# M3 contract notes — integrate

What the integrate agent changed outside the module agents' files, and how every
`.notes/m3-contract-*.md` note was resolved. ARCHITECTURE.md rev 13 should carry the "accepted"
items as decisions or notes.

## Changes made here (contracts kept consistent everywhere)

1. **SAFE_NAME / SAFE_ID exported from `src/providers/wire.ts`** (loop 22, tools-parse 1). The private
   copies in `src/engine/narrate.ts`, `src/tools/run.ts` and `src/providers/probe-active.ts` are gone;
   all three import them. No behaviour change.
2. **The notes book is not a world** (loop 20). `prompt/assemble/lore.ts loreSources`: the '@notes'
   source never shadows a book and is never shadowed by name (a lorebook or card book called
   «Заметки» used to hide every note, or be hidden by them). It stays where the caller put it
   (request.ts: first; the lore engine gathers it after '@card'). Without notes the sources are M2's
   exactly. Test: `test/prompt-m3/notes-shadow.test.ts`.
3. **`trace.tokens.estimated` counts native tool declarations** (loop 21, prompt "for other agents").
   `traceForSent(trace, messages, prefill?, nativeTools?)` gained an optional 4th parameter: the
   declarations of a native-tool request, estimated with `estimateToolSpecs` and added like the
   prefill (`blocks` stays 1:1 with the messages). turn.ts `sentTrace` (prep line, server-window check,
   commit) and session.ts preview pass `tools.specs` when the turn's transport is native. Why: the
   server counts the declarations as prompt; without them the EMA sample and the truncation check
   read native turns as tokenizer drift (≈ 500 o200k tokens for the two history tools; the live gemma4
   run: estimate 2173 with them vs 2152 reported, 1670 without). Prompted tools are already in the
   messages (the core block). No tools: unchanged (golden/parity green). Doc of `Trace.tokens`
   updated in entries.ts. Test: `test/engine-m3/estimate.test.ts`.
4. **Two stale M2 tests updated** (prompt 1, text 1): `test/assemble/assemble.test.ts` "only text
   blocks are rendered (D-16), joined as one text block per message (C4)" expects the C4 join;
   `test/lore/engine.test.ts` "book match 'stem' matches by stems (M3)" expects `+key`.
5. **Port headers added** to the adapted tests that had only a prose credit:
   `test/tools-builtin/{search-history,read-history,lore,index}.test.ts` (Levi) and
   `test/engine-m3/{loop,units}.test.ts` (Coneja-Chibi), matching their PROVENANCE rows.
6. **`src/index.ts`** exports the M3 public surface: `PreviewOptions`, `PreviewResult`, `ToolTraceRow`,
   `Replay`, `ToolSpec`, the tool types (`Tool`, `ToolCall`, `ToolCallOutcome`, `ToolCtx`,
   `ToolOutput`, `DEFAULT_TOOL_OUTPUT`), `HISTORY_TOOLS` / `LORE_TOOLS` / `toolSpecs`, `HistoryHit` /
   `HistorySearch`, `CEntry` / `CompendiumView` / `MemEntry` / `MemOp`, `LoreVerdict`, and
   `runActiveProbes` with its input/result types and limits. SessionHandle's verbs are part of the
   already exported SessionHandle type.
7. PROVENANCE.md: the M3 rows merged (28 rows, file order kept, no existing row moved), the *record*
   verdict defined, narrate.ts taken out of the "fresh" list for its M3 parts, an "M3 adds, fresh"
   paragraph (incl. the jsonrepair dependency and the RoleCall tool-call-test.ts anti-example).
8. New: `test/demo-m3/innkeeper.test.ts` (the §15 demo, deterministic), `test/live/m3-ollama.test.ts`
   (RP_CORE_LIVE=1; plumbing checked against a local mock of Ollama's /v1), `docs/M3-DEMO.md` (the
   live run). README: the live test row, the M3 demo link, "about 3000 tests".

