// M3 request shapes on the openai-chat wire: the DeepSeek reasoning echo (decisions C3, §8.4), the
// final round's tool drop (D-91, unchanged from M1b), and validateToolProtocol over the requests a
// tool loop builds (native rounds, a prompted round) and over broken ones (§8.3).
import { describe, expect, test } from 'bun:test';
import { buildChatRequest, createOpenAIChatProvider, ECHO_PLACEHOLDER } from '../../src/providers/openai-chat.ts';
import { mergeCaps } from '../../src/providers/caps.ts';
import { echoesReasoning, echoPlaceholders, validateToolProtocol } from '../../src/providers/wire.ts';
import { ProviderError, type ModelCaps, type ModelRequest, type PromptMsg, type ToolSpec } from '../../src/providers/types.ts';
import { blocks, capsAt, collect, msg, request } from '../adapter/kit.ts';

type Wire = Record<string, unknown>;

function body(req: ModelRequest): Wire {
  return JSON.parse(buildChatRequest(req, { connectionId: 'c', baseUrl: 'http://127.0.0.1:9999', local: true }, null).body!) as Wire;
}
const wireMessages = (req: ModelRequest): Wire[] => body(req).messages as Wire[];

const TOOLS: ToolSpec[] = [
  { name: 'search_lore', description: 'Search the lore.', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'read_lore', description: 'Read entries.', schema: { type: 'object', properties: { ids: { type: 'array' } }, required: ['ids'], additionalProperties: false } },
];

const V4 = capsAt('https://api.deepseek.com:443', 'deepseek-v4-pro');
const REASONER = capsAt('https://api.deepseek.com:443', 'deepseek-reasoner');
const CHAT = capsAt('https://api.deepseek.com:443', 'deepseek-chat');

/** A path with a greeting (no reasoning), a model answer with reasoning, and the current user turn. */
const HISTORY: PromptMsg[] = [
  msg('system', 'You are Mara.'),
  msg('assistant', 'Welcome to the Amber Mug.'),
  msg('user', 'A room, please.'),
  blocks('assistant', { k: 'reasoning', text: 'They want a room.' }, { k: 'text', text: 'Upstairs, second door.' }),
  msg('user', 'And the amber?'),
];

/** The same path after one native tool round. */
const ROUND: PromptMsg[] = [
  ...HISTORY,
  blocks('assistant', { k: 'reasoning', text: 'Look it up.' }, { k: 'tool_call', id: 'call_0_0', name: 'search_lore', args: '{"query":"amber"}' }),
  blocks('tool', { k: 'tool_result', callId: 'call_0_0', name: 'search_lore', text: 'L1 Amber' }),
];

