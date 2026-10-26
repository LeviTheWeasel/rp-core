// Ported from Bunraku:src/core/lore/engine/timers.test.ts@702d8120 (window cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lore/timers.ts: ST's sticky/cooldown/delay arithmetic in path messages, and fires from a PathView.
// Window cases adapted from Bunraku src/core/lore/engine/timers.test.ts @702d8120 (messagesAgo in
// replies → chat lengths in path messages).
import { describe, expect, test } from 'bun:test';
import { foldView } from '../../src/session/fold.ts';
import type { EntryInput } from '../../src/session/entries.ts';
import { chatLengthAt, cooldownLeft, delayLeft, isSticky, pathFires, pathScans, stickyLeft, timerState, type PastFire } from '../../src/lore/timers.ts';
import { entryKey } from '../../src/lore/engine.ts';
import { head, hide, makeHeader, msg, seqd, text, traceWith, TS } from '../session/fixtures.ts';

const K = entryKey('b', 'e1');
const fire = (at: number, why = 'key', id = 'e1'): PastFire => ({ book: 'b', id, why, at });

describe('sticky then cooldown (ST windows, in chat messages)', () => {
  // A fresh fire at chat length 4, sticky 3, cooldown 2: sticky while C < 7, cooldown while 7 <= C < 9.
  const fires = [fire(4)];
  const at = (c: number) => timerState(fires, c);

  test('sticky window [L, L+S): open at 5 and 6, closed at 7', () => {
    expect([5, 6, 7, 8].map((c) => isSticky(at(c), K, 3))).toEqual([true, true, false, false]);
    expect([5, 6, 7].map((c) => stickyLeft(at(c), K, 3))).toEqual([2, 1, 0]);
  });

  test('cooldown starts when the sticky window ends and counts down to 1', () => {
    expect([5, 6, 7, 8, 9, 10].map((c) => cooldownLeft(at(c), K, 3, 2))).toEqual([0, 0, 2, 1, 0, 0]);
  });

  test('without sticky the cooldown runs from the fire itself: [L, L+D)', () => {
    expect([5, 6, 7].map((c) => cooldownLeft(at(c), K, undefined, 3))).toEqual([2, 1, 0]);
    expect([5, 6].map((c) => cooldownLeft(at(c), K, 0, 2))).toEqual([1, 0]);
  });

  test('no fire, no sticky value, or zero values: nothing', () => {
    expect(isSticky(timerState([], 5), K, 3)).toBe(false);
    expect(isSticky(at(5), K, 0)).toBe(false);
    expect(isSticky(at(5), K, undefined)).toBe(false);
    expect(cooldownLeft(at(5), K, 3, 0)).toBe(0);
    expect(cooldownLeft(timerState([], 5), K, 3, 2)).toBe(0);
    expect(isSticky(at(5), entryKey('b', 'other'), 3)).toBe(false);
  });

  test('the newest fresh fire counts', () => {
    const t = timerState([fire(1), fire(8)], 9);
    expect(isSticky(t, K, 3)).toBe(true);
    expect(t.last.get(K)).toEqual({ at: 8, fresh: true });
  });

  test('a sticky reinjection does not restart the window', () => {
    const t = timerState([fire(4), fire(5, 'sticky'), fire(6, 'sticky')], 7);
    expect(t.last.get(K)).toEqual({ at: 4, fresh: false });
    expect(isSticky(t, K, 3)).toBe(false);
    expect(cooldownLeft(t, K, 3, 2)).toBe(2);
  });

  test('a reinjection with no fresh fire before it starts nothing', () => {
    const t = timerState([fire(4, 'sticky')], 5);
    expect(t.last.has(K)).toBe(false);
    expect(isSticky(t, K, 3)).toBe(false);
  });

  test('fires the chat has not advanced past are ignored (ST drops them)', () => {
    const t = timerState([fire(4), fire(6)], 6);
    expect(t.last.get(K)).toEqual({ at: 4, fresh: true });
  });

  test('order of the input does not matter', () => {
    const a = timerState([fire(6, 'sticky'), fire(4)], 7);
    expect(a.last.get(K)).toEqual({ at: 4, fresh: false });
  });
});

