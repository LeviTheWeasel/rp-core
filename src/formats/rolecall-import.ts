// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The RoleCall story import's plan (.notes/rcimport-decisions.md D-185…D-194): a parsed `.rolecall`
// story (rolecall-story.ts parseStory) → the library items to save and one finished journal per
// imported chat. Pure: no file, no clock (the caller passes `now`); the CLI (cli/import-story.ts)
// reads the zip, finds the library ids, writes the items and the journals.
//
// - Library items (D-187): the character card (the card importer's reading, parseStory), the persona
//   (RoleCall's persona text), the preset as RoleCall stored it and, per chat whose own settings change
//   it, a copy named `<preset> (<story>)`; the lorebooks (booksFromRows: identical books once, a taken
//   name renamed, consumed rows disabled), each with its content hash so a re-import can reuse an equal
//   library book.
// - Sessions (D-188…D-190, D-192): one per chosen chat (`main` by default; `all` skips a chat whose
//   messages equal an earlier one's; or chats by id prefix). The header carries the cast, `imported`,
//   the chat's books and preset, the Director as RoleCall ran it (the model follows the narrator) and
//   `compendium.enabled: false`; then the `msg` entries (chatMessages, RoleCall's name macros written
//   out), the Director's records on every version of the head reply and of the reply before it (turns
//   counted in user messages, dated by the user messages' timestamps), a `head` entry when the newest
//   version is not the head, and — with the Compendium on —
//   a closing `config` entry that turns it on: its seq is the enable moment (D-171, D-189), so the
//   imported past is neither filed nor summarised again.
// - A branch whose copied prefix matches its parent's by text and by message id takes the parent's ids
//   for that prefix and names the parent as its fork (the caller keeps the fork only when the parent is
//   imported in the same run); otherwise it is a session of its own, with a warning.
// - Not carried (D-191): trackers, storyboards, RoleCall's chat summary, TunnelVision / immersion / mind
//   modules that were on: one warning each, with counts; per chat, the books TunnelVision kept out of
//   keyword lore. Two different books with one RoleCall id are both imported; the chats get the first.

import { createHash } from 'node:crypto';
import { directorRecordsFor, directorSettingsFor, dmContextToState } from '../agents/director/import-rc.ts';
import type { DirectorRecord } from '../agents/director/types.ts';
import { DEFAULT_SESSION_CONFIG, type DeepPartial, type EntryInput, type SessionConfig, type SessionHeader } from '../session/entries.ts';
import { mergePatch } from '../session/fold.ts';
import type { LibraryKind } from './library.ts';
import {
  validateCharacter,
  validateLoreBook,
  validatePersona,
  validatePreset,
  type Character,
  type ImportWarning,
  type LoreBook,
  type Persona,
  type Preset,
  type Validation,
} from './native.ts';
import {
  booksFromRows,
  chatMessages,
  personaFromRow,
  presetFromRow,
  RC_TIME_MAX,
  type MessagePlan,
  type PlannedMessage,
  type StoryBook,
  type StoryBundle,
  type StoryChat,
} from './rolecall-story.ts';
import { isRecord, nonBlank, type Rec } from './wire.ts';

/** The story cannot be imported as asked (no character, a --chat that names nothing): one line for the user. */
export class StoryImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryImportError';
  }
}

export interface StoryImportOptions {
  /** 'main' (default), 'all', or chat id prefixes separated by commas. */
  chat?: string;
  /** Turn the Compendium on after the imported past (default true). */
  compendium?: boolean;
  /** The story's title (--as): the main session's title and the preset copy's suffix. */
  title?: string;
  /** The sessions' starting config (config.toml's session defaults, --model on the narrator). */
  config?: DeepPartial<SessionConfig>;
}

export type StoryItemKind = 'character' | 'persona' | 'preset' | 'lorebook';

/** One library item to save. */
export interface PlannedItem {
  /** 'character', 'persona', 'preset', 'preset@<chat id>', 'book:<RoleCall book id>'. */
  key: string;
  kind: StoryItemKind;
  folder: LibraryKind;
  name: string;
  value: Character | Persona | Preset | LoreBook;
  /** A lorebook's content hash (bookHash): an equal library book of the same name is reused (D-187). */
  hash?: string;
  /** A short description for the output ("18 entries, 2 consumed rows disabled"). */
  detail?: string;
}

