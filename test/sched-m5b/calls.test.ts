// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b (D-172): priority through streamCall and structuredCall, the 'preempted' outcome, the
// filing / historian budget reasons, and the idle gate seen from a call.
import { describe, expect, test } from 'bun:test';
import { abortWith, realTimers, reasonOf, type AbortReason } from '../../src/engine/abort.ts';
import type { Connection } from '../../src/engine/api.ts';
import { streamCall, type CallInput } from '../../src/engine/narrate.ts';
import { createScheduler, type Scheduler } from '../../src/engine/sched.ts';
import type { StructuredAgent } from '../../src/agents/structured.ts';
import type { ReadResult } from '../../src/agents/director/types.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import { fakeClock } from '../helpers.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import { calls, rig } from '../structured/kit.ts';

const LOCAL = 'http://127.0.0.1:8080';
const SLOW = { firstByteMs: 10_000_000, idleMs: 10_000_000 };

function conn(script: ScriptCall[], origin = 'script:c'): Connection & { provider: ReturnType<typeof createScriptedProvider> } {
  return { id: 'c', provider: createScriptedProvider(script), caps: SCRIPT_CAPS, origin, local: true };
}

function input(c: Connection, sched: Scheduler, more: Partial<CallInput> = {}): CallInput {
  return {
    conn: c,
    model: 'm',
    caps: c.caps,
    messages: [{ role: 'user', blocks: [{ k: 'text', text: 'hi' }], src: 'history' }],
    maxTokens: 100,
    samplers: {},
    callKey: 'j_00000001:filing:0',
    turnSignal: new AbortController().signal,
    sched,
    fetch,
    timeouts: SLOW,
    timers: realTimers,
    clock: fakeClock(),
    onText: () => undefined,
    onReasoning: () => undefined,
    ...more,
  };
}

describe('streamCall priority', () => {
  test('a background call preempted mid-stream ends stopped + preempted, with no error; the interactive call then runs', async () => {
    const sched = createScheduler();
    const c = conn(calls([{ text: 'half an answer' }, { pause: 'never' }], [{ text: 'narrator' }]));
    const bg = streamCall(input(c, sched, { priority: 'background' }));
    await settle();
    expect(c.provider.requests.length).toBe(1);
    const int = streamCall(input(c, sched, { callKey: 't_1:narrator:0' }));
    const res = await bg;
    expect(res.stopped).toBe(true);
    expect(res.preempted).toBe(true);
    expect(res.error).toBeUndefined();
    expect(reasonOf(c.provider.requests[0]!.signal)).toBe('preempted');
    const done = await int;
    expect(done.text).toBe('narrator');
    expect('preempted' in done).toBe(false);
    expect(sched.forOrigin('script:c', 1).inFlight()).toBe(0);
  });

  test('preempted between the grant and the send: nothing is sent and onSlot is not called', async () => {
    const sched = createScheduler();
    const sem = sched.forOrigin('script:c', 1);
    const c = conn(calls([{ text: 'never sent' }]));
    const holder = await sem.acquire('interactive');
    let slots = 0;
    const bg = streamCall(input(c, sched, { priority: 'background', onSlot: () => void slots++ }));
    await settle();
    // The holder leaves (the place goes to the queued background call) and an interactive request
    // comes before the background call resumes: it is preempted before it sends anything.
    holder.release();
    const int = sem.acquire('interactive');
    const res = await bg;
    expect(res.preempted).toBe(true);
    expect(res.stopped).toBe(true);
    expect(slots).toBe(0);
    expect(c.provider.requests.length).toBe(0);
    (await int).release();
    expect(sem.inFlight()).toBe(0);
  });

  test('a preemption after the finish keeps the answer', async () => {
    const sched = createScheduler();
    const sem = sched.forOrigin('script:c', 1);
    const c = conn(calls([{ text: 'whole' }, { finish: 'end' }]));
    const res = await streamCall(input(c, sched, { priority: 'background' }));
    expect(res.text).toBe('whole');
    expect(res.preempted).toBeUndefined();
    expect(sem.inFlight()).toBe(0);
  });

  test('the priority never reaches the request', async () => {
    const sched = createScheduler();
    const c = conn(calls([{ text: 'ok' }]));
    await streamCall(input(c, sched, { priority: 'background', idleDelaySec: 0 }));
    const req = c.provider.requests[0]!;
    expect('priority' in req).toBe(false);
    expect('idleDelaySec' in req).toBe(false);
  });

  test("the session's idleDelaySec reaches the local idle gate", async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    sched.touch(LOCAL);
    const c = conn(calls([{ text: 'filed' }]), LOCAL);
    const bg = streamCall(input(c, sched, { priority: 'background', idleDelaySec: 8 }));
    await settle();
    timers.advance(7_999);
    await settle();
    expect(c.provider.requests.length).toBe(0);
    timers.advance(1);
    expect((await bg).text).toBe('filed');
  });
});

