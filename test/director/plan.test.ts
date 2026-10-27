// Ported from Bunraku:src/core/director/plan-round.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: reading the planning command's arguments) and the hasDirectiveContent vectors of
// RoleCall:apps/rc/src/lib/ai/dm-stream/DirectiveBuilder.ts@fb8dc623e (Coneja-Chibi; the function had
// no test there, the vectors are .notes research rolecall.md §9.4).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/director/plan.ts: PLAN_SCHEMA / PLAN_SCHEMA_LITE, readPlan, hasDirectiveContent.
// Bunraku's cases keep their names where they still apply. Changed by D-62 / D-107: there is no tool
// wrapper and the root requires only `directive`; 4 of the 7 directive refusals flip to accepted;
// a seed with no or an unknown action is skipped (not reinforced); a missing chapter title is ''
// (not "The Story Begins"); texts are cut at 300 (not 1 200); everything dropped is in `skipped`.
import { describe, expect, test } from 'bun:test';
import { PLAN_SCHEMA, PLAN_SCHEMA_LITE, hasDirectiveContent, readPlan } from '../../src/agents/director/plan.ts';
import {
  ARC_PRIORITIES,
  ARC_STATUSES,
  ARC_TYPES,
  CHAPTER_ACTIONS,
  CHAPTER_STATUSES,
  HIDDEN_ACTIONS,
  HIDDEN_ARC_TYPES,
  HIDDEN_STATUSES,
  HORIZONS,
  INTENTION_PRIORITIES,
  INTENTION_TARGETS,
  PACINGS,
  READ_LIMITS,
  SCOPES,
  SEED_ACTIONS,
  STATE_LIMITS,
  URGENCIES,
  type NarratorDirective,
  type PlanningRound,
  type Skip,
} from '../../src/agents/director/types.ts';

type Rec = Record<string, unknown>;

const ok = (over: Rec = {}): Rec => ({
  directive: { mood: 'tense', pacing: 'slow' },
  arcUpdates: [],
  seedUpdates: [],
  invisibleArcUpdates: [],
  analysis: {},
  chapterUpdate: { action: 'none', title: 'x' },
  ...over,
});

/** readPlan that must succeed. */
function read(raw: unknown, lite = false): { round: PlanningRound; skipped: Skip[] } {
  const r = readPlan(raw, { lite });
  if (!r.ok) throw new Error(`expected a plan, got ${r.code}: ${r.message}`);
  return { round: r.value, skipped: r.skipped };
}

/** Walks a schema: `at(s, 'properties', 'directive')`. */
function at(schema: unknown, ...path: string[]): Rec {
  let x = schema;
  for (const k of path) x = (x as Rec)[k];
  return x as Rec;
}

const props = (schema: unknown, ...path: string[]): string[] => Object.keys(at(schema, ...path, 'properties'));

