// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-184 (.notes/m5b-decisions.md, review lane#2): the fold applies rows in story order, by (anchor,
// kind, seq) (K, order#2: agent rows before human rows at one anchor). An agent row's anchor is the
// path position of its `on`; a human row's the position of the newest path message older than it (0
// when none). A re-write of an old answer (staleness, refile, a recovered begin) applies where its
// answer is, never after later answers' rows; a person's edit applies after every pass of the messages
// up to the one it followed. Checkpoints resume on the sorted order's prefix: a resumed fold equals a
// fold from the seed for any order the rows come in.
import { describe, expect, test } from 'bun:test';
import { foldCompendium, type FoldOptions } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { file, filing, hist, note, row } from '../memory/fixtures.ts';
import { lantern } from '../memory/kit.ts';

/** g → u1 → a1 → u2 → a2 → u3 → a3, message seqs 1…7 (rows come after them unless said). */
const PATH = ['g0000001', 'u0000001', 'a0000001', 'u0000002', 'a0000002', 'u0000003', 'a0000003'];
const MSGS = new Map(PATH.map((id, i) => [id, { seq: i + 1 }]));
const opts = (touched: Record<string, number> = {}, more: Partial<FoldOptions> = {}): FoldOptions => ({
  pathSet: new Set(PATH),
  path: PATH,
  touched: new Map(Object.entries(touched)),
  msgs: MSGS,
  ...more,
});
const frol = (status: string, more: Record<string, unknown> = {}): MemOp => file('character', { name: 'Фрол', current_state: { status }, ...more });
const stateOf = (c: CompendiumView): unknown => (c.entries.get('character:фрол')!.data.current_state as { status: string }).status;
const edit = (ref: string, set: Record<string, unknown>): MemOp => ({ op: 'edit', ref, set });

describe('D-184: agent rows apply where their answer is in the story', () => {
  test('a stale pass of an old answer, written again later, does not roll back what later answers filed (review lane#2)', () => {
    // a1 files Фрол alive (seq 10), a2 files him dead (seq 17); a typo fix in u1 (seq 18) makes a1's pass
    // stale and the lane writes it again (seq 20): the model says alive again.
    const rows = [
      filing(10, 'a0000001', [frol('alive')], ['u0000001', 'a0000001']),
      filing(17, 'a0000002', [frol('dead')], ['u0000002', 'a0000002']),
      filing(20, 'a0000001', [frol('alive')], ['u0000001', 'a0000001']),
    ];
    const c = foldCompendium(rows, opts({ u0000001: 18 }));
    expect(stateOf(c)).toBe('dead');
    expect(c.tasks.get('file:a0000001')).toEqual({ seq: 20, status: 'applied', range: ['u0000001', 'a0000001'] });
    // The re-written row applied first (it re-created the entry), a2's merged into it after.
    expect(c.effects.map((x) => [x.seq, x.change])).toEqual([
      [20, 'created'],
      [17, 'merged'],
    ]);
    expect(c.lastSeq).toBe(20);
    expect(c.entries.get('character:фрол')!.prov.lastSeq).toBe(17);
    // Input order never matters.
    expect(foldCompendium([rows[2]!, rows[0]!, rows[1]!], opts({ u0000001: 18 })).entries).toEqual(c.entries);
  });

  test('a refile (/memory refile) of an old answer: the same, the new pass applies at its answer', () => {
    const rows = [
      filing(10, 'a0000001', [frol('alive', { traits: ['хромает'] })]),
      filing(17, 'a0000002', [frol('dead')]),
      filing(20, 'a0000001', [frol('alive', { traits: ['хромает', 'молчит'] })]),
    ];
    const c = foldCompendium(rows, opts());
    expect(c.entries.get('character:фрол')!.data).toMatchObject({ current_state: { status: 'dead' }, traits: ['хромает', 'молчит'] });
  });

  test('a historian window written again after a hide keeps the newer window\'s arc overview; lastSeq names the row whose text it shows', () => {
    const arc = (overview: string): MemOp => ({ op: 'arc', plot: 'Свет маяка', overview });
    const summary = (title: string): MemOp => file('summary', { title, summary: `${title}.`, parent_plot: 'Свет маяка' });
    const rows = [
      hist(20, 'g0000001', 'a0000002', [summary('Фонарь зажжён'), arc('V1: маяк светит.')]),
      hist(32, 'u0000003', 'a0000003', [summary('Фонарь погас'), arc('V2: маяк погас навсегда.')]),
      hist(35, 'g0000001', 'a0000002', [summary('Фонарь зажжён'), arc('V1: маяк светит.')]),
    ];
    const c = foldCompendium(rows, opts({ u0000002: 33 }));
    const overview = c.entries.get('arc:свет маяка')!;
    expect(overview.content).toBe('V2: маяк погас навсегда.');
    expect(overview.prov.lastSeq).toBe(32);
    // Handles follow creation (K, order#3): the window written again (seq 35) re-created its summary after a3's (32).
    expect([...c.entries.keys()].filter((k) => k.startsWith('summary:'))).toEqual(['summary:a0000003.0', 'summary:a0000002.0']);
  });

  test('the rows of one answer keep seq order; rows of answers in order fold as before (seq order)', () => {
    const rows = [filing(10, 'a0000001', [frol('alive')]), hist(11, 'g0000001', 'a0000001', [file('summary', { title: 'Начало', summary: 'Фрол жив.' })]), filing(12, 'a0000002', [frol('dead')])];
    const c = foldCompendium(rows, opts());
    expect(c.effects.map((x) => x.seq)).toEqual([10, 11, 12]);
    expect(c.rev).toBe(foldCompendium(structuredClone(rows), { ...opts(), msgs: undefined }).rev);
    expect(c.rev).toBe(foldCompendium(structuredClone(rows), { pathSet: new Set(PATH) }).rev);
  });
});

