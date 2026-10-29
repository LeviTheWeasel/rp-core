// Ported from Bunraku:src/kit/providers/models.ts@702d8120 (modelsUrlLadder, parseModelsPayload, the
// ladder walk of openAICompatModels) and RoleCall:apps/rc/src/lib/models/fetcher.ts@fb8dc623e
// (parseCapabilities: OpenRouter supported_parameters → capabilities).
// Copyright (C) 2026 Coneja-Chibi and the RoleCall authors (Coneja-Chibi, NemoVonNirgend et al.);
// changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The catalog half of rp-core probe (ARCHITECTURE.md §8.2 source 3, §15 M1b) and the caps cache.
// Active probes (tools, stream shape, json_schema) live in probe-active.ts (M3); the cache keeps
// their facts apart from the catalog's. A probe only ADVISES: it never raises capacity [D-84].
// Port sources: Bunraku src/kit/providers/models.ts (/models ladder, ~60 lines); RoleCall
// apps/rc/src/lib/models/fetcher.ts parseCapabilities (lines 110-135).
// CONTRACT FILE (M1b): signatures are fixed; the caps agent implements the bodies.
//
// Changes from the sources:
// - Every request goes through http.guardedFetch (same origin only, manual redirects) with its own
//   short timeout; a failure becomes a note, and only "nothing answered at all" throws (unreachable).
// - The ladder's context sniffing drops `max_tokens` (an output limit on several catalogs) and adds
//   vLLM's `max_model_len`; payload items keep their raw record for the server-specific readers.
// - A model's TRAINED context (Ollama model_info `<arch>.context_length`, llama.cpp `n_ctx_train`,
//   LM Studio `max_context_length`) is never reported as contextLength: those servers run at a
//   smaller configured window and silently cut a longer prompt. Only runtime windows are claimed
//   (llama.cpp /props n_ctx, Ollama /api/ps or PARAMETER num_ctx, LM Studio loaded_instances,
//   koboldcpp true_max_context_length, vLLM max_model_len, OpenRouter context_length); otherwise a
//   note says what is known and how to set [caps."conn:model"] context_length in config.toml.
// - parseCapabilities becomes a Partial<ModelCaps> (tools, toolChoice, structured outputs, reasoning
//   control, sampler names) instead of RoleCall's boolean flags; modality/moderation are not kept.
// - Slots reported by a server (llama.cpp total_slots or /slots, LM Studio `parallel`) are advice only.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelCaps } from './types.ts';
import { ProviderError, categoryOf } from './types.ts';
import { guardedFetch, originOf } from './http.ts';
import { HOST_ROWS, SAMPLER_NAMES, globMatch } from './caps.ts';

export interface CatalogInfo {
  server: 'llama.cpp' | 'ollama' | 'lmstudio' | 'koboldcpp' | 'openrouter' | 'vllm' | 'anthropic' | 'unknown';
  models: { id: string; contextLength?: number }[];
  /** Per model id, what the catalog says (contextLength, tools, reasoning...). */
  caps: Record<string, Partial<ModelCaps>>;
  /**
   * The models list answered 401/403: the key is missing or refused, so whatever else was read is
   * not this account's view of the server (the CLI then stores nothing, review M1b).
   */
  authFailed?: true;
  /** Slots the server reports (llama.cpp /slots or /props total_slots): advice only. */
  slots?: number;
  notes: string[];
}

/** Per-request timeout of the catalog probe (§15 M1b: short, the server is either there or not). */
export const PROBE_TIMEOUT_MS = 5000;
/** At most this many Ollama /api/show calls per probe (and this many in flight at once). */
export const OLLAMA_SHOW_MAX = 64;
const OLLAMA_SHOW_PARALLEL = 4;

// ---------------------------------------------------------------------------------------------------
// The /models ladder (Bunraku models.ts)
// ---------------------------------------------------------------------------------------------------

