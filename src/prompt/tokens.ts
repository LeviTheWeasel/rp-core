// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Token estimate (ARCHITECTURE.md §11). M1: chars/3, Cyrillic chars/2.5, conservative, no deps.
// gpt-tokenizer and the EMA correction arrive in M1b/M2 behind the same functions.
// CONTRACT FILE: signatures are fixed; the prompt agent implements the bodies.

import type { PromptMsg } from '../providers/types.ts';
import type { Block } from '../session/entries.ts';

/** Characters per token for everything that is not Cyrillic. */
export const CHARS_PER_TOKEN = 3;
/** Cyrillic tokenizes denser (BPE vocabularies hold fewer Cyrillic merges), so it gets a smaller divisor. */
export const CYRILLIC_CHARS_PER_TOKEN = 2.5;
/** Role and framing tokens every message costs on the wire. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Cyrillic, Cyrillic Supplement, Extended-A/B/C. All BMP, so one UTF-16 unit per character. */
function isCyrillic(c: number): boolean {
  return (
    (c >= 0x0400 && c <= 0x052f) ||
    (c >= 0x1c80 && c <= 0x1c8f) ||
    (c >= 0x2de0 && c <= 0x2dff) ||
    (c >= 0xa640 && c <= 0xa69f)
  );
}

/**
 * ceil(other / 3 + cyrillic / 2.5), counted per character class. Characters are UTF-16 units, so an
 * astral character (emoji) counts twice: that errs high, which is the safe side for a budget.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyr = 0;
  for (let i = 0; i < text.length; i++) if (isCyrillic(text.charCodeAt(i))) cyr++;
  const other = text.length - cyr;
  // Same sum over a common denominator of 15 (other/3 = 5·other/15, cyr/2.5 = 6·cyr/15): integer
  // arithmetic, so an exact multiple never rounds up by a float hair.
  return Math.ceil((other * 5 + cyr * 6) / 15);
}

/** One block's estimate: everything of it that goes on the wire, ids and tool names included. */
export function estimateBlock(block: Block): number {
  switch (block.k) {
    case 'text':
    case 'reasoning':
      return estimateTokens(block.text);
    case 'tool_call':
      return estimateTokens(block.id) + estimateTokens(block.name) + estimateTokens(block.args);
    case 'tool_result':
      return estimateTokens(block.callId) + estimateTokens(block.name) + estimateTokens(block.text);
    default:
      return 0; // a block kind from a newer core (image is reserved): nothing countable yet
  }
}

/** One message: its blocks plus the per-message overhead. */
export function estimateMessage(message: PromptMsg): number {
  let sum = MESSAGE_OVERHEAD_TOKENS;
  for (const b of message.blocks) sum += estimateBlock(b);
  return sum;
}

/** Sum over text/reasoning/tool blocks plus 4 tokens of overhead per message. */
export function estimateMessages(messages: readonly PromptMsg[]): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessage(m);
  return sum;
}

// ---- M1b [D-50] --------------------------------------------------------------------------------

/** EMA defaults: alpha 0.3, start 1.15, clamped to [0.8, 2.0] (§11). */
export const EMA_ALPHA = 0.3;
export const EMA_START = 1.15;
export const EMA_MIN = 0.8;
export const EMA_MAX = 2.0;

/**
 * The token-estimate correction for one model, derived (never stored) from the answers on the path
 * that report prompt tokens: samples oldest → newest, each {estimated, reported}. No samples → EMA_START.
 * CONTRACT (M1b): implemented by the prompt-m1b agent.
 */
export function emaFactor(samples: readonly { estimated: number; reported: number }[]): number {
  void samples;
  throw new Error('not implemented: emaFactor');
}