describe('the cooldown after a sticky window starts at the first scan at or after its end (ST re-arms it there)', () => {
  // Fresh fire at 2, sticky 3 (window [2, 5)), cooldown 3. Two messages per turn: scans at 2, 4, 6, …
  const fires = [fire(2)];

  test('no scan at 5: the scan at 6 re-arms it as [6, 9), so 6 and 8 are blocked and 10 is free', () => {
    expect(cooldownLeft(timerState(fires, 6, [2, 4]), K, 3, 3)).toBe(3);
    expect(cooldownLeft(timerState(fires, 8, [2, 4, 6]), K, 3, 3)).toBe(1);
    expect(cooldownLeft(timerState(fires, 10, [2, 4, 6, 8]), K, 3, 3)).toBe(0);
  });

  test('cooldown 1 after an odd sticky still blocks one scan (it used to block none)', () => {
    // Fire at 2, sticky 1: the window ends at 3; the scan at 4 starts [4, 5).
    expect(cooldownLeft(timerState(fires, 4, [2]), K, 1, 1)).toBe(1);
    expect(cooldownLeft(timerState(fires, 6, [2, 4]), K, 1, 1)).toBe(0);
  });

  test('a scan exactly at the end (a continue at index + 1) starts it there', () => {
    expect(cooldownLeft(timerState(fires, 6, [2, 4, 5]), K, 3, 3)).toBe(2);
    expect(cooldownLeft(timerState(fires, 8, [2, 4, 5, 6]), K, 3, 3)).toBe(0);
  });

  test('inside the sticky window there is no cooldown; without sticky it runs from the fire', () => {
    expect(cooldownLeft(timerState(fires, 4, [2]), K, 3, 3)).toBe(0);
    expect(cooldownLeft(timerState(fires, 4, [2]), K, 0, 3)).toBe(1);
  });

  test('without scans (a caller that passes none) every chat length counts: it starts at the end', () => {
    expect(cooldownLeft(timerState(fires, 6), K, 3, 3)).toBe(2);
  });
});

describe('delay', () => {
  test('blocked while the chat has fewer than N messages', () => {
    expect([3, 4, 5, 6].map((c) => delayLeft(5, c))).toEqual([2, 1, 0, 0]);
  });

  test('no delay, zero or negative never blocks', () => {
    expect(delayLeft(undefined, 0)).toBe(0);
    expect(delayLeft(0, 0)).toBe(0);
    expect(delayLeft(-3, 0)).toBe(0);
  });
});

