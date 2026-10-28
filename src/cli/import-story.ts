// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core import <file.rolecall>`: RoleCall's per-story export (.notes/rcimport-decisions.md
// D-185…D-195). The zip is read lazily (story.jsonl, a copy of the rest, is never inflated), parsed
// (formats/rolecall-story.ts) and planned (formats/rolecall-import.ts); this file does the I/O:
// - the session ids: `s_` + 8 hex of the chat id; a chat imported before is skipped with a line, and
//   refused when it is all that was asked, unless --new (D-192); a branch whose parent chat was
//   imported earlier names that session as its fork;
// - the library ids: an identical item is the same item; an equal lorebook of the same name is
//   reused instead of a `-2`;
// - the writes, all or nothing: every new library item, journal and --keep-raw copy is written under
//   a temp name first and put in place at the end; a failure removes what the run made, and an item
//   the run reuses is never touched;
// - the fit check (D-195): each written session is opened in lane manual and its next request built,
//   never sent; a request that cannot fit the narrator's window becomes a warning;
// - the report: one line per library item and session, the warnings grouped and named after the
//   session, book or preset they are about, then the hints.
// --dry-run builds and checks everything and writes nothing. --keep-raw copies each imported chat's
// tracker, storyboard and dm-context to <home>/imports/<session id>/ (D-191).

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Engine } from '../engine/engine.ts';
import type { EngineHandle } from '../engine/api.ts';
import { parseModelRef } from '../engine/route.ts';
import { systemClock } from '../engine/system.ts';
import { libraryDir, RESERVED_IDS, type LibraryKind } from '../formats/library.ts';
import { canonicalId, validateLoreBook, type ImportWarning, type LoreBook } from '../formats/native.ts';
import {
  planStoryImport,
  rcSessionId,
  sessionJournal,
  StoryImportError,
  type PlannedItem,
  type PlannedSession,
  type StoryImportOptions,
  type StoryImportPlan,
} from '../formats/rolecall-import.ts';
import { bookHash, booksFromRows, parseStory, personaFromRow, presetFromRow, type StoryBundle, type StoryChat, type StoryMember } from '../formats/rolecall-story.ts';
import { isRecord } from '../formats/wire.ts';
import { isZip, openZip, ZipError, type ZipArchive } from '../formats/zip.ts';
import { parseEntry, type DeepPartial, type EntryInput, type SessionConfig, type SessionHeader } from '../session/entries.ts';
import { mergePatch } from '../session/fold.ts';
import { checkHeaderForCreate, fsyncDir, readSessionFile, sessionsDir } from '../session/log.ts';
import { UsageError } from './args.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { connectionProblem, engineOptions, type Runtime } from './runtime.ts';

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown): string | undefined => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined);
const short = (id: string): string => id.slice(0, 8);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * A ZIP that holds a manifest.json: the story importer takes it (D-185), whatever the manifest says
 * (parseStory names a manifest of another format). null: not a ZIP. `error`: a ZIP that cannot be
 * read, or one without a manifest at its top (said in plain words: no other archive is imported).
 */
export function storyArchive(bytes: Uint8Array): { zip: ZipArchive } | { error: string } | null {
  if (!isZip(bytes)) return null;
  let zip: ZipArchive;
  try {
    zip = openZip(bytes);
  } catch (e) {
    return { error: `not a readable ZIP archive (${errMessage(e)})` };
  }
  if (zip.has('manifest.json')) return { zip };
  const nested = zip.entries.find((e) => !e.dir && e.name.endsWith('/manifest.json'));
  const inside = nested ? ` (one is inside ${nested.name.slice(0, -'manifest.json'.length)}: the archive was repacked)` : '';
  return {
    error: `a ZIP archive with no manifest.json at its top${inside}; the only archive rp-core imports is a RoleCall story export, which has one: import the .rolecall file as RoleCall exported it`,
  };
}

export interface ImportStoryArgs {
  home: string;
  file: string;
  zip: ZipArchive;
  /** --chat: main (default), all, or chat id prefixes (main may stand among them). */
  chat?: string;
  /** --model conn:model: the sessions' narrator. */
  model?: string;
  /** --compendium on|off (default on). */
  compendium?: string;
  dryRun: boolean;
  /** --new: import again under fresh session ids. */
  fresh: boolean;
  /** --as: the story's title. */
  as?: string;
  keepRaw: boolean;
  json: boolean;
  io: Io;
  /** config.toml: session defaults, the --model connection check and the fit check. Absent: neither. */
  rt?: Runtime;
  /** The import moment (the Compendium's enable entry). Default the system clock. */
  now?: () => Date;
}

type SlotState = 'new' | 'same' | 'reused';
interface Slot {
  id: string;
  path: string;
  state: SlotState;
}

/** The text saveToLibrary writes for a value (an identical file is the same item). */
const libraryText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Where saveToLibrary would put `value` (the same walk: id, id-2, …), without writing: an identical
 * file is 'same'; `claimed` holds what this run writes before it.
 */
