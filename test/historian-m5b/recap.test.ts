// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The {{recap}} slot's content (D-177, D-178): arc overviews then summaries, what touches the cut, the
// budget, lite, library arcs, and the stability rule (same boundary → same ids and arc revisions).
import { describe, expect, test } from 'bun:test';
import { arcRevisionText, recapArcText, recapSlot, recapSummaryText, type RecapInput } from '../../src/agents/compendium/recap.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import { arc, histRow, libArc, summary, typed, userRow, viewOf, words } from './kit.ts';

const PATH = Array.from({ length: 40 }, (_, i) => `m${i + 1}`);

function input(entries: CEntry[], over: Partial<RecapInput> = {}): RecapInput {
  return {
    view: viewOf(entries),
    path: PATH,
    trimmed: { from: 'm2', to: 'm10' },
    boundary: 'm11',
    previous: null,
    budgetTok: 1_000,
    profile: 'full',
    count: words,
    ...over,
  };
}

const S1 = summary('Fog night', 'The Lantern', ['m1', 'm6']);
const S2 = summary('The door', 'The Lantern', ['m7', 'm12']);
const S3 = summary('Later', 'Salt', ['m13', 'm20']);
const LANTERN = arc('The Lantern', 'A lamp went out and a door opened.', 30);
const SALT = arc('Salt', 'Salt everywhere.', 40);