describe('pathFires / chatLengthAt over a PathView', () => {
  // greeting g1 (fires: none), u1, a1 (fires e1 key; continue edit fires e2 key and e1 sticky),
  // u2 (hidden), a2 (fires e3 constant), u3 (the turn being built), plus a swipe sibling of a1 with
  // its own fire that must never show up. Positions count visible messages only (ST's coreChat
  // drops hidden ones): g1 0, u1 1, a1 2, u2 3 (hidden), a2 3, u3 4.
  const continued = (target: string, fired: { book: string; id: string; why: string }[]): EntryInput =>
    ({ t: 'edit', ts: TS, target, reason: 'continue', blocks: text('more'), trace: traceWith(fired) as never }) as EntryInput;
  const entries = seqd([
    msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }),
    msg('u0000001', 'g0000001', 'user', 'Hi'),
    msg('a0000001', 'u0000001', 'assistant', 'answer', { trace: traceWith([{ book: 'b', id: 'e1', why: 'key' }]) as never }),
    msg('a0000009', 'u0000001', 'assistant', 'swipe', { trace: traceWith([{ book: 'b', id: 'off', why: 'key' }]) as never }),
    head('a0000001'),
    continued('a0000001', [
      { book: 'b', id: 'e2', why: 'key' },
      { book: 'b', id: 'e1', why: 'sticky' },
    ]),
    msg('u0000002', 'a0000001', 'user', 'Next'),
    msg('a0000002', 'u0000002', 'assistant', 'two', { trace: traceWith([{ book: '@card', id: 'e3', why: 'constant' }]) as never }),
    msg('u0000003', 'a0000002', 'user', 'Third'),
    hide('u0000002'),
  ]);
  const view = foldView(makeHeader(), entries);
  // The same story with nothing hidden.
  const shown = foldView(makeHeader(), entries.filter((e) => e.t !== 'hide'));

  test("every fire on the path up to the message, oldest first, at = the visible messages before it (a continue's: + 1)", () => {
    // The continue of a1 scanned at chat length 3 (ST's chat for a continue holds a1); a2 was
    // written after g1, u1, a1 (u2 is hidden): 3.
    expect(pathFires(view, 'u0000003')).toEqual([
      { book: 'b', id: 'e1', why: 'key', at: 2 },
      { book: 'b', id: 'e2', why: 'key', at: 3 },
      { book: 'b', id: 'e1', why: 'sticky', at: 3 },
      { book: '@card', id: 'e3', why: 'constant', at: 3 },
    ]);
    // Nothing hidden: a2 sits at its path index.
    expect(pathFires(shown, 'u0000003').at(-1)).toEqual({ book: '@card', id: 'e3', why: 'constant', at: 4 });
  });

  test('the scans on the path: every answer at its place, every continue at its place + 1, no greeting', () => {
    // a1 at 2, its continue at 3, a2 at 3 (u2 hidden): one scan length.
    expect(pathScans(view, 'u0000003')).toEqual([2, 3]);
    expect(pathScans(view, 'u0000002')).toEqual([2, 3]);
    expect(pathScans(view, 'u0000001')).toEqual([]);
    expect(pathScans(shown, 'u0000003')).toEqual([2, 3, 4]);
  });

  test("a second continue of the same answer does not see the first continue's fires (ST: chat not advanced)", () => {
    // Continuing a2 again runs at chat length 4; a continue's fires of a2 would sit at 4 and are dropped.
    expect(chatLengthAt(view, 'a0000002')).toBe(4);
    const t = timerState([{ book: 'b', id: 'x', why: 'key', at: 4 }], chatLengthAt(view, 'a0000002'));
    expect(t.last.size).toBe(0);
  });

  test('fires after upTo are left out (a regeneration of a2 does not see a2 own fires)', () => {
    expect(pathFires(view, 'u0000002').map((f) => f.id)).toEqual(['e1', 'e2', 'e1']);
    expect(pathFires(view, 'u0000001')).toEqual([]);
  });

  test('chat length = the visible path messages up to the turn; a hidden message does not count (ST coreChat)', () => {
    expect(chatLengthAt(view, 'u0000003')).toBe(5);
    expect(chatLengthAt(view, 'u0000001')).toBe(2);
    expect(chatLengthAt(view, 'a0000002')).toBe(4);
    // A hidden message is not in its own chat either.
    expect(chatLengthAt(view, 'u0000002')).toBe(3);
    // Nothing hidden: path index + 1.
    expect(chatLengthAt(shown, 'u0000003')).toBe(6);
    expect(chatLengthAt(shown, 'a0000002')).toBe(5);
  });

  test('timers from the path: the continue reinjection of e1 does not restart its window', () => {
    const t = timerState(pathFires(view, 'u0000003'), chatLengthAt(view, 'u0000003'));
    expect(t.last.get(entryKey('b', 'e1'))).toEqual({ at: 2, fresh: false });
    expect(t.last.get(entryKey('b', 'e2'))).toEqual({ at: 3, fresh: true });
    // Chat length 5 (u2 hidden): sticky 4 is still open ([2, 6)), sticky 3 closed.
    expect(isSticky(t, entryKey('b', 'e1'), 4)).toBe(true);
    expect(isSticky(t, entryKey('b', 'e1'), 3)).toBe(false);
    // With u2 shown the chat is one longer: sticky 4 has closed.
    const s = timerState(pathFires(shown, 'u0000003'), chatLengthAt(shown, 'u0000003'));
    expect(isSticky(s, entryKey('b', 'e1'), 5)).toBe(true);
    expect(isSticky(s, entryKey('b', 'e1'), 4)).toBe(false);
  });

  test('a message off the path is an error', () => {
    expect(() => pathFires(view, 'a0000009')).toThrow(/not on the active path/);
    expect(() => chatLengthAt(view, 'nope')).toThrow(/not on the active path/);
  });
});
