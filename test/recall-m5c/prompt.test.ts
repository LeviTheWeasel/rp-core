// Ported from Bunraku:src/core/compendium/recall-core.test.ts@702d8120 ("the request": the selector
// prompt, the index and conversation, the JSON ask; the guidance and the hard requirement; guidance is
// bounded).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/recall.ts recallRequest (M5c, D-198): the full prompt is Bunraku's rendered text
// (bunraku-golden.ts) but the listed edits — the prefetch line, the conversation cap, the guidance
// without a Guide; the lite prompt is pinned; the call's numbers, the schema and the top-up.
import { describe, expect, test } from 'bun:test';
import {
  betterRead,
  LITE_RECALL_SYSTEM,
  MAX_RECALL_GUIDANCE,
  moreNudge,
  needsTopUp,
  PREFETCH_LINE,
  RECALL_SYSTEM,
  recallDeadlineMs,
  recallRequest,
  recallSettings,
  topUpUser,
  type RecallRead,
  type RecallRequestInput,
} from '../../src/agents/compendium/recall.ts';
import { AGENT_OUTPUT_FLOOR, type StructuredResult } from '../../src/agents/structured.ts';
import { O200K_COUNTER } from '../../src/prompt/tokens.ts';
import { BUNRAKU_GUIDED, BUNRAKU_MORE_1_3, BUNRAKU_PLAIN } from './bunraku-golden.ts';
import { count, fakeIndex } from './kit.ts';

const HELLO = [
  { role: 'user', text: 'Hello' },
  { role: 'assistant', text: 'Hi' },
];

const base = (o: Partial<RecallRequestInput> = {}): RecallRequestInput => ({
  index: fakeIndex('INDEX', 3),
  conversation: HELLO,
  profile: 'full',
  window: 32_768,
  guidance: '',
  prefetch: false,
  minEntries: 0,
  maxEntries: 10,
  contextMessages: 20,
  reasoningOff: true,
  count,
  ...o,
});

const read = (handles: string[]): RecallRead => ({ picks: handles.map((h) => ({ ref: `k${h.slice(1)}`, handle: h })), unknown: 0, repeated: 0, trimmed: 0, byName: 0, salvaged: 0 });

describe('the full prompt is Bunraku’s, but the listed edits (D-198 golden)', () => {
  test('no minimum, no guidance: system and user are Bunraku’s rendered text', () => {
    const r = recallRequest(base());
    expect(r.system).toBe(BUNRAKU_PLAIN.system);
    expect(r.system).toBe(RECALL_SYSTEM);
    expect(r.user).toBe(BUNRAKU_PLAIN.user);
  });

  test('a minimum and guidance: the HARD REQUIREMENT and the guidance block, word for word', () => {
    const r = recallRequest(base({ minEntries: 3, guidance: '  INLINE \n' }));
    expect(r.system).toBe(BUNRAKU_GUIDED.system);
    expect(r.user).toBe(BUNRAKU_GUIDED.user);
  });

  test('edit 1: a prefetch run ends the user message with the prefetch line, nothing else changes', () => {
    const r = recallRequest(base({ prefetch: true }));
    expect(r.system).toBe(BUNRAKU_PLAIN.system);
    expect(r.user).toBe(`${BUNRAKU_PLAIN.user}\n${PREFETCH_LINE}`);
    expect(PREFETCH_LINE).toBe('The player has not answered yet; pick what the narrator will most likely need for the next reply.');
  });

  test('edit 2: the conversation keeps the newest contextMessages within min(8 000, 20 %) tokens, a message that does not fit cut head and tail', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `Message ${i}.` }));
    const r = recallRequest(base({ conversation: many }));
    expect(r.messages).toBe(20);
    expect(r.user).toContain('## Recent Conversation (last 20 messages)\n\n[user]: Message 10.\n\n');
    expect(r.user).not.toContain('Message 9.');

    // 20 % of 10 000 = 2 000 tokens: the newest (3 000 chars ≈ 1 000) fits, the next is cut, older ones go.
    const long = (tag: string): string => `${tag}-head ${'w'.repeat(3000)} ${tag}-tail`;
    const big = recallRequest(base({ window: 10_000, conversation: [{ role: 'user', text: long('A') }, { role: 'assistant', text: long('B') }, { role: 'user', text: long('C') }, { role: 'user', text: 'Now?' }] }));
    expect(big.messages).toBe(3);
    expect(big.user).not.toContain('A-head');
    expect(big.user).toContain('[assistant]: B-head');
    expect(big.user).toContain('characters cut from the middle');
    expect(big.user).toContain('B-tail');
    expect(big.user).toContain(`[user]: ${long('C')}\n\n[user]: Now?`);
    const talk = big.user.slice(big.user.indexOf('[assistant]'), big.user.indexOf('\n\nAnswer with'));
    expect(talk.split('\n\n[').reduce((n, l, i) => n + count(i === 0 ? l : `[${l}`), 0)).toBeLessThanOrEqual(2000);
  });

  test('the newest message alone over the cap is cut to it', () => {
    const r = recallRequest(base({ window: 5000, conversation: [{ role: 'assistant', text: '   ' }, { role: 'user', text: `start ${'z'.repeat(9000)} end` }] }));
    expect(r.messages).toBe(1);
    expect(r.user).toContain('(last 1 messages)');
    expect(r.user).toContain('[user]: start');
    expect(r.user).toContain(' end\n\nAnswer with');
  });

  test('the guidance is bounded (Bunraku: 8 000 characters), never splitting a surrogate pair', () => {
    const r = recallRequest(base({ guidance: 'x'.repeat(MAX_RECALL_GUIDANCE * 2) }));
    expect(r.system.length).toBeLessThan(RECALL_SYSTEM.length + MAX_RECALL_GUIDANCE + 400);
    const pair = recallRequest(base({ guidance: `${'x'.repeat(MAX_RECALL_GUIDANCE - 1)}😀tail` }));
    expect(pair.system).toContain(`\n${'x'.repeat(MAX_RECALL_GUIDANCE - 1)}\nThis guidance may prioritize`);
  });

  test('a minimum above the cap is the cap', () => {
    const r = recallRequest(base({ index: fakeIndex('INDEX', 10), minEntries: 12, maxEntries: 4 }));
    expect(r.system).toContain('at least 4 entries');
    expect(r.user).toContain('Select between 4 and 4 entries.');
  });
});

