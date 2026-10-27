// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The model-free selector (D-153): tiers, matching through mention.ts (D-169 as narrowed in section I:
// a proper name's words in one text in any order, a name with a short or stop word, an event, plot or
// summary title and a library lore key as a run; a key's secondary keys and logic), an opening's
// empty U, order inside a tier.
import { describe, expect, test } from 'bun:test';
import { select, WINDOW_MESSAGES, type SelectInput } from '../../src/agents/compendium/select.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import { entry, libEntry, refsOf } from './fixtures.ts';

/** select over `entries` with refs in list order; U and the window as given, no cast. */
function pick(entries: CEntry[], over: Partial<SelectInput> = {}) {
  return select({ entries, refOf: refsOf(entries), uText: '', windowTexts: [], castNames: [], ...over });
}
const keys = (picks: { key: string }[]): string[] => picks.map((p) => p.key);

const MIRA = entry('character:мира', 'character', 'Мира');
const HARBOR = entry('location:гавань соли', 'location', 'Гавань Соли');

describe('tier 0: named in U', () => {
  test('a Russian name in any case form (Мира / Миру / Мирой) by stems', () => {
    for (const u of ['Мира, ты здесь?', 'Я видел Миру у причала.', 'Мы пошли с Мирой.']) {
      expect(pick([MIRA], { uText: u })).toEqual([{ key: 'character:мира', ref: 'C1', tier: 0, via: 'mention' }]);
    }
    // A known limit (D-153): a single stem collides with a common word.
    expect(keys(pick([MIRA], { uText: 'Весь мир спит.' }))).toEqual(['character:мира']);
    expect(pick([MIRA], { uText: 'Никого нет.' })).toEqual([]);
  });

  test('a phrase name needs every significant word, in any order (D-169); an alias names the entry too', () => {
    const vance = entry('character:мира ванс', 'character', 'Мира Ванс', { aliases: ['Фонарщица'] });
    expect(keys(pick([vance], { uText: 'Миру Ванс ждут.' }))).toEqual(['character:мира ванс']);
    expect(keys(pick([vance], { uText: 'Ванс и Мира.' }))).toEqual(['character:мира ванс']);
    expect(pick([vance], { uText: 'Мира пришла одна.' })).toEqual([]);
    expect(keys(pick([vance], { uText: 'Где Фонарщица?' }))).toEqual(['character:мира ванс']);
    expect(keys(pick([vance], { uText: 'Фонарщицей звали её.' }))).toEqual(['character:мира ванс']);
  });

  test('words apart, in another order and case: «фонарь вашего мужа, Гордея» names «Фонарь Гордея»', () => {
    const lamp = entry('item:фонарь гордея', 'item', 'Фонарь Гордея');
    expect(pick([lamp], { uText: 'Это фонарь вашего мужа, Гордея?' })).toEqual([{ key: 'item:фонарь гордея', ref: 'C1', tier: 0, via: 'mention' }]);
    expect(keys(pick([lamp], { uText: 'Гордей оставил свой фонарь.' }))).toEqual(['item:фонарь гордея']);
    expect(pick([lamp], { uText: 'Чей это фонарь?' })).toEqual([]);
  });

  test('every significant word: «Ватага Сыча» needs both', () => {
    const band = entry('organization:ватага сыча', 'organization', 'Ватага Сыча');
    expect(pick([band], { uText: 'Ватага ушла в лес.' })).toEqual([]);
    expect(pick([band], { uText: 'Сыч молчит.' })).toEqual([]);
    expect(keys(pick([band], { uText: 'Сыч и его ватага.' }))).toEqual(['organization:ватага сыча']);
  });

  test('a name with a stop word is a run of stems, in order (section I); a name of stop words only too', () => {
    const house = entry('location:дом на холме', 'location', 'Дом на холме');
    expect(keys(pick([house], { uText: 'Мы дошли до дома на холме.' }))).toEqual(['location:дом на холме']);
    expect(pick([house], { uText: 'Дом стоит, холм за ним.' })).toEqual([]);
    expect(pick([house], { uText: 'Дом на краю.' })).toEqual([]);
    const ash = entry('character:the ash', 'character', 'The Ash');
    expect(keys(pick([ash], { uText: 'The Ash came back.' }))).toEqual(['character:the ash']);
    expect(pick([ash], { uText: 'Ash came back, the door shut.' })).toEqual([]);
    const nick = entry('character:как', 'character', 'Как');
    expect(keys(pick([nick], { uText: 'Как пришёл.' }))).toEqual(['character:как']);
    expect(pick([nick], { uText: 'Кто пришёл?' })).toEqual([]);
  });

  test('the words must meet in one text: one window message, or U with the guidance', () => {
    const vance = entry('character:мира ванс', 'character', 'Мира Ванс');
    expect(pick([vance], { windowTexts: ['Мира пришла.', 'Ванс ушёл.'] })).toEqual([]);
    expect(pick([vance], { uText: 'Мира?', windowTexts: ['Ванс ушёл.'] })).toEqual([]);
    expect(pick([vance], { uText: 'Мира?', guidance: 'Пусть Ванс вернётся.' })).toEqual([{ key: 'character:мира ванс', ref: 'C1', tier: 0, via: 'mention' }]);
  });

  test("a library entry's non-regex lore keys are triggers; a regex key and a session entry's keys are not", () => {
    const pier = libEntry('lib:lantern:pier', 'location', 'Северный пирс', { keys: ['причал', '/маяк/'] });
    const session = entry('location:склад', 'location', 'Склад', { keys: ['причал'] });
    expect(keys(pick([pier, session], { uText: 'Идём к причалу.' }))).toEqual(['lib:lantern:pier']);
    // '/маяк/' read as a phrase would match: as a regex key it is no trigger at all.
    expect(pick([pier], { uText: 'Маяк горит.' })).toEqual([]);
  });

  test('a name, alias or key with fewer than 2 letters never matches', () => {
    const tiny = entry('character:я', 'character', 'Я', { aliases: ['K9', '7'] });
    const libTiny = libEntry('lib:lantern:x', 'item', 'Ж', { keys: ['Q'] });
    expect(pick([tiny, libTiny], { uText: 'Я и K9 и 7 и Ж и Q.' })).toEqual([]);
  });

  test('former names do not match', () => {
    const renamed = entry('character:уголек', 'character', 'Тлен', { prov: { created: null, lastSeq: 3, appended: {}, createdSeq: 1, formerNames: ['Уголёк'] } });
    expect(pick([renamed], { uText: 'Уголёк пришёл.' })).toEqual([]);
  });

  test("a guided re-roll's guidance joins U; a blank one adds nothing", () => {
    expect(pick([HARBOR], { uText: 'Дальше.', guidance: 'Пусть сцена уйдёт в Гавань Соли.' })).toEqual([
      { key: 'location:гавань соли', ref: 'C1', tier: 0, via: 'mention' },
    ]);
    expect(pick([HARBOR], { uText: 'Дальше.', guidance: '  ' })).toEqual([]);
  });
});

