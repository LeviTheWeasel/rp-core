# M3 contract notes — providers agent

Files: src/providers/{openai-chat,wire,scripted,record,probe,probe-active,caps}.ts, caps-data/hosts.json,
src/config/config.ts, src/cli/{catalog,runtime}.ts, src/testing/index.ts; tests test/adapter-m3/,
test/probe-m3/ (+ pinned M1b/M2 tests updated, listed at the end).

## For the cli agent (phase 2)

1. **`rp-core probe --active`** (main.ts): add `active: 'bool'` to the probe command's flags and pass
   `active: bool(p, 'active')` to `cmdProbe` (catalog.ts; the option is `active?: boolean`). Usage line:
   `rp-core probe [connection[:model]] [--active] [--write] [--json]`. Suggested help lines:
   `--active  also call the model (one <connection>:<model> only): a tiny reply, one tool offered with
   tool_choice auto, a json_schema reply; at most 6 calls of 96 tokens (they cost money on a paid API)` and
   `--write  store the catalog (and with --active the probe facts) in <home>/caps-cache.json; new turns use
   them; [caps."conn:model"] in config.toml still wins`. `cmdProbe` throws `UsageError('--active probes one
   model: …', 'probe')` for a whole connection or no target, before any request.
   `--json` results gain `active?: {observations, facts, calls, written, notes}` (ActiveProbeReport).
2. **REPL `/probe --active [--write]`** on the narrator binding: `cmdProbe({rt, io, json: false, clock,
   target: \`${conn}:${model}\`, write, active: true})` prints the same report. The REPL's connections were
   built from the cache at start (runtime.ts loadRuntime): after `--write` they do not see the new facts
   until rebuilt (`connectionsWith(rt, readCapsCache(rt.home))`) or the next start — say so, or rebuild.
3. **`--provider script:<file>`** (cli/provider.ts): load the file with `parseScriptFile(text)` and give the
   connection `caps = scriptCapsWith(file.caps)` (both exported from providers/scripted.ts and
   rp-core/testing). Without a caps line that is exactly SCRIPT_CAPS (a copy). `parseScript` is unchanged
   and still refuses a caps line.

## For the loop agent

