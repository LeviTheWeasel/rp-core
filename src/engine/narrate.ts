// Ported from Bunraku:src/stage/provider/tool-loop.ts@702d8120 (sendWithTools: one provider call
// per round with every round streamed, the request only ever appended to, the round separator,
// ids unique across the turn, the echo rebuilt from the parsed arguments, the final send with
// tool_choice 'none' and the schemas still declared) and Bunraku:src/kit/loop/stop-core.ts@702d8120
// (the "same call, same observation three times in the last eight" guard). The lines ported here are
// Coneja-Chibi's; Levi's lines of tool-loop.ts (the result cap) live in tools/run.ts.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The narrator's call and its tool loop (ARCHITECTURE.md §7.1, §8.1, §8.3, §8.8, D-55).
//
// One call (streamCall): resolve the connection's key (M1b, D-73), take a place on the connection's
// origin semaphore (interactive priority), stream, turn every StreamEv into an outcome. Timeouts
// (first byte, idle) abort a child of the turn signal with a typed reason and come back as
// ProviderError 'timeout': a timeout is never reported as a Stop. They are measured on bytes, as
// §8.8 says ("Первый байт … Простой между чанками"): the provider reports every body chunk through
// ProviderEnv.onActivity, so SSE keep-alive comments (OpenRouter's ': OPENROUTER PROCESSING' while a
// reasoning model thinks, DeepSeek's ': keep-alive' while queued, llama.cpp's pings) keep a live
// server's call open even though they carry no event. M3: the call declares tools / tool_choice /
// stop, collects native calls and replay payloads, and ends quietly FINISH_GRACE_MS after a finish.
//
// The loop (narrateRounds, .notes/m3-decisions.md B): every round of one route. Port notes. Kept
// from Bunraku: the request is never re-assembled inside the turn; text accumulates across rounds
// [D-16]; the separator goes through the same path as the text (events and chk); ids unique across
// the turn with `call_<round>_<i>`; the echo is the parsed arguments; the final round keeps the
// schemas. Changed: the separator is lazy (only before a round's first visible text, so the stream
// never ends in a stray "\n" and nothing is trimmed); non-final rounds send toolChoice 'auto'
// explicitly; the batch runs in parallel (tools/run.ts); calls on the final round are refused, traced
// and told (Bunraku dropped them silently); Stop yields a typed result with 'cancelled' results
// instead of throwing; the loop guard counts ANY triple in the window (stop-core anchored on the
// newest key only, so a parallel batch [A, A, A, B] never tripped it) over canonical arguments and
// a sha-1 of the result; a call ceiling, a tool room and a final cue; the prompted transport and
// leak recovery. Not ported: the read-only gate (rp-core tools are 'read' by type), the 12 000-char
// default cap (DEFAULT_TOOL_OUTPUT), `full` text events.

import { createHash } from 'node:crypto';
import { abortWith, childController, reasonOf, type DelayTimers } from './abort.ts';
import type { Scheduler } from './sched.ts';
import type { Connection } from './api.ts';
import { ProviderError } from '../providers/types.ts';
import { echoPlaceholders, SAFE_ID, SAFE_NAME } from '../providers/wire.ts';
import type { CallAgent, FinishReason, JSONSchema, ModelCaps, ModelRequest, PromptMsg, Replay, StreamEv, ToolSpec, Usage } from '../providers/types.ts';
import type { Block, ToolTraceRow, Trace } from '../session/entries.ts';
import { historyPageChars } from '../tools/builtin/history.ts';
import { recoverLeaks } from '../tools/leaks.ts';
import { createPromptedStripper, cutAtPromptedStop, frameResults, parsePromptedCalls, PROMPTED_STOP, stripPromptedCalls } from '../tools/prompted.ts';
import { runTools } from '../tools/run.ts';
import type { Tool, ToolCall, ToolCallOutcome, ToolCtx } from '../tools/types.ts';
import type { Samplers } from '../formats/native.ts';
import { CYRILLIC_CHARS_PER_TOKEN, MESSAGE_OVERHEAD_TOKENS } from '../prompt/tokens.ts';

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
  /**
   * M3: what the call declares. tools (sorted) and toolChoice go to the request as given; stop, when
   * set, replaces samplers.stop (the round loop adds PROMPTED_STOP to the sampler stops).
   */
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  stop?: string[];
  /** M4 (D-98): who the call is for (ModelRequest.agent); absent = 'narrator'. */
  agent?: CallAgent;
  /** M4 (D-98): the structured transport's schema (openai-chat sends it as response_format). */
  responseSchema?: { name: string; schema: JSONSchema };
  /** M4 (D-101): called once, right after the call got its semaphore slot (an agent's budget starts here). */
  onSlot?(): void;
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
  /**
   * M3: the native tool calls the stream carried (tool_start / tool_args / tool_end), in index order,
   * args as the raw concatenated fragments. A call still open when the stream failed or stopped is
   * left out. [] without tools.
   */
  calls: { id: string; name: string; args: string }[];
  /** M3: replay payloads (StreamEv 'replay'), for this round's wire message only (§8.6). */
  replay: Replay[];
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
export type RequestFields = Pick<
  CallInput,
  'conn' | 'model' | 'caps' | 'messages' | 'prefill' | 'maxTokens' | 'samplers' | 'reasoning' | 'callKey' | 'tools' | 'toolChoice' | 'stop' | 'agent' | 'responseSchema'
