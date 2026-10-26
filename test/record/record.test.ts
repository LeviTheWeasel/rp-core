// Record and replay end to end (ARCHITECTURE.md §14): the recorder around the real openai-chat
// provider against a local Bun.serve SSE mock (no outside network), then the replay of what it wrote.
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOpenAIChatProvider, type OpenAIChatOptions } from '../../src/providers/openai-chat.ts';
import {
  createRecordingProvider,
  createReplayProvider,
  parseRecording,
  RAW_CAP_BYTES,
  RAW_TRUNCATED_MARK,
  recordedRequest,
  type RecordedCall,
} from '../../src/providers/record.ts';
import { createScriptedProvider, hashRequest } from '../../src/providers/scripted.ts';
import { PROVIDER_ERROR_MESSAGE, ProviderError, type ModelRequest, type Provider, type StreamEv } from '../../src/providers/types.ts';
import { bytesIn, capsAt, enc, msg, request, sleep } from '../adapter/kit.ts';
import { tmpHome } from '../helpers.ts';

type Handler = (req: Request) => Response | Promise<Response>;

/** One mock server for the file; each test installs its handler. */
let handler: Handler = () => new Response('no handler', { status: 500 });
const seen: { headers: Record<string, string>; body: string }[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    seen.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.clone().text() });
    return handler(req);
  },
});
afterAll(() => server.stop(true));

const BASE = `http://127.0.0.1:${server.port}`;
const SSE = { 'content-type': 'text/event-stream' };
const KEY = 'sk-test-0123456789abcdefKEY';
const HDR = 'team-SECRET-5544332211';

const data = (o: unknown): string => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta: object, finish: string | null = null, extra: object = {}): object => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
  model: 'served-model',
  ...extra,
});

function provider(over: Partial<OpenAIChatOptions> = {}): Provider {
  return createOpenAIChatProvider({ connectionId: 'local', baseUrl: BASE, local: true, ...over });
}

/** Ollama-like caps (stream_options), aimed at the mock. */
function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return request({
    caps: capsAt('http://127.0.0.1:11434', 'm'),
    model: { connection: 'local', model: 'm' },
    messages: [msg('system', 'You are Mara, who keeps the tavern.'), msg('user', 'Hello there, how are you today?')],
    ...over,
  });
}

/** A recorder whose lines land in an array. */
function recorder(inner: Provider, secrets: readonly string[] = []): { rec: Provider; lines: string[] } {
  const lines: string[] = [];
  const rec = createRecordingProvider(inner, (line) => lines.push(line), { connection: 'local', secrets: () => secrets });
  return { rec, lines };
}

/** Collect until the stream ends or throws. */
async function drain(it: AsyncIterable<StreamEv>): Promise<{ events: StreamEv[]; thrown: unknown }> {
  const events: StreamEv[] = [];
  try {
    for await (const ev of it) events.push(ev);
  } catch (e) {
    return { events, thrown: e };
  }
  return { events, thrown: undefined };
}

/** A fetch that must never be called (replay has no network). */
const noFetch = (() => {
  throw new Error('replay must not fetch');
}) as unknown as typeof fetch;

const STORY_SSE =
  data(chunk({ role: 'assistant', reasoning_content: 'She weighs ' })) +
  data(chunk({ reasoning_content: 'the question.' })) +
  data(chunk({ content: 'Mara sets down ' })) +
  data(chunk({ content: 'the mug.' })) +
  data(chunk({}, 'stop')) +
  data({ choices: [], usage: { prompt_tokens: 61, completion_tokens: 9 }, model: 'served-model' }) +
  data('[DONE]');

