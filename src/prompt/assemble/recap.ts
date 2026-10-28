// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The `{{recap}}` slot in a request (ARCHITECTURE.md §7.4.4, §10.2, §11; .notes/m5b-decisions.md D-177,
// D-178 and section G). agents/compendium/recap.ts chooses the slot's content for one cut; this file holds
// what the request around it needs: the input assemble takes (AssembleInput.recap), the slot's message,
// the previous request's trace.recap read back leniently, the books check that forces a fresh choice, and
// G's rule that a session arc replaces the library arc of the same plot. Pure.
// After the final check (the lead's ruling K): trace.recap records the profile and the share the slot was
// chosen under (a pin holds only under both), and G's second choice keeps the view's effects (the arcs'
// revisions are read from them, as in the first).

import { normalizeName } from '../../agents/compendium/apply.ts';
import { NOTES_BOOK_KEY } from '../../agents/compendium/notes.ts';
import { RECAP_SRC, recapSlot, type RecapInput, type RecapSlot, type RecapTrace } from '../../agents/compendium/recap.ts';
import type { CEntry, CompendiumProfile } from '../../agents/compendium/types.ts';
import type { PromptMsg } from '../../providers/types.ts';

/** D-178: AssembleInput.recap, present while the Compendium is on (request.ts). */
export interface RecapRequest {
  /** The previous request's trace.recap (request.ts previousRecap), or null: a fresh choice. */
  previous: RecapTrace | null;
  /**
   * The previous request's trace.loreHashes. When a book (the notes book aside) was added, removed or
   * changed since, `previous` is not used: the slot is chosen afresh, so a book attached mid-session
   * shows its arcs at once instead of when the cut next moves. Absent: not compared.
   */
  books?: Readonly<Record<string, string>>;
  /** compendiumProfile(cfg.profile, the narrator's window), as the block's. */
  profile: CompendiumProfile;
  /**
   * An arc's overview at an older revision (recap.ts arcRevisionText over the session's mem rows); `op`:
   * the index in that row of the op the fold applied to the arc, when the slot knows it (ruling K).
   */
  revisionText?: (key: string, rev: number, op?: number) => string | null;
}

/** The slot as one system message at the trim point of {{history}}: its text as chosen, no macro expansion. */
export const recapMsg = (text: string): PromptMsg => ({ role: 'system', blocks: [{ k: 'text', text }], src: RECAP_SRC, placement: 'inline' });

/** trace.recap of a request with no slot (and of every request before M5b). */
export const emptyRecapTrace = (): RecapTrace => ({ ids: [], arcs: [], boundary: null });

/** trace.recap of a request: what the slot holds and the profile and share it was chosen under, or the empty form. */
export const recapTraceOf = (slot: RecapSlot | null): RecapTrace =>
  slot === null
    ? emptyRecapTrace()
    : { ids: slot.ids, arcs: slot.arcs, boundary: slot.boundary, profile: slot.profile, ...(slot.share !== undefined ? { share: slot.share } : {}) };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * trace.recap as a journal holds it, read leniently (the journal checks only seed, now and lore fires):
 * ids a list of strings, arcs a list of {key: string, rev: finite number}, boundary a string or null.
 * null when it is not of that shape. Since ruling K also the optional profile ('full' | 'lite') and share
 * (a finite number); one of another shape makes the whole unreadable (null: the slot is chosen afresh).
 */
export function readRecapTrace(v: unknown): RecapTrace | null {
  if (!isRecord(v)) return null;
  const { ids, arcs, boundary, profile, share } = v;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(arcs)) return null;
  const read: RecapTrace['arcs'] = [];
  for (const a of arcs) {
    if (!isRecord(a) || typeof a.key !== 'string' || typeof a.rev !== 'number' || !Number.isFinite(a.rev)) return null;
    read.push({ key: a.key, rev: a.rev });
  }
  if (boundary !== null && typeof boundary !== 'string') return null;
  if (profile !== undefined && profile !== 'full' && profile !== 'lite') return null;
  if (share !== undefined && (typeof share !== 'number' || !Number.isFinite(share))) return null;
  return { ids: [...ids], arcs: read, boundary, ...(profile !== undefined ? { profile } : {}), ...(share !== undefined ? { share } : {}) };
}

/**
 * The books of two requests are the same for the slot: the same keys with the same hashes, the notes
 * book left out (a note is no arc). An unreadable record is never the same.
 */
export function sameBooks(was: unknown, now: Readonly<Record<string, string>>): boolean {
  if (!isRecord(was)) return false;
  const keys = (r: Readonly<Record<string, unknown>>): string[] => Object.keys(r).filter((k) => k !== NOTES_BOOK_KEY).sort();
  const a = keys(was);
  const b = keys(now);
  return a.length === b.length && a.every((k, i) => k === b[i] && was[k] === now[k]);
}

const isArcOf = (e: CEntry | undefined, kind: 'session' | 'library'): e is CEntry =>
  e !== undefined && e.retired === undefined && e.type === null && e.arc !== undefined && e.origin.kind === kind;

/**
 * Section G: the library arcs a slot must not show beside it — every live library arc whose plot
 * (normalizeName) is the plot of a session arc the slot holds.
 */
export function replacedLibraryArcs(entries: ReadonlyMap<string, CEntry>, arcs: readonly { key: string }[]): Set<string> {
  const plots = new Set<string>();
  for (const { key } of arcs) {
    const e = entries.get(key);
    if (isArcOf(e, 'session')) plots.add(normalizeName(e.arc!));
  }
  const out = new Set<string>();
  if (plots.size === 0) return out;
  for (const e of entries.values()) if (isArcOf(e, 'library') && plots.has(normalizeName(e.arc!))) out.add(e.key);
  return out;
}

/**
 * recapSlot with section G's rule: a session arc replaces the library arc of the same plot. When the
 * chosen slot holds a session arc and a library arc of one plot, it is chosen once more without the
 * library arcs of the plots its session arcs cover (session arcs are placed first, so the second
 * choice keeps them and only gains room). A library arc whose plot has a session arc that is not in
 * the slot (its summaries are still in view) still shows: the book's overview until the story's own
 * one takes its place.
 */
export function chooseRecap(input: RecapInput): RecapSlot | null {
  const slot = recapSlot(input);
  if (slot === null) return null;
  const entries = input.view.entries;
  const replaced = replacedLibraryArcs(entries, slot.arcs);
  if (![...replaced].some((key) => slot.keys.includes(key))) return slot;
  const kept = new Map<string, CEntry>();
  for (const [key, e] of entries) if (!replaced.has(key)) kept.set(key, e);
  // Ruling K: the view's effects stay (the arcs' revisions and pins are read from them).
  return recapSlot({ ...input, view: { ...input.view, entries: kept } });
}
