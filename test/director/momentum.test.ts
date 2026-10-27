// Ported from Bunraku:src/core/director/momentum.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: the threshold, ripeness, planting, shadow and text cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/director/momentum.ts (ARCHITECTURE.md §7.3 "Импульс", D-63; m4-decisions A.2, A.3, D-102,
// D-109): RoleCall's thresholds exactly, every one of them checked just below and at its boundary;
// ages derived from createdAtTurn / plantedAtTurn / lastProgressTurn; the report and the pressures name
// the plan's fields bare (never commit_planning_round); a lite report has no shadow section.
// Changed from Bunraku: no removedAt (the "removed" cases are dropped), the hidden-arc case is
// rewritten for derived surface turns, the text case asserts the bare field names.
import { describe, expect, test } from 'bun:test';
import { computeMomentum, formatMomentumReport, MOMENTUM, planningPressures } from '../../src/agents/director/momentum.ts';
import {
  CHAPTER_TURNS,
  HORIZONS,
  SURFACE_TURNS,
  type DirectorArc,
  type DirectorInvisibleArc,
  type DirectorSeed,
  type DirectorState,
} from '../../src/agents/director/types.ts';

// Builders (Bunraku fixtures.ts without the fields rp-core does not store).
const arcOf = (over: Partial<DirectorArc> = {}): DirectorArc => ({
  id: 'arc-1',
  title: 'The Locked Room',
  description: 'A door nobody opens.',
  status: 'building',
  priority: 'active',
  arcType: 'side',
  horizon: 'medium',
  stages: [],
  createdAtTurn: 1,
  ...over,
});
const seedOf = (over: Partial<DirectorSeed> = {}): DirectorSeed => ({
  id: 'seed-1',
  hint: 'A cracked bell',
  payoff: 'It rings at the finale.',
  scope: 'world',
  plantedAtTurn: 1,
  payoffHorizon: 'long',
  payoffDelivered: false,
  reinforcements: [],
  ...over,
});
const hiddenOf = (over: Partial<DirectorInvisibleArc> = {}): DirectorInvisibleArc => ({
  id: 'hidden-1',
  title: 'The Ledger Conspiracy',
  description: 'Someone is cooking the books.',
  arcType: 'conspiracy',
  horizon: 'medium',
  scope: 'world',
  status: 'building',
  stages: [],
  playerClues: [],
  createdAtTurn: 1,
  ...over,
});
const stateOf = (over: Partial<DirectorState> = {}): DirectorState => ({
  turn: 0,
  nextId: 1,
  chapters: [],
  arcs: [],
  seeds: [],
  invisibleArcs: [],
  notes: [],
  pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
  nextIntentions: [],
  ...over,
});
const two = [{ turn: 5 }, { turn: 9 }];
/** A state with no planting pressure at `turn` (a plant on that turn), so a test sees only its own signal. */
const calm = (over: Partial<DirectorState> = {}, turn = 0): DirectorState => stateOf({ lastPlantTurn: turn, ...over });
const allText = (state: DirectorState, turn: number, lite = false): string => {
  const report = computeMomentum(state, turn);
  return [formatMomentumReport(report, { lite }), planningPressures(state, report, { lite }), report.summary].join('\n');
};

describe('MOMENTUM', () => {
  test('one data object holds every threshold, with RoleCall’s values', () => {
    expect(MOMENTUM).toEqual({
      horizonLimits: { immediate: 2, short: 9, medium: 15, long: 30, epic: 75 },
      arcStale: 15,
      seedRipe: { age: 30, reinforcements: 2, overdueAge: 60 },
      planting: { moderate: 12, high: 20, critical: 35 },
      invisibleSurface: { immediate: 2, short: 6, medium: 12, long: 25, epic: 60 },
      shadowUrgency: { high: 10, medium: 4 },
      overallPace: { staleArcs: 3, ripeSeeds: 2 },
      rhythm: { quiet: 8, tension: 12, climax: 4 },
      chapter: { wrap: 0.7, startNew: 50, overdue: 100, justStarted: 10 },
      arcHints: { minActive: 2, minActiveAfterTurn: 5, maxStagesSingle: 5, characterArcAfter: 8, sideArcAfter: 10 },
      listMax: 10,
    });
  });

  test('the chapter hints follow CHAPTER_TURNS: wrap up from 35, start_new from 50, OVERDUE from 100', () => {
    expect(MOMENTUM.chapter.startNew).toBe(CHAPTER_TURNS.target);
    expect(MOMENTUM.chapter.overdue).toBe(CHAPTER_TURNS.maximum);
    expect(MOMENTUM.chapter.wrap * CHAPTER_TURNS.target).toBe(35);
  });

  test('a surface turn always comes before the parity age (D-63 note), for every horizon', () => {
    for (const h of HORIZONS) expect(SURFACE_TURNS[h]).toBeLessThan(MOMENTUM.invisibleSurface[h]);
  });
});

