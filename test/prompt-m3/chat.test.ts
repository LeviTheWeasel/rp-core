// M3 history rendering (decisions C3, C4; §8.4 D-94): each history message's text blocks are ONE text
// block joined with '' (as they streamed); with echoReasoning and tools offered, answers of that
// connection and model keep their raw reasoning blocks before the text block; shape lets such
// echo answers still merge (DeepSeek refuses successive assistant turns).
import { describe, expect, test } from 'bun:test';
import { HISTORY_SRC } from '../../src/prompt/assemble.ts';
import { applyCapsRules, shape } from '../../src/prompt/shape.ts';
import { CHARS_COUNTER, estimateMessage } from '../../src/prompt/tokens.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import type { Block } from '../../src/session/entries.ts';
import { CAPS, chain, LEVI, MIRA, msg, RICH, runOk, SPECS } from './fixtures.ts';

const ECHO = { connection: 'deepseek', model: 'deepseek-reasoner' };
const DS = { connection: 'deepseek', model: 'deepseek-reasoner' };
const DS_CAPS = { ...CAPS, alternation: 'strict' as const, reasoning: { ...CAPS.reasoning, echo: 'all-with-tools' as const } };

/** The history messages of a request, as their blocks. */
const historyBlocks = (msgs: readonly PromptMsg[]): Block[][] => msgs.filter((m) => m.src === HISTORY_SRC).map((m) => m.blocks);

const answer = (id: string, blocks: Block[], model?: { connection: string; model: string }) => msg(id, 'assistant', '', { blocks, ...(model ? { model } : {}) });

describe('one text block per history message', () => {
  test('a multi-round answer is joined as it streamed; tool blocks stay out', () => {
    const view = chain([
      msg('g', 'assistant', 'Hello.', { greeting: true }),
      msg('u1', 'user', 'Where is the map?'),
      answer('a1', [
        { k: 'text', text: 'Let me look.' },
        { k: 'tool_call', id: 'c1', name: 'search_history', args: '{"query":"map"}' },
        { k: 'tool_result', callId: 'c1', name: 'search_history', text: '#3 the map' },
        { k: 'text', text: '\nFound it.' },
      ]),
      msg('u2', 'user', 'Good.'),
    ]);
    const r = runOk({ view });
    expect(historyBlocks(r.messages)).toEqual([
      [{ k: 'text', text: 'Hello.' }],
      [{ k: 'text', text: 'Where is the map?' }],
      [{ k: 'text', text: 'Let me look.\nFound it.' }],
      [{ k: 'text', text: 'Good.' }],
    ]);
    // Counted as the one block it is.
    const a1 = r.messages.findIndex((m) => m.src === HISTORY_SRC && m.blocks[0]?.k === 'text' && m.blocks[0].text.startsWith('Let me'));
    expect(r.trace.blocks[a1]!.tok).toBe(estimateMessage(r.messages[a1]!, CHARS_COUNTER));
  });

  test('user text blocks are joined before the identity macros run', () => {
    const view = chain([
      msg('u1', 'user', '', {
        blocks: [
          { k: 'text', text: 'Hi, {{ch' },
          { k: 'text', text: 'ar}} and {{user}}.' },
        ],
      }),
    ]);
    expect(historyBlocks(runOk({ view }).messages)).toEqual([[{ k: 'text', text: 'Hi, Mira and Levi.' }]]);
  });

  test('a message whose text blocks are all blank is skipped like a tool-only one', () => {
    const view = chain([
      msg('u1', 'user', 'Hi.'),
      answer('a1', [
        { k: 'text', text: '' },
        { k: 'tool_call', id: 'c1', name: 'x', args: '{}' },
        { k: 'text', text: '  ' },
      ]),
      msg('u2', 'user', 'Again.'),
    ]);
    const r = runOk({ view });
    expect(historyBlocks(r.messages)).toEqual([[{ k: 'text', text: 'Hi.' }], [{ k: 'text', text: 'Again.' }]]);
    expect(r.kept).toEqual(['u1', 'u2']);
  });
});

