// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c seams (D-207): the scheduler's locality from the engine's connections (connectionLocality), and
// RP_CORE_RECALL, the recall mode default's override read once per engine (test/preload.ts: lexical).
import { afterEach, describe, expect, test } from 'bun:test';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import type { EngineCtx } from '../../src/engine/context.ts';
import { Engine, type RecallDefaultCtx } from '../../src/engine/engine.ts';
import { connectionLocality, createScheduler, declaredLocality, type LocalityConnection } from '../../src/engine/sched.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { tmpHome } from '../helpers.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';

const plain = createScriptedProvider([]);

/** A connection as the engine's tests build them (script: origin, `local: true` for windows and timeouts). */
const scriptConn = (id: string, more: Partial<Connection> = {}): Connection => ({ id, provider: plain, caps: SCRIPT_CAPS, origin: `script:${id}`, local: true, ...more });

/** A configured HTTP connection (config.ts: `local` = the config's flag when set, else the URL's guess). */
const configured = (id: string, baseUrl: string, local: boolean): Connection => ({
  id,
  provider: plain,
  caps: SCRIPT_CAPS,
  origin: new URL(baseUrl).origin,
  local,
  dialect: 'openai-chat',
  baseUrl,
});

describe('declaredLocality', () => {
  test('a configured connection says its `local`; an in-process one only when its provider says so', () => {
    expect(declaredLocality(configured('a', 'http://127.0.0.1:8080/v1', false))).toBe(false);
    expect(declaredLocality(configured('b', 'https://api.example.com/v1', true))).toBe(true);
    expect(declaredLocality(scriptConn('s'))).toBeUndefined();
    expect(declaredLocality(scriptConn('t', { provider: createScriptedProvider([], { localOrigin: true }) }))).toBe(true);
    expect(declaredLocality(scriptConn('u', { provider: createScriptedProvider([], { localOrigin: false }) }))).toBe(false);
  });
});

describe('connectionLocality', () => {
  test('per origin: the connections on it decide, else isLocalOrigin', () => {
    const conns: LocalityConnection[] = [
      configured('tunnel', 'https://gpu.example.com/v1', true),
      configured('lan', 'http://192.168.1.20:5001/v1', false),
      scriptConn('old'),
      scriptConn('gpu', { provider: createScriptedProvider([], { localOrigin: true }) }),
      scriptConn('far', { provider: createScriptedProvider([], { localOrigin: false }), origin: 'http://127.0.0.1:5005' }),
    ];
    const isLocal = connectionLocality(() => conns);
    expect(isLocal('https://gpu.example.com')).toBe(true);
    expect(isLocal('http://192.168.1.20:5001')).toBe(false);
    // The M5b test connections (script:, local: true, a plain script) stay remote.
    expect(isLocal('script:old')).toBe(false);
    expect(isLocal('script:gpu')).toBe(true);
    expect(isLocal('http://127.0.0.1:5005')).toBe(false);
    // Origins no connection names: the URL's guess.
    expect(isLocal('http://127.0.0.1:11434')).toBe(true);
    expect(isLocal('https://openrouter.ai:443')).toBe(false);
    expect(isLocal('script:nobody')).toBe(false);
  });

  test('connections that disagree on one origin: local wins', () => {
    const remote = configured('a', 'http://10.0.0.5:8000/v1', false);
    const local = configured('b', 'http://10.0.0.5:8000/v1', true);
    expect(connectionLocality(() => [remote, local])('http://10.0.0.5:8000')).toBe(true);
    expect(connectionLocality(() => [local, remote])('http://10.0.0.5:8000')).toBe(true);
    expect(connectionLocality(() => [remote])('http://10.0.0.5:8000')).toBe(false);
  });

  test('read when asked (a connection added later counts); a custom fallback replaces isLocalOrigin', () => {
    const conns: LocalityConnection[] = [];
    const isLocal = connectionLocality(() => conns, (o) => o === 'script:fallback');
    expect(isLocal('script:late')).toBe(false);
    conns.push(scriptConn('late', { provider: createScriptedProvider([], { localOrigin: true }) }));
    expect(isLocal('script:late')).toBe(true);
    expect(isLocal('script:fallback')).toBe(true);
    expect(isLocal('http://127.0.0.1:1')).toBe(false);
  });

  test('in a scheduler: a script that says it is local gets the local rules and the idle gate, touched before its first call', async () => {
    const timers = fakeTimers();
    const conns = [scriptConn('gpu', { provider: createScriptedProvider([], { localOrigin: true }) }), scriptConn('old')];
    const sched = createScheduler({ timers, isLocal: connectionLocality(() => conns) });
    sched.touch('script:gpu');
    sched.touch('script:old');
    const gpu = sched.forOrigin('script:gpu', 1);
    const old = sched.forOrigin('script:old', 1);
    expect([gpu.local, old.local]).toEqual([true, false]);
    let got = false;
    const bg = gpu.acquire('background', undefined, { idleDelaySec: 2 }).then((s) => ((got = true), s));
    const remote = await old.acquire('background', undefined, { idleDelaySec: 2 });
    timers.advance(1_999);
    await settle();
    expect(got).toBe(false);
    timers.advance(1);
    (await bg).release();
    remote.release();
  });
});

