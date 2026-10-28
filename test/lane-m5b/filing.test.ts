// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lane's filing tasks (.notes/m5b-decisions.md D-171): what an accepted answer is (wait 1 and 0,
// never the greeting), the rows a run writes (job begin, the mem row) and its events, everyN grouping,
// and the path deciding what the Compendium holds (a swipe, an edit that makes a pass stale).
import { describe, expect, test } from 'bun:test';
import { answer, calls, char, filed, jobs, laneEvents, laneRig, laneSession, memRows, pathIds, say, tick, userText } from './kit.ts';

describe('filing an accepted answer', () => {
  test('wait 1: the answer is filed once the player answers it; one begin, one mem row, the version unmoved', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол, смотритель маяка, кивнул.'), answer('Он ушёл.')),
      recorder: calls(filed(char('Фрол', { description: 'Смотритель маяка.' }))),
    });
    const s = laneSession(r.engine);
    await say(s, 'Кто ты?');
    const [, u1, a1] = pathIds(s);
    // Not accepted yet: no player message after it.
    expect(s.memoryStatus()).toEqual({ queued: [], parked: [], backlog: 0 });
    s.send({ text: 'А маяк?', expectedVersion: s.version() });
    expect(s.memoryStatus()).toEqual({ queued: [{ key: `file:${a1}`, task: 'file', on: a1, range: [u1, a1], attempt: 1 }], parked: [], backlog: 1 });
    // Manual lane: nothing ran by itself.
    expect(r.recorder.requests).toHaveLength(0);
    const version = s.version();

    const out = await s.memoryWait();
    expect(out).toEqual({ queued: [], parked: [], backlog: 0, idle: true });
    expect(s.version()).toBe(version);
    expect(r.recorder.requests).toHaveLength(1);
    const req = r.recorder.requests[0]!;
    expect(req.agent).toBe('filing');
    expect(req.callKey).toMatch(/^j_[0-9a-f]{8}:filing:0$/);
    expect(req.maxTokens).toBeLessThanOrEqual(1500);
    expect(req.samplers.temperature).toBe(0.3);
    expect(userText(req)).toBe('The narrator just wrote this reply:\n\nФрол, смотритель маяка, кивнул.\n\nThe reply answers:\nКто ты?\n\nFile anything that meets the rules above.\n\nWrite every field value in Russian.');

    expect(jobs(r.home, s.id)).toEqual([['begin', `file:${a1}`, 1]]);
    const rows = memRows(r.home, s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: `file:${a1}`,
      on: a1,
      by: 'filing',
      range: [u1, a1],
      ops: [{ op: 'file', type: 'character', data: { name: 'Фрол', description: 'Смотритель маяка.' } }],
      gen: { model: 'rec:r', profile: 'lite', transport: 'tagged', calls: 1 },
    });
    expect(rows[0]!.gen!.ms).toBeGreaterThanOrEqual(0);
    expect(s.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', description: 'Смотритель маяка.' });
    expect(s.compendium().tasks.get(`file:${a1}`)).toMatchObject({ status: 'applied', range: [u1, a1] });

    await tick();
    expect(laneEvents(r.events.seen)).toEqual([
      { type: 'agent', agent: 'filing', status: 'queued' },
      { type: 'idle', background: 1 },
      { type: 'agent', agent: 'filing', job: 'j', status: 'started' },
      { type: 'memory', change: 'created', ref: 'character:фрол', kind: 'character', name: 'Фрол', by: 'filing' },
      { type: 'agent', agent: 'filing', job: 'j', status: 'done', count: 1, skipped: 0 },
      { type: 'idle', background: 0 },
    ]);
    await r.engine.close();
  });

  test('wait 0: the committed answer is filed at once; the greeting never is', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(filed(char('Фрол'))) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    // The greeting alone, and a user message with no answer: nothing to file.
    expect(s.memoryStatus().queued).toEqual([]);
    s.send({ text: 'Кто ты?', expectedVersion: s.version() });
    expect(s.memoryStatus().queued).toEqual([]);
    await s.memoryWait();
    expect(r.recorder.requests).toHaveLength(0);
    await (async () => {
      const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
      for await (const _ of t.events) void _;
    })();
    const [g, u1, a1] = pathIds(s);
    expect(s.memoryStatus().queued.map((t) => [t.key, t.range])).toEqual([[`file:${a1}`, [u1, a1]]]);
    await s.memoryWait();
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`file:${a1}`]);
    expect(s.compendium().tasks.has(`file:${g}`)).toBe(false);
    await r.engine.close();
  });

  test('everyN 2: two exchanges in one task keyed by the last answer; the last group waits; a hidden answer ends a group', async () => {
    const r = await laneRig({
      narrator: calls(answer('Ответ один.'), answer('Ответ два.'), answer('Ответ три.'), answer('Ответ четыре.'), answer('Ответ пять.')),
      recorder: calls(filed(char('Фрол')), filed(), filed()),
    });
    const s = laneSession(r.engine, { filing: { everyN: 2 } });
    await say(s, 'Раз.');
    await say(s, 'Два.');
    // A1 accepted, alone: its group waits for a second answer.
    expect(s.memoryStatus()).toMatchObject({ queued: [], backlog: 1 });
    s.send({ text: 'Три.', expectedVersion: s.version() });
    const [, u1, , , a2] = pathIds(s);
    expect(s.memoryStatus().queued.map((t) => [t.key, t.range])).toEqual([[`file:${a2}`, [u1, a2]]]);
    await s.memoryWait();
    expect(userText(r.recorder.requests[0]!)).toBe(
      'The narrator just wrote these replies, oldest first:\n\n[1] Ответ один.\n\n[2] Ответ два.\n\nThey answer:\n[1] Раз.\n\n[2] Два.\n\nFile anything that meets the rules above.\n\nWrite every field value in Russian.',
    );
    expect(memRows(r.home, s.id).map((m) => [m.key, m.range])).toEqual([[`file:${a2}`, [u1, a2]]]);

    // A3 (hidden), A4, A5: A4 and A5 group; A3 is never debt.
    const t3 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    for await (const _ of t3.events) void _;
    await say(s, 'Четыре.');
    await say(s, 'Пять.');
    s.send({ text: 'Шесть.', expectedVersion: s.version() });
    const ids = pathIds(s);
    const [a3, u4, a4, u5, a5] = [ids[6]!, ids[7]!, ids[8]!, ids[9]!, ids[10]!];
    s.hide({ messageId: a3, hidden: true, expectedVersion: s.version() });
    expect(s.memoryStatus().queued.map((t) => [t.key, t.range])).toEqual([[`file:${a5}`, [u4, a5]]]);
    // Unhidden, A3 pairs with A4 (range from U3) and A5 waits for its pair.
    s.hide({ messageId: a3, hidden: false, expectedVersion: s.version() });
    expect(s.memoryStatus()).toMatchObject({ queued: [{ key: `file:${a4}`, range: [ids[5], a4] }], backlog: 3 });
    void u5;
    await r.engine.close();
  });
});