describe('D-169 narrowed (section I): runs, labels, phrase titles, lore keys', () => {
  test('a one-letter label binds: «Корпус В» / «Корпус Г», «Wing A» / «Wing B», «Блок А» / «Блок Б», «Plan A»', () => {
    const v = entry('location:корпус в', 'location', 'Корпус В');
    const g = entry('location:корпус г', 'location', 'Корпус Г');
    expect(keys(pick([v, g], { uText: 'Корпус Г заперт, ищи ключ.' }))).toEqual(['location:корпус г']);
    expect(keys(pick([v, g], { uText: 'Пропуск есть только в корпус Г.' }))).toEqual(['location:корпус г']);
    expect(keys(pick([v, g], { uText: 'В корпусе В горит свет.' }))).toEqual(['location:корпус в']);
    const a = entry('location:wing a', 'location', 'Wing A');
    const b = entry('location:wing b', 'location', 'Wing B');
    expect(keys(pick([a, b], { uText: 'Take me to Wing B.' }))).toEqual(['location:wing b']);
    expect(keys(pick([a, b], { uText: 'Wing A is sealed.' }))).toEqual(['location:wing a']);
    const blockA = entry('location:блок а', 'location', 'Блок А');
    const blockB = entry('location:блок б', 'location', 'Блок Б');
    expect(keys(pick([blockA, blockB], { uText: 'Нам нужен блок Б, а не этот.' }))).toEqual(['location:блок б']);
    const plan = entry('item:plan a', 'item', 'Plan A');
    expect(pick([plan], { uText: 'What is the plan for tonight? A quiet one.' })).toEqual([]);
    expect(keys(pick([plan], { uText: 'We go with Plan A.' }))).toEqual(['item:plan a']);
  });

  test('initials and regnal numerals bind: «Elizabeth I» / «Elizabeth II», «Агент К» / «Агент Джей»', () => {
    const first = entry('character:elizabeth i', 'character', 'Elizabeth I');
    const second = entry('character:elizabeth ii', 'character', 'Elizabeth II');
    expect(keys(pick([first, second], { uText: 'I bow before Elizabeth II.' }))).toEqual(['character:elizabeth ii']);
    expect(keys(pick([first, second], { uText: 'Long live Elizabeth I!' }))).toEqual(['character:elizabeth i']);
    const k = entry('character:агент к', 'character', 'Агент К');
    const j = entry('character:агент джей', 'character', 'Агент Джей');
    expect(keys(pick([k, j], { uText: 'Агент Джей подошёл к машине.' }))).toEqual(['character:агент джей']);
    // «Агент Джей» has no short or stop word: any order still works for it.
    expect(keys(pick([k, j], { uText: 'Джей, наш агент, молчит.' }))).toEqual(['character:агент джей']);
  });

  test('a name word a pronoun meets (том, нам …) binds: «Старый Том» is not named by «старая … о том»', () => {
    const tom = entry('character:старый том', 'character', 'Старый Том');
    expect(pick([tom], { uText: 'Старая дверь скрипнула. Я думал о том, что будет.' })).toEqual([]);
    expect(keys(pick([tom], { uText: 'Старый Том вернулся.' }))).toEqual(['character:старый том']);
  });

  test('event, plot and summary titles (and their aliases) are phrases: a run, in order', () => {
    const fall = entry('event:the fall of the city', 'event', 'The Fall of the City');
    expect(pick([fall], { uText: 'Snow falls over the city as we walk.' })).toEqual([]);
    expect(keys(pick([fall], { uText: 'Since the fall of the city we hide.' }))).toEqual(['event:the fall of the city']);
    const fire = entry('event:пожар на складе', 'event', 'Пожар на складе', { aliases: ['Ночной пожар'] });
    expect(pick([fire], { uText: 'На складе пусто; пожар в камине догорает. Ночью тихо.' })).toEqual([]);
    expect(keys(pick([fire], { uText: 'Пожар на складе всё изменил.' }))).toEqual(['event:пожар на складе']);
    expect(keys(pick([fire], { uText: 'После ночного пожара мы ушли.' }))).toEqual(['event:пожар на складе']);
    const night = entry('summary:ночь в порту', 'summary', 'Ночь в порту');
    expect(pick([night], { uText: 'В порту тихо. Ночью придёт корабль.' })).toEqual([]);
    // No stop word, still a phrase: «Тайна маяка» needs its words in a row.
    const secret = entry('plot:тайна маяка', 'plot', 'Тайна маяка');
    expect(pick([secret], { uText: 'Маяк хранит свою тайну.' })).toEqual([]);
    expect(keys(pick([secret], { uText: 'Тайна маяка раскрыта.' }))).toEqual(['plot:тайна маяка']);
  });

  test("a library entry's multi-word lore key is a run, in order (as the lore engine's stem keys)", () => {
    const korvin = libEntry('lib:port:k1', 'character', 'Корвин', { keys: ['Корвин', 'старый капитан'] });
    expect(pick([korvin], { uText: 'Старый причал пуст, капитан ушёл на берег.' })).toEqual([]);
    expect(keys(pick([korvin], { uText: 'Старого капитана ждут.' }))).toEqual(['lib:port:k1']);
    const vex = libEntry('lib:lantern:vex', 'character', 'Векс', { keys: ['black market'] });
    const hob = libEntry('lib:lantern:hob', 'character', 'Хоб', { keys: ['the old man'] });
    expect(pick([vex, hob], { uText: 'The market was loud; a black cat slept on the crates. The man at the gate was old and tired.' })).toEqual([]);
    expect(keys(pick([vex, hob], { uText: 'The old man runs the black market.' }))).toEqual(['lib:lantern:vex', 'lib:lantern:hob']);
  });

  test('a guarded key: secondary keys with their logic must hold in the same text; case is folded', () => {
    const will = (logic: CEntry['logic'], secondary: string[]): CEntry =>
      libEntry('lib:port:w', 'character', 'William Turner', { keys: ['Will'], secondary, ...(logic ? { logic } : {}) });
    const anyOf = will(undefined, ['Turner', 'blacksmith']);
    expect(pick([anyOf], { uText: 'I will wait by the docks until dawn.' })).toEqual([]);
    expect(keys(pick([anyOf], { uText: 'Will, the blacksmith, waits.' }))).toEqual(['lib:port:w']);
    // caseSensitive is not honoured: stems fold case.
    expect(keys(pick([anyOf], { uText: 'will the blacksmith come?' }))).toEqual(['lib:port:w']);
    // The name is no key: it needs no secondary key.
    expect(keys(pick([anyOf], { uText: 'Turner, William, at your service.' }))).toEqual(['lib:port:w']);
    // The secondary key must be in the text the key was found in.
    expect(pick([anyOf], { uText: 'I will wait.', windowTexts: ['Turner left.'] })).toEqual([]);
    expect(pick([anyOf], { uText: 'I will wait.', guidance: 'Turner shows up.' })).toEqual([{ key: 'lib:port:w', ref: 'C1', tier: 0, via: 'mention' }]);

    const allOf = will('and_all', ['Turner', 'blacksmith']);
    expect(pick([allOf], { uText: 'Will the blacksmith come?' })).toEqual([]);
    expect(keys(pick([allOf], { uText: 'Will Turner, the blacksmith.' }))).toEqual(['lib:port:w']);
    const noneOf = will('not_any', ['testament']);
    expect(keys(pick([noneOf], { uText: 'I will wait.' }))).toEqual(['lib:port:w']);
    expect(pick([noneOf], { uText: 'His last will and testament.' })).toEqual([]);
    const notAll = will('not_all', ['testament', 'lawyer']);
    expect(keys(pick([notAll], { uText: 'His will and testament.' }))).toEqual(['lib:port:w']);
    expect(pick([notAll], { uText: 'The lawyer read the will and testament.' })).toEqual([]);
    // A '/re/' secondary key is the lore engine's regex key.
    const smithy = will(undefined, ['/smith(y)?\\b/i']);
    expect(keys(pick([smithy], { uText: 'Will went to the SMITHY.' }))).toEqual(['lib:port:w']);
    expect(pick([smithy], { uText: 'I will wait.' })).toEqual([]);
  });

  test('the positive cases stay: «Гордея» → «Фонарь Гордея», «Миру» → «Мира», «Ванс и Мира» → «Мира Ванс», an alias «охотник» → Глеб', () => {
    const lamp = entry('item:фонарь гордея', 'item', 'Фонарь Гордея');
    const vance = entry('character:мира ванс', 'character', 'Мира Ванс');
    const gleb = libEntry('lib:inn:gleb', 'character', 'Глеб', { aliases: ['охотник'] });
    const all = [MIRA, lamp, vance, gleb];
    expect(keys(pick(all, { uText: 'Это фонарь вашего мужа, Гордея?' }))).toEqual(['item:фонарь гордея']);
    expect(keys(pick(all, { uText: 'Отдай это Миру.' }))).toEqual(['character:мира']);
    expect(keys(pick(all, { uText: 'Ванс и Мира.' }))).toEqual(['character:мира', 'character:мира ванс']);
    expect(keys(pick(all, { uText: 'Где охотник?' }))).toEqual(['lib:inn:gleb']);
    expect(keys(pick(all, { uText: 'Охотника видели у печи.' }))).toEqual(['lib:inn:gleb']);
  });

  test('a spaceless-script name is a substring (known limit: a spaced name never meets the unspaced form)', () => {
    const yamada = entry('character:山田 太郎', 'character', '山田 太郎');
    expect(keys(pick([yamada], { uText: '山田 太郎が来た。' }))).toEqual(['character:山田 太郎']);
    expect(pick([yamada], { uText: '山田太郎が来た。' })).toEqual([]);
  });
});

