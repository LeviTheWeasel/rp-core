// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// agents/compendium/recall.ts after the M5c review (the lead's ruling K and D-208's words): the reader
// keeps scanning after an opener that never closes and never lets the prompt's example win (core#2,
// #7); items keyed by a handle and several handles in one item (core#6, #9); a same-named place never
// repeats an index line (core#4); the lite shortlist's lexScore query (core#5); the minimum held to the
// entries shown (core#8); Bunraku's conversation lines as they are (core#10); prose is undecodable, only
// an empty answer is no_output (cli#8); the request names its opening (D-208).
import { describe, expect, test } from 'bun:test';
import { needsTopUp, readRecall, RECALL_OPENING, recallIndex, recallRequest, topUpUser, moreNudge, type RecallRead, type RecallRequestInput } from '../../src/agents/compendium/recall.ts';
import { BUNRAKU_PLAIN } from './bunraku-golden.ts';
import { ce, count, fakeIndex, optsOf, viewOf } from './kit.ts';

const OPTS = {
  handles: new Map([
    ['e1', 'k:mira'],
    ['e2', 'k:dov'],
    ['e3', 'k:harbor'],
    ['e4', 'k:court'],
    ['e7', 'k:seven'],
  ]),
  names: new Map<string, string | null>([
    ['mira', 'k:mira'],
    ['dov', 'k:dov'],
    ['harbor', 'k:harbor'],
  ]),
  maxEntries: 10,
  profile: 'full' as const,
};
const handlesOf = (r: ReturnType<typeof readRecall>): string[] => (r.ok ? r.picks.map((p) => p.handle) : []);

describe('core#2: an opener that never closes does not end the search', () => {
  test('a false start, then the answer: the answer is read whole', () => {
    const r = readRecall('{"entry_ids": ["e1",\nSorry, let me redo that.\n{"entry_ids": ["e1", "e2", "e3"]}', OPTS);
    expect(r).toMatchObject({ ok: true, unknown: 0 });
    expect(handlesOf(r)).toEqual(['e1', 'e2', 'e3']);
    expect(r.ok && r.cutOff).toBeFalsy();
  });

  test('an unclosed brace in prose before the answer: the answer, not an empty jsonrepair of the rest', () => {
    const r = readRecall('Note: {thinking: Mira matters\n{"entry_ids":["e1"],"reasons":{"e1":"here"}}', OPTS);
    expect(r).toMatchObject({ ok: true, unknown: 0, picks: [{ handle: 'e1', reason: 'here' }] });
  });

  test('an unclosed list in prose before the answer: the answer, not the cut list', () => {
    const r = readRecall('Candidates ["e1", "e2" are relevant.\n{"entry_ids": ["e3"]}', OPTS);
    expect(handlesOf(r)).toEqual(['e3']);
    expect(r.ok && r.cutOff).toBeFalsy();
  });

  test('a cut-off answer is still a cut-off answer: its own list and reasons are pieces of it, not answers', () => {
    const r = readRecall('{"entry_ids": ["e1", "e2"], "reasons": {"e1": "ok", "e2": "cut her', OPTS);
    expect(r).toMatchObject({ ok: true, cutOff: true, picks: [{ handle: 'e1', reason: 'ok' }, { handle: 'e2' }] });
    // A stray quote still reads the value whole (it did close).
    expect(handlesOf(readRecall('{entry_ids": ["e1", "e2"]}', OPTS))).toEqual(['e1', 'e2']);
  });

  test('a cut-off answer that closed no item is undecodable, not an empty selection', () => {
    expect(readRecall('{"entry_ids": [', OPTS)).toMatchObject({ ok: false, code: 'undecodable' });
    // An earlier empty answer does not hide a later one cut off with picks.
    expect(readRecall('{"entry_ids": []}\nActually: {"entry_ids": ["e1", "e', OPTS)).toMatchObject({ ok: true, cutOff: true, picks: [{ handle: 'e1' }] });
  });
});

