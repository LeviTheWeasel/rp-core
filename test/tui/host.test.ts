// The TUI host (TUI decisions T-3, T-4, T-6, T-9): the input port on its own, then the real Repl in
// a headless renderer: the three panes, a streamed answer, hotkeys (Latin and Russian layout), the
// in-place edit, F2 and the responsive widths.
import { afterEach, describe, expect, test } from 'bun:test';
import { TextareaSource, interruptHub, isCtrlCChunk, PASTE_END, pasteGuard } from '../../src/cli/tui/source.ts';
import { SEND_FIRST } from '../../src/cli/tui/run.ts';
import { applyWidth } from '../../src/cli/tui/app.ts';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calls, tuiRig, type TuiRig } from './kit.ts';
import { messageText } from '../../src/cli/render.ts';

// ---- the input port -----------------------------------------------------------------------------

function box(text = '') {
  const b = {
    plainText: text,
    ends: 0,
    setText(t: string) {
      b.plainText = t;
    },
    gotoBufferEnd() {
      b.ends++;
    },
  };
  return b;
}

describe('TextareaSource', () => {
  test('lines sent before next() wait in order; next() waits for the next submit', async () => {
    const b = box();
    const s = new TextareaSource(b, () => {});
    b.plainText = 'привет';
    s.submit();
    s.inject('/r');
    expect(b.plainText).toBe('');
    expect(await s.next()).toEqual({ done: false, value: 'привет' });
    expect(await s.next()).toEqual({ done: false, value: '/r' });
    const later = s.next();
    b.plainText = 'вторая\nстрока';
    s.submit();
    expect(await later).toEqual({ done: false, value: 'вторая\nстрока' });
  });

  test('flags and pending', () => {
    const b = box('typed');
    const s = new TextareaSource(b, () => {});
    expect([s.interactive, s.echoes, s.inline, s.multiline]).toEqual([true, false, true, true]);
    expect(s.pending()).toBe('typed');
    s.clearPending();
    expect(s.pending()).toBe('');
    s.mute(true);
    expect(s.muted).toBe(true);
  });

  test('prompt: the label without SGR, the mode remembered; submit or cancel ends an edit', () => {
    const labels: string[] = [];
    const b = box();
    const s = new TextareaSource(b, (l) => labels.push(l));
    s.prompt('\x1b[1myou \x1b[22m › ', 'line');
    expect(s.promptMode).toBe('line');
    s.prompt('\x1b[1medit\x1b[22m › ', 'edit');
    expect(s.promptMode).toBe('edit');
    b.plainText = 'new text';
    s.submit();
    expect(s.promptMode).toBe('line');
    s.prompt('edit › ', 'edit');
    s.clearPending(); // the Repl's cancel (Ctrl+C / Esc)
    expect(s.promptMode).toBe('line');
    // T-17: the padding the REPL aligns its columns with is collapsed: `you › `.
    expect(labels).toEqual(['you › ', 'edit › ', 'you › ', 'edit › ', 'you › ']);
  });

  test('prefill keeps real line breaks and moves the cursor to the end', () => {
    const b = box('old');
    const s = new TextareaSource(b, () => {});
    s.prefill('*Mira looks up.*\n"Hello."');
    expect(b.plainText).toBe('*Mira looks up.*\n"Hello."');
    expect(b.ends).toBe(1);
  });

  test('close ends next() and drops later lines', async () => {
    const b = box();
    const s = new TextareaSource(b, () => {});
    const waiting = s.next();
    s.close();
    expect(await waiting).toEqual({ done: true, value: undefined });
    s.inject('/r');
    expect(await s.next()).toEqual({ done: true, value: undefined });
  });

  test('once the box is destroyed (the renderer went away) every method is a no-op', () => {
    const labels: string[] = [];
    const b = { ...box('typed'), isDestroyed: false };
    const s = new TextareaSource(b, (l) => labels.push(l));
    b.isDestroyed = true;
    // A destroyed TextareaRenderable throws on plainText / setText: nothing may touch it.
    Object.defineProperty(b, 'plainText', {
      get() {
        throw new Error('EditBuffer is destroyed');
      },
    });
    b.setText = () => {
      throw new Error('EditBuffer is destroyed');
    };
    expect(s.pending()).toBe('');
    s.clearPending();
    s.prefill('x');
    s.prompt('you › ');
    s.submit();
    expect(labels).toEqual([]);
  });

  test('interruptHub: presses reach the subscriber; SIGINT too; none listening calls orphan', () => {
    const signals = new EventEmitter();
    let orphans = 0;
    const hub = interruptHub(signals as never, () => orphans++);
    let presses = 0;
    const off = hub.interrupts(() => presses++);
    hub.fire();
    signals.emit('SIGINT');
    expect(presses).toBe(2);
    off();
    signals.emit('SIGINT');
    expect([presses, orphans]).toEqual([2, 1]);
    hub.dispose();
    signals.emit('SIGINT');
    expect(orphans).toBe(1);
  });
});

