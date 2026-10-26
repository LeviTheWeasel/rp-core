// Ported from Bunraku:src/kit/providers/models.test.ts@702d8120 (parseModelsPayload, modelsUrlLadder cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// probe.ts: the /models ladder (cases adapted from Bunraku src/kit/providers/models.test.ts), and
// fetchCatalog against local Bun.serve mocks impersonating llama.cpp, Ollama, OpenRouter, koboldcpp,
// LM Studio and vLLM, an unreachable port, timeouts and aborts; then the caps cache round trip.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  capsCachePath,
  fetchCatalog,
  modelsUrlLadder,
  ollamaShowCaps,
  openRouterCaps,
  parseModelsPayload,
  readCapsCache,
  serverRootOf,
  writeCapsCache,
  type CapsCacheRow,
} from '../../src/providers/probe.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import { ProviderError } from '../../src/providers/types.ts';
import { tmpHome } from '../helpers.ts';

// ---------------------------------------------------------------------------------------------------
// Mock servers
// ---------------------------------------------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  body: string;
  auth: string | null;
}

type Route = (req: Request, body: string) => Response | Promise<Response>;

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

/** A local server answering `routes` (key: "METHOD /path?query" or "METHOD /path"); anything else 404. */
function mock(routes: Record<string, Route>): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.text();
      seen.push({ method: req.method, path: `${u.pathname}${u.search}`, body, auth: req.headers.get('authorization') });
      const route = routes[`${req.method} ${u.pathname}${u.search}`] ?? routes[`${req.method} ${u.pathname}`];
      return route ? route(req, body) : new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

const json = (v: unknown, status = 200): Route => () => Response.json(v, { status });

function opts(extra: Partial<Parameters<typeof fetchCatalog>[1]> = {}): Parameters<typeof fetchCatalog>[1] {
  return { fetch, key: null, signal: new AbortController().signal, timeoutMs: 1000, ...extra };
}

// ---------------------------------------------------------------------------------------------------
// The ladder (adapted from Bunraku models.test.ts)
// ---------------------------------------------------------------------------------------------------

describe('parseModelsPayload', () => {
  test('openai-style {data:[...]} with context sniffing, sorted', () => {
    const models = parseModelsPayload({ data: [{ id: 'b-model', context_length: 128000 }, { id: 'a-model', context_window: 200000 }] });
    expect(models.map((m) => [m.id, m.contextLength])).toEqual([
      ['a-model', 200000],
      ['b-model', 128000],
    ]);
  });

  test('bare arrays and google-style {models:[...]} with name and inputTokenLimit', () => {
    expect(parseModelsPayload([{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }]).map((m) => m.id)).toEqual(['claude-opus-4-8']);
    const g = parseModelsPayload({ models: [{ name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576 }] });
    expect(g.map((m) => [m.id, m.contextLength])).toEqual([['models/gemini-2.5-pro', 1048576]]);
  });

  test('max_tokens is not a context window; vLLM max_model_len is', () => {
    expect(parseModelsPayload({ data: [{ id: 'x', max_tokens: 4096 }] })[0]!.contextLength).toBeUndefined();
    expect(parseModelsPayload({ data: [{ id: 'x', max_model_len: 32768 }] })[0]!.contextLength).toBe(32768);
  });

  test('dedupes ids, drops junk; garbage yields [] and never throws', () => {
    expect(parseModelsPayload({ data: [{ id: 'x' }, { id: 'x' }, { nope: true }, 42] }).map((m) => m.id)).toEqual(['x']);
    expect(parseModelsPayload(null)).toEqual([]);
    expect(parseModelsPayload('nonsense')).toEqual([]);
    expect(parseModelsPayload({ data: 'not-an-array' })).toEqual([]);
  });
});

