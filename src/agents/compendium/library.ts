// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Library books in the Compendium (.notes/m5a-decisions.md D-141, D-142). A "book" is a library
// lorebook of SessionConfig.lorebooks, keyed by its library id (LoreSource.key); its access is
// `compendium.books.<id>`: 'read' (default) or 'off'. The card's, the persona's and the notes' books
// ('@'-keyed) are never seeded or routed. Pure.
// - librarySeed: the typed entries of readable books become CEntries the fold starts from; so do
//   their [Arc] overviews (M5b, .notes/m5b-decisions.md D-177: arc entries the {{recap}} slot reads).
// - routeBooks: those entries leave the lore engine's sources (the Compendium block and the slot
//   show them).
// The reading rule (a type only when it is one of the eleven, else plain lore) is Bunraku's
// src/core/compendium/read.ts:40-54, re-derived for LoreEntry.meta; a typed entry also needs data.
// A seeded entry keeps its non-regex lore keys and its secondary keys with their logic (selector
// triggers, mention.ts).

import { createHash } from 'node:crypto';
import type { LoreEntry } from '../../formats/native.ts';
import { DEFAULT_LORE_ORDER, type LoreSource } from '../../lore/engine.ts';
import type { CompendiumConfig } from '../../session/entries.ts';
import { normalizeName } from './apply.ts';
import { deriveTagline, isBlank, isEntryType } from './entry-types.ts';
import { EMPTY_SEED, type CEntry, type EntryType, type LibrarySeed, type Rec } from './types.ts';

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonBlank = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
/** A lore key in the '/re/flags' form (never a selector trigger). */
const isRegexKey = (k: string): boolean => /^\/.+\/[a-z]*$/s.test(k.trim());
const LOGICS: ReadonlySet<string> = new Set(['and_any', 'and_all', 'not_any', 'not_all']);

/**
 * Data with something in it at any depth (section I): a value that is not blank (undefined, null,
 * whitespace); a list or an object counts only through its items. Iterative, so data nested
 * thousands of levels deep never overflows the stack; a shared object is looked at once.
 */
function filled(v: unknown): boolean {
  const stack: unknown[] = [v];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const x = stack.pop();
    if (isBlank(x)) continue;
    if (typeof x !== 'object') return true;
    if (seen.has(x as object)) continue;
    seen.add(x as object);
    for (const item of Array.isArray(x) ? x : Object.values(x as Rec)) stack.push(item);
  }
  return false;
}

/**
 * A Compendium entry (D-141 and the lead's rulings after the review and the final check): meta.type is
 * one of the eleven entry types, it is not an [Arc] overview, and meta.data is an object with at least
 * one non-blank value at any depth (a list of blank strings or an object of blank values is blank).
 * Without data an entry stays plain lore: its text is all it has (the Compendium would render nothing).
 */
export function isCompendiumEntry(e: LoreEntry): boolean {
  const meta = e.meta;
  return isEntryType(meta?.type) && meta?.arc === undefined && isRec(meta?.data) && filled(meta.data);
}

/**
 * D-177: an [Arc] overview of a book — `meta.arc` names its plot (letters or digits in it) and the entry
 * has a text, the overview (a session arc needs both too, D-145). Typed or not: `meta.arc` wins. A blank
 * plot or a blank text stays plain lore (and is not a classic name either, as in M5a).
 */
export function isLibraryArc(e: LoreEntry): boolean {
  const arc = e.meta?.arc;
  return typeof arc === 'string' && normalizeName(arc) !== '' && typeof e.content === 'string' && e.content.trim() !== '';
}

/** What the Compendium holds of a readable book: its typed entries and its [Arc] overviews. */
const held = (e: LoreEntry): boolean => isCompendiumEntry(e) || isLibraryArc(e);

/** A book's access by its library id: 'off' only when the config says so. */
export function bookAccess(cfg: CompendiumConfig, libraryId: string): 'read' | 'off' {
  const books = cfg.books;
  return isRec(books) && Object.hasOwn(books, libraryId) && books[libraryId] === 'off' ? 'off' : 'read';
}

/** The library books the Compendium reads: not '@'-keyed, not 'off'; none when Compendium is disabled. */
const readable = (src: LoreSource, cfg: CompendiumConfig): boolean => cfg.enabled !== false && !src.key.startsWith('@') && bookAccess(cfg, src.key) === 'read';

