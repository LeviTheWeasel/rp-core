import { describe, expect, test } from 'bun:test';
import { abortWith, TypedAbort } from '../../src/engine/abort.ts';
import {
  categoryOf,
  createScriptedProvider,
  hashRequest,
  parseScript,
  SCRIPT_CAPS,
  type ScriptCall,
} from '../../src/providers/scripted.ts';
import { ProviderError, type ModelRequest, type ProviderEnv, type StreamEv } from '../../src/providers/types.ts';
import { fakeTimers, settle } from './fake-timers.ts';

const env: ProviderEnv = { fetch, key: null };

function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: { connection: 'script', model: 'script' },
    caps: SCRIPT_CAPS,
    messages: [
      { role: 'system', blocks: [{ k: 'text', text: 'You are Vera.' }], src: 'main' },
      { role: 'user', blocks: [{ k: 'text', text: 'Any storms?' }], src: 'history' },
    ],
    maxTokens: 256,
    samplers: { temperature: 0.8 },
    signal: new AbortController().signal,
    callKey: 'turn-1:narrator:0',
    agent: 'narrator',
    ...over,
  };
}

async function collect(it: AsyncIterable<StreamEv>): Promise<StreamEv[]> {
  const out: StreamEv[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

/** Start draining a stream; `state()` says whether it has finished yet. */
function drain(it: AsyncIterable<StreamEv>) {
  let finished = false;
  const promise = collect(it).finally(() => {
    finished = true;
  });
  return { promise, finished: () => finished };
}

function one(steps: ScriptCall['steps']) {
  return createScriptedProvider([{ steps }]);
}

function errorOf(evs: StreamEv[]): ProviderError {
  const last = evs[evs.length - 1];
  if (last?.t !== 'error') throw new Error(`expected an error event, got ${JSON.stringify(last)}`);
  return last.err;
}

describe('parseScript', () => {
  test('one call per non-empty line, both forms, CRLF and blank lines', () => {
    const hash = 'a'.repeat(16);
    const calls = parseScript(
      `﻿[{"text":"Hi"},{"finish":"length"}]\r\n\n   \n{"steps":[{"reasoning":"hm"}],"requestHash":"${hash}"}\n`,
    );
    expect(calls).toEqual([
      { steps: [{ text: 'Hi' }, { finish: 'length' }] },
      { steps: [{ reasoning: 'hm' }], requestHash: hash },
    ]);
  });

  test('every step kind parses', () => {
    const [call] = parseScript(
      JSON.stringify([
        { text: 'a' },
        { reasoning: 'b' },
        { tool: { name: 'roll', args: { sides: 20 }, id: 'x1' } },
        { tool: { name: 'look' } },
        { delay: 5 },
        { pause: 'p' },
        { usage: { inputTotal: 10, outputTotal: 3, cost: 0 } },
        { error: { code: 'overloaded', status: 529, afterOutput: false, retryAfterSec: 2, message: 'busy' } },
        { cut: true },
        { finish: 'refusal' },
      ]),
    );
    expect(call?.steps).toEqual([
      { text: 'a' },
      { reasoning: 'b' },
      { tool: { name: 'roll', args: { sides: 20 }, id: 'x1' } },
      { tool: { name: 'look', args: {} } },
      { delay: 5 },
      { pause: 'p' },
      { usage: { inputTotal: 10, outputTotal: 3, cost: 0 } },
      { error: { code: 'overloaded', status: 529, afterOutput: false, retryAfterSec: 2, message: 'busy' } },
      { cut: true },
      { finish: 'refusal' },
    ]);
  });

  const bad: [string, string, RegExp][] = [
    ['invalid JSON', '[{"text":"ok"}]\n\n[{"text":', /^script line 3: invalid JSON/],
    ['scalar call', '42', /^script line 1: a call must be/],
    ['unknown call field', '{"steps":[],"hash":"x"}', /line 1: unknown field "hash"/],
    ['steps not an array', '{"steps":{}}', /line 1: "steps" must be an array/],
    ['bad requestHash', '{"steps":[],"requestHash":"ABC"}', /line 1: "requestHash" must be 16 lowercase hex/],
    ['unknown step', '[{"text":"a"},{"txt":"b"}]', /^script line 1: step 2: unknown step "txt"/],
    ['two keys in a step', '[{"text":"a","delay":1}]', /step 1: a step must have exactly one key, got text, delay/],
    ['empty step', '[{}]', /step 1: a step must have exactly one key, got none/],
    ['step not an object', '["hi"]', /step 1: a step must be an object/],
    ['text not a string', '[{"text":3}]', /step 1: "text" must be a string/],
    ['tool without name', '[{"tool":{"args":{}}}]', /tool.name must be a non-empty string/],
    ['tool unknown field', '[{"tool":{"name":"a","arguments":{}}}]', /unknown field "arguments"/],
    ['negative delay', '[{"delay":-1}]', /"delay" must be a number of ms >= 0/],
    ['empty pause', '[{"pause":""}]', /"pause" must be a non-empty name/],
    ['unknown error code', '[{"error":{"code":"teapot"}}]', /unknown error code "teapot"/],
    ['error typo', '[{"error":{"code":"timeout","afterOuput":true}}]', /unknown field "afterOuput"/],
    ['bad status', '[{"error":{"code":"overloaded","status":42}}]', /error.status must be an HTTP status/],
    ['unknown usage field', '[{"usage":{"tokens":3}}]', /unknown usage field "tokens"/],
    ['negative usage', '[{"usage":{"outputTotal":-3}}]', /usage.outputTotal must be a number >= 0/],
    ['cut false', '[{"cut":false}]', /"cut" must be true/],
    ['unknown finish', '[{"finish":"stop"}]', /unknown finish reason "stop"/],
  ];
  for (const [name, text, re] of bad) {
    test(`rejects ${name} with its line number`, () => {
      expect(() => parseScript(text)).toThrow(re);
    });
  }
});

describe('hashRequest', () => {
  test('16 hex chars, stable under key order and bookkeeping fields', () => {
    const h = hashRequest(req());
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    const reordered = req({ samplers: { temperature: 0.8 }, callKey: 'other', agent: 'director' });
    reordered.messages = reordered.messages.map((m) => ({ src: 'elsewhere', blocks: m.blocks, role: m.role }));
    expect(hashRequest(reordered)).toBe(h);
  });

  test('changes with anything the model sees', () => {
    const h = hashRequest(req());
    expect(hashRequest(req({ maxTokens: 512 }))).not.toBe(h);
    expect(hashRequest(req({ prefill: 'Vera:' }))).not.toBe(h);
    expect(hashRequest(req({ samplers: { temperature: 0.9 } }))).not.toBe(h);
    expect(hashRequest(req({ tools: [{ name: 'roll', description: 'dice', schema: {} }] }))).not.toBe(h);
    const edited = req();
    edited.messages = [...edited.messages, { role: 'assistant', blocks: [{ k: 'text', text: '…' }], src: 'history' }];
    expect(hashRequest(edited)).not.toBe(h);
  });
});

describe('scripted provider', () => {
  test('text, reasoning, usage and the default finish', async () => {
    const p = one([{ reasoning: 'Clouds.' }, { text: 'Storms' }, { text: ' tonight.' }, { usage: { outputTotal: 3 } }]);
    expect(await collect(p.stream(req(), env))).toEqual([
      { t: 'reasoning', i: 0, d: 'Clouds.' },
      { t: 'text', i: 0, d: 'Storms' },
      { t: 'text', i: 0, d: ' tonight.' },
      { t: 'usage', u: { outputTotal: 3 } },
      { t: 'finish', reason: 'end', raw: 'end' },
    ]);
  });

  test('tool calls get increasing indices and JSON args; ids default deterministically', async () => {
    const p = one([
      { tool: { name: 'roll', args: { sides: 20 } } },
      { tool: { name: 'look', args: {}, id: 'given' } },
    ]);
    expect(await collect(p.stream(req(), env))).toEqual([
      { t: 'tool_start', i: 0, id: 'call_1_0', name: 'roll' },
      { t: 'tool_args', i: 0, d: '{"sides":20}' },
      { t: 'tool_end', i: 0 },
      { t: 'tool_start', i: 1, id: 'given', name: 'look' },
      { t: 'tool_args', i: 1, d: '{}' },
      { t: 'tool_end', i: 1 },
      { t: 'finish', reason: 'end', raw: 'end' },
    ]);
  });

  test('finish overrides the reason; cut ends with no finish', async () => {
    const p = createScriptedProvider([
      { steps: [{ finish: 'length' }, { text: 'cut off' }] },
      { steps: [{ text: 'half' }, { cut: true }, { text: 'never' }] },
    ]);
    expect(await collect(p.stream(req(), env))).toEqual([
      { t: 'text', i: 0, d: 'cut off' },
      { t: 'finish', reason: 'length', raw: 'length' },
    ]);
    expect(await collect(p.stream(req(), env))).toEqual([{ t: 'text', i: 0, d: 'half' }]);
  });

  test('error: category by code, fields kept, nothing after it', async () => {
    const p = one([
      { error: { code: 'rate_limited', status: 429, retryAfterSec: 3, message: 'slow down' } },
      { text: 'never' },
    ]);
    const evs = await collect(p.stream(req(), env));
    expect(evs.length).toBe(1);
    const err = errorOf(evs);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.category).toBe('rate');
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(3);
    expect(err.message).toBe('slow down');
    expect(err.afterOutput).toBe(false);
    expect(evs[0]).toMatchObject({ t: 'error', afterOutput: false });
  });

  test('error afterOutput defaults to whether output was produced, and can be forced', async () => {
    const p = createScriptedProvider([
      { steps: [{ text: 'Sto' }, { error: { code: 'truncated_stream' } }] },
      { steps: [{ usage: { inputTotal: 1 } }, { error: { code: 'overloaded', status: 503 } }] },
      { steps: [{ error: { code: 'timeout', afterOutput: true } }] },
    ]);
    const a = await collect(p.stream(req(), env));
    expect(a[a.length - 1]).toMatchObject({ t: 'error', afterOutput: true });
    expect(errorOf(a)).toMatchObject({ category: 'network', afterOutput: true });
    const b = await collect(p.stream(req(), env));
    expect(b[b.length - 1]).toMatchObject({ t: 'error', afterOutput: false });
    expect(errorOf(b).category).toBe('server');
    const c = await collect(p.stream(req(), env));
    expect(errorOf(c).afterOutput).toBe(true);
  });

  test('category table', () => {
    expect(categoryOf('auth_failed')).toBe('auth');
    for (const code of [
      'model_not_found',
      'bad_request',
      'context_length_exceeded',
      'prefill_unsupported',
      'forced_tool_unsupported',
      'tool_protocol_invalid',
      'script_exhausted',
    ] as const) {
      expect(categoryOf(code)).toBe('request');
    }
    expect(categoryOf('rate_limited')).toBe('rate');
    expect(categoryOf('overloaded')).toBe('server');
    for (const code of ['unreachable', 'timeout', 'truncated_stream'] as const) expect(categoryOf(code)).toBe('network');
    for (const code of ['content_filter', 'refusal'] as const) expect(categoryOf(code)).toBe('content');
    for (const code of ['empty_response', 'reasoning_only', 'thinking_signature_mismatch'] as const) {
      expect(categoryOf(code)).toBe('protocol');
    }
  });

  test('records requests at call time and fails with script_exhausted when calls run out', async () => {
    const p = createScriptedProvider([{ steps: [{ text: 'only' }] }]);
    expect(p.remaining()).toBe(1);
    const first = req();
    const s1 = p.stream(first, env);
    expect(p.requests).toEqual([first]);
    expect(p.remaining()).toBe(0);
    await collect(s1);
    const evs = await collect(p.stream(req(), env));
    const err = errorOf(evs);
    expect(err.code).toBe('script_exhausted');
    expect(err.category).toBe('request');
    expect(err.message).toMatch(/request 2 has no call left/);
    expect(p.requests.length).toBe(2);
    expect(p.remaining()).toBe(0);
  });

  test('requestHash: a match plays the call, a mismatch fails loudly with both hashes', async () => {
    const good = hashRequest(req());
    const p = createScriptedProvider([
      { steps: [{ text: 'ok' }], requestHash: good },
      { steps: [{ text: 'never' }], requestHash: good },
    ]);
    expect(await collect(p.stream(req(), env))).toEqual([
      { t: 'text', i: 0, d: 'ok' },
      { t: 'finish', reason: 'end', raw: 'end' },
    ]);
    const other = req({ maxTokens: 999 });
    const evs = await collect(p.stream(other, env));
    expect(evs.length).toBe(1);
    const err = errorOf(evs);
    expect(err.code).toBe('bad_request');
    expect(err.category).toBe('request');
    expect(err.message).toContain(`expected ${good}`);
    expect(err.message).toContain(`actual ${hashRequest(other)}`);
    expect(err.message).toContain('maxTokens 999');
    // The hint never echoes prompt text.
    expect(err.message).not.toContain('Any storms?');
  });

  test('delay waits on the injected timers', async () => {
    const timers = fakeTimers();
    const p = createScriptedProvider([{ steps: [{ text: 'a' }, { delay: 100 }, { text: 'b' }] }], { timers });
    const run = drain(p.stream(req(), env));
    await settle();
    expect(run.finished()).toBe(false);
    expect(timers.pending()).toBe(1);
    timers.advance(100);
    expect(await run.promise).toEqual([
      { t: 'text', i: 0, d: 'a' },
      { t: 'text', i: 0, d: 'b' },
      { t: 'finish', reason: 'end', raw: 'end' },
    ]);
  });

  test('abort mid-delay throws the TypedAbort and clears the timer', async () => {
    const timers = fakeTimers();
    const ctl = new AbortController();
    const p = createScriptedProvider([{ steps: [{ text: 'a' }, { delay: 10_000 }, { text: 'b' }] }], { timers });
    const seen: StreamEv[] = [];
    const run = (async () => {
      for await (const ev of p.stream(req({ signal: ctl.signal }), env)) seen.push(ev);
    })();
    await settle();
    abortWith(ctl, 'user_stop');
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypedAbort);
    expect((err as TypedAbort).reason).toBe('user_stop');
    expect(seen).toEqual([{ t: 'text', i: 0, d: 'a' }]);
    expect(timers.pending()).toBe(0);
  });

  test('pause holds the stream until release', async () => {
    const p = one([{ text: 'a' }, { pause: 'gate' }, { text: 'b' }]);
    const run = drain(p.stream(req(), env));
    await settle();
    expect(run.finished()).toBe(false);
    p.release('other');
    await settle();
    expect(run.finished()).toBe(false);
    p.release('gate');
    expect((await run.promise).map((e) => e.t)).toEqual(['text', 'text', 'finish']);
  });

  test('a release before the pause is remembered', async () => {
    const p = one([{ pause: 'gate' }, { text: 'b' }]);
    p.release('gate');
    expect((await collect(p.stream(req(), env))).map((e) => e.t)).toEqual(['text', 'finish']);
  });

  test('each release lets exactly one pause through', async () => {
    const p = createScriptedProvider([
      { steps: [{ pause: 'g' }, { text: '1' }] },
      { steps: [{ pause: 'g' }, { text: '2' }] },
    ]);
    const a = drain(p.stream(req(), env));
    const b = drain(p.stream(req(), env));
    await settle();
    p.release('g');
    await a.promise;
    await settle();
    expect(b.finished()).toBe(false);
    p.release('g');
    expect((await b.promise)[0]).toEqual({ t: 'text', i: 0, d: '2' });
  });

  test('abort mid-pause throws the TypedAbort and does not swallow a later release', async () => {
    const ctl = new AbortController();
    const p = createScriptedProvider([{ steps: [{ pause: 'g' }, { text: 'x' }] }, { steps: [{ pause: 'g' }, { text: 'y' }] }]);
    const run = collect(p.stream(req({ signal: ctl.signal }), env));
    await settle();
    abortWith(ctl, 'timeout:idle');
    const err = await run.catch((e: unknown) => e);
    expect((err as TypedAbort).reason).toBe('timeout:idle');
    // The aborted waiter left the queue, so this release is banked for the next pause.
    p.release('g');
    expect((await collect(p.stream(req(), env)))[0]).toEqual({ t: 'text', i: 0, d: 'y' });
  });

  test('an abort between events surfaces on the next pull', async () => {
    const ctl = new AbortController();
    const p = one([{ text: 'a' }, { text: 'b' }]);
    const it = p.stream(req({ signal: ctl.signal }), env)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ t: 'text', i: 0, d: 'a' });
    abortWith(ctl, 'user_stop');
    const err = await it.next().catch((e: unknown) => e);
    expect((err as TypedAbort).reason).toBe('user_stop');
  });

  test('an already aborted signal throws before any event', async () => {
    const ctl = new AbortController();
    abortWith(ctl, 'shutdown');
    const p = one([{ text: 'a' }]);
    const err = await collect(p.stream(req({ signal: ctl.signal }), env)).catch((e: unknown) => e);
    expect((err as TypedAbort).reason).toBe('shutdown');
    // The call was still consumed: the engine asked for it.
    expect(p.remaining()).toBe(0);
  });

  test('an empty call is a bare finish (the engine decides it is empty_response)', async () => {
    expect(await collect(one([]).stream(req(), env))).toEqual([{ t: 'finish', reason: 'end', raw: 'end' }]);
  });

  test('a script parsed from JSONL plays end to end', async () => {
    const p = createScriptedProvider(parseScript('[{"text":"Hi"}]\n[{"error":{"code":"refusal"}}]\n'));
    expect((await collect(p.stream(req(), env))).map((e) => e.t)).toEqual(['text', 'finish']);
    expect(errorOf(await collect(p.stream(req(), env))).category).toBe('content');
  });
});
