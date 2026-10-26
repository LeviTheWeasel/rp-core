// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The narrator's call (ARCHITECTURE.md §7.1, §8.1, §8.8). M1a is the loop without tools: exactly
// one streamed round. The shape follows Bunraku's tool loop (one provider call per round, events
// forwarded as they arrive); tool rounds, the final text-only round and the loop guard arrive in M3.
//
// One call: resolve the connection's key (M1b, D-73), take a place on the connection's origin
// semaphore (interactive priority), stream, turn every StreamEv into an outcome. Timeouts (first
// byte, idle) abort a child of the turn signal with a typed reason and come back as ProviderError
// 'timeout': a timeout is never reported as a Stop. They are measured on bytes, as §8.8 says
// ("Первый байт … Простой между чанками"): the provider reports every body chunk through
// ProviderEnv.onActivity, so SSE keep-alive comments (OpenRouter's ': OPENROUTER PROCESSING' while a
// reasoning model thinks, DeepSeek's ': keep-alive' while queued, llama.cpp's pings) keep a live
// server's call open even though they carry no event.

import { abortWith, childController, reasonOf, type DelayTimers } from './abort.ts';
import type { Scheduler } from './sched.ts';
import type { Connection } from './api.ts';
import { ProviderError } from '../providers/types.ts';
import type { FinishReason, ModelCaps, ModelRequest, PromptMsg, StreamEv, Usage } from '../providers/types.ts';
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
  /** The caps of `model` on `conn` (Route.caps: capsFor(model) ?? conn.caps). */
  caps: ModelCaps;
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
  /** Each usage StreamEv as it arrives (the merged figure is CallResult.usage). */
  onUsage?(usage: Usage): void;
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

/** What of a call goes into its ModelRequest. */
export type RequestFields = Pick<CallInput, 'conn' | 'model' | 'caps' | 'messages' | 'prefill' | 'maxTokens' | 'samplers' | 'reasoning' | 'callKey'>;

/**
 * The request the provider sees. The signal is the call's own child controller. Exported for the
 * preview's wire() (session.ts), which must show the very request a call would send.
 */