describe('the lite prompt (pinned; D-198)', () => {
  test('a short system without WILD CARD, the index without headings, at most N, an empty list fine', () => {
    const r = recallRequest(base({ profile: 'lite', index: fakeIndex('[e1] Mira', 1, 'lite'), maxEntries: 4, minEntries: 2, window: 16_384 }));
    expect(r.system).toBe(LITE_RECALL_SYSTEM);
    expect(LITE_RECALL_SYSTEM).toBe(
      [
        "You pick the knowledge entries the narrator needs for its next reply. Pick only:",
        '- ACTIVE - characters present, the current location, items, powers or concepts in use;',
        '- ANTICIPATED - what is about to be needed: someone about to appear, a place being traveled to, a thread about to pay off.',
        'Leave out everything else. A few right picks beat many loose ones.',
      ].join('\n'),
    );
    expect(r.system).not.toContain('WILD CARD');
    // ≈ 90 tokens (§7.4.2) by a real tokenizer.
    expect(O200K_COUNTER.count(r.system)).toBeLessThanOrEqual(90);
    expect(r.user).toBe(
      '## Knowledge Index\n\n[e1] Mira\n\n## Recent Conversation (last 2 messages)\n\n[user]: Hello\n\n[assistant]: Hi\n\n' +
        'Answer with one JSON object and nothing else: {"entry_ids": ["e1"]}. Use only the [eN] handles shown in the index. Select at most 4 entries; an empty list is fine.',
    );
    expect(r).toMatchObject({ profile: 'lite', maxTokens: 200, temperature: 0.3, repair: false, fits: true });
    expect(r.schema.schema).toEqual({ type: 'object', properties: { entry_ids: { type: 'array', items: { type: 'string', enum: ['e1'] } } }, required: ['entry_ids'] });
  });

  test('lite: the prefetch line, the guidance cut to 1 000, messages cut at 1 200 characters and held to 1 500 tokens', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `M${i} ${'y'.repeat(2000)} E${i}` }));
    const r = recallRequest(base({ profile: 'lite', index: fakeIndex('[e1] Mira', 1, 'lite'), conversation: msgs, guidance: 'g'.repeat(5000), prefetch: true, contextMessages: 6, window: 32_768 }));
    expect(r.user.endsWith(`an empty list is fine.\n${PREFETCH_LINE}`)).toBe(true);
    expect(r.system).toContain(`## USER RETRIEVAL GUIDANCE\n${'g'.repeat(1000)}\nThis guidance`);
    expect(r.user).not.toContain('M0 ');
    expect(r.user).not.toContain('M1 ');
    expect(r.user).toContain('E7\n\n');
    for (const line of r.user.split('\n\n').filter((l) => /^\[(user|assistant)\]/.test(l))) expect(line.length).toBeLessThanOrEqual(1200 + 20);
    const talk = r.user.split('\n\n').filter((l) => /^\[(user|assistant)\]/.test(l));
    expect(talk.reduce((n, l) => n + count(l), 0)).toBeLessThanOrEqual(1500);
  });

  test('lite on a small window: the whole request stays within 40 % of it', () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', text: `${'q'.repeat(1100)} ${i}` }));
    const r = recallRequest(base({ profile: 'lite', index: fakeIndex('[e1] Mira', 1, 'lite'), conversation: msgs, contextMessages: 6, window: 4096 }));
    expect(r.tokens).toBeLessThanOrEqual(Math.floor(0.4 * 4096));
    expect(r.messages).toBeGreaterThan(0);
  });
});