describe('DeepSeek echo (C3): with tools, every assistant message carries reasoning_content', () => {
  test('its own raw reasoning, else one space (a greeting, an answer of another model)', () => {
    for (const caps of [V4, REASONER]) {
      const m = wireMessages(request({ caps, messages: HISTORY, tools: TOOLS, toolChoice: 'auto' }));
      expect(m[1]).toEqual({ role: 'assistant', content: 'Welcome to the Amber Mug.', reasoning_content: ECHO_PLACEHOLDER });
      expect(m[3]).toEqual({ role: 'assistant', content: 'Upstairs, second door.', reasoning_content: 'They want a room.' });
      // Only assistant messages: system and user never get the field.
      for (const w of m) if (w.role !== 'assistant') expect(w).not.toHaveProperty('reasoning_content');
    }
    expect(ECHO_PLACEHOLDER).toBe(' ');
  });

  test('inside the loop: the round message echoes its reasoning; a final round without tools still echoes (tool_call blocks are on the wire)', () => {
    const live = wireMessages(request({ caps: V4, messages: ROUND, tools: TOOLS, toolChoice: 'auto' }));
    expect(live[5]).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'Look it up.' });
    expect(live[6]).toEqual({ role: 'tool', tool_call_id: 'call_0_0', content: 'L1 Amber' });
    const final = body(request({ caps: V4, messages: ROUND, tools: TOOLS, toolChoice: 'none' }));
    // DeepSeek does not honour tool_choice (toolChoiceHonored false): the final round sends no tools.
    expect(final.tools).toBeUndefined();
    expect(final.tool_choice).toBeUndefined();
    expect((final.messages as Wire[])[1]).toMatchObject({ reasoning_content: ' ' });
    expect((final.messages as Wire[])[5]).toMatchObject({ reasoning_content: 'Look it up.' });
  });

  test('no tool traffic: no echo at all (a turn without tools is exactly M2)', () => {
    for (const caps of [V4, REASONER]) {
      const m = wireMessages(request({ caps, messages: HISTORY }));
      for (const w of m) expect(w).not.toHaveProperty('reasoning_content');
    }
  });

  test('thinking switched off for the turn (canDisable): thinking disabled, nothing echoed', () => {
    const b = body(request({ caps: V4, messages: HISTORY, tools: TOOLS, toolChoice: 'auto', reasoning: 'none' }));
    expect(b.thinking).toEqual({ type: 'disabled' });
    for (const w of b.messages as Wire[]) expect(w).not.toHaveProperty('reasoning_content');
    // A model that cannot switch thinking off keeps thinking, so it keeps echoing (D-94 revised).
    const r = wireMessages(request({ caps: REASONER, messages: HISTORY, tools: TOOLS, reasoning: 'none' }));
    expect(r[1]).toMatchObject({ reasoning_content: ' ' });
  });

  test('echoesReasoning / echoPlaceholders (wire.ts) are the rule the adapter follows', () => {
    const cases: ModelRequest[] = [
      request({ caps: V4, messages: HISTORY, tools: TOOLS, toolChoice: 'auto' }),
      request({ caps: V4, messages: ROUND, tools: TOOLS, toolChoice: 'none' }),
      request({ caps: V4, messages: HISTORY }),
      request({ caps: V4, messages: HISTORY, tools: TOOLS, reasoning: 'none' }),
      request({ caps: REASONER, messages: HISTORY, tools: TOOLS, reasoning: 'none' }),
      request({ caps: CHAT, messages: ROUND, tools: TOOLS }),
    ];
    for (const q of cases) {
      const sent = wireMessages(q).filter((w) => w.role === 'assistant');
      expect(echoesReasoning(q)).toBe(sent.some((w) => 'reasoning_content' in w));
      expect(echoPlaceholders(q)).toBe(sent.filter((w) => w.reasoning_content === ECHO_PLACEHOLDER).length);
    }
    // The greeting is the one placeholder of HISTORY; the round's own reasoning is real.
    expect(echoPlaceholders(cases[0]!)).toBe(1);
    expect(echoPlaceholders(cases[1]!)).toBe(1);
    expect(echoPlaceholders(cases[3]!)).toBe(0);
  });

  test('a model without the echo never gets the field; the field follows reasoning.output', () => {
    for (const w of wireMessages(request({ caps: CHAT, messages: ROUND, tools: TOOLS }))) expect(w).not.toHaveProperty('reasoning_content');
    const viaReasoning = mergeCaps(V4, { reasoning: { output: 'reasoning' } as ModelCaps['reasoning'] });
    const m = wireMessages(request({ caps: viaReasoning, messages: HISTORY, tools: TOOLS }));
    expect(m[1]).toEqual({ role: 'assistant', content: 'Welcome to the Amber Mug.', reasoning: ' ' });
    expect(m[3]).toMatchObject({ reasoning: 'They want a room.' });
  });

  test('summaries and redactions are not the model\'s own reasoning: the placeholder goes out instead', () => {
    const m = wireMessages(
      request({ caps: V4, tools: TOOLS, messages: [msg('user', 'q'), blocks('assistant', { k: 'reasoning', text: 'sum', kind: 'summary' }, { k: 'text', text: 'a' }), msg('user', 'q2')] }),
    );
    expect(m[1]).toEqual({ role: 'assistant', content: 'a', reasoning_content: ' ' });
  });
});

