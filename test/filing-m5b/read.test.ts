// Ported from Bunraku:src/core/compendium/filing.test.ts@702d8120 (parsing a filing answer: a fenced
// answer, bad items rejected alone and named by position, switched-off types and the item cap,
// unreadable vs empty) and Bunraku:src/studio/compendium-filing.test.ts@702d8120 (a bad item is
// rejected alone; an item naming a book); the memory rule's vectors from
// RoleCall:apps/rc/src/lib/ai/dm-stream/tools/__tests__/compendium-memory-provenance.test.ts@fb8dc623e.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/filing.ts, M5b (D-82, D-175): readFilingAnswer. "port" = Bunraku's expectation
// kept; "adapt" = the lenient reading changes it (a bad field is skipped, the item stays).
import { describe, expect, test } from 'bun:test';
import { filingReader, readFilingAnswer, resolveType, snakeKey, type FilingItem, type FilingRead } from '../../src/agents/compendium/filing.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import { ENTRY_TYPES, type EntryType } from '../../src/agents/compendium/types.ts';

const ALL = ENTRY_TYPES;
const answer = (...filings: unknown[]): string => JSON.stringify({ filings });
const read = (raw: unknown, allow: readonly EntryType[] = DEFAULT_FILING_ALLOW, profile: 'full' | 'lite' = 'full'): FilingRead => readFilingAnswer(raw, { allow, profile });

function ok(r: FilingRead): { items: FilingItem[]; skipped: { path: string; why: string }[] } {
  if (!r.ok) throw new Error(`unreadable: ${r.why}`);
  return r;
}
const codes = (r: FilingRead): [string, string][] => ok(r).skipped.map((s) => [s.path, s.why.split(':')[0]!]);
const only = (raw: unknown, allow?: readonly EntryType[]): FilingItem => {
  const r = ok(read(raw, allow));
  expect(r.items).toHaveLength(1);
  return r.items[0]!;
};

