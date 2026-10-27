// Ported from Bunraku:src/core/director/state.ts, src/core/director/bounds.ts and
// src/stage/store/director-rules.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi:
// emptyDirectorState, prune / fitState, checkDirectorState) and
// RoleCall:apps/rc/src/lib/ai/dm-stream/seed-aging.ts@fb8dc623e (Levi: seedTurnsActive, the derived age).
// Copyright (C) 2026 Coneja-Chibi, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Director's state (ARCHITECTURE.md §7.3, §5.9, D-61; .notes/m4-decisions.md A.6, A.8, D-103):
// the empty state, derived ages, the size and the limits (fitState), the checks for a `dir` read
// from disk (checkState, checkRecord) and the fold on the path (directorAt). Pure.
//
// Port notes. Kept: the empty state's values (turn 0, nextId 1, mood 'ambient', rhythm 0/0); prune's
// three finished kinds and their oldest-first keys; fitState's "the same object when it fits", its
// best effort (a state still too big is returned, never thrown) and that nothing a person wrote is
// ever evicted; checkDirectorState's ids (1..80 chars, unique per collection) and whole turns.
// Changed: the cap is UTF-8 bytes, not UTF-16 units (A.6); the structural limits of D-61 run first
// on every state, then the §7.3 size steps (not Bunraku's activity/prune/working-set steps), each
// recorded as a `skipped` entry; the working sets keep the survivors in their order (Bunraku
// re-sorted them); evicting seeds keeps `lastPlantTurn`; a person's items keep their texts whole
// (their stage / clue / reinforcement lists are capped like any other, the model writes those);
// checkState rebuilds a clean state (unknown keys are not copied) and returns null instead of
// throwing; arrays are bounded at 4x the D-61 limits (older files may hold more), each string at
// 2 000 code points and the JSON at 4x the hard cap (D-116: the core never refuses a state it
// wrote); a seed's relatedArcId and a beat's targetTurn are read leniently (dropped when bad, D-123).
// Added: checkRecord, checkDirective, directorAt, clipText (word-boundary cut), chapter
// themes held to 12, checkState raising `nextId` past the ids already issued, and two last-resort
// size steps (D-116: every model text to 120 chars and smaller working sets, then no lastDirective).

import type { TreeIndex } from '../../session/tree.ts';
import {
  ARC_PRIORITIES,
  ARC_STATUSES,
  ARC_TYPES,
  CHAPTER_STATUSES,
  HIDDEN_ARC_TYPES,
  HIDDEN_STATUSES,
  HORIZONS,
  INTENTION_PRIORITIES,
  INTENTION_TARGETS,
  NEXT_BEAT_STATUSES,
  PACINGS,
  READ_LIMITS,
  REDUCER_VERSION,
  SCOPES,
  STATE_LIMITS,
  URGENCIES,
  type DirectorArc,
  type DirectorAttempt,
  type DirectorChapter,
  type DirectorFailCode,
  type DirectorIntention,
  type DirectorInvisibleArc,
  type DirectorNextBeat,
  type DirectorNote,
  type DirectorRecord,
  type DirectorSeed,
  type DirectorStage,
  type DirectorState,
  type NarratorDirective,
  type PlanningAnalysis,
  type Skip,
} from './types.ts';

const L = STATE_LIMITS;

// ---- basics -------------------------------------------------------------------------------------

/** The state before the Director's first turn (Bunraku emptyDirectorState values). */
export function emptyState(): DirectorState {
  return {
    turn: 0,
    nextId: 1,
    chapters: [],
    arcs: [],
    seeds: [],
    invisibleArcs: [],
    notes: [],
    pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
    nextIntentions: [],
  };
}

/** Turns since `from` (createdAtTurn, plantedAtTurn…), never negative; 0 when `from` is missing. */
export function ageOf(turn: number, from: number | undefined): number {
  if (typeof from !== 'number' || !Number.isFinite(from) || !Number.isFinite(turn)) return 0;
  return Math.max(0, turn - from);
}

const utf8 = new TextEncoder();

/** UTF-8 bytes of JSON.stringify(state): what STATE_LIMITS.hardBytes caps (A.6). */
export function stateBytes(state: DirectorState): number {
  return utf8.encode(JSON.stringify(state)).byteLength;
}

/**
 * `text` cut to `max` code points (never half a surrogate pair), at the last whitespace when that
 * keeps at least half of it; '…' marks a cut and counts toward `max`. Text within `max` is returned
 * as is, so a cut text is never cut again.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text; // UTF-16 length >= code points
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  if (max < 2) return cps.slice(0, Math.max(0, max)).join('');
  let head = cps.slice(0, max - 1).join('');
  const space = head.search(/\s\S*$/u);
  if (space > 0 && space >= head.length / 2) head = head.slice(0, space);
  return `${head.trimEnd()}…`;
}

/** An arc that is over (complete or abandoned). */
export const isFinishedArc = (a: DirectorArc): boolean => a.status === 'complete' || a.status === 'abandoned';
/** A seed whose payoff was delivered. */
export const isPaidSeed = (x: DirectorSeed): boolean => x.payoffDelivered;
/** A hidden arc that is over for the shadow world (resolved, or surfaced into the visible story). */
export const isFinishedHidden = (h: DirectorInvisibleArc): boolean => h.status === 'resolved' || h.status === 'visible';

