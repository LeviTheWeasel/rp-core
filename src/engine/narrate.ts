// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The narrator's call (ARCHITECTURE.md §7.1, §8.1, §8.8). M1a is the loop without tools: exactly
// one streamed round. The shape follows Bunraku's tool loop (one provider call per round, events
// forwarded as they arrive); tool rounds, the final text-only round and the loop guard arrive in M3.
//
// One call: take a place on the connection's origin semaphore (interactive priority), stream, turn
// every StreamEv into an outcome. Timeouts (first byte, idle) abort a child of the turn signal with
// a typed reason and come back as ProviderError 'timeout': a timeout is never reported as a Stop.

import { abortWith, childController, reasonOf, type DelayTimers } from './abort.ts';
import type { Scheduler } from './sched.ts';
import type { Connection } from './api.ts';
import { ProviderError } from '../providers/types.ts';
import type { FinishReason, ModelRequest, PromptMsg, StreamEv, Usage } from '../providers/types.ts';
import type { Samplers } from '../formats/native.ts';

/** §8.8: first byte 600 s on a local origin (prompt processing is slow), 120 s remote; idle 120 s. */
export const FIRST_BYTE_LOCAL_MS = 600_000;
export const FIRST_BYTE_REMOTE_MS = 120_000;
export const IDLE_MS = 120_000;

export interface CallTimeouts {
  firstByteMs: number;
  idleMs: number;
}

export function timeoutsFor(conn: Connection, override?: Partial<CallTimeouts>): CallTimeouts {
  return {
    firstByteMs: override?.firstByteMs ?? (conn.local ? FIRST_BYTE_LOCAL_MS : FIRST_BYTE_REMOTE_MS),
    idleMs: override?.idleMs ?? IDLE_MS,
  };
}

export interface CallInput {
  conn: Connection;
  model: string;
  messages: PromptMsg[];
  prefill?: string;
  maxTokens: number;
  samplers: Partial<Samplers>;
  reasoning?: ModelRequest['reasoning'];
  callKey: string;
  /** The turn's signal: Stop reaches the semaphore wait and the stream through it. */
  turnSignal: AbortSignal;
  sched: Scheduler;
  fetch: typeof fetch;
  timeouts: CallTimeouts;
  timers: DelayTimers;
  clock: () => Date;
  /** Streamed text / reasoning deltas, in arrival order. */
  onText(delta: string): void;
  onReasoning(delta: string): void;
  onUsage(usage: Usage): void;
}

export interface CallResult {
  text: string;
  reasoning: string;
  usage?: Usage;
  finish?: { reason: FinishReason; raw: string };
  /** The model the server says it served (gen.served). */
  served?: string;
  /** Set when the call failed (provider error, timeout, truncated stream) before its finish. */
  error?: ProviderError;
  /**
   * A failure after the finish (while reading for usage, §8.1): the answer stands and commits with
   * the provider's finish; only what would have followed the finish (usage) is missing.
   */
  tailError?: ProviderError;
  /** The turn was stopped (user_stop / shutdown) during this call. */
  stopped: boolean;
  /** Text or reasoning arrived (or the provider said the failure came after output). */
  output: boolean;
  ms: number;
  ttftMs?: number;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The finishes a provider may report. 'stopped', 'interrupted' and 'max_rounds' are the engine's own. */
const PROVIDER_FINISHES: ReadonlySet<FinishReason> = new Set<FinishReason>(['end', 'length', 'content_filter', 'refusal']);

/**
 * A provider's finish as the engine records it: anything outside the provider's vocabulary reads as
 * a natural end (the raw value stays in `finish.raw`), so a stop is never invented (§6.5, §6.8).
 */
export function providerFinish(reason: FinishReason): FinishReason {
  return PROVIDER_FINISHES.has(reason) ? reason : 'end';
}

/** The request the provider sees. The signal is the call's own child controller. */
function buildRequest(input: CallInput, signal: AbortSignal): ModelRequest {
  const req: ModelRequest = {
    model: { connection: input.conn.id, model: input.model },
    caps: input.conn.caps,
    messages: input.messages,
    maxTokens: input.maxTokens,
    samplers: input.samplers,
    signal,
    callKey: input.callKey,
    agent: 'narrator',
  };
  if (input.prefill !== undefined && input.prefill !== '') req.prefill = input.prefill;
  if (input.reasoning !== undefined) req.reasoning = input.reasoning;
  if (input.samplers.stop && input.samplers.stop.length > 0) req.stop = input.samplers.stop;
  return req;
}

/** A semaphore capacity the scheduler accepts (an integer >= 1). */
function capacityOf(conn: Connection): number {
  const n = Math.floor(conn.caps.maxInFlight);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** One streamed narrator call. Never throws for provider trouble; the outcome says what happened. */
export async function streamCall(input: CallInput): Promise<CallResult> {
  const { clock, timers } = input;
  const t0 = clock().getTime();
  const out: CallResult = { text: '', reasoning: '', stopped: false, output: false, ms: 0 };
  const done = (): CallResult => {
    out.ms = Math.max(0, clock().getTime() - t0);
    return out;
  };

  // The semaphore: a Stop while queued leaves the queue and ends the call as stopped.
  const sem = input.sched.forOrigin(input.conn.origin, capacityOf(input.conn));
  let slot;
  try {
    slot = await sem.acquire('interactive', input.turnSignal);
  } catch {
    out.stopped = true;
    return done();
  }

  const call = childController(input.turnSignal);
  let timer: unknown = null;
  const arm = (ms: number, reason: 'timeout:first_byte' | 'timeout:idle'): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => abortWith(call, reason), ms);
  };
  arm(input.timeouts.firstByteMs, 'timeout:first_byte');