describe('record, then replay', () => {
  test('a streamed call (reasoning, text, finish, usage) is recorded and replays as the same event sequence', async () => {
    handler = () => new Response(STORY_SSE, { headers: SSE });
    const { rec, lines } = recorder(provider());
    const r = req({ samplers: { temperature: 0.7 } });
    const live = await drain(rec.stream(r, { fetch, key: null }));
    expect(live.thrown).toBeUndefined();
    expect(live.events).toEqual([
      { t: 'reasoning', i: 0, d: 'She weighs ' },
      { t: 'reasoning', i: 0, d: 'the question.' },
      { t: 'reasoning_end', i: 0 },
      { t: 'text', i: 0, d: 'Mara sets down ' },
      { t: 'text', i: 0, d: 'the mug.' },
      { t: 'finish', reason: 'end', raw: 'stop', model: 'served-model' },
      { t: 'usage', u: { inputTotal: 61, outputTotal: 9 } },
    ]);

    expect(lines).toHaveLength(1);
    const calls = parseRecording(lines.join('\n'));
    const call = calls[0]!;
    expect(call.v).toBe(1);
    expect(call.requestHash).toBe(hashRequest(r));
    expect(call.request).toEqual(recordedRequest(r));
    expect(call.model).toEqual({ connection: 'local', model: 'm' });
    expect(call.raw).toBe(STORY_SSE);
    expect(call.aborted).toBeUndefined();

    const replay = createReplayProvider(calls);
    expect(replay.remaining()).toBe(1);
    const again = await drain(replay.stream(req({ samplers: { temperature: 0.7 } }), { fetch: noFetch, key: null }));
    expect(again.thrown).toBeUndefined();
    expect(again.events).toEqual(live.events);
    expect(replay.remaining()).toBe(0);
  });

  test('events pass through as they arrive: the first text is seen while the server still holds the stream', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const safety = setTimeout(() => release(), 3000); // a buffering recorder fails the assertion, never hangs
    let ended = false;
    let step = 0;
    handler = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            if (step++ === 0) {
              c.enqueue(enc.encode(data(chunk({ content: 'first ' }))));
              return;
            }
            await gate;
            c.enqueue(enc.encode(data(chunk({ content: 'second' }, 'stop')) + data('[DONE]')));
            ended = true;
            c.close();
          },
        }),
        { headers: SSE },
      );
    const { rec, lines } = recorder(provider());
    const events: StreamEv[] = [];
    let endedAtFirstText: boolean | undefined;
    for await (const ev of rec.stream(req(), { fetch, key: null })) {
      events.push(ev);
      if (ev.t === 'text' && endedAtFirstText === undefined) {
        endedAtFirstText = ended;
        release();
      }
    }
    clearTimeout(safety);
    expect(endedAtFirstText).toBe(false);
    expect(events.filter((e) => e.t === 'text').map((e) => (e as { d: string }).d)).toEqual(['first ', 'second']);
    expect(parseRecording(lines[0]!)[0]!.raw).toBe(data(chunk({ content: 'first ' })) + data(chunk({ content: 'second' }, 'stop')) + data('[DONE]'));
  });

  test('an HTTP 429 with Retry-After is recorded as its error fields and replays as an equal ProviderError', async () => {
    const body = JSON.stringify({ error: { message: 'Rate limit exceeded: slow down', type: 'rate_limit' } });
    handler = () => new Response(body, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } });
    const { rec, lines } = recorder(provider());
    const live = await drain(rec.stream(req(), { fetch, key: null }));
    expect(live.events).toHaveLength(1);
    const ev = live.events[0]!;
    if (ev.t !== 'error') throw new Error('expected an error event');
    expect(ev.err.code).toBe('rate_limited');
    expect(ev.err.detail).toContain('slow down');

    const call = parseRecording(lines[0]!)[0]!;
    expect(call.events).toEqual([
      {
        t: 'error',
        err: { category: 'rate', code: 'rate_limited', message: 'the server is rate limiting requests (HTTP 429)', status: 429, retryAfterSec: 7 },
        afterOutput: false,
      },
    ]);
    expect(call.raw).toBe(body);
    // The server's words reach the file only inside raw, never as an error's detail.
    expect(lines[0]!).not.toContain('"detail"');

    const again = await drain(createReplayProvider([call]).stream(req(), { fetch: noFetch, key: null }));
    expect(again.events).toHaveLength(1);
    const back = again.events[0]!;
    if (back.t !== 'error') throw new Error('expected an error event');
    expect(back.err).toBeInstanceOf(ProviderError);
    expect(back.afterOutput).toBe(false);
    for (const k of ['category', 'code', 'message', 'status', 'retryAfterSec', 'afterOutput'] as const) expect(back.err[k]).toEqual(ev.err[k]);
    expect(back.err.detail).toBeUndefined();
  });

  test('an aborted call: the abort is rethrown after the line is written, the server stream is cancelled, and an interactive replay holds until its own abort', async () => {
    let cancelled = false;
    let step = 0;
    handler = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            if (step++ === 0) c.enqueue(enc.encode(data(chunk({ content: 'Once ' }))));
            else await new Promise<void>(() => {}); // stall
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: SSE },
      );
    const { rec, lines } = recorder(provider());
    const ac = new AbortController();
    const reason = new Error('user stop');
    const got: StreamEv[] = [];
    let thrown: unknown;
    try {
      for await (const ev of rec.stream(req({ signal: ac.signal }), { fetch, key: null })) {
        got.push(ev);
        if (ev.t === 'text') ac.abort(reason);
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(reason);
    expect(got).toEqual([{ t: 'text', i: 0, d: 'Once ' }]);
    expect(lines).toHaveLength(1);
    const call = parseRecording(lines[0]!)[0]!;
    expect(call.aborted).toBe(true);
    expect(call.events).toEqual([{ t: 'text', i: 0, d: 'Once ' }]);
    expect(call.raw).toBe(data(chunk({ content: 'Once ' })));
    for (let k = 0; k < 100 && !cancelled; k++) await sleep(10);
    expect(cancelled).toBe(true);

    // Interactive replay (holdAborted): the recorded prefix, then nothing until the replay's own signal aborts.
    const ac2 = new AbortController();
    const reason2 = new Error('stop again');
    const it = createReplayProvider([call], { holdAborted: true }).stream(req({ signal: ac2.signal }), { fetch: noFetch, key: null })[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ done: false, value: { t: 'text', i: 0, d: 'Once ' } });
    const pending = it.next();
    const raced = await Promise.race([pending.then(() => 'moved', () => 'threw'), sleep(50).then(() => 'held')]);
    expect(raced).toBe('held');
    ac2.abort(reason2);
    await expect(pending).rejects.toBe(reason2);

    // Otherwise (a piped or one-shot replay, nobody to press Ctrl+C): the prefix, then at once a
    // distinct failure, never a wait for the engine's timeout.
    const evs: StreamEv[] = [];
    for await (const ev of createReplayProvider([call]).stream(req(), { fetch: noFetch, key: null })) evs.push(ev);
    expect(evs[0]).toEqual({ t: 'text', i: 0, d: 'Once ' });
    const last = evs.at(-1)!;
    expect(last.t).toBe('error');
    if (last.t === 'error') {
      expect(last.err.code).toBe('replay_aborted');
      expect(last.afterOutput).toBe(true);
      expect(last.err.message).toContain('replay it in an interactive chat and press Ctrl+C');
    }
  });

  test('two calls in flight are recorded each with its own body', async () => {
    handler = async (r) => {
      const body = (await r.json()) as { messages: { content: string }[] };
      const who = body.messages.at(-1)!.content;
      await sleep(who === 'A' ? 30 : 0);
      return new Response(data(chunk({ content: `answer ${who}` }, 'stop')) + data('[DONE]'), { headers: SSE });
    };
    const { rec, lines } = recorder(provider());
    await Promise.all([
      drain(rec.stream(req({ messages: [msg('user', 'A')] }), { fetch, key: null })),
      drain(rec.stream(req({ messages: [msg('user', 'B')] }), { fetch, key: null })),
    ]);
    const calls = parseRecording(lines.join('\n'));
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const who = (c.request.messages[0]!.blocks[0] as { text: string }).text;
      expect(c.raw).toBe(data(chunk({ content: `answer ${who}` }, 'stop')) + data('[DONE]'));
    }
  });
});

