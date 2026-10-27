# M3 decisions (the lead's design note; authoritative for the M3 build)

M3 = "Tools and search" (ARCHITECTURE.md §15). The spec is the base; where it is silent, contradicts
itself or was overtaken by an accepted decision, THIS note decides. Every "D-9x" below becomes a
numbered decision in ARCHITECTURE.md rev 13 after the build. Research notes the decisions rest on
(read the parts your task names): `<session scratchpad>/m3/`
`m3-spec-1.md`, `m3-spec-2.md` (requirements), `m3-code-map.md` (current code, seams, risks),
`m3-port-rc-tools.md`, `m3-port-search.md`, `m3-port-br-loop.md` (port sources, verbatim texts,
authors), `m3-probe-deepseek.md`, `m3-test-plan.md`.

Facts checked by the lead: DeepSeek's docs (api-docs.deepseek.com/guides/thinking_mode) say that
with `tools` in a request the `reasoning_content` of ALL previous turns must be passed back, or 400.
The user's Ollama 0.34.2 on `/v1` read a 13 917-token prompt whole for `magmell-16k:latest` (its
Modelfile num_ctx 16384 applies): Bunraku's "/v1 ignores num_ctx" does not reproduce there.

## A. Superseded spec text (accepted decisions win)

1. Word class: D-46 (`\p{L}\p{N}\p{M}`, normalize.ts WORD_CHAR_CLASS), not §7.5's `[\p{L}\p{N}]+`.
2. read_history page: D-58, not §7.5's 4 000.
3. Argument chain order: D-56, not §9.1.
4. §11 "a tool result ≤ 4 000 chars" = DEFAULT_TOOL_OUTPUT only; read_history (page + 1 000) and
   read_lore (8 000) set their own maxOutput.
5. §10.3 step 1 "notes — M5" is stale: notes are M3 (§5.8, §15).

## B. The loop (engine/narrate.ts narrateRounds, engine/turn.ts)

1. **One loop per route.** `streamCall` stays the one-call primitive (now with tools, toolChoice,
   stop, collected native calls and replay payloads). `narrateRounds` runs every round for one
   route. Retry and fallback stay in turn.ts and wrap the WHOLE loop, only while the result has no
   output (no text, reasoning or tool call yet) — in practice round 0 (§6.6). A retry re-runs the
   loop from scratch.
2. **D-90: fallback with another transport.** A fallback route whose `caps.tools` differs from the
   primary's gets its request rebuilt (buildRequest with the fallback as the route: same view, seed,
   now); `prep` is not rewritten. Same transport → reshaped as today.
3. **Rounds and ceiling.** maxRounds = config.narrator.maxRounds clamped to 1..MAX_TOOL_ROUNDS (8);
   a larger value is clamped with notice `tool_rounds_clamped` (D-55). CALL_CEILING (12) counts every
   narrator model call of the turn, retries and fallback included; a round is the last when: no tools,
   or round ≥ maxRounds, or calls + 1 ≥ CALL_CEILING, or the loop guard tripped, or the tool room is
   below MIN_ROOM_TOKENS. A loop that ran tools always ends with a final round (round > 0).
4. **D-91: final round.** `toolChoice: 'none'`, the tools still in the ModelRequest (§7.1). The
   openai-chat adapter keeps dropping them when `!caps.toolChoiceHonored` (Ollama would call them
   anyway); that is the adapter's choice per caps, not the loop's. FINAL_CUE (narrate.ts) is added on
   every final round with round > 0: native → its own message (`system` when caps.midSystem is
   'native'/'anthropic-native', else `user`; src 'core:final_cue'); prompted → appended to the
   results user message (frameResults cue). RoleCall's VN cue text is not used.
5. **D-55 separator, lazily:** right before the first text delta of round k > 0, if the turn's
   visible text is non-empty and does not end in whitespace, one "\n" goes through onText (event +
   chk) and belongs to round k's text block. Nothing is sent for a round with no text.
