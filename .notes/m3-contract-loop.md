# M3 contract notes — loop (narrate, turn, request, ema, commit, admit, session preview)

Files: src/engine/{narrate,turn,request,ema,commit,admit}.ts, src/engine/session.ts (preview only),
test/engine-m3/ (66 tests). No exported signature of the contract changed; additions below.

## Edits outside my list (the task's test seam), please keep

1. **`EngineSeams.toolSets` (src/engine/engine.ts) and `EngineCtx.toolSets` (src/engine/context.ts):**
   the test seam the task asked for ("RequestInput and the engine's EngineOptions or the rig"). It
   lives on EngineSeams (beside `counter`), not on the EngineOptions contract; hosts never set it.
   request.ts `RequestInput.toolSets?: ToolSets` (`{history(): Tool[]; lore(): Tool[]}`, default
   `BUILTIN_TOOL_SETS` = HISTORY_TOOLS / LORE_TOOLS). The selection rules stay the same; only what a
   set holds changes. turn.ts and session.ts preview pass it through.

## Additions to my own contract types

2. `TurnTools.count?(text)`: the request's token counter. The room is spent per round by what the
   round appends to the wire, measured as assemble measures the prompt (counter × tokenFactor + 4
   per message, ids and names included). C6's 2.5 chars/token conversion is used only for the caps
   (roomChars → runTools' share and pageChars). With chars/2.5 for the spending too, one 1 500-char
   English result emptied a 734-token room (the CLI agent's m3-flows tests ended 'room').
3. `BuiltRequest.echo?: true`: the history carries this route's raw reasoning (D-94). A fallback is
   then rebuilt instead of reshaped (§8.6: reasoning never goes to another model); same when
   `BuiltRequest.reasoning` is set (the thinking-off plan was decided for the primary model).
4. `AdmittedTurn.maxRounds` (clamped 1..8) and `roundsClamped?` (admit.ts `clampRounds`). The turn says
   `tool_rounds_clamped` once per session, only on a turn that offers tools.
5. New exports: narrate.ts `roundFields`, `firstRoundLast`, `promptedStops`, `sumUsage`, `roomChars`,
   `finalCueMessage`, `FINAL_CUE_SRC` ('core:final_cue'), `ROUND_SRC` ('core:round'), `RESULTS_SRC`
   ('core:tool_results'); request.ts `ToolSets`, `BUILTIN_TOOL_SETS`, `unfiredLore`, `echoComplete`;
   commit.ts `continuedBlocks`; admit.ts `clampRounds`.

## Decisions taken where the note is silent (for rev 13)

6. **`trace.rounds.ended` of a forced final round** is the reason it was forced ('max_rounds',
   'ceiling', 'guard', 'room'), also when the model then answered in prose; 'answer' only when a
   round that could still call tools answered without calls. Order when several hold: max_rounds,
   ceiling, guard, room.
7. **Pass B is dropped (no tools, pass A is the request)** when it fails (the core block does not
   fit) or its toolRoom < MIN_ROOM_TOKENS: round 0 would already be the final one, so tools would
   only cost the core block. (Round 0 can still be final through the ceiling when M4/M5 calls come
   before the narrator; then it gets toolChoice 'none' and no cue.)
8. **D-94 check over pass B's `kept`** (what the request carries), not the whole path: an old answer
   of another model that the history trimmed away does not turn thinking off. Assistant messages
   without a generation are exempt like greetings. Thinking off → pass B is re-assembled without
   `echoReasoning` (the history goes text-only; nothing is echoed with thinking off). The notice says
   that answers written with thinking off carry no reasoning either, so it repeats while they are in
   the context (inherent in D-94; worth a line in the docs).
9. **The reasoning echo inside the loop** (B8 "only when the echo is on"): the round's raw reasoning
   rides its wire assistant message when `caps.reasoning.echo !== 'never'` and the call is not
   thinking-off; the adapter decides what to send ('all-with-tools' → reasoning_content; openai-chat
   ignores reasoning blocks otherwise). Replay payloads always ride.
10. **Prompted rounds** also try leak recovery (other dialects: DSML, `<function=…>`, JSON) when no
    `<tool_call>` block parsed (§8.3 "любой диалект").
11. **Native wire text** = the round's visible text without the D-55 separator; after leak recovery,
    `stripPromptedCalls(recovered.text)`. Prompted wire text = `cutAtPromptedStop(raw)` (tools-parse
    note 3).
12. **Known limit:** JSON-in-prose salvaged in a native round (recoverLeaks' JSON family) streamed
    before it was recognised; the text block keeps it (B6: text === chk === events), and step 9's
    stripToolCallLeaks does not cut bare JSON. Markup families are cut at step 9 as before.
13. **gen.usage** = sumUsage over the turn's calls that reported usage (retries included); `cost` only
    when each of those has one. One call → a copy of its own usage (M2's gen.usage exactly).
14. **FINISH_GRACE_MS runs beside the idle limit after a finish:** the grace ends the call quietly;
    an idle limit set shorter than the grace (tests: 200 ms) still makes the stall a tail failure,
    so the M1b tests "a stall after finish_reason … told as a tail failure" keep passing. With the
    defaults (idle 120 s) the grace always wins, which closes rev 11 note 37's first item.
15. **A fallback whose own request cannot be built** (D-90 rebuild fails, e.g. its window is too
    small): the primary's failure stands; gen.route gets `{fallback, status:'error', code}`.
16. **hookTransformReply (M9) on a multi-round answer:** unchanged text keeps the blocks; a rewritten
    one becomes the tool blocks, then one text block.
17. **Continue on a message with tool blocks (B16):** the last text block becomes
    `full.slice(len(earlier text blocks))`; when `full` no longer starts with the earlier text blocks
    (cue mode trimmed into them) the M1 layout is used. Messages without tool blocks: M1 layout.
18. **`unfiredLore`** counts budget-cut entries as unfired (they did not fire); `enabled: false`
    entries never count; the sources are `loreSources(cast, lorebooks)` (shadowing applied), the same
    list ToolCtx.lore carries.
19. Tool events: 'start' args = the raw arguments when they are a JSON object as sent; 'done' args =
    the parsed object. Names are 'invalid_tool' for a non-SAFE_NAME name. Final-round calls get no
    events (they are not dispatched), only trace rows and the notice.

## For other agents / integrate

20. **prompt (assemble/lore.ts `loreSources`): the notes book can be shadowed by name.** It is a
    LoreSource named `NOTES_BOOK_NAME` ('Заметки'): a session book or a card book with that name
    shadows it (or is shadowed by it) through `shadowedSessionBooks` / `shadowedCastBooks`, so a user
    lorebook called «Заметки» silently hides every note. Suggest: never shadow the '@notes' source and
    never let it shadow another. (request.ts adds the source first, as C5 says.)
21. **prompt (traceForSent / tokens.estimated)** does not count the native tool declarations, while
    the server's reported prompt tokens include them: on native tool turns the EMA sample reads a
    little high (≈ 5 % with four builtin tools on a 6 k prompt). Suggest adding estimateToolSpecs to
    `tokens.estimated` when the request declares native tools (golden/M2 unaffected: no tools there).
22. providers/wire.ts keeps SAFE_ID / SAFE_NAME private; narrate.ts has its own copies (as run.ts).
    Export them from wire.ts and import (tools-parse note 1).
23. CALL_CEILING cannot be reached end to end in M3 (retry + fallback + 9 rounds = 11 calls); the
    ceiling is tested through `narrateRounds` with `callsBefore`. M4/M5 must pass their calls in
    `RoundsInput.callsBefore` (turn.ts passes `trace.calls.length` so far).
24. CLI (`/trace`): with note 6, a loop forced to its final round shows 'ended: room' (etc.) even when
    the model answered; the m3-flows tests pass as written (the room is no longer exhausted there).

## Fast suite at the time of writing

2 failures, neither mine: test/assemble/assemble.test.ts "chat area > only text blocks are rendered
(D-16)" (prompt agent's chat.ts change) and test/lore/engine.test.ts "book match 'stem' is matched as
literal in M2" (text agent's note 1).
