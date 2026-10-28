// Ported from RoleCall:apps/rc/src/lib/ai/dm-stream/DMContextStore.ts, seed-aging.ts, chapter-identity.ts,
// DMStreamService.ts and app/scene/[characterId]/[chatId]/page.tsx@fb8dc623e (Coneja-Chibi:
// resolveCurrentChapterId, the chapter-identity keeper, the new-item defaults, the corrupted hidden-arc
// filter, the dmEnabled rule; NemoVonNirgend: the lastProgressTurn anchor of migrateContext; Levi:
// backfillSeedPlantedAtTurn, recoverArcTitleFromId).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The RoleCall story import's Director part (D-190, .notes/rcimport-decisions.md): a chat's
// `dm-context.json` (RoleCall's DMContext, `user_chats.dm_context`) → the D-61 DirectorState, and the
// `dir` records the import stores on the head reply and on the reply before it. Pure.
//
//   rows read leniently (bare strings and strings spread into {"0": …} objects skipped, intentions
//   excepted) → defaults for unknown enum values → chapters by number, the rest renumbered arc-N /
//   seed-N / hidden-N, references remapped → turn stamps derived where missing and held to the
//   import turn → D-61 live caps → fitState (32 KB) → compact ids → checkState
//
// RoleCall's turn stamps are not all absolute: a visible arc's `stages[].turn` is the arc's update
// count when the stage was added (DMStreamService), and its `turnsActive` counts updates, not turns;
// hidden-arc stages and clues, seed, beat, chapter and lastProgressTurn stamps are turns. A turn with
// no stamp is the newest one the other stamps allow (an age is never overstated, seed-aging.ts).
//
// Port notes. Kept: resolveCurrentChapterId (the pointer if it names a chapter, else the last one not
// complete, else the last); repairChapterIdentities' keeper of a shared chapter id (the last one not
// complete, else the last), which every reference to that id resolves to; migrateContext's anchor (a
// live arc with no lastProgressTurn progressed at the current turn); backfillSeedPlantedAtTurn (a
// plant turn of 0 or none: the earliest reinforcement turn, else the current turn); recoverArcTitleFromId
// for an arc with no title; RoleCall's defaults for a new arc (seeding, background, side, medium), seed
// (player, medium, payoff '') and hidden arc (background, medium, world, seeding, description = title);
// a hidden arc whose title is not a string is corrupted (the filter of processInvisibleArcUpdates);
// the dmEnabled rule (dmMode decides when set, else dmEnabled). Changed: the current turn is the
// import's (user messages up to the head reply, D-190), not deriveCurrentTurn; the RoleCall ids
// become the core's (chapter-<number>, one counter for the rest); `seed_<turn>_<n>` ids and the
// payoff turn also bound a missing plant turn; RoleCall's load-time dedup of arcs and shadow-world
// stages is not run (fitState caps the lists). Added: the legacy hidden-arc shape (`arcTitle`, a
// visible-arc status) read, the createdAtTurn derivations, the clamp to the import turn, the D-61
// live caps, the warnings, and the records.

import type { ImportWarning } from '../../formats/native.ts';
import { matchArc } from './reduce.ts';
import {
  CHECK_LIMITS,
  checkDirective,
  checkRecord,
  checkState,
  clipText,
  emptyState,
  FIT_OVER_CAP,
  fitState,
  isFinishedArc,
  isFinishedHidden,
  isPaidSeed,
} from './state.ts';
import {
  ARC_PRIORITIES,
  ARC_STATUSES,
  ARC_TYPES,
  CHAPTER_STATUSES,
  DIRECTOR_PERSONALITIES,
  HIDDEN_ARC_TYPES,
  HIDDEN_STATUSES,
  HORIZONS,
  INTENTION_PRIORITIES,
  INTENTION_TARGETS,
  NEXT_BEAT_STATUSES,
  REDUCER_VERSION,
  SCOPES,
  STATE_LIMITS,
  type ArcStatus,
  type ChapterStatus,
  type DirectorArc,
  type DirectorChapter,
  type DirectorIntention,
  type DirectorInvisibleArc,
  type DirectorNextBeat,
  type DirectorPacing,
  type DirectorRecord,
  type DirectorSeed,
  type DirectorStage,
  type DirectorState,
  type HiddenStatus,
  type NarratorDirective,
  type PersonalityId,
  type PlanningAnalysis,
  type Skip,
} from './types.ts';

// ---- API ----------------------------------------------------------------------------------------

export interface DmContextOptions {
  /** The Director turn of the head reply: the user messages on the path up to it (D-190). */
  turn: number;
  /**
   * The turn an ISO time falls in (the user messages sent up to it). Optional: when given, an item's
   * `createdAt` dates a chapter, arc or hidden arc with no createdAtTurn, and a visible arc stage's
   * `timestamp` dates the stage; without it the turn stamps of the context bound them.
   */
  turnAt?: (iso: string) => number | undefined;
}

export interface DmContextImport {
  /** null: the dm-context is not an object (rc_director_unreadable); no record is stored. */
  state: DirectorState | null;
  /** RoleCall's analysis of the head turn (its recentAnalysis entry of `turn`), for the head record. */
  analysis?: PlanningAnalysis;
  warnings: ImportWarning[];
}

export interface RecordOptions {
  /** The head record's analysis (DmContextImport.analysis). */
  analysis?: PlanningAnalysis;
  /** Both records' `model`, e.g. directorSettingsFor's 'rolecall:<model>'. */
  model?: string;
  /** The before record's turn (the user messages up to that reply); default `turn − 1`. */
  beforeTurn?: number;
}

export interface ImportedRecords {
  /** For the head reply: `turn`, and the directive RoleCall wrote for that turn when it did. */
  head: DirectorRecord;
  /**
   * For the reply before it (the assistant message a replan of the head reply starts from): the same
   * state one turn earlier, without a later lastDirective; absent when `turn` is 0.
   */
  before?: DirectorRecord;
}

export interface RcDirectorSettings {
  /** A SessionConfig.director patch: enabled as RoleCall had it, the style when it is one of the core's. */
  director: { enabled: boolean; style?: PersonalityId };
  /** 'rolecall:<dmModelId>' for the records' `model`; absent without a DM model. */
  model?: string;
  warnings: ImportWarning[];
}

