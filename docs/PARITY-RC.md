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
