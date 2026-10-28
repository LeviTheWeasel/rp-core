// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Per-origin semaphore (ARCHITECTURE.md §8.8, §7.4.7, D-37, D-84; .notes/m5b-decisions.md D-172;
// .notes/m5c-decisions.md D-203, D-207).
// M1a: a FIFO semaphore where interactive waiters overtake background ones. M5b: background holders
// are preemptable, a local origin keeps background off while interactive work is about, and a local
// origin's idle gate holds background back for the session's idleDelaySec after the last touch. M5c:
// a boost lifts a background request (queued or held) to interactive and back, a request may wait for
// another's place in the queue before taking its own, and locality may come from the connections.
//
// Rules (D-172, D-203):
// - Interactive = narrator, Director, recall-sync, `draft`; background = filing, historian, prerecall.
// - Remote origin: background runs alongside while places are free. When an interactive request would
//   have to wait and a place is held by background, the MOST RECENT background holder is preempted
//   (its slot's signal aborts with TypedAbort 'preempted'); one per interactive request that cannot
//   otherwise be served.
// - Local origin: an interactive request preempts EVERY background holder even with a free place;
//   background starts only when the origin has no interactive request in flight or queued AND its
//   idle gate is open.
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
// - Boost (D-203, the grace wait): every request acquired with a promoted boost is interactive, the
//   rules above included — a queued one is served with the interactive requests in arrival order and
//   past the idle gate, a held one is not preempted and keeps a local origin's background off. Demoted,
//   each is again the priority it asked for (a held background one is preemptable at once). A holder
//   preempted before the promotion stays preempted: an abort cannot be called back.
// - Order (D-203, Director-first on one place): `after` keeps a request out of the queue until a
//   promise settles; `ordered()` builds the pair of schedulers a turn gives the Director and recall
//   (on an origin of more places it orders nothing: ruling K).
// - Locality (D-207): the injected `isLocal`; the engine passes connectionLocality (a configured
//   connection's `local`, a script that says it is local, else isLocalOrigin). Without one, every
//   origin isLocalOrigin does not know (the scripted provider's `script:` origins) is remote.
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
   * place. Never aborts for an interactive slot (nor for a background one while its boost is promoted).
   * The holder stops its work and releases the slot.
   */
  readonly signal: AbortSignal;
}

/**
 * D-203: the grace wait's lever on a prefetch's requests, queued or held, on any origin. Made by
 * createBoost and passed in AcquireOpts.boost (or through boosted()); starts demoted.
 */
export interface Boost {
  readonly promoted: boolean;
  /** Its requests count as interactive from now (the header's rules). Idempotent. */
  promote(): void;
  /** Back to the priority each request asked for. Idempotent. */
  demote(): void;
}

export interface AcquireOpts {
  /**
   * Background only: the requesting session's `compendium.idleDelaySec` (0–60). On a local origin
   * the request waits this long after the origin's last touch. Absent or 0: no wait.
   */
  idleDelaySec?: number;
  /** D-203: the request is interactive while this boost is promoted (createBoost). */
  boost?: Boost;
  /**
   * D-203: the request joins the queue only once this settles (fulfilled or rejected alike), so a
   * request made at the same moment as another can be put behind it. An abort while waiting rejects
   * with the signal's reason, as an abort in the queue does.
   */
  after?: PromiseLike<unknown>;
}

export interface OriginSemaphore {
  readonly capacity: number;
  /** The origin follows the local rules (the scheduler's isLocal, D-172, D-207). */
  readonly local: boolean;
  /** Places held (all, or of one priority as boosts make it now); a preempted holder counts until it releases. */
  inFlight(priority?: Priority): number;
  /** Requests queued (all, or of one priority as boosts make it now); one still waiting for `after` is not. */
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
  /** Which origins follow the local rules; isLocalOrigin by default (the engine: connectionLocality, D-207). */
  isLocal?: (origin: string) => boolean;
}

