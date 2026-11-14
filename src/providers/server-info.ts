// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What a local server says about itself (M5d, D-210): llama.cpp's slots and build, the models Ollama
// has loaded and how each name runs, LM Studio's loaded models. The engine reads it once per origin
// (it memoises; this module keeps no state) to pin llama.cpp slots (D-211) and to warn about setups
// that reload or swap the model (D-212); `rp-core probe` prints it with the pinning verdict.
//
// The reader never throws and never writes anything: every failure is kind 'unknown' with a reason.
// Requests have short deadlines (1.5 s each, 3 s in all) because the first model call on the origin
// waits for the answer. The /props, /api/show and LM Studio readers are probe.ts's, shared.
// Callers decide when it runs (local openai-chat connections only, RP_CORE_SERVER_INFO); remote
// origins and other dialects get 'unknown' here too, so a slip never reaches a paid API.

import { guardedFetch, isLocalOrigin, originOf } from './http.ts';
import { isLlamaCppProps, isOllamaVersion, lmStudioV1Models, ollamaParameter, readLlamaCppProps, serverRootOf } from './probe.ts';
import type { ModelCaps } from './types.ts';

/** Per-request deadline of the reader (D-210). */
export const SERVER_INFO_REQUEST_MS = 1500;
/** Deadline of the whole read (D-210): the first model call on the origin waits at most this long. */
export const SERVER_INFO_TOTAL_MS = 3000;
/** llama.cpp PR #30295: from this build on, pinning a busy slot no longer loads another prompt into it (D-211). */
export const SLOT_PIN_MIN_BUILD = 11552;

/** One model of Ollama /api/ps. */
export interface OllamaLoaded {
  name: string;
  /** The window it is loaded with (context_length). */
  contextLength?: number;
  digest?: string;
}

export type ServerInfo =
  | {
      kind: 'llama.cpp';
      /** /props total_slots; null when the answer lacks it. */
      totalSlots: number | null;
      /** N of build_info `b<N>-<commit>`; null when it is 0 or missing. */
      build: number | null;
      /** /props endpoint_slots, when the server says. */
      endpointSlots?: boolean;
    }
  | { kind: 'ollama'; version?: string; loaded: OllamaLoaded[] }
  | {
      kind: 'lmstudio';
      /** Per model key (and per loaded instance id), whether it is loaded now. */
      loaded: Record<string, boolean>;
    }
  | { kind: 'unknown'; reason: string };

/** The options Ollama's needsReload compares (server/sched.go at v0.40.12); null = not set in the Modelfile. */
export interface OllamaRunner {
  num_ctx: number | null;
  num_batch: number | null;
  num_gpu: number | null;
  main_gpu: number | null;
  use_mmap: boolean | null;
  num_thread: number | null;
}

export interface OllamaModel {
  /** The FROM path of the Modelfile: the weights blob. */
  blob: string;
  runner: OllamaRunner;
}

