// Ported from RoleCall:apps/rc/src/lib/ai/tv-stream/__tests__/compendium-freshness.test.ts@fb8dc623e (its
// cases, on path positions and provenance) and RoleCall:apps/rc/src/lib/scene/__tests__/branch-trim-freshness.test.ts@fb8dc623e
// (its "fails closed on malformed trim state" idea).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Freshness (D-80, D-152): the visible window from the last reply's trim, and what the narrator may see
// of an entry. Vectors C1–C6 of the M5a RoleCall study (§4.4) come first, then RoleCall's own tests.
import { describe, expect, test } from 'bun:test';
import { isVisible, visibilityAt, visibleCopy, type Visibility } from '../../src/agents/compendium/fresh.ts';
import { renderContent } from '../../src/agents/compendium/render.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import { alternating, arcEntry, chat, cut, lib, noteEntry, typed, uncut } from './kit.ts';

// m0 greeting, m1 u, m2 a, …, m8 a, U = m9; m8's request cut m0…m4, so m5 is the first visible message.
// (A real request keeps a protected head: see the greeting test below, cut m1…m4.)
const trimmed = chat(alternating(10, (i) => (i === 8 ? { trace: cut('m0', 'm4') } : {})));
const VIS = visibilityAt(trimmed.view, trimmed.tree, 'm9');
// The same chat with nothing cut: everything is visible.
const whole = chat(alternating(10, (i) => (i === 8 ? { trace: uncut } : {})));
const ALL = visibilityAt(whole.view, whole.tree, 'm9');

const summary = (key: string, from: string, to: string): CEntry =>
  typed(key, 'summary', { title: key, summary: `What happened in ${key}.` }, { range: [from, to], prov: { created: to, lastSeq: 5, appended: {}, createdSeq: 5 } });
const created = (key: string, type: 'plot' | 'event', on: string | null): CEntry =>
  typed(key, type, { name: key, description: `About ${key}.` }, { prov: { created: on, lastSeq: 5, appended: {}, createdSeq: 5 } });
const shown = (e: CEntry, v: Visibility = VIS): boolean => visibleCopy(e, v).entry !== null;

