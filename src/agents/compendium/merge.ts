// Ported from Bunraku:src/core/compendium/merge.ts@702d8120 (mergeData: a blank value never erases,
// objects deep-merge, scalars replace, the same reference when nothing changes) and
// RoleCall:apps/rc/src/lib/ai/dm-stream/tools/compendium-definitions.ts:66-349@fb8dc623e (normKey,
// ARRAY_KEY_FNS, the keyed array dedup, the near-duplicate collapse of string facts).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a `file` op's data merges into an entry (.notes/m5a-decisions.md D-148, D-149). Pure.
// - Blank (undefined, null, a whitespace-only string) never erases, at any depth; blank list items
//   are dropped. An absent old value takes the incoming one, cleaned the same way (arrays go through
//   the array merge against [], so a first write is deduplicated too).
// - Objects deep-merge, scalars replace (no change when deepEq), a kind mismatch replaces.
// - Arrays of a field with a key fn (by field name, at any depth): same key → the item deep-merges
//   into the existing one; new key → appended; no key → appended unless deepEq to an item already
//   there. Other arrays: append what is not deepEq to an item already there (one lookup in a set of
//   canonical texts kept per list). When a string was added or reworded, near-duplicate string facts
//   then collapse over the whole list.
// - Past MERGE_MAX_DEPTH (32) nesting levels a value is a scalar: it replaces, never recursed.
// - `keep` (identity fields, top level): an existing non-blank value is never replaced.
// - Per TOP-level array field the result says where each element came from (prov.appended, D-149).
// Changes from the sources: Bunraku's blank rule (RoleCall let '' erase); RoleCall's key fns fixed
// (affiliations by org, else with; abilities and every keyed field accept a plain string; a composite
// key whose parts are all empty is no key); first index wins on duplicate old keys; tokens of the
// near-duplicate test are word stems (RoleCall's [^a-z0-9] erased every Cyrillic word).

import { deepEq } from '../../formats/wire.ts';
import { foldText, STOP_WORDS, wordsOf } from '../../text/normalize.ts';
import { isBlank } from './entry-types.ts';
import type { Rec } from './types.ts';

export { deepEq };

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sets an own property, also for the key '__proto__' (data comes from model output). */
function put(o: Rec, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
  else o[key] = value;
}

/** normKey results by text: the fold re-merges the same lists on every refold. Oldest first. */
const KEY_MEMO = new Map<string, string>();
const KEY_MEMO_MAX = 16_384;

/** A string as array keys compare it: foldText (NFKC, lower case, ё→е, marks dropped), whitespace collapsed, trimmed. '' for a non-string. */
export function normKey(s: unknown): string {
  if (typeof s !== 'string') return '';
  const hit = KEY_MEMO.get(s);
  if (hit !== undefined) return hit;
  const out = foldText(s).replace(/\s+/gu, ' ').trim();
  if (KEY_MEMO.size >= KEY_MEMO_MAX) KEY_MEMO.delete(KEY_MEMO.keys().next().value as string);
  KEY_MEMO.set(s, out);
  return out;
}

type KeyFn = (item: unknown) => string;

/** A plain string list: the item's normKey. */
const asString: KeyFn = (item) => normKey(item);

/** A string, or an object keyed by the first non-blank of `fields`. */
const byField =
  (...fields: string[]): KeyFn =>
  (item) => {
    if (typeof item === 'string') return normKey(item);
    if (!isRec(item)) return '';
    for (const f of fields) if (!isBlank(item[f])) return normKey(item[f]);
    return '';
  };

/** A string, or an object keyed by two fields; no key when both are empty. */
const byPair =
  (a: string, b: string): KeyFn =>
  (item) => {
    if (typeof item === 'string') return normKey(item);
    if (!isRec(item)) return '';
    const x = normKey(item[a]);
    const y = normKey(item[b]);
    return x === '' && y === '' ? '' : `${x}|${y}`;
  };