// ---- reading helpers ----------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** `o` without its undefined keys. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** A string within checkState's bound; undefined for anything else. */
const textOf = (v: unknown): string | undefined => (typeof v === 'string' ? clipText(v, CHECK_LIMITS.string) : undefined);
/** A label: whitespace collapsed, trimmed, within the bound; '' when there is none. */
const labelOf = (v: unknown): string => (typeof v === 'string' ? clipText(v.replace(/\s+/g, ' ').trim(), CHECK_LIMITS.string) : '');

/** A string RoleCall spread into an object ({"0": "a", "1": "b"}: one character per index), joined back. */
function unspread(v: Obj): string | null {
  const keys = Object.keys(v);
  if (keys.length === 0) return null;
  let out = '';
  for (let i = 0; i < keys.length; i++) {
    const c = v[keys[i]!];
    if (keys[i] !== String(i) || typeof c !== 'string' || c.length !== 1) return null;
    out += c;
  }
  return out;
}

/** One row of a RoleCall list: an object, text (bare or spread), or anything else. */
type Row = { obj: Obj } | { text: string; spread: boolean } | { other: true };
function rowOf(v: unknown): Row {
  if (typeof v === 'string') return { text: v, spread: false };
  if (!isObj(v)) return { other: true };
  const s = unspread(v);
  return s === null ? { obj: v } : { text: s, spread: true };
}
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The turn `n` of a `<prefix>_<n>_<m>` id (RoleCall's `seed_<turn>_<i>`, `iarc_<turn>_<i>`). */
function idTurn(id: unknown, prefix: string): number | undefined {
  if (typeof id !== 'string') return undefined;
  const m = new RegExp(`^${prefix}_(\\d{1,9})_\\d+$`).exec(id);
  return m ? Number(m[1]) : undefined;
}

/** RoleCall recoverArcTitleFromId, for an arc with no title only: a snake_case id of 2+ words, capitalised. */
function titleFromId(id: unknown): string {
  if (typeof id !== 'string' || !id.includes('_')) return '';
  const words = id
    .replace(/_+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length >= 2 ? clipText(words.join(' '), CHECK_LIMITS.string) : '';
}

/** A count (turnsActive, turnsElapsed…): a finite number >= 0, floored; undefined for anything else. */
const countOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

const minOf = (xs: readonly (number | undefined)[]): number | undefined => {
  let m: number | undefined;
  for (const x of xs) if (x !== undefined && (m === undefined || x < m)) m = x;
  return m;
};

// ---- the report ---------------------------------------------------------------------------------

/** Counts by path and reason, turned into one warning per path at the end. */
class Tally {
  private readonly by = new Map<string, Map<string, number>>();
  add(path: string, why: string, n = 1): void {
    if (n <= 0) return;
    let m = this.by.get(path);
    if (m === undefined) this.by.set(path, (m = new Map()));
    m.set(why, (m.get(why) ?? 0) + n);
  }
  total(path: string): number {
    let n = 0;
    for (const x of this.by.get(path)?.values() ?? []) n += x;
    return n;
  }
  paths(): string[] {
    return [...this.by.keys()];
  }
  /** `why (n), …` in the order first counted. */
  parts(path: string): string {
    return [...(this.by.get(path) ?? new Map<string, number>())].map(([why, n]) => `${why} (${n})`).join(', ');
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What a collection is called in a warning. */
const NOUNS: Readonly<Record<string, string>> = {
  chapters: 'chapters',
  activeArcs: 'arcs',
  'activeArcs[].stages': 'arc stages',
  'activeArcs[].nextBeat': 'next beats',
  epicSeeds: 'seeds',
  'epicSeeds[].reinforcements': 'reinforcements',
  invisibleArcs: 'hidden arcs',
  'invisibleArcs[].stages': 'hidden-arc stages',
  'invisibleArcs[].playerClues': 'player clues',
  nextIntentions: 'intentions',
};

interface Cx {
  turn: number;
  turnAt?: (iso: string) => number | undefined;
  /** Turn stamps after the import turn, held to it. */
  clamped: number;
  skipped: Tally;
  coerced: Tally;
  derived: Tally;
  refs: Tally;
  details: Tally;
  /** One-off warnings, in order. */
  notes: ImportWarning[];
}

/** A turn stamp: a finite number >= 0, floored, held to the import turn (counted). */
function turnOf(cx: Cx, v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  const t = Math.floor(v);
  if (t > cx.turn) {
    cx.clamped++;
    return cx.turn;
  }
  return t;
}

/** The turn of an ISO time by the caller's turnAt; undefined without it. */
function turnAtIso(cx: Cx, v: unknown): number | undefined {
  if (cx.turnAt === undefined || typeof v !== 'string' || v === '') return undefined;
  const t = cx.turnAt(v);
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.min(Math.floor(t), cx.turn) : undefined;
}

/** A row's object, or null with the reason it is not one counted under `path`. */
function objOf(cx: Cx, path: string, v: unknown): Obj | null {
  const r = rowOf(v);
  if ('obj' in r) return r.obj;
  cx.skipped.add(path, 'text' in r ? (r.spread ? 'a string spread into an object' : 'bare text') : 'not an object');
  return null;
}

/** An enum value, else `fallback` with the field counted as coerced. */
function enumOf<T extends string>(cx: Cx, path: string, field: string, list: readonly T[], v: unknown, fallback: T): T {
  if (isIn(list, v)) return v;
  cx.coerced.add(path, `${field} ${v === undefined ? 'missing' : 'unknown'} → ${fallback}`);
  return fallback;
}

const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

// ---- chapters -----------------------------------------------------------------------------------

interface BuiltChapters {
  chapters: DirectorChapter[];
  /** RoleCall chapter id → the core id of its keeper. */
  ids: Map<string, string>;
  current?: string;
}

const RC_CHAPTER_STATUSES = ['planned', ...CHAPTER_STATUSES] as const;
type RcChapterStatus = (typeof RC_CHAPTER_STATUSES)[number];

function readChapters(cx: Cx, raw: Obj): BuiltChapters {
  const path = 'dm-context.chapters';
  interface ChapterRow {
    o: Obj;
    rcId: string;
    status: RcChapterStatus;
    number?: number;
    created?: number;
  }
  const rows: ChapterRow[] = [];
  for (const v of rowsOf(raw.chapters)) {
    const o = objOf(cx, path, v);
    if (o === null) continue;
    const rcId = typeof o.id === 'string' ? o.id.trim() : '';
    rows.push({ o, rcId, status: enumOf(cx, path, 'status', RC_CHAPTER_STATUSES, o.status, 'active') });
  }

  // repairChapterIdentities: of the rows sharing an id, the last one not complete (else the last) keeps it.
  const keeper = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.rcId === '') return;
    const k = keeper.get(r.rcId);
    if (k === undefined || r.status !== 'complete' || rows[k]!.status === 'complete') keeper.set(r.rcId, i);
  });
  const shared = rows.filter((r, i) => r.rcId !== '' && keeper.get(r.rcId) !== i).length;
  if (shared > 0) cx.coerced.add(path, 'id shared with another chapter (references go to the open one)', shared);

  // resolveCurrentChapterId: the pointer if it names a chapter, else the last one not complete, else the last.
  const pointer = typeof raw.currentChapterId === 'string' ? keeper.get(raw.currentChapterId.trim()) : undefined;
  let currentIndex = pointer;
  if (currentIndex === undefined) {
    for (let i = rows.length - 1; i >= 0 && currentIndex === undefined; i--) if (rows[i]!.status !== 'complete') currentIndex = i;
    if (currentIndex === undefined && rows.length > 0) currentIndex = rows.length - 1;
  }

  // A planned chapter has not begun: the core has no such status. The current one is active.
  const kept: ChapterRow[] = [];
  rows.forEach((r, i) => {
    if (r.status !== 'planned') kept.push(r);
    else if (i === currentIndex) {
      r.status = 'active';
      cx.coerced.add(path, 'planned but current → active');
      kept.push(r);
    } else cx.skipped.add(path, 'planned, not begun');
  });

  // Numbers: a whole number >= 1 that no earlier chapter holds, else the next free one after the highest.
  const used = new Set<number>();
  for (const r of kept) if (isWhole(r.o.number) && r.o.number >= 1 && !used.has(r.o.number)) used.add((r.number = r.o.number));
  let next = Math.max(0, ...used) + 1;
  for (const r of kept) {
    if (r.number !== undefined) continue;
    r.number = next++;
    cx.coerced.add(path, 'number missing or taken → renumbered');
  }

  // createdAtTurn: its own, the time it was made, else the newest the neighbours allow (the first: 0).
  const byNumber = [...kept].sort((a, b) => a.number! - b.number!);
  for (const r of byNumber) r.created = turnOf(cx, r.o.createdAtTurn);
  for (let i = 0; i < byNumber.length; i++) {
    const r = byNumber[i]!;
    if (r.created !== undefined) continue;
    cx.derived.add('createdAtTurn', 'chapters');
    const at = turnAtIso(cx, r.o.createdAt);
    if (at !== undefined) {
      r.created = at;
      continue;
    }
    if (i === 0) {
      r.created = 0;
      continue;
    }
    let low = 0;
    for (let j = 0; j < i; j++) low = Math.max(low, byNumber[j]!.created ?? 0);
    const later = byNumber.slice(i + 1).find((x) => x.created !== undefined)?.created;
    const elapsed = countOf(r.o.turnsElapsed);
    r.created = Math.max(low, minOf([later, elapsed === undefined ? undefined : Math.max(0, cx.turn - elapsed), cx.turn])!);
  }

  const ids = new Map<string, string>();
  const chapters: DirectorChapter[] = [];
  let current: string | undefined;
  for (const r of kept) {
    const o = r.o;
    const id = `chapter-${r.number!}`;
    if (nonEmptyList(o.arcIds)) cx.details.add('chapters', 'arc lists');
    if (typeof o.emotionalJourney === 'string' && o.emotionalJourney !== '') cx.details.add('chapters', 'emotional journeys');
    if (typeof o.openingMoment === 'string' && o.openingMoment !== '') cx.details.add('chapters', 'opening moments');
    chapters.push(
      compact({
        id,
        number: r.number!,
        title: labelOf(o.title) || `Chapter ${r.number!}`,
        premise: textOf(o.premise) ?? '',
        status: r.status as ChapterStatus,
        themes: rowsOf(o.themes).flatMap((t) => (typeof t === 'string' && t.trim() !== '' ? [clipText(t, CHECK_LIMITS.string)] : [])),
        tone: textOf(o.tone) ?? '',
        majorGoal: textOf(o.majorGoal) ?? '',
        closingMoment: textOf(o.closingMoment),
        createdAtTurn: r.created!,
      }),
    );
    const i = rows.indexOf(r);
    if (r.rcId !== '' && keeper.get(r.rcId) === i) ids.set(r.rcId, id);
    if (i === currentIndex) current = id;
  }
  return { chapters, ids, ...(current !== undefined ? { current } : {}) };
}

// ---- arcs ---------------------------------------------------------------------------------------

/** An arc while it is built: the RoleCall id and title for references. */
interface ArcRow {
  arc: DirectorArc;
  rcId: string;
  rcTitle: string;
}

function readArcs(cx: Cx, raw: Obj, chapters: BuiltChapters): ArcRow[] {
  const path = 'dm-context.activeArcs';
  const out: ArcRow[] = [];
  const created = new Map(chapters.chapters.map((c) => [c.id, c.createdAtTurn]));
  for (const v of rowsOf(raw.activeArcs)) {
    const o = objOf(cx, path, v);
    if (o === null) continue;
    let title = labelOf(o.title);
    if (title === '') {
      title = titleFromId(o.id);
      if (title === '') {
        cx.skipped.add(path, 'no title');
        continue;
      }
      cx.coerced.add(path, 'no title → read from the id');
    }
    const status = enumOf<ArcStatus>(cx, path, 'status', ARC_STATUSES, o.status, 'seeding');
    let chapterId: string | undefined;
    if (typeof o.chapterId === 'string' && o.chapterId.trim() !== '') {
      chapterId = chapters.ids.get(o.chapterId.trim());
      if (chapterId === undefined) cx.refs.add("an arc's chapterId", 'names no chapter: dropped');
    }

    const lastRaw = turnOf(cx, o.lastProgressTurn);
    const beatRaw = isObj(o.nextBeat) ? o.nextBeat : undefined;
    const plannedRaw = beatRaw ? turnOf(cx, beatRaw.plannedAtTurn) : undefined;
    const deliveredRaw = beatRaw ? turnOf(cx, beatRaw.deliveredAtTurn) : undefined;

    // createdAtTurn: RoleCall arcs have none. Its own, the time it was made, else the newest turn its
    // stamps allow (turnsActive counts updates, so turn − turnsActive is an upper bound), not before
    // its chapter began.
    let createdAtTurn = turnOf(cx, o.createdAtTurn);
    if (createdAtTurn === undefined) {
      cx.derived.add('createdAtTurn', 'arcs');
      createdAtTurn = turnAtIso(cx, o.createdAt);
      if (createdAtTurn === undefined) {
        const active = countOf(o.turnsActive);
        const high = minOf([active === undefined ? undefined : Math.max(0, cx.turn - active), lastRaw, plannedRaw, deliveredRaw, cx.turn])!;
        createdAtTurn = Math.max(chapterId !== undefined ? (created.get(chapterId) ?? 0) : 0, high);
      }
    }

    // A visible arc's stage turn is its update count then (DMStreamService): from the arc's start.
    const stages: DirectorStage[] = [];
    for (const sv of rowsOf(o.stages)) {
      const s = isObj(sv) ? sv : null;
      const st = s ? labelOf(s.title) : '';
      if (s === null || st === '') {
        cx.skipped.add(`${path}[].stages`, s === null ? 'not an object' : 'no title');
        continue;
      }
      if (typeof s.description === 'string' && s.description !== '') cx.details.add('arcs', 'stage descriptions');
      const rel = countOf(s.turn) ?? 0;
      stages.push({ title: st, turn: turnAtIso(cx, s.timestamp) ?? Math.min(cx.turn, createdAtTurn + rel) });
    }

    let nextBeat: DirectorNextBeat | undefined;
    if (beatRaw !== undefined) {
      const description = labelOf(beatRaw.description) === '' ? undefined : textOf(beatRaw.description);
      if (description === undefined) cx.skipped.add(`${path}[].nextBeat`, 'no description');
      else
        nextBeat = compact({
          description,
          plannedAtTurn: plannedRaw ?? createdAtTurn,
          // Lenient as checkState [D-123]: a rough future target, kept when whole.
          targetTurn: isWhole(beatRaw.targetTurn) ? beatRaw.targetTurn : undefined,
          status: enumOf(cx, `${path}[].nextBeat`, 'status', NEXT_BEAT_STATUSES, beatRaw.status, 'pending'),
          deliveredAtTurn: deliveredRaw,
        });
    }

    // migrateContext: a live arc with no progress turn progressed now (its staleness starts at the import).
    let lastProgressTurn = lastRaw;
    if (lastProgressTurn === undefined && status !== 'complete' && status !== 'abandoned') {
      lastProgressTurn = cx.turn;
      cx.derived.add('lastProgressTurn', 'live arcs');
    }

    if (nonEmptyList(o.plannedBeats)) cx.details.add('arcs', 'planned beats');
    if (nonEmptyList(o.involvedCharacters)) cx.details.add('arcs', 'involved characters');
    if (nonEmptyList(o.plantedSeeds)) cx.details.add('arcs', 'planted-seed lists');

    out.push({
      arc: compact({
        id: '',
        title,
        description: textOf(o.description) ?? '',
        chapterId,
        status,
        priority: enumOf(cx, path, 'priority', ARC_PRIORITIES, o.priority, 'background'),
        arcType: enumOf(cx, path, 'arcType', ARC_TYPES, o.arcType, 'side'),
        horizon: enumOf(cx, path, 'horizon', HORIZONS, o.horizon, 'medium'),
        lastProgressTurn,
        stages,
        nextBeat,
        createdAtTurn,
      }),
      rcId: typeof o.id === 'string' ? o.id : '',
      rcTitle: title,
    });
  }
  return out;
}

// ---- seeds --------------------------------------------------------------------------------------

/** A seed while it is built: its RoleCall relatedArcId, resolved after the arcs have ids. */
interface SeedRow {
  seed: DirectorSeed;
  related?: string;
}

function readSeeds(cx: Cx, raw: Obj): SeedRow[] {
  const path = 'dm-context.epicSeeds';
  const out: SeedRow[] = [];
  for (const v of rowsOf(raw.epicSeeds)) {
    const o = objOf(cx, path, v);
    if (o === null) continue;
    const hint = labelOf(o.hint);
    if (hint === '') {
      cx.skipped.add(path, 'no hint');
      continue;
    }
    const reinforcements: { turn: number }[] = [];
    for (const r of rowsOf(o.reinforcements)) {
      const t = isObj(r) ? turnOf(cx, r.turn) : undefined;
      if (t === undefined) {
        cx.skipped.add(`${path}[].reinforcements`, 'no turn');
        continue;
      }
      if (isObj(r) && typeof r.description === 'string' && r.description !== '') cx.details.add('seeds', 'reinforcement descriptions');
      reinforcements.push({ turn: t });
    }
    const payoffTurn = turnOf(cx, o.payoffTurn);

    // backfillSeedPlantedAtTurn: a plant turn of 0 or none was RoleCall's bug. Its id's turn, else
    // the earliest reinforcement (or the payoff), else the import turn: an age is never overstated.
    let plantedAtTurn = turnOf(cx, o.plantedAtTurn);
    if (plantedAtTurn === undefined || plantedAtTurn === 0) {
      cx.derived.add('plantedAtTurn', 'seeds');
      const fromId = idTurn(o.id, 'seed');
      plantedAtTurn =
        fromId !== undefined && fromId > 0
          ? Math.min(fromId, cx.turn)
          : (minOf([...reinforcements.map((r) => r.turn), payoffTurn].map((t) => (t !== undefined && t > 0 ? t : undefined))) ?? cx.turn);
    }

    out.push({
      seed: compact({
        id: '',
        hint,
        payoff: textOf(o.payoff) ?? '',
        scope: enumOf(cx, path, 'scope', SCOPES, o.scope, 'player'),
        plantedAtTurn,
        payoffHorizon: enumOf(cx, path, 'payoffHorizon', HORIZONS, o.payoffHorizon, 'medium'),
        payoffDelivered: o.payoffDelivered === true,
        payoffTurn,
        reinforcements,
      }),
      ...(typeof o.relatedArcId === 'string' && o.relatedArcId.trim() !== '' ? { related: o.relatedArcId.trim() } : {}),
    });
  }
  return out;
}

// ---- hidden arcs --------------------------------------------------------------------------------

/** A legacy row's visible-arc status, read as the hidden one it means. */
const HIDDEN_FROM_ARC: Readonly<Partial<Record<string, HiddenStatus>>> = {
  climax: 'approaching_player',
  resolution: 'approaching_player',
  complete: 'resolved',
  abandoned: 'resolved',
};

function readHidden(cx: Cx, raw: Obj): DirectorInvisibleArc[] {
  const path = 'dm-context.invisibleArcs';
  const out: DirectorInvisibleArc[] = [];
  for (const v of rowsOf(raw.invisibleArcs)) {
    const o = objOf(cx, path, v);
    if (o === null) continue;
    let title = labelOf(o.title);
    if (title === '') {
      title = labelOf(o.arcTitle);
      if (title === '') {
        cx.skipped.add(path, 'no title');
        continue;
      }
      cx.coerced.add(path, 'legacy shape: arcTitle read as the title');
    }
    let status: HiddenStatus;
    if (isIn(HIDDEN_STATUSES, o.status)) status = o.status;
    else if (typeof o.status === 'string' && Object.hasOwn(HIDDEN_FROM_ARC, o.status)) {
      status = HIDDEN_FROM_ARC[o.status]!;
      cx.coerced.add(path, `status ${o.status} → ${status}`);
    } else status = enumOf(cx, path, 'status', HIDDEN_STATUSES, o.status, 'seeding');

    const rawStages: { title: string; turn?: number }[] = [];
    for (const sv of rowsOf(o.stages)) {
      const s = isObj(sv) ? sv : null;
      const st = s ? labelOf(s.title) : '';
      if (s === null || st === '') {
        cx.skipped.add(`${path}[].stages`, s === null ? 'not an object' : 'no title');
        continue;
      }
      if (typeof s.description === 'string' && s.description !== '') cx.details.add('hidden arcs', 'stage descriptions');
      rawStages.push({ title: st, turn: turnOf(cx, s.turn) });
    }
    const rawClues: { clue: string; turn?: number }[] = [];
    for (const c of rowsOf(o.playerClues)) {
      const x = isObj(c) ? c : null;
      const clue = x ? textOf(x.clue) : undefined;
      if (x === null || clue === undefined || clue.trim() === '') {
        cx.skipped.add(`${path}[].playerClues`, x === null ? 'not an object' : 'no clue');
        continue;
      }
      rawClues.push({ clue, turn: turnOf(cx, x.turn) });
    }

    // createdAtTurn: its own, the time it was made, else the earliest of its id's turn, turn −
    // turnsActive (it counts every turn while pending) and its stage and clue turns.
    let createdAtTurn = turnOf(cx, o.createdAtTurn);
    if (createdAtTurn === undefined) {
      cx.derived.add('createdAtTurn', 'hidden arcs');
      createdAtTurn = turnAtIso(cx, o.createdAt);
      if (createdAtTurn === undefined) {
        const fromId = idTurn(o.id, 'iarc');
        const active = countOf(o.turnsActive);
        createdAtTurn = minOf([
          fromId === undefined ? undefined : Math.min(fromId, cx.turn),
          active === undefined ? undefined : Math.max(0, cx.turn - active),
          ...rawStages.map((s) => s.turn),
          ...rawClues.map((c) => c.turn),
          cx.turn,
        ])!;
      }
    }

    if (nonEmptyList(o.plannedBeats)) cx.details.add('hidden arcs', 'planned beats');
    if (nonEmptyList(o.relatedVisibleArcs) || nonEmptyList(o.foreshadowingSeeds)) cx.details.add('hidden arcs', 'links to arcs and seeds');

    out.push(
      compact({
        id: '',
        title,
        description: labelOf(o.description) === '' ? title : textOf(o.description)!,
        arcType: enumOf(cx, path, 'arcType', HIDDEN_ARC_TYPES, o.arcType, 'background'),
        horizon: enumOf(cx, path, 'horizon', HORIZONS, o.horizon, 'medium'),
        scope: enumOf(cx, path, 'scope', SCOPES, o.scope, 'world'),
        status,
        stages: rawStages.map((s) => ({ title: s.title, turn: s.turn ?? createdAtTurn })),
        surfaceCondition: textOf(o.surfaceCondition),
        playerClues: rawClues.map((c) => ({ turn: c.turn ?? createdAtTurn, clue: c.clue })),
        createdAtTurn,
        userAuthored: o.userAuthored === true ? (true as const) : undefined,
      }),
    );
  }
  return out;
}

// ---- the rest -----------------------------------------------------------------------------------

/** plan.ts INTENTION_DEFAULTS (D-107). */
const INTENTION_DEFAULTS = { type: 'advance_arc', priority: 'should', targetTurn: 'next' } as const;

function readIntentions(cx: Cx, raw: Obj): DirectorIntention[] {
  const path = 'dm-context.nextIntentions';
  const out: DirectorIntention[] = [];
  for (const v of rowsOf(raw.nextIntentions)) {
    const r = rowOf(v);
    if ('text' in r) {
      if (r.text.trim() === '') continue;
      cx.coerced.add(path, r.spread ? 'a string spread into an object → its description' : 'bare text → its description');
      out.push({ ...INTENTION_DEFAULTS, description: clipText(r.text, CHECK_LIMITS.string) });
      continue;
    }
    if (!('obj' in r) || labelOf(r.obj.description) === '') {
      cx.skipped.add(path, 'obj' in r ? 'no description' : 'not an object');
      continue;
    }
    const o = r.obj;
    out.push({
      type: labelOf(o.type) || INTENTION_DEFAULTS.type,
      description: textOf(o.description)!,
      priority: enumOf(cx, path, 'priority', INTENTION_PRIORITIES, o.priority, INTENTION_DEFAULTS.priority),
      targetTurn: enumOf(cx, path, 'targetTurn', INTENTION_TARGETS, o.targetTurn, INTENTION_DEFAULTS.targetTurn),
    });
  }
  return out;
}

function readPacing(cx: Cx, raw: Obj): DirectorPacing {
  const base = emptyState().pacing;
  if (!isObj(raw.pacing)) return base;
  const p = raw.pacing;
  const rhythm = isObj(p.rhythm) ? p.rhythm : {};
  return {
    currentMood: labelOf(p.currentMood) || base.currentMood,
    turnsAtCurrentMood: countOf(p.turnsAtCurrentMood) ?? 0,
    rhythm: {
      lastActionSequence: turnOf(cx, rhythm.lastActionSequence) ?? 0,
      lastQuietMoment: turnOf(cx, rhythm.lastQuietMoment) ?? 0,
    },
  };
}

/** RoleCall's analysis of turn `turn` (the last recentAnalysis entry for it) as the record's analysis. */
function analysisOf(raw: Obj, turn: number): PlanningAnalysis | undefined {
  const list = rowsOf(raw.recentAnalysis).filter((e): e is Obj => isObj(e) && e.turn === turn);
  const e = list[list.length - 1];
  if (e === undefined) return undefined;
  const texts = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => clipText(x, STATE_LIMITS.text));
    return out.length > 0 ? out : undefined;
  };
  const a = compact<PlanningAnalysis>({
    whatHappened: typeof e.whatHappened === 'string' && e.whatHappened.trim() !== '' ? clipText(e.whatHappened, STATE_LIMITS.text) : undefined,
    seedsPlanted: texts(e.seedsPlanted),
    seedsPaidOff: texts(e.seedsPayedOff ?? e.seedsPaidOff),
    unexpected: texts(e.unexpectedDevelopments ?? e.unexpected),
  });
  return Object.keys(a).length > 0 ? a : undefined;
}

