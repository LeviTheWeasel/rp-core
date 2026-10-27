// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The left "Models" pane (TUI decisions T-5, T-6, T-15, T-16): the session, the narrator's and the
// Director's bindings from the Repl's banner facts, then the keys. One row per item, cut to the pane's
// width with an ellipsis (fitLine: sanitised, measured in terminal columns), never a wrap into the
// next item. The keys are one row each, their descriptions in one aligned column.

import { TextRenderable } from '@opentui/core';
import type { DirectorRecord } from '../../agents/director/types.ts';
import type { BannerInfo } from '../repl-view.ts';
import { toolsWord } from '../repl-render.ts';
import { fitLine, flatText, paneText, paneWarp, PANE_TEXT_WIDTH, textWidth, type Line, type PaneOptions, type Seg } from './agents-pane.ts';
import { selectionColours } from './app.ts';
import { keyRows } from './keys.ts';
import type { ModelsPaneApi, Theme, Ui } from './types.ts';

export interface ModelsExtra {
  /** The Director's record at the head (agents.ts recordAt): the profile of the last plan. */
  record?: DirectorRecord;
  /** The active newline key as the left pane shows it (keys.ts newlineKey: 'Shift+Enter' only under kitty/CSI-u, else 'Alt+Enter'). */
  newlineKey: string;
  /** F3: mouse reporting on (wheel scrolling, OpenTUI's own selection; the default, T-17). */
  mouse: boolean;
}

/** A window size in the banner's words: 16384 → 16k, 200000 → 200k, unknown → ≤cap or ?. */
export function windowText(window: number | null, cap?: number): string {
  const k = (n: number): string => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
  if (window !== null) return k(window);
  return cap !== undefined && cap > 0 ? `≤${k(cap)}` : '?';
}

/** The key rows (keys.ts; re-exported here, where the pane lists them). */
export { keyRows } from './keys.ts';

/**
 * The keys, one row each (T-15). The descriptions share one column: a space after the widest label,
 * moved left as far as the widest description needs to fit; a label as wide as that column or wider
 * (Shift+Enter in 24 columns) is followed by one space. A row that still does not fit is cut.
 */
function keyLines(rows: readonly [string, string][], width: number, o: PaneOptions): Line[] {
  const widest = (i: 0 | 1): number => Math.max(0, ...rows.map((r) => textWidth(r[i])));
  const column = Math.max(1, Math.min(widest(0) + 1, width - widest(1)));
  return rows.map(([label, description]) => {
    const lw = textWidth(label);
    // The key in the accent colour (T-12), bold; its description dim.
    const gap = ' '.repeat(lw < column ? column - lw : 1);
    return fitLine([{ text: label, tone: 'accent', bold: true }, { text: gap, tone: 'text' }, { text: description, tone: 'dim' }], width, o);
  });
}

/** The same text after cleaning, ignoring case and runs of spaces ('Narrator' and ' narrator '). */
const sameName = (a: string, b: string, o: PaneOptions): boolean => {
  const norm = (s: string): string => flatText(s, o).trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
};

/** The pane's rows for this banner. `o.warp`: the sanitiser's Warp drops (T-10). */
export function modelsLines(b: BannerInfo, extra: ModelsExtra, width: number, o: PaneOptions = {}): Line[] {
  const lines: Line[] = [];
  const push = (l: Line): void => void lines.push(fitLine(l, width, o));
  const name = (text: string): Seg => ({ text, tone: 'accent', bold: true });
  const h = b.header;

  /** A name or title from a file, trimmed; undefined when nothing visible is left after cleaning. */
  const shown = (s: string | undefined): string | undefined => (s !== undefined && flatText(s, o).trim() !== '' ? flatText(s, o).trim() : undefined);
  const character = shown(h.cast.character.name) ?? 'them';
  const title = shown(h.title) ?? h.id;
  // A session titled after its character (the live run's 'Narrator' / 'Narrator') shows the name once.
  if (!sameName(title, character, o)) push([{ text: title, tone: 'bold' }]);
  const persona = shown(h.cast.persona?.name);
  push([{ text: character, tone: 'char' }, ...(persona ? [{ text: ' · you: ', tone: 'dim' } as Seg, { text: persona, tone: 'user' } as Seg] : [])]);

  lines.push([]);
  push([name('Narrator')]);
  push([{ text: `${b.narrator.conn}:${b.narrator.model}`, tone: 'text' }]);
  push([{ text: `ctx ${windowText(b.window, b.cap)} · tools ${toolsWord(b.tools)}`, tone: 'dim' }]);
  if (b.override) push([{ text: `(${b.override.plays})`, tone: 'yellow' }]);

  lines.push([]);
  const d = b.director;
  if (!d) push([name('Director'), { text: ' · ', tone: 'dim' }, { text: 'off', tone: 'dim' }]);
  else {
    push([name('Director')]);
    push([{ text: `${d.conn}:${d.model}`, tone: 'text' }]);
    if (d.follows) push([{ text: 'follows narrator', tone: 'dim' }]);
    push([{ text: 'profile ', tone: 'dim' }, { text: extra.record?.profile ?? d.profile, tone: 'text' }]);
    push([{ text: 'style ', tone: 'dim' }, { text: b.config.director.style, tone: 'text' }]);
  }

  lines.push([]);
  lines.push(...keyLines(keyRows(extra), width, o));
  return lines;
}

/**
 * The models pane in `ui.left`: one Text, rebuilt on update(). The width follows the laid-out Text
 * (checked after each frame); before the first frame it is PANE_TEXT_WIDTH.left. `o.warp`: as the
 * transcript's (default: from TERM_PROGRAM).
 */
export function createModelsPane(ui: Ui, theme: Theme, o: PaneOptions = {}): ModelsPaneApi {
  const opts: PaneOptions = { warp: paneWarp(o) };
  const r = ui.renderer;
  const text = new TextRenderable(r, { id: 'models-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1, flexShrink: 1, minHeight: 0, ...selectionColours(theme) });
  ui.left.add(text);

  let last: { b: BannerInfo; extra: ModelsExtra } | null = null;
  let drawnWidth = 0;
  const width = (): number => (text.width > 0 ? text.width : PANE_TEXT_WIDTH.left);
  const draw = (): void => {
    drawnWidth = width();
    text.content = paneText(last ? modelsLines(last.b, last.extra, drawnWidth, opts) : [], theme);
  };
  r.on('frame', () => {
    if (last && text.width > 0 && text.width !== drawnWidth) draw();
  });

  return {
    update(b, extra): void {
      last = { b, extra };
      draw();
    },
  };
}
