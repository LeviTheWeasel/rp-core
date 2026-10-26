// Ported from Bunraku:src/stage/provider/openai-compatible-request.test.ts@702d8120 (URL and wire-message cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// openai-chat request half: URL, messages from blocks, body fields by caps, overrides.
// Rewritten from Bunraku src/stage/provider/openai-compatible-request.test.ts (string ProviderMessage →
// PromptMsg blocks, connection `support` flags → the capability record). Dropped with a reason:
// images (no image blocks in the core), the explicit chatCompletionsEndpoint (no such config field),
// "neutral values are removed" (only top_p 0 is "off"; a 0 penalty is a real, harmless setting),
// tools without `strict` (ToolSpec has no strict flag), "control fields never reach the wire" (no
// option bag), post-processing (shape.ts), YAML / chat-text overrides and their parse errors (config
// parses JSON at load, D-53), disallow_tools (the engine decides tools before the call).
import { describe, expect, test } from 'bun:test';
import { buildChatRequest, chatCompletionsUrl, type OpenAIChatOptions } from '../../src/providers/openai-chat.ts';
import { mergeCaps } from '../../src/providers/caps.ts';
import { ProviderError, type ModelCaps, type ModelRequest } from '../../src/providers/types.ts';
import { blocks, capsAt, msg, request } from './kit.ts';

const LOCAL: OpenAIChatOptions = { connectionId: 'local', baseUrl: 'http://127.0.0.1:8080', local: true };

function body(req: ModelRequest, o: OpenAIChatOptions = LOCAL, key: string | null = null): Record<string, unknown> {
  return JSON.parse(buildChatRequest(req, o, key).body!) as Record<string, unknown>;
}

/** The llama.cpp preset with a patch. */
const llama = (patch: Partial<ModelCaps> = {}, model = 'm'): ModelCaps => mergeCaps(capsAt('http://127.0.0.1:8080', model), patch, 'user');

