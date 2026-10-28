// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// recap.ts after the M5b review (.notes/m5b-decisions.md, the lead's ruling I), over real folds: an arc's
// pinned revision is the seq of the last row that set its text (review historian#6), dropped when that
// row is no longer effective (undo, staleness: historian#4) or holds no op for the arc after a fork
// renumbered the rows (historian#7); a pin holds only under the same profile and within its caps
// (historian#8); an overview over the arcs' half is cut head-first to fit (historian#9).
import { describe, expect, test } from 'bun:test';
import { arcRevisionText, recapSlot, type RecapInput, type RecapSlot, type RecapTrace } from '../../src/agents/compendium/recap.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { arc, fold, histRow, summary, userRow, viewOf, words } from '../historian-m5b/kit.ts';

const PATH = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5'];

const pass = (seq: number, from: string, to: string, title: string, overview: string): MemEntry =>
  histRow(seq, from, to, [
    { op: 'file', type: 'summary', data: { title, parent_plot: 'Lantern', summary: `${title} happened.` } },
    { op: 'arc', plot: 'Lantern', overview },
  ]);

function slotOf(view: CompendiumView, rows: readonly MemEntry[], previous: RecapTrace | null, over: Partial<RecapInput> = {}): RecapSlot {
  const slot = recapSlot({
    view,
    path: PATH,
    trimmed: { from: 'u1', to: 'a2' },
    boundary: 'u3',
    previous,
    budgetTok: 500,
    profile: 'full',
    count: words,
    revisionText: (key, rev) => arcRevisionText(rows, key, rev),
    ...over,
  });
  expect(slot).not.toBeNull();
  return slot!;
}

const traceOf = (s: RecapSlot): RecapTrace => ({ ids: s.ids, arcs: s.arcs, boundary: s.boundary });
const arcLine = (s: RecapSlot): string => s.text.split('\n')[1]!;

describe('review historian#4: a pinned revision whose row is no longer effective is dropped', () => {
  const rows = [pass(10, 'u1', 'a1', 'Fog', 'V1 overview.'), pass(20, 'u2', 'a2', 'Door', 'V2 overview.')];
  const first = slotOf(fold(rows, PATH), rows, null);

  test('the first request pins the second pass’s text at its seq', () => {
    expect([arcLine(first), first.arcs]).toEqual(['V2 overview.', [{ key: 'arc:lantern', rev: 20 }]]);
  });

  test('/memory undo of that pass: the same boundary renders the fold’s text (V1, rev 10), never the undone one', () => {
    const undone = [...rows, userRow(30, [{ op: 'revert', key: 'hist:u2-a2' }])];
    const slot = slotOf(fold(undone, PATH), undone, traceOf(first));
    expect([arcLine(slot), slot.arcs]).toEqual(['V1 overview.', [{ key: 'arc:lantern', rev: 10 }]]);
    expect(slot.ids).toEqual(['summary:a1.0']);
  });

  test('an edit in the pass’s range makes it stale: the same', () => {
    const view = fold(rows, PATH, new Map([['a2', 25]]));
    const slot = slotOf(view, rows, traceOf(first));
    expect([arcLine(slot), slot.arcs]).toEqual(['V1 overview.', [{ key: 'arc:lantern', rev: 10 }]]);
  });

  test('a later rewrite that is effective: the pinned text still renders (D-178), at its revision', () => {
    const later = [...rows, pass(40, 'u3', 'a3', 'Cellar', 'V3 overview.')];
    const slot = slotOf(fold(later, PATH), later, traceOf(first));
    expect([arcLine(slot), slot.arcs]).toEqual(['V2 overview.', [{ key: 'arc:lantern', rev: 20 }]]);
  });
});

describe('review historian#6: the revision is the row that set the text, not the last row that touched the arc', () => {
  const rows = [pass(10, 'u1', 'a1', 'Fog', 'OLD overview.'), userRow(20, [{ op: 'edit', ref: 'arc:lantern', featured: true }])];

  test('a `featured` edit after the arc op: the slot records the arc op’s seq', () => {
    expect(slotOf(fold(rows, PATH), rows, null).arcs).toEqual([{ key: 'arc:lantern', rev: 10 }]);
  });

  test('then a historian rewrite at the same boundary: the old text stays', () => {
    const first = slotOf(fold(rows, PATH), rows, null);
    const later = [...rows, pass(30, 'u2', 'a2', 'Door', 'NEW overview.')];
    const slot = slotOf(fold(later, PATH), later, traceOf(first));
    expect([arcLine(slot), slot.arcs]).toEqual(['OLD overview.', [{ key: 'arc:lantern', rev: 10 }]]);
  });

  test('an edit that sets the content is a text revision', () => {
    const edited = [...rows, userRow(30, [{ op: 'edit', ref: 'arc:lantern', set: { content: 'Hand-written overview.' } }])];
    const slot = slotOf(fold(edited, PATH), edited, null);
    expect([arcLine(slot), slot.arcs]).toEqual(['Hand-written overview.', [{ key: 'arc:lantern', rev: 30 }]]);
  });
});

