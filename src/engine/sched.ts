// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Per-origin semaphore (ARCHITECTURE.md §8.8, §7.4.7, D-37, D-84; .notes/m5b-decisions.md D-172).
// M1a: a FIFO semaphore where interactive waiters overtake background ones. M5b: background holders
// are preemptable, a local origin keeps background off while interactive work is about, and a local
// origin's idle gate holds background back for the session's idleDelaySec after the last touch.
//
// Rules (D-172):
// - Interactive = narrator, Director, recall-sync, `draft`; background = filing, historian.
// - Remote origin: background runs alongside while places are free. When an interactive request would
//   have to wait and a place is held by background, the MOST RECENT background holder is preempted
//   (its slot's signal aborts with TypedAbort 'preempted'); one per interactive request that cannot
//   otherwise be served.
// - Local origin (isLocalOrigin): an interactive request preempts EVERY background holder even with a
//   free place; background starts only when the origin has no interactive request in flight or queued
//   AND its idle gate is open.
// - A preempted holder keeps its place until it releases it (it is aborting; the place never goes to
//   two requests at once), so the origin never carries more than its capacity.
// - Idle gate (local origins only): `touch(origin)` on turn end, head move, edit, hide, continue,
//   swipe and session open; the end of every interactive request on the origin is a touch too (so the
//   gap between the Director's call and the narrator's does not let background in). A background
//   request waits until its own `idleDelaySec` has passed since the last touch. The wait is measured
//   with the injected timers alone (no clock): a request that arrives after a touch, with no request
//   of the same delay already waiting since it, waits the full delay from its arrival (never shorter
//   than the rule; the lane asks right after the touches, so the two coincide). An origin never
//   touched has an open gate; `idleDelaySec` 0 never waits.
// - The scripted provider's `script:` origins (and any origin isLocalOrigin does not know) are remote.
// - Starvation is counted by the lane (it sees each preemption as structuredCall's 'preempted'); the
//   scheduler only exports the threshold.

import { realTimers, TypedAbort, type DelayTimers } from './abort.ts';
import { isLocalOrigin } from '../providers/http.ts';

export type Priority = 'interactive' | 'background';

/** D-172: preemptions in a row after which a background task is starved (it goes first at the next pause). */
export const STARVED_AFTER = 3;

export interface Slot {
  release(): void;
  /**
   * D-172: aborts with TypedAbort('preempted') when an interactive request takes this background
   * place. Never aborts for an interactive slot. The holder stops its work and releases the slot.
   */
  readonly signal: AbortSignal;
}

export interface AcquireOpts {
  /**
   * Background only: the requesting session's `compendium.idleDelaySec` (0–60). On a local origin
   * the request waits this long after the origin's last touch. Absent or 0: no wait.
   */
  idleDelaySec?: number;
}

export interface OriginSemaphore {
  readonly capacity: number;
  /** The origin follows the local rules (isLocalOrigin, D-172). */
  readonly local: boolean;
  /** Places held (all, or of one priority); a preempted holder counts until it releases. */
  inFlight(priority?: Priority): number;
  /** Requests queued (all, or of one priority). */
  waiting(priority?: Priority): number;
  /** Resolves when a place is free. Rejects with the signal's TypedAbort if aborted while waiting. */
  acquire(priority: Priority, signal?: AbortSignal, opts?: AcquireOpts): Promise<Slot>;
}

export interface Scheduler {
  /** The semaphore of an origin (scheme://host:port, or a connection id for in-process providers). */
  forOrigin(origin: string, capacity: number): OriginSemaphore;
  /**
   * D-172 idle gate: activity on the origin (turn end, head move, edit, hide, continue, swipe,
   * session open). Background requests on a local origin wait their idleDelaySec from here. A no-op
   * on a remote origin.
   */
  touch(origin: string): void;
}

export interface SchedulerOptions {
  /** The idle gate's timers (EngineCtx.timers); the host's by default. */
  timers?: DelayTimers;
  /** Which origins follow the local rules; isLocalOrigin by default. */
  isLocal?: (origin: string) => boolean;
}

