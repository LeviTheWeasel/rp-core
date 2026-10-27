// Ported from RoleCall:apps/rc/src/lib/ai/dm-stream/__tests__/vvs-264-arc-dedup.test.ts@fb8dc623e
// (Coneja-Chibi: the arc dedup vectors).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Arc matching (agents/director/reduce.ts matchArc, D-108): all 19 VVS-264 vectors keep their
// expected results through the stem-based rule. RoleCall's findArcMatch({title, id?}, candidates)
// becomes `find` below: the id first (when given), then the title, as applyPlan does with arcId and
// title. Reasons are renamed: exact-id → 'id', normalized-title → 'key', word-overlap → 'words'.
// Added: Russian vectors (two different Cyrillic arcs never merge, case forms merge, the documented
// false merge «Миру грозит война» / «Мира и война»), the empty key, DIRECTOR_STOP, matchKey,
// titleTokens and findArc; D-123's id echoes ('[arc-1] The Lighthouse' names arc-1).
import { describe, expect, test } from 'bun:test';
import {
  applyPlan,
  DIRECTOR_STOP,
  findArc,
  idEchoes,
  matchArc,
  matchKey,
  titleTokens,
  type ArcMatch,
} from '../../src/agents/director/reduce.ts';
import type { DirectorArc, DirectorState, PlanningRound } from '../../src/agents/director/types.ts';
import { foldText, STOP_WORDS } from '../../src/text/normalize.ts';

type Cand = { id: string; title: string };

/** RoleCall's call shape: the id (if any) first, then the title. */
function find(incoming: { title: string; id?: string }, candidates: Cand[]): ArcMatch<Cand> | undefined {
  return (incoming.id !== undefined ? matchArc(candidates, incoming.id) : undefined) ?? matchArc(candidates, incoming.title);
}
const idOf = (m: ArcMatch<Cand> | undefined): string | null => m?.item.id ?? null;

const baseArc = { id: 'arc-prince-quest', title: "The Prince's Quest" };

describe('VVS-264 — exact-ID match (the cheapest path)', () => {
  test("matches when incoming.id equals an existing arc's id", () => {
    const r = find({ title: 'Whatever', id: 'arc-prince-quest' }, [baseArc]);
    expect(idOf(r)).toBe('arc-prince-quest');
    expect(r?.by).toBe('id');
  });

  test("falls through to title match when incoming.id doesn't match any candidate", () => {
    const r = find({ title: "The Prince's Quest", id: 'unknown-id' }, [baseArc]);
    expect(idOf(r)).toBe('arc-prince-quest');
    expect(r?.by).toBe('key');
  });
});

describe('VVS-264 — normalized-title match (case + punctuation insensitive)', () => {
  test('exact same title', () => {
    expect(idOf(find({ title: "The Prince's Quest" }, [baseArc]))).toBe('arc-prince-quest');
  });

  test('different case', () => {
    expect(idOf(find({ title: "the prince's quest" }, [baseArc]))).toBe('arc-prince-quest');
  });

  test('apostrophe stripped (the model emits without)', () => {
    expect(idOf(find({ title: 'The Princes Quest' }, [baseArc]))).toBe('arc-prince-quest');
  });

  test('extra whitespace ignored', () => {
    expect(idOf(find({ title: "  The   Prince's   Quest  " }, [baseArc]))).toBe('arc-prince-quest');
  });

  test('trailing punctuation ignored', () => {
    expect(idOf(find({ title: "The Prince's Quest." }, [baseArc]))).toBe('arc-prince-quest');
  });
});

describe("VVS-264 — word-overlap fallback (the heuristic that catches the user's repeats)", () => {
  test("'Quest of the Prince' matches 'The Prince's Quest' — same words, different order", () => {
    const r = find({ title: 'Quest of the Prince' }, [baseArc]);
    expect(idOf(r)).toBe('arc-prince-quest');
    expect(r?.by).toBe('words');
    expect(r?.ratio).toBeGreaterThanOrEqual(0.5);
  });

  test("'A Prince and his Quest' matches", () => {
    expect(idOf(find({ title: 'A Prince and his Quest' }, [baseArc]))).toBe('arc-prince-quest');
  });

  test("'The Quest' alone does NOT match (only 1 significant word — risk of false positive)", () => {
    expect(idOf(find({ title: 'The Quest' }, [baseArc]))).toBeNull();
  });

  test("totally different titles don't false-positive ('The Battle at the Gates')", () => {
    expect(idOf(find({ title: 'The Battle at the Gates' }, [baseArc]))).toBeNull();
  });

  test('when multiple candidates partially match, picks the highest-ratio one', () => {
    const candidates = [
      { id: 'arc-prince-quest', title: "The Prince's Quest" },
      { id: 'arc-prince-doom', title: "The Prince's Doom" },
    ];
    expect(idOf(find({ title: 'Quest of the Prince' }, candidates))).toBe('arc-prince-quest');
  });

  test('stop words are ignored in overlap counting', () => {
    expect(idOf(find({ title: 'in the by an' }, [{ id: 'arc-x', title: 'of the and to' }]))).toBeNull();
  });
});

