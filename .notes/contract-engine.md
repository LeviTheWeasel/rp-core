# Contract notes — engine agent (M1a)

Files: src/engine/{engine, session, admit, turn, narrate, route, commit, recover, checkpoint, bus,
hooks, context}.ts; tests in test/engine/. No contract file was edited; `engine.ts` keeps
`Engine.open(opts: EngineOptions)` and adds the `EngineTuning` export.

## Gaps in the contracts (worked around)

1. **EngineOptions has no timeouts or timers.** §8.8 timeouts (600 s / 120 s first byte, 120 s idle)
   cannot be tested without them. Workaround: `Engine.open` also reads `timeouts?: {firstByteMs?,
   idleMs?}` and `timers?: DelayTimers` from the same object (`EngineOptions & EngineTuning`, exported
   from engine.ts). Proposal: add both to `EngineOptions`. `hooks` (§12.1) is also absent; `HostHooks`
   lives in hooks.ts and the engine passes `undefined` until M9.
2. **The session lock must not use the injected clock.** The engine passes no `clock` to
   `openSessionLog`/`createSessionLog`: with `fakeClock` (1 s per call) a lock's `renewed` looks older
   than the 30 s TTL after ~30 clock reads, and a second open would steal a live lock. Journal
   timestamps (`ts`, `now`, `created`) still come from the injected clock. Suggest LogOptions document
   that its clock is wall time for lock staleness only.
3. **TurnEntry.parent is required non-empty**, but a continue of a root greeting has no parent.
   The engine writes the target id itself as `parent` for that case (recovery of a continue never
   reads `parent`). Alternative: make `parent` nullable for continue.
4. **PrepEntry carries no model ref.** A recovered answer gets `gen = {kind:'model', finish:'interrupted',
   prefill?}` only — connection/model are unknown. Proposal: `prep.model?: {connection, model}` (or a
   narrator row in `trace.agents`).
5. **Fallback on continue with different `caps.prefill`.** `prep.cont` records the primary's join mode;
   the live commit uses the fallback's (re-shaped) mode, but a crash during the fallback call is
   recovered with the primary's mode. Rare; a second `prep` or a `cont` per attempt would fix it.
6. **events.ts does not export the body type.** turn.ts derives
   `EventBody = DistributiveOmit<Event, 'sessionId' | 'ts'>`; exporting it would help clients too.
7. **`gate_unsupported` is unreachable in M1a** (RunTurnOptions has no `inspect`).

## Decisions the contract left open

- **Retry rule (§6.6).** Retryable iff no output yet (`!afterOutput`, nothing streamed), not stopped,
  the error carries an HTTP status, and (status ∈ RETRYABLE_STATUSES or code ∈ {rate_limited,
  overloaded, timeout}). Errors without a status — our own first-byte/idle timeouts, `unreachable`,
  `fetch failed` — are never retried or sent to the fallback (the request may have been billed).
  Delay = min(retryAfterSec·1000 or 1000 ms default, retryMaxDelayMs ?? 8000) + jitter ≤ min(250 ms,
  delay/4) from the injected random. One `retry` event with `attempt: 1`. The fallback gets the same
  conditions after the retry also failed; a `notice{code:'fallback'}` announces it. All attempts share
  callKey `<turnId>:narrator:0`; each attempt is a row in `trace.calls`. `gen.route` is always written
  (`[{model:'conn:model', status:'ok'}]` for a plain turn).
- **Fallback resolution.** `opts.fallback` that names an unknown connection → Refusal `no_connection`;
  malformed → `invalid_params`. `binding.fallback` with an unknown connection is not a refusal: a
  once-per-session `notice{fallback_unavailable}`. Same conn:model as the primary → no fallback.
  Under `providerOverride` a fallback resolves to the override connection with the fallback's model.
- **Refusal order.** busy → held → expectedVersion type (`invalid_params`) → stale → kind value
  (`invalid_params`) → kind preconditions → guidance/onError/emptyReply/fallback params → connection →
  preset. Blank guidance counts as none (Bunraku); length counted in code points (as assemble clips).
  A reply to a hidden user head is admitted (assemble includes `upTo` even when hidden).
- **Verbs.** send/submit refuse `held_pending`; edit/hide/select don't. fork and configure have no
  expectedVersion but refuse `session_busy` while a turn runs. configure validates the merged config
  with `checkHeader` → `invalid_params`. createSession throws `Refusal('invalid_params')` for a header
  the reader would reject. select onto the current head writes nothing. A user edit keeps non-text
  blocks and replaces all text blocks by one. submit checks busy/held/version, connection and preset
  before writing the user line, so a refusal writes nothing.
- **Greetings.** Blank greetings are skipped; `greetingIndex` counts the stored greeting roots.
- **gen.preset.name** = `config.preset` (`'builtin'` or the library id: resolvable, while a preset's
  own name may be ''); hash = `trace.presetHash`. `gen.ms` = turn start → commit.
- **Failure categories/codes beyond D-51:** `request/assemble_failed`, `request/shape_failed`,
  `protocol/nothing_to_add`, `content/content_filter|refusal` (empty answer with that finish),
  `conflict/dropped|discarded` (unconditional-commit rule ending a live turn — unreachable in M1a),
  `internal/internal_error`, `internal/commit_deferred` (D-38: the commit write failed; no `end` is
  written, the checkpoint is recovered at the next open).
- **Empty answers.** Whitespace-only text counts as none. `caps.reasoning.answerInReasoning` turns a
  reasoning-only answer into the text (§6.6 exception). A continue's streamed reasoning is not stored
  (the edit keeps the target's non-text blocks + one text block, as the task specified).
- **onError 'keep'** needs answer text: output that was only reasoning (or a continue echo) is dropped
  with `end{failed}`. Event order: `changed`, then `failed` (no `done`).
- **Events.** A turn's stream also carries `usage`, `notice`, `retry`, `changed` (they have no turnId
  or only sometimes). Commit `changed.version` is the committed line's seq; a tail commit adds
  `changed{head}`. Assemble/shape notices are deduped per open session by code (D-28 "once per
  session"; a reopen starts fresh). `openEvents()` (recovered + torn/bad-line notices +
  committed_as_tail) are also published to `engine.events()` subscribers that exist at open time.
  `engine.events()` buffers without bound for each subscriber until it is read or broken out of.
- **Stop** reasons: `session.stop` → `user_stop`; `session.close()` / `engine.close()` → `shutdown`;
  both keep streamed text as finish `'stopped'`. Stop while queued on the semaphore or waiting for the
  retry → `end{stopped-empty}`.
- **Checkpoints** are timer-driven (chars threshold or `ms` after the first pending delta; datasync
  every `datasyncMs` only when chk lines were written since the last one); a final `chk` is flushed
  before every commit/end; all timers cleared when the turn ends. chk write errors do not fail a live
  turn (the commit reports real trouble).
- **Ids.** Message and turn ids are re-drawn on collision within a session (storage note 5);
  session ids on `session already exists`.
- **engine.session(id)** for an id already open in the same engine → `session_locked` without touching
  the disk. `SessionCorruptError` (unreadable header) propagates as is (not a Refusal).

## For other agents

- CLI/one-shot: `TurnHandle.events` is single-consumer (a second iteration throws); breaking out
  discards the rest of that stream but the turn continues. `close()` keeps partial text.
- events.ts still lacks the RoleCall port header noted by the infra agent (not mine to edit).
