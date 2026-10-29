// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
// Native Gemini generateContent adapter. Signed parts stay in memory for one tool loop.
import { ProviderError, PROVIDER_ERROR_CATEGORY, providerMessage } from './types.ts';
import type { ModelRequest, PromptMsg, Provider, ProviderEnv, ProviderErrorCode, StreamEv, Usage } from './types.ts';
import { applyOverrides, validateToolProtocol, type ConnectionOverrides } from './wire.ts';
import { bodyBytes, classifyHttpFailure, guardedFetch, originOf, type HttpRequest } from './http.ts';
import { sseEvents } from './sse.ts';
import { systemClock } from '../engine/system.ts';

type Rec = Record<string, unknown>;
const rec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => typeof x === 'string' ? x : '';
function failure(code: ProviderErrorCode, detail?: string, afterOutput = false): ProviderError {
  return new ProviderError({ code, category: PROVIDER_ERROR_CATEGORY[code], message: providerMessage(code), afterOutput, ...(detail ? { detail } : {}) });
}

export interface GeminiOptions {
  connectionId: string;
  baseUrl: string;
  local: boolean;
  overrides?: ConnectionOverrides;
}

/** Accept a bare origin or a pasted /v1beta base; the key never enters the URL. */
export function streamUrl(baseUrl: string, model: string): string {
  const u = new URL(baseUrl.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError('not an http(s) URL');
  const base = u.pathname.replace(/\/+$/, '').replace(/\/(?:v1|v1beta)(?:\/models)?$/i, '');
  const id = model.replace(/^models\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw failure('bad_request');
  u.pathname = `${base}/v1beta/models/${encodeURIComponent(id)}:streamGenerateContent`;
  u.search = 'alt=sse';
  u.hash = '';
  return u.href;
}

const SCHEMA_KEYS = new Set(['$id', '$defs', '$ref', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering']);
/** Keep the JSON Schema subset accepted by Gemini. Nullable becomes an explicit null branch. */
export function sanitizeSchema(value: unknown, rootObject = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeSchema(item));
  if (!rec(value)) return value;
  const out: Rec = {};
  for (const [key, child] of Object.entries(value)) if (SCHEMA_KEYS.has(key)) {
    if (key === 'properties' || key === '$defs') {
      if (rec(child)) out[key] = Object.fromEntries(Object.entries(child).map(([name, v]) => [name, sanitizeSchema(v)]));
    } else out[key] = sanitizeSchema(child);
  }
  if (typeof out.$ref === 'string') {
    for (const key of Object.keys(out)) if (!key.startsWith('$')) delete out[key];
  }
  if (value.nullable === true && !rootObject && typeof out.type === 'string' && out.type !== 'null') {
    const base = { ...out };
    return { anyOf: [base, { type: 'null' }] };
  }
  return out;
}

function text(m: PromptMsg): string {
  return m.blocks.filter((b) => b.k === 'text').map((b) => b.text).filter(Boolean).join('\n\n');
}
function replayParts(m: PromptMsg, req: ModelRequest): Rec[] | undefined {
  if (m.role !== 'assistant') return;
  for (const r of m.replay ?? []) if (r.kind === 'gemini-parts' && r.connection === req.model.connection && r.model === req.model.model && Array.isArray(r.payload)) {
    const parts = r.payload.filter(rec);
    if (parts.length) return parts.map((p) => ({ ...p }));
  }
}
function parts(m: PromptMsg, req: ModelRequest): Rec[] {
  const replay = replayParts(m, req);
  if (replay) return replay;
  const out: Rec[] = [];
  for (const b of m.blocks) {
    if (b.k === 'text' && b.text) out.push({ text: b.text });
    if (b.k === 'tool_call') {
      let args: unknown;
      try { args = b.args.trim() ? JSON.parse(b.args) : {}; } catch { throw failure('tool_protocol_invalid'); }
      out.push({ functionCall: { id: b.id, name: b.name, args } });
    }
    if (b.k === 'tool_result') out.push({ functionResponse: { ...(b.callId.startsWith('g_missing_') ? {} : { id: b.callId }), name: b.name, response: b.error ? { error: b.text } : { result: b.text } } });
  }
  return out;
}

const SAFETY_CATEGORIES = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'] as const;
export function buildGeminiRequest(req: ModelRequest, o: GeminiOptions, key: string | null): HttpRequest {
  if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0) throw failure('bad_request');
  const valid = validateToolProtocol(req.messages);
  if (!valid.ok) throw failure('tool_protocol_invalid', valid.why);
  const url = streamUrl(o.baseUrl, req.model.model);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['x-goog-api-key'] = key;
  let i = 0;
  const systemParts: Rec[] = [];
  while (i < req.messages.length && req.messages[i]!.role === 'system') {
    const t = text(req.messages[i++]!);
    if (t) systemParts.push({ text: t });
  }
  const contents: { role: 'user' | 'model'; parts: Rec[]; signed: boolean }[] = [];
  for (; i < req.messages.length; i++) {
    const m = req.messages[i]!;
    const p = m.role === 'system' ? [{ text: `[System note]\n${text(m)}` }] : parts(m, req);
    if (!p.length) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const signed = p.some((part) => 'thoughtSignature' in part);
    const prev = contents.at(-1);
    if (prev && prev.role === role && !prev.signed && !signed) prev.parts.push(...p);
    else contents.push({ role, parts: p, signed });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: ' ' }], signed: false });
  // Gemini expects all function calls before all responses, even for parallel calls.
  const body: Rec = {
    contents: contents.map(({ role, parts }) => ({ role, parts })),
    safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'OFF' })),
  };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  const generationConfig: Rec = { maxOutputTokens: req.maxTokens };
  if (req.stop?.length) generationConfig.stopSequences = req.stop.slice(0, Math.min(5, req.caps.stopMax ?? 5));
  for (const [from, to] of [['temperature', 'temperature'], ['top_p', 'topP'], ['top_k', 'topK'], ['seed', 'seed']] as const) {
    if (req.caps.samplers.accepted.includes(from) && req.samplers[from] !== undefined) generationConfig[to] = req.samplers[from];
  }
  if (req.responseSchema && req.caps.structuredOutput.mode === 'json_schema') {
    generationConfig.responseFormat = { text: { mimeType: 'APPLICATION_JSON', schema: sanitizeSchema(req.responseSchema.schema) } };
  }
  const thinking: Rec = {};
  if (req.caps.reasoning.control === 'level') {
    const allowed = req.caps.reasoning.efforts ?? ['low', 'medium', 'high'];
    const effort = req.reasoning === 'none' ? (allowed.includes('minimal') ? 'minimal' : undefined) : req.reasoning;
    if (effort && effort !== 'auto' && allowed.includes(effort)) thinking.thinkingLevel = effort.toUpperCase();
  } else if (req.caps.reasoning.control === 'budget') {
    if (req.reasoning === 'none' && req.caps.reasoning.canDisable) thinking.thinkingBudget = 0;
    else if (req.reasoning && req.reasoning !== 'auto' && req.reasoning !== 'none') {
      const target = req.reasoning === 'low' ? 1024 : req.reasoning === 'medium' ? 8192 : 24576;
      thinking.thinkingBudget = Math.min(target, Math.max(512, req.maxTokens - 512));
    }
  }
  if (req.caps.reasoning.output === 'gemini-parts' && req.caps.reasoning.control !== 'none') thinking.includeThoughts = true;
  if (Object.keys(thinking).length) generationConfig.thinkingConfig = thinking;
  body.generationConfig = generationConfig;
  if (req.tools?.length && req.caps.tools === 'native' && req.toolChoice !== 'none') {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: sanitizeSchema(t.schema, true) })) }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  const patched = applyOverrides(body, headers, o.overrides);
  return { url, method: 'POST', headers: patched.headers, body: JSON.stringify(patched.body) };
}