// ---- copy on write ------------------------------------------------------------------------------

/** `list` mapped by `f`; the same array when `f` returned every item unchanged. */
function mapSame<T>(list: T[], f: (x: T) => T): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const x = list[i]!;
    const y = f(x);
    if (out === null) {
      if (y === x) continue;
      out = list.slice(0, i);
    }
    out.push(y);
  }
  return out ?? list;
}

/** `x` with `patch`; the same object when every patched value is already there. */
function patched<T extends object>(x: T, patch: Partial<T>): T {
  for (const k of Object.keys(patch) as (keyof T)[]) if (patch[k] !== x[k]) return { ...x, ...patch };
  return x;
}

/** Every string inside a JSON value cut to `max`; the same value when nothing was cut. */
function clipDeep<T>(v: T, max: number): T {
  if (typeof v === 'string') return clipText(v, max) as T;
  if (Array.isArray(v)) return mapSame(v as unknown[], (x) => clipDeep(x, max)) as T;
  if (typeof v === 'object' && v !== null) {
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(v)) {
      const y = clipDeep(x, max);
      if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
    }
    return (out ?? v) as T;
  }
  return v;
}

const lastN = <T>(list: T[], n: number): T[] => (list.length <= n ? list : list.slice(list.length - n));
const firstN = <T>(list: T[], n: number): T[] => (list.length <= n ? list : list.slice(0, n));

/** The items of `list` beyond the newest `keep` by `older` (a stable sort: equal keys go in list order). */
function oldestBeyond<T>(list: readonly T[], keep: number, older: (a: T, b: T) => number): Set<T> {
  if (list.length <= keep) return new Set();
  return new Set([...list].sort(older).slice(0, list.length - keep));
}

const byKey =
  <T>(key: (x: T) => number) =>
  (a: T, b: T): number =>
    key(a) - key(b);

// ---- eviction (never a person's item) -----------------------------------------------------------

const arcProgress = (a: DirectorArc): number => a.lastProgressTurn ?? a.createdAtTurn;

function dropArcs(s: DirectorState, drop: ReadonlySet<DirectorArc>): DirectorState {
  return drop.size === 0 ? s : { ...s, arcs: s.arcs.filter((a) => !drop.has(a)) };
}

/** Seeds out; `lastPlantTurn` keeps the newest planting so the planting pressure stays true. */
function dropSeeds(s: DirectorState, drop: ReadonlySet<DirectorSeed>): DirectorState {
  if (drop.size === 0) return s;
  let last = s.lastPlantTurn;
  for (const x of s.seeds) if (last === undefined || x.plantedAtTurn > last) last = x.plantedAtTurn;
  return { ...s, seeds: s.seeds.filter((x) => !drop.has(x)), ...(last !== undefined ? { lastPlantTurn: last } : {}) };
}

function dropHidden(s: DirectorState, drop: ReadonlySet<DirectorInvisibleArc>): DirectorState {
  return drop.size === 0 ? s : { ...s, invisibleArcs: s.invisibleArcs.filter((h) => !drop.has(h)) };
}

function keepFinishedArcs(s: DirectorState, keep: number): DirectorState {
  const done = s.arcs.filter((a) => isFinishedArc(a) && a.byUser !== true);
  return dropArcs(s, oldestBeyond(done, keep, byKey(arcProgress)));
}

function keepPaidSeeds(s: DirectorState, keep: number): DirectorState {
  const paid = s.seeds.filter((x) => isPaidSeed(x) && x.byUser !== true);
  return dropSeeds(s, oldestBeyond(paid, keep, byKey((x) => x.payoffTurn ?? x.plantedAtTurn)));
}

function keepFinishedHidden(s: DirectorState, keep: number): DirectorState {
  const done = s.invisibleArcs.filter((h) => isFinishedHidden(h) && h.userAuthored !== true);
  return dropHidden(s, oldestBeyond(done, keep, byKey((h) => h.createdAtTurn)));
}

const keepCompleted = (s: DirectorState, keep: number): DirectorState =>
  keepFinishedHidden(keepPaidSeeds(keepFinishedArcs(s, keep), keep), keep);

/** The current chapter plus the newest `keep` others. */
function keepChapters(s: DirectorState, keep: number): DirectorState {
  const done = s.chapters.filter((c) => c.id !== s.currentChapterId);
  const drop = oldestBeyond(done, keep, (a, b) => a.createdAtTurn - b.createdAtTurn || a.number - b.number);
  return drop.size === 0 ? s : { ...s, chapters: s.chapters.filter((c) => !drop.has(c)) };
}

