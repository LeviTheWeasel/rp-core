// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Finding the Director's plan in a corrupted answer (m4-decisions D-98, D-99): the 20 probes of
// rolecall.md §5.4 (RoleCall's tag vectors rewritten for <plan>), envelopes, the attribute form,
// fences, markup around, prose mentions, bare objects, answers that live in the reasoning
// (RoleCall's cremecafe-glm-thinking case) and answers cut off by the token limit. Each answer goes
// through structuredCall with no corrective pass, so the code is the first reading's.
// D-117 accepts two answers D-99 read strictly (a nameless <tool_call> holding the plan; a <plan>
// mention in prose followed by a bare plan object) and unwraps a plan envelope on both transports;
// every other probe keeps its result.
import { describe, expect, test } from 'bun:test';
import { findPlan, firstObject, readAnswer } from '../../src/agents/structured.ts';
import { scriptCapsWith, type ScriptStep } from '../../src/providers/scripted.ts';
import { calls, P, readPlanish, rig, STRUCTURED_CAPS } from './kit.ts';

/** One tagged answer, read once (repair off). */
async function once(steps: ScriptStep[], caps = scriptCapsWith()) {
  const r = rig(calls(steps), { caps, input: { repair: false } });
  const out = await r.run();
  expect(r.provider.requests.length).toBe(1);
  return out;
}

const moodOf = (out: Awaited<ReturnType<typeof once>>): unknown => (out.ok ? out.value.directive['mood'] : `failed: ${out.code}`);

describe('the 20 probes of rolecall.md §5.4 (P = {"directive":{"mood":"tense"}})', () => {
  // [#, answer, expected mood or failure code]
  const probes: [number, string, string][] = [
    [1, `sure\n<plan>${P}</plan>`, 'tense'],
    [2, `<plan id="1" name="x">${P}</plan>`, 'tense'],
    [3, `< PLAN >${P}</ Plan >`, 'tense'],
    // RoleCall's scanner finds no block; D-99's text path finds the object with a directive.
    [4, `<plans>${P}</plans>`, 'tense'],
    // An empty block is an empty object: the reader says the directive is missing.
    [5, '<plan></plan>', 'failed: missing_directive'],
    [6, '<plan/>', 'failed: missing_directive'],
    [7, `<plan>${P}`, 'tense'],
    [8, '<plan>{"directive":{"mood":"te', 'failed: undecodable'],
    [9, `<plan>\`\`\`json\n${P}\n\`\`\`</plan>`, 'tense'],
    [10, `<plan>json ${P}</plan>`, 'tense'],
    [11, `\`\`\`\n<plan>${P}</plan>\n\`\`\``, 'tense'],
    [12, `<plan>${P}</plan>\n<plan>{"directive":{"mood":"calm"}}</plan>`, 'tense'],
    [13, `I will write the <plan> now.\n<plan>${P}</plan>`, 'tense'],
    [14, `First I think about the <plan>, then:\n\n<plan>${P}</plan>`, 'tense'],
    [15, `<plan>{"name":"plan","args":${P}}</plan>`, 'tense'],
    // The scanner leaves this envelope whole (another name); D-99 unwraps it one level.
    [16, `<plan>{"name":"commit_planning_round","arguments":${P}}</plan>`, 'tense'],
    [17, `<tool_call>{"name":"commit_planning_round","arguments":${P}}</tool_call>`, 'tense'],
    [18, `<plan>${P}</tool_call></plan>`, 'tense'],
    [19, `<x:plan>${P}</x:plan>`, 'tense'],
    [20, `<plan>${P}\nThat is my plan.`, 'tense'],
  ];
  for (const [n, text, want] of probes) {
    test(`probe ${n}: ${JSON.stringify(text).slice(0, 70)}`, async () => {
      expect(moodOf(await once([{ text }]))).toBe(want);
    });
  }

  test('probe 12: the first block is the plan, the second a skipped extra block', async () => {
    const out = await once([{ text: probes[11]![1] }]);
    expect(out.ok && out.skipped).toEqual([{ path: 'plan', why: 'extra block' }]);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['ok']);
  });
});