describe('modelsUrlLadder / serverRootOf', () => {
  test('unversioned base gets the /v1 ladder, detailed first', () => {
    expect(modelsUrlLadder('https://proxy.example')).toEqual([
      'https://proxy.example/v1/models?detailed=true',
      'https://proxy.example/v1/models',
      'https://proxy.example/models',
    ]);
  });

  test('versioned base skips the /v1 insert', () => {
    expect(modelsUrlLadder('https://nano-gpt.com/api/v1')).toEqual(['https://nano-gpt.com/api/v1/models?detailed=true', 'https://nano-gpt.com/api/v1/models']);
  });

  test('a pasted chat endpoint is stripped, an explicit models URL is used as-is', () => {
    expect(modelsUrlLadder('https://proxy.example/v1/chat/completions/')).toEqual(['https://proxy.example/v1/models?detailed=true', 'https://proxy.example/v1/models']);
    expect(modelsUrlLadder('https://proxy.example/v1/models')).toEqual(['https://proxy.example/v1/models']);
  });

  test('the server root drops the endpoint and the /vN segment', () => {
    expect(serverRootOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(serverRootOf('http://127.0.0.1:8080/v1/chat/completions')).toBe('http://127.0.0.1:8080');
    expect(serverRootOf('https://host.example/llama/v1/models')).toBe('https://host.example/llama');
    expect(serverRootOf('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
  });
});

describe('catalog readers', () => {
  test('openRouterCaps reads supported_parameters (RoleCall parseCapabilities)', () => {
    expect(
      openRouterCaps({
        id: 'anthropic/claude-sonnet-4.5',
        context_length: 1000000,
        top_provider: { context_length: 1000000, max_completion_tokens: 64000, is_moderated: true },
        supported_parameters: ['tools', 'tool_choice', 'reasoning', 'include_reasoning', 'structured_outputs', 'Temperature', 'top_p', 'top_k', 'max_tokens', 'stop', 'response_format', 'logit_bias'],
      }),
    ).toEqual({
      contextLength: 1000000,
      maxOutput: 64000,
      tools: 'native',
      toolChoice: ['auto', 'none'],
      toolChoiceHonored: true,
      structuredOutput: { mode: 'json_schema', confirmedBy: 'host' },
      reasoning: { control: 'effort' } as never,
      samplers: { accepted: ['temperature', 'top_p', 'top_k', 'stop', 'max_tokens'] },
    });
    expect(openRouterCaps({ id: 'plain', supported_parameters: ['response_format'] })).toEqual({});
  });

  test('ollamaShowCaps: runtime window only, never the trained one', () => {
    const show = { capabilities: ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 1024000 }, parameters: 'stop "<|im_end|>"' };
    const none = ollamaShowCaps('mag', show);
    expect(none.caps).toEqual({});
    expect(none.notes[0]).toContain('trained 1024000');
    expect(ollamaShowCaps('mag', { ...show, parameters: 'num_ctx                        8192\nstop "x"' }).caps).toEqual({ contextLength: 8192 });
    expect(ollamaShowCaps('mag', show, 16384).caps).toEqual({ contextLength: 16384 });
    // A loaded window above the trained one is clamped.
    expect(ollamaShowCaps('m', { model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 } }, 8192).caps).toEqual({ contextLength: 4096 });
  });
});

// ---------------------------------------------------------------------------------------------------
// fetchCatalog against mocks
// ---------------------------------------------------------------------------------------------------

describe('fetchCatalog: llama.cpp', () => {
  test('/props n_ctx is the window, n_ctx_train is not; total_slots is advice', async () => {
    const m = mock({
      'GET /v1/models': json({ object: 'list', data: [{ id: 'qwen3-14b', object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 40960 } }] }),
      'GET /props': json({ default_generation_settings: { n_ctx: 16384, params: {} }, total_slots: 4, chat_template: '...' }),
    });
    const info = await fetchCatalog(`${m.base}/v1`, opts());
    expect(info.server).toBe('llama.cpp');
    expect(info.models).toEqual([{ id: 'qwen3-14b', contextLength: 16384 }]);
    expect(info.caps).toEqual({ 'qwen3-14b': { contextLength: 16384 } });
    expect(info.slots).toBe(4);
    expect(info.notes.some((n) => n.includes('4 slots') && n.includes('[D-84]'))).toBe(true);
    // Read-only: GETs only, and the probe never claims capacity.
    expect(m.seen.every((s) => s.method === 'GET')).toBe(true);
    expect(JSON.stringify(info.caps)).not.toContain('maxInFlight');
    // owned_by already named the server: no detection sweep.
    expect(m.seen.map((s) => s.path)).toEqual(['/v1/models?detailed=true', '/props']);

    // The catalog feeds resolveCaps; capacity stays 1 locally.
    const caps = resolveCaps({ dialect: 'openai-chat', origin: m.base, local: true, model: 'qwen3-14b', server: info.server, catalog: info.caps['qwen3-14b'] });
    expect(caps.contextLength).toBe(16384);
    expect(caps.source).toEqual(['host', 'model', 'catalog']);
    expect(caps.extraBody).toEqual({ cache_prompt: true });
    expect(caps.maxInFlight).toBe(1);
  });

  test('an older llama.cpp without owned_by is found by /props; /slots counts slots', async () => {
    const m = mock({
      'GET /v1/models': json({ data: [{ id: 'model.gguf' }] }),
      'GET /props': json({ default_generation_settings: { n_ctx: 8192 } }),
      'GET /slots': json([{ id: 0 }, { id: 1 }]),
    });
    const info = await fetchCatalog(m.base, opts({ model: 'whatever' }));
    expect(info.server).toBe('llama.cpp');
    // llama.cpp serves its loaded model whatever the request names.
    expect(info.caps).toEqual({ whatever: { contextLength: 8192 } });
    expect(info.slots).toBe(2);
  });
});

