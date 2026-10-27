// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Human notes as a lore book (ARCHITECTURE.md §5.8 "Заметки", M3): the fold's live notes become one
// book the lore engine reads like any other, matched by word stems, placed at depth 4 with the
// source 'compendium' (§10.1 rank) and the wrapper '[Memory: title]'. Notes count against the lore
// budget. Typed Compendium entries never become lore (§7.4.1, D-76). M5a: a note's handle is its place
// in the view's one numbering (refs.ts, D-150), the same in /memory, the tools and the block.
// CONTRACT FILE (M3): signatures are fixed; the memory agent implements the bodies.

import type { LoreBook, LoreEntry } from '../../formats/native.ts';
import { handleNumber, normalizeName } from './apply.ts';
import { entryRefs } from './refs.ts';
import type { CEntry, CompendiumView } from './types.ts';

/** The lore source key of the notes book. The engine gathers it after the card's book, before the session books. */
export const NOTES_BOOK_KEY = '@notes';
export const NOTES_BOOK_NAME = 'Заметки';
/** §5.8: notes are inserted at depth 4 (role system) and scan the last 4 messages. */
export const NOTES_DEPTH = 4;
export const NOTES_SCAN_DEPTH = 4;
/** Every note entry's `order` (they are equal: creation order breaks ties). */
export const NOTES_ORDER = 100;

/** A human note: no type, made in the session, not an arc overview (D-145), its text in `content`. */
export function isNote(e: CEntry): boolean {
  return e.type === null && e.origin.kind === 'session' && e.arc === undefined && typeof e.content === 'string';
}

/** The text a fired note sends: '[Memory: <title>]' on its own line, then the note. */
export function noteText(title: string, content: string): string {
  return `[Memory: ${title}]\n${content}`;
}

/** A note's lore keys: its keys without blank ones, else its title. */
function loreKeys(e: CEntry): string[] {
  const keys = e.keys.filter((k) => k.trim() !== '');
  return keys.length > 0 ? keys : [e.name];
}

/**
 * The live (not retired) notes as a book, or null when there are none:
 * {name: NOTES_BOOK_NAME, scanDepth: NOTES_SCAN_DEPTH, match: 'stem', wholeWords: false,
 * recursive: false, entries}. One entry per note in creation order: id = the note's key, title =
 * its name, keys = its keys (a note without keys is keyed by its title), content = noteText(name,
 * content), position {depth: NOTES_DEPTH, role: 'system'}, order 100.
 */
export function notesBook(view: CompendiumView): LoreBook | null {
  const entries: LoreEntry[] = [];
  for (const e of view.entries.values()) {
    if (!isNote(e) || e.retired) continue;
    entries.push({
      id: e.key,
      title: e.name,
      keys: loreKeys(e),
      content: noteText(e.name, e.content ?? ''),
      position: { depth: NOTES_DEPTH, role: 'system' },
      order: NOTES_ORDER,
    });
  }
  if (entries.length === 0) return null;
  return { name: NOTES_BOOK_NAME, scanDepth: NOTES_SCAN_DEPTH, match: 'stem', wholeWords: false, recursive: false, entries };
}

/** The notes of a view in creation order (live and retired), each with its handle C<n> (entryRefs numbering, D-150). */
export function noteRefs(view: CompendiumView): { ref: string; entry: CEntry }[] {
  return entryRefs(view).filter((r) => isNote(r.entry));
}

/**
 * Resolve what a user typed, among the notes only: 'C<n>' / 'c<n>' (entryRefs numbering; a handle of
 * another kind of entry → undefined), an exact key ('note:…'), or a title (normalizeName equal to
 * exactly one note's name). undefined when nothing or several match. A title is looked up among the
 * notes in the `prefer`red state first (live by default; restore asks for retired ones), then among
 * the others, so a retired 'Брат' never makes the live 'Брат' ambiguous. A handle wins over a note
 * titled like one ('C2').
 */
export function resolveNoteRef(view: CompendiumView, ref: string, prefer: 'live' | 'retired' = 'live'): CEntry | undefined {
  const typed = ref.trim();
  const n = handleNumber(typed);
  if (n !== null) {
    const hit = n >= 1 ? entryRefs(view)[n - 1]?.entry : undefined;
    return hit !== undefined && isNote(hit) ? hit : undefined;
  }
  const byKey = view.entries.get(typed);
  if (byKey && isNote(byKey)) return byKey;
  const name = normalizeName(typed);
  if (name === '') return undefined;
  const same = noteRefs(view)
    .map((r) => r.entry)
    .filter((e) => normalizeName(e.name) === name);
  const wanted = same.filter((e) => (e.retired !== undefined) === (prefer === 'retired'));
  const pool = wanted.length > 0 ? wanted : same;
  return pool.length === 1 ? pool[0] : undefined;
}
