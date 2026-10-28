// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The request builder's side of the slot (D-178): which request is "the previous one" (the nearest
// answer at or before upTo, its newest continue edit's trace — so a swipe of a past answer reads its
// predecessor's trace.recap, never the head's), the slot's input only while the Compendium is on, the
// lore tools counting the slot's summaries as in the prompt; and the helpers (lenient trace reading,
// the books check, a session arc replacing the library arc of its plot).
import { describe, expect, test } from 'bun:test';
import { recapSlot, type RecapInput, type RecapTrace } from '../../src/agents/compendium/recap.ts';
import { resolveCompendium } from '../../src/agents/compendium/profile.ts';
import { previousRecap, recapRequest, unfiredCompendium } from '../../src/engine/request.ts';
import { chooseRecap, readRecapTrace, recapTraceOf, replacedLibraryArcs, sameBooks } from '../../src/prompt/assemble/recap.ts';
import type { EditEntry, Entry, MsgEntry, Trace } from '../../src/session/entries.ts';
import { buildTree } from '../../src/session/tree.ts';
import { greet, m, path } from '../assemble/fixtures.ts';
import { histRow, viewOf, words } from '../historian-m5b/kit.ts';
import { arc, libArc, summary, typed } from './kit.ts';

const TS = '2026-10-28T12:00:00.000Z';

/** A trace with this recap and these books (the rest as a turn writes it). */
function traceOf(recap: RecapTrace, books: Record<string, string> = {}): Trace {
  return {
    seed: 1,
    now: TS,
    window: 8192,
    reserve: 2048,
    tokens: { estimated: 0, counter: 'chars' },
    blocks: [],
    lore: { fired: [], cut: [], budget: 0 },
    recap,
    prefill: null,
    macros: { unknown: [] },
    trimmed: null,
    calls: [],
    agents: {},
    presetHash: 'p',
    loreHashes: books,
  };
}

const R = (boundary: string): RecapTrace => ({ ids: [`summary:${boundary}`], arcs: [{ key: 'arc:x', rev: 3 }], boundary });

/** g u1 a1 u2 a2 u3 a3, each answer's trace naming its own boundary; a3 continued once (its edit's trace: 'a3c'). */
function journal(): { entries: Entry[]; ids: string[] } {
  const ids = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
  const entries: Entry[] = ids.map((id, i): MsgEntry => {
    const assistant = id.startsWith('a') || id === 'g';
    return {
      t: 'msg',
      seq: i + 1,
      ts: TS,
      id,
      parent: i === 0 ? null : ids[i - 1]!,
      role: assistant ? 'assistant' : 'user',
      blocks: [{ k: 'text', text: id }],
      ...(id === 'g' ? { gen: { kind: 'greeting' as const } } : {}),
      ...(id.startsWith('a') ? { gen: { kind: 'model' as const }, trace: traceOf(R(id), { book: `h-${id}` }) } : {}),
    };
  });
  const edit: EditEntry = { t: 'edit', seq: 8, ts: TS, target: 'a3', reason: 'continue', blocks: [{ k: 'text', text: 'a3 more' }], trace: traceOf(R('a3c')) };
  return { entries: [...entries, edit], ids };
}

const viewTo = (ids: string[], upTo: string) => path(ids.slice(0, ids.indexOf(upTo) + 1).map((id) => (id === 'g' ? greet(id, id) : m(id, id.startsWith('a') ? 'assistant' : 'user', id))));

describe('previousRecap: the request before this one', () => {
  const { entries, ids } = journal();
  const tree = buildTree(entries);

  test('a reply to U reads the answer before U', () => {
    expect(previousRecap(viewTo(ids, 'u3'), tree, 'u3')).toEqual({ recap: R('a2'), books: { book: 'h-a2' } });
  });

  test("a swipe of a past answer (the view folded at its U) reads its predecessor's trace, not the head's", () => {
    expect(previousRecap(viewTo(ids, 'u2'), tree, 'u2')?.recap).toEqual(R('a1'));
  });

  test("a continue extends A: A's own request, through its newest continue edit", () => {
    expect(previousRecap(viewTo(ids, 'a3'), tree, 'a3')?.recap).toEqual(R('a3c'));
    expect(previousRecap(viewTo(ids, 'a2'), tree, 'a2')?.recap).toEqual(R('a2'));
  });

  test('the first answer reads nothing: the greeting has no trace; upTo off the path reads nothing', () => {
    expect(previousRecap(viewTo(ids, 'u1'), tree, 'u1')).toBeNull();
    expect(previousRecap(viewTo(ids, 'u1'), tree, 'zz')).toBeNull();
  });

  test('an unreadable trace.recap reads as none; unreadable books are left out', () => {
    const bad = buildTree([
      { t: 'msg', seq: 1, ts: TS, id: 'g', parent: null, role: 'assistant', blocks: [], gen: { kind: 'greeting' } },
      { t: 'msg', seq: 2, ts: TS, id: 'u1', parent: 'g', role: 'user', blocks: [] },
      { t: 'msg', seq: 3, ts: TS, id: 'a1', parent: 'u1', role: 'assistant', blocks: [], trace: { ...traceOf(R('a1')), recap: { ids: 'x' } as never } },
      { t: 'msg', seq: 4, ts: TS, id: 'u2', parent: 'a1', role: 'user', blocks: [] },
      { t: 'msg', seq: 5, ts: TS, id: 'a2', parent: 'u2', role: 'assistant', blocks: [], trace: { ...traceOf(R('a2')), loreHashes: { b: 7 } as never } },
      { t: 'msg', seq: 6, ts: TS, id: 'u3', parent: 'a2', role: 'user', blocks: [] },
    ]);
    const v = path([greet('g', 'g'), m('u1', 'user', 'u1'), m('a1', 'assistant', 'a1'), m('u2', 'user', 'u2'), m('a2', 'assistant', 'a2'), m('u3', 'user', 'u3')]);
    expect(previousRecap(v, bad, 'u2')).toBeNull();
    expect(previousRecap(v, bad, 'u3')).toEqual({ recap: R('a2') });
  });
});