describe('the schema', () => {
  // Was "it is the one forced command, its required fields are the six sections, and the dossier
  // field is gone": no tool wrapper any more and only the directive is required (D-107, plan.ts).
  test('the plan has the six sections, only the directive is required, and the dossier field is gone', () => {
    expect(PLAN_SCHEMA['type']).toBe('object');
    expect(props(PLAN_SCHEMA)).toEqual(['directive', 'arcUpdates', 'seedUpdates', 'invisibleArcUpdates', 'analysis', 'chapterUpdate']);
    expect(PLAN_SCHEMA['required']).toEqual(['directive']);
    for (const s of [PLAN_SCHEMA, PLAN_SCHEMA_LITE]) {
      const json = JSON.stringify(s);
      expect(json).not.toMatch(/dossier|batch_update|set_directive|update_analysis|commit_planning_round/);
      expect(json).not.toContain(String.fromCharCode(0x2014));
      expect(json).not.toContain('additionalProperties');
    }
  });

  test('D-62: the directive requires nothing; mood and pacing are optional', () => {
    expect(at(PLAN_SCHEMA, 'properties', 'directive')['required']).toBeUndefined();
    expect(props(PLAN_SCHEMA, 'properties', 'directive')).toEqual([
      'mood',
      'pacing',
      'include',
      'avoid',
      'dialogueGuidance',
      'sceneGuidance',
      'endingHook',
      'arcDirections',
      'callbacks',
      'characterBeats',
      'narrativeGoal',
    ]);
    expect(JSON.stringify(PLAN_SCHEMA)).not.toContain('"focus"');
  });

  test('hidden-arc updates require only title and action; the fields rp-core does not store are gone', () => {
    const item = at(PLAN_SCHEMA, 'properties', 'invisibleArcUpdates', 'items');
    expect(item['required']).toEqual(['title', 'action']);
    expect(Object.keys(item['properties'] as Rec)).not.toContain('plannedBeats');
    expect(JSON.stringify(item)).not.toMatch(/plannedBeats|foreshadowingSeeds|relatedVisibleArcs|expectedSurfaceTurn/);
  });

  test('arc updates offer arcType (a new arc would always be side without it)', () => {
    expect(at(PLAN_SCHEMA, 'properties', 'arcUpdates', 'items', 'properties', 'arcType')['enum']).toEqual([...ARC_TYPES]);
  });

  test('every enum is the contract constant', () => {
    const p = (...path: string[]): unknown => at(PLAN_SCHEMA, 'properties', ...path)['enum'];
    expect(p('directive', 'properties', 'pacing')).toEqual([...PACINGS]);
    expect(p('directive', 'properties', 'arcDirections', 'items', 'properties', 'urgency')).toEqual([...URGENCIES]);
    expect(p('arcUpdates', 'items', 'properties', 'status')).toEqual([...ARC_STATUSES]);
    expect(p('arcUpdates', 'items', 'properties', 'horizon')).toEqual([...HORIZONS]);
    expect(p('arcUpdates', 'items', 'properties', 'priority')).toEqual([...ARC_PRIORITIES]);
    expect(p('seedUpdates', 'items', 'properties', 'action')).toEqual([...SEED_ACTIONS]);
    expect(p('seedUpdates', 'items', 'properties', 'scope')).toEqual([...SCOPES]);
    expect(p('invisibleArcUpdates', 'items', 'properties', 'action')).toEqual([...HIDDEN_ACTIONS]);
    expect(p('invisibleArcUpdates', 'items', 'properties', 'status')).toEqual([...HIDDEN_STATUSES]);
    expect(p('invisibleArcUpdates', 'items', 'properties', 'arcType')).toEqual([...HIDDEN_ARC_TYPES]);
    expect(p('analysis', 'properties', 'intentions', 'items', 'properties', 'priority')).toEqual([...INTENTION_PRIORITIES]);
    expect(p('analysis', 'properties', 'intentions', 'items', 'properties', 'targetTurn')).toEqual([...INTENTION_TARGETS]);
    expect(p('chapterUpdate', 'properties', 'action')).toEqual([...CHAPTER_ACTIONS]);
    expect(p('chapterUpdate', 'properties', 'status')).toEqual([...CHAPTER_STATUSES]);
  });

  // The structured transport sends the schema as response_format json_schema (non-strict); keep it
  // to the subset every OpenAI-compatible server and llama.cpp's grammar converter take.
  test.each([
    ['full', PLAN_SCHEMA],
    ['lite', PLAN_SCHEMA_LITE],
  ])('the %s schema uses only the portable JSON Schema subset', (_name, schema) => {
    const KEYWORDS = new Set(['type', 'properties', 'items', 'required', 'enum', 'description', 'maxItems']);
    const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
    const walk = (s: Rec, path: string): void => {
      for (const k of Object.keys(s)) expect(KEYWORDS.has(k) ? k : `${path}: ${k}`).toBe(k);
      expect(TYPES.has(String(s['type'])) ? 'ok' : `${path}: type ${String(s['type'])}`).toBe('ok');
      if (s['type'] === 'object') {
        const p = (s['properties'] ?? {}) as Rec;
        for (const r of (s['required'] ?? []) as string[]) expect(Object.keys(p)).toContain(r);
        for (const [k, v] of Object.entries(p)) walk(v as Rec, `${path}.${k}`);
      }
      if (s['type'] === 'array') walk(s['items'] as Rec, `${path}[]`);
      if (s['enum'] !== undefined) for (const e of s['enum'] as unknown[]) expect(typeof e).toBe('string');
      if (s['maxItems'] !== undefined) expect(s['type']).toBe('array');
    };
    walk(schema, '$');
    expect(() => JSON.parse(JSON.stringify(schema))).not.toThrow();
  });

  test('the lite schema is the §7.3 subset: smaller directive with 3/3/2 lists, no shadow arcs, ≤ 3 intentions', () => {
    const L = PLAN_SCHEMA_LITE;
    expect(L['required']).toEqual(['directive']);
    expect(props(L)).toEqual(['directive', 'arcUpdates', 'seedUpdates', 'analysis', 'chapterUpdate']);
    expect(props(L, 'properties', 'directive').sort()).toEqual(
      ['mood', 'pacing', 'narrativeGoal', 'sceneGuidance', 'endingHook', 'arcDirections', 'characterBeats', 'callbacks'].sort(),
    );
    expect(at(L, 'properties', 'directive', 'properties', 'arcDirections')['maxItems']).toBe(3);
    expect(at(L, 'properties', 'directive', 'properties', 'characterBeats')['maxItems']).toBe(3);
    expect(at(L, 'properties', 'directive', 'properties', 'callbacks')['maxItems']).toBe(2);
    expect(props(L, 'properties', 'arcUpdates', 'items').sort()).toEqual(
      ['arcId', 'title', 'status', 'arcType', 'horizon', 'newStageTitle', 'nextBeat', 'markNextBeatDelivered'].sort(),
    );
    // No newStageDescription in lite, so its title must not demand one.
    expect(String(at(L, 'properties', 'arcUpdates', 'items', 'properties', 'newStageTitle')['description'])).not.toContain('newStageDescription');
    expect(props(L, 'properties', 'seedUpdates', 'items').sort()).toEqual(['id', 'title', 'action', 'description', 'payoffHorizon', 'outcome'].sort());
    expect(at(L, 'properties', 'seedUpdates', 'items')['required']).toEqual(['title', 'action']);
    expect(props(L, 'properties', 'analysis')).toEqual(['whatHappened', 'intentions']);
    expect(at(L, 'properties', 'analysis', 'properties', 'intentions')['maxItems']).toBe(3);
    expect(props(L, 'properties', 'chapterUpdate')).toEqual(['action', 'title', 'description']);
    expect(JSON.stringify(L).length).toBeLessThan(JSON.stringify(PLAN_SCHEMA).length * 0.7);
    // The shared field texts are the full schema's.
    expect(at(L, 'properties', 'directive', 'properties', 'endingHook')).toEqual(at(PLAN_SCHEMA, 'properties', 'directive', 'properties', 'endingHook'));
  });
});

