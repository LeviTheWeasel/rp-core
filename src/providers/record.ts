// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Record and replay providers (ARCHITECTURE.md §14 "Провайдеры для тестов"): `--provider
// record:<file>` lets every role talk to its real connection and appends each model call to
// <file>; `--provider replay:<file>` plays those calls back without a network. A recording holds
// the normalized StreamEv sequence, the raw response body (SSE) and the request (with its hash),
// secrets scrubbed. On replay a request whose hash differs from the recorded one fails LOUDLY
// (ProviderError 'replay_mismatch') with a readable diff of the two requests: the point of a
// replay is to notice that the prompt changed.
// File format: JSONL, one RecordedCall per line. A recording is not a script file (parseScript
// rejects it); scripts stay hand-written.
// Fresh code (the scripted provider is the model for the replay side).
// CONTRACT FILE: signatures are fixed; the infra agent implements the bodies.
//
// Decided here (see .notes/m2-contract-infra.md):
// - The recorder passes every event through as it arrives and writes its line when the call ends:
//   finished, failed, stopped by the consumer, or thrown (an abort is rethrown after the write).
// - A call that ended in an abort is marked `aborted: true`. Its replay yields the recorded events,
//   then: with `holdAborted` (an interactive chat, where a person can press Ctrl+C again) it holds
//   like a silent server until the replay's own signal aborts; otherwise it ends at once with
//   'replay_aborted', so a piped or one-shot replay never waits for a timeout that costs its full
//   real duration again (M2 fix).
// - The raw body is read through a pass-through stream (no buffering, cancel reaches the server),
//   decoded by one streaming TextDecoder per call, capped at RAW_CAP_BYTES with an SSE comment
//   marking the cut.
// - Scrubbing covers the whole line, not only raw and error messages: the call's key (env.key) and
//   every string of secrets() are replaced in the request, the events (a secret split across two
//   text deltas included) and raw. A ProviderError's `detail` is never recorded.

import { scrub } from '../config/secrets.ts';
import { canonicalJson, hashRequest } from './scripted.ts';
import { PROVIDER_ERROR_CATEGORY, PROVIDER_ERROR_MESSAGE, ProviderError } from './types.ts';
import type { FinishReason, ProviderErrorCategory, ProviderErrorCode, PromptMsg, Provider, ProviderEnv, StreamEv, ToolSpec, Usage } from './types.ts';
import type { ModelRequest } from './types.ts';
import type { Samplers } from '../formats/native.ts';
import type { Block } from '../session/entries.ts';

/** StreamEv as JSON: a ProviderError travels as its fields. */
export type RecordedEv =
  | Exclude<StreamEv, { t: 'error' }>
  | {
      t: 'error';
      err: { category: ProviderErrorCategory; code: ProviderErrorCode; message: string; status?: number; retryAfterSec?: number };
      afterOutput: boolean;
    };

/** The parts of a request the model sees (hashRequest's subject in scripted.ts), kept for the diff. */
export interface RecordedRequest {
  messages: { role: PromptMsg['role']; blocks: PromptMsg['blocks'] }[];
  tools?: ToolSpec[];
  prefill?: string;
  maxTokens: number;
  samplers: Partial<Samplers>;
}

export interface RecordedCall {
  v: 1;
  /** hashRequest(req) from scripted.ts. */
  requestHash: string;
  request: RecordedRequest;
  /** Model as requested (and the connection id when the recorder knows it). */
  model: { connection?: string; model: string };
  events: RecordedEv[];
  /** The raw response body as received (SSE text), secrets scrubbed; absent when the inner provider never fetched. */
  raw?: string;
  /** The call ended in an abort (Stop, a timeout) before the stream did; replay then holds until its own signal aborts. */
  aborted?: true;
}

/** Raw body bytes kept per call; the rest still streams to the consumer, unrecorded. */
export const RAW_CAP_BYTES = 4 * 1024 * 1024;

/** Appended to a raw body cut at RAW_CAP_BYTES (an SSE comment, so the text stays SSE). */
export const RAW_TRUNCATED_MARK = `\n: [rp-core] raw body truncated at ${RAW_CAP_BYTES} bytes\n`;

/** What scrub() puts in place of a secret. */
const REDACTED = '[redacted]';

// ---- recorded forms -----------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The recorded form of a request (deterministic: same request → same object). */
export function recordedRequest(req: ModelRequest): RecordedRequest {
  const out: RecordedRequest = {
    messages: req.messages.map((m) => ({ role: m.role, blocks: m.blocks })),
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(req.prefill !== undefined ? { prefill: req.prefill } : {}),
    maxTokens: req.maxTokens,
    samplers: req.samplers,
  };
  // A JSON copy: a snapshot the caller cannot change later, with undefined members dropped as the
  // file drops them (and as hashRequest ignores them), so a recorded request hashes like the live one.
  return JSON.parse(JSON.stringify(out)) as RecordedRequest;
}