describe('the engine', () => {
  const engines: EngineHandle[] = [];
  const saved = process.env.RP_CORE_RECALL;
  afterEach(async () => {
    if (saved === undefined) delete process.env.RP_CORE_RECALL;
    else process.env.RP_CORE_RECALL = saved;
    for (const e of engines.splice(0)) await e.close();
  });

  /** The engine's context (a test looks behind the handle). */
  const ctxOf = (e: EngineHandle): EngineCtx & RecallDefaultCtx => (e as unknown as { ctx: EngineCtx & RecallDefaultCtx }).ctx;

  async function open(opts: Partial<Parameters<typeof Engine.open>[0]> = {}): Promise<EngineCtx & RecallDefaultCtx> {
    const engine = await Engine.open({ home: tmpHome(), ...opts });
    engines.push(engine);
    return ctxOf(engine);
  }

  test("its scheduler takes locality from its connections and the provider override", async () => {
    const ctx = await open({
      connections: {
        old: scriptConn('old'),
        gpu: scriptConn('gpu', { provider: createScriptedProvider([], { localOrigin: true }) }),
        lan: configured('lan', 'http://192.168.1.20:5001/v1', false),
      },
      providerOverride: scriptConn('script', { origin: 'script:demo/chat3.jsonl', provider: createScriptedProvider([], { localOrigin: true }) }),
    });
    expect(ctx.sched.forOrigin('script:old', 1).local).toBe(false);
    expect(ctx.sched.forOrigin('script:gpu', 1).local).toBe(true);
    expect(ctx.sched.forOrigin('http://192.168.1.20:5001', 1).local).toBe(false);
    expect(ctx.sched.forOrigin('script:demo/chat3.jsonl', 1).local).toBe(true);
    expect(ctx.sched.forOrigin('http://127.0.0.1:8080', 1).local).toBe(true);
  });

  test('RP_CORE_RECALL=lexical (the test preload) is the recall default; EngineSeams.recall decides instead', async () => {
    expect(process.env.RP_CORE_RECALL).toBe('lexical');
    expect((await open()).recallDefault).toBe('lexical');
    expect((await open({ recall: 'config' })).recallDefault).toBeUndefined();
    expect('recallDefault' in (await open({ recall: 'config' }))).toBe(false);
    expect((await open({ recall: 'off' })).recallDefault).toBe('off');
  });

  test('RP_CORE_RECALL is read once, when the engine opens; only lexical and off override', async () => {
    process.env.RP_CORE_RECALL = 'off';
    const ctx = await open();
    process.env.RP_CORE_RECALL = 'lexical';
    expect(ctx.recallDefault).toBe('off');
    for (const value of ['auto', 'sync', 'prefetch', '', 'LEXICAL']) {
      process.env.RP_CORE_RECALL = value;
      expect((await open()).recallDefault).toBeUndefined();
    }
    delete process.env.RP_CORE_RECALL;
    expect((await open()).recallDefault).toBeUndefined();
  });
});
