// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M5d demo end to end, deterministic (.notes/m5d-decisions.md D-215; docs/M5D-DEMO.md): the real CLI
// (`bun src/cli/main.ts`, spawned as a person runs it) against Bun.serve fakes of three local servers
// (fakes.ts), in one isolated home. RP_CORE_SERVER_INFO is removed from the children's environment (the
// test preload turns the reader off), so every run reads the server info as a person's would.
//   1. llama.cpp, 2 slots, build b11901: `probe` prints the info and the pinning verdict; a chat with the
//      Director on is told slots_pinned once, the narrator sends id_slot 0 and the Director 1, and
//      /trace shows each call's prompt counts: the narrator's second prompt is mostly cached.
//   2. The same server with slot_pin = false: slots_detected, no id_slot, and the narrator's second
//      prompt is processed again (the Director's prompt took its slot).
//   3. `bench ttft` on that server: PASS pinned (call 3 processes only the tail), FAIL with --pin off.
//   4. Ollama with two names on one blob (num_ctx 16384 and 32768) for the narrator and the Director:
//      ollama_reload_risk, and every switch empties the cache.
//   5. LM Studio with the Director's model not loaded: lmstudio_autoevict.
//   6. --stdio: the same notice reaches a JSON-RPC client as an event.
// Each claim is its own test over the one recorded run. RP_CORE_DEMO_PRINT=1 prints the transcript.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from '../cli/kit.ts';
import { MAIN, ROOT } from '../cli/kit.ts';
import { tmpHome } from '../helpers.ts';
import { llamaFake, lmStudioFake, ollamaFake, type ChatSeen, type Fake } from './fakes.ts';

const DIR = import.meta.dir;
/** The reader on (the preload turns it off), no colour. */
const ENV = { RP_CORE_SERVER_INFO: undefined, NO_COLOR: '1' };
/** What the person types in every chat. */
const TYPED = ['I slide the ticket window open.', 'I ask the man in grey for his ticket.', '/trace', '/quit'];
const BLOB = 'models/blobs/sha256-7e1d';

const llama = llamaFake({ slots: 2, build: 'b11901-5320c87f', propsDelayMs: 300 });
const ollama = ollamaFake({
  models: {
    'lumen-16k': { blob: BLOB, parameters: 'num_ctx 16384\nstop "<|im_end|>"' },
    'lumen-32k': { blob: BLOB, parameters: 'num_ctx 32768\nstop "<|im_end|>"' },
  },
});
const lmstudio = lmStudioFake({ models: { 'lumen-7b': true, 'lumen-3b': false } });
const FAKES: [Fake, string][] = [
  [llama, 'http://127.0.0.1:8080'],
  [ollama, 'http://127.0.0.1:11434'],
  [lmstudio, 'http://127.0.0.1:1234'],
];

interface Step {
  args: string[];
  stdin?: string;
  r: RunResult;
}

let home: string;
const steps: Step[] = [];
/** Each part's chat calls as the fake saw them. */
const seen: Record<'pinned' | 'unpinned' | 'benchOn' | 'benchOff' | 'ollama' | 'lmstudio', ChatSeen[]> = {
  pinned: [],
  unpinned: [],
  benchOn: [],
  benchOff: [],
  ollama: [],
  lmstudio: [],
};
const runs: Record<'probe' | 'pinned' | 'unpinned' | 'benchOn' | 'benchOff' | 'ollama' | 'lmstudio', RunResult> = {} as never;
let stdioFrames: Record<string, unknown>[] = [];
/** The paths each fake was asked, for the probe and the Ollama chat. */
const asked: { probe: string[]; ollama: string[] } = { probe: [], ollama: [] };

async function cli(args: string[], stdin?: string): Promise<RunResult> {
  const r = await run(['--home', home, ...args], { env: ENV, ...(stdin !== undefined ? { stdin } : {}) });
  steps.push({ args, ...(stdin !== undefined ? { stdin } : {}), r });
  return r;
}

