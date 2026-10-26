// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The CLI's two channels (ARCHITECTURE.md §12.2 "Каналы"): stdout carries only the product (text
// or events), stderr carries everything a human should read. Writes are tracked so the process
// can exit only after they are out: under Bun 1.3.14 a process.exit() right after a large
// write to a pipe loses the tail, while awaiting the last write's callback does not.

import type { Writable } from 'node:stream';

export interface Channel {
  write(text: string): void;
  /** Resolves when everything written so far has been handed to the OS. */
  flush(): Promise<void>;
}

export interface Io {
  out: Channel;
  err: Channel;
}

/** A tracked channel over a Node-style writable (process.stdout / process.stderr). */
export function streamChannel(stream: Pick<Writable, 'write' | 'on'>): Channel {
  let last: Promise<void> = Promise.resolve();
  let broken = false;
  // A closed reader (`rp-core send … | head`) must not crash the turn: the session still commits.
  stream.on('error', () => {
    broken = true;
  });
  return {
    write(text: string): void {
      if (broken || text === '') return;
      last = new Promise<void>((resolve) => {
        try {
          stream.write(text, () => resolve());
        } catch {
          broken = true;
          resolve();
        }
      });
    },
    flush(): Promise<void> {
      return last;
    },
  };
}

/** A channel that keeps what is written (unit tests of renderers). */
export function memoryChannel(): Channel & { text(): string } {
  const parts: string[] = [];
  return {
    write: (t) => void parts.push(t),
    flush: () => Promise.resolve(),
    text: () => parts.join(''),
  };
}

export function processIo(): Io {
  return { out: streamChannel(process.stdout), err: streamChannel(process.stderr) };
}
