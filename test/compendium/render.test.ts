// Ported from Bunraku:src/core/compendium/filing.test.ts@702d8120 (the renderer case).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The renderer (D-151): Bunraku's renderContent with the four listed fixes, renderEntry for every kind
// of entry, and renderBrief.
import { describe, expect, test } from 'bun:test';
import { label, RENDER_HIDDEN, RENDER_MAX_DEPTH, renderBrief, renderBriefParts, renderContent, renderEntry } from '../../src/agents/compendium/render.ts';
import { ENTRY_TYPES } from '../../src/agents/compendium/types.ts';
import { arcEntry, lib, noteEntry, typed } from './kit.ts';

const MIRA = {
  name: 'Мира Ванс',
  aliases: ['Фонарщица'],
  description: 'Хранительница последнего фонаря. Говорит мало.',
  role: 'ally',
  current_state: { status: 'wounded', condition: 'хромает', location: 'Маяк' },
  relationships: [
    { with: 'Дов', nature: 'ally', status: 'active' },
    { with: 'Села', nature: 'rival' },
    { with: 'Оз', nature: 'family', status: 'strained', notes: 'брат' },
    { with: 'Тень', nature: 'enemy' },
  ],
  memories: [
    { what_happened: 'Зажгла фонарь', changed_belief: 'Свет держит берег.', source_turn: 3, writer_source: 'postgen' },
    { what_happened: 'Потеряла фонарь', changed_behavior: 'Не спит.' },
    { what_happened: 'Нашла фонарь', changed_belief: 'Надежда есть.', when: 'вчера' },
  ],
  likes: ['чай', 'дождь'],
  physical: { eyes: 'серые', height: '' },
};

describe('renderContent (Bunraku)', () => {
  test('the same data in a different key order renders the same text, and a render never depends on stored text', () => {
    const a = { name: 'Mira', tagline: 'T', description: 'D', memories: ['x'], zeta: 'z', alpha: 'a', physical: { b: 1, a: 2 } };
    const b = { alpha: 'a', physical: { a: 2, b: 1 }, zeta: 'z', memories: ['x'], description: 'D', tagline: 'T', name: 'Mira' };
    expect(renderContent('character', a)).toBe(renderContent('character', b));
    expect(renderContent('character', a).startsWith('# Mira\n\nT\n\nD')).toBe(true);
  });

  test('a whole entry: head paragraphs, known fields in the type order, unknown ones by name, objects with sorted keys', () => {
    expect(renderContent('character', MIRA)).toBe(
      [
        '# Мира Ванс',
        'Хранительница последнего фонаря. Говорит мало.',
        '## Role\nally',
        '## Physical\nEyes: серые',
        '## Current state\nCondition: хромает\nLocation: Маяк\nStatus: wounded',
        '## Relationships\n- Nature: ally; Status: active; With: Дов\n- Nature: rival; With: Села\n- Nature: family; Notes: брат; Status: strained; With: Оз\n- Nature: enemy; With: Тень',
        '## Memories\n- Changed belief: Свет держит берег.; What happened: Зажгла фонарь\n- Changed behavior: Не спит.; What happened: Потеряла фонарь\n- Changed belief: Надежда есть.; What happened: Нашла фонарь; When: вчера',
        '## Likes\n- чай\n- дождь',
      ].join('\n\n'),
    );
  });

  test('no name, title or topic: the heading is the type label; empty values and empty lists are skipped', () => {
    expect(renderContent('item', { description: 'A key.', abilities: [], current_owner: '', value: null })).toBe('# Item\n\nA key.');
    expect(renderContent('worldbuilding', { topic: 'Право огня', category: 'закон', key_facts: ['Огонь — общий.'] })).toBe(
      '# Право огня\n\n## Category\nзакон\n\n## Key facts\n- Огонь — общий.',
    );
  });

  test('label: underscores to spaces, the first letter upper case', () => {
    expect(label('current_state')).toBe('Current state');
    expect(label('what_happens_if_unaddressed')).toBe('What happens if unaddressed');
    expect(label('имя')).toBe('Имя');
  });

  test('nested lists and objects read as Bunraku writes them', () => {
    expect(renderContent('item', { name: 'Ключ', activation: { words: ['раз', 'два'], cost: { coins: 2 } }, set_pieces: [['a', 'b'], { name: 'c' }] })).toBe(
      '# Ключ\n\n## Activation\nCost: Coins: 2\nWords: - раз - два\n\n## Set pieces\n- - a; - b\n- Name: c',
    );
  });
});

