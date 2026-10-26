// prompt/assemble.ts tokenFactor (M1b, D-50): every budget estimate is scaled by the model's EMA
// correction; the trace keeps the raw estimates.
import { describe, expect, test } from 'bun:test';
import { assemble } from '../../src/prompt/assemble.ts';
import { estimateMessage, estimateMessages } from '../../src/prompt/tokens.ts';
import { HISTORY_BLOCK, greet, input, m, ok, path, preset } from '../assemble/fixtures.ts';

// Greeting (10 tokens) + 39 messages of 13 tokens each (27 chars + 4 overhead); no other blocks.
const longPath = () =>
  path([
    greet('g', 'Hello, traveller.'),
    ...Array.from({ length: 39 }, (_, i) => m(`m${i + 1}`, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(27))),
  ]);
const run = (window: number, tokenFactor?: number) =>
  assemble(input({ view: longPath(), preset: preset([HISTORY_BLOCK]), window, reserve: 100, ...(tokenFactor === undefined ? {} : { tokenFactor }) }));

describe('tokenFactor scales the budget [D-50]', () => {
  test('1.5 trims earlier than 1, still on the chunk grid', () => {
    // budget 300. ×1: greeting 10 + 15·13 = 205 fits, 23 messages would need 309 → cut after m24.
    // ×1.5: greeting 15 + 15·20 = 315 no longer fits, 15 + 7·20 = 155 does → cut after m32.
    const one = ok(run(400, 1));
    const more = ok(run(400, 1.5));
    expect(one.trace.trimmed).toEqual({ from: 'm1', to: 'm24' });
    expect(more.trace.trimmed).toEqual({ from: 'm1', to: 'm32' });
    expect(more.messages.length).toBeLessThan(one.messages.length);
  });

  test('a factor below 1 keeps more', () => {
    // ×0.8: greeting 8 + 23·11 = 261 fits, 31·11 + 8 = 349 does not → cut after m16.
    expect(ok(run(400, 0.8)).trace.trimmed).toEqual({ from: 'm1', to: 'm16' });
  });

  test('the trace keeps the raw estimates', () => {
    const r = ok(run(400, 1.5));
    expect(r.trace.tokens.estimated).toBe(estimateMessages(r.messages));
    expect(r.trace.blocks.map((b) => b.tok)).toEqual(r.messages.map((x) => estimateMessage(x)));
    expect(r.trace.blocks.every((b) => b.tok === 13 || b.tok === 10)).toBe(true);
  });

  test('unset, 1 and unusable factors are the same request', () => {
    const base = ok(run(400));
    for (const f of [1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = ok(run(400, f));
      expect(r.messages).toEqual(base.messages);
      expect(r.trace).toEqual(base.trace);
    }
  });

  test('the mandatory part is scaled too: what fits at ×1 can overflow at ×1.5', () => {
    // protected: greeting + the current message = 23 at ×1, 15 + 20 = 35 at ×1.5; available 30
    expect(run(130, 1).ok).toBe(true);
    const r = run(130, 1.5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('context_length_exceeded');
      expect(r.message).toContain('35 tokens');
    }
  });

  test('fixed blocks are scaled with the rest', () => {
    // A 270-character system block: 94 tokens raw. ×1.5 makes it 141 and pushes the cut on by a chunk.
    const big = { id: 'main', role: 'system' as const, enabled: true, content: 'S'.repeat(270), at: 'relative' as const };
    const p = preset([big, HISTORY_BLOCK]);
    const at = (f: number) => ok(assemble(input({ view: longPath(), preset: p, window: 500, reserve: 100, tokenFactor: f }))).trace.trimmed;
    // ×1: 400 − 94 = 306 for history → 15 kept (205). ×1.5: 400 − 141 = 259 → 15 kept cost 315, 7 kept cost 155.
    expect(at(1)).toEqual({ from: 'm1', to: 'm24' });
    expect(at(1.5)).toEqual({ from: 'm1', to: 'm32' });
  });
});
