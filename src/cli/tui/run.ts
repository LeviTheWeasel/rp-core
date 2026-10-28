// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core tui <session>` (TUI decisions T-1, T-3, T-6, T-9, T-10, T-13…T-16): the same Repl as
// `rp-core chat`, hosted full-screen. The engine and the session open BEFORE the renderer, so a lock
// or a missing session is refused as a normal CLI error. The Repl reads lines from the input box
// (TextareaSource) and shows everything through TuiView; hotkeys that are commands go in as typed
// lines, so the Repl's rules (held text, refused edits mid-turn) apply unchanged. Ctrl+C (the key, or
// SIGINT from outside) is one press of the Repl's interrupt handler.
// Every exit signal is ours (T-13): SIGTERM, SIGHUP (the terminal closed), SIGQUIT, SIGABRT, SIGPIPE
// and SIGBUS take runChat's SIGTERM path: say so, close the engine (the turn stops with its partial
// text kept, the lock is released), leave with 128 + the signal's number; a second one leaves at once.
// OpenTUI handles none of them, and if the renderer goes away any other way the Repl's input ends.
// Leaving: destroy the renderer, wait until the terminal is restored, then the Io writes to the real
// channels again, the restored terminal is told what the TUI could not show (T-14: a signal's line,
// lines said while the TUI shut down, the exit summary of an exit 1 / 3 / 130), and the engine closes
// as runChat closes it.
// T-17: the mouse is on by default (F3 turns it off); a selection that ends is sent with OSC 52 (not
// under VTE, which ignores it: the status row says to Shift+drag); ↑ / ↓ scroll the chat while the
// input is empty; /help lists the keys when the left pane is hidden.

import { constants as osConstants } from 'node:os';
import { createCliRenderer, type CliRenderer, type KeyEvent, type Selection } from '@opentui/core';
import { Engine } from '../../engine/engine.ts';
import { Refusal, type EngineHandle, type SessionHandle } from '../../engine/api.ts';
import { systemClock } from '../../engine/system.ts';
import type { Event } from '../../protocol/events.ts';
import { chatDeps, endChat, TERMINATED_LINE, type ChatArgs } from '../chat.ts';
import type { Channel } from '../io.ts';
import { EXIT, reportRefusal } from '../oneshot.ts';
import { runReplWith } from '../repl.ts';
import { stripAnsi } from '../repl-render.ts';
import type { ReplView, TurnView } from '../repl-view.ts';
import { engineOptions } from '../runtime.ts';
import { EXIT_SIGINT } from '../signals.ts';
import { isLaneEvent } from './agents.ts';
import { createContextPane } from './context-pane.ts';
import { applyWidth, createUi, rendererConfig, type HostUi } from './app.ts';
import { fileLog, tuiIo, tuiLogPath, type FileLog, type TuiIo } from './io.ts';
import { hotkeyAction, isInterruptKey, newlineKey } from './keys.ts';
import { createModelPicker } from './model-picker.ts';
import { createStoryPicker } from './story-picker.ts';
import { interruptHub, pasteGuard, TextareaSource, type InterruptHub } from './source.ts';
import type { TranscriptOptions } from './transcript.ts';
import { MONO_THEME, THEME } from './theme.ts';
import type { AgentsPaneApi, HotkeyAction, ModelsPaneApi, Theme, TranscriptApi, Ui } from './types.ts';
import { TuiView } from './view.ts';

const EDITING = 'editing in place · Enter saves · Esc or Ctrl+C cancels';
/** Ctrl+E while the input holds typed text (T-15): /e would put the message over it. */
export const SEND_FIRST = 'send or clear the input first (Esc)';
/** A command still runs after WORKING_AFTER_MS (/probe --active, /preview of a big session) (T-15). */
export const WORKING = 'working… · lines sent now wait their turn';
export const WORKING_AFTER_MS = 300;
/** ↑ / ↓ with an EMPTY input scroll the chat by this many lines (T-17). */
export const ARROW_SCROLL_LINES = 3;
/**
 * The status row after a selection was sent with OSC 52 (T-17). A terminal never answers OSC 52, so
 * this says what was sent, not that it reached the clipboard.
 */
