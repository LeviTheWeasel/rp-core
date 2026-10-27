// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-97 (.notes/m3-decisions.md L): an offered tool's name used as a tag is a call of that tool.
// tools/prompted.ts parsePromptedCalls / stripPromptedCalls / createPromptedStripper with the
// offered tools, and tools/leaks.ts recoverLeaks with their specs: the three body rules, the tag
// forms, unclosed tags, stray closers, fences and seams, names that are not offered, the no-tools
// path, and the streaming stripper on a tag split at every offset.
import { describe, expect, test } from 'bun:test';
import { HISTORY_TOOLS, LORE_TOOLS, toolSpecs } from '../../src/tools/builtin/index.ts';
import { parseToolArgs } from '../../src/tools/args.ts';
import { recoverLeaks } from '../../src/tools/leaks.ts';
import { createPromptedStripper, parsePromptedCalls, stripPromptedCalls, type OfferedTool } from '../../src/tools/prompted.ts';
import type { ToolSpec } from '../../src/providers/types.ts';
import { subRng, type Rng } from '../../src/prompt/rng.ts';

const ALL = toolSpecs([...HISTORY_TOOLS(), ...LORE_TOOLS()]);
const LORE = toolSpecs(LORE_TOOLS());
const HISTORY = toolSpecs(HISTORY_TOOLS());
const spec = (name: string): ToolSpec => ALL.find((t) => t.name === name)!;

/** The live model's output (magmell-16k, the second live run): the name as a tag, a made-up result inside, then prose. */
const LIVE =
  "<search_history>\nранее в диалоге не упоминалось имени брата Марфы.\n</search_history>\n\nМарфа не mentioning her brother's name…";

const calls = (text: string, tools: readonly OfferedTool[] = ALL) => parsePromptedCalls(text, tools).map((b) => ({ name: b.name, args: b.args, ...(b.error !== undefined ? { error: b.error } : {}) }));
const one = (text: string, tools: readonly OfferedTool[] = ALL) => {
  const got = calls(text, tools);
  expect(got).toHaveLength(1);
  return got[0]!;
};
/** The arguments as the tool would get them (tools/args.ts), or its error. */
const ran = (name: string, args: string) => {
  const r = parseToolArgs(args, spec(name).schema, name);
  return r.ok ? r.value : r.error;
};

function streamed(parts: readonly string[], tools: readonly OfferedTool[] = ALL): string {
  const s = createPromptedStripper(tools);
  let out = '';
  for (const p of parts) out += s.push(p);
  return out + s.end();
}

describe('the live model output (section L)', () => {
  test('one search_history call with that query; the prose after it stays prose', () => {
    expect(calls(LIVE)).toEqual([{ name: 'search_history', args: JSON.stringify({ query: 'ранее в диалоге не упоминалось имени брата Марфы.' }) }]);
    expect(ran('search_history', calls(LIVE)[0]!.args)).toEqual({ query: 'ранее в диалоге не упоминалось имени брата Марфы.' });
    expect(stripPromptedCalls(LIVE, ALL)).toBe("Марфа не mentioning her brother's name…");
    expect(streamed([...LIVE])).toBe("Марфа не mentioning her brother's name…");
  });
});

