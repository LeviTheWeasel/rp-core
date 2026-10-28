// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// agents/structured.ts `opening` (M5c, D-208; the live run of .notes/m5c-decisions.md section J): a
// tag:null agent names its answer's JSON opening; on the tagged transport, when the caps take an
// assistant prefill, every call sends it as the prefill and the answer is read as the opening followed
// by the model's text. Not on the structured transport, not for caps without a prefill, not for tag
// 'plan'. A rawRead agent's corrective pass quotes its reader's reason (cli#8: prose is undecodable).
import { describe, expect, test } from 'bun:test';
import { FILING_OPENING } from '../../src/agents/compendium/filing.ts';
import { HISTORIAN_OPENING } from '../../src/agents/compendium/historian.ts';
import { RECALL_OPENING, recallReader, type RecallRead } from '../../src/agents/compendium/recall.ts';
import { openingOf, readRawAnswer, withOpening } from '../../src/agents/structured.ts';
import type { ReadResult } from '../../src/agents/director/types.ts';
import { SCRIPT_CAPS, scriptCapsWith } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import { calls, P, rig, STRUCTURED_CAPS, textOfMsg } from './kit.ts';

const reader = recallReader({
  handles: new Map([
    ['e1', 'k:marfa'],
    ['e2', 'k:merchant'],
  ]),
  names: new Map(),
  maxEntries: 10,
  profile: 'full',
});

/** A recall-shaped call (rawRead) with the recall opening on the shared rig. */
function recallRig(script: Parameters<typeof rig>[0], caps: ModelCaps = SCRIPT_CAPS, o: { opening?: string; repair?: boolean } = {}) {
  return rig<RecallRead>(script, {
    caps,
    input: {
      agent: 'recall',
      tag: null,
      schema: { name: 'recall', schema: { type: 'object' } },
      read: reader.read,
      rawRead: reader.rawRead,
      repair: o.repair ?? true,
      callKeyPrefix: 't_1:recall',
      opening: o.opening ?? RECALL_OPENING,
    },
  });
}

const picks = (r: { ok: boolean; value?: RecallRead }): string[] => (r.ok && r.value ? r.value.picks.map((p) => p.handle) : []);

describe('the prefill (D-208)', () => {
  test('tagged, caps that take a prefill: the opening is sent, and opening + continuation is the answer', async () => {
    const x = recallRig(calls([{ text: 'e1]}' }]));
    const r = await x.run();
    expect(x.provider.requests[0]!.prefill).toBe('{"entry_ids": [');
    expect(r).toMatchObject({ ok: true, transport: 'tagged', attempts: [{ outcome: 'ok' }] });
    expect(picks(r)).toEqual(['e1']);
  });

  test('prefix-flag caps take it too', async () => {
    const x = recallRig(calls([{ text: '"e2"]}' }]), scriptCapsWith({ prefill: 'prefix-flag' }));
    expect(picks(await x.run())).toEqual(['e2']);
    expect(x.provider.requests[0]!.prefill).toBe(RECALL_OPENING);
  });

  test('not sent on the structured transport, nor to caps without a prefill; the answer is read alone', async () => {
    const structured = recallRig(calls([{ text: '{"entry_ids": ["e2"]}' }]), STRUCTURED_CAPS);
    expect(picks(await structured.run())).toEqual(['e2']);
    expect(structured.provider.requests[0]!.prefill).toBeUndefined();
    const none = recallRig(calls([{ text: '["e1"]' }]), scriptCapsWith({ prefill: 'none' }));
    expect(picks(await none.run())).toEqual(['e1']);
    expect(none.provider.requests[0]!.prefill).toBeUndefined();
  });

  test('an answer that writes the opening itself, opens a fence or a list of its own, is read alone', async () => {
    expect(picks(await recallRig(calls([{ text: '{ "entry_ids" : ["e2"] }' }])).run())).toEqual(['e2']);
    expect(picks(await recallRig(calls([{ text: '["e2", "e1"]' }])).run())).toEqual(['e2', 'e1']);
    expect(picks(await recallRig(calls([{ text: '```json\n{"entry_ids": ["e1"]}\n```' }])).run())).toEqual(['e1']);
  });

  test('an empty answer stays empty: no_output, not the opening read as a cut-off list', async () => {
    const r = await recallRig(calls([{ text: '' }]), SCRIPT_CAPS, { repair: false }).run();
    expect(r).toMatchObject({ ok: false, code: 'no_output' });
  });

  test('the corrective pass keeps the prefill and echoes the opening with the bad answer; prose is undecodable', async () => {
    const prose = 'Marfa smiles and pours another cup.';
    const x = recallRig(calls([{ text: prose }], [{ text: '"e2"]}' }]));
    const r = await x.run();
    expect(r.attempts.map((a) => a.outcome)).toEqual(['undecodable', 'ok']);
    expect(picks(r)).toEqual(['e2']);
    const second = x.provider.requests[1]!;
    expect(second.prefill).toBe(RECALL_OPENING);
    expect(textOfMsg(second.messages.at(-2)!)).toBe(`${RECALL_OPENING}${prose}`);
    expect(textOfMsg(second.messages.at(-1)!)).toContain('(the JSON could not be read)');
  });

  test('cli#8: prose without a prefill is undecodable, and the correction quotes the reader: no JSON object was found', async () => {
    const x = recallRig(calls([{ text: 'Marfa smiles and pours another cup.' }], [{ text: '["e1"]' }]), scriptCapsWith({ prefill: 'none' }));
    const r = await x.run();
    expect(r.attempts.map((a) => a.outcome)).toEqual(['undecodable', 'ok']);
    expect(textOfMsg(x.provider.requests[1]!.messages.at(-1)!)).toBe('Your answer was not usable (no JSON object was found). Answer again with exactly one JSON object following the schema above. Write nothing else.');
  });

  test('without an opening nothing changes: no prefill', async () => {
    const x = rig<RecallRead>(calls([{ text: '["e1"]' }]), {
      input: { agent: 'recall', tag: null, schema: { name: 'recall', schema: {} }, read: reader.read, rawRead: reader.rawRead, repair: false, callKeyPrefix: 't:recall' },
    });
    expect(picks(await x.run())).toEqual(['e1']);
    expect(x.provider.requests[0]!.prefill).toBeUndefined();
  });

  test('a JSON agent without rawRead (filing, the historian) reads the opening and its items as one object', async () => {
    const seen: unknown[] = [];
    const read = (raw: unknown): ReadResult<unknown> => {
      seen.push(raw);
      return { ok: true, value: raw, skipped: [] };
    };
    const x = rig<unknown>(calls([{ text: '{"type": "character", "entry": {"name": "Marfa"}}]}' }]), {
      input: { agent: 'filing', tag: null, schema: { name: 'filing', schema: {} }, read, repair: true, callKeyPrefix: 'j:filing', opening: FILING_OPENING, priority: 'background' },
    });
    const r = await x.run();
    expect(x.provider.requests[0]!.prefill).toBe('{"filings": [');
    expect(r).toMatchObject({ ok: true, value: { filings: [{ type: 'character', entry: { name: 'Marfa' } }] } });
    expect(HISTORIAN_OPENING).toBe('{"filings": [');
  });

  test('tag "plan" (the Director) never sends one', async () => {
    const x = rig(calls([{ text: `<plan>${P}</plan>` }]), { input: { opening: '{"directive": {' } });
    expect(await x.run()).toMatchObject({ ok: true });
    expect(x.provider.requests[0]!.prefill).toBeUndefined();
  });
});

