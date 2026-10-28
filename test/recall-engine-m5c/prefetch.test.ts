// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c prefetch through the engine (.notes/m5c-decisions.md D-201…D-204, ruling G): on a local recall
// origin `auto` prefetches in the lane (`prerecall:<head>`, never journaled) and the turn adopts the
// record with no recall call of its own; a prefetch still in flight is promoted and waited for at most
// graceSec — in time it is adopted, late it is superseded and the turn falls back per onMiss (lexical:
// a `prefetch_missed` record and notice); a Stop ends the wait and the prefetch serves the next reply to
// the same U; a manual lane never prefetches. Fake timers where the grace wait matters.
import { describe, expect, test } from 'bun:test';
import { journalOf, pathUsage } from '../../src/cli/repl-journal.ts';
import type { Event } from '../../src/protocol/events.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';
import { agentsOf, dirCall, entriesOf, fullCaps, keyOf, line, msgOf, narr, noticeCodes, pausedPicks, picks, recallEvents, recallRig, recallSession, turnOf, until } from './kit.ts';

/** The lane's recall events on the bus (no turn id). */
const laneRecall = (seen: readonly Event[]): Record<string, unknown>[] => recallEvents(seen).filter((e) => e.turnId === undefined);

describe('auto on a local origin: the lane prefetches, the turn adopts', () => {
  test('a stored prefetch is adopted: no recall call in the turn, source prefetch, the basis is the answered message', async () => {
    const r = await recallRig([picks(['Арсений Кеттер'], [{ usage: { inputTotal: 200, outputTotal: 8 } }]), narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    const greeting = s.view().path[0]!.id;
    await until(() => laneRecall(r.events.seen).some((e) => e.status === 'done'));
    expect(r.provider.requests.map((q) => [q.agent, q.callKey])).toEqual([['recall', `p_${greeting}:recall:0`]]);
    // Nothing of it is journaled.
    expect(entriesOf(r.home, s.id).filter((e) => e.t === 'job' || e.t === 'mem')).toEqual([]);

    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(agentsOf(r.provider.requests).slice(0, 2)).toEqual(['recall', 'narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toMatchObject({ status: 'recalled', source: 'prefetch', basis: greeting, calls: 1, picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    expect(msg.trace?.calls.map((c) => c.agent)).toEqual(['narrator']);
    expect(msg.trace?.agents.recall).toEqual({ status: 'done', transport: 'tagged' });
    expect(msg.trace?.compendium?.source).toBe('prefetch');
    expect(msg.trace?.compendium?.picks).toContainEqual(expect.objectContaining({ key: keyOf(s, 'Арсений Кеттер'), via: 'model' }));
    expect(recallEvents(evs)).toEqual([{ type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'adopted', source: 'prefetch', count: 1 }]);
    // /usage counts the adopted prefetch from its record.
    const file = readSessionFile(r.home, s.id);
    const usage = pathUsage(journalOf(file.header, file.entries), s.view().path.map((m) => m.id), {});
    expect(usage.agents?.recall).toMatchObject({ calls: 1, inputTokens: 200, outputTokens: 8 });
    // The committed answer is the next basis: the lane prefetches for it.
    await until(() => laneRecall(r.events.seen).filter((e) => e.status === 'done').length === 2);
    expect(r.provider.requests[2]!.callKey).toBe(`p_${turn.messageId}:recall:0`);
    expect(laneRecall(r.events.seen).map((e) => e.status)).toEqual(['queued', 'started', 'done', 'queued', 'started', 'done']);
    await r.engine.close();
  });

  test('an edit after the prefetch changes its basis: the lane prefetches again, the turn adopts the new record', async () => {
    const r = await recallRig([picks(['Мира']), picks(['Арсений Кеттер']), narr(), picks(['Мира'])], { local: true, lane: 'auto' });
    const s = recallSession(r, { mode: 'auto' }, { text: null, compendium: { idleDelaySec: 0 } });
    const greeting = s.view().path[0]!.id;
    await until(() => laneRecall(r.events.seen).filter((e) => e.status === 'done').length === 1);
    s.edit({ messageId: greeting, text: 'Фонарь качается.', expectedVersion: s.version() });
    await until(() => laneRecall(r.events.seen).filter((e) => e.status === 'done').length === 2);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const { turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests).slice(0, 3)).toEqual(['recall', 'recall', 'narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ source: 'prefetch', basis: greeting, picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    await r.engine.close();
  });

  test('a manual lane never prefetches: auto on a local origin behaves as onMiss (lexical), no record, no notice', async () => {
    const r = await recallRig([narr()], { local: true, lane: 'manual' });
    const s = recallSession(r, { mode: 'auto' }, { compendium: { idleDelaySec: 0 } });
    const { evs, turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests)).toEqual(['narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toBeUndefined();
    expect(msg.trace?.compendium?.source).toBe('lexical');
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    await r.engine.close();
  });

  test('a manual lane with mode prefetch and onMiss sync: recall runs in the turn (no prefetch was ever owed)', async () => {
    const r = await recallRig([picks(['Мира']), narr()], { local: true, lane: 'manual' });
    const s = recallSession(r, { mode: 'prefetch', onMiss: 'sync' });
    const { evs, turn } = await turnOf(s);
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator']);
    expect(msgOf(r.home, s.id, turn.messageId)!.recall).toMatchObject({ source: 'sync', status: 'recalled' });
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    await r.engine.close();
  });
});

describe('the grace wait (fake timers)', () => {
  /** A local engine whose prefetch is paused at the greeting ('p'), U sent, the turn started. */
  async function waiting(grace = 4) {
    const timers = fakeTimers();
    const r = await recallRig([pausedPicks('p', ['Арсений Кеттер']), narr(), picks(['Мира']), narr(), picks(['Мира'])], { local: true, lane: 'auto', timers });
    const s = recallSession(r, { mode: 'auto', graceSec: grace }, { text: null, compendium: { idleDelaySec: 0 } });
    const greeting = s.view().path[0]!.id;
    await until(() => r.provider.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs: Event[] = [];
    const drained = (async () => {
      for await (const ev of turn.events) evs.push(ev);
    })();
    for (let i = 0; i < 5; i++) await settle();
    return { r, s, timers, turn, evs, drained, greeting };
  }

  test('in flight and ready within graceSec: promoted, adopted; the narrator asks after it', async () => {
    const { r, s, timers, turn, evs, drained, greeting } = await waiting();
    expect(agentsOf(r.provider.requests)).toEqual(['recall']);
    timers.advance(1000);
    r.provider.release('p');
    await drained;
    expect((await turn.result).type).toBe('done');
    expect(agentsOf(r.provider.requests).slice(0, 2)).toEqual(['recall', 'narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toMatchObject({ status: 'recalled', source: 'prefetch', basis: greeting, calls: 1 });
    expect(msg.trace?.calls.map((c) => c.agent)).toEqual(['narrator']);
    expect(recallEvents(evs)).toEqual([{ type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'adopted', source: 'prefetch', count: 1 }]);
    expect(noticeCodes(evs)).not.toContain('prefetch_missed');
    await r.engine.close();
  });

  test('late (graceSec passed): superseded, a miss — lexical on a local origin, prefetch_missed record and notice', async () => {
    const { r, s, timers, turn, evs, drained, greeting } = await waiting(2);
    timers.advance(1999);
    for (let i = 0; i < 3; i++) await settle();
    expect(agentsOf(r.provider.requests)).toEqual(['recall']);
    timers.advance(1);
    await drained;
    expect((await turn.result).type).toBe('done');
    expect(agentsOf(r.provider.requests).slice(0, 2)).toEqual(['recall', 'narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toMatchObject({ status: 'skipped', source: 'lexical', code: 'prefetch_missed', basis: greeting, calls: 0, picks: [] });
    expect(msg.trace?.agents.recall).toEqual({ status: 'skipped', code: 'prefetch_missed' });
    expect(msg.trace?.compendium?.source).toBe('lexical');
    expect(msg.trace?.compendium?.picks.some((p) => p.via === 'model')).toBe(false);
    expect(noticeCodes(evs)).toContain('prefetch_missed');
    expect(recallEvents(evs)).toEqual([{ type: 'agent', agent: 'recall', turnId: turn.turnId, status: 'fallback', source: 'lexical', code: 'prefetch_missed' }]);
    // The late prefetch was superseded (told on the bus).
    expect(laneRecall(r.events.seen)).toContainEqual({ type: 'agent', agent: 'recall', status: 'skipped', reason: 'superseded' });
    await r.engine.close();
  });

  test('a remote origin: the Director plans during the wait; late → onMiss auto = sync, recall runs in the turn', async () => {
    const timers = fakeTimers();
    const r = await recallRig([pausedPicks('p', ['Мира']), line('director', dirCall()), picks(['Арсений Кеттер']), narr(), picks(['Мира'])], {
      lane: 'auto',
      timers,
      caps: fullCaps({ maxInFlight: 2 }),
    });
    const s = recallSession(r, { mode: 'prefetch' }, { text: null, config: { director: { enabled: true } } });
    await until(() => r.provider.requests.length === 1);
    s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs: Event[] = [];
    const drained = (async () => {
      for await (const ev of turn.events) evs.push(ev);
    })();
    // The Director is asked while the turn waits for the prefetch.
    await until(() => r.provider.requests.length === 2);
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'director']);
    timers.advance(4000);
    await drained;
    expect((await turn.result).type).toBe('done');
    expect(agentsOf(r.provider.requests).slice(0, 4)).toEqual(['recall', 'director', 'recall', 'narrator']);
    const msg = msgOf(r.home, s.id, turn.messageId)!;
    expect(msg.recall).toMatchObject({ source: 'sync', status: 'recalled', picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    expect(msg.trace?.calls.map((c) => c.agent)).toEqual(['director', 'recall', 'narrator']);
    expect(noticeCodes(evs)).toContain('prefetch_missed');
    await r.engine.close();
  });

  test('a Stop ends the wait: the turn stops empty, the prefetch runs on and serves the next reply to the same U', async () => {
    const { r, s, turn, drained, greeting } = await waiting();
    s.stop(turn.turnId);
    await drained;
    expect(await turn.result).toEqual({ type: 'stopped', message: null });
    expect(entriesOf(r.home, s.id).filter((e) => e.t === 'prep')).toEqual([]);
    r.provider.release('p');
    await until(() => laneRecall(r.events.seen).some((e) => e.status === 'done'));
    const again = await turnOf(s);
    expect(again.out.type).toBe('done');
    // One recall call in all: the prefetch's.
    expect(agentsOf(r.provider.requests).slice(0, 2)).toEqual(['recall', 'narrator']);
    expect(msgOf(r.home, s.id, again.turn.messageId)!.recall).toMatchObject({ source: 'prefetch', basis: greeting, status: 'recalled' });
    await r.engine.close();
  });
});
