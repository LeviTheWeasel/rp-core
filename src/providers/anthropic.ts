// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
// Native Anthropic Messages adapter. Requests and stream state are per call.
import { ProviderError, PROVIDER_ERROR_CATEGORY, providerMessage } from './types.ts';
import type { ModelRequest, PromptMsg, Provider, ProviderEnv, ProviderErrorCode, StreamEv, Usage } from './types.ts';
import { applyOverrides, normalizeFinish, validateToolProtocol, type ConnectionOverrides } from './wire.ts';
import { bodyBytes, classifyHttpFailure, guardedFetch, originOf, type HttpRequest } from './http.ts';
import { sseEvents } from './sse.ts';
import { estimateTokens } from '../prompt/tokens.ts';
import { systemClock } from '../engine/system.ts';

type Rec = Record<string, unknown>;
const rec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => typeof x === 'string' ? x : '';
function error(code: ProviderErrorCode, detail?: string, afterOutput = false): ProviderError {
  return new ProviderError({ code, category: PROVIDER_ERROR_CATEGORY[code], message: providerMessage(code), afterOutput, ...(detail ? { detail } : {}) });
}
export interface AnthropicOptions {
  connectionId: string;
  baseUrl: string;
  local: boolean;
  apiVersion?: string;
  cacheTtl?: '5m' | '1h';
  overrides?: ConnectionOverrides;
}
export function messagesUrl(baseUrl: string): string {
  const u = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new TypeError('not an http(s) URL');
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/messages)?$/i, '') + '/v1/messages';
  u.hash = '';
  return u.href;
}
function text(m: PromptMsg): string {
  return m.blocks.filter((b) => b.k === 'text').map((b) => b.text).filter(Boolean).join('\n\n');
}
function note(s: string): string { return `[System note]\n${s}`; }
function content(m: PromptMsg, req: ModelRequest): Rec[] {
  const out: Rec[] = [];
  if (m.role === 'assistant') {
    // Signed blocks exist only on the wire message of this tool loop and this exact model.
    for (const r of m.replay ?? []) if (!(req.reasoning === 'none' && req.caps.reasoning.canDisable) && r.kind === 'anthropic-blocks' && r.connection === req.model.connection && r.model === req.model.model && Array.isArray(r.payload)) {
      for (const b of r.payload) if (rec(b) && (b.type === 'thinking' || b.type === 'redacted_thinking')) out.push({ ...b });
    }
  }
  for (const b of m.blocks) {
    if (b.k === 'text' && b.text) out.push({ type: 'text', text: b.text });
    if (b.k === 'tool_call') {
      let input: unknown;
      try { input = b.args.trim() ? JSON.parse(b.args) : {}; } catch { throw error('tool_protocol_invalid'); }
      out.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
    if (b.k === 'tool_result') out.push({ type: 'tool_result', tool_use_id: b.callId, content: b.text });
  }
  return out;
}
export function buildAnthropicRequest(req: ModelRequest, o: AnthropicOptions, key: string | null, continuation: Rec[][] = []): HttpRequest {
  if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0) throw error('bad_request');
  const valid = validateToolProtocol(req.messages);
  if (!valid.ok) throw error('tool_protocol_invalid', valid.why);
  const url = messagesUrl(o.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': o.apiVersion ?? '2023-06-01' };
  if (key) headers['x-api-key'] = key;
  const leading: Rec[] = [];
  const msgs: { role: 'user' | 'assistant' | 'system'; content: Rec[] }[] = [];
  let i = 0;
  for (; i < req.messages.length && req.messages[i]!.role === 'system'; i++) {
    const t = text(req.messages[i]!);
    if (t) leading.push({ type: 'text', text: t });
  }
  for (; i < req.messages.length; i++) {
    const m = req.messages[i]!;
    if (m.role === 'system') {
      let t = text(m);
      while (i + 1 < req.messages.length && req.messages[i + 1]!.role === 'system') t += '\n\n' + text(req.messages[++i]!);
      if (!t) continue;
      const prev = msgs.at(-1);
      const next = req.messages[i + 1];
      if (req.caps.midSystem === 'anthropic-native' && prev?.role === 'user' && (!next || next.role === 'assistant')) {
        msgs.push({ role: 'system', content: [{ type: 'text', text: t }] });
      } else if (next?.role === 'user' || next?.role === 'tool') {
        // Attach to the nearest following user turn. A pending note is consumed there.
        const parts: Rec[] = [{ type: 'text', text: note(t) }, ...content(next, req)];
        msgs.push({ role: 'user', content: parts });
        i++;
      } else if (prev?.role === 'user') prev.content.push({ type: 'text', text: note(t) });
      else if (prev) msgs.push({ role: 'user', content: [{ type: 'text', text: note(t) }] });
      else msgs.push({ role: 'user', content: [{ type: 'text', text: note(t) }] });
      continue;
    }
    const parts = content(m, req);
    if (parts.length) msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: parts });
  }
  const merged: typeof msgs = [];
  for (const m of msgs) {
    const prev = merged.at(-1);
    if (prev && prev.role === m.role && m.role !== 'system') prev.content.push(...m.content);
    else merged.push(m);
  }
  if (!merged.length || merged[0]!.role !== 'user') merged.unshift({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  for (const parts of continuation) merged.push({ role: 'assistant', content: parts });
  if (req.prefill && req.caps.prefill === 'assistant-last' && !(req.tools?.length)) merged.push({ role: 'assistant', content: [{ type: 'text', text: req.prefill }] });
  const body: Rec = { model: req.model.model, max_tokens: req.maxTokens, stream: true, messages: merged };
  if (leading.length) body.system = leading;
  if (req.tools?.length && req.caps.tools === 'native' && req.toolChoice !== 'none') {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    body.tool_choice = { type: 'auto' };
  }
  if (req.responseSchema && req.caps.structuredOutput.mode === 'json_schema') {
    body.output_config = { format: { type: 'json_schema', schema: req.responseSchema.schema } };
  }
  if (req.reasoning !== 'none' && req.caps.reasoning.control === 'adaptive') {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    if (req.reasoning && req.reasoning !== 'auto') body.output_config = { ...(body.output_config as Rec | undefined), effort: req.reasoning };
  } else if (req.reasoning !== 'none' && req.caps.reasoning.control === 'budget') {
    const budget = Math.min(Math.floor(req.maxTokens / 2), req.reasoning === 'high' ? 8192 : req.reasoning === 'low' ? 1024 : 4096);
    if (budget >= 1024 && req.maxTokens > budget) body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  if (!body.thinking && req.reasoning === 'none' && req.caps.reasoning.canDisable) body.thinking = { type: 'disabled' };
  const fixedSamplers = req.caps.samplers.fixed || (o.apiVersion !== undefined && o.apiVersion >= '2026-10-21');
  if (!fixedSamplers && !body.thinking) {
    for (const name of ['temperature', 'top_p', 'top_k'] as const) {
      if (name === 'top_p' && body.temperature !== undefined) continue;
      if (req.caps.samplers.accepted.includes(name) && req.samplers[name] !== undefined) body[name] = req.samplers[name];
    }
  }
  if (!fixedSamplers && req.stop?.length) body.stop_sequences = req.stop.slice(0, req.caps.stopMax ?? req.stop.length);
  if (req.caps.caching === 'anthropic-breakpoints') {
    const ttl = o.cacheTtl ?? '1h';
    const mark = (b: Rec) => { b.cache_control = { type: 'ephemeral', ttl }; };
    const min = req.caps.cacheMinTokens ?? 1024;
    const sys = body.system as Rec[] | undefined;
    if (sys?.length && estimateTokens(sys.map((b) => str(b.text)).join('\n')) >= min) mark(sys.at(-1)!);
    const hist = merged;
    const count = (n: number) => estimateTokens(JSON.stringify({ system: sys, messages: hist.slice(0, n + 1) }));
    for (const n of [hist.length - 2, hist.length - 1]) if (n >= 0 && count(n) >= min) {
      const b = hist[n]!.content.at(-1);
      if (b) mark(b);
    }
  }
  const patched = applyOverrides(body, headers, o.overrides);
  return { url, method: 'POST', headers: patched.headers, body: JSON.stringify(patched.body) };
}
function usage(x: unknown): Usage | undefined {
  if (!rec(x)) return;
  const u: Usage = {};
  const input = typeof x.input_tokens === 'number' ? x.input_tokens : undefined;
  const read = typeof x.cache_read_input_tokens === 'number' ? x.cache_read_input_tokens : undefined;
  const write = typeof x.cache_creation_input_tokens === 'number' ? x.cache_creation_input_tokens : undefined;
  if (input !== undefined) u.inputTotal = input + (read ?? 0) + (write ?? 0);
  if (typeof x.output_tokens === 'number') u.outputTotal = x.output_tokens;
  if (read !== undefined) u.inputCacheRead = read;
  if (write !== undefined) u.inputCacheWrite = write;
  const cc = x.cache_creation;
  if (rec(cc) && typeof cc.ephemeral_1h_input_tokens === 'number') u.inputCacheWrite1h = cc.ephemeral_1h_input_tokens;
  return Object.keys(u).length ? u : undefined;
}
async function* streamOnce(req: ModelRequest, env: ProviderEnv, o: AnthropicOptions, continuation: Rec[][], onPause: (blocks: Rec[]) => void): AsyncGenerator<StreamEv> {
  let http: HttpRequest;
  try { http = buildAnthropicRequest(req, o, env.key, continuation); }
  catch (e) { const err = e instanceof ProviderError ? e : error('bad_request'); yield { t: 'error', err, afterOutput: false }; return; }
  let res: Response;
  try { res = await guardedFetch(http, { fetch: env.fetch, signal: req.signal, allowedOrigin: originOf(o.baseUrl) }); }
  catch (e) { if (req.signal.aborted) throw req.signal.reason; const err = e instanceof ProviderError ? e : error('unreachable', String(e)); yield { t: 'error', err, afterOutput: false }; return; }
  if (!res.ok) {
    let err = await classifyHttpFailure(res, { now: systemClock() });
    if (res.status === 400 && /(?:thinking|signature).*(?:signature|invalid)|invalid.*signature/i.test(err.detail ?? '')) {
      err = new ProviderError({ code: 'thinking_signature_mismatch', category: 'protocol', message: providerMessage('thinking_signature_mismatch', res.status), status: res.status, detail: err.detail });
    }
    yield { t: 'error', err, afterOutput: false }; return;
  }
  const blocks = new Map<number, Rec>();
  let served = req.model.model;
  let finish: string | undefined;
  let stopped = false;
  let output = false;
  let lastUsage: Usage | undefined;
  try {
    const bytes = (async function* () { for await (const b of bodyBytes(res, req.signal)) { env.onActivity?.(); yield b; } })();
    for await (const s of sseEvents(bytes)) {
      let ev: Rec;
      try { ev = JSON.parse(s.data); } catch { continue; }
      if (!rec(ev)) continue;
      const type = str(ev.type) || s.event;
      const n = typeof ev.index === 'number' ? ev.index : 0;
      const delta = rec(ev.delta) ? ev.delta : {};
      if (type === 'message_start') {
        const m = rec(ev.message) ? ev.message : {};
        served = str(m.model) || served;
        lastUsage = usage(m.usage) ?? lastUsage;
      } else if (type === 'content_block_start') {
        const b = rec(ev.content_block) ? { ...ev.content_block } : {};
        blocks.set(n, b);
        if (b.type === 'tool_use') { output = true; yield { t: 'tool_start', i: n, id: str(b.id), name: str(b.name) }; }
        if (b.type === 'text' && str(b.text)) { output = true; yield { t: 'text', i: n, d: str(b.text) }; }
      } else if (type === 'content_block_delta') {
        const b = blocks.get(n);
        if (delta.type === 'text_delta' && str(delta.text)) { output = true; if (b) b.text = str(b.text) + str(delta.text); yield { t: 'text', i: n, d: str(delta.text) }; }
        if (delta.type === 'thinking_delta' && str(delta.thinking)) { output = true; if (b) b.thinking = str(b.thinking) + str(delta.thinking); yield { t: 'reasoning', i: n, d: str(delta.thinking) }; }
        if (delta.type === 'signature_delta' && b) b.signature = str(b.signature) + str(delta.signature);
        if (delta.type === 'input_json_delta' && str(delta.partial_json)) { output = true; if (b) b._args = str(b._args) + str(delta.partial_json); yield { t: 'tool_args', i: n, d: str(delta.partial_json) }; }
      } else if (type === 'content_block_stop') {
        const b = blocks.get(n);
        if (b?.type === 'thinking') yield { t: 'reasoning_end', i: n, ...(str(b.signature) ? { signature: str(b.signature) } : {}) };
        if (b?.type === 'redacted_thinking') yield { t: 'reasoning_end', i: n, redacted: true };
        if (b?.type === 'tool_use') yield { t: 'tool_end', i: n };
      } else if (type === 'message_delta') {
        if (typeof delta.stop_reason === 'string') finish = delta.stop_reason;
        lastUsage = { ...lastUsage, ...usage(ev.usage) };
      } else if (type === 'message_stop') { stopped = true; break; }
      else if (type === 'error') { const e = rec(ev.error) ? ev.error : {}; throw error(e.type === 'overloaded_error' ? 'overloaded' : 'bad_request', str(e.message), output); }
    }
  } catch (e) {
    if (req.signal.aborted) throw req.signal.reason;
    const err = e instanceof ProviderError ? e : error('truncated_stream', String(e), output);
    yield { t: 'error', err, afterOutput: output }; return;
  }
  if (!stopped || !finish) { const err = error('truncated_stream', undefined, output); yield { t: 'error', err, afterOutput: output }; return; }
  if (finish === 'pause_turn') {
    const parts = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => {
      const { _args, ...raw } = b;
      if (b.type === 'tool_use' && str(_args)) {
        try { raw.input = JSON.parse(str(_args)); } catch { /* retain the original input */ }
      }
      return raw;
    });
    onPause(parts);
  }
  if (lastUsage) yield { t: 'usage', u: lastUsage };
  const thinking = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').map((b) => b.type === 'thinking' ? { type: 'thinking', thinking: str(b.thinking), signature: str(b.signature) } : { type: 'redacted_thinking', data: str(b.data) });
  if (thinking.length) yield { t: 'replay', r: { kind: 'anthropic-blocks', connection: req.model.connection, model: req.model.model, payload: thinking } };
  yield { t: 'finish', reason: normalizeFinish(finish), raw: finish, model: served };
}
async function* stream(req: ModelRequest, env: ProviderEnv, o: AnthropicOptions): AsyncGenerator<StreamEv> {
  const continuation: Rec[][] = [];
  let offset = 0;
  let totals: Usage = {};
  const signed: Rec[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let paused: Rec[] | undefined;
    let maxIndex = -1;
    for await (const ev of streamOnce(req, env, o, continuation, (b) => { paused = b; })) {
      if ('i' in ev) { maxIndex = Math.max(maxIndex, ev.i); yield { ...ev, i: ev.i + offset } as StreamEv; }
      else if (ev.t === 'usage') {
        for (const [key, value] of Object.entries(ev.u)) if (typeof value === 'number') (totals as Record<string, number>)[key] = ((totals as Record<string, number>)[key] ?? 0) + value;
        yield { t: 'usage', u: totals };
      } else if (ev.t === 'replay') {
        if (Array.isArray(ev.r.payload)) signed.push(...ev.r.payload.filter(rec));
      } else if (ev.t === 'finish' && ev.raw === 'pause_turn') {
        if (attempt === 2 || !paused?.length) { yield { t: 'finish', reason: 'length', raw: 'pause_turn', model: ev.model }; return; }
      } else if (ev.t === 'finish') {
        if (signed.length) yield { t: 'replay', r: { kind: 'anthropic-blocks', connection: req.model.connection, model: req.model.model, payload: signed } };
        yield ev;
      } else yield ev;
    }
    if (!paused?.length) return;
    continuation.push(paused);
    offset += maxIndex + 1;
  }
}
export function createAnthropicProvider(o: AnthropicOptions): Provider {
  return { stream: (req, env) => stream(req, env, o), wire(req) { const h = buildAnthropicRequest(req, o, null); return { url: h.url, body: JSON.parse(h.body ?? 'null') }; } };
}
