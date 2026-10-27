# TUI polish (T-17), unit `host`: contract

Files: src/cli/tui/{app,run,source,keys,models-pane,agents-pane}.ts (io.ts, index.ts unchanged); tests
test/tui/{host,panes}.test.ts adjusted, test/tui/polish-host.test.ts new (16 tests). The line REPL is
untouched (test/repl unchanged). `bunx tsc --noEmit -p .` clean; full suite 4526 pass, 3 skip, 0 fail.

## What changed
- **Input width (app.ts).** The Textarea has `flexShrink: 1`, `minWidth: 0` AND `flexBasis: 0`. The
  probe's fix (shrink + minWidth) was not enough once fitInput makes the box several rows high: with the
  default 'auto' basis Yoga measured the wrapped text and the box came out up to 4 columns wider than
  the room left (100 columns, 3 rows: input x 8 + w 59 > the border at 63). With basis 0 it is exactly
  what the label leaves (62 − 1 − 6 = 55) at any height.
- **Label (source.ts).** New export `inputLabel(prompt)`: SGR stripped, whitespace collapsed, one
  trailing space: `you      › ` → `you › `, `edit › ` unchanged. TextareaSource.prompt() uses it, so
  setLabel and the edit-end restore get the short label. The transcript keeps the REPL's padding.
- **Mouse ON by default (app.ts).** `rendererConfig(useMouse = true)` (was false); runTui's default
  renderer and tuiRig's both use it. F3 still toggles; the pane's F3 row reads `mouse: on|off`.
- **Key rows (keys.ts).** `keyRows(extra)` moved here (models-pane.ts re-exports it, same list) and gained
  the row `Shift+drag  select` right after F3 (exported `SHIFT_DRAG`), always shown (true with the mouse
  on or off). Rows still fit 24 columns (label 10 + 1 + 6). New `tuiHelpLines(extra, keysShown)`:
  `[tuiHelpNote(true)]` when the left pane is on screen; else a note ending `; the keys:` and every
  keyRows row as `  <label><pad to widest + 2><description>`. tuiHelpNote unchanged.
- **↑ / ↓ (run.ts).** With an EMPTY input (plainText === ''), plain ↑ / ↓ scroll the transcript ScrollBox
  by `ARROW_SCROLL_LINES` (3) via `ui.transcript.scrollBy` (preventDefault, before the hotkeys); with
  text they stay the Textarea's. Exported `arrowScroll(k)` (−3 / +3 / 0; any modifier → 0).
- **Selection colours (app.ts).** Exported `selectionColours(theme)` = `{ selectionBg:
  RGBA.fromIndex(8), selectionFg: theme.text }`, also under NO_COLOR (a selection must show). Set on the
  status row, the label, the input Textarea, models-body, agents-body and agents-usage.
- **Copy (run.ts).** mountTui listens to the renderer's `selection` event (OpenTUI 0.7.0 emits it from
  finishSelection on mouse up with the Selection): non-empty `getSelectedText()` →
  `renderer.copyToClipboardOSC52(text)` → status `copiedText(n)` ("copied N chars", code points), or
  yellow `NOT_COPIED` when it returns false or throws (logged). Removed in dispose(). A click (empty
  selection) copies nothing.
- **/help (run.ts).** TuiView gets `keysShown: () => ui.left.visible` (view.ts's optional dep, wired by
  the chat unit: `TuiView.helpRows()` = `tuiHelpLines(extra(), keysShown())`). {warp} to both panes was
  already passed (lifecycle fixes).
- New exports (additive): app.ts `selectionColours`; keys.ts `keyRows`, `SHIFT_DRAG`, `tuiHelpLines`;
  source.ts `inputLabel`; run.ts `ARROW_SCROLL_LINES`, `arrowScroll`, `copiedText`, `NOT_COPIED`.

## OpenTUI 0.7.0 facts found on the way
- `copyToClipboardOSC52` writes `ESC ] 52 ; c ; <base64> ESC \` through the native session, and THROWS
  `NativeError ot_session_clipboard failed: InvalidPhase` until `setupTerminal()` ran (createTestRenderer
  never runs it; createCliRenderer does). Hence the try/catch. `isOsc52Supported()` is true while the
  capability is 'unknown' (VTE: sent and ignored, nothing to detect).
- A headless renderer's bytes can be recorded: `createTestRenderer({ stdout: <Writable with isTTY,
  columns, rows, getColorDepth>, bufferedOutput: 'stdout' })` + `await renderer.setupTerminal()` (7 ms).
- Selection colours: TextRenderable and Textarea options `selectionBg` / `selectionFg` (RGBA); selected
  cells then capture as bg intent 'indexed' slot 8, fg intent 'default'.

## Tests (each checked to fail with its change reverted: scratchpad polish/mutate.py over a copy of the tree)
- polish-host.test.ts: long input at 100 and 140 columns (the Agents pane's cells identical before and
  after typing, the box inside the chat border, 1 < rows < 6, then exactly 6); inputLabel; the frame's
  `│ you › Write your line` and `│ edit › Карта готова.`; mouse on by default + both pane rows + F3 off;
  keyRows (Shift+drag after F3, same list as the pane's, 24-column fit); arrowScroll; ↑/↓ by 3 with an
  empty input, cursor movement with text; selection colours on all six renderables; OSC 52 bytes in the
  recorded output + `copied 4 chars` (a click copies nothing); NOT_COPIED without a set-up terminal;
  copiedText; tuiHelpLines; /help at 130 (note), 100 and 130 + F2 (key rows) through the real view.
  Mutations caught: shrink/basis/minWidth, basis alone, label, mouse default, Shift+drag row, arrows,
  selectionColours, status/label, input, agents-usage, copy listener, keysShown.
- host.test.ts: the TextareaSource label test expects `you › `; the two stop tests wait for `· stopped]`
  (the chat unit's one-stop-marker change removed the `[stopped]` row they waited for).
- panes.test.ts: KEYS has the `Shift+drag select` row; the T-15 row count is 3 + HOTKEYS + 1.

## For the lead
- Two `selectionColours(theme)` exist (app.ts, mine; transcript.ts, the chat unit's) with the same
  values; one could import the other.
- Not checked in a real pty: mouse modes on at start, OSC 52 in Warp / kitty, Shift+drag native
  selection in Warp and GNOME Terminal (the lead's / Levi's look).
- The models pane lists one more row (Shift+drag): on a short terminal its last rows are cut first,
  as before.
