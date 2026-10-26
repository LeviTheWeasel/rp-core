# M2 contract notes — fix (the reviewed and verified M2 findings)

State at hand-over: `bunx tsc --noEmit -p .` clean, `bun test` green (about 2030 pass, 1 skip), the
purity test green. Every finding got a fix at the root and a regression test that fails without it
(checked by reverting the fix for the lore-why, EMA and memo ones). Below: every contract change
and why, the readings taken, and what is left open.

## Contract changes (all additive unless said)

1. **Book-level `scan_depth` / `recursive_scanning` of a card book or WI file are no longer mapped**
   to `LoreBook.scanDepth` / `recursive` (formats/st-worldinfo.ts). They ride `extras`, with one
   `not_honoured` warning when they differ from ST's globals (2 / on). Why: SillyTavern never reads
   them (convertCharacterBook copies entries only; world_info_depth and world_info_recursive are
   global); the user's Wymare cards (scan_depth 100, recursive_scanning false) scanned 100 messages
   with recursion off. Native core.lorebook files still set scanDepth / recursive. This replaces an
   unexamined M1a mapping (test/formats/worldinfo.test.ts, card.test.ts, formats-m2/import.test.ts
   updated).
2. **Lore timers (lore/timers.ts, session/view.ts, session/fold.ts):**
   - `PathView['fires'][n]` gains `continued?: true` (a continue edit's fires) and
     `names?: Record<string,string>` (the trace's book names); `PathView.continued?: ReadonlySet<string>`
     (path messages with a continue edit).
   - `pathFires`: a continue's fires sit at the message index **+ 1** (the chat length its scan ran
     at, as ST's continue chat holds the message). `timerState`'s "at >= chatLength is ignored" then
     reproduces ST's "chat not advanced" drop for a second continue. Supersedes lore note "Readings"
     9, third bullet.
   - New `pathScans(view, upTo)`: the chat lengths of the scans on the path (every non-greeting
     answer at its index, every continued message at index + 1). `timerState(fires, chatLength,
     scans?)` takes them; `cooldownLeft` after a sticky window starts at the first scan at or after
     L + S (ST re-arms the cooldown in onEnded.sticky), the turn being built included. Without
     `scans` (a direct caller) every chat length counts as a scan, i.e. the old arithmetic.
     Supersedes lore note "Readings" 9, second bullet. `LoreRunInput.scans?` passes them through.
   - `PastFire.name?`: the book's name from the trace. runAssembleLore aliases past fires by name
     (`aliasFires`): a fire whose source key is not read now follows its book name to the source read
     under that name ('@card' ↔ a library id, harbor ↔ harbor-2), as ST keys timed effects by world
     name. `'@card'` / `'@persona'` fires of traces without names fall back to the cast's own book
     names (`LoreRequest.ownBooks?`). A library id from an old trace without names whose book is no
     longer read cannot be aliased (nothing records its name).
3. **`Trace.loreNames?: Record<string,string>`** (source key → trimmed book name, next to
   loreHashes) and **`Trace.lore.unsent?: Record<string,string>`** (entry label → the slot it needed,
   for entries that fired but that nothing in the request took). Both optional; old traces lack them.
4. **`Trace.tokens.estimated` includes the prefill** the request carried (a preset prefill, or on a
   continue the whole answer so far), counted like one more message; `blocks` stays 1:1 with the
   messages. `traceForSent(trace, messages, prefill?)` gained the optional argument; turn.ts (prep,
   commit, the server-truncation check) and session.ts (preview) pass it. Why: the server counts the
   prefill as prompt, so every continue taught the EMA a ratio > 1 (D-50 bias). M2 traces written
   before this sample slightly low; harmless (one sample, α 0.3).
5. **Lore engine (lore/engine.ts):**
   - Gather: the persona's and the card's book each sorted on its own, then **all session books as one
     group** sorted by order (ST's getSortedEntries merges global worlds before sorting). 'lore.prob'
     draw indices follow the new gather order, so `/trace` / `/preview --turn` verdicts recomputed for
     earlier turns of a session with several books can differ from what that turn rolled.
   - Budget: per-entry counts decide far from the budget (one count per entry); within
     `BUDGET_SLACK` (3 tokens per estimated entry) of it the joined text is counted exactly, so the
     cut stays exact (golden 04's 250) and the cost is linear. `used` is still the exact count. The
     test "a non-additive counter is applied to the whole text" became "the counter decides near the
     budget": a counter whose joined text differs from the sum by more than the slack is not supported.
   - `budget-cut` detail: `cost` = the marginal cost the check used (`count(next) − used`, separator
     included), `left` = `budget − used − 1` (the most an entry could add; the check is strict). For
     entries skipped after the overflow, cost stays their raw tokens.
   - A group loser looked at again in a recursion loop that matches the chat text alone is a 'key' /
     'secondary' fire, not 'recursion'.
   - `LoreVerdict.detail.recursionLimit?: number`: an entry the recursion text would have woken
     after the last allowed loop keeps 'no-key-match' (D-45's vocabulary unchanged) with this detail;
     /lore test says "recursion would wake it, but it stops after 3 loops" and does not fold it away.
6. **Depth order (prompt/depth.ts, lore/place.ts):** `SOURCE_RANK` is now preset < author_note <
   card_depth < lore < compendium < director < guidance, and lore depth inserts carry no order of
   their own (ST's order-100 extension group; an entry's order only sorts the lore, in place.ts's
   output order). Matches openai.js populationInjectionPrompts + getExtensionPrompt key order. The
   golden G-3 normaliser no longer re-sorts, so case 06 checks the order.
7. **Assemble budget (prompt/assemble.ts, §11):** the greeting is dropped as the **last resort**
   before a refusal (retry of trimHistory with protectedHead 0; trace.trimmed then starts at the
   greeting; notice `greeting_dropped`). The refusal message names the parts (preset blocks with the
   lore in them and the lore budget, in-chat inserts, prefill and cues, the current message, the
   greeting already left out). `fixed` now also counts the continue cue (prefill 'none') and the
   'strict' placeholder that shape() adds. New notice `lore_unsent`.
8. **`{{outlet::x}}` resolves outside a preset block's own slots** (prompt/macros.ts
   `MacroEnv.outlet?`): author's note, card depth prompt, card fields (expanded inside preset blocks,
   after the lore run: the current outlet text) get the outlet's entries; lore entry content (expanded
   before the outlets exist) and unknown outlets get ''. Never the raw tag. Without a resolver the tag
   stays structural, as before.
9. **o200k memo:** `ensureMemoCapacity(n)` (assemble calls it with 2 × path length + 256, capped at
   65 536 texts; the 8M-char cap still holds) and `o200kRuns()` (tests). turn.ts counts the sent
   trace once (`sentTrace`, cached on the shaped messages) for prep, the server check and the commit.
10. **Formats:**
    - Decorators (st-worldinfo.ts `parseDecorators`, ST's port): leading '@@' lines are stripped from
      the content and kept in `extras.decorators`; `@@activate` → `constant: true`, `@@dont_activate`
      → `enabled: false` (what the entry said before rides extras); only the dropped ones warn.
    - `selective` rides extras when it switches non-empty secondary keys off (round trip).
    - Preset prompt rows: `system_prompt`, `marker`, a relative block's `injection_depth` /
      `injection_order`, `forbid_overrides` on any block and `injection_trigger` (even empty) ride
      block extras (D-70 round trip).
    - **Custom prompt send rules follow ST** for plain ST files: a relative custom prompt is imported
      disabled unless `system_prompt === false` (one folded `st_not_sent` warning), and a custom
      `marker: true` row with `system_prompt: false` and text is an ordinary block. Files with
      RoleCall signs (`prompt_post_processing` without `custom_prompt_post_processing`, or an
      unescaped `{{message_history}}`) keep today's reading with one `rc_signs` warning naming how
      many ST would not send (all of the user's paramnesia-vi-*.json are such files). RC exports:
      unchanged. Decision for D-71, named here.
    - **No 100001 order → ST's default order** (`promptManagerDefaultPromptOrder`): defaults only,
      missing ones filled silently, every other prompt disabled; one `no_global_order` warning. A file
      with no `prompt_order` at all is read the same way (ST then keeps the previous preset's order;
      a fresh ST's is that default). Replaces the Bunraku reading.
    - `dialogueExamples` with injection_position 1 is forced relative (`examples_relative`).
    - RC exports: `new_chat_prompt` and `new_example_chat_prompt` ride extras unapplied with the other
      template formats (`rc_formats`). Supersedes integrate note 5's "stay applied (RC-5 unchanged)";
      PARITY-RC RC-5 now expects the raw examples row. A disabled `personaDescription` marker of an RC
      export stays disabled; `personaInjection` goes after the first enabled main, else jailbreak,
      else first (RoleCall's preset-loader); no `marker_disabled` warning for it then.
    - `unknown_macro` warnings at preset import (one per name, folded over blocks; the prefill and
      impersonation texts too), via the new `unknownMacrosIn(text)` in prompt/macros.ts.
    - Card book fallback name `"<char>'s Lorebook"` (ST's), so an extracted world dedups by name.
    - `formatExamples`: a present-but-blank header splits on `<START>` and heads nothing; `undefined`
      keeps sending the raw text (native/builtin presets). Lore example chunks pass '' through.
    - Detection (kind-markers.ts `isChatCompletionPreset`, `notChatCompletionReason`): an ST preset
      needs a chat-completion marker (prompts array, prompt_order, chat_completion_source,
      openai_max_context/tokens, legacy main/nsfw/jailbreak_prompt). Text-completion presets
      (NovelAI and friends), request bodies (`messages`) and bare samplers are refused with a reason.
      `looksLikeSettingsExport` stays broad (card.ts uses it to refuse cards). test/formats/
      import.test.ts: `{name, description, temperature}` is now 'unknown' (still never a card).
11. **Lore sources:** of session books with the same trimmed, non-empty name only the **last** is read
    (`shadowedSessionBooks`; `loreSources`, cli/refs.ts `bookRows` marks the others `shadowedBy`).
    `/lore add` and `new --lore` put a same-named book in the old one's place (`addLoreId`) and say so.
12. **Engine / CLI:**
    - `PreviewResult.samplersNotSent?: string[]`; the text preview shows only what the connection
      sends and names the rest.
    - `preview --turn` notices drift: `preview_inputs_changed` also names the history, the author's
      note / in-chat inserts, the other messages, the window and the model (row-by-row comparison of
      the rebuilt trace with the stored one; tokens only when both were counted the same way).
    - `ReplDeps.failExit?` (chat.ts sets it under `--provider script:`/`replay:`): exit 3 when an
      answer failed; a non-interactive replay stops at the first replay_mismatch / script_exhausted.
      `REPL_FAILED = 3` exported. Amends the M1b REPL contract "0 for /quit, EOF" for these runs only.
    - `ProviderErrorCode` gains **`replay_aborted`** (category request). `createReplayProvider(calls,
      opts?: ReplayOptions)`: `holdAborted` (interactive chat: hold for Ctrl+C, the old behaviour) and
      `note(req)` (appended to a mismatch). Without holdAborted an aborted recording fails at once
      after its events. A mismatch on another model gets a `model:` line. `replayConnection(…, opts?)`
      and `prepareProvider(…, opts?)` pass `interactive` from main.ts (`deps.tty`).
    - `/lore test` prints the lore notices (codes starting `lore`) after the verdicts.
    - `rp-core preview --turn <prefix naming nothing>` is a refusal: exit 5 + the refusal JSON line
      (`not_found`, ambiguous `invalid_params`), as README's row 5 promised.

## Docs updated

README.md (imports, /lore add, /lore test reasons, preview samplers and seeds, recording, exit
codes, test count, demo links, the context error example), docs/M2-DEMO.md (a "Changed by the M2
fix" section; the transcript is left as it ran), docs/PARITY-RC.md (RC-5, the RC export bullets),
test/golden/st/README.md (G-3 order, G-5 recursion cap, the settings table claim), `rp-core help
chat|preview`, the headers of every touched src file, lore note 9 and integrate note 5 (pointers here).

## Not done / open

- I3's optional parts: card text fields are not scanned for unknown macros at card import, and there
  is no once-per-session runtime notice for unknown macros (import warnings and /trace cover it).
- The RC lore analogue of the persona fix: an RC export's disabled worldInfoBefore/After is still
  revived in place; RoleCall puts world entries at characterBlockStart (lorebook-position-injection.ts).
  Needs a RoleCall recording with a lorebook before it can be asserted.
- Old library presets imported before this fix keep their old blocks (no unknown_macro warnings,
  RC exports with applied new_chat_prompt, custom prompts enabled): re-import to get the new reading.

## Architect, after the review (lore-ignorebudget-not-counted)

The verifier refuted this finding, but the code did not do what ST does: an ignoreBudget entry's
text was never added to the accepted text. ST's checkWorldInfo runs `acceptedContent = nextContent`
for every accepted entry, ignoreBudget included, so that text counts against the entries after it.
Fixed in src/lore/engine.ts (the else branch after the budget check); test/lore/budget.test.ts has
the corrected test and the review's three-entry case (IGN 300 / X 200 / Y 100, budget 250 →
IGN, X fire; Y cut). Golden 04 is unaffected (its ignoreBudget entry is last).
