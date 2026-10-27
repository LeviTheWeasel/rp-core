// Ported from Bunraku:src/core/compendium/filing.test.ts@702d8120 (staging and identity cases: an alias
// files into the canonical entry, items rejected alone, two items for one new entity, findMatch).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/apply.ts, M5a: the file, arc and edit ops over typed, library and arc entries
// (D-144…D-147), pinned file ops (D-168), entryNames / findMatch, issues and effects.
import { describe, expect, test } from 'bun:test';
import { entryNames, findMatch, foldCompendium, LARGE_ENTRY_CHARS, type FoldOptions } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import { isNote } from '../../src/agents/compendium/notes.ts';
import type { CEntry, CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { file, filing, hist, NO_PATH, note, row } from './fixtures.ts';
import { lantern, source, typed } from './kit.ts';

const SEED = librarySeed([lantern()], { enabled: true });
const PATH = ['g0000001', 'u0000001', 'a0000001', 'u0000002', 'a0000002'];
const fold = (rows: MemEntry[], opts: Partial<FoldOptions> = {}): CompendiumView =>
  foldCompendium(rows, { pathSet: new Set(PATH), path: PATH, library: SEED, ...opts });
const bare = (rows: MemEntry[]): CompendiumView => foldCompendium(rows, { pathSet: NO_PATH });
const get = (v: CompendiumView, key: string): CEntry => {
  const e = v.entries.get(key);
  if (!e) throw new Error(`no entry ${key}: ${[...v.entries.keys()].join(', ')}`);
  return e;
};
const sessionKeys = (v: CompendiumView): string[] => [...v.entries.keys()].filter((k) => !k.startsWith('lib:'));
const why = (v: CompendiumView) => v.issues.map((i) => [i.seq, i.op, i.why, i.key]);
const edit = (ref: string, more: Record<string, unknown>): MemOp => ({ op: 'edit', ref, ...more }) as MemOp;

describe('file: create', () => {
  test('a new typed entry: key, name, aliases, tagline, cleaned data, provenance, effect', () => {
    const v = fold([
      filing(4, 'a0000001', [
        file('character', {
          name: ' Мира ',
          aliases: ['Фонарщица', 'мира', ' Фонарщица ', ''],
          description: 'Ученица фонарщиков. Носит латунный фонарь.',
          role: '',
          traits: ['смелая', 'Смелая', '  '],
          relationships: [{ with: 'Ульяна', nature: 'mentor', notes: null }],
        }),
      ]),
    ]);
    expect(sessionKeys(v)).toEqual(['character:мира']);
    expect(get(v, 'character:мира')).toEqual({
      key: 'character:мира',
      type: 'character',
      name: 'Мира',
      aliases: ['Фонарщица'],
      tagline: 'Ученица фонарщиков.',
      data: {
        name: ' Мира ',
        // Keyed by normKey: the later wording of a key wins, blanks are dropped.
        aliases: [' Фонарщица ', 'мира'],
        description: 'Ученица фонарщиков. Носит латунный фонарь.',
        traits: ['Смелая'],
        relationships: [{ with: 'Ульяна', nature: 'mentor' }],
      },
      keys: [],
      origin: { kind: 'session' },
      prov: {
        created: 'a0000001',
        lastSeq: 4,
        appended: { aliases: ['a0000001', 'a0000001'], traits: ['a0000001'], relationships: ['a0000001'] },
        createdSeq: 4,
      },
    });
    expect(v.effects).toEqual([{ seq: 4, op: 0, key: 'character:мира', change: 'created' }]);
    expect(v.issues).toEqual([]);
  });

  test('a human row creates with created null and null provenance', () => {
    const e = get(fold([row(2, [file('item', { name: 'Латунный фонарь', abilities: ['Светит'] })])]), 'item:латунный фонарь');
    expect(e.prov).toEqual({ created: null, lastSeq: 2, appended: { abilities: [null] }, createdSeq: 2 });
  });

  test('worldbuilding is named by its topic; a summary is never matched', () => {
    const v = fold([row(1, [file('worldbuilding', { topic: 'Право огня', category: 'закон', description: 'Огонь принадлежит гильдии.' })])]);
    expect(get(v, 'worldbuilding:право огня').name).toBe('Право огня');
  });

  test('missing_required, unknown_type, invalid; nothing is written', () => {
    const ops = [
      file('worldbuilding', { topic: 'Приливы' }),
      file('character', {}),
      file('character', { name: '   ', description: 'x' }),
      file('dragon', { name: 'Туманник' }),
      { op: 'file', type: 5, data: {} },
      file('character', ['Мира'] as never),
      file('character', { name: '!!!' }),
      file('character', { name: 7 }),
    ] as MemOp[];
    const v = fold([row(3, ops)]);
    expect(why(v)).toEqual([
      [3, 0, 'missing_required', undefined],
      [3, 1, 'missing_required', undefined],
      [3, 2, 'missing_required', undefined],
      [3, 3, 'unknown_type', undefined],
      [3, 4, 'unknown_type', undefined],
      [3, 5, 'invalid', undefined],
      [3, 6, 'invalid', undefined],
      [3, 7, 'invalid', undefined],
    ]);
    expect(sessionKeys(v)).toEqual([]);
    expect(v.effects).toEqual([]);
  });

  test("another type's entry of the same name is not a match; a retired one is not either ('#2')", () => {
    const v = fold([
      row(1, [file('character', { name: 'Мира' }), file('location', { name: 'Мира' })]),
      row(2, [{ op: 'retire', ref: 'character:мира', reason: 'ушла' }]),
      row(3, [file('character', { name: 'Мира', description: 'Другая.' })]),
    ]);
    expect(sessionKeys(v)).toEqual(['character:мира', 'location:мира', 'character:мира#2']);
    expect(get(v, 'character:мира#2').data.description).toBe('Другая.');
  });
});

describe('file: merge', () => {
  test('by name or alias into the session entry: the canonical name is kept, aliases unite, lastSeq moves', () => {
    const v = fold([
      row(1, [file('character', { name: 'Мира', aliases: ['Фонарщица'], traits: ['смелая'] })]),
      filing(5, 'a0000002', [file('character', { name: 'Фонарщица', aliases: ['Мирочка'], traits: ['упрямая'], tier: 'B' })]),
    ]);
    expect(sessionKeys(v)).toEqual(['character:мира']);
    const e = get(v, 'character:мира');
    expect(e.name).toBe('Мира');
    expect(e.data).toEqual({ name: 'Мира', aliases: ['Фонарщица', 'Мирочка'], traits: ['смелая', 'упрямая'], tier: 'B' });
    expect(e.aliases).toEqual(['Фонарщица', 'Мирочка']);
    expect(e.prov).toEqual({ created: null, lastSeq: 5, appended: { aliases: [null, 'a0000002'], traits: [null, 'a0000002'] }, createdSeq: 1 });
    expect(v.effects.map((x) => [x.seq, x.change])).toEqual([
      [1, 'created'],
      [5, 'merged'],
    ]);
  });

  test('a merge that changes nothing is recorded but does not move lastSeq', () => {
    const v = fold([row(1, [file('character', { name: 'Мира', traits: ['смелая'] })]), row(2, [file('character', { name: 'мира', traits: ['смелая'], role: ' ' })])]);
    expect(get(v, 'character:мира').prov.lastSeq).toBe(1);
    expect(v.effects.map((x) => x.change)).toEqual(['created', 'merged']);
  });

  test('two ops for one new entity in one row create, then merge (Bunraku filing.test)', () => {
    const v = fold([row(1, [file('character', { name: 'Вера', tier: 'B' }), file('character', { name: 'Вера', memories: ['m'] })])]);
    expect(sessionKeys(v)).toEqual(['character:вера']);
    expect(get(v, 'character:вера').data).toEqual({ name: 'Вера', tier: 'B', memories: ['m'] });
  });

  test('a library match becomes an overlay under the same key; the book is untouched', () => {
    const before = structuredClone(SEED.entries);
    const v = fold([filing(6, 'a0000002', [file('character', { name: 'Уля', relationships: [{ with: 'Мира', nature: 'ally', status: 'strained' }, { with: 'Кай', nature: 'rival' }] })])]);
    expect(sessionKeys(v)).toEqual([]);
    const e = get(v, 'lib:lantern:e1');
    expect(e.origin).toEqual({ kind: 'library', book: 'lantern', id: 'e1', overlay: true });
    expect(e.name).toBe('Ульяна');
    expect(e.data.relationships).toEqual([
      { with: 'Мира', nature: 'ally', status: 'strained' },
      { with: 'Кай', nature: 'rival' },
    ]);
    expect(e.prov).toEqual({ created: null, lastSeq: 6, appended: { relationships: ['a0000002', 'a0000002'] }, createdSeq: 0 });
    expect(SEED.entries).toEqual(before);
    // A second fold starts from the book again.
    expect(get(fold([]), 'lib:lantern:e1').origin).toEqual({ kind: 'library', book: 'lantern', id: 'e1', overlay: false });
  });

  test('session entries are searched before library ones', () => {
    const v = fold([
      row(1, [{ op: 'retire', ref: 'lib:lantern:e1', reason: 'x' }]),
      row(2, [file('character', { name: 'Ульяна', tier: 'S' })]),
      row(3, [{ op: 'restore', ref: 'lib:lantern:e1' }]),
      row(4, [file('character', { name: 'Ульяна', tier: 'A' })]),
    ]);
    expect(get(v, 'character:ульяна').data.tier).toBe('A');
    expect(get(v, 'lib:lantern:e1').data.tier).toBeUndefined();
  });

  test('an entry whose data had no identity takes the filed one; its old name stays an alias', () => {
    const seed = librarySeed(
      [{ key: 'b', book: { name: 'B', entries: [{ id: 'x1', title: 'Мира', content: '', keys: [], position: 'after', meta: { type: 'character', data: { tier: 'C' }, aliases: ['Фонарщица'] } }] } }],
      { enabled: true },
    );
    const v = foldCompendium([row(1, [file('character', { name: 'Фонарщица', tier: 'B' })])], { pathSet: NO_PATH, library: seed });
    const e = get(v, 'lib:b:x1');
    expect(e.name).toBe('Фонарщица');
    expect(e.aliases).toEqual(['Мира']);
    expect(e.data).toEqual({ tier: 'B', name: 'Фонарщица' });
  });

  test("classic_conflict: a readable book's untyped entry owns the name; a note never does", () => {
    const v = fold([row(1, [file('location', { name: 'Песня фонарщиков' }), file('item', { name: 'x', aliases: ['песня фонарщиков!'] })])]);
    expect(why(v)).toEqual([
      [1, 0, 'classic_conflict', 'lib:lantern:k1'],
      [1, 1, 'classic_conflict', 'lib:lantern:k1'],
    ]);
    expect(sessionKeys(v)).toEqual([]);
    const notes = fold([row(1, [note('Мира')]), row(2, [file('character', { name: 'Мира' })])]);
    expect(sessionKeys(notes)).toEqual(['note:мира', 'character:мира']);
    // An [Arc] overview of a book is not a classic name.
    expect(why(fold([row(1, [file('event', { name: '[Arc] Украденный свет' })])]))).toEqual([]);
  });

  test('data nested 20 000 levels deep folds (the merge stops recursing past MERGE_MAX_DEPTH)', () => {
    const nest = (leaf: string): unknown => {
      let v: unknown = leaf;
      for (let i = 0; i < 20_000; i++) v = { a: v };
      return v;
    };
    const v = fold([row(1, [file('character', { name: 'Глубина', deep: nest('x') })]), row(2, [file('character', { name: 'Глубина', deep: nest('x') })]), row(3, [file('character', { name: 'Глубина', deep: nest('y') })])]);
    expect(v.effects.map((x) => [x.seq, x.change])).toEqual([
      [1, 'created'],
      [2, 'merged'],
      [3, 'merged'],
    ]);
    // The same deep value again changed nothing (lastSeq stays); a different one replaced it.
    expect(get(v, 'character:глубина').prov.lastSeq).toBe(3);
    expect(fold([row(1, [file('character', { name: 'Глубина', deep: nest('x') })]), row(2, [file('character', { name: 'Глубина', deep: nest('x') })])]).entries.get('character:глубина')?.prov.lastSeq).toBe(1);
    expect(why(v).map((w) => w[2])).toEqual(['large_entry']);
  });

  test('large_entry: once per key, at the last op that changed it', () => {
    const big = 'x'.repeat(LARGE_ENTRY_CHARS);
    const v = fold([row(1, [file('character', { name: 'Мира', description: big })]), row(2, [file('character', { name: 'Мира', tier: 'A' }), note('Тихо')])]);
    expect(why(v)).toEqual([[2, 0, 'large_entry', 'character:мира']]);
    expect(get(v, 'character:мира').data.tier).toBe('A');
    expect(why(fold([row(1, [file('character', { name: 'Мира', description: 'x'.repeat(LARGE_ENTRY_CHARS - 100) })])]))).toEqual([]);
  });
});

describe('summaries (D-144.2)', () => {
  test("never merge; keyed by the range end and the index among the row's summaries", () => {
    const s = (title: string) => file('summary', { title, summary: `${title}: что было.` });
    const v = fold([hist(7, 'u0000001', 'a0000002', [s('Фонарь погас'), file('plot', { name: 'Украденный свет', status: 'escalating' }), s('Фонарь погас')])]);
    expect(sessionKeys(v)).toEqual(['summary:a0000002.0', 'summary:a0000002.1']);
    const e = get(v, 'summary:a0000002.1');
    expect(e).toMatchObject({ type: 'summary', name: 'Фонарь погас', range: ['u0000001', 'a0000002'], tagline: 'Фонарь погас: что было.' });
    expect(e.prov.created).toBe('a0000002');
    // The plot merged into the library's.
    expect(get(v, 'lib:lantern:e3').data.status).toBe('escalating');
  });

  test('a row without a range: summary:user:<title> (D-168); a taken key gets #2; required fields', () => {
    const v = fold([
      row(3, [file('summary', { title: 'Итог', summary: 'Всё.' })]),
      hist(5, 'u0000001', 'a0000001', [file('summary', { title: 'A', summary: 'a' })]),
      hist(6, 'g0000001', 'a0000001', [file('summary', { title: 'B', summary: 'b' }), file('summary', { title: 'C' })]),
      row(7, [file('summary', { title: ' ИТОГ! ', summary: 'Ещё раз.' }), file('summary', { title: 'Итог', summary: 'И снова.' })]),
    ]);
    expect(sessionKeys(v)).toEqual(['summary:user:итог', 'summary:a0000001.0', 'summary:a0000001.0#2', 'summary:user:итог#2', 'summary:user:итог#3']);
    expect(get(v, 'summary:user:итог').range).toBeUndefined();
    expect(get(v, 'summary:user:итог#2')).toMatchObject({ name: 'ИТОГ!', data: { summary: 'Ещё раз.' } });
    expect(why(v)).toEqual([[6, 1, 'missing_required', undefined]]);
  });

  test('a user summary keeps its key whatever seq its row has (a fork renumbers seq)', () => {
    const rows = (a: number, b: number, c: number) => [
      row(a, [file('summary', { title: 'Встреча', summary: 'Они встретились.' })]),
      row(b, [file('summary', { title: 'Ссора', summary: 'Они поссорились.' })]),
      row(c, [{ op: 'retire', ref: 'summary:user:встреча', reason: '' }, edit('summary:user:ссора', { set: { summary: 'Они помирились.' } })]),
    ];
    for (const v of [fold(rows(6, 9, 12)), fold(rows(3, 4, 5))]) {
      expect(sessionKeys(v)).toEqual(['summary:user:встреча', 'summary:user:ссора']);
      expect(get(v, 'summary:user:встреча').retired).toEqual({ reason: '' });
      expect(get(v, 'summary:user:ссора').retired).toBeUndefined();
      expect(get(v, 'summary:user:ссора').data.summary).toBe('Они помирились.');
      expect(v.issues).toEqual([]);
    }
  });
});

describe('pinned file ops (D-168)', () => {
  const pin = (type: string, data: Record<string, unknown>, target: string): MemOp => ({ op: 'file', type, data, target }) as MemOp;
  /** The user's own rows, written while no book was attached: their verbs pinned the keys. */
  const own = [
    row(2, [pin('character', { name: 'Мира', role: 'ally' }, 'character:мира')]),
    row(3, [edit('character:мира', { set: { role: 'antagonist' } })]),
    row(4, [pin('location', { name: 'Песня фонарщиков' }, 'location:песня фонарщиков')]),
    row(5, [edit('location:песня фонарщиков', { set: { type: 'building' } })]),
    row(6, [pin('character', { name: 'Ульяна', tier: 'S' }, 'character:ульяна')]),
  ];

  test('attaching a book never re-homes them: no name match, no classic_conflict, their edits apply', () => {
    // The lantern book has a typed «Ульяна» (e1) and a classic «Песня фонарщиков» (k1).
    const v = fold(own);
    expect(sessionKeys(v)).toEqual(['character:мира', 'location:песня фонарщиков', 'character:ульяна']);
    expect(v.issues).toEqual([]);
    expect(get(v, 'character:мира').data.role).toBe('antagonist');
    expect(get(v, 'location:песня фонарщиков').data).toEqual({ name: 'Песня фонарщиков', type: 'building' });
    expect(get(v, 'character:ульяна').data.tier).toBe('S');
    expect(get(v, 'lib:lantern:e1').origin).toMatchObject({ overlay: false });
    expect(v.effects.map((x) => [x.seq, x.key, x.change])).toEqual([
      [2, 'character:мира', 'created'],
      [3, 'character:мира', 'edited'],
      [4, 'location:песня фонарщиков', 'created'],
      [5, 'location:песня фонарщиков', 'edited'],
      [6, 'character:ульяна', 'created'],
    ]);
    // The same rows unpinned are name-addressed (agent rows, M5b): they re-home and conflict.
    const loose = fold(own.map((r) => row(r.seq, r.ops.map((o) => (o.op === 'file' ? file(o.type, o.data) : o)))));
    expect(why(loose).map((w) => w[2])).toEqual(['classic_conflict', 'not_found']);
    expect(get(loose, 'lib:lantern:e1').data.tier).toBe('S');
  });

  test('an existing entry with the key (retired too, library too) takes the merge and keeps its own name', () => {
    const v = fold([
      ...own.slice(0, 1),
      row(7, [{ op: 'retire', ref: 'character:мира', reason: 'ушла' }]),
      row(8, [pin('character', { name: 'Мирослава', tier: 'B' }, 'character:мира')]),
      row(9, [pin('character', { name: 'Уля', tier: 'A' }, 'lib:lantern:e1')]),
    ]);
    expect(sessionKeys(v)).toEqual(['character:мира']);
    expect(get(v, 'character:мира')).toMatchObject({ name: 'Мира', retired: { reason: 'ушла' }, data: { name: 'Мира', role: 'ally', tier: 'B' } });
    expect(get(v, 'lib:lantern:e1')).toMatchObject({ name: 'Ульяна', origin: { overlay: true }, data: { tier: 'A' } });
    expect(v.effects.filter((x) => x.seq >= 8).map((x) => [x.seq, x.key, x.change])).toEqual([
      [8, 'character:мира', 'merged'],
      [9, 'lib:lantern:e1', 'merged'],
    ]);
  });

  test('a missing lib: key is library_entry_missing; a session key held by another type is allocated from it', () => {
    const v = fold([
      row(2, [pin('character', { name: 'Ульяна' }, 'lib:lantern:e9'), pin('character', { name: 'Ульяна' }, 'lib:lantern:e2')]),
      row(3, [note('Маяк')]),
      row(4, [pin('location', { name: 'Маяк' }, 'note:маяк')]),
      row(5, [pin('character', { role: 'ally' }, 'character:кай'), pin('character', { name: '!!' }, 'character:кай'), pin('character', { name: 'Кай' }, ''), pin('character', { name: 'Кай' }, 5 as never)]),
    ]);
    expect(why(v)).toEqual([
      [2, 0, 'library_entry_missing', 'lib:lantern:e9'],
      [2, 1, 'library_entry_missing', 'lib:lantern:e2'],
      [5, 0, 'missing_required', undefined],
      [5, 1, 'invalid', undefined],
      [5, 2, 'invalid', undefined],
      [5, 3, 'invalid', undefined],
    ]);
    expect(sessionKeys(v)).toEqual(['note:маяк', 'note:маяк#2']);
    expect(get(v, 'note:маяк#2')).toMatchObject({ type: 'location', name: 'Маяк' });
  });

  test('a book replaced under the same id: a pinned lib: row whose names the entry no longer answers to is library_entry_missing (ruling I)', () => {
    const before = librarySeed([source('lantern', 'Фонарщики', [typed('e1', 'character', { name: 'Мира', likes: ['тёплый свет'] })])], { enabled: true });
    const after = librarySeed(
      [
        source('lantern', 'Фонарщики', [
          typed('e1', 'character', { name: 'Арсений Кеттер', description: 'Механик.' }),
          typed('e9', 'character', { name: 'Мира', likes: ['тёплый свет', 'тишина порта'] }),
        ]),
      ],
      { enabled: true },
    );
    // The new e1's data has no name: the entry is named by its LoreEntry title (the review's variant A2).
    const untitled = librarySeed([source('lantern', 'Фонарщики', [typed('e1', 'character', { description: 'Механик.' }, { title: 'Арсений Кеттер' })])], { enabled: true });
    const filed = [row(2, [pin('character', { name: 'Мира', likes: ['чай с мятой'], description: 'Мира боится темноты.' }, 'lib:lantern:e1')])];
    // Written against the old book: e1 was Мира.
    const was = fold(filed, { library: before });
    expect(was.issues).toEqual([]);
    expect(get(was, 'lib:lantern:e1')).toMatchObject({ name: 'Мира', origin: { overlay: true }, data: { likes: ['тёплый свет', 'чай с мятой'], description: 'Мира боится темноты.' } });
    for (const seed of [after, untitled]) {
      const v = fold(filed, { library: seed });
      expect(why(v)).toEqual([[2, 0, 'library_entry_missing', 'lib:lantern:e1']]);
      expect(v.effects).toEqual([]);
      const e1 = get(v, 'lib:lantern:e1');
      expect(e1).toMatchObject({ name: 'Арсений Кеттер', aliases: [], origin: { overlay: false } });
      expect(e1.data).toBe(seed.entries[0]!.data);
    }
    expect(get(fold(filed, { library: after }), 'lib:lantern:e9').data).toEqual({ name: 'Мира', likes: ['тёплый свет', 'тишина порта'] });
    // The same op by name (what the verb's dry run does now) finds Мира at e9.
    const byName = fold([row(2, [file('character', { name: 'Мира', likes: ['чай с мятой'] })])], { library: after });
    expect(byName.effects.map((x) => [x.key, x.change])).toEqual([['lib:lantern:e9', 'merged']]);
    // An op with no name answers to nothing.
    expect(why(fold([row(2, [pin('character', { likes: ['чай'] }, 'lib:lantern:e1')])], { library: before }))).toEqual([[2, 0, 'library_entry_missing', 'lib:lantern:e1']]);
  });

  test('a pinned lib: row still lands by any name the entry answers to: the book\'s, an alias or a name the session gave it, a former name, a topic', () => {
    const seed = librarySeed(
      [source('lantern', 'Фонарщики', [typed('e1', 'character', { name: 'Ульяна', aliases: ['Уля'] }), typed('w1', 'worldbuilding', { topic: 'Маяки', description: 'Огни мыса.' })])],
      { enabled: true },
    );
    const v = fold(
      [
        row(2, [pin('character', { name: 'уля', tier: 'A' }, 'lib:lantern:e1')]),
        row(3, [edit('lib:lantern:e1', { set: { name: 'Ульяна Петровна' } })]),
        row(4, [pin('character', { name: 'Ульяна Петровна', role: 'ally' }, 'lib:lantern:e1')]),
        row(5, [pin('character', { name: 'Ульяна', likes: ['маяк'] }, 'lib:lantern:e1')]),
        row(6, [edit('lib:lantern:e1', { set: { aliases: ['Смотрительница'] } })]),
        row(7, [pin('character', { name: 'Смотрительница', fears: ['шторм'] }, 'lib:lantern:e1')]),
        row(8, [pin('character', { name: 'Кто-то', aliases: ['Ульяна Петровна'], goals: ['свет'] }, 'lib:lantern:e1')]),
        row(9, [pin('worldbuilding', { topic: 'маяки', details: 'Их двенадцать.' }, 'lib:lantern:w1')]),
        row(10, [pin('worldbuilding', { topic: 'Порт', details: 'x' }, 'lib:lantern:w1')]),
      ],
      { library: seed },
    );
    expect(why(v)).toEqual([[10, 0, 'library_entry_missing', 'lib:lantern:w1']]);
    expect(v.effects.filter((x) => x.change === 'merged').map((x) => x.seq)).toEqual([2, 4, 5, 7, 8, 9]);
    expect(get(v, 'lib:lantern:e1').data).toMatchObject({ tier: 'A', role: 'ally', likes: ['маяк'], fears: ['шторм'], goals: ['свет'] });
    expect(get(v, 'lib:lantern:w1').data).toEqual({ topic: 'Маяки', description: 'Огни мыса.', details: 'Их двенадцать.' });
  });

  test('a pinned summary creates exactly its key; the dry run and the written row fold the same', () => {
    const unpinned = fold([row(3, [file('summary', { title: 'Итог', summary: 'a' })]), row(4, [file('summary', { title: 'Итог', summary: 'b' })])]);
    const pinned = fold([row(3, [file('summary', { title: 'Итог', summary: 'a' })]), row(4, [pin('summary', { title: 'Итог', summary: 'b' }, 'summary:user:итог#2')])]);
    expect(sessionKeys(pinned)).toEqual(sessionKeys(unpinned));
    expect(get(pinned, 'summary:user:итог#2')).toEqual(get(unpinned, 'summary:user:итог#2'));
    expect(pinned.effects).toEqual(unpinned.effects);
  });
});

describe('arc (D-145)', () => {
  test('creates the missing plot first, then the overview; a second arc replaces it', () => {
    const v = fold([hist(4, 'u0000001', 'a0000001', [{ op: 'arc', plot: 'Тихий сезон', overview: 'Начало.' }]), row(6, [{ op: 'arc', plot: 'тихий  СЕЗОН', overview: 'Конец.' }])]);
    expect(sessionKeys(v)).toEqual(['plot:тихий сезон', 'arc:тихий сезон']);
    expect(get(v, 'plot:тихий сезон')).toMatchObject({ type: 'plot', name: 'Тихий сезон', data: { name: 'Тихий сезон', status: 'active' } });
    const arc = get(v, 'arc:тихий сезон');
    expect(arc).toMatchObject({ type: null, name: 'Тихий сезон', arc: 'Тихий сезон', content: 'Конец.', data: {}, keys: [], origin: { kind: 'session' } });
    expect(arc.prov).toMatchObject({ created: 'a0000001', lastSeq: 6, createdSeq: 4 });
    expect(isNote(arc)).toBe(false);
    expect(v.effects.map((x) => [x.seq, x.key, x.change])).toEqual([
      [4, 'plot:тихий сезон', 'created'],
      [4, 'arc:тихий сезон', 'arc'],
      [6, 'arc:тихий сезон', 'arc'],
    ]);
  });

  test("a live plot of that name (the book's too) is reused; blank plot or overview is invalid", () => {
    const v = fold([row(1, [{ op: 'arc', plot: 'Украденный свет', overview: 'Свет украден.' }])]);
    expect(sessionKeys(v)).toEqual(['arc:украденный свет']);
    const bad = fold([row(1, [{ op: 'arc', plot: ' ', overview: 'x' }, { op: 'arc', plot: 'P', overview: '' }, { op: 'arc', plot: '!!', overview: 'x' }] as MemOp[])]);
    expect(why(bad).map((w) => w[2])).toEqual(['invalid', 'invalid', 'invalid']);
  });

  test("a classic name owns the plot: no plot, a classic_conflict naming the plot's would-be key, the arc still applies", () => {
    const v = fold([row(1, [file('plot', { name: 'Другое' })]), row(2, [{ op: 'arc', plot: 'Песня фонарщиков!', overview: 'Они поют.' }])]);
    expect(sessionKeys(v)).toEqual(['plot:другое', 'arc:песня фонарщиков']);
    expect(get(v, 'arc:песня фонарщиков')).toMatchObject({ arc: 'Песня фонарщиков!', content: 'Они поют.' });
    expect(why(v)).toEqual([[2, 0, 'classic_conflict', 'plot:песня фонарщиков']]);
    expect(v.effects.map((x) => [x.seq, x.key, x.change])).toEqual([
      [1, 'plot:другое', 'created'],
      [2, 'arc:песня фонарщиков', 'arc'],
    ]);
    // The would-be key skips a taken one (a retired plot's too) and takes nothing.
    const w = fold([
      row(1, [{ op: 'file', type: 'plot', data: { name: 'Песня фонарщиков' }, target: 'plot:песня фонарщиков' }]),
      row(2, [{ op: 'retire', ref: 'plot:песня фонарщиков', reason: '' }]),
      row(3, [{ op: 'arc', plot: 'Песня фонарщиков', overview: 'a' }]),
      row(4, [{ op: 'file', type: 'plot', data: { name: 'П' }, target: 'plot:песня фонарщиков#2' }]),
    ]);
    expect(why(w)).toEqual([[3, 0, 'classic_conflict', 'plot:песня фонарщиков#2']]);
    expect(sessionKeys(w)).toEqual(['plot:песня фонарщиков', 'arc:песня фонарщиков', 'plot:песня фонарщиков#2']);
  });

  test('edit an arc: content or overview replaces the text; its name and text cannot be removed', () => {
    const base = [row(1, [{ op: 'arc', plot: 'Тихий сезон', overview: 'Начало.' }] as MemOp[])];
    expect(get(fold([...base, row(2, [edit('arc:тихий сезон', { set: { overview: 'Середина.' } })])]), 'arc:тихий сезон').content).toBe('Середина.');
    expect(get(fold([...base, row(2, [edit('arc:тихий сезон', { set: { content: 'Финал.' } })])]), 'arc:тихий сезон').content).toBe('Финал.');
    const v = fold([
      ...base,
      row(2, [
        edit('arc:тихий сезон', { set: { title: 'Другое' } }),
        edit('arc:тихий сезон', { set: { name: 'Другое' } }),
        edit('arc:тихий сезон', { unset: ['content'] }),
        edit('arc:тихий сезон', { set: { content: '  ' } }),
      ]),
    ]);
    expect(why(v).map((w) => w[2])).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
  });
});

describe('edit (D-146)', () => {
  const mira = row(1, [file('character', { name: 'Мира', aliases: ['Фонарщица'], current_state: { status: 'alive', location: 'маяк' }, traits: ['смелая'] })]);

  test('set replaces top-level fields whole, unset deletes; array provenance becomes null', () => {
    const v = fold([filing(2, 'a0000001', [file('character', { name: 'Мира', traits: ['упрямая'] })]), mira, row(3, [edit('character:мира', { set: { current_state: { status: 'missing' }, traits: ['тихая'] }, unset: ['aliases'] })])].sort((a, b) => a.seq - b.seq));
    const e = get(v, 'character:мира');
    expect(e.data).toEqual({ name: 'Мира', current_state: { status: 'missing' }, traits: ['тихая'] });
    expect(e.aliases).toEqual([]);
    expect(e.prov.appended).toEqual({ traits: [null] });
    expect(e.prov.lastSeq).toBe(3);
    expect(v.effects.at(-1)).toEqual({ seq: 3, op: 0, key: 'character:мира', change: 'edited' });
  });

  test('rename: the key stays, the old name goes to formerNames, findMatch still finds it', () => {
    const v = fold([mira, row(2, [edit('character:мира', { set: { name: 'Мира Ванс' } })]), row(3, [file('character', { name: 'Мира', tier: 'A' })])]);
    expect(sessionKeys(v)).toEqual(['character:мира']);
    const e = get(v, 'character:мира');
    expect(e.name).toBe('Мира Ванс');
    expect(e.prov.formerNames).toEqual(['Мира']);
    expect(e.data).toMatchObject({ name: 'Мира Ванс', tier: 'A' });
    expect(entryNames(e)).toEqual(['мира ванс', 'фонарщица', 'мира']);
    expect(findMatch(v.entries.values(), 'character', ['МИРА'])?.key).toBe('character:мира');
    // Renaming back does not list the current name as a former one.
    const back = get(fold([mira, row(2, [edit('character:мира', { set: { name: 'Мира Ванс' } })]), row(3, [edit('character:мира', { set: { name: 'мира' } })])]), 'character:мира');
    expect(back.prov.formerNames).toEqual(['Мира Ванс']);
  });

  test('set.aliases replaces the list; a rename onto an alias drops it from the aliases', () => {
    expect(get(fold([mira, row(2, [edit('character:мира', { set: { aliases: ['Мирочка', 'мира', 'Мирочка'] } })])]), 'character:мира').aliases).toEqual(['Мирочка']);
    expect(get(fold([mira, row(2, [edit('character:мира', { set: { name: 'Фонарщица' } })])]), 'character:мира').aliases).toEqual([]);
  });

  test('the identity field cannot be unset or blanked; bad aliases are invalid; skipped whole', () => {
    const v = fold([
      mira,
      row(2, [
        edit('character:мира', { unset: ['name'], set: { tier: 'A' } }),
        edit('character:мира', { set: { name: '  ', tier: 'A' } }),
        edit('character:мира', { set: { aliases: 'Мирочка' } }),
        edit('character:мира', { keys: 'мира' }),
      ]),
    ]);
    expect(why(v).map((w) => [w[2], w[3]])).toEqual([
      ['invalid', 'character:мира'],
      ['invalid', 'character:мира'],
      ['invalid', 'character:мира'],
      ['invalid', 'character:мира'],
    ]);
    expect(get(v, 'character:мира').data.tier).toBeUndefined();
  });

  test('keys and featured on a typed entry; a summary renames by its title', () => {
    const v = fold([mira, row(2, [edit('character:мира', { keys: ['фонарь'], featured: true })]), row(3, [file('summary', { title: 'Итог', summary: 'x' })]), row(4, [edit('summary:user:итог', { set: { title: 'Итог главы' } })])]);
    expect(get(v, 'character:мира')).toMatchObject({ keys: ['фонарь'], featured: true });
    expect(get(v, 'summary:user:итог')).toMatchObject({ name: 'Итог главы', prov: { formerNames: ['Итог'] } });
  });

  test('a library entry edited becomes an overlay; the tagline follows the description', () => {
    const v = fold([row(2, [edit('lib:lantern:e1', { set: { current_state: { status: 'missing' }, description: 'Пропала. Маяк пуст.' } })])]);
    const e = get(v, 'lib:lantern:e1');
    expect(e.origin).toMatchObject({ overlay: true });
    expect(e.data.current_state).toEqual({ status: 'missing' });
    expect(e.tagline).toBe('Пропала.');
    expect(SEED.entries[0]!.data.current_state).toBeUndefined();
  });

  test('a hand-written ref: C<n> or a name resolves; a key-shaped ref is looked up only', () => {
    // The seed holds C1..C3; Мира is C4.
    const v = fold([mira, row(2, [edit('C4', { set: { tier: 'A' } }), edit('фонарщица', { set: { age: '19' } }), edit('с1', { set: { tier: 'S' } }), edit('character:нет', { set: {} }), edit('Нет такой', { set: {} })])]);
    expect(get(v, 'character:мира').data).toMatchObject({ tier: 'A', age: '19' });
    expect(get(v, 'lib:lantern:e1').data.tier).toBe('S');
    expect(why(v)).toEqual([
      [2, 3, 'not_found', undefined],
      [2, 4, 'not_found', undefined],
    ]);
  });
});

describe('retire and restore any entry', () => {
  test('typed, library (an overlay), arc; a name prefers live for retire and retired for restore', () => {
    const v = fold([
      row(1, [file('character', { name: 'Мира' }), { op: 'arc', plot: 'Украденный свет', overview: 'x' }] as MemOp[]),
      row(2, [
        { op: 'retire', ref: 'character:мира', reason: 'ушла' },
        { op: 'retire', ref: 'Уля', reason: 'умерла' },
        { op: 'retire', ref: 'arc:украденный свет', reason: '' },
      ]),
      row(3, [file('character', { name: 'Мира' })]),
      row(4, [{ op: 'restore', ref: 'мира' }]),
    ]);
    expect(get(v, 'character:мира').retired).toBeUndefined();
    expect(get(v, 'character:мира#2').retired).toBeUndefined();
    expect(get(v, 'lib:lantern:e1')).toMatchObject({ retired: { reason: 'умерла' }, origin: { overlay: true } });
    expect(get(v, 'arc:украденный свет').retired).toEqual({ reason: '' });
    expect(v.effects.filter((x) => x.seq >= 2).map((x) => [x.key, x.change])).toEqual([
      ['character:мира', 'retired'],
      ['lib:lantern:e1', 'retired'],
      ['arc:украденный свет', 'retired'],
      ['character:мира#2', 'created'],
      ['character:мира', 'restored'],
    ]);
    // A retired library entry is not a match: filing its name makes a session entry.
    expect(sessionKeys(fold([row(1, [{ op: 'retire', ref: 'lib:lantern:e1', reason: '' }]), row(2, [file('character', { name: 'Ульяна' })])]))).toEqual(['character:ульяна']);
  });
});

describe('a vanished library base (D-147)', () => {
  test('overlay rows by ref are skipped with library_entry_missing; a file by name creates a session entry', () => {
    const rows = [
      row(1, [edit('lib:lantern:e1', { set: { tier: 'A' } }), { op: 'retire', ref: 'lib:lantern:e1', reason: '' }, { op: 'restore', ref: 'lib:lantern:e9' }]),
      row(2, [file('character', { name: 'Ульяна', tier: 'B' })]),
    ];
    const v = fold(rows, { library: undefined });
    expect(why(v)).toEqual([
      [1, 0, 'library_entry_missing', 'lib:lantern:e1'],
      [1, 1, 'library_entry_missing', 'lib:lantern:e1'],
      [1, 2, 'library_entry_missing', 'lib:lantern:e9'],
    ]);
    expect([...v.entries.keys()]).toEqual(['character:ульяна']);
    // With the book back, the same rows apply as an overlay (retired, so the file makes a session entry).
    const back = fold(rows);
    expect(get(back, 'lib:lantern:e1')).toMatchObject({ data: { tier: 'A' }, retired: { reason: '' }, origin: { overlay: true } });
    expect(sessionKeys(back)).toEqual(['character:ульяна']);
  });
});

describe('rows, keys and tasks (D-143)', () => {
  test('refile: only the newest row of a key applies; older ones are superseded', () => {
    const v = fold([filing(3, 'a0000001', [file('character', { name: 'Мира', tier: 'C' })]), filing(8, 'a0000001', [file('character', { name: 'Кай' })])]);
    expect(sessionKeys(v)).toEqual(['character:кай']);
    expect(v.tasks.get('file:a0000001')).toEqual({ seq: 8, status: 'applied', range: ['a0000001', 'a0000001'] });
    expect(v.lastSeq).toBe(8);
  });

  test('revert closes the key; its other ops apply; a newer row with the key opens it again', () => {
    const filed = filing(3, 'a0000001', [file('character', { name: 'Мира' })]);
    const revert = row(5, [{ op: 'revert', key: 'file:a0000001' }, note('Почему')], { on: 'a0000001' });
    const v = fold([filed, revert]);
    expect(sessionKeys(v)).toEqual(['note:почему']);
    expect(v.tasks.get('file:a0000001')).toEqual({ seq: 5, status: 'reverted', range: ['a0000001', 'a0000001'] });
    expect(v.issues).toEqual([]);
    expect(v.effects).toEqual([{ seq: 5, op: 1, key: 'note:почему', change: 'note' }]);
    const again = fold([filed, revert, filing(9, 'a0000001', [file('character', { name: 'Мира', tier: 'A' })])]);
    expect(sessionKeys(again)).toEqual(['note:почему', 'character:мира']);
    expect(again.tasks.get('file:a0000001')).toMatchObject({ seq: 9, status: 'applied' });
    // An older revert does not close a newer row; a revert bound to an off-path message counts for nothing.
    expect(sessionKeys(fold([row(2, [{ op: 'revert', key: 'file:a0000001' }]), filed]))).toEqual(['character:мира']);
    expect(sessionKeys(fold([filed, row(5, [{ op: 'revert', key: 'file:a0000001' }], { on: 'a000001b' })]))).toEqual(['character:мира']);
  });

  test('a malformed revert is invalid; a revert of a key never filed is reported as reverted', () => {
    const v = fold([row(2, [{ op: 'revert' } as never, { op: 'revert', key: 'hist:x-y' }])]);
    expect(why(v)).toEqual([[2, 0, 'invalid', undefined]]);
    expect(v.tasks.get('hist:x-y')).toEqual({ seq: 2, status: 'reverted' });
  });

  test('out-of-order historian rows apply by name: a catch-up row merges into entries filed later', () => {
    const v = fold([
      filing(3, 'a0000002', [file('character', { name: 'Мира', tier: 'C' })], ['u0000002', 'a0000002']),
      hist(9, 'g0000001', 'a0000001', [file('character', { name: 'Мира', memories: [{ what_happened: 'Нашла фонарь', changed_belief: 'Свет можно унести.' }] }), file('summary', { title: 'Начало', summary: 'Мира нашла фонарь.' })]),
    ]);
    expect(sessionKeys(v)).toEqual(['character:мира', 'summary:a0000001.0']);
    expect(get(v, 'character:мира').data).toMatchObject({ tier: 'C', memories: [{ what_happened: 'Нашла фонарь' }] });
    expect(get(v, 'character:мира').prov.appended.memories).toEqual(['a0000001']);
    expect([...v.tasks.keys()]).toEqual(['file:a0000002', 'hist:g0000001-a0000001']);
  });

  test('staleness: a range message touched after the row drops the row; human rows never go stale', () => {
    const rows = [filing(5, 'a0000001', [file('character', { name: 'Мира' })], ['u0000001', 'a0000001']), row(6, [note('Своё')], { on: 'a0000001' })];
    const keys = (touched: Record<string, number>, opts: Partial<FoldOptions> = {}) => sessionKeys(fold(rows, { touched: new Map(Object.entries(touched)), ...opts }));
    expect(keys({})).toEqual(['character:мира', 'note:свое']);
    expect(keys({ u0000001: 4, a0000001: 5 })).toEqual(['character:мира', 'note:свое']);
    expect(keys({ u0000001: 7 })).toEqual(['note:свое']);
    expect(keys({ a0000001: 6 })).toEqual(['note:свое']);
    // Outside the range: still fresh.
    expect(keys({ u0000002: 9, g0000001: 9 })).toEqual(['character:мира', 'note:свое']);
    // Without the path, staleness is not checked.
    expect(keys({ a0000001: 6 }, { path: undefined })).toEqual(['character:мира', 'note:свое']);
    const v = fold(rows, { touched: new Map([['a0000001', 6]]) });
    expect(v.tasks.get('file:a0000001')).toEqual({ seq: 5, status: 'stale', range: ['u0000001', 'a0000001'] });
    expect(v.lastSeq).toBe(6);
  });

  test('a range that cannot be checked is stale; a row without a range never is', () => {
    const mk = (range: unknown, on = 'a0000001') => row(5, [file('character', { name: 'Мира' })], { key: 'file:x', on, by: 'filing', range: range as [string, string] });
    expect(sessionKeys(fold([mk(['u0000001', 'a000001b'])]))).toEqual([]);
    expect(sessionKeys(fold([mk(['a0000001', 'u0000001'])]))).toEqual([]);
    expect(sessionKeys(fold([mk(['a0000001'])]))).toEqual([]);
    expect(sessionKeys(fold([mk(undefined)]))).toEqual(['character:мира']);
    // A stale row's newer sibling key still applies; the stale one does not block an older fresh row.
    const older = filing(3, 'a0000001', [file('character', { name: 'Кай' })], ['u0000001', 'a0000001']);
    const newer = filing(7, 'a0000001', [file('character', { name: 'Мира' })], ['u0000001', 'a0000001']);
    const v = fold([older, newer], { touched: new Map([['a0000001', 5]]) });
    expect(sessionKeys(v)).toEqual(['character:мира']);
    const w = fold([older, newer], { touched: new Map([['a0000001', 8]]) });
    expect(sessionKeys(w)).toEqual([]);
    expect(w.tasks.get('file:a0000001')).toMatchObject({ seq: 7, status: 'stale' });
  });

  test('rev hashes the applied rows and the seed', () => {
    const rows = [row(1, [file('character', { name: 'Мира' })])];
    expect(fold([]).rev).toMatch(/^[0-9a-f]{16}$/);
    expect(bare([]).rev).toBe('');
    expect(fold(rows).rev).not.toBe(bare(rows).rev);
    expect(fold(rows).rev).not.toBe(fold([]).rev);
    const other = librarySeed([{ key: 'lantern', book: { name: 'Фонарщики', entries: [] } }], { enabled: true });
    expect(fold([], { library: other }).rev).not.toBe(fold([]).rev);
    // A stale row does not count.
    const stale = filing(5, 'a0000001', [file('character', { name: 'Кай' })]);
    expect(fold([...rows, stale], { touched: new Map([['a0000001', 9]]) }).rev).toBe(fold(rows).rev);
  });
});

describe('findMatch and entryNames', () => {
  const v = fold([row(1, [file('character', { name: 'Мира', aliases: ['Фонарщица'] }), file('worldbuilding', { topic: 'Право огня', category: 'закон', description: 'x', title: 'Закон огня' })])]);
  test('names: name, data.title, data.topic, aliases, former names; normalized and deduplicated', () => {
    expect(entryNames(get(v, 'character:мира'))).toEqual(['мира', 'фонарщица']);
    expect(entryNames(get(v, 'worldbuilding:право огня'))).toEqual(['право огня', 'закон огня']);
  });

  test('live entries of the type; any name form; blank names never match', () => {
    expect(findMatch(v.entries.values(), 'character', ['ФОНАРЩИЦА!'])?.key).toBe('character:мира');
    expect(findMatch(v.entries.values(), 'character', ['маяк'])).toBeNull();
    expect(findMatch(v.entries.values(), 'location', ['маяк'])?.key).toBe('lib:lantern:e2');
    expect(findMatch(v.entries.values(), 'worldbuilding', ['закон огня'])?.key).toBe('worldbuilding:право огня');
    expect(findMatch(v.entries.values(), 'character', ['', '!!'])).toBeNull();
    expect(findMatch(v.entries.values(), 'location', ['мира'])).toBeNull();
  });

  test('the fold and findMatch agree, session before library', () => {
    const both = fold([row(1, [{ op: 'retire', ref: 'lib:lantern:e1', reason: '' }]), row(2, [file('character', { name: 'Уля' })]), row(3, [{ op: 'restore', ref: 'lib:lantern:e1' }])]);
    expect(findMatch(both.entries.values(), 'character', ['уля'])?.key).toBe('character:уля');
  });
});

describe('the view', () => {
  test('never aliases the rows or the seed', () => {
    const data = { name: 'Мира', traits: ['смелая'] };
    const rows = [row(1, [file('character', data)])];
    const v = fold(rows);
    const e = get(v, 'character:мира');
    expect(e.data).not.toBe(data);
    expect(e.data.traits).not.toBe(data.traits);
    get(v, 'lib:lantern:e1').aliases.push('x');
    expect(SEED.entries[0]!.aliases).toEqual(['Уля']);
  });

  test('the M3 notes fold is unchanged without a seed', () => {
    const v = bare([row(1, [note('Брат')]), row(2, [note('Брат')])]);
    expect([...v.entries.keys()]).toEqual(['note:брат', 'note:брат#2']);
    expect(v.effects.map((x) => x.change)).toEqual(['note', 'note']);
    expect(v.tasks.size).toBe(0);
  });
});
