// Ported from Bunraku:src/core/compendium/historian.test.ts@702d8120 ("the answer": a recap without a plot,
// arcs that need a plot and an overview, only recaps and plots) and the reading cases of
// Bunraku:src/core/compendium/filing.test.ts@702d8120 (unreadable vs empty, the item cap).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The historian's answer read leniently (D-176 → D-175, D-82). Changed from Bunraku: the reader gets the
// decoded JSON (structuredCall found it; prose never reaches it), more envelopes and item forms are read,
// a field of the wrong kind is skipped and its item kept, and every dropped item or arc is named in
// `skipped` (Bunraku dropped bad arcs silently).
import { describe, expect, test } from 'bun:test';
import { readHistorianAnswer, type HistorianAnswer } from '../../src/agents/compendium/historian.ts';

const read = (raw: unknown, profile: 'full' | 'lite' = 'full'): HistorianAnswer => {
  const r = readHistorianAnswer(raw, profile);
  if (!r.ok) throw new Error(r.message);
  expect(r.skipped).toBe(r.value.skipped);
  return r.value;
};
const entry = (title: string, parent_plot?: string) => ({ type: 'summary', entry: { title, summary: 's', ...(parent_plot ? { parent_plot } : {}) } });
const titles = (a: HistorianAnswer): unknown[] => a.summaries.map((s) => s.data.title);

describe('the answer (Bunraku historian.test.ts)', () => {
  test('a recap with no plot is skipped alone; arcs need a plot and an overview', () => {
    const a = read({ filings: [entry('A'), entry('B', 'P')], arcs: [{ plot: 'P', overview: 'o' }, { plot: 'P' }, { overview: 'x' }, 'no'] });
    expect(titles(a)).toEqual(['B']);
    expect(a.arcs.map(({ plot, overview }) => ({ plot, overview }))).toEqual([{ plot: 'P', overview: 'o' }]);
    expect(a.skipped).toEqual([
      { path: 'filings[0]', why: 'every summary must belong to a plot (parent_plot)' },
      { path: 'arcs[1]', why: 'an arc needs a plot and an overview' },
      { path: 'arcs[2]', why: 'an arc needs a plot and an overview' },
      { path: 'arcs[3]', why: 'an arc needs a plot and an overview' },
    ]);
  });

  test('only summaries and plots are taken; anything else is skipped; a non-object answer is invalid', () => {
    const a = read({ filings: [{ type: 'character', entry: { name: 'X' } }, { type: 'dragon', entry: { name: 'Y' } }] });
    expect(a.skipped).toEqual([
      { path: 'filings[0]', why: 'the historian writes only summaries and plots' },
      { path: 'filings[1]', why: 'its type "dragon" is not summary or plot' },
    ]);
    expect(readHistorianAnswer('I summarized it.')).toEqual({ ok: false, code: 'invalid', message: 'the answer is not a JSON object' });
  });
});

describe('unreadable vs nothing to file (Bunraku filing.test.ts)', () => {
  test('no list and no arcs is invalid (the corrective pass); empty lists and {} are a valid "nothing"', () => {
    for (const raw of [{ filings: 3 }, { note: 'done' }]) expect(readHistorianAnswer(raw).ok).toBe(false);
    // {} (no envelope, no item) is nothing to summarise: the lead's ruling G (Bunraku: unreadable).
    for (const raw of [{}, { filings: [] }, [], { arcs: [] }, { filings: [], arcs: [] }]) {
      expect(read(raw)).toEqual({ summaries: [], plots: [], arcs: [], skipped: [], offered: 0 });
    }
  });

  test('items past the cap (12, lite 6) are skipped as over_limit, counted across the answer', () => {
    const many = Array.from({ length: 14 }, (_, i) => entry(`S${i}`, 'P'));
    const full = read({ filings: many });
    expect(full.summaries).toHaveLength(12);
    expect(full.skipped).toEqual([
      { path: 'filings[12]', why: 'over_limit' },
      { path: 'filings[13]', why: 'over_limit' },
    ]);
    const lite = read({ filings: many.slice(0, 4), plots: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }, 'lite');
    expect([lite.summaries.length, lite.plots.length]).toEqual([4, 2]);
    expect(lite.skipped).toEqual([{ path: 'plots[2]', why: 'over_limit' }]);
    const arcs = read({ arcs: Array.from({ length: 8 }, (_, i) => ({ plot: `P${i}`, overview: 'o' })) }, 'lite');
    expect(arcs.arcs).toHaveLength(6);
    expect(arcs.skipped.map((s) => s.path)).toEqual(['arcs[6]', 'arcs[7]']);
  });

  test('an entry too long or too deep is skipped (6 000 / lite 3 000 JSON chars, depth 6)', () => {
    const long = { type: 'summary', entry: { title: 'T', parent_plot: 'P', summary: 'x'.repeat(4_000) } };
    expect(read({ filings: [long] }).summaries).toHaveLength(1);
    expect(read({ filings: [long] }, 'lite').skipped).toEqual([{ path: 'filings[0]', why: 'its entry is longer than 3000 characters' }]);
    const deep = { type: 'plot', entry: { name: 'P', x: { a: { b: { c: { d: { e: { f: 1 } } } } } } } };
    expect(read({ filings: [deep] }).skipped).toEqual([{ path: 'filings[0]', why: 'its entry is nested deeper than 6 levels' }]);
  });
});

