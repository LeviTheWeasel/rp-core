// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The lead's rulings after the final check (.notes/m5b-decisions.md section K), at the fold:
// - order#1: rowOrder / foldStaged — a pass stages against exactly the rows the fold applies before it;
// - order#2: rows sort by (anchor, kind, seq), agent rows before human rows at one anchor;
// - order#3: handles C<n> count session entries by the row seq (then op index) that created them;
// - order#4: a trial fold (a verb's dry run) keeps no checkpoint, and the frontier's survives many verbs;
// - arcs follow renamed plots: an arc op finds its plot and its arc by any name, alias or former name.
import { describe, expect, test } from 'bun:test';
import { compareRowOrder, findMatch, foldCompendium, foldStaged, plotArc, rowOrder, type FoldOptions } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import { noteRefs } from '../../src/agents/compendium/notes.ts';
import { entryRefs, refOf, resolveEntryRef } from '../../src/agents/compendium/refs.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { file, filing, hist, note, row } from '../memory/fixtures.ts';
import { lantern } from '../memory/kit.ts';

/** g → u1 → a1 → u2 → a2 → u3 → a3; a1's pass (seq 7) lands after u3, a3 is seq 8 (wait 1). */
const PATH = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
const SEQS: Record<string, number> = { g: 1, u1: 2, a1: 3, u2: 4, a2: 5, u3: 6, a3: 8 };
const MSGS = new Map(Object.entries(SEQS).map(([id, seq]) => [id, { seq }]));
const opts = (path: readonly string[] = PATH, more: Partial<FoldOptions> = {}): FoldOptions & { path: readonly string[] } => ({
  pathSet: new Set(path),
  path,
  touched: new Map(),
  msgs: MSGS,
  ...more,
});
const edit = (ref: string, set: Record<string, unknown>): MemOp => ({ op: 'edit', ref, set });
const char = (name: string, more: Record<string, unknown> = {}): MemOp => file('character', { name, ...more });
const live = (c: CompendiumView, type: string) => [...c.entries.values()].filter((e) => e.type === type && e.retired === undefined);
const handles = (c: CompendiumView): string[] => entryRefs(c).map((r) => `${r.ref}=${r.entry.name}`);

