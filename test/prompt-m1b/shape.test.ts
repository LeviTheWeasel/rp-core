// prompt/shape.ts (M1b): the capability rules (mid-system as user, strict alternation, §8.5 generic
// path, D-48), their order after post-processing, and the M1a prefill/continue behaviour under both.
import { describe, expect, test } from 'bun:test';
import {
  CONTINUE_CUE,
  CONTINUE_CUE_SRC,
  SYSTEM_NOTE_PREFIX,
  applyCapsRules,
  leadingSystemRun,
  midSystemAsUser,
  shape,
  type ShapeInput,
} from '../../src/prompt/shape.ts';
import type { ModelCaps, PromptMsg } from '../../src/providers/types.ts';
import { CAPS } from '../assemble/fixtures.ts';

const m = (role: PromptMsg['role'], text: string, src = 'history', placement?: PromptMsg['placement']): PromptMsg => ({
  role,
  blocks: [{ k: 'text', text }],
  src,
  ...(placement ? { placement } : {}),
});
const text = (x: PromptMsg): string => x.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');
const rows = (xs: readonly PromptMsg[]): string[] => xs.map((x) => `${x.role}|${x.src}|${text(x)}`);

const caps = (over: Partial<ModelCaps>): ModelCaps => ({ ...CAPS, ...over });
const AS_USER = caps({ midSystem: 'as-user' });
const STRICT = caps({ alternation: 'strict' });
const ROUTER = caps({ midSystem: 'as-user', alternation: 'strict' });

const S = m('system', 'You are Mira.', 'main', 'head');
const N = (t: string, src = 'author_note'): PromptMsg => m('system', t, src, 'inline');

const toolCall: PromptMsg = {
  role: 'assistant',
  blocks: [{ k: 'tool_call', id: 'c1', name: 'roll', args: '{}' }],
  src: 'round:1',
};
const promptedResult: PromptMsg = {
  role: 'user',
  blocks: [{ k: 'tool_result', callId: 'c1', name: 'roll', text: '17' }],
  src: 'round:1',
};

describe('leading system run', () => {
  test('counts the system messages before the first non-system one, whatever their placement', () => {
    expect(leadingSystemRun([S, N('[Start]', 'new_chat'), m('assistant', 'Hi')])).toBe(2);
    expect(leadingSystemRun([m('user', 'U'), S])).toBe(0);
    expect(leadingSystemRun([])).toBe(0);
  });
});

