// M1b: the engine reads the caps of the bound model (Connection.capsFor(model) ?? conn.caps, §8.2)
// everywhere — window, assemble's prefill rule, shape, the request, the fallback route, the
// answer-in-reasoning rule, the origin semaphore — and two connections on one origin share its places
// (§8.8, D-84).
import { describe, expect, test } from 'bun:test';
import type { TurnOutcome } from '../../src/engine/api.ts';
import { saveToLibrary } from '../../src/formats/library.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import { createScriptedProvider } from '../../src/providers/scripted.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, textOf, until } from '../engine/kit.ts';
import { fakeConn } from './fake.ts';

const codes = (evs: readonly Event[]): string[] => evs.filter((e) => e.type === 'notice').map((e) => (e as { code: string }).code);

function expectDone(o: TurnOutcome): Extract<TurnOutcome, { type: 'done' }> {
  if (o.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(o)}`);
  return o;
}

/** A preset with a prefill in the library of `home`; returns its id. */
function prefillPreset(home: string, prefill = '*{{char}} nods*'): string {
  return saveToLibrary(home, 'presets', 'Prefilled', { ...BUILTIN_PRESET, name: 'Prefilled', prefill }).id;
}

describe('capsFor(model) decides the prefill', () => {
  test("model caps prefill 'none' beat the connection default 'assistant-last'", async () => {
    const provider = createScriptedProvider(calls([{ text: 'One.' }], [{ text: 'Two.' }]));
    const conn = fakeConn('m', provider, { caps: { prefill: 'assistant-last' }, perModel: { strict: { prefill: 'none' } } });
    const { engine, home } = await rig([], { connections: { m: conn } });
    const preset = prefillPreset(home);
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset, roles: { narrator: { conn: 'm', model: 'strict' } } } });
    const v1 = s.send({ text: 'Hi.', expectedVersion: s.version() }).version;
    const first = await drain(s.runTurn({ kind: 'reply', expectedVersion: v1 }));

    expect(conn.capsAsked).toContain('strict');
    expect(provider.requests[0]!.prefill).toBeUndefined();
    expect(provider.requests[0]!.caps.prefill).toBe('none');
    expect(first.some((e) => e.type === 'prefill')).toBe(false);
    expect(codes(first)).toEqual(['prefill_unsupported']);
    const msg = entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.role === 'assistant' && e.turn !== undefined)!;
    expect(msg.trace?.prefill).toBe('unsupported');
    expect(msg.gen?.prefill).toBeUndefined();

    // Second turn: the notice is not repeated (once per session).
    const v2 = s.send({ text: 'Again.', expectedVersion: s.version() }).version;
    const second = await drain(s.runTurn({ kind: 'reply', expectedVersion: v2 }));
    expect(codes(second)).toEqual([]);
    await engine.close();
  });

  test("model caps 'assistant-last' beat a connection default 'none'", async () => {
    const provider = createScriptedProvider(calls([{ text: 'and so it begins.' }]));
    const conn = fakeConn('m', provider, { caps: { prefill: 'none' }, perModel: { open: { prefill: 'assistant-last' } } });
    const { engine, home } = await rig([], { connections: { m: conn } });
    const preset = prefillPreset(home);
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset, roles: { narrator: { conn: 'm', model: 'open' } } } });
    const v = s.send({ text: 'Go on.', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
    const evs = await drain(turn);
    expect(provider.requests[0]!.prefill).toBe('*Mira nods*');
    expect(codes(evs)).toEqual([]);
    expect(expectDone(await turn.result).message.gen?.prefill).toBe('*Mira nods*');
    await engine.close();
  });

  test('without capsFor the connection caps apply', async () => {
    const provider = createScriptedProvider(calls([{ text: 'Ok.' }]));
    const conn = fakeConn('m', provider, { caps: { prefill: 'none' } });
    expect(conn.capsFor).toBeUndefined();
    const { engine, home } = await rig([], { connections: { m: conn } });
    const preset = prefillPreset(home);
    const s = engine.createSession({ character: MIRA, config: { preset, roles: { narrator: { conn: 'm', model: 'any' } } } });
    const v = s.send({ text: 'Hi.', expectedVersion: s.version() }).version;
    const evs = await drain(s.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(provider.requests[0]!.prefill).toBeUndefined();
    expect(codes(evs)).toEqual(['prefill_unsupported']);
    await engine.close();
  });
});

describe('capsFor(model) everywhere else', () => {
  test('the request carries the model caps, and the window follows their contextLength', async () => {
    const provider = createScriptedProvider(calls([{ text: 'Ok.' }]));
    const conn = fakeConn('m', provider, { caps: { contextLength: 8192 }, perModel: { small: { contextLength: 4096 } } });
    const { engine, home } = await rig([], { connections: { m: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'm', model: 'small' } } } });
    const v = s.send({ text: 'Hi.', expectedVersion: s.version() }).version;
    await drain(s.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(provider.requests[0]!.caps.contextLength).toBe(4096);
    const msg = entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.turn !== undefined)!;
    expect(msg.trace?.window).toBe(4096);
    await engine.close();
  });

  test('the fallback route is shaped with the fallback model caps', async () => {
    // Primary fails before output with a retryable status twice (retry, then fallback).
    const primary = createScriptedProvider(
      calls([{ error: { code: 'overloaded', status: 503 } }], [{ error: { code: 'overloaded', status: 503 } }]),
    );
    const backup = createScriptedProvider(calls([{ text: 'From the backup.' }]));
    const a = fakeConn('a', primary, { caps: { prefill: 'assistant-last' } });
    const b = fakeConn('b', backup, { caps: { prefill: 'assistant-last' }, perModel: { strict: { prefill: 'none' } } });
    const { engine, home } = await rig([], { connections: { a, b } });
    const preset = prefillPreset(home);
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset, roles: { narrator: { conn: 'a', model: 'x' } } } });
    const v = s.send({ text: 'Hi.', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v, fallback: 'b:strict' });
    const evs = await drain(turn);
    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[0]!.prefill).toBe('*Mira nods*');
    expect(backup.requests).toHaveLength(1);
    expect(backup.requests[0]!.caps.prefill).toBe('none');
    expect(backup.requests[0]!.prefill).toBeUndefined();
    expect(b.capsAsked).toContain('strict');
    expect(codes(evs)).toContain('prefill_unsupported');
    const done = expectDone(await turn.result);
    expect(textOf(done.message)).toBe('From the backup.');
    expect(done.message.gen).toMatchObject({ connection: 'b', model: 'strict' });
    await engine.close();
  });

  test('answerInReasoning is read from the model caps', async () => {
    const provider = createScriptedProvider(calls([{ reasoning: 'The answer lives here.' }]));
    const conn = fakeConn('m', provider, { perModel: { r1: { reasoning: { output: 'reasoning_content', control: 'none', canDisable: false, echo: 'never', answerInReasoning: true } } } });
    const { engine } = await rig([], { connections: { m: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'm', model: 'r1' } } } });
    const v = s.send({ text: 'Hi.', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
    await drain(turn);
    expect(textOf(expectDone(await turn.result).message)).toBe('The answer lives here.');
    await engine.close();
  });

  test('a capsFor that throws refuses the turn before anything is written', async () => {
    const provider = createScriptedProvider([]);
    const conn = fakeConn('m', provider);
    conn.capsFor = () => {
      throw new Error('broken caps row');
    };
    const { engine } = await rig([], { connections: { m: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'm', model: 'x' } } } });
    const v = s.send({ text: 'Hi.', expectedVersion: s.version() }).version;
    expect(() => s.runTurn({ kind: 'reply', expectedVersion: v })).toThrow(expect.objectContaining({ name: 'Refusal', code: 'no_connection' }));
    expect(s.version()).toBe(v);
    expect(s.busy()).toBe(false);
    await engine.close();
  });
});

describe('the origin semaphore (§8.8, D-84)', () => {
  /** Two sessions, narrators on connections a and b; a's turn pauses until released. */
  async function twoOnOneOrigin(capA: number, capB: number, opts: { modelCapB?: number } = {}) {
    const origin = 'http://127.0.0.1:8080';
    const pa = createScriptedProvider(calls([{ text: 'A ' }, { pause: 'a' }, { text: 'done.' }]));
    const pb = createScriptedProvider(calls([{ text: 'B done.' }]));
    const a = fakeConn('a', pa, { origin, caps: { maxInFlight: capA } });
    const b = fakeConn('b', pb, {
      origin,
      caps: { maxInFlight: capB },
      ...(opts.modelCapB !== undefined ? { perModel: { m: { maxInFlight: opts.modelCapB } } } : {}),
    });
    const { engine } = await rig([], { connections: { a, b } });
    const s1 = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'a', model: 'm' } } } });
    const s2 = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'b', model: 'm' } } } });
    const t1 = s1.runTurn({ kind: 'reply', expectedVersion: s1.send({ text: 'one', expectedVersion: s1.version() }).version });
    const e1 = drain(t1);
    await until(() => pa.requests.length === 1);
    const t2 = s2.runTurn({ kind: 'reply', expectedVersion: s2.send({ text: 'two', expectedVersion: s2.version() }).version });
    const e2 = drain(t2);
    return { engine, pa, pb, t1, t2, e1, e2 };
  }

  test('two connection ids on one origin share its places: the smaller capacity wins', async () => {
    const r = await twoOnOneOrigin(2, 1);
    // b's call waits behind a's although a's connection alone would allow 2 in flight.
    await new Promise((res) => setTimeout(res, 30));
    expect(r.pb.requests).toHaveLength(0);
    expect(r.t2.messageId).toBeString();
    r.pa.release('a');
    await r.e1;
    await r.e2;
    expect(r.pb.requests).toHaveLength(1);
    expect((await r.t1.result).type).toBe('done');
    expect((await r.t2.result).type).toBe('done');
    await r.engine.close();
  });

  test('the smaller capacity wins whichever connection asks first', async () => {
    const r = await twoOnOneOrigin(1, 2);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.pb.requests).toHaveLength(0);
    r.pa.release('a');
    await Promise.all([r.e1, r.e2]);
    expect(r.pb.requests).toHaveLength(1);
    await r.engine.close();
  });

  test('with room for both, both run at once', async () => {
    const r = await twoOnOneOrigin(2, 2);
    await until(() => r.pb.requests.length === 1);
    expect((await r.t2.result).type).toBe('done');
    // a is still paused while b finished: they ran side by side.
    expect(r.pa.requests).toHaveLength(1);
    r.pa.release('a');
    await Promise.all([r.e1, r.e2]);
    await r.engine.close();
  });

  test('the capacity comes from the model caps (capsFor), not the connection default', async () => {
    const r = await twoOnOneOrigin(2, 2, { modelCapB: 1 });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.pb.requests).toHaveLength(0);
    r.pa.release('a');
    await Promise.all([r.e1, r.e2]);
    expect(r.pb.requests).toHaveLength(1);
    await r.engine.close();
  });
});
