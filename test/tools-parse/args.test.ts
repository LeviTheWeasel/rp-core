// Ported from RoleCall:apps/rc/src/lib/ai/tool-call-repair/__tests__/repair.test.ts@fb8dc623e (47 cases)
// and RoleCall:apps/rc/src/lib/ai/__tests__/json-repair.test.ts@fb8dc623e (2 fixtures).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tools/args.ts: the D-56 argument chain. RoleCall's 47 repair cases: 32 ported (layer numbers read
// as `repaired` notes), 3 adapted (the onLayer events become `repaired`; the two DeepSeek probes,
// which only logged, now pin rp-core's outcome), 6 FLIPPED (RoleCall dropped unknown keys, filled
// a missing required field with a type default, wrapped a lone object into an array, dropped
// invalid array items, unwrapped [a, b] keeping a, dropped a mismatched optional field — rp-core
// reports each as an error), 6 DROPPED: the layer-4 retry cases (retry callback used, retry-failed,
// the byte ceiling on retry output, empty / null / thrown retry). rp-core has no re-call inside the
// argument chain: the error result sent back to the model is the retry (§9.1).
import { describe, expect, test } from 'bun:test';
import { ARGS_ERROR_MAX, MAX_ARGS_BYTES, canonicalJson, looseJson, parseToolArgs, pythonCall, pythonCallEnd } from '../../src/tools/args.ts';

const OPEN = { type: 'object' };
const ok = (raw: unknown, schema: Record<string, unknown> = OPEN): { value: Record<string, unknown>; repaired: string[] } => {
  const r = parseToolArgs(raw, schema, 'tool');
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return { value: r.value, repaired: r.repaired };
};
const err = (raw: unknown, schema: Record<string, unknown> = OPEN, name = 'tool'): string => {
  const r = parseToolArgs(raw, schema, name);
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
};

const COMMIT_PLANNING_SCHEMA_FRAG = {
  type: 'object',
  required: ['directive'],
  additionalProperties: false,
  properties: {
    directive: { type: 'string' },
    callbacks: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        required: ['reference', 'intent'],
        additionalProperties: false,
        properties: { reference: { type: 'string' }, intent: { type: 'string' } },
      },
    },
  },
};

describe('RoleCall layer 1 — jsonrepair (ported)', () => {
  test('strict-parses pristine JSON', () => {
    expect(ok('{"a": 1, "b": "x"}')).toEqual({ value: { a: 1, b: 'x' }, repaired: [] });
  });
  test('repairs trailing commas', () => {
    expect(ok('{"a": 1, "b": "x",}')).toEqual({ value: { a: 1, b: 'x' }, repaired: ['jsonrepair'] });
  });
  test('repairs missing closing brace', () => {
    expect(ok('{"a": 1, "b": "x"').value).toEqual({ a: 1, b: 'x' });
  });
  test('repairs single quotes', () => {
    expect(ok("{'a': 1}").value).toEqual({ a: 1 });
  });
  test('repairs unquoted keys', () => {
    expect(ok('{a: 1, b: "x"}').value).toEqual({ a: 1, b: 'x' });
  });
  test('strips markdown code fences', () => {
    expect(ok('```json\n{"a": 1}\n```').value).toEqual({ a: 1 });
  });
});

