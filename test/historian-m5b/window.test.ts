// Ported from Bunraku:src/core/compendium/historian.test.ts@702d8120 ("the window", "the watermark") and
// RoleCall:apps/rc/src/lib/ai/tv-stream/__tests__/summary-watermark.test.ts@fb8dc623e (the watermark from
// summaries only, the window from it plus the overlap, the turns since).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When the historian is due and what it reads (D-176). Changed from the sources: positions are 1-based
// path positions and ranges are message ids (D-58, D-68); the watermark is the end of the covered prefix
// over historian rows (applied or reverted, not stale), never the newest live summary; the overlap takes
// at most a third of the cap and one new message is always read (Bunraku Q1, a regression test here).
// Not ported: Bunraku's "a tail that starts later" (the path is read whole) and RoleCall's legacy
// turn-ordinal window and `summaryLastN` (no such rows or forced run in rp-core).
import { describe, expect, test } from 'bun:test';
import {
  historianDue,
  historianKey,
  historianRanges,
  historianWatermark,
  historianWindowAt,
  WINDOW_TOKENS,
  windowCap,
  type HistMessage,
} from '../../src/agents/compendium/historian.ts';
import { chat, due, exchanges, fold, hist, histRow, roles, tasks, userRow, words } from './kit.ts';

const ids = (w: { messages: { id: string }[] } | null): string[] => (w === null ? [] : w.messages.map((m) => m.id));

describe('the window (Bunraku historian.test.ts)', () => {
  test('it is due once `interval` player turns follow the watermark, and starts `overlap` before it', () => {
    const path = chat('auauauau');
    expect(historianDue(due(path, { interval: 5, overlap: 2 }))).toBeNull();
    expect(historianDue(due(path, { interval: 4, overlap: 2 }))).toMatchObject({ start: 1, newStart: 1, end: 8, turns: 4, watermark: 0 });
    const covered = tasks(hist('m1', 'm4'));
    expect(historianDue(due(path, { interval: 2, overlap: 2, tasks: covered }))).toMatchObject({ start: 3, newStart: 5, end: 8, turns: 2, watermark: 4 });
    expect(historianDue(due(path, { interval: 3, overlap: 2, tasks: covered }))).toBeNull();
    expect(historianDue(due(path, { interval: 0, overlap: 2 }))).toBeNull();
  });

  test('the window never reaches before the start of the path', () => {
    const w = historianDue(due(chat('auau'), { interval: 1, overlap: 50 }));
    expect(w).toMatchObject({ start: 1, fromId: 'm1', end: 4, toId: 'm4' });
  });

  test('one run reads at most the token cap, always at least one message, and the rest waits for the next run', () => {
    const big = 'word '.repeat(WINDOW_TOKENS);
    const path = chat('uauau', big);
    const w = historianDue(due(path, { interval: 1, overlap: 0 }))!;
    expect(w.end).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(5);
    expect(ids(w)).toEqual(['m1']);
  });

  test('the cap is min(12 000, 35 % of the recorder window)', () => {
    expect(windowCap(128_000)).toBe(12_000);
    expect(windowCap(16_384)).toBe(5_734);
    const path = chat('uauau', 'word '.repeat(2_000));
    // 16k window: 5 734 tokens → two messages of 2 000 fit, the third does not.
    expect(ids(historianDue(due(path, { window: 16_384, overlap: 0 })))).toEqual(['m1', 'm2']);
  });
});

