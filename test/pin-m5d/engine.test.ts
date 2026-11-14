// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5d (D-210, D-211, D-212), the engine side of slot pinning, end to end: connections built from a
// config.toml, the real openai-chat adapter, and a Bun.serve fake of llama.cpp (/props and the chat
// endpoint, which records each body's id_slot by the agent that sent it). The session opens, the engine
// reads /props once, the first call waits for it, and every agent's call goes out with its slot.
import { afterAll, describe, expect, test } from 'bun:test';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { CallAgent, Provider } from '../../src/providers/types.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { engineOptions, type Runtime } from '../../src/cli/runtime.ts';
import { LEVI, MIRA } from '../engine/kit.ts';
import { recallSession } from '../recall-engine-m5c/kit.ts';
import { collect, tick } from '../engine-m5a/kit.ts';
import { planOf } from '../engine-m4/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

interface Seen {
  agent: string;
  /** The body's id_slot; 'none' when absent. */
  slot: unknown;
}

interface Llama {
  base: string;
  /** Every path asked, in order. */
  paths: string[];
  calls: Seen[];
  stop(): void;
}

/** llama.cpp /props as a server of this build and slot count answers it. */
const props = (build: string, slots: number): Record<string, unknown> => ({
  default_generation_settings: { n_ctx: 8192, params: {} },
  total_slots: slots,
  build_info: build,
  endpoint_slots: true,
});

const sse = (chunks: unknown[]): Response =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const chunk = (content: string, finish: string | null = null): Record<string, unknown> => ({
  object: 'chat.completion.chunk',
  model: 'm',
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});

/** The answer each agent gets: a reply, a plan, recall's picks. */
function answer(agent: string): string {
  if (agent === 'director') return JSON.stringify(planOf());
  if (agent === 'recall') return JSON.stringify({ entry_ids: ['Арсений Кеттер'] });
  return 'Мира кивает.';
}

const servers: Llama[] = [];
const engines: EngineHandle[] = [];
afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
  for (const s of servers) s.stop();
});

function llama(propsBody: Record<string, unknown> | null, propsDelayMs = 0): Llama {
  const l: Llama = { base: '', paths: [], calls: [], stop: () => server.stop(true) };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      l.paths.push(path);
      if (path === '/props') {
        if (propsDelayMs > 0) await new Promise((r) => setTimeout(r, propsDelayMs));
        return propsBody ? Response.json(propsBody) : new Response('no', { status: 404 });
      }
      if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      const agent = req.headers.get('x-test-agent') ?? '?';
      l.calls.push({ agent, slot: 'id_slot' in body ? body.id_slot : 'none' });
      return sse([chunk(answer(agent)), chunk('', 'stop')]);
    },
  });
  l.base = `http://127.0.0.1:${server.port}`;
  servers.push(l);
  return l;
}

/** The provider with each request tagged by its agent (a header only the fake reads); the adapter is the real one. */
function tagAgents(conn: Connection): Connection {
  const inner = conn.provider;
  const provider: Provider = {
    stream(req, env) {
      const agent: CallAgent = req.agent ?? 'narrator';
      const fetchFn = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('x-test-agent', agent);
        return env.fetch(input, { ...init, headers });
      }) as typeof fetch;
      return inner.stream(req, { ...env, fetch: fetchFn });
    },
  };
  if (inner.wire) provider.wire = inner.wire.bind(inner);
  return { ...conn, provider };
}

/** One connection 'local' on the fake, from config.toml lines (connection and caps). */
function connection(l: Llama, more: { conn?: string; caps?: string } = {}): Connection {
  const toml = `[connections.local]\nbase_url = "${l.base}/v1"\n${more.conn ?? ''}\n\n[caps."local:m"]\ncontext_length = 32768\n${more.caps ?? ''}\n`;
  const { connections } = buildConnections(parseConfig(toml, null), { env: {}, secrets: createSecretResolver({ env: {} }), capsCache: {} });
  return tagAgents(connections.local!);
}

