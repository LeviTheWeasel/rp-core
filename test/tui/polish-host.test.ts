// Levi's second look at the TUI, host part (TUI decisions T-17): the input stays in the chat column and
// grows up to 6 rows; its label carries no padding; the mouse is on by default (F3 turns it off, the
// left pane says so and names Shift+drag); ↑/↓ scroll the chat while the input is empty; OpenTUI's
// own selection shows in the terminal's palette and is sent with OSC 52 when it ends (not under VTE,
// which ignores it: the status row says so and claims no copy); /help lists the keys when the left
// pane is not on screen.
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { BoxRenderable, CapturedSpan, Renderable, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { rendererConfig } from '../../src/cli/tui/app.ts';
import { fileLog, tuiIo, tuiLogPath } from '../../src/cli/tui/io.ts';
import { keyRows, SHIFT_DRAG, tuiHelpLines, tuiHelpNote } from '../../src/cli/tui/keys.ts';
import { keyRows as paneKeyRows } from '../../src/cli/tui/models-pane.ts';
import { arrowScroll, ARROW_SCROLL_LINES, copiedText, ignoresOsc52, mountTui, NOT_COPIED, VTE_NO_COPY, type MountedTui } from '../../src/cli/tui/run.ts';
import { inputLabel, interruptHub, type InterruptHub } from '../../src/cli/tui/source.ts';
import { createTranscript } from '../../src/cli/tui/transcript.ts';
import { createModelsPane } from '../../src/cli/tui/models-pane.ts';
import { createAgentsPane } from '../../src/cli/tui/agents-pane.ts';
import { LAYOUT } from '../../src/cli/tui/types.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, LEVI, MIRA, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
let host: HostRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
  await host?.close();
  host = null;
});

const ANSWER = calls([{ text: 'Карта ' }, { text: 'готова.' }]);
const READY = 'ready · Enter sends';

const byId = <T extends Renderable>(setup: TestRendererSetup, id: string): T => {
  const r = setup.renderer.root.findDescendantById(id);
  if (!r) throw new Error(`no renderable ${id}`);
  return r as unknown as T;
};

/** What a frame row shows from terminal column `x` on (wide characters appear once in a char frame). */
function fromColumn(row: string, x: number): string {
  let col = 0;
  let i = 0;
  const chars = [...row];
  while (i < chars.length && col < x) col += Math.max(1, Bun.stringWidth(chars[i++]!));
  return chars.slice(i).join('');
}

/** The span covering cell (x, y) of the current frame. */
function spanAt(setup: TestRendererSetup, x: number, y: number): CapturedSpan {
  let at = 0;
  for (const sp of setup.captureSpans().lines[y]!.spans) {
    if (x < at + sp.width) return sp;
    at += sp.width;
  }
  throw new Error(`no span at ${x},${y}`);
}

// ---- a host on a renderer whose output is recorded (OSC 52 must reach the terminal) -------------------

