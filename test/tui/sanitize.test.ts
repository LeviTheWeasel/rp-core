import { describe, expect, test } from 'bun:test';
import { labels } from '../../src/cli/repl-render.ts';
import { createSanitizer, displayLabels, sanitize } from '../../src/cli/tui/sanitize.ts';

const plain = { warp: false };
const warp = { warp: true };

/** Every split of `s` into two deltas gives what sanitize() gives for the whole. */
function splitsAgree(s: string, o = plain): void {
  const whole = sanitize(s, o);
  for (let i = 0; i <= s.length; i++) {
    const z = createSanitizer(o);
    expect(z.push(s.slice(0, i)) + z.push(s.slice(i)) + z.end()).toBe(whole);
  }
}

describe('sanitize (T-10)', () => {
  test('plain text, Cyrillic, CJK and emoji pass unchanged', () => {
    const s = 'Привет, брат! 漢字 😀 "quoted" *action*\nsecond line';
    expect(sanitize(s, plain)).toBe(s);
  });

  test('controls go except \\n; \\t becomes two spaces; \\r\\n becomes \\n', () => {
    expect(sanitize('a\tb\r\nc\x00d\x07e\x08f\x7fg\u0085h\u009ci', plain)).toBe('a  b\ncdefghi');
  });

  test('whole escape sequences go, not only the ESC', () => {
    expect(sanitize('\x1b[31mred\x1b[0m plain', plain)).toBe('red plain');
    expect(sanitize('a\x1b[1;2;3Hb', plain)).toBe('ab');
    expect(sanitize('a\x1b]0;title\x07b', plain)).toBe('ab');
    expect(sanitize('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b', plain)).toBe('alinkb');
    expect(sanitize('a\x1bPq#0;2;0;0;0\x1b\\b', plain)).toBe('ab');
    expect(sanitize('a\x1b(Bb\x1b7c\x1bcd', plain)).toBe('abcd');
    expect(sanitize('a\u009b31mb\u009d0;t\u0007c', plain)).toBe('abc');
  });

  test('a malformed CSI drops what it consumed and keeps the byte that ended it', () => {
    expect(sanitize('a\x1b[12\nb', plain)).toBe('a\nb');
    expect(sanitize('a\x1b[1é', plain)).toBe('aé');
  });

  test('an unterminated sequence at the end is dropped; a runaway one only loses its introducer', () => {
    expect(sanitize('text\x1b[3', plain)).toBe('text');
    expect(sanitize('text\x1b]0;never ends', plain)).toBe('text');
    const long = 'x'.repeat(300);
    expect(sanitize(`a\x1b]${long}`, plain)).toBe(`a]${long}`);
  });

  test('lone surrogates are dropped, pairs kept', () => {
    expect(sanitize('a\ud83db\ude00c😀', plain)).toBe('abc😀');
  });

  test('warp drops ZWJ, VS16 and skin tones; without warp they stay', () => {
    const family = '👨‍👩‍👧';
    const heart = '❤️';
    const thumb = '👍🏽';
    expect(sanitize(`${family} ${heart} ${thumb}`, warp)).toBe('👨👩👧 ❤ 👍');
    expect(sanitize(`${family} ${heart} ${thumb}`, plain)).toBe(`${family} ${heart} ${thumb}`);
  });

  test('stream: an ESC split across deltas is held, then dropped whole', () => {
    const z = createSanitizer(plain);
    expect(z.push('before \x1b')).toBe('before ');
    expect(z.push('[3')).toBe('');
    expect(z.push('1mred')).toBe('red');
    expect(z.push('\x1b]0;ti')).toBe('');
    expect(z.push('tle\x07 after')).toBe(' after');
    expect(z.end()).toBe('');
  });

  test('stream: a surrogate pair split across deltas', () => {
    const z = createSanitizer(warp);
    const thumb = '👍🏽';
    expect(z.push(`ok ${thumb.slice(0, 1)}`)).toBe('ok ');
    expect(z.push(thumb.slice(1, 3))).toBe('👍');
    expect(z.push(thumb.slice(3))).toBe('');
    expect(z.push('!')).toBe('!');
  });

  test('stream: every split agrees with the whole', () => {
    splitsAgree('a\x1b[1;33mб\x1b]0;t\x07в\tг\r\n\u009b2m😀\x1b(Bд\x1b');
    splitsAgree('👨‍👩 ❤️ 👍🏽 \x1b[0m', warp);
  });

  test('U+2028 / U+2029 become line breaks (T-16), whole or streamed', () => {
    expect(sanitize('a\u2028b\u2029c', plain)).toBe('a\nb\nc');
    splitsAgree('one\u2028two\u2029\x1b[1mthree');
  });
});

describe('displayLabels (T-16: columns, not UTF-16 units)', () => {
  test('ASCII names: what the REPL\'s labels() gives', () => {
    for (const name of ['Mira', 'Al', '', '  ', 'A very long character name indeed', 'Seraphina']) {
      expect(displayLabels(name, plain)).toEqual(labels(name));
    }
  });

  test('wide names are padded and cut by columns; a cut never splits a grapheme', () => {
    expect(displayLabels('美咲', plain)).toEqual({ char: '美咲', user: 'you ', width: 4 });
    const long = displayLabels('天野美咲天野美咲天野美咲', plain);
    expect(long.width).toBe(16);
    expect(long.char).toBe('天野美咲天野美… ');
    expect(Bun.stringWidth(long.char)).toBe(16);
    expect(Bun.stringWidth(long.user)).toBe(16);
    const emoji = displayLabels('Mira the 👨‍👩‍👧 Wanderer of Sands', plain);
    expect(emoji.char).toBe('Mira the 👨‍👩‍👧 Wan…');
    expect(Bun.stringWidth(emoji.char)).toBe(16);
    // No lone surrogate anywhere.
    for (const name of ['😀😀😀😀😀😀😀😀😀😀', 'aaaaaaaaaaaaaaa😀']) {
      expect(displayLabels(name, plain).char).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  test('a card file\'s name is sanitised: escapes, controls, line breaks; Warp drops ZWJ / VS16', () => {
    expect(displayLabels('Mira\x1b[31m\nRed\x07', plain).char).toBe('Mira Red');
    expect(displayLabels('Ann 👨‍👩‍👧', warp).char).toBe('Ann 👨👩👧');
    expect(displayLabels('\x1b]0;x\x07', plain).char).toBe('them');
  });
});
