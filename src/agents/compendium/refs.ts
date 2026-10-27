// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Handles of Compendium entries (.notes/m5a-decisions.md D-150, amends D-59). One numbering over the
// whole view: the i-th entry of `view.entries` in Map order is C<i+1>. The fold inserts the library
// seed first (config order, book order), then session entries in creation order, and never removes
// an entry (retired ones keep their numbers), so:
// - without a typed book, M3 note numbers are unchanged;
// - attaching a book shifts session handles by its entry count; a session entry never shifts a library
//   handle; path-bound rows can shift later session handles after a rewind.
// `/memory`, the lore tools and the block's brief tail all print these.

import { resolveRefIn } from './apply.ts';
import type { CEntry, CompendiumView } from './types.ts';

/** Every entry of the view with its handle C<n>, in Map order (live and retired). */
export function entryRefs(view: CompendiumView): { ref: string; entry: CEntry }[] {
  const out: { ref: string; entry: CEntry }[] = [];
  for (const entry of view.entries.values()) out.push({ ref: `C${out.length + 1}`, entry });
  return out;
}

/** The handle of the entry with this key, or null when the view has none. */
export function refOf(view: CompendiumView, key: string): string | null {
  let i = 0;
  for (const k of view.entries.keys()) {
    i++;
    if (k === key) return `C${i}`;
  }
  return null;
}

/**
 * What a user or a hand-written row typed: C<n> / c<n> (also with the Cyrillic С/с), an exact key, or a
 * name, alias or former name (normalizeName) that exactly one entry answers to — the `prefer`red pool
 * first (live by default; restore asks for retired ones), then the other. A handle wins over an entry
 * named like one. null when nothing or several match.
 */
export function resolveEntryRef(view: CompendiumView, ref: string, prefer: 'live' | 'retired' = 'live'): CEntry | null {
  return resolveRefIn(view.entries, ref, prefer);
}
