// Ported from Bunraku:src/core/director/apply.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi:
// applying a planning round to the Director's state) and RoleCall:apps/rc/src/lib/ai/dm-stream/
// find-arc-match.ts, arc-title-sanitizer.ts@fb8dc623e (Coneja-Chibi: the arc matching steps, the
// stutter rule, the title cap).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reducer (ARCHITECTURE.md §7.3 "Редьюсер", D-63; .notes/m4-decisions.md A.2, D-108, D-109, F):
// a pure function from the state a Director turn starts with and the plan read for it to the next
// state and the list of what it refused. fitState runs after it (the caller's job).
//
// Port notes. Kept from Bunraku: the order chapter → arcs → seeds → hidden arcs → intentions →
// pacing; one id counter (arc-N, seed-N, hidden-N), chapter-<number>; the first chapter forced;
// start_new refused while the ACTIVE current chapter is young (a concluding one may close at once);
// a start_new closes every active or concluding chapter; arcs are never renamed on update (RoleCall
// VVS-267: titles sent with an update are slug echoes more often than renames); progress only on a
// new stage, a status change or a delivered beat; arc, seed and hidden-arc defaults; seeds named by
// id never fall back to the hint; a re-plant updates the seed and keeps plantedAtTurn; hidden-arc
// clues and stages only on 'update'; a hidden arc's scope is set once; nextIntentions replaced.
// Changed: no `now`, activity, recentAnalysis, suggestedActions, turnsActive or turnsElapsed (ages
// are derived, D-61); delete removes (no soft delete); a stage's turn is the turn (Bunraku wrote the
// update count, and 0 for a new arc); matching is Unicode (D-108: Bunraku's [^a-z0-9] erased
// Cyrillic, so every Cyrillic title "matched" the first Cyrillic arc); stage, hint and clue
// comparisons fold (foldText); a new live item over the D-61 live cap, a start_new refusal, an
// unknown id and every other ignored request goes to `skipped` (Bunraku dropped them silently);
// per-item list caps (stages, reinforcements, clues) are fitState's, not applied here; a reinforce
// counts without its text (the text is not stored), once per turn; the rhythm reads mood kinds
// (D-109) instead of exact strings, and "the same mood" compares the mood's words.
// D-123: a selector that echoes the prompt's id ('[arc-1] The Lighthouse', 'arc-1: Маяк',
// '(hidden-2) "The Guild"') names that id when it exists, else its cleaned title (as RoleCall
// sanitizes before findArcMatch); new hidden-arc titles are cleaned like arc titles; a seed's
// relatedArcId is matched like an arc selector and stored as that arc's id (unknown → dropped and
// skipped); every text stored is within STATE_LIMITS.text, the joined chapter goal included.

import { foldText, STOP_WORDS, wordsOf } from '../../text/normalize.ts';
import { moodKinds } from './mood.ts';
import { clipText } from './state.ts';
import {
  CHAPTER_MIN_TURNS,
  STATE_LIMITS,
  type DirectorArc,
  type DirectorChapter,
  type DirectorInvisibleArc,
  type DirectorPacing,
  type DirectorSeed,
  type DirectorState,
  type PlanningAnalysis,
  type PlanningArcUpdate,
  type PlanningChapterUpdate,
  type PlanningInvisibleArcUpdate,
  type PlanningRound,
  type PlanningSeedUpdate,
  type Skip,
} from './types.ts';

export interface ApplyContext {
  /** The Director turn being planned (state.turn + 1 for the caller). */
  turn: number;
}

export interface Applied {
  state: DirectorState;
  skipped: Skip[];
}

/** The first chapter's title when the model gave none. */
export const FIRST_CHAPTER_TITLE = 'The Story Begins';

// ---- words and titles ([D-108]) ---------------------------------------------------------------------

/**
 * Function words the Director drops from titles and moods (folded: lower case, ё → е). RoleCall's 15
 * English stop words plus more English and Russian prepositions, conjunctions, particles, pronouns
 * and auxiliaries. Left out on purpose: words that are also names or common nouns (will, may, might,
 * том, тем, есть). Words of one or two letters never count in a title anyway (length > 2).
 */
