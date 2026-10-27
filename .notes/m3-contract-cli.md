# M3 contract notes — cli agent

Files: src/cli/* (catalog.ts and runtime.ts too, for wiring), README.md, test/repl/, test/cli/.

## What the CLI reads from others (no contract change asked)

- **Tool events** (`{type:'tool', phase, round, name, args, ok, summary}`): the side line is
  `⋯ <name> <args> → <summary>` (render.ts toolLine, shared by the REPL and `send`'s text mode).
  `args` reads best as the PARSED object (ToolCallOutcome.parsed): `{query:'караван', before: 40}`
  prints `"караван" before=40`, `{ids:['L1']}` prints `ids=L1`. A raw JSON string would print as
  is (cut to 60 chars). Please put the parsed object (or nothing) in `args` on 'done' — loop agent.
- **The D-55 separator**: the REPL drops ONE leading "\n" of the first text delta after a tool side
  line (display only; the stored answer keeps it). send's text mode keeps stdout byte-identical to
  the answer and starts the stderr tool line on a fresh line instead.
- **Status 'tools: off (prefill)'**: read from the answer's own trace (`trace.prefill === 'tools_off'`)
  in the journal after each turn (the notice is once per session, so it cannot be the signal).
- **/trace**: Trace.rounds {n, transport, ended, room, roomLeft} and Trace.tools rows (round, name,
  ok / refused, repaired, chars, cut). Absent rounds = no tools offered (an M2 trace prints as before).
- **/preview**: PreviewResult.tools names the tools; the transport word comes from the primary route's
  caps (ReplDeps.capsOf / runtime.bindingCaps), not from the preview. The core block is printed as
  a message like any other (src 'core:tools').
- **Notes**: SessionHandle.memoryAdd/Edit/Retire/Restore publish their `memory` event on the engine
  bus only; the REPL prints its own one-line confirmation (it does not subscribe to engine.events()).
  `/memory show` resolves the ref locally with agents/compendium/notes.ts resolveNoteRef (no verb).
  A refusal is printed as one red line `/memory <sub>: <message>`.
- **/probe --active** in the REPL: ReplDeps.probe (chat.ts → cmdProbe with active:true). Not offered
  under --provider record: (rt.recording; the probe calls would land in the recording) and refused
  under script:/replay: (override). After --write the chat says the facts apply from the next start
  (the engine's connections are built once).

## New exports others may use

- runtime.ts `bindingCaps(rt, conn, model)`, `connectionCaps(conn, model)`; Runtime.recording.
- render.ts `toolArgsText`, `toolLine`; repl-render.ts `toolsWord`, `toolTraceLines`,
  `previewToolsText`, `renderNoteList`, `renderNoteCard`, `renderSearch`;
  repl-commands.ts `takeRef`. ReplDeps gained `capsOf?` and `probe?`; ReplDeps.override gained `capsOf?`.

## Tests changed because M3 behaviour reached them

- test/cli/m1b.test.ts "send without --provider streams from the server": the v3-full card's book has
  entries that do not fire on "Hello", so D-92 now offers the lore tools on the mock (its caps say
  tools native), the prompt estimate grows past the mock's fixed 120 reported tokens and
  `context_truncated_by_server` fires. The test is about a plain M1b turn: its config.toml now says
  `[caps."mock:m"] tools = "none"`.

## Not mine, failing in the fast suite at the end of my work

- test/assemble/assemble.test.ts "only text blocks are rendered (D-16)" (prompt agent).
- test/lore/engine.test.ts "book match 'stem' is matched as literal in M2" (phase-1 lore/text change).