function peekSlot(home: string, folder: LibraryKind, name: string, value: unknown, claimed: ReadonlyMap<string, string>): Slot {
  const dir = libraryDir(home, folder);
  const text = libraryText(value);
  const base = canonicalId(name);
  for (let n = RESERVED_IDS[folder]?.includes(base) ? 2 : 1; n <= 10_000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const path = join(dir, `${id}.json`);
    const existing = claimed.get(path) ?? readIfExists(path);
    if (existing === text) return { id, path, state: claimed.has(path) ? 'new' : 'same' };
    if (existing === null) return { id, path, state: 'new' };
  }
  throw new StoryImportError(`library ${folder}: no free id for ${JSON.stringify(name)}`);
}

/** Library lorebooks by name (trimmed), their content hash computed on demand (D-187 reuse). */
function libraryBooks(home: string): (name: string, hash: string) => Slot | undefined {
  const dir = libraryDir(home, 'lorebooks');
  let rows: { id: string; path: string; name: string; value: unknown; hash?: string }[] | null = null;
  return (name, hash) => {
    if (rows === null) {
      rows = [];
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
      } catch {
        files = [];
      }
      for (const f of files) {
        try {
          const value = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
          const n = typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : undefined;
          if (typeof n === 'string') rows.push({ id: f.slice(0, -'.json'.length), path: join(dir, f), name: n.trim(), value });
        } catch {
          // a broken library file is never reused
        }
      }
    }
    for (const r of rows) {
      if (r.name !== name.trim()) continue;
      if (r.hash === undefined) {
        const v = validateLoreBook(r.value);
        r.hash = v.ok ? bookHash(v.value) : '';
      }
      if (r.hash === hash) return { id: r.id, path: r.path, state: 'reused' };
    }
    return undefined;
  };
}

/** Each planned item's library id: an identical file, else an equal book of the same name, else the next free id. */
function librarySlots(home: string, items: readonly PlannedItem[]): Map<string, Slot> {
  const claimed = new Map<string, string>();
  const books = libraryBooks(home);
  const out = new Map<string, Slot>();
  for (const item of items) {
    let slot = peekSlot(home, item.folder, item.name, item.value, claimed);
    if (slot.state === 'new' && !claimed.has(slot.path) && item.hash !== undefined) slot = books(item.name, item.hash) ?? slot;
    if (slot.state === 'new') claimed.set(slot.path, libraryText(item.value));
    out.set(item.key, slot);
  }
  return out;
}

/**
 * The chat id an existing journal was imported from (its header's `imported.chat`), read from its
 * first line only (a header holds the cast, so it is read in chunks up to its newline).
 */
function importedChatOf(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < 256 * (1 << 20); ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : n)));
      if (nl >= 0) break;
      pos += n;
    }
    const header = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { imported?: { chat?: unknown } };
    return typeof header.imported?.chat === 'string' ? header.imported.chat : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const journalPath = (home: string, id: string): string => join(sessionsDir(home), `${id}.jsonl`);

/** The session a chat was imported as: `s_` + 8 hex of its id, or a later --new one (D-192). */
function importedAs(home: string, chatId: string): string | undefined {
  for (let n = 1; n <= 10_000; n++) {
    const id = rcSessionId(chatId, n);
    const path = journalPath(home, id);
    if (!existsSync(path)) return undefined;
    if (importedChatOf(path) === chatId) return id;
  }
  return undefined;
}

/** The first free session id of a chat (`taken`: claimed earlier in the run). */
function freeSessionId(home: string, chatId: string, taken: ReadonlySet<string>): string {
  for (let n = 1; n <= 10_000; n++) {
    const id = rcSessionId(chatId, n);
    if (!taken.has(id) && !existsSync(journalPath(home, id))) return id;
  }
  throw new StoryImportError(`no free session id for chat ${short(chatId)}`);
}

/** config.toml's session defaults, then --model on the narrator (checked against config.toml, as `new`). */
function baseConfig(a: ImportStoryArgs): DeepPartial<SessionConfig> | undefined {
  let config: DeepPartial<SessionConfig> | undefined = a.rt && Object.keys(a.rt.config.sessionDefaults).length > 0 ? a.rt.config.sessionDefaults : undefined;
  if (a.model !== undefined) {
    const ref = parseModelRef(a.model);
    if (!ref) throw new UsageError(`--model must be conn:model, got ${JSON.stringify(a.model)}`, 'import');
    if (a.rt) {
      const problem = connectionProblem(a.rt, ref.conn);
      if (problem) throw new UsageError(`--model ${a.model}: ${problem}`, 'import');
    }
    config = mergePatch<DeepPartial<SessionConfig>>(config ?? {}, { roles: { narrator: { conn: ref.conn, model: ref.model } } });
  }
  return config;
}

// ---- --chat ----------------------------------------------------------------------------------------

/** A chat as the user can tell it apart: `id8 "title" (N messages)`. */
function chatLabel(c: StoryChat): string {
  const title = c.title?.trim() || c.branchName?.trim();
  return `${short(c.id)}${title ? ` ${JSON.stringify(title)}` : ''} (${plural(c.messages.length, 'message')})`;
}