6. **Storage blocks** (RoundsResult.blocks): per round: reasoning (raw, if any), text (visible, if
   non-empty), tool_call per call, tool_result per call, in call order. concat(text blocks) ===
   everything onText received === the chk text. A turn without tools commits `[reasoning?, text]` as
   in M2. Turn step 9 strips unrecovered leaks from EACH text block (empty blocks dropped);
   recover.ts stays as is (one text block from chk, §6.7).
7. **Prompted round:** no `tools` in the request; stop = sampler stops + PROMPTED_STOP (deduped;
   when caps.stopMax is exceeded the prompted stop stays and the sampler's last stops go). Live text
   passes the prompted stripper before onText. At round end parsePromptedCalls(raw round text) gives
   the calls; ids `call_<round>_<i>`. Wire append: assistant `{text: raw round text}` (tags kept,
   §8.3) and ONE user message `frameResults(results, cue?)`. A block with an error still becomes a
   call (name from the block or 'invalid_tool') whose result is the error: storage stays paired.
8. **Native round:** request tools = specs (sorted), toolChoice 'auto' (final: 'none'). Live text
   ALSO passes the prompted stripper (Qwen-style `<tool_call>` leaks never reach events or chk).
   Calls = the stream's native calls; when there are none, recoverLeaks(raw round text, {offered,
   nativeCalls: 0}) may recover some (via 'leak'). Ids: the server's when SAFE_ID and unused in the
   turn, else `call_<round>_<i>` (suffix `_2`… on collision). Wire append: assistant {reasoning (only
   when the echo is on, see C), text (visible), tool_call echoes (SAFE id, echoName, echoArgs)} with
   the round's `replay`, then ONE `role:'tool'` PromptMsg holding the tool_result blocks in call order.
9. **Calls on the final round** (the model ignored 'none'): not run, not stored as blocks; rows in
   trace.tools with refused 'final_round'; notice `tool_calls_on_final_round` (once per session);
   finish 'max_rounds'. Their visible text is kept.
10. **Loop guard (fixes Bunraku stop-core):** after each round, for every call the triple (name,
    canonicalJson(args), sha-1 of the result text); if ANY triple occurs ≥ GUARD_REPEATS (3) times
    among the turn's last GUARD_WINDOW (8) calls, the next round is the final one (ended 'guard').
11. **Empty and failed turns:** a turn whose rounds produced no visible text at all follows the M2
    rules for the whole turn (empty_response / reasoning_only / content_filter / refusal); nothing is
    committed (tool blocks dropped). A final round with no text after earlier text commits normally.
12. **Stop / failure mid-loop:** blocks so far; calls of the unfinished round are dropped; calls
    whose tools were running get `{k:'tool_result', text:'cancelled', error:true}` (§6.5). Commit
    when any visible text exists (stopped / interrupted with onError 'keep'), else stopped-empty /
    end{failed}; the draft is the visible text.
13. **Usage and trace:** one `usage` event per model call; callKey `${turn}:narrator:${round}` (a
    retry or fallback of round 0 keeps `:0`). gen.usage = sum over the turn's calls (cost summed only
    when every call has one); trace.tokens.reported = round 0's inputTotal; trace.calls one row per
    call; trace.tools rows (ToolTraceRow); trace.rounds {n, transport, ended, room, roomLeft};
    gen.transport = the route's caps.tools when tools were offered, else 'none'; gen.rounds = model
    calls of the loop. ema.ts reads trace.tokens.reported FIRST, then gen.usage.inputTotal (sums never
    feed the EMA); checkServerWindow uses round 0's usage. trace.blocks/tokens.estimated stay the
    round-0 request (preview --turn compares them 1:1).
14. **Finish grace (rev 11 note 37):** after a `finish`, streamCall ends the call after
    FINISH_GRACE_MS of silence (abort with its own reason; not an error, no tailError).
15. **Tools read the request's view** (BuiltRequest.view, folded at upTo), never host.view().
16. **Continue on a message with tool blocks:** the addition is appended to the LAST text block, the
    block order kept (commit.ts). `edit` keeps its M1 behaviour (tool blocks, then one text block).

## C. The request (engine/request.ts, prompt/*)

