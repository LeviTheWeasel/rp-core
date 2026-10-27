// Ported from RoleCall:apps/rc/src/lib/ai/dm-stream/tools/__tests__/vvs-811-adopt-render-order.test.ts@fb8dc623e
// ("string lists do not accumulate rephrasings": N1, N2 and their expectations verbatim) and
// Bunraku:src/core/compendium/filing.test.ts@702d8120 (the merge cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/merge.ts: the `file` merge (D-148), its per-element provenance (D-149) and sameData (ruling I).
// Vectors M1–M16 and N1–N7 are rolecall.md §3.1, "core" column; the rest are ported from RoleCall's
// vvs-811 tests and Bunraku's filing.test.ts merge cases.
import { describe, expect, test } from 'bun:test';
import { ARRAY_KEY_FNS, collapseNearDuplicates, deepEq, MERGE_MAX_DEPTH, mergeData, normKey, sameData } from '../../src/agents/compendium/merge.ts';
import { IDENTITY_KEEP } from '../../src/agents/compendium/entry-types.ts';
import type { Rec } from '../../src/agents/compendium/types.ts';

const merge = (old: Rec, incoming: Rec, keep: readonly string[] = IDENTITY_KEEP) => mergeData(old, incoming, { keep, on: 'a0000002', appended: {} });
const data = (old: Rec, incoming: Rec, keep?: readonly string[]) => merge(old, incoming, keep).data;