describe('envelopes and item forms (D-175)', () => {
  const s = { title: 'The Howl', summary: 'A howl.', parent_plot: 'The Lantern' };

  test('a top-level list, `entries`, `items`, typed lists, a lone item', () => {
    expect(titles(read([{ type: 'summary', entry: s }]))).toEqual(['The Howl']);
    expect(titles(read({ entries: [{ type: 'summary', entry: s }] }))).toEqual(['The Howl']);
    expect(titles(read({ items: [{ type: 'summary', entry: s }] }))).toEqual(['The Howl']);
    expect(titles(read({ summaries: [s], recaps: [{ ...s, title: 'Two' }] }))).toEqual(['The Howl', 'Two']);
    expect(read({ plots: [{ name: 'Lantern' }], storylines: { name: 'Fog' } }).plots.map((p) => p.data.name)).toEqual(['Lantern', 'Fog']);
    expect(titles(read({ type: 'summary', entry: s }))).toEqual(['The Howl']);
  });

  test('{type, data}, flat fields, {summary: {…}}, a type-less summary, type words in any case and Russian', () => {
    const a = read({
      filings: [
        { type: 'Summary', data: s },
        { type: 'recap', ...s, title: 'Flat' },
        { summary: { ...s, title: 'Keyed' } },
        { ...s, title: 'Bare' },
        { type: 'Сюжет', entry: { name: 'Туман' } },
        { type: 'story line', entry: { name: 'Fog' } },
        { name: 'No type' },
      ],
    });
    expect(titles(a)).toEqual(['The Howl', 'Flat', 'Keyed', 'Bare']);
    expect(a.summaries.map((x) => x.at)).toEqual(['filings[0]', 'filings[1]', 'filings[2]', 'filings[3]']);
    expect(a.plots.map((p) => p.data.name)).toEqual(['Туман', 'Fog']);
    expect(a.skipped).toEqual([{ path: 'filings[6]', why: 'it has no type' }]);
  });

  test('an entry that is not an object, and a list item that is not one, are skipped alone', () => {
    const a = read({ filings: [{ type: 'summary', entry: 'text' }, 7, { type: 'summary', entry: s }] });
    expect(titles(a)).toEqual(['The Howl']);
    expect(a.skipped).toEqual([
      { path: 'filings[0]', why: 'it has no entry object' },
      { path: 'filings[1]', why: 'not an object' },
    ]);
  });
});

