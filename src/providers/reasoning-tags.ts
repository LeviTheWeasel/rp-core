// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Streaming splitter for inline reasoning tags (ARCHITECTURE.md §8.4, D-54). A carry buffer holds any
// suffix that could be the start of a marker, so tag fragments never leak into text events.
// Reference: Bunraku src/core/reasoning-capture.ts (closingForOpening table); tests from reasoning-tags.ts.
// CONTRACT FILE (M1b): signatures are fixed; the transport agent implements the bodies.

export interface TagPair {
  open: string;
  close: string;
}

/** [D-54] default tags: <think>, <thinking>, <thought>, [THINK], ◁think▷, <|begin_of_thought|>. */
export const DEFAULT_REASONING_TAGS: readonly string[] = ['<think>', '<thinking>', '<thought>', '[THINK]', '◁think▷', '<|begin_of_thought|>'];

/** Opening markers → pairs with their closing markers (e.g. '<think>' → '</think>', '[THINK]' → '[/THINK]', '<|begin_of_thought|>' → '<|end_of_thought|>'). */
export function tagPairs(tags?: readonly string[]): TagPair[] {
  void tags;
  throw new Error('not implemented: tagPairs');
}

export type SplitPiece = { kind: 'text' | 'reasoning'; d: string };

export interface ReasoningSplitter {
  push(chunk: string): SplitPiece[];
  /** Flush the carry buffer at the end of the stream (an unclosed reasoning block stays reasoning). */
  end(): SplitPiece[];
}

/** startInside: the stream begins inside a reasoning block (some templates open <think> in the prompt). */
export function createReasoningSplitter(pairs: readonly TagPair[], opts?: { startInside?: boolean }): ReasoningSplitter {
  void pairs; void opts;
  throw new Error('not implemented: createReasoningSplitter');
}