describe('D-184: a human row applies after the messages older than it', () => {
  // u3 and a3 come after the person's rows: g…a2 have seqs 1…5, u3 10, a3 11.
  const msgs = new Map(PATH.map((id, i) => [id, { seq: i < 5 ? i + 1 : i + 5 }]));
  const o = (touched: Record<string, number> = {}): FoldOptions => opts(touched, { msgs });
  // While the head is a2 the person files Фрол by hand (seq 6) and edits him (seq 8): both follow a2.
  const byHand = row(6, [file('character', { name: 'Фрол', description: 'Смотритель маяка.' })]);
  const person = row(8, [edit('character:фрол', { current_state: { status: 'спасён' } })]);

  test('a pass of an earlier answer written after the edit (lagging, or written again) applies before it: the edit wins', () => {
    const lagging = filing(9, 'a0000001', [frol('при смерти')]);
    const c = foldCompendium([byHand, person, lagging], o());
    expect(stateOf(c)).toBe('спасён');
    expect(c.effects.map((x) => [x.seq, x.change])).toEqual([
      [9, 'created'],
      [6, 'merged'],
      [8, 'edited'],
    ]);
    // In seq order (no path) the pass would overwrite the edit.
    expect(stateOf(foldCompendium([byHand, person, lagging], { pathSet: new Set(PATH) }))).toBe('при смерти');
  });

  test('K (order#2): a pass of the answer the edit follows, written after it, applies before it; a later answer\'s after it', () => {
    // The edit was made while a2 was the head: every pass of a2 (lagging, re-written) comes first.
    expect(stateOf(foldCompendium([byHand, person, filing(9, 'a0000002', [frol('при смерти')])], o()))).toBe('спасён');
    expect(stateOf(foldCompendium([byHand, person, filing(12, 'a0000003', [frol('погиб')])], o()))).toBe('погиб');
  });

  test('without msgs a human row anchors at the newest position a row up to it is bound to; without a path, seq order', () => {
    // a1's pass (seq 7) and its refile (seq 9) around the edit.
    const rows = [byHand, filing(7, 'a0000001', [frol('ранен')]), person, filing(9, 'a0000001', [frol('при смерти')])];
    expect(stateOf(foldCompendium(rows, o()))).toBe('спасён');
    // The pass at seq 7 says the edit follows a1, no more: the refile of a1 (seq 9) shares that place and,
    // an agent row, applies before the edit (K, order#2).
    expect(stateOf(foldCompendium(rows, { ...o(), msgs: undefined }))).toBe('спасён');
    expect(stateOf(foldCompendium(rows, { pathSet: new Set(PATH) }))).toBe('при смерти');
  });

  test('a human row older than every path message anchors at 0, before every pass', () => {
    const late = new Map(PATH.map((id, i) => [id, { seq: 10 + i }]));
    const rows = [row(40, [note('Маяк', 'Третий.')]), filing(30, 'a0000001', [note('Маяк', 'Второй.')]), row(5, [note('Маяк', 'Первый.')])];
    const c = foldCompendium(rows, opts({}, { msgs: late }));
    expect([...c.entries.values()].map((e) => e.content)).toEqual(['Первый.', 'Второй.', 'Третий.']);
  });

  test('a refile of an old answer applies before the person\'s rows: their ops meet the entries at once (no hold, D-179)', () => {
    const lighthouse = file('location', { name: 'Маяк', description: 'Башня на мысе.' });
    const rows = [
      filing(10, 'a0000001', [file('character', { name: 'Мира', description: 'Фонарщица.' }), lighthouse]),
      row(11, [edit('character:мира', { role: 'ally' })]),
      row(12, [{ op: 'retire', ref: 'location:маяк', reason: 'сгорел' }]),
      row(13, [{ op: 'revert', key: 'file:a0000001' }], { on: 'a0000001' }),
      filing(14, 'a0000001', [file('character', { name: 'Мира', description: 'Фонарщица, ученица.' }), lighthouse]),
    ];
    const c = foldCompendium(rows, opts());
    expect(c.entries.get('character:мира')!.data).toMatchObject({ description: 'Фонарщица, ученица.', role: 'ally' });
    expect(c.entries.get('location:маяк')!.retired).toEqual({ reason: 'сгорел' });
    expect(c.issues).toEqual([]);
    expect(c.effects.map((x) => [x.seq, x.op, x.key, x.change])).toEqual([
      [14, 0, 'character:мира', 'created'],
      [14, 1, 'location:маяк', 'created'],
      [11, 0, 'character:мира', 'edited'],
      [12, 0, 'location:маяк', 'retired'],
    ]);
  });
});

