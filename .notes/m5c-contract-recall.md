# M5c contract — recall (wave 1: D-197…D-200 as pure functions, the structuredCall hook)

Files: `src/agents/compendium/recall.ts` (new), `src/agents/structured.ts` (the `rawRead` hook only),
tests `test/recall-m5c/` (76 tests: index 16, prompt 16, read 20, record 12, structured 12).
Nothing here touches the engine, the lane, the scheduler, the selector or the config; it is all pure.

## API (`src/agents/compendium/recall.ts`)

### Constants
- `RECALL_LIMITS[profile]` = `{maxEntries, contextMessages, maxTokens, indexTokens, indexShare, talkTokens, talkShare}`:
  full `{10, 20, 2000, 20 000, 0.25, 8000, 0.2}`, lite `{4, 6, 200, 2000, 0.15, 1500, 0.2}`.
- `INDEX_DEPTH` 2, `SHORTLIST` 40, `LEX_MESSAGES` 6, `LITE_MESSAGE_CHARS` 1200, `LITE_REQUEST_TOKENS` 6000 /
  `LITE_REQUEST_SHARE` 0.4, `LITE_GUIDANCE_CHARS` 1000, `MAX_RECALL_GUIDANCE` 8000, `MAX_REASON` 200,
  `REASONING_ROOM` 1024, `RECALL_TEMPERATURE` 0.3, `ENUM_HANDLES` 200, `LITE_ANSWER_FLOOR` 100, `TALK_CUT_FLOOR` 64,
  `RECALL_DEADLINE_SEC` `{local: 30, remote: 20, prefetch: 60}`, `PREFETCH_LINE` (verbatim D-198 text),
  `RECALL_SYSTEM` (Bunraku verbatim), `LITE_RECALL_SYSTEM` (new, ~80 o200k tokens).
- `recallSettings(resolved.recall, profile)` → `{maxEntries, minEntries, contextMessages}` (by-profile defaults
  filled; minEntries held to maxEntries).
- `recallDeadlineMs({prefetch, local, timeoutSec?})` → structuredCall's `budgetMs` (D-204; timeoutSec overrides all three).

### Index (D-197)
`recallIndex({view, vis?, slotIds?, profile, window, count, uText?, windowTexts?, lastTexts?, castNames?, categoryOf?})`
→ `RecallIndex {profile, text, handles: Map<'eN', key>, names: Map<normalizedName, key|null>, candidates, shown, omitted, truncated}`.
- `vis`: `visibilityAt(view, tree, U.id)` for a sync turn, `visibilityAt(view, tree, null)` at prefetch time (A(n) is
  the nearest answer). Absent = nothing hidden. Freshness is `visibleCopy` (a hidden entry is not a candidate).
- `slotIds`: the nearest ancestor answer's `trace.recap.ids` (the predicted {{recap}} slot, D-197).
- `window`: the RECALL binding's window; `count`: the session counter (`estimateTokens(…, ctx.counter)`).
- Lite only: `uText` (U's text, '' in a prefetch), `windowTexts` (visible messages before U, oldest→newest; tier 2
  reads the last 4), `lastTexts` (the last messages; lexScore reads the last 6), `castNames` (PathView.castNames).
- `shown === 0` → no call: write `skippedRecord({profile, code: 'empty_index', omitted})`.
- `truncated` → `notice{recall_index_truncated}` once per session (the engine keys it).

### Request (D-198)
`recallRequest({index, conversation, profile, window, guidance, prefetch, minEntries, maxEntries, contextMessages, reasoningOff, count})`
→ `{profile, system, user, maxTokens, temperature, schema, repair, messages, tokens, fits}`.
- `conversation`: `{role, text}[]` oldest first, visible messages only (no hidden ones), up to and including U for
  sync, up to A(n) for a prefetch; text = `messageText` (no speaker prefix is added by recall; Bunraku printed
  `[role]: content`). The request takes the last `contextMessages`.
