// Ported from Bunraku:src/studio/scene-turn-fallback.ts (isFallbackWorthy)@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which failures earn one retry on the same model and then one fallback attempt (ARCHITECTURE.md
// §6.6), and how long to wait before the retry. Pure.
//
// Port notes: Bunraku's rule (only a "try again later" provider error qualifies; anything
// unrecognised fails as is) is kept, keyed on rp-core's ProviderError {code, status} instead of
// Bunraku's categories, with the status set of §6.6 (RETRYABLE_STATUSES adds 524/529). New here: the
// "before any output" condition lives in the predicate (afterOutput), the retry-after delay with a
// cap and jitter, and the conn:model parsing of a fallback.

import { ProviderError, RETRYABLE_STATUSES } from '../providers/types.ts';
import type { RandomBytes } from '../session/ids.ts';

/** §6.6: retry-after is honoured up to 8 s. */
export const RETRY_MAX_DELAY_MS = 8_000;
/** Wait when the server gave no retry-after. */
export const RETRY_DEFAULT_DELAY_MS = 1_000;
/** Jitter is at most this, and at most a quarter of the delay. */
export const RETRY_MAX_JITTER_MS = 250;

/** Codes that mean "try again later" when the server said so with a status. */
const TRANSIENT_CODES = new Set(['rate_limited', 'overloaded', 'timeout']);

/**
 * A failure that may be retried (and then sent to the fallback): nothing came out yet, it is not an
 * auth failure, and the server said "try again later" (a §6.6 status, or a transient code carrying
 * a status). A failure without a status — a local timeout, `fetch failed` after the body went out —
 * is ambiguous: the request may have been billed, so it is not repeated.
 */
export function isRetryable(err: unknown): err is ProviderError {
  if (!(err instanceof ProviderError)) return false;
  if (err.afterOutput) return false;
  // An auth failure (a rejected or unavailable key, D-73) is the same on every attempt: never retried,
  // and so never sent to the fallback either.
  if (err.category === 'auth') return false;
  if (err.status === undefined) return false;
  return RETRYABLE_STATUSES.has(err.status) || TRANSIENT_CODES.has(err.code);
}

/** min(retryAfter, cap) plus a little jitter from the injected entropy. */
export function retryDelayMs(err: ProviderError, capMs: number | undefined, random: RandomBytes): number {
  const cap = typeof capMs === 'number' && Number.isFinite(capMs) && capMs >= 0 ? capMs : RETRY_MAX_DELAY_MS;
  const asked = err.retryAfterSec !== undefined ? err.retryAfterSec * 1000 : RETRY_DEFAULT_DELAY_MS;
  const base = Math.max(0, Math.min(asked, cap));
  const b = random(2);
  const unit = ((b[0]! << 8) | b[1]!) / 65536;
  const jitter = Math.floor(unit * Math.min(RETRY_MAX_JITTER_MS, base / 4));
  return Math.round(base) + jitter;
}

/** 'conn:model' → {conn, model}; the model part may itself contain ':' (ollama tags). Null if malformed. */
export function parseModelRef(ref: string): { conn: string; model: string } | null {
  const at = ref.indexOf(':');
  if (at <= 0 || at === ref.length - 1) return null;
  return { conn: ref.slice(0, at), model: ref.slice(at + 1) };
}

export const modelLabel = (conn: string, model: string): string => `${conn}:${model}`;