function tokenUsage(x: unknown): Usage | undefined {
  if (!rec(x)) return;
  const u: Usage = {};
  if (typeof x.promptTokenCount === 'number') u.inputTotal = x.promptTokenCount;
  if (typeof x.cachedContentTokenCount === 'number') u.inputCacheRead = x.cachedContentTokenCount;
  if (typeof x.thoughtsTokenCount === 'number') u.outputReasoning = x.thoughtsTokenCount;
  if (typeof x.candidatesTokenCount === 'number') u.outputTotal = x.candidatesTokenCount + (u.outputReasoning ?? 0);
  return Object.keys(u).length ? u : undefined;
}
function finishReason(raw: string): 'end' | 'length' | 'content_filter' {
  if (raw === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'].includes(raw)) return 'content_filter';
  return 'end';
}
function isSignatureError(detail: string): boolean {
  return /(?:missing|invalid).*(?:thought.?signature|signature)|(?:thought.?signature|signature).*(?:missing|invalid)/i.test(detail);
}

async function* stream(req: ModelRequest, env: ProviderEnv, o: GeminiOptions): AsyncGenerator<StreamEv> {
  let http: HttpRequest;
  try { http = buildGeminiRequest(req, o, env.key); }
  catch (e) { const err = e instanceof ProviderError ? e : failure('bad_request'); yield { t: 'error', err, afterOutput: false }; return; }
  let res: Response;
  try { res = await guardedFetch(http, { fetch: env.fetch, signal: req.signal, allowedOrigin: originOf(o.baseUrl) }); }
  catch (e) { if (req.signal.aborted) throw req.signal.reason; const err = e instanceof ProviderError ? e : failure('unreachable', String(e)); yield { t: 'error', err, afterOutput: false }; return; }
  if (!res.ok) {
    let err = await classifyHttpFailure(res, { now: systemClock() });
    if (res.status >= 400 && res.status < 500 && isSignatureError(err.detail ?? '')) err = new ProviderError({ code: 'thinking_signature_mismatch', category: 'protocol', message: providerMessage('thinking_signature_mismatch', res.status), status: res.status, detail: err.detail });
    yield { t: 'error', err, afterOutput: false }; return;
  }
  const replay: Rec[] = [];
  const seenCalls = new Set<string>();
  let toolIndex = 0;
  let textIndex = 0;
  let output = false;
  let served = req.model.model;
  let lastUsage: Usage | undefined;
  let rawFinish: string | undefined;
  let blockedPrompt = false;
  let sawPayload = false;
  try {
    const bytes = (async function* () { for await (const b of bodyBytes(res, req.signal)) { env.onActivity?.(); yield b; } })();
    for await (const s of sseEvents(bytes)) {
      let packet: unknown;
      try { packet = JSON.parse(s.data); } catch { continue; }
      if (!rec(packet)) continue;
      sawPayload = true;
      if (s.event === 'error' && !rec(packet.error)) throw failure('unreachable', JSON.stringify(packet), output);
      if (rec(packet.error)) {
        const detail = str(packet.error.message);
        throw failure(isSignatureError(detail) ? 'thinking_signature_mismatch' : 'bad_request', detail, output);
      }
      const feedback = rec(packet.promptFeedback) ? packet.promptFeedback : undefined;
      if (feedback && str(feedback.blockReason) && feedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') { rawFinish = str(feedback.blockReason); blockedPrompt = true; }
      if (str(packet.modelVersion)) served = str(packet.modelVersion);
      lastUsage = tokenUsage(packet.usageMetadata) ?? lastUsage;
      const candidates = Array.isArray(packet.candidates) ? packet.candidates : [];
      const candidate = candidates.find(rec);
      if (!rec(candidate)) continue;
      if (str(candidate.finishReason)) rawFinish = str(candidate.finishReason);
      const content = rec(candidate.content) ? candidate.content : {};
      const items = Array.isArray(content.parts) ? content.parts : [];
      for (const item of items) {
        if (!rec(item)) continue;
        const part = { ...item };
        replay.push(part); // Includes empty signed text parts, in the provider's original order.
        const n = textIndex++;
        if (str(part.text)) {
          output = true;
          yield part.thought === true ? { t: 'reasoning', i: n, d: str(part.text) } : { t: 'text', i: n, d: str(part.text) };
          if (part.thought === true) yield { t: 'reasoning_end', i: n };
        }
        if (rec(part.functionCall)) {
          const call = part.functionCall;
          const name = str(call.name);
          const id = str(call.id) || `g_missing_${toolIndex}`;
          const key = `${id}\u0000${name}`;
          if (!seenCalls.has(key) && name) {
            seenCalls.add(key);
            output = true;
            const index = toolIndex++;
            yield { t: 'tool_start', i: index, id, name };
            yield { t: 'tool_args', i: index, d: JSON.stringify(rec(call.args) ? call.args : {}) };
            yield { t: 'tool_end', i: index };
          }
        }
      }
    }
  } catch (e) {
    if (req.signal.aborted) throw req.signal.reason;
    const err = e instanceof ProviderError ? e : failure('truncated_stream', String(e), output);
    yield { t: 'error', err, afterOutput: output }; return;
  }
  if (!sawPayload || !rawFinish) {
    const err = failure('truncated_stream', undefined, output);
    yield { t: 'error', err, afterOutput: output }; return;
  }
  if (rawFinish === 'MALFORMED_FUNCTION_CALL' || rawFinish === 'MISSING_THOUGHT_SIGNATURE') {
    const err = failure(rawFinish === 'MISSING_THOUGHT_SIGNATURE' ? 'thinking_signature_mismatch' : 'tool_protocol_invalid', undefined, output);
    yield { t: 'error', err, afterOutput: output }; return;
  }
  if (lastUsage) yield { t: 'usage', u: lastUsage };
  if (replay.length) yield { t: 'replay', r: { kind: 'gemini-parts', connection: req.model.connection, model: req.model.model, payload: replay } };
  yield { t: 'finish', reason: blockedPrompt ? 'content_filter' : finishReason(rawFinish), raw: rawFinish, model: served };
}

export function createGeminiProvider(o: GeminiOptions): Provider {
  return {
    stream: (req, env) => stream(req, env, o),
    wire(req) { const h = buildGeminiRequest(req, o, null); return { url: h.url, body: JSON.parse(h.body ?? 'null') }; },
  };
}
