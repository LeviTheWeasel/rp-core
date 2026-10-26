// Ported from Bunraku:src/stage/provider/openai-compatible.test.ts@702d8120 (the send-loop scenarios).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// openai-chat end to end: createOpenAIChatProvider against local Bun.serve mock servers (no outside
// network) and a few fake fetches for bodies a real server cannot easily produce. Follows the cases of
// Bunraku src/stage/provider/openai-compatible.test.ts (one POST with the built request, streamed
// events, cut-off stream, abort mid-stream with the signal's reason, abort inside the consumer, an
// already-aborted signal, a request that cannot be built, HTTP failures) on the StreamEv contract.
import { afterAll, describe, expect, test } from 'bun:test';
import { createOpenAIChatProvider, type OpenAIChatOptions } from '../../src/providers/openai-chat.ts';
import { ProviderError, type ModelRequest, type StreamEv } from '../../src/providers/types.ts';
import { blocks, capsAt, coalesce, collect, enc, fixture, msg, request, sleep } from './kit.ts';

type Handler = (req: Request) => Response | Promise<Response>;

/** One mock server per test file; each test installs its handler. */
let handler: Handler = () => new Response('no handler', { status: 500 });
const seen: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
    return handler(req);
  },
});
afterAll(() => server.stop(true));

const BASE = `http://127.0.0.1:${server.port}`;
const SSE = { 'content-type': 'text/event-stream' };

function provider(over: Partial<OpenAIChatOptions> = {}) {
  return createOpenAIChatProvider({ connectionId: 'local', baseUrl: BASE, local: true, ...over });
}

/** A request with Ollama-like caps (stream_options) aimed at the mock. */
function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return request({ caps: capsAt('http://127.0.0.1:11434', 'm'), model: { connection: 'local', model: 'm' }, ...over });
}

const env = (key: string | null = null) => ({ fetch, key });

/** Collect until the stream ends or throws; returns events and the thrown value. */
async function drain(it: AsyncIterable<StreamEv>): Promise<{ events: StreamEv[]; thrown: unknown }> {
  const events: StreamEv[] = [];
  try {
    for await (const ev of it) events.push(ev);
  } catch (e) {
    return { events, thrown: e };
  }
  return { events, thrown: undefined };
}

/** An SSE body that sends `parts` one by one, `gapMs` apart; records cancellation. */
function slowBody(parts: readonly string[], gapMs: number, then: 'end' | 'stall' = 'end') {
  const state = { sent: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (state.sent > 0) await sleep(gapMs);
      const next = parts[state.sent];
      if (next === undefined) {
        if (then === 'end') controller.close();
        else await new Promise<void>(() => {});
        return;
      }
      state.sent++;
      controller.enqueue(enc.encode(next));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const data = (o: unknown) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const delta = (d: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }], model: 'served' });

