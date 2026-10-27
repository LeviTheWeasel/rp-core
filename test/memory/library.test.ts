// agents/compendium/library.ts: the library seed (D-141) and routing typed entries out of lore (D-142).
import { describe, expect, test } from 'bun:test';
import { bookAccess, isCompendiumEntry, librarySeed, routeBooks } from '../../src/agents/compendium/library.ts';
import { select } from '../../src/agents/compendium/select.ts';
import { EMPTY_SEED } from '../../src/agents/compendium/types.ts';
import type { CompendiumConfig } from '../../src/session/entries.ts';
import { classic, lantern, source, typed } from './kit.ts';

const ON: CompendiumConfig = { enabled: true };

/** Every kind of entry a book can hold. */
function mixed() {
  return source('mixed', 'Смесь', [
    typed('t1', 'character', { name: 'Мира' }),
    classic('c1', 'Песня'),
    classic('a1', '[Arc] Свет', { meta: { arc: 'Свет' } }),
    typed('a2', 'plot', { name: 'Свет' }, { meta: { type: 'plot', data: { name: 'Свет' }, arc: 'Свет' } }),
    typed('u1', 'dragon', { name: 'Туманник' }),
    typed('d1', 'character', { name: 'Призрак' }, { enabled: false }),
    classic('d2', 'Старая пристань', { enabled: false }),
    classic('n1', '  '),
    { id: 'n2', content: 'no title', keys: [], position: 'after' },
  ]);
}

describe('isCompendiumEntry and bookAccess', () => {
  test('one of the eleven types and not an [Arc] overview', () => {
    const [t1, c1, a1, a2, u1, d1] = mixed().book.entries;
    expect([t1, c1, a1, a2, u1, d1].map((e) => isCompendiumEntry(e!))).toEqual([true, false, false, false, false, true]);
  });

  test('a typed entry needs meta.data with a filled field; without one it stays plain lore (its text is all it has)', () => {
    const withData = (data: unknown) => isCompendiumEntry({ id: 'x', title: 'Мира', content: 'Мира — фонарщица.', keys: [], position: 'after', meta: { type: 'character', data: data as never } });
    expect([undefined, 'Мира', ['Мира'], {}, { name: '  ', role: null, traits: [], physical: {} }].map(withData)).toEqual([false, false, false, false, false]);
    expect([{ name: 'Мира' }, { tier: 3 }, { tameable: false }, { traits: ['смелая'] }, { physical: { hair: 'red' } }].map(withData)).toEqual([true, true, true, true, true]);
  });

  test('blank is checked at every depth (section I): lists of blank strings and objects of blank values are blank', () => {
    const withData = (data: unknown) => isCompendiumEntry({ id: 'x', title: 'Мира', content: 'Мира — фонарщица.', keys: [], position: 'after', meta: { type: 'character', data: data as never } });
    const blank = [{ traits: ['  ', ''] }, { physical: { hair: ' ' } }, { name: '', relationships: [{ with: ' ', notes: null }], physical: { eyes: [[]] } }];
    expect(blank.map(withData)).toEqual([false, false, false]);
    const filled = [{ traits: ['  ', 'смелая'] }, { physical: { hair: ' ', eyes: 'серые' } }, { relationships: [{ with: ' ', trust: 0 }] }, { flags: [[false]] }];
    expect(filled.map(withData)).toEqual([true, true, true, true]);
    // Deep data is walked without recursion: 2 000 levels of blank objects, then one value at the bottom.
    const nest = (leaf: unknown): unknown => JSON.parse(`${'{"d":'.repeat(2000)}${JSON.stringify(leaf)}${'}'.repeat(2000)}`);
    expect(withData(nest(' '))).toBe(false);
    expect(withData(nest('дно'))).toBe(true);
    // Through the seed: such an entry stays plain lore (its text is all it has).
    const book = source('b', 'B', [
      { id: 'b1', title: 'Пустая', content: 'Только текст.', keys: ['Пустая'], position: 'after', meta: { type: 'character', data: { name: ' ', traits: ['  ', ''], physical: { hair: ' ' } } } },
    ]);
    expect(librarySeed([book], ON).entries).toEqual([]);
    expect(routeBooks([book], ON)[0]!.book.entries.map((e) => e.id)).toEqual(['b1']);
  });

  test("'off' only when the config says so", () => {
    expect(bookAccess(ON, 'lantern')).toBe('read');
    expect(bookAccess({ enabled: true, books: { lantern: 'off' } }, 'lantern')).toBe('off');
    expect(bookAccess({ enabled: true, books: { lantern: 'read' } }, 'lantern')).toBe('read');
    expect(bookAccess({ enabled: true, books: {} }, 'constructor')).toBe('read');
  });
});

