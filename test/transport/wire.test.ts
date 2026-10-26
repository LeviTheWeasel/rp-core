// Ported from Bunraku:src/stage/provider/request-overrides.test.ts, src/stage/params/custom.test.ts and
// src/stage/provider/transport-core.test.ts (finish reasons)@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// wire.ts: the tool protocol check, id remapping, merging, finish reasons and connection overrides.
// Override cases adapted from Bunraku src/stage/provider/request-overrides.test.ts and
// src/stage/params/custom.test.ts (protected keys and headers, case-insensitive header names).
import { describe, expect, test } from 'bun:test';
import type { Block } from '../../src/session/entries.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import {
  applyOverrides,
  mergeAdjacent,
  normalizeFinish,
  PROTECTED_BODY_KEYS,
  PROTECTED_HEADERS,
  remapToolIds,
  validateToolProtocol,
} from '../../src/providers/wire.ts';

const text = (t: string): Block => ({ k: 'text', text: t });
const call = (id: string, name = 'roll_dice', args = '{"sides":6}'): Block => ({ k: 'tool_call', id, name, args });
const result = (callId: string, name = 'roll_dice', t = '4'): Block => ({ k: 'tool_result', callId, name, text: t });
const msg = (role: PromptMsg['role'], blocks: Block[], extra: Partial<PromptMsg> = {}): PromptMsg => ({ role, blocks, src: 'history', ...extra });

const sys = msg('system', [text('You are the narrator.')]);
const user = msg('user', [text('Roll for me.')]);

function bad(messages: PromptMsg[], why: RegExp): void {
  const v = validateToolProtocol(messages);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.why).toMatch(why);
}

describe('validateToolProtocol: accepted', () => {
  test('no tools at all', () => {
    expect(validateToolProtocol([sys, user, msg('assistant', [text('Sure.')])])).toEqual({ ok: true });
    expect(validateToolProtocol([])).toEqual({ ok: true });
  });

  test('OpenAI shape: one tool message per result, in call order', () => {
    expect(
      validateToolProtocol([
        sys,
        user,
        msg('assistant', [text('Rolling.'), call('call_1'), call('call_2', 'look_up', '{"q":"x"}')]),
        msg('tool', [result('call_1')]),
        msg('tool', [result('call_2', 'look_up', 'found')]),
        msg('assistant', [text('A four.')]),
      ]),
    ).toEqual({ ok: true });
  });

  test('Anthropic shape: one user turn with every result (text after the results is fine)', () => {
    expect(
      validateToolProtocol([user, msg('assistant', [call('toolu_01A'), call('toolu_01B')]), msg('user', [result('toolu_01A'), result('toolu_01B'), text('continue')])]),
    ).toEqual({ ok: true });
  });

  test('several rounds; empty args count as {}; Kimi-style ids are safe', () => {
    expect(
      validateToolProtocol([
        user,
        msg('assistant', [call('functions.roll_dice:0', 'roll_dice', '')]),
        msg('tool', [result('functions.roll_dice:0')]),
        msg('assistant', [call('functions.roll_dice:1', 'roll_dice', '  ')]),
        msg('tool', [result('functions.roll_dice:1')]),
      ]),
    ).toEqual({ ok: true });
  });

  test('the request may end on the results (the model answers next)', () => {
    expect(validateToolProtocol([user, msg('assistant', [call('c1')]), msg('tool', [result('c1')])])).toEqual({ ok: true });
  });
});

