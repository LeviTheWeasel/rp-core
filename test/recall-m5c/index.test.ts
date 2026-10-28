// Ported from Bunraku:src/core/compendium/recall-core.test.ts@702d8120 ("the index": deterministic
// text, handles and aliases; taglines; the budget; depth; one heading; the live window).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/recall.ts recallIndex (M5c, D-197). Adapted from Bunraku: classic entries are not
// offered (227 candidates, not 233); there is no detail setting (the tagline is derived, never a
// preview) and no depth setting (2); one `World Knowledge` heading replaces the per-book headers; the
// live window is fresh.ts's (a summary while its last message is visible, a plot or event while the
// message that filed it is), plus the {{recap}} slot. Fresh: the lite shortlist.
import { describe, expect, test } from 'bun:test';
import { recallIndex, SHORTLIST, type RecallIndexInput } from '../../src/agents/compendium/recall.ts';
import { HARBOR_CANDIDATES } from './harbor.ts';
import { ce, count, harborView, viewOf, visOf } from './kit.ts';

const FULL: Omit<RecallIndexInput, 'view'> = { profile: 'full', window: 200_000, count };

describe('the full index (Bunraku recall-core.test.ts "the index")', () => {
  const view = harborView();

  test('lists every live typed entry once under its tree group, with handles, aliases and taglines, and is the same every time', () => {
    const a = recallIndex({ view, ...FULL });
    expect(recallIndex({ view, ...FULL }).text).toBe(a.text);
    expect(a.omitted).toBe(0);
    expect(a.truncated).toBe(false);
    expect(a.text).toContain('Cast (');
    expect(a.text).toMatch(/\[e\d+\] Mira Vance \(aka The Lamplighter\) - Keeps the last lantern lit\./);
    expect(a.handles.get('e1')).toBe('lib:harbor:c-mira');
    // 239 entries: 3 switched off, 2 retired plots, the retired Ghost and 6 classic entries are not offered.
    expect(a.candidates).toBe(HARBOR_CANDIDATES);
    expect(a.shown).toBe(HARBOR_CANDIDATES);
    expect(a.handles.size).toBe(HARBOR_CANDIDATES);
    expect(a.text).not.toContain('Switched Off');
    expect(a.text).not.toContain('Classic');
    expect(a.text).not.toContain('Ghost');
    expect(a.text).not.toContain(`[e${HARBOR_CANDIDATES + 1}]`);
  });

  test('the golden head: one heading, Bunraku’s groups and lines, handles in print order', () => {
    const lines = recallIndex({ view, ...FULL }).text.split('\n');
    expect(lines.slice(0, 7)).toEqual([
      `=== World Knowledge (${HARBOR_CANDIDATES} entries) ===`,
      'Cast (59)',
      '  Lantern Guild (16)',
      '    [e1] Mira Vance (aka The Lamplighter) - Keeps the last lantern lit.',
      '    [e2] Dov Ketter - Quartermaster.',
      '    [e3] Extra Character 3',
      '    [e4] Extra Character 6',
    ]);
    // Bunraku's group headings (probe of its index), Unsorted gone with the classic entries.
    const headings = lines.filter((l) => !l.includes('[e'));
    expect(headings.slice(1, 7)).toEqual(['Cast (59)', '  Lantern Guild (16)', '  Salt Court (16)', '  Ashen Wardens (14)', '  Unaffiliated (13)', 'Places (30)']);
    expect(headings).toContain('Narrative (24)');
    expect(headings).toContain('  Unlinked Summaries (4)');
    expect(headings).not.toContain('Unsorted (6)');
  });

  test('an entry without an explicit tagline gets the derived one; one without a description has none', () => {
    const v = viewOf([ce('character:xan', 'character', 'Xan', { data: { tagline: 'Tall.' } }), ce('item:lamp', 'item', 'Lamp', { data: { description: 'A brass lamp. It hums.' } }), ce('item:rope', 'item', 'Rope')]);
    const text = recallIndex({ view: v, ...FULL }).text;
    expect(text).toContain('[e1] Xan - Tall.');
    expect(text).toContain('] Lamp - A brass lamp.');
    expect(text).toMatch(/\] Rope$/m);
  });

  test('a token budget stops the list, says how many it left out, and the cut entries get no handle', () => {
    const full = recallIndex({ view, ...FULL });
    // min(20 000, 25 % of 1 600) = 400 tokens.
    const cut = recallIndex({ view, ...FULL, window: 1600 });
    expect(cut.shown).toBeLessThan(full.shown);
    expect(cut.shown).toBeGreaterThan(0);
    expect(cut.omitted).toBe(full.shown - cut.shown);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith(`(+${cut.omitted} more entries not shown)`)).toBe(true);
    expect([...cut.handles.keys()]).toEqual(Array.from({ length: cut.shown }, (_, i) => `e${i + 1}`));
    // Every printed line but the tail is within the budget, counted line by line (Bunraku).
    const lines = cut.text.split('\n').slice(0, -1);
    expect(lines.reduce((n, l) => n + count(l), 0)).toBeLessThanOrEqual(400);
  });

  test('the first line that does not fit stops every later one (Bunraku’s latch)', () => {
    const long = 'x'.repeat(900);
    const v = viewOf([ce('item:a', 'item', 'A'), ce('item:b', 'item', 'B', { data: { tagline: long } }), ce('item:c', 'item', 'C')]);
    // min(20 000, 25 % of 1 000) = 250: B's line does not fit, C's would.
    const idx = recallIndex({ view: v, ...FULL, window: 1000 });
    expect([...idx.handles.values()]).toEqual(['item:a']);
    expect(idx.omitted).toBe(2);
    expect(idx.text).not.toContain('] C');
  });

  test('depth 2: a group below the second level is listed whole under its level-2 group', () => {
    const v = viewOf([
      ce('location:realm', 'location', 'The Realm'),
      ce('location:city', 'location', 'Harbor City', { data: { parent_location: 'The Realm' } }),
      ce('location:row', 'location', 'Lamp Row', { data: { parent_location: 'Harbor City' } }),
      ce('location:cellar', 'location', 'Lamp Row Cellars', { data: { parent_location: 'Lamp Row' } }),
      ce('location:dock', 'location', 'Dock Ward', { data: { parent_location: 'Harbor City' } }),
    ]);
    expect(recallIndex({ view: v, ...FULL }).text).toBe(
      [
        '=== World Knowledge (5 entries) ===',
        'Places (5)',
        '  The Realm (5)',
        '    [e1] The Realm',
        '    [e2] Harbor City',
        '    [e3] Lamp Row',
        '    [e4] Lamp Row Cellars',
        '    [e5] Dock Ward',
      ].join('\n'),
    );
  });

  test('session and library entries share one heading; under 5 entries the tree is one General group', () => {
    const v = viewOf([ce('character:mira', 'character', 'Mira', { aliases: ['Lamplighter', 'Мира'] }), ce('lib:salt:s1', 'organization', 'Salt Court', { library: 'salt' })]);
    expect(recallIndex({ view: v, ...FULL }).text).toBe(
      ['=== World Knowledge (2 entries) ===', 'General (2)', '  [e1] Mira (aka Lamplighter, Мира)', '  [e2] Salt Court'].join('\n'),
    );
  });

  test('an empty view (or only notes and arcs) gives an empty index: no call', () => {
    for (const v of [viewOf([]), viewOf([ce('note:x', null, 'X'), ce('arc:plot', null, 'Plot', { arc: 'Plot' })])]) {
      const idx = recallIndex({ view: v, ...FULL });
      expect(idx).toMatchObject({ text: '', shown: 0, candidates: 0, omitted: 0, truncated: false });
    }
  });
});

