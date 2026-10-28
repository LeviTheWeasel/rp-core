// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b (the lead's ruling K): a fork renumbers seq, so the {{recap}} pins a copied trace holds (arc
// revisions named by the seq of their mem row) follow their rows; a pin whose row was not copied goes.
import { describe, expect, test } from 'bun:test';
import type { Entry, EntryInput, MemEntry, Trace } from '../../src/session/entries.ts';
import { planFork } from '../../src/session/fork.ts';
import { makeHeader, msg, seqd, traceWith, TS } from './fixtures.ts';

const memRow = (on: string | null, plot: string): EntryInput =>
  ({ t: 'mem', ts: TS, key: on === null ? null : `hist:x-${on}`, on, by: on === null ? 'user' : 'historian', ops: [{ op: 'arc', plot, overview: `${plot} overview` }] }) as EntryInput;

describe('planFork and {{recap}} pins', () => {
  test('each pinned arc revision follows its mem row; a pin of a row left behind is dropped', () => {
    const inputs: EntryInput[] = [
      msg('g0000001', null, 'assistant', 'Hello.'),
      msg('u0000001', 'g0000001', 'user', 'Hi'),
      msg('a0000001', 'u0000001', 'assistant', 'one'),
      msg('u000000b', 'g0000001', 'user', 'other branch'),
      msg('a000000b', 'u000000b', 'assistant', 'branch answer'),
      memRow('a000000b', 'Branch'), // seq 6: bound off the fork's path, not copied
      memRow(null, 'Lantern'), // seq 7: a human row, copied
      msg('u0000002', 'a0000001', 'user', 'Again'),
    ];
    const recap = { ids: [], arcs: [{ key: 'arc:lantern', rev: 7 }, { key: 'arc:branch', rev: 6 }], boundary: 'u0000001' };
    inputs.push(msg('a0000002', 'u0000002', 'assistant', 'two', { trace: { ...traceWith(), recap } as unknown as Trace }));
    const entries: Entry[] = seqd(inputs);
    const { entries: forked } = planFork({ header: makeHeader(), entries }, 'a0000002', { newId: 's_0000f001', now: TS });
    const lantern = forked.find((e): e is MemEntry => e.t === 'mem' && e.key === null)!;
    expect(lantern.seq).not.toBe(7);
    const a2 = forked.find((e) => e.t === 'msg' && e.id === 'a0000002') as Entry & { trace: Trace };
    expect(a2.trace.recap.arcs).toEqual([{ key: 'arc:lantern', rev: lantern.seq }]);
    expect(a2.trace.recap.boundary).toBe('u0000001');
    expect(forked.some((e) => e.t === 'mem' && e.key === 'hist:x-a000000b')).toBe(false);
  });
});