describe('VVS-264 — real production duplicate pairs that lithonia could realistically hit', () => {
  test("'Saving Alice' vs 'Save Alice' (verb form drift)", () => {
    // Still no match: the D-46 stemmer cuts no -ing (normalize.ts: verb forms are a known miss).
    expect(idOf(find({ title: 'Save Alice' }, [{ id: 'arc-saving-alice', title: 'Saving Alice' }]))).toBeNull();
  });

  test("'Battle at the Gates' vs 'The Battle at the Gates' — article difference", () => {
    expect(idOf(find({ title: 'Battle at the Gates' }, [{ id: 'arc-bat', title: 'The Battle at the Gates' }]))).toBe('arc-bat');
  });

  test("'Lyra and the Tower' vs 'The Tower of Lyra' — words swapped", () => {
    expect(idOf(find({ title: 'Lyra and the Tower' }, [{ id: 'arc-lyra', title: 'The Tower of Lyra' }]))).toBe('arc-lyra');
  });

  test("'The Crown' vs 'The Crown' — exact match", () => {
    expect(idOf(find({ title: 'The Crown' }, [{ id: 'arc-crown', title: 'The Crown' }]))).toBe('arc-crown');
  });
});

describe('VVS-264 — defensive edges', () => {
  test('empty candidates returns no match', () => {
    expect(idOf(find({ title: 'Any' }, []))).toBeNull();
  });

  test('empty title returns no match', () => {
    expect(idOf(find({ title: '' }, [baseArc]))).toBeNull();
  });

  test('incoming with id but empty title still tries id match', () => {
    expect(idOf(find({ title: '', id: 'arc-prince-quest' }, [baseArc]))).toBe('arc-prince-quest');
  });

  test("title that's all stop words returns no match", () => {
    expect(idOf(find({ title: 'the and of' }, [baseArc]))).toBeNull();
  });

  test('title with single emoji + 2 words still matches via word overlap', () => {
    const r = find({ title: "🌟 Prince's Quest" }, [baseArc]);
    expect(idOf(r)).toBe('arc-prince-quest');
    expect(r?.by).toBe('words');
  });
});

describe('Russian arcs [D-108]', () => {
  const ru: Cand[] = [
    { id: 'arc-1', title: 'Тайна старой башни' },
    { id: 'arc-2', title: 'Долг перед гильдией' },
    { id: 'arc-3', title: 'Тайна маяка' },
    { id: 'arc-4', title: 'Ночной караван' },
    { id: 'arc-5', title: 'Сердце Маруси' },
    { id: 'arc-6', title: 'Война за перевал' },
  ];

  test('two different Cyrillic arcs never merge (Bunraku and RoleCall merged any two)', () => {
    // RoleCall's [^a-z0-9] key made every Cyrillic title '' and so equal to the first Cyrillic arc.
    expect(find({ title: 'Новая угроза с севера' }, ru)).toBeUndefined();
    for (const a of ru) {
      const others = ru.filter((b) => b !== a);
      expect(find({ title: a.title }, others)).toBeUndefined();
    }
  });

  test('one shared word is not enough («Тайна маяка» ≠ «Тайна старой башни»)', () => {
    expect(find({ title: 'Тайна маяка' }, [ru[0] as Cand])).toBeUndefined();
  });

  test('the same arc in another case form merges by its key', () => {
    expect(find({ title: 'тайну маяка' }, ru)).toMatchObject({ item: { id: 'arc-3' }, by: 'key' });
    expect(find({ title: 'Тайна старой Башни.' }, ru)).toMatchObject({ item: { id: 'arc-1' }, by: 'key' });
    expect(find({ title: 'ночного каравана' }, ru)).toMatchObject({ item: { id: 'arc-4' }, by: 'key' });
    expect(find({ title: 'Сердце Маруси' }, ru)).toMatchObject({ item: { id: 'arc-5' }, by: 'key' });
  });

  test('shared stems merge: plural forms, a dropped preposition', () => {
    // тайн, стар shared; башен ≠ башн (a fleeting vowel, a documented stemmer miss): 2 of 3.
    expect(find({ title: 'Тайны старых башен' }, ru)).toMatchObject({ item: { id: 'arc-1' }, by: 'words' });
    // перед is a function word: долг, гильд shared, 2 of 2.
    expect(find({ title: 'Долг гильдии' }, ru)).toMatchObject({ item: { id: 'arc-2' }, by: 'words', ratio: 1 });
  });

  test('the documented false merge: «Миру грозит война» meets «Мира и война» (мир, войн)', () => {
    // D-108 keeps rule (3): both stems are shared and cover the shorter title. Mira the name and
    // мир 'world' share a stem; a model that needs both arcs should name them apart.
    expect(find({ title: 'Миру грозит война' }, [{ id: 'arc-9', title: 'Мира и война' }])).toMatchObject({ item: { id: 'arc-9' }, by: 'words', ratio: 1 });
  });

  test('Latin and Cyrillic do not meet', () => {
    expect(find({ title: 'Mira' }, [{ id: 'a', title: 'Мира' }])).toBeUndefined();
  });
});

