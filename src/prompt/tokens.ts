// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Token estimate (ARCHITECTURE.md §11). M1: chars/3, Cyrillic chars/2.5, conservative, no deps.
// M1b: the per-model EMA correction (emaFactor, D-50). M2: gpt-tokenizer o200k behind the same
// functions (TokenCounter); the counter's id goes to trace.tokens.counter so the EMA only learns
// from samples counted the same way. o200k loads on the first count and remembers recent counts.
// M3: native tool declarations are estimated as their wire JSON (estimateToolSpecs).
// CONTRACT FILE: signatures are fixed; the prompt agent implements the bodies.

import type { PromptMsg, ToolSpec } from '../providers/types.ts';
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

// ---- counters (M2) -----------------------------------------------------------------------------

/** A way to count tokens. `id` is recorded in trace.tokens.counter. */
export interface TokenCounter {
  readonly id: 'chars' | 'o200k';
  count(text: string): number;
}

/** M1's estimate: chars/3, Cyrillic chars/2.5 (charsEstimate). Tests that pin token numbers use it. */
export const CHARS_COUNTER: TokenCounter = { id: 'chars', count: (text) => charsEstimate(text) };

type CountTokens = (text: string, opts: { disallowedSpecial: Set<string> }) => number;

/** o200k's countTokens, required on first use: loading the BPE ranks takes ~0.3 s. */
let o200kCount: CountTokens | undefined;
function o200k(): CountTokens {
  if (!o200kCount) {
    // A synchronous require keeps the counter synchronous; Bun resolves the package's cjs build.
    const mod = require('gpt-tokenizer/encoding/o200k_base') as { countTokens: CountTokens };
    o200kCount = mod.countTokens;
  }
  return o200kCount;
}

/** True once the o200k tables are loaded (tests check that loading is lazy). */
export function o200kLoaded(): boolean {
  return o200kCount !== undefined;
}

/** Special tokens are plain text: "<|endoftext|>" in a card is counted, never thrown on. */
const NO_SPECIAL = { disallowedSpecial: new Set<string>() };

/**
 * Counts of recent texts. A turn measures the same history messages several times (budget, trace,
 * the engine's check), and the next turn measures them again; BPE is the expensive part, a Map
 * lookup is not. Deterministic, so it changes no result. Least recently used entries go first when
 * either cap is reached.
 */
const MEMO_MAX = 4096;
/** The most texts the memo may grow to for one very long chat (ensureMemoCapacity). */
const MEMO_MAX_GROWN = 65_536;
/** Characters kept in all (~16 MB of UTF-16): lore budget texts can be long. */
const MEMO_MAX_CHARS = 8_000_000;
let memoMax = MEMO_MAX;
/** BPE runs so far (tests: a turn over a known history must hit the memo). */
let bpeRuns = 0;
/** Texts shorter than this are cheaper to count than to remember. */
const MEMO_MIN_LENGTH = 64;
const memo = new Map<string, number>();
let memoChars = 0;

function countO200k(text: string): number {
  if (!text) return 0;
  if (text.length < MEMO_MIN_LENGTH || text.length > MEMO_MAX_CHARS) {
    bpeRuns++;
    return o200k()(text, NO_SPECIAL);
  }
  const hit = memo.get(text);
  if (hit !== undefined) {
    // Refresh: a Map iterates in insertion order, so the first key is the least recently used.
    memo.delete(text);
    memo.set(text, hit);
    return hit;
  }
  bpeRuns++;
  const n = o200k()(text, NO_SPECIAL);
  while (memo.size > 0 && (memo.size >= memoMax || memoChars + text.length > MEMO_MAX_CHARS)) {
    const oldest = memo.keys().next().value as string;
    memo.delete(oldest);
    memoChars -= oldest.length;
  }
  memo.set(text, n);
  memoChars += text.length;
  return n;
}

/**
 * Let the memo hold at least `texts` texts (up to MEMO_MAX_GROWN; the character cap still holds).
 * A turn walks every sent message several times in order (assemble, the trace, the engine's check);
 * an LRU smaller than the request misses on every pass of a very long chat. assemble calls this with
 * the size of the request it builds. It never shrinks: results do not depend on it.
 */
export function ensureMemoCapacity(texts: number): void {
  if (Number.isFinite(texts) && texts > memoMax) memoMax = Math.min(MEMO_MAX_GROWN, Math.ceil(texts));
}

/** How many texts o200k has tokenized so far (memo misses and short texts). For tests. */
export function o200kRuns(): number {
  return bpeRuns;
}

/**
 * gpt-tokenizer's o200k_base, loaded lazily on the first count (it takes ~0.3 s), with every
 * special token counted as plain text (`disallowedSpecial: new Set()`): a card that contains
 * "<|endoftext|>" must not throw.
 */
export const O200K_COUNTER: TokenCounter = {
  id: 'o200k',
  count: (text) => countO200k(text),
};

/** The counter assemble and the engine use when none is given. M2: O200K_COUNTER. */
export function defaultCounter(): TokenCounter {
  return O200K_COUNTER;
}

/** The counter a trace names (Trace.tokens.counter; absent = 'chars', M1). */
export function counterById(id: 'chars' | 'o200k' | undefined): TokenCounter {
  return id === 'o200k' ? O200K_COUNTER : CHARS_COUNTER;
}