describe('RoleCall layer 2 — schema-guided coercion (ported and flipped)', () => {
  test('coerces stringified number to number', () => {
    expect(ok({ a: '75' }, { type: 'object', properties: { a: { type: 'number' } } })).toEqual({ value: { a: 75 }, repaired: ['coerce:a'] });
  });
  test('coerces stringified integer to integer', () => {
    expect(ok({ a: '42' }, { type: 'object', properties: { a: { type: 'integer' } } }).value).toEqual({ a: 42 });
  });
  test('coerces stringified boolean', () => {
    expect(ok({ a: 'true' }, { type: 'object', properties: { a: { type: 'boolean' } } }).value).toEqual({ a: true });
  });
  test("coerces 'null' string to null when nullable", () => {
    expect(ok({ a: 'null' }, { type: 'object', properties: { a: { type: ['string', 'null'] } } }).value).toEqual({ a: null });
  });
  test('FLIP: an unknown property under additionalProperties:false is an error, not dropped', () => {
    const e = err({ a: 1, hallucinated: 'extra' }, { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } } });
    expect(e).toContain('unknown field "hallucinated" (allowed: a)');
  });
  test('FLIP: a missing required field is an error, never filled with a type default', () => {
    const e = err({ a: 1 }, { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'string' } } });
    expect(e).toContain('missing required field "b"');
  });
  test('FLIP: a lone object for an array<object> field is an error, not wrapped (scalars only)', () => {
    const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } };
    expect(err({ tags: { name: 'x' } }, schema)).toContain('"tags" must be array, not object');
  });
  test('FLIP: array items that do not fit are errors, never dropped', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
    };
    const e = err({ items: [1, 'two', { name: 'ok' }] }, schema);
    expect(e).toContain('"items[0]" must be object, not integer');
    expect(e).toContain('"items[1]" must be object, not string');
  });
  test('recurses into nested objects', () => {
    const schema = { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'number' } } } } };
    expect(ok({ outer: { inner: '10' } }, schema)).toEqual({ value: { outer: { inner: 10 } }, repaired: ['coerce:outer.inner'] });
  });
});

describe('RoleCall pipeline — repairToolCallArgs (ported, adapted, flipped)', () => {
  test('pristine input needs no repair (layerThatFixed 0)', () => {
    expect(ok('{"directive": "test"}', COMMIT_PLANNING_SCHEMA_FRAG)).toEqual({ value: { directive: 'test' }, repaired: [] });
  });
  test('a trailing comma is a jsonrepair fix (layer 1)', () => {
    expect(ok('{"directive": "test",}', COMMIT_PLANNING_SCHEMA_FRAG).repaired).toEqual(['jsonrepair']);
  });
  test('a stringified integer is a coercion (layer 2)', () => {
    const schema = { type: 'object', required: ['count'], additionalProperties: false, properties: { count: { type: 'integer' } } };
    expect(ok('{"count": "42"}', schema)).toEqual({ value: { count: 42 }, repaired: ['coerce:count'] });
  });
  test('ADAPT (onLayer events): every step that changed something is named, in chain order', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' }, on: { type: 'boolean' } } };
    expect(ok('[{"count": "3", "on": "TRUE",}]</tool_call>', schema).repaired).toEqual(['template_markers', 'jsonrepair', 'array_root', 'coerce:count', 'coerce:on']);
  });
  test('classifies size error for oversized inputs', () => {
    const e = err('x'.repeat(2_000_000), COMMIT_PLANNING_SCHEMA_FRAG);
    expect(e).toContain('over the 1048576-byte limit');
  });
  test('enforces the limit as UTF-8 bytes rather than UTF-16 code units', () => {
    const raw = JSON.stringify({ value: 'é'.repeat(600_000) });
    expect(raw.length).toBeLessThan(MAX_ARGS_BYTES);
    expect(err(raw)).toMatch(/the arguments are \d+ bytes, over the 1048576-byte limit/);
  });
  test('works without a schema (layers 0/1 only)', () => {
    expect(ok('{"a": 1, "b": "x",}').value).toEqual({ a: 1, b: 'x' });
  });
  test('normalizes empty-string args to {}', () => {
    expect(ok('', { type: 'object', properties: { reason: { type: 'string' } } })).toEqual({ value: {}, repaired: [] });
  });
  test('normalizes whitespace-only args to {}', () => {
    expect(ok('   \n  ')).toEqual({ value: {}, repaired: ['empty'] });
  });
  test("normalizes literal 'null' string to {}", () => {
    expect(ok('null')).toEqual({ value: {}, repaired: ['empty'] });
  });
  test('unwraps array-at-root when schema is object: [{...}] → {...}', () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    expect(ok('[{"name": "Caspian"}]', schema)).toEqual({ value: { name: 'Caspian' }, repaired: ['array_root'] });
  });
  test('FLIP: an array root of several objects is an error (RoleCall kept the first)', () => {
    const e = err('[{"name": "first"}, {"name": "second"}]', { type: 'object', properties: { name: { type: 'string' } } });
    expect(e).toContain('an array of 2 objects, not one object');
  });
  test('strips trailing </tool_call> template marker (GLM bug)', () => {
    const schema = { type: 'object', properties: { allies: { type: 'array', items: { type: 'string' } } } };
    // The cut leaves `{"allies":["Sunken Choir"]`, whose missing brace jsonrepair closes.
    expect(ok('{"allies":["Sunken Choir"]</tool_call>', schema)).toEqual({ value: { allies: ['Sunken Choir'] }, repaired: ['template_markers', 'jsonrepair'] });
  });
  test('strips Mistral [/TOOL_CALLS] marker', () => {
    expect(ok('{"name": "test"}[/TOOL_CALLS]').value).toEqual({ name: 'test' });
  });
  test('strips <|im_end|> chat marker', () => {
    expect(ok('{"name": "test"}<|im_end|>').value).toEqual({ name: 'test' });
  });
  test('strips <|tool_calls_end|> qwen-style marker', () => {
    expect(ok('{"name": "test"}<|tool_calls_end|>').value).toEqual({ name: 'test' });
  });
  test("does NOT strip valid JSON content that happens to contain '<' or '['", () => {
    expect(ok('{"html": "<div>hi</div>"}', { type: 'object', properties: { html: { type: 'string' } } })).toEqual({
      value: { html: '<div>hi</div>' },
      repaired: [],
    });
  });
});

