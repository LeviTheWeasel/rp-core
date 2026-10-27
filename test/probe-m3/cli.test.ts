// `rp-core probe <conn:model> --active` (cli/catalog.ts cmdProbe with `active`), called in-process
// against a local mock: the catalog half, then the active probes; probe facts are stored only with
// --write, apart from the catalog facts; a later catalog refresh keeps them; the plain probe still
// makes no model call. The flag itself (main.ts, REPL /probe) is the cli agent's.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdProbe, factsSummary, type ProbeResult } from '../../src/cli/catalog.ts';
import { UsageError } from '../../src/cli/args.ts';
import type { Io } from '../../src/cli/io.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { PROBE_TIMEOUT_MS } from '../../src/providers/probe.ts';
import { failing, hasTools, leaker, mockServer, nativeCaller, noTools, thinker } from './mock.ts';

const mock = mockServer();
afterAll(() => mock.stop());

function io(): Io & { stdout: () => string } {
  let out = '';
  return {
    out: { write: (t) => void (out += t), flush: async () => {} },
    err: { write: () => {}, flush: async () => {} },
    stdout: () => out,
  };
}

function home(): string {
  const h = tmpHome('rp-core-probe-m3-');
  writeFileSync(join(h, 'config.toml'), `[connections.mock]\nbase_url = "${mock.base}"\n`);
  return h;
}

async function probe(h: string, args: { target?: string; write?: boolean; active?: boolean; json?: boolean }) {
  const o = io();
  const code = await cmdProbe({
    rt: loadRuntime(h, {}),
    io: o,
    json: args.json ?? true,
    clock: fakeClock(),
    fetch,
    timeoutMs: 2_000,
    activeTimeouts: { firstByteMs: 5_000, idleMs: 5_000 },
    write: args.write ?? false,
    ...(args.active !== undefined ? { active: args.active } : {}),
    ...(args.target !== undefined ? { target: args.target } : {}),
  });
  return { code, out: o.stdout(), results: args.json === false ? [] : (JSON.parse(o.stdout()) as ProbeResult[]) };
}

const chatCalls = (): number => mock.paths.filter((p) => p === '/v1/chat/completions').length;

