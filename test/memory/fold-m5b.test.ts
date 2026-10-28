// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M5b fold (.notes/m5b-decisions.md D-179): a human edit / retire / restore addressed by a key that
// no entry has yet waits for it, so a refile or a re-write after staleness keeps the person's changes;
// TaskState's `stale` flag and `range` (G-2); the TreeIndex job index (D-171).
import { describe, expect, test } from 'bun:test';
import { foldCompendium, type FoldOptions } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { Entry, EntryInput, JobEntry, MemEntry, MemOp } from '../../src/session/entries.ts';
import { foldView, foldViewAt } from '../../src/session/fold.ts';
import { buildTree } from '../../src/session/tree.ts';
import { edit, hide, makeHeader, msg, seqd, TS } from '../session/fixtures.ts';
import { file, filing, hist, note, row } from './fixtures.ts';
import { lantern } from './kit.ts';

/** An agent row as the M5b lane writes it, for the log (no seq). */
const fileRow = (on: string, range: [string, string], ops: MemOp[]): EntryInput => ({ t: 'mem', ts: TS, key: `file:${on}`, on, by: 'filing', range, ops }) as EntryInput;
const histRow = (from: string, to: string, ops: MemOp[]): EntryInput => ({ t: 'mem', ts: TS, key: `hist:${from}-${to}`, on: to, by: 'historian', range: [from, to], ops }) as EntryInput;
/** A human row as the verbs write it: key null, on null. */
const userRow = (...ops: MemOp[]): EntryInput => ({ t: 'mem', ts: TS, key: null, on: null, by: 'user', ops }) as EntryInput;
const editOp = (ref: string, more: Record<string, unknown>): MemOp => ({ op: 'edit', ref, ...more }) as MemOp;
const retireOp = (ref: string, reason = ''): MemOp => ({ op: 'retire', ref, reason });
const restoreOp = (ref: string): MemOp => ({ op: 'restore', ref });

/** g → u1 → a1 → u2 → a2 (no rows). */
const CHAT: EntryInput[] = [
  msg('g0000001', null, 'assistant', 'Здравствуй.', { gen: { kind: 'greeting' } }),
  msg('u0000001', 'g0000001', 'user', 'Где Мира?'),
  msg('a0000001', 'u0000001', 'assistant', 'Мира у маяка.'),
  msg('u0000002', 'a0000001', 'user', 'А маяк?'),
  msg('a0000002', 'u0000002', 'assistant', 'Маяк горит.'),
];
const MIRA = (description = 'Фонарщица.'): MemOp => file('character', { name: 'Мира', description });
const LIGHTHOUSE = file('location', { name: 'Маяк', description: 'Башня на мысе.' });
const viewOf = (extra: EntryInput[]) => foldView(makeHeader(), seqd([...CHAT, ...extra])).compendium;
const seqOf = (extra: EntryInput[], i: number): number => CHAT.length + i + 1;