// ---- boosts -------------------------------------------------------------------------------------

/** A boost as the semaphores see it: they ask to be pumped when it moves. */
interface WatchedBoost extends Boost {
  watch(pump: () => void): void;
}

const isWatched = (b: Boost): b is WatchedBoost => typeof (b as Partial<WatchedBoost>).watch === 'function';

/** D-203: a demoted boost for one prefetch run (pass it with every acquire of the run). */
export function createBoost(): Boost {
  let promoted = false;
  // The pumps of the semaphores that have had a request of this boost (a pump with nothing to do is a no-op).
  const pumps = new Set<() => void>();
  const set = (next: boolean): void => {
    if (promoted === next) return;
    promoted = next;
    for (const pump of [...pumps]) pump();
  };
  const boost: WatchedBoost = {
    get promoted() {
      return promoted;
    },
    promote: () => set(true),
    demote: () => set(false),
    watch: (pump) => {
      pumps.add(pump);
    },
  };
  return boost;
}

// ---- the semaphore ------------------------------------------------------------------------------

interface Waiter {
  /** What the request asked for (a boost may lift it while it waits). */
  priority: Priority;
  boost: Boost | undefined;
  /** Background: the idle gate's wait in ms (0: none). */
  delayMs: number;
  grant(slot: Slot): void;
}

interface Holder {
  priority: Priority;
  boost: Boost | undefined;
  ctrl: AbortController;
  preempted: boolean;
  released: boolean;
}

/** The priority a waiter has now: interactive while its boost is promoted. */
const waiterPriority = (w: Waiter): Priority => (w.boost?.promoted ? 'interactive' : w.priority);
/** The priority a holder has now; a holder already preempted stays background (its abort has fired). */
const holderPriority = (h: Holder): Priority => (h.boost?.promoted && !h.preempted ? 'interactive' : h.priority);

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

/** Resolves once `after` settles either way; rejects with the signal's reason if it aborts first. */
function settled(after: PromiseLike<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal?.reason);
    const done = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(after).then(done, done);
  });
}