describe('tiers 1, 2, 3', () => {
  test('recall picks are tier 1; a pick that is not a live candidate is ignored', () => {
    expect(pick([MIRA, HARBOR], { recallPicks: ['location:гавань соли', 'character:нет'] })).toEqual([
      { key: 'location:гавань соли', ref: 'C2', tier: 1, via: 'model' },
    ]);
  });

  test(`tier 2 looks at the last ${WINDOW_MESSAGES} window messages only`, () => {
    const window = ['Мира пела.', 'a', 'b', 'c', 'd'];
    expect(pick([MIRA], { windowTexts: window })).toEqual([]);
    expect(pick([MIRA], { windowTexts: window.slice(1).concat('Миру позвали.') })).toEqual([{ key: 'character:мира', ref: 'C1', tier: 2, via: 'window' }]);
  });

  test('an opening (empty U): the window and the constant entries still pick (section H)', () => {
    const law = libEntry('lib:lantern:law', 'worldbuilding', 'Закон огня', { constant: true });
    expect(pick([MIRA, HARBOR, law], { uText: '', windowTexts: ['Добро пожаловать в Гавань Соли.'] })).toEqual([
      { key: 'location:гавань соли', ref: 'C2', tier: 2, via: 'window' },
      { key: 'lib:lantern:law', ref: 'C3', tier: 3, via: 'constant' },
    ]);
  });

  test('constant library entries are tier 3; a session entry is never constant', () => {
    const law = libEntry('lib:lantern:law', 'worldbuilding', 'Закон огня', { constant: true });
    const fake = entry('worldbuilding:x', 'worldbuilding', 'Икс', { constant: true });
    expect(pick([law, fake])).toEqual([{ key: 'lib:lantern:law', ref: 'C1', tier: 3, via: 'constant' }]);
  });

  test('an entry is picked once, at its best tier', () => {
    const law = libEntry('lib:lantern:law', 'worldbuilding', 'Закон огня', { constant: true });
    const r = pick([MIRA, HARBOR, law], {
      uText: 'Мира молчит.',
      windowTexts: ['Мира и Гавань Соли.', 'Закон огня суров.'],
      recallPicks: ['character:мира'],
    });
    expect(r).toEqual([
      { key: 'character:мира', ref: 'C1', tier: 0, via: 'mention' },
      { key: 'lib:lantern:law', ref: 'C3', tier: 2, via: 'window' },
      { key: 'location:гавань соли', ref: 'C2', tier: 2, via: 'window' },
    ]);
  });

  test('notes, arcs and retired entries are never candidates, even when named', () => {
    const note = entry('note:мира', null, 'Мира', { content: 'Мира боится воды.' });
    const arc = entry('arc:мира', null, 'Мира', { arc: 'Мира', content: 'обзор' });
    const gone = entry('character:мира', 'character', 'Мира', { retired: { reason: 'дубль' } });
    expect(pick([note, arc, gone], { uText: 'Мира?' })).toEqual([]);
  });
});