describe('secrets', () => {
  test('a key and a header value echoed back by a malicious body never reach the recording file', async () => {
    handler = (r) => {
      const auth = r.headers.get('authorization') ?? '';
      const key = auth.replace(/^Bearer /, '');
      const hdr = r.headers.get('x-team-token') ?? '';
      const half = Math.floor(key.length / 2);
      return new Response(
        `: echo ${auth} ${hdr}\n\n` +
          data(chunk({ reasoning_content: `the key ${key} again` })) +
          // The key split across two text deltas.
          data(chunk({ content: `your key is ${key.slice(0, half)}` })) +
          data(chunk({ content: `${key.slice(half)} and the token ${hdr}.` })) +
          data(chunk({}, 'stop', { model: `model-${key}` })) +
          data('[DONE]'),
        { headers: SSE },
      );
    };
    // Only the header value is listed: the call's own key (env.key) is scrubbed regardless.
    const { rec, lines } = recorder(provider({ overrides: { headers: { 'X-Team-Token': HDR } } }), [HDR]);
    const live = await drain(rec.stream(req(), { fetch, key: KEY }));
    expect(live.thrown).toBeUndefined();
    // The consumer gets the events unchanged.
    const liveText = live.events.map((e) => (e.t === 'text' ? e.d : '')).join('');
    expect(liveText).toBe(`your key is ${KEY} and the token ${HDR}.`);

    const file = join(tmpHome('rp-core-record-'), 'calls.jsonl');
    for (const line of lines) appendFileSync(file, `${line}\n`);
    const onDisk = readFileSync(file, 'utf8');
    for (const s of [KEY, HDR, JSON.stringify(KEY).slice(1, -1), JSON.stringify(HDR).slice(1, -1)]) expect(onDisk).not.toContain(s);

    const call = parseRecording(onDisk)[0]!;
    expect(call.raw).toContain(': echo Bearer [redacted] [redacted]');
    expect(call.raw).toContain('the key [redacted] again');
    // Events are scrubbed per channel: the key split across two deltas is gone from both.
    expect(JSON.stringify(call.events)).not.toContain(KEY.slice(0, 12));
    expect(JSON.stringify(call.events)).not.toContain(KEY.slice(13));
    const replayed = await drain(createReplayProvider([call]).stream(req(), { fetch: noFetch, key: null }));
    // The deltas keep their number: the split key is redacted where it starts.
    expect(replayed.events.filter((e) => e.t === 'text')).toEqual([
      { t: 'text', i: 0, d: 'your key is [redacted]' },
      { t: 'text', i: 0, d: ' and the token [redacted].' },
    ]);
    expect(replayed.events.find((e) => e.t === 'reasoning')).toEqual({ t: 'reasoning', i: 0, d: 'the key [redacted] again' });
    expect(replayed.events.find((e) => e.t === 'finish')).toEqual({ t: 'finish', reason: 'end', raw: 'stop', model: 'model-[redacted]' });
  });

  test('a secret echoed JSON-escaped in the raw body (\\/, \\") is scrubbed too', async () => {
    const odd = 'sk-odd/0123"4567\\89';
    const escaped = JSON.stringify(odd).slice(1, -1);
    const body = `data: {"error":{"message":"bad key ${escaped.replaceAll('/', '\\/')}"}}\n\n`;
    const fake = (async () => new Response(body, { headers: SSE })) as unknown as typeof fetch;
    const { rec, lines } = recorder(provider());
    await drain(rec.stream(req(), { fetch: fake, key: odd }));
    expect(lines[0]!).not.toContain(escaped);
    expect(lines[0]!).not.toContain('0123');
    expect(parseRecording(lines[0]!)[0]!.raw).toBe('data: {"error":{"message":"bad key [redacted]"}}\n\n');
  });

  test('a 401 whose body quotes the key: the raw body is scrubbed, the error keeps its fixed message', async () => {
    handler = (r) =>
      new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${(r.headers.get('authorization') ?? '').slice(7)}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const { rec, lines } = recorder(provider());
    await drain(rec.stream(req(), { fetch, key: KEY }));
    expect(lines[0]!).not.toContain(KEY);
    const call = parseRecording(lines[0]!)[0]!;
    expect(call.raw).toBe(JSON.stringify({ error: { message: 'Incorrect API key provided: [redacted]' } }));
    expect(call.events).toEqual([
      { t: 'error', err: { category: 'auth', code: 'auth_failed', message: 'the server refused the API key (HTTP 401)', status: 401 }, afterOutput: false },
    ]);
  });
});

