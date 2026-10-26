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

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { Refusal, type EngineHandle, type SessionHandle, type TurnHandle, type TurnOutcome } from '../engine/api.ts';
import { ConfigError, type RpConfig } from '../config/config.ts';
import type { Event } from '../protocol/events.ts';
import type { DeepPartial, Roles, SessionConfig } from '../session/entries.ts';
import { readSessionFile } from '../session/log.ts';
import type { MessageView, PathView } from '../session/view.ts';
import type { Io } from './io.ts';
import { describeEvent, hasServerWords, messageText, redactEvent } from './render.ts';
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
  bannerLine,
  formatMessage,
  labels,
  makeStyle,
  noticeText,
  prefix,
  refusalText,
  renderBindings,
  renderNote,
  renderNumberedPath,
  renderSessionList,
  renderTails,
  renderTrace,
  renderUsage,
  Screen,
  statusLine,
  TurnPrinter,
  type Style,
} from './repl-render.ts';

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
   * window of that answer's trace wins afterwards. Optional: without it the banner says `ctx ?`.
   */
  windowOf?: (conn: string, model: string) => number | null;
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
}

/** Run until /quit, EOF or a double Ctrl+C at the prompt. Returns the process exit code. */
export function runRepl(deps: ReplDeps): Promise<number> {
  return runReplWith(deps, {});
}

/** runRepl with the extra knobs of ReplOptions. */
export function runReplWith(deps: ReplDeps, opts: ReplOptions = {}): Promise<number> {
  return new Repl(deps, opts).run();
}

// ---- input sources --------------------------------------------------------------------------------

interface LineSource {
  next(): Promise<IteratorResult<string>>;
  /** Lines may arrive while a turn runs (a person typing). */
  readonly interactive: boolean;
  /** The source shows the prompt and echoes typing itself (readline on a TTY). */
  readonly echoes: boolean;
  /** Show the prompt, with any text typed and not yet sent after it. */
  prompt(text: string): void;
  /** Mute (true) or restore (false) the source's own writes: its echo and redraws (a turn streams). */
  mute(on: boolean): void;
  readonly muted: boolean;
  /** Text typed and not yet sent ('' for sources that do not edit lines). */
  pending(): string;
  /** Throw the typed text away (Ctrl+C at the prompt). */
  clearPending(): void;
  /** Put text into the input line as if typed (inline /e); no-op for sources that do not edit lines. */
  prefill(text: string): void;
  /** Hand the terminal to a child process (the editor); returns the function that takes it back. */
  suspend(): () => void;
  close(): void;
}

type InterruptSource = (handler: () => void) => () => void;

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

// ---- the REPL ---------------------------------------------------------------------------------------

type Item = { t: 'line'; line: string; during: boolean } | { t: 'end' } | { t: 'quit' };

class Repl {
  private session: SessionHandle;
  private readonly style: Style;
  private readonly screen: Screen;
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
  private printer: TurnPrinter | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ctrl+C presses during the running turn (1: stop asked). */
  private stopPresses = 0;
  /** Resolves run() at once with an exit code (the third press on a turn that will not stop). */
  private leaveNow: ((code: number) => void) | null = null;
  /** The --debug hint after a provider failure was given (once per REPL). */
  private debugHinted = false;
  private left = false;
  private finished = false;
  /** Set while /e edits in place: the next line (or null on Ctrl+C / end of input) is the result. */
  private editing: ((line: string | null) => void) | null = null;

  constructor(
    private readonly deps: ReplDeps,
    opts: ReplOptions,
  ) {
    const env = opts.env ?? process.env;
    this.session = deps.session;
    this.style = makeStyle(deps.color ?? (process.stdout.isTTY === true && !env.NO_COLOR));
    this.screen = new Screen((s) => deps.io.out.write(s));
    if (deps.input) {
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
      this.screen.line(this.style.red(`error: ${errorMessage(e)}`));
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
          this.screen.line(this.style.red(`error while closing the session: ${errorMessage(e)}`));
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
      if (this.queue.length === 0) this.prompt();
      const item = await this.take();
      if (item.t !== 'line') return 0;
      await this.process(item);
    }
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
    if (this.source.echoes && !this.source.muted) this.screen.markLineStart();
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
    if (this.source.echoes) this.screen.write('\n'); // the cursor sits after the prompt
    this.screen.line(this.style.dim('(press Ctrl+C again to quit, or type /quit)'));
    if (this.wake) this.prompt();
  }

  private disarmExit(): void {
    if (this.exitTimer !== null) clearTimeout(this.exitTimer);
    this.exitTimer = null;
  }

