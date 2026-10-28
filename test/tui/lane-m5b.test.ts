// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b in the TUI (.notes/m5b-decisions.md D-181, D-128): the agents pane folds the background lane's
// agent and memory events (they come from the engine's bus, never through a turn view) into a Filing
// and a Historian block; the lane's lines reach the transcript as the REPL prints them.
import { afterEach, describe, expect, test } from 'bun:test';
import { initialAgents, isLaneEvent, reduceAgents } from '../../src/cli/tui/agents.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import { LAYOUT } from '../../src/cli/tui/types.ts';
import { calls, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

const W = 130;
const rowsOf = (f: string): string[] => f.split('\n');
/** The Agents box's rows as text, without the box's borders and padding. */
const agentsRows = (f: string): string[] =>
  rowsOf(f).map((r) => [...r].slice(W - LAYOUT.right).join('').replace(/^[│┌└]\s?/, '').replace(/\s*[│┐┘▄▀█]?$/, '').trimEnd());

const filedJson = (...names: string[]): string => JSON.stringify({ filings: names.map((name) => ({ type: 'character', entry: { name } })) });

describe('the agents pane and the lane', () => {
  test('a filing pass: queued after the answer it files is accepted, started while its call runs, done with its memory change', async () => {
    rig = await tuiRig(calls([{ text: 'Фрол кивнул.' }], [{ text: 'Дальше.' }], [{ pause: 'f1' }, { text: filedJson('Фрол') }]), { width: W, height: 34 });
    await rig.until('Hello, Levi');
    await rig.send('Кто ты?');
    await rig.until('Mira › Фрол кивнул.');
    await rig.send('Ясно.');
    let f = await rig.until('Filing · queued');
    await rig.send('/memory wait');
    f = await rig.until('Filing · started');
    rig.provider.release('f1');
    f = await rig.until('Filing · done (1)');
    const rows = agentsRows(f);
    const at = rows.indexOf('Filing · done (1)');
    expect(rows[at + 1]).toMatch(/^ {2}[\d.]+s$/);
    // The pane is narrow: the line is cut at its width.
    expect(rows[at + 2]).toStartWith('  memory: created character "Фр');
    // The REPL's line for the pass, in the transcript.
    f = await rig.until('the background lane is idle');
    expect(f).toContain('⋯ memory: filing #3 → +1: C1 "Фрол"');
  });

  test('a historian pass gets its own block after the filing one', async () => {
    const hist = JSON.stringify({ filings: [{ type: 'summary', entry: { title: 'Встреча', parent_plot: 'Фонарь', summary: 'Леви встретил Фрола.' } }], arcs: [{ plot: 'Фонарь', overview: 'Фонарь пропал.' }] });
    rig = await tuiRig(calls([{ text: 'Фрол кивнул.' }], [{ text: 'Дальше.' }], [{ text: filedJson('Фрол') }], [{ text: hist }]), {
      width: W,
      height: 34,
      config: { compendium: { enabled: true, historian: { interval: 1 } } },
    });
    await rig.until('Hello, Levi');
    await rig.send('Кто ты?');
    await rig.until('Mira › Фрол кивнул.');
    await rig.send('Ясно.');
    await rig.until('Filing · queued');
    await rig.send('/memory wait');
    const f = await rig.until('Historian · done (3)');
    const rows = agentsRows(f);
    expect(rows.indexOf('Filing · done (1)')).toBeGreaterThan(0);
    expect(rows.indexOf('Historian · done (3)')).toBeGreaterThan(rows.indexOf('Filing · done (1)'));
    expect(rows[rows.indexOf('Historian · done (3)') + 2]).toBe('  memory: arc arc "Фонарь"');
  });
});

describe('the reducer', () => {
  const ev = (body: EventBody, s = 0): Event => ({ sessionId: 's', ts: `2026-10-28T12:00:${String(s).padStart(2, '0')}.000Z`, ...body }) as Event;

  test('a pass queued while another runs leaves the running block alone; a new start drops the last pass\'s memory line', () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    let s = initialAgents();
    for (const e of [
      ev({ type: 'agent', agent: 'filing', status: 'queued' }, 1),
      ev({ type: 'agent', agent: 'filing', status: 'started', job: 'j_1' }, 2),
      ev({ type: 'agent', agent: 'filing', status: 'queued' }, 3),
    ]) {
      s = reduceAgents(s, e, now);
    }
    expect(s.others).toEqual([{ agent: 'filing', status: 'started', startedMs: Date.parse('2026-10-28T12:00:01.000Z') }]);
    s = reduceAgents(s, ev({ type: 'memory', change: 'created', ref: 'character:фрол', kind: 'character', name: 'Фрол', by: 'filing' }, 4), now);
    s = reduceAgents(s, ev({ type: 'agent', agent: 'filing', status: 'done', job: 'j_1', count: 1, skipped: 0 }, 5), now);
    expect(s.others[0]).toMatchObject({ status: 'done', count: 1, memory: 'created character "Фрол"', ms: 4000 });
    s = reduceAgents(s, ev({ type: 'agent', agent: 'filing', status: 'started', job: 'j_2' }, 6), now);
    expect(s.others[0]!.memory).toBeUndefined();
  });

  test('isLaneEvent: the lane\'s agent events (no turn), its agents\' memory events, its calls\' retries', () => {
    expect(isLaneEvent(ev({ type: 'agent', agent: 'filing', status: 'queued' }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'agent', agent: 'historian', status: 'done', job: 'j_1' }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'agent', agent: 'recall', status: 'recalled', turnId: 't' }))).toBe(false);
    expect(isLaneEvent(ev({ type: 'memory', change: 'created', ref: 'k', kind: 'character', name: 'Фрол', by: 'filing' }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'memory', change: 'edited', ref: 'k', kind: 'character', name: 'Фрол', by: 'user' }))).toBe(false);
    expect(isLaneEvent(ev({ type: 'retry', callKey: 'j_1:filing:0', attempt: 1, delayMs: 5, code: 'server_error' }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'retry', callKey: 't_1:narrator:0', attempt: 1, delayMs: 5, code: 'server_error' }))).toBe(false);
  });
});