describe('probe --active', () => {
  test('without --write: observations and facts printed, caps shown with the probe stored, nothing written', async () => {
    mock.behave = nativeCaller;
    const h = home();
    const r = await probe(h, { target: 'mock:m', active: true });
    expect(r.code).toBe(0);
    const res = r.results[0]!;
    expect(res.active!.observations.map((o) => o.probe)).toEqual(['stream', 'tools', 'tools_result', 'json_schema']);
    expect(res.active!.facts).toEqual({ streamUsage: 'timings', tools: 'native', structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' } });
    expect(res.active!.written).toBe(false);
    expect(res.written).toBe(false);
    // caps "with this probe stored": the probe slot speaks.
    expect(res.caps!.source).toContain('probe');
    expect(res.caps!.tools).toBe('native');
    expect(existsSync(join(h, 'caps-cache.json'))).toBe(false);
  });

  test('--write stores the facts as the row\'s probe part, next to the catalog part; new turns see source probe', async () => {
    mock.behave = nativeCaller;
    const h = home();
    const r = await probe(h, { target: 'mock:m', active: true, write: true });
    expect(r.results[0]!.written).toBe(true);
    expect(r.results[0]!.active!.written).toBe(true);
    const cache = JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(cache['mock:m']).toEqual({
      as_of: '2026-10-26',
      server: 'unknown',
      probe: { streamUsage: 'timings', tools: 'native', structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' } },
    });
    const caps = loadRuntime(h, {}).connections.mock!.capsFor!('m');
    expect(caps.source).toEqual(['probe']);
    expect(caps.structuredOutput).toEqual({ mode: 'json_schema', confirmedBy: 'probe' });

    // A catalog-only refresh (no model call) keeps the probe part.
    const before = chatCalls();
    const again = await probe(h, { target: 'mock:m', write: true });
    expect(chatCalls()).toBe(before);
    expect(again.results[0]!.active).toBeUndefined();
    const after = JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(after['mock:m']!.probe).toEqual(cache['mock:m']!.probe);
    // So does a whole-connection refresh.
    await probe(h, { target: 'mock', write: true });
    expect((JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, Record<string, unknown>>)['mock:m']!.probe).toEqual(cache['mock:m']!.probe);
  });

  test('a later run starts from the caps without the old probe facts, and an inconclusive fact erases nothing', async () => {
    const h = home();
    writeFileSync(
      join(h, 'caps-cache.json'),
      JSON.stringify({ 'mock:m': { as_of: '2026-10-01', catalog: { contextLength: 4096 }, probe: { tools: 'native', structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' } } } }),
    );
    mock.behave = leaker;
    const r = await probe(h, { target: 'mock:m', active: true, write: true });
    expect(r.results[0]!.active!.facts).toEqual({ streamUsage: 'timings', tools: 'prompted', structuredOutput: { mode: 'none' } });
    const row = (JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, { catalog: unknown; probe: unknown; as_of: string }>)['mock:m']!;
    expect(row.as_of).toBe('2026-10-26');
    expect(row.probe).toEqual({ tools: 'prompted', structuredOutput: { mode: 'none' }, streamUsage: 'timings' });
  });

  test('a refused tools probe prints a hint; text output lists every probe and the facts', async () => {
    mock.behave = noTools;
    const h = home();
    const r = await probe(h, { target: 'mock:m', active: true, json: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain('active probes (3 calls):');
    expect(r.out).toMatch(/stream\s+ok\s+answered/);
    expect(r.out).toMatch(/tools\s+not ok\s+refused: the server refused the request \(HTTP 400\)/);
    expect(r.out).toContain('note: the server refused the tools field');
    expect(r.out).toContain('probe facts: tools prompted · usage timings · structured json_schema (confirmed by probe)');
    expect(r.out).toContain('[caps."mock:m"]');
    expect(r.out).toContain('tools = "prompted"');
    expect(r.out).toContain('not stored: --write keeps this catalog and the probe facts for new turns');
  });

  test('--active needs one model: a whole connection (or no target) is a usage error, and nothing is called', async () => {
    const h = home();
    const before = mock.paths.length;
    await expect(probe(h, { target: 'mock', active: true })).rejects.toBeInstanceOf(UsageError);
    await expect(probe(h, { active: true })).rejects.toThrow('--active probes one model');
    expect(mock.paths.length).toBe(before);
  });

  test('the plain probe still makes no model call', async () => {
    const h = home();
    const before = chatCalls();
    const r = await probe(h, { target: 'mock:m' });
    expect(r.code).toBe(0);
    expect(chatCalls()).toBe(before);
  });
});

describe('probe --active: verdicts, stops, hints (review fixes)', () => {
  test('an inconclusive probe reads "inconclusive", not "not ok", and the columns stay aligned', async () => {
    mock.behave = thinker({ ping: 10, tools: 2000, round2: 0, json: 2000 });
    const h = home();
    const r = await probe(h, { target: 'mock:m', active: true, json: false });
    const report = r.out.slice(r.out.indexOf('  active probes'), r.out.indexOf('  probe facts'));
    expect(report.split('\n').slice(1, -1)).toEqual([
      '    stream        ok            answered (finish stop); reasoning in reasoning; no usage in the stream (1000 ms)',
      '    stream_usage  not ok        no usage even with stream_options (1000 ms)',
      '    tools         inconclusive  the reply hit the 1024-token cap before any tool call (it was still thinking) (1000 ms)',
      '    json_schema   inconclusive  the reply hit the 512-token cap before any text (it was still thinking) (1000 ms)',
    ]);
    expect(r.out).toContain('probe facts: usage none · reasoning field reasoning');
  });

  test('a probe the run had no call left for is printed as not run (no time: it made no call)', async () => {
    let n = 0;
    mock.behave = failing(1, (b) => !hasTools(b) && b.response_format === undefined && !b.stream_options && n++ === 0, failing(1, (b) => hasTools(b) && !b.messages.some((m) => m.role === 'tool'), (b) => {
      if (hasTools(b) || b.response_format !== undefined) return nativeCaller(b);
      return new Response(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const r = await probe(h0(), { target: 'mock:m', active: true, json: false });
    expect(r.out).toContain('\n    json_schema   inconclusive  not run: the run had made its 6 calls (a repeated call counts)\n');
  });

  test('a 500 on every tools call still ends in prompted with the tools hint', async () => {
    mock.behave = failing(99, hasTools, nativeCaller);
    const r = await probe(h0(), { target: 'mock:m', active: true });
    const a = r.results[0]!.active!;
    expect(a.facts.tools).toBe('prompted');
    expect(a.notes).toEqual(['the server refused the tools field; the prompted transport works without it']);
  });

  test('a model the server does not list: the failed ping says where the list is', async () => {
    mock.behave = () => Response.json({ error: { message: 'model "qwen3:14b" not found, try pulling it first' } }, { status: 404 });
    const r = await probe(h0(), { target: 'mock:qwen3:14b', active: true, json: false });
    expect(r.out).toMatch(/stream {2}not ok {2}the server does not know this model \(or this URL\) \(HTTP 404\); the other probes were skipped/);
    expect(r.out).toContain("note: qwen3:14b is not in the server's model list: rp-core models mock lists what it has");
    expect(r.out).not.toContain('model "qwen3:14b" not found');
  });

  test("the caller's stop ends a probe that waits on a silent server: rejected, nothing stored even with --write", async () => {
    // A server that never answers (until the test lets go of the requests it holds).
    const held: ((r: Response) => void)[] = [];
    mock.behave = () => new Promise<Response>((resolve) => held.push(resolve));
    const h = home();
    const ctrl = new AbortController();
    const o = io();
    const t0 = Date.now();
    try {
      // Short call timeouts only bound a regression: the stop must win long before them.
      const run = cmdProbe({ rt: loadRuntime(h, {}), io: o, json: false, clock: fakeClock(), fetch, target: 'mock:m', write: true, active: true, signal: ctrl.signal, activeTimeouts: { firstByteMs: 2_000, idleMs: 2_000 } });
      while (held.length === 0) await Bun.sleep(5);
      ctrl.abort(new Error('stopped by the test'));
      await expect(run).rejects.toThrow('stopped by the test');
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(existsSync(join(h, 'caps-cache.json'))).toBe(false);
      expect(o.stdout()).toBe('');
    } finally {
      for (const answer of held) answer(new Response('gone', { status: 503 }));
    }
  });

  test('a stop during the catalog requests is rethrown at once, not reported as an unreachable server, and no later connection is asked', async () => {
    // The first connection's /v1/models hangs (the catalog would wait PROBE_TIMEOUT_MS for it).
    const held: ((r: Response) => void)[] = [];
    const silent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>((resolve) => held.push(resolve)) });
    const h = tmpHome('rp-core-probe-m3-');
    // The second connection's key command leaves a mark when it runs: after a stop nothing of it may.
    const mark = join(h, 'key-asked');
    writeFileSync(
      join(h, 'config.toml'),
      `[connections.silent]\nbase_url = "http://127.0.0.1:${silent.port}"\n\n[connections.mock]\nbase_url = "${mock.base}"\nkey_cmd = ["sh", "-c", "touch '${mark}'; echo sk-test"]\n`,
    );
    const asked: string[] = [];
    const watched = Object.assign((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      asked.push(String(url));
      return fetch(url, init);
    }, { preconnect: fetch.preconnect }) as typeof fetch;
    const ctrl = new AbortController();
    const o = io();
    const t0 = Date.now();
    try {
      const run = cmdProbe({ rt: loadRuntime(h, {}), io: o, json: true, clock: fakeClock(), fetch: watched, write: true, signal: ctrl.signal });
      while (held.length === 0) await Bun.sleep(5);
      ctrl.abort(new Error('stopped early'));
      await expect(run).rejects.toThrow('stopped early');
      expect(Date.now() - t0).toBeLessThan(PROBE_TIMEOUT_MS / 2);
      expect(asked.filter((u) => u.startsWith(mock.base))).toEqual([]);
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(join(h, 'caps-cache.json'))).toBe(false);
      expect(o.stdout()).toBe('');
    } finally {
      for (const answer of held) answer(new Response('gone', { status: 503 }));
      silent.stop(true);
    }
  });
});

const h0 = (): string => home();

test('factsSummary', () => {
  expect(factsSummary({})).toBe('none (nothing conclusive)');
  expect(factsSummary({ tools: 'native', reasoning: { output: 'tags' } as never })).toBe('tools native · reasoning in inline tags');
});
