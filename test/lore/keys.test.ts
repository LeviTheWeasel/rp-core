// Ported from Bunraku:src/core/lore/engine/key-word-boundary.test.ts and triggers-keyword.test.ts@702d8120 (boundary and keyword cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lore/keys.ts: literal and '/re/' keys, the Unicode boundary [D-46], secondary logic.
// Boundary and keyword cases ported from Bunraku src/core/lore/engine/key-word-boundary.test.ts and
// triggers-keyword.test.ts @702d8120, rewritten onto KeyMatcher (see .notes/m2-provenance-lore.md).
import { describe, expect, test } from 'bun:test';
import { KeyMatcher, parseRegexKey, secondaryPasses, type KeyOptions } from '../../src/lore/keys.ts';

const WW: KeyOptions = { caseSensitive: false, wholeWords: true };
const SUB: KeyOptions = { caseSensitive: false, wholeWords: false };
const CS: KeyOptions = { caseSensitive: true, wholeWords: true };

const hits = (key: string, text: string, opts: KeyOptions = WW): boolean => new KeyMatcher().match([key], text, opts).matched.length === 1;

describe('parseRegexKey (ST parseRegexFromString)', () => {
  test('/pattern/flags splits; flags limited to gimsuy', () => {
    expect(parseRegexKey('/drag(on|ons)/i')).toEqual({ source: 'drag(on|ons)', flags: 'i' });
    expect(parseRegexKey('/a.b/')).toEqual({ source: 'a.b', flags: '' });
    expect(parseRegexKey('/x/gimsuy')).toEqual({ source: 'x', flags: 'gimsuy' });
    expect(parseRegexKey('/x/q')).toBeNull();
  });

  test('not a regex: no delimiters, empty pattern, an unescaped slash inside', () => {
    expect(parseRegexKey('dragon')).toBeNull();
    expect(parseRegexKey('//')).toBeNull();
    expect(parseRegexKey('/a/b/')).toBeNull();
    expect(parseRegexKey('/dragon')).toBeNull();
  });

  test('escaped slashes are unescaped, every one of them', () => {
    expect(parseRegexKey('/a\\/b\\/c/')).toEqual({ source: 'a/b/c', flags: '' });
  });

  test('syntax is not judged here: re2js reports it', () => {
    expect(parseRegexKey('/(?<=a)b/')).toEqual({ source: '(?<=a)b', flags: '' });
    expect(parseRegexKey('/(abc/')).toEqual({ source: '(abc', flags: '' });
  });
});

describe('literal keys: whole words with a Unicode boundary', () => {
  test("Cyrillic: 'мир' does not match inside 'мирный'", () => {
    expect(hits('мир', 'мирный город')).toBe(false);
    expect(hits('мир', 'весь мир, привет')).toBe(true);
  });

  test("'Мира' matches 'мира' case-insensitively, not case-sensitively", () => {
    expect(hits('Мира', 'у мира нет краёв')).toBe(true);
    expect(hits('Мира', 'у мира нет краёв', CS)).toBe(false);
    expect(hits('Мира', 'у Мира нет краёв', CS)).toBe(true);
  });

  test("'_' is a word character", () => {
    expect(hits('мир', 'мир_два')).toBe(false);
    expect(hits('cat', 'cat_')).toBe(false);
    expect(hits('cat', '_cat')).toBe(false);
  });

  test('a decomposed й (NFD) matches a composed one, both ways', () => {
    const composed = 'Мой';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(hits(composed, `это ${decomposed} дом`)).toBe(true);
    expect(hits(decomposed, `это ${composed} дом`)).toBe(true);
    expect(hits('мой', `${decomposed}ка`)).toBe(false);
  });

  test('CJK keys match as substrings; Latin keys inside running CJK text still match', () => {
    expect(hits('龍', '巨龍王')).toBe(true);
    expect(hits('龍', 'x龍')).toBe(true);
    expect(hits('ねこ', 'これはねこです')).toBe(true);
    expect(hits('แมว', 'ฉันมีแมวสองตัว')).toBe(true);
    expect(hits('cat', '龍cat城')).toBe(true);
    expect(hits('cat', '龍category')).toBe(false);
  });

  test('a multi-word key matches as a substring even with whole words on (ST)', () => {
    expect(hits('New York', 'I live in New York City')).toBe(true);
    expect(hits('New York', 'a New Yorker')).toBe(true);
    expect(hits('Ева Браун', 'это Ева Браун.')).toBe(true);
    expect(hits('new york', 'NEW YORK')).toBe(true);
  });

  test('case-sensitive literal', () => {
    expect(hits('Dragon', 'a dragon appeared', { caseSensitive: true, wholeWords: false })).toBe(false);
    expect(hits('Dragon', 'a Dragon appeared', CS)).toBe(true);
  });

  test('whole words off: plain substring, case-insensitive by default', () => {
    expect(hits('dragon', 'A Dragonfly', SUB)).toBe(true);
    expect(hits('cat', 'concatenate', SUB)).toBe(true);
    expect(hits('cat', 'concatenate')).toBe(false);
  });

  test('keys are trimmed; blank keys never match; matched keys come back as written, in key order', () => {
    const m = new KeyMatcher().match(['  cat ', '', '   ', 'dog', 'eel'], 'dog and cat', WW);
    expect(m.matched).toEqual(['  cat ', 'dog']);
    expect(m.regexErrors).toEqual([]);
  });

  test('regex metacharacters in a literal are text', () => {
    expect(hits('C++', 'I write C++ daily')).toBe(true);
    expect(hits('a.b', 'axb')).toBe(false);
    expect(hits('(x)', 'see (x) here')).toBe(true);
    expect(hits('$5', 'pay $5 now')).toBe(true);
  });
});

