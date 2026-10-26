// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Event plumbing for the Engine (ARCHITECTURE.md §12.1): an unbounded async queue, the
// single-consumer iterable behind TurnHandle.events, and the broadcast bus behind engine.events().
// Everything lives on the Engine instance; there is no module-level state.

/** Unbounded FIFO with one reader. push() after end() is ignored. */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T, undefined>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const wake = this.waiters.shift();
    if (wake) wake({ value, done: false });
    else this.items.push(value);
  }

  /** No more values: readers drain what is buffered, then see done. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const wake of this.waiters.splice(0)) wake({ value: undefined, done: true });
  }

  /** Drop the buffer and end (the reader went away). */
  discard(): void {
    this.items.length = 0;
    this.end();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * An AsyncIterable over a queue that may be iterated once. A second iteration throws: two readers
 * would each see half the events, which is never what a caller meant.
 */
export function singleConsumer<T>(queue: EventQueue<T>, onClose?: () => void): AsyncIterable<T> {
  let taken = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
      if (taken) throw new Error('this event stream has a single consumer and is already being read');
      taken = true;
      return {
        next: () => queue.next(),
        return: async () => {
          // The reader left early (break): stop buffering for it.
          queue.discard();
          onClose?.();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** Fan-out to every live subscriber. Each subscriber sees events published after it subscribed. */
export class EventBus<T> {
  private readonly subs = new Set<EventQueue<T>>();
  private closed = false;

  publish(value: T): void {
    for (const q of this.subs) q.push(value);
  }

  /** A live tail starting now. Ends when the bus closes or the reader breaks out. */
  subscribe(): AsyncIterable<T> {
    const q = new EventQueue<T>();
    if (this.closed) q.end();
    else this.subs.add(q);
    return singleConsumer(q, () => this.subs.delete(q));
  }

  close(): void {
    this.closed = true;
    for (const q of this.subs) q.end();
    this.subs.clear();
  }
}
