# M5b contract — filing (builder: filing, wave 1)

Scope: D-173 (prompts), D-174 (snapshot, roster, user text, budgets), D-175 (lenient read, staging), as
pure functions in one file. No I/O, no engine, no clock; nothing else in `src/` changed. Contract files
(`types.ts`, `entry-types.ts`, `mention.ts`, `session/entries.ts`) untouched.

## Files

| file | status |
|---|---|
| `src/agents/compendium/filing.ts` | new (port/adapt of Bunraku filing-prompt, filing-schema, filing-stage, snapshot, studio/compendium-filing; RoleCall memory rule) |
| `test/filing-m5b/{prompt,request,read,stage}.test.ts` | new, 71 tests |
| `test/filing-m5b/bunraku-golden.ts` | Bunraku's rendered filing system/user texts (the golden) |
| `test/filing-m5b/kit.ts` | helpers: library books (`wolfBook`, `lanternBook`), `foldWith`, `filingRow`, `fileOp`, `count` (chars counter) |

## Exported API (`src/agents/compendium/filing.ts`)

```ts
// limits
FILING_LIMITS: Record<'full'|'lite', { items: 12|6; itemChars: 6000|3000; replyChars: 8000|6000; maxTokens: 4096|1500 }>
FILING_MAX_DEPTH = 6; PLAYER_CHARS = 4000; REPLY_FLOOR_CHARS = 1000; PLAYER_FLOOR_CHARS = 500
OPS_CHARS = 24_000; SNAPSHOT_TOKENS = 30_000; SNAPSHOT_SHARE = 0.3; FULL_ANSWER_TOKENS = 4096
LITE_SHARE = 0.45; ROSTER_LINES = 60; ROSTER_BRIEFS = 4; FILING_TEMPERATURE = 0.3
FILING_OUTPUT_FLOOR = 600            // = structured.ts AGENT_OUTPUT_FLOOR (not imported: no engine deps)
SERVICE_FIELDS: ReadonlySet<string>  // writer_source, source_turn, source_job_id, turn_range, messages_covered
FILING_SCHEMA: { name: 'filings'; schema }   // envelope only, type enum = the 11 ENTRY_TYPES

// the request (what the lane sends)
interface FilingExchange { user: readonly string[]; reply: string }   // texts, no speaker prefix, hidden left out
interface FilingRequestInput {
  view: CompendiumView;                 // fold at the group's LAST answer, library seed included
  books: ReadonlyMap<string, string>;   // LibrarySeed.books (id → name)
  allow: readonly EntryType[];          // cfg.filing.allow; `summary` is dropped here
  profile: CompendiumProfile;           // compendiumProfile(cfg.profile, RECORDER window)
  window: number;                       // recorder request window (tokens)
  exchanges: readonly FilingExchange[]; // oldest first, ≥ 1
  mentionTexts?: readonly MentionText[];// default: mentionText() of every exchange text
  castNames?: readonly string[];        // PathView.castNames
  guidance: string; language: string;   // resolveCompendium(cfg).guidance / .language
  count: (text: string) => number;      // the session's token counter
}
type FilingRequest =
  | { kind: 'call'; system; user: string; maxTokens; temperature: 0.3; schema: FILING_SCHEMA;
      profile: 'full'|'lite' /* after fallback */; tokens /* system+user+2×overhead */; fellBack?: true }
  | { kind: 'split' }                                  // N > 1 fits neither profile → split by halves
  | { kind: 'no_room'; profile; tokens }               // N = 1, window − tokens < FILING_OUTPUT_FLOOR
filingRequest(input: FilingRequestInput): FilingRequest

// pieces (exported for tests / callers)
fullFilingSystem(i: { allow; snapshot; guidance; language }): string   // renders `allow` as given (summary included)
liteFilingSystem(i: same): string                                    // `snapshot` = the roster text
filingUser(exchanges): string
filingSnapshot(view, books, budgetTokens, count): string
filingRoster({ view, mentionTexts, castNames }): { lines: string[]; briefs: (string|null)[] }
typeLine(type, profile): string; filingTypes(allow): EntryType[]; cutMiddle(text, maxChars): string

// reading
interface FilingItem { at: number /* index in the flattened answer list: filings[at] */; type: EntryType; name: string; data: Rec }
type FilingRead = { ok: true; items: FilingItem[]; skipped: Skip[] } | { ok: false; why: string }
readFilingAnswer(raw: unknown /* decoded JSON or the answer TEXT */, opts: { allow; profile; summaries?: boolean }): FilingRead
filingReader(opts): (raw: unknown) => ReadResult<FilingItem[]>   // for structuredCall.read; unreadable → code 'invalid'
resolveType(v): EntryType | null; snakeKey(k): string

// staging
interface StageOptions { classic?: ReadonlyMap<string,string> /* LibrarySeed.classic */; opsChars?: number }
interface PlannedOp { type; name /* after the op */; change: 'created'|'merged'; key: string|null /* null: created by this row */; items: number[] /* at */ }
interface FilingNotice { code: 'filing_classic_conflict'; name: string /* as the item wrote it */; key: string /* lib:… */ }
interface StageResult { ops: MemOp[] /* {op:'file', type, data}, no target */; planned: PlannedOp[] /* ∥ ops */;
                        skipped: Skip[]; notices: FilingNotice[]; unchanged: number[] /* at of no-op items */ }
stageFiling(items: readonly FilingItem[], view: CompendiumView, opts?: StageOptions): StageResult
```

