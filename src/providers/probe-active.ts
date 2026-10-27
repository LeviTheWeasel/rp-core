// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Active probes (ARCHITECTURE.md §8.2 source 4, §7.2): what `rp-core probe --active` learns by
// calling the model. They go through the real provider (Provider.stream, the same adapter a turn
// uses) so what a probe saw is what a turn will see. A probe only advises: its facts are written to
// the caps cache only with --write, the user's [caps."conn:model"] still wins, and nothing is ever
// applied mid-session. Tools are probed with tool_choice 'auto' only — forcing a tool is the
// anti-example (RoleCall providers/tool-call-test.ts; it is a 400 on several Claude models, §7.2).
// Design: the scratch note m3-probe-deepseek.md §1.
// CONTRACT FILE (M3): signatures are fixed; the providers agent implements the body.
//
// Fresh code. Nothing is ported from RoleCall's tool-call-test.ts (forced choice, stream:false, one
// round, its own request builder); the probe texts below are new.
//
// How a call is watched: the provider gets a fetch that hands it the real response with its body
// read through a pass-through (record.ts passThrough), so the probe sees the bytes the adapter read:
// which delta field carried reasoning, whether usage (or llama.cpp timings) arrived, how a tool call
// was fragmented. Events (text, reasoning, tool_*) come from the adapter's own reader as usual.
// Evidence only: a probe writes a fact only when one of its calls showed it; an inconclusive call
// (timeout, a transient failure, a reply cut by the token cap) writes nothing, and its observation
// says 'inconclusive' rather than 'no'. A server error (5xx) before any output is asked once more
// (within ACTIVE_PROBE_MAX_CALLS): one 500 is an Ollama runner crash or an overloaded proxy as often
// as a refusal; llama.cpp without --jinja answers the tools field with a 500 every time.

import { abortWith, childController, realTimers, reasonOf, type AbortReason, type DelayTimers } from '../engine/abort.ts';
import { FINISH_GRACE_MS, FIRST_BYTE_LOCAL_MS, FIRST_BYTE_REMOTE_MS, IDLE_MS } from '../engine/narrate.ts';
import type { Block } from '../session/entries.ts';
import { findToolCallLeaks, recoverLeaks, type LeakFamily } from '../tools/leaks.ts';
import { parseToolArgs } from '../tools/args.ts';
import { passThrough } from './record.ts';
import { sseEvents } from './sse.ts';
import { SAFE_ID } from './wire.ts';
import { PROVIDER_ERROR_CATEGORY, ProviderError, providerMessage } from './types.ts';
import type { FinishReason, JSONSchema, ModelCaps, ModelRequest, PromptMsg, Provider, ProviderEnv, Replay, ToolSpec, Usage } from './types.ts';

/** Most calls one active probe run makes (a repeated call counts). */
export const ACTIVE_PROBE_MAX_CALLS = 6;

export type ProbeName = 'stream' | 'stream_usage' | 'tools' | 'tools_result' | 'json_schema';

/**
 * The reply cap of each probe call. A ping needs a word. The tool call and the JSON reply get room
 * for a thinking model to think first: thinking counts against max_tokens (Ollama's /v1 thinks by
 * default; in docs/M3-DEMO.md gemma4 wrote 841 characters of thinking before a one-line answer), and
 * only a model that thinks spends that room. The values are the scratch note's §1.6.
 */
export const ACTIVE_PROBE_TOKENS: Readonly<Record<ProbeName, number>> = {
  stream: 96,
  stream_usage: 96,
  tools: 1024,
  tools_result: 512,
  json_schema: 512,
};
/** The largest reply cap of any probe call (1024). */
export const ACTIVE_PROBE_MAX_TOKENS: number = Math.max(...Object.values(ACTIVE_PROBE_TOKENS));

/** Tokens the probe prompts take at most (round 2 of the tools probe: system, user, call, result, the tool's schema). */
export const PROBE_PROMPT_TOKENS = 512;

/**
 * The max_tokens a probe call sends: its ACTIVE_PROBE_TOKENS, never above what the caps say the model
 * may write (maxOutput) or what its window leaves after the probe prompt (contextLength −
 * PROBE_PROMPT_TOKENS, at least 16): some servers answer 400 to a max_tokens past the model's limit
 * (vLLM when prompt + max_tokens passes max_model_len), and that must not read as a refusal of tools.
 */
