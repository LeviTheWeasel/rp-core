// Ported from Bunraku:src/studio/dramaturg-tools.test.ts@702d8120 (the lore cases).
// Copyright (C) 2026 Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// search_lore and read_lore (src/tools/builtin/lore.ts; §9.2, D-59): lexScore ranking over the
// turn's enabled book entries and live notes, handles L<n> / C<n> from the turn's HandleTable,
// read_lore by handles in order (a note reads as its noteText, D-156), unknown handles, the
// 8 000-character cap. The typed Compendium entries are in test/tools-m5a. Adapted from Bunraku
// src/studio/dramaturg-tools.test.ts ("the lore and the preset", Levi).
import { describe, expect, test } from 'bun:test';
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { noteRefs, notesBook, NOTES_BOOK_KEY, resolveNoteRef } from '../../src/agents/compendium/notes.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { LoreBook, LoreEntry } from '../../src/formats/native.ts';
import type { LoreSource } from '../../src/lore/engine.ts';
import type { MemOp } from '../../src/session/entries.ts';
import { LORE_HITS_MAX, LORE_SNIPPET, READ_LORE_MAX, readLoreTool, searchLoreTool } from '../../src/tools/builtin/lore.ts';
import { HandleTable } from '../../src/tools/handles.ts';
import { runTools } from '../../src/tools/run.ts';
import type { ToolCtx } from '../../src/tools/types.ts';
import { row } from '../memory/fixtures.ts';
import { call, chatView, ctxFor } from './kit.ts';

const entry = (id: string, title: string, content: string, more: Partial<LoreEntry> = {}): LoreEntry => ({ id, title, content, keys: [title], position: 'before', ...more });
const book = (name: string, entries: LoreEntry[]): LoreBook => ({ name, entries });

const HARBOR = book('Harbor', [
  entry('x1', 'Mira', 'Keeps the second ledger. Her sister drowned.'),
  entry('x2', 'The Pier', 'Salt and rope.', { constant: true }),
  entry('x3', 'Old Bell', 'Rings for a sister lost.', { enabled: false, keys: ['bell'] }),
]);
const TOWN = book('Town', Array.from({ length: 25 }, (_, i) => entry(`t${i}`, `Street ${i}`, 'A lamp street.')));

const noteOp = (title: string, content: string, keys: string[] = [title]): MemOp => ({ op: 'note', title, keys, content });

/** Notes: Ledger (live), Old Debt (retired), Брат (live). */
function notes(): CompendiumView {
  return foldCompendium(
    [
      row(1, [noteOp('Ledger', 'Mira keeps the second ledger in the cellar.')]),
      row(2, [noteOp('Old Debt', 'A debt to the second ledger keeper.')]),
      row(3, [noteOp('Брат', 'Тихон — брат трактирщицы Марты.', ['брат', 'Тихон'])]),
      row(4, [{ op: 'retire', ref: 'note:old debt', reason: 'paid' }]),
    ],
    { pathSet: new Set() },
  );
}

/** The turn's sources as request.ts gathers them: card, notes book, session books. */
function loreCtx(more: Partial<ToolCtx> = {}, compendium: CompendiumView = notes()): ToolCtx {
  const notesSrc = notesBook(compendium);
  const lore: LoreSource[] = [{ key: '@card', book: HARBOR }, ...(notesSrc ? [{ key: NOTES_BOOK_KEY, book: notesSrc }] : []), { key: 'town', book: TOWN }];
  return ctxFor(chatView(['Hello.']), { lore, compendium, ...more });
}

const searchLore = (query: string, ctx: ToolCtx) => call(searchLoreTool, { query }, ctx);
const readLore = (ids: unknown, ctx: ToolCtx) => call(readLoreTool, { ids }, ctx);
const rows = (text: string): string[] => text.split('\n').filter((l) => /^[LC]\d+ /.test(l));