/** hashRequest over a recorded request (it reads only the fields RecordedRequest keeps). */
function hashRecorded(r: RecordedRequest): string {
  return hashRequest(r as unknown as ModelRequest);
}

const USAGE_FIELDS: Readonly<Record<keyof Usage, true>> = {
  inputTotal: true,
  inputCacheRead: true,
  inputCacheWrite: true,
  inputCacheWrite1h: true,
  outputTotal: true,
  outputReasoning: true,
  cost: true,
};

/** The finite numbers of a usage record (anything else is "unknown" and is left out). */
function usageCopy(u: Usage): Usage {
  const out: Usage = {};
  for (const k of Object.keys(USAGE_FIELDS) as (keyof Usage)[]) {
    const n = u[k];
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/** A StreamEv as it goes to the file: known fields only; a ProviderError as {category, code, message, status?, retryAfterSec?}. */
export function toRecordedEv(ev: StreamEv): RecordedEv {
  switch (ev.t) {
    case 'text':
    case 'reasoning':
    case 'tool_args':
      return { t: ev.t, i: ev.i, d: ev.d } as RecordedEv;
    case 'reasoning_end':
      return {
        t: 'reasoning_end',
        i: ev.i,
        ...(ev.signature !== undefined ? { signature: ev.signature } : {}),
        ...(ev.redacted !== undefined ? { redacted: ev.redacted } : {}),
      };
    case 'tool_start':
      return { t: 'tool_start', i: ev.i, id: ev.id, name: ev.name };
    case 'tool_end':
      return { t: 'tool_end', i: ev.i };
    case 'usage':
      return { t: 'usage', u: usageCopy(ev.u) };
    case 'finish':
      return { t: 'finish', reason: ev.reason, raw: ev.raw, ...(ev.model !== undefined ? { model: ev.model } : {}) };
    case 'error': {
      // `detail` (the server's own words) stays out: it may quote the prompt or echo a key (§13).
      const e = ev.err;
      return {
        t: 'error',
        err: {
          category: e.category,
          code: e.code,
          message: e.message,
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}),
        },
        afterOutput: ev.afterOutput,
      };
    }
  }
}

/** A recorded event back as a StreamEv (a fresh object; an error becomes a ProviderError again). */
export function fromRecordedEv(ev: RecordedEv): StreamEv {
  if (ev.t === 'usage') return { t: 'usage', u: { ...ev.u } };
  if (ev.t !== 'error') return { ...ev };
  const e = ev.err;
  const err = new ProviderError({
    category: e.category,
    code: e.code,
    message: e.message,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}),
    afterOutput: ev.afterOutput,
  });
  return { t: 'error', err, afterOutput: ev.afterOutput };
}

// ---- raw body capture ---------------------------------------------------------------------------

/** Statuses a constructed Response cannot carry a body with (and it only takes 200–599 at all). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

interface RawCapture {
  /** env.fetch, with every response body read through the capture. */
  fetch: typeof fetch;
  /** Seal the capture: the decoded text (undefined when nothing was fetched) and whether it was cut. */
  seal(): { text: string; truncated: boolean } | undefined;
}

function captureRaw(base: typeof fetch): RawCapture {
  // One streaming decoder for the call, so a UTF-8 sequence split across chunks decodes whole.
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let fetched = false;
  let sealed = false;
  let truncated = false;
  let bytes = 0;

  const take = (chunk: Uint8Array): void => {
    if (sealed || truncated) return;
    const room = RAW_CAP_BYTES - bytes;
    if (chunk.byteLength > room) {
      truncated = true;
      if (room > 0) parts.push(decoder.decode(chunk.subarray(0, room), { stream: true }));
      bytes = RAW_CAP_BYTES;
      return;
    }
    bytes += chunk.byteLength;
    parts.push(decoder.decode(chunk, { stream: true }));
  };

  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const res = await base(input, init);
    if (sealed) return res;
    fetched = true;
    return passThrough(res, take);
  };

  return {
    fetch: Object.assign(wrapped, { preconnect: base.preconnect }) as typeof fetch,
    seal() {
      if (!sealed) {
        sealed = true;
        parts.push(decoder.decode());
      }
      return fetched ? { text: parts.join(''), truncated } : undefined;
    },
  };
}

