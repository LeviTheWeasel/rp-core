// `rp-core new | import | sessions | show`, global flags and usage errors, run as processes.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MessageView } from '../../src/session/view.ts';
import { tmpHome } from '../helpers.ts';
import { CARDS, newSession, run, script } from './kit.ts';

const T = 30_000;

describe('new', () => {
  test(
    'from a V3 JSON card: prints the session id, imports the card, writes the greetings',
    async () => {
      const home = tmpHome('rp-core-cli-');
      const r = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', home]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^s_[0-9a-f]{8}\n$/);
      const id = r.stdout.trim();
      expect(existsSync(join(home, 'sessions', `${id}.jsonl`))).toBe(true);
      expect(existsSync(join(home, 'library', 'characters', 'alice.json'))).toBe(true);
      expect(r.stderr).toContain(`created session ${id} "Alice" with 3 greetings`);
      // The lock is released when `new` exits.
      expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(false);
    },
    T,
  );

  test(
    'from a PNG card with --json: {sessionId, title, greetings}',
    async () => {
      const home = tmpHome('rp-core-cli-');
      const r = await run(['new', '--card', join(CARDS, 'Seraphina.png'), '--home', home, '--json']);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      const out = JSON.parse(lines[0]!) as { sessionId: string; title: string; greetings: { id: string; text: string }[] };
      expect(out.sessionId).toMatch(/^s_[0-9a-f]{8}$/);
      expect(out.title).toBe('Seraphina');
      expect(out.greetings.length).toBeGreaterThanOrEqual(1);
      expect(out.greetings[0]!.id).toMatch(/^[0-9a-f]{8}$/);
      expect(out.greetings[0]!.text.length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    '--title, --model and --persona reach the session; a library id works as --card',
    async () => {
      const home = tmpHome('rp-core-cli-');
      const persona = join(home, 'levi.json');
      writeFileSync(persona, JSON.stringify({ name: 'Levi', description: 'A traveller.' }));
      expect((await run(['import', join(CARDS, 'v3-full.json'), '--home', home])).code).toBe(0);
      const r = await run(['new', '--card', 'alice', '--title', 'Dungeon run', '--model', 'local:qwen3:14b', '--persona', persona, '--home', home]);
      expect(r.code).toBe(0);
      const header = JSON.parse(readFileSync(join(home, 'sessions', `${r.stdout.trim()}.jsonl`), 'utf8').split('\n')[0]!);
      expect(header.title).toBe('Dungeon run');
      expect(header.config.roles.narrator).toMatchObject({ conn: 'local', model: 'qwen3:14b' });
      expect(header.cast.persona.name).toBe('Levi');
      expect(header.cast.character.name).toBe('Alice');
    },
    T,
  );

  test(
    'bad inputs: no --card is a usage error; a missing card or an invalid persona is exit 1',
    async () => {
      const home = tmpHome('rp-core-cli-');
      expect((await run(['new', '--home', home])).code).toBe(64);
      const missing = await run(['new', '--card', join(home, 'nope.png'), '--home', home]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('no card file');
      const persona = join(home, 'bad.json');
      writeFileSync(persona, JSON.stringify({ description: 'no name' }));
      const bad = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--persona', persona, '--home', home]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('persona');
      expect((await run(['new', '--card', join(CARDS, 'v3-full.json'), '--model', 'nocolon', '--home', home])).code).toBe(64);
    },
    T,
  );
});

describe('import', () => {
  test(
    'prints the library id; --as renames; --json describes the result',
    async () => {
      const home = tmpHome('rp-core-cli-');
      const a = await run(['import', join(CARDS, 'v3-full.json'), '--home', home]);
      expect(a.code).toBe(0);
      expect(a.stdout).toBe('alice\n');
      const b = await run(['import', join(CARDS, 'Seraphina.png'), '--as', 'Sera Two', '--json', '--home', home]);
      expect(b.code).toBe(0);
      const out = JSON.parse(b.stdout) as { kind: string; id: string; path: string; name: string; warnings: unknown[] };
      expect(out.kind).toBe('character');
      expect(out.name).toBe('Seraphina');
      expect(existsSync(out.path)).toBe(true);
      expect(out.path.startsWith(join(home, 'library', 'characters'))).toBe(true);
    },
    T,
  );

  test(
    'an unknown file is exit 1 with the reason',
    async () => {
      const home = tmpHome('rp-core-cli-');
      const f = join(home, 'x.json');
      writeFileSync(f, '{"hello": 1}');
      const r = await run(['import', f, '--home', home]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('import failed');
      expect(r.stdout).toBe('');
    },
    T,
  );
});

describe('sessions and show', () => {
  test(
    'sessions lists newest first; --json is one array',
    async () => {
      const { home, id } = await newSession();
      const text = await run(['sessions', '--home', home]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(id);
      expect(text.stdout).toContain('Alice');
      const json = await run(['sessions', '--json', '--home', home]);
      const rows = JSON.parse(json.stdout) as { id: string; title?: string; updated: string }[];
      expect(rows.map((r) => r.id)).toEqual([id]);
      expect(rows[0]!.title).toBe('Alice');
      const empty = await run(['sessions', '--home', tmpHome('rp-core-cli-')]);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toBe('');
    },
    T,
  );

  test(
    'show prints the path with greeting position; --json is the PathView path',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['show', id, '--home', home]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Alice · ${id} · version`);
      expect(r.stdout).toContain('greeting 1/3');
      expect(r.stdout).toContain('Another adventurer!');
      const j = await run(['show', id, '--json', '--home', home]);
      const path = JSON.parse(j.stdout) as MessageView[];
      expect(path).toHaveLength(1);
      expect(path[0]).toMatchObject({ role: 'assistant', gen: { kind: 'greeting' }, swipe: { index: 0, count: 3 } });
    },
    T,
  );

  test(
    'show does not take the lock: it works while another process holds it',
    async () => {
      const { home, id } = await newSession();
      writeFileSync(
        join(home, 'sessions', `${id}.lock`),
        JSON.stringify({ pid: process.pid, host: hostname(), started: new Date(0).toISOString(), renewed: new Date(Date.now()).toISOString() }),
      );
      const r = await run(['show', id, '--home', home]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('greeting 1/3');
      // While the lock is live, send is refused: the session is open elsewhere.
      const s = await run(['send', id, 'hi', '--home', home, '--provider', script('reply.jsonl'), '--json']);
      expect(s.code).toBe(5);
      expect(JSON.parse(s.stderr.trim().split('\n').pop()!)).toMatchObject({ type: 'refusal', code: 'session_locked' });
    },
    T,
  );

  test(
    'show of a missing session is exit 1',
    async () => {
      const r = await run(['show', 's_00000000', '--home', tmpHome('rp-core-cli-')]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('no session s_00000000');
    },
    T,
  );
});

describe('global flags and usage', () => {
  test(
    '--help, help <command>, --version',
    async () => {
      const h = await run(['--help']);
      expect(h.code).toBe(0);
      expect(h.stdout).toContain('Commands:');
      for (const c of ['new', 'import', 'send', 'sessions', 'show']) expect(h.stdout).toContain(`  ${c}`);
      const hs = await run(['send', '--help']);
      expect(hs.code).toBe(0);
      expect(hs.stdout).toContain('Usage: rp-core send <session>');
      expect(hs.stdout).toContain('Exit codes: 0 done, 2 stopped, 3 failed, 4 conflict, 5 refused');
      expect((await run(['help', 'show'])).stdout).toContain('Usage: rp-core show');
      const v = await run(['--version']);
      expect(v.code).toBe(0);
      expect(v.stdout).toMatch(/^rp-core \d+\.\d+\.\d+\n$/);
    },
    T,
  );

  test.each([
    [[], 'no command given'],
    [['frobnicate'], 'unknown command'],
    [['sessions', '--bogus'], 'unknown flag --bogus'],
    [['sessions', 'extra'], 'unexpected argument'],
    [['send'], 'which session?'],
    [['send', 's_1'], 'a reply needs text'],
    [['send', 's_1', 'hi', '--kind', 'sideways'], '--kind must be'],
    [['send', 's_1', 'hi', '--kind', 'swipe'], 'takes no text'],
    [['send', 's_1', 'hi', '--guidance', 'be brief'], '--guidance only applies to --kind swipe'],
    [['send', 's_1', 'hi', '--provider', 'record:x.jsonl'], 'M2'],
    [['send', 's_1', 'hi', '--provider', 'nonsense'], '--provider must be script:<file>'],
    [['sessions', '--home'], '--home needs a value'],
    [['sessions', '--sandbox', '--home', '/tmp'], 'cannot be combined'],
    [['--home', '/tmp', 'sessions', '--home', '/tmp'], 'given twice'],
  ] as [string[], string][])('usage error %p → 64', async (argv, message) => {
    const r = await run(argv);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain(message);
    expect(r.stderr).toContain('usage: ');
    expect(r.stdout).toBe('');
  }, T);

  test(
    'global flags work before the command',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['--home', home, 'sessions']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(id);
    },
    T,
  );

  test(
    '--sandbox uses a temporary home and removes it at exit',
    async () => {
      const r = await run(['new', '--sandbox', '--debug', '--card', join(CARDS, 'v3-full.json'), '--json']);
      expect(r.code).toBe(0);
      const m = /sandbox home (\S+) \(removed at exit\)/.exec(r.stderr);
      expect(m).not.toBeNull();
      expect(existsSync(m![1]!)).toBe(false);
      expect(JSON.parse(r.stdout).title).toBe('Alice');
    },
    T,
  );

  test(
    'a broken script file is exit 1 with its line number, before the session is touched',
    async () => {
      const { home, id } = await newSession();
      const bad = join(home, 'bad.jsonl');
      writeFileSync(bad, '[{"text":"ok"}]\n[{"txet":"typo"}]\n');
      const before = readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8');
      const r = await run(['send', id, 'hi', '--home', home, '--provider', `script:${bad}`]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('script line 2');
      expect(readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8')).toBe(before);
    },
    T,
  );
});
