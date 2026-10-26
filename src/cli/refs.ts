// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What `/preset <x>`, `/lore add <x>`, `new --preset <x>` and `new --lore <x>` accept (ARCHITECTURE.md
// §12.4, D-72): a file, imported into the library first (importFile with `expect`, so a card given
// to /preset is refused before anything is written), or the id of something already in the library
// ('builtin' for the built-in preset). An existing regular file wins over a library id of the same
// spelling, as with `new --card`. Whatever is chosen must load and validate here, so a session is
// never pointed at something the next turn would refuse.
// Also the descriptions /lore and /trace print: entry counts and entry titles.

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { importFile, ImportError, type ImportedKind } from '../formats/import.ts';
import { listLibrary, loadFromLibrary, type LibraryKind } from '../formats/library.ts';
import {
  BUILTIN_PRESET,
  validateLoreBook,
  validatePreset,
  type Character,
  type ImportWarning,
  type LoreBook,
  type Persona,
  type Preset,
  type Validation,
} from '../formats/native.ts';
import { CARD_BOOK_KEY, entryLabel, PERSONA_BOOK_KEY } from '../lore/engine.ts';
import { shadowedCastBooks, shadowedSessionBooks } from '../prompt/assemble/lore.ts';

/** A ref that cannot be used: one line for the user, nothing was configured. */
export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

/** A resolved ref: the library id to put in the session config, the value, and the import if a file was given. */
export interface Resolved<T> {
  id: string;
  value: T;
  imported?: { file: string; path: string; warnings: ImportWarning[] };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `~/x` → `<HOME>/x` (the REPL has no shell to do it); anything else as typed. */
export function expandHome(ref: string, env: Record<string, string | undefined>): string {
  const home = env.HOME;
  if (!home) return ref;
  if (ref === '~') return home;
  return ref.startsWith('~/') ? `${home}${ref.slice(1)}` : ref;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** It was meant as a path (a separator or a file extension), not as a library id. */
const looksLikePath = (ref: string): boolean => /[/\\]/.test(ref) || /\.(json|png|jsonl)$/i.test(ref);

const WHAT: Record<'preset' | 'lorebook', { dir: LibraryKind; label: string }> = {
  preset: { dir: 'presets', label: 'preset' },
  lorebook: { dir: 'lorebooks', label: 'lorebook' },
};

function firstError<T>(v: Validation<T>): string {
  if (v.ok) return '';
  const e = v.errors[0];
  return `${e?.path || '(root)'}: ${e?.message ?? 'invalid'}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ''}`;
}

function resolveRef<T>(
  home: string,
  ref: string,
  kind: 'preset' | 'lorebook',
  validate: (v: unknown) => Validation<T>,
  env: Record<string, string | undefined>,
): Resolved<T> {
  const { dir, label } = WHAT[kind];
  const typed = ref.trim();
  if (typed === '') throw new RefError(`which ${label}? give a library id or a file`);
  const file = expandHome(typed, env);
  if (isFile(file)) {
    let r;
    try {
      r = importFile(home, resolve(file), { expect: kind as ImportedKind });
    } catch (e) {
      if (e instanceof ImportError) throw new RefError(`cannot import ${typed}: ${e.message}`);
      throw e;
    }
    // importFile self-checks what it saves; validating again catches nothing new but keeps one path.
    const v = validate(r.value);
    if (!v.ok) throw new RefError(`${typed} imported as ${label} ${r.id}, but it is invalid (${firstError(v)})`);
    return { id: r.id, value: v.value, imported: { file: typed, path: r.path, warnings: r.warnings } };
  }
  if (looksLikePath(typed)) throw new RefError(`no such file: ${typed}`);
  let raw: unknown = null;
  try {
    raw = loadFromLibrary(home, dir, typed);
  } catch (e) {
    // An id that could never name a library file is just "not found".
    if (!errText(e).startsWith('invalid library id')) throw new RefError(`library ${label} ${typed} cannot be read: ${errText(e)}`);
  }
  if (raw === null) {
    const known = listLibrary(home, dir).map((r) => r.id);
    // A library file named builtin (saved before the id was reserved) is not reachable by that id.
    const extra = kind === 'preset' ? ['builtin', ...known.filter((id) => id !== 'builtin')] : known;
    throw new RefError(
      `no file and no library ${label} named ${JSON.stringify(typed)}${extra.length > 0 ? ` (the library has: ${extra.join(', ')})` : ` (the library has no ${label}s yet)`}`,
    );
  }
  const v = validate(raw);
  if (!v.ok) throw new RefError(`library ${label} ${typed} is invalid (${firstError(v)})`);
  return { id: typed, value: v.value };
}

/** A preset ref: 'builtin', a library id or an ST chat-completion preset file. */
export function resolvePresetRef(home: string, ref: string, env: Record<string, string | undefined> = {}): Resolved<Preset> {
  if (ref.trim() === 'builtin') return { id: 'builtin', value: BUILTIN_PRESET };
  return resolveRef(home, ref, 'preset', validatePreset, env);
}

/** A lorebook ref: a library id, or a world info / character_book file (a card gives its embedded book). */
export function resolveLoreRef(home: string, ref: string, env: Record<string, string | undefined> = {}): Resolved<LoreBook> {
  return resolveRef(home, ref, 'lorebook', validateLoreBook, env);
}

// ---- descriptions ---------------------------------------------------------------------------------

/** One book as /lore lists it. `problem` replaces the counts when it cannot be loaded. */
export interface BookRow {
  key: string;
  /** 'persona' / 'card' for the cast's own books, else a session book. */
  owner: 'persona' | 'card' | 'session';
  name?: string;
  entries?: number;
  disabled?: number;
  problem?: string;
  /** A book not read because this book has its name (SillyTavern loads a world once): the card's or persona's own book, or an earlier session book. */
  shadowedBy?: string;
}

function bookRow(key: string, owner: BookRow['owner'], book: LoreBook): BookRow {
  const disabled = book.entries.filter((e) => e.enabled === false).length;
  return { key, owner, name: book.name, entries: book.entries.length, disabled };
}

/** A session book from the library, or why it cannot be used. */
export function loadSessionBook(home: string, id: string): { ok: true; book: LoreBook } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = loadFromLibrary(home, 'lorebooks', id);
  } catch (e) {
    return { ok: false, problem: `cannot be read: ${errText(e)}` };
  }
  if (raw === null) return { ok: false, problem: 'missing from the library' };
  const v = validateLoreBook(raw);
  return v.ok ? { ok: true, book: v.value } : { ok: false, problem: `invalid: ${firstError(v)}` };
}

