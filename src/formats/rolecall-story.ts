// Ported from RoleCall:apps/rc/src/lib/personas/generatePersonaXml.ts@fb8dc623e (generatePersonaXml,
// escapeXml, toXmlTagName: the persona text RoleCall sends) and from
// RoleCall:apps/rc/src/app/api/content/presets/[id]/export/route.ts@fb8dc623e with
// RoleCall:packages/presets-core/src/preset-parser.ts, system-prompts.ts, category-tree.ts and
// export-metadata.ts@fb8dc623e (serializePrompt, the 100001 order from the rows, the system prompt
// precedence, reconstructPresetCategoryTree, extensions.rolecall: RoleCall's preset export, built
// from the database rows).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RoleCall's per-story export, the `.rolecall` zip (`format: "rolecall-story-zip"` v1), read into a
// typed bundle and converted piece by piece (.notes/rcimport-decisions.md D-187, D-188). Pure: the
// caller reads the zip, writes the library and the journals; nothing here touches a file or a clock.
// - parseStory: the zip's members → manifest, character, persona, preset, books and the chats with
//   their messages and raw tracker / storyboard / dm-context objects, keyed on the ids inside the files
//   (directory names are lossy). story.jsonl repeats the same data and is not read.
// - chatMessages: one chat → the `msg` entries to write. Each message's swipes are sibling versions in
//   swipe order; the active one is the swipe whose text equals `content` (the last such; none: the last
//   swipe, with a warning) and is the parent of the next message; ids are 8 hex from a hash of (chat id,
//   message id, swipe index); the first message, when it is the character's, is the greeting; inline
//   reasoning is split off as RoleCall splits it from history (rolecall-think.ts), a reasoning kept
//   twice (stored and inline) once; RoleCall's name macros are written out (the caller's names).
// - personaFromRow: the text RoleCall sends for the persona (generatePersonaXml over `details` in
//   `section_order`), else the row's description.
// - presetFromRow: RoleCall's preset export rebuilt from the rows (prompts in `sort_order`, RoleCall's
//   runtime order; enabled flags in the 100001 order; extensions.rolecall), the chat's overrides
//   applied, a slot marker's own text sent as RoleCall's loader sends it, then read by stPresetToPreset,
//   whose D-71 path keys on extensions.rolecall; RoleCall's "messages" context mode becomes the
//   preset's message limit (N + 1).
// - booksFromRows: each book row wrapped as a Compendium export and read by readCompendium; identical
//   books (by a hash of their converted rows) become one; a later different book with a taken name is
//   renamed; rows a standardisation split consumed are imported disabled.
// Port notes. generatePersonaXml: identical output; RoleCall hides user-written tags behind
// placeholders keyed by a random nonce while escaping, this escapes around the tags in one pass (the
// same text, no entropy). The preset export: no category header prompts (RoleCall's runtime never sends
// categories, and their identifiers are fresh random UUIDs), so the hierarchy rides
// extensions.rolecall only; samplers, behaviour and API options are written only when the row carries
// them (the export fills RoleCall's defaults, its runtime sends only what is set); duplicate prompt
// identifiers keep the row RoleCall's loader keeps (the first enabled one with text or a marker).
// Behaviour references (facts, not code), RoleCall @fb8dc623e: lib/scenes-export/per-chat-export.ts
// (the zip), app/api/scenes/[chatId]/export-package/route.ts (row orders), lib/ai/preset-loader.ts
// (sort_order, overrides by identifier, context_mode / max_messages, the content filter before the
// identifier dedupe, the marker fills), lib/ai/jobs/message-context-window.ts (the "messages" window:
// the last user message and N before it), lib/ai/prompt-assembly.ts (persona text, overrides, history
// stripping, replaceMacrosHistorical), lib/macros/processor.ts and handlers/identity.ts (the name
// macros, their aliases and the legacy angle tokens), lib/ai/native-reasoning.ts (inline-tags),
// hooks/scene/useSamplerConfiguration.ts and lib/ai/jobs/worker.ts (sampler precedence, the chat's
// contextMode / maxMessages, keep_inline_thinking_tags), app/api/content/lorebooks/[id]/compendium/export/route.ts (the envelope),
// lib/compendium/standardize.ts (consumed_by_split), lib/import/rolecall-story-jsonl.ts (active lines).

import { createHash } from 'node:crypto';
import { unknownMacrosIn } from '../prompt/macros.ts';
import type { Block, Generation, MsgEntry } from '../session/entries.ts';
import { CardFormatError, readCard } from './card.ts';
import { COMPENDIUM_FORMAT, COMPENDIUM_SCHEMA, readCompendium } from './compendium-v1.ts';
import type { Character, Imported, ImportWarning, LoreBook, LoreEntry, Persona, Preset } from './native.ts';
import { extractPresetCoTTag, splitThinkingFromContent } from './rolecall-think.ts';
import { stPresetToPreset, ST_GLOBAL_ORDER_ID, ST_MARKER_SLOTS } from './st-preset.ts';
import { compact, isRecord, nonBlank, optNum, WarningSink, type Rec } from './wire.ts';

export const STORY_FORMAT = 'rolecall-story-zip';
export const STORY_VERSION = 1;

// ---- shared helpers ------------------------------------------------------------------------------

const UTF8 = new TextDecoder('utf-8');

const textOf = (data: Uint8Array | string): string =>
  typeof data === 'string' ? (data.charCodeAt(0) === 0xfeff ? data.slice(1) : data) : UTF8.decode(data);

const bytesOf = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A finite number (numbers written as strings too), else undefined; null is "not set". */
const num = (v: unknown): number | undefined => (v === null ? undefined : optNum(v));

/** An id-like string: a non-blank string, or a finite number as text. */
function idOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return nonBlank(v)?.trim();
}

/** The first 8 characters of an id, for names and messages. */
const short = (id: string): string => id.slice(0, 8);

/**
 * The last millisecond a stored time may name: 9999-12-31T23:59:59.999Z. From 1970 to here an ISO time
 * reads `YYYY-…` and sorts as text; a RoleCall time outside it is a broken value, not a date.
 */
export const RC_TIME_MAX = 253_402_300_799_999;

/** ISO time of a millisecond epoch (or a parseable date string) from 1970 to RC_TIME_MAX, else undefined. */
function isoOf(v: unknown): string | undefined {
  const n = typeof v === 'string' && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(v) ? Date.parse(v) : num(v);
  if (n === undefined || !Number.isFinite(n) || n < 0 || n > RC_TIME_MAX) return undefined;
  return new Date(n).toISOString();
}

/** A value present but not a usable time (isoOf refuses it). */
const badTime = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && isoOf(v) === undefined;

