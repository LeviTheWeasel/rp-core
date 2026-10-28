// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The {{recap}} slot after the M5b final check (.notes/m5b-decisions.md, the lead's ruling K): assemble
// gives both slot choices the slot's whole share, so at one boundary the arcs are cut alike as the chat
// grows (historian#9, agents-cli assemble.ts:867); section G's second choice keeps the view's effects
// (historian#6, recap.ts:110); trace.recap records the profile and the share and a pin holds only under
// both (historian#8, recap.ts:39); a pinned revision renders only while the row with that seq holds an
// applied arc-text op of the arc (recap.ts:185).
import { describe, expect, test } from 'bun:test';
import { arcRevisionText, recapSlot, type RecapTrace } from '../../src/agents/compendium/recap.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { chooseRecap, readRecapTrace, recapTraceOf } from '../../src/prompt/assemble/recap.ts';
import { fold, histRow, seed, userRow, viewOf, words } from '../historian-m5b/kit.ts';
import { arc, asmIn, chatView, libArc, longChat, ok, prev, recapIn, recapText, summary } from './kit.ts';

const LINE = 'The lamp went out over the harbour and the keeper vanished; a door below the tower opened onto a cellar full of salt. ';

/** Two requests at one boundary: the chat grew by an exchange, the cut did not move. */
function twoRequests(overview: string): { r1: ReturnType<typeof ok>; r2: ReturnType<typeof ok> } {
  const entries = [summary('Fog', 'The Lantern', ['u1', 'a4']), arc('The Lantern', overview, 30)];
  const r1 = ok(assemble(asmIn(chatView(longChat(18), entries), { recap: recapIn() })));
  const r2 = ok(assemble(asmIn(chatView(longChat(19), entries), { recap: recapIn({ previous: prev(r1.trace.recap) }) })));
  return { r1, r2 };
}

describe('assemble gives both slot choices the share (historian#9, assemble.ts:867)', () => {
  test('an overview over the arcs’ half: cut alike in both requests at one boundary, never dropped by the second', () => {
    const { r1, r2 } = twoRequests(LINE.repeat(3).trim());
    expect(r1.trace.recap.boundary).toBe('u5');
    expect(r2.trace.recap.boundary).toBe('u5');
    expect(r1.trace.recap.arcs).toEqual([{ key: 'arc:the lantern', rev: 30 }]);
    expect(r2.trace.recap.arcs).toEqual(r1.trace.recap.arcs);
    expect(recapText(r1)).toContain('…');
    expect(recapText(r2)).toBe(recapText(r1)!);
  });

  test('an overview just over the half: the second request does not send it whole', () => {
    const { r1, r2 } = twoRequests(LINE.repeat(2).trim());
    expect(recapText(r1)).toContain('opened onto a…');
    expect(recapText(r2)).toBe(recapText(r1)!);
  });
});

describe('section G’s second choice keeps the effects (historian#6, recap.ts:110)', () => {
  const path = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4'];
  const rows = [
    histRow(10, 'u1', 'a1', [
      { op: 'file', type: 'summary', data: { title: 'Fog', parent_plot: 'Lantern', summary: 'Fog fell.' } },
      { op: 'arc', plot: 'Lantern', overview: 'OLD overview.' },
    ]),
    // A featured edit: no text, so no new revision.
    userRow(20, [{ op: 'edit', ref: 'arc:lantern', featured: true }]),
  ];
  const later = [
    ...rows,
    histRow(30, 'u2', 'a2', [
      { op: 'file', type: 'summary', data: { title: 'Door', parent_plot: 'Lantern', summary: 'A door.' } },
      { op: 'arc', plot: 'Lantern', overview: 'NEW overview.' },
    ]),
  ];
  const base = { path, trimmed: { from: 'u1', to: 'a1' }, boundary: 'u2', budgetTok: 500, profile: 'full' as const, count: words };
  const lib = seed([libArc('book', 'e1', 'Lantern', 'The book’s overview of the lantern.')]);

  test('with a library arc of the plot the revision is the arc op’s, and the pin holds at the same boundary', () => {
    const s1 = chooseRecap({ ...base, view: fold(rows, path, new Map(), lib), previous: null, revisionText: (k, r) => arcRevisionText(rows, k, r) })!;
    expect(s1.keys).not.toContain('lib:book:e1');
    expect(s1.arcs).toEqual([{ key: 'arc:lantern', rev: 10 }]);
    const s2 = chooseRecap({ ...base, view: fold(later, path, new Map(), lib), previous: recapTraceOf(s1), revisionText: (k, r) => arcRevisionText(later, k, r) })!;
    expect(s2.arcs).toEqual([{ key: 'arc:lantern', rev: 10 }]);
    expect(s2.text.split('\n')[1]).toBe('OLD overview.');
  });
});

