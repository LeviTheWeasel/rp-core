// Ported from RoleCall:apps/rc/src/lib/ai/__tests__/vvs-257-strip-tool-call-leaks.test.ts@fb8dc623e
// (28 of 30 cases) and vvs-728-dsml-tool-call-normalization.test.ts@fb8dc623e (fixture shapes).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tools/leaks.ts (M1b, D-57): leaked tool-call markup is stripped from prose.
// The first block ports RoleCall apps/rc/src/lib/ai/__tests__/vvs-257-strip-tool-call-leaks.test.ts
// @fb8dc623e (28 of 30: the null/undefined passthrough cases do not apply to the typed signature;
// the exact-output case now expects one space at the seam, and the self-closing case now keeps the
// prose after the tag). The DSML block takes the shapes of vvs-728-dsml-tool-call-normalization.test.ts
// (stripping only; recovering calls is M3). The rest covers the families §8.3 adds.
import { describe, expect, test } from 'bun:test';
import { findToolCallLeaks, stripToolCallLeaks } from '../../src/tools/leaks.ts';

const strip = (s: string): string => stripToolCallLeaks(s).text;

describe('VVS-257 — basic <tool_call> leak shapes', () => {
  test('strips a single closed <tool_call>...</tool_call> block', () => {
    const raw = 'She turned. <tool_call>{"name":"set_directive","arguments":{"mood":"tense"}}</tool_call> "Listen."';
    // RoleCall leaves both spaces ('She turned.  "Listen."'); the seam keeps one.
    expect(stripToolCallLeaks(raw)).toEqual({ text: 'She turned. "Listen."', stripped: 1 });
  });

  test('strips multiple <tool_call> blocks in one message', () => {
    const out = stripToolCallLeaks('<tool_call>{"name":"a"}</tool_call> mid <tool_call>{"name":"b"}</tool_call> end');
    expect(out.text).not.toContain('<tool_call>');
    expect(out.text).not.toContain('</tool_call>');
    expect(out.text).toContain('mid');
    expect(out.text).toContain('end');
    expect(out).toEqual({ text: 'mid end', stripped: 2 });
  });

  test('strips an UNCLOSED <tool_call> block (truncation)', () => {
    const out = strip('She paused. <tool_call>{"name":"set_directive"');
    expect(out).not.toContain('<tool_call>');
    expect(out).toContain('She paused.');
    expect(out).toBe('She paused.');
  });

  test('case-insensitive tag match (model emits <Tool_Call> etc.)', () => {
    const out = strip('<Tool_Call>{"name":"x"}</Tool_Call>visible');
    expect(out).not.toMatch(/<tool_call>/i);
    expect(out).toContain('visible');
  });

  test('tag with attributes (rare GLM variant: `<tool_call type="json">`)', () => {
    const out = strip('<tool_call type="json">{"name":"x"}</tool_call>visible');
    expect(out).not.toContain('<tool_call');
    expect(out).toContain('visible');
  });

  test('tag with whitespace inside opener/closer', () => {
    const out = strip('< tool_call >{"name":"x"}< / tool_call >visible');
    expect(out).not.toContain('tool_call');
    expect(out).toContain('visible');
  });
});

describe('VVS-257 — alternate tool-call formats some models use', () => {
  test('strips `<function>...</function>` Anthropic-style', () => {
    const raw = '<function>{"name":"x"}</function>visible';
    expect(strip(raw)).toContain('visible');
    expect(strip(raw)).not.toContain('<function>');
  });

  test('strips `<function_call>...</function_call>`', () => {
    const raw = '<function_call>{"name":"x"}</function_call>visible';
    expect(strip(raw)).toContain('visible');
    expect(strip(raw)).not.toContain('<function_call>');
  });

  test('strips `<invoke>...</invoke>` Claude-style tool invocation', () => {
    const raw = '<invoke name="x">{}</invoke>visible';
    expect(strip(raw)).toContain('visible');
    expect(strip(raw)).not.toContain('<invoke');
  });

  test('strips `<tool_use>...</tool_use>` GLM/Mistral variant', () => {
    const raw = '<tool_use>{"name":"x"}</tool_use>visible';
    expect(strip(raw)).toContain('visible');
    expect(strip(raw)).not.toContain('<tool_use>');
  });
});

