// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c (.notes/m5c-decisions.md D-197, D-200, D-203): a swipe or a continue reuses the answered message's
// record with no call (source 'reused', reusedFrom), a failed record is not reused, a guided re-roll
// recalls again; a crash-recovered answer takes its record from `prep`; /preview --turn rebuilds the
// block's tier 1 from the record; the index leaves out the predicted {{recap}} slot and the entries
// freshness hides.
import { describe, expect, test } from 'bun:test';
import { checkRecallRecord } from '../../src/agents/compendium/recall.ts';
import type { EntryInput, RecallRecord, Trace, TurnKind } from '../../src/session/entries.ts';
import type { SessionLog } from '../../src/session/log.ts';
import { agentsOf, editsOf, entriesOf, keyOf, line, msgOf, narr, picks, recallEvents, recallRig, recallSession, turnOf, userText, writeRaw } from './kit.ts';

describe('reuse on a swipe and a continue (D-203)', () => {
  test('a swipe reuses the replaced answer\'s record with no call; a continue reuses its target\'s', async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), narr('Первый.'), narr('Второй.'), narr(' И ещё.')]);
    const s = recallSession(r, { mode: 'sync' });
    const first = await turnOf(s);
    const a1 = first.turn.messageId;
    const ketter = keyOf(s, 'Арсений Кеттер');

    const swipe = await turnOf(s, 'swipe');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator', 'narrator']);
    const a2 = swipe.turn.messageId;
    const rec = msgOf(r.home, s.id, a2)!.recall as RecallRecord;
    expect(rec).toMatchObject({ status: 'recalled', source: 'reused', reusedFrom: a1, calls: 0, picks: [{ ref: ketter }] });
    expect(rec.ms).toBeUndefined();
    expect(checkRecallRecord(rec)).toEqual(rec);
    const trace = msgOf(r.home, s.id, a2)!.trace!;
    expect(trace.agents.recall).toEqual({ status: 'reused', transport: 'tagged' });
    expect(trace.calls.map((c) => c.agent)).toEqual(['narrator']);
    expect(trace.compendium?.source).toBe('reused');
    expect(trace.compendium?.picks).toContainEqual(expect.objectContaining({ key: ketter, via: 'model' }));
    expect(recallEvents(swipe.evs)).toEqual([{ type: 'agent', agent: 'recall', turnId: swipe.turn.turnId, status: 'reused', source: 'reused', count: 1 }]);

    const cont = await turnOf(s, 'continue');
    expect(cont.out.type).toBe('done');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator', 'narrator', 'narrator']);
    const edit = editsOf(r.home, s.id, a2).at(-1)!;
    expect(edit.recall).toMatchObject({ source: 'reused', reusedFrom: a2, calls: 0, picks: [{ ref: ketter }] });
    expect(edit.trace?.compendium?.source).toBe('reused');
    await r.engine.close();
  });

  test('a failed record is not reused: the swipe recalls again', async () => {
    const r = await recallRig([line('recall', [{ text: 'No idea.' }]), narr('Первый.'), picks(['Мира']), narr('Второй.')]);
    const s = recallSession(r, { mode: 'sync' });
    const first = await turnOf(s);
    expect(msgOf(r.home, s.id, first.turn.messageId)!.recall).toMatchObject({ status: 'failed' });
    const swipe = await turnOf(s, 'swipe');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator', 'recall', 'narrator']);
    expect(msgOf(r.home, s.id, swipe.turn.messageId)!.recall).toMatchObject({ status: 'recalled', source: 'sync' });
    await r.engine.close();
  });

  test('a guided re-roll recalls again; onSwipe rerun too', async () => {
    const r = await recallRig([picks(['Мира']), narr('Первый.'), picks(['Арсений Кеттер']), narr('Второй.'), picks(['Серый маяк']), narr('Третий.')]);
    const s = recallSession(r, { mode: 'sync' });
    await turnOf(s);
    const guided = await turnOf(s, 'swipe', { guidance: 'Пусть придёт учитель.' });
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator', 'recall', 'narrator']);
    expect(msgOf(r.home, s.id, guided.turn.messageId)!.recall).toMatchObject({ source: 'sync', picks: [{ ref: keyOf(s, 'Арсений Кеттер') }] });
    s.configure({ compendium: { recall: { mode: 'sync', onSwipe: 'rerun' } } });
    const rerun = await turnOf(s, 'swipe');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator', 'recall', 'narrator', 'recall', 'narrator']);
    expect(msgOf(r.home, s.id, rerun.turn.messageId)!.recall).toMatchObject({ source: 'sync', picks: [{ ref: keyOf(s, 'Серый маяк') }] });
    await r.engine.close();
  });

  test('/preview --turn rebuilds tier 1 from the answer\'s record, never calling recall', async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), narr()]);
    const s = recallSession(r, { mode: 'sync' });
    const { turn } = await turnOf(s);
    const p = s.preview({ turn: turn.messageId });
    if (!p.ok) throw new Error(p.message);
    expect(p.trace.compendium?.source).toBe('sync');
    expect(p.trace.compendium?.picks).toContainEqual(expect.objectContaining({ key: keyOf(s, 'Арсений Кеттер'), via: 'model' }));
    expect(p.notices.map((n) => n.code)).not.toContain('preview_inputs_changed');
    expect(agentsOf(r.provider.requests)).toEqual(['recall', 'narrator']);
    await r.engine.close();
  });
});

