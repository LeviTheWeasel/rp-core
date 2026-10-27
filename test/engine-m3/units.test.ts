// Ported from Bunraku:src/stage/provider/tool-loop.test.ts@702d8120 (the round cap and final round,
// at the unit level), rewritten on narrate.ts.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Units of the M3 loop: streamCall's new fields and the finish grace, narrateRounds against the
// call ceiling, and the small helpers (usage sum, stops, continue layout, the rounds clamp).
import { describe, expect, test } from 'bun:test';
import { EMPTY_COMPENDIUM } from '../../src/agents/compendium/types.ts';
import { clampRounds } from '../../src/engine/admit.ts';
import { realTimers, type DelayTimers } from '../../src/engine/abort.ts';
import type { Connection } from '../../src/engine/api.ts';
import { continuedBlocks } from '../../src/engine/commit.ts';
import {
  CALL_CEILING,
  FINISH_GRACE_MS,
  MAX_TOOL_ROUNDS,
  narrateRounds,
  promptedStops,
  roomChars,
  roundFields,
  streamCall,
  sumUsage,
  type CallInput,
  type RoundsInput,
  type TurnTools,
} from '../../src/engine/narrate.ts';
import { createScheduler } from '../../src/engine/sched.ts';
import { createScriptedProvider, type ScriptCall } from '../../src/providers/scripted.ts';
import type { ModelRequest, Provider, StreamEv } from '../../src/providers/types.ts';
import type { PathView } from '../../src/session/view.ts';
import { HandleTable } from '../../src/tools/handles.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { fakeClock } from '../helpers.ts';
import { calls, capsWith, lookupTool, type ToolLog } from './kit.ts';

function conn(provider: Provider, tools: 'native' | 'prompted' | 'none' = 'native'): Connection {
  return { id: 'c', provider, caps: capsWith(tools), origin: 'mem:c', local: true };
}

function callInput(c: Connection, more: Partial<CallInput> = {}): CallInput {
  return {
    conn: c,
    model: 'm',
    caps: c.caps,
    messages: [{ role: 'user', blocks: [{ k: 'text', text: 'hi' }], src: 'history' }],
    maxTokens: 100,
    samplers: { stop: ['END'] },
    callKey: 't:narrator:0',
    turnSignal: new AbortController().signal,
    sched: createScheduler(),
    fetch,
    timeouts: { firstByteMs: 60_000, idleMs: 60_000 },
    timers: realTimers,
    clock: fakeClock(),
    onText: () => undefined,
    onReasoning: () => undefined,
    ...more,
  };
}

/** A provider that yields `events`, then (optionally) hangs until its signal aborts. */
function provider(events: StreamEv[], hang = false): Provider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(req) {
      requests.push(req);
      for (const ev of events) yield ev;
      if (hang) {
        await new Promise((_, reject) => {
          if (req.signal.aborted) reject(req.signal.reason);
          req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
        });
      }
    },
  };
}

/** Timers the test fires by hand. */
function manualTimers(): DelayTimers & { fire(ms: number): number } {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    setTimeout(fn, ms) {
      const h = ++next;
      pending.set(h, { fn, ms });
      return h;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
    fire(ms) {
      let n = 0;
      for (const [h, t] of [...pending]) {
        if (t.ms !== ms) continue;
        pending.delete(h);
        t.fn();
        n++;
      }
      return n;
    },
  };
}