describe('chatCompletionsUrl', () => {
  test('a bare origin gets /v1/chat/completions; trailing slashes go', () => {
    expect(chatCompletionsUrl('http://127.0.0.1:5001/')).toBe('http://127.0.0.1:5001/v1/chat/completions');
    expect(chatCompletionsUrl('  http://localhost:8080  ')).toBe('http://localhost:8080/v1/chat/completions');
  });

  test('a path with a version segment is kept, wherever the segment is', () => {
    expect(chatCompletionsUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.z.ai/api/coding/paas/v4')).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    expect(chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  test("DeepSeek's /beta base (prefix completion) gets no /v1", () => {
    expect(chatCompletionsUrl('https://api.deepseek.com/beta')).toBe('https://api.deepseek.com/beta/chat/completions');
    expect(chatCompletionsUrl('https://api.deepseek.com/beta/')).toBe('https://api.deepseek.com/beta/chat/completions');
  });

  test('a path without a version gets /v1 (OpenRouter pasted without it)', () => {
    expect(chatCompletionsUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  test('pasted endpoints are reduced to the base first', () => {
    expect(chatCompletionsUrl('http://127.0.0.1:5001/v1/chat/completions')).toBe('http://127.0.0.1:5001/v1/chat/completions');
    expect(chatCompletionsUrl('https://proxy.example/v2/chat/completions/')).toBe('https://proxy.example/v2/chat/completions');
    expect(chatCompletionsUrl('http://127.0.0.1:1234/v1/models')).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(chatCompletionsUrl('http://127.0.0.1:5001/v1/completions')).toBe('http://127.0.0.1:5001/v1/chat/completions');
    expect(chatCompletionsUrl('http://127.0.0.1:8080/chat/completions')).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(chatCompletionsUrl('https://Proxy.Example/V1/Chat/Completions')).toBe('https://proxy.example/V1/chat/completions');
  });

  test('a query string survives, a fragment does not', () => {
    expect(chatCompletionsUrl('https://x.example/openai/v1?api-version=2026-01-01#frag')).toBe(
      'https://x.example/openai/v1/chat/completions?api-version=2026-01-01',
    );
  });

  test('a non-http(s) or broken URL is a TypeError that does not echo the URL', () => {
    expect(() => chatCompletionsUrl('ftp://x/v1')).toThrow(TypeError);
    let message = '';
    try {
      chatCompletionsUrl('not a url ?key=sk-secret');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('sk-secret');
  });
});

describe('messages from blocks', () => {
  test('the leading system run is ONE system message; a later system message stays system', () => {
    const b = body(
      request({
        messages: [msg('system', 'A'), msg('system', 'B', '   '), msg('system', ''), msg('user', 'U'), msg('system', 'note'), msg('assistant', 'X')],
      }),
    );
    expect(b.messages).toEqual([
      { role: 'system', content: 'A\n\nB' },
      { role: 'user', content: 'U' },
      { role: 'system', content: 'note' },
      { role: 'assistant', content: 'X' },
    ]);
  });

  test('text blocks of one message join with a blank line; reasoning blocks are dropped', () => {
    const b = body(
      request({
        messages: [
          msg('user', 'one', 'two'),
          blocks('assistant', { k: 'reasoning', text: 'private' }, { k: 'text', text: 'shown' }),
          msg('user', 'next'),
        ],
      }),
    );
    expect(b.messages).toEqual([
      { role: 'user', content: 'one\n\ntwo' },
      { role: 'assistant', content: 'shown' },
      { role: 'user', content: 'next' },
    ]);
  });

  const toolTurn = [
    msg('user', 'roll'),
    blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{"n":2}' }, { k: 'tool_call', id: 'c2', name: 'look', args: '' }),
    blocks('tool', { k: 'tool_result', callId: 'c1', name: 'roll', text: '7' }, { k: 'tool_result', callId: 'c2', name: 'look', text: 'a door' }),
  ];

  test('a tool-only assistant turn sends content null; each result is its own tool message', () => {
    const b = body(request({ messages: toolTurn }));
    expect(b.messages).toEqual([
      { role: 'user', content: 'roll' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'roll', arguments: '{"n":2}' } },
          { id: 'c2', type: 'function', function: { name: 'look', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '7' },
      { role: 'tool', tool_call_id: 'c2', content: 'a door' },
    ]);
  });

  test('an assistant turn with text and calls keeps its text', () => {
    const b = body(
      request({
        messages: [
          blocks('assistant', { k: 'text', text: 'Let me check.' }, { k: 'tool_call', id: 'c1', name: 'look', args: '{}' }),
          blocks('tool', { k: 'tool_result', callId: 'c1', name: 'look', text: 'ok' }),
        ],
      }),
    );
    expect((b.messages as Record<string, unknown>[])[0]).toMatchObject({ role: 'assistant', content: 'Let me check.' });
  });

  test('results in a user turn (the Anthropic shape) become tool messages followed by the user text', () => {
    const b = body(
      request({
        messages: [
          blocks('assistant', { k: 'tool_call', id: 'c1', name: 'look', args: '{}' }),
          blocks('user', { k: 'tool_result', callId: 'c1', name: 'look', text: 'ok' }, { k: 'text', text: 'and then?' }),
        ],
      }),
    );
    expect((b.messages as unknown[]).slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: 'and then?' },
    ]);
  });

  test('a broken tool protocol is refused before anything is built (ProviderError tool_protocol_invalid)', () => {
    const bad: ModelRequest['messages'][] = [
      [blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{}' })], // dangling batch
      [blocks('tool', { k: 'tool_result', callId: 'nope', name: 'roll', text: 'x' })], // unknown call
      [blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '[1]' }), blocks('tool', { k: 'tool_result', callId: 'c1', name: 'roll', text: 'x' })],
      [blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{bad' }), blocks('tool', { k: 'tool_result', callId: 'c1', name: 'roll', text: 'x' })],
      [blocks('assistant', { k: 'tool_call', id: 'c1', name: 'bad name', args: '{}' }), blocks('tool', { k: 'tool_result', callId: 'c1', name: 'bad name', text: 'x' })],
      [blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{}' }), msg('user', 'interrupting'), blocks('tool', { k: 'tool_result', callId: 'c1', name: 'roll', text: 'x' })],
      [blocks('assistant', { k: 'tool_call', id: 'c1', name: 'roll', args: '{}' }), blocks('tool', { k: 'tool_result', callId: 'c1', name: 'other', text: 'x' })],
    ];
    for (const messages of bad) {
      let err: unknown;
      try {
        buildChatRequest(request({ messages }), LOCAL, null);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe('tool_protocol_invalid');
      expect((err as ProviderError).category).toBe('request');
    }
  });

  test('mistral9 tool ids are remapped consistently across calls and results', () => {
    const caps = capsAt('https://api.mistral.ai:443', 'mistral-large-latest');
    const b = body(request({ caps, messages: toolTurn }), { connectionId: 'mistral', baseUrl: 'https://api.mistral.ai/v1', local: false });
    const m = b.messages as { tool_calls?: { id: string }[]; tool_call_id?: string }[];
    const ids = m[1]!.tool_calls!.map((c) => c.id);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect([m[2]!.tool_call_id, m[3]!.tool_call_id]).toEqual(ids);
  });
});

describe('prefill per caps.prefill', () => {
  const messages = [msg('user', 'Go on.')];
  test("'assistant-last' → a trailing assistant message", () => {
    const b = body(request({ messages, prefill: 'She smiled', caps: llama({ prefill: 'assistant-last' }) }));
    expect((b.messages as unknown[]).at(-1)).toEqual({ role: 'assistant', content: 'She smiled' });
  });
  test("'prefix-flag' → a trailing assistant message with prefix: true (DeepSeek)", () => {
    const b = body(request({ messages, prefill: 'She smiled', caps: llama({ prefill: 'prefix-flag' }) }));
    expect((b.messages as unknown[]).at(-1)).toEqual({ role: 'assistant', content: 'She smiled', prefix: true });
  });
  test("'none' → not sent", () => {
    const b = body(request({ messages, prefill: 'She smiled', caps: llama({ prefill: 'none' }) }));
    expect(b.messages).toEqual([{ role: 'user', content: 'Go on.' }]);
  });
  test('an empty prefill is no prefill', () => {
    const b = body(request({ messages, prefill: '', caps: llama({ prefill: 'assistant-last' }) }));
    expect(b.messages).toEqual([{ role: 'user', content: 'Go on.' }]);
  });
});

describe('samplers, stop, max tokens', () => {
  const all = {
    temperature: 0.8,
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    top_a: 0.1,
    typical_p: 0.95,
    repetition_penalty: 1.1,
    frequency_penalty: 0,
    presence_penalty: 0.2,
    seed: 7,
  };

  test('only accepted samplers are sent, under their wire names; 0 is a value, not "off"', () => {
    const b = body(request({ samplers: all }));
    expect(b).toMatchObject({ temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, typical_p: 0.95, repeat_penalty: 1.1, frequency_penalty: 0, presence_penalty: 0.2, seed: 7 });
    expect(b.top_a).toBeUndefined(); // llama.cpp does not list it
    expect(b.repetition_penalty).toBeUndefined(); // renamed, not duplicated
  });

  test('top_p 0 is never sent; neither is a non-finite value', () => {
    const b = body(request({ samplers: { top_p: 0, temperature: Number.NaN, top_k: Number.POSITIVE_INFINITY, min_p: 0 } }));
    expect(b.top_p).toBeUndefined();
    expect(b.temperature).toBeUndefined();
    expect(b.top_k).toBeUndefined();
    expect(b.min_p).toBe(0);
  });

  test('fixed sampling sends no sampler at all, but stop and the token budget still go', () => {
    const caps = llama({ samplers: { accepted: ['temperature', 'top_p', 'stop', 'max_tokens'], fixed: true } });
    const b = body(request({ caps, samplers: { ...all, stop: ['\nUser:'] }, maxTokens: 500 }));
    for (const k of Object.keys(all)) expect(b[k]).toBeUndefined();
    expect(b.stop).toEqual(['\nUser:']);
    expect(b.max_tokens).toBe(500);
  });

  test('stop: only where accepted, blanks and repeats removed, capped at stopMax; req.stop wins over samplers.stop', () => {
    const stop = ['a', '', 'b', 'a', 'c', 'd', 'e'];
    expect(body(request({ caps: llama({ stopMax: 4 }), stop })).stop).toEqual(['a', 'b', 'c', 'd']);
    expect(body(request({ stop })).stop).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(body(request({ stop: ['x'], samplers: { stop: ['y'] } })).stop).toEqual(['x']);
    expect(body(request({ samplers: { stop: ['y'] } })).stop).toEqual(['y']);
    expect(body(request({ stop: ['', ''] })).stop).toBeUndefined();
    // OpenAI reasoning models do not list 'stop': the field is not introduced (RoleCall's rule, now data).
    const o = capsAt('https://api.openai.com:443', 'gpt-5.1');
    expect(body(request({ caps: o, stop: ['x'] })).stop).toBeUndefined();
  });

  test('max tokens goes under caps.maxTokensField', () => {
    expect(body(request({ maxTokens: 300 })).max_tokens).toBe(300);
    const b = body(request({ caps: llama({ maxTokensField: 'max_completion_tokens' }), maxTokens: 300 }));
    expect(b.max_completion_tokens).toBe(300);
    expect(b.max_tokens).toBeUndefined();
  });
});

describe('stream usage, tools, reasoning control, structured output', () => {
  test("stream_options only when caps.streamUsage is 'stream_options'", () => {
    expect(body(request({ caps: llama({ streamUsage: 'stream_options' }) })).stream_options).toEqual({ include_usage: true });
    for (const su of ['timings', 'always', 'none'] as const) expect(body(request({ caps: llama({ streamUsage: su }) })).stream_options).toBeUndefined();
    expect(body(request()).stream).toBe(true);
  });

  const tools = [
    { name: 'roll', description: 'Roll dice', schema: { type: 'object', properties: { n: { type: 'integer' } } } },
    { name: 'look', description: 'Look around', schema: { type: 'object', properties: {} } },
  ];

  test('native tools are sent sorted by name, with tool_choice and parallel_tool_calls per caps', () => {
    const b = body(request({ caps: llama({ tools: 'native' }), tools, toolChoice: 'auto' }));
    expect(b.tools).toEqual([
      { type: 'function', function: { name: 'look', description: 'Look around', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'roll', description: 'Roll dice', parameters: tools[0]!.schema } },
    ]);
    expect(b.tool_choice).toBe('auto');
    expect(b.parallel_tool_calls).toBe(true); // llama.cpp: 'send-true'
  });

  test("tool_choice only when caps lists it; 'param' servers get no parallel_tool_calls", () => {
    const b = body(request({ caps: llama({ tools: 'native', toolChoice: [], parallelToolCalls: 'param' }), tools, toolChoice: 'auto' }));
    expect(b.tools).toHaveLength(2);
    expect(b.tool_choice).toBeUndefined();
    expect(b.parallel_tool_calls).toBeUndefined();
  });

  test("prompted or none: no native tools on the wire", () => {
    expect(body(request({ caps: llama({ tools: 'prompted' }), tools })).tools).toBeUndefined();
    expect(body(request({ caps: llama({ tools: 'none' }), tools })).tools).toBeUndefined();
  });

  test("tool_choice 'none' on a server that ignores tool_choice sends no tools at all", () => {
    const b = body(request({ caps: llama({ tools: 'native', toolChoiceHonored: false }), tools, toolChoice: 'none' }));
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
    const honoured = body(request({ caps: llama({ tools: 'native', toolChoiceHonored: true }), tools, toolChoice: 'none' }));
    expect(honoured.tool_choice).toBe('none');
  });

  test("effort control: reasoning_effort only for listed values; 'auto' sends nothing", () => {
    const caps = llama({ reasoning: { output: 'none', control: 'effort', canDisable: false, echo: 'never', efforts: ['low', 'medium', 'high'] } });
    expect(body(request({ caps, reasoning: 'high' })).reasoning_effort).toBe('high');
    expect(body(request({ caps, reasoning: 'auto' })).reasoning_effort).toBeUndefined();
    expect(body(request({ caps, reasoning: 'none' })).reasoning_effort).toBeUndefined();
    const noList = llama({ reasoning: { output: 'none', control: 'effort', canDisable: false, echo: 'never' } });
    expect(body(request({ caps: noList, reasoning: 'high' })).reasoning_effort).toBeUndefined();
  });

  test("effort control: 'none' through the list, or through offShape when the model can disable", () => {
    const listed = capsAt('https://api.openai.com:443', 'gpt-5.1');
    expect(body(request({ caps: listed, reasoning: 'none' })).reasoning_effort).toBe('none');
    const shaped = llama({ reasoning: { output: 'none', control: 'effort', canDisable: true, echo: 'never', efforts: ['low'], offShape: { reasoning: { enabled: false } } } });
    expect(body(request({ caps: shaped, reasoning: 'none' })).reasoning).toEqual({ enabled: false });
  });

  test('toggle control (Qwen3 on llama.cpp): chat_template_kwargs.enable_thinking, merged with what is there', () => {
    const caps = capsAt('http://127.0.0.1:8080', 'Qwen3-8B-Q5_K_M.gguf');
    expect(body(request({ caps, reasoning: 'none' })).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body(request({ caps, reasoning: 'high' })).chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body(request({ caps, reasoning: 'auto' })).chat_template_kwargs).toBeUndefined();
    const withKwargs = mergeCaps(caps, { extraBody: { chat_template_kwargs: { keep: 1 } } }, 'user');
    expect(body(request({ caps: withKwargs, reasoning: 'none' })).chat_template_kwargs).toEqual({ keep: 1, enable_thinking: false });
  });

  test("toggle control with another off switch (DeepSeek V4 `thinking`): off sends it, on sends nothing", () => {
    const caps = capsAt('https://api.deepseek.com:443', 'deepseek-v4-pro');
    expect(body(request({ caps, reasoning: 'none' })).thinking).toEqual({ type: 'disabled' });
    const on = body(request({ caps, reasoning: 'high' }));
    expect(on.thinking).toBeUndefined();
    expect(on.chat_template_kwargs).toBeUndefined();
  });

  test('toggle on a model that cannot disable: nothing', () => {
    const caps = llama({ reasoning: { output: 'tags', control: 'toggle', canDisable: false, echo: 'never' } });
    expect(body(request({ caps, reasoning: 'none' })).chat_template_kwargs).toBeUndefined();
  });

  test('response_format json_schema only where structured output is json_schema', () => {
    const responseSchema = { name: 'verdict', schema: { type: 'object' } };
    expect(body(request({ responseSchema })).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'verdict', schema: { type: 'object' } } });
    expect(body(request({ caps: llama({ structuredOutput: { mode: 'none' } }), responseSchema })).response_format).toBeUndefined();
  });
});

describe('DeepSeek reasoning echo (§8.4, caps.reasoning.echo all-with-tools)', () => {
  const caps = capsAt('https://api.deepseek.com:443', 'deepseek-reasoner');
  const history = [
    msg('user', 'q1'),
    blocks('assistant', { k: 'reasoning', text: 'thought one' }, { k: 'text', text: 'a1' }),
    msg('user', 'q2'),
    blocks('assistant', { k: 'reasoning', text: 'thought two' }, { k: 'tool_call', id: 'c1', name: 'look', args: '{}' }),
    blocks('tool', { k: 'tool_result', callId: 'c1', name: 'look', text: 'ok' }),
  ];
  const tools = [{ name: 'look', description: 'd', schema: { type: 'object' } }];

  test('with tools, every assistant message carries its reasoning as reasoning_content', () => {
    const m = body(request({ caps, messages: history, tools })).messages as Record<string, unknown>[];
    expect(m[1]).toEqual({ role: 'assistant', content: 'a1', reasoning_content: 'thought one' });
    expect(m[3]).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'thought two' });
  });

  test('without tool traffic nothing is echoed', () => {
    const m = body(request({ caps, messages: [history[0]!, history[1]!, history[2]!] })).messages as Record<string, unknown>[];
    expect(m[1]).toEqual({ role: 'assistant', content: 'a1' });
  });

  test('a model with echo never drops reasoning even with tools; summaries are never echoed', () => {
    const chat = capsAt('https://api.deepseek.com:443', 'deepseek-chat');
    const m = body(request({ caps: chat, messages: history, tools })).messages as Record<string, unknown>[];
    expect(m[1]).toEqual({ role: 'assistant', content: 'a1' });
    const summary = body(
      request({ caps, tools, messages: [blocks('assistant', { k: 'reasoning', text: 'sum', kind: 'summary' }, { k: 'text', text: 'a' })] }),
    ).messages as Record<string, unknown>[];
    expect(summary[0]).toEqual({ role: 'assistant', content: 'a' });
  });
});

describe('replay inside the tool loop (§8.6)', () => {
  const details = [{ type: 'reasoning.encrypted', data: 'xyz', index: 0 }];
  const turn = (connection: string, model: string): ModelRequest['messages'] => [
    {
      role: 'assistant',
      src: 'round',
      blocks: [{ k: 'tool_call', id: 'c1', name: 'look', args: '{}' }],
      replay: [
        { kind: 'reasoning_details', connection, model, payload: details },
        { kind: 'tool_extra', connection, model, payload: { c1: { extra_content: { google: { thought_signature: 'sig' } } } } },
      ],
    },
    blocks('tool', { k: 'tool_result', callId: 'c1', name: 'look', text: 'ok' }),
  ];

  test('payloads of this connection and model are rendered by kind', () => {
    const m = body(request({ model: { connection: 'or', model: 'google/gemini-3-pro' }, messages: turn('or', 'google/gemini-3-pro') }))
      .messages as Record<string, unknown>[];
    expect(m[0]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_details: details,
      tool_calls: [{ extra_content: { google: { thought_signature: 'sig' } }, id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }],
    });
  });

  test('payloads of another model or connection are never sent', () => {
    for (const [c, mdl] of [['or', 'other/model'], ['other', 'google/gemini-3-pro']] as const) {
      const m = body(request({ model: { connection: 'or', model: 'google/gemini-3-pro' }, messages: turn(c, mdl) })).messages as Record<string, unknown>[];
      expect(m[0]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }] });
    }
  });
});

