// assemble M2: where fired lore lands (§10.2, §10.1, D-47), as SillyTavern places it.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_PRESET, type Preset } from '../../src/formats/native.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { allText, always, bySrc, HISTORY_BLOCK, input, lines, longView, MIRA, ok, preset, source, textOf, withLore } from './fixtures.ts';

const MAIN = "Write Mira's next reply in a fictional roleplay chat between Mira and Levi. Stay in character, write vivid prose, and never speak, act or decide for Levi.";

describe('every position in its place, ascending order within a place', () => {
  const entries = [
    always('B2', { order: 20 }),
    always('B1', { order: 10 }),
    always('A', { position: 'after' }),
    always('EB', { position: 'examples_before', content: 'Mira: before example' }),
    always('EA', { position: 'examples_after', content: '<START>\nMira: after example' }),
    always('NB2', { position: 'note_before', order: 7 }),
    always('NB1', { position: 'note_before', order: 3 }),
    always('NA', { position: 'note_after' }),
    always('T', { position: 'top' }),
    always('Bo', { position: 'bottom' }),
    always('R', { position: 'recap' }),
    always('D', { position: { depth: 1, role: 'user' } }),
    always('D0', { position: { depth: 1, role: 'user' }, order: 5 }),
    always('O', { position: { outlet: 'x' } }),
  ];

  test('the builtin layout, golden', () => {
    const r = withLore(entries);
    expect(lines(r.messages)).toEqual([
      'system|lore:top|T text',
      `system|main|${MAIN}`,
      'system|lore_before|B1 text\nB2 text',
      'system|description|Mira is a cartographer who maps dreams for Levi.',
      'system|personality|Curious, dry.',
      'system|scenario|A lighthouse at dusk.',
      'system|lore_after|A text',
      'system|persona|A traveller with a broken compass.',
      'system|examples|<START>\nMira: before example\n<START>\nMira: after example',
      'system|lore:recap|R text',
      'assistant|history|Hello, traveller.',
      'user|history|Hi.',
      // No author's note in the session: AN-positioned lore goes to ST's default place, depth 4, system.
      'system|author_note|NB1 text\nNB2 text\n\nNA text',
      'assistant|history|She nods.',
      'user|history|Where are we?',
      'assistant|history|At the lighthouse.',
      'user|lore:lib:D0|D0 text',
      'user|lore:lib:D|D text',
      'user|history|Show me the map.',
      'system|lore:bottom|Bo text',
    ]);
    // The outlet has no {{outlet::x}} in the builtin preset: fired, not sent (ST).
    expect(r.trace.lore.fired.map((f) => f.id)).toContain('O');
    expect(allText(r.messages)).not.toContain('O text');
  });

  test('lore:top joins the leading system run (head); depth lore and the rest are inline', () => {
    const r = withLore(entries);
    expect(r.messages[0]!.placement).toBe('head');
    expect(bySrc(r.messages, 'lore:recap')!.placement).toBe('inline');
    expect(bySrc(r.messages, 'lore:bottom')!.placement).toBe('inline');
    expect(bySrc(r.messages, 'lore:lib:D')!.placement).toBe('inline');
  });

  test('top before the top pins, bottom after the bottom pins, recap right before the chat area', () => {
    const p = preset(
      [
        { id: 'pin_top', role: 'system', enabled: true, content: 'TOP PIN', at: 'top' },
        { id: 'main', role: 'system', enabled: true, content: 'Main.', at: 'relative' },
        HISTORY_BLOCK,
        { id: 'post', role: 'system', enabled: true, content: 'Post.', at: 'relative' },
        { id: 'pin_bottom', role: 'system', enabled: true, content: 'BOTTOM PIN', at: 'bottom' },
      ],
      { formats: { newChat: '[Start a new chat]' } },
    );
    const r = withLore([always('T', { position: 'top' }), always('Bo', { position: 'bottom' }), always('R', { position: 'recap' })], { preset: p });
    const srcs = r.messages.map((x) => x.src);
    expect(srcs.slice(0, 5)).toEqual(['lore:top', 'pin_top', 'main', 'new_chat', 'lore:recap']);
    expect(srcs[5]).toBe('history');
    expect(srcs.slice(-3)).toEqual(['post', 'pin_bottom', 'lore:bottom']);
  });

  test('several top entries make one message, joined with a newline, ascending order', () => {
    const r = withLore([always('T2', { position: 'top', order: 9 }), always('T1', { position: 'top', order: 1 })]);
    expect(r.messages.filter((x) => x.src === 'lore:top').map(textOf)).toEqual(['T1 text\nT2 text']);
  });
});