describe('what the index leaves out (D-197; Bunraku’s live-window test on fresh.ts)', () => {
  const path = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4'];
  // The last request cut positions 1..4 (u1…a2): those are out of the narrator's sight.
  const vis = visOf(path, [1, 4]);
  const entries = [
    ce('summary:recent', 'summary', 'Recent Recap', { range: ['u2', 'a3'] }),
    ce('summary:old', 'summary', 'Old Recap', { range: ['u1', 'a2'] }),
    ce('event:fresh', 'event', 'Fresh Event', { created: 'a3' }),
    ce('event:old', 'event', 'Old Event', { created: 'a1' }),
    ce('plot:live', 'plot', 'Live Plot', { created: 'u3' }),
    ce('character:plain', 'character', 'Plain'),
    ce('character:gone', 'character', 'Gone', { retired: true }),
    ce('note:n', null, 'A Note'),
    ce('arc:old-debts', null, 'Old Debts', { arc: 'Old Debts' }),
    ce('character:slot', 'character', 'In The Slot'),
  ];

  test('hidden by freshness, retired, in the {{recap}} slot, notes and arcs are never offered', () => {
    const idx = recallIndex({ view: viewOf(entries), vis, slotIds: ['character:slot'], ...FULL });
    expect([...idx.handles.values()].sort()).toEqual(['character:plain', 'event:old', 'summary:old']);
    expect(idx.candidates).toBe(3);
  });

  test('without a window nothing is hidden by freshness', () => {
    const idx = recallIndex({ view: viewOf(entries), ...FULL });
    expect(idx.shown).toBe(7);
  });

  test('a list element still in sight is dropped, the entry stays (the line does not change)', () => {
    const e = ce('character:mira', 'character', 'Mira', { data: { description: 'Keeper.', memories: [{ what_happened: 'old' }, { what_happened: 'new' }] }, appended: { memories: ['a1', 'a3'] } });
    const idx = recallIndex({ view: viewOf([e]), vis, ...FULL });
    expect(idx.text).toContain('[e1] Mira - Keeper.');
  });

  test('names map an exact normalized name or alias to its key; a shared one maps to null', () => {
    const v = viewOf([ce('character:a', 'character', 'Mira Vance', { aliases: ['The Lamplighter'] }), ce('character:b', 'character', 'Dov', { aliases: ['the lamplighter'] })]);
    const idx = recallIndex({ view: v, ...FULL });
    expect(idx.names.get('mira vance')).toBe('character:a');
    expect(idx.names.get('dov')).toBe('character:b');
    expect(idx.names.get('the lamplighter')).toBeNull();
  });
});

