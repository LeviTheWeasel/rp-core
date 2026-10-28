# M5c wave 1 — seams (D-203's scheduler half, D-207)

Files: `src/engine/sched.ts`, `src/engine/engine.ts`, `src/providers/scripted.ts`, `test/preload.ts`,
tests in `test/sched-m5c/` (`boost`, `order`, `locality`, `scripted`; there is no `test/providers/`, so
the scripted provider's M5c tests live here too). Fresh code, nothing ported (no provenance note).

## sched.ts

Interactive behaviour is unchanged: without a boost or `after`, every request is served exactly as in
M5b (the two FIFO queues became one arrival-ordered list read per priority; same grants, same
preemptions, same idle gate). The `Scheduler` and `OriginSemaphore` interfaces have no new required
members, so lane.ts `tapped()` keeps compiling.

- `AcquireOpts.boost?: Boost` and `createBoost(): Boost` (`promoted`, `promote()`, `demote()`; starts
  demoted; idempotent). While promoted, every request acquired with the boost is interactive:
  - queued: served with the interactive requests in arrival order (a prefetch queued before U goes
    before the Director's later request), past the idle gate; on a local origin it preempts every
    background holder, on a remote one it counts as an interactive waiter;
  - held: never preempted; on a local origin it keeps other background off (filing is preempted, a
    waited-for prefetch is not: T6).
  - Demoted: back to the priority asked for; a held background request is preemptable at once (a
    demotion with an interactive request queued, or on a local origin with one in flight, preempts it
    in the same step). A demoted queued request's idle-gate wait runs from its arrival, not from the
    demotion (its timer is kept while promoted).
  - A holder preempted before the promotion stays preempted (its abort has fired) and counts as
    background. So promote before the turn makes any interactive request on that origin.
  - The release of a promoted holder is a touch (an interactive request ended): the idle gate starts again.
  - `inFlight(p)`/`waiting(p)` count by the priority each request has now.
  - One boost may cover requests on several origins (each semaphore is pumped when it moves).
- `boosted(sched, boost): Scheduler` — the scheduler a prefetch run's calls see (every acquire carries
  the boost). The lane can wrap its `tapped(r)` result with it, or add `boost` inside `tapped`'s acquire.
- `AcquireOpts.after?: PromiseLike<unknown>` — the request joins the queue only once it settles
  (fulfilled or rejected alike); an abort while waiting rejects with the signal's reason and never
  takes a place; `waiting()` does not count it meanwhile.
- `ordered(sched): Ordered` (`first`, `second`, `open()`) — Director-first on one place: `first` is the
  Director's scheduler (its first acquire opens the order the moment its request is queued or granted,
  its own `after` honoured), `second` is recall's (every acquire waits for the order, plus its own
  `after`). On one place the Director is served first and recall after it; on two both run alongside.
  The order no longer depends on `resolveKey` microtasks. **The caller must `open()` in a `finally` of
  the Director's work** (Director off, reused, refused, key failure), or recall waits until its signal
  aborts. Use it when the two routes share an origin (harmless otherwise, but recall then waits for
  the Director's key resolution).
- `connectionLocality(connections, fallback = isLocalOrigin)` → the `isLocal` predicate;
  `declaredLocality(conn)`; `LocalityConnection` (Connection fits). See the deviation below.

D-201's "scheduler's locality" for `auto`/`onMiss`: `ctx.sched.forOrigin(route.conn.origin,
capacity).local` (same capacity streamCall uses: `floor(caps.maxInFlight)`, min 1; making the
semaphore early is harmless). No `Scheduler.isLocal` was added (it would break `tapped()`'s literal).

## engine.ts

- The scheduler gets `isLocal: connectionLocality(() => [...Object.values(ctx.connections), providerOverride?])`,
  read when an origin is first used (and for touches before that).
- `RP_CORE_RECALL` read once per `Engine.open`: `lexical` or `off` → `ctx.recallDefault`; anything else
  (unset, `auto`, `sync`, typos) → absent. `EngineSeams.recall?: 'lexical' | 'off' | 'config'` decides
  instead ('config' = no override: an M5c test opting in under the preload). Types exported:
  `RecallOverride`, `RecallDefaultCtx`.
- `recallDefault` sits on the ctx object beside `EngineCtx` (typed `EngineCtx & RecallDefaultCtx` in
  engine.ts) because context.ts is not this builder's file. **Wave 2:** add
  `recallDefault?: 'lexical' | 'off'` to `EngineCtx` and read `ctx.recallDefault` in the mode
  resolution. Intended meaning (D-207 "overrides the recall mode default"): it replaces only the
  default, i.e. when the session's raw `compendium.recall.mode` is absent or invalid —
  `resolveCompendium` fills `'auto'` itself, so check the raw config (or give resolveCompendium the
  default). A mode from config.toml, the session config or `/memory mode` wins; M5c tests opt in that
  way, with `recall: 'config'`, or with `RP_CORE_RECALL=auto` in a spawned CLI's environment.
- `src/cli/main.ts` documents `RP_CORE_LANE` in its help text; `RP_CORE_RECALL` could go next to it.

## scripted.ts

- A call line `{"steps": [...], "agent": "narrator|director|recall|filing|historian", "requestHash"?}`
  (`ScriptCall.agent`). A request takes the first unconsumed line tagged with `req.agent`, else the
  first unconsumed untagged line; a line tagged for another agent is never taken. Untagged scripts
  play exactly as before. `remaining()` counts tagged lines too; `requests` stays in arrival order.
- `script_exhausted` keeps its message; when lines tagged for other agents are left it appends
  `; left for other agents: director 1, recall 2`.
- `createScriptedProvider(calls, { timers?, localOrigin? })` (`ScriptedOptions`); the provider shows
  `localOrigin` only when given. `parseScriptFile` accepts `"local": true|false` on the first line,
  alone or beside `"caps"` (`{"caps": {...}, "local": true}`), and returns it as `local`.
- **Wave 2 (cli/provider.ts `scriptConnection`)**: pass it on —
  `createScriptedProvider(parsed.calls, parsed.local !== undefined ? { localOrigin: parsed.local } : undefined)`,
  and probably `local: parsed.local ?? true` on the connection (windows, timeouts). The demo's process 3
  (`{"caps": …, "local": true}`) is then local, process 2 (no `local`) remote, as demo.md G1 proposes.
  `src/testing/index.ts` may want to export `ScriptedOptions`.

## test/preload.ts

`RP_CORE_RECALL=lexical` beside `RP_CORE_LANE=manual` (comment explains the opt-ins). Nothing reads
`recallDefault` yet, so nothing changes until wave 2 wires it.

## Deviation: D-207's locality ("the connection's `local` flag when set")

`Connection.local` is a required boolean, and almost every test connection is `local: true` on a
`script:` origin (for windows and timeouts). Honouring that flag as is turns those origins local in the
scheduler: probed in this wave with lane-m5b, about 30 tests failed on 5 s timeouts (the kit's
recorder `script:rec` became local, so `memoryWait` sat behind the default 8 s idle gate and local
preemption changed). So "set" is read as:
- a configured connection (it has `baseUrl`): its `local`, which config.ts already makes "the config's
  `local` when set, else isLocalOrigin" — the user's override now reaches the scheduler too;
- an in-process connection: only when its provider says so (`localOrigin`, from a script's `"local"`
  line or the option);
- otherwise `isLocalOrigin(origin)`; connections on one origin that disagree: local wins.
Pre-M5c tests keep their M5b scheduling; M5c engine tests get a local scripted origin with
`createScriptedProvider(steps, { localOrigin: true })` (or, as lane-m5b does, an `http://127.0.0.1:…`
origin). Tests with a configured connection whose `local` contradicts its URL: none found that run background work.

