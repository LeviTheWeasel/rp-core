// Ported from Bunraku:src/core/assembly/recall-place.ts@702d8120 (placeRecall: the block's header, sections and first-fit cut).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Compendium block (ARCHITECTURE.md §7.4.1, .notes/m5a-decisions.md D-155): the selector's
// candidates, as RoleCall injects retrieved entries — one text headed '[Retrieved World Knowledge]',
// a '[Lore: <name>]' line and the entry's text per entry, entries separated by a blank line — inside
// the budget assemble hands it. In order: an entry already in the prompt is `repeated`; past the
// profile's maxEntries, or when its text does not fit what is left, it is `cut` and the next one is
// tried (first-fit). The text is the full render when there is one within the profile's limit and it
// fits, else the brief, with its tail ('(more: read_lore C12)') on its own line when the request
// offers read_lore. No selection reasons in the text (the trace has them). Pure.
// Changes from Bunraku: profile limits (entries, full vs brief, the lite block cap), the brief
// fallback and its tail, handles and modes in the result, the counter passed in.

import type { CompendiumTrace } from '../../session/entries.ts';
import type { BlockCandidate, BlockLimits, CompendiumBlockInput } from './types.ts';

export const BLOCK_HEADER = '[Retrieved World Knowledge]';

/** One entry's part of the block. */
export const blockSection = (name: string, text: string): string => `[Lore: ${name}]\n${text}`;

export interface PlaceResult {
  /** The block, or null when no entry went in. */
  text: string | null;
  /** Tokens the block takes against its budget: the header and each injected section (0 when empty). */
  tok: number;
  injected: CompendiumTrace['injected'];
  cut: CompendiumTrace['cut'];
  /** Keys skipped because they are already in the prompt. */
  repeated: string[];
}

/** The full render when the profile allows one this long, else null. */
function fullText(c: BlockCandidate, limits: BlockLimits): string | null {
  if (c.full === null || c.full.trim() === '') return null;
  return c.full.length <= limits.fullChars ? c.full : null;
}

function briefText(c: BlockCandidate, withTail: boolean): string {
  return withTail && c.briefTail.trim() !== '' ? `${c.brief}\n${c.briefTail}` : c.brief;
}

/**
 * The block for these candidates within `budgetTok` (capped by limits.blockTok), costs from `count`
 * (the request's counter, in budget tokens). `withTail`: the request offers read_lore.
 */
export function placeBlock(input: CompendiumBlockInput, budgetTok: number, count: (text: string) => number, withTail: boolean): PlaceResult {
  const { limits } = input;
  const injected: PlaceResult['injected'] = [];
  const cut: PlaceResult['cut'] = [];
  const repeated: string[] = [];
  const sections: string[] = [];
  const headTok = count(BLOCK_HEADER);
  let left = Math.min(budgetTok, limits.blockTok) - headTok;
  let used = headTok;
  const seen = new Set<string>();

  for (const c of input.candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    if (input.inPrompt.has(c.key)) {
      repeated.push(c.key);
      continue;
    }
    const full = fullText(c, limits);
    const brief = briefText(c, withTail);
    // A candidate with nothing to say is skipped (Bunraku: in no list).
    if (full === null && c.brief.trim() === '') continue;
    if (injected.length >= limits.maxEntries) {
      cut.push({ ref: c.ref, tok: count(blockSection(c.name, full ?? brief)) });
      continue;
    }
    let tok = 0;
    let mode: 'full' | 'brief' | null = null;
    let section = '';
    if (full !== null) {
      section = blockSection(c.name, full);
      tok = count(section);
      if (tok <= left) mode = 'full';
    }
    if (mode === null && c.brief.trim() !== '') {
      section = blockSection(c.name, brief);
      tok = count(section);
      if (tok <= left) mode = 'brief';
    }
    if (mode === null) {
      cut.push({ ref: c.ref, tok });
      continue;
    }
    left -= tok;
    used += tok;
    sections.push(section);
    injected.push({ ref: c.ref, tok, mode });
  }

  if (sections.length === 0) return { text: null, tok: 0, injected, cut, repeated };
  return { text: `${BLOCK_HEADER}\n${sections.join('\n\n')}`, tok: used, injected, cut, repeated };
}