describe('replay failures', () => {
  test('one changed character fails the call with replay_mismatch and a readable diff', async () => {
    const lines: string[] = [];
    const rec = createRecordingProvider(createScriptedProvider([{ steps: [{ text: 'Fine, thanks.' }] }]), (l) => lines.push(l));
    await drain(rec.stream(req(), { fetch: noFetch, key: null }));
    const replay = createReplayProvider(parseRecording(lines[0]!));
    const changed = req({ messages: [msg('system', 'You are Mara, who keeps the tavern.'), msg('user', 'Hello there, how are you tonight?')] });
    const out = await drain(replay.stream(changed, { fetch: noFetch, key: null }));
    expect(out.thrown).toBeUndefined();
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    if (ev.t !== 'error') throw new Error('expected an error event');
    expect(ev.afterOutput).toBe(false);
    expect(ev.err).toBeInstanceOf(ProviderError);
    expect(ev.err.code).toBe('replay_mismatch');
    expect(ev.err.category).toBe('request');
    expect(ev.err.status).toBeUndefined();
    expect(ev.err.message).toBe(
      [
        `${PROVIDER_ERROR_MESSAGE.replay_mismatch} (recorded call 1 of 1)`,
        'first difference: messages[1] (user)',
        '  at char 27 (recorded 31 chars, actual 33)',
        '  recorded: Hello there, how are you today?',
        '  actual:   Hello there, how are you tonight?',
        '                                       ^',
      ].join('\n'),
    );
    expect(replay.remaining()).toBe(0);
  });

  test('running out of recorded calls fails with script_exhausted', async () => {
    const lines: string[] = [];
    const rec = createRecordingProvider(createScriptedProvider([{ steps: [{ text: 'one' }] }]), (l) => lines.push(l));
    await drain(rec.stream(req(), { fetch: noFetch, key: null }));
    const replay = createReplayProvider(parseRecording(lines[0]!));
    const first = await drain(replay.stream(req(), { fetch: noFetch, key: null }));
    expect(first.events.map((e) => e.t)).toEqual(['text', 'finish']);
    const second = await drain(replay.stream(req(), { fetch: noFetch, key: null }));
    expect(second.events).toHaveLength(1);
    const ev = second.events[0]!;
    if (ev.t !== 'error') throw new Error('expected an error event');
    expect(ev.err.code).toBe('script_exhausted');
    expect(ev.err.category).toBe('request');
    expect(ev.err.message).toBe('the recording ran out of calls: request 2 has no recorded call left (the recording has 1)');

    const empty = await drain(createReplayProvider([]).stream(req(), { fetch: noFetch, key: null }));
    expect(empty.events[0]!.t === 'error' && empty.events[0]!.err.code).toBe('script_exhausted');
  });

  test('a replay honours an already-aborted signal', async () => {
    const lines: string[] = [];
    const rec = createRecordingProvider(createScriptedProvider([{ steps: [{ text: 'one' }] }]), (l) => lines.push(l));
    await drain(rec.stream(req(), { fetch: noFetch, key: null }));
    const ac = new AbortController();
    const reason = new Error('gone');
    ac.abort(reason);
    const out = await drain(createReplayProvider(parseRecording(lines[0]!)).stream(req({ signal: ac.signal }), { fetch: noFetch, key: null }));
    expect(out.events).toEqual([]);
    expect(out.thrown).toBe(reason);
  });
});

