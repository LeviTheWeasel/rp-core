// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c through the engine (.notes/m5c-decisions.md D-201, D-203, D-204): a sync recall runs beside the
// Director (both asked before either answers on two places; the Director first on one); its picks
// reach the block as tier 1 ('model') in recall's order; the RecallRecord rides prep and the commit
// (checkRecallRecord reads both back unchanged); trace.calls holds the Director's, recall's and the
// narrator's calls in that order, trace.agents.recall and trace.compendium.source say what happened;
// a remote origin's `auto` is sync; lexical and off make no call; a request that cannot fit makes none
// either (D-195); /usage counts recall; recall_slow is told once after three slow sync recalls.
import { describe, expect, test } from 'bun:test';
import { checkRecallRecord } from '../../src/agents/compendium/recall.ts';
import { journalOf, pathUsage } from '../../src/cli/repl-journal.ts';
import type { Character } from '../../src/formats/native.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { fakeClock } from '../helpers.ts';
import type { Event } from '../../src/protocol/events.ts';
import {
  agentsOf,
  fullCaps,
  keyOf,
  line,
  MIRA,
  msgOf,
  narr,
  noticeCodes,
  picks,
  prepOf,
  recallEvents,
  recallRig,
  recallSession,
  tagged,
  planOf,
  turnOf,
  until,
  userText,
} from './kit.ts';

describe('sync recall beside the Director (D-203)', () => {
  test('two places: both are asked before either answers; picks reach the block as tier 1; prep, commit and trace', async () => {
    const r = await recallRig(
      [line('director', [{ pause: 'd' }, { text: tagged(planOf()) }]), line('recall', [{ pause: 'r' }, { text: JSON.stringify({ entry_ids: ['Арсений Кеттер'], reasons: { 'Арсений Кеттер': 'her teacher' } }) }]), narr()],
      { caps: fullCaps({ maxInFlight: 2 }) },
    );
    const s = recallSession(r, { mode: 'sync' }, { config: { director: { enabled: true } } });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await until(() => r.provider.requests.length === 2);
    expect(agentsOf(r.provider.requests).sort()).toEqual(['director', 'recall']);
    r.provider.release('r');
    r.provider.release('d');
    const evs: Event[] = [];
    for await (const ev of turn.events) evs.push(ev);
    const out = await turn.result;
    expect(out.type).toBe('done');
    expect(agentsOf(r.provider.requests).slice(2)).toEqual(['narrator']);
    const recallReq = r.provider.requests.find((q) => q.agent === 'recall')!;
    expect(recallReq.callKey).toBe(`${turn.turnId}:recall:0`);
    // The full profile (a 32k window): Bunraku's system prompt, the index lists the typed entries.
    expect(recallReq.messages[0]!.blocks[0]).toMatchObject({ k: 'text' });
    expect(userText(recallReq)).toContain('Арсений Кеттер');
    expect(userText(recallReq)).toContain('## Recent Conversation');

    const ketter = keyOf(s, 'Арсений Кеттер');
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    const rec = msg.recall as Record<string, unknown>;
    // The guard reads both back unchanged (checked first: a matcher below must not touch the record).
    expect(checkRecallRecord(rec)).toEqual(rec as never);
    expect(structuredClone(rec)).toMatchObject({ v: 1, status: 'recalled', source: 'sync', profile: 'full', picks: [{ ref: ketter, reason: 'her teacher' }], byName: 1, calls: 1, model: 'script:default', transport: 'tagged' });
    const prep = prepOf(r.home, s.id, turn.turnId)!;
    expect(prep.recall).toEqual(msg.recall);
    expect(checkRecallRecord(prep.recall)).toEqual(prep.recall as never);

    const trace = msg.trace!;
    expect(trace.calls.map((c) => [c.agent, c.callKey])).toEqual([
      ['director', `${turn.turnId}:director:0`],
      ['recall', `${turn.turnId}:recall:0`],
      ['narrator', `${turn.turnId}:narrator:0`],
    ]);
    expect(trace.agents).toEqual({ director: { status: 'done', transport: 'tagged' }, recall: { status: 'done', transport: 'tagged' } });
    expect(trace.compendium?.source).toBe('sync');
    expect(trace.compendium?.picks).toContainEqual({ ref: expect.stringMatching(/^C\d+$/), key: ketter, via: 'model' });
    // The narrator's block holds the pick.
    const narrator = r.provider.requests.at(-1)!;
    const block = narrator.messages.find((m) => m.src === 'compendium:block')!;
    expect(block.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('')).toContain('[Lore: Арсений Кеттер]');
    expect(recallEvents(evs)).toEqual([
      { type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'started', source: 'sync' },
      { type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'recalled', source: 'sync', count: 1 },
    ]);
    await r.engine.close();
  });

  test('one place on one origin: the Director is served first, recall after its call', async () => {
    const r = await recallRig([line('director', [{ pause: 'd' }, { text: tagged(planOf()) }]), picks(['Арсений Кеттер']), narr()], { caps: fullCaps() });
    const s = recallSession(r, { mode: 'sync' }, { config: { director: { enabled: true } } });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await until(() => r.provider.requests.length === 1);
    await new Promise((res) => setTimeout(res, 20));
    expect(agentsOf(r.provider.requests)).toEqual(['director']);
    r.provider.release('d');
    expect((await turn.result).type).toBe('done');
    expect(agentsOf(r.provider.requests)).toEqual(['director', 'recall', 'narrator']);
    await r.engine.close();
  });

  test("a remote origin's auto is sync: one recall call in the turn (lite on an 8k window)", async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), narr()]);
    const s = recallSession(r, { mode: 'auto' });
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toMatchObject({ status: 'recalled', source: 'sync', profile: 'lite', picks: [{ ref: keyOf(s, 'Арсений Кеттер') }], calls: 1 });
    expect(msg.trace?.compendium?.picks).toContainEqual(expect.objectContaining({ key: keyOf(s, 'Арсений Кеттер'), via: 'model' }));
    await r.engine.close();
  });

  test('tier 1 keeps recall order; a pick already named in U stays tier 0', async () => {
    const r = await recallRig([picks(['Серый маяк', 'Арсений Кеттер', 'Мира']), narr()]);
    const s = recallSession(r, { mode: 'sync' }, { text: 'Мира молчит.' });
    const { turn } = await turnOf(s);
    const got = msgOf(r.home, s.id, turn.messageId)!.trace!.compendium!.picks.map((p) => [p.key, p.via]);
    expect(got).toEqual([
      [keyOf(s, 'Мира'), 'mention'],
      [keyOf(s, 'Серый маяк'), 'model'],
      [keyOf(s, 'Арсений Кеттер'), 'model'],
    ]);
    await r.engine.close();
  });
});