describe('headers, extraBody and connection overrides', () => {
  test('Authorization only when there is a key', () => {
    expect(buildChatRequest(request(), LOCAL, null).headers).toEqual({ 'Content-Type': 'application/json' });
    expect(buildChatRequest(request(), LOCAL, '').headers).toEqual({ 'Content-Type': 'application/json' });
    expect(buildChatRequest(request(), LOCAL, 'sk-1').headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-1' });
  });

  test('the request is a POST to the chat completions URL', () => {
    const r = buildChatRequest(request(), { ...LOCAL, baseUrl: 'http://127.0.0.1:8080/v1/' }, null);
    expect(r.method).toBe('POST');
    expect(r.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  test('caps.extraBody merges deep but never touches protected keys', () => {
    const caps = llama({ extraBody: { cache_prompt: true, model: 'evil', messages: [], stream: false, nested: { a: 1 } } });
    const b = body(request({ caps }));
    expect(b).toMatchObject({ model: 'm', stream: true, cache_prompt: true, nested: { a: 1 } });
    expect(b.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('connection overrides apply last: exclude, deep extra_body, headers; protected ones untouched', () => {
    const o: OpenAIChatOptions = {
      ...LOCAL,
      overrides: {
        excludeBody: ['cache_prompt', 'model'],
        extraBody: { temperature: 0.1, provider: { order: ['x'] }, tools: [], tool_choice: 'required' },
        headers: { 'X-Title': 'rp-core', authorization: 'Basic nope', 'Content-Type': 'text/plain' },
      },
    };
    const r = buildChatRequest(request({ samplers: { temperature: 0.9 } }), o, 'k');
    const b = JSON.parse(r.body!) as Record<string, unknown>;
    expect(b.cache_prompt).toBeUndefined(); // excluded
    expect(b.model).toBe('m'); // protected
    expect(b.temperature).toBe(0.1); // the hatch wins over the preset
    expect(b.provider).toEqual({ order: ['x'] });
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined(); // a forced tool_choice can never come back through extra_body (D-53)
    expect(r.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k', 'X-Title': 'rp-core' });
  });

  test('building never mutates the request or the caps', () => {
    const req = request({ caps: llama({ extraBody: { cache_prompt: true } }), prefill: 'x', stop: ['a'] });
    const before = JSON.stringify({ ...req, signal: undefined });
    buildChatRequest(req, { ...LOCAL, overrides: { extraBody: { cache_prompt: false } } }, 'k');
    expect(JSON.stringify({ ...req, signal: undefined })).toBe(before);
  });
});
