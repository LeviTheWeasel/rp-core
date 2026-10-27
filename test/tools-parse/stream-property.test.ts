// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// tools/prompted.ts: the promise of §8.3 that the live text equals the stored one. For 50 replies
// generated from a seeded RNG (RP prose in two languages, calls in every form the parser takes,
// fences around and inside them, code blocks, look-alikes, cut-off tails), every chunking (char by
// char, every two-way split, 20 random ones) gives exactly stripPromptedCalls(reply). A token soup
// run (thousands of short random texts) guards the corner cases the replies do not reach.
import { describe, expect, test } from 'bun:test';
import { subRng, type Rng } from '../../src/prompt/rng.ts';
import { createPromptedStripper, parsePromptedCalls, stripPromptedCalls } from '../../src/tools/prompted.ts';

const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const PROSE = [
  'She wiped the counter and did not look up.',
  'Трактирщица вздохнула: «Мой брат ушёл с караваном».',
  '"You remember the lantern?" he asked.',
  'Ветер стучал ставнями, а свеча почти догорела.',
  'A cat < a lion, but only just > a mouse.',
  'Mira laughed — the kind of laugh that hides a knife.',
  '*He leans closer.* "Tell me again."',
  'Use `code` here, or ~maybe~ there.',
];
const CALLS = [
  '<tool_call>{"name": "search_history", "args": {"query": "брат"}}</tool_call>',
  '<tool_call name="read_history">{"from": 12, "to": 14}</tool_call>',
  '<tool_call>\n{"name": "search_lore", "arguments": {"query": "lantern"}}\n</tool_call>',
  '<tool_call>\n```json\n{"name": "read_lore", "args": {"ids": ["L1"]}}\n```\n</tool_call>',
  '<TOOL_CALL>{"name": "search_history", "parameters": {"query": "Мира"}}</tool_call >',
  '<tool_call name="search_lore" />',
  '<tool_calls>[{"name": "a", "args": {}}, {"name": "b", "args": {}}]</tool_calls>',
  '<tool_call>search_history(query="караван")</tool_call>',
  '<tool_call>{"name": "x", "args": {"q": "a < b"}}</tool_call>',
];
const TAILS = [
  '',
  '',
  '\n<tool_call>{"name": "search_history", "args": {"query": "бр',
  ' <tool_c',
  '\n<tool_result name="search_history">#3 Mira: hello</tool_result>\nMore text.',
  '</tool_call>',
  '\n\n   ',
  '\n```',
];
const SEPS = [' ', '\n', '\n\n', '', '  ', '\n \n'];

/** One generated reply: prose and calls, some calls fenced, maybe a code block, maybe a cut tail. */
function reply(r: Rng): string {
  let out = r() < 0.3 ? pick(r, ['  ', '\n', '']) : '';
  const parts = 2 + Math.floor(r() * 7);
  for (let i = 0; i < parts; i++) {
    const roll = r();
    if (roll < 0.45) out += pick(r, PROSE);
    else if (roll < 0.75) out += pick(r, CALLS);
    else if (roll < 0.9) {
      const fence = pick(r, ['```', '~~~', '````', '```json']);
      const close = fence.startsWith('`') ? fence.replace('json', '') : fence;
      out += `${fence}\n${pick(r, CALLS)}${r() < 0.3 ? `\n${pick(r, CALLS)}` : ''}\n${pick(r, [close, close, '```', '~~~'])}`;
    } else out += `\`\`\`\nlet x = 1 < 2;\n\`\`\``;
    out += pick(r, SEPS);
  }
  return out + pick(r, TAILS);
}

function streamed(parts: readonly string[]): string {
  const s = createPromptedStripper();
  let out = '';
  for (const p of parts) out += s.push(p);
  return out + s.end();
}

function randomChunks(r: Rng, text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const n = 1 + Math.floor(r() * (r() < 0.5 ? 4 : 40));
    out.push(text.slice(at, at + n));
    at += n;
  }
  return out;
}

