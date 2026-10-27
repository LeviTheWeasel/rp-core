// Ported from Bunraku:src/core/director/plan-schema.ts and plan-round.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: the plan's JSON Schema, its text copied from RoleCall's commit_planning_round, and
// the reader) and RoleCall:apps/rc/src/lib/ai/dm-stream/{schemas.ts,DirectiveBuilder.ts}@fb8dc623e
// (Coneja-Chibi, Levi: the tolerance rules of validateNarratorDirective, hasDirectiveContent).
// Copyright (C) 2026 Coneja-Chibi, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Director's plan: its JSON Schema (full and lite) and the one place a plan is read
// (ARCHITECTURE.md §7.3, D-62; .notes/m4-decisions.md D-107). The directive is the only strict part:
// a plan whose directive sets no field is refused (`missing_directive`, which feeds the correction
// pass). Everything else is read leniently, and whatever is dropped or changed goes to `skipped`.
//
// Port notes. Kept: the six sections and the field texts of plan-schema.ts; `arcId ?? id ?? title`;
// `-term` horizons; numeric-string target turns; urgency → 'moderate'; tension clamped to 0..10; an
// analysis string is `whatHappened`; a bad element costs only that element. Changed (D-62, D-107): no
// tool wrapper (the tool description is prompt text, prompt.ts PLAN_RULES); the root requires only
// `directive` and the directive requires nothing (mood may be absent, pacing absent/invalid →
// 'medium'); a directive is refused only when it has no content (hasDirectiveContent, RoleCall's rule
// made precise: an empty sceneGuidance or empty lists are not content, pacing counts only when sent,
// valid and not 'medium'); enum values are case-fixed; unknown values, unknown keys and malformed
// elements go to `skipped` instead of vanishing; a section sent as a JSON string is decoded with
// looseJson (Bunraku read only arrays/objects); a seed without a valid action is skipped (Bunraku
// made it 'reinforce'); a missing chapterUpdate is {none, ''} (Bunraku invented "The Story Begins");
// texts are cut at 300 (Bunraku 1 200), arc titles at 80; intentions are completed with the defaults
// of Bunraku's apply.ts:89 and keep their order (readAnalysis put string items first); hidden-arc
// updates need only title and action (Bunraku's schema required 11 fields), and plannedBeats,
// foreshadowingSeeds, relatedVisibleArcs, expectedSurfaceTurn are gone (rp-core does not store them).
// Added: `arcType` in the arc-update schema (the reader read it, the schema never offered it); the
// lite schema; the `skipped` cap; a target turn must be a safe integer (D-123).

import { looseJson } from '../../tools/args.ts';
import type { JSONSchema } from '../../providers/types.ts';
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
  type DirectorIntention,
  type NarratorDirective,
  type PlanningAnalysis,
  type PlanningArcUpdate,
  type PlanningChapterUpdate,
  type PlanningInvisibleArcUpdate,
  type PlanningRound,
  type PlanningSeedUpdate,
  type ReadResult,
  type Skip,
} from './types.ts';

// ---- the schema ---------------------------------------------------------------------------------
// Sent as `response_format: json_schema` without `strict` (structured transport) or shown as compact
// JSON in the system prompt (tagged). Only `directive` is required at the root: a grammar-enforcing
// server (llama.cpp, vLLM) would otherwise force every section out of the model, and readPlan
// defaults all the others. No `additionalProperties: false` anywhere: extra keys are read as
// `skipped`, not refused.