// ---- the paste guard (T-16) ----------------------------------------------------------------------------

describe('pasteGuard', () => {
  /** A stream whose own listener stands in for OpenTUI's parser (it sees what the guard lets through). */
  function stream() {
    const s = new EventEmitter();
    const seen: string[] = [];
    s.on('data', (c: Buffer) => seen.push(c.toString('latin1')));
    const push = (t: string) => void s.emit('data', Buffer.from(t, 'latin1'));
    return { s, seen, push };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('a paste without its end marker is ended after the idle time', async () => {
    const { s, seen, push } = stream();
    const ends: string[] = [];
    const off = pasteGuard(s as never, { idleMs: 20, onEnd: (w) => ends.push(w) });
    push('\x1b[200~hello ');
    push('there');
    await wait(60);
    expect(seen).toEqual(['\x1b[200~hello ', 'there', PASTE_END]);
    expect(ends).toEqual(['idle']);
    off();
  });

  test('a Ctrl+C key while a paste is open ends the paste first, then the key goes through', () => {
    const { s, seen, push } = stream();
    const ends: string[] = [];
    const off = pasteGuard(s as never, { idleMs: 10_000, onEnd: (w) => ends.push(w) });
    push('\x1b[200~hello');
    push('\x1b[99;5u');
    expect(seen).toEqual(['\x1b[200~hello', PASTE_END, '\x1b[99;5u']);
    expect(ends).toEqual(['interrupt']);
    // Closed now: a Ctrl+C is just a key.
    push('\x03');
    expect(ends).toEqual(['interrupt']);
    off();
  });

  test('a whole paste (markers split over chunks) needs nothing; removing the guard stops the timer', async () => {
    const { s, seen, push } = stream();
    const ends: string[] = [];
    const off = pasteGuard(s as never, { idleMs: 20, onEnd: (w) => ends.push(w) });
    push('\x1b[20');
    push('0~text\x1b[2');
    push('01~');
    await wait(50);
    expect(ends).toEqual([]);
    push('\x1b[200~again');
    off();
    await wait(50);
    expect(ends).toEqual([]);
    expect(seen.at(-1)).toBe('\x1b[200~again');
  });

  test('isCtrlCChunk: legacy, kitty (Russian layout, CapsLock), modifyOtherKeys; not Alt+C or a release', () => {
    for (const k of ['\x03', '\x1b[99;5u', '\x1b[99;5:1u', '\x1b[1089::99;5u', '\x1b[99;69u', '\x1b[27;5;99~', '\x1b[27;5;1089~', '\x1b[1089;5u']) {
      expect(isCtrlCChunk(k)).toBe(true);
    }
    for (const k of ['c', '\x1b[99;3u', '\x1b[99;7u', '\x1b[99;5:3u', '\x1b[27;3;99~', '\x1b[114;5u', '\x03\x03']) {
      expect(isCtrlCChunk(k)).toBe(false);
    }
  });
});

test('applyWidth: all three from 120, chat + agents from 90, chat below; F2 hides both', () => {
  const ui = { left: { visible: true }, right: { visible: true } };
  const at = (w: number, hidden = false) => {
    applyWidth(ui as never, w, hidden);
    return [ui.left.visible, ui.right.visible];
  };
  expect(at(130)).toEqual([true, true]);
  expect(at(120)).toEqual([true, true]);
  expect(at(119)).toEqual([false, true]);
  expect(at(90)).toEqual([false, true]);
  expect(at(89)).toEqual([false, false]);
  expect(at(130, true)).toEqual([false, false]);
});

// ---- the host with the real Repl ----------------------------------------------------------------------

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

const ANSWER = calls([{ text: 'Карта ' }, { text: 'готова.' }]);

describe('host flows', () => {
  test('open: the three panes, the greeting card, the label', async () => {
    rig = await tuiRig(ANSWER);
    const f = await rig.until('Hello, Levi');
    expect(f).toContain('Models');
    expect(f).toContain('Chat');
    expect(f).toContain('Agents');
    expect(f).toContain('Mira');
    expect(f).toContain('you');
    expect(f).toContain('›');
  });

  test('Cyrillic + Enter: the echo, then a streamed answer card and its status', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('Привет, Мира 🎉');
    const f = await rig.until('Карта готова.');
    expect(f).toContain('Привет, Мира');
    await rig.until('swipe 1/1');
    expect(rig.input()).toBe('');
  });

  test('Shift+Enter breaks the line; Enter sends both lines as one message', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.type('первая');
    rig.setup.mockInput.pressEnter({ shift: true });
    await rig.type('вторая');
    expect(rig.input()).toBe('первая\nвторая');
    rig.setup.mockInput.pressEnter();
    await rig.until('Карта готова.');
    const head = rig.session.view().path.at(-2)!;
    expect(messageText(head)).toBe('первая\nвторая');
  });

  test('Ctrl+R (Russian layout, ctrl+к) swipes the answer', async () => {
    rig = await tuiRig(calls([{ text: 'Первый ответ.' }], [{ text: 'Второй ответ.' }]));
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    await rig.until('Первый ответ.');
    await rig.until('swipe 1/1');
    await rig.setup.mockInput.pressKeys(['\x1b[1082::114;5u']);
    await rig.until('Второй ответ.');
    await rig.until('swipe 2/2');
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Второй ответ.');
  });

  test('a Russian layout under modifyOtherKeys (no baseCode): ctrl+к swipes, ctrl+с stops the answer', async () => {
    rig = await tuiRig(calls([{ text: 'Один.' }], [{ text: 'Медленно ' }, { pause: 'p' }, { text: 'всё.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Один.');
    await rig.setup.mockInput.pressKeys(['\x1b[27;5;1082~']);
    await rig.until('Медленно');
    await rig.setup.mockInput.pressKeys(['\x1b[27;5;1089~']);
    // One stop marker (T-17): the answer's status line says it.
    await rig.until('· stopped]');
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Медленно ');
  });

  test('Alt+← browses back to the first version', async () => {
    rig = await tuiRig(calls([{ text: 'Один.' }], [{ text: 'Два.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('swipe 1/1');
    rig.setup.mockInput.pressKey('r', { ctrl: true });
    await rig.until('swipe 2/2');
    rig.setup.mockInput.pressArrow('left', { meta: true });
    await rig.until('swipe 1/2');
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Один.');
  });

  test('Ctrl+E: the last message in the input (real line breaks), edited, Enter saves', async () => {
    rig = await tuiRig(calls([{ text: 'Строка один.\nСтрока два.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('swipe 1/1');
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    await rig.until('edit ›');
    expect(rig.input()).toBe('Строка один.\nСтрока два.');
    // Hotkeys that are commands stay out of an open edit.
    rig.setup.mockInput.pressKey('r', { ctrl: true });
    await rig.type(' Правка!');
    rig.setup.mockInput.pressEnter();
    await rig.until('Правка!');
    await rig.gone('edit ›');
    const head = rig.session.view().path.at(-1)!;
    expect(messageText(head)).toBe('Строка один.\nСтрока два. Правка!');
    expect(head.edited).toBe(true);
    expect(head.swipe.count).toBe(1);
  });

  test('Esc cancels an edit: the message stays, the input is empty again', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('swipe 1/1');
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    await rig.until('edit ›');
    await rig.type('мусор');
    rig.setup.mockInput.pressEscape();
    await rig.until('edit cancelled');
    expect(rig.input()).toBe('');
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Карта готова.');
    // Esc outside an edit clears the input.
    await rig.type('черновик');
    rig.setup.mockInput.pressEscape();
    await rig.frame();
    expect(rig.input()).toBe('');
  });

  test('Ctrl+G puts /regen into the input before what was typed', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.type('мягче');
    rig.setup.mockInput.pressKey('g', { ctrl: true });
    await rig.frame();
    expect(rig.input()).toBe('/regen мягче');
  });

  test('F1 runs /help; F2 hides and shows the side panes', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.setup.mockInput.pressKeys(['F1']);
    await rig.until('/quit');
    await rig.setup.mockInput.pressKeys(['F2']);
    const hidden = await rig.gone('Agents');
    expect(hidden).not.toContain('Models');
    await rig.setup.mockInput.pressKeys(['F2']);
    const shown = await rig.until('Agents');
    expect(shown).toContain('Models');
  });

  test('Ctrl+C mid-answer stops it and keeps what arrived', async () => {
    rig = await tuiRig(calls([{ text: 'Начало ' }, { pause: 'p' }, { text: 'конец.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Начало');
    rig.setup.mockInput.pressCtrlC();
    // One stop marker (T-17): the answer's status line says it.
    await rig.until('· stopped]');
    const head = rig.session.view().path.at(-1)!;
    expect(messageText(head)).toBe('Начало ');
    expect(head.gen?.finish).toBe('stopped');
  });

  test('typing mid-answer is held; /e mid-answer is refused (the Repl rules)', async () => {
    rig = await tuiRig(calls([{ text: 'Медленно ' }, { pause: 'p' }, { text: 'всё.' }], [{ text: 'Потом.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Медленно');
    await rig.send('ещё');
    await rig.until('held');
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    await rig.until('refused [session_busy]');
    rig.provider.release('p');
    await rig.until('Потом.');
  });
});

describe('T-15 and T-16 in the host', () => {
  test('Ctrl+E with text typed in the input: the status row says why, nothing is lost, no edit opens', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('swipe 1/1');
    await rig.type('мой черновик');
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    const f = await rig.until(SEND_FIRST);
    expect(f).not.toContain('edit ›');
    expect(rig.input()).toBe('мой черновик');
    // Cleared, Ctrl+E edits the last message as before.
    rig.setup.mockInput.pressEscape();
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    await rig.until('edit ›');
    expect(rig.input()).toBe('Карта готова.');
  });

  test('Ctrl+E mid-answer with text typed: the Repl refuses /e, the text stays', async () => {
    rig = await tuiRig(calls([{ text: 'Медленно ' }, { pause: 'p' }, { text: 'всё.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Медленно');
    await rig.type('черновик');
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    const f = await rig.until('refused [session_busy]');
    expect(f).toContain('answering…');
    expect(rig.input()).toBe('черновик');
    rig.provider.release('p');
    await rig.until('всё.');
  });

  test('Warp (TERM_PROGRAM in the injected env) reaches both panes as it reaches the transcript', async () => {
    const seen: unknown[] = [];
    const { createModelsPane } = await import('../../src/cli/tui/models-pane.ts');
    const { createAgentsPane } = await import('../../src/cli/tui/agents-pane.ts');
    rig = await tuiRig(ANSWER, {
      env: { TERM_PROGRAM: 'WarpTerminal' },
      parts: {
        models: (ui, theme, o) => (seen.push(['models', o]), createModelsPane(ui, theme, o)),
        agents: (ui, theme, clock, o) => (seen.push(['agents', o]), createAgentsPane(ui, theme, clock, o)),
      },
    });
    await rig.until('Hello, Levi');
    expect(seen).toEqual([
      ['models', { warp: true }],
      ['agents', { warp: true }],
    ]);
  });

  test('hints that name the command name rp-core tui', async () => {
    rig = await tuiRig(calls([{ error: { code: 'bad_request', status: 400, message: 'upstream exploded' } }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    const f = await rig.until('--debug shows');
    expect(f).toContain(`rp-core tui ${rig.session.id} --debug`);
    expect(f).not.toContain('rp-core chat');
  });

  test('a fast command never shows "working…"', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('/help');
    await rig.until('/quit');
    await new Promise((r) => setTimeout(r, 400));
    expect(await rig.frame()).toContain('ready · Enter sends');
  });

  test('an unterminated bracketed paste: Ctrl+C still works (the paste lands in the input, then clears it), twice quits', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.setup.mockInput.pressKeys(['\x1b[200~hello there']);
    rig.setup.mockInput.pressCtrlC();
    await rig.frame();
    expect(rig.input()).toBe('');
    rig.setup.mockInput.pressCtrlC();
    await rig.until('press Ctrl+C again');
    rig.setup.mockInput.pressCtrlC();
    expect(await rig.done).toBe(0);
    expect(readFileSync(join(rig.home, 'logs', 'tui.log'), 'utf8')).toContain('paste: no end marker; ended (Ctrl+C)');
  });

  test('an unterminated bracketed paste ends by itself after a quiet second: Enter sends again', async () => {
    rig = await tuiRig(calls([{ text: 'Принято.' }]));
    await rig.until('Hello, Levi');
    await rig.setup.mockInput.pressKeys(['\x1b[200~вставка']);
    await new Promise((r) => setTimeout(r, 1200));
    await rig.frame();
    expect(rig.input()).toBe('вставка');
    rig.setup.mockInput.pressEnter();
    await rig.until('Принято.');
  }, 15_000);
});

describe('widths', () => {
  test.each([
    [130, ['Models', 'Chat', 'Agents'], []],
    [100, ['Chat', 'Agents'], ['Models']],
    [70, ['Chat'], ['Models', 'Agents']],
  ])('%i columns', async (width, shown, hidden) => {
    rig = await tuiRig(ANSWER, { width });
    const f = await rig.until('Hello');
    for (const s of shown) expect(f).toContain(s);
    for (const s of hidden) expect(f).not.toContain(s);
    for (const line of f.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  });

  test('a resize folds the panes', async () => {
    rig = await tuiRig(ANSWER, { width: 130 });
    await rig.until('Models');
    rig.setup.resize(80, 30);
    const f = await rig.gone('Agents');
    expect(f).not.toContain('Models');
    rig.setup.resize(125, 30);
    await rig.until('Models');
  });
});
