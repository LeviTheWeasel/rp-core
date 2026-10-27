// PathView.compendium (session/fold.ts) from TreeIndex.mems, and the "(in context)" set of /search.
import { describe, expect, test } from 'bun:test';
import { sentByHeadRequest } from '../../src/engine/session.ts';
import type { EntryInput } from '../../src/session/entries.ts';
import { foldView, foldViewAt } from '../../src/session/fold.ts';
import { buildTree } from '../../src/session/tree.ts';
import { edit, head, hide, makeHeader, msg, seqd, TS, traceWith } from '../session/fixtures.ts';
import { note } from './fixtures.ts';

const mem = (ops: ReturnType<typeof note>[], on: string | null = null): EntryInput => ({ t: 'mem', ts: TS, key: null, on, by: 'user', ops });

/** g → u1 → a1 (swipe a1b under u1), notes: one global, one bound to a1, one bound to the swipe a1b. */
function journal(): EntryInput[] {
  return [
    msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }),
    mem([note('Global')]),
    msg('u0000001', 'g0000001', 'user', 'Hi'),
    msg('a000001b', 'u0000001', 'assistant', 'old answer'),
    mem([note('Swiped')], 'a000001b'),
    msg('a0000001', 'u0000001', 'assistant', 'new answer'),
    mem([note('Bound')], 'a0000001'),
  ];
}

describe('buildTree: mem rows', () => {
  test('every mem row in seq order, and the last mem seq; mem rows never move the version', () => {
    const entries = seqd(journal());
    const tree = buildTree(entries);
    expect(tree.mems.map((m) => m.seq)).toEqual([2, 5, 7]);
    expect(tree.lastMemSeq).toBe(7);
    expect(tree.version).toBe(6);
    expect(buildTree(seqd(journal().filter((e) => e.t !== 'mem'))).lastMemSeq).toBe(0);
  });
});

describe('PathView.compendium', () => {
  test('foldView folds the rows bound to the head path and the global ones', () => {
    const view = foldView(makeHeader(), seqd(journal()));
    expect(view.head).toBe('a0000001');
    expect([...view.compendium.entries.keys()]).toEqual(['note:global', 'note:bound']);
    expect(view.compendium.lastSeq).toBe(7);
  });

  test('selecting the swipe swaps the bound notes', () => {
    const view = foldView(makeHeader(), seqd([...journal(), head('a000001b')]));
    expect([...view.compendium.entries.keys()]).toEqual(['note:global', 'note:swiped']);
  });

  test("foldViewAt: a swipe's view at U keeps the global notes and drops the replaced answer's", () => {
    const tree = buildTree(seqd(journal()));
    const atU = foldViewAt(makeHeader(), tree, 'u0000001');
    expect(atU.head).toBe('u0000001');
    expect([...atU.compendium.entries.keys()]).toEqual(['note:global']);
    const atA = foldViewAt(makeHeader(), tree, 'a0000001');
    expect([...atA.compendium.entries.keys()]).toEqual(['note:global', 'note:bound']);
  });

  test('a session without mem rows has an empty Compendium', () => {
    const view = foldView(makeHeader(), seqd(journal().filter((e) => e.t !== 'mem')));
    expect(view.compendium).toEqual({ entries: new Map(), rev: '', lastSeq: 0, issues: [], tasks: new Map(), effects: [] });
  });
});

describe('sentByHeadRequest (/search "in context")', () => {
  const ids = (s: ReadonlySet<string> | null) => (s === null ? null : [...s]);
  /** g → u1 → a1 → u2 → a2 → u3 → a3; a3's trace says what its request cut. */
  function chat(trimmed: { from: string; to: string } | null, extra: EntryInput[] = []) {
    const t = { ...traceWith(), trimmed };
    const entries = seqd([
      msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }),
      msg('u0000001', 'g0000001', 'user'),
      msg('a0000001', 'u0000001', 'assistant'),
      msg('u0000002', 'a0000001', 'user'),
      msg('a0000002', 'u0000002', 'assistant'),
      msg('u0000003', 'a0000002', 'user'),
      msg('a0000003', 'u0000003', 'assistant', 'answer', { gen: { kind: 'model' }, trace: t as never }),
      ...extra,
    ]);
    const tree = buildTree(entries);
    return { view: foldView(makeHeader(), entries, tree), tree };
  }

  test('nothing cut: every earlier path message was sent (the head itself was not)', () => {
    const { view, tree } = chat(null);
    expect(ids(sentByHeadRequest(view, tree))).toEqual(['g0000001', 'u0000001', 'a0000001', 'u0000002', 'a0000002', 'u0000003']);
  });

  test('the cut range (trace.trimmed) and hidden messages were not sent', () => {
    const { view, tree } = chat({ from: 'u0000001', to: 'a0000001' }, [hide('u0000002')]);
    expect(ids(sentByHeadRequest(view, tree))).toEqual(['g0000001', 'a0000002', 'u0000003']);
  });

  test("a continue's trace replaces the answer's", () => {
    const cont = { t: 'edit', ts: TS, target: 'a0000003', reason: 'continue', blocks: [{ k: 'text', text: 'answer, longer' }], trace: { ...traceWith(), trimmed: { from: 'g0000001', to: 'u0000002' } } } as EntryInput;
    const { view, tree } = chat(null, [cont]);
    expect(ids(sentByHeadRequest(view, tree))).toEqual(['a0000002', 'u0000003']);
    // A user edit carries no trace: the answer's own still counts.
    const plain = chat(null, [edit('a0000003', 'answer, edited')]);
    expect(sentByHeadRequest(plain.view, plain.tree)?.size).toBe(6);
  });

  test('unknown → null: a user head, a greeting head, a cut that names messages no longer on the path', () => {
    const userHead = chat(null, [msg('u0000004', 'a0000003', 'user')]);
    expect(sentByHeadRequest(userHead.view, userHead.tree)).toBeNull();
    const greeting = chat(null, [head('g0000001')]);
    expect(sentByHeadRequest(greeting.view, greeting.tree)).toBeNull();
    const gone = chat({ from: 'zzzzzzzz', to: 'a0000001' });
    expect(sentByHeadRequest(gone.view, gone.tree)).toBeNull();
    const empty = foldView(makeHeader(), []);
    expect(sentByHeadRequest(empty, buildTree([]))).toBeNull();
  });
});