>;

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
    agent: input.agent ?? 'narrator',
  };
  if (input.prefill !== undefined && input.prefill !== '') req.prefill = input.prefill;
  if (input.reasoning !== undefined) req.reasoning = input.reasoning;
  // M3: a round's stop list (prompted: the sampler stops + PROMPTED_STOP) replaces the samplers'.
  const stop = input.stop ?? input.samplers.stop;
  if (stop && stop.length > 0) req.stop = stop;
  if (input.tools !== undefined && input.tools.length > 0) {
    req.tools = input.tools;
    if (input.toolChoice !== undefined) req.toolChoice = input.toolChoice;
  }
  if (input.responseSchema !== undefined) req.responseSchema = input.responseSchema;
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
  /** The finish arrived: from now on silence for FINISH_GRACE_MS ends the call quietly. */
  private graced = false;
  private grace: unknown = null;

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
    if (this.graced) {
      // After the finish both deadlines run: the grace ends the call quietly (the answer is complete,
      // only the tail is missing); an idle limit set shorter than the grace still counts as a stall.
      if (this.grace !== null) this.timers.clearTimeout(this.grace);
      this.grace = this.timers.setTimeout(() => {
        this.grace = null;
        if (!this.stopped && !this.call.signal.aborted) this.call.abort(new FinishGrace());
      }, FINISH_GRACE_MS);
    }
    this.idle = this.timers.setTimeout(() => {
      this.idle = null;
      this.idleOver = true;
      if (this.evented || this.firstOver) this.fire();
    }, this.t.idleMs);
  }

  /** Rev 11 note 37: the finish arrived; what may follow (usage, [DONE]) gets FINISH_GRACE_MS of silence. */
  finished(): void {
    if (this.stopped || this.graced) return;
    this.graced = true;
    if (this.first !== null) this.timers.clearTimeout(this.first);
    this.first = null;
    this.bytes();
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
    if (this.grace !== null) this.timers.clearTimeout(this.grace);
    this.first = this.idle = this.grace = null;
  }

  private fire(): void {
    if (this.stopped) return;
    abortWith(this.call, this.evented ? 'timeout:idle' : 'timeout:first_byte');
  }
}

/** The abort value of a call ended by the finish grace (not an AbortReason: it is neither a Stop nor a timeout). */
class FinishGrace extends Error {
  constructor() {
    super('the stream went quiet after its finish');
    this.name = 'FinishGrace';
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
  const out: CallResult = { text: '', reasoning: '', calls: [], replay: [], stopped: false, output: false, ms: 0 };
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
  // M4 (D-101): the agent's budget starts now; the wait in the queue is not counted. A throwing
  // callback is the caller's bug: the place is given back before it propagates.
  if (input.onSlot) {
    try {
      input.onSlot();
    } catch (e) {
      slot.release();
      throw e;
    }
  }

  const call = childController(input.turnSignal);
  const watch = new ActivityWatch(call, input.timeouts, timers);

  let finished = false;
  // M3: native calls by stream index; `closed` once tool_end arrived.
  const open = new Map<number, { id: string; name: string; args: string; closed: boolean }>();
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
      } else if (ev.t === 'tool_start') {
        // A call is output: the round can no longer be retried (§6.6).
        if (out.ttftMs === undefined) out.ttftMs = Math.max(0, clock().getTime() - t0);
        out.output = true;
        open.set(ev.i, { id: ev.id, name: ev.name, args: '', closed: false });
      } else if (ev.t === 'tool_args') {
        const c = open.get(ev.i);
        if (c && !c.closed) c.args += ev.d;
      } else if (ev.t === 'tool_end') {
        const c = open.get(ev.i);
        if (c) c.closed = true;
      } else if (ev.t === 'replay') {
        out.replay.push(ev.r);
      } else if (ev.t === 'usage') {
        out.usage = { ...out.usage, ...ev.u };
        input.onUsage?.(ev.u);
      } else if (ev.t === 'finish') {
        // Keep reading: usage may follow the finish (§8.1), for FINISH_GRACE_MS of silence at most.
        out.finish = { reason: providerFinish(ev.reason), raw: ev.raw };
        if (ev.model) out.served = ev.model;
        finished = true;
        watch.finished();
      } else if (ev.t === 'error') {
        // After the finish the answer is complete: an error now only costs the usage (§19.2: an
        // answer in hand is never thrown away). The finish grace ending the call is no error at all.
        if (finished) {
          if (!(call.signal.reason instanceof FinishGrace)) out.tailError = ev.err;
        } else {
          out.error = ev.err;
          if (ev.afterOutput || ev.err.afterOutput) out.output = true;
        }
        break;
      }
      // reasoning_end carries nothing the loop needs (reasoning is one raw block per round).
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

