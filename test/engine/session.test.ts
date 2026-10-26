// Engine sessions: creation, greetings, the non-turn verbs, locking, fork, events, close.
import { describe, expect, test } from 'bun:test';
import { Refusal } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import { calls, drain, entriesOf, LEVI, MIRA, ONE_GREETING, rig, textOf, withUserMessage } from './kit.ts';

describe('createSession', () => {
  test('greetings are sibling roots with identity macros expanded; head on greeting 0', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    const view = s.view();
    expect(view.path).toHaveLength(1);
    const g0 = view.path[0]!;
    expect(textOf(g0)).toBe('Hello, Levi. I am Mira.');
    expect(g0.gen).toEqual({ kind: 'greeting' });
    expect(g0.parent).toBeNull();
    expect(g0.swipe).toEqual({ index: 0, count: 2 });
    expect(view.tails).toHaveLength(1);

    const entries = entriesOf(home, s.id);
    expect(entries.map((e) => e.t)).toEqual(['msg', 'msg', 'head']);
    expect(entries[2]).toMatchObject({ t: 'head', leaf: g0.id });
    expect(s.header().title).toBe('Mira');
    expect(s.header().config.preset).toBe('builtin');
    await engine.close();
  });

  test('one greeting needs no head entry; config is deep-merged over the defaults; title kept', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({
      character: ONE_GREETING,
      title: 'Harbour',
      config: { narrator: { maxRounds: 2 }, roles: { narrator: { conn: 'script', model: 'm2' } } },
    });
    expect(entriesOf(home, s.id).map((e) => e.t)).toEqual(['msg']);
    const cfg = s.header().config;
    expect(cfg.narrator).toEqual({ maxRounds: 2, prefillVsTools: 'prefill' });
    expect(cfg.roles.narrator.model).toBe('m2');
    expect(cfg.director.enabled).toBe(false);
    expect(s.header().title).toBe('Harbour');
    // {{user}} without a persona is 'User'.
    const s2 = engine.createSession({ character: { name: 'A', description: '', greetings: ['Hi {{user}}', '  '] } });
    expect(textOf(s2.view().path[0]!)).toBe('Hi User');
    expect(entriesOf(home, s2.id)).toHaveLength(1); // the blank greeting is skipped
    await engine.close();
  });

  test('no greetings: an empty path; the first send is a root user message', async () => {
    const { engine } = await rig([]);
    const s = engine.createSession({ character: { name: 'A', description: '', greetings: [] } });
    expect(s.view().head).toBeNull();
    const sent = s.send({ text: 'hello', expectedVersion: s.version() });
    expect(s.view().path.map((m) => m.id)).toEqual([sent.messageId]);
    expect(s.view().path[0]!.parent).toBeNull();
    await engine.close();
  });
});

describe('verbs', () => {
  test('send / edit / hide / select bump the version and emit changed', async () => {
    const { engine } = await rig([]);
    const tail = engine.events();
    const seen: Event[] = [];
    const reading = (async () => {
      for await (const ev of tail) seen.push(ev);
    })();
    const { s, version, userId } = withUserMessage(engine, 'Hi.');
    expect(s.view().head).toBe(userId);
    const g0 = s.view().path[0]!.id;

    const e = s.edit({ messageId: userId, text: 'Hello!', expectedVersion: version });
    expect(e.version).toBeGreaterThan(version);
    const u = s.view().path.at(-1)!;
    expect(textOf(u)).toBe('Hello!');
    expect(u.edited).toBe(true);

    const h = s.hide({ messageId: userId, hidden: true, expectedVersion: e.version });
    expect(s.view().path.at(-1)!.hidden).toBe(true);

    // select the second greeting: the head moves there, the first greeting's branch becomes a tail
    const g1 = s.view().tails[0]!;
    const sel = s.select({ messageId: g1, expectedVersion: h.version });
    expect(s.view().head).toBe(g1);
    // selecting where the head already is writes nothing
    expect(s.select({ messageId: g1, expectedVersion: sel.version }).version).toBe(sel.version);
    // select the first greeting again: the head goes to its newest descendant, the user message
    s.select({ messageId: g0, expectedVersion: sel.version });
    expect(s.view().head).toBe(userId);

    await engine.close();
    await reading;
    const changed = seen.filter((x) => x.type === 'changed').map((x) => (x as { change: string }).change);
    expect(changed.slice(0, 4)).toEqual(['msg', 'edit', 'hide', 'head']);
  });

  test('select {exact: true} rewinds onto the message itself; the old continuation becomes a tail', async () => {
    const { engine } = await rig([]);
    const { s, version, userId } = withUserMessage(engine, 'Hi.');
    const g0 = s.view().path[0]!.id;
    // Without exact, selecting a message on a straight path goes back to the newest descendant: no-op.
    expect(s.select({ messageId: g0, expectedVersion: version }).version).toBe(version);
    expect(s.view().head).toBe(userId);
    const r = s.select({ messageId: g0, expectedVersion: version, exact: true });
    expect(r.version).toBeGreaterThan(version);
    expect(s.view().head).toBe(g0);
    expect(s.view().tails).toContain(userId);
    expect(() => s.select({ messageId: g0, expectedVersion: r.version, exact: 'yes' as unknown as boolean })).toThrow(Refusal);
    await engine.close();
  });

  test('stale_version, not_found and invalid_params on the verbs, with nothing written', async () => {
    const { engine, home } = await rig([]);
    const { s, version, userId } = withUserMessage(engine);
    const before = entriesOf(home, s.id).length;
    const code = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        if (e instanceof Refusal) return e.code;
        throw e;
      }
      return 'none';
    };
    expect(code(() => s.send({ text: 'x', expectedVersion: version - 1 }))).toBe('stale_version');
    expect(code(() => s.edit({ messageId: userId, text: 'x', expectedVersion: version + 5 }))).toBe('stale_version');
    expect(code(() => s.edit({ messageId: 'nope', text: 'x', expectedVersion: version }))).toBe('not_found');
    expect(code(() => s.hide({ messageId: 'nope', hidden: true, expectedVersion: version }))).toBe('not_found');
    expect(code(() => s.select({ messageId: 'nope', expectedVersion: version }))).toBe('not_found');
    expect(code(() => s.send({ text: 'x', expectedVersion: version, greetingIndex: 9 }))).toBe('not_found');
    expect(code(() => s.send({ text: 'x', expectedVersion: version, greetingIndex: -1 }))).toBe('invalid_params');
    expect(code(() => s.fork({ at: 'nope' }))).toBe('not_found');
    expect(code(() => s.configure({ roles: { narrator: { conn: 5 as unknown as string } } }))).toBe('invalid_params');
    expect(entriesOf(home, s.id)).toHaveLength(before);
    await engine.close();
  });

  test('send under a chosen greeting writes one msg whose parent is that greeting', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    const g1 = s.view().tails[0]!;
    const before = entriesOf(home, s.id).length;
    const sent = s.send({ text: 'Hm?', expectedVersion: s.version(), greetingIndex: 1 });
    expect(entriesOf(home, s.id)).toHaveLength(before + 1);
    expect(s.view().path.map((m) => m.id)).toEqual([g1, sent.messageId]);
    await engine.close();
  });

  test('configure appends a config entry without changing the version', async () => {
    const { engine, home } = await rig([]);
    const { s, version } = withUserMessage(engine);
    s.configure({ roles: { narrator: { conn: 'script', model: 'bigger' } } });
    expect(s.version()).toBe(version);
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'config' });
    await engine.close();
    // The patch survives a reopen.
    const again = (await rig([], { home })).engine;
    const s2 = again.session(s.id);
    expect(s2.version()).toBe(version);
    await again.close();
  });

  test('fork copies the path into a new, unopened session', async () => {
    const { engine } = await rig(calls([{ text: 'A reply.' }]));
    const { s, version } = withUserMessage(engine);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    const at = s.view().path[1]!.id; // the user message
    const forkId = s.fork({ at });
    expect(forkId).not.toBe(s.id);
    const f = engine.session(forkId);
    expect(f.header().fork).toEqual({ from: s.id, at });
    expect(f.view().path.map((m) => m.id)).toEqual(s.view().path.slice(0, 2).map((m) => m.id));
    await engine.close();
  });
});

