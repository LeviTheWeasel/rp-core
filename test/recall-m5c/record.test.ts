// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// agents/compendium/recall.ts RecallRecord builders and checkRecallRecord (M5c, D-200, D-203): a run's
// status, source and code; the top-up's choice; lite's unreadable answer (ruling G: failed); skipped
// (no_room too), missed and reused records;
// what a stored record reads back as.
import { describe, expect, test } from 'bun:test';
import { checkRecallRecord, missedRecord, recallPicks, recallRecord, reusable, reusedRecord, skippedRecord, type RecallRead, type RecallRun } from '../../src/agents/compendium/recall.ts';
import type { StructuredFailCode, StructuredResult, TraceCall } from '../../src/agents/structured.ts';
import type { RecallRecord } from '../../src/session/entries.ts';

const call = (n: number, usage?: { inputTotal: number; outputTotal: number }): TraceCall => ({ callKey: `t:recall:${n}`, agent: 'recall', model: 'loc:qwen', ms: 10, ...(usage ? { usage } : {}) });
const read = (refs: string[], extra: Partial<RecallRead> = {}): RecallRead => ({
  picks: refs.map((ref, i) => ({ ref, handle: `e${i + 1}`, reason: `why ${ref}` })),
  unknown: 0,
  repeated: 0,
  trimmed: 0,
  byName: 0,
  salvaged: 0,
  ...extra,
});
const ok = (value: RecallRead, calls: TraceCall[] = [call(0)]): StructuredResult<RecallRead> => ({ ok: true, value, transport: 'tagged', skipped: [], attempts: [], calls });
const fail = (code: StructuredFailCode, calls: TraceCall[] = [call(0)]): StructuredResult<RecallRead> => ({ ok: false, code, attempts: [], calls });
const run = (o: Partial<RecallRun>): RecallRun => ({ source: 'sync', profile: 'full', omitted: 0, model: 'loc:qwen', transport: 'tagged', first: ok(read(['a'])), ...o });

