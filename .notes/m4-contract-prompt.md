# M4 contract notes — unit `prompt` (+ personalities)

Files: `src/agents/director/prompt.ts`, `src/agents/director/personalities/` (index.ts, types.ts, 10
personality files), `test/director/prompt.test.ts`, `test/director/personalities.test.ts`,
`test/director/prompt-lite.test.ts`. Provenance rows: `.notes/m4-provenance-prompt.md`.
prompt.ts imports only `types.ts` and `personalities/` (no plan.ts, no momentum.ts — seams F).

## 1. Changes needed in files I do not own

None required. For the **integrate** unit (call.ts), how to call this unit:
- System: `systemPrompt({ profile, transport, style: config.director.style, creativity: config.director.creativity,
  persona: persona && { name: persona.name, description }, charName, schemaText })` with
  `schemaText = transport === 'tagged' ? JSON.stringify(profile === 'lite' ? PLAN_SCHEMA_LITE : PLAN_SCHEMA) : undefined`
  (D-110: compact JSON). Structured sends the schema in the request; the system text then has PLAN_RULES
  but no "How to answer".
- History: `historyLines(msgs, Math.floor(window * (lite ? DIRECTOR_CALL.historyShareLite : DIRECTOR_CALL.historyShareFull)),
  (s) => estimateTokens(s, counter))`; `msgs` = visible text-only messages BEFORE U, greeting included
  (D-110); pass `historyCount: msgs.length`.
- Self-audit: `selfAudit = state.lastDirective?.turn === state.turn && parentOf(U) is an assistant reply
  ? selfAuditSection(state.lastDirective.directive, effectiveText(parent)) : undefined`.
- User: `userPrompt({ profile, state, turn: state.turn + 1, momentumText: formatMomentumReport(report),
  worldText: worldSnapshot?.(view, lite ? WORLD_LITE : WORLD_FULL) ?? '', userMessage: U.text, guidance,
  instructions: config.director.instructions ?? '', history, historyCount, selfAudit, rhythm: report.rhythm })`.
- The auto-profile measurement (D-102) can call `systemPrompt({profile:'full',…})` and `userPrompt` with the
  history at 25 % directly; both are pure and cheap.

Doc (ARCHITECTURE.md rev 14): the lite digest measures 0.89–1.33k chars (§7.3 says 0.8–1.2k; Nemo's longer
pacingRhythm texts in jester/shadow/thrill-seeker). The full Sage system prompt is now 21 276 chars without a
persona (Bunraku's 19 531 + PLAN_RULES 1 741 + 4 separator chars); oracle 23 751; Sage with a short persona
25 218. Lite system (structured, no persona): 7.37–7.81k chars; tagged adds HOW_TO_ANSWER (≈ 0.5k) + the schema.

## 2. Deviations from m4-decisions.md (and the task text), with reasons

1. **Pacing Status rhythm lines**: `UserPromptInput` has an additive optional `rhythm?: { needsQuietMoment;
   needsTension }`; the caller passes `report.rhythm` and the two "Consider…" lines appear when set, absent →
   left out. Reason: the state stores no recommendations and the momentum text does not print these flags,
   so taking them from momentumText was impossible; the report already has them. "Chapter phase" (always
   "development" in Bunraku) is now `concluding` when the current chapter's status is `concluding`, else
   `development`.
2. **Arc order** in "Active Story Arcs": by `lastProgressTurn ?? createdAtTurn` ascending (the A.2 staleness
   formula). Bunraku sorted `lastProgressTurn ?? Infinity`, which put never-progressed arcs LAST, against its
   own comment and the "arcs by staleness" rule.
3. **Chapter hints**: "just started" stays Bunraku's `< 10` turns (a prompt hint; the reducer's refusal is
   CHAPTER_MIN_TURNS = 3); target/maximum = CHAPTER_TURNS 50/100. A finished chapter's "(N turns)" is the next
   chapter's createdAtTurn minus its own (rp-core stores no turnsElapsed); left out when unknown.
4. **Persona/player rules**: full = Bunraku's block, shown when the persona has a name OR a description
   (D-110), left out without a persona. Lite always carries THE TEST (for "the player" when no persona) in its
   own "## The Player Character" section, with the persona's name and description when there is one — the
   condensed rules need it more than the full ones.
5. **PLAN_RULES**: Bunraku's DESCRIPTION without the "SINGLETON. Call this tool EXACTLY ONE time…" sentence
   (there is no tool; "exactly one block" is in HOW_TO_ANSWER), one rule per line under `## YOUR PLAN`. A
   separate `PLAN_RULES_LITE` describes PLAN_SCHEMA_LITE's five sections (no invisibleArcUpdates anywhere in
   lite). `HOW_TO_ANSWER` is a function `(lite = false)`.
