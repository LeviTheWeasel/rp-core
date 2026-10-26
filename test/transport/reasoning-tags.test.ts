// Ported from Bunraku:src/core/reasoning-tags.test.ts@702d8120 (cases adapted to the streaming rules).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// reasoning-tags.ts: the streaming splitter for inline reasoning tags (D-54).
// The Bunraku cases (src/core/reasoning-tags.test.ts) are adapted to the streaming rules (exact,
// case-sensitive markers; lossless whitespace; an unclosed block stays reasoning) and run at every cut
// point of the stream, for every default tag pair.
import { describe, expect, test } from 'bun:test';
import {
  createReasoningSplitter,
  DEFAULT_REASONING_TAGS,
  tagPairs,
  type SplitPiece,
  type TagPair,
} from '../../src/providers/reasoning-tags.ts';

const DEFAULTS = tagPairs();

/** Feed `chunks`, then end(); adjacent pieces of one kind merged (as a consumer would append them). */
function run(pairs: readonly TagPair[], chunks: readonly string[], opts?: { startInside?: boolean }): SplitPiece[] {
  const s = createReasoningSplitter(pairs, opts);
  const raw: SplitPiece[] = [];
  for (const c of chunks) raw.push(...s.push(c));
  raw.push(...s.end());
  for (const p of raw) expect(p.d).not.toBe(''); // never an empty piece
  return merge(raw);
}

function merge(pieces: readonly SplitPiece[]): SplitPiece[] {
  const out: SplitPiece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.d += p.d;
    else out.push({ ...p });
  }
  return out;
}

/** Every split of `s` into 1, 2 and 3 chunks (3-way only for short strings), plus one char per chunk. */
function* splits(s: string): Generator<string[]> {
  yield [s];
  for (let i = 0; i <= s.length; i++) yield [s.slice(0, i), s.slice(i)];
  if (s.length <= 60) {
    for (let i = 0; i <= s.length; i++) for (let j = i; j <= s.length; j++) yield [s.slice(0, i), s.slice(i, j), s.slice(j)];
  }
  yield Array.from(s);
}

