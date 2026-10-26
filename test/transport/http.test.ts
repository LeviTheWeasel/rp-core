// Ported from Bunraku:src/kit/providers/egress.test.ts (lines 49-125)@702d8120 and
// Bunraku:src/core/stream-bytes.test.ts@702d8120 (chunksOf cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// http.ts: origins, the host-locked fetch, the status table, retry-after, byte streaming.
// guardedFetch cases adapted from Bunraku src/kit/providers/egress.test.ts (lines 49-125); bodyBytes
// cases from Bunraku src/core/stream-bytes.test.ts (chunksOf).
import { afterAll, describe, expect, test } from 'bun:test';
import {
  bodyBytes,
  classifyHttpFailure,
  guardedFetch,
  isLocalOrigin,
  originOf,
  parseRetryAfter,
  type HttpRequest,
} from '../../src/providers/http.ts';
import { PROVIDER_ERROR_CATEGORY, ProviderError, type ProviderErrorCode } from '../../src/providers/types.ts';
import { collect, enc, fakeFetch, nowMs, redirect, rejectionOf, sleep, spiedStream } from './kit.ts';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const never = new AbortController().signal;
const post = (url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  url,
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
  body: '{"model":"m"}',
  ...extra,
});

function expectProviderError(e: unknown, code: ProviderErrorCode): ProviderError {
  expect(e).toBeInstanceOf(ProviderError);
  const pe = e as ProviderError;
  expect(pe.code).toBe(code);
  expect(pe.category).toBe(PROVIDER_ERROR_CATEGORY[code]);
  return pe;
}

describe('originOf', () => {
  test('default ports are made explicit, host lower-cased, path and query dropped', () => {
    expect(originOf('http://127.0.0.1:8080/v1/chat/completions')).toBe('http://127.0.0.1:8080');
    expect(originOf('https://OpenRouter.ai/api?x=1')).toBe('https://openrouter.ai:443');
    expect(originOf('http://localhost')).toBe('http://localhost:80');
    expect(originOf('https://api.example.com:443/')).toBe('https://api.example.com:443');
    expect(originOf('http://[::1]:11434/')).toBe('http://[::1]:11434');
    expect(originOf('http://user:pw@host.example:81/x')).toBe('http://host.example:81');
  });
  test('a non-http(s) or unparseable URL throws without echoing it', () => {
    expect(() => originOf('ftp://example.com/')).toThrow(/http\(s\)/);
    expect(() => originOf('file:///etc/passwd')).toThrow();
    expect(() => originOf('not a url ?key=sk-secret')).toThrow();
    try {
      originOf('nope://x?key=sk-secret');
    } catch (e) {
      expect(String(e)).not.toContain('sk-secret');
    }
  });
});

describe('isLocalOrigin', () => {
  test('the documented local set', () => {
    for (const o of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://127.8.9.10:80',
      'http://[::1]:11434',
      'http://10.0.0.5:1234',
      'http://172.16.0.1:5001',
      'http://172.31.255.255:5001',
      'http://192.168.1.20:8080',
      'http://gpu-box.local:8080',
      'http://app.localhost:3000',
      'http://LOCALHOST:1',
    ]) {
      expect(isLocalOrigin(o)).toBe(true);
    }
  });
  test('the documented superset: 0.0.0.0, link-local, CGNAT/Tailscale, IPv6 ULA and mapped, LAN suffixes', () => {
    for (const o of [
      'http://0.0.0.0:8080',
      'http://169.254.10.1:80',
      'http://100.101.102.103:8080',
      'http://[fd12:3456::1]:8080',
      'http://[fe80::1]:8080',
      'http://[::ffff:127.0.0.1]:8080',
      'http://[::ffff:192.168.0.2]:8080',
      'http://nas.lan:8080',
      'http://box.home.arpa:8080',
      'http://host.docker.internal:11434',
      'http://localhost.:8080',
    ]) {
      expect(isLocalOrigin(o)).toBe(true);
    }
  });
  test('public hosts and near misses are remote', () => {
    for (const o of [
      'https://openrouter.ai:443',
      'https://api.deepseek.com',
      'http://172.32.0.1:80',
      'http://172.15.0.1:80',
      'http://192.169.0.1:80',
      'http://11.0.0.1:80',
      'http://100.128.0.1:80',
      'http://[2001:db8::1]:80',
      'http://[::ffff:8.8.8.8]:80',
      'http://localhost.example.com:80',
      'http://mylocal:80',
      'garbage',
    ]) {
      expect(isLocalOrigin(o)).toBe(false);
    }
  });
});