/** The working sets: every person's item plus the newest arcs, seeds and hidden arcs of the model. */
function keepWorkingSets(s: DirectorState, arcs: number, seeds: number, hidden: number): DirectorState {
  let out = dropArcs(s, oldestBeyond(s.arcs.filter((a) => a.byUser !== true), arcs, byKey(arcProgress)));
  out = dropSeeds(out, oldestBeyond(out.seeds.filter((x) => x.byUser !== true), seeds, byKey((x) => x.plantedAtTurn)));
  return dropHidden(out, oldestBeyond(out.invisibleArcs.filter((h) => h.userAuthored !== true), hidden, byKey((h) => h.createdAtTurn)));
}

// ---- per-item lists and texts -------------------------------------------------------------------

function capStages(s: DirectorState, n: number): DirectorState {
  return patched(s, {
    arcs: mapSame(s.arcs, (a) => patched(a, { stages: lastN(a.stages, n) })),
    invisibleArcs: mapSame(s.invisibleArcs, (h) => patched(h, { stages: lastN(h.stages, n) })),
  });
}

const capReinforcements = (s: DirectorState, n: number): DirectorState =>
  patched(s, { seeds: mapSame(s.seeds, (x) => patched(x, { reinforcements: lastN(x.reinforcements, n) })) });

const capClues = (s: DirectorState, n: number): DirectorState =>
  patched(s, { invisibleArcs: mapSame(s.invisibleArcs, (h) => patched(h, { playerClues: lastN(h.playerClues, n) })) });

/** Chapter themes: no D-61 limit, held to the plan's list limit (D-107) so a chapter stays bounded. */
const capThemes = (s: DirectorState, n: number): DirectorState =>
  patched(s, { chapters: mapSame(s.chapters, (c) => patched(c, { themes: firstN(c.themes, n) })) });

/** Intentions come in the model's order of importance: the first ones stay. */
const capIntentions = (s: DirectorState, n: number): DirectorState => patched(s, { nextIntentions: firstN(s.nextIntentions, n) });

type Cut = (v: string) => string;
const same: Cut = (v) => v;

/**
 * Every text field cut by `t`, arc and hidden-arc titles (their match keys) and a seed's
 * relatedArcId by `title`, the lastDirective's strings to `directive` code points (null: left alone);
 * a person's items untouched.
 */
function capTexts(s: DirectorState, t: Cut, title: Cut, directive: number | null): DirectorState {
  const stages = (list: DirectorStage[]): DirectorStage[] => mapSame(list, (st) => patched(st, { title: t(st.title) }));
  const chapters = mapSame(s.chapters, (c) =>
    patched(c, {
      title: t(c.title),
      premise: t(c.premise),
      tone: t(c.tone),
      majorGoal: t(c.majorGoal),
      themes: mapSame(c.themes, t),
      ...(c.closingMoment !== undefined ? { closingMoment: t(c.closingMoment) } : {}),
    }),
  );
  const arcs = mapSame(s.arcs, (a) =>
    a.byUser === true
      ? a
      : patched(a, {
          title: title(a.title),
          description: t(a.description),
          stages: stages(a.stages),
          ...(a.nextBeat ? { nextBeat: patched(a.nextBeat, { description: t(a.nextBeat.description) }) } : {}),
        }),
  );
  // relatedArcId is an arc's id (reduce resolves it); an older build's long text is held to the title cap.
  const seeds = mapSame(s.seeds, (x) =>
    x.byUser === true
      ? x
      : patched(x, { hint: t(x.hint), payoff: t(x.payoff), ...(x.relatedArcId !== undefined ? { relatedArcId: title(x.relatedArcId) } : {}) }),
  );
  const invisibleArcs = mapSame(s.invisibleArcs, (h) =>
    h.userAuthored === true
      ? h
      : patched(h, {
          title: title(h.title),
          description: t(h.description),
          stages: stages(h.stages),
          playerClues: mapSame(h.playerClues, (c) => patched(c, { clue: t(c.clue) })),
          ...(h.surfaceCondition !== undefined ? { surfaceCondition: t(h.surfaceCondition) } : {}),
        }),
  );
  const nextIntentions = mapSame(s.nextIntentions, (i) => patched(i, { type: t(i.type), description: t(i.description) }));
  const pacing = patched(s.pacing, { currentMood: t(s.pacing.currentMood) });
  const lastDirective = s.lastDirective && directive !== null && patched(s.lastDirective, { directive: clipDeep(s.lastDirective.directive, directive) });
  return patched(s, { chapters, arcs, seeds, invisibleArcs, nextIntentions, pacing, ...(lastDirective ? { lastDirective } : {}) });
}

/**
 * D-116 step 6's cut: `text` to `max` code points and, besides, to `maxBytes` UTF-8 bytes ('…'
 * included), so a 3- or 4-byte script is held to the same bytes as Cyrillic. Idempotent.
 */
function clipTextBytes(text: string, max: number, maxBytes: number): string {
  const out = clipText(text, max);
  if (out.length * 3 <= maxBytes || utf8.encode(out).byteLength <= maxBytes) return out; // a UTF-16 unit is ≤ 3 bytes
  const cps = Array.from(text);
  let bytes = 3; // '…'
  let fit = 0; // code points that fit before the '…'
  while (fit < cps.length && bytes + cpBytes(cps[fit]!) <= maxBytes) bytes += cpBytes(cps[fit++]!);
  // clipText(text, n) keeps at most n − 1 code points before its '…' when the text is longer than n.
  return clipText(text, Math.min(max, fit + 1, cps.length - 1));
}

