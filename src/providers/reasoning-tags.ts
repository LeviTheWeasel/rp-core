// Ported from Bunraku:src/core/reasoning-capture.ts@702d8120 (closingForOpening: the opening → closing table).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Streaming splitter for inline reasoning tags (ARCHITECTURE.md §8.4, D-54). A carry buffer holds any
// suffix that could be the start of a marker, so tag fragments never leak into text events.
// Reference: Bunraku src/core/reasoning-capture.ts (closingForOpening table); tests from reasoning-tags.ts.
// CONTRACT FILE (M1b): signatures are fixed; the transport agent implements the bodies.
//
// Only the table is ported. Bunraku's reasoning-tags.ts is a display-time scan over a finished reply
// (case-insensitive, name heuristics, heading layouts, "an unclosed block shows as the reply"); this is
// a fresh streaming state machine with different, deliberate rules:
//
// - Markers are matched EXACTLY, case-sensitive: '<think>' does not match '<Think>' or '<THINK>'.
//   A model that emits another spelling gets that spelling listed in caps.reasoning.tags (data, §8.2).
// - Outside reasoning, an opening marker starts a block; inside, only the CLOSING marker of the pair
//   that opened it ends the block. Everything else inside (another opening, a different closing) is
//   reasoning text; there is no nesting.
// - A closing marker seen outside reasoning (the template opened <think> in the prompt but the caller
//   did not pass startInside) is dropped: it is markup, and leaking it into text is the bug this file
//   exists to prevent. What came before it has already gone out as text.
// - Lossless otherwise: the markers are the only characters removed. Whitespace around them (the
//   usual "\n\n" after </think>) is kept; trimming is display policy, not transport.
// - An unclosed block at end() stays reasoning. A marker prefix left in the carry at end() is plain
//   content of the current state (text outside, reasoning inside).

export interface TagPair {
  open: string;
  close: string;
}

/** [D-54] default tags: <think>, <thinking>, <thought>, [THINK], ◁think▷, <|begin_of_thought|>. */
export const DEFAULT_REASONING_TAGS: readonly string[] = ['<think>', '<thinking>', '<thought>', '[THINK]', '◁think▷', '<|begin_of_thought|>'];

/**
 * The closing text that pairs with an opening one (Bunraku closingForOpening): "<plan>" gives
 * "</plan>", "[THINK]" gives "[/THINK]", plus Kimi's ◁think▷ and OpenThoughts' <|begin_of_thought|>.
 * Blank when the text has no tag shape to close. Unlike Bunraku, the opening is not trimmed: markers
 * are exact text.
 */
export function closingFor(open: string): string {
  if (open === '<|begin_of_thought|>') return '<|end_of_thought|>';
  if (open === '◁think▷') return '◁/think▷';
  const angle = /^<\s*([a-zA-Z][a-zA-Z0-9_-]*)\b[^>]*>$/.exec(open);
  if (angle) return `</${angle[1]}>`;
  const square = /^\[\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\]$/.exec(open);
  return square ? `[/${square[1]}]` : '';
}

/**
 * Opening markers → pairs with their closing markers (e.g. '<think>' → '</think>', '[THINK]' → '[/THINK]', '<|begin_of_thought|>' → '<|end_of_thought|>').
 * An opening with no tag shape (no closing can be derived) is skipped; duplicates collapse.
 */
export function tagPairs(tags?: readonly string[]): TagPair[] {
  const out: TagPair[] = [];
  const seen = new Set<string>();
  for (const open of tags ?? DEFAULT_REASONING_TAGS) {
    if (open === '' || seen.has(open)) continue;
    const close = closingFor(open);
    if (close === '') continue;
    seen.add(open);
    out.push({ open, close });
  }
  return out;
}

export type SplitPiece = { kind: 'text' | 'reasoning'; d: string };

export interface ReasoningSplitter {
  push(chunk: string): SplitPiece[];
  /** Flush the carry buffer at the end of the stream (an unclosed reasoning block stays reasoning). */
  end(): SplitPiece[];
}