// ---- references, caps, ids ----------------------------------------------------------------------

/** The items of `list` beyond the newest `keep` by `key` (stable: equal keys drop in list order). */
function oldestBeyond<T>(list: readonly T[], keep: number, key: (x: T) => number): Set<T> {
  if (list.length <= keep) return new Set();
  return new Set([...list].sort((a, b) => key(a) - key(b)).slice(0, list.length - Math.max(0, keep)));
}

/** D-61's live caps (24 arcs, 32 seeds, 12 hidden arcs), the oldest out first by fitState's keys. */
function capLive(s: DirectorState): DirectorState {
  const L = STATE_LIMITS;
  const arcs = oldestBeyond(
    s.arcs.filter((a) => !isFinishedArc(a) && a.byUser !== true),
    L.liveArcs,
    (a) => a.lastProgressTurn ?? a.createdAtTurn,
  );
  const seeds = oldestBeyond(
    s.seeds.filter((x) => !isPaidSeed(x) && x.byUser !== true),
    L.liveSeeds,
    (x) => x.plantedAtTurn,
  );
  const live = s.invisibleArcs.filter((h) => !isFinishedHidden(h));
  const people = live.filter((h) => h.userAuthored === true).length;
  const hidden = oldestBeyond(
    live.filter((h) => h.userAuthored !== true),
    L.liveHidden - people,
    (h) => h.createdAtTurn,
  );
  return {
    ...s,
    arcs: s.arcs.filter((a) => !arcs.has(a)),
    seeds: s.seeds.filter((x) => !seeds.has(x)),
    invisibleArcs: s.invisibleArcs.filter((h) => !hidden.has(h)),
  };
}

