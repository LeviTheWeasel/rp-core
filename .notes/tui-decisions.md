# TUI decisions (the lead's design note; authoritative for the TUI build)

The stage after M4 (Levi, 27.10.2026): a full-screen three-column terminal UI on OpenTUI, before M5.
LEFT: the current models and the hotkeys with descriptions. MIDDLE (widest): the chat. RIGHT: the
agents and their latest tool calls. Decisions here become D-125… in ARCHITECTURE.md rev 15 (a new
milestone entry "M4.5 TUI" in §15). Research it rests on:
`<session scratchpad>/tui/`
- `opentui.md` — the TESTED OpenTUI 0.7.0 cheat sheet (config, exit, keys, ScrollBox, Textarea,
  widths, headless tests, performance, gotchas). Prototype: `opentui-probe/proto.ts`; pty driver:
  `pty_drive.py` (Python pty + pyte venv in that dir).
- `repl-map.md` — how the REPL works and the port refactor (§2.2), pane data sources (§3), session
  lifecycle (§4), test reuse (§5).

## T-1 Command and scope
- `rp-core tui <session> [--provider …]` (same flags as `chat`). It needs a TTY on stdin and stdout;
  otherwise exit 64 with "rp-core tui needs a terminal; use rp-core chat". `rp-core new --tui` opens the
  new session in the TUI instead of the REPL. `rp-core chat` (the line REPL) stays the default and
  unchanged: scripts, pipes, `--provider script:` runs.
- Everything the REPL does works in the TUI: every slash command, held lines, refusals mid-turn,
  Ctrl+C rules, `/open`, `/fork`, `/e` (inline only, T-9).
- Not in v1: mouse text selection inside the TUI, image display, a settings screen, held-answer
  keep/discard (M6), IME guarantees, Ctrl+Z suspend.

## T-2 Library
- `@opentui/core` pinned EXACTLY `0.7.0` (no caret) in package.json, bun.lock committed. The peer
  `web-tree-sitter` that Bun installs with it is accepted (not imported by us). MIT.
- Imported ONLY dynamically from the `tui` command path (`await import('@opentui/core')` inside
  `src/cli/tui/…` entry), so no other command, test or library user loads the native lib. Tests of the
  TUI import `@opentui/core/testing`.
- PROVENANCE: no ported code; the dependency gets a line like jsonrepair's.

