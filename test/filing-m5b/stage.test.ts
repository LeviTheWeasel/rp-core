// Ported from Bunraku:src/core/compendium/filing.test.ts@702d8120 (staging: an alias files into the
// canonical entry, a nickname with punctuation still finds it, items rejected alone, two items for one
// new entity, a pass that outgrows its receipt) and Bunraku:src/studio/compendium-filing.test.ts@702d8120
// (a create and a merge in one pass; a type switched off; a bad item alone; an untyped name).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/filing.ts, M5b (D-175): stageFiling against the fold — the ops it writes are deltas
// (agent `file` ops, no target), and folding them gives what staging predicted.
import { describe, expect, test } from 'bun:test';
import { readFilingAnswer, stageFiling, type FilingItem, type StageResult } from '../../src/agents/compendium/filing.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import type { CEntry, CompendiumView, EntryType, LibrarySeed, Rec } from '../../src/agents/compendium/types.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { classicLore, fileOp, filingRow, foldWith, lanternBook, seedOf, source, typedLore, wolfBook } from './kit.ts';

const item = (at: number, type: EntryType, data: Rec): FilingItem => ({ at, type, name: String(data.name ?? data.title ?? data.topic), data });

/** Stages `items` against the fold of `rows`, then folds the row the lane would write; both views. */
function run(seed: LibrarySeed, rows: MemEntry[], items: FilingItem[]): { before: CompendiumView; staged: StageResult; after: CompendiumView } {
  const before = foldWith(seed, rows);
  const staged = stageFiling(items, before, { classic: seed.classic });
  const after = foldWith(seed, [...rows, filingRow(100, 'a2', staged.ops, 'u2')]);
  return { before, staged, after };
}

const entry = (v: CompendiumView, key: string): CEntry => {
  const e = v.entries.get(key);
  if (!e) throw new Error(`no ${key}: ${[...v.entries.keys()].join(', ')}`);
  return e;
};
const sessionKeys = (v: CompendiumView): string[] => [...v.entries.keys()].filter((k) => !k.startsWith('lib:'));

/** Every op's predicted effect is what the fold did with it: merged into `key`, or created. */
function expectFoldAgrees(r: ReturnType<typeof run>): void {
  const effects = r.after.effects.filter((e) => e.seq === 100);
  expect(effects.map((e) => e.change)).toEqual(r.staged.planned.map((p) => p.change));
  r.staged.planned.forEach((p, i) => {
    if (p.key !== null) expect(effects[i]!.key).toBe(p.key);
    expect(entry(r.after, effects[i]!.key).name).toBe(p.name);
  });
  expect(r.after.issues.filter((i) => i.seq === 100)).toEqual([]);
}