const DIRECTIVE_PROPS: Record<string, JSONSchema> = {
  mood: {
    type: 'string',
    description: "Current emotional tone of the scene - free-form but concise (e.g. 'tense', 'melancholy', 'playful unease').",
  },
  pacing: {
    type: 'string',
    enum: [...PACINGS],
    description: 'How quickly the next beat should unfold.',
  },
  include: {
    type: 'object',
    description:
      "Concrete material the narrator SHOULD weave into this turn's prose. Almost every turn has at least one entry across these sub-fields - they're how you steer texture, not whether to.",
    properties: {
      characters: { type: 'array', items: { type: 'string' }, description: 'NPC names the narrator should bring on-stage or keep present this turn.' },
      themes: {
        type: 'array',
        items: { type: 'string' },
        description: "Thematic threads worth surfacing this turn (e.g. 'discipline gap', 'mentorship testing', 'loneliness of command').",
      },
      sensoryDetails: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Concrete sensory anchors the narrator should drop in - a smell, a sound, the texture of a surface. These prevent generic prose.',
      },
      foreshadowing: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Hints to plant for future payoffs - a brief odd phrase, an out-of-place mark, a name dropped in passing. Tie to a relatedArcId in your seedUpdates if planting a new seed.',
      },
    },
  },
  avoid: {
    type: 'object',
    description: 'What the narrator should NOT surface this turn - kept secret, off-limits, or saved for later beats.',
    properties: {
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: "Topics the narrator must not raise this turn (e.g. 'future plot twists', 'NPC's hidden motive').",
      },
      characters: { type: 'array', items: { type: 'string' }, description: 'NPCs who should stay off-screen this turn.' },
      revelations: { type: 'array', items: { type: 'string' }, description: 'Specific secrets/identities/agendas to hold back this turn.' },
    },
  },
  dialogueGuidance: {
    type: 'array',
    description:
      "Per-NPC voice direction. For every NPC who has speakable lines this turn, give the narrator a tone read and (when useful) specific hint phrases the NPC's voice should land. Without this, dialogue drifts toward generic affect.",
    items: {
      type: 'object',
      required: ['character', 'tone'],
      properties: {
        character: { type: 'string', description: 'NPC name.' },
        tone: {
          type: 'string',
          description: "Short tonal read - 'measured cold focus with strain under it', 'controlled bitterness', 'wry tenderness'.",
        },
        hints: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Specific line shapes or phrases the NPC's voice should produce - 'speaks in training commands', 'one off-hand formal instruction'.",
        },
      },
    },
  },
  sceneGuidance: {
    type: 'object',
    description:
      "Where the scene is AND its physical/emotional texture. Fill this almost every turn - even when the location hasn't changed, atmosphere and tension level shift turn-to-turn.",
    properties: {
      setting: { type: 'string', description: "Concrete location - 'stone courtyard by the eastern wall practice posts', not 'the courtyard'." },
      atmosphere: {
        type: 'string',
        description: "The room/space's emotional weather - 'tight air after sparring, everyone pretending it's routine'.",
      },
      tension_level: {
        type: 'number',
        description: '0-10 scale. Calibrate so the narrator paces tone correctly. 6+ should produce noticeable strain in the prose.',
      },
    },
  },
  endingHook: {
    type: 'string',
    description:
      "What specific moment should END this turn's narrator output - a glance, a sound, an unfinished question. The hook should make the next player input feel inevitable. Don't skip this; an ending without a hook reads as fade-out.",
  },
  arcDirections: {
    type: 'array',
    description:
      'Per-arc nudge to the narrator. For every ACTIVE arc the player is engaging with this turn, give the narrator one specific instruction that moves the arc forward in the prose.',
    items: {
      type: 'object',
      required: ['arcName', 'instruction', 'urgency'],
      properties: {
        arcName: { type: 'string', description: "Active arc's title or slug." },
        instruction: {
          type: 'string',
          description:
            "What the narrator should DO this turn that moves the arc - 'have Lyra stop the sparring tempo and give a specific footwork drill', not 'show training'.",
        },
        urgency: {
          type: 'string',
          enum: [...URGENCIES],
          description:
            "How loudly the arc beat lands. 'subtle' = background hum, 'moderate' = noticeable nudge, 'forceful' = the arc is the spine of this turn.",
        },
      },
    },
  },
  callbacks: {
    type: 'array',
    description:
      'References to earlier moments the narrator should echo this turn - a memory, a phrase, an object. Callbacks are how the story feels woven instead of episodic. Aim for at least one every few turns.',
    items: {
      type: 'object',
      required: ['reference', 'instruction'],
      properties: {
        reference: {
          type: 'string',
          description: "What earlier moment is being called back - 'Brynn's earlier comment about her father', 'the rusted bell on turn 7'.",
        },
        instruction: {
          type: 'string',
          description: "How the narrator should land the callback - 'have it surface as a half-finished thought during Lyra's correction'.",
        },
      },
    },
  },
  characterBeats: {
    type: 'array',
    description:
      'Per-NPC internal beat the narrator should show through action or implication. Distinct from dialogueGuidance - this is what the NPC is internally DOING or feeling, not how they speak.',
    items: {
      type: 'object',
      required: ['character', 'beat'],
      properties: {
        character: { type: 'string', description: 'NPC name.' },
        beat: {
          type: 'string',
          description:
            "The internal beat - 'Lyra weighing whether to reveal her real reason for taking Kai on', 'Brynn fighting the urge to throw the drill blade'.",
        },
        motivation: {
          type: 'string',
          description: "Optional one-phrase why behind the beat - 'pride she won't admit', 'old wound from training under her father'.",
        },
      },
    },
  },
  narrativeGoal: {
    type: 'string',
    description:
      "One-sentence read on what THIS TURN's prose should accomplish in the larger arc - 'establish Lyra's mentorship as both demanding and protective while letting Brynn's resentment sharpen visibly'.",
  },
};

const NEW_STAGE_TITLE =
  'New milestone title (only for important events, BACKWARD-LOOKING - describes what already happened this turn).';

const ARC_UPDATE_PROPS: Record<string, JSONSchema> = {
  arcId: { type: 'string', description: 'ID of the arc (from the active arcs list)' },
  title: {
    type: 'string',
    description:
      "Short label (~3-6 words, max 80 chars). Only set if the arc was renamed. NO description content, NO 'Next Beat:' content, NO multi-line text - those go in description and nextBeat.",
  },
  description: { type: 'string', description: 'Updated description reflecting what happened this turn' },
  status: { type: 'string', enum: [...ARC_STATUSES], description: 'Updated status' },
  horizon: { type: 'string', enum: [...HORIZONS] },
  priority: { type: 'string', enum: [...ARC_PRIORITIES] },
  // rp-core: the reader always read arcType, the schema never offered it, so every new arc was 'side'.
  arcType: { type: 'string', enum: [...ARC_TYPES], description: 'Kind of arc. Set it when you add a new arc.' },
  newStageTitle: { type: 'string', description: `${NEW_STAGE_TITLE} MUST be paired with newStageDescription.` },
  newStageDescription: {
    type: 'string',
    description: 'REQUIRED when newStageTitle is set. Describe what happened, who was involved, and why it matters.',
  },
  markNextBeatDelivered: {
    type: 'boolean',
    description: "Mark the arc's pending nextBeat as delivered when the narrator's prose THIS turn fulfilled it.",
  },
  nextBeat: {
    type: 'object',
    description: 'FORWARD-LOOKING plan for what should happen NEXT in this arc. Stages describe history; nextBeat describes future.',
    required: ['description'],
    properties: {
      description: { type: 'string', description: 'What the DM plans to push the narrator to deliver next. Be specific.' },
      targetTurn: { type: 'number', description: 'Optional rough target turn when this beat should land. Emit as a number.' },
    },
  },
};

const SEED_UPDATE_PROPS: Record<string, JSONSchema> = {
  id: { type: 'string', description: 'Existing stable seed ID from the seed list. Use it when titles repeat; omit for a new seed.' },
  title: { type: 'string', description: 'Seed title (must match existing for reinforce/resolve, or new for plant)' },
  action: { type: 'string', enum: [...SEED_ACTIONS] },
  scope: { type: 'string', enum: [...SCOPES] },
  relatedArcId: { type: 'string', description: "ID/title of related arc (use '' if none)" },
  description: {
    type: 'string',
    description:
      "REQUIRED when action is 'plant' or when the existing seed has no description. The seed's full meaning, question, expected payoff. NOT the horizon.",
  },
  payoffHorizon: { type: 'string', enum: [...HORIZONS], description: 'For plant: when this seed should pay off' },
  reinforcement: { type: 'string', description: "REQUIRED when action is 'reinforce'. How the seed was echoed this turn." },
  outcome: { type: 'string', description: "REQUIRED when action is 'resolve'. How the seed paid off." },
};