describe('wi_format (D-70, ST formatWorldInfo)', () => {
  const entries = [
    always('B'),
    always('A', { position: 'after' }),
    always('EB', { position: 'examples_before', content: 'Mira: ex' }),
    always('N', { position: 'note_before' }),
    always('D', { position: { depth: 0 } }),
    always('T', { position: 'top' }),
  ];
  const wi = (format: string): Preset => ({ ...BUILTIN_PRESET, formats: { wi: format } });

  test('wraps the before and after slot values, nothing else', () => {
    const r = withLore(entries, { preset: wi('<wi>{0}</wi>') });
    expect(textOf(bySrc(r.messages, 'lore_before')!)).toBe('<wi>B text</wi>');
    expect(textOf(bySrc(r.messages, 'lore_after')!)).toBe('<wi>A text</wi>');
    expect(textOf(bySrc(r.messages, 'examples')!)).toBe('<START>\nMira: ex');
    expect(textOf(bySrc(r.messages, 'author_note')!)).toBe('N text');
    expect(textOf(bySrc(r.messages, 'lore:lib:D')!)).toBe('D text');
    expect(textOf(bySrc(r.messages, 'lore:top')!)).toBe('T text');
  });

  test('a blank format is no format; an empty slot stays empty (its block drops out)', () => {
    expect(textOf(bySrc(withLore(entries, { preset: wi('   ') }).messages, 'lore_before')!)).toBe('B text');
    const none = withLore([], { preset: wi('<wi>{0}</wi>') });
    expect(bySrc(none.messages, 'lore_before')).toBeUndefined();
    expect(allText(none.messages)).not.toContain('<wi>');
  });
});

describe('outlets (ST {{outlet::name}})', () => {
  const p = (formats?: Preset['formats']): Preset =>
    preset([{ id: 'known', role: 'system', enabled: true, content: 'Known: {{outlet::x}}', at: 'relative' }, HISTORY_BLOCK], formats ? { formats } : {});
  const entries = [
    always('O1', { position: { outlet: 'x' }, order: 2 }),
    always('O2', { position: { outlet: ' x ' }, order: 1 }),
    always('O3', { position: { outlet: 'y' } }),
  ];

  test('sent only where a preset names it; names trimmed; never wrapped by wi_format', () => {
    const r = withLore(entries, { preset: p({ wi: '<wi>{0}</wi>' }) });
    expect(textOf(bySrc(r.messages, 'known')!)).toBe('Known: O2 text\nO1 text');
    expect(allText(r.messages)).not.toContain('O3 text');
    expect(r.trace.lore.fired.map((f) => f.id).sort()).toEqual(['O1', 'O2', 'O3']);
  });

  test('outlet names are case-sensitive, as in ST', () => {
    const r = withLore([always('O', { position: { outlet: 'X' } })], { preset: p() });
    expect(textOf(bySrc(r.messages, 'known')!)).toBe('Known: ');
  });
});