const STRING_LIST_FIELDS = [
  'factions_present', 'key_residents', 'connected_to', 'goals', 'methods', 'beliefs', 'allies', 'enemies', 'territory',
  'consequences', 'related_plots', 'central_characters', 'key_locations', 'involved_organizations', 'obstacles',
  'recent_developments', 'affected_targets', 'counters', 'weaknesses', 'who_can_stop_it', 'clues_revealed', 'key_facts',
  'rules', 'exceptions', 'applies_to', 'related_to', 'involved_locations', 'aliases', 'traits', 'quirks', 'fears', 'secrets',
  'notable_features', 'distinguishing_features', 'drawbacks', 'behaviors', 'predators', 'prey', 'symbiotes', 'known_locations',
];

/**
 * Stable item keys per array field name (RoleCall ARRAY_KEY_FNS, fixed). A key '' means "no key": the
 * item is appended unless deepEq to one already in the list.
 */
export const ARRAY_KEY_FNS: Readonly<Record<string, KeyFn>> = {
  relationships: byPair('with', 'nature'),
  // RoleCall keyed by `with`, but the schema's item is {org, role, since, status} (decisions A.7).
  affiliations: byField('org', 'with'),
  memories: byPair('what_happened', 'when'),
  key_moments: byField('label', 'description'),
  points_of_interest: byField('name'),
  members: byField('name'),
  participants: byField('name'),
  // An item's abilities are strings, a creature's are {name, type, …}.
  abilities: byPair('name', 'type'),
  ...Object.fromEntries(STRING_LIST_FIELDS.map((f) => [f, asString])),
};

const keyFnOf = (field: string | undefined): KeyFn | undefined =>
  field !== undefined && Object.hasOwn(ARRAY_KEY_FNS, field) ? ARRAY_KEY_FNS[field] : undefined;

// ---- near-duplicate string facts ------------------------------------------------------------------

/** RoleCall NEAR_DUP_STOPWORDS (verbatim), D-46 STOP_WORDS and a few folded Russian function words. */
const NEAR_DUP_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'his', 'her', 'their', 'with', 'from', 'that', 'this', 'was', 'were', 'has', 'had', 'have', 'for', 'into',
  'onto', 'but', 'not', 'are', 'its', 'who', 'which', 'when', 'then', 'than', 'also', 'been', 'being',
  ...STOP_WORDS,
  'его', 'она', 'они', 'оно', 'был', 'была', 'было', 'были', 'что', 'это', 'для', 'при', 'или', 'так', 'уже', 'еще', 'тоже',
  'также', 'который', 'которая', 'которое', 'которые', 'над', 'под', 'без', 'про', 'через', 'после', 'перед',
]);
/** The smaller fact needs this many significant tokens to be a near-duplicate at all. */
export const NEAR_DUP_MIN_TOKENS = 3;
export const NEAR_DUP_JACCARD = 0.8;
/** Past this many items the scan is skipped; exact keys still apply. */
export const NEAR_DUP_SCAN_LIMIT = 400;

/** Token sets by text: the fold re-merges the same facts on every refold. Oldest first. */
const TOKEN_MEMO = new Map<string, ReadonlySet<string>>();
const TOKEN_MEMO_MAX = 16_384;

function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
}

/** The distinct stems of the words whose folded form has ≥ 3 code points and is not a stop word. */
function significantTokens(s: string): ReadonlySet<string> {
  const hit = TOKEN_MEMO.get(s);
  if (hit !== undefined) return hit;
  const out = new Set<string>();
  for (const w of wordsOf(s)) if (codePoints(w.norm) >= 3 && !NEAR_DUP_STOPWORDS.has(w.norm)) out.add(w.stem);
  if (TOKEN_MEMO.size >= TOKEN_MEMO_MAX) TOKEN_MEMO.delete(TOKEN_MEMO.keys().next().value as string);
  TOKEN_MEMO.set(s, out);
  return out;
}

/** RoleCall isNearDuplicateFact: all tokens of the smaller in the larger, or Jaccard ≥ 0.8; the smaller needs ≥ 3 tokens. */
function isNearDuplicate(ta: ReadonlySet<string>, tb: ReadonlySet<string>): boolean {
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = smaller === ta ? tb : ta;
  if (smaller.size < NEAR_DUP_MIN_TOKENS) return false;
  let shared = 0;
  for (const t of smaller) if (larger.has(t)) shared++;
  if (shared === smaller.size) return true;
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= NEAR_DUP_JACCARD;
}

