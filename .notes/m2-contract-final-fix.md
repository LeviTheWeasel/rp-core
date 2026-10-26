# M2 contract notes — final fix (the last read-only check's 21 findings)

State at hand-over: `bunx tsc --noEmit -p .` clean, `bun test` green (counts in the hand-over
message), the purity test green. Every code change has a regression test; docs/ARCHITECTURE.md was
not touched (the architect is editing it). Below: every contract change, the readings taken, and
what is left open.

## Contract changes (all additive unless said)

1. **Lore timers count visible messages only (lore/timers.ts).** `chatLengthAt`, `pathScans` and the
   `at` of `pathFires` count the non-hidden path messages (ST's timed effects run on the WI chat
   built from coreChat, which drops `is_system`: script.js coreChat ~7115, ~7393; world-info.js
   WorldInfoTimedEffects). A fire's `at` = the visible messages before its message; a continue's =
   that + 1 when the message is visible. Positions follow today's hidden state, so a message hidden
   later shifts every later position (in ST a hidden message shortens the chat the same way).
   **Changes behaviour:** the old rule "chat length = path index + 1; hidden messages still count"
   is gone (test/lore/timers.test.ts updated; test/engine-m2/fires.test.ts adds a sticky window that
   stays open one message longer when a message between the turns is hidden).
