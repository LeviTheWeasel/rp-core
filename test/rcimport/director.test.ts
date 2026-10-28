// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The RoleCall story import's Director part (D-190): agents/director/import-rc.ts. Synthetic
// dm-contexts only (D-194): a clean one mapped field by field, malformed rows (bare strings, strings
// spread into {"0": …} objects, the legacy hidden-arc shape, planned and shared-id chapters), the
// derived turn stamps, the dropped parts (one warning each), a 1 MB context held to 32 KB, a person's
// hidden arcs over the cap, the two records and how the fold and a swipe read them, the setting.
import { describe, expect, test } from 'bun:test';
import { reusedRecord } from '../../src/agents/director/call.ts';
import { directorRecordsFor, directorSettingsFor, dmContextToState } from '../../src/agents/director/import-rc.ts';
import { checkRecord, checkState, directorAt, stateBytes } from '../../src/agents/director/state.ts';
import { REDUCER_VERSION, STATE_LIMITS, type DirectorState } from '../../src/agents/director/types.ts';
import type { EntryInput, MsgEntry } from '../../src/session/entries.ts';
import { planStoryImport } from '../../src/formats/rolecall-import.ts';
import { parseStory } from '../../src/formats/rolecall-story.ts';
import { buildTree } from '../../src/session/tree.ts';
import { ru } from '../director/fixtures-state.ts';
import { msg, seqd } from '../session/fixtures.ts';
import { buildStory } from './kit.ts';

type Obj = Record<string, unknown>;

const T0 = '2026-01-01T00:00:00.000Z';
const spread = (s: string): Obj => ({ ...s.split('') });

