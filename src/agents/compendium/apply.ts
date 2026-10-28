// normalizeName ported from Bunraku:src/core/compendium/relationships.ts@702d8120 (line 39);
// entryNames and findMatch from Bunraku:src/core/compendium/snapshot.ts@702d8120 (the identity match);
// the `file` rules from Bunraku:src/core/compendium/filing-stage.ts@702d8120 (items applied in order
// on the working state, classic names refused, required fields for a new entry).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Compendium fold over `mem` rows (ARCHITECTURE.md §5.8; .notes/m5a-decisions.md D-141…D-150).
// Pure. Pipeline (D-143):
//   rowsOnPath = rows with `on` null or on the path
//   fresh      = rowsOnPath without stale agent rows (an edit or hide newer than the row in its range)
//   effective  = human rows + per task key the newest action (a row with that key, or a revert of it)
//   fold(library seed, effective in story order (M5b D-184, K: by (anchor, kind, seq)), applyOp)
// Ops: note (M3), file (D-144), arc (D-145), edit (D-146), retire / restore (any entry), revert (consumed
// by the filter). Ops address entries by key; a hand-written ref may also be C<n> or a name. A `file` op
// is matched by name unless it is pinned (`target`, D-168: a verb's row keeps the key it was written for;
// a pinned `lib:` entry must still answer to one of the op's names, ruling I).
// M5b (.notes/m5b-decisions.md D-179): a human row's edit / retire / restore addressed by a key that no
// entry has yet waits for it and applies right after the op that creates that key (held ops in seq
// order), so a refile or a re-write after staleness, which re-creates an agent entry at a later seq,
// keeps the person's changes; one that never meets its entry is `not_found` as before. D-184: rows
// apply in story order (an agent row where its answer is on the path, a human row after the messages
// older than it; at one place the passes first), so such a re-write never applies after the rows of
// later answers. K (the lead's rulings after the final check): rowOrder / foldStaged export that order
// (the lane stages against exactly the rows before its pass); handles C<n> count session entries by
// the row and op that created them; a trial fold keeps no checkpoint; an arc follows its renamed plot.
// normalizeName: Bunraku's rule with the D-46 word class (\p{M} kept) plus NFKC and ё→е (D-95).
// Changes from Bunraku's findMatch: the candidates are the fold's live entries of the type, session
// entries before library ones; untyped names are the readable books' (LibrarySeed.classic), never notes.

import { createHash } from 'node:crypto';
import type { MemEntry } from '../../session/entries.ts';
import { deriveTagline, IDENTITY_KEEP, identityField, isBlank, isEntryType, REQUIRED_FIELDS } from './entry-types.ts';
import { mergeData } from './merge.ts';
import {
  EMPTY_SEED,
  ENTRY_TYPES,
  type CEntry,
  type CompendiumView,
  type EntryType,
  type FoldIssue,
  type LibrarySeed,
  type OpEffect,
  type Rec,
  type TaskState,
} from './types.ts';

const NOT_NAME_CHAR = /[^\p{L}\p{N}\p{M}\s]/gu;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * A name as the fold compares it: NFKC, lower case (locale-free), ё→е, every character that is not
 * a letter, digit, combining mark or whitespace becomes a space, runs of whitespace collapse to one
 * space, trimmed. '' for a name with no letters or digits.
 */
export function normalizeName(name: string): string {
  const out = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(NOT_NAME_CHAR, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Bunraku's class has no \p{M}; with it a lone combining mark would survive as a "name".
  return HAS_LETTER_OR_DIGIT.test(out) ? out : '';
}

/** Texts a memo keeps (the oldest goes first): the fold meets the same names and texts on every refold. */
const MEMO_MAX = 16_384;

function remember(memo: Map<string, string>, text: string, compute: () => string): string {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const out = compute();
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(text, out);
  return out;
}

const NAME_MEMO = new Map<string, string>();
/** normalizeName, remembered. */
const norm = (name: string): string => remember(NAME_MEMO, name, () => normalizeName(name));

const TAGLINE_MEMO = new Map<string, string>();
/** deriveTagline, remembered by the text it is cut from (an explicit tagline is read as is). */
function taglineOf(type: EntryType, data: Rec): string {
  const source = type === 'summary' ? data.summary : data.description;
  if ((typeof data.tagline === 'string' && data.tagline.trim() !== '') || typeof source !== 'string') return deriveTagline(type, data);
  return remember(TAGLINE_MEMO, source, () => deriveTagline(type, data));
}

export interface FoldOptions {
  /** Messages on the path the view is folded for: a row with `on` set applies only when `on` is in it. */
  pathSet: ReadonlySet<string>;
  /** The path's ids, root → leaf: agent rows' ranges are checked for staleness against it (D-143). Absent: no staleness. */
  path?: readonly string[];
  /** TreeIndex.touched: per message, the seq of its newest edit or hide. */
  touched?: ReadonlyMap<string, number>;
  /** The readable books' Compendium entries, folded in first (D-141). */
  library?: LibrarySeed;
  /**
   * TreeIndex.msgs: the path's messages' seqs, which place a human row in the story (D-184). Absent: a
   * human row is placed after the newest path message a row before it is bound to (what the rows tell).
   */
  msgs?: ReadonlyMap<string, { readonly seq: number }>;
  /**
   * K (order#1): apply only the effective rows whose order (rowOrder) sorts strictly before this point —
   * a prefix of the fold's order. The lane stages a pass against exactly that (foldStaged).
   */
  before?: RowOrder;
  /** Leave out the rows whose task key is this one (a pass stages without its key's own rows). */
  without?: string;
  /** K (order#4): a fold no later fold resumes from (a verb's dry run, whose row is never written) keeps no checkpoint. */
  trial?: boolean;
}

/**
 * A row's place in the fold's order (D-184, K): rows apply by (anchor, kind, seq). `anchor` is a path
 * position (1-based, D-58; 0 = before every message), `kind` 0 for an agent row (a task key), 1 for a
 * human row, so at one anchor the passes and re-writes of that answer apply before the person's rows.
 */
export interface RowOrder {
  anchor: number;
  kind: 0 | 1;
  seq: number;
}

/** (anchor, kind, seq), ascending. */
export function compareRowOrder(a: RowOrder, b: RowOrder): number {
  return a.anchor - b.anchor || a.kind - b.kind || a.seq - b.seq;
}

/** The prefix of a note's key (§5.8 "Ключи записей"). */
export const NOTE_KEY_PREFIX = 'note:';
/** D-144.6: an entry whose data reaches this many JSON chars is flagged `large_entry`. */
export const LARGE_ENTRY_CHARS = 12_000;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

/** Sets an own property, also for the key '__proto__'. */
function put(o: Rec, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
  else o[key] = value;
}

/** A note's fields that live outside `data` (set renames or rewrites them; they cannot be unset). */
const NOTE_FIELDS: ReadonlySet<string> = new Set(['title', 'content']);
/** An arc's fields that live outside `data`: the overview can be set, never unset; the plot is the key. */
const ARC_FIELDS: ReadonlySet<string> = new Set(['content', 'overview', 'title', 'name']);

/** A string that is an entry key (a hand-written C<n> or name is resolved; a key is looked up only). */
const KEY_SHAPED = new RegExp(`^(?:note|arc|lib|${ENTRY_TYPES.join('|')}):`);
/** A handle: C<n>, c<n>, or the Cyrillic С/с a Russian keyboard types. */
const HANDLE = /^[CcСс](\d+)$/u;

/** The number of a handle ('C12' → 12), else null. */
export function handleNumber(ref: string): number | null {
  const m = HANDLE.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Every name an entry answers to, normalized, blanks dropped, deduplicated: its name, data.title,
 * data.topic, its aliases and its former names (D-144).
 */
export function entryNames(e: CEntry): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (!isStr(v)) return;
    const n = norm(v);
    if (n !== '' && !out.includes(n)) out.push(n);
  };
  add(e.name);
  add(e.data.title);
  add(e.data.topic);
  for (const a of e.aliases) add(a);
  for (const f of e.prov.formerNames ?? []) add(f);
  return out;
}