export interface ServerInfoOptions {
  /** globalThis.fetch by default. */
  fetch?: typeof fetch;
  /** The caller's stop: the read ends at once with kind 'unknown'. */
  signal?: AbortSignal;
  /** The connection's key (llama.cpp --api-key also guards /props). */
  key?: string | null;
  /** When given and not openai-chat, nothing is read. */
  dialect?: ModelCaps['dialect'];
  /** Deadlines (tests); defaults SERVER_INFO_REQUEST_MS and SERVER_INFO_TOTAL_MS. */
  requestMs?: number;
  totalMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Got = { kind: 'json'; status: number; json: unknown } | { kind: 'failed'; why: 'timeout' | 'unreachable' | 'aborted' };

interface Reader {
  fetch: typeof fetch;
  key: string | null;
  origin: string;
  caller: AbortSignal | undefined;
  /** The whole read's deadline, shared by every request. */
  total: AbortSignal;
  requestMs: number;
}

async function request(r: Reader, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Got> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (r.key) headers['authorization'] = `Bearer ${r.key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const parts = [r.total, AbortSignal.timeout(r.requestMs)];
  if (r.caller) parts.push(r.caller);
  const signal = AbortSignal.any(parts);
  try {
    const res = await guardedFetch(
      { url, method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      { fetch: r.fetch, signal, allowedOrigin: r.origin },
    );
    // The body read is under the same deadline (the signal also ends it).
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { kind: 'json', status: res.status, json: res.ok ? json : undefined };
  } catch {
    if (r.caller?.aborted) return { kind: 'failed', why: 'aborted' };
    return { kind: 'failed', why: signal.aborted ? 'timeout' : 'unreachable' };
  }
}

function reader(baseUrl: string, opts: ServerInfoOptions): Reader {
  return {
    fetch: opts.fetch ?? fetch,
    key: opts.key ?? null,
    origin: originOf(baseUrl),
    caller: opts.signal,
    total: AbortSignal.timeout(opts.totalMs ?? SERVER_INFO_TOTAL_MS),
    requestMs: opts.requestMs ?? SERVER_INFO_REQUEST_MS,
  };
}

const unknown = (reason: string): ServerInfo => ({ kind: 'unknown', reason });

/**
 * Ask the server at `baseUrl` what it is (D-210): GET /props (llama.cpp), else /api/version and
 * /api/ps (Ollama), else /api/v1/models (LM Studio), else kind 'unknown'. Never throws, keeps no memo.
 */
export async function readServerInfo(baseUrl: string, opts: ServerInfoOptions = {}): Promise<ServerInfo> {
  if (opts.dialect !== undefined && opts.dialect !== 'openai-chat') return unknown(`not an openai-chat connection (${opts.dialect})`);
  let r: Reader;
  try {
    r = reader(baseUrl, opts);
  } catch {
    return unknown('no valid http(s) base URL');
  }
  if (!isLocalOrigin(r.origin)) return unknown('not a local server');
  if (opts.signal?.aborted) return unknown('stopped');
  const root = serverRootOf(baseUrl);
  // A timed-out step still lets the next one try (a server may hang on one path); a refused
  // connection or the whole deadline ends the read.
  const end = (g: Extract<Got, { kind: 'failed' }>): ServerInfo | null => {
    if (g.why === 'aborted') return unknown('stopped');
    if (g.why === 'unreachable') return unknown(`nothing answered at ${r.origin}`);
    return r.total.aborted ? unknown(`no answer within ${opts.totalMs ?? SERVER_INFO_TOTAL_MS} ms`) : null;
  };
  const misses: string[] = [];

  const props = await request(r, 'GET', `${root}/props`);
  if (props.kind === 'failed') {
    const stop = end(props);
    if (stop) return stop;
    misses.push('/props timed out');
  } else if (isLlamaCppProps(props.json)) {
    const p = readLlamaCppProps(props.json);
    return { kind: 'llama.cpp', totalSlots: p.totalSlots ?? null, build: p.build, ...(p.endpointSlots !== undefined ? { endpointSlots: p.endpointSlots } : {}) };
  } else misses.push(`/props ${props.status === 200 ? 'is not llama.cpp' : `HTTP ${props.status}`}`);

  const version = await request(r, 'GET', `${root}/api/version`);
  if (version.kind === 'failed') {
    const stop = end(version);
    if (stop) return stop;
    misses.push('/api/version timed out');
  } else if (isOllamaVersion(version.json)) {
    const ps = await request(r, 'GET', `${root}/api/ps`);
    const loaded: OllamaLoaded[] = [];
    if (ps.kind === 'json' && isRecord(ps.json) && Array.isArray(ps.json['models'])) {
      for (const m of ps.json['models'].filter(isRecord)) {
        const name = typeof m['name'] === 'string' ? m['name'] : typeof m['model'] === 'string' ? m['model'] : '';
        if (name === '') continue;
        const row: OllamaLoaded = { name };
        const ctx = m['context_length'];
        if (typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0) row.contextLength = ctx;
        if (typeof m['digest'] === 'string') row.digest = m['digest'];
        loaded.push(row);
      }
    }
    // /api/ps failing still leaves a known Ollama: nothing is reported loaded.
    if (ps.kind === 'failed' && ps.why === 'aborted') return unknown('stopped');
    return { kind: 'ollama', version: version.json.version, loaded };
  } else misses.push(`/api/version HTTP ${version.status}`);

  const lm = await request(r, 'GET', `${root}/api/v1/models`);
  if (lm.kind === 'failed') {
    const stop = end(lm);
    if (stop) return stop;
    misses.push('/api/v1/models timed out');
  } else {
    const models = lmStudioV1Models(lm.json);
    if (models.length > 0) {
      const loaded: Record<string, boolean> = {};
      for (const m of models) {
        const instances = Array.isArray(m['loaded_instances']) ? m['loaded_instances'].filter(isRecord) : [];
        loaded[m['key'] as string] = instances.length > 0;
        // A model loaded under its own identifier is called by that id.
        for (const i of instances) if (typeof i['id'] === 'string') loaded[i['id']] = true;
      }
      return { kind: 'lmstudio', loaded };
    }
    misses.push(`/api/v1/models ${lm.status === 200 ? 'lists no LM Studio models' : `HTTP ${lm.status}`}`);
  }
  return unknown(`no known server (${misses.join('; ')})`);
}

/** The first integer value of an option. */
function intParam(show: Record<string, unknown>, name: string): number | null {
  const v = ollamaParameter(show, name).find((x) => /^-?\d+$/.test(x));
  return v === undefined ? null : Number(v);
}

function boolParam(show: Record<string, unknown>, name: string): boolean | null {
  const v = ollamaParameter(show, name).find((x) => x === 'true' || x === 'false');
  return v === undefined ? null : v === 'true';
}

/** The FROM line of /api/show's modelfile (the header's commented "# FROM" is skipped). */
function fromLine(show: Record<string, unknown>): string | undefined {
  const text = typeof show['modelfile'] === 'string' ? show['modelfile'] : '';
  for (const line of text.split('\n')) {
    const m = /^\s*FROM\s+(.+?)\s*$/i.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** One /api/show answer → the blob and runner options; null without a FROM line. */
export function readOllamaShow(show: Record<string, unknown>): OllamaModel | null {
  const blob = fromLine(show);
  if (blob === undefined) return null;
  return {
    blob,
    runner: {
      num_ctx: intParam(show, 'num_ctx'),
      num_batch: intParam(show, 'num_batch'),
      num_gpu: intParam(show, 'num_gpu'),
      main_gpu: intParam(show, 'main_gpu'),
      use_mmap: boolParam(show, 'use_mmap'),
      num_thread: intParam(show, 'num_thread'),
    },
  };
}

/**
 * POST <root>/api/show for one model name (D-210): its blob and runner options, or null on any
 * failure (not local, no answer within the deadline, not found, no FROM line). Never throws.
 */
export async function ollamaModel(root: string, name: string, opts: Omit<ServerInfoOptions, 'dialect'> = {}): Promise<OllamaModel | null> {
  let r: Reader;
  try {
    r = reader(root, opts);
  } catch {
    return null;
  }
  if (!isLocalOrigin(r.origin) || opts.signal?.aborted) return null;
  const got = await request(r, 'POST', `${serverRootOf(root)}/api/show`, { model: name });
  return got.kind === 'json' && isRecord(got.json) ? readOllamaShow(got.json) : null;
}

/** The slots D-211 pins to: the narrator keeps 0, every other agent shares 1. */
export const SLOT_PIN = { narrator: 0, agents: 1 } as const;

export interface PinVerdict {
  pin: { narrator: number; agents: number } | null;
  why: string;
}

/**
 * D-211: pin when the user says so (`slot_pin = true`), never when they say no (`false`), else
 * only on llama.cpp with at least 2 slots and either build ≥ SLOT_PIN_MIN_BUILD or capacity 1 (then
 * rp-core never sends to a busy slot). Pure.
 */
export function pinVerdict(info: ServerInfo, o: { capacity: number; override?: boolean }): PinVerdict {
  if (o.override === true) return { pin: { ...SLOT_PIN }, why: 'slot_pin = true in config' };
  if (o.override === false) return { pin: null, why: 'slot_pin = false in config' };
  if (info.kind === 'unknown') return { pin: null, why: `server unknown (${info.reason})` };
  if (info.kind !== 'llama.cpp') return { pin: null, why: `${info.kind === 'lmstudio' ? 'LM Studio' : 'Ollama'} has no slots to pin` };
  if (info.totalSlots === null) return { pin: null, why: 'the server does not report its slot count' };
  if (info.totalSlots < 2) {
    return { pin: null, why: `the server has ${info.totalSlots} slot; pinning needs 2 (start it with -np 2 --no-kv-unified)` };
  }
  const build = info.build === null ? 'build unknown' : `build b${info.build}`;
  if (info.build !== null && info.build >= SLOT_PIN_MIN_BUILD) return { pin: { ...SLOT_PIN }, why: `${info.totalSlots} slots, ${build}` };
  if (o.capacity <= 1) return { pin: { ...SLOT_PIN }, why: `${info.totalSlots} slots, capacity 1 (${build})` };
  // An unknown build may well be new enough; rp-core just cannot tell.
  const age =
    info.build === null ? `the build is unknown (pinning a busy slot is safe only from b${SLOT_PIN_MIN_BUILD})` : `${build} is older than b${SLOT_PIN_MIN_BUILD}`;
  return {
    pin: null,
    why: `${age} and capacity is ${o.capacity}: a busy pinned slot could take another prompt; set slot_pin = true, update llama.cpp, or max_in_flight = 1`,
  };
}

/** The verdict as one line (rp-core probe): "slot pinning: on — narrator 0, agents 1 (why)" or "off — why". */
export function pinLine(v: PinVerdict): string {
  return v.pin ? `slot pinning: on — narrator ${v.pin.narrator}, agents ${v.pin.agents} (${v.why})` : `slot pinning: off — ${v.why}`;
}