describe('BODY → arguments (D-97 rules)', () => {
  test('rule 1: a JSON envelope gives its args under any of the three keys; the name may be left out', () => {
    for (const key of ['args', 'arguments', 'parameters']) {
      const b = one(`<search_history>{"name": "search_history", "${key}": {"query": "брат", "limit": 3}}</search_history>`);
      expect(b).toEqual({ name: 'search_history', args: '{"query":"брат","limit":3}' });
    }
    expect(one('<search_history>{"args": {"query": "брат"}}</search_history>')).toEqual({ name: 'search_history', args: '{"query":"брат"}' });
    // The envelope's name in another case is still this tool's.
    expect(one('<search_history>{"name": "Search_History", "args": {"query": "брат"}}</search_history>').args).toBe('{"query":"брат"}');
  });

  test('rule 1: any other object is the arguments itself (the schema check tells the model what is wrong)', () => {
    const b = one('<search_history>{"query": "брат", "before": 40}</search_history>');
    expect(b).toEqual({ name: 'search_history', args: '{"query": "брат", "before": 40}' });
    expect(ran('search_history', b.args)).toEqual({ query: 'брат', before: 40 });
    // An envelope naming another tool is not this tool's envelope: the object is the arguments.
    const other = one('<search_history>{"name": "read_history", "args": {"from": 3}}</search_history>');
    expect(other.name).toBe('search_history');
    expect(ran('search_history', other.args)).toContain('Invalid arguments for search_history');
    // read_history takes JSON only.
    expect(ran('read_history', one('<read_history>{"from": 12, "to": 14}</read_history>').args)).toEqual({ from: 12, to: 14 });
    // A fence and a `json` word inside the tags, as in a <tool_call>.
    expect(one('<read_history>\n```json\n{"from": 2}\n```\n</read_history>').args).toBe('{"from": 2}');
  });

  test('rule 2: one required string property takes the trimmed BODY (search_history query, search_lore query)', () => {
    expect(one('<search_history>  брат Марфы \n</search_history>').args).toBe('{"query":"брат Марфы"}');
    expect(one('<search_lore>lantern</search_lore>').args).toBe('{"query":"lantern"}');
    // A closed body of several lines is all of it, trimmed.
    expect(one('<search_history>\nбрат\nсестра\n</search_history>').args).toBe('{"query":"брат\\nсестра"}');
    // Quotes and brackets in the text are text.
    expect(ran('search_history', one('<search_history>"ярмарка" [OOC]</search_history>').args)).toEqual({ query: '"ярмарка" [OOC]' });
  });

  test('rule 2: an empty BODY is a call without the argument; the tool\'s own check tells the model', () => {
    for (const text of ['<search_history></search_history>', '<search_history>  \n </search_history>', '<search_history/>', '<search_history />']) {
      const b = one(text);
      expect(b).toEqual({ name: 'search_history', args: '' });
      expect(ran('search_history', b.args)).toContain('query');
    }
  });

  test('rule 3: otherwise the call is malformed and reported like any malformed prompted call', () => {
    for (const [text, name] of [
      ['<read_history>12</read_history>', 'read_history'],
      ['<read_lore>L1, L2</read_lore>', 'read_lore'],
    ] as const) {
      const b = one(text);
      expect(b.name).toBe(name);
      expect(b.args).toBe('');
      expect(b.error).toBe(`The <${name}> block does not hold its arguments as a JSON object. Write the call as <tool_call>{"name": "${name}", "args": {…}}</tool_call>.`);
    }
    // A body that opens as JSON and does not read as JSON is malformed, not a query.
    const broken = one('<search_history>{"query": }} x}</search_history>');
    expect(broken.error).toStartWith('The <search_history> block is not readable JSON (');
    expect(broken.error).toEndWith('Write the call as <tool_call>{"name": "search_history", "args": {…}}</tool_call>.');
  });
});