describe('parseRetryAfter', () => {
  test('delta-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120);
    expect(parseRetryAfter(' 5 ', NOW)).toBe(5);
    expect(parseRetryAfter('0', NOW)).toBe(0);
    expect(parseRetryAfter('1.5', NOW)).toBe(1.5);
  });
  test('HTTP-date, relative to now, never negative', () => {
    expect(parseRetryAfter('Mon, 26 Oct 2026 12:00:30 GMT', NOW)).toBe(30);
    expect(parseRetryAfter('Mon, 26 Oct 2026 12:01:00 GMT', NOW)).toBe(60);
    expect(parseRetryAfter('Mon, 26 Oct 2026 12:00:00 GMT', NOW)).toBe(0);
    expect(parseRetryAfter('Sun, 25 Oct 2026 12:00:00 GMT', NOW)).toBe(0);
    // A fractional remainder rounds up: waiting less than asked is the wrong side.
    expect(parseRetryAfter('Mon, 26 Oct 2026 12:00:10 GMT', new Date('2026-10-26T12:00:00.500Z'))).toBe(10);
  });
  test('absent or invalid → undefined', () => {
    for (const v of [null, '', '   ', '-1', '+5', 'soon', '5s', 'May', '1e3', 'Mon, 32 Foo 2026 99:99:99 GMT']) {
      expect(parseRetryAfter(v, NOW)).toBeUndefined();
    }
  });
});

