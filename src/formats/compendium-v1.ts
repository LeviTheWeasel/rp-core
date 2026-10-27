// Ported from Bunraku:src/formats/rolecall/compendium.ts@702d8120 (the detection predicate, the
// column-by-column row reader with its fallbacks, the streamed writer's header / row / footer framing)
// and RoleCall:apps/rc/src/app/api/content/lorebooks/[id]/compendium/export/route.ts@fb8dc623e (the
// file's layout: key order, `JSON.stringify(payload, null, 2)`, counts).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RoleCall's Compendium export, `compendium-v1.0.0` (ARCHITECTURE.md §7.4.8; .notes/m5a-decisions.md
// D-162 read, D-163 write). The file is flat: raw `lorebook_entries` rows (snake_case columns, the
// whole `metadata` blob) beside `lorebook`, `tree`, `nodeConstraints`, `categories` and `counts`.
// Read: every row becomes a core LoreEntry. A typed row (`metadata.entry_type` one of the 11 types)
// gets `meta {type, data, aliases, featured}` and keeps RoleCall's rendered text in `content` (a
// blank one is rendered from data), so an 'off' book or a disabled Compendium still injects it as
// plain lore; the Compendium itself ignores it and renders from data. An arc overview gets
// `meta.arc`; any other row is ordinary lore.
// RoleCall-only columns ride extras, said when they would change what RoleCall does. Kept data
// (structured_data, extras) nested deeper than MAX_DATA_DEPTH keeps its deeper parts as JSON text,
// said once per field; keys are set as own properties, so '__proto__' stays a plain key.
// Write: a copy, streamed chunk by chunk, byte for byte RoleCall's layout; ids are UUIDs derived from
// (book name, entry key), so a re-export keeps them and RoleCall's id remap finds nothing to rewrite.
// Changes from Bunraku: no adapter registry and no raw-file escrow (rp-core stores core.lorebook/1);
// plain-string triggers are read (RoleCall reads them); regex triggers become '/re/flags' keys; the
// position enum maps to core slots, depths through fromRcDepth; rows are thin and ids derived. As in
// Bunraku, `lorebook: null` is refused (RoleCall accepts it).
// Behaviour reference (facts, not code), RoleCall apps/rc/src @fb8dc623e: lib/lorebook/compendium-parser.ts
// and app/api/content/lorebooks/compendium/import/route.ts (detection, the version warning, string
// triggers, the id remap that UUID ids avoid), lib/lorebook/matcher.ts (unflagged regex triggers).

import { createHash } from 'node:crypto';
import { identityField, isEntryType } from '../agents/compendium/entry-types.ts';
import { renderContent } from '../agents/compendium/render.ts';
import type { EntryType } from '../agents/compendium/types.ts';
import { parseRegexKey } from '../lore/keys.ts';
import { fromRcDepth } from '../prompt/depth.ts';
import { hasCompendiumTag } from './kind-markers.ts';
import type { ChatRole, CompendiumMeta, Imported, ImportWarning, LoreBook, LoreEntry, LorePosition } from './native.ts';
import { compact, isRecord, joinPath, nonBlank, optBool, optCount, optNum, uniqueIds, WarningSink, type Rec } from './wire.ts';

export const COMPENDIUM_SCHEMA = 'compendium-v1.0.0';
export const COMPENDIUM_FORMAT = 'rolecall-compendium';

/**
 * What RoleCall refuses on import: more rows than `entries` (compendium import route), a file over
 * `bytes` (its generic import). The writer's caller warns; the format does not forbid either.
 */
export const RC_LIMITS = { entries: 5000, bytes: 10 * 1024 * 1024 } as const;

/** `metadata.source` of a plot's arc overview row (RoleCall lib/lorebook/tv-writer.ts). */
const ARC_SOURCE = 'tv_arc_overview';
/** `metadata.source` of a typed row RoleCall's Remember_* tools write. */
const TYPED_SOURCE = 'tv_compendium';

/**
 * Bunraku's predicate: tagged as a Compendium export, with a `lorebook` object and a top-level
 * `entries` list. RoleCall also accepts `lorebook: null`; this does not.
 */
export function looksLikeCompendium(json: unknown): boolean {
  return hasCompendiumTag(json) && isRecord((json as Rec).lorebook) && Array.isArray((json as Rec).entries);
}