/** The collapse, or null when nothing collapsed (or the list is over the scan limit). */
function collapse(items: readonly unknown[]): { items: unknown[]; from: number[] } | null {
  if (items.length > NEAR_DUP_SCAN_LIMIT) return null;
  const out: unknown[] = [];
  const from: number[] = [];
  /** Per kept slot: the tokens of its current text (undefined: not a candidate). */
  const tokensAt: (ReadonlySet<string> | undefined)[] = [];
  // token → kept slots holding it (two facts can be near-duplicates only if they share a token).
  const postings = new Map<string, number[]>();
  const index = (slot: number, tokens: ReadonlySet<string>): void => {
    for (const t of tokens) {
      const list = postings.get(t);
      if (list === undefined) postings.set(t, [slot]);
      else if (!list.includes(slot)) list.push(slot);
    }
  };
  /** The item index a slot was last checked for (each slot is checked once per item). */
  const seen = new Int32Array(items.length).fill(-1);
  let collapsed = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tokens = typeof item === 'string' ? significantTokens(item) : undefined;
    if (tokens === undefined || tokens.size < NEAR_DUP_MIN_TOKENS) {
      out.push(item);
      from.push(i);
      tokensAt.push(undefined);
      continue;
    }
    // The FIRST kept slot it nearly duplicates.
    let best = -1;
    for (const t of tokens) {
      const list = postings.get(t);
      if (list === undefined) continue;
      for (const slot of list) {
        if (seen[slot] === i || (best !== -1 && slot > best)) continue;
        seen[slot] = i;
        if (isNearDuplicate(tokensAt[slot]!, tokens)) best = slot;
      }
    }
    if (best === -1) {
      index(out.length, tokens);
      out.push(item);
      from.push(i);
      tokensAt.push(tokens);
      continue;
    }
    collapsed = true;
    if ((item as string).length > (out[best] as string).length) {
      out[best] = item;
      from[best] = i;
      tokensAt[best] = tokens;
      index(best, tokens);
    }
  }
  return collapsed ? { items: out, from } : null;
}

/**
 * RoleCall collapseNearDuplicateStrings: each string item merges into the FIRST kept string it nearly
 * duplicates; the slot keeps the first one's position and takes the longer wording. Non-strings pass
 * through. `from[j]` is the index in `items` whose value ended in slot j. More than 400 items, or
 * nothing collapsed: `items` itself is returned.
 */
export function collapseNearDuplicates(items: readonly unknown[]): { items: unknown[]; from: number[] } {
  return collapse(items) ?? { items: items as unknown[], from: items.map((_, i) => i) };
}

// ---- the merge ------------------------------------------------------------------------------------

/**
 * Nesting levels the merge walks (a top-level field is level 1). Past it a value is a scalar: it
 * replaces what was there (unless equal), never recursed, so no data is too deep to fold.
 */
export const MERGE_MAX_DEPTH = 32;

/**
 * A text two values share exactly when deepEq calls them equal: object keys sorted, an object's
 * undefined field left out, an array's undefined item kept apart from null. null for a value deepEq
 * calls equal to nothing else (NaN, a symbol, a function, anything holding one). Past MERGE_MAX_DEPTH
 * levels below `v` the rest is JSON.stringify's text (no recursion here, whatever the depth).
 */
function canonical(v: unknown, depth = 0): string | null {
  if (v === undefined) return 'u';
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return Number.isNaN(v) ? null : `${v}`;
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return `${v}n`;
    case 'object':
      break;
    default:
      return null;
  }
  if (depth >= MERGE_MAX_DEPTH) return JSON.stringify(v);
  const parts: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = canonical(item, depth + 1);
      if (t === null) return null;
      parts.push(t);
    }
    return `[${parts.join(',')}]`;
  }
  const o = v as Rec;
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined) continue;
    const t = canonical(o[k], depth + 1);
    if (t === null) return null;
    parts.push(`${JSON.stringify(k)}:${t}`);
  }
  return `{${parts.join(',')}}`;
}

