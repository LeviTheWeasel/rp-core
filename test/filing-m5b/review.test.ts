// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The filing reader after the M5b review (.notes/m5b-decisions.md, the lead's ruling I): free-form map
// keys are not renamed (review filing#4), a typeless element is not reread as a type-keyed item
// (filing#5), an item-level entry_type wins over the entry's own `type` field (filing#8), an envelope
// holding null, '' or "none" is nothing to file, and prototype keys never throw (breaker#7).
import { describe, expect, test } from 'bun:test';
import { filingReader, readFilingAnswer, snakeKey, type FilingItem, type FilingRead } from '../../src/agents/compendium/filing.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import { ENTRY_TYPES } from '../../src/agents/compendium/types.ts';

const read = (raw: unknown): FilingRead => readFilingAnswer(raw, { allow: ENTRY_TYPES, profile: 'full' });

function ok(r: FilingRead): { items: FilingItem[]; skipped: { path: string; why: string }[] } {
  if (!r.ok) throw new Error(`unreadable: ${r.why}`);
  return r;
}

describe('review filing#4: the keys of free-form maps stay as written', () => {
  test('stakes_per_character, family and notable_stats keep their keys; field names are still snake_cased', () => {
    const r = ok(
      read({
        filings: [
          {
            type: 'plot',
            entry: { name: 'Украденный свет', stakesPerCharacter: { 'Ульяна Петровна': 'теряет маяк', 'Frol McKee': 'loses the mill', ' Фрол ': 'долг' } },
          },
          { type: 'character', entry: { name: 'Фрол', family: { Мать: 'Анна', 'Older Brother': 'Сеня' }, notableStats: { STR: 18, 'Hit Points': 30 } } },
        ],
      }),
    );
    expect(r.items.map((i) => i.data)).toEqual([
      { name: 'Украденный свет', stakes_per_character: { 'Ульяна Петровна': 'теряет маяк', 'Frol McKee': 'loses the mill', Фрол: 'долг' } },
      { name: 'Фрол', family: { Мать: 'Анна', 'Older Brother': 'Сеня' }, notable_stats: { STR: 18, 'Hit Points': 30 } },
    ]);
    expect(r.skipped).toEqual([]);
  });

  test('the records of a nested field are still spelled as the schema spells them; what they hold is not', () => {
    const r = ok(
      read({
        filings: [
          {
            type: 'character',
            entry: {
              name: 'Фрол',
              currentState: { Status: 'alive', recentChanges: 'moved' },
              memories: [{ whatHappened: 'Мельница сгорела.', changedBelief: 'Огонь опасен.', With: ['Мира'] }],
              relationships: [{ With: 'Мира', nature: 'ally', History: { 'Old Debt': 'paid' } }],
            },
          },
        ],
      }),
    );
    expect(r.items[0]!.data).toEqual({
      name: 'Фрол',
      current_state: { status: 'alive', recent_changes: 'moved' },
      memories: [{ what_happened: 'Мельница сгорела.', changed_belief: 'Огонь опасен.', with: ['Мира'] }],
      relationships: [{ with: 'Мира', nature: 'ally', history: { 'Old Debt': 'paid' } }],
    });
  });

  test('a camelCase twin of a field is still dropped; two map keys that trim alike are one, said once', () => {
    const r = ok(read({ filings: [{ type: 'character', entry: { name: 'Фрол', family: { Мать: 'Анна', ' Мать ': 'Мария' } } }] }));
    expect(r.items[0]!.data.family).toEqual({ Мать: 'Анна' });
    expect(r.skipped).toEqual([{ path: 'filings[0].entry.family. Мать ', why: 'duplicate_field: Мать was given twice' }]);
  });
});

describe('review filing#5: a typeless element is not a type-keyed item', () => {
  test('an entry with a name and fields that are type words is rejected alone, with a reason', () => {
    const r = ok(read({ filings: [{ type: 'item', entry: { name: 'Ключ' } }, { name: 'Фрол', abilities: [{ name: 'Огненный шар' }], skills: ['рыбалка'] }] }));
    expect(r.items.map((i) => [i.type, i.name])).toEqual([['item', 'Ключ']]);
    expect(r.skipped).toEqual([{ path: 'filings[1]', why: 'unknown_type: it has no type' }]);
  });

  test('a typeless root entry is unreadable (the corrective pass), not an event of its `events` field', () => {
    expect(read({ name: 'Фрол', description: 'Мельник', events: [{ name: 'Пожар на мельнице' }] })).toEqual({ ok: false, why: 'the answer has no "filings" list' });
    expect(read({ title: 'Соль', rules: [{ topic: 'Прилив' }] }).ok).toBe(false);
  });

  test('type-keyed forms still read: a list element, the root, a stray scalar beside them', () => {
    const r = ok(read({ filings: [{ character: { name: 'Ян' } }, { abilities: [{ name: 'Огненный шар' }] }] }));
    expect(r.items.map((i) => [i.type, i.name])).toEqual([
      ['character', 'Ян'],
      ['power', 'Огненный шар'],
    ]);
    expect(ok(read({ character: [{ name: 'A' }], location: { name: 'B' }, mood: 'x' })).items.map((i) => i.name)).toEqual(['A', 'B']);
    // An object value under a word that is no type: an entry, not a type-keyed wrapper.
    expect(ok(read({ filings: [{ character: { name: 'Ян' }, currentState: { status: 'alive' } }] })).skipped).toEqual([{ path: 'filings[0]', why: 'unknown_type: it has no type' }]);
  });
});