/** UTF-8 bytes of one code point. */
function cpBytes(ch: string): number {
  const cp = ch.codePointAt(0)!;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** §7.3 step 3: the long texts of the model's items to `n` code points. */
function shortDescriptions(s: DirectorState, n: number): DirectorState {
  const t = (v: string): string => clipText(v, n);
  return patched(s, {
    arcs: mapSame(s.arcs, (a) =>
      a.byUser === true
        ? a
        : patched(a, {
            description: t(a.description),
            ...(a.nextBeat ? { nextBeat: patched(a.nextBeat, { description: t(a.nextBeat.description) }) } : {}),
          }),
    ),
    seeds: mapSame(s.seeds, (x) => (x.byUser === true ? x : patched(x, { payoff: t(x.payoff) }))),
    invisibleArcs: mapSame(s.invisibleArcs, (h) => (h.userAuthored === true ? h : patched(h, { description: t(h.description) }))),
  });
}

// ---- fitState -----------------------------------------------------------------------------------

type Op = (s: DirectorState) => DirectorState;

/** The D-61 limits every state is held to; each that removed something is a `limit:<name>` skip. */
const LIMITS: readonly (readonly [string, Op])[] = [
  ['completed-arcs', (s) => keepFinishedArcs(s, L.completedPerKind)],
  ['completed-seeds', (s) => keepPaidSeeds(s, L.completedPerKind)],
  ['completed-hidden', (s) => keepFinishedHidden(s, L.completedPerKind)],
  ['chapters', (s) => keepChapters(s, L.completedChapters)],
  ['stages', (s) => capStages(s, L.stages)],
  ['reinforcements', (s) => capReinforcements(s, L.reinforcements)],
  ['clues', (s) => capClues(s, L.clues)],
  ['intentions', (s) => capIntentions(s, L.intentions)],
  ['themes', (s) => capThemes(s, L.themes)],
  ['text', (s) => capTexts(s, (v) => clipText(v, L.text), (v) => clipText(v, L.arcTitle), L.text)],
];

/**
 * D-116 step 6: every model text to 120 code points and 240 UTF-8 bytes (120 Cyrillic letters; a CJK
 * text keeps ~80, so a CJK state fits the cap too). Arc and hidden-arc titles keep their 80.
 */
export const LAST_RESORT_TEXT = { chars: 120, bytes: 240 } as const;

/** The size steps in order (§7.3 1–5, D-116 6–7); each that changed the state is a `fit:<step>` skip. */
export const FIT_STEPS = ['completed-5', 'completed-0', 'lists', 'descriptions', 'chapters', 'working-sets', 'texts', 'last-directive'] as const;
export type FitStep = (typeof FIT_STEPS)[number];

const STEPS: Readonly<Record<FitStep, Op>> = {
  'completed-5': (s) => keepCompleted(s, 5),
  'completed-0': (s) => keepCompleted(s, 0),
  lists: (s) => capReinforcements(capClues(capStages(s, 3), 3), 2),
  descriptions: (s) => capIntentions(capStages(shortDescriptions(s, 160), 1), 3),
  chapters: (s) => keepChapters(s, 2),
  'working-sets': (s) => keepWorkingSets(s, 12, 16, 6),
  texts: (s) =>
    capTexts(
      capClues(keepChapters(keepWorkingSets(s, 8, 10, 4), 0), 1),
      (v) => clipTextBytes(v, LAST_RESORT_TEXT.chars, LAST_RESORT_TEXT.bytes),
      same,
      null,
    ),
  // The next turn then skips the self-audit (it reads only lastDirective).
  'last-directive': (s) => {
    if (s.lastDirective === undefined) return s;
    const { lastDirective: _, ...rest } = s;
    return rest;
  },
};

/** The `skipped` entry when a state is still over the cap after the last step (a person's items). */
export const FIT_OVER_CAP: Skip = { path: 'state', why: 'fit:over-cap' };

/**
 * The state held to the D-61 limits and then, while its UTF-8 JSON is over `maxBytes`, shrunk by the
 * size steps in order (§7.3, D-116). Pure: the input is never changed, and it comes back as the same
 * object when nothing had to change. A person's items (byUser, userAuthored, notes) are never evicted
 * nor their texts cut, so a state can stay over the cap: it is returned as is with FIT_OVER_CAP in
 * `skipped`. Without them a state of the core's own ids ends within the cap in any script (worst
 * measured, every D-61 limit after step 7: ≈ 28 KB, Chinese or 4-byte text).
 */
export function fitState(state: DirectorState, maxBytes: number = L.hardBytes): { state: DirectorState; skipped: Skip[] } {
  const skipped: Skip[] = [];
  let s = state;
  for (const [what, op] of LIMITS) {
    const next = op(s);
    if (next !== s) skipped.push({ path: 'state', why: `limit:${what}` });
    s = next;
  }
  let bytes = stateBytes(s);
  for (const step of FIT_STEPS) {
    if (bytes <= maxBytes) break;
    const next = STEPS[step](s);
    if (next === s) continue;
    s = next;
    bytes = stateBytes(s);
    skipped.push({ path: 'state', why: `fit:${step}` });
  }
  if (bytes > maxBytes) skipped.push({ ...FIT_OVER_CAP });
  return { state: s, skipped };
}

// ---- checks for what is read from disk ----------------------------------------------------------
// A check rebuilds a clean value from the known keys (unknown keys are not copied: the state the
// core writes back holds only what it understands, and stays bounded). Anything the code reads must
// have its type; a broken state is refused whole (null), the fold then takes an older ancestor.

/** How far a stored state may exceed the D-61 limits (older files, a person's items). */
const SLACK = 4;
const BOUND = {
  chapters: SLACK * (1 + L.completedChapters),
  arcs: SLACK * (L.liveArcs + L.completedPerKind),
  seeds: SLACK * (L.liveSeeds + L.completedPerKind),
  invisibleArcs: SLACK * (L.liveHidden + L.completedPerKind),
  notes: SLACK * L.notes,
  stages: SLACK * L.stages,
  reinforcements: SLACK * L.reinforcements,
  clues: SLACK * L.clues,
  intentions: SLACK * L.intentions,
  /** Lists with no D-61 limit (chapter themes, directive and analysis lists). */
  list: SLACK * READ_LIMITS.directiveList,
  /** Strings in the lenient parts of a record (directive, analysis, skipped, model). */
  text: SLACK * L.text,
  skipped: 200,
  attempts: 16,
} as const;

/**
 * D-116: what checkState takes besides the list bounds. Each string ≤ `string` code points (the
 * model's texts are held to 300; room for a person's), the whole JSON ≤ `jsonBytes` UTF-8 bytes
 * (4x the cap: fitState's states always pass, and older or edited files get room).
 */
export const CHECK_LIMITS = { string: 2_000, jsonBytes: 4 * L.hardBytes } as const;

/** At most `max` code points (UTF-16 length first: it is never smaller). */
const withinChars = (v: string, max: number): boolean => v.length <= max || Array.from(v).length <= max;

const INVALID = new Error('invalid director state');
function bad(): never {
  throw INVALID;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

const obj = (v: unknown): Obj => (isObj(v) ? v : bad());
const str = (v: unknown): string => (isStr(v) && withinChars(v, CHECK_LIMITS.string) ? v : bad());
/** A turn, a count or a counter: a whole number >= 0. */
const whole = (v: unknown): number => (isWhole(v) ? v : bad());
const anId = (v: unknown): string => (typeof v === 'string' && v.length >= 1 && v.length <= 80 ? v : bad());
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : bad());
const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): T =>
    isIn(list, v) ? v : bad();