describe('envelopes and the attribute form', () => {
  test.each([
    ['args inside <plan>', `<plan>{"name":"commit_planning_round","args":${P}}</plan>`],
    ['arguments as a JSON string', `<plan>{"name":"commit_planning_round","arguments":${JSON.stringify(P)}}</plan>`],
    ['a <tool_call> named plan', `<tool_call>{"name":"plan","arguments":${P}}</tool_call>`],
    ['a <tool_call> with string arguments', `<tool_call>{"name":"commit_planning_round","arguments":${JSON.stringify(P)}}</tool_call>`],
    ['the attribute form', `<tool_call name="commit_planning_round">${P}</tool_call>`],
    ['the attribute form with an args wrapper', `<tool_call name="plan">{"arguments":${P}}</tool_call>`],
    ['a name tag of the planning command', `<commit_planning_round>${P}</commit_planning_round>`],
    ['a python call in a <tool_call>', '<tool_call>commit_planning_round(directive={"mood": "tense"})</tool_call>'],
    ['a <plan> with attributes', `<plan name="plan" version="2">${P}</plan>`],
  ])('%s', async (_, text) => {
    expect(moodOf(await once([{ text }]))).toBe('tense');
  });

  test('an envelope with other keys beside name and arguments is not unwrapped: the root has no directive', async () => {
    const out = await once([{ text: `<plan>{"name":"commit_planning_round","arguments":${P},"id":"1"}</plan>` }]);
    expect(out.ok ? 'ok' : out.code).toBe('missing_directive');
  });

  test("a <tool_call> of another tool is not the plan's; a plan block after it is", async () => {
    expect(moodOf(await once([{ text: '<tool_call>{"name":"search_history","args":{"query":"key"}}</tool_call>' }]))).toBe('failed: no_output');
    expect(moodOf(await once([{ text: `<tool_call>{"name":"search_history","args":{"query":"key"}}</tool_call>\n<plan>${P}</plan>` }]))).toBe('tense');
  });

  test('a nameless <tool_call> holding the plan is the plan (D-117; was undecodable under D-99)', async () => {
    expect(moodOf(await once([{ text: `<tool_call>${P}</tool_call>` }]))).toBe('tense');
    expect(moodOf(await once([{ text: `Planning.\n\`\`\`\n<tool_call>\n${P}\n</tool_call>\n\`\`\`` }]))).toBe('tense');
    // Its object must hold the directive: anything else nameless stays a broken block.
    expect(moodOf(await once([{ text: '<tool_call>{"arcUpdates":[]}</tool_call>' }]))).toBe('failed: undecodable');
    expect(moodOf(await once([{ text: '<tool_call>{"directive":{"mood":"te' }]))).toBe('failed: undecodable'); // cut off
    expect(moodOf(await once([{ text: '<tool_call></tool_call>' }]))).toBe('failed: undecodable');
  });

  test('a nameless plan block counts in block order: after a <plan> it is an extra block, before one it is the plan', async () => {
    const after = await once([{ text: `<plan>${P}</plan>\n<tool_call>{"directive":{"mood":"calm"}}</tool_call>` }]);
    expect(moodOf(after)).toBe('tense');
    expect(after.ok && after.skipped).toEqual([{ path: 'plan', why: 'extra block' }]);
    const before = await once([{ text: `<tool_call>{"directive":{"mood":"calm"}}</tool_call>\n<plan>${P}</plan>` }]);
    expect(moodOf(before)).toBe('calm');
  });
});

describe('a plan envelope is unwrapped on both transports (D-117)', () => {
  const envelopes: [string, string][] = [
    ['name + arguments', `{"name":"commit_planning_round","arguments":${P}}`],
    ['name + args', `{"name":"plan","args":${P}}`],
    ['arguments as a JSON string', `{"name":"commit_planning_round","arguments":${JSON.stringify(P)}}`],
    ['in a fence', `\`\`\`json\n{"name":"Commit_Planning_Round","arguments":${P}}\n\`\`\``],
  ];
  for (const [name, text] of envelopes) {
    test(`structured transport: ${name}`, async () => {
      expect(moodOf(await once([{ text }], STRUCTURED_CAPS))).toBe('tense');
    });
    test(`tagged transport, a bare envelope with no tag: ${name}`, async () => {
      expect(moodOf(await once([{ text: `Here is my plan:\n${text}` }]))).toBe('tense');
    });
  }

  test('one level only, and only an exact envelope: other keys, another name or a nested envelope stay as they are', async () => {
    expect(moodOf(await once([{ text: `{"name":"commit_planning_round","arguments":${P},"id":"1"}` }], STRUCTURED_CAPS))).toBe('failed: missing_directive');
    expect(moodOf(await once([{ text: `{"name":"search_history","arguments":${P}}` }], STRUCTURED_CAPS))).toBe('failed: missing_directive');
    const nested = `{"name":"plan","arguments":{"name":"plan","arguments":${P}}}`;
    expect(moodOf(await once([{ text: nested }], STRUCTURED_CAPS))).toBe('failed: missing_directive');
    // Tagged: a bare object whose root (unwrapped) has no directive is still no output.
    expect(moodOf(await once([{ text: `{"name":"search_history","arguments":${P}}` }]))).toBe('failed: no_output');
  });

  test('the structured transport with the corrective pass: an envelope answer needs none', async () => {
    const r = rig(calls([{ text: `{"name":"commit_planning_round","arguments":${P}}` }]), { caps: STRUCTURED_CAPS });
    const out = await r.run();
    expect(moodOf(out)).toBe('tense');
    expect(out.attempts.map((a) => [a.transport, a.outcome])).toEqual([['structured', 'ok']]);
    expect(r.provider.requests.length).toBe(1);
  });
});

