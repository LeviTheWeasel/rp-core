# M4 contract notes — unit `state`

Files owned: `src/agents/director/state.ts`, `test/director/state.test.ts`, `test/director/fit.test.ts`,
`test/director/fold.test.ts`, `test/director/fixtures-state.ts`.

## 1. Changes needed in files I do not own

1. **`src/session/entries.ts`** — keep `DirectorRecord = Record<string, unknown>` (opaque) on `MsgEntry.dir` /
   `PrepEntry.dir` / `CommitBody.dir`: the journal guard checks only "an object", so the typed record must
   come from `checkRecord(m.dir)`, never from a cast. The writer (integrate) needs a cast, because the
   types.ts interface has no index signature: `dir: record as unknown as Record<string, unknown>`
   (or change the field type to `object` — lead's call).
2. **`src/agents/director/types.ts`** (lead) — suggested additions, worked around locally:
   - a runtime list of `DirectorFailCode` (`DIRECTOR_FAIL_CODES`); state.ts keeps an exhaustive
     `Record<DirectorFailCode, true>` instead;
   - a `themes` limit in `STATE_LIMITS`; state.ts uses `READ_LIMITS.directiveList` (12).
3. **integrate** — after `directorAt(tree, U)`: `invalid > 0` → `notice{director_state_invalid}` once per
   session (D-115). The fitState result's `skipped` goes into `DirectorRecord.skipped`. On failure
   (`{...prev, turn}`) fitState still runs. `/director show` (cli) can take "last result
   (planned / reused / failed (code))" from `directorAt(...).record` (ok, code, reusedFrom).
4. **`src/session/view.ts:24`, `src/session/fold.ts:7`** — comments still say `directorAt` lives on
   PathView / in the fold; per A.8 it is `agents/director/state.ts directorAt(tree, fromId)`.
5. **ARCHITECTURE.md §7.3** — "В v1 … шаг 5 всегда укладывает состояние в потолок" is false for
   Russian (and more so CJK) texts; see §4.1.

## 2. Deviations from m4-decisions.md / the task text, and why

- `fitState(state, maxBytes = STATE_LIMITS.hardBytes)`: an optional cap (Bunraku had one) so tests can
  drive single steps. Callers pass nothing.
- `skipped` names (a limit or step is recorded only when it CHANGED something; a step that finds
  nothing to give up is not a skip):
  - limits: `limit:completed-arcs`, `limit:completed-seeds`, `limit:completed-hidden`, `limit:chapters`,
    `limit:stages`, `limit:reinforcements`, `limit:clues`, `limit:intentions`, `limit:themes`, `limit:text`;
  - steps (`FIT_STEPS`, in order): `fit:completed-5`, `fit:completed-0`, `fit:lists`,
    `fit:descriptions`, `fit:chapters`, `fit:working-sets`; still over after the last one →
    `fit:over-cap` (`FIT_OVER_CAP`, an addition so the trace shows it). All with `path:'state'`.
  - "completed → 5 then 0" is two steps with a size check between (as Bunraku's prune(5), prune(0)).
- Step 3 "descriptions → 160" = arc `description`, arc `nextBeat.description`, seed `payoff`, hidden-arc
  `description` (Bunraku's set + the next beat). Titles, hints, clues, stage titles stay at the limits.
- A person's items (`byUser`, `userAuthored`) and notes: never evicted and their TEXTS never cut (neither
  by the 300/80 limit nor by step 3); their stage / clue / reinforcement lists ARE capped (the model
  writes those; Bunraku's step 3 did the same). Working sets keep every person's item plus the newest
  N of the model's (Bunraku's hidden-arc rule, applied to arcs and seeds too).
- Hidden-arc titles are held to `arcTitle` (80) like arc titles (they are matched like arcs, D-108).
- Chapters: "completed" = every chapter other than `currentChapterId`, whatever its status (a
  non-current 'active' chapter is stale); newest by `createdAtTurn`, then `number`. No current id →
  every chapter counts.
- Intentions keep the FIRST n (the model's order of importance); stages, clues and reinforcements
  the newest n (they are appended).
- Texts: `clipText` cuts by CODE POINTS (never half a surrogate pair), at the last whitespace when that
  keeps ≥ half, and appends '…' within the limit. A cut text is never cut again (idempotent).
  `lastDirective` strings are held to 300 by the text limit; no step touches lastDirective.
- Chapter themes held to 12 (`READ_LIMITS.directiveList`) — not in D-61; needed so a chapter is bounded.
- Working sets keep the survivors in their list order (Bunraku re-sorted arcs and seeds by age).
- Whenever seeds are evicted, `lastPlantTurn = max(lastPlantTurn, newest plantedAtTurn of all seeds
  before the eviction)` — it stays when set, and is filled when an older state lacks it.
- `checkState`: unknown keys tolerated and NOT copied (the state the core writes back holds only what it
  understands and stays bounded; a writer that must keep a new field bumps REDUCER_VERSION); null
  optional fields read as absent; `byUser`/`userAuthored` false/null read as absent, any other non-true
  value refuses; a malformed `lastDirective` is DROPPED (only the self-audit reads it), not fatal;
  `nextId` is raised past the highest `arc-/seed-/hidden-N` (a counter behind its own ids would issue a
  duplicate, and the next read would refuse the whole state). Bounds (4x): arcs 136 (= 4 x (24 live +
  10 completed)), seeds 168, hidden 88, chapters 44, notes 64, stages 24, reinforcements 16, clues 24,
  intentions 20, themes 48. The 2 x hardBytes size is measured on the INPUT value. Never throws.
- `checkRecord` lenient parts: unknown code / transport / profile dropped; directive and analysis read
  field by field (`checkDirective`: an invalid field or element dropped, pacing → 'medium', urgency →
  'moderate'); strings in directive / analysis / skipped / model cut at 1 200 code points (4 x 300 —
  enrich may build strings longer than 300, so not 300); `skipped` ≤ 200, `attempts` ≤ 16 (outcome and
  finish ≤ 80 chars); missing `skipped` / `attempts` → `[]`; `reusedFrom` 1..80 chars.
- `directorAt` also returns `record` (the accepted record). It reads `msg` rows only (an `edit` row's
  `dir` is ignored: continue writes none, D-104); a `dir` on a USER message is ignored and not counted;
  a record of another reducer version counts in `invalid` (it is unreadable to this core, the notice
  fits). The walk is bounded by `tree.msgs.size` (guards a hand-made index with a cycle).

## 3. Additive API (src/agents/director/state.ts)

```ts
export function emptyState(): DirectorState;
export function ageOf(turn: number, from: number | undefined): number;          // max(0, turn − from); 0 if from missing/NaN
export function stateBytes(state: DirectorState): number;                        // UTF-8 bytes of JSON.stringify
export function clipText(text: string, max: number): string;                     // code points, word boundary, '…'
export const isFinishedArc: (a: DirectorArc) => boolean;                         // complete | abandoned
export const isPaidSeed: (x: DirectorSeed) => boolean;                           // payoffDelivered
export const isFinishedHidden: (h: DirectorInvisibleArc) => boolean;             // resolved | visible
export const FIT_STEPS: readonly ['completed-5', 'completed-0', 'lists', 'descriptions', 'chapters', 'working-sets'];
export type FitStep = (typeof FIT_STEPS)[number];
export const FIT_OVER_CAP: Skip;                                                 // {path:'state', why:'fit:over-cap'}
export function fitState(state: DirectorState, maxBytes?: number): { state: DirectorState; skipped: Skip[] };
export function checkState(value: unknown): DirectorState | null;
export function checkDirective(value: unknown): NarratorDirective | null;        // lenient, for a stored directive
export function checkRecord(value: unknown): DirectorRecord | null;
export function directorAt(tree: TreeIndex, fromId: string | null):
  { state: DirectorState; from?: string; record?: DirectorRecord; invalid: number };
```
Every result is a fresh object (checkState / checkRecord rebuild); fitState returns its input when
nothing changed and never mutates it.

## 4. What I could not do / open problems

1. **§7.3's promise that step 5 always fits does not hold for non-Latin text** (bytes, A.6). Measured:
   - a rich Cyrillic state at the D-61 maxima (every text at 300): ≈ 50 KB after step 5 (12 arcs ≈ 14 KB,
     16 seeds ≈ 10.5 KB, 6 hidden ≈ 15 KB, 3 chapters ≈ 5 KB, lastDirective ≈ 3 KB);
   - a verbose Russian planner over 300 turns (fit.test.ts VERBOSE): 287 of 300 states over 32 KB, max
     54.7 KB; even moderate Russian texts at the working-set sizes land at ~34–40 KB;
   - Chinese (3 bytes/char) with every text, theme and intention at its limit: 142 KB after step 5
     (measured; chapter themes alone ≈ 32 KB) — OVER the 2 x hardBytes read bound, so
     `checkState` would refuse the state the core itself just wrote: every turn the fold would fall back
     to an older ancestor (the Director stops advancing, `director_state_invalid` each session).
   - `lastDirective` is shrunk by no step; at readPlan's limits (12 per list x 300 chars) it alone could
     exceed 64 KB.
   As instructed, the state is returned as is with `fit:over-cap`; the tests pin it (fit.test.ts
   "a verbose Russian planner…", "at the D-61 maxima…"), so changing it is a visible decision.
   Proposal (lead): (a) a step 6 `last-resort` — drop `lastDirective`, every model text → 160, clues → 1,
   chapters → the current one, then working sets 8 / 10 / 4; and (b) make checkState's size guard a
   per-string bound (e.g. 4 x 300 code points) instead of 2 x hardBytes on the whole JSON, so what
   fitState writes is always readable. The `typical ≤ 16 KB` target is not reachable for Russian
   sessions at the working-set sizes.
2. The 300-turn run uses a test-local stand-in planner, not reduce.ts (another unit, unfinished when this
   was written). The integrate demo should repeat it with the real `applyPlan` and Russian scripts.
