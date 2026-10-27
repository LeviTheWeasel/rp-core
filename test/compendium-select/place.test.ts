// Ported from Bunraku:src/core/assembly/assemble-recall.test.ts@702d8120 (the placeRecall cases: header and sections, first-fit cut, no repeat, determinism).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Compendium block (D-155): picking, full vs brief, the tail, first-fit cuts, repeats, limits.
// The assembler part of the Bunraku file is in assemble-block.test.ts.
import { describe, expect, test } from 'bun:test';
import { BLOCK_HEADER, blockSection, placeBlock } from '../../src/agents/compendium/place.ts';
import { COMPENDIUM_LIMITS } from '../../src/agents/compendium/profile.ts';
import { blockInput, cand, LEN } from './fixtures.ts';

const MIRA = cand('C1', 'Mira', { key: 'b1:e1', full: 'Keeps the lantern.', brief: 'Lantern keeper.' });
const HARBOR = cand('C2', 'Harbor', { key: 'b1:e2', full: 'A salt town.', brief: 'Salt town.' });

describe('the text', () => {
  test("one text headed as RoleCall heads it: '[Lore: <name>]' and the text per entry, a blank line between", () => {
    const r = placeBlock(blockInput([MIRA, HARBOR]), 10_000, LEN, false);
    expect(r.text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nKeeps the lantern.\n\n[Lore: Harbor]\nA salt town.`);
    expect(r.injected).toEqual([
      { ref: 'C1', tok: LEN('[Lore: Mira]\nKeeps the lantern.'), mode: 'full' },
      { ref: 'C2', tok: LEN('[Lore: Harbor]\nA salt town.'), mode: 'full' },
    ]);
    // The header counts; the separators do not (Bunraku).
    expect(r.tok).toBe(LEN(BLOCK_HEADER) + r.injected[0]!.tok + r.injected[1]!.tok);
    expect(r).toMatchObject({ cut: [], repeated: [] });
  });

  test('no candidates → no text, nothing used', () => {
    expect(placeBlock(blockInput([]), 10_000, LEN, true)).toEqual({ text: null, tok: 0, injected: [], cut: [], repeated: [] });
  });

  test('a candidate with nothing to say is skipped silently', () => {
    const blank = cand('C3', 'Blank', { full: null, brief: '  ' });
    expect(placeBlock(blockInput([blank]), 10_000, LEN, true)).toEqual({ text: null, tok: 0, injected: [], cut: [], repeated: [] });
  });

  test('the same input, budget and counter give the same block', () => {
    const a = placeBlock(blockInput([MIRA, HARBOR]), 200, LEN, true);
    expect(placeBlock(blockInput([MIRA, HARBOR]), 200, LEN, true)).toEqual(a);
    expect(a.injected.length).toBe(2);
  });
});

describe('full or brief', () => {
  test('the full render when it fits, else the brief; the brief when there is no full render', () => {
    const fullTok = LEN(blockSection('Mira', 'Keeps the lantern.'));
    const briefTok = LEN(blockSection('Mira', 'Lantern keeper.'));
    const exact = (left: number) => placeBlock(blockInput([MIRA]), LEN(BLOCK_HEADER) + left, LEN, false);
    expect(exact(fullTok).injected).toEqual([{ ref: 'C1', tok: fullTok, mode: 'full' }]);
    expect(exact(fullTok - 1).injected).toEqual([{ ref: 'C1', tok: briefTok, mode: 'brief' }]);
    expect(exact(fullTok - 1).text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
    expect(exact(briefTok - 1)).toEqual({ text: null, tok: 0, injected: [], cut: [{ ref: 'C1', tok: briefTok }], repeated: [] });
    const noFull = cand('C1', 'Mira', { brief: 'Lantern keeper.' });
    expect(placeBlock(blockInput([noFull]), 10_000, LEN, false).injected).toEqual([{ ref: 'C1', tok: briefTok, mode: 'brief' }]);
  });

  test('a full render over the profile limit goes brief; the lite profile is always brief', () => {
    const long = cand('C1', 'Mira', { full: 'x'.repeat(4001), brief: 'Lantern keeper.' });
    expect(placeBlock(blockInput([long]), 100_000, LEN, false).injected[0]!.mode).toBe('brief');
    const at = cand('C1', 'Mira', { full: 'x'.repeat(4000), brief: 'Lantern keeper.' });
    expect(placeBlock(blockInput([at]), 100_000, LEN, false).injected[0]!.mode).toBe('full');
    const lite = blockInput([MIRA], { profile: 'lite', limits: COMPENDIUM_LIMITS.lite });
    expect(placeBlock(lite, 100_000, LEN, false).text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
  });

  test('the brief carries its tail on its own line only when the request offers read_lore', () => {
    const lite = (c = MIRA) => blockInput([c], { profile: 'lite', limits: COMPENDIUM_LIMITS.lite });
    expect(placeBlock(lite(), 10_000, LEN, true).text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.\n(more: read_lore C1)`);
    expect(placeBlock(lite(), 10_000, LEN, false).text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
    // No tail when the brief left nothing out (the request builder passes ''), and never after a full render.
    expect(placeBlock(lite({ ...MIRA, briefTail: '' }), 10_000, LEN, true).text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nLantern keeper.`);
    expect(placeBlock(blockInput([MIRA]), 10_000, LEN, true).text).toBe(`${BLOCK_HEADER}\n[Lore: Mira]\nKeeps the lantern.`);
    // The tail is part of the brief's cost.
    expect(placeBlock(lite(), 10_000, LEN, true).injected[0]!.tok).toBe(LEN('[Lore: Mira]\nLantern keeper.\n(more: read_lore C1)'));
  });
});

describe('cuts and repeats', () => {
  const big = (n: number) => cand(`C${n}`, `Big ${n}`, { key: `b1:big${n}`, full: 'storm '.repeat(40), brief: 'storm '.repeat(30) });
  const small = cand('C9', 'Small', { key: 'b1:s', full: 'Tiny.', brief: 'Tiny.' });

  test('first-fit in candidate order: what does not fit is cut and listed, a later smaller one still goes in', () => {
    const budget = 250;
    const r = placeBlock(blockInput([big(1), big(2), small, big(3)]), budget, LEN, false);
    expect(r.injected.map((h) => h.ref)).toEqual(['C1', 'C9']);
    // Big 1's full render does not fit, its brief does; Small fits whole in what is left.
    expect(r.injected.map((h) => h.mode)).toEqual(['brief', 'full']);
    expect(r.cut).toEqual([
      { ref: 'C2', tok: LEN(blockSection('Big 2', 'storm '.repeat(30))) },
      { ref: 'C3', tok: LEN(blockSection('Big 3', 'storm '.repeat(30))) },
    ]);
    expect(r.tok).toBeLessThanOrEqual(budget);
    expect(r.tok).toBe(LEN(BLOCK_HEADER) + r.injected.reduce((a, h) => a + h.tok, 0));
  });

  test('a budget below the header cuts everything', () => {
    const r = placeBlock(blockInput([small]), LEN(BLOCK_HEADER) - 1, LEN, false);
    expect(r).toEqual({ text: null, tok: 0, injected: [], cut: [{ ref: 'C9', tok: LEN(blockSection('Small', 'Tiny.')) }], repeated: [] });
  });

  test('an entry already in the prompt is repeated, not sent, and takes no slot', () => {
    const limits = { ...COMPENDIUM_LIMITS.full, maxEntries: 1 };
    const r = placeBlock(blockInput([MIRA, HARBOR], { inPrompt: new Set(['b1:e1']), limits }), 10_000, LEN, false);
    expect(r.repeated).toEqual(['b1:e1']);
    expect(r.injected.map((h) => h.ref)).toEqual(['C2']);
    expect(r.text).not.toContain('Mira');
  });

  test('past maxEntries the rest is cut with what it would have cost', () => {
    const many = Array.from({ length: 8 }, (_, i) => cand(`C${i + 1}`, `E${i + 1}`, { key: `k${i + 1}`, full: `full ${i + 1}`, brief: `brief ${i + 1}` }));
    const lite = placeBlock(blockInput(many, { profile: 'lite', limits: COMPENDIUM_LIMITS.lite }), 100_000, LEN, false);
    expect(lite.injected.map((h) => h.ref)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    expect(lite.cut).toEqual([
      { ref: 'C7', tok: LEN(blockSection('E7', 'brief 7')) },
      { ref: 'C8', tok: LEN(blockSection('E8', 'brief 8')) },
    ]);
    const full = placeBlock(blockInput(many, { limits: { ...COMPENDIUM_LIMITS.full, maxEntries: 7 } }), 100_000, LEN, false);
    expect(full.cut).toEqual([{ ref: 'C8', tok: LEN(blockSection('E8', 'full 8')) }]);
  });

  test('the lite block never passes limits.blockTok, whatever the budget', () => {
    const fat = Array.from({ length: 6 }, (_, i) => cand(`C${i + 1}`, `E${i + 1}`, { key: `k${i + 1}`, brief: 'z'.repeat(600) }));
    const r = placeBlock(blockInput(fat, { profile: 'lite', limits: COMPENDIUM_LIMITS.lite }), 100_000, LEN, false);
    expect(r.injected.length).toBe(2);
    expect(r.cut.map((h) => h.ref)).toEqual(['C3', 'C4', 'C5', 'C6']);
    expect(r.tok).toBeLessThanOrEqual(1600);
    // The budget still applies below the cap.
    expect(placeBlock(blockInput(fat, { profile: 'lite', limits: COMPENDIUM_LIMITS.lite }), 700, LEN, false).injected.length).toBe(1);
  });
});
