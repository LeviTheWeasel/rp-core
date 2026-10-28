// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-208 through the engine (.notes/m5c-decisions.md section J): a recall call to a model on the tagged
// transport whose caps take a prefill sends `{"entry_ids": [` as the trailing assistant message (the
// top-up too), and the answer is read as the opening followed by the model's text; a model on the
// structured transport, or one whose caps take no prefill, gets none and its answer is read alone.
// Core#8 (the top-up half): the minimum is held to the entries the index shows, so an answer that
// picks every one of them asks for no top-up.
import { describe, expect, test } from 'bun:test';
import { RECALL_OPENING } from '../../src/agents/compendium/recall.ts';
import { buildChatRequest } from '../../src/providers/openai-chat.ts';
import type { ModelRequest } from '../../src/providers/types.ts';
import { agentsOf, fullCaps, keyOf, line, msgOf, narr, picks, recallRig, recallSession, turnOf } from './kit.ts';

/** The last message of the request as the openai-chat wire would send it (pure: nothing is contacted). */
function wireTail(req: ModelRequest): unknown {
  const http = buildChatRequest(req, { connectionId: 'script', baseUrl: 'http://model.invalid/v1', local: false }, null);
  const body = JSON.parse(http.body!) as { messages: unknown[] };
  return body.messages.at(-1);
}

/** The recall requests of the provider, in order. */
const recallReqs = (reqs: readonly ModelRequest[]): ModelRequest[] => reqs.filter((q) => q.agent === 'recall');

describe('the JSON prefill of recall (D-208)', () => {
  test('tagged, caps that take a prefill: the opening is the trailing assistant message; the answer is read as opening + text', async () => {
    const r = await recallRig([line('recall', [{ text: '"Арсений Кеттер", "Серый маяк"]}' }]), narr()], { caps: fullCaps() });
    const s = recallSession(r, { mode: 'sync' });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    const [req] = recallReqs(r.provider.requests);
    expect(req!.prefill).toBe(RECALL_OPENING);
    expect(wireTail(req!)).toEqual({ role: 'assistant', content: '{"entry_ids": [' });
    // The continuation alone holds no selection (a JSON string and closers): read after the opening, it picks two.
    const rec = msgOf(r.home, s.id, turn.messageId)!.recall as Record<string, unknown>;
    expect(rec).toMatchObject({ status: 'recalled', source: 'sync', transport: 'tagged', calls: 1, byName: 2 });
    expect((rec.picks as { ref: string }[]).map((p) => p.ref)).toEqual([keyOf(s, 'Арсений Кеттер'), keyOf(s, 'Серый маяк')]);
    // The narrator's own request carries no recall opening.
    expect(r.provider.requests.find((q) => q.agent === 'narrator')!.prefill).toBeUndefined();
    await r.engine.close();
  });

  test('the top-up sends the opening too, and its continuation is read the same way', async () => {
    const r = await recallRig(
      [line('recall', [{ text: '"Арсений Кеттер"]}' }]), line('recall', [{ text: '"Арсений Кеттер", "Серый маяк"]}' }]), narr()],
      { caps: fullCaps() },
    );
    const s = recallSession(r, { mode: 'sync', minEntries: 2 });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    const reqs = recallReqs(r.provider.requests);
    expect(reqs.map((q) => q.callKey)).toEqual([`${turn.turnId}:recall:0`, `${turn.turnId}:recall:more:0`]);
    expect(reqs.map((q) => q.prefill)).toEqual([RECALL_OPENING, RECALL_OPENING]);
    expect(reqs.map(wireTail)).toEqual([
      { role: 'assistant', content: RECALL_OPENING },
      { role: 'assistant', content: RECALL_OPENING },
    ]);
    const rec = msgOf(r.home, s.id, turn.messageId)!.recall as Record<string, unknown>;
    expect(rec).toMatchObject({ status: 'recalled', calls: 2 });
    expect((rec.picks as { ref: string }[]).map((p) => p.ref)).toEqual([keyOf(s, 'Арсений Кеттер'), keyOf(s, 'Серый маяк')]);
    await r.engine.close();
  });

  test('the structured transport gets no prefill; the answer is read alone', async () => {
    const caps = fullCaps({ structuredOutput: { mode: 'json_schema', confirmedBy: 'user' } });
    const r = await recallRig([picks(['Арсений Кеттер']), narr()], { caps });
    const s = recallSession(r, { mode: 'sync' });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    const [req] = recallReqs(r.provider.requests);
    expect(req!.prefill).toBeUndefined();
    expect(req!.responseSchema).toBeDefined();
    expect(wireTail(req!)).toMatchObject({ role: 'user' });
    const rec = msgOf(r.home, s.id, turn.messageId)!.recall as Record<string, unknown>;
    expect(rec).toMatchObject({ status: 'recalled', transport: 'structured', picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    await r.engine.close();
  });

  test('caps that take no prefill get none; the answer is read alone', async () => {
    const r = await recallRig([picks(['Серый маяк']), narr()], { caps: fullCaps({ prefill: 'none' }) });
    const s = recallSession(r, { mode: 'sync' });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    const [req] = recallReqs(r.provider.requests);
    expect(req!.prefill).toBeUndefined();
    expect(wireTail(req!)).toMatchObject({ role: 'user' });
    const rec = msgOf(r.home, s.id, turn.messageId)!.recall as Record<string, unknown>;
    expect(rec).toMatchObject({ status: 'recalled', transport: 'tagged', picks: [{ ref: keyOf(s, 'Серый маяк') }] });
    await r.engine.close();
  });
});

describe('the top-up minimum is held to the entries shown (core#8)', () => {
  test('min_entries above the index: an answer that picks every entry shown asks for no top-up', async () => {
    const r = await recallRig([picks(['Мира', 'Серый маяк', 'Арсений Кеттер']), narr()], { caps: fullCaps() });
    const s = recallSession(r, { mode: 'sync', minEntries: 8 });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    // Three typed entries are shown (the plain «Гавань» is no candidate): one recall call, no top-up.
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator']);
    const rec = msgOf(r.home, s.id, turn.messageId)!.recall as Record<string, unknown>;
    expect(rec).toMatchObject({ status: 'recalled', calls: 1 });
    expect((rec.picks as unknown[]).length).toBe(3);
    await r.engine.close();
  });
});
