# M5c — review fixes, engine (fix-engine)

The lead's rulings K (`.notes/m5c-decisions.md`). Files: `src/engine/{recall,turn,session,lane}.ts`,
`src/engine/sched.ts` (sched#7 only); tests `test/recall-engine-m5c/review.test.ts` (new, 18),
`test/sched-m5c/order.test.ts` (+1), `test/recall-engine-m5c/sync.test.ts` (one expectation, ruling J).

## What changed

- **core#1 — at most two recall calls.** `runRecall` (engine/recall.ts) runs the top-up only when the
  first structuredCall made one model call (`first.calls.length < 2`, Bunraku's `calls < 2`): after a
  corrective pass (or a §6.6 retry) there is no third call; the repaired answer stands with its picks.
- **engine#6 — `RecallRecord.ms` is recall's own time.** It runs from the first grant (`granted`, the
  stamp the deadline already used), else from the run's start when nothing was ever granted. The wait
  for the Director's place on one origin (and a prefetch's idle gate) is no longer in it, so
  `recall_slow` (which reads `record.ms`) counts recall's own time. `trace.calls[].ms` of recall's rows
  is streamCall's and still includes the queue wait (not this builder's file).
- **engine#1, breaker#4 — memoryWait waits for the prefetch (ruling I).** `Lane.wait` (auto mode) awaits
  a running prefetch (`pre.done`, raced with the timeout) and, while one is owed for the head
  (`preDue()`), pumps and waits for the lane's next look. `idle` is false while a prefetch is queued,
  in flight or owed. Manual mode is unchanged (no prefetch there).
- **engine#3, #5, #7, cli#5, breaker#3 — `prefetch_missed` only after a real wait.**
  - `decideRecall`: a basis the lane holds nothing for (no answer before U, a prefetch never begun, a
    session just opened, a user head after a reopen) falls back per onMiss with **no record and no
    notice** (as a manual lane: nothing was waited for). A stored FAILED prefetch: onMiss lexical →
    its own record (fallback event with its code), onMiss sync → the turn's recall; never told. The
    `missed` flags of `RecallPlan` are gone.
  - Only `graceWait` tells it, when the wait ended without a selection: `late` (grace_sec passed; the
    prefetch is cancelled) or the run ended with no record (preempted before the promotion). A failed
    record in the wait is a fallback, not told (as before).
  - `missedNotice(graceSec, late)`: late → «…was still running when the turn needed it (the turn waited
    N s for it)… A longer compendium.recall.grace_sec, or a second slot…»; ended → «…ended without a
    selection while the turn waited for it (it was interrupted before it answered), so the turn went
    on without it.» (no wait length, no grace_sec advice).
  - engine#7: `SessionImpl.close()` stops the running turn (`stop('shutdown')`) before `lane.close()`,
    then awaits it: a grace wait ends as a Stop (stopped, no notice, no fallback event) instead of
    reading the prefetch the lane's close cancels as a miss. The lane still closes before the log.
- **cli#4, breaker#1 — a re-roll recalls again.** A swipe that does not reuse (guidance given, or
  onSwipe 'rerun') runs a sync recall in the turn whatever the mode (after the reuse and route checks):
  it never adopts the prefetch of its basis (the one the replaced version read; it never saw U). A plain
  swipe whose target's record is failed/absent still runs per mode. The re-roll's guidance does not
  reach recall's prompt (only `compendium.recall.guidance` does; the guidance still names tier 0).
- **breaker#2 — the basis' head is the newest answer before U.** `basisHead(tree, id)` (engine/recall.ts)
  walks up past user messages to the nearest assistant message. Used by `decideRecall` (reply/swipe:
  from U's parent; continue: the target as before), `Lane.preValid` (a running prefetch stays valid while
  player messages stack under its answer) and `SessionImpl.prefetchNow` (`MemoryStatus.prefetch` with a
  stacked head reads the prefetch after the last answer).
- **sched#3, #5, #7 — the Director and recall on one place.** `TurnRun.sharesOnePlace(route)`: the
  Director calls this turn on recall's origin and that origin's semaphore has one place
  (`forOrigin(origin, min(capacityOf(dir.caps), capacityOf(recall.caps))).capacity === 1`;
  `capacityOf` is now exported from engine/recall.ts).
  - `alongside`: `ordered()` only then (was: any shared origin).
  - `graceWait`: holds the Director back only when the origin is local AND shared on one place;
    otherwise the Director plans during the wait (a remote origin as before; now also a local recall
    origin with the Director elsewhere, or with two places). A sync recall owed by a miss on that path
    goes through `order.second` when shared, so it queues behind the Director's request.
  - `sched.ts ordered()`: `second` waits for the order only on a one-place semaphore (`sem.capacity
    > 1` → acquire at once); doc comment says so. With the turn's gate this is a second guard.
- **engine#4, breaker#6 — `/preview --turn` of a continued answer.** `previewRecall` reads the message's
  own record (`checkRecallRecord(tree.msgs.get(id)?.recall)`), not `effectiveRecall` (a later
  continue's), matching `past = entry.trace`. `/memory recall --turn` and `/trace` keep their own
  readers (breaker#5 is the CLI's).

## Tests (each fails with its fix reverted, checked one by one in a scratch copy)

`test/recall-engine-m5c/review.test.ts`: two calls max (+ a control: the top-up after a one-call first
answer); ms 0 with a 9 s Director on one place, no recall_slow; memoryWait (short → idle false/running;
no timeout → ends with the prefetch, ready); no greeting (local auto: no record/notice/event; remote
prefetch: sync, no notice); failed stored prefetch with onMiss sync (no notice) and lexical (its record,
control); the late notice's words; `missedNotice` both forms; close during the grace wait; guided and
rerun swipes recall in the turn on a local auto session; stacked messages adopt a held prefetch and keep
a running one valid; recall local + Director remote (Director asked during the wait); remote one place
with a slow Director key (Director's request before the miss's sync recall); two places with a slow
Director key (recall asks first); preview of a continued answer. `test/sched-m5c/order.test.ts`: two
places, recall's acquire is granted before the Director asks.
`test/recall-engine-m5c/sync.test.ts` "an unreadable lite answer fails": `no_output` → `undecodable`
(ruling J's words, built elsewhere; prose with no selection).

## For the lead

- `src/engine/api.ts` (not mine): the `memoryWait` doc comment should say it waits for the recall
  prefetch too. `src/cli/repl.ts` `prefetchWait` and its comment ("ruling H: memoryWait does not wait
  for the recall prefetch") are now redundant/stale (CLI's call; kept working: demo 3a passes).
- `docs/M5C-DEMO.md:377` quotes the old late wording («was not ready when the turn started (the turn
  waited 1 s for it)»); the new text is «was still running when the turn needed it (the turn waited 1 s
  for it)». `test/demo-m5c` only checks «the turn waited 1 s for it».
- A guided re-roll's guidance is not in recall's request (neither design nor sources put it there);
  only the re-run itself is new.
- Not fixed here: `test/demo-m5c` 2b, 2c, 2e, 3c fail on index handles moved by the index fixes
  (same-named entries / the lite shortlist, core#4/#5: the scripted answers' handles now name other
  entries) — they fail the same with this builder's changes reverted.

## Run
`TMPDIR=… bun test test/recall-engine-m5c test/lane-m5b test/sched-m5c test/engine test/engine-m5a
test/demo-m5c`: 629 pass, 4 fail (demo 2b, 2c, 2e, 3c above). `bunx tsc --noEmit -p .` clean.