describe('port: Bunraku’s parsing cases', () => {
  test('a fenced answer parses; unknown fields are kept as given', () => {
    const text = '```json\n' + answer({ type: 'character', entry: { name: 'Mira', mood: 'wary' } }) + '\n```';
    const r = ok(read(text, ALL));
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toEqual({ at: 0, type: 'character', name: 'Mira', data: { name: 'Mira', mood: 'wary' } });
  });

  test('adapt: each bad item is rejected alone and named by position; a bad enum costs only its field', () => {
    const r = ok(
      read(
        answer(
          { type: 'character', entry: { name: 'Ok' } },
          { type: 'dragon', entry: { name: 'X' } },
          { type: 'location', entry: { name: 'Y', type: 'planet' } },
          { type: 'item' },
          { type: 'plot', entry: { name: '' } },
          'nope',
          { type: 'event', entry: { name: 'Fine' } },
        ),
        ALL,
      ),
    );
    expect(r.items.map((i) => [i.at, i.name])).toEqual([[0, 'Ok'], [2, 'Y'], [6, 'Fine']]);
    expect(r.items[1]!.data).toEqual({ name: 'Y' });
    expect(r.skipped.map((s) => s.path)).toEqual(['filings[1]', 'filings[2].entry.type', 'filings[3]', 'filings[4]', 'filings[5]']);
    expect(r.skipped[1]!.why).toBe('bad_enum: type must be one of city, town, village, settlement, building, room, dungeon, wilderness, region, realm, plane');
    expect(r.skipped[0]!.why).toBe('unknown_type: its type "dragon" is not one of the eleven');
    expect(r.skipped[2]!.why).toBe('no_entry: it has no entry object');
    expect(r.skipped[3]!.why).toBe('no_identity: it has no name');
    expect(r.skipped[4]!.why).toBe('not_object: it is not an object');
  });

  test('a type the person switched off is rejected, and so is everything past the item cap (12 full, 6 lite)', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ type: 'item', entry: { name: `I${i}` } }));
    const full = ok(read(answer({ type: 'creature', entry: { name: 'Wolf' } }, ...many), ['item']));
    expect(full.skipped[0]).toEqual({ path: 'filings[0]', why: 'not_allowed: filing creature entries is switched off' });
    expect(full.items).toHaveLength(11);
    expect(full.skipped.at(-1)).toEqual({ path: 'filings[12]', why: 'over_limit: only the first 12 items are taken (3 more)' });
    const lite = ok(read(answer(...many), ['item'], 'lite'));
    expect(lite.items.map((i) => i.name)).toEqual(['I0', 'I1', 'I2', 'I3', 'I4', 'I5']);
    expect(lite.skipped).toEqual([{ path: 'filings[6]', why: 'over_limit: only the first 6 items are taken (8 more)' }]);
  });

  test('adapt: prose, a missing list and a non-object are unreadable; {}, [] and {"filings":[]} are "nothing to file"', () => {
    for (const text of ['I filed it!', '{"filings": 3}', '', '   ', '"just a string"']) expect(read(text, ALL).ok).toBe(false);
    for (const value of [{ filings: 3 }, { notes: 'none' }, 7, null]) expect(read(value, ALL).ok).toBe(false);
    expect(read('{"filings":[]}', ALL)).toEqual({ ok: true, items: [], skipped: [] });
    expect(read('[]', ALL)).toEqual({ ok: true, items: [], skipped: [] });
    expect(read({ filings: [] }, ALL)).toEqual({ ok: true, items: [], skipped: [] });
    // The lead's ruling G (Bunraku: unreadable): no envelope and no item is nothing to file.
    expect(read('{}', ALL)).toEqual({ ok: true, items: [], skipped: [] });
    expect(read('Nothing new.\n```json\n{ }\n```', ALL)).toEqual({ ok: true, items: [], skipped: [] });
    expect(read({}, ALL)).toEqual({ ok: true, items: [], skipped: [] });
    expect(read('I filed it!', ALL)).toEqual({ ok: false, why: 'the answer is not a JSON object' });
    expect(read('{"filings": 3}', ALL)).toEqual({ ok: false, why: 'the answer has no "filings" list' });
  });

  test('adapt (studio): "book" is read and ignored; summary is the historian’s', () => {
    const r = ok(read(answer({ type: 'item', book: 'elsewhere', entry: { name: 'Lamp' } }, { type: 'summary', entry: { title: 'T', summary: 'S' } }), ALL));
    expect(r.items.map((i) => [i.type, i.data])).toEqual([['item', { name: 'Lamp' }]]);
    expect(r.skipped).toEqual([{ path: 'filings[1]', why: 'summary: filing never writes summaries; the historian does' }]);
    const hist = readFilingAnswer(answer({ type: 'summary', entry: { title: 'T', summary: 'S', turn_range: { from: 1, to: 2 }, messages_covered: 3 } }), {
      allow: ['summary', 'plot'],
      profile: 'full',
      summaries: true,
    });
    expect(ok(hist).items[0]).toEqual({ at: 0, type: 'summary', name: 'T', data: { title: 'T', summary: 'S' } });
  });
});

