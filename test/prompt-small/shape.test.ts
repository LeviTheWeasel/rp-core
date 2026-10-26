// prompt/shape.ts (M1a): prefill by caps.prefill, continue in both modes, continuationResult.
import { describe, expect, test } from 'bun:test';
import { CONTINUE_CUE, continuationResult, shape, type ShapeInput } from '../../src/prompt/shape.ts';
import type { ModelCaps, PromptMsg } from '../../src/providers/types.ts';

const caps = (prefill: ModelCaps['prefill']): ModelCaps => ({ prefill }) as unknown as ModelCaps;
const m = (role: PromptMsg['role'], text: string, src = 'history'): PromptMsg => ({ role, blocks: [{ k: 'text', text }], src });
const sys = m('system', 'You are Vera.', 'preset:main');
const input = (over: Partial<ShapeInput>): ShapeInput => ({
  messages: [sys, m('assistant', 'Evening.'), m('user', 'Any storms?')],
  caps: caps('assistant-last'),
  prefill: null,
  kind: 'reply',
  ...over,
});

describe('shape: reply and swipe', () => {
  test('passes messages through and sends the prefill when the model takes one', () => {
    const inp = input({ prefill: 'Vera:' });
    const out = shape(inp);
    expect(out.messages).toEqual(inp.messages);
    expect(out.messages).not.toBe(inp.messages);
    expect(out.prefill).toBe('Vera:');
    expect(out.notices).toEqual([]);
    expect(out.continueMode).toBeUndefined();
    expect(shape(input({ prefill: 'Vera:', caps: caps('prefix-flag'), kind: 'swipe' })).prefill).toBe('Vera:');
  });

  test('no prefill, no field', () => {
    const out = shape(input({}));
    expect('prefill' in out).toBe(false);
    expect(out.notices).toEqual([]);
  });

  test('a model without prefill drops it with prefill_unsupported', () => {
    const out = shape(input({ prefill: 'Vera:', caps: caps('none') }));
    expect(out.prefill).toBeUndefined();
    expect(out.notices.map((n) => n.code)).toEqual(['prefill_unsupported']);
    expect(out.messages).toHaveLength(3);
    // nothing to drop, nothing to say
    expect(shape(input({ caps: caps('none') })).notices).toEqual([]);
  });

  test('post-processing other than none passes through with post_processing_m1b', () => {
    const inp = input({ postProcessing: 'strict' });
    const out = shape(inp);
    expect(out.messages).toEqual(inp.messages);
    expect(out.notices.map((n) => n.code)).toEqual(['post_processing_m1b']);
    expect(shape(input({ postProcessing: 'none' })).notices).toEqual([]);
  });
});

describe('shape: continue', () => {
  const target = m('assistant', 'The lamp swings.\n');
  const msgs = [sys, m('assistant', 'Evening.'), m('user', 'Any storms?'), target];

  test('prefill mode: the target leaves the list and becomes the prefill', () => {
    const out = shape(input({ kind: 'continue', messages: msgs, prefill: 'ignored' }));
    expect(out.continueMode).toBe('prefill');
    expect(out.continueBase).toBe('The lamp swings.\n');
    expect(out.prefill).toBe('The lamp swings.'); // trailing whitespace not sent
    expect(out.messages).toEqual(msgs.slice(0, 3));
    expect(out.notices).toEqual([]);
  });

  test('cue mode: the target stays and a user cue follows', () => {
    const out = shape(input({ kind: 'continue', messages: msgs, caps: caps('none') }));
    expect(out.continueMode).toBe('cue');
    expect(out.continueBase).toBe('The lamp swings.\n');
    expect(out.prefill).toBeUndefined();
    expect(out.messages).toHaveLength(5);
    expect(out.messages[3]).toBe(target);
    expect(out.messages[4]).toEqual({
      role: 'user',
      blocks: [{ k: 'text', text: CONTINUE_CUE }],
      src: 'continue_cue',
      placement: 'inline',
    });
    expect(CONTINUE_CUE).toBe(
      'Continue your last reply from exactly where it stopped. Do not repeat what was already written.',
    );
    expect(out.notices).toEqual([]);
  });

  test('blocks after the history (post-history, depth 0) stay; the target is found above them', () => {
    const after = m('system', 'Stay in character.', 'post_history');
    const withTail = [...msgs, after];
    const p = shape(input({ kind: 'continue', messages: withTail }));
    expect(p.messages).toEqual([...msgs.slice(0, 3), after]);
    expect(p.prefill).toBe('The lamp swings.');
    const c = shape(input({ kind: 'continue', messages: withTail, caps: caps('none') }));
    expect(c.messages.slice(3, 5)).toEqual([target, after]);
    expect(c.messages.at(-1)!.src).toBe('continue_cue');
    // an assistant-role block after history does not steal the target from a history message
    const fake = m('assistant', 'Narrator:', 'preset:tail');
    expect(shape(input({ kind: 'continue', messages: [...msgs, fake] })).continueBase).toBe('The lamp swings.\n');
  });

  test('base is the text blocks only; reasoning is not reply text', () => {
    const t: PromptMsg = {
      role: 'assistant',
      blocks: [{ k: 'reasoning', text: 'hmm' }, { k: 'text', text: 'One. ' }, { k: 'text', text: 'Two.' }],
      src: 'history',
    };
    expect(shape(input({ kind: 'continue', messages: [sys, t] })).continueBase).toBe('One. Two.');
  });

  test('a missing target is a caller bug', () => {
    expect(() => shape(input({ kind: 'continue', messages: [sys, m('user', 'hi')] }))).toThrow();
  });

  test('post-processing notice on continue too', () => {
    const out = shape(input({ kind: 'continue', messages: msgs, postProcessing: 'merge' }));
    expect(out.notices.map((n) => n.code)).toEqual(['post_processing_m1b']);
  });
});