describe('validateToolProtocol: refused', () => {
  test('a dangling batch at the end', () => bad([user, msg('assistant', [call('c1')])], /incomplete at the end/));
  test('a partly answered batch at the end', () => bad([user, msg('assistant', [call('c1'), call('c2')]), msg('tool', [result('c1')])], /incomplete at the end/));
  test('a message without results while a batch is open', () =>
    bad([user, msg('assistant', [call('c1')]), msg('user', [text('hello?')]), msg('tool', [result('c1')])], /incomplete before message 2/));
  test('a new assistant turn before the batch is answered', () =>
    bad([user, msg('assistant', [call('c1')]), msg('assistant', [call('c2')]), msg('tool', [result('c1')]), msg('tool', [result('c2')])], /incomplete before message 2/));
  test('a result without a call', () => bad([user, msg('tool', [result('ghost')])], /unknown call ghost/));
  test('a result answered twice', () => bad([user, msg('assistant', [call('c1')]), msg('tool', [result('c1')]), msg('tool', [result('c1')])], /already answered call c1/));
  test('results out of order', () => bad([user, msg('assistant', [call('c1'), call('c2')]), msg('tool', [result('c2')]), msg('tool', [result('c1')])], /out of order: c1/));
  test('a result naming another tool', () => bad([user, msg('assistant', [call('c1', 'roll_dice')]), msg('tool', [result('c1', 'look_up')])], /names look_up but the assistant called roll_dice/));
  test('duplicate ids, within a batch and across rounds', () => {
    bad([user, msg('assistant', [call('c1'), call('c1')]), msg('tool', [result('c1')]), msg('tool', [result('c1')])], /duplicate/);
    bad([user, msg('assistant', [call('c1')]), msg('tool', [result('c1')]), msg('assistant', [call('c1')]), msg('tool', [result('c1')])], /duplicate/);
  });
  test('unsafe ids', () => {
    for (const id of ['', 'has space', 'quote"', '<tag>', 'x'.repeat(129), 'new\nline', 'tab\t']) {
      bad([user, msg('assistant', [call(id)]), msg('tool', [result(id)])], /unsafe/);
    }
  });
  test('unsafe names', () => {
    for (const name of ['', 'bad name', '1starts_with_digit', 'x'.repeat(65), 'dots.not.allowed', 'emoji🙂']) {
      bad([user, msg('assistant', [call('c1', name)]), msg('tool', [result('c1', name)])], /unsafe/);
    }
  });
  test('arguments that are not a JSON object', () => {
    bad([user, msg('assistant', [call('c1', 'roll_dice', '{not json')]), msg('tool', [result('c1')])], /invalid JSON/);
    for (const args of ['[1,2]', 'null', '"text"', '42', 'true']) {
      bad([user, msg('assistant', [call('c1', 'roll_dice', args)]), msg('tool', [result('c1')])], /must be a JSON object/);
    }
  });
  test('tool calls outside an assistant message', () => {
    bad([msg('user', [call('c1')]), msg('tool', [result('c1')])], /require an assistant message, not user/);
    bad([msg('system', [call('c1')])], /require an assistant message/);
  });
  test('tool results outside a tool or user message', () => {
    bad([user, msg('assistant', [call('c1')]), msg('assistant', [result('c1')])], /must be in a tool or user message, not assistant/);
    bad([user, msg('assistant', [call('c1')]), msg('system', [result('c1')])], /not system/);
  });
});

describe('remapToolIds', () => {
  const convo = (): PromptMsg[] => [
    user,
    msg('assistant', [text('rolling'), call('call_abc123XYZ'), call('functions.look:1', 'look_up', '{}')]),
    msg('tool', [result('call_abc123XYZ')]),
    msg('tool', [result('functions.look:1', 'look_up')]),
    msg('assistant', [call('Ab3dE5gH9')]),
    msg('tool', [result('Ab3dE5gH9')]),
  ];
  const idsOf = (ms: PromptMsg[]): string[] =>
    ms.flatMap((m) => m.blocks.flatMap((b) => (b.k === 'tool_call' ? [b.id] : b.k === 'tool_result' ? [b.callId] : [])));

  test('without a format: an equal copy, not the same objects', () => {
    const input = convo();
    const out = remapToolIds(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out[1]).not.toBe(input[1]);
    expect(out[1]!.blocks[1]).not.toBe(input[1]!.blocks[1]);
  });

  test('mistral9: every id becomes 9 alphanumerics; calls and results stay paired; the protocol still holds', () => {
    const input = convo();
    const snapshot = JSON.stringify(input);
    const out = remapToolIds(input, 'mistral9');
    expect(JSON.stringify(input)).toBe(snapshot); // input untouched
    for (const id of idsOf(out)) expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
    const [c1, c2, r1, r2] = idsOf(out);
    expect(r1).toBe(c1);
    expect(r2).toBe(c2);
    expect(c1).not.toBe(c2);
    expect(validateToolProtocol(out)).toEqual({ ok: true });
    // Text and the rest of each message survive.
    expect(out[1]!.blocks[0]).toEqual(text('rolling'));
    expect(out[2]!.role).toBe('tool');
  });

  test('an id already in shape is kept (Mistral ids round-trip)', () => {
    const out = remapToolIds(convo(), 'mistral9');
    expect(idsOf(out).slice(4)).toEqual(['Ab3dE5gH9', 'Ab3dE5gH9']);
  });

  test('deterministic: the same id maps the same way in every request of a loop', () => {
    const first = remapToolIds(convo().slice(0, 4), 'mistral9');
    const later = remapToolIds(convo(), 'mistral9');
    expect(idsOf(later).slice(0, 4)).toEqual(idsOf(first));
    expect(remapToolIds(convo(), 'mistral9')).toEqual(later);
  });

  test('a generated id never collides with an id already in shape', () => {
    const generated = idsOf(remapToolIds([msg('assistant', [call('call_x')]), msg('tool', [result('call_x')])], 'mistral9'))[0]!;
    const out = remapToolIds(
      [msg('assistant', [call('call_x'), call(generated)]), msg('tool', [result('call_x')]), msg('tool', [result(generated)])],
      'mistral9',
    );
    const [a, b] = idsOf(out);
    expect(b).toBe(generated);
    expect(a).not.toBe(generated);
    expect(a).toMatch(/^[A-Za-z0-9]{9}$/);
  });

  test('many distinct ids stay distinct', () => {
    const blocks = Array.from({ length: 500 }, (_, i) => call(`call_${i}`));
    const out = remapToolIds([msg('assistant', blocks)], 'mistral9');
    expect(new Set(idsOf(out)).size).toBe(500);
  });
});