/** `o[key]` only when `o` has it as its own key: a RoleCall value never reaches Object.prototype ('__proto__', 'constructor'). */
function own<T>(o: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** JSON with keys sorted at every level: the same value always gives the same text. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(',')}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** A stable sort by a numeric key; rows without one keep their place after the numbered ones (SQL nulls last). */
function bySortOrder<T>(items: readonly T[], key: (item: T) => unknown): T[] {
  return items
    .map((item, i) => ({ item, i, k: num(key(item)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.k === b.k ? a.i - b.i : a.k < b.k ? -1 : 1))
    .map((x) => x.item);
}

// ---- parseStory ----------------------------------------------------------------------------------

/** One member of the zip, as the zip reader gives it. */
export interface StoryMember {
  name: string;
  data: Uint8Array | string;
}
export type StoryMembers = Iterable<StoryMember> | ReadonlyMap<string, Uint8Array | string>;

/** manifest.json, read. Ids are RoleCall's UUIDs. */
export interface StoryManifest {
  version: number;
  exportedAt?: string;
  rootChatId?: string;
  mainChatId?: string;
  characterId?: string;
  personaId?: string;
  presetId?: string;
  lorebookIds: string[];
  /** BFS order of the chat tree. */
  chatIds: string[];
  /** Chunks the exporter could not decrypt: their messages are missing from the export. */
  failedChunks: Rec[];
  appVersion?: string;
  /** The server's stats, verbatim. */
  stats?: Rec;
}

/** The character card: `characters/<name>.png` (preferred) or `.json`, read by the card importer. */
export interface StoryCharacter {
  path: string;
  bytes: Uint8Array;
  /** readCard's result; absent when the card could not be read (a warning says why). */
  card?: Imported<Character>;
  /** `<name>.raw.json`, RoleCall's database row: never imported, kept for reference. */
  raw?: Rec;
}

/** One chat of the tree (chats/<dir>/). */
export interface StoryChat {
  id: string;
  /** The member directory, `chats/<dir>`. */
  dir: string;
  parentId: string | null;
  isMain: boolean;
  branchName?: string;
  /** How many of the parent's messages the branch copied. */
  branchPointIndex?: number;
  title?: string;
  /** RoleCall's rolling chat summary. */
  summary?: string;
  personaId?: string;
  /** active_lorebooks, both of RoleCall's shapes: a plain id is enabled. */
  lorebooks: { id: string; enabled: boolean }[];
  /** The whole chat config blob (preset_id, overrides, dm*, tv_*, …). */
  config: Rec;
  createdAt?: string;
  updatedAt?: string;
  lastMessageAt?: string;
  /** messages.jsonl lines in `index` order; malformed lines are left out with a warning. */
  messages: Rec[];
  tracker?: unknown;
  storyboard?: unknown;
  dmContext?: unknown;
}

export interface StoryBundle {
  manifest: StoryManifest;
  character?: StoryCharacter;
  /** The raw `personas` row. */
  persona?: Rec;
  /** The raw `presets` row with `categories` and `prompts`. */
  preset?: Rec;
  /** Raw `lorebooks` rows, each with `entries`, in member order. */
  books: Rec[];
  /** Chats in the manifest's order (chats it does not list follow by directory name). */
  chats: StoryChat[];
  /** The chat `import` takes by default: is_main_timeline, else the manifest's main_chat_id. */
  mainChatId: string;
  warnings: ImportWarning[];
}

export type StoryParse = { ok: true; value: StoryBundle } | { ok: false; why: string };

const CHAT_FILES = new Set(['chat.json', 'messages.jsonl', 'tracker.json', 'storyboard.json', 'dm-context.json']);

function memberList(members: StoryMembers): StoryMember[] {
  if (members instanceof Map) return [...(members as Map<string, Uint8Array | string>)].map(([name, data]) => ({ name, data }));
  return [...(members as Iterable<StoryMember>)];
}

const normName = (name: string): string => name.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

/** One row of a members folder chosen by its id (the manifest's), else the first; the rest are said. */
function pickRow(rows: { path: string; row: Rec }[], id: string | undefined, what: string, sink: WarningSink): Rec | undefined {
  if (rows.length === 0) return undefined;
  const chosen = rows.find((r) => id !== undefined && idOf(r.row.id) === id) ?? rows[0]!;
  for (const r of rows) if (r !== chosen) sink.add('rc_extra_member', r.path, `a second ${what}; the story uses ${chosen.path}, this one is not imported`);
  return chosen.row;
}

/**
 * The zip's members → the story bundle. Refuses (ok: false) a zip without a manifest, a manifest of
 * another format (RoleCall's account backup is a JSON file, not this zip) or one with no chat.
 */
export function parseStory(members: StoryMembers): StoryParse {
  const sink = new WarningSink();
  const files = new Map<string, Uint8Array | string>();
  for (const m of memberList(members)) {
    const name = normName(m.name);
    if (name === '' || name.endsWith('/')) continue;
    if (files.has(name)) sink.add('rc_duplicate_member', name, 'the export holds this file twice; the first copy is read');
    else files.set(name, m.data);
  }

  const json = (path: string, data: Uint8Array | string): unknown => {
    try {
      return JSON.parse(textOf(data)) as unknown;
    } catch (e) {
      sink.add('rc_unreadable', path, `not valid JSON (${e instanceof Error ? e.message : String(e)}); not imported`);
      return undefined;
    }
  };

  const manifestData = files.get('manifest.json');
  if (manifestData === undefined) return { ok: false, why: 'no manifest.json: not a RoleCall story export' };
  let mf: unknown;
  try {
    mf = JSON.parse(textOf(manifestData)) as unknown;
  } catch {
    return { ok: false, why: 'manifest.json is not valid JSON' };
  }
  if (!isRecord(mf)) return { ok: false, why: 'manifest.json is not a JSON object' };
  if (mf.format !== STORY_FORMAT) {
    return { ok: false, why: `manifest.json names the format ${JSON.stringify(mf.format ?? null)}, not ${STORY_FORMAT}` };
  }
  const version = num(mf.version);
  if (version !== STORY_VERSION) sink.add('rc_version', 'manifest.json', `version ${JSON.stringify(mf.version ?? null)} is not ${STORY_VERSION}; read as version ${STORY_VERSION}`);
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => idOf(x) ?? []) : []);
  const manifest: StoryManifest = compact({
    version: version ?? STORY_VERSION,
    exportedAt: nonBlank(mf.exported_at),
    rootChatId: idOf(mf.root_chat_id),
    mainChatId: idOf(mf.main_chat_id),
    characterId: idOf(mf.character_id),
    personaId: idOf(mf.persona_id),
    presetId: idOf(mf.preset_id),
    lorebookIds: ids(mf.lorebook_ids),
    chatIds: ids(mf.chat_ids),
    failedChunks: Array.isArray(mf.failed_chunks) ? mf.failed_chunks.filter(isRecord) : [],
    appVersion: nonBlank(mf.app_version),
    stats: isRecord(mf.stats) ? mf.stats : undefined,
  });
  if (manifest.failedChunks.length > 0) {
    sink.add('rc_failed_chunks', 'manifest.json', `${manifest.failedChunks.length} message chunk(s) did not decrypt when RoleCall exported the story; their messages are missing`);
  }

  const cards: { path: string; data: Uint8Array | string }[] = [];
  const raws: { path: string; row: Rec }[] = [];
  const personas: { path: string; row: Rec }[] = [];
  const presets: { path: string; row: Rec }[] = [];
  const bookRows: { path: string; row: Rec }[] = [];
  const dirs = new Map<string, Map<string, Uint8Array | string>>();
  const rowAt = (path: string, data: Uint8Array | string, into: { path: string; row: Rec }[]): void => {
    const v = json(path, data);
    if (isRecord(v)) into.push({ path, row: v });
    else if (v !== undefined) sink.add('rc_unreadable', path, 'not a JSON object; not imported');
  };

  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const parts = path.split('/');
    const [top, second, third] = parts;
    if (path === 'manifest.json' || path === 'story.jsonl') continue;
    if (top === 'characters' && parts.length === 2 && second !== undefined) {
      if (second.endsWith('.raw.json')) rowAt(path, data, raws);
      else if (/\.(?:png|json)$/i.test(second)) cards.push({ path, data });
      else sink.fold('rc_unknown_member', path, 'characters/*', 'not part of the story export; ignored');
    } else if (top === 'personas' && parts.length === 2 && second?.endsWith('.json')) rowAt(path, data, personas);
    else if (top === 'presets' && parts.length === 2 && second?.endsWith('.json')) rowAt(path, data, presets);
    else if (top === 'lorebooks' && parts.length === 2 && second?.endsWith('.json')) rowAt(path, data, bookRows);
    else if (top === 'chats' && parts.length === 3 && second !== undefined && third !== undefined && CHAT_FILES.has(third)) {
      const dir = `chats/${second}`;
      const d = dirs.get(dir) ?? new Map<string, Uint8Array | string>();
      d.set(third, data);
      dirs.set(dir, d);
    } else sink.fold('rc_unknown_member', path, '*', 'not part of the story export; ignored');
  }

  // The card: the PNG when the exporter could embed the image, else the JSON (per-chat-export.ts).
  let character: StoryCharacter | undefined;
  const card = cards.find((c) => /\.png$/i.test(c.path)) ?? cards[0];
  for (const c of cards) if (c !== card) sink.add('rc_extra_member', c.path, `a second character card; the story uses ${card?.path}, this one is not imported`);
  if (card) {
    const bytes = bytesOf(card.data);
    let read: Imported<Character> | undefined;
    try {
      read = readCard(bytes, card.path.split('/').pop() ?? card.path);
    } catch (e) {
      if (!(e instanceof CardFormatError)) throw e;
      sink.add('rc_character_unreadable', card.path, `the character card could not be read: ${e.message}`);
    }
    const raw = raws.find((r) => r.path.slice(0, -'.raw.json'.length) === card.path.replace(/\.(?:png|json)$/i, ''))?.row ?? raws[0]?.row;
    character = compact({ path: card.path, bytes, card: read, raw });
  } else sink.add('rc_no_character', 'characters', 'the export has no character card');

  const persona = pickRow(personas, manifest.personaId, 'persona', sink);
  const preset = pickRow(presets, manifest.presetId, 'preset', sink);
  const books: Rec[] = [];
  for (const b of bookRows) {
    if (Array.isArray(b.row.entries)) books.push(b.row);
    else sink.add('rc_unreadable', b.path, 'a lorebook row without an entries list; not imported');
  }
  const bookIds = new Set(books.flatMap((b) => idOf(b.id) ?? []));
  const missingBooks = manifest.lorebookIds.filter((id) => !bookIds.has(id)).length;
  if (missingBooks > 0) sink.add('rc_missing_member', 'lorebooks', `${missingBooks} lorebook(s) the manifest lists are not in the export`);

  const chats: StoryChat[] = [];
  for (const [dir, d] of [...dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const chat = readChat(dir, d, json, sink);
    if (!chat) continue;
    if (chats.some((c) => c.id === chat.id)) sink.add('rc_duplicate_chat', dir, `chat ${short(chat.id)} is in the export twice; the first copy is read`);
    else chats.push(chat);
  }
  if (chats.length === 0) return { ok: false, why: 'the export holds no chat' };
  const rank = new Map(manifest.chatIds.map((id, i) => [id, i]));
  chats.sort((a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY));
  const unlisted = chats.filter((c) => !rank.has(c.id)).length;
  if (unlisted > 0 && manifest.chatIds.length > 0) sink.add('rc_unlisted_chat', 'chats', `${unlisted} chat folder(s) the manifest does not list; read after the listed ones`);
  const missingChats = manifest.chatIds.filter((id) => !chats.some((c) => c.id === id)).length;
  if (missingChats > 0) sink.add('rc_missing_member', 'chats', `${missingChats} chat(s) the manifest lists are not in the export`);

  const mains = chats.filter((c) => c.isMain);
  if (mains.length > 1) sink.add('rc_main_chat', 'chats', `${mains.length} chats are marked as the main timeline; the first in the tree is taken`);
  const main = mains[0] ?? chats.find((c) => c.id === manifest.mainChatId);
  if (!main) sink.add('rc_main_chat', 'chats', `no chat is the main timeline; the first in the tree (${short(chats[0]!.id)}) is taken`);
  const mainChatId = (main ?? chats[0]!).id;

  // Hidden flags and images: the exporter writes neither (per-chat-export.ts); said once each.
  const all = chats.flatMap((c) => c.messages);
  if (all.length > 0 && !all.some((m) => 'is_hidden' in m)) {
    sink.add('rc_hidden_unavailable', 'chats', "the story export does not say which messages were hidden in RoleCall; every message is imported visible");
  }
  if (all.length > 0 && !all.some((m) => Array.isArray(m.images) && m.images.length > 0)) {
    sink.add('rc_images_unavailable', 'chats', 'the story export carries no message images; none are imported');
  }

  return { ok: true, value: compact({ manifest, character, persona, preset, books, chats, mainChatId, warnings: sink.list() }) };
}