// ---- read ----------------------------------------------------------------------------------------

export interface CompendiumReadOptions {
  /** The book's name when neither `name` nor a non-blank `lorebook.name` gives one: the file stem. */
  fallbackName: string;
  /** `--as`: names the book before `lorebook.name` does (D-162). */
  name?: string;
}

/** RoleCall's structural positions → core slots (D-162). `depth`, `append` and `scene` are handled apart. */
const RC_SLOTS: Readonly<Record<string, LorePosition>> = {
  world: 'before',
  character: 'after',
  before_example: 'examples_before',
  after_example: 'examples_after',
  prepend_top: 'top',
  append_bottom: 'bottom',
};
/** The `depth` column's default in RoleCall's schema. */
const RC_DEFAULT_DEPTH = 4;
const ROLES: readonly ChatRole[] = ['system', 'user', 'assistant'];
const LOGICS: readonly NonNullable<LoreEntry['logic']>[] = ['and_any', 'and_all', 'not_any', 'not_all'];

/**
 * How deep kept data may nest (the lead's ruling after the review: render, merge and import bound
 * their recursion). RoleCall's writers never come near it; a hand-made file can nest 20 000 levels,
 * which overflows the stack of every recursive walk (render, the library's pretty printer).
 */
export const MAX_DATA_DEPTH = 32;
/** The JSON text a flattened part keeps, in UTF-16 units, before '…'. */
const FLAT_TEXT_MAX = 1000;
const TOO_DEEP = `nested deeper than ${MAX_DATA_DEPTH} levels; the deeper parts are kept as their JSON text, cut to ${FLAT_TEXT_MAX} characters`;

/** `o[key] = value` as an own data property, also for '__proto__' (assigning that one sets the prototype). */
function put(o: Rec, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
  else o[key] = value;
}

/**
 * The JSON text of `value`, cut to FLAT_TEXT_MAX with '…'. It stops as soon as the text is that long,
 * and every level it enters writes a character first, so it never recurses deeper than that.
 */
function jsonHead(value: unknown): string {
  let out = '';
  const emit = (s: string): boolean => {
    out += s;
    return out.length <= FLAT_TEXT_MAX;
  };
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) {
      if (!emit('[')) return false;
      for (const [i, x] of v.entries()) if ((i > 0 && !emit(',')) || !walk(x ?? null)) return false;
      return emit(']');
    }
    if (isRecord(v)) {
      if (!emit('{')) return false;
      let first = true;
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        if ((!first && !emit(',')) || !emit(`${JSON.stringify(k)}:`) || !walk(x)) return false;
        first = false;
      }
      return emit('}');
    }
    return emit(JSON.stringify(v) ?? 'null');
  };
  walk(value);
  if (out.length <= FLAT_TEXT_MAX) return out;
  const cut = out.slice(0, FLAT_TEXT_MAX);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/**
 * `value` (at level `depth`) with every object or list deeper than MAX_DATA_DEPTH replaced by its
 * JSON text (jsonHead); `flat.hit` says that happened. What is within the bound is kept as it is
 * (the same object); a changed object is copied key by key with `put`, so a '__proto__' key stays one.
 */
function bound(value: unknown, depth: number, flat: { hit: boolean }): unknown {
  if (!Array.isArray(value) && !isRecord(value)) return value;
  if (depth > MAX_DATA_DEPTH) {
    flat.hit = true;
    return jsonHead(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => bound(v, depth + 1, flat));
    return items.some((v, i) => v !== value[i]) ? items : value;
  }
  const fields = Object.entries(value);
  const kept = fields.map(([k, v]) => [k, bound(v, depth + 1, flat)] as const);
  if (kept.every(([, v], i) => v === fields[i]?.[1])) return value;
  const copy: Rec = {};
  for (const [k, v] of kept) put(copy, k, v);
  return copy;
}

/** bound() from level 1, calling `said` once when something was flattened. */
function boundSaid<T>(value: T, said: () => void): T {
  const flat = { hit: false };
  const out = bound(value, 1, flat) as T;
  if (flat.hit) said();
  return out;
}

/** null, undefined, blank text, an empty list or an empty object: a cell that says nothing. */
const isUnset = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0) ||
  (isRecord(v) && Object.keys(v).length === 0);

/**
 * Bookkeeping columns of RoleCall's database: dropped without a word. The file order is the book
 * order (RoleCall exports by `sort_order`), so `sort_order` goes too; `token_count` is derived.
 */