/**
 * The survivors renumbered arc-1… seed-… hidden-… in order (one counter); a seed's relatedArcId
 * follows its arc, or is dropped (counted) with an arc the limits left out.
 */
function compactIds(cx: Cx, s: DirectorState): DirectorState {
  let n = 1;
  const arcIds = new Map<string, string>();
  const arcs = s.arcs.map((a) => {
    const id = `arc-${n++}`;
    arcIds.set(a.id, id);
    return { ...a, id };
  });
  const seeds = s.seeds.map((x) => {
    const { relatedArcId, ...rest } = x;
    const related = relatedArcId === undefined ? undefined : arcIds.get(relatedArcId);
    if (relatedArcId !== undefined && related === undefined) cx.refs.add("a seed's relatedArcId", 'its arc left out by the limits: dropped');
    return { ...rest, id: `seed-${n++}`, ...(related !== undefined ? { relatedArcId: related } : {}) };
  });
  const invisibleArcs = s.invisibleArcs.map((h) => ({ ...h, id: `hidden-${n++}` }));
  return { ...s, nextId: n, arcs, seeds, invisibleArcs };
}

// ---- the warnings -------------------------------------------------------------------------------

const warn = (code: string, path: string, message: string): ImportWarning => ({ code, path, message });

/** RoleCall parts the D-61 state has no place for: [key, noun, why]. */
const DROPPED: readonly (readonly [string, string, string])[] = [
  ['hiddenEvents', 'hidden events', "the core's Director keeps no off-screen events"],
  ['npcOffScreenActions', 'off-screen NPC actions', "the core's Director keeps no NPC agendas"],
  ['parallelTimelines', 'parallel timelines', "the core's Director keeps no parallel timelines"],
  ['coreMemories', 'core memories', "the core's Director keeps no permanent memories (the Compendium holds the story's facts)"],
  ['notes', 'Director notes', "the core's Director notes are the player's own (its prompt reads them as notes from the player)"],
];

