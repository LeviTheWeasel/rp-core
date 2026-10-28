// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b in the TUI after the review (.notes/m5b-decisions.md, the lead's ruling I): the agents pane shows
// the lane's state at a session's open (its events then came before the pane, cli#13); a pass that ends
// with nothing to tell — superseded, or dropped from the queue — leaves its block (cli#4); the usage
// block counts the lane's calls (cli#6).
import { afterEach, describe, expect, test } from 'bun:test';
import { initialAgents, isLaneEvent, reduceAgents, storedFacts, withLane } from '../../src/cli/tui/agents.ts';
import { configOf, journalOf } from '../../src/cli/repl-journal.ts';
import { LAYOUT } from '../../src/cli/tui/types.ts';
import type { Connection, MemoryStatus } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, LEVI, MIRA, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

const W = 130;
/** The Agents box's rows as text, without the box's borders and padding. */
const agentsRows = (f: string): string[] =>
  f.split('\n').map((r) => [...r].slice(W - LAYOUT.right).join('').replace(/^[│┌└]\s?/, '').replace(/\s*[│┐┘▄▀█]?$/, '').trimEnd());

const filedJson = (...names: string[]): string => JSON.stringify({ filings: names.map((name) => ({ type: 'character', entry: { name } })) });

describe('the pane at a session\'s open (cli#13)', () => {
  test('a pass queued at the open has its block at once; it runs and ends with its duration', async () => {
    // A closed session whose A1 is accepted (U2 follows it) and not filed: the lane queues it at the open.
    const home = tmpHome('rp-core-tui-');
    const provider = createScriptedProvider(calls([{ text: 'Фрол кивнул.' }], [{ text: 'Дальше.' }]));
    const conn: Connection = { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true };
    const e = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(5), timeZone: 'UTC', lane: 'manual' });
    const s = e.createSession({ character: MIRA, persona: LEVI });
    for (const text of ['Кто ты?', 'Ясно.']) {
      const t = s.submit({ text, expectedVersion: s.version(), onError: 'keep' });
      for await (const _ of t.events);
      await t.result;
    }
    expect(s.memoryStatus().queued).toHaveLength(1);
    await e.close();

    rig = await tuiRig(calls([{ pause: 'f1' }, { text: filedJson('Фрол') }]), { width: W, height: 34, home, sessionId: s.id });
    let f = await rig.until('Mira › Дальше.');
    expect(agentsRows(f)).toContain('Filing · queued');
    await rig.send('/memory wait');
    f = await rig.until('Filing · started');
    rig.provider.release('f1');
    f = await rig.until('Filing · done (1)');
    const rows = agentsRows(f);
    expect(rows[rows.indexOf('Filing · done (1)') + 1]).toMatch(/^ {2}[\d.]+s$/);
  });

  test('withLane: the running pass (queued while it waits for a place), else a queued one, else a parked one', () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const task = (key: string) => ({ key, task: key.startsWith('hist:') ? ('hist' as const) : ('file' as const), on: 'a1', range: ['u1', 'a1'] as [string, string], attempt: 1 });
    const lane: MemoryStatus = { running: { ...task('file:a1'), job: 'j_1' }, queued: [task('hist:g-a1')], parked: [{ key: 'file:x', on: 'x', failures: 3 }], backlog: 0 };
    expect(withLane(initialAgents(), lane, now).others).toEqual([
      { agent: 'filing', status: 'started', startedMs: now.getTime() },
      { agent: 'historian', status: 'queued', startedMs: now.getTime() },
    ]);
    expect(withLane(initialAgents(), { ...lane, running: { ...task('file:a1'), job: 'j_1', waiting: true } }, now).others[0]).toEqual({ agent: 'filing', status: 'queued', startedMs: now.getTime() });
    expect(withLane(initialAgents(), { queued: [], parked: [{ key: 'file:x', on: 'x', failures: 1, code: 'no_room' }], backlog: 0 }, now).others).toEqual([
      { agent: 'filing', status: 'parked', code: 'no_room' },
    ]);
    const idle = initialAgents();
    expect(withLane(idle, { queued: [], parked: [], backlog: 0 }, now)).toBe(idle);
  });
});

