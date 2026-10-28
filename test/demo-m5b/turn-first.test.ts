// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What the deterministic demo leans on (an integration fix found by it, see .notes/m5b-contract-demo.md):
// in auto mode the lane starts nothing while a turn of its session runs. A message accepts the answer
// before it, and before the fix `submit` (send, then the turn) began that answer's filing at the send:
// on a one-place origin the call took the place first and the narrator preempted it a moment later —
// a wasted call, a scripted line eaten, a local server's cache refilled with the filing prompt. Now the
// lane looks once the turn is registered and starts the filing when the turn settles. After the review
// (the lead's ruling I) a `send` on its own does not start the lane at once either: the fresh message
// holds it back for max(idleDelaySec, 2 s), the time a client takes to call runTurn after it.
import { describe, expect, test } from 'bun:test';
import type { Event } from '../../src/protocol/events.ts';
import type { JobEntry } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig } from '../engine/kit.ts';
import { collect, tick } from '../engine-m5a/kit.ts';
import { fakeTimers } from '../infra/fake-timers.ts';

const A1 = 'Мира кивнула. — Фрол ждёт у причала.';
const A2 = 'Фрол долго молчит, потом берётся за вёсла.';
const F1 = JSON.stringify({ filings: [{ type: 'character', entry: { name: 'Фрол', description: 'Старый лодочник.' } }] });

const laneEvents = (seen: readonly Event[]): string[] => seen.flatMap((e) => (e.type === 'agent' && e.agent === 'filing' ? [`${e.agent} ${e.status}`] : []));

describe('auto lane: a turn comes first', () => {
  test('one scripted connection for both (as the CLI demo): the second message’s narrator call is not preempted by the filing of A1', async () => {
    // One script for every role, one place (SCRIPT_CAPS), the calls taken in order: A1, A2, then F1.
    const r = await rig(calls([{ text: A1 }], [{ text: A2 }], [{ text: F1 }]), { extra: { lane: 'auto' } });
    const events = collect(r.engine);
    const s = r.engine.createSession({ character: MIRA, persona: LEVI, config: { compendium: { enabled: true, idleDelaySec: 0, historian: { interval: 0 } } } });
    for (const text of ['Кто ждёт у причала?', 'А что Фрол?']) {
      const t = s.submit({ text, expectedVersion: s.version() });
      await drain(t);
      expect((await t.result).type).toBe('done');
    }
    expect(await s.memoryWait()).toMatchObject({ idle: true, queued: [] });
    await tick();
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['narrator', 'narrator', 'filing']);
    const path = s.view().path;
    expect(path.at(-1)!.blocks).toEqual([{ k: 'text', text: A2 }]);
    // One begin, then the row: the pass was never preempted.
    const jobs = entriesOf(r.home, s.id).filter((e): e is JobEntry => e.t === 'job');
    expect(jobs.map((j) => [j.key, j.state, j.attempt])).toEqual([[`file:${path[2]!.id}`, 'begin', 1]]);
    expect(laneEvents(events.seen)).toEqual(['filing queued', 'filing started', 'filing done']);
    await s.close();
    await r.engine.close();
  });

  test('a send on its own: the lane starts once the message is 2 s old (idleDelaySec 0), not at the send (ruling I)', async () => {
    const timers = fakeTimers();
    const clock = (): Date => new Date('2026-10-28T10:00:00.000Z');
    const r = await rig(calls([{ text: A1 }], [{ pause: 'f1' }, { text: F1 }]), { extra: { lane: 'auto', timers, clock } });
    const s = r.engine.createSession({ character: MIRA, persona: LEVI, config: { compendium: { enabled: true, idleDelaySec: 0, historian: { interval: 0 } } } });
    const t = s.submit({ text: 'Кто ждёт у причала?', expectedVersion: s.version() });
    await drain(t);
    await t.result;
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['narrator']);
    // The player adds a line and asks for no answer yet: A1 is accepted; a runTurn may follow the send.
    s.send({ text: 'А что Фрол?', expectedVersion: s.version() });
    expect(s.memoryStatus()).toMatchObject({ queued: [{ task: 'file', on: s.view().path[2]!.id }] });
    expect(s.memoryStatus().running).toBeUndefined();
    timers.advance(1_999);
    expect(s.memoryStatus().running).toBeUndefined();
    timers.advance(1);
    expect(s.memoryStatus().running).toMatchObject({ task: 'file', on: s.view().path[2]!.id });
    r.provider.release('f1');
    expect(await s.memoryWait()).toMatchObject({ idle: true });
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['narrator', 'filing']);
    await s.close();
    await r.engine.close();
  });
});