/** One warning per RoleCall part the state has no place for, with the malformed rows among them. */
function droppedWarnings(raw: Obj, analysisUsed: boolean): ImportWarning[] {
  const out: ImportWarning[] = [];
  for (const [key, noun, why] of DROPPED) {
    const rows = rowsOf(raw[key]);
    if (rows.length === 0) continue;
    let bare = 0;
    let spread = 0;
    for (const v of rows) {
      const r = rowOf(v);
      if ('text' in r) r.spread ? spread++ : bare++;
    }
    const shapes = [bare > 0 ? `${bare} bare text` : '', spread > 0 ? `${spread} a string spread into an object` : ''].filter((x) => x !== '');
    const tail = shapes.length > 0 ? ` (${shapes.join(', ')})` : '';
    out.push(warn('rc_director_dropped', `dm-context.${key}`, `${rows.length} ${noun} not imported${tail}: ${why} (D-61).`));
  }
  if (isObj(raw.characterSecrets)) {
    let n = 0;
    for (const v of Object.values(raw.characterSecrets)) n += Array.isArray(v) ? v.length : 1;
    const message = `${plural(n, 'character secret')} not imported: the core's Director keeps no secrets (D-61).`;
    if (n > 0) out.push(warn('rc_director_dropped', 'dm-context.characterSecrets', message));
  }
  if (isObj(raw.worldState)) {
    const n = Object.keys(raw.worldState).length;
    const message = `${plural(n, 'world-state key')} not imported: the core's Director keeps no world state (D-61).`;
    if (n > 0) out.push(warn('rc_director_dropped', 'dm-context.worldState', message));
  }
  const analyses = rowsOf(raw.recentAnalysis).length - (analysisUsed ? 1 : 0);
  if (analyses > 0) {
    const head = analysisUsed ? " (the head turn's is on the head reply)" : '';
    const message = `${plural(analyses, 'turn analysis', 'turn analyses')} not imported: a record holds its own turn's analysis only${head}.`;
    out.push(warn('rc_director_dropped', 'dm-context.recentAnalysis', message));
  }
  return out;
}

