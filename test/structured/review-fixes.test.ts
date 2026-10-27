// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// structuredCall after the M4 review and the first live run (m4-decisions D-121 item 4, D-122, D-123):
// the corrective pass lowers maxTokens by what its echo and correction add (and is skipped below the
// floor of 600); transport_unsupported is only a structured 400 bad_request before any output; an
// empty <plan></plan> / <plan/> / argument-less plan call is not the plan and no extra block.
import { describe, expect, test } from 'bun:test';
import { AGENT_OUTPUT_FLOOR, correctionEcho, correctionMaxTokens, correctionText, findPlan, readAnswer } from '../../src/agents/structured.ts';
import { MESSAGE_OVERHEAD_TOKENS } from '../../src/prompt/tokens.ts';
import { scriptCapsWith, type ScriptStep } from '../../src/providers/scripted.ts';
import { calls, P, readPlanish, rig, STRUCTURED_CAPS, textOfMsg } from './kit.ts';

const PLAN = `<plan>${P}</plan>`;
/** A deterministic counter: one token per three UTF-16 units, rounded up. */
const thirds = (s: string): number => Math.ceil(s.length / 3);

describe('D-121: the corrective pass keeps prompt + max_tokens where the caller put it', () => {
  test('with a counter: the second request asks for maxTokens − (echo + correction + two message overheads)', async () => {
    // The review's probe: a 5 000-char first answer (echoed as its first 1 000), maxTokens 12 768.
    const first = 'The scene should be tense. '.repeat(200);
    const r = rig(calls([{ text: first }], [{ text: PLAN }]), { input: { maxTokens: 12_768, count: thirds } });
    const out = await r.run();
    expect(out.ok).toBe(true);
    const [q0, q1] = r.provider.requests;
    expect(q0!.maxTokens).toBe(12_768); // the first request is the caller's
    const echo = textOfMsg(q1!.messages.at(-2)!);
    const correction = textOfMsg(q1!.messages.at(-1)!);
    expect(echo).toBe(correctionEcho({ text: first, reasoning: '' }));
    expect(correction).toBe(correctionText('no plan block was found', 'plan', 'tagged'));
    expect(q1!.maxTokens).toBe(12_768 - (thirds(echo) + thirds(correction) + 2 * MESSAGE_OVERHEAD_TOKENS));
    expect(q1!.maxTokens).toBeLessThan(12_768 - 300);
  });

  test("the corrective pass's own §6.6 retry asks for the same lowered maxTokens", async () => {
    const r = rig(calls([{ text: 'prose' }], [{ error: { code: 'overloaded', status: 503 } }], [{ text: PLAN }]), { input: { maxTokens: 4_000, count: thirds } });
    const out = await r.run();
    expect(out.attempts.map((a) => a.outcome)).toEqual(['no_output', 'retried', 'ok']);
    const [q0, q1, q2] = r.provider.requests;
    expect(q0!.maxTokens).toBe(4_000);
    expect(q1!.maxTokens).toBeLessThan(4_000);
    expect(q2!.maxTokens).toBe(q1!.maxTokens);
  });

  test('below the floor of 600 the corrective pass is not sent: the first attempt\'s code stands', async () => {
    // A constant counter puts the boundary exactly: left = maxTokens − (10 + 10 + 8).
    const ten = (): number => 10;
    const at = (maxTokens: number) => rig(calls([{ text: 'prose' }], [{ text: PLAN }]), { input: { maxTokens, count: ten } });
    const fits = at(AGENT_OUTPUT_FLOOR + 28);
    expect((await fits.run()).ok).toBe(true);
    expect(fits.provider.requests.map((q) => q.maxTokens)).toEqual([628, 600]);

    const short = at(AGENT_OUTPUT_FLOOR + 27);
    const out = await short.run();
    expect(out.ok ? 'ok' : out.code).toBe('no_output');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['no_output']);
    expect(out.calls.length).toBe(1);
    expect(short.provider.requests.length).toBe(1);
    expect(short.provider.remaining()).toBe(1);
  });

  test('skipped for want of room, an undecodable or missing_directive first answer keeps its own code', async () => {
    const cut = rig(calls([{ text: '<plan>{"directive":{"mood":"te' }, { finish: 'length' }], [{ text: PLAN }]), { input: { maxTokens: 650, count: thirds } });
    const a = await cut.run();
    expect(a.ok ? 'ok' : a.code).toBe('undecodable');
    expect(cut.provider.requests.length).toBe(1);
    // A Russian echo counts denser: 1 000 Cyrillic chars at chars/2.5 is 400 tokens.
    const ru = rig(calls([{ text: `<plan>{"directive":{}}</plan> ${'Мира смотрит на карту. '.repeat(60)}` }], [{ text: PLAN }]), {
      input: { maxTokens: 1_000, count: (s) => Math.ceil(s.length / 2.5) },
    });
    const b = await ru.run();
    expect(b.ok ? 'ok' : b.code).toBe('missing_directive');
    expect(ru.provider.requests.length).toBe(1);
  });

  test('without a counter nothing changes: the same maxTokens, and no floor', async () => {
    const r = rig(calls([{ text: 'prose' }], [{ text: PLAN }]), { input: { maxTokens: 300 } });
    expect((await r.run()).ok).toBe(true);
    expect(r.provider.requests.map((q) => q.maxTokens)).toEqual([300, 300]);
  });

  test('correctionMaxTokens: the arithmetic, the floor, and no counter', () => {
    expect(correctionMaxTokens(2_000, 'abc', 'abcdef', thirds)).toBe(2_000 - (1 + 2 + 2 * MESSAGE_OVERHEAD_TOKENS));
    expect(correctionMaxTokens(608, '', '', () => 0)).toBe(600);
    expect(correctionMaxTokens(607, '', '', () => 0)).toBeNull();
    expect(correctionMaxTokens(100, 'x'.repeat(1_000), 'y', undefined)).toBe(100);
  });
});

