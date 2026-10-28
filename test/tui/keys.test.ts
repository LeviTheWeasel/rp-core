// The TUI's hotkey matching (TUI decisions T-6, T-16): names, baseCode on a Russian layout (kitty),
// the ЙЦУКЕН position without one (modifyOtherKeys), the pairs, F-keys, Esc, and what is not a
// hotkey (Ctrl+C, plain letters, Dvorak's Latin letters); the newline key's label and the /help note.
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import type { KeyEvent } from '@opentui/core';
import { actionOf, hotkeyAction, isInterruptKey, matchHotkey, newlineKey, russianKey, tuiHelpNote, type KeyLike } from '../../src/cli/tui/keys.ts';
import { HOTKEYS } from '../../src/cli/tui/types.ts';

const key = (name: string, mods: Partial<KeyLike> = {}): KeyLike => ({ name, ctrl: false, meta: false, shift: false, ...mods });

describe('hotkeyAction: plain objects', () => {
  test('Latin ctrl letters', () => {
    expect(hotkeyAction(key('r', { ctrl: true }))).toEqual({ kind: 'command', line: '/r' });
    expect(hotkeyAction(key('g', { ctrl: true }))).toEqual({ kind: 'prefill', text: '/regen ' });
    expect(hotkeyAction(key('o', { ctrl: true }))).toEqual({ kind: 'command', line: '/c' });
    expect(hotkeyAction(key('e', { ctrl: true }))).toEqual({ kind: 'ui', what: 'editLast' });
    expect(hotkeyAction(key('d', { ctrl: true }))).toEqual({ kind: 'command', line: '/director show' });
  });

  test('a Russian layout: the Cyrillic name with the Latin baseCode', () => {
    expect(hotkeyAction(key('к', { ctrl: true, baseCode: 114 }))).toEqual({ kind: 'command', line: '/r' });
    expect(hotkeyAction(key('п', { ctrl: true, baseCode: 103 }))).toEqual({ kind: 'prefill', text: '/regen ' });
    expect(hotkeyAction(key('щ', { ctrl: true, baseCode: 111 }))).toEqual({ kind: 'command', line: '/c' });
    expect(hotkeyAction(key('у', { ctrl: true, baseCode: 101 }))).toEqual({ kind: 'ui', what: 'editLast' });
    expect(hotkeyAction(key('в', { ctrl: true, baseCode: 100 }))).toEqual({ kind: 'command', line: '/director show' });
  });

  test('a Russian layout without baseCode (modifyOtherKeys): the letter\'s key on ЙЦУКЕН', () => {
    expect(hotkeyAction(key('к', { ctrl: true }))).toEqual({ kind: 'command', line: '/r' });
    expect(hotkeyAction(key('п', { ctrl: true }))).toEqual({ kind: 'prefill', text: '/regen ' });
    expect(hotkeyAction(key('щ', { ctrl: true }))).toEqual({ kind: 'command', line: '/c' });
    expect(hotkeyAction(key('у', { ctrl: true }))).toEqual({ kind: 'ui', what: 'editLast' });
    expect(hotkeyAction(key('в', { ctrl: true }))).toEqual({ kind: 'command', line: '/director show' });
    // Caps Lock: the capital letter is the same key.
    expect(hotkeyAction(key('К', { ctrl: true }))).toEqual({ kind: 'command', line: '/r' });
    // Modifiers still must match; a letter that is no hotkey's key stays nothing.
    expect(hotkeyAction(key('к'))).toBeNull();
    expect(hotkeyAction(key('к', { ctrl: true, shift: true }))).toBeNull();
    expect(hotkeyAction(key('ф', { ctrl: true }))).toBeNull();
    // A baseCode, when the terminal sends one, wins over the layout table (kitty knows the real layout).
    expect(hotkeyAction(key('к', { ctrl: true, baseCode: 100 }))).toEqual({ kind: 'command', line: '/director show' });
    // Other scripts have no table: without a baseCode they match nothing.
    expect(hotkeyAction(key('ρ', { ctrl: true }))).toBeNull();
  });

  test('the ЙЦУКЕН table: every letter to its QWERTY key', () => {
    const ru = 'йцукенгшщзхъфывапролджэячсмитьбюё';
    const us = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
    expect([...ru].map((c) => russianKey(c)).join('')).toBe(us);
    expect([...ru.toUpperCase()].map((c) => russianKey(c)).join('')).toBe(us);
    expect(russianKey('r')).toBeUndefined();
    expect(russianKey('ρ')).toBeUndefined();
  });

  test('a Latin name never falls back to baseCode (Dvorak keeps its letters)', () => {
    // Dvorak: the key printing "p" sits where US "r" is.
    expect(hotkeyAction(key('p', { ctrl: true, baseCode: 114 }))).toBeNull();
    expect(hotkeyAction(key('r', { ctrl: true, baseCode: 111 }))).toEqual({ kind: 'command', line: '/r' });
  });

  test('modifiers must match exactly', () => {
    expect(hotkeyAction(key('r'))).toBeNull();
    expect(hotkeyAction(key('к'))).toBeNull();
    expect(hotkeyAction(key('r', { ctrl: true, meta: true }))).toBeNull();
    expect(hotkeyAction(key('r', { ctrl: true, shift: true }))).toBeNull();
    expect(hotkeyAction(key('left'))).toBeNull();
    expect(hotkeyAction(key('home'))).toBeNull();
  });

  test('pairs: Alt+←/→, PgUp/PgDn, Ctrl+Home/End', () => {
    expect(hotkeyAction(key('left', { meta: true }))).toEqual({ kind: 'command', line: '/[' });
    expect(hotkeyAction(key('right', { meta: true }))).toEqual({ kind: 'command', line: '/]' });
    expect(hotkeyAction(key('pageup'))).toEqual({ kind: 'ui', what: 'scrollPageUp' });
    expect(hotkeyAction(key('pagedown'))).toEqual({ kind: 'ui', what: 'scrollPageDown' });
    expect(hotkeyAction(key('home', { ctrl: true }))).toEqual({ kind: 'ui', what: 'scrollTop' });
    expect(hotkeyAction(key('end', { ctrl: true }))).toEqual({ kind: 'ui', what: 'scrollBottom' });
    const m = matchHotkey(key('pagedown'));
    expect(m?.which).toBe(1);
    expect(actionOf(m!.hotkey, 0)).toEqual({ kind: 'ui', what: 'scrollPageUp' });
  });

  test('F-keys and Esc', () => {
    expect(hotkeyAction(key('f1'))).toEqual({ kind: 'command', line: '/help' });
    expect(hotkeyAction(key('f2'))).toEqual({ kind: 'ui', what: 'togglePanes' });
    expect(hotkeyAction(key('f3'))).toEqual({ kind: 'ui', what: 'toggleMouse' });
    expect(hotkeyAction(key('escape'))).toEqual({ kind: 'ui', what: 'escape' });
    expect(hotkeyAction(key('f4'))).toEqual({ kind: 'ui', what: 'modelPicker' });
    expect(hotkeyAction(key('f5'))).toEqual({ kind: 'ui', what: 'storyPicker' });
    expect(hotkeyAction(key('f6'))).toEqual({ kind: 'ui', what: 'newStory' });
  });

  test('Ctrl+C is the interrupt, not a hotkey (Latin and Russian layout)', () => {
    expect(hotkeyAction(key('c', { ctrl: true }))).toBeNull();
    expect(isInterruptKey(key('c', { ctrl: true }))).toBe(true);
    expect(isInterruptKey(key('с', { ctrl: true, baseCode: 99 }))).toBe(true);
    expect(isInterruptKey(key('c'))).toBe(false);
    expect(isInterruptKey(key('c', { ctrl: true, meta: true }))).toBe(false);
    expect(isInterruptKey(key('x', { ctrl: true, baseCode: 99 }))).toBe(false);
    // modifyOtherKeys: ctrl+с with no baseCode is Ctrl+C too (either case); other letters are not.
    expect(isInterruptKey(key('с', { ctrl: true }))).toBe(true);
    expect(isInterruptKey(key('С', { ctrl: true }))).toBe(true);
    expect(isInterruptKey(key('с'))).toBe(false);
    expect(isInterruptKey(key('с', { ctrl: true, meta: true }))).toBe(false);
    expect(isInterruptKey(key('к', { ctrl: true }))).toBe(false);
    // A kitty baseCode that names another key wins over the table.
    expect(isInterruptKey(key('с', { ctrl: true, baseCode: 120 }))).toBe(false);
    expect(hotkeyAction(key('с', { ctrl: true }))).toBeNull();
  });

  test('every HOTKEYS entry is reachable by its own first key', () => {
    for (const h of HOTKEYS) expect(matchHotkey({ ctrl: false, meta: false, shift: false, ...h.match[0]! })?.hotkey).toBe(h);
  });

  test('newline key label: short enough for one row of the left pane (T-15)', () => {
    expect(newlineKey(true)).toBe('Shift+Enter');
    expect(newlineKey(false)).toBe('Alt+Enter');
  });

  test('the note under /help: the hotkeys on the left, or F2 to show them when the left pane is hidden', () => {
    expect(tuiHelpNote(true)).toBe('In the TUI: /e and Ctrl+E edit in the input box ($VISUAL / $EDITOR are not used); the hotkeys are listed on the left (F2 hides the side panes).');
    expect(tuiHelpNote(false)).toBe('In the TUI: /e and Ctrl+E edit in the input box ($VISUAL / $EDITOR are not used); F2 shows the hotkeys.');
  });
});

