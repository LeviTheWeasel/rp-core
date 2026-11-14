// `rp-core bench ttft` (M5d, D-214) through main(), against Bun.serve fakes: llama.cpp with timings
// (a pinned two-slot server passes, a one-slot or unpinned one fails, id_slot per --pin), an
// Ollama-shaped /v1 usage with cached_tokens, an LM Studio-shaped server with no counts (ratio
// unknown, exit 0), the --json shape, the call-count line, a failing call and bad arguments.
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCH_MAX_TOKENS, judgeRound, median, roundPrompts, seedOf, syntheticText, type BenchResult } from '../../src/cli/bench.ts';
import { main } from '../../src/cli/main.ts';
import { estimateTokens } from '../../src/prompt/tokens.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { chatFake, llamaRoutes, LMSTUDIO_ROUTES, OLLAMA_ROUTES, type ChatFake, type FakeOptions } from './fakes.ts';

const fakes: ChatFake[] = [];
afterAll(() => {
  for (const f of fakes) f.stop();
});

function up(o: FakeOptions): ChatFake {
  const f = chatFake(o);
  fakes.push(f);
  return f;
}

/** Small prompts keep the runs fast; the sizes are flags like any other. */
const SMALL = ['--prompt-tokens', '300', '--tail-tokens', '40', '--agent-tokens', '200'];

interface Run {
  code: number;
  out: string;
  err: string;
  /** How many requests the fake had seen when the first stdout / stderr line was written. */
  seenAtFirstLine?: number;
}

async function bench(f: ChatFake | null, args: string[], config?: string): Promise<Run> {
  const home = tmpHome('rp-core-bench-m5d-');
  const base = f?.base ?? 'http://127.0.0.1:9';
  writeFileSync(join(home, 'config.toml'), config ?? `[connections.local]\nbase_url = "${base}/v1"\n\n[roles]\nnarrator = "local:m"\n`);
  let out = '';
  let err = '';
  let seen: number | undefined;
  const first = (): void => {
    if (seen === undefined) seen = f?.paths.length ?? 0;
  };
  const code = await main(['bench', ...args, '--home', home], {
    io: {
      out: { write: (t) => void (first(), (out += t)), flush: async () => {} },
      err: { write: (t) => void (first(), (err += t)), flush: async () => {} },
    },
    env: {},
    exit: () => {},
    fetch,
    clock: fakeClock('2026-11-14T12:00:00.000Z', 10),
  });
  return { code, out, err, ...(seen !== undefined ? { seenAtFirstLine: seen } : {}) };
}

const chats = (f: ChatFake): Record<string, unknown>[] => f.bodies;
const slotsSent = (f: ChatFake): unknown[] => chats(f).map((b) => ('id_slot' in b ? b.id_slot : 'none'));