/**
 * --chat as the planner reads it, and the chats it names: `main` and `all` in any case; `main` may
 * stand among id prefixes, `all` only alone; a prefix names one chat, and a refusal lists the chats
 * it could mean (all of them when it means none).
 */
function chatChoice(bundle: StoryBundle, given: string | undefined): { choice: string; chats: StoryChat[] } {
  const words = (given ?? 'main')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== '');
  if (words.length === 0) throw new StoryImportError('--chat: main, all, or chat id prefixes separated by commas');
  if (words.includes('all')) {
    if (words.length > 1) throw new StoryImportError('--chat all already takes every chat; give it alone');
    return { choice: 'all', chats: [...bundle.chats] };
  }
  const picked = new Set<string>();
  for (const w of words) {
    if (w === 'main') {
      picked.add(bundle.mainChatId);
      continue;
    }
    const hits = bundle.chats.filter((c) => c.id.toLowerCase().startsWith(w));
    if (hits.length === 1) {
      picked.add(hits[0]!.id);
      continue;
    }
    if (hits.length > 1) throw new StoryImportError(`--chat ${w}: ${hits.length} chats have an id starting so: ${hits.map(chatLabel).join(', ')}; give more of it`);
    throw new StoryImportError(`--chat ${w}: no chat of the export has an id starting so; its chats: ${bundle.chats.map(chatLabel).join(', ')}`);
  }
  if (words.length === 1 && words[0] === 'main') return { choice: 'main', chats: bundle.chats.filter((c) => c.id === bundle.mainChatId) };
  const chats = bundle.chats.filter((c) => picked.has(c.id));
  return { choice: chats.map((c) => c.id).join(','), chats };
}

// ---- refusals with their reasons ---------------------------------------------------------------------

/** The parser's warnings that say why a member could not be read. */
const REASON_CODES = new Set(['rc_character_unreadable', 'rc_missing_member', 'rc_bad_line', 'rc_unreadable']);

/**
 * The parser's reasons behind a refusal about these members (robust#6): its warnings on them, at most
 * three, each without the path when the refusal already names it.
 */
function because(ws: readonly ImportWarning[], members: readonly string[], refusal: string): string {
  const on = (w: ImportWarning, m: string): boolean =>
    w.path === m || w.path.startsWith(`${m}/`) || (m.startsWith('chats/') && w.path.startsWith('chats/*/'));
  const hits = ws.filter((w) => REASON_CODES.has(w.code) && members.some((m) => on(w, m)));
  if (hits.length === 0) return '';
  const shown = hits.slice(0, 3).map((w) => (refusal.includes(w.path) ? w.message : `${w.path}: ${w.message}`));
  return ` (${shown.join('; ')}${hits.length > 3 ? `; ${hits.length - 3} more` : ''})`;
}

/** planStoryImport, its refusal carrying the parser's reasons about the card and the chosen chats. */
function planOrRefuse(bundle: StoryBundle, opts: StoryImportOptions, chats: readonly StoryChat[]): StoryImportPlan {
  try {
    return planStoryImport(bundle, opts);
  } catch (e) {
    if (!(e instanceof StoryImportError)) throw e;
    const members = [...(bundle.character ? [bundle.character.path] : []), ...chats.map((c) => c.dir)];
    throw new StoryImportError(`${e.message}${because(bundle.warnings, members, e.message)}`);
  }
}

/**
 * Why no chat folder of the zip could be read, when the parser found none (robust#6): the three
 * faults its chat reading refuses — no chat.json, not a JSON object (or not JSON), no id.
 */
function chatFaults(zip: ZipArchive): string[] {
  const dirs = new Set<string>();
  for (const e of zip.entries) {
    const parts = e.name.split('/');
    if (!e.dir && parts.length === 3 && parts[0] === 'chats') dirs.add(`chats/${parts[1]}`);
  }
  const out: string[] = [];
  for (const dir of [...dirs].sort()) {
    const at = `${dir}/chat.json`;
    if (!zip.has(at)) {
      out.push(`${dir}: no chat.json`);
      continue;
    }
    try {
      const v = JSON.parse(zip.text(at)) as unknown;
      if (!isRecord(v)) out.push(`${at}: not a JSON object`);
      else if (!((typeof v.id === 'string' && v.id.trim() !== '') || (typeof v.id === 'number' && Number.isFinite(v.id)))) out.push(`${at}: the chat has no id`);
    } catch (e) {
      out.push(`${at}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : errMessage(e)}`);
    }
  }
  return out;
}

// ---- warnings ----------------------------------------------------------------------------------------

const keyOf = (w: ImportWarning): string => `${w.code}\u0000${w.path}\u0000${w.message}`;

/**
 * Whom each planned warning is about (ux#3): a session (its id), or a library item (`lorebook <id>`,
 * `preset <id>`, `persona <id>`, `character <id>`).
 * - Sessions: the planner lists the story's own warnings, then each session's in session order, then
 *   the not-carried counts (paths `chats/*`…). Planning each session alone gives the length of its
 *   block, so with two sessions or more the list splits exactly; the split is checked against the
 *   single plans, and a list that does not split so keeps its warnings unnamed. One session needs no
 *   name: the report has only it.
 * - Items: what the card reading, personaFromRow, presetFromRow and booksFromRows say about each,
 *   matched in order against the warnings no session took.
 */