/** One entry of a models list. `raw` is the record as the server sent it. */
export interface ModelEntry {
  id: string;
  contextLength?: number;
  ownedBy?: string;
  raw: Record<string, unknown>;
}

/** Context-length fields of a models list that mean the SERVING window (not the trained one). */
const CONTEXT_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'contextLength',
  'contextWindow',
  'inputTokenLimit',
  'max_model_len', // vLLM: the window the engine was started with
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function posInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function contextOf(record: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_KEYS) {
    const value = posInt(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Parse any known models-list wire shape ({data:[…]}, bare arrays, {models:[…]}) into a deduped, sorted list. Garbage in, [] out. */
export function parseModelsPayload(payload: unknown): ModelEntry[] {
  const items: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload['data'])
      ? payload['data']
      : isRecord(payload) && Array.isArray(payload['models'])
        ? payload['models']
        : [];
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = typeof item['id'] === 'string' ? item['id'] : typeof item['name'] === 'string' ? item['name'] : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const entry: ModelEntry = { id, raw: item };
    const ctx = contextOf(item);
    if (ctx !== undefined) entry.contextLength = ctx;
    if (typeof item['owned_by'] === 'string') entry.ownedBy = item['owned_by'];
    out.push(entry);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A base URL without a trailing slash or a pasted endpoint suffix. */
function trimBase(rawBase: string): string {
  return rawBase.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|messages)$/, '');
}

/**
 * The URL candidates for an OpenAI-compatible base: an explicit /models URL is used as-is; a
 * versioned base skips the /v1 insert; detailed=true is tried first (routers such as NanoGPT add
 * context lengths with it).
 */
export function modelsUrlLadder(rawBase: string): string[] {
  const base = trimBase(rawBase);
  if (/\/models(\?.*)?$/.test(base)) return [base];
  if (/\/v\d+[a-z]*$/.test(base)) return [`${base}/models?detailed=true`, `${base}/models`];
  return [`${base}/v1/models?detailed=true`, `${base}/v1/models`, `${base}/models`];
}

/** Where a server's own endpoints live (/props, /api/*): the base without the endpoint and the /vN segment. */
export function serverRootOf(rawBase: string): string {
  return trimBase(rawBase)
    .replace(/\/models(\?.*)?$/, '')
    .replace(/\/v\d+[a-z]*$/, '');
}

// ---------------------------------------------------------------------------------------------------
// Readers of server-specific catalogs
// ---------------------------------------------------------------------------------------------------

/** OpenRouter's supported_parameters names that are core sampler names (formats/native.ts Samplers). */
const OPENROUTER_SAMPLERS: ReadonlySet<string> = new Set(SAMPLER_NAMES);

/**
 * One OpenRouter /api/v1/models entry → caps. supported_parameters is the endpoint's own list
 * (RoleCall parseCapabilities): tools / tool_choice → native tools; structured_outputs →
 * json_schema; reasoning / include_reasoning → effort control; samplers → the accepted list.
 */
export function openRouterCaps(entry: Record<string, unknown>): Partial<ModelCaps> {
  const caps: Partial<ModelCaps> = {};
  const ctx = posInt(entry['context_length']);
  if (ctx !== undefined) caps.contextLength = ctx;
  const top = isRecord(entry['top_provider']) ? entry['top_provider'] : undefined;
  const maxOut = top ? posInt(top['max_completion_tokens']) : undefined;
  if (maxOut !== undefined) caps.maxOutput = maxOut;

  const raw = entry['supported_parameters'];
  if (!Array.isArray(raw)) return caps;
  const params = new Set(raw.filter((p): p is string => typeof p === 'string').map((p) => p.toLowerCase()));
  if (params.has('tools')) caps.tools = 'native';
  if (params.has('tool_choice')) {
    caps.toolChoice = ['auto', 'none'];
    caps.toolChoiceHonored = true;
  }
  if (params.has('parallel_tool_calls')) caps.parallelToolCalls = 'param';
  if (params.has('structured_outputs')) caps.structuredOutput = { mode: 'json_schema', confirmedBy: 'host' };
  if (params.has('reasoning') || params.has('include_reasoning')) caps.reasoning = { control: 'effort' } as ModelCaps['reasoning'];
  const accepted = SAMPLER_NAMES.filter((n) => OPENROUTER_SAMPLERS.has(n) && params.has(n));
  if (accepted.length > 0) caps.samplers = { accepted };
  return caps;
}

