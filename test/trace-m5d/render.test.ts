// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5d (D-213), /trace: one line per model call, "narrator  +2.1 s  first token 0.4 s  1.8 s  prompt
// 3 412 cached, 96 new"; each part only when the row has it, so older rows still print.
import { describe, expect, test } from 'bun:test';
import { renderTrace, traceCallLines } from '../../src/cli/repl-render.ts';
import type { Trace, TraceCallRow } from '../../src/session/entries.ts';

const row = (over: Partial<TraceCallRow> = {}): TraceCallRow => ({ callKey: 't:narrator:0', agent: 'narrator', model: 'local:m', ms: 1800, ...over });

describe('traceCallLines', () => {
  test("the decision's example, and the answer's own model left out", () => {
    expect(traceCallLines([row({ at: 2100, ttftMs: 400, prompt: { cached: 3412, processed: 96 } })], 'local:m')).toEqual([
      '  calls:',
      '    narrator  +2.1 s  first token 0.4 s  1.8 s  prompt 3 412 cached, 96 new',
    ]);
  });

  test('agents padded to one column; another model named at the end', () => {
    const rows = [
      row({ callKey: 't:director:0', agent: 'director', model: 'dir:big', at: 0, ttftMs: 1200, ms: 3000 }),
      row({ callKey: 't:recall:0', agent: 'recall', at: 0, ttftMs: 300, ms: 900, prompt: { processed: 1500, cached: 0 } }),
      row({ at: 3100, ttftMs: 450, ms: 2400, prompt: { processed: 1_234_567 } }),
    ];
    expect(traceCallLines(rows, 'local:m')).toEqual([
      '  calls:',
      '    director  +0.0 s  first token 1.2 s  3.0 s  dir:big',
      '    recall    +0.0 s  first token 0.3 s  0.9 s  prompt 0 cached, 1 500 new',
      '    narrator  +3.1 s  first token 0.5 s  2.4 s  prompt 1 234 567 new',
    ]);
  });

  test('an old row: the agent and its time; only the cached part when that is all the server said', () => {
    expect(traceCallLines([row(), row({ prompt: { cached: 40 } })], 'local:m')).toEqual(['  calls:', '    narrator  1.8 s', '    narrator  1.8 s  prompt 40 cached']);
  });

  test('no rows, no lines; a row with bad values prints what is usable', () => {
    expect(traceCallLines([])).toEqual([]);
    const bad = { ...row(), at: 'soon', ttftMs: -1, prompt: { processed: 'many' } } as unknown as TraceCallRow;
    expect(traceCallLines([bad], 'local:m')).toEqual(['  calls:', '    narrator  1.8 s']);
  });
});

describe('renderTrace', () => {
  test('the call lines sit where the calls line was', () => {
    const trace: Trace = {
      seed: 1,
      now: '2026-11-14T12:00:00.000Z',
      window: 8192,
      reserve: 1024,
      tokens: { estimated: 3500 },
      blocks: [{ src: 'main', role: 'system', tok: 10 }],
      lore: { fired: [], cut: [], budget: 0 },
      recap: { ids: [], arcs: [], boundary: null },
      prefill: null,
      macros: { unknown: [] },
      trimmed: null,
      calls: [row({ at: 2100, ttftMs: 400, prompt: { cached: 3412, processed: 96 } })],
      agents: {},
      presetHash: 'h',
      loreHashes: {},
    } as Trace;
    const out = renderTrace('a1', { trace, gen: { kind: 'model', connection: 'local', model: 'm' }, continued: false }).split('\n');
    expect(out.slice(-2)).toEqual(['  calls:', '    narrator  +2.1 s  first token 0.4 s  1.8 s  prompt 3 412 cached, 96 new']);
  });
});
