// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5b filing tests (not a test file itself): library books as the import writes
// them, the fold over rows on a short path, and filing rows as the lane will write them.
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { CompendiumView, LibrarySeed } from '../../src/agents/compendium/types.ts';
import type { LoreEntry } from '../../src/formats/native.ts';
import type { LoreSource } from '../../src/lore/engine.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';

export const TS = '2026-10-28T12:00:00.000Z';
export const count = (text: string): number => CHARS_COUNTER.count(text);

/** A typed library entry (meta.type + meta.data). */
export function typedLore(id: string, type: string, data: Record<string, unknown>, extra: Partial<LoreEntry> = {}): LoreEntry {
  const title = String(data.name ?? data.title ?? data.topic ?? id);
  return { id, title, content: `${title}.`, keys: [title], position: 'after', meta: { type, data }, ...extra };
}

/** An untyped (classic) library entry. */
export function classicLore(id: string, title: string, extra: Partial<LoreEntry> = {}): LoreEntry {
  return { id, title, content: `About ${title}.`, keys: [title], position: 'after', ...extra };
}

export const source = (key: string, name: string, entries: LoreEntry[]): LoreSource => ({ key, book: { name, entries } });

/** Bunraku's fake rig book (fake-compendium-rig.ts / filing.test.ts), as a library book. */
export function wolfBook(): LoreSource {
  return source('bk', 'Book', [
    typedLore('c1', 'character', { name: 'Lycanthrope', aliases: ['Wolfman', 'the werewolf'], tagline: 'A werewolf NPC', tier: 'B' }),
    typedLore('p1', 'plot', { name: 'The Salt War', status: 'resolved' }),
    typedLore('p2', 'plot', { name: 'Old Debts', status: 'active' }),
    classicLore('k1', 'Harbor Lore'),
    typedLore('w1', 'worldbuilding', { topic: 'Tides', description: 'The sea rises twice a day.' }),
  ]);
}

/** A small Russian book: two characters, a place, a plot, a classic entry. */
export function lanternBook(): LoreSource {
  return source('lantern', 'Фонарщики', [
    typedLore('e1', 'character', { name: 'Ульяна', aliases: ['Уля', 'Смотрительница'], description: 'Смотрительница Серого маяка.', current_state: { status: 'missing' } }, { order: 50 }),
    typedLore('e2', 'location', { name: 'Серый маяк', aliases: ['маяк'], description: 'Маяк на мысе.' }, { order: 80 }),
    typedLore('e3', 'plot', { name: 'Украденный свет', status: 'active' }),
    typedLore('e4', 'character', { name: 'Арсений Кеттер', description: 'Мастер Гильдии фонарщиков.' }, { order: 10 }),
    classicLore('k1', 'Песня фонарщиков'),
  ]);
}

export const seedOf = (...books: LoreSource[]): LibrarySeed => librarySeed(books, { enabled: true });

export const PATH = ['g1', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'];

/** A human row (on null) or an agent filing row. */
export function humanRow(seq: number, ops: MemOp[]): MemEntry {
  return { t: 'mem', seq, ts: TS, key: null, on: null, by: 'user', ops };
}

export function filingRow(seq: number, on: string, ops: MemOp[], from = on): MemEntry {
  return { t: 'mem', seq, ts: TS, key: `file:${on}`, on, by: 'filing', range: [from, on], ops };
}

export const fileOp = (type: string, data: Record<string, unknown>): MemOp => ({ op: 'file', type, data }) as MemOp;

export const foldWith = (seed: LibrarySeed, rows: MemEntry[]): CompendiumView =>
  foldCompendium(rows, { pathSet: new Set(PATH), path: PATH, library: seed });