const HIDDEN_UPDATE_PROPS: Record<string, JSONSchema> = {
  title: { type: 'string' },
  arcId: { type: 'string' },
  action: { type: 'string', enum: [...HIDDEN_ACTIONS] },
  description: { type: 'string' },
  status: { type: 'string', enum: [...HIDDEN_STATUSES] },
  arcType: { type: 'string', enum: [...HIDDEN_ARC_TYPES] },
  horizon: { type: 'string', enum: [...HORIZONS] },
  scope: { type: 'string', enum: [...SCOPES] },
  surfaceCondition: { type: 'string' },
  newClue: { type: 'string' },
  newStageTitle: { type: 'string' },
  newStageDescription: { type: 'string' },
};

const ANALYSIS_PROPS: Record<string, JSONSchema> = {
  whatHappened: { type: 'string', description: '1-2 sentences: what actually happened this turn (the beats that landed in the prose).' },
  summary: { type: 'string', description: "Optional alternative phrasing if 'whatHappened' is too narrow." },
  seedsPlanted: { type: 'array', items: { type: 'string' }, description: 'New foreshadowing seeds the narrator dropped this turn.' },
  seedsPaidOff: { type: 'array', items: { type: 'string' }, description: 'Seeds whose payoff actually delivered this turn.' },
  unexpected: {
    type: 'array',
    items: { type: 'string' },
    description: "Developments you didn't plan for - moments the player or narrator surprised you.",
  },
  pacingAnalysis: {
    type: 'string',
    description: '1-2 sentences: current rhythm, whether the next turn wants action or quiet, what comes next.',
  },
  playerEnergy: { type: 'string', description: "Optional read on the player's engagement this turn." },
  intentions: {
    type: 'array',
    description: 'What you want to happen NEXT, with timeline. Each entry: { type, description, priority, targetTurn }.',
    items: {
      type: 'object',
      required: ['description'],
      properties: {
        type: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: [...INTENTION_PRIORITIES] },
        targetTurn: { type: 'string', enum: [...INTENTION_TARGETS] },
      },
    },
  },
  suggestedActions: { type: 'array', items: { type: 'string' }, description: "Quick action suggestions to surface in the player's UI." },
};

const CHAPTER_PROPS: Record<string, JSONSchema> = {
  action: {
    type: 'string',
    enum: [...CHAPTER_ACTIONS],
    description:
      'Choose start_new when no chapter exists or the story crossed a major boundary; update when the current chapter meaningfully evolved; otherwise none.',
  },
  title: {
    type: 'string',
    description: 'A concise title for the current or new chapter, without a Chapter N prefix. Required even for none.',
  },
  description: { type: 'string', description: 'The current or new chapter premise.' },
  status: { type: 'string', enum: [...CHAPTER_STATUSES], description: 'Updated status when action is update.' },
  themes: { type: 'array', items: { type: 'string' } },
  objectives: { type: 'array', items: { type: 'string' } },
  tone: { type: 'string' },
  closingMoment: {
    type: 'string',
    description: 'For update, how the current chapter should end; for start_new, how the previous chapter concluded.',
  },
};

const SECTION_TEXT = {
  directive: 'The narrator directive for this turn (mood, pacing, include/avoid, beats, callbacks, etc.). Set at least one field.',
  arcUpdates: 'Updates for visible story arcs. Include one entry per arc that meaningfully changed this turn; send [] if none changed.',
  seedUpdates:
    'Updates for narrative seeds - every pending seed needs an entry (plant/reinforce/resolve/delete). Send [] only when there are zero pending seeds AND nothing new to plant.',
  invisibleArcUpdates: 'Updates for invisible (shadow world) arcs. Send [] if no shadow arcs exist or changed this turn.',
  analysis:
    'Turn-level analysis: whatHappened, pacing read, intentions for upcoming turns, suggestedActions. All fields optional but provide as many as apply.',
  chapterUpdate:
    'The mandatory chapter-lifecycle decision for this turn. No current chapter means action=start_new. Existing chapters may use none, update, or start_new as warranted.',
} as const;

/** The listed properties of `props`, in that order; `over` replaces or extends single entries. */
function only(props: Record<string, JSONSchema>, keys: readonly string[], over: Record<string, JSONSchema> = {}): Record<string, JSONSchema> {
  return Object.fromEntries(keys.map((k) => [k, { ...props[k], ...over[k] }]));
}

/** The whole plan [§7.3, D-62]: the six sections of Bunraku's planning command, without the tool wrapper. */
export const PLAN_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['directive'],
  properties: {
    directive: { type: 'object', description: SECTION_TEXT.directive, properties: DIRECTIVE_PROPS },
    arcUpdates: { type: 'array', description: SECTION_TEXT.arcUpdates, items: { type: 'object', required: ['arcId'], properties: ARC_UPDATE_PROPS } },
    seedUpdates: {
      type: 'array',
      description: SECTION_TEXT.seedUpdates,
      items: { type: 'object', required: ['title', 'action', 'scope', 'relatedArcId'], properties: SEED_UPDATE_PROPS },
    },
    invisibleArcUpdates: {
      type: 'array',
      description: SECTION_TEXT.invisibleArcUpdates,
      items: { type: 'object', required: ['title', 'action'], properties: HIDDEN_UPDATE_PROPS },
    },
    analysis: { type: 'object', description: SECTION_TEXT.analysis, properties: ANALYSIS_PROPS },
    chapterUpdate: { type: 'object', description: SECTION_TEXT.chapterUpdate, required: ['action', 'title'], properties: CHAPTER_PROPS },
  },
};

/**
 * The lite plan [§7.3 "PLAN_SCHEMA_LITE", D-102]: a smaller answer for small windows, because the
 * Director's latency is mostly decoding. No include/avoid/dialogueGuidance, no shadow arcs.
 */