describe('streamCall (M3)', () => {
  test('tools, toolChoice and stop go into the request; stop replaces the sampler stops', async () => {
    const p = provider([{ t: 'finish', reason: 'end', raw: 'stop' }]);
    const tools = [{ name: 'lookup', description: 'd', schema: { type: 'object' } }];
    await streamCall(callInput(conn(p), { tools, toolChoice: 'none', stop: ['X', PROMPTED_STOP] }));
    expect(p.requests[0]).toMatchObject({ tools, toolChoice: 'none', stop: ['X', PROMPTED_STOP] });
    // Without M3 fields: the M2 request (sampler stops, no tool fields).
    await streamCall(callInput(conn(p)));
    expect(p.requests[1]!.tools).toBeUndefined();
    expect(p.requests[1]!.toolChoice).toBeUndefined();
    expect(p.requests[1]!.stop).toEqual(['END']);
  });

  test('native calls are collected in index order with their argument fragments; a call is output', async () => {
    const p = provider([
      { t: 'tool_start', i: 1, id: 'b', name: 'second' },
      { t: 'tool_start', i: 0, id: 'a', name: 'first' },
      { t: 'tool_args', i: 0, d: '{"q":' },
      { t: 'tool_args', i: 1, d: '{}' },
      { t: 'tool_args', i: 0, d: '"x"}' },
      { t: 'tool_end', i: 0 },
      { t: 'tool_end', i: 1 },
      { t: 'replay', r: { kind: 'tool_extra', connection: 'c', model: 'm', payload: { a: 1 } } },
      { t: 'finish', reason: 'end', raw: 'tool_calls' },
    ]);
    const res = await streamCall(callInput(conn(p)));
    expect(res.calls).toEqual([
      { id: 'a', name: 'first', args: '{"q":"x"}' },
      { id: 'b', name: 'second', args: '{}' },
    ]);
    expect(res.replay).toEqual([{ kind: 'tool_extra', connection: 'c', model: 'm', payload: { a: 1 } }]);
    expect(res.output).toBe(true);
    expect(res.text).toBe('');
  });

  test('a call still open when the stream fails is left out', async () => {
    const p = provider([
      { t: 'tool_start', i: 0, id: 'a', name: 'done' },
      { t: 'tool_end', i: 0 },
      { t: 'tool_start', i: 1, id: 'b', name: 'open' },
      { t: 'tool_args', i: 1, d: '{"q' },
    ]);
    const res = await streamCall(callInput(conn(p)));
    expect(res.error?.code).toBe('truncated_stream');
    expect(res.calls.map((c) => c.name)).toEqual(['done']);
  });

  test(`after the finish, ${FINISH_GRACE_MS} ms of silence end the call quietly: no error, no tail error`, async () => {
    const timers = manualTimers();
    const p = provider([{ t: 'text', i: 0, d: 'Hi' }, { t: 'finish', reason: 'end', raw: 'stop' }], true);
    const pending = streamCall(callInput(conn(p), { timers }));
    // Let the stream reach its hang, then let the grace run out.
    for (let i = 0; i < 20 && timers.fire(FINISH_GRACE_MS) === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const res = await pending;
    expect(res.finish).toEqual({ reason: 'end', raw: 'stop' });
    expect(res.text).toBe('Hi');
    expect(res.error).toBeUndefined();
    expect(res.tailError).toBeUndefined();
    expect(res.stopped).toBe(false);
  });

  test('an idle limit shorter than the grace still makes a stall after the finish a tail failure (M1b)', async () => {
    const timers = manualTimers();
    const p = provider([{ t: 'text', i: 0, d: 'Hi' }, { t: 'finish', reason: 'end', raw: 'stop' }], true);
    const pending = streamCall(callInput(conn(p), { timers, timeouts: { firstByteMs: 60_000, idleMs: 200 } }));
    for (let i = 0; i < 20 && timers.fire(200) === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const res = await pending;
    expect(res.finish?.reason).toBe('end');
    expect(res.tailError?.code).toBe('timeout');
  });
});

describe('narrateRounds against the call ceiling (B3)', () => {
  function input(script: ScriptCall[], callsBefore: number, log: ToolLog): { input: RoundsInput; requests: ModelRequest[] } {
    const p = createScriptedProvider(script);
    const c = conn(p);
    const tool = lookupTool(log);
    const tools: TurnTools = {
      transport: 'native',
      tools: new Map([[tool.name, tool]]),
      specs: [{ name: tool.name, description: tool.description, schema: tool.schema }],
      ctx: {
        view: {} as PathView,
        upTo: 'u',
        names: { char: 'Mira', user: 'Levi' },
        lore: [],
        compendium: EMPTY_COMPENDIUM,
        handles: new HandleTable(),
        inContext: () => false,
        now: '2026-10-26T12:00:00.000Z',
        rng: () => 0.5,
      },
      roomTokens: 2000,
      window: 8192,
      tokenFactor: 1,
    };
    const base = callInput(c);
    const { onText: _t, onReasoning: _r, onUsage: _u, callKey: _k, tools: _x, toolChoice: _c, stop: _s, ...rest } = base;
    return {
      requests: p.requests,
      input: {
        ...rest,
        turnId: 't',
        tools,
        maxRounds: MAX_TOOL_ROUNDS,
        callsBefore,
        onText: () => undefined,
        onReasoning: () => undefined,
        onTool: () => undefined,
        onCall: () => undefined,
        onNotice: () => undefined,
      },
    };
  }

  test(`${CALL_CEILING - 2} calls before: round 0 may call tools, round 1 is the final one (ended ceiling)`, async () => {
    const log: ToolLog = { runs: [] };
    const { input: i, requests } = input(calls([{ tool: { name: 'lookup', args: { q: 'a' } } }], [{ text: 'Done.' }]), CALL_CEILING - 2, log);
    const res = await narrateRounds(i);
    expect(requests.map((q) => q.toolChoice)).toEqual(['auto', 'none']);
    expect(res.ended).toBe('ceiling');
    expect(res.rounds).toBe(2);
    expect(res.text).toBe('Done.');
  });

  test(`${CALL_CEILING - 1} calls before: round 0 is already the final one`, async () => {
    const log: ToolLog = { runs: [] };
    const { input: i, requests } = input(calls([{ text: 'Done.' }]), CALL_CEILING - 1, log);
    const res = await narrateRounds(i);
    expect(requests.map((q) => q.toolChoice)).toEqual(['none']);
    // Round 0 has no cue (nothing ran before it).
    expect(requests[0]!.messages.some((m) => m.src === 'core:final_cue')).toBe(false);
    expect(res.ended).toBe('ceiling');
  });

  test('blocks, text and usage of a loop: text === concat(text blocks); firstUsage is round 0', async () => {
    const log: ToolLog = { runs: [] };
    const { input: i } = input(
      calls([{ text: 'A' }, { tool: { name: 'lookup', args: { q: 'a' } } }, { usage: { inputTotal: 10, outputTotal: 1 } }], [{ text: 'B' }, { usage: { inputTotal: 20, outputTotal: 2 } }]),
      0,
      log,
    );
    const res = await narrateRounds(i);
    expect(res.text).toBe(res.blocks.flatMap((b) => (b.k === 'text' ? [b.text] : [])).join(''));
    expect(res.firstUsage).toEqual({ inputTotal: 10, outputTotal: 1 });
    expect(res.usage).toEqual({ inputTotal: 30, outputTotal: 3 });
    expect(res.output).toBe(true);
  });
});

describe('helpers', () => {
  test('sumUsage: counts add up; cost only when every call has one; one usage is itself', () => {
    expect(sumUsage([])).toBeUndefined();
    const one = { inputTotal: 5, cost: 0.1 };
    expect(sumUsage([one])).toEqual(one);
    expect(sumUsage([one])).not.toBe(one);
    expect(sumUsage([{ inputTotal: 5, cost: 0.1 }, { inputTotal: 7, outputTotal: 2, cost: 0.2 }])).toEqual({ inputTotal: 12, outputTotal: 2, cost: 0.1 + 0.2 });
    expect(sumUsage([{ inputTotal: 5, cost: 0.1 }, { inputTotal: 7 }])).toEqual({ inputTotal: 12 });
  });

  test('promptedStops: sampler stops deduped, the prompted stop last and kept under stopMax', () => {
    expect(promptedStops(undefined)).toEqual([PROMPTED_STOP]);
    expect(promptedStops(['a', 'b', 'a', '', PROMPTED_STOP])).toEqual(['a', 'b', PROMPTED_STOP]);
    expect(promptedStops(['a', 'b', 'c'], 2)).toEqual(['a', PROMPTED_STOP]);
    expect(promptedStops(['a'], 1)).toEqual([PROMPTED_STOP]);
  });

  test('roundFields: native declares, prompted stops, none is M2', () => {
    const caps = capsWith('native');
    const tools = { transport: 'native', specs: [{ name: 'x', description: '', schema: {} }] } as unknown as TurnTools;
    expect(roundFields(null, caps, { stop: ['s'] }, false)).toEqual({});
    expect(roundFields(tools, caps, {}, false)).toEqual({ tools: tools.specs, toolChoice: 'auto' });
    expect(roundFields(tools, caps, {}, true)).toEqual({ tools: tools.specs, toolChoice: 'none' });
    expect(roundFields({ ...tools, transport: 'prompted' }, caps, { stop: ['s'] }, false)).toEqual({ stop: ['s', PROMPTED_STOP] });
  });

  test('roomChars: budget tokens back to characters at 2.5 per token', () => {
    expect(roomChars(1000, 1)).toBe(2500);
    expect(roomChars(1150, 1.15)).toBe(2500);
    expect(roomChars(-5, 1)).toBe(0);
  });

  test('continuedBlocks: M1 layout without tool blocks; the last text block grows with them', () => {
    expect(continuedBlocks([{ k: 'reasoning', text: 'r' }, { k: 'text', text: 'Hi.' }], 'Hi. More.')).toEqual([
      { k: 'reasoning', text: 'r' },
      { k: 'text', text: 'Hi. More.' },
    ]);
    const tool = [
      { k: 'text', text: 'A' },
      { k: 'tool_call', id: 'c', name: 'n', args: '{}' },
      { k: 'tool_result', callId: 'c', name: 'n', text: 'r' },
      { k: 'text', text: '\nB' },
    ] as const;
    expect(continuedBlocks([...tool], 'A\nB more')).toEqual([tool[0], tool[1], tool[2], { k: 'text', text: '\nB more' }]);
    // Text that no longer starts with the earlier blocks falls back to the M1 layout.
    expect(continuedBlocks([...tool], 'X')).toEqual([tool[1], tool[2], { k: 'text', text: 'X' }]);
  });

  test('clampRounds: 1..8, a larger value says what it was', () => {
    expect(clampRounds(4)).toEqual({ maxRounds: 4 });
    expect(clampRounds(0)).toEqual({ maxRounds: 1 });
    expect(clampRounds(20)).toEqual({ maxRounds: MAX_TOOL_ROUNDS, clamped: 20 });
    expect(clampRounds('x')).toEqual({ maxRounds: 1 });
  });
});