describe('normKey and the key fns', () => {
  test('normKey: folded, whitespace collapsed, trimmed; non-strings are ""', () => {
    expect(normKey('  Brothers   In\tArms ')).toBe('brothers in arms');
    expect(normKey('Ёлка')).toBe('елка');
    expect(normKey('Мо́ре')).toBe('море');
    expect(normKey(5)).toBe('');
    expect(normKey(undefined)).toBe('');
  });

  test('composite keys; all parts empty → no key; every key fn takes a plain string', () => {
    expect(ARRAY_KEY_FNS.relationships!({ with: 'Kael', nature: 'Ally' })).toBe('kael|ally');
    expect(ARRAY_KEY_FNS.relationships!({ nature: 'rival' })).toBe('|rival');
    expect(ARRAY_KEY_FNS.relationships!({ notes: 'x' })).toBe('');
    expect(ARRAY_KEY_FNS.memories!({ what_happened: 'Lost it', when: 'Turn 3' })).toBe('lost it|turn 3');
    expect(ARRAY_KEY_FNS.affiliations!({ org: 'Lantern Guild', role: 'x' })).toBe('lantern guild');
    expect(ARRAY_KEY_FNS.affiliations!({ with: 'Salt Court' })).toBe('salt court');
    expect(ARRAY_KEY_FNS.affiliations!({ org: '  ', with: 'Salt Court' })).toBe('salt court');
    expect(ARRAY_KEY_FNS.key_moments!({ description: 'The fall' })).toBe('the fall');
    expect(ARRAY_KEY_FNS.abilities!('Glows in the dark')).toBe('glows in the dark');
    expect(ARRAY_KEY_FNS.abilities!({ name: 'Bite', type: 'attack' })).toBe('bite|attack');
    for (const fn of Object.values(ARRAY_KEY_FNS)) expect(fn(' Mira ')).toBe('mira');
    expect(ARRAY_KEY_FNS.traits!({ a: 1 })).toBe('');
  });

  test('deepEq ignores key order and undefined fields', () => {
    expect(deepEq({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEq({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEq([1, 2], [2, 1])).toBe(false);
  });
});

describe('rolecall.md §3.1 merge vectors (core column)', () => {
  test('M1 a keyed relationship merges into the existing one (incoming casing)', () => {
    const r = data({ name: 'Mira', relationships: [{ with: 'Kael', nature: 'ally', status: 'active' }] }, { relationships: [{ with: 'kael', nature: 'Ally', status: 'strained' }] });
    expect(r.relationships).toEqual([{ with: 'kael', nature: 'Ally', status: 'strained' }]);
  });

  test('M2 another nature is another relationship', () => {
    expect((data({ relationships: [{ with: 'Kael', nature: 'ally' }] }, { relationships: [{ with: 'Kael', nature: 'rival' }] }).relationships as unknown[]).length).toBe(2);
  });

  test('M3 a memory with the same what/when merges', () => {
    const r = data({ memories: [{ what_happened: 'Lost the lantern', when: 'turn 3' }] }, { memories: [{ what_happened: 'lost the lantern', when: 'Turn 3', changed_belief: 'Light can be stolen.' }] });
    expect(r.memories).toEqual([{ what_happened: 'lost the lantern', when: 'Turn 3', changed_belief: 'Light can be stolen.' }]);
  });

  test('M4 keyed object lists are never near-duplicate-collapsed', () => {
    const r = data({ memories: [{ what_happened: 'He touched the scar', when: 'turn 3' }] }, { memories: [{ what_happened: 'He touched the scar again', when: 'turn 4' }] });
    expect(r.memories).toHaveLength(2);
  });

  test('M5, M6 a blank scalar never erases', () => {
    expect(data({ name: 'Mira', role: 'ally' }, { role: '' })).toEqual({ name: 'Mira', role: 'ally' });
    expect(data({ species: 'human' }, { species: '   ' })).toEqual({ species: 'human' });
  });

  test('M7 the identity field is kept; aliases are added', () => {
    expect(data({ name: 'Ambriel Dawnspark' }, { name: 'Ambriel', aliases: ['Ambriel'] })).toEqual({ name: 'Ambriel Dawnspark', aliases: ['Ambriel'] });
  });

  test('M8 objects deep-merge; a null leaf changes nothing', () => {
    expect(data({ physical: { height: 'tall' } }, { physical: { eyes: 'green', height: null } })).toEqual({ physical: { height: 'tall', eyes: 'green' } });
  });

  test('M9 an unkeyed list dedups by deepEq, key order ignored', () => {
    const r = data({ powers: [{ name: 'Fire', mastery: 'adept' }] }, { powers: [{ mastery: 'adept', name: 'Fire' }, { name: 'Fire', mastery: 'master' }] });
    expect(r.powers).toEqual([{ name: 'Fire', mastery: 'adept' }, { name: 'Fire', mastery: 'master' }]);
  });

  test('M10 duplicates inside incoming merge (the later wording wins)', () => {
    expect(data({ traits: ['kind'] }, { traits: ['brave', 'Brave'] }).traits).toEqual(['kind', 'Brave']);
  });

  test('M11 a composite key with one part still keys; items with no key append', () => {
    const r = data({ relationships: [{ nature: 'rival', notes: 'a' }] }, { relationships: [{ nature: 'rival', notes: 'b' }, { notes: 'c' }, { notes: 'd' }] });
    expect(r.relationships).toEqual([{ nature: 'rival', notes: 'b' }, { notes: 'c' }, { notes: 'd' }]);
  });

  test('M12 affiliations key by org', () => {
    const r = data({ affiliations: [{ org: 'Lantern Guild', role: 'apprentice' }] }, { affiliations: [{ org: 'lantern guild', role: 'keeper' }] });
    expect(r.affiliations).toEqual([{ org: 'lantern guild', role: 'keeper' }]);
  });

  test('M13 string abilities key by the string', () => {
    expect(data({ abilities: ['Glows in the dark'] }, { abilities: ['Burns spirits'] }).abilities).toEqual(['Glows in the dark', 'Burns spirits']);
  });

  test('M14 a kind mismatch replaces', () => {
    expect(data({ skills: ['archery'] }, { skills: 'archery, riding' }).skills).toBe('archery, riding');
  });

  test('M15 a first write is deduplicated and loses blank items', () => {
    expect(data({ name: 'M' }, { traits: ['brave', 'Brave', ''] })).toEqual({ name: 'M', traits: ['Brave'] });
  });

  test('M16 blank items are dropped; a keyed string takes the incoming wording', () => {
    expect(data({ traits: ['kind'] }, { traits: ['', 'kind '] }).traits).toEqual(['kind ']);
  });

  test('N1 rephrased facts collapse onto the fuller wording (RoleCall vvs-811, verbatim)', () => {
    const r = data(
      {
        physical: {
          distinguishing_features: [
            'Crescent scar beneath the left eye, taken in the childhood assassination attempt that killed his brothers',
            'Black tattoos on each arm',
          ],
        },
      },
      {
        physical: {
          distinguishing_features: [
            'Crescent scar beneath the left eye from the childhood assassination attempt',
            'Crescent scar beneath left eye',
            'Wears black tattoos on each arm',
            'Deep voice, velvet wrapped around steel',
          ],
        },
      },
    );
    expect((r.physical as Rec).distinguishing_features).toEqual([
      'Crescent scar beneath the left eye, taken in the childhood assassination attempt that killed his brothers',
      'Wears black tattoos on each arm',
      'Deep voice, velvet wrapped around steel',
    ]);
  });

  test('N2 facts that share words but differ in substance stay (RoleCall vvs-811)', () => {
    const r = data({ personality: { fears: ['Losing Aaron to the northern lords'] } }, { personality: { fears: ['Losing Aaron to the sea', 'Proud'] } });
    expect((r.personality as Rec).fears).toEqual(['Losing Aaron to the northern lords', 'Losing Aaron to the sea', 'Proud']);
  });

  test('N3 left and right cheek stay apart', () => {
    expect(data({ traits: ['Scar on the left cheek'] }, { traits: ['Scar on the right cheek'] }).traits).toHaveLength(2);
  });

  test('N4 a Russian rephrasing collapses onto the longer incoming text', () => {
    const longer = 'Шрам под левым глазом в форме полумесяца, след покушения в детстве';
    expect(data({ traits: ['Шрам в форме полумесяца под левым глазом'] }, { traits: [longer] }).traits).toEqual([longer]);
  });

  test('N5 левой / правой щеке stay apart', () => {
    expect(data({ traits: ['Шрам на левой щеке'] }, { traits: ['Шрам на правой щеке'] }).traits).toHaveLength(2);
  });

  test('N6 known miss: хранит / хранится stem apart', () => {
    expect(data({ traits: ['Фонарщица хранит последний фонарь гильдии'] }, { traits: ['Последний фонарь гильдии хранится у фонарщицы'] }).traits).toHaveLength(2);
  });

  test('N7 fewer than 3 significant tokens never collapse', () => {
    expect(data({ traits: ['Смелая'] }, { traits: ['Очень смелая'] }).traits).toEqual(['Смелая', 'Очень смелая']);
  });
});

describe('mergeData (Bunraku filing.test.ts cases)', () => {
  test('each rule, and an unchanged field is not a change', () => {
    const old = { name: 'Mira', tier: 'B', memories: [{ event: 'a' }], physical: { hair: 'red', eyes: 'grey' }, likes: ['tea'] };
    const m = mergeData(old, { name: 'Mira Vance', tier: 'A', memories: [{ event: 'a' }, { event: 'b' }], physical: { hair: 'black' }, likes: ['tea'], age: '30' }, { keep: ['name'], on: null, appended: {} });
    expect(m.data).toEqual({ name: 'Mira', tier: 'A', memories: [{ event: 'a' }, { event: 'b' }], physical: { hair: 'black', eyes: 'grey' }, likes: ['tea'], age: '30' });
    expect(m.data.likes).toBe(old.likes);
    expect(m.changed).toBe(true);
  });

  test('blank incoming values change nothing: the same reference back', () => {
    const old = { tier: 'B', likes: ['tea'] };
    const m = mergeData(old, { tier: '', likes: [], description: '  ', x: null, y: undefined }, { keep: [], on: 'a', appended: {} });
    expect(m.data).toBe(old);
    expect(m.changed).toBe(false);
  });

  test('a merge that repeats what is there is no change', () => {
    const old = { name: 'Mira', traits: ['kind', 'brave'], physical: { eyes: 'grey' }, relationships: [{ with: 'Kael', nature: 'ally' }] };
    const appended = { traits: ['a1', null], relationships: ['a1'] };
    const m = mergeData(old, { name: 'Mira', traits: ['Kind'.toLowerCase()], physical: { eyes: 'grey' }, relationships: [{ with: 'Kael', nature: 'ally' }] }, { keep: IDENTITY_KEEP, on: 'a9', appended });
    expect(m.data).toBe(old);
    expect(m.appended).toBe(appended);
    expect(m.changed).toBe(false);
  });

  test('a rephrasing that collapses back into the old wording is no change', () => {
    const old = { key_facts: ['The lantern guild keeps the last flame of the city'] };
    const m = mergeData(old, { key_facts: ['The guild keeps the last flame'] }, { keep: [], on: 'a', appended: {} });
    expect(m.data).toBe(old);
  });

  test('keep: an existing non-blank identity is kept, a blank one is filled', () => {
    expect(data({ name: '  ', topic: 'Fire law' }, { name: 'Mira', topic: 'Other' })).toEqual({ name: 'Mira', topic: 'Fire law' });
    expect(data({ title: 'Old' }, { title: 'New' }, [])).toEqual({ title: 'New' });
  });

  test('a new nested object is stored without its blank leaves', () => {
    expect(data({}, { current_state: { status: 'alive', location: '  ', condition: null }, ecology: {} })).toEqual({ current_state: { status: 'alive' }, ecology: {} });
  });

  test('never mutates its inputs; never sets a prototype', () => {
    const old = { name: 'Mira', traits: ['kind'], physical: { eyes: 'grey' } };
    const incoming = JSON.parse('{"traits":["brave"],"physical":{"hair":"red","__proto__":{"x":1}},"__proto__":{"polluted":true}}') as Rec;
    const before = structuredClone(old);
    const r = mergeData(old, incoming, { keep: [], on: 'a', appended: {} });
    expect(old).toEqual(before);
    expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(r.data.physical)).toBe(Object.prototype);
    expect(({} as Rec).polluted).toBeUndefined();
    expect(Object.hasOwn(r.data, '__proto__')).toBe(true);
  });
});

describe('prov.appended (D-149)', () => {
  const on = 'a0000009';
  const run = (old: Rec, incoming: Rec, appended: Record<string, (string | null)[]> = {}) => mergeData(old, incoming, { keep: IDENTITY_KEEP, on, appended });

  test('new elements get `on`; unchanged old ones keep theirs (missing = null)', () => {
    const r = run({ traits: ['kind', 'brave'] }, { traits: ['wise'] }, { traits: ['a1', 'a2'] });
    expect(r.data.traits).toEqual(['kind', 'brave', 'wise']);
    expect(r.appended).toEqual({ traits: ['a1', 'a2', on] });
    // A library base list has no entry: its elements read null.
    expect(run({ traits: ['kind'] }, { traits: ['wise'] }).appended).toEqual({ traits: [null, on] });
  });

  test('an old element changed by a keyed merge gets `on`', () => {
    const r = run({ relationships: [{ with: 'Kael', nature: 'ally' }, { with: 'Ion', nature: 'rival' }] }, { relationships: [{ with: 'Ion', nature: 'rival', status: 'strained' }] }, { relationships: ['a1', 'a2'] });
    expect(r.appended).toEqual({ relationships: ['a1', on] });
  });

  test('a collapse: the slot follows the text it kept; a removed element loses its slot', () => {
    const old = { distinguishing_features: ['Black tattoos on each arm', 'Scar'] };
    const r = run(old, { distinguishing_features: ['Wears black tattoos on each arm', 'Black tattoos on arm each'] }, { distinguishing_features: ['a1', 'a2'] });
    expect(r.data.distinguishing_features).toEqual(['Wears black tattoos on each arm', 'Scar']);
    expect(r.appended).toEqual({ distinguishing_features: [on, 'a2'] });
    // A shorter rephrasing collapses into the old element, which keeps its own `on`.
    const r2 = run(old, { distinguishing_features: ['Tattoos black each arm', 'Limp'] }, { distinguishing_features: ['a1', 'a2'] });
    expect(r2.data.distinguishing_features).toEqual(['Black tattoos on each arm', 'Scar', 'Limp']);
    expect(r2.appended).toEqual({ distinguishing_features: ['a1', 'a2', on] });
  });

  test('a field replaced by a non-array loses its entry; nested arrays carry none', () => {
    const r = run({ skills: ['archery'], physical: { marks: ['a'] } }, { skills: 'archery, riding', physical: { marks: ['b'] } }, { skills: ['a1'] });
    expect(r.appended).toEqual({});
    expect((r.data.physical as Rec).marks).toEqual(['a', 'b']);
  });

  test('a human row (on null) records null', () => {
    expect(mergeData({}, { traits: ['kind'] }, { keep: [], on: null, appended: {} }).appended).toEqual({ traits: [null] });
  });
});

describe('collapseNearDuplicates', () => {
  test('non-strings pass through; the index map names the source of each slot', () => {
    const r = collapseNearDuplicates(['Black tattoos on each arm', 3, { a: 1 }, 'Wears black tattoos on each arm']);
    expect(r.items).toEqual(['Wears black tattoos on each arm', 3, { a: 1 }]);
    expect(r.from).toEqual([3, 1, 2]);
  });

  test('nothing collapsed or over 400 items: the same array back', () => {
    const plain = ['one two three', 'four five six'];
    expect(collapseNearDuplicates(plain).items).toBe(plain);
    const many = Array.from({ length: 401 }, () => 'the same fact repeated here');
    expect(collapseNearDuplicates(many).items).toBe(many);
    expect(collapseNearDuplicates(many.slice(0, 400)).items).toEqual(['the same fact repeated here']);
  });

  test('an item merges into the FIRST near-duplicate even when a later slot changed text', () => {
    const r = collapseNearDuplicates(['alpha beta gamma', 'delta epsilon zeta', 'alpha beta gamma delta epsilon zeta eta']);
    // The third is a superset of both; it lands in the first slot.
    expect(r.items).toEqual(['alpha beta gamma delta epsilon zeta eta', 'delta epsilon zeta']);
  });
});

describe('unkeyed list items (review breaker#6: a set of canonical texts, the same results as a deepEq scan)', () => {
  /** The D-148 rule as a plain deepEq scan, for lists without blanks or strings (nothing to clean or collapse). */
  const reference = (old: readonly unknown[], incoming: readonly unknown[]): unknown[] => {
    const out = [...old];
    for (const v of incoming) if (!out.some((had) => deepEq(had, v))) out.push(v);
    return out;
  };
  /** Deterministic values that deepEq tells apart only by content: shuffled keys, 1 vs '1', nesting, NaN. */
  const POOL: unknown[] = [
    { name: 'нож', note: 'старый' },
    { note: 'старый', name: 'нож' },
    { name: 'нож', note: 'новый' },
    { name: 'нож', note: 'старый', extra: undefined },
    { a: 1 },
    { a: '1' },
    { a: [1, { b: true }] },
    { a: [{ b: true }, 1] },
    [1, 2],
    [2, 1],
    1,
    true,
    0,
    -0,
    { a: Number.NaN },
    { nested: { deep: { deeper: ['x', { y: 2 }] } } },
    { nested: { deep: { deeper: [{ y: 2 }, 'x'] } } },
  ];

  test('a deterministic run of merges, branches included, matches the deepEq scan exactly', () => {
    let state = 7;
    const next = (n: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (state >>> 16) % n;
    };
    const lists: unknown[][] = [[]];
    for (let step = 0; step < 400; step++) {
      // Mostly the newest list (a fold's chain), sometimes an older one (a checkpoint, a dry run, another branch).
      const from = next(4) === 0 ? lists[next(lists.length)]! : lists[lists.length - 1]!;
      const incoming = Array.from({ length: 1 + next(3) }, () => structuredClone(POOL[next(POOL.length)]));
      const got = mergeData({ possessions: from }, { possessions: incoming }, { keep: [], on: null, appended: {} }).data.possessions as unknown[];
      const want = reference(from, incoming);
      // toEqual: NaN equals NaN, an undefined field is absent (fresh drops it, the scan keeps it).
      expect(got).toEqual(want);
      lists.push(got);
    }
    expect(Math.max(...lists.map((l) => l.length))).toBeGreaterThan(14);
  });

  test('keyed lists: items without a key dedupe by content, keyed ones by key', () => {
    const r = data({ relationships: [{ notes: 'old', tags: ['a', 'b'] }, { with: 'Кай', nature: 'ally' }] }, { relationships: [{ tags: ['a', 'b'], notes: 'old' }, { with: 'кай', nature: 'ALLY', status: 'strained' }, { notes: 'new' }] });
    expect(r.relationships).toEqual([{ notes: 'old', tags: ['a', 'b'] }, { with: 'кай', nature: 'ALLY', status: 'strained' }, { notes: 'new' }]);
  });
});

describe('depth bound (review breaker#3, merge side)', () => {
  /** `{a: {a: … 'leaf' }}`, `n` levels. */
  const nest = (n: number, leaf: unknown = 'leaf'): unknown => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { a: v };
    return v;
  };
  const below = (v: unknown, n: number): unknown => {
    let x = v;
    for (let i = 0; i < n; i++) x = (x as Rec).a;
    return x;
  };

  test('past depth 32 a value is a scalar: stored as given, never recursed; 20 000 levels merge', () => {
    const deep = nest(20_000);
    const m = mergeData({}, { deep }, { keep: [], on: null, appended: {} });
    // `deep` is level 1: levels 1…32 are walked (copied), level 33 is the incoming value itself.
    expect(below(m.data.deep, 31)).not.toBe(below(deep, 31));
    expect(below(m.data.deep, 32)).toBe(below(deep, 32));
    // Blanks are dropped down to level 32 and kept past it.
    const shallow = mergeData({}, { x: nest(30, { keep: 1, drop: '  ' }) }, { keep: [], on: null, appended: {} }).data;
    expect(below(shallow.x, 30)).toEqual({ keep: 1 });
    const past = mergeData({}, { x: nest(32, { keep: 1, drop: '  ' }) }, { keep: [], on: null, appended: {} }).data;
    expect(below(past.x, 32)).toEqual({ keep: 1, drop: '  ' });
    expect(MERGE_MAX_DEPTH).toBe(32);
  });

  test('an equal deep value again is no change; a different one replaces it', () => {
    const first = mergeData({}, { deep: nest(20_000) }, { keep: [], on: null, appended: {} }).data;
    const again = mergeData(first, { deep: nest(20_000) }, { keep: [], on: null, appended: {} });
    expect(again.changed).toBe(false);
    expect(again.data).toBe(first);
    const other = mergeData(first, { deep: nest(20_000, 'другой') }, { keep: [], on: null, appended: {} });
    expect(other.changed).toBe(true);
    expect(below(other.data.deep, 20_000)).toBe('другой');
  });

  test('deep list items dedupe and merge without recursing past the bound', () => {
    const item = () => ({ name: 'нож', deep: nest(20_000) });
    const first = mergeData({}, { possessions: [item()] }, { keep: [], on: null, appended: {} }).data;
    const again = mergeData(first, { possessions: [item(), item()] }, { keep: [], on: null, appended: {} });
    expect(again.changed).toBe(false);
    const keyed = mergeData({}, { memories: [{ what_happened: 'a', deep: nest(20_000) }] }, { keep: [], on: null, appended: {} }).data;
    const merged = mergeData(keyed, { memories: [{ what_happened: 'a', deep: nest(20_000, 'b') }] }, { keep: [], on: null, appended: {} });
    expect(below((merged.data.memories as Rec[])[0]!.deep, 20_000)).toBe('b');
  });
});

describe('sameData (ruling I: the verbs\' no-op check, bounded like the merge)', () => {
  /** `n` levels of `{a: …}` over `leaf`; the object at level `at` (from the top, 1-based) also has `b: 1`, written first when `bFirst`. */
  const chain = (n: number, leaf: unknown = 'leaf', at = 0, bFirst = false): unknown => {
    let v = leaf;
    for (let level = n; level >= 1; level--) v = level !== at ? { a: v } : bFirst ? { b: 1, a: v } : { a: v, b: 1 };
    return v;
  };
  const PAIRS: unknown[] = [
    { name: 'нож', note: 'старый' },
    { note: 'старый', name: 'нож' },
    { name: 'нож', note: 'старый', extra: undefined },
    { name: 'нож' },
    { a: 1 },
    { a: '1' },
    { a: null },
    {},
    { a: [1, { b: true }] },
    { a: [{ b: true }, 1] },
    [1, 2],
    [2, 1],
    [1, 2, 3],
    [undefined],
    [null],
    [],
    1,
    '1',
    true,
    null,
    undefined,
    0,
    -0,
    Number.NaN,
    { a: Number.NaN },
    { nested: { deep: { deeper: ['x', { y: 2 }] } } },
    { nested: { deep: { deeper: ['x', { y: 2, z: undefined }] } } },
    { nested: { deep: { deeper: [{ y: 2 }, 'x'] } } },
  ];

  test('within the bound it is deepEq: every pair of a pool, as distinct copies', () => {
    const copy = (v: unknown): unknown => (typeof v === 'object' && v !== null ? structuredClone(v) : v);
    let same = 0;
    for (const a of PAIRS) {
      for (const b of PAIRS) {
        const want = deepEq(copy(a), copy(b));
        expect([a, b, sameData(copy(a), copy(b))]).toEqual([a, b, want]);
        if (want) same++;
      }
    }
    expect(same).toBeGreaterThan(PAIRS.length);
  });

  test('past the bound: an equal deep value is the same, a different leaf or field is not, key order is ignored for another 32 levels', () => {
    expect(sameData(chain(2_000), chain(2_000))).toBe(true);
    expect(sameData(chain(2_000), chain(2_000, 'другой'))).toBe(false);
    expect(sameData(chain(2_000), chain(1_999))).toBe(false);
    expect(sameData(chain(2_000, 'leaf', 1_500), chain(2_000))).toBe(false);
    expect(sameData(chain(2_000, 'leaf', 1_500), chain(2_000, 'leaf', 1_500))).toBe(true);
    expect(sameData(chain(2_000, 'leaf', 1_500, true), chain(2_000, 'leaf', 1_500))).toBe(false); // JSON text: key order counts there
    // `chain`'s level 1 is the argument itself, so its level L is the merge's level L - 1.
    for (const at of [10, MERGE_MAX_DEPTH + 1, MERGE_MAX_DEPTH + 10, 2 * MERGE_MAX_DEPTH + 1, 2 * MERGE_MAX_DEPTH + 2]) {
      expect([at, sameData(chain(2_000, 'leaf', at, true), chain(2_000, 'leaf', at))]).toEqual([at, at <= 2 * MERGE_MAX_DEPTH + 1]);
    }
    expect(sameData([{ x: chain(100) }], [{ x: chain(100) }])).toBe(true);
    expect(sameData({ x: chain(100), y: undefined }, { x: chain(100) })).toBe(true);
  });

  /** Calls `fn` under `n` frames of filler recursion (not a tail call, so every frame stays). */
  function under(n: number, fn: () => void): number {
    if (n === 0) {
      fn();
      return 0;
    }
    return under(n - 1, fn) + 1;
  }
  /** The deepest filler under which `fn` still runs: what is left of the stack once `fn` has what it needs. */
  function headroom(fn: () => void): number {
    const fits = (n: number): boolean => {
      try {
        under(n, fn);
        return true;
      } catch (e) {
        if (e instanceof RangeError) return false;
        throw e;
      }
    };
    let lo = 0;
    let hi = 1 << 22;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  test('the stack it needs does not grow with depth: 2 000 levels need what 40 do (deepEq needs thousands of frames more)', () => {
    const [a40, b40, a2k, b2k] = [chain(40), chain(40), chain(2_000), chain(2_000)];
    let sink = 0;
    const run = (eq: (a: unknown, b: unknown) => boolean, a: unknown, b: unknown) => (): void => {
      if (eq(a, b)) sink++;
    };
    for (let i = 0; i < 3; i++) headroom(run(sameData, a40, b40)); // warm the filler and the walk
    const same40 = headroom(run(sameData, a40, b40));
    const same2k = headroom(run(sameData, a2k, b2k));
    const deep40 = headroom(run(deepEq, a40, b40));
    const deep2k = headroom(run(deepEq, a2k, b2k));
    expect(sink).toBeGreaterThan(0);
    expect(same40).toBeGreaterThan(1_000);
    expect(same2k).toBeGreaterThan(same40 - 500);
    // The control: the measure sees an unbounded walk (what the verbs' no-op check did with deepEq).
    expect(deep2k).toBeLessThan(deep40 - 1_000);
  });
});