describe('hotkeyAction: key events from the headless renderer (kitty)', () => {
  let setup: TestRendererSetup | undefined;
  afterEach(async () => {
    await setup?.dispose();
    setup = undefined;
  });

  async function events(press: (s: TestRendererSetup) => Promise<void> | void): Promise<KeyEvent[]> {
    setup = await createTestRenderer({ width: 40, height: 5, kittyKeyboard: true });
    const seen: KeyEvent[] = [];
    setup.renderer.keyInput.on('keypress', (k) => seen.push(k));
    await press(setup);
    await setup.renderOnce();
    return seen;
  }

  test('Ctrl+R on Latin and Russian layouts, Ctrl+С as the interrupt', async () => {
    const seen = await events(async (s) => {
      s.mockInput.pressKey('r', { ctrl: true });
      await s.mockInput.pressKeys(['\x1b[1082::114;5u']); // ctrl+к, base key r
      await s.mockInput.pressKeys(['\x1b[1089::99;5u']); // ctrl+с, base key c
    });
    expect(seen.map((k) => k.name)).toEqual(['r', 'к', 'с']);
    expect(hotkeyAction(seen[0]!)).toEqual({ kind: 'command', line: '/r' });
    expect(hotkeyAction(seen[1]!)).toEqual({ kind: 'command', line: '/r' });
    expect(isInterruptKey(seen[2]!)).toBe(true);
  });

  test('modifyOtherKeys (CSI 27;5;cp~, no baseCode): Russian-layout Ctrl+letters and Ctrl+С through the real parser', async () => {
    const seen = await events(async (s) => {
      await s.mockInput.pressKeys(['\x1b[27;5;1082~']); // ctrl+к
      await s.mockInput.pressKeys(['\x1b[27;5;1097~']); // ctrl+щ
      await s.mockInput.pressKeys(['\x1b[27;5;1074~']); // ctrl+в
      await s.mockInput.pressKeys(['\x1b[27;5;1089~']); // ctrl+с
      await s.mockInput.pressKeys(['\x1b[27;5;114~']); // ctrl+r
    });
    expect(seen.map((k) => [k.name, k.ctrl, k.baseCode])).toEqual([
      ['к', true, undefined],
      ['щ', true, undefined],
      ['в', true, undefined],
      ['с', true, undefined],
      ['r', true, undefined],
    ]);
    expect(seen.map(hotkeyAction)).toEqual([{ kind: 'command', line: '/r' }, { kind: 'command', line: '/c' }, { kind: 'command', line: '/director show' }, null, { kind: 'command', line: '/r' }]);
    expect(seen.map(isInterruptKey)).toEqual([false, false, false, true, false]);
  });

  test('Alt+arrows, PgUp/PgDn, Ctrl+Home/End, F1-F3, Esc', async () => {
    const seen = await events(async (s) => {
      s.mockInput.pressArrow('left', { meta: true });
      s.mockInput.pressArrow('right', { meta: true });
      await s.mockInput.pressKeys(['\x1b[5~', '\x1b[6~']);
      s.mockInput.pressKey('HOME', { ctrl: true });
      s.mockInput.pressKey('END', { ctrl: true });
      await s.mockInput.pressKeys(['F1', 'F2', 'F3']);
      s.mockInput.pressEscape();
    });
    expect(seen.map(hotkeyAction)).toEqual([
      { kind: 'command', line: '/[' },
      { kind: 'command', line: '/]' },
      { kind: 'ui', what: 'scrollPageUp' },
      { kind: 'ui', what: 'scrollPageDown' },
      { kind: 'ui', what: 'scrollTop' },
      { kind: 'ui', what: 'scrollBottom' },
      { kind: 'command', line: '/help' },
      { kind: 'ui', what: 'togglePanes' },
      { kind: 'ui', what: 'toggleMouse' },
      { kind: 'ui', what: 'escape' },
    ]);
  });
});