describe('the visible window', () => {
  test("the nearest reply's cut is the hidden run; positions cover the whole path", () => {
    expect(VIS.cut).toEqual([0, 4]);
    expect(VIS.pos.get('m0')).toBe(0);
    expect(VIS.pos.get('m9')).toBe(9);
    expect(['m4', 'm5', 'm9'].map((id) => isVisible(VIS, id))).toEqual([false, true, true]);
    expect(isVisible(VIS, null)).toBe(false);
    expect(isVisible(VIS, 'elsewhere')).toBe(false);
    expect(ALL.cut).toBeNull();
  });

  test('only the nearest reply counts: an older cut does not, and a reply without a cut shows everything', () => {
    const c = chat(alternating(10, (i) => (i === 6 ? { trace: cut('m0', 'm4') } : i === 8 ? { trace: uncut } : {})));
    expect(visibilityAt(c.view, c.tree, 'm9').cut).toBeNull();
    // Asked at m7 the nearest reply is m6.
    expect(visibilityAt(c.view, c.tree, 'm7').cut).toEqual([0, 4]);
  });

  test("a continue's trace wins over the message's own: its request was the last one", () => {
    const c = chat(alternating(10, (i) => (i === 8 ? { trace: uncut, cont: cut('m0', 'm2') } : {})));
    expect(visibilityAt(c.view, c.tree, 'm9').cut).toEqual([0, 2]);
    const two = chat(alternating(10, (i) => (i === 8 ? { trace: cut('m0', 'm6'), cont: uncut } : {})));
    expect(visibilityAt(two.view, two.tree, 'm9').cut).toBeNull();
  });

  test('no reply before U, a greeting without a trace, or U off the path: everything is visible', () => {
    const one = chat([{ role: 'user', text: 'hi' }]);
    expect(visibilityAt(one.view, one.tree, 'm0').cut).toBeNull();
    const greeted = chat(alternating(2));
    expect(visibilityAt(greeted.view, greeted.tree, 'm1').cut).toBeNull();
    expect(visibilityAt(trimmed.view, trimmed.tree, 'not-there').cut).toBeNull();
  });

  test('an opening (upTo null): the newest assistant message on the path, by its last continue, was the last request', () => {
    // A greeting alone, never continued: nothing cut.
    const greeting = chat(alternating(1));
    expect(visibilityAt(greeting.view, greeting.tree, null)).toEqual({ cut: null, pos: new Map([['m0', 0]]) });
    // A path ending at an assistant message: its own continue trace is read (asked at that message, it is not).
    const c = chat(alternating(5, (i) => (i === 4 ? { trace: uncut, cont: cut('m0', 'm2') } : {})));
    expect(visibilityAt(c.view, c.tree, null).cut).toEqual([0, 2]);
    expect(visibilityAt(c.view, c.tree, 'm4').cut).toBeNull();
  });

  test('a hidden reply still says what its request sent', () => {
    const c = chat(alternating(10, (i) => (i === 8 ? { trace: cut('m0', 'm4'), hidden: true } : {})));
    expect(visibilityAt(c.view, c.tree, 'm9').cut).toEqual([0, 4]);
  });

  test('messages before the cut (a protected head: the greeting) were sent, so they are visible', () => {
    const c = chat(alternating(10, (i) => (i === 8 ? { trace: cut('m1', 'm4') } : {})));
    const v = visibilityAt(c.view, c.tree, 'm9');
    expect(v.cut).toEqual([1, 4]);
    expect(['m0', 'm1', 'm4', 'm5', 'm9'].map((id) => isVisible(v, id))).toEqual([true, false, false, true, true]);
    // A plot filed from the greeting is hidden (the greeting is in front of the model); one from the cut shows.
    expect(shown(created('p0', 'plot', 'm0'), v)).toBe(false);
    expect(shown(created('p2', 'plot', 'm2'), v)).toBe(true);
    // A summary of the cut run shows; an element added from the greeting is dropped.
    expect(shown(summary('s', 'm1', 'm4'), v)).toBe(true);
    const e = typed('c', 'character', { name: 'Hana', likes: ['tea', 'rain', 'maps'] }, { prov: { created: null, lastSeq: 7, appended: { likes: ['m0', 'm3', 'm6'] }, createdSeq: 3 } });
    expect(visibleCopy(e, v).entry?.data.likes).toEqual(['rain']);
  });

  test('a `from` that cannot be read starts the cut at the path\'s start; a `from` after `to` cuts nothing', () => {
    const at = (trace: Record<string, unknown>) => {
      const c = chat(alternating(10, (i) => (i === 8 ? { trace } : {})));
      return visibilityAt(c.view, c.tree, 'm9').cut;
    };
    expect(at({ trimmed: { to: 'm4' } })).toEqual([0, 4]);
    expect(at({ trimmed: { from: 'gone', to: 'm4' } })).toEqual([0, 4]);
    expect(at({ trimmed: { from: 3, to: 'm4' } })).toEqual([0, 4]);
    expect(at({ trimmed: { from: 'm6', to: 'm4' } })).toBeNull();
  });

  // RoleCall branch-trim-freshness.test.ts "fails closed for malformed or absent trim state": a cut that
  // cannot be read never moves the window.
  test.each([
    ['a cut that is not an object', { trimmed: 'm4' }],
    ['a cut without `to`', { trimmed: { from: 'm0' } }],
    ['a `to` that is not text', { trimmed: { from: 'm0', to: 4 } }],
    ['a `to` that is not on the path', { trimmed: { from: 'm0', to: 'gone' } }],
    ['no trimmed field at all', { seed: 1 }],
  ])('%s leaves everything visible', (_, trace) => {
    const c = chat(alternating(10, (i) => (i === 8 ? { trace } : {})));
    expect(visibilityAt(c.view, c.tree, 'm9').cut).toBeNull();
  });
});

