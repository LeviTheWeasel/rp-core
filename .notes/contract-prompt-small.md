# Contract notes — prompt-small (depth, tokens, budget, shape)

1. **trimHistory `keepFrom` with `protectedHead`.** The contract does not say what `keepFrom` means
   when head messages are protected. Implemented: kept = `history[0, protectedHead)` ∪
   `history[keepFrom, n)`; dropped = `history[protectedHead, keepFrom)`; when nothing is dropped
   `keepFrom === protectedHead` (not 0). With `protectedHead` 0 (default) `history.slice(keepFrom)`
   is exactly what to send. Callers using `protectedHead` must keep the head separately. The grid is
   anchored at index `protectedHead` (the oldest droppable message). The one off-grid cut is the
   start of the protected tail (used only when no grid point fits). `budget` is the history budget
   (window − reserve − non-history parts); `fits:false` also when budget < 0 with nothing protected.
   trimHistory knows nothing about tool pairs: assemble should pass a tool round (call + results)
   as ONE entry so a pair is never split (§11).

2. **shape continue target.** The contract says the last message is the target, but §10.2 puts a
   `post_history` system block (and depth-0 inserts) after `{{history}}`, so on continue the target
   is often NOT last. shape therefore looks for the last assistant message with src `'history'` or
   `'history:…'`, falling back to the last assistant message of any src. Assemble should mark history
   messages with src `'history'` (or `'history:<msgId>'`) so an assistant-role preset block after the
   history cannot be taken for the target. Messages after the target stay in place: prefill mode
   removes the target (the adapter sends the prefill last, as ST's continue-prefill does); cue mode
   appends the cue at the very end. No assistant message at all → throws (caller bug).

3. **Prefill text on continue** is `base.trimEnd()` (Bunraku `continuationPrefill`; providers refuse
   a final assistant turn ending in whitespace). `continueBase` keeps the untrimmed text;
   `continuationResult` strips a re-sent trailing whitespace so it is not doubled. A preset prefill
   passed on continue is ignored silently. An empty base on prefill mode sets no `prefill` field.

4. **continuationResult details.** Whitespace-only additions count as nothing new (`addition: ''`,
   `full: base`) → the engine's `failed{nothing_to_add}`. Cue mode trims leading whitespace of the
   streamed text and the trailing whitespace of the base, joining with exactly `\n\n` (equals
   `base + '\n\n' + addition` for clean inputs); an empty base gives `full = addition`.

5. **Notices.** `prefill_unsupported` and `post_processing_m1b` are level `'warn'`. Empty-string
   prefill on reply/swipe is treated as no prefill (no notice).

6. **injectAtDepth** skips inserts whose text is blank (ST drops empty injections; providers reject
   empty messages). Depths past the chat are ordered deeper-first before the first message (ST's
   reversed-splice order), then by order/rank. Extra exports: `SOURCE_RANK`, `DEFAULT_INSERT_ORDER`,
   `insertSrc()`, `isInsertSrc()`.

7. **tokens.** CJK is estimated at chars/3 like Latin, which under-counts badly (~1 token/char);
   the §11 M1 formula has no class for it. Worth a CJK divisor (≈1) when the EMA/tokenizer lands.
   Tool blocks count id + name + args/text. Extra exports: `estimateBlock`, `estimateMessage`,
   constants `CHARS_PER_TOKEN`, `CYRILLIC_CHARS_PER_TOKEN`, `MESSAGE_OVERHEAD_TOKENS`.
