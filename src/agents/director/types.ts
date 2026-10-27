// Ported from Bunraku:src/stage/contracts/director-types.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: the Director's state, plan and directive shapes; enum values kept verbatim) and
// RoleCall:apps/rc/src/lib/ai/dm-stream/types.ts@fb8dc623e (NarratorDirective).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Story Director's types and constants (ARCHITECTURE.md §7.3, §5.9, D-61…D-65; .notes/m4-decisions.md).
// CONTRACT FILE for the M4 build: only the lead changes it. The cut-down D-61 shape: no activity, edits,
// archive, tracker updates or soft deletes; ages are derived from createdAtTurn / plantedAtTurn /
// lastProgressTurn, never stored counters; field names and enum values stay Bunraku's, because the
// prompts, momentum and the personalities name them.

// ---- enums ------------------------------------------------------------------------------------------

export const HORIZONS = ['immediate', 'short', 'medium', 'long', 'epic'] as const;
export type Horizon = (typeof HORIZONS)[number];

export const PACINGS = ['slow', 'medium', 'fast', 'breakneck'] as const;
export type Pacing = (typeof PACINGS)[number];

export const URGENCIES = ['subtle', 'moderate', 'forceful'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const ARC_STATUSES = ['seeding', 'building', 'climax', 'resolution', 'complete', 'abandoned'] as const;
export type ArcStatus = (typeof ARC_STATUSES)[number];

export const ARC_PRIORITIES = ['background', 'active', 'urgent'] as const;
export type ArcPriority = (typeof ARC_PRIORITIES)[number];

export const ARC_TYPES = ['main', 'side', 'character', 'world', 'mystery'] as const;
export type ArcType = (typeof ARC_TYPES)[number];

export const HIDDEN_ARC_TYPES = ['faction', 'npc_agenda', 'world_event', 'conspiracy', 'background'] as const;
export type HiddenArcType = (typeof HIDDEN_ARC_TYPES)[number];

export const HIDDEN_STATUSES = ['seeding', 'building', 'approaching_player', 'visible', 'resolved'] as const;
export type HiddenStatus = (typeof HIDDEN_STATUSES)[number];

export const CHAPTER_STATUSES = ['active', 'concluding', 'complete'] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const NEXT_BEAT_STATUSES = ['pending', 'delivered', 'abandoned'] as const;
export type NextBeatStatus = (typeof NEXT_BEAT_STATUSES)[number];

export const SCOPES = ['world', 'player'] as const;
export type Scope = (typeof SCOPES)[number];

export const SEED_ACTIONS = ['plant', 'reinforce', 'resolve', 'delete'] as const;
export type SeedAction = (typeof SEED_ACTIONS)[number];

export const HIDDEN_ACTIONS = ['add', 'update', 'surface', 'resolve', 'delete'] as const;
export type HiddenAction = (typeof HIDDEN_ACTIONS)[number];

export const CHAPTER_ACTIONS = ['none', 'update', 'start_new'] as const;
export type ChapterAction = (typeof CHAPTER_ACTIONS)[number];

export const INTENTION_PRIORITIES = ['must', 'should', 'could'] as const;
export type IntentionPriority = (typeof INTENTION_PRIORITIES)[number];

export const INTENTION_TARGETS = ['next', 'soon', 'eventually'] as const;
export type IntentionTarget = (typeof INTENTION_TARGETS)[number];

export const CREATIVITY = ['subtle', 'moderate', 'dramatic'] as const;
export type Creativity = (typeof CREATIVITY)[number];

/** Picker order (Bunraku DIRECTOR_PERSONALITIES). */
export const DIRECTOR_PERSONALITIES = [
  'the-weaver',
  'the-architect',
  'the-oracle',
  'the-romantic',
  'the-thrill-seeker',
  'the-shadow',
  'the-jester',
  'the-enigma',
  'the-chronicler',
  'the-balanced',
] as const;
export type PersonalityId = (typeof DIRECTOR_PERSONALITIES)[number];
/** Sage. Also what an unknown `director.style` falls back to [D-64, D-111]. */
export const DEFAULT_PERSONALITY: PersonalityId = 'the-balanced';

// ---- the directive (what the narrator sees) ---------------------------------------------------------

/** RoleCall NarratorDirective without `focus` [D-62]; `mood` may be absent ('neutral' is never invented). */
export interface NarratorDirective {
  mood?: string;
  /** Absent or invalid in the plan → 'medium'. */
  pacing: Pacing;
  include?: { characters?: string[]; themes?: string[]; sensoryDetails?: string[]; foreshadowing?: string[] };
  avoid?: { topics?: string[]; characters?: string[]; revelations?: string[] };
  dialogueGuidance?: { character: string; tone: string; hints?: string[] }[];
  /** tension_level: 0..10. */
  sceneGuidance?: { setting?: string; atmosphere?: string; tension_level?: number };
  endingHook?: string;
  arcDirections?: { arcName: string; instruction: string; urgency: Urgency }[];
  callbacks?: { reference: string; instruction: string }[];
  characterBeats?: { character: string; beat: string; motivation?: string }[];
  narrativeGoal?: string;
}

// ---- state (one snapshot per reply version, §5.9) ---------------------------------------------------

export interface DirectorStage {
  title: string;
  turn: number;
}

export interface DirectorNextBeat {
  description: string;
  plannedAtTurn: number;
  targetTurn?: number;
  status: NextBeatStatus;
  deliveredAtTurn?: number;
}

export interface DirectorChapter {
  /** 'chapter-<number>'. */
  id: string;
  number: number;
  title: string;
  premise: string;
  status: ChapterStatus;
  themes: string[];
  tone: string;
  majorGoal: string;
  closingMoment?: string;
  createdAtTurn: number;
}

export interface DirectorArc {
  /** 'arc-N' from state.nextId. */
  id: string;
  title: string;
  description: string;
  chapterId?: string;
  status: ArcStatus;
  priority: ArcPriority;
  arcType: ArcType;
  horizon: Horizon;
  /** Moves only on a new stage, a status change or a delivered beat. */
  lastProgressTurn?: number;
  stages: DirectorStage[];
  nextBeat?: DirectorNextBeat;
  createdAtTurn: number;
  /** Written by a human (dirEdit, later): never evicted. Absent in v1. */
  byUser?: true;
}

export interface DirectorSeed {
  /** 'seed-N'. */
  id: string;
  hint: string;
  payoff: string;
  scope: Scope;
  plantedAtTurn: number;
  payoffHorizon: Horizon;
  payoffDelivered: boolean;
  payoffTurn?: number;
  relatedArcId?: string;
  reinforcements: { turn: number }[];
  byUser?: true;
}

export interface DirectorInvisibleArc {
  /** 'hidden-N'. */
  id: string;
  title: string;
  description: string;
  arcType: HiddenArcType;
  horizon: Horizon;
  scope: Scope;
  status: HiddenStatus;
  stages: DirectorStage[];
  surfaceCondition?: string;
  playerClues: { turn: number; clue: string }[];
  createdAtTurn: number;
  /** Never evicted. Absent in v1. */
  userAuthored?: true;
}

export interface DirectorNote {
  id: string;
  content: string;
  createdAtTurn: number;
}

export interface DirectorIntention {
  type: string;
  description: string;
  priority: IntentionPriority;
  targetTurn: IntentionTarget;
}

export interface DirectorPacing {
  currentMood: string;
  turnsAtCurrentMood: number;
  rhythm: { lastActionSequence: number; lastQuietMoment: number };
}

export interface DirectorState {
  /** The last Director turn, failed ones included; the next one is turn + 1. Stored, never derived. */
  turn: number;
  /** One counter for arc-N, seed-N and hidden-N. */
  nextId: number;
  chapters: DirectorChapter[];
  currentChapterId?: string;
  arcs: DirectorArc[];
  seeds: DirectorSeed[];
  invisibleArcs: DirectorInvisibleArc[];
  /** Written only by a human (later); empty in v1. */
  notes: DirectorNote[];
  pacing: DirectorPacing;
  nextIntentions: DirectorIntention[];
  /** The AUTHORED directive (before enrich and the persona filter); read only by the self-audit. */
  lastDirective?: { turn: number; directive: NarratorDirective };
  /** Planting pressure survives the eviction of paid-off seeds. */
  lastPlantTurn?: number;
}

// ---- the plan (the model's answer, after readPlan) ---------------------------------------------------

export interface PlanningArcUpdate {
  /** The match key the model sent (arcId ?? id ?? title); matched by applyPlan [D-108]. */
  arcId: string;
  title?: string;
  description?: string;
  status?: ArcStatus;
  horizon?: Horizon;
  priority?: ArcPriority;
  arcType?: ArcType;
  newStageTitle?: string;
  /** Read, not stored. */
  newStageDescription?: string;
  markNextBeatDelivered?: boolean;
  nextBeat?: { description: string; targetTurn?: number };
}

export interface PlanningSeedUpdate {
  id?: string;
  title: string;
  action: SeedAction;
  scope?: Scope;
  relatedArcId?: string;
  description?: string;
  payoffHorizon?: Horizon;
  reinforcement?: string;
  outcome?: string;
}

export interface PlanningInvisibleArcUpdate {
  title: string;
  action: HiddenAction;
  arcId?: string;
  description?: string;
  status?: HiddenStatus;
  arcType?: HiddenArcType;
  horizon?: Horizon;
  scope?: Scope;
  surfaceCondition?: string;
  newClue?: string;
  newStageTitle?: string;
  newStageDescription?: string;
}

export interface PlanningAnalysis {
  whatHappened?: string;
  summary?: string;
  seedsPlanted?: string[];
  seedsPaidOff?: string[];
  unexpected?: string[];
  pacingAnalysis?: string;
  playerEnergy?: string;
  /** Complete intentions (readPlan fills the defaults of missing fields, D-107). */
  intentions?: DirectorIntention[];
  suggestedActions?: string[];
}

export interface PlanningChapterUpdate {
  action: ChapterAction;
  /** '' when the model sent none. */
  title: string;
  description?: string;
  status?: ChapterStatus;
  themes?: string[];
  objectives?: string[];
  tone?: string;
  closingMoment?: string;
}

export interface PlanningRound {
  directive: NarratorDirective;
  arcUpdates: PlanningArcUpdate[];
  seedUpdates: PlanningSeedUpdate[];
  invisibleArcUpdates: PlanningInvisibleArcUpdate[];
  analysis: PlanningAnalysis;
  chapterUpdate: PlanningChapterUpdate;
}

// ---- results ----------------------------------------------------------------------------------------

/** Something the reader, reducer, filter or fitState dropped or changed, for the trace [D-60]. */
export interface Skip {
  path: string;
  why: string;
}

/**
 * What an agent's reader returns for the decoded JSON of one answer (structuredCall, D-98). A failure
 * message feeds the correction pass.
 */
export type ReadResult<T> =
  | { ok: true; value: T; skipped: Skip[] }
  | { ok: false; code: 'invalid' | 'missing_directive'; message: string };

export const DIRECTOR_FAIL_CODES = [
  'no_connection',
  'transport_unsupported',
  'provider_error',
  'no_output',
  'undecodable',
  'missing_directive',
  'timeout',
  'aborted',
  'no_room',
] as const;

export type DirectorFailCode =
  | 'no_connection'
  | 'transport_unsupported'
  | 'provider_error'
  | 'no_output'
  | 'undecodable'
  | 'missing_directive'
  | 'timeout'
  | 'aborted'
  /** D-121: the Director's prompt does not fit its window even shrunk; nothing was sent. */
  | 'no_room';

export interface DirectorAttempt {
  transport: 'structured' | 'tagged';
  outcome: string;
  ms: number;
  status?: number;
  finish?: string;
  /** Output tokens. */
  tokens?: number;
}

/** What one Director turn left on the reply (prep.dir and the commit body's dir) [D-61, §5.9]. */
export interface DirectorRecord {
  turn: number;
  ok: boolean;
  code?: DirectorFailCode;
  transport?: 'structured' | 'tagged';
  profile?: 'full' | 'lite';
  /** 'conn:model' of the call. */
  model?: string;
  /** FINAL directive: after enrichFromMomentum and the persona filter, as sent. */
  directive?: NarratorDirective;
  analysis?: PlanningAnalysis;
  skipped: Skip[];
  attempts: DirectorAttempt[];
  /** After applyPlan and fitState; on failure the previous state with turn + 1. */
  state: DirectorState;
  /** Reducer version [§5.9]. */
  reducer: number;
  /** [D-29] the reply whose plan this swipe reused. */
  reusedFrom?: string;
  /** The plan was found in the reasoning text, not in the visible answer [D-60]. */
  fromReasoning?: true;
}

// ---- momentum (computed before the call, D-63) ------------------------------------------------------

export interface StaleArc {
  id: string;
  name: string;
  status: ArcStatus;
  turnsSinceProgress: number;
  suggestedAction: string;
}

export interface ForcedArcAction {
  id: string;
  name: string;
  status: ArcStatus;
  horizon: Horizon;
  /** Bunraku's `turnsActive` here: turns without progress (m4-decisions A.2). */
  turnsSinceProgress: number;
  horizonLimit: number;
  overdueBy: number;
}

export interface RipeSeed {
  id: string;
  name: string;
  /** Age: turn − plantedAtTurn. */
  turnsPlanted: number;
  reinforcements: number;
  payoff: string;
  suggestedAction: string;
}

export interface PlantingPressure {
  active: boolean;
  severity: 'none' | 'moderate' | 'high' | 'critical';
  pendingCount: number;
  turnsSinceLastPlant: number;
  reason: string;
  suggestedAction: string;
}

export interface ShadowOpportunity {
  id: string;
  title: string;
  summary: string;
  reason: string;
  turnsRipe: number;
  urgency: 'low' | 'medium' | 'high';
  suggestedAction: string;
}

export interface MomentumReport {
  staleArcs: StaleArc[];
  ripeSeeds: RipeSeed[];
  forcedActions: ForcedArcAction[];
  shadowOpportunities: ShadowOpportunity[];
  plantingPressure: PlantingPressure;
  rhythm: { needsQuietMoment: boolean; needsTension: boolean; readyForClimax: boolean };
  pacingRecommendation: string;
  summary: string;
}

// ---- constants --------------------------------------------------------------------------------------

/** State limits [D-61]; byUser / userAuthored items are never evicted. */
export const STATE_LIMITS = {
  liveArcs: 24,
  liveHidden: 12,
  liveSeeds: 32,
  notes: 16,
  /** Completed items kept per kind (finished arcs, paid seeds, resolved/visible hidden arcs). */
  completedPerKind: 10,
  /** Completed chapters kept besides the current one. */
  completedChapters: 10,
  stages: 6,
  reinforcements: 4,
  clues: 6,
  intentions: 5,
  /** Themes per chapter. */
  themes: 12,
  text: 300,
  arcTitle: 80,
  /** UTF-8 bytes of JSON.stringify(state) (m4-decisions A.6). */
  hardBytes: 32_768,
  typicalBytes: 16_384,
} as const;

/** Reading limits [D-62, D-107]. */
export const READ_LIMITS = {
  sectionEntries: 40,
  directiveList: 12,
  liteArcDirections: 3,
  liteCharacterBeats: 3,
  liteCallbacks: 2,
  intentionsRead: 10,
  liteIntentions: 3,
  skipped: 20,
} as const;

/** What the user prompt shows [D-64]; the rest as "(+N more…)". */
export const PROMPT_LIMITS = { arcs: 25, seeds: 40, hidden: 25, notes: 30, text: 300, arcStagesShown: 6 } as const;

/** Chapter length hints (Bunraku apply.ts:117 estimatedTurns). */
export const CHAPTER_TURNS = { minimum: 20, target: 50, maximum: 100 } as const;

/** Turns from createdAtTurn / plantedAtTurn after which a hidden arc should surface and a seed or hidden arc is OVERDUE. */
export const SURFACE_TURNS: Readonly<Record<Horizon, number>> = { immediate: 1, short: 3, medium: 5, long: 10, epic: 25 };

/** start_new is refused while the current chapter is younger than this [D-63]. */
export const CHAPTER_MIN_TURNS = 3;

export const REDUCER_VERSION = 1;

/** Call parameters (§7.3, D-101, D-102). */
export const DIRECTOR_CALL = {
  temperature: 0.7,
  fullMaxTokens: 16_384,
  liteMaxTokens: 1_500,
  liteReasoningExtra: 1_024,
  /** Output tokens the full profile must still fit besides its prompt (auto profile test). */
  fullOutputReserve: 4_096,
  /** Below this window `auto` is lite (same threshold as the Compendium, D-79). */
  liteWindow: 24_576,
  /** Below this window even `full` runs lite (notice director_lite). */
  fullMinWindow: 16_384,
  historyShareFull: 0.25,
  historyShareLite: 0.1,
  historyMessages: 30,
  selfAuditChars: 2_400,
  instructionsMax: 2_000,
  correctionEchoChars: 1_000,
} as const;

/** The world snapshot's budget (M5a worldSnapshot; the Director gets '' until then). */
export interface WorldBudget {
  chars: number;
  characters: number;
  relationships: number;
  tensions: number;
  locations: number;
}
export const WORLD_FULL: WorldBudget = { chars: 4_000, characters: 15, relationships: 5, tensions: 5, locations: 5 };
export const WORLD_LITE: WorldBudget = { chars: 1_500, characters: 6, relationships: 2, tensions: 3, locations: 2 };
