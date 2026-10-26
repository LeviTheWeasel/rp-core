// Ported from Bunraku:src/stage/provider/openai-compatible-request.ts@702d8120 (resolveChatCompletionsUrl,
// toWireMessages, buildWireRequest), Bunraku:src/stage/provider/openai-compatible-reply.ts@702d8120
// (createStreamReader, extractContent / contentArrayReasoning) and Bunraku:src/stage/provider/
// openai-compatible.ts + provider-send.ts@702d8120 (the send loop: build, fetch, classify, read, abort).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The OpenAI-compatible Chat Completions adapter (ARCHITECTURE.md §8.1, §8.4 "openai-chat (M1)").
// Covers llama.cpp, Ollama, LM Studio, koboldcpp, vLLM, TabbyAPI, OpenRouter, NanoGPT, DeepSeek.
// Quirks list only (no code): RoleCall apps/rc/src/lib/providers/adapters/openai.ts, base.ts.
//
// Three pure-ish parts and a thin loop:
// - chatCompletionsUrl / buildChatRequest: PromptMsg blocks + the capability record → url, headers,
//   JSON body. Everything the body carries is decided by caps (data, §8.2), never by the model id.
// - createChatParser: one stateful reader per request over SSE data payloads → StreamEv.
// - createOpenAIChatProvider: guardedFetch → classifyHttpFailure | sseEvents → parser. Stateless
//   between calls; the fetch and the key come with every call (§8.1).
//
// Changes from Bunraku:
// - Messages are rendered from blocks (text / reasoning / tool_call / tool_result) instead of string
//   ProviderMessage; reasoning is echoed only by caps.reasoning.echo (DeepSeek 'all-with-tools') and
//   replay payloads are rendered by kind (§8.6), matched on connection + model.
// - Mid-dialogue system messages are left to shape.ts (caps.midSystem), not to a model-id regex
//   ("targetsAnthropic"); the PARAMS registry and reasoning-wire.ts tables became caps data
//   (samplers.accepted / wire, reasoning.control / efforts / offShape, extraBody, stopMax).
// - The reader emits events (text, reasoning, reasoning_end, tool_*, usage, finish, error) instead of
//   building one completion. Tool call fragments: the name is ASSIGNED, never concatenated (§19.4
//   "Не переносить": function.name +=); a new id on a used index opens a new call; calls without a
//   name are dropped; unknown call keys are kept for replay.
// - An error object inside a 200 stream is a failure even when the chunk also carries choices
//   (OpenRouter), and so is finish_reason "error"; errors are classified onto the D-51 codes (not
//   "everything but 401 is backend_error"). EOF without finish and [DONE] is 'truncated_stream'.
// - No non-streaming path and no whole-call timeout: the engine always streams and owns the
//   first-byte and idle timers (§8.8).

import { ProviderError, PROVIDER_ERROR_CATEGORY, providerMessage } from './types.ts';
import type { ModelCaps, ModelRequest, PromptMsg, Provider, ProviderEnv, ProviderErrorCode, Replay, StreamEv, ToolSpec, Usage } from './types.ts';
import type { Block } from '../session/entries.ts';
import { bodyBytes, classifyHttpFailure, guardedFetch, isModerationError, originOf, type HttpRequest } from './http.ts';
import { sseEvents } from './sse.ts';
import { applyOverrides, normalizeFinish, remapToolIds, validateToolProtocol, type ConnectionOverrides } from './wire.ts';
import { createReasoningSplitter, DEFAULT_REASONING_TAGS, tagPairs } from './reasoning-tags.ts';

export interface OpenAIChatOptions {
  connectionId: string;
  baseUrl: string;
  local: boolean;
  overrides?: ConnectionOverrides;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function providerError(
  code: ProviderErrorCode,
  message: string,
  extra: { status?: number; afterOutput?: boolean; detail?: string } = {},
): ProviderError {
  return new ProviderError({ category: PROVIDER_ERROR_CATEGORY[code], code, message, ...extra });
}

// ---- URL -----------------------------------------------------------------------------------------

/** A path segment that names an API version: v1, v4, v1beta, v1alpha2 (Google's /v1beta/openai). */
const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?$/i;
/** Endpoint suffixes people paste into a base URL field. */
const PASTED_SUFFIX = /\/(?:chat\/completions|completions|models)$/i;

/** Keep a path that has a /vN segment; else append /v1. Strip pasted /models, /completions, /chat/completions; then add /chat/completions. */
export function chatCompletionsUrl(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    // The URL is not echoed: a pasted base URL may carry a key in its query.
    throw new TypeError('not a valid http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError(`not an http(s) URL (scheme ${u.protocol})`);
  const path = u.pathname.replace(/\/+$/, '').replace(PASTED_SUFFIX, '').replace(/\/+$/, '');
  // A version segment anywhere in the path counts (OpenRouter /api/v1, Z.AI /api/coding/paas/v4,
  // Google /v1beta/openai): the server chose its layout, only a bare origin gets /v1. A final /beta
  // is DeepSeek's beta base (https://api.deepseek.com/beta, needed for `prefix: true`): its endpoint
  // is /beta/chat/completions, without a /v1.
  const segments = path.split('/');
  const versioned = segments.some((seg) => VERSION_SEGMENT.test(seg)) || segments.at(-1)?.toLowerCase() === 'beta';
  u.pathname = `${path}${versioned ? '' : '/v1'}/chat/completions`;
  u.hash = '';
  return u.href;
}

// ---- messages ------------------------------------------------------------------------------------

/** Text blocks of a message joined with a blank line; blank parts add nothing. */
function textOf(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { k: 'text' }> => b.k === 'text')
    .map((b) => b.text)
    .filter((t) => t.trim() !== '')
    .join('\n\n');
}

/** The raw reasoning of an assistant message, for the DeepSeek echo (summaries and redactions are not the model's own text). */
function reasoningOf(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { k: 'reasoning' }> => b.k === 'reasoning' && (b.kind === undefined || b.kind === 'raw'))
    .map((b) => b.text)
    .filter((t) => t !== '')
    .join('\n\n');
}