export function copiedText(chars: number): string {
  return `sent ${chars} ${chars === 1 ? 'char' : 'chars'} to the clipboard`;
}
/** The status row when the copy could not be sent (no OSC 52, or the terminal is not set up). */
export const NOT_COPIED = 'not copied (no OSC 52 here) · Shift+drag selects natively';
/** The status row after a selection under VTE (GNOME Terminal, Tilix, Terminator…): nothing is sent. */
export const VTE_NO_COPY = 'this terminal ignores copy requests: select with Shift+drag';

/** TERM_PROGRAM of terminals that take OSC 52 (a VTE_VERSION they inherited does not make them VTE). */
const OSC52_TERM_PROGRAMS: ReadonlySet<string> = new Set(['WarpTerminal', 'WezTerm', 'iTerm.app', 'kitty', 'ghostty']);

/**
 * The environment shows a VTE terminal, which ignores OSC 52 (nothing reaches the clipboard): VTE_VERSION
 * is set and no known OSC 52 terminal overrides it (Warp, WezTerm, iTerm, kitty, Ghostty started from a
 * GNOME Terminal inherit its VTE_VERSION).
 */
export function ignoresOsc52(env: Record<string, string | undefined>): boolean {
  if (!env.VTE_VERSION) return false;
  if (OSC52_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? '')) return false;
  // kitty sets no TERM_PROGRAM.
  return !env.KITTY_WINDOW_ID && env.TERM !== 'xterm-kitty';
}

/**
 * Lines a key scrolls the chat by when the input is empty (T-17): ↑ -ARROW_SCROLL_LINES, ↓ +, any
 * other key (or a modified arrow: Alt+← / → are the versions) 0. A wheel that a terminal turned into
 * arrows scrolls the chat too.
 */
export function arrowScroll(k: Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift'>): number {
  if (k.ctrl || k.meta || k.shift) return 0;
  return k.name === 'up' ? -ARROW_SCROLL_LINES : k.name === 'down' ? ARROW_SCROLL_LINES : 0;
}

/** At most this many of the Repl's last lines are repeated on the restored terminal after an exit 1 / 3 / 130. */
const SUMMARY_LINES = 6;
/** How long leaving waits for the renderer to restore the terminal (after a hangup it may never say so). */
const CLOSE_WAIT_MS = 2000;

/** What `rp-core tui` cannot run without. */
export const NEEDS_TERMINAL = 'rp-core tui needs a terminal; use rp-core chat';

/** The signals that end the TUI on the SIGTERM path (T-13); SIGINT is the Repl's (Ctrl+C). */
export const EXIT_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGBUS'] as const;
export type ExitSignal = (typeof EXIT_SIGNALS)[number];

/** The process, or a test's emitter: SIGINT (the hub) and every exit signal. */
export interface ExitSignalSource {
  on(signal: 'SIGINT' | ExitSignal, listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | ExitSignal, listener: () => void): unknown;
}

