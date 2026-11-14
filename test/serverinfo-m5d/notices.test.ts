// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5d (D-212): the four server notices. serverNotices as a pure function of the roles and what the
// servers said, then through the engine against Bun.serve fakes of llama.cpp, Ollama and LM Studio:
// told on the bus once per session (by code and subject), when the info arrives after the open, again
// after a configure changes the roles (/model), and with the Compendium off.
import { afterAll, describe, expect, test } from 'bun:test';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import { serverNotices, type ServerFacts, type ServerRole } from '../../src/engine/server-notices.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { OllamaModel, ServerInfo } from '../../src/providers/server-info.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import type { DeepPartial, SessionConfig } from '../../src/session/entries.ts';
import { LEVI, MIRA, until } from '../engine/kit.ts';
import { collect, tick } from '../engine-m5a/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { fake, llamaProps, ollamaShow, type Fake, type Route } from './fakes.ts';

const ORIGIN = 'http://127.0.0.1:8080';
const BLOB = '/models/blobs/sha256-0d1f';
const RUNNER = { num_ctx: 16384, num_batch: null, num_gpu: null, main_gpu: null, use_mmap: null, num_thread: null };

function role(r: ServerRole['role'], model: string, caps: Partial<ServerRole['caps']> = {}): ServerRole {
  const conn = { id: 'local', origin: ORIGIN, local: true } as Connection;
  return { role: r, conn, model, caps: { ...resolveCaps({ dialect: 'openai-chat', origin: ORIGIN, local: true, model }), ...caps } };
}

function facts(info: ServerInfo | undefined, shows: Record<string, OllamaModel | null> = {}, capacity = 1): ServerFacts {
  return { info: () => info, ollama: (_o, m) => shows[m], capacity: () => capacity };
}

const llama = (build: number | null, totalSlots: number | null): ServerInfo => ({ kind: 'llama.cpp', build, totalSlots });
const codes = (ns: ReturnType<typeof serverNotices>): string[] => ns.map((n) => n.notice.code);