/**
 * The same response with its body read through `take`: each chunk is handed over as the consumer
 * pulls it (highWaterMark 0: nothing is read ahead), and a cancel (Stop, leaving the loop) reaches
 * the server's body. A body a constructed Response cannot carry is passed through unrecorded.
 */
function passThrough(res: Response, take: (chunk: Uint8Array) => void): Response {
  const source = res.body;
  if (source === null || NULL_BODY_STATUSES.has(res.status) || res.status < 200 || res.status > 599) return res;
  const reader = source.getReader();
  let closed = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // A read error (abort, reset) rejects pull, which errors this stream with the same reason.
        const r = await reader.read();
        if (closed) return;
        if (r.done) {
          closed = true;
          controller.close();
          return;
        }
        take(r.value);
        controller.enqueue(r.value);
      },
      cancel(reason) {
        closed = true;
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  let out: Response;
  try {
    out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch {
    reader.releaseLock();
    return res;
  }
  if (res.url !== '') {
    try {
      Object.defineProperty(out, 'url', { value: res.url });
    } catch {
      /* cosmetic only: no adapter reads url */
    }
  }
  return out;
}

// ---- scrubbing ----------------------------------------------------------------------------------

/** Every string in a JSON value (object keys included) with the secrets replaced. */
function scrubDeep<T>(v: T, secrets: readonly string[]): T {
  if (typeof v === 'string') return scrub(v, secrets) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, secrets)) as T;
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[scrub(k, secrets)] = scrubDeep(x, secrets);
    return out as T;
  }
  return v;
}

/**
 * Secrets in a string that arrived in pieces (the deltas of one channel), piece boundaries kept: a
 * covered run becomes '[redacted]' in the piece where it starts and is dropped from the others.
 */
function scrubPieces(pieces: readonly string[], secrets: readonly string[]): string[] {
  const whole = pieces.join('');
  const covered = new Uint8Array(whole.length);
  let any = false;
  for (const s of secrets) {
    for (let at = whole.indexOf(s); at >= 0; at = whole.indexOf(s, at + 1)) {
      covered.fill(1, at, at + s.length);
      any = true;
    }
  }
  if (!any) return [...pieces];
  const out: string[] = [];
  let pos = 0;
  for (const piece of pieces) {
    let s = '';
    for (let k = 0; k < piece.length; k++, pos++) {
      if (!covered[pos]) s += piece[k];
      else if (pos === 0 || !covered[pos - 1]) s += REDACTED;
    }
    out.push(s);
  }
  return out;
}

/** Events with the secrets replaced; text, reasoning and tool-argument deltas are scrubbed per channel. */
function scrubEvents(events: readonly RecordedEv[], secrets: readonly string[]): RecordedEv[] {
  const out = events.map((ev) => (ev.t === 'text' || ev.t === 'reasoning' || ev.t === 'tool_args' ? { ...ev } : scrubDeep(ev, secrets)));
  const channels = new Map<string, number[]>();
  out.forEach((ev, n) => {
    if (ev.t !== 'text' && ev.t !== 'reasoning' && ev.t !== 'tool_args') return;
    const key = `${ev.t}:${ev.i}`;
    const list = channels.get(key) ?? [];
    list.push(n);
    channels.set(key, list);
  });
  for (const list of channels.values()) {
    const deltas = list.map((n) => out[n] as { d: string });
    const clean = scrubPieces(
      deltas.map((ev) => ev.d),
      secrets,
    );
    deltas.forEach((ev, j) => (ev.d = clean[j]!));
  }
  return out;
}

/** A raw body cut mid-way may end with the first characters of a secret: those (6 or more) go too. */
function scrubTail(text: string, secrets: readonly string[]): string {
  for (const s of secrets) {
    for (let k = Math.min(s.length - 1, text.length); k >= 6; k--) {
      if (text.endsWith(s.slice(0, k))) return text.slice(0, text.length - k) + REDACTED;
    }
  }
  return text;
}

/**
 * The captured body as it goes to the file: scrubbed, and a cut one marked as such. The body is
 * mostly JSON, where a server may echo a secret escaped (" and \ always, / as \/ by some), so those
 * spellings go too. A secret the server splits or encodes otherwise is beyond any scrubber.
 */
function rawText(body: { text: string; truncated: boolean }, secrets: readonly string[]): string {
  const spellings = new Set(secrets);
  for (const s of secrets) {
    const json = JSON.stringify(s).slice(1, -1);
    spellings.add(json);
    spellings.add(json.replaceAll('/', '\\/'));
  }
  const all = [...spellings];
  const text = scrub(body.text, all);
  return body.truncated ? scrubTail(text, all) + RAW_TRUNCATED_MARK : text;
}

