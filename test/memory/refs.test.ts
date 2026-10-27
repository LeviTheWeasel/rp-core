// agents/compendium/refs.ts and notes.ts handles: one C<n> numbering over the whole view (D-150).
import { describe, expect, test } from 'bun:test';
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import { noteRefs, resolveNoteRef } from '../../src/agents/compendium/notes.ts';
import { entryRefs, refOf, resolveEntryRef } from '../../src/agents/compendium/refs.ts';
import { EMPTY_COMPENDIUM, type CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { file, filing, NO_PATH, note, row } from './fixtures.ts';
import { lantern } from './kit.ts';

const SEED = librarySeed([lantern()], { enabled: true });
const ROWS: MemEntry[] = [
  row(1, [note('Брат')]),
  row(2, [file('character', { name: 'Мира', aliases: ['Фонарщица'] })]),
  row(3, [note('Мост')]),
  row(4, [{ op: 'retire', ref: 'note:мост', reason: '' }]),
  row(5, [{ op: 'arc', plot: 'Украденный свет', overview: 'x' }]), // the book has the plot
];
const withBook = (rows: MemEntry[] = ROWS, path: string[] = []): CompendiumView => foldCompendium(rows, { pathSet: new Set(path), library: SEED });
const noBook = (rows: MemEntry[] = ROWS): CompendiumView => foldCompendium(rows, { pathSet: NO_PATH });
const table = (v: CompendiumView) => entryRefs(v).map((r) => `${r.ref} ${r.entry.key}`);

describe('entryRefs', () => {
  test('the library first (book order), then session entries in creation order; retired ones keep their numbers', () => {
    expect(table(withBook())).toEqual([
      'C1 lib:lantern:e1',
      'C2 lib:lantern:e2',
      'C3 lib:lantern:e3',
      'C4 note:брат',
      'C5 character:мира',
      'C6 note:мост',
      'C7 arc:украденный свет',
    ]);
    expect(entryRefs(EMPTY_COMPENDIUM)).toEqual([]);
  });

  test('without a typed book notes keep their M3 numbers; a typed session entry takes its own place', () => {
    const notesOnly = noBook([row(1, [note('Брат')]), row(3, [note('Мост')])]);
    expect(noteRefs(notesOnly).map((r) => r.ref)).toEqual(['C1', 'C2']);
    // A typed session entry takes its own number in creation order.
    expect(noteRefs(noBook()).map((r) => `${r.ref} ${r.entry.key}`)).toEqual(['C1 note:брат', 'C3 note:мост']);
    // Attaching a book shifts session handles by its entry count.
    expect(noteRefs(withBook()).map((r) => r.ref)).toEqual(['C4', 'C6']);
  });

  test('a session entry never shifts a library handle; a rewind can shift later session handles', () => {
    const bound = [row(1, [note('Брат')]), filing(2, 'a0000001', [file('character', { name: 'Кай' })]), row(3, [note('Мост')])];
    expect(refOf(withBook(bound, ['a0000001']), 'note:мост')).toBe('C6');
    expect(refOf(withBook(bound, []), 'note:мост')).toBe('C5');
    expect(refOf(withBook(bound, []), 'lib:lantern:e3')).toBe('C3');
    expect(refOf(withBook(bound, []), 'character:кай')).toBeNull();
  });
});

describe('resolveEntryRef', () => {
  const v = withBook();
  const key = (ref: string, prefer?: 'live' | 'retired') => resolveEntryRef(v, ref, prefer)?.key ?? null;

  test('handles: C, c and the Cyrillic С, с; out of range → null', () => {
    expect(key('C1')).toBe('lib:lantern:e1');
    expect(key(' c5 ')).toBe('character:мира');
    expect(key('С6')).toBe('note:мост');
    expect(key('с07')).toBe('arc:украденный свет');
    expect(key('C0')).toBeNull();
    expect(key('C8')).toBeNull();
  });

  test('an exact key; a name, alias or former name answered by exactly one entry', () => {
    expect(key('lib:lantern:e2')).toBe('lib:lantern:e2');
    expect(key('Фонарщица')).toBe('character:мира');
    expect(key('уля')).toBe('lib:lantern:e1');
    expect(key('маяк')).toBe('lib:lantern:e2');
    expect(key('Нет такого')).toBeNull();
    expect(key('')).toBeNull();
    const renamed = withBook([...ROWS, row(6, [{ op: 'edit', ref: 'character:мира', set: { name: 'Мира Ванс' } }])]);
    expect(resolveEntryRef(renamed, 'мира')?.key).toBe('character:мира');
  });

  test('ambiguous names → null; the preferred state decides between live and retired', () => {
    // Украденный свет: the library plot and its session arc share the name.
    expect(resolveEntryRef(v, 'Украденный свет')).toBeNull();
    const again = withBook([...ROWS, row(6, [note('Мост')])]);
    expect(resolveEntryRef(again, 'мост')?.key).toBe('note:мост#2');
    expect(resolveEntryRef(again, 'мост', 'retired')?.key).toBe('note:мост');
    expect(resolveEntryRef(v, 'мост')?.key).toBe('note:мост'); // only a retired one: used anyway
  });

  test('a handle wins over an entry named like one; refOf is the inverse', () => {
    const odd = noBook([row(1, [note('C2')]), row(2, [note('Другая')])]);
    expect(resolveEntryRef(odd, 'C2')?.key).toBe('note:другая');
    for (const { ref, entry } of entryRefs(v)) expect(refOf(v, entry.key)).toBe(ref);
  });
});

describe('noteRefs and resolveNoteRef with typed entries around', () => {
  test("notes only; a typed entry's handle is not a note", () => {
    const v = withBook();
    expect(noteRefs(v).map((r) => [r.ref, r.entry.key])).toEqual([
      ['C4', 'note:брат'],
      ['C6', 'note:мост'],
    ]);
    expect(resolveNoteRef(v, 'C4')?.key).toBe('note:брат');
    expect(resolveNoteRef(v, 'C5')).toBeUndefined();
    expect(resolveNoteRef(v, 'C1')).toBeUndefined();
    expect(resolveNoteRef(v, 'character:мира')).toBeUndefined();
    expect(resolveNoteRef(v, 'Мира')).toBeUndefined();
    expect(resolveNoteRef(v, 'C7')).toBeUndefined(); // an arc is not a note
    expect(resolveNoteRef(v, 'брат')?.key).toBe('note:брат');
  });
});
