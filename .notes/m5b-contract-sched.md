# M5b contract: sched (D-172; the call side of D-171)

Builder: sched (wave 1). Files: `src/engine/sched.ts`, `src/engine/abort.ts`, `src/engine/narrate.ts`,
`src/agents/structured.ts`; tests `test/sched-m5b/` (sched, abort, calls). Nothing ported (fresh code, no
provenance note).

## Exported API

`src/engine/sched.ts`
```ts
type Priority = 'interactive' | 'background';
const STARVED_AFTER = 3;                              // D-172 starvation threshold (the lane counts)
interface Slot { release(): void; readonly signal: AbortSignal }   // signal: TypedAbort('preempted'), background only
interface AcquireOpts { idleDelaySec?: number }      // background: the requesting session's compendium.idleDelaySec
interface OriginSemaphore {
  readonly capacity: number;
  readonly local: boolean;                            // follows the local rules
  inFlight(priority?: Priority): number;              // a preempted holder counts until it releases
  waiting(priority?: Priority): number;
  acquire(priority: Priority, signal?: AbortSignal, opts?: AcquireOpts): Promise<Slot>;
}
interface Scheduler { forOrigin(origin: string, capacity: number): OriginSemaphore; touch(origin: string): void }
interface SchedulerOptions { timers?: DelayTimers; isLocal?: (origin: string) => boolean }
function createScheduler(opts?: SchedulerOptions): Scheduler;   // defaults: realTimers, isLocalOrigin
```

`src/engine/abort.ts`: `AbortReason` gains `'budget:filing' | 'budget:historian'` (`'preempted'` was there).
New `linkAbort(ctrl: AbortController, signal: AbortSignal): () => void` (a second parent: ctrl aborts with
signal's reason; returns the unlink; drops itself once ctrl aborts).

`src/engine/narrate.ts`: `CallInput.priority?: Priority` (absent = interactive), `CallInput.idleDelaySec?:
number` (background only). `CallResult.preempted?: true`, set together with `stopped: true` and with `error`
removed, only when the place was taken before the finish. `RoundsInput` omits both fields (the narrator's
loop is always interactive). Neither field reaches the `ModelRequest`.

`src/agents/structured.ts`: `StructuredFailCode` and `AttemptOutcome` gain `'preempted'`;
`StructuredInput.priority?: Priority`, `StructuredInput.idleDelaySec?: number`;
`StructuredResult<T, C extends StructuredFailCode = StructuredFailCode>`; `InteractiveResult<T>` (= every
code but 'preempted'). Overloads: `structuredCall(input & { priority?: 'interactive' }) →
InteractiveResult<T>` (the Director's call site compiles unchanged), any other input → `StructuredResult<T>`.
Budget reasons: filing → `budget:filing`, historian → `budget:historian` (still code 'timeout').

## Behaviour

- Remote origin: background runs alongside while places are free. Each interactive waiter that the free
  places (counting places already on their way back from preempted holders) cannot serve preempts the
  MOST RECENT unpreempted background holder.
- Local origin: any interactive request in flight or queued preempts EVERY background holder, even with a
  free place; a background waiter is granted only with no interactive request in flight or queued and its
  idle gate open. Among background waiters the first whose gate is open goes (FIFO otherwise).
- A preempted holder keeps its place until it releases (its call is aborting): the origin never carries
  more than its capacity, and the M1a test "interactive overtakes background" keeps its exact counts.
- Idle gate: local origins only (D-172's local sentence + "remote runs alongside"; the config's own
  comment says the delay is for the local origin). `touch(origin)` is a no-op on a remote origin; a touch
  before the first `forOrigin` of a local origin is remembered. The end (release) of every interactive
  slot on a local origin is a touch too, so the gap between the Director's call and the narrator's does
  not let background in. The wait is timer-only (no clock: the test clocks step on every read): per delay
  value, one timer since the last touch; a request arriving with no wait of its delay running since the
  touch waits its full delay from its arrival (never shorter than the rule; the lane asks right after a
  touch, so they coincide). A wait that has passed lets later requests of that delay straight in until the
  next touch. Never touched = open; `idleDelaySec` 0/absent = no wait. A gated waiter that aborts leaves
  no timer behind.
- Locality is `isLocalOrigin(origin)` (injectable), not `Connection.local`: `script:` connections are built
  with `local: true` (cli/provider.ts) but are remote here as D-172 says; `replay:` too.
- streamCall, background: the slot's signal is linked to the call controller (abort reason 'preempted').
  Preempted between the grant and the send → nothing sent, `onSlot` not called (no budget armed), slot
  released. Preempted after the finish → the answer is kept, no `preempted`. Interactive calls: the same
  acquire as before, nothing else changes.
- structuredCall: `preempted` ends the agent call at once — no §6.6 retry, no corrective pass, `read()` is
  not called. The agent's own signal outranks it (Stop/shutdown/superseded → 'aborted', budget →
  'timeout'). The preempted call still has its `calls[]` trace row (and a `usage` event if usage arrived,
  normally none); `attempts` ends with outcome 'preempted'.

## For the wave-2 lane / engine builder

- engine.ts builds `createScheduler()` today: pass `{ timers: opts.timers ?? realTimers }` (the same timers as the
  ctx's) so tests' fake timers drive the idle gate. With real timers nothing else changes.
- Lane call: `structuredCall({ agent: 'filing' | 'historian', priority: 'background', idleDelaySec:
  resolved.idleDelaySec, callKeyPrefix: `${jobId}:filing` (→ `<jobId>:filing:0`, `:1` for the retry or
  the corrective pass), budgetMs: filing.timeoutSec * 1000, turnSignal: jobCtrl.signal, env: { …,
  keepRequest } })`. Result `code === 'preempted'` → re-queue the same key, no `job{failed}`, same
  attempt; for 'aborted' read `reasonOf(jobCtrl.signal)` ('shutdown' | 'superseded').
- Starvation is the lane's: count `preempted` per task key, reset on a completed attempt (done or
  failed); at `STARVED_AFTER` the task goes first and `memory_starved` once per session.
- Touch with `ctx.sched.touch(origin)` for every origin the session's routes use (narrator, Director,
  filing/historian connection) on turn end, head move, edit, hide, continue, swipe and session open.
  Calling it for remote origins is harmless.