const DIRECTOR_ONLY_STOP: readonly string[] = [
  // English: RoleCall find-arc-match.ts STOP_WORDS
  'the', 'a', 'an', 'of', 'and', 'in', 'to', 'for', 'is', 'on', 'at', 'by', 'with', 'as', 'from',
  // English: more prepositions, conjunctions, pronouns, auxiliaries
  'or', 'but', 'nor', 'not', 'no', 'so', 'yet', 'if', 'than', 'then', 'that', 'this', 'these', 'those',
  'into', 'onto', 'upon', 'over', 'under', 'about', 'after', 'before', 'between', 'against', 'through',
  'without', 'within', 'among', 'along', 'across', 'toward', 'towards', 'around', 'beyond', 'off', 'out',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs', 'we', 'us',
  'our', 'ours', 'you', 'your', 'yours', 'my', 'mine', 'me', 'who', 'whom', 'whose', 'which', 'what',
  'when', 'where', 'why', 'how', 'there', 'here', 'all', 'any', 'some', 'each', 'every',
  'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'shall',
  'should', 'would', 'could', 'must',
  // Russian: prepositions
  'с', 'со', 'к', 'ко', 'у', 'о', 'об', 'обо', 'от', 'ото', 'до', 'из', 'изо', 'за', 'под', 'подо', 'над',
  'надо', 'при', 'про', 'для', 'без', 'безо', 'через', 'перед', 'передо', 'после', 'между', 'около',
  'вокруг', 'среди', 'против', 'ради', 'сквозь', 'вдоль', 'кроме', 'возле', 'вместо', 'вне', 'внутри',
  // Russian: conjunctions and particles
  'а', 'но', 'да', 'или', 'либо', 'что', 'чтобы', 'когда', 'если', 'тоже', 'также', 'зато', 'однако',
  'хотя', 'пока', 'лишь', 'только', 'даже', 'уже', 'еще', 'вот', 'ведь', 'будто', 'словно', 'же', 'ли',
  'ни', 'не', 'нет', 'так', 'где', 'куда', 'откуда', 'почему', 'зачем', 'чем',
  // Russian: pronouns and their common forms
  'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'его', 'ему', 'ее', 'ей', 'им', 'их', 'ими', 'него',
  'нему', 'нее', 'ней', 'ним', 'них', 'нем', 'меня', 'мне', 'тебя', 'тебе', 'нас', 'нам', 'вас', 'вам',
  'себя', 'себе', 'собой', 'мой', 'моя', 'мое', 'мои', 'моего', 'моей', 'моих', 'твой', 'твоя', 'твое',
  'твои', 'свой', 'своя', 'свое', 'свои', 'своего', 'своей', 'своих', 'свою', 'своим', 'наш', 'наша',
  'наше', 'наши', 'нашего', 'нашей', 'наших', 'ваш', 'ваша', 'ваше', 'ваши', 'этот', 'эта', 'это',
  'эти', 'этого', 'этой', 'этих', 'тот', 'та', 'те', 'того', 'той', 'тех', 'кто', 'кого', 'кому',
  'весь', 'вся', 'все', 'всех', 'всего', 'всей', 'сам', 'сама', 'само', 'сами',
  // Russian: auxiliaries
  'был', 'была', 'было', 'были', 'быть', 'будет',
];

/** D-46 STOP_WORDS plus the Director's own function words [D-108]. Folded words. */
export const DIRECTOR_STOP: ReadonlySet<string> = new Set([...STOP_WORDS, ...DIRECTOR_ONLY_STOP]);