/**
 * The live entry of `type` that one of `names` (any form; normalized here) names: the first session
 * entry in creation order, else the first library entry in seed order; null when none (D-144.3).
 */
export function findMatch(entries: Iterable<CEntry>, type: EntryType, names: string[]): CEntry | null {
  const wanted = new Set(names.filter(isStr).map(norm).filter((n) => n !== ''));
  if (wanted.size === 0) return null;
  let library: CEntry | null = null;
  for (const e of entries) {
    if (e.retired !== undefined || e.type !== type) continue;
    if (!entryNames(e).some((n) => wanted.has(n))) continue;
    if (e.origin.kind === 'session') return e;
    library ??= e;
  }
  return library;
}

/**
 * K (arcs follow renamed plots): the live session arc an `arc` op naming `plot` rewrites, as the fold
 * finds it among a view's entries (Map order = creation order): the live plot that name means (findMatch:
 * its names, aliases, former names), then the session arc whose plot is that plot's name, else the first
 * whose plot is any of its names. undefined when the op would make a new arc.
 */
export function plotArc(entries: Iterable<CEntry>, plot: string): CEntry | undefined {
  const list = [...entries];
  const found = findMatch(list, 'plot', [plot]);
  const names = found === null ? [norm(plot)] : entryNames(found);
  const current = found === null ? norm(plot) : norm(found.name);
  let first: CEntry | undefined;
  for (const e of list) {
    if (e.arc === undefined || e.origin.kind !== 'session' || e.retired !== undefined) continue;
    const n = norm(e.arc);
    if (n !== '' && n === current) return e;
    if (first === undefined && names.includes(n)) first = e;
  }
  return first;
}

/**
 * What a ref names among `entries` (D-150): a handle C<n> (Map order, from 1), an exact key, or a
 * normalized name/alias/former name that exactly one entry answers to — the `prefer`red pool (live or
 * retired) first, then the other. null when nothing or several match.
 */
export function resolveRefIn(
  entries: ReadonlyMap<string, CEntry>,
  ref: string,
  prefer: 'live' | 'retired' = 'live',
  namesOf: (e: CEntry) => readonly string[] = entryNames,
): CEntry | null {
  const typed = ref.trim();
  const n = handleNumber(typed);
  if (n !== null) {
    if (n < 1) return null;
    let i = 0;
    for (const e of entries.values()) if (++i === n) return e;
    return null;
  }
  const byKey = entries.get(typed);
  if (byKey) return byKey;
  const name = norm(typed);
  if (name === '') return null;
  const same: CEntry[] = [];
  for (const e of entries.values()) if (namesOf(e).includes(name)) same.push(e);
  const wanted = same.filter((e) => (e.retired !== undefined) === (prefer === 'retired'));
  const pool = wanted.length > 0 ? wanted : same;
  return pool.length === 1 ? pool[0]! : null;
}

// ---- the fold's state -----------------------------------------------------------------------------

/** Per seed (cached): each entry's names, the name index, the seed order and each entry's data JSON length. */
interface SeedNames {
  names: ReadonlyMap<string, readonly string[]>;
  index: ReadonlyMap<string, readonly string[]>;
  ordinal: ReadonlyMap<string, number>;
  size: ReadonlyMap<string, number>;
}
const SEED_NAMES = new WeakMap<LibrarySeed, SeedNames>();

function seedNames(seed: LibrarySeed): SeedNames {
  const hit = SEED_NAMES.get(seed);
  if (hit) return hit;
  const names = new Map<string, readonly string[]>();
  const index = new Map<string, string[]>();
  const ordinal = new Map<string, number>();
  const size = new Map<string, number>();
  for (const e of seed.entries) {
    if (ordinal.has(e.key)) continue;
    ordinal.set(e.key, ordinal.size);
    size.set(e.key, JSON.stringify(e.data).length);
    const list = entryNames(e);
    names.set(e.key, list);
    for (const n of list) {
      const keys = index.get(n);
      if (keys) keys.push(e.key);
      else index.set(n, [e.key]);
    }
  }
  const out: SeedNames = { names, index, ordinal, size };
  SEED_NAMES.set(seed, out);
  return out;
}

/** The fold's working state. Entries are copies made for this fold, so ops mutate them in place. */
interface FoldState {
  entries: Map<string, CEntry>;
  /** Per base key, the last '#n' suffix handed out (keys are never removed, so the next is free). */
  suffix: Map<string, number>;
  issues: FoldIssue[];
  effects: OpEffect[];
  seed: LibrarySeed;
  seedNames: SeedNames;
  /** Current names of the entries created or renamed in this fold (the seed's are in seedNames). */
  names: Map<string, readonly string[]>;
  /** Name → keys that had it in this fold (add-only; candidates are checked against current names). */
  index: Map<string, string[]>;
  /** K (order#3): per session entry, the (row seq, op index) of the op that created it, as one number (bornAt). */
  born: Map<string, number>;
  /** Keys whose data an op changed, with the last such op (large_entry). */
  changed: Map<string, { seq: number; op: number }>;
  /** Per changed key, an upper bound of its data's JSON length: only entries that may be large are measured. */
  bound: Map<string, number>;
  /** JSON lengths of the current row's ops. */
  sizes: readonly number[];
  /** D-179: human ops waiting for the key they address, per key, in seq order. */
  held: Map<string, Held[]>;
  /** Keys created by the current op that have held ops (released after it). */
  met: string[];
}

/** D-179: one held op and what applying it later needs (its row, its index, its row's op sizes). */
interface Held {
  row: MemEntry;
  ops: readonly unknown[];
  i: number;
  op: Rec;
  sizes: readonly number[];
}

/** The first free key from `base` and its suffix number: `base`, else `base#2`, `base#3`… (taken by any entry, retired included). */
function freeKey(st: FoldState, base: string): { key: string; n: number } {
  let n = st.suffix.get(base) ?? 0;
  let key: string;
  do {
    n++;
    key = n === 1 ? base : `${base}#${n}`;
  } while (st.entries.has(key));
  return { key, n };
}

/** The key for a new entry (freeKey), taken. */
function allocKey(st: FoldState, base: string): string {
  const { key, n } = freeKey(st, base);
  st.suffix.set(base, n);
  return key;
}

const namesOf = (st: FoldState, e: CEntry): readonly string[] => st.names.get(e.key) ?? st.seedNames.names.get(e.key) ?? entryNames(e);

/** Recomputes an entry's names and indexes the new ones. */
function reindex(st: FoldState, e: CEntry): void {
  const before = namesOf(st, e);
  const now = entryNames(e);
  st.names.set(e.key, now);
  for (const n of now) {
    if (before.includes(n)) continue; // already indexed (here or in the seed's index)
    const keys = st.index.get(n);
    if (keys) keys.push(e.key);
    else st.index.set(n, [e.key]);
  }
}