// ---- checkpoints on the sorted order ---------------------------------------------------------------

/** A seeded PRNG (mulberry32): the property runs are the same on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['Фрол', 'Мира', 'Тихон', 'Уля'];
const WORDS = ['маяк', 'свет', 'море', 'фонарь', 'ночь', 'клятва', 'берег', 'ветер', 'соль', 'ключ'];

interface World {
  rows: MemEntry[];
  path: string[];
  msgs: Map<string, { seq: number }>;
  touched: Map<string, number>;
}

/** A random session: a path whose messages are every 10th seq, rows of every kind at other seqs, in shuffled order. */
function randomWorld(rnd: () => number): World {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const n = 6 + Math.floor(rnd() * 30);
  const path = Array.from({ length: n }, (_, i) => `m${String(i).padStart(7, '0')}`);
  const msgs = new Map(path.map((id, i) => [id, { seq: (i + 1) * 10 }]));
  const fact = (): string => `${pick(NAMES)} ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}${rnd() < 0.3 ? ` ${pick(WORDS)}` : ''}`;
  const rows: MemEntry[] = [];
  const used = new Set<number>();
  const count = 10 + Math.floor(rnd() * 70);
  for (let k = 0; k < count; k++) {
    let seq: number;
    do seq = 1 + Math.floor(rnd() * (n * 10 + 40));
    while (seq % 10 === 0 || used.has(seq));
    used.add(seq);
    // Bound to a message already written (its seq below the row's), or to none.
    const older = path.filter((id) => msgs.get(id)!.seq < seq);
    const kind = rnd();
    if (kind < 0.55 && older.length > 1) {
      const at = older.length - 1 - Math.floor(rnd() * Math.min(older.length - 1, 4));
      const on = older[at]!;
      const ops: MemOp[] = [file('character', { name: pick(NAMES), minor_facts: [fact(), fact()], current_state: { status: pick(WORDS) } })];
      if (rnd() < 0.3) ops.push({ op: 'arc', plot: pick(['Свет', 'Буря']), overview: fact() });
      if (rnd() < 0.2) ops.push(file('summary', { title: fact(), summary: fact() }));
      const key = rnd() < 0.8 ? `file:${on}` : `hist:${older[at - 1]}-${on}`;
      rows.push(row(seq, ops, { key, on, by: key.startsWith('file:') ? 'filing' : 'historian', range: [older[at - 1]!, on] }));
    } else if (kind < 0.75) {
      const ref = `character:${pick(NAMES).toLowerCase()}`;
      const op: MemOp = rnd() < 0.6 ? edit(ref, { role: pick(WORDS) }) : rnd() < 0.5 ? { op: 'retire', ref, reason: 'r' } : { op: 'restore', ref };
      rows.push(row(seq, [op]));
    } else if (kind < 0.85) {
      rows.push(row(seq, [note(pick(WORDS), fact())]));
    } else if (kind < 0.93 && older.length > 1) {
      rows.push(row(seq, [{ op: 'revert', key: `file:${pick(older)}` }]));
    } else {
      rows.push(row(seq, [file('character', { name: pick(NAMES), minor_facts: [fact()] })]));
    }
  }
  const touched = new Map<string, number>();
  for (const id of path) if (rnd() < 0.15) touched.set(id, msgs.get(id)!.seq + Math.floor(rnd() * 200));
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  return { rows, path, msgs, touched };
}

