// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// agents/structured.ts rawRead (M5c, D-199) with the recall reader: the agent reads the answer's text
// itself (a bare list of handles, prose), JSON in the reasoning is never read, an answer cut off while
// it was still reasoning is undecodable; callers without rawRead read as before. Then one recall call
// end to end on a scripted connection: index → request → structuredCall → record.
import { describe, expect, test } from 'bun:test';
import { recallIndex, recallReader, recallRecord, recallRequest, type RecallRead } from '../../src/agents/compendium/recall.ts';
import { readRawAnswer, type RawRead } from '../../src/agents/structured.ts';
import { SCRIPT_CAPS, scriptCapsWith } from '../../src/providers/scripted.ts';
import { calls, rig, STRUCTURED_CAPS, textOfMsg } from '../structured/kit.ts';
import { ce, count, optsOf, viewOf } from './kit.ts';

const index = recallIndex({
  view: viewOf([ce('character:mira', 'character', 'Mira', { aliases: ['Lamplighter'] }), ce('location:dock', 'location', 'Dock Ward'), ce('item:lantern', 'item', 'Brass Lantern')]),
  profile: 'full',
  window: 32_768,
  count,
});
const reader = recallReader(optsOf(index));

/** A recall-shaped structuredCall on the shared rig ('dir', model 'm'). */
function recallRig(script: Parameters<typeof rig>[0], o: { caps?: typeof SCRIPT_CAPS; repair?: boolean; rawRead?: boolean } = {}) {
  return rig<RecallRead>(script, {
    ...(o.caps ? { caps: o.caps } : {}),
    input: {
      agent: 'recall',
      tag: null,
      schema: { name: 'recall', schema: { type: 'object' } },
      read: reader.read,
      ...(o.rawRead === false ? {} : { rawRead: reader.rawRead }),
      repair: o.repair ?? true,
      callKeyPrefix: 't_1:recall',
    },
  });
}

const keysOf = (r: Awaited<ReturnType<ReturnType<typeof recallRig>['run']>>): string[] => (r.ok ? r.value.picks.map((p) => p.ref) : []);

describe('rawRead (D-199)', () => {
  test('a bare list of handles is the answer (tag:null without rawRead finds no object in it)', async () => {
    const r = await recallRig(calls([{ text: '["e1", "e2"]' }])).run();
    expect(r).toMatchObject({ ok: true, transport: 'tagged', attempts: [{ outcome: 'ok' }] });
    expect(keysOf(r)).toEqual(['character:mira', 'location:dock']);
    const before = await recallRig(calls([{ text: '["e1", "e2"]' }]), { rawRead: false, repair: false }).run();
    expect(before).toMatchObject({ ok: false, code: 'no_output' });
  });

  test('handles in prose are salvaged; names read', async () => {
    const r = await recallRig(calls([{ text: 'I would bring in [e3] and Mira.' }])).run();
    // Prose: e3 salvaged (names in prose are not read).
    expect(keysOf(r)).toEqual(['item:lantern']);
    expect(r.ok && r.value.salvaged).toBe(1);
    expect(r.calls).toHaveLength(1);
    const named = await recallRig(calls([{ text: '{"entry_ids":["Lamplighter","e3"]}' }])).run();
    expect(keysOf(named)).toEqual(['character:mira', 'item:lantern']);
    expect(named.ok && named.value.byName).toBe(1);
  });

  test('JSON only in the reasoning is not read: no_output, and the corrective pass asks again', async () => {
    const x = recallRig(calls([{ reasoning: 'Thinking: {"entry_ids": ["e1"]}' }, { text: '' }], [{ text: '{"entry_ids": ["e2"]}' }]));
    const r = await x.run();
    expect(r.attempts.map((a) => a.outcome)).toEqual(['no_output', 'ok']);
    expect(keysOf(r)).toEqual(['location:dock']);
    const second = x.provider.requests[1]!;
    expect(textOfMsg(second.messages.at(-1)!)).toBe('Your answer was not usable (no JSON object was found). Answer again with exactly one JSON object following the schema above. Write nothing else.');
  });

  test('without rawRead a tag:null agent still finds JSON in the reasoning (existing callers unchanged)', async () => {
    const r = await recallRig(calls([{ reasoning: '{"entry_ids": ["e1"]}' }, { text: '' }]), { rawRead: false }).run();
    expect(r).toMatchObject({ ok: true, fromReasoning: true, attempts: [{ outcome: 'ok_reasoning' }] });
  });

  test('cut off by finish length while still reasoning: undecodable, rawRead never asked', async () => {
    let asked = 0;
    const spy = (a: { text: string }): RawRead<RecallRead> => {
      asked++;
      return reader.rawRead(a);
    };
    const x = rig<RecallRead>(calls([{ reasoning: 'Let me think about e1 and e2 and' }, { finish: 'length' }]), {
      input: { agent: 'recall', tag: null, schema: { name: 'recall', schema: {} }, read: reader.read, rawRead: spy, repair: false, callKeyPrefix: 't:recall' },
    });
    const r = await x.run();
    expect(r).toMatchObject({ ok: false, code: 'undecodable', message: 'the answer was cut off while it was still reasoning' });
    expect(asked).toBe(0);
  });

  test('a host that puts the answer in the reasoning (answerInReasoning) is read there', async () => {
    const caps = scriptCapsWith({ reasoning: { ...SCRIPT_CAPS.reasoning, answerInReasoning: true } });
    const r = await recallRig(calls([{ reasoning: '{"entry_ids": ["e3"]}' }]), { caps }).run();
    expect(keysOf(r)).toEqual(['item:lantern']);
    expect(r.ok && r.fromReasoning).toBeFalsy();
  });

  test('think tags are cut before rawRead: what they hold is never a pick', async () => {
    const r = await recallRig(calls([{ text: '<think>{"entry_ids":["e3"]}</think>["e1"]' }])).run();
    expect(keysOf(r)).toEqual(['character:mira']);
  });

  test('a visible answer cut off by finish length keeps its closed items and says cutOff', async () => {
    const r = await recallRig(calls([{ text: '{"entry_ids": ["e1", "e2", "e' }, { finish: 'length' }])).run();
    expect(r).toMatchObject({ ok: true, cutOff: true, skipped: [{ path: 'answer' }] });
    expect(keysOf(r)).toEqual(['character:mira', 'location:dock']);
  });

  test('a wrong shape is invalid; the correction quotes rawRead’s reason', async () => {
    const x = recallRig(calls([{ text: '{"selection": "the first"}' }], [{ text: '["e1"]' }]));
    const r = await x.run();
    expect(r.attempts.map((a) => a.outcome)).toEqual(['invalid', 'ok']);
    expect(textOfMsg(x.provider.requests[1]!.messages.at(-1)!)).toContain('(the answer has no entry_ids list)');
  });

  test('the structured transport: the schema rides the request, rawRead reads the text', async () => {
    const x = recallRig(calls([{ text: '{"entry_ids": ["e2"]}' }]), { caps: STRUCTURED_CAPS });
    const r = await x.run();
    expect(r).toMatchObject({ ok: true, transport: 'structured' });
    expect(x.provider.requests[0]!.responseSchema).toEqual({ name: 'recall', schema: { type: 'object' } });
  });

  test('readRawAnswer alone: finish length with text is read; a blank answer goes to rawRead', () => {
    const caps = SCRIPT_CAPS;
    const rawRead = reader.rawRead;
    expect(readRawAnswer({ text: '["e1"]', reasoning: 'x' }, caps, { finish: 'length', rawRead })).toMatchObject({ ok: true, cutOff: true, fromReasoning: false });
    expect(readRawAnswer({ text: '', reasoning: '' }, caps, { finish: 'end', rawRead })).toMatchObject({ ok: false, code: 'no_output' });
  });
});

