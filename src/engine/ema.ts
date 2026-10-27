// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The token-estimate correction of one model, derived from the path (ARCHITECTURE.md §11, D-50):
// never stored, recomputed for every turn from what is already in the log. Pure.
//
// A sample is one model call on the path whose commit carries both the estimate of what was sent
// (trace.tokens.estimated) and the prompt tokens the provider reported (trace.tokens.reported, also
// in gen.usage.inputTotal when the answer took one call). An answer contributes its `msg` line, and every continue `edit`
// of it contributes its own call. Samples are ordered by seq (oldest → newest) so the EMA weighs the
// newest calls most. prompt/tokens.ts emaFactor folds them.
//
// M2: only calls counted the way the next prompt is counted are samples (trace.tokens.counter; an
// absent counter is M1's 'chars'). A ratio learned against chars/3 says nothing about o200k.
//
// M3 (B13): an answer with tool rounds made several calls and gen.usage is their sum, while the
// estimate is round 0's request. So the reported side is trace.tokens.reported (round 0's prompt)
// first; gen.usage.inputTotal only stands in for a trace without it (the two are equal for one call).

import { defaultCounter, EMA_DISCARD_BELOW, emaFactor, type TokenCounter } from '../prompt/tokens.ts';
import type { Generation, Trace } from '../session/entries.ts';
import type { TreeIndex } from '../session/tree.ts';
import type { PathView } from '../session/view.ts';

export interface EmaSample {
  estimated: number;
  reported: number;
}

/** A counter id: what trace.tokens.counter holds. */
export type CounterId = TokenCounter['id'];

/** How a trace's estimate was counted: absent means 'chars' (M1 traces). */
export function counterOf(trace: Trace): CounterId {
  return trace.tokens?.counter ?? 'chars';
}

/** One call's sample, when its commit has both counts and the model and the counter match. */
function sampleOf(gen: Generation | undefined, trace: Trace | undefined, model: string, counter: CounterId): EmaSample | null {
  if (!gen || gen.kind !== 'model' || gen.model !== model || !trace) return null;
  // A recovered (partial) answer has no usage of its own; skip it explicitly all the same.
  if (trace.partial) return null;
  if (counterOf(trace) !== counter) return null;
  // Round 0's prompt; a sum over rounds never feeds the EMA.
  const reported = trace.tokens?.reported ?? gen.usage?.inputTotal;
  const estimated = trace.tokens?.estimated;
  if (typeof reported !== 'number' || typeof estimated !== 'number') return null;
  return { estimated, reported };
}

/**
 * The samples of `model` along the path, oldest → newest, counted by `counter` (default: the
 * default counter's id). Hidden answers count: hiding changes what the next prompt holds, not what
 * an earlier call measured.
 */
export function emaSamples(idx: TreeIndex, view: Pick<PathView, 'path'>, model: string, counter: CounterId = defaultCounter().id): EmaSample[] {
  const found: { seq: number; s: EmaSample }[] = [];
  for (const m of view.path) {
    if (m.role !== 'assistant') continue;
    const entry = idx.msgs.get(m.id);
    if (!entry) continue;
    const own = sampleOf(entry.gen, entry.trace, model, counter);
    if (own) found.push({ seq: entry.seq, s: own });
    for (const e of idx.edits.get(m.id) ?? []) {
      if (e.reason !== 'continue') continue;
      const s = sampleOf(e.gen, e.trace, model, counter);
      if (s) found.push({ seq: e.seq, s });
    }
  }
  return found.sort((a, b) => a.seq - b.seq).map((f) => f.s);
}

/** Below this many estimated prompt tokens a low report is not read as truncation (framing noise). */
export const TRUNCATION_MIN_ESTIMATE = 256;

/**
 * The server reported far fewer prompt tokens than were sent (ratio below EMA_DISCARD_BELOW on a
 * prompt of at least TRUNCATION_MIN_ESTIMATE estimated tokens): it cut the prompt to fit a window
 * smaller than the engine budgeted for, as Ollama does silently at its num_ctx. Such a call is not an
 * EMA sample (tokens.ts), and the engine tells the user once per session.
 */
export function truncatedByServer(estimated: number, reported: number | undefined): boolean {
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) return false;
  if (!Number.isFinite(estimated) || estimated < TRUNCATION_MIN_ESTIMATE) return false;
  return reported / estimated < EMA_DISCARD_BELOW;
}

/** AssembleInput.tokenFactor for a turn of `model` counted by `counter` (EMA_START when the path has no sample). */
export function tokenFactorFor(idx: TreeIndex, view: Pick<PathView, 'path'>, model: string, counter: CounterId = defaultCounter().id): number {
  return emaFactor(emaSamples(idx, view, model, counter));
}
