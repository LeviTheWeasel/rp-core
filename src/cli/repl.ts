// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The REPL (ARCHITECTURE.md §12.4, §15 M1b): a line REPL with node:readline for editing and history
// (never for the protocol), ANSI styles, no TUI framework. Pure command parsing lives in repl-commands.ts
// so it can be tested without a terminal.
// CONTRACT FILE (M1b): signature is fixed; the repl agent implements it.
//
// Shape. Two loops share one queue of input items:
// - the reader pulls lines from the input and judges each as it arrives;
// - the processor takes items one at a time and runs them, awaiting a turn to its end.
// So a line that arrives while a turn runs never reaches the session mid-turn: plain text is HELD
// and submitted with a fresh version once the turn is done/stopped/failed (§6.1: no queue in the
// engine), a read-only command runs after the answer, and an editing command is refused on the spot
// (§12.4). That is the interactive rule (a person at a TTY). Non-interactive input (piped lines, an
// injected iterator) is a script: every line waits its turn in order, so `printf 'hi\n/r\n/show\n' |
// rp-core chat …` behaves as if each line were typed after the previous answer.
//
// Ctrl+C: during a turn it always stops the turn (the partial answer is kept, §6.5), whatever was
// typed meanwhile (that text stays held for the prompt); at an empty prompt the first press prints a
// hint and a second one within 2 s quits; with typed text at the prompt it only clears the line. A
// turn that does not settle after Stop (a server ignoring the abort) gets a hint on the second press
// and is left behind on the third: exit 130 at once, the lock stays and the next open recovers the
// turn, as after a crash (the one-shot's second SIGINT, signals.ts).
// EOF lets the running turn and every queued line finish, then closes the session and returns 0.
//
// The terminal while an answer streams: readline keeps reading keys (so typing ahead and Ctrl+C
// work), but its OUTPUT is muted: its echo of typed keys and its prompt redraws (on Backspace, on a
// line clear: cursor to column 1, clear to the end of the screen, "you › …") would otherwise land in
// the middle of the answer, erase the streamed line and glue the player's keys into it. When the turn
// ends, the prompt comes back with whatever was typed, cursor where it was.
//
// Ports (TUI decisions T-3). Input comes through a LineSource and Ctrl+C through an InterruptSource
// (readline by default, an injected iterator in tests, a host's own pair via ReplOptions.source);
// output goes through a ReplView (repl-view.ts: LineView over io.out by default, a host's own via
// ReplOptions.view). The rules above live here, whatever the ports are.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { Refusal, type EngineHandle, type PreviewOptions, type SessionHandle, type TurnHandle, type TurnOutcome } from '../engine/api.ts';
import { ConfigError, type RpConfig } from '../config/config.ts';
import { listLibrary } from '../formats/library.ts';
import { CARD_BOOK_KEY, entryLabel, PERSONA_BOOK_KEY } from '../lore/engine.ts';
import { NOTES_BOOK_KEY, noteRefs, resolveNoteRef } from '../agents/compendium/notes.ts';
import { directorAt } from '../agents/director/state.ts';
import type { NarratorDirective } from '../agents/director/types.ts';
import type { CEntry } from '../agents/compendium/types.ts';
import type { HistorySearch } from '../tools/builtin/history.ts';
import type { Event } from '../protocol/events.ts';
import { ACTIVE_PROBE_MAX_CALLS, ACTIVE_PROBE_MAX_TOKENS, ACTIVE_PROBE_TOKENS } from '../providers/probe-active.ts';
import type { ModelCaps } from '../providers/types.ts';
import type { DeepPartial, Roles, SessionConfig, Trace } from '../session/entries.ts';
import { readSessionFile } from '../session/log.ts';
import type { TreeIndex } from '../session/tree.ts';
import type { MessageView, PathView } from '../session/view.ts';
import { memoryChannel, type Io } from './io.ts';
import { addLoreId, bookRows, entryTitles, resolveLoreRef, resolvePresetRef } from './refs.ts';
import { describeEvent, hasServerWords, messageText, modelNotFoundHint, redactEvent } from './render.ts';
import { EXIT_SIGINT } from './signals.ts';
import {
  commandClass,
  DEFAULT_NOTE_DEPTH,
  helpText,
  isLocalCommand,
  parseLine,
  resolveBindingArg,
  type Command,
  type LocalCommand,
  type RoleName,
} from './repl-commands.ts';
import {
  configOf,
  directorBinding,
  journalOf,
  latestTrace,
  pathUsage,
  resolveMessageId,
  siblingIds,
  tailRows,
  windowFor,
  type Journal,
} from './repl-journal.ts';
import {
  labels,
  makeStyle,
  noticeText,
  prefix,
  previewFailureText,
  refusalText,
  renderBindings,
  renderDirector,
  renderImported,
  renderLoreBooks,
  renderNote,
  renderNoteCard,
  renderNoteList,
  renderNumberedPath,
  renderSearch,
  presetCapText,
  renderPresets,
  renderPreview,
  renderSessionList,
  renderTails,
  renderTrace,
  renderTraceMisses,
  renderUsage,
  renderVerdicts,
  renderWire,
  type Style,
} from './repl-render.ts';
import { LineView, type BannerInfo, type ReplView, type ReplViewContext, type TurnView } from './repl-view.ts';

export interface ReplDeps {
  engine: EngineHandle;
  session: SessionHandle;
  config: RpConfig;
  home: string;
  io: Io;
  /** Line input. Default: node:readline over process.stdin with terminal mode when stdin is a TTY. */
  input?: AsyncIterable<string> & { close?(): void };
  /** Ctrl+C source. Default process 'SIGINT' / readline 'SIGINT'. */
  onInterrupt?: (handler: () => void) => () => void;
  /** $EDITOR runner for /e: returns the edited text or null when cancelled. Default spawns $EDITOR on a temp file. */
  editText?: (initial: string) => Promise<string | null>;
  /** ANSI colours (default: io.out is a TTY and NO_COLOR is unset). */
  color?: boolean;
  /** Switch to another session (/open, /fork follow-up): returns the new handle. */
  openSession?: (id: string) => SessionHandle;
  /**
   * Every message the REPL prints from an event or an error goes through this (the CLI passes
   * scrub() over the secrets it knows, §13). Default: as is.
   */
  redact?: (text: string) => string;
  /**
   * --debug: the REPL attaches its own line printer for raw provider failures (so they never glue into
   * a streamed answer) and gets back the function that detaches it. Absent without --debug.
   */
  debugTap?: (print: (line: string) => void) => () => void;
  /**
   * Why `conn` cannot serve a binding (not in config.toml, or a dialect that arrives later), or null.
   * /model refuses with this reason. Default: only config.toml's [connections] names are checked.
   */
  connectionProblem?: (conn: string) => string | null;
  /**
   * The context window a binding's resolved caps state (host preset, catalog, probe cache, user
   * override), or null when unknown. Used by the banner before the binding's first answer; the
   * window of that answer's trace wins afterwards. Optional: without it the banner says `ctx ?`, or
   * `ctx ≤N` when the preset (or the session) caps the window at N.
   */
  windowOf?: (conn: string, model: string) => number | null;
  /**
   * M3: the resolved caps of a binding (what its turns use), or null when unknown. The banner reads
   * caps.tools ("tools: native|prompted|off"), /preview the transport. Optional: without it the banner
   * says "tools: off".
   */
  capsOf?: (conn: string, model: string) => ModelCaps | null;
  /**
   * M3 `/probe --active [--write]`: run cmdProbe with `active` on `target` (conn:model), printing its
   * report to `io`; `signal` is Ctrl+C (the probe then rejects with the abort and stores nothing).
   * Resolves the exit code and whether --write stored anything. Absent where the REPL cannot probe
   * (under --provider record:, a host without a runtime): /probe --active then says to probe from
   * the shell.
   */
  probe?: (a: { target: string; write: boolean; io: Io; signal: AbortSignal }) => Promise<{ code: number; written: boolean }>;
  /**
   * The chat plays a script or a recording (--provider script: / replay:): a turn that failed makes
   * the REPL end with exit 3 instead of 0, so a CI job running a piped replay notices a changed
   * request. Without a person at the keyboard the REPL also stops at the first replay_mismatch or
   * script_exhausted: every later call would be misaligned with the recording.
   */
  failExit?: boolean;
  /**
   * The --provider script: / replay: connection every turn runs on instead of the binding's: its id
   * (what the answers' traces name), what it plays (for the wording of a stop) and its window for a
   * model. The banner and /preset then take the window from it, not from config.toml's caps.
   */
  override?: { conn: string; plays: 'script' | 'recording'; windowOf(model: string): number | null; capsOf?(model: string): ModelCaps | null };
}

