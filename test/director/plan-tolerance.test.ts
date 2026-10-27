// Ported from RoleCall:apps/rc/src/lib/ai/dm-stream/tools/__tests__/arcUpdates-string-tolerance.test.ts,
// dm-stream/__tests__/dm-schema-tolerance-prod-models.test.ts and the reading part of
// dm-stream/__tests__/cremecafe-glm-thinking-undefined-content.test.ts@fb8dc623e (Coneja-Chibi: the
// prod-log symptoms of drifting Director models).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// readPlan's tolerance (D-62, D-107). RoleCall's cases are rewritten for readPlan: where RoleCall
// rejected a whole call, rp-core empties that section and records a skip (only the directive is
// strict); where RoleCall invented a neutral mood, rp-core leaves mood absent; where its zod dropped an
// arc direction with a bad urgency, rp-core keeps it as 'moderate'. Each changed expectation says so.
// Then every row of the tolerance matrix (.notes research rolecall.md §1.2) with the rp-core outcome,
// the lite caps, the skipped cap, Russian text, and a deterministic never-throws sweep.
import { describe, expect, test } from 'bun:test';
import { readPlan } from '../../src/agents/director/plan.ts';
import { READ_LIMITS, STATE_LIMITS, type PlanningRound, type ReadResult, type Skip } from '../../src/agents/director/types.ts';

type Rec = Record<string, unknown>;

const plan = (over: Rec = {}): Rec => ({
  directive: { mood: 'tense' },
  arcUpdates: [],
  seedUpdates: [],
  invisibleArcUpdates: [],
  analysis: {},
  chapterUpdate: { action: 'none', title: 'x' },
  ...over,
});
const withDirective = (d: Rec): Rec => plan({ directive: d });

