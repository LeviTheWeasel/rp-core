// M3 (§8.6, decisions G1): the openai-chat reader's replay payloads go out as StreamEv 'replay',
// once per call and kind, right before the finish; record/replay keeps them (scrubbed like the rest
// of the line); the next round's wire carries them back. SSE fixtures: the M1b OpenRouter one
// (reasoning_details) and a hand-written Gemini-through-OpenAI one (extra_content on tool calls).
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChatRequest, createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';
import { createRecordingProvider, createReplayProvider, parseRecording, toRecordedEv, fromRecordedEv } from '../../src/providers/record.ts';
import { validateToolProtocol } from '../../src/providers/wire.ts';
import type { ModelRequest, PromptMsg, Replay, StreamEv } from '../../src/providers/types.ts';
import { blocks, capsAt, coalesce, collect, fixture, msg, parseSse, request } from '../adapter/kit.ts';

const GEMINI = capsAt('https://generativelanguage.googleapis.com:443', 'gemini-3-pro-preview');
const OPENROUTER = capsAt('https://openrouter.ai:443', 'google/gemini-3-pro-preview');
const SIZES = [0, 1, 7, 64];

const local = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');

const EXTRAS = {
  fc_1: { extra_content: { google: { thought_signature: 'c2lnLW9uZQ==' } } },
  fc_2: { extra_content: { google: { thought_signature: 'c2lnLXR3bw==' } } },
};

describe('replay events from SSE', () => {
  test('OpenRouter reasoning_details: one replay event, verbatim, before the finish; usage after it', async () => {
    for (const size of SIZES) {
      const { events } = await parseSse(request({ caps: OPENROUTER, model: { connection: 'or', model: 'g3' } }), fixture('openrouter-reasoning.sse'), size);
      const replays = events.filter((e) => e.t === 'replay');
      expect(replays).toHaveLength(1);
      const at = events.findIndex((e) => e.t === 'replay');
      expect(events[at + 1]?.t).toBe('finish');
      const r = (replays[0] as Extract<StreamEv, { t: 'replay' }>).r;
      expect(r.kind).toBe('reasoning_details');
      expect(r.connection).toBe('or');
      expect(r.model).toBe('g3');
      expect((r.payload as unknown[]).map((p) => (p as { type: string }).type)).toEqual(['reasoning.text', 'reasoning.text', 'reasoning.encrypted']);
    }
  });

  test('a call with extra fields: tool_extra keyed by call id, before the finish, at any chunking', async () => {
    for (const size of SIZES) {
      const { events } = await parseSse(request({ caps: GEMINI, model: { connection: 'g', model: 'gemini-3-pro-preview' } }), local('gemini-tool-extra.sse'), size);
      expect(coalesce(events)).toEqual([
        { t: 'text', i: 0, d: 'Let me check the archive.' },
        { t: 'tool_start', i: 0, id: 'fc_1', name: 'search_lore' },
        { t: 'tool_args', i: 0, d: '{"query": "amber"}' },
        { t: 'tool_start', i: 1, id: 'fc_2', name: 'read_lore' },
        { t: 'tool_args', i: 1, d: '{"ids":["L1"]}' },
        { t: 'tool_end', i: 0 },
        { t: 'tool_end', i: 1 },
        { t: 'replay', r: { kind: 'tool_extra', connection: 'g', model: 'gemini-3-pro-preview', payload: EXTRAS } },
        { t: 'finish', reason: 'end', raw: 'tool_calls', model: 'gemini-3-pro-preview' },
        { t: 'usage', u: { inputTotal: 120, outputTotal: 30 } },
      ]);
    }
  });

  test('no payloads, no replay event (a plain answer is exactly M2)', async () => {
    const { events } = await parseSse(request({ caps: GEMINI }), fixture('ollama-usage.sse'));
    expect(events.some((e) => e.t === 'replay')).toBe(false);
  });

  test('the payloads ride on the next round: tool_extra merged into each call, reasoning_details on the message', async () => {
    const { events } = await parseSse(request({ caps: GEMINI, model: { connection: 'g', model: 'gemini-3-pro-preview' } }), local('gemini-tool-extra.sse'));
    const replay = events.filter((e): e is Extract<StreamEv, { t: 'replay' }> => e.t === 'replay').map((e) => e.r);
    const details: Replay = { kind: 'reasoning_details', connection: 'g', model: 'gemini-3-pro-preview', payload: [{ type: 'reasoning.encrypted', data: 'zz' }] };
    const messages: PromptMsg[] = [
      msg('system', 'You are Mara.'),
      msg('user', 'What is amber?'),
      {
        ...blocks(
          'assistant',
          { k: 'text', text: 'Let me check the archive.' },
          { k: 'tool_call', id: 'fc_1', name: 'search_lore', args: '{"query":"amber"}' },
          { k: 'tool_call', id: 'fc_2', name: 'read_lore', args: '{"ids":["L1"]}' },
        ),
        replay: [...replay, details],
      },
      blocks('tool', { k: 'tool_result', callId: 'fc_1', name: 'search_lore', text: 'L1 Amber' }, { k: 'tool_result', callId: 'fc_2', name: 'read_lore', text: 'Amber is a stone.' }),
    ];
    expect(validateToolProtocol(messages)).toEqual({ ok: true });
    const req = request({ caps: { ...GEMINI, tools: 'native' }, model: { connection: 'g', model: 'gemini-3-pro-preview' }, messages });
    const body = JSON.parse(buildChatRequest(req, { connectionId: 'g', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', local: false }, null).body!) as {
      messages: Record<string, unknown>[];
    };
    const assistant = body.messages[2]!;
    expect(assistant.tool_calls).toEqual([
      { ...EXTRAS.fc_1, id: 'fc_1', type: 'function', function: { name: 'search_lore', arguments: '{"query":"amber"}' } },
      { ...EXTRAS.fc_2, id: 'fc_2', type: 'function', function: { name: 'read_lore', arguments: '{"ids":["L1"]}' } },
    ]);
    expect(assistant.reasoning_details).toEqual([{ type: 'reasoning.encrypted', data: 'zz' }]);
    expect(body.messages.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'fc_1', content: 'L1 Amber' },
      { role: 'tool', tool_call_id: 'fc_2', content: 'Amber is a stone.' },
    ]);
    // Another model's payloads never reach this one (§8.6).
    const other = request({ caps: { ...GEMINI, tools: 'native' }, model: { connection: 'g', model: 'gemini-3-flash' }, messages });
    const otherBody = JSON.parse(buildChatRequest(other, { connectionId: 'g', baseUrl: 'https://x.example/v1', local: false }, null).body!) as {
      messages: Record<string, unknown>[];
    };
    expect(otherBody.messages[2]!.reasoning_details).toBeUndefined();
    expect((otherBody.messages[2]!.tool_calls as Record<string, unknown>[])[0]!.extra_content).toBeUndefined();
  });
});