describe('example-message entries are example dialogue (ST parseMesExamples)', () => {
  const card = { ...MIRA, examples: '<START>\nMira: hi there' };
  const entries = [
    always('EB', { position: 'examples_before', content: 'Mira: one\n<START>\nMira: two' }),
    always('EA', { position: 'examples_after', content: 'Mira: last' }),
  ];

  test('before the card examples, after them, each chunk headed; one newline at each seam', () => {
    const r = withLore(entries, { cast: { character: card } });
    expect(textOf(bySrc(r.messages, 'examples')!)).toBe('<START>\nMira: one\n<START>\nMira: two\n<START>\nMira: hi there\n<START>\nMira: last');
  });

  test('new_example_chat_prompt heads every chunk, lore and card alike', () => {
    const r = withLore(entries, { cast: { character: card }, preset: { ...BUILTIN_PRESET, formats: { newExampleChat: '[Example Chat]' } } });
    expect(textOf(bySrc(r.messages, 'examples')!)).toBe('[Example Chat]\nMira: one\n[Example Chat]\nMira: two\n[Example Chat]\nMira: hi there\n[Example Chat]\nMira: last');
  });

  test('a blank new_example_chat_prompt heads nothing: no literal <START> reaches the model, lore and card alike', () => {
    // Regression: the importer keeps an ST file's '' as is, and formatExamples then sent the raw
    // text, <START> lines included. In ST <START> is only a separator and the empty header is dropped.
    const r = withLore(entries, { cast: { character: card }, preset: { ...BUILTIN_PRESET, formats: { newExampleChat: '' } } });
    const text = textOf(bySrc(r.messages, 'examples')!);
    expect(text).not.toContain('<START>');
    expect(text).toBe('Mira: one\nMira: two\nMira: hi there\nMira: last');
  });

  test("before-entries run in DESCENDING order (ST unshifts them twice), after-entries ascending", () => {
    const r = withLore([
      always('B10', { position: 'examples_before', order: 10, content: 'Mira: b10' }),
      always('B30', { position: 'examples_before', order: 30, content: 'Mira: b30' }),
      always('B20', { position: 'examples_before', order: 20, content: 'Mira: b20' }),
      always('A20', { position: 'examples_after', order: 20, content: 'Mira: a20' }),
      always('A10', { position: 'examples_after', order: 10, content: 'Mira: a10' }),
    ], { cast: { character: card } });
    expect(textOf(bySrc(r.messages, 'examples')!).split('\n').filter((l) => l !== '<START>')).toEqual([
      'Mira: b30',
      'Mira: b20',
      'Mira: b10',
      'Mira: hi there',
      'Mira: a10',
      'Mira: a20',
    ]);
  });

  test('without card examples the two sides still meet on one newline, with none at the edges', () => {
    expect(textOf(bySrc(withLore(entries).messages, 'examples')!)).toBe('<START>\nMira: one\n<START>\nMira: two\n<START>\nMira: last');
    expect(textOf(bySrc(withLore([entries[1]!]).messages, 'examples')!)).toBe('<START>\nMira: last');
    expect(textOf(bySrc(withLore([entries[0]!]).messages, 'examples')!)).toBe('<START>\nMira: one\n<START>\nMira: two');
  });
});

describe("author's note with AN-top / AN-bottom lore (ST world-info.js, authors-note.js)", () => {
  const entries = [always('NB', { position: 'note_before' }), always('NA', { position: 'note_after' })];

  test("wraps the note at the note's depth and role, macros in the note expanded", () => {
    const r = withLore(entries, { authorNote: { text: 'Keep it short, {{char}}.', depth: 2, role: 'user' } });
    const at = r.messages.findIndex((x) => x.src === 'author_note');
    expect(lines([r.messages[at]!])).toEqual(['user|author_note|NB text\nKeep it short, Mira.\nNA text']);
    // Depth 2: two chat messages after it.
    expect(r.messages.slice(at + 1).map((x) => x.src)).toEqual(['history', 'history']);
  });

  test('a note without AN lore is sent as written (M1)', () => {
    const r = withLore([], { authorNote: { text: '  Keep it short.  ', depth: 2, role: 'user' } });
    expect(textOf(bySrc(r.messages, 'author_note')!)).toBe('  Keep it short.  ');
  });

  test("no note: ST's default place, depth 4 as system; the empty note leaves its blank line", () => {
    const r = withLore(entries);
    const at = r.messages.findIndex((x) => x.src === 'author_note');
    expect(lines([r.messages[at]!])).toEqual(['system|author_note|NB text\n\nNA text']);
    expect(r.messages.slice(at + 1).filter((x) => x.src === 'history')).toHaveLength(4);
  });

  test('only one side: no stray newline', () => {
    expect(textOf(bySrc(withLore([entries[0]!]).messages, 'author_note')!)).toBe('NB text');
    expect(textOf(bySrc(withLore([entries[1]!]).messages, 'author_note')!)).toBe('NA text');
  });

  test("a blank note keeps its depth and role for the lore", () => {
    const r = withLore([entries[0]!], { authorNote: { text: '   ', depth: 1, role: 'user' } });
    const at = r.messages.findIndex((x) => x.src === 'author_note');
    expect(lines([r.messages[at]!])).toEqual(['user|author_note|NB text']);
    expect(r.messages.slice(at + 1).map((x) => x.src)).toEqual(['history']);
  });
});