describe('D-122: transport_unsupported is a structured 400 bad_request before any output, nothing else', () => {
  test('a 400 inside a stream that already answered is a provider error (no caps.suggest), and no correction', async () => {
    const r = rig(calls([{ text: '{"directive": {"mood": "te' }, { error: { code: 'bad_request', status: 400 } }], [{ text: P }]), { caps: STRUCTURED_CAPS });
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('provider_error');
    expect(out.attempts.map((a) => [a.transport, a.outcome, a.status])).toEqual([['structured', 'provider_error', 400]]);
    expect(r.provider.requests.length).toBe(1);
  });

  test('a 400 the provider marks as after output (no text seen) is a provider error too', async () => {
    const r = rig(calls([{ error: { code: 'bad_request', status: 400, afterOutput: true } }]), { caps: STRUCTURED_CAPS });
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('provider_error');
  });

  test('reasoning before the 400 is output as well', async () => {
    const r = rig(calls([{ reasoning: 'Let me plan.' }, { error: { code: 'bad_request', status: 400 } }]), { caps: STRUCTURED_CAPS });
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('provider_error');
  });

  test('other refusals stay provider errors: another status, no status, another code', async () => {
    for (const error of [
      { code: 'bad_request', status: 422 },
      { code: 'bad_request' },
      { code: 'context_length_exceeded', status: 400 },
      { code: 'auth_failed', status: 401 },
    ] as const) {
      const r = rig(calls([{ error }]), { caps: STRUCTURED_CAPS });
      const out = await r.run();
      expect([error, out.ok ? 'ok' : out.code]).toEqual([error, 'provider_error']);
    }
  });

  test('the refusal itself still is transport_unsupported: HTTP 400 bad_request before any output', async () => {
    const r = rig(calls([{ error: { code: 'bad_request', status: 400 } }]), { caps: STRUCTURED_CAPS });
    const out = await r.run();
    expect(out.ok ? 'ok' : out.code).toBe('transport_unsupported');
  });
});