const POSSESSIVE_RE = /['’]s$/;

/** A function word, also with an English possessive ("it's" → it). */
function isStop(norm: string): boolean {
  return DIRECTOR_STOP.has(norm) || (POSSESSIVE_RE.test(norm) && DIRECTOR_STOP.has(norm.slice(0, -2)));
}

/** Folded and whitespace-collapsed: how stages, hints and clues compare. */
const fold = (text: string): string => foldText(text).replace(/\s+/g, ' ').trim();

/**
 * The match key of a title [D-108 step 2]: the stems of all its words, in order. Case, punctuation,
 * an English possessive or plural and a Russian case ending do not change it ("The Prince's Quest"
 * = "the princes quest."; «Тайна маяка» = «тайну маяка»). '' for a title with no word.
 */
export function matchKey(title: string): string {
  return wordsOf(title)
    .map((w) => w.stem)
    .join(' ');
}

/** A title's significant tokens [D-108 step 3]: distinct stems longer than two, function words left out. */
export function titleTokens(title: string): string[] {
  const out: string[] = [];
  for (const w of wordsOf(title)) {
    if (w.stem.length <= 2 || isStop(w.norm) || out.includes(w.stem)) continue;
    out.push(w.stem);
  }
  return out;
}

export interface ArcMatch<T> {
  item: T;
  /** Which step found it: the exact id, an equal match key, or shared tokens. */
  by: 'id' | 'key' | 'words';
  /** Shared tokens / the shorter title's tokens (by 'words' only). */
  ratio?: number;
}

/** The kinds of id the prompt shows in front of a title: `- [arc-N] Title`, `- [hidden-N] "Title"`. */
export type EchoKind = 'arc' | 'hidden';

/** One leading `kind-N` echo, with its brackets and a separator (as ARC_ECHO_HEAD_RE, one at a time). */
const ECHO_HEAD: Readonly<Record<EchoKind, RegExp>> = {
  arc: /^[[(]?\s*(arc-\d+)\b\s*[\])]?\s*[:.|\-–—]?\s*/i,
  hidden: /^[[(]?\s*(hidden-\d+)\b\s*[\])]?\s*[:.|\-–—]?\s*/i,
};
/** A trailing bracketed `(kind-N)` or `[kind-N]` (as ARC_ECHO_TAIL_RE). */
const ECHO_TAIL: Readonly<Record<EchoKind, RegExp>> = {
  arc: /\s*[[(]\s*(arc-\d+)\s*[\])]$/i,
  hidden: /\s*[[(]\s*(hidden-\d+)\s*[\])]$/i,
};

/**
 * The ids a selector echoes from the prompt's lines [D-123] ('[arc-1] The Lighthouse', 'arc-1: Маяк',
 * 'The Lighthouse (arc-1)', '(hidden-2) "The Guild"'), lower-cased, leading ones first, and the
 * selector without them (whitespace collapsed). No echo: `ids` is empty and `rest` the selector.
 */
export function idEchoes(selector: string, kind: EchoKind): { ids: string[]; rest: string } {
  let rest = selector.replace(/\s+/g, ' ').trim();
  const ids: string[] = [];
  for (let m = ECHO_HEAD[kind].exec(rest); m !== null && m[0] !== ''; m = ECHO_HEAD[kind].exec(rest)) {
    ids.push(m[1]!.toLowerCase());
    rest = rest.slice(m[0].length);
  }
  const tail = ECHO_TAIL[kind].exec(rest);
  if (tail !== null) {
    ids.push(tail[1]!.toLowerCase());
    rest = rest.slice(0, tail.index);
  }
  return { ids, rest: rest.trim() };
}

/**
 * The arc a selector (an id or a title) names [D-108, D-123; RoleCall findArcMatch]: (1) the exact id
 * (trimmed, any case); (2) an id the selector echoes from the prompt ('[arc-1] The Lighthouse',
 * 'arc-1: Маяк'), when that arc exists; (3) the first arc with an equal, non-empty match key, for the
 * selector as sent and then cleaned as a new arc's title would be (cleanTitle: echoes cut, the first
 * sentence), so a selector never misses an arc whose title its own new arc would repeat; (4) the arc
 * sharing the most significant tokens with either form: at least 2 shared, covering at least half of
 * the shorter title's tokens (the selector needs 2 tokens; on equal ratios the first arc wins).
 * Known false merge, kept by D-108: «Миру грозит война» meets «Мира и война» (мир, войн).
 */
export function matchArc<T extends { id: string; title: string }>(candidates: readonly T[], selector: string): ArcMatch<T> | undefined {
  const sel = selector.trim();
  if (sel === '') return undefined;
  const id = sel.toLowerCase();
  const byId = candidates.find((c) => c.id.toLowerCase() === id);
  if (byId !== undefined) return { item: byId, by: 'id' };
  for (const echoed of idEchoes(sel, 'arc').ids) {
    const byEcho = candidates.find((c) => c.id.toLowerCase() === echoed);
    if (byEcho !== undefined) return { item: byEcho, by: 'id' };
  }
  const forms = [...new Set([sel, cleanTitle(sel)])].filter((f) => f !== '');
  for (const form of forms) {
    const key = matchKey(form);
    if (key === '') continue;
    const byKey = candidates.find((c) => matchKey(c.title) === key);
    if (byKey !== undefined) return { item: byKey, by: 'key' };
  }
  for (const form of forms) {
    const byWords = matchWords(candidates, form);
    if (byWords !== undefined) return byWords;
  }
  return undefined;
}

/** D-108 step 3 for one form of the selector. */
function matchWords<T extends { id: string; title: string }>(candidates: readonly T[], selector: string): ArcMatch<T> | undefined {
  const incoming = titleTokens(selector);
  if (incoming.length < 2) return undefined;
  let best: ArcMatch<T> & { ratio: number } | undefined;
  for (const c of candidates) {
    const theirs = titleTokens(c.title);
    if (theirs.length === 0) continue;
    const shared = incoming.filter((t) => theirs.includes(t)).length;
    const ratio = shared / Math.min(incoming.length, theirs.length);
    if (shared >= 2 && ratio >= 0.5 && (best === undefined || ratio > best.ratio)) best = { item: c, by: 'words', ratio };
  }
  return best;
}

/** The arc of the state a selector names (matchArc over every arc, finished ones included, as Bunraku). */
export function findArc(state: DirectorState, key: string): DirectorArc | undefined {
  return matchArc(state.arcs, key)?.item;
}

/** One or more leading `arc-N` echoes of the prompt's `[arc-N] Title` lines, with their brackets and separators. */
const ARC_ECHO_HEAD_RE = /^(?:[[(]?\s*arc-\d+\b\s*[\])]?\s*[:.|\-–—]?\s*)+/i;
/** A trailing bracketed `(arc-N)` or `[arc-N]`. */
const ARC_ECHO_TAIL_RE = /\s*[[(]\s*arc-\d+\s*[\])]$/i;
/** Three or more equal leading words and something after them (RoleCall VVS-267). */
const STUTTER_RE = /^(\S+)(?:\s+\1){2,}\s+(.+)$/iu;
/** A sentence end or a "Title: subtitle" colon. */
const SENTENCE_RE = /(?<=[.!?])\s|:\s/;

/**
 * A label, not a description [D-108; Bunraku cleanTitle, RoleCall sanitizeArcTitle]: whitespace
 * collapsed; leading `arc-N` echoes and a trailing `(arc-N)` cut; a stutter of three or more equal
 * leading words healed ("Levi Levi Levi Strovolos" → "Levi Strovolos"; two stay: "Bora Bora"); the
 * first sentence or the part before ": "; at most STATE_LIMITS.arcTitle (80) UTF-16 units, cut at
 * the last space when it is past 60 %. No hex-slug rules (they cut "Dead", "Cafe", "Face"). '' when
 * nothing is left. Known limit, as in both sources: "Mr. Smith's Debt" → "Mr.". Idempotent.
 */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(ARC_ECHO_HEAD_RE, '').replace(ARC_ECHO_TAIL_RE, '').trim();
  const stutter = STUTTER_RE.exec(t);
  if (stutter !== null) t = `${stutter[1]} ${stutter[2]}`;
  const first = t.split(SENTENCE_RE)[0]?.trim();
  if (first) t = first;
  const max = STATE_LIMITS.arcTitle;
  if (t.length > max) {
    let cut = t.slice(0, max);
    // Never leave half of a surrogate pair.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    const space = cut.lastIndexOf(' ');
    t = (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
  }
  return t;
}

/** A whole title in the double quotes the prompt's `- [hidden-N] "Title"` line puts around it. */
const QUOTED_RE = /^(?:"([^"]*)"|«([^«»]*)»|“([^“”]*)”|„([^„“”]*)[“”])$/u;