/** The import's warnings besides the dropped parts and the fit, one per collection and kind. */
function reportWarnings(cx: Cx, raw: Obj, totals: Readonly<Record<string, number>>): ImportWarning[] {
  const out: ImportWarning[] = [];
  const keyOf = (path: string): string => path.replace(/^dm-context\./, '');
  for (const path of cx.skipped.paths()) {
    const total = totals[keyOf(path)];
    const of = total !== undefined ? ` of ${total}` : '';
    out.push(warn('rc_director_skipped', path, `${cx.skipped.total(path)}${of} ${NOUNS[keyOf(path)] ?? keyOf(path)} skipped: ${cx.skipped.parts(path)}.`));
  }
  out.push(...cx.notes);
  for (const path of cx.coerced.paths())
    out.push(warn('rc_director_coerced', path, `${NOUNS[keyOf(path)] ?? keyOf(path)} read with RoleCall's defaults or fixed: ${cx.coerced.parts(path)}.`));
  const derived: string[] = [];
  const planted = cx.derived.total('plantedAtTurn');
  const progressed = cx.derived.total('lastProgressTurn');
  if (cx.derived.total('createdAtTurn') > 0) derived.push(`createdAtTurn derived for ${cx.derived.parts('createdAtTurn')}`);
  if (planted > 0)
    derived.push(`plantedAtTurn of 0 or none set for ${plural(planted, 'seed')} (RoleCall's repair: its id's turn, the earliest reinforcement, else the current turn)`);
  if (progressed > 0) derived.push(`lastProgressTurn set to turn ${cx.turn} for ${plural(progressed, 'live arc')} (as RoleCall does on load)`);
  if (derived.length > 0) out.push(warn('rc_director_derived', 'dm-context', `Turn stamps RoleCall did not keep: ${derived.join('; ')}.`));
  const refs = cx.refs.paths().map((k) => `${k}: ${cx.refs.parts(k)}`);
  if (refs.length > 0) out.push(warn('rc_director_refs', 'dm-context', `References to the new ids: ${refs.join('; ')}.`));
  const last = countOf(raw.lastDirectiveTurn);
  if (last !== undefined && last < cx.turn) {
    const message = `RoleCall's Director last planned turn ${last}, the story is at turn ${cx.turn}: the head reply was written without it and gets no directive.`;
    out.push(warn('rc_director_turn', 'dm-context.lastDirectiveTurn', message));
  }
  if (cx.clamped > 0) out.push(warn('rc_director_turn', 'dm-context', `${plural(cx.clamped, 'turn stamp')} later than turn ${cx.turn} (the head reply's) held to it.`));
  const details = cx.details.paths().map((k) => `${k}: ${cx.details.parts(k)}`);
  if (details.length > 0) out.push(warn('rc_director_details', 'dm-context', `Details the core's Director does not keep (D-61) left out: ${details.join('; ')}.`));
  return out;
}