describe('prompts', () => {
  test('seeded: the same seed gives the same text, about the asked size', () => {
    const a = syntheticText(seedOf('P', 1), 500);
    expect(syntheticText(seedOf('P', 1), 500)).toBe(a);
    expect(syntheticText(seedOf('P', 2), 500)).not.toBe(a);
    const n = estimateTokens(a);
    expect(n).toBeGreaterThanOrEqual(500);
    expect(n).toBeLessThan(560);
  });

  test("call 3 starts with call 1's message; A shares nothing with P at --agent-shared 0", () => {
    const [p, agent, pt] = roundPrompts(1, { promptTokens: 300, tailTokens: 40, agentTokens: 200, agentShared: 0 });
    expect(p!.agent).toBe('narrator');
    expect(agent!.agent).toBe('filing');
    expect(pt!.agent).toBe('narrator');
    expect(pt!.messages[0]).toEqual(p!.messages[0]!);
    expect(pt!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(agent!.messages[0]).not.toEqual(p!.messages[0]!);
  });

  test("A starts with P's own start at --agent-shared 50; the salt leads P and so A", () => {
    const sizes = { promptTokens: 400, tailTokens: 40, agentTokens: 200, agentShared: 50 };
    const [p, agent] = roundPrompts(1, sizes, 'run abcd. ');
    const pText = (p!.messages[0]!.blocks[0] as { text: string }).text;
    const aText = (agent!.messages[0]!.blocks[0] as { text: string }).text;
    expect(pText.startsWith('run abcd. ')).toBe(true);
    let common = 0;
    while (common < aText.length && aText[common] === pText[common]) common++;
    // About half of A (by its token estimate) is P's start; the rest is A's own.
    expect(estimateTokens(aText.slice(0, common))).toBeGreaterThan(70);
    expect(estimateTokens(aText.slice(0, common))).toBeLessThan(130);
    expect(estimateTokens(aText)).toBeGreaterThanOrEqual(195);
    // Unsalted, the same round is the same text.
    expect(roundPrompts(1, sizes)).toEqual(roundPrompts(1, sizes));
    expect(roundPrompts(1, sizes, 'run 1. ')).not.toEqual(roundPrompts(1, sizes, 'run 2. '));
  });

  test('median and the round verdict', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const call = (n: 1 | 2 | 3, promptTokens?: number, processed?: number) => ({
      call: n,
      agent: 'narrator' as const,
      prompt: 'P' as const,
      estimatedTokens: 0,
      totalMs: 0,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(processed !== undefined ? { processed } : {}),
    });
    expect(judgeRound([call(1, 1000, 1000), call(2), call(3, 1100, 150)])).toEqual({ newTokens: 100, ratio: 1.5, verdict: 'pass' });
    expect(judgeRound([call(1, 1000, 1000), call(2), call(3, 1100, 151)]).verdict).toBe('fail');
    expect(judgeRound([call(1, 1000), call(2), call(3, 1100)]).verdict).toBe('unknown');
    expect(judgeRound([call(1), call(2), call(3, undefined, 10)]).why).toBe('the server reported no prompt token totals');
    expect(judgeRound([call(1, 1100, 10), call(2), call(3, 1000, 10)]).why).toContain('is not longer than');
  });
});