/** The secrets scrub() acts on (6 characters or more), longest first. */
function secretList(list: readonly (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const s of list) if (typeof s === 'string' && s.length >= 6) set.add(s);
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * One JSONL line for a call, every secret replaced (raw comes already scrubbed: rawText). Scrubbed
 * field by field before stringify, so a secret is caught in its decoded form (a key with a " in it
 * would appear escaped in the line).
 */
function serialize(call: RecordedCall, secrets: readonly string[]): string {
  if (secrets.length === 0) return JSON.stringify(call);
  return JSON.stringify({
    v: 1,
    requestHash: call.requestHash,
    request: scrubDeep(call.request, secrets),
    model: scrubDeep(call.model, secrets),
    events: scrubEvents(call.events, secrets),
    ...(call.raw !== undefined ? { raw: call.raw } : {}),
    ...(call.aborted ? { aborted: true as const } : {}),
  } satisfies RecordedCall);
}

// ---- recorder -----------------------------------------------------------------------------------

/**
 * Wrap a provider: every call is passed through unchanged (events, errors, aborts) and, when it
 * ends — finished, failed or aborted — one RecordedCall line goes to `sink`. The raw body is
 * captured by wrapping env.fetch and teeing the response body. Every string of `secrets()` (the
 * connection's key and header values) is scrubbed from `raw` and from error messages.
 *
 * The line is the JSON text without a newline. The call's own key (env.key) is scrubbed even when
 * secrets() does not list it, and scrubbing covers every string of the line (see the file header).
 * A sink that throws fails the call, unless the call already failed (its own error wins).
 * `wire()` is passed through from the inner provider.
 */
export function createRecordingProvider(
  inner: Provider,
  sink: (line: string) => void,
  opts?: { connection?: string; secrets?: () => readonly string[] },
): Provider {
  /** What a call carries from stream() into its generator. */
  interface Started {
    request: RecordedRequest;
    requestHash: string;
    raw: RawCapture;
    events: AsyncIterable<StreamEv>;
  }

  async function* record(req: ModelRequest, env: ProviderEnv, call: Started): AsyncGenerator<StreamEv> {
    const events: RecordedEv[] = [];
    let ended = false;
    let failed = false;
    try {
      for await (const ev of call.events) {
        events.push(toRecordedEv(ev));
        yield ev;
      }
      ended = true;
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      // Runs on every way out: the end, a throw (rethrown after this), a consumer that stopped.
      try {
        const secrets = secretList([env.key, ...(opts?.secrets?.() ?? [])]);
        const body = call.raw.seal();
        const connection = opts?.connection ?? req.model.connection;
        const line: RecordedCall = {
          v: 1,
          requestHash: call.requestHash,
          request: call.request,
          model: { ...(connection ? { connection } : {}), model: req.model.model },
          events,
          ...(body !== undefined ? { raw: rawText(body, secrets) } : {}),
          ...(!ended && req.signal.aborted ? { aborted: true as const } : {}),
        };
        sink(serialize(line, secrets));
      } catch (e) {
        if (!failed) throw e;
      }
    }
  }

  const provider: Provider = {
    stream(req: ModelRequest, env: ProviderEnv): AsyncIterable<StreamEv> {
      // At call time, as the inner provider would see it: the request snapshot (the caller may
      // reuse its arrays later) and the inner call itself (the scripted provider consumes its call
      // here). A synchronous throw surfaces on iteration, so it is recorded like any other.
      const raw = captureRaw(env.fetch);
      const callEnv: ProviderEnv = { ...env, fetch: raw.fetch, key: env.key };
      if (env.onActivity) callEnv.onActivity = () => env.onActivity?.();
      let events: AsyncIterable<StreamEv>;
      try {
        events = inner.stream(req, callEnv);
      } catch (e) {
        events = thrown(e);
      }
      return record(req, env, { request: recordedRequest(req), requestHash: hashRequest(req), raw, events });
    },
  };
  if (inner.wire) {
    const wire = inner.wire.bind(inner);
    provider.wire = (req: ModelRequest) => wire(req);
  }
  return provider;
}

/** An event stream that throws `e` when iterated. */
async function* thrown(e: unknown): AsyncGenerator<StreamEv> {
  throw e;
}

// ---- parsing ------------------------------------------------------------------------------------

const ROLES: Readonly<Record<PromptMsg['role'], true>> = { system: true, user: true, assistant: true, tool: true };

const FINISH_REASONS: Readonly<Record<FinishReason, true>> = {
  end: true,
  length: true,
  stopped: true,
  interrupted: true,
  content_filter: true,
  refusal: true,
  max_rounds: true,
};

const CATEGORIES: Readonly<Record<ProviderErrorCategory, true>> = {
  auth: true,
  request: true,
  rate: true,
  server: true,
  network: true,
  content: true,
  protocol: true,
};

function has<K extends string>(table: Readonly<Record<K, unknown>>, key: unknown): key is K {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

type Fail = (msg: string) => never;

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], fail: Fail): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`unknown field "${k}" (allowed: ${allowed.join(', ')})`);
}