/** The trained context of an Ollama /api/show answer (model_info `<arch>.context_length`). */
function ollamaTrainedContext(show: Record<string, unknown>): number | undefined {
  const info = isRecord(show['model_info']) ? show['model_info'] : undefined;
  if (!info) return undefined;
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : undefined;
  if (arch !== undefined) {
    const v = posInt(info[`${arch}.context_length`]);
    if (v !== undefined) return v;
  }
  for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length') && posInt(v) !== undefined) return posInt(v);
  return undefined;
}

/** `PARAMETER num_ctx N` of a Modelfile, from /api/show's `parameters` text. */
function ollamaNumCtx(show: Record<string, unknown>): number | undefined {
  const text = typeof show['parameters'] === 'string' ? show['parameters'] : '';
  for (const line of text.split('\n')) {
    const m = /^\s*num_ctx\s+(\d+)\s*$/.exec(line);
    if (m) return posInt(Number(m[1]));
  }
  return undefined;
}

/**
 * One Ollama /api/show answer (plus the loaded window from /api/ps, when the model is loaded) → caps
 * and notes. capabilities 'tools' → native tools; 'thinking' → reasoning in the `reasoning` field,
 * reasoning_effort control, "none" turns thinking off on boolean-only models (docs.ollama.com
 * /api/openai-compatibility). The window is the loaded one, else PARAMETER num_ctx, never the trained
 * context: the OpenAI endpoint has no way to set num_ctx.
 */
export function ollamaShowCaps(
  model: string,
  show: Record<string, unknown>,
  loadedContext?: number,
): { caps: Partial<ModelCaps>; notes: string[] } {
  const caps: Partial<ModelCaps> = {};
  const notes: string[] = [];
  const trained = ollamaTrainedContext(show);
  const numCtx = ollamaNumCtx(show);
  const runtime = loadedContext ?? numCtx;
  if (runtime !== undefined) caps.contextLength = trained !== undefined ? Math.min(runtime, trained) : runtime;
  else {
    notes.push(
      `ollama: ${model}: window unknown (trained ${trained ?? '?'} tokens, but /v1 runs at the server's num_ctx, ` +
        `which /api/show does not report for this model); set PARAMETER num_ctx in a Modelfile or context_length under [caps."<connection>:${model}"] in config.toml`,
    );
  }
  const capabilities = Array.isArray(show['capabilities']) ? show['capabilities'].filter((c): c is string => typeof c === 'string') : [];
  if (capabilities.includes('tools')) caps.tools = 'native';
  if (capabilities.includes('thinking')) {
    caps.reasoning = {
      output: 'reasoning',
      control: 'effort',
      canDisable: true,
      offShape: { reasoning_effort: 'none' },
    } as ModelCaps['reasoning'];
  }
  return { caps, notes };
}

