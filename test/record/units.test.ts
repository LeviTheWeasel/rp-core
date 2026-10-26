// record.ts without a network: the recorded forms, parseRecording, requestDiff, and the recorder's
// behaviour on the ways a call can end (scripted inner provider).
import { describe, expect, test } from 'bun:test';
import {
  createRecordingProvider,
  createReplayProvider,
  fromRecordedEv,
  parseRecording,
  recordedRequest,
  requestDiff,
  toRecordedEv,
  type RecordedCall,
  type RecordedRequest,
} from '../../src/providers/record.ts';
import { createScriptedProvider, hashRequest, parseScript } from '../../src/providers/scripted.ts';
import { ProviderError, type ModelRequest, type Provider, type StreamEv } from '../../src/providers/types.ts';
import { blocks, msg, request } from '../adapter/kit.ts';

const noFetch = (() => {
  throw new Error('no fetch here');
}) as unknown as typeof fetch;
const env = { fetch: noFetch, key: null };

async function drain(it: AsyncIterable<StreamEv>): Promise<{ events: StreamEv[]; thrown: unknown }> {
  const events: StreamEv[] = [];
  try {
    for await (const ev of it) events.push(ev);
  } catch (e) {
    return { events, thrown: e };
  }
  return { events, thrown: undefined };
}

/** One recorded call of the scripted provider, as a parsed RecordedCall and as its line. */
async function recordOne(r: ModelRequest, steps = [{ text: 'ok' }]): Promise<{ call: RecordedCall; line: string }> {
  const lines: string[] = [];
  const rec = createRecordingProvider(createScriptedProvider([{ steps }]), (l) => lines.push(l));
  await drain(rec.stream(r, env));
  return { call: parseRecording(lines[0]!)[0]!, line: lines[0]! };
}

const base = (): RecordedRequest => ({
  messages: [
    { role: 'system', blocks: [{ k: 'text', text: 'You are Mara.' }] },
    { role: 'user', blocks: [{ k: 'text', text: 'Hello.' }] },
  ],
  maxTokens: 256,
  samplers: { temperature: 0.7 },
});

describe('recordedRequest', () => {
  test('deterministic, a snapshot, and it hashes like the live request', () => {
    const r = request({ messages: [msg('user', 'hi')], tools: [{ name: 'roll', description: 'dice', schema: { type: 'object' } }], prefill: 'Mara:', samplers: { temperature: 0.5, top_p: undefined } });
    const a = recordedRequest(r);
    expect(a).toEqual(recordedRequest(r));
    expect(a).toEqual({
      messages: [{ role: 'user', blocks: [{ k: 'text', text: 'hi' }] }],
      tools: [{ name: 'roll', description: 'dice', schema: { type: 'object' } }],
      prefill: 'Mara:',
      maxTokens: 256,
      samplers: { temperature: 0.5 },
    });
    expect('top_p' in a.samplers).toBe(false);
    expect(hashRequest(a as unknown as ModelRequest)).toBe(hashRequest(r));
    (r.messages[0]!.blocks[0] as { text: string }).text = 'changed';
    expect(a.messages[0]!.blocks[0]).toEqual({ k: 'text', text: 'hi' });
  });

  test('no tools and no prefill: the fields are absent', () => {
    const a = recordedRequest(request());
    expect('tools' in a).toBe(false);
    expect('prefill' in a).toBe(false);
  });
});