describe('forced and stale arcs', () => {
  test.each([
    ['immediate', 2],
    ['short', 9],
    ['medium', 15],
    ['long', 30],
    ['epic', 75],
  ] as const)('a %s arc is forced at exactly %i turns without progress', (horizon, limit) => {
    const state = stateOf({ arcs: [arcOf({ horizon, lastProgressTurn: 100 })] });
    expect(computeMomentum(state, 100 + limit - 1).forcedActions).toEqual([]);
    expect(computeMomentum(state, 100 + limit).forcedActions).toMatchObject([
      { id: 'arc-1', horizon, horizonLimit: limit, overdueBy: 0, turnsSinceProgress: limit },
    ]);
    expect(computeMomentum(state, 100 + limit + 4).forcedActions[0]!.overdueBy).toBe(4);
  });

  test('an arc is stale at 15 turns, seeding arcs are never forced, finished arcs never count, and an arc with no progress turn ages from its creation', () => {
    const arcs = [
      arcOf({ id: 'a', lastProgressTurn: 0 }),
      arcOf({ id: 's', title: 'S', status: 'seeding', lastProgressTurn: 0 }),
      arcOf({ id: 'd', title: 'D', status: 'complete', lastProgressTurn: 0 }),
      arcOf({ id: 'x', title: 'X', status: 'abandoned', lastProgressTurn: 0 }),
      arcOf({ id: 'g', title: 'G' }), // created at turn 1, never progressed
    ];
    const at14 = computeMomentum(stateOf({ arcs }), 14);
    expect(at14.staleArcs).toEqual([]);
    const at15 = computeMomentum(stateOf({ arcs }), 15);
    expect(at15.staleArcs.map((a) => a.name).sort()).toEqual(['S', 'The Locked Room']);
    expect(at15.forcedActions.map((a) => a.id)).toEqual(['a']);
    const at16 = computeMomentum(stateOf({ arcs }), 16);
    expect(at16.staleArcs.map((a) => a.name).sort()).toEqual(['G', 'S', 'The Locked Room']);
    expect(at16.forcedActions.map((a) => a.id)).toEqual(['a', 'g']);
  });

  test('an arc with no progress turn ages from its creation: turnsSinceProgress = turn − (lastProgressTurn ?? createdAtTurn)', () => {
    // FLIPPED (D-117, A.2 stands): was "the grace rule" — Bunraku's `lastProgressTurn ?? turn` counted
    // such an arc as having just moved however old it was, so it was never stale or forced. reduce
    // sets lastProgressTurn on every arc it creates, so this reaches only an arc written without it.
    const report = computeMomentum(stateOf({ arcs: [arcOf({ createdAtTurn: 1, horizon: 'immediate' })] }), 99);
    expect(report.staleArcs.map((a) => [a.id, a.turnsSinceProgress])).toEqual([['arc-1', 98]]);
    expect(report.forcedActions).toEqual([
      { id: 'arc-1', name: 'The Locked Room', status: 'building', horizon: 'immediate', turnsSinceProgress: 98, horizonLimit: 2, overdueBy: 96 },
    ]);
    const young = computeMomentum(stateOf({ arcs: [arcOf({ createdAtTurn: 98, horizon: 'immediate' })] }), 99);
    expect(young.staleArcs).toEqual([]);
    expect(young.forcedActions).toEqual([]);
    // lastProgressTurn, when set, still wins over the creation turn.
    expect(computeMomentum(stateOf({ arcs: [arcOf({ createdAtTurn: 1, lastProgressTurn: 98, horizon: 'immediate' })] }), 99).forcedActions).toEqual([]);
  });

  test('the most overdue arc comes first', () => {
    const state = stateOf({ arcs: [arcOf({ id: 'a', lastProgressTurn: 10 }), arcOf({ id: 'b', title: 'B', lastProgressTurn: 0 })] });
    expect(computeMomentum(state, 40).forcedActions.map((a) => a.id)).toEqual(['b', 'a']);
    expect(computeMomentum(state, 40).staleArcs.map((a) => a.id)).toEqual(['b', 'a']);
  });

  test('the stale advice follows the status', () => {
    const arcs = [
      arcOf({ id: 's', status: 'seeding', lastProgressTurn: 0 }),
      arcOf({ id: 'b', status: 'building', lastProgressTurn: 1 }),
      arcOf({ id: 'c', status: 'climax', lastProgressTurn: 2 }),
      arcOf({ id: 'r', status: 'resolution', lastProgressTurn: 3 }),
    ];
    const byId = new Map(computeMomentum(stateOf({ arcs }), 20).staleArcs.map((a) => [a.id, a.suggestedAction]));
    expect(byId.get('s')).toBe('Time to escalate this arc from setup to active development.');
    expect(byId.get('b')).toContain('building too long');
    expect(byId.get('c')).toContain('Climax has stalled');
    expect(byId.get('r')).toBe('Force progression - 17 turns is too long without movement.');
  });
});