describe('search_lore', () => {
  test('book entries get L<n> in order of first appearance, notes their /memory C<n>; rows `<handle> <title> (<book>): <snippet>`', async () => {
    const ctx = loreCtx();
    const out = await searchLore('sister', ctx);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe('L1 Mira (Harbor): Keeps the second ledger. Her sister drowned.');
    expect(out.summary).toBe('1 hit');
    // The note's title matches (a key) so it ranks above the entry that only mentions the word.
    const ledger = await searchLore('ledger', ctx);
    expect(rows(ledger.text)).toEqual(['C1 Ledger (note): Mira keeps the second ledger in the cellar.', 'L1 Mira (Harbor): Keeps the second ledger. Her sister drowned.']);
  });

  test('handles are stable within a turn (one HandleTable) and restart in the next', async () => {
    const ctx = loreCtx();
    await searchLore('pier', ctx);
    expect((await searchLore('sister', ctx)).text).toMatch(/^L2 Mira/);
    expect((await searchLore('pier', ctx)).text).toMatch(/^L1 The Pier/);
    const next = loreCtx({ handles: new HandleTable() });
    expect((await searchLore('sister', next)).text).toMatch(/^L1 Mira/);
  });

  test('disabled entries and retired notes never appear; the notes book is not searched twice', async () => {
    const ctx = loreCtx();
    expect((await searchLore('bell', ctx)).text).toMatch(/^No lore or Compendium entry matches\./);
    expect((await searchLore('debt', ctx)).text).toMatch(/^No lore or Compendium entry matches\./);
    // The note is listed once, as C3, its /memory handle (the retired Old Debt keeps C2); its
    // notes-book entry would have been an L handle.
    const brat = await searchLore('Тихон', ctx);
    expect(rows(brat.text)).toEqual(['C3 Брат (note): Тихон — брат трактирщицы Марты.']);
    // Without the notes book in ctx.lore the notes are still found (they come from ctx.compendium).
    const bare = ctxFor(chatView(['Hello.']), { lore: [{ key: '@card', book: HARBOR }], compendium: notes() });
    expect(rows((await searchLore('Тихон', bare)).text)).toEqual(['C3 Брат (note): Тихон — брат трактирщицы Марты.']);
  });

  test('stems: «брата» finds the note keyed «брат»', async () => {
    const out = await searchLore('брата', loreCtx());
    expect(rows(out.text)).toEqual(['C3 Брат (note): Тихон — брат трактирщицы Марты.']);
  });

  test('lexScore ranking: more matched words first (the innkeeper over «Брат Алексей» for «брат трактирщица»)', async () => {
    const world = book('Мир', [
      entry('a', 'Брат Алексей', 'Брат Алексей, кузнец.', { keys: ['брат Алексей'] }),
      entry('b', 'Марта', 'Марта, трактирщица «Гуся». Её брат пропал с караваном.', { keys: ['Марта'] }),
    ]);
    const ctx = ctxFor(chatView(['Hello.']), { lore: [{ key: 'world', book: world }] });
    expect(rows((await searchLore('брат трактирщица', ctx)).text).map((l) => l.slice(0, 12))).toEqual(['L1 Марта (Ми', 'L2 Брат Алек']);
    // Inflected query words still find both.
    expect(rows((await searchLore('брата трактирщицы', ctx)).text)).toHaveLength(2);
  });

  test('ties: a key match first, then rank (lore order; a note by its last change)', async () => {
    const world = book('W', [
      entry('lo', 'Low', 'The lamp.', { order: 10, keys: ['x'] }),
      entry('hi', 'High', 'The lamp.', { order: 200, keys: ['y'] }),
      entry('key', 'Keyed', 'Nothing.', { order: 1, keys: ['lamp'] }),
    ]);
    const ctx = ctxFor(chatView(['Hello.']), { lore: [{ key: 'w', book: world }] });
    expect(rows((await searchLore('lamp', ctx)).text).map((l) => l.split(' ')[1])).toEqual(['Keyed', 'High', 'Low']);
    // Two notes equal on words: the one changed last comes first.
    const two = foldCompendium(
      [row(1, [noteOp('Alpha', 'The lamp is lit.', ['a'])]), row(2, [noteOp('Beta', 'The lamp is out.', ['b'])]), row(5, [{ op: 'edit', ref: 'note:alpha', set: { content: 'The lamp is lit again.' } }])],
      { pathSet: new Set() },
    );
    const nctx = ctxFor(chatView(['Hello.']), { compendium: two });
    expect(rows((await searchLore('lamp', nctx)).text).map((l) => l.split(' ')[1])).toEqual(['Alpha', 'Beta']);
  });

  test(`at most ${LORE_HITS_MAX} rows, then how many more match`, async () => {
    const out = await searchLore('lamp', loreCtx());
    expect(rows(out.text)).toHaveLength(LORE_HITS_MAX);
    expect(out.text.split('\n').at(-1)).toBe('15 more match; add a word to narrow it.');
    expect(out.summary).toBe('10 hits');
  });

  test(`the snippet: about ${LORE_SNIPPET} characters around the first match in the text; the head when only the title or a key matched`, async () => {
    const long = `${'дорога '.repeat(60)}ключ от погреба ${'река '.repeat(60)}`;
    const world = book('W', [entry('k', 'Погреб', long, { keys: ['погреб'] }), entry('t', 'Колодец', `${'вода '.repeat(80)}`, { keys: ['колодец'] })]);
    const ctx = ctxFor(chatView(['Hello.']), { lore: [{ key: 'w', book: world }] });
    const [hit] = rows((await searchLore('ключ', ctx)).text);
    const snippet = hit!.slice('L1 Погреб (W): '.length);
    expect(snippet).toContain('ключ от погреба');
    expect(snippet.startsWith('…') && snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(LORE_SNIPPET + 2);
    const [title] = rows((await searchLore('колодец', ctx)).text);
    expect(title).toMatch(/^L2 Колодец \(W\): вода вода/);
    expect(title!.endsWith('…')).toBe(true);
  });

  test('an untitled entry shows its first plain key; a book with no name shows what it is', async () => {
    const card = book('', [{ id: 'u', content: 'A silver key.', keys: ['/sil+ver/i', 'trinket'], position: 'before' }]);
    const ctx = ctxFor(chatView(['Hello.']), { lore: [{ key: '@card', book: card }] });
    expect((await searchLore('silver', ctx)).text).toBe('L1 trinket (card): A silver key.');
  });

  test('no words, no lore, no match: each says so', async () => {
    const empty = await searchLore('?!', loreCtx());
    expect(empty.error).toBe(true);
    expect(empty.text).toMatch(/no words/);
    const none = await searchLore('lamp', ctxFor(chatView(['Hello.'])));
    expect(none.text).toBe('This chat has no lore or Compendium entries to search.');
    const miss = await searchLore('dragon', loreCtx());
    expect(miss.text).toMatch(/^No lore or Compendium entry matches\. Try/);
    expect(miss.summary).toBe('no hits');
  });

  test('the description asks to search before saying the lore is silent, and names the Compendium entries (D-156)', () => {
    expect(searchLoreTool.description).toMatch(/search before you say the lore does not cover something/);
    expect(searchLoreTool.description).toMatch(/L3.*C2/);
    expect(searchLoreTool.description).toMatch(/the Compendium entries \(characters, places, items, events, plots/);
    expect(readLoreTool.description).toMatch(/Compendium entries whole/);
  });
});

describe('read_lore', () => {
  test('the full text of each handle, in the order asked: `<handle> <title> (<book>):\\n<content>`', async () => {
    const ctx = loreCtx();
    await searchLore('ledger', ctx); // C1 Ledger, L1 Mira
    const out = await readLore(['L1', 'C1'], ctx);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe('L1 Mira (Harbor):\nKeeps the second ledger. Her sister drowned.\n\nC1 Ledger (note):\n[Memory: Ledger]\nMira keeps the second ledger in the cellar.');
    expect(out.summary).toBe('2 read');
  });

  test('handles are read as models write them: case, brackets, quotes, zero padding', async () => {
    const ctx = loreCtx();
    await searchLore('sister', ctx);
    for (const h of ['l1', '[L1]', ' "L01" ', '#L1']) expect((await readLore([h], ctx)).text).toMatch(/^L1 Mira \(Harbor\):/);
    // A bare string is one handle.
    expect((await readLore('L1', ctx)).text).toMatch(/^L1 Mira/);
  });

  test('a note goes by its /memory handle: search_lore lists it so, read_lore reads it with no search before, in any turn', async () => {
    const compendium = foldCompendium(
      [row(1, [noteOp('Брат Марфы', 'Младшего брата Марфы зовут Тихон.', ['брат'])]), row(2, [noteOp('Мельник', 'Мельник должен Марфе три серебряка.', ['мельник'])])],
      { pathSet: new Set() },
    );
    expect(noteRefs(compendium).map((r) => `${r.ref} ${r.entry.name}`)).toEqual(['C1 Брат Марфы', 'C2 Мельник']);
    const ctx = loreCtx({}, compendium);
    expect(rows((await searchLore('мельник', ctx)).text)).toEqual(['C2 Мельник (note): Мельник должен Марфе три серебряка.']);
    expect(resolveNoteRef(compendium, 'C2')?.name).toBe('Мельник');
    // The next turn: a fresh table, no search yet; a Cyrillic С reads as C.
    for (const h of ['C2', 'c2', 'С2']) {
      const next = loreCtx({ handles: new HandleTable() }, compendium);
      expect((await readLore([h], next)).text).toBe('C2 Мельник (note):\n[Memory: Мельник]\nМельник должен Марфе три серебряка.');
    }
    const next = loreCtx({ handles: new HandleTable() }, compendium);
    expect((await readLore(['C1', 'C3'], next)).text).toBe(
      'C1 Брат Марфы (note):\n[Memory: Брат Марфы]\nМладшего брата Марфы зовут Тихон.\n\n"C3": no such handle. Use the handles search_lore gave, like L3 or C2.',
    );
  });

  test('handles sent as one string are split at commas and spaces, also through the argument chain', async () => {
    const ctx = loreCtx();
    await searchLore('ledger', ctx); // C1 Ledger, L1 Mira
    const both = 'L1 Mira (Harbor):\nKeeps the second ledger. Her sister drowned.\n\nC1 Ledger (note):\n[Memory: Ledger]\nMira keeps the second ledger in the cellar.';
    for (const ids of ['L1, C1', 'L1 C1', ['L1, C1'], ['L1;C1'], '[L1, C1]', 'L1，C1']) expect([ids, (await readLore(ids, ctx)).text]).toEqual([ids, both]);
    const tools = new Map([[readLoreTool.name, readLoreTool]]);
    for (const args of ['{"ids":"L1, C1"}', '{"ids":"L1 C1"}', '{"ids":["L1, C1"]}']) {
      const [o] = await runTools({ calls: [{ id: 'x', name: 'read_lore', args, round: 1, via: 'native' }], tools, ctx, roomChars: 9000 }, () => new Date(0));
      expect([args, o!.ok, o!.text]).toEqual([args, true, both]);
    }
  });

  test('a handle wrapped with spaces inside, or written with its title, reads cleanly: no bogus unknowns', async () => {
    const ctx = loreCtx();
    await searchLore('ledger', ctx); // C1 Ledger, L1 Mira
    const one = 'L1 Mira (Harbor):\nKeeps the second ledger. Her sister drowned.';
    const both = `${one}\n\nC1 Ledger (note):\n[Memory: Ledger]\nMira keeps the second ledger in the cellar.`;
    for (const ids of [['« L1 »'], ['[ L1 ]'], ['" L1 "'], ['L1 (Mira)'], ['L1 Mira']]) {
      const out = await readLore(ids, ctx);
      expect([ids, out.text, out.summary]).toEqual([ids, one, '1 read']);
    }
    const out = await readLore(['L1 Mira', 'C1 Ledger'], ctx);
    expect([out.text, out.summary]).toEqual([both, '2 read']);
    // A handle-shaped unknown beside a known one is still told; a title alone stays one unknown id.
    expect((await readLore(['L1, L9'], ctx)).text).toBe(`${one}\n\n"L9": no such handle. Use the handles search_lore gave, like L3 or C2.`);
    expect((await readLore(['Second ledger'], ctx)).text).toBe('"Second ledger": no such handle. Use the handles search_lore gave, like L3 or C2.');
  });

  test('an unknown handle gets one line naming it; all unknown is an error; a handle asked twice is shown once', async () => {
    const ctx = loreCtx();
    expect((await readLore(['L1'], ctx)).text).toBe('"L1": no such handle. Use the handles search_lore gave, like L3 or C2.');
    await searchLore('sister', ctx);
    const mixed = await readLore(['L99', 'Mira', 'L1', 'l1'], ctx);
    expect(mixed.error).toBeUndefined();
    expect(mixed.text.split('\n\n')).toEqual([
      '"L99": no such handle. Use the handles search_lore gave, like L3 or C2.',
      '"Mira": no such handle. Use the handles search_lore gave, like L3 or C2.',
      'L1 Mira (Harbor):\nKeeps the second ledger. Her sister drowned.',
    ]);
    expect(mixed.summary).toBe('1 read, 2 unknown');
    const bad = await readLore(['C9'], ctx);
    expect(bad.error).toBe(true);
    expect((await readLore([], ctx)).error).toBe(true);
  });

  test(`at most ${READ_LORE_MAX} characters in all: a long entry is cut with what is left, later ones are named for another call`, async () => {
    const big = book('Big', [entry('a', 'A', 'a'.repeat(5000), { keys: ['lamp'] }), entry('b', 'B', 'b'.repeat(5000), { keys: ['lamp'] }), entry('c', 'C', 'c'.repeat(5000), { keys: ['lamp'] })]);
    const ctx = ctxFor(chatView(['Hello.']), { lore: [{ key: 'big', book: big }] });
    await searchLore('lamp', ctx);
    expect(readLoreTool.maxOutput!(ctx)).toBe(READ_LORE_MAX);
    const out = await readLore(['L1', 'L2', 'L3'], ctx);
    expect(out.text.length).toBeLessThanOrEqual(READ_LORE_MAX);
    expect(out.text).toContain(`L1 A (Big):\n${'a'.repeat(5000)}\n\nL2 B (Big):\nbbb`);
    expect(out.text).toMatch(/\n\[L2 continues for \d+ more characters past the 8000-character limit\]\n\nNot shown, the result is full: L3\. Call read_lore with them again\.$/);
    expect(out.summary).toBe('2 read, 1 not shown');
    expect((await readLore(['L3'], ctx)).text).toBe(`L3 C (Big):\n${'c'.repeat(5000)}`);
    // One entry alone past the limit: its head and the note.
    const huge = book('Huge', [entry('h', 'H', 'h'.repeat(20000), { keys: ['lamp'] })]);
    const hctx = ctxFor(chatView(['Hello.']), { lore: [{ key: 'huge', book: huge }] });
    await searchLore('lamp', hctx);
    const one = await readLore(['L1'], hctx);
    expect(one.text.length).toBeLessThanOrEqual(READ_LORE_MAX);
    expect(one.text).toMatch(/\[L1 continues for \d+ more characters past the 8000-character limit\]$/);
  });
});
