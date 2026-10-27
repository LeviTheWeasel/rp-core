# TUI polish (T-17), unit `chat`: contract

Files: src/cli/tui/{turn-view,transcript,view}.ts (sgr.ts, sanitize.ts unchanged); tests
test/tui/{stream,e2e}.test.ts changed, test/tui/polish-chat.test.ts new (23 tests). The line REPL is
untouched (createProseStyler unchanged; test/repl unchanged).

## What changed
- **`**bold**` (turn-view.ts).** New exports `createChatStyler(): ChatStyler` (ProseStyler + `flush()`,
  `seed(before)`) and `visibleText(text)`. The REPL's prose styler with markdown bold on top: a run of
  `*` is held until the next character; `**` opens bold before a non-blank char / closes an open bold
  after one (asterisks dropped, SGR 1 / 22 go to the SGR reader); `***` = the action's `*` + bold (the
  visible `*` never bold); other runs (`*`, `****`, `** ` …) go to createProseStyler as before (a lone
  `*` italic, asterisks kept). A newline ends an open bold. Any split of the text == the whole.
  proseChunks (cards, archive, repaints) and LiveTurn use it. Streaming: the side-line branch
  flushes the held run onto the text line before the side line (the D-55 `\n` would drop it);
  endText draws a run still held; a continue `seed()`s `continueFrom`, so a `*` the text before ends
  with is not drawn again in the addition, and `…last words` use visibleText (`**` dropped).
- **One stop marker (turn-view.ts).** `stopped` with a message whose `gen.finish === 'stopped'` prints no
  `[stopped]` row (the Repl's status line under it says `· stopped`); `[stopped] nothing had arrived…`
  and a kept message with another finish keep the row.
- **Selection (transcript.ts).** `selectionColours(theme)` (exported): `selectionBg` RGBA.fromIndex(8),
  `selectionFg` theme.text, on every transcript TextRenderable (cards, rows, live cards, archive blocks,
  the `⋯ N earlier messages` row). The mono theme keeps the palette-8 background (else invisible).
  Checked headless: selected cells are bg indexed 8, fg intent default.
- **/help (view.ts).** `TuiViewDeps.keysShown?(): boolean` (optional, default true) and
  `TuiView.helpRows()`: under the Repl's help, keys.ts `tuiHelpLines(extra(), keysShown())` (the
  host's helper) as dim system rows: the note pointing left, or the note + every key row. run.ts
  already passes `keysShown: () => ui.left.visible`. The old TUI_HELP constant is gone.

## Tests
- polish-chat.test.ts: styler (bold, in speech, `***` cases, newline, every 3-way split, held runs /
  flush / seed, visibleText, REPL styler unchanged), cards and streaming (split `**`, `***`, lone `*`,
  side line, continue + last words), selection (colour + NO_COLOR spans, every renderable incl.
  archive and the earlier-messages row, a live card), /help (TuiView hidden / shown / no dep; e2e at
  100 columns, 130 columns, 130 + F2).
- stream.test.ts: the kept-partial stop test now expects no `[stopped]` row and the status line
  (`  [swipe 1/1 · stopped]`); new guard: a kept answer with finish `end` keeps the row.
- e2e.test.ts:200: waits for `· stopped]`, the status row right under the card, no `[stopped]` (T-17).
  Also updated for the host's T-17 behaviour (e2e is this unit's file): the input label is `you ›`
  (layout ×3, /open), the mouse is ON by default and F3 turns it off (F3/F2 test).
- Every changed/new test of the changes was run on the original chat files (+ export shims) and
  fails there (19 + e2e:200); the invariants (lone `*` == REPL, any split, REPL styler, stop row with
  finish `end`, pane-shown note) pass on both, as guards. tsc clean; full suite 4526 pass, 3 skip, 0 fail.
