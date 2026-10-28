// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lane as a whole (.notes/m5b-decisions.md D-171, D-172, the lead's rulings G): recovery at open
// (a begin left by a crash or by close() runs again with its attempt), the historian on its interval,
// preemption by a turn (re-queued, not an attempt), the enable moment, the once-per-session notices,
// and the auto mode's idle gate on a local origin.
import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../../src/session/log.ts';
import { putBook, LANTERN } from '../engine-m5a/kit.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import {
  answer,
  calls,
  char,
  chronicle,
  drain,
  filed,
  jobs,
  laneEvents,
  laneRig,
  laneSession,
  localConn,
  memRows,
  pathIds,
  say,
  tick,
  until,
  userText,
  writeRaw,
} from './kit.ts';
import { scriptConn } from '../engine/kit.ts';

describe('recovery at open', () => {
  test('close() during a filing call aborts it (shutdown, nothing written); the next open runs it again with the same attempt', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls([{ pause: 'f' }], filed(char('Фрол'))) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    const a1 = pathIds(s)[2]!;
    const key = `file:${a1}`;
    const waiting = s.memoryWait();
    await until(() => r.recorder.requests.length === 1);
    expect(s.memoryStatus().running).toMatchObject({ key, attempt: 1 });
    await s.close();
    await waiting;
    // The begin stays; no failed row, no mem row.
    expect(jobs(r.home, s.id)).toEqual([['begin', key, 1]]);
    expect(memRows(r.home, s.id)).toEqual([]);

    const s2 = r.engine.session(s.id);
    expect(s2.memoryStatus().queued).toEqual([expect.objectContaining({ key, attempt: 1 })]);
    await s2.memoryWait();
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['begin', key, 1],
    ]);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([key]);
    expect(s2.compendium().tasks.get(key)?.status).toBe('applied');
    await r.engine.close();
  });

  test('a crash mid-call (the lock gone, another engine opens): the begin is run again; exactly one effective row', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls([{ pause: 'never' }]) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    const key = `file:${pathIds(s)[2]!}`;
    void s.memoryWait();
    await until(() => r.recorder.requests.length === 1);
    // "kill -9": the process holding the lock is gone; another engine finds the lock free.
    unlinkSync(join(sessionsDir(r.home), `${s.id}.lock`));
    const other = await laneRig({ home: r.home, recorder: calls(filed(char('Фрол'))) });
    const s2 = other.engine.session(s.id);
    expect(s2.memoryStatus().queued).toEqual([expect.objectContaining({ key, attempt: 1 })]);
    await s2.memoryWait();
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['begin', key, 1],
    ]);
    expect(memRows(r.home, s.id).filter((m) => m.key === key)).toHaveLength(1);
    expect(s2.compendium().entries.has('character:фрол')).toBe(true);
    await other.engine.close();
    await r.engine.close();
  });

  test('rule 1 is a hint (ruling I): a begin left on a covered key (a refile cut short) is not re-run; one on a key still owed is', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.'), answer('Дальше.')), recorder: calls(filed(char('Фрол'))) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    const key = `file:${a1}`;
    await s.close();
    // Closed and reopened as is: the begin has its mem row after it, nothing to run.
    const again = r.engine.session(s.id);
    expect(again.memoryStatus().queued).toEqual([]);
    await say(again, 'А дальше?');
    const a2 = pathIds(again)[4]!;
    await again.close();
    writeRaw(r.home, s.id, (log) => {
      log.append({ t: 'job', ts: 'x', job: 'j_deadbeef', key, task: 'file', on: a1, state: 'begin', attempt: 1 });
      log.append({ t: 'job', ts: 'x', job: 'j_feedface', key: `file:${a2}`, task: 'file', on: a2, state: 'begin', attempt: 1 });
    });
    const r2 = await laneRig({ home: r.home, recorder: calls(filed(char('Серый'))) });
    const s2 = r2.engine.session(s.id);
    // A1 is covered by its row: its begin is dropped. A2 is owed: it runs with the begin's attempt.
    expect(s2.memoryStatus().queued).toEqual([expect.objectContaining({ key: `file:${a2}`, attempt: 1 })]);
    await s2.memoryWait();
    expect(r2.recorder.requests).toHaveLength(1);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([key, `file:${a2}`]);
    expect(s2.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол' });
    await r2.engine.close();
    await r.engine.close();
  });

  test('a begin of a historian window a wider window replaced is dropped at open: one pass over the stretch (sched#1, historian#2)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Один.'), answer('Два.'), answer('Три.')),
      recorder: calls(chronicle([{ title: 'Всё', plot: 'Маяк', summary: 'Три хода.' }], [])),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Раз.');
    const [g, , a1] = pathIds(s);
    // A historian pass over [G, A1] cut short (a crash, a preemption the key moved past).
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([`hist:${g}-${a1}`]);
    await s.close();
    writeRaw(r.home, s.id, (log) => {
      log.append({ t: 'job', ts: 'x', job: 'j_deadbeef', key: `hist:${g}-${a1}`, task: 'hist', on: a1!, state: 'begin', attempt: 1 });
    });
    const s2 = r.engine.session(s.id);
    await say(s2, 'Два.');
    await say(s2, 'Три.');
    const a3 = pathIds(s2)[6]!;
    await s2.close();
    const r2 = await laneRig({ home: r.home, recorder: calls(chronicle([{ title: 'Всё', plot: 'Маяк', summary: 'Три хода.' }], [])) });
    const s3 = r2.engine.session(s.id);
    // Only the window that is due now: the old begin's window is inside it.
    expect(s3.memoryStatus().queued.map((q) => q.key)).toEqual([`hist:${g}-${a3}`]);
    await s3.memoryWait();
    expect(r2.recorder.requests).toHaveLength(1);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`hist:${g}-${a3}`]);
    expect([...s3.compendium().entries.values()].filter((e) => e.type === 'summary')).toHaveLength(1);
    expect(s3.memoryStatus()).toMatchObject({ queued: [], parked: [] });
    await r2.engine.close();
    await r.engine.close();
  });
});