describe('mergeAdjacent', () => {
  test('neighbours of one role merge, text joined with a blank line, src listing both', () => {
    const out = mergeAdjacent([
      msg('system', [text('A')], { src: 'main' }),
      msg('system', [text('B')], { src: 'card' }),
      msg('user', [text('U1')], { src: 'history' }),
      msg('user', [text('U2')], { src: 'history' }),
      msg('user', [text('U3')], { src: 'post' }),
    ]);
    expect(out).toEqual([msg('system', [text('A\n\nB')], { src: 'main+card' }), msg('user', [text('U1\n\nU2\n\nU3')], { src: 'history+history+post' })]);
  });

  test('several text blocks in one message become one', () => {
    expect(mergeAdjacent([msg('user', [text('a'), text('b')]), msg('user', [text('c')])])).toEqual([msg('user', [text('a\n\nb\n\nc')], { src: 'history+history' })]);
  });

  test('a blank message adds no gap', () => {
    expect(mergeAdjacent([msg('user', [text('a')]), msg('user', [text('  ')]), msg('user', [text('b')])])[0]!.blocks).toEqual([text('a\n\nb')]);
  });

  test('tool traffic, replay and reasoning are never merged', () => {
    const toolCall = msg('assistant', [call('c1')]);
    const plain = msg('assistant', [text('after')]);
    const withReplay = msg('assistant', [text('r')], { replay: [{ kind: 'reasoning_details', connection: 'or', model: 'm', payload: [] }] });
    const withReasoning = msg('assistant', [{ k: 'reasoning', text: 'thought' }, text('t')]);
    const r1 = msg('tool', [result('c1')]);
    const r2 = msg('tool', [result('c2')]);
    for (const pair of [
      [toolCall, plain],
      [plain, withReplay],
      [withReasoning, plain],
      [r1, r2],
    ]) {
      expect(mergeAdjacent(pair)).toEqual(pair);
    }
  });

  test('different placement is never merged; equal placement is', () => {
    const head = msg('system', [text('h')], { placement: 'head' });
    const inline = msg('system', [text('i')], { placement: 'inline' });
    const none = msg('system', [text('n')]);
    expect(mergeAdjacent([head, inline])).toHaveLength(2);
    expect(mergeAdjacent([head, none])).toHaveLength(2);
    expect(mergeAdjacent([inline, { ...inline, src: 'x' }])).toEqual([msg('system', [text('i\n\ni')], { placement: 'inline', src: 'history+x' })]);
  });

  test('never mutates its input', () => {
    const input = [msg('user', [text('a')]), msg('user', [text('b')])];
    const snapshot = JSON.stringify(input);
    const out = mergeAdjacent(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    const single = mergeAdjacent([msg('user', [text('x')])]);
    expect(single[0]!.blocks[0]).not.toBe(input[0]!.blocks[0]);
    expect(out).toHaveLength(1);
  });
});

describe('normalizeFinish', () => {
  test('the documented table', () => {
    expect(['stop', 'end_turn', 'tool_calls'].map(normalizeFinish)).toEqual(['end', 'end', 'end']);
    expect(['length', 'max_tokens'].map(normalizeFinish)).toEqual(['length', 'length']);
    expect(normalizeFinish('content_filter')).toBe('content_filter');
  });
  test('other dialects and case', () => {
    expect(['STOP', 'COMPLETE', 'stop_sequence', 'tool_use', 'function_call', 'eos', 'pause_turn'].map(normalizeFinish)).toEqual(Array(7).fill('end'));
    expect(['MAX_TOKENS', 'max_output_tokens', 'model_context_window_exceeded'].map(normalizeFinish)).toEqual(Array(3).fill('length'));
    expect(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].map(normalizeFinish)).toEqual(Array(5).fill('content_filter'));
    expect(normalizeFinish('refusal')).toBe('refusal');
  });
  test('absent or unknown → end', () => {
    expect([null, undefined, '', 'something_new'].map(normalizeFinish)).toEqual(['end', 'end', 'end', 'end']);
  });
});