describe('fences, markup around, prose', () => {
  test.each([
    ['a ```json fence without a tag', `Here it is:\n\`\`\`json\n${P}\n\`\`\``],
    ['a ~~~ fence around the block', `~~~\n<plan>${P}</plan>\n~~~`],
    ['DSML markup around the block', `<｜DSML｜function_calls>\n<plan>${P}</plan>\n</｜DSML｜function_calls>`],
    ['chat-template tokens around the block', `<|channel|>final<|message|><plan>${P}</plan><|end|>`],
    ['prose on both sides', `Okay. The scene needs tension.\n\n<plan>${P}</plan>\n\nDone planning.`],
    ['a bare object with a directive after prose braces', `Plan {as asked}: ${P}`],
    ['a bare object with a directive and trailing commas (jsonrepair)', '{"directive":{"mood":"tense",},}'],
  ])('%s', async (_, text) => {
    expect(moodOf(await once([{ text }]))).toBe('tense');
  });

  test('a DSML call with no plan block and no directive object is no output', async () => {
    const dsml = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="plan">\n<｜DSML｜parameter name="mood" string="true">tense</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
    expect(moodOf(await once([{ text: dsml }]))).toBe('failed: no_output');
  });

  test('a <plan> mention in prose with no real block, then a bare or fenced plan object: the object is the plan (D-117; was undecodable under D-99)', async () => {
    expect(moodOf(await once([{ text: `I will write the <plan> now.\n${P}` }]))).toBe('tense');
    expect(moodOf(await once([{ text: `I will write the <plan> now.\n\`\`\`json\n${P}\n\`\`\`` }]))).toBe('tense');
    expect(moodOf(await once([{ text: `My <plan>: ${P}`}]))).toBe('tense');
    // On the structured transport too (a tag inside the object's own text no longer breaks it).
    expect(moodOf(await once([{ text: '{"directive":{"mood":"tense","narrativeGoal":"write the <plan> on the wall"}}' }], STRUCTURED_CAPS))).toBe('tense');
  });

  test('every tag block failed and no whole directive object: still the broken block (undecodable)', async () => {
    expect(moodOf(await once([{ text: 'I will write the <plan> now.\n{"arcUpdates":[]}' }]))).toBe('failed: undecodable');
    expect(moodOf(await once([{ text: 'I will write the <plan> now.' }]))).toBe('failed: undecodable');
    // A cut-off plan object after the mention is not whole: the cut block's failure stands.
    expect(moodOf(await once([{ text: 'I will write the <plan> now.\n{"directive":{"mood":"te' }]))).toBe('failed: undecodable');
  });

  test('a bare object without a directive is no output on the tagged transport', async () => {
    expect(moodOf(await once([{ text: '{"arcUpdates":[]}' }]))).toBe('failed: no_output');
    expect(moodOf(await once([{ text: 'I would rather not plan today.' }]))).toBe('failed: no_output');
    expect(moodOf(await once([{ text: '' }]))).toBe('failed: no_output');
  });

  test('on the structured transport the bare object IS the answer: read() decides (missing_directive)', async () => {
    expect(moodOf(await once([{ text: '{"arcUpdates":[]}' }], STRUCTURED_CAPS))).toBe('failed: missing_directive');
    expect(moodOf(await once([{ text: P }], STRUCTURED_CAPS))).toBe('tense');
  });

  test('a root that is not an object is undecodable', async () => {
    expect(moodOf(await once([{ text: '<plan>["tense"]</plan>' }]))).toBe('failed: undecodable');
    expect(moodOf(await once([{ text: '<plan>"just a string"</plan>' }]))).toBe('failed: undecodable');
  });

  test('a directive written as a string reaches read(), whose code is the result (invalid)', async () => {
    const out = await once([{ text: '<plan>{"directive":"be tense"}</plan>' }]);
    expect(out.ok ? 'ok' : [out.code, out.message]).toEqual(['invalid', 'directive must be an object, not a string']);
  });

  test('Russian text survives the scanner and the repair', async () => {
    const plan = '{"directive":{"mood":"напряжённый","narrativeGoal":"Мира находит карту «Ёлки»",}}';
    const out = await once([{ text: `Вот план:\n<plan>${plan}</plan>` }]);
    expect(out.ok && out.value.directive).toEqual({ mood: 'напряжённый', narrativeGoal: 'Мира находит карту «Ёлки»' });
  });
});

