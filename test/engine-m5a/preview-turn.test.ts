// M5a, review prompt#6: /preview --turn names a Compendium change: trace.compendium.rev (the rows and
// the library seed) sees a verb's edit, and inputsChanged compares it. trace.loreHashes hash the books
// as loaded, before routing (the lead's ruling I): the Compendium turned on or off is "the Compendium",
// never a changed book; a typed entry edited in its book file is both.
// M5b (the lead's ruling H): a {{recap}} slot that came, went or changed is "the {{recap}} slot", not
// "the text of the system blocks"; a change of the Compendium explains it.
import { describe, expect, test } from 'bun:test';
import type { EntryInput, MsgEntry } from '../../src/session/entries.ts';
import { bookSession, calls, drain, entriesOf, fullCaps, LANTERN, LEVI, MIRA, ok, putBook, rewriteBook, rig, turnOf, writeRaw } from './kit.ts';

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

describe('preview --turn and the {{recap}} slot (M5b)', () => {
  const TS = '2026-10-28T12:00:00.000Z';
  const LINE = 'the lamp flickers over the grey harbour while we walk along the old pier together';

  /** A 1 600-token session: 15 exchanges the budget trims, a historian row (a summary and its arc) over the first three; one swipe of the head answer. */
  async function slotted() {
    const r = await rig(calls([{ text: 'She smiles.' }]));
    const s0 = r.engine.createSession({ character: MIRA, persona: LEVI, config: { window: 1600 } });
    let parent = s0.view().path[0]!.id;
    const id = s0.id;
    await s0.close();
    const rows: EntryInput[] = [];
    for (let k = 1; k <= 15; k++) {
      rows.push(
        { t: 'msg', ts: TS, id: `u${k}`, parent, role: 'user', blocks: [{ k: 'text', text: `I say ${k}: ${LINE}.` }] },
        { t: 'msg', ts: TS, id: `a${k}`, parent: `u${k}`, role: 'assistant', blocks: [{ k: 'text', text: `She says ${k}: ${LINE}.` }] },
      );
      parent = `a${k}`;
    }
    rows.push({
      t: 'mem',
      ts: TS,
      key: 'hist:u1-a3',
      on: 'a3',
      by: 'historian',
      range: ['u1', 'a3'],
      ops: [
        { op: 'file', type: 'summary', data: { title: 'The fog', parent_plot: 'The Lantern', summary: 'Fog fell on the harbour.' } },
        { op: 'arc', plot: 'The Lantern', overview: 'The lamp of the harbour went out.' },
      ],
    });
    writeRaw(r.home, id, (log) => {
      for (const row of rows) log.append(row);
    });
    const s = r.engine.session(id);
    const turn = s.runTurn({ kind: 'swipe', expectedVersion: s.version() });
    await drain(turn);
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(out.type);
    const sent = entriesOf(r.home, id).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
    expect(sent.trace!.recap.ids).toEqual(['summary:a3.0']);
    return { ...r, s, answer: out.message.id };
  }

  test('a slot that went with a wider window: "the {{recap}} slot", not "the text of the system blocks"', async () => {
    const r = await slotted();
    expect(changedNotice(ok(r.s.preview({ turn: r.answer })))).toBeUndefined();
    // Nothing is cut in the model's whole window: no summary precedes a cut, the slot is empty.
    r.s.configure({ window: 8192 });
    const p = ok(r.s.preview({ turn: r.answer }));
    expect(p.messages.some((m) => m.src === 'recap')).toBe(false);
    const message = changedNotice(p);
    expect(message).toContain('the {{recap}} slot');
    expect(message).toContain('the window (1600/');
    expect(message).not.toContain('the text of the system blocks');
    await r.engine.close();
  });

  test('a slot that went with the Compendium: "the Compendium" explains it', async () => {
    const r = await slotted();
    r.s.configure({ compendium: { enabled: false } });
    const message = changedNotice(ok(r.s.preview({ turn: r.answer })));
    expect(message).toContain('the Compendium');
    expect(message).not.toContain('the {{recap}} slot');
    expect(message).not.toContain('the text of the system blocks');
    await r.engine.close();
  });
});