async function rig(conn: Connection, serverInfo: 'auto' | 'off' = 'auto', override?: Connection): Promise<{ engine: EngineHandle; home: string; events: { seen: Event[] } }> {
  const home = tmpHome();
  const engine = await Engine.open({
    home,
    connections: { local: conn },
    ...(override ? { providerOverride: override } : {}),
    clock: fakeClock(),
    random: fakeRandom(5),
    timeZone: 'UTC',
    checkpoint: { chars: 1e9, ms: 1e9, datasyncMs: 1e9 },
    lane: 'manual',
    recall: 'config',
    serverInfo,
  });
  engines.push(engine);
  return { engine, home, events: collect(engine) };
}

/** A session on 'local:m' with the Director on and a sync recall (the Compendium on: recorder and recall count too). */
function session(r: { engine: EngineHandle; home: string }): SessionHandle {
  return recallSession(r, { mode: 'sync' }, { config: { roles: { narrator: { conn: 'local', model: 'm' } }, director: { enabled: true } } });
}

async function turn(s: SessionHandle): Promise<void> {
  const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
  for await (const _ of t.events);
  const out = await t.result;
  expect(out.type).toBe('done');
}

/** The id_slots each agent sent, deduplicated (a repair call sends the same). */
function slotsBy(calls: readonly Seen[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const c of calls) if (!(out[c.agent] ?? []).includes(c.slot)) (out[c.agent] ??= []).push(c.slot);
  return out;
}

