// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors.
//
// D-123 / D-116: the core never refuses a state it wrote itself. For fuzzed plans over many turns
// (random shapes, long and odd strings, Cyrillic, CJK, emoji, huge numbers, id echoes),
// checkState(fitState(applyPlan(state, readPlan(raw).value, {turn})).state) is a state, reads back
// as itself, and the next turn plans from it. The generator is seeded: a failure names its seed and turn.
import { describe, expect, test } from 'bun:test';
import { readPlan } from '../../src/agents/director/plan.ts';
import { applyPlan } from '../../src/agents/director/reduce.ts';
import { checkRecord, checkState, emptyState, fitState } from '../../src/agents/director/state.ts';
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
  SCOPES,
  SEED_ACTIONS,
  URGENCIES,
  type DirectorState,
} from '../../src/agents/director/types.ts';
import { proseOf, recordOf, ru, zh } from './fixtures-state.ts';

type Rec = Record<string, unknown>;

/** mulberry32: a small seeded generator (tests only; src never draws random numbers). */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Fuzz {
  private readonly r: () => number;
  constructor(seed: number) {
    this.r = generator(seed);
  }
  int(n: number): number {
    return Math.floor(this.r() * n);
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
  /** A list of 0..max items. */
  some<T>(max: number, make: () => T): T[] {
    return Array.from({ length: this.int(max + 1) }, make);
  }

  private static readonly WORDS = [
    'The Lighthouse', 'Маяк', 'Долг перед гильдией', 'Тайна старой башни', '灯塔', '行会的债务', "The Prince's Quest",
    'Cassian’s Debt', 'Levi Levi Levi Strovolos', 'Mr. Smith’s Debt', 'A cracked bell', 'Треснувший колокол',
    'The Guild', 'Заговор гильдии', 'Bora Bora', '😀 Emoji Arc', 'ёжик в тумане', 'Chapter 4: Return', 'x',
  ];

  /** A title-like string, sometimes with an id echo copied from the prompt's lines. */
  title(s: DirectorState): string {
    const w = this.pick(Fuzz.WORDS);
    if (!this.chance(0.4)) return w;
    const kind = this.pick(['arc', 'hidden', 'seed'] as const);
    // Ids that exist (small N) and ids that do not.
    const n = this.chance(0.7) ? 1 + this.int(Math.max(1, s.nextId)) : 1000 + this.int(1000);
    const id = `${kind}-${n}`;
    return this.pick([
      `[${id}] ${w}`,
      `${id}: ${w}`,
      `(${id}) "${w}"`,
      `${w} (${id})`,
      `[${id}]`,
      id,
      `${id.toUpperCase()} — ${w}`,
      `[${id}] [${id}] ${w}`,
    ]);
  }

  /** Any string: short, very long, Cyrillic, CJK, emoji, whitespace, numeric, nullish, JSON-looking. */
  text(s: DirectorState): string {
    switch (this.int(10)) {
      case 0:
        return ru(1 + this.int(3_000), this.int(50));
      case 1:
        return zh(1 + this.int(3_000), this.int(50));
      case 2:
        return proseOf('🌊ж字 á\n\t', 1 + this.int(2_500), this.int(7));
      case 3:
        return this.pick(['', ' ', '　', 'none', 'null', 'N/A', '-', '[', '{', '{"a":', '[1,', '"quoted"']);
      case 4:
        return this.pick(['7', '-3', '0', '-0', '1e5', '123456789012345678901', '9007199254740993', '12.6', ' 42 ']);
      case 5:
        return `${this.pick(Fuzz.WORDS)} `.repeat(1 + this.int(40));
      default:
        return this.chance(0.5) ? this.title(s) : this.pick(Fuzz.WORDS);
    }
  }

  /** A JSON number, huge ones included (the decoded JSON never holds NaN or Infinity). */
  number(): number {
    return this.pick([0, 1, 3, 12, -1, -0, 0.4, 2.5, 10.6, 1e20, 2 ** 53 + 2, Number.MAX_SAFE_INTEGER, 1e308, -1e308]);
  }

  /** An enum value: right, in another case, with -term, or junk of another type. */
  oneOf(values: readonly string[]): unknown {
    switch (this.int(6)) {
      case 0:
        return this.pick(values).toUpperCase();
      case 1:
        return `${this.pick(values)}-term`;
      case 2:
        return this.pick([null, 'warp', 3, true, '', ['x']]);
      default:
        return this.pick(values);
    }
  }

  /** Something of a random type for a slot, often the right one. */
  any(s: DirectorState, right: () => unknown): unknown {
    if (this.chance(0.8)) return right();
    return this.pick<() => unknown>([() => null, () => this.number(), () => this.text(s), () => true, () => [this.text(s)], () => ({ zz: 1 })])();
  }

  /** A field set that may be absent. */
  maybe(o: Rec, key: string, p: number, value: () => unknown): void {
    if (this.chance(p)) o[key] = value();
  }

  directive(s: DirectorState): Rec {
    const d: Rec = {};
    // Most plans carry a directive with content; some do not (they are refused and skip the turn).
    if (this.chance(0.9)) d.mood = this.any(s, () => this.text(s));
    this.maybe(d, 'pacing', 0.5, () => this.oneOf(PACINGS));
    this.maybe(d, 'sceneGuidance', 0.4, () => ({ setting: this.text(s), atmosphere: this.text(s), tension_level: this.chance(0.5) ? this.number() : this.text(s) }));
    this.maybe(d, 'include', 0.3, () => ({ characters: this.some(14, () => this.text(s)), themes: this.text(s), foreshadowing: this.some(3, () => this.text(s)) }));
    this.maybe(d, 'avoid', 0.2, () => ({ topics: this.some(3, () => this.text(s)), revelations: [this.text(s)] }));
    this.maybe(d, 'arcDirections', 0.4, () => this.some(14, () => ({ arcName: this.title(s), instruction: this.text(s), urgency: this.oneOf(URGENCIES) })));
    this.maybe(d, 'callbacks', 0.3, () => this.some(4, () => ({ reference: this.text(s), instruction: this.text(s) })));
    this.maybe(d, 'characterBeats', 0.3, () => this.some(4, () => ({ character: this.text(s), beat: this.text(s), motivation: this.text(s) })));
    this.maybe(d, 'dialogueGuidance', 0.3, () => this.some(4, () => ({ character: this.text(s), tone: this.text(s), hints: this.some(14, () => this.text(s)) })));
    this.maybe(d, 'endingHook', 0.4, () => this.text(s));
    this.maybe(d, 'narrativeGoal', 0.4, () => this.text(s));
    this.maybe(d, 'unknownKey', 0.05, () => this.text(s));
    return d;
  }

  arcUpdate(s: DirectorState): Rec {
    const u: Rec = {};
    this.maybe(u, this.pick(['arcId', 'arcId', 'id']), 0.7, () => this.any(s, () => this.title(s)));
    this.maybe(u, 'title', 0.6, () => this.any(s, () => (this.chance(0.7) ? this.title(s) : this.text(s))));
    this.maybe(u, 'description', 0.5, () => this.text(s));
    this.maybe(u, 'status', 0.4, () => this.oneOf(ARC_STATUSES));
    this.maybe(u, 'horizon', 0.3, () => this.oneOf(HORIZONS));
    this.maybe(u, 'priority', 0.3, () => this.oneOf(ARC_PRIORITIES));
    this.maybe(u, 'arcType', 0.3, () => this.oneOf(ARC_TYPES));
    this.maybe(u, 'newStageTitle', 0.5, () => this.text(s));
    this.maybe(u, 'newStageDescription', 0.3, () => this.text(s));
    this.maybe(u, 'markNextBeatDelivered', 0.3, () => this.pick([true, false, 'true', 'yes', null]));
    this.maybe(u, 'nextBeat', 0.5, () =>
      this.chance(0.2) ? this.text(s) : { description: this.any(s, () => this.text(s)), targetTurn: this.chance(0.5) ? this.number() : this.text(s) },
    );
    return u;
  }

  seedUpdate(s: DirectorState): Rec {
    const u: Rec = {};
    const known = s.seeds.length > 0 && this.chance(0.5) ? this.pick(s.seeds) : undefined;
    u.title = this.any(s, () => (known !== undefined && this.chance(0.6) ? known.hint : this.text(s)));
    u.action = this.oneOf(SEED_ACTIONS);
    this.maybe(u, 'id', 0.3, () => (known !== undefined ? known.id : this.title(s)));
    this.maybe(u, 'scope', 0.4, () => this.oneOf(SCOPES));
    // The schema says "ID/title of related arc": ids, echoes, titles, long descriptions, '' and 'none'.
    this.maybe(u, 'relatedArcId', 0.7, () => this.any(s, () => (this.chance(0.5) ? this.title(s) : this.text(s))));
    this.maybe(u, 'description', 0.5, () => this.text(s));
    this.maybe(u, 'payoffHorizon', 0.4, () => this.oneOf(HORIZONS));
    this.maybe(u, 'reinforcement', 0.3, () => this.text(s));
    this.maybe(u, 'outcome', 0.2, () => this.text(s));
    return u;
  }

  hiddenUpdate(s: DirectorState): Rec {
    const u: Rec = {};
    const known = s.invisibleArcs.length > 0 && this.chance(0.5) ? this.pick(s.invisibleArcs) : undefined;
    u.title = this.any(s, () => (known !== undefined && this.chance(0.5) ? `[${known.id}] "${known.title}"` : this.title(s)));
    u.action = this.oneOf(HIDDEN_ACTIONS);
    this.maybe(u, 'arcId', 0.3, () => (known !== undefined ? known.id : this.title(s)));
    this.maybe(u, 'description', 0.4, () => this.text(s));
    this.maybe(u, 'status', 0.3, () => this.oneOf(HIDDEN_STATUSES));
    this.maybe(u, 'arcType', 0.3, () => this.oneOf(HIDDEN_ARC_TYPES));
    this.maybe(u, 'horizon', 0.3, () => this.oneOf(HORIZONS));
    this.maybe(u, 'scope', 0.3, () => this.oneOf(SCOPES));
    this.maybe(u, 'surfaceCondition', 0.3, () => this.text(s));
    this.maybe(u, 'newClue', 0.5, () => this.text(s));
    this.maybe(u, 'newStageTitle', 0.4, () => this.text(s));
    return u;
  }

  plan(s: DirectorState): Rec {
    const raw: Rec = { directive: this.directive(s) };
    this.maybe(raw, 'arcUpdates', 0.8, () => this.some(6, () => this.arcUpdate(s)));
    this.maybe(raw, 'seedUpdates', 0.8, () => this.some(6, () => this.seedUpdate(s)));
    this.maybe(raw, 'invisibleArcUpdates', 0.6, () => this.some(4, () => this.hiddenUpdate(s)));
    this.maybe(raw, 'analysis', 0.6, () =>
      this.chance(0.2)
        ? this.text(s)
        : {
            whatHappened: this.text(s),
            intentions: this.some(12, () => (this.chance(0.3) ? this.text(s) : { type: this.text(s), description: this.text(s), priority: this.oneOf(INTENTION_PRIORITIES), targetTurn: this.oneOf(INTENTION_TARGETS) })),
            suggestedActions: this.some(3, () => this.text(s)),
          },
    );
    this.maybe(raw, 'chapterUpdate', 0.8, () => ({
      action: this.oneOf(CHAPTER_ACTIONS),
      title: this.any(s, () => this.text(s)),
      description: this.text(s),
      status: this.oneOf(CHAPTER_STATUSES),
      themes: this.some(16, () => this.text(s)),
      objectives: this.some(16, () => this.text(s)),
      tone: this.text(s),
      closingMoment: this.text(s),
    }));
    // A section sent as a JSON string now and then (D-107).
    if (this.chance(0.1) && Array.isArray(raw.arcUpdates)) raw.arcUpdates = JSON.stringify(raw.arcUpdates);
    return raw;
  }
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('the core never refuses a state it wrote (D-116, D-123)', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const TURNS = 60;

  for (const seed of SEEDS) {
    test(`fuzzed plans, seed ${seed}: checkState(fitState(applyPlan(…))) is a state that reads back as itself`, () => {
      const fuzz = new Fuzz(seed);
      let state = emptyState();
      let planned = 0;
      for (let i = 0; i < TURNS; i++) {
        const raw = fuzz.plan(state);
        const read = readPlan(json(raw), { lite: fuzz.chance(0.3) });
        const turn = state.turn + 1;
        // A refused plan keeps the state with the new turn (call.ts); it must read back too.
        const next = read.ok ? applyPlan(state, read.value, { turn }).state : { ...state, turn };
        if (read.ok) planned++;
        const stored = json(fitState(next).state);
        const back = checkState(stored);
        if (back === null) throw new Error(`seed ${seed}, turn ${turn}: checkState refused the state it wrote; plan ${JSON.stringify(raw).slice(0, 2_000)}`);
        expect(back).toEqual(stored);
        expect(checkState(json(back))).toEqual(back);
        state = back;
      }
      // The run exercised the reducer, not only refusals.
      expect(planned).toBeGreaterThan(TURNS / 2);
      expect(state.turn).toBe(TURNS);
    });
  }
});

describe("the review's witnesses, end to end (readPlan → applyPlan → fitState → the stored record)", () => {
  /** One turn as call.ts runs it, and the record read back from JSON as the next turn's fold reads it. */
  function turnOn(state: DirectorState, raw: Rec): { state: DirectorState; skipped: string[] } {
    const read = readPlan(json(raw), { lite: false });
    if (!read.ok) throw new Error(read.message);
    const applied = applyPlan(state, read.value, { turn: state.turn + 1 });
    const fitted = fitState(applied.state);
    const record = checkRecord(json(recordOf(fitted.state)));
    expect(record).not.toBeNull();
    expect(record!.state).toEqual(json(fitted.state));
    return { state: record!.state, skipped: [...read.skipped, ...applied.skipped, ...fitted.skipped].map((x) => `${x.path}: ${x.why}`) };
  }
  const longRelated = 'The slow unraveling of the Ashford family secret about the fire at the old mill (arc-1)';

  test('a relatedArcId of 87 chars naming an arc is stored as its id (it made the next read refuse the record)', () => {
    let s = turnOn(emptyState(), { directive: { mood: 'tense' }, arcUpdates: [{ title: 'The Ashford Secret' }] }).state;
    const out = turnOn(s, { directive: { mood: 'tense' }, seedUpdates: [{ title: 'A scorched ring', action: 'plant', relatedArcId: longRelated }] });
    s = out.state;
    expect(s.seeds[0]).toMatchObject({ hint: 'A scorched ring', relatedArcId: 'arc-1' });
    expect(out.skipped).toEqual([]);
  });

  test('a relatedArcId naming no arc is dropped and skipped; the seed is kept', () => {
    const out = turnOn(emptyState(), { directive: { mood: 'tense' }, seedUpdates: [{ title: 'A scorched ring', action: 'plant', relatedArcId: longRelated }] });
    expect(out.state.seeds).toHaveLength(1);
    expect('relatedArcId' in out.state.seeds[0]!).toBe(false);
    expect(out.skipped).toEqual([`seedUpdates[0].relatedArcId: no arc matches "${longRelated.slice(0, 60)}…"`]);
  });

  test('a target turn of 1e20 or "123456789012345678901" is dropped and skipped; the beat is kept', () => {
    for (const targetTurn of [1e20, '123456789012345678901']) {
      const out = turnOn(emptyState(), { directive: { mood: 'tense' }, arcUpdates: [{ title: 'The Ring', nextBeat: { description: 'ring', targetTurn } }] });
      expect(out.state.arcs[0]!.nextBeat).toEqual({ description: 'ring', plannedAtTurn: 1, status: 'pending' });
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]).toStartWith('arcUpdates[0].nextBeat.targetTurn: not a turn number');
    }
  });

  test("'[arc-1] The Lighthouse' and '[hidden-1] \"The Guild\"' land on their items over turns: no duplicates", () => {
    let s = turnOn(emptyState(), {
      directive: { mood: 'tense' },
      arcUpdates: [{ title: 'The Lighthouse' }],
      invisibleArcUpdates: [{ title: 'The Guild', action: 'add' }],
    }).state;
    for (let i = 0; i < 3; i++) {
      s = turnOn(s, {
        directive: { mood: 'tense' },
        arcUpdates: [{ title: '[arc-1] The Lighthouse', newStageTitle: `stage ${i}` }],
        invisibleArcUpdates: [{ title: '[hidden-2] "The Guild"', action: 'update', newClue: `clue ${i}` }],
      }).state;
    }
    expect(s.arcs.map((a) => [a.id, a.title, a.stages.length])).toEqual([['arc-1', 'The Lighthouse', 3]]);
    expect(s.invisibleArcs.map((h) => [h.id, h.title, h.playerClues.length])).toEqual([['hidden-2', 'The Guild', 3]]);
  });
});