describe('the request on the wire', () => {
  test('one POST to /v1/chat/completions with the built headers and body; the stream is read into events', async () => {
    seen.length = 0;
    handler = () => new Response(fixture('ollama-usage.sse'), { headers: SSE });
    const { events, thrown } = await drain(provider().stream(req({ messages: [msg('system', 'S'), msg('user', 'hi')], samplers: { temperature: 0.7 } }), env('sk-local')));
    expect(thrown).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-local');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]!.body)).toEqual({
      model: 'm',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
      temperature: 0.7,
    });
    expect(coalesce(events)).toEqual([
      { t: 'text', i: 0, d: 'Mara sets down the mug.' },
      { t: 'finish', reason: 'end', raw: 'stop', model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M' },
      { t: 'usage', u: { inputTotal: 61, inputCacheRead: 48, outputTotal: 7 } },
    ]);
  });

  test('no key, no Authorization header; the fetch is the one passed with the call', async () => {
    seen.length = 0;
    handler = () => new Response(data(delta({ content: 'x' }, 'stop')) + data('[DONE]'), { headers: SSE });
    let calls = 0;
    const counting = ((url: string, init?: RequestInit) => {
      calls++;
      return fetch(url, init);
    }) as typeof fetch;
    const p = provider();
    await drain(p.stream(req(), { fetch: counting, key: null }));
    await drain(p.stream(req(), { fetch: counting, key: null }));
    expect(calls).toBe(2);
    expect(seen.map((s) => s.headers.authorization)).toEqual([undefined, undefined]);
  });

  test('two calls of one provider stream side by side without mixing', async () => {
    // Each answer names the model it was asked for, so a mixed-up stream would show the other's text.
    seen.length = 0;
    handler = () => {
      const asked = (JSON.parse(seen.at(-1)!.body) as { model: string }).model;
      const parts = [data(delta({ content: `${asked}1 ` })), data(delta({ content: `${asked}2` }, 'stop')), data('[DONE]')];
      return new Response(slowBody(parts, 10).stream, { headers: SSE });
    };
    const p = provider();
    const [one, two] = await Promise.all([
      drain(p.stream(req({ model: { connection: 'local', model: 'A' } }), env())),
      drain(p.stream(req({ model: { connection: 'local', model: 'B' } }), env())),
    ]);
    expect(coalesce(one.events)).toEqual([{ t: 'text', i: 0, d: 'A1 A2' }, { t: 'finish', reason: 'end', raw: 'stop', model: 'served' }]);
    expect(coalesce(two.events)).toEqual([{ t: 'text', i: 0, d: 'B1 B2' }, { t: 'finish', reason: 'end', raw: 'stop', model: 'served' }]);
  });

  test('a request that cannot be built is one error event and nothing is sent', async () => {
    seen.length = 0;
    const bad = req({ messages: [blocks('tool', { k: 'tool_result', callId: 'c9', name: 'x', text: 'orphan' })] });
    const { events } = await drain(provider().stream(bad, env()));
    expect(events).toHaveLength(1);
    expect(events[0]!.t === 'error' && events[0]!.err.code).toBe('tool_protocol_invalid');
    expect(seen).toHaveLength(0);
  });
});

