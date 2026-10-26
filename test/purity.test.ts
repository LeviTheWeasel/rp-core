// §6.9: no Math.random or Date.now in src/. engine/system.ts is the only place that may touch the
// wall clock and system entropy.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const ALLOWED = new Set(['engine/system.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('purity', () => {
  test('no Math.random / Date.now / argless new Date() outside engine/system.ts', () => {
    const bad: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (ALLOWED.has(rel) || rel.endsWith('.test.ts')) continue;
      const src = readFileSync(f, 'utf8');
      if (/Math\.random\s*\(/.test(src) || /Date\.now\s*\(/.test(src) || /new Date\(\s*\)/.test(src)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});
