// Ported from Bunraku:src/studio/scene-director-call.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (the "one budget for the whole turn" cases), rewritten on structuredCall with fake timers.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// structuredCall (m4-decisions D-98, D-99, D-101): the transport choice, the corrective pass, the
// §6.6 retry, transport_unsupported, the budget from the first semaphore slot, Stop, and what every
// call leaves behind (callKey, agent, trace rows, usage events, attempts).
import { describe, expect, test } from 'bun:test';
import { abortWith, reasonOf } from '../../src/engine/abort.ts';
import { createScheduler } from '../../src/engine/sched.ts';
import { chooseTransport, correctionEcho, correctionReason, correctionText, STRUCTURED_REFUSED_KEY, structuredRefusedMessage } from '../../src/agents/structured.ts';
import { SCRIPT_CAPS, scriptCapsWith } from '../../src/providers/scripted.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import { calls, P, rig, STRUCTURED_CAPS, textOfMsg } from './kit.ts';

const PLAN = `<plan>${P}</plan>`;
/** Http deadlines far beyond the budgets under test (Bunraku's calls had none). */
const SLOW = { firstByteMs: 10_000_000, idleMs: 10_000_000 };
const TAGGED_FIX = (reason: string): string =>
  `Your answer had no usable plan (${reason}). Answer again with exactly one <plan>…</plan> block that holds one JSON object following the schema above, with a directive that sets at least one field. Write nothing else.`;

describe('chooseTransport', () => {
  test("structured only where json_schema output is confirmed (host, probe or user); else tagged", () => {
    expect(chooseTransport(SCRIPT_CAPS)).toBe('tagged');
    expect(chooseTransport(scriptCapsWith({ structuredOutput: { mode: 'json_schema' } }))).toBe('tagged');
    for (const by of ['host', 'probe', 'user'] as const) {
      expect(chooseTransport(scriptCapsWith({ structuredOutput: { mode: 'json_schema', confirmedBy: by } }))).toBe('structured');
    }
    expect(chooseTransport(scriptCapsWith({ structuredOutput: { mode: 'none', confirmedBy: 'user' } }))).toBe('tagged');
  });
});

describe('the request', () => {
  test('structured: responseSchema rides the request; agent, callKey, samplers, maxTokens, reasoning as given; no tools, no prefill', async () => {
    const r = rig(calls([{ text: P }]), { caps: STRUCTURED_CAPS, input: { reasoning: 'none', samplers: { temperature: 0.7, stop: ['###'] } } });
    const out = await r.run();
    expect(out.ok && out.transport).toBe('structured');
    const [q] = r.provider.requests;
    expect(q!.responseSchema).toEqual(r.input.schema);
    expect(q!.agent).toBe('director');
    expect(q!.callKey).toBe('t_1:director:0');
    expect(q!.samplers).toEqual({ temperature: 0.7, stop: ['###'] });
    expect(q!.stop).toEqual(['###']);
    expect(q!.maxTokens).toBe(1500);
    expect(q!.reasoning).toBe('none');
    expect(q!.tools).toBeUndefined();
    expect(q!.toolChoice).toBeUndefined();
    expect(q!.prefill).toBeUndefined();
  });

  test('tagged: no responseSchema; system then the user messages in order, a blank one not sent', async () => {
    const r = rig(calls([{ text: PLAN }]), { input: { user: ['Plan this turn.', '  ', 'Pressures: none.'] } });
    await r.run();
    const [q] = r.provider.requests;
    expect(q!.responseSchema).toBeUndefined();
    expect(q!.messages.map((m) => [m.role, m.src, textOfMsg(m)])).toEqual([
      ['system', 'director:system', 'You plan the story.'],
      ['user', 'director:user', 'Plan this turn.'],
      ['user', 'director:user', 'Pressures: none.'],
    ]);
  });

  test('strict alternation: the user messages go as one', async () => {
    const r = rig(calls([{ text: PLAN }]), { caps: scriptCapsWith({ alternation: 'strict' }), input: { user: ['Plan this turn.', 'Pressures: none.'] } });
    await r.run();
    expect(r.provider.requests[0]!.messages.map((m) => [m.role, textOfMsg(m)])).toEqual([
      ['system', 'You plan the story.'],
      ['user', 'Plan this turn.\n\nPressures: none.'],
    ]);
  });

  test('the text and reasoning are collected silently: no text events, only usage', async () => {
    const r = rig(calls([{ reasoning: 'thinking' }, { text: PLAN }, { usage: { inputTotal: 900, outputTotal: 40 } }]));
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(['usage']);
  });
});

