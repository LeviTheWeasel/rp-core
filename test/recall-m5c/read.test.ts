// Ported from Bunraku:src/core/compendium/recall-core.test.ts@702d8120 ("the answer": plain, fenced
// and wrapped objects with short reasons; refusals; unknown, repeated and over-cap handles) and from
// RoleCall:apps/rc/src/lib/ai/tv-stream/pregen-retrieval.ts@fb8dc623e (the parse ladder's and the
// name resolver's vectors, as re-typed in the M5c research: P1–P8, the refusal prose, exact names).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/recall.ts readRecall / recallReader (M5c, D-199). Adapted, each a listed change:
// Bunraku refused a bare list, other list keys, a string list value, a cut-off object and names;
// rp-core reads them. A wrong-shaped first object no longer hides a later right one. Prose with handles
// is salvaged; prose without them, and lists of numbers, still fail (the corrective pass runs): prose is
// `undecodable` (D-208's words), only an empty answer is `no_output`.
import { describe, expect, test } from 'bun:test';
import { MAX_REASON, readRecall, recallIndex, recallReader, type RecallReadOptions } from '../../src/agents/compendium/recall.ts';
import { count, harborView, optsOf } from './kit.ts';

const index = recallIndex({ view: harborView(), profile: 'full', window: 200_000, count });
const opts = optsOf(index);
const parse = (text: string, max = 10) => readRecall(text, { ...opts, maxEntries: max });
const handlesOf = (r: ReturnType<typeof parse>): string[] => (r.ok ? r.picks.map((p) => p.handle) : []);

/** RoleCall's names (rc vectors): Hana, Мира Ванс, Satoru Gojo as e1…e3. */
const RC: RecallReadOptions = {
  handles: new Map([
    ['e1', 'k-hana'],
    ['e2', 'k-mira'],
    ['e3', 'k-gojo'],
    ['e7', 'k-seven'],
  ]),
  names: new Map<string, string | null>([
    ['hana', 'k-hana'],
    ['мира ванс', 'k-mira'],
    ['satoru gojo', 'k-gojo'],
  ]),
  maxEntries: 10,
  profile: 'full',
};

describe('the answer (Bunraku recall-core.test.ts)', () => {
  test('a plain or fenced JSON object with handles and reasons resolves to the entries, with the reasons kept short', () => {
    const long = 'r'.repeat(MAX_REASON * 3);
    const plain = parse(`{"entry_ids": ["e1", "e2"], "reasons": {"e1": " Present. ", "e2": "${long}"}}`);
    expect(handlesOf(plain)).toEqual(['e1', 'e2']);
    expect(plain.ok && plain.picks[0]).toEqual({ ref: 'lib:harbor:c-mira', handle: 'e1', reason: 'Present.' });
    expect(plain.ok && plain.picks[1]!.reason!.length).toBe(MAX_REASON);
    expect(handlesOf(parse('Sure!\n```json\n{"entry_ids": ["e3"]}\n```'))).toEqual(['e3']);
    const wrapped = parse('Here you go: {"entry_ids": ["e4"], "reasons": {"e4": "a } brace"}} done');
    expect(wrapped.ok && wrapped.picks).toEqual([{ ref: index.handles.get('e4')!, handle: 'e4', reason: 'a } brace' }]);
  });

  test('prose without handles, numbers and shapeless JSON are refusals with a code, never an empty success', () => {
    expect(parse('I cannot help with that.')).toMatchObject({ ok: false, code: 'undecodable' });
    expect(parse('{"entry_ids": [1, 2]}')).toMatchObject({ ok: false, code: 'invalid' });
    expect(parse('[1,2]')).toMatchObject({ ok: false });
    expect(parse('{"selection": "none of them"}')).toMatchObject({ ok: false, code: 'invalid' });
    expect(parse('{"foo": bar": "baz"}')).toMatchObject({ ok: false });
    expect(parse('')).toMatchObject({ ok: false, code: 'no_output' });
  });

  test('changed: a cut-off object, another list key and a string value now read', () => {
    expect(parse('{"entry_ids": ["e1"')).toMatchObject({ ok: true, cutOff: true });
    expect(handlesOf(parse('{"entry_ids": ["e1"'))).toEqual(['e1']);
    expect(handlesOf(parse('{"entries": ["e1"]}'))).toEqual(['e1']);
    expect(handlesOf(parse('{"entry_ids": "e1, e2"}'))).toEqual(['e1', 'e2']);
    expect(parse('{"entry_ids": null}')).toMatchObject({ ok: true, picks: [] });
  });

  test('a handle the index never printed is dropped and counted, a repeat counts once, and the cap trims the rest', () => {
    const r = parse('{"entry_ids": ["e1", "e99999", "e1", "e2", "e3"]}', 2);
    expect(r).toMatchObject({ ok: true, unknown: 1, repeated: 1, trimmed: 1, byName: 0, salvaged: 0 });
    expect(handlesOf(r)).toEqual(['e1', 'e2']);
    expect(parse('{"entry_ids": []}')).toMatchObject({ ok: true, picks: [] });
    // Bunraku's order: a repeat past the cap is a repeat, unknowns are every occurrence.
    expect(parse('{"entry_ids": ["e1", "e2", "e2", "e0", "e0"]}', 1)).toMatchObject({ ok: true, unknown: 2, repeated: 1, trimmed: 1 });
  });

  test('reasons are looked up by the handle as written, trimmed; a non-object reasons is ignored', () => {
    const r = parse('{"entry_ids":[" e1 "],"reasons":{" e1 ":"kept?","e1":"trimmed key"}}');
    expect(r.ok && r.picks[0]!.reason).toBe('trimmed key');
    expect(parse('{"entry_ids":["e1"],"reasons":"none"}')).toMatchObject({ ok: true, picks: [{ handle: 'e1' }] });
    expect(parse('{"entry_ids":["e1"],"reasons":{"e1":5}}')).toMatchObject({ ok: true, picks: [{ handle: 'e1' }] });
  });
});

