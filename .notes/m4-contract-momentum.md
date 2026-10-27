# M4 contract note — unit `momentum`

Files: `src/agents/director/momentum.ts`, `test/director/momentum.test.ts` (49 tests),
`test/director/enrich.test.ts` (12 tests). Provenance rows: `.notes/m4-provenance-momentum.md`.

## (1) Changes needed in files I do not own

- **integrate (`call.ts`)** — the pipeline calls, in this order:
  `report = computeMomentum(prevState, turn)` with `turn = prevState.turn + 1` (BEFORE applyPlan);
  user prompt gets `formatMomentumReport(report, { lite })`; the second user message is
  `planningPressures(prevState, report, { lite })`, left out when it is `''`; after applyPlan,
  `enrichFromMomentum(plan.directive, report)` and then the persona filter. The authored
  `plan.directive` (not the enriched one) is `state.lastDirective` (types.ts says so).
- **prompt (`prompt.ts`)** — Bunraku `user-prompt.ts:142-143` read `pacing.recommendations.needsQuietMoment /
  needsTension`, which rp-core does not store: they are `report.rhythm.*` now. Either `userPrompt` takes
  them as an input or the caller folds them into `momentumText`. The chapter hints (`elapsed < 10`,
  `≥ 0.7 × target`, `≥ target`, `≥ maximum`) and arc hints (`< 2 active after turn 5`, `> 5 stages`,
  `no character arc after 8`, `no side arc after 10`) have their numbers in `MOMENTUM.chapter` and
  `MOMENTUM.arcHints` (D-63: one data object). The wave-1 seam forbids prompt.ts importing momentum.ts,
  so prompt.ts holds its own copies for now; after wave 1 it should import `MOMENTUM` (a pure const, no
  cycle) or add a test that its numbers equal `MOMENTUM`'s.
- **reduce (`reduce.ts`)** — momentum relies on: `lastProgressTurn` set when an arc is created (Bunraku
  `apply.ts:166`) and on progress; `lastPlantTurn` set on every plant; `pacing.rhythm` counters and
  `turnsAtCurrentMood` kept per D-109. With the grace rule below, an arc created WITHOUT
  `lastProgressTurn` never goes stale or forced.
