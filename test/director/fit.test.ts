// Ported from Bunraku:src/core/director/state.test.ts (fitState) and src/core/director/bounds.test.ts
// @702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/director/state.ts fitState: the D-61 limits, then the §7.3 size steps against the 32 KB
// UTF-8 cap (A.6). Bunraku's activity-line cases are REWRITTEN (no activity in the core: identity,
// no-mutation and best effort kept); prune's cases are ported with keep = 10 (D-61, was 20) through
// fitState's structural limit; the 300-turn run is ported with a test-local planner standing in for
// the reducer (reduce.ts is another unit; the integrate demo runs the real one) and Cyrillic texts.
// D-116 (steps 6 texts and 7 last-directive): every script ends within the cap; the cases that pinned
// `fit:over-cap` for Cyrillic now assert the cap, and states at every limit in Russian, Chinese and
// emoji, plus generated states, are fitted and read back by checkState.
import { describe, expect, test } from 'bun:test';
import {
  checkState,
  FIT_OVER_CAP,
  FIT_STEPS,
  fitState,
  isFinishedArc,
  LAST_RESORT_TEXT,
  stateBytes,
  type FitStep,
} from '../../src/agents/director/state.ts';
import {
  READ_LIMITS,
  STATE_LIMITS,
  type DirectorArc,
  type DirectorSeed,
  type DirectorState,
  type NarratorDirective,
} from '../../src/agents/director/types.ts';
import { arcOf, chapterOf, hiddenOf, proseOf, ru, seedOf, stateOf, zh } from './fixtures-state.ts';

const whys = (r: { skipped: { why: string }[] }): string[] => r.skipped.map((x) => x.why);
const fits = (r: { skipped: { why: string }[] }): string[] => whys(r).filter((w) => w.startsWith('fit:'));
const ids = (list: { id: string }[]): string[] => list.map((x) => x.id);
const frozen = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
};
const utf8Bytes = (t: string): number => Buffer.byteLength(t, 'utf8');
const cps = (t: string): number => Array.from(t).length;
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The state after the steps up to `last`, run one at a time (each with a cap just under the size the
 * previous one left, so exactly the next step that changes something runs).
 */
function through(s: DirectorState, last: FitStep): { state: DirectorState; ran: string[] } {
  let cur = fitState(s, Number.MAX_SAFE_INTEGER).state; // the limits only
  const ran: string[] = [];
  for (;;) {
    const r = fitState(cur, stateBytes(cur) - 1);
    const step = fits(r)[0];
    if (step === undefined || step === FIT_OVER_CAP.why) return { state: cur, ran };
    cur = r.state;
    ran.push(step);
    if (step === `fit:${last}`) return { state: cur, ran };
  }
}

/**
 * A rich Cyrillic state at every D-61 limit: 24 live + 10 finished arcs, 32 + 10 seeds, 12 + 10 hidden
 * arcs, 11 chapters, full stage / clue / reinforcement lists, 5 intentions. Sized so that every §7.3
 * step is needed and step 5 lands it under 32 KB.
 */
function bigState(): DirectorState {
  let n = 1;
  const arcs: DirectorArc[] = [];
  const seeds: DirectorSeed[] = [];
  for (let i = 0; i < 34; i++)
    arcs.push(
      arcOf({
        id: `arc-${n++}`,
        title: ru(50, i),
        description: ru(300, i * 7),
        status: i < 10 ? 'complete' : 'building',
        createdAtTurn: i,
        lastProgressTurn: i,
        stages: Array.from({ length: 6 }, (_, k) => ({ title: ru(40, k), turn: i })),
        nextBeat: { description: ru(100, i), plannedAtTurn: i, status: 'pending' },
      }),
    );
  for (let i = 0; i < 42; i++)
    seeds.push(seedOf({ id: `seed-${n++}`, hint: ru(60, i * 3), payoff: ru(300, i), plantedAtTurn: i, payoffDelivered: i < 10, reinforcements: [1, 2, 3, 4].map((turn) => ({ turn })) }));
  const invisibleArcs = Array.from({ length: 22 }, (_, i) =>
    hiddenOf({
      id: `hidden-${n++}`,
      title: ru(50, i),
      description: ru(300, i),
      surfaceCondition: ru(60, i + 1),
      status: i < 10 ? 'resolved' : 'building',
      createdAtTurn: i,
      stages: Array.from({ length: 6 }, (_, k) => ({ title: ru(40, k), turn: i })),
      playerClues: Array.from({ length: 6 }, (_, k) => ({ clue: ru(60, k), turn: i })),
    }),
  );
  const chapters = Array.from({ length: 11 }, (_, i) =>
    chapterOf({ id: `chapter-${i + 1}`, number: i + 1, title: ru(40, i), premise: ru(300, i), majorGoal: ru(200, i + 2), status: i === 10 ? 'active' : 'complete', createdAtTurn: i * 10 }),
  );
  return stateOf({
    turn: 300,
    nextId: n,
    arcs,
    seeds,
    invisibleArcs,
    chapters,
    currentChapterId: 'chapter-11',
    lastPlantTurn: 41,
    nextIntentions: Array.from({ length: 5 }, (_, i) => ({ type: 'setup', description: ru(300, i), priority: 'should' as const, targetTurn: 'soon' as const })),
  });
}

describe('fitState', () => {
  test('a state that fits is the same object with nothing skipped; one that does not gives up only as much as it takes, and the input is never changed', () => {
    // Rewritten from "loses its oldest activity lines first": activity is not stored (D-61).
    const s = frozen(stateOf({ arcs: [arcOf()], seeds: [seedOf()] }));
    const same = fitState(s);
    expect(same.state).toBe(s);
    expect(same.skipped).toEqual([]);

    const paid = Array.from({ length: 10 }, (_, i) => seedOf({ id: `seed-${i + 1}`, hint: `S${i}`, payoff: ru(300, i), payoffDelivered: true, payoffTurn: i }));
    const t = frozen(stateOf({ seeds: paid, arcs: [arcOf({ id: 'arc-20' })] }));
    const before = JSON.stringify(t);
    const max = stateBytes(t) - 700;
    const fit = fitState(t, max);
    expect(stateBytes(fit.state)).toBeLessThanOrEqual(max);
    expect(fits(fit)).toEqual(['fit:completed-5']); // the first step was enough
    expect(ids(fit.state.seeds)).toEqual(ids(paid.slice(5)));
    expect(fit.state.arcs).toBe(t.arcs);
    expect(JSON.stringify(t)).toBe(before);
  });

  test('the story is never trimmed past what a person wrote: an over-cap state comes back best effort, marked fit:over-cap', () => {
    // Rewritten from "with no activity left it gives back what it has" and "fitState never touches
    // what a person wrote": notes, byUser and userAuthored items stay whole however large.
    const notes = Array.from({ length: 16 }, (_, i) => ({ id: `note-${i}`, content: ru(1_500, i), createdAtTurn: i }));
    const mine = hiddenOf({ id: 'hidden-1', description: ru(1_000), userAuthored: true, status: 'resolved' });
    const myArc = arcOf({ id: 'arc-2', description: ru(1_000), byUser: true, status: 'complete' });
    const mySeeds = Array.from({ length: 20 }, (_, i) => seedOf({ id: `seed-${i + 3}`, hint: `S${i}`, payoff: ru(1_000, i), byUser: true }));
    const s = frozen(stateOf({ notes, invisibleArcs: [mine], arcs: [myArc], seeds: mySeeds }));
    const fit = fitState(s);
    expect(fit.state).toBe(s); // nothing could be given up
    expect(fit.skipped).toEqual([FIT_OVER_CAP]);
    expect(fitState(s, 10).state.notes).toEqual(notes);
    expect(stateBytes(fit.state)).toBeGreaterThan(STATE_LIMITS.hardBytes);
  });

  test('never throws on an empty state or a tiny cap', () => {
    const fit = fitState(stateOf(), 10);
    expect(fit.skipped).toEqual([FIT_OVER_CAP]);
    expect(fitState(stateOf()).skipped).toEqual([]);
  });
});