describe('stream === batch on 50 generated replies', () => {
  const gen = subRng(20261026, 'tools-parse.replies');
  const replies = Array.from({ length: 50 }, () => reply(gen));

  test('the generator covers calls, fences, tails and look-alikes', () => {
    const all = replies.join('\n');
    for (const needle of ['<tool_call name=', '```\n<tool_call', '~~~', '<tool_result', '<tool_c', 'a < b', '<TOOL_CALL>', '<tool_calls>']) {
      expect(all).toContain(needle);
    }
    expect(replies.reduce((n, t) => n + parsePromptedCalls(t).length, 0)).toBeGreaterThan(80);
  });

  replies.forEach((text, i) => {
    test(`reply ${i}`, () => {
      const batch = stripPromptedCalls(text);
      expect(streamed([...text])).toBe(batch);
      for (let k = 0; k <= text.length; k++) expect(streamed([text.slice(0, k), text.slice(k)])).toBe(batch);
      const r = subRng(i, 'tools-parse.chunks');
      for (let n = 0; n < 20; n++) expect(streamed(randomChunks(r, text))).toBe(batch);
      // Nothing a block was made of is left in the text.
      expect(batch).not.toMatch(/<\s*\/?\s*tool_(call|result)/i);
    });
  });
});

describe('stream === batch on a token soup', () => {
  const TOKENS = [
    'Hello', 'мир', ' ', '  ', '\n', '\n\n', '\t', '\r\n', '```', '```json', '~~~', '````', '``', '`', '~', 'x', 'ё', '😀',
    '<tool_call>{"name":"a","args":{"q":"b"}}</tool_call>', '<tool_call name="a">{"q":1}</tool_call>', '<tool_call name="a" />',
    '<tool_call>', '</tool_call>', '<TOOL_CALL>{"name":"a"}</Tool_Call >', '< tool_call>{"name":"a"}', '<tool_calls>[{"name":"a"}]</tool_calls>',
    '<tool_calls>', '</tool_calls>', '<tool_result name="a">r</tool_result>', '</tool_result>', '<tool_result', '<', '< ', '<b>', 'a < b',
    '<tool_c', '<tool_call', '</tool_ca', '>', '{"x":1}', '{"name":"a","args":{}}', '\n```\n', '  ```\n', '\n~~~~\n',
    '<tool_call>\n```json\n{"name":"a"}\n```\n</tool_call>',
  ];
  test('4000 texts, random chunkings', () => {
    const r = subRng(7, 'tools-parse.soup');
    let failures = 0;
    for (let i = 0; i < 4000; i++) {
      let text = '';
      for (let n = 1 + Math.floor(r() * 20); n > 0; n--) text += pick(r, TOKENS);
      const batch = stripPromptedCalls(text);
      const parts = i % 2 === 0 ? [...text] : randomChunks(r, text);
      if (streamed(parts) !== batch) failures++;
    }
    expect(failures).toBe(0);
  });
});

