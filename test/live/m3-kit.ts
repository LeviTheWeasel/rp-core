// The M3 innkeeper demo, shared by the live tests (m3-ollama.test.ts, m3-cloud.test.ts): the
// innkeeper-200 chat (seeded in-process, no model), then the §15 question on a real model. Every try
// checks the protocol invariants; the caller asserts the demo claim (a search_history call and an
// answer naming Тихон in one of the tries). Each try is logged as it ends and the run as a whole at
// the end (JSON); neither ever holds a key or a request body.
import { expect } from 'bun:test';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, SessionHandle, TurnHandle } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { CapsCacheRow } from '../../src/providers/probe.ts';
import type { ModelRequest, Usage } from '../../src/providers/types.ts';
import type { Block, MsgEntry } from '../../src/session/entries.ts';
import { GAP_SRC, REMIND_SRC } from '../../src/prompt/assemble/gap.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { entriesOf } from '../engine/kit.ts';
import { tmpHome } from '../helpers.ts';
import { INNKEEPER_BROTHER, INNKEEPER_QUESTION, innkeeperConnection, seedInnkeeperSession } from '../fixtures/ru/innkeeper-200/load.ts';

export type Transport = 'native' | 'prompted';

/** The first answer, then 2 swipes. */
export const TRIES = 3;
/**
 * narrator.maxRounds: at most 3 answered model calls per try, 9 in all. A round 0 the server refuses
 * before any output (429, 5xx) is retried once by the engine, so a try may send one request more.
 */
export const MAX_ROUNDS = 2;

/** Tool markup that must never reach a committed text block (prompted tags, DSML, results). */
export const MARKUP = /<\/?tool_(call|result)|<｜DSML｜|<function_calls>|\[TOOL_CALLS\]|<\s*\/?\s*(search_history|read_history|search_lore|read_lore)\b/i;

const textOf = (blocks: readonly Block[]): string => blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/**
 * A connection built from a config.toml text the way the CLI builds it. `capsCache` plays
 * <home>/caps-cache.json (rows by "conn:model", as `rp-core probe --write` stores them).
 */
export function connectionFromToml(toml: string, id: string, env: Record<string, string | undefined> = {}, capsCache: Record<string, CapsCacheRow> = {}): Connection {
  const { connections, skipped } = buildConnections(parseConfig(toml, null), { env, secrets: createSecretResolver({ env }), capsCache });
  const conn = connections[id];
  if (!conn) throw new Error(`connection '${id}' was not built: ${JSON.stringify(skipped)}`);
  return conn;
}

