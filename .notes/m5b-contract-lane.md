# M5b contract — lane (wave 2: the background lane and its engine wiring)

Builder: lane. Decisions: D-171, D-172 (the lane's side), D-180, D-182 (engine part), the lead's rulings G.
Nothing ported (fresh code, no provenance note).

## Files

| file | status |
|---|---|
| `src/engine/lane.ts` | new: the lane (derivation, runs, recovery, verbs' lane side, events, notices) |
| `src/engine/session.ts` | lane wiring, the five verbs, `publishChanges`, `publish` public, tree cache keyed on job rows |
| `src/engine/api.ts` | `EngineOptions.lane`, `onProviderError` info, `LaneTaskInfo`, `MemoryStatus`, `MemoryLaneWrite`, verbs |
| `src/engine/context.ts` | `EngineCtx.lane` |
| `src/engine/engine.ts` | `createScheduler({ timers })`, the lane default from `RP_CORE_LANE` |
| `src/engine/turn.ts` | `keepRequestFile` lifted out of TurnRun; `TurnHost.turnSettled?` after the terminal event |
| `src/agents/structured.ts` | `firstJson`: a list root for `tag: null` agents (ruling G) |
| `test/preload.ts` | `process.env.RP_CORE_LANE = 'manual'` |
| `test/lane-m5b/{kit,filing,verbs,lane,calls}.test.ts` | new, 28 tests |

## API

`src/engine/api.ts`
```ts
EngineOptions.lane?: 'auto' | 'manual'        // default: 'manual' iff process.env.RP_CORE_LANE === 'manual' (read once in Engine.open)
EngineOptions.onProviderError?(info: { sessionId; turnId?: string; job?: string; callKey; model; error })  // lane calls: job, no turnId
interface LaneTaskInfo { key; task: 'file' | 'hist'; on; range: [string, string]; attempt: number }
interface MemoryStatus { queued: LaneTaskInfo[]; running?: LaneTaskInfo & { job: string }; parked: { key; on; failures }[]; backlog: number }
interface MemoryLaneWrite { keys: string[]; changed: boolean }
SessionHandle.memoryUndo({ messageId, task?: 'file' | 'hist' }): MemoryLaneWrite
SessionHandle.memoryRefile({ messageId, task? }): MemoryLaneWrite
SessionHandle.memoryRetry({ messageId? }?): MemoryLaneWrite
SessionHandle.memoryWait({ timeoutMs? }?): Promise<MemoryStatus & { idle: boolean }>
SessionHandle.memoryStatus(): MemoryStatus
```
`src/engine/lane.ts`: `Lane` (session-internal), `LaneHost`, `LaneTask`, `resolveRecorder(ctx, config)` (D-85:
`roles.recorder` absent/'narrator' → the narrator's conn+model only; an explicit binding keeps its fields; no
route → null, never a Refusal; providerOverride applies), `enableMoment(header, entries, tree)`, `taskOn(key)`.
`src/agents/structured.ts`: `firstJson(text)` (exported for tests). `src/engine/turn.ts`: `keepRequestFile(home,
sessionId, req)` (throws), `TurnHost.turnSettled?(run)`.

## Behaviour (choices the note left open are marked ▸)

- **Derived work** (D-171), cached per (journal length + last seq, config object, seed object, lane state):
  accepted answer = assistant message after the path's first user message (▸ anything before it is card
  material, not only position 1), not hidden, ≥ `wait` visible user messages after it, msg seq > the enable
  moment. Coverage: `file:` keys applied, or reverted and not stale, whose range holds it. Groups: runs of
  uncovered accepted counted visible answers, chunked by `everyN`; a covered/hidden/pre-moment answer ends a
  run (the part before is its own task); the trailing run waits until it has N. Key `file:<last>`, range
  [▸ the first VISIBLE user message since the previous answer, else the first answer; the last answer].
- **Enable moment** ▸: walk `config` entries tracking `resolveCompendium(..).enabled`; the newest off→on entry's
  seq; else the header (0; ▸ a fork: the seq of its `fork.at` msg in the fork); null while off (no lane).
- **Historian** (D-176 + ruling G): after the file tasks, one `historianDue` over the path up to the last
  accepted visible answer (pre-moment answers included in the path), `tasks` = the view's plus ▸ a synthetic
  covered range `hist:` [path[0], last message with seq ≤ moment] when the moment is > 0 (historian.ts not
  touched), `trimmed` = the newest path answer's trace.trimmed (its continue's). Runs use `historianWindowAt`
  with the key's range (refile, retry, recovery and derived alike).
