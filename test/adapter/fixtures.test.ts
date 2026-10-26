// Ported from RoleCall:apps/rc/src/lib/ai/__tests__/inhouse-nonstream-toolcall-sse.test.ts@fb8dc623e
// (SSE_BODY and the aggregateOpenAICompletionSSE cases; the RoleCall block).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Golden SSE fixtures (test/fixtures/sse/openai-chat/*.sse) through the real sseEvents + parser, at
// several chunkings (whole body, byte by byte, odd sizes): the events must not depend on where the
// network cut the bytes. The rolecall-*.sse fixtures are the bodies of RoleCall
// apps/rc/src/lib/ai/__tests__/inhouse-nonstream-toolcall-sse.test.ts @ fb8dc623e (SSE_BODY and the
// aggregateOpenAICompletionSSE cases), re-expressed as event expectations.
import { describe, expect, test } from 'bun:test';
import type { ModelCaps, StreamEv } from '../../src/providers/types.ts';
import { capsAt, coalesce, fixture, parseSse, request } from './kit.ts';

/** The events, minus the error object (compared by its fields). */
function plain(events: readonly StreamEv[]): unknown[] {
  return coalesce(events).map((ev) =>
    ev.t === 'error' ? { t: 'error', code: ev.err.code, category: ev.err.category, status: ev.err.status, afterOutput: ev.afterOutput } : ev,
  );
}

const SIZES = [0, 1, 7, 64];

async function check(name: string, caps: ModelCaps, expected: unknown[], model = 'm'): Promise<void> {
  const text = fixture(name);
  for (const size of SIZES) {
    const { events } = await parseSse(request({ caps, model: { connection: 'c', model } }), text, size);
    expect(plain(events)).toEqual(expected);
  }
}