describe('the call’s numbers (D-198)', () => {
  test('full: temperature 0.3, 2 000 tokens, +1 024 when reasoning stays on, the corrective pass', () => {
    expect(recallRequest(base())).toMatchObject({ maxTokens: 2000, temperature: 0.3, repair: true, fits: true, profile: 'full' });
    expect(recallRequest(base({ reasoningOff: false })).maxTokens).toBe(3024);
    expect(recallRequest(base({ profile: 'lite', index: fakeIndex('x', 1, 'lite'), reasoningOff: false })).maxTokens).toBe(1224);
  });

  test('the answer never asks past the window; below its floor the request does not fit', () => {
    const r = recallRequest(base({ window: 900 }));
    expect(r.tokens + r.maxTokens).toBeLessThanOrEqual(900);
    expect(r.maxTokens).toBeLessThan(AGENT_OUTPUT_FLOOR);
    expect(r.fits).toBe(false);
    const lite = recallRequest(base({ profile: 'lite', index: fakeIndex('x', 1, 'lite'), window: 700 }));
    expect(lite.fits).toBe(true);
    expect(lite.maxTokens).toBe(200);
  });

  test('the schema: entry_ids with an enum of handles up to 200, reasons (full) optional', () => {
    const full = recallRequest(base());
    expect(full.schema).toEqual({
      name: 'recall',
      schema: {
        type: 'object',
        properties: { entry_ids: { type: 'array', items: { type: 'string', enum: ['e1', 'e2', 'e3'] } }, reasons: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['entry_ids'],
      },
    });
    const many = recallRequest(base({ index: fakeIndex('INDEX', 201) }));
    expect((many.schema.schema as { properties: { entry_ids: { items: unknown } } }).properties.entry_ids.items).toEqual({ type: 'string' });
  });

  test('settings by profile, the minimum held to the cap; deadlines from the grant', () => {
    expect(recallSettings({ minEntries: 0 }, 'full')).toEqual({ maxEntries: 10, minEntries: 0, contextMessages: 20 });
    expect(recallSettings({ minEntries: 6 }, 'lite')).toEqual({ maxEntries: 4, minEntries: 4, contextMessages: 6 });
    expect(recallSettings({ maxEntries: 15, minEntries: 2, contextMessages: 40 }, 'lite')).toEqual({ maxEntries: 15, minEntries: 2, contextMessages: 40 });
    expect(recallDeadlineMs({ prefetch: false, local: true })).toBe(30_000);
    expect(recallDeadlineMs({ prefetch: false, local: false })).toBe(20_000);
    expect(recallDeadlineMs({ prefetch: true, local: true })).toBe(60_000);
    expect(recallDeadlineMs({ prefetch: true, local: false, timeoutSec: 7 })).toBe(7000);
  });
});

describe('the top-up (D-198: full only, one call, wins only with more picks)', () => {
  const r = recallRequest(base({ minEntries: 3 }));

  test('fewer picks than the minimum asks once more, with the first answer and Bunraku’s moreNudge', () => {
    expect(moreNudge(1, 3)).toBe(BUNRAKU_MORE_1_3);
    expect(needsTopUp(read(['e1']), { profile: 'full', minEntries: 3, maxEntries: 10 })).toBe(true);
    expect(needsTopUp(read(['e1', 'e2', 'e3']), { profile: 'full', minEntries: 3, maxEntries: 10 })).toBe(false);
    expect(needsTopUp(read([]), { profile: 'lite', minEntries: 3, maxEntries: 4 })).toBe(false);
    expect(needsTopUp(read(['e1', 'e2']), { profile: 'full', minEntries: 5, maxEntries: 2 })).toBe(false);
    expect(topUpUser(r, read(['e1']), 3)).toEqual([r.user, `Your last answer: {"entry_ids":["e1"]}\n${BUNRAKU_MORE_1_3}`]);
  });

  test('the second answer replaces the first only when it read and has more picks', () => {
    const first = read(['e1']);
    const ok = (v: RecallRead): StructuredResult<RecallRead> => ({ ok: true, value: v, transport: 'tagged', skipped: [], attempts: [], calls: [] });
    expect(betterRead(first, ok(read(['e1', 'e2'])))).toEqual(read(['e1', 'e2']));
    expect(betterRead(first, ok(read(['e2'])))).toBe(first);
    expect(betterRead(first, { ok: false, code: 'no_output', attempts: [], calls: [] })).toBe(first);
    expect(betterRead(first, undefined)).toBe(first);
  });
});
