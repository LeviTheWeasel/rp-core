// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// search_lore and read_lore over the whole Compendium (D-156): typed session entries, library entries
// (labelled with their book), overlays, notes and arcs under their C<n> (D-150); retired entries never;
// a routed typed library entry never also as an L<n> row; read_lore gives the full render with no
// freshness filter.
import { describe, expect, test } from 'bun:test';
import { renderEntry } from '../../src/agents/compendium/render.ts';
import { LORE_SNIPPET, readLoreTool, searchLoreTool } from '../../src/tools/builtin/lore.ts';
import type { ToolCtx } from '../../src/tools/types.ts';
import { row } from '../memory/fixtures.ts';
import { lantern } from '../memory/kit.ts';
import { entryOf, idOf, memRows, world, worldCtx } from './kit.ts';

const search = (query: string, ctx: ToolCtx = worldCtx()) => searchLoreTool.run({ query }, ctx);
const read = (ids: unknown, ctx: ToolCtx = worldCtx()) => readLoreTool.run({ ids }, ctx);
const rows = (text: string): string[] => text.split('\n').filter((l) => /^[LC]\d+ /.test(l));

describe('search_lore over the Compendium', () => {
  test('a typed session entry: its C<n>, its type as the label, its brief as the snippet', async () => {
    const out = await search('клятва');
    expect(rows(out.text)).toEqual(['C5 Мира (character): Младшая фонарщица. | Role: ally | Memories: Старая клятва; Спор у маяка — Ульяне можно верить.']);
    // An alias is a key: the entry is found by it.
    expect(rows((await search('Фонарщица')).text)[0]).toStartWith('C5 Мира (character): ');
  });

  test('a library entry is labelled with its type and its book; an overlay too', async () => {
    expect(rows((await search('Ульяна')).text)[0]).toBe('C1 Ульяна (character, Фонарщики): Смотрительница Серого маяка. | Relationships: Мира (ally)');
    // «Серый маяк» is an overlay (the session added a danger): found by the new field.
    expect(rows((await search('обрыв')).text)).toEqual(['C2 Серый маяк (location, Фонарщики): Маяк на мысе. | Dangers: обрыв']);
    // A book that is not among the turn's sources is named by its library id.
    expect(rows((await search('обрыв', worldCtx(world(), { lore: [] }))).text)).toEqual(['C2 Серый маяк (location, lantern): Маяк на мысе. | Dangers: обрыв']);
  });

  test('a note and an arc: labelled so, their snippet cut around the match in their own text', async () => {
    expect(rows((await search('трактирщицы')).text)).toEqual(['C4 Брат (note): Тихон — брат трактирщицы Марты.']);
    const arc = rows((await search('тьму')).text);
    expect(arc).toEqual(['C6 Украденный свет (arc): Свет маяка украли, и город погрузился во тьму.']);
  });

  test('a retired entry never appears, and read_lore does not read it', async () => {
    expect((await search('пристань')).text).toMatch(/^No lore or Compendium entry matches\./);
    expect((await read(['C7'])).text).toBe('"C7": no such handle. Use the handles search_lore gave, like L3 or C2.');
  });

  test('a routed typed library entry is a C<n> row only: no L<n> for it, also when the sources were not routed', async () => {
    const routed = rows((await search('свет')).text);
    expect(routed).toContain('C3 Украденный свет (plot, Фонарщики): Status: active');
    // The book's [Arc] entry stays plain lore (D-141), so it is an L row.
    expect(routed.filter((l) => l.startsWith('L'))).toEqual(['L1 [Arc] Украденный свет (Фонарщики): About [Arc] Украденный свет.']);
    // Handed the unrouted book, the tool still lists each typed entry once, as its C<n>.
    const raw = worldCtx(world(), { lore: [lantern()] });
    const all = rows((await search('Ульяна маяк свет песня', raw)).text);
    expect(all.filter((l) => l.startsWith('L')).map((l) => l.replace(/^L\d+ /, '').split(' (')[0])).toEqual(['Песня фонарщиков', '[Arc] Украденный свет']);
    expect(all.filter((l) => / \((character|location|plot), Фонарщики\)/.test(l)).map((l) => l.split(' ')[0])).toEqual(['C1', 'C2', 'C3']);
  });

  test('the brief snippet keeps whole lines within LORE_SNIPPET, then says more follows', async () => {
    const long = memRows();
    long.push(row(20, [{ op: 'edit', ref: 'character:мира', set: { role: 'ally', personality: 'x', goals: Array.from({ length: 6 }, (_, i) => `цель номер ${i} очень длинная и подробная`) } }]));
    long.push(row(21, [{ op: 'file', type: 'location', data: { name: 'Обсерватория', type: 'башня', parent_location: 'Мыс', controlling_faction: 'Гильдия фонарщиков, старшая ветвь', dangers: ['крутые ступени над пропастью без перил', 'ветер, сбивающий с ног на самом верху', 'старые ловушки смотрителей', 'сова'] } }]));
    const [hit] = rows((await search('Обсерватория', worldCtx(world(long)))).text);
    const snippet = hit!.slice(hit!.indexOf('): ') + 3);
    expect(snippet).toStartWith('Type: башня | Parent location: Мыс | Controlling faction: ');
    expect(snippet.length).toBeLessThanOrEqual(LORE_SNIPPET + 4);
    expect(snippet).toEndWith(' | …');
  });

  test('ties: a session entry by its last change; a library entry by its lore order', async () => {
    // Two session characters equal on the words: the one changed last comes first.
    const two = memRows();
    two.push(row(30, [{ op: 'edit', ref: 'character:тихон', set: { description: 'Брат Марты, ходит с караваном.' } }]));
    two.push(row(31, [{ op: 'edit', ref: 'character:мира', set: { description: 'Младшая фонарщица, ходит с караваном.' } }]));
    const order = rows((await search('караваном', worldCtx(world(two)))).text).map((l) => l.split(' ')[1]);
    expect(order).toEqual(['Мира', 'Тихон']);
  });
});