describe('the historian', () => {
  test('fires on its interval: one row with the made plot, the summary and the arc; the window is covered after it', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол зажёг фонарь.'), answer('Свет ушёл в море.')),
      recorder: calls(
        chronicle([{ title: 'Фонарь зажжён', plot: 'Свет маяка', summary: 'Фрол зажёг фонарь, и свет ушёл в море.' }], [{ plot: 'Свет маяка', overview: 'Маяк снова светит.' }]),
      ),
    });
    const s = laneSession(r.engine, { filing: { enabled: false }, historian: { interval: 2 } });
    await say(s, 'Зажги фонарь.');
    await say(s, 'Что дальше?');
    expect(s.memoryStatus().queued).toEqual([]);
    s.send({ text: 'Смотрю.', expectedVersion: s.version() });
    const [g, , , , a2] = pathIds(s);
    const key = `hist:${g}-${a2}`;
    expect(s.memoryStatus().queued).toEqual([{ key, task: 'hist', on: a2, range: [g, a2], attempt: 1 }]);
    await s.memoryWait();
    const req = r.recorder.requests[0]!;
    expect(req.agent).toBe('historian');
    expect(req.callKey).toMatch(/^j_[0-9a-f]{8}:historian:0$/);
    expect(req.messages[0]!.blocks[0]).toMatchObject({ text: expect.stringContaining('YOUR WINDOW: messages 1 through 5 (5 messages).') });
    const row = memRows(r.home, s.id)[0]!;
    expect(row).toMatchObject({ key, on: a2, by: 'historian', range: [g, a2], gen: { profile: 'lite', transport: 'tagged' } });
    expect(row.ops.map((o) => o.op)).toEqual(['file', 'file', 'arc']);
    const c = s.compendium();
    expect(c.entries.get('plot:свет маяка')?.data).toMatchObject({ name: 'Свет маяка', status: 'active' });
    expect([...c.entries.values()].find((e) => e.type === 'summary')?.data).toMatchObject({ title: 'Фонарь зажжён', parent_plot: 'Свет маяка', messages_covered: 5 });
    expect(c.entries.get('arc:свет маяка')?.content).toBe('Маяк снова светит.');
    expect(s.memoryStatus().queued).toEqual([]);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'memory').map((e) => [e.change, e.kind, e.by])).toEqual([
      ['created', 'plot', 'historian'],
      ['created', 'summary', 'historian'],
      ['arc', 'arc', 'historian'],
    ]);
    // Undo by the window's last message takes the historian's pass back (filing is off: none to pick).
    expect(s.memoryUndo({ messageId: a2!, task: 'hist' })).toEqual({ keys: [key], changed: true });
    expect(s.compendium().entries.has('arc:свет маяка')).toBe(false);
    await r.engine.close();
  });
});

describe('preemption', () => {
  test('a turn on a capacity-1 origin preempts the filing call: re-queued with the same attempt, no failed row', async () => {
    // The recorder is the narrator's own connection ('script', one place).
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.'), [{ pause: 'f' }], answer('Ушёл.'), filed(char('Фрол'))) });
    const s = laneSession(r.engine, {}, { roles: { recorder: 'narrator' } });
    await say(s, 'Кто ты?');
    s.send({ text: 'Ясно.', expectedVersion: s.version() });
    const key = `file:${pathIds(s)[2]!}`;
    const waiting = s.memoryWait();
    await until(() => r.narrator.requests.length === 2);
    const out = await drain(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    expect(out.at(-1)?.type).toBe('done');
    await waiting;
    expect(r.narrator.requests.map((q) => q.agent)).toEqual(['narrator', 'filing', 'narrator', 'filing']);
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['begin', key, 1],
    ]);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([key]);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => e.status)).toEqual(['queued', 'started', 'preempted', 'queued', 'started', 'done']);
    await r.engine.close();
  });
});

