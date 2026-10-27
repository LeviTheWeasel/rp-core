// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's frame (TUI decisions T-4, T-10): the renderer's settings, the three columns (Models,
// Chat, Agents), the chat's transcript, status row and input box, and which columns a width shows.
// The transcript's cards and the panes' contents belong to their own modules; this file only builds
// the boxes they fill.

import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type CliRendererConfig,
  type OptimizedBuffer,
  type Renderable,
} from '@opentui/core';
import { chunk } from './sgr.ts';
import { LAYOUT, type Theme, type Ui } from './types.ts';

/**
 * The renderer's settings (T-10, T-13, T-17): the Repl owns Ctrl+C (the key and SIGINT), OpenTUI
 * handles no signal at all (its handler only destroys the renderer and never exits: a closed terminal
 * left an orphan holding the session lock; runTui handles every exit signal itself), a click never
 * moves the focus off the input, an error never opens the console overlay, and the terminal's own
 * background stays. The mouse is ON by default (T-17): with reporting off, terminals turn the wheel
 * into ↑/↓ in the alternate screen, which moved the cursor in the input. A plain drag is then
 * OpenTUI's selection (sent with OSC 52; not under VTE), Shift+drag the terminal's own; F3 turns reporting off.
 */
export function rendererConfig(useMouse = true): CliRendererConfig {
  return {
    exitOnCtrlC: false,
    exitSignals: [],
    targetFps: 30,
    maxFps: 60,
    autoFocus: false,
    openConsoleOnError: false,
    useMouse,
  };
}

/** The Ui of types.ts plus what only the host touches: the input's label. */
export interface HostUi extends Ui {
  /** The row under the status line: label + input box. */
  inputRow: BoxRenderable;
  /** The prompt label left of the input (`you › `, `edit › `: no padding, T-17). */
  label: TextRenderable;
  setLabel(text: string): void;
  /** One status row line in a tone (the Repl's red for errors, dim for the rest). */
  setStatus(text: string, tone?: 'dim' | 'yellow' | 'red' | 'plain'): void;
  /** Re-measure the input after a frame: 1 to LAYOUT.inputMaxRows rows. */
  fitInput(): void;
}

/**
 * The colours of OpenTUI's own selection (a plain drag while the mouse is on, T-17) on a selectable
 * renderable: the terminal's palette 8 (bright black) behind the terminal's default foreground. Its
 * defaults (black on its own background) vanished on Ubuntu's aubergine background. The same under
 * NO_COLOR: a selection must show (as the cursor's grey does).
 */
export function selectionColours(theme: Theme): { selectionBg: RGBA; selectionFg: RGBA } {
  return { selectionBg: RGBA.fromIndex(8), selectionFg: theme.text };
}

/** No fill of its own: what is under it shows (the backdrop's default background). */
const TRANSPARENT = 'transparent';

/** A box's colours (T-12): border and title from the theme, never OpenTUI's own defaults (a white border, a light-blue focused one). */
const boxColours = (theme: Theme) =>
  ({ borderColor: theme.border, focusedBorderColor: theme.focusedBorder, titleColor: theme.text }) as const;

/**
 * Paints the whole screen with blanks in the theme's text and background colours before the
 * columns draw (T-12). OpenTUI clears each frame to blanks with a white rgb foreground: a cell no
 * renderable writes would otherwise be sent as white (`38;2;255;255;255` / `38;5;15`).
 */
function backdrop(theme: Theme): (this: Renderable, buffer: OptimizedBuffer) => void {
  let blank = '';
  return function (this: Renderable, buffer: OptimizedBuffer): void {
    if (blank.length !== this.width) blank = ' '.repeat(Math.max(0, this.width));
    for (let y = 0; y < this.height; y++) buffer.drawText(blank, this.x, this.y + y, theme.text, theme.background);
  };
}