describe('seeds', () => {
  test('a seed is ripe at 30 turns with two reinforcements, not with one, and not when delivered', () => {
    const seeds = [
      seedOf({ id: 'ripe', reinforcements: two }),
      seedOf({ id: 'one', hint: 'One', reinforcements: two.slice(0, 1) }),
      seedOf({ id: 'done', hint: 'Done', reinforcements: two, payoffDelivered: true }),
    ];
    expect(computeMomentum(stateOf({ seeds }), 30).ripeSeeds).toEqual([]);
    expect(computeMomentum(stateOf({ seeds }), 31).ripeSeeds.map((s) => s.name)).toEqual(['A cracked bell']);
    expect(computeMomentum(stateOf({ seeds }), 62).ripeSeeds[0]!.suggestedAction).toContain('OVERDUE');
  });

  test('ripeness boundaries: age 29/30, one/two reinforcements, OVERDUE only past age 60', () => {
    const seeds = [seedOf({ plantedAtTurn: 10, reinforcements: two })];
    expect(computeMomentum(stateOf({ seeds }), 39).ripeSeeds).toEqual([]);
    expect(computeMomentum(stateOf({ seeds }), 40).ripeSeeds).toMatchObject([
      { id: 'seed-1', name: 'A cracked bell', turnsPlanted: 30, reinforcements: 2, payoff: 'It rings at the finale.' },
    ]);
    expect(computeMomentum(stateOf({ seeds: [seedOf({ plantedAtTurn: 10, reinforcements: [{ turn: 3 }] })] }), 40).ripeSeeds).toEqual([]);
    expect(computeMomentum(stateOf({ seeds }), 70).ripeSeeds[0]!.suggestedAction).toStartWith('Ready for payoff.');
    expect(computeMomentum(stateOf({ seeds }), 71).ripeSeeds[0]!.suggestedAction).toStartWith('OVERDUE');
  });

  test('the oldest ripe seed comes first', () => {
    const seeds = [seedOf({ id: 'young', hint: 'Young', plantedAtTurn: 5, reinforcements: two }), seedOf({ id: 'old', plantedAtTurn: 1, reinforcements: two })];
    expect(computeMomentum(stateOf({ seeds }), 40).ripeSeeds.map((s) => s.id)).toEqual(['old', 'young']);
  });

  // Bunraku's title passed three values to two placeholders; the fixture now uses lastPlantTurn (§7.3).
  test.each([
    [0, 'none'],
    [11, 'none'],
    [12, 'moderate'],
    [19, 'moderate'],
    [20, 'high'],
    [34, 'high'],
    [35, 'critical'],
  ] as const)('planting pressure after the last plant at turn 1 and now %i turns later is %s', (later, severity) => {
    const state = stateOf({ lastPlantTurn: 1 });
    const p = computeMomentum(state, 1 + later).plantingPressure;
    expect(p.severity).toBe(severity);
    expect(p.active).toBe(severity !== 'none');
    expect(p.turnsSinceLastPlant).toBe(later);
  });

  test('without lastPlantTurn the newest seed’s plant turn counts, paid seeds included; the later of both wins', () => {
    const seeds = [seedOf({ plantedAtTurn: 3 }), seedOf({ id: 'seed-2', plantedAtTurn: 8, payoffDelivered: true })];
    expect(computeMomentum(stateOf({ seeds }), 20).plantingPressure).toMatchObject({ severity: 'moderate', turnsSinceLastPlant: 12, pendingCount: 1 });
    expect(computeMomentum(stateOf({ seeds, lastPlantTurn: 10 }), 20).plantingPressure).toMatchObject({ severity: 'none', turnsSinceLastPlant: 10 });
  });

  test('lastPlantTurn survives the eviction of every seed: no "never planted" pressure', () => {
    const p = computeMomentum(stateOf({ lastPlantTurn: 5 }), 10).plantingPressure;
    expect(p).toMatchObject({ active: false, severity: 'none', pendingCount: 0, turnsSinceLastPlant: 5 });
    expect(p.reason).toBe('Last plant was 5 turns ago. Planting rhythm healthy.');
  });

  test('a story that never planted a seed is under critical pressure', () => {
    expect(computeMomentum(stateOf(), 3).plantingPressure).toMatchObject({ active: true, severity: 'critical', pendingCount: 0, turnsSinceLastPlant: 3 });
    expect(computeMomentum(stateOf(), 3).plantingPressure.reason).toContain('No seeds have ever been planted');
  });
});

