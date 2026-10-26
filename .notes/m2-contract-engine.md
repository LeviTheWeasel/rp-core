# M2 contract notes — engine (src/engine/* except api.ts and system.ts; test/engine-m2/)

No contract file was edited. api.ts is implemented as written (`SessionImpl.preview`).

## Additions inside my files (others may rely on them)

1. **`src/engine/request.ts` (new): the request half of a turn**, called by both `TurnRun.body` and
   `SessionImpl.preview`: window → reserve/limits (`max_tokens_reduced`) → the starting view
   (`startView`: folded at upTo when that is not the head) → EMA factor for the engine's counter →
   `loadLorebooks(home, config.lorebooks)` → `assemble` (with `lorebooks`, `counter`, `explain`) →
   `shapeRequest`. Also exports `replyLimits` (moved here from turn.ts; nothing imported it from
   there), `maxTokensFor`, `tokenLimit`, `brokenRegexKeys`, `regexNoticesPerEntry`, and the types
   `Shaped`, `KeyedNotice`, `RequestPlan`, `BuiltRequest`.
2. **Counter seam:** `Engine.open(opts: EngineOptions & EngineSeams)`, `EngineSeams = { counter?: TokenCounter }`
   (engine.ts). Not an EngineOptions field: hosts never set it; tests that pin chars/3 numbers pass
   `counter: CHARS_COUNTER`. `EngineCtx.counter` (required, `opts.counter ?? defaultCounter()`) is
   what the engine passes to assemble and uses for the EMA and the server-truncation check.
3. **`ema.ts`:** `emaSamples(idx, view, model, counter = defaultCounter().id)`,
   `tokenFactorFor(..., counter = defaultCounter().id)`, `counterOf(trace)` (absent = 'chars'), type
   `CounterId`. Only samples whose `trace.tokens.counter` equals the counter in use count (D-50).
4. **`narrate.ts`:** the internal `buildRequest` is now the exported `modelRequest(fields, signal)`
   (type `RequestFields`), so preview's `wire()` gets the very ModelRequest a call would stream.
5. **`session.ts`:** `DRAFT_ID = 'draft'` exported.
6. **test/engine-m1b/ema.test.ts:** the two pure `emaSamples` fixture tests now pass `'chars'`
   explicitly (their traces carry no counter = chars; the default counter became o200k). No
   expectation changed.

## Behaviour decided here (please confirm or overrule)

1. **The next turn's seed is drawn by the first preview of it** and kept in the session (memory
   only) until the next `turn` line takes it. So a preview of the next turn (reply, swipe, draft)
   is byte-identical to the request the turn sends, `{{random}}`, `{{pick}}` and lore chance/groups
   included (only `now` differs: the turn reads the clock when it starts). Without a preview the
   draw order is unchanged (turn id, msg id, seed), so fakeRandom sequences in old tests hold.
   `/lore test <text>` (preview with a draft) also reserves it; harmless.
2. **Admission in preview:** the turn's `admitTurn` minus what is about writing — a running turn,
   a held answer and the version are not checked (the contract says it works while a turn runs).
   Kind checks, connection and preset refusals come back as `ok:false` with the refusal code.
3. **`turn` option:** unknown id → `not_found`; not on the active path, a user message, a greeting
   or an answer without a trace → `invalid_params`. Built at `foldViewAt(U)`, the trace's seed and
   now, today's binding/preset/books/config; kind `'swipe'` when the answer has older siblings. A
   guided re-roll is rebuilt with `gen.guidance` and, when today's `swipe.showRejected` is on, the
   replaced answer's (the turn line's `target`) current text.
4. **`preview_inputs_changed`** (level info) names what changed: "the preset", "lorebook X",
   "lorebook X (added)", "lorebook X (gone)" — from `presetHash` / `loreHashes` of the stored trace
   vs the preview's.
5. **Shape failure** in a preview returns `code: 'assemble_failed'` (the PreviewResult union has
   no 'shape_failed'; the turn still fails with 'shape_failed').
6. **`wire()` that throws** → no `wire` field and a notice `{level:'warn', code:'wire_unavailable'}`.
   The ModelRequest given to `wire()` has callKey `'preview:narrator:0'` and a fresh, never-aborted
   signal.
7. **Notices in a preview:** every request notice once (by key), none marked as told, so the next
   turn still tells them.
8. **Once-per-session keys:** request notices are gated by key: the code, except
   `lorebook_missing:<id>` and `lore_regex_invalid:<book:id>`.
9. **`lorebook_missing`** message: ``The lorebook '<id>' is skipped: <why>.`` with why one of
   "it is not in the library", "it cannot be read (<error>)", "it is invalid (<first 3 errors>; N
   more)", "a library id cannot start with @". A repeated id is loaded once. Books are read at every
   turn and preview (a book added to the library later takes effect at the next turn).

## For the assemble/prompt owner (src/prompt/assemble*.ts)

- **`lore_regex_invalid`** is one notice per request naming up to ten `label key` pairs. To keep
  "once per session per entry", request.ts finds the named entries among the books' own broken
  `/re/` keys (`brokenRegexKeys`, compiled with lore/keys.ts `KeyMatcher`) by the exact
  `"<label> <key>"` text and re-emits one notice per entry via your `regexNotice([...])`. Brittle
  points: it depends on that message format, and entries past the tenth are not told until they
  are among the named ten. Cleaner: expose the errors structurally (e.g. an optional
  `AssembleResult.loreRegexErrors: LoreRunResult['regexErrors']`) or emit one notice per entry;
  then `regexNoticesPerEntry` reduces to a map. request.ts also imports `loreSources` and
  `regexNotice` from `src/prompt/assemble/lore.ts`.
- `traceForSent` re-counts with `counterById(trace.tokens.counter)`: a pinned counter whose id is
  'o200k' but which counts otherwise (only my test's fake) is re-counted with the real o200k. Fine.

## Not done / open

- Preview is synchronous: M9 `beforeAssemble` placements and the `transformRequest` gate are not
  applied to it (both are pass-throughs today). M4: a stub directive goes in `placements`.
- A preview taken while a turn runs shows that turn's request at the next turn's seed (it reads the
  head U), so seeded text may differ from what the running turn sent.
