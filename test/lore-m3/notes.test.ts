// M3 lore: the notes book '@notes' (ARCHITECTURE.md §5.8, decisions C5/F4): its own gather group
// after the card's book, budget priority from that place, depth inserts with src 'compendium'.
import { describe, expect, test } from 'bun:test';
import { NOTES_BOOK_KEY } from '../../src/agents/compendium/notes.ts';
import type { LoreEntry } from '../../src/formats/native.ts';
import { CARD_BOOK_KEY, entryLabel, PERSONA_BOOK_KEY, type LoreHit } from '../../src/lore/engine.ts';
import { placeLore } from '../../src/lore/place.ts';
import { entry, run, source } from '../lore/fixtures.ts';

const labels = (hits: readonly { book: string; id: string }[]): string[] => hits.map((h) => entryLabel(h.book, h.id));

/** A notes-like book: stem matching, depth 4, as agents/compendium/notes.ts notesBook builds it. */
const notes = (entries: LoreEntry[]) => source(NOTES_BOOK_KEY, entries, { name: 'Заметки', match: 'stem', scanDepth: 4, recursive: false, wholeWords: false });

describe("'@notes' gather order", () => {
  test('persona → card → notes → session books, whatever the input order', () => {
    const res = run([
      source('lib', [entry('s', { constant: true, order: 999 })]),
      notes([entry('n', { constant: true, order: 1 })]),
      source(CARD_BOOK_KEY, [entry('c', { constant: true, order: 1 })]),
      source(PERSONA_BOOK_KEY, [entry('p', { constant: true, order: 1 })]),
    ]);
    // Acceptance follows the gather order; a session entry's high order does not lift it past the groups.
    expect(labels(res.fired)).toEqual(['@persona:p', '@card:c', '@notes:n', 'lib:s']);
    // Verdicts stay in input order (sources, then book order).
    expect(labels(res.verdicts ?? [])).toEqual(['lib:s', '@notes:n', '@card:c', '@persona:p']);
  });

  test('notes are not merged with the session books: they sort among themselves by order', () => {
    const res = run([
      source(CARD_BOOK_KEY, [entry('c', { constant: true })]),
      source('a', [entry('a1', { constant: true, order: 300 })]),
      notes([entry('n1', { constant: true, order: 10 }), entry('n2', { constant: true, order: 20 })]),
      source('b', [entry('b1', { constant: true, order: 200 })]),
    ]);
    expect(labels(res.fired)).toEqual(['@card:c', '@notes:n2', '@notes:n1', 'a:a1', 'b:b1']);
  });

  test('without a notes book the M2 order is unchanged', () => {
    const res = run([
      source(PERSONA_BOOK_KEY, [entry('p', { constant: true, order: 1 })]),
      source(CARD_BOOK_KEY, [entry('k1', { constant: true, order: 2 }), entry('k2', { constant: true, order: 3 })]),
      source('a', [entry('a', { constant: true, order: 1 })]),
      source('b', [entry('b', { constant: true, order: 5 })]),
    ]);
    expect(labels(res.fired)).toEqual(['@persona:p', '@card:k2', '@card:k1', 'b:b', 'a:a']);
  });

  test('notes fire by stem from their own book settings', () => {
    const res = run([notes([entry('note:мира', { keys: ['Мира'] })]), source('lib', [entry('l', { keys: ['Мира'] })])], { scan: ['Levi: я говорил с Мирой'] });
    expect(labels(res.fired)).toEqual(['@notes:note:мира']); // the literal book does not see «Мирой»
  });
});

describe("'@notes' budget priority", () => {
  // One character = one token; each accepted entry costs its text + '\n'.
  const c = (id: string, content: string): LoreEntry => entry(id, { constant: true, content });

  test('the budget cuts notes after the card and before the session books', () => {
    const sources = [source('lib', [c('s', 'ssss')]), notes([c('n', 'nnnn')]), source(CARD_BOOK_KEY, [c('k', 'kkkk')])];
    // Room for the card's entry only: the note overflows, the session entry goes with it.
    const tight = run(sources, { budget: 6 });
    expect(labels(tight.fired)).toEqual(['@card:k']);
    expect(labels(tight.cut)).toEqual(['@notes:n', 'lib:s']);
    // Room for two: card and note fit, the session book is cut.
    const two = run(sources, { budget: 11 });
    expect(labels(two.fired)).toEqual(['@card:k', '@notes:n']);
    expect(labels(two.cut)).toEqual(['lib:s']);
  });
});

describe("'@notes' placement", () => {
  const hit = (book: string, id: string, patch: Partial<LoreEntry> = {}): LoreHit => {
    const e = entry(id, { position: { depth: 4, role: 'system' }, ...patch });
    return { book, id, entry: e, text: e.content, tokens: e.content.length, why: 'key', matched: [], loop: 0 };
  };

  test("depth inserts from '@notes' have src 'compendium'; other books stay 'lore'", () => {
    const place = placeLore([
      hit(NOTES_BOOK_KEY, 'note:мира', { content: '[Memory: Мира]\nСестра трактирщицы.' }),
      hit('lib', 'x'),
      hit(CARD_BOOK_KEY, 'c'),
    ]);
    // Equal order: reverse acceptance order (ST), as for any lore.
    expect(place.depth.map((d) => [d.src, d.srcId, d.depth, d.role])).toEqual([
      ['lore', '@card:c', 4, 'system'],
      ['lore', 'lib:x', 4, 'system'],
      ['compendium', '@notes:note:мира', 4, 'system'],
    ]);
    expect(place.depth[2]?.text).toBe('[Memory: Мира]\nСестра трактирщицы.');
  });

  test('a notes entry with a slot position goes to that slot like any entry', () => {
    const place = placeLore([hit(NOTES_BOOK_KEY, 'n', { position: 'before' })]);
    expect(place.slots.before).toEqual(['n text']);
    expect(place.depth).toEqual([]);
  });
});