describe('fetchCatalog: Ollama', () => {
  const show: Record<string, unknown> = {
    'loaded:latest': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, parameters: '' },
    'tuned:latest': { capabilities: ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, parameters: 'num_ctx 12288\nstop "<|im_end|>"' },
    'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M': {
      capabilities: ['completion'],
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 1024000 },
      parameters: 'stop                           "<|im_start|>"\nstop                           "<|im_end|>"',
    },
  };
  const routes = (): Record<string, Route> => ({
    'GET /v1/models': json({ object: 'list', data: Object.keys(show).map((id) => ({ id, object: 'model', owned_by: 'library' })) }),
    'GET /api/version': json({ version: '0.12.0' }),
    'GET /api/ps': json({ models: [{ name: 'loaded:latest', model: 'loaded:latest', context_length: 32768 }] }),
    'POST /api/show': (_req, body) => {
      const name = (JSON.parse(body) as { model: string }).model;
      return name in show ? Response.json(show[name]) : Response.json({ error: 'not found' }, { status: 404 });
    },
  });

  test('/api/show per model: loaded window, PARAMETER num_ctx, else a note; tools and thinking', async () => {
    const m = mock(routes());
    const info = await fetchCatalog(`${m.base}/v1`, opts());
    expect(info.server).toBe('ollama');
    expect(info.caps['loaded:latest']).toEqual({
      contextLength: 32768,
      tools: 'native',
      reasoning: { output: 'reasoning', control: 'effort', canDisable: true, offShape: { reasoning_effort: 'none' } } as never,
    });
    expect(info.caps['tuned:latest']).toEqual({ contextLength: 12288 });
    expect(info.caps['hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M']).toBeUndefined();
    expect(info.notes.some((n) => n.includes('MN-12B-Mag-Mell') && n.includes('trained 1024000') && n.includes('num_ctx'))).toBe(true);
    expect(info.models.find((x) => x.id === 'loaded:latest')!.contextLength).toBe(32768);

    // POST /api/show is the only non-GET request, one per model, with {model}.
    const posts = m.seen.filter((s) => s.method !== 'GET');
    expect(posts.every((p) => p.method === 'POST' && p.path === '/api/show')).toBe(true);
    expect(posts.map((p) => (JSON.parse(p.body) as { model: string }).model).sort()).toEqual(Object.keys(show).sort());
  });

  test('with `model`, only that model is shown; an unknown one is noted', async () => {
    const m = mock(routes());
    const info = await fetchCatalog(m.base, opts({ model: 'tuned:latest' }));
    expect(Object.keys(info.caps)).toEqual(['tuned:latest']);
    expect(m.seen.filter((s) => s.method === 'POST').length).toBe(1);
    const missing = await fetchCatalog(m.base, opts({ model: 'ghost:7b' }));
    expect(missing.caps).toEqual({});
    expect(missing.notes).toContain('ghost:7b is not in the server\'s model list');
    expect(missing.notes).toContain('POST /api/show ghost:7b: HTTP 404');
  });

  test('the catalog lifts tools for the model but the host keeps tool_choice unhonoured', async () => {
    const m = mock(routes());
    const info = await fetchCatalog(m.base, opts({ model: 'loaded:latest' }));
    const caps = resolveCaps({ dialect: 'openai-chat', origin: m.base, local: true, model: 'loaded:latest', server: info.server, catalog: info.caps['loaded:latest'] });
    expect(caps.tools).toBe('native');
    expect(caps.toolChoiceHonored).toBe(false);
    expect(caps.contextLength).toBe(32768);
    expect(caps.reasoning.tags).toBeDefined();
    expect(caps.maxInFlight).toBe(1);
  });
});