// ---- dmContextToState ---------------------------------------------------------------------------

/**
 * A RoleCall chat's dm-context (`chats/<chat>/dm-context.json`) as the core's DirectorState at the
 * head reply's turn `opts.turn` (D-190). Lenient: rows that are not objects are skipped (a bare or
 * spread string becomes an intention's description, nowhere else), unknown enum values take
 * RoleCall's defaults for a new item, a missing title or hint skips the row; chapters keep their
 * numbers (chapter-<number>), arcs, seeds and hidden arcs are renumbered from one counter and the
 * references follow (a chapter id several chapters share names the open one, a seed's relatedArcId
 * is matched by id, then by title); every turn stamp is held to `opts.turn`; the D-61 live caps,
 * then fitState (32 KB), then the survivors' ids are made consecutive. Parts the state has no place
 * for (hidden events, NPC actions, timelines, core memories, notes, secrets, world state, older
 * analyses) are dropped with one warning each. The state comes back as checkState reads it; null
 * only for a dm-context that is not an object. Never throws; `raw` is not changed.
 */
export function dmContextToState(raw: unknown, opts: DmContextOptions): DmContextImport {
  const turn = typeof opts.turn === 'number' && Number.isFinite(opts.turn) && opts.turn > 0 ? Math.floor(opts.turn) : 0;
  if (!isObj(raw)) {
    return { state: null, warnings: [warn('rc_director_unreadable', 'dm-context', 'dm-context.json is not an object: the Director starts empty.')] };
  }
  const cx: Cx = {
    turn,
    ...(opts.turnAt !== undefined ? { turnAt: opts.turnAt } : {}),
    clamped: 0,
    skipped: new Tally(),
    coerced: new Tally(),
    derived: new Tally(),
    refs: new Tally(),
    details: new Tally(),
    notes: [],
  };

  const chapters = readChapters(cx, raw);
  const arcRows = readArcs(cx, raw, chapters);
  const seedRows = readSeeds(cx, raw);
  const hidden = readHidden(cx, raw);
  const intentions = readIntentions(cx, raw);
  const pacing = readPacing(cx, raw);

  // Ids: one counter, arcs first; a seed's relatedArcId by RoleCall id, then by title (matchArc).
  let n = 1;
  for (const r of arcRows) r.arc.id = `arc-${n++}`;
  const candidates = arcRows.map((r) => ({ id: r.rcId, title: r.rcTitle, core: r.arc.id }));
  for (const r of seedRows) {
    r.seed.id = `seed-${n++}`;
    if (r.related === undefined) continue;
    const exact = candidates.find((c) => c.id !== '' && c.id === r.related);
    const found = exact ?? matchArc(candidates, r.related)?.item;
    if (found !== undefined) {
      r.seed.relatedArcId = found.core;
      if (exact === undefined) cx.refs.add("a seed's relatedArcId", 'an arc title, matched');
    } else cx.refs.add("a seed's relatedArcId", 'names no arc: dropped');
  }
  for (const h of hidden) h.id = `hidden-${n++}`;

  // The last directive: RoleCall's authored one, at its turn (held to the import turn).
  let lastDirective: DirectorState['lastDirective'];
  if (isObj(raw.lastDirective)) {
    const directive = checkDirective(raw.lastDirective);
    const at = turnOf(cx, raw.lastDirectiveTurn);
    if (directive !== null && at !== undefined) lastDirective = { turn: at, directive };
    else
      cx.notes.push({
        code: 'rc_director_skipped',
        path: 'dm-context.lastDirective',
        message: "RoleCall's last directive has no lastDirectiveTurn: left out (the next turn skips the self-audit).",
      });
  }

  const seeds = seedRows.map((r) => r.seed);
  let lastPlantTurn: number | undefined;
  for (const x of seeds) if (lastPlantTurn === undefined || x.plantedAtTurn > lastPlantTurn) lastPlantTurn = x.plantedAtTurn;
  const built: DirectorState = compact({
    turn,
    nextId: n,
    chapters: chapters.chapters,
    currentChapterId: chapters.current,
    arcs: arcRows.map((r) => r.arc),
    seeds,
    invisibleArcs: hidden,
    notes: [],
    pacing,
    nextIntentions: intentions,
    lastDirective,
    lastPlantTurn,
  });

  // D-61: the live caps, then fitState; a person's hidden arcs keep their flag while the state fits.
  let fitted = fitState(capLive(built));
  const overCap = fitted.skipped.some((s) => s.why === FIT_OVER_CAP.why);
  if (overCap) fitted = fitState(capLive({ ...built, invisibleArcs: built.invisibleArcs.map(({ userAuthored: _, ...h }) => h) }));
  const state = checkState(compactIds(cx, fitted.state));

  const analysis = analysisOf(raw, turn);
  const totals: Record<string, number> = {};
  for (const k of ['chapters', 'activeArcs', 'epicSeeds', 'invisibleArcs', 'nextIntentions']) totals[k] = rowsOf(raw[k]).length;
  const warnings = [...reportWarnings(cx, raw, totals), ...droppedWarnings(raw, analysis !== undefined)];
  if (state === null) {
    warnings.push(warn('rc_director_unreadable', 'dm-context', 'The Director state built from dm-context.json does not pass checkState: the Director starts empty.'));
    return { state: null, warnings };
  }
  const kept = (what: string, from: number, to: number): string => (from === to ? '' : `${what} ${to} of ${from}`);
  const counts = [
    kept('arcs', built.arcs.length, state.arcs.length),
    kept('seeds', built.seeds.length, state.seeds.length),
    kept('hidden arcs', built.invisibleArcs.length, state.invisibleArcs.length),
    kept('chapters', built.chapters.length, state.chapters.length),
    built.lastDirective !== undefined && state.lastDirective === undefined ? 'the last directive left out' : '',
  ].filter((x) => x !== '');
  const steps = [...new Set(fitted.skipped.map((x) => x.why))];
  if (counts.length > 0 || overCap)
    warnings.push({
      code: 'rc_director_fit',
      path: 'dm-context',
      message:
        `Held to the core's Director limits (D-61: ${STATE_LIMITS.liveArcs} live arcs, ${STATE_LIMITS.liveSeeds} live seeds, ${STATE_LIMITS.liveHidden} live hidden arcs, ` +
        `${STATE_LIMITS.completedPerKind} finished of each, ${STATE_LIMITS.hardBytes / 1024} KB; the oldest go first): kept ${counts.join(', ') || 'everything'}` +
        `${overCap ? "; the player's hidden arcs did not fit as the player's and are kept as the Director's" : ''}` +
        `${steps.length > 0 ? ` (${steps.join(', ')})` : ''}.`,
    });
  return { state, ...(analysis !== undefined ? { analysis } : {}), warnings };
}

