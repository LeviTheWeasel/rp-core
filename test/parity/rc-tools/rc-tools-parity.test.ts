// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// RoleCall parity for the tool-call code (docs/PARITY-RC.md, "Tool calls (M3)"). corpus.json holds
// one row per case: the input (RoleCall's own test inputs, `source` file:line, plus inputs the
// rp-core suite adds), RoleCall's output for it (recorded from its modules at fb8dc623e, see the doc)
// and rp-core's. A row without a deviation must come out exactly as RoleCall's; a row with one names
// the TD-n of the doc, and rp-core's output must differ from RoleCall's in that row.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreOutput, type CorpusRow } from './run.ts';

const rows = JSON.parse(readFileSync(join(import.meta.dir, 'corpus.json'), 'utf8')) as CorpusRow[];
const doc = readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'PARITY-RC.md'), 'utf8');
const section = doc.slice(doc.indexOf('## Tool calls (M3)'));

/** Inputs too large to keep inline are stored as a recipe. */
function inflate(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  if (Array.isArray(input)) return input.map(inflate);
  const rec = input as Record<string, unknown>;
  if (typeof rec['repeat'] === 'string' && typeof rec['times'] === 'number' && Object.keys(rec).length === 2) return rec['repeat'].repeat(rec['times']);
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, inflate(v)]));
}

/** The TD ids the doc's section defines, in its deviations table. */
const documented = new Set([...section.matchAll(/^\| (TD-\d+) \|/gm)].map((m) => m[1]!));

describe('RoleCall tool-call parity corpus', () => {
  test('the corpus is whole and its ids are unique', () => {
    expect(rows.length).toBeGreaterThanOrEqual(120);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(section.length).toBeGreaterThan(0);
  });

  test('every deviation a row names is in docs/PARITY-RC.md, and every documented one is used or marked', () => {
    const used = new Set(rows.flatMap((r) => (r.deviation ? [r.deviation] : [])));
    for (const td of used) expect(documented.has(td)).toBe(true);
    for (const td of documented) {
      const row = section.split('\n').find((l) => l.startsWith(`| ${td} |`))!;
      if (!used.has(td)) expect(row).toContain('no corpus row');
    }
  });

  for (const row of rows) {
    test(`${row.id} ${row.kind} (${row.source})${row.deviation ? ` — ${row.deviation}` : ''}`, async () => {
      const ours = await coreOutput(row.kind, inflate(row.input));
      expect(JSON.parse(JSON.stringify(ours))).toEqual(row.core);
      if (row.deviation === undefined) expect(row.core).toEqual(row.rc);
      else expect(row.core).not.toEqual(row.rc);
    });
  }
});