describe('what the slot holds', () => {
  test('summaries touching or before the cut, oldest first, after their plots\' arcs', () => {
    const slot = recapSlot(input([S3, S2, S1, LANTERN, SALT]))!;
    expect(slot.text).toBe(
      [recapArcText('The Lantern', 'A lamp went out and a door opened.'), recapSummaryText('Fog night', 'Fog night happened.'), recapSummaryText('The door', 'The door happened.')].join('\n\n'),
    );
    expect(slot).toMatchObject({ ids: ['summary:m6.0', 'summary:m12.0'], arcs: [{ key: 'arc:the lantern', rev: 30 }], boundary: 'm11' });
    expect(slot.keys).toEqual(['arc:the lantern', 'summary:m6.0', 'summary:m12.0']);
    expect(slot.tok).toBe(words(slot.text));
  });

  test('a summary entirely before the cut counts ("touches or precedes"); one after it does not', () => {
    const head = summary('Greeting', 'The Lantern', ['m1', 'm1']);
    const slot = recapSlot(input([head, S3], { trimmed: { from: 'm3', to: 'm10' } }))!;
    expect(slot.ids).toEqual(['summary:m1.0']);
  });

  test('nothing cut and no library arc: no slot (nothing reserved)', () => {
    expect(recapSlot(input([S1, S2, LANTERN], { trimmed: null, boundary: 'm1' }))).toBeNull();
    expect(recapSlot(input([]))).toBeNull();
    expect(recapSlot(input([S1], { budgetTok: 0 }))).toBeNull();
  });

  test('library arcs are always eligible, after session arcs, higher order first (D-177)', () => {
    const lowOrder = libArc('book', 'a1', 'Old War', 'The old war.', 50);
    const highOrder = libArc('book', 'a2', 'The Crown', 'The crown.', 200);
    const slot = recapSlot(input([lowOrder, highOrder, S1, LANTERN]))!;
    expect(slot.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:book:a2', 'lib:book:a1']);
    const untrimmed = recapSlot(input([lowOrder, S1, LANTERN], { trimmed: null, boundary: 'm1' }))!;
    expect(untrimmed).toMatchObject({ ids: [], arcs: [{ key: 'lib:book:a1', rev: 0 }], text: recapArcText('Old War', 'The old war.') });
  });

  test('session arcs: newest activity first; a plot named by an alias of its entry counts', () => {
    const plot = typed('plot:salt', 'plot', { name: 'Salt', aliases: ['The Salt Road'] });
    const viaAlias = summary('Road', 'the salt road', ['m3', 'm4']);
    const slot = recapSlot(input([plot, S1, viaAlias, LANTERN, SALT]))!;
    expect(slot.arcs).toEqual([
      { key: 'arc:salt', rev: 40 },
      { key: 'arc:the lantern', rev: 30 },
    ]);
  });

  test('retired summaries, arcs and summaries without a range are left out', () => {
    const human = typed('summary:user:x', 'summary', { title: 'Hand', summary: 'By hand.', parent_plot: 'The Lantern' });
    const gone = { ...S2, retired: { reason: '' } };
    const slot = recapSlot(input([S1, gone, human, { ...LANTERN, retired: { reason: '' } }]))!;
    expect(slot).toMatchObject({ ids: ['summary:m6.0'], arcs: [] });
  });
});

describe('the budget', () => {
  const many = Array.from({ length: 6 }, (_, i) => summary(`S${i}`, 'The Lantern', [`m${i + 1}`, `m${i + 1}`], {}, `word `.repeat(20).trim()));
  const bigArc = arc('The Lantern', 'word '.repeat(60).trim(), 9);

  test('the oldest summaries drop first when they do not all fit', () => {
    // Each summary is 22 tokens ("[Summary:", "S0]", 20 words); the word counter gives a blank line 0.
    const slot = recapSlot(input(many, { budgetTok: 70 }))!;
    expect(slot.ids).toEqual(['summary:m4.0', 'summary:m5.0', 'summary:m6.0']);
    expect(slot.tok).toBeLessThanOrEqual(70);
  });

  test('arcs take at most half the slot; one over what is left is cut head-first to fit (ruling I); summaries the rest', () => {
    const small = libArc('book', 'a', 'Tiny', 'Small.', 100);
    const slot = recapSlot(input([...many, bigArc, small], { budgetTok: 100 }))!;
    // The 62-token overview is cut to the half's 50 tokens; the library arc no longer fits beside it.
    expect(slot.arcs.map((a) => a.key)).toEqual(['arc:the lantern']);
    const overview = slot.text.split('\n\n')[0]!;
    expect(overview.startsWith('[Arc] The Lantern\nword word')).toBe(true);
    expect(overview.endsWith('…')).toBe(true);
    expect(words(overview)).toBeLessThanOrEqual(50);
    expect(slot.tok).toBeLessThanOrEqual(100);
    const roomy = recapSlot(input([...many, bigArc, small], { budgetTok: 200 }))!;
    expect(roomy.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:book:a']);
    expect(roomy.tok).toBeLessThanOrEqual(200);
  });

  test('lite: at most 2 overviews, each cut to 1 200 chars with \'…\'', () => {
    const long = arc('The Lantern', 'word '.repeat(400).trim(), 9);
    const libs = [libArc('book', 'a', 'A', 'a.', 300), libArc('book', 'b', 'B', 'b.', 200)];
    const slot = recapSlot(input([S1, long, ...libs], { profile: 'lite', budgetTok: 5_000 }))!;
    expect(slot.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:book:a']);
    const overview = slot.text.split('\n\n')[0]!.split('\n')[1]!;
    expect([...overview].length).toBeLessThanOrEqual(1_200);
    expect(overview.endsWith('…')).toBe(true);
  });
});

describe('stability (D-178)', () => {
  const first = recapSlot(input([S1, S2, LANTERN]))!;
  const previous = { ids: first.ids, arcs: first.arcs, boundary: first.boundary };

  test('same boundary: the same ids and the same arc revision, even after the historian rewrote the arc and added a summary', () => {
    const rewritten = { ...LANTERN, content: 'A newer overview.', prov: { ...LANTERN.prov, lastSeq: 55 } };
    const newer = summary('Newer', 'The Lantern', ['m3', 'm5']);
    const seen: [string, number][] = [];
    const slot = recapSlot(
      input([S1, S2, newer, rewritten], {
        previous,
        revisionText: (key, rev) => {
          seen.push([key, rev]);
          return 'A lamp went out and a door opened.';
        },
      }),
    )!;
    expect(seen).toEqual([['arc:the lantern', 30]]);
    expect(slot.text).toBe(first.text);
    expect(slot).toMatchObject({ ids: first.ids, arcs: [{ key: 'arc:the lantern', rev: 30 }] });
  });

  test('same boundary: an entry no longer live drops out, nothing comes in', () => {
    const slot = recapSlot(input([{ ...S1, retired: { reason: '' } }, S2, LANTERN], { previous }))!;
    expect(slot.ids).toEqual(['summary:m12.0']);
    expect(slot.arcs).toEqual(first.arcs);
    const empty = recapSlot(input([S1, S2, LANTERN], { previous: { ids: [], arcs: [], boundary: 'm11' } }));
    expect(empty).toBeNull();
  });

  test('an old revision that cannot be read renders the current one, with its revision', () => {
    const rewritten = { ...LANTERN, content: 'Rewritten.', prov: { ...LANTERN.prov, lastSeq: 55 } };
    const slot = recapSlot(input([S1, S2, rewritten], { previous, revisionText: () => null }))!;
    expect(slot.arcs).toEqual([{ key: 'arc:the lantern', rev: 55 }]);
    expect(slot.text.startsWith(recapArcText('The Lantern', 'Rewritten.'))).toBe(true);
  });

  test('a moved boundary, a missing or pre-M5b previous, or a previous slot over the budget: chosen afresh', () => {
    const newer = summary('Newer', 'The Lantern', ['m3', 'm5']);
    expect(recapSlot(input([S1, S2, newer, LANTERN], { previous, boundary: 'm19', trimmed: { from: 'm2', to: 'm18' } }))!.ids).toEqual([
      'summary:m6.0',
      'summary:m5.0',
      'summary:m12.0',
    ]);
    expect(recapSlot(input([S1, newer, LANTERN], { previous: { ids: [], arcs: [], boundary: null }, boundary: null }))!.ids).toEqual(['summary:m6.0', 'summary:m5.0']);
    // The previous slot takes 23 tokens; at 11 only the newest summary (6) fits, the arc (11) is over half.
    const tight = recapSlot(input([S1, S2, LANTERN], { previous, budgetTok: 11 }))!;
    expect(tight.ids).toEqual(['summary:m12.0']);
    expect(tight.arcs).toEqual([]);
  });
});

describe('arcRevisionText', () => {
  const rows = [
    histRow(10, 'm1', 'm5', [
      { op: 'file', type: 'summary', data: {} },
      { op: 'arc', plot: 'The Lantern', overview: 'First.' },
    ]),
    userRow(11, [{ op: 'edit', ref: 'arc:the lantern', set: { content: 'Edited.' } }]),
    histRow(12, 'm6', 'm9', [{ op: 'arc', plot: 'the  lantern', overview: 'Second.' }]),
    userRow(13, [{ op: 'edit', ref: 'lib:book:a1', set: { overview: 'Overlay.' } }]),
    userRow(14, [{ op: 'edit', ref: 'arc:the lantern', featured: true }]),
  ];

  test('the text the row with that seq gave the arc: an arc op of its plot, or an edit of its key', () => {
    expect(arcRevisionText(rows, 'arc:the lantern', 10)).toBe('First.');
    expect(arcRevisionText(rows, 'arc:the lantern', 11)).toBe('Edited.');
    expect(arcRevisionText(rows, 'arc:the lantern', 12)).toBe('Second.');
    expect(arcRevisionText(rows, 'arc:the lantern#2', 12)).toBe('Second.');
    expect(arcRevisionText(rows, 'lib:book:a1', 13)).toBe('Overlay.');
  });

  test('null when that row says nothing about the text, or there is no such row', () => {
    expect(arcRevisionText(rows, 'arc:the lantern', 14)).toBeNull();
    expect(arcRevisionText(rows, 'arc:salt', 10)).toBeNull();
    expect(arcRevisionText(rows, 'arc:the lantern', 99)).toBeNull();
    expect(arcRevisionText([...rows].reverse(), 'arc:the lantern', 10)).toBe('First.');
  });
});
