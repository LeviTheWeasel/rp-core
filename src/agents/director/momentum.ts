// Ported from Bunraku:src/core/director/momentum.ts and Bunraku:src/core/director/directive.ts
// (enrichFromMomentum)@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi: the momentum engine, its
// report and pressure texts, the enrichment; the texts are RoleCall's dm-stream/momentum-engine.ts and
// DirectiveBuilder.ts enrichDirectiveFromMomentum, Coneja-Chibi).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Director's momentum (ARCHITECTURE.md §7.3 "Импульс", D-63; .notes/m4-decisions.md A.2, A.3,
// D-109): a deterministic pass over the state before the call. It finds the arcs that are stale or
// overdue, the seeds ripe for payoff, stalled planting, the hidden arcs due to surface and the story's
// rhythm. The report goes into the user prompt (formatMomentumReport), the pressures follow as their
// own user message (planningPressures), and after the call enrichFromMomentum puts what the planner
// left out into the directive, so the pressure reaches the narrator even when the planner forgets.
//
// Port notes. Kept: RoleCall's thresholds, the report and pressure texts and their order, ten entries
// per list, the sort orders. Changed: every number lives in MOMENTUM; ages are derived
// (turn − plantedAtTurn / createdAtTurn), never counters; ForcedArcAction.turnsActive is
// turnsSinceProgress = turn − (lastProgressTurn ?? createdAtTurn) (A.2, D-117: an arc with no progress
// turn ages from its creation; Bunraku's grace rule `?? turn` never let it go stale); a hidden arc is
// due at createdAtTurn + SURFACE_TURNS[horizon]; planting reads lastPlantTurn, which survives the
// eviction of paid seeds; the rhythm signals are derived from state.pacing with moodKinds (Bunraku
// stored them after each turn, matching whole mood strings); `commit_planning_round.X` → `X` and
// "a" → "an" (A.3); a lite report has no shadow section (D-102); enrich matches names by whole words
// only (D-117): a run of word stems after foldText (inflected Russian), or the item's id — Bunraku's
// substring compare is gone ("Art" is not named by "The Party"); it compares with the planner's own
// entries only, stays within READ_LIMITS.directiveList and returns a new object. Dropped: tensionOf /
// tensionPeaks (nothing writes involvedCharacters).

import { foldText, stemKeyMatches, wordsOf } from '../../text/normalize.ts';
import { moodKinds } from './mood.ts';
import {
  CHAPTER_TURNS,
  READ_LIMITS,
  SURFACE_TURNS,
  type DirectorArc,
  type DirectorState,
  type ForcedArcAction,
  type MomentumReport,
  type NarratorDirective,
  type PlantingPressure,
  type RipeSeed,
  type ShadowOpportunity,
  type StaleArc,
} from './types.ts';

/** Every momentum threshold, in turns unless noted (RoleCall's balanced values, D-63). */
export const MOMENTUM = {
  /** Turns without progress after which an arc past seeding must be acted on ("horizon x 3"). */
  horizonLimits: { immediate: 2, short: 9, medium: 15, long: 30, epic: 75 },
  /** Turns without progress after which any live arc is stale. */
  arcStale: 15,
  /** Ripe: age ≥ `age` with ≥ `reinforcements`; OVERDUE when age > `overdueAge`. */
  seedRipe: { age: 30, reinforcements: 2, overdueAge: 60 },
  /** Turns since the last plant for each planting severity. */
  planting: { moderate: 12, high: 20, critical: 35 },
  /**
   * Age at which a hidden arc is due even before its surface turn. Kept for parity only: the surface
   * turn createdAtTurn + SURFACE_TURNS[horizon] always comes first (D-63 note).
   */
  invisibleSurface: { immediate: 2, short: 6, medium: 12, long: 25, epic: 60 },
  /** Turns past due for a shadow opportunity's urgency. */
  shadowUrgency: { high: 10, medium: 4 },
  /** Stale arcs or ripe seeds that make "multiple storylines need attention". */
  overallPace: { staleArcs: 3, ripeSeeds: 2 },
  /** quiet: a quiet scene more than N turns ago; tension: action more than N ago; climax: N turns in a tense mood. */
  rhythm: { quiet: 8, tension: 12, climax: 4 },
  /**
   * The chapter hints of the user prompt: wrap up from `wrap` × target, look for start_new from the
   * target, OVERDUE from the maximum, never start_new while younger than `justStarted`.
   */
  chapter: { wrap: 0.7, startNew: CHAPTER_TURNS.target, overdue: CHAPTER_TURNS.maximum, justStarted: 10 },
  /** The arc hints of the user prompt (Bunraku user-prompt.ts arcHints). */
  arcHints: { minActive: 2, minActiveAfterTurn: 5, maxStagesSingle: 5, characterArcAfter: 8, sideArcAfter: 10 },
  /** Entries per list in the report and the pressures; the most overdue come first. */
  listMax: 10,
} as const;

