import { describe, expect, test } from 'bun:test';
import { buildAnthropicRequest, createAnthropicProvider } from '../../src/providers/anthropic.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import { listModels } from '../../src/providers/probe.ts';
import { fetchCatalog } from '../../src/providers/probe.ts';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import type { ModelRequest, PromptMsg, StreamEv } from '../../src/providers/types.ts';
import { blocks, msg, request } from './kit.ts';

const base = 'https://api.anthropic.com';
const caps = (model: string) => resolveCaps({ dialect: 'anthropic', origin: base, local: false, model });
const opts = { connectionId: 'claude', baseUrl: base, local: false };
function req(model = 'claude-sonnet-5-5', over: Partial<ModelRequest> = {}): ModelRequest {
  return request({ model: { connection: 'claude', model }, caps: caps(model), maxTokens: 4096, ...over });
}
function body(r: ModelRequest): any { return JSON.parse(buildAnthropicRequest(r, opts, null).body!); }

describe('Anthropic wire', () => {
  test('system placement, model capabilities and samplers', () => {
    const r = req('claude-sonnet-5-5', { messages: [msg('system', 'lead'), msg('user', 'a'), msg('system', 'native'), msg('assistant', 'b'), msg('system', 'inline'), msg('user', 'c')], samplers: { temperature: 0.4, top_p: 0.7 }, stop: ['END'], reasoning: 'high' });
    const b = body(r);
    expect(b.system[0].text).toBe('lead');
    expect(b.messages.map((m: any) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(b.messages[1].content[0].text).toBe('native');
    expect(b.messages[3].content[0].text).toContain('[System note]');
    expect(b.thinking.type).toBe('adaptive');
    expect(b.output_config.effort).toBe('high');
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
    expect(b.stop_sequences).toBeUndefined();
    expect(body(req('claude-sonnet-5', { messages: r.messages })).messages[0].content[1].text).toContain('[System note]');
  });
  test('tools, signed replay, cache breakpoints and structured output', () => {
    const prior: PromptMsg = blocks('assistant', { k: 'tool_call', id: 't1', name: 'lookup', args: '{"q":"x"}' });
    prior.replay = [{ kind: 'anthropic-blocks', connection: 'claude', model: 'claude-sonnet-5-5', payload: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'redacted_thinking', data: 'opaque' }] }];
    const r = req('claude-sonnet-5-5', { messages: [msg('system', 'S'.repeat(6000)), msg('user', 'lookup'), prior, blocks('tool', { k: 'tool_result', callId: 't1', name: 'lookup', text: 'result' })], tools: [{ name: 'lookup', description: 'Lookup', schema: { type: 'object' } }], responseSchema: { name: 'Answer', schema: { type: 'object' } } });
    const b = body(r);
    expect(b.messages[1].content.map((x: any) => x.type)).toEqual(['thinking', 'redacted_thinking', 'tool_use']);
    expect(b.messages[2].content[0].tool_use_id).toBe('t1');
    expect(b.output_config.format.type).toBe('json_schema');
    expect(b.system[0].cache_control.ttl).toBe('1h');
    expect(b.messages[2].content.at(-1).cache_control.ttl).toBe('1h');
    const other = req('claude-sonnet-5-5', { ...r, model: { connection: 'claude', model: 'claude-sonnet-5-5' }, messages: [msg('user', 'lookup'), { ...prior, replay: [{ ...prior.replay![0]!, model: 'other' }] }, r.messages[3]!] });
    expect(body(other).messages[1].content[0].type).toBe('tool_use');
  });
  test('a pinned newer API version omits all samplers even on an older model', () => {
    const r = req('claude-sonnet-4-5', { samplers: { temperature: 0.5, top_p: 0.8 }, stop: ['END'], reasoning: 'none' });
    expect(r.caps.reasoning.control).toBe('budget');
    expect(r.caps.prefill).toBe('assistant-last');
    const h = buildAnthropicRequest(r, { ...opts, apiVersion: '2026-10-21' }, null);
    const b = JSON.parse(h.body!);
    expect(h.headers['anthropic-version']).toBe('2026-10-21');
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
    expect(b.stop_sequences).toBeUndefined();
  });
});