const llamaConfig = (more = ''): string =>
  [
    '[connections.local]',
    `base_url = "${llama.base}"`,
    '',
    '[caps."local:m"]',
    'context_length = 32768',
    ...(more ? [more] : []),
    '',
    '[roles]',
    'narrator = "local:m"',
    '',
    '[director]',
    'enabled = true',
    '',
    '[compendium]',
    'enabled = false',
    '',
  ].join('\n');

const ollamaConfig = (): string =>
  [
    '[connections.ollama]',
    `base_url = "${ollama.base}"`,
    '',
    '[caps."ollama:lumen-16k"]',
    'context_length = 16384',
    '',
    '[caps."ollama:lumen-32k"]',
    'context_length = 32768',
    '',
    '[roles]',
    'narrator = "ollama:lumen-16k"',
    'director = "ollama:lumen-32k"',
    '',
    '[director]',
    'enabled = true',
    '',
    '[compendium]',
    'enabled = false',
    '',
  ].join('\n');

const lmConfig = (): string =>
  [
    '[connections.lmstudio]',
    `base_url = "${lmstudio.base}"`,
    '',
    '[caps."lmstudio:lumen-7b"]',
    'context_length = 16384',
    '',
    '[caps."lmstudio:lumen-3b"]',
    'context_length = 16384',
    '',
    '[roles]',
    'narrator = "lmstudio:lumen-7b"',
    'director = "lmstudio:lumen-3b"',
    '',
    '[director]',
    'enabled = true',
    '',
    '[compendium]',
    'enabled = false',
    '',
  ].join('\n');

function config(text: string): void {
  writeFileSync(join(home, 'config.toml'), text);
  steps.push({ args: ['<config.toml>'], r: { code: 0, stdout: text, stderr: '' } });
}

