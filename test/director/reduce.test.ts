// Ported from Bunraku:src/core/director/apply.test.ts and fixtures.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: applying a planning round) and the seed-age cases of
// RoleCall:apps/rc/src/lib/ai/dm-stream/__tests__/seed-aging.test.ts@fb8dc623e (Levi).
// Copyright (C) 2026 Coneja-Chibi, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// applyPlan (agents/director/reduce.ts; §7.3, D-63, D-108, D-109). Test names are Bunraku's where
// they still apply. Changed for rp-core: no `now`, activity, recentAnalysis or suggestedActions
// (their tests "only the last ten analyses…" and "the activity lines of the round…" are dropped: the
// analysis rides in the DirectorRecord, D-61); no turnsActive / turnsElapsed (ages are derived, D-61);
// a stage's turn is the turn; the per-item caps (stages 6, clues 6, reinforcements 4) are fitState's
// (state.ts), so here lists only grow; delete removes; refusals are `skipped` entries; the rhythm
// hints are momentum's, only the counters are here. Bunraku's fixtures are local (state.ts is another
// unit's file): the empty state is Bunraku's (turn 0, nextId 1, mood 'ambient', rhythm 0/0, D-103).
import { describe, expect, test } from 'bun:test';
import { applyPlan, FIRST_CHAPTER_TITLE, pacingAfter, sameMood } from '../../src/agents/director/reduce.ts';
import {
  STATE_LIMITS,
  type DirectorArc,
  type DirectorInvisibleArc,
  type DirectorSeed,
  type DirectorState,
  type PlanningRound,
} from '../../src/agents/director/types.ts';

// ---- fixtures (Bunraku fixtures.ts, cut down to the D-61 shape) ------------------------------------

const emptyState = (): DirectorState => ({
  turn: 0,
  nextId: 1,
  chapters: [],
  arcs: [],
  seeds: [],
  invisibleArcs: [],
  notes: [],
  pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
  nextIntentions: [],
});
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
  id: 'hid-1',
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
const stateOf = (over: Partial<DirectorState> = {}): DirectorState => ({ ...emptyState(), ...over });

const round = (over: Partial<PlanningRound> = {}): PlanningRound => ({
  directive: { mood: 'tense', pacing: 'slow' },
  arcUpdates: [],
  seedUpdates: [],
  invisibleArcUpdates: [],
  analysis: {},
  chapterUpdate: { action: 'none', title: 'x' },
  ...over,
});
const ctx = (turn: number) => ({ turn });
/** Age as state.ts derives it (RoleCall seedTurnsActive): never negative. */
const ageOf = (plantedAtTurn: number, turn: number): number => Math.max(0, turn - plantedAtTurn);

