// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The Compendium export builders (D-163): the scope (session entries and overlays, live and retired),
// the core.lorebook/1 shape, the compendium-v1 rows and their round trip through readCompendium,
// RoleCall's service fields (a summary's turn_range, a filed memory's source_turn), one featured entry
// per type in the file, deterministic ids, and the streamed write with RoleCall's limits.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportCompendiumRows, exportCoreBook, exportScope, ExportLimitError, writeCompendiumFile } from '../../src/agents/compendium/export.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import { renderEntry } from '../../src/agents/compendium/render.ts';
import type { Rec } from '../../src/agents/compendium/types.ts';
import { compendiumChunks, compendiumWarnings, deterministicUuid, RC_LIMITS, readCompendium, type CompendiumRowInput } from '../../src/formats/compendium-v1.ts';
import { validateLoreBook, type LoreEntry } from '../../src/formats/native.ts';
import { tmpHome } from '../helpers.ts';
import { entryOf, world } from './kit.ts';

const HEAD = { name: 'Вечер у маяка', exportDate: '2026-10-27T10:00:00.000Z' };
const SERVICE = new Set(['turn_range', 'messages_covered', 'source_turn', 'aliases']);

/** Data without the fields the export adds (and the aliases it rewrites), at the top level and in list items. */
function strip(data: Rec | undefined): unknown {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !SERVICE.has(k)).map(([k, x]) => [k, clean(x)]));
  };
  return clean(data ?? {});
}

const byId = (entries: LoreEntry[], id: string): LoreEntry => entries.find((e) => e.id === id)!;

describe('scope', () => {
  test('session entries and overlays, live and retired, in handle order; plain library entries stay out', () => {
    const view = world();
    expect(exportScope(view).map((e) => e.key)).toEqual([
      'lib:lantern:e2',
      'note:брат',
      'character:мира',
      'arc:украденный свет',
      'location:старая пристань',
      'summary:m0000005.0',
      'character:тихон',
    ]);
  });
});

describe('exportCoreBook (--format core)', () => {
  const view = world();
  const book = exportCoreBook(view, 'Вечер у маяка');

  test('a valid core.lorebook/1 book, ids = entry keys', () => {
    expect(validateLoreBook(book).ok).toBe(true);
    expect(book.name).toBe('Вечер у маяка');
    expect(book.match).toBe('stem');
    expect(book.entries.map((e) => e.id)).toEqual(exportScope(view).map((e) => e.key));
  });

  test('typed: title = name, keys = name and aliases, content = the render, meta {type, data, aliases, featured}', () => {
    const mira = entryOf(view, 'character:мира');
    const e = byId(book.entries, 'character:мира');
    expect(e).toMatchObject({ title: 'Мира', keys: ['Мира', 'Фонарщица'], content: renderEntry(mira), position: 'after', meta: { type: 'character', aliases: ['Фонарщица'], featured: true } });
    expect(strip(e.meta?.data)).toEqual(strip(mira.data));
    expect(e.enabled).toBeUndefined();
    // An overlay is exported whole, with its library order and lore keys.
    expect(byId(book.entries, 'lib:lantern:e2')).toMatchObject({ title: 'Серый маяк', keys: ['Серый маяк', 'маяк'], order: 100, meta: { type: 'location', data: { dangers: ['обрыв'] }, aliases: ['маяк'] } });
  });

  test("an overlay keeps its book entry's secondary keys and logic (section I)", () => {
    const v = world();
    const e2 = entryOf(v, 'lib:lantern:e2');
    const entries = new Map(v.compendium.entries);
    entries.set(e2.key, { ...e2, secondary: ['туман'], logic: 'and_all' });
    const out = exportCoreBook({ ...v, compendium: { ...v.compendium, entries } }, 'x');
    expect(validateLoreBook(out).ok).toBe(true);
    expect(byId(out.entries, 'lib:lantern:e2')).toMatchObject({ secondary: ['туман'], logic: 'and_all' });
    expect(byId(out.entries, 'character:мира').secondary).toBeUndefined();
  });

  test('a note at depth 4 with its keys; an arc constant `[Arc] <plot>` with meta.arc; a retired entry disabled with its reason', () => {
    expect(byId(book.entries, 'note:брат')).toEqual({
      id: 'note:брат',
      title: 'Брат',
      content: 'Тихон — брат трактирщицы Марты.',
      keys: ['брат', 'Тихон'],
      position: { depth: 4, role: 'system' },
      scanDepth: 4,
    });
    expect(byId(book.entries, 'arc:украденный свет')).toEqual({
      id: 'arc:украденный свет',
      title: '[Arc] Украденный свет',
      content: 'Свет маяка украли, и город погрузился во тьму.',
      constant: true,
      keys: [],
      position: 'after',
      meta: { arc: 'Украденный свет' },
    });
    expect(byId(book.entries, 'location:старая пристань')).toMatchObject({ enabled: false, extras: { disableReason: 'сгорела' } });
  });

  test('service fields: the summary gains turn_range (0-based positions, `to` exclusive) and messages_covered; a filed memory its source_turn', () => {
    // The historian row covered #2…#5: path positions 1…4.
    expect(byId(book.entries, 'summary:m0000005.0').meta?.data).toEqual({ title: 'Вечер у маяка', summary: 'Мира и Ульяна говорили о свете.', turn_range: { from: 1, to: 5 }, messages_covered: 4 });
    // The memory filed on #5: user messages #2 and #4 up to it. The human one gets none.
    const memories = byId(book.entries, 'character:мира').meta?.data?.memories as Rec[];
    expect(memories).toEqual([{ what_happened: 'Старая клятва' }, { what_happened: 'Спор у маяка', changed_belief: 'Ульяне можно верить.', source_turn: 2 }]);
    // The view's own data is not touched.
    expect(entryOf(view, 'character:мира').data.memories).toEqual([{ what_happened: 'Старая клятва' }, { what_happened: 'Спор у маяка', changed_belief: 'Ульяне можно верить.' }]);
    expect(entryOf(view, 'summary:m0000005.0').data.turn_range).toBeUndefined();
  });

  test('attached as a library book, the export seeds the same live typed entries (types, names, aliases, data)', () => {
    const seed = librarySeed([{ key: 'evening', book }], { enabled: true });
    const live = exportScope(view).filter((e) => e.type !== null && e.retired === undefined);
    expect(seed.entries.map((e) => [e.type, e.name, e.aliases])).toEqual(live.map((e) => [e.type, e.name, e.aliases]));
    expect(seed.entries.map((e) => strip(e.data))).toEqual(live.map((e) => strip(e.data)));
    expect(seed.entries.find((e) => e.name === 'Мира')?.featured).toBe(true);
  });

  test('deterministic: the same view exports the same book', () => {
    expect(JSON.stringify(exportCoreBook(world(), 'Вечер у маяка'))).toBe(JSON.stringify(book));
  });
});