function readChat(
  dir: string,
  d: ReadonlyMap<string, Uint8Array | string>,
  json: (path: string, data: Uint8Array | string) => unknown,
  sink: WarningSink,
): StoryChat | undefined {
  const at = (file: string): string => `${dir}/${file}`;
  const chatData = d.get('chat.json');
  if (chatData === undefined) {
    sink.add('rc_missing_member', dir, 'a chat folder without chat.json; not imported');
    return undefined;
  }
  const c = json(at('chat.json'), chatData);
  if (!isRecord(c)) {
    if (c !== undefined) sink.add('rc_unreadable', at('chat.json'), 'not a JSON object; the chat is not imported');
    return undefined;
  }
  const id = idOf(c.id);
  if (id === undefined) {
    sink.add('rc_unreadable', at('chat.json'), 'the chat has no id; not imported');
    return undefined;
  }

  const messages: Rec[] = [];
  const lines = d.get('messages.jsonl');
  if (lines === undefined) sink.add('rc_missing_member', at('messages.jsonl'), 'the chat has no messages.jsonl; imported without messages');
  else {
    textOf(lines)
      .split('\n')
      .forEach((line, i) => {
        if (line.trim() === '') return;
        let v: unknown;
        try {
          v = JSON.parse(line) as unknown;
        } catch {
          v = undefined;
        }
        if (isRecord(v)) messages.push(v);
        else sink.fold('rc_bad_line', `${at('messages.jsonl')}:${i + 1}`, 'chats/*/messages.jsonl', 'a line that is not a JSON object; skipped');
      });
  }
  // The exporter writes messages in `index` order; a file out of order is put back in it (stable).
  const ordered = messages.every((m) => num(m.index) !== undefined) ? bySortOrder(messages, (m) => m.index) : messages;

  const lorebooks: { id: string; enabled: boolean }[] = [];
  for (const v of Array.isArray(c.active_lorebooks) ? c.active_lorebooks : []) {
    const bookId = isRecord(v) ? idOf(v.id) : idOf(v);
    if (bookId !== undefined && !lorebooks.some((b) => b.id === bookId)) lorebooks.push({ id: bookId, enabled: !isRecord(v) || v.enabled !== false });
  }
  const opt = (file: string): unknown => {
    const data = d.get(file);
    return data === undefined ? undefined : json(at(file), data);
  };
  return compact({
    id,
    dir,
    parentId: idOf(c.parent_chat_id) ?? null,
    isMain: c.is_main_timeline === true,
    branchName: nonBlank(c.branch_name),
    branchPointIndex: num(c.branch_point_index),
    title: nonBlank(c.title),
    summary: nonBlank(c.summary),
    personaId: idOf(c.active_persona_id),
    lorebooks,
    config: isRecord(c.config) ? c.config : {},
    createdAt: nonBlank(c.created_at),
    updatedAt: nonBlank(c.updated_at),
    lastMessageAt: nonBlank(c.last_message_at),
    messages: ordered,
    tracker: opt('tracker.json'),
    storyboard: opt('storyboard.json'),
    dmContext: opt('dm-context.json'),
  });
}

// ---- chatMessages --------------------------------------------------------------------------------

/** A `msg` entry to write, without its seq (the writer numbers the journal). */
export type PlannedMsg = Omit<MsgEntry, 'seq'>;

/** One RoleCall message of the plan. */
export interface PlannedMessage {
  /** RoleCall's message id (`m_<index>` when the line has none). */
  rcId: string;
  index: number;
  role: 'user' | 'assistant';
  /** The id of the active version: on the path, the parent of the next message. */
  active: string;
  /** Every version's id, in swipe order. */
  versions: string[];
  /** User messages up to and including this one (RoleCall's Director turn at this message). */
  users: number;
  /** sha256 of role and RoleCall's `content`: two chats share a message when these are equal. */
  contentHash: string;
}

export interface MessagePlan {
  /** The entries in write order: every parent precedes its children. */
  entries: PlannedMsg[];
  messages: PlannedMessage[];
  /** The active version of the last message (null for a chat without messages). */
  head: string | null;
  /** True when the newest entry is not `head`: the writer appends a `head` entry on it. */
  headMove: boolean;
  /** Active versions RoleCall marked hidden (`is_hidden: true`); the export does not carry the flag today. */
  hidden: string[];
  /** sha256 over every message's contentHash: equal for two chats with the same messages. */
  fingerprint: string;
  counts: {
    messages: number;
    versions: number;
    users: number;
    /** Versions whose inline reasoning was split off. */
    reasoning: number;
    /** …of which at least one block was unclosed (RoleCall's terminator or swallow rule). */
    unclosed: number;
    /** …of which nothing visible was left. */
    emptied: number;
    /** Versions without reasoning that lost a stray reasoning tag (a lone `</think>`), as in RoleCall's history. */
    cleaned: number;
  };
  warnings: ImportWarning[];
}

export interface ChatMessagesOptions {
  /**
   * Extra reasoning tag names. The chat's own Start Reply With tag is added already; RoleCall adds no
   * other (the preset's assistant prefill is not a reasoning tag there).
   */
  extraTags?: string | readonly string[];
  /**
   * A branch that copied its parent's first `count` messages: their ids are derived from the parent
   * chat's id, so they equal the parent session's (RoleCall copies message ids with the messages).
   */
  prefixFrom?: { chatId: string; count: number };
  /**
   * The same, message by message: message k takes its ids from `prefixSalts[k]` (a branch of a branch
   * copies a prefix whose first messages carry the grandparent's ids). Wins over `prefixFrom`.
   */
  prefixSalts?: readonly string[];
  /**
   * The persona's and the character's names: RoleCall's name macros in the messages ({{user}},
   * {{char}} and their spellings) are written out, as RoleCall showed them and sent them as history.
   */
  names?: { user: string; char: string };
}

/**
 * RoleCall's name macros (lib/macros: names are read case-insensitively, `{{char}}` has the aliases
 * character and bot, `{{user}}` has player; the legacy `<user>`, `<char>`, `<bot>` tokens are the same
 * macros). `\{{` stays as written.
 */
const RC_NAME_MACRO = /(?<!\\)\{\{\s*(user|player|char|character|bot)\s*\}\}|<(user|char|bot)>/gi;

/** A message's text with RoleCall's name macros written out. */
export function rcNames(text: string, names: { user: string; char: string }): string {
  return text.replace(RC_NAME_MACRO, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b ?? '').toLowerCase();
    return name === 'user' || name === 'player' ? names.user : names.char;
  });
}

/** The 8-hex id of a version: sha256 of (chat id, message id, swipe index[, retry]). */
export function rcMsgId(chatId: string, messageId: string, swipe: number, retry = 0): string {
  return sha256(`${chatId}\u0000${messageId}\u0000${swipe}${retry > 0 ? `\u0000${retry}` : ''}`).slice(0, 8);
}

/** Whether RoleCall kept inline reasoning in the history of this chat (keep_inline_thinking_tags, else send_thinking_to_llm). */
export function keepsInlineThinking(config: Rec): boolean {
  const so = isRecord(config.sampler_overrides) ? config.sampler_overrides : {};
  const enabled = isRecord(so.enabled) ? so.enabled : {};
  const values = isRecord(so.values) ? so.values : {};
  const sent = (id: string): unknown => (enabled[id] === true && values[id] !== undefined && values[id] !== null ? values[id] : undefined);
  return Boolean(sent('keep_inline_thinking_tags') ?? sent('send_thinking_to_llm') ?? false);
}

