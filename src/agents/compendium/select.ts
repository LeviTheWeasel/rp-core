// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The model-free selector (ARCHITECTURE.md §7.4.1, .notes/m5a-decisions.md D-153): which live typed
// entries the block offers this turn, every turn, by name. Tiers: 0 named in the user's message (and
// in the guidance of a guided re-roll), 1 picked by recall (M5c), 2 named in the last
// WINDOW_MESSAGES visible messages before it, 3 a library entry marked constant. An opening has no
// user message: U is empty, so it gets tiers 2 and 3 (section H). An entry is picked once, at its
// best tier. Inside a tier: entries named like the card's character or the persona last (they are in
// the prompt anyway), then (tier 2) the newer message first, then the entry changed last, then handle
// order. M5c (.notes/m5c-decisions.md D-203, D-153 amended): tier 1 keeps recall's own ranking (the
// order of `recallPicks`), nothing else. Matching is mention.ts's (D-169 as narrowed in section I: a proper name's words in any order
// within one text, a phrase name or a lore key as a run, a key's secondary keys and logic honoured;
// U with the guidance is one text, each window message another). Pure.

import { normalizeName } from './apply.ts';
import { entryMatchers, mentioned, mentionText } from './mention.ts';
import type { CEntry, Pick } from './types.ts';

/** Tier 2 looks this many visible messages back from the user's message. */
export const WINDOW_MESSAGES = 4;

export interface SelectInput {
  /** Live typed entries of the view after freshness (fresh copies), in handle order. */
  entries: readonly CEntry[];
  /** C<n> of an entry key (refs.ts refOf over the same view). */
  refOf: (key: string) => string;
  /** The user's message U, without a speaker prefix; '' on an opening (no U). */
  uText: string;
  /** A guided re-roll's guidance: its names count as named in U. */
  guidance?: string;
  /** The last visible messages before U (an opening: the path's last ones), oldest → newest, without speaker prefixes. */
  windowTexts: readonly string[];
  /** The card character's and the persona's names (PathView.castNames). */
  castNames: readonly string[];
  /** Entry keys recall picked (M5c; none in M5a), in recall's order: tier 1 keeps it (D-203). */
  recallPicks?: readonly string[];
}

interface Ranked {
  pick: Pick;
  cast: boolean;
  /** Tier 2: index of the newest window message naming the entry (higher = newer); -1 otherwise. */
  msg: number;
  /** Tier 1: the entry's place in recall's picks (D-203); -1 otherwise. */
  rank: number;
  lastSeq: number;
  /** Handle number, then input position. */
  c: number;
  at: number;
}

const VIA: Readonly<Record<Pick['tier'], Pick['via']>> = { 0: 'mention', 1: 'model', 2: 'window', 3: 'constant' };

/** The number of a 'C<n>' handle; a ref of another shape sorts after every handle. */
const handleNumber = (ref: string): number => {
  const m = /^C(\d+)$/.exec(ref);
  return m ? Number(m[1]) : Infinity;
};

export function select(input: SelectInput): Pick[] {
  const cast = new Set(input.castNames.map(normalizeName).filter((n) => n !== ''));
  const isCast = (e: CEntry): boolean => [e.name, ...e.aliases].some((n) => typeof n === 'string' && cast.has(normalizeName(n)));
  // U and a re-roll's guidance are one text (D-169): a phrase's words may be split between them.
  const guided = input.guidance !== undefined && input.guidance.trim() !== '';
  const named = mentionText(guided ? `${input.uText}\n${input.guidance}` : input.uText);
  const window = input.windowTexts.slice(-WINDOW_MESSAGES).map(mentionText);
  // D-203: recall's order (a key picked twice keeps its first place).
  const recall = new Map<string, number>();
  for (const key of input.recallPicks ?? []) if (!recall.has(key)) recall.set(key, recall.size);

  const ranked: Ranked[] = [];
  const seen = new Set<string>();
  input.entries.forEach((e, at) => {
    if (e.type === null || e.retired !== undefined || e.arc !== undefined || seen.has(e.key)) return;
    seen.add(e.key);
    const matchers = entryMatchers(e);
    let tier: Pick['tier'];
    let msg = -1;
    if (mentioned(matchers, named)) tier = 0;
    else if (recall.has(e.key)) tier = 1;
    else {
      for (let i = window.length - 1; i >= 0 && msg < 0; i--) if (mentioned(matchers, window[i]!)) msg = i;
      if (msg >= 0) tier = 2;
      else if (e.origin.kind === 'library' && e.constant === true) tier = 3;
      else return;
    }
    const ref = input.refOf(e.key);
    ranked.push({ pick: { key: e.key, ref, tier, via: VIA[tier] }, cast: isCast(e), msg, rank: tier === 1 ? recall.get(e.key)! : -1, lastSeq: e.prov.lastSeq, c: handleNumber(ref), at });
  });

  ranked.sort(
    (a, b) =>
      a.pick.tier - b.pick.tier ||
      (a.pick.tier === 1 ? a.rank - b.rank : 0) ||
      Number(a.cast) - Number(b.cast) ||
      b.msg - a.msg ||
      b.lastSeq - a.lastSeq ||
      (a.c === b.c ? 0 : a.c < b.c ? -1 : 1) ||
      a.at - b.at,
  );
  return ranked.map((r) => r.pick);
}