describe('VVS-257 — multi-line and embedded leaks', () => {
  test('multi-line tool call (model pretty-prints)', () => {
    const raw = `Before
<tool_call>
{
  "name": "set_directive",
  "arguments": {
    "mood": "tense"
  }
}
</tool_call>
After`;
    const out = strip(raw);
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('set_directive');
    expect(out).toContain('Before');
    expect(out).toContain('After');
    expect(out).toBe('Before\nAfter');
  });

  test('tool call inside a paragraph (mid-prose injection)', () => {
    const out = strip('She glanced at the door <tool_call>{"name":"x"}</tool_call> and shrugged.');
    expect(out).toContain('She glanced at the door');
    expect(out).toContain('and shrugged.');
    expect(out).not.toContain('<tool_call>');
  });

  test('tool call inside a `<think>` block (cremecafe’s exact shape)', () => {
    const out = strip('<think>I should call <tool_call>{"name":"set_directive"}</tool_call> here.</think>');
    expect(out).not.toContain('<tool_call>');
    expect(out).toContain('<think>');
    expect(out).toContain('I should call');
  });
});

describe('VVS-257 — defensive against false positives', () => {
  test("user prose containing the words 'tool call' but no tags is left intact", () => {
    expect(strip('I made a tool call to fix the issue.')).toBe('I made a tool call to fix the issue.');
  });

  test('code-block inside prose containing JSON is left intact', () => {
    const raw = 'Here\'s the schema:\n```json\n{"name": "x"}\n```\nDone.';
    expect(strip(raw)).toBe(raw);
  });

  test("HTML in prose that isn't a tool-call tag survives", () => {
    expect(strip('<span>red</span>')).toBe('<span>red</span>');
  });

  test('a literal `<tool_call>` mention inside an explanation is stripped (acceptable false positive)', () => {
    expect(strip('in the model output, look for <tool_call>x</tool_call>')).not.toContain('<tool_call>');
  });
});

describe('VVS-257 — empty/edge inputs', () => {
  test('empty string returns empty string', () => {
    expect(stripToolCallLeaks('')).toEqual({ text: '', stripped: 0 });
  });

  test('input with ONLY a tool call returns empty string after trim', () => {
    expect(strip('<tool_call>{"name":"x"}</tool_call>').trim()).toBe('');
  });

  test('input with only whitespace + tool call returns empty after trim', () => {
    expect(strip('  \n\n<tool_call>{"name":"x"}</tool_call>  ').trim()).toBe('');
    expect(strip('  \n\n<tool_call>{"name":"x"}</tool_call>  ')).toBe(''); // and without one, too
  });
});

