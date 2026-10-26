// prompt/budget.ts: window, reply reserve [D-89], chunked history trim [D-49].
import { describe, expect, test } from 'bun:test';
import { contextWindow, replyReserve, trimHistory } from '../../src/prompt/budget.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import type { Preset } from '../../src/formats/native.ts';

const caps = (contextLength?: number): ModelCaps =>
  ({ contextLength, prefill: 'assistant-last' }) as unknown as ModelCaps;
const preset = (maxContext?: number): Preset => ({ name: 'p', blocks: [], context: { maxContext } });

describe('contextWindow', () => {
  test('model window, or 8192 local / 32768 remote when unknown', () => {
    expect(contextWindow({ caps: caps(131072), local: false })).toBe(131072);
    expect(contextWindow({ caps: caps(), local: true })).toBe(8192);
    expect(contextWindow({ caps: caps(), local: false })).toBe(32768);
  });

  test('preset and config can only shrink it', () => {
    expect(contextWindow({ caps: caps(131072), local: false, preset: preset(16384) })).toBe(16384);
    expect(contextWindow({ caps: caps(8192), local: false, preset: preset(65536) })).toBe(8192);
    expect(contextWindow({ caps: caps(131072), local: false, preset: preset(65536), configWindow: 20000 })).toBe(20000);
    expect(contextWindow({ caps: caps(), local: true, configWindow: 0 })).toBe(8192); // 0 = unset
  });
});

describe('replyReserve', () => {
  test('defaults: 2048 below 24576, 8192 from there', () => {
    expect(replyReserve(16384)).toBe(2048);
    expect(replyReserve(24575)).toBe(2048);
    expect(replyReserve(24576)).toBe(8192);
    expect(replyReserve(32768)).toBe(8192);
  });

  test('maxTokens wins over the default', () => {
    expect(replyReserve(32768, 1000)).toBe(1000);
    expect(replyReserve(16384, 4096)).toBe(4096);
  });

  test('never more than half the window', () => {
    expect(replyReserve(16384, 12000)).toBe(8192);
    expect(replyReserve(2048)).toBe(1024);
    expect(replyReserve(4097)).toBe(2048);
    expect(replyReserve(4095)).toBe(2047);
  });
});

const hist = (toks: number[]) => toks.map((tok, i) => ({ id: `m${i}`, tok }));