describe('the directive', () => {
  // Still refused under D-62: no directive object, or one with no content.
  test.each([[null], ['x'], [{}]])('a directive of %j refuses the round', (directive) => {
    const r = readPlan(ok({ directive }), { lite: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('missing_directive');
  });

  // FLIPPED by D-62 (each was refused in Bunraku): a directive is refused only when it has no content.
  test.each([
    // pacing absent → 'medium'; mood alone is content.
    [{ mood: 'tense' }, { mood: 'tense', pacing: 'medium' }],
    // an explicit pacing other than 'medium' is content; mood may be absent.
    [{ pacing: 'slow' }, { pacing: 'slow' }],
    // an invalid pacing → 'medium' (and a skip).
    [{ mood: 'tense', pacing: 'sluggish' }, { mood: 'tense', pacing: 'medium' }],
    // a blank mood is absent; the pacing carries the directive.
    [{ mood: '  ', pacing: 'slow' }, { pacing: 'slow' }],
  ])('D-62: a directive of %j is accepted', (directive, expected) => {
    expect(read(ok({ directive })).round.directive).toEqual(expected as NarratorDirective);
  });

  test('arguments that are not an object refuse the round', () => {
    for (const raw of ['nope', null, [], undefined, 42]) {
      const r = readPlan(raw, { lite: false });
      expect(r).toEqual({ ok: false, code: 'invalid', message: 'the plan is not a JSON object' });
    }
  });

  test('a whole directive is kept field by field; empty groups and malformed entries are left out; texts and lists are bounded', () => {
    const { round, skipped } = read(
      ok({
        directive: {
          mood: 'm',
          pacing: 'fast',
          include: { characters: ['A', '', 3, 'B'], themes: [] },
          avoid: {},
          endingHook: 'h'.repeat(2_000),
          narrativeGoal: 'g',
          arcDirections: [{ arcName: 'Arc', instruction: 'do', urgency: 'forceful' }, { arcName: 'NoInstruction' }, { arcName: 'Arc2', instruction: 'x', urgency: 'loud' }],
          callbacks: [{ reference: 'r', instruction: 'i' }, { reference: 'only' }],
          characterBeats: [{ character: 'A', beat: 'b', motivation: 'why' }, { character: 'B' }],
          dialogueGuidance: [{ character: 'A', tone: 'dry', hints: ['x'] }, { character: 'B' }],
          sceneGuidance: { setting: 's', tension_level: 99 },
        },
      }),
    );
    const d = round.directive;
    expect(d.include).toEqual({ characters: ['A', 'B'] });
    expect(d.avoid).toBeUndefined();
    // Bunraku cut at 1 200; §7.3 / D-107 cut every text at 300.
    expect(d.endingHook).toHaveLength(STATE_LIMITS.text);
    expect(d.arcDirections).toEqual([
      { arcName: 'Arc', instruction: 'do', urgency: 'forceful' },
      { arcName: 'Arc2', instruction: 'x', urgency: 'moderate' },
    ]);
    expect(d.callbacks).toEqual([{ reference: 'r', instruction: 'i' }]);
    expect(d.characterBeats).toEqual([{ character: 'A', beat: 'b', motivation: 'why' }]);
    expect(d.dialogueGuidance).toEqual([{ character: 'A', tone: 'dry', hints: ['x'] }]);
    expect(d.sceneGuidance).toEqual({ setting: 's', tension_level: 10 });
    // rp-core: every drop and change is in `skipped` [D-60], in the order of the answer.
    expect(skipped).toEqual([
      { path: 'directive.include.characters[2]', why: 'not a string' },
      { path: 'directive.dialogueGuidance[1]', why: 'no tone' },
      { path: 'directive.sceneGuidance.tension_level', why: 'clamped to 10' },
      { path: 'directive.endingHook', why: 'cut to 300 chars' },
      { path: 'directive.arcDirections[1]', why: 'no instruction' },
      { path: 'directive.arcDirections[2].urgency', why: 'unknown value "loud"' },
      { path: 'directive.callbacks[1]', why: 'no instruction' },
      { path: 'directive.characterBeats[1]', why: 'no beat' },
    ]);
  });

  test('the refusal message names what was wrong, for the correction pass', () => {
    const r = readPlan(ok({ directive: { focus: 'the door', mood: 7 } }), { lite: false });
    expect(r).toEqual({
      ok: false,
      code: 'missing_directive',
      message: 'the directive sets no usable field (focus: unknown key; mood: not a string)',
    });
    expect(readPlan({ mood: 'tense' }, { lite: false })).toEqual({
      ok: false,
      code: 'missing_directive',
      message: 'the plan has no directive (mood: unknown key)',
    });
    const s = readPlan({ directive: 'tense' }, { lite: false });
    expect(s.ok === false && s.message.startsWith('the directive is not a JSON object')).toBe(true);
    // Also when the skip list is already full.
    const junk = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const f = readPlan({ ...junk, directive: 'tense' }, { lite: false });
    expect(f.ok === false && f.message.startsWith('the directive is not a JSON object')).toBe(true);
  });
});

describe('the other sections', () => {
  test('a bare-string analysis is the account of what happened; string intentions become intentions', () => {
    expect(read(ok({ analysis: 'They argued.' })).round.analysis).toEqual({ whatHappened: 'They argued.' });
    const { round, skipped } = read(
      ok({ analysis: { intentions: ['Raise the stakes', { description: 'Slow down', priority: 'must', targetTurn: 'soon' }, { nope: 1 }] } }),
    );
    // D-107: intentions are complete DirectorIntentions (Bunraku apply.ts:89 defaults), in the order sent.
    expect(round.analysis.intentions).toEqual([
      { type: 'advance_arc', description: 'Raise the stakes', priority: 'should', targetTurn: 'next' },
      { type: 'advance_arc', description: 'Slow down', priority: 'must', targetTurn: 'soon' },
    ]);
    expect(skipped).toEqual([
      { path: 'analysis.intentions[2].nope', why: 'unknown key' },
      { path: 'analysis.intentions[2]', why: 'no description' },
    ]);
  });

  test('intentions keep their order (Bunraku put string items first)', () => {
    const { round } = read(ok({ analysis: { intentions: [{ description: 'first', type: 'reveal' }, 'second', { description: 'third', targetTurn: 'Eventually' }] } }));
    expect(round.analysis.intentions?.map((i) => [i.type, i.description, i.targetTurn])).toEqual([
      ['reveal', 'first', 'next'],
      ['advance_arc', 'second', 'next'],
      ['advance_arc', 'third', 'eventually'],
    ]);
  });

  test('arc updates need an id or a title; a horizon given as short-term is short; a next beat\'s target turn is coerced; a bad status is dropped, not the update', () => {
    const { round, skipped } = read(
      ok({
        arcUpdates: [
          { arcId: 'arc-1', status: 'climax', horizon: 'short-term', nextBeat: { description: 'The door opens', targetTurn: '12' }, markNextBeatDelivered: true },
          { title: 'A new thread', status: 'sideways' },
          { description: 'no identity' },
          'junk',
        ],
      }),
    );
    expect(round.arcUpdates).toEqual([
      { arcId: 'arc-1', status: 'climax', horizon: 'short', nextBeat: { description: 'The door opens', targetTurn: 12 }, markNextBeatDelivered: true },
      { arcId: 'A new thread', title: 'A new thread' },
    ]);
    expect(skipped).toEqual([
      { path: 'arcUpdates[1].status', why: 'unknown value "sideways"' },
      { path: 'arcUpdates[2]', why: 'no arcId, id or title' },
      { path: 'arcUpdates[3]', why: 'a string that is not a JSON object' },
    ]);
  });

  test('the arc key is arcId, else id, else title; an empty arcId falls through', () => {
    const { round } = read(ok({ arcUpdates: [{ id: 'arc-2' }, { arcId: '', title: 'Fresh' }, { arcId: 'arc-3', id: 'arc-9', title: 'T' }] }));
    expect(round.arcUpdates.map((u) => u.arcId)).toEqual(['arc-2', 'Fresh', 'arc-3']);
  });

  // FLIPPED by D-107 (Bunraku: "a seed update with no action reinforces; with an unknown action it
  // reinforces too, and one with no title is dropped"): a seed without a valid action is skipped,
  // because reinforcing a seed that was meant to be planted silently lost it.
  test('a seed update with no action or an unknown one is skipped, one with no title is dropped, and the action is case-fixed', () => {
    const { round, skipped } = read(
      ok({ seedUpdates: [{ title: 'Bell' }, { title: 'Key', action: 'PLANT', payoffHorizon: 'epic' }, { action: 'plant' }, { title: 'Lamp', action: 'water' }] }),
    );
    expect(round.seedUpdates).toEqual([{ title: 'Key', action: 'plant', payoffHorizon: 'epic' }]);
    expect(skipped).toEqual([
      { path: 'seedUpdates[0]', why: 'no action' },
      { path: 'seedUpdates[2]', why: 'no title' },
      { path: 'seedUpdates[3]', why: 'action: unknown value "water"' },
    ]);
  });

  test('a hidden-arc update needs a title and a known action', () => {
    const { round, skipped } = read(
      ok({ invisibleArcUpdates: [{ title: 'Cabal', action: 'add', plannedBeats: [{ description: 'meet' }, { completed: true }] }, { title: 'No action' }, { action: 'add' }] }),
    );
    // plannedBeats are not stored in rp-core (D-61): an unknown key, skipped.
    expect(round.invisibleArcUpdates).toEqual([{ title: 'Cabal', action: 'add' }]);
    expect(skipped).toEqual([
      { path: 'invisibleArcUpdates[0].plannedBeats', why: 'unknown key' },
      { path: 'invisibleArcUpdates[1]', why: 'no action' },
      { path: 'invisibleArcUpdates[2]', why: 'no title' },
    ]);
  });

  // CHANGED by D-107 (Bunraku: "the chapter decision defaults to none with the story's first
  // title"): the title stays '' when the model sent none; the reducer names a first chapter.
  test('the chapter decision defaults to none with an empty title', () => {
    const { round, skipped } = read(ok({ chapterUpdate: 'start please' }));
    expect(round.chapterUpdate).toEqual({ action: 'none', title: '' });
    expect(skipped).toEqual([{ path: 'chapterUpdate', why: 'a string that is not a JSON object' }]);
    const { round: none } = read({ directive: { mood: 'tense' } });
    expect(none.chapterUpdate).toEqual({ action: 'none', title: '' });
  });

  test('a full chapter update is read whole', () => {
    const { round, skipped } = read(
      ok({
        chapterUpdate: {
          action: 'Start_New',
          title: 'The Bell Tower',
          description: 'premise',
          status: 'active',
          themes: ['duty'],
          objectives: ['ring it'],
          tone: 'grim',
          closingMoment: 'the rope snaps',
        },
      }),
    );
    expect(round.chapterUpdate).toEqual({
      action: 'start_new',
      title: 'The Bell Tower',
      description: 'premise',
      status: 'active',
      themes: ['duty'],
      objectives: ['ring it'],
      tone: 'grim',
      closingMoment: 'the rope snaps',
    });
    expect(skipped).toEqual([]);
  });
});

describe('hasDirectiveContent', () => {
  const d = (over: Partial<NarratorDirective>): NarratorDirective => ({ pacing: 'medium', ...over });

  // rolecall.md §9.4 vectors; RoleCall's own function counted an absent pacing and {} sceneGuidance.
  test.each([
    ['an explicit fast pacing', d({ pacing: 'fast' }), true, true],
    ['an explicit medium pacing', d({ pacing: 'medium' }), true, false],
    ['nothing', d({}), false, false],
    ['an empty sceneGuidance', d({ sceneGuidance: {} }), false, false],
    ['an ending hook', d({ endingHook: 'x' }), false, true],
    ['an avoid with only empty lists', d({ avoid: { topics: [] } }), false, false],
    ['an empty mood', d({ mood: '' }), false, false],
    ['a blank mood', d({ mood: '   ' }), false, false],
    ['a fast pacing the model did not send', d({ pacing: 'fast' }), false, false],
    ['tension 0 (a set field)', d({ sceneGuidance: { tension_level: 0 } }), false, true],
    ['an include with a theme', d({ include: { themes: ['x'] } }), false, true],
    ['an include with only blank names', d({ include: { characters: [' '] } }), false, false],
    ['a dialogue line', d({ dialogueGuidance: [{ character: 'A', tone: 'dry' }] }), false, true],
    ['an arc direction', d({ arcDirections: [{ arcName: 'a', instruction: 'b', urgency: 'subtle' }] }), false, true],
    ['a callback', d({ callbacks: [{ reference: 'a', instruction: 'b' }] }), false, true],
    ['a character beat', d({ characterBeats: [{ character: 'a', beat: 'b' }] }), false, true],
    ['a narrative goal', d({ narrativeGoal: 'g' }), false, true],
    ['empty lists', d({ arcDirections: [], callbacks: [], characterBeats: [], dialogueGuidance: [] }), false, false],
  ])('%s → content %p/%p', (_name, directive, pacingSent, expected) => {
    expect(hasDirectiveContent(directive, pacingSent)).toBe(expected);
  });

  test('readPlan refuses exactly what hasDirectiveContent rejects', () => {
    expect(readPlan({ directive: { pacing: 'medium' } }, { lite: false }).ok).toBe(false);
    expect(readPlan({ directive: { pacing: 'MEDIUM', sceneGuidance: {} } }, { lite: false }).ok).toBe(false);
    expect(readPlan({ directive: { pacing: 'Breakneck' } }, { lite: false }).ok).toBe(true);
    expect(readPlan({ directive: { sceneGuidance: { tension_level: '0' } } }, { lite: false }).ok).toBe(true);
  });
});

describe('limits', () => {
  test('sections hold at most 40 entries, directive lists 12, intentions 10; the rest is one skip each', () => {
    const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
    const { round, skipped } = read(
      ok({
        directive: {
          mood: 'm',
          arcDirections: many(15, (i) => ({ arcName: `a${i}`, instruction: 'x' })),
          include: { themes: many(13, (i) => `t${i}`) },
        },
        arcUpdates: many(45, (i) => ({ arcId: `arc-${i}` })),
        analysis: { intentions: many(12, (i) => `i${i}`) },
      }),
    );
    expect(round.directive.arcDirections).toHaveLength(READ_LIMITS.directiveList);
    expect(round.directive.include?.themes).toHaveLength(READ_LIMITS.directiveList);
    expect(round.arcUpdates).toHaveLength(READ_LIMITS.sectionEntries);
    expect(round.analysis.intentions).toHaveLength(READ_LIMITS.intentionsRead);
    expect(skipped).toEqual([
      { path: 'directive.include.themes', why: '1 over the limit of 12' },
      { path: 'directive.arcDirections', why: '3 over the limit of 12' },
      { path: 'arcUpdates', why: '5 over the limit of 40' },
      { path: 'analysis.intentions', why: '2 over the limit of 10' },
    ]);
  });

  test('an arc title is cut at 80, other texts at 300, never inside a surrogate pair', () => {
    const { round } = read(ok({ arcUpdates: [{ title: `${'x'.repeat(79)}😀tail`, description: `${'y'.repeat(299)}😀` }] }));
    const u = round.arcUpdates[0]!;
    expect(u.title).toBe('x'.repeat(79));
    expect(u.arcId).toBe('x'.repeat(79));
    expect(u.description).toBe('y'.repeat(299));
  });
});