describe('RoleCall DeepSeek probes (adapted: rp-core outcome pinned, no schema-parser)', () => {
  const DEEPSEEK_BROKEN = '{"directive": "x", "callbacks": ["reference": "Caspian meeting", "intent": "callback"]}';
  test('jsonrepair 3.14.0 reads the pattern as a flat string list', () => {
    const r = looseJson(DEEPSEEK_BROKEN);
    expect(r).toEqual({
      ok: true,
      value: { directive: 'x', callbacks: ['reference', ':', 'Caspian meeting', 'intent', ':', 'callback'] },
      repaired: ['jsonrepair'],
    });
  });
  test('the chain fails cleanly and invents nothing', () => {
    const e = err(DEEPSEEK_BROKEN, COMMIT_PLANNING_SCHEMA_FRAG, 'commit_planning_round');
    expect(e).toStartWith('Invalid arguments for commit_planning_round: "callbacks[0]" must be object, not string');
    expect(e).toContain('(and 3 more)');
    expect(e).toEndWith('Send one complete JSON object that matches the schema.');
  });
});

describe('RoleCall empty strings in array slots (Gemini 3.1 Flash Lite)', () => {
  const REMEMBER_CHARACTER_FRAG = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      strengths: { type: 'array', items: { type: 'string' } },
      weaknesses: { type: 'array', items: { type: 'string' } },
      likes: { type: 'array', items: { type: 'string' } },
      dislikes: { type: 'array', items: { type: 'string' } },
      skills: { type: 'array', items: { type: 'string' } },
      languages: { type: 'array', items: { type: 'string' } },
      possessions: { type: 'array', items: { type: 'string' } },
      minor_facts: { type: 'array', items: { type: 'string' } },
      relationships: {
        type: 'array',
        items: { type: 'object', required: ['with', 'nature'], properties: { with: { type: 'string' }, nature: { type: 'string' } } },
      },
      affiliations: { type: 'array', items: { type: 'object', required: ['org'], properties: { org: { type: 'string' } } } },
      memories: { type: 'array', items: { type: 'object', required: ['what_happened'], properties: { what_happened: { type: 'string' } } } },
    },
  };
  test('coerces empty string to [] in an array-of-strings slot', () => {
    expect(ok({ name: 'Torvald', strengths: '' }, REMEMBER_CHARACTER_FRAG).value).toEqual({ name: 'Torvald', strengths: [] });
  });
  test('coerces empty string to [] in an array-of-objects slot', () => {
    expect(ok({ name: 'Torvald', relationships: '' }, REMEMBER_CHARACTER_FRAG).value).toEqual({ name: 'Torvald', relationships: [] });
  });
  test('coerces "null" and "none" to [] in array slots', () => {
    expect(ok({ name: 'Torvald', likes: 'null' }, REMEMBER_CHARACTER_FRAG).value).toEqual({ name: 'Torvald', likes: [] });
    expect(ok({ name: 'Torvald', dislikes: 'none' }, REMEMBER_CHARACTER_FRAG).value).toEqual({ name: 'Torvald', dislikes: [] });
  });
  test('preserves nullable array nulls instead of wrapping them into blank items', () => {
    const schema = {
      type: 'object',
      required: ['targetSlugs', 'recipientSlugs'],
      additionalProperties: false,
      properties: {
        targetSlugs: { type: ['array', 'null'], items: { type: 'string' } },
        recipientSlugs: { type: ['array', 'null'], items: { type: 'string' } },
      },
    };
    expect(ok({ targetSlugs: null, recipientSlugs: 'none' }, schema)).toEqual({ value: { targetSlugs: null, recipientSlugs: null }, repaired: ['coerce:recipientSlugs'] });
  });
  test("end-to-end: murkapie's exact payload survives (Cyrillic)", () => {
    const rawArgs = JSON.stringify({
      name: 'Торвальд',
      aliases: ['Лютый'],
      role: 'neutral',
      species: 'человек',
      description: 'Прямолинейный и дерзкий северянин.',
      age: 'неизвестно',
      tier: 'неизвестно',
      strengths: '',
      likes: '',
      reputation: '',
      languages: '',
      memories: '',
      possessions: '',
      weaknesses: '',
      relationships: '',
      minor_facts: '',
      affiliations: '',
      skills: '',
      dislikes: '',
    });
    const v = ok(rawArgs, REMEMBER_CHARACTER_FRAG).value;
    expect(v['name']).toBe('Торвальд');
    for (const k of ['strengths', 'likes', 'weaknesses', 'relationships', 'affiliations', 'memories', 'skills', 'languages', 'possessions', 'minor_facts', 'dislikes']) {
      expect(v[k]).toEqual([]);
    }
    // Not in the fragment and not forbidden: kept as written.
    expect(v['reputation']).toBe('');
  });
  test('FLIP: a mismatched optional field is an error, never dropped (a coercible one is coerced)', () => {
    // RoleCall's own input: 42 for an array of strings is a lossless coercion here.
    expect(ok({ name: 'Torvald', aliases: 42 }, REMEMBER_CHARACTER_FRAG).value).toEqual({ name: 'Torvald', aliases: ['42'] });
    // One nothing can coerce is reported by name instead of being dropped.
    expect(err({ name: 'Torvald', aliases: { x: 1 } }, REMEMBER_CHARACTER_FRAG)).toContain('"aliases" must be array, not object');
  });
  test('required type-mismatched fields still fail honestly (no silent drop)', () => {
    expect(err(JSON.stringify({ name: { nested: true } }), REMEMBER_CHARACTER_FRAG)).toContain('"name" must be string, not object');
  });
});

