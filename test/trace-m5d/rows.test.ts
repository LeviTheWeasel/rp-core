// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5d (D-213), the Trace.calls rows: CallResult carries the prompt counts and its start; the
// narrator's rows and a turn's agent rows gain at / ttftMs / prompt; lane rows (no turn) keep their
// shape; the journal guard reads old and new rows alike.
import { describe, expect, test } from 'bun:test';
import { realTimers } from '../../src/engine/abort.ts';
import type { Connection } from '../../src/engine/api.ts';
import { callTiming, streamCall, type CallInput, type CallResult } from '../../src/engine/narrate.ts';
import { createScheduler } from '../../src/engine/sched.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import type { Provider, StreamEv } from '../../src/providers/types.ts';
import { parseEntry, type MsgEntry, type TraceCallRow } from '../../src/session/entries.ts';
import { fakeClock } from '../helpers.ts';
import { drain, entriesOf, rig as engineRig, withUserMessage } from '../engine/kit.ts';
import { TS, traceWith } from '../session/fixtures.ts';
import { calls, rig as agentRig } from '../structured/kit.ts';

/** A provider that yields `events` for every call. */
function provider(events: StreamEv[]): Provider {
  return {
    async *stream() {
      for (const ev of events) yield ev;
    },
  };
}

const ANSWER: StreamEv[] = [
  { t: 'text', i: 0, d: 'She nods.' },
  { t: 'usage', u: { inputTotal: 3508, outputTotal: 3 } },
  { t: 'usage', u: { inputTotal: 3508, inputCacheRead: 3412, outputTotal: 3 }, prompt: { processed: 96, cached: 3412 } },
  { t: 'finish', reason: 'end', raw: 'stop' },
];

function callInput(p: Provider, clock = fakeClock()): CallInput {
  const conn: Connection = { id: 'c', provider: p, caps: SCRIPT_CAPS, origin: 'mem:c', local: true };
  return {
    conn,
    model: 'm',
    caps: conn.caps,
    messages: [{ role: 'user', blocks: [{ k: 'text', text: 'hi' }], src: 'history' }],
    maxTokens: 100,
    samplers: {},
    callKey: 't:narrator:0',
    turnSignal: new AbortController().signal,
    sched: createScheduler(),
    fetch,
    timeouts: { firstByteMs: 60_000, idleMs: 60_000 },
    timers: realTimers,
    clock,
    onText: () => undefined,
    onReasoning: () => undefined,
  };
}

describe('CallResult', () => {
  test('prompt from the usage events, startedAt from the call clock', async () => {
    const res = await streamCall(callInput(provider(ANSWER)));
    expect(res.prompt).toEqual({ processed: 96, cached: 3412 });
    expect(res.startedAt).toBe(new Date('2026-10-26T12:00:00.000Z').getTime());
    expect(res.ttftMs).toBeGreaterThan(0);
  });

  test('no prompt when no usage event carried one', async () => {
    const res = await streamCall(callInput(provider([{ t: 'text', i: 0, d: 'x' }, { t: 'usage', u: { inputTotal: 9 } }, { t: 'finish', reason: 'end', raw: 'stop' }])));
    expect(res.prompt).toBeUndefined();
    expect(res.usage).toEqual({ inputTotal: 9 });
  });

  test('callTiming: at from the turn start, never negative; each field only when known', () => {
    const base: CallResult = { text: '', reasoning: '', calls: [], replay: [], stopped: false, output: false, ms: 10 };
    expect(callTiming(base, 1000)).toEqual({});
    expect(callTiming({ ...base, startedAt: 3100, ttftMs: 400, prompt: { cached: 5 } }, 1000)).toEqual({ at: 2100, ttftMs: 400, prompt: { cached: 5 } });
    expect(callTiming({ ...base, startedAt: 900 }, 1000)).toEqual({ at: 0 });
  });
});

describe('Trace.calls rows', () => {
  test("the narrator's row: at, ttftMs and prompt beside the old fields", async () => {
    const conn: Connection = { id: 'script', provider: provider(ANSWER), caps: SCRIPT_CAPS, origin: 'script:script', local: true };
    const { engine, home } = await engineRig([], { connections: { script: conn } });
    const { s, version } = withUserMessage(engine, 'Hello?');
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(turn);
    expect((await turn.result).type).toBe('done');
    const msg = entriesOf(home, s.id).findLast((e): e is MsgEntry => e.t === 'msg' && e.role === 'assistant')!;
    const [row] = msg.trace!.calls;
    expect(row).toMatchObject({ callKey: `${turn.turnId}:narrator:0`, agent: 'narrator', model: 'script:default', prompt: { processed: 96, cached: 3412 } });
    expect(row!.at).toBeGreaterThan(0);
    expect(row!.ttftMs).toBeGreaterThan(0);
    expect(row!.ms).toBeGreaterThanOrEqual(row!.ttftMs!);
    await engine.close();
  });

  test("an agent's rows on a turn carry at and ttftMs; off a turn (the lane) they keep the old shape", async () => {
    const t0 = new Date('2026-10-26T11:59:55.000Z').getTime();
    const onTurn = agentRig(calls([{ text: '<plan>{"directive":{"mood":"tense"}}</plan>' }]), { env: { turnStart: t0 } });
    const a = await onTurn.run();
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(a.calls[0]!.ttftMs).toBeGreaterThan(0);

    const offTurn = agentRig(calls([{ text: '<plan>{"directive":{"mood":"tense"}}</plan>' }]));
    const b = await offTurn.run();
    expect(Object.keys(b.calls[0]!).sort()).toEqual(['agent', 'callKey', 'model', 'ms']);
  });
});

describe('the journal guard', () => {
  const OLD: TraceCallRow = { callKey: 't_1:narrator:0', agent: 'narrator', model: 'local:m', ms: 1800, usage: { inputTotal: 3508 } };
  const NEW: TraceCallRow = { ...OLD, at: 2100, ttftMs: 400, prompt: { processed: 96, cached: 3412 } };
  const msg = (rows: TraceCallRow[]): Record<string, unknown> => ({
    t: 'msg',
    seq: 3,
    ts: TS,
    id: 'aaaa0002',
    parent: 'aaaa0001',
    role: 'assistant',
    turn: 't_1',
    blocks: [{ k: 'text', text: 'a' }],
    gen: { kind: 'model', model: 'm' },
    trace: { ...traceWith(), calls: rows },
  });

  test('old rows, new rows and a mix read back unchanged', () => {
    for (const rows of [[OLD], [NEW], [OLD, NEW], []]) {
      const v = msg(rows);
      expect(parseEntry(JSON.stringify(v))).toEqual({ ok: true, value: v as never });
    }
  });

  test('a row with only some of the new fields reads too', () => {
    const v = msg([{ ...OLD, ttftMs: 400 }, { ...OLD, prompt: { cached: 1 } }]);
    expect(parseEntry(JSON.stringify(v)).ok).toBe(true);
  });
});