function subjectsOf(
  bundle: StoryBundle,
  opts: StoryImportOptions,
  plan: StoryImportPlan,
  slots: ReadonlyMap<string, Slot>,
  ids: ReadonlyMap<string, string>,
): Map<ImportWarning, string> {
  const out = new Map<ImportWarning, string>();
  const n = plan.sessions.length;
  if (n >= 2) {
    const body = (ws: readonly ImportWarning[]): readonly ImportWarning[] => {
      let k = ws.length;
      while (k > 0 && ws[k - 1]!.path.startsWith('chats/*/')) k--;
      return ws.slice(0, k);
    };
    const same = (x: readonly ImportWarning[], y: readonly ImportWarning[]): boolean => x.length === y.length && x.every((w, i) => keyOf(w) === keyOf(y[i]!));
    let alone: (readonly ImportWarning[])[] | null;
    try {
      alone = plan.sessions.map((s) => body(planStoryImport(bundle, { ...opts, chat: s.chatId }).warnings));
    } catch {
      alone = null;
    }
    const all = body(plan.warnings);
    const g = alone ? (alone.reduce((t, ws) => t + ws.length, 0) - all.length) / (n - 1) : -1;
    if (alone && Number.isInteger(g) && g >= 0) {
      const found: [ImportWarning, string][] = [];
      let at = g;
      const split = alone.every((ws, i) => {
        const own = ws.slice(g);
        const theirs = all.slice(at, at + own.length);
        if (ws.length < g || !same(ws.slice(0, g), all.slice(0, g)) || !same(own, theirs)) return false;
        for (const w of theirs) found.push([w, ids.get(plan.sessions[i]!.chatId)!]);
        at += own.length;
        return true;
      });
      if (split && at === all.length) for (const [w, s] of found) out.set(w, s);
    }
  }

  const queue = new Map<string, string[]>();
  const claim = (ws: readonly ImportWarning[], subject: string | undefined): void => {
    if (subject === undefined) return;
    for (const w of ws) queue.set(keyOf(w), [...(queue.get(keyOf(w)) ?? []), subject]);
  };
  const item = (kind: string, key: string): string | undefined => {
    const id = slots.get(key)?.id;
    return id === undefined ? undefined : `${kind} ${id}`;
  };
  claim(bundle.character?.card?.warnings ?? [], item('character', 'character'));
  if (bundle.persona) claim(personaFromRow(bundle.persona).warnings, item('persona', 'persona'));
  if (bundle.preset) claim(presetFromRow(bundle.preset).warnings, item('preset', 'preset'));
  const books = booksFromRows(bundle.books);
  const bookOf = new Map(books.books.flatMap((b) => b.rcIds.map((id) => [id, item('lorebook', `book:${b.rcIds[0]}`)] as const)));
  for (const b of books.books) claim(b.warnings, bookOf.get(b.rcIds[0]!));
  for (const w of books.warnings) {
    const at = /^lorebooks\[(\d+)\]/.exec(w.path);
    const row = at ? bundle.books[Number(at[1])] : undefined;
    claim([w], typeof row?.id === 'string' ? bookOf.get(row.id.trim()) : undefined);
  }
  for (const w of plan.warnings) {
    if (out.has(w)) continue;
    const subject = queue.get(keyOf(w))?.shift();
    if (subject !== undefined) out.set(w, subject);
  }
  return out;
}

export interface WarningGroup {
  code: string;
  message: string;
  count: number;
  /** Every distinct path the group's warnings name, in order. */
  paths: string[];
  /** The sessions and library items they are about, when known. */
  subjects?: string[];
}

/** Warnings with the same code and text, once each: how many times they came, where, and about whom. */
export function groupWarnings(ws: readonly ImportWarning[], subjectOf: (w: ImportWarning) => string | undefined = () => undefined): WarningGroup[] {
  const out = new Map<string, WarningGroup>();
  for (const w of ws) {
    const key = `${w.code}\u0000${w.message}`;
    let g = out.get(key);
    if (!g) {
      g = { code: w.code, message: w.message, count: 0, paths: [] };
      out.set(key, g);
    }
    g.count++;
    if (!g.paths.includes(w.path)) g.paths.push(w.path);
    const subject = subjectOf(w);
    if (subject !== undefined && !g.subjects?.includes(subject)) g.subjects = [...(g.subjects ?? []), subject];
  }
  return [...out.values()];
}

/** One warning line: its subjects in front, a count when it came more often than they say. */
function warningLine(g: WarningGroup): string {
  const who = g.subjects ? `${g.subjects.join(', ')}: ` : '';
  return `${who}${g.message}${g.count > (g.subjects?.length ?? 1) ? ` (×${g.count})` : ''}`;
}

// ---- notes about the written sessions ----------------------------------------------------------------

/**
 * Where the Compendium starts (fidelity#4, accepted: the enable moment follows the imported past), in
 * one line: the turns RoleCall's summaries in the session's books leave out are summarised by neither.
 */