describe('Q1: an overlap as large as the cap (Bunraku probe, fixed)', () => {
  // Bunraku: 30 messages, the replies 2 600 tokens, watermark 20, overlap 10 → {start 10, newStart 20,
  // end 19}: a window that ends before its new part, stamped turn_range {20, 19}, and the watermark
  // never moves again.
  const path: HistMessage[] = chat('ua'.repeat(15)).map((m) => ({ ...m, text: m.role === 'user' ? 'hi' : 'word '.repeat(2_600) }));
  const covered = tasks(hist('m1', 'm20'));

  test('the overlap takes at most a third of the cap and the new part is read', () => {
    const w = historianDue(due(path, { interval: 2, overlap: 10, tasks: covered }))!;
    expect(w.watermark).toBe(20);
    expect(w.newStart).toBe(21);
    expect(w.end).toBeGreaterThanOrEqual(w.newStart);
    const overlap = w.messages.filter((m) => m.pos < w.newStart);
    expect(overlap.map((m) => m.pos)).toEqual([19, 20]);
    expect(overlap.reduce((n, m) => n + words(m.text), 0)).toBeLessThanOrEqual(WINDOW_TOKENS / 3);
    expect(w).toMatchObject({ start: 19, end: 27, tokens: 10_405 });
    expect(w.tokens).toBeLessThanOrEqual(WINDOW_TOKENS);
    expect(historianKey(w)).toBe('hist:m21-m27');
  });

  test('an overlap message larger than a third of the cap is left out entirely', () => {
    const fat = chat('ua'.repeat(15), 'word '.repeat(5_000));
    const w = historianDue(due(fat, { interval: 2, overlap: 10, tasks: covered }))!;
    expect(w).toMatchObject({ start: 21, newStart: 21, end: 22 });
  });

  test('a first new message larger than the whole cap is still read, alone', () => {
    const huge = chat('ua'.repeat(15), 'word '.repeat(20_000));
    const w = historianDue(due(huge, { interval: 2, overlap: 10, tasks: covered }))!;
    expect(w).toMatchObject({ start: 21, newStart: 21, end: 21 });
  });

  test('the lite profile reads 6 messages of overlap by default, full 10', () => {
    const path = roles(40);
    const covered = tasks(hist('m1', 'm20'));
    expect(historianDue(due(path, { interval: 1, tasks: covered }))!.start).toBe(11);
    expect(historianDue(due(path, { interval: 1, tasks: covered, profile: 'lite' }))!.start).toBe(15);
  });
});

describe('the watermark (Bunraku historian.test.ts, rewritten for rows: B24)', () => {
  const path = chat('ua'.repeat(6));

  test('it is the end of the covered prefix; an undone pass still covers, a stale one does not', () => {
    expect(historianWatermark(path, tasks(hist('m1', 'm5'), hist('m6', 'm9')))).toBe(9);
    expect(historianWatermark(path, tasks(hist('m1', 'm5'), hist('m6', 'm9', 'reverted')))).toBe(9);
    expect(historianWatermark(path, tasks(hist('m1', 'm5'), hist('m6', 'm9', 'stale')))).toBe(5);
    expect(historianWatermark(path, tasks(hist('m1', 'm5'), ['hist:m6-m9', 'reverted', ['m6', 'm9'], true]))).toBe(5);
    expect(historianWatermark(path, new Map())).toBe(0);
  });

  test('a hole left by staleness is where the watermark stays, even with later rows', () => {
    expect(historianWatermark(path, tasks(hist('m1', 'm4', 'stale'), hist('m5', 'm9')))).toBe(0);
    expect(historianWatermark(path, tasks(hist('m1', 'm4'), hist('m7', 'm9')))).toBe(4);
  });

  test('everything covered: the watermark is the last visible message and nothing is due', () => {
    const all = tasks(hist('m1', 'm12'));
    expect(historianWatermark(path, all)).toBe(12);
    expect(historianDue(due(path, { tasks: all }))).toBeNull();
  });

  test('a hidden message is never a hole, never a turn and never shown, but keeps its number', () => {
    const hidden = path.map((m) => (m.id === 'm5' || m.id === 'm9' ? { ...m, hidden: true } : m));
    const t = tasks(hist('m1', 'm4'), hist('m6', 'm7'));
    expect(historianWatermark(hidden, t)).toBe(7);
    // Player messages after the watermark: m9 (hidden) and m11; only m11 is a turn.
    expect(historianDue(due(hidden, { tasks: t, interval: 2, overlap: 1 }))).toBeNull();
    const w = historianDue(due(hidden, { tasks: t, interval: 1, overlap: 1 }))!;
    expect(w.messages.map((m) => m.pos)).toEqual([7, 8, 10, 11, 12]);
    expect(w).toMatchObject({ watermark: 7, start: 7, newStart: 8, end: 12, turns: 1 });
  });
});