  // ---- output helpers ------------------------------------------------------------------------------

  private prompt(): void {
    if (!this.source.echoes || this.finished) return;
    this.screen.newline();
    this.source.prompt(prefix(this.names.user, this.style));
  }

  /** A report line; mid-answer it first ends the streamed line so the two never glue. */
  private say(text: string): void {
    this.printer?.interject();
    this.screen.line(text);
  }

  private echo(line: string): void {
    this.say(`${prefix(this.names.user, this.style)}${line.trim()}`);
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

  private printMessage(m: MessageView): void {
    this.say(formatMessage(m, this.names, this.style));
    if (m.role === 'assistant') this.say(statusLine(m, this.style));
  }

  /** The session's journal as it is on disk now (read-only; the session holds the lock). */
  private journal(): Journal {
    const { header, entries } = readSessionFile(this.deps.home, this.session.id);
    return journalOf(header, entries);
  }

  /** Banner, what happened while opening, and where the story stands. */
  private greet(): void {
    const header = this.session.header();
    this.names = labels(header.cast.character.name);
    const j = this.journal();
    const config = configOf(j);
    this.showReasoning = config.reasoningShown;
    const view = this.session.view();
    const narrator = config.roles.narrator;
    let window = windowFor(j, view.path.map((m) => m.id), narrator, this.deps.config.caps, config.window);
    if (window === null && this.deps.windowOf) {
      const w = this.deps.windowOf(narrator.conn, narrator.model);
      if (w !== null && w > 0) window = typeof config.window === 'number' && config.window > 0 ? Math.min(w, config.window) : w;
    }
    this.say(bannerLine(header, narrator, window, this.style));
    for (const ev of this.session.openEvents()) this.openEvent(ev);
    this.whereYouAre(view);
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
    this.say(formatMessage(head, this.names, this.style));
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
    const printer = new TurnPrinter({
      screen: this.screen,
      style: this.style,
      label: this.names.char,
      showReasoning: () => this.showReasoning,
      notice: (n) => this.notice(n),
      ...(continueFrom !== undefined ? { continueFrom } : {}),
    });
    this.printer = printer;
    let outcome: TurnOutcome;
    try {
      for await (const ev of turn.events) printer.push(redactEvent(ev, this.deps.redact));
      outcome = await turn.result;
    } finally {
      printer.finish();
      this.printer = null;
      this.turn = null;
      this.stopPresses = 0;
      this.source.mute(false);
    }
    const answer = this.answerOf(outcome, turn, printer.kept);
    if (answer) this.say(statusLine(answer, this.style));
    if (outcome.type === 'failed' && hasServerWords(outcome) && !this.deps.debugTap && !this.debugHinted) {
      this.debugHinted = true;
      this.say(this.style.dim(`  (rp-core chat ${this.session.id} --debug shows the server's own words)`));
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
      case 'probe':
        return this.say(
          'Probes run from the shell: rp-core probe <connection>[:<model>] [--write]. They ask the server for its models and\n' +
            'limits (/models, /props, /api/show, OpenRouter supported_parameters); --write keeps the result for the next sessions.',
        );
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
    if (initial.includes(INLINE_BREAK)) {
      this.say(this.style.yellow(`this message contains ${INLINE_BREAK} itself; set $EDITOR to edit it in an editor`));
      return Promise.resolve(null);
    }
    this.say(this.style.dim(`editing in place: Enter saves · Ctrl+C cancels · ${INLINE_BREAK} is a line break · set $EDITOR to use an editor`));
    return new Promise<string | null>((resolve) => {
      this.editing = (line) => {
        this.editing = null;
        resolve(line === null ? null : line.split(INLINE_BREAK).join('\n'));
      };
      if (!this.source.echoes) return; // piped input: the next line is the new text
      this.screen.newline();
      this.source.prompt(prefix('edit', this.style));
      this.source.prefill(initial.replace(/\r?\n/g, INLINE_BREAK));
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
    if (now) this.say(formatMessage(now, this.names, this.style));
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

  /** /trace: the newest trace of the last answer on the path. */
  private trace(): void {
    const view = this.session.view();
    const j = this.journal();
    for (let i = view.path.length - 1; i >= 0; i--) {
      const m = view.path[i]!;
      if (m.role !== 'assistant') continue;
      const t = latestTrace(j, m.id);
      if (t) return this.say(renderTrace(m.id, t));
    }
    this.say(this.style.dim('no answer with a trace on this path yet (greetings have none)'));
  }
}