1. **D-92: tool selection, two passes.** Pass A assembles with `tools: []` — byte-identical to M2.
   Offered: search_history + read_history when pass A's trace.trimmed is not null (the history did
   not fit); search_lore + read_lore when the turn's lore sources (persona, card, notes, session
   books) hold an enabled entry (or live note) that did not fire in pass A. None for continue, for
   caps.tools 'none', and for a fallback-free DeepSeek case (C3). Empty → pass A is the request.
   Else pass B assembles with the specs (D-28 applies inside assemble; when it turns tools off,
   BuiltRequest.tools is null). preview uses the same buildRequest (its `tools` shows the specs).
2. **Core block** (assemble, only when asm.tools is non-empty): one system message, placement
   'head', src CORE_TOOLS_SRC ('core:tools'), right after the last system message of the leading
   run (before new_chat and the history); text = renderCoreBlock(tools, caps.tools). It and, for
   native tools, the schemas' JSON (estimated like text) count in the fixed part. **D-93: tool
   room:** assemble keeps toolRoom(window, reserve) = round(0.25 × (window − reserve)) free by
   trimming more history; AssembleResult.toolRoom = it (0 without tools). `kept` = ids of the path
   messages whose text the history sent.
3. **D-94: DeepSeek echo (§8.4).** When the route's caps.reasoning.echo is 'all-with-tools' and native
   tools are offered: every assistant message in the history generated by a model (gen.kind
   'model') must have a raw reasoning block from the same connection and model. Greetings
   (gen.kind 'greeting') are exempt. All have it → assemble's `echoReasoning` keeps those reasoning
   blocks and the adapter echoes them. Otherwise: caps.reasoning.canDisable → BuiltRequest.reasoning
   'none' (thinking off this turn) + notice `caps.suggest` (once per session); else no tools this
   turn + notice `caps.suggest`. The adapter, with the echo on, sends `reasoning_content` on EVERY
   assistant message: its reasoning text, or " " (one space) when it has none — DeepSeek rejects an
   empty string (third-party report; unverified, named as such in the docs).
4. **History:** assemble/chat.ts renders each history message's text blocks as ONE text block
   (joined with '', as they streamed), so the adapter's '\n\n' join never splits a multi-round
   answer. Reasoning blocks only under echoReasoning.
5. **Notes source:** request.ts adds the notes book (notesBook(view.compendium), key NOTES_BOOK_KEY)
   before the session books; the lore engine gathers '@notes' as its own group after '@card'. Notes
   work whatever compendium.enabled says (M3 has no agents to switch off).
6. **ToolCtx per turn:** view = BuiltRequest.view, upTo, names {char: card name, user: persona name
   ?? 'User'}, lore = the turn's sources (persona, card, notes, session books), compendium =
   view.compendium, a new HandleTable, inContext(id) = asm.kept includes id, now = turn now, rng =
   subRng(seed, 'tools'). Per round: signal = a child of the turn signal; pageChars =
   min(historyPageChars(window), roomChars) where roomChars = floor(roomLeft / tokenFactor × 2.5).

## D. Tools

1. Names: search_history {query, before?, limit?}, read_history {from, to?}, search_lore {query},
   read_lore {ids}. Schemas flat, additionalProperties false. All model-facing text in English; a
   hidden message reads `#n (hidden)`.
2. Arguments (D-56 chain, tools/args.ts): never invent a required value, never drop an unknown key
   silently (additionalProperties false → error). The model gets `Invalid arguments for <tool>: … Send
   one complete JSON object that matches the schema.` (≤ 500 chars). Echo args = JSON of the parsed
   object, '{}' when unparseable.
3. Results: parallel, call order, one tool's failure isolated, duplicates in a round run once,
   cut with `\n[cut: the result was longer than N characters]` to min(maxOutput, room share).
4. Handles (D-59): `L<n>` lore entries, `C<n>` Compendium records (notes), per turn, from 1 in order
   of first appearance; read_lore takes handles only.
