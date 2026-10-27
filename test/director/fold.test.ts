// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// agents/director/state.ts directorAt (D-103, §5.9): the Director's state at a message is the
// `dir.state` of the nearest assistant ancestor (inclusive) whose record checkRecord accepts. Trees
// are built with the real buildTree over synthetic journal entries (test/session/fixtures.ts):
// linear path, swipe, rewind, fork, hidden reply, invalid and newer-reducer records, greeting-only
// path, unknown ids, edits and user rows that carry a dir, and a deep path.
import { describe, expect, test } from 'bun:test';
import { directorAt, emptyState } from '../../src/agents/director/state.ts';
import type { DirectorRecord, DirectorState } from '../../src/agents/director/types.ts';
import type { EntryInput, MsgEntry } from '../../src/session/entries.ts';
import { planFork } from '../../src/session/fork.ts';
import { buildTree, type TreeIndex } from '../../src/session/tree.ts';
import { edit, head, hide, makeHeader, msg, seqd, TS } from '../session/fixtures.ts';
import { arcOf, recordOf, seedOf, stateOf } from './fixtures-state.ts';

/** A state that says which turn made it (turn, an arc and a seed named after it). */
const stateAt = (turn: number, tag = ''): DirectorState =>
  stateOf({
    turn,
    nextId: 3,
    arcs: [arcOf({ id: 'arc-1', title: `Нить ${turn}${tag}`, createdAtTurn: 1, lastProgressTurn: turn })],
    seeds: [seedOf({ id: 'seed-2', hint: `Колокол ${turn}${tag}`, plantedAtTurn: 1 })],
  });

const withDir = (dir: unknown): Partial<MsgEntry> => ({ dir: dir as Record<string, unknown> });
const reply = (id: string, parent: string, dir?: DirectorRecord | Record<string, unknown>): EntryInput =>
  msg(id, parent, 'assistant', `ответ ${id}`, dir === undefined ? {} : withDir(dir));
const user = (id: string, parent: string | null): EntryInput => msg(id, parent, 'user', `реплика ${id}`);
const greeting = (id = 'g0000001'): EntryInput => msg(id, null, 'assistant', 'Здравствуй, путник.', { gen: { kind: 'greeting' } as MsgEntry['gen'] });
const tree = (inputs: EntryInput[]): TreeIndex => buildTree(seqd(inputs));

/** greeting → u1 → a1(turn 1) → u2 → a2(turn 2) → u3 */
function linear(): EntryInput[] {
  return [
    greeting(),
    user('u0000001', 'g0000001'),
    reply('a0000001', 'u0000001', recordOf(stateAt(1))),
    user('u0000002', 'a0000001'),
    reply('a0000002', 'u0000002', recordOf(stateAt(2))),
    user('u0000003', 'a0000002'),
  ];
}