const rcChapter = (over: Obj = {}): Obj => ({
  id: 'chapter_1',
  number: 1,
  title: 'Arrival',
  premise: 'The caravan reaches the sea town.',
  status: 'complete',
  themes: ['trust'],
  tone: 'uneasy',
  arcIds: ['the_locked_room'],
  majorGoal: 'Find the keeper.',
  emotionalJourney: 'wary to curious',
  estimatedTurns: { minimum: 20, target: 50, maximum: 100 },
  turnsElapsed: 5,
  closingMoment: 'The lamp went dark.',
  createdAtTurn: 1,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const rcArc = (over: Obj = {}): Obj => ({
  id: 'the_locked_room',
  title: 'The Locked Room',
  description: 'A door nobody opens.',
  chapterId: 'chapter_1',
  status: 'complete',
  priority: 'background',
  arcType: 'mystery',
  horizon: 'short',
  scope: 'player',
  turnsActive: 4,
  plannedBeats: [],
  completedBeats: [],
  involvedCharacters: [],
  plantedSeeds: [],
  stages: [
    { title: 'The key is found', turn: 0, timestamp: T0 },
    { title: 'The door opens', description: 'Dust and letters.', turn: 2, timestamp: T0 },
  ],
  setupsWithoutPayoff: 0,
  lastProgressTurn: 5,
  rigidity: 'loose',
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const rcSeed = (over: Obj = {}): Obj => ({
  id: 'A cracked bell',
  hint: 'A cracked bell',
  payoff: 'It rings at the finale.',
  scope: 'world',
  plantedAtTurn: 2,
  payoffHorizon: 'long',
  payoffDelivered: false,
  relatedArcId: 'the_keepers_letter',
  reinforcements: [
    { turn: 4, description: 'The bell hums in the wind.' },
    { turn: 8, description: 'A child asks about the bell.' },
  ],
  estimatedPayoffTurn: 12,
  ...over,
});

const rcHidden = (over: Obj = {}): Obj => ({
  id: 'iarc_4_0',
  title: 'The Guild Ledger',
  description: 'Someone is cooking the books.',
  arcType: 'conspiracy',
  horizon: 'long',
  scope: 'world',
  status: 'building',
  turnsActive: 6,
  plannedBeats: [],
  stages: [{ title: 'A missing page', turn: 5, timestamp: T0 }],
  surfaceCondition: 'When the player visits the harbour office.',
  expectedSurfaceTurn: 14,
  relatedVisibleArcs: [],
  foreshadowingSeeds: [],
  playerClues: [{ turn: 7, clue: 'A clerk avoids the question.' }],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

/** A dm-context at turn 10 with one of everything the core keeps, in RoleCall's shape. */
function cleanContext(): Obj {
  return {
    sessionId: 'chat-1',
    chapters: [
      rcChapter(),
      rcChapter({
        id: 'chapter_2',
        number: 2,
        title: 'The Lighthouse',
        premise: 'Someone lights the lamp at night.',
        status: 'active',
        themes: ['secrets', 'debt'],
        tone: 'tense',
        arcIds: [],
        majorGoal: 'Learn who climbs the tower.',
        emotionalJourney: '',
        turnsElapsed: 4,
        closingMoment: undefined,
        createdAtTurn: 6,
      }),
    ],
    currentChapterId: 'chapter_2',
    activeArcs: [
      rcArc(),
      rcArc({
        id: 'the_keepers_letter',
        title: "The Keeper's Letter",
        description: 'The keeper hides a letter from his sister.',
        chapterId: 'chapter_2',
        status: 'building',
        priority: 'active',
        arcType: 'character',
        horizon: 'medium',
        turnsActive: 3,
        plannedBeats: [{ id: 'b1', description: 'A slip of the tongue.', timing: 'soon', prerequisites: [], flexible: true, completed: false }],
        involvedCharacters: ['Mira'],
        stages: [{ title: 'Mira sees the envelope', turn: 1, timestamp: T0 }],
        nextBeat: { description: "The keeper lets the sister's name slip.", plannedAtTurn: 9, targetTurn: 12, status: 'pending' },
        setupsWithoutPayoff: 1,
        lastProgressTurn: 9,
      }),
    ],
    epicSeeds: [
      rcSeed(),
      rcSeed({
        id: 'seed_3_0',
        hint: 'Wet footprints on the stairs',
        payoff: 'The sister visits at night.',
        scope: 'player',
        plantedAtTurn: 3,
        payoffHorizon: 'short',
        payoffDelivered: true,
        payoffTurn: 7,
        relatedArcId: "the keeper's letter",
        reinforcements: [],
      }),
    ],
    invisibleArcs: [rcHidden()],
    hiddenEvents: [],
    npcOffScreenActions: [],
    parallelTimelines: [],
    coreMemories: [],
    notes: [],
    characterSecrets: {},
    worldState: {},
    pacing: {
      currentMood: 'wary_calm',
      turnsAtCurrentMood: 2,
      recentMoodHistory: ['tense'],
      rhythm: { lastActionSequence: 8, lastQuietMoment: 9, lastEmotionalBeat: 7, lastMajorRevelation: 3 },
      recommendations: { needsQuietMoment: false, needsTension: true, readyForClimax: false, needsBreather: false },
      chapterPhase: 'development',
    },
    recentAnalysis: [
      { turn: 9, userAction: 'Ask about the bell.', whatHappened: 'The keeper changes the subject.', seedsPlanted: [], seedsPayedOff: [], unexpectedDevelopments: [], timestamp: T0 },
      {
        turn: 10,
        userAction: 'Climb the tower.',
        whatHappened: 'Mira climbs the tower and finds the lamp warm.',
        seedsPlanted: ['A warm lamp'],
        seedsPayedOff: [],
        unexpectedDevelopments: ['The door was unlocked.'],
        timestamp: T0,
      },
    ],
    nextIntentions: [{ type: 'advance_arc', description: 'Let the keeper slip.', priority: 'must' }],
    storyHealth: { activeArcCount: 1, invisibleArcCount: 1, pendingSeedsCount: 1, turnsWithoutMajorEvent: 2, turnsWithoutQuietMoment: 1, coreMemoryCount: 0, hiddenEventsCount: 0 },
    lastDirective: {
      mood: 'tense',
      pacing: 'slow',
      include: { themes: ['secrets'] },
      avoid: { revelations: ['The sister is alive.'] },
      sceneGuidance: { atmosphere: 'Wind and salt.', tension_level: 6 },
      endingHook: 'A light in the tower.',
      focus: 'the lamp',
    },
    lastDirectiveTurn: 10,
    updatedAt: T0,
  };
}

/** The core state cleanContext() maps to. */
function cleanState(): DirectorState {
  return {
    turn: 10,
    nextId: 6,
    chapters: [
      {
        id: 'chapter-1',
        number: 1,
        title: 'Arrival',
        premise: 'The caravan reaches the sea town.',
        status: 'complete',
        themes: ['trust'],
        tone: 'uneasy',
        majorGoal: 'Find the keeper.',
        closingMoment: 'The lamp went dark.',
        createdAtTurn: 1,
      },
      {
        id: 'chapter-2',
        number: 2,
        title: 'The Lighthouse',
        premise: 'Someone lights the lamp at night.',
        status: 'active',
        themes: ['secrets', 'debt'],
        tone: 'tense',
        majorGoal: 'Learn who climbs the tower.',
        createdAtTurn: 6,
      },
    ],
    currentChapterId: 'chapter-2',
    arcs: [
      {
        id: 'arc-1',
        title: 'The Locked Room',
        description: 'A door nobody opens.',
        chapterId: 'chapter-1',
        status: 'complete',
        priority: 'background',
        arcType: 'mystery',
        horizon: 'short',
        lastProgressTurn: 5,
        // turnsActive 4 → at most turn 6; lastProgressTurn 5 → at most 5; its chapter began at 1.
        createdAtTurn: 5,
        // Stage turns were the arc's update count: from its start.
        stages: [
          { title: 'The key is found', turn: 5 },
          { title: 'The door opens', turn: 7 },
        ],
      },
      {
        id: 'arc-2',
        title: "The Keeper's Letter",
        description: 'The keeper hides a letter from his sister.',
        chapterId: 'chapter-2',
        status: 'building',
        priority: 'active',
        arcType: 'character',
        horizon: 'medium',
        lastProgressTurn: 9,
        createdAtTurn: 7,
        stages: [{ title: 'Mira sees the envelope', turn: 8 }],
        nextBeat: { description: "The keeper lets the sister's name slip.", plannedAtTurn: 9, targetTurn: 12, status: 'pending' },
      },
    ],
    seeds: [
      {
        id: 'seed-3',
        hint: 'A cracked bell',
        payoff: 'It rings at the finale.',
        scope: 'world',
        plantedAtTurn: 2,
        payoffHorizon: 'long',
        payoffDelivered: false,
        relatedArcId: 'arc-2',
        reinforcements: [{ turn: 4 }, { turn: 8 }],
      },
      {
        id: 'seed-4',
        hint: 'Wet footprints on the stairs',
        payoff: 'The sister visits at night.',
        scope: 'player',
        plantedAtTurn: 3,
        payoffHorizon: 'short',
        payoffDelivered: true,
        payoffTurn: 7,
        relatedArcId: 'arc-2',
        reinforcements: [],
      },
    ],
    invisibleArcs: [
      {
        id: 'hidden-5',
        title: 'The Guild Ledger',
        description: 'Someone is cooking the books.',
        arcType: 'conspiracy',
        horizon: 'long',
        scope: 'world',
        status: 'building',
        stages: [{ title: 'A missing page', turn: 5 }],
        surfaceCondition: 'When the player visits the harbour office.',
        playerClues: [{ turn: 7, clue: 'A clerk avoids the question.' }],
        createdAtTurn: 4,
      },
    ],
    notes: [],
    pacing: { currentMood: 'wary_calm', turnsAtCurrentMood: 2, rhythm: { lastActionSequence: 8, lastQuietMoment: 9 } },
    nextIntentions: [{ type: 'advance_arc', description: 'Let the keeper slip.', priority: 'must', targetTurn: 'next' }],
    lastDirective: {
      turn: 10,
      directive: {
        mood: 'tense',
        pacing: 'slow',
        include: { themes: ['secrets'] },
        avoid: { revelations: ['The sister is alive.'] },
        sceneGuidance: { atmosphere: 'Wind and salt.', tension_level: 6 },
        endingHook: 'A light in the tower.',
      },
    },
    lastPlantTurn: 3,
  };
}

const codes = (ws: { code: string }[]): string[] => ws.map((w) => w.code);
const warning = (ws: { code: string; path: string; message: string }[], code: string, path?: string) =>
  ws.find((w) => w.code === code && (path === undefined || w.path === path));

describe('dmContextToState: the mapping', () => {
  test('a clean dm-context: chapter-<number>, one counter for the rest, references remapped, D-61 fields only', () => {
    const r = dmContextToState(cleanContext(), { turn: 10 });
    expect(r.state).toEqual(cleanState());
    expect(checkState(r.state)).toEqual(cleanState()); // already as checkState reads it
    expect(r.analysis).toEqual({
      whatHappened: 'Mira climbs the tower and finds the lamp warm.',
      seedsPlanted: ['A warm lamp'],
      unexpected: ['The door was unlocked.'],
    });
    expect(codes(r.warnings)).toEqual(['rc_director_coerced', 'rc_director_derived', 'rc_director_refs', 'rc_director_details', 'rc_director_dropped']);
    expect(warning(r.warnings, 'rc_director_coerced')!.message).toContain('targetTurn missing → next (1)');
    expect(warning(r.warnings, 'rc_director_refs')!.message).toContain('an arc title, matched (1)');
    expect(warning(r.warnings, 'rc_director_derived')!.message).toContain('createdAtTurn derived for arcs (2), hidden arcs (1)');
    expect(warning(r.warnings, 'rc_director_details')!.message).toContain('stage descriptions (1)');
    expect(warning(r.warnings, 'rc_director_dropped', 'dm-context.recentAnalysis')!.message).toContain("1 turn analysis not imported");
  });

  test('the input is not changed and the same input maps the same', () => {
    const raw = cleanContext();
    const before = structuredClone(raw);
    const a = dmContextToState(raw, { turn: 10 });
    const b = dmContextToState(raw, { turn: 10 });
    expect(raw).toEqual(before);
    expect(a).toEqual(b);
  });

  test('not an object: no state, one unreadable warning; anything else is read, never thrown', () => {
    for (const raw of [null, undefined, 'dm', 7, [], [cleanContext()]]) {
      const r = dmContextToState(raw, { turn: 3 });
      expect(r.state).toBeNull();
      expect(codes(r.warnings)).toEqual(['rc_director_unreadable']);
    }
    const junk = {
      chapters: 'chapter one',
      activeArcs: { 0: 'a' },
      epicSeeds: [null, 3, true, [], { hint: 42 }],
      invisibleArcs: [{ title: ['x'] }],
      pacing: 'calm',
      nextIntentions: [{ description: 5 }],
      lastDirective: 'be tense',
      lastDirectiveTurn: -4,
      notes: 'remember',
    };
    const r = dmContextToState(junk, { turn: 3 });
    expect(r.state).toEqual({
      turn: 3,
      nextId: 1,
      chapters: [],
      arcs: [],
      seeds: [],
      invisibleArcs: [],
      notes: [],
      pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
      nextIntentions: [],
    });
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.epicSeeds')!.message).toBe(
      '5 of 5 seeds skipped: not an object (4), no hint (1).',
    );
  });

  test('a bad turn reads as 0; turn stamps past it are held to it', () => {
    const r = dmContextToState(cleanContext(), { turn: Number.NaN });
    expect(r.state!.turn).toBe(0);
    expect(r.state!.arcs.every((a) => a.createdAtTurn === 0 && a.stages.every((s) => s.turn === 0))).toBe(true);
    expect(warning(r.warnings, 'rc_director_turn', 'dm-context')!.message).toMatch(/^\d+ turn stamps later than turn 0/);
  });
});

describe('dmContextToState: malformed rows', () => {
  function messy(): Obj {
    return {
      chapters: [
        rcChapter({ id: 'chapter_1', number: 1, status: 'complete' }),
        rcChapter({ id: 'chapter_2', number: 2, status: 'complete', title: 'The First Storm', createdAtTurn: 4 }),
        rcChapter({ id: 'chapter_2', number: 2, status: 'active', title: 'The Second Storm', createdAtTurn: 8 }), // a shared id
        rcChapter({ id: 'chapter_9', number: 9, status: 'planned', title: 'Later', createdAtTurn: undefined }),
        'Chapter four',
      ],
      currentChapterId: 'chapter_2',
      activeArcs: [
        'The bell tower',
        spread('The harbour'),
        { description: 'no title, no id' },
        rcArc({ id: 'the_quiet_bell', title: '', chapterId: 'chapter_2', status: 'paused', lastProgressTurn: undefined, stages: ['a stage', { turn: 3 }] }),
        rcArc({ id: 'the_storm', title: '  The   Storm ', chapterId: 'chapter_77', nextBeat: { plannedAtTurn: 3 } }),
      ],
      epicSeeds: ['a bare seed', spread('spread seed'), rcSeed({ hint: '   ' }), rcSeed({ id: undefined, relatedArcId: 'nothing like it' })],
      invisibleArcs: [
        'The smugglers',
        { _stableId: 'legacy-1', arcTitle: 'The Old Debt', description: 'The guild owes the keeper.', status: 'climax', turnsActive: 2 },
        { _stableId: 'legacy-2', arcTitle: 'The Fire', status: 'complete', turnsActive: 1, notes: 'A fire at the docks.' },
        rcHidden({ id: 'iarc_6_1', status: 'whispering' }),
      ],
      nextIntentions: ['Bring back the bell', spread('Calm the sea'), { priority: 'must' }, { type: 'shift_mood', description: 'Quiet now.', priority: 'urgent', targetTurn: 'later' }],
      lastDirective: { mood: 'calm', pacing: 'fast' },
    };
  }

  test('rows that are not objects are skipped, a missing title or hint skips the row, intentions take text', () => {
    const r = dmContextToState(messy(), { turn: 12 });
    const s = r.state!;
    expect(s.arcs.map((a) => [a.id, a.title, a.status])).toEqual([
      ['arc-1', 'The Quiet Bell', 'seeding'], // recoverArcTitleFromId; 'paused' → RoleCall's default
      ['arc-2', 'The Storm', 'complete'],
    ]);
    expect(s.seeds.map((x) => [x.id, x.hint])).toEqual([['seed-3', 'A cracked bell']]);
    expect(s.seeds[0]!.relatedArcId).toBeUndefined();
    expect(s.invisibleArcs.map((h) => [h.id, h.title, h.status, h.arcType, h.horizon, h.scope, h.description])).toEqual([
      ['hidden-4', 'The Old Debt', 'approaching_player', 'background', 'medium', 'world', 'The guild owes the keeper.'],
      ['hidden-5', 'The Fire', 'resolved', 'background', 'medium', 'world', 'The Fire'],
      ['hidden-6', 'The Guild Ledger', 'seeding', 'conspiracy', 'long', 'world', 'Someone is cooking the books.'],
    ]);
    expect(s.nextIntentions).toEqual([
      { type: 'advance_arc', description: 'Bring back the bell', priority: 'should', targetTurn: 'next' },
      { type: 'advance_arc', description: 'Calm the sea', priority: 'should', targetTurn: 'next' },
      { type: 'shift_mood', description: 'Quiet now.', priority: 'should', targetTurn: 'next' },
    ]);
    // No lastDirectiveTurn: the directive is left out with a warning of its own.
    expect(s.lastDirective).toBeUndefined();
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.lastDirective')).toBeDefined();

    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.activeArcs')!.message).toBe(
      '3 of 5 arcs skipped: bare text (1), a string spread into an object (1), no title (1).',
    );
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.epicSeeds')!.message).toBe(
      '3 of 4 seeds skipped: bare text (1), a string spread into an object (1), no hint (1).',
    );
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.invisibleArcs')!.message).toBe('1 of 4 hidden arcs skipped: bare text (1).');
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.activeArcs[].stages')!.message).toBe(
      '2 arc stages skipped: not an object (1), no title (1).',
    );
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.activeArcs[].nextBeat')!.message).toBe('1 next beats skipped: no description (1).');
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.nextIntentions')!.message).toBe('1 of 4 intentions skipped: no description (1).');
    const hidden = warning(r.warnings, 'rc_director_coerced', 'dm-context.invisibleArcs')!.message;
    expect(hidden).toContain('legacy shape: arcTitle read as the title (2)');
    expect(hidden).toContain('status climax → approaching_player (1)');
    expect(hidden).toContain('status complete → resolved (1)');
    expect(hidden).toContain('status unknown → seeding (1)');
    const intents = warning(r.warnings, 'rc_director_coerced', 'dm-context.nextIntentions')!.message;
    expect(intents).toContain('bare text → its description (1)');
    expect(intents).toContain('a string spread into an object → its description (1)');
    expect(intents).toContain('priority unknown → should (1)');
    expect(warning(r.warnings, 'rc_director_coerced', 'dm-context.activeArcs')!.message).toContain('no title → read from the id (1)');
    const refs = warning(r.warnings, 'rc_director_refs')!.message;
    expect(refs).toContain("an arc's chapterId: names no chapter: dropped (1)");
    expect(refs).toContain("a seed's relatedArcId: names no arc: dropped (1)");
  });

  test('chapters: a shared id names the open one, a planned chapter is left out, the current pointer as RoleCall resolves it', () => {
    const r = dmContextToState(messy(), { turn: 12 });
    const s = r.state!;
    expect(s.chapters.map((c) => [c.id, c.title, c.status, c.createdAtTurn])).toEqual([
      ['chapter-1', 'Arrival', 'complete', 1],
      ['chapter-2', 'The First Storm', 'complete', 4],
      ['chapter-3', 'The Second Storm', 'active', 8], // number 2 taken → the next free one
    ]);
    expect(s.currentChapterId).toBe('chapter-3');
    expect(s.arcs[0]!.chapterId).toBe('chapter-3'); // 'chapter_2' → its open keeper
    expect(s.arcs[1]!.chapterId).toBeUndefined();
    expect(warning(r.warnings, 'rc_director_skipped', 'dm-context.chapters')!.message).toBe(
      '2 of 5 chapters skipped: bare text (1), planned, not begun (1).',
    );
    const fixed = warning(r.warnings, 'rc_director_coerced', 'dm-context.chapters')!.message;
    expect(fixed).toContain('id shared with another chapter (references go to the open one) (1)');
    expect(fixed).toContain('number missing or taken → renumbered (1)');
  });

  test('a planned chapter the pointer names is the current one, active; no pointer: the last one not complete', () => {
    const planned = dmContextToState(
      { chapters: [rcChapter(), rcChapter({ id: 'chapter_2', number: 2, status: 'planned', createdAtTurn: undefined })], currentChapterId: 'chapter_2' },
      { turn: 30 },
    ).state!;
    expect(planned.chapters.map((c) => [c.id, c.status])).toEqual([
      ['chapter-1', 'complete'],
      ['chapter-2', 'active'],
    ]);
    expect(planned.currentChapterId).toBe('chapter-2');
    const none = dmContextToState(
      { chapters: [rcChapter({ status: 'active' }), rcChapter({ id: 'chapter_2', number: 2, status: 'complete', createdAtTurn: 9 })] },
      { turn: 30 },
    ).state!;
    expect(none.currentChapterId).toBe('chapter-1');
    const allDone = dmContextToState({ chapters: [rcChapter(), rcChapter({ id: 'chapter_2', number: 2, createdAtTurn: 9 })], currentChapterId: 'gone' }, { turn: 30 }).state!;
    expect(allDone.currentChapterId).toBe('chapter-2');
  });
});

describe('dmContextToState: turn stamps', () => {
  test('arcs: createdAtTurn the newest the stamps allow, not before the chapter; a live arc with no progress turn progressed now', () => {
    const raw = {
      chapters: [rcChapter({ id: 'chapter_1', status: 'active', createdAtTurn: 45 })],
      activeArcs: [
        rcArc({ id: 'a', title: 'Old live arc', status: 'building', chapterId: undefined, turnsActive: 10, lastProgressTurn: undefined }),
        rcArc({ id: 'b', title: 'Arc in the chapter', status: 'building', chapterId: 'chapter_1', turnsActive: 30, lastProgressTurn: undefined }),
        rcArc({ id: 'c', title: 'Planned beat', status: 'climax', chapterId: undefined, turnsActive: 2, lastProgressTurn: 41, nextBeat: { description: 'x', plannedAtTurn: 38, status: 'delivered', deliveredAtTurn: 44 } }),
        rcArc({ id: 'd', title: 'Done arc', status: 'abandoned', chapterId: undefined, turnsActive: 5, lastProgressTurn: undefined, stages: [{ title: 'Late', turn: 9 }] }),
      ],
    };
    const s = dmContextToState(raw, { turn: 50 }).state!;
    expect(s.arcs.map((a) => [a.title, a.createdAtTurn, a.lastProgressTurn])).toEqual([
      ['Old live arc', 40, 50],
      ['Arc in the chapter', 45, 50],
      ['Planned beat', 38, 41],
      ['Done arc', 45, undefined],
    ]);
    // A stage past the import turn is held to it.
    expect(s.arcs[3]!.stages).toEqual([{ title: 'Late', turn: 50 }]);
    expect(s.arcs[2]!.nextBeat).toEqual({ description: 'x', plannedAtTurn: 38, status: 'delivered', deliveredAtTurn: 44 });
  });

  test('turnAt dates an item by its createdAt and a visible arc stage by its timestamp', () => {
    const times: Record<string, number> = { '2026-02-01T00:00:00.000Z': 3, '2026-02-02T00:00:00.000Z': 6, '2026-02-03T00:00:00.000Z': 99 };
    const turnAt = (iso: string): number | undefined => times[iso];
    const raw = {
      chapters: [rcChapter({ createdAtTurn: undefined, createdAt: '2026-02-01T00:00:00.000Z' })],
      activeArcs: [
        rcArc({
          createdAt: '2026-02-01T00:00:00.000Z',
          stages: [
            { title: 'Dated', turn: 1, timestamp: '2026-02-02T00:00:00.000Z' },
            { title: 'Undated', turn: 1, timestamp: 'not a time' },
          ],
        }),
      ],
      invisibleArcs: [rcHidden({ createdAt: '2026-02-03T00:00:00.000Z' })],
    };
    const s = dmContextToState(raw, { turn: 20, turnAt }).state!;
    expect(s.chapters[0]!.createdAtTurn).toBe(3);
    expect(s.arcs[0]!.createdAtTurn).toBe(3);
    expect(s.arcs[0]!.stages).toEqual([
      { title: 'Dated', turn: 6 },
      { title: 'Undated', turn: 4 },
    ]);
    expect(s.invisibleArcs[0]!.createdAtTurn).toBe(20); // a time after the head: held to it
  });

  test("seeds: RoleCall's plant-turn repair, the id's turn first, never after the payoff", () => {
    const raw = {
      epicSeeds: [
        rcSeed({ hint: 'kept', plantedAtTurn: 7 }),
        rcSeed({ hint: 'reinforced', plantedAtTurn: 0, reinforcements: [{ turn: 12 }, { turn: 9 }, { turn: 0 }] }),
        rcSeed({ id: 'seed_33_1', hint: 'by id', plantedAtTurn: 0, reinforcements: [{ turn: 12 }] }),
        rcSeed({ hint: 'paid', plantedAtTurn: undefined, reinforcements: [], payoffDelivered: true, payoffTurn: 15 }),
        rcSeed({ hint: 'nothing', plantedAtTurn: 0, reinforcements: [] }),
        rcSeed({ hint: 'from the future', plantedAtTurn: 70, reinforcements: [{ turn: 71 }] }),
      ],
    };
    const r = dmContextToState(raw, { turn: 40 });
    const s = r.state!;
    expect(s.seeds.map((x) => [x.hint, x.plantedAtTurn])).toEqual([
      ['kept', 7],
      ['reinforced', 9],
      ['by id', 33],
      ['paid', 15],
      ['nothing', 40],
      ['from the future', 40],
    ]);
    expect(s.seeds[5]!.reinforcements).toEqual([{ turn: 40 }]);
    expect(s.lastPlantTurn).toBe(40);
    expect(warning(r.warnings, 'rc_director_derived')!.message).toContain('plantedAtTurn of 0 or none set for 4 seeds');
    expect(warning(r.warnings, 'rc_director_turn', 'dm-context')!.message).toBe("2 turn stamps later than turn 40 (the head reply's) held to it.");
  });

  test('hidden arcs: the earliest of the id turn, turn − turnsActive, stage and clue turns', () => {
    const raw = {
      invisibleArcs: [
        rcHidden({ id: 'iarc_20_0', turnsActive: 2, stages: [], playerClues: [] }),
        rcHidden({ id: 'guild', turnsActive: 5, stages: [{ title: 'A', turn: 31 }], playerClues: [{ turn: 29, clue: 'c' }] }),
        rcHidden({ id: 'quiet', turnsActive: undefined, stages: [], playerClues: [] }),
      ],
    };
    const s = dmContextToState(raw, { turn: 40 }).state!;
    expect(s.invisibleArcs.map((h) => h.createdAtTurn)).toEqual([20, 29, 40]);
  });

  test('chapters with no createdAtTurn: the first at 0, a later one the newest its neighbours and turnsElapsed allow', () => {
    const raw = {
      chapters: [
        rcChapter({ createdAtTurn: undefined }),
        rcChapter({ id: 'chapter_2', number: 2, createdAtTurn: 30 }),
        rcChapter({ id: 'chapter_3', number: 3, status: 'active', createdAtTurn: undefined, turnsElapsed: 4 }),
      ],
    };
    const s = dmContextToState(raw, { turn: 50 }).state!;
    expect(s.chapters.map((c) => c.createdAtTurn)).toEqual([0, 30, 46]);
  });

  test("RoleCall's last directive of an earlier turn: kept in the state, a warning", () => {
    const raw = { ...cleanContext(), lastDirectiveTurn: 8 };
    const r = dmContextToState(raw, { turn: 10 });
    expect(r.state!.lastDirective!.turn).toBe(8);
    expect(warning(r.warnings, 'rc_director_turn', 'dm-context.lastDirectiveTurn')!.message).toContain('last planned turn 8, the story is at turn 10');
  });
});

describe('dmContextToState: what the state has no place for', () => {
  test('one warning per dropped part, with the malformed rows counted', () => {
    const raw = {
      ...cleanContext(),
      hiddenEvents: [{ id: 'h1', title: 'Smoke' }, 'A bare event', spread('A spread event'), spread('Another')],
      npcOffScreenActions: [{ id: 'n1', npcName: 'Oren', action: 'Counts coins.' }],
      parallelTimelines: [spread('Meanwhile at the docks')],
      coreMemories: [{ id: 'm1', title: 'The promise' }, { id: 'm2', title: 'The debt' }],
      notes: [{ id: 'note_1_1', type: 'plan', scope: 'player', content: 'Pay off the bell.', createdAtTurn: 4, resolved: false }],
      characterSecrets: { mira: [{ id: 's1', secret: 'She can swim.' }, { id: 's2', secret: 'x' }], oren: [{ id: 's3', secret: 'y' }] },
      worldState: { tide: 'low', season: 'autumn' },
    };
    const r = dmContextToState(raw, { turn: 10 });
    const dropped = r.warnings.filter((w) => w.code === 'rc_director_dropped');
    expect(dropped.map((w) => w.message)).toEqual([
      "4 hidden events not imported (1 bare text, 2 a string spread into an object): the core's Director keeps no off-screen events (D-61).",
      "1 off-screen NPC actions not imported: the core's Director keeps no NPC agendas (D-61).",
      "1 parallel timelines not imported (1 a string spread into an object): the core's Director keeps no parallel timelines (D-61).",
      "2 core memories not imported: the core's Director keeps no permanent memories (the Compendium holds the story's facts) (D-61).",
      "1 Director notes not imported: the core's Director notes are the player's own (its prompt reads them as notes from the player) (D-61).",
      "3 character secrets not imported: the core's Director keeps no secrets (D-61).",
      "2 world-state keys not imported: the core's Director keeps no world state (D-61).",
      "1 turn analysis not imported: a record holds its own turn's analysis only (the head turn's is on the head reply).",
    ]);
    expect(new Set(dropped.map((w) => w.path)).size).toBe(dropped.length);
    expect(r.state!.notes).toEqual([]);
  });
});

/** A dm-context of about `bytes` bytes: arcs, seeds, hidden arcs and chapters with long Russian texts. */
function bigContext(scale: number): Obj {
  const arcs = Array.from({ length: 30 * scale }, (_, i) =>
    rcArc({
      id: `arc_${i}`,
      title: `Арка ${i} ${ru(30, i)}`,
      description: ru(1_200, i),
      chapterId: `chapter_${1 + (i % 12)}`,
      status: i % 3 === 0 ? 'complete' : 'building',
      turnsActive: i,
      lastProgressTurn: i % 2 === 0 ? 100 + i : undefined,
      stages: Array.from({ length: 20 }, (_, k) => ({ title: ru(80, k + i), description: ru(200, k), turn: k, timestamp: T0 })),
      nextBeat: { description: ru(400, i), plannedAtTurn: 100 + i, status: 'pending' },
    }),
  );
  const seeds = Array.from({ length: 60 * scale }, (_, i) =>
    rcSeed({
      id: `seed_${i}_0`,
      hint: `Семя ${i} ${ru(100, i)}`,
      payoff: ru(800, i),
      plantedAtTurn: i % 4 === 0 ? 0 : i,
      payoffDelivered: i % 2 === 0,
      payoffTurn: i % 2 === 0 ? i + 3 : undefined,
      relatedArcId: `arc_${i % (30 * scale)}`,
      reinforcements: Array.from({ length: 10 }, (_, k) => ({ turn: i + k, description: ru(120, k) })),
    }),
  );
  const hidden = Array.from({ length: 20 * scale }, (_, i) =>
    rcHidden({
      id: `iarc_${i}_0`,
      title: `Тень ${i}`,
      description: ru(1_500, i),
      status: i % 4 === 0 ? 'resolved' : 'building',
      stages: Array.from({ length: 12 }, (_, k) => ({ title: ru(60, k), turn: i + k, timestamp: T0 })),
      playerClues: Array.from({ length: 12 }, (_, k) => ({ turn: i + k, clue: ru(150, k) })),
    }),
  );
  const chapters = Array.from({ length: 12 }, (_, i) =>
    rcChapter({ id: `chapter_${i + 1}`, number: i + 1, status: i === 11 ? 'active' : 'complete', premise: ru(900, i), createdAtTurn: i * 20, themes: [ru(40, i), ru(40, i + 1)] }),
  );
  return {
    ...cleanContext(),
    chapters,
    currentChapterId: 'chapter_12',
    activeArcs: arcs,
    epicSeeds: seeds,
    invisibleArcs: hidden,
    nextIntentions: Array.from({ length: 9 }, (_, i) => ({ type: 'advance_arc', description: ru(500, i), priority: 'should', targetTurn: 'soon' })),
    lastDirective: { mood: ru(200), pacing: 'medium', include: { themes: Array.from({ length: 12 }, (_, i) => ru(300, i)) }, narrativeGoal: ru(1_000) },
    lastDirectiveTurn: 400,
    hiddenEvents: Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? ru(400, i) : { id: `h${i}`, title: ru(50, i), description: ru(600, i) })),
    parallelTimelines: Array.from({ length: 40 }, (_, i) => spread(ru(170, i))),
  };
}