describe('K order#1: the lane stages against exactly what the fold applies before its pass', () => {
  // a1's pass filed Фрол; while reading a3 (before a2's pass lands) the person renames him.
  const filed = filing(7, 'a1', [char('Фрол', { description: 'Смотритель.' })], ['u1', 'a1']);
  const rename = row(9, [edit('character:фрол', { name: 'Фрол Седой' })]);

  test('rowOrder: a pass is placed at its answer, before the person\'s rows there; a person\'s row after the newest older message', () => {
    expect(rowOrder({ key: 'file:a2', on: 'a2', seq: Infinity }, PATH, MSGS)).toEqual({ anchor: 5, kind: 0, seq: Infinity });
    expect(rowOrder(rename, PATH, MSGS)).toEqual({ anchor: 7, kind: 1, seq: 9 });
    expect(rowOrder(row(4.5, []), PATH, MSGS)).toEqual({ anchor: 4, kind: 1, seq: 4.5 });
    // Without msgs a row written now follows every message.
    expect(rowOrder(row(99, []), PATH)).toEqual({ anchor: 7, kind: 1, seq: 99 });
    expect(compareRowOrder({ anchor: 5, kind: 0, seq: 50 }, { anchor: 5, kind: 1, seq: 6 })).toBeLessThan(0);
    expect(compareRowOrder({ anchor: 4, kind: 1, seq: 50 }, { anchor: 5, kind: 0, seq: 6 })).toBeLessThan(0);
  });

  test('a rename made while a3 is the head is not in a2\'s stage: the pass files the name it sees, one entry results (final order#1)', () => {
    const stage = foldStaged([filed, rename], opts(), { key: 'file:a2', on: 'a2' });
    expect(stage.entries.get('character:фрол')!.name).toBe('Фрол');
    expect(findMatch(stage.entries.values(), 'character', ['Фрол'])?.key).toBe('character:фрол');
    // The pass lands with the name its snapshot showed; the rename applies after it.
    const pass = filing(10, 'a2', [char('Фрол', { current_state: { status: 'ранен' } })], ['u2', 'a2']);
    const view = foldCompendium([filed, rename, pass], opts());
    expect(live(view, 'character').map((e) => [e.key, e.name])).toEqual([['character:фрол', 'Фрол Седой']]);
    expect(view.entries.get('character:фрол')!.data).toMatchObject({ description: 'Смотритель.', current_state: { status: 'ранен' } });
    expect(view.issues).toEqual([]);
  });

  test('an entry hand-filed while a3 is the head is not in a2\'s stage either (the worldbuilding case)', () => {
    const byHand = row(9, [file('worldbuilding', { topic: 'Клятва фонарщиков', category: 'обычай', description: 'Её дают у огня.' })]);
    const stage = foldStaged([filed, byHand], opts(), { key: 'file:a2', on: 'a2' });
    expect(live(stage, 'worldbuilding')).toEqual([]);
    expect(live(foldCompendium([filed, byHand], opts()), 'worldbuilding')).toHaveLength(1);
  });

  test('the stage leaves out the key\'s own rows and keeps the other passes of the answer; rows of later answers stay out', () => {
    const own = filing(10, 'a2', [char('Мира')], ['u2', 'a2']);
    const story = hist(11, 'g', 'a2', [file('summary', { title: 'Начало', summary: 'Фрол на маяке.' })]);
    const later = filing(12, 'a3', [char('Тихон')], ['u3', 'a3']);
    const stage = foldStaged([filed, rename, own, story, later], opts(), { key: 'file:a2', on: 'a2' });
    expect([...stage.entries.keys()]).toEqual(['character:фрол', 'summary:a2.0']);
    expect(stage.entries.get('character:фрол')!.name).toBe('Фрол');
  });

  test('random sessions: the stage\'s effects are exactly the full fold\'s effects before the pass\'s first one (150 sessions)', () => {
    const rnd = prng(1841);
    for (let trial = 0; trial < 150; trial++) {
      const w = randomWorld(rnd);
      const o = { pathSet: new Set(w.path), path: w.path, touched: w.touched, msgs: w.msgs };
      const on = w.path[1 + Math.floor(rnd() * (w.path.length - 1))]!;
      const seq = Math.max(...w.rows.map((r) => r.seq), ...[...w.msgs.values()].map((m) => m.seq)) + 1;
      const pass = row(seq, [note(`Новое ${trial}`, 'Текст.')], { key: 'file:new', on, by: 'filing' });
      const full = foldCompendium([...w.rows, pass], o);
      const stage = foldStaged(w.rows, o, { key: 'file:new', on });
      const at = full.effects.findIndex((x) => x.seq === seq);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(stage.effects).toEqual(full.effects.slice(0, at));
    }
  });
});