/** The replay payloads of a message that this connection and model produced (§8.6: never across models). */
function replayFor(m: PromptMsg, req: ModelRequest, kind: Replay['kind']): unknown[] {
  return (m.replay ?? [])
    .filter((r) => r.kind === kind && r.connection === req.model.connection && r.model === req.model.model)
    .map((r) => r.payload);
}

interface RenderCtx {
  req: ModelRequest;
  /** Field the reasoning echo goes to, or null when nothing is echoed. */
  echoField: 'reasoning_content' | 'reasoning' | null;
}

/**
 * One PromptMsg → wire messages (tool results become one 'tool' message each, before any text).
 * `orig` is the message before tool id remapping: replay payloads are keyed by the ids the server sent.
 */
function renderMessage(m: PromptMsg, orig: PromptMsg, ctx: RenderCtx): Rec[] {
  const out: Rec[] = [];
  const text = textOf(m.blocks);
  if (m.role === 'assistant') {
    const wire: Rec = { role: 'assistant', content: text };
    const calls = m.blocks.filter((b): b is Extract<Block, { k: 'tool_call' }> => b.k === 'tool_call');
    const origCalls = orig.blocks.filter((b): b is Extract<Block, { k: 'tool_call' }> => b.k === 'tool_call');
    if (ctx.echoField) {
      const reasoning = reasoningOf(m.blocks);
      if (reasoning !== '') wire[ctx.echoField] = reasoning;
    }
    if (calls.length > 0) {
      // Extra keys the server sent on a call (Gemini's extra_content.google.thought_signature), by call id.
      const extras: Rec = Object.assign({}, ...replayFor(orig, ctx.req, 'tool_extra').filter(isRecord));
      wire.tool_calls = calls.map((c, n) => {
        const extra = extras[origCalls[n]?.id ?? c.id];
        return {
          ...(isRecord(extra) ? extra : {}),
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args.trim() === '' ? '{}' : c.args },
        };
      });
      // Strict servers answer `content: "" + tool_calls` with an empty body (Bunraku, RoleCall base.ts).
      if (text === '') wire.content = null;
    }
    // OpenRouter reasoning_details, verbatim, inside the current tool loop only (§8.6).
    const details = replayFor(orig, ctx.req, 'reasoning_details').flatMap((p) => (Array.isArray(p) ? p : []));
    if (details.length > 0) wire.reasoning_details = details;
    out.push(wire);
    return out;
  }
  for (const b of m.blocks) {
    if (b.k === 'tool_result') out.push({ role: 'tool', tool_call_id: b.callId, content: b.text });
  }
  const hasResults = out.length > 0;
  if (text !== '' || !hasResults) {
    // A 'tool' message cannot carry plain text on this wire (it needs tool_call_id): it goes as user.
    out.push({ role: m.role === 'tool' ? 'user' : m.role, content: text });
  }
  return out;
}

/**
 * The wire messages: the leading system run merged into one system message, everything after it
 * rendered in order (later system messages stay 'system': shape.ts already turned them into user
 * notes when caps.midSystem is 'as-user'), then the prefill per caps.prefill.
 */
function wireMessages(req: ModelRequest, toolsSent: boolean): Rec[] {
  const caps = req.caps;
  const messages = remapToolIds(req.messages, caps.toolIdFormat);
  const out: Rec[] = [];
  let i = 0;
  const head: string[] = [];
  while (i < messages.length && messages[i]!.role === 'system') {
    const t = textOf(messages[i]!.blocks);
    if (t !== '') head.push(t);
    i++;
  }
  if (i > 0) out.push({ role: 'system', content: head.join('\n\n') });

  // DeepSeek thinking with tools needs reasoning_content on every past assistant turn, or 400 (§8.4).
  // The core put only this model's reasoning on the path; the adapter only places it.
  const toolTraffic = toolsSent || messages.some((m) => m.blocks.some((b) => b.k === 'tool_call'));
  const echoField =
    caps.reasoning.echo === 'all-with-tools' && toolTraffic ? (caps.reasoning.output === 'reasoning' ? 'reasoning' : 'reasoning_content') : null;
  const ctx: RenderCtx = { req, echoField };
  for (; i < messages.length; i++) out.push(...renderMessage(messages[i]!, req.messages[i]!, ctx));

  const prefill = req.prefill ?? '';
  if (prefill !== '') {
    if (caps.prefill === 'assistant-last') out.push({ role: 'assistant', content: prefill });
    else if (caps.prefill === 'prefix-flag') out.push({ role: 'assistant', content: prefill, prefix: true });
    // 'none': not sent (shape.ts already reported prefill_unsupported).
  }
  return out;
}