/** Which kind a /v1/models owned_by names, when it is distinctive. */
function kindFromOwner(models: ModelEntry[]): CatalogInfo['server'] | undefined {
  for (const m of models) {
    const o = m.ownedBy?.toLowerCase();
    if (o === 'llamacpp') return 'llama.cpp';
    if (o === 'vllm') return 'vllm';
    if (o === 'koboldcpp') return 'koboldcpp';
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  ok: boolean;
  /** The parsed JSON body; undefined when the body is not JSON. */
  json: unknown;
}

type Outcome = { kind: 'reply'; reply: Reply } | { kind: 'failed'; why: 'timeout' | 'unreachable' };

interface Session {
  fetch: typeof fetch;
  key: string | null;
  signal: AbortSignal;
  origin: string;
  timeoutMs: number;
  /** Some HTTP response arrived (any status): the server is reachable. */
  answered: boolean;
  /** The models list answered 401/403. */
  authFailed?: true;
  notes: string[];
}

/** The path and query of a URL for notes (URLs never carry the key: it travels in a header). */
function shown(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

async function call(s: Session, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Outcome> {
  if (s.signal.aborted) throw s.signal.reason;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (s.key) headers['authorization'] = `Bearer ${s.key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const signal = AbortSignal.any([s.signal, AbortSignal.timeout(s.timeoutMs)]);
  try {
    const res = await guardedFetch(
      { url, method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      { fetch: s.fetch, signal, allowedOrigin: s.origin },
    );
    s.answered = true;
    let json: unknown;
    try {
      const text = await res.text();
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      if (s.signal.aborted) throw s.signal.reason;
      json = undefined;
    }
    return { kind: 'reply', reply: { status: res.status, ok: res.ok, json } };
  } catch {
    // The caller's own abort wins over everything; our timeout is just a failed probe.
    if (s.signal.aborted) throw s.signal.reason;
    return { kind: 'failed', why: signal.aborted ? 'timeout' : 'unreachable' };
  }
}

/** The JSON of a 2xx reply, else undefined (and a note for anything but a plain 404). */
async function getJson(s: Session, url: string, quiet404 = true): Promise<unknown> {
  const out = await call(s, 'GET', url);
  if (out.kind === 'failed') {
    s.notes.push(`GET ${shown(url)}: ${out.why}`);
    return undefined;
  }
  if (!out.reply.ok) {
    if (!(quiet404 && (out.reply.status === 404 || out.reply.status === 405))) s.notes.push(`GET ${shown(url)}: HTTP ${out.reply.status}`);
    return undefined;
  }
  return out.reply.json;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------------
// fetchCatalog
// ---------------------------------------------------------------------------------------------------

function probeSession(baseUrl: string, opts: { fetch: typeof fetch; key: string | null; signal: AbortSignal; timeoutMs?: number }): Session {
  return {
    fetch: opts.fetch,
    key: opts.key,
    signal: opts.signal,
    origin: originOf(baseUrl),
    timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    answered: false,
    notes: [],
  };
}

/**
 * Walk the /models ladder until a rung yields models; a 401/403 stops it (do not hammer). Throws
 * ProviderError 'unreachable' when nothing answered; an empty list with misses becomes a note.
 */
async function walkModelsLadder(s: Session, baseUrl: string): Promise<ModelEntry[]> {
  let models: ModelEntry[] = [];
  const misses: string[] = [];
  for (const url of modelsUrlLadder(baseUrl)) {
    const out = await call(s, 'GET', url);
    if (out.kind === 'failed') {
      misses.push(`GET ${shown(url)} ${out.why}`);
      continue;
    }
    if (out.reply.status === 401 || out.reply.status === 403) {
      s.notes.push(`auth_failed: GET ${shown(url)} answered HTTP ${out.reply.status}; check the connection's key`);
      s.authFailed = true;
      break;
    }
    if (!out.reply.ok) {
      misses.push(`GET ${shown(url)} HTTP ${out.reply.status}`);
      continue;
    }
    models = parseModelsPayload(out.reply.json);
    if (models.length > 0) break;
    misses.push(`GET ${shown(url)} listed no models`);
  }
  if (!s.answered) {
    throw new ProviderError({
      category: categoryOf('unreachable'),
      code: 'unreachable',
      message: `nothing answered at ${s.origin} (${misses.join('; ')})`,
    });
  }
  if (models.length === 0 && misses.length > 0) s.notes.push(`no model list: ${misses.join('; ')}`);
  return models;
}

/**
 * Only the models list (`rp-core models <conn>`): the /models ladder of fetchCatalog without the
 * server-specific requests. Throws ProviderError 'unreachable' when nothing answers; the notes say
 * why a reachable server listed nothing (auth, 404s).
 */
export async function listModels(
  baseUrl: string,
  opts: { fetch: typeof fetch; key: string | null; signal: AbortSignal; timeoutMs?: number; dialect?: ModelCaps['dialect']; apiVersion?: string },
): Promise<{ models: { id: string; contextLength?: number }[]; notes: string[] }> {
  if (opts.dialect === 'anthropic') {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/models)?$/i, '') + '/v1/models';
    const headers: Record<string, string> = { accept: 'application/json', 'anthropic-version': opts.apiVersion ?? '2023-06-01' };
    if (opts.key) headers['x-api-key'] = opts.key;
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS)]);
    const res = await guardedFetch({ url: url.href, method: 'GET', headers }, { fetch: opts.fetch, signal, allowedOrigin: originOf(baseUrl) });
    if (res.status === 401 || res.status === 403) return { models: [], notes: [`auth_failed: GET /v1/models answered HTTP ${res.status}; check the connection's key`] };
    if (!res.ok) return { models: [], notes: [`GET /v1/models answered HTTP ${res.status}`] };
    const parsed = parseModelsPayload(await res.json());
    return { models: parsed.map((m) => m.contextLength ? { id: m.id, contextLength: m.contextLength } : { id: m.id }), notes: [] };
  }
  const s = probeSession(baseUrl, opts);
  const models = await walkModelsLadder(s, baseUrl);
  return {
    models: models.map((m) => (m.contextLength !== undefined ? { id: m.id, contextLength: m.contextLength } : { id: m.id })),
    notes: [...new Set(s.notes)],
  };
}