describe('D-179: human ops wait for their entry', () => {
  test('a refile (a newer row of the key) re-creates the entries at its seq: the edit and the retire made in between survive', () => {
    // The pass of the newest answer, a2: the person's rows (written after a2) and the refile share its
    // place in the story (D-184); the refile, an agent row, applies first (K, order#2), so the person's
    // ops meet the re-created entries at once. (A hold that waits for its entry: test/fold-m5b.)
    const rows = [
      fileRow('a0000002', ['u0000002', 'a0000002'], [MIRA(), LIGHTHOUSE]),
      userRow(editOp('character:мира', { set: { role: 'ally' } })),
      userRow(retireOp('location:маяк', 'сгорел')),
      userRow(editOp('character:мира', { featured: true })),
      fileRow('a0000002', ['u0000002', 'a0000002'], [MIRA('Фонарщица, ученица.'), LIGHTHOUSE]),
    ];
    const c = viewOf(rows);
    const mira = c.entries.get('character:мира')!;
    expect(mira.data).toMatchObject({ name: 'Мира', description: 'Фонарщица, ученица.', role: 'ally' });
    expect(mira.featured).toBe(true);
    expect(c.entries.get('location:маяк')!.retired).toEqual({ reason: 'сгорел' });
    expect(c.issues).toEqual([]);
    const refile = seqOf(rows, 4);
    expect(c.tasks.get('file:a0000002')).toEqual({ seq: refile, status: 'applied', range: ['u0000002', 'a0000002'] });
    // The refile's effects first, then the person's in seq order.
    expect(c.effects.map((x) => [x.seq, x.op, x.key, x.change])).toEqual([
      [refile, 0, 'character:мира', 'created'],
      [refile, 1, 'location:маяк', 'created'],
      [seqOf(rows, 1), 0, 'character:мира', 'edited'],
      [seqOf(rows, 2), 0, 'location:маяк', 'retired'],
      [seqOf(rows, 3), 0, 'character:мира', 'edited'],
    ]);
    // Without the refile the same ops apply in plain seq order: the same entries.
    const before = viewOf(rows.slice(0, 4));
    expect(before.entries.get('character:мира')!.data.role).toBe('ally');
    expect(before.entries.get('location:маяк')!.retired).toEqual({ reason: 'сгорел' });
  });

  test('a re-write after staleness: while the row is stale its entry is gone and the edit is not_found; the re-written row brings both back', () => {
    const filed = fileRow('a0000001', ['u0000001', 'a0000001'], [MIRA()]);
    const person = userRow(editOp('character:мира', { set: { role: 'ally' } }), retireOp('character:мира'), restoreOp('character:мира'));
    const stale = viewOf([filed, person, edit('u0000001', 'Где же Мира?')]);
    expect(stale.entries.has('character:мира')).toBe(false);
    const at = seqOf([], 1);
    expect(stale.issues).toEqual([
      { seq: at, op: 0, why: 'not_found' },
      { seq: at, op: 1, why: 'not_found' },
      { seq: at, op: 2, why: 'not_found' },
    ]);
    expect(stale.tasks.get('file:a0000001')).toMatchObject({ status: 'stale' });
    // The lane re-writes the key: the entry is created again, the person's three ops apply in order.
    const again = viewOf([filed, person, edit('u0000001', 'Где же Мира?'), fileRow('a0000001', ['u0000001', 'a0000001'], [MIRA('Ищет фонарь.')])]);
    const mira = again.entries.get('character:мира')!;
    expect(mira.data).toMatchObject({ description: 'Ищет фонарь.', role: 'ally' });
    expect(mira.retired).toBeUndefined();
    expect(again.issues).toEqual([]);
    expect(again.tasks.get('file:a0000001')).toMatchObject({ seq: seqOf([], 3), status: 'applied' });
  });

  test('a historian summary and arc re-written after a hide keep the person\'s edits; the arc\'s lastSeq is the row whose text it shows', () => {
    const summary = file('summary', { title: 'Вечер', summary: 'Мира пришла к маяку.' });
    const arc: MemOp = { op: 'arc', plot: 'Свет', overview: 'Маяк горит.' };
    const rows = [
      histRow('u0000001', 'a0000002', [summary, arc]),
      userRow(editOp('summary:a0000002.0', { set: { summary: 'Мира и Кай пришли к маяку.' } })),
      userRow(editOp('arc:свет', { set: { content: 'Маяк горит всю ночь.' } })),
      hide('u0000002'),
      histRow('u0000001', 'a0000002', [summary, { op: 'arc', plot: 'Свет', overview: 'Маяк снова горит.' }]),
    ];
    const c = viewOf(rows);
    expect(c.entries.get('summary:a0000002.0')!.data.summary).toBe('Мира и Кай пришли к маяку.');
    const overview = c.entries.get('arc:свет')!;
    expect(overview.content).toBe('Маяк горит всю ночь.');
    // Applied after the re-write's arc op, the edit is the last change in fold order: lastSeq names its
    // row (older than the entry's createdSeq), so the text shown is the text of the row lastSeq names.
    expect(overview.prov).toMatchObject({ createdSeq: seqOf(rows, 4), lastSeq: seqOf(rows, 2) });
    expect(c.issues).toEqual([]);
  });

  test('held ops of one key apply in seq order: the later edit wins; retire then restore leaves it live', () => {
    const rows = [
      row(2, [editOp('character:мира', { set: { role: 'A' } })]),
      row(3, [retireOp('character:мира'), editOp('character:мира', { set: { role: 'B' } })]),
      row(4, [restoreOp('character:мира')]),
      filing(9, 'a0000001', [MIRA()]),
    ];
    const c = foldCompendium(rows, { pathSet: new Set(['a0000001']) });
    expect(c.entries.get('character:мира')).toMatchObject({ data: { role: 'B' } });
    expect(c.entries.get('character:мира')!.retired).toBeUndefined();
    expect(c.effects.map((x) => [x.seq, x.op, x.change])).toEqual([
      [9, 0, 'created'],
      [2, 0, 'edited'],
      [3, 0, 'retired'],
      [3, 1, 'edited'],
      [4, 0, 'restored'],
    ]);
    expect(foldCompendium(rows.slice(0, 2).concat(rows[3]!), { pathSet: new Set(['a0000001']) }).entries.get('character:мира')!.retired).toEqual({ reason: '' });
  });

  test('a held op that fails when it applies is reported at its own seq; issues stay in (seq, op) order', () => {
    const c = foldCompendium(
      [
        row(2, [editOp('character:мира', { unset: ['name'] }), note('!!!')]),
        row(3, [editOp('character:нет', { set: { role: 'x' } })]),
        filing(9, 'a0000001', [MIRA(), { op: 'merge' } as unknown as MemOp]),
      ],
      { pathSet: new Set(['a0000001']) },
    );
    expect(c.issues).toEqual([
      { seq: 2, op: 0, why: 'invalid', key: 'character:мира' },
      { seq: 2, op: 1, why: 'invalid' },
      // Never met: the key no row creates.
      { seq: 3, op: 0, why: 'not_found' },
      { seq: 9, op: 1, why: 'unknown_op' },
    ]);
  });

  test('only key-addressed ops of human rows wait: a handle or a name resolves at once; a lib: key is library_entry_missing; an agent row\'s op is not held', () => {
    const seed = librarySeed([lantern()], { enabled: true });
    const opts: FoldOptions = { pathSet: new Set(['a0000001']), library: seed };
    const c = foldCompendium(
      [
        row(2, [editOp('Мира', { set: { role: 'x' } }), editOp('C9', { set: { role: 'y' } }), retireOp('lib:lantern:нет')]),
        row(3, [editOp('character:мира', { set: { role: 'z' } })], { key: 'file:x', on: 'a0000001', by: 'filing' }),
        filing(9, 'a0000001', [MIRA()]),
      ],
      opts,
    );
    expect(c.issues).toEqual([
      { seq: 2, op: 0, why: 'not_found' },
      { seq: 2, op: 1, why: 'not_found' },
      { seq: 2, op: 2, why: 'library_entry_missing', key: 'lib:lantern:нет' },
      { seq: 3, op: 0, why: 'not_found' },
    ]);
    expect(c.entries.get('character:мира')!.data.role).toBeUndefined();
  });

  test('a held op off the path, or on a path without the creating row, is not_found (a swipe view at U)', () => {
    const rows = [fileRow('a0000002', ['u0000002', 'a0000002'], [MIRA()]), userRow(editOp('character:мира', { set: { role: 'ally' } }))];
    const entries = seqd([...CHAT, ...rows]);
    const atU = foldViewAt(makeHeader(), buildTree(entries), 'u0000002').compendium;
    expect(atU.entries.has('character:мира')).toBe(false);
    expect(atU.issues).toEqual([{ seq: seqOf(rows, 1), op: 0, why: 'not_found' }]);
    expect(foldView(makeHeader(), entries).compendium.entries.get('character:мира')!.data.role).toBe('ally');
  });

  test('held ops cross a checkpoint: a resumed fold equals a fold from the seed', () => {
    const PATH = Array.from({ length: 3 }, (_, i) => `m${i}`);
    const rows: MemEntry[] = [row(1, [editOp('character:поздний', { set: { role: 'ждёт' } })])];
    for (let i = 0; rows.length < 2300; i++) rows.push(row(rows.length + 1, [note(`Заметка ${i % 50}`)]));
    rows.push(filing(5000, 'm1', [file('character', { name: 'Поздний', description: 'Пришёл последним.' })], ['m0', 'm1']));
    const opts: FoldOptions = { pathSet: new Set(PATH), path: PATH, touched: new Map() };
    const plain = (v: CompendiumView) => ({ entries: [...v.entries], issues: v.issues, effects: v.effects, rev: v.rev });
    // The shorter fold keeps checkpoints (at 2 048 rows and at its end) with the edit still held.
    const short = foldCompendium(rows.slice(0, 2300), opts);
    expect(short.issues).toEqual([{ seq: 1, op: 0, why: 'not_found' }]);
    const resumed = foldCompendium(rows, opts);
    expect(resumed.entries.get('character:поздний')!.data.role).toBe('ждёт');
    expect(resumed.issues).toEqual([]);
    expect(plain(resumed)).toEqual(plain(foldCompendium(structuredClone(rows), opts)));
    // And back: the shorter fold resumes from its checkpoint and reports the held op again.
    expect(plain(foldCompendium(rows.slice(0, 2300), opts))).toEqual(plain(short));
  });
});

