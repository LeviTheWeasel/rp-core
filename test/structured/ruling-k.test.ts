// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// structuredCall after the M5b final check (.notes/m5b-decisions.md, the lead's ruling K): a cut-off
// answer whose root is a bare flat item is unreadable — its own lists are its fields, not item lists
// (agents-cli structured.ts:425) — and a tag:null result says `cutOff` (finish 'length', or a JSON that
// closedItems closed) so the lane can fail a cut-off answer that gave it nothing to apply (agents-cli
// lane.ts:1324: the historian's plot closed, its summary cut).
import { describe, expect, test } from 'bun:test';
import { filingReader } from '../../src/agents/compendium/filing.ts';
import { historianOps, readHistorianAnswer, type HistorianAnswer } from '../../src/agents/compendium/historian.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import type { ReadResult } from '../../src/agents/director/types.ts';
import { closedItems, readAnswer } from '../../src/agents/structured.ts';
import { viewOf } from '../historian-m5b/kit.ts';
import { calls, P, rig } from './kit.ts';

const read = filingReader({ allow: DEFAULT_FILING_ALLOW, profile: 'full' });
const asIs = (raw: unknown): ReadResult<unknown> => ({ ok: true, value: raw, skipped: [] });

/** The two bare items of the final check, cut inside them (finish 'length'). */
const CUT_IN_NAME = '{"type":"character","relationships":[{"with":"Ян","nature":"ally"}],"name":"Фр';
const CUT_IN_DESCRIPTION = '{"type":"character","name":"Фрол","relationships":[{"with":"Ян","nature":"ally"}],"description":"Высокий рыбак с';

describe('a cut-off bare flat item is one item that did not close: unreadable', () => {
  test('closedItems: its relationships list holds fields, not items', () => {
    for (const json of [CUT_IN_NAME, CUT_IN_DESCRIPTION]) expect(closedItems(json)).toBeNull();
    // Its type, identity or entry key makes the root the item, in any spelling and wherever it stands.
    expect(closedItems('{"relationships":[{"with":"Ян"}],"Entry_Type":"character","descr')).toBeNull();
    expect(closedItems('{"title":"Туман","characters":[{"name":"Ян"}],"summary":"Туман опуст')).toBeNull();
  });

  test.each(['end', 'length'])('readAnswer, finish %s: undecodable — never filed half, never an empty cover', (finish) => {
    for (const text of [CUT_IN_NAME, CUT_IN_DESCRIPTION]) {
      expect(readAnswer({ text, reasoning: '' }, { tag: null, transport: 'tagged', finish, read })).toEqual({
        ok: false,
        code: 'undecodable',
        message: 'the answer was cut off before its first item closed',
      });
    }
  });

  test('envelopes and type-keyed roots still hold items (an item key beside an envelope does not make it one item)', () => {
    expect(closedItems('{"character":[{"name":"Фрол"}],"location":[{"name":"Ма')).toEqual({ json: '{"character":[{"name":"Фрол"}],"location":[]}', items: 1, dropped: true });
    expect(closedItems('{"name":"answer","filings":[{"type":"item","entry":{"name":"Карта"}},{"type":"it')).toEqual({
      json: '{"name":"answer","filings":[{"type":"item","entry":{"name":"Карта"}}]}',
      items: 1,
      dropped: true,
    });
    expect(closedItems('{"summaries":[{"title":"T","summary":"S"}],"arcs":[{"plot":"P","overview":"Обз')).toEqual({
      json: '{"summaries":[{"title":"T","summary":"S"}],"arcs":[]}',
      items: 1,
      dropped: true,
    });
    // A key inside an item, or a string value that reads like a key, is not the root's.
    expect(closedItems('{"filings":[{"name":"type: x"},{"name":"b')).toEqual({ json: '{"filings":[{"name":"type: x"}]}', items: 1, dropped: true });
  });

  test('the same item cut off inside an envelope keeps failing (no item closed)', () => {
    expect(closedItems(`{"filings":[${CUT_IN_DESCRIPTION}`)).toBeNull();
  });
});

describe('a tag:null result says cutOff', () => {
  const TWO = '{"filings": [{"type":"character","entry":{"name":"Фрол","description":"смотритель"}}, {"type":"character","entry":{"name":"Ми';
  const WHOLE = '{"filings":[{"type":"character","entry":{"name":"Фрол","description":"смотритель"}}]}';

  test('a JSON closed by closedItems (any finish), a whole one with finish length: cutOff', () => {
    for (const finish of ['end', 'length', undefined]) {
      const got = readAnswer({ text: TWO, reasoning: '' }, { tag: null, transport: 'tagged', ...(finish ? { finish } : {}), read });
      expect(got.ok && got.cutOff).toBe(true);
    }
    // Closed right after a complete item: nothing was left out, but the answer was still cut.
    const after = readAnswer({ text: '{"filings":[{"type":"item","entry":{"name":"Карта"}}', reasoning: '' }, { tag: null, transport: 'tagged', finish: 'length', read });
    expect(after.ok && [after.cutOff, after.skipped]).toEqual([true, []]);
    const whole = readAnswer({ text: WHOLE, reasoning: '' }, { tag: null, transport: 'tagged', finish: 'length', read });
    expect(whole.ok && whole.cutOff).toBe(true);
  });

  test('a whole answer that ended: no cutOff; nor for the plan tag', () => {
    const whole = readAnswer({ text: WHOLE, reasoning: '' }, { tag: null, transport: 'tagged', finish: 'end', read });
    expect(whole.ok).toBe(true);
    expect(whole.ok && 'cutOff' in whole).toBe(false);
    const plan = readAnswer({ text: `<plan>${P}</plan>\nAnd then I keep writing until`, reasoning: '' }, { tag: 'plan', transport: 'tagged', finish: 'length', read: asIs });
    expect(plan.ok && 'cutOff' in plan).toBe(false);
  });

  test('structuredCall carries it on the result', async () => {
    const cut = await rig(calls([{ text: TWO }, { finish: 'length' }]), { input: { agent: 'filing', tag: null, read, callKeyPrefix: 'j_1:filing' } }).run();
    expect(cut.ok && cut.cutOff).toBe(true);
    const whole = await rig(calls([{ text: WHOLE }]), { input: { agent: 'filing', tag: null, read, callKeyPrefix: 'j_1:filing' } }).run();
    expect(whole.ok && 'cutOff' in whole).toBe(false);
  });

  test('the historian: a closed plot, its summary cut — read, cutOff, and nothing to apply as a summary', async () => {
    const text = '{"filings":[{"type":"plot","entry":{"name":"Маяк","status":"active"}},{"type":"summary","entry":{"title":"Туман","parent_plot":"Маяк","summary":"Туман опустился';
    const res = await rig(calls([{ text }, { finish: 'length' }]), {
      input: { agent: 'historian', tag: null, read: (raw: unknown) => readHistorianAnswer(raw), callKeyPrefix: 'j_1:historian' },
    }).run();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cutOff).toBe(true);
    expect(res.skipped).toContainEqual({ path: 'answer', why: 'cut_off: the answer was cut off; its unfinished last item was left out' });
    const ops = historianOps(res.value as HistorianAnswer, { newStart: 2, end: 3 }, viewOf([]), 'full');
    // The lane's rule (ruling K): no summary applied while cut off → the attempt fails.
    expect([ops.offered, ops.applied]).toEqual([0, 0]);
  });
});
