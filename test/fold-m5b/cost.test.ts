// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Fold cost with real filing rows (.notes/m5b-decisions.md section I, review breaker#2): the reviewer's
// 300-message chat — 150 answers, each filing four facts and more on two characters and a place, a
// historian pass every 20 answers — folds from scratch in ≤ 300 ms and after a new row or a new message
// in ≤ 30 ms. Every fold keeps a checkpoint at its end (a short chat no longer refolds from the seed on
// every view change), and a merge into a list that collapses to itself compares only the strings it
// adds against it (the same result as collapsing the whole list again, checked here against that).
import { describe, expect, test } from 'bun:test';
import { foldCompendium, type FoldOptions } from '../../src/agents/compendium/apply.ts';
import { collapseNearDuplicates, mergeData, normKey } from '../../src/agents/compendium/merge.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { file, filing, hist, row } from '../memory/fixtures.ts';

/** Median and min of `n` (odd) timed runs of `fn` (after one warm-up); `prepare` runs untimed before each. */
function time<T>(fn: (input: T) => unknown, prepare: () => T, n = 5): { median: number; min: number } {
  fn(prepare());
  const runs: number[] = [];
  for (let i = 0; i < n; i++) {
    const input = prepare();
    const t0 = performance.now();
    fn(input);
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return { median: runs[(n - 1) / 2]!, min: runs[0]! };
}

/** The reviewer's chat (review/break/long.ts) as the lane writes its rows: `answers` answers, path ids m…, message seqs 1, 4, 7… */
function breakerChat(answers: number): { rows: MemEntry[]; path: string[]; msgs: Map<string, { seq: number }>; pass: (n: number) => MemEntry } {
  const path = Array.from({ length: 2 * answers + 2 }, (_, i) => `m${String(i).padStart(7, '0')}`);
  const msgs = new Map(path.map((id, i) => [id, { seq: 1 + i * 3 }]));
  let seq = 100_000;
  const pass = (n: number): MemEntry => {
    const facts = Array.from({ length: 4 }, (_, k) => `факт ${n}-${k}: Фрол однажды видел корабль под номером ${n * 7 + k}`);
    const on = path[Math.min(2 * n + 2, path.length - 1)]!;
    const ops: MemOp[] = [
      file('character', { name: 'Фрол', minor_facts: facts, likes: [`вещь ${n}`], memories: [{ what_happened: `событие ${n}`, changed_belief: `вера ${n}` }] }),
      file('character', { name: 'Мира', minor_facts: facts.map((f) => `${f} (Мира)`), relationships: [{ with: 'Фрол', nature: 'ally', notes: `заметка ${n}` }] }),
      file('location', { name: `Маяк ${n % 5}`, minor_facts: [`камень ${n}`] }),
    ];
    return filing(++seq, on, ops, [path[path.indexOf(on) - 1]!, on]);
  };
  const rows: MemEntry[] = [];
  for (let n = 0; n < answers; n++) {
    rows.push(pass(n));
    if (n % 20 === 19) {
      const to = path[2 * n + 2]!;
      rows.push(hist(++seq, path[2 * n - 37]!, to, [file('summary', { title: `Глава ${n}`, parent_plot: 'Маяк', summary: `Они шли ${n}.` }), { op: 'arc', plot: 'Маяк', overview: `Обзор ${n}` }]));
    }
  }
  return { rows, path, msgs, pass };
}

describe('fold cost (review breaker#2)', () => {
  test('the 300-message chat folds from scratch in ≤ 300 ms, after a new row and after a new message in ≤ 30 ms', () => {
    const { rows, path, msgs, pass } = breakerChat(150);
    const head = path.slice(0, -1);
    const opts = (p: string[]): FoldOptions => ({ pathSet: new Set(p), path: p, touched: new Map(), msgs });
    const v = foldCompendium(rows, opts(head));
    expect(head.length).toBe(301);
    expect(v.entries.get('character:фрол')!.data.minor_facts).toHaveLength(532);
    // Фрол and Мира outgrow 12 000 JSON characters (D-144.6 flags them; it is the reviewer's heavy shape).
    expect(v.issues.map((i) => [i.why, i.key])).toEqual([
      ['large_entry', 'character:фрол'],
      ['large_entry', 'character:мира'],
    ]);
    const cold = time((r: MemEntry[]) => foldCompendium(r, opts(head)), () => structuredClone(rows), 3);
    let n = 1000;
    const row1 = time(
      (r: MemEntry[]) => foldCompendium(r, opts(head)),
      () => {
        foldCompendium(rows, opts(head));
        return [...rows, pass(n++)];
      },
    );
    const msg1 = time(
      (p: string[]) => foldCompendium(rows, opts(p)),
      () => {
        foldCompendium(rows, opts(head));
        return path;
      },
    );
    console.log(`[bench] the breaker#2 chat (${rows.length} rows, ${head.length} messages): from scratch median ${cold.median.toFixed(1)} ms; after a new row ${row1.median.toFixed(2)} ms; after a new message ${msg1.median.toFixed(2)} ms`);
    expect(cold.median).toBeLessThan(300);
    expect(row1.median).toBeLessThan(30);
    expect(msg1.median).toBeLessThan(30);
  });

  test('a short chat (under the old 256-row floor) resumes too: a new message folds no row again, a new row only itself', () => {
    const { rows, path, msgs, pass } = breakerChat(10);
    const opts = (p: string[]): FoldOptions => ({ pathSet: new Set(p), path: p, touched: new Map(), msgs });
    const before = foldCompendium(rows, opts(path.slice(0, -1)));
    // Entries a fold made share their data with the checkpoint it resumed from; a fold from the seed
    // would have merged new objects.
    const after = foldCompendium(rows, opts(path));
    for (const [key, e] of before.entries) expect(after.entries.get(key)!.data).toBe(e.data);
    const extra = pass(10);
    const more = foldCompendium([...rows, extra], opts(path));
    expect(more.entries.get('location:маяк 1')!.data).toBe(before.entries.get('location:маяк 1')!.data);
    expect(more.entries.get('location:маяк 0')!.data).not.toBe(before.entries.get('location:маяк 0')!.data);
    expect(more.entries.get('character:фрол')!.data).not.toBe(before.entries.get('character:фрол')!.data);
    // A fold from the seed gives the same.
    expect([...more.entries]).toEqual([...foldCompendium(structuredClone([...rows, extra]), opts(path)).entries]);
  });
});

// ---- the near-duplicate collapse on merges ---------------------------------------------------------

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

/**
 * A merge of strings into a list as D-148 says it (the oracle): a keyed list (`traits`) merges an item
 * of an existing key into that item (the incoming wording), an unkeyed one (`minor_facts`) skips an
 * item already there; when a string was added or reworded, the whole list collapses again.
 */
function oracle(old: readonly string[], incoming: readonly string[], keyed: boolean): readonly string[] {
  const items = [...old];
  const at = new Map<string, number>();
  items.forEach((x, i) => {
    const k = keyed ? normKey(x) : JSON.stringify(x);
    if (!at.has(k)) at.set(k, i);
  });
  let strings = false;
  for (const x of incoming) {
    if (x.trim() === '') continue;
    const k = keyed ? normKey(x) : JSON.stringify(x);
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, items.length);
      items.push(x);
      strings = true;
    } else if (keyed && items[i] !== x) {
      items[i] = x;
      strings = true;
    }
  }
  if (!strings) return old;
  const c = collapseNearDuplicates(items).items as string[];
  return c.length === old.length && c.every((v, i) => v === old[i]) ? old : c;
}

