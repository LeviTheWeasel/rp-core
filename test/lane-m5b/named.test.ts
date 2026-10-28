// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Tasks asked for by name and the verbs after the M5b review (.notes/m5b-decisions.md, the lead's
// ruling I): a refile or a recovered begin whose agent is off is held, never begun (it used to begin,
// be superseded and begin again without end); refile refuses a hidden, not accepted or Compendium-off
// target in words; a retry of a parked refile after a reopen queues it; no_room parks at its first
// failure; undo binds to the effective row; a refile that drops an entry tells it as reverted.
import { describe, expect, test } from 'bun:test';
import { Refusal } from '../../src/engine/api.ts';
import { answer, calls, char, chronicle, filed, jobs, laneEvents, laneRig, laneSession, memRows, pathIds, say, tick, writeRaw } from './kit.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';

/** The refusal a call throws: [code, message]. */
function refused(fn: () => unknown): [string, string] {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return [e.code, e.message];
    throw e;
  }
  throw new Error('expected a Refusal');
}

const fail400 = [{ error: { code: 'bad_request' as const, status: 400 } }];

describe('a task asked for by name while its agent is off', () => {
  test('a refile with filing off is held (no begin, memoryWait returns); it runs once filing is on again', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(filed(char('Фрол')), filed(char('Фрол', { age: '40' }))) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    const key = `file:${a1}`;
    s.configure({ compendium: { filing: { enabled: false } } });
    expect(s.memoryRefile({ messageId: a1 })).toEqual({ keys: [key], changed: true });
    expect(s.memoryStatus()).toMatchObject({ queued: [], held: [{ key, task: 'file', attempt: 1 }] });
    // Asked again while held: nothing new.
    expect(s.memoryRefile({ messageId: a1 })).toEqual({ keys: [key], changed: false });
    expect(await s.memoryWait({ timeoutMs: 1000 })).toMatchObject({ idle: true, queued: [] });
    expect(jobs(r.home, s.id)).toEqual([['begin', key, 1]]);
    s.configure({ compendium: { filing: { enabled: true } } });
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key }] });
    expect(s.memoryStatus().held).toBeUndefined();
    await s.memoryWait();
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['begin', key, 1],
    ]);
    expect(s.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', age: '40' });
    await r.engine.close();
  });

  test('a historian refile with interval 0 is held too; a begin of the historian left at a close is not run at open while it is off', async () => {
    const r = await laneRig({
      narrator: calls(answer('Свет.')),
      recorder: calls(chronicle([{ title: 'Свет', plot: 'Маяк', summary: 'Зажгли.' }], []), [{ pause: 'never' }]),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 1 } });
    await say(s, 'Зажги.');
    await s.memoryWait();
    const [g, , a1] = pathIds(s);
    const key = `hist:${g}-${a1}`;
    s.configure({ compendium: { historian: { interval: 0 } } });
    expect(s.memoryRefile({ messageId: a1!, task: 'hist' })).toEqual({ keys: [key], changed: true });
    expect(s.memoryStatus()).toMatchObject({ queued: [], held: [{ key, task: 'hist' }] });
    expect(await s.memoryWait({ timeoutMs: 1000 })).toMatchObject({ idle: true });
    expect(jobs(r.home, s.id)).toEqual([['begin', key, 1]]);
    await s.close();
    // A begin left by a run cut short, then reopened with the historian still off.
    writeRaw(r.home, s.id, (log) => {
      log.append({ t: 'job', ts: 'x', job: 'j_deadbeef', key, task: 'hist', on: a1!, state: 'begin', attempt: 1 });
    });
    const s2 = r.engine.session(s.id);
    expect(s2.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    expect(await s2.memoryWait({ timeoutMs: 1000 })).toMatchObject({ idle: true });
    expect(jobs(r.home, s.id)).toHaveLength(2);
    await r.engine.close();
  });
});

describe('refile refusals (ruling I)', () => {
  test('the Compendium off, a hidden message, an answer not accepted yet: refused in words, nothing queued', async () => {
    const r = await laneRig({ narrator: calls(answer('Один.'), answer('Два.')), recorder: calls(filed(char('Фрол'))) });
    const s = laneSession(r.engine, { historian: { interval: 0 } });
    await say(s, 'Раз.');
    await say(s, 'Два.');
    const [, , a1, , a2] = pathIds(s);
    // wait 1: A2 has no user message after it yet.
    const [code, why] = refused(() => s.memoryRefile({ messageId: a2! }));
    expect(code).toBe('invalid_params');
    expect(why).toContain('not accepted yet');
    s.hide({ messageId: a1!, hidden: true, expectedVersion: s.version() });
    expect(refused(() => s.memoryRefile({ messageId: a1! }))).toEqual(['invalid_params', `message ${a1} is hidden: hidden messages are not filed`]);
    s.configure({ compendium: { enabled: false } });
    const off = refused(() => s.memoryRefile({ messageId: a2! }));
    expect(off[0]).toBe('invalid_params');
    expect(off[1]).toContain('the Compendium is off');
    expect(refused(() => s.memoryRetry())[1]).toContain('the Compendium is off');
    s.configure({ compendium: { enabled: true } });
    expect(s.memoryStatus().queued).toEqual([]);
    expect(jobs(r.home, s.id)).toEqual([]);
    await r.engine.close();
  });
});

