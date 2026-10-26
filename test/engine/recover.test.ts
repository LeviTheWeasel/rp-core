// Crash recovery on open (§6.7): partial journals are written through the real log, then reopened.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionHandle } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { EditEntry, Entry, MsgEntry, Trace, TurnKind } from '../../src/session/entries.ts';
import { sessionsDir, type SessionLog } from '../../src/session/log.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, textOf, until, withUserMessage, writeRaw } from './kit.ts';

const TRACE: Trace = {
  seed: 42,
  now: '2026-10-26T12:00:00.000Z',
  window: 8192,
  reserve: 2048,
  tokens: { estimated: 100 },
  blocks: [],
  lore: { fired: [], cut: [], budget: 0 },
  recap: { ids: [], arcs: [], boundary: null },
  prefill: null,
  macros: { unknown: [] },
  trimmed: null,
  calls: [],
  agents: {},
  presetHash: 'abc',
  loreHashes: {},
};

const TS = '2026-10-26T12:00:00.000Z';

function turnLine(log: SessionLog, o: { turn: string; kind: TurnKind; parent: string; target?: string; msgId: string; base: number }): void {
  log.append({ t: 'turn', ts: TS, turn: o.turn, kind: o.kind, parent: o.parent, ...(o.target ? { target: o.target } : {}), msgId: o.msgId, seed: 42, now: TS, base: o.base });
}

/** G, U (closed): returns ids and the version. */
async function closedWithUser() {
  const r = await rig(calls([{ text: 'She nods.' }]));
  const { s, version, userId } = withUserMessage(r.engine);
  const g0 = s.view().path[0]!.id;
  const g1 = s.view().tails[0]!;
  return { ...r, s, version, userId, g0, g1 };
}

/** G, U, A (closed), A = 'She nods.' */
async function closedWithAnswer() {
  const r = await closedWithUser();
  const turn = r.s.runTurn({ kind: 'reply', expectedVersion: r.version });
  await drain(turn);
  return { ...r, answerId: turn.messageId, version: r.s.version() };
}

function reopen(engine: { session(id: string): SessionHandle }, s: SessionHandle): SessionHandle {
  return engine.session(s.id);
}

const recovered = (s: SessionHandle) => s.openEvents().filter((e) => e.type === 'recovered');
const lastOf = <T extends Entry['t']>(es: Entry[], t: T) => es.filter((e) => e.t === t).at(-1) as Extract<Entry, { t: T }> | undefined;