describe("mid-system 'as-user' (§8.5 generic path)", () => {
  test('a note is prefixed and merged in front of the NEXT user message', () => {
    const inp = [S, m('assistant', 'Hello.'), N('Mira is tired.'), m('user', 'Hi.'), m('assistant', 'She yawns.'), m('user', 'Sleep?')];
    const out = midSystemAsUser(inp);
    expect(rows(out)).toEqual([
      'system|main|You are Mira.',
      'assistant|history|Hello.',
      `user|author_note+history|${SYSTEM_NOTE_PREFIX}Mira is tired.\n\nHi.`,
      'assistant|history|She yawns.',
      'user|history|Sleep?',
    ]);
    expect(out[0]).toBe(S); // the leading run is the adapter's
    expect(out[3]).toBe(inp[4]!);
    expect(SYSTEM_NOTE_PREFIX).toBe('[System note] ');
  });

  test('with no user message after it, the note is appended to the PREVIOUS one', () => {
    // depth-0 guidance after the current user message; post_history after the history
    const inp = [S, m('assistant', 'Hello.'), m('user', 'Hi.'), N('Be brief.', 'guidance'), N('Stay in character.', 'post_history')];
    expect(rows(midSystemAsUser(inp))).toEqual([
      'system|main|You are Mira.',
      'assistant|history|Hello.',
      `user|history+guidance+post_history|Hi.\n\n${SYSTEM_NOTE_PREFIX}Be brief.\n\nStay in character.`,
    ]);
  });

  test('backwards across an assistant message when nothing follows', () => {
    const inp = [S, m('user', 'Hi.'), m('assistant', 'Hello.', 'preset:tail'), N('Note.')];
    expect(rows(midSystemAsUser(inp))).toEqual([
      'system|main|You are Mira.',
      `user|history+author_note|Hi.\n\n${SYSTEM_NOTE_PREFIX}Note.`,
      'assistant|preset:tail|Hello.',
    ]);
  });

  test('adjacent notes become one note first; notes apart keep their own prefixes', () => {
    const adjacent = midSystemAsUser([S, m('assistant', 'A0'), N('n1', 'a'), N('n2', 'b'), m('user', 'U1')]);
    expect(rows(adjacent).at(-1)).toBe(`user|a+b+history|${SYSTEM_NOTE_PREFIX}n1\n\nn2\n\nU1`);
    const apart = midSystemAsUser([S, m('assistant', 'A0'), N('n1', 'a'), m('assistant', 'A1'), N('n2', 'b'), m('user', 'U1')]);
    expect(rows(apart)).toEqual([
      'system|main|You are Mira.',
      'assistant|history|A0',
      'assistant|history|A1',
      `user|a+b+history|${SYSTEM_NOTE_PREFIX}n1\n\n${SYSTEM_NOTE_PREFIX}n2\n\nU1`,
    ]);
  });

  test('the leading run (inline new_chat included) is left alone; with no lead every system message is a note', () => {
    const newChat = N('[Start a new chat]', 'new_chat');
    const out = midSystemAsUser([S, newChat, m('assistant', 'Hello.'), m('user', 'Hi.')]);
    expect(out[1]).toBe(newChat);
    expect(rows(midSystemAsUser([m('user', 'Hi.'), N('n')]))).toEqual([`user|history+author_note|Hi.\n\n${SYSTEM_NOTE_PREFIX}n`]);
  });

  test('a user turn carrying tool results is never written into: the note goes back to the user before it', () => {
    const inp = [S, m('user', 'Roll for me.'), toolCall, N('Be fair.'), promptedResult];
    const out = midSystemAsUser(inp);
    expect(rows(out)[1]).toBe(`user|history+author_note|Roll for me.\n\n${SYSTEM_NOTE_PREFIX}Be fair.`);
    expect(out[2]).toBe(toolCall);
    expect(out[3]).toBe(promptedResult);
    // ...and when the user before it carries tool results too, the note stays a user message at its place
    const noPrev = midSystemAsUser([S, promptedResult, N('Be fair.'), { ...promptedResult, src: 'round:2' }]);
    expect(noPrev.map((x) => x.src)).toEqual(['main', 'round:1', 'author_note', 'round:2']);
    expect(rows(noPrev)[2]).toBe(`user|author_note|${SYSTEM_NOTE_PREFIX}Be fair.`);
    expect(noPrev[2]!.placement).toBe('inline');
  });

  test('with no user message anywhere after the lead, the note stays a user message of its own', () => {
    expect(rows(midSystemAsUser([S, m('assistant', 'Hello.'), N('n')]))).toEqual([
      'system|main|You are Mira.',
      'assistant|history|Hello.',
      `user|author_note|${SYSTEM_NOTE_PREFIX}n`,
    ]);
  });

  test('a blank note is dropped; the user message it would join is untouched', () => {
    const u = m('user', 'Hi.');
    const out = midSystemAsUser([S, m('assistant', 'Hello.'), N('  '), u]);
    expect(out).toHaveLength(3);
    expect(out[2]).toBe(u);
  });

  test('native and anthropic-native mid-system leave the list as it is (§8.5 placement is the adapter’s)', () => {
    const inp = [S, m('assistant', 'Hello.'), N('n'), m('user', 'Hi.')];
    for (const midSystem of ['native', 'anthropic-native'] as const) {
      const out = applyCapsRules(inp, caps({ midSystem }));
      expect(out).toEqual(inp);
      out.forEach((x, i) => expect(x).toBe(inp[i]!));
    }
  });
});