const DROPPED = new Set(['lorebook_id', 'origin', 'origin_source_id', 'created_at', 'updated_at', 'token_count', 'sort_order']);

interface RcColumn {
  /** RoleCall's default: a cell holding it is not kept. */
  default?: unknown;
  /** What RoleCall does with the column, for the warning when `active` says it would act. */
  what?: string;
  active?: (v: unknown) => boolean;
}
const isTrue = (v: unknown): boolean => v === true;
const scanning = (what: string): RcColumn => ({ default: false, what: `scanning the ${what}`, active: isTrue });

/** RoleCall-only columns: kept in extras when set, and said when RoleCall would act on them. */
const RC_ONLY: Readonly<Record<string, RcColumn>> = {
  comment: {},
  trigger_mode: { default: 'simple', what: 'advanced trigger mode (per-trigger frequency and probability)', active: (v) => v === 'advanced' },
  use_memo: { default: false },
  allow_recursion: { default: false },
  delay_until_recursion: { default: 0, what: 'delay until recursion', active: (v) => v === true || (typeof v === 'number' && v > 0) },
  character_filter: { what: 'character filter', active: (v) => isRecord(v) && Object.values(v).some((x) => !isUnset(x) && x !== false) },
  scan_character_description: scanning('character description'),
  scan_character_personality: scanning('character personality'),
  scan_user_persona: scanning('persona description'),
  scan_scenario: scanning('scenario'),
  scan_preset: scanning('preset'),
  side_effects: { what: 'side effects', active: (v) => !isUnset(v) },
  boost_ids: { what: 'boosting other entries', active: (v) => Array.isArray(v) && v.length > 0 },
  boost_amount: { default: 0 },
  probability_mode: { default: 'highest', what: 'additive probability', active: (v) => v === 'additive' },
  // Bunraku's bag for the fields RoleCall has no column for.
  unsupported_fields: {},
};

/** Every unescaped '/' of a pattern escaped, so the core key reads back as one '/re/flags' regex. */
const escapeSlashes = (s: string): string => s.replace(/\\[\s\S]|\//gu, (m) => (m === '/' ? '\\/' : m));

/**
 * A RoleCall regex trigger as a core '/re/flags' key. RoleCall's matcher runs an unflagged regex
 * case-insensitively unless the entry is case-sensitive (lib/lorebook/matcher.ts), so such a key
 * gets 'i' then.
 */
function regexKey(pattern: string, flags: unknown, caseSensitive: boolean): string {
  const own = typeof flags === 'string' ? [...new Set(flags.replace(/[^gimsuy]/gu, ''))].join('') : '';
  return `/${escapeSlashes(pattern)}/${own || (caseSensitive ? '' : 'i')}`;
}

/** Triggers as core keys: plain strings and `{keyword}` records; blanks dropped, anything else said. */
function keysOf(raw: unknown, at: [string, string], caseSensitive: boolean, sink: WarningSink): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    sink.fold('invalid_value', ...at, 'triggers are not a list; dropped');
    return [];
  }
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === 'string') {
      if (t.trim() !== '') out.push(t);
    } else if (isRecord(t) && typeof t.keyword === 'string') {
      if (t.keyword.trim() !== '') out.push(t.isRegex === true ? regexKey(t.keyword, t.flags, caseSensitive) : t.keyword);
    } else {
      sink.fold('invalid_value', ...at, 'a trigger is neither text nor a {keyword} record; dropped');
    }
  }
  return out;
}