const event = (x: unknown) => `event: ${(x as any).type}\ndata: ${JSON.stringify(x)}\n\n`;
function fake(events: unknown[]): typeof fetch { return (async () => new Response(events.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch; }
async function collect(it: AsyncIterable<StreamEv>) { const out: StreamEv[] = []; for await (const e of it) out.push(e); return out; }

test('stream emits text, tools, usage and signed thinking, including empty thinking', async () => {
  const events = [
    { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' },
  ];
  const out = await collect(createAnthropicProvider(opts).stream(req(), { fetch: fake(events), key: 'secret' }));
  expect(out.find((e) => e.t === 'tool_start')).toEqual({ t: 'tool_start', i: 1, id: 't1', name: 'lookup' });
  expect(out.find((e) => e.t === 'tool_args')).toEqual({ t: 'tool_args', i: 1, d: '{"q":"x"}' });
  expect(out.find((e) => e.t === 'usage')).toEqual({ t: 'usage', u: { inputTotal: 14, inputCacheRead: 4, outputTotal: 6 } });
  expect(out.find((e) => e.t === 'replay')).toMatchObject({ r: { payload: [{ type: 'thinking', thinking: '', signature: 'signed' }] } });
  expect(out.at(-1)).toEqual({ t: 'finish', reason: 'end', raw: 'tool_use', model: 'claude-sonnet-5-5' });
});

test('pause_turn resends the partial assistant content and returns one terminal finish', async () => {
  const seen: any[] = [];
  const responses = [
    [
      { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ],
    [
      { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' second' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ],
  ];
  const fetcher = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(init.body as string));
    return new Response(responses.shift()!.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const out = await collect(createAnthropicProvider(opts).stream(req(), { fetch: fetcher, key: 'secret' }));
  expect(seen).toHaveLength(2);
  expect(seen[1].messages.at(-1).content[0].text).toBe('first');
  expect(out.filter((e) => e.t === 'finish')).toEqual([{ t: 'finish', reason: 'end', raw: 'end_turn', model: 'claude-sonnet-5-5' }]);
  expect(out.filter((e) => e.t === 'text').map((e: any) => e.d).join('')).toBe('first second');
  expect(out.filter((e) => e.t === 'usage').at(-1)).toEqual({ t: 'usage', u: { inputTotal: 8, outputTotal: 5 } });
});

test('native model list uses x-api-key and Anthropic version', async () => {
  let seen: { url: string; headers: Headers } | undefined;
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url, headers: new Headers(init.headers) };
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }] }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const found = await listModels(base, { fetch: fetcher, key: 'secret', signal: new AbortController().signal, dialect: 'anthropic' });
  expect(found.models).toEqual([{ id: 'claude-sonnet-5-5' }]);
  expect(seen!.url).toBe('https://api.anthropic.com/v1/models');
  expect(seen!.headers.get('x-api-key')).toBe('secret');
  expect(seen!.headers.get('authorization')).toBeNull();
  const catalog = await fetchCatalog(base, { fetch: fetcher, key: 'secret', signal: new AbortController().signal, dialect: 'anthropic' });
  expect(catalog.server).toBe('anthropic');
  expect(catalog.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
});

test('config builds a usable native provider with lazy key resolution', async () => {
  const cfg = parseConfig('[connections.claude]\ndialect = "anthropic"\nkey_env = "ANTHROPIC_API_KEY"\n', null);
  const connections = buildConnections(cfg, { env: { ANTHROPIC_API_KEY: 'secret' }, secrets: createSecretResolver({ env: { ANTHROPIC_API_KEY: 'secret' } }), capsCache: {} }).connections;
  const conn = connections.claude!;
  expect(conn.capsFor!('claude-sonnet-5-5').reasoning.control).toBe('adaptive');
  expect(await conn.resolveKey!()).toBe('secret');
  expect(conn.provider.wire!(req()).url).toBe('https://api.anthropic.com/v1/messages');
});

test('a rejected signed thinking block has a typed, safe error', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid thinking signature secret prompt' } }), { status: 400 })) as unknown as typeof fetch;
  const out = await collect(createAnthropicProvider(opts).stream(req(), { fetch: fetcher, key: 'secret' }));
  const failure = out[0];
  expect(failure?.t).toBe('error');
  if (failure?.t === 'error') {
    expect(failure.err.code).toBe('thinking_signature_mismatch');
    expect(failure.err.message).not.toContain('secret prompt');
  }
});