describe('port: Bunraku’s staging cases', () => {
  const seed = seedOf(wolfBook());

  test('an alias files into the canonical entry: one delta, the rest of the entry untouched, the name kept (a library entry: an overlay)', () => {
    const r = run(seed, [], [item(0, 'character', { name: 'Wolfman', tier: 'A', memories: [{ what_happened: 'b', changed_belief: 'c' }] })]);
    expect(r.staged.skipped).toEqual([]);
    expect(r.staged.ops).toEqual([fileOp('character', { name: 'Wolfman', tier: 'A', memories: [{ what_happened: 'b', changed_belief: 'c' }] })]);
    expect(r.staged.planned).toEqual([{ type: 'character', name: 'Lycanthrope', change: 'merged', key: 'lib:bk:c1', items: [0] }]);
    const wolf = entry(r.after, 'lib:bk:c1');
    expect(wolf.origin).toEqual({ kind: 'library', book: 'bk', id: 'c1', overlay: true });
    expect(wolf.data).toEqual({ name: 'Lycanthrope', aliases: ['Wolfman', 'the werewolf'], tagline: 'A werewolf NPC', tier: 'A', memories: [{ what_happened: 'b', changed_belief: 'c' }] });
    expectFoldAgrees(r);
  });

  test('a nickname given with punctuation still finds the canonical entry', () => {
    const r = run(seed, [], [item(0, 'character', { name: 'x', aliases: ['The Werewolf!'], tier: 'S' })]);
    expect(r.staged.planned[0]).toMatchObject({ change: 'merged', key: 'lib:bk:c1' });
    expectFoldAgrees(r);
  });

  test('items are rejected alone: an untyped name, a missing required field, a merge that adds nothing', () => {
    const r = run(seed, [], [
      item(0, 'location', { name: 'Harbor Lore', climate: 'x' }),
      item(1, 'worldbuilding', { topic: 'Currents' }),
      item(2, 'character', { name: 'Wolfman', tier: 'B' }),
      item(3, 'item', { name: 'Lantern' }),
    ]);
    expect(r.staged.skipped).toEqual([
      { path: 'filings[0]', why: 'classic_conflict: an entry named "Harbor Lore" exists without a type and is left as written' },
      { path: 'filings[1]', why: 'missing_required: a new worldbuilding needs category, description' },
    ]);
    expect(r.staged.unchanged).toEqual([2]);
    expect(r.staged.ops).toEqual([fileOp('item', { name: 'Lantern' })]);
    expect(r.staged.notices).toEqual([{ code: 'filing_classic_conflict', name: 'Harbor Lore', key: 'lib:bk:k1' }]);
    expect(sessionKeys(r.after)).toEqual(['item:lantern']);
    expectFoldAgrees(r);
  });

  test('two items for one new entity become one delta', () => {
    const r = run(seed, [], [item(0, 'character', { name: 'Vera', tier: 'B' }), item(1, 'character', { name: 'Vera', likes: ['m'] })]);
    expect(r.staged.ops).toEqual([fileOp('character', { name: 'Vera', tier: 'B', likes: ['m'] })]);
    expect(r.staged.planned).toEqual([{ type: 'character', name: 'Vera', change: 'created', key: null, items: [0, 1] }]);
    expect(entry(r.after, 'character:vera').data).toEqual({ name: 'Vera', tier: 'B', likes: ['m'] });
    expectFoldAgrees(r);
  });

  test('replaces the receipt budget: ops past the row’s cap go to skipped, with everything after them', () => {
    const big = 'x'.repeat(900);
    const items = [0, 1, 2, 3].map((i) => item(i, 'item', { name: `I${i}`, description: big }));
    const capped = stageFiling(items, foldWith(seed, []), { opsChars: 2500 });
    expect(capped.ops.map((o) => (o as { data: Rec }).data.name)).toEqual(['I0', 'I1']);
    expect(capped.skipped.map((s) => s.path)).toEqual(['filings[2]', 'filings[3]']);
    expect(capped.skipped[0]!.why).toBe('ops_limit: this row already holds 2500 characters of changes; file it again');
    expect(JSON.stringify(capped.ops).length).toBeLessThanOrEqual(2500);
    // The default cap is 24 000 chars of ops JSON.
    const many = Array.from({ length: 12 }, (_, i) => item(i, 'item', { name: `J${i}`, description: 'y'.repeat(2500) }));
    const out = stageFiling(many, foldWith(seed, []));
    expect(JSON.stringify(out.ops).length).toBeLessThanOrEqual(24_000);
    expect(out.ops.length + out.skipped.length).toBe(12);
    expect(out.skipped.every((s) => s.why.startsWith('ops_limit:'))).toBe(true);
  });
});

describe('the studio pass, staged (adapted)', () => {
  const seed = seedOf(wolfBook());
  const create = { type: 'location', entry: { name: 'Dock Ward', climate: 'salt wind' } };
  const merge = { type: 'character', entry: { name: 'Wolfman', tier: 'A', memories: [{ what_happened: 'b', changed_behavior: 'howls less' }] } };
  const readItems = (...filings: unknown[]): FilingItem[] => {
    const r = readFilingAnswer({ filings }, { allow: DEFAULT_FILING_ALLOW, profile: 'full' });
    if (!r.ok) throw new Error(r.why);
    return r.items;
  };

  test('a create and a merge into the canonical (library) entry land as one row with two ops; the classic entry is untouched', () => {
    const r = run(seed, [], readItems(create, merge));
    expect(r.staged.planned.map((p) => [p.change, p.key, p.name])).toEqual([
      ['created', null, 'Dock Ward'],
      ['merged', 'lib:bk:c1', 'Lycanthrope'],
    ]);
    expect(entry(r.after, 'location:dock ward').data).toEqual({ name: 'Dock Ward', climate: 'salt wind' });
    expect(entry(r.after, 'lib:bk:c1').data).toMatchObject({ tier: 'A', memories: [{ what_happened: 'b', changed_behavior: 'howls less' }] });
    expectFoldAgrees(r);
  });

  test('a type switched off: nothing to file, the row is still written (ops: [])', () => {
    const r = readFilingAnswer({ filings: [create] }, { allow: ['character'], profile: 'full' });
    expect(r.ok && r.items).toEqual([]);
    expect(stageFiling(r.ok ? r.items : [], foldWith(seed, []), { classic: seed.classic })).toEqual({ ops: [], planned: [], skipped: [], notices: [], unchanged: [] });
  });

  test('a bad item alone: an unknown type is rejected, a bad enum only loses its field', () => {
    const r = run(seed, [], readItems({ type: 'dragon', entry: { name: 'X' } }, create, { type: 'item', entry: { name: 'Lantern', type: 'spaceship' } }));
    expect(r.staged.planned.map((p) => p.name)).toEqual(['Dock Ward', 'Lantern']);
    expect(entry(r.after, 'item:lantern').data).toEqual({ name: 'Lantern' });
  });

  test('an untyped name is left as written and said once; a `book` is ignored', () => {
    const r = run(seed, [], readItems({ type: 'location', entry: { name: 'Harbor Lore', climate: 'x' } }, { type: 'item', book: 'elsewhere', entry: { name: 'Lamp' } }, { type: 'location', entry: { name: 'harbor  lore!' } }));
    expect(r.staged.skipped.map((s) => s.why.split(':')[0])).toEqual(['classic_conflict', 'classic_conflict']);
    expect(r.staged.notices).toEqual([{ code: 'filing_classic_conflict', name: 'Harbor Lore', key: 'lib:bk:k1' }]);
    expect(sessionKeys(r.after)).toEqual(['item:lamp']);
  });
});