describe('retry and parking', () => {
  test('a parked refile retried after a reopen is queued by name and runs (lane#6, cli#2, breaker#10)', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(filed(char('Фрол')), fail400, fail400, fail400) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    const key = `file:${a1}`;
    s.memoryRefile({ messageId: a1 });
    await s.memoryWait();
    expect(s.memoryStatus().parked).toEqual([{ key, on: a1, failures: 3, code: 'provider_error' }]);
    await r.engine.close();

    const r2 = await laneRig({ home: r.home, recorder: calls(filed(char('Фрол', { age: '40' }))) });
    const s2 = r2.engine.session(s.id);
    expect(s2.memoryStatus()).toMatchObject({ queued: [], parked: [{ key, failures: 3 }] });
    expect(s2.memoryRetry()).toEqual({ keys: [key], changed: true });
    expect(s2.memoryStatus()).toMatchObject({ queued: [{ key, attempt: 1 }], parked: [] });
    expect(await s2.memoryWait()).toMatchObject({ idle: true, queued: [] });
    expect(r2.recorder.requests).toHaveLength(1);
    expect(s2.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', age: '40' });
    await r2.engine.close();
  });

  test('no_room writes one begin and one failed{no_room} and parks at once; no started for a call never made (lane#10)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул. '.repeat(40))),
      recorderCaps: { ...SCRIPT_CAPS, contextLength: 1200 },
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты? '.repeat(40));
    const key = `file:${pathIds(s)[2]!}`;
    await s.memoryWait();
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['failed', key, 1, 'no_room'],
    ]);
    expect(s.memoryStatus()).toMatchObject({ queued: [], parked: [{ key, failures: 1, code: 'no_room' }] });
    expect(r.recorder.requests).toHaveLength(0);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => [e.status, e.code])).toEqual([
      ['queued', undefined],
      ['failed', 'no_room'],
      ['parked', 'no_room'],
    ]);
    // A retry tries once more and parks again at once.
    s.memoryRetry();
    await s.memoryWait();
    expect(jobs(r.home, s.id).slice(2).map((j) => j[0])).toEqual(['retry', 'begin', 'failed']);
    expect(s.memoryStatus().parked).toEqual([{ key, on: pathIds(s)[2], failures: 1, code: 'no_room' }]);
    await r.engine.close();
  });
});

describe('undo and refile bind to the effective pass', () => {
  test('undo of a message a stale window and a wider applied window both hold takes back the applied one (lane#9)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Один.'), answer('Два.'), answer('Три.'), answer('Четыре.')),
      recorder: calls(
        chronicle([{ title: 'Начало', plot: 'Маяк', summary: 'Два хода.' }], []),
        chronicle([{ title: 'Всё', plot: 'Маяк', summary: 'Четыре хода.' }], []),
      ),
    });
    const s = laneSession(r.engine, { filing: { enabled: false, wait: 0 }, historian: { interval: 2 } });
    await say(s, 'Раз.');
    await say(s, 'Два.');
    await s.memoryWait();
    const [g, u1, , , a2] = pathIds(s);
    s.edit({ messageId: u1!, text: 'Раз, исправлено.', expectedVersion: s.version() });
    await say(s, 'Три.');
    await say(s, 'Четыре.');
    await s.memoryWait();
    const a4 = pathIds(s)[8]!;
    const c = s.compendium();
    expect(c.tasks.get(`hist:${g}-${a2}`)?.status).toBe('stale');
    expect(c.tasks.get(`hist:${g}-${a4}`)?.status).toBe('applied');
    expect(s.memoryUndo({ messageId: a2!, task: 'hist' })).toEqual({ keys: [`hist:${g}-${a4}`], changed: true });
    expect([...s.compendium().entries.values()].filter((e) => e.type === 'summary')).toEqual([]);
    await r.engine.close();
  });

  test('a refile whose new row leaves out an entry the old row made tells it as reverted (lane#8)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол и Серый.')),
      recorder: calls(filed(char('Фрол'), char('Серый')), filed(char('Фрол'))),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто здесь?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    await tick();
    const seen = r.events.seen.length;
    s.memoryRefile({ messageId: a1 });
    await s.memoryWait();
    expect([...s.compendium().entries.keys()].filter((k) => k.startsWith('character:'))).toEqual(['character:фрол']);
    await tick();
    expect(laneEvents(r.events.seen.slice(seen)).filter((e) => e.type === 'memory')).toEqual([
      { type: 'memory', change: 'reverted', ref: 'character:серый', kind: 'character', name: 'Серый', by: 'filing' },
    ]);
    expect(memRows(r.home, s.id)).toHaveLength(2);
    await r.engine.close();
  });
});