/**
 * A new hidden arc's title [D-123]: leading `hidden-N` echoes and a trailing `(hidden-N)` cut, the
 * quotes of the prompt's line taken off, then cleanTitle (arc echoes, stutter, the first sentence,
 * 80 chars), repeated until nothing changes ('"[hidden-2] X"' → 'X'). '' when nothing is left.
 * Idempotent.
 */
export function cleanHiddenTitle(raw: string): string {
  let t = raw;
  // After the first pass (whitespace made single spaces) every pass that changes the text shortens it.
  for (let pass = 0; pass <= raw.length + 1; pass++) {
    const rest = idEchoes(t, 'hidden').rest;
    const quoted = QUOTED_RE.exec(rest);
    const next = cleanTitle(quoted === null ? rest : (quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4] ?? ''));
    if (next === t) break;
    t = next;
  }
  return t;
}

// ---- moods ([D-109]) --------------------------------------------------------------------------------

/** A mood's words for comparison: the sorted distinct stems without function words; the folded text when it has none. */
function moodWords(mood: string): string {
  const stems = [...new Set(wordsOf(mood).filter((w) => !isStop(w.norm)).map((w) => w.stem))].sort();
  return stems.length > 0 ? stems.join(' ') : fold(mood);
}

/**
 * Two moods are the same when they have the same words (stems, function words left out, order and
 * punctuation ignored): "tense, watchful" = "Watchful and tense", «напряжённо» = «напряжённый».
 */
export function sameMood(a: string, b: string): boolean {
  return moodWords(a) === moodWords(b);
}

/**
 * Pacing after a turn's mood (Bunraku pacingAfter): no mood or the same mood → one more turn at it,
 * another mood → 1. Rhythm by mood kinds (D-109): action or climax → lastActionSequence (Bunraku
 * counted climax as action), quiet → lastQuietMoment. The hints built on these are momentum's.
 */
export function pacingAfter(prev: DirectorPacing, mood: string | undefined, turn: number): DirectorPacing {
  const m = mood?.trim() ?? '';
  const rhythm = { ...prev.rhythm };
  if (m === '') return { currentMood: prev.currentMood, turnsAtCurrentMood: prev.turnsAtCurrentMood + 1, rhythm };
  const kinds = moodKinds(m);
  if (kinds.has('action') || kinds.has('climax')) rhythm.lastActionSequence = turn;
  if (kinds.has('quiet')) rhythm.lastQuietMoment = turn;
  const same = sameMood(m, prev.currentMood);
  return { currentMood: m, turnsAtCurrentMood: same ? prev.turnsAtCurrentMood + 1 : 1, rhythm };
}

// ---- the reducer ------------------------------------------------------------------------------------

