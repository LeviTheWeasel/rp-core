// Ported from Bunraku:src/core/assembly/assemble-recall.test.ts@702d8120 (the assembler cases, rewritten against rp-core's assemble).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Compendium block in assemble (D-155): byte-identical without candidates, the 60/40 split of
// the lore budget, the block's place at depth 1, the tail, trace.compendium.
import { describe, expect, test } from 'bun:test';
import { BLOCK_HEADER, blockSection } from '../../src/agents/compendium/place.ts';
import { COMPENDIUM_LIMITS } from '../../src/agents/compendium/profile.ts';
import { assemble, type AssembleInput } from '../../src/prompt/assemble.ts';
import { loreBudget } from '../../src/prompt/budget.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import type { ToolSpec } from '../../src/providers/types.ts';
import { always, input, lines, longView, ok, source, textOf } from '../prompt-m2/fixtures.ts';
import { blockInput, cand } from './fixtures.ts';

const READ_LORE: ToolSpec = { name: 'read_lore', description: 'Read lore entries.', schema: { type: 'object', properties: {} } };
const MIRA = cand('C1', 'Mira', { key: 'character:mira', full: 'Keeps the lantern.', brief: 'Lantern keeper.' });
const HARBOR = cand('C2', 'Harbor', { key: 'location:harbor', tier: 2, via: 'window', full: 'A salt town.', brief: 'Salt town.' });
const BLOCK = `${BLOCK_HEADER}\n[Lore: Mira]\nKeeps the lantern.\n\n[Lore: Harbor]\nA salt town.`;

const run = (over: Partial<AssembleInput> = {}) => ok(assemble(input({ view: longView(), ...over })));

describe('no candidates: the M4 request', () => {
  const base = (): Partial<AssembleInput> => ({
    lorebooks: [source('lib', [always('L1', { content: 'l'.repeat(3 * 100) }), always('L2', { content: 'Deep lore.', position: { depth: 1 } })])],
    tools: [READ_LORE],
    placements: [{ depth: 1, role: 'system', src: 'director', text: 'DIRECTIVE' }],
  });

  test('no input → no block and no trace key', () => {
    const r = run(base());
    expect('compendium' in r.trace).toBe(false);
    expect(r.messages.some((x) => x.src.startsWith('compendium'))).toBe(false);
  });

  test('an input with zero candidates sends byte-identical messages; the trace only gains compendium (picks: [])', () => {
    const a = run({ ...base(), explain: true });
    const b = run({ ...base(), explain: true, compendium: blockInput([], { rev: 'r7', hidden: 2 }) });
    const { compendium, ...rest } = b.trace;
    expect(JSON.stringify({ ...b, trace: rest })).toBe(JSON.stringify(a));
    expect(compendium).toEqual({
      rev: 'r7',
      source: 'lexical',
      profile: 'full',
      picks: [],
      injected: [],
      cut: [],
      repeated: [],
      hidden: 2,
      budget: { share: loreBudget(32768, 8192), lore: a.loreUse!.used, block: 0 },
    });
    expect(a.trace.lore.budget).toBe(loreBudget(32768, 8192));
  });
});

describe('the lore budget with candidates (60/40)', () => {
  // window 1000 − reserve 100: the lore share is round(0.25 × 900) = 225 tokens (chars/3 here).
  const tight = { window: 1000, reserve: 100, counter: CHARS_COUNTER };
  const share = loreBudget(1000, 100);

  test('the lore run gets floor(share × (1 − minShare)); lore that fit the whole share is cut', () => {
    const lore = [source('lib', [always('L1', { content: 'l'.repeat(3 * 150) })])];
    const without = run({ ...tight, lorebooks: lore });
    expect(share).toBe(225);
    expect(without.trace.lore).toMatchObject({ budget: 225, cut: [] });
    expect(without.trace.lore.fired.map((h) => h.id)).toEqual(['L1']);

    const r = run({ ...tight, lorebooks: lore, compendium: blockInput([MIRA, HARBOR]) });
    expect(r.trace.lore).toMatchObject({ budget: Math.floor(225 * 0.6), fired: [], cut: ['lib:L1'] });
    expect(r.trace.compendium!.budget).toEqual({ share: 225, lore: 0, block: r.trace.compendium!.budget.block });
    expect(textOf(r.messages.find((x) => x.src === 'compendium:block')!)).toBe(BLOCK);
  });

  test('the block takes what the lore run left of the whole share, never more', () => {
    const lore = [source('lib', [always('L1', { content: 'l'.repeat(3 * 100) })])];
    const big = (n: number) => cand(`C${n}`, `Big ${n}`, { key: `k${n}`, full: 'storm '.repeat(20), brief: 'storm '.repeat(15) });
    const r = run({ ...tight, lorebooks: lore, explain: true, compendium: blockInput([big(1), big(2), big(3)]) });
    const used = r.loreUse!.used;
    expect(r.trace.lore.fired.map((h) => h.id)).toEqual(['L1']);
    const c = r.trace.compendium!;
    expect(c.budget.share).toBe(225);
    expect(c.budget.lore).toBe(used);
    expect(c.budget.block).toBeLessThanOrEqual(225 - used);
    expect(c.injected.length).toBeGreaterThan(0);
    expect(c.cut.length).toBeGreaterThan(0);
    expect(c.budget.block).toBe(CHARS_COUNTER.count(BLOCK_HEADER) + c.injected.reduce((a, h) => a + h.tok, 0));
  });

  test('another minShare moves the split', () => {
    const r = run({ ...tight, compendium: blockInput([MIRA], { minShare: 0.25 }) });
    expect(r.trace.lore.budget).toBe(Math.floor(225 * 0.75));
  });

  test('the lite profile caps the block at limits.blockTok', () => {
    const wide = Array.from({ length: 6 }, (_, i) => cand(`C${i + 1}`, `E${i + 1}`, { key: `k${i + 1}`, brief: 'z'.repeat(3 * 600) }));
    const r = run({ window: 131_072, reserve: 8192, compendium: blockInput(wide, { profile: 'lite', limits: COMPENDIUM_LIMITS.lite }) });
    const c = r.trace.compendium!;
    expect(c.budget.block).toBeLessThanOrEqual(1600);
    expect(c.injected.length).toBe(2);
    expect(c.injected.every((h) => h.mode === 'brief')).toBe(true);
  });
});

