// Ported from Bunraku:src/core/lore/rng.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (mulberry32).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Seeded randomness (ARCHITECTURE.md §6.9, D-44). mulberry32 generates; splitmix32 derives
// labelled sub-streams ('lore.prob', 'lore.group', 'macro:<block source>') so adding a block never
// reshuffles the others. No Math.random anywhere in src/.
// CONTRACT FILE: signatures are fixed; the macros agent implements the bodies.
//
// Bunraku's cryptoUnit/freshSeed are not ported: entropy belongs to engine/system.ts.

/** Returns floats in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32, unchanged from Bunraku: the stream Bunraku runs on and the RoleCall macro corpus was
 * recorded with, so those recordings replay bit for bit (D-44).
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // 2^32, so the largest value stays strictly below 1.
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One splitmix32 step: a well-mixed uint32 from a uint32. Golden-ratio increment, then the
 * 0x21f0aaad / 0x735a2d97 finaliser (the common 32-bit splitmix variant). A good finaliser matters
 * here because neighbouring labels hash to correlated inputs; mulberry32 alone would echo that.
 */
export function splitmix32(x: number): number {
  let z = (x + 0x9e3779b9) | 0;
  z ^= z >>> 16;
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  z ^= z >>> 15;
  return z >>> 0;
}

const utf8 = new TextEncoder();

/** 32-bit FNV-1a of the UTF-8 bytes of s. Bytes, not UTF-16 units, so Cyrillic hashes the same everywhere. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of utf8.encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seed of the labelled sub-stream: splitmix32(seed ^ hashString(label)). */
export function subSeed(seed: number, label: string): number {
  return splitmix32((seed ^ hashString(label)) >>> 0);
}

/** A fresh stream for one label: depends only on (seed, label), never on how many draws came before. */
export function subRng(seed: number, label: string): Rng {
  return mulberry32(subSeed(seed, label));
}