describe('answers in the reasoning (D-60; RoleCall cremecafe-glm-thinking)', () => {
  test('empty content and the plan in the reasoning: found there, outcome ok_reasoning, fromReasoning', async () => {
    const out = await once([{ reasoning: `Let me plan.\n<plan>${P}</plan>` }, { text: '' }]);
    expect(out.ok && out.value.directive).toEqual({ mood: 'tense' });
    expect(out.ok && out.fromReasoning).toBe(true);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['ok_reasoning']);
  });

  test('empty content and empty reasoning: no output (the call does not throw)', async () => {
    const out = await once([{ text: '' }]);
    expect(out.ok ? 'ok' : out.code).toBe('no_output');
    const quiet = await once([{ reasoning: '   ' }]);
    expect(quiet.ok ? 'ok' : quiet.code).toBe('no_output');
  });

  test('prose without a plan in the text, the plan in the reasoning: ok_reasoning', async () => {
    const out = await once([{ reasoning: `<plan>${P}</plan>` }, { text: 'The scene continues.' }]);
    expect(out.ok && out.fromReasoning).toBe(true);
  });

  test('a broken plan in the text is not replaced by the reasoning: undecodable', async () => {
    const out = await once([{ reasoning: `<plan>${P}</plan>` }, { text: '<plan>{"directive":{"mood":"te' }]);
    expect(out.ok ? 'ok' : out.code).toBe('undecodable');
  });

  test('GLM-thinking: the plan in both places is read from the text (no fromReasoning)', async () => {
    const out = await once([{ reasoning: '<plan>{"directive":{"mood":"draft"}}</plan>' }, { text: `<plan>${P}</plan>` }]);
    expect(moodOf(out)).toBe('tense');
    expect(out.ok && out.fromReasoning).toBeUndefined();
  });

  test('caps.reasoning.answerInReasoning: the reasoning IS the text (outcome ok, not ok_reasoning)', async () => {
    const caps = scriptCapsWith({ reasoning: { output: 'reasoning_content', control: 'none', canDisable: false, echo: 'never', answerInReasoning: true } });
    const out = await once([{ reasoning: `<plan>${P}</plan>` }], caps);
    expect(out.ok && out.fromReasoning).toBeUndefined();
    expect(out.attempts.map((a) => a.outcome)).toEqual(['ok']);
  });

  test('inline think tags are reasoning: a draft inside them is not the plan, the block after them is', async () => {
    const out = await once([{ text: `<think>draft: <plan>{"directive":{"mood":"draft"}}</plan></think>\n<plan>${P}</plan>` }]);
    expect(moodOf(out)).toBe('tense');
    const inside = await once([{ text: `<think><plan>${P}</plan></think>` }]);
    expect(inside.ok && inside.fromReasoning).toBe(true);
  });
});

describe("finish 'length': an answer cut off before the JSON closed", () => {
  test('a cut <plan> block is undecodable with or without the length finish', async () => {
    expect(moodOf(await once([{ text: '<plan>{"directive":{"mood":"te' }, { finish: 'length' }]))).toBe('failed: undecodable');
  });

  test('a cut bare object is undecodable at the length finish, repaired otherwise', async () => {
    expect(moodOf(await once([{ text: '{"directive":{"mood":"tense"' }, { finish: 'length' }]))).toBe('failed: undecodable');
    expect(moodOf(await once([{ text: '{"directive":{"mood":"tense"' }]))).toBe('tense');
  });

  test('a cut fence is undecodable at the length finish', async () => {
    expect(moodOf(await once([{ text: '```json\n{"directive":{"mood":"tense"},"arcUpdates":[{"arcId":"a' }, { finish: 'length' }]))).toBe('failed: undecodable');
  });

  test('a whole plan whose answer ran on to the limit is read', async () => {
    expect(moodOf(await once([{ text: `<plan>${P}</plan>\nAnd then I keep writing until` }, { finish: 'length' }]))).toBe('tense');
  });
});