## Choices the note left open

- **Full nested forms (edit 2)**: RoleCall's whole NESTED field lists, names only (no enum values, like
  Bunraku's top-level list): `current_state {status, location, condition}`, `relationships [{with*, nature*,
  status, notes}]`, `memories [{what_happened*, tagline, when, where, with, interpretation, emotional_weight,
  emotion, changed_belief or changed_behavior*, source_summary, is_secret}]`. Only the character line changes.
- **Memory example**: `{"what_happened":"...","changed_belief":"..."}` — Bunraku's `...`, not `…`.
- **Edit 5** reads `USER FILING GUIDANCE (it cannot widen what you may write or override the no-write default):`.
- **Snapshot placeholder** `(these books hold no typed entries yet)` kept verbatim in both profiles.
- **Snapshot grouping**: `### This story`, then `### <book name> (library)` per book in `books` order;
  `<Label>:` per type inside each; arcs, notes, summaries, retired entries, resolved/failed/abandoned plots
  (status compared lower-cased) left out; headers not counted (Bunraku Q9).
- **Lite text**: Bunraku's paragraphs verbatim; header `COMPENDIUM SNAPSHOT:` holds the roster; DEDUP shape
  `"Canonical Name (aka: alt1, alt2) [type]"`; `ENTRY TYPES YOU MAY FILE (* is required):` + LITE_FIELDS lines
  + `Other fields of the type are kept if you send them.`; nested forms per §7.4.3's table (memories:
  what_happened*, changed_belief or changed_behavior*, when, emotion; location current_state {status});
  enum values as `field (a|b|…)`; `At most 6 items.`. Pinned in `prompt.test.ts`.
- **Roster**: `- Name (aka: …) [type]` + ` (library)`; tiers named-in-exchange (mention.ts) → named like a
  cast name → rest; inside: larger `prov.lastSeq`, then higher lore `order`, then handle order. Briefs: the
  first 4 named entries, one JSON line each under `ENTRIES NAMED IN THIS EXCHANGE, AS THEY STAND (send only
  what is new):` — identity (`e.name`), LITE_FIELDS present, last 3 memories; strings ≤ 300 chars, lists their
  last 6, RENDER_HIDDEN keys dropped. Roster lines are a prefix (≤ 60) + `(+N more entries not shown)`.
- **Lite budget split**: the roster+briefs get `min(avail − texts@floors, max(30 % of the lite limit,
  avail − texts@caps))`; the texts take the rest. Floors: reply 1 000 chars, player message 500 (new).