describe('vectors C1–C6', () => {
  test('C1: a summary is hidden while its last message is visible (F3: a span ending just before the window shows)', () => {
    expect(shown(summary('s1', 'm1', 'm4'))).toBe(true);
    expect(shown(summary('s2', 'm3', 'm6'))).toBe(false);
    expect(shown(summary('s3', 'm5', 'm8'))).toBe(false);
    expect(visibleCopy(summary('s2', 'm3', 'm6'), VIS).dropped).toBe(1);
  });

  test('C2: a plot is hidden while the message that created it is visible; a human one never', () => {
    expect(shown(created('p4', 'plot', 'm4'))).toBe(true);
    expect(shown(created('p6', 'plot', 'm6'))).toBe(false);
    expect(shown(created('pn', 'plot', null))).toBe(true);
    expect(shown(created('e6', 'event', 'm6'))).toBe(false);
  });

  test('C3: an event created before the window keeps only the consequences added before it', () => {
    const e = typed('e', 'event', { name: 'Siege', consequences: ['The gate fell.', 'The mayor fled.'] }, { prov: { created: 'm2', lastSeq: 7, appended: { consequences: ['m2', 'm6'] }, createdSeq: 3 } });
    const r = visibleCopy(e, VIS);
    expect(r.entry?.data.consequences).toEqual(['The gate fell.']);
    expect(r.entry?.prov.appended.consequences).toEqual(['m2']);
    expect(r.dropped).toBe(1);
  });

  test('C4: a character created inside the window still shows, without the memories filed from it', () => {
    const memories = [{ what_happened: 'Old vow' }, { what_happened: 'Fresh argument' }, { what_happened: 'Told by the player' }];
    const e = typed('c', 'character', { name: 'Hana', memories }, { prov: { created: 'm6', lastSeq: 7, appended: { memories: ['m2', 'm6', null] }, createdSeq: 6 } });
    const r = visibleCopy(e, VIS);
    expect(r.entry).not.toBeNull();
    expect((r.entry!.data.memories as { what_happened: string }[]).map((m) => m.what_happened)).toEqual(['Old vow', 'Told by the player']);
    expect(r.dropped).toBe(1);
  });

  test('C5: with nothing cut every path-bound summary, plot and event is hidden, and filed elements are dropped', () => {
    expect(shown(summary('s1', 'm1', 'm4'), ALL)).toBe(false);
    expect(shown(created('p0', 'plot', 'm0'), ALL)).toBe(false);
    expect(shown(created('e2', 'event', 'm2'), ALL)).toBe(false);
    const c = typed('c', 'character', { name: 'Hana', likes: ['tea', 'rain', 'maps'] }, { prov: { created: 'm2', lastSeq: 7, appended: { likes: [null, 'm2', 'm8'] }, createdSeq: 3 } });
    const r = visibleCopy(c, ALL);
    expect(r.entry?.data.likes).toEqual(['tea']);
    expect(r.dropped).toBe(2);
  });

  test('C6: a library character is shown whole, and RoleCall turn numbers mean nothing here', () => {
    const memories = [
      { what_happened: 'Old vow', source_turn: 10, changed_belief: 'Trust is earned.' },
      { what_happened: 'Fresh argument', source_turn: 49, changed_behavior: 'Keeps her distance.' },
    ];
    const e = lib('lantern', 'e01', 'character', { name: 'Hana', memories });
    const r = visibleCopy(e, ALL);
    expect(r.entry?.data.memories).toEqual(memories);
    expect(r.dropped).toBe(0);
    expect(renderContent('character', r.entry!.data)).not.toContain('Source turn');
  });
});