// Bunraku key-word-boundary.test.ts cases (whole words, case-insensitive), with the core's answers.
describe('Unicode boundary cases (from Bunraku)', () => {
  const cases: [string, string, string, boolean][] = [
    ['Cyrillic inside a longer word', 'Ева', 'Евангелие', false],
    ['Cyrillic suffix glued', 'Ева', 'праЕва', false],
    ['Cyrillic as a whole word', 'Ева', 'Это Ева, привет', true],
    ['Cyrillic case-insensitive', 'ева', 'ЕВА пришла', true],
    ['Greek upper vs lower with final sigma', 'ΟΔΟΣ', 'η οδος', true],
    ['Turkish dotted capital I', 'İstanbul', 'ISTANBUL İSTANBUL', true],
    ['Cyrillic at string start', 'Ева', 'Ева ушла', true],
    ['Cyrillic at string end', 'Ева', 'пришла Ева', true],
    ['Greek inside a longer word', 'Αθήνα', 'ΑθήναΙοι', false],
    ['Greek whole word', 'Αθήνα', 'στην Αθήνα.', true],
    ['accented Latin key at a real edge', 'café', 'un café, merci', true],
    ['accented Latin key inside a longer word', 'café', 'cafétéria', false],
    ['ASCII key glued to an accented letter', 'cafe', 'cafés', false],
    ['ASCII key before a decomposed accent', 'cafe', 'café noir', false],
    ['accented letter before the key', 'Eve', 'éEve', false],
    ['Hangul inside a longer word', '하나', '하나님', false],
    ['Hangul with a space', '하나', '하나 둘', true],
    ['digit neighbour', 'Ева', 'Ева2', false],
    ['punctuation edges', 'Ева', '(Ева)', true],
    ['quotes and ellipsis edges', 'Ева', '“Ева”…', true],
    ['guillemets', 'Ева', '«Ева»', true],
    ['apostrophe is a boundary', 'Ева', "Ева's", true],
    ['hyphen is a boundary', 'Ева', 'Ева-два', true],
    ['supplementary-plane letter glued', 'a', '\u{10400}a', false],
    ['emoji neighbour is a boundary', 'Ева', '\u{1F409}Ева\u{1F409}', true],
    ['Katakana long-vowel mark next to a Katakana key', 'ネコ', 'ネコー', true],
  ];
  for (const [name, key, text, expected] of cases) test(name, () => expect(hits(key, text)).toBe(expected));
});

// ST's (?:^|\W)key(?:$|\W) for single-word ASCII keys: the core's boundary gives the same answers.
describe('ASCII single-word keys agree with the old \\W rule', () => {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keys = ['cat', 'Cat', 'C++', "o'clock", 'a-b', 'x_y', '1999', '.'];
  const texts = [
    '', 'cat', 'Cat', 'CAT', 'the cat sat', 'concat', 'catalog', "cat's", 'cat_', '_cat', 'cat-cat', 'cat.', '(cat)', 'cat2', '2cat',
    'C++ and C+++', 'c++', 'xC++', "o'clock", "at o'clock sharp", "no'clock", 'a-b', 'a-bc', 'ca-b', 'x_y', 'x_yz', 'in 1999.',
    '11999', '.', 'a.b', 'tab\tcat\nline', '\u{1F409}cat\u{1F409}', 'cat\u{1F409}', 'e',
  ];
  for (const key of keys) {
    for (const caseSensitive of [false, true]) {
      test(`${JSON.stringify(key)} caseSensitive=${caseSensitive}`, () => {
        const legacy = new RegExp(String.raw`(?:^|\W)${esc(key)}(?:$|\W)`, caseSensitive ? '' : 'i');
        for (const text of texts) {
          expect([key, text, hits(key, text, { caseSensitive, wholeWords: true })]).toEqual([key, text, legacy.test(text)]);
        }
      });
    }
  }
});

