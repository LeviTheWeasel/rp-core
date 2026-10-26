// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M2 fix: lore timers through a real engine against SillyTavern's WorldInfoTimedEffects
// (world-info.js 503-817). Three things ST does that the derived timers now reproduce:
// - the cooldown after a sticky window is re-armed at the first scan at or after the window's end
//   (onEnded.sticky), not exactly at L + S — with two messages a turn and odd S and D that is a turn;
// - a continue scans at the continued message's index + 1, so the windows it starts end one message
//   later, and a second continue of the same answer drops the first one's effects (chat not advanced);
// - timers belong to a world by name: when the same world is read under another key mid-chat (the
//   card's own book shadowed by a same-named session book, or back), its open windows go on.
import { describe, expect, test } from 'bun:test';
import type { LoreBook } from '../../src/formats/native.ts';
import { MIRA } from '../engine/kit.ts';
import { book, calls, continueEdits, entry, firedOf, msgTrace, rig, run, say, session, writeLibrary } from './kit.ts';
import { LEVI } from './kit.ts';

type Eff = { start: number; end: number; protected: boolean };

/**
 * A line-by-line model of ST's timed effects for one entry whose key is in every scan: the sticky
 * and cooldown checks (#checkTimedEffectOfType, with onEnded.sticky re-arming a protected cooldown),
 * then checkWorldInfo's order (cooldown && !sticky → suppressed; sticky → reinjected; else the key),
 * then setTimedEffects for the activated entry.
 */
function stModel(scans: readonly number[], S: number, D: number): string[] {
  const meta: { sticky?: Eff; cooldown?: Eff } = {};
  return scans.map((C) => {
    let sticky = false;
    let cooldown = false;
    if (meta.sticky) {
      const v = meta.sticky;
      if (C <= v.start && !v.protected) delete meta.sticky;
      else if (C >= v.end) {
        delete meta.sticky;
        if (D) meta.cooldown = { start: C, end: C + D, protected: true };
      } else sticky = true;
    }
    if (meta.cooldown) {
      const v = meta.cooldown;
      if (C <= v.start && !v.protected) delete meta.cooldown;
      else if (C >= v.end) delete meta.cooldown;
      else cooldown = true;
    }
    const fired = cooldown && !sticky ? null : sticky ? 'sticky' : 'key';
    if (fired) {
      if (S && !meta.sticky) meta.sticky = { start: C, end: C + S, protected: false };
      if (D && !meta.cooldown) meta.cooldown = { start: C, end: C + D, protected: false };
    }
    return `${C}:${fired ?? '-'}`;
  });
}

/** The core over `turns` replies, the key said every turn (scan depth 1: only the user's message). */
async function coreRun(S: number, D: number, turns: number): Promise<string[]> {
  const r = await rig(calls(...Array.from({ length: turns }, (_, i) => [{ text: `Answer ${i}.` }])));
  writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('e', 'LORE', { keys: ['dragon'], sticky: S, cooldown: D, scanDepth: 1 })]));
  const { s } = session(r.engine, ['w'], 'A dragon!');
  const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
  await run(t1);
  const label = (id: string): string => firedOf(msgTrace(r.home, s.id, id))[0]?.split(':')[2] ?? '-';
  // greeting + user: the first answer is written at chat length 2, then every two messages.
  const out = [`2:${label(t1.messageId)}`];
  for (let k = 1; k < turns; k++) {
    const a = await say(s, 'The dragon again!');
    out.push(`${2 + 2 * k}:${label(a.id)}`);
  }
  await r.engine.close();
  return out;
}

describe('sticky then cooldown over 9 turns, as SillyTavern', () => {
  const scans = Array.from({ length: 9 }, (_, k) => 2 + 2 * k);
  for (const [S, D] of [
    [3, 3],
    [1, 1],
    [3, 1],
    [5, 3],
    [0, 3],
    [2, 2],
    [1, 2],
    [2, 1],
    [4, 4],
  ] as const) {
    test(`sticky ${S}, cooldown ${D}`, async () => {
      expect(await coreRun(S, D, 9)).toEqual(stModel(scans, S, D));
    });
  }

  test('the sequences the review found wrong (pinned)', () => {
    expect(stModel([2, 4, 6, 8, 10, 12], 3, 3)).toEqual(['2:key', '4:sticky', '6:-', '8:-', '10:key', '12:sticky']);
    expect(stModel([2, 4, 6, 8], 1, 1)).toEqual(['2:key', '4:-', '6:key', '8:-']);
  });
});

