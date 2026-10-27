// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's input port (TUI decisions T-3, T-9; .notes/tui-contract-ports.md "What the TUI's
// TextareaSource must do"): the Repl reads lines from the input box, and Ctrl+C presses (the key,
// a SIGINT from outside, Esc during an edit) reach its interrupt handler. The Repl's rules apply
// unchanged: text typed mid-turn is held, editing commands are refused, /e edits in place.
// Once the input is closed or its box destroyed (the renderer went away: a hangup, T-13) every
// method is a no-op, so a late Ctrl+C or prompt never touches a destroyed renderer. The paste guard
// (T-16) keeps an unterminated bracketed paste from swallowing Enter and Ctrl+C.

import type { InterruptSource, LineSource } from '../repl.ts';
import { stripAnsi } from '../repl-render.ts';
import type { SignalSource } from '../signals.ts';

/** What the source needs of the input box (a TextareaRenderable; tests pass a plain object). */
export interface InputBox {
  readonly plainText: string;
  setText(text: string): void;
  gotoBufferEnd?(): void;
  /** True once the renderer destroyed the box (a TextareaRenderable has it). */
  readonly isDestroyed?: boolean;
}

/**
 * The input's label from the Repl's prompt text (T-17): its SGR dropped and its padding collapsed,
 * `you      › ` → `you › `. The REPL pads the label to the character's name width to align its
 * columns; the transcript keeps that alignment, the input does not need it.
 */
export function inputLabel(prompt: string): string {
  const label = stripAnsi(prompt).trim().replace(/\s+/g, ' ');
  return label === '' ? '' : `${label} `;
}

/**
 * A LineSource over the input box. The host calls submit() on Enter and inject() for a hotkey's
 * command line. Lines sent before the Repl awaits next() wait in a queue.
 */
export class TextareaSource implements LineSource {
  readonly interactive = true;
  /** The Repl echoes every line through the view (the transcript shows it). */
  readonly echoes = false;
  readonly inline = true;
  readonly multiline = true;
  muted = false;
  private lines: string[] = [];
  private waiters: ((r: IteratorResult<string>) => void)[] = [];
  private closed = false;
  private mode: 'line' | 'edit' = 'line';
  private lineLabel = '';

  constructor(
    private readonly box: InputBox,
    private readonly setLabel: (label: string) => void,
  ) {}

  /** 'edit' while an in-place /e waits for its line (command hotkeys stay out, Esc cancels). */
  get promptMode(): 'line' | 'edit' {
    return this.mode;
  }

  next(): Promise<IteratorResult<string>> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve({ done: false, value: line });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Enter: the box's text becomes a line (real line breaks kept), the box empties. */
  submit(): void {
    if (this.gone()) return;
    const text = this.box.plainText;
    this.box.setText('');
    this.endEdit();
    this.push(text);
  }

  /** A hotkey's command line, as if typed and sent (the box keeps what was typed). */
  inject(line: string): void {
    this.push(line);
  }

  prompt(text: string, mode: 'line' | 'edit' = 'line'): void {
    if (this.gone()) return;
    this.mode = mode;
    const label = inputLabel(text);
    if (mode === 'line') this.lineLabel = label;
    this.setLabel(label);
  }

  mute(on: boolean): void {
    this.muted = on;
  }

  pending(): string {
    return this.gone() ? '' : this.box.plainText;
  }

  clearPending(): void {
    if (this.gone()) return;
    this.box.setText('');
    // The only clear during an edit is its cancel (Ctrl+C / Esc): the box is a plain input again.
    this.endEdit();
  }

  /** /e: the message as is (a multi-line box holds its real line breaks), the cursor at its end. */
  prefill(text: string): void {
    if (this.gone()) return;
    this.box.setText(text);
    this.box.gotoBufferEnd?.();
  }

  /** Not used: /e is inline only in the TUI (T-9), the host passes an env without VISUAL / EDITOR. */
  suspend(): () => void {
    return () => {};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ done: true, value: undefined });
  }

  private push(line: string): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ done: false, value: line });
    else this.lines.push(line);
  }

  /** Closed, or the box is destroyed: nothing may touch it any more. */
  private gone(): boolean {
    return this.closed || this.box.isDestroyed === true;
  }

  private endEdit(): void {
    if (this.mode !== 'edit') return;
    this.mode = 'line';
    if (this.lineLabel !== '') this.setLabel(this.lineLabel);
  }
}