interface Version {
  text: string;
  ts?: string;
  /** The swipe's timestamp was there but is no usable time. */
  badTs?: boolean;
  model?: string;
  ms?: number;
  reasoning?: string;
  /** RoleCall's reasoning_provider: 'inline-tags' when `reasoning` is the <think> block in the content. */
  provider?: string;
}

const FINISH: Readonly<Record<string, NonNullable<Generation['finish']>>> = {
  stop: 'end',
  end_turn: 'end',
  length: 'length',
  max_tokens: 'length',
  content_filter: 'content_filter',
};

/** A swipe (an object, or a bare string in old exports) as a version; undefined when it has no text. */
function versionOf(s: unknown): (Version & { finish?: Generation['finish'] }) | undefined {
  if (typeof s === 'string') return { text: s };
  if (!isRecord(s) || typeof s.content !== 'string') return undefined;
  const finish = typeof s.finishReason === 'string' ? own(FINISH, s.finishReason) : undefined;
  return compact({
    text: s.content,
    ts: isoOf(s.timestamp),
    badTs: badTime(s.timestamp) || undefined,
    model: nonBlank(s.model)?.trim(),
    ms: num(s.generationTimeMs),
    reasoning: nonBlank(s.reasoning),
    provider: nonBlank(s.reasoning_provider),
    finish,
  });
}

/** One millisecond after an ISO time, within RC_TIME_MAX (at the very end the same time again). */
function after(iso: string): string {
  const t = Date.parse(iso) + 1;
  return Number.isFinite(t) && t <= RC_TIME_MAX ? new Date(t).toISOString() : iso;
}

/**
 * One chat → its `msg` entries (D-188). Never throws: lines it cannot use are skipped with a warning.
 */
export function chatMessages(chat: StoryChat, opts: ChatMessagesOptions = {}): MessagePlan {
  const sink = new WarningSink();
  const entries: PlannedMsg[] = [];
  const messages: PlannedMessage[] = [];
  const hidden: string[] = [];
  const used = new Set<string>();
  const counts = { messages: 0, versions: 0, users: 0, reasoning: 0, unclosed: 0, emptied: 0, cleaned: 0 };

  const so = isRecord(chat.config.sampler_overrides) ? chat.config.sampler_overrides : {};
  const chatTag = extractPresetCoTTag(nonBlank(so.prefill));
  const extra = [...(typeof opts.extraTags === 'string' ? [opts.extraTags] : (opts.extraTags ?? [])), ...(chatTag ? [chatTag] : [])];
  const keepInline = keepsInlineThinking(chat.config);
  if (keepInline) sink.add('rc_reasoning_kept', `${chat.dir}/chat.json`, 'RoleCall kept inline reasoning in this chat\'s history (keep inline thinking tags); the answers are imported verbatim');

  let parent: string | null = null;
  let lastTs = isoOf(chat.createdAt) ?? new Date(0).toISOString();
  let badTimes = 0;
  let first = true;
  chat.messages.forEach((m, pos) => {
    const where = `${chat.dir}/messages.jsonl[${pos}]`;
    if (m.is_active_swipe === false) {
      // A legacy per-swipe line that is not the selected one (RoleCall's own reader drops these too).
      sink.fold('rc_inactive_line', where, `${chat.dir}/messages.jsonl[*]`, 'a line marked as an inactive swipe; skipped, as RoleCall does');
      return;
    }
    const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : m.is_user === true ? 'user' : m.is_user === false ? 'assistant' : undefined;
    if (role === 'system') {
      sink.fold('rc_system_message', where, `${chat.dir}/messages.jsonl[*]`, 'a system message has no rp-core place in the chat; skipped');
      return;
    }
    if (role === undefined) {
      sink.fold('rc_bad_message', where, `${chat.dir}/messages.jsonl[*]`, 'a message with no user or assistant role; skipped');
      return;
    }
    const content = typeof m.content === 'string' ? m.content : undefined;
    const index = num(m.index) ?? pos;
    const rcId = idOf(m.message_id) ?? `m_${index}`;
    const versions: (Version & { finish?: Generation['finish'] })[] = [];
    let badSwipes = 0;
    for (const s of Array.isArray(m.swipes) ? m.swipes : []) {
      const v = versionOf(s);
      if (v) versions.push(v);
      else badSwipes++;
    }
    if (badSwipes > 0) sink.fold('rc_bad_swipe', where, `${chat.dir}/messages.jsonl[*].swipes`, 'a swipe without text; skipped');
    if (versions.length === 0) {
      if (content === undefined) {
        sink.fold('rc_bad_message', where, `${chat.dir}/messages.jsonl[*]`, 'a message with neither content nor swipes; skipped');
        return;
      }
      versions.push({ text: content });
    }
    let active = content === undefined ? -1 : versions.map((v) => v.text).lastIndexOf(content);
    if (active < 0) {
      active = versions.length - 1;
      sink.fold('rc_active_swipe_missing', where, `${chat.dir}/messages.jsonl[*]`, "the message's text matches none of its swipes; the last swipe is taken as the active one");
    }
    const greeting = first && role === 'assistant';
    first = false;
    const msgTs = isoOf(m.timestamp);
    if (badTime(m.timestamp)) badTimes++;
    const thinking = nonBlank(m.thinking);
    const k = messages.length;
    const salt = opts.prefixSalts?.[k] ?? (opts.prefixFrom !== undefined && k < opts.prefixFrom.count ? opts.prefixFrom.chatId : chat.id);

    const ids: string[] = [];
    versions.forEach((v, j) => {
      let id = rcMsgId(salt, rcId, j);
      for (let retry = 1; used.has(id); retry++) id = rcMsgId(salt, rcId, j, retry);
      used.add(id);
      ids.push(id);

      const reasoning: string[] = [];
      for (const r of [j === active ? thinking : undefined, v.reasoning]) if (r !== undefined) reasoning.push(r);
      let text = v.text;
      if (role === 'assistant' && !keepInline) {
        const split = splitThinkingFromContent(v.text, extra);
        text = split.visibleContent;
        if (split.reasoning !== null) {
          // RoleCall keeps a reasoning it caught inline twice: as the swipe's reasoning and as the
          // <think> block written back into the content (reasoning_provider 'inline-tags'). One block.
          const caught = split.reasoning;
          const twin = v.provider === 'inline-tags' && v.reasoning !== undefined ? v.reasoning : reasoning.find((r) => r.trim() === caught.trim());
          if (twin !== undefined) reasoning.splice(reasoning.indexOf(twin), 1);
          reasoning.push(caught);
          counts.reasoning++;
          if (split.blocks.some((b) => b.capture.via === 'unclosed')) counts.unclosed++;
          if (text.trim() === '') counts.emptied++;
        } else if (text !== v.text) counts.cleaned++;
      }
      if (opts.names) text = rcNames(text, opts.names);
      const blocks: Block[] = [...reasoning.map((r): Block => ({ k: 'reasoning', text: r })), { k: 'text', text }];

      if (v.badTs) badTimes++;
      const ts = v.ts ?? msgTs ?? after(lastTs);
      lastTs = ts;
      const gen: Generation | undefined =
        role !== 'assistant' ? undefined : greeting ? { kind: 'greeting' } : compact({ kind: 'model' as const, model: v.model, ms: v.ms, finish: v.finish });
      entries.push(compact({ t: 'msg' as const, ts, id, parent, role, blocks, gen }));
    });

    counts.messages++;
    counts.versions += versions.length;
    if (role === 'user') counts.users++;
    const activeId = ids[active]!;
    if (m.is_hidden === true) hidden.push(activeId);
    messages.push({ rcId, index, role, active: activeId, versions: ids, users: counts.users, contentHash: sha256(`${role}\u0000${content ?? versions[active]!.text}`) });
    parent = activeId;
  });

  if (counts.reasoning > 0) {
    sink.add(
      'rc_reasoning_split',
      `${chat.dir}/messages.jsonl`,
      `${counts.reasoning} answer version(s): inline reasoning moved to a reasoning block, as RoleCall strips it from history (${counts.unclosed} with an unclosed tag ended by RoleCall's rule, ${counts.emptied} left no visible text)`,
    );
  }
  if (counts.cleaned > 0) {
    sink.add('rc_reasoning_tag', `${chat.dir}/messages.jsonl`, `${counts.cleaned} answer version(s) lost a stray reasoning tag, as in RoleCall's history`);
  }
  if (badTimes > 0) {
    sink.add('rc_bad_time', `${chat.dir}/messages.jsonl`, `${badTimes} timestamp(s) are no time from 1970 to 9999 and are not used (a version left without a time takes the time before it + 1 ms)`);
  }
  const head = parent;
  return {
    entries,
    messages,
    head,
    headMove: head !== null && entries[entries.length - 1]?.id !== head,
    hidden,
    fingerprint: sha256(messages.map((x) => x.contentHash).join('\n')),
    counts,
    warnings: sink.list(),
  };
}