export const PLAN_SCHEMA_LITE: JSONSchema = {
  type: 'object',
  required: ['directive'],
  properties: {
    directive: {
      type: 'object',
      description: 'The narrator directive for this turn (mood, pacing, scene, beats, callbacks, etc.). Set at least one field.',
      properties: only(
        DIRECTIVE_PROPS,
        ['mood', 'pacing', 'sceneGuidance', 'endingHook', 'arcDirections', 'callbacks', 'characterBeats', 'narrativeGoal'],
        {
          arcDirections: { maxItems: READ_LIMITS.liteArcDirections },
          callbacks: { maxItems: READ_LIMITS.liteCallbacks },
          characterBeats: { maxItems: READ_LIMITS.liteCharacterBeats },
        },
      ),
    },
    arcUpdates: {
      type: 'array',
      description: SECTION_TEXT.arcUpdates,
      items: {
        type: 'object',
        required: ['arcId'],
        properties: only(ARC_UPDATE_PROPS, ['arcId', 'title', 'status', 'horizon', 'arcType', 'newStageTitle', 'markNextBeatDelivered', 'nextBeat'], {
          newStageTitle: { description: NEW_STAGE_TITLE },
        }),
      },
    },
    seedUpdates: {
      type: 'array',
      description: SECTION_TEXT.seedUpdates,
      items: {
        type: 'object',
        required: ['title', 'action'],
        properties: only(SEED_UPDATE_PROPS, ['id', 'title', 'action', 'description', 'payoffHorizon', 'outcome']),
      },
    },
    analysis: {
      type: 'object',
      description: 'Turn-level analysis: whatHappened and up to three intentions for upcoming turns.',
      properties: only(ANALYSIS_PROPS, ['whatHappened', 'intentions'], { intentions: { maxItems: READ_LIMITS.liteIntentions } }),
    },
    chapterUpdate: {
      type: 'object',
      description: SECTION_TEXT.chapterUpdate,
      required: ['action', 'title'],
      properties: only(CHAPTER_PROPS, ['action', 'title', 'description']),
    },
  },
};

// ---- reading helpers ----------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reading context: the skips (at most READ_LIMITS.skipped kept, the rest counted) and the profile. */
interface Cx {
  skips: Skip[];
  more: number;
  lite: boolean;
}

function skip(cx: Cx, path: string, why: string): void {
  if (cx.skips.length < READ_LIMITS.skipped) cx.skips.push({ path, why });
  else cx.more++;
}

const TEXT_MAX = STATE_LIMITS.text;
/** A key from the model in a skip path is cut to this. */
const PATH_KEY_MAX = 60;
/** A value from the model quoted in a skip reason is cut to this. */
const QUOTE_MAX = 40;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
/** A structural slot (object or list) holding one of these strings is absent. */
const NULLISH = /^(?:null|none|undefined)?$/i;

/** At most `max` UTF-16 units, never half a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

const quote = (s: string): string => JSON.stringify(cut(s, QUOTE_MAX));
const child = (path: string, key: string): string => (path === '' ? cut(key, PATH_KEY_MAX) : `${path}.${cut(key, PATH_KEY_MAX)}`);

/** The object without its undefined values. */
function define<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function unknownKeys(cx: Cx, rec: Rec, known: ReadonlySet<string>, path: string): void {
  for (const k of Object.keys(rec)) if (!known.has(k)) skip(cx, child(path, k), 'unknown key');
}

/** A trimmed, cut text; '' and null are absent; another type is skipped. */
function text(cx: Cx, v: unknown, path: string, max: number = TEXT_MAX): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    skip(cx, path, 'not a string');
    return undefined;
  }
  const t = v.trim();
  if (t === '') return undefined;
  if (t.length <= max) return t;
  skip(cx, path, `cut to ${max} chars`);
  return cut(t, max).trimEnd();
}

type Why = { why: string };
const isWhy = (x: unknown): x is Why => isRecord(x) && typeof x['why'] === 'string';

/** A text the element cannot do without: the text, or why the element is dropped. */
function needText(cx: Cx, rec: Rec, key: string, path: string, max: number = TEXT_MAX): string | Why {
  const v = rec[key];
  if (typeof v === 'string' && v.trim() !== '') return text(cx, v, child(path, key), max) as string;
  return { why: v === null || v === undefined || typeof v === 'string' ? `no ${key}` : `${key} is not a string` };
}

/** An enum value, case-fixed (and `X-term` → X for horizons): the value, why it is unusable, or null when absent. */
function enumValue<T extends string>(v: unknown, values: readonly T[], horizon = false): T | Why | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return { why: 'not a string' };
  let s = v.trim().toLowerCase();
  if (s === '') return null;
  if (horizon) s = s.replace(/[-_ ]term$/, '');
  return (values as readonly string[]).includes(s) ? (s as T) : { why: `unknown value ${quote(v)}` };
}

/** An optional enum field: an unusable value is dropped and skipped. */
function oneOf<T extends string>(cx: Cx, v: unknown, values: readonly T[], path: string, horizon = false): T | undefined {
  const r = enumValue(v, values, horizon);
  if (r === null) return undefined;
  if (isWhy(r)) {
    skip(cx, path, r.why);
    return undefined;
  }
  return r;
}

/** An enum field with a default: absent → the default silently, unusable → the default and a skip. */
function oneOfOr<T extends string>(cx: Cx, v: unknown, values: readonly T[], path: string, fallback: T): T {
  return oneOf(cx, v, values, path) ?? fallback;
}

/** A number from a number or a numeric string. */
function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && NUMERIC.test(v.trim())) return Number(v.trim());
  return undefined;
}

const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function tension(cx: Cx, v: unknown, path: string): number | undefined {
  if (blank(v)) return undefined;
  const n = numberOf(v);
  if (n === undefined) {
    skip(cx, path, typeof v === 'string' ? `not a number ${quote(v)}` : 'not a number');
    return undefined;
  }
  const c = Math.min(10, Math.max(0, n));
  if (c !== n) skip(cx, path, `clamped to ${c}`);
  return c;
}