describe('classifyHttpFailure: status → code', () => {
  const table: [number, ProviderErrorCode][] = [
    [400, 'bad_request'],
    [401, 'auth_failed'],
    [402, 'bad_request'],
    [403, 'auth_failed'],
    [404, 'model_not_found'],
    [405, 'bad_request'],
    [408, 'timeout'],
    [409, 'bad_request'],
    [413, 'context_length_exceeded'],
    [418, 'bad_request'],
    [422, 'bad_request'],
    [425, 'bad_request'],
    [429, 'rate_limited'],
    [500, 'overloaded'],
    [502, 'overloaded'],
    [503, 'overloaded'],
    [504, 'overloaded'],
    [524, 'overloaded'],
    [529, 'overloaded'],
    // Deviation (documented): other 5xx are server failures, not bad requests.
    [501, 'overloaded'],
    [520, 'overloaded'],
    [522, 'overloaded'],
    [530, 'overloaded'],
    // An unfollowed redirect, or anything else, is a bad request.
    [302, 'bad_request'],
    [304, 'bad_request'],
    [299, 'bad_request'],
  ];
  for (const [status, code] of table) {
    test(`${status} → ${code}`, async () => {
      const err = await classifyHttpFailure(new Response(status === 304 ? null : 'nope', { status }), { now: NOW });
      expectProviderError(err, code);
      expect(err.status).toBe(status);
      expect(err.afterOutput).toBe(false);
      expect(err.toRecord()).toEqual({ category: PROVIDER_ERROR_CATEGORY[code], code, status });
    });
  }

  test('400 and 422 become context_length_exceeded only when the body says so', async () => {
    const bodies = [
      '{"error":{"message":"This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
      '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":5000,"n_ctx":4096}}',
      '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      '{"object":"error","message":"This model\'s maximum context length is 4096 tokens. However, you requested 5000 tokens.","type":"BadRequestError"}',
      '{"detail":"Prompt length 9000 is greater than max_seq_len 8192"}',
      '{"error":{"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}',
      '{"error":{"message":"This endpoint\'s maximum context length is 131072 tokens. However, you requested about 140000 tokens","code":400}}',
      '{"object":"error","message":"Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length"}',
    ];
    for (const status of [400, 422]) {
      for (const body of bodies) {
        const err = await classifyHttpFailure(new Response(body, { status }), { now: NOW });
        expectProviderError(err, 'context_length_exceeded');
        expect(err.status).toBe(status);
      }
    }
    for (const body of [
      '{"error":{"message":"max_tokens is too large: 50000. This model supports at most 16384 completion tokens."}}',
      '{"error":{"message":"Unrecognized request argument supplied: top_k"}}',
      'plain text failure',
    ]) {
      expectProviderError(await classifyHttpFailure(new Response(body, { status: 400 }), { now: NOW }), 'bad_request');
    }
    // A context phrase on a status outside 400/422 does not change the status mapping.
    expectProviderError(await classifyHttpFailure(new Response('maximum context length exceeded', { status: 500 }), { now: NOW }), 'overloaded');
  });

  test('429 carries retryAfterSec from either Retry-After form; a 503 with Retry-After does too', async () => {
    const a = await classifyHttpFailure(new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }), { now: NOW });
    expectProviderError(a, 'rate_limited');
    expect(a.retryAfterSec).toBe(7);
    const b = await classifyHttpFailure(new Response('', { status: 429, headers: { 'Retry-After': 'Mon, 26 Oct 2026 12:00:20 GMT' } }), { now: NOW });
    expect(b.retryAfterSec).toBe(20);
    const c = await classifyHttpFailure(new Response('', { status: 429, headers: { 'retry-after-ms': '1500' } }), { now: NOW });
    expect(c.retryAfterSec).toBe(1.5);
    const d = await classifyHttpFailure(new Response('', { status: 429 }), { now: NOW });
    expect(d.retryAfterSec).toBeUndefined();
    const e = await classifyHttpFailure(new Response('', { status: 429, headers: { 'retry-after': 'later' } }), { now: NOW });
    expect(e.retryAfterSec).toBeUndefined();
    const f = await classifyHttpFailure(new Response('', { status: 503, headers: { 'retry-after': '3' } }), { now: NOW });
    expectProviderError(f, 'overloaded');
    expect(f.retryAfterSec).toBe(3);
  });

  test('§13: the message is the fixed sentence of the code; the server words are only in detail (--debug); the record has neither', async () => {
    const or = await classifyHttpFailure(
      new Response('{"error":{"message":"Provider returned error","code":502,"metadata":{"raw":"upstream exploded","provider_name":"X"}}}', { status: 502 }),
      { now: NOW },
    );
    expect(or.message).toBe('the server failed or is overloaded (HTTP 502)');
    expect(or.detail).toContain('Provider returned error');
    expect(or.detail).toContain('upstream exploded');
    expect(JSON.stringify(or.toRecord())).not.toContain('exploded');
    const ollama = await classifyHttpFailure(new Response('{"error":"model \\"qwen3\\" not found, try pulling it first"}', { status: 404 }), { now: NOW });
    expect(ollama.message).toBe('the server does not know this model (or this URL) (HTTP 404)');
    expect(ollama.detail).toContain('not found, try pulling it first');
    const fastapi = await classifyHttpFailure(new Response('{"detail":[{"loc":["body","messages"],"msg":"field required"}]}', { status: 422 }), { now: NOW });
    expect(fastapi.detail).toContain('field required');
    const empty = await classifyHttpFailure(new Response(null, { status: 401 }), { now: NOW });
    expect(empty.message).toBe('the server refused the API key (HTTP 401)');
    expect(empty.detail).toBeUndefined();
    const long = await classifyHttpFailure(new Response('x'.repeat(5000), { status: 400 }), { now: NOW });
    expect(long.detail!.length).toBeLessThan(600);
    // A gateway that echoes the Authorization header (and the prompt) in its 401 body: none of it in the message.
    const echo = await classifyHttpFailure(
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: Bearer sk-SECRET123456; your prompt was: hi' } }), { status: 401 }),
      { now: NOW },
    );
    expect(echo.message).not.toContain('sk-SECRET');
    expect(echo.message).not.toContain('prompt was');
    expect(echo.detail).toContain('sk-SECRET123456');
  });

  test('403: a moderation refusal (OpenRouter metadata.reasons / flagged_input) is content_filter; any other 403 stays auth_failed', async () => {
    const flagged = await classifyHttpFailure(
      new Response(
        JSON.stringify({ error: { code: 403, message: 'Your chosen model requires moderation and your input was flagged', metadata: { reasons: ['violence'], flagged_input: 'xx', provider_name: 'P', model_slug: 'm' } } }),
        { status: 403 },
      ),
      { now: NOW },
    );
    expect(flagged.toRecord()).toEqual({ category: 'content', code: 'content_filter', status: 403 });
    expect(flagged.message).not.toContain('flagged_input');
    const byWords = await classifyHttpFailure(new Response('{"error":{"message":"input was flagged by moderation"}}', { status: 403 }), { now: NOW });
    expect(byWords.code).toBe('content_filter');
    const denied = await classifyHttpFailure(new Response('{"error":{"message":"Key is disabled"}}', { status: 403 }), { now: NOW });
    expect(denied.toRecord()).toEqual({ category: 'auth', code: 'auth_failed', status: 403 });
    const plain = await classifyHttpFailure(new Response('Forbidden', { status: 403 }), { now: NOW });
    expect(plain.code).toBe('auth_failed');
  });

  test('afterOutput is passed through', async () => {
    const err = await classifyHttpFailure(new Response('x', { status: 500 }), { now: NOW, afterOutput: true });
    expect(err.afterOutput).toBe(true);
  });

  test('at most 64 KiB of the body is read, then the body is cancelled', async () => {
    const { stream, state } = spiedStream([], 'forever'); // 16 KiB chunks, never ends
    const err = await classifyHttpFailure(new Response(stream, { status: 500 }), { now: NOW });
    expectProviderError(err, 'overloaded');
    expect(state.cancelled).toBe(true);
    expect(state.bytes).toBeLessThanOrEqual(64 * 1024 + 2 * 16 * 1024);
  });

  test('text past 64 KiB is never consulted', async () => {
    const within = `${'a'.repeat(1000)} maximum context length is 4096`;
    const beyond = `${'a'.repeat(64 * 1024)} maximum context length is 4096`;
    expectProviderError(await classifyHttpFailure(new Response(within, { status: 400 }), { now: NOW }), 'context_length_exceeded');
    expectProviderError(await classifyHttpFailure(new Response(beyond, { status: 400 }), { now: NOW }), 'bad_request');
  });

  test('a body that breaks off still classifies by status', async () => {
    const { stream } = spiedStream(['{"error":'], new Error('socket reset'));
    expectProviderError(await classifyHttpFailure(new Response(stream, { status: 429 }), { now: NOW }), 'rate_limited');
  });

  test('a multi-byte character cut at the cap does not throw', async () => {
    const body = enc.encode(`${'a'.repeat(64 * 1024 - 1)}é and more`);
    const err = await classifyHttpFailure(new Response(body, { status: 400 }), { now: NOW });
    expectProviderError(err, 'bad_request');
  });
});