/** A filing-like reader: any object with `filings`. */
function readFilings(raw: unknown): ReadResult<{ filings: unknown }> {
  const r = raw as Record<string, unknown>;
  return 'filings' in r ? { ok: true, value: { filings: r['filings'] }, skipped: [] } : { ok: false, code: 'invalid', message: 'no filings' };
}

describe('structuredCall priority', () => {
  test("a preempted background call ends with code 'preempted': no retry, no corrective pass, nothing read", async () => {
    const sched = createScheduler();
    let reads = 0;
    const r = rig<{ filings: unknown }>(calls([{ text: '{"fil' }, { pause: 'never' }], [{ text: 'narrator' }]), {
      sched,
      input: {
        agent: 'filing',
        tag: null,
        priority: 'background',
        callKeyPrefix: 'j_0000abcd:filing',
        read: (raw) => {
          reads++;
          return readFilings(raw);
        },
      },
    });
    const pendingRes = r.run();
    await settle();
    expect(r.provider.requests.map((q) => q.callKey)).toEqual(['j_0000abcd:filing:0']);
    const narrator = streamCall(input(r.conn, sched, { callKey: 't_1:narrator:0' }));
    const out = await pendingRes;
    expect(out.ok ? 'ok' : out.code).toBe('preempted');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['preempted']);
    expect(out.calls.map((c) => c.callKey)).toEqual(['j_0000abcd:filing:0']);
    expect(reads).toBe(0);
    expect(r.events.filter((e) => e.type === 'retry')).toEqual([]);
    expect((await narrator).text).toBe('narrator');
    // The narrator's was the only other request: no retry and no corrective pass went out.
    expect(r.provider.requests.length).toBe(2);
  });

  test('a Stop outranks a preemption: aborted', async () => {
    const sched = createScheduler();
    const r = rig<{ filings: unknown }>(calls([{ pause: 'never' }]), { sched, input: { agent: 'historian', tag: null, priority: 'background', read: readFilings } });
    const pendingRes = r.run();
    await settle();
    abortWith(r.turn, 'shutdown');
    const sem = sched.forOrigin('script:dir', 1);
    const int = sem.acquire('interactive');
    const out = await pendingRes;
    expect(out.ok ? 'ok' : out.code).toBe('aborted');
    (await int).release();
  });

  test('an interactive call (the default) is never preempted by another interactive one', async () => {
    const sched = createScheduler();
    const r = rig(calls([{ text: '<plan>{"directive":' }, { pause: 'p' }, { text: '{"mood":"calm"}}</plan>' }]), { sched });
    const sem = sched.forOrigin('script:dir', 1);
    const pendingRes = r.run();
    await settle();
    expect(r.provider.requests.length).toBe(1);
    const other = sem.acquire('interactive');
    await settle();
    expect(r.provider.requests[0]!.signal.aborted).toBe(false);
    r.provider.release('p');
    const out = await pendingRes;
    expect(out.ok).toBe(true);
    expect(r.provider.requests.length).toBe(1);
    (await other).release();
  });

  test.each([
    ['filing', 'budget:filing'],
    ['historian', 'budget:historian'],
    ['director', 'budget:director'],
  ] as [StructuredAgent, AbortReason][])('the %s budget aborts with %s and reads as a timeout', async (agent, reason) => {
    const timers = fakeTimers();
    const r = rig(calls([{ pause: 'never' }]), {
      timers,
      env: { timeouts: SLOW },
      input: { agent, tag: agent === 'director' ? 'plan' : null, budgetMs: 1_000, ...(agent === 'director' ? {} : { priority: 'background' as const }) },
    });
    const pendingRes = r.run();
    await settle();
    timers.advance(1_000);
    const out = await pendingRes;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(reasonOf(r.provider.requests[0]!.signal)).toBe(reason);
  });
});
