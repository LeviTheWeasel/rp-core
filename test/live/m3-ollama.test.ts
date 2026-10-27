// Live M3 demo against the user's own Ollama: SKIPPED unless RP_CORE_LIVE=1.
//   RP_CORE_LIVE=1 bun test test/live/m3-ollama.test.ts
//   RP_CORE_LIVE=1 RP_CORE_OLLAMA_M3_MODEL=gemma4:26b RP_CORE_OLLAMA_CTX=4096 RP_CORE_OLLAMA_TOOLS=native \
//     RP_CORE_OLLAMA_MAX_TOKENS=1024 bun test test/live/m3-ollama.test.ts
// The innkeeper-200 chat (seeded in-process, no model), then the §15 question on a local model with
// prompted (default) or native tools: the protocol invariants are checked on every try; the demo
// claim (a search_history call and an answer naming Тихон) must hold in one of 3 tries (the first
// answer, then 2 swipes). Nothing is pulled, created or deleted; narrator.maxRounds 2, so at most
// 3 tries × 3 calls. Env: RP_CORE_OLLAMA_URL (default http://127.0.0.1:11434), RP_CORE_OLLAMA_M3_MODEL
// (default magmell-16k:latest, a Modelfile alias with num_ctx 16384), RP_CORE_OLLAMA_CTX (default
// 16384: the window the model really runs with on /v1, docs/M3-DEMO.md), RP_CORE_OLLAMA_TOOLS
// ('prompted' or 'native') and RP_CORE_OLLAMA_MAX_TOKENS (default 300; a thinking model's thinking
// counts against it). A JSON transcript is logged.
import { describe, expect, test } from 'bun:test';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, SessionHandle, TurnHandle } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { ModelRequest } from '../../src/providers/types.ts';
import type { Block, MsgEntry } from '../../src/session/entries.ts';
import { GAP_SRC, REMIND_SRC } from '../../src/prompt/assemble/gap.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { entriesOf } from '../engine/kit.ts';
import { tmpHome } from '../helpers.ts';
import { INNKEEPER_BROTHER, INNKEEPER_QUESTION, innkeeperConnection, seedInnkeeperSession } from '../fixtures/ru/innkeeper-200/load.ts';

const LIVE = process.env.RP_CORE_LIVE === '1';
const BASE = process.env.RP_CORE_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.RP_CORE_OLLAMA_M3_MODEL ?? 'magmell-16k:latest';
const CTX = Number(process.env.RP_CORE_OLLAMA_CTX ?? 16_384);
/** 'prompted' (default) or 'native': the caps' tools transport for the model. */
const TRANSPORT = process.env.RP_CORE_OLLAMA_TOOLS === 'native' ? 'native' : 'prompted';
/** The reply reserve: a thinking model needs more than the default 300 (its thinking counts). */
const MAX_TOKENS = Number(process.env.RP_CORE_OLLAMA_MAX_TOKENS ?? 300);
const TRIES = 3;
const MAX_ROUNDS = 2;

/** Tool markup that must never reach a committed text block (prompted tags, DSML, results). */
const MARKUP = /<\/?tool_(call|result)|<｜DSML｜|<function_calls>|\[TOOL_CALLS\]|<\s*\/?\s*(search_history|read_history|search_lore|read_lore)\b/i;

const textOf = (blocks: readonly Block[]): string => blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/** The configured Ollama connection, built like the CLI builds it, with every request it sends kept. */
function ollama(requests: ModelRequest[]): Connection {
  const toml = `[connections.ollama]\nbase_url = "${BASE}"\n\n[caps."ollama:${MODEL}"]\ncontext_length = ${CTX}\ntools = "${TRANSPORT}"\n`;
  const { connections } = buildConnections(parseConfig(toml, null), { env: {}, secrets: createSecretResolver({ env: {} }), capsCache: {} });
  const conn = connections['ollama']!;
  return {
    ...conn,
    provider: {
      ...conn.provider,
      stream(req, env) {
        requests.push(req);
        return conn.provider.stream(req, env);
      },
    },
  };
}

interface Try {
  n: number;
  outcome: string;
  calls: number;
  tools: { name: string; ok: boolean; args: unknown; summary?: string }[];
  blocks: string[];
  answer: string;
  ms: number;
  named: boolean;
  searched: boolean;
  stripped: boolean;
}