/** One session to write; sessionJournal turns it into the header and the entries. */
export interface PlannedSession {
  chatId: string;
  /** The chat's folder in the zip (`chats/<slug>-<id8>`). */
  dir: string;
  isMain: boolean;
  title: string;
  /** The session id it is imported under unless taken: `s_` + 8 hex of the chat id (D-192). */
  id: string;
  created: string;
  exportedAt: string;
  cast: SessionHeader['cast'];
  /** Its config without the library ids (filled by sessionJournal). */
  config: SessionConfig;
  /** The preset item it uses (absent: the config's preset stays). */
  presetKey?: string;
  /** Its lorebook items, in RoleCall's order. */
  bookKeys: string[];
  /** The parent chat whose prefix it shares, and the last shared message (fork.at). */
  fork?: { chatId: string; at: string };
  /** The msg entries (Director records attached), hide entries, and the head entry when needed. */
  entries: EntryInput[];
  /** Write the closing config entry that turns the Compendium on. */
  compendium: boolean;
  head: string;
  counts: MessagePlan['counts'];
  director: { enabled: boolean; style?: string; turn?: number; records: number };
  /** The chat's raw RoleCall files present in the zip (tracker, storyboard, dm-context), for --keep-raw. */
  raw: string[];
}

export interface StoryImportPlan {
  items: PlannedItem[];
  sessions: PlannedSession[];
  /** Chats chosen but not imported, and why (an exact copy, no messages). */
  skipped: { chatId: string; why: string }[];
  warnings: ImportWarning[];
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const short = (id: string): string => id.slice(0, 8);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The session id of a RoleCall chat: `s_` + 8 hex of its id; n ≥ 2 gives the n-th fresh one (--new). */
export function rcSessionId(chatId: string, n = 1): string {
  return `s_${sha256(n === 1 ? chatId : `${chatId}\u0000${n}`).slice(0, 8)}`;
}

/** An ISO time from RoleCall's timestamps (ISO, Postgres text, or epoch ms) from 1970 to RC_TIME_MAX, else undefined. */
export function rcIsoTime(v: unknown): string | undefined {
  let t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (typeof v === 'string' && !Number.isFinite(t)) {
    // Postgres text: a space for the T, an offset without minutes, more than 3 fraction digits.
    const s = v.trim().replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00').replace(/(\.\d{3})\d+/, '$1');
    t = Date.parse(s);
  }
  return Number.isFinite(t) && t >= 0 && t <= RC_TIME_MAX ? new Date(t).toISOString() : undefined;
}

const RAW_FILES = ['tracker.json', 'storyboard.json', 'dm-context.json'] as const;

/** Self-check: nothing is planned that the library loader would refuse. */
function checked<T>(v: Validation<T>, what: string): T {
  if (v.ok) return v.value;
  const first = v.errors[0];
  throw new StoryImportError(`${what} maps to an invalid value (${first?.path || '(root)'}: ${first?.message})`);
}

/** The chats --chat names, in the bundle's order (parents before their branches). */
function chooseChats(bundle: StoryBundle, choice: string): StoryChat[] {
  const c = choice.trim();
  if (c === '' || c === 'main') {
    const main = bundle.chats.find((x) => x.id === bundle.mainChatId);
    if (!main) throw new StoryImportError('the export names no main chat');
    return [main];
  }
  if (c === 'all') return [...bundle.chats];
  const picked = new Set<string>();
  for (const prefix of c.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')) {
    const hits = bundle.chats.filter((x) => x.id.toLowerCase().startsWith(prefix));
    if (hits.length === 0) throw new StoryImportError(`--chat ${prefix}: no chat of the export has an id starting so (${plural(bundle.chats.length, 'chat')}: ${bundle.chats.map((x) => short(x.id)).join(', ')})`);
    if (hits.length > 1) throw new StoryImportError(`--chat ${prefix}: ${hits.length} chats have an id starting so; give more of it`);
    picked.add(hits[0]!.id);
  }
  if (picked.size === 0) throw new StoryImportError('--chat: main, all, or a chat id prefix');
  return bundle.chats.filter((x) => picked.has(x.id));
}

interface Resolved {
  plan: MessagePlan;
  /** The chat id each copied message took its ids from (a branch that matched its parent), message by message. */
  salts?: string[];
  fork?: { chatId: string; at: string };
  /** Why a branch is not a fork of its parent. */
  detached?: string;
}

/** Ids of the newest assistant message and of the assistant message before it, on the path. */
function replies(messages: readonly PlannedMessage[]): { head?: PlannedMessage; before?: PlannedMessage } {
  let head: PlannedMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    if (!head) head = m;
    else return { head, before: m };
  }
  return head ? { head } : {};
}