describe('one recall call end to end (scripted, no engine)', () => {
  test('index → request → structuredCall with rawRead → a recalled record', async () => {
    const req = recallRequest({
      index,
      conversation: [
        { role: 'user', text: 'The lantern is gone.' },
        { role: 'assistant', text: 'Mira looks at the dock.' },
      ],
      profile: 'full',
      window: 32_768,
      guidance: '',
      prefetch: false,
      minEntries: 0,
      maxEntries: 10,
      contextMessages: 20,
      reasoningOff: true,
      count,
    });
    const x = rig<RecallRead>(calls([{ text: '{"entry_ids": ["e1", "e3", "e9"], "reasons": {"e1": "She is here."}}' }, { usage: { inputTotal: 400, outputTotal: 25 } }]), {
      input: {
        agent: 'recall',
        tag: null,
        schema: req.schema,
        read: reader.read,
        rawRead: reader.rawRead,
        system: req.system,
        user: [req.user],
        repair: req.repair,
        maxTokens: req.maxTokens,
        samplers: { temperature: req.temperature },
        reasoning: 'none',
        callKeyPrefix: 't_2:recall',
      },
    });
    const first = await x.run();
    const sent = x.provider.requests[0]!;
    expect(sent.maxTokens).toBe(2000);
    expect(textOfMsg(sent.messages[0]!)).toBe(req.system);
    expect(textOfMsg(sent.messages[1]!)).toContain('[e1] Mira (aka Lamplighter)');
    const rec = recallRecord({ source: 'sync', profile: 'full', omitted: index.omitted, model: 'dir:m', transport: 'tagged', first, ms: 50 });
    expect(rec).toEqual({
      v: 1,
      status: 'recalled',
      source: 'sync',
      profile: 'full',
      picks: [{ ref: 'character:mira', reason: 'She is here.' }, { ref: 'item:lantern' }],
      unknown: 1,
      repeated: 0,
      trimmed: 0,
      omitted: 0,
      byName: 0,
      salvaged: 0,
      calls: 1,
      ms: 50,
      model: 'dir:m',
      transport: 'tagged',
      usage: { input: 400, output: 25 },
    });
  });
});