async function run(s: SessionHandle, home: string, requests: ModelRequest[], n: number): Promise<Try> {
  const before = requests.length;
  const t0 = performance.now();
  const turn: TurnHandle =
    n === 1
      ? s.submit({ text: INNKEEPER_QUESTION, expectedVersion: s.version() })
      : s.runTurn({ kind: 'swipe', expectedVersion: s.version() });
  const evs: Event[] = [];
  for await (const ev of turn.events) evs.push(ev);
  const out = await turn.result;
  const ms = Math.round(performance.now() - t0);
  const sent = requests.slice(before);
  const done = evs.filter((e): e is Extract<Event, { type: 'tool' }> => e.type === 'tool' && e.phase === 'done');

  if (out.type !== 'done') {
    const notices = evs.flatMap((e) => (e.type === 'notice' ? [{ code: e.code, message: e.message }] : []));
    const tools = evs.flatMap((e) => (e.type === 'tool' ? [{ phase: e.phase, name: e.name }] : []));
    const text = evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    console.log(JSON.stringify({ try: n, outcome: out, calls: sent.length, notices, tools, streamed: text.slice(0, 2000) }, null, 2));
  }
  // Invariants of every try.
  expect(out.type).toBe('done');
  if (out.type !== 'done') throw new Error(`try ${n} ended ${out.type}`);
  const msg = entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
  const blocks = msg.blocks ?? [];
  const answer = textOf(blocks);
  expect(sent.length).toBeGreaterThanOrEqual(1);
  expect(sent.length).toBeLessThanOrEqual(MAX_ROUNDS + 1);
  const q0 = sent[0]!;
  if (TRANSPORT === 'prompted') {
    expect(q0.tools).toBeUndefined();
    expect(q0.stop).toContain(PROMPTED_STOP);
  } else {
    expect((q0.tools ?? []).map((t) => t.name)).toContain('search_history');
  }
  expect(q0.messages.filter((m) => m.src === 'core:tools')).toHaveLength(1);
  // D-96: the trimmed history is told, once before the kept messages and once at depth 0 (shape may
  // merge each into a neighbouring chat message: src 'core:gap+history').
  const srcHas = (src: string) => q0.messages.filter((m) => (m.src ?? '').split('+').includes(src));
  expect(srcHas(GAP_SRC)).toHaveLength(1);
  expect(srcHas(REMIND_SRC)).toHaveLength(1);
  // Paired blocks: every call has exactly one result after it, ids unique.
  const calls = blocks.filter((b): b is Extract<Block, { k: 'tool_call' }> => b.k === 'tool_call');
  const results = blocks.filter((b): b is Extract<Block, { k: 'tool_result' }> => b.k === 'tool_result');
  expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
  expect(results.map((r) => r.callId).sort()).toEqual(calls.map((c) => c.id).sort());
  for (const c of calls) expect(blocks.findIndex((b) => b.k === 'tool_result' && b.callId === c.id)).toBeGreaterThan(blocks.indexOf(c));
  // No tool markup in the stored text. What streamed is what was stored, except that a call written
  // as bare JSON streams and is then left out of the stored text: storage only ever takes text out
  // (the tool_markup_stripped notice says so once per session, so it is not looked for here).
  for (const b of blocks) if (b.k === 'text') expect(b.text).not.toMatch(MARKUP);
  const streamed = evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
  const stripped = streamed !== answer;
  if (stripped) for (const b of blocks) if (b.k === 'text') expect(streamed).toContain(b.text.trim());
  expect(msg.gen?.rounds).toBe(sent.length);
  expect(msg.gen?.transport).toBe(TRANSPORT);

  const searched = calls.some((c) => c.name === 'search_history') && (msg.trace?.tools ?? []).some((t) => t.name === 'search_history' && t.ok);
  return {
    n,
    outcome: out.type,
    calls: sent.length,
    tools: done.map((e) => ({ name: e.name, ok: e.ok === true, args: e.args, ...(e.summary !== undefined ? { summary: e.summary } : {}) })),
    blocks: blocks.map((b) => b.k),
    answer,
    ms,
    named: answer.includes(INNKEEPER_BROTHER),
    searched,
    stripped,
  };
}

describe.skipIf(!LIVE)(`live: the M3 demo on Ollama (${TRANSPORT} tools)`, () => {
  test(
    'the innkeeper question: invariants on every try; a search_history call and Тихон in one of 3 tries',
    async () => {
      const home = tmpHome();
      const requests: ModelRequest[] = [];
      const engine = await Engine.open({
        home,
        connections: { innkeeper: innkeeperConnection(), ollama: ollama(requests) },
        clock: () => new Date(),
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        timeZone: 'UTC',
      });
      const tries: Try[] = [];
      try {
        const id = await seedInnkeeperSession(engine, {
          config: { narrator: { maxRounds: MAX_ROUNDS } },
          narrator: { conn: 'ollama', model: MODEL, maxTokens: MAX_TOKENS },
        });
        const s = engine.session(id);
        for (let n = 1; n <= TRIES; n++) {
          const t = await run(s, home, requests, n);
          tries.push(t);
          if (t.searched && t.named) break;
        }
      } finally {
        console.log(JSON.stringify({ model: MODEL, base: BASE, window: CTX, transport: TRANSPORT, maxTokens: MAX_TOKENS, tries }, null, 2));
        await engine.close();
      }
      expect(tries.some((t) => t.searched)).toBe(true);
      expect(tries.some((t) => t.searched && t.named)).toBe(true);
    },
    900_000,
  );
});