const L = MOMENTUM.listMax;

// ---- computeMomentum --------------------------------------------------------------------------------

/** The momentum of `state` for the Director turn `turn` (state.turn + 1). Pure. */
export function computeMomentum(state: DirectorState, turn: number): MomentumReport {
  const staleArcs: StaleArc[] = [];
  const forcedActions: ForcedArcAction[] = [];
  for (const arc of state.arcs) {
    if (arc.status === 'complete' || arc.status === 'abandoned') continue;
    // A.2 / D-117: an arc with no progress turn ages from its creation (Bunraku's `?? turn` never aged it).
    const since = turn - (arc.lastProgressTurn ?? arc.createdAtTurn);
    if (since >= MOMENTUM.arcStale) {
      staleArcs.push({ id: arc.id, name: arc.title, status: arc.status, turnsSinceProgress: since, suggestedAction: staleAction(arc, since) });
    }
    // Seeding arcs are allowed to simmer.
    if (arc.status === 'seeding') continue;
    const limit: number = MOMENTUM.horizonLimits[arc.horizon] ?? MOMENTUM.horizonLimits.medium;
    if (since >= limit) {
      forcedActions.push({
        id: arc.id,
        name: arc.title,
        status: arc.status,
        horizon: arc.horizon,
        turnsSinceProgress: since,
        horizonLimit: limit,
        overdueBy: since - limit,
      });
    }
  }
  staleArcs.sort((a, b) => b.turnsSinceProgress - a.turnsSinceProgress);
  forcedActions.sort((a, b) => b.overdueBy - a.overdueBy);

  const ripe = MOMENTUM.seedRipe;
  const ripeSeeds: RipeSeed[] = state.seeds
    .filter((s) => !s.payoffDelivered && turn - s.plantedAtTurn >= ripe.age && s.reinforcements.length >= ripe.reinforcements)
    .map((s) => {
      const age = turn - s.plantedAtTurn;
      return {
        id: s.id,
        name: s.hint,
        turnsPlanted: age,
        reinforcements: s.reinforcements.length,
        payoff: s.payoff,
        suggestedAction:
          age > ripe.overdueAge
            ? 'OVERDUE - this seed has been waiting far too long. Deliver the payoff soon or it will feel forgotten.'
            : 'Ready for payoff. Look for a natural moment to deliver the reveal.',
      };
    })
    .sort((a, b) => b.turnsPlanted - a.turnsPlanted);

  const plantingPressure = plantingOf(state, turn);
  const shadowOpportunities = shadowOf(state, turn);
  const rhythm = rhythmOf(state, turn);
  const pacingRecommendation = pacingOf(staleArcs.length, ripeSeeds.length, rhythm);

  const parts: string[] = [];
  if (forcedActions.length > 0) parts.push(`${forcedActions.length} arc(s) MUST be resolved/advanced this turn`);
  if (staleArcs.length > 0) parts.push(`${staleArcs.length} stale arc(s) need attention`);
  if (ripeSeeds.length > 0) parts.push(`${ripeSeeds.length} seed(s) ripe for payoff`);
  if (plantingPressure.active) parts.push(`planting pressure: ${plantingPressure.severity}`);
  if (shadowOpportunities.length > 0) parts.push(`${shadowOpportunities.length} shadow item(s) ready to surface`);
  const summary = parts.length > 0 ? `${parts.join('; ')}. ${pacingRecommendation}` : `All arcs progressing normally. ${pacingRecommendation}`;
  return { staleArcs, ripeSeeds, forcedActions, shadowOpportunities, plantingPressure, rhythm, pacingRecommendation, summary };
}

function staleAction(arc: DirectorArc, since: number): string {
  switch (arc.status) {
    case 'seeding':
      return 'Time to escalate this arc from setup to active development.';
    case 'building':
      return 'This arc has been building too long - push toward a turning point or complication.';
    case 'climax':
      return 'Climax has stalled - deliver the payoff or force a resolution.';
    default:
      return `Force progression - ${since} turns is too long without movement.`;
  }
}