/** Ops per row a creation stamp tells apart (a row with more shares the last stamp; stable order keeps them). */
const OPS_PER_ROW = 2 ** 20;
/** K (order#3): a session entry's creation stamp, (row seq, op index) as one number. */
const bornAt = (row: MemEntry, op: number): number => row.seq * OPS_PER_ROW + Math.min(op, OPS_PER_ROW - 1);

/** A new session entry, created by op `op` of `row`. */
function insert(st: FoldState, e: CEntry, row: MemEntry, op: number): void {
  st.entries.set(e.key, e);
  st.born.set(e.key, bornAt(row, op));
  st.names.set(e.key, []);
  reindex(st, e);
  if (st.held.has(e.key)) st.met.push(e.key);
}

/**
 * K (order#3, amends D-150): the entries in handle order — the library seed first (seed order), then
 * session entries by the row seq and op index that created them, not by the order the fold met them
 * (D-184's story order applies a lagging pass before rows written earlier). `st.entries` itself when
 * it is in that order already.
 */
function inBornOrder(st: FoldState): Map<string, CEntry> {
  let prev = -1;
  let sorted = true;
  for (const key of st.entries.keys()) {
    const b = st.born.get(key) ?? -1;
    if (b < prev) {
      sorted = false;
      break;
    }
    prev = b;
  }
  if (sorted) return st.entries;
  // Stable: the seed's entries (no stamp) keep seed order, one op's entries the order it made them.
  return new Map([...st.entries].sort((a, b) => (st.born.get(a[0]) ?? -1) - (st.born.get(b[0]) ?? -1)));
}

/** findMatch over the fold's index: the same answer as findMatch(st.entries.values(), …) on the folded view. */
function findIn(st: FoldState, type: EntryType, wanted: ReadonlySet<string>): CEntry | null {
  // Session entries in creation order first (K: by creation stamp), then library entries in seed order.
  let session: CEntry | null = null;
  let sessionRank = Infinity;
  let library: CEntry | null = null;
  let libraryRank = Infinity;
  const consider = (key: string): void => {
    const e = st.entries.get(key);
    if (e === undefined || e.retired !== undefined || e.type !== type) return;
    if (!namesOf(st, e).some((n) => wanted.has(n))) return;
    if (e.origin.kind === 'session') {
      const rank = st.born.get(key) ?? 0;
      if (rank < sessionRank) {
        session = e;
        sessionRank = rank;
      }
    } else {
      const rank = st.seedNames.ordinal.get(key) ?? 0;
      if (rank < libraryRank) {
        library = e;
        libraryRank = rank;
      }
    }
  };
  for (const n of wanted) {
    for (const k of st.seedNames.index.get(n) ?? []) consider(k);
    for (const k of st.index.get(n) ?? []) consider(k);
  }
  return session ?? library;
}