## Wave 2 checklist

- Lane prerecall: one `createBoost()` per run; its calls through `boosted(tapped(r), boost)`. A
  LaneHost/TurnHost accessor exposes promote/demote to the turn.
- Turn grace wait: `boost.promote()` before any interactive acquire on that origin; await ≤ graceSec;
  on adoption nothing to undo; on Stop `boost.demote()` (the prefetch runs on at background); on a miss
  the lane supersedes the run (demote first if it is to keep running). Whether a queued (not started)
  prefetch is promoted or counted a miss (demo.md G5) is the turn's choice; the scheduler supports both.
- Turn sync recall beside the Director: `const order = ordered(ctx.sched)` when both routes share an
  origin; the Director's env gets `order.first`, recall's `order.second`; `direct().finally(order.open)`.
- EngineCtx `recallDefault` and the mode resolution as above; CLI provider.ts `localOrigin`.

## Tests

`TMPDIR=… bun test test/sched-m5c` — 51 tests (boost 16, order 14, locality 8, scripted 13). Run at the
end with `test/sched-m5b test/engine test/lane-m5b test/infra/sched.test.ts test/infra/scripted.test.ts
test/adapter-m3/scripted.test.ts`: 669 pass, 0 fail. `bunx tsc --noEmit -p .` clean.