const CHAPTER_PREFIX_RE = /^chapter\s*\d+\s*[:.\-]\s*/i;
const clip = (text: string, n = 60): string => (text.length > n ? `${text.slice(0, n)}…` : text);

const isLiveArc = (a: DirectorArc): boolean => a.status !== 'complete' && a.status !== 'abandoned';
const isLiveSeed = (x: DirectorSeed): boolean => !x.payoffDelivered;
const isLiveHidden = (a: DirectorInvisibleArc): boolean => a.status !== 'resolved' && a.status !== 'visible';

/**
 * Apply one plan to the state of the turn before (pure: the input is not changed) [§7.3, D-63,
 * D-108, D-109]. `state.turn` becomes `ctx.turn`; `lastDirective` holds the AUTHORED directive.
 * Every refused or ignored request is a `skipped` entry with its path in the plan. fitState is not
 * called here.
 */
export function applyPlan(state: DirectorState, plan: PlanningRound, ctx: ApplyContext): Applied {
  const s: DirectorState = structuredClone(state);
  const skipped: Skip[] = [];
  const turn = ctx.turn;
  // Every text stored passes the text cap [D-123] (readPlan's output already does; this holds for any caller).
  const round = capStrings(plan);
  applyChapter(s, round.chapterUpdate, turn, skipped);
  applyArcs(s, round.arcUpdates, turn, skipped);
  applySeeds(s, round.seedUpdates, turn, skipped);
  applyHidden(s, round.invisibleArcUpdates, turn, skipped);
  s.nextIntentions = intentionsOf(round.analysis, skipped);
  s.pacing = pacingAfter(s.pacing, round.directive.mood, turn);
  s.lastDirective = { turn, directive: structuredClone(round.directive) };
  s.turn = turn;
  return { state: s, skipped };
}

/** A JSON-shaped value with every string within STATE_LIMITS.text code points (clipText); new containers. */
function capStrings<T>(v: T): T {
  if (typeof v === 'string') return clipText(v, STATE_LIMITS.text) as T;
  if (Array.isArray(v)) return v.map(capStrings) as T;
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)])) as T;
  return v;
}

/** A chapter's goal: its objectives joined, cut to the text cap (the join can be 12 × 300 chars). */
function goalOf(objectives: readonly string[], skipped: Skip[]): string {
  const joined = objectives.join('; ');
  const goal = clipText(joined, STATE_LIMITS.text);
  if (goal !== joined) skipped.push({ path: 'chapterUpdate.objectives', why: `cut to ${STATE_LIMITS.text} chars` });
  return goal;
}

function applyChapter(s: DirectorState, u: PlanningChapterUpdate, turn: number, skipped: Skip[]): void {
  const current = s.currentChapterId === undefined ? undefined : s.chapters.find((c) => c.id === s.currentChapterId);
  // No chapter yet: the first one is made whatever the model asked for.
  const first = s.chapters.length === 0;
  const action = first ? 'start_new' : u.action;
  if (action === 'start_new') {
    if (current !== undefined && current.status === 'active') {
      const age = Math.max(0, turn - current.createdAtTurn);
      if (age < CHAPTER_MIN_TURNS) {
        skipped.push({ path: 'chapterUpdate', why: `start_new refused: chapter ${current.number} is ${age} turns old (minimum ${CHAPTER_MIN_TURNS})` });
        return;
      }
    }
    for (const c of s.chapters) {
      if (c.status !== 'active' && c.status !== 'concluding') continue;
      c.status = 'complete';
      if (u.closingMoment) c.closingMoment = u.closingMoment;
    }
    const number = s.chapters.reduce((n, c) => Math.max(n, c.number), 0) + 1;
    const title = u.title.replace(CHAPTER_PREFIX_RE, '').trim() || (first ? FIRST_CHAPTER_TITLE : `Chapter ${number}`);
    const chapter: DirectorChapter = {
      id: `chapter-${number}`,
      number,
      title,
      premise: u.description ?? '',
      status: 'active',
      themes: [...(u.themes ?? [])],
      tone: u.tone ?? '',
      majorGoal: goalOf(u.objectives ?? [], skipped),
      createdAtTurn: turn,
    };
    s.chapters.push(chapter);
    s.currentChapterId = chapter.id;
    return;
  }
  if (action !== 'update') return;
  if (current === undefined) {
    skipped.push({ path: 'chapterUpdate', why: 'update refused: no current chapter' });
    return;
  }
  if (u.description) current.premise = u.description;
  if (u.themes) current.themes = [...u.themes];
  if (u.objectives) current.majorGoal = goalOf(u.objectives, skipped);
  if (u.tone) current.tone = u.tone;
  if (u.status) current.status = u.status;
  if (u.closingMoment) current.closingMoment = u.closingMoment;
}