/**
 * A turn number: a number or numeric string >= 0, rounded. It must be a safe integer [D-123]: 1e20 or
 * "123456789012345678901" would be stored and then refused by checkState (state.ts reads turns as
 * safe integers), so they are dropped and skipped like any other bad value. -0 reads as 0.
 */
function turnOf(cx: Cx, v: unknown, path: string): number | undefined {
  if (blank(v)) return undefined;
  const n = numberOf(v);
  const turn = n === undefined || n < 0 ? undefined : Math.abs(Math.round(n));
  if (turn === undefined || !Number.isSafeInteger(turn)) {
    skip(cx, path, typeof v === 'string' ? `not a turn number ${quote(v)}` : 'not a turn number');
    return undefined;
  }
  return turn;
}

/** Only `true` matters (Bunraku): true or "true" → true; false, "false" and absent → absent. */
function flag(cx: Cx, v: unknown, path: string): true | undefined {
  if (v === true) return true;
  if (v === false || blank(v)) return undefined;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return undefined;
  }
  skip(cx, path, 'not a boolean');
  return undefined;
}

/** An object slot: an object, or a string holding one (looseJson); null, '', "null", "none" → absent. */
function asObject(cx: Cx, v: unknown, path: string): Rec | undefined {
  if (v === null || v === undefined) return undefined;
  if (isRecord(v)) return v;
  if (typeof v === 'string') {
    if (NULLISH.test(v.trim())) return undefined;
    const r = looseJson(v.trim());
    if (r.ok && isRecord(r.value)) return r.value;
    skip(cx, path, 'a string that is not a JSON object');
    return undefined;
  }
  skip(cx, path, 'not an object');
  return undefined;
}

/** A list slot: a list, or a string holding one (looseJson); null, '', "null", "none" → absent. */
function asList(cx: Cx, v: unknown, path: string): unknown[] | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    if (NULLISH.test(v.trim())) return undefined;
    const r = looseJson(v.trim());
    if (r.ok && Array.isArray(r.value)) return r.value;
    skip(cx, path, 'a string that is not a JSON list');
    return undefined;
  }
  skip(cx, path, 'not a list');
  return undefined;
}

/**
 * Reads the elements of a list slot until `max` are kept; a null element is absent, a bad one is
 * skipped alone, the ones past the limit are counted in one skip.
 */
function each<T>(cx: Cx, raw: unknown, path: string, max: number, read: (item: unknown, path: string) => T | undefined): T[] {
  const list = asList(cx, raw, path);
  const out: T[] = [];
  if (list === undefined) return out;
  let over = 0;
  list.forEach((item, i) => {
    if (item === null || item === undefined) return;
    if (out.length >= max) {
      over++;
      return;
    }
    const v = read(item, `${path}[${i}]`);
    if (v !== undefined) out.push(v);
  });
  if (over > 0) skip(cx, path, `${over} over the limit of ${max}`);
  return out;
}

/** Elements that must be objects (a string holding one is decoded). */
function records<T>(cx: Cx, raw: unknown, path: string, max: number, read: (rec: Rec, path: string) => T | undefined): T[] {
  return each(cx, raw, path, max, (item, p) => {
    const rec = asObject(cx, item, p);
    return rec === undefined ? undefined : read(rec, p);
  });
}

/** A list of texts; a lone string that is not a JSON list is a one-item list. Empty → absent. */
function texts(cx: Cx, raw: unknown, path: string, max: number = READ_LIMITS.directiveList): string[] | undefined {
  const v = typeof raw === 'string' && !raw.trim().startsWith('[') && !NULLISH.test(raw.trim()) ? [raw] : raw;
  const out = each(cx, v, path, max, (item, p) => text(cx, item, p));
  return out.length > 0 ? out : undefined;
}

const keys = (...k: string[]): ReadonlySet<string> => new Set(k);

// ---- the directive ------------------------------------------------------------------------------

const DIRECTIVE_KEYS = new Set(Object.keys(DIRECTIVE_PROPS));
const INCLUDE_KEYS = ['characters', 'themes', 'sensoryDetails', 'foreshadowing'] as const;
const AVOID_KEYS = ['topics', 'characters', 'revelations'] as const;