describe('VVS-257 audit — additional edge cases from cremecafe’s followup', () => {
  test('tool call inside multi-byte (Chinese) prose strips cleanly without breaking the surrounding text', () => {
    const out = strip('她转身看着门 <tool_call>{"name":"set_directive"}</tool_call> ，然后她笑了。');
    expect(out).toContain('她转身看着门');
    expect(out).toContain('，然后她笑了。');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('set_directive');
  });

  test('26 back-to-back tool calls (the cremecafe T39 turn shape) all strip without hanging', () => {
    const oneCall = '<tool_call>{"name":"update_arc","args":{"id":"x"}}</tool_call>';
    const out = stripToolCallLeaks(`Prefix ${oneCall.repeat(26)} Suffix`);
    expect(out.text).not.toContain('<tool_call');
    expect(out.text).not.toContain('update_arc');
    expect(out.text).toContain('Prefix');
    expect(out.text).toContain('Suffix');
    expect(out).toEqual({ text: 'Prefix Suffix', stripped: 26 });
  });

  test('tool-call JSON containing escaped angle brackets (e.g., HTML in args.value) strips correctly', () => {
    const out = strip('Before <tool_call>{"name":"x","args":{"html":"<span>red</span>","note":"<3"}}</tool_call> After');
    expect(out).toContain('Before');
    expect(out).toContain('After');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('<span>red</span>');
    expect(out).not.toContain('"name":"x"');
  });

  test('self-closing tool-call tag (rare model output: `<tool_call />`) is stripped', () => {
    const out = strip('She thought for a moment <tool_call /> and replied.');
    expect(out).not.toContain('<tool_call');
    expect(out).toContain('She thought for a moment');
    // RoleCall's unclosed-opener pattern also ate " and replied."; a self-closing tag removes only itself.
    expect(out).toBe('She thought for a moment and replied.');
  });

  test('tool-call opener with newline in attributes (model pretty-prints multi-line opener) is stripped', () => {
    const raw = `Before <tool_call
  type="json"
  format="openai">
{"name":"x"}
</tool_call> After`;
    const out = strip(raw);
    expect(out).toContain('Before');
    expect(out).toContain('After');
    expect(out).not.toContain('<tool_call');
    expect(out).not.toContain('type="json"');
    expect(out).not.toContain('"name":"x"');
  });

  test('nested mismatched tags (e.g., <tool_call>...<function>...</function>...</tool_call>) — outer strip eats both', () => {
    const out = strip('Before <tool_call><function>{"name":"x"}</function></tool_call> After');
    expect(out).toContain('Before');
    expect(out).toContain('After');
    expect(out).not.toContain('<tool_call');
    expect(out).not.toContain('<function');
    expect(out).not.toContain('</function');
  });
});

describe('VVS-257 — newline cleanup after strip', () => {
  test('collapses 3+ consecutive newlines down to 2 after stripping', () => {
    const out = strip('A\n\n\n\n<tool_call>{"name":"x"}</tool_call>\n\n\n\nB');
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toBe('A\n\nB');
  });

  test('normal double-newlines (paragraph breaks) are preserved', () => {
    expect(strip('A\n\nB')).toBe('A\n\nB');
  });
});