describe('llama.cpp with timings', () => {
  test('two slots, a recent build: pinned, call 3 processes the tail only, PASS', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const r = await bench(f, ['ttft', ...SMALL]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toBe('bench ttft: 9 real calls to local:m (3 rounds of narrator P, filing A, narrator P+T; at most 16 output tokens each)');
    expect(r.out).toContain('\nserver info: llama.cpp b11901, 2 slots\n');
    expect(r.out).toContain('\nslot pinning: on — narrator 0, agents 1 (2 slots, build b11901)\n');
    expect(slotsSent(f)).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    expect(r.out).toContain('\nround 1\n  #  agent     prompt  first token   total  prompt tok  processed  cached\n');
    expect(r.out).toMatch(/\n {2}3 {2}narrator {2}P\+T +0\.01 s {2}0\.02 s +\d+ +\d+ +\d+\n/);
    expect(r.out).toMatch(/\n {2}ratio 1\.00 \(\d+ processed \/ \d+ new\): PASS\n/);
    expect(r.out).toContain('\nmedian first token: P 0.01 s · A 0.01 s · P+T 0.01 s\n');
    expect(r.out).toContain('\nmedian ratio 1.00 (limit 1.5)\nPASS: call 3 processed at most 1.5× its new tokens in every round\n');
    // Every call: stream, temperature 0, 16 output tokens at most.
    for (const b of chats(f)) {
      expect(b.stream).toBe(true);
      expect(b.temperature).toBe(0);
      expect(b.max_tokens).toBe(BENCH_MAX_TOKENS);
    }
  });

  test('--pin off on the same server: no id_slot, A evicts P, FAIL (exit 1)', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const r = await bench(f, ['ttft', 'local:m', '--pin', 'off', '--rounds', '1', ...SMALL]);
    expect(r.code).toBe(1);
    expect(slotsSent(f)).toEqual(['none', 'none', 'none']);
    expect(r.out).toContain('\nslot pinning: off — --pin off\n');
    expect(r.out).toMatch(/\n {2}ratio \d+\.\d\d \(\d+ processed \/ \d+ new\): FAIL\n/);
    expect(r.out).toContain("\nFAIL: call 3 reprocessed more than 1.5× its new tokens (round 1 ");
    expect(r.out).toContain("the narrator's cache did not survive the agent call\n");
    expect(r.out).toContain('try: llama-server -np 2 --no-kv-unified with slot pinning, or -np 1 with --cache-ram');
  });

  test('one slot: auto does not pin, FAIL; --pin on sends 0 and 1 anyway', async () => {
    const f = up({ counts: 'timings', slots: 1, routes: llamaRoutes(1) });
    const r = await bench(f, ['ttft', '--rounds', '1', ...SMALL]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('slot pinning: off — the server has 1 slot; pinning needs 2 (start it with -np 2 --no-kv-unified)');
    expect(slotsSent(f)).toEqual(['none', 'none', 'none']);
    f.bodies.length = 0;
    const on = await bench(f, ['ttft', '--rounds', '1', '--pin', 'on', ...SMALL]);
    expect(on.out).toContain('slot pinning: on — narrator 0, agents 1 (--pin on)');
    expect(slotsSent(f)).toEqual([0, 1, 0]);
    // id_slot 1 wraps to slot 0 on a one-slot server: still a FAIL.
    expect(on.code).toBe(1);
  });

  test('an old build at capacity 2 is not pinned; slot_pin = true in config pins it', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2, 'b9000-1a2b3c4d') });
    const conf = (extra: string) => `[connections.local]\nbase_url = "${f.base}/v1"\nmax_in_flight = 2\n\n[roles]\nnarrator = "local:m"\n${extra}`;
    const off = await bench(f, ['ttft', '--rounds', '1', ...SMALL], conf(''));
    expect(off.out).toContain('slot pinning: off — build b9000 is older than b11552 and capacity is 2');
    expect(slotsSent(f)).toEqual(['none', 'none', 'none']);
    f.bodies.length = 0;
    const on = await bench(f, ['ttft', '--rounds', '1', ...SMALL], conf('\n[caps."local:m"]\nslot_pin = true\n'));
    expect(on.out).toContain('slot pinning: on — narrator 0, agents 1 (slot_pin = true in config)');
    expect(slotsSent(f)).toEqual([0, 1, 0]);
    expect(on.code).toBe(0);
  });
});

