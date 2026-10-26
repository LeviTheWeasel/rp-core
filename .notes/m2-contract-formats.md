# M2 contract notes — formats agent

## Changes inside my files that others rely on

1. **`validatePreset` now also requires the `{{history}}` block to be placed `'relative'`** (native.ts,
   validator body). Error: `{ path: 'blocks[i].at', message: "the {{history}} block must be placed 'relative'" }`.
   assemble's `planPreset` check is now unreachable through `assemble()` (validatePreset runs first) but
   harmless; `test/assemble/assemble.test.ts` still matches (`/must be placed 'relative'/`). The engine's
   `admit.ts` preset loading gets the same refusal earlier. `test/formats/native.test.ts` updated.
2. **`detect()`**: an ST instruct or context template (settings export without any chat-completion field)
   is now `{ kind: 'unknown', reason: 'this is a SillyTavern instruct template (text completion), …' }`
   instead of `st_preset` (new `textCompletionTemplateKind` in kind-markers.ts).
3. **`importFile`** no longer throws `unsupported_until_m2` (the code stays in the union, contract-fixed).
   `wrong_kind` messages read `"<file>: expected a preset, but this is a character card"`.
   `expect: 'lorebook'` on a card without a book → `wrong_kind` ("… has no embedded lorebook").
   Book-from-card warnings are filtered to the book's own (paths under `character_book(s)`, plus
   `books_merged` / `repaired_json` / `chunk_unreadable`).

## For the CLI / REPL owner (src/cli/commands.ts, repl.ts)

- `importFile` returns the `ImportResult` union; `rp-core import` should print `r.kind` (character /
  preset / lorebook) and the warnings. `/lore add <file>` → `importFile(home, file, { expect: 'lorebook' })`;
  a preset command → `{ expect: 'preset' }`; `new --card` already uses `importCard`.
- Preset import warnings can be many on big presets; codes are stable (list below), folded per block field
  (`path: 'prompts[*].injection_trigger'`, message ends with `(N blocks)`).

## Preset shape produced by `stPresetToPreset` (for assemble / integrate)

- `forbid_overrides` is mapped **per block**: a main/jailbreak prompt with `forbid_overrides: true` gets no
  `override` (and `extras.forbid_overrides: true`). `Preset.forbidOverrides` is never set by the importer —
  ST's flag is per prompt, and a preset-wide flag would also lock the other block.
- In-chat blocks: `at: { depth }` plus `order` only when the file has `injection_order` (absent → depth.ts
  default 100, ST's DEFAULT_ORDER). Missing depth → 4 (ST DEFAULT_DEPTH). RC exports: `fromRcDepth`.
- Marker blocks may sit in-chat (ST lets charDescription etc. carry injection_position 1); only the history
  block is forced relative. assemble already fills slots in depth blocks like anywhere else.
- ST "off" sampler values are imported as written (`top_k: 0`, `top_a: 0`, `min_p: 0`,
  `repetition_penalty: 1`, `frequency_penalty: 0`); seed −1 is dropped. Whether to send them is the
  adapter's/caps' call (openai-chat sends by `caps.samplers.accepted`).
- `context.maxContext` comes from `openai_max_context`: ST's Default.json says **4095**, so a session on
  the imported Default is capped at 4095 tokens (§10.2 "may only reduce the window"). Worth a notice in
  the REPL / demo.
- `formats` keep `''` values (present stays present); `prefill` and impersonation texts drop when blank.
- Block `extras` keys: `forbid_overrides`, `injection_trigger`, `injection_position` (unknown value),
  `role` (unknown role), `content` (marker's own text, or non-string content), unknown prompt fields.
  Preset `extras`: `prompt_order` (other characters' orders, verbatim), `extensions` (whole object),
  every non-honoured setting, invalid raw values. Connection fields and secrets are never kept.
- Synthesised block ids: `chatHistory` (missing history), RC exports `loreBefore`, `loreAfter`,
  `personaInjection`. Duplicate ids are suffixed `-2`, `-3` (wire.ts `uniqueIds`).
- RC exports: `{{random}}` numeric forms become lists of up to 101 values
  (`{{random::0::1::…::100}}`), so the macro engine sees long argument lists.
- Big presets: Paramnesia VI RC imports to a 2 MB library file (148 regex scripts and the readme ride
  extras). §5.2 reads presets every turn: a 2 MB JSON.parse per turn is ~10 ms; if that matters, the
  loader could cache by mtime.

## Warning codes (preset)

`invalid_value`, `unknown_field`, `not_honoured`, `no_prompts`, `no_global_order`, `missing_prompt`,
`default_prompt`, `duplicate_prompt`, `duplicate_order_entry`, `unknown_marker`, `marker_content`,
`marker_disabled`, `slot_escaped`, `unknown_position`, `history_synthesised`, `history_enabled`,
`history_relative`, `history_macro`, `rc_export`, `rc_forced_on`, `rc_synthesised`, `rc_random_range`;
`importFile` adds `repaired_json`.

## Nothing needed from other agents' files

No contract change requested. The importer imports read-only from `src/prompt/depth.ts` (`fromRcDepth`)
and `src/prompt/assemble/slots.ts` (`historySlots`, `topSlots`), the same finder validatePreset uses.