describe('DSML (DeepSeek) — shapes from VVS-728, stripped', () => {
  const reported = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="Remember_Character">
<｜DSML｜parameter name="name" string="true">Mara</｜DSML｜parameter>
<｜DSML｜parameter name="affiliations" string="false">[{"org":"Violet Dragons","role":"resident","status":"active"}]</｜DSML｜parameter>
<｜DSML｜parameter name="age" string="false">null</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

  test('the reported V4 response (fullwidth bars) leaves nothing', () => {
    expect(stripToolCallLeaks(reported)).toEqual({ text: '', stripped: 1 });
  });

  test('compact ASCII DSML: prose outside the block is kept', () => {
    const raw =
      'I found two durable changes.<||DSML||tool_calls><||DSML||invoke name="Remember_Event"><||DSML||parameter name="name" string="true">Arrival</||DSML||parameter><||DSML||parameter name="importance" string="false">3</||DSML||parameter></||DSML||invoke><||DSML||invoke name="postgen_status"><||DSML||parameter name="summary" string="true">Saved the arrival.</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>';
    expect(stripToolCallLeaks(raw)).toEqual({ text: 'I found two durable changes.', stripped: 1 });
  });

  test('literal marker text in prose survives byte for byte', () => {
    const raw =
      'Keep literal |DSML| prose.<|DSML|tool_calls><|DSML|invoke name="Remember_Character"><|DSML|parameter name="name" string="true">Mara |DSML| Vale</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
    expect(strip(raw)).toBe('Keep literal |DSML| prose.');
    expect(stripToolCallLeaks('Plain |DSML| and ｜DSML｜ in prose.')).toEqual({ text: 'Plain |DSML| and ｜DSML｜ in prose.', stripped: 0 });
  });

  test('the V3.2 function_calls container', () => {
    const raw = `<｜DSML｜function_calls>
<｜DSML｜invoke name="postgen_status">
<｜DSML｜parameter name="summary" string="true">Nothing significant changed.</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>`;
    expect(stripToolCallLeaks(raw)).toEqual({ text: '', stripped: 1 });
  });

  test('an unterminated block is a tail: stripped to the end (RoleCall’s parser keeps it; stripping must not)', () => {
    const raw = 'She smiles.\n\n<｜DSML｜tool_calls><｜DSML｜invoke name="Remember_Character"><｜DSML｜parameter name="name" string="true">Mara';
    expect(stripToolCallLeaks(raw)).toEqual({ text: 'She smiles.', stripped: 1 });
  });

  test('a closed block with invalid typed JSON is stripped all the same (validity is M3’s concern)', () => {
    const raw = `Text.
<｜DSML｜tool_calls>
<｜DSML｜invoke name="Remember_Character">
<｜DSML｜parameter name="affiliations" string="false">[{"org":"Violet Dragons"}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
    expect(strip(raw)).toBe('Text.');
  });

  test('repeated unterminated containers in bounded time', () => {
    const malformed = '<｜DSML｜tool_calls>'.repeat(20_000);
    const t0 = performance.now();
    const out = stripToolCallLeaks(malformed);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out).toEqual({ text: '', stripped: 1 });
  });

  test('a bare invoke and stray closers are stripped too', () => {
    expect(strip('A <｜DSML｜invoke name="x"><｜DSML｜parameter name="a" string="true">1</｜DSML｜parameter></｜DSML｜invoke> B')).toBe('A B');
    expect(stripToolCallLeaks('A </｜DSML｜tool_calls> B')).toEqual({ text: 'A B', stripped: 1 });
  });

  test('the end-of-sentence token goes with DSML; elsewhere it is not this module’s business', () => {
    expect(stripToolCallLeaks(`Done.\n${reported}<｜end▁of▁sentence｜>`)).toEqual({ text: 'Done.', stripped: 1 });
    expect(stripToolCallLeaks('Done.<｜end▁of▁sentence｜>')).toEqual({ text: 'Done.<｜end▁of▁sentence｜>', stripped: 0 });
  });
});

describe('the families §8.3 adds', () => {
  test('<function=…> (Llama / Qwen3-coder), with parameter children, inside or outside <tool_call>', () => {
    expect(stripToolCallLeaks('Roll. <function=roll_dice>{"sides": 20}</function> Done.')).toEqual({ text: 'Roll. Done.', stripped: 1 });
    const qwen = 'She waits.\n\n<tool_call>\n<function=roll_dice>\n<parameter=sides>\n20\n</parameter>\n</function>\n</tool_call>\n\nThe die rolls.';
    expect(stripToolCallLeaks(qwen)).toEqual({ text: 'She waits.\n\nThe die rolls.', stripped: 1 });
  });

  test('<invoke …> inside Claude’s <function_calls> wrapper leaves no wrapper behind', () => {
    const raw = 'He nods.\n<function_calls>\n<invoke name="roll">\n<parameter name="sides">20</parameter>\n</invoke>\n</function_calls>';
    expect(stripToolCallLeaks(raw)).toEqual({ text: 'He nods.', stripped: 1 });
    expect(strip('He nods. <ns:invoke name="roll"></ns:invoke> Then waits.')).toBe('He nods. Then waits.');
  });

  test('[TOOL_REQUEST]…[END_TOOL_REQUEST] (LM Studio)', () => {
    expect(stripToolCallLeaks('Wait. [TOOL_REQUEST]\n{"name":"roll","arguments":{"sides":20}}\n[END_TOOL_REQUEST] Go.')).toEqual({ text: 'Wait. Go.', stripped: 1 });
  });

  test('[TOOL_CALLS] with a JSON array (Mistral v3), brackets inside strings ignored', () => {
    expect(stripToolCallLeaks('Wait. [TOOL_CALLS] [{"name":"roll","arguments":{"note":"a ] b }"}}] Go.')).toEqual({ text: 'Wait. Go.', stripped: 1 });
  });

  test('[TOOL_CALLS]name[ARGS]{…} (Mistral v11+), with a call id, several in a row', () => {
    expect(strip('Wait. [TOOL_CALLS]roll[ARGS]{"sides":20} Go.')).toBe('Wait. Go.');
    expect(strip('Wait. [TOOL_CALLS]roll[CALL_ID]a1B2c3D4e[ARGS]{"sides":20} Go.')).toBe('Wait. Go.');
    expect(stripToolCallLeaks('Wait.[TOOL_CALLS]a[ARGS]{}[TOOL_CALLS]b[ARGS]{"x":"}"}')).toEqual({ text: 'Wait.', stripped: 2 });
  });

  test('a bare [TOOL_CALLS] marker goes alone; the prose after it stays', () => {
    expect(stripToolCallLeaks('Wait. [TOOL_CALLS] She shrugs.')).toEqual({ text: 'Wait. She shrugs.', stripped: 1 });
  });

  test('DeepSeek V3 and Kimi K2 special-token sections', () => {
    const ds = 'Ok.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>roll\n```json\n{"sides":20}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    expect(stripToolCallLeaks(ds)).toEqual({ text: 'Ok.', stripped: 1 });
    const kimi = 'Ok. <|tool_calls_section_begin|> <|tool_call_begin|> functions.roll:0 <|tool_call_argument_begin|> {"sides": 20} <|tool_call_end|> <|tool_calls_section_end|>';
    expect(stripToolCallLeaks(kimi)).toEqual({ text: 'Ok.', stripped: 1 });
  });

  test('stray closing tags are removed', () => {
    expect(stripToolCallLeaks('She waits.</tool_call> Then speaks.')).toEqual({ text: 'She waits. Then speaks.', stripped: 1 });
    expect(stripToolCallLeaks('A [END_TOOL_REQUEST] B')).toEqual({ text: 'A B', stripped: 1 });
    // a same-name nest leaves the outer closer over; it goes as a stray
    expect(stripToolCallLeaks('<tool_call><tool_call>x</tool_call></tool_call> tail')).toEqual({ text: 'tail', stripped: 2 });
  });
});