describe('exportCompendiumRows (--format compendium)', () => {
  const view = world();
  const rows = exportCompendiumRows(view);
  const text = [...compendiumChunks(HEAD, rows)].join('');
  const back = readCompendium(JSON.parse(text), { fallbackName: 'x' }).value;

  test('rows: typed with type and data (aliases inside), the arc with its plot, the note classic, the retired one disabled', () => {
    const at = (key: string): CompendiumRowInput => rows.find((r) => r.key === key)!;
    expect(at('character:мира')).toMatchObject({ title: 'Мира', enabled: true, constant: false, keys: ['Мира', 'Фонарщица'], type: 'character', featured: true, data: { aliases: ['Фонарщица'] } });
    expect(at('character:мира').content).toBe(renderEntry(entryOf(view, 'character:мира')));
    expect(at('lib:lantern:e2').data?.aliases).toEqual(['маяк']);
    expect(at('arc:украденный свет')).toEqual({ key: 'arc:украденный свет', title: '[Arc] Украденный свет', content: 'Свет маяка украли, и город погрузился во тьму.', enabled: true, constant: true, keys: [], arc: 'Украденный свет' });
    expect(at('note:брат')).toEqual({ key: 'note:брат', title: 'Брат', content: 'Тихон — брат трактирщицы Марты.', enabled: true, constant: false, keys: ['брат', 'Тихон'] });
    expect(at('location:старая пристань')).toMatchObject({ enabled: false, disableReason: 'сгорела' });
    expect(at('summary:m0000005.0').data).toMatchObject({ turn_range: { from: 1, to: 5 }, messages_covered: 4 });
  });

  test('round trip through readCompendium: same types, names, aliases and data (minus the service fields)', () => {
    const scope = exportScope(view);
    expect(back.entries).toHaveLength(scope.length);
    scope.forEach((e, i) => {
      const r = back.entries[i]!;
      expect(r.id).toBe(deterministicUuid(HEAD.name, e.key));
      if (e.type !== null) {
        expect([e.key, r.title, r.meta?.type, r.meta?.aliases ?? []]).toEqual([e.key, e.name, e.type, e.aliases]);
        expect([e.key, strip(r.meta?.data)]).toEqual([e.key, strip(e.data)]);
      } else if (e.arc !== undefined) {
        expect(r).toMatchObject({ title: `[Arc] ${e.arc}`, content: e.content, constant: true, meta: { arc: e.arc } });
      } else {
        expect(r).toMatchObject({ title: e.name, content: e.content, keys: e.keys });
        expect(r.meta).toBeUndefined();
      }
      expect([e.key, r.enabled !== false]).toEqual([e.key, e.retired === undefined]);
    });
    // The read keeps what RoleCall would show as text; the service fields come back in data.
    expect(byId(back.entries, deterministicUuid(HEAD.name, 'summary:m0000005.0')).meta?.data).toMatchObject({ turn_range: { from: 1, to: 5 }, messages_covered: 4 });
    expect(byId(back.entries, deterministicUuid(HEAD.name, 'location:старая пристань')).extras?.metadata).toEqual({ source: 'tv_compendium', disableReason: 'сгорела' });
  });

  test('featured once per type: Мира keeps it, Тихон (the second featured character) is written unfeatured', () => {
    const file = JSON.parse(text) as { entries: { title: string; is_featured: boolean }[] };
    expect(file.entries.filter((r) => r.is_featured).map((r) => r.title)).toEqual(['Мира']);
    expect(compendiumWarnings(rows).map((w) => w.code)).toEqual(['featured_dropped']);
    expect(back.entries.filter((e) => e.meta?.featured).map((e) => e.title)).toEqual(['Мира']);
  });

  test('deterministic: the same view gives the same rows and the same file', () => {
    expect(exportCompendiumRows(world())).toEqual(rows);
    expect([...compendiumChunks(HEAD, exportCompendiumRows(world()))].join('')).toBe(text);
  });
});

