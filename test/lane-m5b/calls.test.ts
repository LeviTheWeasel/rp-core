// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lane's calls (.notes/m5b-decisions.md D-171, D-172, the lead's ruling G): a tag:null agent's
// answer may be a JSON list (structured.ts firstJson), lane requests are kept with --keep-requests and
// reach the debug tap with their job, and three preemptions in a row make a task starved (one notice).
// After the review (ruling I): the rows keep their calls' usage, done.skipped is the true count, a
// superseded run is told, a recorder with no route is told once.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { firstJson, readAnswer } from '../../src/agents/structured.ts';
import { requestsDir } from '../../src/engine/turn.ts';
import type { JobEntry } from '../../src/session/entries.ts';
import { answer, calls, char, drain, filed, jobRows, jobs, laneEvents, laneRig, laneSession, memRows, pathIds, say, tick, until } from './kit.ts';

describe('a list root for tag:null agents', () => {
  test('firstJson: a fenced or bare list of objects that starts first; an object that starts first wins', () => {
    expect(firstJson('[{"type":"item"}]')).toEqual({ json: '[{"type":"item"}]', whole: true });
    expect(firstJson('Here:\n```json\n[{"a":1}, {"b":2}]\n```')).toEqual({ json: '[{"a":1}, {"b":2}]', whole: true });
    expect(firstJson('Nothing new: []')).toEqual({ json: '[]', whole: true });
    expect(firstJson('{"filings":[{"type":"item"}]}')).toEqual({ json: '{"filings":[{"type":"item"}]}', whole: true });
    // Prose brackets are not a list of objects; a list cut off is not whole.
    expect(firstJson('See [1] and {"a": 1}')).toEqual({ json: '{"a": 1}', whole: true });
    expect(firstJson('[{"type":"item","entry":{"name":"X"')).toEqual({ json: '[{"type":"item","entry":{"name":"X"', whole: false });
    expect(firstJson('no json')).toBeNull();
  });

  test('readAnswer hands a list root to a tag:null reader, never to the plan tag', () => {
    const read = (raw: unknown) => ({ ok: true as const, value: raw, skipped: [] });
    expect(readAnswer({ text: '[{"a":1}]', reasoning: '' }, { tag: null, transport: 'tagged', read })).toEqual({ ok: true, value: [{ a: 1 }], skipped: [], fromReasoning: false });
    expect(readAnswer({ text: '[]', reasoning: '' }, { tag: null, transport: 'tagged', read })).toMatchObject({ ok: true, value: [] });
    expect(readAnswer({ text: '[]', reasoning: '' }, { tag: 'plan', transport: 'structured', read })).toMatchObject({ ok: false, code: 'no_output' });
  });
});

describe('the lane\'s requests', () => {
  test('--keep-requests keeps them under <jobId>:filing:<n>; the debug tap names the job, not a turn', async () => {
    const taps: Record<string, unknown>[] = [];
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls([{ error: { code: 'bad_request', status: 400 } }], filed(char('Фрол'))),
      extra: { keepRequests: true, onProviderError: (i) => taps.push({ ...i }) },
    });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const files = readdirSync(requestsDir(r.home, s.id)).filter((f) => f.includes('_filing_'));
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^j_[0-9a-f]{8}_filing_0\.json$/.test(f))).toBe(true);
    expect(taps).toHaveLength(1);
    const tap = taps[0]!;
    expect(String(tap.callKey)).toMatch(/^j_[0-9a-f]{8}:filing:0$/);
    expect(tap.job).toBe(String(tap.callKey).split(':')[0]);
    expect([tap.sessionId, tap.model, 'turnId' in tap]).toEqual([s.id, 'rec:r', false]);
    await r.engine.close();
  });

  test('without --keep-requests nothing is kept', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(filed(char('Фрол'))) });
    const s = laneSession(r.engine, { filing: { wait: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    expect(existsSync(requestsDir(r.home, s.id))).toBe(false);
    await r.engine.close();
  });
});

