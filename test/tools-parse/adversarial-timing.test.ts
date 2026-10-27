// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// tools/args.ts, tools/prompted.ts and tools/leaks.ts on 100 kB adversarial texts (review findings
// redos-python-call-cubic, redos-fence-before-cubic, unclosed-complete-json-then-prose; D-97's flood
// of name-tag openers that never close, which the stripper read again from the first on every push). A parse, a
// strip and a leak recovery each take under 50 ms. The streaming stripper, fed 16 characters at a
// time, stays within 3× + 50 ms of the same stream over plain prose of the same length (that baseline is
// the cost of appending to and indexing a growing string, not of the parser). Each check first runs a
// 2 kB version, where the old cubic patterns already took seconds, so a regression fails in seconds
// instead of hanging on the 100 kB text (nothing interrupts a running regex).
import { describe, expect, test } from 'bun:test';
import { parseToolArgs, pythonCall } from '../../src/tools/args.ts';
import { recoverLeaks } from '../../src/tools/leaks.ts';
import { createPromptedStripper, parsePromptedCalls, stripPromptedCalls, type OfferedTool } from '../../src/tools/prompted.ts';

const N = 100_000;
const SMALL = 2_000;
const BUDGET_MS = 50;
const BLOCK = '<tool_call>{"name":"search_lore","args":{"query":"x"}}</tool_call>';
const SCHEMA = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };

/** The fastest of `runs` runs, in ms (the one least disturbed by other work on the machine). */
function best(f: () => unknown, runs = 3): number {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const at = performance.now();
    f();
    min = Math.min(min, performance.now() - at);
  }
  return min;
}

function stream16(text: string, tools?: readonly OfferedTool[]): string {
  const s = createPromptedStripper(tools);
  let out = '';
  for (let i = 0; i < text.length; i += 16) out += s.push(text.slice(i, i + 16));
  return out + s.end();
}

/** The 16-character stream over plain prose as long as `length`: what any stream of that size costs. */
const floors = new Map<number, number>();
function streamFloor(length: number): number {
  let ms = floors.get(length);
  if (ms === undefined) {
    const prose = 'The tavern was quiet. '.repeat(Math.ceil(length / 22)).slice(0, length);
    ms = best(() => stream16(prose), 5);
    floors.set(length, ms);
  }
  return ms;
}

/** `run` on the 2 kB text, then on the 100 kB one, each under the budget. */
function fast(make: (n: number) => string, run: (text: string) => unknown, budget = BUDGET_MS): void {
  const small = make(SMALL);
  expect(best(() => run(small), 1)).toBeLessThan(budget);
  const big = make(N);
  expect(best(() => run(big))).toBeLessThan(budget);
}

/**
 * The 16-character stream: equal to the batch strip, and within the budget of the prose floor. The
 * floor is a GC-bound cost that swings 1–4× between runs inside the full suite's heap, so the bound
 * scales with it (3 × floor + budget, best of 5): a per-push rescan (0.3 s and more at 100 kB) still
 * fails it, a collection that lands in one run does not.
 */
function fastStream(make: (n: number) => string, extra = BUDGET_MS, tools?: readonly OfferedTool[]): void {
  const small = make(SMALL);
  expect(best(() => stream16(small, tools), 1)).toBeLessThan(3 * streamFloor(small.length) + extra);
  const big = make(N);
  expect(stream16(big, tools)).toBe(stripPromptedCalls(big, tools));
  expect(best(() => stream16(big, tools), 5)).toBeLessThan(3 * streamFloor(big.length) + extra);
}

