// Fixes after the M3 review, cli lens: `send` names the narrator binding and the way out when the
// server does not know the model (model_not_found), and a script file's caps line checks the type
// of every value (a string window used to be merged as is).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { ACTIVE_PROBE_MAX_TOKENS, ACTIVE_PROBE_TOKENS } from '../../src/providers/probe-active.ts';
import { parseScriptFile, scriptCapsWith } from '../../src/providers/scripted.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { mockServer, nativeCaller } from '../probe-m3/mock.ts';
import { CARDS, collect, MAIN, ROOT, until } from './kit.ts';

const mock = mockServer();
afterAll(() => mock.stop());

function memIo(): Io & { stdout(): string; stderr(): string } {
  let out = '';
  let err = '';
  return {
    out: { write: (t) => void (out += t), flush: async () => {} },
    err: { write: (t) => void (err += t), flush: async () => {} },
    stdout: () => out,
    stderr: () => err,
  };
}

async function inProcess(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = memIo();
  const code = await main([...args, '--home', home], { io, env: {}, exit: () => {}, fetch, clock: fakeClock() });
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

describe('send: model_not_found', () => {
  test("the hint names the session's narrator binding, rp-core models and /model through rp-core chat", async () => {
    // Ollama's answer for a model that was never pulled (its words stay out of plain output).
    mock.behave = () => Response.json({ error: { message: 'model "qwen3:14b" not found, try pulling it first', type: 'api_error' } }, { status: 404 });
    const h = tmpHome('rp-core-review-m3-');
    writeFileSync(join(h, 'config.toml'), `[connections.ollama]\nbase_url = "${mock.base}"\nlocal = true\n\n[roles]\nnarrator = "ollama:qwen3:14b"\n`);
    const made = await inProcess(['new', '--card', join(CARDS, 'v3-full.json'), '--no-chat'], h);
    expect(made.code).toBe(0);
    const id = made.stdout.trim();
    const r = await inProcess(['send', id, 'Hello there.'], h);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('rp-core: the answer failed (request/model_not_found)');
    expect(r.stderr).toContain(
      `rp-core: hint: the narrator is ollama:qwen3:14b: rp-core models ollama lists what the server has; /model narrator ollama:<model> in rp-core chat ${id} switches the session (config.toml [roles] only sets new sessions)\n`,
    );
    expect(r.stderr).not.toContain('try pulling it first');
    // --json keeps stderr to the events' contract: no hint line.
    const j = await inProcess(['send', id, 'Hello again.', '--json'], h);
    expect(j.stderr).not.toContain('hint: the narrator is');
  });

  test('when the narrator failed over to its fallback and the fallback is the unknown model, the hint names the fallback', async () => {
    // The narrator's server is busy (retried, then the fallback); the fallback's model was never pulled.
    mock.behave = (b) =>
      b.model === 'qwen3:14b'
        ? Response.json({ error: { message: 'busy' } }, { status: 503, headers: { 'retry-after': '0' } })
        : Response.json({ error: { message: `model "${String(b.model)}" not found, try pulling it first` } }, { status: 404 });
    const h = tmpHome('rp-core-review-m3-');
    writeFileSync(
      join(h, 'config.toml'),
      `[connections.ollama]\nbase_url = "${mock.base}"\nlocal = true\n\n[roles]\nnarrator = "ollama:qwen3:14b"\nnarrator_fallback = "ollama:gemma3:4b"\n`,
    );
    const made = await inProcess(['new', '--card', join(CARDS, 'v3-full.json'), '--no-chat'], h);
    expect(made.code).toBe(0);
    const r = await inProcess(['send', made.stdout.trim(), 'Hello there.'], h);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('rp-core: the answer failed (request/model_not_found)');
    expect(r.stderr).toContain(
      'rp-core: hint: the fallback ollama:gemma3:4b is the model the server does not know (the narrator ollama:qwen3:14b failed first): rp-core models ollama lists what that server has; [roles] narrator_fallback in config.toml names the fallback of new sessions\n',
    );
    expect(r.stderr).not.toContain('hint: the narrator is');
  });
});

describe('a script caps line checks its values', () => {
  const bad: [string, string][] = [
    ['{"contextLength": "big"}', 'script line 1: caps.contextLength must be an integer from 256 to 100000000, got "big"'],
    ['{"maxInFlight": -3}', 'script line 1: caps.maxInFlight must be an integer from 1 to 64, got -3'],
    ['{"maxOutput": {"x": 1}}', 'script line 1: caps.maxOutput must be an integer from 1 to 100000000, got {"x":1}'],
    ['{"stopMax": 1.5}', 'script line 1: caps.stopMax must be an integer from 0 to 1024, got 1.5'],
    ['{"cacheMinTokens": "1024"}', 'script line 1: caps.cacheMinTokens must be an integer from 1 to 1000000, got "1024"'],
    ['{"strictTools": "yes"}', 'script line 1: caps.strictTools must be a boolean, got "yes"'],
    ['{"streamUsage": "sometimes"}', 'script line 1: caps.streamUsage must be one of stream_options, always, timings, none, got "sometimes"'],
    ['{"toolChoice": ["auto", "forced"]}', 'script line 1: caps.toolChoice must be an array of auto, none, required, got ["auto","forced"]'],
    ['{"structuredOutput": "json_schema"}', 'script line 1: caps.structuredOutput must be an object, got "json_schema"'],
    ['{"structuredOutput": {"mode": "grammar"}}', 'script line 1: caps.structuredOutput.mode must be one of json_schema, none, got "grammar"'],
    ['{"reasoning": {"echo": "always"}}', 'script line 1: caps.reasoning.echo must be one of never, tool-turn, all-with-tools, got "always"'],
    ['{"reasoning": {"outptu": "reasoning"}}', 'script line 1: caps.reasoning: unknown field "outptu"'],
    ['{"samplers": {"wire": {"temperature": 3}}}', 'script line 1: caps.samplers.wire must be an object of strings, got {"temperature":3}'],
  ];
  for (const [caps, message] of bad) {
    test(`${caps} is refused`, () => {
      expect(() => parseScriptFile(`{"caps": ${caps}}\n[{"text":"Hi."}]\n`)).toThrow(message);
    });
  }

  test('valid values still parse and merge', () => {
    const f = parseScriptFile(
      '{"caps": {"contextLength": 4096, "tools": "native", "maxInFlight": 2, "toolChoice": ["auto"], "structuredOutput": {"mode": "json_schema", "confirmedBy": "user"}, "reasoning": {"output": "reasoning", "canDisable": true}, "samplers": {"accepted": ["temperature"]}}}\n[{"text":"Hi."}]\n',
    );
    const caps = scriptCapsWith(f.caps);
    expect(caps).toMatchObject({ contextLength: 4096, tools: 'native', maxInFlight: 2, toolChoice: ['auto'], structuredOutput: { mode: 'json_schema', confirmedBy: 'user' } });
    expect(caps.reasoning.output).toBe('reasoning');
    expect(caps.reasoning.canDisable).toBe(true);
    expect(f.calls).toEqual([{ steps: [{ text: 'Hi.' }] }]);
  });

  test('through the CLI: a bad value fails before anything opens', async () => {
    const h = tmpHome('rp-core-review-m3-');
    const made = await inProcess(['new', '--card', join(CARDS, 'v3-full.json'), '--no-chat'], h);
    const file = join(h, 'big.jsonl');
    writeFileSync(file, '{"caps": {"contextLength": "big"}}\n[{"text":"Hi."}]\n');
    const r = await inProcess(['send', made.stdout.trim(), 'Hi', '--provider', `script:${file}`], h);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('big.jsonl: script line 1: caps.contextLength must be an integer from 256 to 100000000, got "big"');
  });
});

describe('README examples are what rp-core prints', () => {
  const README = readFileSync(join(import.meta.dir, '../../README.md'), 'utf8');
  /** The fenced block right after the line `rp-core probe "<target>" --active` block. */
  const activeExample = (): string[] => {
    const at = README.indexOf('rp-core probe "ollama:magmell-16k:latest" --active\n```\n\n```\n');
    expect(at).toBeGreaterThan(0);
    const body = README.slice(README.indexOf('```\n\n```\n', at) + 9);
    return body.slice(0, body.indexOf('```')).split('\n');
  };

  test('the active-probe example is the shape an Ollama server without tools gives (usage asked for from the start: no usage probe)', async () => {
    // Ollama as the demo met it: /api/version, a model whose template has no tools (HTTP 400 on the
    // tools field), usage only with stream_options, json_schema enforced.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/api/version') return Response.json({ version: '0.12.6' });
        if (u.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'magmell-16k:latest', object: 'model' }] });
        if (u.pathname === '/api/ps') return Response.json({ models: [] });
        if (u.pathname === '/api/show') return Response.json({ model_info: { 'llama.context_length': 1024000 }, parameters: 'num_ctx 16384', capabilities: ['completion'] });
        if (u.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
        const b = (await req.json()) as { tools?: unknown; response_format?: unknown; stream_options?: { include_usage?: boolean } };
        if (b.tools) return Response.json({ error: { message: 'this model does not support tools' } }, { status: 400 });
        const ch = (delta: object, finish: string | null = null) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
        const tail = b.stream_options?.include_usage ? [{ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }] : [];
        const chunks = [ch({ role: 'assistant', content: b.response_format ? '{"mood":"viridian","count":1}' : 'ready' }), ch({}, 'stop'), ...tail];
        return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const h = tmpHome('rp-core-review-m3-');
      writeFileSync(join(h, 'config.toml'), `[connections.ollama]\nbase_url = "http://127.0.0.1:${server.port}"\nlocal = true\n`);
      const r = await inProcess(['probe', 'ollama:magmell-16k:latest', '--active'], h);
      expect(r.code).toBe(0);
      const ms = (l: string): string => l.replace(/\(\d+ ms\)$/, '(N ms)');
      const printed = r.stdout.split('\n').map(ms);
      const shown = activeExample()
        .map(ms)
        .filter((l) => l.trim() !== '…' && !l.startsWith('ollama  '));
      expect(shown.length).toBeGreaterThan(8);
      for (const line of shown) expect(printed).toContain(line);
      expect(shown.join('\n')).not.toContain('stream_usage');
    } finally {
      server.stop(true);
    }
  });

  test("/trace's calls line names the connection and the model, as the trace renders it", () => {
    expect(README).toContain('  calls: narrator ollama:qwen3:14b 3.1s, narrator ollama:qwen3:14b 2.4s\n');
    expect(README).not.toMatch(/calls: narrator qwen3/);
  });

  test("a note's handle in a lookup line is its /memory handle; lore handles are per answer (amended D-59)", () => {
    expect(README).toContain('in a lookup line such as `⋯ read_lore ids=C3`, `C3` is the note\nthat `/memory show C3` prints.');
    expect(README).toContain('Lorebook entries are numbered `L1`, `L2`, … for one answer only');
  });

  test('the probe costs and verdicts match the code', () => {
    expect(README).not.toContain('calls of 96 tokens');
    expect(README).toContain('A ping may write 96 tokens; the\n  tool call may write 1024 and the tool result and JSON replies 512');
    expect(README).toContain('**Each line says `ok`, `not ok` or `inconclusive`.**');
    // The cost bound: every probe's cap, plus one repeat of the largest (a repeat counts as one of the calls).
    const most = Object.values(ACTIVE_PROBE_TOKENS).reduce((n, t) => n + t, 0) + ACTIVE_PROBE_MAX_TOKENS;
    expect(Math.round(most / 100) * 100).toBe(3300);
    expect(README).toContain('A run writes at most about 3 300 tokens');
    expect(README).not.toContain('the whole run\n  is a fraction of a cent');
  });

  test("a renamed note keeps its handle and note: key, and a keyless one fires on the new title (rename-keeps-auto-key)", () => {
    expect(README).toContain('The note keeps its handle and its `note:…` key when its title changes; a note without keys then fires on the new title');
    expect(README).not.toContain('The note keeps its key when its title changes');
  });
});