describe('core#7: the prompt’s own example never wins over another answer', () => {
  const EXAMPLE = '{"entry_ids": ["e1", "e7"], "reasons": {"e1": "one short sentence", "e7": "one short sentence"}}';

  test('echoed before the answer: the answer', () => {
    const r = readRecall(`Format: ${EXAMPLE}\n\n{"entry_ids": ["e3", "e4"], "reasons": {"e3": "the harbor", "e4": "the court"}}`, OPTS);
    expect(r.ok && r.picks).toEqual([
      { ref: 'k:harbor', handle: 'e3', reason: 'the harbor' },
      { ref: 'k:court', handle: 'e4', reason: 'the court' },
    ]);
  });

  test('before an answer that picks nothing, or one cut off: that answer', () => {
    expect(readRecall(`Format: ${EXAMPLE}\nNothing fits: {"entry_ids": []}`, OPTS)).toMatchObject({ ok: true, picks: [] });
    expect(readRecall(`Format: ${EXAMPLE}\n{"entry_ids": ["e2", "e`, OPTS)).toMatchObject({ ok: true, cutOff: true, picks: [{ handle: 'e2' }] });
  });

  test('alone it is what the model said (the lite example is also a real answer)', () => {
    expect(handlesOf(readRecall(EXAMPLE, OPTS))).toEqual(['e1', 'e7']);
    const lite = { ...OPTS, profile: 'lite' as const };
    expect(handlesOf(readRecall('{"entry_ids": ["e1"]}', lite))).toEqual(['e1']);
    expect(handlesOf(readRecall('Like this: {"entry_ids": ["e1"]}\nMine: {"entry_ids": ["e2", "e3"]}', lite))).toEqual(['e2', 'e3']);
  });
});

describe('core#6, core#9: names that look like handles, several handles in an item, items keyed by a handle', () => {
  const index = recallIndex({
    view: viewOf([ce('character:mira', 'character', 'Mira'), ce('character:dov', 'character', 'Dov'), ce('character:none', 'character', 'None'), ce('item:e3', 'item', 'E3 Lamp'), ce('location:route', 'location', 'Route E66')]),
    profile: 'full',
    window: 100_000,
    count,
  });
  const opts = optsOf(index);
  const h = (key: string): string => [...index.handles].find(([, k]) => k === key)![0];

  test('an exact name that starts like a handle is that entry', () => {
    expect(readRecall('{"entry_ids":["E3 Lamp"]}', opts)).toMatchObject({ ok: true, byName: 1, picks: [{ ref: 'item:e3' }] });
  });

  test('several handles in one item all count; an unknown one among them is counted', () => {
    expect(readRecall('{"entry_ids": "e1 e2 e3"}', opts)).toMatchObject({ ok: true, unknown: 0, picks: [{ handle: 'e1' }, { handle: 'e2' }, { handle: 'e3' }] });
    expect(readRecall('{"entry_ids": ["e1 and e2"]}', opts)).toMatchObject({ ok: true, picks: [{ handle: 'e1' }, { handle: 'e2' }] });
    expect(readRecall('{"entry_ids": [{"id": "e1 & e2 & e99"}]}', opts)).toMatchObject({ ok: true, unknown: 1, picks: [{ handle: 'e1' }, { handle: 'e2' }] });
  });

  test('an index line copied whole is one pick, even when the name holds a handle-like word', () => {
    const line = `[${h('location:route')}] Route E66`;
    expect(readRecall(JSON.stringify({ entry_ids: [line] }), opts)).toMatchObject({ ok: true, unknown: 0, picks: [{ ref: 'location:route' }] });
  });

  test('{"e1": "reason"} items read as their handles, the value as the reason', () => {
    const r = readRecall('{"entry_ids": [{"e1": "present"}, {"e2": "nearby"}]}', opts);
    expect(r).toMatchObject({ ok: true, unknown: 0 });
    expect(r.ok && r.picks.map((p) => [p.handle, p.reason])).toEqual([
      ['e1', 'present'],
      ['e2', 'nearby'],
    ]);
    // Lite keeps no reason; an unknown handle key is counted.
    expect(readRecall('[{"e1": "x", "e404": "y"}]', { ...opts, profile: 'lite' })).toMatchObject({ ok: true, unknown: 1, picks: [{ handle: 'e1' }] });
  });
});