const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function checkRequest(v: unknown, fail: Fail): RecordedRequest {
  if (!isRecord(v)) fail('"request" must be an object');
  if (!Array.isArray(v.messages)) fail('request.messages must be an array');
  v.messages.forEach((m, n) => {
    if (!isRecord(m) || !has(ROLES, m.role) || !Array.isArray(m.blocks)) {
      fail(`request.messages[${n}] must be {role, blocks: [...]} with a known role`);
    }
    m.blocks.forEach((b, k) => {
      if (!isRecord(b) || typeof b.k !== 'string') fail(`request.messages[${n}].blocks[${k}] must be a block {k, ...}`);
    });
  });
  if (v.tools !== undefined) {
    if (!Array.isArray(v.tools)) fail('request.tools must be an array');
    v.tools.forEach((t, n) => {
      if (!isRecord(t) || typeof t.name !== 'string' || typeof t.description !== 'string' || !isRecord(t.schema)) {
        fail(`request.tools[${n}] must be {name, description, schema}`);
      }
    });
  }
  if (v.prefill !== undefined && typeof v.prefill !== 'string') fail('request.prefill must be a string');
  if (typeof v.maxTokens !== 'number') fail('request.maxTokens must be a number');
  if (!isRecord(v.samplers)) fail('request.samplers must be an object');
  return v as unknown as RecordedRequest;
}

function checkEv(v: unknown, fail: Fail): RecordedEv {
  if (!isRecord(v)) fail('an event must be an object {t, ...}');
  const t = v.t;
  const index = (): void => {
    if (!isIndex(v.i)) fail(`"${String(t)}" needs an index i >= 0`);
  };
  const text = (key: string): void => {
    if (typeof v[key] !== 'string') fail(`"${String(t)}".${key} must be a string`);
  };
  switch (t) {
    case 'text':
    case 'reasoning':
    case 'tool_args':
      onlyKeys(v, ['t', 'i', 'd'], fail);
      index();
      text('d');
      break;
    case 'reasoning_end':
      onlyKeys(v, ['t', 'i', 'signature', 'redacted'], fail);
      index();
      if (v.signature !== undefined) text('signature');
      if (v.redacted !== undefined && typeof v.redacted !== 'boolean') fail('"reasoning_end".redacted must be a boolean');
      break;
    case 'tool_start':
      onlyKeys(v, ['t', 'i', 'id', 'name'], fail);
      index();
      text('id');
      text('name');
      break;
    case 'tool_end':
      onlyKeys(v, ['t', 'i'], fail);
      index();
      break;
    case 'usage': {
      onlyKeys(v, ['t', 'u'], fail);
      if (!isRecord(v.u)) fail('"usage".u must be an object');
      for (const [k, n] of Object.entries(v.u)) {
        if (!has(USAGE_FIELDS, k)) fail(`unknown usage field "${k}"`);
        if (!isNonNegative(n)) fail(`usage.${k} must be a number >= 0`);
      }
      break;
    }
    case 'finish':
      onlyKeys(v, ['t', 'reason', 'raw', 'model'], fail);
      if (!has(FINISH_REASONS, v.reason)) fail(`unknown finish reason ${JSON.stringify(v.reason)}`);
      text('raw');
      if (v.model !== undefined) text('model');
      break;
    case 'error': {
      onlyKeys(v, ['t', 'err', 'afterOutput'], fail);
      const e = v.err;
      if (!isRecord(e)) fail('"error".err must be an object {category, code, message, status?, retryAfterSec?}');
      onlyKeys(e, ['category', 'code', 'message', 'status', 'retryAfterSec'], fail);
      if (!has(PROVIDER_ERROR_CATEGORY, e.code)) fail(`unknown error code ${JSON.stringify(e.code)}`);
      if (!has(CATEGORIES, e.category)) fail(`unknown error category ${JSON.stringify(e.category)}`);
      if (typeof e.message !== 'string') fail('err.message must be a string');
      if (e.status !== undefined && !(Number.isInteger(e.status) && (e.status as number) >= 100 && (e.status as number) <= 599)) {
        fail(`err.status must be an HTTP status, got ${JSON.stringify(e.status)}`);
      }
      if (e.retryAfterSec !== undefined && !isNonNegative(e.retryAfterSec)) fail('err.retryAfterSec must be a number >= 0');
      if (typeof v.afterOutput !== 'boolean') fail('"error".afterOutput must be a boolean');
      break;
    }
    default:
      fail(`unknown event type ${JSON.stringify(t)}`);
  }
  return v as unknown as RecordedEv;
}

