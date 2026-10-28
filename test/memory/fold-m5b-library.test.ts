// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Library [Arc] overviews in the Compendium (.notes/m5b-decisions.md D-177, G-9, C-9): an enabled entry
// with meta.arc of a readable book is seeded as an arc entry with a library origin and leaves the lore
// sources; 'off' books and a disabled Compendium keep it plain lore, as in M5a.
import { describe, expect, test } from 'bun:test';
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { isCompendiumEntry, isLibraryArc, librarySeed, routeBooks } from '../../src/agents/compendium/library.ts';
import { isNote } from '../../src/agents/compendium/notes.ts';
import { entryRefs } from '../../src/agents/compendium/refs.ts';
import { select } from '../../src/agents/compendium/select.ts';
import { EMPTY_SEED } from '../../src/agents/compendium/types.ts';
import type { LoreEntry } from '../../src/formats/native.ts';
import type { CompendiumConfig, MemOp } from '../../src/session/entries.ts';
import { NO_PATH, row } from './fixtures.ts';
import { classic, lantern, source, typed } from './kit.ts';

const ON: CompendiumConfig = { enabled: true };
const arcEntry = (id: string, plot: unknown, content = `Обзор ${id}.`, extra: Partial<LoreEntry> = {}): LoreEntry =>
  ({ id, title: `[Arc] ${String(plot)}`, content, keys: [], constant: true, position: 'after', meta: { arc: plot }, ...extra }) as LoreEntry;

describe('isLibraryArc', () => {
  test('meta.arc names a plot (letters or digits) and the entry has a text; typed or not', () => {
    expect(isLibraryArc(arcEntry('a', 'Украденный свет'))).toBe(true);
    expect(isLibraryArc(arcEntry('a', ' 1812 '))).toBe(true);
    // A typed entry with meta.arc: the arc wins (it was neither typed nor classic in M5a either).
    const typedArc = typed('p', 'plot', { name: 'Свет' }, { meta: { type: 'plot', data: { name: 'Свет' }, arc: 'Свет' } });
    expect([isLibraryArc(typedArc), isCompendiumEntry(typedArc)]).toEqual([true, false]);
    // A blank plot or a blank text stays plain lore.
    expect([arcEntry('a', '  '), arcEntry('a', '!!'), arcEntry('a', 'Свет', '  '), arcEntry('a', 'Свет', '')].map(isLibraryArc)).toEqual([false, false, false, false]);
    expect(isLibraryArc(classic('k', 'Песня'))).toBe(false);
    expect(isLibraryArc(typed('t', 'character', { name: 'Мира' }))).toBe(false);
  });
});

describe('librarySeed: [Arc] overviews', () => {
  test('an arc entry: no type, the plot as name and arc, the text as content, no data or keys, a library origin', () => {
    const book = source('b', 'Книга', [arcEntry('x1', ' Украденный свет ', 'Маяк погас.', { keys: ['свет'], order: 40, meta: { arc: ' Украденный свет ', featured: true } })]);
    const [arc] = librarySeed([book], ON).entries;
    expect(arc).toEqual({
      key: 'lib:b:x1',
      type: null,
      name: 'Украденный свет',
      aliases: [],
      tagline: '',
      data: {},
      keys: [],
      content: 'Маяк погас.',
      arc: 'Украденный свет',
      featured: true,
      order: 40,
      origin: { kind: 'library', book: 'b', id: 'x1', overlay: false },
      prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
    });
    expect(isNote(arc!)).toBe(false);
    expect(librarySeed([source('b', 'Книга', [arcEntry('x2', 'Свет')])], ON).entries[0]).toMatchObject({ order: 100, content: 'Обзор x2.' });
    expect(librarySeed([source('b', 'Книга', [arcEntry('x2', 'Свет')])], ON).entries[0]).not.toHaveProperty('featured');
  });

  test('in book order among the typed entries; disabled, blank and repeated ones as typed entries are; never a classic name', () => {
    const book = source('b', 'Книга', [
      typed('t1', 'plot', { name: 'Свет', status: 'active' }),
      arcEntry('a1', 'Свет'),
      arcEntry('a2', 'Тьма', 'Обзор.', { enabled: false }),
      arcEntry('a3', '  '),
      typed('t2', 'character', { name: 'Мира' }),
      arcEntry('a1', 'Двойник'),
    ]);
    const seed = librarySeed([book], ON);
    expect(seed.entries.map((e) => [e.key, e.name])).toEqual([
      ['lib:b:t1', 'Свет'],
      ['lib:b:a1', 'Свет'],
      ['lib:b:t2', 'Мира'],
    ]);
    expect([...seed.classic]).toEqual([]);
  });

  test("an 'off' book, an '@' book and a disabled Compendium seed no arc and route nothing", () => {
    const card = source('@card', 'Card', [arcEntry('c', 'Карта')]);
    const sources = [card, lantern()];
    expect(librarySeed(sources, { enabled: true, books: { lantern: 'off' } })).toBe(EMPTY_SEED);
    expect(librarySeed(sources, { enabled: false })).toBe(EMPTY_SEED);
    expect(routeBooks(sources, { enabled: true, books: { lantern: 'off' } })).toBe(sources);
    expect(routeBooks(sources, { enabled: false })).toBe(sources);
    expect(librarySeed(sources, ON).entries.map((e) => e.key)).toEqual(['lib:lantern:e1', 'lib:lantern:e2', 'lib:lantern:e3', 'lib:lantern:k2']);
  });
});

