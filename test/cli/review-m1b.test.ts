// Review M1b fixes, run as processes against local Bun.serve mocks:
// - §13 / D-20: keys never reach events, the REPL or stderr, and the server's own words (which may
//   quote the prompt, or echo the key) are printed only with --debug, scrubbed of the key even then;
// - a key with an invisible character pasted along is refused before fetch can quote it;
// - `probe --write` during an auth failure stores nothing and exits 1;
// - a D-53 header variable that is not set fails only its own connection, not every command;
// - /model accepts a configured native connection.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from '../helpers.ts';
import { CARDS, MAIN, ROOT, script } from './kit.ts';

const T = 30_000;
const KEY = 'sk-test-SECRETKEY1234567890abcdef';
const HDR = 'hdrSECRETvalue987654';

let mode: 'echo401' | 'ok' = 'echo401';
let authOk = true;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/v1/chat/completions') {
        if (mode === 'echo401') {
          // A gateway that echoes the Authorization header, a custom header and the prompt.
          const auth = req.headers.get('authorization') ?? '';
          const h = req.headers.get('x-org-token-ref') ?? '';
          return Response.json({ error: { message: `Incorrect API key provided: ${auth} (org header ${h}); your prompt was: xxxxxxxxxx` } }, { status: 401 });
        }
        const body = [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello.' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join('');
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      // A llama.cpp-like catalog behind a key.
      if (!authOk || req.headers.get('authorization') !== `Bearer ${KEY}`) return new Response('{"error":"unauthorized"}', { status: 401 });
      if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'm1', object: 'model' }] });
      if (path === '/props') return Response.json({ default_generation_settings: { n_ctx: 16384 }, total_slots: 1 });
      return new Response('nope', { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
const base = (): string => `http://127.0.0.1:${server.port}`;

async function cli(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: ROOT,
    stdin: stdin !== undefined ? new Blob([stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

function grepTree(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) hits.push(...grepTree(f, needles));
    else for (const n of needles) if (readFileSync(f, 'utf8').includes(n)) hits.push(`${f}: ${n.slice(0, 8)}…`);
  }
  return hits;
}

async function newSession(home: string, env: Record<string, string>): Promise<string> {
  const made = await cli(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home, '--no-chat'], env);
  if (made.code !== 0) throw new Error(made.stderr);
  return made.stdout.trim();
}

describe('§13: keys and server words stay out of events and plain output', () => {
  test(
    'a 401 that echoes the key, a header and the prompt: send (text, --json) and the REPL show the fixed message only',
    async () => {
      const home = tmpHome('rp-core-review-');
      writeFileSync(
        join(home, 'config.toml'),
        `[connections.mock]\nbase_url = "${base()}"\nkey_env = "MOCK_KEY"\nheaders = { "X-Org-Token-Ref" = "MOCK_HDR" }\n[roles]\nnarrator = "mock:m1"\n`,
      );
      const env = { MOCK_KEY: KEY, MOCK_HDR: HDR };
      const id = await newSession(home, env);
      mode = 'echo401';
      const text = await cli(['send', id, 'hi', '--home', home], env);
      const json = await cli(['send', id, 'hi again', '--home', home, '--json'], env);
      const repl = await cli(['chat', id, '--home', home], env, 'one more\n/quit\n');
      const all = [text, json, repl].map((r) => r.stdout + r.stderr).join('\n');
      for (const secret of [KEY, HDR, 'your prompt was']) expect(all).not.toContain(secret);
      expect(text.stderr).toContain('the answer failed (auth/auth_failed): the server refused the API key (HTTP 401)');
      expect(text.stderr).toContain("hint: --debug prints the server's own words");
      const failed = json.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: string }).find((e) => e.type === 'failed');
      expect(failed?.message).toBe('the server refused the API key (HTTP 401)');
      expect(repl.stdout).toContain('✗ the answer failed (auth/auth_failed): the server refused the API key (HTTP 401)');
      expect(repl.stdout).toContain(`(rp-core chat ${id} --debug shows the server's own words)`);
      expect(grepTree(home, [KEY, HDR, 'your prompt was'])).toEqual([]);

      // --debug: the server's words on stderr (send) or as a dim REPL line, with the key and the header scrubbed.
      const dbg = await cli(['send', id, 'debug me', '--home', home, '--json', '--debug'], env);
      expect(dbg.stderr).toContain('rp-core: debug: mock:m1');
      expect(dbg.stderr).toContain('your prompt was');
      expect(dbg.stderr).toContain('Bearer [redacted]');
      expect(dbg.stderr).toContain('org header [redacted]');
      expect(dbg.stdout + dbg.stderr).not.toContain(KEY);
      expect(dbg.stdout + dbg.stderr).not.toContain(HDR);
      expect(dbg.stdout).not.toContain('your prompt was'); // events never carry it
      const replDbg = await cli(['chat', id, '--home', home, '--debug'], env, 'again\n/quit\n');
      expect(replDbg.stdout).toContain('debug: mock:m1');
      expect(replDbg.stdout).toContain('Bearer [redacted]');
      expect(replDbg.stdout + replDbg.stderr).not.toContain(KEY);
    },
    T,
  );

  test(
    'a key_env value with a zero-width space pasted along: key_unavailable, the key nowhere',
    async () => {
      const home = tmpHome('rp-core-review-');
      writeFileSync(join(home, 'config.toml'), `[connections.mock]\nbase_url = "${base()}"\nkey_env = "MOCK_KEY"\n[roles]\nnarrator = "mock:m1"\n`);
      const env = { MOCK_KEY: `${KEY}​` };
      const id = await newSession(home, env);
      mode = 'ok';
      const json = await cli(['send', id, 'hi', '--home', home, '--json'], env);
      const repl = await cli(['chat', id, '--home', home], env, '/r\n/quit\n');
      expect(json.code).toBe(3);
      const failed = json.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; code?: string; message?: string }).find((e) => e.type === 'failed');
      expect(failed?.code).toBe('key_unavailable');
      expect(failed?.message).toContain('environment variable MOCK_KEY (key_env) holds a character an HTTP header cannot carry');
      for (const r of [json, repl]) expect(r.stdout + r.stderr).not.toContain('SECRETKEY');
    },
    T,
  );
});