describe('review historian#7: after a fork renumbered the rows, a pin to a row that holds no op for the arc is dropped', () => {
  // The source pinned rev 11 (REV-B). In the fork the rows are 4 (A), 7 (B), 10 (C).
  const fork = [pass(4, 'u1', 'a1', 'One', 'REV-A of the overview.'), pass(7, 'u2', 'a2', 'Two', 'REV-B of the overview.'), pass(10, 'u3', 'a3', 'Three', 'REV-C of the overview.')];
  const pinned: RecapTrace = { ids: ['summary:a1.0', 'summary:a2.0'], arcs: [{ key: 'arc:lantern', rev: 11 }], boundary: 'u3' };

  test('no row with that seq: the current text and revision', () => {
    const slot = slotOf(fold(fork, PATH), fork, pinned);
    expect([arcLine(slot), slot.arcs]).toEqual(['REV-C of the overview.', [{ key: 'arc:lantern', rev: 10 }]]);
  });

  test('a row with that seq that is not effective on this path (undone) holds no applied op: dropped, though its text is in the journal', () => {
    const rows = [...fork, pass(11, 'u4', 'a4', 'Four', 'REV-D, undone.'), userRow(12, [{ op: 'revert', key: 'hist:u4-a4' }])];
    const slot = slotOf(fold(rows, PATH), rows, pinned);
    expect([arcLine(slot), slot.arcs]).toEqual(['REV-C of the overview.', [{ key: 'arc:lantern', rev: 10 }]]);
  });
});

describe('review historian#8: a pin holds only under its profile and within its caps', () => {
  const plots = ['Ash', 'Bell', 'Coin', 'Dune'];
  const entries = [
    ...plots.map((p, i) => summary(`${p} night`, p, ['u1', `a${i + 1}`], { key: `summary:${p}` })),
    ...plots.map((p, i) => arc(p, `${p} overview.`, 10 + i)),
  ];
  const view = viewOf(entries);
  const base = { view, path: PATH, trimmed: { from: 'u1', to: 'a4' }, boundary: 'u5', budgetTok: 1_000, count: words };

  test('a full-profile pin of four arcs, read under lite: chosen afresh, two arcs', () => {
    const full = recapSlot({ ...base, previous: null, profile: 'full' })!;
    expect(full.arcs).toHaveLength(4);
    const lite = recapSlot({ ...base, previous: traceOf(full), profile: 'lite' })!;
    expect(lite.arcs).toHaveLength(2);
  });

  test('a trace that records its profile: another profile chooses afresh, the same one pins', () => {
    const lite = recapSlot({ ...base, previous: null, profile: 'lite' })!;
    expect(lite.profile).toBe('lite');
    const pinnedLite: RecapTrace = { ...traceOf(lite), profile: 'lite', ids: [lite.ids[0]!] };
    expect(recapSlot({ ...base, previous: pinnedLite, profile: 'lite' })!.ids).toEqual([lite.ids[0]!]);
    const asFull = recapSlot({ ...base, previous: { ...pinnedLite, profile: 'full' }, profile: 'lite' })!;
    expect(asFull.ids).toEqual(lite.ids);
  });
});

describe('review historian#9: an overview over the arcs’ half is cut head-first to fit', () => {
  const long = `FIRST ${'event '.repeat(1_300)}LAST`;
  const view = viewOf([summary('Fog night', 'Lantern', ['u1', 'a1']), arc('Lantern', long, 10)]);
  const base = { view, path: PATH, trimmed: { from: 'u1', to: 'a2' }, boundary: 'u3', previous: null, profile: 'full' as const, count: words };

  test('a full-profile overview larger than half the slot is cut, not left out', () => {
    const slot = recapSlot({ ...base, budgetTok: 1_000 })!;
    expect(slot.arcs).toEqual([{ key: 'arc:lantern', rev: 10 }]);
    const [arcText] = slot.text.split('\n\n');
    expect(arcText!.startsWith('[Arc] Lantern\nFIRST event')).toBe(true);
    expect(arcText!.endsWith('…')).toBe(true);
    expect(arcText).not.toContain('LAST');
    expect(words(arcText!)).toBeLessThanOrEqual(500);
    expect(slot.ids).toEqual(['summary:a1.0']);
  });

  test('with the slot’s share, a tighter budget cuts it the same, and the pinned slot renders the same text', () => {
    const first = recapSlot({ ...base, budgetTok: 1_000, shareTok: 1_000 })!;
    const tight = recapSlot({ ...base, budgetTok: first.tok + 3, shareTok: 1_000 })!;
    expect(tight.text).toBe(first.text);
    const again = recapSlot({ ...base, budgetTok: 1_000, shareTok: 1_000, previous: traceOf(first) })!;
    expect(again.text).toBe(first.text);
    expect(again.arcs).toEqual(first.arcs);
  });

  test('too little room for even a short cut: the arc is left out', () => {
    expect(recapSlot({ ...base, budgetTok: 20 })!.arcs).toEqual([]);
  });
});
