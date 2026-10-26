// Ported from Bunraku:src/stage/provider/openai-compatible-reply.test.ts and
// openai-compatible-reply.regressions.test.ts@702d8120 (stream cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// openai-chat reply half: the per-request parser over SSE data payloads.
// Rewritten from Bunraku src/stage/provider/openai-compatible-reply.test.ts and
// openai-compatible-reply.regressions.test.ts (a completion object → StreamEv events). Flipped: "a
// placeholder id is replaced by the real one" pinned `function.name +=` ("ro" + "ll"); the name is now
// assigned (§19.4 "Не переносить"). Dropped with a reason: the non-streamed parseCompletion cases (the
// core always streams), the reasoning-into-content fallback (now data: caps.reasoning.answerInReasoning;
// a reasoning-only answer is the engine's D-31 rule), the extra field names thinking / thought /
// reasoningContent (not in the §8.4 list), the line splitter (sse.ts) and HTTP failures (http.ts).
import { describe, expect, test } from 'bun:test';
import { createChatParser, createChatReader } from '../../src/providers/openai-chat.ts';
import { mergeCaps } from '../../src/providers/caps.ts';
import type { ModelCaps, StreamEv } from '../../src/providers/types.ts';
import { capsAt, chunk, coalesce, parseSse, request, textsOf } from './kit.ts';

const LLAMA = capsAt('http://127.0.0.1:8080', 'm');
const caps = (patch: Partial<ModelCaps>): ModelCaps => mergeCaps(LLAMA, patch, 'user');

/** Feed payloads, then end(). */
function run(payloads: readonly string[], c: ModelCaps = LLAMA, callKey = 'T1:narrator:0'): StreamEv[] {
  const p = createChatParser(request({ caps: c, callKey }));
  const out: StreamEv[] = [];
  for (const d of payloads) out.push(...p.line(d));
  out.push(...p.end());
  return out;
}

const DONE = '[DONE]';
const tc = (calls: unknown[], finish: string | null = null) => chunk({ tool_calls: calls }, finish);

