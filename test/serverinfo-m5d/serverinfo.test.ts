// M5d server-info reader (D-210) against Bun.serve fakes: llama.cpp /props (slots, build, endpoint
// flags), Ollama /api/version + /api/ps + /api/show, LM Studio /api/v1/models, a hanging server under
// the deadlines, and the cases that never send anything (remote origin, other dialect, a stop);
// the engine's memo, whose deadline covers the connection's key too.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  SERVER_INFO_REQUEST_MS,
  SERVER_INFO_TOTAL_MS,
  ollamaModel,
  readOllamaShow,
  readServerInfo,
} from '../../src/providers/server-info.ts';
import type { Connection } from '../../src/engine/api.ts';
import { ServerInfoMemo } from '../../src/engine/server-notices.ts';
import { fake, llamaProps, ollamaShow, type Fake } from './fakes.ts';

const fakes: Fake[] = [];
const up = (routes: Parameters<typeof fake>[0]): Fake => {
  const f = fake(routes);
  fakes.push(f);
  return f;
};
afterAll(() => {
  for (const f of fakes) f.stop();
});

describe('llama.cpp', () => {
  test('a recent build: slots, build number and /slots flag; only /props is asked', async () => {
    const f = up({ '/props': llamaProps() });
    expect(await readServerInfo(`${f.base}/v1`)).toEqual({ kind: 'llama.cpp', totalSlots: 2, build: 11901, endpointSlots: true });
    expect(f.paths).toEqual(['/props']);
  });

  test('an old build reads as its number', async () => {
    const f = up({ '/props': llamaProps({ build_info: 'b9000-1a2b3c4d', total_slots: 4 }) });
    expect(await readServerInfo(f.base)).toEqual({ kind: 'llama.cpp', totalSlots: 4, build: 9000, endpointSlots: true });
  });

  test('build 0 and a missing build_info are unknown (null)', async () => {
    const zero = up({ '/props': llamaProps({ build_info: 'b0-unknown' }) });
    const none = up({ '/props': { default_generation_settings: { n_ctx: 4096 }, total_slots: 1 } });
    expect(await readServerInfo(`${zero.base}/v1/chat/completions`)).toMatchObject({ kind: 'llama.cpp', build: null });
    expect(await readServerInfo(none.base)).toEqual({ kind: 'llama.cpp', totalSlots: 1, build: null });
  });

  test('/props without total_slots still is llama.cpp, the slot count unknown', async () => {
    const f = up({ '/props': { default_generation_settings: { n_ctx: 4096 }, build_info: 'b12000-ffff' } });
    expect(await readServerInfo(f.base)).toEqual({ kind: 'llama.cpp', totalSlots: null, build: 12000 });
  });

  test('/props missing and nothing else known → unknown with a reason', async () => {
    const f = up({});
    const info = await readServerInfo(`${f.base}/v1`);
    expect(info.kind).toBe('unknown');
    expect(info.kind === 'unknown' && info.reason).toBe('no known server (/props HTTP 404; /api/version HTTP 404; /api/v1/models HTTP 404)');
    expect(f.paths).toEqual(['/props', '/api/version', '/api/v1/models']);
  });

  test('a /props that is some other JSON is not llama.cpp', async () => {
    const f = up({ '/props': { hello: 'world' } });
    const info = await readServerInfo(f.base);
    expect(info.kind === 'unknown' && info.reason).toContain('/props is not llama.cpp');
  });
});

describe('Ollama', () => {
  const blob = '/models/blobs/sha256-0d1f';
  const shows: Record<string, unknown> = {
    'magmell-16k': ollamaShow(blob, 'num_ctx                        16384\nstop                           "<|im_end|>"\nnum_gpu 99\nuse_mmap false'),
    'magmell-32k': ollamaShow(blob, 'num_ctx 32768'),
  };
  const f = up({
    '/api/version': { version: '0.40.12' },
    '/api/ps': {
      models: [
        { name: 'magmell-16k:latest', model: 'magmell-16k:latest', digest: 'abc123', context_length: 16384, size_vram: 1 },
        { model: 'other:latest' },
        { size: 3 },
      ],
    },
    '/api/show': (body: unknown) => {
      const name = (body as { model?: string }).model ?? '';
      return name in shows ? Response.json(shows[name]) : Response.json({ error: `model '${name}' not found` }, { status: 404 });
    },
  });

  test('/api/version and /api/ps: version and what is loaded', async () => {
    expect(await readServerInfo(`${f.base}/v1`)).toEqual({
      kind: 'ollama',
      version: '0.40.12',
      loaded: [{ name: 'magmell-16k:latest', contextLength: 16384, digest: 'abc123' }, { name: 'other:latest' }],
    });
  });

  test('ollamaModel: the FROM blob (not the commented one) and the runner options', async () => {
    f.posts.length = 0;
    expect(await ollamaModel(f.base, 'magmell-16k')).toEqual({
      blob,
      runner: { num_ctx: 16384, num_batch: null, num_gpu: 99, main_gpu: null, use_mmap: false, num_thread: null },
    });
    expect(f.posts).toEqual([{ model: 'magmell-16k' }]);
    const other = await ollamaModel(`${f.base}/v1`, 'magmell-32k');
    expect(other?.blob).toBe(blob);
    expect(other?.runner.num_ctx).toBe(32768);
  });

  test('ollamaModel: an unknown name, a show without FROM, a remote root → null', async () => {
    expect(await ollamaModel(f.base, 'nope')).toBeNull();
    expect(readOllamaShow({ parameters: 'num_ctx 2048' })).toBeNull();
    let asked = 0;
    const spy = (async () => {
      asked++;
      return Response.json({});
    }) as unknown as typeof fetch;
    expect(await ollamaModel('https://api.example.com', 'm', { fetch: spy })).toBeNull();
    expect(asked).toBe(0);
  });

  test('/api/ps failing still gives Ollama, nothing loaded', async () => {
    const g = up({ '/api/version': { version: '0.40.12' } });
    expect(await readServerInfo(g.base)).toEqual({ kind: 'ollama', version: '0.40.12', loaded: [] });
  });
});