describe('the path decides', () => {
  test('a swipe drops the replaced answer\'s row from the view; the new answer is filed', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.'), answer('Агата улыбнулась.')),
      recorder: calls(filed(char('Фрол')), filed(char('Агата'))),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто здесь?');
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    expect(s.compendium().entries.has('character:фрол')).toBe(true);

    const t = s.runTurn({ kind: 'swipe', expectedVersion: s.version() });
    for await (const _ of t.events) void _;
    const b1 = pathIds(s)[2]!;
    expect(b1).not.toBe(a1);
    // The row bound to A1 is off the path: its entry and its task are gone from the view.
    expect(s.compendium().entries.has('character:фрол')).toBe(false);
    expect(s.compendium().tasks.has(`file:${a1}`)).toBe(false);
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([`file:${b1}`]);
    await s.memoryWait();
    expect(s.compendium().entries.has('character:агата')).toBe(true);
    expect(s.compendium().entries.has('character:фрол')).toBe(false);
    await r.engine.close();
  });

  test('an edit inside a filed range makes the pass stale: the lane files the key again', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол, смотритель, кивнул.'), answer('Дальше.')),
      recorder: calls(filed(char('Фрол', { description: 'Смотритель.' })), filed(char('Фрол', { description: 'Кузнец.' }))),
    });
    const s = laneSession(r.engine);
    await say(s, 'Кто ты?');
    s.send({ text: 'Понятно.', expectedVersion: s.version() });
    await s.memoryWait();
    const a1 = pathIds(s)[2]!;
    const first = memRows(r.home, s.id)[0]!;

    s.edit({ messageId: a1, text: 'Фрол, кузнец, кивнул.', expectedVersion: s.version() });
    expect(s.compendium().tasks.get(`file:${a1}`)?.status).toBe('stale');
    expect(s.memoryStatus().queued.map((q) => [q.key, q.attempt])).toEqual([[`file:${a1}`, 1]]);
    await s.memoryWait();
    expect(userText(r.recorder.requests[1]!)).toContain('Фрол, кузнец, кивнул.');
    const rows = memRows(r.home, s.id);
    expect(rows.map((m) => m.key)).toEqual([`file:${a1}`, `file:${a1}`]);
    expect(s.compendium().tasks.get(`file:${a1}`)).toMatchObject({ status: 'applied', seq: rows[1]!.seq });
    expect(rows[1]!.seq).toBeGreaterThan(first.seq);
    expect(s.compendium().entries.get('character:фрол')?.data).toEqual({ name: 'Фрол', description: 'Кузнец.' });
    await r.engine.close();
  });

  test('a top-level list answer is read (the lead\'s ruling G), and {} files nothing', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.'), answer('Тишина.')),
      recorder: calls([{ text: JSON.stringify([char('Фрол')]) }], [{ text: '{}' }]),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто здесь?');
    await s.memoryWait();
    await say(s, 'Ну?');
    await s.memoryWait();
    expect(r.recorder.requests).toHaveLength(2);
    expect(memRows(r.home, s.id).map((m) => m.ops.length)).toEqual([1, 0]);
    expect(s.compendium().entries.has('character:фрол')).toBe(true);
    await r.engine.close();
  });
});