describe('K order#2: at one anchor agent rows apply before human rows', () => {
  const filed = filing(6, 'a1', [char('Фрол', { current_state: { status: 'ранен' } })], ['u1', 'a1']);
  const status = (c: CompendiumView): unknown => (c.entries.get('character:фрол')!.data.current_state as { status: string }).status;
  const msgs = (ids: Record<string, number>) => new Map(Object.entries(ids).map(([id, seq]) => [id, { seq }]));

  test('(A) an edit made while a2 is the head survives a2\'s lagging pass; (B) one made after a3 does too (same ops, any timing)', () => {
    const at = msgs({ g: 1, u1: 2, a1: 3, u2: 4, a2: 5, u3: 8, a3: 9 });
    const a = foldCompendium([filed, row(7, [edit('character:фрол', { current_state: { status: 'спасён' } })]), filing(10, 'a2', [char('Фрол', { current_state: { status: 'при смерти' } })], ['u2', 'a2'])], opts(PATH, { msgs: at }));
    expect(status(a)).toBe('спасён');
    const b = foldCompendium([filed, row(10, [edit('character:фрол', { current_state: { status: 'спасён' } })]), filing(11, 'a2', [char('Фрол', { current_state: { status: 'при смерти' } })], ['u2', 'a2'])], opts(PATH, { msgs: at }));
    expect(status(b)).toBe('спасён');
  });

  test('(C) wait 0: a2\'s pass re-written after a typo fix in a2 does not overwrite the correction made after that pass', () => {
    const path = PATH.slice(0, 5);
    const rows = [
      filing(3.5, 'a1', [char('Фрол', { description: 'Смотритель.' })], ['u1', 'a1']),
      filing(6, 'a2', [char('Фрол', { current_state: { status: 'ранен' } })], ['u2', 'a2']),
      row(7, [edit('character:фрол', { current_state: { status: 'спасён' } })]),
      filing(9, 'a2', [char('Фрол', { current_state: { status: 'при смерти' } })], ['u2', 'a2']),
    ];
    const c = foldCompendium(rows, opts(path, { touched: new Map([['a2', 8]]), msgs: msgs({ g: 1, u1: 2, a1: 3, u2: 4, a2: 5 }) }));
    expect(c.tasks.get('file:a2')).toEqual({ seq: 9, status: 'applied', range: ['u2', 'a2'] });
    expect(status(c)).toBe('спасён');
  });

  test('(D) one log, two branches: the edit made at a3, a2\'s lagging pass — the same answer on both', () => {
    const main = ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
    const other = ['g', 'u1', 'a1', 'u2', 'a2', 'u3b', 'a3b'];
    const at = msgs({ g: 1, u1: 2, a1: 3, u2: 4, a2: 5, u3: 7, a3: 8, u3b: 12, a3b: 13 });
    const rows = [filed, row(10, [edit('character:фрол', { current_state: { status: 'спасён' } })]), filing(11, 'a2', [char('Фрол', { current_state: { status: 'при смерти' } })], ['u2', 'a2'])];
    expect(status(foldCompendium(rows, opts(main, { msgs: at })))).toBe('спасён');
    expect(status(foldCompendium(rows, opts(other, { msgs: at })))).toBe('спасён');
  });

  test('a historian window ending at the answer the person edited an arc after does not wipe the edit', () => {
    const rows = [
      hist(6, 'g', 'a1', [file('summary', { title: 'Свет', summary: 'Маяк горит.', parent_plot: 'Маяк' }), { op: 'arc', plot: 'Маяк', overview: 'V1.' }]),
      row(7, [edit('arc:маяк', { content: 'Правка человека.' })]),
      hist(9, 'u2', 'a2', [file('summary', { title: 'Тьма', summary: 'Маяк погас.', parent_plot: 'Маяк' }), { op: 'arc', plot: 'Маяк', overview: 'V2.' }]),
    ];
    // The arc edit was made while a2 was the head (a2 = 5 < 7 < u3 = 8): the window ending at a2 applies first.
    const c = foldCompendium(rows, opts(PATH, { msgs: msgs({ g: 1, u1: 2, a1: 3, u2: 4, a2: 5, u3: 8, a3: 10 }) }));
    expect(c.entries.get('arc:маяк')!.content).toBe('Правка человека.');
  });

  test('D-179 still holds an op whose entry a later answer\'s pass creates (the pass that had it was undone)', () => {
    const rows = [
      filing(6, 'a1', [char('Мира', { description: 'Фонарщица.' })], ['u1', 'a1']),
      row(7, [edit('character:мира', { role: 'ally' })]),
      row(8, [{ op: 'revert', key: 'file:a1' }], { on: 'a1' }),
      filing(10, 'a3', [char('Мира', { description: 'Фонарщица, ученица.' })], ['u3', 'a3']),
    ];
    const c = foldCompendium(rows, opts(PATH, { msgs: msgs({ g: 1, u1: 2, a1: 3, u2: 4, a2: 5, u3: 6, a3: 9 }) }));
    expect(c.entries.get('character:мира')!.data).toMatchObject({ description: 'Фонарщица, ученица.', role: 'ally' });
    expect(c.issues).toEqual([]);
    expect(c.effects.map((x) => [x.seq, x.change])).toEqual([
      [10, 'created'],
      [7, 'edited'],
    ]);
  });
});

