// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// tools/handles.ts: per-turn short handles (D-59; C<n> = entryRefs, D-150).
import { describe, expect, test } from 'bun:test';
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import { noteRefs } from '../../src/agents/compendium/notes.ts';
import { entryRefs } from '../../src/agents/compendium/refs.ts';
import { HandleTable, type HandleTarget } from '../../src/tools/handles.ts';
import { file, row } from '../memory/fixtures.ts';
import { source, typed } from '../memory/kit.ts';

describe('HandleTable', () => {
  test('numbered from 1 per prefix in order of first appearance; the same target keeps its handle', () => {
    const h = new HandleTable();
    expect(h.handleFor({ kind: 'lore', book: '@card', id: 'e7' })).toBe('L1');
    expect(h.handleFor({ kind: 'compendium', key: 'note:брат' })).toBe('C1');
    expect(h.handleFor({ kind: 'lore', book: 'world', id: 'e7' })).toBe('L2');
    expect(h.handleFor({ kind: 'lore', book: '@card', id: 'e7' })).toBe('L1');
    expect(h.handleFor({ kind: 'compendium', key: 'note:караван' })).toBe('C2');
    expect(h.handleFor({ kind: 'compendium', key: 'note:брат' })).toBe('C1');
  });

  test('resolve: case, whitespace, quotes and brackets ignored', () => {
    const h = new HandleTable();
    h.handleFor({ kind: 'lore', book: 'b', id: 'x' });
    for (let i = 2; i <= 12; i++) h.handleFor({ kind: 'lore', book: 'b', id: `x${i}` });
    h.handleFor({ kind: 'compendium', key: 'note:a' });
    for (const s of ['L12', 'l12', ' L12 ', '"L12"', "'l12'", '[L12]', '(L12)', '«L12»', '“L12”', '`L12`', '#L12', 'L012', 'L12.']) {
      expect(h.resolve(s)).toEqual({ kind: 'lore', book: 'b', id: 'x12' });
    }
    expect(h.resolve('c1')).toEqual({ kind: 'compendium', key: 'note:a' });
  });

  test('unknown or not a handle: undefined', () => {
    const h = new HandleTable();
    h.handleFor({ kind: 'lore', book: 'b', id: 'x' });
    for (const s of ['L2', 'C1', 'Mira', 'L', 'L1a', 'X1', '', 'L 1', 'L0', 'e1']) expect(h.resolve(s)).toBeUndefined();
  });

  test('resolve hands out a copy', () => {
    const h = new HandleTable();
    h.handleFor({ kind: 'compendium', key: 'note:a' });
    const t = h.resolve('C1')!;
    (t as { key: string }).key = 'changed';
    expect(h.resolve('C1')).toEqual({ kind: 'compendium', key: 'note:a' });
  });

  test('resolve reads NFKC forms and a Cyrillic С as C; other Cyrillic letters are not handles', () => {
    const h = new HandleTable();
    h.handleFor({ kind: 'lore', book: 'b', id: 'x' });
    h.handleFor({ kind: 'compendium', key: 'note:a' });
    const lore: HandleTarget = { kind: 'lore', book: 'b', id: 'x' };
    const note: HandleTarget = { kind: 'compendium', key: 'note:a' };
    for (const s of ['С1', 'с1', ' «С1» ', 'С01', 'Ｃ1', 'C１', 'ｃ１']) expect([s, h.resolve(s)]).toEqual([s, note]);
    for (const s of ['L１', 'Ｌ1', 'ｌ１', '[Ｌ１]']) expect([s, h.resolve(s)]).toEqual([s, lore]);
    for (const s of ['Л1', 'л1', 'СС1', 'Сx1', `L${'0'.repeat(40)}1`]) expect([s, h.resolve(s)]).toEqual([s, undefined]);
  });

  test('bound to the turn\'s Compendium, a note\'s handle is its /memory handle (noteRefs = entryRefs), listed or not', () => {
    const compendium = foldCompendium(
      [
        row(1, [{ op: 'note', title: 'Брат Марфы', keys: ['брат'], content: 'Тихон.' }]),
        row(2, [{ op: 'note', title: 'Долг', keys: [], content: 'Три серебряка.' }]),
        row(3, [{ op: 'note', title: 'Мельник', keys: ['мельник'], content: 'Должен Марфе.' }]),
        row(4, [{ op: 'retire', ref: 'note:долг', reason: '' }]),
      ],
      { pathSet: new Set() },
    );
    expect(noteRefs(compendium).map((r) => `${r.ref} ${r.entry.key}`)).toEqual(['C1 note:брат марфы', 'C2 note:долг', 'C3 note:мельник']);
    const h = new HandleTable(compendium);
    // Every note resolves before any handle was issued; the retired one keeps its number.
    expect(h.resolve('C3')).toEqual({ kind: 'compendium', key: 'note:мельник' });
    expect(h.resolve('с2')).toEqual({ kind: 'compendium', key: 'note:долг' });
    expect(h.resolve('C4')).toBeUndefined();
    // First appearance does not renumber them; lore handles still count from 1.
    expect(h.handleFor({ kind: 'compendium', key: 'note:мельник' })).toBe('C3');
    expect(h.handleFor({ kind: 'lore', book: 'b', id: 'x' })).toBe('L1');
    expect(h.handleFor({ kind: 'compendium', key: 'note:брат марфы' })).toBe('C1');
    // A key the bound view does not hold comes after every entry of the view.
    expect(h.handleFor({ kind: 'compendium', key: 'character:mira' })).toBe('C4');
    // Stable across turns: a fresh table bound to the same Compendium gives the same handles.
    const next = new HandleTable();
    next.bindNotes(compendium);
    next.bindNotes(compendium); // binding again changes nothing
    expect(next.handleFor({ kind: 'compendium', key: 'note:мельник' })).toBe('C3');
    // A late bind replaces handles issued before it (C only).
    const late = new HandleTable();
    expect(late.handleFor({ kind: 'compendium', key: 'note:мельник' })).toBe('C1');
    expect(late.handleFor({ kind: 'lore', book: 'b', id: 'x' })).toBe('L1');
    late.bindNotes(compendium);
    expect(late.resolve('C1')).toEqual({ kind: 'compendium', key: 'note:брат марфы' });
    expect(late.handleFor({ kind: 'compendium', key: 'note:мельник' })).toBe('C3');
    expect(late.resolve('L1')).toEqual({ kind: 'lore', book: 'b', id: 'x' });
  });

  test('D-150: every entry of the bound view has its entryRefs handle: library first, typed and arcs between notes', () => {
    const library = librarySeed([source('lantern', 'Фонарщики', [typed('e1', 'character', { name: 'Ульяна' }), typed('e2', 'location', { name: 'Серый маяк' })])], { enabled: true });
    const view = foldCompendium(
      [
        row(1, [{ op: 'note', title: 'Брат', keys: ['брат'], content: 'Тихон.' }]),
        row(2, [file('character', { name: 'Мира', role: 'ally' })]),
        row(3, [{ op: 'arc', plot: 'Украденный свет', overview: 'Свет украли.' }]),
        row(4, [{ op: 'note', title: 'Долг', keys: [], content: 'Три серебряка.' }]),
        row(5, [{ op: 'retire', ref: 'character:мира', reason: 'gone' }]),
      ],
      { pathSet: new Set(), library },
    );
    const refs = entryRefs(view).map((r) => `${r.ref} ${r.entry.key}`);
    expect(refs).toEqual(['C1 lib:lantern:e1', 'C2 lib:lantern:e2', 'C3 note:брат', 'C4 character:мира', 'C5 plot:украденный свет', 'C6 arc:украденный свет', 'C7 note:долг']);
    const h = new HandleTable(view);
    // Every entry resolves with no search before, retired ones too; the handle is the same as /memory's.
    for (const { ref, entry } of entryRefs(view)) {
      expect(h.resolve(ref)).toEqual({ kind: 'compendium', key: entry.key });
      expect(h.handleFor({ kind: 'compendium', key: entry.key })).toBe(ref);
    }
    expect(h.resolve('С4')).toEqual({ kind: 'compendium', key: 'character:мира' });
    // Asked in any order, nothing is renumbered by first appearance.
    const late = new HandleTable();
    late.bindNotes(view);
    expect(late.handleFor({ kind: 'compendium', key: 'note:долг' })).toBe('C7');
    expect(late.handleFor({ kind: 'compendium', key: 'lib:lantern:e2' })).toBe('C2');
    // Without a typed book the notes keep their M3 numbers (the notes-only view of the test above).
    const notesOnly = foldCompendium([row(1, [{ op: 'note', title: 'Брат', keys: [], content: 'Тихон.' }]), row(2, [{ op: 'note', title: 'Долг', keys: [], content: 'x' }])], { pathSet: new Set() });
    expect(new HandleTable(notesOnly).resolve('C2')).toEqual({ kind: 'compendium', key: 'note:долг' });
  });

  test('tables are per turn: a fresh table starts again', () => {
    const a = new HandleTable();
    a.handleFor({ kind: 'lore', book: 'b', id: 'x' });
    a.handleFor({ kind: 'lore', book: 'b', id: 'y' });
    const b = new HandleTable();
    expect(b.handleFor({ kind: 'lore', book: 'b', id: 'y' })).toBe('L1');
  });
});