async function newSession(): Promise<string> {
  const r = await cli(['new', '--card', join(DIR, 'card.json'), '--persona', join(DIR, 'persona.json'), '--no-chat']);
  if (r.code !== 0) throw new Error(`new failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A chat with the typed lines; the fake's calls are taken and the fake is restarted afterwards. */
async function chat(f: Fake): Promise<{ r: RunResult; calls: ChatSeen[]; paths: string[] }> {
  const id = await newSession();
  const r = await cli(['chat', id], `${TYPED.join('\n')}\n`);
  const calls = [...f.chats];
  const paths = [...f.paths];
  f.reset();
  return { r, calls, paths };
}

/** `rp-core --stdio`: initialize, open `id`, read frames until a notice event (or 5 s), shut down. */
async function stdio(id: string): Promise<Record<string, unknown>[]> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...ENV })) if (v !== undefined) env[k] = v;
  const p = Bun.spawn([process.execPath, MAIN, '--home', home, '--stdio'], { cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
  const send = (frame: unknown): void => {
    p.stdin.write(`${JSON.stringify(frame)}\n`);
    void p.stdin.flush();
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocol: 1, client: { name: 'demo', version: '1' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'session/open', params: { sessionId: id } });
  const frames: Record<string, unknown>[] = [];
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 5000;
  const isNotice = (f: Record<string, unknown>): boolean => f.method === 'event' && (f.params as { type?: string }).type === 'notice';
  while (!frames.some(isNotice) && Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now()))]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      buf = buf.slice(nl + 1);
    }
  }
  send({ jsonrpc: '2.0', id: 3, method: 'shutdown' });
  p.stdin.end();
  reader.releaseLock();
  await p.exited;
  return frames;
}

beforeAll(async () => {
  home = tmpHome('rp-core-demo-m5d-');
  // 1. llama.cpp, pinned by D-211's rule.
  config(llamaConfig());
  runs.probe = await cli(['probe', 'local']);
  asked.probe = [...llama.paths];
  llama.reset();
  ({ r: runs.pinned, calls: seen.pinned } = await chat(llama));
  // 2. The same server, slot_pin = false.
  config(llamaConfig('slot_pin = false'));
  ({ r: runs.unpinned, calls: seen.unpinned } = await chat(llama));
  // 3. bench ttft, pinned by the rule and with --pin off.
  config(llamaConfig());
  const bench = ['bench', 'ttft', '--rounds', '2', '--prompt-tokens', '1200', '--tail-tokens', '120', '--agent-tokens', '600'];
  runs.benchOn = await cli(bench);
  seen.benchOn = [...llama.chats];
  llama.reset();
  runs.benchOff = await cli([...bench, '--pin', 'off']);
  seen.benchOff = [...llama.chats];
  llama.reset();
  // 6. --stdio on a session of the pinned server.
  const id = await newSession();
  stdioFrames = await stdio(id);
  steps.push({ args: ['<stdio>'], r: { code: 0, stdout: id, stderr: '' } });
  llama.reset();
  // 4. Ollama, two names on one blob.
  config(ollamaConfig());
  ({ r: runs.ollama, calls: seen.ollama, paths: asked.ollama } = await chat(ollama));
  // 5. LM Studio, the Director's model not loaded.
  config(lmConfig());
  ({ r: runs.lmstudio, calls: seen.lmstudio } = await chat(lmstudio));
}, 60_000);

afterAll(() => {
  for (const [f] of FAKES) f.stop();
});

/** The chat's notice lines (`! … (code)`). */
const noticeLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('! '));
/** /trace's call rows. */
const callRows = (out: string): string[] => {
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l === '  calls:');
  if (at < 0) return [];
  const rows: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('    ')) break;
    rows.push(l.trim());
  }
  return rows;
};
/** The prompt counts of a /trace row: [cached, new]. */
const countsOf = (row: string): [number, number] | null => {
  const m = /prompt ([\d ]+) cached, ([\d ]+) new/.exec(row);
  return m ? [Number(m[1]!.replace(/ /g, '')), Number(m[2]!.replace(/ /g, ''))] : null;
};
const of = (calls: readonly ChatSeen[], agent: ChatSeen['agent']): ChatSeen[] => calls.filter((c) => c.agent === agent);

describe('M5d demo: llama.cpp with two slots', () => {
  test('probe prints the server info and the pinning verdict', () => {
    expect(runs.probe.code).toBe(0);
    expect(runs.probe.stdout).toContain('  server info: llama.cpp b11901, 2 slots\n');
    expect(runs.probe.stdout).toContain('  slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)\n');
    // Once for the catalog, once through the server-info reader.
    expect(asked.probe.filter((p) => p === '/props')).toHaveLength(2);
  });

  test('the chat is told slots_pinned once; the narrator sends id_slot 0 and the Director 1', () => {
    expect(runs.pinned.code).toBe(0);
    const told = noticeLines(runs.pinned.stdout);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('(2 slots, build b11901) is pinned: the narrator keeps slot 0 and the agents use slot 1.');
    expect(told[0]).toEndWith('(slots_pinned)');
    // After the first answer (the REPL shows the bus once the turn has ended), before the second message.
    const lines = runs.pinned.stdout.split('\n');
    const you = lines.flatMap((l, i) => (l.startsWith('you      › ') ? [i] : []));
    const at = lines.indexOf(told[0]!);
    const answer = lines.findIndex((l, i) => i > you[0]! && l.startsWith('Narrator › '));
    expect(answer).toBeGreaterThan(you[0]!);
    expect(at).toBeGreaterThan(answer);
    expect(at).toBeLessThan(you[1]!);
    expect(seen.pinned.map((c) => [c.agent, c.idSlot])).toEqual([
      ['director', 1],
      ['narrator', 0],
      ['director', 1],
      ['narrator', 0],
    ]);
  });

  test("/trace shows each call's start, first token and prompt counts, as the server reported them", () => {
    const rows = callRows(runs.pinned.stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^director {2}\+\d+\.\d s {2}first token \d+\.\d s {2}\d+\.\d s {2}prompt [\d ]+ cached, [\d ]+ new$/);
    expect(rows[1]).toMatch(/^narrator {2}\+\d+\.\d s {2}first token \d+\.\d s {2}\d+\.\d s {2}prompt [\d ]+ cached, [\d ]+ new$/);
    const [dir2, nar2] = [of(seen.pinned, 'director')[1]!, of(seen.pinned, 'narrator')[1]!];
    expect(countsOf(rows[0]!)).toEqual([dir2.cached, dir2.processed]);
    expect(countsOf(rows[1]!)).toEqual([nar2.cached, nar2.processed]);
    // The counts the docs quote (the fakes count words, so the run is the same every time).
    expect(rows[0]).toEndWith('prompt 5 087 cached, 836 new');
    expect(rows[1]).toEndWith('prompt 452 cached, 151 new');
    // The narrator's second prompt is mostly its first one, still in slot 0: the cache holds up to where
    // the first turn's directive sat (depth 1), and the rest is new.
    expect(nar2.cached).toBeGreaterThan(nar2.processed * 2);
    expect(nar2.cached).toBeLessThan(of(seen.pinned, 'narrator')[0]!.total);
  });

  test('slot_pin = false: slots_detected names the setting, no id_slot, and the narrator processes its prompt again', () => {
    expect(runs.unpinned.code).toBe(0);
    const told = noticeLines(runs.unpinned.stdout);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('but rp-core does not pin it for the narrator and the Director: slot_pin = false in config; to pin, set slot_pin = true under [caps."local:m"]');
    expect(told[0]).toEndWith('(slots_detected)');
    expect(seen.unpinned.every((c) => c.idSlot === null && c.slot === 0)).toBe(true);
    const nar2 = of(seen.unpinned, 'narrator')[1]!;
    const pinned2 = of(seen.pinned, 'narrator')[1]!;
    // The same prompt: the Director's plan and the replies are the fake's, so both runs send the same text.
    expect(nar2.total).toBe(pinned2.total);
    expect(nar2.processed).toBeGreaterThan(nar2.total * 0.9);
    expect(nar2.processed).toBeGreaterThan(pinned2.processed * 3);
    const [, nar] = callRows(runs.unpinned.stdout);
    expect(countsOf(nar!)).toEqual([nar2.cached, nar2.processed]);
  });
});

describe('M5d demo: bench ttft', () => {
  test('pinned by the rule: call 3 processes only the new tokens, every round PASSes, exit 0', () => {
    expect(runs.benchOn.code).toBe(0);
    expect(runs.benchOn.stdout).toMatch(/^bench ttft: 6 real calls to local:m \(2 rounds/);
    expect(runs.benchOn.stdout).toContain('slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)');
    expect(runs.benchOn.stdout.match(/^ {2}ratio 1\.00 \(\d+ processed \/ \d+ new\): PASS$/gm)).toHaveLength(2);
    expect(runs.benchOn.stdout).toMatch(/\nPASS/);
    expect(seen.benchOn.map((c) => c.idSlot)).toEqual([0, 1, 0, 0, 1, 0]);
  });

  test('--pin off: the agent prompt, sharing P\'s start, takes P\'s slot; call 3 processes the rest again, FAIL, exit 1', () => {
    expect(runs.benchOff.code).toBe(1);
    expect(runs.benchOff.stdout).toContain('slot pinning: off — --pin off');
    expect(runs.benchOff.stdout).toMatch(/\nFAIL/);
    expect(runs.benchOff.stdout).toContain('\n  ratio 6.98 (370 processed / 53 new): FAIL\n');
    expect(runs.benchOff.stdout).toContain('\n  ratio 7.14 (364 processed / 51 new): FAIL\n');
    expect(runs.benchOff.stdout).toContain('\ntry: llama-server -np 2 --no-kv-unified with slot pinning, or -np 1 with --cache-ram');
    expect(seen.benchOff.every((c) => c.idSlot === null)).toBe(true);
    // Only A's shared start (P's own) survives in the slot.
    const call3 = seen.benchOff[2]!;
    expect(call3.processed).toBeGreaterThan(call3.total * 0.7);
  });
});

describe('M5d demo: Ollama and LM Studio', () => {
  test('two names on one blob with other runner options: ollama_reload_risk, and every switch reloads', () => {
    expect(runs.ollama.code).toBe(0);
    const told = noticeLines(runs.ollama.stdout);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('the narrator on lumen-16k and the Director on lumen-32k share one model file with different runner options (num_ctx 16384 vs 32768)');
    expect(told[0]).toEndWith('(ollama_reload_risk)');
    // The Director and the narrator alternate, so the narrator never finds its prompt cached.
    expect(of(seen.ollama, 'narrator').map((c) => c.cached)).toEqual([0, 0]);
    expect(seen.ollama.every((c) => c.idSlot === null)).toBe(true);
    // The reader, then /api/show once per name.
    expect(asked.ollama.filter((p) => p !== '/v1/chat/completions')).toEqual(['/props', '/api/version', '/api/ps', '/api/show', '/api/show']);
    const rows = callRows(runs.ollama.stdout);
    expect(rows[0]).toMatch(/prompt 0 cached, [\d ]+ new {2}ollama:lumen-32k$/);
    expect(rows[1]).toMatch(/^narrator .* prompt 0 cached, [\d ]+ new$/);
  });

  test("LM Studio with the Director's model not loaded: lmstudio_autoevict; /trace has timings only", () => {
    expect(runs.lmstudio.code).toBe(0);
    const told = noticeLines(runs.lmstudio.stdout);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('name 2 models (lumen-7b, lumen-3b) and lumen-3b is not loaded');
    expect(told[0]).toEndWith('(lmstudio_autoevict)');
    const rows = callRows(runs.lmstudio.stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^director {2}\+\d+\.\d s {2}first token \d+\.\d s {2}\d+\.\d s {2}lmstudio:lumen-3b$/);
    expect(rows[1]).toMatch(/^narrator {2}\+\d+\.\d s {2}first token \d+\.\d s {2}\d+\.\d s$/);
    for (const row of rows) expect(row).not.toContain('prompt');
  });
});

describe('M5d demo: --stdio', () => {
  test('a JSON-RPC client gets the notice as an event after session/open', () => {
    const ids = stdioFrames.filter((f) => f.id !== undefined).map((f) => f.id);
    expect(ids).toContain(2);
    const notice = stdioFrames.find((f) => f.method === 'event' && (f.params as { type?: string }).type === 'notice');
    expect(notice?.params).toMatchObject({ type: 'notice', level: 'info', code: 'slots_pinned' });
  });
});

/** The run as the docs show it: the fakes' ports as the servers' usual ones, the home as <home>. */
function transcript(): string {
  const clean = (s: string): string => {
    let out = s.split(home).join('<home>').split(ROOT).join('.');
    for (const [f, as] of FAKES) out = out.split(f.base).join(as);
    return out;
  };
  const parts: string[] = [];
  for (const s of steps) {
    if (s.args[0] === '<stdio>') {
      parts.push(`$ rp-core --stdio  (initialize, session/open ${s.r.stdout}, then every frame until the notice)`);
      for (const f of stdioFrames) parts.push(clean(JSON.stringify(f.id === 2 ? { ...f, result: '…' } : f)));
      continue;
    }
    if (s.args[0] === '<config.toml>') {
      parts.push(`$ cat <home>/config.toml\n${clean(s.r.stdout)}`);
      continue;
    }
    parts.push(`$ rp-core ${s.args.map((a) => clean(a)).join(' ')}${s.stdin !== undefined ? ' < typed.txt' : ''}`);
    if (s.r.stderr) parts.push(clean(s.r.stderr).trimEnd());
    if (s.r.stdout) parts.push(clean(s.r.stdout).trimEnd());
    if (s.r.code !== 0) parts.push(`(exit ${s.r.code})`);
  }
  return parts.join('\n');
}

test('the transcript (RP_CORE_DEMO_PRINT=1 prints it)', () => {
  const t = transcript();
  // The docs are public: no absolute path of this machine may survive the cleaning.
  expect(t).not.toMatch(/\/(home|tmp|Users|private|var)\//);
  expect(t).not.toContain(tmpdir());
  expect(t).not.toContain(homedir());
  if (process.env.RP_CORE_DEMO_PRINT === '1') console.log(t);
});