describe('final round: tools dropped where tool_choice is not honoured (D-91, unchanged)', () => {
  const native = (caps: ModelCaps): ModelCaps => mergeCaps(caps, { tools: 'native' }, 'user');
  const OLLAMA = native(capsAt('http://127.0.0.1:11434', 'qwen3:14b'));
  const LLAMA = native(capsAt('http://127.0.0.1:8080', 'qwen3-14b'));
  const OPENAI = capsAt('https://api.openai.com:443', 'gpt-5');

  test('Ollama: tools + tool_choice auto on a round; nothing on the final one', () => {
    const round = body(request({ caps: OLLAMA, messages: ROUND, tools: TOOLS, toolChoice: 'auto' }));
    expect((round.tools as Wire[]).map((t) => (t.function as Wire).name)).toEqual(['read_lore', 'search_lore']);
    expect(round.tool_choice).toBe('auto');
    const final = body(request({ caps: OLLAMA, messages: ROUND, tools: TOOLS, toolChoice: 'none' }));
    expect(final.tools).toBeUndefined();
    expect(final.tool_choice).toBeUndefined();
    // The round's tool traffic stays on the wire.
    expect((final.messages as Wire[]).some((m) => m.role === 'tool')).toBe(true);
  });

  test('llama.cpp: parallel_tool_calls true on a round; the final round drops the tools too', () => {
    const round = body(request({ caps: LLAMA, messages: ROUND, tools: TOOLS, toolChoice: 'auto' }));
    expect(round.parallel_tool_calls).toBe(true);
    const final = body(request({ caps: LLAMA, messages: ROUND, tools: TOOLS, toolChoice: 'none' }));
    expect(final.tools).toBeUndefined();
    expect(final.parallel_tool_calls).toBeUndefined();
  });

  test('a server that honours tool_choice keeps the schemas declared with tool_choice none', () => {
    const final = body(request({ caps: OPENAI, messages: ROUND, tools: TOOLS, toolChoice: 'none' }));
    expect((final.tools as Wire[]).length).toBe(2);
    expect(final.tool_choice).toBe('none');
  });

  test('DeepSeek reasoners: tools on a round, never any tool_choice', () => {
    const round = body(request({ caps: REASONER, messages: ROUND, tools: TOOLS, toolChoice: 'auto' }));
    expect((round.tools as Wire[]).length).toBe(2);
    expect(round).not.toHaveProperty('tool_choice');
  });

  test('prompted caps never send a tools field', () => {
    const prompted = capsAt('http://127.0.0.1:11434', 'qwen3:14b');
    expect(prompted.tools).toBe('prompted');
    const b = body(request({ caps: prompted, messages: HISTORY, tools: TOOLS, toolChoice: 'auto' }));
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });
});