describe('TaskState (G-2): range of the row the status is about; stale for a reverted key', () => {
  const PATH = ['g0000001', 'u0000001', 'a0000001', 'u0000002', 'a0000002'];
  const fold = (rows: MemEntry[], touched: Record<string, number> = {}): CompendiumView =>
    foldCompendium(rows, { pathSet: new Set(PATH), path: PATH, touched: new Map(Object.entries(touched)) });
  const filed = (seq: number, range: [string, string] = ['u0000001', 'a0000001']) => filing(seq, 'a0000001', [MIRA()], range);
  const revert = (seq: number) => row(seq, [{ op: 'revert', key: 'file:a0000001' }]);

  test('reverted, its row fresh: no flag, the reverted row\'s range (covered: the lane files nothing)', () => {
    expect(fold([filed(3), revert(5)]).tasks.get('file:a0000001')).toEqual({ seq: 5, status: 'reverted', range: ['u0000001', 'a0000001'] });
  });

  test('reverted, its row stale since: stale true (staleness re-writes even after an undo, D-74)', () => {
    const v = fold([filed(3), revert(5)], { u0000001: 7 });
    expect(v.tasks.get('file:a0000001')).toEqual({ seq: 5, status: 'reverted', stale: true, range: ['u0000001', 'a0000001'] });
    expect(v.entries.size).toBe(0);
    // Touched before the row: still fresh.
    expect(fold([filed(3), revert(5)], { u0000001: 2 }).tasks.get('file:a0000001')).not.toHaveProperty('stale');
  });

  test('the reverted row is the newest row of the key before the revert; its range is reported', () => {
    const v = fold([filed(3, ['a0000001', 'a0000001']), filed(4, ['u0000001', 'a0000001']), revert(5)], { u0000001: 6 });
    expect(v.tasks.get('file:a0000001')).toEqual({ seq: 5, status: 'reverted', stale: true, range: ['u0000001', 'a0000001'] });
    // The older row is fresh (its range misses u0000001), but the revert closed the key: nothing applies.
    expect(v.entries.size).toBe(0);
  });

  test('a stale row newer than the revert (a refile after the undo) re-opened the key: the status is about it', () => {
    const v = fold([filed(3, ['a0000001', 'a0000001']), revert(5), filed(7, ['u0000001', 'a0000001'])], { u0000001: 8 });
    expect(v.tasks.get('file:a0000001')).toEqual({ seq: 7, status: 'stale', range: ['u0000001', 'a0000001'] });
    expect(v.entries.size).toBe(0);
    // Fresh, it applies.
    expect(fold([filed(3), revert(5), filed(7)]).tasks.get('file:a0000001')).toEqual({ seq: 7, status: 'applied', range: ['u0000001', 'a0000001'] });
  });

  test('applied: the applied row\'s range, not a newer stale row\'s; stale: the newest row\'s', () => {
    const older = filed(3, ['a0000001', 'a0000001']);
    const newer = filed(7, ['u0000001', 'a0000001']);
    expect(fold([older, newer], { u0000001: 8 }).tasks.get('file:a0000001')).toEqual({ seq: 3, status: 'applied', range: ['a0000001', 'a0000001'] });
    expect(fold([older, newer], { a0000001: 8 }).tasks.get('file:a0000001')).toEqual({ seq: 7, status: 'stale', range: ['u0000001', 'a0000001'] });
  });

  test('a revert of a key never filed: reverted, no range, no flag; a historian key the same way as a filing key', () => {
    expect(fold([row(2, [{ op: 'revert', key: 'hist:x-y' }])]).tasks.get('hist:x-y')).toEqual({ seq: 2, status: 'reverted' });
    const h = hist(3, 'u0000001', 'a0000002', [file('summary', { title: 'Итог', summary: 'Всё.' })]);
    const v = fold([h, row(4, [{ op: 'revert', key: 'hist:u0000001-a0000002' }])], { u0000002: 5 });
    expect(v.tasks.get('hist:u0000001-a0000002')).toEqual({ seq: 4, status: 'reverted', stale: true, range: ['u0000001', 'a0000002'] });
  });
});