## The module agents' notes

- **builtins** 1–6 (read_history cut mark without an offset, "at least one message" instead of two,
  layout and texts, notes as `(note)`, read_lore limits): accepted as implemented; rev 13 should
  replace the contract comments' wording. 7–10 (exports, maxOutput per tool, outputRoom, schemas):
  accepted. **11 (handle numbering):** kept as decided (D4: first appearance per turn), so the tool's
  `C<n>` is not the REPL's `C<n>` (noteRefs = creation order). The docs must say so; no code change.
  12–16: accepted / informational.
- **cli**: nothing asked of integrate. The 'done' tool event carries the parsed args (loop 19;
  checked live against a mock: `args: {query: "брат"}`). The m1b test that now pins `tools = "none"`
  is fine.
- **loop** 1 (EngineSeams.toolSets) kept. 2–19 accepted (rev 13 decisions: `ended` of a forced final
  round, pass B dropped below MIN_ROOM_TOKENS, D-94 over `kept`, the echo inside the loop, prompted
  leak recovery of other dialects, native wire text, the JSON-in-prose known limit, gen.usage sums,
  FINISH_GRACE_MS beside the idle limit, fallback build failures, M9 hook layout, continue layout,
  unfiredLore, tool event args). 20, 21, 22: done (above). 23–24: informational.
- **prompt** 1 done; 2–5 accepted. "integrate / docs": C4 changes what a tool-less request sends for a
  multi-round answer in history (the streamed text instead of the '\n\n' join) — a rev 13 line. The
  DeepSeek strict-alternation risk (providers) is resolved in shape.ts.
- **providers**: the CLI wiring (probe `--active`, REPL `/probe --active`, a script file's caps line)
  is in place (checked: main.ts flags/usage, provider.ts parseScriptFile + scriptCapsWith). Cache
  split, probe order and facts, hosts.json: accepted. **ACTIVE_PROBE_MAX_TOKENS = 96** stays open:
  the live probe ran on magmell (no thinking; stream ok, tools refused 400, json_schema enforced), so
  the thinking-model case was not exercised (budget); see docs/M3-DEMO.md.
- **text** 1 done; 2–7 accepted (one ending + stem tail, Latin folding, wordsOf extras, empty query,
  parseQuery, lexScore per key); 8–10 additive. Docs: §10.3 step 1 "Заметки — M5" and "до M3 …
  literal" are stale (rev 13).
- **tools-parse** 1 done; 2–9 accepted (the loop uses `cutAtPromptedStop` and calls `end()` per round).

## Open (for the lead)

- **The live demo did not call a tool** (docs/M3-DEMO.md): magmell-16k (prompted) answered three
  times without a call (once "not mentioned", twice a wrong name taken from the visible chat),
  gemma4:26b (native, 4096 window) thought it over and answered "not mentioned". Neither prompt
  tells the model that the chat it sees is only the tail of a longer one, and the only tool guidance
  sits in the head, ~9 000 tokens before the question. Proposal, not implemented (model-facing text,
  a contract change of `renderCoreBlock`): when the history tools are offered (D-92: exactly when the
  history was trimmed), say so in the core block, e.g. "Only the end of this chat is shown to you:
  messages #2–#161 are not. Anything said there can be found with search_history.", and
  consider a short tail reminder for prompted mode. `test/live/m3-ollama.test.ts` asserts the demo
  claim and is expected to fail on magmell until then.
- Ollama's /v1 streams thinking as `delta.reasoning` (seen live on gemma4:26b); the parser reads every
  known reasoning field whatever the caps say, so it arrived as reasoning (841 characters, stored as a
  raw reasoning block). With max_tokens 300 the thinking took most of the reply budget (260 tokens
  out); a thinking model in a tool loop needs more room, or a way to turn thinking off on Ollama.
- `gen.reasoningMs` is never written (since M1; not an M3 regression).