function checkCall(v: unknown, fail: Fail): RecordedCall {
  if (Array.isArray(v)) fail('this is a script call (a JSON array of steps), not a recorded call: scripts load with --provider script:<file>');
  if (!isRecord(v)) fail('a recorded call must be a JSON object');
  if (v.v !== 1) {
    fail(v.v === undefined ? 'no "v": 1, so this is not a recorded call (a script line? those load with --provider script:<file>)' : `unsupported version "v": ${JSON.stringify(v.v)} (this rp-core reads v 1)`);
  }
  onlyKeys(v, ['v', 'requestHash', 'request', 'model', 'events', 'raw', 'aborted'], fail);
  if (typeof v.requestHash !== 'string' || !/^[0-9a-f]{16}$/.test(v.requestHash)) fail('"requestHash" must be 16 lowercase hex chars (the output of hashRequest)');
  checkRequest(v.request, fail);
  const m = v.model;
  if (!isRecord(m) || typeof m.model !== 'string' || (m.connection !== undefined && typeof m.connection !== 'string')) {
    fail('"model" must be {model, connection?} with string values');
  }
  if (!Array.isArray(v.events)) fail('"events" must be an array');
  v.events.forEach((ev, n) => checkEv(ev, (msg) => fail(`event ${n + 1}: ${msg}`)));
  if (v.raw !== undefined && typeof v.raw !== 'string') fail('"raw" must be a string');
  if (v.aborted !== undefined && v.aborted !== true) fail('"aborted" must be true when present');
  return v as unknown as RecordedCall;
}