describe('hidden arcs', () => {
  // Rewritten: Bunraku stored turnsActive and expectedSurfaceTurn; here both come from createdAtTurn
  // (§7.3, D-63), and the surface turn createdAtTurn + SURFACE_TURNS[horizon] fires first.
  test('a hidden arc is ripe at its expected surface turn, never once visible or resolved', () => {
    const arcs = [
      hiddenOf({ id: 'h', horizon: 'short', createdAtTurn: 1 }), // due at 4
      hiddenOf({ id: 'v', title: 'V', status: 'visible', createdAtTurn: 1 }),
      hiddenOf({ id: 'r', title: 'R', status: 'resolved', createdAtTurn: 1 }),
      hiddenOf({ id: 'e', title: 'E', horizon: 'long', createdAtTurn: 0 }), // due at 10
    ];
    expect(computeMomentum(stateOf({ invisibleArcs: arcs }), 3).shadowOpportunities).toEqual([]);
    expect(computeMomentum(stateOf({ invisibleArcs: arcs }), 4).shadowOpportunities).toMatchObject([
      { id: 'h', turnsRipe: 0, urgency: 'low', reason: 'Expected surface turn (4) reached 0 turns ago' },
    ]);
    expect(computeMomentum(stateOf({ invisibleArcs: arcs }), 10).shadowOpportunities.map((o) => [o.id, o.urgency])).toEqual([
      ['h', 'medium'],
      ['e', 'low'],
    ]);
    expect(computeMomentum(stateOf({ invisibleArcs: arcs }), 24).shadowOpportunities.find((o) => o.id === 'e')!.urgency).toBe('high');
    expect(computeMomentum(stateOf({ invisibleArcs: [arcs[1]!, arcs[2]!] }), 999).shadowOpportunities).toEqual([]);
  });

  test.each(HORIZONS.map((h) => [h, SURFACE_TURNS[h]] as const))('a %s hidden arc is due %i turns after it was created', (horizon, after) => {
    const state = stateOf({ invisibleArcs: [hiddenOf({ horizon, createdAtTurn: 7 })] });
    expect(computeMomentum(state, 7 + after - 1).shadowOpportunities).toEqual([]);
    expect(computeMomentum(state, 7 + after).shadowOpportunities).toMatchObject([{ id: 'hidden-1', turnsRipe: 0 }]);
  });

  test('urgency: medium from 4 turns past due, high from 10; high first, then the longest ripe', () => {
    const at = (turn: number) => computeMomentum(stateOf({ invisibleArcs: [hiddenOf({ horizon: 'immediate', createdAtTurn: 0 })] }), turn).shadowOpportunities[0]!;
    // immediate: due at turn 1.
    expect([at(4).urgency, at(5).urgency, at(10).urgency, at(11).urgency]).toEqual(['low', 'medium', 'medium', 'high']);
    const arcs = [
      hiddenOf({ id: 'low', horizon: 'immediate', createdAtTurn: 18 }),
      hiddenOf({ id: 'hi1', horizon: 'immediate', createdAtTurn: 5 }),
      hiddenOf({ id: 'hi2', horizon: 'immediate', createdAtTurn: 0 }),
      hiddenOf({ id: 'mid', horizon: 'immediate', createdAtTurn: 14 }),
    ];
    expect(computeMomentum(stateOf({ invisibleArcs: arcs }), 20).shadowOpportunities.map((o) => o.id)).toEqual(['hi2', 'hi1', 'mid', 'low']);
  });

  test('the summary is the description cut to 140 characters, or the title when there is none; the advice follows the status', () => {
    const long = 'Тайный совет '.repeat(20);
    const arcs = [
      hiddenOf({ id: 'a', description: long, status: 'seeding', createdAtTurn: 0 }),
      hiddenOf({ id: 'b', title: 'Заговор казначея', description: '', status: 'approaching_player', createdAtTurn: 0 }),
    ];
    const byId = new Map(computeMomentum(stateOf({ invisibleArcs: arcs }), 5).shadowOpportunities.map((o) => [o.id, o]));
    expect(byId.get('a')!.summary).toBe(long.slice(0, 140));
    expect(byId.get('a')!.suggestedAction).toStartWith('Plant the first breadcrumb');
    expect(byId.get('b')!.summary).toBe('Заговор казначея');
    expect(byId.get('b')!.suggestedAction).toStartWith('SURFACE NOW.');
  });

  test('the cut never splits a surrogate pair', () => {
    const description = `${'x'.repeat(139)}😀 tail`;
    const o = computeMomentum(stateOf({ invisibleArcs: [hiddenOf({ description, createdAtTurn: 0 })] }), 50).shadowOpportunities[0]!;
    expect(o.summary).toBe('x'.repeat(139));
  });
});