describe('recapRequest: the slot input', () => {
  const { entries, ids } = journal();
  const tree = { ...buildTree(entries), mems: [histRow(30, 'u1', 'a1', [{ op: 'arc', plot: 'X', overview: 'Old X.' }])] };
  const view = viewTo(ids, 'u3');

  test('Compendium off: none (no slot, the M5a request)', () => {
    expect(recapRequest(view, tree, 'u3', resolveCompendium({ enabled: false }), 32_768)).toBeUndefined();
  });

  test("on: the previous request's slot and books, the narrator window's profile, old revisions from the rows", () => {
    const r = recapRequest(view, tree, 'u3', resolveCompendium({ enabled: true }), 32_768)!;
    expect(r).toMatchObject({ previous: R('a2'), books: { book: 'h-a2' }, profile: 'full' });
    expect(r.revisionText!('arc:x', 30)).toBe('Old X.');
    expect(recapRequest(view, tree, 'u3', resolveCompendium({ enabled: true }), 8192)!.profile).toBe('lite');
    expect(recapRequest(view, tree, 'u3', resolveCompendium({ enabled: true, profile: 'full' }), 8192)!.profile).toBe('full');
  });
});

describe('the lore tools see the slot (D-156)', () => {
  test("a live typed entry the slot holds is not 'left out'", () => {
    const s = summary('Fog night', 'The Lantern', ['u1', 'a1']);
    const c = viewOf([s]);
    expect(unfiredCompendium(c, [])).toBe(true);
    expect(unfiredCompendium(c, [], ['summary:a1.0'])).toBe(false);
    expect(unfiredCompendium(viewOf([s, typed('character:ада', 'character', { name: 'Ада' })]), [], ['summary:a1.0'])).toBe(true);
  });
});

describe('helpers', () => {
  test('readRecapTrace: the shape, read leniently; recapTraceOf: the empty form without a slot', () => {
    expect(readRecapTrace({ ids: ['a'], arcs: [{ key: 'k', rev: 2, more: 1 }], boundary: 'b', extra: true })).toEqual({ ids: ['a'], arcs: [{ key: 'k', rev: 2 }], boundary: 'b' });
    expect(readRecapTrace({ ids: [], arcs: [], boundary: null })).toEqual({ ids: [], arcs: [], boundary: null });
    for (const bad of [null, [], { ids: [1], arcs: [], boundary: null }, { ids: [], arcs: [{ key: 'k', rev: Infinity }], boundary: null }, { ids: [], arcs: [], boundary: 3 }, { ids: [], boundary: null }]) {
      expect(readRecapTrace(bad)).toBeNull();
    }
    expect(recapTraceOf(null)).toEqual({ ids: [], arcs: [], boundary: null });
  });

  test('sameBooks: the same keys and hashes, the notes book aside', () => {
    expect(sameBooks({ a: '1', '@notes': 'x' }, { a: '1', '@notes': 'y' })).toBe(true);
    expect(sameBooks({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameBooks({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameBooks(null, {})).toBe(false);
  });

  test('chooseRecap: a session arc in the slot replaces the library arcs of its plot (two books included)', () => {
    const entries = [
      summary('Fog night', 'The Lantern', ['m1', 'm4']),
      arc('The Lantern', 'Story overview.', 20),
      libArc('one', 'a1', 'the  lantern', 'Book one overview.', 300),
      libArc('two', 'a1', 'The Lantern', 'Book two overview.', 200),
      libArc('one', 'a2', 'Salt', 'Salt overview.', 100),
    ];
    const input: RecapInput = {
      view: viewOf(entries),
      path: Array.from({ length: 20 }, (_, i) => `m${i + 1}`),
      trimmed: { from: 'm1', to: 'm8' },
      boundary: 'm9',
      previous: null,
      budgetTok: 24,
      profile: 'full',
      count: words,
    };
    // Without the rule, the arc half (12 words) holds the session arc (5) and the first library one (6).
    expect(recapSlot(input)!.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:one:a1']);
    expect([...replacedLibraryArcs(input.view.entries, [{ key: 'arc:the lantern' }])].sort()).toEqual(['lib:one:a1', 'lib:two:a1']);
    expect(chooseRecap(input)!.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:one:a2']);
    // No session arc in the slot: nothing replaced.
    expect(replacedLibraryArcs(input.view.entries, [{ key: 'lib:one:a2' }]).size).toBe(0);
  });
});
