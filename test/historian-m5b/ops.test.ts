// Ported from Bunraku:src/core/compendium/historian.test.ts@702d8120 ("a plot the book and the answer lack
// is made, once, before the recap") and Bunraku:src/studio/compendium-historian.test.ts@702d8120 ("what it
// writes": the made plot, the stamped range, the arc overview; a recap with no plot rejected alone; an arc
// rewritten in place and one for a plot no recap names left out; Undo and the watermark).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The historian's row (D-176): its ops, then the same ops through the fold. Changed from Bunraku: the
// writes are ops of one `mem` row whose range is the window's new part (no turn_range in the data;
// `messages_covered` stamped by code); the arc is an `arc` op for the {{recap}} slot, not a constant lore
// entry; Undo is a `revert` row and the watermark does not move back (B24); cuts and dropped arcs are
// named in `skipped`.
import { describe, expect, test } from 'bun:test';
import { historianDue, historianKey, historianOps, historianWatermark, readHistorianAnswer, type HistorianAnswer, type HistMessage } from '../../src/agents/compendium/historian.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemOp } from '../../src/session/entries.ts';
import { arc, due, fold, histRow, libArc, seed, typed, userRow, viewOf } from './kit.ts';

const answer = (raw: unknown, profile: 'full' | 'lite' = 'full'): HistorianAnswer => {
  const r = readHistorianAnswer(raw, profile);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const recap = (title: string, plot: string | null = 'The Lantern') => ({ type: 'summary', entry: { title, summary: `${title} happened.`, ...(plot ? { parent_plot: plot } : {}) } });
const said = (filings: unknown[], arcs: unknown[] = []) => answer({ filings, arcs });
const shape = (ops: MemOp[]): string[] => ops.map((o) => (o.op === 'file' ? `${o.type}:${String(o.data.name ?? o.data.title)}` : o.op === 'arc' ? `arc:${o.plot}` : o.op));
const W = { newStart: 1, end: 5 };
/** A file op's data ({} for any other op). */
const dataOf = (op: MemOp | undefined): Record<string, unknown> => (op?.op === 'file' ? op.data : {});

describe('prepareItems (Bunraku historian.test.ts)', () => {
  test('a plot the view and the answer lack is made, once, before the summaries; messages_covered is stamped; create_plot is not kept', () => {
    const a = said([
      { type: 'summary', entry: { title: 'A', summary: 's', parent_plot: 'New Plot', turn_range: { from: 0, to: 99 } } },
      { type: 'summary', entry: { title: 'B', summary: 's', parent_plot: 'new plot', create_plot: { name: 'x' } } },
    ]);
    const view = viewOf([typed('plot:old', 'plot', { name: 'Old' })]);
    // Bunraku's window {newStart 2, end 10} (end exclusive) is positions 3…10.
    const out = historianOps(a, { newStart: 3, end: 10 }, view, 'full');
    expect(shape(out.ops)).toEqual(['plot:New Plot', 'summary:A', 'summary:B']);
    expect(out.ops[0]).toEqual({ op: 'file', type: 'plot', data: { name: 'New Plot', status: 'active' } });
    expect(out.ops[1]).toEqual({ op: 'file', type: 'summary', data: { title: 'A', summary: 's', parent_plot: 'New Plot', messages_covered: 8 } });
    expect(dataOf(out.ops[2])).not.toHaveProperty('create_plot');
    expect(out.skipped).toEqual([]);
  });

  test('a plot the view has (any name it answers to, a library one too) or the answer files is not made again', () => {
    const view = viewOf([typed('plot:old debts', 'plot', { name: 'Old Debts', aliases: ['The Debt'] }), libArc('book', 'x', 'Unused', 'o'), typed('lib:book:p', 'plot', { name: 'Salt War' }, { origin: { kind: 'library', book: 'book', id: 'p', overlay: false } })]);
    const a = said([recap('A', 'the debt'), recap('B', 'Salt War'), recap('C', 'Fog'), { type: 'plot', entry: { name: 'Fog Lane', aliases: ['Fog'] } }]);
    expect(shape(historianOps(a, W, view, 'full').ops)).toEqual(['plot:Fog Lane', 'summary:A', 'summary:B', 'summary:C']);
  });
});

describe('what it writes (Bunraku compendium-historian.test.ts)', () => {
  const path = ['m1', 'm2', 'm3', 'm4', 'm5'];

  test('a recap belongs to a plot made when missing, its range is the row\'s, and the arc is the plot\'s overview', () => {
    const out = historianOps(said([recap('The Howl')], [{ plot: 'The Lantern', overview: 'A howl began the tale.' }]), W, viewOf([]), 'full');
    expect(shape(out.ops)).toEqual(['plot:The Lantern', 'summary:The Howl', 'arc:The Lantern']);
    const view = fold([histRow(10, 'm1', 'm5', out.ops)], path);
    expect(view.issues).toEqual([]);
    expect(view.entries.get('plot:the lantern')).toMatchObject({ name: 'The Lantern', data: { name: 'The Lantern', status: 'active' } });
    expect(view.entries.get('summary:m5.0')).toMatchObject({
      type: 'summary',
      range: ['m1', 'm5'],
      data: { title: 'The Howl', parent_plot: 'The Lantern', messages_covered: 5 },
    });
    expect(view.entries.get('arc:the lantern')).toMatchObject({ type: null, arc: 'The Lantern', content: 'A howl began the tale.' });
    expect(view.tasks.get('hist:m1-m5')).toMatchObject({ status: 'applied', range: ['m1', 'm5'] });
    expect(view.effects.map((e) => e.change)).toEqual(['created', 'created', 'arc']);
  });

  test('a recap with no plot is skipped alone and named, the rest are written', () => {
    const out = historianOps(said([recap('Orphan', null), recap('The Howl')]), W, viewOf([]), 'full');
    expect(shape(out.ops)).toEqual(['plot:The Lantern', 'summary:The Howl']);
    expect(out.skipped).toEqual([{ path: 'filings[0]', why: 'every summary must belong to a plot (parent_plot)' }]);
  });

  test('an arc is rewritten in place on the next run, not duplicated; an arc for a plot no recap names is left out', () => {
    const first = historianOps(said([recap('The Howl')], [{ plot: 'The Lantern', overview: 'First.' }]), W, viewOf([]), 'full');
    const rows = [histRow(10, 'm1', 'm5', first.ops)];
    const longer = [...path, 'm6', 'm7', 'm8'];
    const before = fold(rows, longer);
    const second = historianOps(
      said([recap('The Creak')], [{ plot: 'The Lantern', overview: 'Second.' }, { plot: 'Elsewhere', overview: 'Stray.' }]),
      { newStart: 6, end: 8 },
      before,
      'full',
    );
    expect(shape(second.ops)).toEqual(['summary:The Creak', 'arc:The Lantern']);
    expect(second.skipped).toEqual([{ path: 'arcs[1]', why: 'no summary of this run names the plot' }]);
    const after = fold([...rows, histRow(11, 'm6', 'm8', second.ops)], longer);
    const arcs = [...after.entries.values()].filter((e) => e.arc !== undefined);
    expect(arcs.map((e) => [e.key, e.content, e.prov.lastSeq])).toEqual([['arc:the lantern', 'Second.', 11]]);
  });

  test('Undo is a revert: the run\'s entries go, and the watermark stays (B24)', () => {
    const msgs: HistMessage[] = path.map((id, i) => ({ id, role: i % 2 === 0 ? 'assistant' : 'user', text: `Text ${id}.` }));
    const out = historianOps(said([recap('The Howl')], [{ plot: 'The Lantern', overview: 'First.' }]), W, viewOf([]), 'full');
    const rows = [histRow(10, 'm1', 'm5', out.ops), userRow(11, [{ op: 'revert', key: 'hist:m1-m5' }])];
    const view = fold(rows, path);
    expect([...view.entries.values()].filter((e) => e.retired === undefined)).toEqual([]);
    expect(view.tasks.get('hist:m1-m5')).toMatchObject({ status: 'reverted' });
    expect(historianWatermark(msgs, view.tasks)).toBe(5);
    expect(historianDue(due(msgs, { interval: 1, tasks: view.tasks }))).toBeNull();
  });
});

describe('the rest of the ops (D-176)', () => {
  test('the order is made plots, the answer\'s plots, summaries, arcs', () => {
    const a = said([recap('S1', 'Fog'), { type: 'plot', entry: { name: 'Ash', status: 'active' } }, recap('S2', 'Ash')], [{ plot: 'Ash', overview: 'o' }, { plot: 'Fog', overview: 'p' }]);
    expect(shape(historianOps(a, W, viewOf([]), 'full').ops)).toEqual(['plot:Fog', 'plot:Ash', 'summary:S1', 'summary:S2', 'arc:Ash', 'arc:Fog']);
  });

  test('a plot of the answer that would change nothing is left out; one that adds something stays', () => {
    const view = viewOf([typed('plot:ash', 'plot', { name: 'Ash', status: 'active', goal: 'Find the ash.' })]);
    const same = said([{ type: 'plot', entry: { name: 'ash', status: 'active' } }]);
    expect(historianOps(same, W, view, 'full').ops).toEqual([]);
    const more = said([{ type: 'plot', entry: { name: 'Ash', status: 'escalating' } }]);
    expect(historianOps(more, W, view, 'full').ops).toEqual([{ op: 'file', type: 'plot', data: { name: 'Ash', status: 'escalating' } }]);
  });

  test('an arc that says what the plot\'s arc already says is left out; the last arc of a plot wins', () => {
    const view = viewOf([typed('plot:ash', 'plot', { name: 'Ash' }), arc('Ash', 'Same.')]);
    expect(shape(historianOps(said([recap('S', 'Ash')], [{ plot: 'Ash', overview: 'Same.' }]), W, view, 'full').ops)).toEqual(['summary:S']);
    const twice = historianOps(said([recap('S', 'Ash')], [{ plot: 'Ash', overview: 'One.' }, { plot: 'ash', overview: 'Two.' }]), W, view, 'full');
    // The lead's ruling I: the arc is keyed by the plot's canonical name, whatever spelling the model used.
    expect(twice.ops.filter((o) => o.op === 'arc')).toEqual([{ op: 'arc', plot: 'Ash', overview: 'Two.' }]);
    expect(twice.skipped).toEqual([{ path: 'arcs[0]', why: 'a later arc of this answer rewrites the same plot' }]);
  });

  test('a summary is cut to 1 500 chars and an overview to 6 000 (lite 1 200), with \'…\', and the cut is named', () => {
    const long = 'word '.repeat(700).trim();
    const a = answer({ filings: [{ type: 'summary', entry: { title: 'S', parent_plot: 'P', summary: 'x '.repeat(1_400) } }], arcs: [{ plot: 'P', overview: long }] }, 'lite');
    const full = historianOps(a, W, viewOf([]), 'full');
    const sum = String(dataOf(full.ops.find((o) => o.op === 'file' && o.type === 'summary')).summary);
    expect([...sum].length).toBeLessThanOrEqual(1_500);
    expect(sum.endsWith('…')).toBe(true);
    expect((full.ops.find((o) => o.op === 'arc') as { overview: string }).overview).toBe(long);
    const lite = historianOps(a, W, viewOf([]), 'lite');
    const overview = (lite.ops.find((o) => o.op === 'arc') as { overview: string }).overview;
    expect([...overview].length).toBeLessThanOrEqual(1_200);
    expect(overview.endsWith('…')).toBe(true);
    expect(lite.skipped).toEqual([
      { path: 'filings[0].summary', why: 'cut to 1500 chars' },
      { path: 'arcs[0].overview', why: 'cut to 1200 chars' },
    ]);
  });

  test('a library plot\'s arc in the view does not hide a session arc op (the fold keeps them apart)', () => {
    const lib = seed([libArc('book', 'a1', 'Old War', 'From the book.')]);
    const base: CompendiumView = fold([], ['m1'], new Map(), lib);
    const out = historianOps(said([recap('S', 'Old War')], [{ plot: 'Old War', overview: 'From the book.' }]), W, base, 'full');
    expect(shape(out.ops)).toEqual(['plot:Old War', 'summary:S', 'arc:Old War']);
  });

  test('the key and the row: hist:<newFromId>-<toId>, the range without the overlap', () => {
    const msgs: HistMessage[] = ['u1', 'a1', 'u2', 'a2'].map((id) => ({ id, role: id.startsWith('u') ? 'user' : 'assistant', text: id }));
    const w = historianDue(due(msgs, { interval: 1, overlap: 2, tasks: new Map([['hist:u1-a1', { seq: 1, status: 'applied', range: ['u1', 'a1'] }]]) }))!;
    expect([historianKey(w), w.fromId, w.newFromId, w.toId]).toEqual(['hist:u2-a2', 'u1', 'u2', 'a2']);
    const out = historianOps(said([recap('S', 'P')]), w, viewOf([]), 'full');
    expect(dataOf(out.ops[1]).messages_covered).toBe(2);
  });
});