describe('dmContextToState: size', () => {
  test('a 1 MB dm-context comes back within 32 KB, the D-61 limits and checkState, fast', () => {
    const raw = bigContext(4);
    const size = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    expect(size).toBeGreaterThan(1_000_000);
    expect(size).toBeLessThan(5_000_000);
    const t0 = performance.now();
    const r = dmContextToState(raw, { turn: 400 });
    const ms = performance.now() - t0;
    const s = r.state!;
    expect(stateBytes(s)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    expect(checkState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(s.arcs.filter((a) => a.status !== 'complete' && a.status !== 'abandoned').length).toBeLessThanOrEqual(STATE_LIMITS.liveArcs);
    expect(s.seeds.filter((x) => !x.payoffDelivered).length).toBeLessThanOrEqual(STATE_LIMITS.liveSeeds);
    expect(s.invisibleArcs.filter((h) => h.status !== 'resolved' && h.status !== 'visible').length).toBeLessThanOrEqual(STATE_LIMITS.liveHidden);
    expect(s.nextIntentions.length).toBeLessThanOrEqual(STATE_LIMITS.intentions);
    // Ids are consecutive after the cut, the counter past them, and every relatedArcId names a kept arc.
    const ids = [...s.arcs, ...s.seeds, ...s.invisibleArcs].map((x) => Number(x.id.replace(/^\D+-/, '')));
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    expect(s.nextId).toBe(ids.length + 1);
    const arcIds = new Set(s.arcs.map((a) => a.id));
    expect(s.seeds.every((x) => x.relatedArcId === undefined || arcIds.has(x.relatedArcId))).toBe(true);
    expect(s.currentChapterId).toBe('chapter-12');
    expect(s.chapters.some((c) => c.id === 'chapter-12')).toBe(true);
    const fit = warning(r.warnings, 'rc_director_fit')!.message;
    expect(fit).toContain('kept arcs');
    expect(fit).toContain('fit:');
    expect(ms).toBeLessThan(2_000);
    const { head, before } = directorRecordsFor(s, 400, r.analysis !== undefined ? { analysis: r.analysis } : {});
    for (const rec of [head, before!]) {
      expect(checkRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
      expect(stateBytes(rec.state)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    }
  });

  test("a person's hidden arcs keep their flag while they fit; over the cap they are kept as the Director's", () => {
    const few = dmContextToState({ invisibleArcs: [rcHidden({ userAuthored: true }), rcHidden({ id: 'iarc_5_0', title: 'Other' })] }, { turn: 10 }).state!;
    expect(few.invisibleArcs.map((h) => h.userAuthored)).toEqual([true, undefined]);

    const many = Array.from({ length: 16 }, (_, i) =>
      rcHidden({ id: `iarc_${i}_0`, title: `Тень ${i}`, description: ru(2_000, i), surfaceCondition: ru(2_000, i + 1), userAuthored: true }),
    );
    const r = dmContextToState({ invisibleArcs: many }, { turn: 30 });
    const s = r.state!;
    expect(stateBytes(s)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    expect(s.invisibleArcs.every((h) => h.userAuthored === undefined)).toBe(true);
    expect(s.invisibleArcs.length).toBeLessThanOrEqual(STATE_LIMITS.liveHidden);
    expect(warning(r.warnings, 'rc_director_fit')!.message).toContain("the player's hidden arcs did not fit as the player's");
  });
});

// ---- the records --------------------------------------------------------------------------------

const roundTrip = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe('directorRecordsFor', () => {
  test('head: the turn, its directive and analysis; before: one turn earlier, no later directive; both read back unchanged', () => {
    const r = dmContextToState(cleanContext(), { turn: 10 });
    const { head, before } = directorRecordsFor(r.state!, 10, { analysis: r.analysis!, model: 'rolecall:some/model' });
    expect(head).toEqual({
      turn: 10,
      ok: true,
      model: 'rolecall:some/model',
      directive: cleanState().lastDirective!.directive,
      analysis: r.analysis!,
      skipped: [],
      attempts: [],
      state: cleanState(),
      reducer: REDUCER_VERSION,
    });
    const { lastDirective: _, ...rest } = cleanState();
    expect(before).toEqual({ turn: 9, ok: true, model: 'rolecall:some/model', skipped: [], attempts: [], state: { ...rest, turn: 9 }, reducer: REDUCER_VERSION });
    expect(checkRecord(roundTrip(head))).toEqual(head);
    expect(checkRecord(roundTrip(before))).toEqual(before!);
  });

  test("RoleCall's directive of an earlier turn: no directive on the head, it stays in a state at or after its turn", () => {
    const s = dmContextToState({ ...cleanContext(), lastDirectiveTurn: 9 }, { turn: 10 }).state!;
    const { head, before } = directorRecordsFor(s, 10);
    expect(head.directive).toBeUndefined();
    expect(head.state.lastDirective!.turn).toBe(9);
    expect(before!.directive).toEqual(s.lastDirective!.directive);
    expect(before!.state.lastDirective!.turn).toBe(9);
    const other = directorRecordsFor(s, 10, { beforeTurn: 7 });
    expect(other.before!.turn).toBe(7);
    expect(other.before!.state.lastDirective).toBeUndefined();
    expect(directorRecordsFor(s, 10, { beforeTurn: 25 }).before!.turn).toBe(9); // never at or past the head
  });

  test('turn 0: the head record only', () => {
    const s = dmContextToState(cleanContext(), { turn: 0 }).state!;
    const out = directorRecordsFor(s, 0);
    expect(out.before).toBeUndefined();
    expect(out.head.turn).toBe(0);
    expect(checkRecord(roundTrip(out.head))).toEqual(out.head);
  });

  test('a state checkState refuses is a programming error', () => {
    const s = dmContextToState(cleanContext(), { turn: 10 }).state!;
    expect(() => directorRecordsFor({ ...s, arcs: [{ ...s.arcs[0]!, status: 'paused' as never }] }, 10)).toThrow();
  });

  test('on a path: the next reply plans turn + 1 from the head, a replan of the head from the reply before, a plain swipe reuses the directive', () => {
    const r = dmContextToState(cleanContext(), { turn: 10 });
    const { head, before } = directorRecordsFor(r.state!, 10);
    const withDir = (dir: unknown): Partial<MsgEntry> => ({ dir: dir as Record<string, unknown> });
    const inputs: EntryInput[] = [
      msg('g0000001', null, 'assistant', 'The sea town at dusk.', { gen: { kind: 'greeting' } as MsgEntry['gen'] }),
      msg('u0000001', 'g0000001', 'user', 'I ask about the bell.'),
      msg('a0000001', 'u0000001', 'assistant', 'The keeper looks away.', withDir(before)),
      msg('u0000002', 'a0000001', 'user', 'I climb the tower.'),
      msg('a0000002', 'u0000002', 'assistant', 'The lamp is warm.', withDir(head)),
      msg('u0000003', 'a0000002', 'user', 'I touch the lamp.'),
    ];
    const tree = buildTree(seqd(inputs));
    const next = directorAt(tree, 'u0000003');
    expect(next.from).toBe('a0000002');
    expect(next.state.turn + 1).toBe(11);
    const replan = directorAt(tree, 'u0000002'); // a swipe of a0000002 plans from its parent
    expect(replan.from).toBe('a0000001');
    expect(replan.state.turn + 1).toBe(10);
    expect(replan.state.lastDirective).toBeUndefined();
    const reused = reusedRecord(tree, 'a0000002', undefined);
    expect(reused!.directive).toEqual(head.directive!);
    expect(reused!.reusedFrom).toBe('a0000002');
  });
});

describe('directorSettingsFor', () => {
  test("on as RoleCall's chat page reads it: dmMode decides when set, else dmEnabled", () => {
    expect(directorSettingsFor({ dmMode: 'full' }).director.enabled).toBe(true);
    expect(directorSettingsFor({ dmMode: 'off', dmEnabled: true }).director.enabled).toBe(false);
    expect(directorSettingsFor({ dmMode: 'tv_only', dmEnabled: true }).director.enabled).toBe(false);
    expect(directorSettingsFor({ dmEnabled: true }).director.enabled).toBe(true);
    expect(directorSettingsFor({ dmMode: '', dmEnabled: 1 }).director.enabled).toBe(true); // the page's truthiness
    expect(directorSettingsFor({}).director.enabled).toBe(false);
    expect(directorSettingsFor(null)).toEqual({ director: { enabled: false }, warnings: [] });
  });

  test("the style when it is one of the core's, else a warning; the model label", () => {
    expect(directorSettingsFor({ dmEnabled: true, dmPersonality: 'the-oracle', dmModelId: ' some/model ' })).toEqual({
      director: { enabled: true, style: 'the-oracle' },
      model: 'rolecall:some/model',
      warnings: [],
    });
    const odd = directorSettingsFor({ dmEnabled: true, dmPersonality: 'the-gardener', dmModelId: '' });
    expect(odd.director).toEqual({ enabled: true });
    expect(odd.model).toBeUndefined();
    expect(codes(odd.warnings)).toEqual(['rc_director_style']);
  });
});

describe('the review fixes', () => {
  test("fidelity#3: every version of the head reply and of the reply before it carries RoleCall's state", () => {
    const story = buildStory({ branch: false, duplicate: false, detached: false });
    const main = story.facts.chats.main!;
    const name = `${main.dir}/messages.jsonl`;
    // Give the last two replies (9 and 11) a second version, the first one shown.
    const files = story.files.map((f) => {
      if (f.name !== name) return f;
      const rows = f.data.split('\n').map((l) => JSON.parse(l) as Obj);
      for (const i of [9, 11]) {
        const row = rows[i]!;
        const swipes = row.swipes as Obj[];
        rows[i] = { ...row, swipes: [...swipes, { ...swipes[0]!, content: `${String(row.content)} (another take)` }] };
      }
      return { ...f, data: rows.map((r) => JSON.stringify(r)).join('\n') };
    });
    const parsed = parseStory(files.filter((f) => f.name !== 'story.jsonl'));
    if (!parsed.ok) throw new Error(parsed.why);
    const s = planStoryImport(parsed.value).sessions[0]!;
    const msgs = s.entries.filter((e): e is EntryInput & { t: 'msg'; id: string; parent: string | null; dir?: Obj } => e.t === 'msg');
    const tree = buildTree(seqd(s.entries));
    const head = msgs.find((m) => m.id === s.head)!;
    const headTwin = msgs.find((m) => m.parent === head.parent && m.id !== head.id)!;
    const userBefore = msgs.find((m) => m.id === head.parent)!;
    const before = msgs.find((m) => m.id === userBefore.parent)!;
    const beforeTwin = msgs.find((m) => m.parent === before.parent && m.id !== before.id)!;
    expect(msgs.filter((m) => m.dir !== undefined).map((m) => m.id).sort()).toEqual([head.id, headTwin.id, before.id, beforeTwin.id].sort());
    expect(s.director.records).toBe(4);
    // Continuing from the other version of the head: RoleCall's state at its turn, as from the head.
    const fromTwin = directorAt(tree, headTwin.id);
    expect(fromTwin.from).toBe(headTwin.id);
    expect(fromTwin.record?.turn).toBe(main.users);
    expect(fromTwin.state.arcs.length).toBeGreaterThan(0);
    // …and from the other version of the reply before it: the state one turn earlier, not an empty one.
    const fromBeforeTwin = directorAt(tree, beforeTwin.id);
    expect(fromBeforeTwin.from).toBe(beforeTwin.id);
    expect(fromBeforeTwin.record?.turn).toBe(main.users - 1);
    expect(fromBeforeTwin.state.arcs.length).toBeGreaterThan(0);
  });

  test("robust#7: a hidden arc's status named like Object.prototype's keys reads as RoleCall's default", () => {
    for (const status of ['__proto__', 'constructor', 'toString']) {
      const r = dmContextToState({ ...cleanContext(), invisibleArcs: [rcHidden({ status })] }, { turn: 10 });
      expect(r.state!.invisibleArcs).toHaveLength(1);
      expect(r.state!.invisibleArcs[0]!.status).toBe('seeding');
      expect(checkState(r.state!)).not.toBeNull();
    }
  });
});