describe('ProviderError <-> RecordedEv', () => {
  test('category, code, message, status, retryAfterSec and afterOutput round-trip; detail is never recorded', () => {
    const err = new ProviderError({ category: 'rate', code: 'rate_limited', message: 'slow (HTTP 429)', status: 429, retryAfterSec: 2.5, afterOutput: true, detail: 'server words' });
    const rec = toRecordedEv({ t: 'error', err, afterOutput: true });
    expect(rec).toEqual({ t: 'error', err: { category: 'rate', code: 'rate_limited', message: 'slow (HTTP 429)', status: 429, retryAfterSec: 2.5 }, afterOutput: true });
    const back = fromRecordedEv(JSON.parse(JSON.stringify(rec)));
    if (back.t !== 'error') throw new Error('expected an error');
    expect(back.err).toBeInstanceOf(ProviderError);
    expect([back.err.category, back.err.code, back.err.message, back.err.status, back.err.retryAfterSec, back.err.afterOutput, back.afterOutput]).toEqual([
      'rate',
      'rate_limited',
      'slow (HTTP 429)',
      429,
      2.5,
      true,
      true,
    ]);
    expect(back.err.detail).toBeUndefined();
  });

  test('optional fields stay absent', () => {
    const err = new ProviderError({ category: 'network', code: 'truncated_stream', message: 'cut' });
    const rec = toRecordedEv({ t: 'error', err, afterOutput: false });
    expect(rec).toEqual({ t: 'error', err: { category: 'network', code: 'truncated_stream', message: 'cut' }, afterOutput: false });
    const back = fromRecordedEv(rec);
    if (back.t !== 'error') throw new Error('expected an error');
    expect(back.err.status).toBeUndefined();
    expect(back.err.retryAfterSec).toBeUndefined();
  });

  test('other events keep exactly their fields; usage keeps only finite numbers', () => {
    expect(toRecordedEv({ t: 'finish', reason: 'end', raw: 'stop' })).toEqual({ t: 'finish', reason: 'end', raw: 'stop' });
    expect(toRecordedEv({ t: 'reasoning_end', i: 0, signature: 'sig', redacted: true })).toEqual({ t: 'reasoning_end', i: 0, signature: 'sig', redacted: true });
    expect(toRecordedEv({ t: 'usage', u: { inputTotal: 5, outputTotal: Number.NaN } })).toEqual({ t: 'usage', u: { inputTotal: 5 } });
    const ev = toRecordedEv({ t: 'usage', u: { inputTotal: 5 } });
    const back = fromRecordedEv(ev);
    expect(back).toEqual(ev as StreamEv);
    expect(back).not.toBe(ev as StreamEv);
  });
});

describe('the recorder', () => {
  test('a consumer that stops early (no abort) still gets its line, not marked aborted', async () => {
    const lines: string[] = [];
    const rec = createRecordingProvider(createScriptedProvider([{ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }]), (l) => lines.push(l));
    for await (const ev of rec.stream(request(), env)) if (ev.t === 'text') break;
    expect(lines).toHaveLength(1);
    const call = parseRecording(lines[0]!)[0]!;
    expect(call.events).toEqual([{ t: 'text', i: 0, d: 'a' }]);
    expect(call.aborted).toBeUndefined();
  });

  test('a call aborted while paused is rethrown with its reason and marked aborted', async () => {
    const lines: string[] = [];
    const scripted = createScriptedProvider([{ steps: [{ text: 'a' }, { pause: 'p' }, { text: 'b' }] }]);
    const rec = createRecordingProvider(scripted, (l) => lines.push(l));
    const ac = new AbortController();
    const reason = new Error('timeout:idle');
    const it = rec.stream(request({ signal: ac.signal }), env)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ t: 'text', i: 0, d: 'a' });
    const pending = it.next();
    ac.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const call = parseRecording(lines[0]!)[0]!;
    expect(call.aborted).toBe(true);
    expect(call.events).toEqual([{ t: 'text', i: 0, d: 'a' }]);
  });

  test('a provider that throws: the throw is rethrown after the line; a throwing sink does not hide it', async () => {
    const boom = new Error('provider bug');
    const thrower: Provider = {
      async *stream() {
        yield { t: 'text', i: 0, d: 'x' };
        throw boom;
      },
    };
    const lines: string[] = [];
    const out = await drain(createRecordingProvider(thrower, (l) => lines.push(l)).stream(request(), env));
    expect(out.thrown).toBe(boom);
    expect(parseRecording(lines[0]!)[0]!.events).toEqual([{ t: 'text', i: 0, d: 'x' }]);

    const failingSink = () => {
      throw new Error('disk full');
    };
    const hidden = await drain(createRecordingProvider(thrower, failingSink).stream(request(), env));
    expect(hidden.thrown).toBe(boom);
    // A call that went well fails when its line cannot be written.
    const ok = await drain(createRecordingProvider(createScriptedProvider([{ steps: [{ text: 'y' }] }]), failingSink).stream(request(), env));
    expect((ok.thrown as Error).message).toBe('disk full');
  });

  test('the inner call starts at stream() time, as without the recorder; a synchronous throw is recorded and rethrown', async () => {
    const scripted = createScriptedProvider([{ steps: [{ text: 'a' }] }]);
    const lines: string[] = [];
    const rec = createRecordingProvider(scripted, (l) => lines.push(l));
    const it = rec.stream(request(), env);
    expect(scripted.remaining()).toBe(0);
    await drain(it);
    expect(lines).toHaveLength(1);

    const boom = new Error('sync');
    const sync: Provider = {
      stream() {
        throw boom;
      },
    };
    const out = await drain(createRecordingProvider(sync, (l) => lines.push(l)).stream(request(), env));
    expect(out.thrown).toBe(boom);
    expect(parseRecording(lines[1]!)[0]!.events).toEqual([]);
  });

  test('the connection defaults to the request model; opts.connection wins', async () => {
    const r = request({ model: { connection: 'cloud', model: 'big' } });
    expect((await recordOne(r)).call.model).toEqual({ connection: 'cloud', model: 'big' });
    const lines: string[] = [];
    await drain(createRecordingProvider(createScriptedProvider([{ steps: [] }]), (l) => lines.push(l), { connection: 'other' }).stream(r, env));
    expect(parseRecording(lines[0]!)[0]!.model).toEqual({ connection: 'other', model: 'big' });
  });

  test('secrets from secrets() are scrubbed from the request and error messages too', async () => {
    const lines: string[] = [];
    const scripted = createScriptedProvider([{ steps: [{ error: { code: 'bad_request', message: 'echo sekret-123456 here' } }] }]);
    const rec = createRecordingProvider(scripted, (l) => lines.push(l), { secrets: () => ['sekret-123456', 'short'] });
    await drain(rec.stream(request({ messages: [msg('user', 'my key is sekret-123456')] }), env));
    expect(lines[0]!).not.toContain('sekret-123456');
    const call = parseRecording(lines[0]!)[0]!;
    expect(call.request.messages[0]!.blocks[0]).toEqual({ k: 'text', text: 'my key is [redacted]' });
    expect(call.events[0]).toMatchObject({ t: 'error', err: { message: 'echo [redacted] here' } });
  });
});