describe('rhythm and pace', () => {
  const rhythm = (r: Partial<DirectorState['pacing']>, turn: number) =>
    computeMomentum(calm({ pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 }, ...r } }, turn), turn).rhythm;

  test('needsQuietMoment: the last quiet scene more than 8 turns ago, once there was any action', () => {
    expect(rhythm({ rhythm: { lastActionSequence: 5, lastQuietMoment: 2 } }, 10).needsQuietMoment).toBe(false);
    expect(rhythm({ rhythm: { lastActionSequence: 5, lastQuietMoment: 2 } }, 11).needsQuietMoment).toBe(true);
    // Bunraku's guard: a story with no action yet never asks for a breather.
    expect(rhythm({ rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } }, 50).needsQuietMoment).toBe(false);
  });

  test('needsTension: the last action more than 12 turns ago, once there was a quiet scene', () => {
    expect(rhythm({ rhythm: { lastActionSequence: 1, lastQuietMoment: 3 } }, 13).needsTension).toBe(false);
    expect(rhythm({ rhythm: { lastActionSequence: 1, lastQuietMoment: 3 } }, 14).needsTension).toBe(true);
    expect(rhythm({ rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } }, 50).needsTension).toBe(false);
  });

  test('readyForClimax: 4 turns in a tense mood, by its words, English or Russian (D-109)', () => {
    expect(rhythm({ currentMood: 'tense', turnsAtCurrentMood: 3 }, 9).readyForClimax).toBe(false);
    expect(rhythm({ currentMood: 'tense', turnsAtCurrentMood: 4 }, 9).readyForClimax).toBe(true);
    expect(rhythm({ currentMood: 'Tense, watchful', turnsAtCurrentMood: 4 }, 9).readyForClimax).toBe(true);
    expect(rhythm({ currentMood: 'тревожное ожидание', turnsAtCurrentMood: 6 }, 9).readyForClimax).toBe(true);
    expect(rhythm({ currentMood: 'calm', turnsAtCurrentMood: 9 }, 9).readyForClimax).toBe(false);
  });

  test('the pacing advice: many stale arcs or ripe seeds first, then quiet, tension, climax, one stale arc, healthy', () => {
    const stale = (n: number) => Array.from({ length: n }, (_, i) => arcOf({ id: `arc-${i + 1}`, title: `A${i}`, status: 'seeding', lastProgressTurn: 0 }));
    const ripe = (n: number) => Array.from({ length: n }, (_, i) => seedOf({ id: `seed-${i + 1}`, hint: `S${i}`, reinforcements: two }));
    const pace = (over: Partial<DirectorState>, turn = 40) => computeMomentum(calm(over, turn), turn).pacingRecommendation;
    expect(pace({ arcs: stale(3) })).toStartWith('Multiple storylines need attention.');
    expect(pace({ arcs: stale(2) })).toStartWith('One or more arcs need progression.');
    expect(pace({ seeds: ripe(2) })).toStartWith('Multiple storylines need attention.');
    expect(pace({ seeds: ripe(1) })).toBe('Pacing is healthy. Continue the current rhythm.');
    const pacing = (lastActionSequence: number, lastQuietMoment: number, currentMood = 'ambient', turnsAtCurrentMood = 0) => ({
      currentMood,
      turnsAtCurrentMood,
      rhythm: { lastActionSequence, lastQuietMoment },
    });
    expect(pace({ arcs: stale(1), pacing: pacing(30, 1) })).toStartWith('The story needs a breather.');
    expect(pace({ arcs: stale(1), pacing: pacing(1, 39) })).toStartWith('Tension is low.');
    expect(pace({ arcs: stale(1), pacing: pacing(0, 0, 'напряжение', 4) })).toStartWith('The story is primed for a climax.');
    expect(pace({})).toBe('Pacing is healthy. Continue the current rhythm.');
  });

  test('the summary counts each signal, or says all is well', () => {
    expect(computeMomentum(calm({}, 6), 6).summary).toBe('All arcs progressing normally. Pacing is healthy. Continue the current rhythm.');
    const state = stateOf({
      arcs: [arcOf({ lastProgressTurn: 0 })],
      seeds: [seedOf({ plantedAtTurn: 0, reinforcements: two })],
      invisibleArcs: [hiddenOf({ createdAtTurn: 0 })],
    });
    expect(computeMomentum(state, 40).summary).toBe(
      '1 arc(s) MUST be resolved/advanced this turn; 1 stale arc(s) need attention; 1 seed(s) ripe for payoff; planting pressure: critical; 1 shadow item(s) ready to surface. One or more arcs need progression. Weave advancement into the natural flow of the scene.',
    );
  });
});