describe('stream === batch on unclosed blocks followed by prose (review: unclosed-complete-json-then-prose)', () => {
  /** A complete call left unclosed with prose after it (the block ends after the value), and look-alikes that stay cut off. */
  const UNCLOSED = [
    '<tool_call>{"name": "search_lore", "args": {"query": "x"}}\nThe tavern was quiet that night.',
    '<tool_call>search_history(query="брат (старший)")\nОна кивнула.',
    '<tool_call name="read_lore">{"ids": ["L1"]}\n*She nods.*',
    '<tool_call>\n```json\n{"name": "a", "args": {}}\n```\nAfter that, silence.',
    '```\n<tool_call>{"name": "a", "args": {}}\n```\nAfter.',
    '<tool_call>{"query": "x"} and then she left.',
    '<tool_call>json {"name": "a", "args": {}} Then.',
    '<tool_call>[{"name": "a"}, {"name": "b"}]\nBoth done.',
    '<tool_calls>[{"name": "a", "args": {}}]\nДальше.',
    '<tool_call>[read_history(from=1, to=2)]  ~quiet~',
    '<tool_call>{"name": "a"}\n{"name": "b"',
    '<tool_call>{"name": "a"}</tool_cal',
    '<tool_call>{"name": "a"}\n[OOC]',
    '<tool_call>{"name": "a"}\nsearch_lore(q="y")',
    // Residue, comma-separated calls, prose that opens like markup (review: parse-residue-raw-markup).
    '<tool_call>{"name": "a", "args": {}}}\nThe tavern was quiet that night.',
    '<tool_call>{"name": "a", "args": {}}, {"name": "b", "args": {}}\nShe waits.',
    '<tool_call>[f(q="x"), g(q="y")]\nShe waits.',
    '<tool_call>{"name": "a", "args": {}},',
    '<tool_call>{"name": "a", "args": {}}\n[OOC: thanks]',
    '<tool_call>{"name": "a", "args": {}}<br>She smiles.',
    '<tool_call>search_lore(query="x")\nThe end.\n(OOC: hope that works)',
  ];

  function unclosedReply(r: Rng): string {
    let out = '';
    const parts = 1 + Math.floor(r() * 5);
    for (let i = 0; i < parts; i++) {
      const roll = r();
      out += roll < 0.45 ? pick(r, UNCLOSED) : roll < 0.7 ? pick(r, PROSE) : pick(r, CALLS);
      out += pick(r, SEPS);
    }
    return out + (r() < 0.3 ? pick(r, TAILS) : '');
  }

  const gen = subRng(20261027, 'tools-parse.unclosed');
  const replies = [...UNCLOSED, ...Array.from({ length: 40 }, () => unclosedReply(gen))];

  test('the replies keep prose after unclosed calls', () => {
    expect(stripPromptedCalls(UNCLOSED[0]!)).toBe('The tavern was quiet that night.');
    expect(replies.filter((t) => stripPromptedCalls(t).includes('The tavern was quiet that night.')).length).toBeGreaterThan(3);
  });

  replies.forEach((text, i) => {
    test(`reply ${i}`, () => {
      const batch = stripPromptedCalls(text);
      expect(streamed([...text])).toBe(batch);
      for (let k = 0; k <= text.length; k++) expect(streamed([text.slice(0, k), text.slice(k)])).toBe(batch);
      const r = subRng(i, 'tools-parse.unclosed.chunks');
      for (let n = 0; n < 20; n++) expect(streamed(randomChunks(r, text))).toBe(batch);
      // No tag and no call JSON is left in the text, nor punctuation a call left behind.
      expect(batch).not.toMatch(/<\s*\/?\s*tool_(call|result)/i);
      expect(batch).not.toContain('"name"');
      expect(batch).not.toMatch(/(?:^|\n)\s*[,;}\])]/);
    });
  });

  test('a token soup of values, python calls, fences and prose: 4000 texts, random chunkings', () => {
    const TOKENS = [
      '<tool_call>', '<tool_call name="a">', '<tool_calls>', '</tool_call>', '{"name":"a","args":{}}', '{"q":1}', '[{"name":"a"}]', 'f(q="x")',
      '[f(q=1)]', 'f(', ')', '(', '{', '}', '[', ']', '"', "'", 'json', '```json\n', '```', '~~~', '\n', ' ', '\n\n', 'The end.', 'Она ушла.',
      '<tool_result>', '<', 'x', '\\', '"""', ',', ', ', ';', '}}', ')]', '[OOC: ok]', '<i>', '<br>', 'g(q=2)',
    ];
    const r = subRng(11, 'tools-parse.unclosed.soup');
    let failures = 0;
    for (let i = 0; i < 4000; i++) {
      let text = '';
      for (let n = 1 + Math.floor(r() * 16); n > 0; n--) text += pick(r, TOKENS);
      const batch = stripPromptedCalls(text);
      const parts = i % 2 === 0 ? [...text] : randomChunks(r, text);
      if (streamed(parts) !== batch) failures++;
    }
    expect(failures).toBe(0);
  });
});