export function probeMaxTokens(name: ProbeName, caps: Pick<ModelCaps, 'maxOutput' | 'contextLength'>): number {
  let cap = ACTIVE_PROBE_TOKENS[name];
  const out = caps.maxOutput;
  if (out !== undefined && Number.isFinite(out) && out >= 1) cap = Math.min(cap, Math.floor(out));
  const window = caps.contextLength;
  if (window !== undefined && Number.isFinite(window) && window >= 1) cap = Math.min(cap, Math.max(16, Math.floor(window) - PROBE_PROMPT_TOKENS));
  return Math.max(1, cap);
}

export interface ActiveProbeInput {
  provider: Provider;
  connection: string;
  model: string;
  /** The caps a turn would use now (resolved without the probe's own earlier facts). */
  caps: ModelCaps;
  local: boolean;
  fetch: typeof fetch;
  key: string | null;
  signal: AbortSignal;
  clock: () => Date;
  timers?: DelayTimers;
  /** Per-call timeouts (default: narrate.ts timeoutsFor values for a local/remote connection). */
  timeouts?: { firstByteMs: number; idleMs: number };
  /**
   * The server kind the catalog found ('ollama', 'llama.cpp', …), when known. Ollama tells a model
   * without tools with HTTP 400: a 500 from it, even twice, is a runner that failed, never a refusal.
   */
  server?: string;
}

/**
 * 'ok': it worked. 'no': it did not, and that is evidence (a refusal, a call leaked as text, prose
 * instead of the schema). 'inconclusive': nothing was learned (a timeout, a transient server failure,
 * a reply cut by its cap); such an observation never yields a fact.
 */
export type ProbeVerdict = 'ok' | 'no' | 'inconclusive';

export interface ProbeObservation {
  probe: ProbeName;
  verdict: ProbeVerdict;
  /** verdict === 'ok'. */
  ok: boolean;
  /** One plain line for the report ("native call", "leaked as text: <tool_call>", "no usage in stream"). */
  detail: string;
  ms: number;
  usage?: Usage;
}

export interface ActiveProbeResult {
  /**
   * Only fields a probe saw evidence for: tools ('native' when a native call came back, 'prompted'
   * when the call leaked as text), streamUsage, reasoning.output, structuredOutput
   * {mode:'json_schema', confirmedBy:'probe'} when the schema was enforced (else {mode:'none'}).
   * Never maxInFlight, never the context window.
   */
  facts: Partial<ModelCaps>;
  observations: ProbeObservation[];
  calls: number;
}

// ---- the probe texts (model-facing, English, fixed) ------------------------------------------------

/** The stream probe's whole prompt: a reply of a few tokens. */
export const PROBE_PING_USER = 'Reply with one word: ready.';

/** The one tool the tools probe offers. Its schema never has an empty `required` (DeepSeek refuses that). */
export const PROBE_TOOL: ToolSpec = {
  name: 'lookup_word',
  description: 'Look up the word stored under a key in the archive. Only this tool knows the stored words; they cannot be guessed.',
  schema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'The key to look up, for example "amber-7".' } },
    required: ['key'],
    additionalProperties: false,
  },
};
export const PROBE_TOOLS_SYSTEM = 'You can call tools. When a question needs a tool, call the tool instead of guessing, then answer from its result.';
export const PROBE_TOOLS_USER = 'Which word is stored under the key "amber-7"? Look it up and tell me the word.';
/** What the probe's tool "returns"; round 2 answered when its reply names it. */
export const PROBE_TOOL_RESULT = 'heliotrope';

/** The json_schema probe: the prompt does NOT ask for JSON, so only an enforcing server yields it. */
export const PROBE_JSON_USER = 'Say hello in one short sentence.';
export const PROBE_JSON_SCHEMA: { name: string; schema: JSONSchema } = {
  name: 'rp_core_probe',
  schema: {
    type: 'object',
    properties: { mood: { type: 'string', enum: ['heliotrope', 'viridian'] }, count: { type: 'integer' } },
    required: ['mood', 'count'],
    additionalProperties: false,
  },
};

/**
 * A fixed hint for a server kind that refused the tools field (fixed text: the server's own words are
 * never quoted, §13). The CLI prints it next to a 'refused' tools observation.
 */
export function toolsRefusedHint(server: string | undefined): string {
  switch (server) {
    case 'llama.cpp':
      return 'llama-server needs --jinja for tools (and a chat template that supports them)';
    case 'vllm':
      return 'vLLM needs --enable-auto-tool-choice and --tool-call-parser <name> for tool_choice auto';
    case 'ollama':
      return "this model's template has no tools (ollama show <model> lists its capabilities)";
    default:
      return 'the server refused the tools field; the prompted transport works without it';
  }
}

