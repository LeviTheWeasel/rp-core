// Ported from Bunraku:src/core/director/compendium-snapshot.test.ts@702d8120 (every case, adapted).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Director's world snapshot (D-157): scene-first choice, the budget's caps, tensions, what is left
// out; then the rp-core changes: stems (Мира / Миру / Мирой), phrase names in any order (D-169), the
// recent window, tie order (higher library `order` first), field caps, the character budget with
// "(+N more not shown)", and a mirror rivalry printed once.
import { describe, expect, test } from 'bun:test';
import { WORLD_FULL, WORLD_LITE, type WorldBudget } from '../../src/agents/director/types.ts';
import type { CEntry, Rec } from '../../src/agents/compendium/types.ts';
import { WORLD_CLIP, worldSnapshot } from '../../src/agents/compendium/world.ts';
import { chat, lib, noteEntry, typed, type Line } from './kit.ts';

// Library entries with one lore `order`, so equal ranks fall to handle order: Bunraku's book order
// (its `order` was the position in the book; here `order` is the lore priority, higher first).
const person = (name: string, data: Rec = {}, more: Partial<CEntry> = {}): CEntry => lib('book', `c-${name}`, 'character', { name, ...data }, more);
const place = (name: string, data: Rec = {}, more: Partial<CEntry> = {}): CEntry => lib('book', `l-${name}`, 'location', { name, ...data }, more);

/** The snapshot of a view whose path is `recent` (user lines) and whose Compendium is `entries`. */
function snap(entries: readonly CEntry[], recent: readonly (string | Line)[] = [], castNames: string[] = [], budget: WorldBudget = WORLD_FULL): string {
  const lines: Line[] = recent.map((r) => (typeof r === 'string' ? { role: 'user', text: r } : r));
  return worldSnapshot(chat(lines, { entries, castNames }).view, budget);
}

const characterLines = (text: string): string[] => text.split('Unresolved Tensions:')[0]!.split('Key Locations:')[0]!.split('\n').filter((l) => l.startsWith('  - '));
const locationLines = (text: string): string[] => (text.split('Key Locations:')[1] ?? '').split('\n').filter((l) => l.startsWith('  - '));
const tensionLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('  Tension:'));

describe('the choice', () => {
  const many = Array.from({ length: 40 }, (_, i) => person(`Person ${String(i).padStart(2, '0')}`));

  test("characters are capped by the budget (15) and locations too (5); with nothing in the scene the featured entries come first, then book order", () => {
    const entries = [...many, person('Zed Featured', {}, { featured: true }), ...Array.from({ length: 9 }, (_, i) => place(`Place ${i}`))];
    const text = snap(entries);
    expect(characterLines(text)).toHaveLength(WORLD_FULL.characters);
    expect(text).toContain('  - Zed Featured');
    expect(text).toContain('  - Person 13');
    expect(text).not.toContain('Person 14');
    expect(locationLines(text)).toHaveLength(WORLD_FULL.locations);
    expect(text.startsWith('[COMPENDIUM CONTEXT]\nCharacters:\n  - Zed Featured\n  - Person 00\n')).toBe(true);
  });

  test('characters named in the recent messages, by the card or the persona, or an alias, beat book order; so do the people they are related to', () => {
    const entries = [...many, person('Valen Ash', { aliases: ['the Ash'], relationships: [{ with: 'Person 39', nature: 'ally' }] }), person('Mira')];
    const text = snap(entries, ['Everyone watched the Ash cross the courtyard.'], ['Mira']);
    const lines = characterLines(text);
    expect(lines.slice(0, 2).map((l) => l.slice(4, 13)).sort()).toEqual(['Mira', 'Valen Ash']);
    expect(lines[2]).toStartWith('  - Person 39');
    expect(text).toContain('Relationships: Person 39 (ally)');
    expect(text).not.toContain('Person 38');
  });

  test('locations the scene mentions, or where its characters are, come first', () => {
    const entries = [person('Mira', { current_state: { location: 'The Pier', status: 'wounded', condition: 'limping' } }), place('Aaa Hall'), place('The Pier', { description: 'Salt and rope.' }), place('The Lamp Room')];
    const text = snap(entries, ['Mira went up to the lamp room.']);
    expect(locationLines(text).map((l) => l.slice(4)).slice(0, 2).sort()).toEqual(['The Lamp Room', 'The Pier: Salt and rope.']);
    expect(text).toContain('Status: wounded. limping. At: The Pier');
  });

  test('the lite budget: 6 characters, 2 relationships each, 3 tensions, 2 locations', () => {
    const rels = [1, 2, 3].map((i) => ({ with: `Foe ${i}`, nature: 'enemy' }));
    const entries = [...Array.from({ length: 8 }, (_, i) => person(`Lite ${i}`, { relationships: rels })), ...Array.from({ length: 4 }, (_, i) => place(`Spot ${i}`))];
    const text = snap(entries, [], [], WORLD_LITE);
    expect(characterLines(text)).toHaveLength(6);
    expect(text).toContain('    Relationships: Foe 1 (enemy), Foe 2 (enemy)\n');
    expect(tensionLines(text)).toHaveLength(3);
    expect(locationLines(text)).toHaveLength(2);
    expect(text.length).toBeLessThanOrEqual(WORLD_LITE.chars);
  });
});