describe('the enable moment', () => {
  test('/memory on in an old session files only the answers after it; the historian starts there too', async () => {
    const r = await laneRig({
      narrator: calls(answer('Один.'), answer('Два.'), answer('Три.')),
      recorder: calls(filed(char('Фрол'))),
    });
    const s = laneSession(r.engine, { enabled: false, historian: { interval: 1 } });
    await say(s, 'Раз.');
    await say(s, 'Два.');
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    s.configure({ compendium: { enabled: true } });
    // A1 is accepted but older than the moment; A2 is not accepted yet.
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    await say(s, 'Три.');
    // A2 is accepted now, still older than the moment.
    expect(s.memoryStatus()).toMatchObject({ queued: [], backlog: 0 });
    s.send({ text: 'Четыре.', expectedVersion: s.version() });
    const ids = pathIds(s);
    const [u3, a3] = [ids[5]!, ids[6]!];
    // Only A3 is filed; the historian's window starts after the moment (positions before it count as covered).
    expect(s.memoryStatus().queued.map((q) => [q.key, q.range])).toEqual([
      [`file:${a3}`, [u3, a3]],
      [`hist:${u3}-${a3}`, [u3, a3]],
    ]);
    // Off again: no lane at all.
    s.configure({ compendium: { enabled: false } });
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    await r.engine.close();
  });
});

describe('a fork', () => {
  test('its moment sits just before its fork-point answer (ruling H): earlier answers are not back-filled; the fork point and later ones are filed', async () => {
    const r = await laneRig({ narrator: calls(answer('Один.'), answer('Два.'), answer('Три.')), recorder: calls(filed(char('Фрол'))) });
    const s = laneSession(r.engine);
    await say(s, 'Раз.');
    await say(s, 'Два.');
    s.send({ text: 'Три.', expectedVersion: s.version() });
    // The source owes two answers; the fork at A2 copies neither debt.
    expect(s.memoryStatus().backlog).toBe(2);
    const forkId = s.fork({ at: pathIds(s)[4] });
    const f = r.engine.session(forkId);
    expect(f.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    f.send({ text: 'Три на форке.', expectedVersion: f.version() });
    const [, , , u2, a2] = pathIds(f);
    // A1 stays the source's; A2, the fork point, is accepted on the fork and counts.
    expect(f.memoryStatus()).toMatchObject({ backlog: 1, queued: [{ key: `file:${a2}`, range: [u2, a2] }] });
    await say(f, 'Четыре.');
    expect(f.memoryStatus().queued.map((q) => q.key)).toEqual([`file:${a2}`]);
    f.send({ text: 'Пять.', expectedVersion: f.version() });
    const ids = pathIds(f);
    // G U1 A1 U2 A2 | U3 U4 A3 U5: A2 and A3 are after the fork's moment.
    expect(f.memoryStatus().queued.map((q) => q.key)).toEqual([`file:${a2}`, `file:${ids[7]}`]);
    await r.engine.close();
  });

  test('an answer not yet accepted when the fork was made is filed once it is accepted on the fork (ruling H)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Первый ответ.'), answer('Второй ответ.'), answer('Третий ответ.'), answer('Четвёртый ответ.'), answer('Пятый ответ.')),
      recorder: calls(filed(char('Фрол'))),
    });
    const s = laneSession(r.engine);
    await say(s, 'Раз.');
    await say(s, 'Два.');
    // G U1 A1 U2 A2: the source owes A1; A2 is not accepted yet (wait 1).
    expect(s.memoryStatus().backlog).toBe(1);
    const [, , a1, u2, a2] = pathIds(s);
    const f = r.engine.session(s.fork({ at: a2! }));
    expect(f.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    await say(f, 'На форке.');
    expect(f.memoryStatus().queued.map((q) => [q.key, q.range])).toEqual([[`file:${a2}`, [u2, a2]]]);
    await f.memoryWait();
    expect(r.recorder.requests).toHaveLength(1);
    expect(userText(r.recorder.requests[0]!)).toContain('Второй ответ.');
    expect(userText(r.recorder.requests[0]!)).not.toContain('Первый ответ.');
    expect(memRows(r.home, f.id).map((m) => m.key)).toEqual([`file:${a2}`]);
    expect(f.compendium().tasks.has(`file:${a1}`)).toBe(false);
    // A fork at a user message has no answer at its fork point: the answer before it is not back-filled.
    const g = r.engine.session(s.fork({ at: u2! }));
    expect(g.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    await say(g, 'Ещё.');
    g.send({ text: 'И ещё.', expectedVersion: g.version() });
    // G U1 A1 U2 | U3 A2' U4: only A2' is after the moment.
    const gi = pathIds(g);
    expect(g.memoryStatus().queued.map((q) => q.key)).toEqual([`file:${gi[5]}`]);
    await r.engine.close();
  });
});

