# Contract notes — assemble agent (src/prompt/assemble.ts, src/prompt/assemble/)

No contract signature changed. Decisions the contract left open, and points for other agents:

## Behaviour the engine can rely on

1. **Chat message src.** Every chat message (greeting included) has `src: 'history'` (`HISTORY_SRC`), no
   `placement`. A preset block whose id is `history` or starts with `history:` is sent as `block:<id>`
   (`blockSrc`), so `shape.findContinueTarget` never mistakes preset text for the continue target. The
   builtin history block is id `history`, but it is exactly `{{history}}`, so it emits nothing itself.
2. **Placement.** Leading system run of `top` + before-history blocks → `'head'`; every other preset,
   `new_chat` and depth-insert message → `'inline'`; chat messages → none.
3. **`upTo` not on the path throws** `Error('assemble: upTo … is not on the active path')`: a caller bug,
   and the result union has no code for it. A hidden `upTo` is still included (it is the turn's subject);
   other hidden messages and messages without text are skipped.
4. **Continue returns `tools: []`** whatever `input.tools` holds (§6.4, §7.1 `narrate`), prefill null.
5. **Notices are emitted on every call.** "Once per session" (D-28) is the engine's dedup.
   `history_crowded` (D-89) is NOT emitted here: §19.7 gives it to `agents/compendium/profile.ts` (M5c).
6. **`window` / `reserve` are used as given.** assemble does not re-apply `preset.context.maxContext`;
   the engine should pass `contextWindow({caps, local, preset, configWindow})`.
7. **Prefill.** Expanded before the D-28 checks, so a `{{setvar}}` in a prefill lands in `varsDiff` even
   when the prefill is not sent. A sent prefill counts as mandatory in the budget (+4 overhead), but
   `trace.tokens.estimated` is `estimateMessages(messages)` only, as specified. Not trimmed.
8. **Error codes.** `preset_invalid` messages are `path: message; …` from `validatePreset`, or a layout
   reason. `context_length_exceeded` message carries token counts only, never prompt text.
9. **Extra exports:** `presetHash(preset)` (sha256 of canonical JSON with sorted keys, 16 hex — use it
   for `Generation.preset.hash` too), `HISTORY_SRC`, `blockSrc`, `guidanceText`, `REJECTED_DRAFT_LABEL`.
   Helpers in `src/prompt/assemble/{slots,guidance,hash,chat}.ts`.

## Layout rules decided here

10. **History block.** Exactly one `{{history}}` slot at the top level (not inside another macro's
    argument) of an enabled block, and that block must be `at: 'relative'`; otherwise `preset_invalid`.
    Text around the slot becomes a message before and after the chat area (Bunraku's marker split). The
    history block is never overridden (a card text without `{{original}}` would delete the chat).
11. **Slots are found in the raw text** with the macro lexer, then swapped for noncharacter sentinels
    (U+FDD0/U+FDD1) before the single `run.block()` call, so an escaped `\{{lore::x}}`, a slot tag inside a
    card field, or one nested in a macro argument stays literal (contract-macros.md point 1). Numbering is
    global per run, so sentinels carried through `{{original}}` stay correct. Non-history slot values come
    from `slotValue()` in assemble.ts: all `''` in M1a — **M2 (lore), M4 (`slot::director`), M5 (`recap`)
    fill it there**; `renderSlot` already applies `formats.wi` to non-empty lore/outlet values.
12. **Formats (D-70).** `personality` / `scenario`: applied only to a block whose whole text is that one
    macro (the ST marker form), when the card field is non-empty; `{0}` becomes the macro, so ST-style
    formats that say `{{personality}}` themselves also work. `newChat`: a system message `src 'new_chat'`
    opening the chat area (mandatory, not a chat message for depth). `newExampleChat`: rewrites the
    examples value (each `<START>` chunk headed by the line, missing first `<START>` implied as in ST) for
    every `{{examples}}`; ST chat-completion makes separate messages instead — named deviation.
13. **Author's note** is sent as written (ST), without RoleCall/Bunraku's `[Author's Note: …]` wrapper.
    Card depth note and author's note expand via `run.block(text, 'card_depth' | 'author_note')`, default
    order 100. Expansion order: preset blocks (preset order) → new_chat → card_depth → author_note →
    prefill; history only through `run.userText` (no side effects).
14. **Guidance (D-41).** One system block, depth 0, src `guidance`. Direction through `run.userText`,
    clipped to 10 000 code points; rejected draft (inert) clipped to 2 000 code points including a `…`,
    labelled and fenced with a backtick fence longer than any run inside it. Blank guidance → no block.
    Wording without a draft drops the references to one.
15. **Messages keep their text blocks separate** (tool rounds give several); reasoning/tool blocks dropped.

## Problems in other contracts (worked around)

- **validatePreset vs the macro engine on `{{history}}`.** validatePreset counts the exact substring
  `{{history}}`: it rejects `{{ History }}` (which the engine treats as the slot) and counts an escaped
  `\{{history}}` as a second slot. assemble re-checks with the lexer (`historySlots` in
  `src/prompt/assemble/slots.ts`); formats could reuse it so both agree.
- `AssembleInput` has no `swipe.showRejected`; the engine must pass `guidance.rejected` only when it is on.