describe('routeBooks: [Arc] overviews leave the lore', () => {
  test('seeded arcs (and disabled ones) are routed out; a blank one stays; a book of arcs only is routed too', () => {
    const book = source('b', 'Книга', [classic('k', 'Песня'), arcEntry('a1', 'Свет'), arcEntry('a2', 'Тьма', 'Обзор.', { enabled: false }), arcEntry('a3', '  ')]);
    expect(routeBooks([book], ON)[0]!.book.entries.map((e) => e.id)).toEqual(['k', 'a3']);
    expect(routeBooks([source('arcs', 'Только арки', [arcEntry('a', 'Свет')])], ON)[0]!.book.entries).toEqual([]);
  });
});

describe('the fold over a library arc', () => {
  const seed = librarySeed([lantern()], ON);
  const fold = (ops: MemOp[][]) => foldCompendium(ops.map((o, i) => row(i + 1, o)), { pathSet: NO_PATH, library: seed });

  test('a handle in its book place; an edit of its overview makes it an overlay; retire and restore', () => {
    const v = fold([]);
    expect(entryRefs(v).map((r) => `${r.ref} ${r.entry.key}`)).toEqual(['C1 lib:lantern:e1', 'C2 lib:lantern:e2', 'C3 lib:lantern:e3', 'C4 lib:lantern:k2']);
    expect(v.entries.get('lib:lantern:k2')).toMatchObject({ type: null, arc: 'Украденный свет', content: 'About [Arc] Украденный свет.' });
    const edited = fold([[{ op: 'edit', ref: 'lib:lantern:k2', set: { content: 'Свет вернули.' } }], [{ op: 'retire', ref: 'C4', reason: 'конец' }]]);
    expect(edited.entries.get('lib:lantern:k2')).toMatchObject({ content: 'Свет вернули.', retired: { reason: 'конец' }, origin: { overlay: true }, prov: { lastSeq: 2 } });
    expect(edited.issues).toEqual([]);
    // Its plot name cannot change, as for a session arc.
    expect(fold([[{ op: 'edit', ref: 'lib:lantern:k2', set: { name: 'Другое' } }]]).issues).toEqual([{ seq: 1, op: 0, why: 'invalid', key: 'lib:lantern:k2' }]);
    // The seed itself is never changed.
    expect(seed.entries[3]!.content).toBe('About [Arc] Украденный свет.');
  });

  test('an arc op on the same plot writes a session arc beside it (the book\'s stays as it is)', () => {
    const v = fold([[{ op: 'arc', plot: 'Украденный свет', overview: 'Свет украли снова.' }]]);
    expect([...v.entries.keys()].slice(3)).toEqual(['lib:lantern:k2', 'arc:украденный свет']);
    expect(v.entries.get('lib:lantern:k2')!.content).toBe('About [Arc] Украденный свет.');
  });

  test('never a selector candidate: its plot name picks the plot', () => {
    const v = fold([]);
    const refs = new Map(entryRefs(v).map((r) => [r.entry.key, r.ref]));
    const picks = select({ entries: [...v.entries.values()], refOf: (k) => refs.get(k)!, uText: 'Кто украл свет? Украденный свет!', windowTexts: [], castNames: [] });
    expect(picks.map((p) => p.key)).toEqual(['lib:lantern:e3']);
  });
});