describe('serverNotices (pure)', () => {
  test('llama.cpp: pinned, detected (old build at capacity 2, slot_pin = false), nothing on one slot', () => {
    const roles = [role('narrator', 'm'), role('director', 'm')];
    const pinned = serverNotices(roles, facts(llama(11901, 2)));
    expect(pinned.map((n) => [n.key, n.notice.level])).toEqual([[`slots_pinned:${ORIGIN}`, 'info']]);
    expect(pinned[0]!.notice.message).toContain('the narrator keeps slot 0 and the agents use slot 1');

    const old = serverNotices(roles, facts(llama(9000, 2), {}, 2));
    expect(old.map((n) => n.key)).toEqual([`slots_detected:${ORIGIN}`]);
    expect(old[0]!.notice.message).toContain('the narrator and the Director');
    // Capacity 1 pins the same old build.
    expect(codes(serverNotices(roles, facts(llama(9000, 2), {}, 1)))).toEqual(['slots_pinned']);

    const never = serverNotices([role('narrator', 'm', { slotPin: null })], facts(llama(11901, 2)));
    expect(codes(never)).toEqual(['slots_detected']);
    expect(never[0]!.notice.message).toContain('slot_pin = true under [caps."local:m"]');

    expect(serverNotices(roles, facts(llama(11901, 1)))).toEqual([]);
    expect(serverNotices(roles, facts(llama(11901, null)))).toEqual([]);
    // A custom slot_pin names its own slots.
    const odd = serverNotices([role('narrator', 'm', { slotPin: { narrator: 2, agents: 3 } })], facts(llama(11901, 4)));
    expect(odd[0]!.notice.message).toContain('slot 2 and the agents use slot 3');
  });

  test('slots_pinned gives its reason only when it adds something', () => {
    const roles = [role('narrator', 'm'), role('director', 'm')];
    // The plain rule: the slot count and build are said once, no second parenthesis.
    const plain = serverNotices(roles, facts(llama(11901, 2)))[0]!.notice.message;
    expect(plain).toContain('(2 slots, build b11901) is pinned: the narrator keeps slot 0 and the agents use slot 1. ');
    // Capacity 1 on an old build, and slot_pin = true, are reasons of their own.
    const cap1 = serverNotices(roles, facts(llama(9000, 2), {}, 1))[0]!.notice.message;
    expect(cap1).toContain('the agents use slot 1 (2 slots, capacity 1 (build b9000)). ');
    const forced = serverNotices([role('narrator', 'm', { slotPin: { narrator: 0, agents: 1 } })], facts(llama(11901, 2)))[0]!.notice.message;
    expect(forced).toContain('the agents use slot 1 (slot_pin = true in config). ');
  });

  test('slots_pinned names only the roles that are pinned: an unpinned narrator is not said to keep a slot', () => {
    const roles = [role('narrator', 'big', { slotPin: null }), role('director', 'small')];
    const ns = serverNotices(roles, facts(llama(11552, 2), {}, 2));
    expect(codes(ns)).toEqual(['slots_pinned', 'slots_detected']);
    const pinned = ns[0]!.notice.message;
    expect(pinned).toContain('(2 slots, build b11552) is pinned for the Director, which uses slot 1; the narrator is not pinned. ');
    expect(pinned).not.toContain('the narrator keeps');
    expect(ns[1]!.notice.message).toContain('does not pin it for the narrator: slot_pin = false in config');
    // Two agent roles; the narrator on another origin is not mentioned at all.
    const two = serverNotices([role('director', 'small'), role('recorder', 'small')], facts(llama(11901, 2)))[0]!.notice.message;
    expect(two).toContain('is pinned for the Director and the recorder, which use slot 1. ');
    expect(two).not.toContain('narrator');
  });

  test("a hand-set id_slot in the model's extra_body: not pinned by rp-core, and the notice says why without telling how to pin", () => {
    const ns = serverNotices([role('narrator', 'm', { extraBody: { id_slot: 2 } })], facts(llama(11901, 2)));
    expect(codes(ns)).toEqual(['slots_detected']);
    expect(ns[0]!.notice.message).toEndWith('does not pin it for the narrator: id_slot 2 is set in extra_body.');
  });

  test('nothing for an origin whose info has not settled, an unknown server, or a server without slots', () => {
    const roles = [role('narrator', 'a'), role('director', 'b')];
    expect(serverNotices(roles, facts(undefined))).toEqual([]);
    expect(serverNotices(roles, facts({ kind: 'unknown', reason: 'x' }))).toEqual([]);
    expect(serverNotices([role('narrator', 'a')], facts({ kind: 'ollama', loaded: [] }))).toEqual([]);
  });

  test('ollama_reload_risk: one blob, different runner options; not for other blobs, equal options or a missing show', () => {
    const roles = [role('narrator', 'magmell-16k'), role('director', 'magmell-32k'), role('recorder', 'magmell-16k')];
    const info: ServerInfo = { kind: 'ollama', loaded: [] };
    const risk = serverNotices(roles, facts(info, { 'magmell-16k': { blob: BLOB, runner: RUNNER }, 'magmell-32k': { blob: BLOB, runner: { ...RUNNER, num_ctx: 32768 } } }));
    expect(risk.map((n) => [n.key, n.notice.level])).toEqual([[`ollama_reload_risk:${ORIGIN}:magmell-16k|magmell-32k`, 'warn']]);
    expect(risk[0]!.notice.message).toContain('the narrator and the recorder on magmell-16k and the Director on magmell-32k');
    expect(risk[0]!.notice.message).toContain('num_ctx 16384 vs 32768');
    expect(risk[0]!.notice.message).toContain('Bind both roles to one name');

    expect(serverNotices(roles, facts(info, { 'magmell-16k': { blob: BLOB, runner: RUNNER }, 'magmell-32k': { blob: '/other', runner: { ...RUNNER, num_ctx: 32768 } } }))).toEqual([]);
    expect(serverNotices(roles, facts(info, { 'magmell-16k': { blob: BLOB, runner: RUNNER }, 'magmell-32k': { blob: BLOB, runner: RUNNER } }))).toEqual([]);
    expect(serverNotices(roles, facts(info, { 'magmell-16k': { blob: BLOB, runner: RUNNER }, 'magmell-32k': null }))).toEqual([]);
  });

  test('lmstudio_autoevict: two or more models and one not loaded', () => {
    const roles = [role('narrator', 'qwen3-8b'), role('director', 'gemma-3-12b')];
    const evict = serverNotices(roles, facts({ kind: 'lmstudio', loaded: { 'qwen3-8b': true, 'gemma-3-12b': false } }));
    expect(evict.map((n) => [n.notice.code, n.notice.level])).toEqual([['lmstudio_autoevict', 'warn']]);
    expect(evict[0]!.notice.message).toContain('gemma-3-12b is not loaded');
    expect(evict[0]!.notice.message).toContain('lms load');
    expect(serverNotices(roles, facts({ kind: 'lmstudio', loaded: { 'qwen3-8b': true, 'gemma-3-12b': true } }))).toEqual([]);
    expect(serverNotices([role('narrator', 'qwen3-8b'), role('director', 'qwen3-8b')], facts({ kind: 'lmstudio', loaded: {} }))).toEqual([]);
  });
});