describe("alternation 'strict'", () => {
  test('consecutive same-role messages after the leading run are merged; the run itself is not', () => {
    const lead2 = m('system', 'Persona.', 'persona', 'head');
    const inp = [S, lead2, m('assistant', 'Hello.'), m('user', 'Hi.'), m('user', 'Be vivid.', 'jailbreak'), m('assistant', 'A1'), m('assistant', 'A2')];
    const out = applyCapsRules(inp, STRICT);
    expect(rows(out)).toEqual([
      'system|main|You are Mira.',
      'system|persona|Persona.',
      'assistant|history|Hello.',
      'user|history+jailbreak|Hi.\n\nBe vivid.',
      'assistant|history+history|A1\n\nA2',
    ]);
    expect(out[0]).toBe(S);
    expect(out[1]).toBe(lead2);
  });

  test('tool-carrying messages stay apart even when that breaks alternation', () => {
    const out = applyCapsRules([S, m('user', 'U'), m('assistant', 'Let me roll.'), toolCall], STRICT);
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(toolCall);
  });

  test('free alternation leaves neighbours apart', () => {
    const inp = [S, m('user', 'Hi.'), m('user', 'Be vivid.', 'jailbreak')];
    expect(applyCapsRules(inp, CAPS)).toEqual(inp);
  });

  test('as-user runs first: notes join their user turn, then strict merges what is left', () => {
    // a mid-dialogue system note between two user messages: as-user puts it in front of U2, strict merges U1 with that
    const inp = [S, m('assistant', 'Hello.'), m('user', 'U1'), N('n'), m('user', 'U2')];
    expect(rows(applyCapsRules(inp, ROUTER))).toEqual([
      'system|main|You are Mira.',
      'assistant|history|Hello.',
      `user|history+author_note+history|U1\n\n${SYSTEM_NOTE_PREFIX}n\n\nU2`,
    ]);
  });
});

describe('shape(): post-processing first, then the capability rules [D-48]', () => {
  const MIXED = [S, m('user', 'U1'), m('assistant', 'A1'), N('mid'), m('user', 'U3')];
  const input = (over: Partial<ShapeInput>): ShapeInput => ({ messages: MIXED, caps: ROUTER, prefill: null, kind: 'reply', ...over });

  test("semi already made the mid-system message user text, so as-user finds no note (no '[System note]')", () => {
    const out = shape(input({ postProcessing: 'semi' }));
    expect(rows(out.messages)).toEqual([
      'system|main|You are Mira.',
      'user|history|U1',
      'assistant|history|A1',
      'user|author_note+history|mid\n\nU3',
    ]);
    expect(out.notices).toEqual([]);
  });

  test('with no post-processing the caps rule handles the same message', () => {
    expect(rows(shape(input({})).messages).at(-1)).toBe(`user|author_note+history|${SYSTEM_NOTE_PREFIX}mid\n\nU3`);
  });

  test('the preset prefill still passes through (reply/swipe)', () => {
    const out = shape(input({ postProcessing: 'strict', prefill: 'Mira:', kind: 'swipe' }));
    expect(out.prefill).toBe('Mira:');
    expect(out.notices).toEqual([]);
  });

  test('the old M1a pass-through notice is gone', () => {
    for (const pp of ['merge', 'semi', 'strict', 'single'] as const) {
      expect(shape(input({ postProcessing: pp })).notices.map((n) => n.code)).not.toContain('post_processing_m1b');
    }
  });

  test('names reach single post-processing', () => {
    const out = shape(input({ postProcessing: 'single', names: { char: 'Mira', user: 'Levi' }, caps: CAPS }));
    expect(rows(out.messages)).toEqual(['user|main+history+history+author_note+history|You are Mira.\n\nLevi: U1\n\nMira: A1\n\nmid\n\nLevi: U3']);
  });
});