/** Build the three columns under `renderer.root` and focus the input. */
export function createUi(renderer: CliRenderer, theme: Theme): HostUi {
  const root = new BoxRenderable(renderer, { id: 'root', flexDirection: 'row', width: '100%', height: '100%', renderBefore: backdrop(theme) });
  renderer.root.add(root);
  const side = { flexShrink: 0, border: true, flexDirection: 'column' as const, paddingX: 1, ...boxColours(theme) };
  const left = new BoxRenderable(renderer, { id: 'models', width: LAYOUT.left, title: ' Models ', ...side });
  const middle = new BoxRenderable(renderer, {
    id: 'chat',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: LAYOUT.middleMin,
    border: true,
    title: ' Chat ',
    flexDirection: 'column',
    ...boxColours(theme),
  });
  const right = new BoxRenderable(renderer, { id: 'agents', width: LAYOUT.right, title: ' Agents ', ...side });
  root.add(left);
  root.add(middle);
  root.add(right);

  const transcript = new ScrollBoxRenderable(renderer, {
    id: 'transcript',
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: 'bottom',
    paddingX: 1,
    viewportCulling: true,
    // The thumb in the border colour (OpenTUI's default track is a dark grey). The track is
    // transparent over the backdrop: an opaque fill would give its cells OpenTUI's white fg.
    scrollbarOptions: {
      trackOptions: { foregroundColor: theme.border, backgroundColor: TRANSPARENT },
      arrowOptions: { foregroundColor: theme.border, backgroundColor: TRANSPARENT },
    },
  });
  const text = { fg: theme.text, ...selectionColours(theme) } as const;
  const status = new TextRenderable(renderer, { id: 'status', height: 1, flexShrink: 0, marginLeft: 1, marginRight: 1, wrapMode: 'none', content: '', ...text });
  const inputRow = new BoxRenderable(renderer, { id: 'input-row', flexDirection: 'row', flexShrink: 0 });
  const label = new TextRenderable(renderer, { id: 'label', flexShrink: 0, marginLeft: 1, wrapMode: 'none', content: '', ...text });
  const input = new TextareaRenderable(renderer, {
    id: 'input',
    height: 1,
    flexGrow: 1,
    // T-17: without these Yoga gives the box the whole column next to the label, so the row was the
    // label's width too wide and long input was drawn over the Agents pane. The box takes exactly what
    // the label leaves: a basis of 0 (with the default 'auto' basis Yoga measures the wrapped text, and
    // once the box is several rows high that measure came out up to 4 columns wider than the room left).
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    wrapMode: 'word',
    // Dim text in the default foreground (a StyledText: a string placeholder gets no attributes).
    placeholder: new StyledText([chunk('Write your line… (Enter sends)', theme, { dim: true })]),
    placeholderColor: theme.text,
    textColor: theme.text,
    focusedTextColor: theme.text,
    // No input background (T-12): the row is marked by its `you ›` label. The box stays
    // transparent over the backdrop (an opaque fill would give its blank cells OpenTUI's white fg).
    cursorColor: theme.cursor,
    ...selectionColours(theme),
    // Merged over the defaults: Enter sends; Shift+Enter (kitty / CSI-u), Alt+Enter and Ctrl+J break
    // the line (a legacy terminal's Ctrl+J arrives as `linefeed`, a newline by default).
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'kpenter', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'return', meta: true, action: 'newline' },
      { name: 'j', ctrl: true, action: 'newline' },
    ],
  });
  inputRow.add(label);
  inputRow.add(input);
  middle.add(transcript);
  middle.add(status);
  middle.add(inputRow);

  const setLabel = (text: string): void => {
    if (label.isDestroyed) return;
    const tone = /^edit\b/.test(text) ? theme.yellow : theme.user;
    label.content = new StyledText([chunk(text, theme, { bold: true, fg: tone })]);
    label.width = Math.max(1, Bun.stringWidth(text));
  };
  const setStatus = (text: string, tone: 'dim' | 'yellow' | 'red' | 'plain' = 'dim'): void => {
    if (status.isDestroyed) return;
    const c =
      tone === 'plain'
        ? chunk(text, theme)
        : tone === 'dim'
          ? chunk(text, theme, { dim: true })
          : // Monochrome: a warning or an error stays visible through bold.
            chunk(text, theme, { fg: theme[tone], bold: theme.mono });
    status.content = new StyledText([c]);
  };
  const fitInput = (): void => {
    const w = input.width;
    if (w <= 0 || input.isDestroyed) return;
    const rows = input.editorView.measureForDimensions(w, 1000)?.lineCount ?? 1;
    const h = Math.max(1, Math.min(LAYOUT.inputMaxRows, rows));
    if (input.height !== h) input.height = h;
  };
  renderer.on('frame', fitInput);
  input.focus();
  return { renderer, left, middle, right, transcript, status, input, inputRow, label, setLabel, setStatus, fitInput };
}

/**
 * Which columns a width shows (T-4): from LAYOUT.allFrom all three, from LAYOUT.agentsFrom the chat
 * and the agents, below it the chat only. `manualHidden` (F2) hides both side panes at any width.
 */
export function applyWidth(ui: Pick<Ui, 'left' | 'right'>, width: number, manualHidden: boolean): void {
  ui.left.visible = !manualHidden && width >= LAYOUT.allFrom;
  ui.right.visible = !manualHidden && width >= LAYOUT.agentsFrom;
}