describe('trace.recap records the profile and the share; a pin holds only under both (historian#8, recap.ts:39)', () => {
  const books = ['a1', 'a2', 'a3'].map((id, i) => libArc('book', id, `Plot ${id}`, `${id} `.repeat(300).trim(), 300 - i));
  const view = chatView(longChat(2), books);
  const big = { window: 40_000, reserve: 8192 };
  /** What the next request reads back from the journal. */
  const stored = (t: RecapTrace): RecapTrace | null => readRecapTrace(JSON.parse(JSON.stringify(t)));

  test('the trace holds both, and a JSON round trip reads them back', () => {
    const r = ok(assemble(asmIn(view, { ...big, recap: recapIn({ profile: 'lite' }) })));
    expect(r.trace.recap).toMatchObject({ boundary: 'g', profile: 'lite', share: 4000 });
    expect(stored(r.trace.recap)).toEqual(r.trace.recap);
  });

  test('a lite pin under full is chosen afresh (all three arcs, as a fresh full request)', () => {
    const lite = ok(assemble(asmIn(view, { ...big, recap: recapIn({ profile: 'lite' }) })));
    expect(lite.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1', 'lib:book:a2']);
    const full = ok(assemble(asmIn(view, { ...big, recap: recapIn({ profile: 'full', previous: stored(lite.trace.recap) }) })));
    const fresh = ok(assemble(asmIn(view, { ...big, recap: recapIn({ profile: 'full' }) })));
    expect(full.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1', 'lib:book:a2', 'lib:book:a3']);
    expect(recapText(full)).toBe(recapText(fresh)!);
  });

  test('a pin made under a 16k window is chosen afresh at 64k (the share changed)', () => {
    const wide = chatView(longChat(2), ['a1', 'a2', 'a3'].map((id, i) => libArc('book', id, `Plot ${id}`, `${id} `.repeat(500).trim(), 300 - i)));
    const small = ok(assemble(asmIn(wide, { window: 16_000, reserve: 4096, recap: recapIn() })));
    expect(small.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1', 'lib:book:a2']);
    const large = ok(assemble(asmIn(wide, { window: 64_000, reserve: 4096, recap: recapIn({ previous: stored(small.trace.recap) }) })));
    expect(large.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1', 'lib:book:a2', 'lib:book:a3']);
    expect(large.trace.recap.share).toBe(6400);
  });

  test('the same profile and share: the pin holds (nothing added at the same boundary)', () => {
    const wide = chatView(longChat(2), ['a1', 'a2', 'a3'].map((id, i) => libArc('book', id, `Plot ${id}`, `${id} `.repeat(500).trim(), 300 - i)));
    const one = ok(assemble(asmIn(wide, { window: 16_000, reserve: 4096, recap: recapIn() })));
    const more = viewOf([...wide.compendium.entries.values(), libArc('book', 'a0', 'Plot a0', 'a0 overview', 400)]);
    const two = ok(assemble(asmIn({ ...wide, compendium: more }, { window: 16_000, reserve: 4096, recap: recapIn({ previous: stored(one.trace.recap) }) })));
    expect(two.trace.recap.arcs).toEqual(one.trace.recap.arcs);
    expect(recapText(two)).toBe(recapText(one)!);
  });

  test('an older trace without them still pins; one with an unreadable profile or share is unreadable', () => {
    const t = { ids: [], arcs: [{ key: 'lib:book:a1', rev: 0 }], boundary: 'g' };
    expect(readRecapTrace(t)).toEqual(t);
    expect(readRecapTrace({ ...t, profile: 'medium' })).toBeNull();
    expect(readRecapTrace({ ...t, share: '4000' })).toBeNull();
    expect(readRecapTrace({ ...t, share: null })).toBeNull();
  });

  test('an empty slot records neither (it never pins)', () => {
    const r = ok(assemble(asmIn(chatView(longChat(2), []), { recap: recapIn() })));
    expect(r.trace.recap).toEqual({ ids: [], arcs: [], boundary: null });
  });
});

describe('a pinned revision is the arc-text op of that arc in the row with that seq (recap.ts:185)', () => {
  const PATH = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5'];
  const pass = (seq: number, from: string, to: string, title: string, plot: string, overview: string) =>
    histRow(seq, from, to, [
      { op: 'file', type: 'summary', data: { title, parent_plot: plot, summary: `${title} happened.` } },
      { op: 'arc', plot, overview },
    ]);
  // The person renames the plot after the first pass; later passes name it as it is called now, and the
  // fold applies their arc ops to the same arc (arc:lantern), renamed (ruling K, arcs follow renamed plots).
  const before = [pass(10, 'u1', 'a1', 'Fog', 'Lantern', 'V1.'), userRow(20, [{ op: 'edit', ref: 'plot:lantern', set: { name: 'The Harbour Lantern' } }]), pass(30, 'u2', 'a2', 'Door', 'The Harbour Lantern', 'V2.')];
  const after = [...before, pass(40, 'u3', 'a3', 'Bell', 'The Harbour Lantern', 'V3.')];
  const slot = (rows: typeof after, previous: RecapTrace | null) =>
    recapSlot({
      view: fold(rows, PATH),
      path: PATH,
      trimmed: { from: 'u1', to: 'a2' },
      boundary: 'u3',
      previous,
      budgetTok: 500,
      profile: 'full',
      count: words,
      revisionText: (key, rev, op) => arcRevisionText(rows, key, rev, op),
    })!;

  test('an arc op that named the renamed plot is read back as that arc’s revision: the pin holds', () => {
    const one = slot(before, null);
    expect(one.arcs).toEqual([{ key: 'arc:lantern', rev: 30 }]);
    expect(one.text).toContain('[Arc] The Harbour Lantern\nV2.');
    const two = slot(after, recapTraceOf(one));
    expect(two.arcs).toEqual([{ key: 'arc:lantern', rev: 30 }]);
    expect(two.text).toBe(one.text);
  });

  test('arcRevisionText: with the op index exactly that op; without it the plot its key names', () => {
    expect(arcRevisionText(after, 'arc:lantern', 30, 1)).toBe('V2.');
    expect(arcRevisionText(after, 'arc:lantern', 30)).toBeNull();
    expect(arcRevisionText(after, 'arc:lantern', 10)).toBe('V1.');
    // An index that is no arc-text op of that arc, or out of the row: nothing.
    expect(arcRevisionText(after, 'arc:lantern', 30, 0)).toBeNull();
    expect(arcRevisionText(after, 'arc:lantern', 30, 5)).toBeNull();
    // A library arc's key names no plot: an arc op of the row is never its text without the index.
    expect(arcRevisionText(after, 'lib:book:e1', 30)).toBeNull();
  });
});
