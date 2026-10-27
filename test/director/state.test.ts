// Ported from Bunraku:src/core/director/state.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374 ("the
// rest": the empty state's nextId; Coneja-Chibi) and RoleCall:apps/rc/src/lib/ai/dm-stream/__tests__/
// seed-aging.test.ts@fb8dc623e (the seedTurnsActive vectors; Levi).
// Copyright (C) 2026 Coneja-Chibi, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/director/state.ts basics and checks: emptyState, ageOf, stateBytes, clipText, checkState,
// checkRecord, checkDirective. Bunraku's live views and turnOf are DROPPED (no removedAt; the turn is
// stored, D-61); its fitState cases live in fit.test.ts, the fold in fold.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  ageOf,
  CHECK_LIMITS,
  checkDirective,
  checkRecord,
  checkState,
  clipText,
  emptyState,
  stateBytes,
} from '../../src/agents/director/state.ts';
import { REDUCER_VERSION, STATE_LIMITS, type DirectorState } from '../../src/agents/director/types.ts';
import { arcOf, chapterOf, hiddenOf, recordOf, ru, seedOf, stateOf } from './fixtures-state.ts';

/** A state with one of everything, as JSON read back from disk. */
function fullState(): DirectorState {
  return stateOf({
    turn: 12,
    nextId: 9,
    chapters: [chapterOf({ id: 'chapter-1', status: 'complete', closingMoment: 'Маяк погас.' }), chapterOf({ id: 'chapter-2', number: 2, createdAtTurn: 8 })],
    currentChapterId: 'chapter-2',
    arcs: [
      arcOf({
        id: 'arc-1',
        title: 'Письмо сестры',
        chapterId: 'chapter-2',
        lastProgressTurn: 11,
        stages: [{ title: 'Находка', turn: 9 }],
        nextBeat: { description: 'Смотритель проговаривается.', plannedAtTurn: 11, targetTurn: 13, status: 'pending' },
      }),
      arcOf({ id: 'arc-2', status: 'complete', byUser: true }),
    ],
    seeds: [seedOf({ id: 'seed-3', payoffDelivered: true, payoffTurn: 10, relatedArcId: 'arc-1', reinforcements: [{ turn: 4 }, { turn: 7 }] })],
    invisibleArcs: [
      hiddenOf({ id: 'hidden-4', surfaceCondition: 'Если герой войдёт в порт ночью.', playerClues: [{ turn: 5, clue: 'Мокрые следы.' }], userAuthored: true }),
    ],
    notes: [{ id: 'note-1', content: 'Не убивать смотрителя.', createdAtTurn: 3 }],
    pacing: { currentMood: 'тревожный', turnsAtCurrentMood: 2, rhythm: { lastActionSequence: 6, lastQuietMoment: 10 } },
    nextIntentions: [{ type: 'reveal', description: 'Показать письмо.', priority: 'must', targetTurn: 'next' }],
    lastDirective: { turn: 12, directive: { pacing: 'slow', mood: 'тревожный', arcDirections: [{ arcName: 'Письмо сестры', instruction: 'Намекнуть.', urgency: 'subtle' }] } },
    lastPlantTurn: 6,
  });
}

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('the rest', () => {
  test('the empty state: turn 0, nextId 1, mood ambient, rhythm 0/0, every list empty, a fresh object each time', () => {
    const s = emptyState();
    expect(s.nextId).toBe(1); // the one assertion of Bunraku's "the rest" that still applies
    expect(s).toEqual({
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
    s.arcs.push(arcOf());
    expect(emptyState().arcs).toEqual([]);
  });
});

describe('ageOf (RoleCall seedTurnsActive vectors)', () => {
  test('age is turn minus the start, clamped at 0; a missing start is age 0', () => {
    expect(ageOf(400, 400)).toBe(0);
    expect(ageOf(400, 0)).toBe(400);
    expect(ageOf(400, 395)).toBe(5);
    expect(ageOf(120, 400)).toBe(0);
    expect(ageOf(400, undefined)).toBe(0);
    // RoleCall let NaN through (Math.max(0, NaN)); here it is age 0.
    expect(ageOf(400, Number.NaN)).toBe(0);
  });
});

describe('stateBytes', () => {
  test('counts UTF-8 bytes of the JSON, not UTF-16 units (A.6)', () => {
    const s = stateOf({ arcs: [arcOf({ description: ru(1000) })] });
    const json = JSON.stringify(s);
    expect(stateBytes(s)).toBe(Buffer.byteLength(json, 'utf8'));
    expect(stateBytes(s)).toBeGreaterThan(json.length + 800); // Cyrillic letters are 2 bytes
    const emoji = stateOf({ pacing: { ...emptyState().pacing, currentMood: '🌊🌊' } });
    expect(stateBytes(emoji) - stateBytes(emptyState())).toBe(8 - 'ambient'.length);
  });
});

describe('clipText', () => {
  test('text within the limit is returned as is', () => {
    const t = 'Короткая строка';
    expect(clipText(t, 300)).toBe(t);
    expect(clipText('', 3)).toBe('');
  });

  test('a long text is cut at the last space and marked with …, never over the limit in code points', () => {
    const t = ru(400);
    const out = clipText(t, 300);
    expect(out.endsWith('…')).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(300);
    expect(Array.from(out).length).toBeGreaterThan(150);
    const kept = out.slice(0, -1);
    expect(t.startsWith(kept)).toBe(true);
    expect(kept.at(-1)).not.toBe(' ');
    expect(t[kept.length]).toBe(' '); // the cut is at a word boundary
  });

  test('one long word is cut hard; a surrogate pair is never split; a cut text is not cut again', () => {
    expect(clipText('абвгдежзик', 5)).toBe('абвг…');
    const emoji = '🌊'.repeat(10);
    const out = clipText(emoji, 4);
    expect(out).toBe('🌊🌊🌊…');
    expect(clipText(out, 4)).toBe(out);
    const once = clipText(ru(500), 160);
    expect(clipText(once, 160)).toBe(once);
  });
});

describe('checkState', () => {
  test('accepts the empty state and a full state read back from JSON, equal to what was written', () => {
    expect(checkState(roundTrip(emptyState()))).toEqual(emptyState());
    const s = fullState();
    expect(checkState(roundTrip(s))).toEqual(s);
  });

  test('a copy, never the input object', () => {
    const v = roundTrip(fullState());
    const out = checkState(v)!;
    expect(out).not.toBe(v as unknown as DirectorState);
    expect(out.arcs[0]).not.toBe((v as unknown as DirectorState).arcs[0]);
  });

  const broken: [string, (s: Record<string, any>) => void][] = [
    ['turn missing', (s) => delete s.turn],
    ['turn negative', (s) => (s.turn = -1)],
    ['turn fractional', (s) => (s.turn = 1.5)],
    ['turn a string', (s) => (s.turn = '3')],
    ['nextId missing', (s) => delete s.nextId],
    ['arcs not a list', (s) => (s.arcs = {})],
    ['an arc without an id', (s) => delete s.arcs[0].id],
    ['an empty id', (s) => (s.arcs[0].id = '')],
    ['an id of 81 chars', (s) => (s.seeds[0].id = 'x'.repeat(81))],
    ['duplicate arc ids', (s) => (s.arcs[1].id = s.arcs[0].id)],
    ['duplicate chapter ids', (s) => (s.chapters[1].id = s.chapters[0].id)],
    ['an unknown arc status', (s) => (s.arcs[0].status = 'paused')],
    ['an enum in the wrong case', (s) => (s.arcs[0].horizon = 'Medium')],
    ['an unknown hidden status', (s) => (s.invisibleArcs[0].status = 'revealed')],
    ['an unknown seed scope', (s) => (s.seeds[0].scope = 'party')],
    ['an unknown intention priority', (s) => (s.nextIntentions[0].priority = 'may')],
    ['an unknown beat status', (s) => (s.arcs[0].nextBeat.status = 'done')],
    ['a stage turn negative', (s) => (s.arcs[0].stages[0].turn = -2)],
    // D-123 keeps these strict: they are the core's own turns, not the model's.
    ['a beat planned at a turn past 2^53', (s) => (s.arcs[0].nextBeat.plannedAtTurn = 1e20)],
    ['a clue without text', (s) => delete s.invisibleArcs[0].playerClues[0].clue],
    ['payoffDelivered not a boolean', (s) => (s.seeds[0].payoffDelivered = 'yes')],
    ['a description not a string', (s) => (s.arcs[0].description = 42)],
    ['chapter themes not strings', (s) => (s.chapters[0].themes = [1])],
    ['pacing missing', (s) => delete s.pacing],
    ['rhythm missing', (s) => delete s.pacing.rhythm],
    ['currentMood not a string', (s) => (s.pacing.currentMood = null)],
    ['byUser not a flag', (s) => (s.arcs[1].byUser = 'yes')],
    ['lastPlantTurn fractional', (s) => (s.lastPlantTurn = 2.5)],
    ['stages over 4x the limit', (s) => (s.arcs[0].stages = Array.from({ length: 4 * STATE_LIMITS.stages + 1 }, (_, i) => ({ title: 's', turn: i })))],
    ['arcs over 4x the limit', (s) => (s.arcs = Array.from({ length: 4 * (STATE_LIMITS.liveArcs + STATE_LIMITS.completedPerKind) + 1 }, (_, i) => arcOf({ id: `arc-${i}` })))],
    // D-116: each string ≤ 2 000 code points, the whole JSON ≤ 4x the cap (was: the JSON ≤ 2x).
    ['a note over 2 000 chars', (s) => (s.notes[0].content = ru(CHECK_LIMITS.string + 1))],
    ['a stage title over 2 000 chars', (s) => (s.arcs[0].stages[0].title = 'ж'.repeat(CHECK_LIMITS.string + 1))],
    ['a mood over 2 000 chars', (s) => (s.pacing.currentMood = '🌊'.repeat(CHECK_LIMITS.string + 1))],
    ['JSON over 4x the hard cap', (s) => (s.notes = Array.from({ length: 40 }, (_, i) => ({ id: `note-${i}`, content: ru(CHECK_LIMITS.string, i), createdAtTurn: i })))],
  ];
  for (const [name, breakIt] of broken) {
    test(`refuses a state with ${name}`, () => {
      const v = roundTrip(fullState()) as unknown as Record<string, any>;
      breakIt(v);
      expect(checkState(v)).toBeNull();
    });
  }

  test('refuses what is not a state object, and never throws', () => {
    for (const v of [null, undefined, 3, 'state', [], [emptyState()], { turn: 0 }]) expect(checkState(v)).toBeNull();
    const cyclic: Record<string, unknown> = { ...emptyState() };
    cyclic.self = cyclic;
    expect(checkState(cyclic)).toBeNull();
  });

  test('accepts 4x the limits (older files may hold more) and a state over 2x the hard cap but within 4x (D-116)', () => {
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.arcs[0].stages = Array.from({ length: 4 * STATE_LIMITS.stages }, (_, i) => ({ title: `этап ${i}`, turn: i }));
    v.notes = Array.from({ length: 28 }, (_, i) => ({ id: `note-${i}`, content: ru(CHECK_LIMITS.string, i), createdAtTurn: i }));
    expect(CHECK_LIMITS.jsonBytes).toBe(4 * STATE_LIMITS.hardBytes);
    const out = checkState(v)!;
    expect(out).not.toBeNull();
    expect(out.arcs[0]!.stages).toHaveLength(24);
    expect(stateBytes(out)).toBeGreaterThan(3 * STATE_LIMITS.hardBytes); // > 96 KB in bytes, < 128 KB
    expect(stateBytes(out)).toBeLessThanOrEqual(CHECK_LIMITS.jsonBytes);
  });

  test('a string of exactly 2 000 code points is taken, counted in code points (2 000 emoji = 4 000 UTF-16 units)', () => {
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.notes[0].content = '🌊'.repeat(CHECK_LIMITS.string);
    v.arcs[0].description = ru(CHECK_LIMITS.string);
    const out = checkState(v)!;
    expect(out.notes[0]!.content).toBe(v.notes[0].content);
    expect(out.arcs[0]!.description).toHaveLength(CHECK_LIMITS.string);
  });

  test('a long string in the lastDirective is cut (lenient), not a reason to refuse the state', () => {
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.lastDirective.directive.narrativeGoal = ru(CHECK_LIMITS.string + 500);
    const out = checkState(v)!;
    expect(out).not.toBeNull();
    expect(Array.from(out.lastDirective!.directive.narrativeGoal!).length).toBeLessThanOrEqual(4 * STATE_LIMITS.text);
  });

  test('unknown keys are tolerated and not copied; null optional fields read as absent; false flags as absent', () => {
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.activity = [{ id: 'a1' }]; // a Bunraku key
    v.futureField = { x: 1 };
    v.arcs[0].turnsActive = 7;
    v.arcs[0].chapterId = null;
    v.arcs[0].byUser = false;
    v.seeds[0].payoffTurn = null;
    const out = checkState(v)!;
    expect(out).not.toBeNull();
    expect('activity' in out).toBe(false);
    expect('futureField' in out).toBe(false);
    expect('turnsActive' in out.arcs[0]!).toBe(false);
    expect('chapterId' in out.arcs[0]!).toBe(false);
    expect('byUser' in out.arcs[0]!).toBe(false);
    expect('payoffTurn' in out.seeds[0]!).toBe(false);
  });

  test('a malformed lastDirective is dropped, the state kept; a malformed field inside it is dropped', () => {
    for (const bad of ['plan', { turn: -1, directive: {} }, { turn: 3, directive: 'x' }, { turn: 3 }]) {
      const v = roundTrip(fullState()) as unknown as Record<string, any>;
      v.lastDirective = bad;
      const out = checkState(v)!;
      expect(out).not.toBeNull();
      expect(out.lastDirective).toBeUndefined();
    }
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.lastDirective.directive.callbacks = 'nope';
    v.lastDirective.directive.pacing = 'warp';
    expect(checkState(v)!.lastDirective).toEqual({
      turn: 12,
      directive: { pacing: 'medium', mood: 'тревожный', arcDirections: [{ arcName: 'Письмо сестры', instruction: 'Намекнуть.', urgency: 'subtle' }] },
    });
  });

  test("D-123: a seed's relatedArcId is read leniently: a 1..2 000-char string is kept, anything else dropped, never a refusal", () => {
    // The review's witness: an older build stored the model's 87-char arc description as the reference.
    const long = 'The slow unraveling of the Ashford family secret about the fire at the old mill (arc-1)';
    for (const kept of [long, 'x', ru(CHECK_LIMITS.string)]) {
      const v = roundTrip(fullState()) as unknown as Record<string, any>;
      v.seeds[0].relatedArcId = kept;
      expect(checkState(v)!.seeds[0]!.relatedArcId).toBe(kept);
    }
    for (const bad of ['', ru(CHECK_LIMITS.string + 1), 42, true, { id: 'arc-1' }, ['arc-1']]) {
      const v = roundTrip(fullState()) as unknown as Record<string, any>;
      v.seeds[0].relatedArcId = bad;
      const out = checkState(v);
      expect(out).not.toBeNull();
      expect('relatedArcId' in out!.seeds[0]!).toBe(false);
      expect(out!.seeds[0]!.id).toBe('seed-3');
    }
  });

  test("D-123: a beat's targetTurn that is not a whole number is dropped, never a refusal", () => {
    for (const bad of [1e20, 2 ** 53, -1, 1.5, '13', true]) {
      const v = roundTrip(fullState()) as unknown as Record<string, any>;
      v.arcs[0].nextBeat.targetTurn = bad;
      const out = checkState(v);
      expect(out).not.toBeNull();
      expect(out!.arcs[0]!.nextBeat).toEqual({ description: 'Смотритель проговаривается.', plannedAtTurn: 11, status: 'pending' });
    }
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.arcs[0].nextBeat.targetTurn = Number.MAX_SAFE_INTEGER;
    expect(checkState(v)!.arcs[0]!.nextBeat!.targetTurn).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('nextId is raised past the highest arc-/seed-/hidden-N id, so the next id is never a duplicate', () => {
    const v = roundTrip(fullState()) as unknown as Record<string, any>;
    v.nextId = 2;
    expect(checkState(v)!.nextId).toBe(5); // hidden-4
    v.nextId = 40;
    expect(checkState(v)!.nextId).toBe(40);
  });
});

describe('checkRecord', () => {
  test('accepts a record as the turn writes it, failed ones too (they carry the state)', () => {
    const r = recordOf(fullState(), {
      analysis: { whatHappened: 'Герой нашёл письмо.', intentions: [{ type: 'reveal', description: 'Письмо.', priority: 'must', targetTurn: 'next' }] },
      skipped: [{ path: 'plan.arcUpdates[2]', why: 'no key' }],
      reusedFrom: 'a1b2c3d4',
      fromReasoning: true,
    });
    expect(checkRecord(roundTrip(r))).toEqual(r);
    const failed = recordOf(fullState(), { ok: false, code: 'timeout', directive: undefined, attempts: [{ transport: 'structured', outcome: 'timeout', ms: 180000 }] });
    delete failed.directive;
    expect(checkRecord(roundTrip(failed))).toEqual(failed);
  });

  const refused: [string, (r: Record<string, any>) => void][] = [
    ['reducer 2', (r) => (r.reducer = 2)],
    ['no reducer', (r) => delete r.reducer],
    ['reducer "1"', (r) => (r.reducer = '1')],
    ['ok missing', (r) => delete r.ok],
    ['ok a string', (r) => (r.ok = 'true')],
    ['turn negative', (r) => (r.turn = -1)],
    ['turn missing', (r) => delete r.turn],
    ['no state', (r) => delete r.state],
    ['a broken state', (r) => (r.state.arcs = 'none')],
  ];
  test('D-123: a record whose state holds a long relatedArcId or a huge targetTurn is read, so the fold keeps it', () => {
    const s = fullState();
    s.seeds[0]!.relatedArcId = 'The slow unraveling of the Ashford family secret about the fire at the old mill (arc-1)';
    s.arcs[0]!.nextBeat!.targetTurn = 1e20;
    const out = checkRecord(roundTrip(recordOf(s)));
    expect(out).not.toBeNull();
    expect(out!.state.seeds[0]!.relatedArcId).toBe(s.seeds[0]!.relatedArcId);
    expect(out!.state.arcs[0]!.nextBeat!.targetTurn).toBeUndefined();
  });

  for (const [name, breakIt] of refused) {
    test(`refuses a record with ${name}`, () => {
      const r = roundTrip(recordOf(fullState())) as unknown as Record<string, any>;
      breakIt(r);
      expect(checkRecord(r)).toBeNull();
    });
  }

  test('refuses what is not an object', () => {
    for (const v of [null, undefined, 'dir', 1, [recordOf(emptyState())]]) expect(checkRecord(v)).toBeNull();
  });

  test('the rest is lenient: a malformed directive or analysis is dropped, bad entries filtered, unknown values dropped', () => {
    const r = roundTrip(recordOf(fullState())) as unknown as Record<string, any>;
    r.directive = 'go dark';
    r.analysis = ['x'];
    r.code = 'exploded';
    r.transport = 'carrier-pigeon';
    r.profile = 'max';
    r.model = 7;
    r.skipped = [{ path: 'a', why: 'b' }, { path: 1 }, 'x'];
    r.attempts = [{ transport: 'tagged', outcome: 'ok', ms: 5 }, { transport: 'tagged', ms: 5 }, { transport: 'fax', outcome: 'ok', ms: 1 }];
    r.reusedFrom = '';
    r.fromReasoning = 'yes';
    r.ops = [{ op: 'x' }]; // unknown key
    const out = checkRecord(r)!;
    expect(out).not.toBeNull();
    expect(out).toEqual({
      turn: 12,
      ok: true,
      skipped: [{ path: 'a', why: 'b' }],
      attempts: [{ transport: 'tagged', outcome: 'ok', ms: 5 }],
      state: fullState(),
      reducer: REDUCER_VERSION,
    });
  });

  test('missing skipped and attempts read as empty lists', () => {
    const r = roundTrip(recordOf(fullState())) as unknown as Record<string, any>;
    delete r.skipped;
    delete r.attempts;
    const out = checkRecord(r)!;
    expect(out.skipped).toEqual([]);
    expect(out.attempts).toEqual([]);
  });
});

describe('checkDirective', () => {
  test('keeps a valid directive whole', () => {
    const d = {
      mood: 'тревожный',
      pacing: 'fast' as const,
      include: { characters: ['Мира'], themes: ['долг'] },
      avoid: { topics: ['смерть смотрителя'] },
      dialogueGuidance: [{ character: 'Мира', tone: 'сухо', hints: ['не называет сестру'] }],
      sceneGuidance: { setting: 'маяк', atmosphere: 'сырость', tension_level: 7 },
      endingHook: 'Огонь на башне гаснет.',
      arcDirections: [{ arcName: 'Письмо', instruction: 'Дать улику.', urgency: 'forceful' as const }],
      callbacks: [{ reference: 'треснувший колокол', instruction: 'Пусть звякнет.' }],
      characterBeats: [{ character: 'Мира', beat: 'колеблется', motivation: 'страх' }],
      narrativeGoal: 'Сомнение в смотрителе.',
    };
    expect(checkDirective(roundTrip(d))).toEqual(d);
  });

  test('drops bad fields and elements; pacing defaults to medium, urgency to moderate (D-107); null for a non-object', () => {
    expect(checkDirective('x')).toBeNull();
    expect(checkDirective([])).toBeNull();
    expect(
      checkDirective({
        pacing: 'MEDIUM',
        mood: 3,
        include: { characters: ['Мира', 4], themes: 'долг' },
        avoid: 'all',
        dialogueGuidance: [{ character: 'Мира' }, { character: 'Лев', tone: 'тихо', hints: 'x' }],
        sceneGuidance: { tension_level: 11, setting: 4 },
        arcDirections: [{ arcName: 'Письмо', instruction: 'Улика.', urgency: 'high' }, { arcName: 'Без инструкции' }],
        callbacks: [null, { reference: 'колокол', instruction: 'звон' }],
        characterBeats: [{ character: 'Мира', beat: 'молчит', motivation: 5 }],
        focus: 'old RoleCall key',
      }),
    ).toEqual({
      pacing: 'medium',
      include: { characters: ['Мира'] },
      dialogueGuidance: [{ character: 'Лев', tone: 'тихо' }],
      arcDirections: [{ arcName: 'Письмо', instruction: 'Улика.', urgency: 'moderate' }],
      callbacks: [{ reference: 'колокол', instruction: 'звон' }],
      characterBeats: [{ character: 'Мира', beat: 'молчит' }],
    });
  });
});
