// prompt/tokens.ts emaFactor (M1b, §11, D-50): α 0.3 from 1.15, each ratio and the result in [0.8, 2.0].
import { describe, expect, test } from 'bun:test';
import { EMA_ALPHA, EMA_DISCARD_BELOW, EMA_MAX, EMA_MIN, EMA_START, emaFactor } from '../../src/prompt/tokens.ts';

const s = (estimated: number, reported: number) => ({ estimated, reported });

describe('emaFactor', () => {
  test('the constants are §11’s', () => {
    expect([EMA_ALPHA, EMA_START, EMA_MIN, EMA_MAX]).toEqual([0.3, 1.15, 0.8, 2.0]);
  });

  test('no samples → the start value', () => {
    expect(emaFactor([])).toBe(1.15);
  });

  test('one step: α·ratio + (1 − α)·start', () => {
    expect(emaFactor([s(100, 100)])).toBeCloseTo(0.3 * 1 + 0.7 * 1.15, 12); // 1.105
    expect(emaFactor([s(200, 300)])).toBeCloseTo(0.3 * 1.5 + 0.7 * 1.15, 12); // 1.255
  });

  test('a sequence, oldest → newest; the newest weighs most', () => {
    const f1 = 0.3 * 1.5 + 0.7 * 1.15;
    const f2 = 0.3 * 1.5 + 0.7 * f1;
    expect(emaFactor([s(100, 150), s(100, 150)])).toBeCloseTo(f2, 12);
    const up = emaFactor([s(100, 90), s(100, 130)]);
    const down = emaFactor([s(100, 130), s(100, 90)]);
    expect(up).toBeCloseTo(0.3 * 1.3 + 0.7 * (0.3 * 0.9 + 0.7 * 1.15), 12);
    expect(up).toBeGreaterThan(down);
  });

  test('converges on a steady ratio', () => {
    expect(emaFactor(Array.from({ length: 60 }, () => s(1000, 1300)))).toBeCloseTo(1.3, 6);
    expect(emaFactor(Array.from({ length: 60 }, () => s(1000, 900)))).toBeCloseTo(0.9, 6);
  });

  test('each sample’s ratio is clamped before it enters the average', () => {
    expect(emaFactor([s(100, 1000)])).toBeCloseTo(0.3 * 2.0 + 0.7 * 1.15, 12); // ratio 10 counts as 2.0
    expect(emaFactor([s(1000, 600)])).toBeCloseTo(0.3 * 0.8 + 0.7 * 1.15, 12); // ratio 0.6 counts as 0.8
  });

  test('the result stays in [0.8, 2.0] however long the run', () => {
    const high = emaFactor(Array.from({ length: 200 }, () => s(10, 10_000)));
    const low = emaFactor(Array.from({ length: 200 }, () => s(10_000, 5_500)));
    expect(high).toBeLessThanOrEqual(2.0);
    expect(high).toBeCloseTo(2.0, 10);
    expect(low).toBeGreaterThanOrEqual(0.8);
    expect(low).toBeCloseTo(0.8, 10);
  });

  test('a ratio below EMA_DISCARD_BELOW (0.5) is no sample: the server cut the prompt (review M1b, live Ollama)', () => {
    expect(EMA_DISCARD_BELOW).toBe(0.5);
    // Ollama at num_ctx 4096 dropped a 24 005-char message and reported 21 of ~8022 tokens.
    const truncated = Array.from({ length: 6 }, () => s(8022, 21));
    expect(emaFactor(truncated)).toBe(1.15);
    // Interleaved with real samples it changes nothing either: the factor is the real samples' own.
    expect(emaFactor([s(1000, 900), ...truncated, s(1000, 900)])).toBeCloseTo(emaFactor([s(1000, 900), s(1000, 900)]), 12);
    // An ordinary English ratio (~0.75, below EMA_MIN) still counts, clamped to 0.8.
    expect(emaFactor([s(1000, 750)])).toBeCloseTo(0.3 * 0.8 + 0.7 * 1.15, 12);
  });

  test('samples without two positive finite counts are skipped', () => {
    const junk = [s(0, 100), s(100, 0), s(-5, 100), s(100, -5), s(Number.NaN, 100), s(100, Number.NaN), s(Number.POSITIVE_INFINITY, 100), s(100, Number.POSITIVE_INFINITY)];
    expect(emaFactor(junk)).toBe(1.15);
    expect(emaFactor([...junk, s(100, 100), ...junk])).toBeCloseTo(1.105, 12);
  });

  test('pure: same samples, same factor; the input is not touched', () => {
    const samples = Object.freeze([s(120, 150), s(300, 290)]);
    expect(emaFactor(samples)).toBe(emaFactor([...samples]));
  });
});
