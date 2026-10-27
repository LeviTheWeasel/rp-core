// Ported from Bunraku:src/core/director/directive.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: the enrichFromMomentum cases; the sanitize cases belong to render's tests).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// enrichFromMomentum (agents/director/momentum.ts; ARCHITECTURE.md §7.3, D-63): overdue arcs and ripe
// seeds the planner left out reach the narrator as a forceful arc direction and a callback. Names
// compare after foldText by whole words only — a run of word stems (Russian inflection) — or by id
// (D-117: Bunraku's substring compare is gone, "Art" is not named by "The Party");
// the planner's entries are never dropped; lists stay within READ_LIMITS.directiveList; the inputs are
// never changed and a new object comes back.
import { describe, expect, test } from 'bun:test';
import { computeMomentum, enrichFromMomentum } from '../../src/agents/director/momentum.ts';
import {
  READ_LIMITS,
  type DirectorArc,
  type DirectorSeed,
  type DirectorState,
  type MomentumReport,
  type NarratorDirective,
} from '../../src/agents/director/types.ts';

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
const two = [{ turn: 1 }, { turn: 2 }];

const base: NarratorDirective = { mood: 'tense', pacing: 'slow' };
const report = () => computeMomentum(stateOf({ arcs: [arcOf({ lastProgressTurn: 0 })], seeds: [seedOf({ plantedAtTurn: 0, reinforcements: two })] }), 40);
/** A report with one forced arc and one ripe seed of these names (ids arc-1, seed-1). */
const reportFor = (arcTitle: string, seedHint: string): MomentumReport =>
  computeMomentum(stateOf({ arcs: [arcOf({ title: arcTitle, lastProgressTurn: 0 })], seeds: [seedOf({ hint: seedHint, plantedAtTurn: 0, reinforcements: two })] }), 40);

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