function applyArcs(s: DirectorState, updates: readonly PlanningArcUpdate[], turn: number, skipped: Skip[]): void {
  updates.forEach((u, i) => {
    const path = `arcUpdates[${i}]`;
    const sentTitle = u.title !== undefined && u.title.trim() !== '' && u.title.trim() !== u.arcId.trim() ? u.title : undefined;
    const bySelector = matchArc(s.arcs, u.arcId);
    const match = bySelector ?? (sentTitle !== undefined ? matchArc(s.arcs, sentTitle) : undefined);
    const stageTitle = u.newStageTitle?.trim() || undefined;
    let beat: DirectorArc['nextBeat'];
    if (u.nextBeat !== undefined) {
      if (u.nextBeat.description.trim() === '') skipped.push({ path: `${path}.nextBeat`, why: 'empty description' });
      else
        beat = {
          description: u.nextBeat.description,
          plannedAtTurn: turn,
          ...(u.nextBeat.targetTurn !== undefined ? { targetTurn: u.nextBeat.targetTurn } : {}),
          status: 'pending',
        };
    }

    if (match !== undefined) {
      const arc = match.item;
      // A title sent beside a matching id would rename the arc: arcs keep their title (Bunraku, RoleCall VVS-267).
      if (bySelector !== undefined && sentTitle !== undefined && matchKey(cleanTitle(sentTitle)) !== matchKey(arc.title))
        skipped.push({ path: `${path}.title`, why: `arcs are not renamed (kept "${arc.title}")` });
      let progress = false;
      if (stageTitle !== undefined) {
        const last = arc.stages[arc.stages.length - 1];
        if (last !== undefined && fold(last.title) === fold(stageTitle)) skipped.push({ path: `${path}.newStageTitle`, why: 'same as the last stage' });
        else {
          arc.stages.push({ title: stageTitle, turn });
          progress = true;
        }
      }
      if (u.markNextBeatDelivered) {
        if (arc.nextBeat?.status === 'pending') {
          arc.nextBeat = { ...arc.nextBeat, status: 'delivered', deliveredAtTurn: turn };
          progress = true;
        } else skipped.push({ path: `${path}.markNextBeatDelivered`, why: 'no pending beat' });
      }
      if (beat !== undefined) arc.nextBeat = beat;
      if (u.status !== undefined && u.status !== arc.status) {
        arc.status = u.status;
        progress = true;
      }
      // A rewritten description is not progress.
      if (u.description) arc.description = u.description;
      if (u.horizon) arc.horizon = u.horizon;
      if (u.priority) arc.priority = u.priority;
      if (u.arcType) arc.arcType = u.arcType;
      if (progress) arc.lastProgressTurn = turn;
      return;
    }

    const raw = sentTitle ?? (u.title?.trim() ? u.title : u.arcId);
    const title = cleanTitle(raw);
    if (title === '') {
      skipped.push({ path, why: `no arc matches "${clip(u.arcId)}" and it has no title for a new arc` });
      return;
    }
    if (s.arcs.filter(isLiveArc).length >= STATE_LIMITS.liveArcs) {
      skipped.push({ path, why: `new arc "${title}" refused: ${STATE_LIMITS.liveArcs} live arcs is the limit` });
      return;
    }
    if (title !== raw.replace(/\s+/g, ' ').trim()) skipped.push({ path: `${path}.title`, why: `cut to "${title}"` });
    if (u.markNextBeatDelivered) skipped.push({ path: `${path}.markNextBeatDelivered`, why: 'a new arc has no beat to deliver' });
    const arc: DirectorArc = {
      id: `arc-${s.nextId++}`,
      title,
      description: u.description ?? '',
      ...(s.currentChapterId !== undefined ? { chapterId: s.currentChapterId } : {}),
      status: u.status ?? 'seeding',
      priority: u.priority ?? 'background',
      arcType: u.arcType ?? 'side',
      horizon: u.horizon ?? 'medium',
      lastProgressTurn: turn,
      stages: stageTitle !== undefined ? [{ title: stageTitle, turn }] : [],
      ...(beat !== undefined ? { nextBeat: beat } : {}),
      createdAtTurn: turn,
    };
    s.arcs.push(arc);
  });
}

/** A relatedArcId that says "no arc" (the schema asks for '' then; models also write these). */
const NO_ARC_RE = /^(?:none|null|undefined|n\/a|-+|—)$/i;

/**
 * The id of the arc a seed's relatedArcId names [D-123]: matched like an arc update's selector (an
 * id, an echo, a title or its words), so the stored value is always an arc's id. Absent, blank or a
 * "none" → undefined silently; no arc matches → undefined and a skip (the seed keeps what it had).
 */
function relatedArc(s: DirectorState, raw: string | undefined, path: string, skipped: Skip[]): string | undefined {
  const sel = raw?.trim() ?? '';
  if (sel === '' || NO_ARC_RE.test(sel)) return undefined;
  const arc = findArc(s, sel);
  if (arc === undefined) skipped.push({ path: `${path}.relatedArcId`, why: `no arc matches "${clip(sel)}"` });
  return arc?.id;
}

