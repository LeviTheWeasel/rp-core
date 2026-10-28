// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c in the TUI's agents pane (.notes/m5c-decisions.md D-206, ruling H): the recall prefetch is the
// lane's (agent{recall} without a turn, calls `p_<head>:recall:N`), so the host hands its events from the
// bus; its usage is left out (it counts once a reply adopts it, through the record, as /usage). The
// Recall block shows a turn's sync recall and the prefetch alike; a prefetch that ended with picks says
// `prefetched (n)`; idle{background: 0} clears a prefetch block still queued or started, never a turn's;
// a session the pane starts showing gets the prefetch from memoryStatus().
import { describe, expect, test } from 'bun:test';
import { agentsLines, linesText } from '../../src/cli/tui/agents-pane.ts';
import { initialAgents, isLaneEvent, reduceAgents, withLane, type AgentsState } from '../../src/cli/tui/agents.ts';
import type { MemoryStatus } from '../../src/engine/api.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import type { RecallRecord } from '../../src/session/entries.ts';

const T0 = Date.parse('2026-10-28T12:00:00.000Z');
const now = new Date(T0);
const ev = (body: EventBody, sec = 0): Event => ({ sessionId: 's', ts: new Date(T0 + sec * 1000).toISOString(), ...body }) as Event;
const run = (evs: Event[], s: AgentsState = initialAgents()): AgentsState => evs.reduce((acc, e) => reduceAgents(acc, e, now), s);
const usage = (agent: string, callKey: string): Event => ev({ type: 'usage', callKey, agent, model: 'script:default', usage: { inputTotal: 1 }, costUsd: null, priceSource: 'none' });
const recallBlocks = (s: AgentsState): string => linesText(agentsLines(s, 60).slice(-3));

const rec = (over: Partial<RecallRecord> = {}): RecallRecord => ({
  v: 1,
  status: 'recalled',
  source: 'prefetch',
  profile: 'lite',
  picks: [{ ref: 'k1' }, { ref: 'k2' }],
  unknown: 0,
  repeated: 0,
  trimmed: 0,
  omitted: 0,
  byName: 0,
  salvaged: 0,
  calls: 1,
  basis: 'a1',
  ...over,
});
const idleLane: MemoryStatus = { queued: [], parked: [], backlog: 0 };

describe('isLaneEvent: the prefetch is the lane\'s', () => {
  test("a recall agent event without a turn passes, a turn's does not; a prefetch call's retry passes, its usage does not", () => {
    expect(isLaneEvent(ev({ type: 'agent', agent: 'recall', status: 'queued' }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'agent', agent: 'recall', status: 'done', source: 'prefetch', count: 2 }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'adopted', source: 'prefetch', count: 2 }))).toBe(false);
    expect(isLaneEvent(ev({ type: 'retry', callKey: 'p_a1b2c3d4:recall:0', attempt: 1, delayMs: 5, code: 'server_error' }))).toBe(true);
    expect(isLaneEvent(ev({ type: 'retry', callKey: 't_1:recall:0', attempt: 1, delayMs: 5, code: 'server_error' }))).toBe(false);
    expect(isLaneEvent(usage('recall', 'p_a1b2c3d4:recall:0'))).toBe(false);
    expect(isLaneEvent(usage('recall', 't_1:recall:0'))).toBe(false);
  });
});

