// §6.9 for the engine files: time and entropy come from EngineOptions (system.ts is the only
// place that reads the wall clock or system entropy). test/purity.test.ts covers all of src/.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', '..', 'src', 'engine');

describe('engine purity', () => {
  test('no Math.random / Date.now / argless new Date() / crypto randomness outside system.ts', () => {
    const bad: string[] = [];
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith('.ts') || name === 'system.ts') continue;
      const src = readFileSync(join(DIR, name), 'utf8');
      if (
        /Math\.random\s*\(/.test(src) ||
        /Date\.now\s*\(/.test(src) ||
        /new Date\(\s*\)/.test(src) ||
        /getRandomValues|randomFillSync|randomBytes|randomUUID/.test(src) ||
        /performance\.now/.test(src)
      ) {
        bad.push(name);
      }
    }
    expect(bad).toEqual([]);
  });

  test('no module-level mutable state in the engine (let/var at top level)', () => {
    const bad: string[] = [];
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith('.ts')) continue;
      const src = readFileSync(join(DIR, name), 'utf8');
      if (/^(export\s+)?(let|var)\s/m.test(src)) bad.push(name);
    }
    expect(bad).toEqual([]);
  });
});