const TS = '2026-10-28T12:00:00.000Z';

/** A trace as a turn writes it (only what the readers here look at matters). */
function traceOf(recap: Trace['recap']): Trace {
  return {
    seed: 5,
    now: TS,
    window: 8192,
    reserve: 2048,
    tokens: { estimated: 0 },
    blocks: [],
    lore: { fired: [], cut: [], budget: 0 },
    recap,
    prefill: null,
    macros: { unknown: [] },
    trimmed: null,
    calls: [],
    agents: {},
    presetHash: 'p',
    loreHashes: {},
  };
}

describe('recovery and the index', () => {
  test("a crash after `prep`: the recovered answer carries prep's record; a malformed one is left out", async () => {
    const r = await recallRig([picks(['Арсений Кеттер']), narr()]);
    const s = recallSession(r, { mode: 'sync' });
    const { turn } = await turnOf(s);
    const good = msgOf(r.home, s.id, turn.messageId)!.recall as RecallRecord;
    for (const [recall, want] of [
      [good, good],
      [{ v: 1, status: 'nonsense' }, undefined],
    ] as const) {
      const s2 = recallSession(r, { mode: 'sync' });
      const u = s2.view().path.at(-1)!.id;
      const version = s2.version();
      const id = s2.id;
      await s2.close();
      writeRaw(r.home, id, (log: SessionLog) => {
        const kind: TurnKind = 'reply';
        log.append({ t: 'turn', ts: TS, turn: 't_x', kind, parent: u, msgId: 'm_rec', seed: 1, now: TS, base: version });
        log.append({ t: 'prep', turn: 't_x', trace: traceOf({ ids: [], arcs: [], boundary: null }), recall });
        log.append({ t: 'chk', turn: 't_x', text: 'Мира поднимает фонарь.' }, { durable: false });
      });
      const s3 = r.engine.session(id);
      expect(s3.openEvents().filter((e) => e.type === 'recovered')).toEqual([expect.objectContaining({ outcome: 'interrupted' })]);
      expect(msgOf(r.home, id, 'm_rec')!.recall).toEqual(want);
      await s3.close();
    }
    await r.engine.close();
  });

  test('the index leaves out the predicted {{recap}} slot (the previous answer\'s trace.recap.ids) and entries freshness hides', async () => {
    const r = await recallRig([picks(['Мира']), narr()]);
    const s0 = recallSession(r, { mode: 'sync' }, { text: null });
    const g = s0.view().path[0]!.id;
    const lighthouse = keyOf(s0, 'Серый маяк');
    const id = s0.id;
    await s0.close();
    const rows: EntryInput[] = [
      { t: 'msg', ts: TS, id: 'u1', parent: g, role: 'user', blocks: [{ k: 'text', text: 'Где мы?' }] },
      {
        t: 'msg',
        ts: TS,
        id: 'a1',
        parent: 'u1',
        role: 'assistant',
        blocks: [{ k: 'text', text: 'У пристани.' }],
        gen: { kind: 'model', connection: 'script', model: 'default' },
        // The slot the previous request held (pre-M5b boundary: chosen afresh by the narrator's request).
        trace: traceOf({ ids: [lighthouse], arcs: [], boundary: null }),
      },
      // A summary over u1…a1: hidden while a1 is in front of the model (D-152).
      {
        t: 'mem',
        ts: TS,
        key: 'hist:u1-a1',
        on: 'a1',
        by: 'historian',
        range: ['u1', 'a1'],
        ops: [{ op: 'file', type: 'summary', data: { title: 'Туман у пристани', parent_plot: 'Фонарь', summary: 'Туман упал на гавань.' } }],
      },
      { t: 'msg', ts: TS, id: 'u2', parent: 'a1', role: 'user', blocks: [{ k: 'text', text: 'Что дальше?' }] },
    ];
    writeRaw(r.home, id, (log) => {
      for (const row of rows) log.append(row);
    });
    const s = r.engine.session(id);
    expect([...s.view().compendium.entries.values()].some((e) => e.name === 'Туман у пристани')).toBe(true);
    const { out } = await turnOf(s);
    expect(out.type).toBe('done');
    const index = userText(r.provider.requests[0]!);
    expect(index).toContain('Мира');
    expect(index).toContain('Арсений Кеттер');
    expect(index).not.toContain('Серый маяк');
    expect(index).not.toContain('Туман у пристани');
    expect(entriesOf(r.home, id).some((e) => e.t === 'msg' && e.recall !== undefined)).toBe(true);
    await r.engine.close();
  });
});
