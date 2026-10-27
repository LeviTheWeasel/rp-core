// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Compendium records as the fold produces them (ARCHITECTURE.md §5.8, rev. 6). M3 holds only the
// human notes (type null, origin session); typed entries, arcs, summaries, library overlays and the
// lane arrive in M5a/M5b. The shapes are the final ones so M5 adds behaviour, not fields.
// CONTRACT FILE (M3): the types are fixed by the architect.

export type { MemEntry, MemOp } from '../../session/entries.ts';

/** §5.8: the 11 entry types of Bunraku and RoleCall, in the order of the tree's buckets. */
export const ENTRY_TYPES = [
  'character',
  'location',
  'item',
  'power',
  'organization',
  'event',
  'plot',
  'threat',
  'worldbuilding',
  'summary',
  'creature',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export type Rec = Record<string, unknown>;

/** One record of the fold (§5.8 CEntry). */
export interface CEntry {
  /** Stable key: 'note:<normalizeName(title at creation)>' (+ '#2', '#3' on collision) for a note. */
  key: string;
  /** null: a human note (or a classic library entry, M5a). */
  type: EntryType | null;
  /** A note's current title. */
  name: string;
  aliases: string[];
  /** A note: '' (its content is the text). Typed entries: derived (M5a). */
  tagline: string;
  data: Rec;
  /** Lore keys: only notes have them (matched by stems, §5.8). */
  keys: string[];
  /** Notes only: the note's text. */
  content?: string;
  origin: { kind: 'session' } | { kind: 'library'; book: string; id: string; overlay: boolean };
  retired?: { reason: string };
  featured?: boolean;
  order?: number;
  range?: [string, string];
  arc?: string;
  prov: {
    /** `on` of the row that created it; null for a human row or a library entry. */
    created: string | null;
    /** seq of the last row that changed it. */
    lastSeq: number;
    appended: Record<string, (string | null)[]>;
    /** M3: seq of the row that created it (the REPL's C<n> numbering follows it). */
    createdSeq: number;
  };
}

/** One operation the fold could not apply, and why (for /memory and the trace). */
export interface FoldIssue {
  seq: number;
  /** Index of the op inside its row. */
  op: number;
  /** e.g. 'not_until_m5' (file/arc/revert in M3), 'not_found' (a ref with no live target), 'invalid'. */
  why: string;
}

export interface CompendiumView {
  /** Live and retired entries by key, in creation order (Map insertion order). */
  entries: ReadonlyMap<string, CEntry>;
  /** Hash of the applied rows (and, from M5a, of the readable books): for the trace. '' when empty. */
  rev: string;
  /** seq of the newest row folded in; 0 when none. */
  lastSeq: number;
  issues: FoldIssue[];
}

export const EMPTY_COMPENDIUM: CompendiumView = { entries: new Map(), rev: '', lastSeq: 0, issues: [] };