describe('wire()', () => {
  test('returns exactly the body the provider sends, with the URL and no headers', async () => {
    seen.length = 0;
    handler = () => new Response(data(chunk({ content: 'x' }, 'stop')) + data('[DONE]'), { headers: SSE });
    const p = provider({ overrides: { headers: { 'X-Team-Token': HDR }, extraBody: { cache_prompt: true } } });
    const r = req({ samplers: { temperature: 0.8, top_p: 0.9 }, maxTokens: 300, stop: ['\nUser:'] });
    const w = p.wire!(r);
    expect(Object.keys(w).sort()).toEqual(['body', 'url']);
    expect(w.url).toBe(`${BASE}/v1/chat/completions`);
    await drain(p.stream(r, { fetch, key: KEY }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(seen[0]!.body)).toEqual(w.body);
    const shown = JSON.stringify(w);
    for (const s of [KEY, HDR, 'Bearer', 'Authorization']) expect(shown).not.toContain(s);
  });

  test('the recorder passes wire() through; the replay provider has none', () => {
    const p = provider();
    const { rec } = recorder(p);
    expect(rec.wire!(req())).toEqual(p.wire!(req()));
    expect(createReplayProvider([]).wire).toBeUndefined();
    expect(recorder(createScriptedProvider([])).rec.wire).toBeUndefined();
  });
});

describe('raw capture', () => {
  /** A fetch that answers with `parts`, one chunk each (no network). */
  const fakeFetch = (parts: readonly Uint8Array[]): typeof fetch =>
    (async () => {
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            const next = parts[n++];
            if (next === undefined) c.close();
            else c.enqueue(next);
          },
        }),
        { headers: SSE },
      );
    }) as unknown as typeof fetch;

  test('one streaming decoder: UTF-8 split across chunks byte by byte is recorded whole', async () => {
    // No [DONE]: the stream is read to its end, so raw is the whole body.
    const body = data(chunk({ content: 'Мира улыбается 🌙' }, 'stop'));
    const parts: Uint8Array[] = [];
    for await (const b of bytesIn(body, 1)) parts.push(b);
    const { rec, lines } = recorder(provider());
    const live = await drain(rec.stream(req(), { fetch: fakeFetch(parts), key: null }));
    expect(live.events[0]).toEqual({ t: 'text', i: 0, d: 'Мира улыбается 🌙' });
    expect(parseRecording(lines[0]!)[0]!.raw).toBe(body);
  });

  test('raw is capped at 4 MiB and marked; the consumer still gets the whole stream; a key cut at the cap leaves no prefix', async () => {
    // 4095 comment lines of 1 KiB, then a line that puts the key 10 bytes before the cap.
    const line = `: ${'x'.repeat(1021)}\n`;
    const head = line.repeat(4095) + `: ${'y'.repeat(1024 - 10 - 2)}`;
    expect(enc.encode(head).byteLength).toBe(RAW_CAP_BYTES - 10);
    const body = `${head}${KEY}\n\n${line.repeat(200)}${data(chunk({ content: 'after the cap' }, 'stop'))}${data('[DONE]')}`;
    const bytes = enc.encode(body);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 64 * 1024) parts.push(bytes.slice(i, i + 64 * 1024));
    const { rec, lines } = recorder(provider());
    const live = await drain(rec.stream(req(), { fetch: fakeFetch(parts), key: KEY }));
    expect(live.events.map((e) => e.t)).toEqual(['text', 'finish']);
    const call = parseRecording(lines[0]!)[0]!;
    expect(call.events.map((e) => e.t)).toEqual(['text', 'finish']);
    const raw = call.raw!;
    expect(raw.endsWith(RAW_TRUNCATED_MARK)).toBe(true);
    expect(raw.startsWith(head)).toBe(true);
    expect(raw).toBe(`${head}[redacted]${RAW_TRUNCATED_MARK}`);
    expect(lines[0]!).not.toContain(KEY.slice(0, 10));
  });

  test('a provider that never fetches is recorded without raw', async () => {
    const scripted = createScriptedProvider([
      { steps: [{ reasoning: 'hm' }, { tool: { name: 'roll', args: { sides: 20 }, id: 'c1' } }, { usage: { inputTotal: 3 } }, { finish: 'end' }] },
    ]);
    const { rec, lines } = recorder(scripted);
    const live = await drain(rec.stream(req(), { fetch: noFetch, key: null }));
    const call: RecordedCall = parseRecording(lines[0]!)[0]!;
    expect('raw' in call).toBe(false);
    const again = await drain(createReplayProvider([call]).stream(req(), { fetch: noFetch, key: null }));
    expect(again.events).toEqual(live.events);
  });
});
