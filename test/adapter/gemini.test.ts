import { describe, expect, test } from 'bun:test';
import { buildGeminiRequest, createGeminiProvider, sanitizeSchema } from '../../src/providers/gemini.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import { listModels, fetchCatalog } from '../../src/providers/probe.ts';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import type { ModelRequest, PromptMsg, StreamEv } from '../../src/providers/types.ts';
import { blocks, msg, request } from './kit.ts';

const base = 'https://generativelanguage.googleapis.com';
const opts = { connectionId: 'gemini', baseUrl: base, local: false };
const caps = (model: string) => resolveCaps({ dialect: 'gemini', origin: base, local: false, model });
function req(model = 'gemini-3-flash', over: Partial<ModelRequest> = {}): ModelRequest {
  return request({ model: { connection: 'gemini', model }, caps: caps(model), maxTokens: 4096, ...over });
}
function body(r: ModelRequest): any { return JSON.parse(buildGeminiRequest(r, opts, null).body!); }
function event(x: unknown): string { return `data: ${JSON.stringify(x)}\n\n`; }
async function collect(it: AsyncIterable<StreamEv>): Promise<StreamEv[]> { const out: StreamEv[] = []; for await (const ev of it) out.push(ev); return out; }

describe('Gemini wire', () => {
  test('system, native endpoint, header key, safety OFF and model-specific thinking', () => {
    const r = req('gemini-3-flash', { messages: [msg('system', 'lead'), msg('user', 'hello'), msg('system', 'late'), msg('assistant', 'hi'), msg('user', 'next')], reasoning: 'low', samplers: { temperature: 0.5, top_p: 0.9 }, stop: ['END'] });
    const h = buildGeminiRequest(r, opts, 'secret');
    const b = JSON.parse(h.body!);
    expect(h.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse');
    expect(h.url).not.toContain('secret');
    expect(h.headers['x-goog-api-key']).toBe('secret');
    expect(b.systemInstruction.parts).toEqual([{ text: 'lead' }]);
    expect(b.contents[0].parts.map((p: any) => p.text)).toEqual(['hello', '[System note]\nlate']);
    expect(b.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
    expect(b.generationConfig.topP).toBe(0.9);
    expect(b.generationConfig.stopSequences).toEqual(['END']);
    expect(b.safetySettings).toHaveLength(4);
    expect(b.safetySettings.every((x: any) => x.threshold === 'OFF')).toBe(true);
    const older = body(req('gemini-2.5-flash', { reasoning: 'none' }));
    expect(older.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: true });
    const pro = body(req('gemini-2.5-pro', { reasoning: 'none' }));
    expect(pro.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
  });

  test('signed parts replay exactly, tool responses carry the real id, and schemas are sanitized', () => {
    const prior: PromptMsg = blocks('assistant', { k: 'tool_call', id: 'call-7', name: 'lookup', args: '{"q":"x"}' });
    const signed = { functionCall: { id: 'call-7', name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'opaque' };
    prior.replay = [{ kind: 'gemini-parts', connection: 'gemini', model: 'gemini-3-flash', payload: [{ text: '', thoughtSignature: 'empty' }, signed] }];
    const r = req('gemini-3-flash', { messages: [msg('user', 'lookup'), prior, blocks('tool', { k: 'tool_result', callId: 'call-7', name: 'lookup', text: 'result' })], tools: [{ name: 'lookup', description: 'Lookup', schema: { type: 'object', nullable: true, properties: { q: { type: 'string', nullable: true, minLength: 1 } } } }], responseSchema: { name: 'Answer', schema: { type: 'object', properties: { answer: { type: 'string', maxLength: 200 } } } } });
    const b = body(r);
    expect(b.contents[1].parts).toEqual([{ text: '', thoughtSignature: 'empty' }, signed]);
    expect(b.contents[2].parts[0].functionResponse).toEqual({ id: 'call-7', name: 'lookup', response: { result: 'result' } });
    expect(b.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual({ type: 'object', properties: { q: { anyOf: [{ type: 'string' }, { type: 'null' }] } } });
    expect(b.generationConfig.responseFormat.text.schema.properties.answer).toEqual({ type: 'string' });
    expect(b.generationConfig.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
    expect(sanitizeSchema({ $ref: '#/$defs/X', description: 'ignored sibling' })).toEqual({ $ref: '#/$defs/X' });
    const changed = req('gemini-3-flash', { ...r, messages: [msg('user', 'lookup'), { ...prior, replay: [{ ...prior.replay![0]!, model: 'other' }] }, r.messages[2]!] });
    expect(body(changed).contents[1].parts[0].functionCall.id).toBe('call-7');
  });
});

test('SSE preserves empty signed parts, native function id, usage and finish', async () => {
  const chunks = [
    { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }], modelVersion: 'gemini-3-flash-001' },
    { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'empty' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'fc-1', name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'signed' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 8, thoughtsTokenCount: 3 } },
  ];
  const fetcher = (async () => new Response(chunks.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
  const out = await collect(createGeminiProvider(opts).stream(req(), { fetch: fetcher, key: 'secret' }));
  expect(out.find((e) => e.t === 'tool_start')).toEqual({ t: 'tool_start', i: 0, id: 'fc-1', name: 'lookup' });
  expect(out.find((e) => e.t === 'tool_args')).toEqual({ t: 'tool_args', i: 0, d: '{"q":"x"}' });
  expect(out.find((e) => e.t === 'usage')).toEqual({ t: 'usage', u: { inputTotal: 100, inputCacheRead: 20, outputTotal: 11, outputReasoning: 3 } });
  expect(out.find((e) => e.t === 'replay')).toMatchObject({ r: { payload: [{ text: 'thinking', thought: true }, { text: '', thoughtSignature: 'empty' }, { functionCall: { id: 'fc-1' }, thoughtSignature: 'signed' }, { text: 'hello' }] } });
  expect(out.at(-1)).toEqual({ t: 'finish', reason: 'end', raw: 'STOP', model: 'gemini-3-flash-001' });
});

test('prompt safety and malformed tool calls are typed outcomes', async () => {
  const fake = (chunks: unknown[]) => (async () => new Response(chunks.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
  const blocked = await collect(createGeminiProvider(opts).stream(req(), { fetch: fake([{ promptFeedback: { blockReason: 'OTHER' } }]), key: 'secret' }));
  expect(blocked.at(-1)).toMatchObject({ t: 'finish', reason: 'content_filter', raw: 'OTHER' });
  const malformed = await collect(createGeminiProvider(opts).stream(req(), { fetch: fake([{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }]), key: 'secret' }));
  expect(malformed.at(-1)?.t).toBe('error');
  if (malformed.at(-1)?.t === 'error') expect((malformed.at(-1) as Extract<StreamEv, { t: 'error' }>).err.code).toBe('tool_protocol_invalid');
});

test('native model list is paginated and uses the key only in a header', async () => {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    urls.push(url); headers.push(new Headers(init.headers));
    const page = urls.length === 1 ? { models: [{ name: 'models/gemini-3-flash', inputTokenLimit: 100000, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' } : { models: [{ name: 'models/gemini-2.5-flash', inputTokenLimit: 50000, supportedGenerationMethods: ['generateContent'] }] };
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const args = { fetch: fetcher, key: 'secret', signal: new AbortController().signal, dialect: 'gemini' as const };
  const found = await listModels(base, args);
  expect(found.models).toEqual([{ id: 'gemini-2.5-flash', contextLength: 50000 }, { id: 'gemini-3-flash', contextLength: 100000 }]);
  expect(urls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  expect(urls[1]).toContain('pageToken=next');
  expect(urls.every((u) => !u.includes('secret'))).toBe(true);
  expect(headers[0]!.get('x-goog-api-key')).toBe('secret');
  const catalog = await fetchCatalog(base, { ...args, fetch: (async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-3-flash', inputTokenLimit: 100000, supportedGenerationMethods: ['generateContent'] }] }))) as unknown as typeof fetch });
  expect(catalog.server).toBe('gemini');
  expect(catalog.caps['gemini-3-flash']).toEqual({ contextLength: 100000 });
});

test('config builds a native Gemini provider and resolves its key lazily', async () => {
  const cfg = parseConfig('[connections.gemini]\ndialect = "gemini"\nkey_env = "GEMINI_API_KEY"\n', null);
  const conn = buildConnections(cfg, { env: { GEMINI_API_KEY: 'secret' }, secrets: createSecretResolver({ env: { GEMINI_API_KEY: 'secret' } }), capsCache: {} }).connections.gemini!;
  expect(conn.capsFor!('gemini-3-flash').reasoning.control).toBe('level');
  expect(await conn.resolveKey!()).toBe('secret');
  expect(conn.provider.wire!(req()).url).toContain('/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse');
});

test('three-round tool loop sends signed model parts before each matching response', async () => {
  const sent: any[] = [];
  const packets = [
    [{ candidates: [{ content: { parts: [{ functionCall: { id: 'fc1', name: 'lookup', args: { q: 'a' } }, thoughtSignature: 'sig1' }] }, finishReason: 'STOP' }] }],
    [{ candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'empty2' }, { functionCall: { id: 'fc2', name: 'lookup', args: { q: 'b' } }, thoughtSignature: 'sig2' }] }, finishReason: 'STOP' }] }],
    [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
  ];
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response(packets.shift()!.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const provider = createGeminiProvider(opts);
  const tools = [{ name: 'lookup', description: 'Lookup', schema: { type: 'object' } }];
  const first = await collect(provider.stream(req('gemini-3-flash', { tools }), { fetch: fetcher, key: 'secret' }));
  const call1 = first.find((e) => e.t === 'tool_start') as Extract<StreamEv, { t: 'tool_start' }>;
  const replay1 = first.find((e) => e.t === 'replay') as Extract<StreamEv, { t: 'replay' }>;
  const a1: PromptMsg = blocks('assistant', { k: 'tool_call', id: call1.id, name: call1.name, args: '{"q":"a"}' });
  a1.replay = [replay1.r];
  const second = await collect(provider.stream(req('gemini-3-flash', { tools, messages: [msg('user', 'hi'), a1, blocks('tool', { k: 'tool_result', callId: 'fc1', name: 'lookup', text: 'A' })] }), { fetch: fetcher, key: 'secret' }));
  const call2 = second.find((e) => e.t === 'tool_start') as Extract<StreamEv, { t: 'tool_start' }>;
  const replay2 = second.find((e) => e.t === 'replay') as Extract<StreamEv, { t: 'replay' }>;
  const a2: PromptMsg = blocks('assistant', { k: 'tool_call', id: call2.id, name: call2.name, args: '{"q":"b"}' });
  a2.replay = [replay2.r];
  const third = await collect(provider.stream(req('gemini-3-flash', { tools, messages: [msg('user', 'hi'), a1, blocks('tool', { k: 'tool_result', callId: 'fc1', name: 'lookup', text: 'A' }), a2, blocks('tool', { k: 'tool_result', callId: 'fc2', name: 'lookup', text: 'B' })] }), { fetch: fetcher, key: 'secret' }));
  expect(sent).toHaveLength(3);
  expect(sent[1].contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
  expect(sent[1].contents[1].parts[0].thoughtSignature).toBe('sig1');
  expect(sent[1].contents[2].parts[0].functionResponse.id).toBe('fc1');
  expect(sent[2].contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
  expect(sent[2].contents[3].parts[0]).toEqual({ text: '', thoughtSignature: 'empty2' });
  expect(sent[2].contents[3].parts[1].thoughtSignature).toBe('sig2');
  expect(sent[2].contents[4].parts[0].functionResponse.id).toBe('fc2');
  expect(third.find((e) => e.t === 'text')).toMatchObject({ d: 'done' });
});