describe('failures before the stream', () => {
  async function errorFor(status: number, body: string, headers: Record<string, string> = {}) {
    handler = () => new Response(body, { status, headers });
    const { events, thrown } = await drain(provider().stream(req(), env()));
    expect(thrown).toBeUndefined();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.t !== 'error') throw new Error('expected an error event');
    expect(ev.afterOutput).toBe(false);
    return ev.err;
  }

  test('HTTP statuses map onto the D-51 codes (not "everything but 401 is backend_error")', async () => {
    expect((await errorFor(401, 'no')).toRecord()).toEqual({ category: 'auth', code: 'auth_failed', status: 401 });
    expect((await errorFor(404, '{"error":"model not found"}')).code).toBe('model_not_found');
    expect((await errorFor(400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}')).code).toBe('context_length_exceeded');
    expect((await errorFor(503, '{"error":{"message":"loading model"}}')).code).toBe('overloaded');
    const e = await errorFor(422, '{"detail":"bad field"}');
    expect([e.code, e.status]).toEqual(['bad_request', 422]);
    // §13: the message is the fixed sentence of the code; the server's words are for --debug only.
    expect(e.message).toBe('the server refused the request (HTTP 422)');
    expect(e.detail).toContain('bad field');
  });

  test('Retry-After: seconds, or a date read against the server\'s own Date header', async () => {
    expect((await errorFor(429, '{}', { 'retry-after': '3' })).retryAfterSec).toBe(3);
    const at = (s: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, s)).toUTCString();
    // Bun.serve sets its own Date header; a fake fetch controls both.
    const fake = (async () => new Response('{}', { status: 503, headers: { date: at(0), 'retry-after': at(7) } })) as unknown as typeof fetch;
    const { events } = await drain(provider().stream(req(), { fetch: fake, key: null }));
    expect(events[0]!.t === 'error' && events[0]!.err.retryAfterSec).toBe(7);
  });

  test('a dated Retry-After without a server Date is dropped, not guessed against the epoch', async () => {
    const at = new Date(Date.UTC(2026, 9, 26, 12, 0, 7)).toUTCString();
    const fake = (async () => {
      const r = new Response('{}', { status: 429, headers: { 'retry-after': at } });
      r.headers.delete('date');
      return r;
    }) as unknown as typeof fetch;
    const { events } = await drain(provider().stream(req(), { fetch: fake, key: null }));
    const ev = events[0]!;
    expect(ev.t === 'error' && [ev.err.code, ev.err.retryAfterSec, ev.err.status]).toEqual(['rate_limited', undefined, 429]);
  });

  test('a closed port is unreachable (category network), no throw', async () => {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const closed = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const { events, thrown } = await drain(provider({ baseUrl: closed }).stream(req(), env()));
    expect(thrown).toBeUndefined();
    expect(events[0]!.t === 'error' && events[0]!.err.toRecord()).toEqual({ category: 'network', code: 'unreachable' });
  });

  test('a redirect to another origin is refused (the connection only talks to its base URL)', async () => {
    handler = () => new Response(null, { status: 307, headers: { location: 'http://127.0.0.2:9/v1/chat/completions' } });
    const { events } = await drain(provider().stream(req(), env()));
    expect(events[0]!.t === 'error' && events[0]!.err.code).toBe('unreachable');
  });

  test('a 200 JSON error body (a proxy, or a server that ignored stream:true) fails with its message', async () => {
    handler = () => Response.json({ error: { message: 'quota exceeded', code: 429 } });
    const { events } = await drain(provider().stream(req(), env()));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.t === 'error' && [ev.err.code, ev.err.status]).toEqual(['rate_limited', 429]);
  });

  test('a 200 JSON completion (stream ignored) is read as one chunk', async () => {
    handler = () =>
      Response.json({
        model: 'served',
        choices: [{ index: 0, message: { role: 'assistant', content: '<think>p</think>Hi.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    const { events } = await drain(provider().stream(req(), env()));
    expect(coalesce(events)).toEqual([
      { t: 'reasoning', i: 0, d: 'p' },
      { t: 'reasoning_end', i: 0 },
      { t: 'text', i: 0, d: 'Hi.' },
      { t: 'usage', u: { inputTotal: 4, outputTotal: 2 } },
      { t: 'finish', reason: 'end', raw: 'stop', model: 'served' },
    ]);
  });
});

describe('failures inside the stream', () => {
  test('an `event: error` SSE event is an in-stream error', async () => {
    handler = () => new Response(data(delta({ content: 'a' })) + 'event: error\ndata: {"message":"overloaded_error","type":"overloaded"}\n\n', { headers: SSE });
    const { events } = await drain(provider().stream(req(), env()));
    expect(events.map((e) => e.t)).toEqual(['text', 'error']);
    const ev = events[1]!;
    expect(ev.t === 'error' && [ev.err.code, ev.afterOutput]).toEqual(['overloaded', true]);
  });

  test('the body breaking off before the finish is truncated_stream after output', async () => {
    const { stream } = (() => {
      let n = 0;
      return {
        stream: new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ === 0) c.enqueue(enc.encode(data(delta({ content: 'half' }))));
            else c.error(new Error('connection reset'));
          },
        }),
      };
    })();
    const fake = (async () => new Response(stream, { headers: SSE })) as unknown as typeof fetch;
    const { events, thrown } = await drain(provider().stream(req(), { fetch: fake, key: null }));
    expect(thrown).toBeUndefined();
    expect(events.map((e) => e.t)).toEqual(['text', 'error']);
    const ev = events[1]!;
    expect(ev.t === 'error' && [ev.err.code, ev.afterOutput, ev.err.afterOutput]).toEqual(['truncated_stream', true, true]);
  });

  test('the body breaking off after the finish delivers the answer, then the break as a tail error', async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(enc.encode(data(delta({ content: 'whole' }, 'stop'))));
        else c.error(new Error('connection reset'));
      },
    });
    const fake = (async () => new Response(stream, { headers: SSE })) as unknown as typeof fetch;
    const { events } = await drain(provider().stream(req(), { fetch: fake, key: null }));
    expect(events.map((e) => e.t)).toEqual(['text', 'finish', 'error']);
  });

  test('a stream that just ends without finish or [DONE] is truncated', async () => {
    handler = () => new Response(fixture('truncated.sse'), { headers: SSE });
    const { events } = await drain(provider().stream(req(), env()));
    expect(events.at(-1)!.t === 'error' && (events.at(-1) as { err: ProviderError }).err.code).toBe('truncated_stream');
  });
});

