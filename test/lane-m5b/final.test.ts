// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lane after the final check (.notes/m5b-decisions.md, the lead's ruling K): a pass stages against
// exactly what the fold applies before its row (order#1); a split group's rest is owed at once after a
// reopen (groupEnd, lane#5); parked filing keys whose answers are filed elsewhere or hidden are dropped
// (lane#1, cli#1); the circuit breaker (two parks in a row pause the agent) and MemoryStatus.blocked; a
// refile of a never-filed answer inside a historian pass queues its filing too; recorder_unavailable
// for a historian-only setup; a cut-off historian answer that applies no summary fails the attempt.
import { describe, expect, test } from 'bun:test';
import { SCRIPT_CAPS, type ScriptStep } from '../../src/providers/scripted.ts';
import {
  answer,
  calls,
  char,
  chronicle,
  filed,
  jobs,
  laneEvents,
  laneRig,
  laneSession,
  LEVI,
  memRows,
  MIRA,
  pathIds,
  say,
  tick,
  until,
} from './kit.ts';

const fail400 = [{ error: { code: 'bad_request' as const, status: 400 } }];

/** A historian answer cut off by the server (finish 'length'). */
const cut = (text: string): ScriptStep[] => [{ text }, { finish: 'length' }];

describe('a pass stages against what the fold applies before it (order#1)', () => {
  test('a rename made while the next answer is read: the lagging pass sees the old name, one entry results', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол у маяка.'), answer('Седой Фрол молчит у огня.'), answer('Тишина.')),
      recorder: calls(filed(char('Фрол', { description: 'Смотритель маяка.' })), filed(char('Фрол', { minor_facts: ['молчит у огня по ночам'] }))),
    });
    const s = laneSession(r.engine, { historian: { interval: 0 } });
    await say(s, 'Кто там?');
    await say(s, 'Что он делает?');
    await s.memoryWait();
    await say(s, 'И?');
    // The person renames him while the head is a3; a2's pass still waits.
    s.memoryEdit({ ref: 'character:фрол', set: { name: 'Фрол Седой' } });
    await s.memoryWait();
    // a2's pass applies before the rename (D-184): its snapshot is the Compendium as it was then.
    const prompt = JSON.stringify(r.recorder.requests[1]!.messages);
    expect(prompt).toContain('Фрол');
    expect(prompt).not.toContain('Фрол Седой');
    const people = [...s.compendium().entries.values()].filter((e) => e.type === 'character');
    expect(people.map((e) => [e.key, e.name])).toEqual([['character:фрол', 'Фрол Седой']]);
    expect(people[0]!.data.minor_facts).toEqual(['молчит у огня по ночам']);
    expect(s.compendium().issues).toEqual([]);
    await r.engine.close();
  });

  test('an entry the person files after the answer is not what the pass merges into: no missing_required in the view', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол у маяка.'), answer('Фрол даёт клятву у огня.'), answer('Тишина.')),
      recorder: calls(filed(), filed({ type: 'worldbuilding', entry: { topic: 'Клятва фонарщиков', key_facts: ['фонарь не гаснет, пока жив смотритель'] } })),
    });
    const s = laneSession(r.engine, { historian: { interval: 0 } });
    await say(s, 'Кто там?');
    await say(s, 'Что он делает?');
    await s.memoryWait();
    await say(s, 'И?');
    const data = { topic: 'Клятва фонарщиков', category: 'обычай', description: 'Клятва, которую дают у огня.' };
    s.memoryFile({ type: 'worldbuilding', data });
    await s.memoryWait();
    expect(s.compendium().issues).toEqual([]);
    const pass = memRows(r.home, s.id).at(-1)!;
    expect(pass.key).toBe(`file:${pathIds(s)[4]}`);
    // Staged against the Compendium before the person's entry, the item lacks its required fields.
    expect(pass.ops).toEqual([]);
    expect(JSON.stringify(pass.skipped)).toContain('worldbuilding');
    expect([...s.compendium().entries.values()].find((e) => e.type === 'worldbuilding')?.data).toEqual(data);
    await r.engine.close();
  });
});