describe('open and lock', () => {
  test('a second session(id) while open is session_locked; unknown ids are session_not_found', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA });
    expect(() => engine.session(s.id)).toThrow(Refusal);
    try {
      engine.session(s.id);
    } catch (e) {
      expect((e as Refusal).code).toBe('session_locked');
    }
    // Another engine on the same home sees the lock file.
    const other = (await rig([], { home })).engine;
    try {
      other.session(s.id);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Refusal).code).toBe('session_locked');
    }
    try {
      other.session('s_nothere');
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Refusal).code).toBe('session_not_found');
    }
    await s.close();
    // Released: the other engine can open it now.
    const reopened = other.session(s.id);
    expect(reopened.view().path).toHaveLength(1);
    await other.close();
    await engine.close();
  });

  test('listSessions lists created sessions with their titles', async () => {
    const { engine } = await rig([]);
    const a = engine.createSession({ character: MIRA });
    const b = engine.createSession({ character: ONE_GREETING });
    const ids = engine.listSessions().map((r) => r.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(engine.listSessions().find((r) => r.id === b.id)?.title).toBe('Vera');
    await engine.close();
  });

  test('engine.events() sees every event of a turn, in order, and ends on close', async () => {
    const { engine } = await rig(calls([{ text: 'One ' }, { text: 'two.' }, { usage: { inputTotal: 10, outputTotal: 2 } }]));
    const tail = engine.events();
    const seen: Event[] = [];
    const reading = (async () => {
      for await (const ev of tail) seen.push(ev);
    })();
    const { s, version } = withUserMessage(engine);
    const turnEvents = await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    await engine.close();
    await reading;
    expect(turnEvents.map((e) => e.type)).toContain('usage');
    // Every turn event (changed and usage included) is on the tail, in the same order.
    const tailTurn = seen.slice(seen.findIndex((e) => e.type === 'start'));
    expect(tailTurn).toEqual(turnEvents);
  });

  test('close() stops a running turn keeping its partial text, and releases the lock', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'Partial' }, { pause: 'p' }, { text: ' rest' }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const it = turn.events[Symbol.asyncIterator]();
    for (;;) {
      const r = await it.next();
      if (r.done || r.value.type === 'text') break;
    }
    await s.close();
    const outcome = await turn.result;
    expect(outcome.type).toBe('stopped');
    if (outcome.type === 'stopped') {
      expect(textOf(outcome.message!)).toBe('Partial');
      expect(outcome.message!.gen?.finish).toBe('stopped');
    }
    provider.release('p');
    const other = (await rig([], { home })).engine;
    const again = other.session(s.id);
    expect(again.openEvents()).toEqual([]); // nothing to recover: the turn was closed
    expect(textOf(again.view().path.at(-1)!)).toBe('Partial');
    await other.close();
    await engine.close();
  });
});
