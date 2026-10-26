// Ported from Bunraku:src/core/tokens/trim.ts and src/core/assembly/budget-app.ts@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Context budget (ARCHITECTURE.md §11, D-49, D-89).
// CONTRACT FILE: signatures are fixed; the prompt agent implements the bodies.
//
// Port notes: Bunraku's trimHistory (a chunk grid anchored at the oldest message, suffix sums) and
// its appBudgeter.fitHistory (walk from the newest message, stop the moment the budget is exceeded)
// are merged into one pass over {id, tok}. Behaviour reference: RoleCall finalPassBudgetTrim
// (protected tail, never drop what the caller marks protected, report rather than send when even
// the protected part overflows). Not ported: RoleCall's chars/4 measure and its one-at-a-time drop,
// which moves the prompt start every turn and defeats the provider cache.

import type { ModelCaps } from '../providers/types.ts';
import type { Preset } from '../formats/native.ts';

/** Window assumed for a model that reports none: llama.cpp's common default locally, a safe floor remotely. */
export const DEFAULT_LOCAL_WINDOW = 8192;
export const DEFAULT_REMOTE_WINDOW = 32768;
/** Below this window the reply reserve defaults to 2048 instead of 8192 [D-89]. */
export const SMALL_WINDOW = 24576;
export const SMALL_WINDOW_REPLY = 2048;
export const LARGE_WINDOW_REPLY = 8192;
/** History dropped per step: the cached prefix survives about four exchanges [D-49]. */
export const DEFAULT_TRIM_CHUNK = 8;

/** A usable size limit: a positive finite number, floored; anything else means "not set". */
function limit(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** min(caps.contextLength ?? (local ? 8192 : 32768), preset.context.maxContext, configWindow). */
export function contextWindow(input: {
  caps: ModelCaps;
  local: boolean;
  preset?: Preset;
  configWindow?: number;
}): number {
  const model = limit(input.caps.contextLength) ?? (input.local ? DEFAULT_LOCAL_WINDOW : DEFAULT_REMOTE_WINDOW);
  // The preset and the session config may only shrink the window, never grow it past the model.
  let w = model;
  const preset = limit(input.preset?.context?.maxContext);
  if (preset !== undefined) w = Math.min(w, preset);
  const config = limit(input.configWindow);
  if (config !== undefined) w = Math.min(w, config);
  return w;
}

/** min(maxTokens ?? (window < 24576 ? 2048 : 8192), floor(window / 2)). [D-89] */
export function replyReserve(window: number, maxTokens?: number): number {
  const half = window > 0 ? Math.floor(window / 2) : 0; // NaN and negatives reserve nothing
  const wanted = limit(maxTokens) ?? (window < SMALL_WINDOW ? SMALL_WINDOW_REPLY : LARGE_WINDOW_REPLY);
  return Math.min(wanted, half);
}

/** A positive count limit, floored; anything else means "no limit". */
function limitOf(n: number | undefined): number | undefined {
  return typeof n === 'number' && n > 0 && !Number.isNaN(n) ? Math.floor(n) : undefined;
}

/** A count option clamped to [0, max]; NaN and missing mean 0. */
function count(n: number | undefined, max: number): number {
  return typeof n === 'number' && n > 0 ? Math.min(max, Math.floor(n)) : 0;
}

/** A token estimate that cannot poison a sum: negative or non-finite counts as 0. */
function tokOf(entry: { tok: number }): number {
  return Number.isFinite(entry.tok) && entry.tok > 0 ? entry.tok : 0;
}

/**
 * Which oldest history messages to drop [D-49]. `history` is oldest→newest with token estimates;
 * `protectedTail` messages at the end (current user message etc.) are never dropped. The grid of
 * 8-message chunks is anchored at the oldest message, so the cut point moves a whole chunk at a time.
 * Measures from the newest backwards and stops early once the budget is exceeded.
 *
 * `budget` is what history may use (window − reserve − everything that is not history). The kept
 * messages are history[0, protectedHead) plus history[keepFrom, n); history[protectedHead, keepFrom)
 * is dropped and `trimmed` names its first and last id (null when nothing is dropped, in which case
 * keepFrom = protectedHead). With protectedHead 0, `history.slice(keepFrom)` is what to send. The
 * grid is anchored at the oldest droppable message (index protectedHead); the one off-grid cut is
 * the start of the protected tail, used when no grid point fits. `fits` is false when even the
 * protected messages alone exceed the budget: the caller reports context_length_exceeded and sends
 * nothing; keepFrom then drops every droppable message. `maxKept` caps how many messages are kept
 * in all (preset.context.maxMessages), protected ones included; it moves the cut to the first grid
 * point that respects it, so it slides a chunk at a time too (the chunk shrinks to
 * maxKept − protected + 1 when that is smaller, so such a point always exists).
 */
export function trimHistory(
  history: readonly { id: string; tok: number }[],
  budget: number,
  opts?: { chunk?: number; protectedHead?: number; protectedTail?: number; maxKept?: number },
): { keepFrom: number; trimmed: { from: string; to: string } | null; fits: boolean } {
  const n = history.length;
  const head = count(opts?.protectedHead, n);
  const tail = count(opts?.protectedTail, n - head);
  const end = n - tail; // droppable messages are history[head, end)
  // maxKept (preset.context.maxMessages): at most that many messages in all, the protected ones
  // included and always kept. It raises the lowest allowed cut, and the cut stays on the grid. A
  // limit smaller than a chunk shrinks the chunk to what the limit leaves room for, so a grid point
  // between the limit and the protected tail always exists: otherwise the cut would fall back to the
  // off-grid tail and move every turn.
  const maxKept = limitOf(opts?.maxKept);
  let chunk = count(opts?.chunk ?? DEFAULT_TRIM_CHUNK, Number.MAX_SAFE_INTEGER) || 1;
  if (maxKept !== undefined) chunk = Math.min(chunk, Math.max(1, maxKept - head - tail + 1));
  const floor = maxKept === undefined ? head : Math.min(end, Math.max(head, n - maxKept + head));

  const result = (keepFrom: number, fits: boolean) => ({
    keepFrom,
    trimmed: keepFrom > head ? { from: history[head]!.id, to: history[keepFrom - 1]!.id } : null,
    fits,
  });

  // The protected part is sent whatever happens, so it is the floor of what this request costs.
  let used = 0;
  for (let i = 0; i < head; i++) used += tokOf(history[i]!);
  for (let i = end; i < n; i++) used += tokOf(history[i]!);
  if (used > budget) return result(end, false);

  // Cut points: head, head + chunk, head + 2·chunk, … below `end`, plus `end` itself. Walk them from
  // the newest down, adding the messages each step uncovers; the first point that overflows means
  // the previous one is the cut, and nothing older is ever measured (the early stop).
  let cut = end;
  let i = end;
  for (let g = end > head ? head + Math.floor((end - 1 - head) / chunk) * chunk : head - 1; g >= floor; g -= chunk) {
    while (i > g) used += tokOf(history[--i]!);
    if (used > budget) break;
    cut = g;
  }
  return result(cut, true);
}