describe('fetchCatalog: OpenRouter', () => {
  test('supported_parameters per model; no local-server sweep; the key goes only to its origin', async () => {
    const m = mock({
      'GET /api/v1/models': json({
        data: [
          {
            id: 'anthropic/claude-sonnet-4.5',
            context_length: 1000000,
            top_provider: { max_completion_tokens: 64000 },
            supported_parameters: ['tools', 'tool_choice', 'reasoning', 'structured_outputs', 'temperature', 'top_p', 'max_tokens', 'stop'],
          },
          { id: 'thedrummer/rocinante-12b', context_length: 32768, supported_parameters: ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'max_tokens', 'stop', 'seed'] },
        ],
      }),
    });
    // The transport is the injected fetch: the openrouter.ai origin is served by the local mock.
    const toMock: typeof fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace('https://openrouter.ai', m.base), init),
      { preconnect: fetch.preconnect },
    );
    const info = await fetchCatalog('https://openrouter.ai/api/v1', opts({ fetch: toMock, key: 'sk-or-test' }));
    expect(info.server).toBe('openrouter');
    expect(m.seen.map((s) => s.path)).toEqual(['/api/v1/models?detailed=true']);
    expect(m.seen[0]!.auth).toBe('Bearer sk-or-test');
    expect(info.models).toEqual([
      { id: 'anthropic/claude-sonnet-4.5', contextLength: 1000000 },
      { id: 'thedrummer/rocinante-12b', contextLength: 32768 },
    ]);
    expect(info.caps['thedrummer/rocinante-12b']).toEqual({
      contextLength: 32768,
      samplers: { accepted: ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'seed', 'stop', 'max_tokens'] },
    });
    const sonnet = resolveCaps({
      dialect: 'openai-chat',
      origin: 'https://openrouter.ai:443',
      local: false,
      model: 'anthropic/claude-sonnet-4.5',
      server: info.server,
      catalog: info.caps['anthropic/claude-sonnet-4.5'],
    });
    expect(sonnet.tools).toBe('native');
    expect(sonnet.maxOutput).toBe(64000);
    expect(sonnet.reasoning.control).toBe('effort');
    expect(sonnet.reasoning.output).toBe('reasoning_details'); // the host's field survives the catalog's partial
    expect(sonnet.prefill).toBe('assistant-last');
    expect(sonnet.extraBody).toEqual({ provider: { allow_fallbacks: false } });
    expect(sonnet.source).toEqual(['host', 'model', 'catalog']);
    expect(sonnet.maxInFlight).toBe(4);
  });
});