describe('chat: /probe --active --write says "stored" only when something was (the real chat wiring)', () => {
  for (const [label, behave, stored] of [
    ['a server that refuses every chat call: nothing stored, nothing claimed', () => Response.json({ error: { message: 'bad key' } }, { status: 400 }), false],
    ['a native tool caller: facts stored, the note says they apply from the next chat', nativeCaller, true],
  ] as const) {
    test(
      label,
      async () => {
        mock.behave = behave;
        const h = tmpHome('rp-core-review-m3-');
        writeFileSync(join(h, 'config.toml'), `[connections.mock]\nbase_url = "${mock.base}"\nlocal = true\n`);
        const made = await inProcess(['new', '--card', join(CARDS, 'v3-full.json'), '--no-chat', '--model', 'mock:m'], h);
        expect(made.code).toBe(0);
        const p = Bun.spawn([process.execPath, MAIN, 'chat', made.stdout.trim(), '--home', h], { cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        const out = collect(p.stdout);
        try {
          p.stdin.write('/probe --active --write\n');
          await p.stdin.flush();
          await until(() => out.text().includes('active probes ('), 15_000, 'the report');
          p.stdin.write('/quit\n');
          await p.stdin.flush();
          p.stdin.end();
          expect(await p.exited).toBe(0);
          await out.done;
          expect(existsSync(join(h, 'caps-cache.json'))).toBe(stored);
          if (stored) expect(out.text()).toContain('the stored facts apply from the next rp-core chat');
          else expect(out.text()).not.toContain('stored facts apply');
        } finally {
          p.kill('SIGKILL');
        }
      },
      30_000,
    );
  }
});

describe('probe --active on Ollama: a 500 on both tries is no refusal, and no "template has no tools" hint', () => {
  test('/api/show lists tools, the runner fails on every tools request: tools inconclusive, nothing about tools stored', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/api/version') return Response.json({ version: '0.12.6' });
        if (u.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'qwen3:14b', object: 'model' }] });
        if (u.pathname === '/api/ps') return Response.json({ models: [] });
        if (u.pathname === '/api/show') return Response.json({ model_info: {}, parameters: 'num_ctx 16384', capabilities: ['completion', 'tools'] });
        if (u.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
        const b = (await req.json()) as { tools?: unknown; response_format?: unknown; stream_options?: { include_usage?: boolean } };
        if (b.tools) return Response.json({ error: { message: 'llama runner process has terminated: exit status 2' } }, { status: 500 });
        const ch = (delta: object, finish: string | null = null) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
        const tail = b.stream_options?.include_usage ? [{ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }] : [];
        const chunks = [ch({ role: 'assistant', content: b.response_format ? '{"mood":"viridian","count":1}' : 'ready' }), ch({}, 'stop'), ...tail];
        return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const h = tmpHome('rp-core-review-m3-');
      writeFileSync(join(h, 'config.toml'), `[connections.ollama]\nbase_url = "http://127.0.0.1:${server.port}"\nlocal = true\n`);
      const r = await inProcess(['probe', 'ollama:qwen3:14b', '--active', '--write'], h);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/\n {4}tools +inconclusive +the server failed or is overloaded \(HTTP 500\) on both tries/);
      expect(r.stdout).not.toContain("this model's template has no tools");
      const cache = JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, { probe?: Record<string, unknown> }>;
      expect(cache['ollama:qwen3:14b']?.probe?.['tools']).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

describe('chat: Ctrl+C stops /probe --active (the real chat wiring)', () => {
  test(
    'a probe waiting on a silent server stops at the first SIGINT; nothing stored; /quit then ends the chat',
    async () => {
      // A busy server that never answers (until the test lets go of the requests it holds).
      const held: ((r: Response) => void)[] = [];
      mock.behave = () => new Promise<Response>((resolve) => held.push(resolve));
      const h = tmpHome('rp-core-review-m3-');
      writeFileSync(join(h, 'config.toml'), `[connections.mock]\nbase_url = "${mock.base}"\nlocal = true\n`);
      const made = await inProcess(['new', '--card', join(CARDS, 'v3-full.json'), '--no-chat', '--model', 'mock:m'], h);
      expect(made.code).toBe(0);
      const p = Bun.spawn([process.execPath, MAIN, 'chat', made.stdout.trim(), '--home', h], { cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      const out = collect(p.stdout);
      try {
        p.stdin.write('/probe --active --write\n');
        await p.stdin.flush();
        await until(() => out.text().includes('Ctrl+C stops)…') && held.length > 0, 10_000, 'the probe to start');
        p.kill('SIGINT');
        await until(() => out.text().includes('(probe stopped; nothing stored)'), 10_000, 'the probe to stop');
        p.stdin.write('/quit\n');
        await p.stdin.flush();
        p.stdin.end();
        expect(await p.exited).toBe(0);
        await out.done;
        expect(out.text()).not.toContain('press Ctrl+C again');
        expect(out.text()).not.toContain('stored facts apply');
        expect(existsSync(join(h, 'caps-cache.json'))).toBe(false);
      } finally {
        p.kill('SIGKILL');
        for (const answer of held) answer(new Response('gone', { status: 503 }));
      }
    },
    30_000,
  );
});