/** Parse a recording file. Throws Error naming the line on bad input. */
export function parseRecording(text: string): RecordedCall[] {
  const calls: RecordedCall[] = [];
  // Physical lines, 1-based, as an editor numbers them; trim() drops a CR; a BOM is not content.
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  lines.forEach((raw, at) => {
    const line = raw.trim();
    if (line === '') return;
    const fail: Fail = (msg) => {
      throw new Error(`recording line ${at + 1}: ${msg}`);
    };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      fail(`invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    calls.push(checkCall(value, fail));
  });
  return calls;
}

// ---- replay -------------------------------------------------------------------------------------

function failure(code: ProviderErrorCode, message: string, afterOutput = false): StreamEv {
  return { t: 'error', err: new ProviderError({ category: PROVIDER_ERROR_CATEGORY[code], code, message, afterOutput }), afterOutput };
}

/** Throws the signal's reason before every event, so an abort at any point surfaces as a throw. */
async function* guarded(signal: AbortSignal, inner: AsyncGenerator<StreamEv>): AsyncGenerator<StreamEv> {
  signal.throwIfAborted();
  for await (const ev of inner) {
    signal.throwIfAborted();
    yield ev;
  }
  signal.throwIfAborted();
}

/** Resolves never; rejects with the signal's reason once it aborts. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Options of a replay (all optional; the CLI sets them). */
export interface ReplayOptions {
  /** A call recorded as aborted holds after its events until the replay's signal aborts (interactive). */
  holdAborted?: boolean;
  /** A line added to a replay_mismatch message for this request (why its caps may differ), or undefined. */
  note?: (req: ModelRequest) => string | undefined;
}

/**
 * Play recorded calls in order. A call whose request hash differs from the next recorded one
 * fails with ProviderError 'replay_mismatch' whose message carries requestDiff() (and a `model:`
 * line when the model asked for is not the one recorded, plus opts.note); running out of calls
 * fails with 'script_exhausted'. Events are yielded as recorded; aborts are honoured.
 *
 * Calls are consumed when stream() is called (a mismatching call too), as the scripted provider
 * does. A call recorded as `aborted` yields its events, then holds until the signal aborts when
 * opts.holdAborted is set, else fails at once with 'replay_aborted'.
 */
export function createReplayProvider(calls: RecordedCall[], opts: ReplayOptions = {}): Provider & { remaining(): number } {
  const recorded = [...calls];
  let next = 0;
  let asked = 0;

  async function* play(req: ModelRequest, call: RecordedCall | undefined, position: number, request: number): AsyncGenerator<StreamEv> {
    if (!call) {
      yield failure(
        'script_exhausted',
        `the recording ran out of calls: request ${request} has no recorded call left (the recording has ${recorded.length})`,
      );
      return;
    }
    const actual = hashRequest(req);
    if (actual !== call.requestHash) {
      let diff = requestDiff(call.request, recordedRequest(req));
      // hashRequest ignores the model; a different one only shows through the caps it shapes by.
      if (call.model.model !== req.model.model) {
        const was = call.model.connection !== undefined ? `${call.model.connection}:${call.model.model}` : call.model.model;
        diff = `model: ${was} recorded, ${req.model.model} actual\n${diff}`;
      }
      const own = hashRecorded(call.request);
      if (own !== call.requestHash) {
        diff += `\nnote: the recorded request hashes to ${own}, not to its requestHash ${call.requestHash} (was the recording edited by hand?)`;
      }
      const note = opts.note?.(req);
      if (note !== undefined) diff += `\n${note}`;
      yield failure('replay_mismatch', `${PROVIDER_ERROR_MESSAGE.replay_mismatch} (recorded call ${position + 1} of ${recorded.length})\n${diff}`);
      return;
    }
    let output = false;
    for (const ev of call.events) {
      if (ev.t === 'text' || ev.t === 'reasoning' || ev.t === 'tool_start') output = true;
      yield fromRecordedEv(ev);
    }
    if (!call.aborted) return;
    if (opts.holdAborted) await untilAborted(req.signal);
    else {
      yield failure(
        'replay_aborted',
        `${PROVIDER_ERROR_MESSAGE.replay_aborted} (recorded call ${position + 1} of ${recorded.length}): replay it in an interactive chat and press Ctrl+C, or record it again`,
        output,
      );
    }
  }

  return {
    remaining: () => recorded.length - next,
    stream(req: ModelRequest, _env: ProviderEnv): AsyncIterable<StreamEv> {
      // Consumed at call time, not on first iteration, like the scripted provider.
      const request = ++asked;
      const position = next;
      const call = recorded[next];
      if (call) next++;
      return guarded(req.signal, play(req, call, position, request));
    },
  };
}

// ---- diff ---------------------------------------------------------------------------------------

/** Characters shown on each side of the first difference. */
const DIFF_CONTEXT = 60;
const DIFF_MAX_LINES = 40;
const LABEL_RECORDED = '  recorded: ';
const LABEL_ACTUAL = '  actual:   ';

/** One block as a line of text for the diff. */
function blockText(b: Block | Record<string, unknown>): string {
  const x = b as Block;
  switch (x.k) {
    case 'text':
      return x.text;
    case 'reasoning':
      return `[reasoning${x.kind ? ` ${x.kind}` : ''}] ${x.text}`;
    case 'tool_call':
      return `[tool_call ${x.name} ${x.id}] ${x.args}`;
    case 'tool_result':
      return `[tool_result ${x.name} ${x.callId}${x.error ? ' error' : ''}] ${x.text}`;
    default:
      return canonicalJson(b);
  }
}

function messageText(m: RecordedRequest['messages'][number]): string {
  return m.blocks.map(blockText).join('\n\n');
}

/** Control characters escaped (\n, \t, \uXXXX), so a window of text stays on one line. */
function escapeLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** Both texts around their first differing character, with a caret under it. */
function around(recorded: string, actual: string): string[] {
  let p = 0;
  while (p < recorded.length && p < actual.length && recorded[p] === actual[p]) p++;
  // Never start a window on the second half of a surrogate pair.
  let start = Math.max(0, p - DIFF_CONTEXT);
  if (start > 0 && /[\udc00-\udfff]/.test(recorded[start] ?? '')) start--;
  const side = (s: string): string => {
    let end = Math.min(s.length, p + DIFF_CONTEXT);
    if (end < s.length && /[\ud800-\udbff]/.test(s[end - 1] ?? '')) end++;
    return `${start > 0 ? '…' : ''}${escapeLine(s.slice(start, end))}${end < s.length ? '…' : ''}`;
  };
  const caret = ' '.repeat(LABEL_RECORDED.length + (start > 0 ? 1 : 0) + escapeLine(recorded.slice(start, p)).length) + '^';
  return [
    `  at char ${p} (recorded ${recorded.length} chars, actual ${actual.length})`,
    LABEL_RECORDED + side(recorded),
    LABEL_ACTUAL + side(actual),
    caret,
  ];
}

/** A short one-line preview of a text. */
function preview(s: string): string {
  const max = DIFF_CONTEXT * 2;
  return s.length > max ? `"${escapeLine(s.slice(0, max))}…" (${s.length} chars)` : `"${escapeLine(s)}"`;
}

function messageLines(r: RecordedRequest['messages'], a: RecordedRequest['messages']): string[] {
  const lines: string[] = [];
  if (r.length !== a.length) lines.push(`messages: ${r.length} recorded, ${a.length} actual`);
  const shared = Math.min(r.length, a.length);
  let first = -1;
  let differing = 0;
  for (let n = 0; n < shared; n++) {
    if (canonicalJson(r[n]) !== canonicalJson(a[n])) {
      if (first < 0) first = n;
      differing++;
    }
  }
  if (first >= 0) {
    const rm = r[first]!;
    const am = a[first]!;
    const role = rm.role === am.role ? rm.role : `role ${rm.role} recorded, ${am.role} actual`;
    lines.push(`first difference: messages[${first}] (${role})`);
    let rt = messageText(rm);
    let at = messageText(am);
    // Two block lists can read the same as text (one block "a\n\nb" vs two): compare their JSON then.
    if (rt === at && canonicalJson(rm.blocks) !== canonicalJson(am.blocks)) {
      rt = canonicalJson(rm.blocks);
      at = canonicalJson(am.blocks);
    }
    if (rt !== at) lines.push(...around(rt, at));
    if (differing > 1) lines.push(`${differing - 1} more of the ${shared} shared messages differ`);
  } else if (r.length !== a.length) {
    const longer = r.length > a.length ? r : a;
    const extra = longer[shared]!;
    lines.push(`first difference: messages[${shared}] (${extra.role}) is only in the ${longer === r ? 'recorded' : 'actual'} request: ${preview(messageText(extra))}`);
  }
  return lines;
}

function toolLines(r: ToolSpec[] | undefined, a: ToolSpec[] | undefined): string[] {
  if (canonicalJson(r) === canonicalJson(a)) return [];
  const rl = r ?? [];
  const al = a ?? [];
  const byName = (list: ToolSpec[]): Map<string, string> => new Map(list.map((t) => [t.name, canonicalJson(t)]));
  const rm = byName(rl);
  const am = byName(al);
  const added = [...am.keys()].filter((n) => !rm.has(n)).sort();
  const removed = [...rm.keys()].filter((n) => !am.has(n)).sort();
  const changed = [...am.keys()].filter((n) => rm.has(n) && rm.get(n) !== am.get(n)).sort();
  const what: string[] = [];
  if (added.length > 0) what.push(`added: ${added.join(', ')}`);
  if (removed.length > 0) what.push(`removed: ${removed.join(', ')}`);
  if (changed.length > 0) what.push(`changed: ${changed.join(', ')}`);
  if (what.length === 0) {
    what.push(r === undefined || a === undefined ? 'no tools field on one side, an empty list on the other' : 'the same tools in another order');
  }
  return [`tools: ${rl.length} recorded, ${al.length} actual (${what.join('; ')})`];
}

function prefillLines(r: string | undefined, a: string | undefined): string[] {
  if (r === a) return [];
  if (r === undefined || a === undefined) {
    return [`prefill: ${r === undefined ? 'none' : preview(r)} recorded, ${a === undefined ? 'none' : preview(a)} actual`];
  }
  return ['prefill differs:', ...around(r, a)];
}

function samplerLines(r: Partial<Samplers>, a: Partial<Samplers>): string[] {
  const rs = r as Record<string, unknown>;
  const as = a as Record<string, unknown>;
  const show = (v: unknown): string => (v === undefined ? 'unset' : canonicalJson(v));
  const keys = [...new Set([...Object.keys(rs), ...Object.keys(as)])].sort();
  return keys.filter((k) => canonicalJson(rs[k]) !== canonicalJson(as[k])).map((k) => `samplers.${k}: ${show(rs[k])} recorded, ${show(as[k])} actual`);
}

/**
 * A short human diff of two requests: the first differing message (index, role, both texts
 * around the first differing character), changed counts, prefill, maxTokens, samplers. At most
 * ~40 lines. This is the user's own prompt text, shown locally; never sent anywhere.
 */
export function requestDiff(recorded: RecordedRequest, actual: RecordedRequest): string {
  const lines = [
    ...messageLines(recorded.messages, actual.messages),
    ...toolLines(recorded.tools, actual.tools),
    ...prefillLines(recorded.prefill, actual.prefill),
    ...(recorded.maxTokens !== actual.maxTokens ? [`maxTokens: ${recorded.maxTokens} recorded, ${actual.maxTokens} actual`] : []),
    ...samplerLines(recorded.samplers, actual.samplers),
  ];
  if (lines.length === 0) return 'no difference in what the model sees';
  if (lines.length > DIFF_MAX_LINES) {
    const rest = lines.length - (DIFF_MAX_LINES - 1);
    return [...lines.slice(0, DIFF_MAX_LINES - 1), `… ${rest} more lines`].join('\n');
  }
  return lines.join('\n');
}