- **plan (`readPlan`)** — nothing required: enrich already ignores empty `arcName` / `reference`
  (RoleCall's edge, rolecall.md §9.1), but readPlan dropping them into `skipped` is still right.
- **types.ts** — nothing required. See the A.2 conflict below.

## (2) Deviations from m4-decisions.md and the task text, and why

1. **Grace rule vs A.2.** A.2 says `turnsSinceProgress = turn − (lastProgressTurn ?? createdAtTurn)`;
   the momentum task says `turn − (lastProgressTurn ?? turn)` ("keep Bunraku's rule"). I followed the
   task (Bunraku, RoleCall). Arcs made by reduce carry `lastProgressTurn`, so the two differ only for an
   arc without it: never stale/forced here, aged from creation under A.2. Lead's call: it is one token
   in `computeMomentum` (`?? turn` → `?? arc.createdAtTurn`) and the test
   "the grace rule: …" flips.
2. **Rhythm guards kept.** The task's formulas (`turn − lastQuietMoment > 8`, `turn − lastActionSequence
   > 12`) leave out Bunraku's `lastActionSequence > 0` / `lastQuietMoment > 0` guards
   (`apply.ts:264`). Without them a story whose moods never read as quiet would be told "The story
   needs a breather" from turn 9 on, forever (rule 2 of the pacing advice shadows everything after).
3. **Rhythm derived at the planning turn**, with `turnsAtCurrentMood ≥ 4` and `moodKinds(mood)` having
   `tense` (task, §7.3). Bunraku computed the flags after the previous turn, with the previous count
   (`prev.turnsAtCurrentMood >= 4 && mood === "tense"`, i.e. 5 turns in practice).
4. **Planting** uses the later of `lastPlantTurn` and the newest seed's `plantedAtTurn` (equal when
   reduce keeps the invariant; robust when it does not).
5. **Lite report**: besides dropping the shadow section, a lite report whose only signal is shadow is
   the quiet one-liner (otherwise it would be a bare header and "Pacing:"). `report.summary` still
   counts shadow items (it is not part of the prompt).
6. **`planningPressures` lite** is accepted but changes nothing: Bunraku's pressures name no hidden arc.
7. **enrich** (all only add matches Bunraku missed, except item c):
   a. names compare after `foldText` + whitespace collapse, contained in either direction (Bunraku), OR
      by a run of word stems (`stemKeyMatches`: "Тайна запертой комнаты" names "Запертая комната"), OR
      by the item's id (`arc-3`, `[arc-3]`, `SEED-1`);
   b. an empty name never matches;
   c. forced arcs / ripe seeds are compared with the PLANNER's entries only (Bunraku also compared with
      what it had just added, so of two forced arcs "The Bell" and "The Bell Tower" the second was lost);
   d. each list stops at `READ_LIMITS.directiveList` (12), most overdue first, the planner's entries kept;
   e. the report is required and a new object is always returned (Bunraku returned the same object
      when nothing was added; the ported test says so).
8. **Extra MOMENTUM keys** beyond the task's list: `chapter.justStarted: 10` and `arcHints.minActive: 2`
   (both numbers are in Bunraku user-prompt.ts and are thresholds too).
9. **Name**: F lists `momentumReport`; the task and the prompt seam say `formatMomentumReport` — used
   the latter.

## (3) API (all from `src/agents/director/momentum.ts`)

```ts
export const MOMENTUM: {
  horizonLimits: { immediate: 2; short: 9; medium: 15; long: 30; epic: 75 };
  arcStale: 15;
  seedRipe: { age: 30; reinforcements: 2; overdueAge: 60 };
  planting: { moderate: 12; high: 20; critical: 35 };
  invisibleSurface: { immediate: 2; short: 6; medium: 12; long: 25; epic: 60 };   // parity only (D-63)
  shadowUrgency: { high: 10; medium: 4 };
  overallPace: { staleArcs: 3; ripeSeeds: 2 };
  rhythm: { quiet: 8; tension: 12; climax: 4 };
  chapter: { wrap: 0.7; startNew: 50; overdue: 100; justStarted: 10 };             // from CHAPTER_TURNS
  arcHints: { minActive: 2; minActiveAfterTurn: 5; maxStagesSingle: 5; characterArcAfter: 8; sideArcAfter: 10 };
  listMax: 10;
};   // `as const`
export function computeMomentum(state: DirectorState, turn: number): MomentumReport;
export interface MomentumTextOptions { lite?: boolean }
export function formatMomentumReport(report: MomentumReport, opts?: MomentumTextOptions): string;
export function planningPressures(state: DirectorState, report: MomentumReport, opts?: MomentumTextOptions): string;
export function enrichFromMomentum(directive: NarratorDirective, report: MomentumReport): NarratorDirective;
```
`MomentumReport.rhythm` = `{ needsQuietMoment, needsTension, readyForClimax }` (types.ts shape), derived.
All pure; imports only `text/normalize.ts`, `mood.ts`, `types.ts`.

## (4) What I could not do / open points

- **Loose compare kept**: Bunraku's plain substring means a forced arc "Art" counts as directed by a
  planner's "The Party", and a one-letter arcName silences most additions. Kept for parity (§7.3:
  "сравнение подстрокой"); a whole-word containment (the stem run already covers inflection) would fix
  it — lead's call.
- Fixture builders (`arcOf`, `seedOf`, `hiddenOf`, `stateOf`) are duplicated in my two test files: a
  shared `test/director/fixtures.ts` is not mine, and the state unit's `emptyState` is unfinished in
  wave 1. Worth merging into one fixtures file after wave 1.