describe('K order#3: handles count session entries by the row that created them', () => {
  const frol = filing(7, 'a1', [char('Фрол', { description: 'Смотритель.' })], ['u1', 'a1']);
  const key = row(9, [note('Ключ', 'Ключ у Миры.')]);
  const mira = filing(10, 'a2', [char('Мира', { description: 'Фонарщица.' })], ['u2', 'a2']);

  test('a lagging pass\'s new entry never takes the number of an entry the person made earlier (final order#3)', () => {
    expect(handles(foldCompendium([frol, key], opts()))).toEqual(['C1=Фрол', 'C2=Ключ']);
    const c = foldCompendium([frol, key, mira], opts());
    expect(handles(c)).toEqual(['C1=Фрол', 'C2=Ключ', 'C3=Мира']);
    expect(refOf(c, 'note:ключ')).toBe('C2');
    expect(resolveEntryRef(c, 'C2')?.key).toBe('note:ключ');
    expect(noteRefs(c).map((r) => r.ref)).toEqual(['C2']);
    // The fold still applied the pass before the note (story order): only the numbering changed.
    expect(c.effects.map((x) => x.seq)).toEqual([7, 10, 9]);
  });

  test('a hand-written C<n> in a row resolves in that numbering; a retired entry keeps its number', () => {
    const c = foldCompendium([frol, key, mira, row(11, [{ op: 'retire', ref: 'C2', reason: 'потерян' }])], opts());
    expect(c.entries.get('note:ключ')!.retired).toEqual({ reason: 'потерян' });
    expect(c.entries.get('character:мира')!.retired).toBeUndefined();
    expect(handles(c)).toEqual(['C1=Фрол', 'C2=Ключ', 'C3=Мира']);
  });

  test('library entries come first; a refile re-creates its entries under its own seq; one row\'s entries in op order', () => {
    const seed = librarySeed([lantern()], { enabled: true });
    const lib = seed.entries.length;
    const both = filing(12, 'a1', [char('Фрол', { description: 'Смотритель, старик.' }), char('Тихон')], ['u1', 'a1']);
    const c = foldCompendium([frol, key, mira, both], opts(PATH, { library: seed }));
    const refs = entryRefs(c);
    expect(refs.slice(0, lib).every((r) => r.entry.origin.kind === 'library')).toBe(true);
    expect(refs.slice(lib).map((r) => `${r.ref}=${r.entry.name}`)).toEqual([`C${lib + 1}=Ключ`, `C${lib + 2}=Мира`, `C${lib + 3}=Фрол`, `C${lib + 4}=Тихон`]);
  });
});

