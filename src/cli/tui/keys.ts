// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's hotkeys (TUI decisions T-6, T-16): which entry of HOTKEYS a key press is, and what it
// does. Matching is by the key's name, or, when the name is a non-Latin letter, by the Latin key it
// sits on: its kitty `baseCode` (a Russian layout under kitty reports Ctrl+R as `ctrl+к` with
// baseCode 114), or without one (xterm's modifyOtherKeys sends `CSI 27;5;1082~`: `ctrl+к`, no
// baseCode) its position on the standard Russian ЙЦУКЕН layout. A Latin name never falls back, so
// other Latin layouts (Dvorak) keep the letters they print. Ctrl+C is not a hotkey: the host routes
// it to the Repl's interrupt handler (isInterruptKey), on any of these paths. Also the key rows the
// left pane lists (keyRows) and the TUI's lines under the Repl's /help (tuiHelpNote, tuiHelpLines:
// the key rows themselves when the left pane is not on screen, T-17).

import type { KeyEvent } from '@opentui/core';
import { HOTKEYS, type Hotkey, type HotkeyAction } from './types.ts';

/** The fields of a KeyEvent the matching reads (tests pass plain objects). */
export type KeyLike = Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift'> & { baseCode?: number | undefined };

type Match = Hotkey['match'][number];

/** A single non-ASCII character: a letter of another layout, whose baseCode names the Latin key. */
const foreignLetter = (name: string): boolean => [...name].length === 1 && name.codePointAt(0)! > 0x7f;