describe('a pass that ends with nothing to tell leaves its block (cli#4)', () => {
  test('/memory off drops the queued pass: the block says idle, not queued', async () => {
    rig = await tuiRig(calls([{ text: 'Фрол кивнул.' }], [{ text: 'Дальше.' }]), { width: W, height: 34 });
    await rig.until('Hello, Levi');
    await rig.send('Кто ты?');
    await rig.until('Mira › Фрол кивнул.');
    await rig.send('Ясно.');
    await rig.until('Filing · queued');
    await rig.send('/memory off');
    const f = await rig.until('Filing · idle');
    expect(f).not.toContain('Filing · queued');
  });

  test('a run superseded by /memory off ends its block: skipped, superseded', async () => {
    rig = await tuiRig(calls([{ text: 'Фрол кивнул.' }], [{ text: 'Дальше.' }], [{ pause: 'f1' }, { text: filedJson('Фрол') }]), { width: W, height: 34 });
    await rig.until('Hello, Levi');
    await rig.send('Кто ты?');
    await rig.until('Mira › Фрол кивнул.');
    await rig.send('Ясно.');
    await rig.until('Filing · queued');
    await rig.send('/memory wait');
    await rig.until('Filing · started');
    // Ctrl+C stops waiting (the pass goes on), then the Compendium goes off under it.
    rig.setup.mockInput.pressKey('c', { ctrl: true });
    await rig.until('(stopped waiting;');
    await rig.send('/memory off');
    const f = await rig.until('Filing · skipped');
    const rows = agentsRows(f);
    expect(rows[rows.indexOf('Filing · skipped') + 1]).toMatch(/^ {2}[\d.]+s · superseded$/);
    rig.provider.release('f1');
  });

  test('the reducer: idle{background: 0} turns a block still queued or started into idle (its memory line kept); other counts change nothing', () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const ev = (body: EventBody): Event => ({ sessionId: 's', ts: '2026-10-28T12:00:01.000Z', ...body }) as Event;
    let s = reduceAgents(initialAgents(), ev({ type: 'memory', change: 'created', ref: 'k', kind: 'character', name: 'Фрол', by: 'filing' }), now);
    s = reduceAgents(s, ev({ type: 'agent', agent: 'filing', status: 'queued' }), now);
    expect(reduceAgents(s, ev({ type: 'idle', background: 1 }), now)).toBe(s);
    s = reduceAgents(s, ev({ type: 'idle', background: 0 }), now);
    expect(s.others).toEqual([{ agent: 'filing', status: 'idle', memory: 'created character "Фрол"' }]);
    expect(reduceAgents(s, ev({ type: 'idle', background: 0 }), now)).toBe(s);
    expect(isLaneEvent(ev({ type: 'idle', background: 0 }))).toBe(true);
  });
});

describe('the usage block counts the lane\'s calls (cli#6)', () => {
  test('the filing call\'s usage: live from its event, then from its row once the pane re-reads the journal', async () => {
    rig = await tuiRig(calls([{ text: 'Фрол кивнул.' }], [{ text: 'Дальше.' }], [{ text: filedJson('Фрол') }, { usage: { inputTotal: 5000, outputTotal: 700 } }]), { width: W, height: 34 });
    await rig.until('Hello, Levi');
    await rig.send('Кто ты?');
    await rig.until('Mira › Фрол кивнул.');
    await rig.send('Ясно.');
    await rig.until('Filing · queued');
    await rig.send('/memory wait');
    await rig.until('the background lane is idle');
    await rig.until('3 calls · 5000 in · 700 out');
    const { header, entries } = readSessionFile(rig.home, rig.session.id);
    const j = journalOf(header, entries);
    expect(storedFacts(j, null, configOf(j), CONFIG.prices).usage).toMatchObject({ calls: 3, inputTokens: 5000, outputTokens: 700, noUsage: 2 });
  });

  test('isLaneEvent: the lane agents\' usage events pass, a turn\'s do not (they come through the turn view)', () => {
    const usage = (agent: string, callKey: string): Event =>
      ({ sessionId: 's', ts: '2026-10-28T12:00:00.000Z', type: 'usage', callKey, agent, model: 'script:default', usage: { inputTotal: 1 }, costUsd: null, priceSource: 'none' }) as Event;
    expect(isLaneEvent(usage('filing', 'j_1:filing:0'))).toBe(true);
    expect(isLaneEvent(usage('historian', 'j_1:historian:0'))).toBe(true);
    expect(isLaneEvent(usage('narrator', 't_1:narrator:0'))).toBe(false);
    expect(isLaneEvent(usage('director', 't_1:director:0'))).toBe(false);
  });
});