describe('keys and tokens', () => {
  test('matchKey: stems of every word, in order; punctuation and case gone', () => {
    expect(matchKey("The Prince's Quest.")).toBe('the prince quest');
    expect(matchKey('The Princes Quest')).toBe('the prince quest');
    expect(matchKey('Тайна маяка')).toBe(matchKey('тайну маяка'));
    expect(matchKey('1984!')).toBe('1984');
    expect(matchKey('🌟 — !!')).toBe('');
  });

  test('an empty key never matches, not even another empty key', () => {
    expect(matchArc([{ id: 'a', title: '—' }], '!!')).toBeUndefined();
    expect(matchArc([{ id: 'a', title: '' }], '   ')).toBeUndefined();
  });

  test('numbers keep their key ("1984" = "1984!")', () => {
    expect(matchArc([{ id: 'a', title: '1984!' }], '1984')).toMatchObject({ item: { id: 'a' }, by: 'key' });
  });

  test('titleTokens: distinct stems longer than two, function words out', () => {
    expect(titleTokens("A Prince and his Quest")).toEqual(['prince', 'quest']);
    expect(titleTokens('Долг перед гильдией')).toEqual(['долг', 'гильд']);
    expect(titleTokens('Levi Levi Levi')).toEqual(['levi']);
    expect(titleTokens("It's the Ox")).toEqual([]);
  });

  test('the id step is trimmed and case-free', () => {
    expect(matchArc([{ id: 'arc-3', title: 'X' }], ' ARC-3 ')).toMatchObject({ item: { id: 'arc-3' }, by: 'id' });
  });

  test('DIRECTOR_STOP holds the D-46 STOP_WORDS and only folded words', () => {
    for (const w of STOP_WORDS) expect(DIRECTOR_STOP.has(w)).toBe(true);
    for (const w of DIRECTOR_STOP) expect(foldText(w)).toBe(w);
    // Names and nouns that look like function words stay significant.
    for (const w of ['will', 'may', 'том', 'есть', 'мир']) expect(DIRECTOR_STOP.has(w)).toBe(false);
  });

  test('findArc searches every arc of the state, finished ones too (Bunraku)', () => {
    const arc = (id: string, title: string, status: DirectorArc['status']): DirectorArc => ({
      id,
      title,
      description: '',
      status,
      priority: 'active',
      arcType: 'side',
      horizon: 'medium',
      stages: [],
      createdAtTurn: 1,
    });
    const state = { arcs: [arc('arc-1', 'The Heist', 'complete'), arc('arc-2', 'Тайна маяка', 'building')] } as DirectorState;
    expect(findArc(state, 'the heist')?.id).toBe('arc-1');
    expect(findArc(state, 'тайну маяка')?.id).toBe('arc-2');
    expect(findArc(state, 'arc-2')?.id).toBe('arc-2');
    expect(findArc(state, 'Nothing like it')).toBeUndefined();
  });
});

// ---- D-123: selectors that echo the prompt's ids -------------------------------------------------

