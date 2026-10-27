// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Where the TUI's text goes while the renderer owns the terminal (TUI decisions T-10). A write to
// process.stdout / process.stderr would land in the middle of the frame, so the TUI's Io sends both
// channels to the transcript (as system rows) and to a file log, <home>/logs/tui.log, which also
// takes debug lines and uncaught errors. Once the renderer is gone, the Io writes to the real
// channels again (detach).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { systemClock } from '../../engine/system.ts';
import type { Channel, Io } from '../io.ts';
import { stripAnsi } from '../repl-render.ts';

/** The file log: one timestamped line per call; failures to write are swallowed (it is a log). */
export interface FileLog {
  readonly path: string;
  line(text: string): void;
  error(e: unknown, where?: string): void;
}

/** <home>/logs/tui.log */
export function tuiLogPath(home: string): string {
  return join(home, 'logs', 'tui.log');
}

export function fileLog(path: string, clock: () => Date = systemClock): FileLog {
  let ready = false;
  const write = (text: string): void => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      const at = clock().toISOString();
      const body = stripAnsi(text).replace(/\n+$/, '');
      appendFileSync(path, `${at} ${body.replace(/\n/g, `\n${at} `)}\n`);
    } catch {
      /* nowhere left to report it */
    }
  };
  return {
    path,
    line: write,
    error(e: unknown, where = 'error'): void {
      const what = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}` : String(e);
      write(`${where}: ${what}`);
    },
  };
}

/** The TUI's Io: out and err become transcript rows (via `show`) and log lines. */
export interface TuiIo extends Io {
  /** Where a write is shown while the renderer is up (the transcript's system rows). */
  attach(show: (text: string) => void): void;
  /** The renderer is gone: from now on writes go to `to` (processIo()), still logged. */
  detach(to: Io): void;
}

export function tuiIo(log: FileLog): TuiIo {
  let show: ((text: string) => void) | null = null;
  let real: Io | null = null;
  const channel = (name: 'out' | 'err'): Channel => ({
    write(text: string): void {
      if (text === '') return;
      log.line(`${name}: ${text}`);
      if (real) return real[name].write(text);
      const t = text.replace(/^\n+|\n+$/g, '');
      if (show && t !== '') show(t);
    },
    flush(): Promise<void> {
      return real ? real[name].flush() : Promise.resolve();
    },
  });
  return {
    out: channel('out'),
    err: channel('err'),
    attach(s): void {
      show = s;
    },
    detach(to: Io): void {
      show = null;
      real = to;
    },
  };
}