/** `meta` minus the given keys, or undefined when nothing is left. */
function without(meta: Rec | undefined, keys: readonly string[]): Rec | undefined {
  if (!meta) return undefined;
  const rest = Object.fromEntries(Object.entries(meta).filter(([k]) => !keys.includes(k)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

interface RowCtx {
  path: string;
  star: string;
  fallbackId: string;
  sink: WarningSink;
  /** category id → name, from the file's `categories`. */
  categories: ReadonlyMap<string, string>;
  /** The book's `global_case_sensitive`, for unflagged regex triggers. */
  bookCaseSensitive: boolean;
}

/**
 * The lore text of a typed row whose RoleCall text is blank: renderContent of its data, headed by the
 * row's title when the data names nothing (as the Compendium's renderEntry does). Used only when the
 * entry is read as plain lore (an 'off' book, a disabled Compendium); the Compendium renders again.
 */
function typedText(type: EntryType, data: Rec, title: string | undefined): string {
  const named = ['name', 'title', 'topic'].some((f) => typeof data[f] === 'string' && (data[f] as string).trim() !== '');
  return renderContent(type, named || title === undefined ? data : { ...data, [identityField(type)]: title });
}

/** One raw row as a core entry (D-162). */
function entryOf(row: Rec, c: RowCtx): LoreEntry {
  const used = new Set<string>();
  const take = (col: string): unknown => {
    used.add(col);
    return row[col];
  };
  const at = (col: string): [string, string] => [joinPath(c.path, col), joinPath(c.star, col)];
  const bad = (col: string, message: string): void => c.sink.fold('invalid_value', ...at(col), message);
  // A null cell is "not set"; a value of the wrong kind is said and ignored (RoleCall's default stays).
  const read = <T>(col: string, as: (v: unknown) => T | undefined, kind: string): T | undefined => {
    const v = take(col);
    if (v === undefined || v === null) return undefined;
    const out = as(v);
    if (out === undefined) bad(col, `${col} is not ${kind}; ignored`);
    return out;
  };
  const bool = (col: string): boolean | undefined => read(col, optBool, 'true or false');
  const num = (col: string): number | undefined => read(col, optNum, 'a number');
  const count = (col: string): number | undefined => read(col, optCount, 'a whole number >= 0');
  const extras: Rec = {};

  const rawId = take('id');
  let id = nonBlank(rawId) ?? (typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : undefined);
  if (id === undefined) {
    c.sink.fold('invalid_value', ...at('id'), 'entry has no id; numbered by its position in the file');
    id = c.fallbackId;
  }
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const title = nonBlank(read('title', text, 'text'));
  const content = read('content', text, 'text') ?? '';

  const rawMeta = take('metadata');
  const metadata = isRecord(rawMeta) ? rawMeta : undefined;
  if (rawMeta !== undefined && rawMeta !== null && !metadata) bad('metadata', 'metadata is not an object; ignored');
  const rawType = metadata?.entry_type;
  const typeWord = typeof rawType === 'string' ? rawType.trim().toLowerCase() : undefined;
  const type: EntryType | undefined = isEntryType(typeWord) ? typeWord : undefined;
  if (type === undefined && typeWord) {
    c.sink.fold('unknown_type', ...at('metadata.entry_type'), 'entry_type is not one of the 11 Compendium types; imported as a plain lore entry');
  }
  const featuredColumn = take('is_featured') === true;
  const featured = featuredColumn || metadata?.featured === true;
  // An arc overview: RoleCall's source tag, or the legacy "[Arc] …" title its tree builder still reads.
  const arcTagged = type === undefined && (metadata?.source === ARC_SOURCE || (title?.startsWith('[Arc]') ?? false));
  const arc = arcTagged ? (nonBlank(metadata?.arc) ?? nonBlank(title?.replace(/^\[Arc\]/u, '')))?.trim() : undefined;
  if (arcTagged && arc === undefined) bad('title', 'arc overview without a plot name; imported as a plain lore entry');

  let meta: CompendiumMeta | undefined;
  if (type !== undefined) {
    const sd = metadata?.structured_data;
    if (sd !== undefined && sd !== null && !isRecord(sd)) bad('metadata.structured_data', 'structured_data is not an object; the entry has no fields');
    const data = isRecord(sd) ? boundSaid(sd, () => c.sink.fold('too_deep', ...at('metadata.structured_data'), TOO_DEEP)) : {};
    const aliases = Array.isArray(data.aliases) ? data.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : [];
    meta = compact({ type, data, aliases: aliases.length > 0 ? aliases : undefined, featured: featured || undefined });
    const rest = without(metadata, ['entry_type', 'structured_data', 'featured']);
    if (rest) extras.metadata = rest;
  } else {
    if (arc !== undefined) meta = { arc };
    const rest = arc !== undefined ? without(metadata, ['arc']) : metadata && !isUnset(metadata) ? metadata : undefined;
    if (rest) extras.metadata = rest;
    // Featured means something for typed entries only (one per type); elsewhere it is just kept.
    if (featuredColumn) extras.is_featured = true;
  }

  const caseSensitive = bool('case_sensitive');
  const regexCase = caseSensitive ?? c.bookCaseSensitive;
  const keys = keysOf(take('triggers'), at('triggers'), regexCase, c.sink);
  const secondaryAll = keysOf(take('secondary_triggers'), at('secondary_triggers'), regexCase, c.sink);
  const rawLogic = take('selective_logic');
  let logic: LoreEntry['logic'];
  if (secondaryAll.length > 0) {
    logic = LOGICS.find((l) => l === rawLogic);
    if (rawLogic !== undefined && rawLogic !== null && logic === undefined) bad('selective_logic', "selective_logic is not one of RoleCall's; AND ANY is used");
  }

  let enabled = bool('enabled');
  const rawPosition = take('position');
  const rawDepth = take('depth');
  const rawRole = take('role');
  let position: LorePosition = 'after'; // RoleCall's default, `character`
  if (rawPosition === 'depth') {
    const depth = optCount(rawDepth);
    if (rawDepth !== undefined && rawDepth !== null && depth === undefined) bad('depth', "depth is not a whole number >= 0; RoleCall's 4 is used");
    const role = ROLES.find((r) => r === rawRole);
    if (rawRole !== undefined && rawRole !== null && role === undefined) bad('role', 'role is not system, user or assistant; system is used');
    position = { depth: fromRcDepth(depth ?? RC_DEFAULT_DEPTH), role: role ?? 'system' };
  } else if (typeof rawPosition === 'string' && Object.hasOwn(RC_SLOTS, rawPosition)) {
    position = RC_SLOTS[rawPosition] as LorePosition;
  } else if (rawPosition === 'append') {
    // RoleCall glues an append onto the d-th last chat message; the core has no such placement (D-71).
    if (enabled !== false) c.sink.fold('rc_append', ...at('position'), 'a RoleCall append (glued onto a chat message) has no rp-core placement; imported disabled');
    enabled = false;
    Object.assign(extras, compact({ position: rawPosition, depth: rawDepth ?? undefined, role: rawRole ?? undefined }));
  } else if (rawPosition === 'scene') {
    c.sink.fold('rc_scene', ...at('position'), "RoleCall's scene position has no rp-core slot; placed before the examples, as RoleCall's own SillyTavern export does");
    position = 'examples_before';
    extras.position = rawPosition;
  } else if (rawPosition !== undefined && rawPosition !== null) {
    bad('position', "position is not one of RoleCall's; placed after the character (RoleCall's default)");
  }

  const probability = num('probability');
  const group = read('group_name', text, 'text')?.trim();
  const rawCategory = take('category_id');
  if (typeof rawCategory === 'string') {
    const name = c.categories.get(rawCategory);
    if (name !== undefined) extras.category = name;
    else bad('category_id', 'category_id names no category of the file; dropped');
  }

  const entry: LoreEntry = compact({
    id,
    title,
    content: type !== undefined && content.trim() === '' ? typedText(type, meta?.data ?? {}, title) : content,
    enabled,
    constant: bool('constant'),
    keys,
    secondary: secondaryAll.length > 0 ? secondaryAll : undefined,
    logic,
    position,
    order: num('priority'),
    probability: probability === undefined ? undefined : Math.min(100, Math.max(0, probability)),
    groups: group ? [group] : undefined,
    groupWeight: num('group_weight'),
    scanDepth: count('scan_depth'),
    caseSensitive,
    wholeWords: bool('match_whole_words'),
    preventRecursion: bool('prevent_recursion'),
    excludeRecursion: bool('exclude_recursion'),
    ignoreBudget: bool('ignore_budget'),
    sticky: count('sticky'),
    cooldown: count('cooldown'),
    delay: count('delay'),
    meta,
  } satisfies LoreEntry);

  for (const [col, v] of Object.entries(row)) {
    if (used.has(col) || DROPPED.has(col) || isUnset(v)) continue;
    const rule = Object.hasOwn(RC_ONLY, col) ? RC_ONLY[col] : undefined;
    if (rule) {
      if (v === rule.default) continue;
      put(extras, col, v);
      if (rule.what !== undefined && rule.active?.(v)) c.sink.fold('not_honoured', ...at(col), `${rule.what} is not honoured; kept in extras`);
      continue;
    }
    put(extras, col, v);
    c.sink.fold('unknown_field', ...at(col), `unknown column "${col}" kept in extras`);
  }
  // Every extras key that can nest is named after its column (metadata, position, depth, role, others).
  for (const [k, v] of Object.entries(extras)) put(extras, k, boundSaid(v, () => c.sink.fold('too_deep', ...at(k), TOO_DEEP)));
  if (Object.keys(extras).length > 0) entry.extras = extras;
  return entry;
}

/** Book fields that map to LoreBook fields (RoleCall applies them to every entry of the book). */
const BOOK_MAPPED = new Set(['name', 'global_case_sensitive', 'global_match_whole_words', 'global_scan_depth', 'global_recursion']);
/** Ids of the source account and deployment (creator, fork lineage), RoleCall's row state: dropped. */
const BOOK_DROPPED = new Set(['id', 'creator_id', 'forked_from_id', 'original_creator_id', 'status', 'created_at', 'updated_at']);
/** Book fields kept in extras without a word, unless they hold RoleCall's default (a budget of 0 is none). */
const BOOK_KEPT: Readonly<Record<string, unknown>> = {
  description: undefined,
  genre: undefined,
  fandom: undefined,
  tags: undefined,
  lorebook_type: undefined,
  token_budget: 0,
  provenance: undefined,
  unsupported_fields: undefined,
};
/** The file's own keys. `exportDate` and `counts` are derived; the tree is said once. */
const FILE_KEYS = new Set(['schemaVersion', 'format', 'exportDate', 'lorebook', 'entries', 'tree', 'nodeConstraints', 'categories', 'counts']);

/** readCompendium's result: `refused` says why nothing could be read (the importer refuses the file). */
export interface CompendiumRead extends Imported<LoreBook> {
  refused?: string;
}

/**
 * A RoleCall Compendium export → core.lorebook/1 (D-162), with warnings for what is not honoured.
 * Never throws: a file that is not a Compendium export reads as an empty book with a warning; data
 * nested deeper than MAX_DATA_DEPTH is flattened with a warning; anything that still fails to read
 * gives an empty book, an 'unreadable' warning and `refused` with the reason.
 */
export function readCompendium(json: unknown, opts: CompendiumReadOptions): CompendiumRead {
  const sink = new WarningSink();
  try {
    return readBook(json, opts, sink);
  } catch (e) {
    const why = e instanceof RangeError ? 'it is nested too deeply or too large' : e instanceof Error ? e.message : String(e);
    const refused = `could not be read as a RoleCall Compendium export: ${why}`;
    sink.add('unreadable', '$', `${refused}; nothing imported`);
    return { value: { name: nonBlank(opts.name) ?? opts.fallbackName, match: 'literal', entries: [] }, warnings: sink.list(), refused };
  }
}

function readBook(json: unknown, opts: CompendiumReadOptions, sink: WarningSink): Imported<LoreBook> {
  const asName = nonBlank(opts.name);
  if (!looksLikeCompendium(json)) {
    sink.add('invalid_value', '$', 'not a RoleCall Compendium export (no lorebook object or entries list); imported as an empty book');
    return { value: { name: asName ?? opts.fallbackName, match: 'literal', entries: [] }, warnings: sink.list() };
  }
  const file = json as Rec;
  const book = file.lorebook as Rec;
  const version = file.schemaVersion;
  if (version !== COMPENDIUM_SCHEMA) {
    sink.add(
      'unknown_version',
      'schemaVersion',
      typeof version === 'string' ? `schema version "${version}" is not ${COMPENDIUM_SCHEMA}; read as ${COMPENDIUM_SCHEMA}` : `no schemaVersion; read as ${COMPENDIUM_SCHEMA}`,
    );
  }
  if (!isUnset(file.tree) || !isUnset(file.nodeConstraints)) {
    sink.add('not_honoured', isUnset(file.tree) ? 'nodeConstraints' : 'tree', "RoleCall's stored tree and node constraints are dropped: rp-core derives the tree from the entries");
  }

  const categories = new Map<string, string>();
  for (const cat of Array.isArray(file.categories) ? file.categories : []) {
    const name = isRecord(cat) ? nonBlank(cat.name) : undefined;
    if (isRecord(cat) && typeof cat.id === 'string' && name !== undefined && !categories.has(cat.id)) categories.set(cat.id, name);
  }

  const read = <T>(key: string, as: (v: unknown) => T | undefined, kind: string): T | undefined => {
    const v = book[key];
    if (v === undefined || v === null) return undefined;
    const out = as(v);
    if (out === undefined) sink.add('invalid_value', joinPath('lorebook', key), `${key} is not ${kind}; ignored`);
    return out;
  };
  const caseSensitive = read('global_case_sensitive', optBool, 'true or false');

  const rows: { entry: LoreEntry; at: number }[] = [];
  (file.entries as unknown[]).forEach((row, i) => {
    const path = joinPath('entries', i);
    if (!isRecord(row)) {
      sink.fold('invalid_value', path, 'entries[*]', 'entry is not an object; skipped');
      return;
    }
    const c: RowCtx = { path, star: 'entries[*]', fallbackId: String(i), sink, categories, bookCaseSensitive: caseSensitive === true };
    rows.push({ entry: entryOf(row, c), at: i });
  });
  const entries = uniqueIds(rows.map((r) => r.entry));
  entries.forEach((e, i) => {
    const was = rows[i] as { entry: LoreEntry; at: number };
    if (e.id !== was.entry.id) sink.fold('duplicate_id', joinPath(joinPath('entries', was.at), 'id'), 'entries[*].id', 'entry id already used in the file; a -2, -3… suffix added');
  });

  const extras: Rec = {};
  for (const [k, v] of Object.entries(book)) {
    if (BOOK_MAPPED.has(k) || BOOK_DROPPED.has(k) || isUnset(v)) continue;
    const kept = Object.hasOwn(BOOK_KEPT, k);
    if (kept && v === BOOK_KEPT[k]) continue;
    const path = joinPath('lorebook', k);
    if (!kept) sink.add('unknown_field', path, `unknown lorebook field "${k}" kept in extras`);
    put(extras, k, boundSaid(v, () => sink.add('too_deep', path, TOO_DEEP)));
  }
  const envelope: Rec = {};
  for (const [k, v] of Object.entries(file)) {
    if (FILE_KEYS.has(k) || isUnset(v)) continue;
    sink.add('unknown_field', k, `unknown field "${k}" kept in extras.envelope`);
    put(envelope, k, boundSaid(v, () => sink.add('too_deep', k, TOO_DEEP)));
  }
  if (Object.keys(envelope).length > 0) extras.envelope = envelope;

  const value: LoreBook = compact({
    name: asName ?? nonBlank(book.name) ?? opts.fallbackName,
    scanDepth: read('global_scan_depth', optCount, 'a whole number >= 0'),
    recursive: read('global_recursion', optBool, 'true or false'),
    caseSensitive,
    wholeWords: read('global_match_whole_words', optBool, 'true or false'),
    match: 'literal' as const,
    entries,
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  } satisfies LoreBook);
  return { value, warnings: sink.list() };
}

// ---- write ---------------------------------------------------------------------------------------

/** One entry to write (D-163; the caller maps a CEntry to it). */
export interface CompendiumRowInput {
  /** The entry's stable key: with the book name, it derives the row's UUID. */
  key: string;
  /** The row title as RoleCall shows it: the name; a summary's title; `[Arc] <plot>` for an arc. */
  title: string;
  /** RoleCall reads it as the entry text: renderContent, a note's text, an arc's overview. */
  content: string;
  enabled: boolean;
  constant: boolean;
  /** Triggers: plain keys, or '/re/flags' regex keys. Blank keys are dropped. */
  keys: string[];
  /** A typed entry; `data` is written as `structured_data` as given (aliases belong in `data.aliases`). */
  type?: EntryType;
  data?: Rec;
  /** RoleCall keeps one featured entry per type: only the first featured row of a type is written so. */
  featured?: boolean;
  /** An arc overview's plot name (an untyped row). */
  arc?: string;
  /** Why the entry is disabled (a retired entry's reason). */
  disableReason?: string;
  /** A typed row's `metadata.turnNumber`. */
  turnNumber?: number;
}

/** A UUID-shaped id (version 5 layout) from SHA-1 of the parts: the same parts always give the same id. */
export function deterministicUuid(...parts: string[]): string {
  const h = createHash('sha1').update(JSON.stringify(parts)).digest('hex');
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A core key as a RoleCall trigger. */
function triggerOf(key: string): Rec {
  const re = parseRegexKey(key.trim());
  if (!re) return { keyword: key, isRegex: false };
  return re.flags !== '' ? { keyword: re.source, isRegex: true, flags: re.flags } : { keyword: re.source, isRegex: true };
}

/** The `metadata` blob of one row: typed, arc overview or classic. */
function metadataOf(r: CompendiumRowInput): Rec {
  const m: Rec =
    r.type !== undefined
      ? { source: TYPED_SOURCE, entry_type: r.type, structured_data: r.data ?? {} }
      : r.arc !== undefined
        ? { source: ARC_SOURCE, arc: r.arc }
        : {};
  if (r.type !== undefined && r.turnNumber !== undefined) m.turnNumber = r.turnNumber;
  if (r.disableReason !== undefined) m.disableReason = r.disableReason;
  return m;
}

/** RoleCall's name limit (its importer cuts there). */
const NAME_MAX = 200;

/**
 * The file, streamed: the header, one chunk per row, the footer. Joined, the chunks are exactly
 * `JSON.stringify(payload, null, 2)` of RoleCall's export (no trailing newline), with thin rows (the
 * columns that carry the entry; RoleCall's importer fills the rest with its defaults), `tree: null`,
 * no node constraints and no categories. `exportDate` comes from the caller: the codec reads no clock.
 */
export function* compendiumChunks(head: { name: string; exportDate: string }, rows: readonly CompendiumRowInput[]): Iterable<string> {
  const bookId = deterministicUuid(head.name);
  const lorebook = { id: bookId, name: Array.from(head.name).slice(0, NAME_MAX).join(''), description: null, tags: [], lorebook_type: 'compendium' };
  const top = JSON.stringify({ schemaVersion: COMPENDIUM_SCHEMA, format: COMPENDIUM_FORMAT, exportDate: head.exportDate, lorebook }, null, 2);
  yield `${top.slice(0, -2)},\n  "entries": [`;
  const featuredTypes = new Set<EntryType>();
  let typed = 0;
  for (const [i, r] of rows.entries()) {
    let featured = false;
    if (r.type !== undefined) {
      typed++;
      if (r.featured === true && !featuredTypes.has(r.type)) {
        featuredTypes.add(r.type);
        featured = true;
      }
    }
    const row = {
      id: deterministicUuid(head.name, r.key),
      lorebook_id: bookId,
      title: r.title,
      content: r.content,
      enabled: r.enabled,
      constant: r.constant,
      trigger_mode: 'simple',
      triggers: r.keys.filter((k) => k.trim() !== '').map(triggerOf),
      secondary_triggers: [],
      selective_logic: 'and_any',
      position: 'character',
      depth: RC_DEFAULT_DEPTH,
      role: 'system',
      sort_order: i,
      priority: 100,
      probability: 100,
      category_id: null,
      metadata: metadataOf(r),
      is_featured: featured,
    };
    yield `${i === 0 ? '' : ','}\n    ${JSON.stringify(row, null, 2).replace(/\n/gu, '\n    ')}`;
  }
  const counts = { totalEntries: rows.length, typedEntries: typed, classicEntries: rows.length - typed };
  const tail = JSON.stringify({ tree: null, nodeConstraints: [], categories: [], counts }, null, 2);
  yield `${rows.length > 0 ? '\n  ' : ''}],${tail.slice(1)}`;
}

/**
 * What the writer changes or RoleCall would refuse, for the caller to show: a second featured entry
 * of a type (written unfeatured), more rows than RoleCall imports. The file size (RC_LIMITS.bytes)
 * is the caller's to check while it streams.
 */
export function compendiumWarnings(rows: readonly CompendiumRowInput[]): ImportWarning[] {
  const out: ImportWarning[] = [];
  const first = new Map<EntryType, string>();
  rows.forEach((r, i) => {
    if (r.type === undefined || r.featured !== true) return;
    const was = first.get(r.type);
    if (was === undefined) first.set(r.type, r.title);
    else {
      out.push({
        code: 'featured_dropped',
        path: joinPath(joinPath('entries', i), 'is_featured'),
        message: `"${r.title}" is written unfeatured: RoleCall keeps one featured ${r.type} per book, and "${was}" is it`,
      });
    }
  });
  if (rows.length > RC_LIMITS.entries) {
    out.push({ code: 'too_many_entries', path: 'entries', message: `${rows.length} entries: RoleCall imports at most ${RC_LIMITS.entries} per file` });
  }
  return out;
}
