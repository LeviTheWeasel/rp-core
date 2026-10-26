// M1b: the API key is resolved per call (Connection.resolveKey, D-73) and handed to the provider in
// ProviderEnv; an unavailable key fails the turn before any output (auth / key_unavailable), with no
// retry and no fallback (§6.6, §13).
import { describe, expect, test } from 'bun:test';
import type { TurnOutcome } from '../../src/engine/api.ts';
import { createScriptedProvider } from '../../src/providers/scripted.ts';
import { ProviderError } from '../../src/providers/types.ts';
import type { EndEntry } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, MIRA, rig, types } from '../engine/kit.ts';
import { answer, fakeConn, fakeProvider } from './fake.ts';

function expectFailed(o: TurnOutcome): Extract<TurnOutcome, { type: 'failed' }> {
  if (o.type !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(o)}`);
  return o;
}

const keyError = (): ProviderError =>
  new ProviderError({ category: 'auth', code: 'key_unavailable', message: "OPENROUTER_API_KEY is not set (connection 'or')" });

describe('resolving the key', () => {
  test('resolveKey is awaited before the call and its key reaches ProviderEnv', async () => {
    let asked = 0;
    const provider = fakeProvider(() => answer('Hi.'));
    const conn = fakeConn('or', provider, {
      key: 'static-ignored',
      resolveKey: async () => {
        asked++;
        return 'sk-test-resolved';
      },
    });
    const { engine } = await rig([], { connections: { or: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'x' } } } });
    expect(asked).toBe(0); // lazy: nothing runs before the first call
    const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
    await drain(turn);
    expect((await turn.result).type).toBe('done');
    expect(asked).toBe(1);
    expect(provider.envs[0]!.key).toBe('sk-test-resolved');
    await engine.close();
  });

  test('without resolveKey the static key is used, and null when there is none', async () => {
    const withKey = fakeProvider(() => answer('Hi.'));
    const without = fakeProvider(() => answer('Hi.'));
    const a = fakeConn('a', withKey, { key: 'sk-static' });
    const b = fakeConn('b', without);
    const { engine } = await rig([], { connections: { a, b } });
    for (const id of ['a', 'b']) {
      const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: id, model: 'x' } } } });
      const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
      await drain(s.runTurn({ kind: 'reply', expectedVersion: v }));
    }
    expect(withKey.envs[0]!.key).toBe('sk-static');
    expect(without.envs[0]!.key).toBeNull();
    await engine.close();
  });

  test('resolveKey resolving null falls back to the static key', async () => {
    const provider = fakeProvider(() => answer('Hi.'));
    const conn = fakeConn('a', provider, { key: 'sk-static', resolveKey: async () => null });
    const { engine } = await rig([], { connections: { a: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'a', model: 'x' } } } });
    await drain(s.runTurn({ kind: 'reply', expectedVersion: s.send({ text: 'x', expectedVersion: s.version() }).version }));
    expect(provider.envs[0]!.key).toBe('sk-static');
    await engine.close();
  });
});

describe('key_unavailable', () => {
  test('fails the turn before any output: failed{auth, key_unavailable} and end{failed}, the provider never called', async () => {
    const provider = fakeProvider(() => answer('never'));
    const conn = fakeConn('or', provider, { resolveKey: () => Promise.reject(keyError()) });
    const { engine, home } = await rig([], { connections: { or: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'x' } } } });
    const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
    const evs = await drain(turn);

    expect(types(evs)).toEqual(['start', 'failed']);
    const failed = expectFailed(await turn.result);
    expect(failed).toMatchObject({ category: 'auth', code: 'key_unavailable', draft: '' });
    expect(failed.message).toContain('OPENROUTER_API_KEY');
    expect(provider.requests).toHaveLength(0);

    const entries = entriesOf(home, s.id).filter((e) => e.seq > v);
    expect(entries.map((e) => e.t)).toEqual(['turn', 'prep', 'end']);
    expect(entries.at(-1) as EndEntry).toMatchObject({ outcome: 'failed', code: 'key_unavailable' });
    expect(s.busy()).toBe(false);
    expect(s.view().head).not.toBeNull();
    await engine.close();
  });

  test('no retry and no fallback for an auth failure', async () => {
    const primary = fakeProvider(() => answer('never'));
    const backup = createScriptedProvider(calls([{ text: 'From the backup.' }]));
    const a = fakeConn('a', primary, { resolveKey: () => Promise.reject(keyError()) });
    const b = fakeConn('b', backup);
    const { engine } = await rig([], { connections: { a, b } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'a', model: 'x', fallback: { conn: 'b', model: 'y' } } } } });
    const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
    const evs = await drain(turn);
    expect(evs.some((e) => e.type === 'retry')).toBe(false);
    expect(evs.some((e) => e.type === 'notice' && e.code === 'fallback')).toBe(false);
    expect(backup.requests).toHaveLength(0);
    expect(expectFailed(await turn.result)).toMatchObject({ category: 'auth', code: 'key_unavailable' });
    await engine.close();
  });

  test('a provider auth_failed with a 401 is not retried or sent to the fallback either', async () => {
    const primary = createScriptedProvider(calls([{ error: { code: 'auth_failed', status: 401 } }]));
    const backup = createScriptedProvider(calls([{ text: 'From the backup.' }]));
    const { engine } = await rig([], { connections: { a: fakeConn('a', primary), b: fakeConn('b', backup) } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'a', model: 'x' } } } });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.send({ text: 'x', expectedVersion: s.version() }).version, fallback: 'b:y' });
    await drain(turn);
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests).toHaveLength(0);
    expect(expectFailed(await turn.result)).toMatchObject({ category: 'auth', code: 'auth_failed' });
    await engine.close();
  });

  test('a rejection that is not a ProviderError becomes key_unavailable with a fixed message', async () => {
    const provider = fakeProvider(() => answer('never'));
    const conn = fakeConn('or', provider, { resolveKey: () => Promise.reject(new Error('secret-tool said: hunter2')) });
    const { engine } = await rig([], { connections: { or: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'x' } } } });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.send({ text: 'x', expectedVersion: s.version() }).version });
    await drain(turn);
    const failed = expectFailed(await turn.result);
    expect(failed).toMatchObject({ category: 'auth', code: 'key_unavailable' });
    expect(failed.message).not.toContain('hunter2');
    expect(failed.message).toContain("'or'");
    await engine.close();
  });

  test('a Stop while the key is being resolved ends the turn as stopped-empty', async () => {
    const provider = fakeProvider(() => answer('never'));
    let unblock: (k: string) => void = () => {};
    const conn = fakeConn('or', provider, { resolveKey: () => new Promise<string>((r) => (unblock = r)) });
    const { engine, home } = await rig([], { connections: { or: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'x' } } } });
    const v = s.send({ text: 'x', expectedVersion: s.version() }).version;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
    const evs = drain(turn);
    await new Promise((r) => setTimeout(r, 10));
    turn.stop();
    expect(await turn.result).toEqual({ type: 'stopped', message: null });
    await evs;
    unblock('late-key'); // settles after the turn: ignored
    expect(provider.requests).toHaveLength(0);
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'stopped-empty' });
    await engine.close();
  });
});