describe('writeCompendiumFile', () => {
  const rows = exportCompendiumRows(world());
  const expected = [...compendiumChunks(HEAD, rows)].join('');

  test('streams the codec text into a temp file and renames it into place (the folder made when missing)', () => {
    const dir = join(tmpHome(), 'exports');
    const path = join(dir, 'vecher.compendium.json');
    writeCompendiumFile(path, HEAD, rows);
    expect(readFileSync(path, 'utf8')).toBe(expected);
    expect(readdirSync(dir)).toEqual(['vecher.compendium.json']);
    // A second write replaces the file (refusing is the caller's choice, --force).
    writeCompendiumFile(path, HEAD, rows.slice(0, 1));
    expect(readFileSync(path, 'utf8')).toBe([...compendiumChunks(HEAD, rows.slice(0, 1))].join(''));
  });

  test("a temp file left by a crash is never overwritten: the next free '<path>.tmp-<n>' is used", () => {
    const dir = tmpHome();
    const path = join(dir, 'x.compendium.json');
    writeFileSync(`${path}.tmp-1`, 'left over');
    writeCompendiumFile(path, HEAD, rows);
    expect(readFileSync(`${path}.tmp-1`, 'utf8')).toBe('left over');
    expect(readFileSync(path, 'utf8')).toBe(expected);
    expect(readdirSync(dir).sort()).toEqual(['x.compendium.json', 'x.compendium.json.tmp-1']);
  });

  test(`more than ${RC_LIMITS.entries} rows: refused before anything is written`, () => {
    const dir = tmpHome();
    const path = join(dir, 'big.compendium.json');
    const many = Array.from({ length: RC_LIMITS.entries + 1 }, (_, i): CompendiumRowInput => ({ key: `note:${i}`, title: `N${i}`, content: '', enabled: true, constant: false, keys: [] }));
    let err: unknown;
    try {
      writeCompendiumFile(path, HEAD, many);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExportLimitError);
    expect((err as ExportLimitError).limit).toBe('entries');
    expect((err as Error).message).toBe(`${RC_LIMITS.entries + 1} entries: RoleCall imports at most ${RC_LIMITS.entries} from one Compendium file; nothing was written`);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('past 10 MB: refused while streaming, the temp file removed, an older file left as it was', () => {
    const dir = tmpHome();
    const path = join(dir, 'huge.compendium.json');
    writeFileSync(path, 'older export');
    const big = Array.from({ length: 3 }, (_, i): CompendiumRowInput => ({ key: `note:${i}`, title: `N${i}`, content: 'x'.repeat(4 * 1024 * 1024), enabled: true, constant: false, keys: [] }));
    let err: unknown;
    try {
      writeCompendiumFile(path, HEAD, big);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExportLimitError);
    expect((err as ExportLimitError).limit).toBe('bytes');
    expect((err as Error).message).toBe('the export passes 10 MB, more than RoleCall imports from one file; nothing was written');
    expect(readdirSync(dir)).toEqual(['huge.compendium.json']);
    expect(readFileSync(path, 'utf8')).toBe('older export');
    expect(existsSync(`${path}.tmp-1`)).toBe(false);
  });
});