describe('a continue scans one message later', () => {
  /** Reply 'A dragon' to a keyless message, then continue it (the key is only in the answer). */
  async function continued(more: { sticky?: number; cooldown?: number }, extra: { text: string }[][] = []) {
    const r = await rig(calls([{ text: 'A dragon' }], [{ text: ' lands.' }], ...extra));
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('dragon', 'DRAGON-LORE', { keys: ['dragon'], scanDepth: 1, ...more })]));
    const { s } = session(r.engine, ['w'], 'What comes?');
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    expect(firedOf(msgTrace(r.home, s.id, t1.messageId))).toEqual([]);
    const c = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    expect((await run(c)).out.type).toBe('done');
    expect(firedOf(continueEdits(r.home, s.id, t1.messageId)[0]!.trace)).toEqual(['w:dragon:key']);
    return { r, s, answer: t1.messageId };
  }

  test("cooldown 2 started by a continue still blocks the next reply (ST's window [3, 5) holds the scan at 4)", async () => {
    const { r, s } = await continued({ cooldown: 2 }, [[{ text: 'Later.' }]]);
    const a2 = await say(s, 'The dragon?');
    expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual([]);
    await r.engine.close();
  });

  test('sticky 2 started by a continue reinjects in the next reply', async () => {
    const { r, s } = await continued({ sticky: 2 }, [[{ text: 'Later.' }]]);
    const a2 = await say(s, 'And then?');
    expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual(['w:dragon:sticky']);
    await r.engine.close();
  });

  test("a second continue of the same answer does not see the first one's cooldown (ST: chat not advanced)", async () => {
    const { r, s, answer } = await continued({ cooldown: 5 }, [[{ text: ' More.' }]]);
    const c2 = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    expect((await run(c2)).out.type).toBe('done');
    const edits = continueEdits(r.home, s.id, answer);
    expect(edits.map((e) => firedOf(e.trace))).toEqual([['w:dragon:key'], ['w:dragon:key']]);
    await r.engine.close();
  });
});

describe('timers follow a world by name when it changes keys', () => {
  const eldoria = (): LoreBook => book('Eldoria', [entry('x', 'ELDORIA-LORE', { keys: ['dragon'], sticky: 6, scanDepth: 1 })]);

  test("the card's book fires, a same-named session book takes over: its sticky window goes on", async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }], [{ text: 'Three.' }], [{ text: 'Four.' }]));
    writeLibrary(r.home, 'lorebooks', 'eldoria', eldoria());
    const s = r.engine.createSession({ character: { ...MIRA, book: eldoria() }, persona: LEVI, config: { lorebooks: [] } });
    s.send({ text: 'A dragon!', expectedVersion: s.version() });
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    expect(firedOf(msgTrace(r.home, s.id, t1.messageId))).toEqual(['@card:x:key']);
    const a2 = await say(s, 'Walk on.');
    expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual(['@card:x:sticky']);
    // The library's Eldoria now stands in for the card's (a world is read once by name).
    s.configure({ lorebooks: ['eldoria'] });
    const a3 = await say(s, 'Walk on.'); // chat length 6, inside [2, 8)
    expect(firedOf(msgTrace(r.home, s.id, a3.id))).toEqual(['eldoria:x:sticky']);
    // ...and back: the card's book is read again, the window still holds until 8.
    s.configure({ lorebooks: [] });
    const a4 = await say(s, 'Walk on.'); // chat length 8: the window [2, 8) is closed
    expect(firedOf(msgTrace(r.home, s.id, a4.id))).toEqual([]);
    expect(msgTrace(r.home, s.id, a3.id)?.loreNames).toEqual({ eldoria: 'Eldoria' });
    await r.engine.close();
  });

  test('back from a session book to the card: the window it opened goes on', async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }]));
    writeLibrary(r.home, 'lorebooks', 'eldoria', eldoria());
    const s = r.engine.createSession({ character: { ...MIRA, book: eldoria() }, persona: LEVI, config: { lorebooks: ['eldoria'] } });
    s.send({ text: 'A dragon!', expectedVersion: s.version() });
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    expect(firedOf(msgTrace(r.home, s.id, t1.messageId))).toEqual(['eldoria:x:key']);
    s.configure({ lorebooks: [] });
    const a2 = await say(s, 'Walk on.');
    expect(firedOf(msgTrace(r.home, s.id, a2.id))).toEqual(['@card:x:sticky']);
    await r.engine.close();
  });
});