describe('id echoes (D-123: the prompt lists arcs as "- [arc-N] Title")', () => {
  const arcs: Cand[] = [
    { id: 'arc-1', title: 'The Lighthouse' },
    { id: 'arc-2', title: 'Маяк' },
    { id: 'arc-3', title: 'Долг' },
  ];

  test('idEchoes reads leading and trailing echoes, with brackets and separators, and leaves the rest', () => {
    expect(idEchoes('[arc-1] The Lighthouse', 'arc')).toEqual({ ids: ['arc-1'], rest: 'The Lighthouse' });
    expect(idEchoes('ARC-2:  Маяк', 'arc')).toEqual({ ids: ['arc-2'], rest: 'Маяк' });
    expect(idEchoes('[arc-7] [arc-7] arc-9 — Levi (arc-3)', 'arc')).toEqual({ ids: ['arc-7', 'arc-7', 'arc-9', 'arc-3'], rest: 'Levi' });
    expect(idEchoes('(hidden-2) "The Guild"', 'hidden')).toEqual({ ids: ['hidden-2'], rest: '"The Guild"' });
    expect(idEchoes('(hidden-2) "The Guild"', 'arc')).toEqual({ ids: [], rest: '(hidden-2) "The Guild"' });
    // Words that only start like an echo are not one.
    expect(idEchoes('arc-12abc Tower', 'arc')).toEqual({ ids: [], rest: 'arc-12abc Tower' });
    expect(idEchoes('Archer', 'arc')).toEqual({ ids: [], rest: 'Archer' });
  });

  test('a single-word title echoed with its id names its arc (it made a duplicate before)', () => {
    for (const [sel, id] of [
      ['[arc-1] The Lighthouse', 'arc-1'],
      ['arc-1: The Lighthouse', 'arc-1'],
      ['The Lighthouse (arc-1)', 'arc-1'],
      ['[arc-1]', 'arc-1'],
      ['(arc-1)', 'arc-1'],
      ['[arc-2] Маяк', 'arc-2'],
      ['arc-2: Маяк', 'arc-2'],
      ['arc-3 Долг', 'arc-3'],
      ['ARC-3 — Долг', 'arc-3'],
    ] as const) {
      expect(matchArc(arcs, sel)).toMatchObject({ item: { id }, by: 'id' });
    }
  });

  test('the echoed id wins when it exists; else the cleaned title is matched', () => {
    expect(idOf(matchArc(arcs, '[arc-2] The Lighthouse'))).toBe('arc-2');
    expect(matchArc(arcs, '[arc-9] The Lighthouse')).toMatchObject({ item: { id: 'arc-1' }, by: 'key' });
    expect(matchArc(arcs, 'arc-44: маяка')).toMatchObject({ item: { id: 'arc-2' }, by: 'key' });
    expect(matchArc(arcs, '[arc-9]')).toBeUndefined();
    expect(matchArc(arcs, '[arc-9] Something else')).toBeUndefined();
  });

  test('a selector whose cleaned form is an arc\'s title names that arc (its new arc would repeat the title)', () => {
    expect(matchArc(arcs, 'The Lighthouse: the keeper lies')).toMatchObject({ item: { id: 'arc-1' }, by: 'key' });
    expect(matchArc(arcs, 'Маяк. Смотритель лжёт о письме.')).toMatchObject({ item: { id: 'arc-2' }, by: 'key' });
  });
});

describe('applyPlan with echoed selectors (D-123)', () => {
  const stateOf = (arcs: DirectorArc[]): DirectorState => ({
    turn: 3,
    nextId: 10,
    chapters: [],
    arcs,
    seeds: [],
    invisibleArcs: [],
    notes: [],
    pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
    nextIntentions: [],
  });
  const arc = (id: string, title: string): DirectorArc => ({
    id,
    title,
    description: '',
    status: 'building',
    priority: 'active',
    arcType: 'side',
    horizon: 'medium',
    stages: [],
    createdAtTurn: 1,
  });
  const plan = (arcUpdates: PlanningRound['arcUpdates']): PlanningRound => ({
    directive: { mood: 'tense', pacing: 'medium' },
    arcUpdates,
    seedUpdates: [],
    invisibleArcUpdates: [],
    analysis: {},
    chapterUpdate: { action: 'none', title: '' },
  });

  test('the review\'s witnesses: the stage lands on the echoed arc and no second arc is made', () => {
    const base = stateOf([arc('arc-1', 'The Lighthouse'), arc('arc-2', 'Маяк'), arc('arc-3', 'Долг')]);
    for (const u of [
      { arcId: '[arc-1] The Lighthouse', title: '[arc-1] The Lighthouse' },
      { arcId: 'arc-1: The Lighthouse' },
      { arcId: 'arc-1', title: '[arc-1] The Lighthouse' },
      { arcId: '[arc-2] Маяк' },
      { arcId: 'arc-3 Долг' },
    ]) {
      const out = applyPlan(base, plan([{ ...u, newStageTitle: 'The keeper lies' }]), { turn: 4 });
      expect(out.state.arcs).toHaveLength(3);
      expect(out.state.arcs.filter((a) => a.stages.length > 0).map((a) => a.id)).toHaveLength(1);
      expect(out.skipped).toEqual([]);
    }
    const lighthouse = applyPlan(base, plan([{ arcId: '[arc-1] The Lighthouse', newStageTitle: 'The keeper lies' }]), { turn: 4 }).state.arcs[0]!;
    expect(lighthouse).toMatchObject({ id: 'arc-1', stages: [{ title: 'The keeper lies', turn: 4 }], lastProgressTurn: 4 });
  });
});
