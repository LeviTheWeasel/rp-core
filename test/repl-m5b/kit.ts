// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5b REPL tests (not a test file itself): the REPL rig over a session whose
// background lane is 'manual' (test/preload.ts), so `/memory wait` runs the filing and historian passes
// with the scripted answers that follow the narrator's; scripted answers, and the output cut per line.
import type { ScriptStep } from '../../src/providers/scripted.ts';
import type { JobEntry, MemEntry } from '../../src/session/entries.ts';
import { entriesOf, type ReplRig } from '../repl/kit.ts';

export { calls, entriesOf, replRig, type ReplRig } from '../repl/kit.ts';

/** One narrator answer. */
export const answer = (text: string): ScriptStep[] => [{ text }];

/** One filing answer holding these items ({type, entry}). */
export const filed = (...items: unknown[]): ScriptStep[] => [{ text: JSON.stringify({ filings: items }) }];

/** A character item. */
export const char = (name: string, more: Record<string, unknown> = {}): { type: string; entry: Record<string, unknown> } => ({ type: 'character', entry: { name, ...more } });

/** One historian answer: summaries (each under its plot) and arc overviews. */
export const chronicle = (summaries: { title: string; plot: string; summary: string }[], arcs: { plot: string; overview: string }[]): ScriptStep[] => [
  {
    text: JSON.stringify({
      filings: summaries.map((s) => ({ type: 'summary', entry: { title: s.title, parent_plot: s.plot, summary: s.summary } })),
      arcs,
    }),
  },
];

/** A call the server refuses (HTTP 400): a failed attempt of a lane pass. */
export const refused = (): ScriptStep[] => [{ error: { code: 'bad_request', status: 400 } }];

/**
 * The output cut at the echoes of the player's lines (`you › <line>`): one block per line, in order,
 * holding what was printed after it up to the next echo. `said(line, k)`: the k-th (1-based) block of that line.
 */
export function blocks(out: string): { line: string; said: string }[] {
  const parts: { line: string; said: string }[] = [];
  let cur: { line: string; said: string } | null = null;
  const rows = out.split('\n');
  if (rows.at(-1) === '') rows.pop();
  for (const l of rows) {
    const m = /^\s*you\s+› (.*)$/.exec(l);
    if (m) {
      cur = { line: m[1]!, said: '' };
      parts.push(cur);
    } else if (cur) cur.said += `${l}\n`;
  }
  return parts;
}

export function said(out: string, line: string, k = 1): string {
  const hit = blocks(out).filter((b) => b.line === line)[k - 1];
  if (!hit) throw new Error(`no echo #${k} of ${JSON.stringify(line)} in:\n${out}`);
  return hit.said;
}

/** The session's mem and job rows as written. */
export const memRows = (r: Pick<ReplRig, 'home' | 'session'>): MemEntry[] => entriesOf(r.home, r.session.id).filter((e): e is MemEntry => e.t === 'mem');
export const jobRows = (r: Pick<ReplRig, 'home' | 'session'>): JobEntry[] => entriesOf(r.home, r.session.id).filter((e): e is JobEntry => e.t === 'job');

/** The path's message ids: [greeting, U1, A1, U2, A2, …]. */
export const pathIds = (r: Pick<ReplRig, 'session'>): string[] => r.session.view().path.map((m) => m.id);

/** The C<n> handle of the entry named `name` now (of that type, when given: a plot and its arc share a name). */
export function handleOf(r: Pick<ReplRig, 'session'>, name: string, type?: 'arc' | 'plot' | 'summary' | 'character'): string {
  const row = r.session.memoryList({ includeRetired: true, ...(type !== undefined ? { type } : {}) }).find((x) => x.name === name);
  if (!row) throw new Error(`no entry named ${JSON.stringify(name)}`);
  return row.ref;
}