describe('staging against the fold (D-175)', () => {
  const seed = seedOf(lanternBook(), wolfBook());

  test('a session entry is found before a library one of the same name', () => {
    // A hand-filed entry pinned to its session key (D-168), so the story has its own Ульяна.
    const rows: MemEntry[] = [
      { t: 'mem', seq: 1, ts: 'x', key: null, on: null, by: 'user', ops: [{ op: 'file', type: 'character', data: { name: 'Ульяна', description: 'Тёзка смотрительницы.' }, target: 'character:ульяна' }] },
    ];
    const r = run(seed, rows, [item(0, 'character', { name: 'Ульяна', role: 'ally' })]);
    expect(r.staged.planned).toEqual([{ type: 'character', name: 'Ульяна', change: 'merged', key: 'character:ульяна', items: [0] }]);
    expect(entry(r.after, 'lib:lantern:e1').origin).toMatchObject({ overlay: false });
    expectFoldAgrees(r);
  });

  test('an alias of a library entry makes an overlay; the overlay’s later delta merges into it', () => {
    const r = run(seed, [], [item(0, 'character', { name: 'Смотрительница', current_state: { status: 'alive' } }), item(1, 'character', { name: 'Уля', likes: ['чай'] })]);
    expect(r.staged.ops).toEqual([fileOp('character', { name: 'Смотрительница', current_state: { status: 'alive' }, likes: ['чай'] })]);
    expect(entry(r.after, 'lib:lantern:e1').data).toMatchObject({ name: 'Ульяна', current_state: { status: 'alive' }, likes: ['чай'] });
    expectFoldAgrees(r);
  });

  test('required fields are checked after the merge: an incomplete library entry is not made worse', () => {
    const r = run(seed, [], [item(0, 'worldbuilding', { topic: 'Tides', key_facts: ['Spring tides flood the docks.'] })]);
    expect(r.staged.skipped).toEqual([{ path: 'filings[0]', why: 'missing_required: "Tides" would still lack category' }]);
    expect(r.staged.ops).toEqual([]);
  });

  test('merges that change nothing are dropped: the same facts again, a known alias (a reworded one is a change)', () => {
    const rows = [filingRow(1, 'a1', [fileOp('character', { name: 'Фрол', aliases: ['лодочник'], likes: ['море'] })])];
    const r = run(seed, rows, [
      item(0, 'character', { name: 'лодочник', likes: ['море'] }),
      item(1, 'location', { name: 'маяк', description: 'Маяк на мысе.' }),
      item(2, 'character', { name: 'Фрол', aliases: ['лодочник'] }),
      item(3, 'character', { name: 'Фрол', likes: ['Море'] }),
    ]);
    expect(r.staged.unchanged).toEqual([0, 1, 2]);
    // The keyed merge takes the later wording of a fact: a change, written.
    expect(r.staged.ops).toEqual([fileOp('character', { name: 'Фрол', likes: ['Море'] })]);
    expectFoldAgrees(r);
  });

  test('a later item that only repeats an earlier one of this pass adds nothing to the delta', () => {
    const r = run(seed, [], [item(0, 'item', { name: 'Ключ', condition: 'good' }), item(1, 'item', { name: 'Ключ', condition: 'good' })]);
    expect(r.staged.unchanged).toEqual([1]);
    expect(r.staged.planned).toEqual([{ type: 'item', name: 'Ключ', change: 'created', key: null, items: [0] }]);
  });

  test('a name that is no name is invalid, as the fold says', () => {
    const r = stageFiling([item(0, 'item', { name: '!!!' })], foldWith(seed, []), { classic: seed.classic });
    expect(r.skipped).toEqual([{ path: 'filings[0]', why: 'invalid_name: "!!!" is not a name' }]);
  });

  test('when one delta would land elsewhere, the row keeps one op per item (and the fold agrees with the prediction)', () => {
    // Item 1 creates Мира; item 2 names her with the alias «Уля», which the library's Ульяна also has.
    // As one delta {Мира, aka Уля} the fold would merge it into Ульяна (Мира does not exist yet).
    const r = run(seed, [], [item(0, 'character', { name: 'Мира', role: 'protagonist' }), item(1, 'character', { name: 'Мира', aliases: ['Уля'], likes: ['огни'] })]);
    expect(r.staged.ops).toEqual([
      fileOp('character', { name: 'Мира', role: 'protagonist' }),
      fileOp('character', { name: 'Мира', aliases: ['Уля'], likes: ['огни'] }),
    ]);
    expect(r.staged.planned.map((p) => [p.change, p.key, p.items])).toEqual([
      ['created', null, [0]],
      ['merged', null, [1]],
    ]);
    expect(entry(r.after, 'character:мира')).toMatchObject({ aliases: ['Уля'], data: { name: 'Мира', role: 'protagonist', aliases: ['Уля'], likes: ['огни'] } });
    expect(entry(r.after, 'lib:lantern:e1').origin).toMatchObject({ overlay: false });
    expectFoldAgrees(r);
  });

  test('a classic name of another book, a session note of that name: only the book’s untyped entry conflicts', () => {
    const books = seedOf(source('misc', 'Misc', [classicLore('m1', 'Old Mill'), typedLore('m2', 'location', { name: 'New Mill' })]));
    const rows: MemEntry[] = [{ t: 'mem', seq: 1, ts: 'x', key: null, on: null, by: 'user', ops: [{ op: 'note', title: 'Pond', keys: ['Pond'], content: 'A note.' }] }];
    const r = run(books, rows, [item(0, 'location', { name: 'Old Mill' }), item(1, 'location', { name: 'Pond' })]);
    expect(r.staged.skipped.map((s) => s.path)).toEqual(['filings[0]']);
    expect(r.staged.planned.map((p) => p.name)).toEqual(['Pond']);
    expectFoldAgrees(r);
  });

  test('the demo’s answers F1 and F4 stage as the M5b demo expects', () => {
    const view = foldWith(seed, []);
    const f1 = readFilingAnswer(
      '{"filings":[{"type":"character","entry":{"name":"Фрол","aliases":["лодочник"],"description":"Старый лодочник Вельмара.","role":"ally","current_state":{"status":"alive","location":"гавань Вельмара"}}},{"type":"location","entry":{"name":"маяк","connected_to":["гавань Вельмара"]}}]}',
      { allow: DEFAULT_FILING_ALLOW, profile: 'lite' },
    );
    if (!f1.ok) throw new Error(f1.why);
    const s1 = stageFiling(f1.items, view, { classic: seed.classic });
    expect(s1.planned.map((p) => [p.change, p.key, p.name])).toEqual([
      ['created', null, 'Фрол'],
      ['merged', 'lib:lantern:e2', 'Серый маяк'],
    ]);
    const f4 = readFilingAnswer(
      '{"filings":[{"type":"character","entry":{"name":"Смотрительница","current_state":{"status":"alive"},"memories":[{"what_happened":"Люди в масках сняли фонарь","changed_belief":"суд не даст зажечь маяк миром"},{"what_happened":"Пряталась под парусом в башне"}]}}]}',
      { allow: DEFAULT_FILING_ALLOW, profile: 'lite' },
    );
    if (!f4.ok) throw new Error(f4.why);
    expect(f4.skipped.map((s) => s.path)).toEqual(['filings[0].entry.memories[1]']);
    const s4 = stageFiling(f4.items, view, { classic: seed.classic });
    expect(s4.planned).toEqual([{ type: 'character', name: 'Ульяна', change: 'merged', key: 'lib:lantern:e1', items: [0] }]);
  });
});