describe('RoleCall json-repair.test.ts fixtures (jsonrepair 3.14.0 does the bare-value fix)', () => {
  test('bare string values are quoted', () => {
    expect(ok('{"name":"Abigail","occupation": ER Nurse,"reason": Converting source entry}').value).toEqual({
      name: 'Abigail',
      occupation: 'ER Nurse',
      reason: 'Converting source entry',
    });
  });
  test('literals stay literals', () => {
    expect(ok('{"a": true, "b": null, "c": 3}').value).toEqual({ a: true, b: null, c: 3 });
  });
});

describe('D-56 order, step by step', () => {
  test('1. the byte limit is exact', () => {
    const pad = (n: number): string => `{"a":"${'x'.repeat(n - 8)}"}`;
    expect(pad(MAX_ARGS_BYTES).length).toBe(MAX_ARGS_BYTES);
    expect(ok(pad(MAX_ARGS_BYTES)).repaired).toEqual([]);
    expect(err(pad(MAX_ARGS_BYTES + 1))).toContain(`at least ${MAX_ARGS_BYTES + 1} bytes`);
  });
  test('1. a refused oversize text is not parsed (no repair notes)', () => {
    const r = parseToolArgs('{'.repeat(MAX_ARGS_BYTES + 1), OPEN, 'tool');
    expect(r).toMatchObject({ ok: false, repaired: [] });
  });
  test('2. undefined, null, empty and whitespace are {}', () => {
    expect(ok(undefined).value).toEqual({});
    expect(ok(null).value).toEqual({});
    expect(ok('').value).toEqual({});
    expect(ok(' \t\n').value).toEqual({});
  });
  test('2. {} still meets required fields: they are never filled in', () => {
    expect(err('', { type: 'object', required: ['query'], properties: { query: { type: 'string' } } })).toContain('missing required field "query"');
  });
  test('3. markers come off BEFORE jsonrepair, which would glue them into the value', () => {
    expect(ok('{"a":"x</tool_call>')).toEqual({ value: { a: 'x' }, repaired: ['template_markers', 'jsonrepair'] });
  });
  test('3. a marker alone is no arguments (RoleCall checked emptiness before the cut)', () => {
    expect(ok('</tool_call>')).toEqual({ value: {}, repaired: ['template_markers'] });
    expect(ok('  <|im_end|>  ')).toEqual({ value: {}, repaired: ['template_markers'] });
  });
  test('3. markers are cut only at the end: one inside a valid string stays', () => {
    expect(ok('{"q": "a </tool_call> b"}')).toEqual({ value: { q: 'a </tool_call> b' }, repaired: [] });
  });
  test('3. several stacked markers are cut, at most six passes', () => {
    expect(ok('{"a":1}</tool_call><|im_end|>[/INST]').value).toEqual({ a: 1 });
    const seven = `{"a":1}${'</tool_call>'.repeat(7)}`;
    expect(err(seven)).toContain('not valid JSON');
  });
  test('4. valid JSON is parsed as is', () => {
    expect(ok('{"q": "брат", "n": 2}')).toEqual({ value: { q: 'брат', n: 2 }, repaired: [] });
  });
  test('5. the python-call form, string literals left alone', () => {
    expect(ok('search_history(query="брат", limit=5)')).toEqual({ value: { query: 'брат', limit: 5 }, repaired: ['python_call'] });
    expect(ok('[read_history(from=12, to=None)]').value).toEqual({ from: 12, to: null });
    // RoleCall rewrote `k = v` and True inside strings and broke the JSON.
    expect(ok('search_lore(query="x y = z True", exact=True)').value).toEqual({ query: 'x y = z True', exact: true });
    expect(ok("f(text='''a \"quoted\" line''', n=1)").value).toEqual({ text: 'a "quoted" line', n: 1 });
    expect(ok("f(q='it\\'s')").value).toEqual({ q: "it's" });
  });
  test('5. pythonCall returns the function name', () => {
    expect(pythonCall('search_history(query="брат")')).toEqual({ name: 'search_history', json: '{"query": "брат"}' });
    expect(pythonCall('ping()')).toEqual({ name: 'ping', json: '{}' });
    expect(pythonCall('{"a": 1}')).toBeNull();
    expect(pythonCall('Sure, I will call it (later).')).toBeNull();
  });
  test("5. pythonCall reads the shapes RoleCall's one pattern read (head and tail now checked apart)", () => {
    // RoleCall: /^\[?\s*([A-Za-z_]\w*)\s*\(\s*([\s\S]*?)\s*\)\s*\]?\s*$/ — the body between the last ')' and '('.
    const name = (t: string): [string, string] | null => {
      const r = pythonCall(t);
      return r === null ? null : [r.name, r.json];
    };
    expect(name('f()')).toEqual(['f', '{}']);
    expect(name('[f(a=1)]')).toEqual(['f', '{"a": 1}']);
    expect(name(' g ( x="1" ) ')).toEqual(['g', '{"x": "1"}']);
    expect(name('f( a=1 ) ]')).toEqual(['f', '{"a": 1}']);
    expect(name('f(\n\n q="x"\n)')).toEqual(['f', '{"q": "x"}']);
    expect(name('f(a=1))')).toEqual(['f', '{"a": 1)}']);
    for (const t of ['f(a', '[f(]', 'f(a) b', 'f)', '(a)', 'f(a)]]', 'f(' + ' '.repeat(50) + 'x']) expect(pythonCall(t)).toBeNull();
  });
  test('5. pythonCallEnd: the end of a whole call at a position, parentheses in strings skipped', () => {
    const text = 'Mira: search_lore(query="a (b) c", n=f(2))\nThe end.';
    const at = text.indexOf('search_lore');
    expect(text.slice(at, pythonCallEnd(text, at))).toBe('search_lore(query="a (b) c", n=f(2))');
    expect(pythonCallEnd("[f(q='x)')  ] more", 0)).toBe("[f(q='x)')  ]".length);
    expect(pythonCallEnd('f(q="""a ) b""") tail', 0)).toBe('f(q="""a ) b""")'.length);
    expect(pythonCallEnd('f(q="x"', 0)).toBe(-1);
    expect(pythonCallEnd('f(q="x)', 0)).toBe(-1);
    expect(pythonCallEnd('f(q=1) x', 0, 5)).toBe(-1);
    expect(pythonCallEnd('The end (soon).', 0)).toBe(-1);
    expect(pythonCallEnd('{"a": 1}', 0)).toBe(-1);
  });
  test('5. the missing-brace patterns', () => {
    expect(ok('{entry_names": ["a"]}')).toEqual({ value: { entry_names: ['a'] }, repaired: ['missing_braces'] });
    expect(ok('{"directive": mood": "tense"}}').value).toEqual({ directive: { mood: 'tense' } });
    expect(ok('{"categories":[name":"X"}]}').value).toEqual({ categories: [{ name: 'X' }] });
  });
  test('5. prose is not an object (jsonrepair turns it into a string)', () => {
    expect(err('this is not json at all')).toContain('the arguments are text, not a JSON object');
    expect(err('<not-json>')).toContain('the arguments are text, not a JSON object');
    expect(err('42')).toContain('must be a JSON object, not integer');
  });
  test('5. text jsonrepair cannot read is a parse error', () => {
    expect(err('Sure! {"a":1} done')).toContain('the arguments are not valid JSON (Unexpected character');
  });
  test('6. an array root: one object unwrapped; empty, scalars or several are errors', () => {
    expect(ok('[{"a":1}]').value).toEqual({ a: 1 });
    expect(err('[]')).toContain('an array of 0 items');
    expect(err('["a"]')).toContain('an array of 1 item,');
    expect(err('{"a":1}\n{"b":2}')).toContain('an array of 2 objects');
  });
  test('7. coercions by type', () => {
    const schema = {
      type: 'object',
      properties: {
        n: { type: 'number' },
        i: { type: 'integer' },
        b: { type: 'boolean' },
        s: { type: 'string' },
        ns: { type: ['string', 'null'] },
        ids: { type: 'array', items: { type: 'string' } },
        nums: { type: 'array', items: { type: 'integer' } },
        mode: { type: 'string', enum: ['all', 'any'] },
      },
    };
    expect(ok({ n: '-1.5', i: ' 7 ', b: 'False', s: 42, ns: 'None', ids: 'L12', nums: '[1, "2"]', mode: ' ANY ' }, schema)).toEqual({
      value: { n: -1.5, i: 7, b: false, s: '42', ns: null, ids: ['L12'], nums: [1, 2], mode: 'any' },
      repaired: ['coerce:n', 'coerce:i', 'coerce:b', 'coerce:s', 'coerce:ns', 'coerce:ids', 'coerce:nums', 'coerce:nums[1]', 'coerce:mode'],
    });
    expect(ok({ ids: 12, s: true }, schema).value).toEqual({ ids: ['12'], s: 'true' });
  });
  test('7. lossy or invented coercions are not made', () => {
    const schema = { type: 'object', properties: { i: { type: 'integer' }, n: { type: 'number' }, b: { type: 'boolean' }, s: { type: 'string' } } };
    expect(err({ i: '4.7' }, schema)).toContain('"i" must be integer, not string');
    expect(err({ i: 4.7 }, schema)).toContain('"i" must be integer, not number');
    expect(err({ n: '1e3' }, schema)).toContain('"n" must be number, not string');
    expect(err({ b: 'null' }, schema)).toContain('"b" must be boolean, not string');
    expect(err({ s: null }, schema)).toContain('"s" must be string, not null');
    expect(err({ s: ['a', 'b'] }, schema)).toContain('"s" must be string, not array');
    expect(err({ s: { k: 'v' } }, schema)).toContain('"s" must be string, not object');
  });
  test('8. enum, maxLength (code points), minLength, minimum, maximum, exclusive bounds, items', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['all', 'any'] },
        q: { type: 'string', maxLength: 3, minLength: 1 },
        n: { type: 'integer', minimum: 1, maximum: 20 },
        x: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
        ids: { type: 'array', items: { type: 'string' }, maxItems: 2, minItems: 1 },
      },
    };
    expect(ok({ q: 'ёж😀' }, schema).value).toEqual({ q: 'ёж😀' }); // 3 code points, 4 UTF-16 units
    expect(err({ mode: 'some' }, schema)).toContain('"mode" must be one of "all", "any"');
    expect(err({ q: 'брат' }, schema)).toContain('"q" must be at most 3 characters long');
    expect(err({ q: '' }, schema)).toContain('"q" must be at least 1 characters long');
    expect(err({ n: 0 }, schema)).toContain('"n" must be at least 1');
    expect(err({ n: 21 }, schema)).toContain('"n" must be at most 20');
    expect(err({ x: 0 }, schema)).toContain('"x" must be more than 0');
    expect(err({ x: 1 }, schema)).toContain('"x" must be less than 1');
    expect(err({ ids: ['a', 'b', 'c'] }, schema)).toContain('"ids" must have at most 2 items');
    expect(err({ ids: [] }, schema)).toContain('"ids" must have at least 1 items');
    expect(err({ ids: ['a', {}] }, schema)).toBe(
      'Invalid arguments for tool: "ids[1]" must be string, not object. Send one complete JSON object that matches the schema.',
    );
  });
  test('8. required and additionalProperties:false, reported together in schema order', () => {
    const schema = { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string' }, limit: { type: 'integer' } } };
    expect(err('{"q": "брат"}', schema, 'search_history')).toBe(
      'Invalid arguments for search_history: missing required field "query"; unknown field "q" (allowed: query, limit). Send one complete JSON object that matches the schema.',
    );
  });
  test('a plain object skips the text steps and is still coerced and validated', () => {
    expect(ok({ n: '3' }, { type: 'object', properties: { n: { type: 'integer' } } })).toEqual({ value: { n: 3 }, repaired: ['coerce:n'] });
    expect(err(7)).toContain('the arguments must be a JSON object, not integer');
    expect(err(true)).toContain('not boolean');
  });
});

