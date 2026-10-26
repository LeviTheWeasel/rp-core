// text/normalize.ts: the lore word character and spaceless scripts [D-46].
import { describe, expect, test } from 'bun:test';
import { charAt, charBefore, gluesToLoreKey, hasSpacelessScript, isLoreWordChar, LORE_WORD_CHAR_CLASS, WORD_CHAR_CLASS } from '../../src/text/normalize.ts';

describe('isLoreWordChar', () => {
  test('ASCII letters, digits and _ are word characters; punctuation and spaces are not', () => {
    for (const ch of ['a', 'Z', '0', '9', '_']) expect([ch, isLoreWordChar(ch)]).toEqual([ch, true]);
    for (const ch of [' ', '-', "'", '.', '\n', '+', '\u0000']) expect([ch, isLoreWordChar(ch)]).toEqual([ch, false]);
  });

  test('Unicode letters, digits and combining marks are word characters', () => {
    for (const ch of ['ж', 'Ё', 'é', 'Ω', '龍', 'ね', '٣', '́', '̆', '\u{10400}']) {
      expect([ch, isLoreWordChar(ch)]).toEqual([ch, true]);
    }
  });

  test('emoji, quotes and dashes are not; only one code point is judged', () => {
    for (const ch of ['\u{1F409}', '«', '»', '“', '—', '…', 'ab', '']) expect([ch, isLoreWordChar(ch)]).toEqual([ch, false]);
  });

  test('the class constants', () => {
    expect(WORD_CHAR_CLASS).toBe('\\p{L}\\p{N}\\p{M}');
    expect(LORE_WORD_CHAR_CLASS).toBe('\\p{L}\\p{N}\\p{M}_');
  });
});

describe('hasSpacelessScript', () => {
  test('Han, Hiragana, Katakana and Thai letters', () => {
    for (const t of ['龍', 'ねこ', 'ネコ', 'แมว', 'a 龍 b', 'ー']) expect([t, hasSpacelessScript(t)]).toEqual([t, true]);
  });

  test('Latin, Cyrillic, Hangul, CJK punctuation alone are not', () => {
    for (const t of ['cat', 'мир', '하나', '。', '、', '「」', '']) expect([t, hasSpacelessScript(t)]).toEqual([t, false]);
  });
});

describe('gluesToLoreKey, charBefore, charAt', () => {
  test('lore word characters glue, except letters of spaceless scripts', () => {
    for (const ch of ['a', '_', '7', 'ж', '\u0301', '\u{10400}', '하']) expect([ch, gluesToLoreKey(ch)]).toEqual([ch, true]);
    for (const ch of ['龍', 'ね', 'ネ', 'ー', 'แ', ' ', '-', '', '\u{1F409}']) expect([ch, gluesToLoreKey(ch)]).toEqual([ch, false]);
  });

  test('surrogate pairs are read whole on both sides', () => {
    const t = 'x\u{10400}y';
    expect(charBefore(t, 3)).toBe('\u{10400}');
    expect(charBefore(t, 1)).toBe('x');
    expect(charBefore(t, 0)).toBe('');
    expect(charAt(t, 1)).toBe('\u{10400}');
    expect(charAt(t, 3)).toBe('y');
    expect(charAt(t, 4)).toBe('');
  });
});