/** Aliases as stored: trimmed strings, deduplicated by normalized name, none equal to the name. */
function aliasList(candidates: readonly string[], name: string): string[] {
  const seen = new Set([norm(name)]);
  const out: string[] = [];
  for (const a of candidates) {
    const n = norm(a);
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    out.push(a.trim());
  }
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The inputs of entryNames, to tell whether an op changed them. */
const nameInputs = (e: CEntry): unknown[] => [e.name, e.aliases, e.data.title, e.data.topic, e.prov.formerNames];
const sameInputs = (a: unknown[], b: unknown[]): boolean => a.every((v, i) => v === b[i]);

function validRange(r: unknown): [string, string] | null {
  return Array.isArray(r) && r.length === 2 && isStr(r[0]) && isStr(r[1]) ? [r[0], r[1]] : null;
}

// ---- ops ------------------------------------------------------------------------------------------

/** Why an op was skipped (and the entry it concerns); null when it applied. */
type Skip = { why: string; key?: string } | null;
const skip = (why: string, key?: string): Skip => (key === undefined ? { why } : { why, key });

/** One applied op's effect and its bookkeeping. */
function touch(st: FoldState, row: MemEntry, op: number, e: CEntry, change: OpEffect['change'], dataChanged: boolean): void {
  st.effects.push({ seq: row.seq, op, key: e.key, change });
  if (!dataChanged) return;
  st.changed.set(e.key, { seq: row.seq, op });
  // A merge or an edit adds at most its op's JSON to the data's (plus a little punctuation).
  st.bound.set(e.key, (st.bound.get(e.key) ?? st.seedNames.size.get(e.key) ?? 0) + (st.sizes[op] ?? 0) + 64);
}

/** A library entry an op changed becomes an overlay (D-144.3, D-146). */
function overlay(e: CEntry): void {
  if (e.origin.kind === 'library' && !e.origin.overlay) e.origin = { ...e.origin, overlay: true };
}

/** A note entry (§5.8 CEntry for a human note): no type, no aliases, its text in `content`. */
function newNote(key: string, title: string, keys: string[], content: string, row: MemEntry): CEntry {
  return {
    key,
    type: null,
    name: title,
    aliases: [],
    tagline: '',
    data: {},
    keys: [...keys],
    content,
    origin: { kind: 'session' },
    prov: { created: row.on, lastSeq: row.seq, appended: {}, createdSeq: row.seq },
  };
}

/** A new typed session entry from a file op's data (the caller checked type, identity and required fields). */
function createTyped(st: FoldState, row: MemEntry, op: number, type: EntryType, key: string, name: string, data: Rec, range?: [string, string]): CEntry {
  const m = mergeData({}, data, { keep: [], on: row.on, appended: {} });
  const e: CEntry = {
    key,
    type,
    name,
    aliases: aliasList(strings(data.aliases), name),
    tagline: taglineOf(type, m.data),
    data: m.data,
    keys: [],
    origin: { kind: 'session' },
    prov: { created: row.on, lastSeq: row.seq, appended: m.appended, createdSeq: row.seq },
  };
  if (range) e.range = range;
  insert(st, e, row, op);
  touch(st, row, op, e, 'created', true);
  return e;
}

/**
 * D-144.2: a summary never merges. A row with a range keys it by the range's end and its index among
 * the row's summaries; a row without one (filed by hand) by its title, `summary:user:<normalizeName(title)>`
 * (D-168: never by seq, which a fork renumbers). `#2`… when taken.
 */
function fileSummary(st: FoldState, row: MemEntry, ops: readonly unknown[], op: number, data: Rec): Skip {
  if (isBlank(data.title) || isBlank(data.summary)) return skip('missing_required');
  if (!isStr(data.title) || norm(data.title) === '') return skip('invalid');
  const range = validRange(row.range);
  let base: string;
  if (range) {
    let i = 0;
    for (let j = 0; j < op; j++) {
      const o = ops[j];
      if (isRec(o) && o.op === 'file' && o.type === 'summary') i++;
    }
    base = `summary:${range[1]}.${i}`;
  } else base = `summary:user:${norm(data.title)}`;
  createTyped(st, row, op, 'summary', allocKey(st, base), data.title.trim(), data, range ?? undefined);
  return null;
}

/**
 * D-168: a `file` op pinned to the key its verb's dry run produced. An entry with that key and type (any
 * state) → merge into it; a missing `lib:` key (or one of another type now) → library_entry_missing; a
 * missing session key → create it with exactly that key (from it via allocKey when another type holds
 * it). No name matching and no classic_conflict: the dry run checked those when the row was written.
 * Ruling I: a `lib:` entry that answers to none of the op's names is another entity now (the book was
 * replaced under the same id) → library_entry_missing, never a merge.
 */
function filePinned(st: FoldState, row: MemEntry, op: number, type: EntryType, data: Rec, target: unknown): Skip {
  if (!isStr(target) || target.trim() === '') return skip('invalid');
  const held = st.entries.get(target);
  if (held !== undefined && held.type === type) {
    if (target.startsWith('lib:') && !answersTo(st, held, data)) return skip('library_entry_missing', target);
    mergeInto(st, row, op, held, data, strings(data.aliases));
    return null;
  }
  if (target.startsWith('lib:')) return skip('library_entry_missing', target);
  if (REQUIRED_FIELDS[type].some((f) => isBlank(data[f]))) return skip('missing_required');
  const idf = identityField(type);
  const identity = isStr(data[idf]) ? data[idf].trim() : '';
  if (norm(identity) === '') return skip('invalid');
  const range = type === 'summary' ? validRange(row.range) : null;
  createTyped(st, row, op, type, held === undefined ? target : allocKey(st, target), identity, data, range ?? undefined);
  return null;
}

/**
 * Whether `e` answers to a name of a file op's data (name, title, topic, aliases; normalizeName): its
 * names at this point of the fold — the book's, with the aliases, renames and former names the session
 * gave it — so a row its verb pinned by one of those names still lands (the dry run matched on them).
 */
function answersTo(st: FoldState, e: CEntry, data: Rec): boolean {
  const names = namesOf(st, e);
  for (const v of [data.name, data.title, data.topic, ...strings(data.aliases)]) {
    if (!isStr(v)) continue;
    const n = norm(v);
    if (n !== '' && names.includes(n)) return true;
  }
  return false;
}

/** D-144.3/4: merge into the entry the names find, else create one. */
function fileEntry(st: FoldState, row: MemEntry, op: number, type: EntryType, data: Rec): Skip {
  const idf = identityField(type);
  const identity = isStr(data[idf]) ? data[idf].trim() : '';
  const aliasesIn = strings(data.aliases);
  const wanted = new Set([identity, ...aliasesIn].map(norm).filter((n) => n !== ''));
  const match = wanted.size > 0 ? findIn(st, type, wanted) : null;
  if (match) {
    mergeInto(st, row, op, match, data, aliasesIn);
    return null;
  }
  for (const n of wanted) {
    const classic = st.seed.classic.get(n);
    if (classic !== undefined) return skip('classic_conflict', classic);
  }
  if (REQUIRED_FIELDS[type].some((f) => isBlank(data[f]))) return skip('missing_required');
  const base = norm(identity);
  if (base === '') return skip('invalid');
  createTyped(st, row, op, type, allocKey(st, `${type}:${base}`), identity, data);
  return null;
}

function mergeInto(st: FoldState, row: MemEntry, op: number, e: CEntry, data: Rec, aliasesIn: readonly string[]): void {
  const type = e.type as EntryType;
  const idf = identityField(type);
  const m = mergeData(e.data, data, { keep: IDENTITY_KEEP, on: row.on, appended: e.prov.appended });
  // An entry whose data had no identity value takes the filed one as its name; the old name stays an alias.
  let name = e.name;
  const filled = m.data[idf];
  if (isBlank(e.data[idf]) && isStr(filled) && !isBlank(filled)) name = filled.trim();
  const extra = name !== e.name ? [e.name] : [];
  const aliases = aliasesIn.length === 0 && extra.length === 0 ? e.aliases : aliasList([...e.aliases, ...extra, ...aliasesIn], name);
  const aliasesChanged = !sameList(aliases, e.aliases);
  // A merge that changes nothing is recorded but does not move lastSeq (D-144.4).
  touch(st, row, op, e, 'merged', m.changed);
  if (!m.changed && !aliasesChanged && name === e.name) return;
  const before = nameInputs(e);
  const old = e.data;
  e.data = m.data;
  e.prov.appended = m.appended;
  e.name = name;
  if (aliasesChanged) e.aliases = aliases;
  if (old.tagline !== e.data.tagline || old.description !== e.data.description || old.summary !== e.data.summary) e.tagline = taglineOf(type, e.data);
  e.prov.lastSeq = row.seq;
  overlay(e);
  if (!sameInputs(before, nameInputs(e))) reindex(st, e);
}

/**
 * K: the live session arc of a plot that answers to `names` (normalized: the plot's names, aliases and
 * former names) — the one whose plot is `current` first, else the first created. Library arcs are the
 * books' (the slot prefers a session arc of the same plot, ruling G).
 */
function sessionArcOf(st: FoldState, names: readonly string[], current: string): CEntry | undefined {
  let best: CEntry | undefined;
  let bestRank = Infinity;
  for (const n of names) {
    for (const key of st.index.get(n) ?? []) {
      const e = st.entries.get(key);
      if (e === undefined || e.arc === undefined || e.origin.kind !== 'session' || e.retired !== undefined) continue;
      const plot = norm(e.arc);
      if (!names.includes(plot)) continue;
      const rank = (plot === current ? 0 : 2 ** 60) + (st.born.get(key) ?? 0);
      if (rank < bestRank) {
        best = e;
        bestRank = rank;
      }
    }
  }
  return best;
}

/**
 * D-145: replace a plot's arc overview; create the plot first when no live one has that name. A
 * readable book's untyped entry of that name owns it (as for `file`): no plot then, and an issue
 * `classic_conflict` naming the plot's would-be key; the arc itself still applies. K (arcs follow
 * renamed plots): the plot is found by any of its names, aliases and former names, and its arc is the
 * live session arc that answers to any of them (sessionArcOf), renamed to the plot's current name; a
 * new arc is keyed and named by that name.
 */
function applyArc(st: FoldState, row: MemEntry, op: number, plotRaw: unknown, overview: unknown): Skip {
  if (!isStr(plotRaw) || !isStr(overview) || isBlank(plotRaw) || isBlank(overview)) return skip('invalid');
  const written = plotRaw.trim();
  const base = norm(written);
  if (base === '') return skip('invalid');
  let plot = findIn(st, 'plot', new Set([base]));
  if (plot === null) {
    if (st.seed.classic.has(base)) st.issues.push({ seq: row.seq, op, why: 'classic_conflict', key: freeKey(st, `plot:${base}`).key });
    else plot = createTyped(st, row, op, 'plot', allocKey(st, `plot:${base}`), written, { name: written, status: 'active' });
  }
  const name = plot === null ? written : plot.name;
  const current = plot === null ? base : norm(name);
  let arc = sessionArcOf(st, plot === null ? [base] : namesOf(st, plot), current);
  if (arc === undefined) {
    arc = {
      key: allocKey(st, `arc:${current}`),
      type: null,
      name,
      aliases: [],
      tagline: '',
      data: {},
      keys: [],
      content: overview,
      arc: name,
      origin: { kind: 'session' },
      prov: { created: row.on, lastSeq: row.seq, appended: {}, createdSeq: row.seq },
    };
    insert(st, arc, row, op);
  } else {
    // An arc whose plot is called otherwise now (renamed, or named by an alias) takes the plot's name.
    const renamed = norm(arc.arc ?? '') !== current;
    if (renamed) {
      arc.arc = name;
      arc.name = name;
      reindex(st, arc);
    }
    if (renamed || arc.content !== overview) {
      arc.content = overview;
      arc.prov.lastSeq = row.seq;
    }
  }
  touch(st, row, op, arc, 'arc', false);
  return null;
}

/** The entry an op's ref names, or why not: a key is looked up; C<n> or a name is resolved (D-146). */
function target(st: FoldState, ref: unknown, prefer: 'live' | 'retired'): CEntry | Skip {
  if (!isStr(ref)) return skip('invalid');
  const e = st.entries.get(ref);
  if (e) return e;
  // D-147: an overlay row whose library entry is gone (book removed, 'off', entry deleted).
  if (ref.startsWith('lib:')) return skip('library_entry_missing', ref);
  if (KEY_SHAPED.test(ref)) return skip('not_found');
  // A handle counts in the view's numbering (K, order#3): creation order, not the order the fold met them.
  const entries = handleNumber(ref) === null ? st.entries : inBornOrder(st);
  return resolveRefIn(entries, ref, prefer, (x) => namesOf(st, x)) ?? skip('not_found');
}

const isEntry = (v: CEntry | Skip): v is CEntry => v !== null && 'key' in v && 'prov' in v;

/** D-146: edit any entry. Every field is checked before anything changes, so a skipped edit leaves no trace. */
function applyEdit(st: FoldState, row: MemEntry, op: number, raw: Rec): Skip {
  const found = target(st, raw.ref, 'live');
  if (!isEntry(found)) return found;
  const e = found;
  const set = raw.set === undefined ? {} : raw.set;
  const unset = raw.unset === undefined ? [] : raw.unset;
  const { keys, featured } = raw;
  if (!isRec(set) || !isStrArray(unset)) return skip('invalid', e.key);
  if (keys !== undefined && !isStrArray(keys)) return skip('invalid', e.key);
  if (featured !== undefined && typeof featured !== 'boolean') return skip('invalid', e.key);
  const before = nameInputs(e);
  let dataChanged = false;
  if (e.type !== null) {
    const r = editTyped(e, set, unset);
    if (r !== null) return skip(r, e.key);
    dataChanged = true;
  } else if (e.arc !== undefined) {
    if (unset.some((k) => ARC_FIELDS.has(k)) || set.title !== undefined || set.name !== undefined) return skip('invalid', e.key);
    const text = set.content !== undefined ? set.content : set.overview;
    if (text !== undefined && !(isStr(text) && !isBlank(text))) return skip('invalid', e.key);
    if (isStr(text)) e.content = text;
    dataChanged = editData(e, set, unset, ARC_FIELDS);
  } else {
    // A note (M3): set.title renames, set.content replaces the text, other fields are data's.
    if (unset.some((k) => NOTE_FIELDS.has(k))) return skip('invalid', e.key);
    if (set.title !== undefined && !(isStr(set.title) && norm(set.title) !== '')) return skip('invalid', e.key);
    if (set.content !== undefined && !isStr(set.content)) return skip('invalid', e.key);
    if (isStr(set.title)) e.name = set.title;
    if (isStr(set.content)) e.content = set.content;
    dataChanged = editData(e, set, unset, NOTE_FIELDS);
  }
  if (keys !== undefined) e.keys = [...keys];
  if (featured === true) e.featured = true;
  else if (featured === false) delete e.featured;
  e.prov.lastSeq = row.seq;
  overlay(e);
  if (!sameInputs(before, nameInputs(e))) reindex(st, e);
  touch(st, row, op, e, 'edited', dataChanged);
  return null;
}

/** `set` fields other than `outside` replace data fields, `unset` deletes; true when data changed. */
function editData(e: CEntry, set: Rec, unset: readonly string[], outside: ReadonlySet<string>): boolean {
  let data: Rec | undefined;
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || outside.has(k)) continue;
    data ??= { ...e.data };
    put(data, k, v);
  }
  for (const k of unset) {
    if (!Object.hasOwn(data ?? e.data, k)) continue;
    data ??= { ...e.data };
    delete data[k];
  }
  if (data === undefined) return false;
  e.data = data;
  return true;
}