/** Planting pressure from the last plant: lastPlantTurn, else (or if later) the newest seed's plantedAtTurn. */
function plantingOf(state: DirectorState, turn: number): PlantingPressure {
  const pendingCount = state.seeds.filter((s) => !s.payoffDelivered).length;
  let last = state.lastPlantTurn;
  for (const s of state.seeds) if (last === undefined || s.plantedAtTurn > last) last = s.plantedAtTurn;
  const turnsSinceLastPlant = last === undefined ? turn : Math.max(0, turn - last);
  const on = (severity: 'moderate' | 'high' | 'critical', reason: string, suggestedAction: string): PlantingPressure => ({
    active: true,
    severity,
    pendingCount,
    turnsSinceLastPlant,
    reason,
    suggestedAction,
  });
  const P = MOMENTUM.planting;
  if (last === undefined) {
    return on(
      'critical',
      'No seeds have ever been planted in this chat. The foreshadowing/payoff machinery is inert.',
      'PLANT NOW. Include at least one action:"plant" entry in seedUpdates this turn. Think ahead: what could the narrator mention in passing this scene that pays off 30+ turns from now? A character quirk, an overheard rumor, a strange symbol, an NPC\'s odd behavior - anything that sets up a future reveal.',
    );
  }
  if (turnsSinceLastPlant >= P.critical) {
    return on(
      'critical',
      `Last new seed was planted ${turnsSinceLastPlant} turns ago. The plant-early/pay-off-later loop has stopped producing.`,
      'PLANT NOW. Include at least one action:"plant" entry in seedUpdates this turn. You\'ve been letting the seed system rot. Without new seeds, the ripe-seed machinery has nothing to surface later.',
    );
  }
  if (turnsSinceLastPlant >= P.high) {
    return on(
      'high',
      `Last new seed was planted ${turnsSinceLastPlant} turns ago. Planting has stalled.`,
      'Include at least one action:"plant" entry in seedUpdates this turn. What could the narrator mention in passing that pays off later? A rumor, a character quirk, a strange detail - anything that seeds a future reveal.',
    );
  }
  if (turnsSinceLastPlant >= P.moderate) {
    return on(
      'moderate',
      `Last new seed was planted ${turnsSinceLastPlant} turns ago.`,
      "Consider planting a new seed this turn. The plant-early/pay-off-later pattern works best with steady planting rhythm - don't let the hopper go empty.",
    );
  }
  return {
    active: false,
    severity: 'none',
    pendingCount,
    turnsSinceLastPlant,
    reason: `Last plant was ${turnsSinceLastPlant} turns ago. Planting rhythm healthy.`,
    suggestedAction: '',
  };
}

const SHADOW_ACTIONS = {
  seeding:
    'Plant the first breadcrumb - have an NPC drop a rumor or the environment show a trace. Add a newClue in invisibleArcUpdates or weave it into the directive as a callback.',
  building:
    'Escalate the clues - have the player notice a pattern, or let an NPC reference the underlying truth obliquely. Consider action "surface" in invisibleArcUpdates if the player has enough clues to start connecting dots.',
  approaching_player:
    'SURFACE NOW. This arc should break into the visible story this scene. Use action "surface" in invisibleArcUpdates and write a directive that introduces the player to it.',
} as const;

const URGENCY_RANK = { high: 3, medium: 2, low: 1 } as const;

/** Hidden arcs due to surface: past their surface turn, or (never first, D-63) old enough for their horizon. */
function shadowOf(state: DirectorState, turn: number): ShadowOpportunity[] {
  const out: ShadowOpportunity[] = [];
  for (const arc of state.invisibleArcs) {
    if (arc.status === 'visible' || arc.status === 'resolved') continue;
    const age = turn - arc.createdAtTurn;
    const threshold: number = MOMENTUM.invisibleSurface[arc.horizon] ?? MOMENTUM.invisibleSurface.medium;
    const expected = arc.createdAtTurn + (SURFACE_TURNS[arc.horizon] ?? SURFACE_TURNS.medium);
    const reached = turn >= expected;
    if (!reached && age < threshold) continue;
    const turnsRipe = reached ? Math.max(0, turn - expected) : age - threshold;
    const U = MOMENTUM.shadowUrgency;
    out.push({
      id: arc.id,
      title: arc.title,
      summary: head(arc.description, 140) || arc.title,
      reason: reached
        ? `Expected surface turn (${expected}) reached ${turnsRipe} turns ago`
        : `Active for ${age} turns (threshold for ${arc.horizon} horizon: ${threshold})`,
      turnsRipe,
      urgency: turnsRipe >= U.high ? 'high' : turnsRipe >= U.medium ? 'medium' : 'low',
      suggestedAction: SHADOW_ACTIONS[arc.status],
    });
  }
  return out.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || b.turnsRipe - a.turnsRipe);
}