describe('fields (D-82, D-175)', () => {
  test('camelCase names, enum words, lists from one value; a wrong field is skipped and the item kept', () => {
    const a = read({
      filings: [
        {
          type: 'summary',
          entry: {
            title: ' The Howl ',
            summary: 'A howl.',
            parentPlot: 'The Lantern',
            keyMoments: ['door', null, 'howl'],
            significance: 'Major',
            mood: 'very bad',
            participants: 'Mira',
            pov_character: 42,
            mood_color: 'grey',
          },
        },
      ],
    });
    expect(a.summaries[0]!.data).toEqual({
      title: 'The Howl',
      summary: 'A howl.',
      parent_plot: 'The Lantern',
      key_moments: ['door', 'howl'],
      significance: 'major',
      participants: ['Mira'],
      pov_character: '42',
      mood_color: 'grey',
    });
    expect(a.skipped).toEqual([{ path: 'filings[0].entry.mood', why: 'must be one of light, comedic, tense, tragic, triumphant, melancholy, horrific, hopeful' }]);
  });

  test('significance `critical` (RoleCall\'s word) reads as `pivotal`; another unknown word is still skipped', () => {
    const a = read({ summaries: [{ title: 'A', summary: 'S', parent_plot: 'P', significance: 'Critical' }, { title: 'B', summary: 'S', parent_plot: 'P', significance: 'huge' }] });
    expect(a.summaries.map((s) => s.data.significance)).toEqual(['pivotal', undefined]);
    expect(a.skipped).toEqual([{ path: 'summaries[1].significance', why: 'must be one of minor, moderate, major, pivotal' }]);
  });

  test('service fields the model sends are stripped (turn_range, messages_covered, …)', () => {
    const a = read({
      summaries: [{ title: 'T', summary: 'S', parent_plot: 'P', turn_range: { from: 1, to: 4 }, messagesCovered: 3, writer_source: 'x', source_turn: 2, source_job_id: 'j' }],
    });
    expect(a.summaries[0]!.data).toEqual({ title: 'T', summary: 'S', parent_plot: 'P' });
  });

  test('plot status words are folded; a plot named by `title` is read; a plot with no name is skipped', () => {
    const a = read({ plots: [{ title: 'Fog', status: 'Not Started' }, { name: 'Ash', status: 'over' }, { description: 'no name' }] });
    expect(a.plots.map((p) => p.data)).toEqual([{ name: 'Fog', status: 'not_started' }, { name: 'Ash' }]);
    expect(a.skipped).toEqual([
      { path: 'plots[1].status', why: 'must be one of not_started, active, stalled, escalating, resolved, failed, abandoned' },
      { path: 'plots[2]', why: 'it has no name' },
    ]);
  });

  test('a summary needs a title (its `name` will do) and a summary text', () => {
    const a = read({ summaries: [{ name: 'Named', summary: 'S', parent_plot: 'P' }, { title: 'No text', parent_plot: 'P' }, { summary: 'S', parent_plot: 'P', title: '  ' }] });
    expect(a.summaries.map((s) => s.data)).toEqual([{ title: 'Named', summary: 'S', parent_plot: 'P' }]);
    expect(a.skipped).toEqual([
      { path: 'summaries[1]', why: 'it has no summary' },
      { path: 'summaries[2]', why: 'it has no title' },
    ]);
  });

  test('create_plot names the plot when parent_plot is blank (RoleCall), and becomes a plot of its own; else it is dropped', () => {
    const a = read({
      filings: [
        { type: 'summary', entry: { title: 'A', summary: 'S', create_plot: { name: 'New Thread', description: 'D', status: 'Escalating' } } },
        { type: 'summary', entry: { title: 'B', summary: 'S', parent_plot: 'new plot', create_plot: { name: 'x' } } },
      ],
    });
    expect(a.summaries.map((s) => s.data)).toEqual([
      { title: 'A', summary: 'S', parent_plot: 'New Thread' },
      { title: 'B', summary: 'S', parent_plot: 'new plot' },
    ]);
    expect(a.plots).toEqual([{ at: 'filings[0].entry.create_plot', data: { name: 'New Thread', description: 'D', status: 'escalating' } }]);
  });
});

describe('arcs', () => {
  test('a list, one object, or a map plot → overview; other names for the fields', () => {
    expect(read({ arcs: { plot: 'P', overview: 'o' } }).arcs).toEqual([{ at: 'arcs[0]', plot: 'P', overview: 'o' }]);
    expect(read({ arcs: { Fog: 'Grey.', Ash: 'Black.' } }).arcs.map((a) => [a.plot, a.overview])).toEqual([
      ['Fog', 'Grey.'],
      ['Ash', 'Black.'],
    ]);
    expect(read({ overviews: [{ name: ' Fog ', text: ' Grey. ' }] }).arcs).toEqual([{ at: 'overviews[0]', plot: 'Fog', overview: 'Grey.' }]);
  });
});