describe('envelopes and item forms (D-82)', () => {
  const mira = { type: 'character', entry: { name: 'Мира' } };
  test('filings | entries | items (any case), a single item under them, a top-level array, a bare item', () => {
    for (const raw of [{ filings: [mira] }, { entries: [mira] }, { Items: [mira] }, { filing: mira }, [mira], mira, JSON.stringify([mira])]) {
      expect(only(raw).data).toEqual({ name: 'Мира' });
    }
  });

  test('flat items {type, name, …} and type-keyed ones {"character": {…}}; a type-keyed entry keeps its own `type` field', () => {
    const r = ok(
      read({
        items: [
          { type: 'персонаж', name: 'Хромой стражник', role: 'злодей' },
          { character: { name: 'Ян' } },
          { location: [{ name: 'Подвалы', type: 'building' }, { name: 'Пристань' }] },
          { type: 'location', entry: '{"name": "Маяк"}' },
        ],
      }),
    );
    expect(r.items.map((i) => [i.at, i.type, i.data])).toEqual([
      [0, 'character', { name: 'Хромой стражник' }],
      [1, 'character', { name: 'Ян' }],
      [2, 'location', { name: 'Подвалы', type: 'building' }],
      [3, 'location', { name: 'Пристань' }],
      [4, 'location', { name: 'Маяк' }],
    ]);
    expect(r.skipped).toEqual([{ path: 'filings[0].entry.role', why: expect.stringMatching(/^bad_enum: role must be one of protagonist, antagonist/) }]);
    expect(ok(read({ character: [{ name: 'A' }], location: { name: 'B' }, mood: 'x' })).items.map((i) => i.name)).toEqual(['A', 'B']);
  });

  test('the answer in prose: a later object, an array, a fence in the middle; a cut-off answer is unreadable', () => {
    expect(only('Sure! Here it is: {"filings":[{"type":"item","entry":{"name":"Key"}}]} Hope it helps {ok}').name).toBe('Key');
    expect(only('Filed [as asked]: [{"type":"item","entry":{"name":"Key"}}]').name).toBe('Key');
    expect(only('Notes first.\n```json\n{"filings":[{"type":"item","entry":{"name":"Key"}}]}\n```\nDone.').name).toBe('Key');
    expect(read('{"filings":[{"type":"item","entry":{"name":"Ke', ALL)).toEqual({ ok: false, why: 'the answer was cut off before the JSON closed' });
  });

  test('the D-82 type synonyms (en and ru), any case, English plurals', () => {
    const cases: [string, EntryType][] = [
      ['NPC', 'character'], ['person', 'character'], ['Персонаж', 'character'], ['place', 'location'], ['место', 'location'], ['локация', 'location'],
      ['faction', 'organization'], ['group', 'organization'], ['организация', 'organization'], ['фракция', 'organization'], ['quest', 'plot'],
      ['storyline', 'plot'], ['сюжет', 'plot'], ['квест', 'plot'], ['lore', 'worldbuilding'], ['rule', 'worldbuilding'], ['мир', 'worldbuilding'],
      ['правило', 'worldbuilding'], ['monster', 'creature'], ['beast', 'creature'], ['существо', 'creature'], ['ability', 'power'], ['spell', 'power'],
      ['skill', 'power'], ['способность', 'power'], ['сила', 'power'], ['object', 'item'], ['предмет', 'item'], ['danger', 'threat'], ['угроза', 'threat'],
      ['событие', 'event'], ['Characters', 'character'], ['abilities', 'power'], ['World Building', 'worldbuilding'], ['side-quest', null as unknown as EntryType],
    ];
    for (const [word, type] of cases) expect([word, resolveType(word)]).toEqual([word, type ?? null]);
    expect(resolveType('constructor')).toBeNull();
    expect(resolveType(3)).toBeNull();
  });
});