- The gate and the local rule wait INSIDE the semaphore queue, i.e. inside `structuredCall`. A job whose
  `job{begin}` is written before the call may sit queued for `idleDelaySec`+; aborting `jobCtrl` leaves
  the queue cleanly. structuredCall has no hook for "the slot is granted" (its `onSlot` is internal);
  add one if `agent{status:'started'}` must mean "sending", not "queued".
- `slots_shared` (G-21) has no scheduler API: compare the routes' `conn.origin` in the session.

## Open questions

- Array root (rpcore.md item 8): `readAnswer` still requires an object root, and `firstObject` finds the
  first inner object of a bare `[...]` answer. The filing lenient read (D-175: "a top-level array" envelope)
  needs an opt-in in structured.ts (e.g. `arrayRoot` for `tag: null`); not done here (outside D-172).
- A user's `local = true` on a host `isLocalOrigin` does not know (e.g. a VPN address) does not get the
  local scheduling rules. `SchedulerOptions.isLocal` can take a predicate built from the connections
  (`conn.local` except `script:`/`replay:`) if that is wanted.

## Fixes after the review (fix-agents; the lead's ruling I) — structuredCall

Files: `src/agents/structured.ts`. Tests: `test/structured/review-m5b.test.ts` (new, 15).

- **Budget only while holding a slot** (sched#3): for `priority: 'background'` the budget timer is
  cleared when a call returns (what was used is subtracted, measured with `env.clock`) and re-armed with
  what is left at the next call's `onSlot`. So a §6.6 retry or a corrective pass queued behind a turn, and
  the backoff before it, are not timed; the held time of all calls still adds up to `budgetMs`. An
  interactive call keeps D-101's single running budget from its first slot.
- **Cut-off answers** (breaker#3): for `tag: null` an answer whose JSON never closed (any finish) goes
  through the exported `closedItems(json)`: its items are the elements of the root list or of the lists the
  root object holds as member values; the text is cut back to the last item or member that closed (or to
  an opened list) and its brackets closed again. No closed item → `undecodable` ("the answer was cut off
  before its first item closed": the corrective pass, then a failed attempt — never an empty cover); else
  the reader gets the closed items and the result's `skipped` gains `{path:'answer', why:'cut_off: the
  answer was cut off; its unfinished last item was left out'}` when something unfinished was dropped. A
  root object with no list is one item (a bare item cut off is undecodable). The plan tag is unchanged.
- For the lane: the filing row already takes `res.skipped` (the cut_off line lands there); the historian
  row uses only `historianOps().skipped`, so its cut_off line is lost unless the lane adds `res.skipped`'s
  `path: 'answer'` entry.

## After the final check (fix2-agents; the lead's ruling K) — structuredCall

Files: `src/agents/structured.ts`. Tests: `test/structured/ruling-k.test.ts` (new).

- **`cutOff`** on the ok result (tag null only; `StructuredResult` ok branch `cutOff?: true`, also on
  readAnswer's ok `Read`): the answer read was cut off — its call finished with `'length'`, or its JSON
  never closed and closedItems closed it (whether or not an unfinished item was left out). Absent
  otherwise; the plan tag never sets it. The `cut_off` skip line is unchanged (only when an unfinished
  item was left out).
- **For the lane** (lane.ts is not mine): the historian row should fail the attempt when
  `ops.applied === 0 && (ops.offered > 0 || res.cutOff === true)` (ruling K: "applies no summary while it
  was cut off, or offered summaries"), and its `skipped` should take `res.skipped`'s `path: 'answer'`
  entries (the cut_off line) besides `historianOps().skipped` (it already holds the reader's own), so the
  row and `done.skipped` say it. `prep.row(res.value, res.skipped)` needs `res.cutOff` for that.
- **A bare flat item root** (agents-cli structured.ts:425): closedItems reads a root object as ONE item
  — its lists are its fields (`relationships`), not item lists — when it has a type, identity or entry
  key (`type`, `entry_type`, `entry`, `data`, `name`, `title`, `topic`, `summary`, `parent_plot`, any
  case/spelling) and no envelope key (`filings`, `entries`, `items`, `summaries`, `recaps`, `plots`,
  `storylines`, `arc(s)`, `overviews`, `plot_overviews`). Cut off, it closed no item: `undecodable`
  (the corrective pass, then a failed attempt) — never filed half, never an empty cover. A type-keyed
  root (`{"character": [...]}`) and the envelopes hold items as before.
