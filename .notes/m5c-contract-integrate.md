# M5c contract — integrate (wave 2: D-201…D-204 in the engine)

Recall runs in the turn and as a lane prefetch. Fresh code (the pure recall parts are wave 1's
`agents/compendium/recall.ts`, whose provenance note covers them), so no provenance note here.

Files: `src/engine/recall.ts` (new), `src/engine/{turn,lane,session,admit,request,recover,context,engine}.ts`,
`src/agents/compendium/{select,types,recall}.ts`, `src/prompt/assemble.ts` (one line), `src/session/entries.ts`
(a comment), `src/providers/openai-chat.ts` (`sendsReasoningOff`), `src/cli/provider.ts`,
`src/cli/repl-journal.ts` (`pathUsage`). Tests: `test/recall-engine-m5c/` (27: sync 13, prefetch 8, reuse 6);
`test/recall-m5c/record.test.ts` updated for ruling G.

## What was built

### Context and routes
- `EngineCtx.recallDefault?: 'lexical' | 'off'` (context.ts); engine.ts sets it (RP_CORE_RECALL /
  `EngineSeams.recall`); `RecallDefaultCtx` stays as an alias type for wave 1's test.
- `admit.ts`: `resolveRecorder` moved here (lane.ts re-exports it), `resolveRecall(ctx, config)` = D-85:
  explicit binding → all its fields; `'narrator'` → the narrator's conn/model only; `'recorder'`/absent →
  `resolveRecorder` (which follows the narrator while the recorder is unset). Route null → `no_connection`.
- `engine/recall.ts`:
  - `recallModeOf(config, recallDefault)` — the raw `compendium.recall.mode` when valid, else the engine
    default, else `'auto'` (ruling G: the env override replaces only the default).
  - `recallSetup(ctx, config)` → `RecallSetup {cfg, mode, binding, route, label, local, window, profile,
    settings, reasoning, fingerprint}` or null (Compendium off). Window = `contextWindow` of the recall
    route (config.window applies); profile = `compendiumProfile(cfg.profile, window)`; `local` = the
    scheduler's (`sched.forOrigin(origin, capacity).local`), computed only when the mode can call.
  - `wantsPrefetch(setup)`, `onMissOf(setup)` (auto: lexical local / sync remote).
  - `prefetchBasis(setup, view, tree, head)` = `head|compendium rev|newest touch on the path up to head|
    hidden count|fingerprint` (fingerprint = hash of label, window, profile, settings, guidance,
    timeoutSec, reasoning, binding samplers/maxTokens).
  - `runRecall(input)` → `{record, calls, truncated, omitted, refused, preempted}` (below).
  - `effectiveRecall(tree, id)` (newest continue edit's record, else the message's; checked),
    `tapGrant(sched, onGrant)`, `recallAgentRow(rec)`, `recallEvent(rec, how)`, the notices
    `truncatedNotice`, `missedNotice`, `slowNotice`, constants `RECALL_SLOW_MS` 8000, `RECALL_SLOW_AFTER` 3.