function applySeeds(s: DirectorState, updates: readonly PlanningSeedUpdate[], turn: number, skipped: Skip[]): void {
  updates.forEach((u, i) => {
    const path = `seedUpdates[${i}]`;
    const id = u.id?.trim() || undefined;
    const hint = fold(u.title);
    // A named id that does not exist is skipped: a shared hint is not identity (Bunraku).
    const hit =
      id !== undefined
        ? s.seeds.find((x) => x.id.toLowerCase() === id.toLowerCase())
        : hint !== ''
          ? s.seeds.find((x) => fold(x.hint) === hint)
          : undefined;
    if (id !== undefined && hit === undefined) {
      skipped.push({ path, why: `no seed has id "${clip(id)}"` });
      return;
    }
    switch (u.action) {
      case 'plant': {
        if (hit !== undefined) {
          // Planting a known seed again updates it; plantedAtTurn stays.
          if (u.description) hit.payoff = u.description;
          if (u.scope) hit.scope = u.scope;
          const related = relatedArc(s, u.relatedArcId, path, skipped);
          if (related !== undefined) hit.relatedArcId = related;
          return;
        }
        if (hint === '') {
          skipped.push({ path, why: 'a new seed needs a title' });
          return;
        }
        if (s.seeds.filter(isLiveSeed).length >= STATE_LIMITS.liveSeeds) {
          skipped.push({ path, why: `new seed refused: ${STATE_LIMITS.liveSeeds} pending seeds is the limit` });
          return;
        }
        const related = relatedArc(s, u.relatedArcId, path, skipped);
        const seed: DirectorSeed = {
          id: `seed-${s.nextId++}`,
          hint: u.title.trim(),
          payoff: u.description ?? '',
          scope: u.scope ?? 'player',
          plantedAtTurn: turn,
          payoffHorizon: u.payoffHorizon ?? 'medium',
          payoffDelivered: false,
          ...(related !== undefined ? { relatedArcId: related } : {}),
          reinforcements: [],
        };
        s.seeds.push(seed);
        s.lastPlantTurn = turn;
        return;
      }
      case 'reinforce': {
        if (hit === undefined) {
          skipped.push({ path, why: `reinforce refused: no seed "${clip(u.title)}"` });
          return;
        }
        if (u.description && !hit.payoff) hit.payoff = u.description;
        if (u.scope) hit.scope = u.scope;
        const related = relatedArc(s, u.relatedArcId, path, skipped);
        if (related !== undefined) hit.relatedArcId = related;
        // One reinforcement per turn; the list is capped by fitState.
        if (hit.reinforcements[hit.reinforcements.length - 1]?.turn === turn) skipped.push({ path, why: 'already reinforced this turn' });
        else hit.reinforcements.push({ turn });
        return;
      }
      case 'resolve': {
        if (hit === undefined) {
          skipped.push({ path, why: `resolve refused: no seed "${clip(u.title)}"` });
          return;
        }
        hit.payoffDelivered = true;
        hit.payoffTurn = turn;
        const outcome = u.outcome ?? u.description;
        if (outcome) hit.payoff = outcome;
        return;
      }
      case 'delete': {
        if (hit === undefined) {
          skipped.push({ path, why: `delete refused: no seed "${clip(u.title)}"` });
          return;
        }
        s.seeds.splice(s.seeds.indexOf(hit), 1);
        return;
      }
    }
  });
}

/**
 * The hidden arc an update names [D-108, D-123]: by id (arcId, or a title that is an id), then by an
 * id echoed from the prompt's `[hidden-N] "Title"` line when that arc exists, then by the match key of
 * the title as sent and as a new hidden arc's title would be cleaned (cleanHiddenTitle).
 */
function matchHidden(list: readonly DirectorInvisibleArc[], u: PlanningInvisibleArcUpdate): DirectorInvisibleArc | undefined {
  const sels = [u.arcId, u.title].flatMap((x) => (x !== undefined && x.trim() !== '' ? [x.trim()] : []));
  const ids = sels.map((x) => x.toLowerCase());
  const byId = list.find((a) => ids.includes(a.id.toLowerCase()));
  if (byId !== undefined) return byId;
  for (const echoed of sels.flatMap((x) => idEchoes(x, 'hidden').ids)) {
    const byEcho = list.find((a) => a.id.toLowerCase() === echoed);
    if (byEcho !== undefined) return byEcho;
  }
  for (const title of new Set([u.title, cleanHiddenTitle(u.title)])) {
    const key = matchKey(title);
    const byKey = key === '' ? undefined : list.find((a) => matchKey(a.title) === key);
    if (byKey !== undefined) return byKey;
  }
  return undefined;
}

