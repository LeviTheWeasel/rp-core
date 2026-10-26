// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Text checkpoints while a reply streams (ARCHITECTURE.md §5.3 "Долговечность", §6.2 step 8):
// a `chk` line with the new text every `chars` characters or `ms` milliseconds, whichever comes
// first, written without fsync; an fdatasync every `datasyncMs` while there is unsynced text.
// Timers are injected so tests can drive them; everything is cleared by stop().

import type { DelayTimers } from './abort.ts';

export interface CheckpointCadence {
  chars: number;
  ms: number;
  datasyncMs: number;
}

export const DEFAULT_CHECKPOINT: CheckpointCadence = { chars: 400, ms: 1000, datasyncMs: 2000 };

/** Fill a partial cadence with the defaults; nonsense values fall back too. */
export function checkpointCadence(c?: Partial<CheckpointCadence>): CheckpointCadence {
  const pick = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    chars: pick(c?.chars, DEFAULT_CHECKPOINT.chars),
    ms: pick(c?.ms, DEFAULT_CHECKPOINT.ms),
    datasyncMs: pick(c?.datasyncMs, DEFAULT_CHECKPOINT.datasyncMs),
  };
}

export class Checkpointer {
  private pending = '';
  private flushTimer: unknown = null;
  private syncTimer: unknown = null;
  /** chk lines written since the last datasync. */
  private dirty = false;
  private stopped = false;
  /** The first write error, if any (a timer cannot throw to anyone). */
  error: unknown = null;

  constructor(
    private readonly write: (text: string) => void,
    private readonly sync: () => void,
    private readonly cadence: CheckpointCadence,
    private readonly timers: DelayTimers,
  ) {}

  /** Start the datasync cadence. Called when streaming begins. */
  start(): void {
    if (this.stopped || this.syncTimer !== null) return;
    const tick = (): void => {
      this.syncTimer = null;
      if (this.stopped) return;
      this.syncNow();
      this.syncTimer = this.timers.setTimeout(tick, this.cadence.datasyncMs);
    };
    this.syncTimer = this.timers.setTimeout(tick, this.cadence.datasyncMs);
  }

  /** New streamed text. */
  add(delta: string): void {
    if (this.stopped || delta === '') return;
    this.pending += delta;
    if (this.pending.length >= this.cadence.chars) this.flush();
    else if (this.flushTimer === null) {
      this.flushTimer = this.timers.setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.cadence.ms);
    }
  }

  /** Write whatever is pending as one chk line (before a commit or a crash-relevant point). */
  flush(): void {
    this.clearFlushTimer();
    if (this.pending === '') return;
    const text = this.pending;
    this.pending = '';
    try {
      this.write(text);
      this.dirty = true;
    } catch (e) {
      // Losing a checkpoint is not fatal while the turn is alive; the commit reports real trouble.
      this.error ??= e;
    }
  }

  /** Clear every timer. `flush` writes pending text first; false discards it (a dropped turn). */
  stop(opts: { flush: boolean }): void {
    if (this.stopped) return;
    if (opts.flush) this.flush();
    else this.pending = '';
    this.stopped = true;
    this.clearFlushTimer();
    if (this.syncTimer !== null) {
      this.timers.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private syncNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.sync();
    } catch (e) {
      this.error ??= e;
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
