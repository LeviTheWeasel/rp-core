// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the historian and {{recap}} tests (not a test file itself): paths, task maps, a word
// counter, hand-built CEntry objects and a fold over historian rows.
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import type { HistMessage, HistorianDueInput } from '../../src/agents/compendium/historian.ts';
import { deriveTagline } from '../../src/agents/compendium/entry-types.ts';
import { EMPTY_COMPENDIUM, type CEntry, type CompendiumView, type EntryType, type LibrarySeed, type Rec, type TaskState } from '../../src/agents/compendium/types.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';

export const TS = '2026-10-27T12:00:00.000Z';

/** One token per word: token counts in the tests are word counts. */
export const words = (text: string): number => (text.match(/\S+/g) ?? []).length;

/** A path from role letters ('u' user, 'a' assistant), ids m1, m2, … (the position), one text for all. */
export function chat(roles: string, text = 'hello there'): HistMessage[] {
  return [...roles].map((r, i) => ({ id: `m${i + 1}`, role: r === 'u' ? 'user' : 'assistant', text }));
}

/** RoleCall's `roles(n)`: user at even index, assistant at odd, ids m1…mn. */
export const roles = (n: number): HistMessage[] => chat('ua'.repeat(Math.ceil(n / 2)).slice(0, n));

/** A path of n exchanges without a greeting: u1 a1 u2 a2 … (pos(u_k) = 2k − 1, pos(a_k) = 2k). */
export function exchanges(n: number, text = (id: string): string => `Text of ${id}.`): HistMessage[] {
  const out: HistMessage[] = [];
  for (let k = 1; k <= n; k++) {
    out.push({ id: `u${k}`, role: 'user', text: text(`u${k}`) });
    out.push({ id: `a${k}`, role: 'assistant', text: text(`a${k}`) });
  }
  return out;
}

/** A task map: [key, status, range, stale?]. */
export function tasks(...rows: [string, TaskState['status'], [string, string] | undefined, true?][]): Map<string, TaskState> {
  return new Map(
    rows.map(([key, status, range, stale], i): [string, TaskState] => [
      key,
      { seq: i + 1, status, ...(range ? { range } : {}), ...(stale ? { stale } : {}) },
    ]),
  );
}

/** A historian key's task, applied, over [from, to]. */
export const hist = (from: string, to: string, status: TaskState['status'] = 'applied'): [string, TaskState['status'], [string, string]] => [
  `hist:${from}-${to}`,
  status,
  [from, to],
];

/** historianDue's input with the defaults most tests use (full profile, a 128k window: the 12 000 cap). */
export function due(path: HistMessage[], over: Partial<HistorianDueInput> & { interval?: number; overlap?: number; recapAfter?: number } = {}): HistorianDueInput {
  const { interval = 1, overlap, recapAfter = 24, ...rest } = over;
  return {
    path,
    tasks: new Map(),
    trimmed: null,
    cfg: { interval, recapAfter, ...(overlap !== undefined ? { overlap } : {}) },
    profile: 'full',
    window: 128_000,
    count: words,
    ...rest,
  };
}

// ---- entries --------------------------------------------------------------------------------------

const nameOf = (data: Rec, fallback: string): string => {
  for (const f of ['name', 'title', 'topic']) {
    const v = data[f];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return fallback;
};

/** A typed session entry. */
export function typed(key: string, type: EntryType, data: Rec, more: Partial<CEntry> = {}): CEntry {
  return {
    key,
    type,
    name: nameOf(data, key),
    aliases: Array.isArray(data.aliases) ? data.aliases.filter((a): a is string => typeof a === 'string') : [],
    tagline: deriveTagline(type, data),
    data,
    keys: [],
    origin: { kind: 'session' },
    prov: { created: null, lastSeq: 1, appended: {}, createdSeq: 1 },
    ...more,
  };
}

/** A historian summary over [from, to] (key summary:<to>.0 unless given). */
export function summary(title: string, plot: string, range: [string, string], more: Partial<CEntry> = {}, text = `${title} happened.`): CEntry {
  return typed(`summary:${range[1]}.0`, 'summary', { title, parent_plot: plot, summary: text }, { range, ...more });
}

/** A session arc overview of `plot`. */
export function arc(plot: string, overview: string, lastSeq = 1, more: Partial<CEntry> = {}): CEntry {
  return {
    key: `arc:${plot.toLowerCase()}`,
    type: null,
    name: plot,
    aliases: [],
    tagline: '',
    data: {},
    keys: [],
    content: overview,
    arc: plot,
    origin: { kind: 'session' },
    prov: { created: null, lastSeq, appended: {}, createdSeq: lastSeq },
    ...more,
  };
}

/** A library `[Arc]` entry (D-177 seed shape). */
export function libArc(book: string, id: string, plot: string, overview: string, order = 100): CEntry {
  return {
    ...arc(plot, overview, 0),
    key: `lib:${book}:${id}`,
    origin: { kind: 'library', book, id, overlay: false },
    order,
    prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
  };
}

export function viewOf(entries: readonly CEntry[]): CompendiumView {
  return { ...EMPTY_COMPENDIUM, entries: new Map(entries.map((e) => [e.key, e])) };
}

// ---- rows and the fold ----------------------------------------------------------------------------

/** A historian row as the lane writes it. */
export function histRow(seq: number, from: string, to: string, ops: MemOp[]): MemEntry {
  return { t: 'mem', seq, ts: TS, key: `hist:${from}-${to}`, on: to, by: 'historian', range: [from, to], ops };
}

/** A human row. */
export function userRow(seq: number, ops: MemOp[]): MemEntry {
  return { t: 'mem', seq, ts: TS, key: null, on: null, by: 'user', ops };
}

/** The fold of `rows` on `path` (ids), with staleness from `touched` and an optional library seed. */
export function fold(rows: MemEntry[], path: readonly string[], touched: ReadonlyMap<string, number> = new Map(), library?: LibrarySeed): CompendiumView {
  return foldCompendium(rows, { pathSet: new Set(path), path, touched, ...(library ? { library } : {}) });
}

/** A library seed holding `entries` (classic names none). */
export function seed(entries: CEntry[]): LibrarySeed {
  return { entries, classic: new Map(), books: new Map([['book', 'Book']]), hash: 'seed0000seed0000' };
}
