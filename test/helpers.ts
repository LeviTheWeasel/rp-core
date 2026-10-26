// Shared test helpers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temporary home directory (not cleaned automatically; the OS tmp cleaner handles it). */
export function tmpHome(prefix = 'rp-core-home-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Deterministic clock: starts at `start`, advances `stepMs` per call. */
export function fakeClock(start = '2026-10-26T12:00:00.000Z', stepMs = 1000): () => Date {
  let t = new Date(start).getTime();
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

/** Deterministic random bytes from a counter. */
export function fakeRandom(seed = 1): (n: number) => Uint8Array {
  let x = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      out[i] = (z ^ (z >>> 16)) & 0xff;
    }
    return out;
  };
}