describe('guardedFetch with a fake fetch', () => {
  const ORIGIN = 'https://api.example.com';

  test('refuses another origin before touching the network', async () => {
    const f = fakeFetch(() => new Response('ok'));
    for (const url of ['https://evil.example.com/steal', 'http://api.example.com/v1', 'https://api.example.com:8443/v1']) {
      const e = await rejectionOf(guardedFetch(post(url), { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN }));
      expectProviderError(e, 'unreachable');
    }
    expect(f.calls).toHaveLength(0);
  });

  test('passes method, headers, body, the signal, manual redirects and no Bun idle timer', async () => {
    const ac = new AbortController();
    const f = fakeFetch(() => new Response('ok'));
    const res = await guardedFetch(post(`${ORIGIN}/v1/chat/completions`), { fetch: f.fetch, signal: ac.signal, allowedOrigin: ORIGIN });
    expect(await res.text()).toBe('ok');
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/chat/completions`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"model":"m"}');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer secret' });
    expect(init.signal).toBe(ac.signal);
    expect(init.redirect).toBe('manual');
    expect(init.timeout).toBe(false);
  });

  test('allowedOrigin may be a base URL; default ports compare equal', async () => {
    const f = fakeFetch(() => new Response('ok'));
    await guardedFetch(post('https://api.example.com:443/v1/x'), { fetch: f.fetch, signal: never, allowedOrigin: 'https://api.example.com/api/v1' });
    await guardedFetch(post('http://127.0.0.1:8080/v1'), { fetch: f.fetch, signal: never, allowedOrigin: 'http://127.0.0.1:8080' });
    expect(f.calls).toHaveLength(2);
  });

  test('follows a same-origin redirect (relative Location) and returns the final response', async () => {
    const f = fakeFetch((_u, _i, n) => (n === 0 ? redirect(307, '/v1/models?page=2') : Response.json({ data: [] })));
    const res = await guardedFetch({ url: `${ORIGIN}/v1/models`, method: 'GET', headers: {} }, { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN });
    expect(res.status).toBe(200);
    expect(f.calls.map((c) => c.url)).toEqual([`${ORIGIN}/v1/models`, `${ORIGIN}/v1/models?page=2`]);
  });

  test('307 and 308 keep POST and its body; 303, and 301/302 after POST, become a bodiless GET', async () => {
    for (const [status, method, hasBody] of [
      [307, 'POST', true],
      [308, 'POST', true],
      [303, 'GET', false],
      [301, 'GET', false],
      [302, 'GET', false],
    ] as const) {
      const f = fakeFetch((_u, _i, n) => (n === 0 ? redirect(status, `${ORIGIN}/next`) : new Response('ok')));
      await guardedFetch(post(`${ORIGIN}/start`), { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN });
      const second = f.calls[1]!.init;
      expect(second.method).toBe(method);
      expect(second.body !== undefined).toBe(hasBody);
      const names = Object.keys(second.headers as Record<string, string>).map((k) => k.toLowerCase());
      expect(names.includes('content-type')).toBe(hasBody);
      expect(names).toContain('authorization'); // same origin: credentials still go
    }
  });

  test('a redirect to another host, port or scheme is refused and never sent', async () => {
    for (const location of ['https://evil.example.com/steal', 'https://api.example.com:8443/x', '//evil.example.com/x', 'http://127.0.0.1:8321/api']) {
      const f = fakeFetch(() => redirect(302, location));
      const e = await rejectionOf(guardedFetch(post(`${ORIGIN}/v1`), { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN }));
      const pe = expectProviderError(e, 'unreachable');
      expect(pe.status).toBe(302);
      expect(f.calls).toHaveLength(1);
    }
  });

  test('an https → http downgrade is refused, and so is an http → https switch (not the same origin)', async () => {
    const down = fakeFetch(() => redirect(301, 'http://api.example.com/v1'));
    const e = await rejectionOf(guardedFetch(post(`${ORIGIN}/v1`), { fetch: down.fetch, signal: never, allowedOrigin: ORIGIN }));
    expect(expectProviderError(e, 'unreachable').message).toContain('downgrade');
    const up = fakeFetch(() => redirect(301, 'https://127.0.0.1:8080/v1'));
    expectProviderError(await rejectionOf(guardedFetch(post('http://127.0.0.1:8080/v1'), { fetch: up.fetch, signal: never, allowedOrigin: 'http://127.0.0.1:8080' })), 'unreachable');
    expect(up.calls).toHaveLength(1);
  });

  test('a non-http(s) or invalid Location is refused', async () => {
    for (const location of ['ftp://api.example.com/x', 'javascript:alert(1)', 'http://[bad']) {
      const f = fakeFetch(() => redirect(302, location));
      expectProviderError(await rejectionOf(guardedFetch(post(`${ORIGIN}/v1`), { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN })), 'unreachable');
    }
  });

  test('stops a redirect loop after 5 hops (6 requests), or after maxRedirects', async () => {
    let hops = 0;
    const loop = fakeFetch(() => redirect(302, `/hop/${++hops}`));
    const e = await rejectionOf(guardedFetch(post(`${ORIGIN}/start`), { fetch: loop.fetch, signal: never, allowedOrigin: ORIGIN }));
    expect(expectProviderError(e, 'unreachable').message).toContain('more than 5');
    expect(loop.calls).toHaveLength(6);

    const five = fakeFetch((_u, _i, n) => (n < 5 ? redirect(307, `/hop/${n}`) : new Response('ok')));
    expect((await guardedFetch(post(`${ORIGIN}/start`), { fetch: five.fetch, signal: never, allowedOrigin: ORIGIN })).status).toBe(200);
    expect(five.calls).toHaveLength(6);

    const none = fakeFetch(() => redirect(307, '/x'));
    await rejectionOf(guardedFetch(post(`${ORIGIN}/start`), { fetch: none.fetch, signal: never, allowedOrigin: ORIGIN, maxRedirects: 0 }));
    expect(none.calls).toHaveLength(1);
  });

  test('a 3xx without Location is returned as is (the caller classifies it)', async () => {
    const f = fakeFetch(() => redirect(302, null));
    const res = await guardedFetch(post(`${ORIGIN}/v1`), { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN });
    expect(res.status).toBe(302);
    expectProviderError(await classifyHttpFailure(res, { now: NOW }), 'bad_request');
  });

  test("a followed redirect's body is cancelled", async () => {
    const { stream, state } = spiedStream(['moved'], 'stall');
    const f = fakeFetch((_u, _i, n) => (n === 0 ? redirect(307, '/next', stream) : new Response('ok')));
    await guardedFetch(post(`${ORIGIN}/v1`), { fetch: f.fetch, signal: never, allowedOrigin: ORIGIN });
    expect(state.cancelled).toBe(true);
  });

  test('a network failure is unreachable; a timer failure is timeout; the message is live only', async () => {
    const refused = fakeFetch(() => {
      throw new TypeError('Unable to connect. Is the computer able to access the url?');
    });
    const e = expectProviderError(await rejectionOf(guardedFetch(post(`${ORIGIN}/v1`), { fetch: refused.fetch, signal: never, allowedOrigin: ORIGIN })), 'unreachable');
    expect(e.status).toBeUndefined();
    expect(e.toRecord()).toEqual({ category: 'network', code: 'unreachable' });
    const timer = fakeFetch(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    expectProviderError(await rejectionOf(guardedFetch(post(`${ORIGIN}/v1`), { fetch: timer.fetch, signal: never, allowedOrigin: ORIGIN })), 'timeout');
  });

  test('an abort rejects with the signal reason, before or during the fetch', async () => {
    const reason = new Error('user pressed stop');
    const f = fakeFetch(() => new Response('ok'));
    expect(await rejectionOf(guardedFetch(post(`${ORIGIN}/v1`), { fetch: f.fetch, signal: AbortSignal.abort(reason), allowedOrigin: ORIGIN }))).toBe(reason);
    expect(f.calls).toHaveLength(0);

    const ac = new AbortController();
    const hanging = fakeFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = guardedFetch(post(`${ORIGIN}/v1`), { fetch: hanging.fetch, signal: ac.signal, allowedOrigin: ORIGIN });
    ac.abort(reason);
    expect(await rejectionOf(p)).toBe(reason);
  });
});

describe('bodyBytes', () => {
  test('yields the chunks in order and skips empty ones', async () => {
    const { stream } = spiedStream(['ab', new Uint8Array(0), 'cd']);
    const chunks = await collect(bodyBytes(new Response(stream), never));
    expect(chunks.map((c) => new TextDecoder().decode(c))).toEqual(['ab', 'cd']);
  });

  test('a null body yields nothing', async () => {
    expect(await collect(bodyBytes(new Response(null, { status: 204 }), never))).toEqual([]);
  });

  test('a consumer that stops early cancels the body', async () => {
    const { stream, state } = spiedStream(['a', 'b', 'c'], 'stall');
    for await (const _ of bodyBytes(new Response(stream), never)) break;
    expect(state.cancelled).toBe(true);
  });

  test('an abort wakes a read waiting on a silent body, throws the reason and cancels', async () => {
    const { stream, state } = spiedStream(['first'], 'stall');
    const ac = new AbortController();
    const reason = new Error('stop');
    const seen: string[] = [];
    const run = (async () => {
      for await (const c of bodyBytes(new Response(stream), ac.signal)) {
        seen.push(new TextDecoder().decode(c));
        setTimeout(() => ac.abort(reason), 20);
      }
    })();
    expect(await rejectionOf(run)).toBe(reason);
    expect(seen).toEqual(['first']);
    expect(state.cancelled).toBe(true);
  });

  test('an already-aborted signal throws the reason and cancels', async () => {
    const { stream, state } = spiedStream(['x']);
    const reason = new Error('already');
    expect(await rejectionOf(collect(bodyBytes(new Response(stream), AbortSignal.abort(reason))))).toBe(reason);
    expect(state.cancelled).toBe(true);
  });

  test('a body that breaks off (not an abort) is truncated_stream', async () => {
    const { stream } = spiedStream(['data: {"x":1}\n'], new Error('ECONNRESET'));
    const e = await rejectionOf(collect(bodyBytes(new Response(stream), never)));
    expectProviderError(e, 'truncated_stream');
  });
});

// ---- against a real Bun.serve (local mock server only) ----------------------------------------------

describe('guardedFetch against Bun.serve', () => {
  let otherHits = 0;
  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      otherHits++;
      return new Response('you should not be here');
    },
  });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      switch (u.pathname) {
        case '/hop':
          return new Response('moved', { status: 307, headers: { location: '/final' } });
        case '/final':
          return new Response(`final ${req.method} ${await req.text()}`);
        case '/away':
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/x` } });
        case '/loop':
          return new Response(null, { status: 302, headers: { location: '/loop' } });
        case '/slow-first': {
          await sleep(5_000);
          return new Response('late');
        }
        case '/stall-error':
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(c) {
                c.enqueue(enc.encode('{"error":{"message":"partial'));
                await sleep(5_000);
                c.close();
              },
            }),
            { status: 503 },
          );
        case '/stall-mid':
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(c) {
                c.enqueue(enc.encode('data: first\n\n'));
                await sleep(5_000);
                c.close();
              },
            }),
          );
        default:
          return new Response('ok');
      }
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  afterAll(() => {
    server.stop(true);
    other.stop(true);
  });

  test("Bun's manual redirect mode hands the 3xx over, and the same-origin hop is followed", async () => {
    const res = await guardedFetch(post(`${origin}/hop`), { fetch, signal: never, allowedOrigin: origin });
    expect(await res.text()).toBe('final POST {"model":"m"}');
  });

  test('a redirect to another local port is refused and the other server never sees a request', async () => {
    const e = await rejectionOf(guardedFetch(post(`${origin}/away`), { fetch, signal: never, allowedOrigin: origin }));
    expectProviderError(e, 'unreachable');
    expect(otherHits).toBe(0);
  });

  test('a real redirect loop stops at the cap', async () => {
    expectProviderError(await rejectionOf(guardedFetch(post(`${origin}/loop`), { fetch, signal: never, allowedOrigin: origin })), 'unreachable');
  });

  test('a closed port is unreachable', async () => {
    const tmp = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    const closed = `http://127.0.0.1:${tmp.port}`;
    tmp.stop(true);
    const e = await rejectionOf(guardedFetch(post(`${closed}/v1`), { fetch, signal: never, allowedOrigin: closed }));
    expectProviderError(e, 'unreachable');
  });

  test('aborting while waiting for the first byte ends the fetch promptly with the reason', async () => {
    const ac = new AbortController();
    const reason = new Error('stop before first byte');
    const t0 = nowMs();
    const p = guardedFetch(post(`${origin}/slow-first`), { fetch, signal: ac.signal, allowedOrigin: origin });
    setTimeout(() => ac.abort(reason), 100);
    expect(await rejectionOf(p)).toBe(reason);
    expect(nowMs() - t0).toBeLessThan(1_500);
  });

  test('an error body that stalls is given up when the request signal aborts', async () => {
    const ac = new AbortController();
    const res = await guardedFetch(post(`${origin}/stall-error`), { fetch, signal: ac.signal, allowedOrigin: origin });
    expect(res.status).toBe(503);
    const t0 = nowMs();
    setTimeout(() => ac.abort(new Error('give up')), 100);
    const err = await classifyHttpFailure(res, { now: NOW });
    expectProviderError(err, 'overloaded');
    expect(err.status).toBe(503);
    expect(nowMs() - t0).toBeLessThan(1_500);
  });

  test('aborting mid-body ends the body read promptly with the reason', async () => {
    const ac = new AbortController();
    const reason = new Error('stop mid body');
    const res = await guardedFetch(post(`${origin}/stall-mid`), { fetch, signal: ac.signal, allowedOrigin: origin });
    expect(res.status).toBe(200);
    const t0 = nowMs();
    const got: string[] = [];
    const run = (async () => {
      for await (const c of bodyBytes(res, ac.signal)) {
        got.push(new TextDecoder().decode(c));
        setTimeout(() => ac.abort(reason), 50);
      }
    })();
    expect(await rejectionOf(run)).toBe(reason);
    expect(got).toEqual(['data: first\n\n']);
    expect(nowMs() - t0).toBeLessThan(1_500);
  });
});