describe('K order#4: dry runs keep no checkpoint; the frontier\'s survives', () => {
  /** Passes of a0…a(n−1) (agent rows), each filing two characters and a place; path ids m…, message seqs 1, 11, 21… */
  function chat(n: number) {
    const path = Array.from({ length: 2 * n + 4 }, (_, i) => `m${String(i).padStart(7, '0')}`);
    const msgs = new Map(path.map((id, i) => [id, { seq: 1 + i * 10 }]));
    const pass = (k: number, seq: number): MemEntry => {
      const on = path[2 * k + 2]!;
      return filing(seq, on, [char('Фрол', { minor_facts: [`факт ${k}`] }), char('Мира', { minor_facts: [`дело ${k}`] }), file('location', { name: `Маяк ${k % 7}`, minor_facts: [`камень ${k}`] })], [path[2 * k + 1]!, on]);
    };
    const rows = Array.from({ length: n - 1 }, (_, k) => pass(k, 1 + (2 * k + 4) * 10 + 5));
    return { path, msgs, rows, pass };
  }

  test('a trial fold\'s state is never resumed from: the same rows folded for real apply the trial row again (final order#4)', () => {
    const { path, msgs, rows } = chat(12);
    const o: FoldOptions = { pathSet: new Set(path), path, touched: new Map(), msgs };
    foldCompendium(rows, o);
    const verb = row(100_000, [edit('character:мира', { role: 'ally' })]);
    const tried = foldCompendium([...rows, verb], { ...o, trial: true });
    const real = foldCompendium([...rows, verb], o);
    expect(real.entries.get('character:мира')!.data).toEqual(tried.entries.get('character:мира')!.data);
    // Not resumed from the trial's state (the edit made new data again) …
    expect(real.entries.get('character:мира')!.data).not.toBe(tried.entries.get('character:мира')!.data);
    // … but from the view's checkpoint, as the trial was: an entry no row touched shares its data.
    expect(real.entries.get('location:маяк 3')!.data).toBe(tried.entries.get('location:маяк 3')!.data);
  });

  test('many verbs, then a lagging pass: the fold resumes at the frontier, not from the seed (final order#4)', () => {
    const { path, msgs, rows, pass } = chat(60);
    const o: FoldOptions = { pathSet: new Set(path), path, touched: new Map(), msgs };
    const first = foldCompendium(rows, o);
    let cur = [...rows];
    let seq = 100_000;
    for (let i = 0; i < 9; i++) {
      // Each verb: the dry run with a trial row, then the view after the row is written.
      foldCompendium([...cur, row(seq + 1, [edit('character:мира', { role: `r${i}` })])], { ...o, trial: true });
      cur = [...cur, row(++seq, [edit('character:мира', { role: `r${i}` })])];
      foldCompendium(cur, o);
      // A view at an earlier leaf and a staging fold come in between too.
      foldCompendium(cur, { ...o, pathSet: new Set(path.slice(0, 40)), path: path.slice(0, 40) });
    }
    const late = pass(59, ++seq);
    const after = foldCompendium([...cur, late], o);
    // Resumed from the checkpoint the first view kept (the frontier): untouched entries share data.
    expect(after.entries.get('location:маяк 5')!.data).toBe(first.entries.get('location:маяк 5')!.data);
    expect(after.effects.findIndex((x) => x.seq === late.seq)).toBeLessThan(after.effects.findIndex((x) => x.seq === 100_001));
    const scratch = foldCompendium(structuredClone([...cur, late]), o);
    expect([...after.entries]).toEqual([...scratch.entries]);
    expect(after.effects).toEqual(scratch.effects);
  });
});

describe('K: arcs follow renamed plots', () => {
  const summary = (title: string, plot: string): MemOp => file('summary', { title, summary: `${title}.`, parent_plot: plot });
  const arc = (plot: string, overview: string): MemOp => ({ op: 'arc', plot, overview });
  const first = hist(6, 'g', 'a1', [summary('Огонь', 'Lantern'), arc('Lantern', 'Overview one.')]);
  // The person renames the plot while u3 is the head; the next window ends at a3.
  const renamed = row(7, [edit('plot:lantern', { name: 'The Harbour Lantern' })]);
  const arcs = (c: CompendiumView) => [...c.entries.values()].filter((e) => e.arc !== undefined && e.retired === undefined).map((e) => [e.key, e.arc, e.content]);

  test('an arc op naming the plot by its new name rewrites the one arc and renames it (final agents-cli)', () => {
    const c = foldCompendium([first, renamed, hist(9, 'u2', 'a3', [summary('Гавань', 'The Harbour Lantern'), arc('The Harbour Lantern', 'Overview two.')])], opts());
    expect(arcs(c)).toEqual([['arc:lantern', 'The Harbour Lantern', 'Overview two.']]);
    expect(c.entries.get('arc:lantern')!.name).toBe('The Harbour Lantern');
    expect(c.entries.get('arc:lantern')!.prov.lastSeq).toBe(9);
    expect(live(c, 'plot').map((e) => e.name)).toEqual(['The Harbour Lantern']);
    expect(c.issues).toEqual([]);
  });

  test('by its former name or an alias: the same arc, under the plot\'s current name', () => {
    const byFormer = foldCompendium([first, renamed, hist(9, 'u2', 'a3', [arc('Lantern', 'Overview two.')])], opts());
    expect(arcs(byFormer)).toEqual([['arc:lantern', 'The Harbour Lantern', 'Overview two.']]);
    const alias = row(8, [edit('plot:lantern', { aliases: ['Огонёк'] })]);
    const byAlias = foldCompendium([first, alias, hist(9, 'u2', 'a3', [arc('Огонёк', 'Overview three.')])], opts());
    expect(arcs(byAlias)).toEqual([['arc:lantern', 'Lantern', 'Overview three.']]);
  });

  test('plotArc finds, in a view, the arc an arc op of that plot rewrites (for the historian\'s no-op check)', () => {
    const view = foldCompendium([first, renamed], opts());
    expect(plotArc(view.entries.values(), 'The Harbour Lantern')?.key).toBe('arc:lantern');
    expect(plotArc(view.entries.values(), 'lantern')?.key).toBe('arc:lantern');
    expect(plotArc(view.entries.values(), 'Буря')).toBeUndefined();
    const rewritten = foldCompendium([first, renamed, hist(9, 'u2', 'a3', [arc('The Harbour Lantern', 'Overview two.')])], opts());
    expect(plotArc(rewritten.entries.values(), 'The Harbour Lantern')?.content).toBe('Overview two.');
  });

  test('a new arc of a plot named by an alias is keyed and named by the plot\'s name; another plot keeps its own arc', () => {
    const plot = row(2.5, [file('plot', { name: 'Свет маяка', aliases: ['Маяк'], status: 'active' })]);
    const c = foldCompendium([plot, hist(6, 'g', 'a1', [arc('Маяк', 'Обзор.'), arc('Буря', 'Шторм.')])], opts());
    expect(arcs(c)).toEqual([
      ['arc:свет маяка', 'Свет маяка', 'Обзор.'],
      ['arc:буря', 'Буря', 'Шторм.'],
    ]);
  });
});

