// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The {{recap}} slot through the engine (D-178): a session whose chat the budget trims and whose
// historian rows summarised the start shows the slot in /preview (src 'recap') and sends it in the
// turn, whose trace.recap is the slot; the Compendium off sends none; a past answer's preview rebuilds
// its slot from its predecessor's trace.recap (pinned while the boundary holds), never the head's.
import { describe, expect, test } from 'bun:test';
import { recapArcText, recapSummaryText, type RecapTrace } from '../../src/agents/compendium/recap.ts';
import type { EntryInput, MemEntry, MsgEntry, Trace } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, LEVI, MIRA, ok, rig, srcTexts, writeRaw } from '../engine-m5a/kit.ts';

const TS = '2026-10-28T12:00:00.000Z';
const LINE = 'the lamp flickers over the grey harbour while we walk along the old pier together';
const EXCHANGES = 15;

/** A trace as a turn writes it, with this recap. */
function traceOf(recap: RecapTrace): Trace {
  return {
    seed: 5,
    now: TS,
    window: 1600,
    reserve: 800,
    tokens: { estimated: 0, counter: 'o200k' },
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

const EMPTY: RecapTrace = { ids: [], arcs: [], boundary: null };

/**
 * The chat after the greeting `g`: EXCHANGES exchanges u1 a1 … (answers by the model, each with a trace
 * whose recap `recapOf` gives), and two historian rows: «The fog» over u1…a3, «The door» over u4…a6,
 * both of the plot «The Lantern», the first with its arc.
 */
function rows(g: string, recapOf: (k: number) => RecapTrace = () => EMPTY): EntryInput[] {
  const out: EntryInput[] = [];
  let parent = g;
  for (let k = 1; k <= EXCHANGES; k++) {
    const u: EntryInput = { t: 'msg', ts: TS, id: `u${k}`, parent, role: 'user', blocks: [{ k: 'text', text: `I say ${k}: ${LINE}.` }] };
    const a: EntryInput = {
      t: 'msg',
      ts: TS,
      id: `a${k}`,
      parent: `u${k}`,
      role: 'assistant',
      blocks: [{ k: 'text', text: `She says ${k}: ${LINE}.` }],
      gen: { kind: 'model', connection: 'script', model: 'm' },
      trace: traceOf(recapOf(k)),
    };
    out.push(u, a);
    parent = `a${k}`;
  }
  const hist = (from: string, to: string, ops: MemEntry['ops']): EntryInput => ({ t: 'mem', ts: TS, key: `hist:${from}-${to}`, on: to, by: 'historian', range: [from, to], ops });
  out.push(
    hist('u1', 'a3', [
      { op: 'file', type: 'summary', data: { title: 'The fog', parent_plot: 'The Lantern', summary: 'Fog fell on the harbour.' } },
      { op: 'arc', plot: 'The Lantern', overview: 'The lamp of the harbour went out.' },
    ]),
    hist('u4', 'a6', [{ op: 'file', type: 'summary', data: { title: 'The door', parent_plot: 'The Lantern', summary: 'A door opened under the pier.' } }]),
  );
  return out;
}

/** A closed session over that journal (a 1 600-token window), reopened. */
async function seeded(script = calls(), recapOf?: (k: number) => RecapTrace) {
  const r = await rig(script);
  const s0 = r.engine.createSession({ character: MIRA, persona: LEVI, config: { window: 1600 } });
  const g = s0.view().path[0]!.id;
  const id = s0.id;
  await s0.close();
  writeRaw(r.home, id, (log) => {
    for (const row of rows(g, recapOf)) log.append(row);
  });
  return { ...r, s: r.engine.session(id), id };
}

const FOG = recapSummaryText('The fog', 'Fog fell on the harbour.');
const DOOR = recapSummaryText('The door', 'A door opened under the pier.');
const ARC = recapArcText('The Lantern', 'The lamp of the harbour went out.');

describe('the slot through the engine', () => {
  test('the preview shows it (src recap), and the turn sends it: its trace.recap is the slot', async () => {
    const r = await seeded(calls([{ text: 'She smiles.' }]));
    const p = ok(r.s.preview());
    expect(p.kind).toBe('swipe');
    expect(p.trace.trimmed).not.toBeNull();
    expect(srcTexts(p.messages, 'recap')).toEqual([[ARC, FOG, DOOR].join('\n\n')]);
    expect(p.trace.recap).toMatchObject({ ids: ['summary:a3.0', 'summary:a6.0'], arcs: [{ key: 'arc:the lantern' }] });
    // Right before the first message sent after the cut.
    const at = p.messages.findIndex((m) => m.src === 'recap');
    expect(p.messages[at + 1]!.src).toBe('history');

    const turn = r.s.runTurn({ kind: 'swipe', expectedVersion: r.s.version() });
    await drain(turn);
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(out.type);
    const sent = r.provider.requests[0]!.messages;
    expect(srcTexts(sent, 'recap')).toEqual([[ARC, FOG, DOOR].join('\n\n')]);
    const row = entriesOf(r.home, r.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
    expect(row.trace!.recap).toEqual(p.trace.recap);
    await r.engine.close();
  });

  test('the Compendium off: no slot, trace.recap empty', async () => {
    const r = await seeded();
    r.s.configure({ compendium: { enabled: false } });
    const p = ok(r.s.preview());
    expect(p.messages.some((m) => m.src === 'recap')).toBe(false);
    expect(p.trace.recap).toEqual(EMPTY);
    await r.engine.close();
  });

  test("a past answer's preview pins the slot its predecessor's trace.recap names, not the head's", async () => {
    // The boundary that request has (the first message after its cut), from a session with no pins.
    const plain = await seeded();
    const fresh = ok(plain.s.preview({ turn: `a${EXCHANGES}` })).trace.recap;
    await plain.engine.close();
    expect(fresh.ids).toEqual(['summary:a3.0', 'summary:a6.0']);
    const boundary = fresh.boundary;
    // The predecessor pinned «The door» alone; the head (the past answer itself) «The fog» alone.
    const pinned = await seeded(calls(), (k) =>
      k === EXCHANGES - 1 ? { ids: ['summary:a6.0'], arcs: [], boundary } : k === EXCHANGES ? { ids: ['summary:a3.0'], arcs: [], boundary } : EMPTY,
    );
    const p = ok(pinned.s.preview({ turn: `a${EXCHANGES}` }));
    expect(p.trace.recap).toEqual({ ids: ['summary:a6.0'], arcs: [], boundary, profile: 'lite', share: 160 });
    expect(srcTexts(p.messages, 'recap')).toEqual([DOOR]);
    // The swipe of the head answer is the same request.
    expect(ok(pinned.s.preview()).trace.recap).toEqual(p.trace.recap);
    await pinned.engine.close();
  });
});
