// Unit tests for the assemble helpers: slots, formats, guidance text, hashes.
import { describe, expect, test } from 'bun:test';
import {
  applyFormat,
  fillSlots,
  formatExamples,
  historySlots,
  protectSlots,
  renderSlot,
  soleMacro,
  splitAtHistory,
  type SlotRef,
} from '../../src/prompt/assemble/slots.ts';
import { clip, fence, guidanceText, REJECTED_DRAFT_LABEL } from '../../src/prompt/assemble/guidance.ts';
import { canonicalJson, shortHash } from '../../src/prompt/assemble/hash.ts';
import { blockSrc } from '../../src/prompt/assemble.ts';

describe('slots', () => {
  test('only top-level, unescaped slot tags count', () => {
    expect(historySlots('{{history}}')).toBe(1);
    expect(historySlots('a {{ History }} b')).toBe(1);
    expect(historySlots('\\{{history}}')).toBe(0);
    expect(historySlots('{{random::{{history}}}}')).toBe(0);
    expect(historySlots('{{// {{history}} }}')).toBe(0);
    expect(historySlots('{{history::x}}')).toBe(0);
  });

  test('protect → expand → fill round trip keeps text and numbers slots globally', () => {
    const refs: SlotRef[] = [];
    const a = protectSlots('A {{lore::before}} B', refs);
    const b = protectSlots('{{recap}}|{{history}}|{{outlet::Diary}}', refs);
    expect(refs).toEqual([{ kind: 'lore', name: 'before' }, { kind: 'recap' }, { kind: 'history' }, { kind: 'outlet', name: 'Diary' }]);
    const value = (r: SlotRef) => (r.kind === 'history' ? '' : `<${r.kind}${'name' in r ? ':' + r.name : ''}>`);
    expect(fillSlots(a, refs, value)).toBe('A <lore:before> B');
    const split = splitAtHistory(b, refs)!;
    expect(split.map((s) => fillSlots(s, refs, value))).toEqual(['<recap>|', '|<outlet:Diary>']);
    expect(splitAtHistory(a, refs)).toBeNull();
  });

  test('a sentinel number nobody registered is left alone', () => {
    expect(fillSlots('x﷐7﷑y', [], () => 'z')).toBe('x﷐7﷑y');
  });

  test('example slots meet their neighbours on one newline (M2), other slots are glued as written', () => {
    const refs: SlotRef[] = [];
    const t = protectSlots('{{lore::examples_before}}{{lore::examples_after}}|{{lore::before}}{{lore::after}}', refs);
    const all = (r: SlotRef) => ('name' in r ? r.name.toUpperCase() : '');
    expect(fillSlots(t, refs, all)).toBe('EXAMPLES_BEFORE\nEXAMPLES_AFTER|BEFOREAFTER');
    // Empty neighbours add nothing; an existing newline is not doubled.
    const one = (name: string) => (r: SlotRef) => ('name' in r && r.name === name ? 'X' : '');
    expect(fillSlots(t, refs, one('examples_before'))).toBe('X\n|');
    const lone: SlotRef[] = [];
    expect(fillSlots(protectSlots('{{lore::examples_before}}', lone), lone, () => 'X')).toBe('X');
    const nl: SlotRef[] = [];
    expect(fillSlots(protectSlots('A\n{{lore::examples_after}}', nl), nl, () => 'X')).toBe('A\nX');
    expect(fillSlots(protectSlots('A{{lore::examples_after}}', nl), nl, () => 'X')).toBe('A\nX');
  });

  test('soleMacro recognises a block that is exactly one argless macro', () => {
    expect(soleMacro('{{personality}}')).toBe('personality');
    expect(soleMacro('  {{Scenario}}\n')).toBe('scenario');
    expect(soleMacro('x {{personality}}')).toBeNull();
    expect(soleMacro('{{getvar::x}}')).toBeNull();
  });
});

describe('formats (D-70)', () => {
  test('applyFormat replaces every {0}, literally', () => {
    expect(applyFormat('[{0}] ({0})', 'v $& $1')).toBe('[v $& $1] (v $& $1)');
    expect(applyFormat(undefined, 'v')).toBe('v');
    expect(applyFormat('', 'v')).toBe('v');
  });

  test('wi_format wraps non-empty lore::before / lore::after values only (ST formatWorldInfo)', () => {
    const formats = { wi: '<lore>{0}</lore>' };
    expect(renderSlot({ kind: 'lore', name: 'before' }, 'L', formats)).toBe('<lore>L</lore>');
    expect(renderSlot({ kind: 'lore', name: 'After' }, 'L', formats)).toBe('<lore>L</lore>');
    // ST sends outlets and example entries unwrapped.
    expect(renderSlot({ kind: 'outlet', name: 'x' }, 'O', formats)).toBe('O');
    expect(renderSlot({ kind: 'lore', name: 'examples_before' }, 'E', formats)).toBe('E');
    expect(renderSlot({ kind: 'lore', name: 'before' }, '', formats)).toBe('');
    expect(renderSlot({ kind: 'recap' }, 'R', formats)).toBe('R');
    // A blank format is no format.
    expect(renderSlot({ kind: 'lore', name: 'before' }, 'L', { wi: '  ' })).toBe('L');
  });

  test('example chats are headed by new_example_chat_prompt; a missing first <START> is implied (ST)', () => {
    expect(formatExamples('a\n<START>\nb\n<start>\n\n', '[Example Chat]')).toBe('[Example Chat]\na\n[Example Chat]\nb');
    expect(formatExamples('<START>\na', undefined)).toBe('<START>\na');
    expect(formatExamples('   ', '[E]')).toBe('   ');
    // present but blank: <START> only separates, nothing heads the chunks (ST drops the empty header)
    expect(formatExamples('<START>\na\n<START>\nb', '')).toBe('a\nb');
  });
});

describe('guidance text (D-41)', () => {
  test('clip counts code points and marks the cut', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcd', 3)).toBe('ab…');
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…');
  });

  test('fence outgrows any backtick run inside', () => {
    expect(fence('plain')).toBe('```\nplain\n```');
    expect(fence('a ```` b')).toBe('`````\na ```` b\n`````');
  });

  test('with and without a draft', () => {
    const withDraft = guidanceText('  Be kinder.  ', 'old text');
    expect(withDraft).toContain('USER DIRECTION:\nBe kinder.\n');
    expect(withDraft).toContain(`${REJECTED_DRAFT_LABEL}\n\`\`\`\nold text\n\`\`\`\n<<<END GUIDED SWIPE DIRECTIVE>>>`);
    const without = guidanceText('Be kinder.', '   ');
    expect(without).not.toContain(REJECTED_DRAFT_LABEL);
    expect(without).not.toContain('Read the draft');
    expect(without.endsWith('Be kinder.\n<<<END GUIDED SWIPE DIRECTIVE>>>')).toBe(true);
  });
});

describe('hash', () => {
  test('canonical JSON sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
    expect(shortHash({ a: 1, b: 2 })).toBe(shortHash({ b: 2, a: 1 }));
    expect(shortHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

test('blockSrc keeps preset blocks apart from chat messages', () => {
  expect(blockSrc('main')).toBe('main');
  expect(blockSrc('history')).toBe('block:history');
  expect(blockSrc('history:x')).toBe('block:history:x');
  expect(blockSrc('historyish')).toBe('historyish');
});
