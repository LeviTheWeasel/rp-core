# M4 contract notes — plan (`src/agents/director/plan.ts`)

Files: `src/agents/director/plan.ts`, `test/director/plan.test.ts` (47 tests),
`test/director/plan-tolerance.test.ts` (80 tests). types.ts and mood.ts untouched.

## 1. Changes needed in files I do not own

- **integrate (call.ts).** structuredCall's `read` = `(raw) => readPlan(raw, { lite: profile === 'lite' })`;
  `schema = { name, schema: lite ? PLAN_SCHEMA_LITE : PLAN_SCHEMA }`. The json_schema `name` must match
  `[A-Za-z0-9_-]{1,64}` (e.g. `'director_plan'`); plan.ts exports no name. The tagged `schemaText` for
  prompt.ts = `JSON.stringify(lite ? PLAN_SCHEMA_LITE : PLAN_SCHEMA)` (D-110).
- **structured / integrate.** readPlan does NOT unwrap a `{"name": "commit_planning_round"|"plan",
  "arguments"|"args": {…}}` envelope (D-99 puts that in the `<plan>` reading). An envelope at the root
  of a structured answer reads as `missing_directive` with the message
  `the plan has no directive (name: unknown key; arguments: unknown key)` → correction pass. If that
  shows up in practice, unwrap it before `read` (one level), not in readPlan.