describe('fetchCatalog: koboldcpp, LM Studio, vLLM', () => {
  test('koboldcpp: owned_by and true_max_context_length', async () => {
    const m = mock({
      'GET /v1/models': json({ object: 'list', data: [{ id: 'koboldcpp/Mag-Mell', owned_by: 'koboldcpp' }] }),
      'GET /api/extra/true_max_context_length': json({ value: 12288 }),
    });
    const info = await fetchCatalog(m.base, opts());
    expect(info.server).toBe('koboldcpp');
    expect(info.caps).toEqual({ 'koboldcpp/Mag-Mell': { contextLength: 12288 } });
  });

  test('koboldcpp found by /api/extra/version even when it also answers like Ollama', async () => {
    const m = mock({
      'GET /v1/models': json({ data: [{ id: 'm' }] }),
      'GET /api/extra/version': json({ result: 'KoboldCpp', version: '1.123.1' }),
      'GET /api/version': json({ version: '0.5.0' }),
      'GET /api/extra/true_max_context_length': json({ value: 4096 }),
    });
    expect((await fetchCatalog(m.base, opts())).server).toBe('koboldcpp');
  });

  test('LM Studio: the loaded instance window, not max_context_length; parallel is advice', async () => {
    const m = mock({
      'GET /v1/models': json({ data: [{ id: 'google/gemma-4-26b', owned_by: 'organization_owner' }, { id: 'deepseek-r1', owned_by: 'organization_owner' }] }),
      'GET /api/v1/models': json({
        models: [
          {
            type: 'llm',
            key: 'google/gemma-4-26b',
            loaded_instances: [{ id: 'google/gemma-4-26b', config: { context_length: 4096, parallel: 2 } }],
            max_context_length: 262144,
            capabilities: { vision: true, trained_for_tool_use: true },
          },
          { type: 'llm', key: 'deepseek-r1', loaded_instances: [], max_context_length: 131072 },
        ],
      }),
    });
    const info = await fetchCatalog(`${m.base}/v1`, opts());
    expect(info.server).toBe('lmstudio');
    expect(info.caps).toEqual({ 'google/gemma-4-26b': { contextLength: 4096, tools: 'native' } });
    expect(info.slots).toBe(2);
    expect(info.notes.some((n) => n.includes('deepseek-r1 is not loaded') && n.includes('131072'))).toBe(true);
  });

  test('vLLM: owned_by and max_model_len', async () => {
    const m = mock({ 'GET /v1/models': json({ data: [{ id: 'Qwen/Qwen3-32B', owned_by: 'vllm', max_model_len: 32768 }] }) });
    const info = await fetchCatalog(m.base, opts());
    expect(info.server).toBe('vllm');
    expect(info.caps).toEqual({ 'Qwen/Qwen3-32B': { contextLength: 32768 } });
    expect(m.seen.length).toBe(1);
  });

  test('an unknown OpenAI-compatible server: the sweep is read-only and failures stay quiet', async () => {
    const m = mock({ 'GET /v1/models': json({ data: [{ id: 'mystery' }] }) });
    const info = await fetchCatalog(m.base, opts());
    expect(info.server).toBe('unknown');
    expect(info.caps).toEqual({});
    expect(info.notes).toEqual([]);
    expect(m.seen.every((s) => s.method === 'GET')).toBe(true);
  });
});

