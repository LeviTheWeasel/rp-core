// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// structuredCall after the M5b review (.notes/m5b-decisions.md, the lead's ruling I): a background call's
// budget runs only while one of its calls holds a slot (review sched#3), and a tag:null answer cut off
// before its JSON closed keeps the items that closed, drops the unfinished last one and fails when none
// closed — whatever the finish (review breaker#3).
import { describe, expect, test } from 'bun:test';
import { filingReader } from '../../src/agents/compendium/filing.ts';
import { readHistorianAnswer, type HistorianAnswer } from '../../src/agents/compendium/historian.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import type { ReadResult } from '../../src/agents/director/types.ts';
import { closedItems, readAnswer } from '../../src/agents/structured.ts';
import { createScheduler } from '../../src/engine/sched.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import { calls, P, rig } from './kit.ts';

const SLOW = { firstByteMs: 10_000_000, idleMs: 10_000_000 };
const asIs = (raw: unknown): ReadResult<unknown> => ({ ok: true, value: raw, skipped: [] });

describe('review sched#3: a background call’s budget runs only while it holds a slot', () => {
  test.each(['remote', 'local'])('%s: a §6.6 retry queued behind a turn longer than the budget still runs', async (where) => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers, isLocal: () => where === 'local' });
    const sem = sched.forOrigin('script:dir', 1);
    const r = rig(calls([{ error: { code: 'overloaded', status: 503 } }], [{ text: '{"filings":[]}' }]), {
      sched,
      timers,
      env: { timeouts: SLOW, retryMaxDelayMs: 1_000, clock: () => new Date(timers.now()) },
      input: { agent: 'filing', tag: null, priority: 'background', budgetMs: 120_000, callKeyPrefix: 'j_1:filing', read: asIs },
    });
    const pending = r.run();
    await settle();
    // During the backoff a turn takes the only place, and holds it far longer than the budget.
    const turn = await sem.acquire('interactive');
    timers.advance(1_000);
    await settle();
    timers.advance(300_000);
    await settle();
    expect(r.provider.requests.length).toBe(1);
    turn.release();
    await settle();
    timers.advance(10_000);
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('ok');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['retried', 'ok']);
    expect(r.provider.requests.length).toBe(2);
  });

  test('the time its calls hold a slot adds up; the backoff between them does not count', async () => {
    const timers = fakeTimers();
    const r = rig(calls([{ delay: 600 }, { error: { code: 'overloaded', status: 503 } }], [{ delay: 600 }, { text: '{"filings":[]}' }]), {
      timers,
      env: { timeouts: SLOW, retryMaxDelayMs: 1_000, clock: () => new Date(timers.now()) },
      input: { agent: 'historian', tag: null, priority: 'background', budgetMs: 1_000, callKeyPrefix: 'j_1:historian', read: asIs },
    });
    const pending = r.run();
    await settle();
    timers.advance(600); // the first call: 600 ms held, then a retryable error
    await settle();
    timers.advance(1_300); // the backoff (1 000 ms and its jitter): not timed
    await settle();
    expect(r.provider.requests.length).toBe(2);
    timers.advance(400); // 600 + 400 held: the budget is spent mid-retry
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(r.provider.requests[1]!.signal.reason).toBeDefined();
  });

  test('an interactive call keeps D-101’s one running budget from its first slot', async () => {
    const timers = fakeTimers();
    const r = rig(calls([{ error: { code: 'overloaded', status: 503 } }], [{ text: P }]), {
      timers,
      env: { timeouts: SLOW, retryMaxDelayMs: 1_000, clock: () => new Date(timers.now()) },
      input: { budgetMs: 500 },
    });
    const pending = r.run();
    await settle();
    timers.advance(1_000); // the backoff outlasts the Director's budget
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(r.provider.requests.length).toBe(1);
  });
});