/**
 * Ladder: GET <base>/v1/models then <base>/models; llama.cpp GET /props (n_ctx, total_slots);
 * Ollama POST /api/show per model (context_length from model_info, capabilities incl. 'tools'/'thinking');
 * OpenRouter /api/v1/models (supported_parameters, context_length); koboldcpp /api/extra/version.
 * Every request uses http.guardedFetch with a short timeout; failures become notes, never throws for a
 * reachable server; throws ProviderError 'unreachable' when nothing answers.
 *
 * Details (see the file header for why): the server kind comes from a hosts.json hostname row
 * (openrouter.ai; other known API hosts skip the local-server detection and report 'unknown'), from
 * /v1/models owned_by (llamacpp, vllm, koboldcpp), else from read-only GETs at the server root
 * (/api/extra/version → koboldcpp, /props → llama.cpp, /api/v1/models or /api/v0/models → LM Studio,
 * /api/version → Ollama). Ollama also gets GET /api/ps (the loaded window) and POST /api/show, the
 * only non-GET request, for `model` or for each listed model (at most OLLAMA_SHOW_MAX).
 * `timeoutMs` overrides PROBE_TIMEOUT_MS (tests).
 */
export async function fetchCatalog(
  baseUrl: string,
  opts: { fetch: typeof fetch; key: string | null; signal: AbortSignal; model?: string; timeoutMs?: number; dialect?: ModelCaps['dialect']; apiVersion?: string },
): Promise<CatalogInfo> {
  if (opts.dialect === 'anthropic') {
    const result = await listModels(baseUrl, opts);
    const caps: CatalogInfo['caps'] = {};
    for (const m of result.models) if (m.contextLength !== undefined && (opts.model === undefined || opts.model === m.id)) caps[m.id] = { contextLength: m.contextLength };
    const notes = [...result.notes];
    if (opts.model && result.models.length && !result.models.some((m) => m.id === opts.model)) notes.push(`${opts.model} is not in the server's model list`);
    return { server: 'anthropic', models: result.models, caps, notes, ...(notes.some((n) => n.startsWith('auth_failed:')) ? { authFailed: true } : {}) };
  }
  const origin = originOf(baseUrl);
  const s = probeSession(baseUrl, opts);
  const root = serverRootOf(baseUrl);

  // 1. The models list: walk the ladder until a rung yields models; 401/403 stops it (do not hammer).
  const models = await walkModelsLadder(s, baseUrl);

  // 2. The server kind.
  const hostname = new URL(origin).hostname.toLowerCase();
  const hostRow = HOST_ROWS.find((r) => typeof r.match === 'object' && r.match.hostname !== undefined && globMatch(r.match.hostname, hostname));
  const hostServer = hostRow && typeof hostRow.match === 'object' ? hostRow.match.server : undefined;
  let server: CatalogInfo['server'] = hostServer === 'openrouter' ? 'openrouter' : 'unknown';
  const found: { props?: Record<string, unknown>; lmV1?: Record<string, unknown>[]; lmV0?: Record<string, unknown>[] } = {};
  if (hostRow !== undefined) {
    if (server === 'unknown') s.notes.push(`${hostRow.name ?? hostname}: known API host, its preset applies`);
  } else {
    server = kindFromOwner(models) ?? 'unknown';
    if (server === 'unknown') {
      const [kobold, props, lmV1, lmV0, ollama] = await Promise.all([
        getJson(s, `${root}/api/extra/version`),
        getJson(s, `${root}/props`),
        getJson(s, `${root}/api/v1/models`),
        getJson(s, `${root}/api/v0/models`),
        getJson(s, `${root}/api/version`),
      ]);
      const lmV1Models = isRecord(lmV1) && Array.isArray(lmV1['models']) ? lmV1['models'].filter(isRecord).filter((m) => typeof m['key'] === 'string') : [];
      const lmV0Models = isRecord(lmV0) && Array.isArray(lmV0['data']) ? lmV0['data'].filter(isRecord).filter((m) => 'max_context_length' in m || 'state' in m) : [];
      if (isRecord(kobold) && (typeof kobold['version'] === 'string' || kobold['result'] === 'KoboldCpp')) server = 'koboldcpp';
      else if (isRecord(props) && ('default_generation_settings' in props || 'total_slots' in props)) {
        server = 'llama.cpp';
        found.props = props;
      } else if (lmV1Models.length > 0 || lmV0Models.length > 0) {
        server = 'lmstudio';
        found.lmV1 = lmV1Models;
        found.lmV0 = lmV0Models;
      } else if (isRecord(ollama) && typeof ollama['version'] === 'string') server = 'ollama';
    }
  }

  // 3. What each server says about its models.
  const caps: Record<string, Partial<ModelCaps>> = {};
  const targets = opts.model !== undefined ? [opts.model] : models.map((m) => m.id);
  const wanted = new Set(targets);
  const put = (id: string, patch: Partial<ModelCaps>): void => {
    if (Object.keys(patch).length > 0) caps[id] = { ...(caps[id] ?? {}), ...patch };
  };
  let slots: number | undefined;

  // Windows a generic list states (NanoGPT detailed=true, vLLM max_model_len, OpenRouter context_length).
  for (const m of models) if (m.contextLength !== undefined && wanted.has(m.id)) put(m.id, { contextLength: m.contextLength });

  if (opts.model !== undefined && models.length > 0 && !models.some((m) => m.id === opts.model) && server !== 'llama.cpp' && server !== 'koboldcpp') {
    s.notes.push(`${opts.model} is not in the server's model list`);
  }

  switch (server) {
    case 'openrouter': {
      for (const m of models) if (wanted.has(m.id)) put(m.id, openRouterCaps(m.raw));
      break;
    }
    case 'llama.cpp': {
      const props = found.props ?? (await getJson(s, `${root}/props`, false));
      if (isRecord(props)) {
        const gen = isRecord(props['default_generation_settings']) ? props['default_generation_settings'] : {};
        const nCtx = posInt(gen['n_ctx']) ?? posInt(props['n_ctx']);
        slots = posInt(props['total_slots']);
        if (nCtx !== undefined) for (const id of targets) put(id, { contextLength: nCtx });
        else s.notes.push('llama.cpp: /props has no n_ctx');
      }
      if (slots === undefined) {
        const list = await getJson(s, `${root}/slots`);
        if (Array.isArray(list) && list.length > 0) slots = list.length;
      }
      if (models.length > 1) s.notes.push(`llama.cpp lists ${models.length} models; /props n_ctx is the loaded model's window`);
      break;
    }
    case 'ollama': {
      const ps = await getJson(s, `${root}/api/ps`);
      const loaded = new Map<string, number>();
      if (isRecord(ps) && Array.isArray(ps['models'])) {
        for (const m of ps['models'].filter(isRecord)) {
          const ctx = posInt(m['context_length']);
          if (ctx === undefined) continue;
          for (const k of ['name', 'model']) if (typeof m[k] === 'string') loaded.set(m[k] as string, ctx);
        }
      }
      const asked = targets.slice(0, OLLAMA_SHOW_MAX);
      if (targets.length > asked.length) s.notes.push(`ollama: /api/show asked for the first ${OLLAMA_SHOW_MAX} of ${targets.length} models`);
      const shows = await mapLimit(asked, OLLAMA_SHOW_PARALLEL, async (id) => {
        const out = await call(s, 'POST', `${root}/api/show`, { model: id });
        return { id, out };
      });
      for (const { id, out } of shows) {
        if (out.kind === 'failed') s.notes.push(`POST /api/show ${id}: ${out.why}`);
        else if (!out.reply.ok || !isRecord(out.reply.json)) s.notes.push(`POST /api/show ${id}: HTTP ${out.reply.status}`);
        else {
          const r = ollamaShowCaps(id, out.reply.json, loaded.get(id));
          put(id, r.caps);
          s.notes.push(...r.notes);
        }
      }
      break;
    }
    case 'koboldcpp': {
      const v = await getJson(s, `${root}/api/extra/true_max_context_length`, false);
      const ctx = isRecord(v) ? posInt(v['value']) : undefined;
      if (ctx !== undefined) for (const id of targets) put(id, { contextLength: ctx });
      break;
    }
    case 'lmstudio': {
      for (const id of targets) {
        const entry = (found.lmV1 ?? []).find(
          (m) => m['key'] === id || (Array.isArray(m['loaded_instances']) && m['loaded_instances'].some((i) => isRecord(i) && i['id'] === id)),
        );
        if (entry) {
          const instances = Array.isArray(entry['loaded_instances']) ? entry['loaded_instances'].filter(isRecord) : [];
          const inst = instances.find((i) => i['id'] === id) ?? instances[0];
          const config = inst && isRecord(inst['config']) ? inst['config'] : undefined;
          const ctx = config ? posInt(config['context_length']) : undefined;
          if (ctx !== undefined) put(id, { contextLength: ctx });
          else s.notes.push(`lmstudio: ${id} is not loaded (max ${posInt(entry['max_context_length']) ?? '?'} tokens); its window is set when it loads`);
          const parallel = config ? posInt(config['parallel']) : undefined;
          if (parallel !== undefined) slots = Math.max(slots ?? 0, parallel);
          const c = isRecord(entry['capabilities']) ? entry['capabilities'] : undefined;
          if (c && c['trained_for_tool_use'] === true) put(id, { tools: 'native' });
          continue;
        }
        const old = (found.lmV0 ?? []).find((m) => m['id'] === id);
        if (old) s.notes.push(`lmstudio: ${id}: the v0 API gives only the maximum (${posInt(old['max_context_length']) ?? '?'} tokens), not the loaded window`);
      }
      break;
    }
    default:
      break;
  }

  if (slots !== undefined && slots >= 2) {
    s.notes.push(
      `${server}: ${slots} slots reported; capacity stays at the connection's max_in_flight (default 1 locally): ` +
        'parallel slots may share one KV pool, and overflowing it fails every request in flight [D-84]',
    );
  }

  const info: CatalogInfo = {
    server,
    models: models.map((m) => {
      const ctx = caps[m.id]?.contextLength ?? m.contextLength;
      return ctx !== undefined ? { id: m.id, contextLength: ctx } : { id: m.id };
    }),
    caps,
    notes: [...new Set(s.notes)],
  };
  if (slots !== undefined) info.slots = slots;
  if (s.authFailed) info.authFailed = true;
  return info;
}