- `reasoningOff`: true only when the caps confirm reasoning can be turned off AND the adapter sends the switch
  (the "+1 024" rule). The predicate is not exported by `openai-chat.ts` yet (wave 2).
- `fits === false` → do not call (the window leaves the answer less than AGENT_OUTPUT_FLOOR full / 100 lite).
  `maxTokens` is already clamped to `window − tokens`.
- structuredCall input: `{agent:'recall', tag:null, schema: req.schema, read, rawRead, system: req.system,
  user:[req.user], transport: chooseTransport(caps), samplers:{...binding samplers, temperature: req.temperature},
  reasoning: (lane/director reasoningFor), maxTokens: req.maxTokens, repair: req.repair, count, budgetMs:
  recallDeadlineMs(...), priority: sync 'interactive' / prefetch 'background', callKeyPrefix}` with
  `{read, rawRead} = recallReader({handles: index.handles, names: index.names, maxEntries, profile})`.
- Top-up (full only): `needsTopUp(first.value, {profile, minEntries, maxEntries})` → a second structuredCall with
  `user: topUpUser(req, first.value, minEntries)` (same system/schema/maxTokens, `repair: false` is reasonable,
  budgetMs = what is left of the deadline). Pass both results to `recallRecord` (it applies `betterRead`).

### Reading (D-199)
- `readRecall(raw: string | unknown, {handles, names, maxEntries, profile})` →
  `{ok:true, picks:{ref,handle,reason?}[], unknown, repeated, trimmed, byName, salvaged, cutOff?}` |
  `{ok:false, code:'no_output'|'undecodable'|'invalid', why}`. Expects think-free text (structuredCall cuts tags).
- `recallReader(opts)` → `{read, rawRead}` for structuredCall.

### Record (D-200)
- `recallRecord({source:'sync'|'prefetch', profile, omitted, model:'conn:model', transport, first, topUp?, ms?, basis?})`.
  Read → `recalled`/`empty` with the run's source; failure → `failed`, source `lexical`, code
  (invalid/missing_directive → `undecodable`, preempted → `aborted`); LITE reading failure (no_output, undecodable,
  invalid) → `empty` with its code, source kept (§7.4.2 "nothing usable → empty picks"). `calls` = every TraceCall row
  (retries and the top-up included); `usage` = summed `inputTotal/outputTotal` when any call reported usage.
- `skippedRecord({profile, code:'empty_index'|'no_connection', omitted?, model?, basis?})`, `missedRecord({profile, basis?})`
  (status skipped, source lexical, code prefetch_missed) — for onMiss = lexical. A miss followed by sync writes the
  sync run's record (no miss code on it).
- `reusable(rec)` (recalled|empty), `reusedRecord(prev, from)` (0 calls, `source:'reused'`, `reusedFrom: from`; ms,
  usage, basis, code dropped; null when not reusable), `recallPicks(rec)` → keys in recall's order (select.ts tier 1).
- `checkRecallRecord(stored)` → `RecallRecord | null` (the guard entries.ts names; required fields strict, bad optional
  fields and picks dropped, reasons cut to 200, ≤ 64 picks).

## `src/agents/structured.ts`: the `rawRead` hook
- `StructuredInput.rawRead?: (answer: {text, finish?}) => RawRead<T>`; `RawRead<T>` exported; `readRawAnswer` exported.
- Used only when `tag === null && rawRead !== undefined`; every other caller reads exactly as before (filing,
  historian, Director untouched; their path is the same expression as before).