describe('content and reasoning', () => {
  test('content streams as text; the finish goes out with its chunk, the usage that follows it at [DONE]', () => {
    const p = createChatReader(request());
    expect(p.line(chunk({ content: 'Hel' }))).toEqual([{ t: 'text', i: 0, d: 'Hel' }]);
    // The answer is complete at the finish_reason: the consumer hears it now, not at [DONE].
    expect(p.line(chunk({ content: 'lo' }, 'stop'))).toEqual([
      { t: 'text', i: 0, d: 'lo' },
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
    expect(p.finished).toBe(true);
    expect(p.done).toBe(false); // still reading for the usage (§8.1)
    expect(p.line(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }))).toEqual([]);
    expect(p.line(DONE)).toEqual([{ t: 'usage', u: { inputTotal: 3, outputTotal: 2 } }]);
    expect(p.done).toBe(true);
  });

  test('usage on the finish chunk goes out before the finish; unchanged usage is not repeated at [DONE]', () => {
    const u = { prompt_tokens: 3, completion_tokens: 2 };
    expect(run([chunk({ content: 'x' }, 'stop', { usage: u }), JSON.stringify({ choices: [], usage: u }), DONE])).toEqual([
      { t: 'text', i: 0, d: 'x' },
      { t: 'usage', u: { inputTotal: 3, outputTotal: 2 } },
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
    // A later, fuller usage goes out again (the consumer merges them).
    expect(run([chunk({ content: 'x' }, 'stop', { usage: u }), JSON.stringify({ choices: [], usage: { ...u, cost: 0.5 } }), DONE]).slice(-1)).toEqual([
      { t: 'usage', u: { inputTotal: 3, outputTotal: 2, cost: 0.5 } },
    ]);
  });

  test('an error after the finish_reason comes after the finish (the engine keeps the answer as a tail failure)', () => {
    const evs = run([chunk({ content: 'whole' }, 'stop'), JSON.stringify({ error: { message: 'usage lookup failed' } })]);
    expect(evs.map((e) => e.t)).toEqual(['text', 'finish', 'error']);
  });

  test('a repeated finish_reason changes nothing: the first one is the finish', () => {
    const evs = run([chunk({ content: 'a' }, 'length'), chunk({}, 'stop'), DONE]);
    expect(evs.filter((e) => e.t === 'finish')).toEqual([{ t: 'finish', reason: 'length', raw: 'length' }]);
  });

  test('reasoning_content and reasoning carrying the same text are read once; different texts both', () => {
    expect(textsOf(run([chunk({ reasoning_content: 'a', reasoning: 'a' }, 'stop')])).reasoning).toBe('a');
    expect(textsOf(run([chunk({ reasoning_content: 'a', reasoning: 'b' }, 'stop')])).reasoning).toBe('ab');
  });

  test('reasoning_details text only when no reasoning field carried text (OpenRouter duplicates)', () => {
    const detail = [{ type: 'reasoning.text', text: 'd' }];
    expect(textsOf(run([chunk({ reasoning_details: detail }, 'stop')])).reasoning).toBe('d');
    expect(textsOf(run([chunk({ reasoning: 'r', reasoning_details: detail }, 'stop')])).reasoning).toBe('r');
    expect(textsOf(run([chunk({ reasoning_details: [{ type: 'reasoning.summary', summary: 's' }] }, 'stop')])).reasoning).toBe('s');
    expect(textsOf(run([chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'x' }] }, 'stop')])).reasoning).toBe('');
  });

  test('reasoning in a delta goes out before that delta\'s content', () => {
    expect(coalesce(run([chunk({ reasoning_content: 'why', content: 'what' }, 'stop')]))).toEqual([
      { t: 'reasoning', i: 0, d: 'why' },
      { t: 'reasoning_end', i: 0 },
      { t: 'text', i: 0, d: 'what' },
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
  });

  test('a reasoning-only answer closes its reasoning before the finish', () => {
    expect(run([chunk({ reasoning_content: 'hmm' }, 'length')])).toEqual([
      { t: 'reasoning', i: 0, d: 'hmm' },
      { t: 'reasoning_end', i: 0 },
      { t: 'finish', reason: 'length', raw: 'length' },
    ]);
  });

  test('inline tags are split by caps.reasoning.tags; tags [] turns the splitter off', () => {
    const think = [chunk({ content: '<think>plan</think>Answer' }, 'stop')];
    expect(textsOf(run(think))).toEqual({ text: 'Answer', reasoning: 'plan' });
    const off = caps({ reasoning: { output: 'reasoning_content', tags: [], control: 'none', canDisable: false, echo: 'never' } });
    expect(textsOf(run(think, off))).toEqual({ text: '<think>plan</think>Answer', reasoning: '' });
    const custom = caps({ reasoning: { output: 'tags', tags: ['<plan>'], control: 'none', canDisable: false, echo: 'never' } });
    expect(textsOf(run([chunk({ content: '<plan>p</plan><think>t</think>' }, 'stop')], custom))).toEqual({ text: '<think>t</think>', reasoning: 'p' });
  });

  test('caps.reasoning.answerInReasoning: reasoning text becomes text', () => {
    const c = caps({ reasoning: { output: 'reasoning', control: 'none', canDisable: false, echo: 'never', answerInReasoning: true } });
    const evs = run([chunk({ content: '', reasoning: 'the whole answer' }, 'stop')], c);
    expect(evs).toEqual([
      { t: 'text', i: 0, d: 'the whole answer' },
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
  });

  test('content parts: thinking parts are reasoning, text parts are content (Magistral)', () => {
    const evs = run([
      chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm ' }] }, { type: 'text', text: 'hi' }] }),
      chunk({ content: [{ type: 'reasoning', text: 'more' }] }, 'stop'),
    ]);
    expect(textsOf(evs)).toEqual({ text: 'hi', reasoning: 'hmm more' });
  });

  test('null content and empty strings produce nothing', () => {
    expect(run([chunk({ role: 'assistant', content: null, reasoning_content: null }), chunk({ content: '' }, 'stop')])).toEqual([
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
  });
});

describe('termination', () => {
  test('a finish reason without [DONE] is a complete stream', () => {
    expect(run([chunk({ content: 'x' }, 'length')])).toEqual([
      { t: 'text', i: 0, d: 'x' },
      { t: 'finish', reason: 'length', raw: 'length' },
    ]);
  });

  test('[DONE] without a finish reason ends normally, raw empty', () => {
    expect(run([chunk({ content: 'x' }), DONE])).toEqual([
      { t: 'text', i: 0, d: 'x' },
      { t: 'finish', reason: 'end', raw: '' },
    ]);
  });

  test('nothing is read after [DONE]; end() then adds nothing', () => {
    const p = createChatReader(request());
    expect(p.line(chunk({ content: 'x' }, 'stop')).at(-1)).toMatchObject({ t: 'finish' });
    expect(p.line(DONE)).toEqual([]);
    expect(p.done).toBe(true);
    expect(p.line(chunk({ content: 'late' }))).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  test('a stream cut off before its end fails as truncated_stream, never resolving partial', () => {
    const evs = run([chunk({ content: 'half' })]);
    expect(evs[0]).toEqual({ t: 'text', i: 0, d: 'half' });
    const last = evs.at(-1)!;
    expect(last.t).toBe('error');
    if (last.t === 'error') {
      expect(last.err.code).toBe('truncated_stream');
      expect(last.afterOutput).toBe(true);
      expect(last.err.afterOutput).toBe(true);
    }
  });

  test('a stream with nothing in it (or only noise) is truncated with no output', () => {
    for (const payloads of [[], ['not json'], ['[1,2]', '"str"']]) {
      const evs = run(payloads);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ t: 'error', afterOutput: false });
    }
  });

  test('text held in the tag splitter is flushed before a truncation error', () => {
    const evs = run([chunk({ content: 'ok <thi' })]);
    expect(evs.map((e) => e.t)).toEqual(['text', 'text', 'error']);
    expect(textsOf(evs).text).toBe('ok <thi');
  });

  test('finish reasons are normalised; the raw string is kept', () => {
    for (const [raw, reason] of [
      ['stop', 'end'],
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['tool_calls', 'end'],
      ['eos', 'end'],
    ] as const) {
      expect(run([chunk({}, raw)]).at(-1)).toEqual({ t: 'finish', reason, raw });
    }
  });

  test('the served model is the last one a chunk named', () => {
    const evs = run([chunk({ content: 'a' }, null, { model: 'one' }), chunk({}, 'stop', { model: 'two' }), JSON.stringify({ choices: [], model: '' })]);
    expect(evs.at(-1)).toEqual({ t: 'finish', reason: 'end', raw: 'stop', model: 'two' });
  });
});

describe('errors inside a 200 stream', () => {
  function errorOf(payloads: string[]) {
    const ev = run(payloads).find((e) => e.t === 'error');
    if (!ev || ev.t !== 'error') throw new Error('no error event');
    return ev;
  }

  test("the provider's message is shown, the error ends the stream, nothing after it", () => {
    const p = createChatReader(request());
    const evs = p.line(JSON.stringify({ error: { message: 'upstream exploded' } }));
    expect(evs).toHaveLength(1);
    // §13: the server's words are in detail (--debug), the message is the fixed sentence.
    expect(evs[0]!.t === 'error' && evs[0]!.err.detail).toContain('upstream exploded');
    expect(evs[0]!.t === 'error' && evs[0]!.err.message).toBe('the server failed or is overloaded inside the stream');
    expect(p.done).toBe(true);
    expect(p.line(chunk({ content: 'x' }, 'stop'))).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  test('classified by status first: a numeric code is the upstream HTTP status (OpenRouter)', () => {
    const rate = errorOf([JSON.stringify({ error: { code: 429, message: 'slow down' } })]);
    expect([rate.err.code, rate.err.category, rate.err.status]).toEqual(['rate_limited', 'rate', 429]);
    const bad = errorOf([JSON.stringify({ error: { code: '502', message: 'bad gateway' } })]);
    expect([bad.err.code, bad.err.status]).toEqual(['overloaded', 502]);
    const auth = errorOf([JSON.stringify({ error: { status: 401, message: 'no' } })]);
    expect(auth.err.code).toBe('auth_failed');
  });

  test('then by code / type names, then by message', () => {
    const cases: [object, string][] = [
      [{ code: 'rate_limit_exceeded', message: 'x' }, 'rate_limited'],
      [{ type: 'invalid_request_error', message: "This model's maximum context length is 8192 tokens" }, 'context_length_exceeded'],
      [{ code: 'context_length_exceeded', message: 'x' }, 'context_length_exceeded'],
      [{ type: 'invalid_request_error', message: 'bad field' }, 'bad_request'],
      [{ code: 'content_filter', message: 'x' }, 'content_filter'],
      [{ type: 'authentication_error', message: 'x' }, 'auth_failed'],
      [{ code: 'server_error', message: 'x' }, 'overloaded'],
      [{ message: 'something odd' }, 'overloaded'],
    ];
    for (const [error, code] of cases) expect(errorOf([JSON.stringify({ error })]).err.code).toBe(code as never);
  });

  test('a string error and an OpenRouter upstream detail are kept in detail (--debug), never in the message', () => {
    expect(errorOf([JSON.stringify({ error: 'model is loading' })]).err.detail).toContain('model is loading');
    const e = errorOf([JSON.stringify({ error: { code: 400, message: 'bad', metadata: { raw: { detail: 'upstream says no' } } } })]);
    expect(e.err.detail).toContain('upstream says no');
    expect(e.err.message).toBe('the server refused the request (HTTP 400) inside the stream');
    expect(e.err.toRecord()).toEqual({ category: 'request', code: 'bad_request', status: 400 });
  });

  test('an in-stream 403 moderation refusal is content_filter; any other in-stream 403 is auth_failed', () => {
    const flagged = errorOf([JSON.stringify({ error: { code: 403, message: 'Your chosen model requires moderation and your input was flagged', metadata: { reasons: ['x'], flagged_input: 'y' } } })]);
    expect(flagged.err.toRecord()).toEqual({ category: 'content', code: 'content_filter', status: 403 });
    expect(errorOf([JSON.stringify({ error: { code: 403, message: 'Key disabled' } })]).err.code).toBe('auth_failed');
  });

  test("finish_reason 'error' fails even without an error object; afterOutput follows what went out", () => {
    const e = errorOf([chunk({ content: 'partial' }), chunk({ content: '' }, 'error')]);
    expect(e.err.code).toBe('overloaded');
    expect(e.afterOutput).toBe(true);
    const early = errorOf([chunk({}, 'error')]);
    expect(early.afterOutput).toBe(false);
  });

  test('content in the same chunk as the error is delivered before the error', () => {
    const evs = run([JSON.stringify({ choices: [{ index: 0, delta: { content: 'last words' }, finish_reason: null }], error: { message: 'cut' } })]);
    expect(evs.map((e) => e.t)).toEqual(['text', 'error']);
  });
});

describe('usage', () => {
  test('an empty usage object is "unknown", not zeros', () => {
    expect(run([chunk({}, 'stop', { usage: {} })]).some((e) => e.t === 'usage')).toBe(false);
  });

  test('every OpenAI-shape field: cache read / write, reasoning tokens, cost; DeepSeek cache hits', () => {
    const u = {
      prompt_tokens: 5000,
      completion_tokens: 9,
      prompt_tokens_details: { cached_tokens: 4096, cache_write_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 4 },
      cost: 0.0123,
    };
    expect(run([chunk({}, 'stop', { usage: u })])).toContainEqual({
      t: 'usage',
      u: { inputTotal: 5000, inputCacheRead: 4096, inputCacheWrite: 100, outputTotal: 9, outputReasoning: 4, cost: 0.0123 },
    });
    expect(run([chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 8 } })])).toContainEqual({
      t: 'usage',
      u: { inputTotal: 10, inputCacheRead: 8, outputTotal: 1 },
    });
  });

  test('llama.cpp timings count as usage; usage fields win where both exist, timings fill the cache split', () => {
    expect(run([chunk({}, 'stop', { timings: { prompt_n: 20, cache_n: 3000, predicted_n: 7 } })])).toContainEqual({
      t: 'usage',
      u: { inputTotal: 3020, inputCacheRead: 3000, outputTotal: 7 },
    });
    expect(run([chunk({}, 'stop', { usage: { prompt_tokens: 3020, completion_tokens: 7 }, timings: { prompt_n: 20, cache_n: 3000, predicted_n: 7 } })])).toContainEqual({
      t: 'usage',
      u: { inputTotal: 3020, inputCacheRead: 3000, outputTotal: 7 },
    });
  });

  test('a repeated (cumulative) usage keeps the last report; one usage event at the end', () => {
    const evs = run([
      chunk({ content: 'a' }, null, { usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      chunk({ content: 'b' }, 'stop', { usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      DONE,
    ]);
    expect(evs.filter((e) => e.t === 'usage')).toEqual([{ t: 'usage', u: { inputTotal: 5, outputTotal: 2 } }]);
  });

  test('negative or non-numeric counts are dropped', () => {
    expect(run([chunk({}, 'stop', { usage: { prompt_tokens: -1, completion_tokens: '7', cost: 0 } })])).toContainEqual({ t: 'usage', u: { cost: 0 } });
  });
});

describe('tool call fragments', () => {
  test('a name that arrives before its id waits for the id (Bunraku placeholder case, name now assigned)', () => {
    const evs = run([
      tc([{ index: 0, function: { name: 'ro', arguments: '{"n":' } }]),
      tc([{ index: 0, id: 'real', function: { name: 'roll', arguments: '2}' } }]),
      chunk({}, 'tool_calls'),
    ]);
    expect(evs).toEqual([
      { t: 'tool_start', i: 0, id: 'real', name: 'roll' },
      { t: 'tool_args', i: 0, d: '{"n":2}' },
      { t: 'tool_end', i: 0 },
      { t: 'finish', reason: 'end', raw: 'tool_calls' },
    ]);
  });

  test('a name is never glued to an earlier one: "ro" then "ll" is "ll", not "roll"', () => {
    const evs = run([tc([{ index: 0, id: 'c', function: { name: 'ro' } }]), tc([{ index: 0, function: { name: 'll' } }]), chunk({}, 'tool_calls')]);
    expect(evs[0]).toEqual({ t: 'tool_start', i: 0, id: 'c', name: 'ro' });
  });

  test('a call that never gets an id gets a deterministic one from the call key, on its next fragment', () => {
    const evs = run([tc([{ index: 0, function: { name: 'roll' } }]), tc([{ index: 0, function: { arguments: '{}' } }]), chunk({}, 'tool_calls')], LLAMA, 'T 9/narrator:0');
    expect(evs[0]).toEqual({ t: 'tool_start', i: 0, id: 'call_T_9_narrator:0_0', name: 'roll' });
    // A one-fragment call without an id starts at the finish.
    const one = run([tc([{ index: 0, function: { name: 'roll', arguments: '{}' } }]), chunk({}, 'tool_calls')]);
    expect(one.slice(0, 3)).toEqual([
      { t: 'tool_start', i: 0, id: 'call_T1:narrator:0_0', name: 'roll' },
      { t: 'tool_args', i: 0, d: '{}' },
      { t: 'tool_end', i: 0 },
    ]);
  });

  test('a new id on a used index opens a new call (servers that number every call 0)', () => {
    const evs = run([
      tc([{ index: 0, id: 'a', function: { name: 'roll', arguments: '{"n":1}' } }]),
      tc([{ index: 0, id: 'b', function: { name: 'look', arguments: '{}' } }]),
      chunk({}, 'tool_calls'),
    ]);
    expect(evs).toEqual([
      { t: 'tool_start', i: 0, id: 'a', name: 'roll' },
      { t: 'tool_args', i: 0, d: '{"n":1}' },
      { t: 'tool_end', i: 0 },
      { t: 'tool_start', i: 1, id: 'b', name: 'look' },
      { t: 'tool_args', i: 1, d: '{}' },
      { t: 'tool_end', i: 1 },
      { t: 'finish', reason: 'end', raw: 'tool_calls' },
    ]);
  });

  test('several whole calls in one delta without index use their position; object arguments are serialised', () => {
    const evs = run([tc([{ id: 'a', function: { name: 'roll', arguments: { n: 2 } } }, { id: 'b', function: { name: 'look', arguments: '{}' } }], 'tool_calls')]);
    expect(evs.filter((e) => e.t === 'tool_start')).toEqual([
      { t: 'tool_start', i: 0, id: 'a', name: 'roll' },
      { t: 'tool_start', i: 1, id: 'b', name: 'look' },
    ]);
    expect(evs).toContainEqual({ t: 'tool_args', i: 0, d: '{"n":2}' });
  });

  test('order is first-started, gaps closed: index 2 before index 0 gives slots 0 and 1', () => {
    const evs = run([
      tc([{ index: 2, id: 'b', function: { name: 'second', arguments: '{}' } }]),
      tc([{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }]),
      tc([{ index: 3, id: 'c', function: { arguments: '{}' } }]), // nameless: dropped
      DONE,
    ]);
    expect(evs.filter((e) => e.t === 'tool_start')).toEqual([
      { t: 'tool_start', i: 0, id: 'b', name: 'second' },
      { t: 'tool_start', i: 1, id: 'a', name: 'first' },
    ]);
    expect(evs.filter((e) => e.t === 'tool_end')).toEqual([
      { t: 'tool_end', i: 0 },
      { t: 'tool_end', i: 1 },
    ]);
  });

  test('reasoning before a call is closed by reasoning_end; text may follow the calls', () => {
    const evs = coalesce(run([chunk({ reasoning_content: 'plan' }), tc([{ index: 0, id: 'a', function: { name: 'look', arguments: '{}' } }]), chunk({ content: 'Done.' }, 'tool_calls')]));
    expect(evs.map((e) => e.t)).toEqual(['reasoning', 'reasoning_end', 'tool_start', 'tool_args', 'text', 'tool_end', 'finish']);
  });

  test('unknown call keys are kept for replay by call id (Gemini thought_signature)', () => {
    const r = createChatReader(request({ model: { connection: 'g', model: 'gemini-3-pro' } }));
    r.line(tc([{ index: 0, id: 'fc_1', type: 'function', function: { name: 'look', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig==' } } }]));
    r.line(tc([{ index: 0, function: { arguments: '' }, extra_content: { google: { other: 1 } } }]));
    r.line(tc([{ index: 1, function: { arguments: '{}' }, extra_content: { lost: true } }])); // nameless: never replayed
    r.line(chunk({}, 'tool_calls'));
    r.end();
    expect(r.replay()).toEqual([
      { kind: 'tool_extra', connection: 'g', model: 'gemini-3-pro', payload: { fc_1: { extra_content: { google: { thought_signature: 'sig==', other: 1 } } } } },
    ]);
  });

  test('two parsers never share state (no module-level mutable state)', () => {
    const a = createChatReader(request());
    const b = createChatReader(request());
    a.line(tc([{ index: 0, id: 'x', function: { name: 'roll', arguments: '{' } }]));
    expect(b.line(tc([{ index: 0, id: 'y', function: { name: 'look', arguments: '{}' } }]))).toEqual([
      { t: 'tool_start', i: 0, id: 'y', name: 'look' },
      { t: 'tool_args', i: 0, d: '{}' },
    ]);
    expect(a.replay()).toEqual([]);
  });
});

describe('a stream without blank lines between events (review M1b)', () => {
  test('data lines one per chunk, no blank lines: text, finish and [DONE] are all read', async () => {
    const line = (d: string): string => `data: ${d}\n`;
    const text = line(chunk({ content: 'Hello' })) + line(chunk({ content: ' there.' })) + line(chunk({}, 'stop')) + line('[DONE]');
    const { events, reader } = await parseSse(request(), text);
    expect(textsOf(events).text).toBe('Hello there.');
    expect(events.at(-1)).toEqual({ t: 'finish', reason: 'end', raw: 'stop' });
    expect(reader.done).toBe(true);
  });
});