/** Knobs outside the fixed contract (tests and hosts that inject their own input). */
export interface ReplOptions {
  /**
   * Lines can arrive while a turn runs and are judged as typed then: text is held, editing commands
   * are refused, read-only ones wait for the answer. Default: true for the default input when stdin
   * is a TTY; false for piped stdin and for an injected `input` (lines run strictly in order).
   */
  interactive?: boolean;
  /** The double Ctrl+C window at the prompt, ms (default 2000). */
  exitWindowMs?: number;
  /**
   * The terminal readline runs on (default process.stdin / process.stdout). Tests pass a fake TTY
   * (isTTY true, setRawMode) to drive the real readline key by key.
   */
  terminal?: { stdin: NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?(mode: boolean): unknown }; stdout: NodeJS.WritableStream & { columns?: number; rows?: number; isTTY?: boolean } };
  /** Environment for $VISUAL / $EDITOR / NO_COLOR (default process.env). */
  env?: Record<string, string | undefined>;
  /**
   * The input port: a host's own line source and Ctrl+C source (a full-screen TUI's input box and key
   * handler). Preferred over deps.input / deps.onInterrupt and readline, which are then not used;
   * `interactive` and `terminal` above are ignored too (the source says whether it is interactive).
   */
  source?: { source: LineSource; interrupts: InterruptSource };
  /**
   * The output port: builds the view everything is shown through. Default: LineView over io.out (the
   * line REPL, byte for byte).
   */
  view?: (ctx: ReplViewContext) => ReplView;
  /**
   * The command the person runs this chat with, as the Repl's hints name it (`rp-core <command> <id>
   * --debug …`, `… from the next rp-core <command>`). Default 'chat' (the line REPL's bytes); the
   * full-screen host passes 'tui'.
   */
  command?: 'chat' | 'tui';
}

/** The exit code of a chat whose replayed or scripted turns failed (ReplDeps.failExit): oneshot's EXIT.failed. */
export const REPL_FAILED = 3;

/** Run until /quit, EOF or a double Ctrl+C at the prompt. Returns the process exit code. */
export function runRepl(deps: ReplDeps): Promise<number> {
  return runReplWith(deps, {});
}

/** runRepl with the extra knobs of ReplOptions. */
export function runReplWith(deps: ReplDeps, opts: ReplOptions = {}): Promise<number> {
  return new Repl(deps, opts).run();
}

// ---- input sources --------------------------------------------------------------------------------

/**
 * The input port (ReplOptions.source): where lines come from and how the input line is shown. The
 * Repl reads next() in its own loop and judges each line as it arrives (held, refused, queued).
 */
export interface LineSource {
  next(): Promise<IteratorResult<string>>;
  /** Lines may arrive while a turn runs (a person typing). */
  readonly interactive: boolean;
  /** The source shows the prompt and echoes typing itself (readline on a TTY). */
  readonly echoes: boolean;
  /**
   * The source has an input line the Repl can label and prefill (readline on a TTY, a TUI's input
   * box): inline /e puts the message there, and the prompt label is set through prompt() even when
   * the source does not echo. Absent: false.
   */
  readonly inline?: boolean;
  /**
   * Show the prompt (`you › `, or `edit › ` while /e edits in place, styled like the Repl's other
   * strings), with any text typed and not yet sent after it. `mode` says which: 'edit' while an
   * in-place edit waits for its line (a TUI then keeps command hotkeys out of the box and lets Esc
   * cancel), 'line' otherwise. Sources that only show a label may ignore it.
   */
  prompt(text: string, mode?: 'line' | 'edit'): void;
  /**
   * The input holds real line breaks (a TUI's multi-line box): inline /e prefills the text as is,
   * needs no ⏎ stand-in and never refuses a message for containing ⏎. Absent: false.
   */
  readonly multiline?: boolean;
  /** Mute (true) or restore (false) the source's own writes: its echo and redraws (a turn streams). */
  mute(on: boolean): void;
  readonly muted: boolean;
  /** Text typed and not yet sent ('' for sources that do not edit lines). */
  pending(): string;
  /** Throw the typed text away (Ctrl+C at the prompt). */
  clearPending(): void;
  /**
   * Put text into the input line as if typed (inline /e). Line breaks arrive as INLINE_BREAK (⏎); a
   * multi-line input may turn them back into \n (the saved line is split on ⏎ either way). No-op for
   * sources that do not edit lines.
   */
  prefill(text: string): void;
  /** Hand the terminal to a child process (the editor); returns the function that takes it back. */
  suspend(): () => void;
  close(): void;
}

/**
 * The Ctrl+C port: subscribes the Repl's handler (each call is one press) and returns the function
 * that unsubscribes it. The Repl decides what a press means (stop the turn, clear the line, quit).
 */
export type InterruptSource = (handler: () => void) => () => void;

/** Real SIGINT only (piped stdin, an injected input without its own interrupt source). */
const processInterrupts: InterruptSource = (handler) => {
  process.on('SIGINT', handler);
  return () => void process.off('SIGINT', handler);
};

/**
 * The terminal as readline sees it: writes pass through to the real output unless muted; the size and
 * its changes are the real terminal's, so readline still wraps long lines right.
 */
class MutableOutput extends Writable {
  muted = false;
  private readonly onResize = (): void => void this.emit('resize');
  constructor(private readonly target: NodeJS.WritableStream & { columns?: number; rows?: number; isTTY?: boolean }) {
    super({ decodeStrings: false });
    target.on('resize', this.onResize);
  }
  get columns(): number | undefined {
    return this.target.columns;
  }
  get rows(): number | undefined {
    return this.target.rows;
  }
  get isTTY(): boolean {
    return this.target.isTTY === true;
  }
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.muted) return cb();
    this.target.write(chunk as string | Uint8Array, () => cb());
  }
  detach(): void {
    this.target.removeListener('resize', this.onResize);
  }
}

function readlineInput(interactive: boolean | undefined, terminal?: ReplOptions['terminal']): { source: LineSource; interrupts: InterruptSource } {
  const stdin = terminal?.stdin ?? process.stdin;
  const stdout = terminal?.stdout ?? process.stdout;
  const tty = stdin.isTTY === true;
  const out = new MutableOutput(stdout);
  const rl = createInterface({ input: stdin, output: tty ? out : stdout, terminal: tty, historySize: tty ? 1000 : 0 });
  const it = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.on('close', () => {
    closed = true;
    out.detach();
  });
  const source: LineSource = {
    next: () => it.next(),
    interactive: interactive ?? tty,
    echoes: tty,
    inline: tty,
    prompt(text: string): void {
      if (closed) return;
      rl.setPrompt(text);
      // preserveCursor: text typed while the answer streamed comes back with the cursor where it was.
      rl.prompt(true);
    },
    mute(on: boolean): void {
      if (!tty || out.muted === on) return;
      out.muted = on;
      // The redraws readline made while muted never moved the real cursor: its idea of how many rows
      // the input spans (Bun / Node readline's own `prevRows`) must not send the next redraw upwards
      // into the answer.
      if (!on) (rl as unknown as { prevRows?: number }).prevRows = 0;
    },
    get muted(): boolean {
      return out.muted;
    },
    pending: () => (closed ? '' : rl.line),
    clearPending(): void {
      if (closed || rl.line === '') return;
      rl.write(null, { ctrl: true, name: 'e' });
      rl.write(null, { ctrl: true, name: 'u' });
    },
    prefill(text: string): void {
      if (!closed && text !== '') rl.write(text);
    },
    suspend(): () => void {
      rl.pause();
      const raw = tty && stdin.isRaw === true;
      if (raw) stdin.setRawMode?.(false);
      return () => {
        if (raw && !closed) stdin.setRawMode?.(true);
        if (!closed) rl.resume();
      };
    },
    close(): void {
      if (!closed) rl.close();
    },
  };
  const interrupts: InterruptSource = (handler) => {
    // On a TTY readline turns Ctrl+C into its own 'SIGINT' (and leaves its line alone). The REPL
    // decides: a running turn stops whatever was typed; at the prompt, typed text is cleared first.
    const onKey = (): void => handler();
    rl.on('SIGINT', onKey);
    const offSignal = processInterrupts(handler);
    return () => {
      rl.off('SIGINT', onKey);
      offSignal();
    };
  };
  return { source, interrupts };
}

function injectedInput(input: AsyncIterable<string> & { close?(): void }, interactive: boolean): LineSource {
  const it = input[Symbol.asyncIterator]();
  return {
    next: () => it.next(),
    interactive,
    echoes: false,
    inline: false,
    prompt: () => {},
    mute: () => {},
    muted: false,
    pending: () => '',
    clearPending: () => {},
    prefill: () => {},
    suspend: () => () => {},
    close(): void {
      try {
        input.close?.();
      } catch {
        /* the input is going away anyway */
      }
      // Not awaited: an iterator blocked in next() must not keep the REPL from returning.
      void it.return?.()?.catch(() => {});
    },
  };
}

/** How a line break looks while a message is edited in place (inline /e). */
export const INLINE_BREAK = '⏎';