- With rawRead: the reader gets the visible text after think tags are cut (`answerOf`; the reasoning stands in only
  for a blank text when `caps.reasoning.answerInReasoning`); JSON in the reasoning is never searched; finish
  `length` with a blank text and some reasoning → `undecodable` ("the answer was cut off while it was still
  reasoning") before rawRead is asked. `cutOff` when rawRead says so or finish was `length`. Failures are the
  usual correctable codes, so the corrective pass runs (full) with rawRead's message as the reason.

## Choices (deviations to list; say if any should change)
1. **Schema field is `entry_ids`, not `picks`.** D-199 says "the schema has `picks` and an optional `reasons`". The
   verbatim full prompt and the lite prompt both ask for `{"entry_ids": …}` and §7.4.2 says `{entry_ids: string[]}`;
   a grammar forcing `picks` would contradict the prompt. The reader accepts `picks` anyway. One line in `recallSchema`
   if the lead wants `picks`.
2. Full index heading: `=== World Knowledge (N entries) ===` (Bunraku's single-book header shape), one deriveTree over
   session + library candidates; no per-book headings, no `bookDisplay`/`detail`/`depth` settings.
3. Lite shortlist: tiers 0 and 2 via `select()` (no recall picks, tier 3 excluded), then lexScore with a query of
   word stems (≥ 3 letters, stop and function words out, no phrases) over docs {title: name, keys: aliases, text:
   tagline, rank: prov.lastSeq}, then every remaining candidate newest change first (so a small Compendium is listed
   whole). `omitted` counts only shortlist lines cut by the budget (not entries outside the 40).
4. The conversation fit: newest first; a message that does not fit whole is cut head+tail (filing's `cutMiddle`
   marker) when ≥ 64 tokens are left, the newest always (cut to the cap); older messages then dropped. Lite also cuts
   each message to 1 200 chars first and holds the conversation to what the 40 % ceiling leaves (≥ 64).
5. Guidance: the session's `compendium.recall.guidance` only (no Guide); full 8 000 UTF-16 units (no split pair),
   lite 1 000 chars. Lite has no HARD REQUIREMENT and never tops up (its answer line says "an empty list is fine").
6. Top-up echo: structuredCall has no assistant turn, so the second user message is
   `Your last answer: {"entry_ids":[…]}\n` + Bunraku's moreNudge (listed edit).
7. Reader leniency beyond D-199's list: `entry_names` (RoleCall) as a list key; keys compared case/`_`-insensitively;
   a string list value split on `,;\n`; `null` = empty; handles case-insensitive and zero-padded (`E1`, `e01` → e1); an
   index line copied whole (`[e3] Name - tag`) reads as e3; object items also take `entry_id`/`ref`/`key` and
   `entry_name`/`title`, reason also `why`; a cut-off JSON keeps its closed items (`cutOff`); an example value that
   picks nothing does not hide a later answer. No fuzzy names (RoleCall's Dice not ported).
8. Salvage counts unknown handles seen in prose; repeats in prose are not counted as `repeated`.

## Open questions for the lead / wave 2
- Q1 `picks` vs `entry_ids` in the schema (choice 1).
- Q2 Lite reading failure: I write `status:'empty'` + code with the run's source (spec "record ok"). If the lead
  prefers `failed`/lexical, it is the `READING` set in `recallRecord`.
- Q3 A `fits:false` request (no room): no RecallRecord code exists for it; `skippedRecord` takes only
  `empty_index|no_connection`. Suggest the integrator writes no record (or add a code to the contract type).
- Q4 `reasoningOff` needs an exported "adapter sends thinking off" predicate (rpcore.md §7); not in my files.
- I did not run `test/structured/*` (rule: only my tests); the hook does not change their path, but the integrator
  should run them once with the full suite.

## Fix round after the review (fix-core; the lead's ruling K, D-208)

Files: `src/agents/compendium/{recall,filing,historian}.ts`, `src/agents/structured.ts`; tests
`test/recall-m5c/review.test.ts` (new, 23), `test/structured/opening.test.ts` (new, 13), one test each added to
`test/filing-m5b/request.test.ts` and `test/historian-m5b/prompt.test.ts`; expectations changed in
`test/recall-m5c/{read,prompt}.test.ts` (prose → `undecodable`; the min-cap test uses a 10-entry index).

### What changed
- core#2 (reader): `scan` no longer stops at an opener that never closes. It remembers the first one (its rest read
  whole when it ends with the closer — the stray-quote case — else its text as the cut) and goes on. Order of
  answers: whole values (after an unclosed opener only objects of the recall shape count; a list or other object
  there is a piece of the unfinished answer), then the rest-read-whole, then the cut (only when it picks
  something), then the prompt's example; the first with picks, else the first. A cut that closed no item is no
  longer an empty success: it falls through to salvage, then `undecodable`.
- core#7: a value equal to the prompt's example (canonical JSON of `EXAMPLE[profile]`, the text the prompt shows)
  is used only when no other answer exists.
- core#6: `resolve` → a list of hits: a handle alone; else an exact name (`E3 Lamp` is that entry); else several
  handles joined by commas/blanks/`and|or|plus|и|или|&` all count (unknown ones counted); else the handle an index
  line starts with (`[e4] Route E66` stays one pick).
- core#9: an object item with no id/name field whose keys are handles (`{"e1": "present"}`) gives each handle, its
  value as the reason (full).
- core#4: `recallIndex` meets each key once (listed or omitted); heading counts are `listedCounts` (entries listed
  under the group and its subgroups, an entry counted under the first group that holds it). `Group.count` is gone.
- core#5: the lite lexScore query drops `DIRECTOR_STOP` (D-46 + D-108 function words, possessive too) besides the
  Russian marked words; a spaceless-script run becomes overlapping character pairs, kept only when some candidate's
  name or alias holds the pair; lexScore's results are re-sorted inKey → matched → rank → index (a name hit first).
- core#8: `recallRequest` holds the full minimum to min(minEntries, maxEntries, index.shown) and returns it as
  `RecallRequest.minEntries` (lite: 0). `needsTopUp(read, {profile, minEntries, maxEntries, shown?})` — `shown`
  optional (absent = no cap; the engine must pass it, see below). `topUpUser`'s nudge never asks past
  `request.minEntries`.
- core#10: removed rather than listed — the full prompt's conversation is Bunraku's: the last `contextMessages`
  messages, blank ones too, texts untrimmed. Lite (a new text) keeps dropping blank messages and trimming.
- cli#8 (reader side): text that holds no readable selection is `undecodable` (why: 'no JSON object was found');
  `no_output` only for a blank answer. structuredCall: a rawRead agent's corrective pass quotes the reader's own
  message (so prose still hears "no JSON object was found", not "the JSON could not be read").
- D-208: `StructuredInput.opening?: string`. `openingOf(input)` = the opening when tag null, transport 'tagged',
  `caps.prefill !== 'none'` and non-blank; every call (the corrective pass's too) sends it as `prefill`.
  `withOpening(opening, text)`: the text read is opening + the model's (visible, think-cut) text; the text alone
  when blank (→ no_output), when it restates the opening (blanks ignored), opens a fence, or opens a list after an
  opening ending in `[`. The corrective echo is the opened text. `readRawAnswer` takes `opening`. Constants and
  request fields: `RECALL_OPENING` / `RecallRequest.opening` (`{"entry_ids": [`), `FILING_OPENING` /
  `FilingCall.opening`, `HISTORIAN_OPENING` / `HistorianRequest.opening` (both `{"filings": [`). The prefill's few
  tokens are not taken off maxTokens (inside the estimate's slack). Listed deviation: Bunraku and RoleCall send no
  prefill.

### Not done here (other owners' files) — for the lead
- `src/engine/recall.ts`: pass `opening: req.opening` in `common` (D-208 is inert until then), and
  `needsTopUp(first.value, { profile, ...settings, shown: index.shown })` (core#8's top-up half).
- `src/engine/lane.ts`: carry `opening: req.opening` in `Prepared` (filing and historian) and pass
  `opening: prep.opening` to structuredCall in `execute`.
- `.notes/m5c-provenance-recall.md` rows for `recallRequest` (the minimum also held to the entries shown; the
  conversation now verbatim; the opening prefill) and `readRecall` (the new reading order, the example rule, codes:
  prose is undecodable) need the same words; `src/cli/repl-render.ts` RECALL_CODE_WORDS is cli#8's other half.
