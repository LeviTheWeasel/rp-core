// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's two themes (TUI decisions T-12) as OpenTUI colours. No hex colour anywhere: plain text is
// RGBA.defaultForeground() (sent as SGR 39, the terminal's own text colour), accents are
// RGBA.fromIndex(n) (sent as `38;5;n`, the terminal's own palette), backgrounds
// RGBA.defaultBackground() (SGR 49). So a light and a dark terminal theme both work, without
// detecting which one is on. Dim text is the DIM attribute on the default foreground. The Theme
// type is in types.ts (type-only, so loading the contract never loads the native library); this
// module is loaded only on the `tui` command path.

import { RGBA } from '@opentui/core';
import type { Theme } from './types.ts';

/** ANSI palette slots (the terminal's theme decides the actual colours). */
const ANSI = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, brightBlack: 8 } as const;

const text = RGBA.defaultForeground();
const background = RGBA.defaultBackground();
/** OSC 12 needs a concrete colour (types.ts Theme.cursor): the palette's bright black as the value. */
const cursor = RGBA.defaultForeground(RGBA.fromIndex(ANSI.brightBlack));

export const THEME: Theme = Object.freeze({
  text,
  yellow: RGBA.fromIndex(ANSI.yellow),
  red: RGBA.fromIndex(ANSI.red),
  accent: RGBA.fromIndex(ANSI.blue),
  user: RGBA.fromIndex(ANSI.green),
  char: RGBA.fromIndex(ANSI.magenta),
  border: RGBA.fromIndex(ANSI.brightBlack),
  focusedBorder: RGBA.fromIndex(ANSI.blue),
  background,
  cursor,
  mono: false,
});

/** NO_COLOR: the default foreground everywhere; bold / dim / italic carry the tones. */
export const MONO_THEME: Theme = Object.freeze({
  text,
  yellow: text,
  red: text,
  accent: text,
  user: text,
  char: text,
  border: text,
  focusedBorder: text,
  background,
  cursor,
  mono: true,
});