/** The process, or a test's emitter: where uncaught errors and unhandled rejections arrive (T-10). */
export interface ErrorEventSource {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown;
  removeListener(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown;
}

/** 128 + the signal's number, as shells report it (SIGHUP 129, SIGTERM 143). */
export function signalExitCode(sig: ExitSignal): number {
  return 128 + (osConstants.signals[sig] ?? 15);
}

/** What a signal says before the session closes: SIGTERM runChat's line byte for byte, the others name themselves. */
export function signalLine(sig: ExitSignal): string {
  return sig === 'SIGTERM' ? TERMINATED_LINE : `rp-core: ${sig}: closing the session (the partial answer is kept)`;
}

/** The transcript and the panes (their own modules; tests may pass stand-ins). */
export interface TuiParts {
  transcript(ui: Ui, theme: Theme, o: TranscriptOptions): TranscriptApi;
  /** `o.warp`: TERM_PROGRAM=WarpTerminal in the injected env (the panes sanitise as the transcript does). */
  models(ui: Ui, theme: Theme, o?: { warp?: boolean }): ModelsPaneApi;
  agents(ui: Ui, theme: Theme, clock: () => Date, o?: { warp?: boolean }): AgentsPaneApi;
}

async function defaultParts(): Promise<TuiParts> {
  const [t, m, a] = await Promise.all([import('./transcript.ts'), import('./models-pane.ts'), import('./agents-pane.ts')]);
  return { transcript: t.createTranscript, models: m.createModelsPane, agents: a.createAgentsPane };
}

export interface TuiArgs extends ChatArgs {
  /** SIGINT and the exit signals (default process; tests pass an emitter). */
  signals?: ExitSignalSource;
  /** Uncaught errors and unhandled rejections (default process; tests pass an emitter). */
  errors?: ErrorEventSource;
  /** Environment (NO_COLOR, TERM_PROGRAM, VTE_VERSION, HOME); default process.env. */
  env?: Record<string, string | undefined>;
  /** The renderer (tests: a headless one). Default createCliRenderer(rendererConfig()). */
  createRenderer?: () => Promise<CliRenderer>;
  /** Stand-ins for the transcript and the panes (tests). */
  parts?: Partial<TuiParts>;
  /** The Repl's double Ctrl+C window (tests). */
  exitWindowMs?: number;
  /** An unterminated bracketed paste ends after this long without a byte (default PASTE_IDLE_MS). */
  pasteIdleMs?: number;
  /** "working…" shows when a command still runs after this long (default WORKING_AFTER_MS). */
  workingAfterMs?: number;
  /** Minimum time to show the first rendered loading screen (tests may pass 0). */
  splashMs?: number;
}

/** `rp-core tui <session>`: needs a terminal (else 64); refusals at open print as CLI errors (5). */
export async function cmdTui(a: TuiArgs & { sessionId: string; tty?: boolean }): Promise<number> {
  const tty = a.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!tty) {
    a.io.err.write(`${NEEDS_TERMINAL}\n`);
    return EXIT.usage;
  }
  const engine = await Engine.open({ ...a.engine, ...engineOptions(a.rt) });
  // Before the open: the lane's notices at open are on the bus only (ChatArgs.events).
  const events = engine.events();
  let session: SessionHandle;
  try {
    session = engine.session(a.sessionId);
  } catch (e) {
    await engine.close();
    if (e instanceof Refusal) return reportRefusal(a.io, e, false, a.rt);
    throw e;
  }
  return runTui(engine, session, { ...a, events });
}

/** A write to a terminal that may be gone (EIO after a hangup): never throws. */
function write(c: Channel, text: string): void {
  try {
    c.write(text);
  } catch {
    /* the terminal is gone */
  }
}

/** `p` settled, or `ms` passed. */
function settle(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
    const done = (): void => {
      clearTimeout(t);
      resolve();
    };
    p.then(done, done);
  });
}