describe('the block in the request', () => {
  test('depth 1: below the author note and depth lore, above the Director, right above U', () => {
    const r = run({
      lorebooks: [source('lib', [always('L2', { content: 'Deep lore.', position: { depth: 1 } })])],
      authorNote: { text: 'NOTE', depth: 1, role: 'system' },
      placements: [{ depth: 1, role: 'system', src: 'director', text: 'DIRECTIVE' }],
      compendium: blockInput([MIRA, HARBOR]),
    });
    const tail = lines(r.messages).slice(-6);
    expect(tail).toEqual([
      'assistant|history|At the lighthouse.',
      'system|author_note|NOTE',
      expect.stringMatching(/^system\|lore[^|]*\|Deep lore\.$/),
      `system|compendium:block|${BLOCK}`,
      'system|director|DIRECTIVE',
      'user|history|Show me the map.',
    ]);
    expect(r.messages.find((x) => x.src === 'compendium:block')!.placement).toBe('inline');
    expect(r.trace.blocks.some((b) => b.src === 'compendium:block' && b.role === 'system')).toBe(true);
  });

  test('the brief tail comes only when read_lore is offered and survives the prefill rule', () => {
    const lite = blockInput([MIRA], { profile: 'lite', limits: COMPENDIUM_LIMITS.lite });
    const block = (over: Partial<AssembleInput>) => textOf(run({ compendium: lite, ...over }).messages.find((x) => x.src === 'compendium:block')!);
    expect(block({ tools: [READ_LORE] })).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.\n(more: read_lore C1)`);
    expect(block({ tools: [] })).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
    expect(block({ tools: [{ ...READ_LORE, name: 'search_lore' }] })).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
    const withPrefill = { ...input().preset, prefill: 'Sure:' };
    expect(block({ tools: [READ_LORE], preset: withPrefill, prefillVsTools: 'prefill' })).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
  });

  test('no reasons reach the request: the block holds names and texts only', () => {
    const r = run({ compendium: blockInput([MIRA, HARBOR]) });
    const sent = JSON.stringify(r.messages);
    for (const word of ['mention', 'window', 'character:mira', 'tier']) expect(sent).not.toContain(word);
  });

  test('the block is part of the fixed prompt, named when the prompt cannot fit', () => {
    const r = assemble(input({ view: longView(), window: 300, reserve: 200, counter: CHARS_COUNTER, compendium: blockInput([cand('C1', 'A', { brief: 'x' })]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('the Compendium block');
  });
});

describe('trace.compendium', () => {
  test('picks from the candidates; injected, cut and repeated from the block; hidden from the input; no texts', () => {
    const big = cand('C3', 'Big', { key: 'item:big', tier: 3, via: 'constant', brief: 'b'.repeat(3 * 800) });
    const r = run({ compendium: blockInput([MIRA, HARBOR, big, cand('C4', 'Seen', { key: 'note:seen' })], { inPrompt: new Set(['note:seen']), hidden: 3, rev: 'abc' }), counter: CHARS_COUNTER, window: 4000, reserve: 1000 });
    const tok = (name: string, text: string) => CHARS_COUNTER.count(blockSection(name, text));
    expect(r.trace.compendium).toEqual({
      rev: 'abc',
      source: 'lexical',
      profile: 'full',
      picks: [
        { ref: 'C1', key: 'character:mira', via: 'mention' },
        { ref: 'C2', key: 'location:harbor', via: 'window' },
        { ref: 'C3', key: 'item:big', via: 'constant' },
        { ref: 'C4', key: 'note:seen', via: 'mention' },
      ],
      injected: [
        { ref: 'C1', tok: tok('Mira', 'Keeps the lantern.'), mode: 'full' },
        { ref: 'C2', tok: tok('Harbor', 'A salt town.'), mode: 'full' },
      ],
      cut: [{ ref: 'C3', tok: tok('Big', 'b'.repeat(3 * 800)) }],
      repeated: ['note:seen'],
      hidden: 3,
      budget: { share: loreBudget(4000, 1000), lore: 0, block: CHARS_COUNTER.count(BLOCK_HEADER) + tok('Mira', 'Keeps the lantern.') + tok('Harbor', 'A salt town.') },
    });
    expect(JSON.stringify(r.trace.compendium)).not.toContain('lantern');
  });
});