// ---- persona -------------------------------------------------------------------------------------

/** RoleCall's PersonaSection, in its default order (generatePersonaXml). */
const DEFAULT_SECTION_ORDER = ['appearance', 'body', 'personality', 'quirks', 'history'] as const;

/** A label as an XML tag name: lower case, spaces to underscores, other characters dropped. */
function toXmlTagName(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/** `<word>`, `</word>`, `<word/>` with plain attributes: user-written tags RoleCall leaves as they are. */
const XML_TAG = /<\/?[\w-]+(?:\s+[\w-]+(?:="[^"]*")?)*\s*\/?>/g;

/**
 * RoleCall's escapeXml: ampersands that start no entity are escaped first; then <, >, " and ' are
 * escaped everywhere except inside the user-written tags found in that text.
 */
function escapeXml(str: string): string {
  const amp = str.replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;');
  const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  let out = '';
  let from = 0;
  for (const tag of amp.matchAll(XML_TAG)) {
    out += esc(amp.slice(from, tag.index)) + tag[0];
    from = tag.index + tag[0].length;
  }
  return out + esc(amp.slice(from));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** Newline runs condensed to one, trimmed (RoleCall's cleaning of the long sections). */
const condensed = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/\n+/g, '\n').trim() : '';
  return s === '' ? undefined : s;
};

/** RoleCall's generatePersonaXml (indent two spaces, no empty tags). */
export function generatePersonaXml(name: string, details: Rec): string {
  const i1 = '  ';
  const i2 = '    ';
  const lines: string[] = [`<persona name="${escapeXml(name)}">`];
  const pronouns = str(details.pronouns);
  const title = str(details.title);
  const height = str(details.height);
  const age = str(details.age);
  if (pronouns || title || height || age) {
    lines.push(`${i1}<identity>`);
    if (pronouns) lines.push(`${i2}<pronouns>${escapeXml(pronouns)}</pronouns>`);
    if (title) lines.push(`${i2}<title>${escapeXml(title)}</title>`);
    if (height) lines.push(`${i2}<height>${escapeXml(height)}</height>`);
    if (age) lines.push(`${i2}<age>${escapeXml(age)}</age>`);
    lines.push(`${i1}</identity>`);
  }
  const order = Array.isArray(details.section_order) ? details.section_order : DEFAULT_SECTION_ORDER;
  for (const section of order) {
    switch (section) {
      case 'appearance': {
        for (const color of Array.isArray(details.colors) ? details.colors : []) {
          if (!isRecord(color)) continue;
          const label = str(color.label);
          const colorName = str(color.name);
          if (!label || !colorName) continue;
          const tag = toXmlTagName(label);
          if (!tag) continue;
          const hex = str(color.hex);
          lines.push(`${i1}<${tag}>${escapeXml(hex ? `${colorName} (${hex})` : colorName)}</${tag}>`);
        }
        const appearance = condensed(details.appearance);
        if (appearance) lines.push(`${i1}<appearance>${escapeXml(appearance)}</appearance>`);
        break;
      }
      case 'personality': {
        const personality = condensed(details.personality);
        if (personality) lines.push(`${i1}<personality>${escapeXml(personality)}</personality>`);
        const traits = Array.isArray(details.traits) ? details.traits.filter((t): t is string => typeof t === 'string') : [];
        if (traits.length > 0) lines.push(`${i1}<traits>${traits.map(escapeXml).join(', ')}</traits>`);
        break;
      }
      case 'quirks': {
        const quirks = condensed(details.quirks);
        if (quirks) lines.push(`${i1}<quirks>${escapeXml(quirks)}</quirks>`);
        break;
      }
      case 'history': {
        const history = condensed(details.history);
        if (history) lines.push(`${i1}<history>${escapeXml(history)}</history>`);
        break;
      }
      default:
        break; // 'body' is part of appearance
    }
  }
  lines.push('</persona>');
  return lines.join('\n');
}

/**
 * A RoleCall persona row → a session persona (D-187): the text RoleCall sends (the XML of `details`
 * in the row's `section_order`, after `details.injection_prefix`), else the row's description when
 * `details` renders nothing.
 */
export function personaFromRow(row: unknown): Imported<Persona> {
  const sink = new WarningSink();
  const r: Rec = isRecord(row) ? row : {};
  if (!isRecord(row)) sink.add('invalid_value', '$', 'the persona row is not an object; an empty persona is used');
  const name = nonBlank(r.name)?.trim() ?? 'User';
  if (nonBlank(r.name) === undefined) sink.add('invalid_value', 'name', 'the persona has no name; "User" is used, as RoleCall does');
  const fallback = nonBlank(r.description) ?? nonBlank(r.content) ?? '';
  if (!isRecord(r.details)) {
    if (r.details !== undefined && r.details !== null) sink.add('invalid_value', 'details', 'details is not an object; the description is used');
    return { value: { name, description: fallback }, warnings: sink.list() };
  }
  const details: Rec = Array.isArray(r.section_order) ? { ...r.details, section_order: r.section_order } : r.details;
  const xml = generatePersonaXml(typeof r.name === 'string' ? r.name : name, details);
  const prefix = str(details.injection_prefix);
  if (xml.split('\n').length <= 2 && prefix === undefined) {
    sink.add('rc_persona_description', 'details', "the persona's details render no text; its description is used");
    return { value: { name, description: fallback }, warnings: sink.list() };
  }
  return { value: { name, description: prefix ? `${prefix}\n${xml}` : xml }, warnings: sink.list() };
}

// ---- preset --------------------------------------------------------------------------------------

/** The structural markers RoleCall's export writes in ST's sparse shape. */
const STRUCTURAL_MARKERS = new Set(['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples', 'personaDescription']);

/** RoleCall's normalizeInjectionPosition: 0 relative, 1 in-chat, 2 append, 3 append-bottom, 4 prepend-top. */
function normalizeInjectionPosition(v: unknown): number {
  if (v === 1 || v === '1' || v === 'in-chat') return 1;
  if (v === 2 || v === '2' || v === 'append') return 2;
  if (v === 3 || v === '3' || v === 'append-bottom') return 3;
  if (v === 4 || v === '4' || v === 'prepend-top') return 4;
  return 0;
}

const POST_PROCESSING = ['none', 'merge', 'semi', 'strict', 'single'];
const postProcessingOf = (v: unknown): string | undefined => (typeof v === 'string' && POST_PROCESSING.includes(v) ? v : undefined);

/** The eight system prompts, snake_case (canonical) → camelCase alias (presets-core system-prompts.ts). */
const SYSTEM_PROMPTS: readonly (readonly [string, string])[] = [
  ['impersonation_prompt', 'impersonationPrompt'],
  ['new_chat_prompt', 'newChatPrompt'],
  ['new_group_chat_prompt', 'newGroupChatPrompt'],
  ['new_example_chat_prompt', 'newExampleChatPrompt'],
  ['continue_nudge_prompt', 'continueNudgePrompt'],
  ['group_nudge_prompt', 'groupNudgePrompt'],
  ['assistant_prefill', 'assistantPrefill'],
  ['assistant_impersonation', 'assistantImpersonation'],
];

/** The authored value of one system prompt: the first spelling holding a string wins, an empty one included. */
function authoredSystemPrompt(blob: unknown, snake: string, camel: string): string | undefined {
  if (!isRecord(blob)) return undefined;
  for (const key of [snake, camel]) if (typeof blob[key] === 'string') return blob[key];
  return undefined;
}

/** Sampler columns of the row → the export's keys. */
const ROW_SAMPLERS: readonly (readonly [string, string])[] = [
  ['temperature', 'temperature'],
  ['frequency_penalty', 'frequency_penalty'],
  ['presence_penalty', 'presence_penalty'],
  ['top_p', 'top_p'],
  ['top_k', 'top_k'],
  ['top_a', 'top_a'],
  ['min_p', 'min_p'],
  ['repetition_penalty', 'repetition_penalty'],
  ['max_context', 'openai_max_context'],
  ['max_tokens', 'openai_max_tokens'],
];
/** The chat's preset_sampler_overrides (camelCase, numbers only) → the export's keys; true = rounded. */
const CHAT_SAMPLERS: readonly (readonly [string, string, boolean])[] = [
  ['temperature', 'temperature', false],
  ['topP', 'top_p', false],
  ['topK', 'top_k', true],
  ['maxTokens', 'openai_max_tokens', true],
  ['maxContext', 'openai_max_context', false],
  ['frequencyPenalty', 'frequency_penalty', false],
  ['presencePenalty', 'presence_penalty', false],
  ['minP', 'min_p', false],
  ['topA', 'top_a', false],
  ['repetitionPenalty', 'repetition_penalty', false],
];
/** Generation-panel samplers (sampler_overrides, when enabled) rp-core has a place for. */
const PANEL_SAMPLERS: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  repetition_penalty: 'repetition_penalty',
  seed: 'seed',
  max_tokens: 'openai_max_tokens',
};
/** Panel switches that shape the history, not the request: chatMessages reads them. */
const HISTORY_SWITCHES = new Set(['keep_inline_thinking_tags', 'send_thinking_to_llm']);

const BEHAVIOR_KEYS = ['wrap_in_quotes', 'names_behavior', 'send_if_empty', 'continue_prefill', 'continue_postfix'];
const API_OPTION_KEYS = [
  'stream_openai',
  'claude_use_sysprompt',
  'use_makersuite_sysprompt',
  'squash_system_messages',
  'function_calling',
  'show_thoughts',
  'reasoning_effort',
  'enable_web_search',
  'request_images',
];
/** media_settings / generation_settings are stored camelCase; the export writes ST's names. */
const MEDIA_KEYS: readonly (readonly [string, string])[] = [
  ['imageInlining', 'image_inlining'],
  ['inlineImageQuality', 'inline_image_quality'],
  ['videoInlining', 'video_inlining'],
];
const GENERATION_KEYS: readonly (readonly [string, string])[] = [
  ['seed', 'seed'],
  ['n', 'n'],
  ['maxContextUnlocked', 'max_context_unlocked'],
  ['biasPresetSelected', 'bias_preset_selected'],
];

interface HierarchyNode {
  name: unknown;
  content: string;
  prompt_identifiers: string[];
  children: HierarchyNode[];
}

/** reconstructPresetCategoryTree: parents by parent_id; a missing parent, a self-link or a cycle makes a root. */
function categoryHierarchy(categories: readonly Rec[], prompts: readonly Rec[]): HierarchyNode[] {
  const byId = new Map<string, HierarchyNode>();
  const parentOf = new Map<string, string | null>();
  for (const c of categories) {
    const id = idOf(c.id);
    if (id === undefined || byId.has(id)) continue;
    byId.set(id, { name: c.name, content: typeof c.content === 'string' ? c.content : '', prompt_identifiers: [], children: [] });
    parentOf.set(id, idOf(c.parent_id) ?? null);
  }
  const acyclic = (id: string, parent: string): boolean => {
    if (!byId.has(parent) || id === parent) return false;
    const seen = new Set([id]);
    for (let cur: string | null = parent; cur !== null; cur = parentOf.get(cur) ?? null) {
      if (seen.has(cur)) return false;
      seen.add(cur);
    }
    return true;
  };
  const roots: HierarchyNode[] = [];
  for (const [id, node] of byId) {
    const parent = parentOf.get(id) ?? null;
    if (parent !== null && acyclic(id, parent)) byId.get(parent)!.children.push(node);
    else roots.push(node);
  }
  for (const p of prompts) {
    const cat = idOf(p.category_id);
    const ident = idOf(p.identifier);
    if (cat !== undefined && ident !== undefined) byId.get(cat)?.prompt_identifiers.push(ident);
  }
  return roots;
}

/** serializePrompt: ST's sparse shape for the structural markers, the full bundle for the rest. */
function exportPrompt(p: Rec): Rec {
  const identifier = idOf(p.identifier);
  const name = typeof p.name === 'string' ? p.name : undefined;
  const marker = p.marker === true;
  if (marker && identifier !== undefined && STRUCTURAL_MARKERS.has(identifier)) {
    return compact({ identifier, name, system_prompt: p.system_prompt === true, marker: true });
  }
  return compact({
    identifier,
    name,
    content: typeof p.content === 'string' ? p.content : '',
    role: nonBlank(p.role) ?? 'system',
    system_prompt: p.system_prompt === true,
    injection_position: normalizeInjectionPosition(p.injection_position),
    injection_depth: num(p.injection_depth) ?? 4,
    injection_order: num(p.injection_order) ?? 100,
    forbid_overrides: p.forbid_overrides === true,
    injection_trigger: Array.isArray(p.injection_trigger) ? p.injection_trigger : [],
    marker: marker ? true : undefined,
  });
}

/**
 * The prompt rows as RoleCall's loader sends a marker that carries its own text (preset-loader.ts;
 * the slot markers otherwise send only their slot): chatHistory sends its text and then the history
 * (`text\n\n{{message_history}}`, unless a sent prompt holds {{message_history}} already),
 * personaDescription its text and then the persona (unless a sent prompt holds {{persona}}),
 * worldInfoBefore / worldInfoAfter their text where they stand, next to the lore it places after
 * them; charDescription, charPersonality, scenario and dialogueExamples are filled only when empty,
 * so their text is sent instead of the card field. A text that replaces its slot becomes an ordinary
 * prompt (identifier `<marker>Text`: the identifier decides a slot); a lore marker keeps its slot and
 * gets its text in such a prompt just before it. `enabled` is set for the rows made here.
 */
function markerTexts(prompts: readonly Rec[], sendable: (p: Rec) => boolean): { row: Rec; enabled?: boolean }[] {
  const sent = prompts.filter(sendable);
  const textOf = (p: Rec): string => (typeof p.content === 'string' ? p.content : '');
  const held = (has: (text: string) => boolean): boolean => sent.some((p) => has(textOf(p)));
  const taken = new Set(prompts.flatMap((p) => idOf(p.identifier) ?? []));
  const textId = (ident: string): string => {
    let id = `${ident}Text`;
    for (let n = 2; taken.has(id); n++) id = `${ident}Text${n}`;
    taken.add(id);
    return id;
  };
  return prompts.flatMap((p): { row: Rec; enabled?: boolean }[] => {
    const ident = idOf(p.identifier);
    const text = textOf(p);
    if (p.marker !== true || ident === undefined || !Object.hasOwn(ST_MARKER_SLOTS, ident) || text.trim() === '' || !sendable(p)) return [{ row: p }];
    const plain = (content: string): Rec => ({ ...p, identifier: textId(ident), content, marker: false });
    if (ident === 'worldInfoBefore' || ident === 'worldInfoAfter') return [{ row: plain(text), enabled: true }, { row: p, enabled: true }];
    const slot =
      ident === 'chatHistory' && !held((t) => t.toLowerCase().includes('{{message_history}}'))
        ? '\n\n{{message_history}}'
        : ident === 'personaDescription' && !held((t) => t.includes('{{persona}}'))
          ? '\n\n{{persona}}'
          : '';
    return [{ row: plain(text + slot), enabled: true }];
  });
}

/** The chat whose overrides apply to the preset: its config blob (chat.json `config`). */
export interface PresetChat {
  config?: unknown;
}

export interface RcPresetExport {
  /** RoleCall's preset export (ST grammar with extensions.rolecall), built from the row. */
  json: Rec;
  /** The chat's overrides changed something (the caller saves the result as a copy). */
  overridden: boolean;
  warnings: ImportWarning[];
  /**
   * RoleCall's "messages" context mode: the user's message plus the N before it (N + 1), for the
   * preset's `context.maxMessages` (ST's grammar has no such field). Absent in token mode.
   */
  maxMessages?: number;
}

/**
 * The preset row (with `prompts` and `categories`) → RoleCall's preset export, the chat's overrides
 * applied: prompt toggles (`preset_prompt_overrides[<row id>]`), the generation panel's enabled
 * samplers (`sampler_overrides`), then `preset_sampler_overrides` (RoleCall's precedence: the preset,
 * then the request).
 */
export function rcPresetExport(row: unknown, chat?: PresetChat): RcPresetExport {
  const sink = new WarningSink();
  const r: Rec = isRecord(row) ? row : {};
  if (!isRecord(row)) sink.add('invalid_value', '$', 'the preset row is not an object; an empty preset is used');
  const config: Rec = isRecord(chat?.config) ? chat.config : {};
  const presetId = idOf(r.id);
  const allToggles = isRecord(config.preset_prompt_overrides) ? config.preset_prompt_overrides : {};
  const presetToggles = presetId !== undefined ? own(allToggles, presetId) : undefined;
  const rawToggles = isRecord(presetToggles) ? presetToggles : {};
  const toggles = new Map<string, boolean>();
  for (const [ident, on] of Object.entries(rawToggles)) if (typeof on === 'boolean') toggles.set(ident, on);
  const changed: string[] = [];

  // Prompts in RoleCall's runtime order (preset-loader: sort_order ascending).
  const rows = bySortOrder((Array.isArray(r.prompts) ? r.prompts : []).filter(isRecord), (p) => p.sort_order);
  const enabledOf = (p: Rec): boolean => {
    const ident = idOf(p.identifier);
    return (ident !== undefined ? toggles.get(ident) : undefined) ?? p.enabled === true;
  };
  // What RoleCall's loader sends: enabled rows with text or a marker flag (`enabled && (content.trim()
  // || marker)`), then the first of those per identifier. A row it would not send never wins over one
  // it would; with none to send, the first row stays (disabled).
  const sendable = (p: Rec): boolean => enabledOf(p) && ((typeof p.content === 'string' && p.content.trim() !== '') || p.marker === true);
  const winner = new Map<string, Rec>();
  for (const p of rows) {
    const ident = idOf(p.identifier);
    if (ident === undefined) continue;
    const was = winner.get(ident);
    if (was === undefined || (!sendable(was) && sendable(p))) winner.set(ident, p);
  }
  const prompts = rows.filter((p) => {
    const ident = idOf(p.identifier);
    return ident === undefined || winner.get(ident) === p;
  });
  if (prompts.length < rows.length) {
    sink.add('rc_duplicate_prompt', 'prompts', `${rows.length - prompts.length} prompt row(s) repeat an identifier; RoleCall sends the first enabled one with text (or a marker), so the others are left out`);
  }
  const known = new Set(prompts.flatMap((p) => idOf(p.identifier) ?? []));
  const applied = [...toggles.keys()].filter((k) => known.has(k));
  const flipped = prompts.filter((p) => {
    const ident = idOf(p.identifier);
    return ident !== undefined && toggles.has(ident) && toggles.get(ident) !== (p.enabled === true);
  }).length;
  if (flipped > 0) changed.push(`${flipped} prompt toggle(s)`);
  if (applied.length < toggles.size) {
    sink.add('rc_preset_overrides', 'preset_prompt_overrides', `${toggles.size - applied.length} prompt toggle(s) of the chat name prompts the preset does not have; ignored`);
  }

  const json: Rec = {};
  const raw = isRecord(r.raw_settings) ? r.raw_settings : {};
  // defineProperty: a '__proto__' key stays a key (assigning it would set the object's prototype).
  for (const [k, v] of Object.entries(raw)) if (k !== 'extensions') Object.defineProperty(json, k, { value: v, writable: true, enumerable: true, configurable: true });
  json.name = typeof r.name === 'string' ? r.name : undefined;

  for (const [col, key] of ROW_SAMPLERS) {
    const v = num(r[col]);
    if (v !== undefined) json[key] = v;
  }
  const so = isRecord(config.sampler_overrides) ? config.sampler_overrides : {};
  const panelOn = isRecord(so.enabled) ? so.enabled : {};
  const panelValues = isRecord(so.values) ? so.values : {};
  const notCarried: string[] = [];
  for (const [id, on] of Object.entries(panelOn)) {
    const value = own(panelValues, id);
    if (on !== true || value === undefined || value === null || HISTORY_SWITCHES.has(id)) continue;
    const key = own(PANEL_SAMPLERS, id);
    const v = num(value);
    if (key !== undefined && v !== undefined) {
      if (json[key] !== v) changed.push(id);
      json[key] = v;
    } else notCarried.push(id);
  }
  if (notCarried.length > 0) {
    sink.add('not_honoured', 'sampler_overrides', `the chat's generation settings ${notCarried.join(', ')} have no rp-core preset field; not carried`);
  }
  const pso = isRecord(config.preset_sampler_overrides) ? config.preset_sampler_overrides : {};
  for (const [camel, key, round] of CHAT_SAMPLERS) {
    const v = pso[camel];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const value = round ? Math.round(v) : v;
    if (json[key] !== value) changed.push(camel);
    json[key] = value;
  }
  const ppp = postProcessingOf(pso.promptPostProcessing) ?? postProcessingOf(so.promptPostProcessing) ?? postProcessingOf(r.prompt_post_processing);
  if (ppp !== undefined) {
    // RoleCall reads an unset value as 'none'.
    if (ppp !== (postProcessingOf(r.prompt_post_processing) ?? 'none')) changed.push('promptPostProcessing');
    json.prompt_post_processing = ppp;
  }

  for (const [snake, camel] of SYSTEM_PROMPTS) {
    const v = authoredSystemPrompt(r.system_prompts, snake, camel);
    if (v !== undefined) json[snake] = v;
  }
  // The chat's Start Reply With wins over the preset's prefill.
  const chatPrefill = nonBlank(so.prefill);
  if (chatPrefill !== undefined && chatPrefill !== json.assistant_prefill) {
    json.assistant_prefill = chatPrefill;
    changed.push('prefill');
  }
  // RoleCall's message-count context (preset-loader: system_prompts.context_mode / max_messages > 0;
  // the chat's override: contextMode / maxMessages ≥ 0; the worker keeps the last user message and the
  // `max` messages before it) → the preset's message limit, which counts the user's message too.
  const sp = isRecord(r.system_prompts) ? r.system_prompts : {};
  const ctxMode = (v: unknown): 'tokens' | 'messages' | undefined => (v === 'tokens' || v === 'messages' ? v : undefined);
  const ctxMax = (v: unknown, min: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : undefined);
  const presetMode = ctxMode(sp.context_mode);
  const presetMax = ctxMax(sp.max_messages, 1);
  const mode = ctxMode(pso.contextMode) ?? ctxMode(pso.context_mode) ?? presetMode;
  const max = ctxMax(pso.maxMessages, 0) ?? ctxMax(pso.max_messages, 0) ?? presetMax;
  const maxMessages = mode === 'messages' && max !== undefined ? max + 1 : undefined;
  if (maxMessages !== (presetMode === 'messages' && presetMax !== undefined ? presetMax + 1 : undefined)) changed.push('contextMode');
  if (maxMessages !== undefined) {
    sink.add(
      'rc_context_messages',
      'context_mode',
      `RoleCall sent the user's message and the ${max} message(s) before it; the preset keeps at most ${maxMessages} chat message(s) (context.maxMessages)`,
    );
  }

  const tf = isRecord(r.template_formats) ? r.template_formats : {};
  for (const key of ['wi_format', 'scenario_format', 'personality_format']) if (typeof tf[key] === 'string') json[key] = tf[key];
  const behavior = isRecord(r.behavior) ? r.behavior : {};
  for (const key of BEHAVIOR_KEYS) if (behavior[key] !== undefined && behavior[key] !== null) json[key] = behavior[key];
  const api = isRecord(r.api_options) ? r.api_options : {};
  for (const key of API_OPTION_KEYS) if (api[key] !== undefined && api[key] !== null) json[key] = api[key];
  const media = isRecord(r.media_settings) ? r.media_settings : {};
  for (const [camel, key] of MEDIA_KEYS) if (media[camel] !== undefined && media[camel] !== null) json[key] = media[camel];
  const generation = isRecord(r.generation_settings) ? r.generation_settings : {};
  for (const [camel, key] of GENERATION_KEYS) if (generation[camel] !== undefined && generation[camel] !== null) json[key] = generation[camel];

  const sent = markerTexts(prompts, sendable);
  json.prompts = sent.map((x) => exportPrompt(x.row));
  json.prompt_order = [
    {
      character_id: ST_GLOBAL_ORDER_ID,
      order: sent.flatMap((x) => {
        const identifier = idOf(x.row.identifier);
        return identifier === undefined ? [] : [{ identifier, enabled: x.enabled ?? enabledOf(x.row) }];
      }),
    },
  ];
  const rawExtensions = isRecord(raw.extensions) ? raw.extensions : {};
  json.extensions = {
    ...rawExtensions,
    rolecall: {
      ...(isRecord(rawExtensions.rolecall) ? rawExtensions.rolecall : {}),
      category_hierarchy: categoryHierarchy((Array.isArray(r.categories) ? r.categories : []).filter(isRecord), sent.map((x) => x.row)),
      category_header_identifiers: [],
      prompt_regex_rules: {},
      schema_version: 1,
      edition_kind: r.edition_kind === 'standard' ? 'standard' : 'rolecall',
      source_export: 'rolecall-story-zip-v1',
    },
  };
  if (r.settings !== undefined && r.settings !== null) {
    sink.add('rc_preset_settings', 'settings', "the preset's original SillyTavern file is not read: RoleCall runs its prompt rows, which this import reads");
  }
  if (changed.length > 0) sink.add('rc_preset_overrides', 'config', `the chat's own settings are applied: ${changed.join(', ')}`);
  return { json: compact(json), overridden: changed.length > 0, warnings: sink.list(), ...(maxMessages !== undefined ? { maxMessages } : {}) };
}

/**
 * The preset row → a core preset (D-187): rcPresetExport, then stPresetToPreset (D-71's RoleCall
 * rules). Macros rp-core does not know are named in one warning. `name` names the result (the caller's
 * `<preset> (<story>)` for a copy with the chat's overrides).
 */
export function presetFromRow(row: unknown, chat?: PresetChat & { name?: string }): Imported<Preset> & { export: Rec; overridden: boolean } {
  const built = rcPresetExport(row, chat);
  const json = chat?.name !== undefined ? { ...built.json, name: chat.name } : built.json;
  const read = stPresetToPreset(json, nonBlank(json.name) ?? 'RoleCall preset');
  if (built.maxMessages !== undefined) read.value.context = { ...read.value.context, maxMessages: built.maxMessages };
  const names = new Set<string>();
  const texts = [...read.value.blocks.map((b) => b.content), read.value.prefill ?? '', read.value.impersonation?.prompt ?? '', read.value.impersonation?.prefill ?? ''];
  for (const t of texts) for (const n of unknownMacrosIn(t)) names.add(n);
  // Empty markers RoleCall's loader has nothing to send for (custom anchors of the preset): one line.
  const prompts = Array.isArray(json.prompts) ? json.prompts : [];
  const markers = read.warnings.flatMap((w) => {
    if (w.code !== 'unknown_marker') return [];
    const at = /^prompts\[(\d+)\]/.exec(w.path);
    const p = at ? prompts[Number(at[1])] : undefined;
    return [(isRecord(p) ? idOf(p.identifier) : undefined) ?? w.path];
  });
  const warnings = read.warnings.filter((w) => w.code !== 'unknown_macro' && w.code !== 'unknown_marker');
  if (names.size > 0) {
    warnings.push({
      code: 'unknown_macro',
      path: 'prompts[*].content',
      message: `macros rp-core does not run stay literal text: ${[...names].map((n) => `{{${n}}}`).join(', ')}`,
    });
  }
  if (markers.length > 0) {
    const shown = markers.slice(0, 8).map((m) => `"${m}"`).join(', ');
    warnings.push({
      code: 'unknown_marker',
      path: 'prompts[*].identifier',
      message: `${markers.length} marker prompt(s) without text have nothing to send and are kept disabled: ${shown}${markers.length > 8 ? `, and ${markers.length - 8} more` : ''}`,
    });
  }
  return { value: read.value, warnings: [...built.warnings, ...warnings], export: json, overridden: built.overridden };
}

// ---- lorebooks -----------------------------------------------------------------------------------

/** The lorebook row's fields RoleCall's Compendium export puts under `lorebook` (export route). */
const ENVELOPE_FIELDS = [
  'id',
  'name',
  'description',
  'creator_id',
  'status',
  'created_at',
  'updated_at',
  'global_case_sensitive',
  'global_match_whole_words',
  'global_scan_depth',
  'global_recursion',
  'token_budget',
  'genre',
  'fandom',
  'tags',
  'lorebook_type',
  'forked_from_id',
  'original_creator_id',
];

/** `metadata.standardization_state` of a row whose data a Compendium split moved into typed rows. */
const CONSUMED = 'consumed_by_split';

/**
 * A zip lorebook row as RoleCall's Compendium export file: the envelope, the rows in `sort_order` (the
 * export's order; the story export's rows come in database order), consumed rows disabled.
 */
export function compendiumFileOf(row: Rec): { file: Rec; consumed: number; consumedConstant: number } {
  const lorebook: Rec = {};
  for (const k of ENVELOPE_FIELDS) if (Object.hasOwn(row, k)) lorebook[k] = row[k];
  const fromName = nonBlank(row.scene_fork_source_lorebook_name);
  const fromLabel = nonBlank(row.scene_fork_source_message_label);
  lorebook.provenance = fromName && fromLabel ? { kind: 'scene_fork', sourceLorebookName: fromName, sourceMessageLabel: fromLabel } : null;
  let consumed = 0;
  let consumedConstant = 0;
  const entries = bySortOrder(Array.isArray(row.entries) ? row.entries : [], (e) => (isRecord(e) ? e.sort_order : undefined)).map((e) => {
    if (!isRecord(e) || !isRecord(e.metadata) || e.metadata.standardization_state !== CONSUMED) return e;
    if (e.enabled !== false) {
      consumed++;
      if (e.constant === true) consumedConstant++;
    }
    return { ...e, enabled: false };
  });
  return { file: { schemaVersion: COMPENDIUM_SCHEMA, format: COMPENDIUM_FORMAT, lorebook, entries }, consumed, consumedConstant };
}

/** One library book of the story. */
export interface StoryBook {
  /** The RoleCall book ids it stands for: the one read, then its identical copies. */
  rcIds: string[];
  book: LoreBook;
  /** sha256 of the book's settings and its rows (ids and extras aside, in any order; the name is not part of it). */
  hash: string;
  /** The book's own name, when another book already had it and this one was renamed. */
  renamedFrom?: string;
  /** Rows imported disabled because a standardisation split consumed them. */
  consumed: number;
  /** …of which constant (RoleCall injects a constant row of a TunnelVision-managed book). */
  consumedConstant: number;
  warnings: ImportWarning[];
}

/** An entry's behaviour, without its id and the RoleCall-only extras. */
const entryKey = (e: LoreEntry): string => {
  const { id: _id, extras: _extras, ...rest } = e;
  return stableJson(rest);
};

/**
 * A book's identity for dedupe and re-import reuse (D-187): its settings and its rows' behaviour, ids,
 * extras, row order and the name aside. The same for a library copy read back.
 */
export function bookHash(book: LoreBook): string {
  const rows = book.entries.map((e) => sha256(entryKey(e))).sort();
  return sha256(stableJson({ scanDepth: book.scanDepth, recursive: book.recursive, caseSensitive: book.caseSensitive, wholeWords: book.wholeWords, match: book.match, rows }));
}

/**
 * The story's lorebook rows → library books (D-187). Identical books (same hash) become one: the copy
 * whose rows keep the most RoleCall metadata is read, the others are listed in `rcIds`. A later book
 * whose (trimmed) name is taken by a different book is renamed `<name> (<id8>)`, so the "a world is
 * read once by name" rule does not hide it.
 */
export function booksFromRows(rows: readonly unknown[]): { books: StoryBook[]; warnings: ImportWarning[] } {
  const sink = new WarningSink();
  const read: (StoryBook & { kept: number; at: number; budget?: unknown })[] = [];
  rows.forEach((row, at) => {
    if (!isRecord(row)) {
      sink.add('invalid_value', `lorebooks[${at}]`, 'a lorebook row that is not an object; skipped');
      return;
    }
    const rcId = idOf(row.id) ?? `lorebook-${at + 1}`;
    const { file, consumed, consumedConstant } = compendiumFileOf(row);
    const res = readCompendium(file, { fallbackName: `RoleCall lorebook ${short(rcId)}` });
    if (res.refused !== undefined) {
      sink.add('rc_book_unreadable', `lorebooks[${at}]`, `lorebook ${short(rcId)} ${res.refused}`);
      return;
    }
    // A book's own token budget is said once for all books, below.
    const budget = res.warnings.find((w) => w.code === 'not_honoured' && w.path === 'lorebook.token_budget');
    const warnings = res.warnings.filter((w) => w !== budget);
    if (consumed > 0) {
      warnings.push({
        code: 'rc_book_consumed',
        path: 'entries[*].metadata.standardization_state',
        message: `${consumed} row(s) a Compendium split consumed are imported disabled: their data lives in the typed rows (RoleCall's keyword lore still read them)`,
      });
    }
    const kept = res.value.entries.filter((e) => e.extras?.metadata !== undefined || e.meta !== undefined).length;
    read.push({ rcIds: [rcId], book: res.value, hash: bookHash(res.value), consumed, consumedConstant, warnings, kept, at, budget: budget !== undefined ? row.token_budget : undefined });
  });

  const byHash = new Map<string, (typeof read)[number]>();
  const order: (typeof read)[number][] = [];
  const copies: { at: number; hash: string }[] = [];
  for (const b of read) {
    const same = byHash.get(b.hash);
    if (same === undefined) {
      byHash.set(b.hash, b);
      order.push(b);
      continue;
    }
    // Identical books: the copy with the most RoleCall metadata is read, at the first copy's place.
    const [winner, loser] = b.kept > same.kept ? [b, same] : [same, b];
    const merged = { ...winner, rcIds: [...winner.rcIds, ...loser.rcIds], at: same.at };
    byHash.set(b.hash, merged);
    order[order.indexOf(same)] = merged;
    copies.push({ at: loser.at, hash: b.hash });
  }

  const taken = new Set<string>();
  const books: StoryBook[] = order.map(({ kept: _kept, at, budget: _budget, ...b }) => {
    const name = b.book.name.trim();
    if (name === '' || !taken.has(name)) {
      taken.add(name);
      return b;
    }
    const base = `${name} (${short(b.rcIds[0]!)})`;
    let next = base;
    for (let n = 2; taken.has(next); n++) next = `${base} ${n}`;
    taken.add(next);
    sink.add('rc_book_renamed', `lorebooks[${at}]`, `another lorebook is already named "${name}"; this one is imported as "${next}"`);
    return { ...b, book: { ...b.book, name: next }, renamedFrom: b.book.name };
  });
  // One line per merged copy, the same text for every copy of a book (the report counts them).
  const nameOf = new Map(books.map((b) => [b.hash, b.book.name]));
  for (const c of copies) sink.add('rc_book_duplicate', `lorebooks[${c.at}]`, `a copy of lorebook "${nameOf.get(c.hash)}" with the same rows is imported once`);
  const budgets = order.flatMap((o, i) => (o.budget !== undefined ? [`"${books[i]!.book.name}" ${JSON.stringify(o.budget)}`] : []));
  if (budgets.length > 0) {
    sink.add('not_honoured', 'lorebooks[*].token_budget', `RoleCall capped these lorebooks at their own token budgets, which rp-core does not honour (its lorebooks share one budget): ${budgets.join(', ')}`);
  }
  return { books, warnings: sink.list() };
}