/** deepEq for a value past MERGE_MAX_DEPTH (bounded: canonical stops recursing). */
function sameDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const t = canonical(a);
  return t !== null && t === canonical(b);
}

/**
 * deepEq with the merge's depth bound, for JSON-shaped values (what rows and views hold): key order
 * carries no meaning, an undefined field equals an absent one, NaN equals nothing. The walk covers
 * MERGE_MAX_DEPTH levels below the arguments (a value directly in `a` is level 1, as a top-level field
 * is for the merge); a deeper value compares as the merge compares one past its bound (sameDeep: a
 * canonical text, JSON.stringify's past another MERGE_MAX_DEPTH levels, where key order counts — two
 * equal values can then only be called different). No recursion past that, whatever the depth: the
 * verbs' no-op check uses it, never deepEq (ruling I).
 */
export function sameData(a: unknown, b: unknown): boolean {
  return sameAt(a, b, 0);
}

function sameAt(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth > MERGE_MAX_DEPTH) return sameDeep(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameAt(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const ao = a as Rec;
  const bo = b as Rec;
  for (const k of Object.keys(ao)) if (!sameAt(ao[k], Object.hasOwn(bo, k) ? bo[k] : undefined, depth + 1)) return false;
  for (const k of Object.keys(bo)) if (!Object.hasOwn(ao, k) && bo[k] !== undefined) return false;
  return true;
}

interface ArrayMerge {
  items: unknown[];
  /**
   * After a near-duplicate collapse, per result element: its index in the old array when it is that old
   * element unchanged, else -1. Without one (undefined): old elements kept their places, those in
   * `changedAt` merged in place, and new ones follow them.
   */
  from?: number[];
  /** Old positions a keyed merge changed. */
  changedAt: ReadonlySet<number>;
  /** false: `items` is the old array itself. */
  changed: boolean;
}

const NONE: ReadonlySet<number> = new Set();

/** A new value at `depth` as the merge stores it: blanks dropped at every depth it walks (arrays deduplicated). */
const fresh = (v: unknown, depth: number): unknown => mergeValue(undefined, v, undefined, depth);

/**
 * The key → first index map of a list, by key fn, so the next merge into the same list does not key
 * every old item again. `own`: the map belongs to a list this module made, whose successor may take
 * the map over (a merged list replaces its predecessor; lists are never changed in place).
 */
const KEY_INDEX = new WeakMap<readonly unknown[], { fn: KeyFn; index: Map<string, number>; own: boolean }>();

function keyIndex(list: readonly unknown[], fn: KeyFn): { index: Map<string, number>; own: boolean } {
  const hit = KEY_INDEX.get(list);
  if (hit !== undefined && hit.fn === fn) return hit;
  const index = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const k = fn(list[i]);
    if (k !== '' && !index.has(k)) index.set(k, i);
  }
  const out = { fn, index, own: false };
  KEY_INDEX.set(list, out);
  return out;
}

/**
 * The canonical texts of a list's items that have no key (every item when the field has no key fn),
 * so deduplicating an unkeyed item is one lookup instead of a deepEq scan of the list. Kept per list
 * like KEY_INDEX (`own`: a successor list may take the set over). An item with a key is never deepEq
 * to one without (equal items have equal keys), so the keyed ones need no place here.
 */
const PLAIN_INDEX = new WeakMap<readonly unknown[], { fn: KeyFn | undefined; texts: Set<string>; own: boolean }>();

function plainIndex(list: readonly unknown[], fn: KeyFn | undefined): { texts: Set<string>; own: boolean } {
  const hit = PLAIN_INDEX.get(list);
  if (hit !== undefined && hit.fn === fn) return hit;
  const texts = new Set<string>();
  for (const item of list) {
    if (fn !== undefined && fn(item) !== '') continue;
    const t = canonical(item);
    if (t !== null) texts.add(t);
  }
  const out = { fn, texts, own: false };
  PLAIN_INDEX.set(list, out);
  return out;
}