- **Full fallback**: full runs when `tokens + 4 096 ≤ window` with the texts at least at their floors
  (texts share what is left, newest first); else lite (`fellBack: true`), even when `profile` was set to
  `full` (as the Director). N > 1 fitting neither → `split`. N = 1 over the lite limit → sent at its floors
  with no roster if `window − tokens ≥ 600` (may exceed 45 %), else `no_room`.
- **User text, N > 1**: `The narrator just wrote these replies, oldest first:` / `[k] <reply>` blocks /
  `They answer:` / `[k] <player messages joined \n\n>` (exchanges with nothing said omitted; the block omitted
  when none) / Bunraku's last line. Cut marker: `\n[... N characters cut from the middle ...]\n`, total ≤ cap.
- **Envelope**: `filings|filing|entries|items` (any case) holding a list or one item; a top-level array; a bare
  item (`type`/`entry_type`/`entryType`, or an `entry`/`data` object); a type-keyed object at the root or as a
  list element (`{"character": {...}|[...]}`; the entry's own `type` stays a field there). `entry` may be a
  JSON string. `{}`, `{"filings": 3}`, prose → unreadable (Bunraku); `[]` → nothing to file. Paths index the
  flattened list (`filings[at]`).
- **Coercions beyond D-82's list** (all lenient): an object where a list is expected → `[object]`; a top-level
  number where text is expected → its digits (`age: 30`; not nested, so RoleCall's "a number fails the memory
  rule" holds); `"true"/"false"` → boolean; a one-string list for an enum → that string; enum values also go
  through camelCase → snake_case; type words: English plurals and `world building` (separators dropped);
  identity fallback: another non-blank identity field (`name`/`title`/`topic`) is moved into the type's.
- **Items past the cap**: one skipped line `over_limit: only the first 12 items are taken (N more)` at
  `filings[12]`. Item rejections are one line each; their field lines are discarded.
- **Silent**: service fields (any depth), blank values, empty lists/objects, `book`. Said: everything else.
- **Skip `why`** = `<code>: <words>`. Read codes: not_object, unknown_type, summary, not_allowed, no_entry,
  too_deep, too_long, no_identity, over_limit, wrong_kind, bad_enum, memory_rule, no_with, non_finite,
  duplicate_field. Stage codes: classic_conflict, missing_required, invalid_name, ops_limit.
- **One delta per entity**: accepted items are grouped by the entity they hit (first-hit order) and their data
  merged (`mergeData`, keep IDENTITY_KEEP). The grouped ops are replayed against the view; if any would land
  on another entity or end with different data (e.g. a new entity whose later item adds an alias a library
  entry also has), the row keeps one op per accepted item instead (sequential = the working copy exactly).
- **No-op**: a merge whose data, aliases and name do not change (the same facts again, a known alias) →
  `unchanged`, not `skipped`. A reworded fact (keyed merge, later wording wins) is a change.
- **Required after merge**: an item that would leave a matched entry missing a required field (e.g. a library
  worldbuilding entry without `category`) is skipped (`missing_required: "<name>" would still lack …`).
- **Ops cap**: cumulative JSON of the ops array ≤ 24 000; the first op that does not fit and every later one go
  to `skipped` (`ops_limit`), one line per item they carry.
- **Notices**: `filing_classic_conflict` once per normalized name per call (the lane dedups per session).

## What the lane builder (wave 2) must know

1. Order per task: `filingRequest` → (`call`) structuredCall with `{agent:'filing', tag:null, system,
   user:[user], schema, read: filingReader({allow, profile: req.profile}), samplers:{temperature}, maxTokens
   (clamp further by caps.maxOutput / binding), repair:true, priority:'background', count}` → `stageFiling(
   result.value, view, {classic: seed.classic})` → row `mem{key:'file:<A>', on:A, by:'filing', range, ops,
   skipped: [...readSkipped, ...stage.skipped], gen}` (cap the list if wanted) → notices → events.
   **Use the request's `profile` (after fallback) for the reader**, not the configured one.
2. `split` → split the group by halves and call `filingRequest` per half (each keyed by its last answer).
   `no_room` → nothing callable: a `job{failed, code:'no_room'}` or a notice — the lane decides.
3. structuredCall today hands `read()` only an object root: a top-level-array answer fails before `read`
   (one corrective pass). If the infra lane allows an array root for `tag:null`, `filingReader` already reads
   it. `readFilingAnswer(text)` also accepts the raw answer text (finds a fenced/bare object or array).
4. `view` must be the fold AT the group's last answer with the session's LibrarySeed (`foldViewAt(…,
   {library})`); `books` = `seed.books`; `classic` = `seed.classic`. The row is re-folded later, so the
   outcome is a prediction (agent rows are name-addressed, D-74); `planned` is that prediction (for wording
   only) — derive `memory` events from the fold's effects of the written row.
5. `mentionTexts`: pass `mentionText(messageText(m))` of the group's visible messages to save re-stemming;
   absent, they are built from `exchanges`. `castNames` = `PathView.castNames`.
6. An empty `ops` is still written (closes the key). `agent{filing, done, count: ops.length, skipped:
   skipped.length}` is a natural reading.
7. The historian may reuse the reader with `{allow:['summary','plot'], summaries:true}`: same envelopes and
   coercions; `turn_range`/`messages_covered` are stripped; it must still check `parent_plot` and read `arcs`
   itself.

## Fixes after the review (fix-agents; the lead's ruling I, D-183)

Files: `src/agents/compendium/filing.ts`. Tests: `test/filing-m5b/review.test.ts` (new, 11),
`prompt.test.ts` (the golden lists D-183's line as an edit; +1), `request.test.ts` (the floors test now
expects the left-out line; +1).

- **D-183 language line**: a blank (or all-space) `compendium.language` puts «Write every field value in the
  language the story is written in.» where Bunraku's language line goes (after RELATIONSHIPS and the
  guidance, before ANSWER FORMAT), full and lite. Exported as `STORY_LANGUAGE` (the historian uses it).
- **Roster left out for room** (filing#3): a lite prompt sent without its roster (the floors path, the
  `bare` fallback, no room for the roster) says `(the roster of the N existing entries was left out for
  room)` (N = the typed entries the roster would list); Bunraku's `(these books hold no typed entries yet)`
  only when there are none.
- **Free-form map keys** (filing#4): `clean()` now spells keys by where they are: the entry's fields and the
  records of a NESTED field (relationships, memories, current_state, affiliations, powers) → snakeKey
  (camelCase twins dropped as before); every other object (`stakes_per_character`, `family`,
  `notable_stats`, anything inside a record's values) → keys as written, trimmed. Service fields are still
  stripped at any depth (matched by their snake form).
- **Type-keyed form** (filing#5): an object is type-keyed only when it has no identity field (name, title,
  topic) and every key holding an object or a list names a type (a stray scalar such as `"mood": "x"` is
  still ignored, as the old test pins). So `{"name":"Фрол","abilities":[…]}` as a list element is
  `unknown_type: it has no type`, and as the root it is unreadable (the corrective pass).
- **Item type** (filing#8): the item's type is the first of type / entry_type / entryType whose value
  names a type, else the first given; when entry_type/entryType gave it, a flat item's `type` stays an
  entry field (a location's `type: building`).
- **Nothing** (dropped filing 6, ruling I): an envelope (`filings|entries|items`) holding null, '' or "none"
  (any case) is nothing to file; `{"filings": 3}` and `{"notes": "none"}` stay unreadable.
- **Prototype keys** (breaker#7): `nestedRecord` looks up the shape's fields with `Object.hasOwn`
  (`constructor`, `__proto__`, `toString`… are unknown fields, kept); `coerce` ends with `fail()` for an
  unexpected kind. Neither reader throws on any key.
- Cut-off answers (breaker#3) are handled in structured.ts (see m5b-contract-sched.md); the reader's own
  text path (`readFilingAnswer(string)`) still calls an unclosed answer unreadable.