describe('core#4: an entry the tree hangs under two same-named places is listed once', () => {
  const twoBooks = [
    ce('lib:a:harbor', 'location', 'Harbor', { library: 'a' }),
    ce('lib:a:dock', 'location', 'Dock', { library: 'a', data: { parent_location: 'Harbor' } }),
    ce('lib:b:harbor', 'location', 'Harbor', { library: 'b' }),
    ce('lib:b:pier', 'location', 'Pier', { library: 'b', data: { parent_location: 'Harbor' } }),
    ce('character:mira', 'character', 'Mira'),
  ];

  test('one handle per entry, and the counts are of the entries listed', () => {
    const idx = recallIndex({ view: viewOf(twoBooks), profile: 'full', window: 100_000, count });
    expect(idx).toMatchObject({ candidates: 5, shown: 5, omitted: 0 });
    expect(new Set(idx.handles.values()).size).toBe(5);
    expect(idx.text).toContain('Places (4)\n  Harbor (3)\n');
    expect(idx.text).toContain('  Harbor (1)\n    [e5] Harbor');
    expect(idx.text.match(/\] Dock$/gm)).toHaveLength(1);
  });

  test('a budget that lists nothing leaves out each candidate once', () => {
    const idx = recallIndex({ view: viewOf(twoBooks), profile: 'full', window: 40, count });
    expect(idx).toMatchObject({ shown: 0, omitted: 5, candidates: 5, truncated: true });
    expect(idx.text).toBe('(+5 more entries not shown)');
  });
});

describe('core#5: the lite shortlist’s lexScore stage', () => {
  test('function words out, and a name the chat wrote ranks before taglines that share common words', () => {
    const filler = Array.from({ length: 45 }, (_, i) =>
      ce(`character:f${i}`, 'character', `Filler ${i}`, { data: { tagline: 'She was there with them when they came back and said that she would stay for you.' }, lastSeq: 100 + i }),
    );
    const last = [
      'We rode out across the Salt Flats at dawn.',
      'You were there with them when they came back.',
      'She said that she would stay for you.',
      'They came back and she was there with them.',
      'You said that you would stay.',
      'She smiles and nods.',
    ];
    const idx = recallIndex({
      view: viewOf([ce('location:flats', 'location', 'Salt Flats', { lastSeq: 1 }), ...filler]),
      profile: 'lite',
      window: 16_384,
      count,
      uText: last[5]!,
      windowTexts: last.slice(1, 5),
      lastTexts: last,
    });
    expect(idx.handles.get('e1')).toBe('location:flats');
  });

  test('a spaceless-script run is cut into pairs: a name written five messages back is found', () => {
    const jp = [ce('location:tokyo', 'location', '東京タワー', { lastSeq: 1 }), ...Array.from({ length: 45 }, (_, i) => ce(`item:j${i}`, 'item', `道具${i}`, { lastSeq: 100 + i }))];
    const last = ['昨日は東京タワーに行きました。', 'そうですか。', 'はい。', '楽しかった。', 'よかったね。', 'うん。'];
    const idx = recallIndex({ view: viewOf(jp), profile: 'lite', window: 16_384, count, uText: last[5]!, windowTexts: last.slice(1, 5), lastTexts: last });
    expect(idx.handles.get('e1')).toBe('location:tokyo');
  });
});