describe('the tag (D-97: like the other tags)', () => {
  test('any case, whitespace after "<", attributes, an XML prefix; the closer likewise', () => {
    for (const text of [
      '<SEARCH_HISTORY>брат</search_history>',
      '<Search_History>брат</SEARCH_HISTORY >',
      '< search_history>брат< /search_history>',
      '<search_history\n>брат</search_history>',
      '<search_history query="ignored" data-x=\'1\'>брат</search_history>',
      '<ns:search_history>брат</ns:search_history>',
      '<rp:Search_History mode="x">брат</search_history>',
    ]) {
      expect(calls(`Она кивнула. ${text} Дальше.`)).toEqual([{ name: 'search_history', args: '{"query":"брат"}' }]);
      expect(stripPromptedCalls(`Она кивнула. ${text} Дальше.`, ALL)).toBe('Она кивнула. Дальше.');
    }
  });

  test('a tool name with digits and a hyphen is a tag too; a longer or other word is not', () => {
    const roll: OfferedTool = { name: 'roll-2d6', schema: { type: 'object', properties: { why: { type: 'string' } }, required: ['why'] } };
    expect(calls('<roll-2d6>stealth</roll-2d6>', [roll])).toEqual([{ name: 'roll-2d6', args: '{"why":"stealth"}' }]);
    expect(calls('<roll-2d6x>stealth</roll-2d6x> <roll>x</roll>', [roll])).toEqual([]);
    expect(stripPromptedCalls('<roll-2d6x>stealth</roll-2d6x>', [roll])).toBe('<roll-2d6x>stealth</roll-2d6x>');
  });

  test('in order with <tool_call> blocks, inside a <tool_calls> container, several in a row', () => {
    const text = 'A <search_history>брат</search_history> B <tool_call>{"name": "read_history", "args": {"from": 3}}</tool_call> C <search_lore>ключ</search_lore>';
    expect(calls(text).map((c) => c.name)).toEqual(['search_history', 'read_history', 'search_lore']);
    expect(stripPromptedCalls(text, ALL)).toBe('A B C');
    expect(calls('<tool_calls><search_history>a</search_history>\n<search_lore>b</search_lore></tool_calls>')).toEqual([
      { name: 'search_history', args: '{"query":"a"}' },
      { name: 'search_lore', args: '{"query":"b"}' },
    ]);
    expect(calls('<search_history>a</search_history>\n<search_history>b</search_history>').map((c) => c.args)).toEqual(['{"query":"a"}', '{"query":"b"}']);
  });

  test('a stray closer of an offered name is removed like a stray </tool_call>', () => {
    expect(stripPromptedCalls('Она ушла.</search_history> Тишина.', ALL)).toBe('Она ушла. Тишина.');
    expect(stripPromptedCalls('Она ушла. </ns:Search_History >\nТишина.', ALL)).toBe('Она ушла.\nТишина.');
    expect(calls('Она ушла.</search_history>')).toEqual([]);
  });

  test('the fence around it goes with it; the seams are repaired', () => {
    expect(stripPromptedCalls('Мира задумалась.\n```\n<search_history>брат</search_history>\n```\nОна вспомнила.', ALL)).toBe('Мира задумалась.\nОна вспомнила.');
    expect(stripPromptedCalls('Мира задумалась.\n\n\n<search_history>брат</search_history>\n\n\nОна вспомнила.', ALL)).toBe('Мира задумалась.\n\nОна вспомнила.');
    expect(stripPromptedCalls('Мира  <search_history>брат</search_history>  кивнула.', ALL)).toBe('Мира  кивнула.');
    const fenced = parsePromptedCalls('Мира.\n~~~\n<search_history>брат</search_history>\n~~~\nДа.', ALL);
    expect(fenced).toHaveLength(1);
    expect([fenced[0]!.start, fenced[0]!.end]).toEqual([6, 52]);
  });
});

describe('left unclosed (D-97: like an unclosed <tool_call>)', () => {
  test('at the end of the text: a text body is the query; a complete JSON body is the arguments', () => {
    expect(one('Сейчас. <search_history>брат Марфы').args).toBe('{"query":"брат Марфы"}');
    expect(one('Сейчас. <search_history>\nбрат Марфы\n').args).toBe('{"query":"брат Марфы"}');
    expect(one('<search_history>{"query": "брат"}').args).toBe('{"query": "брат"}');
    expect(stripPromptedCalls('Сейчас. <search_history>брат Марфы', ALL)).toBe('Сейчас.');
  });

  test('cut off: an opener without its ">", a JSON body that never closes, an empty body', () => {
    const cut = 'The <search_history> block was cut off before it was complete. Write the call as <tool_call>{"name": "search_history", "args": {…}}</tool_call>.';
    for (const text of ['Сейчас. <search_history', 'Сейчас. <search_history query="x"', 'Сейчас. <search_history>{"query": "бр', 'Сейчас. <search_history>']) {
      expect(one(text)).toEqual({ name: 'search_history', args: '', error: cut });
      expect(stripPromptedCalls(text, ALL)).toBe('Сейчас.');
    }
  });

  test('prose after it on later lines stays text: the block takes the first line (text) or the object (JSON)', () => {
    expect(one('<search_history>брат Марфы\nМарфа улыбнулась.').args).toBe('{"query":"брат Марфы"}');
    expect(stripPromptedCalls('Сейчас. <search_history>брат Марфы\nМарфа улыбнулась.', ALL)).toBe('Сейчас.\nМарфа улыбнулась.');
    expect(one('<search_history>{"query": "брат"}\nМарфа улыбнулась.').args).toBe('{"query": "брат"}');
    expect(stripPromptedCalls('<search_history>{"query": "брат"} Марфа улыбнулась.', ALL)).toBe('Марфа улыбнулась.');
  });

  test('before the next opener it ends there, like an unclosed <tool_call>', () => {
    const text = '<search_history>брат <search_lore>ключ</search_lore> Конец.';
    expect(calls(text)).toEqual([
      { name: 'search_history', args: '{"query":"брат"}' },
      { name: 'search_lore', args: '{"query":"ключ"}' },
    ]);
    expect(stripPromptedCalls(text, ALL)).toBe('Конец.');
    // A name tag ends an unclosed <tool_call> too.
    expect(calls('<tool_call>{"name": "read_history", "args": {"from": 1}}\n<search_history>брат</search_history>').map((c) => c.name)).toEqual(['read_history', 'search_history']);
  });
});

