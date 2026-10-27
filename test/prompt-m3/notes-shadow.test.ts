// The notes book is not a world (integrate fix of the loop agent's note 20): a lorebook named like
// it («Заметки») neither hides the notes nor is hidden by them; name shadowing between real books
// keeps its M2 rules.
import { describe, expect, test } from 'bun:test';
import { NOTES_BOOK_KEY, NOTES_BOOK_NAME } from '../../src/agents/compendium/notes.ts';
import type { Character, LoreBook } from '../../src/formats/native.ts';
import { CARD_BOOK_KEY, type LoreSource } from '../../src/lore/engine.ts';
import { loreSources } from '../../src/prompt/assemble/lore.ts';

const book = (name: string): LoreBook => ({ name, entries: [{ id: 'e', keys: ['x'], content: 'X.', position: 'before' }] });
const notes: LoreSource = { key: NOTES_BOOK_KEY, book: book(NOTES_BOOK_NAME) };
const keys = (sources: readonly LoreSource[]): string[] => sources.map((s) => s.key);
const mira = (own?: LoreBook): { character: Character } => ({ character: { name: 'Mira', description: 'A guide.', greetings: ['Hi.'], ...(own ? { book: own } : {}) } });

describe('loreSources and the notes book', () => {
  test('a session book named «Заметки» does not shadow the notes, nor the notes it', () => {
    const cast = mira();
    expect(keys(loreSources(cast, [notes, { key: 'zametki', book: book(NOTES_BOOK_NAME) }]))).toEqual([NOTES_BOOK_KEY, 'zametki']);
  });

  test('a card book named «Заметки» stays: the notes book never stands in for a world', () => {
    const cast = mira(book(NOTES_BOOK_NAME));
    expect(keys(loreSources(cast, [notes]))).toEqual([CARD_BOOK_KEY, NOTES_BOOK_KEY]);
  });

  test('real books still shadow by name (M2): the later session book wins, the card book goes', () => {
    const cast = mira(book('Eldoria'));
    const sources = loreSources(cast, [notes, { key: 'a', book: book('Eldoria') }, { key: 'b', book: book('Eldoria') }]);
    expect(keys(sources)).toEqual([NOTES_BOOK_KEY, 'b']);
  });
});