interface Waiter {
  priority: Priority;
  /** Background: the idle gate's wait in ms (0: none). */
  delayMs: number;
  grant(slot: Slot): void;
}

interface Holder {
  priority: Priority;
  ctrl: AbortController;
  preempted: boolean;
  released: boolean;
}

/** The semaphore plus what the scheduler needs of it. */
interface MutableSemaphore extends OriginSemaphore {
  /** Capacity only ever shrinks. */
  lower(capacity: number): void;
  touch(): void;
}

function checkCapacity(capacity: number): number {
  // A zero or fractional capacity would either deadlock every caller or mean nothing; fail loudly.
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`semaphore capacity must be an integer >= 1, got ${String(capacity)}`);
  }
  return capacity;
}

/** idleDelaySec as timer milliseconds (anything not a positive finite number: no wait). */
function delayMsOf(opts: AcquireOpts | undefined): number {
  const sec = opts?.idleDelaySec;
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
}

function createSemaphore(initial: number, local: boolean, touchedBefore: boolean, timers: DelayTimers): MutableSemaphore {
  let capacity = checkCapacity(initial);
  // Holders in grant order (the most recent last).
  const held: Holder[] = [];
  // Two FIFO queues: an interactive waiter is always served before any background one (§8.8).
  const queues: Record<Priority, Waiter[]> = { interactive: [], background: [] };

  // ---- the idle gate (local origins only) ----
  let touched = touchedBefore;
  /** Per delay (ms): the wait since the last touch; `open` once its timer fired. */
  const waits = new Map<number, { open: boolean; handle: unknown }>();

  const gated = (delayMs: number): boolean => local && touched && delayMs > 0;
  const gateOpen = (delayMs: number): boolean => !gated(delayMs) || waits.get(delayMs)?.open === true;

  /** Starts the wait of a delay since the last touch, unless one runs or has passed. */
  function arm(delayMs: number): void {
    if (!gated(delayMs) || waits.has(delayMs)) return;
    const wait: { open: boolean; handle: unknown } = { open: false, handle: null };
    wait.handle = timers.setTimeout(() => {
      wait.handle = null;
      wait.open = true;
      pump();
    }, delayMs);
    waits.set(delayMs, wait);
  }

  /** Drops running waits no queued request needs (a passed wait stays: it costs no timer). */
  function disarmUnused(): void {
    for (const [delayMs, wait] of waits) {
      if (wait.open || queues.background.some((w) => w.delayMs === delayMs)) continue;
      if (wait.handle !== null) timers.clearTimeout(wait.handle);
      waits.delete(delayMs);
    }
  }

  function touch(): void {
    if (!local) return;
    touched = true;
    for (const wait of waits.values()) if (wait.handle !== null) timers.clearTimeout(wait.handle);
    waits.clear();
    for (const w of queues.background) arm(w.delayMs);
  }

  // ---- places ----
  const heldOf = (priority: Priority): number => held.filter((h) => h.priority === priority).length;
  const interactiveAbout = (): boolean => queues.interactive.length > 0 || heldOf('interactive') > 0;

  /** D-172: marks the background holders an interactive request needs gone, then aborts them. */
  function preempt(): void {
    const candidates = held.filter((h) => h.priority === 'background' && !h.preempted);
    if (candidates.length === 0) return;
    let victims: Holder[] = [];
    if (local) {
      if (interactiveAbout()) victims = candidates;
    } else {
      // Places already on their way back count as free; each interactive waiter beyond them takes
      // the most recent background holder.
      const leaving = held.filter((h) => h.preempted).length;
      const free = Math.max(0, capacity - (held.length - leaving));
      const need = queues.interactive.length - free;
      if (need > 0) victims = candidates.slice(-need);
    }
    for (const v of victims) v.preempted = true;
    // Aborting runs the holder's listeners; any release they make re-enters pump(), which defers.
    for (const v of victims) v.ctrl.abort(new TypedAbort('preempted'));
  }

  /** The first background waiter allowed to start, or -1. */
  function backgroundReady(): number {
    if (local && interactiveAbout()) return -1;
    return queues.background.findIndex((w) => gateOpen(w.delayMs));
  }

  function makeSlot(h: Holder): Slot {
    return {
      signal: h.ctrl.signal,
      release() {
        // Idempotent: a `finally` and an error path may both release the same slot.
        if (h.released) return;
        h.released = true;
        held.splice(held.indexOf(h), 1);
        // The end of an interactive request is activity on the origin (the gap before the next one).
        if (h.priority === 'interactive') touch();
        pump();
      },
    };
  }

  function grant(w: Waiter): void {
    const h: Holder = { priority: w.priority, ctrl: new AbortController(), preempted: false, released: false };
    held.push(h);
    w.grant(makeSlot(h));
  }

  /** One pass: preempt what interactive work needs, then hand out free places in priority order. */
  function step(): void {
    preempt();
    while (held.length < capacity) {
      const next = queues.interactive.shift();
      if (next) {
        grant(next);
        continue;
      }
      const at = backgroundReady();
      if (at < 0) break;
      const [bg] = queues.background.splice(at, 1);
      grant(bg!);
      disarmUnused();
    }
  }

  let pumping = false;
  let again = false;
  /** Called after every change that can free a place, open a gate or need a preemption. */
  function pump(): void {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        step();
      } while (again);
    } finally {
      pumping = false;
    }
  }

  return {
    get capacity() {
      return capacity;
    },
    local,
    inFlight: (priority?: Priority) => (priority === undefined ? held.length : heldOf(priority)),
    waiting: (priority?: Priority) => (priority === undefined ? queues.interactive.length + queues.background.length : queues[priority].length),
    lower(next: number) {
      // Excess holders keep their places; the smaller capacity applies as they release.
      capacity = Math.min(capacity, checkCapacity(next));
    },
    touch,
    acquire(priority: Priority, signal?: AbortSignal, opts?: AcquireOpts): Promise<Slot> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const queue = queues[priority];
      const delayMs = priority === 'background' ? delayMsOf(opts) : 0;
      return new Promise<Slot>((resolve, reject) => {
        const onAbort = (): void => {
          // Leave the queue so the place goes to the next waiter, not to a caller that has gone.
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          if (priority === 'background') disarmUnused();
          reject(signal?.reason);
          // A local origin's background may start once no interactive request is queued.
          pump();
        };
        const waiter: Waiter = {
          priority,
          delayMs,
          grant(slot) {
            signal?.removeEventListener('abort', onAbort);
            resolve(slot);
          },
        };
        queue.push(waiter);
        if (priority === 'background') arm(delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        // A free place is granted synchronously here; otherwise the waiter stays queued.
        pump();
      });
    },
  };
}

export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  const timers = opts.timers ?? realTimers;
  const isLocal = opts.isLocal ?? isLocalOrigin;
  const byOrigin = new Map<string, MutableSemaphore>();
  // Local origins touched before their semaphore existed (a session opens before its first call).
  const touchedEarly = new Set<string>();
  return {
    forOrigin(origin: string, capacity: number): OriginSemaphore {
      const existing = byOrigin.get(origin);
      if (existing) {
        // Two connections on one server share its places [D-84]; if they disagree on how many,
        // the smaller figure is the safe one for a server whose real limit we do not know.
        existing.lower(capacity);
        return existing;
      }
      const sem = createSemaphore(capacity, isLocal(origin), touchedEarly.has(origin), timers);
      touchedEarly.delete(origin);
      byOrigin.set(origin, sem);
      return sem;
    },
    touch(origin: string): void {
      const sem = byOrigin.get(origin);
      if (sem) sem.touch();
      else if (isLocal(origin)) touchedEarly.add(origin);
    },
  };
}
