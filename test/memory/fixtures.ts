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
