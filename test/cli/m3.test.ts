// M3 CLI wiring (§12.3, §12.4, decisions G2, G3, H): a script file's caps line gives the `script:`
// connection tools (the chat's banner says so), `send` prints the narrator's tool calls on stderr in
// text mode and as events with --json, and `rp-core probe <conn:model> --active [--write] [--json]`
// against a local mock, in-process and through the chat's /probe --active.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import { main } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { scriptConnection } from '../../src/cli/provider.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { mockServer, nativeCaller } from '../probe-m3/mock.ts';
import { CARDS, jsonl, run } from './kit.ts';

const T = 30_000;
const CARD = join(CARDS, 'v3-full.json');
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

/** rp-core in this process (no spawn): exit code and both channels. */
async function inProcess(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = memIo();
  const code = await main([...args, '--home', home], { io, env: {}, exit: () => {}, fetch, clock: fakeClock() });
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

/** A script file in `home`: an optional caps line, then one line per call. */
function scriptFile(home: string, name: string, caps: Record<string, unknown> | null, ...callSteps: unknown[][]): string {
  const lines = [...(caps ? [JSON.stringify({ caps })] : []), ...callSteps.map((s) => JSON.stringify(s))];
  const path = join(home, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

async function newSession(home: string, ...args: string[]): Promise<string> {
  const r = await run(['new', '--card', CARD, '--home', home, '--no-chat', ...args]);
  if (r.code !== 0) throw new Error(`new failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

/** Give a closed session a note through the library API (what /memory add writes). */
async function addNote(home: string, id: string, note: { title: string; keys?: string[]; content: string }): Promise<void> {
  const engine = await Engine.open({ home });
  try {
    const s = engine.session(id);
    s.memoryAdd(note);
    await s.close();
  } finally {
    await engine.close();
  }
}

describe('a script file with a caps line', () => {
  test('scriptConnection merges the caps line over SCRIPT_CAPS; without one it is SCRIPT_CAPS', () => {
    const home = tmpHome('rp-core-cli-m3-');
    const withCaps = scriptFile(home, 'tools.jsonl', { tools: 'prompted', contextLength: 16384 }, [{ text: 'Hi.' }]);
    const conn = scriptConnection(`script:${withCaps}`);
    expect(conn.caps.tools).toBe('prompted');
    expect(conn.caps.contextLength).toBe(16384);
    expect(conn.caps.samplers).toEqual(SCRIPT_CAPS.samplers);
    const plain = scriptConnection(`script:${scriptFile(home, 'plain.jsonl', null, [{ text: 'Hi.' }])}`);
    expect(plain.caps).toEqual(SCRIPT_CAPS);
    expect(plain.caps).not.toBe(SCRIPT_CAPS);
  });

  test(
    'the chat banner reads the script connection\'s tools; a bad caps line fails before anything opens',
    async () => {
      const home = tmpHome('rp-core-cli-m3-');
      const id = await newSession(home);
      const file = scriptFile(home, 'prompted.jsonl', { tools: 'prompted' });
      const chat = await run(['chat', id, '--home', home, '--provider', `script:${file}`], { stdin: '/quit\n' });
      expect(chat.code).toBe(0);
      expect(chat.stdout.split('\n')[0]).toMatch(/^session s_[0-9a-f]+ · .* · narrator \S+ \(tools: prompted\) · ctx 8192$/);

      const bad = scriptFile(home, 'bad.jsonl', { tools: 'sometimes' }, [{ text: 'x' }]);
      const r = await run(['send', id, 'Hi', '--home', home, '--provider', `script:${bad}`]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('bad.jsonl: script line 1:');
      const late = scriptFile(home, 'late.jsonl', null, [{ text: 'x' }]);
      writeFileSync(late, `${readFileSync(late, 'utf8')}${JSON.stringify({ caps: { tools: 'native' } })}\n`);
      const r2 = await run(['send', id, 'Hi', '--home', home, '--provider', `script:${late}`]);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toContain('late.jsonl: script line 2');
    },
    T,
  );
});

/** A session whose history no longer fits its window (so a turn offers the history tools, D-92). */
async function longSession(home: string, id: string): Promise<void> {
  const engine = await Engine.open({ home });
  try {
    const s = engine.session(id);
    s.configure({ window: 3000 });
    const filler = ' The road goes on through the dunes and the wind keeps blowing sand into every pack and every boot.'.repeat(3);
    for (let i = 1; i <= 40; i++) s.send({ text: `Day ${i}: ${i === 3 ? 'the caravan moves on.' : 'we walk on.'}${filler}`, expectedVersion: s.version() });
    await s.close();
  } finally {
    await engine.close();
  }
}

describe('a chat on a script whose caps line enables prompted tools', () => {
  test(
    'the banner says prompted; a search_history round is a side line; /trace shows the rounds; preview names the tools',
    async () => {
      const home = tmpHome('rp-core-cli-m3-');
      const id = await newSession(home, '--max-tokens', '64');
      await longSession(home, id);
      const call = '<tool_call>{"name": "search_history", "args": {"query": "caravan"}}</tool_call>';
      const file = scriptFile(home, 'prompted.jsonl', { tools: 'prompted' }, [{ text: call }], [{ text: 'The caravan left at dawn.' }]);
      const r = await run(['chat', id, '--home', home, '--provider', `script:${file}`], { stdin: 'Where did the caravan go?\n/trace\n/quit\n' });
      expect(r.code).toBe(0);
      const out = r.stdout;
      expect(out.split('\n')[0]).toContain('(tools: prompted)');
      expect(out).not.toContain('<tool_call>');
      expect(out).toMatch(/\n {2}⋯ search_history "caravan" → \d+ hits?\n.* › The caravan left at dawn\.\n/);
      expect(out).toMatch(/\n {2}rounds: 2 · prompted tools · ended: answer · tool room \d+ of \d+ tok used\n {2}tool calls: 1\n {4}round 0 · search_history · ok · \d+ chars\n/);

      const p = await run(['preview', id, '--draft', 'And then?', '--home', home, '--provider', `script:${file}`]);
      expect(p.code).toBe(0);
      expect(p.stdout).toMatch(/#\d+ system · core:tools · \d+ tok\n/);
      expect(p.stdout).toMatch(/\ntools: [a-z_, ]*search_history[a-z_, ]* \(prompted\)\n/);
    },
    T,
  );
});

describe('send: the narrator\'s tool calls', () => {
  test(
    'text mode: stdout is the answer alone, each finished call one line on stderr; --json carries the tool events with their round',
    async () => {
      const home = tmpHome('rp-core-cli-m3-');
      const id = await newSession(home);
      // A note that does not fire on "Hello" leaves lore unfired: the turn offers search_lore and read_lore (D-92).
      await addNote(home, id, { title: 'Brother', keys: ['Yan'], content: "Mira's brother Yan sails the north road." });
      const file = scriptFile(home, 'native.jsonl', { tools: 'native' }, [{ tool: { name: 'search_lore', args: { query: 'brother' } } }], [{ text: 'Yan is away at sea.' }]);
      const r = await run(['send', id, 'Hello', '--home', home, '--provider', `script:${file}`]);
      expect(r.stderr).toMatch(/^rp-core: ⋯ search_lore "brother" → .+$/m);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('Yan is away at sea.\n');

      const file2 = scriptFile(home, 'native2.jsonl', { tools: 'native' }, [{ tool: { name: 'search_lore', args: { query: 'brother' } } }], [{ text: 'Again.' }]);
      const j = await run(['send', id, 'Hello again', '--home', home, '--json', '--provider', `script:${file2}`]);
      expect(j.code).toBe(0);
      const tools = jsonl(j.stdout).filter((e) => e.type === 'tool');
      expect(tools.map((e) => (e as { phase: string }).phase)).toEqual(['start', 'done']);
      expect(tools.every((e) => (e as { round?: number }).round === 0 && (e as { name: string }).name === 'search_lore')).toBe(true);
    },
    T,
  );
});

describe('probe --active', () => {
  function home(): string {
    const h = tmpHome('rp-core-cli-m3-');
    writeFileSync(join(h, 'config.toml'), `[connections.mock]\nbase_url = "${mock.base}"\n`);
    return h;
  }
  const chatCalls = (): number => mock.paths.filter((p) => p === '/v1/chat/completions').length;

  test('one conn:model: the catalog, then the model calls and their facts; nothing stored without --write', async () => {
    mock.behave = nativeCaller;
    const h = home();
    const before = chatCalls();
    const r = await inProcess(['probe', 'mock:m', '--active'], h);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ {2}active probes \(\d calls\):/);
    expect(r.stdout).toContain('  probe facts: tools native');
    expect(r.stdout).toContain('not stored: --write keeps this catalog and the probe facts for new turns');
    expect(chatCalls() - before).toBeGreaterThan(1);
    expect(existsSync(join(h, 'caps-cache.json'))).toBe(false);
  });

  test('--write stores the probe facts; --json carries them as active', async () => {
    mock.behave = nativeCaller;
    const h = home();
    const w = await inProcess(['probe', 'mock:m', '--active', '--write'], h);
    expect(w.code).toBe(0);
    const cache = JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, { probe?: { tools?: string } }>;
    expect(cache['mock:m']!.probe!.tools).toBe('native');
    const j = await inProcess(['probe', 'mock:m', '--active', '--json'], h);
    expect(j.code).toBe(0);
    const res = JSON.parse(j.stdout) as { active?: { facts: { tools?: string }; written: boolean } }[];
    expect(res[0]!.active!.facts.tools).toBe('native');
    expect(res[0]!.active!.written).toBe(false);
  });

  test('a whole connection or no target is a usage error before any request; the help names the flag', async () => {
    const h = home();
    const before = chatCalls();
    const paths = mock.paths.length;
    for (const args of [['probe', 'mock', '--active'], ['probe', '--active', '--write']]) {
      const r = await inProcess(args, h);
      expect(r.code).toBe(64);
      expect(r.stderr).toContain('rp-core: --active probes one model: rp-core probe <connection>:<model> --active');
      expect(r.stderr).toContain('usage: rp-core probe [connection[:model]] [--active] [--write] [--json]');
    }
    expect(chatCalls()).toBe(before);
    expect(mock.paths.length).toBe(paths);
    const help = await inProcess(['help', 'probe'], h);
    expect(help.stdout).toContain('--active  also call the model (one <connection>:<model> only)');
    expect(help.stdout).toContain('[caps."conn:model"] in config.toml still wins');
  });

  test(
    'the chat\'s /probe --active probes the narrator binding and prints the same report',
    async () => {
      mock.behave = nativeCaller;
      const h = home();
      const id = await newSession(h, '--model', 'mock:m');
      const r = await run(['chat', id, '--home', h], { stdin: '/probe --active --write\n/quit\n' });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('probing mock:m: a few short calls (at most 6, replies of 96 to 1024 tokens; Ctrl+C stops)…');
      expect(r.stdout).toMatch(/ {2}active probes \(\d calls\):/);
      expect(r.stdout).toContain('  probe facts: tools native');
      expect(r.stdout).toContain('the stored facts apply from the next rp-core chat');
      const cache = JSON.parse(readFileSync(join(h, 'caps-cache.json'), 'utf8')) as Record<string, { probe?: { tools?: string } }>;
      expect(cache['mock:m']!.probe!.tools).toBe('native');
      // The next chat's banner reads the stored fact.
      const again = await run(['chat', id, '--home', h], { stdin: '/quit\n' });
      expect(again.stdout.split('\n')[0]).toContain('narrator mock:m (tools: native)');
    },
    T,
  );
});
