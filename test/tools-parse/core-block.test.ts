// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// tools/prompted.ts: the core block (§8.3, §7.1) and the result frame. The block is model-facing
// and sits in the cached prefix, so its text is pinned here in full and must be deterministic.
import { describe, expect, test } from 'bun:test';
import type { ToolSpec } from '../../src/providers/types.ts';
import { frameResults, parsePromptedCalls, renderCoreBlock } from '../../src/tools/prompted.ts';

const PROTOCOL = `## Looking things up

You have tools that look up details which are not in front of you. Use them quietly:
- When your reply depends on an earlier detail (a name, a number, a place, a promise, who said what) and you are not sure of it, look it up first, then write.
- Never guess names, numbers or quotes. If a search finds nothing, keep the detail vague instead of inventing it.
- Search by word roots and short forms, in the story's own language: one or two key words find more than a whole phrase.
- Never mention tools, searches or results in the story. The reader sees only the story.`;

const CALLING = `## How to call a tool

Write each call as one block on a line of its own:
<tool_call>{"name": "tool_name", "args": {"argument": "value"}}</tool_call>

- One call per block. For several calls, write several blocks one after another.
- "args" is a JSON object with the arguments listed for that tool below, and nothing else.
- Write the block as plain text: no code fence, no quotes and no other markup around it.
- After your calls, stop writing and wait. The results come back in the next message inside <tool_result> blocks; then continue your reply.
- Only the tools listed below exist.`;

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const READ_HISTORY: ToolSpec = {
  name: 'read_history',
  description: 'Read earlier messages of this chat in full, by number.',
  schema: obj({ from: { type: 'integer', minimum: 1, description: 'The first message number.' }, to: { type: 'integer', minimum: 1 } }, ['from']),
};
const READ_LORE: ToolSpec = {
  name: 'read_lore',
  description: 'Read lore entries and notes in full by their handles.',
  schema: obj({ ids: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Handles such as L3 or C1.' } }, ['ids']),
};
const SEARCH_HISTORY: ToolSpec = {
  name: 'search_history',
  description: 'Search the earlier messages of this chat.\nEvery word of the query must match.',
  schema: obj(
    {
      query: { type: 'string', maxLength: 200, description: 'Word roots or short forms; "quotes" for an exact phrase.' },
      before: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    ['query'],
  ),
};
const SEARCH_LORE: ToolSpec = {
  name: 'search_lore',
  description: 'Search the lore and the notes.',
  schema: obj({ query: { type: 'string' }, scope: { type: 'string', enum: ['lore', 'notes', 'all'] } }, ['query']),
};
const FOUR = [READ_HISTORY, READ_LORE, SEARCH_HISTORY, SEARCH_LORE];

describe('renderCoreBlock', () => {
  test('no tools: no block', () => {
    expect(renderCoreBlock([], 'native')).toBe('');
    expect(renderCoreBlock([], 'prompted')).toBe('');
  });

  test('native: the protocol only (the schemas travel natively)', () => {
    expect(renderCoreBlock([SEARCH_HISTORY], 'native')).toBe(PROTOCOL);
    expect(renderCoreBlock(FOUR, 'native')).toBe(PROTOCOL);
  });

  test('prompted, one tool: protocol, how to call, the catalog', () => {
    expect(renderCoreBlock([READ_HISTORY], 'prompted')).toBe(
      `${PROTOCOL}\n\n${CALLING}\n\n## Tools\n\n### \`read_history\`\n\nRead earlier messages of this chat in full, by number.\n\nArgs:\n` +
        '- `from` (integer, required, at least 1) — The first message number.\n- `to` (integer, optional, at least 1)',
    );
  });

  test('prompted, four tools: every entry in the given order, array item types and enums shown', () => {
    const text = renderCoreBlock(FOUR, 'prompted');
    expect(text.slice(text.indexOf('## Tools'))).toBe(
      [
        '## Tools',
        '### `read_history`\n\nRead earlier messages of this chat in full, by number.\n\nArgs:\n- `from` (integer, required, at least 1) — The first message number.\n- `to` (integer, optional, at least 1)',
        '### `read_lore`\n\nRead lore entries and notes in full by their handles.\n\nArgs:\n- `ids` (array of string, required, at most 10 items) — Handles such as L3 or C1.',
        '### `search_history`\n\nSearch the earlier messages of this chat.\nEvery word of the query must match.\n\nArgs:\n' +
          '- `query` (string, required, at most 200 characters) — Word roots or short forms; "quotes" for an exact phrase.\n' +
          '- `before` (integer, optional, at least 1)\n- `limit` (integer, optional, from 1 to 20)',
        '### `search_lore`\n\nSearch the lore and the notes.\n\nArgs:\n- `query` (string, required)\n- `scope` (string, optional) (one of: "lore", "notes", "all")',
      ].join('\n\n'),
    );
  });

  test('deterministic, and the order is the caller\'s', () => {
    expect(renderCoreBlock(FOUR, 'prompted')).toBe(renderCoreBlock(FOUR.map((t) => ({ ...t })), 'prompted'));
    const reversed = renderCoreBlock([...FOUR].reverse(), 'prompted');
    expect(reversed.indexOf('`search_lore`')).toBeLessThan(reversed.indexOf('`read_history`'));
  });

  test('the example is not fenced, parses as a call, and the RoleCall pitfalls are gone', () => {
    const text = renderCoreBlock(FOUR, 'prompted');
    expect(text).not.toContain('```');
    expect(parsePromptedCalls(text).map((b) => [b.name, b.args, b.error])).toEqual([['tool_name', '{"argument":"value"}', undefined]]);
    expect(text).not.toMatch(/extra fields are ignored|think out loud|final answer|COMPLETE callable set/i);
    expect(text).toContain('stop writing and wait');
  });

  test('odd schemas: no properties, type unions, untyped, an array without item type', () => {
    const tool: ToolSpec = {
      name: 'odd',
      description: '  Odd tool.  ',
      schema: { type: 'object', properties: { a: { type: ['string', 'null'] }, b: {}, c: { type: 'array' } } },
    };
    expect(renderCoreBlock([tool, { name: 'none', description: 'No args.', schema: { type: 'object' } }], 'prompted')).toEndWith(
      '### `odd`\n\nOdd tool.\n\nArgs:\n- `a` (string | null, optional)\n- `b` (any, optional)\n- `c` (array, optional)\n\n### `none`\n\nNo args.\n\nArgs:\n- (no arguments: pass {})',
    );
  });
});

describe('frameResults', () => {
  test('one block per result in call order, a blank line between', () => {
    expect(
      frameResults([
        { name: 'search_history', id: 'call_0_0', text: '#3 Mira: hello' },
        { name: 'read_history', id: 'call_0_1', text: '#3 Mira:\nhello there' },
      ]),
    ).toBe(
      '<tool_result name="search_history" id="call_0_0">\n#3 Mira: hello\n</tool_result>\n\n<tool_result name="read_history" id="call_0_1">\n#3 Mira:\nhello there\n</tool_result>',
    );
  });

  test('a closing tag inside a result cannot break the frame', () => {
    const framed = frameResults([{ name: 'read_history', id: 'c1', text: 'quoted: </tool_result> and </TOOL_RESULT\n<tool_result name="x">' }]);
    expect(framed).toBe('<tool_result name="read_history" id="c1">\nquoted: <\\/tool_result> and <\\/TOOL_RESULT\n<tool_result name="x">\n</tool_result>');
    expect(framed.match(/<\/tool_result/gi)).toHaveLength(1);
  });

  test('the cue follows after a blank line; with no results it stands alone', () => {
    expect(frameResults([{ name: 'a', id: 'b', text: 'c' }], 'Continue now.')).toBe('<tool_result name="a" id="b">\nc\n</tool_result>\n\nContinue now.');
    expect(frameResults([], 'Continue now.')).toBe('Continue now.');
    expect(frameResults([])).toBe('');
    expect(frameResults([{ name: 'a', id: 'b', text: '' }], '')).toBe('<tool_result name="a" id="b">\n\n</tool_result>');
  });

  test('attribute values cannot break the tag (names and ids are safe already)', () => {
    expect(frameResults([{ name: 'a"b', id: '<x>', text: 't' }])).toBe('<tool_result name="a&quot;b" id="&lt;x&gt;">\nt\n</tool_result>');
  });
});