describe('recallRecord (D-200)', () => {
  test('a read with picks: recalled, keys in the model’s order with reasons, the counts, calls and usage', () => {
    const rec = recallRecord(
      run({
        first: ok(read(['character:mira', 'lib:b:e1'], { unknown: 2, repeated: 1, trimmed: 1, byName: 1, salvaged: 0 }), [call(0, { inputTotal: 900, outputTotal: 30 }), call(1, { inputTotal: 950, outputTotal: 40 })]),
        omitted: 5,
        ms: 1234,
      }),
    );
    expect(rec).toEqual({
      v: 1,
      status: 'recalled',
      source: 'sync',
      profile: 'full',
      picks: [
        { ref: 'character:mira', reason: 'why character:mira' },
        { ref: 'lib:b:e1', reason: 'why lib:b:e1' },
      ],
      unknown: 2,
      repeated: 1,
      trimmed: 1,
      omitted: 5,
      byName: 1,
      salvaged: 0,
      calls: 2,
      ms: 1234,
      model: 'loc:qwen',
      transport: 'tagged',
      usage: { input: 1850, output: 70 },
    } satisfies RecallRecord);
  });

  test('an answer with no picks is empty; a prefetch keeps its source and basis; lite drops reasons', () => {
    expect(recallRecord(run({ first: ok(read([])) }))).toMatchObject({ status: 'empty', source: 'sync', picks: [], calls: 1 });
    expect(recallRecord(run({ source: 'prefetch', basis: 'm_a4' }))).toMatchObject({ status: 'recalled', source: 'prefetch', basis: 'm_a4' });
    expect(recallRecord(run({ profile: 'lite' })).picks).toEqual([{ ref: 'a' }]);
    expect(recallRecord(run({})).usage).toBeUndefined();
  });

  test('the top-up wins only when it read and has more picks; its calls count either way', () => {
    const more = recallRecord(run({ first: ok(read(['a'])), topUp: ok(read(['a', 'b']), [call(1)]) }));
    expect(more).toMatchObject({ status: 'recalled', calls: 2 });
    expect(more.picks.map((p) => p.ref)).toEqual(['a', 'b']);
    const fewer = recallRecord(run({ first: ok(read(['a', 'b'])), topUp: ok(read(['c']), [call(1)]) }));
    expect(fewer.picks.map((p) => p.ref)).toEqual(['a', 'b']);
    const failed = recallRecord(run({ first: ok(read(['a'])), topUp: fail('timeout', [call(1)]) }));
    expect(failed).toMatchObject({ status: 'recalled', calls: 2, picks: [{ ref: 'a' }] });
    expect(failed.code).toBeUndefined();
  });

  test('a failure: failed, source lexical (the selector stands in), its code; the model is named', () => {
    const cases: [StructuredFailCode, NonNullable<RecallRecord['code']>][] = [
      ['timeout', 'timeout'],
      ['provider_error', 'provider_error'],
      ['no_output', 'no_output'],
      ['undecodable', 'undecodable'],
      ['invalid', 'undecodable'],
      ['transport_unsupported', 'transport_unsupported'],
      ['aborted', 'aborted'],
      ['preempted', 'aborted'],
    ];
    for (const [code, want] of cases) {
      expect(recallRecord(run({ first: fail(code, [call(0), call(1)]), omitted: 3 }))).toEqual({
        v: 1,
        status: 'failed',
        source: 'lexical',
        profile: 'full',
        picks: [],
        unknown: 0,
        repeated: 0,
        trimmed: 0,
        omitted: 3,
        byName: 0,
        salvaged: 0,
        calls: 2,
        model: 'loc:qwen',
        transport: 'tagged',
        code: want,
      });
    }
  });

  test('lite (ruling G): an unreadable answer is a failure like full (never reused; the turn falls back per onMiss)', () => {
    expect(recallRecord(run({ profile: 'lite', first: fail('no_output') }))).toMatchObject({ status: 'failed', source: 'lexical', code: 'no_output', calls: 1 });
    expect(recallRecord(run({ profile: 'lite', first: fail('invalid') }))).toMatchObject({ status: 'failed', source: 'lexical', code: 'undecodable' });
    expect(recallRecord(run({ profile: 'lite', first: fail('timeout') }))).toMatchObject({ status: 'failed', source: 'lexical', code: 'timeout' });
  });
});

describe('records without a call', () => {
  test('skipped: an empty index or no connection, the selector stands in', () => {
    expect(skippedRecord({ profile: 'full', code: 'empty_index', omitted: 0 })).toEqual({
      v: 1,
      status: 'skipped',
      source: 'lexical',
      profile: 'full',
      picks: [],
      unknown: 0,
      repeated: 0,
      trimmed: 0,
      omitted: 0,
      byName: 0,
      salvaged: 0,
      calls: 0,
      code: 'empty_index',
    });
    expect(skippedRecord({ profile: 'lite', code: 'no_connection', model: 'gone:m' })).toMatchObject({ code: 'no_connection', model: 'gone:m', calls: 0 });
    // Ruling G: a request that cannot fit the recall window.
    const noRoom = skippedRecord({ profile: 'lite', code: 'no_room', model: 'loc:qwen' });
    expect(noRoom).toMatchObject({ status: 'skipped', source: 'lexical', code: 'no_room', calls: 0 });
    expect(checkRecallRecord(noRoom)).toEqual(noRoom);
  });

  test('a missed prefetch falling back to the selector', () => {
    expect(missedRecord({ profile: 'lite', basis: 'm_a3' })).toMatchObject({ status: 'skipped', source: 'lexical', code: 'prefetch_missed', basis: 'm_a3', calls: 0, picks: [] });
  });
});