describe('the pure finders', () => {
  test('firstObject: fence first, prose braces passed over, a broken object kept unless a readable one follows', () => {
    expect(firstObject('no braces here')).toBeNull();
    expect(firstObject('{as asked} and {"a": 1}')).toEqual({ json: '{"a": 1}', whole: true });
    expect(firstObject('{"a": 1} ```json\n{"b": 2}\n```')).toEqual({ json: '{"b": 2}', whole: true });
    // jsonrepair reads `{"a": }` as {"a": null}; `{"a" "b" "c"}` it cannot read.
    expect(firstObject('{"a": } x {"b": 2}')).toEqual({ json: '{"a": }', whole: true });
    expect(firstObject('{"a" "b" "c"} x {"b": 2}')).toEqual({ json: '{"b": 2}', whole: true });
    expect(firstObject('{"a" "b" "c"}')).toEqual({ json: '{"a" "b" "c"}', whole: true });
    expect(firstObject('lead {"a": {"b": 1}, "c": [')).toEqual({ json: '{"a": {"b": 1}, "c": [', whole: false });
    expect(firstObject('{"s": "a } b", "n": 1}')).toEqual({ json: '{"s": "a } b", "n": 1}', whole: true });
  });

  test('findPlan: the kinds', () => {
    expect(findPlan('nothing')).toEqual({ kind: 'none' });
    expect(findPlan('<plan>{"directive":{"mood":"te')).toEqual({ kind: 'broken', why: 'the plan block was cut off' });
    expect(findPlan('<plan>not json at all</plan>')).toEqual({ kind: 'broken', why: 'the plan block could not be read' });
    expect(findPlan(`<plan>${P}</plan><plan>${P}</plan>`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 1 });
    expect(findPlan('{"other": 1}')).toEqual({ kind: 'none' });
    expect(findPlan('{"other": 1}', { anyObject: true })).toEqual({ kind: 'json', json: '{"other": 1}', whole: true, block: false, extra: 0 });
    // D-117.
    expect(findPlan(`<tool_call>${P}</tool_call>`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 0 });
    expect(findPlan(`<tool_call>${P}</tool_call><plan>${P}</plan>`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 1 });
    expect(findPlan(`the <plan> then ${P}`)).toEqual({ kind: 'json', json: P, whole: true, block: false, extra: 0 });
    const env = `{"name":"plan","arguments":${P}}`;
    expect(findPlan(env)).toEqual({ kind: 'json', json: env, whole: true, block: false, extra: 0 });
  });

  test('readAnswer unwraps a plan envelope for tag "plan" on both transports, never for tag:null', () => {
    const env = `{"name":"commit_planning_round","arguments":${P}}`;
    const read = (tag: 'plan' | null, transport: 'structured' | 'tagged') => readAnswer({ text: env, reasoning: '' }, { tag, transport, read: (raw) => ({ ok: true, value: raw, skipped: [] }) });
    for (const transport of ['structured', 'tagged'] as const) expect(read('plan', transport)).toEqual({ ok: true, value: { directive: { mood: 'tense' } }, skipped: [], fromReasoning: false });
    expect(read(null, 'tagged')).toEqual({ ok: true, value: JSON.parse(env), skipped: [], fromReasoning: false });
  });

  test('readAnswer searches the reasoning only when the text found nothing', () => {
    const read = (text: string, reasoning: string) => readAnswer({ text, reasoning }, { tag: 'plan', transport: 'tagged', read: readPlanish });
    expect(read('', `<plan>${P}</plan>`)).toEqual({ ok: true, value: { directive: { mood: 'tense' } }, skipped: [], fromReasoning: true });
    expect(read(`<plan>${P}</plan>`, '')).toEqual({ ok: true, value: { directive: { mood: 'tense' } }, skipped: [], fromReasoning: false });
    expect(read('prose', 'more prose')).toEqual({ ok: false, code: 'no_output', message: 'no plan block was found' });
  });
});