describe('TreeIndex.jobs (D-171)', () => {
  const job = (key: string, state: JobEntry['state'], attempt: number, more: Partial<JobEntry> = {}): EntryInput =>
    ({ t: 'job', ts: TS, job: `j_0000000${attempt}`, key, task: key.startsWith('hist:') ? 'hist' : 'file', on: 'a0000001', state, attempt, ...more }) as EntryInput;

  test('job rows by task key, each list in seq order (begin, failed, retry); not part of the tree or the version', () => {
    const entries = seqd([
      ...CHAT,
      job('file:a0000001', 'begin', 1),
      job('file:a0000001', 'failed', 1, { code: 'timeout' }),
      job('hist:g0000001-a0000001', 'begin', 1),
      job('file:a0000001', 'retry', 1),
      job('file:a0000001', 'begin', 2),
      fileRow('a0000001', ['u0000001', 'a0000001'], [MIRA()]),
    ]);
    const tree = buildTree(entries);
    expect([...tree.jobs.keys()]).toEqual(['file:a0000001', 'hist:g0000001-a0000001']);
    expect(tree.jobs.get('file:a0000001')!.map((j) => [j.seq, j.state, j.attempt])).toEqual([
      [6, 'begin', 1],
      [7, 'failed', 1],
      [9, 'retry', 1],
      [10, 'begin', 2],
    ]);
    expect(tree.jobs.get('file:a0000001')![1]!.code).toBe('timeout');
    // The version is the last msg/edit/hide/head entry's seq; job and mem rows do not move it.
    expect(tree.version).toBe(5);
    expect(buildTree(seqd(CHAT)).jobs.size).toBe(0);
  });

  test('entries out of seq order are indexed in seq order; a view folded at another leaf keeps the index', () => {
    const entries = seqd([...CHAT, job('file:a0000001', 'begin', 1), job('file:a0000001', 'failed', 1)]);
    const shuffled: Entry[] = [entries[6]!, ...entries.slice(0, 6)];
    expect(buildTree(shuffled).jobs.get('file:a0000001')!.map((j) => j.seq)).toEqual([6, 7]);
    const tree = buildTree(entries);
    expect(foldViewAt(makeHeader(), tree, 'u0000001').compendium.tasks.size).toBe(0);
    expect({ ...tree, head: 'u0000001' }.jobs).toBe(tree.jobs);
  });
});