describe('what the planner is told', () => {
  test('the report and the pressure message name the plan fields bare, never a tool the planner does not have', () => {
    // Changed (m4-decisions A.3): `commit_planning_round.arcUpdates` → `arcUpdates`.
    const state = stateOf({ arcs: [arcOf({ lastProgressTurn: 0 })], invisibleArcs: [hiddenOf({ createdAtTurn: 0 })] });
    const text = allText(state, 40);
    expect(text).toContain('You MUST include an arcUpdates entry for each one');
    expect(text).toContain("MUST be acted upon in this turn's arcUpdates:");
    expect(text).toContain('[arc-1]');
    expect(text).toContain('nextBeat');
    expect(text).not.toContain('commit_planning_round');
    expect(text).not.toMatch(/batch_update|surface_invisible_arc|add_arc_clue|set_directive/);
  });

  test('a quiet story gets the one-line report and no pressure message', () => {
    const state = stateOf({
      seeds: [seedOf({ plantedAtTurn: 5 })],
      arcs: [arcOf({ lastProgressTurn: 5, nextBeat: { description: 'x', plannedAtTurn: 5, status: 'pending' } })],
    });
    const report = computeMomentum(state, 6);
    expect(formatMomentumReport(report)).toBe(
      '[MOMENTUM REPORT]\nPacing is healthy. Continue the current rhythm.\nAll storylines progressing normally - no forced escalation needed.',
    );
    expect(planningPressures(state, report)).toBe('');
  });

  /** A state at turn 60 that raises every signal, with Russian titles. */
  const loud = (): DirectorState =>
    stateOf({
      arcs: [
        arcOf({ id: 'arc-1', title: 'Запертая комната', lastProgressTurn: 10 }),
        arcOf({ id: 'arc-2', title: 'Старый долг', status: 'seeding', lastProgressTurn: 40, nextBeat: { description: 'x', plannedAtTurn: 50, status: 'delivered', deliveredAtTurn: 55 } }),
      ],
      seeds: [seedOf({ hint: 'Треснувший колокол', payoff: 'Он зазвонит в финале.', plantedAtTurn: 2, reinforcements: two })],
      invisibleArcs: [hiddenOf({ title: 'Заговор казначея', description: 'Кто-то подделывает счета.', createdAtTurn: 30 })],
    });

  test('every section appears in Bunraku’s order, with Russian titles intact', () => {
    const report = computeMomentum(loud(), 60);
    const text = formatMomentumReport(report);
    const order = ['MANDATORY ARC ACTIONS THIS TURN', 'STALE ARCS', 'RIPE SEEDS', 'SEED PLANTING PRESSURE (CRITICAL)', 'SURFACE-READY SHADOW WORLD', '\nPacing: '];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('[arc-1] "Запертая комната" (building, medium horizon) - 50 turns without progress (35 past limit of 15). RESOLVE OR ADVANCE.');
    expect(text).toContain('"Запертая комната" (building) - 50 turns since last progress.');
    expect(text).toContain('"Треснувший колокол" - planted 58 turns ago, reinforced 2x. Payoff: Он зазвонит в финале.');
    expect(text).toContain('[INVISIBLE ARC] "Заговор казначея" (high, ripe 25t)');
    expect(text).toContain('Summary: Кто-то подделывает счета.');
    expect(text).toContain('set its action to "surface" in invisibleArcUpdates');
    expect(text).toContain('This is a CRITICAL pressure - planting a seed this turn is NOT optional.');
    const pressures = planningPressures(loud(), report);
    expect(pressures).toContain('- [arc-1] "Запертая комната" (currently building, medium horizon, 50 turns without progress, 35 past limit)');
    expect(pressures).toContain('- [arc-2] "Старый долг" (seeding) - previous beat delivered on turn 55, needs new plan');
    expect(pressures).toContain('SEED PLANTING IS MANDATORY THIS TURN - NOT OPTIONAL:');
    expect(pressures).toContain('You MUST include at least one entry in seedUpdates this turn with action:"plant".');
  });

  test('no output ever says commit_planning_round, and "an" stands before the field names', () => {
    for (const lite of [false, true]) {
      const text = allText(loud(), 60, lite);
      expect(text).not.toContain('commit_planning_round');
      expect(text).not.toMatch(/\ba (?:arcUpdates|seedUpdates|invisibleArcUpdates)\b/);
    }
  });

  test('lite leaves out the shadow-world section; a lite report with only shadow items is quiet', () => {
    const report = computeMomentum(loud(), 60);
    const lite = formatMomentumReport(report, { lite: true });
    expect(lite).not.toContain('SURFACE-READY SHADOW WORLD');
    expect(lite).not.toContain('[INVISIBLE ARC]');
    expect(lite).not.toContain('invisibleArcUpdates');
    expect(lite).toContain('MANDATORY ARC ACTIONS THIS TURN');
    expect(formatMomentumReport(report)).toContain('SURFACE-READY SHADOW WORLD');

    const onlyShadow = calm({ invisibleArcs: [hiddenOf({ createdAtTurn: 0 })] }, 20);
    const r2 = computeMomentum(onlyShadow, 20);
    expect(r2.shadowOpportunities).toHaveLength(1);
    expect(formatMomentumReport(r2, { lite: true })).toContain('no forced escalation needed');
    expect(formatMomentumReport(r2)).toContain('[INVISIBLE ARC] "The Ledger Conspiracy"');
  });

  test('the pressures name no hidden arc, so lite gives the same message', () => {
    const report = computeMomentum(loud(), 60);
    expect(planningPressures(loud(), report, { lite: true })).toBe(planningPressures(loud(), report));
  });

  test('the nextBeat pressure lists live arcs without a pending beat, with the reason', () => {
    const state = calm(
      {
        arcs: [
          arcOf({ id: 'arc-1', lastProgressTurn: 5 }),
          arcOf({ id: 'arc-2', title: 'B', lastProgressTurn: 5, nextBeat: { description: 'x', plannedAtTurn: 4, status: 'delivered' } }),
          arcOf({ id: 'arc-3', title: 'C', lastProgressTurn: 5, nextBeat: { description: 'x', plannedAtTurn: 4, status: 'abandoned' } }),
          arcOf({ id: 'arc-4', title: 'D', lastProgressTurn: 5, nextBeat: { description: 'x', plannedAtTurn: 4, status: 'pending' } }),
          arcOf({ id: 'arc-5', title: 'E', status: 'complete' }),
        ],
      },
      6,
    );
    const text = planningPressures(state, computeMomentum(state, 6));
    expect(text).toStartWith('MANDATORY: SET A FORWARD-LOOKING nextBeat FOR THESE ARCS THIS TURN:\n');
    expect(text).toContain('- [arc-1] "The Locked Room" (building) - no nextBeat set');
    expect(text).toContain('- [arc-2] "B" (building) - previous beat delivered on turn ?, needs new plan');
    expect(text).toContain('- [arc-3] "C" (building) - previous beat abandoned, needs new plan');
    expect(text).not.toContain('arc-4');
    expect(text).not.toContain('arc-5');
  });

  test('moderate planting pressure has its own header in both texts', () => {
    const state = stateOf({ lastPlantTurn: 1, seeds: [seedOf({ plantedAtTurn: 1 })], arcs: [arcOf({ lastProgressTurn: 13, nextBeat: { description: 'x', plannedAtTurn: 13, status: 'pending' } })] });
    const report = computeMomentum(state, 13);
    expect(report.plantingPressure.severity).toBe('moderate');
    expect(formatMomentumReport(report)).toContain('SEED PLANTING PRESSURE (MODERATE):\n  Last new seed was planted 12 turns ago.\n  Pending seeds currently tracked: 1');
    expect(formatMomentumReport(report)).not.toContain('CRITICAL pressure');
    expect(planningPressures(state, report)).toStartWith('SEED PLANTING PRESSURE (MODERATE):\nLast new seed was planted 12 turns ago.');
  });

  test('each list shows at most 10 entries, the most overdue first', () => {
    const arcs = (n: number) =>
      Array.from({ length: n }, (_, i) => arcOf({ id: `arc-${i + 1}`, title: `Arc ${i + 1}`, lastProgressTurn: i, nextBeat: { description: 'x', plannedAtTurn: 0, status: 'pending' } }));
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    for (const n of [10, 11]) {
      const state = calm({ arcs: arcs(n) }, 40);
      const report = computeMomentum(state, 40);
      expect(report.forcedActions).toHaveLength(n);
      const text = formatMomentumReport(report);
      expect(count(text, 'RESOLVE OR ADVANCE.')).toBe(10);
      expect(count(text, 'turns since last progress.')).toBe(10);
      expect(count(planningPressures(state, report), 'past limit)')).toBe(10);
    }
    const text = formatMomentumReport(computeMomentum(calm({ arcs: arcs(11) }, 40), 40));
    expect(text).toContain('[arc-1] "Arc 1"');
    expect(text).not.toContain('[arc-11]');
    const beats = Array.from({ length: 11 }, (_, i) => arcOf({ id: `arc-${i + 1}`, title: `Arc ${i + 1}`, lastProgressTurn: 39 }));
    const s2 = calm({ arcs: beats }, 40);
    expect(count(planningPressures(s2, computeMomentum(s2, 40)), 'no nextBeat set')).toBe(10);
    const seeds = Array.from({ length: 11 }, (_, i) => seedOf({ id: `seed-${i + 1}`, hint: `Seed ${i + 1}`, plantedAtTurn: 0, reinforcements: two }));
    expect(count(formatMomentumReport(computeMomentum(calm({ seeds }, 40), 40)), 'reinforced 2x')).toBe(10);
    const hidden = Array.from({ length: 11 }, (_, i) => hiddenOf({ id: `hidden-${i + 1}`, createdAtTurn: 0 }));
    expect(count(formatMomentumReport(computeMomentum(calm({ invisibleArcs: hidden }, 40), 40)), '[INVISIBLE ARC]')).toBe(10);
  });

  test('computeMomentum and the texts are pure: the state is not changed', () => {
    const state = loud();
    const before = JSON.stringify(state);
    const report = computeMomentum(state, 60);
    formatMomentumReport(report);
    planningPressures(state, report);
    expect(JSON.stringify(state)).toBe(before);
    expect(computeMomentum(state, 60)).toEqual(report);
  });
});