describe('a group split for size, across a reopen (lane#5, filing#1, breaker#6)', () => {
  test('the first part records the group end; closed while the second runs, the next open files it at once', async () => {
    const long = (n: number): string => `Ответ ${n}. ${'Фрол долго смотрит на море и молчит. '.repeat(20)}`;
    const caps = { ...SCRIPT_CAPS, contextLength: 4096 };
    const r = await laneRig({
      narrator: calls(answer(long(1)), answer(long(2)), answer(long(3)), answer(long(4))),
      recorder: calls(filed(char('Фрол')), [{ pause: 'never' }]),
      recorderCaps: caps,
    });
    const s = laneSession(r.engine, { filing: { wait: 0, everyN: 4 }, historian: { interval: 0 } });
    for (const n of [1, 2, 3, 4]) await say(s, `Ход ${n}. ${'Я жду ответа. '.repeat(10)}`);
    // G U1 A1 U2 A2 U3 A3 U4 A4
    const [, u1, , , a2, u3, , , a4] = pathIds(s);
    const w = s.memoryWait();
    await until(() => r.recorder.requests.length === 2, 3000);
    await s.close();
    await w;
    expect(memRows(r.home, s.id).map((m) => [m.key, m.range, m.groupEnd])).toEqual([[`file:${a2}`, [u1, a2], a4]]);
    await r.engine.close();

    const r2 = await laneRig({ home: r.home, recorder: calls(filed(char('Серый'))), recorderCaps: caps });
    const s2 = r2.engine.session(s.id);
    expect(s2.memoryStatus()).toMatchObject({ queued: [{ key: `file:${a4}`, range: [u3, a4], attempt: 1 }], backlog: 2 });
    expect(await s2.memoryWait()).toMatchObject({ idle: true, queued: [], backlog: 0 });
    expect(memRows(r.home, s.id).map((m) => [m.key, m.range])).toEqual([
      [`file:${a2}`, [u1, a2]],
      [`file:${a4}`, [u3, a4]],
    ]);
    // The begin cut short by the close runs again with its attempt.
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', `file:${a2}`, 1],
      ['begin', `file:${a4}`, 1],
      ['begin', `file:${a4}`, 1],
    ]);
    await r2.engine.close();
  });
});

describe('parked filing keys are re-validated (lane#1, cli#1)', () => {
  test('a parked key whose answers a later group filed is not listed; retry has nothing to re-run', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.'), answer('Серый ушёл.'), answer('Маяк погас.'), answer('Ночь.')),
      recorder: calls(fail400, fail400, fail400, filed(char('Серый'), char('Маяк')), filed(char('Маяк', { state: 'погас' }))),
    });
    const s = laneSession(r.engine, { filing: { wait: 0, everyN: 3 }, historian: { interval: 0 } });
    for (const t of ['Кто ты?', 'А он?', 'А маяк?']) await say(s, t);
    await s.memoryWait();
    const [, , a1, u2, , , a3] = pathIds(s);
    expect(s.memoryStatus().parked.map((p) => p.key)).toEqual([`file:${a3}`]);
    s.hide({ messageId: a1!, hidden: true, expectedVersion: s.version() });
    await say(s, 'И что?');
    await s.memoryWait();
    const a4 = pathIds(s)[8]!;
    expect(memRows(r.home, s.id).map((m) => [m.key, m.range])).toEqual([[`file:${a4}`, [u2, a4]]]);
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    expect(s.memoryRetry()).toEqual({ keys: [], changed: false });
    await s.memoryWait();
    expect(jobs(r.home, s.id).filter((j) => j[0] === 'retry')).toEqual([]);
    expect(r.recorder.requests).toHaveLength(4);
    await r.engine.close();
  });

  test('a parked key whose answer is hidden is not listed; retry writes nothing', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(fail400, fail400, fail400, filed(char('Фрол'))) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    expect(s.memoryStatus().parked.map((p) => p.key)).toEqual([`file:${a1}`]);
    s.hide({ messageId: a1, hidden: true, expectedVersion: s.version() });
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    expect(s.memoryRetry()).toEqual({ keys: [], changed: false });
    expect(jobs(r.home, s.id).map((j) => j[0])).toEqual(['begin', 'failed', 'begin', 'failed', 'begin', 'failed']);
    await r.engine.close();
  });

  test('a parked refile whose answer only its own old row covers stays listed (lane#6 holds)', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(filed(char('Фрол')), fail400, fail400, fail400) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    s.memoryRefile({ messageId: a1 });
    await s.memoryWait();
    expect(s.memoryStatus().parked.map((p) => p.key)).toEqual([`file:${a1}`]);
    await r.engine.close();
  });
});

