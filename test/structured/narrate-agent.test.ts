// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M4 amendment of narrate.ts (m4-decisions D-98, D-101): CallInput.agent / responseSchema /
// onSlot, carried by modelRequest; the narrator's requests unchanged. And one wire test: the
// structured transport through the openai-chat adapter against a local server sends
// response_format, the tagged one does not, and a server that refuses it gives transport_unsupported.
import { describe, expect, test } from 'bun:test';
import { abortWith, realTimers } from '../../src/engine/abort.ts';
import type { Connection } from '../../src/engine/api.ts';
import { modelRequest, streamCall, type CallInput, type RequestFields } from '../../src/engine/narrate.ts';
import { createScheduler } from '../../src/engine/sched.ts';
import { chooseTransport, structuredCall, type AgentCallEvent } from '../../src/agents/structured.ts';
import { createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';
import { createScriptedProvider, SCRIPT_CAPS, scriptCapsWith } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import { drain, rig as engineRig, withUserMessage } from '../engine/kit.ts';
import { fakeClock, fakeRandom } from '../helpers.ts';
import { settle } from '../infra/fake-timers.ts';
import { calls, P, readPlanish, STRUCTURED_CAPS } from './kit.ts';

function fields(more: Partial<RequestFields> = {}): RequestFields {
  const provider = createScriptedProvider([]);
  return {
    conn: { id: 'c', provider, caps: SCRIPT_CAPS, origin: 'script:c', local: true },
    model: 'm',
    caps: SCRIPT_CAPS,
    messages: [{ role: 'user', blocks: [{ k: 'text', text: 'hi' }], src: 'history' }],
    maxTokens: 100,
    samplers: { temperature: 0.5 },
    callKey: 't:narrator:0',
    ...more,
  };
}

describe('modelRequest', () => {
  test("without the M4 fields: the narrator's request, key for key (agent 'narrator', no responseSchema)", () => {
    const signal = new AbortController().signal;
    const req = modelRequest(fields(), signal);
    expect(Object.keys(req)).toEqual(['model', 'caps', 'messages', 'maxTokens', 'samplers', 'signal', 'callKey', 'agent']);
    expect(req.agent).toBe('narrator');
    expect('responseSchema' in req).toBe(false);
  });

  test('agent and responseSchema are carried as given', () => {
    const schema = { name: 'plan', schema: { type: 'object' } };
    const req = modelRequest(fields({ agent: 'director', responseSchema: schema, callKey: 't:director:0' }), new AbortController().signal);
    expect(req.agent).toBe('director');
    expect(req.responseSchema).toEqual(schema);
    expect(req.callKey).toBe('t:director:0');
  });

  test('a narrator turn still sends agent narrator and no responseSchema', async () => {
    const r = await engineRig(calls([{ text: 'The lamp flickers.' }]));
    const { s, version } = withUserMessage(r.engine);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    expect(r.provider.requests.map((q) => [q.agent, q.responseSchema])).toEqual([['narrator', undefined]]);
    await r.engine.close();
  });
});

describe('streamCall onSlot (D-101)', () => {
  function input(more: Partial<CallInput> & Pick<CallInput, 'conn' | 'sched'>): CallInput {
    return {
      model: 'm',
      caps: more.conn.caps,
      messages: [{ role: 'user', blocks: [{ k: 'text', text: 'hi' }], src: 'history' }],
      maxTokens: 100,
      samplers: {},
      callKey: 't:director:0',
      turnSignal: new AbortController().signal,
      fetch,
      timeouts: { firstByteMs: 60_000, idleMs: 60_000 },
      timers: realTimers,
      clock: fakeClock(),
      onText: () => undefined,
      onReasoning: () => undefined,
      ...more,
    };
  }
  const conn = (script = calls([{ text: 'ok' }])): Connection => ({ id: 'c', provider: createScriptedProvider(script), caps: SCRIPT_CAPS, origin: 'script:c', local: true });

  test('called once, only after the slot is held (not while queued)', async () => {
    const sched = createScheduler();
    const held = await sched.forOrigin('script:c', 1).acquire('interactive');
    const seen: string[] = [];
    const pending = streamCall(input({ conn: conn(), sched, onSlot: () => void seen.push('slot') }));
    await settle();
    expect(seen).toEqual([]);
    held.release();
    const res = await pending;
    expect(seen).toEqual(['slot']);
    expect(res.text).toBe('ok');
  });

  test('a call stopped in the queue never gets a slot: onSlot is not called', async () => {
    const sched = createScheduler();
    const held = await sched.forOrigin('script:c', 1).acquire('interactive');
    const stop = new AbortController();
    let slots = 0;
    const pending = streamCall(input({ conn: conn(), sched, turnSignal: stop.signal, onSlot: () => void slots++ }));
    await settle();
    abortWith(stop, 'user_stop');
    expect((await pending).stopped).toBe(true);
    expect(slots).toBe(0);
    held.release();
  });

  test('a throwing onSlot gives the place back before the error propagates', async () => {
    const sched = createScheduler();
    const c = conn();
    await expect(
      streamCall(
        input({
          conn: c,
          sched,
          onSlot: () => {
            throw new Error('bug');
          },
        }),
      ),
    ).rejects.toThrow('bug');
    expect(sched.forOrigin('script:c', 1).inFlight()).toBe(0);
  });
});

describe('the structured transport on the wire (openai-chat against a local server)', () => {
  /** A local OpenAI-compatible server: records each body; refuses response_format when `refuse`. */
  function server(answer: string, refuse = false) {
    const bodies: Record<string, unknown>[] = [];
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const b = (await req.json()) as Record<string, unknown>;
        bodies.push(b);
        if (refuse && b['response_format'] !== undefined) return Response.json({ error: { message: 'response_format is not supported' } }, { status: 400 });
        const ch = (delta: object, finish: string | null = null) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
        const usage = { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } };
        const chunks = [ch({ role: 'assistant', content: answer }), ch({}, 'stop'), usage];
        return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    return { srv, bodies };
  }

  async function run(caps: ModelCaps, answer: string, refuse = false) {
    const { srv, bodies } = server(answer, refuse);
    try {
      const provider = createOpenAIChatProvider({ connectionId: 'local', baseUrl: `http://127.0.0.1:${srv.port}/v1`, local: true });
      const conn: Connection = { id: 'local', provider, caps, origin: `http://127.0.0.1:${srv.port}`, local: true, dialect: 'openai-chat' };
      const events: AgentCallEvent[] = [];
      const out = await structuredCall({
        agent: 'director',
        schema: { name: 'plan', schema: { type: 'object', properties: { directive: { type: 'object' } }, required: ['directive'] } },
        read: readPlanish,
        system: 'You plan the story.',
        user: ['Plan this turn.'],
        tag: 'plan',
        route: { conn, model: 'qwen3:14b', caps },
        transport: chooseTransport(caps),
        samplers: { temperature: 0.7 },
        maxTokens: 1500,
        repair: true,
        callKeyPrefix: 't_1:director',
        budgetMs: 30_000,
        turnSignal: new AbortController().signal,
        env: { sched: createScheduler(), fetch, timeouts: { firstByteMs: 30_000, idleMs: 30_000 }, timers: realTimers, clock: fakeClock(), random: fakeRandom(1), retryMaxDelayMs: 5, emit: (ev) => void events.push(ev) },
      });
      return { out, bodies, events };
    } finally {
      srv.stop(true);
    }
  }

  test('structured: the body carries response_format json_schema with the schema; the answer is read', async () => {
    const { out, bodies, events } = await run(STRUCTURED_CAPS, P);
    expect(out.ok && out.value.directive).toEqual({ mood: 'tense' });
    expect(out.ok && out.transport).toBe('structured');
    expect(bodies[0]!['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'plan', schema: { type: 'object', properties: { directive: { type: 'object' } }, required: ['directive'] } },
    });
    expect(bodies[0]!['tools']).toBeUndefined();
    expect(bodies[0]!['tool_choice']).toBeUndefined();
    expect(bodies[0]!['temperature']).toBe(0.7);
    expect(events).toEqual([
      { type: 'usage', callKey: 't_1:director:0', agent: 'director', model: 'local:qwen3:14b', usage: { inputTotal: 40, outputTotal: 9 }, costUsd: null, priceSource: 'none' },
    ]);
  });

  test('tagged: no response_format; the <plan> block is read from the streamed text', async () => {
    const { out, bodies } = await run(scriptCapsWith(), `<plan>${P}</plan>`);
    expect(out.ok && out.transport).toBe('tagged');
    expect(bodies[0]!['response_format']).toBeUndefined();
  });

  test('a server that refuses response_format with HTTP 400: transport_unsupported, one request', async () => {
    const { out, bodies } = await run(STRUCTURED_CAPS, P, true);
    expect(out.ok ? 'ok' : out.code).toBe('transport_unsupported');
    expect(out.attempts.map((a) => [a.outcome, a.status])).toEqual([['transport_unsupported', 400]]);
    expect(bodies.length).toBe(1);
  });
});
