// agents/compendium/notes.ts: the notes lore book, C<n> handles and ref resolution (§5.8 "Заметки").
import { describe, expect, test } from 'bun:test';
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { NOTES_BOOK_KEY, NOTES_BOOK_NAME, noteRefs, notesBook, noteText, resolveNoteRef } from '../../src/agents/compendium/notes.ts';
import { EMPTY_COMPENDIUM } from '../../src/agents/compendium/types.ts';
import { validateLoreBook } from '../../src/formats/native.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { NO_PATH, note, row } from './fixtures.ts';

const fold = (rows: MemEntry[]) => foldCompendium(rows, { pathSet: NO_PATH });

/** Брат (C1), Мост (C2, retired), Лампа without keys (C3). */
const ROWS: MemEntry[] = [
  row(1, [note('Брат', 'Старший брат Миры.', ['брат', 'Тим'])]),
  row(2, [note('Мост', 'Сгорел в первой главе.', ['мост'])]),
  row(3, [{ op: 'retire', ref: 'note:мост', reason: 'сгорел' }]),
  row(4, [note('Лампа', 'Мигает, когда рядом ложь.', [])]),
];

describe('noteText', () => {
  test("'[Memory: title]' on its own line, then the note", () => {
    expect(noteText('Брат', 'Старший брат Миры.')).toBe('[Memory: Брат]\nСтарший брат Миры.');
  });
});

describe('notesBook', () => {
  test('null when there is no live note', () => {
    expect(notesBook(EMPTY_COMPENDIUM)).toBeNull();
    expect(notesBook(fold(ROWS.slice(1, 3)))).toBeNull(); // only a retired one
  });

  test('the live notes in creation order, stem-matched, depth 4, wrapped', () => {
    const book = notesBook(fold(ROWS));
    expect(book).toEqual({
      name: NOTES_BOOK_NAME,
      scanDepth: 4,
      match: 'stem',
      wholeWords: false,
      recursive: false,
      entries: [
        {
          id: 'note:брат',
          title: 'Брат',
          keys: ['брат', 'Тим'],
          content: '[Memory: Брат]\nСтарший брат Миры.',
          position: { depth: 4, role: 'system' },
          order: 100,
        },
        {
          // A note without keys is keyed by its title.
          id: 'note:лампа',
          title: 'Лампа',
          keys: ['Лампа'],
          content: '[Memory: Лампа]\nМигает, когда рядом ложь.',
          position: { depth: 4, role: 'system' },
          order: 100,
        },
      ],
    });
    expect(NOTES_BOOK_NAME).toBe('Заметки');
    expect(NOTES_BOOK_KEY).toBe('@notes');
    // It is a valid core lorebook (unique ids, known fields).
    expect(validateLoreBook(book).ok).toBe(true);
  });

  test('a renamed note fires with its new title; blank keys fall back to the title', () => {
    const book = notesBook(fold([...ROWS, row(5, [{ op: 'edit', ref: 'note:лампа', set: { title: 'Старая лампа' }, keys: ['  ', ''] }])]));
    expect(book!.entries[1]).toMatchObject({ id: 'note:лампа', title: 'Старая лампа', keys: ['Старая лампа'], content: '[Memory: Старая лампа]\nМигает, когда рядом ложь.' });
  });

  test('a restored note is back in the book, in its creation place', () => {
    const book = notesBook(fold([...ROWS, row(5, [{ op: 'restore', ref: 'note:мост' }])]));
    expect(book!.entries.map((e) => e.id)).toEqual(['note:брат', 'note:мост', 'note:лампа']);
  });

  test('the book is deterministic and never aliases the view', () => {
    const view = fold(ROWS);
    const a = notesBook(view)!;
    a.entries[0]!.keys.push('x');
    expect(notesBook(view)).not.toEqual(a);
    expect(view.entries.get('note:брат')!.keys).toEqual(['брат', 'Тим']);
  });
});

describe('noteRefs', () => {
  test('C<n> in creation order, live and retired', () => {
    expect(noteRefs(fold(ROWS)).map((r) => [r.ref, r.entry.key, r.entry.retired !== undefined])).toEqual([
      ['C1', 'note:брат', false],
      ['C2', 'note:мост', true],
      ['C3', 'note:лампа', false],
    ]);
    expect(noteRefs(EMPTY_COMPENDIUM)).toEqual([]);
  });
});

describe('resolveNoteRef', () => {
  const view = fold(ROWS);
  const key = (ref: string, prefer?: 'live' | 'retired') => resolveNoteRef(view, ref, prefer)?.key;

  test('handles: C<n> and c<n>, trimmed; out of range → undefined', () => {
    expect(key('C1')).toBe('note:брат');
    expect(key('c2')).toBe('note:мост');
    expect(key(' C3 ')).toBe('note:лампа');
    expect(key('C03')).toBe('note:лампа');
    expect(key('C0')).toBeUndefined();
    expect(key('C4')).toBeUndefined();
  });

  test('an exact key', () => {
    expect(key('note:мост')).toBe('note:мост');
    expect(key('note:нет')).toBeUndefined();
  });

  test('a title, compared by normalizeName', () => {
    expect(key('брат')).toBe('note:брат');
    expect(key('  БРАТ! ')).toBe('note:брат');
    expect(key('Мост')).toBe('note:мост'); // the only one with that title, though retired
    expect(key('Башня')).toBeUndefined();
    expect(key('!!!')).toBeUndefined();
    expect(key('')).toBeUndefined();
  });

  test('a title shared by two live notes is ambiguous → undefined; the handles still work', () => {
    const twins = fold([...ROWS, row(5, [note('Брат', 'Другой брат.')])]);
    expect(resolveNoteRef(twins, 'Брат')).toBeUndefined();
    expect(resolveNoteRef(twins, 'C4')?.key).toBe('note:брат#2');
    expect(resolveNoteRef(twins, 'note:брат#2')?.content).toBe('Другой брат.');
  });

  test('a live and a retired note of one title: the preferred state decides', () => {
    const again = fold([...ROWS, row(5, [note('Мост', 'Новый мост.')])]);
    expect(resolveNoteRef(again, 'мост')?.key).toBe('note:мост#2');
    expect(resolveNoteRef(again, 'мост', 'retired')?.key).toBe('note:мост');
    // Only one state present: it is used whatever is preferred.
    expect(resolveNoteRef(again, 'брат', 'retired')?.key).toBe('note:брат');
  });

  test('a handle wins over a note titled like one', () => {
    const odd = fold([row(1, [note('C2')]), row(2, [note('Другая')])]);
    expect(resolveNoteRef(odd, 'C2')?.key).toBe('note:другая');
    expect(resolveNoteRef(odd, 'note:c2')?.name).toBe('C2');
  });
});