describe('RoleCall summary-watermark.test.ts', () => {
  test('only historian rows count: filing writes never move the watermark (the pollution regression)', () => {
    const path = roles(6);
    const t = tasks(['file:m6', 'applied', ['m1', 'm6']], hist('m1', 'm4'));
    expect(historianRanges(t)).toEqual([['m1', 'm4']]);
    expect(historianWatermark(path, t)).toBe(4);
  });

  test('a historian key without a range covers nothing', () => {
    expect(historianWatermark(roles(6), tasks(['hist:m1-m4', 'applied', undefined]))).toBe(0);
  });

  test('backfills from the start: the Mahito case', () => {
    const w = historianDue(due(roles(6), { interval: 3, overlap: 10 }))!;
    expect(w).toMatchObject({ start: 1, newStart: 1, fromId: 'm1', newFromId: 'm1' });
  });

  test('resumes exactly where the last pass ended, plus overlap', () => {
    const w = historianDue(due(roles(30), { interval: 5, overlap: 4, tasks: tasks(hist('m1', 'm20')) }))!;
    expect(w).toMatchObject({ newStart: 21, start: 17, newFromId: 'm21', fromId: 'm17' });
  });

  test('a range reaching past the messages read covers to their end (RoleCall clamped an index instead)', () => {
    expect(historianDue(due(roles(10), { tasks: tasks(['hist:m1-later', 'applied', ['m1', 'later']]) }))).toBeNull();
  });

  test('counts the player turns after the covered span', () => {
    const w = historianDue(due(roles(6), { interval: 2, tasks: tasks(hist('m1', 'm2')) }))!;
    expect(w.turns).toBe(2);
    expect(historianDue(due(roles(6), { interval: 3, tasks: tasks(hist('m1', 'm2')) }))).toBeNull();
  });
});

describe('rolecall.md H1–H4 on path ids (u1 a1 u2 a2 …; interval 3, overlap 2, wait 0)', () => {
  const at = (n: number) => exchanges(n);
  const cfg = { interval: 3, overlap: 2 };

  test('H1: at a3 the first window is u1…a3, with no overlap', () => {
    const w = historianDue(due(at(3), cfg))!;
    expect(w).toMatchObject({ fromId: 'u1', newFromId: 'u1', toId: 'a3', watermark: 0, turns: 3, trigger: 'interval' });
    expect(historianKey(w)).toBe('hist:u1-a3');
  });

  test('H2: at a6 the window is new u4…a6, shown from u3 (u3, a3 already summarized)', () => {
    const w = historianDue(due(at(6), { ...cfg, tasks: tasks(hist('u1', 'a3')) }))!;
    expect(w).toMatchObject({ fromId: 'u3', newFromId: 'u4', toId: 'a6', watermark: 6, start: 5, newStart: 7, end: 12 });
    expect(historianKey(w)).toBe('hist:u4-a6');
  });

  test('H3: an undone pass keeps its range covered: at a9 the window is u7…a9, not u1…a3', () => {
    const w = historianDue(due(at(9), { ...cfg, tasks: tasks(hist('u1', 'a3', 'reverted'), hist('u4', 'a6')) }))!;
    expect(w).toMatchObject({ fromId: 'u6', newFromId: 'u7', toId: 'a9', watermark: 12 });
  });

  test('H4: a stale pass (a2 edited) is the oldest uncovered segment, taken before newer messages', () => {
    const stale = tasks(hist('u1', 'a3', 'stale'), hist('u4', 'a6'));
    const w = historianDue(due(at(9), { ...cfg, tasks: stale }))!;
    expect(w).toMatchObject({ fromId: 'u1', newFromId: 'u1', toId: 'a3', watermark: 0, turns: 9 });
    expect(historianKey(w)).toBe('hist:u1-a3');
    const undoneThenStale = tasks(['hist:u1-a3', 'reverted', ['u1', 'a3'], true], hist('u4', 'a6'));
    expect(historianDue(due(at(9), { ...cfg, tasks: undoneThenStale }))).toMatchObject({ newFromId: 'u1', toId: 'a3' });
  });

  test('H3/H4 through the fold: a revert keeps the watermark, an edit in the range moves it back', () => {
    const path = at(6);
    const pathIds = path.map((m) => m.id);
    const rows = [histRow(10, 'u1', 'a3', []), histRow(11, 'u4', 'a6', [])];
    expect(historianWatermark(path, fold(rows, pathIds).tasks)).toBe(12);
    const undone = [...rows, userRow(12, [{ op: 'revert', key: 'hist:u1-a3' }])];
    expect(historianWatermark(path, fold(undone, pathIds).tasks)).toBe(12);
    const edited = fold(rows, pathIds, new Map([['a2', 20]]));
    expect(historianWatermark(path, edited.tasks)).toBe(0);
    expect(historianDue(due(path, { ...cfg, tasks: edited.tasks }))).toMatchObject({ newFromId: 'u1', toId: 'a3' });
  });
});