describe('what is left out and what is found', () => {
  test('retired and other-typed entries, notes, and disabled library entries (never seeded) are not in it; nothing typed gives nothing', () => {
    const entries = [person('Kept'), person('Retired', {}, { retired: { reason: 'dead' } }), lib('book', 'i', 'item', { name: 'Sword' }), noteEntry('Classic', 'Plain text.')];
    const text = snap(entries);
    expect(text).toContain('  - Kept');
    expect(['Retired', 'Sword', 'Classic'].some((n) => text.includes(n))).toBe(false);
    expect(snap([lib('book', 'i', 'item', { name: 'Sword' })])).toBe('');
    expect(snap([])).toBe('');
  });

  test('tensions come from strained, rival and enemy relationships, at most five, with the notes; a relationships field that is not a list is ignored', () => {
    const entries = [
      ...Array.from({ length: 7 }, (_, i) => person(`P${i}`, { relationships: [{ with: 'X', nature: 'rival', notes: i === 0 ? 'old grudge' : undefined }] })),
      person('Calm', { relationships: [{ with: 'Y', nature: 'friend', status: 'active' }] }),
      person('Odd', { relationships: 'various' }),
      person('Strained', { relationships: [{ with: 'Z', nature: 'kin', status: 'strained' }] }),
    ];
    const text = snap(entries);
    const tension = tensionLines(text);
    expect(tension).toHaveLength(WORLD_FULL.tensions);
    expect(tension[0]).toBe('  Tension: P0 / X: rival relationship (active): old grudge');
    expect(text).toContain('Relationships: Z (kin, strained)');
    expect(text).not.toContain('various');
  });

  test('the text is plain: no emoji and no em dash', () => {
    const text = snap([person('A', { relationships: [{ with: 'B', nature: 'enemy' }] })]);
    expect(/[—⚡↔]/.test(text)).toBe(false);
  });

  test('the whole section, as the Director prompt places it', () => {
    const entries = [person('Vera', { description: 'A ferrywoman.', role: 'ally', relationships: [{ with: 'Oz', nature: 'rival', status: 'strained', notes: 'debt' }] }), place('Ferry', { description: 'Old.' })];
    expect(snap(entries)).toBe(
      [
        '[COMPENDIUM CONTEXT]',
        'Characters:',
        '  - Vera: A ferrywoman. (ally)',
        '    Relationships: Oz (rival, strained)',
        '',
        'Unresolved Tensions:',
        '  Tension: Vera / Oz: rival relationship (strained): debt',
        '',
        'Key Locations:',
        '  - Ferry: Old.',
      ].join('\n'),
    );
  });
});