/** A marker the scanner looks for in the current state. */
interface Marker {
  text: string;
  /** 'open' enters the pair; 'close' leaves reasoning (inside) or is dropped (outside, stray). */
  role: 'open' | 'close';
  pair?: TagPair;
}

/** startInside: the stream begins inside a reasoning block (some templates open <think> in the prompt). */
export function createReasoningSplitter(pairs: readonly TagPair[], opts?: { startInside?: boolean }): ReasoningSplitter {
  const usable = pairs.filter((p) => p.open !== '' && p.close !== '');
  // Outside: every opening, and every closing (a stray one is dropped, never shown as text).
  const outsideMarkers: Marker[] = [
    ...usable.map((p): Marker => ({ text: p.open, role: 'open', pair: p })),
    ...usable.map((p): Marker => ({ text: p.close, role: 'close' })),
  ];
  // Inside a block opened by the template (startInside): we do not know which pair, so any closing ends it.
  const anyClose: Marker[] = dedupe(usable.map((p): Marker => ({ text: p.close, role: 'close' })));
  const closeOf = (p: TagPair): Marker[] => [{ text: p.close, role: 'close' }];

  /** null = outside; else the markers that end the current reasoning block. */
  let inside: Marker[] | null = opts?.startInside && anyClose.length > 0 ? anyClose : null;
  let carry = '';

  function emit(out: SplitPiece[], kind: SplitPiece['kind'], d: string): void {
    if (d === '') return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.d += d;
    else out.push({ kind, d });
  }

  /** Consume `carry` as far as it can be decided; with `final`, decide everything. */
  function drain(final: boolean): SplitPiece[] {
    const out: SplitPiece[] = [];
    for (;;) {
      const markers = inside ?? outsideMarkers;
      const kind: SplitPiece['kind'] = inside ? 'reasoning' : 'text';
      const hit = earliest(carry, markers);
      // Where an undecided marker prefix begins (it runs to the end of the carry), if anywhere.
      const pending = final ? -1 : partialStart(carry, markers);
      if (hit && (pending < 0 || hit.at < pending)) {
        // Take the full marker, unless a longer marker might still be completing at or before it
        // (`pending` <= hit.at): then wait for more input, or for end().
        emit(out, kind, carry.slice(0, hit.at));
        carry = carry.slice(hit.at + hit.marker.text.length);
        if (inside) inside = null;
        else if (hit.marker.role === 'open') inside = closeOf(hit.marker.pair!);
        // else: a stray closing outside reasoning, dropped.
        continue;
      }
      if (pending >= 0) {
        emit(out, kind, carry.slice(0, pending));
        carry = carry.slice(pending);
      } else {
        emit(out, kind, carry);
        carry = '';
      }
      return out;
    }
  }

  return {
    push(chunk: string): SplitPiece[] {
      if (chunk === '') return [];
      carry += chunk;
      return drain(false);
    },
    end(): SplitPiece[] {
      return drain(true);
    },
  };
}

function dedupe(markers: Marker[]): Marker[] {
  const seen = new Set<string>();
  return markers.filter((m) => (seen.has(m.text) ? false : (seen.add(m.text), true)));
}

/** The earliest full marker in `s` (the longest one when several start at the same index). */
function earliest(s: string, markers: readonly Marker[]): { at: number; marker: Marker } | null {
  let best: { at: number; marker: Marker } | null = null;
  for (const m of markers) {
    const at = s.indexOf(m.text);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && m.text.length > best.marker.text.length)) best = { at, marker: m };
  }
  return best;
}

/**
 * The smallest index j such that s.slice(j) is a proper prefix of some marker: the start of the
 * longest suffix that could still grow into a marker. -1 when no suffix could.
 */
function partialStart(s: string, markers: readonly Marker[]): number {
  let longest = 0;
  for (const m of markers) longest = Math.max(longest, m.text.length - 1);
  for (let j = Math.max(0, s.length - longest); j < s.length; j++) {
    const tail = s.slice(j);
    if (markers.some((m) => m.text.length > tail.length && m.text.startsWith(tail))) return j;
  }
  return -1;
}