describe('core#8: the minimum is held to the entries shown', () => {
  const two = fakeIndex('[e1] Mira\n[e2] Dov', 2);
  const input: RecallRequestInput = {
    index: two,
    conversation: [{ role: 'user', text: 'Hi' }],
    profile: 'full',
    window: 32_768,
    guidance: '',
    prefetch: false,
    minEntries: 3,
    maxEntries: 10,
    contextMessages: 20,
    reasoningOff: true,
    count,
  };
  const read = (handles: string[]): RecallRead => ({ picks: handles.map((h) => ({ ref: `k${h.slice(1)}`, handle: h })), unknown: 0, repeated: 0, trimmed: 0, byName: 0, salvaged: 0 });

  test('the prompt asks for no more than the index shows', () => {
    const r = recallRequest(input);
    expect(r.system).toContain('You MUST select at least 2 entries.');
    expect(r.user).toContain('Select between 2 and 10 entries.');
    expect(r.minEntries).toBe(2);
    expect(recallRequest({ ...input, profile: 'lite', index: fakeIndex('[e1] Mira', 1, 'lite') }).minEntries).toBe(0);
  });

  test('no top-up when every shown entry was picked; the nudge never asks past the request’s minimum', () => {
    expect(needsTopUp(read(['e1', 'e2']), { profile: 'full', minEntries: 3, maxEntries: 10, shown: 2 })).toBe(false);
    expect(needsTopUp(read(['e1', 'e2']), { profile: 'full', minEntries: recallRequest(input).minEntries, maxEntries: 10 })).toBe(false);
    expect(needsTopUp(read(['e1']), { profile: 'full', minEntries: 3, maxEntries: 10, shown: 2 })).toBe(true);
    expect(topUpUser(recallRequest(input), read(['e1']), 3)[1]).toBe(`Your last answer: {"entry_ids":["e1"]}\n${moreNudge(1, 2)}`);
  });
});

describe('core#10: the full prompt’s conversation is Bunraku’s, line for line', () => {
  const base: RecallRequestInput = {
    index: fakeIndex('INDEX', 3),
    conversation: [],
    profile: 'full',
    window: 32_768,
    guidance: '',
    prefetch: false,
    minEntries: 0,
    maxEntries: 10,
    contextMessages: 20,
    reasoningOff: true,
    count,
  };
  const talkOf = (talk: string, n: number): string => BUNRAKU_PLAIN.user.replace('(last 2 messages)\n\n[user]: Hello\n\n[assistant]: Hi', `(last ${n} messages)\n\n${talk}`);

  test('a padded text is sent as it is, and a blank message is sent too', () => {
    const r = recallRequest({ ...base, conversation: [{ role: 'user', text: '  Hello\n' }, { role: 'assistant', text: '' }, { role: 'user', text: 'Again' }] });
    expect(r.user).toBe(talkOf('[user]:   Hello\n\n\n[assistant]: \n\n[user]: Again', 3));
    expect(r.messages).toBe(3);
  });

  test('contextMessages counts blank messages, as Bunraku’s slice does', () => {
    const r = recallRequest({ ...base, contextMessages: 1, conversation: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: '   ' }] });
    expect(r.user).toBe(talkOf('[assistant]:    ', 1));
  });

  test('lite (a new text) still leaves blank messages out and trims', () => {
    const r = recallRequest({ ...base, profile: 'lite', index: fakeIndex('[e1] Mira', 1, 'lite'), conversation: [{ role: 'user', text: '  Hello\n' }, { role: 'assistant', text: ' ' }] });
    expect(r.user).toContain('(last 1 messages)\n\n[user]: Hello\n\nAnswer with');
  });
});

describe('cli#8 and D-208 in the reader and the request', () => {
  test('an answer with text but no selection is undecodable; only an empty one is no_output', () => {
    const prose = 'Marfa wipes the counter and smiles. "The merchant? He left at dawn, dear."';
    expect(readRecall(prose, OPTS)).toMatchObject({ ok: false, code: 'undecodable' });
    expect(readRecall('', OPTS)).toMatchObject({ ok: false, code: 'no_output' });
    // After the prefill, a continuation in prose is undecodable too (not an empty cut-off list).
    expect(readRecall(`${RECALL_OPENING}${prose}`, OPTS)).toMatchObject({ ok: false, code: 'undecodable' });
  });

  test('the request names its opening, and the opening and a continuation read as one answer', () => {
    expect(recallRequest({ ...{ index: fakeIndex('INDEX', 3), conversation: [], profile: 'full', window: 32_768, guidance: '', prefetch: false, minEntries: 0, maxEntries: 10, contextMessages: 20, reasoningOff: true, count } }).opening).toBe('{"entry_ids": [');
    expect(handlesOf(readRecall(`${RECALL_OPENING}e1]}`, OPTS))).toEqual(['e1']);
    expect(handlesOf(readRecall(`${RECALL_OPENING}"e2", "e3"], "reasons": {"e2": "here"}}`, OPTS))).toEqual(['e2', 'e3']);
  });
});