describe('the python-call form (redos-python-call-cubic)', () => {
  test('a call that never closes after a newline run: native arguments and a prompted block', () => {
    fast((n) => `search_lore(${'\n'.repeat(n)}query="x"`, (t) => parseToolArgs(t, SCHEMA, 'search_lore'));
    fast((n) => `f(${' '.repeat(n)}x`, (t) => pythonCall(t));
    const cut = (n: number): string => `Mira nods. <tool_call>search_lore(${'\n'.repeat(n)}que`;
    fast(cut, (t) => parsePromptedCalls(t));
    fast(cut, (t) => stripPromptedCalls(t));
    fastStream(cut);
    expect(parsePromptedCalls(cut(10))[0]!.error).toContain('cut off');
  });
  test('string literals that never close (each quote used to rescan to the end)', () => {
    fast((n) => `f(${'"\\'.repeat(n / 2)})`, (t) => pythonCall(t));
    fast((n) => `f('${"x\\'".repeat(n / 3)})`, (t) => pythonCall(t));
    fast((n) => `f(${'"""'}${'""a'.repeat(n / 3)})`, (t) => pythonCall(t));
    fast((n) => `f(${`"'`.repeat(n / 2)})`, (t) => pythonCall(t));
    fast((n) => `f(${'"\\'.repeat(n / 2)})`, (t) => parseToolArgs(t, { type: 'object' }, 'f'));
  });
});

describe('fences around blocks (redos-fence-before-cubic)', () => {
  test('a fence line with a long run of trailing blanks before a block', () => {
    const before = (n: number): string => `\`\`\`${' '.repeat(n)}\nprose ${BLOCK}`;
    fast(before, (t) => stripPromptedCalls(t));
    fast(before, (t) => parsePromptedCalls(t));
    fastStream(before);
    expect(stripPromptedCalls(before(10))).toBe(`\`\`\`${' '.repeat(10)}\nprose`);
    const stray = (n: number): string => `\`\`\`json${'\t'.repeat(n)}\`\n${BLOCK}`;
    fast(stray, (t) => stripPromptedCalls(t));
    fast(stray, (t) => parsePromptedCalls(t));
    fastStream(stray);
  });
  test('a long run of blanks after a block (the closing fence may still come)', () => {
    const after = (n: number): string => `${BLOCK}${' '.repeat(n)}The end.`;
    fast(after, (t) => stripPromptedCalls(t));
    fast(after, (t) => parsePromptedCalls(t));
    fastStream(after);
    fastStream((n) => `${BLOCK}${'\n'.repeat(n)}The end.`);
    const lines = (n: number): string => `${BLOCK}${' '.repeat(n / 2)}\n${' '.repeat(n / 2)}x`;
    fast(lines, (t) => stripPromptedCalls(t));
    fast(lines, (t) => parsePromptedCalls(t));
  });
  test('leak recovery widening over a fence', () => {
    fast(
      (n) => `\`\`\`${' '.repeat(n)}\nprose <function=search_lore>{"query":"x"}</function>\n\`\`\``,
      (t) => recoverLeaks(t, { offered: ['search_lore'], nativeCalls: 0 }),
    );
  });
});

describe('unclosed blocks followed by prose (unclosed-complete-json-then-prose)', () => {
  test('a long call value, then prose: parse, strip and stream stay linear', () => {
    const json = (n: number): string => `Mira. <tool_call>{"name":"search_lore","args":{"query":"${'x'.repeat(n)}"}}\nThe end.`;
    fast(json, (t) => parsePromptedCalls(t));
    fast(json, (t) => stripPromptedCalls(t));
    fastStream(json);
    expect(stripPromptedCalls(json(10))).toBe('Mira.\nThe end.');
    const py = (n: number): string => `<tool_call>search_lore(query="${'x'.repeat(n)}")\nThe end.`;
    fast(py, (t) => parsePromptedCalls(t));
    fast(py, (t) => stripPromptedCalls(t));
    fastStream(py);
    const word = (n: number): string => `<tool_call>{"name":"a"}\n${'a'.repeat(n)}(`;
    fast(word, (t) => parsePromptedCalls(t));
    fastStream(word);
  });
  test('a held block before a pending one is not re-read on every push', () => {
    // Without the stripper's memo of the value-end decision this took 1.6 s (a JSON.parse of the first block per push).
    const held = (n: number): string => `<tool_call>{"name":"a","args":{"q":"${'x'.repeat(n)}"}}\n<tool_call>{"name":"b","args":{"q":"${'y'.repeat(n)}`;
    fastStream(held, 250);
  });
});

describe('a flood of openers that never close (D-97 name tags)', () => {
  const TOOLS: OfferedTool[] = [{ name: 'search_history', schema: SCHEMA }];
  /** `unit` repeated to about n characters after a line of prose. */
  const flood = (unit: string) => (n: number): string => `Mira nods.\n${unit.repeat(Math.ceil(n / unit.length))}`;

  test('thousands of <search_history openers, unclosed: parse, strip and stream stay linear', () => {
    for (const unit of ['<search_history>', '<search_history>\n', '<SEARCH_HISTORY>x ', '<ns:search_history q="1">', '<search_history ', '<search_history', '</search_history>']) {
      fast(flood(unit), (t) => parsePromptedCalls(t, TOOLS));
      fast(flood(unit), (t) => stripPromptedCalls(t, TOOLS));
      fastStream(flood(unit), BUDGET_MS, TOOLS);
    }
    // Each opener but the last is empty and ended by the next one: a wrapper, markup (d97-wrapper-nesting).
    // The last runs to the end, empty: one cut-off call.
    const flooded = parsePromptedCalls('<search_history>'.repeat(3000), TOOLS);
    expect(flooded).toHaveLength(1);
    expect(flooded[0]!.error).toContain('cut off');
    expect(stripPromptedCalls(flood('<search_history>\n')(N), TOOLS)).toBe('Mira nods.');
    expect(stripPromptedCalls(flood('<search_history>x ')(SMALL), TOOLS)).toBe('Mira nods.');
  });

  test("one opener left unclosed, then prose full of '<' (d97-pending-tag-rescan-quadratic: each push read the open body from its start, 2 s at 100 kB)", () => {
    const after = (opener: string, unit: string) => (n: number): string => `${opener}${unit.repeat(Math.ceil(n / unit.length))}`;
    for (const [opener, unit] of [
      ['<search_history>q\n', 'She <i>smiles</i>. '],
      ['<search_history>q\n', '<'],
      ['<search_history>', '</read_history>'],
      ['<search_history>', 'a <b '],
      ['<tool_call>{"name": "a"', '</search_hi '],
    ] as const) {
      fastStream(after(opener, unit), BUDGET_MS, TOOLS);
    }
    fastStream(after('<tool_call>', 'She <i>smiles</i>. '));
    // Read on, the body decides what the batch decides (fastStream compares them): the first line is the query.
    expect(stream16(after('Mira nods. <search_history>q\n', 'She <i>smiles</i>. ')(SMALL), TOOLS)).toStartWith('Mira nods.\nShe <i>smiles</i>.');
  }, 30_000);

  test('the same flood of <tool_call> openers, with and without tools (each push read every held block again: 17 s at 100 kB)', () => {
    for (const unit of ['<tool_call>', '<tool_call>\n', '<tool_call>{"name":"a"} ']) {
      fastStream(flood(unit));
      fastStream(flood(unit), BUDGET_MS, TOOLS);
    }
    expect(stream16(flood('<tool_call>')(N))).toBe('Mira nods.');
  });

  test('blocks that do close, back to back, and prose between them on one long line (each read its line from the start)', () => {
    // ASCII text: the prose floor is ASCII, and a 16-bit string costs twice as much to grow and index.
    for (const unit of ['<search_history>brat</search_history>\n', '<search_history>brat</search_history> x ', `${BLOCK} x `]) {
      fast(flood(unit), (t) => parsePromptedCalls(t, TOOLS));
      fast(flood(unit), (t) => stripPromptedCalls(t, TOOLS));
      fastStream(flood(unit), BUDGET_MS, TOOLS);
    }
    fastStream(flood(`${BLOCK}\n`));
    // A parse and a strip on a 16-bit text (no prose floor to compare): each block's opening fence
    // was looked for from its line's start (90 ms at 100 kB).
    for (const unit of ['<search_history>брат</search_history> x ', `${BLOCK} я `]) {
      fast(flood(unit), (t) => parsePromptedCalls(t, TOOLS));
      fast(flood(unit), (t) => stripPromptedCalls(t, TOOLS));
    }
    const line = '<search_history>brat</search_history> x ';
    expect(stripPromptedCalls(flood(line)(SMALL), TOOLS)).toBe(`Mira nods.\n${'x '.repeat(Math.ceil(SMALL / line.length))}`);
  });
});