describe('the reasoning echo (§8.4, D-94)', () => {
  const view = chain([
    msg('g', 'assistant', 'Hello.', { greeting: true, blocks: [{ k: 'reasoning', text: 'greeting thoughts' }, { k: 'text', text: 'Hello.' }] }),
    msg('u1', 'user', 'One.'),
    answer('a1', [{ k: 'reasoning', text: 'r1' }, { k: 'text', text: 'A1.' }], DS),
    msg('u2', 'user', 'Two.'),
    answer('a2', [{ k: 'reasoning', text: 'other model' }, { k: 'text', text: 'A2.' }], { connection: 'deepseek', model: 'deepseek-chat' }),
    msg('u3', 'user', 'Three.'),
    answer('a3', [{ k: 'reasoning', text: 'other connection' }, { k: 'text', text: 'A3.' }], { connection: 'openrouter', model: 'deepseek-reasoner' }),
    msg('u4', 'user', 'Four.'),
    answer(
      'a4',
      [
        { k: 'reasoning', text: 'round 0' },
        { k: 'text', text: 'Let me check.' },
        { k: 'tool_call', id: 'c1', name: 'search_history', args: '{}' },
        { k: 'tool_result', callId: 'c1', name: 'search_history', text: 'none' },
        { k: 'reasoning', text: '' },
        { k: 'reasoning', text: 'a summary', kind: 'summary' },
        { k: 'reasoning', text: 'round 1', kind: 'raw' },
        { k: 'reasoning', text: 'hidden', kind: 'redacted' },
        { k: 'text', text: ' Nothing.' },
      ],
      DS,
    ),
    msg('u5', 'user', 'Five.', { blocks: [{ k: 'reasoning', text: 'user reasoning?' }, { k: 'text', text: 'Five.' }] }),
  ]);

  test('only raw reasoning of answers by the same connection and model, before the one text block', () => {
    const r = runOk({ view, tools: SPECS, caps: DS_CAPS, echoReasoning: ECHO });
    expect(historyBlocks(r.messages)).toEqual([
      [{ k: 'text', text: 'Hello.' }], // a greeting never echoes
      [{ k: 'text', text: 'One.' }],
      [
        { k: 'reasoning', text: 'r1' },
        { k: 'text', text: 'A1.' },
      ],
      [{ k: 'text', text: 'Two.' }],
      [{ k: 'text', text: 'A2.' }], // another model
      [{ k: 'text', text: 'Three.' }],
      [{ k: 'text', text: 'A3.' }], // another connection
      [{ k: 'text', text: 'Four.' }],
      [
        { k: 'reasoning', text: 'round 0' },
        { k: 'reasoning', text: 'round 1', kind: 'raw' },
        { k: 'text', text: 'Let me check. Nothing.' },
      ],
      [{ k: 'text', text: 'Five.' }], // user messages never
    ]);
  });

  test('the echoed reasoning is counted in the budget', () => {
    const plain = runOk({ view, tools: SPECS, caps: DS_CAPS });
    const echoed = runOk({ view, tools: SPECS, caps: DS_CAPS, echoReasoning: ECHO });
    expect(echoed.trace.tokens.estimated).toBe(plain.trace.tokens.estimated + CHARS_COUNTER.count('r1') + CHARS_COUNTER.count('round 0') + CHARS_COUNTER.count('round 1'));
    expect(echoed.kept).toEqual(plain.kept);
  });

  test('no echo without tools, nor when the prefill rule turns them off', () => {
    const noTools = runOk({ view, caps: DS_CAPS, echoReasoning: ECHO });
    expect(JSON.stringify(noTools.messages)).not.toContain('"reasoning"');
    const off = runOk({ view, caps: DS_CAPS, preset: RICH, tools: SPECS, echoReasoning: ECHO });
    expect(off.trace.prefill).toBe('tools_off');
    expect(JSON.stringify(off.messages)).not.toContain('"reasoning"');
  });

  test('without echoReasoning the history is text only even with tools [D-16]', () => {
    const r = runOk({ view, tools: SPECS, caps: DS_CAPS });
    expect(historyBlocks(r.messages).flat().every((b) => b.k === 'text')).toBe(true);
  });
});

