// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// RoleCall's reasoning splitter in linear time (src/formats/rolecall-think.ts; robust#2 of the
// story-import review, a listed deviation in how, not in what): texts that made RoleCall's regexes
// and loops quadratic (a `<` or `[` before a long run of spaces, `<a ` with no `>`, long runs of
// newlines or letters, thousands of unclosed openers) split in well under a second, the review's
// 44 KB export included; and the rewritten scans give RoleCall's results on texts that exercise them
// (the expectations below are what RoleCall's own thinking-tags.ts returns for these texts).
// Every text here is invented for the test.
import { describe, expect, test } from 'bun:test';
import { planStoryImport } from '../../src/formats/rolecall-import.ts';
import { parseStory } from '../../src/formats/rolecall-story.ts';
import { extractPresetCoTTag, splitThinkingFromContent } from '../../src/formats/rolecall-think.ts';
import { openZip } from '../../src/formats/zip.ts';
import { buildStory, writeZip } from './kit.ts';

type Rec = Record<string, unknown>;

const MB = 1_000_000;

/** Milliseconds one call takes. */
function timed(f: () => unknown): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}

describe('splitThinkingFromContent: linear time', () => {
  test('1 MB of spaces, and a `<` or `[` before 1 MB of spaces: each under 200 ms', () => {
    expect(timed(() => splitThinkingFromContent(' '.repeat(MB)))).toBeLessThan(200);
    expect(timed(() => splitThinkingFromContent(`<think>x</think><${' '.repeat(MB)}`))).toBeLessThan(200);
    expect(timed(() => splitThinkingFromContent(`<think>x</think>[${' '.repeat(MB)}`))).toBeLessThan(200);
    expect(timed(() => splitThinkingFromContent(`<think>x</think><${' '.repeat(MB / 2)}/${' '.repeat(MB / 2)}`))).toBeLessThan(200);
  });

  test('`<a ` repeated with no `>`, and runs of newlines or letters after a heading or an opener: each under 200 ms', () => {
    expect(timed(() => splitThinkingFromContent(`<think>x</think>${'<a '.repeat(MB / 3)}`))).toBeLessThan(200);
    expect(timed(() => splitThinkingFromContent(`Thinking:\n${'\n'.repeat(MB)}x`))).toBeLessThan(200);
    expect(timed(() => splitThinkingFromContent(`<think>${'\n'.repeat(MB)}x`))).toBeLessThan(200);
    expect(timed(() => splitThinkingFromContent(`<think>END OF THINKING${'a'.repeat(MB)}`))).toBeLessThan(200);
  });

  test('thousands of unclosed openers, each ended early by a terminator: under 200 ms for 250 KB', () => {
    const n = 250_000;
    const cases = [
      '<think>END OF THINKING '.repeat(n / 23) + '</think>',
      '<think>\n"red green blue" '.repeat(n / 23),
      '<think>a</thi '.repeat(n / 14),
      '<think>'.repeat(n / 7),
      `<x ${'[think]\n"red green blue" '.repeat(n / 24)}>`,
    ];
    for (const s of cases) expect(timed(() => splitThinkingFromContent(s))).toBeLessThan(200);
    // The last one is reached through a closer that a later tag token swallows (a restart inside it).
    expect(timed(() => splitThinkingFromContent(`<thinking>x</thin ${'[think]\n"red green blue" '.repeat(n / 24)}>`))).toBeLessThan(200);
  });

  test("the review's 44 KB export (one answer ends with `<` and 100 000 spaces) parses and plans in under 200 ms", () => {
    const story = buildStory({ branch: false, duplicate: false, detached: false });
    const lines = `${story.facts.chats.main!.dir}/messages.jsonl`;
    const files = story.files.map((f) => {
      if (f.name !== lines) return f;
      const rows = f.data.split('\n').map((l) => JSON.parse(l) as Rec);
      const row = rows[9]!;
      const text = `${String(row.content)}<${' '.repeat(100_000)}`;
      rows[9] = { ...row, content: text, swipes: [{ content: text, timestamp: (row.swipes as Rec[])[0]!.timestamp }] };
      return { ...f, data: rows.map((r) => JSON.stringify(r)).join('\n') };
    });
    const bytes = writeZip(files);
    expect(bytes.length).toBeLessThan(64 * 1024);
    let plan: ReturnType<typeof planStoryImport> | undefined;
    const ms = timed(() => {
      const zip = openZip(bytes);
      const parsed = parseStory(zip.entries.filter((e) => !e.dir && e.name !== 'story.jsonl').map((e) => ({ name: e.name, data: zip.read(e.name) })));
      if (!parsed.ok) throw new Error(parsed.why);
      plan = planStoryImport(parsed.value);
    });
    expect(ms).toBeLessThan(200);
    expect(plan!.sessions[0]!.counts.messages).toBe(story.facts.chats.main!.messages);
  });
});