describe('rp-core changes (D-157)', () => {
  const crowd = Array.from({ length: 20 }, (_, i) => person(`Житель ${i}`));
  const mira = person('Мира', { aliases: ['Фонарщица'] });

  test.each(['Мира зажгла фонарь.', 'Он подошёл к Миру.', 'Все говорили с Мирой.', 'Фонарщицу видели у маяка.'])('a stem names Мира in «%s»', (line) => {
    expect(characterLines(snap([...crowd, mira], [line]))[0]).toBe('  - Мира');
  });

  test('a phrase name: every word in one message, in any order (D-169); with a stop word, a run (section I)', () => {
    const vance = person('Мира Ванс');
    expect(characterLines(snap([...crowd, vance], ['Ванс и Мира пришли.']))[0]).toBe('  - Мира Ванс');
    expect(characterLines(snap([...crowd, vance], ['Пришла Мира.']))[0]).toBe('  - Житель 0');
    // The words must meet in one message.
    expect(characterLines(snap([...crowd, vance], ['Пришла Мира.', 'Ванс ушёл.']))[0]).toBe('  - Житель 0');
    // «Дом на холме» holds a stop word: its words in a row, in order.
    const house = place('Дом на холме');
    const field = Array.from({ length: 6 }, (_, i) => place(`Поле ${i}`));
    expect(locationLines(snap([...field, house], ['Холм за домом.']))[0]).toBe('  - Поле 0');
    expect(locationLines(snap([...field, house], ['Мы у дома на холме.']))[0]).toBe('  - Дом на холме');
    // Both words of «Двор Сыча».
    const yard = place('Двор Сыча');
    expect(locationLines(snap([...field, yard], ['Сыч ушёл.']))[0]).toBe('  - Поле 0');
    expect(locationLines(snap([...field, yard], ['Во дворе ждал Сыч.']))[0]).toBe('  - Двор Сыча');
  });

  test('section I: a one-letter label or numeral binds to its word («Elizabeth I», «Wing A»)', () => {
    const courtiers = Array.from({ length: 14 }, (_, i) => person(`Courtier ${String(i).padStart(2, '0')}`));
    const first = person('Elizabeth I');
    const second = person('Elizabeth II');
    const lines = characterLines(snap([...courtiers, first, second], ['I bow before Elizabeth II.']));
    expect(lines[0]).toBe('  - Elizabeth II');
    expect(lines).not.toContain('  - Elizabeth I');
    expect(lines).toContain('  - Courtier 13');
    const wings = [...Array.from({ length: 5 }, (_, i) => place(`Yard ${i}`)), place('Wing A'), place('Wing B')];
    expect(locationLines(snap(wings, ['Take me to Wing B.']))).toEqual(['  - Wing B', '  - Yard 0', '  - Yard 1', '  - Yard 2', '  - Yard 3']);
  });

  test("section I: a library key is a run and its secondary keys must hold; a key in another message does not count", () => {
    const turner = person('William Turner', {}, { keys: ['Will', 'old smith'], secondary: ['Turner', 'blacksmith'] });
    expect(characterLines(snap([...crowd, turner], ['I will wait by the docks.']))[0]).toBe('  - Житель 0');
    expect(characterLines(snap([...crowd, turner], ['The smith was old.']))[0]).toBe('  - Житель 0');
    expect(characterLines(snap([...crowd, turner], ['Will the blacksmith came.']))[0]).toBe('  - William Turner');
    expect(characterLines(snap([...crowd, turner], ['I will wait.', 'Turner left.']))[0]).toBe('  - Житель 0');
  });

  test('the card or persona name puts a character in the scene; so does a library key', () => {
    expect(characterLines(snap([...crowd, mira], [], ['мира']))[0]).toBe('  - Мира');
    const keeper = person('Ганс', {}, { keys: ['старый смотритель'] });
    expect(characterLines(snap([...crowd, keeper], ['Пришёл старый смотритель.']))[0]).toBe('  - Ганс');
  });

  test('only the last six visible messages count; hidden ones never', () => {
    const quiet = (n: number): Line[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: 'Тишина.' }));
    expect(characterLines(snap([...crowd, mira], [{ role: 'user', text: 'Мира здесь.' }, ...quiet(5)]))[0]).toBe('  - Мира');
    expect(characterLines(snap([...crowd, mira], [{ role: 'user', text: 'Мира здесь.' }, ...quiet(6)]))[0]).toBe('  - Житель 0');
    expect(characterLines(snap([...crowd, mira], [{ role: 'user', text: 'Мира здесь.', hidden: true }, ...quiet(2)]))[0]).toBe('  - Житель 0');
    // A hidden message does not take a place among the six.
    expect(characterLines(snap([...crowd, mira], [{ role: 'user', text: 'Мира здесь.' }, ...quiet(5), { role: 'user', text: 'x', hidden: true }]))[0]).toBe('  - Мира');
  });

  test('equal ranks: library entries by higher order first (no order = 100), then book order; then session entries newest first', () => {
    const s1 = typed('character:a', 'character', { name: 'Session Old' }, { prov: { created: null, lastSeq: 3, appended: {}, createdSeq: 3 } });
    const s2 = typed('character:b', 'character', { name: 'Session New' }, { prov: { created: null, lastSeq: 9, appended: {}, createdSeq: 4 } });
    const low = lib('book', 'low', 'character', { name: 'Library Low' }, { order: 10 });
    const plain = lib('book', 'plain', 'character', { name: 'Library Plain' });
    const high = lib('book', 'high', 'character', { name: 'Library High' }, { order: 150 });
    const same = lib('book', 'same', 'character', { name: 'Library Same' }, { order: 150 });
    expect(characterLines(snap([low, plain, high, same, s1, s2])).map((l) => l.slice(4))).toEqual([
      'Library High',
      'Library Same',
      'Library Plain',
      'Library Low',
      'Session New',
      'Session Old',
    ]);
  });

  test('the cap keeps the higher-order library characters, as the lore engine and search_lore rank them (review prompt#5)', () => {
    // An imported book: the important entries carry order 200, the rest ST's default 100.
    const extras = Array.from({ length: 6 }, (_, i) => person(`Extra ${i}`, {}, { order: 100 }));
    const heroes = [person('Hero One', {}, { order: 200 }), person('Hero Two', {}, { order: 200 })];
    const lines = characterLines(snap([...extras, ...heroes], ['Тишина.'], [], WORLD_LITE)).map((l) => l.slice(4));
    expect(lines).toEqual(['Hero One', 'Hero Two', 'Extra 0', 'Extra 1', 'Extra 2', 'Extra 3']);
    // Locations share the tie.
    const spots = [place('Low Spot', {}, { order: 1 }), place('Mid Spot'), place('Top Spot', {}, { order: 300 })];
    expect(locationLines(snap(spots, [], [], WORLD_LITE)).map((l) => l.slice(4))).toEqual(['Top Spot', 'Mid Spot']);
  });

  test('fields are cut: description 200, role 60, state 120, a tension note 100, a place 160', () => {
    const long = (n: number): string => Array.from({ length: n }, (_, i) => `слово${i}`).join(' ');
    const entries = [
      person('Мира', {
        description: long(60),
        role: long(20),
        current_state: { status: 'wounded', condition: long(40) },
        relationships: [{ with: 'Села', nature: 'rival', notes: long(30) }],
      }),
      place('Маяк', { description: long(50) }),
    ];
    const text = snap(entries);
    const line = characterLines(text)[0]!;
    const [desc, rest] = line.slice('  - Мира: '.length).split(' (');
    expect(Array.from(desc!).length).toBeLessThanOrEqual(WORLD_CLIP.description);
    expect(desc!.endsWith('…')).toBe(true);
    const [role, state] = rest!.split('). ');
    expect(Array.from(role!).length).toBeLessThanOrEqual(WORLD_CLIP.role);
    expect(Array.from(state!).length).toBeLessThanOrEqual(WORLD_CLIP.state);
    expect(state!.startsWith('Status: wounded. слово0')).toBe(true);
    const note = tensionLines(text)[0]!.split('(active): ')[1]!;
    expect(Array.from(note).length).toBeLessThanOrEqual(WORLD_CLIP.notes);
    const spot = locationLines(text)[0]!.slice('  - Маяк: '.length);
    expect(Array.from(spot).length).toBeLessThanOrEqual(WORLD_CLIP.place);
    expect(spot.endsWith('…')).toBe(true);
  });

  test('over the character budget the units that do not fit are counted: (+N more not shown)', () => {
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => person(`Персонаж ${i}`, { description: `Описание персонажа номер ${i}, довольно длинное, чтобы занять место.` })),
      place('Маяк'),
    ];
    const budget = { ...WORLD_FULL, chars: 400 };
    const text = snap(entries, [], [], budget);
    expect(text.length).toBeLessThanOrEqual(400);
    const shown = characterLines(text).length + locationLines(text).length;
    expect(text.endsWith(`\n(+${11 - shown} more not shown)`)).toBe(true);
    expect(shown).toBe(4);
    expect(snap(entries, [], [], { ...WORLD_FULL, chars: 30 })).toBe('');
    // A smaller unit later on still fits after a larger one did not.
    const big = person('Большой', { description: 'очень '.repeat(40) });
    const small = person('Малый');
    expect(snap([big, small], [], [], { ...WORLD_FULL, chars: 100 })).toBe('[COMPENDIUM CONTEXT]\nCharacters:\n  - Малый\n(+1 more not shown)');
    // Everything fits: no counter.
    expect(snap(entries)).not.toContain('more not shown');
  });

  test('a mirror rivalry is printed once, also when one side names the other by an alias', () => {
    const entries = [
      person('Мира', { aliases: ['Фонарщица'], relationships: [{ with: 'Села', nature: 'rival' }] }),
      person('Села', { relationships: [{ with: 'Фонарщица', nature: 'rival', notes: 'старый спор' }] }),
      person('Дов', { relationships: [{ with: 'Села', nature: 'enemy' }] }),
    ];
    expect(tensionLines(snap(entries))).toEqual(['  Tension: Мира / Села: rival relationship (active)', '  Tension: Дов / Села: enemy relationship (active)']);
  });

  test('a status that is not text is not printed; an alive one never is', () => {
    const entries = [person('A', { current_state: { status: 5, condition: 'tired' } }), person('B', { current_state: { status: 'alive' } })];
    const lines = characterLines(snap(entries));
    expect(lines).toEqual(['  - A. tired', '  - B']);
  });

  test("an overlay is still a library entry, ordered by its order; its lastSeq does not count", () => {
    const overlay = lib('book', 'o', 'character', { name: 'Overlay' }, { order: 1, origin: { kind: 'library', book: 'book', id: 'o', overlay: true }, prov: { created: null, lastSeq: 99, appended: {}, createdSeq: 0 } });
    const base = lib('book', 'b', 'character', { name: 'Base' }, { order: 5 });
    expect(characterLines(snap([overlay, base])).map((l) => l.slice(4))).toEqual(['Base', 'Overlay']);
  });
});
