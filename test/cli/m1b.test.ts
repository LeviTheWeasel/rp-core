// M1b CLI wiring, run as processes: init, config.toml errors, new with config defaults and --model
// checks, chat on piped stdin, send / chat against a local openai-chat mock server configured in
// config.toml, probe / models against a mock Ollama, and the probe cache feeding later turns.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_TEMPLATE } from '../../src/config/config.ts';
import type { MessageView } from '../../src/session/view.ts';
import { tmpHome } from '../helpers.ts';
import { CARDS, jsonl, run, script } from './kit.ts';

const T = 30_000;

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

interface Seen {
  method: string;
  path: string;
  body: string;
}

/** A local server: `routes` keyed "METHOD /path"; anything else 404. */
function mock(routes: Record<string, (body: string) => Response>): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.text();
      seen.push({ method: req.method, path: u.pathname, body });
      const route = routes[`${req.method} ${u.pathname}`];
      return route ? route(body) : new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

/** An OpenAI-style SSE answer in `pieces`, then finish, usage and [DONE]. */
function sse(pieces: readonly string[], usage = { prompt_tokens: 120, completion_tokens: 9 }): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const lines = [
    ...pieces.map((p, i) => chunk(i === 0 ? { role: 'assistant', content: p } : { content: p }, null)),
    chunk({}, 'stop'),
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

/** An openai-chat server that answers each chat call with the next of `answers` (the last repeats). */
function chatServer(answers: readonly (readonly string[])[]): { base: string; seen: Seen[]; bodies: () => Record<string, unknown>[] } {
  let n = 0;
  const answer = (): Response => sse(answers[Math.min(n++, answers.length - 1)]!);
  const m = mock({
    'POST /v1/chat/completions': answer,
    'POST /chat/completions': answer,
    'GET /v1/models': () => Response.json({ object: 'list', data: [{ id: 'm', object: 'model', owned_by: 'me' }] }),
  });
  const bodies = (): Record<string, unknown>[] => m.seen.filter((s) => s.path.endsWith('/chat/completions')).map((s) => JSON.parse(s.body) as Record<string, unknown>);
  return { ...m, bodies };
}

/** A mock Ollama: /v1/models, /api/version, /api/ps (one loaded model), /api/show. */
function ollamaServer(): { base: string; seen: Seen[] } {
  const show: Record<string, unknown> = {
    'loaded:latest': { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, parameters: '' },
    'cold:latest': { capabilities: ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 1024000 }, parameters: '' },
  };
  return mock({
    'GET /v1/models': () => Response.json({ object: 'list', data: Object.keys(show).map((id) => ({ id, object: 'model', owned_by: 'library' })) }),
    'GET /api/version': () => Response.json({ version: '0.12.0' }),
    'GET /api/ps': () => Response.json({ models: [{ name: 'loaded:latest', model: 'loaded:latest', context_length: 16384 }] }),
    'POST /api/show': (body) => {
      const name = (JSON.parse(body) as { model: string }).model;
      return name in show ? Response.json(show[name]) : Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

async function newSessionWith(home: string, ...args: string[]): Promise<string> {
  const r = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home, ...args]);
  if (r.code !== 0) throw new Error(`new failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

function header(home: string, id: string): { config: { roles: { narrator: Record<string, unknown> }; narrator: { maxRounds: number } } } {
  return JSON.parse(readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8').split('\n')[0]!);
}

async function showPath(home: string, id: string): Promise<MessageView[]> {
  const r = await run(['show', id, '--json', '--home', home]);
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as MessageView[];
}

const textOf = (m: MessageView): string => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');

describe('init', () => {
  test(
    'writes the starter config once, prints its path, never overwrites',
    async () => {
      const home = join(tmpHome('rp-core-m1b-'), 'fresh-home');
      const r = await run(['init', '--home', home]);
      expect(r.code).toBe(0);
      const path = join(home, 'config.toml');
      expect(r.stdout).toBe(`${path}\n`);
      expect(r.stderr).toContain('wrote a starter config');
      expect(readFileSync(path, 'utf8')).toBe(CONFIG_TEMPLATE);

      writeFileSync(path, '# mine\n');
      const again = await run(['init', '--home', home, '--json']);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.stdout)).toEqual({ path, created: false });
      expect(readFileSync(path, 'utf8')).toBe('# mine\n');
    },
    T,
  );

  test(
    'the template parses: new takes its [roles] narrator and [narrator] defaults',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      expect((await run(['init', '--home', home])).code).toBe(0);
      const id = await newSessionWith(home);
      const h = header(home, id);
      expect(h.config.roles.narrator).toMatchObject({ conn: 'ollama', model: 'qwen3:14b' });
      expect(h.config.narrator.maxRounds).toBe(4);
    },
    T,
  );
});

describe('config.toml errors', () => {
  test(
    'a bad config is exit 64 with the file and the key path, for every command that reads it',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), '[connections.local]\nbase_url = "http://127.0.0.1:8080"\napi_key = "sk-nope"\n');
      for (const args of [
        ['new', '--card', join(CARDS, 'v3-full.json')],
        ['send', 's_00000000', 'hi'],
        ['chat', 's_00000000'],
        ['probe'],
        ['models', 'local'],
      ]) {
        const r = await run([...args, '--home', home]);
        expect(r.code).toBe(64);
        expect(r.stderr).toContain(`config error in ${join(home, 'config.toml')}: connections.local.api_key`);
      }
      writeFileSync(join(home, 'config.toml'), '[roles]\nnarrator = "nowhere:m"\n');
      const r = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home]);
      expect(r.code).toBe(64);
      expect(r.stderr).toContain('roles.narrator');
    },
    T,
  );
});

describe('new', () => {
  test(
    '--model overrides the narrator, --max-tokens sets its limit; --provider lifts the connection check',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), '[connections.a]\nbase_url = "http://127.0.0.1:9"\n[roles]\nnarrator = "a:one"\nnarrator_fallback = "a:two"\n');
      const id = await newSessionWith(home, '--model', 'a:three', '--max-tokens', '150', '--no-chat');
      // The fallback from [roles] survives the --model override.
      expect(header(home, id).config.roles.narrator).toEqual({ conn: 'a', model: 'three', maxTokens: 150, fallback: { conn: 'a', model: 'two' } });

      const bad = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home, '--model', 'b:x']);
      expect(bad.code).toBe(64);
      expect(bad.stderr).toContain('no connection "b"');
      expect(bad.stderr).toContain('known: a');
      expect((await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home, '--max-tokens', '0'])).code).toBe(64);
      const scripted = await newSessionWith(home, '--model', 'b:x', '--provider', script('reply.jsonl'));
      expect(header(home, scripted).config.roles.narrator).toMatchObject({ conn: 'b', model: 'x' });
    },
    T,
  );

  test(
    'a connection of a later dialect is named as such',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), '[connections.claude]\ndialect = "anthropic"\nkey_env = "X"\n');
      const r = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home, '--model', 'claude:sonnet']);
      expect(r.code).toBe(64);
      expect(r.stderr).toContain('connection "claude" cannot be used');
      expect(r.stderr).toContain('M7');
    },
    T,
  );
});

describe('chat on piped stdin', () => {
  test(
    'with --provider: lines run in order, /quit ends with 0, the lock is released',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      const id = await newSessionWith(home);
      const r = await run(['chat', id, '--home', home, '--provider', script('reply.jsonl')], { stdin: 'Hi Alice\n/show\n/quit\n' });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`session ${id}`);
      expect(r.stdout).toContain('Hello there, traveller.');
      expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(false);
      const path = await showPath(home, id);
      expect(path.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    },
    T,
  );

  test(
    'an unknown session is refused with exit 5; a missing argument is a usage error',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      const r = await run(['chat', 's_deadbeef', '--home', home], { stdin: '' });
      expect(r.code).toBe(5);
      expect(r.stderr).toContain('session_not_found');
      expect((await run(['chat', '--home', home])).code).toBe(64);
    },
    T,
  );
});

describe('a configured openai-chat connection', () => {
  test(
    'send without --provider streams from the server; max_tokens and the price table apply',
    async () => {
      const srv = chatServer([['*Alice ', 'waves.*'], ['A second ', 'take.']]);
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(
        join(home, 'config.toml'),
        `[connections.mock]\nbase_url = "${srv.base}"\n[prices."mock:m"]\nin_per_m = 1.0\nout_per_m = 2.0\nas_of = "2026-10-26"\n`,
      );
      const id = await newSessionWith(home, '--model', 'mock:m', '--max-tokens', '64', '--no-chat');
      const r = await run(['send', id, 'Hello', '--home', home]);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('*Alice waves.*\n');
      const body = srv.bodies()[0]!;
      expect(body.model).toBe('m');
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(64);

      const j = await run(['send', id, '--kind', 'swipe', '--json', '--home', home]);
      expect(j.code).toBe(0);
      const usage = jsonl(j.stdout).find((e) => e.type === 'usage') as { costUsd?: number | null; priceSource?: string; model?: string } | undefined;
      expect(usage).toBeDefined();
      expect(usage!.model).toBe('mock:m');
      // 120 in at 1/M + 9 out at 2/M, from the [prices] table
      expect(usage!.costUsd).toBeCloseTo((120 * 1 + 9 * 2) / 1e6, 12);
      expect(usage!.priceSource).toBeDefined();
      const path = await showPath(home, id);
      expect(textOf(path.at(-1)!)).toBe('A second take.');
      expect(path.at(-1)!.gen).toMatchObject({ connection: 'mock', model: 'm' });
    },
    T,
  );

  test(
    'chat: a message, /r, /usage and /quit against the server',
    async () => {
      const srv = chatServer([['First ', 'answer.'], ['Second ', 'answer.']]);
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), `[connections.mock]\nbase_url = "${srv.base}"\n[roles]\nnarrator = "mock:m"\n`);
      const id = await newSessionWith(home);
      const r = await run(['chat', id, '--home', home], { stdin: 'Привет\n/r\n/usage\n/quit\n' });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('First answer.');
      expect(r.stdout).toContain('Second answer.');
      expect(r.stdout).toContain('mock:m');
      expect(srv.bodies()).toHaveLength(2);
      // The card's post-history instructions follow the user's line in the same message.
      const last = (srv.bodies()[0]!.messages as { role: string; content: string }[]).at(-1)!;
      expect(last.role).toBe('user');
      expect(last.content.startsWith('Привет')).toBe(true);
    },
    T,
  );

  test(
    'a binding on a connection config.toml does not have: no_connection with the hint',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), '[connections.claude]\ndialect = "anthropic"\nkey_env = "X"\n');
      const id = await newSessionWith(home, '--model', 'gone:m', '--provider', script('reply.jsonl'));
      const r = await run(['send', id, 'Hi', '--home', home]);
      expect(r.code).toBe(5);
      expect(r.stderr).toContain('refused (no_connection)');
      expect(r.stderr).toContain('connection "claude" in config.toml is skipped');
    },
    T,
  );
});

describe('probe and models', () => {
  test(
    'probe conn:model prints the server kind, windows and caps; --write stores the rows that later resolve as probe',
    async () => {
      const srv = ollamaServer();
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), `[connections.ol]\nbase_url = "${srv.base}"\n`);

      const r = await run(['probe', 'ol:loaded:latest', '--home', home]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('server: ollama');
      expect(r.stdout).toMatch(/loaded:latest\s+ctx 16384/);
      expect(r.stdout).toContain('caps of ol:loaded:latest (with this probe stored)');
      expect(r.stdout).toContain('context 16384');
      expect(r.stdout).toContain('tools native');
      expect(r.stdout).toContain('not stored');
      expect(existsSync(join(home, 'caps-cache.json'))).toBe(false);

      const w = await run(['probe', 'ol', '--write', '--json', '--home', home]);
      expect(w.code).toBe(0);
      const out = JSON.parse(w.stdout) as { connection: string; ok: boolean; server: string; models: { id: string; contextLength?: number }[]; notes: string[]; written: boolean }[];
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ connection: 'ol', ok: true, server: 'ollama', written: true });
      expect(out[0]!.models).toEqual([{ id: 'cold:latest' }, { id: 'loaded:latest', contextLength: 16384 }]);
      expect(out[0]!.notes.some((n) => n.includes('trained 1024000'))).toBe(true);
      const cache = JSON.parse(readFileSync(join(home, 'caps-cache.json'), 'utf8')) as Record<string, { as_of: string; server: string; caps: Record<string, unknown> }>;
      expect(Object.keys(cache)).toEqual(['ol:cold:latest', 'ol:loaded:latest']);
      expect(cache['ol:loaded:latest']).toMatchObject({ server: 'ollama', caps: { contextLength: 16384, tools: 'native' } });
      expect(cache['ol:loaded:latest']!.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // The stored rows are the probe source of the caps from now on.
      const again = await run(['probe', 'ol:loaded:latest', '--json', '--home', home]);
      const caps = (JSON.parse(again.stdout) as { caps: { source: string[]; contextLength: number } }[])[0]!.caps;
      expect(caps.source).toContain('probe');
      expect(caps.contextLength).toBe(16384);
    },
    T,
  );

  test(
    'models lists the ids; an unreachable server is exit 1 for probe and models',
    async () => {
      const srv = ollamaServer();
      const home = tmpHome('rp-core-m1b-');
      writeFileSync(join(home, 'config.toml'), `[connections.ol]\nbase_url = "${srv.base}"\n[connections.down]\nbase_url = "http://127.0.0.1:9"\n`);
      const m = await run(['models', 'ol', '--home', home]);
      expect(m.code).toBe(0);
      expect(m.stdout).toBe('cold:latest\nloaded:latest\n');
      expect(JSON.parse((await run(['models', 'ol', '--json', '--home', home])).stdout)).toEqual([{ id: 'cold:latest' }, { id: 'loaded:latest' }]);
      // models only walks the /models ladder.
      expect(srv.seen.every((s) => s.path.endsWith('/models'))).toBe(true);

      const down = await run(['models', 'down', '--home', home]);
      expect(down.code).toBe(1);
      expect(down.stderr).toContain('unreachable');
      const all = await run(['probe', '--home', home]);
      expect(all.code).toBe(1);
      expect(all.stdout).toContain('ol  ');
      expect(all.stdout).toContain('server: ollama');
      expect(all.stdout).toContain('down  http://127.0.0.1:9  unreachable');
      expect((await run(['models', 'nope', '--home', home])).code).toBe(64);
    },
    T,
  );
});

describe('chat: /e through $EDITOR', () => {
  test(
    '$EDITOR is a shell snippet (as in git): `sh -c "…" sh` edits the file it is given',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      const id = await newSessionWith(home);
      const p = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts'), 'chat', id, '--home', home, '--provider', script('reply.jsonl')], {
        stdin: new Blob(['Hi\n/e\n/quit\n']),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, VISUAL: '', EDITOR: 'sh -c "echo edited >> \\$1" sh' },
      });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(code).toBe(0);
      expect(out).toContain('edited message 3');
      const path = await showPath(home, id);
      expect(textOf(path.at(-1)!)).toBe('Hello there, traveller.\nedited');
      expect(path.at(-1)!.edited).toBe(true);
    },
    T,
  );
});

describe('chat: SIGTERM', () => {
  test(
    'SIGTERM mid-answer closes the session with the partial answer kept, exit 143, no lock left',
    async () => {
      const home = tmpHome('rp-core-m1b-');
      const id = await newSessionWith(home);
      const p = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts'), 'chat', id, '--home', home, '--provider', script('slow.jsonl')], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      p.stdin.write('Hi\n');
      p.stdin.flush();
      let out = '';
      const dec = new TextDecoder();
      void (async () => {
        for await (const c of p.stdout as ReadableStream<Uint8Array>) out += dec.decode(c, { stream: true });
      })();
      const deadline = performance.now() + 10_000;
      while (!out.includes('step3')) {
        if (performance.now() > deadline) throw new Error(`no answer: ${out}`);
        await Bun.sleep(20);
      }
      p.kill('SIGTERM');
      expect(await p.exited).toBe(143);
      expect(await new Response(p.stderr).text()).toContain('terminated: closing the session');
      expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(false);
      const last = (await showPath(home, id)).at(-1)!;
      expect(last.role).toBe('assistant');
      expect(textOf(last)).toStartWith('step1 step2 step3');
    },
    T,
  );
});