describe('the corrective pass (D-98, D-99)', () => {
  test('first bad, then good: ok, two attempts, the second request = the first + the echo + the correction', async () => {
    const r = rig(calls([{ text: 'I think the scene should be tense.' }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok && out.value.directive).toEqual({ mood: 'tense' });
    expect(out.attempts.map((a) => a.outcome)).toEqual(['no_output', 'ok']);
    const [q0, q1] = r.provider.requests;
    expect(q1!.messages.slice(0, q0!.messages.length)).toEqual(q0!.messages);
    expect(q1!.messages.slice(q0!.messages.length).map((m) => [m.role, m.src, textOfMsg(m)])).toEqual([
      ['assistant', 'director:answer', 'I think the scene should be tense.'],
      ['user', 'director:correction', TAGGED_FIX('no plan block was found')],
    ]);
    expect(q1!.callKey).toBe('t_1:director:1');
  });

  test('first bad, then bad: the LAST attempt decides the code', async () => {
    const r = rig(calls([{ text: 'prose' }], [{ text: '<plan>{"directive":{"mood":"te' }]));
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('undecodable');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['no_output', 'undecodable']);
    expect(r.provider.requests.length).toBe(2);
  });

  test('repair: false: no second call', async () => {
    const r = rig(calls([{ text: 'prose' }], [{ text: PLAN }]), { input: { repair: false } });
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('no_output');
    expect(r.provider.requests.length).toBe(1);
    expect(r.provider.remaining()).toBe(1);
  });

  test('read() failing with missing_directive → correction ("the directive was empty") → ok', async () => {
    const r = rig(calls([{ text: '<plan>{"directive":{}}</plan>' }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['missing_directive', 'ok']);
    expect(textOfMsg(r.provider.requests[1]!.messages.at(-1)!)).toBe(TAGGED_FIX('the directive was empty'));
  });

  test("read() failing with invalid: the correction quotes read()'s message, cut to 200", async () => {
    const r = rig(calls([{ text: '<plan>{"directive":"be tense"}</plan>' }], [{ text: PLAN }]));
    expect((await r.run()).ok).toBe(true);
    expect(textOfMsg(r.provider.requests[1]!.messages.at(-1)!)).toBe(TAGGED_FIX('directive must be an object, not a string'));
    expect(correctionReason('invalid', 'x'.repeat(300), 'plan', 'tagged')).toBe('x'.repeat(200));
    expect(correctionReason('invalid', '  ', 'plan', 'tagged')).toBe('the answer did not follow the schema');
  });

  test('the structured wording, and the undecodable reason', async () => {
    const r = rig(calls([{ text: '{"directive":{"mood":"te' }, { finish: 'length' }], [{ text: P }]), { caps: STRUCTURED_CAPS });
    expect((await r.run()).ok).toBe(true);
    expect(textOfMsg(r.provider.requests[1]!.messages.at(-1)!)).toBe(
      'Your answer was not a usable plan (the JSON could not be read). Answer again with one JSON object following the schema, with a directive that sets at least one field.',
    );
    // The correction keeps the transport: the schema rides the second request too.
    expect(r.provider.requests[1]!.responseSchema).toEqual(r.input.schema);
  });

  test('the echo: the visible text, else the reasoning, cut to its first 1 000 characters; "(no text)" when both are empty', async () => {
    const long = 'Мира смотрит на карту. '.repeat(80);
    const r = rig(calls([{ text: long }], [{ text: PLAN }]));
    await r.run();
    const echo = textOfMsg(r.provider.requests[1]!.messages.at(-2)!);
    expect(echo).toBe(long.slice(0, 1000));
    expect(correctionEcho({ text: '', reasoning: 'I was thinking.' })).toBe('I was thinking.');
    expect(correctionEcho({ text: '  ', reasoning: '' })).toBe('(no text)');
    // A surrogate pair is never split at the cut.
    expect(correctionEcho({ text: `${'a'.repeat(999)}😀tail`, reasoning: '' })).toBe('a'.repeat(999));

    const empty = rig(calls([{ text: '' }], [{ text: PLAN }]));
    await empty.run();
    expect(textOfMsg(empty.provider.requests[1]!.messages.at(-2)!)).toBe('(no text)');
  });

  test('the texts for tag:null agents', () => {
    expect(correctionText('no JSON object was found', null, 'tagged')).toBe(
      'Your answer was not usable (no JSON object was found). Answer again with exactly one JSON object following the schema above. Write nothing else.',
    );
    expect(correctionText('the JSON could not be read', null, 'structured')).toBe(
      'Your answer was not usable (the JSON could not be read). Answer again with one JSON object following the schema.',
    );
  });

  test('no correction after a provider error', async () => {
    const r = rig(calls([{ error: { code: 'auth_failed', status: 401 } }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok ? 'ok' : [out.code, out.message]).toEqual(['provider_error', 'auth_failed']);
    expect(out.attempts).toEqual([{ transport: 'tagged', outcome: 'provider_error', ms: expect.any(Number), status: 401 }]);
    expect(r.provider.requests.length).toBe(1);
    expect(r.tapped.map((t) => [t.callKey, t.model, t.error.code])).toEqual([['t_1:director:0', 'dir:m', 'auth_failed']]);
  });
});

describe('provider errors: the shared §6.6 retry only', () => {
  test('429, then ok: a retry event with the failed call\'s key, two attempts', async () => {
    const r = rig(calls([{ error: { code: 'rate_limited', status: 429 } }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(out.attempts.map((a) => [a.outcome, a.status])).toEqual([
      ['retried', 429],
      ['ok', undefined],
    ]);
    expect(r.events).toEqual([{ type: 'retry', callKey: 't_1:director:0', attempt: 1, delayMs: expect.any(Number), code: 'rate_limited', status: 429 }]);
    expect(r.provider.requests.map((q) => q.callKey)).toEqual(['t_1:director:0', 't_1:director:1']);
  });

  test('429, then a bad answer: the corrective pass is still allowed (and may retry once itself)', async () => {
    const r = rig(calls([{ error: { code: 'rate_limited', status: 429 } }], [{ text: 'prose' }], [{ error: { code: 'overloaded', status: 503 } }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['retried', 'no_output', 'retried', 'ok']);
    expect(r.provider.requests.map((q) => q.callKey)).toEqual(['t_1:director:0', 't_1:director:1', 't_1:director:2', 't_1:director:3']);
    expect(r.events.map((e) => e.type === 'retry' && e.callKey)).toEqual(['t_1:director:0', 't_1:director:2']);
    // The correction follows the first pass's answer, not the refused call.
    expect(r.provider.requests[3]!.messages.length).toBe(r.provider.requests[1]!.messages.length + 2);
  });

  test('429 twice: provider_error, no third call, no correction', async () => {
    const r = rig(calls([{ error: { code: 'rate_limited', status: 429 } }], [{ error: { code: 'rate_limited', status: 429 } }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('provider_error');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['retried', 'provider_error']);
    expect(r.provider.requests.length).toBe(2);
  });

  test('a failure after output is not retried', async () => {
    const r = rig(calls([{ text: '<plan>{"dir' }, { error: { code: 'overloaded', status: 503 } }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('provider_error');
    expect(r.provider.requests.length).toBe(1);
  });

  test('HTTP 400 on the structured transport: transport_unsupported (no switch to tagged, no correction)', async () => {
    const r = rig(calls([{ error: { code: 'bad_request', status: 400 } }], [{ text: PLAN }]), { caps: STRUCTURED_CAPS });
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('transport_unsupported');
    expect(out.attempts.map((a) => [a.transport, a.outcome, a.status])).toEqual([['structured', 'transport_unsupported', 400]]);
    expect(r.provider.requests.length).toBe(1);
  });

  test("the engine's caps.suggest notice for a refused structured transport (D-98): its key and text", () => {
    expect(STRUCTURED_REFUSED_KEY).toBe('caps.suggest:structured_output');
    expect(structuredRefusedMessage('ollama:qwen3:14b')).toBe(
      'The Director\'s model refused structured output: set structured_output = "none" under [caps."ollama:qwen3:14b"] or run rp-core probe ollama:qwen3:14b --active --write.',
    );
    expect(structuredRefusedMessage('c:m', 'filing')).toStartWith("The filing agent's model refused structured output");
  });

  test('HTTP 400 on the tagged transport, or a 400 that says the context is too long: provider_error', async () => {
    const tagged = rig(calls([{ error: { code: 'bad_request', status: 400 } }]));
    const a = await tagged.run();
    expect(a.ok ? 'ok' : a.code).toBe('provider_error');
    const long = rig(calls([{ error: { code: 'context_length_exceeded', status: 400 } }]), { caps: STRUCTURED_CAPS });
    const b = await long.run();
    expect(b.ok ? 'ok' : b.code).toBe('provider_error');
  });
});

describe('the budget (D-101) and Stop', () => {
  test('the budget starts at the first semaphore slot: the wait in the queue is not counted; then timeout', async () => {
    const timers = fakeTimers();
    const sched = createScheduler();
    const held = await sched.forOrigin('script:dir', 1).acquire('interactive');
    const r = rig(calls([{ pause: 'never' }]), { timers, sched, input: { budgetMs: 1_000 } });
    const pending = r.run();
    await settle();
    // Queued: no budget timer, no first-byte timer, nothing sent.
    expect(timers.pending()).toBe(0);
    expect(r.provider.requests.length).toBe(0);
    timers.advance(10_000);
    await settle();
    expect(r.provider.requests.length).toBe(0);
    held.release();
    await settle();
    expect(r.provider.requests.length).toBe(1);
    timers.advance(999);
    await settle();
    timers.advance(1);
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['timeout']);
    expect(reasonOf(r.provider.requests[0]!.signal)).toBe('budget:director');
    // Every timer cleared at the end.
    expect(timers.pending()).toBe(0);
  });

  test('a refusal that used up the budget is not re-sent: the Director gives up with a timeout, and the provider was asked once', async () => {
    // Bunraku: spent 650 000 of a 600 000 budget in the call. Here the budget aborts the call while it waits.
    const timers = fakeTimers();
    const r = rig(calls([{ delay: 650_000 }, { error: { code: 'rate_limited', status: 429 } }], [{ text: PLAN }]), { timers, input: { budgetMs: 600_000 }, env: { timeouts: SLOW } });
    const pending = r.run();
    await settle();
    timers.advance(600_000);
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(reasonOf(r.provider.requests[0]!.signal)).toBe('budget:director');
    expect(r.provider.requests.length).toBe(1);
  });

  test('a corrective pass after a first answer that used the budget up is not made; one inside the budget is', async () => {
    const spentTimers = fakeTimers();
    const spent = rig(calls([{ delay: 700_000 }, { text: 'prose' }], [{ text: PLAN }]), { timers: spentTimers, input: { budgetMs: 600_000 }, env: { timeouts: SLOW } });
    const a = spent.run();
    await settle();
    spentTimers.advance(700_000);
    expect(await a).toMatchObject({ ok: false, code: 'timeout' });
    expect(reasonOf(spent.provider.requests[0]!.signal)).toBe('budget:director');
    expect(spent.provider.requests.length).toBe(1);

    const leftTimers = fakeTimers();
    const left = rig(calls([{ delay: 400_000 }, { text: 'prose' }], [{ text: PLAN }]), { timers: leftTimers, input: { budgetMs: 600_000 }, env: { timeouts: SLOW } });
    const b = left.run();
    await settle();
    leftTimers.advance(400_000);
    expect((await b).ok).toBe(true);
    expect(left.provider.requests.length).toBe(2);
  });

  test('inside the budget everything still works: a refusal, a pause and a good answer', async () => {
    // Bunraku re-sent a transient refusal itself; here it is the §6.6 retry (D-98).
    const r = rig(calls([{ error: { code: 'rate_limited', status: 429 } }], [{ text: PLAN }]));
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.provider.requests.length).toBe(2);
  });

  test('the budget running out during the retry wait: timeout, the retry never sent', async () => {
    const timers = fakeTimers();
    const r = rig(calls([{ error: { code: 'rate_limited', status: 429, retryAfterSec: 5 } }], [{ text: PLAN }]), {
      timers,
      input: { budgetMs: 2_000 },
      env: { retryMaxDelayMs: 8_000 },
    });
    const pending = r.run();
    await settle();
    timers.advance(2_000);
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['retried']);
    expect(r.provider.requests.length).toBe(1);
  });

  test("the http first-byte deadline: timeout ('did not answer in time'), no retry, no correction", async () => {
    const timers = fakeTimers();
    const r = rig(calls([{ pause: 'never' }], [{ text: PLAN }]), { timers, env: { timeouts: { firstByteMs: 5_000, idleMs: 5_000 } } });
    const pending = r.run();
    await settle();
    timers.advance(5_000);
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('timeout');
    expect(r.provider.requests.length).toBe(1);
    expect(r.events).toEqual([]);
  });

  test('turn Stop while the call runs: aborted', async () => {
    const r = rig(calls([{ pause: 'never' }], [{ text: PLAN }]));
    const pending = r.run();
    await settle();
    expect(r.provider.requests.length).toBe(1);
    abortWith(r.turn, 'user_stop');
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('aborted');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['aborted']);
    expect(r.provider.requests.length).toBe(1);
  });

  test('turn Stop while waiting to retry: aborted, nothing more sent', async () => {
    const timers = fakeTimers();
    const r = rig(calls([{ error: { code: 'rate_limited', status: 429, retryAfterSec: 1 } }], [{ text: PLAN }]), { timers, env: { retryMaxDelayMs: 8_000 } });
    const pending = r.run();
    await settle();
    abortWith(r.turn, 'shutdown');
    const out = await pending;
    expect(out.ok ? 'ok' : out.code).toBe('aborted');
    expect(r.provider.requests.length).toBe(1);
  });

  test('a turn already stopped: no call', async () => {
    const r = rig(calls([{ text: PLAN }]));
    abortWith(r.turn, 'user_stop');
    const out = await r.run();
    expect(out).toEqual({ ok: false, code: 'aborted', attempts: [], calls: [] });
    expect(r.provider.requests.length).toBe(0);
  });

  test('the recall agent times out with its own reason', async () => {
    const timers = fakeTimers();
    const r = rig(calls([{ pause: 'never' }]), { timers, input: { agent: 'recall', budgetMs: 100 } });
    const pending = r.run();
    await settle();
    timers.advance(100);
    expect((await pending).ok).toBe(false);
    expect(reasonOf(r.provider.requests[0]!.signal)).toBe('budget:recall');
  });
});

describe('accounting: callKeys, agent, trace rows, usage events, attempts', () => {
  test('every call has its key and the agent; one trace row per call, retried ones included', async () => {
    const r = rig(
      calls(
        [{ error: { code: 'overloaded', status: 503 } }],
        [{ text: 'prose' }, { usage: { inputTotal: 900, outputTotal: 12 } }],
        [{ text: PLAN }, { usage: { inputTotal: 950, outputTotal: 30, cost: 0.002 } }],
      ),
    );
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.provider.requests.map((q) => [q.callKey, q.agent])).toEqual([
      ['t_1:director:0', 'director'],
      ['t_1:director:1', 'director'],
      ['t_1:director:2', 'director'],
    ]);
    expect(out.calls.map((c) => [c.callKey, c.agent, c.model, c.usage?.outputTotal])).toEqual([
      ['t_1:director:0', 'director', 'dir:m', undefined],
      ['t_1:director:1', 'director', 'dir:m', 12],
      ['t_1:director:2', 'director', 'dir:m', 30],
    ]);
    expect(out.attempts.map((a) => [a.outcome, a.finish, a.tokens, a.status])).toEqual([
      ['retried', undefined, undefined, 503],
      ['no_output', 'end', 12, undefined],
      ['ok', 'end', 30, undefined],
    ]);
    const usage = r.events.filter((e) => e.type === 'usage');
    expect(usage).toEqual([
      { type: 'usage', callKey: 't_1:director:1', agent: 'director', model: 'dir:m', usage: { inputTotal: 900, outputTotal: 12 }, costUsd: null, priceSource: 'none' },
      { type: 'usage', callKey: 't_1:director:2', agent: 'director', model: 'dir:m', usage: { inputTotal: 950, outputTotal: 30, cost: 0.002 }, costUsd: 0.002, priceSource: 'provider' },
    ]);
  });

  test("a usage event is priced by the agent's own model from the price table", async () => {
    const r = rig(calls([{ text: PLAN }, { usage: { inputTotal: 1_000_000, outputTotal: 1_000_000 } }]), { env: { prices: { 'dir:m': { inPerM: 1, outPerM: 2, asOf: '2026-10-01' } } } });
    await r.run();
    expect(r.events).toEqual([expect.objectContaining({ type: 'usage', costUsd: 3, priceSource: 'table' })]);
  });

  test('another prefix and agent', async () => {
    const r = rig(calls([{ text: '{"filings":[]}' }]), {
      input: { agent: 'filing', tag: null, callKeyPrefix: 'job_9:filing', read: (raw) => ({ ok: true, value: raw as never, skipped: [] }) },
    });
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.provider.requests.map((q) => [q.callKey, q.agent])).toEqual([['job_9:filing:0', 'filing']]);
    expect(r.provider.requests[0]!.messages[0]!.src).toBe('filing:system');
  });
});