## After the review (ruling K, sched#7; fix-engine)
`ordered().second` waits for the order only on a one-place semaphore (`capacity > 1`: it acquires at
once, never waiting for the Director's work before its request); the turn also builds `ordered()` only
when the Director shares recall's origin with one place. Test: order.test.ts "two places (ruling K)".

## After the review (fix-cli, the lead's ruling K)

- **sched#4** `ScriptedProvider.recallTagged: boolean` (always present): any line tagged `"agent":
  "recall"`. engine.ts `scriptRecallDefault(override)` → 'lexical' when the providerOverride's provider says
  `recallTagged: false`; `recallDefaultOf(seam, override)`: EngineSeams.recall ('config': nothing) ›
  RP_CORE_RECALL (lexical|off) › the script › none (auto). It replaces only the default: a mode in the
  session's config or `/memory mode` wins (demo-m5c's chat4 has `/memory mode auto` from chat2 and keeps its
  reuse). Lexical, not off: the M5a/M5b transcripts were made under the preload's lexical (`/trace` says
  `recall: lexical (…)`). Only the providerOverride is read (in the CLI a script is always the override);
  RP_CORE_RECALL=auto is no override (D-207) and does not undo the rule.
- **sched#8** `ScriptQueue.take` returns `{call, at}` (its place among the script's calls); a hash mismatch
  says `script call <at+1>` and, when that differs from the request's arrival number, `(taken by request
  <n>, the <agent>'s)`. Untagged scripts read exactly as before. Tool ids still use the request number.
- **sched#9** A header line after the first names its own keys and the combined form: `a {"local": ...}
  line must be the first line of the file (caps and local go together there, in one object: {"caps":
  {...}, "local": true})` (`{"caps": ...}` / `{"caps": ..., "local": ...}` likewise; the old caps text is a
  prefix of the new one, so test/adapter-m3's assertion holds).
- **sched#2** see m5c-contract-cli.md (provider.ts replayConnection: `localOrigin` from the recording).
- Tests: `test/sched-m5c/scripted.test.ts` (+5: recallTagged, the engine default and its order, the two
  mismatch cases, the header words), `test/cli/replay-m5c.test.ts` (2), `test/cli/script-recall-m5c.test.ts`
  (2), and the demo tests with RP_CORE_RECALL removed. Not run (not my dirs): test/infra/scripted.test.ts and
  test/adapter-m3/scripted.test.ts (they read the mismatch message by `toContain` of the hashes and the
  caps-line text as a prefix; both should hold).