5. search_history: AND of all query parts, newest first, default 10, max 20, `before` cursor from the
   last returned hit (fixes RoleCall's window skip), ±110-char snippet, '(in context)'. Stop words
   dropped from the query (D-46 list exactly). Phrases in "…", «…», “…” literal (folded, unstemmed).
6. read_history: D-58 pages over #from..#to, whole messages, hidden stubs, `next_from`.
7. search_lore: lexScore (matched parts → parts in title/keys → rank) over enabled book entries
   (rank = order) and live notes (rank = prov.lastSeq); notes listed once (as C<n>), the @notes book
   skipped. Top 10.

## E. Search text (text/normalize.ts, text/lexscore.ts)

normalizeTerm: foldText (NFKC, lower, ё→е, U+0300–U+036F dropped), then one longest Russian ending
from an own list (≈ 40–60 noun/adjective endings and only verb endings that never break nouns) for
Cyrillic words of ≥ 4 letters when ≥ 3 remain; Latin ≥ 4: "'s" / "es" / "s". Required: караван/
каравана/караваном, Мира/Миру/Мирой, трактирщица/трактирщицу, брат/брата/братом, ёж/еж; apart: брат vs
братства, мир vs мирный. Known miss allowed: герой/героя (document it). Stem key match: consecutive
key words with equal stems; spaceless scripts by folded substring.

## F. Notes (agents/compendium/*, session/fold.ts, engine/session.ts)

1. Human rows: `{t:'mem', key:null, on:null, by:'user', ops:[op]}`, one op per row, durable.
2. Fold per §5.8 restricted to notes (apply.ts contract). Keys `note:<normalizeName(title)>`,
   '#2'… on collision with ANY entry (retired included). normalizeName = Bunraku's + NFKC + ё→е +
   \p{M} kept (D-95, a named change of a ported function).
3. PathView.compendium is folded from TreeIndex.mems for the view's path (so foldViewAt sees it);
   SessionImpl caches tree() and view() on (version, lastMemSeq).
4. notesBook: depth 4, role system, src 'compendium' (lore/place.ts maps the '@notes' source), text
   `[Memory: <title>]\n<content>`, one insert per note, scanDepth 4, match 'stem', recursive false.
   Notes count against the lore budget.
5. Verbs (api.ts contract): refused with session_busy while a turn runs; invalid_params / not_found;
   each publishes a `memory` event (change note|edited|retired|restored, kind 'note', by 'user').
   Refs: key, 'C<n>' (noteRefs numbering: creation order of all notes on the path, 1-based), or a
   unique title.
6. REPL (§12.4): `/memory` (list), `/memory show <ref>`, `/memory add <title> | <keys> | <content>`
   (keys comma-separated, may be empty → [title]), `/memory edit <ref> <title> | <keys> | <content>`
   (an empty part keeps the old value), `/memory retire <ref> [reason]`, `/memory restore <ref>`.
   `/search <query> [before=<n>]`. These are the M3 subset; the rest of §7.4.9 stays "later" (M5).

## G. Providers and probes

1. StreamEv `{t:'replay', r}` (contract): openai-chat yields its reasoning_details / tool_extra once
   per call before `finish`; record/replay keep it (scrubbed like the rest); scripted can emit it.
2. Scripted provider: a tool step may carry `argsText` (sent verbatim, for broken JSON) instead of
   `args`; a `{replay: Replay}` step; a script FILE may start with a `{"caps": {…}}` line (partial caps
   merged over SCRIPT_CAPS) so `script:` connections in CLI tests can have tools. SCRIPT_CAPS stays
   tools 'none'. hashRequest unchanged (toolChoice and stop are not hashed: documented).
3. Active probes (probe-active.ts contract): `rp-core probe <conn:model> --active [--write] [--json]`,
   REPL `/probe --active` on the narrator binding. Cache rows split catalog/probe (probe.ts
   contract); config.ts feeds each into its own resolveCaps slot. hosts.json: local servers (Ollama,
   llama.cpp, vLLM) lose `structuredOutput confirmedBy:'host'` (§7.2: local servers need a probe or
   the user).
4. DeepSeek: the adapter's echo rule per C3.

## H. CLI

Banner `(tools: native|prompted|off)` from the narrator route's caps; a status item
`tools: off (prefill)` when the last turn's trace.prefill is 'tools_off' (D-28); tool events as dim
side lines (exists) also in `send` text mode; `/trace` shows rounds (n, transport, ended, room) and
the tool rows; `/preview` shows the core block like any message and lists tools; help texts and the
README updated; `/memory` and `/search` leave the LATER table.

## I. Invariants every agent keeps

- **No tools offered ⇒ the request, the trace and the committed blocks are exactly M2's.** Golden,
  parity and assemble fixtures and scripted request hashes must not change.
- Tools never write anything; tool rounds never change the version; `base` stays valid.
- Purity tests: no Date.now / Math.random / argless new Date / performance.now in src; no top-level
  let/var in engine files; clocks and timers injected.
- Model-facing texts are deterministic for the same inputs (they sit in the cached prefix).

## J. Build phases and ownership

Phase 1 (parallel): text · tools-parse (args, prompted, leaks, run, handles, package.json) · memory
(compendium, fold, tree, session verbs) · providers (adapter, scripted, record, probe, caps, config,
catalog, runtime). Phase 2 (parallel): builtins (history, lore, index) · prompt (assemble, chat,
budget, tokens, shape) · loop (narrate, turn, request, ema, commit, admit, session.ts preview only) ·
cli (src/cli except catalog/runtime, README) · fixture (the 200-message demo chat). Phase 3:
integrate (full suite, e2e demo test, live Ollama demo, docs/M3-DEMO.md, PROVENANCE). Then review.
Contract problems → `.notes/m3-contract-<agent>.md`; provenance rows → `.notes/m3-provenance-<agent>.md`.

## K. Added after the live demo

**D-96: the gap note and the tool reminder.** The first live run (docs/M3-DEMO.md) showed both
local models answering from the visible chat as if it were all of it: nothing told them the history
was cut. When the history tools are offered (D-92) and the request leaves out a run of messages:
1. a system message, src `core:gap`, sits in the chat right before the first message sent after the
   left-out run: `[Messages #A–#B of this chat are not shown here. search_history finds what was said
   in them; read_history shows them in full.]` (A, B in the history tools' numbering: path positions
   from 1, hidden messages counted; singular form when A = B). It sits where the request changes
   anyway when the trim moves, so the cached prefix is not affected. Counted in the fixed part with a
   worst-case width, never trimmed; depth inserts count over chat messages only.
2. a system message, src `core:remind`, at depth 0 after every other depth-0 insert: `(Part of this
   chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise,
   who said what — look it up with search_history before you write. If it does not, just write the
   reply.)` Constant text at the end of the request: no cache cost.
Neither exists without tools or with only the lore tools (the M2 invariant holds). Tools are never
offered on continue, so neither appears there.

**D-94 (revised after review).** The thinking-off / tools-off plan of C3 is withdrawn: it never
converged (an answer written with thinking off has no reasoning, so the next tool turn turned
thinking off again, for the rest of the chat). The greeting exemption already bets every DeepSeek
tool turn on the `" "` placeholder (a card greeting sits in nearly every chat), so the bet is the
same for every other answer. New rule: when the route's caps.reasoning.echo is 'all-with-tools',
native tools are offered and thinking is on for this call (not `binding.reasoning 'none' &&
canDisable`), every assistant message carries its own raw reasoning from the same connection and
model when it has one, else `reasoning_content: " "`; no thinking-off, no tools-off, no caps.suggest
for it. When thinking is off (binding 'none' && canDisable) nothing is echoed and nothing is
reassembled. A fallback whose echo rule differs from the primary's gets its request rebuilt (D-90).
If the provider then refuses a tool request with HTTP 400, a once-per-session notice names the way
out (`[caps."conn:model"] tools = "none"`). The placeholder stays named as unverified in the docs.

**D-59 (amended): one numbering for notes.** A note's handle in tool output is its `/memory` handle
(noteRefs: creation order of all notes on the path, 1-based), stable across turns, so `C3` in a
lookup line and `/memory show C3` are the same note. `L<n>` (lore entries) stays per turn, in order
of first appearance. read_lore resolves `C<n>` through noteRefs even when no search this turn
listed it.

## L. Added after the second live run

The rerun after D-96 and the review fixes (magmell-16k, prompted, 3 tries) still made no call, but
the reminder changed what the model reached for: one try wrote
`<search_history>\n…\n</search_history>` (the tool's name as a tag, a made-up result inside, then
prose), the other two answered from the visible chat. The core block's call example sits in the
head, ~9 000 tokens before the question. A raw check (the same request sent to Ollama by hand, 3
calls) with the reminder below gave one well-formed `<tool_call>{"name": "search_history", "args":
{"query": "брат Марфы, имя"}}` (unclosed, then EOS) and two answers without a call; the D-96 text
gave none of three.

**D-96 (amended): the prompted reminder shows the call.** When the turn's transport is prompted, the
reminder (src `core:remind`, same place) is:
`(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place,
a promise, who said what — look it up before you write. Write the call on a line of its own, then
stop:\n<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>\nIf
it does not, just write the reply.)` (`\n` are newlines; the block is exactly the format of the core
block's example, built from the same constants so the two cannot drift). Native transport keeps the
D-96 text. The fixed budget measures the variant actually sent. The gap note is unchanged.

**D-97: an offered tool's name used as a tag is a call of that tool.** Extends D-57's dialects. In a
round where tools are offered, `<NAME …>BODY</NAME>` where NAME is the name of an OFFERED tool (any
case, whitespace after '<', optional attributes, an XML namespace prefix like the other tags;
unclosed at the end of the text like an unclosed `<tool_call>`) is one call of NAME:
- BODY a JSON object: an envelope `{"name": NAME, "args"|"arguments"|"parameters": {…}}` gives its
  args; any other object is the args itself.
- otherwise, when NAME's input schema has exactly one required property and its type is string, the
  trimmed BODY text is that property (search_history `query`); an empty BODY is a call without it
  (the tool's own error tells the model).
- otherwise the call is malformed and reported to the model like any other malformed prompted call.
It is parsed, run, stripped from what streams and from the stored text exactly where a `<tool_call>`
block would be (prompted rounds; a native round's prompted-family fallback; the final round strips
without running and counts it as hidden). Names that are not offered are never matched, so a turn
without tools is byte-identical to M2 and prose tags (`<i>`, `<br>`, `<search>`) are untouched. Risk
noted for the docs: a future tool with a short everyday name (`roll`, `note`) would make that word a
tag in prose; the v1 tools all contain '_'.

**Accepted readings and post-check rules (D-97).** The lead accepted three readings of the
implementation: (1) on the final round every `<tool_call>` block and name tag counts as hidden
markup, so `tool_markup_stripped` fires beside `tool_calls_on_final_round`; (2) a name tag left
unclosed with a body of text ends with its first line when more text follows on later lines (a
query is one line; the story goes on below it); (3) an empty closed body is a call without arguments
for every tool, not only for one whose single required property is a string (the tool's own check
tells the model what is missing); empty and cut off by the end of the text it is a cut-off call. The
adversarial check added (tools/prompted.ts, tools/leaks.ts, engine/narrate.ts):
- Wrapper: a `<tool_call>` or name tag left empty and ended by the next block's opener (a
  `<tool_call>` around a name tag, a name tag around a `<tool_call>`, an opener written twice) is
  markup, not a call: removed like a stray closer, and so is its own closer after the call.
  `parsePromptedCalls('<search_history>'.repeat(3000), tools)` (search_history offered) is one cut-off call.
- Cut tags: after an unclosed call value, `<` and an offered tool's name cut off by the end of the
  text (`<search_hi`) could still be more of the call, like `<tool_ca`: the call is cut off (an error
  result) and nothing is shown. After a body of text, a tag of the call family cut off by the end of
  the text goes with the block, and the text stays the argument.
- Unclosed text body: read after a leading `json` word; a fence opened inside the tags ends with its
  closing fence line; a fence that never closes runs to where the block would end (the end of the
  text, or the next block's opener).
- recoverLeaks `keep`: in a native round, a call recovered from inside a prompted-family block (a
  closed name tag or `<tool_call>`) stays in the recovered text, and the batch strip removes it with
  the stream's own grouping and seams. A run of adjacent closed blocks is no longer counted as
  salvaged and fires no `tool_markup_stripped`.
- The prompted reminder's call (gap.ts REMIND_CALL) and the core block's example line are built by
  the same `promptedCallLine` (tools/prompted.ts; gap.ts imports and re-exports it).