/** The splitter gives `want` however the stream is cut. */
function expectAtEveryCut(pairs: readonly TagPair[], s: string, want: SplitPiece[], opts?: { startInside?: boolean }): void {
  for (const chunks of splits(s)) {
    const got = run(pairs, chunks, opts);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`cut ${JSON.stringify(chunks)}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
}

const T = (d: string): SplitPiece => ({ kind: 'text', d });
const R = (d: string): SplitPiece => ({ kind: 'reasoning', d });

describe('tagPairs', () => {
  test('the D-54 defaults pair with their closers', () => {
    expect(DEFAULT_REASONING_TAGS).toEqual(['<think>', '<thinking>', '<thought>', '[THINK]', '◁think▷', '<|begin_of_thought|>']);
    expect(DEFAULTS).toEqual([
      { open: '<think>', close: '</think>' },
      { open: '<thinking>', close: '</thinking>' },
      { open: '<thought>', close: '</thought>' },
      { open: '[THINK]', close: '[/THINK]' },
      { open: '◁think▷', close: '◁/think▷' },
      { open: '<|begin_of_thought|>', close: '<|end_of_thought|>' },
    ]);
  });

  test('custom tags: angle and square shapes, duplicates collapse, shapeless text is skipped', () => {
    expect(tagPairs(['<plan>', '[REASON]', '<plan>', 'Thinking:', '', '<reasoning effort="high">'])).toEqual([
      { open: '<plan>', close: '</plan>' },
      { open: '[REASON]', close: '[/REASON]' },
      { open: '<reasoning effort="high">', close: '</reasoning>' },
    ]);
    expect(tagPairs([])).toEqual([]);
  });
});

describe('createReasoningSplitter: each default pair at every cut point', () => {
  for (const p of DEFAULTS) {
    const { open: o, close: c } = p;
    // A closer of some other pair, to show it does not end this block.
    const foreign = DEFAULTS.find((q) => q.close !== c)!.close;
    describe(o, () => {
      test('a block, then the answer', () => expectAtEveryCut(DEFAULTS, `${o}plan the scene${c}She opened the door.`, [R('plan the scene'), T('She opened the door.')]));
      test('text around a block, whitespace kept', () =>
        expectAtEveryCut(DEFAULTS, `Before.\n${o}\nplanning\n${c}\n\nAfter.`, [T('Before.\n'), R('\nplanning\n'), T('\n\nAfter.')]));
      test('an unclosed block stays reasoning at end()', () => expectAtEveryCut(DEFAULTS, `Intro ${o}never closes`, [T('Intro '), R('never closes')]));
      test('nested-looking: a second opening inside is reasoning text, the first closing ends the block', () =>
        expectAtEveryCut(DEFAULTS, `${o}a${o}b${c}c`, [R(`a${o}b`), T('c')]));
      test("another pair's closing inside does not end the block", () => expectAtEveryCut(DEFAULTS, `${o}x${foreign}y${c}z`, [R(`x${foreign}y`), T('z')]));
      test('two blocks', () => expectAtEveryCut(DEFAULTS, `${o}a${c}mid${o}b${c}end`, [R('a'), T('mid'), R('b'), T('end')]));
      test('an empty block leaves no piece', () => expectAtEveryCut(DEFAULTS, `${o}${c}only text`, [T('only text')]));
      test('a stray closing outside reasoning is dropped, never shown', () => expectAtEveryCut(DEFAULTS, `text${c}more`, [T('textmore')]));
      test('a marker prefix at the end of the stream is text', () => expectAtEveryCut(DEFAULTS, `hello ${o.slice(0, -1)}`, [T(`hello ${o.slice(0, -1)}`)]));
      test('a marker prefix at the end of an unclosed block is reasoning', () => expectAtEveryCut(DEFAULTS, `${o}deciding ${c.slice(0, -1)}`, [R(`deciding ${c.slice(0, -1)}`)]));
      test('a near miss passes through as text', () => {
        const near = `${o.slice(0, -1)}X`;
        expectAtEveryCut(DEFAULTS, `a ${near} b ${near}`, [T(`a ${near} b ${near}`)]);
      });
      test('startInside: the stream opens inside reasoning', () => expectAtEveryCut(DEFAULTS, `planning${c}answer`, [R('planning'), T('answer')], { startInside: true }));
    });
  }
});

describe('createReasoningSplitter: Bunraku cases, streamed', () => {
  test('a closed <think> block, then narration', () =>
    expectAtEveryCut(DEFAULTS, '<think>\nplanning the scene\n</think>\n\nShe opened the door.', [R('\nplanning the scene\n'), T('\n\nShe opened the door.')]));
  test('a duplicate opening before the real content (prefill + model echo) resolves at the one closing', () =>
    expectAtEveryCut(DEFAULTS, '<think>\n\n<think>\nturkish planning text\n</think>\n\nShe ran outside.', [
      R('\n\n<think>\nturkish planning text\n'),
      T('\n\nShe ran outside.'),
    ]));
  test('the thinking/thought siblings', () => {
    expectAtEveryCut(DEFAULTS, '<thinking>plan</thinking>text', [R('plan'), T('text')]);
    expectAtEveryCut(DEFAULTS, '<thought>plan</thought>text', [R('plan'), T('text')]);
  });
  test('two separate blocks; narration between and after survives', () =>
    expectAtEveryCut(DEFAULTS, '<think>a</think>middle<think>b</think>end', [R('a'), T('middle'), R('b'), T('end')]));
  test('an unclosed block (generation cut off mid-thought) stays reasoning', () =>
    expectAtEveryCut(DEFAULTS, 'Before.\n<think>\nnever closes\n', [T('Before.\n'), R('\nnever closes\n')]));
  test('a lone angle bracket or the bare word think is never touched', () =>
    expectAtEveryCut(DEFAULTS, 'He said <3 and started to think about it.', [T('He said <3 and started to think about it.')]));
  test('markers are exact and case-sensitive (unlike Bunraku display): <THINK> and <Think> are text', () => {
    expectAtEveryCut(DEFAULTS, '<THINK>plan</THINK>text', [T('<THINK>plan</THINK>text')]);
    expectAtEveryCut(DEFAULTS, '<Think>plan</Think>text', [T('<Think>plan</Think>text')]);
    expectAtEveryCut(DEFAULTS, '[think]x[/think]', [T('[think]x[/think]')]);
  });
  test('different blocks of different pairs in one reply', () =>
    expectAtEveryCut(DEFAULTS, '[THINK]a[/THINK]x◁think▷b◁/think▷y<|begin_of_thought|>c<|end_of_thought|>z', [
      R('a'),
      T('x'),
      R('b'),
      T('y'),
      R('c'),
      T('z'),
    ]));
});

describe('createReasoningSplitter: carry and state', () => {
  test('a marker prefix is held back until it is decided', () => {
    const s = createReasoningSplitter(DEFAULTS);
    expect(s.push('abc <thi')).toEqual([T('abc ')]);
    expect(s.push('nk>x')).toEqual([R('x')]);
    expect(s.push('</th')).toEqual([]);
    expect(s.push('ink>done')).toEqual([T('done')]);
    expect(s.end()).toEqual([]);
  });

  test('a held prefix that turns out not to be a marker is released as text', () => {
    const s = createReasoningSplitter(DEFAULTS);
    expect(s.push('a <thin')).toEqual([T('a ')]);
    expect(s.push('g about it')).toEqual([T('<thing about it')]);
  });

  test("text is never held longer than the longest marker's prefix", () => {
    const s = createReasoningSplitter(DEFAULTS);
    expect(s.push('plain text, nothing special')).toEqual([T('plain text, nothing special')]);
  });

  test('push("") and end() on nothing are empty', () => {
    const s = createReasoningSplitter(DEFAULTS);
    expect(s.push('')).toEqual([]);
    expect(s.end()).toEqual([]);
  });

  test('startInside: any default closing ends the opening block; unclosed stays reasoning', () => {
    for (const p of DEFAULTS) expect(run(DEFAULTS, [`x${p.close}y`], { startInside: true })).toEqual([R('x'), T('y')]);
    expectAtEveryCut(DEFAULTS, 'still deciding', [R('still deciding')], { startInside: true });
    // After the opening block closes, the usual rules apply.
    expectAtEveryCut(DEFAULTS, 'a</think>b<think>c</think>d</think>e', [R('a'), T('b'), R('c'), T('de')], { startInside: true });
  });

  test('no pairs: everything is text, startInside is ignored', () => {
    expectAtEveryCut([], '<think>x</think>', [T('<think>x</think>')]);
    expectAtEveryCut([], 'abc', [T('abc')], { startInside: true });
  });

  test('a custom pair list only knows its own markers', () => {
    const pairs = tagPairs(['<plan>']);
    expectAtEveryCut(pairs, '<think>t</think><plan>p</plan>out', [T('<think>t</think>'), R('p'), T('out')]);
  });

  test('a marker that is a prefix of a longer one waits until the longer one is decided', () => {
    const pairs: TagPair[] = [
      { open: '<r>', close: '</r>' },
      { open: '<r>>', close: '<<r>' },
    ];
    expectAtEveryCut(pairs, 'a<r>>b<<r>c', [T('a'), R('b'), T('c')]);
    expectAtEveryCut(pairs, 'a<r>b</r>c', [T('a'), R('b'), T('c')]);
    expectAtEveryCut(pairs, 'a<r>', [T('a')]);
  });

  test('an overlapping longer marker that starts earlier wins once complete', () => {
    const pairs: TagPair[] = [
      { open: 'ab', close: '/ab' },
      { open: 'xaby', close: '/xaby' },
    ];
    expectAtEveryCut(pairs, 'xaby1/xaby2', [R('1'), T('2')]);
    expectAtEveryCut(pairs, 'xab1/ab2', [T('x'), R('1'), T('2')]);
  });

  test('pieces come out in stream order with kinds alternating as blocks open and close', () => {
    const s = createReasoningSplitter(DEFAULTS);
    const out = [...s.push('A<think>B'), ...s.push('C</think>D'), ...s.end()];
    expect(merge(out)).toEqual([T('A'), R('BC'), T('D')]);
  });
});
