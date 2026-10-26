// prompt/tokens.ts: the M1 character estimate (§11), CHARS_COUNTER. The o200k default is tested in test/prompt-m2.
import { describe, expect, test } from 'bun:test';
import { CHARS_COUNTER, estimateBlock, estimateMessages, estimateTokens as estimate } from '../../src/prompt/tokens.ts';
import type { PromptMsg } from '../../src/providers/types.ts';

const estimateTokens = (text: string): number => estimate(text, CHARS_COUNTER);

describe('estimateTokens', () => {
  test('empty text is 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('Latin text: ceil(chars / 3)', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('a'.repeat(300))).toBe(100);
    expect(estimateTokens('a'.repeat(301))).toBe(101);
  });

  test('Cyrillic text: chars / 2.5', () => {
    expect(estimateTokens('ёжик')).toBe(2); // 4 / 2.5 = 1.6
    expect(estimateTokens('привет')).toBe(3); // 6 / 2.5 = 2.4
    expect(estimateTokens('я'.repeat(250))).toBe(100);
    expect(estimateTokens('Ѣ'.repeat(5))).toBe(2); // Cyrillic block beyond Russian
  });

  test('mixed text counts each class with its own divisor', () => {
    // 'Привет, мир!': 9 Cyrillic letters, 3 other characters → 9/2.5 + 3/3 = 4.6 → 5
    expect(estimateTokens('Привет, мир!')).toBe(5);
    // 300 Latin + 250 Cyrillic: exactly 100 + 100, no float rounding up
    expect(estimateTokens('a'.repeat(300) + 'я'.repeat(250))).toBe(200);
  });

  test('Cyrillic estimates higher than Latin of the same length', () => {
    expect(estimateTokens('я'.repeat(30))).toBeGreaterThan(estimateTokens('a'.repeat(30)));
  });
});

describe('estimateMessages', () => {
  test('adds 4 per message on top of the blocks', () => {
    const ms: PromptMsg[] = [
      { role: 'system', blocks: [{ k: 'text', text: 'abcabc' }], src: 'preset:main' },
      { role: 'user', blocks: [], src: 'history' },
    ];
    expect(estimateMessages(ms, CHARS_COUNTER)).toBe(2 + 4 + 0 + 4);
    expect(estimateMessages([], CHARS_COUNTER)).toBe(0);
  });

  test('counts reasoning and tool blocks', () => {
    const m: PromptMsg = {
      role: 'assistant',
      blocks: [
        { k: 'reasoning', text: 'abc' },
        { k: 'tool_call', id: 'c1', name: 'roll', args: '{"d":20}' },
        { k: 'text', text: 'ok' },
      ],
      src: 'history',
    };
    const tool: PromptMsg = {
      role: 'tool',
      blocks: [{ k: 'tool_result', callId: 'c1', name: 'roll', text: '17' }],
      src: 'history',
    };
    expect(estimateBlock(m.blocks[1]!, CHARS_COUNTER)).toBe(1 + 2 + 3);
    expect(estimateMessages([m], CHARS_COUNTER)).toBe(4 + 1 + 6 + 1);
    expect(estimateMessages([m, tool], CHARS_COUNTER)).toBe(12 + 4 + 1 + 2 + 1);
  });
});
