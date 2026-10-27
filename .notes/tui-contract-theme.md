# TUI contract: theme (T-12, colours follow the terminal's theme)

Bug: under Warp's light theme all plain text was invisible. OpenTUI draws text with no explicit fg
as rgb white (`38;5;15` in 256 colours, `38;2;255;255;255` in truecolor).

## What changed
- `src/cli/tui/types.ts`: `Theme` is RGBA-typed (`import type { RGBA }`, no runtime import of
  @opentui/core). Fields: `text, yellow, red, accent, user, char, border, focusedBorder, background,
  cursor, mono`. Removed: `dim` (dim = the DIM attribute on `text`), `bold`, `inputBg`. THEME and
  MONO_THEME moved out of types.ts.
- `src/cli/tui/theme.ts` (new): THEME = text `RGBA.defaultForeground()` (SGR 39), background
  `RGBA.defaultBackground()` (SGR 49), user `fromIndex(2)`, char 5, accent 4, yellow 3, red 1, border 8,
  focusedBorder 4. MONO_THEME = the default foreground for every colour (attributes only). No hex.
  Importers updated: run.ts and the tests (chat-kit, sgr, transcript, panes, e2e).
- `sgr.ts`: `chunk()` ALWAYS sets fg (`st.fg ?? theme.text`); `ChunkStyle.fg` is an RGBA. The hex
  helpers `rgba()` / `colour()` are gone. Mono needs no special case: its colours are all default.
- `agents-pane.ts`: `chunkOf` builds through `chunk()`: dim = DIM + text; mono keeps the old mapping
  (yellow → italic, red → bold). Newline chunks carry fg. Both TextRenderables have `fg: theme.text`.
- `models-pane.ts`: TextRenderable `fg: theme.text`. Hotkey labels are now accent (4) + bold (were bold
  in the default colour), per the T-12 brief.
- `transcript.ts`: every card / row / archive TextRenderable has `fg: theme.text`; the echo label is
  recoloured in mono too (it is the default fg there).
- `app.ts`:
  - Boxes: `borderColor` border (8), `focusedBorderColor` focusedBorder (4), `titleColor` text (titles
    were drawn in the border colour; now the default fg, readable on both themes).
  - Status row and input label: `fg: theme.text`; setStatus / setLabel build chunks with `chunk()`.
  - Textarea: `textColor` / `focusedTextColor` / `placeholderColor` = text; placeholder is a
    StyledText chunk with DIM (a string placeholder gets no attributes); no background options (see
    below); `cursorColor` = theme.cursor.
  - ScrollBox: `scrollbarOptions` track/arrow fg = border (8), bg transparent.
  - Root box: `renderBefore: backdrop(theme)` paints every cell as a blank in text fg / default bg.

## OpenTUI 0.7.0 facts found on the way (pty + headless)
- The frame is cleared to blanks with an rgb WHITE fg. Cells no renderable writes (pane interiors,
  past a line's end) went out as `38;2;255;255;255` / `38;5;15`. Hence the backdrop (H drawText calls
  per frame; the 2 000-message streaming bench is unchanged, median ~1 ms).
- An OPAQUE fill (Textarea backgroundColor, scrollbar track backgroundColor, even
  `defaultBackground()`) resets its blank cells' fg to rgb white. Those fills stay transparent, so the
  backdrop's default bg shows through: no input background, as T-12 wants.
- A TextRenderable with no fg = rgb white; a chunk with no fg takes the renderable's fg. Both are set.
- The cursor colour is always sent as OSC 12 `#rrggbb` from the RGB (intent ignored):
  `defaultForeground()` → `]12;#ffffff` (white cursor on a light theme; the old code sent it too).
  theme.cursor = `RGBA.defaultForeground(RGBA.fromIndex(8))`: intent default, value #808080, visible
  on light and dark. OpenTUI resets it at exit (`]12;default`, `]112`). Keeping the terminal's own
  cursor colour would need `renderer.getPalette()` (detection) — not done.
- `captureSpans()` keeps the intent: `span.fg.intent` is 'default' | 'indexed' | 'rgb', `.slot` the
  palette index.

## Tests
- New `test/tui/colors.test.ts` (4 tests, whole TUI via tuiRig at 130×34): every span of each frame
  (opening with placeholder; echo + Director planning…; card + director side line + status line +
  Director record; /help rows + scrollbar thumb + typed input; native tool line in card and Agents; red
  `✗` failure row) has no rgb fg (OpenTUI's white is the only source) and a default bg; plain text
  has intent 'default' (dim = DIM attribute), accents the indexed theme colours; NO_COLOR: every fg
  'default'. Mutation-checked: dropping the backdrop, or chunk + renderable fg, fails it.
- Adjusted (old hex assertions): sgr.test.ts (chunks now carry `fg: THEME.text`; `dimfg` is gone, dim
  is the attribute; mono chunks are default-fg), transcript.test.ts and e2e.test.ts (compare to the
  RGBA theme values instead of `rgba(hex)`; mono header asserts intent 'default'), panes.test.ts
  (`RGBA.fromHex(THEME.x)` → THEME.x; 'turn 40' is DIM + default fg instead of a grey hex), e2e
  NO_COLOR (was "none of the hex theme colours"; now "every fg and bg intent is 'default'", stronger).
- pty (`scratchpad/tui-theme/drive_tui.py`, truecolor and a 256-colour copy without COLORTERM): SGR
  set is only 0/1/2/3, 39, 49, `38;5;{2,3,4,5,8}`; zero `38;5;15`, `38;2;`, `48;2;`; OSC 12 is
  `#808080`. `bunx tsc --noEmit -p .` clean; full `bun test`: 4422 pass, 3 skip, 0 fail.

## Left as is
- Text selection colours (only reachable with F3 mouse on and a drag) use OpenTUI's defaults.
