// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Which home directory a CLI run uses (ARCHITECTURE.md §5.2): --home, else RP_CORE_HOME, else
// ~/.rp-core. --sandbox swaps in a fresh temporary home that is removed when the process exits,
// so a run can never touch the owner's library or sessions.

import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from './args.ts';

export interface Home {
  dir: string;
  sandbox: boolean;
  /** Remove the sandbox (no-op for a real home). Synchronous so the exit paths can call it. Idempotent. */
  dispose(): void;
}

export function resolveHome(opts: { home?: string; sandbox: boolean; env: Record<string, string | undefined> }): Home {
  if (opts.sandbox) {
    // Both would name the same thing twice; refusing beats guessing which one wins.
    if (opts.home !== undefined) throw new UsageError('--sandbox and --home cannot be combined');
    const dir = mkdtempSync(join(tmpdir(), 'rp-core-sandbox-'));
    let gone = false;
    return {
      dir,
      sandbox: true,
      dispose(): void {
        if (gone) return;
        gone = true;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  if (opts.home !== undefined && opts.home.trim() === '') throw new UsageError('--home needs a directory');
  const fromEnv = opts.env.RP_CORE_HOME;
  const dir = opts.home ?? (fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.rp-core'));
  return { dir: resolve(dir), sandbox: false, dispose: () => {} };
}