6. **History**: the label is Bunraku's `[Turn N] role:` (index-based); `HistoryMessage.name` is accepted but
   not printed. A message that fits whole is always taken (Bunraku stopped once < 256 chars of room were
   left, even for a short message); a cut needs ≥ 64 tokens of room, else the message is left out; cuts never
   split a surrogate pair; '' when even the omission note does not fit the budget.
7. **selfAuditSection(directive, prose, ago = 1)**: third parameter added (Bunraku's "N turns ago"); D-110 only
   ever needs 1. Blank prose → ''.
8. **Macros**: `{{user}}`/`{{char}}` are matched case-insensitively (rp-core's macro engine is). Only the system
   prompt is expanded (persona description included); the user prompt is not (instructions verbatim, D-110).
   Blank charName → "the character". An unknown creativity reads as moderate.
9. Spaces left by RoleCall's stripped emoji (" OVERDUE", " MISSING DESCRIPTION", " Only N active arc(s)",
   " Consider…") are dropped. `clip` (300) also applies to stage titles, clues, notes, chapter goals/premises
   and surface conditions (Bunraku sent those unclipped; state caps them anyway).
10. `getPersonality` trims the id before lookup (`'  the-jester '` → Felix); matching stays case-sensitive.
11. Lite has no SHARED_PERSONALITY_GUIDANCE (715 chars); its Brevity section carries a one-line version.

## 3. Additive API / exports

```ts
// src/agents/director/prompt.ts
export type DirectorProfile = 'full' | 'lite';
export type DirectorTransport = 'structured' | 'tagged';
export const PLAN_RULES: string;
export const PLAN_RULES_LITE: string;
export function HOW_TO_ANSWER(lite?: boolean): string;
export interface SystemPromptInput {
  profile: DirectorProfile; transport: DirectorTransport; style: string; creativity: Creativity;
  persona?: { name: string; description?: string }; charName: string; schemaText?: string;
}
export function systemPrompt(i: SystemPromptInput): string;
export interface HistoryMessage { role: 'user' | 'assistant'; name: string; text: string }
export function historyLines(messages: readonly HistoryMessage[], budgetTokens: number, count: (s: string) => number): string;
export function selfAuditSection(directive: NarratorDirective, prose: string, ago?: number): string;
export function instructionsSection(instructions: string | null | undefined): string;
export interface UserPromptInput {
  profile: DirectorProfile; state: DirectorState; turn: number; momentumText: string; worldText: string;
  userMessage: string; guidance?: string; instructions: string; history: string; historyCount: number;
  selfAudit?: string; rhythm?: { needsQuietMoment: boolean; needsTension: boolean };
}
export function userPrompt(i: UserPromptInput): string;

// src/agents/director/personalities/index.ts
export type { DirectorPersonalityDef } from './types.ts';
export { DEFAULT_PERSONALITY } from '../types.ts';
export const PERSONALITIES: readonly DirectorPersonalityDef[];          // picker order = DIRECTOR_PERSONALITIES
export function getPersonality(id: string | null | undefined): DirectorPersonalityDef;   // unknown → Sage
export const SHARED_PERSONALITY_GUIDANCE: string;
export function personalityPrompt(id: string | null | undefined): string;               // block + footer
export function personalityDigest(p: DirectorPersonalityDef): string;                    // lite, ≈ 0.9–1.3k
```
`DirectorPersonalityDef` (personalities/types.ts) is Bunraku's shape with `id: PersonalityId`; the REPL can list
`name`, `title`, `tagline`, `description` for `/director` if wanted.

## 4. What I could not do / open points

- No byte-for-byte test against Bunraku in the suite (the core never imports Bunraku). Checked once with a
  scratch script: the full system prompt equals Bunraku's `systemPrompt` output for the 7 personalities
  without D-111 fixes × 3 creativities × with/without persona, apart from the {{user}} expansion and the
  PLAN_RULES suffix; the 3 fixed ones differ only at the fixes.
- Tests use fake counters (chars/4, chars/2.5), not o200k; `historyLines` relies on the counter being roughly
  additive (a joined text never counts more than its parts plus separators).
- The out-of-schema keys in 4 safe examples (romantic, thrill-seeker, shadow, jester) and jester's
  `"pacing": "balanced"` stay (D-111: alias map waits for Chi).
- weaver STAGE 8's "Store these in: intentions" (it is `analysis.intentions`) left as is — not a D-111 fix.
- Lite rules text is ≈ 5.0k chars / 49 lines, plus PLAN_RULES_LITE ≈ 1.3k / 12 lines (≈ 6.3k / 61 lines of
  new text); the §7.3 "≈ 7k" is met by the whole lite system prompt (7.4–7.8k), not by the rules alone.