// ---- body ----------------------------------------------------------------------------------------

/** The sampler fields of Samplers that are real samplers (stop and max_tokens are placed separately). */
const SAMPLER_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'typical_p',
  'repetition_penalty',
  'frequency_penalty',
  'presence_penalty',
  'seed',
] as const;

/** Samplers the record accepts, under their wire names; none at all when the model's sampling is fixed. */
function samplerFields(req: ModelRequest): Rec {
  const spec = req.caps.samplers;
  const out: Rec = {};
  if (spec.fixed) return out;
  for (const key of SAMPLER_KEYS) {
    const v = req.samplers[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !spec.accepted.includes(key)) continue;
    // top_p 0 is RoleCall's and ST's "off", never a real setting (and a 400 on several servers).
    if (key === 'top_p' && v === 0) continue;
    out[spec.wire?.[key] ?? key] = v;
  }
  return out;
}

/** Stop strings: only where 'stop' is accepted, blanks and repeats removed, capped at caps.stopMax. */
function stopField(req: ModelRequest): Rec {
  const spec = req.caps.samplers;
  if (!spec.accepted.includes('stop')) return {};
  const list = [...new Set((req.stop ?? req.samplers.stop ?? []).filter((s): s is string => typeof s === 'string' && s !== ''))];
  const capped = req.caps.stopMax !== undefined ? list.slice(0, Math.max(0, req.caps.stopMax)) : list;
  return capped.length > 0 ? { [spec.wire?.stop ?? 'stop']: capped } : {};
}

/** Native tools are sent only when the record says native and the call does not forbid calls the server would not honour. */
function toolsToSend(req: ModelRequest): ToolSpec[] {
  const caps = req.caps;
  if (caps.tools !== 'native' || !req.tools || req.tools.length === 0) return [];
  // tool_choice 'none' on a server that ignores tool_choice (Ollama): the only way to say "no calls" is no tools.
  if (req.toolChoice === 'none' && !caps.toolChoiceHonored) return [];
  // Sorted by name, so the tool block (the very front of the prompt) is stable for the cache (§8.7).
  return [...req.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function toolFields(req: ModelRequest, tools: readonly ToolSpec[]): Rec {
  if (tools.length === 0) return {};
  const out: Rec = {
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
  };
  // Only 'auto' / 'none' ever (§8.3); and only when the record lists it (DeepSeek reasoners: none at all).
  if (req.toolChoice !== undefined && req.caps.toolChoice.includes(req.toolChoice)) out.tool_choice = req.toolChoice;
  // llama.cpp answers one call per turn unless told otherwise; 'param' servers already default to parallel.
  if (req.caps.parallelToolCalls === 'send-true') out.parallel_tool_calls = true;
  return out;
}

/** Thinking on/off/effort per caps.reasoning.control; 'auto' (or no setting) sends nothing. */
function reasoningControl(req: ModelRequest): Rec {
  const r = req.caps.reasoning;
  const want = req.reasoning;
  if (want === undefined || want === 'auto') return {};
  const offShape = isRecord(r.offShape) ? r.offShape : undefined;
  if (r.control === 'effort') {
    if (r.efforts?.includes(want)) return { reasoning_effort: want };
    // 'none' that is not an effort value: the model's own off switch, when it has one.
    if (want === 'none' && r.canDisable && offShape) return offShape;
    return {};
  }
  if (r.control === 'toggle') {
    if (want === 'none') {
      if (!r.canDisable) return {};
      return offShape ?? { chat_template_kwargs: { enable_thinking: false } };
    }
    // On: the template switch says so explicitly; another off switch (DeepSeek's `thinking`) means
    // the model thinks by default, so nothing is sent.
    const kwargs = offShape?.chat_template_kwargs;
    if (offShape === undefined || (isRecord(kwargs) && 'enable_thinking' in kwargs)) return { chat_template_kwargs: { enable_thinking: true } };
    return {};
  }
  // 'none', and the anthropic/gemini controls ('budget', 'adaptive', 'level'): nothing on this wire.
  return {};
}

/** Pure request builder (no I/O): url, headers (Authorization only when key), JSON body. */
export function buildChatRequest(req: ModelRequest, o: OpenAIChatOptions, key: string | null): HttpRequest {
  const caps: ModelCaps = req.caps;
  const verdict = validateToolProtocol(req.messages);
  if (!verdict.ok) throw providerError('tool_protocol_invalid', `the request breaks the tool protocol: ${verdict.why}`);

  const tools = toolsToSend(req);
  let body: Rec = {
    model: req.model.model,
    messages: wireMessages(req, tools.length > 0),
    stream: true,
  };
  if (caps.streamUsage === 'stream_options') body.stream_options = { include_usage: true };
  if (Number.isInteger(req.maxTokens) && req.maxTokens > 0) body[caps.maxTokensField] = req.maxTokens;
  Object.assign(body, samplerFields(req), stopField(req), toolFields(req, tools));
  if (req.responseSchema && caps.structuredOutput.mode === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema } };
  }
  // Host and model facts (llama.cpp cache_prompt, OpenRouter provider.allow_fallbacks, Gemini safety
  // settings), deep-merged; protected keys (model, messages, stream, tools, tool_choice) are skipped.
  if (caps.extraBody) body = applyOverrides(body, {}, { extraBody: caps.extraBody }).body;
  // The session's thinking setting, after the data defaults (deep: chat_template_kwargs may hold more).
  const control = reasoningControl(req);
  if (Object.keys(control).length > 0) body = applyOverrides(body, {}, { extraBody: control }).body;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  // [D-53] the connection's escape hatch, last.
  const final = applyOverrides(body, headers, o.overrides);
  return { url: chatCompletionsUrl(o.baseUrl), method: 'POST', headers: final.headers, body: JSON.stringify(final.body) };
}

