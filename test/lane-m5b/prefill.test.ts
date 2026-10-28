// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-208 in the lane (.notes/m5c-decisions.md section J): the filing call and the historian's, to a
// recorder on the tagged transport whose caps take a prefill, send `{"filings": [` as the trailing
// assistant message, and the answer is read as the opening followed by the model's text (a
// continuation of several items, the historian's arcs after the list); a recorder on the structured
// transport, or one whose caps take no prefill, gets none and its whole answer is read alone.
import { describe, expect, test } from 'bun:test';
import { FILING_OPENING } from '../../src/agents/compendium/filing.ts';
import { HISTORIAN_OPENING } from '../../src/agents/compendium/historian.ts';
import type { SessionHandle } from '../../src/engine/api.ts';
import { buildChatRequest } from '../../src/providers/openai-chat.ts';
import { scriptCapsWith } from '../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest } from '../../src/providers/types.ts';
import { answer, calls, char, chronicle, filed, laneRig, laneSession, memRows, say } from './kit.ts';

/** The last message of the request as the openai-chat wire would send it (pure: nothing is contacted). */
function wireTail(req: ModelRequest): unknown {
  const http = buildChatRequest(req, { connectionId: 'rec', baseUrl: 'http://model.invalid/v1', local: false }, null);
  const body = JSON.parse(http.body!) as { messages: unknown[] };
  return body.messages.at(-1);
}

/** Two character items after the opening: alone, only the first object would be read. */
const FILING_TAIL = '{"type": "character", "entry": {"name": "Фрол"}}, {"type": "character", "entry": {"name": "Ульяна"}}]}';

/** A summary item, the list closed, then the arcs: alone, the arc would never be read. */
const HISTORIAN_TAIL =
  '{"type": "summary", "entry": {"title": "Фонарь зажжён", "parent_plot": "Свет маяка", "summary": "Фрол зажёг фонарь, и свет ушёл в море."}}], ' +
  '"arcs": [{"plot": "Свет маяка", "overview": "Маяк снова светит."}]}';

const STRUCTURED: ModelCaps = scriptCapsWith({ structuredOutput: { mode: 'json_schema', confirmedBy: 'user' } });
const NO_PREFILL: ModelCaps = scriptCapsWith({ prefill: 'none' });

/** The names of the session's live characters. */
const characters = (s: SessionHandle): string[] =>
  [...s.compendium().entries.values()].filter((e) => e.type === 'character').map((e) => e.name).sort();

describe('the JSON prefill of filing and the historian (D-208)', () => {
  test('filing, tagged, caps that take a prefill: the opening is the trailing assistant message; opening + text is read', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол кивнул.')), recorder: calls([{ text: FILING_TAIL }]) });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    const req = r.recorder.requests[0]!;
    expect(req.agent).toBe('filing');
    expect(req.prefill).toBe(FILING_OPENING);
    expect(wireTail(req)).toEqual({ role: 'assistant', content: '{"filings": [' });
    expect(memRows(r.home, s.id)).toHaveLength(1);
    expect(characters(s)).toEqual(['Ульяна', 'Фрол']);
    await r.engine.close();
  });

  test('the historian, tagged, caps that take a prefill: the opening is sent; the summary and the arc after the list are read', async () => {
    const r = await laneRig({ narrator: calls(answer('Фрол зажёг фонарь.'), answer('Свет ушёл в море.')), recorder: calls([{ text: HISTORIAN_TAIL }]) });
    const s = laneSession(r.engine, { filing: { enabled: false }, historian: { interval: 2 } });
    await say(s, 'Зажги фонарь.');
    await say(s, 'Что дальше?');
    s.send({ text: 'Смотрю.', expectedVersion: s.version() });
    await s.memoryWait();
    const req = r.recorder.requests[0]!;
    expect(req.agent).toBe('historian');
    expect(req.prefill).toBe(HISTORIAN_OPENING);
    expect(wireTail(req)).toEqual({ role: 'assistant', content: '{"filings": [' });
    const row = memRows(r.home, s.id)[0]!;
    expect(row).toMatchObject({ by: 'historian', gen: { transport: 'tagged' } });
    expect(row.ops.map((o) => o.op)).toEqual(['file', 'file', 'arc']);
    const c = s.compendium();
    expect([...c.entries.values()].find((e) => e.type === 'summary')?.data).toMatchObject({ title: 'Фонарь зажжён', parent_plot: 'Свет маяка' });
    expect(c.entries.get('arc:свет маяка')?.content).toBe('Маяк снова светит.');
    await r.engine.close();
  });

  for (const [what, caps, transport] of [
    ['the structured transport', STRUCTURED, 'structured'],
    ['caps that take no prefill', NO_PREFILL, 'tagged'],
  ] as const) {
    test(`${what}: no prefill for filing or the historian; the whole answer is read alone`, async () => {
      const r = await laneRig({
        narrator: calls(answer('Фрол кивнул.'), answer('Фрол зажёг фонарь.')),
        recorder: calls(
          filed(char('Фрол')),
          filed(),
          chronicle([{ title: 'Фонарь зажжён', plot: 'Свет маяка', summary: 'Фрол зажёг фонарь.' }], [{ plot: 'Свет маяка', overview: 'Маяк снова светит.' }]),
        ),
        recorderCaps: caps,
      });
      const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 2 } });
      await say(s, 'Кто ты?');
      await s.memoryWait();
      await say(s, 'Зажги фонарь.');
      s.send({ text: 'Смотрю.', expectedVersion: s.version() });
      await s.memoryWait();
      const reqs = r.recorder.requests;
      expect(reqs.map((q) => q.agent)).toEqual(['filing', 'filing', 'historian']);
      for (const q of reqs) {
        expect(q.prefill).toBeUndefined();
        expect(wireTail(q)).toMatchObject({ role: 'user' });
      }
      expect(characters(s)).toEqual(['Фрол']);
      expect(s.compendium().entries.get('arc:свет маяка')?.content).toBe('Маяк снова светит.');
      expect(memRows(r.home, s.id).map((m) => m.gen?.transport)).toEqual(memRows(r.home, s.id).map(() => transport));
      await r.engine.close();
    });
  }
});