- **reduce (applyPlan)** — what the reader guarantees:
  - `arcUpdates[].arcId`: non-empty, ≤ 300; it is the first non-empty of `arcId`, `id`, `title`
    (so it may be a title, already cut at 80 then). `title` ≤ 80, NOT cleaned (cleanTitle is yours).
  - `chapterUpdate` always present; `title` is `''` when the model sent none (also for `start_new`):
    the reducer must name a first / new chapter itself (Bunraku's "The Story Begins" now lives with you).
  - `seedUpdates[].title` non-empty; `action` always valid; `scope`, `payoffHorizon` only when valid.
  - `invisibleArcUpdates[].arcId` = `arcId ?? id`; `title` ≤ 80; `action` always valid.
  - `markNextBeatDelivered` is `true` or absent; `nextBeat.targetTurn` an integer ≥ 0 or absent.
  - `analysis.intentions` are complete `DirectorIntention`s, ≤ 10 (lite 3), order as sent; storing
    5 is yours / fitState's.
  - Every text is trimmed and ≤ 300 UTF-16 units (≤ 80 for arc and hidden-arc titles), never cut
    inside a surrogate pair; empty strings never appear.
- **prompt (PLAN_RULES).** Nothing required. The schema text no longer says "mood and pacing are
  required"; the directive description says "Set at least one field." Keep PLAN_RULES consistent
  (Bunraku's DESCRIPTION also asks for a chapterUpdate every turn; the schema root does not require it).
- **types.ts (lead).** Nothing wrong. Two notes: READ_LIMITS has no cap for analysis / chapter string
  lists (seedsPlanted, seedsPaidOff, unexpected, suggestedActions, themes, objectives, hints) — I use
  `READ_LIMITS.directiveList` (12) for all of them (Bunraku: 12, suggestedActions 8). No
  `PLAN_SCHEMA_NAME` constant exists (see integrate).

## 2. Deviations from m4-decisions.md (and why)

- **Arc key fallthrough.** D-107 says `arcId ?? id ?? title`, empty → skipped. I take the first
  NON-EMPTY of the three: `{arcId: "", title: "The Bell"}` is read by its title (RoleCall's L2 filled
  `arcId: ""` and its executor then used the title; strict `??` would drop a new arc). Empty all → skipped.
- **Hidden arcs also read `id`** as an alias of `arcId` (same drift as visible arcs).
- **A plain-string `nextBeat`** is its description (`"nextBeat": "the door opens"`); a JSON string is decoded.
- **A lone string in a string-list slot** (`themes: "rain"`, `intentions: "raise the stakes"`) is a
  one-item list; a string starting with `[` is decoded with looseJson. Object / list slots holding
  `''`, `"null"`, `"none"`, `"undefined"` (any case) are absent silently.
- **A lone object in a list slot** (`arcUpdates: {…}`) is NOT wrapped into a list: skipped
  (`not a list`), as tools/args.ts refuses that wrap too.
- **Cuts and clamps are in `skipped`** (`cut to 300 chars`, `clamped to 10`): the Skip type says
  "dropped or changed". Case-fixes and silent defaults (absent pacing / urgency / chapter action) are not.
  An invalid enum that falls back to a default (pacing → medium, urgency → moderate, intention
  priority/target, chapter action → none) IS skipped with `unknown value "…"`.
- **One text limit (300)** for every text, names included (Bunraku: character 120, arcName 200,
  mood 200, chapter title 120, intention type 60). Arc titles (visible and hidden) 80.
- **Non-string text values are not coerced**: `mood: 0` → skipped `not a string`, mood absent (the
  RoleCall test wants it absent). `markNextBeatDelivered: "true"` IS read as true.
- **Lite reads the full shape.** `lite` only changes the caps (arcDirections 3, characterBeats 3,
  callbacks 2, intentions 3); include / avoid / dialogueGuidance / invisibleArcUpdates are read if a lite
  model sends them anyway (dropping valid content gains nothing).
- **Schema `required`.** Root: only `directive` (task). Items keep Bunraku's lists except the
  directive (none, D-62) and hidden arcs (title, action; §7.3). So `arcDirections.items` still requires
  `urgency` and full `seedUpdates.items` still require `scope`/`relatedArcId` (guidance only; the reader
  defaults/omits them). Lite seeds require `[title, action]` (scope/relatedArcId are not in the lite subset).
- **`arcType` added to the full arc-update schema** (neither source had it; the lite spec and rev. 6
  need it). Description: "Kind of arc. Set it when you add a new arc."
- **The refusal message** names up to 4 skips: `the directive sets no usable field (type: unknown key;
  description: unknown key; …)` — RoleCall's VVS-130 key preview, for the correction pass. It can exceed
  200 chars; structuredCall cuts it (D-99).

## 3. API (additive; nothing else exported)

```ts
export const PLAN_SCHEMA: JSONSchema;        // root required ['directive']; no additionalProperties
export const PLAN_SCHEMA_LITE: JSONSchema;   // §7.3 subset, maxItems 3/3/2 and intentions 3
export function readPlan(raw: unknown, opts: { lite: boolean }): ReadResult<PlanningRound>;
export function hasDirectiveContent(d: NarratorDirective, pacingSent: boolean): boolean;
```
- `readPlan` never throws. Failures: `{ok:false, code:'invalid', message:'the plan is not a JSON object'}`
  (root not a plain object); `{ok:false, code:'missing_directive', message}` with message
  `the plan has no directive (…)` / `the directive is not a JSON object (…)` /
  `the directive sets no usable field (…)`.
- `skipped`: ≤ 20 entries, then `{path:'skipped', why:'+N more'}`. Paths: `directive.include.themes[2]`,
  `arcUpdates[1].status`, a root key as `focus`. Reasons: `unknown key`, `not a string`, `not an
  object`, `not a list`, `a string that is not a JSON object|list`, `unknown value "…"` (≤ 40 chars
  quoted), `no <field>`, `<field> is not a string`, `action: unknown value "…"`, `no action`,
  `no arcId, id or title`, `cut to N chars`, `clamped to N`, `not a number "…"`, `not a turn number "…"`,
  `not a boolean`, `N over the limit of M`. Keys in paths are cut to 60 chars.
- `hasDirectiveContent(d, pacingSent)`: true for any non-blank mood / narrativeGoal / endingHook, a
  non-empty arcDirections / characterBeats / callbacks / dialogueGuidance, include / avoid with a list
  holding a non-blank item, sceneGuidance with a non-blank setting / atmosphere or a finite
  tension_level (0 counts), or `pacingSent && pacing !== 'medium'`. render / persona filter may reuse it
  (e.g. to see whether a filtered directive became empty — pass `pacingSent: true` there).

## 4. Not done / open

- **Schema size.** Compact JSON: full 13 167 chars ≈ 2 920 o200k tokens; lite 7 997 chars ≈ 1 772
  tokens (the descriptions are most of it). For the tagged lite profile (windows < 24 576) that is a
  notable share; a description-free lite schema text would be ~1/3 of that. Lead's call; nothing in
  the decisions asks for it, so I kept the ported texts.
- No enum alias table (`personal` → `player`, Russian enum words…): skipped per D-107 / D-111.
- Not checked against a live server: llama.cpp's json-schema-to-grammar and an OpenAI-compatible
  non-strict endpoint. The test pins the subset (type/properties/items/required/enum/description/maxItems,
  string enums, `required` ⊆ `properties`).
- The GLM "chapters survive an unusable answer" case is runDirector's (integrate's tests).
- Full suite and tsc: see the summary returned to the lead.