// ---- through the engine ---------------------------------------------------------------------------

const fakes: Fake[] = [];
const engines: EngineHandle[] = [];
afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
  for (const f of fakes) f.stop();
});

function up(routes: Record<string, Route>): Fake {
  const f = fake(routes);
  fakes.push(f);
  return f;
}

function conn(f: Fake): Connection {
  const toml = `[connections.local]\nbase_url = "${f.base}/v1"\n`;
  return buildConnections(parseConfig(toml, null), { env: {}, secrets: createSecretResolver({ env: {} }), capsCache: {} }).connections.local!;
}

async function engineOn(f: Fake): Promise<{ engine: EngineHandle; events: { seen: Event[] } }> {
  const engine = await Engine.open({
    home: tmpHome(),
    connections: { local: conn(f) },
    clock: fakeClock(),
    random: fakeRandom(3),
    timeZone: 'UTC',
    lane: 'manual',
    recall: 'config',
    serverInfo: 'auto',
  });
  engines.push(engine);
  return { engine, events: collect(engine) };
}

/** A session with the Compendium off, the narrator on `narrator` and the Director (on) on `director`. */
function open(engine: EngineHandle, narrator: string, director: string | null, more: DeepPartial<SessionConfig> = {}): SessionHandle {
  return engine.createSession({
    character: MIRA,
    persona: LEVI,
    config: {
      compendium: { enabled: false },
      roles: { narrator: { conn: 'local', model: narrator }, ...(director !== null ? { director: { conn: 'local', model: director } } : {}) },
      director: { enabled: director !== null },
      ...more,
    },
  });
}

