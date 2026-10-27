// Fixtures shared by the memory tests (not a test file itself).
import type { MemEntry, MemOp } from '../../src/session/entries.ts';

export const TS = '2026-10-26T12:00:00.000Z';

/** A human mem row (key null, on null unless given) with the given ops. */
export function row(seq: number, ops: MemOp[], extra: Partial<MemEntry> = {}): MemEntry {
  return { t: 'mem', seq, ts: TS, key: null, on: null, by: 'user', ops, ...extra };
}

export const note = (title: string, content = `About ${title}.`, keys: string[] = [title]): MemOp => ({ op: 'note', title, keys, content });

/** An empty path: only rows with on:null apply. */
export const NO_PATH: ReadonlySet<string> = new Set();

/** A `file` op (M5a). */
export const file = (type: string, data: Record<string, unknown>): MemOp => ({ op: 'file', type, data } as MemOp);

/** A filing row as M5b writes it: key 'file:<on>', bound to `on`, covering `range` (default [on, on]). */
export function filing(seq: number, on: string, ops: MemOp[], range: [string, string] = [on, on]): MemEntry {
  return row(seq, ops, { key: `file:${on}`, on, by: 'filing', range });
}

/** A historian row: key 'hist:<from>-<to>', bound to `to`, covering [from, to]. */
export function hist(seq: number, from: string, to: string, ops: MemOp[]): MemEntry {
  return row(seq, ops, { key: `hist:${from}-${to}`, on: to, by: 'historian', range: [from, to] });
}