describe('LM Studio', () => {
  test('per model key whether it has loaded_instances (and loaded instance ids)', async () => {
    const f = up({
      '/props': { error: 'Unexpected endpoint or method. (GET /props)' },
      '/api/version': { error: 'Unexpected endpoint or method. (GET /api/version)' },
      '/api/v1/models': {
        models: [
          { type: 'llm', key: 'qwen3-8b', loaded_instances: [{ id: 'qwen3-8b', config: { context_length: 8192 } }] },
          { type: 'llm', key: 'gemma-3-12b', loaded_instances: [] },
          { type: 'llm', key: 'mistral-7b' },
          { type: 'llm', key: 'llama-3.1-8b', loaded_instances: [{ id: 'llama-3.1-8b:2' }] },
        ],
      },
    });
    expect(await readServerInfo(`${f.base}/v1`)).toEqual({
      kind: 'lmstudio',
      loaded: { 'qwen3-8b': true, 'gemma-3-12b': false, 'mistral-7b': false, 'llama-3.1-8b': true, 'llama-3.1-8b:2': true },
    });
  });

  test('without loaded_instances on any model: every key not loaded', async () => {
    const f = up({ '/api/v1/models': { models: [{ key: 'a' }, { key: 'b' }] } });
    expect(await readServerInfo(f.base)).toEqual({ kind: 'lmstudio', loaded: { a: false, b: false } });
  });

  test('an empty model list is not LM Studio', async () => {
    const f = up({ '/api/v1/models': { models: [] } });
    expect((await readServerInfo(f.base)).kind).toBe('unknown');
  });
});

describe('deadlines and failures (never throws)', () => {
  test('the defaults are D-210\'s', () => {
    expect([SERVER_INFO_REQUEST_MS, SERVER_INFO_TOTAL_MS]).toEqual([1500, 3000]);
  });

  test('a hanging server: unknown at the total deadline', async () => {
    const f = up({ '/props': 'hang', '/api/version': 'hang', '/api/v1/models': 'hang' });
    const t0 = performance.now();
    const info = await readServerInfo(f.base, { requestMs: 120, totalMs: 200 });
    const took = performance.now() - t0;
    expect(info).toEqual({ kind: 'unknown', reason: 'no answer within 200 ms' });
    expect(took).toBeLessThan(1000);
    // The total deadline cut the read before the last step (/api/version too, under a slow timer).
    expect(f.paths[0]).toBe('/props');
    expect(f.paths).not.toContain('/api/v1/models');
  });

  test('one path that hangs times out alone; the next step still answers', async () => {
    const f = up({ '/props': 'hang', '/api/version': { version: '0.40.12' }, '/api/ps': { models: [] } });
    expect(await readServerInfo(f.base, { requestMs: 100, totalMs: 1000 })).toEqual({ kind: 'ollama', version: '0.40.12', loaded: [] });
  });

  test('nothing listening: unknown, and no further requests', async () => {
    const f = fake({});
    const base = f.base;
    f.stop();
    const info = await readServerInfo(base);
    expect(info).toEqual({ kind: 'unknown', reason: `nothing answered at ${base}` });
  });

  test('remote origins and other dialects are never asked', async () => {
    let asked = 0;
    const spy = (async () => {
      asked++;
      return Response.json(llamaProps());
    }) as unknown as typeof fetch;
    expect(await readServerInfo('https://api.example.com/v1', { fetch: spy })).toEqual({ kind: 'unknown', reason: 'not a local server' });
    expect(await readServerInfo('http://127.0.0.1:1/v1', { fetch: spy, dialect: 'anthropic' })).toEqual({
      kind: 'unknown',
      reason: 'not an openai-chat connection (anthropic)',
    });
    expect(await readServerInfo('not a url', { fetch: spy })).toEqual({ kind: 'unknown', reason: 'no valid http(s) base URL' });
    expect(asked).toBe(0);
  });

  test('the injected fetch is used, with the key', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const spy = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return Response.json(llamaProps({ total_slots: 3 }));
    }) as unknown as typeof fetch;
    expect(await readServerInfo('http://localhost:8080/v1', { fetch: spy, key: 'k-test' })).toMatchObject({ kind: 'llama.cpp', totalSlots: 3 });
    expect(seen).toEqual([{ url: 'http://localhost:8080/props', auth: 'Bearer k-test' }]);
  });

  test("the caller's stop ends the read as unknown", async () => {
    const f = up({ '/props': 'hang' });
    const ac = new AbortController();
    const pending = readServerInfo(f.base, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('stop')), 20);
    expect(await pending).toEqual({ kind: 'unknown', reason: 'stopped' });
    const pre = new AbortController();
    pre.abort();
    expect(await readServerInfo(f.base, { signal: pre.signal })).toEqual({ kind: 'unknown', reason: 'stopped' });
  });
});