- **Order**: file tasks by path position of `on`, then hist; asked-for tasks (refile, retry, recovered) merged
  in, the derived spec winning on a shared key; starved keys first. Parked keys and the running key left out.
- **Parking/attempts**: failures = `failed` rows of the key after max(newest mem row of the key, newest
  `retry` row); attempt = failures + 1; parked when failures ≥ maxAttempts and the newest job row's `on` is on
  the path. A preempted/superseded/shut-down run writes nothing after its begin, so it is not an attempt.
- **A run**: prepared synchronously (▸ a `split` or a gone task writes nothing; ▸ `no_room` writes begin +
  `failed{no_room}`, so it parks), `job{begin}` (durable), `agent{started, job}`, structuredCall (agent
  filing|historian, tag null, priority background, idleDelaySec, `<jobId>:<agent>` prefix, budget
  `filing.timeoutSec ?? (conn.local ? 300 : 120)` s, samplers = the binding's (no max_tokens) with
  temperature ?? 0.3, reasoning as the Director's rule, maxTokens min(request, caps.maxOutput, binding
  limit; historian also the room left), repair on, count = the engine's counter). Staging/ops are against
  ▸ the fold at `on` WITHOUT the key's own rows (`foldWithout`), so a refile or a stale re-write stages
  against what the rest made (else its items would read as no-ops and the new row would empty the entries).
  Readers are wrapped: ▸ `{}` → nothing (ruling G is applied in the lane; filing.ts/historian.ts still call
  `{}` unreadable). mem row: `{key, on, by, range, ops, skipped? (capSkipped), gen{model, profile, transport,
  calls, ms}}`. Written only if the task still stands (▸ `on` on the path, nothing in its range touched after
  the begin seq, no revert of the key after it, the agent still on); else nothing (superseded).
- **Outcomes**: preempted → `agent{preempted}`, count++ (3 → starved, `memory_starved` once), re-queued;
  aborted (shutdown/superseded) → nothing; other codes → `job{failed, code}`, `agent{failed, code, reason?}`,
  and `agent{parked}` when that was attempt maxAttempts; transport_unsupported → the shared caps.suggest
  notice (STRUCTURED_REFUSED_KEY, once per session for every agent). A done or failed attempt resets the
  preemption count. A throw outside the call → `failed{internal}` (▸ parks a buggy loop); a lost lock
  (SessionLockedError) stops the lane.
- **Recovery** (rule 1) ▸: a key whose NEWEST job row is `begin` or `retry`, with no mem row of the key and no
  `revert` of it after that row, `on` on the path → asked for by name (spec: the derived one, else the row's
  stored range, else a single exchange). A revert after it means an undo superseded it: not re-run.
- **Supersession**: every poke checks the running task (as above) and aborts it 'superseded'; undo cancels its
  key's run and its queued refile.
- **Events** (bus only, never `openEvents()`, never inside a turn's stream: the lane looks after the terminal
  event via `turnSettled`): `agent{queued}` (▸ no job: the job id is drawn at begin) each time a key ENTERS the
  queue (▸ a failed or preempted task re-entering is told again), `agent{started|preempted|done|failed|parked,
  job, count?, skipped?, code?, reason?}` (done: count = ops, skipped = skipped lines), `idle{background:n}`
  when queued + running changes, `memory` per entry the row really changed (`publishChanges`: the keys of the
  row's own effects in application order, compared before/after with `sameEntry`; ▸ `created` for an entry
  that existed before becomes `merged`), `retry`/`usage` of the calls.
- **Notices** (bus): `memory_backlog` (warn, backlog > everyN + 3, once), `memory_starved` (warn, once),
  `filing_classic_conflict` (info, once per normalized name: key `filing_classic_conflict:<name>`),
  `slots_shared` (info, once, while the Compendium is on: two distinct connection ids among narrator,
  its fallback, director, recorder, recall with one origin), `keep_requests_failed` (shared key with turns).