describe('fields: keys, kinds and enums (D-82)', () => {
  test('camelCase keys become snake_case, at any depth; the schema’s spelling wins over a camelCase twin', () => {
    const it = only({
      type: 'место',
      name: 'Подвалы',
      parentLocation: 'Вельмар',
      currentState: { status: 'Sealed', recentChanges: 'заперты' },
      'points of interest': ['дверь'],
      parent_location: 'Соляной суд',
    });
    expect(it.data).toEqual({ name: 'Подвалы', parent_location: 'Соляной суд', current_state: { status: 'sealed', recent_changes: 'заперты' }, points_of_interest: ['дверь'] });
    expect(snakeKey('imageURL')).toBe('image_url');
    expect(snakeKey('XMLHttpRequest')).toBe('xml_http_request');
  });

  test('a string where a list is expected, a list where text is expected, a number as text, booleans', () => {
    const it = only({
      type: 'character',
      entry: { name: 'Фрол', likes: 'море', description: ['лодочник', 'седой'], age: 61, relationships: { with: 'Ульяна', nature: 'Ally' } },
    });
    expect(it.data).toEqual({ name: 'Фрол', likes: ['море'], description: 'лодочник; седой', age: '61', relationships: [{ with: 'Ульяна', nature: 'ally' }] });
    expect(only({ type: 'creature', entry: { name: 'Волк', tameable: 'TRUE' } }).data.tameable).toBe(true);
  });

  test('enums: lower case, spaces and hyphens as _, a one-string list; RoleCall’s severity synonyms; a bad one is skipped, the item kept', () => {
    const r = ok(
      read([
        { type: 'character', entry: { name: 'A', role: 'Player Character' } },
        { type: 'plot', entry: { name: 'B', type: 'Side-Quest', status: ['Active'] } },
        { type: 'threat', entry: { name: 'C', severity: 'Existential' } },
        { type: 'threat', entry: { name: 'D', severity: 'moderate', status: 'resolved' } },
        { type: 'threat', entry: { name: 'E', severity: 'resolved' } },
      ]),
    );
    expect(r.items.map((i) => i.data)).toEqual([
      { name: 'A', role: 'player_character' },
      { name: 'B', type: 'side_quest', status: 'active' },
      { name: 'C', severity: 'extinction_level' },
      { name: 'D', severity: 'notable' },
      { name: 'E' },
    ]);
    expect(codes({ ok: true, ...r })).toEqual([['filings[3].entry.status', 'bad_enum'], ['filings[4].entry.severity', 'bad_enum']]);
  });

  test('a field of the wrong kind is skipped with its path; unknown fields are kept', () => {
    const r = ok(read([{ type: 'character', entry: { name: 'A', physical: 'tall', current_state: 'alive', powers: 5, mood: { x: 1 } } }]));
    expect(r.items[0]!.data).toEqual({ name: 'A', mood: { x: 1 } });
    expect(r.skipped).toEqual([
      { path: 'filings[0].entry.physical', why: 'wrong_kind: physical must be an object' },
      { path: 'filings[0].entry.current_state', why: 'wrong_kind: current_state must be an object' },
      { path: 'filings[0].entry.powers', why: 'wrong_kind: powers must be a list' },
    ]);
  });

  test('aliases: a string becomes a list; values that are not names are dropped', () => {
    expect(only({ type: 'location', entry: { name: 'Маяк', aliases: 'Серый маяк' } }).data.aliases).toEqual(['Серый маяк']);
    const r = ok(read([{ type: 'item', entry: { name: 'Ключ', aliases: ['ключик', 3] } }]));
    expect(r.items[0]!.data.aliases).toEqual(['ключик']);
    expect(codes({ ok: true, ...r })).toEqual([['filings[0].entry.aliases', 'wrong_kind']]);
  });

  test('the identity: trimmed; another identity field moves into it (a worldbuilding `name`)', () => {
    expect(only({ type: 'character', entry: { name: '  Мира  ' } })).toMatchObject({ name: 'Мира', data: { name: 'Мира' } });
    expect(only({ type: 'lore', name: 'Соль', category: 'magic', description: 'Соль гасит огни.' }).data).toEqual({
      topic: 'Соль',
      category: 'magic',
      description: 'Соль гасит огни.',
    });
    expect(codes(read([{ type: 'worldbuilding', entry: { category: 'x', description: 'y' } }]))).toEqual([['filings[0]', 'no_identity']]);
  });

  test('service fields are stripped, at any depth; blanks and empty lists are dropped', () => {
    const it = only({
      type: 'character',
      entry: {
        name: 'Мира',
        source_turn: 4,
        turnRange: { from: 1, to: 2 },
        tagline: '  ',
        likes: [],
        dislikes: ['', null, 'дым'],
        memories: [{ what_happened: 'Нашла стекло', changed_belief: 'фонарь можно спасти', writer_source: 'postgen', source_turn: 9, source_job_id: 'j1' }],
      },
    });
    expect(it.data).toEqual({ name: 'Мира', dislikes: ['дым'], memories: [{ what_happened: 'Нашла стекло', changed_belief: 'фонарь можно спасти' }] });
  });

  test('a number too large for JSON is skipped', () => {
    const r = ok(read('{"filings":[{"type":"item","entry":{"name":"Слиток","value":1e400}}]}'));
    expect(r.items[0]!.data).toEqual({ name: 'Слиток' });
    expect(codes({ ok: true, ...r })).toEqual([['filings[0].entry.value', 'non_finite']]);
  });
});

