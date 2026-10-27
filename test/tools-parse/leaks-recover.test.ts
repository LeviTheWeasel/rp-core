// Ported from RoleCall:apps/rc/src/lib/ai/__tests__/vvs-728-dsml-tool-call-normalization.test.ts@fb8dc623e
// (10 cases) and RoleCall:apps/rc/src/lib/ai/narrator-engine/__tests__/content-tool-salvage.test.ts@fb8dc623e
// (8 cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tools/leaks.ts recoverLeaks (§8.3, D-57). DSML: cases 1–5 ported as recovery (RoleCall went through
// extractCompletion; here recoverLeaks with the names offered), 7–9 adapted (fail closed: no call, the
// text untouched here and stripped later by stripToolCallLeaks), 6 replaced (RoleCall gated on a
// "deepseek" model name; rp-core gates on the tools offered: TD-12), 10 dropped (RoleCall's TV tool
// loop, host code). Salvage: all 8 ported, plus the spans rp-core adds. Then every leak family.
import { describe, expect, test } from 'bun:test';
import { recoverLeaks, stripToolCallLeaks } from '../../src/tools/leaks.ts';

const rec = (text: string, offered: string[], nativeCalls = 0): { calls: { name: string; args: unknown }[]; text: string } => {
  const r = recoverLeaks(text, { offered, nativeCalls });
  for (const c of r.calls) {
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.end).toBeGreaterThan(c.start);
  }
  return { calls: r.calls.map((c) => ({ name: c.name, args: JSON.parse(c.args || '{}') as unknown })), text: r.text };
};

const reportedRememberCharacter = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="Remember_Character">
<｜DSML｜parameter name="name" string="true">Mara</｜DSML｜parameter>
<｜DSML｜parameter name="affiliations" string="false">[{"org":"Violet Dragons","role":"resident","status":"active"}]</｜DSML｜parameter>
<｜DSML｜parameter name="age" string="false">null</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

