# M1b contract notes — prompt-m1b

1. **Two M1a tests now fail by design** — `test/prompt-small/shape.test.ts`:
   "post-processing other than none passes through with post_processing_m1b" and
   "post-processing notice on continue too". They pin the M1a stub notice `post_processing_m1b`,
   which M1b removes (post-processing is applied now). They should be deleted; the replacement
   coverage is `test/prompt-m1b/postprocess.test.ts` and `test/prompt-m1b/shape.test.ts`. Not
   edited here (not my area).
2. **`ShapeInput.names?: { char: string; user: string }`** (optional, additive). ST's `single` mode
   prefixes "Char: " / "User: " to the dialogue; without names it is joined unprefixed. Proposed
   wiring in `engine/turn.ts` `shapeFor`: `names: { char: character.name, user: persona?.name || 'User' }`.
3. **Merged messages carry joined sources** (`main+persona`, `author_note+history`,
   `post_history+continue_cue`). `traceForSent` rows therefore name every block that went into a
   message. Anything that looks messages up by `src` after `shape` must expect this (with native
   caps and `postProcessing: 'none'` nothing is renamed, so current engine tests are unaffected).
4. **Engine wiring left to the engine owner:** `assemble({ tokenFactor: emaFactor(samples) })` with
   samples `{estimated: trace.tokens.estimated, reported: gen.usage.inputTotal}` from path answers
   of the same model (D-50); `stripToolCallLeaks` in turn step 9.
5. **For adapters:** after `shape` with `midSystem: 'as-user'`, system messages exist only in the
   leading run, and that run may hold `inline` system messages (e.g. `new_chat`) after the `head`
   ones; an API that takes a single system message must join them. In `single` mode a re-roled head
   message loses `placement: 'head'`. The prefill (reply/swipe, continue prefill mode) is not in
   `messages`, so strict-alternation handling of "assistant message + prefill" stays with the adapter.
6. **New exports** (additive): shape.ts `postProcess`, `applyCapsRules`, `midSystemAsUser`,
   `leadingSystemRun`, `isFixedMessage`, `SYSTEM_NOTE_PREFIX`, `POST_PROCESSING_PLACEHOLDER(_SRC)`;
   leaks.ts `findToolCallLeaks`, `LeakSpan`, `LeakFamily`.
7. **Notice codes:** removed `post_processing_m1b`; added `post_processing_unknown` (warn),
   `post_processing_partial` (info), `post_processing_placeholder` (info).