function createSemaphore(initial: number, local: boolean, touchedBefore: boolean, timers: DelayTimers): MutableSemaphore {
  let capacity = checkCapacity(initial);
  // Holders in grant order (the most recent last).
  const held: Holder[] = [];
  // Waiters in arrival order. Interactive ones (as boosts make them now) are always served before any
  // background one (§8.8); within each priority the order is the arrival order.
  const queue: Waiter[] = [];

  const queuedAs = (priority: Priority): Waiter[] => queue.filter((w) => waiterPriority(w) === priority);
  /** Waiters that asked for background (a promoted one keeps its idle-gate wait running for a demotion). */
  const askedBackground = (): Waiter[] => queue.filter((w) => w.priority === 'background');

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
    const needed = askedBackground();
    for (const [delayMs, wait] of waits) {
      if (wait.open || needed.some((w) => w.delayMs === delayMs)) continue;
      if (wait.handle !== null) timers.clearTimeout(wait.handle);
      waits.delete(delayMs);
    }
  }

  function touch(): void {
    if (!local) return;
    touched = true;
    for (const wait of waits.values()) if (wait.handle !== null) timers.clearTimeout(wait.handle);
    waits.clear();
    for (const w of askedBackground()) arm(w.delayMs);
  }

  // ---- places ----
  const heldOf = (priority: Priority): number => held.filter((h) => holderPriority(h) === priority).length;
  const interactiveAbout = (): boolean => queue.some((w) => waiterPriority(w) === 'interactive') || heldOf('interactive') > 0;

  /** D-172: marks the background holders an interactive request needs gone, then aborts them. */
  function preempt(): void {
    const candidates = held.filter((h) => holderPriority(h) === 'background' && !h.preempted);
    if (candidates.length === 0) return;
    let victims: Holder[] = [];
    if (local) {
      if (interactiveAbout()) victims = candidates;
    } else {
      // Places already on their way back count as free; each interactive waiter beyond them takes
      // the most recent background holder.
      const leaving = held.filter((h) => h.preempted).length;
      const free = Math.max(0, capacity - (held.length - leaving));
      const need = queuedAs('interactive').length - free;
      if (need > 0) victims = candidates.slice(-need);
    }
    for (const v of victims) v.preempted = true;
    // Aborting runs the holder's listeners; any release they make re-enters pump(), which defers.
    for (const v of victims) v.ctrl.abort(new TypedAbort('preempted'));
  }

  /** The first interactive waiter (as boosts make it now), or -1. */
  const interactiveReady = (): number => queue.findIndex((w) => waiterPriority(w) === 'interactive');

  /** The first background waiter allowed to start, or -1. */
  function backgroundReady(): number {
    if (local && interactiveAbout()) return -1;
    return queue.findIndex((w) => waiterPriority(w) === 'background' && gateOpen(w.delayMs));
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
        if (holderPriority(h) === 'interactive') touch();
        pump();
      },
    };
  }

  function grant(w: Waiter): void {
    const h: Holder = { priority: w.priority, boost: w.boost, ctrl: new AbortController(), preempted: false, released: false };
    held.push(h);
    w.grant(makeSlot(h));
  }

  /** One pass: preempt what interactive work needs, then hand out free places in priority order. */
  function step(): void {
    preempt();
    while (held.length < capacity) {
      const next = interactiveReady();
      if (next >= 0) {
        grant(queue.splice(next, 1)[0]!);
        continue;
      }
      const at = backgroundReady();
      if (at < 0) break;
      grant(queue.splice(at, 1)[0]!);
      disarmUnused();
    }
  }

  let pumping = false;
  let again = false;
  /** Called after every change that can free a place, open a gate, move a boost or need a preemption. */
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

  function enqueue(priority: Priority, signal: AbortSignal | undefined, opts: AcquireOpts | undefined): Promise<Slot> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const delayMs = priority === 'background' ? delayMsOf(opts) : 0;
    const boost = opts?.boost;
    if (boost && isWatched(boost)) boost.watch(pump);
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
        boost,
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
  }

  return {
    get capacity() {
      return capacity;
    },
    local,
    inFlight: (priority?: Priority) => (priority === undefined ? held.length : heldOf(priority)),
    waiting: (priority?: Priority) => (priority === undefined ? queue.length : queuedAs(priority).length),
    lower(next: number) {
      // Excess holders keep their places; the smaller capacity applies as they release.
      capacity = Math.min(capacity, checkCapacity(next));
    },
    touch,
    acquire(priority: Priority, signal?: AbortSignal, opts?: AcquireOpts): Promise<Slot> {
      if (opts?.after === undefined) return enqueue(priority, signal, opts);
      const { after, ...rest } = opts;
      return settled(after, signal).then(() => enqueue(priority, signal, rest));
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

// ---- wrappers for a turn and a prefetch run -----------------------------------------------------

/** The scheduler `sched` with every acquire passed through `acquire` (capacity, locality and counts as they are). */
function mapAcquire(sched: Scheduler, acquire: (sem: OriginSemaphore, priority: Priority, signal?: AbortSignal, opts?: AcquireOpts) => Promise<Slot>): Scheduler {
  return {
    touch: (origin) => sched.touch(origin),
    forOrigin: (origin, capacity): OriginSemaphore => {
      const sem = sched.forOrigin(origin, capacity);
      return {
        get capacity() {
          return sem.capacity;
        },
        get local() {
          return sem.local;
        },
        inFlight: (priority) => sem.inFlight(priority),
        waiting: (priority) => sem.waiting(priority),
        acquire: (priority, signal, opts) => acquire(sem, priority, signal, opts),
      };
    },
  };
}

/** D-203: the scheduler a prefetch run's calls see: each of their requests carries `boost`. */
export function boosted(sched: Scheduler, boost: Boost): Scheduler {
  return mapAcquire(sched, (sem, priority, signal, opts) => sem.acquire(priority, signal, { ...opts, boost }));
}

/** D-203: Director-first on one place (ordered()). */
export interface Ordered {
  /** The scheduler the first party's calls see (the Director): its first acquire opens the order once the request is queued or holds a place. */
  readonly first: Scheduler;
  /** The scheduler the second party's calls see (recall): on a one-place origin every acquire waits until the order is open (AcquireOpts.after). */
  readonly second: Scheduler;
  /** Opens the order without the first party's request (it made no call: off, reused, refused, a key that failed). Idempotent. */
  open(): void;
}

/**
 * D-203: two parties started together (`Promise.allSettled`) whose requests go to one origin with a
 * single place: the first party's request enters the queue before the second's, so the first is served
 * first. The order does not depend on what each does before its acquire (a key command, a prompt
 * build). On an origin with more places the order does not apply (the lead's ruling K): the second
 * asks at once, never waiting for the first's work before its request. The caller opens it in a
 * `finally` of the first party's work, or the second waits for good (until its own signal aborts).
 */
export function ordered(sched: Scheduler): Ordered {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    first: mapAcquire(sched, (sem, priority, signal, opts) => {
      // Without an `after` of its own, acquire() queues the request (or grants it) synchronously.
      const queued = (rest: AcquireOpts | undefined): Promise<Slot> => {
        const slot = sem.acquire(priority, signal, rest);
        open();
        return slot;
      };
      if (opts?.after === undefined) return queued(opts);
      const { after, ...rest } = opts;
      return settled(after, signal).then(
        () => queued(rest),
        (reason: unknown) => {
          open();
          throw reason;
        },
      );
    }),
    second: mapAcquire(sched, (sem, priority, signal, opts) => {
      if (sem.capacity > 1) return sem.acquire(priority, signal, opts);
      const after = opts?.after === undefined ? opened : Promise.allSettled([opened, opts.after]);
      return sem.acquire(priority, signal, { ...opts, after });
    }),
    open: () => open(),
  };
}

// ---- locality (D-207) ---------------------------------------------------------------------------

/** What connectionLocality reads of a connection (api.ts Connection has all of it). */
export interface LocalityConnection {
  readonly origin: string;
  readonly local: boolean;
  /** A configured HTTP connection has one: its `local` is the config's flag when set, else the URL's guess. */
  readonly baseUrl?: string;
  /** An in-process provider may say its origin is local (the scripted provider's `localOrigin`). */
  readonly provider: object;
}

/** D-207: the locality one connection says for its origin, or undefined when it says none. */
export function declaredLocality(conn: LocalityConnection): boolean | undefined {
  if (conn.baseUrl !== undefined) return conn.local;
  const said = (conn.provider as { localOrigin?: unknown }).localOrigin;
  return typeof said === 'boolean' ? said : undefined;
}

/**
 * D-207: the scheduler's isLocal over the connections an engine knows (read when an origin is first
 * seen). A configured connection says it with `local`; an in-process one only when its provider says
 * so (a script's `"local"` line), so the test connections that set `local: true` on a `script:` origin
 * for windows and timeouts stay remote; with none, `fallback` (isLocalOrigin). Connections that
 * disagree: local wins (the local rules guard a server that runs one request at a time).
 */
export function connectionLocality(connections: () => Iterable<LocalityConnection>, fallback: (origin: string) => boolean = isLocalOrigin): (origin: string) => boolean {
  return (origin) => {
    let said: boolean | undefined;
    for (const conn of connections()) {
      if (conn.origin !== origin) continue;
      const one = declaredLocality(conn);
      if (one === true) return true;
      if (one === false) said = false;
    }
    return said ?? fallback(origin);
  };
}
