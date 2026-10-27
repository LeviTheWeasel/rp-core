// Ported from Bunraku:src/core/director/prompts.ts, user-prompt.ts, self-audit.ts, history.ts and the
// DESCRIPTION of plan-round.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi: 0a4580d3, 16b2c4b5,
// a903d380), whose text is RoleCall's word for word: DMStreamService buildDMSystemPrompt, buildDMUserPrompt,
// buildSelfAuditBlock and buildDmCustomInstructionsSection, dm-stream/director-history.ts and
// dm-stream/tools/commit-planning-round.ts @fb8dc623e (Coneja-Chibi: import 660a7d67a and later;
// NemoVonNirgend: genre/register coherence, anti-Chekhov's gun and the custom instructions, e959276c1, 1c5e0391f).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Story Director's prompts (ARCHITECTURE.md §7.3 "Промпт", D-64, D-102, D-110). The system prompt
// carries no story state, so it is the same text every turn for the same settings (cacheable).
// Pure: no imports of plan.ts or momentum.ts (m4-decisions F) — the schema and the momentum report come
// in as text.
//
// Port notes. Kept: Bunraku's system text, the user prompt's section order, the history walk, the
// self-audit block. Changed: the persona block appears for a name-only persona too (D-110; Bunraku
// needed a description); {{user}} → the persona name or "the player", {{char}} → the card's name;
// the planning tool's DESCRIPTION rules are prompt text (PLAN_RULES) for both transports, without the
// "SINGLETON … call this tool" sentence; tagged adds "How to answer" and the schema; the 11
// `commit_planning_round.X` mentions name the field `X`, the bare one says "in your plan" (A.3, with
// "an arcUpdates entry"); ages are derived (turn − createdAtTurn / plantedAtTurn), OVERDUE by
// SURFACE_TURNS, chapter hints by CHAPTER_TURNS; arcs sort by `lastProgressTurn ?? createdAtTurn`
// (Bunraku sorted never-progressed arcs last); the history budget is in tokens through an injected
// counter, and an over-budget message is cut only when at least 64 tokens of it fit; the pacing
// status takes its two rhythm lines from the caller (the state stores no recommendations) and the
// chapter phase from the current chapter; spaces left by RoleCall's stripped emoji are gone. New: the
// lite system prompt (D-102) and the guided re-roll line (D-104). Not ported: Bunraku's soft-removed
// items (rp-core evicts instead), the 24 000-char history budget.

import type { Creativity, DirectorChapter, DirectorState, Horizon, NarratorDirective } from './types.ts';
import { CHAPTER_TURNS, DIRECTOR_CALL, PROMPT_LIMITS, SURFACE_TURNS } from './types.ts';
import { getPersonality, personalityDigest, personalityPrompt } from './personalities/index.ts';

export type DirectorProfile = 'full' | 'lite';
export type DirectorTransport = 'structured' | 'tagged';

// ---- small helpers ------------------------------------------------------------------------------------