describe('the whole round', () => {
  test('the base state is not changed, the directive is kept for the next self-audit, and the analysis and pacing move', () => {
    const base = stateOf();
    const frozen = structuredClone(base);
    const r = round({ analysis: { whatHappened: 'A door.', intentions: [{ type: 'advance_arc', description: 'Open it', priority: 'should', targetTurn: 'next' }] } });
    const { state } = applyPlan(base, r, ctx(3));
    expect(base).toEqual(frozen);
    // Bunraku: lastDirective = the directive, lastDirectiveTurn = 3; here one field.
    expect(state.lastDirective).toEqual({ turn: 3, directive: { mood: 'tense', pacing: 'slow' } });
    expect(state.nextIntentions).toEqual([{ type: 'advance_arc', description: 'Open it', priority: 'should', targetTurn: 'next' }]);
    expect(state.pacing).toMatchObject({ currentMood: 'tense', turnsAtCurrentMood: 1 });
    expect(state.turn).toBe(3);
  });

  test('the round is not shared with the state: the stored directive and intentions are copies', () => {
    const r = round({ directive: { mood: 'calm', pacing: 'slow', include: { characters: ['Vera'] } }, analysis: { intentions: [{ type: 't', description: 'd', priority: 'must', targetTurn: 'soon' }] } });
    const { state } = applyPlan(stateOf(), r, ctx(1));
    r.directive.include!.characters!.push('Ghost');
    r.analysis.intentions![0]!.description = 'changed';
    expect(state.lastDirective?.directive.include?.characters).toEqual(['Vera']);
    expect(state.nextIntentions[0]?.description).toBe('d');
  });

  test('pacing remembers action and quiet, and asks for a breather only when one kind has gone on', () => {
    // The hints moved to momentum (D-63); the counters stay here. Bunraku's formula, applied to them,
    // still fires at the same turns (thresholds 8 / 12).
    const needsQuiet = (s: DirectorState, t: number) => s.pacing.rhythm.lastActionSequence > 0 && t - s.pacing.rhythm.lastQuietMoment > 8;
    const needsTension = (s: DirectorState, t: number) => s.pacing.rhythm.lastQuietMoment > 0 && t - s.pacing.rhythm.lastActionSequence > 12;
    let state = stateOf();
    state = applyPlan(state, round({ directive: { mood: 'action', pacing: 'fast' } }), ctx(1)).state;
    expect(state.pacing.rhythm).toEqual({ lastActionSequence: 1, lastQuietMoment: 0 });
    for (let t = 2; t <= 8; t++) state = applyPlan(state, round({ directive: { mood: 'tense', pacing: 'fast' } }), ctx(t)).state;
    expect(needsQuiet(state, 8)).toBe(false);
    state = applyPlan(state, round({ directive: { mood: 'tense', pacing: 'fast' } }), ctx(9)).state;
    expect(needsQuiet(state, 9)).toBe(true);
    state = applyPlan(state, round({ directive: { mood: 'calm', pacing: 'slow' } }), ctx(10)).state;
    expect(state.pacing.rhythm).toEqual({ lastActionSequence: 1, lastQuietMoment: 10 });
    expect(needsQuiet(state, 10)).toBe(false);
    for (let t = 11; t <= 13; t++) state = applyPlan(state, round({ directive: { mood: 'calm', pacing: 'slow' } }), ctx(t)).state;
    expect(needsTension(state, 13)).toBe(false);
    state = applyPlan(state, round({ directive: { mood: 'calm', pacing: 'slow' } }), ctx(14)).state;
    expect(needsTension(state, 14)).toBe(true);
    const fresh = applyPlan(stateOf(), round(), ctx(40)).state;
    expect([needsQuiet(fresh, 40), needsTension(fresh, 40)]).toEqual([false, false]);
  });

  test('the rhythm reads mood words, not whole strings [D-109]; climax counts as action (Bunraku)', () => {
    const at = (mood: string) => applyPlan(stateOf(), round({ directive: { mood, pacing: 'medium' } }), ctx(7)).state.pacing.rhythm;
    expect(at('a desperate chase')).toEqual({ lastActionSequence: 7, lastQuietMoment: 0 });
    expect(at('Climax!')).toEqual({ lastActionSequence: 7, lastQuietMoment: 0 });
    expect(at('quiet, reflective')).toEqual({ lastActionSequence: 0, lastQuietMoment: 7 });
    expect(at('the calm after the battle')).toEqual({ lastActionSequence: 7, lastQuietMoment: 7 });
    expect(at('tense, watchful')).toEqual({ lastActionSequence: 0, lastQuietMoment: 0 });
  });

  test('no mood or the same mood counts one more turn; another mood starts at 1', () => {
    let state = applyPlan(stateOf(), round({ directive: { mood: 'tense, watchful', pacing: 'slow' } }), ctx(1)).state;
    state = applyPlan(state, round({ directive: { mood: 'Watchful and tense.', pacing: 'slow' } }), ctx(2)).state;
    expect(state.pacing).toMatchObject({ currentMood: 'Watchful and tense.', turnsAtCurrentMood: 2 });
    state = applyPlan(state, round({ directive: { pacing: 'slow', narrativeGoal: 'g' } }), ctx(3)).state;
    expect(state.pacing).toMatchObject({ currentMood: 'Watchful and tense.', turnsAtCurrentMood: 3 });
    state = applyPlan(state, round({ directive: { mood: '  ', pacing: 'slow' } }), ctx(4)).state;
    expect(state.pacing.turnsAtCurrentMood).toBe(4);
    state = applyPlan(state, round({ directive: { mood: 'tense', pacing: 'slow' } }), ctx(5)).state;
    expect(state.pacing).toMatchObject({ currentMood: 'tense', turnsAtCurrentMood: 1 });
    // The empty state's 'ambient' is a mood like any other.
    expect(applyPlan(stateOf(), round({ directive: { mood: 'Ambient', pacing: 'slow' } }), ctx(1)).state.pacing.turnsAtCurrentMood).toBe(1);
  });

  test('ids come from one counter: arc-N, seed-N, hidden-N in plan order', () => {
    const { state } = applyPlan(
      stateOf({ nextId: 7 }),
      round({
        arcUpdates: [{ arcId: 'The Lamp', title: 'The Lamp' }],
        seedUpdates: [{ title: 'A cracked bell', action: 'plant' }],
        invisibleArcUpdates: [{ title: 'Cabal', action: 'add' }],
      }),
      ctx(2),
    );
    expect([state.arcs[0]?.id, state.seeds[0]?.id, state.invisibleArcs[0]?.id, state.nextId]).toEqual(['arc-7', 'seed-8', 'hidden-9', 10]);
  });

  test('intentions replace the stored ones: empty ones dropped, at most five kept, none → []', () => {
    const it = (d: string) => ({ type: 'advance_arc', description: d, priority: 'should' as const, targetTurn: 'next' as const });
    const base = stateOf({ nextIntentions: [it('old')] });
    const many = applyPlan(base, round({ analysis: { intentions: ['a', ' ', 'b', 'c', 'd', 'e', 'f'].map(it) } }), ctx(2));
    expect(many.state.nextIntentions.map((x) => x.description)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(many.skipped).toEqual([
      { path: 'analysis.intentions[1]', why: 'empty description' },
      { path: 'analysis.intentions', why: `kept ${STATE_LIMITS.intentions} of 6` },
    ]);
    expect(applyPlan(base, round(), ctx(2)).state.nextIntentions).toEqual([]);
  });

  test('a plain plan skips nothing and touches no item', () => {
    const base = stateOf({ arcs: [arcOf()], seeds: [seedOf()], invisibleArcs: [hiddenOf()] });
    const first = applyPlan(base, round(), ctx(2));
    expect(first.skipped).toEqual([]);
    expect(first.state.arcs).toEqual(base.arcs);
    expect(first.state.seeds).toEqual(base.seeds);
    expect(first.state.invisibleArcs).toEqual(base.invisibleArcs);
  });

  test('D-123: every text stored is within the text cap, the joined chapter goal included', () => {
    const long = (w: string): string => `${w} `.repeat(200).trim(); // ~1 000 chars
    const out = applyPlan(
      stateOf(),
      round({
        directive: { mood: long('тревога'), pacing: 'slow' },
        chapterUpdate: { action: 'start_new', title: long('Прибытие'), description: long('premise'), objectives: Array.from({ length: 12 }, (_, i) => `objective ${i} ${'x'.repeat(40)}`), themes: [long('theme')] },
        arcUpdates: [{ arcId: 'Bell', description: long('desc'), newStageTitle: long('stage'), nextBeat: { description: long('beat') } }],
        seedUpdates: [{ title: long('hint'), action: 'plant', description: long('payoff') }],
        invisibleArcUpdates: [{ title: 'Cabal', action: 'update', description: long('hidden'), newClue: long('clue'), surfaceCondition: long('when') }],
        analysis: { intentions: [{ type: long('type'), description: long('intent'), priority: 'must', targetTurn: 'next' }] },
      }),
      ctx(1),
    );
    const texts: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') texts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk(out.state);
    expect(texts.length).toBeGreaterThan(15);
    for (const t of texts) expect(Array.from(t).length).toBeLessThanOrEqual(STATE_LIMITS.text);
    expect(out.state.chapters[0]!.majorGoal.endsWith('…')).toBe(true);
    expect(out.skipped).toContainEqual({ path: 'chapterUpdate.objectives', why: `cut to ${STATE_LIMITS.text} chars` });
  });

  test('the same input gives the same output', () => {
    const r = round({ arcUpdates: [{ arcId: 'x', title: 'The Lamp', newStageTitle: 'Lit' }], seedUpdates: [{ title: 'Bell', action: 'plant' }] });
    expect(JSON.stringify(applyPlan(stateOf(), r, ctx(4)))).toBe(JSON.stringify(applyPlan(stateOf(), r, ctx(4))));
  });
});

describe('chapters', () => {
  test("with no chapter the first is always started, whatever was asked; the story's turn is its start", () => {
    const { state, skipped } = applyPlan(stateOf(), round({ chapterUpdate: { action: 'none', title: 'Chapter 1: The Arrival', objectives: ['Reach the pier', 'Find Vera'] } }), ctx(1));
    expect(state.chapters).toEqual([
      { id: 'chapter-1', number: 1, title: 'The Arrival', premise: '', status: 'active', themes: [], tone: '', majorGoal: 'Reach the pier; Find Vera', createdAtTurn: 1 },
    ]);
    expect(state.currentChapterId).toBe('chapter-1');
    expect(skipped).toEqual([]);
  });

  test('the first chapter without a title is "The Story Begins"; a later one is "Chapter N"', () => {
    const first = applyPlan(stateOf(), round({ chapterUpdate: { action: 'update', title: '', description: 'A pier at dusk.', status: 'concluding' } }), ctx(1)).state;
    expect(first.chapters[0]).toMatchObject({ title: FIRST_CHAPTER_TITLE, premise: 'A pier at dusk.', status: 'active' });
    const second = applyPlan(first, round({ chapterUpdate: { action: 'start_new', title: '' } }), ctx(5)).state;
    expect(second.chapters[1]).toMatchObject({ id: 'chapter-2', title: 'Chapter 2' });
  });

  test('a new chapter is refused inside the first three turns of the current one, and otherwise closes the current one', () => {
    const first = applyPlan(stateOf(), round({ chapterUpdate: { action: 'start_new', title: 'One' } }), ctx(1)).state;
    const early = applyPlan(first, round({ chapterUpdate: { action: 'start_new', title: 'Two' } }), ctx(3));
    expect(early.state.chapters).toHaveLength(1);
    // Bunraku: a silent refusal that touched turnsElapsed; here a skipped entry.
    expect(early.skipped).toEqual([{ path: 'chapterUpdate', why: 'start_new refused: chapter 1 is 2 turns old (minimum 3)' }]);
    const late = applyPlan(first, round({ chapterUpdate: { action: 'start_new', title: 'Two', closingMoment: 'The pier empties.' } }), ctx(10)).state;
    expect(late.chapters.map((c) => [c.number, c.status])).toEqual([
      [1, 'complete'],
      [2, 'active'],
    ]);
    expect(late.chapters[0]!.closingMoment).toBe('The pier empties.');
    expect(late.currentChapterId).toBe(late.chapters[1]!.id);
  });

  test('CHAPTER_MIN_TURNS: three turns old is old enough; a concluding chapter may close at once (Bunraku)', () => {
    const first = applyPlan(stateOf(), round({ chapterUpdate: { action: 'start_new', title: 'One' } }), ctx(1)).state;
    expect(applyPlan(first, round({ chapterUpdate: { action: 'start_new', title: 'Two' } }), ctx(4)).state.chapters).toHaveLength(2);
    const concluding = applyPlan(first, round({ chapterUpdate: { action: 'update', title: 'One', status: 'concluding' } }), ctx(2)).state;
    const next = applyPlan(concluding, round({ chapterUpdate: { action: 'start_new', title: 'Two' } }), ctx(3));
    expect(next.skipped).toEqual([]);
    expect(next.state.chapters.map((c) => c.status)).toEqual(['complete', 'active']);
  });

  test('none and update each add a turn to the current chapter; update rewrites what it is given', () => {
    // No turnsElapsed any more (age = turn − createdAtTurn): only the rewrite is left to check.
    const first = applyPlan(stateOf(), round({ chapterUpdate: { action: 'start_new', title: 'One', tone: 'light', themes: ['trust'] } }), ctx(1)).state;
    const a = applyPlan(first, round(), ctx(2)).state;
    expect(a.chapters).toEqual(first.chapters);
    const b = applyPlan(a, round({ chapterUpdate: { action: 'update', title: 'Renamed', status: 'concluding', tone: 'dark', objectives: ['Escape'] } }), ctx(3)).state;
    expect(b.chapters[0]).toMatchObject({ title: 'One', status: 'concluding', tone: 'dark', themes: ['trust'], majorGoal: 'Escape', createdAtTurn: 1 });
  });

  test('an update with no current chapter is refused', () => {
    const dangling = stateOf({ chapters: [{ id: 'chapter-1', number: 1, title: 'One', premise: '', status: 'complete', themes: [], tone: '', majorGoal: '', createdAtTurn: 1 }] });
    expect(applyPlan(dangling, round({ chapterUpdate: { action: 'update', title: 'x', tone: 'dark' } }), ctx(5)).skipped).toEqual([
      { path: 'chapterUpdate', why: 'update refused: no current chapter' },
    ]);
  });
});

describe('arcs', () => {
  test("an update names an arc by id, by title or by enough of its words; an update counts a turn and keeps the arc's title", () => {
    // No turnsActive (rounds that touched the arc) any more.
    const base = stateOf({ arcs: [arcOf({ id: 'arc-1', title: "The Prince's Quest" })] });
    for (const arcId of ['arc-1', 'the princes quest', 'Quest of the Prince']) {
      const { state } = applyPlan(base, round({ arcUpdates: [{ arcId, title: 'Renamed!', description: 'Now moving.' }] }), ctx(5));
      expect(state.arcs).toHaveLength(1);
      expect(state.arcs[0]).toMatchObject({ title: "The Prince's Quest", description: 'Now moving.' });
    }
  });

  test('a title sent beside a matching selector is a rename, refused in skipped; the same title is not', () => {
    const base = stateOf({ arcs: [arcOf({ id: 'arc-1', title: "The Prince's Quest" })] });
    expect(applyPlan(base, round({ arcUpdates: [{ arcId: 'arc-1', title: 'Renamed!' }] }), ctx(5)).skipped).toEqual([
      { path: 'arcUpdates[0].title', why: `arcs are not renamed (kept "The Prince's Quest")` },
    ]);
    expect(applyPlan(base, round({ arcUpdates: [{ arcId: 'arc-1', title: 'the princes quest.' }] }), ctx(5)).skipped).toEqual([]);
    // The title is the selector when it alone names the arc (readPlan: arcId = arcId ?? id ?? title).
    expect(applyPlan(base, round({ arcUpdates: [{ arcId: 'Quest of the Prince', title: 'Quest of the Prince' }] }), ctx(5)).skipped).toEqual([]);
    // An unknown id falls back to the title.
    const byTitle = applyPlan(base, round({ arcUpdates: [{ arcId: 'arc-99', title: 'Quest of the Prince', status: 'climax' }] }), ctx(5));
    expect(byTitle.state.arcs).toHaveLength(1);
    expect(byTitle.state.arcs[0]?.status).toBe('climax');
    expect(byTitle.skipped).toEqual([]);
  });

  test('only real progress moves the progress turn: a description rewrite does not, a stage, a status change or a delivered beat does', () => {
    const base = stateOf({ arcs: [arcOf({ lastProgressTurn: 1, nextBeat: { description: 'x', plannedAtTurn: 1, status: 'pending' } })] });
    const at = (u: object) => applyPlan(base, round({ arcUpdates: [{ arcId: 'arc-1', ...u }] }), ctx(9)).state.arcs[0]!;
    expect(at({ description: 'again' }).lastProgressTurn).toBe(1);
    expect(at({ newStageTitle: 'A turn' }).lastProgressTurn).toBe(9);
    expect(at({ status: 'climax' }).lastProgressTurn).toBe(9);
    expect(at({ status: 'building' }).lastProgressTurn).toBe(1);
    expect(at({ priority: 'urgent', horizon: 'long', arcType: 'main' })).toMatchObject({ lastProgressTurn: 1, priority: 'urgent', horizon: 'long', arcType: 'main' });
    expect(at({ markNextBeatDelivered: true })).toMatchObject({ lastProgressTurn: 9, nextBeat: { status: 'delivered', deliveredAtTurn: 9 } });
  });

  test('a delivered beat that is not pending is refused in skipped', () => {
    const base = stateOf({ arcs: [arcOf({ nextBeat: { description: 'x', plannedAtTurn: 1, status: 'delivered', deliveredAtTurn: 2 } })] });
    const out = applyPlan(base, round({ arcUpdates: [{ arcId: 'arc-1', markNextBeatDelivered: true }] }), ctx(4));
    expect(out.state.arcs[0]?.nextBeat).toEqual({ description: 'x', plannedAtTurn: 1, status: 'delivered', deliveredAtTurn: 2 });
    expect(out.skipped).toEqual([{ path: 'arcUpdates[0].markNextBeatDelivered', why: 'no pending beat' }]);
  });

  test('a new beat replaces the old; a repeated stage title is not added twice; stages stop at twelve', () => {
    // Stages carry the turn now; the cap (6) is fitState's, so here they only grow.
    let state = stateOf({ arcs: [arcOf({})] });
    state = applyPlan(state, round({ arcUpdates: [{ arcId: 'arc-1', nextBeat: { description: 'The bell rings', targetTurn: 20 }, newStageTitle: 'Stage 0' }] }), ctx(2)).state;
    expect(state.arcs[0]!.nextBeat).toEqual({ description: 'The bell rings', plannedAtTurn: 2, targetTurn: 20, status: 'pending' });
    const again = applyPlan(state, round({ arcUpdates: [{ arcId: 'arc-1', newStageTitle: '  stage   0 ' }] }), ctx(3));
    state = again.state;
    expect(state.arcs[0]!.stages).toEqual([{ title: 'Stage 0', turn: 2 }]);
    expect(again.skipped).toEqual([{ path: 'arcUpdates[0].newStageTitle', why: 'same as the last stage' }]);
    for (let i = 1; i <= 8; i++) state = applyPlan(state, round({ arcUpdates: [{ arcId: 'arc-1', newStageTitle: `Stage ${i}` }] }), ctx(3 + i)).state;
    expect(state.arcs[0]!.stages).toHaveLength(9);
    expect(state.arcs[0]!.stages.at(-1)).toEqual({ title: 'Stage 8', turn: 11 });
    // Only the LAST stage counts: an older title may come back.
    state = applyPlan(state, round({ arcUpdates: [{ arcId: 'arc-1', newStageTitle: 'Stage 0' }] }), ctx(12)).state;
    expect(state.arcs[0]!.stages.at(-1)).toEqual({ title: 'Stage 0', turn: 12 });
  });

  test("an unknown arc is created with RoleCall's defaults, in the current chapter, with a forward-looking beat if given", () => {
    const chapter = applyPlan(stateOf(), round({ chapterUpdate: { action: 'start_new', title: 'One' } }), ctx(1)).state;
    const { state, skipped } = applyPlan(
      chapter,
      round({ arcUpdates: [{ arcId: 'x', title: 'The Lamp. Something about a very long description that should not be a title.', nextBeat: { description: 'A knock' }, newStageTitle: 'Found' }] }),
      ctx(4),
    );
    expect(state.arcs[0]!.id).toMatch(/^arc-/);
    // No scope (derived from arcType) and no turnsActive (derived age).
    expect(state.arcs[0]).toEqual({
      id: 'arc-1',
      title: 'The Lamp.',
      description: '',
      chapterId: state.currentChapterId,
      status: 'seeding',
      priority: 'background',
      arcType: 'side',
      horizon: 'medium',
      lastProgressTurn: 4,
      stages: [{ title: 'Found', turn: 4 }],
      nextBeat: { description: 'A knock', plannedAtTurn: 4, status: 'pending' },
      createdAtTurn: 4,
    });
    expect(skipped).toEqual([{ path: 'arcUpdates[0].title', why: 'cut to "The Lamp."' }]);
  });

  test('a new arc takes the given status, priority, type and horizon; an arc with only a selector is named by it', () => {
    const { state } = applyPlan(stateOf(), round({ arcUpdates: [{ arcId: 'The Heist', description: 'Rob the bank.', status: 'building', priority: 'urgent', arcType: 'main', horizon: 'short' }] }), ctx(2));
    expect(state.arcs[0]).toMatchObject({ title: 'The Heist', description: 'Rob the bank.', status: 'building', priority: 'urgent', arcType: 'main', horizon: 'short' });
    expect(state.arcs[0]?.chapterId).toBe(state.currentChapterId);
  });

  test('an unknown id with no title makes no arc', () => {
    const out = applyPlan(stateOf(), round({ arcUpdates: [{ arcId: 'arc-12', newStageTitle: 'x' }, { arcId: '[arc-3]', title: '  ' }] }), ctx(2));
    expect(out.state.arcs).toEqual([]);
    expect(out.skipped).toEqual([
      { path: 'arcUpdates[0]', why: 'no arc matches "arc-12" and it has no title for a new arc' },
      { path: 'arcUpdates[1]', why: 'no arc matches "[arc-3]" and it has no title for a new arc' },
    ]);
  });

  test('two updates of one new arc in a plan make one arc', () => {
    const { state } = applyPlan(stateOf(), round({ arcUpdates: [{ arcId: 'The Heist' }, { arcId: 'the heist', newStageTitle: 'Plan' }] }), ctx(2));
    expect(state.arcs).toHaveLength(1);
    expect(state.arcs[0]?.stages).toEqual([{ title: 'Plan', turn: 2 }]);
  });

  test('a removed arc is not matched again, and a collection at its cap refuses a new item rather than grow', () => {
    // Plans do not remove arcs (no soft delete); the cap counts LIVE arcs (D-61: 24) and a refusal is skipped.
    const full = stateOf({ arcs: Array.from({ length: STATE_LIMITS.liveArcs }, (_, i) => arcOf({ id: `a${i}`, title: `Arc number ${i}` })) });
    const out = applyPlan(full, round({ arcUpdates: [{ arcId: 'z', title: 'Zeta' }] }), ctx(5));
    expect(out.state.arcs).toHaveLength(STATE_LIMITS.liveArcs);
    expect(out.skipped).toEqual([{ path: 'arcUpdates[0]', why: `new arc "Zeta" refused: ${STATE_LIMITS.liveArcs} live arcs is the limit` }]);
    // An update of a known arc still goes through, and finished arcs do not count.
    expect(applyPlan(full, round({ arcUpdates: [{ arcId: 'a3', status: 'climax' }] }), ctx(5)).skipped).toEqual([]);
    const finishedOne = structuredClone(full);
    finishedOne.arcs[0]!.status = 'complete';
    expect(applyPlan(finishedOne, round({ arcUpdates: [{ arcId: 'z', title: 'Zeta' }] }), ctx(5)).state.arcs).toHaveLength(STATE_LIMITS.liveArcs + 1);
  });

  test('a finished arc is still matched by its title (Bunraku): the update lands on it', () => {
    const base = stateOf({ arcs: [arcOf({ title: 'The Heist', status: 'complete' })] });
    const { state } = applyPlan(base, round({ arcUpdates: [{ arcId: 'The Heist', status: 'building' }] }), ctx(30));
    expect(state.arcs).toHaveLength(1);
    expect(state.arcs[0]).toMatchObject({ status: 'building', lastProgressTurn: 30 });
  });

  test('an empty beat is refused; a new arc has no beat to deliver', () => {
    const out = applyPlan(stateOf(), round({ arcUpdates: [{ arcId: 'The Heist', nextBeat: { description: ' ' }, markNextBeatDelivered: true }] }), ctx(2));
    expect(out.state.arcs[0]?.nextBeat).toBeUndefined();
    expect(out.skipped).toEqual([
      { path: 'arcUpdates[0].nextBeat', why: 'empty description' },
      { path: 'arcUpdates[0].markNextBeatDelivered', why: 'a new arc has no beat to deliver' },
    ]);
  });
});

describe('seeds', () => {
  test('planting makes a seed; planting its title again updates it; every pending seed ages a turn', () => {
    // Ages are derived (turn − plantedAtTurn), not counted; a re-plant keeps plantedAtTurn.
    // Changed (D-123): relatedArcId must name an arc of the state, so the base holds arc-1.
    let state = applyPlan(stateOf({ arcs: [arcOf()], nextId: 2 }), round({ seedUpdates: [{ title: 'A cracked bell', action: 'plant', description: 'It rings at the end.', payoffHorizon: 'long', relatedArcId: 'arc-1' }] }), ctx(2)).state;
    expect(state.seeds[0]!.id).toMatch(/^seed-/);
    expect(state.seeds[0]).toEqual({
      id: 'seed-2',
      hint: 'A cracked bell',
      payoff: 'It rings at the end.',
      scope: 'player',
      plantedAtTurn: 2,
      payoffHorizon: 'long',
      payoffDelivered: false,
      relatedArcId: 'arc-1',
      reinforcements: [],
    });
    expect(state.lastPlantTurn).toBe(2);
    state = applyPlan(state, round({ seedUpdates: [{ title: 'a cracked BELL', action: 'plant', description: 'It rings once.', scope: 'world' }] }), ctx(3)).state;
    expect(state.seeds).toHaveLength(1);
    expect(state.seeds[0]).toMatchObject({ payoff: 'It rings once.', scope: 'world', plantedAtTurn: 2 });
    expect(ageOf(state.seeds[0]!.plantedAtTurn, state.turn)).toBe(1);
    // A re-plant is not a new plant: lastPlantTurn stays.
    expect(state.lastPlantTurn).toBe(2);
  });

  test('a seed planted with no horizon is medium', () => {
    expect(applyPlan(stateOf(), round({ seedUpdates: [{ title: 'Bell', action: 'plant' }] }), ctx(1)).state.seeds[0]).toMatchObject({ payoffHorizon: 'medium', payoff: '' });
  });

  test('reinforce and resolve need an existing seed; an unknown id is skipped, a title is never a fallback for a wrong id', () => {
    const base = stateOf({ seeds: [seedOf({ id: 'seed-1', hint: 'Bell' }), seedOf({ id: 'seed-2', hint: 'Key' })] });
    const out = applyPlan(
      base,
      round({
        seedUpdates: [
          { title: 'Bell', action: 'reinforce', reinforcement: 'Heard in the fog.' },
          { title: 'Key', action: 'resolve', outcome: 'Opened the vault.' },
          { id: 'seed-404', title: 'Bell', action: 'resolve' },
          { title: 'Ghost', action: 'reinforce', reinforcement: 'x' },
        ],
      }),
      ctx(8),
    );
    // Reinforcements keep only the turn (D-61): the text is not stored.
    expect(out.state.seeds.find((s) => s.id === 'seed-1')).toMatchObject({ reinforcements: [{ turn: 8 }], payoffDelivered: false });
    expect(out.state.seeds.find((s) => s.id === 'seed-2')).toMatchObject({ payoffDelivered: true, payoffTurn: 8, payoff: 'Opened the vault.' });
    expect(out.state.seeds).toHaveLength(2);
    expect(out.skipped).toEqual([
      { path: 'seedUpdates[2]', why: 'no seed has id "seed-404"' },
      { path: 'seedUpdates[3]', why: 'reinforce refused: no seed "Ghost"' },
    ]);
  });

  test('a seed named by id is found in any case; reinforce fills an empty payoff only', () => {
    const base = stateOf({ seeds: [seedOf({ id: 'seed-1', hint: 'Bell', payoff: '' })] });
    const out = applyPlan(base, round({ seedUpdates: [{ id: 'SEED-1', title: 'whatever', action: 'reinforce', description: 'It cracks further.' }] }), ctx(4)).state;
    expect(out.seeds[0]).toMatchObject({ payoff: 'It cracks further.', reinforcements: [{ turn: 4 }] });
    const kept = applyPlan(stateOf({ seeds: [seedOf()] }), round({ seedUpdates: [{ id: 'seed-1', title: '', action: 'reinforce', description: 'Other.' }] }), ctx(4)).state;
    expect(kept.seeds[0]?.payoff).toBe('It rings at the finale.');
  });

  test('a reinforcement counts once per turn; the list is capped later (fitState)', () => {
    const base = stateOf({ seeds: [seedOf({ reinforcements: [{ turn: 2 }, { turn: 3 }, { turn: 4 }, { turn: 5 }] })] });
    const out = applyPlan(base, round({ seedUpdates: [{ title: 'A cracked bell', action: 'reinforce' }, { id: 'seed-1', title: '', action: 'reinforce' }] }), ctx(6));
    expect(out.state.seeds[0]?.reinforcements.map((r) => r.turn)).toEqual([2, 3, 4, 5, 6]);
    expect(out.skipped).toEqual([{ path: 'seedUpdates[1]', why: 'already reinforced this turn' }]);
  });

  test('delete is soft: the seed stays in the state, marked removed, and a delivered seed stops aging', () => {
    // Changed: delete removes the seed (no soft delete, no counters to stop).
    const base = stateOf({ seeds: [seedOf({ id: 'seed-1' }), seedOf({ id: 'seed-2', hint: 'Done', payoffDelivered: true, payoffTurn: 4 })] });
    const out = applyPlan(base, round({ seedUpdates: [{ title: 'A cracked bell', action: 'delete' }, { title: 'Nothing', action: 'delete' }] }), ctx(8));
    expect(out.state.seeds.map((s) => s.id)).toEqual(['seed-2']);
    expect(out.skipped).toEqual([{ path: 'seedUpdates[1]', why: 'delete refused: no seed "Nothing"' }]);
  });

  test('a new seed over the live cap is refused; paid seeds do not count', () => {
    const seeds = Array.from({ length: STATE_LIMITS.liveSeeds }, (_, i) => seedOf({ id: `seed-${i + 1}`, hint: `Hint ${i}` }));
    const full = stateOf({ seeds, nextId: 100 });
    const out = applyPlan(full, round({ seedUpdates: [{ title: 'One more', action: 'plant' }] }), ctx(9));
    expect(out.state.seeds).toHaveLength(STATE_LIMITS.liveSeeds);
    expect(out.state.lastPlantTurn).toBeUndefined();
    expect(out.skipped).toEqual([{ path: 'seedUpdates[0]', why: `new seed refused: ${STATE_LIMITS.liveSeeds} pending seeds is the limit` }]);
    const paid = structuredClone(full);
    paid.seeds[0]!.payoffDelivered = true;
    expect(applyPlan(paid, round({ seedUpdates: [{ title: 'One more', action: 'plant' }] }), ctx(9)).state.seeds).toHaveLength(STATE_LIMITS.liveSeeds + 1);
  });

  test("D-123: relatedArcId is matched like an arc selector and stored as the arc's id", () => {
    const base = stateOf({ arcs: [arcOf({ id: 'arc-1', title: 'The Lighthouse' }), arcOf({ id: 'arc-2', title: 'Долг перед гильдией' })], nextId: 3 });
    const longForm = 'The slow unraveling of the Ashford family secret about the fire at the old mill (arc-1)';
    expect(longForm.length).toBeGreaterThan(STATE_LIMITS.arcTitle);
    for (const [sent, id] of [
      ['arc-2', 'arc-2'],
      ['ARC-1', 'arc-1'],
      ['[arc-1] The Lighthouse', 'arc-1'],
      ['arc-2: Долг', 'arc-2'],
      ['the lighthouse', 'arc-1'],
      ['долга перед гильдией', 'arc-2'],
      [longForm, 'arc-1'],
    ] as const) {
      const out = applyPlan(base, round({ seedUpdates: [{ title: 'A scorched ring', action: 'plant', relatedArcId: sent }] }), ctx(4));
      expect(out.state.seeds[0]?.relatedArcId).toBe(id);
      expect(out.skipped).toEqual([]);
    }
  });

  test('D-123: an unknown relatedArcId is dropped and skipped; "none" and blanks are absent; a known seed keeps its arc', () => {
    const base = stateOf({ arcs: [arcOf({ id: 'arc-1', title: 'The Lighthouse' })], seeds: [seedOf({ id: 'seed-2', hint: 'Bell', relatedArcId: 'arc-1' })], nextId: 3 });
    const longUnknown = 'An arc nobody planned, about a scorched ring and a debt to the guild that will be paid in full';
    const out = applyPlan(
      base,
      round({
        seedUpdates: [
          { title: 'A scorched ring', action: 'plant', relatedArcId: longUnknown },
          { title: 'Bell', action: 'reinforce', relatedArcId: 'arc-404' },
          { title: 'Key', action: 'plant', relatedArcId: 'none' },
          { title: 'Coin', action: 'plant', relatedArcId: '  ' },
          { title: 'Bell', action: 'plant', relatedArcId: 'N/A' },
        ],
      }),
      ctx(5),
    );
    expect(out.state.seeds.map((x) => [x.hint, x.relatedArcId])).toEqual([
      ['Bell', 'arc-1'],
      ['A scorched ring', undefined],
      ['Key', undefined],
      ['Coin', undefined],
    ]);
    expect(out.skipped).toEqual([
      { path: 'seedUpdates[0].relatedArcId', why: `no arc matches "${longUnknown.slice(0, 60)}…"` },
      { path: 'seedUpdates[1].relatedArcId', why: 'no arc matches "arc-404"' },
    ]);
  });

  test('D-123: a seed may name an arc made earlier in the same plan', () => {
    const out = applyPlan(
      stateOf(),
      round({ arcUpdates: [{ arcId: 'Маяк', title: 'Маяк' }], seedUpdates: [{ title: 'Огонь на башне', action: 'plant', relatedArcId: '[arc-1] Маяк' }] }),
      ctx(1),
    );
    expect(out.state.arcs.map((a) => a.id)).toEqual(['arc-1']);
    expect(out.state.seeds[0]).toMatchObject({ id: 'seed-2', relatedArcId: 'arc-1' });
  });

  test('a new seed needs a title', () => {
    expect(applyPlan(stateOf(), round({ seedUpdates: [{ title: '  ', action: 'plant' }] }), ctx(1)).skipped).toEqual([{ path: 'seedUpdates[0]', why: 'a new seed needs a title' }]);
  });
});

describe('seed aging (RoleCall seed-aging.test.ts: ages are derived from plantedAtTurn)', () => {
  test('reports a seed planted this turn as brand new, not as old as the chat', () => {
    const { state } = applyPlan(stateOf({ turn: 399 }), round({ seedUpdates: [{ title: 'The raven watches', action: 'plant' }] }), ctx(400));
    expect(state.seeds[0]?.plantedAtTurn).toBe(400);
    expect(ageOf(state.seeds[0]!.plantedAtTurn, state.turn)).toBe(0);
  });

  test('ages a seed by the turns actually elapsed since planting', () => {
    let state = applyPlan(stateOf({ turn: 394 }), round({ seedUpdates: [{ title: 'The raven watches', action: 'plant' }] }), ctx(395)).state;
    // Turns with and without a word on the seed (and a turn the caller skipped) all count.
    state = applyPlan(state, round({ seedUpdates: [{ title: 'The raven watches', action: 'reinforce' }] }), ctx(397)).state;
    state = applyPlan(state, round({ seedUpdates: [{ title: 'the raven WATCHES', action: 'plant', description: 'A spy.' }] }), ctx(400)).state;
    expect(state.seeds[0]).toMatchObject({ plantedAtTurn: 395, reinforcements: [{ turn: 397 }], payoff: 'A spy.' });
    expect(ageOf(state.seeds[0]!.plantedAtTurn, state.turn)).toBe(5);
  });

  test('clamps to zero when a rebase moves the current turn behind the plant turn', () => {
    expect(ageOf(400, 120)).toBe(0);
  });
});

describe('hidden arcs', () => {
  test('add creates; a second add of the same title updates it; update upserts and records a clue once; stages and clues are capped at twelve', () => {
    // expectedSurfaceTurn is derived (createdAtTurn + SURFACE_TURNS), plannedBeats are gone, the caps are fitState's.
    let state = applyPlan(stateOf(), round({ invisibleArcUpdates: [{ title: 'Cabal', action: 'add', horizon: 'short' }] }), ctx(2)).state;
    expect(state.invisibleArcs[0]!.id).toMatch(/^hidden-/);
    expect(state.invisibleArcs[0]).toEqual({
      id: 'hidden-1',
      title: 'Cabal',
      description: 'Cabal',
      arcType: 'background',
      horizon: 'short',
      scope: 'world',
      status: 'seeding',
      stages: [],
      playerClues: [],
      createdAtTurn: 2,
    });
    state = applyPlan(state, round({ invisibleArcUpdates: [{ title: 'cabal', action: 'add', description: 'Now known.' }] }), ctx(3)).state;
    expect(state.invisibleArcs).toHaveLength(1);
    expect(state.invisibleArcs[0]).toMatchObject({ description: 'Now known.', createdAtTurn: 2 });
    for (let i = 0; i < 9; i++)
      state = applyPlan(state, round({ invisibleArcUpdates: [{ title: 'Cabal', action: 'update', newClue: i % 2 ? 'same clue' : `clue ${i}`, newStageTitle: `step ${i}` }] }), ctx(4 + i)).state;
    expect(state.invisibleArcs[0]!.playerClues.filter((c) => c.clue === 'same clue')).toEqual([{ turn: 5, clue: 'same clue' }]);
    expect(state.invisibleArcs[0]!.playerClues).toHaveLength(6);
    expect(state.invisibleArcs[0]!.stages).toHaveLength(9);
    expect(state.invisibleArcs[0]!.stages.at(-1)).toEqual({ title: 'step 8', turn: 12 });
    const upsert = applyPlan(stateOf(), round({ invisibleArcUpdates: [{ title: 'Fresh', action: 'update', status: 'building', newClue: 'A smell of smoke' }] }), ctx(2)).state;
    expect(upsert.invisibleArcs[0]).toMatchObject({ status: 'building', playerClues: [{ turn: 2, clue: 'A smell of smoke' }] });
  });

  test('a repeated clue (any case) and a repeated last stage are skipped', () => {
    const base = stateOf({ invisibleArcs: [hiddenOf({ playerClues: [{ turn: 1, clue: 'Ink on the cuff' }], stages: [{ title: 'Ledger found', turn: 1 }] })] });
    const out = applyPlan(base, round({ invisibleArcUpdates: [{ title: 'The Ledger Conspiracy', action: 'update', newClue: 'INK ON THE CUFF ', newStageTitle: 'ledger found' }] }), ctx(3));
    expect(out.state.invisibleArcs).toEqual(base.invisibleArcs);
    expect(out.skipped).toEqual([
      { path: 'invisibleArcUpdates[0].newClue', why: 'clue already recorded' },
      { path: 'invisibleArcUpdates[0].newStageTitle', why: 'same as the last stage' },
    ]);
  });

  test('add on a known arc records no clue or stage, a scope is set once, an add starts as seeding (all as Bunraku, now in skipped)', () => {
    const base = stateOf({ invisibleArcs: [hiddenOf()] });
    const out = applyPlan(base, round({ invisibleArcUpdates: [{ title: 'The Ledger Conspiracy', action: 'add', newClue: 'c', newStageTitle: 's', scope: 'player', status: 'approaching_player' }] }), ctx(3));
    expect(out.state.invisibleArcs[0]).toMatchObject({ status: 'approaching_player', scope: 'world', playerClues: [], stages: [] });
    expect(out.skipped).toEqual([
      { path: 'invisibleArcUpdates[0].scope', why: 'scope is set when the arc is made' },
      { path: 'invisibleArcUpdates[0].newClue', why: 'clues are recorded by update, not add' },
      { path: 'invisibleArcUpdates[0].newStageTitle', why: 'stages are recorded by update, not add' },
    ]);
    const fresh = applyPlan(stateOf(), round({ invisibleArcUpdates: [{ title: 'Cabal', action: 'add', status: 'building', newClue: 'c', newStageTitle: 'Met', scope: 'player', surfaceCondition: 'When the bell rings' }] }), ctx(3));
    expect(fresh.state.invisibleArcs[0]).toMatchObject({ status: 'seeding', scope: 'player', playerClues: [], stages: [{ title: 'Met', turn: 3 }], surfaceCondition: 'When the bell rings' });
    expect(fresh.skipped).toEqual([
      { path: 'invisibleArcUpdates[0].status', why: 'a hidden arc made by add starts as seeding' },
      { path: 'invisibleArcUpdates[0].newClue', why: 'clues are recorded by update, not add' },
    ]);
  });

  test('a hidden arc is named by arcId, by a title that is its id, or by its match key', () => {
    const base = stateOf({ invisibleArcs: [hiddenOf({ id: 'hidden-4', title: "The Prince's Cabal" })] });
    for (const u of [
      { title: 'Something else', arcId: 'hidden-4' },
      { title: 'HIDDEN-4' },
      { title: 'the princes cabal' },
    ]) {
      const out = applyPlan(base, round({ invisibleArcUpdates: [{ ...u, action: 'surface' }] }), ctx(3));
      expect(out.state.invisibleArcs.map((a) => [a.id, a.title, a.status])).toEqual([['hidden-4', "The Prince's Cabal", 'visible']]);
    }
  });

  test('D-123: a title or arcId that echoes the prompt\'s id names that hidden arc; no duplicate is made', () => {
    const base = stateOf({ invisibleArcs: [hiddenOf({ id: 'hidden-1', title: 'The Guild' }), hiddenOf({ id: 'hidden-2', title: 'Заговор гильдии' })], nextId: 3 });
    for (const sent of ['[hidden-1] The Guild', 'hidden-1: The Guild', '(hidden-1) "The Guild"', '[hidden-1] "The Guild"', 'The Guild (hidden-1)', '[HIDDEN-1]']) {
      const out = applyPlan(base, round({ invisibleArcUpdates: [{ title: sent, action: 'update', newClue: 'a coin' }] }), ctx(4));
      expect(out.state.invisibleArcs.map((a) => [a.id, a.title, a.playerClues.length])).toEqual([
        ['hidden-1', 'The Guild', 1],
        ['hidden-2', 'Заговор гильдии', 0],
      ]);
      expect(out.skipped).toEqual([]);
      expect(applyPlan(base, round({ invisibleArcUpdates: [{ title: sent, action: 'surface' }] }), ctx(4)).state.invisibleArcs[0]?.status).toBe('visible');
    }
    // An echoed id that does not exist: the cleaned title still finds the arc.
    const byTitle = applyPlan(base, round({ invisibleArcUpdates: [{ title: '[hidden-9] «Заговор гильдии»', action: 'resolve' }] }), ctx(4));
    expect(byTitle.state.invisibleArcs.map((a) => a.status)).toEqual(['building', 'resolved']);
    // The echoed id wins over the title (D-123: "that id when it exists").
    const byEcho = applyPlan(base, round({ invisibleArcUpdates: [{ title: 'hidden-2: The Guild', action: 'surface' }] }), ctx(4));
    expect(byEcho.state.invisibleArcs.map((a) => a.status)).toEqual(['building', 'visible']);
  });

  test('D-123: a new hidden arc\'s title is cleaned: echoes, the prompt\'s quotes, a description after the title', () => {
    const out = applyPlan(
      stateOf({ nextId: 5 }),
      round({
        invisibleArcUpdates: [
          { title: '(hidden-9) "The Cabal"', action: 'add' },
          { title: '[hidden-10] «Тайная гильдия»', action: 'add' },
          { title: 'The Watchers: they follow the keeper everywhere', action: 'add' },
          { title: '[hidden-11]', action: 'add' },
          { title: 'the cabal', action: 'update', newClue: 'a mask' },
        ],
      }),
      ctx(3),
    );
    expect(out.state.invisibleArcs.map((a) => [a.id, a.title, a.description, a.playerClues.length])).toEqual([
      ['hidden-5', 'The Cabal', 'The Cabal', 1],
      ['hidden-6', 'Тайная гильдия', 'Тайная гильдия', 0],
      ['hidden-7', 'The Watchers', 'The Watchers', 0],
    ]);
    expect(out.skipped).toEqual([
      { path: 'invisibleArcUpdates[0].title', why: 'cut to "The Cabal"' },
      { path: 'invisibleArcUpdates[1].title', why: 'cut to "Тайная гильдия"' },
      { path: 'invisibleArcUpdates[2].title', why: 'cut to "The Watchers"' },
      { path: 'invisibleArcUpdates[3]', why: 'a new hidden arc needs a title' },
    ]);
  });

  test('surface, resolve and delete act only on an existing arc; delete is soft; an arc that is visible or resolved stops aging', () => {
    // Changed: delete removes; no aging counters.
    const base = stateOf({ invisibleArcs: [hiddenOf({ id: 'h1', title: 'One' }), hiddenOf({ id: 'h2', title: 'Two' }), hiddenOf({ id: 'h3', title: 'Three' })] });
    const out = applyPlan(
      base,
      round({ invisibleArcUpdates: [{ title: 'One', action: 'surface' }, { title: 'Two', action: 'resolve' }, { title: 'Three', action: 'delete' }, { title: 'Ghost', action: 'surface' }] }),
      ctx(6),
    );
    expect(out.state.invisibleArcs.map((a) => [a.id, a.status])).toEqual([
      ['h1', 'visible'],
      ['h2', 'resolved'],
    ]);
    expect(out.skipped).toEqual([{ path: 'invisibleArcUpdates[3]', why: 'surface refused: no hidden arc "Ghost"' }]);
  });

  test('a new hidden arc over the live cap is refused; visible and resolved ones do not count', () => {
    const many = Array.from({ length: STATE_LIMITS.liveHidden }, (_, i) => hiddenOf({ id: `h${i}`, title: `Plot ${i}` }));
    const full = stateOf({ invisibleArcs: many });
    const out = applyPlan(full, round({ invisibleArcUpdates: [{ title: 'Cabal', action: 'add' }] }), ctx(4));
    expect(out.state.invisibleArcs).toHaveLength(STATE_LIMITS.liveHidden);
    expect(out.skipped).toEqual([{ path: 'invisibleArcUpdates[0]', why: `new hidden arc "Cabal" refused: ${STATE_LIMITS.liveHidden} live hidden arcs is the limit` }]);
    const surfaced = structuredClone(full);
    surfaced.invisibleArcs[0]!.status = 'visible';
    expect(applyPlan(surfaced, round({ invisibleArcUpdates: [{ title: 'Cabal', action: 'add' }] }), ctx(4)).state.invisibleArcs).toHaveLength(STATE_LIMITS.liveHidden + 1);
  });
});

describe('Russian stories [D-108, D-109]', () => {
  test('the same Cyrillic arc in another case form is updated, not duplicated', () => {
    const base = stateOf({ arcs: [arcOf({ id: 'arc-1', title: 'Тайна маяка', lastProgressTurn: 1 })] });
    const { state, skipped } = applyPlan(base, round({ arcUpdates: [{ arcId: 'тайну маяка', newStageTitle: 'Смотритель лжёт' }] }), ctx(4));
    expect(state.arcs).toHaveLength(1);
    expect(state.arcs[0]).toMatchObject({ title: 'Тайна маяка', stages: [{ title: 'Смотритель лжёт', turn: 4 }], lastProgressTurn: 4 });
    expect(skipped).toEqual([]);
  });

  test('two different Cyrillic arcs stay two (Bunraku merged every Cyrillic title into the first)', () => {
    let state = applyPlan(stateOf(), round({ arcUpdates: [{ arcId: 'Тайна старой башни' }] }), ctx(1)).state;
    state = applyPlan(state, round({ arcUpdates: [{ arcId: 'Новая угроза с севера' }, { arcId: 'Долг перед гильдией' }] }), ctx(2)).state;
    expect(state.arcs.map((a) => [a.id, a.title])).toEqual([
      ['arc-1', 'Тайна старой башни'],
      ['arc-2', 'Новая угроза с севера'],
      ['arc-3', 'Долг перед гильдией'],
    ]);
    // A shared word is not enough; a plural with two shared stems is.
    state = applyPlan(state, round({ arcUpdates: [{ arcId: 'Тайна маяка' }, { arcId: 'Тайны старых башен', status: 'climax' }] }), ctx(3)).state;
    expect(state.arcs.map((a) => [a.title, a.status])).toEqual([
      ['Тайна старой башни', 'climax'],
      ['Новая угроза с севера', 'seeding'],
      ['Долг перед гильдией', 'seeding'],
      ['Тайна маяка', 'seeding'],
    ]);
  });

  test('the documented false merge: «Миру грозит война» lands on «Мира и война»', () => {
    const base = stateOf({ arcs: [arcOf({ id: 'arc-1', title: 'Мира и война' })] });
    const out = applyPlan(base, round({ arcUpdates: [{ arcId: 'Миру грозит война', description: 'Мир на грани.' }] }), ctx(5));
    expect(out.state.arcs).toHaveLength(1);
    expect(out.state.arcs[0]).toMatchObject({ title: 'Мира и война', description: 'Мир на грани.' });
  });

  test('stages, seed hints and clues compare folded (case, ё)', () => {
    const base = stateOf({
      arcs: [arcOf({ title: 'Сердце Маруси', stages: [{ title: 'Встреча с Алёной', turn: 2 }] })],
      seeds: [seedOf({ hint: 'Треснувший колокол' })],
      invisibleArcs: [hiddenOf({ title: 'Заговор гильдии', playerClues: [{ turn: 2, clue: 'Чернила на манжете' }] })],
    });
    const out = applyPlan(
      base,
      round({
        arcUpdates: [{ arcId: 'arc-1', newStageTitle: 'ВСТРЕЧА с аленой' }],
        seedUpdates: [{ title: 'треснувший КОЛОКОЛ', action: 'reinforce' }],
        invisibleArcUpdates: [{ title: 'заговора гильдии', action: 'update', newClue: 'чернила НА манжете' }],
      }),
      ctx(6),
    );
    expect(out.state.arcs[0]?.stages).toHaveLength(1);
    expect(out.state.seeds[0]?.reinforcements).toEqual([{ turn: 6 }]);
    expect(out.state.invisibleArcs[0]?.playerClues).toHaveLength(1);
    expect(out.skipped).toEqual([
      { path: 'arcUpdates[0].newStageTitle', why: 'same as the last stage' },
      { path: 'invisibleArcUpdates[0].newClue', why: 'clue already recorded' },
    ]);
  });

  test('rhythm with Russian moods: бой is action, тишина is quiet', () => {
    let state = applyPlan(stateOf(), round({ directive: { mood: 'бой', pacing: 'fast' } }), ctx(3)).state;
    expect(state.pacing).toEqual({ currentMood: 'бой', turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 3, lastQuietMoment: 0 } });
    state = applyPlan(state, round({ directive: { mood: 'Напряжённый бой', pacing: 'fast' } }), ctx(4)).state;
    expect(state.pacing).toEqual({ currentMood: 'Напряжённый бой', turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 4, lastQuietMoment: 0 } });
    state = applyPlan(state, round({ directive: { mood: 'тишина', pacing: 'slow' } }), ctx(5)).state;
    expect(state.pacing.rhythm).toEqual({ lastActionSequence: 4, lastQuietMoment: 5 });
    state = applyPlan(state, round({ directive: { mood: 'Тишина.', pacing: 'slow' } }), ctx(6)).state;
    expect(state.pacing).toEqual({ currentMood: 'Тишина.', turnsAtCurrentMood: 2, rhythm: { lastActionSequence: 4, lastQuietMoment: 6 } });
    state = applyPlan(state, round({ directive: { mood: 'тихий вечер', pacing: 'slow' } }), ctx(7)).state;
    expect(state.pacing).toEqual({ currentMood: 'тихий вечер', turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 4, lastQuietMoment: 7 } });
  });

  test('the same Russian mood in another form counts on: «напряжённо» = «напряжённый»', () => {
    let state = applyPlan(stateOf(), round({ directive: { mood: 'напряжённо', pacing: 'medium' } }), ctx(1)).state;
    state = applyPlan(state, round({ directive: { mood: 'Напряжённый', pacing: 'medium' } }), ctx(2)).state;
    expect(state.pacing.turnsAtCurrentMood).toBe(2);
    expect(state.pacing.rhythm).toEqual({ lastActionSequence: 0, lastQuietMoment: 0 });
  });
});

describe('sameMood and pacingAfter', () => {
  test('moods compare by their words: order, case, punctuation and function words ignored', () => {
    expect(sameMood('tense, watchful', 'Watchful and tense')).toBe(true);
    expect(sameMood('тихо и спокойно', 'Спокойно, тихо')).toBe(true);
    expect(sameMood('tense', 'tense, watchful')).toBe(false);
    expect(sameMood('—', '—')).toBe(true);
    expect(sameMood('—', '…')).toBe(false);
  });

  test('pacingAfter does not change its input', () => {
    const prev = { currentMood: 'calm', turnsAtCurrentMood: 3, rhythm: { lastActionSequence: 1, lastQuietMoment: 2 } };
    const frozen = structuredClone(prev);
    const next = pacingAfter(prev, 'battle', 9);
    expect(prev).toEqual(frozen);
    expect(next).toEqual({ currentMood: 'battle', turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 9, lastQuietMoment: 2 } });
    expect(pacingAfter(prev, undefined, 9)).toEqual({ currentMood: 'calm', turnsAtCurrentMood: 4, rhythm: { lastActionSequence: 1, lastQuietMoment: 2 } });
  });
});
