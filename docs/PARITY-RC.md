# RoleCall parity

rp-core is compared with RoleCall's prompt assembler on fixed inputs (ARCHITECTURE.md §14, "Паритет с
RoleCall"). Parity is asserted only where the core does not diverge on purpose. Every other
difference is listed below with the decision that makes it intentional.

Suite: `test/parity/rc-recorder/rc-parity.test.ts`. Data: `test/fixtures/rc-recorder/`. Notes:
`.notes/m2-contract-rc-parity.md`.

## How the fixtures were recorded

- The eleven cases come from Bunraku's `tools/rc-recorder` at `702d8120` and are copied byte for byte.
- Each `fixtures/<case>.json` holds RoleCall's `PromptAssemblyInput`, plus the database rows a
  fail-closed Supabase double answered with (character, persona, preset, preset prompts).
  `stPreset` is the SillyTavern file RoleCall imported into those preset rows.
- `recorded/<case>.json` is what `assemblePrompt` returned. It was run under RoleCall's own vitest in
  a VAUDEVILLE worktree **pinned at `68afe385987811c4c1b8594013b27e75bebbe8f2`**. The clock,
  `Math.random` and `randomUUID` were frozen per case, and every case ran 15 times with identical
  output.
- Moving the pin means re-recording in Bunraku and reviewing every changed output as a RoleCall
  behaviour change.

## How the test compares

`convert.ts` turns RoleCall's rows into the core's inputs. This is test-only code; `src/` never
reads RoleCall rows.

- **Character row → `Character`.** RoleCall's own card depth notes (`details.prompt_depth_injections`)
  use RoleCall depth, so they go through `fromRcDepth` (D-12, D-47).
- **Persona row → `Persona`.** The description is the XML RoleCall sends (a port of
  `generatePersonaXml`). The test checks it against `recorded.personaXml`.
- **Preset rows → the file RoleCall's export route writes.** That is ST grammar plus
  `extensions.rolecall`, read by the core's own importer (`stPresetToPreset`) under RoleCall's
  rules (D-71): in-chat depth +1, lore and persona always on, `{{message_history}}` read as the chat.
  The request's `promptEnabledStates` go into the export's `prompt_order`.
  - The route's default template formats are left out: the rows carry none. A real RoleCall export
    always writes them; the importer keeps an RC export's `wi_format`, `personality_format`,
    `scenario_format`, `new_chat_prompt` and `new_example_chat_prompt` in extras, unapplied
    (warning `rc_formats`), because RoleCall never applies them.
  - A disabled `personaDescription` marker stays disabled: RoleCall's loader only sees enabled
    prompts and adds its persona block right after `main` (else after `jailbreak`), and so does the
    importer. The lore markers are still revived in place; RoleCall's structural lore placement is
    not covered (no case has a lorebook).
- **The ST file (`stPreset`)** is also read through the same importer under ST's rules. This
  "ST reading" shows what changes when a user imports the original file instead of RoleCall's
  export.
- **No preset → RoleCall's synthesised default set** (`synthesizeDefaultPresetPrompts`) as
  core.preset/1.

`run.ts` builds the rest of the input and runs the pipeline:

- **Path:** a `PathView` of the messages. The greeting has its identity macros expanded, as the
  engine stores greetings.
- **Fixed inputs:** the fixture's seed and clock; no lorebooks (no case has one).
- **Window and reply reserve:** RoleCall's `contextLimit`/`maxResponseTokens` when it ran a budget,
  otherwise 1 000 000/8192. Tokens are counted with `CHARS_COUNTER` so the pinned trim points stay
  put; the budget cases repeat their rule checks under `O200K_COUNTER`.
- **Pipeline:** `assemble`, then `shape` with the preset's post-processing. The result is flattened
  to `{role, content}`, the form of `conversationHistory`.
- **Not compared:** `messagesTrimmed`, `budgetReport`, `reads` and `timing` describe RoleCall
  internals.

## Exact parity

- **02** (no preset, persona, history) and **09** (a preset with only `main`): whole request equal.
- **All cases:**
  - persona XML;
  - samplers, reply cap and post-processing of every preset;
  - no macro state written (RoleCall `writes: []`, core `varsDiff: {}`).