/** The connection with every request it sends kept in `requests` (retried ones included). */
export function recording(conn: Connection, requests: ModelRequest[]): Connection {
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

/**
 * Whether `stored` can be had from `streamed` by taking characters out, in order: storage only ever
 * removes text (a call or leaked markup cut from the middle of a block, its seam built from the
 * whitespace on either side), so a stored block is a subsequence of the stream, not always a
 * substring. `from` and the result are the position in `streamed`; -1 when it is not.
 */
export function subsequenceEnd(streamed: string, stored: string, from = 0): number {
  let at = from;
  for (const ch of stored) {
    at = streamed.indexOf(ch, at);
    if (at < 0) return -1;
    at += ch.length;
  }
  return at;
}

export interface Try {
  n: number;
  outcome: string;
  /** Requests sent, a retried one included. */
  calls: number;
  /** Requests the engine sent again after the server refused round 0 before any output (0 or 1). */
  retries: number;
  tools: { name: string; ok: boolean; args: unknown; summary?: string }[];
  blocks: string[];
  answer: string;
  ms: number;
  usage?: Usage;
  named: boolean;
  searched: boolean;
  stripped: boolean;
}

interface RunOpts {
  transport: Transport;
}

async function run(s: SessionHandle, home: string, requests: ModelRequest[], n: number, opts: RunOpts): Promise<Try> {
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
  const streamed = evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

  if (out.type !== 'done') {
    const notices = evs.flatMap((e) => (e.type === 'notice' ? [{ code: e.code, message: e.message }] : []));
    const tools = evs.flatMap((e) => (e.type === 'tool' ? [{ phase: e.phase, name: e.name }] : []));
    console.log(JSON.stringify({ try: n, outcome: out, calls: sent.length, notices, tools, streamed: streamed.slice(0, 2000) }, null, 2));
  }
  expect(out.type).toBe('done');
  if (out.type !== 'done') throw new Error(`try ${n} ended ${out.type}`);
  const msg = entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
  const blocks = msg.blocks ?? [];
  const answer = textOf(blocks);
  const calls = blocks.filter((b): b is Extract<Block, { k: 'tool_call' }> => b.k === 'tool_call');
  const results = blocks.filter((b): b is Extract<Block, { k: 'tool_result' }> => b.k === 'tool_result');
  const retries = (msg.gen?.route ?? []).filter((r) => r.status === 'retry').length;
  const searched = calls.some((c) => c.name === 'search_history') && (msg.trace?.tools ?? []).some((t) => t.name === 'search_history' && t.ok);
  // The record first, so a try whose invariants fail still shows what it got (it was paid for).
  const record: Try = {
    n,
    outcome: out.type,
    calls: sent.length,
    retries,
    tools: done.map((e) => ({ name: e.name, ok: e.ok === true, args: e.args, ...(e.summary !== undefined ? { summary: e.summary } : {}) })),
    blocks: blocks.map((b) => b.k),
    answer,
    ms,
    ...(msg.gen?.usage !== undefined ? { usage: msg.gen.usage } : {}),
    named: answer.includes(INNKEEPER_BROTHER),
    searched,
    stripped: streamed !== answer,
  };
  try {
    // Calls: every request is a call in the trace; the rounds are the answered ones (a retried
    // round 0 had no output, so it made exactly one request, and its loop starts over).
    const rounds = msg.gen?.rounds ?? 0;
    expect(retries).toBeLessThanOrEqual(1);
    expect(msg.trace?.calls.length).toBe(sent.length);
    expect(rounds).toBe(sent.length - retries);
    expect(rounds).toBeGreaterThanOrEqual(1);
    expect(rounds).toBeLessThanOrEqual(MAX_ROUNDS + 1);
    // The first request of the answered loop (a retry resends the same request).
    const q0 = sent[retries]!;
    if (opts.transport === 'prompted') {
      expect(q0.tools).toBeUndefined();
      expect(q0.stop).toContain(PROMPTED_STOP);
    } else {
      expect((q0.tools ?? []).map((t) => t.name)).toContain('search_history');
    }
    expect(q0.messages.filter((m) => m.src === 'core:tools')).toHaveLength(1);
    // D-96: the trimmed history is told, once before the kept messages and once at depth 0 (shape
    // may merge each into a neighbouring chat message: src 'core:gap+history').
    const srcHas = (src: string) => q0.messages.filter((m) => (m.src ?? '').split('+').includes(src));
    expect(srcHas(GAP_SRC)).toHaveLength(1);
    expect(srcHas(REMIND_SRC)).toHaveLength(1);
    // Paired blocks: every call has exactly one result after it, ids unique.
    expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
    expect(results.map((r) => r.callId).sort()).toEqual(calls.map((c) => c.id).sort());
    for (const c of calls) expect(blocks.findIndex((b) => b.k === 'tool_result' && b.callId === c.id)).toBeGreaterThan(blocks.indexOf(c));
    // No tool markup in the stored text, and nothing stored that did not stream: storage only takes
    // text out (a bare-JSON or leaked call, even from mid-block), so the stored text blocks, in
    // order, are a subsequence of the stream. (The tool_markup_stripped notice comes once per
    // session, so it is not looked for here.)
    for (const b of blocks) if (b.k === 'text') expect(b.text).not.toMatch(MARKUP);
    let at = 0;
    for (const b of blocks) {
      if (b.k !== 'text') continue;
      at = subsequenceEnd(streamed, b.text.trim(), at);
      expect(at).toBeGreaterThanOrEqual(0);
    }
    expect(msg.gen?.transport).toBe(opts.transport);
  } catch (e) {
    console.log(JSON.stringify({ invariantFailed: true, ...record }, null, 2));
    throw e;
  }
  return record;
}

export interface DemoOptions {
  /** The connection's id: the engine's key and the narrator binding's `conn`. */
  connId: string;
  /** The real connection (wrapped here to keep the requests it sends). */
  connection: Connection;
  model: string;
  transport: Transport;
  /** The narrator's reply limit: kept free in the window; a thinking model's thinking counts against it. */
  maxTokens: number;
  /** Extra fields for the logged transcript (base URL, window…). Never a key. */
  label: Record<string, unknown>;
}

/**
 * Seed the innkeeper chat, ask the §15 question, then swipe until a try both searched and named
 * Тихон (at most TRIES). Each try's invariants are checked as it ends; the transcript is logged.
 */
export async function innkeeperDemo(opts: DemoOptions): Promise<Try[]> {
  const home = tmpHome();
  const requests: ModelRequest[] = [];
  const engine = await Engine.open({
    home,
    connections: { innkeeper: innkeeperConnection(), [opts.connId]: recording(opts.connection, requests) },
    clock: () => new Date(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    timeZone: 'UTC',
  });
  const tries: Try[] = [];
  try {
    const id = await seedInnkeeperSession(engine, {
      config: { narrator: { maxRounds: MAX_ROUNDS } },
      narrator: { conn: opts.connId, model: opts.model, maxTokens: opts.maxTokens },
    });
    const s = engine.session(id);
    for (let n = 1; n <= TRIES; n++) {
      const t = await run(s, home, requests, n, { transport: opts.transport });
      tries.push(t);
      // Logged now, so a run cut off by the test's timeout still shows the tries it finished.
      console.log(JSON.stringify({ try: t.n, searched: t.searched, named: t.named, retries: t.retries, ms: t.ms, answer: t.answer.slice(0, 300) }));
      if (t.searched && t.named) break;
    }
  } finally {
    console.log(JSON.stringify({ ...opts.label, model: opts.model, transport: opts.transport, maxTokens: opts.maxTokens, requests: requests.length, tries }, null, 2));
    await engine.close();
  }
  return tries;
}
