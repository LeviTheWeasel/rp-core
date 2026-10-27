# TUI fixes, unit `lifecycle` (T-13, T-14, T-15 host part, T-16 host part; review F1, F2/P3/F5, P2, P6, F6, F3)

Files: src/cli/tui/{app,run,source}.ts, src/cli/repl.ts (one additive ReplOptions field); io.ts and
index.ts unchanged. Tests: test/tui/{lifecycle,host}.test.ts, new test/tui/signals.test.ts.
`bunx tsc --noEmit -p .` clean; my three test files 70 pass; full suite (`TMPDIR=~/.cache bun test`)
4486 pass, 3 skip, 0 fail (212 files). test/repl unchanged and green (the REPL's bytes did not change).

## T-13 every exit signal is ours
- app.ts `rendererConfig().exitSignals` is `[]`: OpenTUI installs no signal listener (its handler only
  destroyed the renderer and, being a listener, cancelled the default action → the orphan at 100 % CPU
  holding the lock). `setLabel` is a no-op on a destroyed label.
- run.ts: `EXIT_SIGNALS` (SIGTERM, SIGHUP, SIGQUIT, SIGABRT, SIGPIPE, SIGBUS) are handled by runTui from
  before the renderer until the terminal is restored. First signal: the line (SIGTERM: TERMINATED_LINE byte
  for byte; others `rp-core: SIGHUP: closing the session (the partial answer is kept)`) → transcript row +
  tui.log → `engine.close()` (turn stopped, partial kept, lock released) → leave(128+n): restore → the
  line again on the restored stderr → `a.exitNow` (main's: --sandbox removed, process.exit). A second
  signal → `a.exitNow(128+n)` at once. onChatTerm is no longer used by the TUI (runChat unchanged).
- mountTui listens to the renderer's `destroy`: if it goes away any other way, `source.close()` → the
  Repl's input ends → runTui finishes as after /quit (exit 0, lock released). Removed in dispose().
- source.ts: every TextareaSource method (submit, prompt, pending, clearPending, prefill) is a no-op once
  closed or once `box.isDestroyed` (InputBox gained an optional `isDestroyed`): a late SIGINT no longer
  throws `EditBuffer is destroyed`.
- EIO: `renderer.destroy()` in try/catch, `await renderer.closed` bounded (2 s), the 2027 reset and the
  told lines written through a never-throwing `write()` (streamChannel already swallows stream errors).
- Checked in a real pty (Bun.spawn `terminal`): kill -HUP / -QUIT / -TERM → 129 / 131 / 143 with `?1049l`,
  `?2027l`, then the line; pty master closed mid-answer → 129, partial kept, lock released; `new --tui
  --sandbox` + SIGHUP → sandbox removed. Before: alive after 6 s, lock renewed (reproduced).

## T-14 nothing the Repl says is lost
- The host wraps the Repl's view (run.ts `hostView`): every `line()` goes to tui.log AND the transcript
  (debug lines included, since they come through say()). **view.ts must not also log line() text**
  (duplicates); the chat unit logs only the turn's failed/conflict rows there, which the host relies on.
- Lines the Repl says after dispose() (the TUI shutting down) and Io writes in that window go to
  `MountOptions.late` → told on stderr after the terminal is restored. After an exit 1 / 3 / 130 the
  last ≤ 6 lines of `TuiView.lastSaid` (the chat unit's getter: since the last echo / idle) are told
  first: `(1 answer failed: script_exhausted; exit 3)`, `! left with the turn still open…`. SGR stripped.
  Exit 0 prints nothing (the /quit test still expects `err === ''`).
- `rt.debug` outside the Repl's run goes through the TUI's Io (log, transcript while up), restored at
  the end. tui.log's `exit N` is the real code on the signal path (was `exit 0`).

## T-15 host part
- Ctrl+E with typed text (not mid-answer): status row `send or clear the input first (Esc)` (yellow,
  `SEND_FIRST`), nothing happens; mid-answer the Repl's own `refused [session_busy]` stands, text kept.
- `ReplOptions.command?: 'chat' | 'tui'` (default 'chat'): the `--debug shows the server's own words`
  hint and the `/probe --active --write` note name `rp-core tui` in the TUI. Field `commandName` in Repl.
- Status row: a line sent while the Repl is idle marks it busy; after `WORKING_AFTER_MS` (300) without
  idle()/turn() the row says `working… · lines sent now wait their turn`; each non-empty line sent
  meanwhile (no turn, no edit) counts: `working… · queued: N` (decremented on the Repl's echo). idle()
  resets (READY from the view); turn() hands the row to `answering…`; after a turn the timer re-arms.
- Warp flag wiring requested by panes/chat: `TuiParts.models/agents` take an optional `{ warp }`, TuiView
  gets `warp` (additive).

## T-16 host part
- `pasteGuard(renderer.stdin, {idleMs, onEnd})` (source.ts): a `prependListener('data')` tap before
  OpenTUI's parser (whose `consumePasteBytes` has no timeout or cap, #1270). A paste open with no byte for
  `PASTE_IDLE_MS` (1000) is ended by emitting `ESC[201~` into the stream (the text so far lands in the
  box); a chunk that is one Ctrl+C key (`isCtrlCChunk`: 0x03, kitty CSI-u incl. `1089::99`, lock bits,
  `:1` press; modifyOtherKeys `27;5;99~` / `27;5;1089~`) ends it at once, then the key goes through.
  Logged `paste: no end marker; ended (…)`. Real pty: `ESC[200~hello there`, ^C, ^C, `/quit⏎` → exit 0.
- Russian Ctrl+letters under modifyOtherKeys: keys.ts is the panes unit's (done there); a host test
  feeds `CSI 27;5;1082~` (swipe) and `CSI 27;5;1089~` (stop) through the real renderer.

## New exports (all additive)
run.ts: `EXIT_SIGNALS`, `ExitSignal`, `ExitSignalSource`, `signalExitCode`, `signalLine`, `SEND_FIRST`,
`WORKING`, `WORKING_AFTER_MS`; `TuiArgs.signals?: ExitSignalSource` (narrows ChatArgs'), `pasteIdleMs?`,
`workingAfterMs?`; `MountedTui.summary()`; `MountOptions.late?`. source.ts: `PASTE_START`, `PASTE_END`,
`PASTE_IDLE_MS`, `InputStream`, `isCtrlCChunk`, `pasteGuard`. repl.ts: `ReplOptions.command?`.

## Tests (each checked to fail with its fix reverted: scratchpad life/mutate.py over a copy of the tree)
- signals.test.ts (15): SIGHUP on the real process listeners (129, reset, line after it, lock, log,
  listeners removed); SIGQUIT/ABRT/PIPE/BUS; a second signal; SIGHUP mid-answer (partial kept, no
  "destroyed" error); renderer destroyed from outside; exit 3 summary on stderr; --debug to tui.log only
  (+ outside the run, rt.debug given back); working…/queued with a /probe --active on a never-answering
  fetch; 3 real-pty tests (kill -HUP, terminal closed mid-answer, `new --tui --sandbox`), skipped
  without `Bun.Terminal`.
- lifecycle.test.ts (+3): every Repl line in tui.log; exit 130 why on stderr; exit 0 prints nothing.
- host.test.ts (+12): source no-ops on a destroyed box; pasteGuard ×3; isCtrlCChunk; Ctrl+E with text
  (and mid-answer); Warp to the panes; `rp-core tui` hint; no "working…" for a fast command; paste + Ctrl+C;
  paste idle end; modifyOtherKeys ctrl+к / ctrl+с.

## Open / for the lead
- Finding 12 (TUI_HELP below 120 columns): the panes note proposes a `keysShown` dep for TuiView; not
  wired (view.ts has no such dep yet).
- SIGBUS / SIGABRT raised by a real fault (not `kill`) are not safe for JS handlers (Node docs); they
  only matter as `kill -BUS/-ABRT` here, as before under OpenTUI.
- A paste whose chunks arrive more than 1 s apart (a huge paste over a slow ssh link) would be cut at the
  gap; the rest then arrives as typed keys (an Enter in it would send). Raise PASTE_IDLE_MS if seen.
