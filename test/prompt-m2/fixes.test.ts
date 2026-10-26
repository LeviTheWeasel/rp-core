// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M2 fix regressions in assemble: the greeting as the budget's last resort (§11, ST's
// populateChatHistory), the continue cue inside the budget, {{outlet::x}} resolved wherever it stands
// (ST's outlet macro), and lore that fired into a slot the preset does not send (trace.lore.unsent).
import { describe, expect, test } from 'bun:test';
import { BUILTIN_PRESET, type Preset } from '../../src/formats/native.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { shape } from '../../src/prompt/shape.ts';
import { CHARS_COUNTER, estimateMessages } from '../../src/prompt/tokens.ts';
import { CAPS } from '../assemble/fixtures.ts';
import { allText, always, greet, input, m, MIRA, ok, path, source, withLore } from './fixtures.ts';

describe('the greeting is left out only as the last resort before a refusal', () => {
  // ST's Default.json numbers: window 4095, reply 300 → 3795 prompt tokens, lore budget 949 (chars/3).
  const desc = 'd'.repeat(3 * 1400);
  const greeting = 'g'.repeat(3 * 1400);
  const view = () => path([greet('g', greeting), m('u1', 'user', 'Hi.'), m('a1', 'assistant', 'Hello.'), m('u2', 'user', 'Tell me about the harbor.')]);
  const card = { ...MIRA, description: desc, greetings: [greeting] };
  const base = { cast: { character: card }, window: 4095, reserve: 300, tokenFactor: 1, counter: CHARS_COUNTER } as const;

  test("a long greeting plus lore within its 25 %: sent without the greeting (it used to be refused), with a notice", () => {
    const r = ok(assemble(input({ ...base, view: view(), lorebooks: [source('w', [always('L1', { content: 'l'.repeat(3 * 900) })])] })));
    expect(allText(r.messages)).not.toContain(greeting);
    // the cut stays on D-49's grid: with the greeting droppable, the next cut point is the protected tail
    expect(r.trace.trimmed).toEqual({ from: 'g', to: 'a1' });
    expect(r.notices.map((n) => n.code)).toEqual(['greeting_dropped']);
    expect(r.trace.tokens.estimated).toBeLessThanOrEqual(4095 - 300);
  });

  test('without the lore the greeting fits and stays', () => {
    const r = ok(assemble(input({ ...base, view: view() })));
    expect(allText(r.messages)).toContain(greeting);
    expect(r.notices).toEqual([]);
  });

  test('still too big without the greeting: refused, and the message names the lore and the greeting with numbers', () => {
    const big = { ...card, description: 'd'.repeat(3 * 3000) };
    const r = assemble(input({ ...base, cast: { character: big }, view: view(), lorebooks: [source('w', [always('L1', { content: 'l'.repeat(3 * 900) })])] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('context_length_exceeded');
    expect(r.message).toMatch(/lore included: \d+ of its budget 949/);
    expect(r.message).toContain('the greeting (1404 tokens) is already left out');
    expect(r.message).toContain("the preset's blocks");
  });
});

describe('a continue in cue mode budgets the cue shape() adds', () => {
  test('prompt plus max_tokens stays inside the window (history trimmed or refused, never over)', () => {
    const v = path([greet('g', 'Hello, traveller.'), m('u1', 'user', 'Hi.'), m('a1', 'assistant', 'She opens the map and')]);
    const caps = { ...CAPS, prefill: 'none' as const };
    const common = { view: v, upTo: 'a1', kind: 'continue' as const, caps, tokenFactor: 1, reserve: 100 };
    const probe = ok(assemble(input({ ...common, window: 100_000 })));
    const window = probe.trace.tokens.estimated + 100; // the assembled messages alone fill it exactly
    const r = assemble(input({ ...common, window }));
    if (!r.ok) return expect(r.code).toBe('context_length_exceeded');
    const out = shape({ messages: r.messages, caps, prefill: r.prefill, kind: 'continue' });
    expect(estimateMessages(out.messages, CHARS_COUNTER) + 100).toBeLessThanOrEqual(window);
  });
});

describe('{{outlet::x}} resolves wherever it stands, as ST\'s outlet macro (never the raw tag)', () => {
  const loc = always('loc', { position: { outlet: 'loc' }, content: 'The harbor is closed.' });

  test("the author's note, the card's depth prompt, the description and scenario get the outlet's text", () => {
    const card = {
      ...MIRA,
      description: 'Desc: {{outlet::loc}}',
      scenario: 'Scen: {{outlet::loc}}',
      depthPrompt: { text: 'Card: {{outlet::loc}}', depth: 1, role: 'system' as const },
    };
    const r = withLore([loc], { cast: { character: card }, authorNote: { text: 'Remember: {{outlet::loc}}', depth: 2, role: 'system' } });
    const sent = allText(r.messages);
    expect(sent).not.toContain('{{outlet::');
    expect(sent).toContain('Remember: The harbor is closed.');
    expect(sent).toContain('Card: The harbor is closed.');
    expect(sent).toContain('Desc: The harbor is closed.');
    expect(sent).toContain('Scen: The harbor is closed.');
    // named by something sent: not reported as unsent
    expect(r.trace.lore.unsent).toBeUndefined();
  });

  test('inside lore content (expanded before the outlets exist) and for an outlet nothing fired: empty', () => {
    const depth = always('d', { position: { depth: 1 }, content: 'Depth: [{{outlet::loc}}] [{{outlet::none}}]' });
    const r = withLore([loc, depth], { authorNote: { text: 'AN [{{outlet::none}}]', depth: 3, role: 'system' } });
    const sent = allText(r.messages);
    expect(sent).not.toContain('{{outlet::');
    expect(sent).toContain('Depth: [] []');
    expect(sent).toContain('AN []');
  });
});

describe('lore that fired into a slot the preset does not send is marked, not hidden', () => {
  const noBefore: Preset = { ...BUILTIN_PRESET, blocks: BUILTIN_PRESET.blocks.map((b) => (b.content.includes('{{lore::before}}') ? { ...b, enabled: false } : b)) };

  test("a disabled {{lore::before}} block: the entry still fired (ST), trace.lore.unsent names it, a notice says so", () => {
    expect(BUILTIN_PRESET.blocks.some((b) => b.content.includes('{{lore::before}}'))).toBe(true);
    const r = withLore([always('B'), always('A', { position: 'after' })], { preset: noBefore });
    expect(r.trace.lore.fired.map((f) => f.id)).toEqual(['B', 'A']);
    expect(allText(r.messages)).not.toContain('B text');
    expect(r.trace.lore.unsent).toEqual({ 'lib:B': '{{lore::before}}' });
    expect(r.notices.map((n) => n.code)).toContain('lore_unsent');
    expect(r.notices.find((n) => n.code === 'lore_unsent')!.message).toContain('the preset has no enabled {{lore::before}}');
  });

  test('an outlet nothing names is unsent; with the default preset nothing is', () => {
    const r = withLore([always('O', { position: { outlet: 'side' } })]);
    expect(r.trace.lore.unsent).toEqual({ 'lib:O': '{{outlet::side}}' });
    const fine = withLore([always('B')]);
    expect(fine.trace.lore.unsent).toBeUndefined();
    expect(fine.notices.map((n) => n.code)).not.toContain('lore_unsent');
  });
});

describe('o200k memo: a very long chat is tokenized once, not once per pass', () => {
  test('5000 messages: a second assemble plus the engine passes over the same history run almost no BPE', async () => {
    // Regression: the memo was an LRU of 4096 texts; with more messages in the request every
    // in-order pass (assemble, two traceForSent, the server check) missed and re-tokenized the chat.
    const { O200K_COUNTER, o200kRuns, estimateMessages: est } = await import('../../src/prompt/tokens.ts');
    const { traceForSent } = await import('../../src/prompt/assemble.ts');
    const msgs = [greet('g', 'Hello, traveller.')];
    for (let i = 0; i < 5000; i++) msgs.push(m(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `Message number ${i}: the harbor bell rang ${i} times across the grey water.`));
    const view = path(msgs);
    const at = (): ReturnType<typeof assemble> => assemble(input({ view, window: 2_000_000, reserve: 1000, counter: O200K_COUNTER }));
    const first = ok(at());
    expect(first.trace.trimmed).toBeNull();
    const before = o200kRuns();
    const again = ok(at());
    traceForSent(again.trace, again.messages);
    traceForSent(again.trace, again.messages);
    est(again.messages, O200K_COUNTER);
    // Only short texts (under the memo's 64 characters) are counted again.
    expect(o200kRuns() - before).toBeLessThan(100);
  }, 60_000);
});