describe('memories and relationships (RoleCall’s rule, adapted: D-82, B21)', () => {
  test('RoleCall vector: an objective memory without changed_belief/changed_behavior is dropped; the item and its other memories stay', () => {
    const r = ok(
      read([
        {
          type: 'character',
          entry: {
            name: 'Hana',
            description: 'Tea master.',
            memories: [{ what_happened: 'Hana drank tea.', when: 'morning' }, { what_happened: 'Hana broke the cup.', changed_behavior: 'She serves in wooden bowls now.' }],
          },
        },
      ]),
    );
    expect(r.items[0]!.data).toEqual({ name: 'Hana', description: 'Tea master.', memories: [{ what_happened: 'Hana broke the cup.', changed_behavior: 'She serves in wooden bowls now.' }] });
    expect(r.skipped).toEqual([
      { path: 'filings[0].entry.memories[0]', why: "memory_rule: a memory needs changed_belief or changed_behavior; objective events belong in the historian's summaries" },
    ]);
  });

  test('the predicate: a non-blank string in either field, after `event` → `what_happened` and the coercions', () => {
    const memories = [
      { event: 'old Bunraku shape', changed_belief: 'kept' },
      { what_happened: 'blank', changed_belief: '   ' },
      { what_happened: 'a number', changed_belief: 5 },
      { what_happened: 'a list of strings', changedBelief: ['first', 'second'] },
      { what_happened: 'behavior only', changed_behavior: 'acts' },
      'a plain string',
      { what_happened: 'with only', with: 'Мира' },
    ];
    const r = ok(read([{ type: 'character', entry: { name: 'A', memories } }]));
    expect(r.items[0]!.data.memories).toEqual([
      { what_happened: 'old Bunraku shape', changed_belief: 'kept' },
      { what_happened: 'a list of strings', changed_belief: 'first; second' },
      { what_happened: 'behavior only', changed_behavior: 'acts' },
    ]);
    expect(codes({ ok: true, ...r })).toEqual([
      ['filings[0].entry.memories[1]', 'memory_rule'],
      ['filings[0].entry.memories[2].changed_belief', 'wrong_kind'],
      ['filings[0].entry.memories[2]', 'memory_rule'],
      ['filings[0].entry.memories[5]', 'memory_rule'],
      ['filings[0].entry.memories[6]', 'memory_rule'],
    ]);
  });

  test('every memory dropped: the field goes, the item stays', () => {
    const r = ok(read([{ type: 'character', entry: { name: 'A', role: 'ally', memories: [{ what_happened: 'x' }] } }]));
    expect(r.items[0]!.data).toEqual({ name: 'A', role: 'ally' });
  });

  test('a relationship without `with` is dropped; a bad nested enum costs only that field', () => {
    const r = ok(
      read([
        {
          type: 'character',
          entry: {
            name: 'A',
            relationships: [{ nature: 'ally' }, { with: 'B', nature: 'Best Friend', status: 'Strained' }, 'C is a friend', { with: ['D'], nature: 'family' }],
          },
        },
      ]),
    );
    expect(r.items[0]!.data.relationships).toEqual([{ with: 'B', status: 'strained' }, { with: 'D', nature: 'family' }]);
    expect(codes({ ok: true, ...r })).toEqual([
      ['filings[0].entry.relationships[0]', 'no_with'],
      ['filings[0].entry.relationships[1].nature', 'bad_enum'],
      ['filings[0].entry.relationships[2]', 'no_with'],
    ]);
  });

  test('the memory rule is filing’s character rule: other lists keep plain strings', () => {
    expect(only({ type: 'character', entry: { name: 'A', affiliations: ['Гильдия'] } }).data.affiliations).toEqual(['Гильдия']);
  });
});

describe('item limits (D-87)', () => {
  test('an entry over 6 000 JSON chars (3 000 lite) is rejected: file a shorter addition', () => {
    const entry = { name: 'Big', description: 'x'.repeat(5980) };
    expect(JSON.stringify(entry).length).toBeGreaterThan(6000);
    expect(codes(read([{ type: 'item', entry }]))).toEqual([['filings[0]', 'too_long']]);
    const small = { name: 'Mid', description: 'x'.repeat(3000) };
    expect(ok(read([{ type: 'item', entry: small }])).items).toHaveLength(1);
    expect(ok(read([{ type: 'item', entry: small }], DEFAULT_FILING_ALLOW, 'lite')).skipped[0]!.why).toBe(
      'too_long: its entry is longer than 3000 characters; file a shorter addition',
    );
  });

  test('values nested deeper than 6 levels reject the item', () => {
    const deep = (n: number): unknown => (n === 0 ? 'x' : { a: deep(n - 1) });
    expect(ok(read([{ type: 'item', entry: { name: 'Ok', physical: deep(5) } }])).items).toHaveLength(1);
    expect(codes(read([{ type: 'item', entry: { name: 'Deep', physical: deep(6) } }]))).toEqual([['filings[0]', 'too_deep']]);
  });
});

describe('structuredCall’s reader', () => {
  test('ok → the items and skipped; unreadable → invalid, so the corrective pass runs', () => {
    const r = filingReader({ allow: DEFAULT_FILING_ALLOW, profile: 'full' });
    expect(r({ filings: [{ type: 'item', entry: { name: 'Key', color: 'red' } }] })).toEqual({
      ok: true,
      value: [{ at: 0, type: 'item', name: 'Key', data: { name: 'Key', color: 'red' } }],
      skipped: [],
    });
    expect(r({ notes: 'nothing' })).toEqual({ ok: false, code: 'invalid', message: 'the answer has no "filings" list' });
    expect(r({})).toEqual({ ok: true, value: [], skipped: [] });
  });
});