  // Index order. At a finish every call is whole (the adapter closes them before it); otherwise a
  // call whose tool_end never came is left out.
  out.calls = [...open.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.closed || finished)
    .map(([, c]) => ({ id: c.id, name: c.name, args: c.args }));

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

// ---- M3: the tool loop (§7.1, §8.3, §9.1, D-55) ---------------------------------------------------
// CONTRACT (M3): types and constants fixed by the architect; the loop agent implements narrateRounds
// and the streamCall changes (tools/toolChoice/stop into the request, native calls and replay
// collected, the finish grace). See .notes/m3-decisions.md.

/** D-55: rounds above this are clamped (notice 'tool_rounds_clamped'). */
export const MAX_TOOL_ROUNDS = 8;
/** §7, §11: model calls of one turn (the narrator's retries and fallback included). */
export const CALL_CEILING = 12;
/** §7.1 loop guard: a (name, canonical args, result hash) seen GUARD_REPEATS times among the last GUARD_WINDOW calls. */
export const GUARD_WINDOW = 8;
export const GUARD_REPEATS = 3;
/** Below this many tokens of tool room the next round is the final one. */
export const MIN_ROOM_TOKENS = 256;
/**
 * Rev 11 note 37: after a `finish`, a stream that goes quiet for this long is over (some servers
 * never send [DONE]); the call keeps its finish, the missing tail is not an error.
 */
export const FINISH_GRACE_MS = 3_000;
/**
 * §7.1 finalCue: appended to the final round of a loop that ran tools (round > 0). Native: its own
 * message (role 'system' when caps.midSystem is 'native' or 'anthropic-native', else 'user'; src
 * 'core:final_cue'); prompted: after the results, inside the same user message (frameResults cue).
 */
export const FINAL_CUE =
  'Tool use is over for this reply. Continue the scene now: write the rest of the reply in the story\'s own voice and language. ' +
  'Do not call tools, do not mention them, and do not repeat what you already wrote in this reply.';

/** The tools a turn offers, fixed for the turn (engine/request.ts builds it). */
export interface TurnTools {
  transport: 'native' | 'prompted';
  /** The dispatch table: exactly the tools the request declares. */
  tools: ReadonlyMap<string, Tool>;
  /** What the request declares (sorted by name; the core block lists the same). */
  specs: ToolSpec[];
  /** The per-turn tool context, without the per-round signal and pageChars. */
  ctx: Omit<ToolCtx, 'signal' | 'pageChars'>;
  /** assemble's toolRoom (budget tokens) and the window it came from (for pageChars). */
  roomTokens: number;
  window: number;
  /** The model's EMA token correction (budget tokens = raw estimate × factor). */
  tokenFactor: number;
  /**
   * The request's token counter (raw tokens of a text), for what each round adds to the wire; absent:
   * the conservative Cyrillic estimate (characters / 2.5).
   */
  count?(text: string): number;
}

/** One model call of the loop, as the turn records it (usage event, trace.calls, debug tap). */
export interface RoundCall {
  callKey: string;
  round: number;
  res: CallResult;
}

export interface RoundsInput extends Omit<CallInput, 'onText' | 'onReasoning' | 'onUsage' | 'callKey' | 'tools' | 'toolChoice' | 'stop'> {
  turnId: string;
  /** null: no tools this turn — exactly one call, as in M2 (no stripper, no stop, no core block). */
  tools: TurnTools | null;
  /** config.narrator.maxRounds, already clamped to 1..MAX_TOOL_ROUNDS. */
  maxRounds: number;
  /** Model calls the turn made before this loop (a retried round 0), for CALL_CEILING. */
  callsBefore: number;
  /** Visible text, in order: the D-55 separator and the prompted stripper's output go through here. */
  onText(delta: string): void;
  onReasoning(delta: string): void;
  /** Tool events (the turn stamps turnId): 'start' when a call is dispatched, 'done' with its outcome. */
  onTool(ev: { phase: 'start' | 'done'; round: number; callId: string; name: string; args?: unknown; ok?: boolean; summary?: string }): void;
  /** After every model call. */
  onCall(call: RoundCall): void;
  /**
   * A notice the turn emits (level warn) under its once-per-session rule, kept under `key` (default:
   * the code): 'tool_calls_on_final_round'; 'caps.suggest' when a request that echoed the reasoning
   * placeholder was refused with HTTP 400 (D-94 revised).
   */
  onNotice(code: string, message: string, key?: string): void;
}

export interface RoundsResult {
  /**
   * Storage blocks in order, per round: reasoning (if any), text (the round's visible text; omitted
   * when empty), tool_call per call, tool_result per call (paired, same order). Text is NOT
   * post-processed (leak stripping is the turn's step 9), except that the spans leak recovery turned
   * into calls (§8.3: JSON in prose, other dialects' markup) are left out of the round's text block, as
   * of its wire text (`salvaged` counts them). Without tools: [reasoning?, text?] (the turn commits a
   * one-round answer the M2 way, [reasoning?, text] with the text even when empty).
   */
  blocks: Block[];
  /**
   * All visible text: exactly what onText received. The concatenation of the text blocks equals it
   * unless `salvaged` > 0 (the events and chk keep what streamed, as with step 9's markup).
   */
  text: string;
  /** Leaked call spans recovered into calls and left out of the text blocks (step 9 tells them). */
  salvaged?: number;
  /**
   * `<tool_call>` blocks and offered tools' names used as tags (D-97) the stripper kept out of the
   * visible text that did not become a run call: in a native round an echo of a native call, a tool
   * not offered, an unreadable block; on the final round (B9) every one of them, since none runs.
   * Step 9 tells them.
   */
  hidden?: number;
  reasoning: string;
  /** Model calls the loop made (the final round included). */
  rounds: number;
  ended: NonNullable<Trace['rounds']>['ended'];
  /** The last call's finish; 'max_rounds' when the final round's calls were ignored (§7.1). */
  finish?: { reason: FinishReason; raw: string };
  error?: ProviderError;
  tailError?: ProviderError;
  stopped: boolean;
  /** Text, reasoning or a tool call arrived in any round (retry/fallback only before this). */
  output: boolean;
  /** Usage summed over the loop's calls (cost summed only when every call reported one). */
  usage?: Usage;
  /** Round 0's usage: the EMA sample and the server-window check compare it with the estimate. */
  firstUsage?: Usage;
  served?: string;
  ttftMs?: number;
  ms: number;
  /** Trace.tools rows, in call order (final-round calls marked refused 'final_round'). */
  toolRows: ToolTraceRow[];
  /** Tool room left at the end (budget tokens). */
  roomLeft: number;
}

/**
 * The narrator's loop for one route (§7.1): every round streamed, a final text-only round after
 * tools ran, the loop guard, the call ceiling, the tool room, Stop pairing. Never throws for
 * provider or tool trouble. Retry and fallback are the turn's: it calls this again only while the
 * result has no output. See .notes/m3-decisions.md for every rule.
 */
export async function narrateRounds(input: RoundsInput): Promise<RoundsResult> {
  const { tools, clock } = input;
  const t0 = clock().getTime();
  const out: RoundsResult = {
    blocks: [],
    text: '',
    reasoning: '',
    rounds: 0,
    ended: 'answer',
    stopped: false,
    output: false,
    ms: 0,
    toolRows: [],
    roomLeft: tools?.roomTokens ?? 0,
  };
  const usages: Usage[] = [];
  // Only ever appended to (a new array per round: a request already sent keeps its messages).
  let wire: PromptMsg[] = input.messages;
  /** Call ids of the turn: unique across rounds (§8.3). */
  const used = new Set<string>();
  /** Guard keys of the turn's last GUARD_WINDOW calls, oldest first. */
  const recent: string[] = [];
  let guard = false;
  const offered = tools === null ? [] : tools.specs.map((s) => s.name);
  // The echo of a round's own reasoning inside the loop (§8.6): the adapter places it per caps. Off
  // only when this call turns thinking off (the adapter's rule: 'none' on a model that can disable it);
  // a model that cannot stop thinking keeps its chain of thought inside the turn.
  const echo = input.caps.reasoning.echo !== 'never' && !(input.reasoning === 'none' && input.caps.reasoning.canDisable);
  /**
   * Budget tokens the loop appended to the wire so far (not clamped at 0 like roomLeft). Whatever goes
   * beyond the room is taken from later rounds' max_tokens, so prompt + max_tokens stays within the
   * window assemble packed round 0 for (window − reserve − room).
   */
  let added = 0;
  /**
   * The text blocks stored so far, joined (what the committed message and the next turn's history
   * read). D-55's separator in storage is decided on it, not on the stream: a recovered span the
   * stored text leaves out may have carried the whitespace that made the stream's separator needless.
   */
  let stored = '';
  /** A round's stored text block: its body, behind the separator when the stored text needs one. */
  const textBlock = (body: string): Block[] => {
    if (body === '') return [];
    const text = storedSeparator(stored, body) + body;
    stored += text;
    return [{ k: 'text', text }];
  };

  const settle = (): RoundsResult => {
    const usage = sumUsage(usages);
    if (usage) out.usage = usage;
    out.ms = Math.max(0, clock().getTime() - t0);
    return out;
  };

  /** Why round `round` has to be the final one (B3), or null when it may still call tools. */
  const forcedAt = (round: number): Forced | null => {
    if (round >= input.maxRounds) return 'max_rounds';
    if (input.callsBefore + out.rounds + 1 >= CALL_CEILING) return 'ceiling';
    if (guard) return 'guard';
    if (out.roomLeft < MIN_ROOM_TOKENS) return 'room';
    return null;
  };

  /** B8: the server's id when it is SAFE_ID and new in the turn, else call_<round>_<i> (_2… on collision). */
  const idFor = (server: string | undefined, round: number, i: number): string => {
    if (server !== undefined && SAFE_ID.test(server) && !used.has(server)) {
      used.add(server);
      return server;
    }
    const base = `call_${round}_${i}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  };

  for (let round = 0; ; round++) {
    const forced = tools === null ? null : forcedAt(round);
    const last = tools === null || forced !== null;
    const callKey = `${input.turnId}:narrator:${round}`;

    // Visible text: every round with tools passes the prompted stripper (a Qwen-style <tool_call>
    // in a native round never reaches events or chk either, nor an offered tool's name used as a
    // tag, D-97); the D-55 separator goes out lazily, right before the round's first visible text,
    // and belongs to this round's text block.
    const stripper = tools === null ? null : createPromptedStripper(tools.specs);
    let shown = '';
    let said = '';
    const emit = (d: string): void => {
      shown += d;
      out.text += d;
      input.onText(d);
    };
    const show = (d: string): void => {
      if (d === '') return;
      if (shown === '' && out.text !== '' && !/\s$/.test(out.text)) emit('\n');
      said += d;
      emit(d);
    };

    const messages = tools?.transport === 'native' && last && round > 0 ? [...wire, finalCueMessage(input.caps)] : wire;
    const fields = roundFields(tools, input.caps, input.samplers, last);
    const res = await streamCall({
      conn: input.conn,
      model: input.model,
      caps: input.caps,
      messages,
      // A prefill only in a turn without tools [D-28].
      ...(tools === null && input.prefill !== undefined ? { prefill: input.prefill } : {}),
      // C6: what the loop added beyond the room comes out of this round's reply (round 0: nothing yet).
      maxTokens: tools === null ? input.maxTokens : roundMaxTokens(input.maxTokens, added, tools.roomTokens),
      samplers: input.samplers,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      callKey,
      turnSignal: input.turnSignal,
      sched: input.sched,
      fetch: input.fetch,
      timeouts: input.timeouts,
      timers: input.timers,
      clock,
      ...fields,
      onText: (d) => show(stripper === null ? d : stripper.push(d)),
      onReasoning: (d) => {
        out.reasoning += d;
        input.onReasoning(d);
      },
    });
    // What the stripper still held (trailing whitespace, a partial tag that never completed).
    if (stripper !== null) show(stripper.end());

    out.rounds++;
    if (res.usage) usages.push(res.usage);
    if (round === 0) {
      if (res.usage) out.firstUsage = res.usage;
      if (res.ttftMs !== undefined) out.ttftMs = res.ttftMs;
    }
    if (res.served !== undefined) out.served = res.served;
    if (res.tailError && !out.tailError) out.tailError = res.tailError;
    if (res.output) out.output = true;
    input.onCall({ callKey, round, res });
    // D-94 (revised): the server refused a request that echoed the placeholder on an answer without
    // reasoning of its own; the way out is to turn this model's tools off (told once per session).
    // Only a plain refusal: a 400 that says the context is too long (context_length_exceeded keeps
    // its status) is no verdict on the placeholder and must not use the once-per-session notice up.
    if (res.error?.status === 400 && res.error.code === 'bad_request' && echoPlaceholders({ caps: input.caps, reasoning: input.reasoning, messages, ...fields }) > 0) {
      input.onNotice('caps.suggest', echoRefusedMessage(`${input.conn.id}:${input.model}`), ECHO_REFUSED_KEY);
    }

    // The round's own blocks (B6): its raw reasoning, then its visible text (textBlock, below).
    const thought: Block[] = res.reasoning.trim() !== '' ? [{ k: 'reasoning', text: res.reasoning }] : [];

    // Stop or failure (B12): what streamed stays; the round's calls are dropped (none ran).
    if (res.stopped || res.error) {
      out.blocks.push(...thought, ...textBlock(said));
      if (res.error) out.error = res.error;
      out.stopped = res.stopped;
      out.ended = res.stopped ? 'stopped' : 'error';
      return settle();
    }
    if (res.finish) out.finish = res.finish;
    if (tools === null) {
      out.blocks.push(...thought, ...textBlock(said));
      return settle();
    }

    const got = roundCalls(tools.transport, res, offered, tools.specs);
    // On the final round no call runs: every block the stripper kept out of the text is hidden markup.
    const hidden = last ? got.markup : got.hidden;
    if (hidden > 0) out.hidden = (out.hidden ?? 0) + hidden;
    if (got.found.length === 0) {
      out.blocks.push(...thought, ...textBlock(said));
      out.ended = forced ?? 'answer';
      return settle();
    }
    const calls: ToolCall[] = got.found.map((f, i) => ({ id: idFor(f.server, round, i), name: f.name, args: f.args, round, via: f.via }));

    // §8.3: a leak recovered into a call is either run or refused, never also kept as story. The
    // round's visible text without the recovered spans is its native wire text AND its stored text
    // (behind the separator the stored text needs); the events and chk keep what streamed, as step 9
    // does for markup, and the turn counts the spans into its tool_markup_stripped notice.
    const visible = got.recovered !== undefined ? stripPromptedCalls(got.recovered, tools.specs) : said;
    // (A Qwen-style <tool_call> in a native round never reached the visible text: nothing changes then.)
    if (got.recovered !== undefined && visible !== said) out.salvaged = (out.salvaged ?? 0) + got.spans;
    const head: Block[] = [...thought, ...textBlock(visible)];

    // B9: the model called on the text-only final round (it ignored 'none'): nothing runs, nothing
    // is stored but the text; the trace and a notice say so.
    if (last) {
      out.blocks.push(...head);
      for (const c of calls) out.toolRows.push({ round, callId: c.id, name: safeName(c.name), ok: false, refused: 'final_round' });
      input.onNotice(
        'tool_calls_on_final_round',
        `The model called tools on its final, text-only round (tool_choice 'none' was not honoured); ${calls.length === 1 ? 'the call was' : `the ${calls.length} calls were`} not run.`,
      );
      out.finish = { reason: 'max_rounds', raw: res.finish?.raw ?? '' };
      out.ended = forced ?? 'max_rounds';
      return settle();
    }

    // The round's wire messages (B7, B8). Native: the visible text (recovered spans and the separator
    // left out), this call's own reasoning when echoed, the call echoes, the round's replay payloads
    // keyed by the loop's ids; then ONE 'tool' message. Prompted: the raw round text, tags kept (§8.3:
    // a model that never sees its calls stops making them), cut at a hallucinated <tool_result>; then
    // ONE user message with the results (and the final cue, B4).
    const own = echo && res.reasoning !== '' ? res.reasoning : '';
    const replay = rekeyReplay(res.replay, got.found, calls);
    const assistantOf = (echoes: readonly Echo[]): PromptMsg =>
      tools.transport === 'native'
        ? {
            role: 'assistant',
            src: ROUND_SRC,
            blocks: [
              ...(own !== '' ? [{ k: 'reasoning', text: own } as Block] : []),
              ...(visible !== '' ? [{ k: 'text', text: visible } as Block] : []),
              ...echoes.map((e): Block => ({ k: 'tool_call', id: e.id, name: e.name, args: e.args })),
            ],
            ...(replay.length > 0 ? { replay } : {}),
          }
        : { role: 'assistant', src: ROUND_SRC, blocks: [{ k: 'text', text: cutAtPromptedStop(res.text) }] };
    const answersOf = (results: readonly Answer[], cue: boolean): PromptMsg =>
      tools.transport === 'native'
        ? {
            role: 'tool',
            src: RESULTS_SRC,
            blocks: results.map((r): Block => ({ k: 'tool_result', callId: r.id, name: r.name, text: r.text, ...(r.error ? { error: true } : {}) })),
          }
        : { role: 'user', src: RESULTS_SRC, blocks: [{ k: 'text', text: frameResults(results, cue ? FINAL_CUE : undefined) }] };
    /** The native final cue is its own message on the final round; the prompted one rides the results. */
    const cueCost = tools.transport === 'native' ? spent(tools, [finalCueMessage(input.caps)]) : 0;

    // C6: the room is what the loop may add to the wire. This round's assistant message (the echoes
    // with the raw arguments), the results message's shell and the final cue (every loop that ran
    // tools ends with a final round) take their part first; the results get what is left.
    const shell = calls.map((c, i): Answer => ({ id: c.id, name: safeName(c.name), text: '', ...(got.found[i]!.error !== undefined ? { error: true } : {}) }));
    const raw = calls.map((c, i): Echo => ({ id: c.id, name: safeName(c.name), args: got.found[i]!.args.trim() === '' ? '{}' : got.found[i]!.args }));
    const reserved = spent(tools, [assistantOf(raw), answersOf(shell, true)]) + cueCost;
    const room = roomChars(Math.max(0, out.roomLeft - reserved), tools.tokenFactor);

    // Run the batch (tools/run.ts): in parallel, in call order, each result cut to its share of the room.
    for (const [i, c] of calls.entries()) {
      const args = startArgs(got.found[i]!);
      input.onTool({ phase: 'start', round, callId: c.id, name: safeName(c.name), ...(args !== undefined ? { args } : {}) });
    }
    // A child of the turn signal: Stop reaches every tool (§6.5, §6.8).
    const signal = childController(input.turnSignal).signal;
    // An unreadable prompted block is not run: its error is its result (B7).
    const unreadable = got.found.reduce((n, f) => n + (f.error?.length ?? 0), 0);
    const runnable = calls.filter((_, i) => got.found[i]!.error === undefined);
    const runBatch = async (chars: number): Promise<ToolCallOutcome[]> => {
      if (runnable.length === 0) return [];
      const ctx: ToolCtx = { ...tools.ctx, signal, pageChars: Math.min(historyPageChars(tools.window), chars) };
      return runTools({ calls: runnable, tools: tools.tools, ctx, roomChars: Math.max(0, chars - unreadable) }, clock);
    };
    let ran = await runBatch(room);
    // The characters of the room assume CYRILLIC_CHARS_PER_TOKEN; the turn's counter may measure the
    // results denser (CJK, lists of names). Then the batch runs once more (v1 tools only read) in the
    // room scaled by what the counter measured, so the results fit the room in tokens and the tools
    // page themselves again; a small overshoot is left to roundMaxTokens.
    const free = Math.max(0, out.roomLeft - reserved);
    const measured = textsCost(tools, [...ran.map((o) => o.text), ...got.found.flatMap((f) => (f.error !== undefined ? [f.error] : []))]);
    if (!signal.aborted && measured > free + Math.max(Math.ceil(free / 10), calls.length * 2)) {
      const scaled = Math.floor((room * free) / measured);
      if (scaled < room) ran = await runBatch(scaled);
    }
    let next = 0;
    const outcomes: ToolCallOutcome[] = calls.map((c, i) => {
      const error = got.found[i]!.error;
      if (error === undefined) return ran[next++]!;
      return { call: c, echoName: safeName(c.name), echoArgs: '{}', ok: false, text: error, summary: 'bad arguments', refused: 'bad_args', ms: 0 };
    });
    for (const o of outcomes) {
      input.onTool({ phase: 'done', round, callId: o.call.id, name: o.echoName, ...(o.parsed !== undefined ? { args: o.parsed } : {}), ok: o.ok, summary: o.summary });
    }

    // Storage stays paired (B6): every call with its result, a Stop's included ('cancelled').
    out.blocks.push(
      ...head,
      ...outcomes.map((o): Block => ({ k: 'tool_call', id: o.call.id, name: o.echoName, args: o.echoArgs })),
      ...outcomes.map((o): Block => ({ k: 'tool_result', callId: o.call.id, name: o.echoName, text: o.text, ...(o.ok ? {} : { error: true }) })),
    );
    for (const o of outcomes) out.toolRows.push(traceRow(o, round));
    if (input.turnSignal.aborted) {
      out.stopped = true;
      out.ended = 'stopped';
      return settle();
    }

    // B10: the loop guard over the turn's last GUARD_WINDOW calls.
    for (const o of outcomes) recent.push(guardKey(o));
    if (recent.length > GUARD_WINDOW) recent.splice(0, recent.length - GUARD_WINDOW);
    if (!guard && guardTripped(recent)) guard = true;

    // The wire grows by this round, and the room shrinks by what it really added (C6); when the next
    // round is the final one, by its cue too.
    const assistant = assistantOf(outcomes.map((o): Echo => ({ id: o.call.id, name: o.echoName, args: o.echoArgs })));
    const results = outcomes.map((o): Answer => ({ id: o.call.id, name: o.echoName, text: o.text, ...(o.ok ? {} : { error: true }) }));
    let answers = answersOf(results, false);
    let cost = spent(tools, [assistant, answers]);
    out.roomLeft = Math.max(0, out.roomLeft - cost);
    if (forcedAt(round + 1) !== null) {
      const cued = answersOf(results, true);
      const extra = tools.transport === 'native' ? cueCost : Math.max(0, spent(tools, [assistant, cued]) - cost);
      answers = cued;
      cost += extra;
      out.roomLeft = Math.max(0, out.roomLeft - extra);
    }
    added += cost;
    wire = [...wire, assistant, answers];
  }
}

// ---- loop helpers ---------------------------------------------------------------------------------

/** Why a loop had to end with a final round (Trace.rounds.ended without the free endings). */
type Forced = 'max_rounds' | 'ceiling' | 'guard' | 'room';

/** src of the messages the loop appends to its wire (in memory only: never stored, never traced). */
export const FINAL_CUE_SRC = 'core:final_cue';
export const ROUND_SRC = 'core:round';
export const RESULTS_SRC = 'core:tool_results';

/** A call's name as events, storage and the trace show it: 'invalid_tool' for a name no dialect takes. */
const safeName = (name: string): string => (SAFE_NAME.test(name) ? name : 'invalid_tool');

/** A call echo on a round's wire assistant message. */
interface Echo {
  id: string;
  name: string;
  args: string;
}

/** A result on a round's wire results message. */
interface Answer {
  id: string;
  name: string;
  text: string;
  error?: boolean;
}

/**
 * D-55 in storage: the separator a stored text block takes in front of `body`, decided on the text
 * stored before it (`before`, the earlier text blocks joined): '\n' when that text is not empty and
 * does not end in whitespace. While nothing was left out of the stored text this is exactly the
 * stream's lazy separator; when a recovered or stripped span took the whitespace with it, it keeps
 * two rounds from gluing together, and nothing stored before means no separator at all.
 */
export function storedSeparator(before: string, body: string): string {
  return body !== '' && before !== '' && !/\s$/.test(before) ? '\n' : '';
}

/** The once-per-session key of the notice for a refused echo placeholder (D-94 revised). */
export const ECHO_REFUSED_KEY = 'caps.suggest:echo_placeholder';

/** D-94 (revised): what to do when a server refuses the reasoning placeholder (`label` is 'conn:model'). */
export function echoRefusedMessage(label: string): string {
  return (
    `${label} refused a tool request (HTTP 400). With tools it needs the reasoning of every earlier answer back; answers without ` +
    `their own (a greeting, another model's, one written with thinking off) were sent a placeholder. If it keeps refusing, turn ` +
    `this model's tools off: tools = "none" under [caps."${label}"] in config.toml.`
  );
}

/**
 * C6: a round's max_tokens. The room (assemble kept it free) holds what the loop adds to the wire;
 * whatever the loop added beyond it (text written before a call, a result the counter measures above
 * the 2.5 chars/token cap) comes out of the reply, so prompt + max_tokens stays within the window.
 * Round 0 (nothing added) asks for the whole reserve, as M2 does. Never below 1.
 */
export function roundMaxTokens(maxTokens: number, added: number, roomTokens: number): number {
  const over = Math.max(0, added - Math.max(0, roomTokens));
  return over === 0 ? maxTokens : Math.max(1, maxTokens - Math.ceil(over));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * B8: a round's replay payloads keyed by the loop's call ids. A server id the loop renamed (not
 * SAFE_ID, or already used in the turn) keyed its 'tool_extra' entry (Gemini's thought signature),
 * and the adapter looks extras up by the id the wire carries: each call takes its server id's entry
 * under its own id; keys of no call of the round stay. A 'reasoning_details' entry whose `id` names a
 * renamed call (OpenRouter ties a Gemini signature to its call that way) follows the rename. Payloads
 * without a rename are returned as they are.
 */
export function rekeyReplay(replay: readonly Replay[], found: readonly { server?: string }[], calls: readonly { id: string }[]): Replay[] {
  const servers = new Set<string>();
  /** Server ids some call of the round kept as its own: their payloads stay with that call. */
  const kept = new Set<string>();
  found.forEach((f, i) => {
    if (f.server === undefined) return;
    servers.add(f.server);
    if (calls[i]!.id === f.server) kept.add(f.server);
  });
  const renamed = new Map<string, string>();
  found.forEach((f, i) => {
    // A server id given to two calls of the round names neither unambiguously: first come first,
    // and the call that kept the id (the first one, when the id was safe and new) is that first.
    if (f.server !== undefined && !kept.has(f.server) && !renamed.has(f.server)) renamed.set(f.server, calls[i]!.id);
  });
  if (renamed.size === 0) return [...replay];
  /** The one call a server id's payload belongs to: the call that kept it, else the first renamed. */
  const ownerOf = (server: string): string | undefined => (kept.has(server) ? server : renamed.get(server));
  return replay.map((r): Replay => {
    if (r.kind === 'tool_extra' && isObject(r.payload)) {
      const from = r.payload;
      const payload: Record<string, unknown> = {};
      found.forEach((f, i) => {
        if (f.server !== undefined && Object.hasOwn(from, f.server) && ownerOf(f.server) === calls[i]!.id) payload[calls[i]!.id] = from[f.server];
      });
      for (const [k, v] of Object.entries(from)) if (!servers.has(k) && !Object.hasOwn(payload, k)) payload[k] = v;
      return { ...r, payload };
    }
    if (r.kind === 'reasoning_details' && Array.isArray(r.payload)) {
      const payload = r.payload.map((d: unknown) => (isObject(d) && typeof d['id'] === 'string' && renamed.has(d['id']) ? { ...d, id: renamed.get(d['id']) } : d));
      return { ...r, payload };
    }
    return r;
  });
}

/** B4: the native final cue, as its own message (system where mid-dialogue system is native, else user). */
export function finalCueMessage(caps: ModelCaps): PromptMsg {
  const role = caps.midSystem === 'native' || caps.midSystem === 'anthropic-native' ? 'system' : 'user';
  return { role, blocks: [{ k: 'text', text: FINAL_CUE }], src: FINAL_CUE_SRC };
}

/**
 * B7: a prompted round's stop list: the sampler's stops (blank and repeated ones dropped), then
 * PROMPTED_STOP. Over caps.stopMax the prompted stop stays and the sampler's last stops go.
 */
export function promptedStops(sampler: readonly string[] | undefined, stopMax?: number): string[] {
  const own = [...new Set((sampler ?? []).filter((s) => typeof s === 'string' && s !== '' && s !== PROMPTED_STOP))];
  const keep = stopMax !== undefined && Number.isFinite(stopMax) ? Math.max(0, Math.floor(stopMax) - 1) : own.length;
  return [...own.slice(0, keep), PROMPTED_STOP];
}

/**
 * The tool fields of one round's request (§7.1, §8.3): native → the specs and toolChoice ('none' on
 * the final round, the schemas still declared); prompted → no tools, the stop list; no tools → none
 * (exactly M2). Shared with the preview, whose wire is round 0's request.
 */
export function roundFields(
  tools: TurnTools | null,
  caps: ModelCaps,
  samplers: Partial<Samplers>,
  last: boolean,
): Pick<CallInput, 'tools' | 'toolChoice' | 'stop'> {
  if (tools === null) return {};
  if (tools.transport === 'native') return { tools: tools.specs, toolChoice: last ? 'none' : 'auto' };
  return { stop: promptedStops(samplers.stop, caps.stopMax) };
}

/** Round 0 is already the final one: the room is too small for a round of tools (never, once request.ts offered tools). */
export function firstRoundLast(tools: TurnTools | null, maxRounds: number): boolean {
  return tools !== null && (maxRounds < 1 || tools.roomTokens < MIN_ROOM_TOKENS || 1 >= CALL_CEILING);
}

/**
 * Usage summed over calls (B13): every count added; `cost` only when every call reported one (a
 * partial sum would read as the whole). One usage comes back as a copy of itself (M2's gen.usage).
 */
export function sumUsage(list: readonly Usage[]): Usage | undefined {
  if (list.length === 0) return undefined;
  if (list.length === 1) return { ...list[0] };
  const out: Usage = {};
  for (const u of list) {
    for (const k of Object.keys(u) as (keyof Usage)[]) {
      const v = u[k];
      if (k !== 'cost' && typeof v === 'number') out[k] = (out[k] ?? 0) + v;
    }
  }
  if (list.every((u) => typeof u.cost === 'number')) out.cost = list.reduce((n, u) => n + (u.cost ?? 0), 0);
  return out;
}

/** C6: budget tokens of room as characters (back to the counter's tokens, then the Cyrillic ratio). */
export function roomChars(tokens: number, tokenFactor: number): number {
  const f = Number.isFinite(tokenFactor) && tokenFactor > 0 ? tokenFactor : 1;
  return Math.max(0, Math.floor((Math.max(0, tokens) / f) * CYRILLIC_CHARS_PER_TOKEN));
}

/**
 * C6: the budget tokens a round's wire messages take from the room, measured as assemble measures
 * the prompt: every block (ids and names included) by the turn's counter, the per-message overhead,
 * times the model's correction.
 */
function spent(tools: TurnTools, messages: readonly PromptMsg[]): number {
  const count = tools.count ?? ((t: string) => Math.ceil(t.length / CYRILLIC_CHARS_PER_TOKEN));
  let raw = 0;
  for (const m of messages) {
    raw += MESSAGE_OVERHEAD_TOKENS;
    for (const b of m.blocks) {
      if (b.k === 'text' || b.k === 'reasoning') raw += count(b.text);
      else if (b.k === 'tool_call') raw += count(b.id) + count(b.name) + count(b.args);
      else if (b.k === 'tool_result') raw += count(b.callId) + count(b.name) + count(b.text);
    }
  }
  const f = Number.isFinite(tools.tokenFactor) && tools.tokenFactor > 0 ? tools.tokenFactor : 1;
  return Math.ceil(raw * f);
}

/** C6: the budget tokens of result texts alone (no ids, names or overhead), as spent() counts them. */
function textsCost(tools: TurnTools, texts: readonly string[]): number {
  const count = tools.count ?? ((t: string) => Math.ceil(t.length / CYRILLIC_CHARS_PER_TOKEN));
  const f = Number.isFinite(tools.tokenFactor) && tools.tokenFactor > 0 ? tools.tokenFactor : 1;
  return Math.ceil(texts.reduce((n, t) => n + count(t), 0) * f);
}

/** One call found in a round, before it has an id. */
interface Found {
  name: string;
  args: string;
  via: ToolCall['via'];
  /** The id the server gave a native call. */
  server?: string;
  /** B7: a prompted block that could not be read; this text is the call's result. */
  error?: string;
}

/**
 * A round's calls (B7, B8): native → the stream's calls, else complete leaks of offered tools in
 * the raw text (D-57; `recovered` = the text without them but for those inside a prompted-family
 * block, which the strip of the visible text removes as the stream did; `spans` = how many spans
 * left it); prompted → the <tool_call> blocks and the offered tools'
 * names used as tags (D-97; an unreadable one is still a call, named 'invalid_tool' when it has no
 * name), else leaks of other dialects. `markup`: the prompted-family blocks of the raw text (what
 * the stripper kept out of the visible text), `hidden`: those of them no call came from.
 */
function roundCalls(
  transport: 'native' | 'prompted',
  res: CallResult,
  offered: readonly string[],
  specs: readonly ToolSpec[],
): { found: Found[]; recovered?: string; spans: number; hidden: number; markup: number } {
  // The prompted family, as the stripper saw it: <tool_call> blocks and name tags (D-97).
  const tagged = parsePromptedCalls(res.text, specs);
  const markup = new Set(tagged.map((b) => b.start)).size;
  if (transport === 'prompted' && tagged.length > 0) {
    return {
      found: tagged.map((b) => ({ name: b.name ?? 'invalid_tool', args: b.args, via: 'prompted', ...(b.error !== undefined ? { error: b.error } : {}) })),
      spans: 0,
      hidden: 0,
      markup,
    };
  }
  // Native: the prompted stripper kept every block of the family out of the visible text. A block
  // that is not run (it echoes a native call, names a tool not offered, or cannot be read) is
  // counted as hidden markup, so the turn's tool_markup_stripped notice tells it. (A prompted round
  // gets here only without any such block.)
  const overlaps = (c: { start: number; end: number }, b: { start: number; end: number }): boolean => c.start < b.end && c.end > b.start;
  const hiddenOf = (ran: readonly { start: number; end: number }[]): number =>
    new Set(tagged.filter((b) => !ran.some((c) => overlaps(c, b))).map((b) => b.start)).size;
  if (res.calls.length > 0) {
    return { found: res.calls.map((c) => ({ name: c.name, args: c.args, via: 'native', server: c.id })), spans: 0, hidden: hiddenOf([]), markup };
  }
  // A recovered span inside a block of the family stays in `recovered`: the batch strip of the
  // visible text below removes it with the stream's own grouping and seams, so the stored text keeps
  // what streamed (removed span by span here, a run of adjacent blocks got another seam).
  const leaks = recoverLeaks(res.text, { offered, nativeCalls: 0, tools: specs, keep: tagged });
  if (leaks.calls.length === 0) {
    // §8.3 in a native round: a Qwen-style block left unclosed after a complete call (leak recovery
    // reads closed tags only), or a name tag left unclosed, is a call too, when every call of its
    // block names an offered tool.
    const spans = new Map<number, typeof tagged>();
    for (const b of tagged) spans.set(b.start, [...(spans.get(b.start) ?? []), b]);
    const taken = [...spans.values()].filter((list) => list.every((b) => b.error === undefined && b.name !== null && offered.includes(b.name))).flat();
    return { found: taken.map((b) => ({ name: b.name!, args: b.args, via: 'leak' })), spans: 0, hidden: hiddenOf(taken), markup };
  }
  // One span may hold several calls (they share its start). A span the stripper already hid (a
  // closed <tool_call> or name tag, kept in `recovered` above) never reached the visible text: it is
  // not counted as salvaged.
  const spans = new Set(leaks.calls.filter((c) => !tagged.some((b) => b.start <= c.start && c.end <= b.end)).map((c) => c.start)).size;
  return { found: leaks.calls.map((c) => ({ name: c.name, args: c.args, via: 'leak' })), recovered: leaks.text, spans, hidden: hiddenOf(leaks.calls), markup };
}

/** The arguments a 'start' event shows: the raw text when it is a JSON object as sent, else nothing. */
function startArgs(f: Found): Record<string, unknown> | undefined {
  if (f.error !== undefined) return undefined;
  try {
    const v: unknown = JSON.parse(f.args === '' ? '{}' : f.args);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A Trace.tools row (no arguments, no result text: §5.7 keeps the trace small). */
function traceRow(o: ToolCallOutcome, round: number): ToolTraceRow {
  return {
    round,
    callId: o.call.id,
    name: o.echoName,
    ok: o.ok,
    ...(o.repaired !== undefined && o.repaired.length > 0 ? { repaired: o.repaired } : {}),
    ...(o.refused !== undefined ? { refused: o.refused } : {}),
    ms: o.ms,
    chars: o.text.length,
    ...(o.cut ? { cut: true as const } : {}),
  };
}

/** B10: a settled call as the guard sees it: name, canonical arguments, sha-1 of what the model was told. */
function guardKey(o: ToolCallOutcome): string {
  return `${o.echoName}\u0000${o.echoArgs}\u0000${createHash('sha1').update(o.text).digest('hex')}`;
}

/** Any key GUARD_REPEATS times in the window (stop-core looked only at the newest key). */
function guardTripped(keys: readonly string[]): boolean {
  const seen = new Map<string, number>();
  for (const k of keys.slice(-GUARD_WINDOW)) {
    const n = (seen.get(k) ?? 0) + 1;
    if (n >= GUARD_REPEATS) return true;
    seen.set(k, n);
  }
  return false;
}