describe('unterminated tails of every family', () => {
  const cases: [string, string][] = [
    ['tag', 'She paused. <invoke name="roll"><parameter name="sides">2'],
    ['tag opener cut mid-attributes', 'She paused. <tool_call type="js'],
    ['function=', 'She paused. <function=roll_dice>{"sides": 2'],
    ['dsml', 'She paused. <|DSML|tool_calls><|DSML|invoke name="x">'],
    ['tool_request', 'She paused. [TOOL_REQUEST]{"name":"roll"'],
    ['tool_calls json', 'She paused. [TOOL_CALLS] [{"name":"roll","arguments":{"s'],
    ['tool_calls named', 'She paused. [TOOL_CALLS]roll[ARGS]{"sides":'],
    ['tool_calls named, no payload yet', 'She paused. [TOOL_CALLS]roll[ARGS]'],
    ['special', 'She paused. <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function'],
  ];
  for (const [name, raw] of cases) {
    test(name, () => {
      expect(stripToolCallLeaks(raw)).toEqual({ text: 'She paused.', stripped: 1 });
      const spans = findToolCallLeaks(raw);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.complete).toBe(false);
      expect(spans[0]!.end).toBe(raw.length);
    });
  }

  test('a long run of unclosed openers of any family stays linear', () => {
    for (const unit of ['<tool_call>', '<tool_call', '[TOOL_CALLS] [', '[TOOL_REQUEST]', '<function=x>', '</invoke> ']) {
      const raw = `Prose. ${unit.repeat(20_000)}`;
      const t0 = performance.now();
      const out = stripToolCallLeaks(raw);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(out.text.startsWith('Prose.')).toBe(true);
      expect(out.text).not.toContain(unit.trim());
    }
  });
});

