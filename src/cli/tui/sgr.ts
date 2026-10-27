// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The Repl's styled strings as OpenTUI text chunks. The Repl styles with a closed SGR set
// (repl-render.ts SGR, makeStyle, createProseStyler): 1 bold, 2 dim, 3 italic, 22 bold+dim off,
// 23 italic off, 31 red, 33 yellow, 39 default fg, and 0 (or empty) reset. Those become attributes
// and theme colours (the mono theme's colours are all the default foreground, so only the attributes
// remain); every chunk carries an explicit fg (T-12). Every other sequence is dropped, never
// shown, and the text between them is sanitised (sanitize.ts). Also the small chunk helpers the
// transcript builds its cards with.

import { TextAttributes, type RGBA, type TextChunk } from '@opentui/core';
import type { Theme } from './types.ts';
import { walk } from './sanitize.ts';

type Fg = 'default' | 'yellow' | 'red';

interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  fg: Fg;
}

const plain = (): SgrState => ({ bold: false, dim: false, italic: false, fg: 'default' });

// ---- chunks ------------------------------------------------------------------------------------------

export interface ChunkStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  /** A theme colour; without one the chunk is theme.text (the terminal's default foreground). */
  fg?: RGBA;
}

/**
 * One chunk in a style. Its fg is ALWAYS set (T-12): `st.fg`, else theme.text, the terminal's
 * default foreground; dim text is the DIM attribute on it. A chunk with no fg would fall back to
 * the TextRenderable's own fg, OpenTUI's white by default.
 */
export function chunk(text: string, theme: Theme, st: ChunkStyle = {}): TextChunk {
  const attributes =
    (st.bold ? TextAttributes.BOLD : 0) | (st.dim ? TextAttributes.DIM : 0) | (st.italic ? TextAttributes.ITALIC : 0);
  const c: TextChunk = { __isChunk: true, text, fg: st.fg ?? theme.text };
  if (attributes) c.attributes = attributes;
  return c;
}

function sameStyle(a: TextChunk, b: TextChunk): boolean {
  if ((a.attributes ?? 0) !== (b.attributes ?? 0)) return false;
  if (a.bg !== b.bg) return false;
  if (a.fg === b.fg) return true;
  return a.fg !== undefined && b.fg !== undefined && a.fg.equals(b.fg);
}

/** Appends `more` to `into`, merging neighbours of one style (fewer chunks per streamed card). */
export function appendChunks(into: TextChunk[], more: readonly TextChunk[]): void {
  for (const c of more) {
    if (c.text === '') continue;
    const last = into[into.length - 1];
    if (last && !last.link && !c.link && sameStyle(last, c)) into[into.length - 1] = { ...last, text: last.text + c.text };
    else into.push(c);
  }
}

// ---- SGR → chunks ------------------------------------------------------------------------------------

function stateChunk(text: string, st: SgrState, theme: Theme): TextChunk {
  return chunk(text, theme, {
    bold: st.bold,
    dim: st.dim,
    italic: st.italic,
    ...(st.fg === 'yellow' ? { fg: theme.yellow } : st.fg === 'red' ? { fg: theme.red } : {}),
  });
}

/** Apply one SGR sequence's parameters; anything outside the closed set is ignored. */
function applySgr(params: string, st: SgrState): void {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    switch (c) {
      case 0:
        Object.assign(st, plain());
        break;
      case 1:
        st.bold = true;
        break;
      case 2:
        st.dim = true;
        break;
      case 3:
        st.italic = true;
        break;
      case 22:
        st.bold = false;
        st.dim = false;
        break;
      case 23:
        st.italic = false;
        break;
      case 31:
        st.fg = 'red';
        break;
      case 33:
        st.fg = 'yellow';
        break;
      case 39:
        st.fg = 'default';
        break;
      case 38:
      case 48:
        // Extended colours: skip their arguments so they are not read as codes.
        k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0;
        break;
      default:
        break;
    }
  }
}

const SGR_RE = /^(?:\x1b\[|\x9b)([0-9;:]*)m$/;

export interface SgrReader {
  /** Chunks for the next piece of a styled stream; the style state carries over between pieces. */
  push(s: string): TextChunk[];
}

/**
 * A stateful converter for one styled stream (a streamed answer after the prose styler). Each
 * piece must hold whole sequences (the Repl's styles and the prose styler never split one).
 */
export function createSgrReader(theme: Theme, o: { warp?: boolean } = {}): SgrReader {
  const st = plain();
  return {
    push(s: string): TextChunk[] {
      const out: TextChunk[] = [];
      walk(
        s,
        o.warp ?? false,
        (t) => appendChunks(out, [stateChunk(t, st, theme)]),
        (raw) => {
          const m = SGR_RE.exec(raw);
          if (m) applySgr(m[1] ?? '', st);
        },
      );
      return out;
    },
  };
}

/** A Repl string in the closed SGR set as chunks (pure; unknown sequences dropped, text sanitised). */
export function sgrToChunks(s: string, theme: Theme, o: { warp?: boolean } = {}): TextChunk[] {
  return createSgrReader(theme, o).push(s);
}