- **Scheduler** (D-172): `engine.ts` passes the engine timers to `createScheduler`. `touch` (every origin of the
  session's connections) at open/create, every runTurn start (▸ all kinds), turnEnded, edit, hide, select.
- **Session wiring**: `lane.recover()` + `lane.open()` after the turns' recovery at open; `lane.open()` at
  create; poke after send, turnSettled, edit, hide, select, configure, the lane verbs; `close()` closes the lane
  first (aborts a run 'shutdown', awaits it). `SessionImpl.tree()` is now cached on (version, memSeq, ▸ jobSeq):
  job rows did not invalidate it (parking never counted).
- **Verbs**: undo/refile/retry refuse `session_busy` during a turn, `not_found` for an unknown message,
  `invalid_params` for a message off the active path or a bad `task`. Undo: the keys bound to the message
  (per kind, filing first: `on` = message, else a range holding it), only `applied` ones; dry-run fold; one
  revert row per key (`on` = taskOn(key)); `memory{reverted, by:'user'}` per entry of the undone row's effects
  that the undo really changes; nothing bound → `not_found`; nothing applied → changed:false. Refile: the bound
  keys (any status) as asked-for tasks; ▸ none bound: the derived group holding the answer, else a single
  exchange task for an assistant message after the first user message, else `invalid_params`; ▸ a parked key
  → `invalid_params` (retry it); already queued or running → changed:false. ▸ Not written: a refile lives while
  the session is open (once begun, rule 1 re-runs it). Retry: parked keys on the path (or bound to the
  message: `on`, or range holds it) → `job{state:'retry', job:<new id>, attempt: 1}` each (▸ attempt = the next
  run's), queued. memoryWait: drives the lane in both modes (in auto it is what the lane does anyway); returns
  status + `idle` (false on timeout or when a runnable task is left); ▸ allowed during a turn.

## What the CLI/TUI builder (wave 3) needs

- `/memory undo|refile <ref|#n> [file|hist]` → `memoryUndo|memoryRefile({messageId, task})`; `/memory retry
  [#n]` → `memoryRetry({messageId?})`; `/memory wait [sec]` → `memoryWait({timeoutMs: sec*1000})`; `/memory
  status` → `memoryStatus()`. Print `keys`/`changed:false` like the M5a verbs' changed:false.
- Lane events and notices are on `engine.events()` only (sessionId stamped). The REPL has no bus subscription:
  it must subscribe (or drain between turns) to show `agent`/`memory`/`notice` lines; the TUI tail filter
  (cli/tui/run.ts) drops `agent`/`notice`/`idle` and everything while a turn runs.
- `agent{queued}` has no `job`; `job` ids are `j_<8 hex>`; callKeys `<job>:filing:<n>` / `<job>:historian:<n>`
  (the TUI's agentOfKey reads `split(':')[1]` → the agent).
- One-shot `rp-core send` in auto mode: the lane may begin a task at the turn's end (wait 0, or a remote
  origin at send) and close() aborts it, leaving a `job{begin}` that the next open re-runs (no attempt
  counted). Open the one-shot engine with `lane: 'manual'` if those begin rows are unwanted (G-7).
- `onProviderError` info has `turnId?` and `job?` now (runtime.ts debugLine ignores both).
- `test/repl/repl.test.ts:358` builds a fake SessionHandle: it needs the five new verbs to typecheck (not my
  file; the only `tsc` error left).

## Deviations / open questions

1. Ruling G items outside my files, not done: historian `critical` → `pivotal`, «1200» without a separator,
   the digest leaving out failed/abandoned plots (historian.ts), `{}` read as nothing inside filing.ts and
   historian.ts (the lane wraps both readers instead).
2. A fork's moment is the fork-at message's seq: an answer the source had not yet accepted at the fork point
   (A_at with wait 1) is never filed on the fork (literal C-11; flag if back-fill of that one is wanted).
3. `agent{queued}` is repeated each time a key re-enters the queue (after a failure or a preemption).
4. Starvation's "goes first" is observable only when the starved key is not already first.
5. The lane recomputes eagerly in manual mode too (events and notices are truthful; nothing runs).

## Fixes after the review (fix-lane; the lead's ruling I)

Files: `src/engine/lane.ts`, `src/engine/session.ts` (open, publishChanges, header), `src/engine/api.ts`
(MemoryStatus, verb docs). Tests: `test/lane-m5b/{named,derive,pace}.test.ts` (new), `lane.test.ts` (rule 1
rewritten, one new), `calls.test.ts` (+4), `test/demo-m5b/turn-first.test.ts` (the send-alone test follows
ruling I). Each fix was checked by undoing it in place: its test fails.

- **Held, never begun** (lane#1, historian#1, breaker#1): a task asked for by name (refile, retry) whose
  agent is off (`filing.enabled` false, `historian.interval` 0) is kept but not queued: `MemoryStatus.held?`
  lists it; it runs once the agent is on. Safety net: a run superseded before anything new was written
  is not begun again until the journal moves (`noRerun`).
- **Recovery is the derivation** (lane#4, historian#2, sched#1, breaker#5): `Lane.recover()` is gone. At
  open the lane looks once: a dangling `job{begin}` runs again (same attempt: a begin is not a failure)
  exactly when its key is in the derived debt; begins of superseded historian windows, of covered
  answers and of refiles cut short are dropped. A forced historian task whose range other historian
  rows cover is dropped.
- **Stale is debt whatever the moment** (lane#3): an answer a stale filing row (or a reverted+stale one)
  spans is counted before the enable moment; the historian's synthetic floor (positions before the
  moment) leaves holes where a stale historian row lies (keys `hist:#n`, local to the derivation).
- **Split** (lane#5, filing#1, breaker#6): a derived split adds both the cut and the group's own last
  answer to `splits`: both halves are tasks at once.
- **Fork moment** (breaker#9): just before the earliest answer of the fork point's path with fewer than
  `wait` visible user messages after it (the fork header's filing.wait); at the fork point when none.
  With wait 0 that is the fork point itself (the fork-point answer was accepted on the source).
- **Parking**: one `no_room` failure parks (lane#10: one begin + one failed, events failed + parked, no
  started); `parked[].code` = the last failure's code. A parked historian key that is not the due window
  (its key moved) or that another pass covered is not listed (cli#1).
- **Retry** (lane#6, cli#2, breaker#10): a picked key the derivation does not hold is queued by name
  (`specOf`), derived ones need nothing; backoff cleared. Refused (invalid_params) while the Compendium is
  off (cli#10).
- **Refile refusals** (lane#11, cli#7, cli#8, cli#10), invalid_params in words: "the Compendium is off:
  nothing is filed while it is (turn it on first)"; "message <id> is hidden: hidden messages are not
  filed"; "the answers <key> files are hidden: …"; "message <id> is not accepted yet: an answer is filed
  once N visible user message(s) follow(s) it (compendium.filing.wait)". A held key counts as queued
  (changed:false).
- **Binding** (lane#9): `boundKeys` ranks applied < reverted-not-stale < other, then `on` before range,
  then the newest row: undo and refile bind the effective row whose range holds the message.
- **When the lane starts** (lane#7, lane#13, sched#8, lane#14): never during a turn of the session (manual
  memoryWait waits for the turn to settle); auto mode also holds while the head is a user message younger
  than max(idleDelaySec, 2 s) (age from `ctx.clock` and the msg ts; one timer per message, then released),
  and spaces a key's attempts after a failure: 15 s × 2^(attempt − 1), ≤ 5 min (per key, auto only; a
  retry, an undo, a done or failed attempt clears it; close clears every timer). memoryWait in auto mode
  only waits (it lets the pump do what it does); in manual it runs and ignores both waits. memoryWait's
  timeout is clamped to 2^31 − 1 ms (cli#11's engine side).
- **Events**: `agent{started}` on the first slot grant of the run's calls (sched#7: the lane hands
  structuredCall a tapped Scheduler whose acquire marks it; `MemoryStatus.running.waiting?: true` until
  then); `agent{skipped, reason:'superseded', job}` for a run the ground left or whose result was dropped
  (cli#4; shutdown tells nothing); `done.skipped` = the uncapped count (filing#9); `memory{reverted, by:
  agent}` for each entry the key's replaced applied row had changed that the new row did not touch and
  that is gone or changed (lane#8; `LaneHost.publishChanges(before, after, seq, by, key)`);
  `notice{recorder_unavailable, warn}` once when work is owed and the recorder has no route, and
  memory_backlog is not told meanwhile (cli#9). Preemptions are counted per key for filing and per agent
  ('hist') for the historian (sched#2).
- **Usage** (cli#6): the mem row and a `job{failed}` row carry `calls: TraceCall[]` ({callKey, agent,
  model 'conn:model', ms, usage?}) when the attempt made calls, the same rows as a turn's trace.calls
  (rows are open to extra fields; `gen.calls` stays the count). The bus `usage` events were already sent.
- **Historian too large** (historian#3, breaker#4; historian.ts is the agents fixer's): the lane builds the
  prompt without messages, passes `budget` = window − that − AGENT_OUTPUT_FLOOR to `historianWindowAt` when
  the window's texts exceed it (historian.ts cuts them head+tail; the cap cut itself is historian.ts's),
  then, as a last resort for line overheads, cuts the largest message (filing's cutMiddle) until the
  request leaves the floor (`fitHistorian`); no_room only when the prompt alone does not fit.
- **Refused summaries** (historian#10): `historianOps().offered > 0 && applied === 0` fails the attempt
  (`job{failed, code:'invalid'}`, reason "every summary of the historian's answer was refused: <first
  skip>"); the window stays due; an answer that offered none still closes it.

### For the CLI fixer (exact changes)

- `agent` events: `started` now comes at the slot grant (a pass held by the idle gate shows queued →
  (begin row) → started later, or never if superseded/shut down first); new `status:'skipped'` with
  `reason:'superseded'` and `job` ends a begun run (the TUI block should leave 'started' on it);
  no_room: `failed{code:'no_room'}` then `parked{code:'no_room'}` with no `started`.
- `memory{change:'reverted', by:'filing'|'historian'}` can now come from a refile/re-write.
- `notice{code:'recorder_unavailable'}` (warn, once per session) names the binding's conn and model.
- `MemoryStatus`: `running.waiting?: true` (begun, nothing sent yet), `parked[].code?`, `held?:
  LaneTaskInfo[]` (absent when none). `memoryRefile` returns changed:true for a held task (the REPL
  should say it waits for the agent rather than "/memory wait waits for it").
- Refusals above (refile: off, hidden, all-hidden pass, not accepted; retry: off) arrive as
  invalid_params with those messages; the REPL can print them as is.
- Undo/refile hint (cli#3): build it from the undone keys (`file:` → `file`, `hist:` → `hist`).
- /usage (cli#6): count, per `agent`, the `calls` rows of mem rows (by 'filing'|'historian') and of
  `job{failed}` rows whose `on` is on the path, priced by each row's `model`, as pathUsage does for
  trace.calls; let the TUI's isLaneEvent pass `usage` events.
- Auto mode: `/memory wait` now waits through a key's backoff (15 s, then 30 s) before "parked"; a send
  on its own starts nothing for max(idleDelaySec, 2 s).

## Final-check fixes (fix2-lane; the lead's ruling K)

Files: `src/engine/lane.ts`, `src/engine/api.ts` (MemoryStatus.blocked, verb docs), `src/engine/session.ts`
(dry runs pass `trial`). Tests: `test/lane-m5b/final.test.ts` (new, 15). Each fix was checked by undoing it
in place: its test fails.

- **Staging = the fold (order#1)**: `foldWithout` is gone; a pass stages (snapshot, findMatch, required
  fields, no-op drop; the historian's digest and ops too) against fix2-fold's `foldStaged(tree.mems, {head
  path, touched, library, msgs}, {key, on})`: the rows that sort before (pos(on), agent, ∞), without the
  key's own. Its checkpoint is kept on purpose (the landing pass's view resumes from it). A person's row
  made while `on` or a later message was the head is never in a pass's snapshot.
- **Dry runs (order#4)**: `dryRun` and `memoryUndo`'s trial fold pass `trial: true` (no checkpoint).
- **Splits survive a reopen (lane#5, filing#1, breaker#6)**: the first part's mem row records `groupEnd`
  (the end of the whole group; a part split again keeps the outer end; a re-written or refiled first part
  carries it over from the key's older row). The derivation closes a run at the `groupEnd` of any
  effective filing row on the path, so after a reopen the rest of the group is a task at once (a dangling
  begin of it re-runs with its attempt). `final/v12-loop-recover-split/split-reopen.ts` now ends with both
  halves filed.
- **Parked keys re-validated (lane#1 regression, cli#1)**: a parked `file:` key the derivation does not
  hold is not listed (so not retried, no retry row) when each of its answers (its asked-for spec, else the
  stored range, else a single exchange) is hidden, covered by ANOTHER key's effective filing row, or part
  of another derived filing task. A parked refile whose answers only its own old row covers stays listed.
- **Circuit breaker (cli#1)**: per agent, parks in a row (a done task resets; `no_room` parks count). Two
  → the agent is paused: its tasks stay in `queued` but never start (pump and memoryWait skip them;
  memoryWait comes back `idle: true`), `notice{memory_paused, warn}` once per agent per session
  (key `memory_paused:<file|hist>`), `MemoryStatus.blocked`. Any `memoryRetry` resumes every paused agent
  (returns `{keys: [], changed: true}` when nothing was parked); the next open starts unpaused (in memory
  only). memory_backlog is not told while filing is blocked.
- **`MemoryStatus.blocked?: {agent: 'filing'|'historian'|'both', reason: 'no_route'|'paused', message}`**
  (cli#9): `no_route` whenever the Compendium is on, an agent is on and the recorder has no route (it
  wins over `paused`); `message` is a sentence; for no_route it is exactly the recorder_unavailable
  notice's text.
- **recorder_unavailable for a historian-only setup (lane regression 7)**: with no route the historian's
  due window is still derived on a stand-in window (8192, `DEFAULT_LOCAL_WINDOW`; never run on it), so it
  is in `queued`, the notice is told, and blocked says why. Notice text by agents on: `The Compendium's
  filing and historian cannot run: …` (unchanged), `… historian cannot run: …`, `… filing agent cannot
  run: …`.
- **Refile (lane regression 5)**: with no `task`, an accepted answer that no filing key is bound to gets
  its filing task (its derived group, else a single exchange) besides every pass bound to it; `keys` lists
  filing first (`[file:A1, hist:G-A1]`). Not accepted yet: refused only when nothing else is bound.
- **Historian cut-off (agents-cli regressions on lane.ts :1322/:1324)**: `prep.row(value, readSkipped,
  res.cutOff === true)`. The row's `skipped` = the read's own lines (cut_off, extra block: readSkipped
  minus the reader's skips) + historianOps'; `done.skipped` counts them. An answer applying no summary
  fails the attempt when it was cut off (`undecodable`, "the historian's answer was cut off before a
  summary closed") or offered summaries (`invalid`, as before); the window stays due.
- **Words**: refile's all-hidden refusal is now `<key> has no visible answer left: hidden messages are not
  filed` (was "the answers <key> files are hidden: …"); every refusal about a pass names it by its task
  key, as before (`file:<id>`, `hist:<from>-<to>`).

### For the agents fixer's CLI part (API and wording changes)

1. `/memory status`: print `MemoryStatus.blocked` (e.g. `  blocked: <message>`); `/memory wait`'s "the
   background lane cannot run" line can key on `blocked.reason === 'no_route'` and say "paused" for
   `'paused'` (its tasks are listed in `queued` and wait returns idle:true). TUI: a paused agent's
   queued block stays `queued`.
2. `notice{code: 'memory_paused', level: 'warn'}` (once per agent): printed like every bus notice; its
   text says "/memory retry".
3. `memoryRetry()` may return `{keys: [], changed: true}` (a paused agent resumed, nothing parked): today
   the REPL would print "queued again:  (…)" with no names — say e.g. "filing resumes (nothing was
   parked)".
4. `memoryRefile` may return a filing key the person did not name next to the historian's, filing first
   (`/memory refile #1` → `filing #1 and historian #1–#1 queued again`).
5. Ruling K words: lane refusals carry task keys; `laneRefusal` should render every
   `\b(?:file|hist):[0-9a-f]{8}(?:-[0-9a-f]{8})?\b` with `passName(key, words)` (and may turn
   "/memory retry" into "/memory retry #n"). `test/repl-m5b/lane.test.ts:216` pins the raw-key text.
   The all-hidden refusal's wording changed (item above).
6. With no recorder route, `queued` also holds the historian's due window (counts in "N tasks queued");
   the recorder_unavailable text for a historian-only or filing-only setup names that agent.
7. mem rows may carry `groupEnd` (a split's first part): readers can ignore it.

### For the lead

- Dry runs' `trial: true` has no engine-level test that fails without it: fix2-fold's frontier
  checkpoint keeps a lagging pass cheap either way; it is pinned at the fold level
  (`test/fold-m5b/final.test.ts`, order#4).
- `final/order/rename.ts` still prints two characters: its scripted recorder answers «Фрол Седой» whatever
  the prompt shows. The prompt now shows «Фрол» only (the rename follows the pass), and the staging agrees
  with the view; the final.test.ts version answers the name its snapshot shows and gets one entry.