describe('prose is preserved', () => {
  test('text without leaks comes back unchanged, whitespace and all', () => {
    for (const raw of [
      'No leaks here.\n\n\n\nStill prose.  Two spaces stay.\n',
      '  Leading and trailing whitespace stay.  ',
      'A functional <functional> tag, an <invoked> one, a <tool_calling> one and function(x) <b>bold</b>.',
      '[TOOL_CALL] is not [TOOL_CALLS without the bracket; [END] neither.',
      '<think>I wonder.</think> She smiles.',
    ]) {
      expect(stripToolCallLeaks(raw)).toEqual({ text: raw, stripped: 0 });
      expect(findToolCallLeaks(raw)).toEqual([]);
    }
  });

  test('whitespace is repaired only at the seams; prose elsewhere keeps its own', () => {
    const raw = 'First.\n\n\n\nSecond.  <tool_call>x</tool_call>  Third.\n\n<tool_call>y</tool_call>\n\n    indented';
    expect(strip(raw)).toBe('First.\n\n\n\nSecond.  Third.\n\n    indented');
  });

  test('a line of its own: one line break stays one line break', () => {
    expect(strip('Line one.\n<tool_call>x</tool_call>\nLine two.')).toBe('Line one.\nLine two.');
  });

  test('a leak in the middle of a continue addition keeps the addition’s leading space', () => {
    expect(strip(' Then <tool_call>{"name":"x"}</tool_call> it stops.')).toBe(' Then it stops.');
  });

  test('a removal at the edges drops the whitespace it leaves there', () => {
    expect(strip('<tool_call>x</tool_call>\n\nShe smiled.')).toBe('She smiled.');
    expect(strip('She smiled.\n\n<tool_call>x</tool_call>\n')).toBe('She smiled.');
    expect(strip('A <tool_call/> <tool_call/> B')).toBe('A B');
  });
});

describe('Cyrillic prose', () => {
  test('Russian around a leak is kept intact', () => {
    const raw = 'Она кивнула. <tool_call>{"name":"бросок","arguments":{"грани":20}}</tool_call> «Ну что ж», — сказала Вера, и ёлка за окном качнулась.';
    expect(stripToolCallLeaks(raw)).toEqual({ text: 'Она кивнула. «Ну что ж», — сказала Вера, и ёлка за окном качнулась.', stripped: 1 });
  });

  test('Russian paragraphs with a DSML block between them', () => {
    const raw = 'Первый абзац.\n\n<｜DSML｜tool_calls><｜DSML｜invoke name="x"><｜DSML｜parameter name="имя" string="true">Мара</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>\n\nВторой абзац.';
    expect(stripToolCallLeaks(raw)).toEqual({ text: 'Первый абзац.\n\nВторой абзац.', stripped: 1 });
  });

  test('Russian text that only talks about tools is untouched', () => {
    const raw = 'Она вызвала функцию — «вызов инструмента», как говорил мастер. [Примечание: без тегов.]';
    expect(stripToolCallLeaks(raw)).toEqual({ text: raw, stripped: 0 });
  });

  test('a cut-off call after Russian prose', () => {
    expect(strip('Вера замолчала. <tool_call>{"name":"молчание"')).toBe('Вера замолчала.');
  });
});

describe('findToolCallLeaks (spans for M3)', () => {
  test('ordered, non-overlapping, with family and completeness', () => {
    const raw = 'a <tool_call>x</tool_call> b [TOOL_REQUEST]y[END_TOOL_REQUEST] c </invoke> d [TOOL_CALLS] [1] e <｜DSML｜tool_calls>z';
    const spans = findToolCallLeaks(raw);
    expect(spans.map((s) => [s.family, s.complete, raw.slice(s.start, s.end)])).toEqual([
      ['tag', true, '<tool_call>x</tool_call>'],
      ['tool_request', true, '[TOOL_REQUEST]y[END_TOOL_REQUEST]'],
      ['tag', false, '</invoke>'],
      ['tool_calls', true, '[TOOL_CALLS] [1]'],
      ['dsml', false, '<｜DSML｜tool_calls>z'],
    ]);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
  });
});
