# TUI review fixes, unit `chat`: contract

Decisions T-15 / T-16 (`.notes/tui-decisions.md`); review findings 4, 7, 8, 9, 10, 14 (card headers), 16,
17, 18, 21 and the view.ts half of 3 / 6 / 19. Files: src/cli/tui/{transcript,turn-view,sanitize,view}.ts
(sgr.ts unchanged: U+2028 comes through `walk`); tests test/tui/{transcript,stream,sanitize,e2e}.test.ts.
types.ts unchanged. The line REPL is untouched (no file outside src/cli/tui changed).

## What changed
- **Status lines (T-15).** `view.ts` `answerStatus(m, style, trace?)` (exported): the REPL's statusItems in
  `  [ … ]`, dim, no `/r swipe /c continue /e edit` hints; a greeting's line also says finish ≠ end /
  edited / hidden (statusItems gives a greeting only `greeting i/n`). Used for status(), message() and
  showPath's statusOf.
- **Markers once (T-15).** A card with a status row shows no `[length] [edited] [hidden] …` before its text:
  showPath builds such cards without them; card() keeps them until status() links a row, which then
  redraws the card bare (`Entry.bare`); a live turn's card never shows them (finalise repaints without).
  Cards without a status row (player's messages, /e's edited message) keep them. `CardLook.markers?`
  (default true), `cardMarkers(m)`.
- **status() placement.** The newest card's status row is replaced only while it is the last entry;
  otherwise a NEW row is appended (REPL-like, never rewrites off-screen). Old test changed accordingly.
- **Continue (T-15, findings 4, 8, 9).** Always a new block after the `/c` row: `Name › …last words` + the
  addition (the in-place path is gone). The prose styler and SGR reader are seeded with `continueFrom`,
  so an addition after a stop inside `*…*` starts italic; the repaint of an addition uses
  `proseChunks(text, theme, warp, before)` (new optional 4th param). On done/stopped(message) the card
  it continued (the newest card of that id, or that card's own origin; if still mounted) is repainted
  from the committed message, and `transcript.status()` also rewrites that card's status row
  (`Entry.origin`). `…last words` keeps the trailing space of the text before it.
- **Prose state over the whole answer (T-15, finding 7).** interject(), notices and side lines no longer
  call `prose.end()`; only done/stopped/failed/conflict/finish do. The D-55 `\n` that is not shown is
  still fed to the styler. A kept streamed card now styles as a card of the stored text.
- **Lazy history (T-16, finding 10).** showPath builds the newest messages up to `LAYOUT.liveCards`
  entries (a card and its status row stay together) as renderables, plus at most `HISTORY_BATCH` (300,
  exported) messages before them straight into archive blocks. Older messages are not built: a dim row
  at the top says `⋯ N earlier messages · Ctrl+Home loads more`; `scroll('top')` builds the next
  HISTORY_BATCH into archive blocks at the top (row updated, removed at 0) and scrolls to 0. PgUp / the
  wheel do not load (the row says Ctrl+Home). Archive blocks now draw their leading gap as marginTop.
- **Streaming cost (T-16, finding 18).** `TurnHost.defer(e, build)` (new; transcript.ts the only
  implementer): a turn's redraws are coalesced and applied once per frame by a renderer frame callback
  (+ `requestRender()`); `set()` cancels a pending one; `release()` / fold() flush first. Deltas cost
  O(delta) now; the frame pays one native set of the card.
- **Sanitising and widths (T-16, findings 14 headers, 16, 17).** `walk()` turns U+2028 / U+2029 into
  `\n` (sanitize, the stream sanitiser and the SGR reader alike). `headerChunks(label, role, theme,
  warp = false)` sanitises the label (new optional param; messageChunks / LiveTurn pass warp).
  `sanitize.ts` `displayLabels(name, {warp})` (exported): the REPL's labels() but sanitised, padded and
  cut in terminal columns by whole graphemes (equals labels() for ASCII names). TuiView uses it for its
  names (and passes `label: names.char` to the turn); the continuation indent is
  `Bun.stringWidth(label) + 3`.
- **view.ts half of findings 3 / 6 / 19.** `TuiView.line()` still calls exactly what it called
  (transcript.system, + the TUI help row). New `get lastSaid(): readonly string[]` — the Repl's lines
  since the player's last line or the last idle() — for the host to print after restore (T-14). The
  turn's own `failed` / `conflict` rows (drawn by the turn view, not through line()) go to `d.log`.
  Optional `TuiViewDeps.warp` (default false).
- **Tests (finding 21).** Wall-clock thresholds (e2e 2 000-message frames/open, transcript 2 000-card
  frame) only under `RP_CORE_PERF=1`; the structural bounds stay. The e2e F3 test reads the F3 row by
  regex (the lead's shorter HOTKEYS changed its text).

## Measurements (headless; scratchpad tui-review/mem5000.ts, stream10k.ts)
- 5 000 messages × 800 chars, showPath: 654 → 81 ms; first frames 188 → 20 ms; transcript RSS +352 → +53 MB.
- 5 000 × 2 000 chars: 1 266 → 160 ms; 359 → 38 ms; +598 → +102 MB.
- e2e (whole host, engine open included): 5 000 × 800 open ≈ 165–185 ms, +56–87 MB.
- Streaming 4 000 words (32k chars, a frame every 5 deltas): push per delta, last 10 % median 0.99 →
  0.015 ms; frame 1.6 → 2.7 ms (the one set moved into it); total 3.3 → 1.5 s.

## Tests
New / changed: stream 26 (continue ×7, prose state ×3, widths/headers ×2, coalescing ×1, markers in
the gap repaint), transcript 21 (status placement, markers once + no hints, U+2028, lazy history ×2,
TuiView ×3), sanitize 13 (U+2028, displayLabels ×3), e2e 24 (continue after F1, held line italics,
stop + Ctrl+O, 5 000-message open, recovery marker). All 29 new/changed regression tests were run on
the original chat files (+ export shims) and fail there. `bunx tsc --noEmit -p .` clean; full suite
4483 pass, 3 skip, 0 fail (an earlier full run under parallel load timed out once in
test/structured/narrate-agent.test.ts, not a TUI file; it passes alone and in the rerun).

## For the lead / other units
- run.ts (host/lifecycle) may pass `warp` to TuiView (`warp: env.TERM_PROGRAM === 'WarpTerminal'`), so
  label padding counts what Warp shows (ZWJ dropped); without it only Warp + ZWJ-emoji names pad wrong.
- run.ts can print `view.lastSaid` to io.err after restore (T-14).
- The input box's `you › ` label comes from the Repl's prompt (REPL labels by UTF-16 length); for CJK
  names it may differ by a column from the transcript's `you › ` echo.
- Not done: finding 12 (TUI_HELP points to the left pane below 120 columns) — not in this unit's list.