describe('names that are not offered are never tags (D-97)', () => {
  const PROSE_TAGS = [
    '<i>шёпотом</i>, а потом <br> громче',
    '<search>брат</search> и <history>старое</history>',
    '<b>Мира</b> <search_histories>x</search_histories> <xsearch_history>y</xsearch_history>',
    'a < b and c > d; <3',
  ];

  test('prose tags and look-alikes are untouched with every tool offered', () => {
    for (const text of PROSE_TAGS) {
      expect(parsePromptedCalls(text, ALL)).toEqual([]);
      expect(stripPromptedCalls(text, ALL)).toBe(text);
      expect(streamed([...text])).toBe(text);
    }
  });

  test('<search_history> with only the lore tools offered stays text (and is not run)', () => {
    expect(parsePromptedCalls(LIVE, LORE)).toEqual([]);
    expect(stripPromptedCalls(LIVE, LORE)).toBe(LIVE);
    expect(streamed([...LIVE], LORE)).toBe(LIVE);
    expect(calls('<search_lore>ключ</search_lore> <read_history>{"from": 1}</read_history>', LORE)).toEqual([{ name: 'search_lore', args: '{"query":"ключ"}' }]);
  });

  test('no tools: exactly the wrapper tags, byte for byte (an empty list too)', () => {
    const texts = [LIVE, ...PROSE_TAGS, 'A <search_history>брат</search_history> <tool_call>{"name": "a", "args": {}}</tool_call> B </search_history>'];
    for (const text of texts) {
      for (const none of [undefined, [] as OfferedTool[]]) {
        expect(parsePromptedCalls(text, none)).toEqual(parsePromptedCalls(text));
        expect(stripPromptedCalls(text, none)).toBe(stripPromptedCalls(text));
        expect(streamed([...text], none ?? [])).toBe(stripPromptedCalls(text));
      }
    }
    expect(stripPromptedCalls(LIVE)).toBe(LIVE);
    expect(stripPromptedCalls(texts.at(-1)!)).toBe('A <search_history>брат</search_history> B </search_history>');
  });

  test('a tool named like a wrapper tag keeps the wrapper meaning', () => {
    const odd: OfferedTool = { name: 'tool_call', schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
    expect(parsePromptedCalls('<tool_call>{"name": "x", "args": {}}</tool_call>', [odd])).toEqual(parsePromptedCalls('<tool_call>{"name": "x", "args": {}}</tool_call>'));
  });
});

describe('the streaming stripper (D-97: the live text equals the stored one)', () => {
  const TEXTS = [
    LIVE,
    'Мира кивнула. <search_history>брат</search_history>\nОна ушла.',
    'Мира кивнула. <SEARCH_HISTORY >брат</Search_History>\nОна ушла.',
    'Мира кивнула. <ns:search_history mode="a">брат</ns:search_history> Она ушла.',
    'Мира кивнула.\n```\n<search_history>брат</search_history>\n```\nОна ушла.',
    'Мира кивнула. <search_history>брат\nОна ушла.',
    'Мира кивнула. <search_history>{"query": "брат"} Она ушла.',
    'Мира кивнула. <search_hi',
    'Мира кивнула. <search_history',
    'Мира кивнула.</search_history> Она ушла.',
    'Мира <i>кивнула</i>. <search>нет</search> <searc',
  ];

  test('a tag split at every offset (a partial "<search_hi" held at the chunk boundary, the closer too)', () => {
    for (const text of TEXTS) {
      const batch = stripPromptedCalls(text, ALL);
      expect(streamed([...text])).toBe(batch);
      for (let k = 0; k <= text.length; k++) {
        expect(streamed([text.slice(0, k), text.slice(k)])).toBe(batch);
        for (let m = k; m <= text.length; m += 7) expect(streamed([text.slice(0, k), text.slice(k, m), text.slice(m)])).toBe(batch);
      }
    }
    expect(stripPromptedCalls(TEXTS[1]!, ALL)).toBe('Мира кивнула.\nОна ушла.');
    expect(stripPromptedCalls(TEXTS[7]!, ALL)).toBe('Мира кивнула. <search_hi');
    expect(stripPromptedCalls(TEXTS[8]!, ALL)).toBe('Мира кивнула.');
  });

  test('a partial tag is held, not shown, until the next character decides it', () => {
    const s = createPromptedStripper(ALL);
    expect(s.push('Мира кивнула. <search_hi')).toBe('Мира кивнула.');
    expect(s.push('story>брат</search_hist')).toBe('');
    expect(s.push('ory>\nОна ушла.')).toBe('\nОна ушла.');
    expect(s.end()).toBe('');
    const t = createPromptedStripper(ALL);
    expect(t.push('Мира <sea')).toBe('Мира');
    expect(t.push('rch> нет')).toBe(' <search> нет');
  });

  /** Generated replies: prose, name tags in every form, <tool_call> blocks, fences, cut tails. */
  const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const PIECES = [
    'Трактирщица вздохнула.', 'She did not look up.', '<i>тихо</i>', 'a < b', '<search>нет</search>',
    '<search_history>брат</search_history>', '<Search_History>\nсестра\n</search_history>', '<ns:search_lore>ключ</ns:search_lore>',
    '<read_history>{"from": 2}</read_history>', '<read_history>12</read_history>', '<search_history/>', '</search_history>',
    '<search_history>брат\nОна ушла.', '<search_history>{"query": "x"} Потом.', '<tool_call>{"name": "search_lore", "args": {"query": "x"}}</tool_call>',
    '```\n<search_lore>ключ</search_lore>\n```', '<read_lore>{"ids": ["L1"]}', '<search_hi', '<search_history', '</search_hist',
  ];
  const SEPS = [' ', '\n', '\n\n', '', '  '];
  const gen = subRng(20261027, 'tools-parse.name-tags');

  test('300 generated replies, random chunkings: stream === batch, no tag left', () => {
    let failures = 0;
    for (let i = 0; i < 300; i++) {
      let text = '';
      for (let n = 1 + Math.floor(gen() * 8); n > 0; n--) text += pick(gen, PIECES) + pick(gen, SEPS);
      const batch = stripPromptedCalls(text, ALL);
      if (/<\s*\/?\s*(?:\w+:)?(?:search|read)_(?:history|lore)\s*[>/]/i.test(batch)) failures++;
      const parts: string[] = [];
      for (let at = 0; at < text.length; ) {
        const n = 1 + Math.floor(gen() * (gen() < 0.5 ? 3 : 25));
        parts.push(text.slice(at, at + n));
        at += n;
      }
      if (streamed(i % 3 === 0 ? [...text] : parts) !== batch) failures++;
    }
    expect(failures).toBe(0);
  });
});

describe('leak recovery in a native round (tools/leaks.ts recoverLeaks with the specs)', () => {
  test('a closed name tag is a complete span of the tag family: recovered, the text without it', () => {
    const r = recoverLeaks('Сейчас. <search_history>брат</search_history> Да. {"name": "search_lore", "arguments": {"query": "ключ"}}', {
      offered: ['search_history', 'search_lore'],
      nativeCalls: 0,
      tools: ALL,
    });
    expect(r.calls.map((c) => [c.name, c.args])).toEqual([
      ['search_history', '{"query":"брат"}'],
      ['search_lore', '{"query":"ключ"}'],
    ]);
    expect(r.text).toBe('Сейчас. Да.');
  });

  test('its JSON is its own (never salvaged apart); unclosed, malformed or not offered: left as it is', () => {
    const envelope = 'Сейчас. <search_history>{"name": "search_history", "arguments": {"query": "брат"}}</search_history>';
    const r = recoverLeaks(envelope, { offered: ['search_history'], nativeCalls: 0, tools: ALL });
    expect(r.calls.map((c) => [c.name, c.args, c.start, c.end])).toEqual([['search_history', '{"query":"брат"}', 8, envelope.length]]);
    expect(r.text).toBe('Сейчас.');
    for (const text of ['<search_history>брат', '<read_history>12</read_history>']) {
      expect(recoverLeaks(text, { offered: ['search_history', 'read_history'], nativeCalls: 0, tools: ALL })).toEqual({ calls: [], text });
    }
    expect(recoverLeaks('<search_history>брат</search_history>', { offered: ['search_lore'], nativeCalls: 0, tools: ALL }).calls).toEqual([]);
    // Without the specs, exactly the M3 families (the JSON inside is salvaged as before).
    expect(recoverLeaks(envelope, { offered: ['search_history'], nativeCalls: 0 }).text).toBe('Сейчас. <search_history></search_history>');
  });
});

describe('HISTORY alone', () => {
  test('search_lore is not a tag when only the history tools are offered', () => {
    expect(parsePromptedCalls('<search_lore>ключ</search_lore>', HISTORY)).toEqual([]);
  });
});

describe('fixes after the D-97 check (.check-live)', () => {
  /** Batch strip, one-character stream and every two-part split agree. */
  const agrees = (text: string, tools: readonly OfferedTool[] = ALL): string => {
    const batch = stripPromptedCalls(text, tools);
    expect(streamed([...text], tools)).toBe(batch);
    for (let k = 0; k <= text.length; k++) expect(streamed([text.slice(0, k), text.slice(k)], tools)).toBe(batch);
    return batch;
  };

  test('d97-unclosed-fenced-text-body: a fence inside an unclosed tag around a text body ends with its closing fence line', () => {
    for (const open of ['```', '```json', '~~~', '  ```']) {
      const close = open.trim().slice(0, 3);
      const text = `Сейчас.\n<search_history>\n${open}\nбрат Марфы\n${close}\nМарфа улыбнулась.`;
      expect(calls(text)).toEqual([{ name: 'search_history', args: '{"query":"брат Марфы"}' }]);
      expect(agrees(text)).toBe('Сейчас.\nМарфа улыбнулась.');
    }
    // The closed form reads the same body the same way.
    expect(calls('<search_history>\n```\nбрат Марфы\n```\n</search_history>')).toEqual(calls('<search_history>\n```\nбрат Марфы\n```\nМарфа.'));
    // A fence that never closes runs to the end, as a fence left open does: nothing raw is shown.
    expect(calls('Сейчас.\n<search_history>\n```\nбрат Марфы\nМарфа улыбнулась.')).toEqual([{ name: 'search_history', args: '{"query":"брат Марфы\\nМарфа улыбнулась."}' }]);
    expect(agrees('Сейчас.\n<search_history>\n```\nбрат Марфы\nМарфа улыбнулась.')).toBe('Сейчас.');
    // A tilde line does not close a backtick fence; a line with prose after the run is no closer either.
    expect(calls('<search_history>\n```\nбрат\n~~~\n```\nДа.')).toEqual([{ name: 'search_history', args: '{"query":"брат\\n~~~"}' }]);
    expect(agrees('<search_history>\n```\nбрат\n```Да\n```\nНет.')).toBe('Нет.');
  });

  test('d97-unclosed-fenced-text-body: a `json` word before a text body is not the query; the body after it is', () => {
    const text = 'Сейчас.\n<search_history>json\nбрат\nМарфа улыбнулась.';
    expect(calls(text)).toEqual([{ name: 'search_history', args: '{"query":"брат"}' }]);
    expect(agrees(text)).toBe('Сейчас.\nМарфа улыбнулась.');
    // Closed, and before a fence, the same; a query that starts with the word keeps it.
    expect(one('<search_history>json\nбрат</search_history>').args).toBe('{"query":"брат"}');
    expect(one('<search_history>json ```\nбрат\n```</search_history>').args).toBe('{"query":"брат"}');
    expect(one('<search_history>json parser</search_history>').args).toBe('{"query":"json parser"}');
    expect(one('<search_history>json</search_history>').args).toBe('{"query":"json"}');
  });

  test('d97-wrapper-nesting-spurious-error: an empty block ended by the next opener is a wrapper (markup), not a call', () => {
    for (const text of [
      'Сейчас.\n<tool_call>\n<search_history>брат</search_history>\n</tool_call>',
      'Сейчас.\n<search_history>\n<tool_call>{"name": "search_history", "args": {"query": "брат"}}</tool_call>\n</search_history>',
      'Сейчас.\n<tool_call>\n<tool_call>{"name": "search_history", "args": {"query": "брат"}}</tool_call>\n</tool_call>',
      'Сейчас.\n<tool_call name="search_history">\n<search_history>брат</search_history>\n</tool_call>',
      'Сейчас.\n<tool_call>\n<search_history>брат</search_history>',
      'Сейчас.\n```\n<tool_call>\n<search_history>брат</search_history>\n</tool_call>\n```',
    ]) {
      expect([text, calls(text)]).toEqual([text, [{ name: 'search_history', args: '{"query":"брат"}' }]]);
      expect([text, agrees(text)]).toEqual([text, 'Сейчас.']);
    }
    // In a container too.
    expect(calls('<tool_calls>\n<tool_call>\n<search_history>a</search_history>\n</tool_call>\n</tool_calls>')).toEqual([{ name: 'search_history', args: '{"query":"a"}' }]);
    // Not a wrapper: an empty block before a hallucinated result, a closed empty block, one with a body.
    expect(calls('<tool_call>\n<tool_result>x</tool_result>').map((c) => c.error)).toEqual([expect.stringContaining('is empty')]);
    expect(calls('<tool_call></tool_call> <search_history>a</search_history>').map((c) => c.name)).toEqual([null, 'search_history']);
    expect(calls('<search_history>брат <search_lore>ключ</search_lore>').map((c) => c.name)).toEqual(['search_history', 'search_lore']);
  });

  test('d97-cut-name-tag-fragment-shown: after an unclosed call value, a name tag cut off by the end is part of the call (cut off, like <tool_ca)', () => {
    const cut = 'The <tool_call> block was cut off before it was complete. Write the call as <tool_call>{"name": "tool_name", "args": {…}}</tool_call>.';
    const namedCut = 'The <search_history> block was cut off before it was complete. Write the call as <tool_call>{"name": "search_history", "args": {…}}</tool_call>.';
    for (const tail of ['<search_hi', '<SEARCH_HI', '<ns:search_h', '<ns:', '</search_hi', '<tool_ca']) {
      const wrapped = `Сейчас.\n<tool_call>{"name": "search_history", "args": {"query": "a"}}\n${tail}`;
      expect([tail, calls(wrapped)]).toEqual([tail, [{ name: 'search_history', args: '', error: cut }]]);
      expect([tail, agrees(wrapped)]).toEqual([tail, 'Сейчас.']);
      const named = `Сейчас.\n<search_history>{"query": "a"}\n${tail}`;
      expect([tail, calls(named)]).toEqual([tail, [{ name: 'search_history', args: '', error: namedCut }]]);
      expect([tail, agrees(named)]).toEqual([tail, 'Сейчас.']);
    }
    // A whole name at the end is an opener cut after its name, a block of its own (as `<tool_call` is).
    expect(calls('<tool_call>{"name": "search_history", "args": {"query": "a"}}\n<SEARCH_HISTORY')).toEqual([
      { name: 'search_history', args: '{"query":"a"}' },
      { name: 'search_history', args: '', error: namedCut },
    ]);
    // Not a cut tag of the family: prose, kept.
    expect(stripPromptedCalls('<tool_call>{"name": "search_history", "args": {"query": "a"}}\n<i>Да</i>', ALL)).toBe('<i>Да</i>');
    // With only the lore tools, `<search_hi` starts no offered name: prose after a call that stays whole.
    expect(stripPromptedCalls('<tool_call>{"name": "search_lore", "args": {"query": "a"}}\n<search_hi', LORE)).toBe('<search_hi');
    expect(calls('<tool_call>{"name": "search_lore", "args": {"query": "a"}}\n<search_hi', LORE)).toEqual([{ name: 'search_lore', args: '{"query":"a"}' }]);
  });

  test('d97-cut-name-tag-fragment-shown: after a text body, a tag cut off by the end goes with the block; the query stays the text', () => {
    for (const tail of ['<search_hi', '</search_hi', '</search_history', '</search_history  ', '<tool_ca', '</tool_ca', '<', '< /', '<ns:read_h']) {
      for (const text of [`Сейчас.\n<search_history>брат\n${tail}`, `Сейчас.\n<search_history>брат ${tail}`, `Сейчас.\n<search_history>\n\`\`\`\nбрат\n\`\`\`\n${tail}`]) {
        expect([text, calls(text)]).toEqual([text, [{ name: 'search_history', args: '{"query":"брат"}' }]]);
        expect([text, agrees(text)]).toEqual([text, 'Сейчас.']);
      }
    }
    // Prose between the body and the cut tag: the tag is prose (as at the end of any text), the query the first line.
    expect(calls('<search_history>брат\nДа. <search_hi')).toEqual([{ name: 'search_history', args: '{"query":"брат"}' }]);
    expect(agrees('<search_history>брат\nДа. <search_hi')).toBe('Да. <search_hi');
    // Not a cut tag of the family: part of the query.
    expect(one('<search_history>a < b').args).toBe('{"query":"a < b"}');
    expect(one('<search_history>брат <i').args).toBe('{"query":"брат <i"}');
    // An empty body cut by a tag: cut off.
    expect(one('Сейчас. <search_history><search_hi').error).toContain('was cut off');
  });

  test('d97-native-seam-divergence: recoverLeaks `keep` leaves the spans inside the given blocks, so the batch strip gives the stream text', () => {
    const offered = ALL.map((t) => t.name);
    for (const text of [
      'Марфа задумалась.\n<search_history>брат</search_history>\n<search_lore>брат</search_lore>\nОна подняла глаза.',
      'Марфа задумалась. <search_history>брат</search_history> <search_lore>брат</search_lore> Она подняла глаза.',
      'Марфа задумалась.\n\n<search_history>брат</search_history>\n\n<search_lore>брат</search_lore>\n\nОна подняла глаза.',
      'Марфа задумалась.\n<tool_call>{"name": "search_history", "args": {"query": "a"}}</tool_call>\n<tool_call>{"name": "search_lore", "args": {"query": "b"}}</tool_call> Она подняла глаза.',
    ]) {
      const tagged = parsePromptedCalls(text, ALL);
      const r = recoverLeaks(text, { offered, nativeCalls: 0, tools: ALL, keep: tagged });
      expect(r.calls).toHaveLength(2);
      expect(r.text).toBe(text);
      expect(stripPromptedCalls(r.text, ALL)).toBe(stripPromptedCalls(text, ALL));
      // Without `keep` each span leaves on its own (the text the loop must not store as the stream's).
      expect(recoverLeaks(text, { offered, nativeCalls: 0, tools: ALL }).calls).toEqual(r.calls);
    }
    // A span outside every kept block still leaves the text.
    const mixed = 'A <search_history>брат</search_history> B {"name": "search_lore", "arguments": {"query": "ключ"}}';
    const r = recoverLeaks(mixed, { offered, nativeCalls: 0, tools: ALL, keep: parsePromptedCalls(mixed, ALL) });
    expect(r.calls.map((c) => c.name)).toEqual(['search_history', 'search_lore']);
    expect(r.text).toBe('A <search_history>брат</search_history> B');
  });
});