function compendiumStart(s: PlannedSession, items: ReadonlyMap<string, PlannedItem>): string {
  const byId = new Map<string, Extract<EntryInput, { t: 'msg' }>>();
  for (const e of s.entries) if (e.t === 'msg') byId.set(e.id, e);
  let turns = 0;
  for (let m = byId.get(s.head); m; m = m.parent !== null ? byId.get(m.parent) : undefined) if (m.role === 'user') turns++;
  let summarised: number | undefined;
  for (const key of s.bookKeys) {
    const item = items.get(key);
    if (item?.kind !== 'lorebook') continue;
    for (const e of (item.value as LoreBook).entries) {
      const md = e.extras?.metadata;
      if (isRecord(md) && md.source === 'tv_summary' && md.chatId === s.chatId && typeof md.turnNumber === 'number') summarised = Math.max(summarised ?? 0, md.turnNumber);
    }
  }
  const start = `the Compendium starts after the imported ${plural(turns, 'turn')}: it files and summarises new turns only`;
  if (summarised === undefined) return `${start}; the imported ones stay in the history and the lorebooks`;
  if (summarised >= turns) return `${start}; RoleCall's summaries in the lorebooks cover the imported ones`;
  const gap = summarised + 1 === turns ? `turn ${turns} is` : `turns ${summarised + 1}–${turns} are`;
  return `${start}; RoleCall's summaries in the lorebooks reach turn ${summarised}, so ${gap} summarised nowhere (the history keeps them while they fit)`;
}

/** The fit warning's text (D-195): needed against available tokens, and what makes room. */
function fitMessage(narrator: string, id: string, why: string): string {
  const m = /needs about (\d+) tokens, but only (\d+) are available \(window (\d+) - reply reserve (\d+)\)/.exec(why);
  const need = m ? `its next request needs about ${m[1]} tokens, but only ${m[2]} are available (window ${m[3]} - reply reserve ${m[4]})` : why;
  return (
    `the story does not fit its narrator ${narrator}: ${need}, so every turn would be refused; choose a narrator with a larger ` +
    `window (/model in the chat, --model when importing) or the built-in layout (/preset builtin); \`rp-core preview ${id}\` shows the parts`
  );
}

/**
 * D-195: each written session opened as a chat opens it (lane manual: no task runs) and its next
 * request built, never sent — a swipe of the head answer, or a reply to an empty draft when only a
 * greeting is there. A request that cannot fit the narrator's window is a warning now rather than
 * every turn's refusal later. Any other refusal is the chat's to report (an unknown connection, …).
 */
async function fitCheck(home: string, rt: Runtime, sessions: readonly { id: string; narrator: string }[]): Promise<ImportWarning[]> {
  const out: ImportWarning[] = [];
  let engine: EngineHandle | undefined;
  try {
    engine = await Engine.open({ ...engineOptions(rt), home, lane: 'manual' });
    for (const s of sessions) {
      try {
        const session = engine.session(s.id);
        try {
          let r = session.preview();
          if (!r.ok && r.code === 'nothing_to_swipe') r = session.preview({ draft: '' });
          if (!r.ok && r.code === 'context_length_exceeded') out.push({ code: 'context_length_exceeded', path: s.id, message: fitMessage(s.narrator, s.id, r.message) });
        } finally {
          await session.close();
        }
      } catch (e) {
        out.push({ code: 'fit_unchecked', path: s.id, message: `whether the story fits its narrator could not be checked: ${errMessage(e)}` });
      }
    }
  } catch (e) {
    for (const s of sessions) out.push({ code: 'fit_unchecked', path: s.id, message: `whether the story fits its narrator could not be checked: ${errMessage(e)}` });
  } finally {
    if (engine) await engine.close();
  }
  return out;
}

// ---- all-or-nothing writes ---------------------------------------------------------------------------

/** Link failures of filesystems without hard links: a rename after an existence check instead. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

function removeQuiet(path: string, folder: boolean): void {
  try {
    if (folder) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Files and folders that appear together or not at all (robust#1). Each is written whole under a temp
 * name beside its place now — a dotfile that the library, `sessions` and `imports` listings skip —
 * and publish() puts them in place in order: a file by a hard link, which never overwrites (a place
 * taken meanwhile fails the run), a folder by a rename onto a free name. discard() removes every temp
 * name, everything published and every folder made by this run (when nothing else has moved in).
 * Nothing that existed before is written or removed. Exported for tests.
 */
export class StagedWrites {
  private readonly steps: { tmp: string; final: string; folder: boolean; placed: boolean }[] = [];
  private readonly made: string[] = [];
  private seq = 0;

  /** mkdir -p, remembering each folder it made. */
  private ensureDir(dir: string): void {
    const first = mkdirSync(dir, { recursive: true });
    if (first === undefined) return;
    const chain: string[] = [];
    for (let d = dir; ; d = dirname(d)) {
      chain.push(d);
      if (d === first || dirname(d) === d) break;
    }
    this.made.push(...chain.reverse());
  }