describe('enrichFromMomentum', () => {
  test('an overdue arc and a ripe seed the planner left out are added as a forceful arc direction and a callback', () => {
    const out = enrichFromMomentum(base, report());
    expect(out.arcDirections).toMatchObject([{ arcName: 'The Locked Room', urgency: 'forceful' }]);
    expect(out.arcDirections![0]!.instruction).toBe(
      'This arc is OVERDUE (40 turns without progression, 25 past the limit). Deliver a turning point that pushes it toward climax/resolution this scene, OR write a beat that brings it to a natural close. Do not leave it to drift another turn - the audience can feel arcs that have stalled.',
    );
    expect(out.callbacks).toMatchObject([{ reference: 'A cracked bell' }]);
    expect(out.callbacks![0]!.instruction).toBe(
      "RIPE SEED - echo this in prose this scene. A passing reference, an environmental cue, an NPC line, or a small detail that quietly reinforces it. Planted 40 turns ago, reinforced 2x - it's ready to land.",
    );
    expect(out.mood).toBe('tense');
    expect(out.pacing).toBe('slow');
  });

  test('what the planner already wrote for them is left alone, even under a looser name', () => {
    const planned: NarratorDirective = {
      ...base,
      arcDirections: [{ arcName: 'the locked room (again)', instruction: 'mine', urgency: 'subtle' }],
      callbacks: [{ reference: 'a cracked bell on the pier', instruction: 'mine' }],
    };
    const out = enrichFromMomentum(planned, report());
    expect(out.arcDirections).toEqual(planned.arcDirections!);
    expect(out.callbacks).toEqual(planned.callbacks!);
    // A shorter name the planner wrote names the arc too (contained the other way round).
    const short = enrichFromMomentum({ ...base, arcDirections: [{ arcName: 'Locked Room', instruction: 'mine', urgency: 'moderate' }] }, report());
    expect(short.arcDirections).toHaveLength(1);
  });

  test('with no pressure the directive comes back unchanged, as a new object', () => {
    // Changed: Bunraku returned the very same object and took an optional report; here the report is
    // always computed before the call and the result is always a new object (momentum unit contract).
    const quiet = computeMomentum(stateOf({ seeds: [seedOf({ plantedAtTurn: 1 })] }), 2);
    const out = enrichFromMomentum(base, quiet);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });

  test('Russian names match after folding and across inflection', () => {
    const r = reportFor('Запертая комната', 'Треснувший колокол');
    const planned: NarratorDirective = {
      ...base,
      arcDirections: [{ arcName: 'Тайна запертой комнаты', instruction: 'моё', urgency: 'subtle' }],
      callbacks: [{ reference: 'звон треснувшего колокола', instruction: 'моё' }],
    };
    expect(enrichFromMomentum(planned, r)).toEqual(planned);
    // ё and е, upper and lower case, extra spaces fold alike.
    const r2 = reportFor('Ёлка  у ворот', 'Чёрный КОТ');
    const folded: NarratorDirective = {
      ...base,
      arcDirections: [{ arcName: 'елка у ворот', instruction: 'x', urgency: 'subtle' }],
      callbacks: [{ reference: 'черный кот', instruction: 'x' }],
    };
    expect(enrichFromMomentum(folded, r2)).toEqual(folded);
  });

  test('a Russian forced arc and ripe seed the planner left out are added with their names intact', () => {
    const out = enrichFromMomentum(
      { ...base, arcDirections: [{ arcName: 'Старый долг', instruction: 'x', urgency: 'subtle' }] },
      reportFor('Запертая комната', 'Треснувший колокол'),
    );
    expect(out.arcDirections!.map((a) => [a.arcName, a.urgency])).toEqual([
      ['Старый долг', 'subtle'],
      ['Запертая комната', 'forceful'],
    ]);
    expect(out.callbacks!.map((c) => c.reference)).toEqual(['Треснувший колокол']);
  });

  test('an entry that names the item by its id counts as naming it', () => {
    const planned: NarratorDirective = {
      ...base,
      arcDirections: [{ arcName: '[arc-1]', instruction: 'x', urgency: 'moderate' }],
      callbacks: [{ reference: 'SEED-1', instruction: 'x' }],
    };
    expect(enrichFromMomentum(planned, report())).toEqual(planned);
    // Another id is another item: arc-12 does not name arc-1.
    const other = enrichFromMomentum({ ...base, arcDirections: [{ arcName: 'arc-12', instruction: 'x', urgency: 'moderate' }] }, report());
    expect(other.arcDirections!.map((a) => a.arcName)).toEqual(['arc-12', 'The Locked Room']);
  });

  test('an unrelated name does not count, and an empty name silences nothing', () => {
    const planned: NarratorDirective = {
      ...base,
      arcDirections: [
        { arcName: '', instruction: 'x', urgency: 'subtle' },
        { arcName: 'The Masquerade', instruction: 'x', urgency: 'subtle' },
      ],
      callbacks: [{ reference: '  ', instruction: 'x' }],
    };
    const out = enrichFromMomentum(planned, reportFor('The Locked Room', 'A cracked bell'));
    expect(out.arcDirections!.map((a) => a.arcName)).toEqual(['', 'The Masquerade', 'The Locked Room']);
    expect(out.callbacks!.map((c) => c.reference)).toEqual(['  ', 'A cracked bell']);
  });

  test('a name inside another word does not count (D-117): "Art" is not directed by "The Party"', () => {
    // Changed: Bunraku's substring compare took "the party" as naming "art", and a one-letter arcName
    // silenced most additions.
    const out = enrichFromMomentum({ ...base, arcDirections: [{ arcName: 'The Party', instruction: 'x', urgency: 'subtle' }] }, reportFor('Art', 'Bell'));
    expect(out.arcDirections!.map((a) => [a.arcName, a.urgency])).toEqual([
      ['The Party', 'subtle'],
      ['Art', 'forceful'],
    ]);
    const short = enrichFromMomentum({ ...base, arcDirections: [{ arcName: 'a', instruction: 'x', urgency: 'subtle' }], callbacks: [{ reference: 'Bel', instruction: 'x' }] }, reportFor('Art', 'Bell'));
    expect(short.arcDirections!.map((a) => a.arcName)).toEqual(['a', 'Art']);
    expect(short.callbacks!.map((c) => c.reference)).toEqual(['Bel', 'Bell']);
    // Russian: a name inside a longer word is another word (Ворон / Воронеж).
    const ru = enrichFromMomentum({ ...base, arcDirections: [{ arcName: 'Дорога на Воронеж', instruction: 'x', urgency: 'subtle' }] }, reportFor('Ворон', 'Перо'));
    expect(ru.arcDirections!.map((a) => a.arcName)).toEqual(['Дорога на Воронеж', 'Ворон']);
  });

  test('a whole word, inflected, counts (D-117): "письмом сестры" directs "Письмо сестры"; "Art" in "the art of lying" too', () => {
    const planned: NarratorDirective = {
      ...base,
      arcDirections: [{ arcName: 'Сцена с письмом сестры', instruction: 'моё', urgency: 'subtle' }],
      callbacks: [{ reference: 'о старом колоколе', instruction: 'моё' }],
    };
    expect(enrichFromMomentum(planned, reportFor('Письмо сестры', 'Старый колокол'))).toEqual(planned);
    const en: NarratorDirective = { ...base, arcDirections: [{ arcName: 'The art of lying', instruction: 'x', urgency: 'subtle' }] };
    expect(enrichFromMomentum(en, reportFor('Art', 'Bell')).arcDirections).toEqual(en.arcDirections!);
    // A CJK name has no spaces to find words by: it matches as a folded substring.
    const zh: NarratorDirective = { ...base, arcDirections: [{ arcName: '关于灯塔的秘密', instruction: 'x', urgency: 'subtle' }] };
    expect(enrichFromMomentum(zh, reportFor('灯塔', 'Bell')).arcDirections).toEqual(zh.arcDirections!);
  });

  test('two forced arcs whose names contain each other both get a direction', () => {
    // Changed: Bunraku also compared with the entries it had just added, so "The Bell Tower" was lost
    // behind "The Bell"; forced arcs are distinct by id, so only the planner's entries are compared.
    const state = stateOf({
      arcs: [arcOf({ id: 'arc-1', title: 'The Bell', lastProgressTurn: 0 }), arcOf({ id: 'arc-2', title: 'The Bell Tower', lastProgressTurn: 1 })],
      lastPlantTurn: 40,
    });
    const out = enrichFromMomentum(base, computeMomentum(state, 40));
    expect(out.arcDirections!.map((a) => a.arcName)).toEqual(['The Bell', 'The Bell Tower']);
  });

  test('the lists stay within READ_LIMITS.directiveList, the most overdue added first, the planner’s entries kept', () => {
    const max = READ_LIMITS.directiveList;
    expect(max).toBe(12);
    const arcs = Array.from({ length: 4 }, (_, i) => arcOf({ id: `arc-${i + 1}`, title: `Overdue ${i + 1}`, lastProgressTurn: i }));
    const seeds = Array.from({ length: 4 }, (_, i) => seedOf({ id: `seed-${i + 1}`, hint: `Ripe ${i + 1}`, plantedAtTurn: i, reinforcements: two }));
    const r = computeMomentum(stateOf({ arcs, seeds }), 40);
    const planned: NarratorDirective = {
      ...base,
      arcDirections: Array.from({ length: max - 1 }, (_, i) => ({ arcName: `Mine ${i}`, instruction: 'x', urgency: 'subtle' as const })),
      callbacks: Array.from({ length: max - 2 }, (_, i) => ({ reference: `Mine ${i}`, instruction: 'x' })),
    };
    const out = enrichFromMomentum(planned, r);
    expect(out.arcDirections).toHaveLength(max);
    expect(out.arcDirections!.slice(0, max - 1)).toEqual(planned.arcDirections!);
    expect(out.arcDirections![max - 1]!.arcName).toBe('Overdue 1');
    expect(out.callbacks!.map((c) => c.reference).slice(max - 2)).toEqual(['Ripe 1', 'Ripe 2']);
    const full: NarratorDirective = { ...base, arcDirections: Array.from({ length: max }, (_, i) => ({ arcName: `Mine ${i}`, instruction: 'x', urgency: 'subtle' as const })) };
    expect(enrichFromMomentum(full, r).arcDirections).toEqual(full.arcDirections!);
  });

  test('every forced arc is added, not only the ten the report shows', () => {
    const arcs = Array.from({ length: 11 }, (_, i) => arcOf({ id: `arc-${i + 1}`, title: `Overdue ${i + 1}`, lastProgressTurn: 0 }));
    const out = enrichFromMomentum(base, computeMomentum(stateOf({ arcs, lastPlantTurn: 40 }), 40));
    expect(out.arcDirections).toHaveLength(11);
  });

  test('pure: frozen inputs are not changed and the output shares no added list with them', () => {
    const r = deepFreeze(report());
    const planned = deepFreeze<NarratorDirective>({
      ...base,
      include: { characters: ['Zorya'] },
      arcDirections: [{ arcName: 'Elsewhere', instruction: 'x', urgency: 'subtle' }],
    });
    const before = JSON.stringify(planned);
    const out = enrichFromMomentum(planned, r);
    expect(JSON.stringify(planned)).toBe(before);
    expect(out.arcDirections).not.toBe(planned.arcDirections);
    expect(out.arcDirections).toHaveLength(2);
    expect(enrichFromMomentum(planned, r)).toEqual(out);
  });

  test('no added text names commit_planning_round', () => {
    const out = enrichFromMomentum(base, report());
    expect(JSON.stringify(out)).not.toContain('commit_planning_round');
  });
});