/**
 * A session's lorebook ids with `id` added, reading a world once by name (SillyTavern: a world's name
 * is its identity, re-importing it replaces it): when a book already listed has the same trimmed,
 * non-empty name, `id` takes its place. `replaced` names the id it took the place of. Books that
 * cannot be loaded are not compared.
 */
export function addLoreId(home: string, ids: readonly string[], id: string, name: string): { ids: string[]; replaced?: string } {
  if (ids.includes(id)) return { ids: [...ids] };
  const n = name.trim();
  const at = n === '' ? -1 : ids.findIndex((other) => {
    const b = loadSessionBook(home, other);
    return b.ok && b.book.name.trim() === n;
  });
  if (at < 0) return { ids: [...ids, id] };
  const out = [...ids];
  const replaced = out[at] as string;
  out[at] = id;
  return { ids: out, replaced };
}

/** Every book a turn scans, in ST order: the persona's, the card's, then the session's (config order). */
export function bookRows(home: string, cast: { character: Character; persona?: Persona }, lorebooks: readonly string[]): BookRow[] {
  const session = lorebooks.map((id) => ({ id, loaded: loadSessionBook(home, id) }));
  const loaded = session.flatMap((s) => (s.loaded.ok ? [{ key: s.id, book: s.loaded.book }] : []));
  const sessionShadow = shadowedSessionBooks(loaded);
  const shadow = shadowedCastBooks(
    cast,
    loaded.filter((s) => !sessionShadow.has(s.key)),
  );
  const own = (key: string, owner: 'persona' | 'card', book: LoreBook, by: string | undefined): BookRow =>
    by === undefined ? bookRow(key, owner, book) : { ...bookRow(key, owner, book), shadowedBy: by };
  const rows: BookRow[] = [];
  if (cast.persona?.book) rows.push(own(PERSONA_BOOK_KEY, 'persona', cast.persona.book, shadow.persona));
  if (cast.character.book) rows.push(own(CARD_BOOK_KEY, 'card', cast.character.book, shadow.card));
  for (const { id, loaded: b } of session) {
    const by = sessionShadow.get(id);
    const row: BookRow = b.ok ? bookRow(id, 'session', b.book) : { key: id, owner: 'session', problem: b.problem };
    rows.push(by === undefined ? row : { ...row, shadowedBy: by });
  }
  return rows;
}

/** entryLabel → entry title, over every book a turn scans (books that cannot be loaded are skipped). */
export function entryTitles(home: string, cast: { character: Character; persona?: Persona }, lorebooks: readonly string[]): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (key: string, book: LoreBook): void => {
    for (const e of book.entries) if (e.title?.trim()) titles.set(entryLabel(key, e.id), e.title.trim());
  };
  if (cast.persona?.book) add(PERSONA_BOOK_KEY, cast.persona.book);
  if (cast.character.book) add(CARD_BOOK_KEY, cast.character.book);
  for (const id of lorebooks) {
    const b = loadSessionBook(home, id);
    if (b.ok) add(id, b.book);
  }
  return titles;
}
