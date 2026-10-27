# M3 contract notes — agent `prompt`

Files: src/prompt/assemble.ts (body), src/prompt/assemble/chat.ts, src/prompt/shape.ts,
src/prompt/tokens.ts, test/prompt-m3/ (budget.ts unchanged: toolRoom was already implemented).
No exported signature changed. Additions: `estimateToolSpecs(tools, counter?)` (tokens.ts),
`EchoOf` and an optional 4th parameter `echo` of `chatArea` (assemble/chat.ts).

## Needs a change in a file I do not own

1. **test/assemble/assemble.test.ts:239–262** ("only text blocks are rendered (D-16) …") pins the M2
   rendering of a history message with two text blocks (`'Let me look.'`, `' Found it.'`) as two
   blocks. Decisions C4 makes it ONE text block joined with ''. Fix: the 4th expected row becomes
   `[{ k: 'text', text: 'Let me look. Found it.' }]` (optionally rename the test "… one text block
   per message (C4)"). This is the only fast-suite failure caused by this agent. M2 never stored a
   message with several text blocks, so no golden/parity/hash changes (verified, see 5).

## Readings of the contract (implemented; please confirm / carry into rev 13)

2. **`kept`** = ids of the chat messages the request carries text for, in path order: hidden and
   blank messages out, the trimmed range out, the greeting only when sent. The continue target is
   in it (its text goes as the prefill or as a message); a blank `upTo` is not (nothing to find).
   Depth inserts are not path messages and never appear.
3. **`toolRoom` can be smaller than toolRoom(window, reserve)** when even the protected messages
   (greeting + the current message, + A on continue) leave less than the whole room: then every
   droppable message is dropped (trace.trimmed covers them) and toolRoom = what is left. The greeting
   goes only after the room is down to what is left (still the last resort before a refusal);
   context_length_exceeded only when the mandatory part WITH the core block (and native
   declarations) does not fit. The refusal names "the tool instructions N". The loop should take
   `asm.toolRoom` as is (MIN_ROOM_TOKENS then makes round 0 the final one when it is tiny).
4. **echoReasoning is honoured only when tools survive the prefill rule.** With [] or a D-28
   'tools_off' turn the history is text only, so such a request equals the tool-less one except
   trace.prefill and the notice (tested). caps.tools 'none' with tools passed is treated as no
   tools at all (defensive; C1 says it never happens). With prompted tools and echoReasoning the
   reasoning blocks are kept (the adapter then echoes nothing: no tool traffic on the wire); the
   request builder should pass echoReasoning only for native tools, as C3 says.
5. **No-tools invariant proof:** test/prompt-m3/no-tools.test.ts pins sha-256 digests of 12 assemble
   scenarios (lore, notes, guidance, trimming, factor, greeting drop, refusal, prefill preset,
   strict/maxMessages, both continue modes, o200k) captured from the M2 commit c478eed with M2's own
   assemble (recipe in test/prompt-m3/capture-m2.ts). The M3 code reproduces all 12, also with
   echoReasoning set and with tools on a caps.tools 'none' model.

## For other agents

- **loop (request.ts / narrate.ts):** the native declarations are counted in the fixed part but
  NOT in trace.tokens.estimated (the Trace doc says messages + prefill, and traceForSent recounts
  from messages only). On a native-tool turn the EMA sample (reported / estimated) therefore sees the
  declarations as tokenizer drift (the four builtins measure 840 o200k tokens today): it errs conservative. If that
  is unwanted, traceForSent could take the declarations (`estimateToolSpecs`) as an optional extra;
  I left the signature alone.
- **loop, R8:** `applyCapsRules` (shape.ts) is idempotent on an already shaped request (tested), so
  the loop may run it over the whole list after appending a round to get strict alternation /
  as-user notes on what it appended. Do not re-run `postProcess` (it inserts placeholders).
- **providers' risk note (DeepSeek strict alternation) is resolved in shape.ts:** a history answer
  (src 'history', role assistant) whose only non-text blocks are raw reasoning and that carries no
  replay merges like plain text; the merged message keeps both answers' reasoning blocks in order
  before the joined text. Loop messages (other src) with reasoning stay fixed, as M1b's tests pin.
- **integrate / docs:** C4 also changes what a tool-less request sends for a multi-round answer in
  history ("a\n\n\nb" on the wire before, now the streamed text exactly); worth one line in rev 13.
