// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Short handles for records the tools show (ARCHITECTURE.md §9.2, D-59 as amended in M3 decisions
// K and by .notes/m5a-decisions.md D-150): models garble long ids, so search_lore shows 'L12' for a
// lore entry and 'C3' for a Compendium entry, and read_lore maps them back.
// - L<n>: per turn, from 1 in order of first appearance; a turn has one table, so a handle means the
//   same entry in every round of that turn.
// - C<n>: the entry's handle in the view's one numbering (agents/compendium/refs.ts entryRefs: the
//   library seed first, then session entries in creation order; retired entries keep their numbers),
//   once the table is bound to the turn's Compendium (constructor or bindNotes). `/memory`, the tools
//   and the Compendium block's brief tail print the same C<n>; every entry of the view resolves,
//   listed this turn or not. A key the bound view does not hold (or any key, unbound) is numbered
//   after the view's entries in order of first appearance.
// CONTRACT FILE (M3): signatures are fixed; the tools-run agent implements the bodies.
//
// The idea (no code) is Bunraku's `e<n>` entry handles (studio/dramaturg-tools.ts) and RoleCall's
// toReadableId; both found that models copy short handles back intact and long ids not.

import { entryRefs } from '../agents/compendium/refs.ts';
import type { CompendiumView } from '../agents/compendium/types.ts';

export type HandleTarget = { kind: 'lore'; book: string; id: string } | { kind: 'compendium'; key: string };

/** Map key of a target: kind, then its ids, NUL-separated (ids never hold NUL). */
const keyOf = (t: HandleTarget): string => (t.kind === 'lore' ? `L\u0000${t.book}\u0000${t.id}` : `C\u0000${t.key}`);

/** Characters a model wraps a handle in: quotes, brackets, '#', and whitespace. */
const WRAP = /^[\s"'`«»“”„‘’()[\]{}<>#]+|[\s"'`«»“”„‘’()[\]{}<>#.,;:]+$/g;
const HANDLE = /^([LC])0*(\d+)$/;
/** A Cyrillic С / с written for the Latin C (a mixed-script slip in Russian chats): no Cyrillic prefix is valid, so it is safe to read. */
const CYRILLIC_C = /^[Сс]/;
/** Longer than this after NFKC is not a handle (and never reaches the regex). */
const HANDLE_MAX = 32;

/**
 * True when `s` is written like a handle, known or not: L<n> or C<n> as resolve() reads it (NFKC,
 * wrapping quotes and brackets, a Cyrillic С for C, any case). read_lore uses it to tell the handles
 * in one string ('L1, L2', 'L1 (Замок)') from the words around them.
 */
export function handleShaped(s: string): boolean {
  if (typeof s !== 'string') return false;
  const folded = s.normalize('NFKC');
  return folded.length <= HANDLE_MAX && HANDLE.test(folded.replace(WRAP, '').replace(CYRILLIC_C, 'C').toUpperCase());
}

export class HandleTable {
  private readonly byTarget = new Map<string, string>();
  private readonly byHandle = new Map<string, HandleTarget>();
  private lore = 0;
  private compendium = 0;
  /** The Compendium the C numbers come from (D-150); undefined until bound. */
  private bound: CompendiumView | undefined;
  /** Entries in the bound view: C1..C<size> are theirs; keys outside it come after. */
  private size = 0;

  /** A table for one turn; with `notes`, bound to that Compendium at once (see bindNotes). */
  constructor(notes?: CompendiumView) {
    if (notes !== undefined) this.bindNotes(notes);
  }

  /**
   * D-150: number the Compendium as /memory does. Every entry of `view` (notes, typed entries, arcs,
   * library entries; live and retired) gets its entryRefs handle C<n>, so a lookup line's C12, the
   * block's `(more: read_lore C12)` and `/memory show C12` are the same entry, across turns too, and
   * read_lore resolves C<n> before any search listed it. Binding the same view again does nothing;
   * another view replaces every C handle (L handles stay). The name is M3's (it bound notes only).
   */
  bindNotes(view: CompendiumView): void {
    if (this.bound === view) return;
    this.bound = view;
    for (const [handle, target] of [...this.byHandle]) {
      if (target.kind !== 'compendium') continue;
      this.byHandle.delete(handle);
      this.byTarget.delete(keyOf(target));
    }
    this.compendium = 0;
    const refs = view.entries === undefined ? [] : entryRefs(view);
    this.size = refs.length;
    for (const { ref, entry } of refs) {
      const target: HandleTarget = { kind: 'compendium', key: entry.key };
      this.byTarget.set(keyOf(target), ref);
      this.byHandle.set(ref, target);
    }
  }

  /** The handle of a target, issuing the next number on first sight (an entry of the bound view already has its own). */
  handleFor(target: HandleTarget): string {
    const key = keyOf(target);
    const known = this.byTarget.get(key);
    if (known !== undefined) return known;
    const handle = target.kind === 'lore' ? `L${++this.lore}` : `C${this.size + ++this.compendium}`;
    this.byTarget.set(key, handle);
    this.byHandle.set(handle, target.kind === 'lore' ? { kind: 'lore', book: target.book, id: target.id } : { kind: 'compendium', key: target.key });
    return handle;
  }

  /**
   * What a handle names; undefined when unknown. Read loosely: NFKC first (a full-width Ｌ１ is L1),
   * surrounding whitespace, quotes and brackets ignored, case-insensitive, and a leading Cyrillic
   * С / с read as C. Any other non-Latin letter is not a handle ('Л1' stays unknown).
   */
  resolve(handle: string): HandleTarget | undefined {
    if (typeof handle !== 'string') return undefined;
    const folded = handle.normalize('NFKC');
    if (folded.length > HANDLE_MAX) return undefined;
    const m = HANDLE.exec(folded.replace(WRAP, '').replace(CYRILLIC_C, 'C').toUpperCase());
    if (m === null) return undefined;
    const target = this.byHandle.get(`${m[1]}${m[2]}`);
    return target === undefined ? undefined : { ...target };
  }
}