/** Run the TUI on an open session of `engine` (cmdTui, `new --tui`); closes the engine at the end. */
export async function runTui(engine: EngineHandle, session: SessionHandle, a: TuiArgs): Promise<number> {
  const clock = a.clock ?? systemClock;
  const log = fileLog(tuiLogPath(a.rt.home), clock);
  const io = tuiIo(log);
  const signals: ExitSignalSource = a.signals ?? process;
  const errors: ErrorEventSource = a.errors ?? process;
  let renderer: CliRenderer | null = null;
  let host: MountedTui | null = null;
  let closing: Promise<void> | null = null;
  /** What the restored terminal is told (T-14), in order. */
  const after: string[] = [];
  // --debug outside the Repl's run (before it starts, while it winds down): through the TUI's Io too,
  // never into the frame. The Repl's own tap replaces this while it runs (chatDeps).
  const plainDebug = a.rt.debug;
  if (plainDebug) a.rt.debug = (line) => io.err.write(`rp-core: debug: ${line}\n`);

  // Handlers first (T-10): nothing below may leave the terminal in the alternate screen.
  const onError = (e: unknown): void => {
    log.error(e, 'uncaught');
    host?.ui.setStatus(`error: ${e instanceof Error ? e.message : String(e)} (see logs/tui.log)`, 'red');
  };
  errors.on('uncaughtException', onError);
  errors.on('unhandledRejection', onError);
  const restore = (): Promise<void> => {
    closing ??= (async () => {
      host?.dispose();
      hub.dispose();
      if (renderer) {
        try {
          renderer.destroy();
        } catch (e) {
          log.error(e, 'destroy');
        }
        await settle(renderer.closed, CLOSE_WAIT_MS);
      }
      io.detach(a.io);
      // OpenTUI 0.7.0 leaves grapheme mode 2027 on (#1727).
      if (renderer) write(a.io.out, '\x1b[?2027l');
      errors.removeListener('uncaughtException', onError);
      errors.removeListener('unhandledRejection', onError);
      if (plainDebug) a.rt.debug = plainDebug;
      log.line('closed');
    })();
    return closing;
  };
  /** The restored terminal is told what the TUI could not show (once), as plain text. */
  const tell = (): void => {
    for (const line of after.splice(0)) write(a.io.err, `${stripAnsi(line)}\n`);
  };
  /** Set once leave() decided the exit code (a signal, an orphan Ctrl+C): runTui's own end then logs nothing. */
  let leftWith: number | null = null;
  const leave = (code: number): void => {
    leftWith ??= code;
    void restore()
      .then(tell)
      .finally(() => {
        log.line(`exit ${code}`);
        a.exitNow(code);
      });
  };
  // A SIGINT while no Repl listens (startup, teardown) leaves cleanly instead of killing the process.
  const hub = interruptHub(signals, () => leave(EXIT_SIGINT));
  // Every exit signal takes the SIGTERM path (T-13); a second one leaves at once (the process's exit
  // hook still resets the terminal).
  let terminating = false;
  const onSignal = (sig: ExitSignal): void => {
    const code = signalExitCode(sig);
    if (terminating) return a.exitNow(code);
    terminating = true;
    const line = signalLine(sig);
    // While the renderer is up: a transcript row and the log; the restored terminal is told again.
    if (closing) log.line(line);
    else io.err.write(line);
    after.push(line);
    void engine
      .close()
      .catch((e: unknown) => log.error(e, 'close'))
      .finally(() => leave(code));
  };
  const offSignals = EXIT_SIGNALS.map((sig) => {
    const h = (): void => onSignal(sig);
    signals.on(sig, h);
    return () => void signals.removeListener(sig, h);
  });
  const unlisten = (): void => offSignals.forEach((off) => off());

  let code: number;
  try {
    const parts = { ...(a.parts && a.parts.transcript && a.parts.models && a.parts.agents ? {} : await defaultParts()), ...a.parts } as TuiParts;
    renderer = await (a.createRenderer ?? (() => createCliRenderer(rendererConfig())))();
    log.line(`open ${session.id} ${renderer.width}x${renderer.height}`);
    host = mountTui({ renderer, engine, session, a, io, log, parts, interrupts: hub, late: (text) => void after.push(text) });
    code = await host.done;
  } catch (e) {
    log.error(e, 'startup');
    unlisten();
    await restore();
    tell();
    await engine.close();
    throw e;
  }
  // Why the Repl left with 1, 3 or 130: its last lines, which the frame no longer shows.
  if (code !== 0) after.unshift(...host.summary());
  await restore();
  tell();
  // The signals stay ours until the terminal is restored: one arriving meanwhile still leaves cleanly.
  unlisten();
  if (leftWith === null) log.line(`exit ${code}`);
  return endChat(engine, code);
}

export interface MountedTui {
  ui: HostUi;
  source: TextareaSource;
  /** The view, once the Repl built it. */
  view(): TuiView | null;
  /** The Repl's exit code. */
  done: Promise<number>;
  /** What the Repl said since it last waited for input or echoed a line (its last SUMMARY_LINES lines). */
  summary(): string[];
  /** Remove the key, resize, destroy and event listeners and the paste guard; later output goes to `late`. */
  dispose(): void;
}

export interface MountOptions {
  renderer: CliRenderer;
  engine: EngineHandle;
  session: SessionHandle;
  a: Pick<TuiArgs, 'rt' | 'fetch' | 'clock' | 'env' | 'exitWindowMs' | 'pasteIdleMs' | 'workingAfterMs' | 'splashMs' | 'events'>;
  io: TuiIo;
  log: FileLog;
  parts: TuiParts;
  interrupts: InterruptHub;
  /** Output that arrives after dispose() or once the renderer is gone (runTui: told on the restored terminal). */
  late?: (text: string) => void;
}