describe('the Recall block', () => {
  test('a prefetch: queued, started, then prefetched (n) · prefetch · its time; the block is the lane\'s', () => {
    let s = run([ev({ type: 'agent', agent: 'recall', status: 'queued' }), ev({ type: 'agent', agent: 'recall', status: 'started', source: 'prefetch' }, 1)]);
    expect(s.others).toEqual([{ agent: 'recall', status: 'started', source: 'prefetch', lane: true, startedMs: T0 }]);
    expect(recallBlocks(s)).toBe('\nRecall · started\n  prefetch');
    s = run([ev({ type: 'agent', agent: 'recall', status: 'done', source: 'prefetch', count: 2 }, 2.5)], s);
    expect(s.others).toEqual([{ agent: 'recall', status: 'done', count: 2, source: 'prefetch', lane: true, ms: 2500 }]);
    expect(recallBlocks(s)).toBe('\nRecall · prefetched (2)\n  prefetch · 2.5s');
  });

  test('a turn then adopts it, falls back, or recalls itself (sync): the block is the turn\'s again', () => {
    const pre = run([ev({ type: 'agent', agent: 'recall', status: 'done', source: 'prefetch', count: 2 })]);
    let s = run([ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'adopted', source: 'prefetch', count: 2 }, 1)], pre);
    expect(s.others).toEqual([{ agent: 'recall', status: 'adopted', count: 2, source: 'prefetch' }]);
    expect(recallBlocks(s)).toBe('\nRecall · adopted (2)\n  prefetch');
    s = run([ev({ type: 'agent', agent: 'recall', turnId: 't2', status: 'fallback', source: 'lexical', code: 'prefetch_missed' }, 2)], s);
    expect(recallBlocks(s)).toBe('\nRecall · fallback [prefetch_missed]\n  lexical');
    s = run([ev({ type: 'agent', agent: 'recall', turnId: 't3', status: 'started', source: 'sync' }, 3), ev({ type: 'agent', agent: 'recall', turnId: 't3', status: 'recalled', source: 'sync', count: 1 }, 3.4)], s);
    expect(recallBlocks(s)).toBe('\nRecall · recalled (1)\n  sync · 0.4s');
  });

  test("a failed, preempted or superseded prefetch says so; a prefetch call's retry marks the block", () => {
    expect(recallBlocks(run([ev({ type: 'agent', agent: 'recall', status: 'failed', code: 'timeout' })]))).toBe('\nRecall · failed [timeout]\n  prefetch');
    expect(recallBlocks(run([ev({ type: 'agent', agent: 'recall', status: 'preempted' })]))).toBe('\nRecall · preempted\n  prefetch');
    expect(recallBlocks(run([ev({ type: 'agent', agent: 'recall', status: 'skipped', reason: 'superseded' })]))).toBe('\nRecall · skipped\n  prefetch · superseded');
    const s = run([ev({ type: 'agent', agent: 'recall', status: 'started', source: 'prefetch' }), ev({ type: 'retry', callKey: 'p_a1:recall:0', attempt: 1, delayMs: 5, code: 'server_error' })]);
    expect(s.others[0]).toMatchObject({ agent: 'recall', status: 'retry', code: 'server_error', lane: true });
  });

  test("idle{background: 0} clears a prefetch block still queued or started, never a turn's sync recall", () => {
    const lane = run([ev({ type: 'agent', agent: 'recall', status: 'started', source: 'prefetch' })]);
    expect(run([ev({ type: 'idle', background: 0 })], lane).others).toEqual([{ agent: 'recall', status: 'idle', lane: true }]);
    const turn = run([ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'started', source: 'sync' })]);
    const after = run([ev({ type: 'idle', background: 0 })], turn);
    expect(after).toBe(turn);
  });
});

describe('withLane: the prefetch as memoryStatus() says it (a session the pane starts showing)', () => {
  test('queued, running, ready with its picks, ready but failed; none: no Recall block', () => {
    const at = (prefetch: MemoryStatus['prefetch']): AgentsState => withLane(initialAgents(), { ...idleLane, ...(prefetch ? { prefetch } : {}) }, now);
    expect(at({ basis: 'b', on: 'a1', state: 'queued' }).others).toEqual([{ agent: 'recall', status: 'queued', source: 'prefetch', startedMs: T0, lane: true }]);
    expect(at({ basis: 'b', on: 'a1', state: 'running' }).others).toEqual([{ agent: 'recall', status: 'started', source: 'prefetch', startedMs: T0, lane: true }]);
    const ready = at({ basis: 'b', on: 'a1', state: 'ready', record: rec() });
    expect(ready.others).toEqual([{ agent: 'recall', status: 'done', count: 2, source: 'prefetch', lane: true }]);
    expect(recallBlocks(ready)).toBe('\nRecall · prefetched (2)\n  prefetch');
    expect(at({ basis: 'b', on: 'a1', state: 'ready', record: rec({ status: 'failed', source: 'lexical', picks: [], code: 'timeout' }) }).others).toEqual([
      { agent: 'recall', status: 'failed', code: 'timeout', source: 'prefetch', lane: true },
    ]);
    const none = initialAgents();
    expect(withLane(none, idleLane, now)).toBe(none);
  });
});
