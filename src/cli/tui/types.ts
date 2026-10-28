// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's shared contract (.notes/tui-decisions.md): the layout pieces the host builds, the theme,
// the hotkey list, and the APIs of the chat transcript and the two side panes. CONTRACT FILE for the
// TUI build: only the lead changes it. Only TYPES are imported from @opentui/core here, so loading
// this file never loads the native library; the modules under src/cli/tui/ that create renderables
// import it at run time, and only the `tui` command path loads them (T-2). The theme's values
// (RGBA objects) live in theme.ts for that reason.

import type {
  BoxRenderable,
  CliRenderer,
  RGBA,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
} from '@opentui/core';
import type { DirectorRecord } from '../../agents/director/types.ts';
import type { MemoryStatus } from '../../engine/api.ts';
import type { Event } from '../../protocol/events.ts';
import type { SessionConfig } from '../../session/entries.ts';
import type { MessageView } from '../../session/view.ts';
import type { Journal, PriceTable } from '../repl-journal.ts';
import type { BannerInfo, TurnOptions, TurnView } from '../repl-view.ts';

// ---- layout --------------------------------------------------------------------------------------

/** What the host builds once (T-4) and hands to the transcript and the panes. */
export interface Ui {
  renderer: CliRenderer;
  /** LEFT "Models" box (width LAYOUT.left). */
  left: BoxRenderable;
  /** MIDDLE "Chat" box: holds transcript, status and input, in that order. */
  middle: BoxRenderable;
  /** RIGHT "Agents" box (width LAYOUT.right). */
  right: BoxRenderable;
  /** The chat's scrollable transcript (stickyScroll, stickyStart 'bottom'). */
  transcript: ScrollBoxRenderable;
  /** One row under the transcript: what is happening (streaming, held lines, errors). */
  status: TextRenderable;
  /** The input box (1–6 rows). */
  input: TextareaRenderable;
}

export const LAYOUT = {
  left: 28,
  right: 36,
  middleMin: 40,
  /** Width from which all three columns show. */
  allFrom: 120,
  /** Width from which the chat and the agents show (below it: the chat only). */
  agentsFrom: 90,
  inputMaxRows: 6,
  /** Finished cards kept as their own renderables; older ones fold into archive blocks (T-7). */
  liveCards: 150,
  /** Tool calls the agents pane lists per agent (T-8). */
  toolCalls: 6,
} as const;

// ---- theme ---------------------------------------------------------------------------------------

/**
 * The colours (T-12): no hex anywhere. Text is the terminal's own default foreground (SGR 39), the
 * accents are the terminal's ANSI palette (`38;5;n`), backgrounds the terminal's default (SGR 49), so
 * a light or a dark terminal theme works without detection. Every renderable and every text chunk
 * sets its colour from here explicitly: nothing may fall back to OpenTUI's white. Dim text is the DIM
 * attribute on `text` (no grey). The values are THEME / MONO_THEME in theme.ts.
 */
export interface Theme {
  /** Plain text, and dim text (with the DIM attribute): the terminal's default foreground. */
  text: RGBA;
  yellow: RGBA;
  red: RGBA;
  /** Agent names, hotkey labels, the Director planning. */
  accent: RGBA;
  /** The player's name in the transcript and the input label. */
  user: RGBA;
  /** The character's name in the transcript. */
  char: RGBA;
  /** Direct speech in the character's replies. */
  speech: RGBA;
  /** Box borders and titles, the scrollbar's thumb. */
  border: RGBA;
  focusedBorder: RGBA;
  /** The screen's background under everything (the input has none of its own): the terminal's default background. */
  background: RGBA;
  /**
   * The input's cursor. OpenTUI 0.7.0 always sends the cursor colour as a concrete OSC 12 `#rrggbb`
   * (the intent is ignored), so this is the default-foreground intent over a mid-grey value that
   * shows on a light and on a dark background alike (`defaultForeground()` alone would be white).
   */
  cursor: RGBA;
  /** NO_COLOR: every colour above is the default foreground / background; only attributes (bold, dim, italic) differ. */
  mono: boolean;
}

// ---- hotkeys (T-6) -------------------------------------------------------------------------------

export type HotkeyAction =
  | { kind: 'command'; line: string }
  | { kind: 'prefill'; text: string }
  | {
      kind: 'ui';
      what: 'scrollPageUp' | 'scrollPageDown' | 'scrollTop' | 'scrollBottom' | 'togglePanes' | 'toggleMouse' | 'modelPicker' | 'storyPicker' | 'newStory' | 'escape' | 'editLast';
    };

export interface Hotkey {
  /** How the left pane shows it, e.g. 'Ctrl+R'. */
  label: string;
  description: string;
  /** Matching: the key name (KeyEvent.name) and modifiers; `baseCode` covers non-Latin layouts (Ctrl+R = ctrl+к, baseCode 114). */
  match: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; baseCode?: number }[];
  action: HotkeyAction;
}

/**
 * The hotkeys the TUI handles and the left pane lists, in display order. Enter / newline / Ctrl+C are
 * handled by the input and the Repl. Label ≤ 10 and description ≤ 13 columns, so every entry fits one
 * row of the 24-column pane (T-15).
 */