describe('trimHistory', () => {
  test('everything fits: nothing dropped', () => {
    expect(trimHistory(hist([10, 10, 10]), 30)).toEqual({ keepFrom: 0, trimmed: null, fits: true });
    expect(trimHistory([], 0)).toEqual({ keepFrom: 0, trimmed: null, fits: true });
  });

  test('drops whole chunks of 8 counted from the oldest message', () => {
    // 20 messages of 10: budget 150 keeps at most 15, so the cut is the first grid point keeping ≤ 15: 8.
    const r = trimHistory(hist(new Array(20).fill(10)), 150);
    expect(r).toEqual({ keepFrom: 8, trimmed: { from: 'm0', to: 'm7' }, fits: true });
    expect(trimHistory(hist(new Array(20).fill(10)), 120).keepFrom).toBe(8);
    expect(trimHistory(hist(new Array(20).fill(10)), 119).keepFrom).toBe(16);
  });

  test('the cut point moves only by whole chunks as history grows', () => {
    const cuts: number[] = [];
    for (let n = 10; n <= 60; n++) {
      const { keepFrom, fits } = trimHistory(hist(new Array(n).fill(10)), 200, { protectedTail: 1 });
      expect(fits).toBe(true);
      expect(keepFrom % 8).toBe(0); // always on the grid anchored at m0
      expect(n - keepFrom).toBeLessThanOrEqual(20); // within budget
      cuts.push(keepFrom);
    }
    // Monotone, and each change is a whole chunk; the first kept message stays put between changes.
    for (let i = 1; i < cuts.length; i++) {
      const step = cuts[i]! - cuts[i - 1]!;
      expect(step === 0 || step === 8).toBe(true);
    }
    expect(new Set(cuts).size).toBeGreaterThan(3);
    // A stretch of turns shares the same first kept message (the cached prefix survives).
    expect(cuts.filter((c) => c === 16).length).toBeGreaterThanOrEqual(7);
  });

  test('custom chunk size', () => {
    expect(trimHistory(hist(new Array(10).fill(10)), 75, { chunk: 3 }).keepFrom).toBe(3);
    expect(trimHistory(hist(new Array(10).fill(10)), 75, { chunk: 1 }).keepFrom).toBe(3);
    expect(trimHistory(hist(new Array(10).fill(10)), 65, { chunk: 1 }).keepFrom).toBe(4);
  });

  test('protected tail is never dropped; off-grid cut at the tail when no grid point fits', () => {
    // 12 messages of 10, last 3 protected (30). Grid 0, 8; budget 35 fits neither 0 (120) nor 8 (40).
    const r = trimHistory(hist(new Array(12).fill(10)), 35, { protectedTail: 3 });
    expect(r).toEqual({ keepFrom: 9, trimmed: { from: 'm0', to: 'm8' }, fits: true });
  });

  test('protected head stays; the grid is anchored at the first droppable message', () => {
    // m0 is the greeting (protected). Droppable m1..m19, grid 1, 9, 17.
    const r = trimHistory(hist(new Array(20).fill(10)), 120, { protectedHead: 1, protectedTail: 1 });
    // keep head (10) + from 9: 11 messages (110) ≤ 120; from 1: 190 > 120.
    expect(r).toEqual({ keepFrom: 9, trimmed: { from: 'm1', to: 'm8' }, fits: true });
    const none = trimHistory(hist([5, 5, 5]), 100, { protectedHead: 1 });
    expect(none).toEqual({ keepFrom: 1, trimmed: null, fits: true });
  });

  test('fits = false when even the protected messages do not fit', () => {
    const r = trimHistory(hist([10, 10, 10, 50, 60]), 100, { protectedTail: 2 });
    expect(r).toEqual({ keepFrom: 3, trimmed: { from: 'm0', to: 'm2' }, fits: false });
    expect(trimHistory(hist([10]), -1).fits).toBe(false); // the non-history part already overflows
    expect(trimHistory(hist([10, 10]), 15, { protectedHead: 1, protectedTail: 1 }).fits).toBe(false);
  });

  test('stops measuring once the budget is exceeded (early stop)', () => {
    let reads = 0;
    const n = 10_000;
    const history = Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      get tok() {
        reads++;
        return 10;
      },
    }));
    const r = trimHistory(history, 200, { protectedTail: 1 });
    expect(r.fits).toBe(true);
    expect(n - r.keepFrom).toBeLessThanOrEqual(20);
    expect(reads).toBeLessThan(100);
  });

  test('bad token counts do not poison the sum', () => {
    const r = trimHistory([{ id: 'a', tok: Number.NaN }, { id: 'b', tok: -5 }, { id: 'c', tok: 10 }], 10);
    expect(r).toEqual({ keepFrom: 0, trimmed: null, fits: true });
  });
});

describe('trimHistory maxKept (preset.context.maxMessages)', () => {
  const hist = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, tok: 1 }));

  test('caps the kept count, protected messages included, on the grid; the cut is reported', () => {
    // 20 messages, head 1 + tail 1 protected, at most 12 kept: chunk stays 8, floor 9 → grid point 9.
    const r = trimHistory(hist(20), 1000, { protectedHead: 1, protectedTail: 1, maxKept: 12 });
    expect(r).toEqual({ keepFrom: 9, trimmed: { from: 'm1', to: 'm8' }, fits: true });
    expect(1 + (20 - r.keepFrom)).toBeLessThanOrEqual(12);
  });

  test('a limit smaller than a chunk shrinks the chunk, so the cut never falls back to the moving tail', () => {
    const starts: number[] = [];
    for (let n = 12; n <= 21; n++) {
      const r = trimHistory(hist(n), 1000, { protectedHead: 1, protectedTail: 1, maxKept: 6 });
      expect(1 + (n - r.keepFrom)).toBeLessThanOrEqual(6);
      expect(1 + (n - r.keepFrom)).toBeGreaterThanOrEqual(2);
      starts.push(r.keepFrom);
    }
    expect(starts).toEqual([11, 11, 11, 11, 11, 16, 16, 16, 16, 16]);
  });

  test('the budget still cuts deeper than the limit; protected messages beat the limit', () => {
    expect(trimHistory(hist(20), 3, { protectedHead: 1, protectedTail: 1, maxKept: 12 }).keepFrom).toBe(19);
    expect(trimHistory(hist(4), 1000, { protectedHead: 1, protectedTail: 2, maxKept: 1 })).toEqual({
      keepFrom: 2,
      trimmed: { from: 'm1', to: 'm1' },
      fits: true,
    });
    // No limit, or a nonsense one, changes nothing.
    expect(trimHistory(hist(20), 1000, { protectedHead: 1, maxKept: 0 }).keepFrom).toBe(1);
  });
});