/** The editor the person named ($VISUAL, then $EDITOR; empty counts as unset), or null. */
export function namedEditor(env: Record<string, string | undefined>): string | null {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || null;
}

/**
 * How to run the editor on `file`. Like git, $VISUAL / $EDITOR is a shell snippet (`code --wait`,
 * `sh -c "…" sh`, a path with spaces in quotes): on POSIX it runs as `sh -c '<editor> "$@"' sh <file>`,
 * so the file arrives as one argument whatever it contains. Elsewhere it is split on whitespace.
 */
export function editorCommand(editor: string, file: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') return ['sh', '-c', `${editor} "$@"`, 'sh', file];
  return [...editor.split(/\s+/), file];
}

/** /e by default: $VISUAL or $EDITOR (else vi) on a temp file; null when the editor fails. */
function editorRunner(source: LineSource, env: Record<string, string | undefined>): (initial: string) => Promise<string | null> {
  return async (initial) => {
    // An empty variable counts as unset (as in git): VISUAL= falls through to EDITOR.
    const editor = env.VISUAL?.trim() || env.EDITOR?.trim() || 'vi';
    const dir = mkdtempSync(join(tmpdir(), 'rp-core-edit-'));
    const file = join(dir, 'message.txt');
    try {
      // Editors add a final newline; one is given and taken back so the text round-trips.
      writeFileSync(file, `${initial}\n`);
      const resume = source.suspend();
      let status: number | null;
      try {
        // Synchronous on purpose: the event loop (and so readline) must not read the terminal
        // while the editor owns it.
        const argv = editorCommand(editor, file);
        const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit', env: { ...process.env, ...env } });
        if (r.error) throw new Error(`cannot start the editor "${editor}" (set $EDITOR): ${r.error.message}`);
        // sh reports a command it cannot find as 127.
        if (r.status === 127 && argv[0] === 'sh') throw new Error(`cannot start the editor "${editor}" (set $EDITOR)`);
        status = r.status;
      } finally {
        resume();
      }
      if (status !== 0) return null;
      return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * /director show of a record that sent no directive (a failed plan, reply `from`): the last directive
 * the narrator got before it, the nearest record on the path above `from` that planned one.
 */
function sentBefore(tree: TreeIndex, from: string): { turn: number; from: string; directive: NarratorDirective } | undefined {
  let cur = tree.msgs.get(from)?.parent ?? null;
  // Each step starts above the record found by the one before it; the bound only guards a hand-made index.
  for (let steps = 0; cur !== null && steps <= tree.msgs.size; steps++) {
    const at = directorAt(tree, cur);
    if (!at.record || at.from === undefined) return undefined;
    if (at.record.ok && at.record.directive) return { turn: at.record.turn, from: at.from, directive: at.record.directive };
    cur = tree.msgs.get(at.from)?.parent ?? null;
  }
  return undefined;
}

// ---- the REPL ---------------------------------------------------------------------------------------

type Item = { t: 'line'; line: string; during: boolean } | { t: 'end' } | { t: 'quit' };

class Repl {
  private session: SessionHandle;
  private readonly style: Style;
  /** The output port: LineView (io.out) unless the host gave its own (ReplOptions.view). */
  private readonly view: ReplView;
  private readonly source: LineSource;
  private readonly interrupts: InterruptSource;
  private readonly editText: (initial: string) => Promise<string | null>;
  private readonly exitWindowMs: number;
  private names: { char: string; user: string; width: number } = labels('');
  private showReasoning = false;
  /** Notice codes already shown in this session (§12.4: each once). */
  private noticed = new Set<string>();
  private queue: Item[] = [];
  private wake: (() => void) | null = null;
  private turn: TurnHandle | null = null;
  /** The running turn's view (a TurnPrinter on the line terminal). */
  private turnView: TurnView | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ctrl+C presses during the running turn (1: stop asked). */
  private stopPresses = 0;
  /** Resolves run() at once with an exit code (the third press on a turn that will not stop). */
  private leaveNow: ((code: number) => void) | null = null;
  /** The --debug hint after a provider failure was given (once per REPL). */
  private debugHinted = false;
  private left = false;
  private finished = false;
  /** failExit: the turns that failed, by code (the exit code says so at the end). */
  private failedTurns: string[] = [];
  /** Set while /e edits in place: the next line (or null on Ctrl+C / end of input) is the result. */
  private editing: ((line: string | null) => void) | null = null;
  /** Set while /probe --active runs: Ctrl+C stops the probe. */
  private probing: AbortController | null = null;
  /** $HOME for `~/` in /preset and /lore add files. */
  private readonly env: Record<string, string | undefined>;
  /** ReplOptions.command: what the hints call this chat's command. */
  private readonly commandName: 'chat' | 'tui';

  constructor(
    private readonly deps: ReplDeps,
    opts: ReplOptions,
  ) {
    const env = opts.env ?? process.env;
    this.env = env;
    this.commandName = opts.command ?? 'chat';
    this.session = deps.session;
    this.style = makeStyle(deps.color ?? (process.stdout.isTTY === true && !env.NO_COLOR));
    this.view = opts.view ? opts.view({ style: this.style, bannerInfo: () => this.bannerInfo() }) : new LineView((s) => deps.io.out.write(s), this.style);
    if (opts.source) {
      this.source = opts.source.source;
      this.interrupts = opts.source.interrupts;
    } else if (deps.input) {
      this.source = injectedInput(deps.input, opts.interactive ?? false);
      this.interrupts = deps.onInterrupt ?? processInterrupts;
    } else {
      const rl = readlineInput(opts.interactive, opts.terminal);
      this.source = rl.source;
      this.interrupts = deps.onInterrupt ?? rl.interrupts;
    }
    // /e: an editor only when the person named one ($VISUAL / $EDITOR); otherwise the message is
    // edited in place in the input line. A terminal editor started from inside the REPL depends on
    // the terminal handing it the keyboard, which some terminals (Warp) do not do.
    this.editText = deps.editText ?? (namedEditor(env) ? editorRunner(this.source, env) : (initial) => this.inlineEdit(initial));
    this.exitWindowMs = opts.exitWindowMs ?? 2000;
  }

  async run(): Promise<number> {
    const unsubscribe = this.interrupts(() => this.interrupt());
    // --debug: raw provider failures print as a dim line of this screen, never glued into an answer.
    const untap = this.deps.debugTap?.((line) => this.say(this.style.dim(`debug: ${line}`)));
    const forced = new Promise<number>((resolve) => {
      this.leaveNow = resolve;
    });
    let code = 0;
    try {
      this.greet();
      void this.readLoop();
      code = await Promise.race([this.loop(), forced]);
    } catch (e) {
      this.view.line(this.style.red(`error: ${errorMessage(e)}`));
      code = 1;
    } finally {
      this.finished = true;
      unsubscribe();
      untap?.();
      this.disarmExit();
      this.source.close();
      if (this.left) {
        // The turn would not settle: do not wait for it. If it ever does, close() still unlocks.
        void this.session.close().catch(() => {});
      } else {
        try {
          // Stops a turn still running (only after an internal error), keeps its partial text, unlocks.
          await this.session.close();
        } catch (e) {
          this.view.line(this.style.red(`error while closing the session: ${errorMessage(e)}`));
          code = code || 1;
        }
      }
      await this.deps.io.out.flush();
    }
    return code;
  }

  // ---- the two loops -----------------------------------------------------------------------------

  private async loop(): Promise<number> {
    for (;;) {
      if (this.queue.length === 0) {
        // Nothing left to run: the view may refresh what commands changed (configure() has no event).
        this.view.idle?.();
        this.prompt();
      }
      const item = await this.take();
      if (item.t !== 'line') return this.endCode();
      await this.process(item);
      // A piped script or replay that ran out of calls, or a request the recording no longer
      // matches: every later call would be misaligned.
      const last = this.failedTurns.at(-1);
      if (this.deps.failExit && !this.source.interactive && (last === 'replay_mismatch' || last === 'script_exhausted')) {
        const what = this.deps.override?.plays ?? 'script';
        const why = last === 'replay_mismatch' ? 'the recording no longer matches this chat' : `the ${what} ran out of calls`;
        this.say(this.style.dim(`(stopped: ${why} (${last}); the rest of the input is not run)`));
        return this.endCode();
      }
    }
  }

  /** 0, or EXIT.failed (3) when failExit is on and a turn failed. */
  private endCode(): number {
    if (!this.deps.failExit || this.failedTurns.length === 0) return 0;
    const n = this.failedTurns.length;
    this.say(this.style.dim(`(${n} answer${n === 1 ? '' : 's'} failed: ${[...new Set(this.failedTurns)].join(', ')}; exit 3)`));
    return REPL_FAILED;
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const r = await this.source.next();
        if (r.done || this.finished) break;
        this.receive(r.value);
      }
    } catch (e) {
      if (!this.finished) this.say(this.style.dim(`(input ended: ${errorMessage(e)})`));
    }
    this.editing?.(null);
    this.enqueue({ t: 'end' });
  }

  private take(): Promise<Item> {
    const item = this.queue.shift();
    if (item) return Promise.resolve(item);
    return new Promise<Item>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve(this.queue.shift()!);
      };
    });
  }

  private enqueue(item: Item, front = false): void {
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    this.wake?.();
  }

  /** A line from the input, judged at arrival (§12.4 "Ввод"). */
  private receive(line: string): void {
    // The Enter moved the cursor, unless readline was muted (a turn streams; its newline never showed).
    if (this.source.echoes && !this.source.muted) this.view.cursor?.markLineStart();
    this.disarmExit();
    if (this.editing) {
      this.editing(line);
      return;
    }
    if (this.turn === null || !this.source.interactive) {
      this.enqueue({ t: 'line', line, during: this.turn !== null });
      return;
    }
    // A person typed while the answer streams.
    const parsed = parseLine(line);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'text') {
      this.enqueue({ t: 'line', line, during: true });
      this.say(this.style.dim('(held: sent when this answer ends)'));
      return;
    }
    if (!this.source.echoes) this.echo(line);
    if (parsed.kind === 'error') {
      this.say(this.style.red(parsed.message));
      return;
    }
    const cmd = parsed.command;
    if (isLocalCommand(cmd)) {
      this.local(cmd);
    } else if (commandClass(cmd) === 'edit') {
      this.say(
        this.style.yellow(
          `refused [session_busy]: ${line.trim().split(/\s/)[0]} changes the story while an answer is being written; wait for it or press Ctrl+C`,
        ),
      );
    } else {
      this.enqueue({ t: 'line', line, during: true });
      this.say(this.style.dim('(runs when this answer ends)'));
    }
  }

  private async process(item: Extract<Item, { t: 'line' }>): Promise<void> {
    const parsed = parseLine(item.line);
    if (parsed.kind === 'empty') return;
    // A TTY already shows what was typed, except a line typed mid-answer that is only now sent.
    if (!this.source.echoes || item.during) this.echo(item.line);
    try {
      if (parsed.kind === 'error') this.say(this.style.red(parsed.message));
      else if (parsed.kind === 'text') await this.submit(parsed.text);
      else await this.command(parsed.command);
    } catch (e) {
      this.report(e);
    }
  }

  // ---- Ctrl+C --------------------------------------------------------------------------------------

  private interrupt(): void {
    if (this.finished) return;
    if (this.editing) {
      // Ctrl+C while editing in place: drop the edit, keep the message as it was.
      this.source.clearPending();
      this.editing(null);
      return;
    }
    if (this.turn) {
      this.stopPresses++;
      // §6.5: what arrived is kept; the stopped event prints [stopped].
      if (this.stopPresses === 1) return this.turn.stop();
      if (this.stopPresses === 2) {
        this.say(this.style.dim('(still stopping; press Ctrl+C once more to leave at once: the next open recovers this turn)'));
        return;
      }
      this.say(this.style.yellow('! left with the turn still open; the next open recovers it'));
      this.left = true;
      this.leaveNow?.(EXIT_SIGINT);
      return;
    }
    if (this.probing) {
      // Ctrl+C during /probe --active stops the probe (its calls can wait minutes on a busy server).
      this.probing.abort(new Error('the probe was stopped'));
      return;
    }
    // At the prompt with typed text: Ctrl+C clears the line, as a shell does.
    if (this.source.pending() !== '') {
      this.disarmExit();
      this.source.clearPending();
      return;
    }
    if (this.exitTimer !== null) {
      this.disarmExit();
      this.queue = [];
      this.enqueue({ t: 'quit' }, true);
      return;
    }
    this.exitTimer = setTimeout(() => this.disarmExit(), this.exitWindowMs);
    (this.exitTimer as { unref?: () => void }).unref?.();
    if (this.source.echoes) this.view.cursor?.write('\n'); // the cursor sits after the prompt
    this.view.line(this.style.dim('(press Ctrl+C again to quit, or type /quit)'));
    if (this.wake) this.prompt();
  }

  private disarmExit(): void {
    if (this.exitTimer !== null) clearTimeout(this.exitTimer);
    this.exitTimer = null;
  }

  // ---- output helpers ------------------------------------------------------------------------------

  /** The prompt label, on a source that shows one (readline on a TTY echoes; a TUI's input box is inline). */
  private prompt(): void {
    if ((!this.source.echoes && !this.source.inline) || this.finished) return;
    this.view.cursor?.newline();
    this.source.prompt(prefix(this.names.user, this.style), 'line');
  }

  /** A report line; mid-answer it first ends the streamed line so the two never glue. */
  private say(text: string): void {
    this.turnView?.interject();
    this.view.line(text);
  }

  private echo(line: string): void {
    this.turnView?.interject();
    this.view.echo(line.trim());
  }

  private notice(n: { level: string; code: string; message: string }): void {
    if (this.noticed.has(n.code)) return;
    this.noticed.add(n.code);
    this.say(this.style.yellow(noticeText({ ...n, message: this.redact(n.message) })));
  }

  /** deps.redact (scrub of known secrets), or the text as is. */
  private redact(text: string): string {
    return this.deps.redact ? this.deps.redact(text) : text;
  }

  private report(e: unknown): void {
    if (e instanceof Refusal) this.say(this.style.yellow(refusalText(e.code, this.redact(e.message))));
    else if (e instanceof ConfigError) this.say(this.style.red(`error: ${this.redact(e.message)}`));
    else this.say(this.style.red(`error: ${this.redact(errorMessage(e))}`));
  }

  /** A whole message; with `withStatus` an answer's status line follows it. */
  private printMessage(m: MessageView, withStatus = true): void {
    this.turnView?.interject();
    this.view.message(m, withStatus);
  }

  /** The session's journal as it is on disk now (read-only; the session holds the lock). */
  private journal(): Journal {
    const { header, entries } = readSessionFile(this.deps.home, this.session.id);
    return journalOf(header, entries);
  }

  /** Banner, what happened while opening, and where the story stands. */
  private greet(): void {
    const info = this.bannerInfo();
    this.names = info.names;
    this.showReasoning = info.config.reasoningShown;
    this.turnView?.interject();
    this.view.banner(info);
    for (const ev of this.session.openEvents()) this.openEvent(ev);
    this.whereYouAre(this.session.view());
  }

  /**
   * The banner's facts for the session open now (ReplViewContext.bannerInfo; the greeting). Reads the
   * journal and the preset and changes nothing, so a host may call it whenever it needs fresh facts.
   */
  private bannerInfo(): BannerInfo {
    const header = this.session.header();
    const j = this.journal();
    const config = configOf(j);
    const view = this.session.view();
    const narrator = config.roles.narrator;
    // The preset and the session config may only shrink the model's window (§10.2, budget.ts).
    const presetWindow = this.presetMaxContext(config.preset);
    const limits = [config.window, presetWindow].filter((n): n is number => typeof n === 'number' && n > 0);
    // Under --provider script:/replay: every turn runs on the override connection: its traces and
    // its caps say the window, not config.toml's caps for the binding.
    const o = this.deps.override;
    const binding = o ? { conn: o.conn, model: narrator.model } : narrator;
    let window = windowFor(j, view.path.map((m) => m.id), binding, o ? {} : this.deps.config.caps, config.window, presetWindow);
    if (window === null) {
      const w = this.modelWindow(narrator);
      if (w !== null && w > 0) window = Math.min(w, ...limits);
    }
    // The model's window unknown: the preset's (or the session's) limit still bounds it.
    const cap = limits.length > 0 ? Math.min(...limits) : undefined;
    // M3: whether the narrator can use tools at all is its route's caps (D-92 still decides per turn).
    // M4: the Director's binding while it is on (D-113).
    const director = config.director.enabled ? { ...directorBinding(config.roles), profile: config.director.profile } : null;
    return {
      session: this.session,
      header,
      names: labels(header.cast.character.name),
      config,
      journal: j,
      narrator,
      window,
      ...(cap !== undefined ? { cap } : {}),
      tools: this.capsOf(narrator)?.tools ?? null,
      director,
      ...(o ? { override: o } : {}),
    };
  }

  private openEvent(raw: Event): void {
    const ev = redactEvent(raw, this.deps.redact);
    if (ev.type === 'notice') return this.notice(ev);
    const line = describeEvent(ev);
    if (line !== null) this.say(this.style.yellow(`! ${line}`));
  }

  private whereYouAre(view: PathView): void {
    const head = view.path.at(-1);
    if (!head) {
      this.say(this.style.dim('(no messages yet: say something to begin)'));
      return;
    }
    if (head.role === 'assistant') return this.printMessage(head);
    const before = view.path.at(-2);
    if (before?.role === 'assistant') this.printMessage(before);
    this.printMessage(head, false);
    this.say(this.style.dim('(your message has no answer yet: /r asks for one, or type more)'));
  }

  /** The selected message and, when the head went further down its branch, the head too. */
  private showSelected(id: string): void {
    const view = this.session.view();
    const at = view.path.findIndex((m) => m.id === id);
    if (at < 0) return this.whereYouAre(view);
    this.printMessage(view.path[at]!);
    const below = view.path.length - 1 - at;
    if (below > 1) this.say(this.style.dim(`  ⋯ ${below - 1} more message${below - 1 === 1 ? '' : 's'} on this branch (/show) ⋯`));
    if (below > 0) this.printMessage(view.path.at(-1)!);
  }

  /** Message n (1-based on the active path) or null after saying why not. */
  private at(view: PathView, n: number): MessageView | null {
    const m = view.path[n - 1];
    if (!m) {
      const len = view.path.length;
      this.say(this.style.red(`there is no message ${n}: this path has ${len} message${len === 1 ? '' : 's'} (/show numbers them)`));
      return null;
    }
    return m;
  }

  // ---- turns ---------------------------------------------------------------------------------------

  private submit(text: string): Promise<void> {
    return this.runTurn(() => this.session.submit({ text, expectedVersion: this.session.version(), onError: 'keep' }));
  }

  /** Start a turn (a Refusal propagates to process()), render it to the end, print its status line. */
  private async runTurn(start: () => TurnHandle, continueFrom?: string): Promise<void> {
    const turn = start();
    this.turn = turn;
    // readline keeps reading keys (typing ahead, Ctrl+C) but must not draw into the answer.
    this.source.mute(true);
    const tv = this.view.turn({
      label: this.names.char,
      showReasoning: () => this.showReasoning,
      notice: (n) => this.notice(n),
      ...(continueFrom !== undefined ? { continueFrom } : {}),
    });
    this.turnView = tv;
    let outcome: TurnOutcome;
    try {
      for await (const ev of turn.events) tv.push(redactEvent(ev, this.deps.redact));
      outcome = await turn.result;
    } finally {
      tv.finish();
      this.turnView = null;
      this.turn = null;
      this.stopPresses = 0;
      this.source.mute(false);
    }
    if (outcome.type === 'failed') this.failedTurns.push(outcome.code);
    const answer = this.answerOf(outcome, turn, tv.kept);
    if (answer) this.view.status(answer, this.traceOf(answer.id));
    if (outcome.type === 'failed' && outcome.code === 'model_not_found' && !this.deps.override) {
      // The banner named the binding long ago; this names it again with the way out.
      this.say(this.style.dim(`  (${modelNotFoundHint(configOf(this.journal()).roles.narrator, undefined, outcome.route)})`));
    }
    if (outcome.type === 'failed' && hasServerWords(outcome) && !this.deps.debugTap && !this.debugHinted) {
      this.debugHinted = true;
      this.say(this.style.dim(`  (rp-core ${this.commandName} ${this.session.id} --debug shows the server's own words)`));
    }
  }

  /** The newest trace of answer `id` as the journal has it now (for the status line), or undefined. */
  private traceOf(id: string): Trace | undefined {
    try {
      return latestTrace(this.journal(), id)?.trace;
    } catch {
      return undefined; // the status line simply goes without it
    }
  }

  private answerOf(outcome: TurnOutcome, turn: TurnHandle, kept: boolean): MessageView | null {
    switch (outcome.type) {
      case 'done':
      case 'stopped':
        return outcome.message;
      case 'failed':
        // onError 'keep': text that arrived before the failure was saved as [interrupted].
        return kept ? (this.session.view().path.find((m) => m.id === turn.messageId) ?? null) : null;
      default:
        return null;
    }
  }

  // ---- commands ------------------------------------------------------------------------------------

  private async command(c: Command): Promise<void> {
    switch (c.name) {
      case 'swipe':
        return this.swipe(c.guidance);
      case 'prev':
      case 'next':
        return this.browse(c.name === 'prev' ? -1 : 1);
      case 'continue': {
        const head = this.session.view().path.at(-1);
        const before = head?.role === 'assistant' ? messageText(head) : undefined;
        return this.runTurn(() => this.session.runTurn({ kind: 'continue', expectedVersion: this.session.version(), onError: 'keep' }), before);
      }
      case 'edit':
        return this.edit(c.n);
      case 'hide':
        return this.hide(c.n, c.hidden);
      case 'rewind':
        return this.rewind(c.n);
      case 'tails': {
        const rows = tailRows(this.journal(), this.session.view().tails);
        return this.say(renderTails(rows, this.names));
      }
      case 'goto':
        return this.goto(c.id);
      case 'fork':
        return this.fork(c.n);
      case 'model':
        return this.model(c.role ?? 'narrator', c.spec, c.role === undefined && c.spec === undefined);
      case 'note':
        return this.note(c);
      case 'show':
        return this.say(renderNumberedPath(this.session.view(), this.session.header(), this.names, this.style));
      case 'sessions':
        return this.say(renderSessionList(this.deps.engine.listSessions(), this.session.id));
      case 'open':
        return this.switchTo(c.id);
      case 'usage': {
        const ids = this.session.view().path.map((m) => m.id);
        return this.say(renderUsage(pathUsage(this.journal(), ids, this.deps.config.prices)));
      }
      case 'trace':
        return this.trace();
      case 'preset':
        return this.preset(c.ref);
      case 'lore':
        return this.lore(c);
      case 'preview':
        return this.preview(c);
      case 'probe':
        if (c.active) return this.probeActive(c.write === true);
        return this.say(
          'Probes run from the shell: rp-core probe <connection>[:<model>] [--write]. They ask the server for its models and\n' +
            'limits (/models, /props, /api/show, OpenRouter supported_parameters); --write keeps the result for the next sessions.\n' +
            "/probe --active [--write] also tests the narrator's model here: a tiny reply, one tool call, a JSON reply (a few short calls).",
        );
      case 'memory':
        return this.memory(c);
      case 'search':
        return this.search(c.query, c.before);
      case 'director':
        return this.director(c.action);
      case 'later':
        return this.say(this.style.dim(`/${c.command} arrives with ${c.when}`));
      case 'think':
      case 'help':
      case 'quit':
        return this.local(c);
    }
  }

  /** /think, /help, /quit: REPL state only, so they work during a turn too. */
  private local(c: LocalCommand): void {
    switch (c.name) {
      case 'help':
        return this.say(helpText());
      case 'quit':
        // A running turn stops (its partial text is kept); the processor quits once it settles.
        this.queue = [];
        this.enqueue({ t: 'quit' }, true);
        this.turn?.stop();
        return;
      case 'think':
        if (c.show === undefined) {
          return this.say(this.style.dim(`reasoning is ${this.showReasoning ? 'shown' : 'folded'} (/think show|hide)`));
        }
        this.showReasoning = c.show;
        // Remembered in the session when nothing runs (configure is refused mid-turn).
        if (!this.session.busy()) {
          try {
            this.session.configure({ reasoningShown: c.show });
          } catch {
            /* a display preference; the REPL keeps it either way */
          }
        }
        return this.say(this.style.dim(c.show ? 'reasoning will be shown' : 'reasoning will be folded to one line'));
    }
  }

  /** /r and /regen (§6.3); on a greeting before the first message, the next greeting (§5.5). */
  private async swipe(guidance: string | undefined): Promise<void> {
    const head = this.session.view().path.at(-1);
    if (!head) return this.say(this.style.red('there is nothing to swipe yet'));
    if (head.gen?.kind === 'greeting') {
      if (guidance !== undefined) return this.say(this.style.red('a greeting is not generated, so it takes no guidance; /r shows the next one'));
      if (head.swipe.count < 2) return this.say(this.style.dim('this card has only one greeting'));
      return this.selectSibling(head, 1, true);
    }
    const expectedVersion = this.session.version();
    if (head.role === 'user') {
      // The answer is missing (a failed turn, a rewind onto your own line): ask for one.
      if (guidance !== undefined) return this.say(this.style.red('your message has no answer to re-roll yet; /r asks for one'));
      return this.runTurn(() => this.session.runTurn({ kind: 'reply', expectedVersion, onError: 'keep' }));
    }
    return this.runTurn(() =>
      this.session.runTurn({ kind: 'swipe', expectedVersion, onError: 'keep', ...(guidance !== undefined ? { guidance } : {}) }),
    );
  }

  /** /[ and /]: the previous / next sibling of the head message (select: its branch comes back too). */
  private browse(dir: -1 | 1): void {
    const head = this.session.view().path.at(-1);
    if (!head) return this.say(this.style.red('there is nothing to browse yet'));
    this.selectSibling(head, dir, false);
  }

  private selectSibling(m: MessageView, dir: -1 | 1, wrap: boolean): void {
    const sibs = siblingIds(this.journal(), m.id);
    const what = m.gen?.kind === 'greeting' ? 'greeting' : 'version';
    if (sibs.length < 2) return this.say(this.style.dim(`this is the only ${what}${m.role === 'assistant' && what === 'version' ? '; /r makes another' : ''}`));
    let i = sibs.indexOf(m.id) + dir;
    if (wrap) i = (i + sibs.length) % sibs.length;
    if (i < 0) return this.say(this.style.dim(`this is the first ${what}`));
    if (i >= sibs.length) return this.say(this.style.dim(`this is the last ${what}${what === 'version' && m.role === 'assistant' ? '; /r makes another' : ''}`));
    this.session.select({ messageId: sibs[i]!, expectedVersion: this.session.version() });
    this.showSelected(sibs[i]!);
  }

  /**
   * /e without $VISUAL / $EDITOR: the message goes into the input line, ready to edit. Enter saves,
   * Ctrl+C cancels. Line breaks show as ⏎ (one line of input cannot hold them) and come back on save.
   */
  private inlineEdit(initial: string): Promise<string | null> {
    // A multi-line input (the TUI) holds real line breaks: no ⏎ stand-in, nothing to refuse.
    const multiline = this.source.multiline === true;
    if (!multiline && initial.includes(INLINE_BREAK)) {
      this.say(this.style.yellow(`this message contains ${INLINE_BREAK} itself; set $EDITOR to edit it in an editor`));
      return Promise.resolve(null);
    }
    this.say(
      this.style.dim(
        multiline
          ? 'editing in place: Enter saves · Esc or Ctrl+C cancels'
          : `editing in place: Enter saves · Ctrl+C cancels · ${INLINE_BREAK} is a line break · set $EDITOR to use an editor`,
      ),
    );
    return new Promise<string | null>((resolve) => {
      this.editing = (line) => {
        this.editing = null;
        resolve(line === null ? null : multiline ? line : line.split(INLINE_BREAK).join('\n'));
      };
      // Piped input: the next line is the new text. A source with an input line gets it prefilled.
      if (!this.source.echoes && !this.source.inline) return;
      this.view.cursor?.newline();
      this.source.prompt(prefix('edit', this.style), 'edit');
      this.source.prefill(multiline ? initial : initial.replace(/\r?\n/g, INLINE_BREAK));
    });
  }

  /** /e [n] (§5.5: an edit entry; the raw text stays in the journal). */
  private async edit(n: number | undefined): Promise<void> {
    const view = this.session.view();
    const m = n === undefined ? (view.path.at(-1) ?? null) : this.at(view, n);
    if (!m) {
      if (n === undefined) this.say(this.style.red('there is nothing to edit yet'));
      return;
    }
    const pos = view.path.indexOf(m) + 1;
    const initial = messageText(m);
    const edited = await this.editText(initial);
    if (edited === null) return this.say(this.style.dim('edit cancelled'));
    if (edited === initial) return this.say(this.style.dim('no change'));
    if (edited.trim() === '') return this.say(this.style.dim(`edit cancelled: the text is empty (/hide ${pos} leaves a message out instead)`));
    this.session.edit({ messageId: m.id, text: edited, expectedVersion: this.session.version() });
    this.say(this.style.dim(`edited message ${pos}`));
    const now = this.session.view().path.find((x) => x.id === m.id);
    if (now) this.printMessage(now, false);
  }

  private hide(n: number, hidden: boolean): void {
    const view = this.session.view();
    const m = this.at(view, n);
    if (!m) return;
    if (m.hidden === hidden) return this.say(this.style.dim(`message ${n} is already ${hidden ? 'hidden' : 'visible'}`));
    this.session.hide({ messageId: m.id, hidden, expectedVersion: this.session.version() });
    this.say(
      this.style.dim(hidden ? `message ${n} is hidden: the model no longer sees it (/unhide ${n} brings it back)` : `message ${n} is visible again`),
    );
  }

  /**
   * /rewind n: the head goes to message n itself (select {exact: true}), so the next message starts
   * a new branch and the old continuation becomes a tail (§5.5). A host engine that ignores `exact`
   * (only "newest descendant") cannot rewind a straight path: that is detected and said.
   */
  private rewind(n: number): void {
    const view = this.session.view();
    const m = this.at(view, n);
    if (!m) return;
    if (m.id === view.head) return this.say(this.style.dim(`message ${n} is already the last one`));
    this.session.select({ messageId: m.id, expectedVersion: this.session.version(), exact: true });
    const after = this.session.view();
    if (after.head !== m.id) {
      this.say(this.style.yellow(`! could not rewind to message ${n}: this engine only selects the newest message below it`));
      return this.whereYouAre(after);
    }
    this.printMessage(m);
    if (m.role === 'user') {
      // The head is the player's own line: a new line would follow it as a second one of theirs.
      this.say(
        this.style.dim(
          `rewound to your message ${n}: /r asks for a new answer to it; a line you type now follows it as another message of yours ` +
            `(/rewind ${n - 1} to replace it instead); the rest stays as a branch (/tails)`,
        ),
      );
      return;
    }
    this.say(this.style.dim(`rewound to message ${n}: what you send next starts a new branch; the rest stays as a branch (/tails)`));
  }

  private goto(prefixOrId: string): void {
    const found = resolveMessageId(this.journal(), prefixOrId);
    if (!found.ok) return this.say(this.style.red(`/goto: ${found.message}`));
    this.session.select({ messageId: found.id, expectedVersion: this.session.version() });
    this.showSelected(found.id);
  }

  /** /fork [n]: a new session with the path up to n (default: the head); then it is opened. */
  private async fork(n: number | undefined): Promise<void> {
    const view = this.session.view();
    const m = n === undefined ? (view.path.at(-1) ?? null) : this.at(view, n);
    if (!m) {
      if (n === undefined) this.say(this.style.red('there is nothing to fork yet'));
      return;
    }
    const pos = view.path.indexOf(m) + 1;
    const id = this.session.fork({ at: m.id });
    this.say(`forked into ${id} (messages 1–${pos})`);
    await this.switchTo(id);
  }

  /** /open and the /fork follow-up: open the other session first, so a refusal keeps this one. */
  private async switchTo(id: string): Promise<void> {
    if (id === this.session.id) return this.say(this.style.dim(`${id} is the session open now`));
    const next = this.deps.openSession ? this.deps.openSession(id) : this.deps.engine.session(id);
    const old = this.session;
    this.session = next;
    this.noticed = new Set();
    try {
      await old.close();
    } finally {
      this.greet();
    }
  }

  /** /model [role] [conn:model] (§12.4): session.configure on the roles, the connection checked first. */
  private model(role: RoleName, spec: string | undefined, all: boolean): void {
    const config = configOf(this.journal());
    if (spec === undefined) return this.say(renderBindings(config.roles, all ? undefined : role));
    const r = resolveBindingArg(role, spec, Object.keys(this.deps.config.connections));
    if (!r.ok) return this.say(this.style.red(r.message));
    const value = r.value;
    // In config.toml is not enough: a connection the runtime skipped (anthropic M7, gemini M8) would
    // be accepted here and refused at the next turn as "not configured".
    const problem = typeof value === 'string' ? null : (this.deps.connectionProblem?.(value.conn) ?? null);
    if (problem !== null) return this.say(this.style.red(`/model ${role}: ${problem}`));
    const roles: DeepPartial<Roles> = {};
    if (typeof value !== 'string') roles[role] = { conn: value.conn, model: value.model };
    // Only director, recorder and recall follow another role (resolveBindingArg guarantees it).
    else if (role === 'recall') roles.recall = value;
    else if (role === 'director' || role === 'recorder') roles[role] = 'narrator';
    this.session.configure({ roles });
    this.say(this.style.dim(`${role} → ${typeof value === 'string' ? `follows the ${value}` : `${value.conn}:${value.model}`} (from the next turn)`));
  }

  /**
   * /director show|on|off (D-113): the Director's state at the head (directorAt, the fold a turn
   * starts from), or director.enabled through configure (from the next turn).
   */
  private director(action: 'show' | 'on' | 'off'): void {
    const j = this.journal();
    const config = configOf(j);
    const binding = directorBinding(config.roles);
    const d = config.director;
    if (action === 'show') {
      const at = directorAt(j.tree, this.session.view().head);
      // A record that sent no directive (a failed plan): the last one sent before it on this path.
      const sent = at.record && !(at.record.ok && at.record.directive) && at.from !== undefined ? sentBefore(j.tree, at.from) : undefined;
      return this.say(
        renderDirector(
          {
            enabled: d.enabled,
            binding,
            profile: d.profile,
            style: d.style,
            state: at.state,
            invalid: at.invalid,
            ...(at.record ? { record: at.record } : {}),
            ...(at.from !== undefined ? { from: at.from } : {}),
            ...(sent ? { sentBefore: sent } : {}),
          },
          this.style,
        ),
      );
    }
    const enabled = action === 'on';
    if (d.enabled === enabled) return this.say(this.style.dim(`the Director is already ${action}`));
    this.session.configure({ director: { enabled } });
    if (!enabled) return this.say(this.style.dim('director off (from the next turn); its plan is kept: /director on resumes it'));
    const model = `${binding.conn}:${binding.model}${binding.follows ? " (the narrator's model)" : ''}`;
    this.say(this.style.dim(`director on: it plans every reply with ${model}, from the next turn (/director shows its plan; /model director <connection:model> picks another model)`));
    // A binding of its own on a connection this runtime cannot serve: every plan would fail no_connection.
    if (!binding.follows && !this.deps.override) {
      const problem = Object.hasOwn(this.deps.config.connections, binding.conn) ? (this.deps.connectionProblem?.(binding.conn) ?? null) : `config.toml has no connection "${binding.conn}"`;
      if (problem !== null) this.say(this.style.yellow(`! the Director's model ${binding.conn}:${binding.model} cannot be reached (${problem}): its plans will fail with no_connection; /model director narrator makes it follow the narrator`));
    }
  }

  /** /note (§5.1 authorNote): set, show or remove. */
  private note(c: Extract<Command, { name: 'note' }>): void {
    const current = configOf(this.journal()).authorNote;
    if (c.action === 'show') return this.say(renderNote({ ...(current ? { authorNote: current } : {}) }));
    if (c.action === 'off') {
      if (!current) return this.say(this.style.dim("there is no author's note"));
      // RFC 7396 merge patch: null removes the key (session/fold.ts mergePatch).
      this.session.configure({ authorNote: null } as unknown as DeepPartial<SessionConfig>);
      return this.say(this.style.dim("author's note removed"));
    }
    const depth = c.depth ?? current?.depth ?? DEFAULT_NOTE_DEPTH;
    const role = current?.role ?? 'system';
    this.session.configure({ authorNote: { text: c.text, depth, role } });
    this.say(this.style.dim(`author's note set @${depth} (from the next turn)`));
  }

  /**
   * /trace: the newest trace of the last answer on the path, then the lore entries it missed and why:
   * the trace stores only what fired and what the budget cut, so the verdicts are recomputed from its
   * seed and clock by rebuilding that answer's request [D-45] (session.preview, nothing is sent).
   */
  private trace(): void {
    const view = this.session.view();
    const j = this.journal();
    for (let i = view.path.length - 1; i >= 0; i--) {
      const m = view.path[i]!;
      if (m.role !== 'assistant') continue;
      const t = latestTrace(j, m.id);
      if (!t) continue;
      const titles = this.titles();
      return this.say(this.redact(renderTrace(m.id, t, titles, this.traceMisses(m.id, t, titles))));
    }
    this.say(this.style.dim('no answer with a trace on this path yet (greetings have none)'));
  }

  /** The recomputed misses of answer `id` for /trace, with the notice when today's inputs differ. */
  private traceMisses(id: string, t: { trace: Trace; continued: boolean }, titles: Map<string, string>): string[] {
    const r = this.session.preview({ turn: id, explain: true });
    if (!r.ok) return [this.style.dim(`  (the lore verdicts cannot be recomputed: ${previewFailureText(r)})`)];
    const lines = renderTraceMisses(r.verdicts ?? [], t.trace.lore, this.style, titles, t.continued);
    for (const n of r.notices) if (n.code === 'preview_inputs_changed') lines.push(this.style.yellow(`  ${noticeText(n)}`));
    return lines;
  }

  // ---- presets, lorebooks, preview (M2) -----------------------------------------------------------

  /** Entry titles of every book a turn scans now (M3: the notes too), for /trace, /lore test and /preview. */
  private titles(): Map<string, string> {
    const titles = entryTitles(this.deps.home, this.session.header().cast, configOf(this.journal()).lorebooks);
    for (const { entry } of this.noteRows()) titles.set(entryLabel(NOTES_BOOK_KEY, entry.key), entry.name);
    return titles;
  }

  /**
   * /preset (§12.4): show it and the library, or switch to 'builtin', a library id or a file (an ST
   * preset, imported first). The preset must load and validate before the session points at it; the
   * next turn reads it.
   */
  private preset(ref: string | undefined): void {
    const config = configOf(this.journal());
    const current = config.preset;
    // Say so when the preset shrinks the model's window (an ST preset's openai_max_context, §10.2),
    // or bounds it when the model's own window is unknown.
    const model = this.modelWindow(config.roles.narrator);
    if (ref === undefined) {
      const maxContext = this.presetMaxContext(current);
      return this.say(renderPresets(current, listLibrary(this.deps.home, 'presets'), { ...(maxContext !== undefined ? { maxContext } : {}), model }));
    }
    const r = resolvePresetRef(this.deps.home, ref, this.env);
    if (r.imported) this.say(this.style.dim(renderImported('preset', r.imported, r.id)));
    if (r.id === current) return this.say(this.style.dim(`the session already uses preset ${r.id}`));
    this.session.configure({ preset: r.id });
    const caps = presetCapText(r.value.context?.maxContext, model);
    this.say(this.style.dim(`preset → ${r.id}${r.value.name !== r.id ? ` "${r.value.name}"` : ''} (from the next turn${caps ? `; ${caps}` : ''})`));
  }

  /** The narrator route's caps (the --provider override's, when one is set), or null when unknown. */
  private capsOf(narrator: { conn: string; model: string }): ModelCaps | null {
    const o = this.deps.override;
    try {
      return o ? (o.capsOf?.(narrator.model) ?? null) : (this.deps.capsOf?.(narrator.conn, narrator.model) ?? null);
    } catch {
      return null; // a model the connection cannot resolve: the turn will say why
    }
  }

  /** The narrator model's own window from its caps (the --provider override's, when one is set), or null. */
  private modelWindow(narrator: { conn: string; model: string }): number | null {
    const o = this.deps.override;
    const w = o ? o.windowOf(narrator.model) : (this.deps.windowOf?.(narrator.conn, narrator.model) ?? null);
    return w !== null && w > 0 ? w : null;
  }

  /** The session preset's own window limit (an ST preset's openai_max_context), when it loads. */
  private presetMaxContext(id: string): number | undefined {
    try {
      return resolvePresetRef(this.deps.home, id, this.env).value.context?.maxContext;
    } catch {
      return undefined; // a missing or broken preset is the next turn's refusal to tell
    }
  }

  /** /lore, /lore add|rm|test. */
  private lore(c: Extract<Command, { name: 'lore' }>): void {
    const home = this.deps.home;
    const current = configOf(this.journal()).lorebooks;
    switch (c.action) {
      case 'list':
        return this.say(renderLoreBooks(bookRows(home, this.session.header().cast, current), listLibrary(home, 'lorebooks')));
      case 'add': {
        const r = resolveLoreRef(home, c.ref, this.env);
        if (r.imported) this.say(this.style.dim(renderImported('lorebook', r.imported, r.id)));
        if (current.includes(r.id)) return this.say(this.style.dim(`lorebook ${r.id} is already in this session`));
        // A world is read once by name: a changed copy of a world (harbor-2 "Harbor") replaces it.
        const next = addLoreId(home, current, r.id, r.value.name);
        this.session.configure({ lorebooks: next.ids });
        const n = r.value.entries.length;
        const entries = `${n} entr${n === 1 ? 'y' : 'ies'}`;
        if (next.replaced !== undefined) {
          return this.say(
            this.style.dim(
              `lorebook ${r.id} "${r.value.name}" replaces ${next.replaced}: same name, and a world is read once by name (${entries}, from the next turn; /lore add ${next.replaced} brings the old one back)`,
            ),
          );
        }
        return this.say(this.style.dim(`lorebook ${r.id} "${r.value.name}" added: ${entries} (from the next turn)`));
      }
      case 'rm': {
        if (c.id === CARD_BOOK_KEY || c.id === PERSONA_BOOK_KEY) {
          return this.say(this.style.red(`/lore rm: ${c.id} is the ${c.id === CARD_BOOK_KEY ? "card's" : "persona's"} own book; it comes with it and cannot be removed`));
        }
        if (!current.includes(c.id)) {
          const has = current.length > 0 ? `it has: ${current.join(', ')}` : 'it has none';
          return this.say(this.style.red(`/lore rm: ${c.id} is not a lorebook of this session (${has})`));
        }
        this.session.configure({ lorebooks: current.filter((id) => id !== c.id) });
        return this.say(this.style.dim(`lorebook ${c.id} removed (from the next turn; it stays in the library)`));
      }
      case 'test': {
        // The reply to `text`, as if it were sent: the engine recomputes the verdicts [D-45].
        const r = this.session.preview({ draft: c.text, explain: true });
        if (!r.ok) return this.say(this.style.yellow(previewFailureText(r)));
        // The lore notices too: a book skipped (missing, invalid), a broken /regex/ key, lore that
        // fired into a slot the preset does not send. Without them a skipped book reads as no match.
        const notes = r.notices.filter((n) => n.code.startsWith('lore')).map((n) => this.style.yellow(noticeText({ ...n, message: this.redact(n.message) })));
        return this.say([`lore test: a reply to your text (nothing is sent)`, renderVerdicts(r.verdicts ?? [], r.trace.lore, this.style, this.titles(), 40, r.loreUse), ...notes].join('\n'));
      }
    }
  }

  /** The answer /preview n|id names (an answer on the active path), or null after saying why not. */
  private previewTarget(at: { n: number } | { id: string }): string | null {
    const view = this.session.view();
    let m: MessageView | undefined;
    let what: string;
    if ('n' in at) {
      m = this.at(view, at.n) ?? undefined;
      if (!m) return null;
      what = `message ${at.n}`;
    } else {
      const found = resolveMessageId(this.journal(), at.id);
      if (!found.ok) {
        this.say(this.style.red(`/preview: ${found.message}`));
        return null;
      }
      m = view.path.find((x) => x.id === found.id);
      if (!m) {
        this.say(this.style.red(`/preview: ${found.id} is not on this path (/goto ${found.id} first)`));
        return null;
      }
      what = found.id;
    }
    if (m.role !== 'assistant') {
      this.say(this.style.red(`/preview: ${what} is yours; it takes an answer, whose request it rebuilds (/show numbers them)`));
      return null;
    }
    if (m.gen?.kind === 'greeting') {
      this.say(this.style.red(`/preview: ${what} is a greeting; it was not generated, so there is no request to rebuild`));
      return null;
    }
    return m.id;
  }

  /**
   * /preview [n|id] [--wire] [--verdicts]: the request a turn would send (or a past answer's), never
   * sent (§6.1). --verdicts adds every lore entry's verdict, as /lore test prints them [D-45]; with
   * --wire the body comes first, then the verdicts and the notices (preview_inputs_changed among them).
   */
  private preview(c: Extract<Command, { name: 'preview' }>): void {
    const opts: PreviewOptions = {};
    if (c.at) {
      const id = this.previewTarget(c.at);
      if (id === null) return;
      opts.turn = id;
    }
    if (c.verdicts) opts.explain = true;
    const r = this.session.preview(opts);
    if (!r.ok) {
      this.say(this.style.yellow(previewFailureText(r)));
      if (r.code === 'nothing_to_swipe') this.say(this.style.dim('(nothing to build yet: say something first; /lore test <text> shows what a message would wake)'));
      return;
    }
    const titles = this.titles();
    const verdicts = c.verdicts ? ['', 'lore verdicts:', renderVerdicts(r.verdicts ?? [], r.trace.lore, this.style, titles, 40, r.loreUse)] : [];
    if (c.wire) {
      if (r.wire) {
        const notes = r.notices.map((n) => this.style.yellow(noticeText(n)));
        return this.say(this.redact([renderWire(r.wire), ...verdicts, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n')));
      }
      this.say(this.style.dim('(no wire form: this connection is an in-process provider; the messages follow)'));
    }
    const transport = this.capsOf({ conn: r.model.connection, model: r.model.model })?.tools ?? null;
    this.say(this.redact([renderPreview(r, this.style, titles, transport), ...verdicts].join('\n')));
  }

  // ---- notes, search, active probes (M3) ------------------------------------------------------------

  /** The notes of the current path with their C<n> handles (creation order, live and retired). */
  private noteRows(): { ref: string; entry: CEntry }[] {
    return noteRefs(this.session.view().compendium);
  }

  /** A note's handle as /memory lists it now ('C?' when it is not on this path). */
  private refOf(key: string): string {
    return this.noteRows().find((r) => r.entry.key === key)?.ref ?? 'C?';
  }

  /** A note's handle and its current title, as a confirmation names it: `C2 "Old lighthouse"`. */
  private named(key: string): string {
    const row = this.noteRows().find((r) => r.entry.key === key);
    return row ? `${row.ref} ${JSON.stringify(row.entry.name)}` : 'C?';
  }

  /** /memory, /memory show|add|edit|retire|restore (decision F6). A refusal is one red line. */
  private memory(c: Extract<Command, { name: 'memory' }>): void {
    const fail = (e: unknown): void => {
      if (e instanceof Refusal) return this.say(this.style.red(`/memory ${c.action}: ${this.redact(e.message)}`));
      throw e;
    };
    switch (c.action) {
      case 'list':
        return this.say(renderNoteList(this.noteRows(), this.style));
      case 'show': {
        const note = resolveNoteRef(this.session.view().compendium, c.ref);
        if (!note) return this.say(this.style.red(`/memory show: no single note matches ${JSON.stringify(c.ref)} (use its C<n> as /memory lists it, or its key)`));
        return this.say(renderNoteCard(this.refOf(note.key), note));
      }
      case 'add': {
        let key: string;
        try {
          key = this.session.memoryAdd({ title: c.title, keys: c.keys, content: c.content }).key;
        } catch (e) {
          return fail(e);
        }
        const ref = this.refOf(key);
        const keys = c.keys.length > 0 ? c.keys : [c.title];
        const when = keys.length > 1 ? `${keys.slice(0, -1).join(', ')} or ${keys.at(-1)}` : keys[0];
        return this.say(this.style.dim(`note ${ref} "${c.title}" added (${key}): from the next turn it is sent when ${when} comes up`));
      }
      case 'edit': {
        let key: string;
        try {
          key = this.session.memoryEdit({
            ref: c.ref,
            ...(c.title !== undefined ? { title: c.title } : {}),
            ...(c.keys !== undefined ? { keys: c.keys } : {}),
            ...(c.content !== undefined ? { content: c.content } : {}),
          }).key;
        } catch (e) {
          return fail(e);
        }
        const what = [c.title !== undefined ? 'title' : '', c.keys !== undefined ? 'keys' : '', c.content !== undefined ? 'text' : ''].filter(Boolean).join(', ');
        return this.say(this.style.dim(`note ${this.named(key)} changed: ${what} (from the next turn)`));
      }
      case 'retire': {
        let key: string;
        try {
          key = this.session.memoryRetire({ ref: c.ref, ...(c.reason !== undefined ? { reason: c.reason } : {}) }).key;
        } catch (e) {
          return fail(e);
        }
        return this.say(this.style.dim(`note ${this.named(key)} retired: it no longer fires (/memory restore ${this.refOf(key)} brings it back)`));
      }
      case 'restore': {
        let key: string;
        try {
          key = this.session.memoryRestore({ ref: c.ref }).key;
        } catch (e) {
          return fail(e);
        }
        return this.say(this.style.dim(`note ${this.named(key)} restored: it fires again from the next turn`));
      }
    }
  }

  /** /search <query> [before=n] (§7.5): the narrator's search_history over this path; read-only. */
  private search(query: string, before: number | undefined): void {
    let r: HistorySearch;
    try {
      r = this.session.search({ query, ...(before !== undefined ? { before } : {}) });
    } catch (e) {
      if (e instanceof Refusal) return this.say(this.style.red(`/search: ${this.redact(e.message)}`));
      throw e;
    }
    this.say(this.redact(renderSearch(query, r, before, this.style)));
  }

  /**
   * /probe --active [--write] on the narrator binding: cmdProbe's active probes, their report printed
   * here. The connections of this chat were built at start: facts written now apply from the next start.
   */
  private async probeActive(write: boolean): Promise<void> {
    const o = this.deps.override;
    if (o) {
      return this.say(this.style.red(`/probe --active: this chat plays a ${o.plays} (--provider); probe from the shell: rp-core probe <connection>:<model> --active`));
    }
    if (!this.deps.probe) return this.say(this.style.red('/probe --active is not available in this chat; from the shell: rp-core probe <connection>:<model> --active'));
    const { conn, model } = configOf(this.journal()).roles.narrator;
    const problem = this.deps.connectionProblem?.(conn) ?? null;
    if (problem !== null) return this.say(this.style.red(`/probe --active: ${problem}`));
    const target = `${conn}:${model}`;
    this.say(
      this.style.dim(
        `probing ${target}: a few short calls (at most ${ACTIVE_PROBE_MAX_CALLS}, replies of ${ACTIVE_PROBE_TOKENS.stream} to ${ACTIVE_PROBE_MAX_TOKENS} tokens; Ctrl+C stops)…`,
      ),
    );
    const out = memoryChannel();
    const err = memoryChannel();
    const ctrl = new AbortController();
    this.probing = ctrl;
    let written: boolean;
    try {
      ({ written } = await this.deps.probe({ target, write, io: { out, err }, signal: ctrl.signal }));
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
      return this.say(this.style.dim('(probe stopped; nothing stored)'));
    } finally {
      this.probing = null;
    }
    const text = `${out.text()}${err.text()}`.trimEnd();
    if (text !== '') this.say(this.redact(text));
    if (written) this.say(this.style.dim(`(this chat keeps the caps it started with: the stored facts apply from the next rp-core ${this.commandName})`));
  }
}