describe('order inside a tier', () => {
  test('entries named like the card character or the persona go last (by name or by alias)', () => {
    const levi = entry('character:леви', 'character', 'Леви');
    const lyra = entry('character:лира вейл', 'character', 'Лира Вейл', { aliases: ['Мира'] });
    const r = pick([MIRA, levi, lyra, HARBOR], { uText: 'Мира, Леви, Лира Вейл и Гавань Соли.', castNames: ['Мира', 'ЛЕВИ'] });
    expect(keys(r)).toEqual(['location:гавань соли', 'character:мира', 'character:леви', 'character:лира вейл']);
  });

  test('tier 2: the newer message first, then the entry changed last, then handle order', () => {
    const at = (key: string, name: string, lastSeq: number): CEntry =>
      entry(key, 'character', name, { prov: { created: null, lastSeq, appended: {}, createdSeq: 0 } });
    const a = at('character:аня', 'Аня', 1);
    const b = at('character:борис', 'Борис', 9);
    const c = at('character:вера', 'Вера', 1);
    const d = at('character:глеб', 'Глеб', 1);
    const r = pick([a, b, c, d], { windowTexts: ['Аня, Борис, Вера.', 'Глеб.'] });
    expect(keys(r)).toEqual(['character:глеб', 'character:борис', 'character:аня', 'character:вера']);
    // Handle order follows the refs, not the input order.
    const refOf = (k: string): string => ({ 'character:аня': 'C7', 'character:вера': 'C2' })[k] ?? 'C99';
    expect(keys(select({ entries: [a, c], refOf, uText: 'Аня и Вера.', windowTexts: [], castNames: [] }))).toEqual(['character:вера', 'character:аня']);
  });

  test('the same input gives the same picks; a duplicated key counts once', () => {
    const input = { uText: 'Мира и Гавань Соли.', refOf: refsOf([MIRA, HARBOR]) };
    expect(pick([MIRA, HARBOR, MIRA], input)).toEqual(pick([MIRA, HARBOR], input));
    expect(pick([MIRA, HARBOR], input)).toEqual(pick([MIRA, HARBOR], input));
  });
});
