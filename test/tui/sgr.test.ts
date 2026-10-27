import { describe, expect, test } from 'bun:test';
import { TextAttributes, type TextChunk } from '@opentui/core';
import { createProseStyler, makeStyle, SGR } from '../../src/cli/repl-render.ts';
import { appendChunks, chunk, createSgrReader, sgrToChunks } from '../../src/cli/tui/sgr.ts';
import { MONO_THEME, THEME } from '../../src/cli/tui/theme.ts';

const style = makeStyle(true);

/** A chunk as a short description: text, attributes, colour (none shown for the default foreground; `NO FG` if unset). */
function d(c: TextChunk): string {
  const a = c.attributes ?? 0;
  const attrs = [
    a & TextAttributes.BOLD ? 'b' : '',
    a & TextAttributes.DIM ? 'd' : '',
    a & TextAttributes.ITALIC ? 'i' : '',
  ].join('');
  const fg = !c.fg
    ? 'NO FG'
    : c.fg.equals(THEME.text)
      ? ''
      : c.fg.equals(THEME.yellow)
        ? 'yellow'
        : c.fg.equals(THEME.red)
          ? 'red'
          : c.fg.toString();
  return [c.text, attrs, fg].filter((x) => x !== '').join('|');
}

const ds = (s: string, theme = THEME): string[] => sgrToChunks(s, theme).map(d);

/** Chunks back to SGR in the Repl's closed set (the round trip). */
function toSgr(chunks: TextChunk[]): string {
  let out = '';
  for (const c of chunks) {
    const a = c.attributes ?? 0;
    let s = c.text;
    if (a & TextAttributes.ITALIC) s = `${SGR.italicOn}${s}${SGR.italicOff}`;
    if (a & TextAttributes.DIM) s = `${SGR.dimOn}${s}${SGR.intensityOff}`;
    if (a & TextAttributes.BOLD) s = `${SGR.boldOn}${s}${SGR.intensityOff}`;
    if (c.fg?.equals(THEME.yellow)) s = `${SGR.yellow}${s}${SGR.fgOff}`;
    if (c.fg?.equals(THEME.red)) s = `${SGR.red}${s}${SGR.fgOff}`;
    out += s;
  }
  return out;
}

describe('sgrToChunks', () => {
  test('plain text: one chunk, no attributes, the terminal\'s default foreground set explicitly (T-12)', () => {
    expect(sgrToChunks('hello', THEME)).toEqual([{ __isChunk: true, text: 'hello', fg: THEME.text }]);
    expect(sgrToChunks('hello', THEME)[0]!.fg!.intent).toBe('default');
  });

  test('each code of the closed set', () => {
    expect(ds(style.bold('B'))).toEqual(['B|b']);
    expect(ds(style.dim('D'))).toEqual(['D|d']);
    expect(ds(`${SGR.italicOn}I${SGR.italicOff}x`)).toEqual(['I|i', 'x']);
    expect(ds(style.yellow('Y'))).toEqual(['Y|yellow']);
    expect(ds(style.red('R'))).toEqual(['R|red']);
    expect(ds(`${SGR.boldOn}a${SGR.dimOn}b${SGR.intensityOff}c`)).toEqual(['a|b', 'b|bd', 'c']);
    expect(ds(`${SGR.red}a${SGR.fgOff}b`)).toEqual(['a|red', 'b']);
    expect(ds('\x1b[1;3;33mx\x1b[0my\x1b[mz')).toEqual(['x|bi|yellow', 'yz']);
  });

  test('combinations as the Repl nests them', () => {
    expect(ds(style.yellow(style.bold('warn')))).toEqual(['warn|b|yellow']);
    expect(ds(style.dim(`  [${style.red('x')}]`))).toEqual(['  [|d', 'x|d|red', ']|d']);
    expect(ds(`${style.bold('Mira')} › ${SGR.italicOn}*waves*${SGR.italicOff} "hi"`)).toEqual(['Mira|b', ' › ', '*waves*|i', ' "hi"']);
  });

  test('round trip: Repl strings → chunks → SGR → the same chunks', () => {
    const samples = [
      style.bold('a'),
      style.dim('b'),
      style.yellow('c'),
      style.red('d'),
      `${style.bold('Mira')} › ${createProseStyler(true).push('*smiles* "hello" *nods*')}`,
      style.dim(`  [swipe 2/3 · 300 tok · 13.3s · length]   /r swipe`),
      `${style.yellow('! warn')}\n${style.red('✗ failed')}\nplain`,
    ];
    for (const s of samples) {
      const chunks = sgrToChunks(s, THEME);
      expect(sgrToChunks(toSgr(chunks), THEME)).toEqual(chunks);
      expect(chunks.map((c) => c.text).join('')).toBe(s.replace(/\x1b\[[0-9;]*m/g, ''));
    }
  });

  test('unknown sequences are dropped, never shown; text between them is sanitised', () => {
    expect(ds('a\x1b[4mb\x1b[38;5;1mc\x1b[2Jd\x1b]0;t\x07e\x00f\tg')).toEqual(['abcdef  g']);
    // 38;5;1 is skipped whole: the 1 is not bold
    expect(ds('\x1b[38;5;1mx')).toEqual(['x']);
  });

  test('warp option drops ZWJ / VS16 in the text', () => {
    expect(sgrToChunks(`${style.bold('❤️')}`, THEME, { warp: true }).map((c) => c.text)).toEqual(['❤']);
  });

  test('mono theme: attributes only, every chunk in the default foreground', () => {
    expect(ds(style.yellow(style.bold('w')), MONO_THEME)).toEqual(['w|b']);
    expect(ds(style.dim('d'), MONO_THEME)).toEqual(['d|d']);
    expect(ds(style.red('r'), MONO_THEME)).toEqual(['r']);
    for (const c of sgrToChunks(`${style.red('r')}${style.yellow('y')}x`, MONO_THEME)) expect(c.fg!.intent).toBe('default');
  });

  test('the reader keeps its state across pieces (a streamed answer)', () => {
    const r = createSgrReader(THEME);
    const p = createProseStyler(true);
    const out = [...r.push(p.push('*she ')), ...r.push(p.push('smiles* and')), ...r.push(p.push(' "talks"')), ...r.push(p.end())];
    const merged: TextChunk[] = [];
    appendChunks(merged, out);
    expect(merged.map(d)).toEqual(['*she smiles*|i', ' and "talks"']);
  });

  test('chunk(): explicit colours; without one the default foreground, never unset', () => {
    expect(d(chunk('x', THEME, { bold: true, fg: THEME.red }))).toBe('x|b|red');
    expect(d(chunk('x', MONO_THEME, { bold: true, fg: MONO_THEME.red }))).toBe('x|b');
    expect(chunk('x', THEME).fg).toBe(THEME.text);
    expect(chunk('x', THEME, { dim: true }).fg).toBe(THEME.text);
  });
});
