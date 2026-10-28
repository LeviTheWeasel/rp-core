// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lane's verbs (.notes/m5b-decisions.md D-180) and its durable state (D-171): undo then refile,
// parking after maxAttempts failures and memoryRetry, both across a reopen, the D-159 refusals.
import { describe, expect, test } from 'bun:test';
import { Refusal, type RefusalCode } from '../../src/engine/api.ts';
import { answer, calls, char, entriesOf, filed, jobs, laneEvents, laneRig, laneSession, memRows, pathIds, say, tick } from './kit.ts';

function refusal(fn: () => unknown): RefusalCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return e.code;
    throw e;
  }
  throw new Error('expected a Refusal');
}

const fail400 = [{ error: { code: 'bad_request' as const, status: 400 } }];

describe('undo and refile', () => {
  test('undo writes a revert row (on = the pass\'s message) and tells what it took back; refile files the key again', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.'), answer('Дальше.')),
      recorder: calls(filed(char('Фрол', { description: 'Смотритель.' })), filed(char('Фрол', { description: 'Кузнец.' }))),
    });
    const s = laneSession(r.engine);
    await say(s, 'Кто ты?');
    s.send({ text: 'Ясно.', expectedVersion: s.version() });
    await s.memoryWait();
    const [, u1, a1, u2] = pathIds(s);
    const key = `file:${a1}`;
    // No pass is bound to U2; U1 is inside the pass's range.
    expect(refusal(() => s.memoryUndo({ messageId: u2! }))).toBe('not_found');
    expect(refusal(() => s.memoryUndo({ messageId: 'ffffffff' }))).toBe('not_found');
    expect(refusal(() => s.memoryUndo({ messageId: a1!, task: 'nope' as never }))).toBe('invalid_params');
    expect(refusal(() => s.memoryUndo({ messageId: u1!, task: 'hist' }))).toBe('not_found');
    const seen = r.events.seen.length;
    const version = s.version();

    expect(s.memoryUndo({ messageId: u1! })).toEqual({ keys: [key], changed: true });
    expect(s.version()).toBe(version);
    const revert = memRows(r.home, s.id).at(-1)!;
    expect(revert).toMatchObject({ key: null, on: a1, by: 'user', ops: [{ op: 'revert', key }] });
    expect(s.compendium().entries.has('character:фрол')).toBe(false);
    expect(s.compendium().tasks.get(key)?.status).toBe('reverted');
    // Reverted counts as covered: nothing queued.
    expect(s.memoryStatus().queued).toEqual([]);
    // Already undone: nothing written.
    expect(s.memoryUndo({ messageId: a1! })).toEqual({ keys: [], changed: false });
    expect(memRows(r.home, s.id)).toHaveLength(2);
    await tick();
    expect(laneEvents(r.events.seen.slice(seen))).toEqual([{ type: 'memory', change: 'reverted', ref: 'character:фрол', kind: 'character', name: 'Фрол', by: 'user' }]);

    expect(s.memoryRefile({ messageId: a1! })).toEqual({ keys: [key], changed: true });
    expect(s.memoryRefile({ messageId: a1! })).toEqual({ keys: [key], changed: false });
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([key]);
    await s.memoryWait();
    expect(s.compendium().tasks.get(key)?.status).toBe('applied');
    expect(s.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', description: 'Кузнец.' });
    expect(memRows(r.home, s.id).map((m) => [m.key, m.by])).toEqual([
      [key, 'filing'],
      [null, 'user'],
      [key, 'filing'],
    ]);
    await r.engine.close();
  });

  test('the refile of an applied pass keeps the person\'s edits of what it made (D-179)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls(filed(char('Фрол')), filed(char('Фрол', { age: '40' }))),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    s.memoryEdit({ ref: 'Фрол', set: { role: 'смотритель' } });
    const a1 = pathIds(s)[2]!;
    expect(s.memoryRefile({ messageId: a1 })).toEqual({ keys: [`file:${a1}`], changed: true });
    await s.memoryWait();
    expect(s.compendium().entries.get('character:фрол')?.data).toMatchObject({ name: 'Фрол', age: '40', role: 'смотритель' });
    await r.engine.close();
  });

  test('refused with session_busy while a turn runs; an accepted answer no pass covers is refiled as its own task', async () => {
    const r = await laneRig({ narrator: calls(answer('Один.'), [{ pause: 'p' }, { text: 'Два.' }]), recorder: calls(filed()) });
    const s = laneSession(r.engine, { enabled: true }, {});
    await say(s, 'Раз.');
    s.send({ text: 'Два.', expectedVersion: s.version() });
    const a1 = pathIds(s)[2]!;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    expect(refusal(() => s.memoryUndo({ messageId: a1 }))).toBe('session_busy');
    expect(refusal(() => s.memoryRefile({ messageId: a1 }))).toBe('session_busy');
    expect(refusal(() => s.memoryRetry())).toBe('session_busy');
    // Read-only and waiting are allowed meanwhile.
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([`file:${a1}`]);
    r.narrator.release('p');
    for await (const _ of turn.events) void _;
    // Already queued (derived): the refile adds nothing.
    expect(s.memoryRefile({ messageId: a1 })).toEqual({ keys: [`file:${a1}`], changed: false });
    await r.engine.close();
  });
});