describe('other servers', () => {
  test('Ollama-shaped /v1 usage with cached_tokens: counts read, one cache, FAIL', async () => {
    const f = up({ counts: 'usage', slots: 1, routes: OLLAMA_ROUTES });
    const r = await bench(f, ['ttft', '--rounds', '1', '--json', ...SMALL]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as BenchResult;
    expect(j.serverInfo).toEqual({ kind: 'ollama', version: '0.40.12', loaded: [{ name: 'm:latest', digest: 'abc', contextLength: 16384 }] });
    expect(j.pin).toEqual({ pin: null, why: 'Ollama has no slots to pin', mode: 'auto' });
    const [c1, c2, c3] = j.rounds[0]!.calls;
    expect(c1!.cached).toBe(0);
    expect(c1!.processed).toBe(c1!.promptTokens!);
    expect(c2!.agent).toBe('filing');
    // P was evicted by A: call 3 kept only the start A shares with P (half of A, by default).
    expect(c3!.cached).toBe(c2!.cached);
    expect(c3!.processed).toBe(c3!.promptTokens! - c3!.cached!);
    expect(c3!.processed!).toBeGreaterThan(c3!.promptTokens! / 2);
    expect(j.verdict).toBe('fail');
    expect(slotsSent(f)).toEqual(['none', 'none', 'none']);
  });

  test('LM Studio-shaped, no counts: timings only, "ratio unknown", exit 0', async () => {
    const f = up({ counts: 'none', routes: LMSTUDIO_ROUTES });
    const r = await bench(f, ['ttft', '--rounds', '2', ...SMALL]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('\nserver info: LM Studio, loaded: m\n');
    expect(r.out).toContain('\nslot pinning: off — LM Studio has no slots to pin\n');
    expect(r.out).toMatch(/\n {2}1 {2}narrator {2}P +0\.01 s {2}0\.02 s +\? +\? +\?\n/);
    expect(r.out).toContain('\n  ratio unknown: the server reported no prompt counts (no cached_tokens in its usage, no cache_n in its timings)\n');
    expect(r.out).toContain('\nmedian total:       P 0.02 s · A 0.02 s · P+T 0.02 s\n');
    expect(r.out).toContain('\nratio unknown: the server reported no prompt counts');
    expect(r.out).not.toContain('PASS');
    expect(r.out).not.toContain('FAIL');
  });
});

describe('--json and the call count', () => {
  test('one object on stdout; the call count on stderr before any request', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const r = await bench(f, ['ttft', '--json', '--rounds', '2', ...SMALL]);
    expect(r.code).toBe(0);
    expect(r.seenAtFirstLine).toBe(0);
    expect(r.err).toBe('rp-core: bench ttft: 6 real calls to local:m (2 rounds of narrator P, filing A, narrator P+T; at most 16 output tokens each)\n');
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const j = JSON.parse(r.out) as BenchResult;
    expect(Object.keys(j).sort()).toEqual(['baseUrl', 'connection', 'limit', 'median', 'model', 'pin', 'plannedCalls', 'rounds', 'serverInfo', 'sizes', 'verdict', 'why']);
    expect(j.connection).toBe('local');
    expect(j.model).toBe('m');
    expect(j.plannedCalls).toBe(6);
    expect(j.sizes).toEqual({ promptTokens: 300, tailTokens: 40, agentTokens: 200, agentShared: 50 });
    expect(j.serverInfo).toEqual({ kind: 'llama.cpp', totalSlots: 2, build: 11901, endpointSlots: true });
    expect(j.pin).toEqual({ pin: { narrator: 0, agents: 1 }, why: '2 slots, build b11901', mode: 'auto' });
    expect(j.limit).toBe(1.5);
    expect(j.verdict).toBe('pass');
    expect(j.rounds).toHaveLength(2);
    const round = j.rounds[0]!;
    expect(round.verdict).toBe('pass');
    expect(round.ratio).toBe(1);
    expect(round.calls.map((c) => [c.call, c.agent, c.prompt, c.idSlot, c.firstTokenMs, c.totalMs])).toEqual([
      [1, 'narrator', 'P', 0, 10, 20],
      [2, 'filing', 'A', 1, 10, 20],
      [3, 'narrator', 'P+T', 0, 10, 20],
    ]);
    const [c1, , c3] = round.calls;
    expect(c3!.cached).toBe(c1!.promptTokens!);
    expect(round.newTokens).toBe(c3!.promptTokens! - c1!.promptTokens!);
    expect(c3!.processed).toBe(round.newTokens!);
    expect(j.median).toEqual({ firstTokenMs: [10, 10, 10], totalMs: [20, 20, 20], ratio: 1 });
  });

  test('the text run prints the call count before the server is asked anything', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const r = await bench(f, ['ttft', '--rounds', '1', ...SMALL]);
    expect(r.seenAtFirstLine).toBe(0);
    expect(r.out.startsWith('bench ttft: 3 real calls to local:m (1 round of ')).toBe(true);
  });

  test('a failing call: the run stops, exit 3, the error in --json', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2), failWith: 500 });
    const r = await bench(f, ['ttft', '--json', ...SMALL]);
    expect(r.code).toBe(3);
    expect(chats(f)).toHaveLength(1);
    const j = JSON.parse(r.out) as BenchResult;
    expect(j.error).toEqual({ round: 1, call: 1, code: 'overloaded', message: expect.any(String) as unknown as string });
    expect(j.rounds).toEqual([]);
    expect(j.verdict).toBe('unknown');
    expect(r.err).toContain('rp-core: bench ttft stopped: round 1, call 1 failed: overloaded: ');
  });

  test('RP_CORE_SERVER_INFO=off: nothing read, auto does not pin', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const home = tmpHome('rp-core-bench-m5d-');
    writeFileSync(join(home, 'config.toml'), `[connections.local]\nbase_url = "${f.base}/v1"\n`);
    let out = '';
    const code = await main(['bench', 'ttft', 'local:m', '--rounds', '1', ...SMALL, '--home', home], {
      io: { out: { write: (t) => void (out += t), flush: async () => {} }, err: { write: () => {}, flush: async () => {} } },
      env: { RP_CORE_SERVER_INFO: 'off' },
      exit: () => {},
      fetch,
      clock: fakeClock(),
    });
    expect(code).toBe(1);
    expect(f.paths.filter((p) => p !== '/v1/chat/completions')).toEqual([]);
    expect(out).toContain('server info: unknown (not read (RP_CORE_SERVER_INFO=off))');
    expect(slotsSent(f)).toEqual(['none', 'none', 'none']);
  });
});

