// M2 (§5.10, §10.3): lore fires ride the turn's trace — `prep` and the committed msg / continue edit
// — and the timers of later turns are derived from them along the path: a sticky entry keeps
// firing for its window and stops after it, a swipe never sees the replaced answer's fires, and a
// continue's own fires count.
import { describe, expect, test } from 'bun:test';
import { book, calls, continueEdits, entry, firedOf, msgTrace, prepOf, rig, run, say, session, writeLibrary } from './kit.ts';

const LORE = 'DRAGON-LORE';
/** Did the request of call n carry the entry's text? */
const sentLore = (r: { provider: { requests: { messages: unknown }[] } }, n: number): boolean => JSON.stringify(r.provider.requests[n]!.messages).includes(LORE);

describe('sticky across turns', () => {
  test('fires on its key, keeps firing as sticky inside the window, stops after it', async () => {
    const r = await rig(calls([{ text: 'A quiet answer.' }], [{ text: 'Another.' }], [{ text: 'A third.' }], [{ text: 'A fourth.' }]));
    // sticky 3: the window is [L, L+3) in chat length; two messages a turn, so the next turn is in it
    // and the one after is not.
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('dragon', LORE, { keys: ['dragon'], sticky: 3 })]));
    const { s } = session(r.engine, ['w'], 'I saw a dragon.');
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    const a2 = await say(s, 'Let us walk on.'); // no key in scan range: sticky only
    const a3 = await say(s, 'And on.'); // window closed
    const a4 = await say(s, 'The dragon again!'); // a fresh key fire

    expect(firedOf(msgTrace(r.home, s.id, t1.messageId))).toEqual(['w:dragon:key']);
    expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual(['w:dragon:sticky']);
    expect(firedOf(msgTrace(r.home, s.id, a3.id))).toEqual([]);
    expect(firedOf(msgTrace(r.home, s.id, a4.id))).toEqual(['w:dragon:key']);
    expect([0, 1, 2, 3].map((n) => sentLore(r, n))).toEqual([true, true, false, true]);

    // The prep line carries the same fires (recovery commits an interrupted answer with them).
    expect(firedOf(prepOf(r.home, s.id, t1.messageId)?.trace)).toEqual(['w:dragon:key']);
    expect(firedOf(prepOf(r.home, s.id, a2.id)?.trace)).toEqual(['w:dragon:sticky']);
    // ...and the path view folds them.
    expect(s.view().fires.map((f) => f.msgId)).toEqual([t1.messageId, a2.id, a4.id]);
    await r.engine.close();
  });
});

describe('hidden messages and the timers (ST: the timed effects run on the chat without hidden messages)', () => {
  test('a message hidden between sticky turns does not count: the window stays open one message longer', async () => {
    // sticky 4 from a fire at chat length 2 (greeting, U1): the window is [2, 6). The third turn runs
    // at chat length 6 with every message shown (closed), at 5 once U2 is hidden (still open).
    const play = async (hideU2: boolean): Promise<{ third: string[]; sent: boolean }> => {
      const r = await rig(calls([{ text: 'A quiet answer.' }], [{ text: 'Another.' }], [{ text: 'A third.' }]));
      writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('dragon', LORE, { keys: ['dragon'], sticky: 4 })]));
      const { s } = session(r.engine, ['w'], 'I saw a dragon.');
      await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
      const a2 = await say(s, 'Let us walk on.');
      expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual(['w:dragon:sticky']);
      if (hideU2) {
        const u2 = s.view().path.at(-2)!;
        expect(u2.role).toBe('user');
        s.hide({ messageId: u2.id, hidden: true, expectedVersion: s.version() });
      }
      const a3 = await say(s, 'And on.');
      const out = { third: firedOf(msgTrace(r.home, s.id, a3.id)), sent: sentLore(r, 2) };
      await r.engine.close();
      return out;
    };
    expect(await play(false)).toEqual({ third: [], sent: false });
    expect(await play(true)).toEqual({ third: ['w:dragon:sticky'], sent: true });
  });
});

describe('swipe isolation', () => {
  test("a swipe does not see the replaced answer's fires; the next reply does", async () => {
    const r = await rig(calls([{ text: 'First.' }], [{ text: 'Swiped.' }], [{ text: 'Reply.' }]));
    // cooldown 10: once fired, the entry is blocked for the next turns of that path.
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('dragon', LORE, { keys: ['dragon'], cooldown: 10 })]));
    const { s } = session(r.engine, ['w'], 'A dragon!');
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    expect(firedOf(msgTrace(r.home, s.id, t1.messageId))).toEqual(['w:dragon:key']);

    // The swipe regrows the answer from U: A1's fire (and its cooldown) is not on that path.
    const sw = s.runTurn({ kind: 'swipe', expectedVersion: s.version() });
    const { out } = await run(sw);
    expect(out.type).toBe('done');
    expect(firedOf(msgTrace(r.home, s.id, sw.messageId))).toEqual(['w:dragon:key']);
    expect(sentLore(r, 1)).toBe(true);

    // A reply after the swipe is on the swipe's path: its fire starts the cooldown there.
    const a3 = await say(s, 'The dragon roars.');
    expect(firedOf(msgTrace(r.home, s.id, a3.id))).toEqual([]);
    expect(sentLore(r, 2)).toBe(false);
    // The path holds the swipe's fire only.
    expect(s.view().fires.map((f) => f.msgId)).toEqual([sw.messageId]);
    await r.engine.close();
  });
});

describe('continue', () => {
  test("a continue's edit carries its fires; they count for the next turns", async () => {
    const r = await rig(calls([{ text: 'Wings unfold: a dragon' }], [{ text: ' lands.' }], [{ text: 'Later.' }]));
    // Scan depth 1: only the newest message is scanned, so the reply (head U) cannot see the key in
    // its own answer, the continue (head A) can.
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('dragon', LORE, { keys: ['dragon'], sticky: 4, scanDepth: 1 })]));
    const { s } = session(r.engine, ['w'], 'What comes?');
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    expect(firedOf(msgTrace(r.home, s.id, t1.messageId))).toEqual([]);

    const c = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    const { out } = await run(c);
    expect(out.type).toBe('done');
    const edits = continueEdits(r.home, s.id, t1.messageId);
    expect(edits).toHaveLength(1);
    expect(firedOf(edits[0]!.trace)).toEqual(['w:dragon:key']);
    expect(sentLore(r, 1)).toBe(true);
    expect(s.view().fires).toEqual([{ msgId: t1.messageId, fired: [{ book: 'w', id: 'dragon', why: 'key' }], continued: true, names: { w: 'World' } }]);

    // The next reply has no key in range but is inside the continue's sticky window.
    const a2 = await say(s, 'And then?');
    expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual(['w:dragon:sticky']);
    expect(sentLore(r, 2)).toBe(true);
    await r.engine.close();
  });
});