describe('read_lore over the Compendium', () => {
  test('C<n> reads the full render, with no freshness filter: the memory filed from a visible message is there', async () => {
    const view = world();
    const mira = entryOf(view, 'character:мира');
    const out = await read(['C5'], worldCtx(view));
    expect(out.text).toBe(`C5 Мира (character):\n${renderEntry(mira)}`);
    expect(out.text).toContain('Спор у маяка');
    expect(mira.prov.appended.memories).toEqual([null, idOf(5)]);
  });

  test('library entries, overlays, notes, arcs and summaries read whole, in the order asked', async () => {
    const view = world();
    const out = await read(['C2', 'C1', 'C4', 'C6', 'C8'], worldCtx(view));
    expect(out.text).toStartWith('C2 Серый маяк (location, Фонарщики):\n# Серый маяк\n\nМаяк на мысе.');
    expect(out.text).toContain('\n\nC1 Ульяна (character, Фонарщики):\n# Ульяна\n');
    expect(out.text).toContain('## Dangers\n- обрыв');
    expect(out.text).toContain('\n\nC4 Брат (note):\n[Memory: Брат]\nТихон — брат трактирщицы Марты.');
    expect(out.text).toContain('\n\nC6 Украденный свет (arc):\n# [Arc] Украденный свет\n\nСвет маяка украли, и город погрузился во тьму.');
    expect(out.text).toEndWith('C8 Вечер у маяка (summary):\n# Вечер у маяка\n\nМира и Ульяна говорили о свете.');
    expect(out.summary).toBe('5 read');
  });

  test('a handle past the view, or of a retired entry, is unknown', async () => {
    const out = await read(['C99', 'С7', 'C9']);
    expect(out.text).toBe(
      [
        '"C99": no such handle. Use the handles search_lore gave, like L3 or C2.',
        '"С7": no such handle. Use the handles search_lore gave, like L3 or C2.',
        `C9 Тихон (character):\n${renderEntry(entryOf(world(), 'character:тихон'))}`,
      ].join('\n\n'),
    );
    expect(out.summary).toBe('1 read, 2 unknown');
  });
});