describe('the four fixes (D-151)', () => {
  test('1. bookkeeping fields are never shown, at the top or inside items; an item or section left empty is not printed', () => {
    for (const f of ['writer_source', 'source_turn', 'source_job_id', 'turn_range', 'messages_covered', 'preserved_prose']) expect(RENDER_HIDDEN.has(f)).toBe(true);
    const text = renderContent('character', {
      name: 'Hana',
      memories: [{ what_happened: 'Old vow', source_turn: 10, writer_source: 'postgen', source_job_id: 'j1' }, { source_turn: 3 }],
      preserved_prose: 'The original card text.',
      source_turn: 4,
      physical: { source_job_id: 'j' },
    });
    expect(text).toBe('# Hana\n\n## Memories\n- What happened: Old vow');
    const recap = renderContent('summary', { title: 'Storm night', summary: 'The roof went.', turn_range: { from: 2, to: 9 }, messages_covered: 7 });
    expect(recap).toBe('# Storm night\n\nThe roof went.');
  });

  test('2. tagline, description and summary are paragraphs once, never repeated as sections', () => {
    // Bunraku printed the tagline twice for a character (RoleCall stores one) and a summary's description twice.
    expect(renderContent('character', { name: 'Mira', tagline: 'T', description: 'D', title: 'X' })).toBe('# Mira\n\nT\n\nD\n\n## Title\nX');
    expect(renderContent('summary', { title: 'S', description: 'D', summary: 'Body.' })).toBe('# S\n\nD\n\nBody.');
    expect(renderContent('character', { name: 'M', description: { long: 'not text' } })).toBe('# M\n\n## Description\nLong: not text');
  });

  test('3. aliases are never a section, whatever the type', () => {
    for (const type of ENTRY_TYPES) expect(renderContent(type, { name: 'N', title: 'N', topic: 'N', aliases: ['A'] })).not.toContain('Aliases');
  });

  test('4. a name, title or topic that is the heading is not repeated; one that is not stays', () => {
    expect(renderContent('character', { name: ' ', title: 'Unnamed Guest' })).toBe('# Unnamed Guest');
    expect(renderContent('summary', { name: 'Chapter One', title: 'Chapter One', summary: 'x' })).toBe('# Chapter One\n\nx');
    expect(renderContent('worldbuilding', { name: 'Tides', topic: 'Tides' })).toBe('# Tides');
    expect(renderContent('event', { name: 'Siege', title: 'The Long Night' })).toBe('# Siege\n\n## Title\nThe Long Night');
  });
});

