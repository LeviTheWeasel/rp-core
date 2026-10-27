# M3 contract notes — tools-parse (args, prompted, leaks recovery, run, handles)

No signature changed. Additions and readings the loop / integrate agents need:

1. **SAFE_NAME is private in `src/providers/wire.ts`.** `src/tools/run.ts` keeps its own copy of
   `/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/`. Suggest wire.ts export `SAFE_NAME` and `SAFE_ID` and run.ts
   import it (integrate; not my file).

2. **The prompted stripper (`createPromptedStripper`).** One stripper per round. Besides partial
   tags it holds back trailing whitespace (a seam may still change it), a line that may open a fence
   around a coming block, and a finished block until what follows it is known. So: call `end()` at
   the end of every round, and only then decide the D-55 separator for the next round. The round's
   visible text = every `push` result + `end()` = `stripPromptedCalls(raw round text)`, for any
   chunking (property-tested). Native rounds use the same object (Qwen-style leaks).

3. **New `cutAtPromptedStop(text)` (prompted.ts).** A server that ignores the `<tool_result` stop
   lets the model write fake results; the stripper never shows them and `parsePromptedCalls` reads
   no call after them, but the raw round text still holds them. Suggest the loop's wire append
   (assistant `{text: raw round text}`, B7) use `cutAtPromptedStop(raw)`.

4. **`parsePromptedCalls` blocks.** A container (`<tool_calls>`, an array / NDJSON body,
   `{"tool_calls": […]}`) gives one block per call, all with the container's span; the first and last
   block of a run of blocks with only whitespace between them take the fence around the run. A block
   with `error` still becomes a call (B7): its `error` text is model-facing English and is meant to
   be the call's result as is; `name: null` → 'invalid_tool'. `stripPromptedCalls` removes a bit
   more than the union of block spans: stray `</tool_call>` closers, everything from a hallucinated
   `<tool_result` on, and the whitespace between blocks of one run.

5. **`renderCoreBlock([], …)` returns ''** (assemble calls it only with tools). Native: the protocol
   only; prompted: protocol + how to call + the catalog in the order given (the request sorts).

6. **`parseToolArgs` with a plain object** skips the text steps (1–5) and is still coerced and
   validated (steps 6–8). Any other non-string, non-null input is an error. `repaired` vocabulary:
   'empty' (whitespace or the text "null"), 'template_markers', 'python_call', 'missing_braces',
   'jsonrepair', 'array_root', 'coerce:<path>' (`limit`, `ids[0]`, `a.b`). Also exported:
   `looseJson(text)` (steps 2–5, no schema) and `pythonCall(text)`; jsonrepair is imported only in
   args.ts.

7. **`recoverLeaks`.** With `nativeCalls > 0` it recovers nothing and returns the text unchanged
   (the markup echoes calls the server made). A several-call span is taken whole or not at all. A
   recovered span takes a fence that wraps only it; recovered DSML takes DeepSeek's end-of-sentence
   token with it. Salvaged JSON is deduped by canonical arguments (RoleCall); other families are not
   (runTools runs identical calls of a round once anyway). The arguments stay raw text.

8. **`runTools` details.** A call refused up front (unknown tool, bad arguments) takes 0 ms and its
   error text counts as a distinct result for the room shares; identical calls share one run and
   one share. 'cancelled' goes to runs still unsettled when the signal aborts (a run that settled
   before Stop keeps its result); an already-aborted signal runs nothing; the round never waits for
   a tool that ignores its signal. An unknown tool's arguments are read without a schema so its
   `echoArgs`/`parsed` show them ('{}' when unreadable). `echoArgs` is `canonicalJson(parsed)` (keys
   sorted at every level): deterministic, and the same text the duplicate check and the loop guard
   key on. `summary` for non-tool outcomes:
   'unknown tool', 'bad arguments', 'failed', 'cancelled'. A share smaller than the cut mark cuts
   without the mark (roomChars 0 → empty texts: the loop ends the loop before that, B3).

9. **Exported helpers** of prompted.ts used by leaks.ts: `readCallBody`, `callShape`, `NAME_KEYS`,
   `ARG_KEYS`, `BodyCall`, `widenOverFence`, `joinPieces`. M4's `<plan>` span search could reuse the
   scanner later; it is not exported generically yet.
