// M5a D-141 / D-142: the session's library books seed the Compendium once per (ids, on/off, books
// table, file mtime+size), and their Compendium entries leave the lore engine (routing) unless the book
// is 'off' or the Compendium is disabled. Requests with no typed entry stay the M4 bytes.
import { describe, expect, test } from 'bun:test';
import type { SessionImpl } from '../../src/engine/session.ts';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/entries.ts';
import { bookSession, calls, fullCaps, LANTERN, LIGHTHOUSE, MIRA_ENTRY, ok, PLAIN, putBook, rewriteBook, rig, srcTexts, textOfPrompt } from './kit.ts';

const keysOf = (s: { view(): { compendium: { entries: ReadonlyMap<string, unknown> } } }): string[] => [...s.view().compendium.entries.keys()];

describe('the library seed (D-141)', () => {
  test('a book with typed entries seeds view().compendium; its typed entries leave the lore (D-142)', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    expect(DEFAULT_SESSION_CONFIG.compendium).toEqual({ enabled: true });
    expect(keysOf(s)).toEqual([`lib:${id}:e1`, `lib:${id}:e2`]);
    const mira = s.view().compendium.entries.get(`lib:${id}:e1`)!;
    expect(mira).toMatchObject({ type: 'character', name: 'Мира', aliases: ['Фонарщица'], origin: { kind: 'library', book: id, id: 'e1', overlay: false } });

    const p = ok(s.preview({ explain: true }));
    // The lore engine never saw the typed entries: no verdict, no lore message; the plain ones run.
    const judged = p.verdicts!.filter((v) => v.book === id).map((v) => v.id);
    expect(judged.sort()).toEqual(['e3', 'e4']);
    // Its lore text is nowhere (the block renders the entry's data, not the book's content).
    expect(p.messages.map(textOfPrompt).join('\n')).not.toContain('Мира — младшая фонарщица Вельмара.');
    expect(srcTexts(p.messages, `lore:${id}:e3`)).toEqual(['В гавани пахнет солью.']);
    expect(srcTexts(p.messages, 'compendium:block')).toHaveLength(1);
    await r.engine.close();
  });

  test("an 'off' book and a disabled Compendium: no seed, the typed entries are plain lore again", async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    for (const compendium of [{ enabled: true, books: { [id]: 'off' as const } }, { enabled: false }]) {
      // The lore engine matches keys literally: "Мира" as written.
      const s = bookSession(r.engine, [id], { text: 'Где Мира?', config: { compendium } });
      expect(keysOf(s)).toEqual([]);
      const p = ok(s.preview({ explain: true }));
      expect(p.verdicts!.find((v) => v.book === id && v.id === 'e1')).toMatchObject({ fired: true });
      expect(p.messages.map(textOfPrompt).join('\n')).toContain('Мира — младшая фонарщица Вельмара.');
      expect(srcTexts(p.messages, 'compendium:block')).toEqual([]);
      expect(p.trace.compendium).toBeUndefined();
      await s.close();
    }
    await r.engine.close();
  });

  test('a book shadowed by a later book of the same name seeds nothing', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const a = putBook(r.home, LANTERN, 'Lantern A');
    const b = putBook(r.home, { name: 'Lantern', entries: [LIGHTHOUSE] }, 'Lantern B');
    const s = bookSession(r.engine, [a, b]);
    // Both books are named "Lantern": the later one is read, the first one is not (a world is read once by name).
    expect(keysOf(s)).toEqual([`lib:${b}:e2`]);
    await r.engine.close();
  });

  test('the same seed and view while nothing changed; a changed file or config loads again', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]) as SessionImpl;
    const seed = s.library().seed;
    const view = s.view();
    expect(s.library().seed).toBe(seed);
    expect(s.view()).toBe(view);
    // A preview does not load again either.
    ok(s.preview());
    expect(s.library().seed).toBe(seed);

    // The book file changes (another size): a new seed, a new view with the new text.
    const changed = { ...LANTERN, entries: [{ ...MIRA_ENTRY, meta: { ...MIRA_ENTRY.meta, data: { name: 'Мира', description: 'Старшая фонарщица гильдии, давно не спит по ночам.' } } }, LIGHTHOUSE] };
    rewriteBook(r.home, id, changed);
    const seed2 = s.library().seed;
    expect(seed2).not.toBe(seed);
    expect(s.view()).not.toBe(view);
    expect(s.view().compendium.entries.get(`lib:${id}:e1`)!.data.description).toBe('Старшая фонарщица гильдии, давно не спит по ночам.');
    expect(s.view().compendium.rev).not.toBe(view.compendium.rev);

    // A config change of what is read: books off → the empty seed.
    s.configure({ compendium: { books: { [id]: 'off' } } });
    expect(s.library().seed).not.toBe(seed2);
    expect(keysOf(s)).toEqual([]);
    // A config change the books do not depend on keeps the seed.
    s.configure({ compendium: { books: { [id]: 'read' } } });
    const seed3 = s.library().seed;
    s.configure({ compendium: { profile: 'lite' } });
    expect(s.library().seed).toBe(seed3);
    await r.engine.close();
  });
});

describe('byte-identical requests without typed entries (D-155)', () => {
  test('a plain book: the same request with the Compendium on or off, and no trace key', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, PLAIN);
    const on = bookSession(r.engine, [id]);
    const off = bookSession(r.engine, [id], { config: { compendium: { enabled: false } } });
    on.memoryAdd({ title: 'Маяк', content: 'Маяк погас.' });
    off.memoryAdd({ title: 'Маяк', content: 'Маяк погас.' });
    const a = ok(on.preview());
    const b = ok(off.preview());
    expect(a.messages).toEqual(b.messages);
    expect(a.trace.compendium).toBeUndefined();
    expect(b.trace.compendium).toBeUndefined();
    expect(a.trace.lore).toEqual(b.trace.lore);
    expect(srcTexts(a.messages, 'compendium:@notes:note:маяк')).toHaveLength(1);
    await r.engine.close();
  });

  test('typed entries none of which is picked: trace.compendium with no picks, the messages unchanged', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const on = bookSession(r.engine, [id], { text: 'Привет.' });
    const off = bookSession(r.engine, [id], { text: 'Привет.', config: { compendium: { enabled: false } } });
    const a = ok(on.preview());
    const b = ok(off.preview());
    expect(a.trace.compendium).toMatchObject({ picks: [], injected: [], cut: [], budget: { block: 0 } });
    expect(b.trace.compendium).toBeUndefined();
    // The typed entries did not fire as lore with the Compendium off either: the same messages.
    expect(a.messages).toEqual(b.messages);
    await r.engine.close();
  });
});
