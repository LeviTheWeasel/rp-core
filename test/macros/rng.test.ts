// Seeded randomness (ARCHITECTURE.md §6.9, D-44).
import { describe, expect, test } from 'bun:test';
import { hashString, mulberry32, splitmix32, subRng, subSeed } from '../../src/prompt/rng.ts';

describe('mulberry32', () => {
  test('pinned stream (identical to Bunraku src/core/lore/rng.ts, so recorded corpora replay)', () => {
    const r = mulberry32(1);
    expect([r(), r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const z = mulberry32(42);
    expect(z()).toBe(0.6011037519201636);
  });

  test('negative and oversized seeds are read as uint32', () => {
    const a = mulberry32(-7);
    const b = mulberry32(-7 >>> 0);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
  });

  test('floats stay in [0, 1)', () => {
    const r = mulberry32(0xdeadbeef);
    for (let i = 0; i < 10_000; i++) {
      const x = r();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});

describe('hashString (FNV-1a 32 over UTF-8)', () => {
  test('published test vectors', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('foobar')).toBe(0xbf9cf968);
  });

  test('hashes UTF-8 bytes, not UTF-16 units (Cyrillic)', () => {
    // 'я' is U+044F → UTF-8 d1 8f.
    let h = 0x811c9dc5;
    for (const byte of [0xd1, 0x8f]) h = Math.imul(h ^ byte, 0x01000193);
    expect(hashString('я')).toBe(h >>> 0);
    expect(hashString('Привет')).toBe(0x33db115f);
  });

  test('always a uint32', () => {
    for (const s of ['x', 'macro:main', '日本語', '🎲'.repeat(9)]) {
      const h = hashString(s);
      expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
    }
  });
});

describe('splitmix32 / subSeed / subRng', () => {
  test('pinned values; uint32 out', () => {
    expect(splitmix32(0)).toBe(1684164658);
    expect(splitmix32(1)).toBe(1580013426);
    expect(splitmix32(0xffffffff)).toBe(3950124170);
  });

  test('neighbouring inputs land far apart', () => {
    const outs = new Set(Array.from({ length: 1000 }, (_, i) => splitmix32(i)));
    expect(outs.size).toBe(1000);
  });

  test('subSeed is splitmix32(seed ^ hashString(label))', () => {
    expect(subSeed(42, 'macro:main')).toBe(splitmix32((42 ^ hashString('macro:main')) >>> 0));
    expect(subSeed(42, 'macro:main')).toBe(3921846067);
  });

  test('a labelled stream depends only on (seed, label)', () => {
    const a1 = subRng(7, 'lore.prob');
    const noise = subRng(7, 'lore.group');
    noise();
    noise();
    const a2 = subRng(7, 'lore.prob');
    for (let i = 0; i < 20; i++) expect(a1()).toBe(a2());
  });

  test('different labels and different seeds give different streams', () => {
    const first = (seed: number, label: string): number => subRng(seed, label)();
    expect(first(7, 'lore.prob')).not.toBe(first(7, 'lore.group'));
    expect(first(7, 'macro:main')).not.toBe(first(8, 'macro:main'));
  });
});