describe('probe --write and auth failures', () => {
  test(
    'all endpoints answer 401: exit 1, "not stored", the good row a working key left stays',
    async () => {
      const home = tmpHome('rp-core-review-');
      writeFileSync(join(home, 'config.toml'), `[connections.lc]\nbase_url = "${base()}"\nkey_env = "LC_KEY"\n`);
      authOk = true;
      const good = await cli(['probe', 'lc:m1', '--write', '--home', home], { LC_KEY: KEY });
      expect(good.code).toBe(0);
      expect(good.stdout).toContain('stored in');
      const before = readFileSync(join(home, 'caps-cache.json'), 'utf8');
      // M3: the catalog's facts are the row's catalog part (active-probe facts go to its probe part).
      expect(JSON.parse(before)['lc:m1']).toMatchObject({ server: 'llama.cpp', catalog: { contextLength: 16384 } });

      const bad = await cli(['probe', 'lc:m1', '--write', '--home', home], {}); // LC_KEY not exported
      expect(bad.code).toBe(1);
      expect(bad.stdout).toContain('refused the key');
      expect(bad.stdout).toContain('not stored: the server refused the key');
      expect(bad.stdout).not.toContain('stored in');
      expect(readFileSync(join(home, 'caps-cache.json'), 'utf8')).toBe(before);

      const json = JSON.parse((await cli(['probe', 'lc', '--write', '--json', '--home', home], {})).stdout) as { ok: boolean; written: boolean; error: string }[];
      expect(json[0]).toMatchObject({ ok: false, written: false });
      expect(json[0]!.error).toStartWith('auth_failed');
      expect(readFileSync(join(home, 'caps-cache.json'), 'utf8')).toBe(before);
    },
    T,
  );
});

describe('config: one connection\'s problem is not every command\'s', () => {
  test(
    'an unset D-53 header variable: chat --provider script and probe of another connection still work; that connection fails precisely',
    async () => {
      const home = tmpHome('rp-core-review-');
      writeFileSync(
        join(home, 'config.toml'),
        `[connections.lc]\nbase_url = "${base()}"\nkey_env = "LC_KEY"\n[connections.openrouter]\nbase_url = "${base()}"\nheaders = { "X-Title" = "RP_CORE_APP_TITLE" }\n[roles]\nnarrator = "openrouter:m1"\n`,
      );
      authOk = true;
      const id = await newSession(home, {});
      const chat = await cli(['chat', id, '--home', home, '--provider', script('reply.jsonl')], {}, '/quit\n');
      expect(chat.code).toBe(0);
      expect(chat.stderr).not.toContain('config error');
      expect((await cli(['probe', 'lc', '--home', home], { LC_KEY: KEY })).code).toBe(0);
      mode = 'ok';
      const send = await cli(['send', id, 'hi', '--home', home, '--json'], {});
      expect(send.code).toBe(3);
      const failed = send.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; code?: string; message?: string }).find((e) => e.type === 'failed');
      expect(failed).toMatchObject({ code: 'key_unavailable', message: "connection 'openrouter': header X-Title: environment variable RP_CORE_APP_TITLE is not set" });
    },
    T,
  );

  test(
    '/model accepts a configured native Gemini connection',
    async () => {
      const home = tmpHome('rp-core-review-');
      writeFileSync(join(home, 'config.toml'), `[connections.mock]\nbase_url = "${base()}"\n[connections.gemini]\ndialect = "gemini"\nkey_env = "X"\n[roles]\nnarrator = "mock:m1"\n`);
      const id = await newSession(home, {});
      const r = await cli(['chat', id, '--home', home], {}, '/model gemini:flash\n/model\n/quit\n');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('gemini:flash');
      expect(r.stdout).not.toContain('cannot be used');
    },
    T,
  );
});