describe('review breaker#3: closedItems', () => {
  test('the items that closed are kept, the unfinished last one is left out', () => {
    expect(closedItems('{"filings": [{"type":"character","entry":{"name":"Фрол"}}, {"type":"character","entry":{"name":"Ми')).toEqual({
      json: '{"filings": [{"type":"character","entry":{"name":"Фрол"}}]}',
      items: 1,
      dropped: true,
    });
    expect(closedItems('[{"a":1},{"b":')).toEqual({ json: '[{"a":1}]', items: 1, dropped: true });
    expect(closedItems('{"filings":[{"t":"s"}],"arcs":[{"plot":"P","overview":"Обз')).toEqual({ json: '{"filings":[{"t":"s"}],"arcs":[]}', items: 1, dropped: true });
    // Braces and brackets inside strings do not count.
    expect(closedItems('{"filings":[{"name":"a } ] { \\" ["},{"name":"b')).toEqual({ json: '{"filings":[{"name":"a } ] { \\" ["}]}', items: 1, dropped: true });
  });

  test('nothing was left out when only closers or a comma are missing', () => {
    expect(closedItems('{"filings":[{"a":1}]')).toEqual({ json: '{"filings":[{"a":1}]}', items: 1, dropped: false });
    expect(closedItems('{"filings":[{"a":1},')).toEqual({ json: '{"filings":[{"a":1}]}', items: 1, dropped: false });
    expect(closedItems('{"filings":[{"a":1}],"arcs":[')).toEqual({ json: '{"filings":[{"a":1}],"arcs":[]}', items: 1, dropped: false });
  });

  test('no item closed: null (an opener alone, an unfinished first item, a root object without a list)', () => {
    for (const json of ['{"filings": [', '{"filings":[{"type":"item","entry":{"name":"Стар', '[', '{"type":"character","entry":{"name":"Ми', '{"filings":[],"arcs":[{"plot":"P","overview":"Обз']) {
      expect(closedItems(json)).toBeNull();
    }
  });
});

describe('review breaker#3: a cut-off tag:null answer through readAnswer and structuredCall', () => {
  const read = filingReader({ allow: DEFAULT_FILING_ALLOW, profile: 'full' });
  const TWO = '{"filings": [{"type":"character","entry":{"name":"Фрол","description":"смотритель"}}, {"type":"character","entry":{"name":"Ми';

  test.each(['end', 'length', undefined])('finish %s: the complete item is filed, the cut one is not, and the cut is said', (finish) => {
    const got = readAnswer({ text: TWO, reasoning: '' }, { tag: null, transport: 'tagged', ...(finish ? { finish } : {}), read });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect((got.value as { name: string }[]).map((i) => i.name)).toEqual(['Фрол']);
    expect(got.skipped).toEqual([{ path: 'answer', why: 'cut_off: the answer was cut off; its unfinished last item was left out' }]);
  });

  test.each(['end', 'length'])('finish %s: an answer with no closed item is undecodable — never an empty cover', (finish) => {
    for (const text of ['{"filings": [', '{"filings":[{"type":"item","entry":{"name":"Стар', '```json\n{"filings": [\n']) {
      expect(readAnswer({ text, reasoning: '' }, { tag: null, transport: 'tagged', finish, read })).toEqual({
        ok: false,
        code: 'undecodable',
        message: 'the answer was cut off before its first item closed',
      });
    }
  });

  test('the historian: the summary that closed is applied, the unfinished arc is not', () => {
    const text = '{"filings":[{"type":"summary","entry":{"title":"T","parent_plot":"P","summary":"S"}}],"arcs":[{"plot":"P","overview":"Обз';
    const got = readAnswer({ text, reasoning: '' }, { tag: null, transport: 'tagged', finish: 'end', read: (raw) => readHistorianAnswer(raw) });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const a = got.value as HistorianAnswer;
    expect([a.summaries.map((s) => s.data.title), a.arcs]).toEqual([['T'], []]);
  });

  test('structuredCall: no closed item runs the corrective pass, then succeeds; one closed item needs no second call', async () => {
    const MAP = '{"filings":[{"type":"item","entry":{"name":"Старая карта"}}]}';
    const cut = rig(calls([{ text: '{"filings": [' }], [{ text: MAP }]), { input: { agent: 'filing', tag: null, read, callKeyPrefix: 'j_1:filing' } });
    const out = await cut.run();
    expect(out.attempts.map((a) => a.outcome)).toEqual(['undecodable', 'ok']);
    expect(out.ok && (out.value as { name: string }[]).map((i) => i.name)).toEqual(['Старая карта']);
    const one = rig(calls([{ text: TWO }]), { input: { agent: 'filing', tag: null, read, callKeyPrefix: 'j_1:filing' } });
    const res = await one.run();
    expect(res.ok && (res.value as { name: string }[]).map((i) => i.name)).toEqual(['Фрол']);
    expect(one.provider.requests.length).toBe(1);
  });

  test('the plan tag is unchanged: a cut-off plan reads as before (finish end: closed by the repair; length: undecodable)', () => {
    const plan = (raw: unknown): ReadResult<unknown> => ({ ok: true, value: raw, skipped: [] });
    expect(readAnswer({ text: '{"directive":{"mood":"tense"', reasoning: '' }, { tag: 'plan', transport: 'tagged', finish: 'end', read: plan })).toMatchObject({ ok: true, value: { directive: { mood: 'tense' } } });
    expect(readAnswer({ text: '{"directive":{"mood":"tense"', reasoning: '' }, { tag: 'plan', transport: 'tagged', finish: 'length', read: plan })).toMatchObject({ ok: false, code: 'undecodable' });
  });
});
