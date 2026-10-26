// Ported from Bunraku:src/stage/provider/transport-core.test.ts (role post-processing cases)@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// prompt/shape.ts postProcess (M1b, D-48): SillyTavern's prompt post-processing over PromptMsg blocks.
// The mode cases follow Bunraku's (which pin RoleCall's port of ST's mergeMessages); the blank-message
// case now expects a merge (the quirk is not ported); the block-aware and placement cases are new.
import { describe, expect, test } from 'bun:test';
import {
  POST_PROCESSING_PLACEHOLDER,
  POST_PROCESSING_PLACEHOLDER_SRC,
  isFixedMessage,
  postProcess,
} from '../../src/prompt/shape.ts';
import type { PromptMsg } from '../../src/providers/types.ts';

/** A plain text message; src defaults to the text so merged sources are easy to read. */
const m = (role: PromptMsg['role'], text: string, src = text, placement?: PromptMsg['placement']): PromptMsg => ({
  role,
  blocks: [{ k: 'text', text }],
  src,
  ...(placement ? { placement } : {}),
});
const text = (x: PromptMsg): string => x.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');
const rows = (xs: readonly PromptMsg[]): [string, string][] => xs.map((x) => [x.role, text(x)]);

const MIXED: PromptMsg[] = [
  m('system', 'A'),
  m('system', 'B'),
  m('user', 'U1'),
  m('user', 'U2'),
  m('assistant', 'A1'),
  m('system', 'mid'),
  m('user', 'U3'),
];

const toolCall: PromptMsg = {
  role: 'assistant',
  blocks: [
    { k: 'text', text: 'Let me look.' },
    { k: 'tool_call', id: 'c1', name: 'search_history', args: '{"q":"lamp"}' },
  ],
  src: 'round:1',
};
const toolResult: PromptMsg = {
  role: 'tool',
  blocks: [{ k: 'tool_result', callId: 'c1', name: 'search_history', text: 'The lamp swings.' }],
  src: 'round:1',
};

describe('ST modes (as Bunraku pins them)', () => {
  test('none and unset return an equal copy, not the same array, and say nothing', () => {
    for (const mode of ['none', undefined] as const) {
      const out = postProcess(MIXED, mode);
      expect(out.messages).toEqual(MIXED);
      expect(out.messages).not.toBe(MIXED);
      out.messages.forEach((x, i) => expect(x).toBe(MIXED[i]!));
      expect(out.notices).toEqual([]);
    }
  });

  test('merge joins consecutive same-role messages with a blank line', () => {
    const out = postProcess(MIXED, 'merge');
    expect(rows(out.messages)).toEqual([
      ['system', 'A\n\nB'],
      ['user', 'U1\n\nU2'],
      ['assistant', 'A1'],
      ['system', 'mid'],
      ['user', 'U3'],
    ]);
    expect(out.messages.map((x) => x.src)).toEqual(['A+B', 'U1+U2', 'A1', 'mid', 'U3']);
    expect(out.notices).toEqual([]);
  });

  test('semi also turns every system message after the first into user, then merges again', () => {
    expect(rows(postProcess(MIXED, 'semi').messages)).toEqual([
      ['system', 'A\n\nB'],
      ['user', 'U1\n\nU2'],
      ['assistant', 'A1'],
      ['user', 'mid\n\nU3'],
    ]);
  });

  test('strict adds a user placeholder after a leading system message that is not followed by a user', () => {
    const out = postProcess([m('system', 'S'), m('assistant', 'X')], 'strict');
    expect(rows(out.messages)).toEqual([
      ['system', 'S'],
      ['user', POST_PROCESSING_PLACEHOLDER],
      ['assistant', 'X'],
    ]);
    expect(out.messages[1]!.src).toBe(POST_PROCESSING_PLACEHOLDER_SRC);
    expect(out.messages[1]!.placement).toBe('inline');
    expect(POST_PROCESSING_PLACEHOLDER).toBe("Let's get started.");
    // a lone system message gets one too (ST: merged.length === 1)
    expect(rows(postProcess([m('system', 'S')], 'strict').messages)).toEqual([
      ['system', 'S'],
      ['user', POST_PROCESSING_PLACEHOLDER],
    ]);
    // the placeholder is the mode working as designed, not news
    expect(out.notices).toEqual([]);
  });

  test('strict adds a user placeholder in front when the chat opens with neither system nor user', () => {
    expect(rows(postProcess([m('assistant', 'X'), m('user', 'Y')], 'strict').messages)).toEqual([
      ['user', POST_PROCESSING_PLACEHOLDER],
      ['assistant', 'X'],
      ['user', 'Y'],
    ]);
  });

  test('strict leaves a well-formed opening alone', () => {
    expect(rows(postProcess(MIXED, 'strict').messages)).toEqual(rows(postProcess(MIXED, 'semi').messages));
    expect(rows(postProcess([m('user', 'Y'), m('assistant', 'X')], 'strict').messages)).toEqual([
      ['user', 'Y'],
      ['assistant', 'X'],
    ]);
  });

  test('single turns everything into one user message', () => {
    const out = postProcess(MIXED, 'single');
    expect(rows(out.messages)).toEqual([['user', 'A\n\nB\n\nU1\n\nU2\n\nA1\n\nmid\n\nU3']]);
    expect(out.messages[0]!.src).toBe('A+B+U1+U2+A1+mid+U3');
    expect(out.notices).toEqual([]);
  });

  test('an empty list becomes one placeholder user message, with a notice', () => {
    for (const mode of ['merge', 'semi', 'strict', 'single'] as const) {
      const out = postProcess([], mode);
      expect(rows(out.messages)).toEqual([['user', POST_PROCESSING_PLACEHOLDER]]);
      expect(out.notices.map((n) => n.code)).toEqual(['post_processing_placeholder']);
    }
  });

  test('a blank message merges like any other and adds no separator (ST keeps it apart: quirk not ported)', () => {
    expect(rows(postProcess([m('user', 'a'), m('user', '   ')], 'merge').messages)).toEqual([['user', 'a']]);
    expect(rows(postProcess([m('user', ''), m('user', 'b')], 'merge').messages)).toEqual([['user', 'b']]);
    expect(rows(postProcess([m('user', 'a'), m('user', ''), m('user', 'b')], 'merge').messages)).toEqual([['user', 'a\n\nb']]);
  });

  test('the input is never mutated', () => {
    const inp = [m('user', 'a'), m('user', 'b'), m('system', 'c')];
    const copy = structuredClone(inp);
    for (const mode of ['merge', 'semi', 'strict', 'single'] as const) postProcess(inp, mode);
    expect(inp).toEqual(copy);
  });

  test('an unknown mode is sent as assembled with a warning', () => {
    const out = postProcess(MIXED, 'merge_tools' as never);
    expect(out.messages).toEqual(MIXED);
    expect(out.notices).toEqual([expect.objectContaining({ level: 'warn', code: 'post_processing_unknown' })]);
  });
});