describe('librarySeed', () => {
  test('typed entries are seeded; untyped titled ones are classic; arcs, unknown types and disabled entries as below', () => {
    const seed = librarySeed([mixed()], ON);
    expect(seed.entries.map((e) => e.key)).toEqual(['lib:mixed:t1']);
    // An unknown type is plain lore, hence a classic name; an [Arc] is neither; disabled entries are neither.
    expect([...seed.classic]).toEqual([
      ['песня', 'lib:mixed:c1'],
      ['туманник', 'lib:mixed:u1'],
    ]);
    expect([...seed.books]).toEqual([['mixed', 'Смесь']]);
    expect(seed.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a seed entry: name fallbacks, aliases, tagline, keys, order, constant, featured, origin, prov', () => {
    const book = source('b', 'B', [
      typed('x1', 'character', { name: ' Мира ', description: 'Ученица. Смелая.', aliases: ['Фонарщица'] }, {
        keys: ['Мира', '/мир[аы]/i', ' ', 'фонарь'],
        order: 40,
        constant: true,
        meta: { type: 'character', data: { name: ' Мира ', description: 'Ученица. Смелая.', aliases: ['Фонарщица'] }, aliases: ['Мирочка', 'мира', 'Мирочка', 5 as never], featured: true },
      }),
      { id: 'x2', title: 'Право огня', content: '', keys: [], position: 'after', meta: { type: 'worldbuilding', data: { topic: 'Огонь', tagline: 'Закон.' } } },
      { id: 'x3', title: 'Заголовок', content: '', keys: [], position: 'after', meta: { type: 'event', data: { when: 'вчера' } } },
      { id: 'x4', content: '', keys: [], position: 'after', meta: { type: 'item', data: { condition: 'good' } } },
      { id: 'x5', title: 'Итог', content: '', keys: [], position: 'after', meta: { type: 'summary', data: { title: '  ', summary: 'Всё кончилось. Почти.' } } },
    ]);
    const [x1, x2, x3, x4, x5] = librarySeed([book], ON).entries;
    expect(x1).toEqual({
      key: 'lib:b:x1',
      type: 'character',
      name: 'Мира',
      // meta.aliases wins over data.aliases; strings only, deduplicated, the name left out.
      aliases: ['Мирочка'],
      tagline: 'Ученица.',
      data: { name: ' Мира ', description: 'Ученица. Смелая.', aliases: ['Фонарщица'] },
      keys: ['Мира', 'фонарь'],
      featured: true,
      order: 40,
      constant: true,
      origin: { kind: 'library', book: 'b', id: 'x1', overlay: false },
      prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
    });
    expect(x2).toMatchObject({ name: 'Огонь', tagline: 'Закон.', order: 100 });
    expect(x2!.featured).toBeUndefined();
    expect(x2!.constant).toBeUndefined();
    expect(x3).toMatchObject({ name: 'Заголовок', data: { when: 'вчера' } });
    expect(x4).toMatchObject({ name: 'x4', aliases: [] });
    expect(x5).toMatchObject({ name: 'Итог', tagline: 'Всё кончилось.' });
  });

  test("a seed entry keeps its non-blank secondary keys and a valid logic (section I); none → neither field", () => {
    const book = source('b', 'B', [
      typed('s1', 'character', { name: 'William Turner' }, { keys: ['Will'], secondary: ['Turner', ' ', '/smith/i'], logic: 'and_all', caseSensitive: true }),
      typed('s2', 'character', { name: 'Bill' }, { keys: ['Bill'], secondary: ['Turner'], logic: 'sometimes' as never }),
      typed('s3', 'character', { name: 'Ann' }, { keys: ['Ann'], secondary: ['  '], logic: 'not_any' }),
    ]);
    const [s1, s2, s3] = librarySeed([book], ON).entries;
    expect(s1).toMatchObject({ keys: ['Will'], secondary: ['Turner', '/smith/i'], logic: 'and_all' });
    expect(s1).not.toHaveProperty('caseSensitive');
    // An unknown logic is left out: the selector reads it as and_any, as the lore engine does.
    expect(s2).toMatchObject({ secondary: ['Turner'] });
    expect(s2).not.toHaveProperty('logic');
    expect(s3).not.toHaveProperty('secondary');
    expect(s3).not.toHaveProperty('logic');
  });

  test('the seed carries the guard to the selector: a common-word key with secondary keys fires only with them', () => {
    const book = source('port', 'Port', [
      typed('w', 'character', { name: 'William Turner' }, { keys: ['Will'], secondary: ['Turner', 'blacksmith'], logic: 'and_any', caseSensitive: true }),
    ]);
    const entries = librarySeed([book], ON).entries;
    const picks = (uText: string) => select({ entries, refOf: () => 'C1', uText, windowTexts: [], castNames: [] }).map((p) => p.key);
    expect(picks('I will wait by the docks until dawn.')).toEqual([]);
    expect(picks('Will, the blacksmith, is late.')).toEqual(['lib:port:w']);
  });

  test('typed entries without data are plain lore: not seeded, classic by title, not routed', () => {
    const book = source('b', 'B', [
      { id: 'x3', title: 'Заголовок', content: 'Событие.', keys: [], position: 'after', meta: { type: 'event', data: 'not an object' as never } },
      { id: 'x4', content: 'Вещь.', keys: [], position: 'after', meta: { type: 'item' } },
      { id: 'x6', title: 'Пустой', content: 'Только текст.', keys: [], position: 'after', meta: { type: 'character', data: { name: ' ', aliases: [] } } },
      typed('x7', 'character', { name: 'Мира' }),
    ]);
    const seed = librarySeed([book], ON);
    expect(seed.entries.map((e) => e.key)).toEqual(['lib:b:x7']);
    expect([...seed.classic]).toEqual([
      ['заголовок', 'lib:b:x3'],
      ['пустой', 'lib:b:x6'],
    ]);
    expect(routeBooks([book], ON)[0]!.book.entries.map((e) => e.id)).toEqual(['x3', 'x4', 'x6']);
  });

  test("books in config order; '@' books never; 'off' books nothing; a repeated key keeps the first", () => {
    const card = source('@card', 'Card', [typed('c', 'character', { name: 'Карта' })]);
    const off = source('off', 'Off', [typed('o', 'character', { name: 'Выкл' }), classic('oc', 'Выкл лор')]);
    const dup = source('lantern', 'Again', [typed('e1', 'character', { name: 'Двойник' })]);
    const seed = librarySeed([card, lantern(), off, dup], { enabled: true, books: { off: 'off' } });
    expect(seed.entries.map((e) => [e.key, e.name])).toEqual([
      ['lib:lantern:e1', 'Ульяна'],
      ['lib:lantern:e2', 'Серый маяк'],
      ['lib:lantern:e3', 'Украденный свет'],
    ]);
    expect([...seed.books.keys()]).toEqual(['lantern']);
    expect(seed.classic.has('выкл лор')).toBe(false);
  });

  test('disabled Compendium or no readable book: EMPTY_SEED; the hash follows the books', () => {
    expect(librarySeed([lantern()], { enabled: false })).toBe(EMPTY_SEED);
    expect(librarySeed([lantern()], { enabled: true, books: { lantern: 'off' } })).toBe(EMPTY_SEED);
    expect(librarySeed([], ON)).toBe(EMPTY_SEED);
    const a = librarySeed([lantern()], ON).hash;
    expect(librarySeed([lantern()], ON).hash).toBe(a);
    const changed = lantern();
    changed.book.entries[3]!.content = 'Другая песня.';
    expect(librarySeed([changed], ON).hash).not.toBe(a);
    // A readable book without typed entries still counts (its classic names do).
    expect(librarySeed([source('plain', 'P', [classic('k', 'Песня')])], ON)).toMatchObject({ entries: [], books: new Map([['plain', 'P']]) });
  });
});

describe('routeBooks (D-142)', () => {
  test('typed entries (disabled ones too) leave readable books; arcs, classic and unknown types stay', () => {
    const routed = routeBooks([mixed()], ON);
    expect(routed[0]!.book.entries.map((e) => e.id)).toEqual(['c1', 'a1', 'a2', 'u1', 'd2', 'n1', 'n2']);
    expect(routed[0]!.book.name).toBe('Смесь');
    expect(routed[0]!.key).toBe('mixed');
  });

  test("'off' books, '@' books and a disabled Compendium keep everything; nothing removed → the same array", () => {
    const card = source('@card', 'Card', [typed('c', 'character', { name: 'Карта' })]);
    const plain = source('plain', 'P', [classic('k', 'Песня')]);
    const lan = lantern();
    const sources = [card, plain, lan];
    const off = routeBooks(sources, { enabled: true, books: { lantern: 'off' } });
    expect(off).toBe(sources);
    expect(routeBooks(sources, { enabled: false })).toBe(sources);
    const routed = routeBooks(sources, ON);
    expect(routed).not.toBe(sources);
    expect(routed[0]).toBe(card);
    expect(routed[1]).toBe(plain);
    expect(routed[2]!.book.entries.map((e) => e.id)).toEqual(['k1', 'k2']);
    // The input is not changed.
    expect(lan.book.entries).toHaveLength(5);
  });
});