describe('shape and echo answers', () => {
  const two = chain([
    msg('u1', 'user', 'One.'),
    answer('a1', [{ k: 'reasoning', text: 'r1' }, { k: 'text', text: 'A1.' }], DS),
    msg('u2', 'user', 'hidden aside', { hidden: true }),
    answer('a2', [{ k: 'reasoning', text: 'r2' }, { k: 'text', text: 'A2.' }], DS),
    msg('u3', 'user', 'Three.'),
  ]);
  // MIRA's depth prompt (depth 2) would land between a1 and a2: leave it out here.
  const cast = { character: { ...MIRA, depthPrompt: undefined }, persona: LEVI };

  test('strict alternation merges two adjacent echo answers, reasoning kept in order', () => {
    const r = runOk({ view: two, cast, tools: SPECS, caps: DS_CAPS, echoReasoning: ECHO });
    const out = shape({ messages: r.messages, caps: DS_CAPS, prefill: null, kind: 'reply' });
    const answers = out.messages.filter((m) => m.role === 'assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.blocks).toEqual([
      { k: 'reasoning', text: 'r1' },
      { k: 'reasoning', text: 'r2' },
      { k: 'text', text: 'A1.\n\nA2.' },
    ]);
    expect(answers[0]!.src).toBe('history+history');
    expect(out.notices).toEqual([]);
  });

  test('free alternation leaves them apart, untouched', () => {
    const r = runOk({ view: two, cast, tools: SPECS, caps: { ...DS_CAPS, alternation: 'free' }, echoReasoning: ECHO });
    const out = shape({ messages: r.messages, caps: { ...DS_CAPS, alternation: 'free' }, prefill: null, kind: 'reply' });
    expect(out.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  test("an echo answer merges with a plain answer; a loop message with reasoning (not 'history') stays apart", () => {
    const echo: PromptMsg = { role: 'assistant', blocks: [{ k: 'reasoning', text: 'r1' }, { k: 'text', text: 'A1.' }], src: HISTORY_SRC };
    const plain: PromptMsg = { role: 'assistant', blocks: [{ k: 'text', text: 'A2.' }], src: HISTORY_SRC };
    const merged = applyCapsRules([{ role: 'user', blocks: [{ k: 'text', text: 'U' }], src: HISTORY_SRC }, echo, plain], DS_CAPS);
    expect(merged).toHaveLength(2);
    expect(merged[1]!.blocks).toEqual([
      { k: 'reasoning', text: 'r1' },
      { k: 'text', text: 'A1.\n\nA2.' },
    ]);
    const loop: PromptMsg = { role: 'assistant', blocks: [{ k: 'reasoning', text: 'r' }, { k: 'text', text: 'T' }], src: 'round:1' };
    expect(applyCapsRules([echo, loop], DS_CAPS)).toEqual([echo, loop]);
    const summary: PromptMsg = { ...echo, blocks: [{ k: 'reasoning', text: 's', kind: 'summary' }, { k: 'text', text: 'S' }] };
    expect(applyCapsRules([echo, summary], DS_CAPS)).toEqual([echo, summary]);
  });

  test('applyCapsRules over an already shaped request changes nothing (the loop may run it again on what it appends)', () => {
    const r = runOk({ view: two, tools: SPECS, caps: { ...DS_CAPS, midSystem: 'as-user' }, echoReasoning: ECHO, authorNote: { text: 'Note.', depth: 1, role: 'system' } });
    const caps = { ...DS_CAPS, midSystem: 'as-user' as const };
    const once = shape({ messages: r.messages, caps, prefill: null, kind: 'reply' }).messages;
    expect(applyCapsRules(once, caps)).toEqual(once);
  });
});