describe('in-chat lore at equal depth (§10.1 source rank, as SillyTavern)', () => {
  test("world info sits in ST's order-100 extension group: preset < author's note < card depth < lore; an entry's order only sorts the lore", () => {
    const p: Preset = {
      ...BUILTIN_PRESET,
      blocks: [...BUILTIN_PRESET.blocks, { id: 'pdepth', role: 'system', enabled: true, content: 'P', at: { depth: 1 } }],
    };
    const r = withLore([always('L', { position: { depth: 1 } }), always('L0', { position: { depth: 1 }, order: 50 })], {
      preset: p,
      cast: { character: { ...MIRA, depthPrompt: { text: 'C', depth: 1, role: 'system' } } },
      authorNote: { text: 'N', depth: 1, role: 'system' },
    });
    const at = r.messages.findIndex((x) => x.src === 'preset:pdepth');
    expect(r.messages.slice(at).map((x) => `${x.src}|${textOf(x)}`)).toEqual([
      'preset:pdepth|P',
      'author_note|N',
      'card_depth|C',
      'lore:lib:L0|L0 text',
      'lore:lib:L|L text',
      'history|Show me the map.',
    ]);
  });

  test("the review's case: preset 100 and 150, an author's note, world info at order 10 and 200, all at depth 1", () => {
    // ST (openai.js populationInjectionPrompts): 'P100\nAN\nW10\nW200', then 'P150'. rp-core keeps
    // the messages apart (D-47) in that order. Before the fix: W10, P100, AN, P150, W200.
    const p: Preset = {
      ...BUILTIN_PRESET,
      blocks: [
        ...BUILTIN_PRESET.blocks,
        { id: 'p100', role: 'system', enabled: true, content: 'P100', at: { depth: 1, order: 100 } },
        { id: 'p150', role: 'system', enabled: true, content: 'P150', at: { depth: 1, order: 150 } },
      ],
    };
    const r = withLore([always('W10', { position: { depth: 1 }, order: 10 }), always('W200', { position: { depth: 1 }, order: 200 })], {
      preset: p,
      authorNote: { text: 'AN', depth: 1, role: 'system' },
    });
    const at = r.messages.findIndex((x) => x.src === 'preset:p100');
    expect(r.messages.slice(at, at + 5).map((x) => textOf(x))).toEqual(['P100', 'AN', 'W10 text', 'W200 text', 'P150']);
  });
});

describe('a slot the preset does not hold is not sent (ST)', () => {
  test('disabled lore_before block: the entry fired, nothing sent', () => {
    const p: Preset = { ...BUILTIN_PRESET, blocks: BUILTIN_PRESET.blocks.map((b) => (b.id === 'lore_before' ? { ...b, enabled: false } : b)) };
    const r = withLore([always('B'), always('A', { position: 'after' })], { preset: p });
    expect(r.trace.lore.fired.map((f) => f.id).sort()).toEqual(['A', 'B']);
    expect(allText(r.messages)).not.toContain('B text');
    expect(textOf(bySrc(r.messages, 'lore_after')!)).toBe('A text');
  });

  test('an unknown lore slot name renders empty', () => {
    const p = preset([{ id: 'odd', role: 'system', enabled: true, content: 'Odd: [{{lore::sideways}}]', at: 'relative' }, HISTORY_BLOCK]);
    const r = ok(assemble(input({ view: longView(), preset: p, lorebooks: [source('lib', [always('B')])] })));
    expect(textOf(bySrc(r.messages, 'odd')!)).toBe('Odd: []');
  });
});
