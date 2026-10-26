// assemble M2: the lore budget (§11 "Доли окна", ST checkWorldInfo): 25 % of the prompt part of the
// window, in tokens corrected by the model's EMA factor [D-50], probability before budget.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_PRESET, type Preset } from '../../src/formats/native.ts';
import { LORE_SHARE, loreBudget } from '../../src/prompt/budget.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { allText, always, bySrc, input, longView, source, textOf, withLore } from './fixtures.ts';

describe('loreBudget', () => {
  test('25 % of window − reserve, rounded (ST Math.round), never below 1 (ST `|| 1`)', () => {
    expect(LORE_SHARE).toBe(0.25);
    expect(loreBudget(32768, 8192)).toBe(6144);
    expect(loreBudget(1000, 200)).toBe(200);
    expect(loreBudget(1000, 0)).toBe(250);
    expect(loreBudget(10, 0)).toBe(3); // 2.5 rounds up, as Math.round does
    expect(loreBudget(2, 0)).toBe(1);
    expect(loreBudget(1, 0)).toBe(1); // 0.25 rounds to 0 → 1
    expect(loreBudget(100, 100)).toBe(1);
    expect(loreBudget(100, 200)).toBe(1);
  });

  test('unusable inputs give the floor', () => {
    expect(loreBudget(Number.NaN, 0)).toBe(1);
    expect(loreBudget(-50, 0)).toBe(1);
    expect(loreBudget(1000, Number.NaN)).toBe(250); // an unusable reserve reserves nothing
  });

  test('the trace records it', () => {
    expect(withLore([]).trace.lore.budget).toBe(loreBudget(32768, 8192));
    expect(withLore([], { window: 1000, reserve: 200 }).trace.lore.budget).toBe(200);
  });
});

describe('the budget cuts by order, over the accepted text (CHARS_COUNTER: 300 chars = 100 tokens)', () => {
  // Each entry is 299 chars; with its '\n' the accepted text grows by exactly 100 tokens a step.
  const big = (id: string, order: number, patch = {}) => always(id, { order, content: id.padEnd(299, '.'), ...patch });
  const four = [big('E1', 40), big('E2', 30), big('E3', 20), big('E4', 10)];
  const run = (tokenFactor?: number, entries = four) =>
    withLore(entries, { window: 1000, reserve: 200, ...(tokenFactor === undefined ? {} : { tokenFactor }) });

  test('budget 200: E1 fits (100), E2 would make 200 (not below the budget) → cut, the rest skipped', () => {
    const r = run();
    expect(r.trace.lore.fired.map((f) => f.id)).toEqual(['E1']);
    expect(r.trace.lore.cut).toEqual(['lib:E2', 'lib:E3', 'lib:E4']);
    expect(textOf(bySrc(r.messages, 'lore_before')!)).toBe(four[0]!.content);
  });

  test('the counts are scaled by tokenFactor, rounded up like the history budget', () => {
    // ×0.5: 50, 100, 150 fit; 200 does not.
    expect(run(0.5).trace.lore.fired.map((f) => f.id)).toEqual(['E1', 'E2', 'E3']);
    expect(run(0.5).trace.lore.cut).toEqual(['lib:E4']);
    // ×1.5: 150 fits, 300 does not.
    expect(run(1.5).trace.lore.fired.map((f) => f.id)).toEqual(['E1']);
    // ×2: even the first (200) does not fit.
    expect(run(2).trace.lore.fired).toEqual([]);
    expect(run(2).trace.lore.cut).toEqual(['lib:E1', 'lib:E2', 'lib:E3', 'lib:E4']);
  });

  test('an ignoreBudget entry skips the check but its text counts against the entries after it (ST)', () => {
    // ST checkWorldInfo: `acceptedContent = nextContent` runs for every accepted entry, ignoreBudget
    // included. I (100) is accepted without a check; E1 would make 200, not below the budget → cut.
    const r = run(undefined, [big('I', 99, { ignoreBudget: true }), ...four]);
    expect(r.trace.lore.fired.map((f) => f.id)).toEqual(['I']);
    expect(r.trace.lore.cut).toEqual(['lib:E1', 'lib:E2', 'lib:E3', 'lib:E4']);
  });

  test('an entry whose slot the preset lacks still costs its tokens', () => {
    const p: Preset = { ...BUILTIN_PRESET, blocks: BUILTIN_PRESET.blocks.map((b) => (b.id === 'lore_before' ? { ...b, enabled: false } : b)) };
    const r = withLore([big('E1', 40), big('E2', 30, { position: 'after' })], { window: 1000, reserve: 200, preset: p });
    expect(r.trace.lore.fired.map((f) => f.id)).toEqual(['E1']);
    expect(r.trace.lore.cut).toEqual(['lib:E2']);
    expect(allText(r.messages)).not.toContain('E1...');
    expect(allText(r.messages)).not.toContain('E2...');
  });

  test('a cut entry is not a fire: timers start only from accepted entries', () => {
    const r = run();
    expect(r.trace.lore.fired.some((f) => f.id === 'E2')).toBe(false);
  });

  test('placed lore is part of the mandatory prompt: too much of it is context_length_exceeded', () => {
    // Three entries fit the lore budget at ×0.5 and are sent: ~300 raw tokens more in the request.
    const bare = withLore([], { window: 1000, reserve: 200, tokenFactor: 0.5 });
    expect(run(0.5).trace.tokens.estimated).toBeGreaterThan(bare.trace.tokens.estimated + 300);
    // ignoreBudget lore of ~800 tokens with 800 available: the mandatory part does not fit.
    const huge = Array.from({ length: 8 }, (_, i) => big(`H${i}`, i, { ignoreBudget: true }));
    const r = assemble(input({ view: longView(), lorebooks: [source('lib', huge)], window: 1000, reserve: 200 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('context_length_exceeded');
  });
});