describe("splitThinkingFromContent: RoleCall's results where the scans were rewritten", () => {
  const split = (s: string, extra?: string): { reasoning: string | null; visible: string; via: string[] } => {
    const r = splitThinkingFromContent(s, extra);
    return { reasoning: r.reasoning, visible: r.visibleContent, via: r.blocks.map((b) => b.capture.via) };
  };

  test('closers: nesting counted, a square block across an angle token, a closer that is another tag', () => {
    expect(split('<think>a <think>b</think> c</think>d')).toEqual({ reasoning: 'a b c', visible: 'd', via: ['tag'] });
    expect(split('[think]a<x [b]>c[/think]d')).toEqual({ reasoning: 'ac', visible: 'd', via: ['tag'] });
    expect(split('<think-->x</think>y')).toEqual({ reasoning: 'x', visible: 'y', via: ['tag'] });
    expect(split('<think>tide</thinking>after')).toEqual({ reasoning: 'tide', visible: 'ing>after', via: ['unclosed'] });
  });

  test('a partial closer inside a later tag token: the scan restarts inside it, as RoleCall', () => {
    expect(split('<thinking>x</thin [think]\n"A gust at the door." [think]\n"Bells once more." >')).toEqual({
      reasoning: 'x',
      visible: '"A gust at the door." "Bells once more." >',
      via: ['unclosed', 'unclosed', 'unclosed'],
    });
    expect(split('<think>first\n*She waves.* Then more text here.<think>second</think>end')).toEqual({
      reasoning: 'first\n*She waves.* Then more text here.second',
      visible: '>end',
      via: ['unclosed'],
    });
  });

  test('transitions after newline runs, the heading pair, an end marker glued to a word', () => {
    expect(split('<think>a\n\n\nResponse:\nok')).toEqual({ reasoning: 'a', visible: 'ok', via: ['unclosed'] });
    expect(split('Thinking:\n\n\nplan it out well\n\n\n\nResponse:\nHello there.')).toEqual({ reasoning: 'plan it out well', visible: 'Hello there.', via: ['heading'] });
    expect(split('<think>weigh it END OF THINKINGabc def.Then the tide turns.')).toEqual({ reasoning: 'weigh it END OF THINKING', visible: 'abc def.Then the tide turns.', via: ['unclosed'] });
    // RoleCall finds the marker in the lower-cased text and uses that index on the text: İ lower-cases
    // to two characters, so the marker's end lands later.
    expect(split('<think>İİ END OF THINKING x')).toEqual({ reasoning: 'İİ END OF THINKING x', visible: '', via: ['unclosed'] });
  });

  test('blocks cut out in one pass, the two delimiter styles overlapping included; a tag in code stays', () => {
    expect(split('◁think▷a<|begin_of_thought|>b◁/think▷c<|end_of_thought|>d')).toEqual({ reasoning: 'a<|begin_of_thought|>b\n\nb◁/think▷c', visible: '', via: ['tag', 'tag'] });
    expect(split('`<think>` stays </think> but')).toEqual({ reasoning: null, visible: '`<think>` stays  but', via: [] });
  });

  test("extractPresetCoTTag: the first opening tag without a slash, angle before square", () => {
    expect(extractPresetCoTTag('</x> < scene foo="1">')).toBe('scene');
    expect(extractPresetCoTTag('[PLAN] then <think >')).toBe('think');
    expect(extractPresetCoTTag('[ PLAN ]')).toBe('plan');
    expect(extractPresetCoTTag(`<a ${'<a '.repeat(100_000)}`)).toBeNull();
  });
});