// ---------------------------------------------------------------------------------------------------
// <home>/caps-cache.json
// ---------------------------------------------------------------------------------------------------

/**
 * <home>/caps-cache.json: {"conn:model": {as_of, server?, catalog?, probe?}}. Missing file → {}.
 * Atomic writes. M3: catalog facts (the server's model list, /api/show, /props, OpenRouter
 * metadata) and active-probe facts are kept apart so `caps.source` tells them apart: config.ts feeds
 * `catalog` into resolveCaps' catalog slot and `probe` into its probe slot. A row written by M1b/M2
 * (`caps` only) reads as catalog facts.
 */
export interface CapsCacheRow {
  as_of: string;
  server?: string;
  catalog?: Partial<ModelCaps>;
  probe?: Partial<ModelCaps>;
  /** @deprecated M1b/M2 rows: read as `catalog`; never written from M3 on. */
  caps?: Partial<ModelCaps>;
}

export function capsCachePath(home: string): string {
  return join(home, 'caps-cache.json');
}

/**
 * A row as it is kept: {as_of, server?, catalog?, probe?}, a legacy `caps` read as `catalog`, every
 * part copied. Null when the row has no as_of string or no facts object at all.
 */
function normalizeRow(row: unknown): CapsCacheRow | null {
  if (!isRecord(row) || typeof row['as_of'] !== 'string') return null;
  const catalog = isRecord(row['catalog']) ? row['catalog'] : isRecord(row['caps']) ? row['caps'] : undefined;
  const probe = isRecord(row['probe']) ? row['probe'] : undefined;
  if (catalog === undefined && probe === undefined) return null;
  const r: CapsCacheRow = { as_of: row['as_of'] };
  if (typeof row['server'] === 'string') r.server = row['server'];
  if (catalog !== undefined) r.catalog = structuredClone(catalog) as Partial<ModelCaps>;
  if (probe !== undefined) r.probe = structuredClone(probe) as Partial<ModelCaps>;
  return r;
}