describe('deep data (review breaker#3)', () => {
  /** `{a: {a: … {a: 'дно'}}}` nested `n` objects deep. */
  const deep = (n: number): Record<string, unknown> => {
    let v: unknown = 'дно';
    for (let i = 0; i < n; i++) v = { a: v };
    return v as Record<string, unknown>;
  };

  test(`lists and objects deeper than ${RENDER_MAX_DEPTH} render as '…'; shallower ones whole`, () => {
    const at = (n: number): string => renderContent('item', { name: 'Ключ', inner: deep(n) });
    // The field's own object is depth 0: `n` objects reach depth n − 1.
    expect(at(RENDER_MAX_DEPTH + 1)).toBe(`# Ключ\n\n## Inner\n${'A: '.repeat(RENDER_MAX_DEPTH + 1)}дно`);
    expect(at(RENDER_MAX_DEPTH + 2)).toBe(`# Ключ\n\n## Inner\n${'A: '.repeat(RENDER_MAX_DEPTH + 1)}…`);
    let list: unknown = ['дно'];
    for (let i = 0; i < 40; i++) list = [list];
    expect(renderContent('item', { name: 'Ключ', inner: list })).toContain('- …');
  });

  test('20 000 levels: renderContent, renderEntry and the brief return instead of overflowing the stack', () => {
    const data = { name: 'Глубина', description: 'Очень глубокая запись.', deep: deep(20_000), list: [deep(20_000)] };
    const e = typed('item:глубина', 'item', data);
    const full = renderEntry(e);
    expect(full.startsWith('# Глубина\n\nОчень глубокая запись.')).toBe(true);
    expect(full).toContain('…');
    expect(full.length).toBeLessThan(1_000);
    expect(renderContent('item', data)).toBe(full);
    expect(renderBriefParts(e, 1200, '(more)')).toEqual({ text: '# Глубина\nОчень глубокая запись.', tail: '(more)' });
    const person = typed('character:глубина', 'character', { name: 'Глубина', current_state: deep(20_000), relationships: [{ with: 'Оз', notes: deep(20_000) }] });
    expect(renderBrief(person, 1200, '(more)')).toBe('# Глубина\nRelationships: Оз\n(more)');
  });
});

describe('renderEntry', () => {
  test('a note is its noteText, an arc its plot and overview, a typed entry its renderContent', () => {
    expect(renderEntry(noteEntry('Брат', 'Он ушёл в море.'))).toBe('[Memory: Брат]\nОн ушёл в море.');
    expect(renderEntry(arcEntry('The Missing Lantern', 'It was lost, then found.'))).toBe('# [Arc] The Missing Lantern\n\nIt was lost, then found.');
    expect(renderEntry(typed('character:мира ванс', 'character', MIRA))).toBe(renderContent('character', MIRA));
  });

  test("an entry whose data names nothing is headed by the entry's name", () => {
    const e = lib('lantern', 'e9', 'character', { description: 'No name in data.' }, { name: 'Старый смотритель' });
    expect(renderEntry(e)).toBe('# Старый смотритель\n\nNo name in data.');
    const recap = lib('lantern', 's', 'summary', { summary: 'Body.' }, { name: 'Глава 1' });
    expect(renderEntry(recap)).toBe('# Глава 1\n\nBody.');
  });
});