describe('a merge collapses only what it adds into a list that collapses to itself', () => {
  const WORDS = ['маяк', 'свет', 'море', 'фонарь', 'ночь', 'клятва', 'берег', 'ветер', 'соль', 'ключ', 'Фрол', 'Мира'];

  test('400 merges of facts sharing words (rewordings, longer wordings, chains): every list equals a whole re-collapse', () => {
    const rnd = prng(148);
    const fact = (): string => {
      const n = 2 + Math.floor(rnd() * 4);
      const words = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]!);
      if (rnd() < 0.3) words.push(String(100 + Math.floor(rnd() * 900)));
      const text = words.join(' ');
      return rnd() < 0.2 ? text.toUpperCase() : rnd() < 0.2 ? `${text} и ещё немного` : text;
    };
    for (const field of ['minor_facts', 'traits'] as const) {
      const keyed = field === 'traits';
      let data: Record<string, unknown> = {};
      let list: readonly string[] = [];
      const history: { data: Record<string, unknown>; list: readonly string[] }[] = [];
      for (let step = 0; step < 400; step++) {
        const incoming = Array.from({ length: 1 + Math.floor(rnd() * 4) }, fact);
        const m = mergeData(data, { [field]: incoming }, { keep: [], on: `m${step}`, appended: {} });
        const want = oracle(list, incoming, keyed);
        expect(m.data[field] ?? []).toEqual(want as string[]);
        history.push({ data, list });
        data = m.data;
        list = (data[field] as string[] | undefined) ?? [];
        // A merge into an older list again (a refold resumed from an older checkpoint): the same answer.
        if (step % 37 === 36) {
          const back = history[step - 10]!;
          const again = mergeData(back.data, { [field]: incoming }, { keep: [], on: 'x', appended: {} });
          expect(again.data[field] ?? []).toEqual(oracle(back.list, incoming, keyed) as string[]);
        }
      }
      expect(list.length).toBeGreaterThan(20);
    }
  });

  test('a longer wording that makes two kept facts near-duplicates: the next merge still collapses them as a whole re-collapse does', () => {
    // «а б в г» and «а б в д» are not near-duplicates (Jaccard 3/5); «а б в г д е» takes the first slot
    // (it nearly duplicates it and is longer), and now holds every word of the second.
    const words = (s: string): string => s.split(' ').map((w) => ({ а: 'маяк', б: 'свет', в: 'море', г: 'фонарь', д: 'ночь', е: 'клятва', ж: 'берег' })[w]).join(' ');
    const steps = [['а б в г', 'а б в д'], ['а б в г д е'], ['ж б в']].map((s) => s.map(words));
    let data: Record<string, unknown> = {};
    let list: readonly string[] = [];
    for (const incoming of steps) {
      data = mergeData(data, { minor_facts: incoming }, { keep: [], on: null, appended: {} }).data;
      list = oracle(list, incoming, false);
      expect(data.minor_facts).toEqual(list as string[]);
    }
    expect(list).toEqual([words('а б в г д е'), words('ж б в')]);
  });
});
