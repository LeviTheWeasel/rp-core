# TUI fixes, unit `panes` (T-15, T-16; review findings 12, 14 panes part, 15; live run "Narrator / Narrator")

Files: src/cli/tui/{keys,models-pane,agents-pane}.ts (agents.ts unchanged: every pane string already ends
in fitLine); tests test/tui/{keys,panes,colors}.test.ts. types.ts and the REPL untouched.

## What changed
- **T-15 key rows** (models-pane.ts): one row per key, never split. The description column is one space
  after the widest label, moved left only as far as the widest description needs (24 columns → column
  11, labels ≤ 10); a label as wide as the column (Shift+Enter under kitty) gets one space. F3 reads
  `mouse: on|off` (13-column limit). New export `keyRows(extra): [label, description][]` (Enter, the
  newline key, Ctrl+C, then HOTKEYS) — the one list the pane shows; a /help listing can reuse it.
- **newlineKey(false)** (keys.ts) is `Alt+Enter` (was `Alt+Enter / Ctrl+J`, which could not fit a row);
  kitty stays `Shift+Enter`. Ctrl+J still works (the `tui` help names it).
- **Title = character** (live run): when the session title equals the character name (after cleaning,
  case and spaces ignored) the title row is dropped and the name shows once, as `Name · you: Persona`
  in the character's colour. A new session's default title is the character's name, so this is common.
- **T-16 sanitise** (agents-pane.ts): `fitLine` (every row of both panes) runs the chat unit's
  `sanitize()` — whole CSI/OSC/DCS sequences go, not just the ESC; tab → two spaces; `\n`, U+2028,
  U+2029 → a space; under Warp ZWJ / VS16 / skin tones go. Widths stay Bun.stringWidth, cuts by
  grapheme. New exports: `PaneOptions { warp?: boolean }`, `flatText(s, o)`, `paneWarp(o)`.
  Additive optional last parameters: `fitLine(line, width, o?)`, `fitWithSuffix(…, o?)`,
  `agentsLines(s, width, o?)`, `usageLines(s, width, o?)`, `modelsLines(b, extra, width, o?)`,
  `createModelsPane(ui, theme, o?)`, `createAgentsPane(ui, theme, clock, o?)`. Without `o.warp` the
  create* functions read TERM_PROGRAM from process.env (what run.ts does when no env is injected).
- **T-16 Russian Ctrl+letters under modifyOtherKeys** (keys.ts): a non-Latin letter with NO baseCode
  matches by its key on the ЙЦУКЕН layout (`russianKey()`, exported; either case; ё → `). A baseCode,
  when sent (kitty), still wins. `isInterruptKey`: ctrl+с without baseCode is Ctrl+C, so run.ts's
  interrupt path (checked before hotkeyAction) works on both protocols; contract unchanged.
- **Help pointer** (finding 12): `tuiHelpNote(keysShown: boolean)` in keys.ts — shown: "…; the hotkeys
  are listed on the left (F2 hides the side panes)."; hidden: "…; F2 shows the hotkeys."

## For the owners of other files (not done here: outside this unit)
- view.ts: replace the TUI_HELP constant with `tuiHelpNote(<left pane visible>)` (e.g. a
  `keysShown?(): boolean` dep from run.ts: `() => ui.left.visible`). NOTE: below LAYOUT.allFrom
  applyWidth (app.ts) never shows the left pane, even after F2 — the note is only true if F2 can bring
  it up there (or list `keyRows()` under /help instead when the width is < 120).
- run.ts: pass the injected env's Warp flag to the panes like the transcript:
  `o.parts.models(ui, theme, { warp })`, `o.parts.agents(ui, theme, clock, { warp })` (TuiParts types
  gain the optional parameter).
- test/tui/e2e.test.ts:657/660 (F3 test) still expect the old row: `'F3     mouse wheel: off'` →
  `'F3         mouse: off'`, `rig.until('mouse wheel: on')` → `rig.until('mouse: on')`.

## Tests (each new one checked to fail on the pre-fix sources)
- panes.test.ts: KEYS rows rewritten (one row each, column 11); T-15 alignment at 24 (both newline keys)
  and 26 columns + the HOTKEYS width limits; title = character shown once (also the real-Repl test: a new
  session titled 'Мира'); models pane sanitised (CSI, OSC, DCS, 8-bit CSI, U+2028, Warp ZWJ through
  `createModelsPane(…, { warp: true })`); agents pane sanitised (tool args, Director summary, memory
  name, agent reason; Warp on/off); fitLine sanitises and never splits a ZWJ emoji.
- keys.test.ts: modifyOtherKeys plain objects (к п щ у в, capitals, shift, unmapped ф, Greek, baseCode
  wins); the full ЙЦУКЕН table; ctrl+с interrupt without baseCode; `\x1b[27;5;cp~` through the headless
  renderer's parser; newlineKey; tuiHelpNote.
- colors.test.ts: the dim-description probe uses 'guided reroll' (the old 'swipe (new version)' is gone).