// ---- reading -------------------------------------------------------------------------------------

/** A finite, non-negative number or undefined. */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Assign defined fields only, so a missing field stays "unknown" instead of becoming zero (§8.1). */
function put<K extends keyof Usage>(u: Usage, k: K, v: Usage[K] | undefined): void {
  if (v !== undefined) u[k] = v;
}

/** OpenAI-shape usage: OpenAI, Ollama, vLLM, OpenRouter (cost, cache write), DeepSeek (cache hit). */
function usageOf(raw: Rec): Usage {
  const u: Usage = {};
  const pd = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const cd = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
  put(u, 'inputTotal', count(raw.prompt_tokens));
  put(u, 'inputCacheRead', count(pd.cached_tokens) ?? count(raw.prompt_cache_hit_tokens));
  put(u, 'inputCacheWrite', count(pd.cache_write_tokens));
  put(u, 'outputTotal', count(raw.completion_tokens));
  put(u, 'outputReasoning', count(cd.reasoning_tokens));
  put(u, 'cost', count(raw.cost));
  return u;
}

/** llama.cpp `timings`: prompt_n tokens evaluated, cache_n reused from the slot's KV, predicted_n generated. */
function usageOfTimings(t: Rec): Usage {
  const u: Usage = {};
  const evaluated = count(t.prompt_n);
  const cached = count(t.cache_n);
  if (evaluated !== undefined) u.inputTotal = evaluated + (cached ?? 0);
  put(u, 'inputCacheRead', cached);
  put(u, 'outputTotal', count(t.predicted_n));
  return u;
}

/** An HTTP status from a number or a three-digit string (OpenRouter puts the upstream status in error.code). */
function statusOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/** How servers say the prompt does not fit (the HTTP table's list, for errors that arrive inside a 200). */
const CONTEXT_EXCEEDED =
  /context[_ ]length[_ ]exceeded|exceed_context_size|maximum context length|context (?:length|window|size)[^.]{0,80}exceed|exceed[^.]{0,80}context (?:length|window|size)|prompt is too long|max_seq_len|maximum model length|max_model_len|too many (?:input|prompt) tokens/i;

function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'timeout';
  if (status === 413) return 'context_length_exceeded';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'overloaded';
  return 'bad_request';
}