describe('parking and retry', () => {
  test('maxAttempts failures park the key; parked survives a reopen; the retry row survives one too', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(fail400, fail400, fail400) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    const a1 = pathIds(s)[2]!;
    const key = `file:${a1}`;
    const out = await s.memoryWait();
    expect(out).toMatchObject({ idle: true, queued: [], parked: [{ key, on: a1, failures: 3 }], backlog: 1 });
    expect(jobs(r.home, s.id)).toEqual([
      ['begin', key, 1],
      ['failed', key, 1, 'provider_error'],
      ['begin', key, 2],
      ['failed', key, 2, 'provider_error'],
      ['begin', key, 3],
      ['failed', key, 3, 'provider_error'],
    ]);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => e.status)).toEqual([
      'queued',
      'started',
      'failed',
      // A failed task is queued again (each time a key enters the queue, it is told).
      'queued',
      'started',
      'failed',
      'queued',
      'started',
      'failed',
      'parked',
    ]);
    expect(refusal(() => s.memoryRefile({ messageId: a1 }))).toBe('invalid_params');
    await r.engine.close();

    // Reopened: still parked, nothing runs.
    const r2 = await laneRig({ home: r.home, recorder: calls(filed(char('Фрол'))) });
    const s2 = r2.engine.session(s.id);
    expect(s2.memoryStatus()).toMatchObject({ queued: [], parked: [{ key, on: a1, failures: 3 }] });
    await s2.memoryWait();
    expect(r2.recorder.requests).toHaveLength(0);
    // The greeting is outside the parked task's range [U1, A1]: nothing to retry there.
    expect(s2.memoryRetry({ messageId: pathIds(s2)[0]! })).toEqual({ keys: [], changed: false });
    expect(s2.memoryRetry({ messageId: a1 })).toEqual({ keys: [key], changed: true });
    expect(jobs(r2.home, s.id).at(-1)).toEqual(['retry', key, 1]);
    expect(s2.memoryStatus()).toMatchObject({ queued: [{ key, attempt: 1 }], parked: [] });
    await r2.engine.close();

    // Closed before it ran: the retry row keeps it un-parked, and the run takes attempt 1.
    const r3 = await laneRig({ home: r.home, recorder: calls(filed(char('Фрол'))) });
    const s3 = r3.engine.session(s.id);
    expect(s3.memoryStatus()).toMatchObject({ queued: [{ key, attempt: 1 }], parked: [] });
    await s3.memoryWait();
    expect(jobs(r3.home, s.id).slice(-2)).toEqual([
      ['retry', key, 1],
      ['begin', key, 1],
    ]);
    expect(memRows(r3.home, s.id).map((m) => m.key)).toEqual([key]);
    expect(s3.memoryStatus()).toMatchObject({ queued: [], parked: [], backlog: 0 });
    await r3.engine.close();
  });

  test('a mem row resets the count: a later failure is attempt 1 again', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(fail400, filed(char('Фрол')), fail400, filed(char('Фрол', { age: '40' }))) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    s.memoryRefile({ messageId: a1 });
    await s.memoryWait();
    expect(jobs(r.home, s.id).map((j) => [j[0], j[2]])).toEqual([
      ['begin', 1],
      ['failed', 1],
      ['begin', 2],
      ['begin', 1],
      ['failed', 1],
      ['begin', 2],
    ]);
    // A refile that fails stays queued until it is done (or parked).
    expect(entriesOf(r.home, s.id).filter((e) => e.t === 'mem')).toHaveLength(2);
    expect(s.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', age: '40' });
    await r.engine.close();
  });
});