/** An optional field: absent or null reads as absent. */
const opt = <T>(v: unknown, read: (v: unknown) => T): T | undefined => (v === undefined || v === null ? undefined : read(v));
const list = <T>(v: unknown, max: number, read: (v: unknown) => T): T[] => (Array.isArray(v) && v.length <= max ? v.map(read) : bad());
/** byUser / userAuthored: true, or absent (false and null read as absent). */
const flag = (v: unknown): true | undefined => (v === true ? true : v === undefined || v === null || v === false ? undefined : bad());

/** `o` without its undefined keys (optional fields stay absent, as JSON would have them). */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  for (const x of items) {
    if (seen.has(x.id)) bad();
    seen.add(x.id);
  }
  return items;
}

const readStage = (v: unknown): DirectorStage => {
  const o = obj(v);
  return { title: str(o.title), turn: whole(o.turn) };
};

const readBeat = (v: unknown): DirectorNextBeat => {
  const o = obj(v);
  return compact({
    description: str(o.description),
    plannedAtTurn: whole(o.plannedAtTurn),
    // Lenient [D-123]: the model's rough target; a bad one (1e20 from an older build) is dropped, never a refusal.
    targetTurn: isWhole(o.targetTurn) ? o.targetTurn : undefined,
    status: oneOf(NEXT_BEAT_STATUSES)(o.status),
    deliveredAtTurn: opt(o.deliveredAtTurn, whole),
  });
};

const readChapter = (v: unknown): DirectorChapter => {
  const o = obj(v);
  return compact({
    id: anId(o.id),
    number: whole(o.number),
    title: str(o.title),
    premise: str(o.premise),
    status: oneOf(CHAPTER_STATUSES)(o.status),
    themes: list(o.themes, BOUND.list, str),
    tone: str(o.tone),
    majorGoal: str(o.majorGoal),
    closingMoment: opt(o.closingMoment, str),
    createdAtTurn: whole(o.createdAtTurn),
  });
};