// ---- watching the wire --------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Raw body bytes kept per probe call (a probe reply is a few hundred tokens). */
const WIRE_CAP_BYTES = 1 << 20;

/** Native delta fields that carried reasoning text, plus Magistral-style content parts. */
type ReasoningField = 'reasoning_content' | 'reasoning' | 'reasoning_details' | 'content_parts';

/** What the bytes of one call showed. */
interface WireSeen {
  /** A response arrived (any status). */
  fetched: boolean;
  /** The response was an event stream (false: a JSON document, the server ignored stream:true). */
  sse: boolean;
  fields: Set<ReasoningField>;
  /** An OpenAI usage object with token counts. */
  usage: boolean;
  /** llama.cpp `timings`. */
  timings: boolean;
  /** tool_calls delta fragments, and whether the server sent call ids. */
  fragments: number;
  ids: boolean;
}

/** One parsed chunk (or a whole JSON completion) into what the call showed. Exported for tests. */
export function observeChunk(chunk: unknown, seen: WireSeen): void {
  if (!isRecord(chunk)) return;
  if (isRecord(chunk.usage) && (typeof chunk.usage.prompt_tokens === 'number' || typeof chunk.usage.completion_tokens === 'number')) seen.usage = true;
  if (isRecord(chunk.timings)) seen.timings = true;
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (!isRecord(choice)) return;
  const d = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined;
  if (!d) return;
  if (typeof d.reasoning_content === 'string' && d.reasoning_content !== '') seen.fields.add('reasoning_content');
  if (typeof d.reasoning === 'string' && d.reasoning !== '') seen.fields.add('reasoning');
  if (Array.isArray(d.reasoning_details) && d.reasoning_details.length > 0) seen.fields.add('reasoning_details');
  if (Array.isArray(d.content) && d.content.some((p) => isRecord(p) && /^(thinking|reasoning)$/i.test(String(p.type)))) seen.fields.add('content_parts');
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) {
      if (!isRecord(tc)) continue;
      seen.fragments++;
      if (typeof tc.id === 'string' && tc.id !== '') seen.ids = true;
    }
  }
}

function emptySeen(): WireSeen {
  return { fetched: false, sse: false, fields: new Set(), usage: false, timings: false, fragments: 0, ids: false };
}

/** A fetch that hands the provider the real response, its body copied (capped) on the way. */
function watchingFetch(base: typeof fetch, seen: WireSeen, chunks: Uint8Array[]): typeof fetch {
  let kept = 0;
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const res = await base(input, init);
    seen.fetched = true;
    if (!res.ok) return res;
    seen.sse = !(res.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
    return passThrough(res, (chunk) => {
      if (kept >= WIRE_CAP_BYTES) return;
      const piece = chunk.byteLength > WIRE_CAP_BYTES - kept ? chunk.subarray(0, WIRE_CAP_BYTES - kept) : chunk;
      kept += piece.byteLength;
      chunks.push(piece.slice());
    });
  };
  return Object.assign(wrapped, { preconnect: base.preconnect }) as typeof fetch;
}