describe('abort', () => {
  test('an abort mid-stream (slow server) throws the signal\'s reason, sends no further event and drops the connection', async () => {
    const parts = Array.from({ length: 200 }, (_, n) => data(delta({ content: `w${n} ` })));
    const body = slowBody(parts, 15, 'stall');
    let serverSawAbort = false;
    handler = (r) => {
      r.signal.addEventListener('abort', () => {
        serverSawAbort = true;
      });
      return new Response(body.stream, { headers: SSE });
    };
    const ctl = new AbortController();
    const reason = new Error('stopped by the user');
    const events: StreamEv[] = [];
    let thrown: unknown;
    try {
      for await (const ev of provider().stream(req({ signal: ctl.signal }), env())) {
        events.push(ev);
        if (events.length === 3) setTimeout(() => ctl.abort(reason), 5);
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(reason);
    const atAbort = events.length;
    expect(atAbort).toBeGreaterThanOrEqual(3);
    expect(atAbort).toBeLessThan(200);
    expect(events.every((e) => e.t === 'text')).toBe(true);
    // The server learns the client is gone (Bun aborts the request signal and/or cancels the body).
    for (let i = 0; i < 100 && !(serverSawAbort || body.state.cancelled); i++) await sleep(10);
    expect(serverSawAbort || body.state.cancelled).toBe(true);
    const sentAtAbort = body.state.sent;
    await sleep(80);
    expect(body.state.sent).toBeLessThanOrEqual(sentAtAbort + 1);
  });

  test('an abort while waiting for the first byte throws the reason', async () => {
    handler = () => new Promise<Response>(() => {}); // never answers
    const ctl = new AbortController();
    const reason = new Error('gone');
    setTimeout(() => ctl.abort(reason), 30);
    const { events, thrown } = await drain(provider().stream(req({ signal: ctl.signal }), env()));
    expect(thrown).toBe(reason);
    expect(events).toEqual([]);
  });

  test('a consumer that aborts while handling an event gets no second event from the same chunk', async () => {
    handler = () => new Response(data(delta({ content: 'one' })) + data(delta({ reasoning_content: 'two', content: 'three' })), { headers: SSE });
    const ctl = new AbortController();
    const reason = new Error('enough');
    const events: StreamEv[] = [];
    let thrown: unknown;
    try {
      for await (const ev of provider().stream(req({ signal: ctl.signal }), env())) {
        events.push(ev);
        if (ev.t === 'reasoning') ctl.abort(reason);
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(reason);
    expect(events).toEqual([
      { t: 'text', i: 0, d: 'one' },
      { t: 'reasoning', i: 0, d: 'two' },
    ]);
  });

  test('an already-aborted signal sends nothing and throws the reason', async () => {
    seen.length = 0;
    const ctl = new AbortController();
    const reason = new Error('before');
    ctl.abort(reason);
    const { thrown } = await drain(provider().stream(req({ signal: ctl.signal }), env()));
    expect(thrown).toBe(reason);
    expect(seen).toHaveLength(0);
  });
});

test('nothing is consumed until the stream is iterated', async () => {
  seen.length = 0;
  handler = () => new Response(data('[DONE]'), { headers: SSE });
  const it = provider().stream(req(), env());
  await sleep(20);
  expect(seen).toHaveLength(0);
  await collect(it);
  expect(seen).toHaveLength(1);
});
