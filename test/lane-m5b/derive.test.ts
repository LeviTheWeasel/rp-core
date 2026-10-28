// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lane's derivation after the M5b review (.notes/m5b-decisions.md, the lead's ruling I): a stale row
// is debt whatever the enable moment (after /memory off+on, on a fork, for the historian's floor too);
// both parts of a group split for size are tasks at once; a fork's moment sits before the earliest
// answer not accepted at the fork point (wait ≥ 2); a parked historian window that is no longer due is
// dropped; a message too large for the historian's window is cut instead of parking the historian; a
// historian answer whose summaries were all refused fails the attempt.
import { describe, expect, test } from 'bun:test';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { answer, calls, char, chronicle, filed, jobs, laneRig, laneSession, memRows, pathIds, say, userText } from './kit.ts';

const fail400 = [{ error: { code: 'bad_request' as const, status: 400 } }];

describe('a stale row is debt whatever the enable moment', () => {
  test('after /memory off and on, an edit of an old message files its answer again', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls(filed(char('Фрол')), filed(char('Фрол', { age: '40' }))),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const [, u1, a1] = pathIds(s);
    s.configure({ compendium: { enabled: false } });
    s.configure({ compendium: { enabled: true } });
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    s.edit({ messageId: u1!, text: 'Кто ты, старик?', expectedVersion: s.version() });
    expect(s.compendium().tasks.get(`file:${a1}`)?.status).toBe('stale');
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key: `file:${a1}` }], backlog: 1 });
    await s.memoryWait();
    expect(s.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', age: '40' });
    await r.engine.close();
  });

  test('on a fork, an edit of a message the source filed files it again', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.'), answer('Серый пришёл.')),
      recorder: calls(filed(char('Фрол')), filed(char('Серый')), filed(char('Фрол', { age: '40' }))),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await say(s, 'А он?');
    await s.memoryWait();
    const [, u1, a1, , a2] = pathIds(s);
    const f = r.engine.session(s.fork({ at: a2! }));
    f.edit({ messageId: u1!, text: 'Кто ты, старик?', expectedVersion: f.version() });
    expect(f.memoryStatus()).toMatchObject({ queued: [{ key: `file:${a1}` }] });
    await f.memoryWait();
    expect([...f.compendium().entries.keys()].filter((k) => k.startsWith('character:')).sort()).toEqual(['character:серый', 'character:фрол']);
    await r.engine.close();
  });

  test('the historian: a stale row before the moment is a hole, the next window', async () => {
    const r = await laneRig({
      narrator: calls(answer('Свет.')),
      recorder: calls(chronicle([{ title: 'Свет', plot: 'Маяк', summary: 'Зажгли.' }], []), chronicle([{ title: 'Огонь', plot: 'Маяк', summary: 'Зажгли огонь.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Зажги.');
    await s.memoryWait();
    const [g, u1, a1] = pathIds(s);
    const key = `hist:${g}-${a1}`;
    s.configure({ compendium: { enabled: false } });
    s.configure({ compendium: { enabled: true } });
    expect(s.memoryStatus().queued).toEqual([]);
    s.edit({ messageId: u1!, text: 'Зажги огонь.', expectedVersion: s.version() });
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([key]);
    await s.memoryWait();
    expect([...s.compendium().entries.values()].filter((e) => e.type === 'summary').map((e) => e.data.title)).toEqual(['Огонь']);
    await r.engine.close();
  });
});

describe('a group split for size', () => {
  test('both halves are tasks at once, each keyed by its last answer (lane#5, filing#1, breaker#6)', async () => {
    const long = (n: number): string => `Ответ ${n}. ${'Фрол долго смотрит на море и молчит. '.repeat(20)}`;
    const r = await laneRig({
      narrator: calls(answer(long(1)), answer(long(2)), answer(long(3)), answer(long(4))),
      recorder: calls(filed(char('Фрол')), filed(char('Серый'))),
      recorderCaps: { ...SCRIPT_CAPS, contextLength: 4096 },
    });
    const s = laneSession(r.engine, { filing: { wait: 0, everyN: 4 }, historian: { interval: 0 } });
    for (const n of [1, 2, 3, 4]) await say(s, `Ход ${n}. ${'Я жду ответа. '.repeat(10)}`);
    const ids = pathIds(s);
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key: `file:${ids[8]}` }], backlog: 4 });
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [], backlog: 0 });
    expect(memRows(r.home, s.id).map((m) => [m.key, m.range])).toEqual([
      [`file:${ids[4]}`, [ids[1], ids[4]]],
      [`file:${ids[8]}`, [ids[5], ids[8]]],
    ]);
    expect(r.recorder.requests).toHaveLength(2);
    await r.engine.close();
  });
});

