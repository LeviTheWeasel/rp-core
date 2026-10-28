// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c D-205 through the engine: a turn whose request leaves the history crowded tells
// notice{history_crowded} once per open session (the turn asks the session, as for every request
// notice), a preview shows it every time without marking it told, and the request sent is the one
// the preview shows (a notice, not a change).
import { describe, expect, test } from 'bun:test';
import type { SessionHandle } from '../../src/engine/api.ts';
import { HISTORY_CROWDED } from '../../src/engine/request.ts';
import type { Event } from '../../src/protocol/events.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { calls, drain, LEVI, MIRA, rig } from '../engine/kit.ts';

const WINDOW = 2048;
/** About 250 tokens of prose: four of these and the preset no longer fit what a 2 048 window leaves. */
const long = (who: string, n: number): string => `${who} ${n}: ${'The tide turns over the black stones and the lamp keeps time. '.repeat(18)}`;

const crowdedOf = (evs: readonly Event[]): Extract<Event, { type: 'notice' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice' && e.code === HISTORY_CROWDED);

/** One reply turn after a user message: its notices of the crowded kind. */
async function turn(s: SessionHandle, n: number): Promise<Extract<Event, { type: 'notice' }>[]> {
  const v = s.send({ text: long('Levi', n), expectedVersion: s.version() }).version;
  const t = s.runTurn({ kind: 'reply', expectedVersion: v });
  const evs = await drain(t);
  const out = await t.result;
  if (out.type !== 'done') throw new Error(`turn ${n}: ${JSON.stringify(out)}`);
  return crowdedOf(evs);
}

describe('history_crowded in turns and previews', () => {
  test('told once per open session at the first crowded turn; a preview shows it every time; a reopen tells again', async () => {
    const answers = Array.from({ length: 6 }, (_, i) => [{ text: long('Mira', i + 1) }]);
    const { engine, provider } = await rig(calls(...answers), { caps: { ...SCRIPT_CAPS, contextLength: WINDOW } });
    const s = engine.createSession({ character: MIRA, persona: LEVI });

    // Turns 1 and 2 send the whole history (the greeting, then one exchange more).
    expect(await turn(s, 1)).toEqual([]);
    expect(await turn(s, 2)).toEqual([]);
    // Turn 3: four earlier messages and the greeting no longer fit; the cut leaves the greeting alone.
    const told = await turn(s, 3);
    expect(told).toHaveLength(1);
    expect(told[0]!.level).toBe('warn');
    expect(told[0]!.message).toStartWith('Only 1 of the 5 earlier messages fits in the request:');
    expect(told[0]!.message).toContain(`(window ${WINDOW} - reply reserve 1024)`);
    expect(told[0]!.message).toContain('/preset builtin');
    expect(told[0]!.message).toMatch(/takes about \d+ of the 1024 tokens a request may use/);
    // Still crowded, never told again in this open session.
    expect(await turn(s, 4)).toEqual([]);

    // A preview shows it (every time) and leaves it untold: the request of the next turn, exactly.
    s.send({ text: long('Levi', 5), expectedVersion: s.version() });
    const p1 = s.preview();
    const p2 = s.preview();
    if (!p1.ok || !p2.ok) throw new Error('preview failed');
    expect(p1.notices.filter((n) => n.code === HISTORY_CROWDED)).toHaveLength(1);
    expect(p2.notices.filter((n) => n.code === HISTORY_CROWDED)).toHaveLength(1);
    const t5 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const ev5 = await drain(t5);
    expect((await t5.result).type).toBe('done');
    expect(crowdedOf(ev5)).toEqual([]);
    expect(JSON.stringify(provider.requests.at(-1)!.messages)).toBe(JSON.stringify(p1.messages));

    // A new open of the session is a new session handle: its first crowded turn tells again.
    await s.close();
    const again = engine.session(s.id);
    expect(await turn(again, 6)).toHaveLength(1);
    await engine.close();
  });

  test('a roomy window never tells it', async () => {
    const answers = Array.from({ length: 4 }, (_, i) => [{ text: long('Mira', i + 1) }]);
    const { engine } = await rig(calls(...answers), { caps: { ...SCRIPT_CAPS, contextLength: 32_768 } });
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    for (let n = 1; n <= 4; n++) expect(await turn(s, n)).toEqual([]);
    const p = s.preview({ draft: 'One more.' });
    if (!p.ok) throw new Error('preview failed');
    expect(p.notices.map((x) => x.code)).not.toContain(HISTORY_CROWDED);
    await engine.close();
  });
});
