// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// When the lane starts its work, after the M5b review (.notes/m5b-decisions.md, the lead's ruling I):
// not between a `send` and its `runTurn` (a user message at the head younger than max(idleDelaySec,
// 2 s) holds it back), not during a turn even when memoryWait asks in auto mode, not again at once
// after a failure (15 s × 2^(attempt − 1)); `agent{started}` comes with the call's place on the server;
// the historian's preemptions are counted per agent (its key moves with its window).
import { describe, expect, test } from 'bun:test';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import { answer, calls, char, chronicle, drain, filed, jobs, laneEvents, laneRig, laneSession, localConn, memRows, pathIds, say, tick, until } from './kit.ts';

const fail400 = [{ error: { code: 'bad_request' as const, status: 400 } }];
/** A clock that stands still: a message's age is what the fake timers say. */
const still = (): Date => new Date('2026-10-28T10:00:00.000Z');

describe('a send its turn follows', () => {
  test('the answer it accepts is not begun before the turn (no preemption, no wasted call) (lane#7)', async () => {
    const timers = fakeTimers();
    const r = await laneRig({
      lane: 'auto',
      timers,
      extra: { clock: still },
      narrator: calls(answer('Фрол кивнул.'), answer('Ушёл.')),
      recorder: calls(filed(char('Фрол'))),
    });
    const s = laneSession(r.engine, { historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    const a1 = pathIds(s)[2]!;
    s.send({ text: 'Ясно.', expectedVersion: s.version() });
    // A1 is accepted now and queued, but the fresh message holds the lane back.
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key: `file:${a1}` }] });
    expect(s.memoryStatus().running).toBeUndefined();
    expect(jobs(r.home, s.id)).toEqual([]);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    await settle();
    expect(jobs(r.home, s.id)).toEqual([['begin', `file:${a1}`, 1]]);
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [] });
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`file:${a1}`]);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => e.status)).toEqual(['queued', 'started', 'done']);
    await r.engine.close();
  });
});

describe('memoryWait in auto mode only waits', () => {
  test('called during a turn it starts nothing; the lane starts once the turn has settled (lane#13, sched#8)', async () => {
    const r = await laneRig({
      lane: 'auto',
      narrator: calls(answer('Фрол кивнул.'), [{ pause: 'turn' }, { text: 'Ушёл.' }]),
      recorder: calls(filed(char('Фрол'))),
    });
    const s = laneSession(r.engine, { historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    const a1 = pathIds(s)[2]!;
    const turn = s.submit({ text: 'Ясно.', expectedVersion: s.version() });
    await until(() => r.narrator.requests.length === 2);
    expect(await s.memoryWait({ timeoutMs: 30 })).toMatchObject({ idle: false, queued: [{ key: `file:${a1}` }] });
    expect(jobs(r.home, s.id)).toEqual([]);
    expect(r.recorder.requests).toHaveLength(0);
    const waiting = s.memoryWait();
    r.narrator.release('turn');
    await drain(turn);
    expect(await waiting).toMatchObject({ idle: true, queued: [], backlog: 0 });
    expect(jobs(r.home, s.id)).toEqual([['begin', `file:${a1}`, 1]]);
    await r.engine.close();
  });
});

describe('a failed attempt waits before the next one (auto mode)', () => {
  test('15 s, then 30 s; the third failure parks the key (lane#14)', async () => {
    const timers = fakeTimers();
    const r = await laneRig({ lane: 'auto', timers, narrator: calls(answer('Фрол кивнул.')), recorder: calls(fail400, fail400, fail400) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    const key = `file:${pathIds(s)[2]!}`;
    await until(() => jobs(r.home, s.id).length === 2);
    timers.advance(14_999);
    await settle();
    expect(jobs(r.home, s.id)).toHaveLength(2);
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key, attempt: 2 }], parked: [] });
    timers.advance(1);
    await until(() => jobs(r.home, s.id).length === 4);
    timers.advance(29_999);
    await settle();
    expect(jobs(r.home, s.id)).toHaveLength(4);
    timers.advance(1);
    await until(() => jobs(r.home, s.id).length === 6);
    expect(jobs(r.home, s.id).map((j) => [j[0], j[2]])).toEqual([
      ['begin', 1],
      ['failed', 1],
      ['begin', 2],
      ['failed', 2],
      ['begin', 3],
      ['failed', 3],
    ]);
    expect(s.memoryStatus()).toMatchObject({ queued: [], parked: [{ key, failures: 3 }] });
    expect(timers.pending()).toBe(0);
    await r.engine.close();
  });

  test('manual memoryWait does not wait between attempts', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(fail400, filed(char('Фрол'))) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [], backlog: 0 });
    expect(jobs(r.home, s.id).map((j) => j[0])).toEqual(['begin', 'failed', 'begin']);
    await r.engine.close();
  });
});

describe('started on the place', () => {
  test('a pass held by the local idle gate is running and waiting, not started; started comes with its place (sched#7)', async () => {
    const timers = fakeTimers();
    const local = localConn('loc', calls(answer('Фрол кивнул.'), filed(char('Фрол'))));
    const r = await laneRig({ lane: 'auto', timers, connections: { loc: local.conn } });
    const s = r.engine.createSession({
      character: { name: 'Mira', description: 'A keeper.', greetings: ['Hello.'] },
      config: { roles: { narrator: { conn: 'loc', model: 'm' } }, compendium: { enabled: true, filing: { wait: 0 }, historian: { interval: 0 } } },
    });
    s.send({ text: 'Кто ты?', expectedVersion: s.version() });
    await drain(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    await settle();
    const key = `file:${pathIds(s)[2]!}`;
    expect(jobs(r.home, s.id)).toEqual([['begin', key, 1]]);
    expect(s.memoryStatus().running).toMatchObject({ key, waiting: true });
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => e.status)).toEqual(['queued']);
    timers.advance(8_000);
    await until(() => memRows(r.home, s.id).length === 1);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => e.status)).toEqual(['queued', 'started', 'done']);
    await r.engine.close();
  });
});

describe('starvation of the historian (D-172)', () => {
  test('three preemptions in a row count for the historian although its key moves each turn (sched#2)', async () => {
    const r = await laneRig({
      narrator: calls(
        answer('Один.'),
        [{ pause: 'h1' }],
        answer('Два.'),
        [{ pause: 'h2' }],
        answer('Три.'),
        [{ pause: 'h3' }],
        answer('Четыре.'),
        chronicle([{ title: 'Всё', plot: 'Маяк', summary: 'Четыре хода.' }], []),
      ),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } }, { roles: { recorder: 'narrator' } });
    await say(s, 'Раз.');
    const waiting = s.memoryWait();
    for (const [n, text] of [
      [2, 'Два.'],
      [4, 'Три.'],
      [6, 'Четыре.'],
    ] as const) {
      await until(() => r.narrator.requests.length === n);
      s.send({ text, expectedVersion: s.version() });
      await drain(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    }
    await waiting;
    const begins = jobs(r.home, s.id).map((j) => j[1]);
    // Each pass was a wider window under a new key.
    expect(new Set(begins).size).toBe(4);
    await tick();
    const evs = laneEvents(r.events.seen);
    expect(evs.filter((e) => e.type === 'agent' && e.status === 'preempted')).toHaveLength(3);
    expect(evs.filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', code: 'memory_starved' }]);
    expect(memRows(r.home, s.id)).toHaveLength(1);
    await r.engine.close();
  });
});