/** "user messages sent up to this time" from the chat's user messages (D-190's turnAt). */
function turnAtOf(plan: MessagePlan): (iso: string) => number | undefined {
  const tsOf = new Map(plan.entries.map((e) => [e.id, e.ts]));
  const times = plan.messages
    .filter((m) => m.role === 'user')
    .map((m) => Date.parse(tsOf.get(m.active) ?? ''))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  return (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return undefined;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/** Rows of a storyboard file (an array, or an object holding one). */
function storyboardRows(sb: unknown): number {
  if (Array.isArray(sb)) return sb.length;
  if (isRecord(sb)) for (const k of ['events', 'rows', 'items', 'entries']) if (Array.isArray(sb[k])) return (sb[k] as unknown[]).length;
  return 0;
}

/**
 * RoleCall features a chat had on that rp-core has no place for. RoleCall keeps a feature's settings
 * when it is switched off: TunnelVision runs only with tv_enabled, an immersion module only with its
 * own `enabled` (worker.ts).
 */
function modulesOf(config: Rec): string[] {
  const out: string[] = [];
  if (config.tv_enabled === true) out.push('TunnelVision');
  const modules = isRecord(config.immersionModules) ? Object.values(config.immersionModules) : [];
  if (modules.some((m) => isRecord(m) && Boolean(m.enabled))) out.push('immersion modules');
  if (config.mind_enabled === true) out.push('mind');
  if (config.agentLoopEnabled === true) out.push('agent loop');
  return out;
}

/** The RoleCall ids of the books TunnelVision kept out of keyword lore in a chat (tv_managed with suppress_keywords). */
function suppressedBooks(config: Rec): Set<string> {
  if (config.tv_enabled !== true || !Array.isArray(config.tv_managed_lorebooks)) return new Set();
  return new Set(
    config.tv_managed_lorebooks.flatMap((l) => (isRecord(l) && l.tv_managed && l.suppress_keywords && typeof l.lorebook_id === 'string' ? [l.lorebook_id.trim()] : [])),
  );
}

/**
 * The story → library items and sessions. Throws StoryImportError when nothing can be imported as
 * asked (no readable character card, a --chat that names no chat). Never reads a file or a clock.
 */
export function planStoryImport(bundle: StoryBundle, opts: StoryImportOptions = {}): StoryImportPlan {
  const warnings: ImportWarning[] = [...bundle.warnings];
  const items: PlannedItem[] = [];

  // ---- library items -----------------------------------------------------------------------------
  const card = bundle.character?.card;
  if (!card) {
    throw new StoryImportError(bundle.character ? `the character card ${bundle.character.path} cannot be read` : 'the export holds no character card');
  }
  const character = checked(validateCharacter(card.value), 'the character card');
  items.push({ key: 'character', kind: 'character', folder: 'characters', name: character.name, value: character });
  warnings.push(...card.warnings);

  let persona: Persona | undefined;
  if (bundle.persona) {
    const p = personaFromRow(bundle.persona);
    persona = checked(validatePersona(p.value), 'the persona');
    items.push({ key: 'persona', kind: 'persona', folder: 'personas', name: persona.name, value: persona });
    warnings.push(...p.warnings);
  } else warnings.push({ code: 'rc_no_persona', path: 'personas/', message: 'the export holds no persona; the sessions have none' });

  const presetRow = bundle.preset;
  const presetId = presetRow ? nonBlank(presetRow.id)?.trim() : undefined;
  let plain: { value: Preset; warnings: ImportWarning[] } | undefined;
  if (presetRow) {
    const p = presetFromRow(presetRow);
    plain = { value: checked(validatePreset(p.value), 'the preset'), warnings: p.warnings };
    items.push({ key: 'preset', kind: 'preset', folder: 'presets', name: plain.value.name, value: plain.value, detail: `${plural(plain.value.blocks.filter((b) => b.enabled).length, 'block')} on` });
    warnings.push(...p.warnings);
  } else warnings.push({ code: 'rc_no_preset', path: 'presets/', message: "the export holds no preset; the sessions keep the config's preset" });
  const plainSeen = new Set((plain?.warnings ?? []).map((w) => `${w.code}\u0000${w.message}`));

  // Books: one item each (keyed apart even when two share a RoleCall id); a chat's book ids name the
  // first book that carries the id.
  const books = booksFromRows(bundle.books);
  const bookKey = new Map<string, string>();
  const bookOf = new Map<string, StoryBook>();
  for (const b of books.books) {
    let key = `book:${b.rcIds[0]}`;
    for (let n = 2; bookOf.has(key); n++) key = `book:${b.rcIds[0]}#${n}`;
    const v = validateLoreBook(b.book);
    if (!v.ok) {
      warnings.push({ code: 'rc_book_unreadable', path: key, message: `lorebook "${b.book.name}" maps to an invalid lorebook (${v.errors[0]?.path}: ${v.errors[0]?.message}); not imported` });
      continue;
    }
    const detail = [
      plural(v.value.entries.length, 'entry', 'entries'),
      ...(b.consumed > 0 ? [`${b.consumed} consumed row(s) disabled`] : []),
      ...(b.rcIds.length > 1 ? [`${plural(b.rcIds.length - 1, 'identical copy', 'identical copies')} merged`] : []),
    ].join(', ');
    items.push({ key, kind: 'lorebook', folder: 'lorebooks', name: v.value.name, value: v.value, hash: b.hash, detail });
    bookOf.set(key, b);
    for (const id of b.rcIds) {
      const first = bookKey.get(id);
      if (first === undefined) bookKey.set(id, key);
      else if (first !== key) {
        warnings.push({
          code: 'rc_duplicate_book_id',
          path: 'lorebooks',
          message: `two different lorebooks carry the RoleCall id ${short(id)}: the chats get "${bookOf.get(first)!.book.name}"; "${v.value.name}" is imported to the library but attached to no session`,
        });
      }
    }
    warnings.push(...b.warnings);
  }
  warnings.push(...books.warnings);

  // ---- chats -------------------------------------------------------------------------------------
  const byId = new Map(bundle.chats.map((c) => [c.id, c]));
  const memo = new Map<string, Resolved>();
  const visiting = new Set<string>();
  // RoleCall writes its name macros out in the history it shows and sends (replaceMacrosHistorical).
  const names = { names: { user: persona?.name ?? 'User', char: character.name } };
  const resolve = (chat: StoryChat): Resolved => {
    const hit = memo.get(chat.id);
    if (hit) return hit;
    visiting.add(chat.id);
    const base = chatMessages(chat, names);
    let out: Resolved = { plan: base };
    const bpi = chat.branchPointIndex;
    const parent = chat.parentId !== null ? byId.get(chat.parentId) : undefined;
    if (parent && !visiting.has(parent.id) && bpi !== undefined && Number.isInteger(bpi) && bpi >= 1) {
      const pr = resolve(parent);
      const pm = pr.plan.messages;
      const same = bpi <= pm.length && bpi <= base.messages.length && base.messages.slice(0, bpi).every((m, k) => m.contentHash === pm[k]!.contentHash);
      if (!same) out = { plan: base, detached: `its first ${plural(bpi, 'message')} differ from its parent's` };
      else {
        // Each copied message takes its ids from where the parent's took them: the parent's own
        // prefix may carry its parent's ids, and so on up the tree.
        const salts = Array.from({ length: bpi }, (_, k) => pr.salts?.[k] ?? parent.id);
        const plan = chatMessages(chat, { ...names, prefixSalts: salts });
        out = plan.messages.slice(0, bpi).every((m, k) => m.active === pm[k]!.active)
          ? { plan, salts, fork: { chatId: parent.id, at: pm[bpi - 1]!.active } }
          : { plan: base, detached: `its first ${plural(bpi, 'message')} match its parent's by text, not by message id` };
      }
    }
    visiting.delete(chat.id);
    memo.set(chat.id, out);
    return out;
  };

  const chosen = chooseChats(bundle, opts.chat ?? 'main');
  const mainChat = byId.get(bundle.mainChatId);
  const storyTitle = opts.title?.trim() || mainChat?.title?.trim() || character.name;
  const sessions: PlannedSession[] = [];
  const skipped: { chatId: string; why: string }[] = [];
  const fingerprints = new Map<string, string>();
  const notCarried = { trackers: 0, storyboards: 0, storyboardRows: 0, summaries: 0, summaryChars: 0, summariesWithBooks: 0, modules: new Set<string>() };
  const base = mergePatch<SessionConfig>(DEFAULT_SESSION_CONFIG, opts.config);

  for (const chat of chosen) {
    const r = resolve(chat);
    const plan = r.plan;
    if (plan.messages.length === 0 || plan.head === null) {
      skipped.push({ chatId: chat.id, why: 'it has no message' });
      continue;
    }
    if (chosen.length > 1) {
      const twin = fingerprints.get(plan.fingerprint);
      if (twin !== undefined) {
        skipped.push({ chatId: chat.id, why: `its messages equal chat ${short(twin)}'s` });
        continue;
      }
      fingerprints.set(plan.fingerprint, chat.id);
    }
    warnings.push(...plan.warnings);
    if (r.detached) {
      warnings.push({ code: 'rc_branch_detached', path: `${chat.dir}/chat.json`, message: `chat ${short(chat.id)} branched from chat ${short(chat.parentId ?? '')}, but ${r.detached}; imported as a session of its own` });
    }

    const isMain = chat.id === bundle.mainChatId;
    const label = chat.branchName ?? `chat ${short(chat.id)}`;
    const title = isMain ? storyTitle : !opts.title?.trim() && chat.title && chat.title.trim() !== storyTitle ? chat.title.trim() : `${storyTitle} · ${label}`;

    // The preset: the story's, or a copy with this chat's own settings.
    let presetKey: string | undefined;
    if (presetRow && plain) {
      const used = nonBlank(chat.config.preset_id)?.trim();
      if (used !== undefined && presetId !== undefined && used !== presetId) {
        warnings.push({ code: 'rc_preset_missing', path: `${chat.dir}/chat.json`, message: `chat ${short(chat.id)} used a preset that is not in the export; it gets the story's preset` });
      }
      const copy = presetFromRow(presetRow, { config: chat.config, name: `${plain.value.name} (${title})` });
      if (copy.overridden) {
        const value = checked(validatePreset(copy.value), 'the preset with the chat\'s settings');
        presetKey = `preset@${chat.id}`;
        items.push({ key: presetKey, kind: 'preset', folder: 'presets', name: value.name, value, detail: "the chat's own settings applied" });
        warnings.push(...copy.warnings.filter((w) => !plainSeen.has(`${w.code}\u0000${w.message}`)));
      } else presetKey = 'preset';
    }

    if (persona && bundle.persona && chat.personaId !== undefined && chat.personaId !== nonBlank(bundle.persona.id)?.trim()) {
      warnings.push({ code: 'rc_persona_other', path: `${chat.dir}/chat.json`, message: `chat ${short(chat.id)} used a persona that is not in the export; it gets the story's persona` });
    }

    const bookKeys: string[] = [];
    let missing = 0;
    for (const b of chat.lorebooks) {
      if (!b.enabled) continue;
      const k = bookKey.get(b.id);
      if (k === undefined) missing++;
      else if (!bookKeys.includes(k)) bookKeys.push(k);
    }
    if (missing > 0) warnings.push({ code: 'rc_book_missing', path: `${chat.dir}/chat.json`, message: `${plural(missing, 'lorebook')} chat ${short(chat.id)} used ${missing === 1 ? 'is' : 'are'} not in the export` });

    // TunnelVision kept the plain rows of the books it managed out of RoleCall's keyword lore (only
    // their constant rows were injected; its tools fetched the rest). rp-core has no such switch.
    const suppressed = suppressedBooks(chat.config);
    const managed = bookKeys.filter((k) => bookOf.get(k)!.rcIds.some((id) => suppressed.has(id)));
    if (managed.length > 0) {
      const plain = managed.reduce((n, k) => n + bookOf.get(k)!.book.entries.filter((e) => e.enabled !== false && e.constant !== true && e.meta === undefined).length, 0);
      const constants = managed.reduce((n, k) => n + bookOf.get(k)!.consumedConstant, 0);
      if (plain > 0 || constants > 0) {
        const named = managed.map((k) => `"${bookOf.get(k)!.book.name}"`).join(', ');
        const parts = [
          ...(plain > 0 ? [`their ${plural(plain, 'other enabled row')} that are no Compendium entries fire by keyword here`] : []),
          ...(constants > 0 ? [`${plural(constants, 'constant row')} a Compendium split consumed, which RoleCall still injected, are imported disabled`] : []),
        ];
        warnings.push({
          code: 'rc_tunnelvision',
          path: `${chat.dir}/chat.json`,
          message: `TunnelVision managed the lorebooks ${named} in chat ${short(chat.id)}: RoleCall injected only their constant rows (its tools fetched the rest); ${parts.join('; ')}`,
        });
      }
    }

    // The Director: RoleCall's setting, and its state on the head reply and the reply before it.
    const ds = directorSettingsFor(chat.config);
    warnings.push(...ds.warnings);
    const dirs = new Map<string, DirectorRecord>();
    let turn: number | undefined;
    const { head: reply, before } = replies(plan.messages);
    if (chat.dmContext !== undefined && reply) {
      turn = reply.users;
      const imp = dmContextToState(chat.dmContext, { turn, turnAt: turnAtOf(plan) });
      warnings.push(...imp.warnings);
      if (imp.state) {
        const recs = directorRecordsFor(imp.state, turn, { ...(imp.analysis ? { analysis: imp.analysis } : {}), ...(before ? { beforeTurn: before.users } : {}) });
        // Every version of the two replies: RoleCall kept one Director state per chat, whichever
        // version was shown, so a version picked here starts from it too.
        for (const id of reply.versions) dirs.set(id, recs.head);
        if (recs.before && before) for (const id of before.versions) dirs.set(id, recs.before);
      }
    }

    const entries: EntryInput[] = plan.entries.map((e) => {
      const dir = dirs.get(e.id);
      return dir ? { ...e, dir } : e;
    });
    const last = plan.entries[plan.entries.length - 1]?.ts ?? '';
    for (const target of plan.hidden) entries.push({ t: 'hide', ts: last, target, hidden: true });
    if (plan.headMove) entries.push({ t: 'head', ts: last, leaf: plan.head });

    if (chat.tracker !== undefined) notCarried.trackers++;
    if (chat.storyboard !== undefined) {
      notCarried.storyboards++;
      notCarried.storyboardRows += storyboardRows(chat.storyboard);
    }
    if (chat.summary !== undefined) {
      notCarried.summaries++;
      notCarried.summaryChars += chat.summary.length;
      if (bookKeys.length > 0) notCarried.summariesWithBooks++;
    }
    for (const m of modulesOf(chat.config)) notCarried.modules.add(m);

    const config = mergePatch<SessionConfig>(base, {
      director: { enabled: ds.director.enabled, ...(ds.director.style !== undefined ? { style: ds.director.style } : {}) },
      compendium: { enabled: false },
    });
    sessions.push({
      chatId: chat.id,
      dir: chat.dir,
      isMain,
      title,
      id: rcSessionId(chat.id),
      created: rcIsoTime(chat.createdAt) ?? plan.entries[0]?.ts ?? rcIsoTime(bundle.manifest.exportedAt) ?? new Date(0).toISOString(),
      exportedAt: bundle.manifest.exportedAt ?? '',
      cast: persona ? { character, persona } : { character },
      config,
      ...(presetKey !== undefined ? { presetKey } : {}),
      bookKeys,
      ...(r.fork ? { fork: r.fork } : {}),
      entries,
      compendium: opts.compendium !== false,
      head: plan.head,
      counts: plan.counts,
      director: { enabled: ds.director.enabled, ...(ds.director.style !== undefined ? { style: ds.director.style } : {}), ...(turn !== undefined ? { turn } : {}), records: dirs.size },
      raw: RAW_FILES.filter((f) => (f === 'tracker.json' ? chat.tracker : f === 'storyboard.json' ? chat.storyboard : chat.dmContext) !== undefined).map((f) => `${chat.dir}/${f}`),
    });
  }

  if (notCarried.trackers > 0) {
    warnings.push({ code: 'rc_tracker', path: 'chats/*/tracker.json', message: `${plural(notCarried.trackers, 'tracker')} (relationships, calendar, resources…) not carried: rp-core has no trackers (--keep-raw keeps a copy)` });
  }
  if (notCarried.storyboards > 0) {
    warnings.push({ code: 'rc_storyboard', path: 'chats/*/storyboard.json', message: `${plural(notCarried.storyboards, 'storyboard')} (${plural(notCarried.storyboardRows, 'row')}) not carried (--keep-raw keeps a copy)` });
  }
  if (notCarried.summaries > 0) {
    const { summaries: n, summariesWithBooks: kept } = notCarried;
    const past = kept === n ? "; the lorebooks keep the story's past" : kept === 0 ? '; its text is not imported anywhere' : `; ${n - kept} of these chats have no lorebook that keeps their past`;
    warnings.push({ code: 'rc_chat_summary', path: 'chats/*/chat.json', message: `RoleCall's chat summary (${plural(n, 'chat')}, ${notCarried.summaryChars} chars) not carried${past}` });
  }
  if (notCarried.modules.size > 0) {
    warnings.push({ code: 'rc_modules', path: 'chats/*/chat.json', message: `RoleCall features rp-core does not have are not carried: ${[...notCarried.modules].join(', ')}` });
  }
  if (sessions.length === 0) throw new StoryImportError(`nothing to import: ${skipped.map((s) => `chat ${short(s.chatId)}: ${s.why}`).join('; ') || 'no chat'}`);
  // The character, the persona, the presets, then the books (the copies' place is the chat loop's).
  const rank: Record<StoryItemKind, number> = { character: 0, persona: 1, preset: 2, lorebook: 3 };
  const ordered = items.map((item, i) => ({ item, i })).sort((x, y) => rank[x.item.kind] - rank[y.item.kind] || x.i - y.i).map((x) => x.item);
  return { items: ordered, sessions, skipped, warnings };
}

/**
 * A planned session's journal: the header (its id, the library ids of its preset and books, the fork
 * when its parent is imported too) and the entries, ending with the Compendium's enable moment.
 */
export function sessionJournal(
  s: PlannedSession,
  ctx: { id: string; now: string; preset?: string; lorebooks: readonly string[]; fork?: { from: string; at: string } },
): { header: SessionHeader; entries: EntryInput[] } {
  const config = mergePatch<SessionConfig>(s.config, { ...(ctx.preset !== undefined ? { preset: ctx.preset } : {}), lorebooks: [...ctx.lorebooks] });
  const header: SessionHeader = {
    t: 'session',
    v: 1,
    id: ctx.id,
    created: s.created,
    title: s.title,
    ...(ctx.fork ? { fork: ctx.fork } : {}),
    imported: { from: 'rolecall', chat: s.chatId, exportedAt: s.exportedAt },
    cast: s.cast,
    config,
  };
  const entries: EntryInput[] = [...s.entries];
  if (s.compendium) entries.push({ t: 'config', ts: ctx.now, patch: { compendium: { enabled: true } } });
  return { header, entries };
}
