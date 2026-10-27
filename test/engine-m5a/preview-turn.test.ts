// M5a, review prompt#6: /preview --turn names a Compendium change: trace.compendium.rev (the rows and
// the library seed) sees a verb's edit, and inputsChanged compares it. trace.loreHashes hash the books
// as loaded, before routing (the lead's ruling I): the Compendium turned on or off is "the Compendium",
// never a changed book; a typed entry edited in its book file is both.
import { describe, expect, test } from 'bun:test';
import { bookSession, calls, entriesOf, fullCaps, LANTERN, ok, putBook, rewriteBook, rig, turnOf } from './kit.ts';

const changedNotice = (p: ReturnType<typeof ok>): string | undefined => p.notices.find((n) => n.code === 'preview_inputs_changed')?.message;

describe('preview --turn and the Compendium', () => {
  test('nothing changed: no notice', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const t = await turnOf(s);
    if (t.out.type !== 'done') throw new Error(t.out.type);
    expect(changedNotice(ok(s.preview({ turn: t.out.message.id })))).toBeUndefined();
    await r.engine.close();
  });

  test('an entry edited by a verb: "the Compendium", not the author\'s note', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const t = await turnOf(s);
    if (t.out.type !== 'done') throw new Error(t.out.type);
    s.memoryEdit({ ref: 'Мира', set: { role: 'antagonist', likes: ['шторм', 'тёмные окна', 'чужие письма'] } });
    const message = changedNotice(ok(s.preview({ turn: t.out.message.id })));
    expect(message).toContain('the Compendium');
    expect(message).not.toContain("the author's note");
    expect(message).not.toContain('lorebook');
    await r.engine.close();
  });

  test('a typed entry edited in its book file: the book and "the Compendium", even when the block reads the same', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const t = await turnOf(s);
    if (t.out.type !== 'done') throw new Error(t.out.type);
    const before = ok(s.preview({ turn: t.out.message.id })).messages;
    // A service field the render never shows: the entry changed, its block text did not.
    const mira = LANTERN.entries[0]!;
    const data = { ...(mira.meta!.data as Record<string, unknown>), source_turn: 3 };
    rewriteBook(r.home, id, { ...LANTERN, entries: [{ ...mira, meta: { ...mira.meta!, data } }, ...LANTERN.entries.slice(1)] });
    const p = ok(s.preview({ turn: t.out.message.id }));
    expect(p.messages).toEqual(before);
    expect(changedNotice(p)).toBe(`Since this answer was written, lorebook ${id}, the Compendium changed: the preview is built with today's.`);
    await r.engine.close();
  });

  test('the Compendium turned on or off, the book file untouched: "the Compendium", never the book (ruling I)', async () => {
    const hashes: Record<string, string>[] = [];
    for (const was of [false, true]) {
      const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
      const id = putBook(r.home, LANTERN);
      const s = bookSession(r.engine, [id], { config: { compendium: { enabled: was } } });
      const t = await turnOf(s);
      if (t.out.type !== 'done') throw new Error(t.out.type);
      // The answer's trace hashed the book as loaded, typed entries and all, whether or not they were routed.
      const prep = entriesOf(r.home, s.id).find((e) => e.t === 'prep');
      if (prep?.t !== 'prep') throw new Error('no prep entry');
      expect(Object.keys(prep.trace.loreHashes)).toEqual([id]);
      expect(prep.trace.compendium !== undefined).toBe(was);
      hashes.push(prep.trace.loreHashes);
      s.configure({ compendium: { enabled: !was } });
      expect(changedNotice(ok(s.preview({ turn: t.out.message.id })))).toBe("Since this answer was written, the Compendium changed: the preview is built with today's.");
      await r.engine.close();
    }
    expect(hashes[1]).toEqual(hashes[0]!);
  });
});