describe("'/re/flags' keys through re2js", () => {
  test('flags: none is case-sensitive, i ignores case, whatever the entry says', () => {
    expect(hits('/DRAGON/', 'a dragon appeared', SUB)).toBe(false);
    expect(hits('/DRAGON/i', 'a dragon appeared', CS)).toBe(true);
    expect(hits('/drag(on|ons)\\b/i', 'Two DRAGONS.')).toBe(true);
  });

  test('s makes . match a newline; m anchors ^ and $ at lines', () => {
    expect(hits('/a.b/', 'a\nb')).toBe(false);
    expect(hits('/a.b/s', 'a\nb')).toBe(true);
    expect(hits('/^foo$/', 'x\nfoo\ny')).toBe(false);
    expect(hits('/^foo$/m', 'x\nfoo\ny')).toBe(true);
  });

  test('g, u and y are ignored; repeated calls give the same answer', () => {
    const km = new KeyMatcher();
    const results = [1, 2, 3, 4].map(() => km.match(['/OOC/gi'], 'hello (OOC: hi)', WW).matched.length);
    expect(results).toEqual([1, 1, 1, 1]);
    expect(hits('/dragon/y', 'a dragon appeared')).toBe(true);
    expect(hits('/\\p{L}+/u', 'мир')).toBe(true);
  });

  test('a regex sees the NFC text and Unicode case folding', () => {
    expect(hits('/мой/i', 'МОЙ'.normalize('NFD'))).toBe(true);
  });

  test('a broken regex falls back to its pattern as a literal and reports the error', () => {
    const m = new KeyMatcher().match(['/(abc/'], 'see (abc here', WW);
    expect(m.matched).toEqual(['/(abc/']);
    expect(m.regexErrors).toHaveLength(1);
    expect(m.regexErrors[0]?.key).toBe('/(abc/');
    expect(m.regexErrors[0]?.message).toContain('missing closing');
    expect(new KeyMatcher().match(['/(abc/'], 'abc', WW).matched).toEqual([]);
  });

  test('lookbehind and lookahead are not supported: regexErrors, literal fallback', () => {
    const m = new KeyMatcher().match(['/(?<=a)b/', '/b(?!c)/'], 'ab bc', WW);
    expect(m.regexErrors.map((e) => e.key)).toEqual(['/(?<=a)b/', '/b(?!c)/']);
    expect(m.matched).toEqual([]);
    expect(new KeyMatcher().match(['/(?<=a)b/'], 'text with (?<=a)b in it', SUB).matched).toEqual(['/(?<=a)b/']);
  });

  test('a regex key that compiles reports no error; a catastrophic shape stays linear', () => {
    const m = new KeyMatcher().match(['/(a+)+$/'], `${'a'.repeat(5000)}!`, WW);
    expect(m.regexErrors).toEqual([]);
    expect(m.matched).toEqual([]);
  });

  test('the compile cache keeps answers per options', () => {
    const km = new KeyMatcher();
    expect(km.match(['Dragon'], 'dragon', CS).matched).toEqual([]);
    expect(km.match(['Dragon'], 'dragon', WW).matched).toEqual(['Dragon']);
    expect(km.match(['/(x/'], '(x', SUB).matched).toEqual(['/(x/']);
    expect(km.match(['/(x/'], 'a(xb', WW).matched).toEqual([]);
  });
});

describe('secondaryPasses (ST selective logic)', () => {
  const table: [Parameters<typeof secondaryPasses>[0], number, number, boolean][] = [
    ['and_any', 0, 2, false],
    ['and_any', 1, 2, true],
    ['and_any', 2, 2, true],
    ['and_all', 0, 2, false],
    ['and_all', 1, 2, false],
    ['and_all', 2, 2, true],
    ['not_any', 0, 2, true],
    ['not_any', 1, 2, false],
    ['not_any', 2, 2, false],
    ['not_all', 0, 2, true],
    ['not_all', 1, 2, true],
    ['not_all', 2, 2, false],
    ['and_any', 0, 0, true],
    ['and_all', 0, 0, true],
    ['not_any', 0, 0, true],
    ['not_all', 0, 0, true],
  ];
  for (const [logic, matched, total, expected] of table) {
    test(`${logic} ${matched}/${total} → ${expected}`, () => expect(secondaryPasses(logic, matched, total)).toBe(expected));
  }
});