  let finished = false;
  try {
    const stream = input.conn.provider.stream(buildRequest(input, call.signal), {
      fetch: input.fetch,
      key: input.conn.key ?? null,
    });
    for await (const ev of stream as AsyncIterable<StreamEv>) {
      arm(input.timeouts.idleMs, 'timeout:idle');
      if (ev.t === 'text' || ev.t === 'reasoning') {
        if (ev.d === '') continue;
        if (out.ttftMs === undefined) out.ttftMs = Math.max(0, clock().getTime() - t0);
        out.output = true;
        if (ev.t === 'text') {
          out.text += ev.d;
          input.onText(ev.d);
        } else {
          out.reasoning += ev.d;
          input.onReasoning(ev.d);
        }
      } else if (ev.t === 'usage') {
        out.usage = { ...out.usage, ...ev.u };
        input.onUsage(ev.u);
      } else if (ev.t === 'finish') {
        // Keep reading: usage may follow the finish (§8.1).
        out.finish = { reason: providerFinish(ev.reason), raw: ev.raw };
        if (ev.model) out.served = ev.model;
        finished = true;
      } else if (ev.t === 'error') {
        // After the finish the answer is complete: an error now only costs the usage (§19.2: an
        // answer in hand is never thrown away).
        if (finished) out.tailError = ev.err;
        else {
          out.error = ev.err;
          if (ev.afterOutput || ev.err.afterOutput) out.output = true;
        }
        break;
      }
      // reasoning_end and tool_* are M3 (tool rounds); a tool-less M1a call ignores them.
    }
  } catch (e) {
    const why = reasonOf(call.signal);
    if (finished) {
      // A stall, a network drop or a Stop while waiting for usage/[DONE]: the finished answer is
      // kept with the provider's finish; a Stop now has nothing left to stop.
      out.tailError =
        e instanceof ProviderError
          ? e
          : new ProviderError({
              category: 'network',
              code: why === 'timeout:idle' || why === 'timeout:first_byte' ? 'timeout' : 'unreachable',
              message:
                why === 'timeout:idle'
                  ? 'the stream stalled after the answer finished'
                  : call.signal.aborted
                    ? 'stopped after the answer finished'
                    : msg(e),
              afterOutput: true,
            });
    } else if (why === 'timeout:first_byte' || why === 'timeout:idle') {
      out.error = new ProviderError({
        category: 'network',
        code: 'timeout',
        message: why === 'timeout:first_byte' ? 'no response from the model in time' : 'the model stopped sending',
        afterOutput: out.output,
      });
    } else if (call.signal.aborted) {
      // The turn was stopped (user_stop, shutdown): whatever arrived is kept by the caller.
      out.stopped = true;
    } else if (e instanceof ProviderError) {
      out.error = e;
    } else {
      // A provider that throws instead of yielding an error event: a network-ish failure whose
      // timing we do not know, so it counts as after output when anything arrived.
      out.error = new ProviderError({ category: 'network', code: 'unreachable', message: msg(e), afterOutput: out.output });
    }
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
    slot.release();
  }

  if (!out.error && !out.stopped && !finished) {
    // EOF without a terminal signal is a truncated stream, never an invented stop (§8.1).
    if (input.turnSignal.aborted) out.stopped = true;
    else
      out.error = new ProviderError({
        category: 'network',
        code: 'truncated_stream',
        message: 'the stream ended without a finish',
        afterOutput: out.output,
      });
  }
  return done();
}
