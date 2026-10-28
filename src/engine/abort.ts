// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The per-turn AbortSignal tree with typed reasons (ARCHITECTURE.md §6.8). A timeout is never
// reported as a Stop.
// CONTRACT FILE: signatures are fixed; the infra agent implements the bodies.

export type AbortReason =
  | 'user_stop'
  | 'timeout:first_byte'
  | 'timeout:idle'
  | 'budget:director'
  | 'budget:recall'
  /** M5b (D-172, C-12): the filing and historian agents' time budgets. */
  | 'budget:filing'
  | 'budget:historian'
  /** M5b (D-172): an interactive request took a background call's place (sched.ts). */
  | 'preempted'
  | 'superseded'
  | 'shutdown'
  | 'consumer_gone';

/** The value passed to controller.abort(): an Error carrying the typed reason. */
export class TypedAbort extends Error {
  readonly reason: AbortReason;
  constructor(reason: AbortReason) {
    super(`aborted: ${reason}`);
    this.name = 'AbortError';
    this.reason = reason;
  }
}

/** Injectable timer pair (the real globals by default; tests pass fakes). */
export interface DelayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** The host's timers. Wrapped so `this` and handle types never leak into callers. */
export const realTimers: DelayTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** A child controller that aborts (with the parent's reason) when the parent aborts. */
export function childController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  // The child carries the parent's reason object itself, so a TypedAbort stays the same instance
  // all the way down the tree and reasonOf() answers identically at every level.
  if (parent.aborted) {
    child.abort(parent.reason);
    return child;
  }
  const follow = (): void => child.abort(parent.reason);
  parent.addEventListener('abort', follow, { once: true });
  // A child that aborts on its own (a timeout, a budget) no longer needs to hear from the parent;
  // dropping the listener keeps a long-lived parent from collecting dead children.
  child.signal.addEventListener('abort', () => parent.removeEventListener('abort', follow), { once: true });
  return child;
}

/**
 * A second parent (M5b): `ctrl` aborts with `signal`'s reason when `signal` aborts (at once if it
 * already has). Returns the unlink; the link also drops itself once `ctrl` aborts on its own.
 */
export function linkAbort(ctrl: AbortController, signal: AbortSignal): () => void {
  if (signal.aborted) {
    ctrl.abort(signal.reason);
    return () => undefined;
  }
  const follow = (): void => ctrl.abort(signal.reason);
  const unlink = (): void => signal.removeEventListener('abort', follow);
  signal.addEventListener('abort', follow, { once: true });
  ctrl.signal.addEventListener('abort', unlink, { once: true });
  return unlink;
}

/** Abort with a typed reason. No-op if already aborted. */
export function abortWith(ctrl: AbortController, reason: AbortReason): void {
  // The first reason wins: a Stop that lands after a timeout must not rewrite why the call ended.
  if (ctrl.signal.aborted) return;
  ctrl.abort(new TypedAbort(reason));
}

/** The typed reason of an aborted signal, or null (not aborted, or aborted with a foreign value). */
export function reasonOf(signal: AbortSignal): AbortReason | null {
  if (!signal.aborted) return null;
  const r: unknown = signal.reason;
  return r instanceof TypedAbort ? r.reason : null;
}

/** Resolves after ms, rejects with the signal's TypedAbort if it aborts first. Timers injectable for tests. */
export function abortableDelay(
  ms: number,
  signal: AbortSignal,
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void },
): Promise<void> {
  const t = timers ?? realTimers;
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      t.clearTimeout(handle);
      reject(signal.reason);
    };
    const handle = t.setTimeout(() => {
      // Remove the listener on the happy path too: a turn signal outlives many delays.
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