/**
 * Read the cache. A missing file is {}; so is a file that is not JSON or not an object (it is a
 * cache: `rp-core probe` rebuilds it). Rows without an as_of string or without any facts object
 * (catalog, probe, or the M1b/M2 `caps`) are dropped. A legacy row's `caps` comes back as `catalog`.
 */
export function readCapsCache(home: string): Record<string, CapsCacheRow> {
  let text: string;
  try {
    text = readFileSync(capsCachePath(home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, CapsCacheRow> = {};
  for (const [key, row] of Object.entries(parsed)) {
    const r = normalizeRow(row);
    if (r) out[key] = r;
  }
  return out;
}

/**
 * Write the cache atomically: a temp file in the same directory, fsync, rename over the old one. Keys
 * sorted. Rows go out as {as_of, server?, catalog?, probe?} (a legacy `caps` is written as `catalog`).
 */
export function writeCapsCache(home: string, cache: Record<string, CapsCacheRow>): void {
  mkdirSync(home, { recursive: true });
  const path = capsCachePath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  const sorted: Record<string, CapsCacheRow> = {};
  for (const key of Object.keys(cache).sort()) {
    const row = normalizeRow(cache[key]);
    if (row) sorted[key] = row;
  }
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(sorted, null, 2)}\n`);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