export interface InterruptHub {
  /** ReplOptions.source.interrupts: the Repl subscribes its handler. */
  interrupts: InterruptSource;
  /** One press: the Ctrl+C key, Esc during an edit, a SIGINT from outside (`kill -INT`). */
  fire(): void;
  /** Stop listening to SIGINT. */
  dispose(): void;
}

/**
 * The Ctrl+C port. SIGINT is listened to from the start (OpenTUI's exitSignals leave it out); a press
 * while no Repl is subscribed (startup, teardown) calls `orphan` (the host leaves cleanly, 130).
 */
export function interruptHub(signals: Pick<SignalSource, 'on' | 'removeListener'> = process, orphan?: () => void): InterruptHub {
  const handlers = new Set<() => void>();
  const fire = (): void => {
    if (handlers.size === 0) return orphan?.();
    for (const h of [...handlers]) h();
  };
  signals.on('SIGINT', fire);
  return {
    interrupts: (handler) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    fire,
    dispose: () => void signals.removeListener('SIGINT', fire),
  };
}

// ---- the paste guard (T-16) -------------------------------------------------------------------------

/** Bracketed paste markers (the terminal wraps pasted text in them; OpenTUI turns them on). */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
/** A paste still open after this long without a new byte is ended (a real paste arrives in one burst). */
export const PASTE_IDLE_MS = 1000;

/** What the guard needs of the renderer's input stream (renderer.stdin; tests pass the mock stdin). */
export interface InputStream {
  prependListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  emit(event: 'data', chunk: Buffer): boolean;
}

/**
 * One Ctrl+C key press as a whole input chunk, in each encoding a terminal may use: the legacy byte
 * 0x03, kitty CSI-u (`CSI 99;5u`, with a Russian layout `CSI 1089::99;5u`, lock bits and an event type
 * allowed) and xterm's modifyOtherKeys (`CSI 27;5;99~`). The Ctrl bit of a modifier field is 4 (+1).
 */
export function isCtrlCChunk(s: string): boolean {
  if (s === '\x03') return true;
  const ctrl = (mod: string): boolean => ((Number(mod) - 1) & 4) !== 0 && ((Number(mod) - 1) & 0b1010) === 0;
  const c = (code: string | undefined): boolean => code === '99' || code === '1089';
  const kitty = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?;(\d+)(?::1)?u$/.exec(s);
  if (kitty) return ctrl(kitty[4]!) && (c(kitty[1]) || kitty[3] === '99');
  const other = /^\x1b\[27;(\d+);(\d+)~$/.exec(s);
  return other !== null && ctrl(other[1]!) && c(other[2]);
}

/**
 * A bracketed paste whose end marker never comes (OpenTUI 0.7.0 #1270: its parser buffers every later
 * byte as pasted text, Enter and Ctrl+C included) is ended by the guard, which sees the raw input
 * before OpenTUI's parser does: after `idleMs` without a new byte, or at once when a whole chunk is a
 * Ctrl+C key press. Ending it feeds the end marker into the stream, so the text pasted so far lands in
 * the input box and the key that follows is a key again. Returns the function that removes the guard.
 */
export function pasteGuard(stdin: InputStream, o: { idleMs?: number; onEnd?: (why: 'idle' | 'interrupt') => void } = {}): () => void {
  const idleMs = o.idleMs ?? PASTE_IDLE_MS;
  let open = false;
  /** The last bytes of the previous chunk: a marker may be split between two chunks. */
  let tail = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const end = (why: 'idle' | 'interrupt'): void => {
    disarm();
    if (!open) return;
    o.onEnd?.(why);
    // Re-enters tap() below (open becomes false) and reaches OpenTUI's parser, which closes the paste.
    stdin.emit('data', Buffer.from(PASTE_END, 'latin1'));
  };
  const tap = (chunk: Buffer | string): void => {
    // latin1 keeps one character per byte: the markers are ASCII, the offsets stay byte offsets.
    const text = typeof chunk === 'string' ? Buffer.from(chunk).toString('latin1') : chunk.toString('latin1');
    if (open && isCtrlCChunk(text)) {
      end('interrupt');
      return;
    }
    const s = tail + text;
    tail = s.slice(-(PASTE_END.length - 1));
    const started = s.lastIndexOf(PASTE_START);
    const ended = s.lastIndexOf(PASTE_END);
    if (started > ended) open = true;
    else if (ended > started) open = false;
    disarm();
    if (open) {
      timer = setTimeout(() => end('idle'), idleMs);
      (timer as { unref?: () => void }).unref?.();
    }
  };
  stdin.prependListener('data', tap);
  return () => {
    disarm();
    stdin.removeListener('data', tap);
  };
}