// ---- record / replay ------------------------------------------------------------------------------

let body = '';
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
});
afterAll(() => server.stop(true));
const BASE = `http://127.0.0.1:${server.port}`;
const KEY = 'sk-replay-secret-0123456789';

function liveReq(over: Partial<ModelRequest> = {}): ModelRequest {
  return request({ caps: capsAt('http://127.0.0.1:11434', 'm'), model: { connection: 'local', model: 'm' }, ...over });
}

describe('record and replay keep the replay event', () => {
  test('recorded, parsed and played back as recorded; the payload is scrubbed like the rest', async () => {
    // A secret inside a payload (an encrypted blob that happens to echo the key) must not reach the file.
    body = local('gemini-tool-extra.sse').replace('c2lnLXR3bw==', `sig-${KEY}`);
    const lines: string[] = [];
    const rec = createRecordingProvider(createOpenAIChatProvider({ connectionId: 'local', baseUrl: BASE, local: true }), (l) => lines.push(l), {
      secrets: () => [KEY],
    });
    const live = await collect(rec.stream(liveReq(), { fetch, key: KEY }));
    expect(live.filter((e) => e.t === 'replay')).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).toContain('"t":"replay"');
    expect(lines[0]).toContain('sig-[redacted]');

    const calls = parseRecording(lines.join('\n'));
    const played = await collect(createReplayProvider(calls).stream(liveReq(), { fetch, key: null }));
    // Everything as it was live, except the scrubbed secret.
    const scrubbed = JSON.parse(JSON.stringify(live).replace(KEY, '[redacted]')) as unknown;
    expect(JSON.parse(JSON.stringify(played)) as unknown).toEqual(scrubbed);
    const r = (played.find((e) => e.t === 'replay') as Extract<StreamEv, { t: 'replay' }>).r;
    expect(r).toEqual({
      kind: 'tool_extra',
      connection: 'local',
      model: 'm',
      payload: { fc_1: EXTRAS.fc_1, fc_2: { extra_content: { google: { thought_signature: 'sig-[redacted]' } } } },
    });
  });

  test('toRecordedEv / fromRecordedEv copy the payload (no shared objects)', () => {
    const payload = { a: { b: [1, 2] } };
    const ev: StreamEv = { t: 'replay', r: { kind: 'tool_extra', connection: 'c', model: 'm', payload } };
    const rec = toRecordedEv(ev);
    expect(rec).toEqual(ev);
    payload.a.b.push(3);
    expect((rec as Extract<StreamEv, { t: 'replay' }>).r.payload).toEqual({ a: { b: [1, 2] } });
    const back = fromRecordedEv(rec);
    expect(back).toEqual(rec as StreamEv);
    expect((back as Extract<StreamEv, { t: 'replay' }>).r.payload).not.toBe((rec as Extract<StreamEv, { t: 'replay' }>).r.payload);
  });

  test('a recording with a broken replay event fails to parse, naming the line and the event', () => {
    const good = { v: 1, requestHash: 'a'.repeat(16), request: { messages: [], maxTokens: 1, samplers: {} }, model: { model: 'm' } };
    const line = (ev: unknown): string => JSON.stringify({ ...good, events: [ev] });
    expect(() => parseRecording(line({ t: 'replay', r: { kind: 'nope', connection: 'c', model: 'm', payload: 1 } }))).toThrow('recording line 1: event 1: unknown replay kind "nope"');
    expect(() => parseRecording(line({ t: 'replay', r: { kind: 'tool_extra', connection: 'c', model: 'm' } }))).toThrow('payload is missing');
    expect(() => parseRecording(line({ t: 'replay', r: { kind: 'tool_extra', connection: 1, model: 'm', payload: {} } }))).toThrow('must be strings');
    expect(() => parseRecording(line({ t: 'replay', r: { kind: 'tool_extra', connection: 'c', model: 'm', payload: {}, x: 1 } }))).toThrow('unknown field "x"');
    expect(() => parseRecording(line({ t: 'replay', r: { kind: 'tool_extra', connection: 'c', model: 'm', payload: null } }))).not.toThrow();
  });
});