describe('a fork with filing.wait 2', () => {
  test('an answer not yet accepted at the fork point is filed once it is accepted on the fork (breaker#9)', async () => {
    const r = await laneRig({
      narrator: calls(...[1, 2, 3, 4, 5].map((n) => answer(`Ответ ${n}.`))),
      recorder: calls(filed(char('Фрол')), filed(char('Серый')), filed(char('Ян'))),
    });
    const s = laneSession(r.engine, { filing: { wait: 2 }, historian: { interval: 0 } });
    for (const n of [1, 2, 3, 4]) await say(s, `Ход ${n}.`);
    await s.memoryWait();
    const ids = pathIds(s);
    // G U1 A1 U2 A2 U3 A3 U4 A4: A1 and A2 are accepted and filed; A3 has one user message after it.
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`file:${ids[2]}`, `file:${ids[4]}`]);
    const f = r.engine.session(s.fork({ at: ids[8]! }));
    expect(f.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    await say(f, 'Ход 5.');
    // U4 and U5 follow A3 now: it is accepted on the fork and owed there.
    expect(f.memoryStatus()).toMatchObject({ queued: [{ key: `file:${ids[6]}` }], backlog: 1 });
    await f.memoryWait();
    expect(userText(r.recorder.requests.at(-1)!)).toContain('Ответ 3.');
    await r.engine.close();
  });
});

describe('the historian', () => {
  test('a parked window that is no longer due is dropped from the parked list; a retry has nothing to re-run (cli#1)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Один.'), answer('Два.')),
      recorder: calls(fail400, fail400, fail400, chronicle([{ title: 'Всё', plot: 'Маяк', summary: 'Два хода.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Раз.');
    await s.memoryWait();
    const [g, , a1] = pathIds(s);
    expect(s.memoryStatus().parked).toEqual([{ key: `hist:${g}-${a1}`, on: a1, failures: 3, code: 'provider_error' }]);
    await say(s, 'Два.');
    const a2 = pathIds(s)[4]!;
    // The due window grew: its key moved; the old window is not parked any more.
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key: `hist:${g}-${a2}` }], parked: [] });
    await s.memoryWait();
    expect(s.memoryStatus()).toMatchObject({ queued: [], parked: [] });
    expect(s.memoryRetry()).toEqual({ keys: [], changed: false });
    await s.close();
    const s2 = r.engine.session(s.id);
    expect(s2.memoryStatus()).toMatchObject({ queued: [], parked: [] });
    await s2.memoryWait();
    expect(r.recorder.requests).toHaveLength(4);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`hist:${g}-${a2}`]);
    await r.engine.close();
  });

  test('a message too large for the recorder\'s window is cut head and tail, not parked (historian#3, breaker#4)', async () => {
    const big = `НАЧАЛО ${'Длинный рассказ о маяке и о море. '.repeat(1500)} КОНЕЦ`;
    const r = await laneRig({
      narrator: calls(answer(big), answer('Дальше.'), answer('Ещё.')),
      recorder: calls(...[1, 2, 3, 4].map((n) => chronicle([{ title: `Часть ${n}`, plot: 'Маяк', summary: `Часть ${n}.` }], []))),
      recorderCaps: { ...SCRIPT_CAPS, contextLength: 1400 },
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Расскажи всё.');
    await s.memoryWait();
    await say(s, 'Дальше.');
    const a1 = pathIds(s)[2]!;
    // The answer alone is the next window (larger than the window's cap): cut, sent, its row closes it.
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([`hist:${a1}-${a1}`]);
    await s.memoryWait();
    expect(jobs(r.home, s.id).filter((j) => j[0] === 'failed')).toEqual([]);
    expect(memRows(r.home, s.id).map((m) => m.range)).toContainEqual([a1, a1]);
    const cut = r.recorder.requests.map(userText).find((t) => t.includes('characters cut from the middle'));
    expect(cut).toBeDefined();
    expect(cut).toContain('НАЧАЛО');
    expect(cut).toContain('КОНЕЦ');
    expect(s.memoryStatus()).toMatchObject({ queued: [], parked: [] });
    // The next window (after it) fits the small window too: the prompt around it bounds its texts.
    await say(s, 'Ещё.');
    await s.memoryWait();
    expect(jobs(r.home, s.id).filter((j) => j[0] === 'failed')).toEqual([]);
    expect(s.memoryStatus()).toMatchObject({ queued: [], parked: [] });
    await r.engine.close();
  });

  test('an answer whose summaries were all refused fails the attempt: no row, the window stays due (historian#10)', async () => {
    const noPlot = [{ text: JSON.stringify({ filings: [{ type: 'summary', entry: { title: 'Без сюжета', summary: 'Что-то было.' } }] }) }];
    const r = await laneRig({
      narrator: calls(answer('Свет.')),
      recorder: calls(noPlot, chronicle([{ title: 'Свет', plot: 'Маяк', summary: 'Зажгли.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Зажги.');
    const [g, , a1] = pathIds(s);
    const key = `hist:${g}-${a1}`;
    await s.memoryWait();
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['failed', key, 1, 'invalid'],
      ['begin', key, 2],
    ]);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([key]);
    expect([...s.compendium().entries.values()].filter((e) => e.type === 'summary').map((e) => e.data.title)).toEqual(['Свет']);
    await r.engine.close();
  });
});