/**
 * D-146 on a typed entry: set replaces top-level fields (an array's prov.appended becomes all null),
 * unset deletes them; the identity field cannot be unset and a new value renames (the key stays, the
 * old name goes to prov.formerNames); set.aliases replaces the alias list. Returns why it cannot apply.
 */
function editTyped(e: CEntry, set: Rec, unset: readonly string[]): string | null {
  const type = e.type as EntryType;
  const idf = identityField(type);
  if (unset.includes(idf)) return 'invalid';
  const rename = set[idf];
  if (rename !== undefined && !(isStr(rename) && norm(rename) !== '')) return 'invalid';
  if (set.aliases !== undefined && !isStrArray(set.aliases)) return 'invalid';
  const data: Rec = { ...e.data };
  let appended: Record<string, (string | null)[]> | undefined;
  const prov = (): Record<string, (string | null)[]> => (appended ??= { ...e.prov.appended });
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    put(data, k, v);
    if (Array.isArray(v)) put(prov() as Rec, k, v.map(() => null));
    else if (Object.hasOwn(e.prov.appended, k)) delete prov()[k];
  }
  for (const k of unset) {
    delete data[k];
    if (Object.hasOwn(e.prov.appended, k)) delete prov()[k];
  }
  e.data = data;
  if (appended !== undefined) e.prov.appended = appended;
  if (isStr(rename)) {
    const name = rename.trim();
    const was = norm(e.name);
    const now = norm(name);
    if (now !== was) {
      const former = (e.prov.formerNames ?? []).filter((f) => norm(f) !== now);
      if (!former.some((f) => norm(f) === was)) former.push(e.name);
      e.prov.formerNames = former;
    }
    e.name = name;
  }
  if (isStrArray(set.aliases)) e.aliases = aliasList(set.aliases, e.name);
  else if (unset.includes('aliases')) e.aliases = [];
  else if (isStr(rename)) e.aliases = aliasList(e.aliases, e.name);
  e.tagline = taglineOf(type, e.data);
  return null;
}

/**
 * D-179: a human row's edit / retire / restore whose ref is a session key (not 'lib:', not C<n> or a
 * name, which resolve now) that no entry has yet is held until an op creates that key. True when held.
 */
function hold(st: FoldState, row: MemEntry, ops: readonly unknown[], i: number, op: Rec): boolean {
  const ref = op.ref;
  if (taskKey(row) !== null || !isStr(ref) || st.entries.has(ref) || ref.startsWith('lib:') || !KEY_SHAPED.test(ref)) return false;
  const h: Held = { row, ops, i, op, sizes: st.sizes };
  const list = st.held.get(ref);
  if (list) list.push(h);
  else st.held.set(ref, [h]);
  return true;
}

/** Records why an op of `row` was skipped (nothing when it applied). */
function report(st: FoldState, row: MemEntry, i: number, why: Skip): void {
  if (why !== null) st.issues.push(why.key === undefined ? { seq: row.seq, op: i, why: why.why } : { seq: row.seq, op: i, why: why.why, key: why.key });
}

/** D-179: after an op, the held ops of the keys it created apply, per key in seq order. */
function release(st: FoldState): void {
  if (st.met.length === 0) return;
  const sizes = st.sizes;
  while (st.met.length > 0) {
    const keys = st.met;
    st.met = [];
    for (const key of keys) {
      const list = st.held.get(key);
      if (list === undefined) continue;
      st.held.delete(key);
      for (const h of list) {
        st.sizes = h.sizes;
        report(st, h.row, h.i, applyOp(st, h.row, h.ops, h.i, h.op));
      }
    }
  }
  st.sizes = sizes;
}

/**
 * Apply one op (§5.8 applyMemOp). Returns why the op was skipped, else null. Every op is checked
 * whole before it changes anything, so a skipped op leaves no trace.
 */
