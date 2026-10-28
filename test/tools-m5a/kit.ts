// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5a tool and export tests (not a test file itself): a linear chat with the
// Russian `lantern` library book seeded (D-141) and session rows of every kind folded over it.
import { librarySeed, routeBooks } from '../../src/agents/compendium/library.ts';
import type { CEntry, LibrarySeed } from '../../src/agents/compendium/types.ts';
import type { LoreSource } from '../../src/lore/engine.ts';
import type { EntryInput, MemEntry } from '../../src/session/entries.ts';
import { foldView } from '../../src/session/fold.ts';
import type { PathView } from '../../src/session/view.ts';
import type { ToolCtx } from '../../src/tools/types.ts';
import { chatEntries, ctxFor, idOf, makeHeader, seqd } from '../tools-builtin/kit.ts';
import { file, filing, hist, note, row } from '../memory/fixtures.ts';
import { lantern } from '../memory/kit.ts';

export { idOf } from '../tools-builtin/kit.ts';

/** #1 greeting (position 0), then user (#2, #4, #6) and assistant (#3, #5, #7) in turn. */
export const TEXTS = ['Добрый вечер.', 'Где Мира?', 'Она у маяка.', 'А Ульяна?', 'Смотрит на море.', 'Пойдём туда.', 'Ветер крепчает.'];

export const ON = { enabled: true } as const;

/**
 * The session's rows over the lantern book: 1 note «Брат»; 2 Мира (human file, one memory); 3 the arc
 * «Украденный свет» (its plot is the book's e3); 4 «Старая пристань» (location), retired by 5; 6 a
 * filing row on #5 adding a memory to Мира; 7 a historian summary of #2…#5; 8 an edit making «Серый
 * маяк» (e2) an overlay; 9 a second character, Тихон, featured; 10 Мира featured too.
 */
export function memRows(): MemEntry[] {
  return [
    row(1, [note('Брат', 'Тихон — брат трактирщицы Марты.', ['брат', 'Тихон'])]),
    row(2, [file('character', { name: 'Мира', aliases: ['Фонарщица'], role: 'ally', description: 'Младшая фонарщица. Боится темноты.', memories: [{ what_happened: 'Старая клятва' }] })]),
    row(3, [{ op: 'arc', plot: 'Украденный свет', overview: 'Свет маяка украли, и город погрузился во тьму.' }]),
    row(4, [file('location', { name: 'Старая пристань', description: 'Гнилые доски.' })]),
    row(5, [{ op: 'retire', ref: 'location:старая пристань', reason: 'сгорела' }]),
    filing(6, idOf(5), [file('character', { name: 'Мира', memories: [{ what_happened: 'Спор у маяка', changed_belief: 'Ульяне можно верить.' }] })]),
    hist(7, idOf(2), idOf(5), [file('summary', { title: 'Вечер у маяка', summary: 'Мира и Ульяна говорили о свете.' })]),
    row(8, [{ op: 'edit', ref: 'lib:lantern:e2', set: { dangers: ['обрыв'] } }]),
    row(9, [file('character', { name: 'Тихон', role: 'neutral', description: 'Брат Марты.' }), { op: 'edit', ref: 'character:тихон', featured: true }]),
    row(10, [{ op: 'edit', ref: 'character:мира', featured: true }]),
  ];
}

export const books = (): LoreSource[] => [lantern()];

/**
 * The PathView at #7 with the lantern seed and `mems` (default memRows()). The person's rows before the
 * first agent row were written while the chat stood at #4, the rest while it stood at #5 (the filing and
 * historian rows are #5's), so they apply in seq order: M5b D-184 places each row where it was written
 * in the story, and at one place the passes come before the person's rows (section K, order#2).
 */
export function world(mems: MemEntry[] = memRows(), seed: LibrarySeed = librarySeed(books(), ON)): PathView {
  const chat = chatEntries(TEXTS);
  const first = mems.findIndex((m) => m.key !== null);
  const early = (first < 0 ? [] : mems.slice(0, first)) as unknown as EntryInput[];
  const late = (first < 0 ? mems : mems.slice(first)) as unknown as EntryInput[];
  const entries: EntryInput[] = [...chat.slice(0, 4), ...early, ...chat.slice(4, 5), ...late, ...chat.slice(5)];
  return foldView(makeHeader(), seqd(entries), undefined, { library: seed });
}

/** A tool ctx over `view` whose lore is the routed lantern book (as the engine hands it). */
export function worldCtx(view: PathView = world(), more: Partial<ToolCtx> = {}): ToolCtx {
  return ctxFor(view, { lore: routeBooks(books(), ON), ...more });
}

export const entryOf = (view: PathView, key: string): CEntry => {
  const e = view.compendium.entries.get(key);
  if (e === undefined) throw new Error(`no entry ${key}`);
  return e;
};