describe('continue under post-processing and caps (M1a behaviour kept)', () => {
  const target = m('assistant', 'The lamp swings.\n');
  const tail = m('assistant', 'Narrator:', 'preset:tail');
  const ph = N('Stay in character.', 'post_history');
  const base = [S, m('assistant', 'Evening.'), m('user', 'Any storms?')];

  test('the target is chosen before a merge could rename it (prefill mode)', () => {
    const out = shape({ messages: [...base, target, tail], caps: CAPS, prefill: null, kind: 'continue', postProcessing: 'merge' });
    expect(out.continueMode).toBe('prefill');
    expect(out.continueBase).toBe('The lamp swings.\n');
    expect(out.prefill).toBe('The lamp swings.');
    expect(rows(out.messages)).toEqual(rows([...base, tail]));
  });

  test('cue mode: the base is the target alone even when merge joins it with a following assistant block', () => {
    const out = shape({ messages: [...base, target, tail], caps: caps({ prefill: 'none' }), prefill: null, kind: 'continue', postProcessing: 'merge' });
    expect(out.continueMode).toBe('cue');
    expect(out.continueBase).toBe('The lamp swings.\n');
    expect(rows(out.messages).slice(-2)).toEqual([
      'assistant|history+preset:tail|The lamp swings.\n\n\nNarrator:',
      `user|${CONTINUE_CUE_SRC}|${CONTINUE_CUE}`,
    ]);
  });

  test('cue mode on an as-user model: a note after the target joins the cue', () => {
    const out = shape({ messages: [...base, target, ph], caps: { ...ROUTER, prefill: 'none' }, prefill: null, kind: 'continue' });
    expect(rows(out.messages).slice(-2)).toEqual([
      'assistant|history|The lamp swings.\n',
      `user|post_history+${CONTINUE_CUE_SRC}|${SYSTEM_NOTE_PREFIX}Stay in character.\n\n${CONTINUE_CUE}`,
    ]);
  });

  test('prefill mode on an as-user model: the target leaves, the note joins the user message before it', () => {
    const out = shape({ messages: [...base, target, ph], caps: ROUTER, prefill: null, kind: 'continue' });
    expect(out.prefill).toBe('The lamp swings.');
    expect(rows(out.messages).at(-1)).toBe(`user|history+post_history|Any storms?\n\n${SYSTEM_NOTE_PREFIX}Stay in character.`);
  });

  test('strict post-processing in cue mode: post_history becomes user and merges with the cue', () => {
    const out = shape({ messages: [...base, target, ph], caps: caps({ prefill: 'none' }), prefill: null, kind: 'continue', postProcessing: 'strict' });
    expect(rows(out.messages)).toEqual([
      'system|main|You are Mira.',
      `user|${'pp_placeholder'}|Let's get started.`,
      'assistant|history|Evening.',
      'user|history|Any storms?',
      'assistant|history|The lamp swings.\n',
      `user|post_history+${CONTINUE_CUE_SRC}|Stay in character.\n\n${CONTINUE_CUE}`,
    ]);
  });

  test('native caps and no post-processing: exactly the M1a output, message identity kept', () => {
    const msgs = [...base, target, ph];
    const p = shape({ messages: msgs, caps: CAPS, prefill: null, kind: 'continue' });
    expect(p.messages).toEqual([...base, ph]);
    p.messages.forEach((x, i) => expect(x).toBe([...base, ph][i]!));
    const c = shape({ messages: msgs, caps: caps({ prefill: 'none' }), prefill: null, kind: 'continue' });
    expect(c.messages.slice(0, 5)).toEqual(msgs);
    c.messages.slice(0, 5).forEach((x, i) => expect(x).toBe(msgs[i]!));
    expect(c.messages[5]).toEqual({ role: 'user', blocks: [{ k: 'text', text: CONTINUE_CUE }], src: CONTINUE_CUE_SRC, placement: 'inline' });
    expect(p.notices).toEqual([]);
    expect(c.notices).toEqual([]);
  });

  test('a missing target is still a caller bug', () => {
    expect(() => shape({ messages: [S, m('user', 'hi')], caps: ROUTER, prefill: null, kind: 'continue', postProcessing: 'single' })).toThrow();
  });

  test('the input list is never mutated', () => {
    const msgs = [...base, target, tail, ph];
    const copy = structuredClone(msgs);
    shape({ messages: msgs, caps: { ...ROUTER, prefill: 'none' }, prefill: null, kind: 'continue', postProcessing: 'strict' });
    shape({ messages: msgs, caps: ROUTER, prefill: 'x', kind: 'reply', postProcessing: 'single' });
    expect(msgs).toEqual(copy);
  });
});