describe('directorAt', () => {
  test('a linear path: the nearest assistant ancestor with a dir, the start inclusive', () => {
    const t = tree(linear());
    const at3 = directorAt(t, 'u0000003');
    expect(at3).toEqual({ state: stateAt(2), from: 'a0000002', record: recordOf(stateAt(2)), invalid: 0 });
    expect(directorAt(t, 'a0000002').from).toBe('a0000002'); // inclusive
    expect(directorAt(t, 'u0000002').state).toEqual(stateAt(1));
    expect(directorAt(t, 'u0000001')).toEqual({ state: emptyState(), invalid: 0 });
    expect(directorAt(t, t.head).from).toBe('a0000002');
  });

  test('a swipe plans from the ancestor: the state at U comes from before the replaced reply, not from a sibling', () => {
    const t = tree([
      ...linear().slice(0, 5),
      reply('a0000002b', 'u0000002', recordOf(stateAt(2, ' (свайп)'))), // the second version of a2
    ]);
    // U of a swipe of a2 (or of a2b) is their parent u2: the state is a1's.
    const at = directorAt(t, 'u0000002');
    expect(at.from).toBe('a0000001');
    expect(at.state).toEqual(stateAt(1));
    // Each version carries its own state.
    expect(directorAt(t, 'a0000002').state.arcs[0]!.title).toBe('Нить 2');
    expect(directorAt(t, 'a0000002b').state.arcs[0]!.title).toBe('Нить 2 (свайп)');
    expect(directorAt(t, t.head).from).toBe('a0000002b');
  });

  test('a rewind: after the head moves to an older reply, a new branch folds from that reply, the abandoned branch unseen', () => {
    const t = tree([
      ...linear(),
      reply('a0000003', 'u0000003', recordOf(stateAt(3))),
      head('a0000001'),
      user('u0000002x', 'a0000001'),
      reply('a0000002x', 'u0000002x', recordOf(stateAt(2, ' (ветка)'))),
      user('u0000003x', 'a0000002x'),
    ]);
    expect(t.head).toBe('u0000003x');
    expect(directorAt(t, 'u0000002x').from).toBe('a0000001');
    expect(directorAt(t, t.head).state.arcs[0]!.title).toBe('Нить 2 (ветка)');
    expect(directorAt(t, 'u0000003x').state.turn).toBe(2);
    // The old branch still folds to its own state.
    expect(directorAt(t, 'a0000003').state.turn).toBe(3);
  });

  test('a fork carries the state: the copied path folds to the same state at the fork point', () => {
    const source = { header: makeHeader(), entries: seqd([...linear(), reply('a0000003', 'u0000003', recordOf(stateAt(3)))]) };
    const fork = planFork(source, 'u0000003', { newId: 's_0000f001', now: TS });
    const ft = buildTree(fork.entries);
    expect(ft.head).toBe('u0000003');
    expect(directorAt(ft, ft.head)).toEqual(directorAt(buildTree(source.entries), 'u0000003'));
    expect(directorAt(ft, ft.head).state).toEqual(stateAt(2));
    expect(ft.msgs.has('a0000003')).toBe(false);
  });

  test('a hidden reply still counts: hiding removes the text, not the plan’s history', () => {
    const t = tree([...linear(), hide('a0000002')]);
    expect(t.hidden.get('a0000002')).toBe(true);
    expect(directorAt(t, 'u0000003').from).toBe('a0000002');
  });

  test('an invalid dir is skipped for the next ancestor and counted', () => {
    const t = tree([
      ...linear().slice(0, 4),
      reply('a0000002', 'u0000002', { turn: 2, ok: true, reducer: 1, state: { turn: 'two' } }),
      user('u0000003', 'a0000002'),
      reply('a0000003', 'u0000003', { garbage: true }),
      user('u0000004', 'a0000003'),
    ]);
    expect(directorAt(t, 'u0000004')).toEqual({ state: stateAt(1), from: 'a0000001', record: recordOf(stateAt(1)), invalid: 2 });
  });

  test('a record of another reducer version is skipped (and counted): its state is not this reducer’s', () => {
    const t = tree([...linear().slice(0, 4), reply('a0000002', 'u0000002', recordOf(stateAt(2), { reducer: 2 })), user('u0000003', 'a0000002')]);
    const at = directorAt(t, 'u0000003');
    expect(at.from).toBe('a0000001');
    expect(at.invalid).toBe(1);
  });

  test('a failed plan carries the state too (ok:false is a valid record)', () => {
    const failed = recordOf({ ...stateAt(1), turn: 2 }, { ok: false, code: 'timeout' });
    delete failed.directive;
    const t = tree([...linear().slice(0, 4), reply('a0000002', 'u0000002', failed), user('u0000003', 'a0000002')]);
    const at = directorAt(t, 'u0000003');
    expect(at.from).toBe('a0000002');
    expect(at.state.turn).toBe(2);
    expect(at.record!.ok).toBe(false);
    expect(at.record!.code).toBe('timeout');
  });

  test('a path with only the greeting folds to the empty state; so do null and an unknown id', () => {
    const t = tree([greeting(), msg('g0000002', null, 'assistant', 'Опять ты.', { gen: { kind: 'greeting' } as MsgEntry['gen'] }), user('u0000001', 'g0000002')]);
    expect(directorAt(t, 'u0000001')).toEqual({ state: emptyState(), invalid: 0 });
    expect(directorAt(t, 'g0000001')).toEqual({ state: emptyState(), invalid: 0 });
    expect(directorAt(t, null)).toEqual({ state: emptyState(), invalid: 0 });
    expect(directorAt(t, 'draft')).toEqual({ state: emptyState(), invalid: 0 });
    expect(directorAt(buildTree([]), 'u0000001')).toEqual({ state: emptyState(), invalid: 0 });
  });

  test('a dir on a user message is ignored (not counted); an edit row’s dir is never read (continue writes none, D-104)', () => {
    const t = tree([
      ...linear().slice(0, 4),
      reply('a0000002', 'u0000002', recordOf(stateAt(2))),
      msg('u0000003', 'a0000002', 'user', 'реплика', withDir(recordOf(stateAt(9)))),
      edit('a0000002', 'продолжение', { reason: 'continue', dir: recordOf(stateAt(7)) }),
    ]);
    const at = directorAt(t, 'u0000003');
    expect(at.from).toBe('a0000002');
    expect(at.state.turn).toBe(2);
    expect(at.invalid).toBe(0);
  });

  test('a reply committed as a tail does not change the state at U, and folds to its own', () => {
    const t = tree([...linear(), reply('a0000003', 'u0000003', recordOf(stateAt(3))), user('u0000004', 'a0000003'), { ...reply('a0000003t', 'u0000003', recordOf(stateAt(3, ' (хвост)'))), tail: true } as EntryInput]);
    expect(t.head).toBe('u0000004');
    expect(directorAt(t, t.head).state.arcs[0]!.title).toBe('Нить 3');
    expect(directorAt(t, 'a0000003t').state.arcs[0]!.title).toBe('Нить 3 (хвост)');
  });

  test('every call returns fresh objects: changing one result does not change the next', () => {
    const t = tree(linear());
    const a = directorAt(t, 'u0000003');
    a.state.arcs.push(arcOf({ id: 'arc-9' }));
    a.state.turn = 99;
    const b = directorAt(t, 'u0000003');
    expect(b.state).toEqual(stateAt(2));
    expect(t.msgs.get('a0000002')!.dir).toEqual(recordOf(stateAt(2)) as unknown as Record<string, unknown>);
    const empty = directorAt(t, 'u0000001');
    empty.state.arcs.push(arcOf());
    expect(directorAt(t, 'u0000001').state).toEqual(emptyState());
  });

  test('a deep path: O(depth), stops at the nearest valid record, and walks to the root when none is valid', () => {
    const inputs: EntryInput[] = [greeting()];
    let parent = 'g0000001';
    const depth = 10_000;
    for (let i = 0; i < depth; i++) {
      const u = `u${String(i).padStart(7, '0')}`;
      const a = `a${String(i).padStart(7, '0')}`;
      inputs.push(user(u, parent), reply(a, u, i === 0 ? recordOf(stateAt(1)) : { reducer: 1, broken: i }));
      parent = a;
    }
    const t = tree(inputs);
    const t0 = performance.now();
    const at = directorAt(t, t.head);
    const ms = performance.now() - t0;
    expect(at.from).toBe('a0000000');
    expect(at.invalid).toBe(depth - 1);
    expect(ms).toBeLessThan(1_000); // generous: CI noise; the walk is linear
    const near = tree([...inputs, user('uLAST', parent), reply('aLAST', 'uLAST', recordOf(stateAt(5))), user('uNEXT', 'aLAST')]);
    expect(directorAt(near, 'uNEXT')).toMatchObject({ from: 'aLAST', invalid: 0 });
  });
});