describe('bad arguments (exit 64, nothing sent)', () => {
  const cases: [string, string[], string][] = [
    ['no benchmark', [], 'rp-core: which benchmark? rp-core bench ttft'],
    ['an unknown benchmark', ['tpot'], 'rp-core: unknown benchmark "tpot"; there is ttft'],
    ['a bad --pin', ['ttft', '--pin', 'maybe'], 'rp-core: --pin must be auto, on or off, got "maybe"'],
    ['--rounds 0', ['ttft', '--rounds', '0'], 'rp-core: --rounds must be a whole number from 1 to 9999999, got "0"'],
    ['too many rounds', ['ttft', '--rounds', '101'], 'rp-core: --rounds must be a whole number from 1 to 100, got 101'],
    ['a connection without a model', ['ttft', 'local'], 'rp-core: expected <connection>:<model>, got "local"'],
    ['an unknown connection', ['ttft', 'nope:m'], 'rp-core: no connection "nope" in '],
    ['a third positional', ['ttft', 'local:m', 'extra'], 'rp-core: unexpected argument "extra"'],
    ['an unknown flag', ['ttft', '--slots', '2'], 'rp-core: unknown flag --slots'],
  ];
  for (const [what, args, msg] of cases) {
    test(what, async () => {
      const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
      const r = await bench(f, args);
      expect(r.code).toBe(64);
      expect(r.err).toContain(msg);
      expect(r.err).toContain('usage: rp-core bench ttft [connection:model]');
      expect(r.out).toBe('');
      expect(f.paths).toEqual([]);
    });
  }

  test('no narrator in [roles] and no model named', async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const r = await bench(f, ['ttft'], `[connections.local]\nbase_url = "${f.base}/v1"\n`);
    expect(r.code).toBe(64);
    expect(r.err).toContain('no narrator in [roles] of config.toml: name the model, rp-core bench ttft <connection>:<model>');
  });

  test("prompts larger than the model's window", async () => {
    const f = up({ counts: 'timings', slots: 2, routes: llamaRoutes(2) });
    const r = await bench(f, ['ttft', 'local:m'], `[connections.local]\nbase_url = "${f.base}/v1"\n\n[caps."local:m"]\ncontext_length = 2048\n`);
    expect(r.code).toBe(64);
    expect(r.err).toContain("do not fit local:m's window of 2048 tokens; lower --prompt-tokens");
    expect(f.paths).toEqual([]);
  });

  test('help names the server setups and that the calls are real', async () => {
    const r = await bench(null, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: rp-core bench ttft [connection:model] [--rounds N]');
    expect(r.out).toContain('REAL model calls');
    expect(r.out).toContain('llama-server -np 1 --cache-ram N');
    expect(r.out).toContain('llama-server -np 1 --cache-ram 0');
    expect(r.out).toContain('llama-server -np 2 --no-kv-unified');
  });
});
