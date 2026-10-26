// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The REPL (ARCHITECTURE.md §12.4, §15 M1b): a line REPL with node:readline for editing and history
// (never for the protocol), ANSI styles, no TUI framework. Pure command parsing lives in repl-commands.ts
// so it can be tested without a terminal.
// CONTRACT FILE (M1b): signature is fixed; the repl agent implements it.

import type { EngineHandle, SessionHandle } from '../engine/api.ts';
import type { RpConfig } from '../config/config.ts';
import type { Io } from './io.ts';

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
}

/** Run until /quit, EOF or a double Ctrl+C at the prompt. Returns the process exit code. */
export function runRepl(deps: ReplDeps): Promise<number> {
  void deps;
  throw new Error('not implemented: runRepl');
}