describe('renderBrief', () => {
  const mira = typed('character:мира ванс', 'character', MIRA);
  const TAIL = '(more: read_lore C12)';

  test('a character: role, state, tense relationships first (at most 3), the last two memories; the tail when something is left out', () => {
    expect(renderBrief(mira, 1200, TAIL)).toBe(
      [
        '# Мира Ванс',
        'Хранительница последнего фонаря.',
        'Role: ally',
        'State: wounded, хромает, at Маяк',
        'Relationships: Села (rival); Оз (family, strained); Тень (enemy)',
        'Memories: Потеряла фонарь — Не спит.; Нашла фонарь — Надежда есть.',
        TAIL,
      ].join('\n'),
    );
    expect(renderBrief(mira, 1200)).not.toContain('(more');
  });

  test('cut at a line boundary so the text and the tail fit; never longer than maxChars', () => {
    expect(renderBrief(mira, 120, TAIL)).toBe(['# Мира Ванс', 'Хранительница последнего фонаря.', 'Role: ally', 'State: wounded, хромает, at Маяк', TAIL].join('\n'));
    for (let n = 10; n <= 400; n += 7) expect(renderBrief(mira, n, TAIL).length).toBeLessThanOrEqual(n);
    expect(renderBrief(mira, 40, TAIL)).toBe(`# Мира Ванс\n${TAIL}`);
  });

  test('a long line is cut at its last sentence end', () => {
    const e = typed('p', 'plot', { name: 'Шторм', status: 'active', goal: 'Удержать маяк до утра. Найти брата. Спасти город от огня и воды.' });
    expect(renderBrief(e, 71, '(more)')).toBe('# Шторм\nStatus: active\nGoal: Удержать маяк до утра. Найти брата.\n(more)');
    expect(renderBrief(e, 70, '(more)')).toBe('# Шторм\nStatus: active\nGoal: Удержать маяк до утра.\n(more)');
  });

  test('a brief that shows everything has no tail; a capped list or an unshown field brings it', () => {
    const small = typed('l', 'location', { name: 'Маяк', description: 'Башня на скале.', type: 'building' });
    expect(renderBrief(small, 700, '(more: read_lore C3)')).toBe('# Маяк\nБашня на скале.\nType: building');
    const capped = typed('l', 'location', { name: 'Маяк', type: 'building', dangers: ['ветер', 'обрыв', 'чайки', 'тьма'] });
    expect(renderBrief(capped, 700, '(more)')).toBe('# Маяк\nType: building\nDangers: ветер; обрыв; чайки\n(more)');
    const extra = typed('l', 'location', { name: 'Маяк', type: 'building', history: 'Old.' });
    expect(renderBrief(extra, 700, '(more)')).toBe('# Маяк\nType: building\n(more)');
    const longer = typed('l', 'location', { name: 'Маяк', description: 'Башня на скале. Внутри темно.' });
    expect(renderBrief(longer, 700, '(more)')).toBe('# Маяк\nБашня на скале.\n(more)');
  });

  test('an uncapped list of scalars printed whole is no reason for the tail (review prompt#3)', () => {
    const plot = typed('p', 'plot', { name: 'Последний огонь', status: 'active', goal: 'Сохранить огонь', next_steps: ['Найти масло', 'Починить линзу'] });
    expect(renderBriefParts(plot, 700, '(more: read_lore C3)')).toEqual({
      text: '# Последний огонь\nStatus: active\nGoal: Сохранить огонь\nNext steps: Найти масло; Починить линзу',
      tail: '',
    });
    const event = typed('e', 'event', { name: 'Буря', type: 'battle', where: ['Маяк', 'Порт'] });
    expect(renderBrief(event, 700, '(more)')).toBe('# Буря\nType: battle\nWhere: Маяк; Порт');
    // A list holding a record, or a blank item, is not printed whole: the tail stays.
    const mixed = typed('p', 'plot', { name: 'Огонь', next_steps: ['Найти масло', { name: 'Линза', who: 'Мира' }] });
    expect(renderBriefParts(mixed, 700, '(more)').tail).toBe('(more)');
    const blank = typed('p', 'plot', { name: 'Огонь', next_steps: ['Найти масло', ' '] });
    expect(renderBriefParts(blank, 700, '(more)').tail).toBe('(more)');
  });

  test('every type has its brief fields', () => {
    const cases: [Parameters<typeof typed>[1], Record<string, unknown>, string[]][] = [
      ['item', { name: 'Фонарь', type: 'relic', current_owner: 'Мира', condition: 'damaged', abilities: ['свет', { name: 'тепло' }, 'зов', 'щит'] }, ['Type: relic', 'Current owner: Мира', 'Condition: damaged', 'Abilities: свет; тепло; зов']],
      ['power', { name: 'Свет', category: 'utility', mastery: 'learning', users: ['Мира'], cost: 'сон', limitations: ['ночь', 'вода', 'ветер'] }, ['Category: utility', 'Mastery: learning', 'Users: Мира', 'Cost: сон', 'Limitations: ночь; вода']],
      ['organization', { name: 'Гильдия', type: 'guild', leader: 'Дов', goals: ['свет'], enemies: ['Тень'] }, ['Type: guild', 'Leader: Дов', 'Goals: свет', 'Enemies: Тень']],
      ['event', { name: 'Буря', type: 'battle', when: 'ночью', where: 'Маяк', outcome: 'выстояли', significance: 'major' }, ['Type: battle', 'When: ночью', 'Where: Маяк', 'Outcome: выстояли', 'Significance: major']],
      ['plot', { name: 'Фонарь', status: 'active', goal: 'найти', current_progress: 'след', next_steps: 'порт' }, ['Status: active', 'Goal: найти', 'Current progress: след', 'Next steps: порт']],
      ['threat', { name: 'Тень', severity: 'major', status: 'active', scope: 'local', what_happens_if_unaddressed: 'тьма' }, ['Severity: major', 'Status: active', 'Scope: local', 'What happens if unaddressed: тьма']],
      ['worldbuilding', { topic: 'Право огня', category: 'закон', key_facts: ['a', 'b', 'c', 'd'], rules: ['r'] }, ['Category: закон', 'Key facts: a; b; c', 'Rules: r']],
      ['creature', { name: 'Чайка', classification: 'beast', disposition: 'territorial', habitat: 'скалы', weaknesses: ['хлеб'] }, ['Classification: beast', 'Disposition: territorial', 'Habitat: скалы', 'Weaknesses: хлеб']],
    ];
    for (const [type, data, lines] of cases) expect(renderBrief(typed('k', type, data), 2000).split('\n').slice(1)).toEqual(lines);
  });

  test('a summary shows its text as a field (no derived tagline) and at most two consequences', () => {
    const s = typed('s', 'summary', { title: 'Ночь бури', summary: 'Буря сорвала крышу. Мира удержала фонарь.', significance: 'major', consequences: ['a', 'b', 'c'], turn_range: { from: 1, to: 4 } });
    expect(renderBrief(s, 700, '(more)')).toBe('# Ночь бури\nSignificance: major\nSummary: Буря сорвала крышу. Мира удержала фонарь.\nConsequences: a; b\n(more)');
    const tagged = typed('s', 'summary', { title: 'T', tagline: 'Short.', summary: 'Long text.' });
    expect(renderBrief(tagged, 700)).toBe('# T\nShort.\nSummary: Long text.');
  });

  test('notes and arcs: their text, cut to fit, with the tail when cut', () => {
    const n = noteEntry('Брат', 'Он ушёл в море. Вернётся весной. Никто не знает.');
    expect(renderBrief(n, 200, '(more)')).toBe('[Memory: Брат]\nОн ушёл в море. Вернётся весной. Никто не знает.');
    expect(renderBrief(n, 50, '(more)')).toBe('[Memory: Брат]\nОн ушёл в море.\n(more)');
    const a = arcEntry('Фонарь', 'Потерян. Найден. Снова потерян.');
    expect(renderBrief(a, 200)).toBe('# [Arc] Фонарь\nПотерян. Найден. Снова потерян.');
    expect(renderBrief(a, 40, '(more)')).toBe('# [Arc] Фонарь\nПотерян. Найден.\n(more)');
  });

  test('a text with no boundary inside the room is cut at a word, with an ellipsis', () => {
    const e = typed('c', 'character', { name: 'Очень длинное имя персонажа без точек' });
    expect(renderBrief(e, 20)).toBe('# Очень длинное…');
  });

  test('in two parts: the text alone and the text with its tail both fit, and join to renderBrief', () => {
    for (const n of [60, 120, 400]) {
      const p = renderBriefParts(mira, n, TAIL);
      expect(p.tail).toBe(TAIL);
      expect(`${p.text}\n${p.tail}`).toBe(renderBrief(mira, n, TAIL));
      expect(`${p.text}\n${p.tail}`.length).toBeLessThanOrEqual(n);
    }
    const small = typed('l', 'location', { name: 'Маяк', type: 'building' });
    expect(renderBriefParts(small, 700, TAIL)).toEqual({ text: '# Маяк\nType: building', tail: '' });
  });

  test('bookkeeping fields never reach the brief and never count as left out', () => {
    const e = typed('c', 'character', { name: 'Hana', role: 'ally', source_turn: 3, preserved_prose: 'x', aliases: ['H'] });
    expect(renderBrief(e, 700, '(more)')).toBe('# Hana\nRole: ally');
  });
});