/** `depth`: the list's own level. */
function mergeArray(old: readonly unknown[], incoming: readonly unknown[], field: string | undefined, depth: number): ArrayMerge {
  const keyFn = keyFnOf(field);
  // An empty list has nothing to index (first writes merge against a fresh []).
  const cached = keyFn === undefined || old.length === 0 ? undefined : keyIndex(old, keyFn);
  const known = cached?.index;
  const added = new Map<string, number>();
  /** The old list's unkeyed items (built on the first unkeyed incoming item) and the ones this merge added. */
  let plain: { texts: Set<string>; own: boolean } | undefined;
  const addedPlain = new Set<string>();
  let items: unknown[] | undefined;
  /** Old positions a keyed merge changed. */
  const changedAt = new Set<number>();
  /** A string was added or reworded: the near-duplicate collapse has something to do. */
  let strings = false;
  for (const raw of incoming) {
    if (isBlank(raw)) continue;
    const k = keyFn === undefined ? '' : keyFn(raw);
    if (k !== '') {
      const at = known?.get(k) ?? added.get(k);
      if (at !== undefined) {
        // Object items recurse by their own field names; strings take the incoming wording.
        const had = (items ?? old)[at];
        const merged = mergeValue(had, raw, undefined, depth + 1);
        if (merged === had) continue;
        items ??= old.slice();
        items[at] = merged;
        if (at < old.length) changedAt.add(at);
        strings ||= typeof merged === 'string';
        continue;
      }
      items ??= old.slice();
      added.set(k, items.length);
      const value = fresh(raw, depth + 1);
      items.push(value);
      strings ||= typeof value === 'string';
      continue;
    }
    const value = fresh(raw, depth + 1);
    // deepEq to an item already in the list: one set lookup (a value deepEq calls equal to nothing has no text).
    const text = canonical(value);
    if (text !== null) {
      plain ??= old.length === 0 ? { texts: new Set(), own: true } : plainIndex(old, keyFn);
      if (plain.texts.has(text) || addedPlain.has(text)) continue;
      addedPlain.add(text);
    }
    items ??= old.slice();
    items.push(value);
    strings ||= typeof value === 'string';
  }
  if (items === undefined) return { items: old as unknown[], changedAt: NONE, changed: false };
  const at = (j: number): number => (j < old.length && !changedAt.has(j) ? j : -1);
  // Only a new or reworded string can make (or, through a longer wording, join) near-duplicates.
  const c = strings ? collapse(items) : null;
  if (c !== null) {
    // A rephrasing that collapsed back into what was there is no change.
    if (c.items.length === old.length && c.items.every((v, i) => v === old[i])) return { items: old as unknown[], changedAt: NONE, changed: false };
    return { items: c.items, from: c.from.map(at), changedAt, changed: true };
  }
  if (keyFn !== undefined) {
    // Positions did not move: the next merge into this list starts from this index.
    let index = added;
    if (cached !== undefined) {
      index = cached.own ? cached.index : new Map(cached.index);
      for (const [k, i] of added) index.set(k, i);
      if (cached.own) KEY_INDEX.delete(old);
    }
    KEY_INDEX.set(items, { fn: keyFn, index, own: true });
  }
  // Items were only appended or merged in place (keyed ones stay keyed): the unkeyed set carries over.
  const hit = PLAIN_INDEX.get(old);
  const prior = plain ?? (hit?.fn === keyFn ? hit : undefined);
  if (prior !== undefined) {
    const texts = prior.own ? prior.texts : new Set(prior.texts);
    for (const t of addedPlain) texts.add(t);
    if (prior.own) PLAIN_INDEX.delete(old);
    PLAIN_INDEX.set(items, { fn: keyFn, texts, own: true });
  }
  return { items, changedAt, changed: true };
}

/**
 * `incoming` merged into `old` at `depth` (the field name picks an array key fn); `old` itself when
 * nothing changes. Past MERGE_MAX_DEPTH the incoming value replaces as a scalar.
 */