/** Build the frame on `renderer`, wire the keys and run the Repl in it. */
export function mountTui(o: MountOptions): MountedTui {
  const { renderer, engine, a, io, log } = o;
  const env = a.env ?? process.env;
  const clock = a.clock ?? systemClock;
  const theme = env.NO_COLOR ? MONO_THEME : THEME;
  const ui = createUi(renderer, theme, a.splashMs);
  let view: TuiView | null = null;
  let currentModel: { conn: string; model: string } | null = null;
  let currentSessionId: string | null = o.session.id;
  let pendingBranch: { sessionId: string; leaf: string } | null = null;
  const warp = env.TERM_PROGRAM === 'WarpTerminal';
  const noOsc52 = ignoresOsc52(env);
  // Finished cards show reasoning as /think says (the Repl's live state, read through the view).
  const transcript = o.parts.transcript(ui, theme, { warp, showReasoning: () => view?.reasoningShown() ?? false });
  const models = o.parts.models(ui, theme, { warp });
  const agents = o.parts.agents(ui, theme, clock, { warp });
  const context = createContextPane(ui, theme, a.rt, a.fetch ?? fetch, { warp });
  let disposed = false;
  const live = (): boolean => !disposed && !renderer.isDestroyed;

  let manualHidden = false;
  applyWidth(ui, renderer.width, manualHidden);
  const onResize = (w: number): void => applyWidth(ui, w, manualHidden);
  renderer.on('resize', onResize);

  io.attach((text) => {
    if (live()) transcript.system(text);
    else o.late?.(text);
  });
  const source: TextareaSource = new TextareaSource(ui.input, (label) => {
    ui.setLabel(label);
    if (source.promptMode === 'edit') ui.setStatus(EDITING, 'yellow');
  });
  const editing = (): boolean => source.promptMode === 'edit';

  // ---- the status row while a command runs (T-15) ----
  const workingAfterMs = a.workingAfterMs ?? WORKING_AFTER_MS;
  /** A line went to the Repl and it has not waited for input since. */
  let busy = false;
  /** Lines sent while busy (no turn) that the Repl has not echoed yet: it runs them in order. */
  let queued = 0;
  let workTimer: ReturnType<typeof setTimeout> | null = null;
  const unarm = (): void => {
    if (workTimer !== null) clearTimeout(workTimer);
    workTimer = null;
  };
  const showWork = (): void => {
    unarm();
    if (!busy || view?.turning || editing() || !live()) return;
    ui.setStatus(queued > 0 ? `working… · queued: ${queued}` : WORKING);
  };
  const arm = (): void => {
    unarm();
    workTimer = setTimeout(showWork, workingAfterMs);
    (workTimer as { unref?: () => void }).unref?.();
  };
  /** A line goes to the Repl (Enter, a command hotkey). A turn says itself what happens to it. */
  const sent = (line: string): void => {
    if (line.trim() === '' || editing() || view?.turning) return;
    if (!busy) {
      busy = true;
      return arm();
    }
    queued++;
    showWork();
  };

  const picker = createModelPicker(ui, theme, a.rt, a.fetch ?? fetch, () => currentModel, ({ conn, model }) => {
    const line = `/model narrator ${conn}:${model}`;
    sent(line);
    source.inject(line);
    transcript.scroll('bottom');
  });
  const storyPicker = createStoryPicker(ui, theme, a.rt.home, () => currentSessionId, (id, leaf) => {
    if (id !== currentSessionId) {
      pendingBranch = leaf ? { sessionId: id, leaf } : null;
      const line = `/open ${id}`;
      sent(line); source.inject(line); transcript.scroll('bottom');
    } else if (leaf) {
      const line = `/goto ${leaf}`;
      sent(line); source.inject(line); transcript.scroll('bottom');
    }
  });

  ui.input.onSubmit = () => {
    sent(ui.input.plainText);
    source.submit();
    transcript.scroll('bottom');
  };

  const act = (x: HotkeyAction): void => {
    switch (x.kind) {
      case 'command':
        // An in-place edit owns the box: a command line now would become the edited text.
        if (editing()) return;
        sent(x.line);
        source.inject(x.line);
        // Its output lands at the bottom, as after Enter.
        transcript.scroll('bottom');
        return;
      case 'prefill': {
        if (editing()) return;
        const typed = ui.input.plainText;
        ui.input.setText(typed.startsWith(x.text) ? typed : `${x.text}${typed}`);
        ui.input.gotoBufferEnd();
        return;
      }
      case 'ui':
        switch (x.what) {
          case 'scrollPageUp':
            return transcript.scroll('pageUp');
          case 'scrollPageDown':
            return transcript.scroll('pageDown');
          case 'scrollTop':
            return transcript.scroll('top');
          case 'scrollBottom':
            return transcript.scroll('bottom');
          case 'togglePanes':
            manualHidden = !manualHidden;
            return applyWidth(ui, renderer.width, manualHidden);
          case 'toggleMouse':
            renderer.useMouse = !renderer.useMouse;
            return view?.refresh();
          case 'modelPicker':
            if (editing() || view?.turning) return;
            if (a.rt.provider) return ui.setStatus('model picker is unavailable with --provider', 'yellow');
            return picker.open();
          case 'storyPicker':
            if (editing() || view?.turning) return;
            return storyPicker.open();
          case 'escape':
            // Esc cancels an in-place edit exactly as Ctrl+C does (the Repl says "edit cancelled").
            if (editing()) return o.interrupts.fire();
            return ui.input.setText('');
          case 'editLast':
            if (editing()) return;
            // /e puts the message into the box: what was typed there would be lost (T-15). Mid-answer
            // the Repl refuses /e itself and the box is left alone.
            if (!view?.turning && ui.input.plainText.trim() !== '') return ui.setStatus(SEND_FIRST, 'yellow');
            sent('/e');
            source.inject('/e');
            transcript.scroll('bottom');
            return;
        }
    }
  };
  const onKey = (k: KeyEvent): void => {
    if (k.eventType === 'release') return;
    if (isInterruptKey(k)) {
      k.preventDefault();
      o.interrupts.fire();
      return;
    }
    if (picker.handle(k)) return;
    if (storyPicker.handle(k)) return;
    // T-17: ↑ / ↓ scroll the chat while the input is empty; with text in it they stay the input's.
    const lines = arrowScroll(k);
    if (lines !== 0 && ui.input.plainText === '') {
      k.preventDefault();
      ui.transcript.scrollBy(lines);
      return;
    }
    const x = hotkeyAction(k);
    if (!x) return;
    k.preventDefault();
    try {
      act(x);
    } catch (e) {
      log.error(e, 'hotkey');
    }
  };
  renderer.keyInput.on('keypress', onKey);
  const onCaps = (): void => view?.refresh();
  renderer.on('capabilities', onCaps);
  // T-17: a selection that ends (OpenTUI's own: a plain drag while the mouse is on) is sent with
  // OSC 52 (Warp, kitty, WezTerm, iTerm). VTE ignores it: nothing is sent and nothing is claimed, the
  // status row points at Shift+drag (the terminal's own selection). Elsewhere the row says what was sent:
  // no terminal confirms that it reached the clipboard.
  const onSelection = (sel: Selection | null): void => {
    try {
      const text = sel?.getSelectedText() ?? '';
      if (text === '' || !live()) return;
      if (noOsc52) ui.setStatus(VTE_NO_COPY, 'yellow');
      else if (renderer.copyToClipboardOSC52(text)) ui.setStatus(copiedText([...text].length));
      else ui.setStatus(NOT_COPIED, 'yellow');
    } catch (e) {
      log.error(e, 'copy');
      ui.setStatus(NOT_COPIED, 'yellow');
    }
  };
  renderer.on('selection', onSelection);
  // T-13: the renderer gone any other way than our own leaving: the Repl's input ends, so it closes
  // the session and runTui finishes as after /quit.
  const onDestroy = (): void => {
    log.line('the renderer was destroyed: the input ends');
    source.close();
  };
  renderer.on('destroy', onDestroy);
  // T-16: a bracketed paste without its end marker must not swallow Enter and Ctrl+C.
  const unguard = pasteGuard(renderer.stdin, {
    ...(a.pasteIdleMs !== undefined ? { idleMs: a.pasteIdleMs } : {}),
    onEnd: (why) => log.line(`paste: no end marker; ended (${why === 'idle' ? 'no input for a while' : 'Ctrl+C'})`),
  });

  // Session-level events the turn views never see (/memory verbs, /hide, /goto…) for the agents pane.
  // M5b (D-181): the background lane's (filing, the historian) whenever they come, a turn streaming or
  // not: they are never part of a turn's stream, so the pane cannot see them twice.
  const tail = engine.events()[Symbol.asyncIterator]();
  void (async () => {
    try {
      for (;;) {
        const r = await tail.next();
        if (r.done) return;
        const ev: Event = r.value;
        const v = view as TuiView | null; // set by the Repl's view factory
        if (!v || !live() || ev.sessionId !== v.sessionId) continue;
        if (isLaneEvent(ev) || (!v.turning && (ev.type === 'memory' || ev.type === 'changed'))) agents.event(ev);
      }
    } catch (e) {
      log.error(e, 'events');
    }
  })();

  // ---- what the Repl shows (T-14): every line also to tui.log; once the renderer is gone, to `late` ----
  const hostView = (v: TuiView): ReplView => ({
    line(text: string): void {
      log.line(text);
      if (live()) v.line(text);
      else o.late?.(text);
    },
    echo(line: string): void {
      if (queued > 0) {
        queued--;
        if (busy) showWork();
      }
      v.echo(line);
    },
    message: (m, withStatus) => v.message(m, withStatus),
    banner: (b) => {
      ui.hideLoading();
      currentModel = b.narrator;
      currentSessionId = b.session.id;
      v.banner(b);
      if (pendingBranch?.sessionId === b.session.id) {
        const line = `/goto ${pendingBranch.leaf}`;
        pendingBranch = null;
        queueMicrotask(() => { if (live()) { sent(line); source.inject(line); } });
      }
    },
    turn(t): TurnView {
      unarm();
      const tv = v.turn(t);
      return {
        // A failed or conflicted answer is logged by the view itself (view.ts).
        push: (ev) => tv.push(ev),
        finish(): void {
          tv.finish();
          // The Repl may go on with a slow command queued behind the answer.
          if (busy) arm();
        },
        interject: () => tv.interject(),
        get kept() {
          return tv.kept;
        },
      };
    },
    status: (m, trace) => v.status(m, trace),
    idle(): void {
      // /open can be refused (for example, another process holds its lock).
      if (pendingBranch && currentSessionId !== pendingBranch.sessionId) pendingBranch = null;
      busy = false;
      queued = 0;
      unarm();
      v.idle();
    },
  });

  const replEnv = { ...env };
  // /e stays in the input box (T-9): no external editor while the renderer owns the terminal.
  delete replEnv.VISUAL;
  delete replEnv.EDITOR;
  const kitty = (): boolean => renderer.capabilities?.kitty_keyboard === true;
  const done = runReplWith(
    {
      ...chatDeps(engine, o.session, { rt: a.rt, io, ...(a.fetch ? { fetch: a.fetch } : {}), ...(a.clock ? { clock: a.clock } : {}), ...(a.events ? { events: a.events } : {}) }),
      color: true,
    },
    {
      source: { source, interrupts: o.interrupts.interrupts },
      view: (ctx) =>
        hostView(
          (view = new TuiView({
            ctx,
            transcript,
            models,
            agents,
            context,
            prices: a.rt.config.prices,
            extra: () => ({ newlineKey: newlineKey(kitty()), mouse: renderer.useMouse }),
            status: (text, tone) => ui.setStatus(text, tone),
            log: (text) => log.line(text),
            live,
            warp,
            // T-17: /help lists the keys itself (keys.ts tuiHelpLines) when the left pane does not show them.
            keysShown: () => ui.left.visible,
          })),
        ),
      env: replEnv,
      // Hints that name the command name this one (T-15).
      command: 'tui',
      ...(a.exitWindowMs !== undefined ? { exitWindowMs: a.exitWindowMs } : {}),
    },
  );

  return {
    ui,
    source,
    view: () => view,
    done,
    // TuiView keeps what the Repl said since the player's last line or the last idle().
    summary: () => (view?.lastSaid ?? []).slice(-SUMMARY_LINES),
    dispose(): void {
      disposed = true;
      unarm();
      unguard();
      picker.dispose();
      storyPicker.dispose();
      context.dispose();
      // The Repl winds down if it still runs (a signal): its input ends, it closes the session.
      source.close();
      renderer.keyInput.off('keypress', onKey);
      renderer.off('resize', onResize);
      renderer.off('capabilities', onCaps);
      renderer.off('selection', onSelection);
      renderer.off('destroy', onDestroy);
      renderer.off('frame', ui.fitInput);
      void tail.return?.()?.catch(() => {});
    },
  };
}