/**
 * The rhythm signals at `turn`, from the counters reduce keeps (D-109). Bunraku's guards stay: no
 * breather is asked for before any action, no tension before any quiet scene.
 */
function rhythmOf(state: DirectorState, turn: number): MomentumReport['rhythm'] {
  const { currentMood, turnsAtCurrentMood, rhythm } = state.pacing;
  const R = MOMENTUM.rhythm;
  return {
    needsQuietMoment: rhythm.lastActionSequence > 0 && turn - rhythm.lastQuietMoment > R.quiet,
    needsTension: rhythm.lastQuietMoment > 0 && turn - rhythm.lastActionSequence > R.tension,
    readyForClimax: turnsAtCurrentMood >= R.climax && moodKinds(currentMood).has('tense'),
  };
}

function pacingOf(stale: number, ripe: number, r: MomentumReport['rhythm']): string {
  if (stale >= MOMENTUM.overallPace.staleArcs || ripe >= MOMENTUM.overallPace.ripeSeeds) {
    return 'Multiple storylines need attention. Prioritize the most stale arc and deliver at least one seed payoff this scene.';
  }
  if (r.needsQuietMoment) {
    return 'The story needs a breather. Use this scene for character development, but weave in a subtle callback or seed reinforcement.';
  }
  if (r.needsTension) return 'Tension is low. Push an arc forward or surface a hidden complication to build momentum.';
  if (r.readyForClimax) return "The story is primed for a climax. If any arc is at 'building' status, consider pushing it to its turning point.";
  if (stale > 0) return 'One or more arcs need progression. Weave advancement into the natural flow of the scene.';
  return 'Pacing is healthy. Continue the current rhythm.';
}