describe('reuse on a swipe or continue (D-203)', () => {
  const answered = recallRecord(run({ source: 'prefetch', basis: 'm_a1', ms: 900, first: ok(read(['a', 'b']), [call(0, { inputTotal: 10, outputTotal: 2 })]) }));

  test('a recalled or empty record is reused: its picks and counts, 0 calls, reusedFrom; no ms, usage or basis', () => {
    const re = reusedRecord(answered, 'm_a2');
    expect(re).toEqual({
      v: 1,
      status: 'recalled',
      source: 'reused',
      profile: 'full',
      picks: answered.picks,
      unknown: 0,
      repeated: 0,
      trimmed: 0,
      omitted: 0,
      byName: 0,
      salvaged: 0,
      calls: 0,
      model: 'loc:qwen',
      transport: 'tagged',
      reusedFrom: 'm_a2',
    });
    expect(re!.picks).not.toBe(answered.picks);
    expect(reusedRecord(recallRecord(run({ first: ok(read([])) })), 'm_x')).toMatchObject({ status: 'empty', source: 'reused' });
    expect(recallPicks(re)).toEqual(['a', 'b']);
    expect(recallPicks(null)).toEqual([]);
  });

  test('a failed, skipped or absent record is not reused', () => {
    expect(reusable(recallRecord(run({ first: fail('timeout') })))).toBe(false);
    expect(reusedRecord(skippedRecord({ profile: 'full', code: 'empty_index' }), 'm')).toBeNull();
    expect(reusedRecord(missedRecord({ profile: 'full' }), 'm')).toBeNull();
    expect(reusedRecord(undefined, 'm')).toBeNull();
  });
});

describe('checkRecallRecord: a stored record (D-200)', () => {
  const good = recallRecord(run({ source: 'prefetch', basis: 'm_a1', ms: 12, first: ok(read(['a']), [call(0, { inputTotal: 5, outputTotal: 1 })]) }));

  test('a written record reads back equal (also through JSON)', () => {
    expect(checkRecallRecord(good)).toEqual(good);
    expect(checkRecallRecord(JSON.parse(JSON.stringify(good)))).toEqual(good);
    for (const rec of [skippedRecord({ profile: 'lite', code: 'empty_index' }), missedRecord({ profile: 'full' }), reusedRecord(good, 'm_a2')!]) {
      expect(checkRecallRecord(rec)).toEqual(rec);
    }
  });

  test('bad required fields read as absent', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      { ...good, v: 2 },
      { ...good, status: 'ok' },
      { ...good, source: 'off' },
      { ...good, profile: 'auto' },
      { ...good, picks: 'a' },
      { ...good, calls: -1 },
      { ...good, unknown: 1.5 },
      { ...good, byName: undefined },
      { ...good, salvaged: '0' },
    ];
    for (const b of bad) expect(checkRecallRecord(b)).toBeNull();
  });

  test('bad optional fields and bad picks are dropped, reasons cut, unknown keys not copied', () => {
    const back = checkRecallRecord({
      ...good,
      picks: [{ ref: 'a', reason: `  ${'r'.repeat(300)}` }, { ref: '' }, 'b', { ref: 'c', reason: 7 }, ...Array.from({ length: 70 }, (_, i) => ({ ref: `x${i}` }))],
      ms: -5,
      model: 7,
      transport: 'tool',
      code: 'weird',
      basis: 'b'.repeat(81),
      reusedFrom: '',
      usage: { input: 1 },
      extra: 'dropped',
    });
    expect(back).not.toBeNull();
    expect(back!.picks[0]).toEqual({ ref: 'a', reason: 'r'.repeat(200) });
    expect(back!.picks[1]).toEqual({ ref: 'c' });
    expect(back!.picks).toHaveLength(62);
    for (const k of ['ms', 'model', 'transport', 'code', 'basis', 'reusedFrom', 'usage', 'extra']) expect(Object.hasOwn(back!, k)).toBe(false);
  });
});
