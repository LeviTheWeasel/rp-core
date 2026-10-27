# TUI Phase 2 "integrate": contract

Unit `integrate` (TUI decisions T-1…T-11; repl-map §5). The three Phase 2 units (`host`, `chat`, `panes`) run
as ONE program: `rp-core tui` / `new --tui` → runTui → the real transcript, models pane and agents pane
behind TuiView, over the real Repl. types.ts unchanged (no change needed).

## Wiring
- No stubs were left: run.ts `defaultParts()` already loads `createTranscript`, `createModelsPane`,
  `createAgentsPane` with `await import` (OpenTUI stays off every other path).
- `/think` reaches finished cards: run.ts passes `showReasoning: () => view?.reasoningShown()` to
  createTranscript (TuiParts.transcript now takes the chat unit's `TranscriptOptions`). TuiView keeps the
  Repl's live getter from the first `TurnOptions.showReasoning`, and before any turn the session's stored
  `config.reasoningShown` (banner, refresh). Cards drawn later (showPath on /open, /fork; `/[ /]`, /rewind…)
  open or fold reasoning as /think says. Live turns already read it themselves.

## Defects found and fixed
1. **`forked into …` vanished** (view.ts). /fork says the line, then greet() → banner → showPath clears
   the transcript: the person never saw where the fork went. TuiView now remembers what the Repl said for
   the current line (since the last echo; reset on idle) and shows it again after showPath on a session
   switch. Tested (e2e smoke + /open-/fork test).
2. **Hotkey commands left the view scrolled up** (run.ts). Enter scrolled to the bottom, a command hotkey
   (Ctrl+R/O/D, Alt+←/→, F1, Ctrl+E) did not: after PgUp the swipe streamed off-screen with sticky scroll
   disengaged. Command and editLast hotkeys now scroll to the bottom too. Tested (scrolling test).
3. **T-9 "the help says so"** (view.ts). The Repl's /help says `/e … in $EDITOR when it is set`, which is
   false in the TUI. helpText() is the REPL's (byte-identical rule), so TuiView adds one dim row under it
   when the Repl's line equals helpText(): `In the TUI: /e and Ctrl+E edit in the input box ($VISUAL /
   $EDITOR are not used); the keys are listed on the left (F2 shows or hides the side panes).`
4. **`new --tui` named the wrong command** — `rp-core chat <id>` reopens it. **Outside src/cli/tui (why):**
   the line is cmdNew's (src/cli/commands.ts); NewArgs gets an optional `reopen?: 'chat' | 'tui'`
   (default 'chat', so `new` and every test/cli expectation are unchanged) and main.ts passes 'tui' under
   `--tui`. Tested through cmdNew + runTui on a headless renderer.
5. Test kit (test/tui/kit.ts): the rig's runtime now uses the engine's connections (as engineOptions(rt)
   does in production), so the Repl's capsOf/windowOf — the models pane's `tools native` and window — see
   the scripted caps; `frame()` returns the last frame after dispose instead of throwing from a timed-out
   poll (that used to surface as an "Unhandled error between tests" in the NEXT test).

## End-to-end tests: test/tui/e2e.test.ts (20 tests)
Layout at 120/100/70 (box positions, widths, every row exactly the terminal width, chat order transcript →
status → input); type+Enter with a pause (echo, partial card, `answering…`, `Narrator · writing…`, then
the card, its status line on the next row, italics and the character colour); pause+Ctrl+C (`[stopped]`,
partial kept in the frame and the journal, next turn runs); held line sent after the answer + `/hide 1`
refused mid-turn; **every slash command** (50 lines: each echoed, followed by its own rows, the expected
words checked; /open switches, /e opens and Esc cancels; stdout/stderr spied: nothing written while the
TUI is up; /quit → only `\x1b[?2027l` on the real out); /e via Ctrl+E (prefill with real line breaks, the
input grows to 2 rows, Enter saves → `edited`, Esc cancels); Director turn (`planning…` while paused,
then `planned · Ns`, summary, record rows; Models: binding, follows narrator, profile auto → full, style);
native tool step (side line in the card, `⋯ search_history "cara… · N.Ns` in Agents, `tools native`);
/open + /fork (transcript, Models title/character, Agents reset to `no model calls yet`, label width);
recovery notice at open (writeRaw; card once, yellow notice); `new --tui` (hint names `rp-core tui`, /quit,
lock released); /quit mid-turn (lock released, partial `stopped`, terminal reset); Russian layout
(ctrl+к swipe, ctrl+щ continue, ctrl+в Director, ctrl+п prefill, ctrl+у edit, ctrl+с cancels, Cyrillic
letters still typed); F3 mouse / F2 panes; scrolling (PgUp holds the rows while the answer streams,
Ctrl+End and a hotkey come back); /think (folded live, opened on a later card, folded again); NO_COLOR (no
theme colour on any span, italic/bold kept); 2 000 messages (open ≈140 ms, 208 renderables, streaming
frames median ≈1 ms, max ≈3–22 ms at 120×40).

Real pty (scratchpad `integ/drive_tui.py`, pyte, `bun src/cli/main.ts tui <id> --provider script:`):
open, reply with reasoning, slow stream, Ctrl+C stop, Ctrl+R swipe, F2, SIGWINCH 120→80, /quit: exit 0,
termios restored, tail has `?1049l`, `?2027l`, `?25h`, `?2004l`; tui.log `open … 120x36`, `closed`, `exit 0`.

Counts: test/tui 150 pass (130 before + 20 e2e). `bunx tsc --noEmit -p .` clean. Full suite
(`TMPDIR=~/.cache bun test`): 4418 pass, 3 skip, 0 fail (4421 tests, 210 files). Once, under load,
`test/tools-parse/unclosed-engine.test.ts` timed out (6.5 s > 5 s); it passes alone and in the next full run
(not a TUI file; same kind of flake as host's innkeeper note). The scrolling test was checked to fail
without fix 2.

## Open problems (not fixed)
- A continue (`/c`, Ctrl+O) grows the newest card IN PLACE (chat unit's design), i.e. above the `you › /c`
  echo row, which is then left with nothing under it. Works, reads a little oddly; the alternative is a new
  `…last words` card like the REPL.
- Finished answer cards show their finish/hidden/edited markers before the text (`Mira › [interrupted] She
  begins to`) AND the REPL's status line repeats them (`[swipe 1/1 · interrupted]`). Harmless duplication
  (chat unit's choice; user cards have no status line, so the markers matter there).
- The input box grows one frame after its text changes (fitInput runs on 'frame'); a real renderer
  schedules the next frame itself, the test renderer needs one more renderOnce.
- Status row: no `probing…` state during `/probe --active` (it says `ready` while the probe runs).
- `rt.debug` is the main Io (process stderr) outside the Repl's run (debugTap swaps it only while the
  Repl runs): a provider failure reported after the Repl ends but before the renderer is destroyed would
  print into the frame. Not reachable in tests; noted for the lead.
- ARCHITECTURE rev 15 (D-125…, §15 "M4.5 TUI"), README and the PROVENANCE line for @opentui/core (MIT,
  pinned 0.7.0) are not written (lead's files). The Warp check and the lead's own pty run are still open.