describe('fetchCatalog: failures', () => {
  test('an unreachable port throws ProviderError unreachable (network)', async () => {
    const tmp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = tmp.port;
    tmp.stop(true);
    const err = await fetchCatalog(`http://127.0.0.1:${port}/v1`, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('unreachable');
    expect((err as ProviderError).category).toBe('network');
  });

  test('a reachable server never throws: 401 and 500 become notes', async () => {
    const m = mock({ 'GET /v1/models': json({ error: 'bad key' }, 401) });
    const info = await fetchCatalog(m.base, opts({ key: 'wrong' }));
    expect(info.models).toEqual([]);
    expect(info.notes[0]).toContain('auth_failed');
    // 401 stops the ladder: no hammering of /models.
    expect(m.seen.filter((s) => s.path.includes('models') && !s.path.startsWith('/api/')).length).toBe(1);

    const broken = mock({});
    const info2 = await fetchCatalog(broken.base, opts());
    expect(info2.server).toBe('unknown');
    expect(info2.notes[0]).toContain('no model list');
  });

  test('a hanging endpoint times out into a note; the rest of the catalog still arrives', async () => {
    const m = mock({
      'GET /v1/models': json({ data: [{ id: 'm', owned_by: 'llamacpp' }] }),
      'GET /props': () => new Promise<Response>(() => undefined),
      'GET /slots': json([{ id: 0 }]),
    });
    const info = await fetchCatalog(m.base, opts({ timeoutMs: 150 }));
    expect(info.server).toBe('llama.cpp');
    expect(info.notes).toContain('GET /props: timeout');
    expect(info.slots).toBe(1);
  });

  test("the caller's abort rejects with its reason", async () => {
    const m = mock({ 'GET /v1/models': () => new Promise<Response>(() => undefined) });
    const ac = new AbortController();
    const p = fetchCatalog(m.base, opts({ signal: ac.signal, timeoutMs: 5000 }));
    setTimeout(() => ac.abort(new Error('user cancelled')), 50);
    expect(await p.catch((e: unknown) => (e as Error).message)).toBe('user cancelled');
  });

  test('a redirect to another origin is refused, not followed', async () => {
    const other = mock({ 'GET /v1/models': json({ data: [{ id: 'leak' }] }) });
    const m = mock({
      'GET /v1/models?detailed=true': () => new Response(null, { status: 302, headers: { location: `${other.base}/v1/models` } }),
      'GET /v1/models': json({ data: [{ id: 'own' }] }),
    });
    const info = await fetchCatalog(m.base, opts({ key: 'secret' }));
    expect(info.models.map((x) => x.id)).toEqual(['own']);
    expect(other.seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The caps cache
// ---------------------------------------------------------------------------------------------------

describe('caps cache', () => {
  test('missing file → {}; write then read round-trips; keys sorted; no temp file left', () => {
    const home = join(tmpHome(), 'nested', 'home');
    expect(readCapsCache(home)).toEqual({});
    const cache: Record<string, CapsCacheRow> = {
      'local:qwen3-14b': { as_of: '2026-10-26', server: 'llama.cpp', caps: { contextLength: 16384 } },
      'ollama:gemma3:12b': { as_of: '2026-10-26', server: 'ollama', caps: { tools: 'native', reasoning: { control: 'effort' } as never } },
      'b:x': { as_of: '2026-10-25', caps: {} },
    };
    writeCapsCache(home, cache);
    expect(readCapsCache(home)).toEqual(cache);
    expect(Object.keys(JSON.parse(readFileSync(capsCachePath(home), 'utf8')) as object)).toEqual(['b:x', 'local:qwen3-14b', 'ollama:gemma3:12b']);
    expect(readdirSync(home)).toEqual(['caps-cache.json']);

    writeCapsCache(home, { 'b:x': { as_of: '2026-10-27', caps: { contextLength: 1 } } });
    expect(readCapsCache(home)).toEqual({ 'b:x': { as_of: '2026-10-27', caps: { contextLength: 1 } } });
    expect(readdirSync(home)).toEqual(['caps-cache.json']);
  });

  test('a corrupt or foreign file reads as {}; malformed rows are dropped', () => {
    const home = tmpHome();
    writeFileSync(capsCachePath(home), '{ not json');
    expect(readCapsCache(home)).toEqual({});
    writeFileSync(capsCachePath(home), '[1,2]');
    expect(readCapsCache(home)).toEqual({});
    writeFileSync(
      capsCachePath(home),
      JSON.stringify({ ok: { as_of: '2026-10-26', caps: { contextLength: 2 }, extra: 1 }, noDate: { caps: {} }, noCaps: { as_of: '2026-10-26' }, junk: 3 }),
    );
    expect(readCapsCache(home)).toEqual({ ok: { as_of: '2026-10-26', caps: { contextLength: 2 } } });
    expect(existsSync(capsCachePath(home))).toBe(true);
  });
});