  /** A temp name beside `final` that is not taken (pid + counter: no clock, no randomness). */
  private claim(final: string, make: (tmp: string) => void): string {
    for (;;) {
      const tmp = join(dirname(final), `.${basename(final)}.${process.pid}-${++this.seq}.import.tmp`);
      try {
        make(tmp);
        return tmp;
      } catch (e) {
        if (errCode(e) !== 'EEXIST' || this.seq > 1_000_000) throw e;
      }
    }
  }

  /** A file: its bytes are written and fsynced under a temp name now. */
  file(final: string, data: Uint8Array | string): void {
    try {
      this.ensureDir(dirname(final));
      let fd: number | undefined;
      const tmp = this.claim(final, (t) => {
        fd = openSync(t, 'wx', 0o644);
      });
      this.steps.push({ tmp, final, folder: false, placed: false });
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      try {
        for (let off = 0; off < bytes.length; ) {
          const n = writeSync(fd!, bytes, off, bytes.length - off);
          if (n <= 0) throw new Error('write returned no progress');
          off += n;
        }
        fsyncSync(fd!);
      } finally {
        closeSync(fd!);
      }
    } catch (e) {
      throw new Error(`cannot write ${final}: ${errMessage(e)}`);
    }
  }

  /** A folder of files, written under a temp name now. */
  folder(final: string, files: readonly { name: string; data: Uint8Array }[]): void {
    try {
      this.ensureDir(dirname(final));
      const tmp = this.claim(final, (t) => mkdirSync(t));
      this.steps.push({ tmp, final, folder: true, placed: false });
      for (const f of files) writeFileSync(join(tmp, f.name), f.data);
    } catch (e) {
      throw new Error(`cannot write ${final}: ${errMessage(e)}`);
    }
  }

  /** Put everything in place, in the order it was staged. Throws on the first place that is taken. */
  publish(): void {
    const dirs = new Set<string>();
    for (const s of this.steps) {
      const taken = (): Error => new Error(`${s.final} appeared while importing; run the import again`);
      if (s.folder) {
        if (existsSync(s.final)) throw taken();
        renameSync(s.tmp, s.final);
        s.placed = true;
      } else {
        try {
          linkSync(s.tmp, s.final);
        } catch (e) {
          const code = errCode(e);
          if (code === 'EEXIST') throw taken();
          if (code === undefined || !NO_LINKS.has(code)) throw e;
          if (existsSync(s.final)) throw taken();
          renameSync(s.tmp, s.final);
        }
        s.placed = true;
        removeQuiet(s.tmp, false);
      }
      dirs.add(dirname(s.final));
    }
    for (const d of dirs) fsyncDir(d);
  }

  /** Remove what this run wrote: the temp names, what was published, the folders it made. */
  discard(): void {
    for (const s of [...this.steps].reverse()) {
      if (s.placed) removeQuiet(s.final, s.folder);
      removeQuiet(s.tmp, s.folder);
    }
    for (const d of [...this.made].reverse()) {
      try {
        rmdirSync(d);
      } catch {
        // not empty: something else lives there now
      }
    }
    this.steps.length = 0;
    this.made.length = 0;
  }
}

/** A journal's bytes, as createSessionLogWith writes them; every line checked as it checks it. */
function journalBytes(header: SessionHeader, entries: readonly EntryInput[]): string {
  let lines: string[];
  try {
    lines = [checkHeaderForCreate(header)];
  } catch (e) {
    throw new StoryImportError(`session ${header.id}: ${errMessage(e)}`);
  }
  entries.forEach((e, i) => {
    const line = JSON.stringify(Object.assign({ t: e.t, seq: i + 1 }, e, { seq: i + 1 }));
    const r = parseEntry(line);
    if (!r.ok) throw new StoryImportError(`session ${header.id}: entry ${i + 1} (${e.t}) would be invalid: ${r.why}`);
    lines.push(line);
  });
  return `${lines.join('\n')}\n`;
}

/** The folder --keep-raw copies a session's files to: <home>/imports/<session id>, else the next free name. */
function keepDir(home: string, id: string): string {
  const base = join(home, 'imports', id);
  for (let n = 1; n <= 10_000; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(dir)) return dir;
  }
  throw new StoryImportError(`--keep-raw: no free folder for ${id} in ${join(home, 'imports')}`);
}

// ---- the command -------------------------------------------------------------------------------------