describe('recovery', () => {
  test('crash after `turn`: end{abandoned}', async () => {
    const { engine, home, s, version, userId } = await closedWithUser();
    await s.close();
    writeRaw(home, s.id, (log) => turnLine(log, { turn: 't_a', kind: 'reply', parent: userId, msgId: '11111111', base: version }));
    const s2 = reopen(engine, s);
    expect(recovered(s2)).toEqual([expect.objectContaining({ type: 'recovered', turnId: 't_a', outcome: 'abandoned' })]);
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', turn: 't_a', outcome: 'abandoned' });
    expect(s2.view().head).toBe(userId);
    // the session is usable again
    const o = await s2.runTurn({ kind: 'reply', expectedVersion: s2.version() }).result;
    expect(o.type).toBe('done');
    await engine.close();
  });

  test('crash after `prep` (nothing streamed): end{abandoned}', async () => {
    const { engine, home, s, version, userId } = await closedWithUser();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_b', kind: 'reply', parent: userId, msgId: '22222222', base: version });
      log.append({ t: 'prep', turn: 't_b', trace: TRACE });
    });
    const s2 = reopen(engine, s);
    expect(recovered(s2).map((e) => (e as { outcome: string }).outcome)).toEqual(['abandoned']);
    expect(s2.view().head).toBe(userId);
    await engine.close();
  });

  test('crash mid `chk`: the text is committed as interrupted with prep vars and a partial trace', async () => {
    const { engine, home, s, version, userId } = await closedWithUser();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_c', kind: 'reply', parent: userId, msgId: '33333333', base: version });
      log.append({ t: 'prep', turn: 't_c', trace: TRACE, vars: { mood: 'tense' }, prefill: '*' });
      log.append({ t: 'chk', turn: 't_c', text: 'She turns ' }, { durable: false });
      log.append({ t: 'chk', turn: 't_c', text: 'toward the window' }, { durable: false });
    });
    const s2 = reopen(engine, s);
    expect(recovered(s2)).toEqual([expect.objectContaining({ turnId: 't_c', outcome: 'interrupted' })]);
    const msg = lastOf(entriesOf(home, s.id), 'msg') as MsgEntry;
    expect(msg).toMatchObject({ id: '33333333', parent: userId, role: 'assistant', turn: 't_c', vars: { mood: 'tense' } });
    expect(msg.blocks).toEqual([{ k: 'text', text: 'She turns toward the window' }]);
    expect(msg.gen).toEqual({ kind: 'model', finish: 'interrupted', prefill: '*' });
    expect(msg.trace?.partial).toBe(true);
    expect(msg.trace?.seed).toBe(42);
    expect(s2.view().head).toBe('33333333');
    expect(s2.view().vars).toEqual({ mood: 'tense' });
    await engine.close();
  });

  test('reply whose head moved away: committed under U as a tail in one line that keeps the head, committed_as_tail', async () => {
    const { engine, home, s, version, userId, g1 } = await closedWithUser();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_d', kind: 'reply', parent: userId, msgId: '44444444', base: version });
      log.append({ t: 'prep', turn: 't_d', trace: TRACE });
      log.append({ t: 'chk', turn: 't_d', text: 'Too late.' }, { durable: false });
      log.append({ t: 'head', ts: TS, leaf: g1 }); // the user went to the other greeting meanwhile (M6)
    });
    const s2 = reopen(engine, s);
    const evs = s2.openEvents();
    expect(evs.map((e) => e.type)).toEqual(['notice', 'recovered']);
    expect(evs[0]).toMatchObject({ code: 'committed_as_tail' });
    // §5.3: the tail commit is one atomic line; `tail: true` keeps the head where the user put it.
    const last = entriesOf(home, s.id).at(-1);
    expect(last).toMatchObject({ t: 'msg', id: '44444444', parent: userId, tail: true });
    expect(s2.view().head).toBe(g1);
    expect(s2.view().tails).toContain('44444444');
    await engine.close();
  });

  test('U hidden meanwhile: end{dropped}, reported as dropped with the draft', async () => {
    const { engine, home, s, version, userId } = await closedWithUser();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_e', kind: 'reply', parent: userId, msgId: '55555555', base: version });
      log.append({ t: 'prep', turn: 't_e', trace: TRACE });
      log.append({ t: 'chk', turn: 't_e', text: 'Unseen.' }, { durable: false });
      log.append({ t: 'hide', ts: TS, target: userId, hidden: true });
    });
    const s2 = reopen(engine, s);
    // §6.6 (applied by §6.7): U hidden → end{dropped}, the draft arrives in the event.
    expect(recovered(s2)).toEqual([expect.objectContaining({ turnId: 't_e', outcome: 'dropped', draft: 'Unseen.' })]);
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', turn: 't_e', outcome: 'dropped' });
    expect(entriesOf(home, s.id).some((e) => e.t === 'msg' && e.id === '55555555')).toBe(false);
    await engine.close();
  });

  test('swipe: the recovered answer is a sibling of the replaced one, not its child', async () => {
    const { engine, home, s, version, userId, answerId } = await closedWithAnswer();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_f', kind: 'swipe', parent: userId, target: answerId, msgId: '66666666', base: version });
      log.append({ t: 'prep', turn: 't_f', trace: TRACE });
      log.append({ t: 'chk', turn: 't_f', text: 'Another take.' }, { durable: false });
    });
    const s2 = reopen(engine, s);
    expect(recovered(s2).map((e) => (e as { outcome: string }).outcome)).toEqual(['interrupted']);
    const head = s2.view().path.at(-1)!;
    expect(head.id).toBe('66666666');
    expect(head.parent).toBe(userId);
    expect(head.swipe).toEqual({ index: 1, count: 2 });
    expect(s2.view().tails).toContain(answerId);
    void home;
    await engine.close();
  });

  test('continue: the addition is joined to the base from prep.cont and committed as an edit', async () => {
    const { engine, home, s, version, userId, answerId } = await closedWithAnswer();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_g', kind: 'continue', parent: userId, target: answerId, msgId: answerId, base: version });
      log.append({ t: 'prep', turn: 't_g', trace: TRACE, cont: { mode: 'cue', base: 'She nods.' } });
      log.append({ t: 'chk', turn: 't_g', text: 'Then she ' }, { durable: false });
      log.append({ t: 'chk', turn: 't_g', text: 'laughs.' }, { durable: false });
    });
    const s2 = reopen(engine, s);
    expect(recovered(s2).map((e) => (e as { outcome: string }).outcome)).toEqual(['interrupted']);
    const edit = lastOf(entriesOf(home, s.id), 'edit') as EditEntry;
    expect(edit).toMatchObject({ target: answerId, reason: 'continue', turn: 't_g' });
    expect(textOf(s2.view().path.at(-1)!)).toBe('She nods.\n\nThen she laughs.');
    expect(s2.view().path.at(-1)!.gen?.finish).toBe('interrupted');
    await engine.close();
  });

  test('continue whose target changed meanwhile, or that only echoed: end{abandoned}', async () => {
    const { engine, home, s, version, userId, answerId } = await closedWithAnswer();
    await s.close();
    writeRaw(home, s.id, (log) => {
      turnLine(log, { turn: 't_h', kind: 'continue', parent: userId, target: answerId, msgId: answerId, base: version });
      log.append({ t: 'prep', turn: 't_h', trace: TRACE, cont: { mode: 'prefill', base: 'She nods.' } });
      log.append({ t: 'chk', turn: 't_h', text: ' And more.' }, { durable: false });
      log.append({ t: 'edit', ts: TS, target: answerId, reason: 'user', blocks: [{ k: 'text', text: 'Rewritten.' }] });
      turnLine(log, { turn: 't_i', kind: 'continue', parent: userId, target: answerId, msgId: answerId, base: version + 99 });
      log.append({ t: 'prep', turn: 't_i', trace: TRACE, cont: { mode: 'prefill', base: 'Rewritten.' } });
      log.append({ t: 'chk', turn: 't_i', text: 'Rewritten.' }, { durable: false }); // an echo, nothing new
    });
    const s2 = reopen(engine, s);
    expect(recovered(s2).map((e) => [(e as { turnId: string }).turnId, (e as { outcome: string }).outcome])).toEqual([
      ['t_h', 'abandoned'],
      ['t_i', 'abandoned'],
    ]);
    // The text the changed target could not take comes back as the draft; an echo had nothing.
    expect(recovered(s2).map((e) => (e as { draft?: string }).draft)).toEqual([' And more.', undefined]);
    expect(textOf(s2.view().path.at(-1)!)).toBe('Rewritten.');
    await engine.close();
  });

  test('closed turns are left alone; a torn last line becomes a notice', async () => {
    const { engine, home, s } = await closedWithAnswer();
    await s.close();
    appendFileSync(join(sessionsDir(home), `${s.id}.jsonl`), '{"t":"chk","seq":99,"tu');
    const tail = engine.events();
    const seen: Event[] = [];
    const reading = (async () => {
      for await (const ev of tail) seen.push(ev);
    })();
    const s2 = reopen(engine, s);
    expect(s2.openEvents().map((e) => e.type)).toEqual(['notice']);
    expect(s2.openEvents()[0]).toMatchObject({ code: 'torn_tail', level: 'warn' });
    await engine.close();
    await reading;
    expect(seen.map((e) => e.type)).toEqual(['notice']); // open events reach engine.events() too
  });

  test('a real crash mid-stream: the next open commits the checkpointed prefix as interrupted', async () => {
    const r = await rig(calls([{ text: 'The tide ' }, { text: 'is turning, ' }, { pause: 'p' }, { text: 'never seen' }]), {
      extra: { checkpoint: { chars: 4, ms: 1000, datasyncMs: 5 } },
    });
    const { s, version, userId } = withUserMessage(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await until(() => entriesOf(r.home, s.id).filter((e) => e.t === 'chk').map((e) => (e as { text: string }).text).join('') === 'The tide is turning, ');
    // "kill -9": the process holding the lock is gone; another engine finds the lock free.
    unlinkSync(join(sessionsDir(r.home), `${s.id}.lock`));
    const other = (await rig([], { home: r.home })).engine;
    const s2 = other.session(s.id);
    expect(recovered(s2)).toEqual([expect.objectContaining({ turnId: turn.turnId, outcome: 'interrupted' })]);
    const head = s2.view().path.at(-1)!;
    expect(head).toMatchObject({ id: turn.messageId, parent: userId });
    expect(textOf(head)).toBe('The tide is turning, ');
    expect(head.gen?.finish).toBe('interrupted');
    // prep named the primary binding, so the recovered answer says which model wrote it.
    expect(head.gen).toMatchObject({ connection: 'script', model: expect.any(String) });
    await other.close();
    // Let the abandoned in-process turn finish so no timer outlives the test.
    turn.stop();
    await turn.result;
    await r.engine.close();
  });
});

void LEVI;
void MIRA;