/** Error codes/types servers put in a stream error object (OpenAI, OpenRouter, vLLM, llama.cpp). */
function codeForName(name: string): ProviderErrorCode {
  const n = name.toLowerCase();
  if (/rate.?limit|too_many_requests|quota/.test(n)) return 'rate_limited';
  if (/context_length|exceed_context/.test(n)) return 'context_length_exceeded';
  if (/auth|api_key|unauthori[sz]ed|permission|forbidden/.test(n)) return 'auth_failed';
  if (/model_not_found|not_found/.test(n)) return 'model_not_found';
  if (/content_filter|content_policy|moderation|safety/.test(n)) return 'content_filter';
  if (/invalid_request|bad_request|invalid_param|validation/.test(n)) return 'bad_request';
  if (/timeout|timed_out/.test(n)) return 'timeout';
  // server_error, overloaded, internal_error, service_unavailable and anything unknown: a stream that
  // started and then failed is the server's failure.
  return 'overloaded';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * An error reported inside a 200 stream → ProviderError (classified by status, then code/type, then
 * message; a 403 moderation refusal is content_filter, as in http.ts). The message is the fixed
 * sentence of the code (§13); the server's words are kept in `detail` for --debug.
 */
function streamError(value: unknown, afterOutput: boolean, fallback: string): ProviderError {
  const e = isRecord(value) ? value : {};
  const meta = isRecord(e.metadata) ? e.metadata : {};
  const message = str(e.message) || (typeof value === 'string' ? value : '') || fallback;
  const name = (typeof e.code === 'string' && statusOf(e.code) === undefined ? e.code : '') || str(e.type);
  const status = statusOf(e.status) ?? statusOf(e.code) ?? statusOf(meta.status);
  let code: ProviderErrorCode = status !== undefined ? codeForStatus(status) : codeForName(name);
  if ((code === 'bad_request' || code === 'overloaded') && CONTEXT_EXCEEDED.test(`${name} ${message}`)) code = 'context_length_exceeded';
  if (status === 403 && isModerationError(value)) code = 'content_filter';
  let detail = clip(message, 500);
  if (meta.raw !== undefined) detail += ` | upstream: ${clip(typeof meta.raw === 'string' ? meta.raw : JSON.stringify(meta.raw), 300)}`;
  else if (str(meta.provider_name)) detail += ` (via ${str(meta.provider_name)})`;
  return providerError(code, `${providerMessage(code, status)} inside the stream`, { ...(status !== undefined ? { status } : {}), afterOutput, detail });
}

/** One tool call being assembled from fragments. */
interface ToolCallState {
  /** The server's index (only used to route fragments). */
  wire: number;
  id?: string;
  name?: string;
  /** Arguments received before the call could start (no name, or no id yet). */
  pending: string;
  /** Unknown keys of the call (extra_content.google.thought_signature …), kept for replay. */
  extra?: Rec;
  fragments: number;
  /** Our event index, once tool_start went out. */
  slot?: number;
  ended: boolean;
}

/** The parser plus what an aggregator needs beyond the events (replay payloads, state). */
export interface ChatReader {
  line(data: string): StreamEv[];
  end(): StreamEv[];
  /** [DONE], an error, or end() has been seen: nothing more will come out. */
  readonly done: boolean;
  /** Text, reasoning or a tool call went out. */
  readonly output: boolean;
  /** A finish_reason arrived (the answer is complete even if [DONE] or usage never does). */
  readonly finished: boolean;
  /**
   * Verbatim payloads for replay inside the current tool loop (§8.6): 'reasoning_details' (the
   * OpenRouter array, as streamed) and 'tool_extra' ({[callId]: {unknown call keys}}). StreamEv has
   * no replay event yet (M3), so an aggregator reads them here.
   */
  replay(): Replay[];
}

/** Keys of a streamed tool call that the reader understands; the rest is kept for replay. */
const KNOWN_CALL_KEYS: ReadonlySet<string> = new Set(['index', 'id', 'type', 'function']);

/** Deep merge for replay extras (objects key by key, anything else replaced). */
function mergeExtra(into: Rec, from: Rec): void {
  for (const [k, v] of Object.entries(from)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const cur = into[k];
    if (isRecord(cur) && isRecord(v)) mergeExtra(cur, v);
    else if (isRecord(v)) {
      const copy: Rec = {};
      mergeExtra(copy, v);
      into[k] = copy;
    } else into[k] = v; // freshly parsed JSON: nothing else holds it
  }
}

/** The reader behind createChatParser, with replay and state exposed. */
export function createChatReader(req: ModelRequest): ChatReader {
  const caps = req.caps;
  const splitter = createReasoningSplitter(tagPairs(caps.reasoning.tags ?? DEFAULT_REASONING_TAGS));
  const answerInReasoning = caps.reasoning.answerInReasoning === true;
  /** Synthesised ids: unique per call, deterministic, within the SAFE_ID alphabet of wire.ts. */
  const idPrefix = `call_${req.callKey.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 96)}_`;

  let terminated = false;
  let output = false;
  let finishRaw: string | null = null;
  /** The finish event went out (at the finish_reason; usage may still follow it, §8.1). */
  let finishSent = false;
  /** The merged usage last emitted, as JSON (usage goes out again only when it changed). */
  let usageSent: string | null = null;
  let model: string | undefined;
  let usage: Usage | undefined;
  let timings: Usage | undefined;
  let last: 'text' | 'reasoning' | 'tool' | null = null;
  let nextSlot = 0;
  const calls: ToolCallState[] = [];
  const byWire = new Map<number, ToolCallState>();
  const details: unknown[] = [];

  function text(d: string, out: StreamEv[]): void {
    if (d === '') return;
    if (last === 'reasoning') out.push({ t: 'reasoning_end', i: 0 });
    out.push({ t: 'text', i: 0, d });
    last = 'text';
    output = true;
  }

  function reasoning(d: string, out: StreamEv[]): void {
    if (d === '') return;
    // Some models answer in the reasoning field; the record says so (data, not a fallback guess).
    if (answerInReasoning) return text(d, out);
    out.push({ t: 'reasoning', i: 0, d });
    last = 'reasoning';
    output = true;
  }

  /** Content through the inline-tag splitter (<think> … </think> and the other pairs of caps.reasoning.tags). */
  function content(s: string, out: StreamEv[]): void {
    for (const piece of splitter.push(s)) (piece.kind === 'text' ? text : reasoning)(piece.d, out);
  }

  function flushSplitter(out: StreamEv[]): void {
    for (const piece of splitter.end()) (piece.kind === 'text' ? text : reasoning)(piece.d, out);
  }

  function startCall(c: ToolCallState, out: StreamEv[]): void {
    if (last === 'reasoning') out.push({ t: 'reasoning_end', i: 0 });
    const slot = nextSlot++;
    c.slot = slot;
    c.id ??= `${idPrefix}${slot}`;
    out.push({ t: 'tool_start', i: slot, id: c.id, name: c.name! });
    if (c.pending !== '') out.push({ t: 'tool_args', i: slot, d: c.pending });
    c.pending = '';
    last = 'tool';
    output = true;
  }

  /** Close one call: a named call that never started starts now; a nameless one is dropped. */
  function endCall(c: ToolCallState, out: StreamEv[]): void {
    if (c.ended) return;
    c.ended = true;
    if (c.slot === undefined) {
      if (c.name === undefined) return;
      startCall(c, out);
    }
    out.push({ t: 'tool_end', i: c.slot! });
  }

  function endCalls(out: StreamEv[]): void {
    for (const c of calls) endCall(c, out);
  }

  function toolDelta(tc: unknown, position: number, out: StreamEv[]): void {
    if (!isRecord(tc)) return;
    const wire = typeof tc.index === 'number' && Number.isInteger(tc.index) ? tc.index : position;
    const fn = isRecord(tc.function) ? tc.function : {};
    const id = str(tc.id);
    const name = str(fn.name);
    const args = typeof fn.arguments === 'string' ? fn.arguments : isRecord(fn.arguments) ? JSON.stringify(fn.arguments) : '';

    let c = byWire.get(wire);
    // A new id on a used index is a new call (servers that number every call 0); so is any fragment
    // after the call was closed by its finish.
    if (c && (c.ended || (id !== '' && c.id !== undefined && id !== c.id))) {
      endCall(c, out);
      c = undefined;
    }
    if (!c) {
      c = { wire, pending: '', fragments: 0, ended: false };
      byWire.set(wire, c);
      calls.push(c);
    }
    c.fragments++;
    if (id !== '' && c.id === undefined && c.slot === undefined) c.id = id;
    // Assigned, never concatenated: vLLM and others repeat the whole name on later fragments.
    if (name !== '' && c.slot === undefined) c.name = name;
    for (const [k, v] of Object.entries(tc)) {
      if (KNOWN_CALL_KEYS.has(k)) continue;
      c.extra ??= {};
      mergeExtra(c.extra, { [k]: v });
    }
    if (args !== '') {
      if (c.slot !== undefined) out.push({ t: 'tool_args', i: c.slot, d: args });
      else c.pending += args;
    }
    // Start once named and identified; a named call whose id did not come with its first fragment
    // gets a synthesised one on the next (a placeholder is never replaced after tool_start).
    if (c.slot === undefined && c.name !== undefined && (c.id !== undefined || c.fragments > 1)) startCall(c, out);
  }

  function delta(d: Rec, out: StreamEv[]): void {
    // Reasoning first: in one delta it precedes the answer. Every known field, deduplicated:
    // reasoning_content, then reasoning when it differs, then reasoning_details only when neither
    // carried text (OpenRouter sends `reasoning` and the same text again in reasoning_details).
    const rc = str(d.reasoning_content);
    const r = str(d.reasoning);
    reasoning(rc, out);
    if (r !== rc) reasoning(r, out);
    if (Array.isArray(d.reasoning_details)) {
      details.push(...d.reasoning_details);
      if (rc === '' && r === '') {
        const t = d.reasoning_details.map((p) => (isRecord(p) ? str(p.text) || str(p.summary) : '')).join('');
        reasoning(t, out);
      }
    }
    const c = d.content;
    if (typeof c === 'string') content(c, out);
    else if (Array.isArray(c)) {
      // Content parts (Mistral Magistral): thinking parts are reasoning, text parts are content.
      for (const part of c) {
        if (!isRecord(part)) continue;
        const type = str(part.type).toLowerCase();
        if (type === 'thinking' || type === 'reasoning') {
          const inner = Array.isArray(part.thinking) ? part.thinking.map((x) => (isRecord(x) ? str(x.text) : '')).join('') : '';
          reasoning(str(part.text) || inner || str(part.thinking), out);
        } else content(str(part.text), out);
      }
    }
    if (Array.isArray(d.tool_calls)) d.tool_calls.forEach((tc, n) => toolDelta(tc, n, out));
  }

  function fail(value: unknown, fallback: string, out: StreamEv[]): StreamEv[] {
    terminated = true;
    const err = streamError(value, output, fallback);
    out.push({ t: 'error', err, afterOutput: output });
    return out;
  }

  /** The usage known so far, when it is new or changed since it last went out. */
  function flushUsage(out: StreamEv[]): void {
    // usage fields win; llama.cpp timings fill what usage lacks (the cache split).
    const u: Usage = { ...(timings ?? {}), ...(usage ?? {}) };
    if (Object.keys(u).length === 0) return;
    const key = JSON.stringify(u);
    if (key === usageSent) return;
    usageSent = key;
    out.push({ t: 'usage', u });
  }

  /** Close what is open: text held by the splitter, tool calls, a reasoning segment. */
  function settle(out: StreamEv[]): void {
    flushSplitter(out);
    endCalls(out);
    if (last === 'reasoning') {
      out.push({ t: 'reasoning_end', i: 0 });
      last = null;
    }
  }

  /**
   * The finish, as soon as it is known: the answer is complete at the finish_reason, so the consumer
   * hears it then, and a stall, a reset or a Stop while waiting for usage / [DONE] costs only the
   * usage (§8.1; the engine records such a failure as a tail error and keeps the answer).
   */
  function finishNow(out: StreamEv[]): void {
    settle(out);
    flushUsage(out);
    out.push({ t: 'finish', reason: normalizeFinish(finishRaw), raw: finishRaw ?? '', ...(model !== undefined ? { model } : {}) });
    finishSent = true;
  }

  /** The closing events at [DONE] / EOF: the finish when it has not gone out yet, else the usage that came after it. */
  function close(out: StreamEv[]): StreamEv[] {
    terminated = true;
    if (finishSent) {
      settle(out);
      flushUsage(out);
    } else finishNow(out);
    return out;
  }

  function line(data: string): StreamEv[] {
    if (terminated) return [];
    const payload = data.trim();
    if (payload === '') return [];
    if (payload === '[DONE]') return close([]);
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return []; // keep-alive noise; a stream of nothing but noise ends as truncated
    }
    if (!isRecord(chunk)) return [];
    const out: StreamEv[] = [];
    if (str(chunk.model) !== '') model = str(chunk.model);
    if (isRecord(chunk.usage)) {
      const u = usageOf(chunk.usage);
      if (Object.keys(u).length > 0) usage = u; // cumulative where servers repeat it; {} is "unknown"
    }
    if (isRecord(chunk.timings)) {
      const t = usageOfTimings(chunk.timings);
      if (Object.keys(t).length > 0) timings = t;
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (isRecord(choice)) {
      const d = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined;
      if (d) delta(d, out);
      const fr = choice.finish_reason;
      if (typeof fr === 'string' && fr !== '') {
        // OpenRouter ends a failed generation with finish_reason "error" (with or without an error object).
        if (fr.trim().toLowerCase() === 'error') return fail(chunk.error, 'the provider ended the stream with an error', out);
        // The first finish_reason finishes the answer; a server that repeats it changes nothing.
        if (finishRaw === null) {
          finishRaw = fr;
          finishNow(out);
        }
      }
    }
    // An error inside a 200 stream is a failure, choices or not (§8.1; RoleCall skipped it when
    // choices were present).
    if (chunk.error !== undefined && chunk.error !== null) return fail(chunk.error, 'the provider reported an error inside the stream', out);
    return out;
  }

  function end(): StreamEv[] {
    if (terminated) return [];
    if (finishRaw !== null) return close([]);
    // EOF without finish and without [DONE]: truncated, never an invented stop (§8.1). Text still in
    // the splitter's carry goes out first; half-assembled tool calls do not.
    terminated = true;
    const out: StreamEv[] = [];
    flushSplitter(out);
    out.push({
      t: 'error',
      err: providerError('truncated_stream', 'the stream ended without a finish', { afterOutput: output }),
      afterOutput: output,
    });
    return out;
  }

  function replay(): Replay[] {
    const out: Replay[] = [];
    const base = { connection: req.model.connection, model: req.model.model };
    if (details.length > 0) out.push({ kind: 'reasoning_details', ...base, payload: [...details] });
    const extras: Rec = {};
    for (const c of calls) if (c.extra && c.slot !== undefined && c.id !== undefined) extras[c.id] = c.extra;
    if (Object.keys(extras).length > 0) out.push({ kind: 'tool_extra', ...base, payload: extras });
    return out;
  }

  return {
    line,
    end,
    replay,
    get done() {
      return terminated;
    },
    get output() {
      return output;
    },
    get finished() {
      return finishRaw !== null;
    },
  };
}

/**
 * Per-request stateful parser over SSE data payloads. line() takes one data string (JSON or '[DONE]')
 * and returns normalised events; the finish goes out with the chunk that carries finish_reason (with
 * the usage known by then), and usage that follows it (OpenAI's choices:[] chunk) goes out at [DONE].
 * end() is called at EOF and returns the closing events (the finish or the late usage, or an error
 * 'truncated_stream' when neither finish nor [DONE] arrived).
 */
export function createChatParser(req: ModelRequest): { line(data: string): StreamEv[]; end(): StreamEv[] } {
  return createChatReader(req);
}

// ---- the provider --------------------------------------------------------------------------------

/** The server's clock from its Date header (Retry-After dates are relative to it); undefined when absent. */
function serverNow(res: Response): Date | undefined {
  const h = res.headers.get('date');
  const at = h === null ? NaN : Date.parse(h);
  return Number.isNaN(at) ? undefined : new Date(at);
}

/** classifyHttpFailure without a trustworthy clock: a dated Retry-After is dropped rather than guessed. */
async function httpFailure(res: Response): Promise<ProviderError> {
  const now = serverNow(res);
  const err = await classifyHttpFailure(res, { now: now ?? new Date(0) });
  const ra = res.headers.get('retry-after')?.trim() ?? '';
  if (now !== undefined || err.retryAfterSec === undefined || ra === '' || /^\d+(?:\.\d+)?$/.test(ra)) return err;
  return new ProviderError({
    category: err.category,
    code: err.code,
    message: err.message,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.detail !== undefined ? { detail: err.detail } : {}),
    afterOutput: err.afterOutput,
  });
}