describe('what is never hidden, and the copy', () => {
  test('notes, arcs, a summary without a range and library summaries are never hidden', () => {
    expect(shown(noteEntry('Брат', 'Он ушёл в море.', { prov: { created: 'm8', lastSeq: 1, appended: {}, createdSeq: 1 } }), ALL)).toBe(true);
    expect(shown(arcEntry('The Missing Lantern', 'It was lost.', { prov: { created: 'm8', lastSeq: 1, appended: {}, createdSeq: 1 } }), ALL)).toBe(true);
    expect(shown(typed('s', 'summary', { title: 'By hand', summary: 'x' }), ALL)).toBe(true);
    // RoleCall hid a constant or classic summary by its foreign turn_range; a library entry never is (B17).
    expect(shown(lib('lantern', 's', 'summary', { title: 'Old', summary: 'x', turn_range: { from: 0, to: 99 } }), ALL)).toBe(true);
  });

  test("an overlay keeps its library base elements and drops the ones a filing row added inside the window", () => {
    const e = lib('lantern', 'e01', 'character', { name: 'Hana', likes: ['tea', 'rain'] }, {
      origin: { kind: 'library', book: 'lantern', id: 'e01', overlay: true },
      prov: { created: null, lastSeq: 9, appended: { likes: [null, 'm8'] }, createdSeq: 0 },
    });
    expect(visibleCopy(e, VIS).entry?.data.likes).toEqual(['tea']);
  });

  test('the copy shares nothing mutable with the entry', () => {
    const e = typed('c', 'character', { name: 'Hana', likes: ['tea', 'rain'], physical: { eyes: 'grey' } }, { prov: { created: null, lastSeq: 2, appended: { likes: ['m1', 'm8'] }, createdSeq: 1 } });
    const r = visibleCopy(e, VIS).entry!;
    (r.data.physical as Record<string, string>).eyes = 'blue';
    r.prov.appended.likes!.push('x');
    r.aliases.push('H');
    const kept = visibleCopy(typed('d', 'character', { name: 'D', likes: ['a'] }), VIS).entry!;
    (kept.data.likes as string[]).push('b');
    expect(e.data).toEqual({ name: 'Hana', likes: ['tea', 'rain'], physical: { eyes: 'grey' } });
    expect(e.prov.appended.likes).toEqual(['m1', 'm8']);
    expect(e.aliases).toEqual([]);
  });

  test('provenance shorter than the list keeps the elements it does not cover', () => {
    const e = typed('c', 'character', { name: 'Hana', likes: ['a', 'b', 'c'] }, { prov: { created: null, lastSeq: 2, appended: { likes: ['m8'] }, createdSeq: 1 } });
    expect(visibleCopy(e, VIS).entry?.data.likes).toEqual(['b', 'c']);
  });
});

// RoleCall compendium-freshness.test.ts, on a 100-message path whose last reply sent the newest 20.
describe("RoleCall's freshness tests, on path positions", () => {
  const long = chat(alternating(100, (i) => (i === 98 ? { trace: cut('m0', 'm79') } : {})));
  const v = visibilityAt(long.view, long.tree, 'm99');

  test('keeps a fresh summary out of retrieval while its source messages remain live', () => {
    expect(v.cut).toEqual([0, 79]);
    expect(shown(summary('fresh', 'm96', 'm99'), v)).toBe(false);
    expect(shown(summary('old', 'm40', 'm50'), v)).toBe(true);
  });

  test('removes only still-live character memories while retaining the durable dossier', () => {
    const e = typed(
      'character',
      'character',
      {
        name: 'Hana',
        description: 'A durable character dossier.',
        memories: [
          { what_happened: 'Old vow', when: 'then', changed_belief: 'Trust is earned.' },
          { what_happened: 'Fresh argument', when: 'now', changed_behavior: 'Keeps her distance.' },
        ],
      },
      { prov: { created: 'm20', lastSeq: 9, appended: { memories: ['m20', 'm98'] }, createdSeq: 2 } },
    );
    const r = visibleCopy(e, v).entry!;
    expect(r.data.memories as unknown[]).toHaveLength(1);
    expect((r.data.memories as { what_happened: string }[])[0]!.what_happened).toBe('Old vow');
    const text = renderContent('character', r.data);
    expect(text).toContain('A durable character dossier.');
    expect(text).not.toContain('Fresh argument');
  });

  test('suppresses a plot filed within the live turns and keeps one from before them', () => {
    expect(shown(created('p19', 'plot', 'm91'), v)).toBe(false);
    expect(shown(created('p5', 'plot', 'm9'), v)).toBe(true);
  });

  test('suppresses a summary overlapping the live window, keeps one fully behind it', () => {
    expect(shown(summary('overlap', 'm70', 'm85'), v)).toBe(false);
    expect(shown(summary('behind', 'm0', 'm24'), v)).toBe(true);
  });
});