describe('review filing#8: the item-level type wins over the entry’s own `type` field', () => {
  test('a flat location with entry_type and its own type keeps both', () => {
    const r = ok(read({ filings: [{ entry_type: 'location', name: 'Мельница', type: 'building', description: 'Старая мельница.' }] }));
    expect(r.items.map((i) => [i.type, i.data])).toEqual([['location', { name: 'Мельница', type: 'building', description: 'Старая мельница.' }]]);
    expect(r.skipped).toEqual([]);
    const camel = ok(read({ filings: [{ entryType: 'Item', name: 'Ключ от маяка', type: 'key' }] }));
    expect(camel.items.map((i) => [i.type, i.data])).toEqual([['item', { name: 'Ключ от маяка', type: 'key' }]]);
  });

  test('a `type` that names a type is the item’s, as before; a type that names none is still rejected', () => {
    expect(ok(read({ filings: [{ type: 'location', entry_type: 'character', name: 'Маяк' }] })).items.map((i) => [i.type, i.data])).toEqual([['location', { name: 'Маяк' }]]);
    expect(ok(read({ filings: [{ type: 'building', name: 'Маяк' }] })).skipped).toEqual([{ path: 'filings[0]', why: 'unknown_type: its type "building" is not one of the eleven' }]);
  });
});

describe('the lead’s ruling I: an envelope that says "nothing" is nothing to file', () => {
  test('null, "none" (any case) and a blank string, decoded or as text; a number still is not', () => {
    for (const raw of [{ filings: null }, { filings: 'none' }, { filings: ' None ' }, { filings: '' }, { items: null }, '{"filings": null}', 'Nothing.\n```json\n{"filings": "none"}\n```']) {
      expect(read(raw)).toEqual({ ok: true, items: [], skipped: [] });
    }
    expect(read({ filings: 3 }).ok).toBe(false);
    expect(read({ filings: 'nope' }).ok).toBe(false);
    expect(filingReader({ allow: DEFAULT_FILING_ALLOW, profile: 'full' })({ filings: null })).toEqual({ ok: true, value: [], skipped: [] });
  });
});

describe('review breaker#7: prototype keys never throw', () => {
  const KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

  test('as fields of nested records (relationships, memories, current_state, affiliations, powers): kept as unknown fields, the item stays', () => {
    for (const k of KEYS) {
      const text = `{"filings":[{"type":"character","entry":{"name":"Фрол","relationships":[{"with":"Мира","nature":"ally","${k}":"x"}],"memories":[{"what_happened":"a","changed_belief":"b","${k}":"y"}],"current_state":{"status":"alive","${k}":"z"},"affiliations":[{"org":"Гильдия","${k}":1}],"powers":[{"name":"Огонь","${k}":true}]}},{"type":"item","entry":{"name":"Ключ"}}]}`;
      const r = ok(read(text));
      expect(r.items.map((i) => i.name)).toEqual(['Фрол', 'Ключ']);
      const data = r.items[0]!.data as Record<string, Record<string, unknown>[]>;
      // A record's keys are spelled as the schema spells them (toString → to_string); the value is kept.
      expect(data.relationships![0]![snakeKey(k)]).toBe('x');
      expect(data.relationships![0]!.with).toBe('Мира');
    }
  });

  test('as item types, entry fields, type-keyed keys, envelope-like keys and enum values: read or rejected, never thrown', () => {
    for (const k of KEYS) {
      const texts = [
        `{"filings":[{"type":"${k}","entry":{"name":"X"}},{"type":"item","entry":{"name":"Ключ"}}]}`,
        `{"filings":[{"type":"item","entry":{"name":"Ключ","${k}":"v"}}]}`,
        `{"filings":[{"${k}":{"name":"X"}},{"type":"item","entry":{"name":"Ключ"}}]}`,
        `{"${k}":[{"type":"item","entry":{"name":"Ключ"}}]}`,
        `{"filings":[{"type":"threat","entry":{"name":"Буря","severity":"${k}","status":"${k}"}}]}`,
        `{"filings":[{"type":"character","entry":{"name":"Фрол","relationships":[{"with":"Мира","nature":"${k}"}]}}]}`,
      ];
      for (const text of texts) expect(() => read(text)).not.toThrow();
      expect(ok(read(texts[0]!)).items.map((i) => i.name)).toEqual(['Ключ']);
      expect(ok(read(texts[1]!)).items.map((i) => i.name)).toEqual(['Ключ']);
    }
  });
});