const LLAMA = capsAt('http://127.0.0.1:8080', 'Qwen3-8B-Q5_K_M.gguf');
const OLLAMA = capsAt('http://127.0.0.1:11434', 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M');
const OPENROUTER = capsAt('https://openrouter.ai:443', 'google/gemini-3-pro-preview');
const DEEPSEEK = capsAt('https://api.deepseek.com:443', 'deepseek-reasoner');
const VLLM = capsAt('http://10.0.0.5:8000', 'Qwen/Qwen3-32B', { server: 'vllm' });
const NANOGPT = capsAt('https://nano-gpt.com:443', 'deepseek/deepseek-v4-flash');

describe('golden fixtures', () => {
  test('llama.cpp: <think> split across chunks becomes reasoning; timings become usage with the cache split', async () => {
    await check('llamacpp-think.sse', LLAMA, [
      { t: 'reasoning', i: 0, d: '\nThe guest is soaked; offer the fire first.\n' },
      { t: 'reasoning_end', i: 0 },
      { t: 'text', i: 0, d: '\n\nMara nods toward the hearth. "Dry off first."' },
      { t: 'usage', u: { inputTotal: 550, inputCacheRead: 512, outputTotal: 14 } },
      { t: 'finish', reason: 'end', raw: 'stop', model: 'Qwen3-8B-Q5_K_M.gguf' },
    ]);
  });

  test('Ollama: the finish goes out with its chunk; the usage chunk with choices:[] after it is still read', async () => {
    await check('ollama-usage.sse', OLLAMA, [
      { t: 'text', i: 0, d: 'Mara sets down the mug.' },
      { t: 'finish', reason: 'end', raw: 'stop', model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M' },
      { t: 'usage', u: { inputTotal: 61, inputCacheRead: 48, outputTotal: 7 } },
    ]);
  });

  test('OpenRouter: processing comments skipped, reasoning once (not again from reasoning_details), cost and reasoning tokens', async () => {
    await check('openrouter-reasoning.sse', OPENROUTER, [
      { t: 'reasoning', i: 0, d: '**Setting the scene**\nRain, a tired keeper.' },
      { t: 'reasoning_end', i: 0 },
      { t: 'text', i: 0, d: 'Mara wipes the bar. "Room\'s upstairs."' },
      { t: 'finish', reason: 'end', raw: 'stop', model: 'google/gemini-3-pro-preview' },
      { t: 'usage', u: { inputTotal: 812, inputCacheRead: 640, outputTotal: 96, outputReasoning: 71, cost: 0.0019 } },
    ]);
  });

  test('OpenRouter: the reasoning_details stream is kept verbatim for replay, encrypted part included', async () => {
    const { reader } = await parseSse(request({ caps: OPENROUTER, model: { connection: 'or', model: 'google/gemini-3-pro-preview' } }), fixture('openrouter-reasoning.sse'));
    expect(reader.replay()).toEqual([
      {
        kind: 'reasoning_details',
        connection: 'or',
        model: 'google/gemini-3-pro-preview',
        payload: [
          { type: 'reasoning.text', text: '**Setting the scene**\n', format: 'google-gemini-v1', index: 0 },
          { type: 'reasoning.text', text: 'Rain, a tired keeper.', format: 'google-gemini-v1', index: 0 },
          { type: 'reasoning.encrypted', data: 'CiQB4/H/XgPq0w==', id: 'tool_0', format: 'google-gemini-v1', index: 1 },
        ],
      },
    ]);
  });

  test('OpenRouter: an error object that arrives WITH choices on HTTP 200 fails the call (never skipped)', async () => {
    await check('openrouter-error-200.sse', OPENROUTER, [
      { t: 'text', i: 0, d: 'Mara opens the' },
      { t: 'error', code: 'overloaded', category: 'server', status: undefined, afterOutput: true },
    ]);
  });

  test('DeepSeek: reasoning_content then content; cache hit tokens', async () => {
    await check(
      'deepseek-reasoning.sse',
      DEEPSEEK,
      [
        { t: 'reasoning', i: 0, d: 'The guest wants a room. Keep it short.' },
        { t: 'reasoning_end', i: 0 },
        { t: 'text', i: 0, d: '"Second door on the left."' },
        { t: 'finish', reason: 'end', raw: 'stop', model: 'deepseek-reasoner' },
        { t: 'usage', u: { inputTotal: 420, inputCacheRead: 384, outputTotal: 58, outputReasoning: 41 } },
      ],
      'deepseek-reasoner',
    );
  });

  test('vLLM: tool call fragments by index; repeated names assigned, not glued; the index gap closed', async () => {
    await check('vllm-tools.sse', VLLM, [
      { t: 'tool_start', i: 0, id: 'chatcmpl-tool-a1f0', name: 'roll_dice' },
      { t: 'tool_args', i: 0, d: '{"sides": 20}' },
      { t: 'tool_start', i: 1, id: 'chatcmpl-tool-b2c7', name: 'look_around' },
      { t: 'tool_args', i: 1, d: '{"target": "door"}' },
      { t: 'tool_end', i: 0 },
      { t: 'tool_end', i: 1 },
      { t: 'finish', reason: 'end', raw: 'tool_calls', model: 'Qwen/Qwen3-32B' },
      { t: 'usage', u: { inputTotal: 350, outputTotal: 41 } },
    ]);
  });

  test('a stream cut off mid-chunk is truncated_stream after output, never an invented stop', async () => {
    await check('truncated.sse', LLAMA, [
      { t: 'text', i: 0, d: 'Mara reaches for the' },
      { t: 'error', code: 'truncated_stream', category: 'network', status: undefined, afterOutput: true },
    ]);
  });
});

describe('RoleCall SSE aggregator cases as fixtures', () => {
  test('NanoGPT index gaps are skipped and call order kept; usage on the finish chunk; served model', async () => {
    await check('rolecall-nanogpt-tool-gaps.sse', NANOGPT, [
      { t: 'tool_start', i: 0, id: 'call_a', name: 'Remember_Character' },
      { t: 'tool_args', i: 0, d: '{"name":"Mara"}' },
      { t: 'tool_start', i: 1, id: 'call_b', name: 'postgen_status' },
      { t: 'tool_args', i: 1, d: '{"summary":"Saved Mara."}' },
      { t: 'tool_end', i: 0 },
      { t: 'tool_end', i: 1 },
      { t: 'usage', u: { inputTotal: 16254, outputTotal: 9948 } },
      { t: 'finish', reason: 'end', raw: 'tool_calls', model: 'deepseek/deepseek-v4-flash' },
    ]);
  });

  test('plain streamed prose with no tool calls', async () => {
    await check('rolecall-plain-prose.sse', NANOGPT, [
      { t: 'text', i: 0, d: 'Hello' },
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
  });

  test('an inline error chunk inside a 200 stream fails closed (before any output)', async () => {
    await check('rolecall-inline-error.sse', NANOGPT, [{ t: 'error', code: 'overloaded', category: 'server', status: undefined, afterOutput: false }]);
  });

  test('a stream truncated mid-arguments fails closed: the half call never gets a tool_end', async () => {
    await check('rolecall-truncated-tool.sse', NANOGPT, [
      { t: 'tool_start', i: 0, id: 'call_t', name: 'postgen_status' },
      { t: 'tool_args', i: 0, d: '{"summ' },
      { t: 'error', code: 'truncated_stream', category: 'network', status: undefined, afterOutput: true },
    ]);
  });

  test('reasoning deltas accumulate before the tool call; reasoning_details kept for replay', async () => {
    await check('rolecall-reasoning-tool.sse', NANOGPT, [
      { t: 'reasoning', i: 0, d: 'thinking harder' },
      { t: 'reasoning_end', i: 0 },
      { t: 'tool_start', i: 0, id: 'call_r', name: 'postgen_status' },
      { t: 'tool_args', i: 0, d: '{"summary":"ok"}' },
      { t: 'tool_end', i: 0 },
      { t: 'finish', reason: 'end', raw: 'tool_calls' },
    ]);
    const { reader } = await parseSse(request({ caps: NANOGPT, model: { connection: 'nano', model: 'x' } }), fixture('rolecall-reasoning-tool.sse'));
    expect(reader.replay()).toEqual([{ kind: 'reasoning_details', connection: 'nano', model: 'x', payload: [{ type: 'reasoning.encrypted', data: 'abc' }] }]);
  });

  test('a call whose name never arrived is dropped', async () => {
    await check('rolecall-nameless-call.sse', NANOGPT, [
      { t: 'tool_start', i: 0, id: 'call_y', name: 'postgen_status' },
      { t: 'tool_args', i: 0, d: '{"summary":"ok"}' },
      { t: 'tool_end', i: 0 },
      { t: 'finish', reason: 'end', raw: 'tool_calls' },
    ]);
  });

  test('a body with no completion chunks (an HTML page on 200) is a truncated stream with no output', async () => {
    await check('rolecall-html-body.sse', NANOGPT, [{ t: 'error', code: 'truncated_stream', category: 'network', status: undefined, afterOutput: false }]);
  });
});