function applyOp(st: FoldState, row: MemEntry, ops: readonly unknown[], i: number, op: Rec): Skip {
  // Rows are read leniently (entries.ts checks only `op`), so every field is checked here.
  switch (op.op) {
    case 'note': {
      const keys = op.keys === undefined ? [] : op.keys;
      if (!isStr(op.title) || !isStr(op.content) || !isStrArray(keys)) return skip('invalid');
      const base = norm(op.title);
      if (base === '') return skip('invalid');
      const e = newNote(allocKey(st, NOTE_KEY_PREFIX + base), op.title, keys, op.content, row);
      insert(st, e, row, i);
      touch(st, row, i, e, 'note', false);
      return null;
    }
    case 'file': {
      if (!isEntryType(op.type)) return skip('unknown_type');
      if (!isRec(op.data)) return skip('invalid');
      if (op.target !== undefined) return filePinned(st, row, i, op.type, op.data, op.target);
      return op.type === 'summary' ? fileSummary(st, row, ops, i, op.data) : fileEntry(st, row, i, op.type, op.data);
    }
    case 'arc':
      return applyArc(st, row, i, op.plot, op.overview);
    case 'edit':
      if (hold(st, row, ops, i, op)) return null;
      return applyEdit(st, row, i, op);
    case 'retire':
    case 'restore': {
      if (hold(st, row, ops, i, op)) return null;
      const found = target(st, op.ref, op.op === 'retire' ? 'live' : 'retired');
      if (!isEntry(found)) return found;
      if (op.op === 'retire') found.retired = { reason: isStr(op.reason) ? op.reason : '' };
      else delete found.retired;
      found.prov.lastSeq = row.seq;
      overlay(found);
      touch(st, row, i, found, op.op === 'retire' ? 'retired' : 'restored', false);
      return null;
    }
    case 'revert':
      // Consumed by the row filter (newest action per key); nothing to apply.
      return isStr(op.key) ? null : skip('invalid');
    default:
      return skip('unknown_op');
  }
}

// ---- rows -----------------------------------------------------------------------------------------

/** The rows in seq order (the log already keeps them so; anything else is sorted, never mutated). */
function inSeqOrder(rows: readonly MemEntry[]): readonly MemEntry[] {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.seq <= rows[i - 1]!.seq) return [...rows].sort((a, b) => a.seq - b.seq);
  }
  return rows;
}

const taskKey = (row: MemEntry): string | null => (isStr(row.key) ? row.key : null);

/** A 64-bit FNV-1a of a text, as 16 hex digits (two 32-bit lanes; for change detection, not security). */
function fnv64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x0100019d);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Per row: a digest of its seq and ops, and each op's JSON length (rows are immutable log entries,
 * folded again on every view).
 */
interface RowFacts {
  seq: number;
  digest: string;
  sizes: number[];
}
const ROW_FACTS = new WeakMap<MemEntry, RowFacts>();
function rowFacts(row: MemEntry, ops: readonly unknown[]): RowFacts {
  const hit = ROW_FACTS.get(row);
  if (hit !== undefined && hit.seq === row.seq) return hit;
  const texts = ops.map((op) => JSON.stringify(op) ?? '');
  const facts = { seq: row.seq, digest: `${row.seq}:${fnv64(texts.join('\u0000'))}`, sizes: texts.map((t) => t.length) };
  ROW_FACTS.set(row, facts);
  return facts;
}

const opsOf = (row: MemEntry): readonly unknown[] => (Array.isArray(row.ops) ? row.ops : []);

const byIssueOrder = (a: FoldIssue, b: FoldIssue): number => a.seq - b.seq || a.op - b.op;
function inIssueOrder(issues: readonly FoldIssue[]): boolean {
  for (let i = 1; i < issues.length; i++) if (byIssueOrder(issues[i - 1]!, issues[i]!) > 0) return false;
  return true;
}

/** An entry copied for a fold or a checkpoint (data is shared: ops replace it, never change it in place). */
function copyEntry(e: CEntry): CEntry {
  const prov = { ...e.prov };
  if (prov.formerNames !== undefined) prov.formerNames = [...prov.formerNames];
  return { ...e, aliases: [...e.aliases], keys: [...e.keys], prov };
}

interface Selected {
  effective: MemEntry[];
  tasks: Map<string, TaskState>;
  /** Each effective row's place in the fold's order. */
  order: (row: MemEntry) => RowOrder;
}

/** Where a path places rows (D-184): each message's position and, when `msgs` knows every one, their seqs root → leaf. */
interface Placement {
  at: ReadonlyMap<string, number>;
  seqs: readonly number[] | undefined;
}

function placementOf(path: readonly string[], msgs: FoldOptions['msgs'], at: ReadonlyMap<string, number>): Placement {
  // The path's messages' seqs grow from the root to the leaf (a parent is older than its children).
  if (msgs === undefined) return { at, seqs: undefined };
  const seqs: number[] = [];
  for (const id of path) {
    const m = msgs.get(id);
    if (m === undefined) return { at, seqs: undefined };
    seqs.push(m.seq);
  }
  return { at, seqs };
}