- openai-chat yields `{t:'replay', r}` right before `finish`, at most once per kind ('reasoning_details',
  'tool_extra'); nothing after an error. streamCall pushes `ev.r` into `CallResult.replay`. The scripted
  provider emits it with a `{replay: {kind, payload, connection?, model?}}` step (connection/model default to
  the request's), and a tool step may carry `argsText` (verbatim tool_args delta; '' sends no delta).
- DeepSeek echo (C3), adapter side: with `caps.reasoning.echo === 'all-with-tools'` and tool traffic (tools
  sent, or tool_call blocks on the wire), EVERY assistant message carries `reasoning_content` (or `reasoning`
  when reasoning.output is 'reasoning'): its raw reasoning blocks joined with '\n\n', else
  `ECHO_PLACEHOLDER` (' ', exported from openai-chat.ts). **Except** when `req.reasoning === 'none' &&
  caps.reasoning.canDisable` (the C3 thinking-off fallback): then nothing is echoed. So the fallback must set
  `reasoning: 'none'` on every call of that turn (round 0 and later rounds).
- Final round unchanged: `toolChoice:'none'` on `!caps.toolChoiceHonored` sends no tools and no tool_choice;
  tool_choice is sent only when `caps.toolChoice` lists it (DeepSeek reasoners: never).
- `validateToolProtocol` already accepts the loop's shapes (tested in test/adapter-m3/wire.test.ts): an
  assistant message with reasoning + text + tool_call blocks (+ replay), then ONE role 'tool' PromptMsg with
  several tool_result blocks (rendered as one role:'tool' wire message each, in order); the native final cue
  as its own system/user message; a prompted round as plain assistant/user text.

## For the prompt agent (risk, not a contract change)

- With the DeepSeek echo, history assistant messages carry raw reasoning blocks; shape.ts `isFixedMessage`
  treats any non-text block as fixed, so two adjacent assistant messages (a hidden user message between them)
  stop merging and DeepSeek (`alternation: 'strict'`) answers 400 "successive same-role messages". Suggest:
  let two assistant messages whose only non-text blocks are raw reasoning merge (reasoning texts joined with
  '\n\n'), per the research note m3-probe-deepseek.md §0 finding 5. (`wire.ts mergeAdjacent` has the same
  rule but nothing in src calls it; I left it.)

## Decisions taken here (for the integrate agent / rev 13)

- **Cache split** (probe.ts): rows are `{as_of, server?, catalog?, probe?}`. `readCapsCache` returns a legacy
  `{caps}` row as `{catalog}`; `writeCapsCache` never writes `caps` (a legacy row passed in is written as
  catalog). A row needs `as_of` and at least one facts object. One `as_of` per row (the last write).
  config.ts: `row.catalog ?? row.caps` → resolveCaps' catalog slot, `row.probe` → probe slot, so
  `caps.source` reads host → model → catalog → probe → user.
- **cmdProbe**: a catalog refresh (single model or whole connection) keeps the row's probe part. `--active`
  runs after the catalog half (skipped when the server did not answer or refused the key), starting from the
  caps with the fresh catalog and WITHOUT the row's old probe part. With `--write` the new facts are merged
  over the old probe facts (an inconclusive probe erases nothing). Without `--write` it prints the facts and a
  ready-to-paste `[caps."conn:model"]` block (tools / stream_usage / structured_output).
- **runActiveProbes** (evidence only; never maxInFlight/contextLength): order stream → stream_usage (only
  when no usage/timings arrived and caps.streamUsage is not 'stream_options') → tools round 1 (tools
  [lookup_word], toolChoice 'auto', caps.tools forced 'native' for the request) → tools round 2 (only after a
  native call: sent like the loop's FINAL round — result appended, toolChoice 'none', round 1's raw
  reasoning and replay on the assistant message, args echoed as JSON of the parsed object or '{}') →
  json_schema (caps.structuredOutput forced {mode:'json_schema'}, PROBE_JSON_SCHEMA, a prompt that does not
  ask for JSON). Max 5 calls in practice (≤ ACTIVE_PROBE_MAX_CALLS = 6). A failed stream probe ends the run;
  unreachable/auth_failed/key_unavailable on the tools probe skip json_schema.
  Facts: `streamUsage` 'always' (usage object without stream_options), 'timings' (llama.cpp timings only),
  'stream_options' (usage only after the retry), 'none' (refused or nothing even with it; or caps asked for
  it and none came); nothing when caps asked for it and it came. `tools` 'native' after round 2 answered (any
  finish), 'prompted' when round 1 leaked (findToolCallLeaks complete span, or recoverLeaks finds the call)
  or was refused (HTTP 400/404/405/415/422/500/501 before output) or round 2 was refused; nothing for no call
  or a transient failure. `structuredOutput` {json_schema, confirmedBy 'probe'} when the reply is exactly the
  schema's object (bare JSON), {mode:'none'} for prose / other JSON / a refusal, nothing when empty or cut by
  the token cap. `reasoning.output`: reasoning_details if seen (OpenRouter sends `reasoning` next to it), else
  the one native field seen, else 'tags' when reasoning events came with no native field; nothing when two
  native fields or none were seen.
  The caller's abort (input.signal) is rethrown; timeouts (first byte, idle; after the finish a
  FINISH_GRACE_MS grace) make that probe inconclusive.
- **ACTIVE_PROBE_MAX_TOKENS = 96** (contract) is tight for thinking models: a model that thinks first may
  hit the cap before calling the tool ("no tool call (the reply hit the 96-token cap)") or before the JSON
  ("inconclusive"); both write nothing. The research note proposed 1024/512. Worth a look in the live demo.
- **hosts.json**: llama.cpp, Ollama and vLLM rows no longer carry `structuredOutput` at all (mode included:
  nothing in src needs an unconfirmed json_schema claim, and the builder would send response_format on it);
  their notes say a probe or the user confirms it. `checkCapsRows` now refuses `confirmedBy: 'host'` on a
  local-server host row (port-only rows and server ∈ `LOCAL_SERVER_KINDS`, exported from caps.ts).
- `record.ts` exports `passThrough` (the probe watches the wire with it).

## Tests updated because they pinned M1b/M2 shapes

- test/adapter/fixtures.test.ts: the OpenRouter and NanoGPT reasoning_details fixtures now expect the
  replay event before the finish.
- test/adapter/request.test.ts: a summary-only assistant message gets `reasoning_content: ' '` under the
  echo; the llama.cpp preset no longer sends response_format unconfirmed (a probe-confirmed caps does).
- test/caps/probe.test.ts (cache round trip in the new shape, legacy row → catalog), test/caps/caps.test.ts
  (new checkCapsRows rule), test/config/build.test.ts (catalog/probe slots), test/cli/m1b.test.ts:334
  (`source` contains 'catalog', not 'probe'; the row's `catalog`), test/cli/review-m1b.test.ts (row shape).

## Not mine, failing in the fast suite at the time of writing

- test/lore/engine.test.ts "book match 'stem' is matched as literal in M2" (lore/text change of M3).