describe('parseRecording', () => {
  test('reads its own lines, with a BOM, CRLF and blank lines', async () => {
    const { line } = await recordOne(request());
    const calls = parseRecording(`﻿${line}\r\n\r\n${line}\r\n`);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]!);
  });

  test('a line without "v": 1 is rejected with its line number', async () => {
    const { line } = await recordOne(request());
    const noV = JSON.stringify({ ...JSON.parse(line), v: undefined });
    expect(() => parseRecording(`${line}\n\n${noV}`)).toThrow(/^recording line 3: no "v": 1/);
    expect(() => parseRecording(JSON.stringify({ ...JSON.parse(line), v: 2 }))).toThrow('recording line 1: unsupported version "v": 2');
  });

  test('a script is not a recording, and a recording is not a script', async () => {
    expect(() => parseRecording('[{"text":"hi"}]')).toThrow(/recording line 1: this is a script call/);
    expect(() => parseRecording('{"steps":[{"text":"hi"}]}')).toThrow(/recording line 1: no "v": 1/);
    const { line } = await recordOne(request());
    expect(() => parseScript(line)).toThrow(/script line 1/);
  });

  test('bad fields are named', async () => {
    const { line } = await recordOne(request());
    const call = JSON.parse(line) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...call, ...patch });
    expect(() => parseRecording(bad({ extra: 1 }))).toThrow('unknown field "extra"');
    expect(() => parseRecording(bad({ requestHash: 'XYZ' }))).toThrow('"requestHash" must be 16 lowercase hex chars');
    expect(() => parseRecording(bad({ events: [{ t: 'text', i: 0 }] }))).toThrow('recording line 1: event 1: "text".d must be a string');
    expect(() => parseRecording(bad({ events: [{ t: 'nope' }] }))).toThrow('event 1: unknown event type "nope"');
    expect(() => parseRecording(bad({ events: [{ t: 'error', err: { category: 'rate', code: 'nope', message: 'm' }, afterOutput: false }] }))).toThrow('unknown error code "nope"');
    expect(() => parseRecording(bad({ events: [{ t: 'finish', reason: 'done', raw: '' }] }))).toThrow('unknown finish reason "done"');
    expect(() => parseRecording(bad({ request: { messages: [{ role: 'narrator', blocks: [] }], maxTokens: 1, samplers: {} } }))).toThrow('request.messages[0]');
    expect(() => parseRecording(bad({ aborted: false }))).toThrow('"aborted" must be true');
    expect(() => parseRecording('{not json')).toThrow(/recording line 1: invalid JSON/);
  });
});