function applyHidden(s: DirectorState, updates: readonly PlanningInvisibleArcUpdate[], turn: number, skipped: Skip[]): void {
  updates.forEach((u, i) => {
    const path = `invisibleArcUpdates[${i}]`;
    const hit = matchHidden(s.invisibleArcs, u);
    const stageTitle = u.newStageTitle?.trim() || undefined;
    const clue = u.newClue?.trim() || undefined;
    if (u.action === 'add' || u.action === 'update') {
      if (hit !== undefined) {
        if (u.description) hit.description = u.description;
        if (u.status) hit.status = u.status;
        if (u.arcType) hit.arcType = u.arcType;
        if (u.horizon) hit.horizon = u.horizon;
        if (u.surfaceCondition) hit.surfaceCondition = u.surfaceCondition;
        // Bunraku sets the scope only when the arc is made.
        if (u.scope && u.scope !== hit.scope) skipped.push({ path: `${path}.scope`, why: 'scope is set when the arc is made' });
        if (u.action === 'add') {
          if (clue !== undefined) skipped.push({ path: `${path}.newClue`, why: 'clues are recorded by update, not add' });
          if (stageTitle !== undefined) skipped.push({ path: `${path}.newStageTitle`, why: 'stages are recorded by update, not add' });
          return;
        }
        if (clue !== undefined) {
          if (hit.playerClues.some((c) => fold(c.clue) === fold(clue))) skipped.push({ path: `${path}.newClue`, why: 'clue already recorded' });
          else hit.playerClues.push({ turn, clue });
        }
        if (stageTitle !== undefined) {
          const last = hit.stages[hit.stages.length - 1];
          if (last !== undefined && fold(last.title) === fold(stageTitle)) skipped.push({ path: `${path}.newStageTitle`, why: 'same as the last stage' });
          else hit.stages.push({ title: stageTitle, turn });
        }
        return;
      }
      // Cleaned as an arc's title is [D-123]: no echoed id or quotes copied from the prompt's line.
      const title = cleanHiddenTitle(u.title);
      if (title === '') {
        skipped.push({ path, why: 'a new hidden arc needs a title' });
        return;
      }
      if (s.invisibleArcs.filter(isLiveHidden).length >= STATE_LIMITS.liveHidden) {
        skipped.push({ path, why: `new hidden arc "${clip(title)}" refused: ${STATE_LIMITS.liveHidden} live hidden arcs is the limit` });
        return;
      }
      if (title !== u.title.replace(/\s+/g, ' ').trim()) skipped.push({ path: `${path}.title`, why: `cut to "${title}"` });
      if (u.action === 'add') {
        if (u.status !== undefined && u.status !== 'seeding') skipped.push({ path: `${path}.status`, why: 'a hidden arc made by add starts as seeding' });
        if (clue !== undefined) skipped.push({ path: `${path}.newClue`, why: 'clues are recorded by update, not add' });
      }
      const arc: DirectorInvisibleArc = {
        id: `hidden-${s.nextId++}`,
        title,
        description: u.description ?? title,
        arcType: u.arcType ?? 'background',
        horizon: u.horizon ?? 'medium',
        scope: u.scope ?? 'world',
        status: u.action === 'update' ? (u.status ?? 'seeding') : 'seeding',
        stages: stageTitle !== undefined ? [{ title: stageTitle, turn }] : [],
        ...(u.surfaceCondition ? { surfaceCondition: u.surfaceCondition } : {}),
        playerClues: u.action === 'update' && clue !== undefined ? [{ turn, clue }] : [],
        createdAtTurn: turn,
      };
      s.invisibleArcs.push(arc);
      return;
    }
    if (hit === undefined) {
      skipped.push({ path, why: `${u.action} refused: no hidden arc "${clip(u.title)}"` });
      return;
    }
    if (u.action === 'surface') hit.status = 'visible';
    else if (u.action === 'resolve') hit.status = 'resolved';
    else s.invisibleArcs.splice(s.invisibleArcs.indexOf(hit), 1);
  });
}

/** analysis.intentions replace the stored ones (Bunraku), empty ones dropped, at most STATE_LIMITS.intentions. */
function intentionsOf(analysis: PlanningAnalysis, skipped: Skip[]): DirectorState['nextIntentions'] {
  const all = analysis.intentions ?? [];
  const kept = all.filter((x, j) => {
    if (x.description.trim() !== '') return true;
    skipped.push({ path: `analysis.intentions[${j}]`, why: 'empty description' });
    return false;
  });
  if (kept.length > STATE_LIMITS.intentions) skipped.push({ path: 'analysis.intentions', why: `kept ${STATE_LIMITS.intentions} of ${kept.length}` });
  return kept.slice(0, STATE_LIMITS.intentions).map((x) => ({ ...x }));
}