describe('applyOverrides', () => {
  const BODY = (): Record<string, unknown> => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    temperature: 0.8,
    top_k: 40,
    provider: { allow_fallbacks: false, order: ['a', 'b'] },
  });
  const HEADERS = (): Record<string, string> => ({ Authorization: 'Bearer key', 'Content-Type': 'application/json', 'X-Title': 'rp-core' });

  test('no overrides: copies, nothing ignored', () => {
    const body = BODY();
    const headers = HEADERS();
    const out = applyOverrides(body, headers, undefined);
    expect(out).toEqual({ body: BODY(), headers: HEADERS(), ignored: [] });
    expect(out.body).not.toBe(body);
    expect(out.body.provider).not.toBe(body.provider);
    expect(out.headers).not.toBe(headers);
  });

  test('exclude, then deep-merge: nested objects merge, arrays and scalars replace, null is sent as null', () => {
    const out = applyOverrides(BODY(), HEADERS(), {
      excludeBody: ['top_k', 'temperature', 'not_there'],
      extraBody: { temperature: 0.2, provider: { order: ['c'], sort: 'price' }, cache_prompt: true, reasoning: null },
    });
    expect(out.body).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.2, // excluded first, then set again by extraBody: the documented order
      provider: { allow_fallbacks: false, order: ['c'], sort: 'price' },
      cache_prompt: true,
      reasoning: null,
    });
    expect(out.ignored).toEqual([]);
  });

  test('protected body keys are never set or removed, and each attempt is reported', () => {
    const out = applyOverrides(BODY(), HEADERS(), {
      excludeBody: ['model', 'stream', 'top_k'],
      extraBody: { messages: [], tools: [{}], tool_choice: 'required', top_p: 0.9 },
    });
    expect(out.body.model).toBe('m');
    expect(out.body.stream).toBe(true);
    expect(out.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect('tools' in out.body).toBe(false);
    expect('tool_choice' in out.body).toBe(false);
    expect(out.body.top_p).toBe(0.9);
    expect('top_k' in out.body).toBe(false);
    expect(out.ignored).toEqual(['exclude_body.model', 'exclude_body.stream', 'extra_body.messages', 'extra_body.tools', 'extra_body.tool_choice']);
    for (const k of ['model', 'messages', 'stream', 'tools', 'tool_choice']) expect(PROTECTED_BODY_KEYS).toContain(k);
  });

  test('nested keys under an allowed key are free', () => {
    expect(applyOverrides({ model: 'm' }, {}, { extraBody: { provider: { model: 'x' } } }).body).toEqual({ model: 'm', provider: { model: 'x' } });
  });

  test('headers replace any letter case of the same name and are sent once', () => {
    const out = applyOverrides({}, HEADERS(), { headers: { 'x-title': 'mine', 'HTTP-Referer': 'https://example.org' } });
    expect(out.headers).toEqual({ Authorization: 'Bearer key', 'Content-Type': 'application/json', 'x-title': 'mine', 'HTTP-Referer': 'https://example.org' });
    expect(Object.keys(out.headers).filter((k) => k.toLowerCase() === 'x-title')).toEqual(['x-title']);
  });

  test('protected headers, in any case and with stray spaces, are skipped and reported', () => {
    const attempts = ['Authorization', 'authorization', 'X-Api-Key', 'API-KEY', ' Host ', 'content-type', 'Anthropic-Version', 'x-goog-api-key', 'Proxy-Authorization', 'Cookie', 'Content-Length'];
    const out = applyOverrides({}, HEADERS(), { headers: Object.fromEntries(attempts.map((k) => [k, 'stolen'])) });
    expect(out.headers).toEqual(HEADERS());
    expect(out.ignored).toEqual(attempts.map((k) => `headers.${k}`));
    for (const h of ['authorization', 'x-api-key', 'anthropic-version', 'content-type']) expect(PROTECTED_HEADERS).toContain(h);
  });

  test('a blank header name is skipped', () => {
    expect(applyOverrides({}, {}, { headers: { ' ': 'x' } })).toEqual({ body: {}, headers: {}, ignored: ['headers. '] });
  });

  test('never mutates its inputs', () => {
    const body = BODY();
    const headers = HEADERS();
    const o = { excludeBody: ['top_k'], extraBody: { provider: { sort: 'price' } }, headers: { 'X-Title': 'z' } };
    const snap = JSON.stringify([body, headers, o]);
    const out = applyOverrides(body, headers, o);
    expect(JSON.stringify([body, headers, o])).toBe(snap);
    // The merged body does not alias the override's objects either.
    (out.body.provider as Record<string, unknown>).sort = 'changed';
    expect(o.extraBody.provider.sort).toBe('price');
  });

  test('__proto__ in extraBody cannot pollute prototypes', () => {
    const extra = JSON.parse('{"__proto__":{"polluted":true},"a":{"__proto__":{"polluted":true},"b":1},"constructor":{"prototype":{"x":1}}}') as Record<string, unknown>;
    const out = applyOverrides({ a: {} }, {}, { extraBody: extra });
    expect(out.body).toEqual({ a: { b: 1 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.body)).toBe(Object.prototype);
  });
});