/** The number of path messages older than `seq` (seqs root → leaf): the position of the newest of them. */
function olderThan(seqs: readonly number[], seq: number): number {
  let lo = 0;
  let hi = seqs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (seqs[mid]! < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * K (order#1): the place of a row on `path` (root → leaf) in the fold's order — also of a row not
 * written yet, e.g. the pass a lane task is staging: rowOrder({key, on, seq: Infinity}, path, msgs).
 * An agent row bound to a path message → (its position, 0, seq); any other row → (the position of the
 * newest path message older than it, 1 for a human row, seq). Without `msgs` that position is the
 * leaf's (a row written now follows every message); the fold itself then uses a lower bound (storyOrder).
 */
export function rowOrder(row: { readonly key?: string | null; readonly on: string | null; readonly seq: number }, path: readonly string[], msgs?: FoldOptions['msgs']): RowOrder {
  const agent = isStr(row.key);
  const pos = row.on === null ? -1 : path.indexOf(row.on);
  if (agent && pos >= 0) return { anchor: pos + 1, kind: 0, seq: row.seq };
  const { seqs } = placementOf(path, msgs, new Map());
  return { anchor: seqs === undefined ? path.length : olderThan(seqs, row.seq), kind: agent ? 0 : 1, seq: row.seq };
}

/**
 * D-184 (review lane#2) and K (order#2): the effective rows (in seq order) in story order, by (anchor,
 * kind, seq). An agent row's anchor is the path position (1-based, D-58) of its `on`; a human row's (or
 * an agent row bound to no path message) is the position of the newest path message whose seq is below
 * the row's, 0 when none. At one anchor agent rows come first (kind 0), then human rows (kind 1). So a
 * re-write of an old answer (staleness, refile, a recovered begin) applies where its answer is in the
 * story, never after the rows of later answers, and a person's edit applies after every pass of the
 * messages up to the one it followed — also one written after it (a lagging pass, a re-write). Without
 * `msgs` a human row anchors at the newest position a row up to it is bound to (those messages are
 * older than the row); without `path`, seq order (every row (0, 0, seq)).
 */
function storyOrder(effective: MemEntry[], onPath: readonly MemEntry[], opts: FoldOptions, positions: (path: readonly string[]) => Map<string, number>): Pick<Selected, 'effective' | 'order'> {
  const path = opts.path;
  if (path === undefined) return { effective, order: (r) => ({ anchor: 0, kind: 0, seq: r.seq }) };
  const { at, seqs } = placementOf(path, opts.msgs, positions(path));
  const anchor = new Map<MemEntry, number>();
  let known = 0;
  for (const r of onPath) {
    const p = r.on === null ? undefined : at.get(r.on);
    if (p !== undefined && p + 1 > known) known = p + 1;
    anchor.set(r, taskKey(r) !== null && p !== undefined ? p + 1 : seqs !== undefined ? olderThan(seqs, r.seq) : known);
  }
  const kind = (r: MemEntry): 0 | 1 => (taskKey(r) !== null ? 0 : 1);
  const order = (r: MemEntry): RowOrder => ({ anchor: anchor.get(r)!, kind: kind(r), seq: r.seq });
  const rank = (r: MemEntry): number => 2 * anchor.get(r)! + kind(r);
  for (let i = 1; i < effective.length; i++) {
    // Stable: rows of one anchor and kind stay in seq order.
    if (rank(effective[i]!) < rank(effective[i - 1]!)) return { effective: effective.sort((a, b) => rank(a) - rank(b)), order };
  }
  return { effective, order };
}

/**
 * D-143 row selection: on the path, not stale, newest action per task key. Human rows (key null) all
 * pass. `tasks` reports every key seen on the path: 'reverted' when its newest action is a revert,
 * 'applied' when a fresh row with the key applies, else 'stale'. M5b (D-179, G-2): `range` is that of
 * the row the status is about (the applied row; the newest stale row; for a reverted key the reverted
 * row, the newest row of the key before the revert), and a reverted key whose reverted row is stale
 * now says `stale: true` (staleness re-writes even after an undo, D-74). A stale row NEWER than the
 * revert (a refile after the undo, then an edit in its range) re-opened the key: the status is 'stale',
 * about that row.
 */
function selectRows(rows: readonly MemEntry[], opts: FoldOptions): Selected {
  const without = opts.without;
  const onPath = inSeqOrder(rows).filter((r) => (r.on === null || opts.pathSet.has(r.on as string)) && (without === undefined || r.key !== without));
  let position: Map<string, number> | undefined;
  const positions = (path: readonly string[]): Map<string, number> => (position ??= new Map(path.map((id, i) => [id, i])));
  const stale = (r: MemEntry): boolean => {
    if (opts.path === undefined || r.range === undefined) return false;
    const range = validRange(r.range);
    if (range === null) return true;
    position = positions(opts.path);
    const from = position.get(range[0]);
    const to = position.get(range[1]);
    if (from === undefined || to === undefined || from > to) return true;
    if (opts.touched === undefined) return false;
    for (let p = from; p <= to; p++) {
      const t = opts.touched.get(opts.path[p]!);
      if (t !== undefined && t > r.seq) return true;
    }
    return false;
  };
  const fresh: MemEntry[] = [];
  const newestAny = new Map<string, MemEntry>();
  const newestFresh = new Map<string, MemEntry>();
  const newestRevert = new Map<string, number>();
  for (const r of onPath) {
    const key = taskKey(r);
    if (key !== null) {
      newestAny.set(key, r);
      if (stale(r)) continue;
      newestFresh.set(key, r);
    }
    fresh.push(r);
    for (const op of opsOf(r)) if (isRec(op) && op.op === 'revert' && isStr(op.key)) newestRevert.set(op.key, r.seq);
  }
  const { effective, order } = storyOrder(
    fresh.filter((r) => {
      const key = taskKey(r);
      if (key === null) return true;
      const revert = newestRevert.get(key);
      return newestFresh.get(key) === r && !(revert !== undefined && revert >= r.seq);
    }),
    onPath,
    opts,
    positions,
  );
  const tasks = new Map<string, TaskState>();
  const about = (s: TaskState, from: MemEntry | undefined): TaskState => {
    const range = from === undefined ? null : validRange(from.range);
    return range ? { ...s, range } : s;
  };
  const state = (key: string): TaskState => {
    const revert = newestRevert.get(key);
    const row = newestFresh.get(key);
    const any = newestAny.get(key);
    if (revert !== undefined && (row === undefined || revert >= row.seq)) {
      // Here the newest row of the key is either older than the revert (the reverted row) or stale.
      if (any !== undefined && any.seq > revert) return about({ seq: any.seq, status: 'stale' }, any);
      const s: TaskState = { seq: revert, status: 'reverted' };
      if (any !== undefined && row !== any) s.stale = true;
      return about(s, any);
    }
    if (row !== undefined) return about({ seq: row.seq, status: 'applied' }, row);
    return about({ seq: any!.seq, status: 'stale' }, any);
  };
  for (const key of newestAny.keys()) tasks.set(key, state(key));
  for (const key of newestRevert.keys()) if (!tasks.has(key)) tasks.set(key, state(key));
  return { effective, tasks, order };
}

/** K (order#1): the leading rows that sort before `before` (the rows are in the fold's order). */
function rowsBefore(rows: MemEntry[], order: (row: MemEntry) => RowOrder, before: RowOrder): MemEntry[] {
  for (let i = 0; i < rows.length; i++) if (compareRowOrder(order(rows[i]!), before) >= 0) return rows.slice(0, i);
  return rows;
}

/**
 * Fold the rows that apply to a path onto the library seed (§5.8, D-143):
 * 1. the seed's entries, in seed order (keys 'lib:…');
 * 2. rows with `on` null or on the path (without `opts.without`'s rows); agent rows not stale; per task
 *    key the newest action;
 * 3. each op of those rows in story order (D-184, K: `storyOrder`, by (anchor, kind, seq) — the path
 *    position the row belongs to, agent rows before human rows, then seq; seq order without a path),
 *    only those before `opts.before` when it is set — note, file, arc, edit, retire, restore; revert is
 *    a no-op; a human edit / retire / restore of a key not created yet waits for it (D-179, `hold`).
 * `entries` are in handle order (K: the seed's, then session entries by the row and op that created
 * them). rev hashes the applied rows in that order and the seed ('' when both are empty); lastSeq is
 * the newest applied row's seq; issues name skipped ops in (seq, op) order (and `large_entry`, once per
 * key, at the last op that changed an entry whose data reached LARGE_ENTRY_CHARS); effects list each
 * applied op's change in the order applied: a held op's effect (its own seq) right after the op that
 * created its entry, a re-written row's where its message is in the story.
 */
export function foldCompendium(rows: readonly MemEntry[], opts: FoldOptions): CompendiumView {
  const seed = opts.library ?? EMPTY_SEED;
  const selected = selectRows(rows, opts);
  const { tasks } = selected;
  const effective = opts.before === undefined ? selected.effective : rowsBefore(selected.effective, selected.order, opts.before);
  const keep = opts.trial !== true;
  const chain = effective.length > 0 ? chainOf(seed, effective[0]!) : undefined;
  const resumed = chain === undefined ? undefined : bestCheckpoint(chain, effective);
  const done = resumed?.rows.length ?? 0;
  // K (order#4): the frontier, right after the newest agent row in this order. A pass that lands next
  // applies there (before the person's rows that follow), so its checkpoint is kept and kept fresh.
  let frontier = 0;
  for (let i = effective.length - 1; i >= 0 && frontier === 0; i--) if (taskKey(effective[i]!) !== null) frontier = i + 1;
  const st = resumed === undefined ? freshState(seed) : copyState(resumed.st);
  const digests: string[] = seed.hash === '' ? [] : [`lib:${seed.hash}`];
  let lastSeq = 0;
  effective.forEach((row, r) => {
    const ops = opsOf(row);
    const facts = rowFacts(row, ops);
    digests.push(facts.digest);
    if (row.seq > lastSeq) lastSeq = row.seq;
    if (r < done) return;
    st.sizes = facts.sizes;
    ops.forEach((op, i) => {
      report(st, row, i, isRec(op) ? applyOp(st, row, ops, i, op) : skip('invalid'));
      release(st);
    });
    const n = r + 1;
    if (keep && chain !== undefined && n < effective.length && (n % CHECKPOINT_EVERY === 0 || n === frontier)) keepCheckpoint(chain, effective.slice(0, n), st);
  });
  st.entries = inBornOrder(st);
  if (chain !== undefined) {
    if (frontier > 0 && frontier < done) touchCheckpoint(chain, effective, frontier);
    if (keep && done < effective.length) keepCheckpoint(chain, effective, st);
  }
  // D-179: a held op that never met its entry is what it would have been at once.
  for (const list of st.held.values()) for (const h of list) st.issues.push({ seq: h.row.seq, op: h.i, why: 'not_found' });
  for (const [key, at] of st.changed) {
    if (st.bound.get(key)! < LARGE_ENTRY_CHARS || JSON.stringify(st.entries.get(key)!.data).length < LARGE_ENTRY_CHARS) continue;
    st.issues.push({ seq: at.seq, op: at.op, why: 'large_entry', key });
  }
  // Issues in (seq, op) order: held ops and the large_entry flags are reported out of fold order.
  if (!inIssueOrder(st.issues)) st.issues.sort(byIssueOrder);
  const rev = digests.length === 0 ? '' : createHash('sha256').update(digests.join('\n')).digest('hex').slice(0, 16);
  return { entries: st.entries, rev, lastSeq, issues: st.issues, tasks, effects: st.effects };
}

/**
 * K (order#1): what a lane pass stages against — exactly the rows the fold applies before the pass's
 * row (a task-keyed row bound to `pass.on`, written next): on `opts.path` (the head's), every row that
 * sorts before (pos(on), agent, ∞) — the rows of earlier answers, the person's rows that follow them,
 * the other passes of `on` — never a person's row made while `on` or a later message was the head,
 * and without the rows of `pass.key` itself (a refile or a re-write stages against what the rest made).
 */
export function foldStaged(rows: readonly MemEntry[], opts: FoldOptions & { path: readonly string[] }, pass: { key: string; on: string }): CompendiumView {
  return foldCompendium(rows, { ...opts, without: pass.key, before: rowOrder({ key: pass.key, on: pass.on, seq: Infinity }, opts.path, opts.msgs) });
}

// ---- checkpoints ----------------------------------------------------------------------------------
//
// A session folds the same rows again on every view change (a new message, a row, a swipe's view at
// U, a verb's dry run, the lane's staging), and the state after a prefix of the effective rows (in
// story order, D-184) depends on that prefix and the seed only. So every fold keeps a copy of its state
// at the end (and every CHECKPOINT_EVERY rows) and the next fold whose effective rows start with the
// same row objects resumes from the longest one: a new message applies no row, a new row one (review
// breaker#2: below the old 256-row floor every view change refolded from the seed). The result is the
// same as a fold from the seed (test/memory/checkpoint.test.ts, test/fold-m5b). K (order#4): a trial
// fold (a verb's dry run: its row is never written) keeps none, and every fold also keeps, and keeps
// fresh, the one at its frontier (after the newest agent row): a lagging pass lands there, before the
// person's rows, however many verbs came in between.

const CHECKPOINT_EVERY = 2048;
/** Checkpoints kept per chain (a seed and a first row); the least recently used goes first. */
const CHECKPOINT_KEEP = 6;

interface Checkpoint {
  /** The effective rows applied, in order. */
  rows: readonly MemEntry[];
  st: FoldState;
  used: number;
}

const CHECKPOINTS = new WeakMap<LibrarySeed, WeakMap<MemEntry, Checkpoint[]>>();
let checkpointClock = 0;

function chainOf(seed: LibrarySeed, first: MemEntry): Checkpoint[] {
  let bySeed = CHECKPOINTS.get(seed);
  if (bySeed === undefined) CHECKPOINTS.set(seed, (bySeed = new WeakMap()));
  let chain = bySeed.get(first);
  if (chain === undefined) bySeed.set(first, (chain = []));
  return chain;
}

function isPrefix(prefix: readonly MemEntry[], rows: readonly MemEntry[]): boolean {
  if (prefix.length > rows.length) return false;
  for (let i = prefix.length - 1; i >= 0; i--) if (prefix[i] !== rows[i]) return false;
  return true;
}

function bestCheckpoint(chain: Checkpoint[], rows: readonly MemEntry[]): Checkpoint | undefined {
  let best: Checkpoint | undefined;
  for (const cp of chain) if ((best === undefined || cp.rows.length > best.rows.length) && isPrefix(cp.rows, rows)) best = cp;
  if (best !== undefined) best.used = ++checkpointClock;
  return best;
}

/** Marks the checkpoint of `rows`' first `length` rows (when one is kept) as just used. */
function touchCheckpoint(chain: Checkpoint[], rows: readonly MemEntry[], length: number): void {
  for (const cp of chain) {
    if (cp.rows.length !== length || !isPrefix(cp.rows, rows)) continue;
    cp.used = ++checkpointClock;
    return;
  }
}

function keepCheckpoint(chain: Checkpoint[], rows: readonly MemEntry[], st: FoldState): void {
  const same = chain.find((cp) => cp.rows.length === rows.length && isPrefix(cp.rows, rows));
  if (same !== undefined) {
    same.used = ++checkpointClock;
    return;
  }
  chain.push({ rows, st: copyState(st), used: ++checkpointClock });
  if (chain.length > CHECKPOINT_KEEP) {
    let oldest = 0;
    for (let i = 1; i < chain.length; i++) if (chain[i]!.used < chain[oldest]!.used) oldest = i;
    chain.splice(oldest, 1);
  }
}

function freshState(seed: LibrarySeed): FoldState {
  const st: FoldState = {
    entries: new Map(),
    suffix: new Map(),
    issues: [],
    effects: [],
    seed,
    seedNames: seedNames(seed),
    names: new Map(),
    index: new Map(),
    born: new Map(),
    changed: new Map(),
    bound: new Map(),
    sizes: [],
    held: new Map(),
    met: [],
  };
  for (const e of seed.entries) if (!st.entries.has(e.key)) st.entries.set(e.key, copyEntry(e));
  return st;
}

/** A state that shares nothing a fold changes in place with `st`. */
function copyState(st: FoldState): FoldState {
  const entries = new Map<string, CEntry>();
  for (const [key, e] of st.entries) entries.set(key, copyEntry(e));
  const index = new Map<string, string[]>();
  for (const [name, keys] of st.index) index.set(name, keys.slice());
  const held = new Map<string, Held[]>();
  for (const [key, list] of st.held) held.set(key, list.slice());
  return {
    entries,
    suffix: new Map(st.suffix),
    issues: st.issues.slice(),
    effects: st.effects.slice(),
    seed: st.seed,
    seedNames: st.seedNames,
    names: new Map(st.names),
    index,
    born: new Map(st.born),
    changed: new Map(st.changed),
    bound: new Map(st.bound),
    sizes: [],
    held,
    met: [],
  };
}