describe('the lenient read (D-199)', () => {
  test('a bare list, [eN], any case, zero padding, and an index line copied whole', () => {
    expect(handlesOf(parse('["e1","e7"]'))).toEqual(['e1', 'e7']);
    expect(handlesOf(parse('{"entry_ids": ["[e3]", "E4", "e05", "[e6] Extra Character 12"]}'))).toEqual(['e3', 'e4', 'e5', 'e6']);
  });

  test('{picks: […]} with objects {id|handle|name, reason}', () => {
    const r = readRecall('{"picks":[{"id":"e7","reason":"r7"},{"name":"Hana","why":"wh"},{"handle":"Satoru Gojo"},{"title":"Nobody"}]}', RC);
    expect(r).toMatchObject({ ok: true, unknown: 1, byName: 2 });
    expect(r.ok && r.picks).toEqual([
      { ref: 'k-seven', handle: 'e7', reason: 'r7' },
      { ref: 'k-hana', handle: 'e1', reason: 'wh' },
      { ref: 'k-gojo', handle: 'e3' },
    ]);
  });

  test('names: an exact normalized name or alias, unique; no fuzzy match (RoleCall’s Dice is not ported)', () => {
    const r = readRecall('{"entry_ids":["Мира Ванс.","Satoru Goj","satoru  GOJO","Hana"]}', RC);
    expect(r).toMatchObject({ ok: true, unknown: 1, byName: 3 });
    const shared: RecallReadOptions = { ...RC, names: new Map([['twin', null]]) };
    expect(readRecall('["twin"]', shared)).toMatchObject({ ok: true, picks: [], unknown: 1 });
    // A name and the same entry's handle are one pick.
    expect(readRecall('["Hana","e1"]', RC)).toMatchObject({ ok: true, repeated: 1, byName: 1 });
  });

  test('handles fished from prose when no JSON reads: known ones once, in order, unknown ones counted', () => {
    const r = readRecall('I would pick [e3] and e1, then e3 again; e99 is not real.', RC);
    expect(r).toMatchObject({ ok: true, salvaged: 2, unknown: 1, repeated: 0 });
    expect(r.ok && r.picks.map((p) => p.handle)).toEqual(['e3', 'e1']);
    // Words that only look like handles are not handles.
    expect(readRecall('the e2e test, 3e1 and ex1', RC)).toMatchObject({ ok: false, code: 'undecodable' });
  });

  test('lite keeps no reasons', () => {
    const lite = readRecall('{"entry_ids":["e1"],"reasons":{"e1":"why"}}', { ...RC, profile: 'lite' });
    expect(lite.ok && lite.picks).toEqual([{ ref: 'k-hana', handle: 'e1' }]);
  });

  test('a decoded value (the structured transport) reads the same way', () => {
    expect(readRecall({ entry_ids: ['e1', 'Satoru Gojo'] }, RC)).toMatchObject({ ok: true, byName: 1 });
    expect(readRecall(['e2'], RC)).toMatchObject({ ok: true, picks: [{ handle: 'e2' }] });
    expect(readRecall({ x: 1 }, RC)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('RoleCall’s parser vectors (rc-recall-vectors P1–P8, the refusal prose)', () => {
  test('P1: a missing quote after the brace is repaired', () => {
    expect(readRecall('{entry_names": ["Hana"], "reasoning": "x"}', RC)).toMatchObject({ ok: true, picks: [{ ref: 'k-hana' }], byName: 1 });
  });

  test('P2: prose and a fence', () => {
    expect(readRecall('Here:\n```json\n{"entry_ids":["e2"]}\n```', RC)).toMatchObject({ ok: true, picks: [{ ref: 'k-mira' }] });
  });

  test('P3, P4: a truncated answer keeps the items that closed (RoleCall lost both)', () => {
    const p3 = readRecall('{"entry_ids":["e1","e2', RC);
    expect(p3).toMatchObject({ ok: true, cutOff: true, picks: [{ handle: 'e1' }] });
    expect(p3.ok && p3.picks).toHaveLength(1);
    expect(readRecall('{"entry_ids":["e1"],"reasoning":"Hana — pres', RC)).toMatchObject({ ok: true, cutOff: true, picks: [{ handle: 'e1' }] });
    const reasons = readRecall('{"entry_ids":["e1","e2"],"reasons":{"e1":"ok","e2":"cut her', RC);
    expect(reasons.ok && reasons.picks).toEqual([
      { ref: 'k-hana', handle: 'e1', reason: 'ok' },
      { ref: 'k-mira', handle: 'e2' },
    ]);
  });

  test('P5: the first object of the recall’s shape, not the first object (RoleCall: nothing; Bunraku: bad_shape)', () => {
    expect(readRecall('{"a":1} and {"entry_ids":["e2"]}', RC)).toMatchObject({ ok: true, picks: [{ handle: 'e2' }] });
    expect(readRecall('Example {"x":1} then {"entry_ids":["e1"]}', RC)).toMatchObject({ ok: true, picks: [{ handle: 'e1' }] });
    // An example that names nothing before the answer: the answer.
    expect(readRecall('Like ["eX"]. My answer: {"entry_ids":["e7"]}', RC)).toMatchObject({ ok: true, picks: [{ handle: 'e7' }], unknown: 0 });
    expect(readRecall('{"entry_ids": ["e404"]}', RC)).toMatchObject({ ok: true, picks: [], unknown: 1 });
  });

  test('P6: a bare list is read (RoleCall: 0 entries reported as a success)', () => {
    expect(readRecall('["e1","e7"]', RC)).toMatchObject({ ok: true, picks: [{ handle: 'e1' }, { handle: 'e7' }] });
  });

  test('P7 and the refusal prose: no handles, no picks, a failure the corrective pass answers', () => {
    for (const t of ['I need to see the full knowledge tree before I can choose.', 'Could you provide the entries?', 'There are no entries available here.', "I don't see a tree.", 'No knowledge to work with.']) {
      expect(readRecall(t, RC)).toMatchObject({ ok: false, code: 'undecodable' });
    }
  });

  test('a fenced answer before a bare one wins; a fence that is not JSON falls through to the text', () => {
    expect(readRecall('```json\n{"entry_ids":["e2"]}\n```\n{"entry_ids":["e3"]}', RC)).toMatchObject({ ok: true, picks: [{ handle: 'e2' }] });
    expect(readRecall('```\nnot json\n```\n{"entry_ids":["e7"]}', RC)).toMatchObject({ ok: true, picks: [{ handle: 'e7' }] });
  });
});

describe('recallReader: structuredCall’s read and rawRead', () => {
  const reader = recallReader(RC);

  test('rawRead gives the read without `ok`, a cut_off skip, and the failure codes', () => {
    expect(reader.rawRead({ text: '["e1"]' })).toEqual({ ok: true, value: { picks: [{ ref: 'k-hana', handle: 'e1' }], unknown: 0, repeated: 0, trimmed: 0, byName: 0, salvaged: 0 }, skipped: [] });
    const cut = reader.rawRead({ text: '{"entry_ids":["e1","e2' });
    expect(cut).toMatchObject({ ok: true, cutOff: true, skipped: [{ path: 'answer' }] });
    expect(reader.rawRead({ text: 'no idea' })).toEqual({ ok: false, code: 'undecodable', message: 'no JSON object was found' });
    expect(reader.rawRead({ text: ' \n' })).toEqual({ ok: false, code: 'no_output', message: 'no JSON object was found' });
    expect(reader.rawRead({ text: '{"x": 1}' })).toEqual({ ok: false, code: 'invalid', message: 'the answer has no entry_ids list' });
  });

  test('read takes a decoded value; anything it cannot read is invalid', () => {
    expect(reader.read({ entry_ids: ['e2'] })).toMatchObject({ ok: true, value: { picks: [{ ref: 'k-mira' }] }, skipped: [] });
    expect(reader.read({ nothing: true })).toEqual({ ok: false, code: 'invalid', message: 'the answer has no entry_ids list' });
  });
});