2. **preview_inputs_changed (engine/session.ts `sentChanged`).** The history is compared through the
   journal, not the trace rows: the path messages up to the answer's user message as of the answer's
   msg seq (a tree built from the entries with `seq <=` it) against today's, by id, hidden state and
   blocks (`historyChangedSince`). The cut is `trace.trimmed` compared on its own ("which old
   messages the budget leaves out"). Trace rows are split on '+' into the parts shape() joined:
   insert parts (author's note, card depth, lore, …) and block parts are compared as sequences, and
   by tokens only when the rows line up one to one and were counted alike. Same parts in the same
   order but grouped or roled otherwise (or a placeholder / continue cue that came or went) is
   **shaping**: "how the messages are shaped (merged or re-roled: <cause>)", the cause being the
   model's connection when the model changed, else the preset's post-processing when the preset
   changed, else the connection's capabilities. "The other messages" is gone: a block text change is
   named only when neither the preset nor a book explains it ("the text of the system blocks (the
   card, the persona or the lore that fired)"). Message wording of the history item changed to "the
   history (an edit or a hidden message)".
3. **Verdict token counts (lore/engine.ts, prompt/assemble.ts, engine/api.ts).**
   - `LoreRunInput.rawCount?(text)`: explain only, the counter without the EMA correction; each
     verdict then carries `LoreVerdict.rawTokens?` (the same text `tokens` counted). `tokens` keeps
     its meaning (budget tokens). runAssembleLore passes it through (`LoreRequest.rawCount?`).
   - `AssembleResult.loreUse?: { used, factor }` and `PreviewResult.loreUse?` (explain only): the
     budget tokens the lore run used and the factor (the model's EMA correction, 1 = none).
   - `renderVerdicts(…, max, use?)`: entry lines show `rawTokens ?? tokens`; the totals line is
     `N tok of lore · <used> of <budget> budget tok (counts ×F for this model)` (no factor text at
     1; without `use`: `budget <budget> budget tok`). A `budget-cut` detail reads `costs N budget
     tok, M left` and has no trailing number any more.
4. **REPL /trace recomputes verdicts [D-45] (cli/repl.ts, repl-render.ts).** /trace calls
   `session.preview({ turn: <answer id>, explain: true })` and prints, after the stored lore lines,
   `renderTraceMisses`: every miss with its own reason on a line (budget cuts the stored cut line
   names are left out), the no-key-match / disabled ones as one count line ("✗ N more: …" or "✗ N
   entries: …"), then the preview's `preview_inputs_changed` notice. A continued answer says the
   verdicts are of its own request ("before its continue"). A preview that cannot be built prints a
   dim line instead. `renderTrace(id, t, titles, after?)` takes those lines.
5. **REPL /preview --verdicts (cli/repl-commands.ts).** The `preview` command gains `verdicts:
   boolean` (always present, like `wire`); `--verdicts` combines with n|id and --wire. /help and
   the parser's error texts name it.
6. **--wire keeps the notices.** REPL: body, then the verdicts, then every notice. One-shot
   `rp-core preview --wire`: stdout stays the JSON body; the notices (`rp-core: <level>: <message>
   (<code>)`) and, with --verdicts, the verdicts go to stderr (before: the verdicts were dropped too).
7. **'builtin' is a reserved preset id (formats/library.ts `RESERVED_IDS`).** saveToLibrary starts a
   reserved id at `-2`: a preset named "Builtin" or imported `--as builtin` becomes builtin-2
   (lorebooks and characters are not affected). `renderPresets` never lists a library row `builtin`
   as the built-in layout: it names `library/presets/builtin.json` apart; refs' "the library has:"
   list names builtin once.
8. **Window shown in the banner and /preset.**
   - `bannerLine(…, cap?)`: with the model's window unknown, the preset's (or the session's) limit is
     shown as `ctx ≤N`.
   - `renderPresets(current, library, cap?)` and the new `presetCapText(cap, model)`: bare /preset
     names the current preset's cap when it shrinks the model's window, or when the model's window is
     unknown; the /preset switch line uses the same words (so with an unknown window it now says
     "it caps the window at N tokens").
   - `ReplDeps.override?: { conn, plays: 'script' | 'recording', windowOf(model) }` (chat.ts
     `overrideOf`, from rt.provider): under `--provider script:`/`replay:` the banner and /preset take
     the window from the override connection (its traces, then its caps), never from config.toml's
     caps for the binding. runtime.ts gains `connectionWindow(conn, model)`.
9. **Exhaustion wording.** The replay provider's script_exhausted message is "the recording ran out
   of calls: request N has no recorded call left (the recording has K)"; the scripted provider's
   starts with `PROVIDER_ERROR_MESSAGE.script_exhausted` ("the script ran out of calls: …"). The
   REPL stop line says "the recording no longer matches this chat" only for replay_mismatch and "the
   <script|recording> ran out of calls" for script_exhausted (from `override.plays`).
10. **Settings files that are not presets (formats/kind-markers.ts).** `looksLikeSettingsExport` also
    takes two or more text-completion sampler keys (KoboldAI / text generation write `temp`, not
    `temperature`) and `formattingTemplateKind` (ST's Advanced Formatting system prompt `{name,
    content, post_history}` and reasoning template `{name, prefix, suffix, separator}`).
    `notChatCompletionReason` names them, and names the text-completion backend
    (`textCompletionBackend`: NovelAI / KoboldAI / text-generation) when the fields say. Cards that
    carry such keys are refused as cards (looksLikeSettingsExport is card.ts's firewall too). The
    NovelAI refusal now says "NovelAI samplers: …" (test/formats/import.test.ts updated).
11. **A non-list keysecondary warns (formats/st-worldinfo.ts).** Found by porting RoleCall's parser
    test: a scalar `keysecondary` was dropped silently. It is still dropped (ST resets it to [] in
    world-info.js "Fixing invalid keysecondary"), now with an `invalid_value` warning like the
    primary keys'. null stays quiet.
12. **One-shot preview on a greeting-only session** adds the stderr line `rp-core: nothing to build
    yet: use --draft "text" to preview a reply to that text` before the refusal JSON (which stays
    the last line).
13. **Wording:** the continue-nudge warning says "(rp-core's /c continues the last answer its own
    way)" instead of citing §6.4; `rp-core help new` says CCv1/V2/V3 and documents the persona's
    `book`; `help import` says how ids are named (own name field, else the file; builtin-2);
    `help preview` says where --wire's notices go; `help chat` the stop on running out of calls;
    `--max-tokens` help states the real default (preset's, else 2048 / 8192, at most half).

## Readings taken

- Finding 1 (test only): the assemble-level test now pins ST's rule (I accepted, E1 cut at budget
  200, every later entry skipped after the overflow).
- Finding 6: comparing the history through the journal was chosen over "history+… rows count as
  history": merged rows carry other blocks' tokens, so a row-level comparison cannot separate an
  edit from a re-shaping. The journal comparison is exact for edits, hides and unhides; it costs one
  tree build over the entries up to the answer (preview --turn and /trace only).
- Finding 11: the raw count is taken by the engine itself (`rawCount`), not derived by dividing by
  the factor (ceil makes that inexact). `loreTraceLines`' "budget N tok" is unchanged.
- Finding 19: the documentation fix (cards and character_books are named by their own name field,
  presets and world info by the file); no naming rule changed.
- Finding 21: ported as `test/formats-m2/ported-lorebooks.test.ts` and `ported-presets.test.ts`
  with port headers and PROVENANCE rows; Bunraku's fixtures minimal / tracker / utility / plain /
  spec-walk copied unchanged into `test/fixtures/presets/bunraku/` (presets/tracker is the same file
  plus a newline: not copied twice). Every case that does not apply is named in the file header and
  the PROVENANCE row (emitters and round trips, divider groups, nemo-wiki, the RoleCall v1 bridge,
  Bunraku's own sample worlds).

## Not done / open

- `PathView` positions are recomputed from today's hidden state; a fire recorded before a later
  hide moves with it (ST's stored effect starts do not move, but its chat shrinks the same way, so
  the distance in sticky/cooldown windows differs from ST by the hidden messages before the fire).
  Named in the timers header; the decision was to follow ST's chat length.
- `{{if}}…{{else}}…{{/if}}` (Bunraku's utility fixture, RoleCall-born presets) stays literal, as
  every unknown macro; only `{{else}}` and `{{/if}}` are named by the import warning (the opening
  `{{if …}}` is not reported as unknown by `unknownMacrosIn`).
- A miss whose roll was skipped (probability 0) shows no roll numbers in its verdict line.
