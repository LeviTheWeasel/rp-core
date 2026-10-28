// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c recall in the engine after the review (.notes/m5c-decisions.md, the lead's rulings K): at most two
// recall calls (no top-up after a corrective pass); memoryWait waits for the prefetch; prefetch_missed
// only when the turn really waited for a prefetch that existed (a failed one falls back untold, nothing
// held falls back with no record, a close during the wait is a Stop); a guided re-roll and onSwipe
// 'rerun' recall again in the turn; the basis' head is the newest answer before U (stacked messages);
// the grace wait holds the Director only on a local origin's single place it shares with recall, a
// miss's sync recall queues behind the Director on one place, and two places order nothing; the
// record's ms is recall's own time; /preview --turn of a continued answer reads the answer's record.
import { describe, expect, test } from 'bun:test';
import type { Connection } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import { missedNotice, RECALL_SLOW_MS } from '../../src/engine/recall.ts';
import type { Event } from '../../src/protocol/events.ts';
import { createScriptedProvider, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { RecallRecord } from '../../src/session/entries.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { putBook } from '../engine-m5a/kit.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import {
  agentsOf,
  dirCall,
  drain,
  editsOf,
  fullCaps,
  HARBOR_BOOK,
  keyOf,
  LEVI,
  line,
  MIRA,
  msgOf,
  narr,
  noticeCodes,
  pausedPicks,
  picks,
  planOf,
  recallEvents,
  recallRig,
  recallSession,
  tagged,
  turnOf,
  until,
} from './kit.ts';

/** The lane's recall events on the bus (no turn id). */
const laneRecall = (seen: readonly Event[]): Record<string, unknown>[] => recallEvents(seen).filter((e) => e.turnId === undefined);
/** A narrator call the server refuses. */
const refused = (): ScriptCall => line('narrator', [{ error: { code: 'bad_request', status: 400 } }]);
/** A recall answer with no selection in it. */
const prose = (): ScriptCall => line('recall', [{ text: 'I would rather not say.' }]);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe('at most two recall calls (core#1)', () => {
  test('a corrective pass then too few picks: no top-up after it', async () => {
    const r = await recallRig([line('recall', [{ text: 'Hard to say which lore matters here.' }]), picks(['Арсений Кеттер']), picks(['Арсений Кеттер', 'Мира']), narr()], { caps: fullCaps() });
    const s = recallSession(r, { mode: 'sync', minEntries: 2 });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'recall', 'narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ status: 'recalled', source: 'sync', calls: 2, picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    expect(r.provider.remaining()).toBe(1);
    await r.engine.close();
  });

  test('a first answer of one call with too few picks still gets its top-up', async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), picks(['Арсений Кеттер', 'Мира']), narr()], { caps: fullCaps() });
    const s = recallSession(r, { mode: 'sync', minEntries: 2 });
    const { turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'recall', 'narrator']);
    expect(r.provider.requests[1]!.callKey).toBe(`${turn.turnId}:recall:more:0`);
    expect((msgOf(r.home, s.id, turn.messageId)!.recall as RecallRecord).picks).toHaveLength(2);
    await r.engine.close();
  });
});

describe("the record's ms is recall's own time (engine#6)", () => {
  test('one place, the Director first and slow: ms from recall\'s grant, no recall_slow after three turns', async () => {
    let now = new Date('2026-10-26T12:00:00.000Z').getTime();
    const script: ScriptCall[] = [];
    for (let i = 0; i < 3; i++) script.push(line('director', [{ pause: `d${i}` }, { text: tagged(planOf()) }]), picks(['Арсений Кеттер']), narr());
    const r = await recallRig(script, { caps: fullCaps(), clock: () => new Date(now) });
    const s = recallSession(r, { mode: 'sync' }, { config: { director: { enabled: true } } });
    const told: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) s.send({ text: `Дальше ${i}.`, expectedVersion: s.version() });
      const before = r.provider.requests.length;
      const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
      const drained = drain(turn);
      await until(() => r.provider.requests.length === before + 1);
      expect(r.provider.requests.at(-1)!.agent).toBe('director');
      // The Director thinks for 9 s; recall waits behind it on the one place, then answers at once.
      now += 9000;
      r.provider.release(`d${i}`);
      told.push(...noticeCodes(await drained));
      expect((await turn.result).type).toBe('done');
      const rec = msgOf(r.home, s.id, turn.messageId)!.recall as RecallRecord;
      expect(rec.calls).toBe(1);
      expect(rec.ms).toBe(0);
    }
    expect(RECALL_SLOW_MS).toBe(8000);
    expect(told).not.toContain('recall_slow');
    await r.engine.close();
  });
});

