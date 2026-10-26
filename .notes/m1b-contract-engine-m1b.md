# M1b contract notes — engine-m1b

No contract file was changed. Notes for the orchestrator and the neighbouring agents:

1. **One `usage` event per call**, emitted when the call ends, carrying the merged usage of every
   `usage` StreamEv of that call (previously one event per StreamEv). Needed so the price-table
   cost (§11) is never computed from half a usage; the event shape is unchanged.
   `CallInput.onUsage` (engine-internal) became optional and unused by turn.ts.
2. **`Route.caps`** (engine-internal, admit.ts): resolved once at admission as
   `conn.capsFor?.(model) ?? conn.caps`. A `capsFor` that throws refuses the turn with
   `Refusal('no_connection')` before anything is written.
3. **Auth failures are never retried** (`route.ts isRetryable`: category 'auth' → false), so never
   sent to the fallback either. `key_unavailable` is resolved per call in narrate.ts, before the
   origin semaphore is taken; a non-ProviderError rejection becomes `key_unavailable` with a fixed
   message (the thrown text is never shown).
4. **Recovery strips leaks too** (recover.ts): the checkpointed text of an interrupted answer goes
   through `stripToolCallLeaks` before it commits, with one `notice{tool_markup_stripped}` in
   `openEvents()`; notices told at open count as told for that open session.
5. **EMA bias with a prefill** (prompt owner): `traceForSent` estimates only `messages`, while a
   provider's `inputTotal` also counts the prefill sent as the last assistant message. A preset with
   a long prefill nudges the factor up slightly. Harmless (errs on the safe side); a fix would add
   the prefill to `trace.tokens.estimated`.
6. `ShapeInput.names` is wired (`{char: card name, user: persona name || 'User'}`), as proposed in
   m1b-contract-prompt-m1b.md item 2.
