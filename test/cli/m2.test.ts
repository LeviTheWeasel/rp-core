// M2 CLI wiring, run as processes: import of every kind, new --preset / --lore, the preview command,
// and --provider record:/replay: against a local openai-chat mock configured in config.toml
// (§12.3, §14, §15 M2, D-45, D-72).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewResult } from '../../src/engine/api.ts';
import type { RecordedCall } from '../../src/providers/record.ts';
import { tmpHome } from '../helpers.ts';
import { CARDS, ROOT, run, script } from './kit.ts';

const T = 30_000;
const FIXTURES = join(ROOT, 'test', 'fixtures', 'cli-m2');
const PRESET = join(FIXTURES, 'Lighthouse.json');
const HARBOR = join(FIXTURES, 'Harbor.json');
const CARD = join(CARDS, 'v3-full.json');

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

function header(home: string, id: string): { config: { preset: string; lorebooks: string[] } } {
  return JSON.parse(readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8').split('\n')[0]!);
}

async function newSession(home: string, ...args: string[]): Promise<string> {
  const r = await run(['new', '--card', CARD, '--home', home, '--no-chat', ...args]);
  if (r.code !== 0) throw new Error(`new failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

describe('import', () => {
  test(
    'every kind lands in its library folder; text mode prints the id and how to use it',
    async () => {
      const home = tmpHome('rp-core-m2-');
      const preset = await run(['import', PRESET, '--json', '--home', home]);
      expect(preset.code).toBe(0);
      const p = JSON.parse(preset.stdout) as { kind: string; id: string; path: string; name: string; warnings: { path: string }[] };
      expect(p).toMatchObject({ kind: 'preset', id: 'lighthouse', name: 'Lighthouse', path: join(home, 'library', 'presets', 'lighthouse.json') });
      expect(p.warnings.map((w) => w.path)).toEqual(['squash_system_messages']);

      const book = await run(['import', HARBOR, '--home', home]);
      expect(book.code).toBe(0);
      expect(book.stdout).toBe('harbor\n');
      expect(book.stderr).toContain(`imported lorebook "Harbor" as ${join(home, 'library', 'lorebooks', 'harbor.json')}`);
      expect(book.stderr).toContain('hint: /lore add harbor in the chat, or rp-core new --lore harbor');

      const card = await run(['import', CARD, '--json', '--home', home]);
      expect(JSON.parse(card.stdout)).toMatchObject({ kind: 'character', id: 'alice' });

      const as = await run(['import', HARBOR, '--as', 'Old Harbor', '--json', '--home', home]);
      const a = JSON.parse(as.stdout) as { id: string; path: string };
      expect(a.id).not.toBe('harbor');
      expect(existsSync(a.path)).toBe(true);

      const bad = await run(['import', join(ROOT, 'README.md'), '--home', home]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('import failed: README.md: neither a PNG nor JSON');
    },
    T,
  );
});

describe('new --preset / --lore', () => {
  test(
    'files are imported, ids are taken from the library, books deduplicated in order',
    async () => {
      const home = tmpHome('rp-core-m2-');
      const r = await run(['new', '--card', CARD, '--home', home, '--no-chat', '--preset', PRESET, '--lore', HARBOR, '--lore', 'harbor', '--lore', CARD]);
      expect(r.code).toBe(0);
      const id = r.stdout.trim();
      expect(r.stderr).toContain(`imported ${PRESET} as`);
      expect(r.stderr).toContain('preset lighthouse; lorebooks harbor, alice');
      expect(header(home, id).config).toMatchObject({ preset: 'lighthouse', lorebooks: ['harbor', 'alice'] });

      const again = await newSession(home, '--preset', 'lighthouse', '--lore', 'harbor');
      expect(header(home, again).config).toMatchObject({ preset: 'lighthouse', lorebooks: ['harbor'] });
      const builtin = await newSession(home, '--preset', 'builtin');
      expect(header(home, builtin).config.preset).toBe('builtin');
    },
    T,
  );

  test(
    'a wrong kind or an unknown id fails before the session exists',
    async () => {
      const home = tmpHome('rp-core-m2-');
      const wrong = await run(['new', '--card', CARD, '--home', home, '--no-chat', '--preset', HARBOR]);
      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain('--preset: cannot import');
      expect(wrong.stderr).toContain('expected a preset');
      const unknown = await run(['new', '--card', CARD, '--home', home, '--no-chat', '--lore', 'atlantis']);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('--lore: no file and no library lorebook named "atlantis"');
      const sessions = await run(['sessions', '--json', '--home', home]);
      expect(JSON.parse(sessions.stdout)).toEqual([]);
    },
    T,
  );
});

describe('preview', () => {
  test(
    'a draft: the exact messages in text, the PreviewResult in JSON, verdicts on request; nothing is written',
    async () => {
      const home = tmpHome('rp-core-m2-');
      const id = await newSession(home, '--preset', PRESET, '--lore', HARBOR);
      const before = readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8');
      const sc = script('reply.jsonl');

      const text = await run(['preview', id, '--draft', 'Is the lighthouse lit?', '--home', home, '--provider', sc]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('preview of a reply to your draft · script:default');
      expect(text.stdout).toContain('#1 system · main · ');
      expect(text.stdout).toContain('You are Alice, a brave and curious adventurer');
      expect(text.stdout).toContain('The Gull Point lighthouse has been dark for nine years.');
      expect(text.stdout).toContain('Is the lighthouse lit?');
      expect(text.stdout).not.toContain('lore verdicts:');

      const json = await run(['preview', id, '--draft', 'Is the lighthouse lit?', '--verdicts', '--json', '--home', home, '--provider', sc]);
      expect(json.code).toBe(0);
      const r = JSON.parse(json.stdout) as Extract<PreviewResult, { ok: true }>;
      expect(r.ok).toBe(true);
      expect(r).toMatchObject({ kind: 'reply', upTo: 'draft', model: { connection: 'script', model: 'default' } });
      expect(r.messages.map((m) => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join(''))).toContain('Is the lighthouse lit?');
      expect(r.verdicts?.find((v) => v.book === 'harbor' && v.id === '0')).toMatchObject({ fired: true, why: 'key', matched: ['lighthouse'] });
      expect(r.trace.lore.fired).toContainEqual({ book: 'harbor', id: '0', why: 'key' });

      const verdicts = await run(['preview', id, '--draft', 'fog', '--verdicts', '--home', home, '--provider', sc]);
      expect(verdicts.stdout).toContain('lore verdicts:\n');
      expect(verdicts.stdout).toContain('  ✓ "Evening fog" harbor:1 · key · keys: fog');

      // No turn, no message, no config: the journal is as it was.
      expect(readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8')).toBe(before);
    },
    T,
  );

  test(
    'a past answer by --turn prefix; refusals exit 5; --wire on a script prints the messages',
    async () => {
      const home = tmpHome('rp-core-m2-');
      const id = await newSession(home, '--lore', HARBOR);
      const sc = script('reply.jsonl');
      // A fresh session ends on a greeting: nothing to build without a draft.
      const nothing = await run(['preview', id, '--home', home, '--provider', sc]);
      expect(nothing.code).toBe(5);
      expect(nothing.stderr).toContain('preview refused [nothing_to_swipe]');
      expect(nothing.stderr).toContain('use --draft "text" to preview a reply');
      expect(nothing.stderr).toContain('{"type":"refusal","code":"nothing_to_swipe"');

      const sent = await run(['send', id, 'The lighthouse, please.', '--json', '--home', home, '--provider', sc]);
      expect(sent.code).toBe(0);
      const show = await run(['show', id, '--json', '--home', home]);
      const path = JSON.parse(show.stdout) as { id: string; role: string }[];
      const answer = path.at(-1)!;
      expect(answer.role).toBe('assistant');

      const past = await run(['preview', id, '--turn', answer.id.slice(0, 5), '--json', '--home', home, '--provider', sc]);
      expect(past.code).toBe(0);
      const r = JSON.parse(past.stdout) as Extract<PreviewResult, { ok: true }>;
      expect(r).toMatchObject({ ok: true, kind: 'reply', upTo: path.at(-2)!.id });
      expect(r.trace.lore.fired).toContainEqual({ book: 'harbor', id: '0', why: 'key' });

      const next = await run(['preview', id, '--wire', '--home', home, '--provider', sc]);
      expect(next.code).toBe(0);
      expect(next.stderr).toContain('no wire form');
      expect(next.stdout).toContain(`preview of a swipe (a new answer to ${path.at(-2)!.id})`);

      // A prefix that names no message is a preview that cannot be built: exit 5 with the refusal line.
      const missing = await run(['preview', id, '--turn', 'ffffffff', '--home', home, '--provider', sc]);
      expect(missing.code).toBe(5);
      expect(missing.stderr).toContain('--turn: no message');
      expect(missing.stderr.trim().split('\n').at(-1)).toBe(JSON.stringify({ type: 'refusal', code: 'not_found', message: '--turn: no message starts with "ffffffff"' }));

      const gone = await run(['preview', 's_nope', '--home', home, '--provider', sc]);
      expect(gone.code).toBe(5);
      expect(gone.stderr).toContain('"code":"session_not_found"');
    },
    T,
  );
});

// ---- record / replay --------------------------------------------------------------------------------

interface Seen {
  path: string;
  body: string;
  auth: string | null;
}

/** An OpenAI-style SSE answer in `pieces`, then finish, usage and [DONE]. */
function sse(pieces: readonly string[]): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const lines = [
    ...pieces.map((p, i) => chunk(i === 0 ? { role: 'assistant', content: p } : { content: p }, null)),
    chunk({}, 'stop'),
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const KEY = 'sk-rec-secret-0123456789';
const ORG = 'org-hdr-secret-abcdef';

/** A chat server whose answer echoes the key and the header value it was sent (a careless proxy). */
function chatServer(): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.text();
      seen.push({ path: u.pathname, body, auth: req.headers.get('authorization') });
      if (!u.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const org = req.headers.get('x-org') ?? '';
      return sse(['The lamp ', 'is lit. ', `(${req.headers.get('authorization') ?? ''} ${org})`]);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

function configure(home: string, base: string): void {
  writeFileSync(join(home, 'config.toml'), `[connections.mock]\nbase_url = "${base}"\nkey_env = "RP_TEST_KEY"\nheaders = { "X-Org" = "RP_TEST_ORG" }\n`);
}

const ENV = { RP_TEST_KEY: KEY, RP_TEST_ORG: ORG };

/** A chat server that answers each call with a fixed text by its turn number (no secret echoed). */
function plainServer(): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({ path: u.pathname, body: await req.text(), auth: req.headers.get('authorization') });
      if (!u.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      return sse(['The lamp ', `is lit (${seen.length}).`]);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}
const chats = (s: { seen: Seen[] }): Seen[] => s.seen.filter((x) => x.path.endsWith('/chat/completions'));

describe('--provider record: / replay:', () => {
  test(
    'record wraps the config connection: one scrubbed line per call; replay plays it back without the network',
    async () => {
      const srv = chatServer();
      const home = tmpHome('rp-core-m2-');
      configure(home, srv.base);
      const file = join(home, 'calls.jsonl');
      const a = await newSession(home, '--model', 'mock:m', '--lore', HARBOR);

      const rec = await run(['send', a, 'Is the lighthouse lit?', '--home', home, '--provider', `record:${file}`], { env: ENV });
      expect(rec.code).toBe(0);
      expect(rec.stdout).toContain('The lamp is lit.');
      expect(chats(srv)).toHaveLength(1);
      expect(chats(srv)[0]!.auth).toBe(`Bearer ${KEY}`);

      const text = readFileSync(file, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(ORG);
      const lines = text.trim().split('\n');
      expect(lines).toHaveLength(1);
      const call = JSON.parse(lines[0]!) as RecordedCall;
      expect(call.model).toEqual({ connection: 'mock', model: 'm' });
      expect(call.raw).toContain('data: ');
      expect(JSON.stringify(call.events)).toContain('[redacted]');
      expect(JSON.stringify(call.request)).toContain('The Gull Point lighthouse has been dark for nine years.');
      // The recorded turn is an ordinary turn on the real connection.
      const shown = await run(['show', a, '--json', '--home', home]);
      expect(shown.stdout).toContain('"connection":"mock"');

      // Replay: a fresh session from the same card, same model and books, the same message.
      const b = await newSession(home, '--model', 'mock:m', '--lore', 'harbor');
      const rep = await run(['send', b, 'Is the lighthouse lit?', '--home', home, '--provider', `replay:${file}`], { env: ENV });
      expect(rep.code).toBe(0);
      expect(rep.stdout).toContain('The lamp is lit.');
      expect(rep.stdout).toContain('[redacted]');
      expect(chats(srv)).toHaveLength(1);

      // A different request fails loudly, with the diff.
      const c = await newSession(home, '--model', 'mock:m', '--lore', 'harbor');
      const off = await run(['send', c, 'Is the beacon lit?', '--home', home, '--provider', `replay:${file}`]);
      expect(off.code).toBe(3);
      expect(off.stderr).toContain('replay_mismatch');
      expect(off.stderr).toContain('the request differs from the recorded one');
      expect(off.stderr).toContain('recorded');
      expect(off.stderr).not.toContain("--debug prints the server's own words");
      expect(chats(srv)).toHaveLength(1);
    },
    T,
  );

  test(
    'preview --wire shows the HTTP body of the configured connection (also under record:, which records nothing)',
    async () => {
      const srv = chatServer();
      const home = tmpHome('rp-core-m2-');
      configure(home, srv.base);
      const id = await newSession(home, '--model', 'mock:m');
      const file = join(home, 'calls.jsonl');
      const r = await run(['preview', id, '--draft', 'Hello', '--wire', '--home', home, '--provider', `record:${file}`], { env: ENV });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(`rp-core: POST ${srv.base}/v1/chat/completions`);
      const body = JSON.parse(r.stdout) as { model: string; stream: boolean; messages: { role: string; content: string }[] };
      expect(body.model).toBe('m');
      expect(body.messages.at(-1)!.role).toBe('user');
      expect(body.messages.at(-1)!.content).toStartWith('Hello');
      expect(r.stdout).not.toContain(KEY);
      expect(readFileSync(file, 'utf8')).toBe('');
      expect(chats(srv)).toHaveLength(0);
    },
    T,
  );

  test(
    'a piped chat replay exits 3 when a request differs or the recording runs out, and stops at the first mismatch',
    async () => {
      // Regression: the piped REPL exited 0 whatever happened to its turns, so CI could not see a
      // replay_mismatch (README: replaying more than one answer means a piped chat).
      const srv = plainServer();
      const home = tmpHome('rp-core-m2-');
      configure(home, srv.base);
      const file = join(home, 'calls.jsonl');
      const a = await newSession(home, '--model', 'mock:m');
      const rec = await run(['chat', a, '--home', home, '--provider', `record:${file}`], { env: ENV, stdin: 'Hello\nIs the lamp lit?\n' });
      expect(rec.code).toBe(0);
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);

      const same = await run(['chat', await newSession(home, '--model', 'mock:m'), '--home', home, '--provider', `replay:${file}`], { env: ENV, stdin: 'Hello\nIs the lamp lit?\n' });
      expect(same.code).toBe(0);

      const changed = await run(['chat', await newSession(home, '--model', 'mock:m'), '--home', home, '--provider', `replay:${file}`], {
        env: ENV,
        stdin: 'Hello\nIs the beacon lit?\nAnd now?\n',
      });
      expect(changed.code).toBe(3);
      expect(changed.stdout).toContain('replay_mismatch');
      expect(changed.stdout).toContain('recorded call 2 of 2');
      // stopped at the mismatch: the third line was not run (it would have exhausted the recording)
      expect(changed.stdout).not.toContain('script_exhausted');
      expect(changed.stdout).toContain('(stopped: the recording no longer matches this chat (replay_mismatch); the rest of the input is not run)');

      const longer = await run(['chat', await newSession(home, '--model', 'mock:m'), '--home', home, '--provider', `replay:${file}`], {
        env: ENV,
        stdin: 'Hello\nIs the lamp lit?\nAnd now?\n',
      });
      expect(longer.code).toBe(3);
      expect(longer.stdout).toContain('script_exhausted');
      // Worded as what ran out: the recording, not the script, and not a mismatch.
      expect(longer.stdout).toContain('the recording ran out of calls: request 3 has no recorded call left');
      expect(longer.stdout).not.toContain('the script ran out of calls');
      expect(chats(srv)).toHaveLength(2);
    },
    T,
  );

  test(
    'a replay on another model, or without the recorded connection in config.toml, says so in the mismatch',
    async () => {
      // Regression: the replay silently fell back to generic caps and the diff blamed prompt text.
      const srv = plainServer();
      const home = tmpHome('rp-core-m2-');
      configure(home, srv.base);
      const file = join(home, 'calls.jsonl');
      const a = await newSession(home, '--model', 'mock:small-model');
      expect((await run(['send', a, 'Hello', '--home', home, '--provider', `record:${file}`], { env: ENV })).code).toBe(0);

      const other = await run(['send', await newSession(home, '--model', 'mock:huge-model'), 'Hello', '--home', home, '--provider', `replay:${file}`], { env: ENV });
      // v3-full's post-history text is merged into the user message by the recorded caps, not by the
      // generic ones: the diff shows that, and now also says why.
      expect(other.code).toBe(3);
      expect(other.stderr).toContain('model: mock:small-model recorded, huge-model actual');
      expect(other.stderr).toContain('note: the recording was made on mock:small-model; this session asks for huge-model');

      // A fresh home without config.toml: the recorded connection is unknown here.
      const bare = tmpHome('rp-core-m2-');
      const b = await newSession(bare, '--model', 'mock:small-model', '--provider', `replay:${file}`);
      const lost = await run(['send', b, 'Hello', '--home', bare, '--provider', `replay:${file}`]);
      expect(lost.code).toBe(3);
      expect(lost.stderr).toContain('note: the recording was made on mock:small-model, and config.toml has no connection "mock"');
    },
    T,
  );

  test(
    'a call stopped while recording replays its text and fails at once outside an interactive chat',
    async () => {
      // Regression: it held until the engine's own timeout (120 s idle, 600 s first byte).
      const srv = plainServer();
      const home = tmpHome('rp-core-m2-');
      configure(home, srv.base);
      const file = join(home, 'calls.jsonl');
      const a = await newSession(home, '--model', 'mock:m');
      expect((await run(['send', a, 'Tell me a story', '--home', home, '--provider', `record:${file}`], { env: ENV })).code).toBe(0);
      // The same call as a Stop would have recorded it: the first text delta, then the abort.
      const call = JSON.parse(readFileSync(file, 'utf8').trim()) as RecordedCall;
      const first = call.events.find((e) => e.t === 'text')!;
      writeFileSync(file, `${JSON.stringify({ ...call, events: [first], aborted: true })}\n`);
      const t0 = performance.now();
      const rep = await run(['send', await newSession(home, '--model', 'mock:m'), 'Tell me a story', '--home', home, '--provider', `replay:${file}`], { env: ENV });
      expect(performance.now() - t0).toBeLessThan(15_000);
      expect(rep.code).toBe(3);
      expect(rep.stderr).toContain('replay_aborted');
      expect(rep.stderr).toContain('press Ctrl+C');
    },
    T,
  );

  test(
    "preview's samplers line names what the wire body sends; the rest is listed as not sent",
    async () => {
      const srv = plainServer();
      const home = tmpHome('rp-core-m2-');
      configure(home, srv.base);
      const id = await newSession(home, '--model', 'mock:m', '--preset', join(ROOT, 'test', 'fixtures', 'presets', 'Default.json'));
      const text = await run(['preview', id, '--draft', 'Hello', '--home', home], { env: ENV });
      const wire = await run(['preview', id, '--draft', 'Hello', '--wire', '--home', home], { env: ENV });
      expect([text.code, wire.code]).toEqual([0, 0]);
      const line = text.stdout.split('\n').find((l) => l.startsWith('prefill: '))!;
      const shown = line.split('samplers: ')[1]!.split(', ').map((x) => x.split(' ')[0]!);
      const body = JSON.parse(wire.stdout) as Record<string, unknown>;
      const sent = ['temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed'].filter((k) => k in body);
      expect(shown.sort()).toEqual(sent.sort());
      expect(text.stdout).toContain('not sent by this connection: top_k, min_p, top_a, repetition_penalty');
      expect(chats(srv)).toHaveLength(0);
    },
    T,
  );

  test(
    'bad files fail before anything runs',
    async () => {
      const home = tmpHome('rp-core-m2-');
      const id = await newSession(home);
      const missing = await run(['send', id, 'hi', '--home', home, '--provider', `replay:${join(home, 'nope.jsonl')}`]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('cannot read recording');
      const bad = join(home, 'bad.jsonl');
      writeFileSync(bad, '[{"text":"a script, not a recording"}]\n');
      const notRecording = await run(['chat', id, '--home', home, '--provider', `replay:${bad}`]);
      expect(notRecording.code).toBe(1);
      expect(notRecording.stderr).toContain('recording line 1');
      const unwritable = await run(['send', id, 'hi', '--home', home, '--provider', `record:${join(home, 'no', 'such', 'dir.jsonl')}`]);
      expect(unwritable.code).toBe(1);
      expect(unwritable.stderr).toContain('cannot write the recording');
      // Nothing ran: the session still ends on its greeting.
      const show = await run(['show', id, '--json', '--home', home]);
      expect((JSON.parse(show.stdout) as unknown[]).length).toBe(1);
    },
    T,
  );
});
