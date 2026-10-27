# M4 contract note — unit `reduce`

Files: `src/agents/director/reduce.ts`; tests `test/director/reduce.test.ts`, `test/director/arc-match.test.ts`,
`test/director/title.test.ts`. Provenance rows: `.notes/m4-provenance-reduce.md`.

## (1) Changes needed in files I do not own

None required. Notes for the other units:
- **state (fitState)**: applyPlan does NOT cap per-item lists. Stages, playerClues and reinforcements only grow
  here (arc stages, hidden stages, clues, reinforcements); fitState must cut them to STATE_LIMITS.stages (6) /
  clues (6) / reinforcements (4), keeping the newest. Intentions are already ≤ 5. Text fields are not re-cut
  (readPlan caps them at 300; arc titles are ≤ 80 by cleanTitle).
- **state (ages)**: tests compute `max(0, turn − plantedAtTurn)` locally (RoleCall seedTurnsActive); state.ts's
  `ageOf` should give the same numbers.
- **integrate**: `applyPlan`'s `skipped` is separate from readPlan's. D-107's "≤ 20 then `+N more`" is
  readPlan's cap; whoever merges both lists into `DirectorRecord.skipped` should decide whether the merged
  list gets the same cap (suggest: yes, one cap over the merged list, same `{path:'skipped', why:'+N more'}`).
  Call order per D-105: `applyPlan(prev, round, {turn: prev.turn + 1})` then enrich/filter, then fitState.
- **prompt**: arcs should keep being listed as `[arc-N] Title`; cleanTitle strips a leading `arc-N` echo
  (bracketed or not) and a trailing `(arc-N)`/`[arc-N]`. A seed's id is `seed-N`, a hidden arc's `hidden-N`.
- **render summaryOf**: ids are allocated in plan order chapter → arcs → seeds → hidden arcs; a new chapter
  is `chapter-<max number + 1>`; a deleted seed or hidden arc is gone from the list (no soft delete).
- **momentum**: may reuse `sameMood(a, b)` if it ever needs mood sameness; rhythm counters follow
  `moodKinds` with climax counted as action (Bunraku parity).
- Unrelated tsc error seen at the end of my run (not mine): `test/structured/structured.test.ts(402,125)`
  — a price object without `asOf`.

## (2) Deviations from m4-decisions.md / the task text, and why

- **start_new refusal only when the current chapter is `active`** (Bunraku parity): a chapter the model has
  already marked `concluding` may close the next turn even if younger than CHAPTER_MIN_TURNS. The note says
  "while the current chapter is younger than 3" without a status; the task said "update/start_new semantics
  as Bunraku". Age = `max(0, turn − createdAtTurn)`; 3 turns old is allowed.
- **First chapter title**: `chapterUpdate.title` minus a `Chapter N:` prefix (Bunraku), else
  `'The Story Begins'` (`FIRST_CHAPTER_TITLE`); a later chapter without a title is `Chapter N` (Bunraku).
- **Mood sameness (the "decide, document" point)**: two moods are the same when their sets of word stems,
  function words (DIRECTOR_STOP) left out, are equal; a mood without words compares its folded text. So
  "tense, watchful" = "Watchful and tense", «напряжённо» = «напряжённый». `currentMood` takes the new spelling.
  An empty/blank mood counts as no mood.
- **Rhythm**: climax also sets `lastActionSequence` (Bunraku `pacingAfter` did; the task text named only
  action and quiet).
- **Matching tokens are distinct** (sets), not RoleCall's per-word count with repeats ("Levi Levi" is one token).
  The exact-id step is trimmed and case-insensitive. Tokens: stems longer than two; the stop check is on the
  folded word (and on it without an English possessive), never on the stem (a stem check would drop «тема»
  → тем). Candidates: every arc, finished ones included (Bunraku and RoleCall parity; an update can land on a
  completed arc with the same title — pinned in a test).
- **DIRECTOR_STOP** leaves out words that are also names or common nouns: will, may, might, том, тем, есть.
- **Hidden-arc matching**: id first (`arcId`, or a `title` that is an id), then the match key. Bunraku took the
  first arc meeting either condition.
- **Reinforce** counts without its `reinforcement` text (the text is not stored any more, so it cannot be
  the condition) and at most once per turn per seed (a second one is skipped). Bunraku required the text.
- **lastPlantTurn** moves only when a NEW seed is planted; a re-plant of a known seed updates it and keeps
  both `plantedAtTurn` and `lastPlantTurn`.
- **Skipped entries beyond the listed refusals** (all "ignored request" cases, each with its path):
  `arcUpdates[i].title` (rename refused — only when a title is sent beside a selector that matched and its
  key differs; hidden arcs are not reported because their title is a required identifier), `.title` "cut to …"
  (a new arc's title changed by cleanTitle beyond whitespace), `.newStageTitle` (same as the last stage),
  `.markNextBeatDelivered` (no pending beat / new arc), `.nextBeat` (empty description), seed
  `already reinforced this turn`, hidden `.newClue` (already recorded / add records no clue), `.newStageTitle`
  (add records no stage), `.status` (add starts as seeding), `.scope` (set once), `analysis.intentions[j]`
  (empty), `analysis.intentions` (kept 5 of N), `chapterUpdate` (update with no current chapter).
- **Live caps** count live items only (arcs not complete/abandoned, seeds not paid, hidden arcs not
  resolved/visible). An update that revives a finished arc is not refused at the cap (fitState handles size).
- **cleanTitle echo rule**: leading `arc-N` echoes (any case, optional brackets and a `: . | - – —` separator,
  repeated) and one trailing bracketed echo. Known cost: a real title starting "Arc-7 …" loses that prefix.

## (3) Exported API (src/agents/director/reduce.ts)

```ts
export interface ApplyContext { turn: number }
export interface Applied { state: DirectorState; skipped: Skip[] }
export function applyPlan(state: DirectorState, round: PlanningRound, ctx: ApplyContext): Applied;

export const FIRST_CHAPTER_TITLE: 'The Story Begins' (string);
export const DIRECTOR_STOP: ReadonlySet<string>;          // D-46 STOP_WORDS ∪ the Director's function words (folded)
export function matchKey(title: string): string;          // stems of every word joined by ' '; '' = no word
export function titleTokens(title: string): string[];     // distinct significant stems
export interface ArcMatch<T> { item: T; by: 'id' | 'key' | 'words'; ratio?: number }
export function matchArc<T extends { id: string; title: string }>(candidates: readonly T[], selector: string): ArcMatch<T> | undefined;
export function findArc(state: DirectorState, key: string): DirectorArc | undefined;
export function cleanTitle(raw: string): string;          // '' when nothing is left
export function sameMood(a: string, b: string): boolean;
export function pacingAfter(prev: DirectorPacing, mood: string | undefined, turn: number): DirectorPacing;
```

## (4) What I could not do

- The per-item caps (stages 6, clues 6, reinforcements 4) are not applied or tested here — fitState's job; the
  ported Bunraku tests "stages stop at twelve" / "capped at twelve" now assert that lists grow.
- seed-aging.test.ts: `deriveCurrentTurn`, `backfillSeedPlantedAtTurn` and the ripeness cases are not reducer
  behaviour (turn is stored; ripeness is momentum's) and were not ported here.
- types.ts needed no change.
