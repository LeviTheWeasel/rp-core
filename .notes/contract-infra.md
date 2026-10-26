# Contract notes — infra agent (M1a)

1. **events.ts header.** `applyDelta` is adapted from RoleCall `stream-delta.ts`, so by §2 the file
   needs the port header (`// Ported from RoleCall:apps/rc/src/lib/ai/streaming/stream-delta.ts@fb8dc623e…`,
   original authors per D-34). I own only the body and did not touch the header. Provenance row is in
   provenance-infra.md.
2. **applyDelta gap error.** The contract says a gap "is an error"; with no exportable error class in
   events.ts it throws `RangeError` (message contains "gap"). A malformed offset (negative,
   non-integer) also throws `RangeError`. Overlap = the delta overwrites `[offset, offset+len)` and text
   past it is kept, so re-delivering an old frame never truncates.
3. **Scripted provider behaviour the contract leaves open (decided here):**
   - `stream()` records the request and consumes the call synchronously at call time, not on first
     iteration (`requests` / `remaining()` are correct right after the engine asks).
   - Tool steps: `i` = 0, 1, … per call (openai-chat style), independent of text/reasoning `i:0`;
     default id `call_<request#>_<i>`; `tool_args.d = JSON.stringify(args)`; a missing `args` in a
     script is normalised to `{}` by `parseScript`.
   - `release(name)` is a counting gate: each release lets exactly one pause through (oldest waiter,
     or banked for the next pause). An aborted pause leaves the queue, so it never swallows a release.
   - If the signal aborts at any point before the iterator reports done — including after the last
     event — the next pull throws `signal.reason`.
   - requestHash in a script must be 16 lowercase hex chars (else parse error). A mismatch yields
     `bad_request` (category request, no status) whose message has expected/actual hashes and a
     prompt-free summary (message count + roles, tools, prefill length, maxTokens, samplers).
   - New export `categoryOf(code)` (the D-51 code→category table, a `Record` so a new code fails the
     typecheck). Other adapters may want to share it; it could move to providers/types.ts.
   - `SCRIPT_CAPS.tools` is `'none'` though `{tool}` steps exist; a test that needs tool rounds must
     pass caps with `tools:'native'`.
4. **Coalescer.** Several batches may be open at once (one per (session, turn, type)), flushed in the
   order they were opened; the single timer is a throttle that flushes all of them. A frame keeps the
   first delta's `ts`/`offset`. Thresholds count UTF-16 code units (`string.length`), and a single
   oversized delta is never split. After `close()` events pass straight through.
5. **Scheduler.** Capacity must be an integer ≥ 1 (RangeError otherwise). Lowering capacity below the
   places in use lets holders drain before any new grant. An abort after the grant does nothing (the
   holder must still release). Preemption / local-origin background rules: M5.
6. **abort.ts.** Exported extras: `DelayTimers` type and `realTimers`. `childController` passes the
   parent's reason object through unchanged (a foreign reason stays foreign → `reasonOf` = null), and
   removes its parent listener when the child aborts on its own; a child that finishes without
   aborting keeps its listener until the parent is collected (no dispose in the contract).