describe('continuationResult', () => {
  const base = 'The lamp swings.';

  test('a clean continuation is glued as-is (prefill) or after a blank line (cue)', () => {
    expect(continuationResult(base, ' Then it stops.', 'prefill')).toEqual({
      addition: ' Then it stops.',
      full: 'The lamp swings. Then it stops.',
    });
    expect(continuationResult(base, 'Then it stops.', 'cue')).toEqual({
      addition: 'Then it stops.',
      full: 'The lamp swings.\n\nThen it stops.',
    });
  });

  test('a full echo of the base is stripped, trimmed or not', () => {
    expect(continuationResult(base, 'The lamp swings. Then it stops.', 'prefill').addition).toBe(' Then it stops.');
    expect(continuationResult('The lamp swings.\n\n', 'The lamp swings.\n\nThen it stops.', 'prefill')).toEqual({
      addition: 'Then it stops.',
      full: 'The lamp swings.\n\nThen it stops.',
    });
    expect(continuationResult('The lamp swings.\n\n', 'The lamp swings.Then it stops.', 'prefill').addition).toBe(
      'Then it stops.',
    );
    expect(continuationResult(base, 'The lamp swings.\n\nThen it stops.', 'cue')).toEqual({
      addition: 'Then it stops.',
      full: 'The lamp swings.\n\nThen it stops.',
    });
  });

  test('the base trailing whitespace is not doubled', () => {
    expect(continuationResult('The lamp swings.\n\n', '\n\nThen it stops.', 'prefill').addition).toBe('Then it stops.');
    expect(continuationResult('The lamp swings.\n\n', 'Then it stops.', 'cue').full).toBe(
      'The lamp swings.\n\nThen it stops.',
    );
  });

  test('a long echoed suffix of the base is stripped', () => {
    const long = 'She waited by the window. The storm rolled in over the hills';
    expect(continuationResult(long, 'The storm rolled in over the hills, and the lamp went out.', 'prefill')).toEqual({
      addition: ', and the lamp went out.',
      full: long + ', and the lamp went out.',
    });
    expect(continuationResult(long + '.', 'The storm rolled in over the hills. Thunder followed.', 'cue').addition).toBe(
      'Thunder followed.',
    );
  });

  test('a short coincidental overlap is not an echo', () => {
    const b = 'She looked at the';
    expect(continuationResult(b, 'the door.', 'prefill').addition).toBe('the door.');
    // suffix starting mid-word is never an echo
    const w = 'It was a remarkably quiet afternoon in town';
    expect(continuationResult(w, 'arkably quiet afternoon in town again', 'prefill').addition).toBe(
      'arkably quiet afternoon in town again',
    );
  });

  test('nothing new: addition is empty and full is the base', () => {
    expect(continuationResult(base, '', 'prefill')).toEqual({ addition: '', full: base });
    expect(continuationResult(base, base, 'prefill')).toEqual({ addition: '', full: base });
    expect(continuationResult(base, base, 'cue')).toEqual({ addition: '', full: base });
    expect(continuationResult('The lamp swings.\n', 'The lamp swings.\n', 'prefill').addition).toBe('');
    expect(continuationResult(base, '  \n', 'cue')).toEqual({ addition: '', full: base });
  });

  test('an empty base takes the addition alone', () => {
    expect(continuationResult('', 'Hello.', 'cue')).toEqual({ addition: 'Hello.', full: 'Hello.' });
    expect(continuationResult('', 'Hello.', 'prefill')).toEqual({ addition: 'Hello.', full: 'Hello.' });
  });
});