describe('RoleCall VVS-728 DSML recovery', () => {
  test('1. the reported V4 response becomes a structured call', () => {
    const r = recoverLeaks(reportedRememberCharacter, { offered: ['Remember_Character'], nativeCalls: 0 });
    expect(r.text).toBe('');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('Remember_Character');
    expect(JSON.parse(r.calls[0]!.args)).toEqual({ name: 'Mara', affiliations: [{ org: 'Violet Dragons', role: 'resident', status: 'active' }], age: null });
    expect([r.calls[0]!.start, r.calls[0]!.end]).toEqual([0, reportedRememberCharacter.length]);
  });
  test('2. compact ASCII DSML, prose outside the block kept, typed values typed', () => {
    const r = rec(
      'I found two durable changes.<||DSML||tool_calls><||DSML||invoke name="Remember_Event"><||DSML||parameter name="name" string="true">Arrival</||DSML||parameter><||DSML||parameter name="importance" string="false">3</||DSML||parameter></||DSML||invoke><||DSML||invoke name="postgen_status"><||DSML||parameter name="summary" string="true">Saved the arrival.</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>',
      ['Remember_Event', 'postgen_status'],
    );
    expect(r.text).toBe('I found two durable changes.');
    expect(r.calls).toEqual([
      { name: 'Remember_Event', args: { name: 'Arrival', importance: 3 } },
      { name: 'postgen_status', args: { summary: 'Saved the arrival.' } },
    ]);
  });
  test('3. literal |DSML| in prose and in a value survives', () => {
    const r = rec(
      'Keep literal |DSML| prose.<|DSML|tool_calls><|DSML|invoke name="Remember_Character"><|DSML|parameter name="name" string="true">Mara |DSML| Vale</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>',
      ['Remember_Character'],
    );
    expect(r.text).toBe('Keep literal |DSML| prose.');
    expect(r.calls).toEqual([{ name: 'Remember_Character', args: { name: 'Mara |DSML| Vale' } }]);
  });
  test('4. the V3.2 function_calls container', () => {
    const text = `<｜DSML｜function_calls>
<｜DSML｜invoke name="postgen_status">
<｜DSML｜parameter name="summary" string="true">Nothing significant changed.</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>`;
    const r = recoverLeaks(text, { offered: ['postgen_status'], nativeCalls: 0 });
    expect(r).toEqual({ calls: [{ name: 'postgen_status', args: JSON.stringify({ summary: 'Nothing significant changed.' }), start: 0, end: text.length }], text: '' });
  });
  test('5. a DSML echo next to native calls is not executed twice', () => {
    expect(recoverLeaks(reportedRememberCharacter, { offered: ['Remember_Character'], nativeCalls: 1 })).toEqual({ calls: [], text: reportedRememberCharacter });
  });
  test('6. REPLACED (TD-12): the gate is the tools offered, not the model name', () => {
    expect(recoverLeaks(reportedRememberCharacter, { offered: ['search_history'], nativeCalls: 0 })).toEqual({ calls: [], text: reportedRememberCharacter });
    expect(recoverLeaks(reportedRememberCharacter, { offered: [], nativeCalls: 0 })).toEqual({ calls: [], text: reportedRememberCharacter });
  });
  test('7. an unterminated block fails closed (left for stripping)', () => {
    const malformed = '<｜DSML｜tool_calls><｜DSML｜invoke name="Remember_Character"><｜DSML｜parameter name="name" string="true">Mara';
    expect(recoverLeaks(malformed, { offered: ['Remember_Character'], nativeCalls: 0 })).toEqual({ calls: [], text: malformed });
    expect(stripToolCallLeaks(malformed).text).toBe('');
  });
  test('8. invalid typed JSON fails closed instead of inventing arguments', () => {
    const malformed = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="Remember_Character">
<｜DSML｜parameter name="affiliations" string="false">[{"org":"Violet Dragons"}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
    expect(recoverLeaks(malformed, { offered: ['Remember_Character'], nativeCalls: 0 })).toEqual({ calls: [], text: malformed });
  });
  test('9. repeated unterminated containers in bounded time', () => {
    const malformed = '<｜DSML｜tool_calls>'.repeat(20_000);
    const t0 = performance.now();
    const r = recoverLeaks(malformed, { offered: ['Remember_Character'], nativeCalls: 0 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r).toEqual({ calls: [], text: malformed });
  });
  test('DSML fails closed on a missing string flag, a duplicate parameter, a bad name', () => {
    const wrap = (inner: string): string => `<｜DSML｜tool_calls><｜DSML｜invoke name="a">${inner}</｜DSML｜invoke></｜DSML｜tool_calls>`;
    expect(rec(wrap('<｜DSML｜parameter name="q">x</｜DSML｜parameter>'), ['a']).calls).toEqual([]);
    expect(rec(wrap('<｜DSML｜parameter name="q" string="true">x</｜DSML｜parameter><｜DSML｜parameter name="q" string="true">y</｜DSML｜parameter>'), ['a']).calls).toEqual([]);
    expect(rec('<｜DSML｜tool_calls><｜DSML｜invoke name="a b"></｜DSML｜invoke></｜DSML｜tool_calls>', ['a b']).calls).toEqual([]);
    expect(rec(wrap('<｜DSML｜parameter name="q" string="TRUE">x</｜DSML｜parameter>'), ['a']).calls).toEqual([{ name: 'a', args: { q: 'x' } }]);
  });
});

const KNOWN = ['commit_planning_round', 'update_arc', 'plant_seed'];

describe('RoleCall content-tool-salvage (ported, with spans)', () => {
  test('salvages a fenced OpenAI-style call', () => {
    const content = ["I'll commit my planning now.", '```json', '{"name": "commit_planning_round", "arguments": {"seedUpdates": [], "mood": "tense"}}', '```'].join('\n');
    const r = rec(content, KNOWN);
    expect(r.calls).toEqual([{ name: 'commit_planning_round', args: { seedUpdates: [], mood: 'tense' } }]);
    expect(r.text).toBe("I'll commit my planning now.");
  });
  test('salvages bare unfenced JSON with tool/parameters key variants', () => {
    const r = rec('Plan: {"tool": "update_arc", "parameters": {"id": "a1", "status": "rising"}}', KNOWN);
    expect(r.calls).toEqual([{ name: 'update_arc', args: { id: 'a1', status: 'rising' } }]);
    expect(r.text).toBe('Plan:');
  });
  test('salvages an array of calls and a tool_calls wrapper, preserving order', () => {
    const content = [
      '{"tool_calls": [',
      '  {"function": {"name": "plant_seed", "arguments": "{\\"title\\": \\"the letter\\"}"}},',
      '  {"name": "commit_planning_round", "arguments": {}}',
      ']}',
    ].join('\n');
    const r = recoverLeaks(content, { offered: KNOWN, nativeCalls: 0 });
    expect(r.calls.map((c) => [c.name, c.args])).toEqual([
      ['plant_seed', '{"title": "the letter"}'],
      ['commit_planning_round', '{}'],
    ]);
    expect(r.text).toBe('');
  });
  test('ignores unknown tool names and prose mentions', () => {
    const content = ['I would normally call commit_planning_round here.', '{"name": "made_up_tool", "arguments": {"x": 1}}'].join('\n');
    expect(recoverLeaks(content, { offered: KNOWN, nativeCalls: 0 })).toEqual({ calls: [], text: content });
  });
  test('ignores name-only objects without an argument payload', () => {
    expect(rec('{"name": "update_arc"}', KNOWN).calls).toEqual([]);
  });
  test('dedupes identical calls (both copies leave the text)', () => {
    const body = '{"name": "update_arc", "arguments": {"id": "a1"}}';
    const r = rec(`${body}\n${body}`, KNOWN);
    expect(r.calls).toEqual([{ name: 'update_arc', args: { id: 'a1' } }]);
    expect(r.text).toBe('');
    // The same arguments in another key order are the same call.
    expect(rec('{"name": "update_arc", "arguments": {"a": 1, "b": 2}} {"name": "update_arc", "arguments": {"b": 2, "a": 1}}', KNOWN).calls).toHaveLength(1);
  });
  test('returns nothing for plain prose rounds', () => {
    expect(rec('The mood is tense. Nothing else to do.', KNOWN)).toEqual({ calls: [], text: 'The mood is tense. Nothing else to do.' });
  });
  test('ignores arguments that are non-JSON strings', () => {
    expect(rec('{"name": "update_arc", "arguments": "just words"}', KNOWN).calls).toEqual([]);
  });
  test('only when the native round returned no calls', () => {
    const content = 'Plan: {"tool": "update_arc", "parameters": {"id": "a1"}}';
    expect(recoverLeaks(content, { offered: KNOWN, nativeCalls: 2 })).toEqual({ calls: [], text: content });
  });
  test('a value holding anything besides offered calls is left whole', () => {
    const content = '[{"name": "update_arc", "arguments": {}}, {"name": "made_up_tool", "arguments": {}}]';
    expect(rec(content, KNOWN)).toEqual({ calls: [], text: content });
    expect(rec('{"name": "update_arc", "arguments": [1]}', KNOWN).calls).toEqual([]);
  });
  test('JSON that is not a call stays in the text, a later call is still found', () => {
    const r = rec('Stats: {"hp": 3}. Then {"name": "plant_seed", "args": {"title": "x"}} done.', KNOWN);
    expect(r).toEqual({ calls: [{ name: 'plant_seed', args: { title: 'x' } }], text: 'Stats: {"hp": 3}. Then done.' });
  });
});

describe('recoverLeaks: the leak families', () => {
  const SH = ['search_history', 'search_lore', 'read_lore'];
  test('Hermes/Qwen <tool_call> with arguments / args / parameters, any case', () => {
    expect(rec('She paused. <tool_call>{"name": "search_history", "arguments": {"query": "брат"}}</tool_call> "Yes?"', SH)).toEqual({
      calls: [{ name: 'search_history', args: { query: 'брат' } }],
      text: 'She paused. "Yes?"',
    });
    expect(rec('<Tool_Call>{"name": "search_lore", "args": {"query": "x"}}</TOOL_CALL>', SH).calls).toEqual([{ name: 'search_lore', args: { query: 'x' } }]);
    expect(rec('<tool_call name="search_lore">{"query": "x"}</tool_call>', SH).calls).toEqual([{ name: 'search_lore', args: { query: 'x' } }]);
  });
  test('<tool_use> and <function_call> envelopes', () => {
    expect(rec('<tool_use>{"name": "search_lore", "input": {"query": "x"}}</tool_use>', SH).calls).toEqual([{ name: 'search_lore', args: { query: 'x' } }]);
    expect(rec('<function_call>{"name": "search_lore", "arguments": {"query": "x"}}</function_call>', SH).calls).toEqual([{ name: 'search_lore', args: { query: 'x' } }]);
  });
  test('<function=name>{json}</function> (Llama 3.1) and <parameter=…> (Qwen3-coder)', () => {
    expect(rec('<function=search_history>{"query": "Мира"}</function>', SH).calls).toEqual([{ name: 'search_history', args: { query: 'Мира' } }]);
    expect(rec('<function=search_history>\n<parameter=query>\nбрат\n</parameter>\n</function>', SH).calls).toEqual([{ name: 'search_history', args: { query: 'брат' } }]);
    expect(rec('<function name="search_lore">{"query": "x"}</function>', SH).calls).toEqual([{ name: 'search_lore', args: { query: 'x' } }]);
  });
  test('Claude XML: <function_calls><invoke><parameter>, and a lone <invoke>', () => {
    const text = 'Checking.\n<function_calls>\n<invoke name="search_history">\n<parameter name="query">брат</parameter>\n</invoke>\n<invoke name="read_lore"><parameter name="ids">["L1"]</parameter></invoke>\n</function_calls>';
    expect(rec(text, SH)).toEqual({
      calls: [
        { name: 'search_history', args: { query: 'брат' } },
        { name: 'read_lore', args: { ids: '["L1"]' } },
      ],
      text: 'Checking.',
    });
    expect(rec('<invoke name="search_lore"><parameter name="query">x</parameter></invoke>', SH).calls).toEqual([{ name: 'search_lore', args: { query: 'x' } }]);
    // A stray element inside makes the whole block unreadable.
    expect(rec('<invoke name="search_lore"><parameter name="query">x</parameter><b>y</b></invoke>', SH).calls).toEqual([]);
  });
  test('[TOOL_REQUEST]…[END_TOOL_REQUEST] (LM Studio)', () => {
    expect(rec('Hm. [TOOL_REQUEST]{"name": "search_lore", "arguments": {"query": "x"}}[END_TOOL_REQUEST] Ok.', SH)).toEqual({
      calls: [{ name: 'search_lore', args: { query: 'x' } }],
      text: 'Hm. Ok.',
    });
  });
  test('Mistral [TOOL_CALLS]: a JSON array, and name[CALL_ID]id[ARGS]{…}', () => {
    expect(rec('[TOOL_CALLS] [{"name": "search_lore", "arguments": {"query": "a"}}, {"name": "search_history", "arguments": {"query": "b"}}]', SH).calls).toEqual([
      { name: 'search_lore', args: { query: 'a' } },
      { name: 'search_history', args: { query: 'b' } },
    ]);
    expect(rec('[TOOL_CALLS]search_history[ARGS]{"query": "c"}', SH).calls).toEqual([{ name: 'search_history', args: { query: 'c' } }]);
    expect(rec('Text [TOOL_CALLS]search_lore[CALL_ID]abc123def[ARGS]{"query": "d"} more', SH)).toEqual({
      calls: [{ name: 'search_lore', args: { query: 'd' } }],
      text: 'Text more',
    });
  });
  test('DeepSeek V3 and Kimi K2 special-token sections', () => {
    const ds = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_history\n```json\n{"query": "брат"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    expect(rec(`Ok.${ds}`, SH)).toEqual({ calls: [{ name: 'search_history', args: { query: 'брат' } }], text: 'Ok.' });
    const kimi = '<|tool_calls_section_begin|><|tool_call_begin|>functions.search_lore:0<|tool_call_argument_begin|>{"query": "x"}<|tool_call_end|><|tool_calls_section_end|>';
    expect(rec(kimi, SH)).toEqual({ calls: [{ name: 'search_lore', args: { query: 'x' } }], text: '' });
  });
  test('a span naming a tool not offered is left alone (stripped later)', () => {
    const text = 'A <tool_call>{"name": "delete_everything", "arguments": {}}</tool_call> B';
    expect(recoverLeaks(text, { offered: SH, nativeCalls: 0 })).toEqual({ calls: [], text });
    // One unknown call in a several-call span keeps the whole span out.
    const mixed = '[TOOL_CALLS] [{"name": "search_lore", "arguments": {}}, {"name": "nope", "arguments": {}}]';
    expect(recoverLeaks(mixed, { offered: SH, nativeCalls: 0 })).toEqual({ calls: [], text: mixed });
  });
  test('incomplete spans are never calls', () => {
    for (const text of [
      'A <tool_call>{"name": "search_lore", "arguments": {"query": "x"}}',
      'A [TOOL_REQUEST]{"name": "search_lore", "arguments": {}}',
      'A [TOOL_CALLS]search_lore[ARGS]{"query": ',
      'A </tool_call>',
    ]) {
      expect(recoverLeaks(text, { offered: SH, nativeCalls: 0 })).toEqual({ calls: [], text });
    }
  });
  test('a span whose body does not parse is left alone', () => {
    const text = '<tool_call>not json at all</tool_call>';
    expect(recoverLeaks(text, { offered: SH, nativeCalls: 0 })).toEqual({ calls: [], text });
  });
  test('arguments are kept raw (tools/args.ts checks them at run time)', () => {
    const r = recoverLeaks('<tool_call>{"name": "search_lore", "arguments": {"query": 5, "extra": true}}</tool_call>', { offered: SH, nativeCalls: 0 });
    expect(r.calls).toEqual([{ name: 'search_lore', args: '{"query":5,"extra":true}', start: 0, end: 88 }]);
  });
  test('several families in one text: text order, seams repaired', () => {
    const text = 'One.\n\n<function=search_lore>{"query": "a"}</function>\n\nTwo. [TOOL_CALLS]search_history[ARGS]{"query": "b"}\n\n\n\nThree.';
    expect(rec(text, SH)).toEqual({
      calls: [
        { name: 'search_lore', args: { query: 'a' } },
        { name: 'search_history', args: { query: 'b' } },
      ],
      text: 'One.\n\nTwo.\n\nThree.',
    });
  });
  test('a recovered span takes a fence that wraps only it', () => {
    const text = 'Looking.\n```\n<tool_call>{"name": "search_lore", "arguments": {"query": "x"}}</tool_call>\n```\nFound.';
    expect(rec(text, SH)).toEqual({ calls: [{ name: 'search_lore', args: { query: 'x' } }], text: 'Looking.\nFound.' });
  });
  test('the DeepSeek end-of-sentence residue is left for stripToolCallLeaks', () => {
    const text = `${reportedRememberCharacter}<｜end▁of▁sentence｜>`;
    const r = recoverLeaks(text, { offered: ['Remember_Character'], nativeCalls: 0 });
    expect(r.calls).toHaveLength(1);
    expect(stripToolCallLeaks(r.text).text).toBe('');
  });
  test('nothing to do: no offered names, empty text, no leaks', () => {
    expect(recoverLeaks('', { offered: SH, nativeCalls: 0 })).toEqual({ calls: [], text: '' });
    expect(recoverLeaks('Plain prose.', { offered: SH, nativeCalls: 0 })).toEqual({ calls: [], text: 'Plain prose.' });
    expect(recoverLeaks('<tool_call>{"name": "a", "args": {}}</tool_call>', { offered: [], nativeCalls: 0 }).calls).toEqual([]);
  });
});