// ---- random sessions (as test/fold-m5b/order.test.ts) ---------------------------------------------

/** A seeded PRNG (mulberry32). */
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
const WORDS = ['маяк', 'свет', 'море', 'фонарь', 'ночь', 'клятва', 'берег', 'ветер'];

/** A path whose messages are every 10th seq, rows of every kind at other seqs (agent rows bound to older messages). */
function randomWorld(rnd: () => number): { rows: MemEntry[]; path: string[]; msgs: Map<string, { seq: number }>; touched: Map<string, number> } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const n = 6 + Math.floor(rnd() * 20);
  const path = Array.from({ length: n }, (_, i) => `m${String(i).padStart(7, '0')}`);
  const msgs = new Map(path.map((id, i) => [id, { seq: (i + 1) * 10 }]));
  const rows: MemEntry[] = [];
  const used = new Set<number>();
  for (let k = 0, count = 8 + Math.floor(rnd() * 40); k < count; k++) {
    let seq: number;
    do seq = 1 + Math.floor(rnd() * (n * 10 + 40));
    while (seq % 10 === 0 || used.has(seq));
    used.add(seq);
    const older = path.filter((id) => msgs.get(id)!.seq < seq);
    const kind = rnd();
    if (kind < 0.5 && older.length > 1) {
      const at = older.length - 1 - Math.floor(rnd() * Math.min(older.length - 1, 3));
      const on = older[at]!;
      const ops: MemOp[] = [char(pick(NAMES), { minor_facts: [`${pick(WORDS)} ${pick(WORDS)} ${k}`] })];
      if (rnd() < 0.3) ops.push(note(pick(WORDS), `${pick(WORDS)}.`));
      rows.push(row(seq, ops, { key: `file:${on}`, on, by: 'filing', range: [older[at - 1]!, on] }));
    } else if (kind < 0.75) {
      rows.push(row(seq, [edit(`character:${pick(NAMES).toLowerCase()}`, { role: pick(WORDS) })]));
    } else if (kind < 0.9) {
      rows.push(row(seq, [note(pick(WORDS), `${pick(WORDS)} ${k}.`)]));
    } else {
      rows.push(row(seq, [char(pick(NAMES), { minor_facts: [`${pick(WORDS)} ${k}`] })]));
    }
  }
  const touched = new Map<string, number>();
  for (const id of path) if (rnd() < 0.1) touched.set(id, msgs.get(id)!.seq + Math.floor(rnd() * 100));
  return { rows, path, msgs, touched };
}