describe('modes without a call', () => {
  test('lexical: no recall call, no record, source lexical; off: source off', async () => {
    for (const mode of ['lexical', 'off'] as const) {
      const r = await recallRig([narr()]);
      const s = recallSession(r, { mode }, { text: 'Мира молчит.' });
      const { out, turn } = await turnOf(s);
      expect(out.type).toBe('done');
      expect(agentsOf(r.provider.requests)).toEqual(['narrator']);
      const msg = msgOf(r.home, s.id, turn.messageId)!;
      expect(msg.recall).toBeUndefined();
      expect(msg.trace?.agents).toEqual({});
      expect(msg.trace?.compendium?.source).toBe(mode);
      expect(msg.trace?.compendium?.picks.map((p) => p.via)).toEqual(['mention']);
      expect(prepOf(r.home, s.id, turn.turnId)?.recall).toBeUndefined();
      await r.engine.close();
    }
  });

  test('the test default (RP_CORE_RECALL=lexical) applies when the config sets no mode; a config mode wins', async () => {
    const { Engine } = await import('../../src/engine/engine.ts');
    const r = await recallRig([picks(['Арсений Кеттер']), narr(), narr()]);
    const engine = await Engine.open({ home: r.home, connections: { script: r.conn }, clock: fakeClock(), timeZone: 'UTC', lane: 'manual' });
    await r.engine.close();
    const s = recallSession({ engine, home: r.home }, {});
    await turnOf(s);
    expect(agentsOf(r.provider.requests)).toEqual(['narrator']);
    s.configure({ compendium: { recall: { mode: 'sync' } } });
    s.send({ text: 'Дальше.', expectedVersion: s.version() });
    await turnOf(s);
    expect(agentsOf(r.provider.requests)).toEqual(['narrator', 'recall', 'narrator']);
    await engine.close();
  });

  test('the Compendium off, or no live typed entry: no record, no trace row (the M5a request)', async () => {
    const r = await recallRig([narr()]);
    const s = r.engine.createSession({ character: MIRA, config: { compendium: { enabled: true, recall: { mode: 'sync' }, filing: { enabled: false }, historian: { interval: 0 } } } });
    s.send({ text: 'Привет.', expectedVersion: s.version() });
    const { turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests)).toEqual(['narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toBeUndefined();
    expect(msg.trace?.agents).toEqual({});
    expect(msg.trace?.compendium).toBeUndefined();
    await r.engine.close();
  });

  test('a request that cannot fit is refused before recall (D-195): no recall call at all', async () => {
    const wordy: Character = { ...MIRA, description: '{{char}} counts every dream she has ever mapped on an abacus for a traveller. '.repeat(900) };
    const r = await recallRig([picks(['Арсений Кеттер']), narr()], { caps: fullCaps({ contextLength: 16_384 }) });
    const s = recallSession(r, { mode: 'sync' }, { character: wordy });
    const { out, evs } = await turnOf(s);
    expect(out).toMatchObject({ type: 'failed', category: 'request', code: 'context_length_exceeded' });
    expect(r.provider.requests).toHaveLength(0);
    expect(recallEvents(evs)).toEqual([]);
    await r.engine.close();
  });
});

describe('failures and the records without a call', () => {
  test('an unreadable lite answer fails (ruling G): the selector stands in, fallback event', async () => {
    const r = await recallRig([line('recall', [{ text: 'I would rather not say.' }]), narr()]);
    const s = recallSession(r, { mode: 'sync' });
    const { evs, turn } = await turnOf(s);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    // Ruling J (words): text with no selection in it is undecodable; no_output is an empty answer only.
    expect(msg.recall).toMatchObject({ status: 'failed', source: 'lexical', code: 'undecodable', calls: 1, picks: [] });
    expect(msg.trace?.agents.recall).toEqual({ status: 'failed', code: 'undecodable', transport: 'tagged' });
    expect(msg.trace?.compendium?.source).toBe('lexical');
    expect(recallEvents(evs).at(-1)).toEqual({ type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'fallback', source: 'lexical', code: 'undecodable' });
    await r.engine.close();
  });

  test('no connection for recall: a skipped record, no call, never a refusal', async () => {
    const r = await recallRig([narr()]);
    const s = recallSession(r, { mode: 'sync' }, { config: { roles: { recall: { conn: 'gone', model: 'x' } } } });
    const { out, evs, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(agentsOf(r.provider.requests)).toEqual(['narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ status: 'skipped', source: 'lexical', code: 'no_connection', model: 'gone:x', calls: 0 });
    expect(recallEvents(evs)).toEqual([{ type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'skipped', code: 'no_connection' }]);
    await r.engine.close();
  });
});

describe('/usage and recall_slow (D-204)', () => {
  test("/usage counts a sync recall's calls under recall", async () => {
    const r = await recallRig([picks(['Арсений Кеттер'], [{ usage: { inputTotal: 300, outputTotal: 12 } }]), narr()]);
    const s = recallSession(r, { mode: 'sync' });
    await turnOf(s);
    const file = readSessionFile(r.home, s.id);
    const j = journalOf(file.header, file.entries);
    const usage = pathUsage(j, s.view().path.map((m) => m.id), {});
    expect(usage.agents?.recall).toMatchObject({ calls: 1, inputTokens: 300, outputTokens: 12 });
    await r.engine.close();
  });

  test('three sync recalls slower than 8 s: recall_slow once', async () => {
    const r = await recallRig([picks(['Мира']), narr(), picks(['Мира']), narr(), picks(['Мира']), narr(), picks(['Мира']), narr()], { clock: fakeClock(undefined, 5000) });
    const s = recallSession(r, { mode: 'sync' });
    const told: string[][] = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) s.send({ text: `Дальше ${i}.`, expectedVersion: s.version() });
      told.push(noticeCodes((await turnOf(s)).evs).filter((c) => c === 'recall_slow'));
    }
    expect(told).toEqual([[], [], ['recall_slow'], []]);
    await r.engine.close();
  });
});

describe('--keep-requests', () => {
  test("recall's request is kept under its call key", async () => {
    const { readdirSync } = await import('node:fs');
    const { requestsDir } = await import('../../src/engine/turn.ts');
    const r = await recallRig([picks(['Мира']), narr()], { keepRequests: true });
    const s = recallSession(r, { mode: 'sync' });
    const { turn } = await turnOf(s);
    const files = readdirSync(requestsDir(r.home, s.id)).sort();
    expect(files).toEqual([`${turn.turnId}_narrator_0.json`, `${turn.turnId}_recall_0.json`].sort());
    await r.engine.close();
  });
});