## T-3 Architecture: the TUI hosts the same Repl through two ports (repl-map §2.2, Phase 1)
Phase 1 (its own green step, no OpenTUI): export `LineSource` / `InterruptSource`; `ReplOptions.source`
and `LineSource.inline`; `src/cli/repl-view.ts` with `ReplView` / `TurnView` / `BannerInfo` and the
default `LineView` (today's Screen + TurnPrinter moved as is); `ReplOptions.view`; `view.idle?()` when
the queue is empty; `bannerInfo()` extracted from `greet()`; `chatDeps()` extracted from `runChat`.
The REPL's output stays byte-identical: every test under test/repl, test/cli, test/cli-m4,
test/demo-m3, test/demo-m4 passes unchanged.
Phase 2: `src/cli/tui/` — the OpenTUI host (`TextareaSource`, interrupts, `TuiView`, panes,
`sgrToChunks`, sanitiser, `tuiIo`, `runTui` / `cmdTui`).

## T-4 Layout
- Root row: LEFT box width 28 (no shrink), MIDDLE flexGrow 1 (minWidth 40), RIGHT box width 36.
  Borders single, titles " Models ", " Chat ", " Agents " (UI labels are English like the rest of the
  CLI). Middle = transcript ScrollBox (stickyScroll, stickyStart bottom) + a one-line status row + the
  input Textarea (auto-grows 1–6 rows).
- Responsive: width ≥ 120 → all three; 90–119 → chat + agents; < 90 → chat only. F2 toggles the side
  panes by hand (overrides until the next F2).
- Colours: the terminal's own background (no forced backgroundColor); dim/bold/yellow/red from the
  Repl's SGR set; NO_COLOR → monochrome.

## T-5 Left pane ("Models")
From `bannerInfo()` (refreshed on `idle()` and on banner/session switch): session title, character
and persona; Narrator `conn:model`, window, tools transport (native/prompted/off), `(script)` /
`(recording)` under --provider; Director: off, or `conn:model` (+ "follows narrator"), profile of the
last plan (lite/full) and style; then the hotkey list (T-6), one line each: key, description.

## T-6 Hotkeys
Matched by `name` OR `baseCode` (Russian layout under kitty: Ctrl+R arrives as `ctrl+к`). A hotkey that
maps to a command injects that command line into the Repl through the TUI's LineSource, so the Repl's
rules (held / refused mid-turn) apply unchanged.
| Key | Action |
|---|---|
| Enter | send |
| Shift+Enter, Alt+Enter, Ctrl+J | new line in the input |
| Ctrl+C | stop the answer / clear the input / twice to quit (the Repl's rules) |
| Ctrl+R | swipe (`/r`) |
| Ctrl+G | guided re-roll: puts `/regen ` into the input |
| Ctrl+O | continue (`/c`) |
| Ctrl+E | edit the last message in the input (`/e`) |
| Alt+← / Alt+→ | previous / next version (`/[`, `/]`) |
| PgUp / PgDn | scroll the chat a page |
| Ctrl+Home / Ctrl+End | top / bottom of the chat |
| Ctrl+D | the Director's state (`/director show`) |
| F1 | help (`/help`) |
| F2 | show / hide the side panes |
| F3 | mouse: wheel scrolling on/off (off keeps the terminal's own text selection) |
| Esc | cancel an in-place edit / clear the input |
The left pane shows the active newline key (Shift+Enter only when the terminal reported kitty/CSI-u).

## T-7 Transcript (middle)
- On open: the whole active path (not only the last message), each message as a card: a header
  `Name › ` (bold; `you` for the player, like the REPL), the text with the prose styling (`*actions*`
  italic), then the dim status line (`swipe 2/3 · 300 tok · 13.3s · length`) for answers.
- Then an append-only log, REPL semantics: the Repl's `line()` output becomes system rows (dim, yellow,
  red as the Repl styled them), `echo` the player's line, `message` a card, `turn` a live card that
  streams (`text` deltas through `applyDelta`, sanitised, prose-styled, converted to chunks) and is
  finalised on the terminal event. Reasoning folds to `⋯ thinking (N chars)` unless `/think show`.
- Performance: keep the newest ~150 cards as renderables; fold older ones into archive Text blocks of
  one StyledText each (opentui.md §6).
- Scroll: sticky at the bottom; PgUp/PgDn/Ctrl+Home/Ctrl+End; sending a message scrolls to the bottom.

## T-8 Right pane ("Agents")
- Narrator: state (idle / thinking N chars / writing / tool `name` / retry), the last 6 tool calls,
  newest first (`toolLine` text + duration from the events' `ts`), the last answer's stats (tokens,
  seconds, finish, rounds, transport).
- Director: off / planning… / planned — summary / reused — summary / failed (code); from the last
  record (directorAt at the head): turn, profile, transport, model, attempts (ms, tokens), chapter,
  live arcs, seeds due.
- Later agents (M5 recall/filing/historian): a generic block per `agent` event name.
- Bottom: totals from `pathUsage` (calls, tokens, cost) refreshed on `idle()`.
- Data: the TUI's `TurnView` receives every turn event; session-level `memory` / `changed` from
  `engine.events()` filtered by the current session id.

## T-9 Editing
`/e` and Ctrl+E edit IN PLACE in the Textarea (real newlines; `⏎` mapping not needed), `edit ›` label,
Enter saves, Esc or Ctrl+C cancels. `$VISUAL`/`$EDITOR` are not used in the TUI v1 (suspending the
renderer for an external editor is unverified, issue #1710); the help says so.

## T-10 Terminal safety (opentui.md §2, §7)
- Renderer: `exitOnCtrlC:false`, SIGINT out of `exitSignals`, `autoFocus:false`,
  `openConsoleOnError:false`, `useMouse` from F3 (default OFF), `targetFps 30`.
- Open the engine and the session BEFORE the renderer (lock / not-found refusals print as normal CLI
  errors, exit 5). Install signal and error handlers before anything that can throw; wrap startup in
  try/finally → shutdown.
- Exit: `renderer.destroy()` → `await renderer.closed` → write `\x1b[?2027l` → restore `processIo()` →
  `process.exit(code)`. The Repl's exit codes (0, 130) and runChat's SIGTERM path (143) are kept.
- Nothing writes to process.stdout/stderr while the renderer is up: the TUI's `Io` routes `out`/`err`
  into transcript system rows and a file log `<home>/logs/tui.log` (debug lines, errors). Uncaught
  errors → file log + a red status row, never the console overlay.
- Sanitise model text (and any string from a file) before display: drop ESC and C0/C1 controls except
  `\n`; `\t` → two spaces. Under Warp (`TERM_PROGRAM=WarpTerminal`) also drop ZWJ / VS16 / skin-tone
  modifiers (ghost glyphs, opencode#58028).

## T-12 Colours follow the terminal's theme (first test in Warp, 27.10)
Levi's Warp uses a light theme: text OpenTUI draws without an explicit fg comes out as bright white
(`38;5;15`) and vanished on the white background. Checked in a pty: `RGBA.defaultForeground()` is sent
as SGR 39 (the terminal's own text colour), `RGBA.fromIndex(n)` as `38;5;n` (the terminal's palette),
the default background as SGR 49. So the theme uses NO hex colours: text = the terminal's default
foreground; dim text = the DIM attribute on it (no grey hex); accents from the terminal's ANSI palette
(user 2 green, character 5 magenta, accent/keys 4 blue, yellow 3, red 1, borders and the scrollbar 8
bright black); no input background (the input row is marked by its `you ›` label); every renderable
sets its fg (and Textarea text/placeholder/cursor colours, borders, scrollbar) explicitly — nothing
may fall back to OpenTUI's white. A light or dark terminal theme then works without detection.
NO_COLOR: the default foreground everywhere, attributes only.

## T-13 Every exit signal is ours (review F1)
OpenTUI's exitSignals only call `destroy()` and never exit: closing the terminal (SIGHUP) left an orphan
at 100 % CPU that kept renewing the session lock. `exitSignals: []`; runTui handles SIGTERM, SIGHUP,
SIGQUIT, SIGABRT, SIGPIPE and SIGBUS itself on the SIGTERM path (engine.close → exit 128+n, the
--sandbox cleanup kept); a `destroy` listener closes the source if the renderer goes away any other
way; the source's methods are no-ops once the input is destroyed; writes after a hangup (EIO) are
caught.

## T-14 Nothing the Repl says is lost (review F2 and dups)
While the renderer is up every Repl line goes to the transcript AND tui.log (debug lines and errors
too, as the help says); the lines that arrive while the TUI shuts down, and the exit summary (why exit
1/3/130), are printed to stderr after the terminal is restored.

## T-15 The chat reads like a chat, not like the line REPL
- Answer status lines in the TUI carry no REPL hints (`/r swipe /c continue /e edit`): the hotkeys do
  that; and the finish / edited / hidden markers show once (in the status line, not before the text).
- Hotkey rows fit one line each (labels and descriptions shortened in HOTKEYS).
- Continue (Ctrl+O, /c) follows the REPL: a new block after the `/c` row, `…<last words>` then the
  addition, styled with the prose state of the whole text; when the answer is done the original card
  (if still mounted) is repainted from the final message (its marker updated). Never writes off-screen.
- A Repl row mid-answer (held line, notice) does not reset the prose styling of the answer.
- Ctrl+E with text typed in the input does not discard it: the status row says "send or clear the
  input first (Esc)" and nothing happens.
- Hints that name `rp-core chat` read `rp-core tui` inside the TUI (an optional Repl option; the REPL's
  bytes do not change).
- A long-running command (/probe --active, /preview of a big session) shows "working…" in the status
  row, and lines typed meanwhile show "queued: N".

## T-16 Smaller review fixes
Opening a big session mounts the newest LAYOUT.liveCards cards only (older history goes straight into
archive blocks); every string from a model, a file or a model id is sanitised before display (headers,
both panes); U+2028/U+2029 become line breaks; widths are measured in columns (Bun.stringWidth), not
UTF-16 units; streaming appends to the live text instead of re-sending the whole card when cheap;
Russian-layout Ctrl+letters also match under modifyOtherKeys (no baseCode: map the Cyrillic letter to
its key on the ЙЦУКЕН layout); an unterminated bracketed paste is bounded (Ctrl+C still works);
wall-clock frame thresholds move out of the default suite (RP_CORE_PERF=1).

## T-17 Levi's second look (Warp light theme, Ubuntu's GNOME Terminal) — 27.10
- **The input never leaves the chat column.** The Textarea sits in a row next to the label; without
  `flexShrink: 1` and `minWidth: 0` Yoga gave it the whole column, so the row was the label's width
  too wide and long input was drawn over the Agents pane (reproduced headless: row 62, label 12 +
  input 56). Test: type a long line at 100 and 140 columns, nothing of it in the right pane.
- **The input label is `you ›` / `edit ›`**, no padding (the REPL pads labels to the character's name
  width to align its columns; the transcript keeps that alignment, the input does not need it).
- **Mouse wheel ON by default.** With mouse reporting off, terminals turn the wheel into ↑/↓ in the
  alternate screen, which moved the cursor in the input ("scroll does not work"). Warp and most
  terminals select natively with Shift held while reporting is on (docs.warp.dev full-screen apps).
  F3 still turns it off; the left pane shows `Shift+drag  select`. And with an EMPTY input, ↑/↓ scroll
  the chat (3 lines), so a wheel turned into arrows scrolls too.
- **OpenTUI's own selection is readable and copies.** A plain drag (mouse on) is OpenTUI's selection:
  its default colours (black on its own bg) vanished on Ubuntu's aubergine background. Selection bg =
  palette 8, fg = the default foreground, on every selectable renderable. When a selection ends, the
  text is copied with OSC 52 (`renderer.copyToClipboardOSC52` or the escape itself; Warp, kitty,
  WezTerm, iTerm; VTE ignores it — Shift+drag works there) and the status row says "copied N chars".
- **`**bold**` renders bold** in the TUI's chat (asterisks dropped, as rendered markdown), streaming-safe
  (`**` split across deltas). The line REPL is unchanged.
- *(Third look, 27.10)* Italic drops its asterisks too: `*action*` is italic without them (a `*` opens
  before a non-blank character not preceded by a letter/digit, closes after a non-blank one not
  followed by a letter/digit; `5 * 3`, `f*ck`, a lone `*` stay visible). `/director show` prints the
  last directive in full, as the narrator got it (the `[DIRECTOR CONSTRAINTS …]` block) — in the line
  REPL too, on purpose.
- **One stop marker:** after Ctrl+C the dim `[stopped]` row is not printed when the status line shows
  `· stopped`.
- **/help in the TUI** lists the hotkey rows (keyRows) when the left pane is not visible (below 120
  columns or hidden by F2) instead of pointing at it (review finding 12); run.ts passes `{warp}` to
  both panes.

## T-11 Tests
Headless `createTestRenderer` (kittyKeyboard true; `pressKeys([...s])` for non-BMP); a `tuiRig` cloned
from `test/repl/kit.ts` `replRig` (scripted provider, fake clock); the repl-map §5 list (layout at
120/100/70; type+Enter+stream; pause+Ctrl+C stop; held line + refused edit; a smoke test per slash
command; inline /e; Director pane after a dirCall turn; tool line; /open and /fork; recovery notice;
lock refusal before the renderer; /quit mid-turn releases the lock), plus hotkeys on a Russian layout
(baseCode), sanitiser, sgrToChunks, archive folding. The real-pty check (pty_drive.py) is the lead's,
plus the user's look in Warp.

## Build units
- **Phase 1 `ports`** — src/cli/repl.ts, src/cli/repl-view.ts (new), src/cli/chat.ts; tests only if a
  new one is needed (no existing test may change).
- **Phase 2** (after Phase 1 is green), contract file `src/cli/tui/types.ts` written by the lead:
  - `host` — src/cli/tui/{app,source,keys,io,run}.ts, the `tui` command in src/cli/main.ts and
    `new --tui`, package.json/bun.lock (the pin), tests test/tui/{host,keys,lifecycle}.test.ts.
  - `chat` — src/cli/tui/{transcript,sgr,sanitize,turn-view}.ts, tests test/tui/{transcript,sgr,
    sanitize,stream}.test.ts.
  - `panes` — src/cli/tui/{models-pane,agents-pane,agents}.ts, tests test/tui/{panes,agents}.test.ts.
Rules as in M4: own files only, no Math.random/Date.now in src (systemClock), English, tests for
everything, FULL `bun test` before finishing, a contract note `.notes/tui-contract-<unit>.md`.