describe('limits (D-61)', () => {
  test('keeps the newest 10 paid-off seeds, finished arcs and finished hidden arcs the model made, oldest first to go, and never a planted hidden arc', () => {
    // Ported from prune: keep 20 → 10 (D-61), so the 20 oldest of 30 go.
    const seeds = Array.from({ length: 30 }, (_, i) => seedOf({ id: `s${i}`, hint: `S${i}`, payoffDelivered: true, payoffTurn: i }));
    const arcs = Array.from({ length: 30 }, (_, i) => arcOf({ id: `a${i}`, title: `A${i}`, status: i % 2 ? 'complete' : 'abandoned', lastProgressTurn: i }));
    const hidden = [
      ...Array.from({ length: 30 }, (_, i) => hiddenOf({ id: `h${i}`, title: `H${i}`, status: i % 3 ? 'resolved' : 'visible', createdAtTurn: i })),
      hiddenOf({ id: 'mine', title: 'Mine', status: 'resolved', userAuthored: true, createdAtTurn: -5 }),
    ];
    const out = fitState(stateOf({ seeds, arcs, invisibleArcs: hidden }));
    expect(ids(out.state.seeds)).toEqual(ids(seeds.slice(20)));
    expect(ids(out.state.arcs)).toEqual(ids(arcs.slice(20)));
    expect(ids(out.state.invisibleArcs)).toEqual([...ids(hidden.slice(20, 30)), 'mine']);
    expect(whys(out)).toEqual(['limit:completed-arcs', 'limit:completed-seeds', 'limit:completed-hidden']);
  });

  test('live seeds and arcs are never pruned, and a state within the keep is the same object', () => {
    const s = stateOf({ seeds: [seedOf()], arcs: [arcOf()] });
    expect(fitState(s).state).toBe(s);
    const live = stateOf({
      arcs: Array.from({ length: 30 }, (_, i) => arcOf({ id: `arc-${i}`, status: 'building' })),
      seeds: Array.from({ length: 40 }, (_, i) => seedOf({ id: `seed-${i}` })),
    });
    expect(fitState(live).state).toBe(live); // live caps are the reducer's (it refuses new ones), not fitState's
  });

  test('the oldest by lastProgressTurn ?? createdAtTurn and payoffTurn ?? plantedAtTurn go first; a person’s finished items stay', () => {
    const arcs = [
      arcOf({ id: 'arc-1', status: 'complete', createdAtTurn: 50 }),
      ...Array.from({ length: 10 }, (_, i) => arcOf({ id: `arc-${i + 2}`, status: 'complete', createdAtTurn: 1, lastProgressTurn: 10 + i })),
      arcOf({ id: 'arc-99', status: 'abandoned', createdAtTurn: 0, byUser: true }),
    ];
    const seeds = [
      seedOf({ id: 'seed-1', payoffDelivered: true, plantedAtTurn: 60 }),
      ...Array.from({ length: 10 }, (_, i) => seedOf({ id: `seed-${i + 2}`, payoffDelivered: true, plantedAtTurn: 1, payoffTurn: 20 + i })),
    ];
    const out = fitState(stateOf({ arcs, seeds })).state;
    expect(ids(out.arcs)).toEqual(['arc-1', ...ids(arcs.slice(2, 11)), 'arc-99']);
    expect(ids(out.seeds)).toEqual(['seed-1', ...ids(seeds.slice(2))]);
  });

  test('chapters: the current one plus the 10 newest others', () => {
    const chapters = Array.from({ length: 14 }, (_, i) =>
      chapterOf({ id: `chapter-${i + 1}`, number: i + 1, status: i === 0 ? 'active' : 'complete', createdAtTurn: i * 10 }),
    );
    // The current chapter is the oldest here (a reader must never lose it).
    const out = fitState(stateOf({ chapters, currentChapterId: 'chapter-1' }));
    expect(ids(out.state.chapters)).toEqual(['chapter-1', ...ids(chapters.slice(4))]);
    expect(whys(out)).toEqual(['limit:chapters']);
    const none = fitState(stateOf({ chapters }));
    expect(ids(none.state.chapters)).toEqual(ids(chapters.slice(4)));
  });

  test('per item: the newest 6 stages, 4 reinforcements and 6 clues; the first 5 intentions and 12 themes', () => {
    const stages = Array.from({ length: 9 }, (_, i) => ({ title: `этап ${i}`, turn: i }));
    const s = stateOf({
      arcs: [arcOf({ stages, byUser: true })],
      invisibleArcs: [hiddenOf({ stages, playerClues: stages.map((x) => ({ turn: x.turn, clue: x.title })) })],
      seeds: [seedOf({ reinforcements: stages.map((x) => ({ turn: x.turn })) })],
      nextIntentions: Array.from({ length: 8 }, (_, i) => ({ type: `t${i}`, description: 'd', priority: 'could' as const, targetTurn: 'eventually' as const })),
      chapters: [chapterOf({ themes: Array.from({ length: 15 }, (_, i) => `тема ${i}`) })],
      currentChapterId: 'chapter-1',
    });
    const out = fitState(s);
    expect(out.state.arcs[0]!.stages).toEqual(stages.slice(3)); // a person's arc too: the model writes its stages
    expect(out.state.invisibleArcs[0]!.stages).toEqual(stages.slice(3));
    expect(out.state.invisibleArcs[0]!.playerClues.map((c) => c.turn)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(out.state.seeds[0]!.reinforcements.map((r) => r.turn)).toEqual([5, 6, 7, 8]);
    expect(out.state.nextIntentions.map((i) => i.type)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    // Themes have no D-61 limit; they are held to the plan's list limit (12, D-107) — an addition.
    expect(out.state.chapters[0]!.themes).toEqual(Array.from({ length: 12 }, (_, i) => `тема ${i}`));
    expect(whys(out)).toEqual(['limit:stages', 'limit:reinforcements', 'limit:clues', 'limit:intentions', 'limit:themes']);
  });

  test('text: every field to 300 code points at a word boundary, arc and hidden-arc titles to 80; a person’s texts whole', () => {
    const long = ru(500);
    const s = stateOf({
      arcs: [
        arcOf({ id: 'arc-1', title: ru(120), description: long, stages: [{ title: long, turn: 1 }], nextBeat: { description: long, plannedAtTurn: 1, status: 'pending' } }),
        arcOf({ id: 'arc-2', title: ru(120), description: long, byUser: true }),
      ],
      seeds: [seedOf({ hint: long, payoff: long })],
      invisibleArcs: [hiddenOf({ title: ru(120), description: long, surfaceCondition: long, playerClues: [{ turn: 1, clue: long }] })],
      chapters: [chapterOf({ title: long, premise: long, tone: long, majorGoal: long, closingMoment: long, themes: [long] })],
      currentChapterId: 'chapter-1',
      nextIntentions: [{ type: long, description: long, priority: 'must', targetTurn: 'next' }],
      pacing: { currentMood: long, turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
      lastDirective: { turn: 1, directive: { pacing: 'slow', narrativeGoal: long, arcDirections: [{ arcName: 'Письмо', instruction: long, urgency: 'subtle' }] } },
    });
    const out = fitState(s);
    expect(whys(out)).toEqual(['limit:text']);
    const cps = (t: string): number => Array.from(t).length;
    const a = out.state.arcs[0]!;
    expect(cps(a.title)).toBeLessThanOrEqual(80);
    expect(a.title.endsWith('…')).toBe(true);
    for (const t of [a.description, a.stages[0]!.title, a.nextBeat!.description]) {
      expect(cps(t)).toBeLessThanOrEqual(300);
      expect(t.endsWith('…')).toBe(true);
      expect(long[t.length - 1]).toBe(' '); // cut where a word ended
    }
    expect(out.state.arcs[1]).toBe(s.arcs[1]!); // byUser: untouched
    expect(cps(out.state.invisibleArcs[0]!.title)).toBeLessThanOrEqual(80);
    expect(cps(out.state.invisibleArcs[0]!.surfaceCondition!)).toBeLessThanOrEqual(300);
    expect(cps(out.state.invisibleArcs[0]!.playerClues[0]!.clue)).toBeLessThanOrEqual(300);
    expect(cps(out.state.seeds[0]!.hint)).toBeLessThanOrEqual(300);
    const c = out.state.chapters[0]!;
    for (const t of [c.title, c.premise, c.tone, c.majorGoal, c.closingMoment!, c.themes[0]!]) expect(cps(t)).toBeLessThanOrEqual(300);
    expect(cps(out.state.nextIntentions[0]!.description)).toBeLessThanOrEqual(300);
    expect(cps(out.state.pacing.currentMood)).toBeLessThanOrEqual(300);
    expect(cps(out.state.lastDirective!.directive.narrativeGoal!)).toBeLessThanOrEqual(300);
    expect(cps(out.state.lastDirective!.directive.arcDirections![0]!.instruction)).toBeLessThanOrEqual(300);
    expect(out.state.lastDirective!.directive.arcDirections![0]!.arcName).toBe('Письмо');
    // A cut text is not cut again: a second fit changes nothing.
    const again = fitState(out.state);
    expect(again.state).toBe(out.state);
    expect(again.skipped).toEqual([]);
  });

  test("D-123: a seed's long relatedArcId (an older build's text) is held to the title cap; an id is left alone", () => {
    const long = 'The slow unraveling of the Ashford family secret about the fire at the old mill (arc-1)';
    const s = stateOf({ nextId: 4, seeds: [seedOf({ id: 'seed-1', relatedArcId: long }), seedOf({ id: 'seed-2', hint: 'Key', relatedArcId: 'arc-1' }), seedOf({ id: 'seed-3', hint: 'Coin', relatedArcId: long, byUser: true })] });
    const out = fitState(s);
    expect(whys(out)).toEqual(['limit:text']);
    expect(cps(out.state.seeds[0]!.relatedArcId!)).toBeLessThanOrEqual(STATE_LIMITS.arcTitle);
    expect(out.state.seeds[1]).toBe(s.seeds[1]!);
    expect(out.state.seeds[2]).toBe(s.seeds[2]!); // a person's seed: untouched
    expect(checkState(roundTrip(out.state))).toEqual(roundTrip(out.state));
  });
});

describe('the §7.3 size steps', () => {
  test('a rich Cyrillic state: steps 1–5 fire in order and the result fits 32 KB in UTF-8 bytes (6 and 7 are not needed)', () => {
    const s = frozen(bigState());
    expect(stateBytes(s)).toBeGreaterThan(4 * STATE_LIMITS.hardBytes);
    const out = fitState(s);
    expect(fits(out)).toEqual(FIT_STEPS.slice(0, FIT_STEPS.indexOf('working-sets') + 1).map((x) => `fit:${x}`));
    expect(out.skipped.every((x) => x.path === 'state')).toBe(true);
    const r = out.state;
    expect(stateBytes(r)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    expect(JSON.stringify(r).length).toBeLessThan(stateBytes(r)); // bytes, not chars
    expect(r.arcs.filter(isFinishedArc)).toEqual([]);
    expect(r.seeds.filter((x) => x.payoffDelivered)).toEqual([]);
    expect(r.invisibleArcs.filter((h) => h.status === 'resolved')).toEqual([]);
    expect(r.arcs).toHaveLength(12);
    expect(r.seeds).toHaveLength(16);
    expect(r.invisibleArcs).toHaveLength(6);
    expect(ids(r.chapters)).toEqual(['chapter-9', 'chapter-10', 'chapter-11']);
    expect(Math.max(...r.arcs.map((a) => a.stages.length), ...r.invisibleArcs.map((h) => h.stages.length))).toBe(1);
    expect(Math.max(...r.invisibleArcs.map((h) => h.playerClues.length))).toBe(3);
    expect(Math.max(...r.seeds.map((x) => x.reinforcements.length))).toBe(2);
    expect(Math.max(...r.arcs.map((a) => Array.from(a.description).length))).toBeLessThanOrEqual(160);
    expect(r.nextIntentions).toHaveLength(3);
    expect(r.lastPlantTurn).toBe(41); // stays when the paid seeds go
    expect(checkState(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  test('the cap is in bytes: a Cyrillic state under 32 K chars but over 32 KB is shrunk (Bunraku counted chars)', () => {
    const paid = Array.from({ length: 10 }, (_, i) => seedOf({ id: `seed-${i + 1}`, hint: ru(250, i), payoff: ru(300, i), payoffDelivered: true, payoffTurn: i }));
    const live = Array.from({ length: 24 }, (_, i) => arcOf({ id: `arc-${i + 20}`, title: ru(80, i), description: ru(300, i), stages: [{ title: ru(150, i), turn: 1 }] }));
    const s = stateOf({ seeds: paid, arcs: live });
    expect(JSON.stringify(s).length).toBeLessThan(STATE_LIMITS.hardBytes);
    expect(stateBytes(s)).toBeGreaterThan(STATE_LIMITS.hardBytes);
    const out = fitState(s);
    expect(fits(out)[0]).toBe('fit:completed-5');
    expect(stateBytes(out.state)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
  });

  test('stops at the first step that fits, and a step that changes nothing is not recorded', () => {
    // With a lastDirective, so that step 7 has something to drop.
    const s: DirectorState = { ...bigState(), lastDirective: { turn: 300, directive: { pacing: 'slow', narrativeGoal: ru(300) } } };
    expect(FIT_STEPS).toEqual(['completed-5', 'completed-0', 'lists', 'descriptions', 'chapters', 'working-sets', 'texts', 'last-directive']);
    for (const [i, step] of FIT_STEPS.entries()) {
      // Run up to this step with a cap just under the size it leaves: the next step must fire.
      const upTo = fitState(s, 1).skipped.length; // all steps
      expect(upTo).toBeGreaterThan(FIT_STEPS.length);
      const sized = fitState(s, Number.MAX_SAFE_INTEGER).state; // limits only
      let cur = sized;
      let lastBytes = stateBytes(cur);
      for (const prev of FIT_STEPS.slice(0, i)) {
        const r = fitState(cur, lastBytes - 1);
        expect(fits(r)[0]).toBe(`fit:${prev}`);
        cur = r.state;
        lastBytes = stateBytes(cur);
      }
      const r = fitState(cur, lastBytes - 1);
      expect(fits(r)[0]).toBe(`fit:${step}`);
    }
    // Nothing finished, no long texts, one chapter: completed-*, descriptions and chapters change nothing.
    const plain = stateOf({ arcs: Array.from({ length: 20 }, (_, i) => arcOf({ id: `arc-${i}`, createdAtTurn: i, stages: [1, 2, 3, 4].map((turn) => ({ title: ru(200, turn), turn })) })) });
    expect(fits(fitState(plain, stateBytes(plain) - 1))).toEqual(['fit:lists']);
    expect(fits(fitState(plain, 1))).toEqual(['fit:lists', 'fit:descriptions', 'fit:working-sets', 'fit:texts', 'fit:over-cap']);
  });

  test('completed-0 keeps lastPlantTurn, and fills it from the evicted seeds when it was missing', () => {
    const paid = Array.from({ length: 4 }, (_, i) => seedOf({ id: `seed-${i + 1}`, payoff: ru(300, i), payoffDelivered: true, plantedAtTurn: 30 + i, payoffTurn: 40 + i }));
    const s = stateOf({ seeds: paid, turn: 50 });
    const out = fitState(s, stateBytes(s) - 100);
    expect(fits(out)).toEqual(['fit:completed-0']);
    expect(out.state.seeds).toEqual([]);
    expect(out.state.lastPlantTurn).toBe(33);
    const kept = fitState({ ...s, lastPlantTurn: 45 }, stateBytes(s) - 100);
    expect(kept.state.lastPlantTurn).toBe(45);
  });

  test('working sets: the newest 12 arcs, 16 seeds, 6 hidden arcs by progress / planting / creation, in their order, plus every person’s item', () => {
    const arcs = Array.from({ length: 20 }, (_, i) => arcOf({ id: `arc-${i}`, createdAtTurn: i, lastProgressTurn: i % 2 ? 100 + i : undefined, byUser: i === 0 ? true : undefined }));
    const seeds = Array.from({ length: 20 }, (_, i) => seedOf({ id: `seed-${i}`, plantedAtTurn: 20 - i }));
    const invisibleArcs = Array.from({ length: 10 }, (_, i) => hiddenOf({ id: `hidden-${i}`, createdAtTurn: i, userAuthored: i < 2 ? true : undefined }));
    const s = stateOf({ arcs, seeds, invisibleArcs, notes: [{ id: 'note-1', content: ru(200), createdAtTurn: 1 }] });
    const five = through(s, 'working-sets');
    expect(five.ran.at(-1)).toBe('fit:working-sets');
    const out = five.state;
    // Arcs: the person's arc-0, then the 12 newest by lastProgressTurn ?? createdAtTurn (odd ones progressed).
    expect(ids(out.arcs)).toEqual(['arc-0', ...ids(arcs.filter((_, i) => i % 2 === 1 || i === 16 || i === 18))]);
    expect(ids(out.seeds)).toEqual(ids(seeds.slice(0, 16))); // planted latest = listed first
    expect(ids(out.invisibleArcs)).toEqual(['hidden-0', 'hidden-1', ...ids(invisibleArcs.slice(4))]);
    expect(out.notes).toEqual(s.notes);
    // Step 6 (D-116): 8 / 10 / 4 by the same rule, the person's items still all there.
    const six = fitState(s, 1).state; // every step; over-cap at the end
    expect(ids(six.arcs)).toEqual(['arc-0', ...ids(arcs.filter((_, i) => i % 2 === 1 && i >= 5))]);
    expect(ids(six.seeds)).toEqual(ids(seeds.slice(0, 10)));
    expect(ids(six.invisibleArcs)).toEqual(['hidden-0', 'hidden-1', ...ids(invisibleArcs.slice(6))]);
    expect(six.notes).toEqual(s.notes);
  });
});

/** Text lengths (code points of Russian prose) a stand-in planner writes. */
interface Talk {
  title: number;
  desc: number;
  beat: number;
  stage: number;
  hint: number;
  clue: number;
  surface: number;
  chapter: number;
  intention: number;
  directive: number;
  /** A person's seed / hidden arc every this many turns. */
  person: number;
}
const TERSE: Talk = { title: 20, desc: 100, beat: 50, stage: 20, hint: 30, clue: 40, surface: 40, chapter: 100, intention: 60, directive: 100, person: 100 };
const VERBOSE: Talk = { title: 100, desc: 400, beat: 300, stage: 60, hint: 120, clue: 150, surface: 200, chapter: 300, intention: 300, directive: 300, person: 50 };

/** A stand-in for the reducer (reduce.ts is another unit): what a planner leaves after turn `t`, live caps respected. */
function plan(prev: DirectorState, t: number, w: Talk): DirectorState {
  let nextId = prev.nextId;
  const id = (kind: string): string => `${kind}-${nextId++}`;
  let { chapters, currentChapterId } = prev;
  if (t === 1 || t % 50 === 0) {
    const number = chapters.reduce((m, c) => Math.max(m, c.number), 0) + 1;
    chapters = [
      ...chapters.map((c) => (c.id === currentChapterId ? { ...c, status: 'complete' as const, closingMoment: ru(w.chapter, t) } : c)),
      chapterOf({ id: `chapter-${number}`, number, title: `Глава ${number}`, premise: ru(w.chapter, t), majorGoal: ru(w.chapter, t + 1), themes: [ru(30, t), ru(30, t + 9)], createdAtTurn: t }),
    ];
    currentChapterId = `chapter-${number}`;
  }
  const liveArcs = prev.arcs.filter((a) => !isFinishedArc(a));
  const closing = t % 7 === 0 ? liveArcs.find((a) => a.byUser !== true)?.id : undefined;
  const arcs: DirectorArc[] = prev.arcs.map((a) =>
    isFinishedArc(a)
      ? a
      : {
          ...a,
          description: ru(w.desc, t),
          stages: [...a.stages, { title: `этап ${t}: ${ru(w.stage, t)}`, turn: t }],
          lastProgressTurn: t,
          nextBeat: { description: ru(w.beat, t + 3), plannedAtTurn: t, status: 'pending' },
          ...(a.id === closing ? { status: 'complete' as const } : {}),
        },
  );
  if (liveArcs.length < STATE_LIMITS.liveArcs)
    arcs.push(arcOf({ id: id('arc'), title: `Нить ${t}: ${ru(w.title, t)}`, description: ru(w.desc, t), chapterId: currentChapterId, status: 'seeding', createdAtTurn: t }));
  const pending = prev.seeds.filter((x) => !x.payoffDelivered);
  const paying = t % 9 === 0 ? pending.find((x) => x.byUser !== true)?.id : undefined;
  const seeds: DirectorSeed[] = prev.seeds.map((x) =>
    x.payoffDelivered ? x : { ...x, reinforcements: [...x.reinforcements, { turn: t }], ...(x.id === paying ? { payoffDelivered: true, payoffTurn: t } : {}) },
  );
  let lastPlantTurn = prev.lastPlantTurn;
  if (pending.length < STATE_LIMITS.liveSeeds) {
    seeds.push(seedOf({ id: id('seed'), hint: `Зерно ${t}: ${ru(w.hint, t)}`, payoff: ru(w.desc, t + 1), plantedAtTurn: t }));
    lastPlantTurn = t;
  }
  if (t % w.person === 0) seeds.push(seedOf({ id: id('seed'), hint: `Моё ${t}`, payoff: ru(w.desc, t), plantedAtTurn: t, byUser: true })); // the person
  const liveHidden = prev.invisibleArcs.filter((h) => h.status !== 'resolved' && h.status !== 'visible');
  const surfacing = t % 11 === 0 ? liveHidden.find((h) => h.userAuthored !== true)?.id : undefined;
  const newest = liveHidden.filter((h) => h.userAuthored !== true).at(-1)?.id;
  const invisibleArcs = prev.invisibleArcs.map((h) =>
    h.id === newest
      ? { ...h, stages: [...h.stages, { title: `тень ${t}`, turn: t }], playerClues: [...h.playerClues, { turn: t, clue: ru(w.clue, t) }] }
      : h.id === surfacing
        ? { ...h, status: 'visible' as const }
        : h,
  );
  if (t % 3 === 0 && liveHidden.length < STATE_LIMITS.liveHidden)
    invisibleArcs.push(hiddenOf({ id: id('hidden'), title: `Скрытое ${t}`, description: ru(w.desc, t), surfaceCondition: ru(w.surface, t), createdAtTurn: t }));
  if (t % (w.person + 10) === 0) invisibleArcs.push(hiddenOf({ id: id('hidden'), title: `Моя тень ${t}`, description: ru(w.desc, t), createdAtTurn: t, userAuthored: true }));
  const notes = t % 25 === 0 ? [...prev.notes, { id: `note-${t}`, content: `Заметка ${t}`, createdAtTurn: t }] : prev.notes;
  return {
    ...prev,
    turn: t,
    nextId,
    chapters,
    ...(currentChapterId !== undefined ? { currentChapterId } : {}),
    arcs,
    seeds,
    invisibleArcs,
    notes,
    pacing: { currentMood: 'напряжённый', turnsAtCurrentMood: prev.pacing.turnsAtCurrentMood + 1, rhythm: { lastActionSequence: Math.max(0, t - 3), lastQuietMoment: Math.max(0, t - 9) } },
    nextIntentions: Array.from({ length: 10 }, (_, i) => ({ type: 'reveal', description: ru(w.intention, t + i), priority: 'should' as const, targetTurn: 'soon' as const })),
    lastDirective: {
      turn: t,
      directive: {
        pacing: 'slow',
        mood: 'напряжённый',
        narrativeGoal: ru(w.directive, t),
        endingHook: ru(w.directive, t + 1),
        arcDirections: [0, 1, 2].map((i) => ({ arcName: `Нить ${t - i}`, instruction: ru(w.directive, t + i), urgency: 'moderate' as const })),
      },
    },
    ...(lastPlantTurn !== undefined ? { lastPlantTurn } : {}),
  };
}

/** 300 planned turns, each fitted; what the person made, the steps used and the turns left over the cap. */
function run(w: Talk, each: (s: DirectorState, skipped: { why: string }[]) => void): { s: DirectorState; mine: Record<'seeds' | 'hidden' | 'notes', string[]>; steps: number; over: number } {
  let s = stateOf();
  const mine = { seeds: [] as string[], hidden: [] as string[], notes: [] as string[] };
  let steps = 0;
  let over = 0;
  for (let t = 1; t <= 300; t++) {
    const planned = plan(s, t, w);
    for (const x of planned.seeds) if (x.byUser && !mine.seeds.includes(x.id)) mine.seeds.push(x.id);
    for (const h of planned.invisibleArcs) if (h.userAuthored && !mine.hidden.includes(h.id)) mine.hidden.push(h.id);
    for (const n of planned.notes) if (!mine.notes.includes(n.id)) mine.notes.push(n.id);
    const out = fitState(planned);
    s = out.state;
    steps += fits(out).length;
    if (out.skipped.some((x) => x.why === FIT_OVER_CAP.why)) over++;
    each(s, out.skipped);
  }
  return { s, mine, steps, over };
}

describe('300 turns of a verbose planner and an active person', () => {
  test('every state the run produces is accepted by checkState and fits 32 KB, and every note, seed and hidden arc the person made is still there', () => {
    // Ported with Russian texts at a terse planner's lengths: at the verbose lengths a Russian state
    // does not fit 32 KB after step 5 (next test). Assertions on caps 4 and 10 (D-61, were 12 and 20).
    const { s, mine, steps, over } = run(TERSE, (x, skipped) => {
      expect(skipped).not.toContainEqual(FIT_OVER_CAP);
      expect(stateBytes(x)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
      expect(checkState(JSON.parse(JSON.stringify(x)))).toEqual(x);
    });
    expect(steps).toBeGreaterThan(0); // the run did need the size steps
    expect(over).toBe(0);
    expect(ids(s.seeds.filter((x) => x.byUser))).toEqual(mine.seeds);
    expect(ids(s.invisibleArcs.filter((h) => h.userAuthored))).toEqual(mine.hidden);
    expect(ids(s.notes)).toEqual(mine.notes);
    expect(Math.max(...s.seeds.map((x) => x.reinforcements.length))).toBeLessThanOrEqual(STATE_LIMITS.reinforcements);
    expect(s.seeds.filter((x) => x.payoffDelivered).length).toBeLessThanOrEqual(STATE_LIMITS.completedPerKind);
    expect(s.arcs.filter(isFinishedArc).length).toBeLessThanOrEqual(STATE_LIMITS.completedPerKind);
    expect(s.chapters.length).toBeLessThanOrEqual(1 + STATE_LIMITS.completedChapters);
    expect(s.nextIntentions.length).toBeLessThanOrEqual(STATE_LIMITS.intentions);
    expect(s.lastPlantTurn).toBe(300);
    expect(s.turn).toBe(300);
  });

  test('a verbose Russian planner: every state ends within 32 KB, readable, the person’s items all kept', () => {
    // §7.3 said step 5 always fits; in Cyrillic at these lengths it did not (287 of 300 states over
    // 32 KB, up to 54.7 KB). D-116's steps 6 and 7 hold the cap: changed from "marked fit:over-cap".
    let texts = 0;
    const { s, mine, over } = run(VERBOSE, (x, skipped) => {
      expect(skipped).not.toContainEqual(FIT_OVER_CAP);
      expect(stateBytes(x)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
      expect(checkState(roundTrip(x))).toEqual(x);
      if (skipped.some((k) => k.why === 'fit:texts')) texts++;
    });
    expect(over).toBe(0);
    expect(texts).toBeGreaterThan(0); // the run needed step 6
    expect(ids(s.seeds.filter((x) => x.byUser))).toEqual(mine.seeds);
    expect(ids(s.invisibleArcs.filter((h) => h.userAuthored))).toEqual(mine.hidden);
    expect(ids(s.notes)).toEqual(mine.notes);
    expect(s.turn).toBe(300);
  });

  test('at the D-61 maxima in Cyrillic step 5 leaves ≈ 50 KB; step 6 brings it within 32 KB', () => {
    // Changed (D-116): was pinned as over the cap with fit:over-cap.
    const s = bigState();
    const max = (t: string, n: number): string => (Array.from(t).length >= n ? t : ru(n, t.length));
    const rich: DirectorState = {
      ...s,
      arcs: s.arcs.map((a) => ({ ...a, title: max(a.title, 80), stages: a.stages.map((x) => ({ ...x, title: ru(300, x.turn) })), nextBeat: { ...a.nextBeat!, description: ru(300) } })),
      invisibleArcs: s.invisibleArcs.map((h) => ({ ...h, surfaceCondition: ru(300), playerClues: h.playerClues.map((c) => ({ ...c, clue: ru(300, c.turn) })) })),
      seeds: s.seeds.map((x) => ({ ...x, hint: ru(300, x.plantedAtTurn) })),
    };
    const five = through(rich, 'working-sets');
    expect(stateBytes(five.state)).toBeGreaterThan(STATE_LIMITS.hardBytes);
    const out = fitState(rich);
    // No lastDirective here: step 7 changes nothing and is not recorded.
    expect(fits(out)).toEqual(FIT_STEPS.slice(0, FIT_STEPS.indexOf('texts') + 1).map((x) => `fit:${x}`));
    expect(stateBytes(out.state)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    expect(checkState(roundTrip(out.state))).toEqual(out.state);
  });
});


// ---- D-116: the last-resort steps --------------------------------------------------------------

type Prose = (n: number, from?: number) => string;
const EMOJI: Prose = (n, from = 0) => proseOf('🌊🔥 ', n, from);
const LATIN: Prose = (n, from = 0) => proseOf('The old keeper hides a letter from his sister. ', n, from);

/** A directive at readPlan's limits: 12 items per list, every text at `T` (the self-audit's copy). */
function directiveAt(t: Prose): NarratorDirective {
  const T = STATE_LIMITS.text;
  const n = READ_LIMITS.directiveList;
  const list = (k: number): string[] => Array.from({ length: n }, (_, i) => t(T, i + k));
  return {
    pacing: 'slow',
    mood: t(T),
    narrativeGoal: t(T, 1),
    endingHook: t(T, 2),
    include: { characters: list(1), themes: list(2), sensoryDetails: list(3), foreshadowing: list(4) },
    avoid: { topics: list(5), characters: list(6), revelations: list(7) },
    dialogueGuidance: Array.from({ length: n }, (_, i) => ({ character: t(T, i), tone: t(T, i + 1), hints: list(i) })),
    sceneGuidance: { setting: t(T), atmosphere: t(T, 1), tension_level: 7 },
    arcDirections: Array.from({ length: n }, (_, i) => ({ arcName: t(STATE_LIMITS.arcTitle, i), instruction: t(T, i), urgency: 'forceful' as const })),
    callbacks: Array.from({ length: n }, (_, i) => ({ reference: t(T, i), instruction: t(T, i + 1) })),
    characterBeats: Array.from({ length: n }, (_, i) => ({ character: t(T, i), beat: t(T, i + 1), motivation: t(T, i + 2) })),
  };
}

/**
 * A state at EVERY D-61 limit in the script of `t`: 24 live + 10 finished arcs, 32 + 10 seeds, 12 + 10
 * hidden arcs, the current + 10 chapters with 12 themes, 6 stages / 4 reinforcements / 6 clues per
 * item, 5 intentions, every text at 300 (titles 80), the mood too, and a lastDirective at readPlan's
 * limits.
 */
function atEveryLimit(t: Prose): DirectorState {
  const L = STATE_LIMITS;
  const T = L.text;
  let n = 1;
  const arcs = Array.from({ length: L.liveArcs + L.completedPerKind }, (_, i) =>
    arcOf({
      id: `arc-${n++}`,
      title: t(L.arcTitle, i),
      description: t(T, i),
      status: i < L.completedPerKind ? 'complete' : 'building',
      createdAtTurn: i,
      lastProgressTurn: i,
      stages: Array.from({ length: L.stages }, (_, k) => ({ title: t(T, k + i), turn: i })),
      nextBeat: { description: t(T, i + 1), plannedAtTurn: i, status: 'pending' },
    }),
  );
  const seeds = Array.from({ length: L.liveSeeds + L.completedPerKind }, (_, i) =>
    seedOf({ id: `seed-${n++}`, hint: t(T, i), payoff: t(T, i + 2), plantedAtTurn: i, payoffDelivered: i < L.completedPerKind, reinforcements: [1, 2, 3, 4].map((turn) => ({ turn })) }),
  );
  const invisibleArcs = Array.from({ length: L.liveHidden + L.completedPerKind }, (_, i) =>
    hiddenOf({
      id: `hidden-${n++}`,
      title: t(L.arcTitle, i),
      description: t(T, i),
      surfaceCondition: t(T, i + 1),
      status: i < L.completedPerKind ? 'resolved' : 'building',
      createdAtTurn: i,
      stages: Array.from({ length: L.stages }, (_, k) => ({ title: t(T, k), turn: i })),
      playerClues: Array.from({ length: L.clues }, (_, k) => ({ clue: t(T, k), turn: i })),
    }),
  );
  const chapters = Array.from({ length: L.completedChapters + 1 }, (_, i) =>
    chapterOf({
      id: `chapter-${i + 1}`,
      number: i + 1,
      title: t(T, i),
      premise: t(T, i),
      tone: t(T, i + 3),
      majorGoal: t(T, i + 2),
      closingMoment: t(T, i + 4),
      themes: Array.from({ length: L.themes }, (_, k) => t(T, k)),
      status: i === L.completedChapters ? 'active' : 'complete',
      createdAtTurn: i * 10,
    }),
  );
  return stateOf({
    turn: 300,
    nextId: n,
    arcs,
    seeds,
    invisibleArcs,
    chapters,
    currentChapterId: `chapter-${L.completedChapters + 1}`,
    lastPlantTurn: 41,
    pacing: { currentMood: t(T), turnsAtCurrentMood: 3, rhythm: { lastActionSequence: 1, lastQuietMoment: 2 } },
    nextIntentions: Array.from({ length: L.intentions }, (_, i) => ({ type: t(T, i), description: t(T, i + 1), priority: 'should' as const, targetTurn: 'soon' as const })),
    lastDirective: { turn: 300, directive: directiveAt(t) },
  });
}

/** Every string of a state's model texts (not the titles), with where it sits. */
function modelTexts(s: DirectorState): string[] {
  return [
    ...s.arcs.flatMap((a) => (a.byUser ? [] : [a.description, ...a.stages.map((x) => x.title), ...(a.nextBeat ? [a.nextBeat.description] : [])])),
    ...s.seeds.flatMap((x) => (x.byUser ? [] : [x.hint, x.payoff])),
    ...s.invisibleArcs.flatMap((h) =>
      h.userAuthored ? [] : [h.description, ...h.stages.map((x) => x.title), ...h.playerClues.map((c) => c.clue), ...(h.surfaceCondition !== undefined ? [h.surfaceCondition] : [])],
    ),
    ...s.chapters.flatMap((c) => [c.title, c.premise, c.tone, c.majorGoal, ...c.themes, ...(c.closingMoment !== undefined ? [c.closingMoment] : [])]),
    ...s.nextIntentions.flatMap((i) => [i.type, i.description]),
    s.pacing.currentMood,
  ];
}

describe('D-116: the cap holds in every script (steps 6 texts and 7 last-directive)', () => {
  test.each([
    ['Cyrillic', ru as Prose],
    ['Chinese', zh as Prose],
    ['emoji (4 bytes)', EMOJI],
    ['Latin', LATIN],
  ])('%s at every limit: every step fires in order and the state ends within 32 KB, read back whole by checkState', (_, t) => {
    const s = frozen(atEveryLimit(t));
    expect(stateBytes(s)).toBeGreaterThan(10 * STATE_LIMITS.hardBytes);
    const out = fitState(s);
    expect(fits(out)).toEqual(FIT_STEPS.map((x) => `fit:${x}`)); // all eight, in order; no fit:over-cap
    expect(out.skipped.every((x) => x.path === 'state')).toBe(true);
    const r = out.state;
    expect(stateBytes(r)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    expect(checkState(roundTrip(r))).toEqual(r);
    expect(r.lastDirective).toBeUndefined();
    expect(r.arcs).toHaveLength(8);
    expect(r.seeds).toHaveLength(10);
    expect(r.invisibleArcs).toHaveLength(4);
    expect(ids(r.chapters)).toEqual([r.currentChapterId!]);
    expect(Math.max(...r.invisibleArcs.map((h) => h.playerClues.length))).toBe(1);
    for (const x of modelTexts(r)) {
      expect(cps(x)).toBeLessThanOrEqual(LAST_RESORT_TEXT.chars);
      expect(utf8Bytes(x)).toBeLessThanOrEqual(LAST_RESORT_TEXT.bytes);
    }
    // Titles are the arcs' match keys: they keep their 80.
    expect(r.arcs.map((a) => a.title)).toEqual(r.arcs.map((a) => s.arcs.find((b) => b.id === a.id)!.title));
    expect(r.lastPlantTurn).toBe(41);
  });

  test('step 6 cuts a Latin or Cyrillic text at 120 chars, a Chinese one at ≤ 240 bytes (~80 chars), at a word boundary where there is one; a cut is not cut again', () => {
    // A seed hint: no earlier step cuts it. Eleven seeds: step 5 keeps 16, step 6 the newest 10.
    const one = (t: string): string => {
      const s = stateOf({ seeds: Array.from({ length: 11 }, (_, i) => seedOf({ id: `seed-${i + 1}`, plantedAtTurn: i, hint: i === 10 ? t : 'x' })) });
      const r = fitState(s, stateBytes(s) - 1);
      expect(fits(r)).toEqual(['fit:texts']);
      return r.state.seeds.at(-1)!.hint;
    };
    const cyr = one(ru(300));
    expect(cps(cyr)).toBeLessThanOrEqual(120);
    expect(cps(cyr)).toBeGreaterThan(100);
    expect(cyr.endsWith('…')).toBe(true);
    expect(ru(300)[cyr.length - 1]).toBe(' '); // cut where a word ended
    const han = one(zh(300));
    expect(utf8Bytes(han)).toBeLessThanOrEqual(240);
    expect(cps(han)).toBe(80); // 79 characters x 3 bytes + '…' (3) = 240
    const wave = one(EMOJI(300));
    expect(utf8Bytes(wave)).toBeLessThanOrEqual(240);
    for (const t of [cyr, han, wave]) expect(one(t)).toBe(t);
    expect(one(ru(120))).toBe(ru(120)); // within both bounds: untouched
  });

  test('step 6 never evicts a person’s item nor cuts its texts; notes stay whole; their clue lists are capped like any other', () => {
    const long = ru(1_500);
    const s = stateOf({
      arcs: [arcOf({ id: 'arc-1', description: long, byUser: true, createdAtTurn: 0 }), ...Array.from({ length: 10 }, (_, i) => arcOf({ id: `arc-${i + 2}`, description: ru(300, i), createdAtTurn: i + 1 }))],
      seeds: [seedOf({ id: 'seed-20', payoff: long, byUser: true, plantedAtTurn: 0 })],
      invisibleArcs: [hiddenOf({ id: 'hidden-30', description: long, userAuthored: true, playerClues: [1, 2, 3].map((turn) => ({ turn, clue: ru(50, turn) })) })],
      notes: [{ id: 'note-1', content: long, createdAtTurn: 1 }],
    });
    const out = fitState(s, 1);
    expect(fits(out)).toContain('fit:texts');
    expect(fits(out).at(-1)).toBe('fit:over-cap');
    const r = out.state;
    expect(r.arcs[0]).toBe(s.arcs[0]!); // the person's arc, whole
    expect(r.arcs).toHaveLength(9); // + the 8 newest of the model's
    expect(r.seeds[0]!.payoff).toBe(long);
    expect(r.invisibleArcs[0]!.description).toBe(long);
    expect(r.invisibleArcs[0]!.playerClues.map((c) => c.turn)).toEqual([3]);
    expect(r.notes).toBe(s.notes);
  });

  test('step 7 runs only when step 6 was not enough: the lastDirective (and so the next self-audit) stays when it can', () => {
    const s = stateOf({
      arcs: Array.from({ length: 12 }, (_, i) => arcOf({ id: `arc-${i + 1}`, description: ru(300, i), createdAtTurn: i })),
      lastDirective: { turn: 5, directive: { pacing: 'slow', narrativeGoal: ru(300) } },
    });
    const after6 = through(s, 'texts').state;
    const kept = fitState(s, stateBytes(after6));
    expect(fits(kept)).toEqual(['fit:descriptions', 'fit:texts']);
    expect(kept.state.lastDirective).toEqual(s.lastDirective!);
    const dropped = fitState(s, stateBytes(after6) - 1);
    expect(fits(dropped)).toEqual(['fit:descriptions', 'fit:texts', 'fit:last-directive']);
    expect(dropped.state.lastDirective).toBeUndefined();
    expect('lastDirective' in dropped.state).toBe(false);
    // A huge lastDirective alone: the story is cut first (the lead's order), then it goes.
    const big = stateOf({ arcs: [arcOf()], lastDirective: { turn: 5, directive: directiveAt(zh) } });
    const out = fitState(big);
    expect(fits(out)).toEqual(['fit:last-directive']);
    expect(out.state.arcs).toBe(big.arcs);
  });

  test('fit:over-cap only after step 7, and only with a person’s items', () => {
    const notes = Array.from({ length: 16 }, (_, i) => ({ id: `note-${i}`, content: ru(1_500, i), createdAtTurn: i }));
    const s = { ...atEveryLimit(ru), notes };
    const out = fitState(s);
    expect(fits(out)).toEqual([...FIT_STEPS.map((x) => `fit:${x}`), FIT_OVER_CAP.why]);
    expect(out.state.notes).toEqual(notes);
    expect(checkState(roundTrip(out.state))).toEqual(out.state); // over the cap, still readable
  });
});

/** A small deterministic PRNG for the generated states (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A random state the model could leave: any script per text, any length up to 500, any list sizes up to beyond the limits. */
function generated(seed: number, withPerson: boolean): DirectorState {
  const r = prng(seed);
  const int = (max: number): number => Math.floor(r() * (max + 1));
  const pick = <T>(list: readonly T[]): T => list[int(list.length - 1)]!;
  const scripts: Prose[] = [ru, zh, EMOJI, LATIN];
  const text = (max = 500): string => pick(scripts)(int(max), int(50));
  let n = 1;
  const stages = (): { title: string; turn: number }[] => Array.from({ length: int(9) }, (_, k) => ({ title: text(), turn: k }));
  const arcs = Array.from({ length: int(40) }, (_, i) =>
    arcOf({
      id: `arc-${n++}`,
      title: text(120),
      description: text(),
      status: pick(['seeding', 'building', 'climax', 'resolution', 'complete', 'abandoned'] as const),
      createdAtTurn: int(300),
      ...(r() < 0.7 ? { lastProgressTurn: int(300) } : {}),
      stages: stages(),
      ...(r() < 0.6 ? { nextBeat: { description: text(), plannedAtTurn: int(300), status: 'pending' as const } } : {}),
      ...(withPerson && i < 2 ? { byUser: true as const } : {}),
    }),
  );
  const seeds = Array.from({ length: int(45) }, (_, i) =>
    seedOf({
      id: `seed-${n++}`,
      hint: text(),
      payoff: text(),
      plantedAtTurn: int(300),
      payoffDelivered: r() < 0.3,
      reinforcements: Array.from({ length: int(6) }, (_, k) => ({ turn: k })),
      ...(withPerson && i < 2 ? { byUser: true as const } : {}),
    }),
  );
  const invisibleArcs = Array.from({ length: int(25) }, (_, i) =>
    hiddenOf({
      id: `hidden-${n++}`,
      title: text(120),
      description: text(),
      status: pick(['seeding', 'building', 'approaching_player', 'visible', 'resolved'] as const),
      createdAtTurn: int(300),
      stages: stages(),
      playerClues: Array.from({ length: int(8) }, (_, k) => ({ turn: k, clue: text() })),
      ...(r() < 0.5 ? { surfaceCondition: text() } : {}),
      ...(withPerson && i < 1 ? { userAuthored: true as const } : {}),
    }),
  );
  const chapters = Array.from({ length: int(14) }, (_, i) =>
    chapterOf({ id: `chapter-${i + 1}`, number: i + 1, title: text(), premise: text(), tone: text(), majorGoal: text(), themes: Array.from({ length: int(15) }, () => text()), createdAtTurn: i * 10, ...(r() < 0.5 ? { closingMoment: text() } : {}) }),
  );
  const lastDirective: NarratorDirective | undefined =
    r() < 0.7 ? { pacing: 'fast', mood: text(), narrativeGoal: text(), arcDirections: Array.from({ length: int(12) }, () => ({ arcName: text(80), instruction: text(), urgency: 'subtle' as const })), include: { themes: Array.from({ length: int(12) }, () => text()) } } : undefined;
  return stateOf({
    turn: 300,
    nextId: n,
    arcs,
    seeds,
    invisibleArcs,
    chapters,
    ...(chapters.length > 0 && r() < 0.8 ? { currentChapterId: `chapter-${int(chapters.length - 1) + 1}` } : {}),
    notes: withPerson ? Array.from({ length: int(16) }, (_, i) => ({ id: `note-${i}`, content: text(600), createdAtTurn: i })) : [],
    pacing: { currentMood: text(), turnsAtCurrentMood: int(9), rhythm: { lastActionSequence: int(300), lastQuietMoment: int(300) } },
    nextIntentions: Array.from({ length: int(8) }, () => ({ type: text(40), description: text(), priority: 'could' as const, targetTurn: 'eventually' as const })),
    ...(lastDirective ? { lastDirective: { turn: 300, directive: lastDirective } } : {}),
  });
}

describe('D-116: checkState accepts every state fitState returns (generated states)', () => {
  test('150 generated model states in mixed scripts: each ends within 32 KB and reads back equal', () => {
    let steps = 0;
    const seen = new Set<string>();
    for (let seed = 1; seed <= 150; seed++) {
      const out = fitState(generated(seed, false));
      for (const w of fits(out)) seen.add(w);
      expect(out.skipped).not.toContainEqual(FIT_OVER_CAP);
      expect(stateBytes(out.state)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
      expect(checkState(roundTrip(out.state))).toEqual(out.state);
      // The steps that ran ran in FIT_STEPS order.
      const ran = fits(out).map((w) => FIT_STEPS.indexOf(w.slice(4) as FitStep));
      expect(ran).toEqual([...ran].sort((a, b) => a - b));
      steps += ran.length;
    }
    expect(steps).toBeGreaterThan(150); // the generator does reach the size steps
    expect([...seen].sort()).toEqual(FIT_STEPS.map((x) => `fit:${x}`).sort()); // every one of them
  });

  test('with a person’s items too (texts up to 600 chars): over the cap or not, the state reads back equal', () => {
    for (let seed = 1_001; seed <= 1_080; seed++) {
      const out = fitState(generated(seed, true));
      expect(checkState(roundTrip(out.state))).toEqual(out.state);
      if (!out.skipped.some((k) => k.why === FIT_OVER_CAP.why)) expect(stateBytes(out.state)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    }
  });
});