- **08:** the whole request once RoleCall's appends are set aside (top and bottom pins in
  `injection_order`), and the preset prefill (raw).
- **11:** the prefill. RoleCall returns it raw and its worker expands it just before sending; the core
  expands it once, to the same text.
- **07:** text around an inline `{{message_history}}`, request-time toggles, in-chat depths 0 and 2
  read from the RoleCall export, and ordering by `injection_order`.

## Deviations

| ID | Case | What differs | Why it is intentional | How the test normalises it |
|---|---|---|---|---|
| RC-1 | 01 | RoleCall drops the card's example dialogue with no preset: its default set writes `{{mes_example}}`, which its macro engine does not know (it has `{{mesExamples}}`), so the macro is stripped. The core sends the examples after the scenario. | §10.4: unknown macros stay literal, and `{{mes_example}}` is a core alias. §19.3 "Не переносить: вырезание неизвестных макросов". | Expected = recording with the examples row inserted after the scenario. |
| RC-2 | 01, 02 | With no preset the core uses `BUILTIN_PRESET`, which adds its main prompt (card `system_prompt` override) above RoleCall's layout. | §10.2 "Раскладка по умолчанию", D-21. The parity runs use RoleCall's own default set. | `BUILTIN_PRESET` rows = main prompt + the RoleCall-set rows. |
| RC-3 | 03, 04, 11 | Different history kept. RoleCall runs three passes: a loose pre-trim (`max(60 %, window − 2048)`), a budget pass that reserves only some sections, and a final pass on chars/4 dropping one message at a time. It keeps turns 7 / 22 / 5 onward. The core makes one cut on an 8-message grid anchored at the oldest message, measured conservatively, and keeps no turn / turns 25 / 9 onward under chars/3. Under o200k, the default counter, it keeps turns 9 / all / 9 onward. | §11, D-49 (whole chunks so the cached prefix survives), §19.3 "Не переносить": the 60 % pre-trim, the reserve for the unsent character prompt. | Frame (all system messages) equal. On both sides the greeting plus a contiguous tail ending at the current message, with both start points pinned (the core's under chars/3). Under both counters, the core's cut is on the grid and its request fits `window − reserve`. With the window opened up, the core sends RoleCall's frame plus the whole chat. |
| RC-4 | 05 | A card depth note alone exceeds the window. RoleCall drops all history and the greeting and still sends over the cap (it reports 100 %). The core refuses with `context_length_exceeded` and sends nothing. | §11: a mandatory part that does not fit is refused, never sent over the cap. | Refusal asserted. With an open window, RoleCall's frame is asserted, and its depth-2 note lands with 3 chat messages after it (`fromRcDepth`). |
| RC-5 | 06 | RoleCall sends no example dialogue under a preset: it had no fill for the `dialogueExamples` marker at the pin (added later, at `fb8dc623e`, as the raw `{{mesExamples}}`). The core fills the slot with the raw example text, `<START>` lines included. An RC export's `new_example_chat_prompt` and `new_chat_prompt` ride extras unapplied (warning `rc_formats`): RoleCall never applies them. | §10.2 marker slots; D-71 (mixed): an RC export behaves like RoleCall. | Expected = recording with the raw examples row inserted after the persona. |
| RC-6 | 07 | An in-chat prompt deeper than the chat (depth 10 of 6) lands below the greeting in RoleCall, because it injects into the history after the greeting. The core puts it above the greeting, the first chat message. | §10.1 "d ≥ count — перед первым" (ST's rule). | The overflow row is moved above the greeting; the rest is equal. |
| RC-7 | 07, ST reading | The ST file RoleCall imported has ST depths, but RoleCall reads them as RoleCall depths. The core reads the file 1:1, so each in-chat block sits one chat message lower than in RoleCall. | D-12 (ST convention), D-47 (`fromRcDepth` only for RoleCall exports). | Each block has exactly its file depth of chat messages after it, one fewer than in the RoleCall-export reading. Nothing else moves. |
| RC-8 | 08 | RoleCall glues append blocks (`injection_position` 2) onto the d-th last chat message of their role. The core has no append placement; the importer imports them disabled (relative, placement kept in extras), with a warning (`rc_append`), so nothing that reads as chat is sent. | §10.2 placements, §19.3 "08 — append". | Strips `\nAPPEND-…` from RoleCall's messages. The pins (`injection_position` 4 / 3) import as `top` / `bottom` blocks in `injection_order` and are compared in order. |
| RC-9 | 09, ST reading | A preset without a `personaDescription` marker sends no persona when read as an ST file. RoleCall, and the core reading RoleCall's export, add one after `main`. | D-71 (mixed): ST presets behave like ST. | ST reading = RoleCall-export reading minus the persona row. |
| RC-10 | 10 | RoleCall's toggle macros `{{enabled::id}}` and `{{when_enabled::id::text}}` expand in RoleCall. The core sends them literally and lists them in `trace.macros.unknown`. The toggles themselves (blocks on and off, request overrides) match. | §10.4 closed macro table; unknown macros stay literal. §19.3 "10 — toggle-макросы RC". | The `main` row is compared with its raw text; the rest is equal. |

## Open

- **Not ported here.** Bunraku's `macro-corpus.json` (macro parity, D-43) and new recordings from
  VAUDEVILLE (§14 "дополняются нашими записями").

## Tool calls (M3)

The tool-call code of M3 (`src/tools/prompted.ts`, `args.ts`, `leaks.ts` recovery, `run.ts`) is
compared with RoleCall's on a corpus of inputs. Suite: `test/parity/rc-tools/rc-tools-parity.test.ts`.
Data: `test/parity/rc-tools/corpus.json` (121 rows). Harness: `test/parity/rc-tools/run.ts`.

### How the corpus was recorded

- **Inputs.** Every input of RoleCall's own tests for these modules, with `source` = test file and
  line at `fb8dc623e` (`prompted-tool-calls/__tests__/*`, `tool-call-repair/__tests__/repair.test.ts`,
  `__tests__/vvs-728-dsml-tool-call-normalization.test.ts`, `narrator-engine/__tests__/content-tool-salvage.test.ts`,
  `narrator-engine/__tests__/tool-executor-repair.test.ts`), plus inputs marked `added` that show a
  difference RoleCall's tests do not reach. RoleCall's layer-2 cases that call `schemaRepair` on an
  object are sent through the whole pipeline as JSON text; the two root-level array schemas are
  moved one level down (rp-core's tool schemas are flat objects); DeepSeek case 9 repeats the opener
  200 times instead of 20 000.
- **RoleCall's outputs** (`rc`) were recorded by running RoleCall's own modules at `fb8dc623e` under
  Bun 1.3.14: `ai/prompted-tool-calls/index.ts`, `ai/tool-call-repair/*`, `ai/dsml-tool-calls.ts`,
  `ai/narrator-engine/content-tool-salvage.ts`, `ai/narrator-engine/tool-executor.ts`, copied
  unchanged except for the `server-only` import (dropped), `@/` paths and host-only type imports, with
  jsonrepair 3.14.0 (the version RoleCall's lockfile resolves and rp-core pins). Three host steps are
  written out from the source: the DSML gate of `inference-engine.ts` 5871–5881 (DeepSeek model
  names only; the content is always the DSML-stripped one), the result framing of `btw/loop.ts`
  625–631, and the streaming carry the btw loop never flushes (`btw/loop.ts` 1403–1415). Every
  RoleCall test assertion on these inputs holds on the recorded outputs.
- **rp-core's outputs** (`core`) come from the same harness the test runs. Moving either side means
  re-recording and reviewing every changed row.

### How the test compares

Each row's output is reduced to a plain shape on both sides:

- **parse:** per block `{name, args, error}`. rp-core's parser leaves the arguments as text and checks
  them when the call runs, so the harness runs `parseToolArgs` against the row's schema; `error` is
  "the block or its arguments failed" on both sides, `args` is `{}` then. RoleCall's synthetic ids
  (`pcall_<name>_<i>_<djb2>`) are not compared: the loop assigns ids (§8.3).
- **strip:** the text. **stream:** everything the user would have seen, char by char (RoleCall: the
  visible parts, the final carry never shown; rp-core: every `push` and `end()`).
- **args:** `{ok, args}`; error texts are compared in the executor rows. **executor:** whether the
  tool ran, with which arguments, and the message of a failed call.
- **dsml / salvage:** the visible content and the recovered calls with parsed arguments. rp-core's
  content is `stripToolCallLeaks(recoverLeaks(…).text)`, the text a turn commits.
- **frame / catalog:** the text.

A row without a deviation must be equal on both sides; a row with one must differ, and its TD is
listed below. 64 rows are equal, 57 differ.

### Exact parity

- The documented envelope, the attribute form (single or double quotes, other attributes, an
  `args` key nested in it), self-closing named tags, a fence inside the tags with a `json` prefix,
  several blocks among prose, loose JSON repaired, an unreadable or empty block reported, no blocks.
- The fence rule: both fences or neither, same character, the closer at least as long; a code block
  before or after the call kept; an unclosed opening fence kept; each call's own fence taken.
- Argument repair: the six jsonrepair cases, the lossless coercions ("75" → 75, "42" → 42, "true" →
  true, "null" → null in a nullable slot, nested objects), the size limit, `""` / whitespace / `"null"`
  → `{}`, a one-object array root unwrapped, the four template markers, a `<` inside a valid value,
  Gemini's `""` / `"null"` / `"none"` → `[]` in array slots (nullable ones → null), the Cyrillic
  murkapie payload, a number for an array of strings → `["42"]`.
- The executor's repaired call (`{"amount": 2,}` runs with `{amount: 2}`).
- DSML cases 1–5: the V4 response, compact ASCII prefixes with prose kept, literal `|DSML|` in prose
  and values, the V3.2 `function_calls` container, no double execution next to native calls.
- All eight salvage cases.

### Deviations

| ID | Rows | What differs | Why it is intentional |
|---|---|---|---|
| TD-1 | P-16, P-17 | RoleCall reads only `args` from the envelope: `{"name": …, "arguments": {…}}` gets `{}`, then layer 2 fills required fields with type defaults, so the call RUNS with invented values (`{query: ""}`); `"args": null` fails the envelope. rp-core reads `args`, `arguments`, `parameters` (then `params`, `input`, OpenAI's `function`), and null is no arguments. | §8.3 "терпимый парсер принимает `arguments`"; §9.1 never invents values. A RoleCall bug worth reporting upstream. |
| TD-2 | P-04, P-22 | RoleCall flags a block without `</tool_call>` and its btw loop never runs it (its DM round does); a block left open before the next one swallows it. rp-core accepts an unclosed block when the JSON inside is complete, at the end of the text or before the next opener. A block left empty and ended by the next block's opener (a `<tool_call>` around a name tag, a name tag around a `<tool_call>`, an opener written twice) is a wrapper: removed as markup like a stray closer, no call. When the body opens with a complete call value (a JSON value that parses, or a whole python call) and goes on with prose, the block ends after the value and the prose stays in the text; more values after a comma are more calls of the block, and punctuation the call left behind (an extra `}`, the `]` of a list, a trailing `,`) goes with it. A value that never closes, or a tail that could be more of the call (`{`; `[` before `{`, `[` or `name(`; `</` or a tool tag's name, an offered tool's among them, D-97: `<search_hi` cut off by the end of the text, like `<tool_ca`; `name(`), is still a cut-off call and nothing of it is shown; `[OOC: …]`, `<i>` and `<br>` after the value are prose. (No corpus row changes: RoleCall has no case with prose after an unclosed block, or with an empty block before the next one.) | §8.3 "незакрытый тег на EOF". With `<tool_result` as the stop sequence, "stopped right after the JSON" is common; a model that forgets the closer and goes on with the story must not lose the story (the wire keeps it, so the model would think the user read it). |
| TD-3 | P-13, P-18, P-19 | RoleCall skips `<tool_calls>` and keeps only the first call of an array or NDJSON body (layer 2's silent unwrap). rp-core reads a `<tool_calls>` container, an array, NDJSON and `{"tool_calls": […]}` as one block per call. | No silent drops (§9.1); the prompted contract (`parsePromptedCalls`). |
| TD-4 | P-20 | RoleCall's python pre-pass drops the function name, so `search_history(query="…")` as a body has no name. rp-core names the call after the function. | The model said which tool; losing it turns a valid call into an error. |
| TD-5 | S-01, S-02, S-04, S-07…S-12, S-18, T-01 | RoleCall leaves the whitespace around a removed block as it was (`"Let me look.\n\ndone"`, three or four newlines after a fenced call, two spaces between words). rp-core repairs the seam with tools/leaks.ts's rule: one side's spaces within a line, at most one blank line across lines, whitespace a removal leaves at the start or end of the text dropped. | One seam rule for every kind of removed markup (M1b, D-57); the stored text is prose. |
| TD-6 | S-14, T-04 | Two calls sharing one fence leave an empty fenced block in RoleCall; its stream never widens over fences at all (`` ``````Found `` live, a clean text stored). rp-core treats a run of blocks with only whitespace between them as one removal sharing one fence, and the stream applies exactly the batch rule (its output equals the stored text for every chunking). | §8.3 "в стриме тот же fence, что при сохранении". |
| TD-7 | T-03, T-05 | RoleCall's streaming carry is never flushed: a reply ending in `<tool_c` or `<tool` never shows it. rp-core's stripper has `end()`; it also holds trailing whitespace until the next text (a seam may still change it). | The live text must equal the stored one. |
| TD-8 | S-15, S-16 | RoleCall leaves a stray `</tool_call>` and a `<tool_result>` the model wrote itself in the text. rp-core removes stray closers (an offered tool's `</search_history>` among them, D-97, and a wrapper's closer after its call, TD-2), and everything from a hallucinated `<tool_result` on (no call after it is read). | `<tool_result` is the stop sequence (§8.3): text after it is the model inventing results. |
| TD-9 | P-21, S-17 | RoleCall matches `<tool_call` case-sensitively, with no whitespace after `<`, and only the exact `</tool_call>` closer, so `</tool_call >` swallows the rest of the reply. rp-core matches like tools/leaks.ts: any case, whitespace inside the tags. | Nothing tools/leaks.ts strips should be stripped without being read as a call. |
| TD-10 | C-01, C-02, C-03 | RoleCall's catalog fences its own example while telling the model not to use fences, says extra fields are ignored, invites thinking out loud between blocks, and carries agent rules (consult/tool_search, "final answer", "COMPLETE callable set"); it shows only a description's first line and `(no arguments — pass {} or omit args)`; with no tools it renders a "disabled" notice. rp-core's core block: an RP protocol (look things up first, never guess names or quotes, never mention tools in the story, search by roots), the example unfenced, the whole description, limits (`from 1 to 20`, `at most 200 characters`), array item types; no block at all without tools. | §7.1, §8.3, scratch note m3-port-rc-tools.md §1.4; a changing "disabled" block would break the cached prefix. |
| TD-11 | X-01 | RoleCall frames a result as `<tool_result name="x">…</tool_result>`, unescaped. rp-core adds the call id and writes `</tool_result` inside a result as `<\/tool_result`. | §8.3 `<tool_result name id>`; a result quoting the closer must not break the frame. |
| TD-12 | D-06…D-10 | RoleCall recovers DSML only when the response's model name matches `/deepseek/i`, and leaves an unterminated or invalid block visible. rp-core recovers whenever the named tools were offered (any model), never otherwise, and a block it cannot recover is stripped from the text (tools/leaks.ts, M1b). | No model-id regexes (§8.2); D-57 strips what is not a call. |
| TD-13 | V-09, V-10, V-11 | RoleCall's salvage leaves the JSON in the visible text, keeps the known calls of a value that also names unknown ones, and dedupes by the arguments string. rp-core removes a salvaged value from the text, takes a value only when every call in it names an offered tool, and dedupes by canonical arguments. | The text a turn commits must not carry the call; removing a value with other content in it would lose that content. |
| TD-14 | R-12, R-43, R-44 | RoleCall fills a missing required field with a type default (`""`, 0, false, `enum[0]`) and turns `"null"` in a non-nullable boolean or number slot into false / 0, `null` in a string slot into `""`. rp-core reports these as errors. | §9.1 "недостающие обязательные значения не выдумываются". |
| TD-15 | R-11, R-14 | RoleCall drops unknown keys under `additionalProperties: false`, array items it cannot repair, and optional fields of the wrong type. rp-core reports each by name. | §9.1, D-56: nothing is dropped silently; Bunraku's own tools refuse an unknown argument by name. |
| TD-16 | R-13, R-25 | RoleCall wraps a lone object into a one-item array and unwraps `[a, b]` at the root keeping `a`. rp-core wraps only scalars and unwraps only a one-object array; the rest are errors. | D-56 step 6 (one object) and step 7 (scalars). |
| TD-17 | R-37…R-42 | RoleCall does not enforce `enum` or any length, truncates `"4.7"` to 4 for an integer, joins an array into `"a, b"` and flattens an object into `"k: v"` for a string slot. rp-core enforces enum, minLength/maxLength (code points), minItems/maxItems and exclusive bounds, and makes no lossy coercion. | D-56 step 8; lossy coercions change what the model asked for. |
| TD-18 | — | RoleCall's layer 1 falls back to its schema-parser (and repairs its three DeepSeek captures), and its pipeline can re-call the model (layer 4). rp-core has neither; the error result sent back is the retry. (no corpus row: RoleCall's outputs here need the retry callback or the schema-parser captures, which are not ported) | §19.5: schema-parser and tokenizer not taken; the loop is the retry (§9.1). |
| TD-19 | R-45, R-46, E-02 | RoleCall checks for empty arguments before cutting template markers (`</tool_call>` alone fails), and its python pre-pass rewrites `k = v` inside string values (`query="x y = z"` fails). rp-core checks again after the cut and leaves strings alone. Error text: RoleCall `Invalid arguments for x (kind): $: expected type "object", got string. Re-emit one complete JSON object matching the tool schema.`; rp-core `Invalid arguments for x: the arguments are text, not a JSON object. Send one complete JSON object that matches the schema.` | D-56 order; the error is read by the model, so it is in plain words. |
| TD-20 | E-03, E-04 | Unknown tool: RoleCall `Unknown tool: nope`; rp-core `Unknown tool "nope". The tools you can call: lookup.` A tool that throws: RoleCall `Execution error: …`; rp-core `Tool lookup failed: …`. | The model gets the list it can choose from (Bunraku's refusal did the same). |
| TD-21 | — | RoleCall reads only `<tool_call>`: a reply that writes an offered tool's name as a tag (`<search_history>брат</search_history>`) runs nothing and shows the markup, a made-up result inside it included. rp-core reads it as one call of that tool (D-97), in prompted rounds and in a native round's fallback: a JSON object inside is the arguments (or their `{"name", "args"}` envelope), plain text is the tool's one required string argument, an empty closed body is a call without arguments for every tool (the tool's own check answers), anything else is an error result; the tag is matched in any case, with attributes or an XML prefix, closed or not, and stripped live and from the stored text like a `<tool_call>` block. Left unclosed, a JSON body ends after its object; a body of text, read after a leading `json` word, ends with its first line when more text follows; a fence opened inside the tags ends with its closing fence line; a fence that never closes runs to the end of the text (or the next block's opener). After a body of text, a call-family tag cut off by the end of the text goes with the block and the text stays the argument; left empty before the next block's opener, the tag is a wrapper (TD-2). Names that are not offered are never tags, so prose tags stay and a turn without tools is unchanged. (no corpus row: RoleCall has no such case) | The second live run (.notes/m3-decisions.md L): a small local model reached for the tool's name as a tag once the reminder named it. A future tool with an everyday name (`roll`, `note`) would make that word a tag in prose; the v1 tools all contain `_`. |

### Not compared

- RoleCall's retry tests (6) and its DeepSeek probes (2, they only log): see TD-18 and
  `test/tools-parse/args.test.ts`, which pins rp-core's outcome on the DeepSeek pattern.
- DSML case 10 (RoleCall's TV tool loop, host code) and RoleCall's ids.
- Search (`btw/scene-search.ts`, `search_lorebook`): the builtins' own parity notes.