/** The token count of `text` by `counter` (default: defaultCounter()). */
export function estimateTokens(text: string, counter?: TokenCounter): number {
  return (counter ?? defaultCounter()).count(text);
}

/**
 * ceil(other / 3 + cyrillic / 2.5), counted per character class. Characters are UTF-16 units, so an
 * astral character (emoji) counts twice: that errs high, which is the safe side for a budget.
 */
export function charsEstimate(text: string): number {
  if (!text) return 0;
  let cyr = 0;
  for (let i = 0; i < text.length; i++) if (isCyrillic(text.charCodeAt(i))) cyr++;
  const other = text.length - cyr;
  // Same sum over a common denominator of 15 (other/3 = 5·other/15, cyr/2.5 = 6·cyr/15): integer
  // arithmetic, so an exact multiple never rounds up by a float hair.
  return Math.ceil((other * 5 + cyr * 6) / 15);
}

/** One block's estimate: everything of it that goes on the wire, ids and tool names included. */
export function estimateBlock(block: Block, counter?: TokenCounter): number {
  const c = counter ?? defaultCounter();
  switch (block.k) {
    case 'text':
    case 'reasoning':
      return c.count(block.text);
    case 'tool_call':
      return c.count(block.id) + c.count(block.name) + c.count(block.args);
    case 'tool_result':
      return c.count(block.callId) + c.count(block.name) + c.count(block.text);
    default:
      return 0; // a block kind from a newer core (image is reserved): nothing countable yet
  }
}

/** One message: its blocks plus the per-message overhead. */
export function estimateMessage(message: PromptMsg, counter?: TokenCounter): number {
  let sum = MESSAGE_OVERHEAD_TOKENS;
  for (const b of message.blocks) sum += estimateBlock(b, counter);
  return sum;
}

/** Sum over text/reasoning/tool blocks plus 4 tokens of overhead per message. */
export function estimateMessages(messages: readonly PromptMsg[], counter?: TokenCounter): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessage(m, counter);
  return sum;
}

/**
 * M3: the native tool declarations of a request, estimated like text: the JSON of the list as the
 * openai-chat wire carries it (`{"type":"function","function":{name, description, parameters}}`
 * per tool, in the order given). Chat templates render it into the prompt in their own wording; the
 * EMA correction takes up the difference. No tools: 0.
 */
export function estimateToolSpecs(tools: readonly ToolSpec[], counter?: TokenCounter): number {
  if (tools.length === 0) return 0;
  const wire = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  return (counter ?? defaultCounter()).count(JSON.stringify(wire));
}

// ---- M1b [D-50] --------------------------------------------------------------------------------

/** EMA defaults: alpha 0.3, start 1.15, clamped to [0.8, 2.0] (§11). */
export const EMA_ALPHA = 0.3;
export const EMA_START = 1.15;
export const EMA_MIN = 0.8;
export const EMA_MAX = 2.0;

/**
 * A sample whose reported/estimated ratio is below this is not a tokenizer at all: the estimate is
 * chars/3 (Cyrillic /2.5), and natural text runs about 3.5–4.5 characters per token, so ordinary
 * ratios sit around 0.65–0.9 (EMA_MIN is an ordinary value, not an outlier line). Under 0.5 the
 * server counted fewer than half of the estimated tokens, i.e. it did not process the whole prompt:
 * Ollama silently drops old messages to fit its num_ctx. Such samples are left out of the EMA (they
 * would drag the factor to EMA_MIN and pack even more text into the next prompt), and the engine
 * says once that the server cut the prompt (engine/ema.ts truncatedByServer).
 */
export const EMA_DISCARD_BELOW = 0.5;

/** x clamped to the EMA corridor [EMA_MIN, EMA_MAX]. */
function clampFactor(x: number): number {
  return Math.min(EMA_MAX, Math.max(EMA_MIN, x));
}

/**
 * The token-estimate correction for one model, derived (never stored) from the answers on the path
 * that report prompt tokens: samples oldest → newest, each {estimated, reported}. No samples → EMA_START.
 *
 * f₀ = EMA_START; for each usable sample f ← α·clamp(reported / estimated) + (1 − α)·f; the result is
 * clamped as well. Each ratio is clamped before it enters the average, so one wild report above the
 * corridor (a server that counts the cached prefix twice, CJK text far denser than chars/3) moves the
 * factor by at most α·(2.0 − f). A sample is skipped when either count is not a positive finite
 * number (a missing report is "unknown", never zero; an empty estimate has no ratio), and when its
 * ratio is below EMA_DISCARD_BELOW: the server did not see the whole prompt, so the sample says
 * nothing about the tokenizer.
 */
export function emaFactor(samples: readonly { estimated: number; reported: number }[]): number {
  let f = EMA_START;
  for (const s of samples) {
    const { estimated, reported } = s;
    if (!(Number.isFinite(estimated) && estimated > 0 && Number.isFinite(reported) && reported > 0)) continue;
    const ratio = reported / estimated;
    if (ratio < EMA_DISCARD_BELOW) continue;
    f = EMA_ALPHA * clampFactor(ratio) + (1 - EMA_ALPHA) * f;
  }
  return clampFactor(f);
}