export function modelRequest(input: RequestFields, signal: AbortSignal): ModelRequest {
  const req: ModelRequest = {
    model: { connection: input.conn.id, model: input.model },
    caps: input.caps,
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
function capacityOf(caps: ModelCaps): number {
  const n = Math.floor(caps.maxInFlight);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * The first-byte and idle deadlines of one call (§8.8), fed by bytes (ProviderEnv.onActivity) and by
 * events. Before anything arrives the call has firstByteMs. After a byte or an event, idleMs since the
 * last one. Before the first EVENT (only keep-alive comments so far) the call fails only once both
 * have run out: a server that sends one comment and then processes a long prompt quietly keeps its
 * first-byte allowance (600 s locally). The abort reason says whether any event had arrived.
 */
class ActivityWatch {
  private first: unknown = null;
  private idle: unknown = null;
  /** A byte or an event arrived. */
  private active = false;
  /** An event arrived (the answer, or at least the stream proper, has started). */
  private evented = false;
  private firstOver = false;
  private idleOver = false;
  private stopped = false;

  constructor(
    private readonly call: AbortController,
    private readonly t: CallTimeouts,
    private readonly timers: DelayTimers,
  ) {
    this.first = timers.setTimeout(() => {
      this.first = null;
      this.firstOver = true;
      if (!this.active || this.idleOver) this.fire();
    }, t.firstByteMs);
  }

  /** Body bytes arrived (a comment counts). */
  bytes(): void {
    if (this.stopped) return;
    this.active = true;
    this.idleOver = false;
    if (this.idle !== null) this.timers.clearTimeout(this.idle);
    this.idle = this.timers.setTimeout(() => {
      this.idle = null;
      this.idleOver = true;
      if (this.evented || this.firstOver) this.fire();
    }, this.t.idleMs);
  }

  /** A StreamEv arrived: from now on only the idle deadline counts. */
  event(): void {
    if (this.stopped) return;
    if (!this.evented) {
      this.evented = true;
      if (this.first !== null) this.timers.clearTimeout(this.first);
      this.first = null;
    }
    this.bytes();
  }

  stop(): void {
    this.stopped = true;
    if (this.first !== null) this.timers.clearTimeout(this.first);
    if (this.idle !== null) this.timers.clearTimeout(this.idle);
    this.first = this.idle = null;
  }

  private fire(): void {
    if (this.stopped) return;
    abortWith(this.call, this.evented ? 'timeout:idle' : 'timeout:first_byte');
  }
}

/** The value an aborted wait for the key settles with (never a key). */
const STOPPED: unique symbol = Symbol('stopped');

/** What waiting for the key came to. */
type KeyOutcome = { key: string | null } | { error: ProviderError } | { stopped: true };

/**
 * The connection's API key (§13, D-73): resolveKey() when the connection resolves it lazily
 * (key_env / key_cmd; the resolver memoises it), else the static `key`, else none. A Stop while a
 * key command runs ends the wait at once (the command itself is bounded by its own 10 s timeout). A
 * rejection is an auth failure before any output: a ProviderError keeps its code; anything else
 * becomes 'key_unavailable' with a fixed message, since a key command's output must never be shown.
 */
async function resolveKey(conn: Connection, signal: AbortSignal): Promise<KeyOutcome> {
  if (signal.aborted) return { stopped: true };
  if (!conn.resolveKey) return { key: conn.key ?? null };
  let pending: Promise<string | null>;
  try {
    pending = Promise.resolve(conn.resolveKey());
  } catch (e) {
    pending = Promise.reject(e);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof STOPPED>((resolve) => {
    onAbort = () => resolve(STOPPED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const got = await Promise.race([pending, aborted]);
    if (got === STOPPED) return { stopped: true };
    return { key: got ?? conn.key ?? null };
  } catch (e) {
    if (signal.aborted) return { stopped: true };
    if (e instanceof ProviderError) return { error: e.afterOutput ? e.withAfterOutput(false) : e };
    return {
      error: new ProviderError({ category: 'auth', code: 'key_unavailable', message: `the API key of connection '${conn.id}' is unavailable` }),
    };
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // A key that settles after a Stop must not surface as an unhandled rejection.
    pending.catch(() => undefined);
  }
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

  // The key first, so a slow key command never holds a place on the origin.
  const keyed = await resolveKey(input.conn, input.turnSignal);
  if ('stopped' in keyed) {
    out.stopped = true;
    return done();
  }
  if ('error' in keyed) {
    out.error = keyed.error;
    return done();
  }

  // The semaphore: a Stop while queued leaves the queue and ends the call as stopped.
  const sem = input.sched.forOrigin(input.conn.origin, capacityOf(input.caps));
  let slot;
  try {
    slot = await sem.acquire('interactive', input.turnSignal);
  } catch {
    out.stopped = true;
    return done();
  }

  const call = childController(input.turnSignal);
  const watch = new ActivityWatch(call, input.timeouts, timers);

  let finished = false;
  try {
    const stream = input.conn.provider.stream(modelRequest(input, call.signal), {
      fetch: input.fetch,
      key: keyed.key,
      onActivity: () => watch.bytes(),
    });
    for await (const ev of stream as AsyncIterable<StreamEv>) {
      watch.event();
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
        input.onUsage?.(ev.u);
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
    const timedOut = why === 'timeout:first_byte' || why === 'timeout:idle';
    if (finished) {
      // A stall or a network drop while waiting for usage/[DONE]: the finished answer is kept with
      // the provider's finish and the failure is a tail error (only the usage is lost). A Stop now has
      // nothing left to stop and nothing failed: the answer is simply kept.
      if (timedOut) {
        out.tailError = new ProviderError({ category: 'network', code: 'timeout', message: 'the stream stalled after the answer finished', afterOutput: true });
      } else if (!call.signal.aborted) {
        out.tailError =
          e instanceof ProviderError
            ? e
            : new ProviderError({ category: 'network', code: 'unreachable', message: 'the stream broke off after the answer finished', afterOutput: true, detail: msg(e) });
      }
    } else if (timedOut) {
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
      // timing we do not know, so it counts as after output when anything arrived. Its own words are
      // kept for --debug only (§13).
      out.error = new ProviderError({ category: 'network', code: 'unreachable', message: 'the connection failed', afterOutput: out.output, detail: msg(e) });
    }
  } finally {
    watch.stop();
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