describe('requestDiff', () => {
  test('identical requests', () => {
    expect(requestDiff(base(), base())).toBe('no difference in what the model sees');
  });

  test('an added message, counts first', () => {
    const a = base();
    a.messages.push({ role: 'assistant', blocks: [{ k: 'text', text: 'Mara nods.\nShe waits.' }] });
    expect(requestDiff(base(), a)).toBe(['messages: 2 recorded, 3 actual', 'first difference: messages[2] (assistant) is only in the actual request: "Mara nods.\\nShe waits."'].join('\n'));
  });

  test('a long message shows ±60 characters around the first difference, the role, and how many others differ', () => {
    const long = 'a'.repeat(500) + 'X' + 'b'.repeat(500);
    const r = base();
    const a = base();
    r.messages[1] = { role: 'user', blocks: [{ k: 'text', text: long }] };
    a.messages[1] = { role: 'user', blocks: [{ k: 'text', text: long.replace('X', 'Y') }] };
    a.messages[0] = { role: 'system', blocks: [{ k: 'text', text: 'You are Mara!' }] };
    r.messages.push({ role: 'user', blocks: [{ k: 'text', text: 'same' }] });
    a.messages.push({ role: 'user', blocks: [{ k: 'text', text: 'same' }] });
    const lines = requestDiff(r, a).split('\n');
    expect(lines[0]).toBe('first difference: messages[0] (system)');
    expect(lines[1]).toBe('  at char 12 (recorded 13 chars, actual 13)');
    expect(lines[5]).toBe('1 more of the 3 shared messages differ');

    const only = requestDiff({ ...base(), messages: [r.messages[1]!] }, { ...base(), messages: [a.messages[1]!] }).split('\n');
    expect(only[2]).toBe(`  recorded: …${'a'.repeat(60)}X${'b'.repeat(59)}…`);
    expect(only[3]).toBe(`  actual:   …${'a'.repeat(60)}Y${'b'.repeat(59)}…`);
    expect(only[4]).toBe(`${' '.repeat(12 + 1 + 60)}^`);
  });

  test('role, tools, prefill, maxTokens and samplers', () => {
    const r: RecordedRequest = { ...base(), tools: [{ name: 'roll', description: 'dice', schema: {} }, { name: 'look', description: 'eyes', schema: {} }] };
    const a: RecordedRequest = {
      ...base(),
      messages: [base().messages[0]!, { role: 'assistant', blocks: [{ k: 'text', text: 'Hello.' }] }],
      tools: [{ name: 'roll', description: 'two dice', schema: {} }, { name: 'map', description: 'where', schema: {} }],
      prefill: 'Mara:',
      maxTokens: 512,
      samplers: { temperature: 0.8, seed: 7 },
    };
    expect(requestDiff(r, a)).toBe(
      [
        'first difference: messages[1] (role user recorded, assistant actual)',
        'tools: 2 recorded, 2 actual (added: map; removed: look; changed: roll)',
        'prefill: none recorded, "Mara:" actual',
        'maxTokens: 256 recorded, 512 actual',
        'samplers.seed: unset recorded, 7 actual',
        'samplers.temperature: 0.7 recorded, 0.8 actual',
      ].join('\n'),
    );
  });

  test('block lists that read the same as text are compared as JSON; non-text blocks are named', () => {
    const r = base();
    const a = base();
    r.messages[1] = { role: 'user', blocks: [{ k: 'text', text: 'a\n\nb' }] };
    a.messages[1] = { role: 'user', blocks: [{ k: 'text', text: 'a' }, { k: 'text', text: 'b' }] };
    expect(requestDiff(r, a).split('\n')[2]).toBe('  recorded: [{"k":"text","text":"a\\n\\nb"}]');
    const t = base();
    t.messages[1] = blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{"sides":6}' });
    const u = base();
    u.messages[1] = blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{"sides":8}' });
    expect(requestDiff(t, u)).toContain('  recorded: [tool_call roll c1] {"sides":6}');
  });

  test('at most 40 lines', () => {
    const many: Record<string, number> = {};
    for (let n = 0; n < 60; n++) many[`k${String(n).padStart(2, '0')}`] = n;
    const lines = requestDiff(base(), { ...base(), samplers: many as never }).split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[39]).toBe('… 22 more lines');
  });
});

describe('replay', () => {
  test('a hand-edited recording whose request no longer matches its hash says so', async () => {
    const { call } = await recordOne(request());
    // The request was edited, its hash was not: the new request matches the text but not the hash.
    const edited: RecordedCall = { ...call, request: { ...call.request, maxTokens: 9 } };
    const out = await drain(createReplayProvider([edited]).stream(request({ maxTokens: 9 }), env));
    const ev = out.events[0]!;
    if (ev.t !== 'error') throw new Error('expected an error');
    expect(ev.err.code).toBe('replay_mismatch');
    expect(ev.err.message.split('\n').slice(1)).toEqual([
      'no difference in what the model sees',
      `note: the recorded request hashes to ${hashRequest(request({ maxTokens: 9 }))}, not to its requestHash ${call.requestHash} (was the recording edited by hand?)`,
    ]);
  });

  test('a mismatch consumes the call, like the scripted provider', async () => {
    const { call } = await recordOne(request());
    const replay = createReplayProvider([call, call]);
    await drain(replay.stream(request({ maxTokens: 1 }), env));
    expect(replay.remaining()).toBe(1);
    const ok = await drain(replay.stream(request(), env));
    expect(ok.events.map((e) => e.t)).toEqual(['text', 'finish']);
  });
});