export const HOTKEYS: readonly Hotkey[] = [
  { label: 'Ctrl+R', description: 'swipe', match: [{ name: 'r', ctrl: true, baseCode: 114 }], action: { kind: 'command', line: '/r' } },
  { label: 'Ctrl+G', description: 'guided reroll', match: [{ name: 'g', ctrl: true, baseCode: 103 }], action: { kind: 'prefill', text: '/regen ' } },
  { label: 'Ctrl+O', description: 'continue', match: [{ name: 'o', ctrl: true, baseCode: 111 }], action: { kind: 'command', line: '/c' } },
  { label: 'Ctrl+E', description: 'edit last', match: [{ name: 'e', ctrl: true, baseCode: 101 }], action: { kind: 'ui', what: 'editLast' } },
  { label: 'Alt+←/→', description: 'versions', match: [{ name: 'left', meta: true }, { name: 'right', meta: true }], action: { kind: 'command', line: '/[' } },
  { label: 'PgUp/PgDn', description: 'scroll', match: [{ name: 'pageup' }, { name: 'pagedown' }], action: { kind: 'ui', what: 'scrollPageUp' } },
  { label: 'C-Home/End', description: 'top/bottom', match: [{ name: 'home', ctrl: true }, { name: 'end', ctrl: true }], action: { kind: 'ui', what: 'scrollTop' } },
  { label: 'Ctrl+D', description: 'Director', match: [{ name: 'd', ctrl: true, baseCode: 100 }], action: { kind: 'command', line: '/director show' } },
  { label: 'F1', description: 'help', match: [{ name: 'f1' }], action: { kind: 'command', line: '/help' } },
  { label: 'F2', description: 'side panes', match: [{ name: 'f2' }], action: { kind: 'ui', what: 'togglePanes' } },
  { label: 'F3', description: 'mouse wheel', match: [{ name: 'f3' }], action: { kind: 'ui', what: 'toggleMouse' } },
  { label: 'F4', description: 'choose model', match: [{ name: 'f4' }], action: { kind: 'ui', what: 'modelPicker' } },
  { label: 'F5', description: 'stories', match: [{ name: 'f5' }], action: { kind: 'ui', what: 'storyPicker' } },
  { label: 'F6', description: 'new story', match: [{ name: 'f6' }], action: { kind: 'ui', what: 'newStory' } },
  { label: 'Esc', description: 'cancel/clear', match: [{ name: 'escape' }], action: { kind: 'ui', what: 'escape' } },
];
// Pairs inside one entry (Alt+←/→, PgUp/PgDn, Ctrl+Home/End) are told apart by the host from the
// matched key: Alt+→ is '/]', PgDn scrollPageDown, Ctrl+End scrollBottom.

// ---- the chat transcript (unit `chat`) ------------------------------------------------------------

/** Labels as the Repl pads them (repl-render.ts labels()). */
export interface Names {
  char: string;
  user: string;
  width: number;
}

export interface TranscriptApi {
  /** The whole active path (open, a session switch): what was shown before is cleared. Status lines are the Repl's SGR strings. */
  showPath(path: readonly MessageView[], names: Names, statusOf: (m: MessageView) => string | null): void;
  /** A finished message as a card (header `Name › `, prose-styled text). */
  card(m: MessageView, names: Names): void;
  /** A Repl line (SGR-styled: dim / bold / italic / yellow / red) as a system row. */
  system(sgr: string): void;
  /** The player's line as the Repl echoes it (an SGR string with the `you › ` prefix). */
  echo(sgr: string): void;
  /** The dim status line under the last card (`swipe 2/3 · 300 tok · 13.3s · length`), an SGR string. */
  status(sgr: string): void;
  /** A streaming card for one turn; every event is also passed to `onEvent` (the agents pane). */
  turn(o: TurnOptions & { names: Names; onEvent?: (ev: Event) => void }): TurnView;
  scroll(how: 'pageUp' | 'pageDown' | 'top' | 'bottom'): void;
  /** The newest card's message id (dedup of where-you-are messages after banner, ports note). */
  lastCardId(): string | null;
}

// ---- the side panes (unit `panes`) ------------------------------------------------------------------

export interface ModelsPaneApi {
  /** Rebuild from the Repl's banner data (refreshed on idle and on a session switch). */
  update(b: BannerInfo, extra: { record?: DirectorRecord; newlineKey: string; mouse: boolean }): void;
}

export interface AgentsPaneApi {
  /** Every turn event (live: narrator state, tool calls, Director statuses, retries, usage). */
  event(ev: Event): void;
  /** Re-read the stored facts at the head (last answer stats, the Director's record, usage totals). */
  refresh(j: Journal, head: string | null, config: SessionConfig, prices: PriceTable): void;
  /**
   * A different session is shown now: forget the live state. `lane`: its background lane now
   * (memoryStatus()): the blocks of the pass that runs, waits or is parked (M5b: the lane's events at the
   * session's open came before the pane).
   */
  reset(sessionId: string, lane?: MemoryStatus): void;
}