function read(raw: unknown, lite = false): { round: PlanningRound; skipped: Skip[] } {
  const r = readPlan(raw, { lite });
  if (!r.ok) throw new Error(`expected a plan, got ${r.code}: ${r.message}`);
  return { round: r.value, skipped: r.skipped };
}
const refused = (raw: unknown): ReadResult<PlanningRound> & { ok: false } => {
  const r = readPlan(raw, { lite: false });
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.value.directive)}`);
  return r;
};
const paths = (skipped: Skip[]): string[] => skipped.map((s) => s.path);

// ---- RoleCall arcUpdates-string-tolerance ---------------------------------------------------------

describe('a section sent as a JSON string (RoleCall arcUpdates-string-tolerance)', () => {
  test('a JSON-string array for arcUpdates is parsed and accepted (the prod symptom)', () => {
    const { round, skipped } = read(plan({ arcUpdates: '[{"arcName":"main","action":"update","arcId":"arc-1"}]' }));
    expect(round.arcUpdates).toEqual([{ arcId: 'arc-1' }]);
    // RoleCall's test item used keys outside the plan schema: here they are visible, not silent.
    expect(skipped).toEqual([
      { path: 'arcUpdates[0].arcName', why: 'unknown key' },
      { path: 'arcUpdates[0].action', why: 'unknown key' },
    ]);
  });

  test("an empty JSON-string array '[]' is parsed and accepted", () => {
    expect(read(plan({ arcUpdates: '[]' }))).toEqual({ round: read(plan()).round, skipped: [] });
  });

  // CHANGED: RoleCall rejected the whole call; rp-core keeps the plan, empties the section, records it.
  test("a malformed JSON string ('{not json') for an array param still rejects (no silent swallow)", () => {
    const { round, skipped } = read(plan({ arcUpdates: '{not json' }));
    expect(round.arcUpdates).toEqual([]);
    expect(skipped).toEqual([{ path: 'arcUpdates', why: 'a string that is not a JSON list' }]);
  });

  // CHANGED: as above, the section is empty and skipped, the plan survives.
  test("a JSON-string of a non-array value ('foo' / '42') rejects - type still mismatched", () => {
    for (const s of ['"foo"', '42', 'true']) {
      const { round, skipped } = read(plan({ arcUpdates: s }));
      expect(round.arcUpdates).toEqual([]);
      expect(skipped).toEqual([{ path: 'arcUpdates', why: 'a string that is not a JSON list' }]);
    }
  });

  test('a real array is unaffected by the coercion path (anti-regression)', () => {
    expect(read(plan({ arcUpdates: [{ arcId: 'main', status: 'building' }] })).round.arcUpdates).toEqual([{ arcId: 'main', status: 'building' }]);
  });

  test('string→object coercion ALSO works (analysis param sometimes arrives stringified too)', () => {
    const { round, skipped } = read(plan({ analysis: '{"whatHappened":"x","pacing":"medium"}' }));
    expect(round.analysis).toEqual({ whatHappened: 'x' });
    expect(skipped).toEqual([{ path: 'analysis.pacing', why: 'unknown key' }]);
  });
});

// ---- RoleCall dm-schema-tolerance-prod-models -----------------------------------------------------

describe('prod models drift on the directive (RoleCall dm-schema-tolerance-prod-models)', () => {
  // CHANGED (D-62): RoleCall returned mood 'neutral' + pacing 'medium'; an empty directive says
  // nothing, so rp-core refuses it and the correction pass asks again.
  test('missing mood + missing pacing → refused as missing_directive (gemini-flash-lite case)', () => {
    expect(refused(withDirective({})).code).toBe('missing_directive');
  });

  test('partial directive - mood present, pacing missing - keeps mood, defaults pacing', () => {
    const { round } = read(withDirective({ mood: 'tense', include: { themes: ['danger'] } }));
    expect(round.directive).toEqual({ mood: 'tense', pacing: 'medium', include: { themes: ['danger'] } });
  });

  test("invalid pacing string ('rapid') → coerce to default 'medium' with the directive otherwise valid", () => {
    const { round, skipped } = read(withDirective({ mood: 'tense', pacing: 'rapid' }));
    expect(round.directive).toEqual({ mood: 'tense', pacing: 'medium' });
    expect(skipped).toEqual([{ path: 'directive.pacing', why: 'unknown value "rapid"' }]);
  });

  // CHANGED (D-62): mood stays absent ('neutral' is never invented), so these directives are empty.
  test('mood as a non-string (number, null, array) → absent, never neutral', () => {
    for (const mood of [0, null, []]) expect(refused(withDirective({ mood })).code).toBe('missing_directive');
    const { round, skipped } = read(withDirective({ mood: 0, endingHook: 'a door creaks' }));
    expect(round.directive).toEqual({ pacing: 'medium', endingHook: 'a door creaks' });
    expect(JSON.stringify(round.directive)).not.toContain('neutral');
    expect(skipped).toEqual([{ path: 'directive.mood', why: 'not a string' }]);
  });

  test('VVS-130 shape ({type, description, energy, tone}) STILL rejects (anti-regression on real drift)', () => {
    const r = refused(withDirective({ type: 'scene', description: 'Two characters meet', energy: 'high', tone: 'tense' }));
    expect(r.code).toBe('missing_directive');
    // RoleCall's keyPreview: the message names the keys, so the correction pass can point at them.
    for (const k of ['type', 'description', 'energy', 'tone']) expect(r.message).toContain(k);
  });

  // CHANGED: these are directive values, not whole answers; the whole-answer case is below.
  test('non-object input (string, number, null, array) rejects', () => {
    for (const directive of ['a string', 42, null, [1, 2, 3]]) expect(refused(withDirective(directive as never)).code).toBe('missing_directive');
    for (const raw of ['a string', 42, null, [1, 2, 3]]) expect(readPlan(raw, { lite: false })).toMatchObject({ ok: false, code: 'invalid' });
  });

  test('nested optional structures (include/avoid/sceneGuidance) survive partial population', () => {
    const { round } = read(withDirective({ mood: 'calm', pacing: 'slow', include: { themes: ['forest'] }, sceneGuidance: { setting: 'twilight' } }));
    expect(round.directive).toEqual({ mood: 'calm', pacing: 'slow', include: { themes: ['forest'] }, sceneGuidance: { setting: 'twilight' } });
  });

  // CHANGED (§7.3, D-107): an unknown urgency is 'moderate', so both arcs are kept (RoleCall kept 1).
  test('arcDirections with invalid urgency value should NOT take down the whole directive', () => {
    const { round, skipped } = read(
      withDirective({
        mood: 'tense',
        pacing: 'fast',
        arcDirections: [
          { arcName: 'main', instruction: 'ratchet', urgency: 'forceful' },
          { arcName: 'side', instruction: 'tease', urgency: 'high' },
        ],
      }),
    );
    expect(round.directive.arcDirections).toEqual([
      { arcName: 'main', instruction: 'ratchet', urgency: 'forceful' },
      { arcName: 'side', instruction: 'tease', urgency: 'moderate' },
    ]);
    expect(skipped).toEqual([{ path: 'directive.arcDirections[1].urgency', why: 'unknown value "high"' }]);
  });

  test('the validator never throws for any input shape (defensive against unexpected DM output)', () => {
    const inputs: unknown[] = [undefined, null, '', 0, false, [], {}, { mood: undefined }, { pacing: undefined }, Object.create(null), new Date(), new Map()];
    for (const raw of inputs) {
      expect(() => readPlan(raw, { lite: false })).not.toThrow();
      expect(() => readPlan(withDirective(raw as never), { lite: true })).not.toThrow();
      expect(readPlan(withDirective(raw as never), { lite: false }).ok).toBe(false);
    }
  });
});

// ---- RoleCall cremecafe-glm-thinking-undefined-content (reading part) -----------------------------
// The rest of that file (no chapter lost when the answer is unusable) is runDirector's: a failed
// plan keeps the previous state with turn + 1 (D-105, integrate's tests).

describe('GLM-thinking malformed shapes (RoleCall cremecafe-glm-thinking-undefined-content)', () => {
  test('undefined response - does not throw a TypeError, returns a default output', () => {
    expect(readPlan(undefined, { lite: false })).toEqual({ ok: false, code: 'invalid', message: 'the plan is not a JSON object' });
  });

  test('null response - does not throw a TypeError, returns a default output', () => {
    expect(readPlan(null, { lite: false })).toMatchObject({ ok: false, code: 'invalid' });
  });

  test('empty-string response (model returned no text body) - does not throw', () => {
    expect(readPlan('', { lite: true })).toMatchObject({ ok: false, code: 'invalid' });
  });

  test('does not report empty legacy bridge objects as successful tool output', () => {
    // An empty directive with empty sections is not a plan.
    expect(refused({ directive: {}, arcUpdates: [], seedUpdates: [], invisibleArcUpdates: [], analysis: {}, chapterUpdate: {} }).code).toBe(
      'missing_directive',
    );
  });
});

// ---- the tolerance matrix (rolecall.md §1.2) -----------------------------------------------------

interface Row {
  input: string;
  raw: Rec;
  /** RoleCall's tool path → what rp-core does instead. */
  expect: (r: ReturnType<typeof readPlan>) => void;
}

const okWith = (check: (round: PlanningRound, skipped: Skip[]) => void) => (r: ReturnType<typeof readPlan>) => {
  if (!r.ok) throw new Error(`expected a plan, got ${r.code}: ${r.message}`);
  check(r.value, r.skipped);
};
const missing = (r: ReturnType<typeof readPlan>): void => {
  expect(r).toMatchObject({ ok: false, code: 'missing_directive' });
};

const MATRIX: Row[] = [
  // RC tool: L2 fills mood "", pacing "slow" (enum[0]) → zod neutral/slow. BR: refused.
  { input: 'directive: {}', raw: withDirective({}), expect: missing },
  { input: 'directive: ""', raw: plan({ directive: '' }), expect: missing },
  // RC: pacing "slow" (L2 enum[0]). BR: refused.
  {
    input: 'directive: {mood:"tense"} (no pacing)',
    raw: withDirective({ mood: 'tense' }),
    expect: okWith((p, s) => {
      expect(p.directive).toEqual({ mood: 'tense', pacing: 'medium' });
      expect(s).toEqual([]);
    }),
  },
  // RC: L2 case-fix. BR: refused (strict oneOf). rp-core: case-fixed silently.
  {
    input: 'pacing: "Fast"',
    raw: withDirective({ pacing: 'Fast' }),
    expect: okWith((p, s) => {
      expect(p.directive.pacing).toBe('fast');
      expect(s).toEqual([]);
    }),
  },
  // RC: zod → "medium". BR: refused. rp-core: 'medium', not content.
  {
    input: 'pacing: "rapid"',
    raw: withDirective({ mood: 'tense', pacing: 'rapid' }),
    expect: okWith((p, s) => {
      expect(p.directive.pacing).toBe('medium');
      expect(s).toEqual([{ path: 'directive.pacing', why: 'unknown value "rapid"' }]);
    }),
  },
  { input: 'pacing: "rapid" alone', raw: withDirective({ pacing: 'rapid' }), expect: missing },
  // RC: zod → "neutral". BR: refused. rp-core: absent.
  ...[0, null, [], ''].map(
    (mood): Row => ({
      input: `mood: ${JSON.stringify(mood)}`,
      raw: withDirective({ mood, narrativeGoal: 'g' }),
      expect: okWith((p) => expect(p.directive).toEqual({ pacing: 'medium', narrativeGoal: 'g' })),
    }),
  ),
  // RC: zod strips silently. BR: ignored. rp-core: skipped.
  {
    input: 'unknown keys (focus, horrorNote, include.sensory)',
    raw: withDirective({ mood: 'x', focus: 'y', horrorNote: 'z', include: { sensory: ['a'], themes: ['t'] } }),
    expect: okWith((p, s) => {
      expect(p.directive).toEqual({ mood: 'x', pacing: 'medium', include: { themes: ['t'] } });
      expect(paths(s)).toEqual(['directive.focus', 'directive.horrorNote', 'directive.include.sensory']);
    }),
  },
  // RC: L3 fails the whole call. BR: empty. rp-core: absent.
  {
    input: 'include / avoid / sceneGuidance: null',
    raw: withDirective({ mood: 'x', include: null, avoid: null, sceneGuidance: null }),
    expect: okWith((p, s) => {
      expect(p.directive).toEqual({ mood: 'x', pacing: 'medium' });
      expect(s).toEqual([]);
    }),
  },
  // RC: L3 / zod refuse the directive. BR: []. rp-core: absent.
  {
    input: 'arcDirections / dialogueGuidance: null',
    raw: withDirective({ mood: 'x', arcDirections: null, dialogueGuidance: null }),
    expect: okWith((p, s) => {
      expect(p.directive).toEqual({ mood: 'x', pacing: 'medium' });
      expect(s).toEqual([]);
    }),
  },
  // RC: L3 refuses. BR: empty. rp-core: looseJson fails to give an object → skipped.
  {
    input: 'include: "rain" (a string in an object slot)',
    raw: withDirective({ mood: 'x', include: 'rain' }),
    expect: okWith((p, s) => {
      expect(p.directive.include).toBeUndefined();
      expect(s).toEqual([{ path: 'directive.include', why: 'a string that is not a JSON object' }]);
    }),
  },
  {
    input: 'include: \'{"themes":["rain"]}\' (a JSON string in an object slot)',
    raw: withDirective({ include: '{"themes":["rain"]}' }),
    expect: okWith((p) => expect(p.directive.include).toEqual({ themes: ['rain'] })),
  },
  // RC: parsed. BR: [] (strings not parsed). rp-core: looseJson.
  {
    input: 'arcUpdates: "[{…}]"',
    raw: plan({ arcUpdates: '[{"arcId":"arc-1","status":"climax"}]' }),
    expect: okWith((p) => expect(p.arcUpdates).toEqual([{ arcId: 'arc-1', status: 'climax' }])),
  },
  // RC: refuses the whole call. BR: []. rp-core: skipped.
  {
    input: 'arcUpdates: "{not json"',
    raw: plan({ arcUpdates: '{not json' }),
    expect: okWith((p, s) => {
      expect(p.arcUpdates).toEqual([]);
      expect(paths(s)).toEqual(['arcUpdates']);
    }),
  },
  ...['foo', '42', 'true'].map(
    (v): Row => ({
      input: `arcUpdates: "${v}"`,
      raw: plan({ arcUpdates: v }),
      expect: okWith((p, s) => {
        expect(p.arcUpdates).toEqual([]);
        expect(paths(s)).toEqual(['arcUpdates']);
      }),
    }),
  ),
  // RC: [] (L2). BR: []. rp-core: [] and nothing skipped.
  ...['null', '', 'none', 'NONE'].map(
    (v): Row => ({
      input: `seedUpdates: ${JSON.stringify(v)}`,
      raw: plan({ seedUpdates: v }),
      expect: okWith((p, s) => {
        expect(p.seedUpdates).toEqual([]);
        expect(s).toEqual([]);
      }),
    }),
  ),
  // RC: {whatHappened} (L2 wrap). BR: {whatHappened}.
  {
    input: 'analysis: "prose…"',
    raw: plan({ analysis: 'The stranger left the inn.' }),
    expect: okWith((p) => expect(p.analysis).toEqual({ whatHappened: 'The stranger left the inn.' })),
  },
  // RC: parsed. BR: whatHappened = the JSON text. rp-core: decoded first.
  {
    input: 'analysis: \'{"whatHappened":"x"}\'',
    raw: plan({ analysis: '{"whatHappened":"x"}' }),
    expect: okWith((p) => expect(p.analysis).toEqual({ whatHappened: 'x' })),
  },
  {
    input: 'analysis: \'"x"\' (a JSON-quoted string)',
    raw: plan({ analysis: '"x"' }),
    expect: okWith((p) => expect(p.analysis).toEqual({ whatHappened: 'x' })),
  },
  // RC: L3 fails the whole call. BR: none + "The Story Begins". rp-core: none + ''.
  {
    input: 'no chapterUpdate',
    raw: { directive: { mood: 'x' } },
    expect: okWith((p, s) => {
      expect(p).toEqual({
        directive: { mood: 'x', pacing: 'medium' },
        arcUpdates: [],
        seedUpdates: [],
        invisibleArcUpdates: [],
        analysis: {},
        chapterUpdate: { action: 'none', title: '' },
      });
      expect(s).toEqual([]);
    }),
  },
  // RC: case-fix. BR: none. rp-core: case-fix.
  {
    input: 'chapterUpdate.action: "START_NEW"',
    raw: plan({ chapterUpdate: { action: 'START_NEW', title: 'Act II' } }),
    expect: okWith((p) => expect(p.chapterUpdate).toEqual({ action: 'start_new', title: 'Act II' })),
  },
  // RC: L2 "plant" (enum[0]). BR: "reinforce". rp-core: skipped.
  {
    input: 'seed without action',
    raw: plan({ seedUpdates: [{ title: 'Bell' }] }),
    expect: okWith((p, s) => {
      expect(p.seedUpdates).toEqual([]);
      expect(s).toEqual([{ path: 'seedUpdates[0]', why: 'no action' }]);
    }),
  },
  // RC: "" → executor "reinforce". BR: "reinforce". rp-core: skipped.
  {
    input: 'seed with action: null',
    raw: plan({ seedUpdates: [{ title: 'Bell', action: null }] }),
    expect: okWith((p, s) => {
      expect(p.seedUpdates).toEqual([]);
      expect(s).toEqual([{ path: 'seedUpdates[0]', why: 'no action' }]);
    }),
  },
  // RC: L2 case-fix. BR: lower-cased. rp-core: case-fix.
  {
    input: 'seed with action: "Plant"',
    raw: plan({ seedUpdates: [{ title: 'Bell', action: 'Plant' }] }),
    expect: okWith((p) => expect(p.seedUpdates).toEqual([{ title: 'Bell', action: 'plant' }])),
  },
  // RC: executor → reinforce. BR: reinforce. rp-core: skipped.
  {
    input: 'seed with an unknown action',
    raw: plan({ seedUpdates: [{ title: 'Bell', action: 'water' }] }),
    expect: okWith((p, s) => {
      expect(p.seedUpdates).toEqual([]);
      expect(s).toEqual([{ path: 'seedUpdates[0]', why: 'action: unknown value "water"' }]);
    }),
  },
  // RC: L2 ENUM_ALIASES → "player". BR: undefined. rp-core: field dropped, skipped (no alias table).
  ...['personal', 'personal-story', 'story'].map(
    (scope): Row => ({
      input: `seed scope: "${scope}"`,
      raw: plan({ seedUpdates: [{ title: 'Bell', action: 'plant', scope }] }),
      expect: okWith((p, s) => {
        expect(p.seedUpdates).toEqual([{ title: 'Bell', action: 'plant' }]);
        expect(s).toEqual([{ path: 'seedUpdates[0].scope', why: `unknown value "${scope}"` }]);
      }),
    }),
  ),
  // RC: zod drops the element. BR: "moderate". rp-core: "moderate".
  {
    input: 'arcDirection with urgency: "high"',
    raw: withDirective({ arcDirections: [{ arcName: 'a', instruction: 'b', urgency: 'high' }] }),
    expect: okWith((p) => expect(p.directive.arcDirections).toEqual([{ arcName: 'a', instruction: 'b', urgency: 'moderate' }])),
  },
  // RC: L2 "subtle" (enum[0]). BR: "moderate". rp-core: "moderate", nothing skipped.
  {
    input: 'arcDirection without urgency',
    raw: withDirective({ arcDirections: [{ arcName: 'a', instruction: 'b' }] }),
    expect: okWith((p, s) => {
      expect(p.directive.arcDirections).toEqual([{ arcName: 'a', instruction: 'b', urgency: 'moderate' }]);
      expect(s).toEqual([]);
    }),
  },
  // RC: tone "" accepted, renders "  NPC: ". BR: dropped. rp-core: skipped.
  {
    input: 'dialogueGuidance without tone',
    raw: withDirective({ mood: 'x', dialogueGuidance: [{ character: 'NPC' }] }),
    expect: okWith((p, s) => {
      expect(p.directive.dialogueGuidance).toBeUndefined();
      expect(s).toEqual([{ path: 'directive.dialogueGuidance[0]', why: 'no tone' }]);
    }),
  },
  // RC (text path): zod refuses the whole directive. BR: element dropped. rp-core: element skipped.
  {
    input: 'one bad element of dialogueGuidance / callbacks / characterBeats',
    raw: withDirective({
      dialogueGuidance: [{ character: 'A', tone: 'dry' }, { character: 'B', tone: 5 }],
      callbacks: [{ reference: 'bell' }, { reference: 'ring', instruction: 'echo it' }],
      characterBeats: [{ beat: 'doubt' }, { character: 'C', beat: 'resolve' }],
    }),
    expect: okWith((p, s) => {
      expect(p.directive.dialogueGuidance).toEqual([{ character: 'A', tone: 'dry' }]);
      expect(p.directive.callbacks).toEqual([{ reference: 'ring', instruction: 'echo it' }]);
      expect(p.directive.characterBeats).toEqual([{ character: 'C', beat: 'resolve' }]);
      expect(s).toEqual([
        { path: 'directive.dialogueGuidance[1]', why: 'tone is not a string' },
        { path: 'directive.callbacks[0]', why: 'no instruction' },
        { path: 'directive.characterBeats[0]', why: 'no character' },
      ]);
    }),
  },
  // RC: L2 → 7 (text path: zod refuses). BR: not a number → dropped. rp-core: 7.
  {
    input: 'tension_level: "7"',
    raw: withDirective({ sceneGuidance: { tension_level: '7' } }),
    expect: okWith((p, s) => {
      expect(p.directive.sceneGuidance).toEqual({ tension_level: 7 });
      expect(s).toEqual([]);
    }),
  },
  {
    input: 'tension_level: "-3" / "high"',
    raw: withDirective({ mood: 'x', sceneGuidance: { tension_level: '-3', setting: 'yard' } }),
    expect: okWith((p, s) => {
      expect(p.directive.sceneGuidance).toEqual({ setting: 'yard', tension_level: 0 });
      expect(s).toEqual([{ path: 'directive.sceneGuidance.tension_level', why: 'clamped to 0' }]);
      const high = read(withDirective({ mood: 'x', sceneGuidance: { tension_level: 'high' } }));
      expect(high.round.directive.sceneGuidance).toBeUndefined();
      expect(high.skipped).toEqual([{ path: 'directive.sceneGuidance.tension_level', why: 'not a number "high"' }]);
    }),
  },
  // RC: mergeArcUpdates cuts -term. BR: cuts -term. rp-core: case-fixed, -term cut.
  {
    input: 'horizon: "long-term"',
    raw: plan({ arcUpdates: [{ arcId: 'arc-1', horizon: 'Long-Term' }], seedUpdates: [{ title: 'Bell', action: 'plant', payoffHorizon: 'short term' }] }),
    expect: okWith((p, s) => {
      expect(p.arcUpdates).toEqual([{ arcId: 'arc-1', horizon: 'long' }]);
      expect(p.seedUpdates).toEqual([{ title: 'Bell', action: 'plant', payoffHorizon: 'short' }]);
      expect(s).toEqual([]);
    }),
  },
  // RC: dropped by L2. BR: "5" → 5, else undefined. rp-core: same, with a skip.
  {
    input: 'nextBeat.targetTurn: "in 3 turns"',
    raw: plan({ arcUpdates: [{ arcId: 'arc-1', nextBeat: { description: 'the bell rings', targetTurn: 'in 3 turns' } }] }),
    expect: okWith((p, s) => {
      expect(p.arcUpdates).toEqual([{ arcId: 'arc-1', nextBeat: { description: 'the bell rings' } }]);
      expect(s).toEqual([{ path: 'arcUpdates[0].nextBeat.targetTurn', why: 'not a turn number "in 3 turns"' }]);
    }),
  },
  // RC: L2 arcId "" → executor derives an id from the title. BR: arcId ?? id ?? title, empty → dropped.
  {
    input: 'arcUpdate without arcId',
    raw: plan({ arcUpdates: [{ title: 'The Ledger' }, { arcId: '', title: 'The Bell' }, { arcId: '', status: 'climax' }] }),
    expect: okWith((p, s) => {
      expect(p.arcUpdates).toEqual([
        { arcId: 'The Ledger', title: 'The Ledger' },
        { arcId: 'The Bell', title: 'The Bell' },
      ]);
      expect(s).toEqual([{ path: 'arcUpdates[2]', why: 'no arcId, id or title' }]);
    }),
  },
  // RC: L0 cuts it. BR: JSON.parse fails. rp-core: looseJson cuts it (here inside a string section).
  {
    input: '</tool_call> tail after the JSON',
    raw: plan({ arcUpdates: '[{"arcId":"arc-1"}]</tool_call>' }),
    expect: okWith((p) => expect(p.arcUpdates).toEqual([{ arcId: 'arc-1' }])),
  },
  // RC: jsonrepair. BR: undecodable. rp-core: a whole answer cut off is structuredCall's
  // `undecodable`; a cut-off string section inside a whole answer is repaired.
  {
    input: 'cut-off JSON (in a string section)',
    raw: plan({ arcUpdates: '[{"arcId":"arc-1","status":"climax"' }),
    expect: okWith((p) => expect(p.arcUpdates).toEqual([{ arcId: 'arc-1', status: 'climax' }])),
  },
  // RC: renamed (L2 with1). BR: ignored. rp-core: skipped.
  {
    input: 'a key with a trailing 1 (mood1, Gemini)',
    raw: withDirective({ mood1: 'tense', narrativeGoal: 'g' }),
    expect: okWith((p, s) => {
      expect(p.directive).toEqual({ pacing: 'medium', narrativeGoal: 'g' });
      expect(s).toEqual([{ path: 'directive.mood1', why: 'unknown key' }]);
    }),
  },
  // RoleCall's dossier field is not in the plan.
  {
    input: 'dossierUpdatesNeeded (RoleCall-only section)',
    raw: plan({ dossierUpdatesNeeded: ['cast'] }),
    expect: okWith((_p, s) => expect(s).toEqual([{ path: 'dossierUpdatesNeeded', why: 'unknown key' }])),
  },
];

describe('the tolerance matrix (rolecall.md §1.2, rp-core column)', () => {
  test.each(MATRIX.map((r) => [r.input, r] as const))('%s', (_input, row) => {
    row.expect(readPlan(row.raw, { lite: false }));
  });
});

// ---- lite caps, skipped cap ----------------------------------------------------------------------

describe('the lite profile', () => {
  const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
  const big = withDirective({
    mood: 'tense',
    arcDirections: many(5, (i) => ({ arcName: `a${i}`, instruction: 'push' })),
    callbacks: many(4, (i) => ({ reference: `r${i}`, instruction: 'echo' })),
    characterBeats: many(4, (i) => ({ character: `c${i}`, beat: 'b' })),
    dialogueGuidance: many(14, (i) => ({ character: `d${i}`, tone: 't' })),
  });
  const withIntentions = (n: number): Rec => ({ ...big, analysis: { intentions: many(n, (i) => `i${i}`) } });

  test('lite caps arcDirections at 3, characterBeats at 3, callbacks at 2, intentions at 3', () => {
    const { round, skipped } = read(withIntentions(6), true);
    expect(round.directive.arcDirections).toHaveLength(READ_LIMITS.liteArcDirections);
    expect(round.directive.callbacks).toHaveLength(READ_LIMITS.liteCallbacks);
    expect(round.directive.characterBeats).toHaveLength(READ_LIMITS.liteCharacterBeats);
    expect(round.directive.arcDirections?.map((a) => a.arcName)).toEqual(['a0', 'a1', 'a2']);
    expect(round.analysis.intentions?.map((i) => i.description)).toEqual(['i0', 'i1', 'i2']);
    // dialogueGuidance is not in the lite schema; a model that sends it anyway gets the full cap.
    expect(round.directive.dialogueGuidance).toHaveLength(READ_LIMITS.directiveList);
    expect(skipped).toEqual([
      { path: 'directive.dialogueGuidance', why: '2 over the limit of 12' },
      { path: 'directive.arcDirections', why: '2 over the limit of 3' },
      { path: 'directive.callbacks', why: '2 over the limit of 2' },
      { path: 'directive.characterBeats', why: '1 over the limit of 3' },
      { path: 'analysis.intentions', why: '3 over the limit of 3' },
    ]);
  });

  test('full reads the same answer with the full caps', () => {
    const { round, skipped } = read(withIntentions(6), false);
    expect(round.directive.arcDirections).toHaveLength(5);
    expect(round.directive.callbacks).toHaveLength(4);
    expect(round.directive.characterBeats).toHaveLength(4);
    expect(round.analysis.intentions).toHaveLength(6);
    expect(skipped).toEqual([{ path: 'directive.dialogueGuidance', why: '2 over the limit of 12' }]);
  });

  test('invalid elements do not use up the cap', () => {
    const { round } = read(withDirective({ arcDirections: [{ arcName: 'x' }, { arcName: 'y' }, ...many(4, (i) => ({ arcName: `a${i}`, instruction: 'go' }))] }), true);
    expect(round.directive.arcDirections?.map((a) => a.arcName)).toEqual(['a0', 'a1', 'a2']);
  });
});

describe('the skipped list', () => {
  const junk = (n: number): Rec => Object.fromEntries(Array.from({ length: n }, (_, i) => [`junk${i}`, i]));

  test('at most 20 entries, then one +N more', () => {
    const { skipped } = read({ ...plan(), ...junk(25) });
    expect(skipped).toHaveLength(READ_LIMITS.skipped + 1);
    expect(skipped[READ_LIMITS.skipped - 1]).toEqual({ path: 'junk19', why: 'unknown key' });
    expect(skipped[READ_LIMITS.skipped]).toEqual({ path: 'skipped', why: '+5 more' });
  });

  test('exactly 20 entries has no +N more', () => {
    const { skipped } = read({ ...plan(), ...junk(20) });
    expect(skipped).toHaveLength(20);
    expect(paths(skipped)).not.toContain('skipped');
  });

  test('a flood of bad elements is counted, not listed', () => {
    const { round, skipped } = read(plan({ seedUpdates: Array.from({ length: 40 }, () => ({ title: 'x' })) }));
    expect(round.seedUpdates).toEqual([]);
    expect(skipped.at(-1)).toEqual({ path: 'skipped', why: '+20 more' });
  });

  test('keys and values quoted in skips are short', () => {
    const long = 'k'.repeat(500);
    const { skipped } = read(plan({ [long]: 1, directive: { mood: 'x', pacing: 'p'.repeat(500) } }));
    expect(skipped[0]!.path).toBe('k'.repeat(60));
    expect(skipped[1]).toEqual({ path: 'directive.pacing', why: `unknown value "${'p'.repeat(40)}"` });
  });
});

// ---- Russian text --------------------------------------------------------------------------------

describe('Russian text survives', () => {
  test('a Russian plan is read whole: trimmed, not mangled, enums case-fixed around it', () => {
    const { round, skipped } = read({
      directive: {
        mood: '  напряжённая тишина ',
        pacing: 'Slow',
        include: { characters: ['Мира', 'Лев'], themes: 'долг и страх' },
        avoid: { revelations: ['кто убил Ёжика'] },
        dialogueGuidance: [{ character: 'Лев', tone: 'сухо, сквозь зубы', hints: ['«Не сейчас.»'] }],
        sceneGuidance: { setting: 'двор у восточной стены', atmosphere: 'воздух после драки', tension_level: '7' },
        endingHook: 'Колокол бьёт один раз — и замолкает.',
        arcDirections: [{ arcName: 'Долг Миры', instruction: 'пусть Лев остановит тренировку', urgency: 'Сильно' }],
        callbacks: [{ reference: 'ржавый колокол', instruction: 'мельком' }],
        characterBeats: [{ character: 'Лев', beat: 'решает, сказать ли правду', motivation: 'гордость' }],
        narrativeGoal: 'показать, что наставничество — это и защита, и давление',
      },
      arcUpdates: [{ title: '  Мира и война  ', status: 'BUILDING', horizon: 'долгий', nextBeat: 'Лев признаётся' }],
      seedUpdates: [{ title: 'Ржавый колокол', action: 'Plant', description: 'кто его повесил?', scope: 'мир' }],
      invisibleArcUpdates: [{ title: 'Заговор гильдии', action: 'ADD', arcType: 'Conspiracy', newClue: 'печать на письме' }],
      analysis: 'Мира впервые ответила Льву резко.',
      chapterUpdate: { action: 'start_new', title: 'Глава о колоколе', themes: ['долг'] },
    });
    expect(round.directive).toEqual({
      mood: 'напряжённая тишина',
      pacing: 'slow',
      include: { characters: ['Мира', 'Лев'], themes: ['долг и страх'] },
      avoid: { revelations: ['кто убил Ёжика'] },
      dialogueGuidance: [{ character: 'Лев', tone: 'сухо, сквозь зубы', hints: ['«Не сейчас.»'] }],
      sceneGuidance: { setting: 'двор у восточной стены', atmosphere: 'воздух после драки', tension_level: 7 },
      endingHook: 'Колокол бьёт один раз — и замолкает.',
      arcDirections: [{ arcName: 'Долг Миры', instruction: 'пусть Лев остановит тренировку', urgency: 'moderate' }],
      callbacks: [{ reference: 'ржавый колокол', instruction: 'мельком' }],
      characterBeats: [{ character: 'Лев', beat: 'решает, сказать ли правду', motivation: 'гордость' }],
      narrativeGoal: 'показать, что наставничество — это и защита, и давление',
    });
    expect(round.arcUpdates).toEqual([{ arcId: 'Мира и война', title: 'Мира и война', status: 'building', nextBeat: { description: 'Лев признаётся' } }]);
    expect(round.seedUpdates).toEqual([{ title: 'Ржавый колокол', action: 'plant', description: 'кто его повесил?' }]);
    expect(round.invisibleArcUpdates).toEqual([{ title: 'Заговор гильдии', action: 'add', arcType: 'conspiracy', newClue: 'печать на письме' }]);
    expect(round.analysis).toEqual({ whatHappened: 'Мира впервые ответила Льву резко.' });
    expect(round.chapterUpdate).toEqual({ action: 'start_new', title: 'Глава о колоколе', themes: ['долг'] });
    // Russian enum values are not translated (no alias table): they are skipped, quoted as sent.
    expect(skipped).toEqual([
      { path: 'directive.arcDirections[0].urgency', why: 'unknown value "Сильно"' },
      { path: 'arcUpdates[0].horizon', why: 'unknown value "долгий"' },
      { path: 'seedUpdates[0].scope', why: 'unknown value "мир"' },
    ]);
  });

  test('a Russian-only directive has content (no ASCII-only checks)', () => {
    expect(read(withDirective({ mood: 'тревога' })).round.directive).toEqual({ mood: 'тревога', pacing: 'medium' });
    expect(read(withDirective({ endingHook: 'Скрип двери.' })).round.directive.endingHook).toBe('Скрип двери.');
    // Unicode whitespace (NBSP, ideographic space) is blank.
    expect(readPlan(withDirective({ mood: ' 　' }), { lite: false }).ok).toBe(false);
  });

  test('Cyrillic texts are cut at the limits by characters, keeping ё and whole emoji', () => {
    const title = `${'ё'.repeat(STATE_LIMITS.arcTitle - 1)}😀конец`;
    const long = `${'щ'.repeat(STATE_LIMITS.text - 1)}🙂хвост`;
    const { round, skipped } = read(plan({ arcUpdates: [{ title, description: long }], directive: { mood: long } }));
    expect(round.arcUpdates[0]!.title).toBe('ё'.repeat(STATE_LIMITS.arcTitle - 1));
    expect(round.arcUpdates[0]!.description).toBe('щ'.repeat(STATE_LIMITS.text - 1));
    expect(round.directive.mood).toBe('щ'.repeat(STATE_LIMITS.text - 1));
    expect(skipped).toEqual([
      { path: 'directive.mood', why: 'cut to 300 chars' },
      { path: 'arcUpdates[0].title', why: 'cut to 80 chars' },
      { path: 'arcUpdates[0].description', why: 'cut to 300 chars' },
    ]);
  });

  test('a Russian plan sent as JSON strings is decoded', () => {
    const { round } = read({
      directive: '{"mood": "напряжённо", "pacing": "fast"}',
      arcUpdates: '[{"arcId": "arc-1", "newStageTitle": "Мира узнала правду"}]',
      analysis: '{"whatHappened": "Лев солгал.", "intentions": ["раскрыть ложь"]}',
    });
    expect(round.directive).toEqual({ mood: 'напряжённо', pacing: 'fast' });
    expect(round.arcUpdates).toEqual([{ arcId: 'arc-1', newStageTitle: 'Мира узнала правду' }]);
    expect(round.analysis.intentions).toEqual([{ type: 'advance_arc', description: 'раскрыть ложь', priority: 'should', targetTurn: 'next' }]);
  });
});

// ---- turn numbers (D-123) -------------------------------------------------------------------------

describe('a target turn is a safe integer (D-123)', () => {
  const beat = (targetTurn: unknown): Rec => plan({ arcUpdates: [{ arcId: 'arc-1', nextBeat: { description: 'the bell rings', targetTurn } }] });

  test('a number past 2^53, as a number or a numeric string, is dropped and skipped (checkState would refuse it)', () => {
    for (const [sent, why] of [
      [1e20, 'not a turn number'],
      [2 ** 53, 'not a turn number'],
      [1e308, 'not a turn number'],
      ['123456789012345678901', 'not a turn number "123456789012345678901"'],
      ['9007199254740993', 'not a turn number "9007199254740993"'],
    ] as const) {
      const { round, skipped } = read(beat(sent));
      expect(round.arcUpdates).toEqual([{ arcId: 'arc-1', nextBeat: { description: 'the bell rings' } }]);
      expect(skipped).toEqual([{ path: 'arcUpdates[0].nextBeat.targetTurn', why }]);
    }
  });

  test('the largest safe integer, a rounded fraction and -0 are turns', () => {
    for (const [sent, turn] of [
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [12.6, 13],
      ['12.4', 12],
      [-0, 0],
      ['-0', 0],
    ] as const) {
      const { round, skipped } = read(beat(sent));
      expect(Object.is(round.arcUpdates[0]?.nextBeat?.targetTurn, turn)).toBe(true);
      expect(skipped).toEqual([]);
    }
  });
});

// ---- never throws --------------------------------------------------------------------------------

describe('never throws', () => {
  // A small deterministic generator of JSON-like junk, dropped into every slot of a plan.
  function* junkValues(seed: number, count: number): Generator<unknown> {
    let x = seed >>> 0;
    const next = (): number => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x;
    };
    const atoms: unknown[] = [null, undefined, '', ' ', 'x', 'none', '[', '{', '{"a":', '[1,', 0, -1, 1e308, NaN, true, false, 'Мира', '😀', '7'];
    const make = (depth: number): unknown => {
      const r = next() % 6;
      if (depth > 3 || r < 3) return atoms[next() % atoms.length];
      if (r === 3) return Array.from({ length: next() % 4 }, () => make(depth + 1));
      const keys = ['mood', 'pacing', 'title', 'action', 'arcId', 'description', 'urgency', 'tension_level', 'nextBeat', 'intentions', 'targetTurn', 'zz'];
      return Object.fromEntries(Array.from({ length: next() % 5 }, () => [keys[next() % keys.length]!, make(depth + 1)]));
    };
    for (let i = 0; i < count; i++) yield make(0);
  }

  test('readPlan never throws and always returns a ReadResult', () => {
    const slots = ['directive', 'arcUpdates', 'seedUpdates', 'invisibleArcUpdates', 'analysis', 'chapterUpdate'];
    let n = 0;
    for (const v of junkValues(7, 400)) {
      const slot = slots[n++ % slots.length]!;
      for (const raw of [v, { ...plan(), [slot]: v }, { ...plan(), [slot]: [v, v] }, withDirective({ mood: 'm', include: v, sceneGuidance: v, arcDirections: [v] })]) {
        for (const lite of [false, true]) {
          const r = readPlan(raw, { lite });
          expect(typeof r.ok).toBe('boolean');
          if (r.ok) expect(r.skipped.length).toBeLessThanOrEqual(READ_LIMITS.skipped + 1);
        }
      }
    }
  });
});
