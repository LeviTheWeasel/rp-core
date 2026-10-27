# M3 contract notes — review fixes (merged)

The adversarial review of M3 confirmed 30 findings (scratchpad `m3/review-result.json`, "confirmed").
Four fix agents worked in parallel on disjoint files: `engine` (9 findings), `parse` (3), `search` (10)
and `cli` (8). Then the integrate step resolved what lay between their files and checked the groups'
changes end to end. All 30 findings are fixed; no group declined one. Each group's own notes follow
the integration section, kept as written (headings one level down). Where the integration section
and a group section disagree, the integration section is the later word.

No golden, parity or no-tools expectation was changed by any group or here: without tools every
request, trace and stored block is M2's.

## Integration (`m3-fix-integrate`)

### Changes made here

1. **A cut result always says it was cut (tools/run.ts, new export `NO_ROOM_MARK`).** The engine
   group's room fix charges a round's own message (its text, call echoes, results shell, cue) before
   the results are capped (engine 9). A round whose text alone used the room up then gave runTools a
   room of 0, and capText cut every result to `''` with `cut: true` and no mark: the model got an
   empty tool message and the trace said `ok`. That was the open point both the engine and the search
   group named. Now a cap that cannot hold `cutMark(cap)` gives the fixed
   `[cut: no room was left for this result]` alone (39 characters), for runs and refused calls alike.
   It goes over the cap by at most its own length; narrate.ts charges it to the room like any result,
   `roundMaxTokens` takes what the room lacks from the next round's `max_tokens` (prompt + max_tokens
   stays within the window), and the next round is the final one (roomLeft < MIN_ROOM_TOKENS). A
   result that fits is never replaced. Contract change: run.ts's documented "a cap below the mark's
   length cuts without the mark" is gone. Tests: test/tools-parse/run.test.ts "a share too small for
   the mark gives the no-room mark alone, never an empty or unmarked cut" (replaces "… cuts without it;
   no room leaves nothing", which pinned the old reading) and test/engine-m3/loop.test.ts "a round
   whose own text used up the room: its result says so (never empty), and the next round is the final
   one". Both fail with the change reverted (checked).