/** include / avoid: named text lists; empty → absent. */
function group<K extends string>(cx: Cx, raw: unknown, path: string, names: readonly K[]): Partial<Record<K, string[]>> | undefined {
  const rec = asObject(cx, raw, path);
  if (rec === undefined) return undefined;
  unknownKeys(cx, rec, new Set(names), path);
  const out: Partial<Record<K, string[]>> = {};
  for (const k of names) {
    const list = texts(cx, rec[k], `${path}.${k}`);
    if (list !== undefined) out[k] = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const SCENE_KEYS = keys('setting', 'atmosphere', 'tension_level');
const DIALOGUE_KEYS = keys('character', 'tone', 'hints');
const ARC_DIRECTION_KEYS = keys('arcName', 'instruction', 'urgency');
const CALLBACK_KEYS = keys('reference', 'instruction');
const BEAT_KEYS = keys('character', 'beat', 'motivation');

/** Skips an element for the first missing required text; returns undefined for `return`. */
function dropped(cx: Cx, path: string, ...xs: (string | Why)[]): undefined {
  skip(cx, path, xs.find(isWhy)?.why ?? 'incomplete');
  return undefined;
}

function readSceneGuidance(cx: Cx, raw: unknown, path: string): NarratorDirective['sceneGuidance'] {
  const scene = asObject(cx, raw, path);
  if (scene === undefined) return undefined;
  unknownKeys(cx, scene, SCENE_KEYS, path);
  const s = define({
    setting: text(cx, scene['setting'], `${path}.setting`),
    atmosphere: text(cx, scene['atmosphere'], `${path}.atmosphere`),
    tension_level: tension(cx, scene['tension_level'], `${path}.tension_level`),
  });
  return Object.keys(s).length > 0 ? s : undefined;
}

/** The fields in schema order, so `skipped` follows the answer. */
function readDirective(cx: Cx, d: Rec): { directive: NarratorDirective; pacingSent: boolean } {
  const P = 'directive';
  const list = READ_LIMITS.directiveList;
  unknownKeys(cx, d, DIRECTIVE_KEYS, P);
  const mood = text(cx, d['mood'], `${P}.mood`);
  const pacing = oneOf(cx, d['pacing'], PACINGS, `${P}.pacing`);
  const include = group(cx, d['include'], `${P}.include`, INCLUDE_KEYS);
  const avoid = group(cx, d['avoid'], `${P}.avoid`, AVOID_KEYS);

  const dialogueGuidance = records(cx, d['dialogueGuidance'], `${P}.dialogueGuidance`, list, (g, p) => {
    unknownKeys(cx, g, DIALOGUE_KEYS, p);
    const character = needText(cx, g, 'character', p);
    const tone = needText(cx, g, 'tone', p);
    if (isWhy(character) || isWhy(tone)) return dropped(cx, p, character, tone);
    return define({ character, tone, hints: texts(cx, g['hints'], `${p}.hints`) });
  });

  const sceneGuidance = readSceneGuidance(cx, d['sceneGuidance'], `${P}.sceneGuidance`);
  const endingHook = text(cx, d['endingHook'], `${P}.endingHook`);

  const arcDirections = records(cx, d['arcDirections'], `${P}.arcDirections`, cx.lite ? READ_LIMITS.liteArcDirections : list, (a, p) => {
    unknownKeys(cx, a, ARC_DIRECTION_KEYS, p);
    const arcName = needText(cx, a, 'arcName', p);
    const instruction = needText(cx, a, 'instruction', p);
    if (isWhy(arcName) || isWhy(instruction)) return dropped(cx, p, arcName, instruction);
    // A missing or unknown urgency is 'moderate' (Bunraku); RoleCall's zod dropped the element.
    return { arcName, instruction, urgency: oneOfOr(cx, a['urgency'], URGENCIES, `${p}.urgency`, 'moderate') };
  });

  const callbacks = records(cx, d['callbacks'], `${P}.callbacks`, cx.lite ? READ_LIMITS.liteCallbacks : list, (c, p) => {
    unknownKeys(cx, c, CALLBACK_KEYS, p);
    const reference = needText(cx, c, 'reference', p);
    const instruction = needText(cx, c, 'instruction', p);
    if (isWhy(reference) || isWhy(instruction)) return dropped(cx, p, reference, instruction);
    return { reference, instruction };
  });

  const characterBeats = records(cx, d['characterBeats'], `${P}.characterBeats`, cx.lite ? READ_LIMITS.liteCharacterBeats : list, (b, p) => {
    unknownKeys(cx, b, BEAT_KEYS, p);
    const character = needText(cx, b, 'character', p);
    const beat = needText(cx, b, 'beat', p);
    if (isWhy(character) || isWhy(beat)) return dropped(cx, p, character, beat);
    return define({ character, beat, motivation: text(cx, b['motivation'], `${p}.motivation`) });
  });

  const directive: NarratorDirective = define({
    mood,
    pacing: pacing ?? 'medium',
    include,
    avoid,
    dialogueGuidance: dialogueGuidance.length > 0 ? dialogueGuidance : undefined,
    sceneGuidance,
    endingHook,
    arcDirections: arcDirections.length > 0 ? arcDirections : undefined,
    callbacks: callbacks.length > 0 ? callbacks : undefined,
    characterBeats: characterBeats.length > 0 ? characterBeats : undefined,
    narrativeGoal: text(cx, d['narrativeGoal'], `${P}.narrativeGoal`),
  });
  return { directive, pacingSent: pacing !== undefined };
}

/**
 * D-62 / D-107: does the directive tell the narrator anything? Any non-empty mood, narrativeGoal,
 * endingHook, arcDirections, characterBeats, callbacks, dialogueGuidance; include / avoid with a
 * non-empty list; sceneGuidance with a set field; `pacing` only when the model sent a valid value
 * (`pacingSent`) other than 'medium' (RoleCall's DirectiveBuilder counted an absent pacing and an
 * empty sceneGuidance too).
 */
export function hasDirectiveContent(d: NarratorDirective, pacingSent: boolean): boolean {
  const said = (s: string | undefined): boolean => s !== undefined && s.trim() !== '';
  const some = (l: readonly unknown[] | undefined): boolean => l !== undefined && l.length > 0;
  const lists = (g: Record<string, readonly string[] | undefined> | undefined): boolean =>
    g !== undefined && Object.values(g).some((l) => some(l?.filter(said)));
  const sg = d.sceneGuidance;
  return (
    (pacingSent && (PACINGS as readonly string[]).includes(d.pacing) && d.pacing !== 'medium') ||
    said(d.mood) ||
    said(d.narrativeGoal) ||
    said(d.endingHook) ||
    some(d.arcDirections) ||
    some(d.characterBeats) ||
    some(d.callbacks) ||
    some(d.dialogueGuidance) ||
    lists(d.include) ||
    lists(d.avoid) ||
    (sg !== undefined && (said(sg.setting) || said(sg.atmosphere) || (typeof sg.tension_level === 'number' && Number.isFinite(sg.tension_level))))
  );
}

// ---- the other sections -------------------------------------------------------------------------

const ARC_KEYS = new Set([...Object.keys(ARC_UPDATE_PROPS), 'id']);

function readArc(cx: Cx, u: Rec, p: string): PlanningArcUpdate | undefined {
  unknownKeys(cx, u, ARC_KEYS, p);
  const title = text(cx, u['title'], `${p}.title`, STATE_LIMITS.arcTitle);
  // The match key: arcId ?? id ?? title, the first one that is not empty [D-107].
  const arcId = text(cx, u['arcId'], `${p}.arcId`) ?? text(cx, u['id'], `${p}.id`) ?? title;
  if (arcId === undefined) return void skip(cx, p, 'no arcId, id or title');
  return define({
    arcId,
    title,
    description: text(cx, u['description'], `${p}.description`),
    status: oneOf(cx, u['status'], ARC_STATUSES, `${p}.status`),
    horizon: oneOf(cx, u['horizon'], HORIZONS, `${p}.horizon`, true),
    priority: oneOf(cx, u['priority'], ARC_PRIORITIES, `${p}.priority`),
    arcType: oneOf(cx, u['arcType'], ARC_TYPES, `${p}.arcType`),
    newStageTitle: text(cx, u['newStageTitle'], `${p}.newStageTitle`),
    newStageDescription: text(cx, u['newStageDescription'], `${p}.newStageDescription`),
    markNextBeatDelivered: flag(cx, u['markNextBeatDelivered'], `${p}.markNextBeatDelivered`),
    nextBeat: readNextBeat(cx, u['nextBeat'], `${p}.nextBeat`),
  });
}

const NEXT_BEAT_KEYS = keys('description', 'targetTurn');

/** A next beat; a plain string (not JSON) is its description. */
function readNextBeat(cx: Cx, v: unknown, path: string): PlanningArcUpdate['nextBeat'] {
  if (typeof v === 'string' && !v.trim().startsWith('{')) {
    if (NULLISH.test(v.trim())) return undefined;
    const description = text(cx, v, `${path}.description`);
    return description === undefined ? undefined : { description };
  }
  const rec = asObject(cx, v, path);
  if (rec === undefined) return undefined;
  unknownKeys(cx, rec, NEXT_BEAT_KEYS, path);
  const description = needText(cx, rec, 'description', path);
  if (isWhy(description)) return void skip(cx, path, description.why);
  return define({ description, targetTurn: turnOf(cx, rec['targetTurn'], `${path}.targetTurn`) });
}

const SEED_KEYS = new Set(Object.keys(SEED_UPDATE_PROPS));

function readSeed(cx: Cx, u: Rec, p: string): PlanningSeedUpdate | undefined {
  unknownKeys(cx, u, SEED_KEYS, p);
  const title = needText(cx, u, 'title', p);
  if (isWhy(title)) return void skip(cx, p, title.why);
  // A seed with no valid action is skipped [D-107]; Bunraku made it 'reinforce', so a plant was lost.
  const action = enumValue(u['action'], SEED_ACTIONS);
  if (action === null) return void skip(cx, p, 'no action');
  if (isWhy(action)) return void skip(cx, p, `action: ${action.why}`);
  return define({
    id: text(cx, u['id'], `${p}.id`),
    title,
    action,
    scope: oneOf(cx, u['scope'], SCOPES, `${p}.scope`),
    relatedArcId: text(cx, u['relatedArcId'], `${p}.relatedArcId`),
    description: text(cx, u['description'], `${p}.description`),
    payoffHorizon: oneOf(cx, u['payoffHorizon'], HORIZONS, `${p}.payoffHorizon`, true),
    reinforcement: text(cx, u['reinforcement'], `${p}.reinforcement`),
    outcome: text(cx, u['outcome'], `${p}.outcome`),
  });
}

const HIDDEN_KEYS = new Set([...Object.keys(HIDDEN_UPDATE_PROPS), 'id']);

function readHidden(cx: Cx, u: Rec, p: string): PlanningInvisibleArcUpdate | undefined {
  unknownKeys(cx, u, HIDDEN_KEYS, p);
  const title = needText(cx, u, 'title', p, STATE_LIMITS.arcTitle);
  if (isWhy(title)) return void skip(cx, p, title.why);
  const action = enumValue(u['action'], HIDDEN_ACTIONS);
  if (action === null) return void skip(cx, p, 'no action');
  if (isWhy(action)) return void skip(cx, p, `action: ${action.why}`);
  return define({
    title,
    action,
    arcId: text(cx, u['arcId'], `${p}.arcId`) ?? text(cx, u['id'], `${p}.id`),
    description: text(cx, u['description'], `${p}.description`),
    status: oneOf(cx, u['status'], HIDDEN_STATUSES, `${p}.status`),
    arcType: oneOf(cx, u['arcType'], HIDDEN_ARC_TYPES, `${p}.arcType`),
    horizon: oneOf(cx, u['horizon'], HORIZONS, `${p}.horizon`, true),
    scope: oneOf(cx, u['scope'], SCOPES, `${p}.scope`),
    surfaceCondition: text(cx, u['surfaceCondition'], `${p}.surfaceCondition`),
    newClue: text(cx, u['newClue'], `${p}.newClue`),
    newStageTitle: text(cx, u['newStageTitle'], `${p}.newStageTitle`),
    newStageDescription: text(cx, u['newStageDescription'], `${p}.newStageDescription`),
  });
}

/** The defaults of an intention's missing fields (Bunraku apply.ts:89). */
const INTENTION_DEFAULTS = { type: 'advance_arc', priority: 'should', targetTurn: 'next' } as const;

const INTENTION_KEYS = keys('type', 'description', 'priority', 'targetTurn');

/** Intentions in the order sent; a string item is the description of one. */
function readIntentions(cx: Cx, raw: unknown, path: string): DirectorIntention[] {
  const max = cx.lite ? READ_LIMITS.liteIntentions : READ_LIMITS.intentionsRead;
  const v = typeof raw === 'string' && !raw.trim().startsWith('[') && !NULLISH.test(raw.trim()) ? [raw] : raw;
  return each(cx, v, path, max, (item, p): DirectorIntention | undefined => {
    if (typeof item === 'string' && !item.trim().startsWith('{')) {
      const description = text(cx, item, p);
      return description === undefined ? undefined : { ...INTENTION_DEFAULTS, description };
    }
    const rec = asObject(cx, item, p);
    if (rec === undefined) return undefined;
    unknownKeys(cx, rec, INTENTION_KEYS, p);
    const description = needText(cx, rec, 'description', p);
    if (isWhy(description)) return void skip(cx, p, description.why);
    return {
      type: text(cx, rec['type'], `${p}.type`) ?? INTENTION_DEFAULTS.type,
      description,
      priority: oneOfOr(cx, rec['priority'], INTENTION_PRIORITIES, `${p}.priority`, INTENTION_DEFAULTS.priority),
      targetTurn: oneOfOr(cx, rec['targetTurn'], INTENTION_TARGETS, `${p}.targetTurn`, INTENTION_DEFAULTS.targetTurn),
    };
  });
}

const ANALYSIS_KEYS = new Set(Object.keys(ANALYSIS_PROPS));

function readAnalysis(cx: Cx, raw: unknown): PlanningAnalysis {
  const P = 'analysis';
  if (typeof raw === 'string' && !raw.trim().startsWith('{')) {
    // Models sometimes send the analysis as a bare string: it is the account of what happened
    // (a JSON-quoted string is decoded first).
    const t = raw.trim();
    if (NULLISH.test(t)) return {};
    const q = t.startsWith('"') ? looseJson(t) : undefined;
    const prose = q?.ok === true && typeof q.value === 'string' ? q.value : t;
    return define({ whatHappened: text(cx, prose, `${P}.whatHappened`) });
  }
  const a = asObject(cx, raw, P);
  if (a === undefined) return {};
  unknownKeys(cx, a, ANALYSIS_KEYS, P);
  const intentions = readIntentions(cx, a['intentions'], `${P}.intentions`);
  return define({
    whatHappened: text(cx, a['whatHappened'], `${P}.whatHappened`),
    summary: text(cx, a['summary'], `${P}.summary`),
    seedsPlanted: texts(cx, a['seedsPlanted'], `${P}.seedsPlanted`),
    seedsPaidOff: texts(cx, a['seedsPaidOff'], `${P}.seedsPaidOff`),
    unexpected: texts(cx, a['unexpected'], `${P}.unexpected`),
    pacingAnalysis: text(cx, a['pacingAnalysis'], `${P}.pacingAnalysis`),
    playerEnergy: text(cx, a['playerEnergy'], `${P}.playerEnergy`),
    intentions: intentions.length > 0 ? intentions : undefined,
    suggestedActions: texts(cx, a['suggestedActions'], `${P}.suggestedActions`),
  });
}

const CHAPTER_KEYS = new Set(Object.keys(CHAPTER_PROPS));

function readChapter(cx: Cx, raw: unknown): PlanningChapterUpdate {
  const P = 'chapterUpdate';
  const c = asObject(cx, raw, P);
  if (c === undefined) return { action: 'none', title: '' };
  unknownKeys(cx, c, CHAPTER_KEYS, P);
  return define({
    action: oneOfOr(cx, c['action'], CHAPTER_ACTIONS, `${P}.action`, 'none'),
    title: text(cx, c['title'], `${P}.title`) ?? '',
    description: text(cx, c['description'], `${P}.description`),
    status: oneOf(cx, c['status'], CHAPTER_STATUSES, `${P}.status`),
    themes: texts(cx, c['themes'], `${P}.themes`),
    objectives: texts(cx, c['objectives'], `${P}.objectives`),
    tone: text(cx, c['tone'], `${P}.tone`),
    closingMoment: text(cx, c['closingMoment'], `${P}.closingMoment`),
  });
}

// ---- readPlan -----------------------------------------------------------------------------------

const ROOT_KEYS = new Set(Object.keys(PLAN_SCHEMA['properties'] as Rec));
/** Skips named in a missing_directive message (structuredCall cuts the message at 200). */
const MESSAGE_SKIPS = 4;

/** Why the directive was refused, with the first few skips (e.g. VVS-130's keys) as a hint. */
function refusal(head: string, skips: readonly Skip[]): string {
  if (skips.length === 0) return head;
  const shown = skips.slice(0, MESSAGE_SKIPS).map((s) => `${s.path.replace(/^directive\./, '')}: ${s.why}`);
  return `${head} (${shown.join('; ')}${skips.length > MESSAGE_SKIPS ? '; …' : ''})`;
}

/**
 * Reads one decoded plan [D-107]. Fails only when the root is not an object (`invalid`) or the
 * directive is absent, not an object or without content (`missing_directive`); anything else that is
 * dropped or changed is listed in `skipped` (≤ READ_LIMITS.skipped entries, then `+N more`). Never
 * throws. `lite` caps the directive lists and the intentions at the lite schema's sizes; the shape
 * read is the same.
 */
export function readPlan(raw: unknown, opts: { lite: boolean }): ReadResult<PlanningRound> {
  if (!isRecord(raw)) return { ok: false, code: 'invalid', message: 'the plan is not a JSON object' };
  const cx: Cx = { skips: [], more: 0, lite: opts.lite };
  unknownKeys(cx, raw, ROOT_KEYS, '');

  const seen = (): number => cx.skips.length + cx.more;
  const before = seen();
  const d = asObject(cx, raw['directive'], 'directive');
  if (d === undefined) {
    const head = seen() > before ? 'the directive is not a JSON object' : 'the plan has no directive';
    return { ok: false, code: 'missing_directive', message: refusal(head, cx.skips) };
  }
  const { directive, pacingSent } = readDirective(cx, d);
  if (!hasDirectiveContent(directive, pacingSent)) {
    return { ok: false, code: 'missing_directive', message: refusal('the directive sets no usable field', cx.skips) };
  }

  const sections = READ_LIMITS.sectionEntries;
  const value: PlanningRound = {
    directive,
    arcUpdates: records(cx, raw['arcUpdates'], 'arcUpdates', sections, (u, p) => readArc(cx, u, p)),
    seedUpdates: records(cx, raw['seedUpdates'], 'seedUpdates', sections, (u, p) => readSeed(cx, u, p)),
    invisibleArcUpdates: records(cx, raw['invisibleArcUpdates'], 'invisibleArcUpdates', sections, (u, p) => readHidden(cx, u, p)),
    analysis: readAnalysis(cx, raw['analysis']),
    chapterUpdate: readChapter(cx, raw['chapterUpdate']),
  };
  const skipped = cx.more > 0 ? [...cx.skips, { path: 'skipped', why: `+${cx.more} more` }] : cx.skips;
  return { ok: true, value, skipped };
}