// ---- the records --------------------------------------------------------------------------------

const wholeTurn = (t: number): number => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? Math.floor(t) : 0);

/** One imported record at `turn`: the state at that turn, the directive written for it, ok. */
function recordAt(state: DirectorState, turn: number, opts: RecordOptions, analysis: PlanningAnalysis | undefined): DirectorRecord {
  const { lastDirective, ...rest } = state;
  const keep = lastDirective !== undefined && lastDirective.turn <= turn ? lastDirective : undefined;
  const fitted = fitState({ ...rest, ...(keep !== undefined ? { lastDirective: keep } : {}), turn });
  const directive: NarratorDirective | undefined = keep !== undefined && keep.turn === turn ? fitted.state.lastDirective?.directive : undefined;
  const skipped: Skip[] = fitted.skipped;
  const record = checkRecord(
    compact<DirectorRecord>({
      turn,
      ok: true,
      model: opts.model,
      directive,
      analysis,
      skipped,
      attempts: [],
      state: fitted.state,
      reducer: REDUCER_VERSION,
    }),
  );
  if (record === null) throw new Error('directorRecordsFor: the state is not a DirectorState checkState accepts');
  return record;
}

/**
 * The `dir` records the import stores (D-190), as checkRecord reads them back: `head` on the head
 * reply (turn `turn`, with the directive RoleCall wrote for that turn when its lastDirective is of
 * that turn, and `opts.analysis`), and `before` on the reply before it (turn `opts.beforeTurn ??
 * turn − 1`, the same state without a later lastDirective, no analysis), so a plain swipe of the head
 * reply reuses RoleCall's plan (D-104) and a replan plans turn `turn` again from RoleCall's state.
 * Both are ok, with no attempts. Throws only for a state checkState refuses (not dmContextToState's).
 */
export function directorRecordsFor(state: DirectorState, turn: number, opts: RecordOptions = {}): ImportedRecords {
  const t = wholeTurn(turn);
  const head = recordAt(state, t, opts, opts.analysis);
  if (t === 0) return { head };
  const bt = opts.beforeTurn === undefined ? t - 1 : Math.min(wholeTurn(opts.beforeTurn), t - 1);
  return { head, before: recordAt(state, bt, opts, undefined) };
}

// ---- the session's setting ----------------------------------------------------------------------

/**
 * The Director's setting from a RoleCall chat's `config` (chat.json): on when RoleCall ran it (the
 * chat page's rule: `dmMode` decides when set, 'full' is on; else `dmEnabled`), the style when
 * `dmPersonality` is one of the core's ids (the same id space), the records' model label. Never throws.
 */
export function directorSettingsFor(config: unknown): RcDirectorSettings {
  const c = isObj(config) ? config : {};
  const enabled = c.dmMode ? c.dmMode === 'full' : Boolean(c.dmEnabled);
  const warnings: ImportWarning[] = [];
  let style: PersonalityId | undefined;
  if (isIn(DIRECTOR_PERSONALITIES, c.dmPersonality)) style = c.dmPersonality;
  else if (typeof c.dmPersonality === 'string' && c.dmPersonality !== '')
    warnings.push(
      warn('rc_director_style', 'chat.config.dmPersonality', `RoleCall's Director personality "${clipText(c.dmPersonality, 80)}" is not one of the core's: the default style.`),
    );
  const model = typeof c.dmModelId === 'string' && c.dmModelId.trim() !== '' ? `rolecall:${clipText(c.dmModelId.trim(), 200)}` : undefined;
  return { director: { enabled, ...(style !== undefined ? { style } : {}) }, ...(model !== undefined ? { model } : {}), warnings };
}