- `openai-chat.ts` `sendsReasoningOff(caps)`: reasoning 'none' reaches this wire (effort 'none', the off
  shape, or toggle with canDisable). Recall's `reasoningOff` = `caps.reasoning.output === 'none' ||
  (reasoning === 'none' && sendsReasoningOff(caps))` → no +1 024.
- `cli/provider.ts scriptConnection`: a script's `"local"` → `localOrigin` and the connection's `local`
  (`?? true` as before).

### runRecall (shared by the turn and the lane)
Index over the fold the request reads: `visibilityAt(view, tree, U ?? null)` (a prefetch: null = the
head's window), `slotIds` = `previousRecap(view, tree, upTo).recap.ids`, lite inputs from the visible path
(uText = U, windowTexts = before U, lastTexts = up to upTo, castNames). Conversation = visible path
messages up to `upTo` (U; a continue's target; the head for a prefetch). `shown 0` → `skipped
empty_index`; `!req.fits` → `skipped no_room` (ruling G). structuredCall: tag null, `rawRead`, schema,
binding samplers + temperature 0.3, reasoning as the Director's rule, maxTokens min(req, caps.maxOutput,
binding max), `budgetMs = recallDeadlineMs` (30/20/60 s, timeoutSec overrides), priority interactive
(sync) / background + idleDelaySec (prefetch), callKeys `<turn>:recall:N` / `p_<head>:recall:N`; top-up
(full) `<prefix>:more:N`, only when what is left of the deadline (from the first grant) is > 0 and the
window still leaves AGENT_OUTPUT_FLOOR. Record = `recallRecord` (`basis` = head for a prefetch, `ms` =
wall time of the run).

### The turn (turn.ts)
- `body()`: hook → `decideRecall()` (pure: nothing told) → the D-195 fit check when the Director plans
  OR recall may call (`sync`/`wait`) → `agents()` → request (with `recall: {picks, source}`) → prep.
- `decideRecall()`: none (Compendium off / no live typed entry: no record, no trace row, M5a request) →
  `off`/`lexical` (source only) → reuse (swipe with onSwipe reuse and no guidance, or continue; the
  target's `effectiveRecall`, `reusedRecord`) → no route (`skipped no_connection`) → sync (sync, or auto
  remote) → prefetch modes: manual lane ⇒ onMiss directly (no record when lexical, no notice); else
  `host.prefetchFor(basis)` with basis head = U's parent (continue: the target): a stored non-failed
  record is adopted; a running one → `wait`; a miss → onMiss (sync with the notice, or a `missedRecord`
  + notice; a stored FAILED prefetch is written as is, without the notice).
- `agents()`: `alongside()` = `Promise.allSettled([direct(order.first).finally(order.open),
  syncRecall(order.second)])`, `ordered()` only when the Director calls on the same origin. `graceWait()`
  = promote, wait ≤ graceSec (`waitFor`: done / 'late' / 'stopped'); local: wait then Director (and sync
  on a miss with onMiss sync, ordered); remote: the Director runs during the wait, a sync recall owed by
  the miss runs after the wait. Late → `supersede()`; Stop → `demote()` and the turn ends stopped-empty.
- Record → `prep.recall` and the commit body (`recall`, continue edits too); `withAgents()` replaces
  `withDirector()`: trace.calls = Director's, recall's (sync only), narrator's; `trace.agents.recall`;
  CALL_CEILING counts recall's calls. `trace.compendium.source` from `RequestInput.recall.source`.
- Events (turnId set): `started` (sync, at the grant), `recalled` (sync), `adopted` (prefetch),
  `reused`, `fallback` (failed / prefetch_missed, source lexical), `skipped` (empty_index, no_room,
  no_connection). Notices: `recall_index_truncated`, `caps.suggest` (structured refused), `prefetch_missed`,
  `recall_slow` (TurnHost.tally).
- TurnHost gained optional `prefetchFor(basis)` and `tally(key)`; exported `RunningPrefetch`, `PrefetchLook`.

### The lane (lane.ts)
- Not a `LaneTask` (no `MemoryStatus` change): a separate `pre: PreRun` slot; "one task at a time" holds
  (pump starts nothing while either runs). `pump()`: a due prefetch begins before the next file/hist
  task unless that task is starved. Due = auto lane, head is an assistant message (greeting included),
  live typed entries, `wantsPrefetch`, no stored record for the basis, not running.
- A run: `boosted(sched, createBoost())`, `runRecall(prefetch)`, record kept in `prefetched` (Map by
  basis, newest 8); nothing written. Preempted → event, no record (re-derived, waits the idle gate).
  `refresh()` supersedes a run whose basis left (head moved, edit/hide, rev, setup) — a user message
  answering the head keeps it valid. close() aborts it ('shutdown').
- Bus events (no turnId): `queued` (once per basis), `started`, `preempted`, `done` (count, source
  prefetch), `failed` (code), `skipped` (reason superseded). `idle{background}` counts a due/running prefetch.

### Elsewhere
- `select.ts`: tier 1 sorted by recall's order (D-153 amended), nothing else inside tier 1.
- `request.ts`: `RequestInput.recall?: RecallInput` → `compendiumBlockInput(..., recall)` → `select`
  `recallPicks` + `CompendiumBlockInput.source` → `assemble.ts` writes it (default 'lexical').
- `session.ts`: `prefetchFor`, `tally`; `/preview --turn` rebuilds tier 1 from the answer's record and
  its trace's source (no recall call). Next-turn previews stay lexical.
- `recover.ts`: `prep.recall` through `checkRecallRecord` (a malformed one is left out).
- `repl-journal.ts pathUsage`: sync recall counts via trace.calls (agent 'recall', as before); a record
  with `basis` (adopted or failed prefetch) adds its `calls` and summed `usage` priced by `model`.
- `recall.ts` (ruling G): a lite reading failure is `failed` (not `empty`); `skippedRecord` takes
  `no_room`; `checkRecallRecord` keeps `no_room`.

## Choices (say if any should change)
1. The greeting is a prefetch basis ("the head is an assistant message"), so the first reply of a local
   `auto` session does not always miss. D-202 says "an assistant reply"; one line in `preWanted`.
2. The basis also carries the newest touch (edit, hide) and the hidden count of the path up to the head,
   so an edit after the prefetch is a miss (§7.4.2) without a separate "touched since" check.
3. A stored prefetch whose record FAILED is a miss without the `prefetch_missed` notice; with onMiss
   lexical its failed record is written (it carries the real code and its calls count in /usage).
4. A manual lane (tests, one-shot CLI) makes `prefetch` behave like `auto`-local: onMiss directly, no
   record and no notice when lexical (nothing was owed, so nothing missed).
5. Late prefetch → superseded at once (not kept running); a Stop demotes and keeps it.
6. Recall's own calls of an adopted prefetch are NOT in the turn's trace.calls nor CALL_CEILING; /usage
   reads them from the record (D-204).
7. The sync `started` event comes at the first grant (tapGrant), so a queued recall says nothing yet.
8. `recall_slow` counts sync runs whose wall time (`record.ms`, queue wait included) > 8 s and that made a call.
9. Category names of library entries (`categoryOf`) are not passed to the index (deriveTree's category
   tree under 5 entries uses none); the session has them (`categories()`), a later hook if wanted.

## For the CLI builder (wave 3)
- Records: `effectiveRecall(tree, id)` (engine/recall.ts) gives a message's record; `checkRecallRecord`
  for raw rows. `/memory recall [--turn]`: source, status, picks (keys → `C<n>` via `entryRefs`), reasons,
  counts, calls, ms, basis/reusedFrom, code.
- `/memory mode <m>`: `configure({compendium: {recall: {mode}}})`; `/memory profile`: show
  `recallSetup(ctx, config)` (profile, window, label) per agent; the block's profile is the narrator's,
  filing/historian the recorder's (lane `recorder()`).
- `/trace` recall line: `trace.agents.recall` {status, code, transport} + `trace.compendium.source` +
  the recall rows of `trace.calls` (callKey `<turn>:recall:N`, `:more:N` for the top-up); an adopted
  prefetch has no row (show the record's `calls`/`ms`/`basis`).
- Bus filters: prefetch events are `agent{agent:'recall'}` WITHOUT turnId (REPL `laneEvent`, TUI
  `isLaneAgent`/`isLaneEvent` accept only filing/historian today); their usage/retry events carry callKey
  `p_<head>:recall:N` (TUI `agentOfKey` reads 'recall' — tell lane from turn by the `p_` prefix or the
  missing turnId). A turn's recall events have turnId.
- `MemoryStatus` does not show the prefetch (no `LaneTaskInfo.task` change); `idle{background}` counts it.
- Kept requests: `t_<turn>_recall_0.json`, prefetch `p_<head>_recall_0.json` (collisions get `-2`).
- `RP_CORE_RECALL` help line next to `RP_CORE_LANE` in `cli/main.ts` (not done).
- The bindings display (`renderBindings` "narrator (follows)" for an absent recall) and the config template
  ("A role that is not set is narrator") are now wrong for recall: it follows the recorder (D-85).
- Preview of the NEXT reply could show an in-memory prefetch (`prefetchFor`) — left lexical.

## Open questions
- Q1 (choice 1) greeting as a prefetch basis.
- Q2 `MemoryStatus`/`/memory status` for a running prefetch: a new optional field, or bus events only?
- Q3 `history_crowded` and `recall_index_truncated` are info/warn as built; `prefetch_missed` and
  `recall_slow` are `info`.

## Tests
`TMPDIR=… bun test test/recall-engine-m5c test/recall-m5c test/engine test/engine-m4 test/engine-m5a
test/lane-m5b test/recap-m5b test/director test/structured test/sched-m5c`: 1 564 pass, 0 fail.
`bunx tsc --noEmit -p .` clean. Not run (rule): the rest of the suite — likely touched by the shared
changes: `test/compendium-select` (tier-1 order; its single-pick cases hold), `test/repl*`/`test/tui`
(nothing they pin changed in output, but `/usage` and the scripted CLI connection's `local` flag moved),
`test/demo-*` and `test/rcimport` (recall stays lexical under the preload).

## After the review (ruling K; details in m5c-contract-fix-engine.md)
- Choice 3 extended: a basis the lane holds nothing for is onMiss with no record and no notice;
  `prefetch_missed` is told only by the grace wait (late, or the run ended without a record).
- Choice 8 changed: `record.ms` (and so `recall_slow`) runs from recall's first grant, not its queue wait.
- `memoryWait` waits for a queued, running or owed prefetch; the basis' head is the newest assistant
  message before U (`basisHead`); a guided re-roll / onSwipe 'rerun' recalls in the turn; `ordered()`
  and the grace wait's hold apply only when the Director shares recall's origin with one place;
  `/preview --turn` reads the message's own record; `close()` stops the turn before the lane.