describe('D-123: an empty plan block is not the plan; the search goes on', () => {
  /** One tagged answer read through structuredCall WITH the corrective pass: how many calls it took. */
  async function read(steps: ScriptStep[], caps = scriptCapsWith()) {
    const r = rig(calls(steps, [{ text: `<plan>{"directive":{"mood":"second"}}</plan>` }]), { caps });
    const out = await r.run();
    return { out, sent: r.provider.requests.length, mood: out.ok ? out.value.directive['mood'] : `failed: ${out.code}` };
  }

  const empties: [string, string][] = [
    ['<plan></plan>', '<plan></plan>'],
    ['<plan/>', '<plan/>'],
    ['<plan />', '<plan />'],
    ['whitespace only', '<plan>   \n </plan>'],
    ['an empty object', '<plan>{}</plan>'],
    ['an empty planning tag', '<commit_planning_round></commit_planning_round>'],
    ['a plan envelope without arguments', '<plan>{"name":"plan"}</plan>'],
    ['a plan envelope with null arguments', '<plan>{"name":"plan","arguments":null}</plan>'],
    ['a <tool_call> named plan without arguments', '<tool_call>{"name":"plan"}</tool_call>'],
    ['a <tool_call> with empty arguments', '<tool_call>{"name":"commit_planning_round","arguments":{}}</tool_call>'],
    ['a <tool_call> with an empty string', '<tool_call>{"name":"plan","arguments":""}</tool_call>'],
    ['a python call without arguments', '<tool_call>commit_planning_round()</tool_call>'],
  ];

  for (const [name, empty] of empties) {
    test(`${name} before the real plan: the real plan, one call, no extra block`, async () => {
      const { out, sent, mood } = await read([{ text: `Format: ${empty}\n${PLAN}` }]);
      expect(mood).toBe('tense');
      expect(sent).toBe(1);
      expect(out.ok && out.skipped).toEqual([]);
      expect(out.attempts.map((a) => a.outcome)).toEqual(['ok']);
    });
  }

  test('the review probe: "Format: <plan></plan>" then the plan (was missing_directive + a corrective call)', () => {
    expect(findPlan(`Format: <plan></plan>\n${PLAN}`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 0 });
    expect(findPlan(`<tool_call>{"name":"plan"}</tool_call>\n${PLAN}`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 0 });
  });

  test('empty blocks after the plan are not extra blocks; a real later block still is', () => {
    expect(findPlan(`${PLAN}\n<plan></plan>\n<plan/>`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 0 });
    const calm = '{"directive":{"mood":"calm"}}';
    expect(findPlan(`${PLAN}<plan></plan><plan>${calm}</plan>`)).toEqual({ kind: 'json', json: P, whole: true, block: true, extra: 1 });
  });

  test('only empty blocks: an empty plan, so read() says the directive is missing (probes 5 and 6 keep their code)', async () => {
    expect(findPlan('<plan></plan>')).toEqual({ kind: 'json', json: '{}', whole: true, block: true, extra: 0, empty: true });
    expect(findPlan('<plan/> and <tool_call>{"name":"plan"}</tool_call>')).toEqual({ kind: 'json', json: '{}', whole: true, block: true, extra: 0, empty: true });
    const { out, mood } = await read([{ text: '<plan></plan>' }]);
    expect(mood).toBe('second');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['missing_directive', 'ok']);
  });

  test('an empty block, then a bare or fenced plan object: the object is the plan', async () => {
    expect((await read([{ text: `<plan></plan>\n${P}` }])).mood).toBe('tense');
    expect((await read([{ text: `<plan>{}</plan>\nHere: ${P}` }])).mood).toBe('tense');
    expect((await read([{ text: `<plan/>\n\`\`\`json\n${P}\n\`\`\`` }])).mood).toBe('tense');
  });

  test('an empty block before a cut-off plan: the cut block decides (undecodable)', () => {
    expect(findPlan('<plan></plan>\n<plan>{"directive":{"mood":"te')).toEqual({ kind: 'broken', why: 'the plan block was cut off' });
  });

  test('a <plan></plan> written inside the plan\'s own text no longer hides it', async () => {
    const own = '{"directive":{"mood":"tense","narrativeGoal":"she writes <plan></plan> on the wall"}}';
    const { out, sent } = await read([{ text: own }]);
    expect(out.ok && out.value.directive).toEqual({ mood: 'tense', narrativeGoal: 'she writes <plan></plan> on the wall' });
    expect(sent).toBe(1);
  });

  test('an empty block in the text: a real plan in the reasoning is taken; otherwise the empty block stands', () => {
    const r = (text: string, reasoning: string) => readAnswer({ text, reasoning }, { tag: 'plan', transport: 'tagged', read: readPlanish });
    expect(r('<plan></plan>', `Thinking.\n${PLAN}`)).toEqual({ ok: true, value: { directive: { mood: 'tense' } }, skipped: [], fromReasoning: true });
    expect(r('<plan></plan>', 'Just thinking.')).toEqual({ ok: false, code: 'missing_directive', message: 'the plan has no directive' });
    expect(r('<plan></plan>', '<plan/>')).toEqual({ ok: false, code: 'missing_directive', message: 'the plan has no directive' });
    expect(r('<plan></plan>', 'I will write the <plan> now.')).toEqual({ ok: false, code: 'missing_directive', message: 'the plan has no directive' });
  });

  test('arguments that are there but cannot be read keep the block: undecodable, as before', async () => {
    const out = await rig(calls([{ text: '<plan>["tense"]</plan>' }]), { input: { repair: false } }).run();
    expect(out.ok ? 'ok' : out.code).toBe('undecodable');
  });

  test('the structured transport: an empty block before the object is passed over too', async () => {
    const { mood, sent } = await read([{ text: `<plan></plan>${P}` }], STRUCTURED_CAPS);
    expect(mood).toBe('tense');
    expect(sent).toBe(1);
  });
});
