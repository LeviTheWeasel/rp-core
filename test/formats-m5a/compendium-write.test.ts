// Ported from Bunraku:src/formats/rolecall/compendium.test.ts@702d8120 (the streaming case, "it arrives
// a piece at a time").
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writing RoleCall's `compendium-v1.0.0` (D-163): the streamed layout, one featured entry per type
// (CV5), UUID ids (CV7), and the format-level round trip (CV6: write, read back, same entries). The
// streaming case is a sync generator of strings here; the rest is fresh.
import { describe, expect, test } from 'bun:test';
import {
  COMPENDIUM_FORMAT,
  COMPENDIUM_SCHEMA,
  compendiumChunks,
  compendiumWarnings,
  deterministicUuid,
  looksLikeCompendium,
  RC_LIMITS,
  readCompendium,
  type CompendiumRowInput,
} from '../../src/formats/compendium-v1.ts';
import { detect } from '../../src/formats/import.ts';
import { validateLoreBook } from '../../src/formats/native.ts';

const HEAD = { name: 'Фонарь', exportDate: '2026-10-27T12:00:00.000Z' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const mira: CompendiumRowInput = {
  key: 'character:мира',
  title: 'Мира',
  content: '# Мира\n\nМладшая фонарщица.',
  enabled: true,
  constant: false,
  keys: ['Мира', 'Фонарщица'],
  type: 'character',
  data: {
    name: 'Мира',
    aliases: ['Фонарщица'],
    description: 'Младшая фонарщица.',
    relationships: [{ with: 'Арсений Кеттер', nature: 'mentor' }],
    memories: [{ what_happened: 'Нашла соль.', changed_belief: 'Фонарь унесли люди.', source_turn: 3, writer_source: 'postgen' }],
  },
  featured: true,
  turnNumber: 3,
};
const plot: CompendiumRowInput = {
  key: 'plot:украденный свет',
  title: 'Украденный свет',
  content: '# Украденный свет',
  enabled: true,
  constant: false,
  keys: ['Украденный свет'],
  type: 'plot',
  data: { name: 'Украденный свет', status: 'active' },
};
const summary: CompendiumRowInput = {
  key: 'summary:m6.0',
  title: 'Фонарь погас',
  content: '# Фонарь погас',
  enabled: true,
  constant: false,
  keys: ['Фонарь погас'],
  type: 'summary',
  data: { title: 'Фонарь погас', summary: 'Маяк погас.', turn_range: { from: 3, to: 7 }, messages_covered: 4 },
};
const note: CompendiumRowInput = { key: 'note:соль', title: 'Соль', content: 'Соль на камнях у маяка.', enabled: true, constant: false, keys: ['соль', '/со[лл]ь/i', ' '] };
const arc: CompendiumRowInput = {
  key: 'arc:украденный свет',
  title: '[Arc] Украденный свет',
  content: 'Маяк погас, фонарь пропал.',
  enabled: true,
  constant: true,
  keys: [],
  arc: 'Украденный свет',
};
const retired: CompendiumRowInput = {
  key: 'location:старая пристань',
  title: 'Старая пристань',
  content: '# Старая пристань',
  enabled: false,
  constant: false,
  keys: ['Старая пристань'],
  type: 'location',
  data: { name: 'Старая пристань' },
  disableReason: 'merged into Вельмар',
};
const ROWS = [mira, plot, summary, note, arc, retired];

const chunks = (rows: readonly CompendiumRowInput[], head = HEAD): string[] => [...compendiumChunks(head, rows)];
const written = (rows: readonly CompendiumRowInput[], head = HEAD): Record<string, unknown> => JSON.parse(chunks(rows, head).join('')) as Record<string, unknown>;
const entriesOf = (f: Record<string, unknown>): Record<string, unknown>[] => f.entries as Record<string, unknown>[];

describe('deterministicUuid', () => {
  test('UUID-shaped, the same parts give the same id, the parts are not glued', () => {
    const a = deterministicUuid('Фонарь', 'character:мира');
    expect(a).toMatch(UUID);
    expect(deterministicUuid('Фонарь', 'character:мира')).toBe(a);
    expect(deterministicUuid('Фонарь', 'character:мира#2')).not.toBe(a);
    expect(deterministicUuid('ab', 'c')).not.toBe(deterministicUuid('a', 'bc'));
    expect(deterministicUuid('Фонарь')).not.toBe(a);
  });
});

describe('the streamed file', () => {
  test("joined, the chunks are exactly RoleCall's JSON.stringify(payload, null, 2): key order, no trailing newline", () => {
    const text = chunks(ROWS).join('');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(text).toBe(JSON.stringify(parsed, null, 2));
    expect(Object.keys(parsed)).toEqual(['schemaVersion', 'format', 'exportDate', 'lorebook', 'entries', 'tree', 'nodeConstraints', 'categories', 'counts']);
    expect(parsed).toMatchObject({
      schemaVersion: COMPENDIUM_SCHEMA,
      format: COMPENDIUM_FORMAT,
      exportDate: HEAD.exportDate,
      tree: null,
      nodeConstraints: [],
      categories: [],
      counts: { totalEntries: 6, typedEntries: 4, classicEntries: 2 },
    });
    expect(parsed.lorebook).toEqual({ id: deterministicUuid('Фонарь'), name: 'Фонарь', description: null, tags: [], lorebook_type: 'compendium' });
    expect(text).not.toContain('creator_id');
  });

  test('a header, one chunk per row, a footer; an empty book is still the exact layout', () => {
    expect(chunks(ROWS)).toHaveLength(ROWS.length + 2);
    const empty = chunks([]);
    expect(empty).toHaveLength(2);
    const text = empty.join('');
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    expect(JSON.parse(text)).toMatchObject({ entries: [], counts: { totalEntries: 0, typedEntries: 0, classicEntries: 0 } });
  });

  test('it arrives a piece at a time: 300 rows, 302 chunks (Bunraku)', () => {
    const rows = Array.from({ length: 300 }, (_, i): CompendiumRowInput => ({ key: `note:${i}`, title: `Entry ${i}`, content: 'x'.repeat(200), enabled: true, constant: false, keys: [] }));
    const parts = chunks(rows);
    expect(parts).toHaveLength(302);
    expect(entriesOf(JSON.parse(parts.join('')) as Record<string, unknown>)).toHaveLength(300);
  });

  test('the same input writes the same bytes; the date comes from the caller', () => {
    expect(chunks(ROWS).join('')).toBe(chunks(ROWS).join(''));
    expect(written(ROWS, { ...HEAD, exportDate: '2027-01-01T00:00:00.000Z' }).exportDate).toBe('2027-01-01T00:00:00.000Z');
  });

  test('RoleCall, Bunraku and rp-core detection all claim it', () => {
    const text = chunks(ROWS).join('');
    expect(looksLikeCompendium(JSON.parse(text))).toBe(true);
    expect(detect(new TextEncoder().encode(text)).kind).toBe('compendium');
  });

  test('a name over 200 code points is cut there (RoleCall cuts on import)', () => {
    const long = '火'.repeat(250);
    expect((written([], { ...HEAD, name: long }).lorebook as Record<string, unknown>).name).toBe('火'.repeat(200));
  });
});

describe('rows', () => {
  test('a typed row: thin RoleCall columns, tv_compendium metadata, triggers from keys', () => {
    const [row] = entriesOf(written([mira]));
    expect(row).toEqual({
      id: deterministicUuid('Фонарь', 'character:мира'),
      lorebook_id: deterministicUuid('Фонарь'),
      title: 'Мира',
      content: mira.content,
      enabled: true,
      constant: false,
      trigger_mode: 'simple',
      triggers: [
        { keyword: 'Мира', isRegex: false },
        { keyword: 'Фонарщица', isRegex: false },
      ],
      secondary_triggers: [],
      selective_logic: 'and_any',
      position: 'character',
      depth: 4,
      role: 'system',
      sort_order: 0,
      priority: 100,
      probability: 100,
      category_id: null,
      metadata: { source: 'tv_compendium', entry_type: 'character', structured_data: mira.data, turnNumber: 3 },
      is_featured: true,
    });
  });

  test('a note: classic row, {} metadata, regex keys as regex triggers, blank keys dropped', () => {
    const [row] = entriesOf(written([note]));
    expect(row).toMatchObject({
      title: 'Соль',
      content: note.content,
      metadata: {},
      is_featured: false,
      triggers: [
        { keyword: 'соль', isRegex: false },
        { keyword: 'со[лл]ь', isRegex: true, flags: 'i' },
      ],
    });
  });

  test('an arc overview and a retired entry', () => {
    const [a, r] = entriesOf(written([arc, retired]));
    expect(a).toMatchObject({ title: '[Arc] Украденный свет', constant: true, triggers: [], metadata: { source: 'tv_arc_overview', arc: 'Украденный свет' } });
    expect(r).toMatchObject({ enabled: false, metadata: { source: 'tv_compendium', entry_type: 'location', disableReason: 'merged into Вельмар' } });
  });

  test('sort_order follows the rows', () => {
    expect(entriesOf(written(ROWS)).map((r) => r.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('CV5: at most one featured entry per type, the first; the rest said', () => {
    const second: CompendiumRowInput = { ...mira, key: 'character:селина', title: 'Селина', data: { name: 'Селина' } };
    const place: CompendiumRowInput = { ...retired, enabled: true, featured: true };
    const rows = [mira, second, place, { ...note, featured: true }];
    expect(entriesOf(written(rows)).map((r) => r.is_featured)).toEqual([true, false, true, false]);
    expect(compendiumWarnings(rows)).toEqual([
      { code: 'featured_dropped', path: 'entries[1].is_featured', message: '"Селина" is written unfeatured: RoleCall keeps one featured character per book, and "Мира" is it' },
    ]);
    expect(compendiumWarnings(ROWS)).toEqual([]);
  });

  test("more rows than RoleCall imports: said, still written", () => {
    const rows = Array.from({ length: RC_LIMITS.entries + 1 }, (_, i): CompendiumRowInput => ({ key: `n${i}`, title: 't', content: '', enabled: true, constant: false, keys: [] }));
    expect(compendiumWarnings(rows).map((w) => w.code)).toEqual(['too_many_entries']);
  });

  test("CV7: every id is a UUID that appears nowhere in the data, so RoleCall's id remap rewrites nothing", () => {
    const named: CompendiumRowInput = { ...mira, key: 'Мира', data: { name: 'Мира', relationships: [{ with: 'Мира' }] } };
    const f = written([named, plot]);
    for (const row of entriesOf(f)) {
      expect(row.id as string).toMatch(UUID);
      for (const other of entriesOf(f)) expect(JSON.stringify(other.metadata)).not.toContain(row.id as string);
    }
  });
});

describe('CV6: round trip at format level (write, read back)', () => {
  const back = readCompendium(written(ROWS), { fallbackName: 'stem' });
  const book = back.value;

  test('a valid book named as written; no warnings', () => {
    expect(validateLoreBook(book).ok).toBe(true);
    expect(book.name).toBe('Фонарь');
    expect(back.warnings).toEqual([]);
  });

  test('typed entries: same types, data, aliases and featured; ids are the derived UUIDs', () => {
    const typed = book.entries.filter((e) => e.meta?.type !== undefined);
    expect(typed.map((e) => [e.title, e.meta?.type])).toEqual([
      ['Мира', 'character'],
      ['Украденный свет', 'plot'],
      ['Фонарь погас', 'summary'],
      ['Старая пристань', 'location'],
    ]);
    expect(book.entries[0]?.id).toBe(deterministicUuid('Фонарь', 'character:мира'));
    expect(book.entries[0]?.meta).toEqual({ type: 'character', data: mira.data, aliases: ['Фонарщица'], featured: true });
    expect(book.entries[1]?.meta).toEqual({ type: 'plot', data: plot.data });
    expect(book.entries[2]?.meta?.data).toEqual({ title: 'Фонарь погас', summary: 'Маяк погас.', turn_range: { from: 3, to: 7 }, messages_covered: 4 });
    expect(book.entries[0]?.keys).toEqual(mira.keys);
    expect(book.entries[0]?.content).toBe(mira.content);
    expect(book.entries[0]?.extras).toEqual({ metadata: { source: 'tv_compendium', turnNumber: 3 } });
  });

  test('the note is a classic entry, the arc keeps its plot, the retired entry stays disabled with its reason', () => {
    expect(book.entries[3]).toEqual({
      id: deterministicUuid('Фонарь', 'note:соль'),
      title: 'Соль',
      content: note.content,
      enabled: true,
      constant: false,
      keys: ['соль', '/со[лл]ь/i'],
      position: 'after',
      order: 100,
      probability: 100,
    });
    expect(book.entries[4]).toMatchObject({ title: '[Arc] Украденный свет', content: arc.content, constant: true, meta: { arc: 'Украденный свет' }, extras: { metadata: { source: 'tv_arc_overview' } } });
    expect(book.entries[5]).toMatchObject({ enabled: false, extras: { metadata: { disableReason: 'merged into Вельмар' } } });
  });

  test('writing what was read writes the same file', () => {
    const again: CompendiumRowInput[] = ROWS.map((r, i) => {
      const e = book.entries[i];
      if (e === undefined) throw new Error('missing entry');
      return { ...r, keys: e.keys, data: e.meta?.data ?? r.data };
    });
    expect(chunks(again).join('')).toBe(chunks(ROWS).join(''));
  });
});