const plain = (v: CompendiumView) => ({ entries: [...v.entries], rev: v.rev, lastSeq: v.lastSeq, issues: v.issues, tasks: [...v.tasks], effects: v.effects });
/** A fold from the seed: fresh row objects never meet a checkpoint. */
const fromScratch = (rows: readonly MemEntry[], o: FoldOptions) => plain(foldCompendium(structuredClone(rows) as MemEntry[], o));

describe('D-184: checkpoints resume on the story order\'s prefix', () => {
  const seed = librarySeed([lantern()], { enabled: true });

  test('random sessions in random row orders: every resumed fold equals a fold from the seed (200 sessions)', () => {
    const rnd = prng(184);
    for (let trial = 0; trial < 200; trial++) {
      const w = randomWorld(rnd);
      const withMsgs = rnd() < 0.8;
      const o = (path: string[] = w.path): FoldOptions => ({
        pathSet: new Set(path),
        path,
        touched: w.touched,
        library: trial % 3 === 0 ? seed : undefined,
        ...(withMsgs ? { msgs: w.msgs } : {}),
      });
      // The views a session folds one after another: the rows as they were written (a growing prefix by
      // seq, the journal's order), the head moving on, a view at an earlier leaf, then all of them.
      const bySeq = [...w.rows].sort((a, b) => a.seq - b.seq);
      const cuts = [Math.floor(bySeq.length / 3), Math.floor((2 * bySeq.length) / 3), bySeq.length - 1];
      for (const cut of cuts) {
        const part = bySeq.slice(0, cut);
        expect(plain(foldCompendium(part, o()))).toEqual(fromScratch(part, o()));
      }
      const short = w.path.slice(0, Math.max(2, Math.floor(w.path.length / 2)));
      expect(plain(foldCompendium(w.rows, o(short)))).toEqual(fromScratch(w.rows, o(short)));
      const all = foldCompendium(w.rows, o());
      expect(plain(all)).toEqual(fromScratch(w.rows, o()));
      // Again, and with one row fewer (a revert's undo dropped, an older checkpoint): still the same.
      expect(plain(foldCompendium(w.rows, o()))).toEqual(plain(all));
      const fewer = w.rows.slice(1);
      expect(plain(foldCompendium(fewer, o()))).toEqual(fromScratch(fewer, o()));
    }
  });

  test('a long session crosses the 2 048-row checkpoint; re-written passes of an early and a late answer: resumed equals from scratch', () => {
    const path = Array.from({ length: 1200 }, (_, i) => `m${String(i).padStart(7, '0')}`);
    const msgs = new Map(path.map((id, i) => [id, { seq: i * 10 }]));
    const rows: MemEntry[] = [];
    for (let i = 2; i < path.length; i += 2) {
      // Each answer's pass and the person's rows right after it (the same place in the story).
      rows.push(filing(i * 10 + 1, path[i]!, [file('character', { name: NAMES[i % 4]!, minor_facts: [`${WORDS[i % 10]} ${WORDS[(i * 3) % 10]} ${WORDS[(i * 7) % 10]} ${i}`] })], [path[i - 1]!, path[i]!]));
      rows.push(row(i * 10 + 2, [edit(`character:${NAMES[(i + 1) % 4]!.toLowerCase()}`, { role: `r${i}` })]));
      rows.push(row(i * 10 + 3, [note(`Заметка ${i % 40}`)]));
      rows.push(row(i * 10 + 4, [note(`Лист ${i % 30}`)]));
    }
    const o: FoldOptions = { pathSet: new Set(path), path, touched: new Map(), msgs };
    const first = foldCompendium(rows, o);
    expect(rows.length).toBeGreaterThan(2048);
    expect(plain(first)).toEqual(fromScratch(rows, o));
    // The lane writes passes again (the answers' user messages were edited): each applies at its answer.
    const rewrite = (i: number, seq: number): MemEntry => filing(seq, path[i]!, [file('character', { name: 'Мира', minor_facts: [`ключ от маяка у Миры ${i}`] })], [path[i - 1]!, path[i]!]);
    for (const i of [1100, 4]) {
      const touched = new Map([[path[i - 1]!, 50_000]]);
      const again = [...rows, rewrite(i, 60_000)];
      const at = { ...o, touched };
      const resumed = foldCompendium(again, at);
      expect(plain(resumed)).toEqual(fromScratch(again, at));
      expect(resumed.effects.findIndex((x) => x.seq === 60_000)).toBeLessThan(resumed.effects.findIndex((x) => x.seq === (i + 2) * 10 + 1));
    }
    expect(plain(foldCompendium(rows, o))).toEqual(plain(first));
  });
});