describe('starvation (D-172)', () => {
  test('three preemptions in a row: memory_starved once; still no attempt counted', async () => {
    // One connection, one place: every turn takes the place from the filing call.
    const r = await laneRig({
      narrator: calls(
        answer('Один.'),
        [{ pause: 'f1' }],
        answer('Два.'),
        [{ pause: 'f2' }],
        answer('Три.'),
        [{ pause: 'f3' }],
        answer('Четыре.'),
        filed(char('Фрол')),
        filed(),
        filed(),
      ),
    });
    const s = laneSession(r.engine, {}, { roles: { recorder: 'narrator' } });
    await say(s, 'Раз.');
    s.send({ text: 'Два.', expectedVersion: s.version() });
    const key = `file:${pathIds(s)[2]!}`;
    const waiting = s.memoryWait();
    for (const [n, text] of [
      [2, null],
      [4, 'Три.'],
      [6, 'Четыре.'],
    ] as const) {
      await until(() => r.narrator.requests.length === n);
      if (text !== null) s.send({ text, expectedVersion: s.version() });
      await drain(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    }
    await waiting;
    expect(jobs(r.home, s.id).filter((j) => j[1] === key)).toEqual([
      ['begin', key, 1],
      ['begin', key, 1],
      ['begin', key, 1],
      ['begin', key, 1],
    ]);
    await tick();
    const evs = laneEvents(r.events.seen);
    expect(evs.filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', code: 'memory_starved' }]);
    expect(evs.filter((e) => e.type === 'agent' && e.status === 'preempted')).toHaveLength(3);
    expect(s.memoryStatus()).toMatchObject({ queued: [], backlog: 0 });
    await r.engine.close();
  });
});

describe('what the lane tells and keeps after the review (ruling I)', () => {
  test('the mem row and a job{failed} row keep their calls\' usage, as a turn\'s trace.calls rows (cli#6)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол кивнул.')),
      recorder: calls([{ usage: { inputTotal: 300, outputTotal: 0 } }, { error: { code: 'bad_request', status: 400 } }], [{ usage: { inputTotal: 5000, outputTotal: 700 } }, ...filed(char('Фрол'))]),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const failed = jobRows(r.home, s.id).find((j) => j.state === 'failed') as JobEntry & { calls?: unknown };
    expect(failed.calls).toEqual([{ callKey: expect.stringMatching(/^j_[0-9a-f]{8}:filing:0$/), agent: 'filing', model: 'rec:r', ms: expect.any(Number), usage: { inputTotal: 300, outputTotal: 0 } }]);
    const row = memRows(r.home, s.id)[0]!;
    expect(row.calls).toEqual([{ callKey: expect.stringMatching(/^j_[0-9a-f]{8}:filing:0$/), agent: 'filing', model: 'rec:r', ms: expect.any(Number), usage: { inputTotal: 5000, outputTotal: 700 } }]);
    expect(row.gen).toMatchObject({ calls: 1 });
    await r.engine.close();
  });

  test('done.skipped is how many were skipped, not the capped list\'s length (filing#9)', async () => {
    const memories = Array.from({ length: 25 }, (_, i) => ({ what_happened: `Событие ${i}.` }));
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls(filed(char('Фрол', { memories }))) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const row = memRows(r.home, s.id)[0]!;
    expect(row.skipped).toHaveLength(21);
    expect(row.skipped!.at(-1)).toEqual({ path: 'skipped', why: '+5 more' });
    await tick();
    expect(laneEvents(r.events.seen).find((e) => e.type === 'agent' && e.status === 'done')).toMatchObject({ count: 1, skipped: 25 });
    await r.engine.close();
  });

  test('a run the ground left is told as agent{skipped, superseded} (cli#4)', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls([{ pause: 'f' }, ...filed(char('Фрол'))]) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    const a1 = pathIds(s)[2]!;
    const waiting = s.memoryWait();
    await until(() => r.recorder.requests.length === 1);
    s.hide({ messageId: a1, hidden: true, expectedVersion: s.version() });
    expect(await waiting).toMatchObject({ idle: true, queued: [] });
    expect(memRows(r.home, s.id)).toEqual([]);
    await tick();
    expect(laneEvents(r.events.seen).filter((e) => e.type === 'agent').map((e) => [e.status, e.reason])).toEqual([
      ['queued', undefined],
      ['started', undefined],
      ['skipped', 'superseded'],
    ]);
    await r.engine.close();
  });

  test('a recorder with no route: recorder_unavailable once, not the backlog notice that blames its pace (cli#9)', async () => {
    const r = await laneRig({ narrator: calls(...['1', '2', '3', '4', '5', '6'].map((n) => answer(`Ответ ${n}.`))) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } }, { roles: { recorder: { conn: 'ghost', model: 'x' } } });
    for (const n of ['1', '2', '3', '4', '5', '6']) await say(s, `Ход ${n}.`);
    expect(s.memoryStatus().backlog).toBe(6);
    expect(await s.memoryWait()).toMatchObject({ idle: true });
    await tick();
    const notices = r.events.seen.flatMap((e) => (e.type === 'notice' ? [[e.code, e.message]] : []));
    expect(notices.map((n) => n[0])).toEqual(['recorder_unavailable']);
    expect(notices[0]![1]).toContain('"ghost"');
    await r.engine.close();
  });
});