describe('the lite shortlist (D-197)', () => {
  const view = harborView();
  const LITE = { profile: 'lite' as const, window: 16_384, count };

  test('entries named in U or the window first, then by lexScore against the last messages, then the rest; at most 40, no headings', () => {
    const idx = recallIndex({
      view,
      ...LITE,
      uText: 'Is Mira Vance here?',
      windowTexts: ['Dov Ketter waits at the Dock Ward.'],
      lastTexts: ['Dov Ketter waits at the Dock Ward.', 'Smoke over the Salt Flats.', 'Is Mira Vance here?'],
    });
    expect(idx.candidates).toBe(SHORTLIST);
    expect(idx.shown).toBe(SHORTLIST);
    const lines = idx.text.split('\n');
    expect(lines).toHaveLength(SHORTLIST);
    expect(lines.every((l) => /^\[e\d+\] /.test(l))).toBe(true);
    // Tier 0 (U), then tier 2 (the window, newer message first), then lexScore (Salt Flats: two words).
    expect(lines.slice(0, 4)).toEqual(['[e1] Mira Vance (aka The Lamplighter) - Keeps the last lantern lit.', '[e2] Dov Ketter - Quartermaster.', '[e3] Dock Ward', '[e4] Salt Flats']);
    expect(idx.handles.get('e1')).toBe('lib:harbor:c-mira');
  });

  test('a prefetch (no U) still ranks by the window and the last messages', () => {
    const idx = recallIndex({ view, ...LITE, uText: '', windowTexts: ['The Salt War is over.'], lastTexts: ['The Salt War is over.'] });
    expect(idx.text.split('\n')[0]).toBe('[e1] The Salt War');
  });

  test('the lite budget is min(2 000, 15 % of the window): lines stop and the rest is counted', () => {
    // 15 % of 1 000 = 150 tokens.
    const idx = recallIndex({ view, ...LITE, window: 1000, lastTexts: ['Mira'] });
    expect(idx.shown).toBeLessThan(SHORTLIST);
    expect(idx.omitted).toBe(SHORTLIST - idx.shown);
    expect(idx.text.endsWith(`(+${idx.omitted} more entries not shown)`)).toBe(true);
  });

  test('a small Compendium is listed whole, newest change first when nothing matches', () => {
    const v = viewOf([ce('item:a', 'item', 'Anchor', { lastSeq: 1 }), ce('item:b', 'item', 'Bell', { lastSeq: 3 }), ce('item:c', 'item', 'Compass', { lastSeq: 2 })]);
    expect(recallIndex({ view: v, ...LITE }).text).toBe('[e1] Bell\n[e2] Compass\n[e3] Anchor');
  });
});