describe('ServerInfoMemo: the deadline covers the key', () => {
  const auths: (string | null)[] = [];
  const spy = (async (_url: string, init: RequestInit) => {
    auths.push(new Headers(init.headers).get('authorization'));
    return Response.json(llamaProps());
  }) as unknown as typeof fetch;
  const connWith = (resolveKey: () => Promise<string | null>): Connection =>
    ({ id: 'local', origin: 'http://127.0.0.1:8080', baseUrl: 'http://127.0.0.1:8080/v1', dialect: 'openai-chat', local: true, caps: {}, resolveKey }) as unknown as Connection;
  const never = (): Promise<string | null> => new Promise<string | null>(() => {});

  test('a key that never comes: the read goes on without it once one request would be left, and settles', async () => {
    auths.length = 0;
    const memo = new ServerInfoMemo({ fetch: spy, requestMs: 60, totalMs: 150 });
    const conn = connWith(never);
    const t0 = performance.now();
    memo.start(conn);
    // A later call's own key does not restart or replace the read.
    memo.start(conn, 'k-late');
    const got = memo.peek(conn.origin);
    expect(got).toBeInstanceOf(Promise);
    expect(await got).toMatchObject({ kind: 'llama.cpp', totalSlots: 2 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(auths).toEqual([null]);
    memo.close();
  });

  test('a key in time is sent', async () => {
    auths.length = 0;
    const memo = new ServerInfoMemo({ fetch: spy, requestMs: 200, totalMs: 1000 });
    const conn = connWith(async () => 'k-test');
    memo.start(conn);
    expect(await memo.peek(conn.origin)).toMatchObject({ kind: 'llama.cpp' });
    expect(auths).toEqual(['Bearer k-test']);
    memo.close();
  });

  test('closing the engine while the key hangs settles the read as stopped', async () => {
    auths.length = 0;
    const memo = new ServerInfoMemo({ fetch: spy, requestMs: 1000, totalMs: 3000 });
    const conn = connWith(never);
    memo.start(conn);
    const got = memo.peek(conn.origin);
    setTimeout(() => memo.close(), 10);
    expect(await got).toEqual({ kind: 'unknown', reason: 'stopped' });
    expect(auths).toEqual([]);
  });
});

describe('ServerInfoMemo: a passing failure is read again (D-210 amended)', () => {
  const conn: Connection = { id: 'local', origin: 'http://127.0.0.1:8080', baseUrl: 'http://127.0.0.1:8080/v1', dialect: 'openai-chat', local: true, caps: {}, key: null } as unknown as Connection;
  const serving = (answers: (() => Response)[]): { fetch: typeof fetch; calls: () => number } => {
    let n = 0;
    const f = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path !== '/props') return new Response('nope', { status: 404 });
      return answers[Math.min(n++, answers.length - 1)]!();
    }) as unknown as typeof fetch;
    return { fetch: f, calls: () => n };
  };
  const loading = (): Response => new Response('Loading model', { status: 503 });
  const ready = (): Response => Response.json(llamaProps());

  test('a server still loading (503) is read again after retryMs, and its answer is then kept', async () => {
    const s = serving([loading, ready]);
    const memo = new ServerInfoMemo({ fetch: s.fetch, retryMs: 40 });
    memo.start(conn);
    const first = await memo.peek(conn.origin);
    expect(first).toMatchObject({ kind: 'unknown' });
    expect((first as { reason: string }).reason).toContain('HTTP 503');
    // Within retryMs: no new read.
    memo.start(conn);
    expect(memo.peek(conn.origin)).toEqual(first);
    await new Promise((r) => setTimeout(r, 60));
    memo.start(conn);
    expect(await memo.peek(conn.origin)).toMatchObject({ kind: 'llama.cpp', totalSlots: 2 });
    // A definite answer stays: no read after retryMs.
    await new Promise((r) => setTimeout(r, 60));
    memo.start(conn);
    expect(s.calls()).toBe(2);
    memo.close();
  });

  test('a server that answered as something else is never read again', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const memo = new ServerInfoMemo({ fetch: f, retryMs: 10 });
    memo.start(conn);
    expect(await memo.peek(conn.origin)).toMatchObject({ kind: 'unknown' });
    const reads = n;
    await new Promise((r) => setTimeout(r, 30));
    memo.start(conn);
    expect(n).toBe(reads);
    memo.close();
  });
});