describe('the circuit breaker (cli#1)', () => {
  test('two historian windows parked in a row pause the historian: memory_paused once, blocked, nothing new starts until retry', async () => {
    const r = await laneRig({
      narrator: calls(answer('Один.'), answer('Два.'), answer('Три.')),
      recorder: calls(...Array.from({ length: 6 }, () => fail400), chronicle([{ title: 'Всё', plot: 'Маяк', summary: 'Три хода.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Раз.');
    await s.memoryWait();
    expect(s.memoryStatus().blocked).toBeUndefined();
    await say(s, 'Два.');
    await s.memoryWait();
    expect(r.recorder.requests).toHaveLength(6);
    expect(s.memoryStatus().blocked).toMatchObject({ agent: 'historian', reason: 'paused' });
    await say(s, 'Три.');
    const [g] = pathIds(s);
    const a3 = pathIds(s)[6]!;
    // The due window is listed, but it does not start: the wait comes back idle with no new call.
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [{ key: `hist:${g}-${a3}` }], blocked: { agent: 'historian', reason: 'paused' } });
    expect(r.recorder.requests).toHaveLength(6);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', code: 'memory_paused' }]);
    // The parked windows moved on (no longer due); a retry still resumes the historian.
    expect(s.memoryRetry()).toEqual({ keys: [], changed: true });
    expect(s.memoryStatus().blocked).toBeUndefined();
    await s.memoryWait();
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`hist:${g}-${a3}`]);
    await r.engine.close();
  });

  test('two filing tasks parked in a row pause filing until the next open; a done task between resets the count', async () => {
    const r = await laneRig({
      narrator: calls(answer('Один.'), answer('Два.'), answer('Три.'), answer('Четыре.'), answer('Пять.')),
      recorder: calls(fail400, fail400, fail400, filed(char('Серый')), fail400, fail400, fail400, fail400, fail400, fail400),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Раз.');
    await say(s, 'Два.');
    await s.memoryWait();
    // a1 parked, a2 filed: not two in a row.
    expect(s.memoryStatus().blocked).toBeUndefined();
    await say(s, 'Три.');
    await say(s, 'Четыре.');
    await s.memoryWait();
    const ids = pathIds(s);
    // a3 parked, a4 parked: paused (a4 parked after a3 in a row).
    expect(s.memoryStatus()).toMatchObject({ parked: [{ key: `file:${ids[2]}` }, { key: `file:${ids[6]}` }, { key: `file:${ids[8]}` }], blocked: { agent: 'filing', reason: 'paused' } });
    await say(s, 'Пять.');
    const a5 = pathIds(s)[10]!;
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [{ key: `file:${a5}` }] });
    expect(r.recorder.requests).toHaveLength(10);
    await s.close();
    const s2 = r.engine.session(s.id);
    expect(s2.memoryStatus()).toMatchObject({ queued: [{ key: `file:${a5}` }] });
    expect(s2.memoryStatus().blocked).toBeUndefined();
    await r.engine.close();
  });
});

describe('MemoryStatus.blocked and recorder_unavailable with no route (cli#9)', () => {
  for (const filingOn of [true, false]) {
    test(`filing ${filingOn ? 'on' : 'off'}, the historian on: the notice is told once and the status says why`, async () => {
      const r = await laneRig({ narrator: calls(answer('Фрол кивнул.'), answer('Ушёл.'), answer('Пришёл.')) });
      const s = r.engine.createSession({
        character: MIRA,
        persona: LEVI,
        config: { roles: { recorder: { conn: 'gone', model: 'x' } }, compendium: { enabled: true, filing: { enabled: filingOn, wait: 0 }, historian: { interval: 1 } } },
      });
      for (const t of ['Кто ты?', 'И?', 'А потом?']) await say(s, t);
      const w = await s.memoryWait({ timeoutMs: 200 });
      expect(w.blocked).toMatchObject({ agent: filingOn ? 'both' : 'historian', reason: 'no_route' });
      expect(w.blocked!.message).toContain('"gone"');
      expect(w.queued.some((q) => q.task === 'hist')).toBe(true);
      await tick();
      const notices = r.events.seen.flatMap((e) => (e.type === 'notice' ? [[e.code, e.message]] : []));
      expect(notices).toEqual([['recorder_unavailable', w.blocked!.message]]);
      expect(w.blocked!.message).toStartWith(`The Compendium's ${filingOn ? 'filing and historian' : 'historian'} cannot run: `);
      await r.engine.close();
    });
  }
});

describe('refile of an answer no filing row covers, inside a historian pass (lane#2 regression)', () => {
  test('both the historian pass and the answer\'s filing are queued', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls(
        chronicle([{ title: 'Встреча', plot: 'Маяк', summary: 'Фрол встретил Леви.' }], []),
        filed(char('Фрол')),
        chronicle([{ title: 'Встреча', plot: 'Маяк', summary: 'Фрол встретил Леви.' }], []),
      ),
    });
    const s = laneSession(r.engine, { filing: { wait: 0, everyN: 3 }, historian: { interval: 1 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const [g, , a1] = pathIds(s);
    expect(s.memoryStatus().backlog).toBe(1);
    expect(s.memoryRefile({ messageId: a1! })).toEqual({ keys: [`file:${a1}`, `hist:${g}-${a1}`], changed: true });
    await s.memoryWait();
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`hist:${g}-${a1}`, `file:${a1}`, `hist:${g}-${a1}`]);
    expect(s.memoryStatus().backlog).toBe(0);
    await r.engine.close();
  });

  test('task hist still refiles only the historian pass', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls(chronicle([{ title: 'Встреча', plot: 'Маяк', summary: 'Фрол.' }], []), chronicle([{ title: 'Встреча', plot: 'Маяк', summary: 'Фрол.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { wait: 0, everyN: 3 }, historian: { interval: 1 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const [g, , a1] = pathIds(s);
    expect(s.memoryRefile({ messageId: a1!, task: 'hist' })).toEqual({ keys: [`hist:${g}-${a1}`], changed: true });
    await r.engine.close();
  });
});

describe('a cut-off historian answer (ruling K)', () => {
  const PLOT_FIRST =
    '{"filings":[{"type":"plot","entry":{"name":"Маяк","status":"active","description":"Старый маяк над гаванью."}},{"type":"summary","entry":{"title":"Туман","parent_plot":"Маяк","summary":"Туман опустился на гавань, и Фрол';
  const SUMMARY_THEN_CUT =
    '{"filings":[{"type":"summary","entry":{"title":"Туман","parent_plot":"Маяк","summary":"Туман опустился."}}],"arcs":[{"plot":"Маяк","overview":"Длинный обзор, который об';

  test('only a plot closed: the attempt fails, the window stays due and the next attempt files it', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls(cut(PLOT_FIRST), chronicle([{ title: 'Туман', plot: 'Маяк', summary: 'Туман опустился.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Кто ты?');
    const [g, , a1] = pathIds(s);
    const key = `hist:${g}-${a1}`;
    await s.memoryWait();
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['failed', key, 1, 'undecodable'],
      ['begin', key, 2],
    ]);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([key]);
    expect([...s.compendium().entries.values()].filter((e) => e.type === 'summary').map((e) => e.data.title)).toEqual(['Туман']);
    await r.engine.close();
  });

  test('a summary closed, the arc cut: the row and the done event record cut_off', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(cut(SUMMARY_THEN_CUT)) });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const row = memRows(r.home, s.id)[0]!;
    expect(row.ops.some((op) => op.op === 'file' && op.type === 'summary')).toBe(true);
    expect(row.skipped).toContainEqual({ path: 'answer', why: expect.stringMatching(/^cut_off/) });
    await tick();
    const done = laneEvents(r.events.seen).find((e) => e.type === 'agent' && e.status === 'done');
    expect(done).toMatchObject({ agent: 'historian', skipped: row.skipped!.length });
    expect(row.skipped!.length).toBeGreaterThanOrEqual(1);
    await r.engine.close();
  });
});

describe('refusals name the pass by its key (words)', () => {
  test('a pass whose answers are all hidden', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.'), answer('Ушёл.')), recorder: calls(filed(char('Фрол', { description: 'Смотритель.' })), filed()) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const [, u1, a1] = pathIds(s);
    s.hide({ messageId: a1!, hidden: true, expectedVersion: s.version() });
    expect(() => s.memoryRefile({ messageId: u1! })).toThrow(`file:${a1} has no visible answer left: hidden messages are not filed`);
    await r.engine.close();
  });
});