/** The copied body, read after the call: SSE data lines (or one JSON document) into `seen`. */
async function readWire(chunks: readonly Uint8Array[], seen: WireSeen): Promise<void> {
  if (chunks.length === 0) return;
  if (!seen.sse) {
    try {
      observeChunk(JSON.parse(new TextDecoder().decode(concat(chunks))), seen);
    } catch {
      /* not JSON: nothing to see */
    }
    return;
  }
  async function* bytes(): AsyncGenerator<Uint8Array> {
    for (const c of chunks) yield c;
  }
  for await (const ev of sseEvents(bytes())) {
    const data = ev.data.trim();
    if (data === '' || data === '[DONE]') continue;
    try {
      observeChunk(JSON.parse(data), seen);
    } catch {
      /* keep-alive noise */
    }
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// ---- one call -----------------------------------------------------------------------------------------

/** What one probe call amounted to. */
interface Outcome {
  text: string;
  reasoning: string;
  calls: { id: string; name: string; args: string }[];
  replay: Replay[];
  usage?: Usage;
  finish?: { reason: FinishReason; raw: string };
  error?: ProviderError;
  ms: number;
  seen: WireSeen;
  /** The HTTP status of a first try that failed before output and was asked again (this is the second try). */
  retriedAfter?: number;
  /** This second try failed the same way: 500/501 twice is a refusal (llama.cpp without --jinja). */
  repeated?: boolean;
}

/** Failures after which no later probe means anything: the server, the key or the model is not there. */
const UNUSABLE = new Set(['unreachable', 'auth_failed', 'key_unavailable']);

/** A server error before any output: worth asking once more before it means anything. */
function serverFailed(err: ProviderError | undefined): boolean {
  return err !== undefined && !err.afterOutput && err.status !== undefined && err.status >= 500 && err.status <= 599;
}

/**
 * The server answered the request itself with a refusal (not a transient failure): evidence of "not
 * supported". A 4xx at once; a 500/501 only when the repeated call got it again (llama.cpp turns an
 * unsupported field into a 500, but so does an Ollama runner that crashed once).
 */
function refused(r: Pick<Outcome, 'error' | 'repeated'>, server?: string): boolean {
  const err = r.error;
  if (!err || err.afterOutput) return false;
  const s = err.status;
  if (s === undefined) return err.code === 'bad_request';
  // Ollama refuses with 400; its 500 is a runner that crashed on the request, however often.
  if (s === 500 || s === 501) return r.repeated === true && server !== 'ollama';
  return s === 400 || s === 404 || s === 405 || s === 415 || s === 422;
}

/**
 * A failed call's verdict: a refusal is evidence, and so is a ping that found the server unusable
 * (nothing streams at all); anything else (a timeout, a server error, a server gone mid-run) taught
 * nothing.
 */
function failureVerdict(r: Pick<Outcome, 'error' | 'repeated'>, probe: ProbeName, server?: string): ProbeVerdict {
  if (refused(r, server)) return 'no';
  return probe === 'stream' && r.error !== undefined && UNUSABLE.has(r.error.code) ? 'no' : 'inconclusive';
}

/** The detail of a probe the run had no call left for (ACTIVE_PROBE_MAX_CALLS, repeats included). */
export const PROBE_NOT_RUN = `not run: the run had made its ${ACTIVE_PROBE_MAX_CALLS} calls (a repeated call counts)`;

/** A failure as a plain line: the fixed sentence of its code (§13), never the server's words. */
function failureLine(r: Pick<Outcome, 'error' | 'repeated'>): string {
  const err = r.error!;
  return `${providerMessage(err.code, err.status)}${r.repeated ? ' on both tries' : ''}`;
}

/** A detail with the note that a first try failed (the observation is the second try's). */
function retried(r: Outcome, detail: string): string {
  return r.retriedAfter === undefined || r.repeated ? detail : `${detail} (second try: the first got HTTP ${r.retriedAfter})`;
}

function text(t: string): Block {
  return { k: 'text', text: t };
}

function msg(role: PromptMsg['role'], blocks: Block[], replay?: Replay[]): PromptMsg {
  return replay && replay.length > 0 ? { role, blocks, src: 'probe', replay } : { role, blocks, src: 'probe' };
}

/**
 * Run the probes in order, each skipped once one before it shows the server is unusable:
 * 1. stream: a tiny reply (text, reasoning field, usage presence; one retry with stream_options only
 *    when no usage arrived and the caps did not ask for it);
 * 2. tools: one offered tool, tool_choice 'auto', a prompt that clearly calls for it; then the result
 *    sent back and a reply read (round 2) when round 1 made a native call;
 * 3. json_schema: a schema-constrained reply whose prompt does NOT ask for JSON; valid JSON for the
 *    schema means the server enforced it.
 * At most ACTIVE_PROBE_MAX_CALLS calls, each capped at its ACTIVE_PROBE_TOKENS (lowered to the caps'
 * maxOutput and window: probeMaxTokens). A call that got a server error (5xx) before any output is
 * sent once more while calls are left; a probe the run has no call left for is observed as
 * inconclusive (PROBE_NOT_RUN). Never throws for provider trouble: an observation says what failed.
 *
 * The caller's own abort (input.signal) is not provider trouble: it is rethrown, and nothing of the
 * run should be stored then. Round 2 of the tools probe is sent the way a tool loop's final round
 * is (the result appended, toolChoice 'none', the round's replay payloads on its message), so the
 * adapter's echo rules and its "no tools when tool_choice is not honoured" rule are exercised too.
 */
export async function runActiveProbes(input: ActiveProbeInput): Promise<ActiveProbeResult> {
  const timers = input.timers ?? realTimers;
  const firstByteMs = input.timeouts?.firstByteMs ?? (input.local ? FIRST_BYTE_LOCAL_MS : FIRST_BYTE_REMOTE_MS);
  const idleMs = input.timeouts?.idleMs ?? IDLE_MS;
  const observations: ProbeObservation[] = [];
  const facts: Partial<ModelCaps> = {};
  let calls = 0;
  /** Reasoning seen over every call: native fields, and reasoning events with none of them (tags). */
  const fields = new Set<ReasoningField>();
  let tagReasoning = false;

  const observe = (probe: ProbeName, verdict: ProbeVerdict, detail: string, r: Outcome, withUsage = false): void => {
    const o: ProbeObservation = { probe, verdict, ok: verdict === 'ok', detail: retried(r, detail), ms: r.ms };
    observations.push(withUsage && r.usage ? { ...o, usage: r.usage } : o);
  };
  /** A failed call's observation: a refusal, an unusable server, or nothing learned. */
  const observeFailure = (probe: ProbeName, r: Outcome, refusedAs: string, suffix = ''): void => {
    observe(probe, failureVerdict(r, probe, input.server), `${isRefusal(r) ? refusedAs : ''}${failureLine(r)}${suffix}`, r);
  };
  const isRefusal = (r: Outcome): boolean => refused(r, input.server);
  /** A probe the run had no call left for: said, so the report never reads as if it was never part of the run. */
  const notRun = (probe: ProbeName): void => {
    observations.push({ probe, verdict: 'inconclusive', ok: false, detail: PROBE_NOT_RUN, ms: 0 });
  };

  async function once(name: ProbeName, over: Partial<ModelRequest> & Pick<ModelRequest, 'caps' | 'messages'>): Promise<Outcome> {
    calls++;
    const ctrl = childController(input.signal);
    const t0 = input.clock().getTime();
    const out: Outcome = { text: '', reasoning: '', calls: [], replay: [], ms: 0, seen: emptySeen() };
    const chunks: Uint8Array[] = [];
    let handle: unknown;
    let finished = false;
    const arm = (ms: number, reason: AbortReason): void => {
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => abortWith(ctrl, reason), ms);
    };
    arm(firstByteMs, 'timeout:first_byte');
    // After the finish only the usage may still come: a short grace, then the call is over (some
    // servers never send [DONE]); before it, the idle timer restarts on every chunk of bytes.
    const env: ProviderEnv = {
      fetch: watchingFetch(input.fetch, out.seen, chunks),
      key: input.key,
      onActivity: () => arm(finished ? FINISH_GRACE_MS : idleMs, 'timeout:idle'),
    };
    const req: ModelRequest = {
      model: { connection: input.connection, model: input.model },
      maxTokens: probeMaxTokens(name, over.caps),
      samplers: {},
      signal: ctrl.signal,
      callKey: `probe_${name}`,
      agent: 'narrator',
      ...over,
    };
    const open = new Map<number, { id: string; name: string; args: string }>();
    try {
      for await (const ev of input.provider.stream(req, env)) {
        if (ev.t === 'text') out.text += ev.d;
        else if (ev.t === 'reasoning') out.reasoning += ev.d;
        else if (ev.t === 'tool_start') open.set(ev.i, { id: ev.id, name: ev.name, args: '' });
        else if (ev.t === 'tool_args') {
          const c = open.get(ev.i);
          if (c) c.args += ev.d;
        } else if (ev.t === 'tool_end') {
          const c = open.get(ev.i);
          if (c) out.calls.push(c);
          open.delete(ev.i);
        } else if (ev.t === 'usage') out.usage = { ...ev.u };
        else if (ev.t === 'replay') out.replay.push(ev.r);
        else if (ev.t === 'finish') {
          out.finish = { reason: ev.reason, raw: ev.raw };
          finished = true;
          arm(FINISH_GRACE_MS, 'timeout:idle');
        } else if (ev.t === 'error') {
          // A failure after the finish (the usage tail) costs only the usage.
          if (!out.finish) out.error = ev.err;
          break;
        }
      }
    } catch (e) {
      if (input.signal.aborted) throw input.signal.reason;
      const why = reasonOf(ctrl.signal);
      if (out.finish) {
        // The finish came; the stream just did not end in time. Not a failure.
      } else if (why === 'timeout:first_byte' || why === 'timeout:idle') {
        out.error = new ProviderError({
          category: PROVIDER_ERROR_CATEGORY.timeout,
          code: 'timeout',
          message: why === 'timeout:first_byte' ? `no first byte within ${Math.round(firstByteMs / 1000)} s` : `the stream stalled for ${Math.round(idleMs / 1000)} s`,
        });
      } else {
        out.error =
          e instanceof ProviderError
            ? e
            : new ProviderError({ category: 'network', code: 'unreachable', message: providerMessage('unreachable'), detail: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (handle !== undefined) timers.clearTimeout(handle);
      // Leaving the loop early (an error event) must not leave the request running.
      abortWith(ctrl, 'consumer_gone');
    }
    // An error event after the caller's abort is the abort, not provider trouble.
    if (input.signal.aborted) throw input.signal.reason;
    await readWire(chunks, out.seen);
    out.ms = Math.max(0, input.clock().getTime() - t0);
    // Reasoning evidence, from successful calls only.
    if (!out.error) {
      for (const f of out.seen.fields) fields.add(f);
      if (out.reasoning !== '' && out.seen.fetched && out.seen.fields.size === 0) tagReasoning = true;
    }
    return out;
  }

  /** One probe call; a server error before any output is asked once more while calls are left. */
  async function call(name: ProbeName, over: Partial<ModelRequest> & Pick<ModelRequest, 'caps' | 'messages'>): Promise<Outcome> {
    const first = await once(name, over);
    if (!serverFailed(first.error) || left() <= 0) return first;
    const again = await once(name, over);
    const out: Outcome = { ...again, ms: first.ms + again.ms, retriedAfter: first.error!.status! };
    if (serverFailed(again.error)) out.repeated = true;
    return out;
  }

  const left = (): number => ACTIVE_PROBE_MAX_CALLS - calls;
  const caps = input.caps;

  // ---- 1. stream ----
  const ping = await call('stream', { caps, messages: [msg('user', [text(PROBE_PING_USER)])] });
  if (ping.error) {
    observeFailure('stream', ping, '', '; the other probes were skipped');
    return { facts, observations, calls };
  }
  const sentOptions = caps.streamUsage === 'stream_options';
  // Without bytes to look at (an in-process provider), a usage event is all there is to go on.
  const usageSeen = ping.seen.fetched ? ping.seen.usage : ping.usage !== undefined;
  const timingsSeen = ping.seen.fetched && ping.seen.timings;
  const parts = [`answered (finish ${ping.finish?.raw || ping.finish?.reason || '?'})`];
  parts.push(
    ping.seen.fields.size > 0
      ? `reasoning in ${[...ping.seen.fields].join(', ')}`
      : ping.reasoning !== ''
        ? 'reasoning in inline tags'
        : 'no reasoning seen',
  );
  parts.push(usageSeen ? `usage in the stream${sentOptions ? ' (stream_options sent)' : ''}` : timingsSeen ? 'llama.cpp timings, no usage object' : 'no usage in the stream');
  if (ping.seen.fetched && !ping.seen.sse) parts.push('the server ignored stream:true (a JSON document came back)');
  observe('stream', 'ok', parts.join('; '), ping, true);

  if (!sentOptions) {
    if (usageSeen) facts.streamUsage = 'always';
    else if (timingsSeen) facts.streamUsage = 'timings';
    else if (left() <= 0) notRun('stream_usage');
    else {
      // ---- 1b. stream_usage: the same ping, asking for usage ----
      const again = await call('stream_usage', { caps: { ...caps, streamUsage: 'stream_options' }, messages: [msg('user', [text(PROBE_PING_USER)])] });
      const got = again.seen.fetched ? again.seen.usage : again.usage !== undefined;
      if (again.error) {
        if (isRefusal(again)) {
          facts.streamUsage = 'none';
          observe('stream_usage', 'no', `the server refused stream_options (${failureLine(again)})`, again);
        } else observeFailure('stream_usage', again, '');
      } else if (got) {
        facts.streamUsage = 'stream_options';
        observe('stream_usage', 'ok', 'usage arrives with stream_options', again, true);
      } else {
        facts.streamUsage = 'none';
        observe('stream_usage', 'no', 'no usage even with stream_options', again);
      }
    }
  } else if (!usageSeen) facts.streamUsage = timingsSeen ? 'timings' : 'none';

  // ---- 2. tools ----
  let stop = false;
  if (left() <= 0) notRun('tools');
  else {
    const system = msg('system', [text(PROBE_TOOLS_SYSTEM)]);
    const user = msg('user', [text(PROBE_TOOLS_USER)]);
    const toolCaps: ModelCaps = { ...caps, tools: 'native' };
    const r1 = await call('tools', { caps: toolCaps, messages: [system, user], tools: [PROBE_TOOL], toolChoice: 'auto' });
    const shape = r1.seen.fragments > 0 ? ` (arguments in ${r1.seen.fragments} fragment${r1.seen.fragments === 1 ? '' : 's'}${r1.seen.ids ? '' : ', no call id from the server'})` : '';
    const native = r1.error ? undefined : r1.calls.find((c) => c.name === PROBE_TOOL.name);
    if (r1.error) {
      stop = UNUSABLE.has(r1.error.code);
      if (isRefusal(r1)) facts.tools = 'prompted';
      observeFailure('tools', r1, 'refused: ');
    } else if (native) {
      // Arguments that do not parse are the argument chain's business, not the transport's: the
      // call is echoed with '{}' as the loop echoes it (decisions D2) and the round trip still runs.
      const args = readArgs(native.args);
      const argsNote = args === null ? ' (its arguments do not parse)' : args.repaired ? ' (the arguments needed repair)' : '';
      observe('tools', 'ok', `native call${argsNote}${shape}`, r1, true);
      // Without round 2 the transport is not known to work end to end: no tools fact then.
      if (left() <= 0) notRun('tools_result');
      else {
        // ---- 2b. tools_result: the result sent back, a reply read ----
        const id = SAFE_ID.test(native.id) ? native.id : 'call_probe_0';
        const blocks: Block[] = [];
        if (r1.reasoning !== '') blocks.push({ k: 'reasoning', text: r1.reasoning });
        if (r1.text.trim() !== '') blocks.push(text(r1.text));
        blocks.push({ k: 'tool_call', id, name: PROBE_TOOL.name, args: args?.json ?? '{}' });
        const replay = id === native.id ? r1.replay : rekeyExtras(r1.replay, native.id, id);
        const messages = [
          system,
          user,
          msg('assistant', blocks, replay),
          msg('tool', [{ k: 'tool_result', callId: id, name: PROBE_TOOL.name, text: PROBE_TOOL_RESULT }]),
        ];
        const r2 = await call('tools_result', { caps: toolCaps, messages, tools: [PROBE_TOOL], toolChoice: 'none' });
        if (r2.error) {
          stop = UNUSABLE.has(r2.error.code);
          if (isRefusal(r2)) facts.tools = 'prompted';
          observeFailure('tools_result', r2, 'the server refused the tool result: ');
        } else {
          facts.tools = 'native';
          const answered = new RegExp(PROBE_TOOL_RESULT, 'i').test(r2.text);
          observe('tools_result', 'ok', answered ? 'the result was taken and used in the reply' : 'the result was taken (the reply did not name it)', r2, true);
        }
      }
    } else {
      const leak = leakIn(r1.text);
      if (leak) {
        facts.tools = 'prompted';
        observe('tools', 'no', `leaked as text: ${leak}`, r1, true);
      } else {
        const other = r1.calls.length > 0 ? `; it called ${r1.calls.map((c) => c.name).join(', ')} instead` : '';
        if (r1.finish?.reason === 'length') {
          // Cut before it could call: a thinking model still thinking says nothing about tools.
          const thinking = r1.text.trim() === '' && r1.reasoning !== '' ? ' (it was still thinking)' : '';
          observe('tools', 'inconclusive', `the reply hit the ${probeMaxTokens('tools', toolCaps)}-token cap before any tool call${thinking}${other}`, r1, true);
        } else observe('tools', 'no', `no tool call${other}`, r1, true);
      }
    }
  }

  // ---- 3. json_schema ----
  if (!stop && left() <= 0) notRun('json_schema');
  else if (!stop) {
    const r = await call('json_schema', {
      caps: { ...caps, structuredOutput: { mode: 'json_schema' } },
      messages: [msg('user', [text(PROBE_JSON_USER)])],
      responseSchema: PROBE_JSON_SCHEMA,
    });
    if (r.error) {
      if (isRefusal(r)) facts.structuredOutput = { mode: 'none' };
      observeFailure('json_schema', r, 'refused: ');
    } else {
      const verdict = jsonVerdict(r.text, r.finish?.reason);
      if (verdict === 'enforced') {
        facts.structuredOutput = { mode: 'json_schema', confirmedBy: 'probe' };
        observe('json_schema', 'ok', 'the schema was enforced', r, true);
      } else if (verdict === 'inconclusive') {
        const cap = `the reply hit the ${probeMaxTokens('json_schema', caps)}-token cap`;
        const why = r.text.trim() !== '' ? cap : r.finish?.reason === 'length' ? `${cap} before any text${r.reasoning !== '' ? ' (it was still thinking)' : ''}` : 'no reply text';
        observe('json_schema', 'inconclusive', why, r, true);
      } else {
        facts.structuredOutput = { mode: 'none' };
        observe('json_schema', 'no', verdict === 'ignored' ? 'ignored: the reply is prose' : 'ignored: the reply is JSON that breaks the schema', r, true);
      }
    }
  }

  // Reasoning: one native field (reasoning_details wins over the plain text OpenRouter sends next to
  // it); inline tags only when no field carried any. Absence is not evidence: nothing is written.
  const native = (['reasoning_content', 'reasoning', 'reasoning_details'] as const).filter((f) => fields.has(f));
  const output = fields.has('reasoning_details') ? 'reasoning_details' : native.length === 1 ? native[0] : undefined;
  if (output !== undefined) facts.reasoning = { output } as ModelCaps['reasoning'];
  else if (native.length === 0 && !fields.has('content_parts') && tagReasoning) facts.reasoning = { output: 'tags' } as ModelCaps['reasoning'];

  return { facts, observations, calls };
}

// ---- reading replies ------------------------------------------------------------------------------

/** The arguments of the probe's call as a JSON object with a string key, or null. */
function readArgs(raw: string): { json: string; repaired: boolean } | null {
  const ok = (v: unknown): v is { key: string } => isRecord(v) && typeof v.key === 'string';
  try {
    const v: unknown = JSON.parse(raw.trim() === '' ? '{}' : raw);
    if (ok(v)) return { json: JSON.stringify(v), repaired: false };
  } catch {
    /* the argument chain may still repair it */
  }
  try {
    const r = parseToolArgs(raw, PROBE_TOOL.schema, PROBE_TOOL.name);
    if (r.ok && ok(r.value)) return { json: JSON.stringify(r.value), repaired: true };
  } catch {
    /* no repair */
  }
  return null;
}

/** Where a call was written as text, in words (the markup family, or a bare JSON call), or null. */
function leakIn(t: string): string | null {
  const span = findToolCallLeaks(t).find((s) => s.complete && !s.residue);
  if (span) return LEAK_WORDS[span.family];
  try {
    if (recoverLeaks(t, { offered: [PROBE_TOOL.name], nativeCalls: 0 }).calls.length > 0) return 'a JSON call in the prose';
  } catch {
    /* recovery unavailable: the markup check above is the evidence */
  }
  return null;
}

const LEAK_WORDS: Readonly<Record<LeakFamily, string>> = {
  tag: '<tool_call>-style tags',
  dsml: 'DSML markup',
  tool_request: '[TOOL_REQUEST] markup',
  tool_calls: '[TOOL_CALLS] markup',
  special: 'special-token tool sections',
};

/** Replay payloads with a tool_extra entry moved from one call id to another. */
function rekeyExtras(replay: readonly Replay[], from: string, to: string): Replay[] {
  return replay.map((r) => {
    if (r.kind !== 'tool_extra' || !isRecord(r.payload) || !(from in r.payload)) return r;
    const { [from]: extra, ...rest } = r.payload;
    return { ...r, payload: { ...rest, [to]: extra } };
  });
}

/**
 * The json_schema verdict from the reply text: exactly the schema's object (bare JSON: a grammar
 * never adds fences or prose) → enforced; prose → ignored; other JSON → invalid; nothing, or JSON
 * cut by the token cap → inconclusive.
 */
function jsonVerdict(raw: string, finish: FinishReason | undefined): 'enforced' | 'ignored' | 'invalid' | 'inconclusive' {
  const t = raw.trim();
  if (t === '') return 'inconclusive';
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    if (finish === 'length' && t.startsWith('{')) return 'inconclusive';
    return /^[[{]/.test(t) || t.startsWith('```') ? 'invalid' : 'ignored';
  }
  if (!isRecord(v)) return 'invalid';
  const keys = Object.keys(v).sort();
  const enumOk = v.mood === 'heliotrope' || v.mood === 'viridian';
  return keys.length === 2 && keys[0] === 'count' && keys[1] === 'mood' && enumOk && Number.isInteger(v.count) ? 'enforced' : 'invalid';
}