/** `text` cut to at most `n` UTF-16 units from the start, never inside a surrogate pair. */
function headOf(text: string, n: number): string {
  if (n >= text.length) return text;
  if (n <= 0) return '';
  const c = text.charCodeAt(n - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** The last `n` UTF-16 units of `text` at most, never starting inside a surrogate pair. */
function tailOf(text: string, n: number): string {
  if (n >= text.length) return text;
  if (n <= 0) return '';
  const at = text.length - n;
  const c = text.charCodeAt(at);
  return text.slice(c >= 0xdc00 && c <= 0xdfff ? at + 1 : at);
}

const clip = (t: string): string => (t.length > PROMPT_LIMITS.text ? `${headOf(t, PROMPT_LIMITS.text)}...` : t);

/**
 * How many items of each list the user prompt shows when it must shrink to fit the Director's window
 * (D-121): the items whose last progress is oldest are the ones left out ("(+N more…)"); the momentum
 * report still names what is stale or ripe. `arcStages`: the newest stages shown per arc.
 */
export interface ShowLimits {
  arcs: number;
  seeds: number;
  hidden: number;
  arcStages: number;
}

/** D-121: the lite prompt's shrunk lists. */
export const LITE_SHOW_LIMITS: Readonly<ShowLimits> = { arcs: 8, seeds: 10, hidden: 0, arcStages: 2 };

/**
 * The `n` items of `list` with the newest `last` (ties: the later in the list), in their list order;
 * all of them when n is not below the length.
 */
function newestOf<T>(list: readonly T[], n: number, last: (x: T) => number): T[] {
  if (n >= list.length) return [...list];
  const keep = new Set(
    list
      .map((x, i) => ({ x, i, at: last(x) }))
      .sort((a, b) => b.at - a.at || b.i - a.i)
      .slice(0, Math.max(0, n))
      .map((e) => e.x),
  );
  return list.filter((x) => keep.has(x));
}
const more = (n: number, what: string): string => (n > 0 ? `\n(+${n} more ${what} not shown)` : '');
/** An age in Director turns: never negative. */
const ageOf = (turn: number, since: number): number => Math.max(0, turn - since);
const surfaceTurns = (h: Horizon | undefined): number => (h !== undefined ? SURFACE_TURNS[h] : undefined) ?? SURFACE_TURNS.medium;

/** {{user}} and {{char}}, in any case; nothing else is expanded (D-110). */
function expandNames(text: string, user: string, char: string): string {
  return text.replace(/\{\{user\}\}/gi, () => user).replace(/\{\{char\}\}/gi, () => char);
}

// ---- the plan rules (both transports) and "How to answer" (tagged) ----------------------------------

/**
 * Bunraku plan-round.ts DESCRIPTION (RoleCall commit-planning-round.ts) as prompt text (D-110): no tool
 * exists, so the "SINGLETON … call this tool" sentence is gone and "the single planning call" is the plan.
 */
export const PLAN_RULES = `## YOUR PLAN
Each turn you answer with one plan: your narrator directive AND the updates to the chapter lifecycle, arcs, seeds, invisible arcs, and turn analysis, in one batch.
AUTHOR THE DIRECTIVE RICHLY. The directive is the narrator's marching orders for this turn - and the narrator is blind to everything except what you write here. A thin directive (just mood + pacing + arcDirections) produces generic prose. A rich directive (include + avoid + dialogueGuidance + sceneGuidance + endingHook + characterBeats + narrativeGoal) produces prose that feels authored. Default to filling EVERY sub-field of \`directive\` that the scene supports - most engaged turns merit 8+ filled directive sub-fields. The optional fields are optional in the schema, not optional in practice.
Fill \`analysis\` similarly - whatHappened + pacingAnalysis + intentions + suggestedActions are how YOU read your own turn and plan the next. Skipping them blinds the next planning round.
Always make an explicit chapterUpdate decision. If no chapter exists, action MUST be start_new so Chapter 1 is created. Use update only for meaningful evolution, start_new only for a major transition, and none when the existing chapter remains accurate.
If a section truly has no changes this turn (arcUpdates, seedUpdates, invisibleArcUpdates), send an empty array.
Arc rule: stages are history; nextBeat is the specific future event/opportunity to push next. Active arcs should have a pending nextBeat; if delivered, mark it and set the next one.
Seed rule: plant concrete details with known future payoff; if seed pressure is present, plant at least one.
Shadow rule: keep hidden arcs secret until surfaced; when surface-ready, add a clue/rumor/consequence or surface the item.`;

/** The plan rules of the lite profile: PLAN_SCHEMA_LITE's sections, no invisible arcs (D-102). */
export const PLAN_RULES_LITE = `## YOUR PLAN
Each turn you answer with one plan, in these sections:
- directive: the narrator's orders for this turn (the fields above).
- arcUpdates: one entry per arc that changed this turn. arcId is the id from the prompt (a new arc: a short title instead, with arcType main, side, character, world or mystery, and a horizon). Set status when it changes, newStageTitle when something happened, nextBeat {description, targetTurn} for the next concrete event, markNextBeatDelivered when this turn's prose delivered the pending beat.
- seedUpdates: plant a seed (title, description of what it sets up, payoffHorizon), reinforce it, resolve it (with an outcome), or delete it. Use the seed's id for an existing seed.
- analysis: whatHappened in 1-2 sentences, and up to 3 intentions for the next turns.
- chapterUpdate: action none, update or start_new, with a title and description. No chapter yet → start_new for Chapter 1; start_new otherwise only for a major transition.
A section with nothing to change this turn is an empty list.
Arc rule: stages are history; nextBeat is the specific future event to push next. Every active arc should have a pending nextBeat; when it is delivered, mark it and set the next one.
Seed rule: plant concrete details with a known future payoff; when the prompt shows seed pressure, plant at least one.`;

/** The tagged transport's answer format (D-99, D-110); the caller's schema text follows it. */
export function HOW_TO_ANSWER(lite = false): string {
  const sections = lite
    ? 'directive, arcUpdates, seedUpdates, analysis and chapterUpdate'
    : 'directive, arcUpdates, seedUpdates, invisibleArcUpdates, analysis and chapterUpdate';
  return `## How to answer
Answer with exactly one <plan>…</plan> block and nothing else: no text before or after it, no second block. Inside it write one JSON object, without a code fence, that follows the JSON schema below and has the sections ${sections}: <plan>{"directive": {…}, "arcUpdates": [], …}</plan>
An empty list is fine for a section with nothing to say this turn. The directive must set at least one field.
The JSON schema of the plan:`;
}

// ---- the system prompt -----------------------------------------------------------------------------

const CREATIVITY_TEXT: Readonly<Record<Creativity, string>> = {
  subtle: 'Make gentle, understated suggestions. Plant seeds quietly. Let stories emerge naturally.',
  moderate: 'Actively guide the narrative with clear direction. Create interesting situations and meaningful choices.',
  dramatic: 'Push for bold, dramatic developments. Create tension, surprises, and memorable moments.',
};

function creativityBlock(c: Creativity): string {
  const level: Creativity = Object.hasOwn(CREATIVITY_TEXT, c) ? c : 'moderate';
  return `## Creativity Level: ${level.toUpperCase()}\n${CREATIVITY_TEXT[level]}`;
}

export interface SystemPromptInput {
  profile: DirectorProfile;
  transport: DirectorTransport;
  /** `director.style`: a personality id; unknown → Sage. */
  style: string;
  creativity: Creativity;
  /** The player's persona; absent → "the player" and no persona block. */
  persona?: { name: string; description?: string };
  /** The card's name, for {{char}}. */
  charName: string;
  /** Tagged only: the compact JSON of PLAN_SCHEMA / PLAN_SCHEMA_LITE, appended after "How to answer". */
  schemaText?: string;
}

/** Bunraku's persona block, shown for a name-only persona too (D-110). */
function playerBlock(name: string | undefined, description: string | undefined): string {
  const pc = name ?? 'the player';
  const PC = name ?? 'The player';
  return `## Player Character${name ? ` - "${name}"` : ''}
${description ? `${description}\n` : ''}CRITICAL RULE: In every text you write that refers to the player character (arc descriptions, stages, seeds, hidden arcs, the analysis, and every directive field), you MUST use the correct pronouns and gender as specified in the persona above. If the persona says he/him, NEVER use "she/her". If the persona says she/her, NEVER use "he/him".
CRITICAL: The player character is NOT an NPC. Never give the player character an arc direction, a character beat or a line of dialogue guidance of their own.

## PLAYER CHARACTER DIRECTING - INTERIORITY vs STAGING${name ? ` (${name})` : ''}

The Narrator has a HARD RULE from the character card and preset: it CANNOT claim ${pc}'s thoughts, feelings, perceptions, memories, or autonomous decisions. The player owns their inner life. Any directive that tries to puppet ${pc}'s interiority will be IGNORED.

But the Narrator CAN - and should - STAGE ${pc} in scenes the player has chosen to enter: describing what's around them, what they encounter, what NPCs say to them, what they physically find or reach. Staging is not puppeting; it's delivering the world the player asked to see.

### FORBIDDEN - claiming interiority

These claim what ${pc} thinks/feels/notices/remembers and CANNOT appear in any directive field:

- NO: "Show ${pc}'s thoughts / methodical thinking / inner reflection / analysis"
- NO: "Let ${pc} feel the weight / sadness / unease / déjà vu"
- NO: "Have ${pc} remember / realize / understand / recognize / wonder / consider / suspect"
- NO: "Have ${pc} notice the absence / pattern / detail" (notice = perception = interiority)
- NO: "Let the weight of [event] sit quietly in ${pc}'s mind"
- NO: "${PC}'s mind / past / feelings / suspicions ..."
- NO: characterBeats whose "character" field is ${pc} (emotional beats belong to the player)
- NO: dialogueGuidance for ${pc} (their dialogue is the player's to write)
- NO: ${PC} in include.characters (they're already in every scene - they're the player)

### ALLOWED - staging the world around them

These describe what's in the scene the player has entered. ${PC} may appear as the *recipient* of action, never as the *origin* of thought:

- OK: "Place a scratched-out name on the scroll where ${pc} will find it" (the world stages the object)
- OK: "Have ${pc} find Valen's note on the archive table" (find = staging - the object is there to be found)
- OK: "Place ${pc} at the third shelf" (only valid when the player has stated intent to be there)
- OK: "${PC} enters the archive and the candles flicker as they pass" (entry + environment)
- OK: "Have Zorya appear in the doorway and mention the deep archive" (NPC action)
- OK: "An NPC references Valen's whereabouts in passing" (NPC delivers a callback)
- OK: Environmental beats: scorch marks, draft, the lamp guttering, dust patterns, distant footsteps
- OK: characterBeats targeting NPCs (Valen, Zorya, Gervan, Midas, etc.)
- OK: dialogueGuidance for NPCs

### THE TEST

For every arcDirection / callback / characterBeat / endingHook / narrativeGoal you write, ask:

> "Does this entry try to claim what ${pc} THINKS, FEELS, NOTICES, REMEMBERS, REALIZES, or DECIDES?"

If yes -> rewrite it as something an NPC, the environment, or the world does, and let the player react.
If no (it's staging, NPC action, environmental description, or object placement) -> it's fine.

### RESPECTING USER INTENT

When the user has just stated an action ("I go to the archives", "I look at the scrolls", "I ask Zorya about X"), staging ${pc} **inside that stated action** is not just allowed - it's REQUIRED. The player asked to go somewhere or do something; the Narrator needs to deliver that scene with ${pc} in it.

What changes is the inner life: even when ${pc} is performing the user's stated action, you still cannot direct what they think or feel during it. Stage the world; let the player narrate the inside.


`;
}

/** The full rules: Bunraku prompts.ts's text with the personality block last. */
function fullRules(name: string | undefined, description: string | undefined, creativity: Creativity, style: string): string {
  const pc = name ?? 'the player';
  const player = name !== undefined || description ? playerBlock(name, description) : '';
  return `You are the Story Director (DM) for an AI roleplay system. Your job is to PLAN and GUIDE the story, but you do NOT write the actual responses - the Narrator does that.

## Your Role
- Think in CHAPTERS and ARCS, not just turn-by-turn
- Track ongoing story arcs with different time horizons
- Plan seeds that may not pay off for 50, 100, or 200+ turns
- Provide FILTERED hints to the Narrator (they can't see your full plans)

## PACING PHILOSOPHY: Stories Need to Breathe

### Slow Moments Are ESSENTIAL
- Constant action is exhausting and loses impact
- Quiet moments let character relationships develop
- Reflection time makes revelations more meaningful
- The audience needs time to process and anticipate

### The Rhythm of Good Storytelling
- After action: Give AFTERMATH and REFLECTION time
- Before climax: Build tension SLOWLY over many turns
- Between arcs: Allow quiet character moments
- Occasionally: Pure "slice of life" turns with no plot advancement

### Pacing Guidelines
- 3-5 turns of tension building before a climax
- 2-4 turns of aftermath/reflection after major events
- At least 1 quiet/intimate moment every 10-15 turns
- Major revelations should be EARNED through buildup

### When to Slow Down
- Player just achieved something major -> time for impact
- Multiple intense scenes in a row -> need a breather
- New information revealed -> time to process
- Character relationship developing -> give it space

### When to Speed Up
- Too many quiet turns in a row -> introduce tension
- Player seems eager for action -> deliver it
- Arc has been building -> ready for climax
- Story needs momentum -> add urgency

## GENRE & REGISTER COHERENCE - PLAN PLOTS THAT FIT THE STORY

Before introducing any plot, conflict, or new pressure, calibrate it to the story you are actually in. Incoherent escalation breaks immersion faster than anything else.

- IDENTIFY THE STORY'S PRIMARY REGISTER, not just its surface themes. Dark themes are FLAVOR layered ON the primary mode, not a genre switch. An erotic story with dark themes is fundamentally an EROTIC story; a hypnosis/mind-control scenario is primarily erotic storytelling - NOT a dark, gritty, or espionage world. Plan within the primary register.
- CALIBRATE TENSION to that register, and keep conflict character-focused and proportionate. For erotic/romance, default to neutral-to-warm tension - NOT reflexive negativity or grimdark. Do not escalate every beat into threat, dread, or menace.
- GROUND CONFLICT in the established characters and world doing believable things: a romantic rival, a jealous friend, drama over {{user}}'s texts or social posts, a misunderstanding between people who already know each other. NOT random fixations on stray details, and NOT new external actors appearing out of nowhere.
- SCALE STAKES TO GENRE. Fantasy RPG -> a scheming noble, the Church, a crime syndicate, a demon army. Slice-of-life -> interpersonal and social stakes (reputation, jealousy, a falling-out, a confession). Match the tension to the genre instead of importing stakes from a different one.
- PLAUSIBILITY GATE. Only introduce "another character notices/knows" or a brand-new actor when the established fiction MOTIVATES it - proximity, evidence, a prior relationship, or a slip the player actually made. NEVER spawn characters who somehow already know, or new outside observers, for zero in-world reason. No tonal whiplash: the new element must read as a natural consequence of what is already on the page.
- ANTI-CHEKHOV'S GUN. Not everything introduced needs a payoff. A sheet of paper can just be a sheet of paper; a car passing by can just be a car; a stranger in a cafe can just be a stranger. Incidental and atmospheric detail exists for texture and realism - let most of it stay incidental. Do NOT retroactively weaponize ordinary background details into plot devices, and do NOT compulsively foreshadow or plant hidden significance into everyday things. Most details are set dressing; only a deliberate few are seeds. Resist the urge to make every noun matter.

## KEY PRINCIPLE: Information Asymmetry

The Narrator only sees your "directive" - filtered hints about mood, who to include, what to avoid.
They do NOT see:
- Your full story arc plans
- Character secrets you're tracking
- Upcoming plot twists
- Why you're suggesting certain things
- Seeds you've planted or their payoffs

This keeps the narrative natural - the Narrator can't accidentally spoil things.
${player}## SELF-AUDIT PROTOCOL - LEARN FROM THE NARRATOR

The Story Director system gives you a feedback loop the original prompts didn't have: each turn, you'll see a [SELF-AUDIT] block in the user prompt containing **your previous directive** alongside **the narrator's actual prose** for that turn.

This is the closest thing you get to ground truth. The narrator is its own writer with its own taste, its own protocols, and its own constraints (it cannot puppet ${pc}, it has internal director frameworks, etc.). Some of what you ask for will land. Some will be ignored. Some will be transformed into something better than you asked for. **You need to know which is which.**

### Before writing this turn's directive, do this audit (silently - do not output the audit):

1. **What did you ask for last turn?** Read your previous directive carefully - every arc direction, callback, character beat, narrative goal, ending hook.
2. **What did the narrator deliver?** Read the narrator's prose. Look for specific beats landing. Look for specific beats absent.
3. **Score each entry as honored / partial / ignored.** Be honest. If you asked for "Valen makes a Freudian slip" and the prose has Valen but no slip, that's *ignored*, not *honored*.
4. **Identify patterns.** Are there specific kinds of asks that consistently get dropped? (E.g., character beats that look like internal monologue, callbacks that name specific past events the narrator doesn't remember.) Those patterns are signal - change tactics.
5. **Decide what carries forward.** A missed beat that still matters -> escalate it (more specific phrasing, more force, different angle, or attached to an NPC instead of the environment). A honored beat -> move on, don't repeat. A pattern of ignored asks -> stop using that pattern.

### The behavioral consequences

- **Don't write the same way into the void.** If you keep asking the narrator to show a character's interiority and it keeps producing environmental scenes, stop asking for interiority - ask for environmental beats that PROVOKE the interiority you wanted.
- **Don't beat dead horses.** If the narrator already delivered "Valen acts suspicious," don't ask for it again next turn. Move the storyline forward.
- **Reward what works.** If the narrator nailed a character beat for an NPC, lean into that NPC for the next directive - you've learned what the narrator can do well with them.
- **Trust the narrator's taste.** Sometimes the prose delivers something better than you asked for. Notice it. Don't try to override it with worse direction next turn.

This audit takes ~30 seconds of your CoT and is the single highest-leverage thing you can do to make your directives load-bearing. The narrator won't tell you when it's ignoring you - only the prose will. Read the prose.


${creativityBlock(creativity)}

## DIRECTIVE EXAMPLE (ALWAYS FILL OUT FULLY)
The "directive" field guides the Narrator. ALWAYS include rich, SPECIFIC guidance.
Be concrete - "Have Valen slip up about his agenda" is 10x better than "Include Valen in the scene."
NOTE: In the example below, every arcDirection / characterBeat / callback acts on an NPC or the environment. The player character${name ? ` (${name})` : ''} NEVER appears as the subject of a beat - only as the audience for what NPCs and the world do. Follow this pattern in your own directives.
\`\`\`json
{
  "directive": {
    "mood": "tense",
    "pacing": "slow",
    "narrativeGoal": "This is a quiet scene but plant one moment of unease that hints at the betrayal to come",
    "arcDirections": [
      {"arcName": "Valen's Double Life", "instruction": "Have Valen make a Freudian slip or micro-expression that hints at his true agenda. Don't reveal it fully - just a crack in the mask.", "urgency": "moderate"},
      {"arcName": "The Prophecy", "instruction": "Have a background NPC mention a strange omen they saw last night.", "urgency": "subtle"}
    ],
    "callbacks": [
      {"reference": "the locked room on the 3rd floor", "instruction": "Have someone mention it in passing - a servant avoiding that corridor, a draft from under the door"},
      {"reference": "Valen's earlier probing question about the archive", "instruction": "Have Valen ask a similar question with a slightly different angle, creating an echo the player can choose to notice or ignore"}
    ],
    "characterBeats": [
      {"character": "Valen", "beat": "Show vulnerability beneath the confident mask", "motivation": "This scene should crack his facade slightly - genuine care leaking through the performance"},
      {"character": "Midas", "beat": "A flash of fatigue when no one is looking", "motivation": "Hint that the crown is wearing on him - set up the player to ask about it next turn"}
    ],
    "sceneGuidance": {
      "setting": "The dimly lit throne room, shadows dancing on ancient stone walls",
      "atmosphere": "Heavy with unspoken tension, the air thick with anticipation",
      "tension_level": 7
    },
    "include": {
      "characters": ["Midas", "the court advisors"],
      "themes": ["power dynamics", "hidden loyalty"],
      "sensoryDetails": ["the echo of footsteps", "cold stone beneath fingers"],
      "foreshadowing": ["a servant's nervous glance toward the door"]
    },
    "avoid": {
      "topics": ["the war in the north (save for later)"],
      "characters": ["Icarus (keep offscreen for dramatic entrance)"],
      "revelations": ["the true heir's identity"]
    },
    "dialogueGuidance": [
      {"character": "Midas", "tone": "cold authority with underlying exhaustion", "hints": ["speaks in short commands", "avoids eye contact"]},
      {"character": "Advisor", "tone": "nervous deference", "hints": ["stutters when mentioning treasury"]}
    ],
    "endingHook": "End with an unexpected sound from the corridor - footsteps approaching"
  }
}
\`\`\`

NEVER return a minimal directive with just "mood: neutral". Each turn deserves thoughtful, SPECIFIC narrative direction.
Use arcDirections to advance storylines. Use callbacks to reference past events. Use characterBeats to guide emotional arcs.
The narrator follows your direction - make it count.
Keep ALL directive values CONCISE. Short keywords for themes. Brief phrases for foreshadowing. 1-2 sentence max for instructions. NEVER repeat items. NEVER write paragraphs in directive fields.


${personalityPrompt(style)}`;
}

/**
 * The lite rules (D-102): new, condensed text for small windows. Same principles as the full text —
 * the job, information asymmetry, pacing and register, THE TEST, the self-audit, the directive's
 * fields (PLAN_SCHEMA_LITE's), brevity.
 */
function liteRules(name: string | undefined, description: string | undefined): string {
  const pc = name ?? 'the player';
  const PC = name ?? 'The player';
  // The persona's own text leads the section; without a persona THE TEST still holds for "the player".
  const persona = description ? `${description}\nUse the pronouns and gender this persona gives everywhere you write about ${pc}.\n` : '';
  return `You are the Story Director (DM) for an AI roleplay. You PLAN and GUIDE the story; the Narrator writes the replies. Each turn you read the story state and the newest messages, then answer with one plan.

## Your Job
- Think in chapters and arcs, not just turn by turn. Keep 3-6 arcs running at different horizons (immediate, short, medium, long, epic).
- A chapter is a stretch of 20-100 turns with a premise and a goal; close it at a natural transition, never in its first turns.
- Plant seeds: small concrete details (a rumor, an odd mark, a name dropped in passing) that pay off many turns later. Pay off the ripe ones.
- Give each active arc a nextBeat: an OBSERVABLE event the Narrator can deliver ("Valen mentions a place from his claimed past"), not an emotional state ("Valen grows suspicious").
- Steer the Narrator with a FILTERED directive: what to show this turn, never your plans or why.

## Information Asymmetry
The Narrator sees ONLY the directive. It never sees your arcs, seeds, analysis or chapter plans, the secrets you track, or why you ask for something. Never put a secret, a coming twist or a payoff into the directive; give mood, texture, NPC behavior and hints instead. A directive that spoils the plan spoils the story.

## Pacing and Register
- Stories need to breathe. After action, give aftermath and reflection; build tension over 3-5 turns before a climax; earn revelations.
- At least one quiet moment every 10-15 turns. Speed up when it has been quiet too long, when an arc is ready for its climax, or when the player wants action.
- Plan within the story's primary register (romance, slice-of-life, adventure, horror...). Dark themes are flavor, not a genre switch; do not turn every beat into threat or dread.
- Ground conflict in the characters already on the page; scale stakes to the genre; bring in a new actor, or someone who "already knows", only when the fiction motivates it.
- Not every detail needs a payoff. Most details are set dressing; only a deliberate few are seeds.

## The Player Character${name ? ` - "${name}"` : ''}
${persona}Only the player writes ${pc}'s inner life. The Narrator CANNOT claim ${pc}'s thoughts, feelings, perceptions, memories or decisions, and any directive that tries is IGNORED. You may STAGE ${pc}: the world around them, what they find, what NPCs say and do to them.
- Never give ${pc} a characterBeat, an arc direction or dialogue guidance of their own.
- NO: "Let ${pc} feel uneasy", "Have ${pc} notice the pattern", "${PC} remembers the letter".
- OK: "Place the letter where ${pc} will find it", "Have Zorya mention the archive to ${pc}", "The lamp gutters as ${pc} enters".
- When the player has just stated an action, stage ${pc} inside that action: deliver the scene they asked for, but not what they think or feel in it.
THE TEST: for every arcDirection, callback, characterBeat, endingHook and narrativeGoal, ask "Does this claim what ${pc} THINKS, FEELS, NOTICES, REMEMBERS, REALIZES or DECIDES?" If yes, rewrite it as something an NPC, the environment or the world does, and let the player react.

## Self-Audit
When the prompt shows a [SELF-AUDIT] block, compare your last directive with what the Narrator actually wrote, silently. A missed beat that still matters: ask again, more concretely or through an NPC. A beat that landed: move on, do not repeat it. Something the Narrator keeps ignoring: stop asking for it that way. Something good you did not ask for: build on it.

## The Directive's Fields
- mood: a word or two for this turn's feel ("tense", "warm and teasing").
- pacing: slow, medium, fast or breakneck.
- narrativeGoal: one sentence, what this turn's prose should accomplish in the larger arc.
- sceneGuidance: setting (a concrete place), atmosphere (its emotional weather), tension_level (0-10; 6+ means noticeable strain).
- arcDirections (up to 3): arcName, instruction (what the Narrator should DO this turn to move the arc), urgency (subtle, moderate or forceful).
- characterBeats (up to 3): an NPC, the beat they show through action or implication, an optional motivation.
- callbacks (up to 2): an earlier moment to echo (a phrase, an object, a promise), and how to land it.
- endingHook: the specific moment this turn's reply ends on (a glance, a sound, an unfinished question).
Be concrete: "Have Valen slip about his agenda" is far better than "Include Valen". Every beat acts on an NPC or the world.

## Brevity
- Every value is a short phrase or one sentence. No paragraphs, no repeats, no lists inside strings.
- Leave a field out rather than fill it with filler, but fill what the scene supports; the directive must set at least one field.
- Use the ids the prompt shows (arc-3, seed-7) when you update an existing arc or seed.
- Never write a minimal directive with just a mood: each turn deserves specific direction.
- Your personality flavors the delivery, never the story's register. Vary your beats and phrasings from turn to turn; do not replay a formula.`;
}

/** The Director's system prompt (D-110): stable for the session's settings. */
export function systemPrompt(i: SystemPromptInput): string {
  const name = i.persona?.name.trim() || undefined;
  const description = i.persona?.description?.trim() || undefined;
  const style = getPersonality(i.style).id;
  const body =
    i.profile === 'lite'
      ? [liteRules(name, description), creativityBlock(i.creativity), personalityDigest(getPersonality(style)), PLAN_RULES_LITE].join('\n\n')
      : `${fullRules(name, description, i.creativity, style)}\n\n${PLAN_RULES}`;
  const charName = i.charName.trim() || 'the character';
  const text = expandNames(body, name ?? 'the player', charName);
  if (i.transport !== 'tagged') return text;
  const schema = i.schemaText?.trim();
  return `${text}\n\n${HOW_TO_ANSWER(i.profile === 'lite')}${schema ? `\n${schema}` : ''}`;
}

// ---- history (section 7 of the user prompt) --------------------------------------------------------

export interface HistoryMessage {
  role: 'user' | 'assistant';
  /** Kept for the caller; the label is Bunraku's `[Turn N] role:`. */
  name: string;
  text: string;
}

const SEP = '\n\n';
/** Below this many tokens of room the oldest message is left out instead of cut. */
const MIN_CUT_TOKENS = 64;

const omittedNote = (n: number): string => `[${n} earlier messages omitted from Director history due to the recent-history budget]`;
const cutNote = (n: number): string => `\n[${n} characters omitted from the middle of this message]\n`;

/** `text` with its middle replaced by a note so that the whole counts ≤ `room` tokens; null if not even 64 fit. */
function cutMiddle(text: string, room: number, count: (s: string) => number): string | null {
  if (room < MIN_CUT_TOKENS) return null;
  const cut = (keep: number): string => {
    const head = headOf(text, Math.ceil(keep / 2));
    const tail = tailOf(text, Math.floor(keep / 2));
    return `${head}${cutNote(text.length - head.length - tail.length)}${tail}`;
  };
  const total = Math.max(1, count(text));
  const free = room - count(cutNote(text.length));
  let keep = Math.min(text.length - 1, Math.floor((text.length * Math.max(0, free)) / total));
  for (let tries = 0; tries < 40 && keep > 0; tries++) {
    const out = cut(keep);
    if (count(out) <= room) return out;
    keep = Math.floor(keep * 0.9);
  }
  return null;
}

/**
 * Bunraku history.ts with a token budget (D-64, D-110): the newest DIRECTOR_CALL.historyMessages
 * messages within `budgetTokens` (counted by `count`), each labeled `[Turn N] role:` by its index; the
 * oldest one that does not fit whole is cut in the middle and the walk stops there; a note says how many
 * earlier messages were left out. '' for no messages.
 */
export function historyLines(messages: readonly HistoryMessage[], budgetTokens: number, count: (s: string) => number): string {
  const n = messages.length;
  if (n === 0) return '';
  const earliest = Math.max(0, n - DIRECTOR_CALL.historyMessages);
  const sep = count(SEP);
  // The omission note is reserved first, in its longest form.
  let remaining = budgetTokens - count(omittedNote(n)) - sep;
  const sections: string[] = [];
  let first = n;
  for (let i = n - 1; i >= earliest; i--) {
    const m = messages[i]!;
    const label = `[Turn ${i + 1}] ${m.role}: `;
    const join = sections.length > 0 ? sep : 0;
    const whole = label + m.text;
    const cost = count(whole) + join;
    if (cost <= remaining) {
      sections.unshift(whole);
      remaining -= cost;
      first = i;
      continue;
    }
    const cut = cutMiddle(m.text, remaining - join - count(label), count);
    if (cut !== null) {
      sections.unshift(label + cut);
      first = i;
    }
    break;
  }
  if (first > 0) {
    // A budget too small for even the note sends nothing.
    if (sections.length === 0 && count(omittedNote(first)) > budgetTokens) return '';
    sections.unshift(omittedNote(first));
  }
  return sections.join(SEP);
}

// ---- self-audit (section 4) --------------------------------------------------------------------------

/**
 * Bunraku self-audit.ts: the Director's own last directive beside the narrator's prose for that turn,
 * the prose cut to DIRECTOR_CALL.selfAuditChars (head and tail). '' when there is nothing to compare.
 * `ago` is how many Director turns back the directive was planned (D-110 runs the audit only for 1).
 */
export function selfAuditSection(directive: NarratorDirective, prose: string, ago = 1): string {
  if (prose.trim() === '') return '';
  const when = ago === 1 ? 'last turn' : `${Math.max(0, ago)} turns ago`;
  const d = directive;
  const lines: string[] = [];
  if (d.mood || d.pacing) lines.push(`Mood/Pacing: ${d.mood || '-'} / ${d.pacing || '-'}`);
  if (d.narrativeGoal) lines.push(`Goal: ${d.narrativeGoal}`);
  if (d.arcDirections?.length) lines.push('Arc Directions:', ...d.arcDirections.map((a) => `  - [${a.urgency}] "${a.arcName}": ${a.instruction}`));
  if (d.callbacks?.length) lines.push('Callbacks:', ...d.callbacks.map((c) => `  - "${c.reference}": ${c.instruction}`));
  if (d.characterBeats?.length) lines.push('Character Beats:', ...d.characterBeats.map((b) => `  - ${b.character}: ${b.beat}`));
  if (d.endingHook) lines.push(`Ending Hook: ${d.endingHook}`);
  if (lines.length === 0) return '';
  const max = DIRECTOR_CALL.selfAuditChars;
  // The middle of a long reply is where the prose lives, but its head and tail say most.
  const text =
    prose.length > max ? `${headOf(prose, max / 2)}\n\n[... ${prose.length - max} chars truncated ...]\n\n${tailOf(prose, max / 2)}` : prose;
  return `### [SELF-AUDIT] Your Directive From ${when} -> What The Narrator Actually Wrote
This is the directive YOU authored ${when}. Below it is the narrator's actual prose for that turn. Compare them BEFORE you write this turn's directive.

YOUR DIRECTIVE WAS:
${lines.join('\n')}

NARRATOR'S ACTUAL PROSE:
${text}

AUDIT QUESTIONS (answer in your own head, do not output):
1. Which arcDirections / callbacks / characterBeats did the narrator HONOR? (Look for specific beats landing in the prose.)
2. Which were IGNORED or watered down? (Look for absence - beats you asked for that didn't show up.)
3. Did the narrator deliver something good you DIDN'T ask for? (The narrator has its own taste - work with it.)
4. Are there beats you keep asking for that keep getting ignored? (If so, change tactics - different angle, more force, or move on.)

Use this audit to shape THIS TURN's directive. If a beat was missed last turn and still matters, escalate it (more specific, more forceful, or via a different angle). If a beat was honored, move on - don't repeat it. Learn the narrator's actual behavior.`;
}

// ---- the user prompt -------------------------------------------------------------------------------

/** The person's standing instructions (RoleCall buildDmCustomInstructionsSection), verbatim, ≤ 2 000 chars; '' when blank. */
export function instructionsSection(instructions: string | null | undefined): string {
  const trimmed = headOf(instructions?.trim() ?? '', DIRECTOR_CALL.instructionsMax);
  if (!trimmed) return '';
  return (
    `\n### Custom Instructions for DM (persistent, from the player - HIGH-PRIORITY STANDING DIRECTIVE)\n` +
    `These are the player's standing instructions for you, applied every turn. Honor them in your planning ` +
    `(arcs, seeds, beats, pacing, tone) unless doing so would violate safety, the character card, or the ` +
    `player-character POV rule.\n${trimmed}\n`
  );
}

/** What the planner knows of the story so far, in short (RoleCall formatContextForPrompt). */
function storyState(s: DirectorState, limits?: ShowLimits): string {
  const sections: string[] = [];
  const arcs = limits ? newestOf(s.arcs, limits.arcs, (a) => a.lastProgressTurn ?? a.createdAtTurn) : s.arcs.slice(-PROMPT_LIMITS.arcs);
  const rest = limits ? more(s.arcs.length - arcs.length, 'arcs') : '';
  if (arcs.length > 0) sections.push(`Active Story Arcs:\n${arcs.map((a) => `- "${a.title}" [${a.status}/${a.priority}]: ${clip(a.description)}`).join('\n')}${rest}`);
  if (s.nextIntentions.length > 0) sections.push(`Your Current Intentions:\n${s.nextIntentions.map((i) => `- [${i.priority}] ${i.type}: ${i.description}`).join('\n')}`);
  sections.push(`Current Mood: ${s.pacing.currentMood} (${s.pacing.turnsAtCurrentMood} turns)`);
  return sections.join('\n\n');
}

const currentChapter = (s: DirectorState): DirectorChapter | undefined =>
  s.currentChapterId === undefined ? undefined : s.chapters.find((c) => c.id === s.currentChapterId);

/** How long a finished chapter ran: until the next chapter began (unknown without one). */
function chapterLength(c: DirectorChapter, all: readonly DirectorChapter[]): number | undefined {
  const next = all.filter((x) => x.number > c.number).sort((a, b) => a.number - b.number)[0];
  return next === undefined ? undefined : Math.max(0, next.createdAtTurn - c.createdAtTurn);
}

/** This chapter is young: never close it (Bunraku's prompt threshold; the reducer refuses below CHAPTER_MIN_TURNS). */
const CHAPTER_YOUNG = 10;

function chapterInfo(s: DirectorState, turn: number): string {
  const done = s.chapters.filter((c) => c.status === 'complete').sort((a, b) => a.number - b.number);
  const current = currentChapter(s);
  let info = '';
  if (done.length > 0) {
    info += `Previous chapters:\n${done
      .map((c) => {
        const len = chapterLength(c, s.chapters);
        return ` - Chapter ${c.number}: "${c.title}"${len === undefined ? '' : ` (${len} turns)`} - ${clip(c.premise || c.majorGoal || 'completed')}\n`;
      })
      .join('')}\n`;
  }
  if (!current) return `${info}No chapter defined yet - chapterUpdate MUST use action "start_new" to create Chapter 1.`;
  const elapsed = ageOf(turn, current.createdAtTurn);
  const { target, maximum } = CHAPTER_TURNS;
  info += `Current: Chapter ${current.number}: "${current.title}" (${current.status}) - ${elapsed}/${target} turns`;
  if (current.themes.length > 0) info += `\nThemes: ${current.themes.join(', ')}`;
  if (current.majorGoal) info += `\nGoal: ${clip(current.majorGoal)}`;
  if (elapsed < CHAPTER_YOUNG) info += `\nThis chapter just started - chapterUpdate must use action "none" or "update", never "start_new".`;
  else if (elapsed >= maximum)
    info += `\nOVERDUE: This chapter has EXCEEDED its maximum length (${elapsed}/${maximum}). Set chapterUpdate.action to "start_new" THIS TURN or next turn. Find a transition point NOW.`;
  else if (elapsed >= target)
    info += `\nThis chapter has reached its target length. Actively look for a good moment to set chapterUpdate.action to "start_new". If the chapter objectives are mostly met, transition now.`;
  else if (elapsed >= target * 0.7)
    info += `\nThis chapter is approaching its target length. Start wrapping up - use chapterUpdate with action "update" and status "concluding" if the chapter is nearing its climax.`;
  return info;
}

function arcInfo(s: DirectorState, turn: number, limits?: ShowLimits): string {
  const active = s.arcs.filter((a) => a.status !== 'complete' && a.status !== 'abandoned');
  // The ones that have gone longest without progress come first, so the cap never hides an arc that needs action.
  // Shrunk to fit the window (D-121), the oldest-progress ones are left out instead (the momentum report names them).
  const since = (a: (typeof active)[number]): number => a.lastProgressTurn ?? a.createdAtTurn;
  const sorted = [...active].sort((a, b) => since(a) - since(b));
  const shown = limits ? sorted.slice(Math.max(0, sorted.length - limits.arcs)) : sorted.slice(0, PROMPT_LIMITS.arcs);
  const stagesShown = limits?.arcStages ?? PROMPT_LIMITS.arcStagesShown;
  const lines =
    shown
      .map((arc) => {
        let line = `- [${arc.id}] ${arc.title} (${arc.status}, ${arc.horizon || 'medium'} horizon, ${ageOf(turn, arc.createdAtTurn)} turns): ${clip(arc.description)}`;
        const b = arc.nextBeat;
        // Forward-looking: the planner's own next beat. Missing or delivered, it is told to set a new one.
        if (b?.status === 'pending')
          line += `\n -> NEXT BEAT [set on turn ${b.plannedAtTurn}]${typeof b.targetTurn === 'number' ? ` (target: turn ${b.targetTurn})` : ''}: ${clip(b.description)}`;
        else if (b?.status === 'delivered')
          line += `\n -> NEXT BEAT: delivered on turn ${b.deliveredAtTurn ?? '?'} - PLAN A NEW ONE this turn via arcUpdates.nextBeat`;
        else if (!b)
          line += `\n -> NEXT BEAT: NONE SET - you MUST set one this turn via arcUpdates.nextBeat. An arc without a forward-looking plan is an arc that drifts.`;
        if (arc.stages.length > 0) {
          const recent = stagesShown > 0 ? arc.stages.slice(-stagesShown) : [];
          const hidden = arc.stages.length - recent.length;
          line += `\n Stages so far (${arc.stages.length}, backward-looking log):\n${hidden > 0 ? ` · (+${hidden} earlier)\n` : ''}${recent.map((st) => ` · ${clip(st.title)}`).join('\n')}`;
        }
        return line;
      })
      .join('\n') + more(active.length - shown.length, 'active arcs') || 'None yet';
  const types = new Set(active.map((a) => a.arcType));
  const hints: string[] = [];
  if (active.length < 2 && turn > 5)
    hints.push(`Only ${active.length} active arc(s) after ${turn} turns - stories feel richer with 3-6 concurrent arcs. Add new narrative threads in arcUpdates.`);
  if (active.length === 1 && active[0]!.stages.length > 5)
    hints.push(`Your single arc has ${active[0]!.stages.length} stages - consider splitting emerging subplots into their own arcs rather than cramming everything into one.`);
  if (!types.has('character') && turn > 8) hints.push('Consider adding a character arc - NPC relationships and personal growth make great arcs.');
  if (!types.has('side') && turn > 10) hints.push('Consider adding a side arc - subplots from player actions or NPC agendas add depth.');
  return lines + (hints.length > 0 ? `\n${hints.join('\n')}` : '');
}

function seedInfo(s: DirectorState, turn: number, limits?: ShowLimits): string {
  const pending = s.seeds.filter((x) => !x.payoffDelivered);
  if (pending.length === 0) return "None planted yet - use seedUpdates with action 'plant' to start tracking narrative threads";
  const over = (x: (typeof pending)[number]): number => ageOf(turn, x.plantedAtTurn) / surfaceTurns(x.payoffHorizon);
  // Shrunk to fit the window (D-121): the seeds planted or reinforced most recently (ripe ones are in the momentum report).
  const lastTouch = (x: (typeof pending)[number]): number => Math.max(x.plantedAtTurn, ...x.reinforcements.map((r) => r.turn));
  const kept = limits ? newestOf(pending, limits.seeds, lastTouch) : pending;
  const shown = [...kept].sort((a, b) => over(b) - over(a)).slice(0, limits ? limits.seeds : PROMPT_LIMITS.seeds);
  return (
    shown
      .map((x) => {
        const threshold = surfaceTurns(x.payoffHorizon);
        const age = ageOf(turn, x.plantedAtTurn);
        const status = age >= threshold ? `OVERDUE (${age}/${threshold} turns) - MUST resolve or advance this seed NOW` : `${age}/${threshold} turns`;
        return `- [${x.payoffHorizon}] "${x.hint}" (id: ${x.id}, ${status}, ${x.reinforcements.length} reinforcements): ${x.payoff ? clip(x.payoff) : "MISSING DESCRIPTION - provide 'description' in the seedUpdates entry"}`;
      })
      .join('\n') + more(pending.length - shown.length, 'pending seeds')
  );
}

function shadowInfo(s: DirectorState, turn: number, limits?: ShowLimits): string {
  const parts: string[] = [];
  const hidden = s.invisibleArcs.filter((a) => a.status !== 'resolved' && a.status !== 'visible');
  // The person's own come first and are always sent; the rest, the longest-running first.
  const mine = hidden.filter((a) => a.userAuthored);
  const others = hidden.filter((a) => !a.userAuthored).sort((a, b) => a.createdAtTurn - b.createdAtTurn);
  const hiddenShown = [...mine, ...others].slice(0, Math.max(limits?.hidden ?? PROMPT_LIMITS.hidden, mine.length));
  if (hidden.length > 0) {
    parts.push(
      'Invisible Arcs:\n' +
        hiddenShown
          .map((a) => {
            const threshold = surfaceTurns(a.horizon);
            const age = ageOf(turn, a.createdAtTurn);
            const status = age >= threshold ? `OVERDUE ${age}/${threshold} - MUST advance/surface/resolve NOW` : `${age}/${threshold} turns`;
            let line = `- [${a.id}] "${a.title}" [${a.status}, ${a.arcType}, ${a.horizon}]${a.userAuthored ? ' PLAYER-PLANTED' : ''} (${status}): ${a.description ? clip(a.description) : "MISSING DESCRIPTION - provide 'description' in the invisibleArcUpdates entry"}`;
            if (a.userAuthored)
              line += `\n  NOTE: This arc was planted directly by the player. Weight surfacing toward their stated intent - they're telling you they want this to land.`;
            if (a.surfaceCondition) line += ` | surfaces: ${clip(a.surfaceCondition)}`;
            if (a.stages.length > 0) line += `\n Stages: ${a.stages.map((st) => `"${clip(st.title)}" (turn ${st.turn})`).join(' -> ')}`;
            if (a.playerClues.length > 0) line += `\n Clues noticed: ${a.playerClues.map((c) => clip(c.clue)).join('; ')}`;
            return line;
          })
          .join('\n') +
        more(hidden.length - hiddenShown.length, 'hidden arcs'),
    );
  }
  const notesShown = s.notes.slice(-PROMPT_LIMITS.notes);
  if (s.notes.length > 0)
    parts.push('Notes from the player:\n' + notesShown.map((n) => `- [${n.id}] ${clip(n.content)}`).join('\n') + more(s.notes.length - notesShown.length, 'older notes'));
  return parts.length > 0 ? parts.join('\n') : 'No shadow world data yet - use invisibleArcUpdates in your plan to track hidden storylines';
}

function pacingStatus(s: DirectorState, rhythm: UserPromptInput['rhythm']): string {
  const lines = [
    `Current mood: ${s.pacing.currentMood} (${s.pacing.turnsAtCurrentMood} turns)`,
    `Chapter phase: ${currentChapter(s)?.status === 'concluding' ? 'concluding' : 'development'}`,
  ];
  if (rhythm?.needsQuietMoment) lines.push('Consider slowing down - too much action recently');
  if (rhythm?.needsTension) lines.push('Consider adding tension - too quiet for too long');
  return lines.join('\n');
}

export interface UserPromptInput {
  profile: DirectorProfile;
  state: DirectorState;
  /** This Director turn (state.turn + 1). */
  turn: number;
  /** formatMomentumReport's text (section 2). */
  momentumText: string;
  /** The world snapshot (M5a); '' leaves the section out. */
  worldText: string;
  /** U's text. */
  userMessage: string;
  /** A guided re-roll's guidance (D-104); one more line in section 6. */
  guidance?: string;
  /** `director.instructions`, verbatim (cut to DIRECTOR_CALL.instructionsMax). */
  instructions: string;
  /** historyLines' text. */
  history: string;
  /** How many messages the history had before the budget (the section heading's count). */
  historyCount: number;
  /** selfAuditSection's text, when the audit runs (D-110). */
  selfAudit?: string;
  /** The momentum report's rhythm signals for the two "Consider…" lines of Pacing Status; absent → left out. */
  rhythm?: { needsQuietMoment: boolean; needsTension: boolean };
  /** D-121: shorter lists for a prompt that must shrink to fit the window (LITE_SHOW_LIMITS); absent → PROMPT_LIMITS. */
  limits?: ShowLimits;
}

/** The Director's user prompt, in Bunraku user-prompt.ts's section order; lite has no Shadow World (D-102). */
export function userPrompt(i: UserPromptInput): string {
  const { state: s, turn } = i;
  const world = i.worldText.trim();
  const audit = i.selfAudit?.trim() ?? '';
  const guidance = i.guidance?.trim();
  const action = guidance ? `${i.userMessage}\nThe player asked for a new version of the last answer: ${guidance}` : i.userMessage;
  const shadow = i.profile === 'lite' ? '' : `\n### Shadow World (Your Private Tracking)\n${shadowInfo(s, turn, i.limits)}\n`;
  return `## Turn ${turn}

## Current Story State
${storyState(s, i.limits)}

${i.momentumText.trim()}
${world ? `\n${world}\n` : ''}${audit ? `\n${audit}\n` : ''}
### Chapters
${chapterInfo(s, turn)}

### User's Action
${action}
${instructionsSection(i.instructions)}
### Conversation History (${i.historyCount} total turns)
${i.history}

### Active Story Arcs (MANDATORY: send an arcUpdates entry for every arc that changed this turn)
${arcInfo(s, turn, i.limits)}

### Pacing Status
${pacingStatus(s, i.rhythm)}

### Your Current Intentions
${s.nextIntentions.map((n) => `- [${n.priority}] ${n.description}`).join('\n') || 'None set'}

### Pending Seeds (MANDATORY: send seedUpdates every turn to reinforce/resolve these)
${seedInfo(s, turn, i.limits)}
${shadow}
---

Remember: The "directive" section is ALL the Narrator will see. Don't spoil your plans!`;
}
