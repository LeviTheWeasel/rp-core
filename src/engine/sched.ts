// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Per-origin semaphore (ARCHITECTURE.md §8.8, D-37, D-84). M1a: a FIFO semaphore where interactive
// waiters overtake background ones. Preemption and the local-origin background rules arrive in M5.
// CONTRACT FILE: signatures are fixed; the infra agent implements the bodies.

export type Priority = 'interactive' | 'background';

export interface Slot {
  release(): void;
}

export interface OriginSemaphore {
  readonly capacity: number;
  inFlight(): number;
  waiting(): number;
  /** Resolves when a place is free. Rejects with the signal's TypedAbort if aborted while waiting. */
  acquire(priority: Priority, signal?: AbortSignal): Promise<Slot>;
}

export interface Scheduler {
  /** The semaphore of an origin (scheme://host:port, or a connection id for in-process providers). */
  forOrigin(origin: string, capacity: number): OriginSemaphore;
}

interface Waiter {
  grant(): void;
}

/** The semaphore plus the one mutation the scheduler needs (capacity only ever shrinks). */
interface MutableSemaphore extends OriginSemaphore {
  lower(capacity: number): void;
}

function checkCapacity(capacity: number): number {
  // A zero or fractional capacity would either deadlock every caller or mean nothing; fail loudly.
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`semaphore capacity must be an integer >= 1, got ${String(capacity)}`);
  }
  return capacity;
}

function createSemaphore(initial: number): MutableSemaphore {
  let capacity = checkCapacity(initial);
  let inFlight = 0;
  // Two FIFO queues: an interactive waiter is always served before any background one (§8.8).
  const queues: Record<Priority, Waiter[]> = { interactive: [], background: [] };

  /** Hands out free places in priority order. Called after every change that can free one. */
  function pump(): void {
    while (inFlight < capacity) {
      const next = queues.interactive.shift() ?? queues.background.shift();
      if (!next) return;
      inFlight++;
      next.grant();
    }
  }

  function makeSlot(): Slot {
    let released = false;
    return {
      release() {
        // Idempotent: a `finally` and an error path may both release the same slot.
        if (released) return;
        released = true;
        inFlight--;
        pump();
      },
    };
  }

  return {
    get capacity() {
      return capacity;
    },
    inFlight: () => inFlight,
    waiting: () => queues.interactive.length + queues.background.length,
    lower(next: number) {
      // Excess holders keep their places; the smaller capacity applies as they release.
      capacity = Math.min(capacity, checkCapacity(next));
    },
    acquire(priority: Priority, signal?: AbortSignal): Promise<Slot> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const queue = queues[priority];
      return new Promise<Slot>((resolve, reject) => {
        const onAbort = (): void => {
          // Leave the queue so the place goes to the next waiter, not to a caller that has gone.
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(signal?.reason);
        };
        const waiter: Waiter = {
          grant() {
            signal?.removeEventListener('abort', onAbort);
            resolve(makeSlot());
          },
        };
        queue.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        // A free place is granted synchronously here; otherwise the waiter stays queued.
        pump();
      });
    },
  };
}

export function createScheduler(): Scheduler {
  const byOrigin = new Map<string, MutableSemaphore>();
  return {
    forOrigin(origin: string, capacity: number): OriginSemaphore {
      const existing = byOrigin.get(origin);
      if (existing) {
        // Two connections on one server share its places [D-84]; if they disagree on how many,
        // the smaller figure is the safe one for a server whose real limit we do not know.
        existing.lower(capacity);
        return existing;
      }
      const sem = createSemaphore(capacity);
      byOrigin.set(origin, sem);
      return sem;
    },
  };
}