const readArc = (v: unknown): DirectorArc => {
  const o = obj(v);
  return compact({
    id: anId(o.id),
    title: str(o.title),
    description: str(o.description),
    chapterId: opt(o.chapterId, anId),
    status: oneOf(ARC_STATUSES)(o.status),
    priority: oneOf(ARC_PRIORITIES)(o.priority),
    arcType: oneOf(ARC_TYPES)(o.arcType),
    horizon: oneOf(HORIZONS)(o.horizon),
    lastProgressTurn: opt(o.lastProgressTurn, whole),
    stages: list(o.stages, BOUND.stages, readStage),
    nextBeat: opt(o.nextBeat, readBeat),
    createdAtTurn: whole(o.createdAtTurn),
    byUser: flag(o.byUser),
  });
};

const readSeed = (v: unknown): DirectorSeed => {
  const o = obj(v);
  return compact({
    id: anId(o.id),
    hint: str(o.hint),
    payoff: str(o.payoff),
    scope: oneOf(SCOPES)(o.scope),
    plantedAtTurn: whole(o.plantedAtTurn),
    payoffHorizon: oneOf(HORIZONS)(o.payoffHorizon),
    payoffDelivered: bool(o.payoffDelivered),
    payoffTurn: opt(o.payoffTurn, whole),
    // Lenient [D-123]: a reference, not this seed's identity. An older build stored the model's text
    // (an arc's title or description); a 1..2 000-char string is kept, anything else dropped.
    relatedArcId: isStr(o.relatedArcId) && o.relatedArcId !== '' && withinChars(o.relatedArcId, CHECK_LIMITS.string) ? o.relatedArcId : undefined,
    reinforcements: list(o.reinforcements, BOUND.reinforcements, (r) => ({ turn: whole(obj(r).turn) })),
    byUser: flag(o.byUser),
  });
};

const readHidden = (v: unknown): DirectorInvisibleArc => {
  const o = obj(v);
  return compact({
    id: anId(o.id),
    title: str(o.title),
    description: str(o.description),
    arcType: oneOf(HIDDEN_ARC_TYPES)(o.arcType),
    horizon: oneOf(HORIZONS)(o.horizon),
    scope: oneOf(SCOPES)(o.scope),
    status: oneOf(HIDDEN_STATUSES)(o.status),
    stages: list(o.stages, BOUND.stages, readStage),
    surfaceCondition: opt(o.surfaceCondition, str),
    playerClues: list(o.playerClues, BOUND.clues, (c) => {
      const x = obj(c);
      return { turn: whole(x.turn), clue: str(x.clue) };
    }),
    createdAtTurn: whole(o.createdAtTurn),
    userAuthored: flag(o.userAuthored),
  });
};

const readNote = (v: unknown): DirectorNote => {
  const o = obj(v);
  return { id: anId(o.id), content: str(o.content), createdAtTurn: whole(o.createdAtTurn) };
};

const readIntention = (v: unknown): DirectorIntention => {
  const o = obj(v);
  return {
    type: str(o.type),
    description: str(o.description),
    priority: oneOf(INTENTION_PRIORITIES)(o.priority),
    targetTurn: oneOf(INTENTION_TARGETS)(o.targetTurn),
  };
};