describe('memoryWait waits for the prefetch (engine#1, breaker#4)', () => {
  test('a prefetch in flight: a short wait is not idle; a wait with no timeout ends with it', async () => {
    const r = await recallRig([pausedPicks('p', ['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    await until(() => r.provider.requests.length === 1);
    const short = await s.memoryWait({ timeoutMs: 30 });
    expect(short.idle).toBe(false);
    expect(short.prefetch).toMatchObject({ state: 'running' });
    let ended = false;
    const waiting = s.memoryWait().then((st) => {
      ended = true;
      return st;
    });
    await sleep(30);
    expect(ended).toBe(false);
    r.provider.release('p');
    const st = await waiting;
    expect(st.idle).toBe(true);
    expect(st.prefetch).toMatchObject({ state: 'ready', record: { status: 'recalled' } });
    expect(laneRecall(r.events.seen).map((e) => e.status)).toEqual(['queued', 'started', 'done']);
    await r.engine.close();
  });
});

describe('prefetch_missed only after a real wait (engine#3, #5, #7, cli#5, breaker#3)', () => {
  test('no greeting, so no answer before U: nothing was held — lexical with no record, nothing told', async () => {
    const r = await recallRig([narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { compendium: { idleDelaySec: 0 }, character: { ...MIRA, greetings: [] } });
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(agentsOf(r.provider.requests)[0]).toBe('narrator');
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toBeUndefined();
    expect(msg.trace?.compendium?.source).toBe('lexical');
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    expect(recallEvents(evs)).toEqual([]);
    await r.engine.close();
  });

  test('no greeting, mode prefetch on a remote origin: onMiss sync recalls in the turn, nothing told', async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), narr(), picks(['Мира'])], { lane: 'auto' });
    const s = recallSession(r, { mode: 'prefetch' }, { compendium: { idleDelaySec: 0 }, character: { ...MIRA, greetings: [] } });
    const { evs, turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests).slice(0, 2)).toEqual(['recall', 'narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ source: 'sync', status: 'recalled' });
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    await r.engine.close();
  });

  test('a stored prefetch that failed, onMiss sync: the turn recalls, nothing told', async () => {
    const r = await recallRig([prose(), picks(['Арсений Кеттер']), narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'prefetch', onMiss: 'sync' }, { text: null, compendium: { idleDelaySec: 0 } });
    await until(() => laneRecall(r.events.seen).some((e) => e.status === 'failed'));
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const { evs, turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests).slice(0, 3)).toEqual(['recall', 'recall', 'narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ source: 'sync', status: 'recalled', picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    await r.engine.close();
  });

  test('a stored prefetch that failed, onMiss lexical: its record is the fallback, nothing told', async () => {
    const r = await recallRig([prose(), narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    const greeting = s.view().path[0]!.id;
    await until(() => laneRecall(r.events.seen).some((e) => e.status === 'failed'));
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const { evs, turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests).slice(0, 2)).toEqual(['recall', 'narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ status: 'failed', source: 'lexical', basis: greeting });
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    expect(recallEvents(evs)).toEqual([expect.objectContaining({ status: 'fallback', source: 'lexical' })]);
    await r.engine.close();
  });

  test('late after graceSec: the notice says the turn waited grace_sec', async () => {
    const timers = fakeTimers();
    const r = await recallRig([pausedPicks('p', ['Арсений Кеттер']), narr(), picks(['Мира'])], { local: true, lane: 'auto', timers });
    const s = recallSession(r, { mode: 'auto', graceSec: 3 }, { text: null, compendium: { idleDelaySec: 0 } });
    await until(() => r.provider.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const drained = drain(turn);
    for (let i = 0; i < 5; i++) await settle();
    timers.advance(3000);
    const evs = await drained;
    const told = evs.find((e) => e.type === 'notice' && e.code === 'prefetch_missed');
    expect(told?.type === 'notice' ? told.message : '').toContain('was still running when the turn needed it (the turn waited 3 s for it)');
    await r.engine.close();
  });

  test('the words say what happened: late after grace_sec, or ended without a selection (no wait claimed)', () => {
    const late = missedNotice(4, true);
    expect(late).toMatchObject({ level: 'info', code: 'prefetch_missed' });
    expect(late.message).toContain('the turn waited 4 s for it');
    expect(late.message).toContain('compendium.recall.grace_sec');
    const ended = missedNotice(4, false);
    expect(ended.message).toContain('ended without a selection while the turn waited for it');
    expect(ended.message).not.toContain('4 s');
    expect(ended.message).not.toContain('grace_sec');
  });

  test('the session closes while the turn waits for the prefetch: a Stop, not a miss', async () => {
    const timers = fakeTimers();
    const r = await recallRig([pausedPicks('p', ['Арсений Кеттер']), picks(['Мира']), narr()], { local: true, lane: 'auto', timers });
    const s = recallSession(r, { mode: 'auto', graceSec: 4 }, { text: null, compendium: { idleDelaySec: 0 } });
    await until(() => r.provider.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const drained = drain(turn);
    for (let i = 0; i < 5; i++) await settle();
    await s.close();
    const evs = await drained;
    expect((await turn.result).type).toBe('stopped');
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    expect(recallEvents(evs)).toEqual([]);
    expect(agentsOf(r.provider.requests)).toEqual(['recall']);
    await r.engine.close();
  });
});

describe('a re-roll recalls again (cli#4, breaker#1)', () => {
  test('auto on a local origin: a guided re-roll and an onSwipe rerun swipe recall in the turn, never adopting the prefetch', async () => {
    const r = await recallRig(
      [
        picks(['Арсений Кеттер']), // the greeting's prefetch, adopted by A1
        narr('Первый.'),
        picks(['Мира']), // the prefetch after A1
        picks(['Серый маяк']), // the guided re-roll's recall
        narr('Второй.'),
        picks(['Мира']), // the prefetch after A2
        picks(['Мира']), // the rerun swipe's recall
        narr('Третий.'),
        picks(['Мира']), // the prefetch after A3
      ],
      { local: true, lane: 'auto' },
    );
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    await until(() => laneRecall(r.events.seen).filter((e) => e.status === 'done').length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const first = await turnOf(s);
    expect(msgOf(r.home, s.id, first.turn.messageId)!.recall).toMatchObject({ source: 'prefetch' });
    await until(() => laneRecall(r.events.seen).filter((e) => e.status === 'done').length === 2);

    const guided = await turnOf(s, 'swipe', { guidance: 'Покажи маяк.' });
    expect(guided.out.type).toBe('done');
    expect(r.provider.requests.map((q) => q.callKey)).toContain(`${guided.turn.turnId}:recall:0`);
    const g = msgOf(r.home, s.id, guided.turn.messageId)!.recall as RecallRecord;
    expect(g).toMatchObject({ source: 'sync', status: 'recalled', calls: 1, picks: [{ ref: keyOf(s, 'Серый маяк') }] });
    expect(g.basis).toBeUndefined();
    expect(recallEvents(guided.evs).at(-1)).toMatchObject({ status: 'recalled', source: 'sync' });
    await until(() => laneRecall(r.events.seen).filter((e) => e.status === 'done').length === 3);

    s.configure({ compendium: { recall: { mode: 'auto', onSwipe: 'rerun' } } });
    const rerun = await turnOf(s, 'swipe');
    expect(r.provider.requests.map((q) => q.callKey)).toContain(`${rerun.turn.turnId}:recall:0`);
    expect(msgOf(r.home, s.id, rerun.turn.messageId)!.recall).toMatchObject({ source: 'sync', status: 'recalled', picks: [{ ref: keyOf(s, 'Мира') }] });
    await r.engine.close();
  });
});

describe("the basis' head is the newest answer before U (breaker#2)", () => {
  test('a failed turn, then the player types again: the stacked message still adopts the prefetch held', async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), refused(), narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    const greeting = s.view().path[0]!.id;
    await until(() => laneRecall(r.events.seen).some((e) => e.status === 'done'));
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    expect((await turnOf(s, 'reply', { onError: 'keep' })).out.type).toBe('failed');
    s.send({ text: 'Ау? Есть кто?', expectedVersion: s.version() });
    expect(s.view().path.map((m) => m.role)).toEqual(['assistant', 'user', 'user']);
    expect(s.memoryStatus().prefetch).toMatchObject({ on: greeting, state: 'ready' });
    const before = r.provider.requests.length;
    const { evs, turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests.slice(before))[0]).toBe('narrator');
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ status: 'recalled', source: 'prefetch', basis: greeting, picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    await r.engine.close();
  });

  test('a prefetch in flight stays valid when two player messages stack under its answer', async () => {
    const r = await recallRig([pausedPicks('p', ['Арсений Кеттер']), narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    const greeting = s.view().path[0]!.id;
    await until(() => r.provider.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    s.send({ text: 'Ау? Есть кто?', expectedVersion: s.version() });
    await sleep(20);
    expect(laneRecall(r.events.seen).map((e) => e.status)).toEqual(['queued', 'started']);
    expect(s.memoryStatus().prefetch).toMatchObject({ on: greeting, state: 'running' });
    r.provider.release('p');
    await until(() => laneRecall(r.events.seen).some((e) => e.status === 'done'));
    const { turn } = await turnOf(s);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ source: 'prefetch', basis: greeting });
    await r.engine.close();
  });
});

/** An engine with the connections given (scripted, by id), the session's roles bound as asked. */
async function twoConns(conns: Record<string, Connection>, timers?: ReturnType<typeof fakeTimers>) {
  const home = tmpHome();
  const engine = await Engine.open({
    home,
    connections: conns,
    clock: fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
    lane: 'auto',
    recall: 'config',
    ...(timers ? { timers } : {}),
  });
  return { home, engine, book: putBook(home, HARBOR_BOOK) };
}

/** A scripted connection on `origin`. */
const conn = (id: string, provider: ScriptedProvider, origin: string, maxInFlight: number, more: Partial<Connection> = {}): Connection => ({
  id,
  provider,
  caps: fullCaps({ maxInFlight }),
  origin,
  local: true,
  ...more,
});

describe('the Director and recall on one place (sched#3, #5, #7)', () => {
  test('recall local on its own origin, the Director remote on another: the Director plans during the grace wait', async () => {
    const timers = fakeTimers();
    const rec = createScriptedProvider([pausedPicks('p', ['Мира'])], { localOrigin: true });
    const main = createScriptedProvider([line('director', dirCall()), narr()]);
    const { engine, book, home } = await twoConns({ rec: conn('rec', rec, 'script:rec', 1), main: conn('main', main, 'script:main', 4) }, timers);
    const s = engine.createSession({
      character: MIRA,
      persona: LEVI,
      config: {
        lorebooks: [book],
        roles: { narrator: { conn: 'main', model: 'default' }, recall: { conn: 'rec', model: 'default' } },
        director: { enabled: true },
        compendium: { enabled: true, idleDelaySec: 0, filing: { enabled: false }, historian: { interval: 0 }, recall: { mode: 'auto', graceSec: 4 } },
      },
    });
    await until(() => rec.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const drained = drain(turn);
    for (let i = 0; i < 10; i++) await settle();
    timers.advance(1000);
    for (let i = 0; i < 10; i++) await settle();
    expect(agentsOf(main.requests)).toEqual(['director']);
    rec.release('p');
    await drained;
    expect((await turn.result).type).toBe('done');
    expect(agentsOf(main.requests)).toEqual(['director', 'narrator']);
    expect(msgOf(home, s.id, turn.messageId)!.recall).toMatchObject({ source: 'prefetch' });
    await engine.close();
  });

  test("a remote origin of one place: the miss's sync recall queues behind the Director (its key slow)", async () => {
    const p = createScriptedProvider([line('recall', [{ pause: 'p' }, { text: 'No idea.' }]), line('recall', [{ text: 'Still no.' }]), line('director', dirCall()), picks(['Мира']), narr(), picks(['Мира'])]);
    const origin = 'script:shared';
    const slowKey = (): Promise<string | null> => new Promise((res) => setTimeout(() => res(null), 150));
    const { engine, book } = await twoConns({ main: conn('main', p, origin, 1), dirc: conn('dirc', p, origin, 1, { resolveKey: slowKey }) });
    const s = engine.createSession({
      character: MIRA,
      persona: LEVI,
      config: {
        lorebooks: [book],
        roles: { narrator: { conn: 'main', model: 'default' }, director: { conn: 'dirc', model: 'default' }, recall: { conn: 'main', model: 'default' } },
        director: { enabled: true },
        compendium: { enabled: true, idleDelaySec: 0, filing: { enabled: false }, historian: { interval: 0 }, recall: { mode: 'prefetch', graceSec: 5 } },
      },
    });
    await until(() => p.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const drained = drain(turn);
    await sleep(10);
    p.release('p');
    await drained;
    expect((await turn.result).type).toBe('done');
    const inTurn = p.requests.filter((q) => q.callKey.startsWith(turn.turnId)).map((q) => q.agent);
    expect(inTurn).toEqual(['director', 'recall', 'narrator']);
    await engine.close();
  });

  test('two places on one origin: recall asks at once, not after the Director\'s slow key', async () => {
    const p = createScriptedProvider([line('director', dirCall()), picks(['Мира']), narr()]);
    const origin = 'script:a';
    const slowKey = (): Promise<string | null> => new Promise((res) => setTimeout(() => res(null), 150));
    const { engine, book } = await twoConns({ main: conn('main', p, origin, 2), dirc: conn('dirc', p, origin, 2, { resolveKey: slowKey }) });
    const s = engine.createSession({
      character: MIRA,
      persona: LEVI,
      config: {
        lorebooks: [book],
        roles: { narrator: { conn: 'main', model: 'default' }, director: { conn: 'dirc', model: 'default' }, recall: { conn: 'main', model: 'default' } },
        director: { enabled: true },
        compendium: { enabled: true, filing: { enabled: false }, historian: { interval: 0 }, recall: { mode: 'sync' } },
      },
    });
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const { out } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(agentsOf(p.requests)).toEqual(['recall', 'director', 'narrator']);
    await engine.close();
  });
});

describe('/preview --turn of a continued answer (engine#4, breaker#6)', () => {
  test("the answer's own record, not the continue's: no tier 1 its request never had", async () => {
    const r = await recallRig([line('recall', [{ error: { code: 'bad_request', status: 400 } }]), narr('Первый.'), picks(['Арсений Кеттер']), narr(' И ещё.')], { keepRequests: true });
    const s = recallSession(r, { mode: 'sync' });
    const { turn } = await turnOf(s);
    const a1 = turn.messageId;
    expect(msgOf(r.home, s.id, a1)!.recall).toMatchObject({ status: 'failed' });
    const cont = await turnOf(s, 'continue');
    expect(cont.out.type).toBe('done');
    expect(editsOf(r.home, s.id, a1).at(-1)!.recall).toMatchObject({ status: 'recalled', source: 'sync' });
    const p = s.preview({ turn: a1 });
    if (!p.ok) throw new Error(p.message);
    expect(p.trace.compendium?.source).toBe('lexical');
    expect(p.trace.compendium?.picks.some((x) => x.via === 'model')).toBe(false);
    expect(p.notices.map((n) => n.code)).not.toContain('preview_inputs_changed');
    await r.engine.close();
  });
});