/** The body's bytes, telling `onActivity` about each chunk (comments and keep-alives count, §8.8). */
async function* withActivity(bytes: AsyncIterable<Uint8Array>, onActivity: (() => void) | undefined): AsyncGenerator<Uint8Array> {
  for await (const chunk of bytes) {
    onActivity?.();
    yield chunk;
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** An `event: error` SSE event → a payload the parser reads as an in-stream error. */
function errorPayload(data: string): string {
  try {
    const v: unknown = JSON.parse(data);
    if (isRecord(v) && 'error' in v) return data;
    return JSON.stringify({ error: v });
  } catch {
    return JSON.stringify({ error: { message: data } });
  }
}

/** Bytes kept from a 200 application/json body (a server that ignored stream:true, or a proxy's error). */
const JSON_BODY_CAP = 8 * 1024 * 1024;

/**
 * A 200 that is a JSON document instead of an event stream: an error object fails the call; a whole
 * completion is fed to the parser as one chunk plus [DONE]; anything else ends as truncated.
 */
async function readJsonBody(res: Response, signal: AbortSignal, reader: ChatReader, onActivity?: () => void): Promise<StreamEv[]> {
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for await (const chunk of withActivity(bodyBytes(res, signal), onActivity)) {
    size += chunk.byteLength;
    if (size > JSON_BODY_CAP) break;
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(doc)) return [];
  if ('error' in doc && doc.error !== null && doc.error !== undefined) return reader.line(JSON.stringify({ error: doc.error }));
  if (!Array.isArray(doc.choices)) return [];
  return [...reader.line(text), ...reader.line('[DONE]')];
}

async function* streamChat(req: ModelRequest, env: ProviderEnv, o: OpenAIChatOptions): AsyncGenerator<StreamEv> {
  const { signal } = req;
  signal.throwIfAborted();

  let http: HttpRequest;
  let allowedOrigin: string;
  try {
    http = buildChatRequest(req, o, env.key);
    allowedOrigin = originOf(o.baseUrl);
  } catch (e) {
    const err = e instanceof ProviderError ? e : providerError('unreachable', 'the connection has no valid http(s) base URL');
    yield { t: 'error', err, afterOutput: false };
    return;
  }

  let res: Response;
  try {
    res = await guardedFetch(http, { fetch: env.fetch, signal, allowedOrigin });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    const err = e instanceof ProviderError ? e : providerError('unreachable', `could not reach ${allowedOrigin}`, { detail: errorText(e) });
    yield { t: 'error', err, afterOutput: false };
    return;
  }

  if (!res.ok) {
    let err: ProviderError;
    try {
      err = await httpFailure(res);
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      err = providerError('unreachable', `HTTP ${res.status}`, { status: res.status });
    }
    signal.throwIfAborted();
    yield { t: 'error', err, afterOutput: false };
    return;
  }

  const reader = createChatReader(req);
  try {
    if ((res.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      for (const ev of await readJsonBody(res, signal, reader, env.onActivity)) {
        signal.throwIfAborted();
        yield ev;
      }
    } else {
      for await (const sse of sseEvents(withActivity(bodyBytes(res, signal), env.onActivity))) {
        const events = sse.event === 'error' ? reader.line(errorPayload(sse.data)) : reader.line(sse.data);
        for (const ev of events) {
          // A consumer that stopped the call while handling the previous event gets nothing more.
          signal.throwIfAborted();
          yield ev;
        }
        // [DONE] or an error: stop reading (leaving the loop cancels the body).
        if (reader.done) break;
      }
    }
  } catch (e) {
    // An abort (Stop, or the engine's first-byte / idle timer) after a finish_reason loses nothing:
    // the finish already went out with the chunk that carried it, so the engine keeps the answer.
    if (signal.aborted) throw signal.reason;
    // The body broke off. After a finish_reason the answer is complete: the usage that arrived is
    // delivered, and the break follows as an error the engine records as a tail failure.
    if (reader.finished) {
      for (const ev of reader.end()) yield ev;
    }
    const pe = e instanceof ProviderError ? e : undefined;
    const why = pe ? pe.message : 'the response body broke off';
    const detail = pe ? pe.detail : errorText(e);
    const err = providerError(pe?.code === 'timeout' ? 'timeout' : 'truncated_stream', why, {
      afterOutput: reader.output,
      ...(detail !== undefined ? { detail } : {}),
    });
    yield { t: 'error', err, afterOutput: reader.output };
    return;
  }
  for (const ev of reader.end()) {
    signal.throwIfAborted();
    yield ev;
  }
}

export function createOpenAIChatProvider(o: OpenAIChatOptions): Provider {
  // A snapshot of the options; nothing else is kept between calls (§8.1: no module or provider state).
  const opts: OpenAIChatOptions = { ...o };
  return {
    stream(req: ModelRequest, env: ProviderEnv): AsyncIterable<StreamEv> {
      return streamChat(req, env, opts);
    },
    // M2 /preview --wire: the request as stream() would send it, built with no key and returned
    // without headers, so neither the key nor a header value can leak into a preview. Throws what
    // buildChatRequest throws (tool_protocol_invalid, a bad base URL).
    wire(req: ModelRequest): { url: string; body: unknown } {
      const http = buildChatRequest(req, opts, null);
      return { url: http.url, body: JSON.parse(http.body ?? 'null') as unknown };
    },
  };
}