/** The highest N of the arc-N / seed-N / hidden-N ids (the one counter of state.nextId). */
function highestId(s: DirectorState): number {
  let max = 0;
  for (const x of [...s.arcs, ...s.seeds, ...s.invisibleArcs]) {
    const m = /^(?:arc|seed|hidden)-(\d{1,15})$/.exec(x.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function readState(v: unknown): DirectorState {
  const o = obj(v);
  const p = obj(o.pacing);
  const rhythm = obj(p.rhythm);
  // Lenient: a malformed lastDirective is dropped, not a reason to refuse the state.
  const ld = o.lastDirective;
  const directive = isObj(ld) && isWhole(ld.turn) ? cleanDirective(ld.directive) : undefined;
  const lastDirective = isObj(ld) && isWhole(ld.turn) && directive ? { turn: ld.turn, directive } : undefined;
  const s: DirectorState = compact({
    turn: whole(o.turn),
    nextId: whole(o.nextId),
    chapters: uniqueIds(list(o.chapters, BOUND.chapters, readChapter)),
    currentChapterId: opt(o.currentChapterId, anId),
    arcs: uniqueIds(list(o.arcs, BOUND.arcs, readArc)),
    seeds: uniqueIds(list(o.seeds, BOUND.seeds, readSeed)),
    invisibleArcs: uniqueIds(list(o.invisibleArcs, BOUND.invisibleArcs, readHidden)),
    notes: uniqueIds(list(o.notes, BOUND.notes, readNote)),
    pacing: {
      currentMood: str(p.currentMood),
      turnsAtCurrentMood: whole(p.turnsAtCurrentMood),
      rhythm: { lastActionSequence: whole(rhythm.lastActionSequence), lastQuietMoment: whole(rhythm.lastQuietMoment) },
    },
    nextIntentions: list(o.nextIntentions, BOUND.intentions, readIntention),
    lastDirective,
    lastPlantTurn: opt(o.lastPlantTurn, whole),
  });
  // A counter behind its own ids would issue a duplicate id, and the next read would refuse the state.
  const high = highestId(s);
  if (s.nextId <= high) s.nextId = high + 1;
  return s;
}

/**
 * A DirectorState read from disk (a `dir.state`), rebuilt from its known keys, or null when it is
 * not one: a field the code reads has the wrong type, an enum value is unknown, an id is not 1..80
 * chars or repeats in its collection, a turn is not a whole number >= 0, a list is longer than 4x
 * its D-61 limit, a string is over CHECK_LIMITS.string code points, or the JSON is over
 * CHECK_LIMITS.jsonBytes (D-116). Lenient: unknown keys are dropped, null optional fields read as
 * absent, a malformed `lastDirective` is dropped and its strings cut (only the self-audit reads it),
 * a seed's `relatedArcId` that is not a 1..2 000-char string and a beat's `targetTurn` that is not a
 * whole number are dropped (D-123), and `nextId` is raised past the highest arc-/seed-/hidden-N id.
 * Never throws.
 */
export function checkState(value: unknown): DirectorState | null {
  try {
    if (!isObj(value) || utf8.encode(JSON.stringify(value)).byteLength > CHECK_LIMITS.jsonBytes) return null;
    return readState(value);
  } catch {
    return null;
  }
}

// ---- lenient parts of a record ------------------------------------------------------------------

const FAIL_CODES: Readonly<Record<DirectorFailCode, true>> = {
  no_connection: true,
  transport_unsupported: true,
  provider_error: true,
  no_output: true,
  undecodable: true,
  missing_directive: true,
  timeout: true,
  aborted: true,
  no_room: true,
};
const TRANSPORTS = ['structured', 'tagged'] as const;
const PROFILES = ['full', 'lite'] as const;

/** A string, cut to the record bound; undefined for anything else. */
const lenText = (v: unknown): string | undefined => (isStr(v) ? clipText(v, BOUND.text) : undefined);
/** The strings of a list (others dropped), at most `max`; undefined when not a list. */
const lenTexts = (v: unknown, max: number = BOUND.list): string[] | undefined =>
  Array.isArray(v) ? v.filter(isStr).slice(0, max).map((x) => clipText(x, BOUND.text)) : undefined;
/** The elements of a list `read` accepts (undefined = dropped), at most `max`; undefined when not a list. */
function items<T>(v: unknown, read: (x: Obj) => T | undefined, max: number = BOUND.list): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    if (out.length >= max) break;
    const y = isObj(x) ? read(x) : undefined;
    if (y !== undefined) out.push(y);
  }
  return out;
}
/** An object of string lists; undefined when none is left. */
function lists<K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, string[]>> | undefined {
  if (!isObj(v)) return undefined;
  const out: Partial<Record<K, string[]>> = {};
  for (const k of keys) {
    const l = lenTexts(v[k]);
    if (l !== undefined) out[k] = l;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A stored NarratorDirective, read leniently (it is only re-rendered or audited): an invalid field
 * or list element is dropped, an invalid or missing pacing reads 'medium', an arc direction's
 * invalid urgency 'moderate' (D-107), strings over 4x the text limit are cut. Null for a non-object.
 */
export function checkDirective(v: unknown): NarratorDirective | null {
  return cleanDirective(v) ?? null;
}

function cleanDirective(v: unknown): NarratorDirective | undefined {
  if (!isObj(v)) return undefined;
  const scene = isObj(v.sceneGuidance)
    ? compact({
        setting: lenText(v.sceneGuidance.setting),
        atmosphere: lenText(v.sceneGuidance.atmosphere),
        tension_level:
          typeof v.sceneGuidance.tension_level === 'number' && v.sceneGuidance.tension_level >= 0 && v.sceneGuidance.tension_level <= 10
            ? v.sceneGuidance.tension_level
            : undefined,
      })
    : undefined;
  return compact({
    mood: lenText(v.mood),
    pacing: isIn(PACINGS, v.pacing) ? v.pacing : 'medium',
    include: lists(v.include, ['characters', 'themes', 'sensoryDetails', 'foreshadowing'] as const),
    avoid: lists(v.avoid, ['topics', 'characters', 'revelations'] as const),
    dialogueGuidance: items(v.dialogueGuidance, (x) => {
      const character = lenText(x.character);
      const tone = lenText(x.tone);
      return character !== undefined && tone !== undefined ? compact({ character, tone, hints: lenTexts(x.hints) }) : undefined;
    }),
    sceneGuidance: scene && Object.keys(scene).length > 0 ? scene : undefined,
    endingHook: lenText(v.endingHook),
    arcDirections: items(v.arcDirections, (x) => {
      const arcName = lenText(x.arcName);
      const instruction = lenText(x.instruction);
      if (arcName === undefined || instruction === undefined) return undefined;
      return { arcName, instruction, urgency: isIn(URGENCIES, x.urgency) ? x.urgency : 'moderate' };
    }),
    callbacks: items(v.callbacks, (x) => {
      const reference = lenText(x.reference);
      const instruction = lenText(x.instruction);
      return reference !== undefined && instruction !== undefined ? { reference, instruction } : undefined;
    }),
    characterBeats: items(v.characterBeats, (x) => {
      const character = lenText(x.character);
      const beat = lenText(x.beat);
      return character !== undefined && beat !== undefined ? compact({ character, beat, motivation: lenText(x.motivation) }) : undefined;
    }),
    narrativeGoal: lenText(v.narrativeGoal),
  });
}

function cleanAnalysis(v: unknown): PlanningAnalysis | undefined {
  if (!isObj(v)) return undefined;
  return compact({
    whatHappened: lenText(v.whatHappened),
    summary: lenText(v.summary),
    seedsPlanted: lenTexts(v.seedsPlanted),
    seedsPaidOff: lenTexts(v.seedsPaidOff),
    unexpected: lenTexts(v.unexpected),
    pacingAnalysis: lenText(v.pacingAnalysis),
    playerEnergy: lenText(v.playerEnergy),
    intentions: items(v.intentions, (x) => {
      try {
        return readIntention(x);
      } catch {
        return undefined;
      }
    }),
    suggestedActions: lenTexts(v.suggestedActions),
  });
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const readAttempt = (x: Obj): DirectorAttempt | undefined => {
  const ms = finite(x.ms);
  if (!isIn(TRANSPORTS, x.transport) || !isStr(x.outcome) || ms === undefined) return undefined;
  return compact({
    transport: x.transport,
    outcome: clipText(x.outcome, 80),
    ms,
    status: isWhole(x.status) ? x.status : undefined,
    finish: isStr(x.finish) ? clipText(x.finish, 80) : undefined,
    tokens: isWhole(x.tokens) ? x.tokens : undefined,
  });
};

/**
 * A DirectorRecord read from disk (a `dir`), or null when it cannot give the fold a state: not an
 * object, `reducer` other than REDUCER_VERSION, `ok` not a boolean, `turn` not whole, or a state
 * checkState refuses. The rest is lenient: a malformed directive or analysis is dropped from the
 * returned record, as are an unknown code / transport / profile, invalid skipped and attempt
 * entries (the lists bounded), a non-string model or reusedFrom; never a reason to refuse it.
 */
export function checkRecord(value: unknown): DirectorRecord | null {
  if (!isObj(value) || value.reducer !== REDUCER_VERSION || typeof value.ok !== 'boolean' || !isWhole(value.turn)) return null;
  const state = checkState(value.state);
  if (state === null) return null;
  const code = typeof value.code === 'string' && Object.hasOwn(FAIL_CODES, value.code) ? (value.code as DirectorFailCode) : undefined;
  const reusedFrom = typeof value.reusedFrom === 'string' && value.reusedFrom.length >= 1 && value.reusedFrom.length <= 80 ? value.reusedFrom : undefined;
  return compact<DirectorRecord>({
    turn: value.turn,
    ok: value.ok,
    code,
    transport: isIn(TRANSPORTS, value.transport) ? value.transport : undefined,
    profile: isIn(PROFILES, value.profile) ? value.profile : undefined,
    model: isStr(value.model) ? clipText(value.model, BOUND.text) : undefined,
    directive: cleanDirective(value.directive),
    analysis: cleanAnalysis(value.analysis),
    skipped:
      items(
        value.skipped,
        (x) => (isStr(x.path) && isStr(x.why) ? { path: clipText(x.path, BOUND.text), why: clipText(x.why, BOUND.text) } : undefined),
        BOUND.skipped,
      ) ?? [],
    attempts: items(value.attempts, readAttempt, BOUND.attempts) ?? [],
    state,
    reducer: REDUCER_VERSION,
    reusedFrom,
    fromReasoning: value.fromReasoning === true ? true : undefined,
  });
}

// ---- the fold -----------------------------------------------------------------------------------

/**
 * The Director's state at `fromId` (D-103, §5.9): walk the parent links from `fromId` (inclusive) to
 * the root and take the first ASSISTANT message whose `dir` passes checkRecord. Hidden replies count
 * (hiding removes text, not the plan's history); edit rows are not read (a continue writes no dir,
 * D-104); a user message's `dir` is ignored. `invalid` counts the assistant `dir`s refused on the way
 * (a newer reducer included), for the engine's notice. No such reply, a null or unknown `fromId` →
 * emptyState(). O(depth); every call returns fresh objects.
 */
export function directorAt(
  tree: TreeIndex,
  fromId: string | null,
): { state: DirectorState; from?: string; record?: DirectorRecord; invalid: number } {
  let invalid = 0;
  let cur = fromId;
  // buildTree guarantees no cycles; the step bound only guards a hand-made index.
  for (let steps = 0; cur !== null && steps <= tree.msgs.size; steps++) {
    const m = tree.msgs.get(cur);
    if (m === undefined) break;
    if (m.role === 'assistant' && m.dir !== undefined) {
      const record = checkRecord(m.dir);
      if (record !== null) return { state: record.state, from: cur, record, invalid };
      invalid++;
    }
    cur = m.parent;
  }
  return { state: emptyState(), invalid };
}