/** `rp-core import <file.rolecall>`: plan, check, write (unless --dry-run), check the fit and report. */
export async function cmdImportStory(a: ImportStoryArgs): Promise<number> {
  const compendium = a.compendium === undefined || a.compendium === 'on' ? true : a.compendium === 'off' ? false : undefined;
  if (compendium === undefined) throw new UsageError(`--compendium must be on or off, got ${JSON.stringify(a.compendium)}`, 'import');
  const config = baseConfig(a);
  const base = basename(a.file);

  // Members on demand: story.jsonl (the same data again) is never inflated.
  const zip = a.zip;
  function* members(): Generator<StoryMember> {
    for (const e of zip.entries) if (!e.dir && e.name !== 'story.jsonl') yield { name: e.name, data: zip.read(e.name) };
  }
  let parsed: ReturnType<typeof parseStory>;
  try {
    parsed = parseStory(members());
  } catch (e) {
    if (e instanceof ZipError) throw new StoryImportError(`${base}: ${e.message}`);
    throw e;
  }
  if (!parsed.ok) {
    const faults = chatFaults(zip);
    throw new StoryImportError(`${base}: ${parsed.why}${faults.length > 0 ? ` (${faults.slice(0, 3).join('; ')}${faults.length > 3 ? `; ${faults.length - 3} more` : ''})` : ''}`);
  }
  const bundle = parsed.value;
  const titleOf = new Map(bundle.chats.map((c) => [c.id, c.title?.trim() || c.branchName?.trim() || '']));
  const chosen = chatChoice(bundle, a.chat);
  const opts: StoryImportOptions = { compendium, ...(a.as !== undefined ? { title: a.as } : {}), ...(config ? { config } : {}) };
  let planOpts: StoryImportOptions = { ...opts, chat: chosen.choice };
  let plan = planOrRefuse(bundle, planOpts, chosen.chats);
  const skipped = [...plan.skipped];

  // A chat imported before is skipped with a line; when it is all that was asked, the run is refused.
  if (!a.fresh) {
    const done = new Map<string, string>();
    for (const s of plan.sessions) {
      const id = importedAs(a.home, s.chatId);
      if (id !== undefined) done.set(s.chatId, id);
    }
    if (done.size === plan.sessions.length) {
      const list = [...done.values()];
      const others = chosen.choice !== 'all' && bundle.chats.some((c) => c.messages.length > 0 && !done.has(c.id) && importedAs(a.home, c.id) === undefined);
      throw new StoryImportError(
        `already imported as ${list.join(', ')}: \`rp-core chat ${list[0]}\` continues it; --new imports ${list.length === 1 ? 'it' : 'them'} again as new session${list.length === 1 ? '' : 's'}` +
          (others ? '; --chat all imports the chats not imported yet' : ''),
      );
    }
    if (done.size > 0) {
      const rest = plan.sessions.filter((s) => !done.has(s.chatId));
      planOpts = { ...opts, chat: rest.map((s) => s.chatId).join(',') };
      plan = planOrRefuse(bundle, planOpts, chosen.chats.filter((c) => !done.has(c.id)));
      for (const [chatId, id] of done) skipped.push({ chatId, why: `already imported as ${id}` });
    }
  }

  const ids = new Map<string, string>();
  for (const s of plan.sessions) ids.set(s.chatId, freeSessionId(a.home, s.chatId, new Set(ids.values())));
  const slots = librarySlots(a.home, plan.items);
  const items = new Map(plan.items.map((i) => [i.key, i]));
  const subjects = subjectsOf(bundle, planOpts, plan, slots, ids);
  const notes: ImportWarning[] = [];
  const note = (w: ImportWarning, subject: string): void => {
    notes.push(w);
    subjects.set(w, subject);
  };
  const now = (a.now ?? systemClock)().toISOString();
  const narrator = (s: PlannedSession): string => `${s.config.roles.narrator.conn}:${s.config.roles.narrator.model}`;

  const journals = plan.sessions.map((s) => {
    const id = ids.get(s.chatId)!;
    // The fork: the parent's session of this run, else the one it was imported as earlier, when that
    // journal holds the branch point.
    let fork: { from: string; at: string } | undefined;
    if (s.fork) {
      const inRun = ids.get(s.fork.chatId);
      const before = inRun === undefined ? importedAs(a.home, s.fork.chatId) : undefined;
      if (inRun !== undefined) fork = { from: inRun, at: s.fork.at };
      else if (before !== undefined) {
        let holds = false;
        try {
          holds = readSessionFile(a.home, before).entries.some((e) => e.t === 'msg' && e.id === s.fork!.at);
        } catch {
          holds = false;
        }
        if (holds) fork = { from: before, at: s.fork.at };
        else {
          note(
            { code: 'rc_fork_unlinked', path: `${s.dir}/chat.json`, message: `its parent chat ${short(s.fork.chatId)} was imported as ${before}, which does not hold the branch point ${s.fork.at}; imported without the fork link` },
            id,
          );
        }
      }
    }
    const preset = s.presetKey !== undefined ? slots.get(s.presetKey)?.id : undefined;
    const lorebooks = s.bookKeys.flatMap((k) => slots.get(k)?.id ?? []);
    const j = sessionJournal(s, { id, now, lorebooks, ...(preset !== undefined ? { preset } : {}), ...(fork ? { fork } : {}) });
    if (s.compendium) note({ code: 'rc_compendium_start', path: id, message: compendiumStart(s, items) }, id);
    return { s, id, fork: fork?.from, bytes: journalBytes(j.header, j.entries) };
  });
  const kept = a.keepRaw
    ? journals.flatMap((j) => {
        const files = j.s.raw.filter((name) => zip.has(name));
        return files.length > 0 ? [{ session: j.id, dir: keepDir(a.home, j.id), files }] : [];
      })
    : [];

  // Everything checked (all a dry run does). The writes: all or nothing.
  if (!a.dryRun) {
    const w = new StagedWrites();
    try {
      for (const item of plan.items) {
        const slot = slots.get(item.key)!;
        if (slot.state === 'new') w.file(slot.path, libraryText(item.value));
      }
      for (const j of journals) w.file(journalPath(a.home, j.id), j.bytes);
      for (const k of kept) w.folder(k.dir, k.files.map((name) => ({ name: basename(name), data: zip.read(name) })));
      w.publish();
    } catch (e) {
      w.discard();
      throw new StoryImportError(`${errMessage(e)}; nothing was imported`);
    }
    if (a.rt) for (const f of await fitCheck(a.home, a.rt, journals.map((j) => ({ id: j.id, narrator: narrator(j.s) })))) note(f, f.path);
  }

  // The tracker and storyboard lines say where --keep-raw put the copies.
  const imports = join(a.home, 'imports');
  const reworded = (w: ImportWarning): ImportWarning => {
    if (!a.keepRaw || !/ \(--keep-raw keeps a copy\)$/.test(w.message)) return w;
    const where = a.dryRun ? `(--keep-raw puts a copy in ${imports}/)` : `(a copy is in ${imports}/)`;
    return { ...w, message: w.message.replace(/\(--keep-raw keeps a copy\)$/, where) };
  };
  const all = [...plan.warnings, ...notes];
  const shown = new Map(all.map((w) => [reworded(w), w] as const));
  const warnings = groupWarnings([...shown.keys()], (w) => subjects.get(shown.get(w)!));
  const keptFiles = (k: (typeof kept)[number]): string[] => k.files.map((f) => basename(f));

  if (a.json) {
    a.io.out.write(
      `${JSON.stringify({
        dryRun: a.dryRun,
        library: plan.items.map((i) => ({ kind: i.kind, id: slots.get(i.key)!.id, name: i.name, state: slots.get(i.key)!.state })),
        sessions: journals.map((j) => ({
          id: j.id,
          chat: j.s.chatId,
          title: j.s.title,
          messages: j.s.counts.messages,
          versions: j.s.counts.versions,
          head: j.s.head,
          narrator: narrator(j.s),
          director: j.s.director,
          compendium: j.s.compendium,
          ...(j.fork !== undefined ? { fork: j.fork } : {}),
        })),
        skipped,
        ...(a.keepRaw ? { kept: kept.map((k) => ({ session: k.session, dir: k.dir, files: keptFiles(k) })) } : {}),
        warnings,
      })}\n`,
    );
    return EXIT.done;
  }

  const out: string[] = [];
  const kindWidth = 9;
  const idWidth = Math.max(...plan.items.map((i) => slots.get(i.key)!.id.length), ...journals.map((j) => j.id.length));
  for (const item of plan.items) {
    const slot = slots.get(item.key)!;
    const state = slot.state === 'same' ? 'same (already in the library)' : slot.state === 'reused' ? 'reused (an equal book)' : 'new';
    out.push(`${item.kind.padEnd(kindWidth)} ${slot.id.padEnd(idWidth)}  ${state}  "${item.name}"${item.detail ? ` · ${item.detail}` : ''}`);
  }
  for (const j of journals) {
    const s = j.s;
    const parts = [
      `chat ${short(s.chatId)}`,
      `${s.counts.messages} messages (${s.counts.versions} versions)`,
      `head ${s.head}`,
      `director ${s.director.enabled ? 'on' : 'off'}${s.director.turn !== undefined ? `, its state at turn ${s.director.turn}` : ''}`,
      s.compendium ? 'compendium on from the import' : 'compendium off',
      ...(j.fork !== undefined ? [`fork of ${j.fork}`] : []),
    ];
    out.push(`${'session'.padEnd(kindWidth)} ${j.id.padEnd(idWidth)}  new  "${s.title}" · ${parts.join(' · ')}`);
  }
  a.io.out.write(`${out.join('\n')}\n`);
  if (a.dryRun) a.io.err.write('rp-core: dry run: nothing was written\n');
  for (const sk of skipped) {
    const title = titleOf.get(sk.chatId);
    a.io.err.write(`rp-core: skipped chat ${short(sk.chatId)}${title ? ` ${JSON.stringify(title)}` : ''}: ${sk.why}\n`);
  }
  for (const k of kept) a.io.err.write(`rp-core: ${a.dryRun ? 'would keep' : 'kept'} ${keptFiles(k).join(', ')} of ${k.session} in ${k.dir}\n`);
  for (const w of warnings) a.io.err.write(`rp-core: warning: ${warningLine(w)}\n`);
  const first = journals[0]!;
  if (a.dryRun) a.io.err.write('rp-core: hint: run it again without --dry-run to import\n');
  else {
    a.io.err.write(`rp-core: hint: \`rp-core chat ${first.id}\` continues the story (\`rp-core tui ${first.id}\` full-screen)\n`);
    if (a.model === undefined) a.io.err.write(`rp-core: hint: its narrator is ${narrator(first.s)}; /model in the chat changes it\n`);
  }
  return EXIT.done;
}
