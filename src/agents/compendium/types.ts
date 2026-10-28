// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Compendium records as the fold produces them (ARCHITECTURE.md §5.8). M3 held only the human notes;
// M5a adds typed entries, arcs, summaries, library seeds and overlays (.notes/m5a-decisions.md
// D-140…D-167). The type tables (SPEC, REQUIRED_FIELDS, LITE_FIELDS…) are in entry-types.ts.
// CONTRACT FILE (M3, extended in M5a): the types are fixed by the architect.

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
  /**
   * Stable key, never changed by a rename (D-143…D-146): 'note:<name>' a note, '<type>:<name>' a typed
   * session entry, 'summary:<toId>.<i>' an agent summary, 'summary:user:<title>' a hand-filed one (D-168), 'arc:<plot>' an arc,
   * 'lib:<libraryId>:<entryId>' a library entry and its overlay. <name> = normalizeName at creation;
   * '#2', '#3' on collision (a retired entry's key counts as taken).
   */
  key: string;
  /** null: a human note or an arc overview (arc set). */
  type: EntryType | null;
  /** Current display name: a note's title, a typed entry's identity value, an arc's plot. */
  name: string;
  aliases: string[];
  /** A note: ''. Typed entries: explicit data.tagline, else derived from the description (D-151). */
  tagline: string;
  data: Rec;
  /** Lore keys: a note's keys; a library entry's non-regex lore keys (selector triggers, D-153). */
  keys: string[];
  /** A note's text; an arc's overview. */
  content?: string;
  origin: { kind: 'session' } | { kind: 'library'; book: string; id: string; overlay: boolean };
  retired?: { reason: string };
  featured?: boolean;
  /** A library entry's lore order (snapshot ties, search rank). */
  order?: number;
  /** M5a: a library entry marked constant in its book (selector tier 3, D-153). */
  constant?: true;
  /** M5a (section I): a library entry's secondary lore keys and their logic (selector key triggers). */
  secondary?: string[];
  logic?: 'and_any' | 'and_all' | 'not_any' | 'not_all';
  /** A summary written from a row with a range: that range (path message ids, inclusive). */
  range?: [string, string];
  /** An arc overview: its plot's name. */
  arc?: string;
  prov: {
    /** `on` of the row that created it; null for a human row or a library entry. */
    created: string | null;
    /** seq of the last row that changed it (0: a library entry no row touched). */
    lastSeq: number;
    /** Per top-level array field of data, parallel to its elements: the `on` that added or last changed each (D-149). */
    appended: Record<string, (string | null)[]>;
    /** seq of the row that created it (0 for a library entry). */
    createdSeq: number;
    /** M5a (D-146): names the entry had before a rename; findMatch still knows them. */
    formerNames?: string[];
  };
}

/** Why the fold could not apply an op (D-143…D-147). */
export type FoldWhy =
  | 'not_found'
  | 'invalid'
  | 'unknown_op'
  | 'unknown_type'
  | 'missing_required'
  | 'classic_conflict'
  | 'library_entry_missing'
  /** Not a failure: the entry's data reached 12 000 JSON chars with this op (notice once per key, D-144). */
  | 'large_entry';

/** One operation the fold could not apply (or flags), and why (for /memory, the verbs' dry run and the trace). */
export interface FoldIssue {
  seq: number;
  /** Index of the op inside its row. */
  op: number;
  why: FoldWhy | string;
  /** The entry key concerned, when there is one. */
  key?: string;
}

/** D-143: what became of one task key's rows on this path (M5b's coverage and watermark read it). */
export interface TaskState {
  /** seq of the effective action: the applied row, the revert row, or the newest stale/superseded row. */
  seq: number;
  status: 'applied' | 'reverted' | 'stale' | 'superseded';
  /** M5b (D-179): a reverted key whose reverted row is stale (staleness re-writes even after undo, D-74). */
  stale?: true;
  /** The range of the row the status is about (for a reverted key: the reverted row's). */
  range?: [string, string];
}

/** D-143: one applied op's effect on one entry. */
export interface OpEffect {
  seq: number;
  op: number;
  key: string;
  change: 'created' | 'merged' | 'edited' | 'arc' | 'note' | 'retired' | 'restored';
}

export interface CompendiumView {
  /**
   * Live and retired entries by key. Map order is the handle order (D-150): the library seed first
   * (config order, book order), then session entries in creation order.
   */
  entries: ReadonlyMap<string, CEntry>;
  /** Hash of the applied rows and of the library seed: for the trace. '' when both are empty. */
  rev: string;
  /** seq of the newest row folded in; 0 when none. */
  lastSeq: number;
  issues: FoldIssue[];
  /** M5a: per task key (agent rows) on this path. Empty without agent rows. */
  tasks: ReadonlyMap<string, TaskState>;
  /** M5a: per applied op, in seq order. */
  effects: OpEffect[];
}

export const EMPTY_COMPENDIUM: CompendiumView = {
  entries: new Map(),
  rev: '',
  lastSeq: 0,
  issues: [],
  tasks: new Map(),
  effects: [],
};

/** D-141: the readable books' Compendium entries, built by library.ts, folded in before the rows. */
export interface LibrarySeed {
  /** Seed entries in (config order, book order); keys 'lib:<libraryId>:<entryId>'. */
  entries: readonly CEntry[];
  /** normalizeName(title) → key of an enabled untyped entry of a readable book (classic_conflict). */
  classic: ReadonlyMap<string, string>;
  /** Library id → book name, of the seeded (readable) books, in config order. */
  books: ReadonlyMap<string, string>;
  /** sha256 of the seeded books (16 hex); '' when none. */
  hash: string;
}

export const EMPTY_SEED: LibrarySeed = { entries: [], classic: new Map(), books: new Map(), hash: '' };

/** D-153: one selector pick. */
export interface Pick {
  key: string;
  /** C<n> (D-150). */
  ref: string;
  tier: 0 | 1 | 2 | 3;
  via: 'mention' | 'model' | 'window' | 'constant';
}

/** D-155: one block candidate, texts rendered by the request builder. */
export interface BlockCandidate extends Pick {
  name: string;
  /** renderContent of the fresh copy; null when over the full limit or in the lite profile. */
  full: string | null;
  /** renderBrief of the fresh copy without a tail. */
  brief: string;
  /** e.g. '(more: read_lore C12)'; added on its own line after a brief when read_lore is offered. */
  briefTail: string;
}

export type CompendiumProfile = 'full' | 'lite';

export interface BlockLimits {
  maxEntries: number;
  /** A full render longer than this goes brief (0: always brief). */
  fullChars: number;
  briefChars: number;
  /** Cap on the whole block in tokens (Infinity: only the budget). */
  blockTok: number;
}

/** D-155: AssembleInput.compendium. */
export interface CompendiumBlockInput {
  rev: string;
  profile: CompendiumProfile;
  candidates: BlockCandidate[];
  limits: BlockLimits;
  /** Share of the lore budget kept for the block when there are candidates (0.4). */
  minShare: number;
  /** Keys already in the prompt (M5b: the {{recap}} slot). */
  inPrompt: ReadonlySet<string>;
  /** Entries hidden or elements dropped by freshness (for the trace). */
  hidden: number;
  /**
   * M5c (D-203): where tier 1 came from, for trace.compendium.source — the turn's RecallRecord source,
   * or 'lexical' / 'off' without one. Absent: 'lexical' (M5a's model-free selector).
   */
  source?: 'sync' | 'prefetch' | 'lexical' | 'reused' | 'off';
}