describe('memoryWait', () => {
  test('with a timeout: idle false while a task still runs (it goes on)', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls([{ pause: 'f' }, { text: '{"filings":[]}' }]) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    const key = `file:${pathIds(s)[2]}`;
    const out = await s.memoryWait({ timeoutMs: 20 });
    expect(out).toMatchObject({ idle: false, queued: [], running: { key, attempt: 1 } });
    expect(out.running?.job).toMatch(/^j_[0-9a-f]{8}$/);
    r.recorder.release('f');
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [], backlog: 0 });
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([key]);
    await r.engine.close();
  });
});

describe('notices', () => {
  test('memory_backlog once per session when uncovered answers pass everyN + 3', async () => {
    const r = await laneRig({ narrator: calls(...['1', '2', '3', '4', '5', '6'].map((n) => answer(`Ответ ${n}.`))) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    for (const n of ['1', '2', '3', '4']) await say(s, `Ход ${n}.`);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'notice')).toEqual([]);
    await say(s, 'Ход 5.');
    await say(s, 'Ход 6.');
    await tick();
    expect(s.memoryStatus().backlog).toBe(6);
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', code: 'memory_backlog' }]);
    await r.engine.close();
  });

  test('filing_classic_conflict once per name; the item is skipped on the row', async () => {
    const r = await laneRig({
      narrator: calls(answer('Гильдия молчит.'), answer('Гильдия снова молчит.')),
      recorder: calls(filed({ type: 'organization', entry: { name: 'Гильдия' } }), filed({ type: 'organization', entry: { name: 'гильдия' } })),
    });
    const book = putBook(r.home, LANTERN);
    const s = laneSession(r.engine, { filing: { wait: 0 } }, { lorebooks: [book] });
    await say(s, 'Что гильдия?');
    await s.memoryWait();
    await say(s, 'А теперь?');
    await s.memoryWait();
    const rows = memRows(r.home, s.id);
    expect(rows.map((m) => m.ops)).toEqual([[], []]);
    expect(rows[0]!.skipped?.[0]?.why).toMatch(/^classic_conflict:/);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', code: 'filing_classic_conflict' }]);
    await r.engine.close();
  });

  test('slots_shared once when two connections of the session are one server', async () => {
    const twin = scriptConn('twin', []);
    const r = await laneRig({ connections: { twin: { ...twin.conn, origin: 'script:script' } } });
    const s = laneSession(r.engine, {}, { roles: { recorder: { conn: 'twin', model: 't' } } });
    s.configure({ compendium: { filing: { wait: 0 } } });
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', code: 'slots_shared' }]);
    await r.engine.close();
  });
});

describe('auto mode', () => {
  test('a local origin: the task waits idleDelaySec after the last activity, then runs by itself', async () => {
    const timers = fakeTimers();
    const local = localConn('loc', calls(answer('Фрол кивнул.'), filed(char('Фрол'))));
    const r = await laneRig({ lane: 'auto', timers, connections: { loc: local.conn } });
    const s = r.engine.createSession({
      character: { name: 'Mira', description: 'A keeper.', greetings: ['Hello.'] },
      config: { roles: { narrator: { conn: 'loc', model: 'm' } }, compendium: { enabled: true, filing: { wait: 0 } } },
    });
    s.send({ text: 'Кто ты?', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await drain(turn);
    await turn.result;
    await settle();
    // Begun at once, but held by the idle gate: no filing request yet.
    const key = `file:${pathIds(s)[2]!}`;
    expect(jobs(r.home, s.id)).toEqual([['begin', key, 1]]);
    expect(local.provider.requests.map((q) => q.agent)).toEqual(['narrator']);
    timers.advance(7_999);
    await settle();
    expect(local.provider.requests).toHaveLength(1);
    timers.advance(1);
    await until(() => memRows(r.home, s.id).length === 1);
    expect(local.provider.requests.map((q) => q.agent)).toEqual(['narrator', 'filing']);
    const out = await s.memoryWait();
    expect(out).toMatchObject({ idle: true, queued: [] });
    await r.engine.close();
  });
});