/** The standard Russian layout (ЙЦУКЕН): each letter's key on the US QWERTY layout. */
const RUSSIAN_KEYS: Readonly<Record<string, string>> = {
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p', х: '[', ъ: ']',
  ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l', ж: ';', э: "'",
  я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm', б: ',', ю: '.', ё: '`',
};

/** The QWERTY key a Cyrillic letter sits on in the ЙЦУКЕН layout (either case), or undefined. */
export function russianKey(letter: string): string | undefined {
  return RUSSIAN_KEYS[letter.toLowerCase()];
}

/**
 * Whether a press of a non-Latin letter is the Latin key `name` (with that key's baseCode, if any):
 * by the press's baseCode when the terminal sent one (kitty), else by the ЙЦУКЕН position.
 */
function layoutMatches(k: KeyLike, name: string, baseCode: number | undefined): boolean {
  if (!foreignLetter(k.name)) return false;
  if (k.baseCode !== undefined) return baseCode !== undefined && k.baseCode === baseCode;
  return russianKey(k.name) === name;
}

function nameMatches(k: KeyLike, m: Match): boolean {
  return k.name === m.name || layoutMatches(k, m.name, m.baseCode);
}

function keyMatches(k: KeyLike, m: Match): boolean {
  return nameMatches(k, m) && !!k.ctrl === !!m.ctrl && !!k.meta === !!m.meta && !!k.shift === !!m.shift;
}

/** The hotkey a key press is, and which of its `match` entries matched (0 or 1 for the pairs). */
export function matchHotkey(k: KeyLike, list: readonly Hotkey[] = HOTKEYS): { hotkey: Hotkey; which: number } | null {
  for (const hotkey of list) {
    const which = hotkey.match.findIndex((m) => keyMatches(k, m));
    if (which >= 0) return { hotkey, which };
  }
  return null;
}

/**
 * What a matched hotkey does. The pairs share one entry (types.ts): the second key of a pair is the
 * other direction: Alt+→ is '/]', PgDn scrollPageDown, Ctrl+End scrollBottom.
 */
export function actionOf(hotkey: Hotkey, which: number): HotkeyAction {
  const a = hotkey.action;
  if (which !== 1) return a;
  if (a.kind === 'command' && a.line === '/[') return { kind: 'command', line: '/]' };
  if (a.kind === 'ui' && a.what === 'scrollPageUp') return { kind: 'ui', what: 'scrollPageDown' };
  if (a.kind === 'ui' && a.what === 'scrollTop') return { kind: 'ui', what: 'scrollBottom' };
  return a;
}

/** matchHotkey + actionOf: the action of a key press, or null when it is not a hotkey. */
export function hotkeyAction(k: KeyLike): HotkeyAction | null {
  const m = matchHotkey(k);
  return m ? actionOf(m.hotkey, m.which) : null;
}

/**
 * Ctrl+C, also `ctrl+с` on a Russian layout (kitty: baseCode 99; modifyOtherKeys: no baseCode, the
 * letter's ЙЦУКЕН key): one press for the Repl's interrupt handler.
 */
export function isInterruptKey(k: KeyLike): boolean {
  if (!k.ctrl || k.meta) return false;
  return k.name === 'c' || layoutMatches(k, 'c', 99);
}

/**
 * The newline key the left pane shows, short enough for one row of it (T-15): Shift+Enter only when
 * the terminal speaks kitty / CSI-u, else Alt+Enter (Ctrl+J works too; the `tui` help says so).
 */
export function newlineKey(kitty: boolean): string {
  return kitty ? 'Shift+Enter' : 'Alt+Enter';
}

/**
 * The TUI's note under the Repl's /help (T-9, review P5). `keysShown`: the left pane (the hotkey
 * list) is on screen; when it is not, the note says how to bring the hotkeys up.
 */
export function tuiHelpNote(keysShown: boolean): string {
  const keys = keysShown ? 'the hotkeys are listed on the left (F2 hides the side panes)' : 'F2 shows the hotkeys';
  return `In the TUI: /e and Ctrl+E edit in the input box ($VISUAL / $EDITOR are not used); ${keys}.`;
}

/** The row for the terminal's own selection while mouse reporting is on (T-17): Warp, kitty, GNOME Terminal… select with Shift held. */
export const SHIFT_DRAG: readonly [string, string] = ['Shift+drag', 'select'];

/**
 * The key rows in display order, [label, description] (T-6, T-15, T-17): Enter, the newline key and
 * Ctrl+C (handled by the input and the Repl), then HOTKEYS; F3's row says whether the mouse is on and
 * is followed by `Shift+drag  select`. Every row fits one line of the 24-column left pane. The left
 * pane lists these rows; /help lists them when the left pane is not on screen (tuiHelpLines).
 */
export function keyRows(extra: { newlineKey: string; mouse: boolean }): [string, string][] {
  const rows: [string, string][] = [
    ['Enter', 'send'],
    [extra.newlineKey, 'new line'],
    ['Ctrl+C', 'stop / quit'],
  ];
  for (const k of HOTKEYS) {
    const mouse = k.action.kind === 'ui' && k.action.what === 'toggleMouse';
    rows.push([k.label, mouse ? `mouse: ${extra.mouse ? 'on' : 'off'}` : k.description]);
    if (mouse) rows.push([SHIFT_DRAG[0], SHIFT_DRAG[1]]);
  }
  return rows;
}

/**
 * What the TUI adds under the Repl's /help (T-9, T-17), one plain-text row each (the view dims them).
 * `keysShown`: the left pane (the key list) is on screen, then the note points at it; when it is not
 * (below LAYOUT.allFrom columns, where F2 cannot bring it up, or hidden by F2) the note is followed by
 * the key rows themselves, aligned: two spaces, the label, two spaces after the widest label, the
 * description.
 */
export function tuiHelpLines(extra: { newlineKey: string; mouse: boolean }, keysShown: boolean): string[] {
  if (keysShown) return [tuiHelpNote(true)];
  const rows = keyRows(extra);
  const widest = Math.max(...rows.map(([label]) => Bun.stringWidth(label)));
  return [
    'In the TUI: /e and Ctrl+E edit in the input box ($VISUAL / $EDITOR are not used); the keys:',
    ...rows.map(([label, description]) => `  ${label}${' '.repeat(widest - Bun.stringWidth(label) + 2)}${description}`),
  ];
}