const told = (evs: readonly Event[], sessionId: string, code: string): Extract<Event, { type: 'notice' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice' && e.code === code && e.sessionId === sessionId);

const SHOWS: Record<string, unknown> = {
  'magmell-16k': ollamaShow(BLOB, 'num_ctx 16384'),
  'magmell-32k': ollamaShow(BLOB, 'num_ctx 32768'),
  'magmell-16k-b': ollamaShow(BLOB, 'num_ctx 16384'),
};
const ollamaRoutes = (): Record<string, Route> => ({
  '/api/version': { version: '0.40.12' },
  '/api/ps': { models: [] },
  '/api/show': (body: unknown) => {
    const name = (body as { model?: string }).model ?? '';
    return name in SHOWS ? Response.json(SHOWS[name]) : Response.json({ error: 'not found' }, { status: 404 });
  },
});

describe('through the engine (Compendium off)', () => {
  test('llama.cpp: slots_pinned arrives after the open, once per session; a second session gets its own', async () => {
    const f = up({ '/props': llamaProps() });
    const { engine, events } = await engineOn(f);
    const s = open(engine, 'm', 'm');
    await until(() => told(events.seen, s.id, 'slots_pinned').length === 1);
    // A configure that keeps the roles tells nothing again.
    s.configure({ director: { enabled: false } });
    s.configure({ director: { enabled: true } });
    await tick();
    expect(told(events.seen, s.id, 'slots_pinned')).toHaveLength(1);
    expect(f.paths.filter((p) => p === '/props')).toHaveLength(1);
    // The memo is the engine's: the second session reads it settled, and is told too.
    const t = open(engine, 'm', null);
    await until(() => told(events.seen, t.id, 'slots_pinned').length === 1);
    expect(f.paths.filter((p) => p === '/props')).toHaveLength(1);
    expect(told(events.seen, t.id, 'slots_pinned')[0]!.level).toBe('info');
  });

  test('llama.cpp, old build at capacity 2: slots_detected', async () => {
    const f = up({ '/props': llamaProps({ build_info: 'b9000-abc' }) });
    const toml = `[connections.local]\nbase_url = "${f.base}/v1"\nmax_in_flight = 2\n`;
    const engine = await Engine.open({
      home: tmpHome(),
      connections: buildConnections(parseConfig(toml, null), { env: {}, secrets: createSecretResolver({ env: {} }), capsCache: {} }).connections,
      clock: fakeClock(),
      random: fakeRandom(4),
      timeZone: 'UTC',
      lane: 'manual',
      serverInfo: 'auto',
    });
    engines.push(engine);
    const events = collect(engine);
    const s = open(engine, 'm', null);
    await until(() => told(events.seen, s.id, 'slots_detected').length === 1);
    expect(told(events.seen, s.id, 'slots_pinned')).toEqual([]);
  });

  test('Ollama: one blob under two names warns; told again only for a new pair; re-checked after /model', async () => {
    const f = up(ollamaRoutes());
    const { engine, events } = await engineOn(f);
    // One name: no /api/show is needed, nothing is told.
    const s = open(engine, 'magmell-16k', 'magmell-16k');
    await s.serverInfoReady?.();
    await tick();
    expect(f.paths).not.toContain('/api/show');
    expect(told(events.seen, s.id, 'ollama_reload_risk')).toEqual([]);
    // /model for the Director (the REPL's configure of roles): the pair is judged now.
    s.configure({ roles: { director: { conn: 'local', model: 'magmell-32k' } } });
    await until(() => told(events.seen, s.id, 'ollama_reload_risk').length === 1);
    const n = told(events.seen, s.id, 'ollama_reload_risk')[0]!;
    expect(n.level).toBe('warn');
    expect(n.message).toContain('the narrator on magmell-16k and the Director on magmell-32k');
    // Back and forth: the same pair is not told twice in one session.
    s.configure({ roles: { director: { conn: 'local', model: 'magmell-16k' } } });
    s.configure({ roles: { director: { conn: 'local', model: 'magmell-32k' } } });
    await tick();
    expect(told(events.seen, s.id, 'ollama_reload_risk')).toHaveLength(1);
    // Each name's /api/show is asked once per engine.
    expect(f.posts.filter((p) => (p as { model?: string }).model === 'magmell-32k')).toHaveLength(1);
    // Same blob, same options under another name: no warning.
    s.configure({ roles: { director: { conn: 'local', model: 'magmell-16k-b' } } });
    await until(() => f.posts.some((p) => (p as { model?: string }).model === 'magmell-16k-b'));
    await tick();
    expect(told(events.seen, s.id, 'ollama_reload_risk')).toHaveLength(1);
  });

  test('LM Studio: two models and one not loaded warns lmstudio_autoevict', async () => {
    const f = up({
      '/api/v1/models': {
        models: [
          { type: 'llm', key: 'qwen3-8b', loaded_instances: [{ id: 'qwen3-8b' }] },
          { type: 'llm', key: 'gemma-3-12b', loaded_instances: [] },
        ],
      },
    });
    const { engine, events } = await engineOn(f);
    const s = open(engine, 'qwen3-8b', 'gemma-3-12b');
    await until(() => told(events.seen, s.id, 'lmstudio_autoevict').length === 1);
    expect(told(events.seen, s.id, 'lmstudio_autoevict')[0]!.level).toBe('warn');
    // Both on the loaded model: nothing more.
    const t = open(engine, 'qwen3-8b', 'qwen3-8b');
    await t.serverInfoReady?.();
    await tick();
    expect(told(events.seen, t.id, 'lmstudio_autoevict')).toEqual([]);
  });

  test('server info off: no request, no notice', async () => {
    const f = up({ '/props': llamaProps() });
    const engine = await Engine.open({ home: tmpHome(), connections: { local: conn(f) }, clock: fakeClock(), random: fakeRandom(6), timeZone: 'UTC', lane: 'manual' });
    engines.push(engine);
    const events = collect(engine);
    const s = open(engine, 'm', 'm');
    await s.serverInfoReady?.();
    await tick();
    // test/preload.ts sets RP_CORE_SERVER_INFO=off; the engine never asked.
    expect(f.paths).toEqual([]);
    expect(events.seen.filter((e) => e.type === 'notice' && e.sessionId === s.id)).toEqual([]);
  });

  test('a closed session tells nothing that arrives later', async () => {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const f = up({
      '/props': async () => {
        await gate;
        return Response.json(llamaProps());
      },
    });
    const { engine, events } = await engineOn(f);
    const s = open(engine, 'm', 'm');
    await until(() => f.paths.includes('/props'));
    await s.close();
    answer();
    // Another session waits for the same read; by then the closed one's look has run too.
    const t = open(engine, 'm', 'm');
    await t.serverInfoReady?.();
    await until(() => told(events.seen, t.id, 'slots_pinned').length === 1);
    expect(told(events.seen, s.id, 'slots_pinned')).toEqual([]);
  });
});