2. **`BuiltRequest.reasoning` removed (request.ts) and session.ts preview reads the binding's
   reasoning.** The engine group left the field `@deprecated` and never set, because session.ts:767
   (search group's file) still read `built.reasoning ?? plan.binding.reasoning`. No behaviour change.
   Covered by test/demo-m3/review-fixes.test.ts: `preview --turn` of a DeepSeek tool turn rebuilds the
   wire body that went out, byte for byte (reasoning, echo, placeholders).
3. **Public exports (src/index.ts)**: `ACTIVE_PROBE_TOKENS` and the types `ProbeName`,
   `ProbeObservation`, `ProbeVerdict` join `ACTIVE_PROBE_MAX_CALLS`, `ACTIVE_PROBE_MAX_TOKENS` and
   `runActiveProbes` (cli group's request). `runProbe` stays CLI-internal (src/cli is not exported).
4. **test/tools-parse/adversarial-timing.test.ts**: the 16-character stream bound is now
   `3 × floor + 50 ms` (best of 5, floor best of 5) instead of `floor + 50 ms` (best of 3). In the full
   suite's heap the floor itself swings 30–120 ms between runs (GC), and the old bound failed once in
   `bun test` (99.8 ms against 81.1 ms) while passing standalone. A per-push rescan (0.3 s and more at
   100 kB, what the bound exists to catch) still fails it; the 2 kB pre-checks and the 50 ms parse/strip
   bounds are unchanged.
5. **End-to-end test of the groups' changes together: test/demo-m3/review-fixes.test.ts** (8 tests):
   - the innkeeper demo with a NATIVE scripted model (16k): history tools offered natively, gap note and
     reminder, ONE tool message whose search_history result names Тихон in #5, the answer stored after
     paired blocks, a native 2-round trace (test/demo-m3/innkeeper.test.ts stays the prompted run);
   - two read_history calls in one round at 8 192 and 16 384 (native, innkeeper chat, real tools): both
     results end with `returned`/`next_from`/"You have not read…", neither is cut, each holds ≥ 2 whole
     messages (8k: room 1 536 tokens, results 1 350 + 1 355 chars; 16k: 3 614 + 2 856);
   - a salvaged JSON call over the real openai-chat wire (Bun.serve mock) on both transports: the call
     runs, the stored text and the next request drop the JSON, events keep what streamed,
     tool_markup_stripped is told, round 1's wire is the visible text + tool_calls (native) or the raw
     round + one `<tool_result` user message (prompted); plus a prompted unclosed block whose call is
     complete followed by prose: the call runs and the prose is stored;
   - DeepSeek caps from resolveCaps (api.deepseek.com host row + deepseek-v4 model row) over the real
     wire: greeting + an answer from another connection, then three tool turns bound `reasoning:
     'high'`: no `thinking` field on any of the 6 bodies, tools on every round 0, `tool_choice` never
     sent, every assistant message carries `reasoning_content` (greeting and foreign answer `" "`,
     DeepSeek's own answers their own reasoning), no caps.suggest; preview --turn equals body 4;
   - a note renamed by `/memory edit C2 Uncle` (keyless add, so its key moves to [Uncle]): the
     confirmation names `C2 "Uncle"`, search_lore lists `C2 Uncle (note)`, read_lore reads `С2, L9`
     (one string, Cyrillic С) as C2 plus an unknown L9, `/memory show C2` prints Uncle with keys Uncle.

Final runs after integration: `RP_CORE_SKIP_SLOW=1 bun test` 3 207 pass, 5 skip, 0 fail (3 212 tests,
160 files); `bun test` 3 209 pass, 2 skip (the live Ollama tests), 0 fail, twice; `bunx tsc --noEmit -p .`
clean; test/purity.test.ts green.

### Seams checked, nothing to change

- **Engine room vs runner limit.** narrate.ts passes `roomChars` = what is left after the round's own
  message; runTools shares it before the tools run (refused texts first, then even shares capped by
  maxOutput) and its backstop never exceeds it except by NO_ROOM_MARK (1 above). `ctx.pageChars` =
  min(historyPageChars, room); read_history sizes page + paging lines to `ctx.limit`. The engine's
  "tool room bounds" tests and the search group's room tests pass together.
- **Revised D-94 vs adapter tests.** wire.ts `echoesReasoning`/`echoPlaceholders` drive both the
  adapter and the 400 notice; adapter output byte-identical (test/adapter, test/adapter-m3 green). The
  README DeepSeek bullet (cli) matches `echoRefusedMessage` (engine): `tools = "none"` under
  `[caps."conn:model"]`, on a 400 only.
- **Tool description text (search).** "Nouns, names and adjectives match their other forms" reaches
  only tool-offering requests; no golden/parity/hash or recorded request pins it.
- **HandleTable binding.** request.ts still builds `new HandleTable()`; search_lore and read_lore bind
  `ctx.compendium` themselves (the request's view, folded at upTo), and the REPL numbers the head
  view's notes; for a reply turn these are the same path (e2e test above).
- **README (cli) vs code.** "A result too long for what is left is cut, and says so" now also holds
  when nothing is left (1).

### Reviewer scratch tests (.review/, re-run: 96 pass, 12 fail; every failure explained)

| Test | Why it still fails |
|---|---|
| loop/d94.test.ts test 1, loop/fallback.test.ts test 3 | assert the withdrawn D-94 thinking-off / tools-off plan |
| loop/room.test.ts | asserts added ≤ room with 1 500 chars of prose before the call; fixed instead by roundMaxTokens (round-1 total 1 946 ≤ 2 400, was 2 580) |
| loop/m2usage.test.ts | gen.usage of a retried no-tools turn sums both calls (150 vs M2 100): decisions B13 "gen.usage = sum over the turn's calls"; the loop reviewer recorded it as not an issue; trace and EMA stay M2's |
| verify-parse/salvage.test.ts "native" | pins the old storage of salvaged JSON (finding json-salvage-stays-in-story) |
| parsing-wire/args-adv.test.ts "deeply nested" | refuted finding deep-nesting-stack-overflow |
| parsing-wire/redos.test.ts "prompted", "leaks" | refuted class quadratic-scans-100kb (opener flood, SALVAGE_FENCE on 100 kB blanks) |
| parsing-wire/native-asm.test.ts "mid-surrogate split via escapes" | expects the raw argument string to hold `😀`; it holds the JSON escapes `\ud83d\ude00` the server sent, which parse to `😀`: not a defect (not a finding) |
| verify-cli/probe-verdicts.test.ts, providers-cli/probe-edge.test.ts (thinker) | assert the old 96-token cap / not-ok verdict |
| verify-cli/repl-probe.test.ts | builds its own probe dep (no signal, returns a number); the real wiring is tested in test/cli/review-m3.test.ts |

### Open (not fixed here)

- docs/ARCHITECTURE.md sentences the fixes make wrong (the file is not edited by fix agents):
  §5.8 line 630 (C<n> per turn; REPL numbering separate), §7.1 line 1081 ("Сохраняется всё, что
  стримилось": recovered spans are streamed but not stored), §7.5 step 3 line 2173 (stemmer: function
  words, Latin -e/-y), §8.3 line 2321 (tolerant parser: incomplete — unclosed block with a complete
  call then prose), §8.4 lines 2354–2355 (DeepSeek thinking-off/tools-off and the notice), §9.1 line
  2487 (ToolCtx without limit, and the room shared before the tools run), §11 line 2701 (prompt + max_tokens:
  later tool rounds send the reserve minus what the loop added beyond the room), line 3114
  (§14, DeepSeek after /model), D-58 line 4558 (maxOutput = 2 × page + 1 000), D-59 line 4568 (per-turn
  handles).
- docs/M3-DEMO.md line 120 quotes the old search_history description; line 353 the 96-token cap.
- The parse group's pre-existing, refuted performance shapes and the prose still erased after an
  attribute-form block with no value, a `<tool_calls>` container of `<tool_call>` blocks, and a
  complete value followed by a cut `</tool_cal` (parse section).
- With the four built-in tools at very small windows (2 400 / 4 096, CHARS counter) the C1 band with
  only the lore tools remains (engine section); at a real 8k window it is gone.

<!-- merged from .notes/m3-contract-fix-engine.md -->
## M3 contract notes — fix group `engine` (after the adversarial review)

Files: src/engine/narrate.ts, request.ts, turn.ts; src/providers/wire.ts, openai-chat.ts; tests in
test/engine-m3/{loop,request,turn}.test.ts and test/adapter-m3/wire.test.ts. Findings:
json-salvage-stays-in-story + salvaged-json-kept-in-story (one defect), d94-thinking-off-self-perpetuates,
fallback-skips-d94, loop-echo-ignores-canDisable, d94-notice-when-thinking-already-off,
tool-room-not-enforced, history-tools-chosen-from-pass-a, tool-extra-lost-on-id-rename. All fixed.
Supersedes .notes/m3-contract-loop.md notes 3 (the reasoning half), 8 (the D-94 plan), 9 (the echo
rule), 12 ("Known limit": salvaged JSON is no longer stored) and the C1 reading of the selection.

### Contract changes

1. **RoundsResult.text no longer always equals the concatenation of the text blocks.** A leak that
   recoverLeaks turned into a call (JSON in prose, `<function=…>`, DSML, …) is left out of the round's
   stored text block, exactly as it is left out of the native wire text (`stripPromptedCalls(recovered)`,
   the D-55 separator kept in front; an empty block is dropped). Applies to both transports and to the
   B9 final round (calls found but not run). `text` stays what onText received (events and chk keep
   what streamed, as M2's step 9 already allows for markup). New `RoundsResult.salvaged?: number` counts
   the spans; it is set only when the stored text actually changed (a Qwen `<tool_call>` in a native
   round never reached the visible text, so nothing is counted for it).
2. **turn.ts postProcess** adds `salvaged` to the `tool_markup_stripped` count, and takes the per-block
   path whenever `salvaged > 0`, even without tool blocks (B9 calls on a final round 0 are not stored,
   and the streamed text still holds them). No tools offered ⇒ salvaged is 0 ⇒ M2 path unchanged.
3. **RoundsInput.onNotice(code, message, key?)**: optional once-per-session key (default: the code).
   turn.ts passes `key ?? code` to firstNotice.
4. **D-94 revised (request.ts).** echoComplete and the thinking-off / tools-off plan are gone (with their
   two caps.suggest texts). New export `echoRuleOf(route, bindingReasoning)` → `{connection, model} |
   null`: native tools, caps.reasoning.echo 'all-with-tools', and not (`'none'` && canDisable). Pass B
   gets `echoReasoning` from it; `BuiltRequest.echo` is set iff it is non-null and tools are offered.
   **`BuiltRequest.reasoning` stays in the type, `@deprecated`, never set**: session.ts:767 (preview,
   owned by the search group) still reads `built.reasoning ?? plan.binding.reasoning`; removing the field
   would break that file. turn.ts `Leg.reasoning` is removed; every leg sends the binding's reasoning.
5. **wire.ts** exports `rawReasoningOf(blocks)`, `EchoFields`, `echoesReasoning(req)` (the D-94 echo
   rule: echo 'all-with-tools', thinking on, tool traffic = native tools that go out or a tool_call
   block on the path) and `echoPlaceholders(req)` (assistant messages that get the placeholder).
   openai-chat.ts now calls them; its wire output is byte-identical (adapter tests unchanged, plus a
   test that the helpers predict exactly what the adapter sends).
6. **The 400 notice (D-94 revised).** After a call fails with `error.status === 400` and its request had
   `echoPlaceholders > 0`, narrate.ts says `caps.suggest` (level warn) with
   `echoRefusedMessage('conn:model')`, naming `tools = "none"` under `[caps."conn:model"]`; once per
   session under key `ECHO_REFUSED_KEY` ('caps.suggest:echo_placeholder'), so another caps.suggest of
   the session cannot swallow it. Not for 422 or other statuses (the decisions note says 400).
7. **In-loop echo**: a round's own reasoning rides its wire message unless the call turns thinking off
   (`reasoning 'none' && caps.reasoning.canDisable`) — the adapter's rule.
8. **Fallback (turn.ts fallbackLeg)**: rebuilt when the transport differs (as before) or when the
   primary's request offers tools and `echoRuleOf(primary)` ≠ `echoRuleOf(fallback)` (same connection
   and model, or both null). Replaces `built.echo === true || built.reasoning !== undefined`.
9. **The tool room (C6).** Before the batch runs, the round's own assistant message (visible text, own
   reasoning when echoed, call echoes with the RAW arguments, ids, names, overhead), the results
   message's shell (ids and names, empty texts; prompted: the frame with the cue) and the native cue
   message are charged; `roomChars`/`pageChars` get what is left. The cue is reserved every round
   (every loop that ran tools ends with a final round; with results filling the room the next round
   is forced 'room'). After the run the real totals are charged as before, and the cue too when the
   next round is final (trace.rounds.roomLeft is a little lower than before). run.ts is untouched.
10. **Later rounds' max_tokens.** narrate.ts tracks `added` (unclamped budget tokens the loop appended)
    and sends `roundMaxTokens(maxTokens, added, roomTokens)` = maxTokens − max(0, added − room), ≥ 1.
    Round 0 and tool-less turns send maxTokens exactly as before. Needed because text written BEFORE a
    call can alone exceed the room (the reviewer's rig: 1 500 chars ≈ 575 budget tokens vs a 300-token
    room); it also absorbs a result the counter measures above the 2.5 chars/token cap (CJK).
    Guarantee: prompt_k + max_tokens_k ≤ prompt_0 + room + reserve ≤ window.
11. **C1 amended (request.ts).** When pass B's trace.trimmed is set and the history set was not offered
    (pass A kept everything), the history set joins and pass B runs once more; kept only if it succeeds,
    keeps its tools and its toolRoom ≥ MIN_ROOM_TOKENS (else the first pass B stands). D-96's gap note
    and reminder then appear in that band (tested with the built-in tools, o200k, 16k window).
12. **Replay ids (narrate.ts `rekeyReplay`)**: when idFor renamed a server id, the round's `tool_extra`
    payload is re-keyed by the loop ids (each call takes its server id's entry; keys of no call stay),
    and a `reasoning_details` entry whose `id` equals a renamed server call id follows the rename
    (assumption: OpenRouter ties a Gemini signature to its call that way; not verifiable offline). No
    rename ⇒ the payloads are passed through unchanged.

New exports: narrate.ts `ECHO_REFUSED_KEY`, `echoRefusedMessage`, `roundMaxTokens`, `rekeyReplay`;
request.ts `echoRuleOf`; wire.ts as in 5. Removed: request.ts `echoComplete` (no other user).

### Reviewer scratch tests that now fail by design

- `.review/loop/d94.test.ts` test 1 asserts the withdrawn plan first (`requests[0].reasoning === 'none'`);
  under the revised rule the request sends 'high' throughout (the test's own goal, q3 'high', holds).
- `.review/loop/fallback.test.ts` test 3 asserts the withdrawn plan (`tools off || reasoning 'none'`).
  Replaced by test/engine-m3/turn.test.ts "D-94 revised: a same-transport fallback whose echo rule differs…".
- `.review/loop/room.test.ts` asserts `e1 − e0 ≤ room` with 1 500 chars of prose before the call: the
  prose alone is larger than the room, so no cap on the results can meet it. Fixed instead by 10: its
  own numbers now give prompt + decl + max_tokens = 1 946 ≤ 2 400 (was 2 580).
- `.review/verify-parse/salvage.test.ts` "native" pins the old behaviour (expects the JSON in storage).

### Left open (not mine to change)

- tools/run.ts: a result whose share is shorter than the cut mark becomes '' with `cut: true` and no
  mark. With 9 a round whose own text used the whole room now gets that for its results (before, a round
  always started with ≥ 256 tokens of room). The search group owns run.ts.
- At very small windows with the four built-in tools (2 400 / 4 096, CHARS counter) the wider pass B of
  11 does not fit, so the first pass B (lore tools only) stands and the band remains there; at a real
  8 k window (o200k) the band is gone (verify-loop/band.test.ts: band 6 → 0).
- session.ts:767 can drop `built.reasoning ??` (search group); then BuiltRequest.reasoning can go.

<!-- merged from .notes/m3-contract-fix-parse.md -->
## M3 contract notes — fix group "parse" (review findings redos-python-call-cubic, redos-fence-before-cubic, unclosed-complete-json-then-prose)

Files: `src/tools/args.ts`, `src/tools/prompted.ts`, `src/tools/leaks.ts`; tests in `test/tools-parse/`;
`docs/PARITY-RC.md` TD-2 text. No exported signature changed. No golden, parity or hash expectation
changed. Every parity row still comes out as recorded.

### Contract additions

1. **`pythonCallEnd(text, at, limit = text.length): number`** (args.ts, new export). It returns the
   index just past a whole python call (`fn(…)` or `[fn(…)]`) that starts at `at`, or -1. Parentheses
   inside string literals do not count, and an unclosed string or paren gives -1. It is linear. The
   prompted parser uses it to end an unclosed block after a complete python call.
2. **`balancedEnd(text, i, limit = text.length): number`** moved from leaks.ts to prompted.ts and is
   exported, so leaks.ts and prompted.ts share one copy. Its behaviour is unchanged: it counts only
   the opener's bracket kind and skips strings. leaks.ts imports it, and its `jsonEnd` (the Mistral
   scan, M1b stripping) is untouched.

### Behaviour changes

3. **An unclosed block whose call is complete, followed by prose (finding unclosed-complete-json-then-prose).**
   This applies to a `<tool_call>` or `<tool_calls>` block with no closer, cut by the end of the text,
   the next opener or a `<tool_result`. When its body (after preClean's `json` word and an inner
   fence opener) begins with a complete call value and prose follows, the block ends right after
   the value. A complete value is a JSON value that closes and strictly `JSON.parse`s, or a whole
   python call. A closing inner fence goes with the value. The prose stays in the stripped text: in
   the stream, in chk and in the committed message. The call is read from the value, so the result
   is a real call or that value's own error (for example "has no name"), never ERR_CUT.
   The old reading is kept (the block runs to its old end, ERR_CUT unless the whole body is
   complete) in these cases:
   - the value never closes, or does not strictly parse;
   - only whitespace follows the value;
   - the text after the value starts like more of the call: `{`, `[`, `<` (for example a cut
     `</tool_cal`), or `name(` with no space;
   - the whole body already reads as complete (strict JSON or `pythonCall` on all of it). This
     keeps every earlier success unchanged, for example `f(q="x")\nf(q="y")`.

   While streaming, an unclosed block with no closer stays pending as before. `end()` releases the
   prose, and so does the arrival of the next opener. stream === batch still holds for every
   chunking (property test extended with these shapes plus a 4000-text soup).
   Engine: the committed text now holds that prose. The wire text of the round
   (`cutAtPromptedStop`) was already the raw text, so the model and the user now see the same story.
   `readCallBody` reads the python form once (no behaviour change).
4. **Regexes rewritten with the same matches, now linear** (fuzz-checked against the old patterns:
   400k inputs each, 0 differences):
   - args.ts: `PYTHON_CALL`, which was cubic on whitespace in an unclosed call, is replaced by
     `PYTHON_HEAD` plus a hand tail check;
   - args.ts: `PY_STRING` matchAll, which was quadratic on `"\"\"…` or `'x\'x\'…`, is replaced by the
     `pyStrings` scanner;
   - prompted.ts: `FENCE_BEFORE`, which was cubic, now takes the info string atomically;
   - prompted.ts: `FENCE_AFTER`, which was quadratic, is now written `[ \t]*(?:\n[ \t]*)?`.
5. **Streaming stripper caches**, so a push does not re-read what it has read:
   - the last line's fence test is incremental (`fenceSoFar`, fuzz-checked against
     `FENCE_LINE_SO_FAR`);
   - the fence test of the line before a blank last line is cached;
   - a gap that runs to the end of the text is answered from the trailing-whitespace mark;
   - other gaps are memoised;
   - the value-end decision of a held block is memoised.

   Before these, a 100 kB fence line, or a block followed by 100 kB of blanks, took 0.3–0.9 s at
   16-char pushes (11 s for blanks on two lines). Without the memo, a held block of 100 kB before
   a pending one took 1.6 s.

### Timings (100 kB, best of 3, this machine)

- Every parse, strip, `parseToolArgs`, `pythonCall` and `recoverLeaks` on the findings' shapes:
  under 6 ms; `pythonCall` on adversarial string shapes: under 35 ms.
- 16-char stream: 35–65 ms, against 40 ms for the same stream over plain prose. That floor is JSC
  flattening `raw += delta` before indexing, which is pre-existing and not the parser's cost.
- `test/tools-parse/adversarial-timing.test.ts` checks each shape at 2 kB first and then at 100 kB.
  On a pre-fix reconstruction all six groups fail in 2.8–34 s, without hanging.

### Not fixed (pre-existing, the review's refuted "quadratic-scans-100kb": capped replies cannot reach these sizes)

- The streaming floor itself. The stripper keeps the whole round in one string and indexes it on
  every push.
- A held group of many adjacent openers is re-scanned on every push (`'<tool_call>'.repeat(9090)`
  in 16-char pushes: 17 s). The body of a pending block is re-searched for `<` on every push
  (100 kB: about 100 ms).
- leaks.ts `SALVAGE_FENCE` on an unclosed ```` ``` ```` followed by 100 kB of blanks: 5.7 s. Also
  `missingBraces` plus jsonrepair on `[a[a…`: 0.2 s.
- These still erase the prose that follows, as before:
  - an attribute-form block with no value (`<tool_call name="x">` + prose);
  - a `<tool_calls>` container of `<tool_call>` blocks;
  - a complete value followed by a cut closer `</tool_cal`.

### Reviewer scratch, for the record

`.review/parsing-wire/args-adv.test.ts` "deeply nested: never throws" fails on a stack overflow in
`canonicalJson`. `.review/parsing-wire/native-asm.test.ts` fails on surrogate escapes in native SSE
args. Neither is in this group's findings, and my changes do not touch either code path.

<!-- merged from .notes/m3-contract-fix-search.md -->
## M3 review fixes — group `search` (contract changes and readings)

Findings: runner-cut-drops-paging-lines, d58-two-message-floor, ru-short-names-vs-function-words,
en-final-e-cut-merges, ru-tail-collisions-undocumented, tool-vs-repl-note-handles,
handle-cyrillic-lookalike, read-lore-comma-string, rename-keeps-auto-key, search-cache-dies-every-turn.
All ten are fixed; none was declined. Files: src/tools/{types,run,handles}.ts,
src/tools/builtin/{history,lore}.ts, src/text/normalize.ts, src/engine/session.ts (memoryEdit only),
test/fixtures/ru/normalize-terms.json; tests under test/tools-builtin (new room.test.ts),
test/tools-parse (run, handles), test/text, test/lore-m3, test/memory.
No golden, parity or assemble expectation changed (no tools ⇒ M2 unchanged).

### Contract changes

1. **ToolCtx.limit?: number** (tools/types.ts, additive). Characters this run's result may take:
   its share of the round's room, never more than the tool's own maxOutput. Set by runTools before
   the tool runs; undefined when a tool runs outside runTools (then only maxOutput applies).
2. **runTools shares the room before the tools run** (tools/run.ts). Order: refused calls' texts
   first (each ≤ DEFAULT_TOOL_OUTPUT, the room split evenly over them, whole in practice), then each
   distinct run gets limit = min(maxOutput(ctx), floor(left / runs)). The post-run cut stays as a
   backstop: runs in call order, an even share of what is still left (unused share passed on),
   capped by maxOutput — provably never below the run's limit, so a tool that keeps to its limit is
   never cut. Behaviour change: a refused call no longer takes an even share; it takes its own
   length (test/tools-parse/run.test.ts "room shares" updated: room 3 000, one run + one refused →
   the run may take 3 000 − the refused text). narrate.ts is unchanged (pageChars and roomChars as
   before).
3. **outputRoom(ctx, max)** (history.ts) = min(max, ctx.limit, the old pageChars < 6 000 rule).
   search_history, search_lore and read_lore size their lines to it, so "More matches before #k",
   "N more match" and "Not shown, the result is full: …" always arrive (case (c) of the finding:
   room 6 000–8 000 no longer leaves read_lore at 8 000).
4. **read_history sizes itself to the limit.** body = (ctx.limit ?? maxOutput) − the longest paging
   lines this range can have (numbers no wider than #end / #total); page = min(max(500, pageChars),
   body) (floor 500); a first message longer than the page is cut so that its note also fits the
   body. **maxOutput = 2 × page + PAGE_SLACK_CHARS** (was page + 1 000): D-58's floor needs room for
   two page-sized messages. PAGE_SLACK_CHARS keeps its value (1 000); its doc changed.
5. **D-58 floor of two whole messages** (supersedes m3-contract-builtins.md deviation 2): when the
   first message came whole and the second passes the page but fits the body, it comes too. Never a
   third past the page. 16k window with 4 000-char messages → "returned: #2 to #3"; 12k window with
   3 200-char messages (two would pass the 6 400 room) → one, next_from 3.
6. **HandleTable (D-59 as amended in m3-decisions K)**: `new HandleTable(notes?: CompendiumView)` and
   `bindNotes(view)`. Bound, every note of the view (live and retired, noteRefs order) is `C<n>` =
   its /memory handle, resolvable before any search; a Compendium record that is not a note gets a
   number after the notes; binding the same view again is a no-op, another view replaces every C
   handle (L handles stay). Unbound: first appearance, as before. search_lore and read_lore bind
   ctx.compendium themselves (lore.ts handlesOf), so engine/request.ts need not change; it MAY pass
   `new HandleTable(view.compendium)` (then the tools' bind is a no-op). `L<n>` stays per turn.
   Supersedes m3-contract-builtins.md §11 and decisions D4 for notes.
7. **HandleTable.resolve** reads NFKC first (Ｌ１ → L1), strips the wrap characters, reads a leading
   Cyrillic С/с as C, upper-cases; longer than 32 characters after NFKC is never a handle. 'Л1' does
   not resolve.
8. **read_lore splits string ids** at commas, semicolons (also the CJK 、，；) and whitespace before
   the 20-handle slice: "L1, L2", "L1 L2", ["L1, L2"], "[L1, L2]" read both.
9. **normalizeTerm, Russian function words** (normalize.ts RU_FUNCTION_WORDS, new export
   FUNCTION_WORD_MARK = '\u0001'): над надо под подо вас вам вами нас нам нами тем том тому чем чему
   кем ком кому ним них ней get `word + '\u0001'` as their stem, which no cut can produce, so they
   meet only themselves. Надя/Нади/Надю/Надей/Наде still meet (над), apart from над and надо; same
   for Вася/вас, Тёма/тем, Тома/том/тому. Checked for same-lexeme splits: был and сам are left out
   (была → был, сама → сам); split on purpose and pinned as misses: Тома/Тому (the accusative is
   spelt as the pronoun), том 'volume'/тома, чем/чему (forms of one pronoun). Decisions E is
   additive-extended, not contradicted (≥ 4 letters and ≥ 3 left still hold for every other word).
10. **normalizeTerm, Latin** (supersedes m3-contract-text.md deviation 3): a final -e is cut only
    after s, x, z, ch, sh or i (the -es plurals, -ie → -i); -y → -i and the plural rules stay. Sam ≠
    same, Tim ≠ time, Don ≠ done, Ann ≠ Anne, her ≠ here, not ≠ note, plan ≠ plane (pinned 'apart').
    Every former plural group still meets; plain -e words meet their plurals through the -s cut
    (stone/stones, place/places). Stem changes visible in tests: snake → snake (was snak).
11. **normalize-terms.json gets a 'merges' section** (documented false merges that DO meet, a test
    asserts they still meet so a change shows): homographs, short names vs content words
    (Мила/милый, Костя/кость, Соня/сон, Женя/жена, Коля/кол, Рома/ром, Дарья/дар, Лина/линия,
    Гера/герой), the stem tail cutting into another word (королева/король, голова/голая,
    корова/кора, статуя/статья, соловей/соль, Пётр/Петров, Львов/льва, Андреев/Андрей,
    месть/место, сталь/стал), Mary/Marie. 'misses' adds -мя nouns, ёж/ежа, English verb forms,
    wolf/wolves and the function-word splits above. normalize.ts names them all and the escape
    hatches ('/regex/' keys, quoted phrases).
12. **Tool descriptions** (cached prefix of tool-offering requests only): search_history and
    search_lore now say "Nouns, names and adjectives match their other forms" (was "Words match
    their other forms"). No pinned hash or text in test/ needed a change.
13. **memoryEdit** (engine/session.ts): a rename without keys, when the stored keys are exactly
    [old name] (what a keyless memoryAdd writes), writes keys [new title] in the same edit op. Keys
    the user wrote stay; keys written equal to the title are indistinguishable and move too.
14. **history.ts words cache** is keyed by the message's stored blocks array (the journal entry's
    own, session/tree.ts effectiveMessage), not the MessageView, so it survives every refold. New
    export `messageWords(m)` (the cached words). 10 000 messages: a no-hit search after a refold
    of the same entries 61 ms (was ≈ 1 500 ms, cold every turn).

### For other groups

- **cli** (tool-vs-repl-note-handles, verifier's extra): the `/memory edit|retire|restore`
  confirmation prints only `note C<n> changed: …`; printing the note's title there (src/cli/repl.ts)
  would make a wrong handle visible. Not done here (not my file); tool and REPL C<n> now agree, so
  the confusion the finding names is gone.
- **engine** (optional): request.ts may build `new HandleTable(view.compendium)`; the lore tools
  bind it anyway.
- docs/M3-DEMO.md quotes the old search_history description ("Words match their other forms").

<!-- merged from .notes/m3-contract-fix-cli.md -->
## M3 review fixes — group `cli` (contract changes and readings)

Findings: repl-probe-active-uninterruptible, active-probe-96-token-cap-thinking-models,
probe-500-recorded-as-refusal, repl-probe-write-claims-stored,
readme-active-probe-example-impossible-on-ollama, readme-tool-handles-differ-from-memory-refs,
model-not-found-not-actionable, script-caps-line-values-unchecked. All eight are fixed; none was
declined. Files: src/providers/{probe-active,scripted}.ts, src/cli/{catalog,chat,main,oneshot,render,repl}.ts,
README.md; tests in test/probe-m3/{active,cli,mock}.ts, test/repl/m3-flows.test.ts,
test/cli/m3.test.ts (one line), test/cli/review-m3.test.ts (new). No golden or parity expectation
changed; nothing here touches a request without tools.

### Contract changes

1. **Active probes: a reply cap per call** (probe-active.ts). New `ProbeName` and
   `ACTIVE_PROBE_TOKENS = { stream: 96, stream_usage: 96, tools: 1024, tools_result: 512,
   json_schema: 512 }` (the scratch note's §1.6). `ACTIVE_PROBE_MAX_TOKENS` changes meaning from
   "the cap of every call" (96) to "the largest cap of any call" (1024, derived). Only a model that
   thinks spends the larger room; the ping still asks for 96.
2. **A tri-state verdict.** `ProbeObservation.verdict: 'ok' | 'no' | 'inconclusive'` (new type
   `ProbeVerdict`); `ok` stays, always `verdict === 'ok'`, so `--json` readers of the M3 shape keep
   working. 'no' is evidence (a refusal, a call leaked as text, prose or broken JSON under the
   schema, no tool call in a finished reply, a ping that found the server unusable); 'inconclusive'
   is nothing learned (a timeout, a server error, a server gone after the ping, a reply cut by its
   cap, an empty reply) and never yields a fact. Details of inconclusive observations lose their
   `inconclusive: ` prefix (the verdict says it): `the server did not answer in time`, `the reply
   hit the 512-token cap`. New details: a tools reply cut before any call is `the reply hit the
   1024-token cap before any tool call` (+ ` (it was still thinking)` when only reasoning came),
   verdict inconclusive (was `no tool call (the reply hit the 96-token cap)`, not ok); a JSON reply
   cut before any text is `the reply hit the 512-token cap before any text (it was still thinking)`.
3. **5xx before output is asked once more** (within ACTIVE_PROBE_MAX_CALLS; the repeat counts as a
   call). 500/501 is a refusal only when the repeat got a 5xx too (llama.cpp without --jinja: still
   `tools prompted` with its hint; detail `refused: … (HTTP 500) on both tries`). A repeat that
   answers is used, its detail ending `(second try: the first got HTTP 500)`, `ms` the sum of both.
   A single 5xx with no call left is inconclusive. json_schema follows the same rule (5xx →
   inconclusive unless repeated). 502–504 twice stay inconclusive (never a refusal status).
4. **The caller's abort** is now also rethrown when the provider ended with an error event after the
   abort (before, only a thrown abort was); no observation is made of it.
5. **catalog.ts.** `CatalogArgs.signal?: AbortSignal` reaches fetchCatalog, listModels and
   runActiveProbes; an abort is rethrown (never an "unreachable" result), nothing is stored or
   printed. New `runProbe(a) → { code, results }` (cmdProbe = its code, signature unchanged);
   exported type `ProbeArgs`. The report's verdict column prints `ok` / `not ok` / `inconclusive`,
   at least `not ok` wide, so a report without an inconclusive probe keeps the M3 columns exactly
   (docs/M3-DEMO.md §4 still matches). The tools hint keys on verdict 'no'. New note when the ping
   fails for a model the server does not list: `<model> is not in the server's model list:
   rp-core models <conn> lists what it has`.
6. **ReplDeps.probe** is now `(a: { target, write, io, signal }) => Promise<{ code, written }>`
   (was `Promise<number>` without a signal). chat.ts passes the signal to runProbe and computes
   `written` as "some result was stored". The REPL keeps an AbortController while /probe --active
   runs; Ctrl+C aborts it (checked after the editing and turn cases, before the at-the-prompt logic)
   and prints `(probe stopped; nothing stored)`; the "stored facts apply from the next rp-core chat"
   note only when `written`. The probing line: `probing <conn>:<model>: a few short calls (at most
   6, replies of 96 to 1024 tokens; Ctrl+C stops)…`. The shell `rp-core probe --active` keeps the
   default SIGINT (the process dies; nothing was written yet).
7. **model_not_found hint** (render.ts `modelNotFoundHint(narrator, sessionId?)`, fixed words naming
   the session's narrator binding, never the server's): REPL, after the failed answer, one dim line
   `(the narrator is <conn>:<model>: rp-core models <conn> lists what the server has; /model
   narrator <conn>:<model> switches this chat (config.toml [roles] only sets new sessions))`;
   send (text mode only, not with --json) `rp-core: hint: … /model narrator <conn>:<model> in
   rp-core chat <id> switches the session …`. Neither under --provider (the script is not the
   binding). The binding is the narrator's even when a fallback failed last.
8. **/memory edit|retire|restore confirmations name the title**: `note C1 "Big brother" changed:
   title, text (from the next turn)`, `note C2 "Lamp" retired: …`, `note C2 "Lamp" restored: …`
   (add already did).
9. **Script caps line values** (scripted.ts parseCapsPatch): every patchable field is checked for
   its type, with config.toml's [caps] ranges: contextLength 256–1e8, maxOutput 1–1e8, maxInFlight
   1–64, cacheMinTokens 1–1e6, stopMax 0–1024 (integers); enums for maxTokensField,
   parallelToolCalls, toolIdFormat, midSystem, alternation, prefill, streamUsage, caching, tools;
   booleans; toolChoice an array of auto/none/required; structuredOutput, reasoning and samplers
   objects whose own fields are checked (an unknown nested field is refused; reasoning.offShape is
   free); extraBody an object. Error: `script line 1: caps.<field> must be …, got <json>`.
10. **main.ts** `probe --help` (--active): the per-call caps and "a probe that learned nothing says
    inconclusive".
11. **README**: Active probes example replaced by the real Ollama shape of docs/M3-DEMO.md §4 (3
    calls, stream_options sent, tools refused with the Ollama hint, json_schema enforced) and
    pinned by test/cli/review-m3.test.ts against what `rp-core probe --active` prints for an
    Ollama-shaped mock; costs, verdicts and Ctrl+C rewritten; /trace calls line is `narrator
    <conn>:<model>`; per the amended D-59 a note's `C<n>` in a lookup line is its `/memory` handle
    and `L<n>` numbers lore entries for one answer only; the DeepSeek bullet rewritten to the
    revised D-94 (own reasoning or a one-space placeholder, unverified against the live API, a
    notice naming `tools = "none"` on a 400); a troubleshooting row for model_not_found.

### Readings

- The reviewer's scratch tests `.review/providers-cli/probe-edge.test.ts` ("a transient HTTP 500")
  and `.review/verify-cli/probe-verdicts.test.ts` ("500") answer 500 to EVERY tools call; by the
  lead's rule that is llama.cpp without --jinja and still ends in `tools prompted`. The transient
  case (one 500, then an answer) is test/probe-m3/active.test.ts "server errors are asked again".
  Their thinker tests now fail as they should (tools native, ACTIVE_PROBE_MAX_TOKENS 1024).
- `.review/verify-cli/repl-probe.test.ts` builds its own probe dep (no signal, returns a number), so
  it cannot show the fix; test/cli/review-m3.test.ts drives the real chat wiring (spawned `rp-core
  chat`, SIGINT during /probe --active against a silent server).
- src/index.ts (not this group's) exports ACTIVE_PROBE_MAX_CALLS, ACTIVE_PROBE_MAX_TOKENS and
  runActiveProbes only; ACTIVE_PROBE_TOKENS, ProbeVerdict and runProbe could be added there.

## Final (`m3-fix-final`): the checkers' re-test

Independent checkers re-tested the four groups' fixes and reported 35 problems: residues of fixed
findings, regression tests that did not bite, defects a fix introduced, and doc drift. Every item was
re-verified on the tree first (the checkers' scratch tests under `.review/check-*`, re-run). All are
fixed except the parts listed under "Left open" with the reason. Every new regression test was checked
to fail with its change reverted in a scratch copy of the tree. No golden, parity or no-tools
expectation changed: without tools every request, trace and stored block is M2's (test/golden,
test/parity and test/purity.test.ts green).

### Engine

1. **The stored text no longer glues rounds (stored-rounds-glued; the new problem of
   json-salvage-stays-in-story / salvaged-json-kept-in-story).** D-55's lazy separator is now also
   decided in storage, against the stored text, not the stream. New export narrate.ts
   `storedSeparator(before, body)` = `'\n'` when `before` (the text blocks stored so far, joined) is
   not empty and does not end in whitespace. narrateRounds builds every round's text block as
   `storedSeparator(stored, body) + body` (body: the round's visible text, or with salvage the text
   without the recovered spans). While nothing was left out of the stored text this is exactly the
   stream's separator (M2 path unchanged: one round, nothing stored before). turn.ts step 9's
   per-block path takes the loop's separator off a block (it is there exactly when
   `storedSeparator(original before, block)` says so), strips the body, and puts back the separator
   the kept text needs: a strip that took a block's trailing whitespace (or a whole block) never glues
   two rounds, and nothing kept before means no separator. Pre-existing for markup stripped by step 9
   (`<function=x>…</function>\n` of a tool not offered), extended to JSON by the salvage fix; both
   fixed. Results: `Let me think.\n{json}\n` + `The door is red.` stores and replays
   `Let me think.\nThe door is red.`; `A.` / `\n{json}\n` / `B.` stores `A.\nB.`; a JSON-only round
   stores `The door is red.` with no leading `\n`. RoundsResult.text keeps what streamed.
   Tests: test/engine-m3/loop.test.ts "a salvaged span that took the whitespace with it never glues
   two rounds…" (native, prompted), "the stored text keeps D-55's separator where a removal took the
   whitespace (B6)" (3 tests, two of them through step 9).
2. **Recorded behaviour (B11), not a defect:** a turn whose only visible text was a salvaged call,
   followed by a final round with no text, now fails (`empty_response`, or `reasoning_only` with
   reasoning) instead of committing the call's JSON as the answer: the call is not story (§8.3), and a
   turn without visible text fails as in M2 (B11). Before the salvage fix it committed the JSON.
3. **The D-94 400 notice needs `error.code === 'bad_request'` (echo-400-notice-on-context-overflow).**
   classifyHttpFailure keeps status 400 for `context_length_exceeded`; that is no verdict on the
   placeholder and no longer uses the once-per-session key up. Test: request.test.ts "a 400 that says
   the context is too long is no refusal of the placeholder…" (the real refusal after it is told).
4. **rekeyReplay and a server id two calls of one response share (rekey-duplicate-server-id).** A
   server id some call of the round kept is never renamed in the payloads; a tool_extra entry goes to
   the one call that owns the id (the call that kept it, else the first renamed one), never copied to
   a duplicate. Test: loop.test.ts "rekeyReplay: one response giving two calls the same id…".
5. **The cue charge is tested (room-cue-charge-untested):** loop.test.ts "when the next round is the
   final one, its cue is taken from the room too" (native: roomLeft = room − round − results − cue,
   message by message as spent() counts; prompted: the cue inside the results message; a non-final
   next round charges none).
6. **Results the counter measures denser than 2.5 chars/token (cjk-room-squeezes-reply; part 2 of
   tool-room-not-enforced).** After a batch runs, narrate.ts measures the result texts with the turn's
   counter (`textsCost`, × tokenFactor). When that passes the room left after the round's own message
   by more than max(10 %, 2 tokens per call), the batch runs once more (v1 tools only read) with its
   character room scaled by room/measured, so the tools page themselves again (read_history keeps its
   cursor). roundMaxTokens stays the backstop for what is left. Only with a real counter (o200k): the
   CHARS estimate can never overshoot, so no tool-less or CHARS-counted turn changes. Checker rig: zh
   and Russian name lists now keep max_tokens 2048 (were 539 / 1716). Test: loop.test.ts "results the
   counter measures denser than 2.5 chars/token (CJK) are fitted to the room in tokens…".
7. **C1 at small windows (c1-band-at-2048).** When pass B with the lore set trims history pass A kept
   and the history set plus the lore set does not fit, the history set alone is tried before the
   first pass B stands (with history cut, reading it matters more than unfired lore). o200k, built-in
   tools: the band (trimmed requests with only the lore tools) was there up to a 3 328 window, now up
   to 2 560. Test: request.test.ts "…the history set goes alone (lore gives way)" (3 072 window).
8. **A native round's Qwen-style block left unclosed after a complete call
   (native-unclosed-call-silently-dropped).** roundCalls: when a native round has no native calls and
   leak recovery found none, the prompted parser reads the `<tool_call>` blocks of the raw text (so an
   unclosed block whose call is complete counts, as in a prompted round); a block becomes calls when
   every call in it is readable and names an offered tool (via 'leak'). New `RoundsResult.hidden`:
   `<tool_call>` blocks a native round's stripper kept out of the visible text without running them
   (an echo of a native call, a tool not offered, an unreadable block); turn.ts adds them to the
   tool_markup_stripped count. Tests: loop.test.ts "a Qwen-style <tool_call> left unclosed after a
   complete call, in a native round: it runs…" and "a <tool_call> a native round hides without running
   it … is told by tool_markup_stripped".

### Parse (src/tools/prompted.ts)

9. **valueEnd reads what follows a complete value (parse-residue-raw-markup; the new problem of
   unclosed-complete-json-then-prose).** It now returns the block's end and its call values
   (`Span.values`, read one by one by spanCalls):
   - more values after a comma are more calls of the same block: a JSON value that parses strictly,
     or a python call written tight (`name(`, so `, and (quietly) she left` stays prose):
     `{…}, {…}`, `{…},\n{…}`, `[f(…), g(…)]` give two calls;
   - punctuation the call left behind goes with the block, across blanks and line breaks: `,` `;`
     `:` `}` `]` `)` (an extra brace, the `]` of a list, a trailing comma). A value followed only by
     such residue is read as the call (before the fix that was ERR_CUT; a closed block's jsonrepair
     path reads the same text the same way);
   - the old reading (block to its old end, ERR_CUT unless whole) stays when what follows could
     still be part of the call (`continuesCall`, item 11).
   Tests: prompted.test.ts "punctuation left after the value goes with the block…", "more calls after
   a comma are more calls of the same block…", the "still cut off" list extended; stream-property
   soup extended with these shapes (stream === batch, no leading `,;}])` left in the text).
10. **A python call followed by prose that ends in ')' (parse-python-prose-paren-still-erased).** The
    whole body counts as complete only as strict JSON, or as a python call whose own end
    (pythonCallEnd) is the end of the body. `search_lore(query="x")\nThe end.\n(OOC: …)` now runs
    search_lore {query: x} and keeps the prose. Test: prompted.test.ts "a python call, then prose that
    ends in ')'…".
11. **'[' and '<' prose after a value (parse-bracket-angle-prose-still-erased).** `continuesCall`:
    `{`; `[` only before `{`, `[` or `name(` (blanks allowed); `<` only as `</` or a tool tag's name,
    whole or cut by the end of the body; `name(` tight. `[OOC: thanks]`, `<i>…</i>`, `<br>` after the
    value are prose; `</function>` (a mismatched closer) still reads as more of the call.
    docs/PARITY-RC.md TD-2 updated. Test: prompted.test.ts "prose that opens with "[" or "<" but
    cannot be the call stays".

### Search (tools/builtin, tools/run.ts, text/normalize.ts)

12. **read_history never exceeds ctx.limit (read-history-floor-overruns-limit,
    read-history-floor-breaks-limit; part 1 of tool-room-not-enforced).** body = limit − the longest
    paging lines (no PAGE_FLOOR_CHARS floor); a first message longer than the page keeps
    min(page, body − its note) of its head. When the first message neither fits nor leaves
    READ_MIN_HEAD_CHARS (100, new export) for its head, the result is only the cursor:
    `No room was left in this round to read #<from>.` / `next_from: <from>` / `You have not read
    #<from> to #<end>: never claim to have read them.` (not an error; summary `no room, next #<from>`).
    PAGE_FLOOR_CHARS still floors the page (pageOf) when the limit allows it. Tests:
    test/tools-builtin/room.test.ts "rooms 277 to 1 280 chars, one call and two: never over the
    limit, never cut by the runner, the cursor always there" (innkeeper chat sweep) and "a limit that
    cannot hold a useful head…".
13. **One share per call; water-filled pre-run limits (duplicate-calls-charged-once,
    pre-run-share-not-redistributed).** runTools: a run answering N identical calls takes N shares
    (its result goes on the wire N times) and the backstop charges every copy; pre-run limits are
    water-filled over the runs' own maxOutput (new export `waterFill(room, caps, copies)`): a run
    capped below its share leaves the rest to the others. Backstop cap = min(maxOutput, limit + a
    per-call share of what earlier runs left unused) — never below the limit. Contract change:
    run.test.ts "room shares" no longer pins "a duplicate takes no share of its own" (two copies of a
    duplicated call now fit the room together). Tests: run.test.ts "duplicates: the limit a run learns
    is one share per call…", "pre-run shares are water-filled…". Checker rig dup.test.ts: 2 × 1 541
    = 3 082 ≤ 3 840 (was 7 130).
14. **English -oes plurals (en-final-e-cut-merges).** The final -e is cut after s, x, z, ch, sh, i
    or o: hero/heroes, potato/potatoes, echo/echoes meet; shoe/shoes meet as `sho`; toe (3 letters)
    is untouched. Pinned under 'meet' in normalize-terms.json; the normalize.ts comments say so (and
    the stemLatin comment now reads "if ≥ 4 letters are left": it is one `if`).
15. **read_lore string ids (read-lore-comma-string).** `splitIds`: pieces with no letter or digit go
    (`« L1 »`, `[ L1 ]`, `" L1 "` read L1 cleanly); when a string holds handle-shaped pieces (new
    export handles.ts `handleShaped`), only those count (`L1 (Замок)`, `L1 Замок` read L1; an unknown
    `L9` beside L1 is still told); a string with none stays one id (`"Second ledger": no such
    handle`). Test: lore.test.ts "a handle wrapped with spaces inside, or written with its title…".
16. **Documented false merges (merges-list-misses-frequent-names):** Света/свет, Люда/люди,
    Люба/любой, Люба/любовь pinned under 'merges' and named in normalize.ts with the escape hatches
    (full name, quoted phrase, '/regex/' key).
17. **Comments (docs-d56-toolctx-and-handle-comment):** ToolCtx.handles now says `L<n>` per turn and
    a note's `C<n>` is its /memory handle (D-59 amended); ToolCtx.limit describes the per-call,
    water-filled share.

### CLI and probes

18. **Probe reply caps never pass the model's limits (the new problem of
    active-probe-96-token-cap-thinking-models).** New exports `probeMaxTokens(name, caps)` =
    min(ACTIVE_PROBE_TOKENS[name], caps.maxOutput, caps.contextLength − PROBE_PROMPT_TOKENS (512),
    ≥ 16), and `PROBE_PROMPT_TOKENS`. Every probe call sends it; the "hit the N-token cap" details name
    the cap sent. Test: active.test.ts "a call never asks for more than the caps' maxOutput or the
    window leaves…" (maxOutput 512 and a server that answers 400 above it: tools native, bodies
    [96, 512, 512, 512]).
19. **A probe the run had no call left for says so (the new problem of probe-500-recorded-as-refusal).**
    New export `PROBE_NOT_RUN` = `not run: the run had made its 6 calls (a repeated call counts)`;
    stream_usage, tools, tools_result and json_schema each get an inconclusive observation with that
    detail (ms 0; the report prints no time for it) when skipped for the call limit. A native call
    whose round trip was not run therefore shows `tools_result inconclusive not run…` and writes no
    tools fact. Tests: active.test.ts "a probe the run had no call left for says so…", cli.test.ts "a
    probe the run had no call left for is printed as not run".
20. **Ollama's repeated 500 is not a refusal (ollama-repeated-500-misleading-hint).**
    `ActiveProbeInput.server?: string` (additive; catalog.ts passes the catalog's server kind):
    500/501 on both tries counts as a refusal only when the server is not 'ollama' (Ollama refuses a
    template without tools with HTTP 400). So an Ollama runner that crashes on every tools request
    gives `tools inconclusive … (HTTP 500) on both tries`, no fact and no "template has no tools" hint;
    llama.cpp and unknown servers keep the refusal. Tests: active.test.ts "Ollama: a 500 on both tries
    is a runner that failed…", review-m3.test.ts "probe --active on Ollama: a 500 on both tries…"
    (through main, /api/show listing tools).
21. **The chat's `written` wiring is tested (chat-written-wiring-untested):** review-m3.test.ts
    spawns `rp-core chat` and runs `/probe --active --write` against a server that refuses every chat
    call (nothing stored, nothing claimed) and against a native tool caller (stored, "the stored facts
    apply from the next rp-core chat"). Each fails with chat.ts returning `p.write`, or `false`.
22. **Stop tests that bite (catalog-stop-test-does-not-bite):** cli.test.ts "a stop during the
    catalog requests is rethrown at once…": two connections, the first one's /v1/models hangs, the
    stop comes while it is held; asserts the rejection before PROBE_TIMEOUT_MS / 2, no request to the
    second connection and its key_cmd never run (fails with a fresh signal to fetchCatalog, and with
    the catch's rethrow removed). active.test.ts "the caller's abort is rethrown when the provider
    ends with an error event after it…" (an in-process provider; fails without probe-active.ts's
    rethrow after the stream).
23. **README (probe-cost-claim, readme-rename-key-sentence):** the cost bullet gives the bound (about
    3 300 tokens: every cap plus one repeat of the largest; never more than the model's own output
    limit) and "a few cents up to about 25 cents for a thinking model on a premium API"; the
    /memory edit row says "The note keeps its handle and its `note:…` key when its title changes; a
    note without keys then fires on the new title"; the verdict bullet says an Ollama 500 stays
    inconclusive and names `not run`. Pinned in review-m3.test.ts.
24. **The model_not_found hint names the route that failed
    (not-found-hint-names-primary-after-fallback).** `TurnOutcome` 'failed' gets an optional
    `route?: string` ('conn:model' of the model call whose failure it is: the fallback's when it ran;
    absent when no model call failed). The terminal `failed` event is unchanged (no protocol change).
    render.ts `modelNotFoundHint(narrator, sessionId?, failed?)`: when `failed` names another model
    than the narrator's, the hint is `the fallback <conn:model> is the model the server does not know
    (the narrator <conn:model> failed first): rp-core models <conn> lists what that server has;
    [roles] narrator_fallback in config.toml names the fallback of new sessions`. REPL and send pass
    `outcome.route`. Test: review-m3.test.ts "when the narrator failed over to its fallback and the
    fallback is the unknown model…".
25. **Script caps `samplers.wire` (script-caps-wire-values):** a record-of-strings rule; error
    `caps.samplers.wire must be an object of strings, got …`. Test in review-m3.test.ts.

### Left open (with the reason)

- **C1 band at 2 048–2 560 (o200k, built-in tools):** there even the history set alone leaves less
  than MIN_ROOM_TOKENS of tool room beside the trimmed history, so the first pass B (lore tools only)
  stands, without D-96's gap note. That is the same history an M2 request sends; offering the history
  tools there would mean a tool room below the floor every turn. Recorded, not fixed.
- **Pre-run shares for results whose size is unknown in advance** (pre-run-share-not-redistributed,
  the checker's share.test.ts case): water-filling only uses the runs' maxOutput. A search_history
  that finds nothing (138 chars beside a read_history) cannot be known before it runs, so the
  read_history beside it still pages at its even share (efficiency only, as the finding says; the
  backstop passes the unused room on to a run that ignores its limit).
- **search_history in a share below one hit line** (seen in the checker's tiny-room rig: a 139-char
  share): the runner's cut still drops its "More matches" line there. Not in a finding; a share that
  small holds no hit at all.
- **A native round's unreadable or unoffered `<tool_call>` blocks** are counted (tool_markup_stripped)
  but not turned into error results: a native model that writes markup in prose is not given a tool
  round it never asked for.

### Reviewer and checker scratch tests that now fail by design

- `.review/check-engine/salvage-edges.test.ts`, `salvage-glue3.test.ts`, `markup-glue.test.ts` only
  print (now `Let me think.\nThe door is red.`, `A.\nB.`, no leading `\n`).
- `.review/check-engine/notice-400.test.ts` passes (it asserts the fix).
- `.review/check-search/smallroom-example.test.ts` asserts the overrun (`> 700`): read_history now
  writes 692 ≤ 700.
- `.review/check-parse/residue.test.ts`, `stray-engine.test.ts`, `comma-engine.test.ts` pass (they
  assert the fixes).
- `.review/check-cli/probe-budget.test.ts` (both tests) and `ollama-500.test.ts` pin the reported
  defects (json_schema missing, tools 'prompted' at maxOutput 512, the Ollama hint).
- `.review/verify-search/english-alt.test.ts` checks the verifier's alternative Latin rule (no -o)
  against the fixture's 'meet' groups; the new hero/heroes, potato/potatoes and echo/echoes groups
  split under it (the point of item 14).
- The earlier list (Integration section) still holds for `.review/loop/*`, `verify-*`,
  `parsing-wire/*`, `providers-cli/*`.
- Re-run of all of `.review/` on the final tree: 192 pass, 17 fail, every failure one of the above or
  of the Integration section's table.

### ARCHITECTURE.md sentences these fixes make wrong (for the lead; not edited here)

- §8.6 line 2414 "рассуждения повторяются дословно из `replay`": rekeyReplay rewrites
  reasoning_details ids and re-keys tool_extra when a call id is renamed (engine fix, earlier).
- §8.3 line 2321 (tolerant parser) and line 2327 ("Если вызов полный … превращается в вызов"):
  unclosed blocks end after their values, comma-separated values are more calls, residue goes, a
  native round's unclosed complete block runs; markup a native round hides without running it is
  told.
- §7.1 line 1081 (already listed) and §6.2 step 9: the stored text's D-55 separator is decided on the
  stored text; a turn whose only visible text was a salvaged call fails as empty (B11).
- §9.1 line 2487 (already listed): the room goes one share per call, water-filled over maxOutput; a
  batch whose results the counter measures over the room runs once more in a scaled room.
- D-58 lines 4555–4558: below PAGE_FLOOR_CHARS + the paging lines the page is what the limit leaves,
  and a limit too small for a head gives the cursor alone.
- D-56 lines 4531–4534: ToolCtx also has `limit` (set by runTools).
- §7.5 step 3 line 2173 (already listed): the Latin -e cut is after s, x, z, ch, sh, i or o.
- C1 (two-pass selection, decisions C1 as amended): the history set alone when both sets do not fit.
- §8.4 lines 2354–2355 (already listed): the 400 notice is for `bad_request` only.
- Line 2908 (REPL Ctrl+C): Ctrl+C also stops a running `/probe --active` (nothing stored), and that
  press does not count toward quitting.
- Active probes (§8.2 source 4, §7.2): max_tokens per call is lowered to the caps' maxOutput and
  window; an Ollama 500 is never a refusal; a probe without a call left says `not run`.