describe('the error text (§9.1)', () => {
  test('starts with the tool, ends with the guidance, one line', () => {
    const e = err('{"a": 1', { type: 'object', required: ['b'], properties: { b: { type: 'string' } } }, 'read_lore');
    expect(e).toBe('Invalid arguments for read_lore: missing required field "b". Send one complete JSON object that matches the schema.');
  });
  test(`never longer than ${ARGS_ERROR_MAX} characters, whatever the detail or the name`, () => {
    const props: Record<string, unknown> = {};
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      props[`field_with_a_long_name_${i}`] = { type: 'integer' };
      value[`field_with_a_long_name_${i}`] = 'not a number at all, and long';
    }
    const e = err(value, { type: 'object', properties: props }, 'x'.repeat(200));
    expect(e.length).toBeLessThanOrEqual(ARGS_ERROR_MAX);
    expect(e).toEndWith('Send one complete JSON object that matches the schema.');
    expect(e).toContain('(and 47 more)');
    expect(e).not.toContain('\n');
    const huge = err(`{"a": "${'é'.repeat(MAX_ARGS_BYTES)}"}`);
    expect(huge.length).toBeLessThanOrEqual(ARGS_ERROR_MAX);
  });
  test('control characters in a parse message become spaces', () => {
    const e = err('{"a"\u0001: }}}', OPEN);
    expect(e).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('canonicalJson', () => {
  test('keys sorted at every level, arrays in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  test('the same call written two ways is one identity', () => {
    expect(canonicalJson({ query: 'брат', limit: 5 })).toBe(canonicalJson({ limit: 5, query: 'брат' }));
    expect(canonicalJson({ query: 'брат' })).not.toBe(canonicalJson({ query: 'Брат' }));
  });
  test('undefined members dropped as JSON does; undefined itself is null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
  });
});