/** A terminal stand-in: every byte the renderer sends. */
class Recorder extends Writable {
  readonly isTTY = true;
  readonly chunks: Buffer[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  override _write(chunk: Uint8Array, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  getColorDepth(): number {
    return 24;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('latin1');
  }
}

interface HostRig {
  setup: TestRendererSetup;
  out: Recorder;
  host: MountedTui;
  engine: EngineHandle;
  frame(): Promise<string>;
  until(text: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * mountTui on a headless renderer that writes to a Recorder, with the terminal set up as
 * createCliRenderer sets it up (OSC 52 needs a set-up terminal), over a scripted engine like tuiRig's.
 */
async function hostRig(width = 130, height = 30, env: Record<string, string> = {}): Promise<HostRig> {
  const home = tmpHome('rp-core-tui-');
  const provider = createScriptedProvider(ANSWER);
  const conn: Connection = { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true };
  const engine = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(7), timeZone: 'UTC', checkpoint: { chars: 8, ms: 5, datasyncMs: 5 }, retryMaxDelayMs: 5 });
  const session = engine.createSession({ character: MIRA, persona: LEVI });
  const out = new Recorder(width, height);
  const setup = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
    ...rendererConfig(),
    stdout: out as unknown as NodeJS.WriteStream,
    bufferedOutput: 'stdout',
  });
  await setup.renderer.setupTerminal();
  const log = fileLog(tuiLogPath(home), fakeClock());
  const io = tuiIo(log);
  const hub: InterruptHub = interruptHub(new EventEmitter() as never);
  const rt = { ...loadRuntime(home, {}), config: CONFIG, connections: { script: conn } };
  const h = mountTui({
    renderer: setup.renderer,
    engine,
    session,
    a: { rt, clock: fakeClock(), env: { HOME: home, ...env } },
    io,
    log,
    parts: { transcript: createTranscript, models: createModelsPane, agents: createAgentsPane },
    interrupts: hub,
  });
  const frame = async (): Promise<string> => {
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return {
    setup,
    out,
    host: h,
    engine,
    frame,
    async until(text: string): Promise<string> {
      for (let waited = 0; ; waited += 5) {
        const f = await frame();
        if (f.includes(text)) return f;
        if (waited > 5000) throw new Error(`timed out waiting for ${text}; frame:\n${f}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    async close(): Promise<void> {
      h.source.inject('/quit');
      await h.done;
      h.dispose();
      hub.dispose();
      await engine.close();
      await setup.dispose();
    },
  };
}

// ---- the input --------------------------------------------------------------------------------------

describe('T-17 the input', () => {
  test.each([100, 140])('%i columns: long input wraps inside the chat column (never into the Agents pane) and grows up to 6 rows', async (width) => {
    rig = await tuiRig(ANSWER, { width, height: 30 });
    await rig.until(READY);
    const right = byId<BoxRenderable>(rig.setup, 'agents');
    const middle = byId<BoxRenderable>(rig.setup, 'chat');
    const input = byId<TextareaRenderable>(rig.setup, 'input');
    const pane = (f: string): string[] => f.split('\n').map((row) => fromColumn(row, right.x));
    const before = pane(await rig.frame());
    expect(before.join('')).toContain('Narrator');

    const settle = async (): Promise<string> => {
      let f = '';
      for (let i = 0; i < 4; i++) f = await rig!.frame();
      return f;
    };
    // Three or so rows of words: the box wraps them and grows to fit.
    await rig.type('zebra quartz '.repeat(12));
    let f = await settle();
    expect(input.x + input.width).toBeLessThanOrEqual(middle.x + middle.width - 1);
    expect(pane(f)).toEqual(before);
    expect(input.height).toBeGreaterThan(1);
    expect(input.height).toBeLessThan(LAYOUT.inputMaxRows);
    // Much more: six rows at most, still inside the column.
    await rig.type('zebra quartz '.repeat(40));
    f = await settle();
    expect(input.height).toBe(LAYOUT.inputMaxRows);
    expect(input.x + input.width).toBeLessThanOrEqual(middle.x + middle.width - 1);
    expect(pane(f)).toEqual(before);
    expect(pane(f).join('')).not.toContain('zebra');
  });

  test('inputLabel: the SGR and the padding go (`you › `, `edit › `)', () => {
    expect(inputLabel('\x1b[1myou      \x1b[22m › ')).toBe('you › ');
    expect(inputLabel('\x1b[1medit\x1b[22m › ')).toBe('edit › ');
    expect(inputLabel('you › ')).toBe('you › ');
    expect(inputLabel('')).toBe('');
  });

  test('the label is `you › ` next to the input, `edit › ` while editing in place', async () => {
    rig = await tuiRig(ANSWER);
    const row = (f: string, text: string): string => f.split('\n').find((r) => r.includes(text)) ?? '';
    let f = await rig.until('Write your line');
    // Mira is wider than `you`: the REPL pads its label to 4 (`you  › `); the input does not.
    expect(row(f, 'Write your line')).toContain('│ you › Write your line');
    await rig.send('Привет');
    await rig.until('Карта готова.');
    await rig.until(READY);
    // Ctrl+E: the last message (the answer) in the box.
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    f = await rig.until('edit › ');
    expect(row(f, 'edit › ')).toContain('│ edit › Карта готова.');
    expect(fromColumn(row(f, 'edit › '), byId<Renderable>(rig.setup, 'label').x)).toStartWith('edit › Карта готова.');
  });
});

// ---- the mouse -----------------------------------------------------------------------------------------

describe('T-17 the mouse', () => {
  test('on by default; the left pane says so and names Shift+drag; F3 turns it off', async () => {
    expect(rendererConfig().useMouse).toBe(true);
    expect(rendererConfig(false).useMouse).toBe(false);
    rig = await tuiRig(ANSWER);
    let f = await rig.until('Shift+drag');
    expect(rig.setup.renderer.useMouse).toBe(true);
    expect(f).toContain('F3         mouse: on');
    expect(f).toContain('Shift+drag select');
    await rig.setup.mockInput.pressKeys(['F3']);
    f = await rig.until('mouse: off');
    expect(rig.setup.renderer.useMouse).toBe(false);
    expect(f).toContain('Shift+drag select');
  });

  test('keyRows: Shift+drag right after F3, the same list the models pane shows; every row fits 24 columns', () => {
    for (const mouse of [true, false]) {
      const rows = keyRows({ newlineKey: 'Alt+Enter', mouse });
      const f3 = rows.findIndex(([label]) => label === 'F3');
      expect(rows[f3]).toEqual(['F3', `mouse: ${mouse ? 'on' : 'off'}`]);
      expect(rows[f3 + 1]).toEqual([...SHIFT_DRAG]);
      expect(paneKeyRows({ newlineKey: 'Alt+Enter', mouse })).toEqual(rows);
      // The pane's rule (T-15): label ≤ 10 and description ≤ 13 columns, or the newline key's 11 + 1 + 8.
      for (const [label, description] of rows) expect(Math.min(Bun.stringWidth(label), 10) + 1 + Bun.stringWidth(description)).toBeLessThanOrEqual(24);
    }
  });
});

// ---- ↑ / ↓ --------------------------------------------------------------------------------------------

describe('T-17 ↑ / ↓', () => {
  test('arrowScroll: plain ↑ / ↓ only', () => {
    const k = (name: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({ name, ctrl: false, meta: false, shift: false, ...mods });
    expect(arrowScroll(k('up'))).toBe(-ARROW_SCROLL_LINES);
    expect(arrowScroll(k('down'))).toBe(ARROW_SCROLL_LINES);
    expect(ARROW_SCROLL_LINES).toBe(3);
    expect(arrowScroll(k('up', { meta: true }))).toBe(0);
    expect(arrowScroll(k('down', { shift: true }))).toBe(0);
    expect(arrowScroll(k('left'))).toBe(0);
  });

  test('with an empty input they scroll the chat by 3 lines; with text they stay the input’s', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n');
    rig = await tuiRig(calls([{ text: long }]), { height: 24 });
    await rig.until('Hello, Levi');
    await rig.send('go');
    await rig.until('row 39');
    await rig.until(READY);
    const box = byId<ScrollBoxRenderable>(rig.setup, 'transcript');
    const bottom = box.scrollTop;
    expect(bottom).toBeGreaterThan(2 * ARROW_SCROLL_LINES);

    rig.setup.mockInput.pressArrow('up');
    await rig.frame();
    expect(box.scrollTop).toBe(bottom - ARROW_SCROLL_LINES);
    rig.setup.mockInput.pressArrow('up');
    await rig.frame();
    expect(box.scrollTop).toBe(bottom - 2 * ARROW_SCROLL_LINES);
    rig.setup.mockInput.pressArrow('down');
    await rig.frame();
    expect(box.scrollTop).toBe(bottom - ARROW_SCROLL_LINES);
    rig.setup.mockInput.pressArrow('down');
    await rig.frame();
    expect(box.scrollTop).toBe(bottom);

    // Text in the input: ↑ moves the cursor a line up, the chat stays.
    await rig.type('ab');
    rig.setup.mockInput.pressEnter({ shift: true });
    await rig.type('cd');
    rig.setup.mockInput.pressArrow('up');
    await rig.type('X');
    await rig.frame();
    expect(rig.input()).toBe('abX\ncd');
    expect(box.scrollTop).toBe(bottom);
  });
});

// ---- the selection -----------------------------------------------------------------------------------------

describe('T-17 OpenTUI selection', () => {
  test('a drag over the panes, the status row, the label and the input selects in palette 8 behind the default foreground', async () => {
    rig = await tuiRig(ANSWER, { width: 130, height: 34 });
    await rig.until(READY);
    await rig.type('hello there');
    await rig.frame();
    for (const id of ['models-body', 'agents-body', 'agents-usage', 'status', 'label', 'input']) {
      const r = byId<Renderable>(rig.setup, id);
      await rig.setup.mockMouse.drag(r.x, r.y, r.x + 3, r.y);
      await rig.frame();
      const sp = spanAt(rig.setup, r.x + 1, r.y);
      expect({ id, text: sp.text.trim() !== '', bg: sp.bg.intent, slot: sp.bg.slot, fg: sp.fg.intent }).toEqual({ id, text: true, bg: 'indexed', slot: 8, fg: 'default' });
    }
  });

  test('a selection that ends is sent with OSC 52 (the bytes reach the terminal); the status row says it was sent', async () => {
    host = await hostRig();
    await host.until(READY);
    const body = byId<Renderable>(host.setup, 'models-body');
    await host.frame();
    const sent = host.out.chunks.length;
    // A click selects nothing: nothing is copied.
    await host.setup.mockMouse.click(body.x + 1, body.y);
    await host.frame();
    expect(Buffer.concat(host.out.chunks.slice(sent)).toString('latin1')).not.toContain('\x1b]52;');

    await host.setup.mockMouse.drag(body.x, body.y, body.x + 3, body.y);
    const text = host.setup.renderer.getSelection()?.getSelectedText() ?? '';
    expect(text).toBe('Mira');
    const f = await host.until(copiedText(4));
    // Sent, not "copied": no terminal confirms that OSC 52 reached the clipboard.
    expect(f).toContain('sent 4 chars to the clipboard');
    expect(f).not.toContain('copied');
    await host.frame();
    expect(host.out.text()).toContain(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`);
  });

  /** Drag over "Mira" in the models pane; what the terminal got from the drag on, and the frame once `status` shows. */
  const dragMira = async (h: HostRig, status: string): Promise<{ frame: string; sent: string }> => {
    await h.until(READY);
    const body = byId<Renderable>(h.setup, 'models-body');
    await h.frame();
    const from = h.out.chunks.length;
    await h.setup.mockMouse.drag(body.x, body.y, body.x + 3, body.y);
    expect(h.setup.renderer.getSelection()?.getSelectedText()).toBe('Mira');
    const frame = await h.until(status);
    await h.frame();
    return { frame, sent: Buffer.concat(h.out.chunks.slice(from)).toString('latin1') };
  };

  test('VTE (GNOME Terminal): nothing is sent and no copy is claimed; the status row points at Shift+drag', async () => {
    host = await hostRig(130, 30, { VTE_VERSION: '7600', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    const { frame, sent } = await dragMira(host, VTE_NO_COPY);
    expect(frame).toContain('this terminal ignores copy requests: select with Shift+drag');
    expect(frame).not.toContain('to the clipboard');
    expect(frame).not.toContain('copied');
    expect(sent).not.toContain('\x1b]52;');
    expect(host.out.text()).not.toContain('\x1b]52;');
    // The status row is yellow, as for the other copy that does not happen.
    const rows = frame.split('\n');
    const row = rows.findIndex((r) => r.includes(VTE_NO_COPY));
    const x = Bun.stringWidth(rows[row]!.slice(0, rows[row]!.indexOf('this terminal')));
    expect(spanAt(host.setup, x, row).fg.slot).toBe(3);
  });

  test('a VTE_VERSION inherited by Warp (started from GNOME Terminal): Warp takes OSC 52, it is sent', async () => {
    host = await hostRig(130, 30, { VTE_VERSION: '7600', TERM_PROGRAM: 'WarpTerminal' });
    const { frame, sent } = await dragMira(host, copiedText(4));
    expect(frame).not.toContain(VTE_NO_COPY);
    expect(sent).toContain(`\x1b]52;c;${Buffer.from('Mira').toString('base64')}\x1b\\`);
  });

  test('ignoresOsc52: VTE_VERSION set and no known OSC 52 terminal overriding it', () => {
    expect(ignoresOsc52({})).toBe(false);
    expect(ignoresOsc52({ TERM_PROGRAM: 'WarpTerminal' })).toBe(false);
    expect(ignoresOsc52({ VTE_VERSION: '' })).toBe(false);
    expect(ignoresOsc52({ VTE_VERSION: '7600' })).toBe(true);
    expect(ignoresOsc52({ VTE_VERSION: '7600', TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toBe(true);
    // tmux inside GNOME Terminal: the outer terminal still drops it.
    expect(ignoresOsc52({ VTE_VERSION: '7600', TERM_PROGRAM: 'tmux', TERM: 'tmux-256color' })).toBe(true);
    for (const term of ['WarpTerminal', 'WezTerm', 'iTerm.app', 'kitty', 'ghostty']) expect(ignoresOsc52({ VTE_VERSION: '7600', TERM_PROGRAM: term })).toBe(false);
    expect(ignoresOsc52({ VTE_VERSION: '7600', TERM: 'xterm-kitty' })).toBe(false);
    expect(ignoresOsc52({ VTE_VERSION: '7600', KITTY_WINDOW_ID: '1' })).toBe(false);
  });

  test('a terminal the copy cannot reach: the status row says so, nothing throws', async () => {
    // tuiRig's renderer never set its terminal up: OpenTUI refuses the OSC 52 write.
    rig = await tuiRig(ANSWER);
    await rig.until(READY);
    const body = byId<Renderable>(rig.setup, 'models-body');
    await rig.setup.mockMouse.drag(body.x, body.y, body.x + 3, body.y);
    expect(await rig.until('not copied')).toContain(NOT_COPIED.slice(0, 30));
  });

  test('copiedText: what was sent, never "copied"', () => {
    expect(copiedText(1)).toBe('sent 1 char to the clipboard');
    expect(copiedText(12)).toBe('sent 12 chars to the clipboard');
  });
});

// ---- /help ---------------------------------------------------------------------------------------------

describe('T-17 /help lists the keys when the left pane is not on screen', () => {
  test('tuiHelpLines: the note alone when the keys are shown; else the note and every key row, aligned', () => {
    const extra = { newlineKey: 'Alt+Enter', mouse: true };
    expect(tuiHelpLines(extra, true)).toEqual([tuiHelpNote(true)]);
    const lines = tuiHelpLines(extra, false);
    expect(lines[0]).toContain('/e and Ctrl+E edit in the input box');
    const rows = keyRows(extra);
    expect(lines.slice(1)).toHaveLength(rows.length);
    const column = 2 + Math.max(...rows.map(([l]) => Bun.stringWidth(l))) + 2;
    lines.slice(1).forEach((line, i) => {
      const [label, description] = rows[i]!;
      expect(line).toStartWith(`  ${label}`);
      expect(line).toEndWith(description);
      expect(Bun.stringWidth(line) - Bun.stringWidth(description)).toBe(column);
    });
    expect(lines).toContain(`  Shift+drag${' '.repeat(column - 2 - 10)}select`);
  });

  test.each([
    [130, false, true],
    [100, false, false],
    [130, true, false],
  ])('%i columns (F2 pressed: %p): the view is told whether the keys are on screen (%p)', async (width, f2, shown) => {
    rig = await tuiRig(ANSWER, { width });
    await rig.until(READY);
    if (f2) {
      await rig.setup.mockInput.pressKeys(['F2']);
      await rig.gone('Agents');
    }
    await rig.setup.mockInput.pressKeys(['F1']);
    const f = await rig.until('/quit');
    if (shown) await rig.until('listed on the left');
    else {
      const last = await rig.until('Shift+drag  select');
      expect(last).toContain('mouse: on');
      expect(f).not.toContain('listed on the left');
    }
  });
});
