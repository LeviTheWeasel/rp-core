// Every Refusal code reachable in M1a, thrown synchronously before any line is written (§6.1).
import { describe, expect, test } from 'bun:test';
import { Refusal, type RefusalCode, type RunTurnOptions, type SessionHandle } from '../../src/engine/api.ts';
import { saveToLibrary } from '../../src/formats/library.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, withUserMessage, writeRaw } from './kit.ts';

function refusal(fn: () => unknown): RefusalCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return e.code;
    throw e;
  }
  throw new Error('expected a Refusal');
}

/** runTurn must refuse with `code` and write nothing. */
function refuses(home: string, s: SessionHandle, opts: RunTurnOptions, code: RefusalCode): void {
  const before = entriesOf(home, s.id).length;
  expect(refusal(() => s.runTurn(opts))).toBe(code);
  expect(entriesOf(home, s.id)).toHaveLength(before);
  expect(s.busy()).toBe(false);
}

describe('runTurn refusals', () => {
  test('stale_version', async () => {
    const { engine, home } = await rig([]);
    const { s, version } = withUserMessage(engine);
    refuses(home, s, { kind: 'reply', expectedVersion: version - 1 }, 'stale_version');
    await engine.close();
  });

  test('session_busy while a turn runs (and on every write verb)', async () => {
    const { engine, home, provider } = await rig(calls([{ pause: 'p' }, { text: 'ok' }]));
    const { s, version, userId } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    expect(refusal(() => s.runTurn({ kind: 'reply', expectedVersion: version }))).toBe('session_busy');
    expect(refusal(() => s.send({ text: 'x', expectedVersion: version }))).toBe('session_busy');
    expect(refusal(() => s.submit({ text: 'x', expectedVersion: version }))).toBe('session_busy');
    expect(refusal(() => s.edit({ messageId: userId, text: 'x', expectedVersion: version }))).toBe('session_busy');
    expect(refusal(() => s.hide({ messageId: userId, hidden: true, expectedVersion: version }))).toBe('session_busy');
    expect(refusal(() => s.select({ messageId: userId, expectedVersion: version }))).toBe('session_busy');
    expect(refusal(() => s.fork({ at: userId }))).toBe('session_busy');
    expect(refusal(() => s.configure({ reasoningShown: true }))).toBe('session_busy');
    expect(refusal(() => s.setPersona({ name: 'Alex', description: '' }))).toBe('session_busy');
    provider.release('p');
    await drain(turn);
    expect(s.busy()).toBe(false);
    void home;
    await engine.close();
  });

  test('held_pending: a held answer left open by recovery blocks new turns and sends', async () => {
    const { engine, home } = await rig([]);
    const { s, version, userId } = withUserMessage(engine);
    await s.close();
    writeRaw(home, s.id, (log) => {
      log.append({ t: 'turn', ts: 'x', turn: 't_held', kind: 'reply', parent: userId, msgId: 'abcdabcd', seed: 1, now: 'x', base: version });
      log.append({ t: 'held', turn: 't_held', body: { blocks: [{ k: 'text', text: 'held answer' }] } });
    });
    const s2 = engine.session(s.id);
    expect(s2.openEvents()).toEqual([]); // held is left open, not recovered
    refuses(home, s2, { kind: 'reply', expectedVersion: s2.version() }, 'held_pending');
    expect(refusal(() => s2.send({ text: 'x', expectedVersion: s2.version() }))).toBe('held_pending');
    await engine.close();
  });

  test('no_connection: the binding names an unknown connection; an unknown explicit fallback', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'nowhere', model: 'm' } } } });
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    refuses(home, s, { kind: 'reply', expectedVersion: sent.version }, 'no_connection');
    const t = withUserMessage(engine);
    refuses(home, t.s, { kind: 'reply', expectedVersion: t.version, fallback: 'nowhere:m' }, 'no_connection');
    // submit refuses before writing the user message
    const before = entriesOf(home, s.id).length;
    expect(refusal(() => s.submit({ text: 'again', expectedVersion: s.version() }))).toBe('no_connection');
    expect(entriesOf(home, s.id)).toHaveLength(before);
    await engine.close();
  });

  test('providerOverride wins over the binding', async () => {
    const { engine: base, home } = await rig([]);
    await base.close();
    const { conn, provider } = (await import('./kit.ts')).scriptConn('override', calls([{ text: 'via override' }]));
    const { engine } = await rig([], { home, extra: { providerOverride: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'nowhere', model: 'm' } } } });
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    const o = await s.runTurn({ kind: 'reply', expectedVersion: sent.version }).result;
    expect(o.type).toBe('done');
    if (o.type === 'done') expect(o.message.gen).toMatchObject({ connection: 'override', model: 'm' });
    expect(provider.requests).toHaveLength(1);
    await engine.close();
  });

  test('preset_missing: not in the library, or invalid', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA, config: { preset: 'nope' } });
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    refuses(home, s, { kind: 'reply', expectedVersion: sent.version }, 'preset_missing');
    const { id } = saveToLibrary(home, 'presets', 'Broken', { name: 'Broken', blocks: [] });
    s.configure({ preset: id });
    refuses(home, s, { kind: 'reply', expectedVersion: sent.version }, 'preset_missing');
    await engine.close();
  });

  test('nothing_to_reply / nothing_to_swipe / nothing_to_continue', async () => {
    const { engine, home } = await rig(calls([{ text: 'An answer.' }]));
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    // head = greeting
    refuses(home, s, { kind: 'reply', expectedVersion: s.version() }, 'nothing_to_reply');
    refuses(home, s, { kind: 'swipe', expectedVersion: s.version() }, 'nothing_to_swipe');
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    // head = user message
    refuses(home, s, { kind: 'swipe', expectedVersion: sent.version }, 'nothing_to_swipe');
    refuses(home, s, { kind: 'continue', expectedVersion: sent.version }, 'nothing_to_continue');
    await drain(s.runTurn({ kind: 'reply', expectedVersion: sent.version }));
    // head = model answer
    refuses(home, s, { kind: 'reply', expectedVersion: s.version() }, 'nothing_to_reply');
    // empty session: no head at all
    const empty = engine.createSession({ character: { name: 'E', description: '', greetings: [] } });
    refuses(home, empty, { kind: 'reply', expectedVersion: empty.version() }, 'nothing_to_reply');
    refuses(home, empty, { kind: 'continue', expectedVersion: empty.version() }, 'nothing_to_continue');
    await engine.close();
  });

  test('continue_target_hidden and continue_target_blank', async () => {
    const { engine, home } = await rig(calls([{ text: 'An answer.' }]));
    const { s, version } = withUserMessage(engine);
    const t = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(t);
    const blank = s.edit({ messageId: t.messageId, text: '   ', expectedVersion: s.version() });
    refuses(home, s, { kind: 'continue', expectedVersion: blank.version }, 'continue_target_blank');
    const back = s.edit({ messageId: t.messageId, text: 'An answer.', expectedVersion: blank.version });
    const hidden = s.hide({ messageId: t.messageId, hidden: true, expectedVersion: back.version });
    refuses(home, s, { kind: 'continue', expectedVersion: hidden.version }, 'continue_target_hidden');
    await engine.close();
  });

  test('invalid_params: guidance off a swipe, guidance too long, bad kind / onError / fallback', async () => {
    const { engine, home } = await rig(calls([{ text: 'An answer.' }]));
    const { s, version } = withUserMessage(engine);
    refuses(home, s, { kind: 'reply', expectedVersion: version, guidance: 'rain' }, 'invalid_params');
    refuses(home, s, { kind: 'bogus' as 'reply', expectedVersion: version }, 'invalid_params');
    refuses(home, s, { kind: 'reply', expectedVersion: version, onError: 'explode' as 'drop' }, 'invalid_params');
    refuses(home, s, { kind: 'reply', expectedVersion: version, fallback: 'no-colon' }, 'invalid_params');
    refuses(home, s, { kind: 'reply', expectedVersion: 1.5 }, 'invalid_params');
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    refuses(home, s, { kind: 'swipe', expectedVersion: s.version(), guidance: 'x'.repeat(10_001) }, 'invalid_params');
    // blank guidance on a reply is simply no guidance (as Bunraku) — not refused
    const sent = s.send({ text: 'More', expectedVersion: s.version() });
    expect(() => s.runTurn({ kind: 'reply', expectedVersion: sent.version, guidance: '   ' })).not.toThrow();
    await engine.close();
  });

  test('not_found for unknown messages; session_locked / session_not_found on open', async () => {
    const { engine } = await rig([]);
    const { s, version } = withUserMessage(engine);
    expect(refusal(() => s.select({ messageId: 'ffffffff', expectedVersion: version }))).toBe('not_found');
    expect(refusal(() => engine.session(s.id))).toBe('session_locked');
    expect(refusal(() => engine.session('s_00000000'))).toBe('session_not_found');
    expect(refusal(() => engine.session('../escape'))).toBe('session_not_found');
    await engine.close();
  });
});