describe('openingOf, withOpening, readRawAnswer', () => {
  const route = { conn: {} as never, model: 'm', caps: SCRIPT_CAPS };

  test('openingOf: tag null, tagged, a prefill in the caps and a non-blank opening', () => {
    expect(openingOf({ tag: null, transport: 'tagged', opening: RECALL_OPENING, route })).toBe(RECALL_OPENING);
    expect(openingOf({ tag: null, transport: 'structured', opening: RECALL_OPENING, route })).toBeUndefined();
    expect(openingOf({ tag: 'plan', transport: 'tagged', opening: RECALL_OPENING, route })).toBeUndefined();
    expect(openingOf({ tag: null, transport: 'tagged', opening: ' ', route })).toBeUndefined();
    expect(openingOf({ tag: null, transport: 'tagged', opening: RECALL_OPENING, route: { ...route, caps: scriptCapsWith({ prefill: 'none' }) } })).toBeUndefined();
  });

  test('withOpening: the opening and the text; the text alone when blank, restated, fenced or whole', () => {
    expect(withOpening(RECALL_OPENING, '"e1"]}')).toBe('{"entry_ids": ["e1"]}');
    expect(withOpening(undefined, 'x')).toBe('x');
    expect(withOpening(RECALL_OPENING, '  \n')).toBe('  \n');
    expect(withOpening(RECALL_OPENING, '\n{"entry_ids":["e1"]}')).toBe('\n{"entry_ids":["e1"]}');
    expect(withOpening(FILING_OPENING, '~~~\n{}\n~~~')).toBe('~~~\n{}\n~~~');
    // A list of its own after an opening that ends in a list: a whole answer.
    expect(withOpening(RECALL_OPENING, '["e1", "e2"]')).toBe('["e1", "e2"]');
    expect(withOpening(FILING_OPENING, ' [{"type": "item"}]')).toBe(' [{"type": "item"}]');
    // One whole object of its own (another envelope): a whole answer; a continuation never parses alone.
    expect(withOpening(FILING_OPENING, '{"items": [{"type": "персонаж"}]}')).toBe('{"items": [{"type": "персонаж"}]}');
    expect(withOpening(FILING_OPENING, '{"type": "item"}]}')).toBe('{"filings": [{"type": "item"}]}');
    expect(withOpening(FILING_OPENING, '{"type": "a"}, {"type": "b"}]}')).toBe('{"filings": [{"type": "a"}, {"type": "b"}]}');
  });

  test('readRawAnswer reads the opening after think tags are cut', () => {
    const got = readRawAnswer({ text: '<think>which?</think>"e2"]}', reasoning: '' }, SCRIPT_CAPS, { finish: 'end', opening: RECALL_OPENING, rawRead: reader.rawRead });
    expect(got).toMatchObject({ ok: true, value: { picks: [{ handle: 'e2' }] } });
    // Only think tags: blank, so no_output (the opening is not an answer on its own).
    expect(readRawAnswer({ text: '<think>hm</think>', reasoning: '' }, SCRIPT_CAPS, { finish: 'end', opening: RECALL_OPENING, rawRead: reader.rawRead })).toMatchObject({ ok: false, code: 'no_output' });
  });
});