/** The first `n` UTF-16 units of `text`, never ending inside a surrogate pair. */
function head(text: string, n: number): string {
  if (text.length <= n) return text;
  const c = text.charCodeAt(n - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

// ---- what the planner is told ---------------------------------------------------------------------

export interface MomentumTextOptions {
  /** The lite profile (D-102): no shadow-world section, no hidden-arc pressures. */
  lite?: boolean;
}

/** The momentum section of the planner's user prompt (RoleCall formatMomentumReport). */
export function formatMomentumReport(report: MomentumReport, opts: MomentumTextOptions = {}): string {
  const shadow = opts.lite ? [] : report.shadowOpportunities;
  const count = report.staleArcs.length + report.ripeSeeds.length + report.forcedActions.length + shadow.length;
  if (count === 0 && !report.plantingPressure.active) {
    return `[MOMENTUM REPORT]\n${report.pacingRecommendation}\nAll storylines progressing normally - no forced escalation needed.`;
  }
  const out: string[] = ['[MOMENTUM REPORT]'];
  if (report.forcedActions.length > 0) {
    out.push(
      'MANDATORY ARC ACTIONS THIS TURN - NON-NEGOTIABLE:',
      'The following arcs have exceeded their horizon x 3 turn budget.',
      'You MUST include an arcUpdates entry for each one with either:',
      '  - status: "complete" or "abandoned" (if the arc has played out)',
      '  - a meaningful newStageTitle and newStageDescription that advance the arc toward its climax/resolution',
      'Do NOT skip, defer, or leave these for a later turn. They are overdue.',
      '',
    );
    for (const a of report.forcedActions.slice(0, L)) {
      out.push(
        `  [${a.id}] "${a.name}" (${a.status}, ${a.horizon} horizon) - ${a.turnsSinceProgress} turns without progress (${a.overdueBy} past limit of ${a.horizonLimit}). RESOLVE OR ADVANCE.`,
      );
    }
    out.push('');
  }
  if (report.staleArcs.length > 0) {
    out.push('STALE ARCS (need progression):');
    for (const a of report.staleArcs.slice(0, L)) {
      out.push(`  "${a.name}" (${a.status}) - ${a.turnsSinceProgress} turns since last progress. ${a.suggestedAction}`);
    }
  }
  if (report.ripeSeeds.length > 0) {
    out.push('RIPE SEEDS (ready for payoff):');
    for (const s of report.ripeSeeds.slice(0, L)) {
      out.push(`  "${s.name}" - planted ${s.turnsPlanted} turns ago, reinforced ${s.reinforcements}x. Payoff: ${s.payoff}. ${s.suggestedAction}`);
    }
  }
  const p = report.plantingPressure;
  if (p.active) {
    out.push('', `SEED PLANTING PRESSURE (${p.severity.toUpperCase()}):`, `  ${p.reason}`, `  Pending seeds currently tracked: ${p.pendingCount}`, `  -> ${p.suggestedAction}`);
    if (p.severity === 'critical') out.push('  This is a CRITICAL pressure - planting a seed this turn is NOT optional.');
  }
  if (shadow.length > 0) {
    out.push(
      '',
      'SURFACE-READY SHADOW WORLD (hidden arcs ready to bleed into the visible story):',
      'You have been writing invisible arcs. Some are ripe to touch the visible narrative now. For each one below, either:',
      '  (a) set its action to "surface" in invisibleArcUpdates',
      "  (b) OR weave a clue/reference into this turn's directive as an arcDirection or callback",
      '  (c) OR add a newClue to it this turn',
      '',
    );
    for (const o of shadow.slice(0, L)) {
      out.push(`  [INVISIBLE ARC] "${o.title}" (${o.urgency}, ripe ${o.turnsRipe}t)`, `     Summary: ${o.summary}`, `     Why ripe: ${o.reason}`, `     -> ${o.suggestedAction}`);
    }
  }
  out.push(`\nPacing: ${report.pacingRecommendation}`);
  return out.join('\n');
}

/**
 * The pressure message sent after the user prompt (RoleCall buildMomentumPressures): forced arc
 * resolutions, a nextBeat for every live arc without a pending one, and seed planting; '' when none.
 * Bunraku's pressures name no hidden arc, so `lite` gives the same text today; it is taken so the
 * caller passes the profile to both texts alike.
 */
export function planningPressures(state: DirectorState, report: MomentumReport, _opts: MomentumTextOptions = {}): string {
  const sections: string[] = [];
  if (report.forcedActions.length > 0) {
    const list = report.forcedActions
      .slice(0, L)
      .map(
        (a) =>
          `  - [${a.id}] "${a.name}" (currently ${a.status}, ${a.horizon} horizon, ${a.turnsSinceProgress} turns without progress, ${a.overdueBy} past limit)`,
      )
      .join('\n');
    sections.push(
      `MANDATORY ARC RESOLUTIONS - THIS TURN IS NOT OPTIONAL:\nThe following arcs have exceeded their horizon x 3 turn budget and MUST be acted upon in this turn's arcUpdates:\n\n${list}\n\nFor EACH arc above, your arcUpdates entry MUST include ONE of:\n  (a) status: "complete" - arc has played out, mark done\n  (b) status: "abandoned" - arc has lost relevance, drop it\n  (c) newStageTitle + newStageDescription - meaningful stage transition advancing toward climax/resolution\n\nDo NOT skip these. Do NOT leave them for a later turn. Do NOT add a pointless label to pretend you acted on them. If an arc has been sitting for this long, the story no longer needs it OR it needs a real turning point - pick one.`,
    );
  }
  const needing = state.arcs.filter(
    (a) => a.status !== 'complete' && a.status !== 'abandoned' && (!a.nextBeat || a.nextBeat.status === 'delivered' || a.nextBeat.status === 'abandoned'),
  );
  if (needing.length > 0) {
    const list = needing
      .slice(0, L)
      .map((a) => {
        const why = !a.nextBeat
          ? 'no nextBeat set'
          : a.nextBeat.status === 'delivered'
            ? `previous beat delivered on turn ${a.nextBeat.deliveredAtTurn ?? '?'}, needs new plan`
            : 'previous beat abandoned, needs new plan';
        return `  - [${a.id}] "${a.title}" (${a.status}) - ${why}`;
      })
      .join('\n');
    sections.push(
      `MANDATORY: SET A FORWARD-LOOKING nextBeat FOR THESE ARCS THIS TURN:\n${list}\n\nFor each arc above, include an arcUpdates entry with a new nextBeat:\n  { "arcId": "<id>", "nextBeat": { "description": "<specific, prescriptive beat>", "targetTurn": <optional> } }\n\nA good nextBeat describes an OBSERVABLE event or staged opportunity the narrator can deliver, not an emotional state. "Valen drops a small slip - mentions a place name from his claimed backstory" is good. "Valen becomes suspicious" is not. Be specific.\n\nArcs without a nextBeat drift. Arcs with a delivered-but-not-replaced beat go to sleep. Neither is acceptable - set a plan.`,
    );
  }
  const p = report.plantingPressure;
  if (p.active) {
    const header = p.severity === 'critical' ? 'SEED PLANTING IS MANDATORY THIS TURN - NOT OPTIONAL:' : `SEED PLANTING PRESSURE (${p.severity.toUpperCase()}):`;
    sections.push(
      `${header}\n${p.reason}\n\nYou MUST include at least one entry in seedUpdates this turn with action:"plant". Think ahead: what detail could the narrator mention in passing this scene that sets up a future reveal 20-100 turns from now? A rumor, an NPC quirk, an overheard snippet, a strange symbol, an odd behavior, an off-hand remark. The plant-early/pay-off-later philosophy only works if you plant. Creating arcs is easy; committing to future seed payoffs requires planning.\n\nPlant format for seedUpdates:\n  { "action": "plant", "title": "<short seed hint, 3-8 words>", "description": "<what this sets up>", "scope": "player"|"world", "relatedArcId": "<arc id or empty string>", "payoffHorizon": "short"|"medium"|"long"|"epic" }`,
    );
  }
  return sections.join('\n\n');
}

// ---- enrichFromMomentum -----------------------------------------------------------------------------

/** A name for comparison: folded (foldText), trimmed, inner whitespace collapsed. */
const fold = (s: string): string => foldText(s).trim().replace(/\s+/gu, ' ');

/**
 * True when `written` (the planner's arcName or reference) already names the item `name` / `id`, by
 * whole words only (D-117): the folded names are equal, or one's word stems run inside the other's
 * ("тайна запертой комнаты" names "Запертая комната"; a CJK name, written without spaces, as a
 * folded substring), or it is the item's id ("arc-3", "[arc-3]"). A substring inside a word does not
 * count ("Art" is not named by "The Party"). An empty name names nothing (RoleCall's empty arcName
 * silenced every addition).
 */
function names(written: string, name: string, id: string): boolean {
  const w = fold(written);
  const n = fold(name);
  if (w === '' || n === '') return false;
  if (w === n || w.replace(/^\[(.*)\]$/u, '$1') === id) return true;
  return stemKeyMatches(n, wordsOf(w), w) || stemKeyMatches(w, wordsOf(n), n);
}

/**
 * The directive with a forceful arcDirection for each forced arc and a callback for each ripe seed
 * that the planner's own entries do not name yet, most overdue first, each list kept within
 * READ_LIMITS.directiveList (the planner's entries are never dropped). Pure: returns a new object and
 * never changes its inputs.
 */
export function enrichFromMomentum(directive: NarratorDirective, report: MomentumReport): NarratorDirective {
  const out: NarratorDirective = { ...directive };
  const max = READ_LIMITS.directiveList;

  const plannedArcs = directive.arcDirections ?? [];
  const arcDirections = [...plannedArcs];
  for (const f of report.forcedActions) {
    if (arcDirections.length >= max) break;
    if (fold(f.name) === '' || plannedArcs.some((d) => names(d.arcName, f.name, f.id))) continue;
    arcDirections.push({
      arcName: f.name,
      urgency: 'forceful',
      instruction: `This arc is OVERDUE (${f.turnsSinceProgress} turns without progression, ${f.overdueBy} past the limit). Deliver a turning point that pushes it toward climax/resolution this scene, OR write a beat that brings it to a natural close. Do not leave it to drift another turn - the audience can feel arcs that have stalled.`,
    });
  }
  if (arcDirections.length > plannedArcs.length) out.arcDirections = arcDirections;

  const plannedCallbacks = directive.callbacks ?? [];
  const callbacks = [...plannedCallbacks];
  for (const s of report.ripeSeeds) {
    if (callbacks.length >= max) break;
    if (fold(s.name) === '' || plannedCallbacks.some((c) => names(c.reference, s.name, s.id))) continue;
    callbacks.push({
      reference: s.name,
      instruction: `RIPE SEED - echo this in prose this scene. A passing reference, an environmental cue, an NPC line, or a small detail that quietly reinforces it. Planted ${s.turnsPlanted} turns ago, reinforced ${s.reinforcements}x - it's ready to land.`,
    });
  }
  if (callbacks.length > plannedCallbacks.length) out.callbacks = callbacks;
  return out;
}
