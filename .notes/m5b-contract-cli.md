# M5b contract — cli (wave 3: the REPL, the TUI and the one-shots over the lane)

Builder: cli. Decisions: D-181, D-180 (the verbs' CLI side), the lead's rulings G and H (one-shots open the
lane `manual`). Nothing ported (no provenance note). No file outside `src/cli/` was edited.

## Files

| file | change |
|---|---|
| `src/cli/repl-commands.ts` | `/memory undo\|refile <ref\|#n> [file\|hist]`, `/memory retry [#n]`, `/memory wait [sec]`, `/memory status`; `MessageAt`; classes; `MEMORY_LATER` = recall, profile, mode only; help |
| `src/cli/repl.ts` | bus listener (`ReplDeps.events?`), lane lines and notices at pauses, the five verbs, `/memory show` provenance, `/trace` recap refs, Ctrl+C stops `/memory wait` |
| `src/cli/repl-render.ts` | `recapTraceLine`, `renderTrace(…, names?, refs?)`, `renderEntryCard(…, prov?)` + `RowOrigin`/`EntryProvenance`, `LaneWords`, `passName`, `laneAgentLine`, `laneUndoneLine`, `renderLaneStatus`, `renderLaneWait` |
| `src/cli/chat.ts` | `ChatArgs.events?` (bus subscribed before the open), passed through `chatDeps` |
| `src/cli/oneshot.ts`, `preview.ts`, `compact.ts`, `commands.ts` | engine opened with `lane: 'manual'` (send, preview, compact; `new` unless it hands over to the chat) |
| `src/cli/main.ts` | "(milestone M5b)"; a sentence on the background lane in `chat` help |
| `src/cli/tui/run.ts` | `cmdTui` pre-subscribes; the tail hands lane events to the agents pane while a turn streams too |
| `src/cli/tui/agents.ts` | `isLaneEvent`; a `queued` while the agent's pass runs changes nothing; `started` drops the last pass's memory line |
| tests | new `test/repl-m5b/{kit,lane,commands,tty}.test.ts` (29), `test/tui/lane-m5b.test.ts` (4), `test/cli/lane-m5b.test.ts` (4); pins in `test/repl/{repl,commands,m2-commands,m3-commands,m4-commands}.test.ts`, `test/repl-m5a/export.test.ts` |

## What the REPL prints

- Lane lines (dim), one per pass that ended, the message as its `/show` number (`#n`; an id off the path):
  `⋯ memory: filing #7 → +2: C12 "Фрол", C3 "Серый маяк"` (each changed entry once, first-change order, at
  most 8 named then `… k more`; an arc `C4 [Arc] "<plot>"`; an entry gone from the path by its kind),
  `· n skipped` when the reader skipped items; `→ nothing to file` (historian: `nothing to record`; ops that
  changed nothing: `nothing new`); `historian #1–#7 → …` (its key's window); `filing #7 gave way to a turn;
  it runs again at the next pause`; `filing #7 failed [code] (attempt a of max)`; `filing #7 parked after 3
  failed attempts: /memory retry #7 runs it again`. `queued`/`started` print nothing. The pass is found
  through the job row of the event's `job` (journal `tree.jobs`).
- An undo's `memory{reverted, by:'user'}` events: `⋯ memory: undo → −2: C16 "Фрол", event "Лодка с солью"`.
- Every bus notice of the session: `! <text> (<code>)` (yellow), deduped by code + message with the
  REPL's other notices; a notice a turn carried counts as told whatever the view did with it.
- When: never inside a streaming answer. Events wait in `lanePending`; they are shown after each
  processed line (a script — non-interactive input — first waits one macrotask so the bus has delivered
  what the line caused: deterministic transcripts), at the end of input, during `/memory wait` as passes
  end, and at an idle prompt (one `setImmediate` after the burst; on a TTY above a fresh prompt that keeps
  the typed text, as the Ctrl+C hint does). A pass's memory events wait for its `agent` end event.
- `/memory status`: `the Compendium's background lane: 1 running, 2 queued, 1 parked · 3 answers not filed
  yet`, then `  running: filing #3 (attempt 2) · job j_…`, `  queued: filing #5, historian #1–#5`, one
  `  parked: … after 3 failed attempts (/memory retry #n runs it again)` each; idle: `… is idle: nothing
  queued, nothing parked[ · n answers not filed yet]`; off: `COMPENDIUM_OFF` (yellow) first.
- `/memory wait [sec]`: the lines, then `the background lane is idle[: nothing to do][ · n parked (/memory
  retry runs it again)][ · n answers not filed yet]`, or `still working after 30 s: filing #3 runs, 1 queued
  (/memory status)`, or (idle with a queue: no recorder route) `the background lane cannot run: …`. Off:
  `the Compendium is off for this session: nothing runs in the background (/memory on)`. Ctrl+C:
  `(stopped waiting; the background work goes on: /memory status shows it)`.
- `/memory undo <ref|#n> [file|hist]`: `undone: filing #3; what it wrote leaves the Compendium from the next
  turn (/memory refile #3 files it again)` + the undo line; changed:false: `/memory undo: the pass bound to
  message #3 is already undone or being filed again; nothing changed`. `/memory refile`: `filing #3 queued
  again (/memory wait waits for it)` / `… is already queued or running; nothing changed`. `/memory retry
  [#n]`: `queued again: filing #3 (/memory wait waits for it)` / `nothing is parked on this path|for message
  #n; nothing changed`. Refusals: one red `/memory <verb>: <engine text>` with `message <id>` → `message #n`.
- Message refs: `5` or `#5` (its /show number), else a hex id or unique prefix (`resolveMessageId`).
  undo/refile/retry are class 'edit' (refused mid-turn), wait/status 'read'.
- `/memory show`: `origin: this session, filed by the filing agent from #3 (file:<id>) at journal row 15;
  last changed at row 21 by the historian from #7 (hist:<a>-<b>)`; a library entry's `last changed at
  journal row N by …`; a summary's `covers messages #1 … #3`. A person's rows keep M5a's words.
- `/trace`: `  recap: 1 arc: C16 "Украденный свет" rev 0 · 2 summaries: C19 "…", C23 "…" · boundary <id>`
  after the compendium line; nothing for an empty slot.

## TUI

The REPL's lines reach the transcript as before. run.ts hands `isLaneEvent` events (agent with no turn,
memory by filing/historian, retries of `<job>:filing|historian:n` calls) to the agents pane whether a turn
streams or not (they are never in a turn's stream); the rest as before. Blocks: `Filing · queued|started|
done (n)`, the duration, `memory: <change> <kind> "<name>"` (M5a's reducer words, pinned by older tests).

## Deviations / open questions

1. The REPL subscribes to the bus itself; `rp-core chat`/`tui` subscribe before the open
   (`ChatArgs.events` → `ReplDeps.events`), so open-time lane notices (memory_backlog, slots_shared) show.
   `new --chat`/`--tui` and test rigs subscribe at REPL start.
2. In interactive input the prompt comes back at once after a command; lane output that arrives a tick
   later goes above a fresh prompt (a TTY keeps an empty `you ›` row above it). A script waits one
   macrotask per line instead. Undo waits that tick itself so its line follows its confirmation everywhere.
3. `/quit` typed during `/memory wait` queues behind it (as behind any slow command); Ctrl+C stops the wait.
4. The engine's parked-refile refusal names the key (`file:<id> is parked …`); left as the engine's words.
5. RP_CORE_LANE is mentioned only in `chat` help; README/ARCHITECTURE wording is the lead's.
6. Not run (rules): test/demo-m5a (its `/trace` pins use toContain; a recap line now follows the
   compendium line with the lantern book's `[Arc]`), test/demo-m3, test/lane-m5b.

## Fixes after the review (fix-cli; the lead's ruling I)

Files: `src/cli/repl.ts`, `repl-render.ts`, `repl-commands.ts`, `repl-journal.ts`, `runtime.ts`, `chat.ts`,
`tui/agents.ts`, `tui/agents-pane.ts`, `tui/types.ts`, `tui/view.ts`. Tests: `test/repl-m5b/review-fixes.test.ts`
(11, new), `test/tui/lane-review.test.ts` (7, new); pins in `test/repl-m5b/lane.test.ts` and
`test/demo-m5b/lantern.test.ts` (the undo hint); `docs/M5B-DEMO.md` section d refreshed to the true output.
Each fix's test was checked by undoing the fix in place: it fails.

- **cli#3** the undo line's way back names the kind of pass undone: `undone: filing #3; what it wrote
  leaves the Compendium from the next turn (/memory refile #3 file runs it again)`; `… hist …` after a
  historian undo; both kinds: `what they wrote … (/memory refile #3 runs them again)`. A refile of
  several passes says `(/memory wait waits for them)`.
- **cli#4** (TUI) the lane's new `agent{skipped, reason:'superseded'}` already ends the block (`Filing ·
  skipped`, `<s> · superseded`); `isLaneEvent` now also passes `idle`, and `idle{background: 0}` turns a
  lane block still `queued`/`started`/`retry` into `idle` (a pass dropped by /memory off, a run cut short
  with nothing to tell); its memory line stays. `skipped` and `idle` are dim.
- **cli#5** `--debug`: `Runtime.debug(line, call?)` and `ReplDeps.debugTap`'s printer get `{job}` for a lane
  call (`onProviderError`'s `job`); the REPL holds such a line in `lanePending` (as `{type:'debug'}`,
  shown whatever session's lane made it) and prints it at the pause before the pass's own line. A turn's
  own debug lines still print at once (interject).
- **cli#6** `pathUsage` counts the `calls` rows of agent `mem` rows and of `job{failed}` rows whose `on` is
  on the path, under their agent (`filing`, `historian`), priced by each row's model: /usage gets a
  `filing` line and the total; the TUI usage block (storedFacts) too, and `isLaneEvent` passes the lane
  agents' `usage` events (live until the next refresh re-reads the rows). A run whose result was dropped
  (superseded) wrote no row: its call shows live, then leaves the total at the next refresh.
- **cli#9** the lane's `recorder_unavailable` notice prints like every bus notice (`! … (recorder_unavailable)`,
  once); no memory_backlog meanwhile; `/memory wait` keeps "the background lane cannot run". Pinned by a
  test; no REPL code change was needed (the engine side is fix-lane's).
- **cli#11** `/memory wait <sec>` is clamped to 86 400 s in the parser (`MEMORY_WAIT_MAX_SEC`); help says
  "up to 24 h".
- **cli#13** `AgentsPaneApi.reset(sessionId, lane?)`: TuiView.banner passes `session.memoryStatus()` (a
  session that cannot say: none) and the pane seeds its blocks with `withLane` (agents.ts): the running
  pass `started` (`queued` while `running.waiting`), else a queued one `queued`, else a parked one
  `parked [code]`, timed from the pane's clock. So a pass queued or begun at the open has its block, and
  the banner no longer wipes it.
- **Following fix-lane's changes**: `failed{no_room}` prints nothing, `parked{no_room}` prints `filing #3
  parked: it does not fit the recorder's window [no_room]; /memory retry #3 runs it again`; `skipped`
  prints nothing; a re-run's `memory{reverted, by: agent}` goes after what it made: `→ +1: C1 "Фрол" ·
  −1: character "Серый"`. `/memory status`: `1 held` in the counts, `  held: filing #3: the filing agent is
  off for this session (compendium.filing.enabled)` (historian: `… (compendium.historian.interval is 0)`),
  ` · waiting for a place on the server` after a running pass that has no slot yet, a no_room parked task
  `  parked: filing #3: it does not fit the recorder's window [no_room] (/memory retry #3 runs it again)`.
  `/memory wait`'s idle line adds ` · n held (its agent is off: /memory status)`. A refile or retry of a
  task whose agent is off: `filing #3 waits: the filing agent is off for this session (…); it runs once
  the agent is on`; again: `/memory refile: filing #3 already waits for its agent; nothing changed
  (/memory status)`. The engine's refusals print as they come, its "(turn it on first)" read as
  "(/memory on)".

Open for the lead: `/memory status` cannot tell a queue the recorder cannot run (no route) from one that
waits for the idle gate (MemoryStatus has no such field); the notice says it once and `/memory wait` says
it each time.

## After the final check (fix2-agents; the lead's ruling K) — the wording items

Files: `src/cli/repl.ts` (laneRefusal, lane notices, laneRetry), `src/cli/repl-render.ts`
(`laneKeysInWords`, `laneResumedWords`, renderLaneStatus/renderLaneWait). Tests:
`test/repl-m5b/ruling-k.test.ts` (new, 8); the parked-refile pin in `test/repl-m5b/lane.test.ts`. Each
new test fails on the code before.

- **Pass names, never task keys** (agents-cli lane.ts:681): the engine's refusals keep their keys
  (fix2-lane); the REPL renders every `file:<id>` / `hist:<a>-<b>` in a refusal with `passName`
  (`laneKeysInWords`), and the parked-refile hint as `/memory retry #n runs it again`: `/memory refile:
  filing #3 is parked after 3 failed attempts: /memory retry #3 runs it again`, `/memory refile: filing #3
  has no visible answer left: hidden messages are not filed`. Lane notices too (`memory_starved`:
  "Turns took the Compendium's filing #3 away 3 times …", `<agent> task <key>` → the pass name).
  `/memory show`'s provenance keeps its `(file:<id>)` reference (not a refusal or a lane line).
- **`MemoryStatus.blocked`** (fix2-lane; cli#9, cli#1): `/memory status` adds `  blocked: <message>` (no
  route) or `  paused: <message>` (the circuit breaker) under its first line, idle or not. `/memory wait`
  idle with a queue: `the background lane cannot run: N tasks queued. <message>` when paused; the old
  "… and the recorder has no model to run on (/model recorder …)" otherwise.
- **A retry that only resumes** (memoryRetry → `{keys: [], changed: true}`): `/memory retry: nothing is
  parked on this path; the filing agent runs again (it was paused)` (historian / both; "the paused agents
  run again" when the status said no_route, which hides the pause).
- `notice{memory_paused}` prints like every bus notice; a refile that queues the filing key beside the
  historian's prints both (`filing #1 and historian #1–#1 queued again`) as before.