function mergeValue(old: unknown, incoming: unknown, field: string | undefined, depth: number): unknown {
  if (isBlank(incoming)) return old;
  if (depth > MERGE_MAX_DEPTH) return old !== undefined && old !== null && sameDeep(old, incoming) ? old : incoming;
  if (Array.isArray(incoming)) {
    if (Array.isArray(old)) return mergeArray(old, incoming, field, depth).items;
    return mergeArray([], incoming, field, depth).items;
  }
  if (isRec(incoming)) {
    const base = isRec(old) ? old : undefined;
    let next: Rec | undefined = base === undefined ? {} : undefined;
    for (const key of Object.keys(incoming)) {
      const had = base?.[key];
      const merged = mergeValue(had, incoming[key], key, depth + 1);
      if (merged === had) continue;
      next ??= { ...base };
      put(next, key, merged);
    }
    return next ?? base;
  }
  return old !== undefined && old !== null && deepEq(old, incoming) ? old : incoming;
}

/** prov.appended of a merged top-level list (D-149) from the old list's (`prev`, parallel to `oldLength` items). */
function provenance(m: ArrayMerge, prev: readonly (string | null)[], oldLength: number, on: string | null): (string | null)[] {
  if (m.from !== undefined) return m.from.map((i) => (i >= 0 ? (prev[i] ?? null) : on));
  // Old elements in place (a missing value is null), the ones merged in place and the appended ones get `on`.
  const out = prev.length > oldLength ? prev.slice(0, oldLength) : prev.slice();
  for (let j = out.length; j < oldLength; j++) out.push(null);
  for (const j of m.changedAt) out[j] = on;
  for (let j = oldLength; j < m.items.length; j++) out.push(on);
  return out;
}

export interface MergeOptions {
  /** Top-level fields an existing non-blank value of which is never replaced (IDENTITY_KEEP). */
  keep: readonly string[];
  /** The writing row's `on`: what new and changed top-level array elements record (D-149). */
  on: string | null;
  /** The entry's prov.appended before the merge. */
  appended: Readonly<Record<string, (string | null)[]>>;
}

export interface MergeResult {
  /** `old` itself when nothing changed. */
  data: Rec;
  /** prov.appended after the merge; the given object itself when nothing changed. */
  appended: Record<string, (string | null)[]>;
  changed: boolean;
}

/**
 * `incoming` merged into `old` (D-148). prov.appended (D-149): per top-level array field, parallel to
 * its elements — a new element or an old one the merge changed gets `on`, an unchanged old one keeps
 * its value (missing = null), a slot that a collapse took over follows the text it kept; a field
 * replaced by a non-array loses its entry. Nested arrays carry none.
 */
export function mergeData(old: Rec, incoming: Rec, opts: MergeOptions): MergeResult {
  let data = old;
  let appended = opts.appended as Record<string, (string | null)[]>;
  const write = (field: string, value: unknown, prov: (string | null)[] | undefined): void => {
    if (data === old) data = { ...old };
    put(data, field, value);
    if (prov === undefined && !Object.hasOwn(appended, field)) return;
    if (appended === opts.appended) appended = { ...opts.appended };
    if (prov === undefined) delete appended[field];
    else put(appended as Rec, field, prov);
  };
  for (const field of Object.keys(incoming)) {
    const value = incoming[field];
    if (isBlank(value)) continue;
    const before = old[field];
    if (opts.keep.includes(field) && !isBlank(before)) continue;
    if (Array.isArray(value)) {
      const wasArray = Array.isArray(before);
      const m = mergeArray(wasArray ? before : [], value, field, 1);
      if (wasArray && !m.changed) continue;
      const prev = wasArray && Object.hasOwn(opts.appended, field) ? opts.appended[field]! : [];
      write(field, m.items, provenance(m, prev, wasArray ? before.length : 0, opts.on));
      continue;
    }
    const merged = mergeValue(before, value, field, 1);
    if (merged === before) continue;
    write(field, merged, undefined);
  }
  return { data, appended, changed: data !== old };
}