/** One typed library entry as the fold's seed (D-141). */
function seedEntry(libraryId: string, e: LoreEntry): CEntry {
  const meta = e.meta!;
  const type = meta.type as EntryType;
  const data = isRec(meta.data) ? meta.data : {};
  const name = nonBlank(data.name) ?? nonBlank(data.title) ?? nonBlank(data.topic) ?? nonBlank(e.title) ?? e.id;
  const aliasSource = Array.isArray(meta.aliases) ? meta.aliases : Array.isArray(data.aliases) ? data.aliases : [];
  const seen = new Set([normalizeName(name)]);
  const aliases: string[] = [];
  for (const a of aliasSource) {
    if (typeof a !== 'string') continue;
    const n = normalizeName(a);
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    aliases.push(a.trim());
  }
  const entry: CEntry = {
    key: `lib:${libraryId}:${e.id}`,
    type,
    name,
    aliases,
    tagline: deriveTagline(type, data),
    data,
    keys: (Array.isArray(e.keys) ? e.keys : []).filter((k) => typeof k === 'string' && k.trim() !== '' && !isRegexKey(k)),
    origin: { kind: 'library', book: libraryId, id: e.id, overlay: false },
    order: typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : DEFAULT_LORE_ORDER,
    prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
  };
  if (meta.featured === true) entry.featured = true;
  if (e.constant === true) entry.constant = true;
  // Section I: the selector honours a lore key's secondary keys and logic as the lore engine does.
  const secondary = (Array.isArray(e.secondary) ? e.secondary : []).filter((k): k is string => typeof k === 'string' && k.trim() !== '');
  if (secondary.length > 0) {
    entry.secondary = secondary;
    if (typeof e.logic === 'string' && LOGICS.has(e.logic)) entry.logic = e.logic;
  }
  return entry;
}

/**
 * One [Arc] overview as the fold's seed (D-177): an arc CEntry like a session arc's (D-145) with a
 * library origin — no type, name and arc = the plot (meta.arc, trimmed), content = the entry's text,
 * no data, no keys (an arc is never a selector candidate), the lore order kept.
 */
function seedArc(libraryId: string, e: LoreEntry): CEntry {
  const plot = (e.meta!.arc as string).trim();
  const entry: CEntry = {
    key: `lib:${libraryId}:${e.id}`,
    type: null,
    name: plot,
    aliases: [],
    tagline: '',
    data: {},
    keys: [],
    content: e.content,
    arc: plot,
    origin: { kind: 'library', book: libraryId, id: e.id, overlay: false },
    order: typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : DEFAULT_LORE_ORDER,
    prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
  };
  if (e.meta?.featured === true) entry.featured = true;
  return entry;
}

/**
 * The fold's library seed (D-141) from the session's books AFTER the "read once by name" shadowing,
 * in config order. Seeded: enabled Compendium entries and [Arc] overviews (D-177) of readable books,
 * in (config, book) order, keyed 'lib:<libraryId>:<entryId>' (a repeated key keeps the first).
 * `classic`: normalizeName(title) → key of each enabled untyped entry without meta.arc that has a
 * title (the first one wins). `books`: id → name
 * of every readable book. `hash`: sha256 over (id, entries JSON) of the readable books, 16 hex; ''
 * when there is none. Compendium disabled → EMPTY_SEED.
 */
export function librarySeed(sources: readonly LoreSource[], cfg: CompendiumConfig): LibrarySeed {
  if (cfg.enabled === false) return EMPTY_SEED;
  const entries: CEntry[] = [];
  const keys = new Set<string>();
  const classic = new Map<string, string>();
  const books = new Map<string, string>();
  const hash = createHash('sha256');
  for (const src of sources) {
    if (!readable(src, cfg)) continue;
    books.set(src.key, src.book.name);
    hash.update(`${src.key}\u0000${JSON.stringify(src.book.entries)}\n`);
    for (const e of src.book.entries) {
      if (e.enabled === false) continue;
      const key = `lib:${src.key}:${e.id}`;
      if (held(e)) {
        if (keys.has(key)) continue;
        keys.add(key);
        entries.push(isLibraryArc(e) ? seedArc(src.key, e) : seedEntry(src.key, e));
      } else if (e.meta?.arc === undefined && typeof e.title === 'string') {
        const n = normalizeName(e.title);
        if (n !== '' && !classic.has(n)) classic.set(n, key);
      }
    }
  }
  if (books.size === 0) return EMPTY_SEED;
  return { entries, classic, books, hash: hash.digest('hex').slice(0, 16) };
}

/**
 * The lore sources with the Compendium entries of readable books removed (D-142): they reach the
 * prompt through the Compendium block instead, and their [Arc] overviews through the {{recap}} slot
 * (D-177). Disabled ones go too. '@'-keyed sources, 'off' books and a disabled Compendium keep
 * everything; routing removes entries, never books. The same array (and the same source objects)
 * when nothing is removed.
 */
export function routeBooks(sources: readonly LoreSource[], cfg: CompendiumConfig): LoreSource[] {
  let out: LoreSource[] | undefined;
  sources.forEach((src, i) => {
    if (!readable(src, cfg) || !src.book.entries.some(held)) return;
    out ??= sources.slice();
    out[i] = { ...src, book: { ...src.book, entries: src.book.entries.filter((e) => !held(e)) } };
  });
  return out ?? (sources as LoreSource[]);
}