describe('block-aware: tool-carrying messages are never merged or re-roled [D-48]', () => {
  test('which messages are fixed', () => {
    expect(isFixedMessage(m('user', 'x'))).toBe(false);
    expect(isFixedMessage(toolCall)).toBe(true);
    expect(isFixedMessage(toolResult)).toBe(true);
    expect(isFixedMessage({ role: 'tool', blocks: [{ k: 'text', text: 'x' }], src: 'r' })).toBe(true);
    expect(isFixedMessage({ role: 'assistant', blocks: [{ k: 'reasoning', text: 'hmm' }, { k: 'text', text: 'x' }], src: 'r' })).toBe(true);
    const replay: PromptMsg = { ...m('assistant', 'x'), replay: [{ kind: 'reasoning_details', connection: 'c', model: 'm', payload: [] }] };
    expect(isFixedMessage(replay)).toBe(true);
    expect(isFixedMessage({ ...m('assistant', 'x'), replay: [] })).toBe(false);
  });

  test('merge keeps a tool round intact and merges around it', () => {
    const inp = [m('system', 'S'), m('user', 'U'), toolCall, toolResult, m('assistant', 'A2'), m('assistant', 'A3')];
    const out = postProcess(inp, 'merge');
    expect(out.messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(out.messages[2]).toBe(toolCall);
    expect(out.messages[3]).toBe(toolResult);
    expect(text(out.messages[4]!)).toBe('A2\n\nA3');
    expect(out.notices).toEqual([]); // nothing unusual: no same-role neighbour was kept apart
  });

  test('a text message next to a same-role tool message stays apart, with a notice', () => {
    const out = postProcess([m('system', 'S'), m('user', 'U'), m('assistant', 'Thinking aloud.'), toolCall], 'merge');
    expect(out.messages).toHaveLength(4);
    expect(out.messages[3]).toBe(toolCall);
    expect(out.notices).toEqual([expect.objectContaining({ level: 'info', code: 'post_processing_partial' })]);
  });

  test('a user message carrying tool results (prompted transport) is not merged with the user text after it', () => {
    const prompted: PromptMsg = { role: 'user', blocks: [toolResult.blocks[0]!], src: 'round:1' };
    const out = postProcess([m('system', 'S'), m('user', 'U'), toolCall, prompted, m('system', 'note'), m('user', 'U2')], 'semi');
    expect(out.messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(out.messages[3]).toBe(prompted);
    expect(text(out.messages[4]!)).toBe('note\n\nU2');
  });

  test('replay and reasoning keep an assistant message apart from its neighbour', () => {
    const replay: PromptMsg = { ...m('assistant', 'R'), replay: [{ kind: 'reasoning_details', connection: 'c', model: 'm', payload: [] }] };
    const reasoning: PromptMsg = { role: 'assistant', blocks: [{ k: 'reasoning', text: 'hmm' }, { k: 'text', text: 'T' }], src: 'r' };
    const out = postProcess([m('user', 'U'), m('assistant', 'A'), replay, reasoning, m('assistant', 'B')], 'merge');
    expect(out.messages).toHaveLength(5);
    expect(out.messages[2]).toBe(replay);
    expect(out.messages[3]).toBe(reasoning);
  });

  test('tool messages among themselves are normal: several results in a row are never merged, no notice', () => {
    const second: PromptMsg = { ...toolResult, blocks: [{ k: 'tool_result', callId: 'c2', name: 'x', text: 'y' }] };
    const out = postProcess([m('user', 'U'), toolCall, toolResult, second], 'merge');
    expect(out.messages).toHaveLength(4);
    expect(out.notices).toEqual([]);
  });

  test("single leaves tool messages in place with their roles and says it could not make one message", () => {
    const out = postProcess([m('system', 'S'), m('user', 'U'), toolCall, toolResult, m('assistant', 'A')], 'single');
    expect(rows(out.messages)).toEqual([
      ['user', 'S\n\nU'],
      ['assistant', 'Let me look.'],
      ['tool', ''],
      ['user', 'A'],
    ]);
    expect(out.messages[1]).toBe(toolCall);
    expect(out.messages[2]).toBe(toolResult);
    expect(out.notices).toEqual([expect.objectContaining({ code: 'post_processing_partial', message: expect.stringContaining("'single' left 4 messages") })]);
  });

  test('semi never re-roles a fixed system message', () => {
    const fixedSys: PromptMsg = { ...m('system', 'sig'), replay: [{ kind: 'anthropic-blocks', connection: 'c', model: 'm', payload: [] }] };
    const out = postProcess([m('system', 'S'), m('user', 'U'), fixedSys], 'semi');
    expect(out.messages[2]).toBe(fixedSys);
  });
});

describe('placement: head and inline never merge [D-48]', () => {
  // The builtin layout: the leading system run is 'head', new_chat is an inline system message.
  const layout = (): PromptMsg[] => [
    m('system', 'Main', 'main', 'head'),
    m('system', 'Persona', 'persona', 'head'),
    m('system', '[Start a new chat]', 'new_chat', 'inline'),
    m('assistant', 'Hello, traveller.', 'history'),
    m('user', 'Hi.', 'history'),
    m('system', 'Stay in character.', 'post_history', 'inline'),
  ];

  test('merge joins the head run but not the inline system message after it', () => {
    const out = postProcess(layout(), 'merge');
    expect(out.messages.map((x) => `${x.role}|${x.placement ?? '-'}|${x.src}`)).toEqual([
      'system|head|main+persona',
      'system|inline|new_chat',
      'assistant|-|history',
      'user|-|history',
      'system|inline|post_history',
    ]);
  });

  test('semi: the inline system message after the head becomes user, as ST makes every system message but the first', () => {
    const out = postProcess(layout(), 'semi');
    expect(out.messages.map((x) => `${x.role}|${x.placement ?? '-'}|${x.src}`)).toEqual([
      'system|head|main+persona',
      'user|inline|new_chat',
      'assistant|-|history',
      'user|inline|history+post_history', // unset and 'inline' are the same placement; the merge names it
    ]);
    // strict needs no placeholder: the first message after the system one is now user
    expect(rows(postProcess(layout(), 'strict').messages)).toEqual(rows(out.messages));
  });

  test('single: a head message that becomes user leaves the head, so everything is one inline message', () => {
    const out = postProcess(layout(), 'single');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe('user');
    expect(out.messages[0]!.placement).toBe('inline');
    expect(text(out.messages[0]!)).toBe('Main\n\nPersona\n\n[Start a new chat]\n\nHello, traveller.\n\nHi.\n\nStay in character.');
  });

  test("single with names prefixes the chat's speakers (only chat messages, never twice)", () => {
    const inp = [...layout(), m('assistant', 'Mira: She nods.', 'history'), m('user', 'A preset user block.', 'jailbreak')];
    const out = postProcess(inp, 'single', { char: 'Mira', user: 'Levi' });
    expect(text(out.messages[0]!)).toBe(
      'Main\n\nPersona\n\n[Start a new chat]\n\nMira: Hello, traveller.\n\nLevi: Hi.\n\nStay in character.\n\nMira: She nods.\n\nA preset user block.',
    );
  });
});