describe('validateToolProtocol over the loop\'s requests (§8.3)', () => {
  const replay = [{ kind: 'reasoning_details' as const, connection: 'c', model: 'm', payload: [{ type: 'reasoning.encrypted', data: 'x' }] }];
  /** Round 0: reasoning + visible text + two calls (with the round's replay), then ONE tool message with both results. */
  const native: PromptMsg[] = [
    ...HISTORY,
    {
      ...blocks(
        'assistant',
        { k: 'reasoning', text: 'Two lookups.' },
        { k: 'text', text: 'Mara thinks.' },
        { k: 'tool_call', id: 'call_0_0', name: 'search_lore', args: '{"query":"amber"}' },
        { k: 'tool_call', id: 'call_0_1', name: 'read_lore', args: '{"ids":["L1"]}' },
      ),
      replay,
    },
    blocks('tool', { k: 'tool_result', callId: 'call_0_0', name: 'search_lore', text: 'L1 Amber' }, { k: 'tool_result', callId: 'call_0_1', name: 'read_lore', text: 'Amber is warm.', error: false }),
  ];

  test('a native round and a second one, plus the final cue as its own message', () => {
    const two: PromptMsg[] = [
      ...native,
      blocks('assistant', { k: 'tool_call', id: 'call_1_0', name: 'search_lore', args: '{"query":"stone"}' }),
      blocks('tool', { k: 'tool_result', callId: 'call_1_0', name: 'search_lore', text: 'nothing', error: true }),
      { ...msg('system', 'Tool use is over for this reply.'), src: 'core:final_cue' },
    ];
    expect(validateToolProtocol(native)).toEqual({ ok: true });
    expect(validateToolProtocol(two)).toEqual({ ok: true });
    const m = wireMessages(request({ caps: mergeCaps(capsAt('https://api.openai.com:443', 'gpt-5'), {}), model: { connection: 'c', model: 'm' }, messages: two, tools: TOOLS, toolChoice: 'none' }));
    expect(m[5]).toMatchObject({ role: 'assistant', content: 'Mara thinks.', reasoning_details: [{ type: 'reasoning.encrypted', data: 'x' }] });
    expect((m[5]!.tool_calls as Wire[]).map((c) => c.id)).toEqual(['call_0_0', 'call_0_1']);
    // One tool PromptMsg with two results → two role:'tool' messages, in call order.
    expect(m.slice(6, 8)).toEqual([
      { role: 'tool', tool_call_id: 'call_0_0', content: 'L1 Amber' },
      { role: 'tool', tool_call_id: 'call_0_1', content: 'Amber is warm.' },
    ]);
    expect(m[8]).toMatchObject({ role: 'assistant', content: null });
    expect(m[9]).toEqual({ role: 'tool', tool_call_id: 'call_1_0', content: 'nothing' });
    expect(m[10]).toEqual({ role: 'system', content: 'Tool use is over for this reply.' });
  });

  test('a prompted round: raw assistant text (tags kept) and one user message of results, all plain text', () => {
    const prompted: PromptMsg[] = [
      ...HISTORY,
      msg('assistant', 'Mara thinks. <tool_call>{"name":"search_lore","args":{"query":"amber"}}</tool_call>'),
      msg('user', '<tool_result name="search_lore" id="call_0_0">\nL1 Amber\n</tool_result>\n\nTool use is over for this reply.'),
    ];
    expect(validateToolProtocol(prompted)).toEqual({ ok: true });
    const m = wireMessages(request({ caps: capsAt('http://127.0.0.1:11434', 'q'), messages: prompted, tools: TOOLS, toolChoice: 'auto' }));
    expect(m.slice(-2)).toEqual([
      { role: 'assistant', content: 'Mara thinks. <tool_call>{"name":"search_lore","args":{"query":"amber"}}</tool_call>' },
      { role: 'user', content: '<tool_result name="search_lore" id="call_0_0">\nL1 Amber\n</tool_result>\n\nTool use is over for this reply.' },
    ]);
  });

  const broken: [string, PromptMsg[], string][] = [
    ['a missing result', [native[5]!, blocks('tool', native[6]!.blocks[0]!)], 'incomplete at the end'],
    ['results out of order', [native[5]!, blocks('tool', native[6]!.blocks[1]!, native[6]!.blocks[0]!)], 'out of order'],
    ['a text message inside the batch', [native[5]!, msg('user', 'hm'), native[6]!], 'incomplete before message 1'],
    ['a result in an assistant message', [native[5]!, blocks('assistant', ...native[6]!.blocks)], 'must be in a tool or user message'],
    ['a call in a user message', [blocks('user', { k: 'tool_call', id: 'a', name: 'search_lore', args: '{}' })], 'require an assistant message'],
    [
      'an id reused by a later round',
      [native[5]!, native[6]!, blocks('assistant', { k: 'tool_call', id: 'call_0_0', name: 'search_lore', args: '{}' }), blocks('tool', { k: 'tool_result', callId: 'call_0_0', name: 'search_lore', text: 'x' })],
      'duplicate',
    ],
    ['an unsafe id', [blocks('assistant', { k: 'tool_call', id: 'call 1', name: 'search_lore', args: '{}' }), blocks('tool', { k: 'tool_result', callId: 'call 1', name: 'search_lore', text: 'x' })], 'unsafe'],
    ['arguments that are not an object', [blocks('assistant', { k: 'tool_call', id: 'a', name: 'search_lore', args: '"amber"' }), blocks('tool', { k: 'tool_result', callId: 'a', name: 'search_lore', text: 'x' })], 'must be a JSON object'],
    ['unparseable arguments', [blocks('assistant', { k: 'tool_call', id: 'a', name: 'search_lore', args: '{"q":' }), blocks('tool', { k: 'tool_result', callId: 'a', name: 'search_lore', text: 'x' })], 'invalid JSON'],
    ['a result under another name', [blocks('assistant', { k: 'tool_call', id: 'a', name: 'search_lore', args: '{}' }), blocks('tool', { k: 'tool_result', callId: 'a', name: 'read_lore', text: 'x' })], 'names read_lore'],
    ['a result for an unknown call', [blocks('tool', { k: 'tool_result', callId: 'zz', name: 'read_lore', text: 'x' })], 'unknown call zz'],
  ];

  for (const [what, messages, why] of broken) {
    test(`refused: ${what}`, async () => {
      const v = validateToolProtocol(messages);
      expect(v.ok).toBe(false);
      expect(v.ok ? '' : v.why).toContain(why);
      // The adapter refuses before anything is sent.
      expect(() => body(request({ messages, tools: TOOLS }))).toThrow(ProviderError);
      let fetched = 0;
      const p = createOpenAIChatProvider({ connectionId: 'c', baseUrl: 'http://127.0.0.1:9999', local: true });
      const evs = await collect(
        p.stream(request({ messages, tools: TOOLS }), {
          fetch: Object.assign(async () => {
            fetched++;
            return new Response('');
          }, { preconnect: fetch.preconnect }) as typeof fetch,
          key: null,
        }),
      );
      expect(fetched).toBe(0);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.t === 'error' && evs[0]!.err.code).toBe('tool_protocol_invalid');
    });
  }
});
