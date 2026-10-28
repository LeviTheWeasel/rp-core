# M5c contract — crowded (D-205, D-89: `history_crowded`)

Fresh code, nothing ported (Bunraku and RoleCall have no such check), so no provenance note.
Files: `src/engine/request.ts` (the check, the wording, the hook in `buildRequest`), tests in
`test/crowded-m5c/` (`check.test.ts` 12 tests, `engine.test.ts` 2 tests). `src/prompt/assemble.ts`
and `src/protocol/events.ts` are unchanged (notice codes are an untyped `string` there).

## API (`src/engine/request.ts`, section "D-205: history_crowded")

- `HISTORY_CROWDED = 'history_crowded'` — the code and the once-per-session key.
- `HISTORY_CROWDED_MIN = 4`.
- `interface HistoryCrowded { before: number; sent: number }` — chat messages before U on the path
  (hidden and blank ones are not chat messages; the greeting counts) and how many of them were sent.
- `historyCrowded(view, plan: {kind, upTo, preset}, asm: {kept, trace}): HistoryCrowded | null` —
  pure; read off an assembled result. Crowded = `sent < 4` and `sent < before` (something was left
  out) and `sent <` what `preset.context.maxMessages` alone would send (same `trimHistory` cut with
  every message free, so a preset that keeps few messages on purpose is not crowded; a budget cut
  below the limit is). Exits without reading the path when `trace.trimmed === null` or
  `kept.length - 2 >= 4` (the protected tail is U, or U and the continued answer).
- `fixedTokens(asm, tokenFactor, nativeTools): number` — the never-trimmed part in budget tokens:
  the non-`history` rows of `trace.blocks` + the sent prefill (+ overhead) + native tool declarations,
  times the EMA factor (ceil; factor 1 / invalid = raw).
- `crowdedNotice(found, fixed, {window, reserve, toolRoom}): KeyedNotice` — level `warn`, e.g.
  `Only 2 of the 30 earlier messages fit in the request: the fixed part of the prompt (everything but
  the chat history) takes about 11234 of the 14336 tokens a request may use (window 16384 - reply
  reserve 2048)[, and N more are kept free for tool rounds]. A narrator with a larger window (/model) or
  a lighter preset (/preset builtin) leaves the history more room; /preview shows the parts.`
  (`fits` for one; `None of the N …` / `The earlier message does not fit` for none.)
- `buildRequest`: every ok result (pass A, pass B, the D-28 pass B) appends the notice after that
  pass's notices when crowded; never with `fitCheck` set (D-195) and never on a refusal.

## Choices

1. **Placement.** In the request builder, not assemble: assemble's notice lists are pinned exactly by
   the prompt tests (greeting-dropped cases are crowded), and a new `AssembleResult` field changes the
   pinned M2 digests (`test/prompt-m3/no-tools.test.ts`, `m2Json` drops only `toolRoom`/`kept`). So
   assemble is untouched and requests are byte-identical by construction; the check mirrors
   `assemble/chat.ts` (path to upTo, hidden/blank out, upTo always in; blankness by the raw text,
   without the identity macros) and `protectedTail`/`trimHistory`'s protections.
2. **"Before U":** on reply/swipe the messages before upTo; on continue the messages before the U the
   answer replies to (U and A are the protected tail). An opening counts before upTo.
3. **"Although the path has more":** at least one earlier chat message was left out (the budget cut,
   the greeting dropped as a last resort). Fewer than 4 earlier messages on the path, all sent: quiet.
4. **Once per session:** the turn's `keyedNotices` → `host.firstNotice('history_crowded')`, like every
   request notice (`max_tokens_reduced`, D-28 ones); a fallback's rebuilt request shares the key; a
   preview shows it every time and marks nothing told; a reopen tells again.
5. **The fixed part's size** is the request's own rows (the counter `/trace` and `/preview` show), so
   the numbers can be checked there; scaled like the budget so it compares with `window - reserve`.
   The tool room is named separately (it is not "fixed", but it is what pass B takes from history).
6. **Level `warn`** (the narrator loses most of the story), like `greeting_dropped`.

## For the wave-2 integrator

- The spec text predates D-205: ARCHITECTURE.md §7.4.6 (the 16k budget paragraph, "меньше 25 % окна",
  advice "меньше лора, меньше max_tokens, другой пресет") and the D-89 decision text say "< 25 % of the
  window"; D-205 replaces that rule and the advice. The §19.7 row puts the check in
  `agents/compendium/{profile,lexical}.ts`; it lives in `engine/request.ts` (listed deviation).
  `.notes/contract-assemble.md` point 5 ("§19.7 gives it to profile.ts") is stale.
- The notice can now appear in any turn or preview whose history is cut below 4 earlier messages. Run
  the whole suite: likely places are the 4 096-window demos (`test/demo-m5b`, its transcript in
  `docs/M5B-DEMO.md`), small-window REPL/TUI transcripts, `test/rcimport` (heavy imported presets) and
  the history-tool tests of `test/engine-m3`. In the suites run here (golden, assemble, engine-m5a)
  nothing changed.
- The REPL and TUI print it as any session notice; no renderer change was needed.
- Optional: `cli/import-story.ts` `fitCheck` reads only `context_length_exceeded` from the preview; it
  could also turn a `history_crowded` preview notice into an import warning (the RoleCall story case).

## Open questions

1. Should an import (D-195's fit check) warn on `history_crowded` too (above)?
2. Should `/trace` show the crowded finding per request (it can be recomputed from `trace.trimmed` and
   the kept rows), or is the once-per-session notice enough?