describe('the second trigger: messages the newest request trimmed (D-176)', () => {
  const path = roles(20);

  test('≥ recapAfter trimmed messages after the watermark make a run due before `interval`', () => {
    const w = historianDue(due(path, { interval: 20, recapAfter: 8, trimmed: { from: 'm2', to: 'm9' } }))!;
    expect(w).toMatchObject({ trigger: 'trimmed', trimmed: 8, turns: 10 });
    expect(historianDue(due(path, { interval: 20, recapAfter: 9, trimmed: { from: 'm2', to: 'm9' } }))).toBeNull();
  });

  test('trimmed messages the historian already covered do not count', () => {
    const t = tasks(hist('m1', 'm6'));
    expect(historianDue(due(path, { interval: 20, recapAfter: 4, tasks: t, trimmed: { from: 'm2', to: 'm9' } }))).toBeNull();
    expect(historianDue(due(path, { interval: 20, recapAfter: 3, tasks: t, trimmed: { from: 'm2', to: 'm9' } }))).toMatchObject({ trimmed: 3, newStart: 7 });
  });

  test('interval 0 turns the historian off, whatever was trimmed (C-2)', () => {
    expect(historianDue(due(path, { interval: 0, recapAfter: 1, trimmed: { from: 'm1', to: 'm19' } }))).toBeNull();
  });
});

describe('a stored range (refile, retry, recovery)', () => {
  const path = exchanges(9);

  test('the same window again, whatever covers it now', () => {
    const t = tasks(hist('u1', 'a3'), hist('u4', 'a6'));
    const w = historianWindowAt(due(path, { overlap: 2, tasks: t }), ['u4', 'a6'])!;
    expect(w).toMatchObject({ fromId: 'u3', newFromId: 'u4', toId: 'a6', start: 5, newStart: 7, end: 12 });
    expect(historianKey(w)).toBe('hist:u4-a6');
  });

  test('null for ids off the path, in the wrong order, or nothing visible between them', () => {
    expect(historianWindowAt(due(path), ['u4', 'gone'])).toBeNull();
    expect(historianWindowAt(due(path), ['a6', 'u4'])).toBeNull();
    const hidden = path.map((m) => (m.id === 'u4' || m.id === 'a4' ? { ...m, hidden: true } : m));
    expect(historianWindowAt(due(hidden), ['u4', 'a4'])).toBeNull();
    expect(historianWindowAt(due(hidden, { overlap: 0 }), ['u4', 'a5'])).toMatchObject({ newFromId: 'u5', toId: 'a5' });
  });
});