const noticesOf = (evs: readonly Event[]): Extract<Event, { type: 'notice' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice' && e.code.startsWith('slots_'));

describe('D-211 through the engine', () => {
  test('a new build with 2 slots: the narrator sends id_slot 0, the Director and recall 1; /props is read once; slots_pinned told once', async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l));
    const s = session(r);
    await turn(s);
    expect(slotsBy(l.calls)).toEqual({ director: [1], recall: [1], narrator: [0] });
    // A second turn reads the settled memo: no second /props.
    s.send({ text: 'Дальше.', expectedVersion: s.version() });
    await turn(s);
    expect(l.paths.filter((p) => p === '/props')).toHaveLength(1);
    expect(slotsBy(l.calls)).toEqual({ director: [1], recall: [1], narrator: [0] });
    await tick();
    const told = noticesOf(r.events.seen);
    expect(told.map((n) => [n.code, n.level])).toEqual([['slots_pinned', 'info']]);
    expect(told[0]!.message).toContain('2 slots, build b11901');
    expect(told[0]!.message).toContain('-np 2 --no-kv-unified');
  });

  test('an old build at capacity 2: nothing is pinned and slots_detected says why and how', async () => {
    const l = llama(props('b9000-abc', 2));
    const r = await rig(connection(l, { conn: 'max_in_flight = 2' }));
    const s = session(r);
    await turn(s);
    expect(slotsBy(l.calls)).toEqual({ director: ['none'], recall: ['none'], narrator: ['none'] });
    await tick();
    const told = noticesOf(r.events.seen);
    expect(told.map((n) => n.code)).toEqual(['slots_detected']);
    expect(told[0]!.message).toContain('older than b11552');
    expect(told[0]!.message).toContain('max_in_flight = 1');
  });

  test('the same old build at capacity 1 is pinned (rp-core never sends to a busy slot)', async () => {
    const l = llama(props('b9000-abc', 2));
    const r = await rig(connection(l));
    await turn(session(r));
    expect(slotsBy(l.calls)).toEqual({ director: [1], recall: [1], narrator: [0] });
  });

  test('slot_pin = false: never pinned, and slots_detected names the setting', async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l, { caps: 'slot_pin = false' }));
    await turn(session(r));
    expect(slotsBy(l.calls)).toEqual({ director: ['none'], recall: ['none'], narrator: ['none'] });
    await tick();
    const told = noticesOf(r.events.seen);
    expect(told.map((n) => n.code)).toEqual(['slots_detected']);
    expect(told[0]!.message).toContain('slot_pin = false in config');
    expect(told[0]!.message).toContain('slot_pin = true under [caps."local:m"]');
  });

  test("the connection's extra_body id_slot wins over the pin", async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l, { conn: 'extra_body = { id_slot = 5 }' }));
    await turn(session(r));
    expect(slotsBy(l.calls)).toEqual({ director: [5], recall: [5], narrator: [5] });
  });

  test("the model's own extra_body id_slot wins too, and slots_detected says it is the user's", async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l, { caps: 'extra_body = { id_slot = 2 }' }));
    await turn(session(r));
    expect(slotsBy(l.calls)).toEqual({ director: [2], recall: [2], narrator: [2] });
    await tick();
    const told = noticesOf(r.events.seen);
    expect(told.map((n) => n.code)).toEqual(['slots_detected']);
    expect(told[0]!.message).toContain('id_slot 2 is set in extra_body.');
    expect(told[0]!.message).not.toContain('to pin');
  });

  test('server info off: /props is never asked, nothing is pinned, nothing is told', async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l), 'off');
    await turn(session(r));
    expect(l.paths).not.toContain('/props');
    expect(slotsBy(l.calls)).toEqual({ director: ['none'], recall: ['none'], narrator: ['none'] });
    await tick();
    expect(noticesOf(r.events.seen)).toEqual([]);
  });

  test('a one-slot server: nothing is pinned, nothing is told', async () => {
    const l = llama(props('b11901-5320c87f', 1));
    const r = await rig(connection(l));
    await turn(session(r));
    expect(slotsBy(l.calls)).toEqual({ director: ['none'], recall: ['none'], narrator: ['none'] });
    await tick();
    expect(noticesOf(r.events.seen)).toEqual([]);
  });

  test('a connection marked local = false is never asked', async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l, { conn: 'local = false' }));
    await turn(session(r));
    expect(l.paths).not.toContain('/props');
    expect(slotsBy(l.calls).narrator).toEqual(['none']);
  });

  test('slot_pin = true pins without asking the server whether it can', async () => {
    const l = llama(null);
    const r = await rig(connection(l, { caps: 'slot_pin = true' }));
    await turn(session(r));
    expect(slotsBy(l.calls)).toEqual({ director: [1], recall: [1], narrator: [0] });
  });

  test("the preview's wire carries the narrator's slot once the server info is in", async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l));
    const s = session(r);
    await s.serverInfoReady?.();
    const p = s.preview();
    if (!p.ok) throw new Error(p.message);
    expect((p.wire?.body as Record<string, unknown>).id_slot).toBe(0);
    // The caps the engine keeps are not touched: the next call still decides for itself.
    expect(l.calls).toEqual([]);
  });

  test('the first call waits for a server that answers late; the narrator alone (Compendium off) is pinned too', async () => {
    const l = llama(props('b11901-5320c87f', 2), 60);
    const r = await rig(connection(l));
    const s = r.engine.createSession({ character: MIRA, persona: LEVI, config: { roles: { narrator: { conn: 'local', model: 'm' } }, compendium: { enabled: false } } });
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    await turn(s);
    expect(l.paths.indexOf('/props')).toBeLessThan(l.paths.indexOf('/v1/chat/completions'));
    expect(l.calls).toEqual([{ agent: 'narrator', slot: 0 }]);
  });

  test('a script: provider override is never asked (no baseUrl), even with a local llama.cpp in config', async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const script: Connection = { id: 'script', provider: createScriptedProvider([{ steps: [{ text: 'Мира кивает.' }] }]), caps: SCRIPT_CAPS, origin: 'script:x', local: true };
    const r = await rig(connection(l), 'auto', script);
    const s = r.engine.createSession({ character: MIRA, persona: LEVI, config: { roles: { narrator: { conn: 'local', model: 'm' } }, compendium: { enabled: false } } });
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    await turn(s);
    expect(l.paths).toEqual([]);
  });

  test('a record: run (the CLI) turns the server info off, so a recording replays without a server to ask', () => {
    const rt = { home: 'h', connections: {}, config: { prices: {} }, recording: 'calls.jsonl' } as unknown as Runtime;
    expect(engineOptions(rt).serverInfo).toBe('off');
    expect(engineOptions({ ...rt, recording: undefined } as Runtime).serverInfo).toBeUndefined();
  });

  test('a draft call is the narrator: slot 0', async () => {
    const l = llama(props('b11901-5320c87f', 2));
    const r = await rig(connection(l));
    const s = session(r);
    await s.draft({ kind: 'quiet', prompt: 'Опиши дверь.' });
    expect(l.calls).toEqual([{ agent: 'narrator', slot: 0 }]);
  });
});
