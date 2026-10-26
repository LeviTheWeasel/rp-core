// Ported from Bunraku:src/ui/server-chats-turn.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (coalesceTurnEvents).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Delta coalescing for the JSONL writers [D-36] (§12.2): text/reasoning deltas are merged into
// one frame every 40 ms or 768 chars per (session, turn, type); any other event first flushes the
// pending batch. Port of Bunraku coalesceTurnEvents (src/ui/server-chats-turn.ts:43-104).
// CONTRACT FILE: signature is fixed; the infra agent implements the body.
//
// Changes from Bunraku: no `full` variant (the authoritative text arrives in done/stopped/failed);
// several batches may be open at once, one per (session, turn, type), so concurrent sessions on one
// writer still coalesce; a delta merges only when its offset continues the batch exactly; the
// timer and both thresholds are injectable.
//
// Ordering guarantees: a frame never jumps over a non-delta event, and within one turn frames come
// out in arrival order (switching between text and reasoning closes the other batch first). Only
// deltas of different turns may be reordered relative to each other, which offset-based clients
// do not notice.

import type { Event } from './events.ts';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Coalescer {
  push(ev: Event): void;
  /** Emit everything pending now. */
  flush(): void;
  /** Flush and stop timers. */
  close(): void;
}

/** Frame cadence from §12.2 (the same figures Bunraku tuned in its perf pass). */
export const COALESCE_MS = 40;
export const COALESCE_CHARS = 768;

type DeltaEvent = Extract<Event, { type: 'text' | 'reasoning' }>;

interface Batch {
  /** The first delta of the batch: the frame keeps its session, turn, ts and offset. */
  head: DeltaEvent;
  /** Merged pieces, joined once on emit. */
  parts: string[];
  chars: number;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function isDelta(ev: Event): ev is DeltaEvent {
  return ev.type === 'text' || ev.type === 'reasoning';
}

// JSON-encoded parts so no session/turn id can collide with another through a separator.
function turnKey(ev: DeltaEvent): string {
  return JSON.stringify([ev.sessionId, ev.turnId]);
}
function batchKey(ev: DeltaEvent): string {
  return JSON.stringify([ev.sessionId, ev.turnId, ev.type]);
}

export function createCoalescer(
  emit: (ev: Event) => void,
  opts?: { ms?: number; chars?: number; timers?: Timers },
): Coalescer {
  const ms = opts?.ms ?? COALESCE_MS;
  const maxChars = opts?.chars ?? COALESCE_CHARS;
  const timers = opts?.timers ?? defaultTimers;
  // Map iteration order is insertion order: batches flush in the order they were opened.
  const pending = new Map<string, Batch>();
  let timer: unknown = null;
  let closed = false;

  function stopTimer(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  /** Emit one batch as a single frame. The batch leaves the map before emit, so re-entry is safe. */
  function emitBatch(key: string, batch: Batch): void {
    pending.delete(key);
    if (pending.size === 0) stopTimer();
    emit({ ...batch.head, delta: batch.parts.join('') });
  }

  function flush(): void {
    stopTimer();
    for (const [key, batch] of [...pending]) emitBatch(key, batch);
  }

  function onTimer(): void {
    timer = null;
    flush();
  }

  function push(ev: Event): void {
    if (closed || !isDelta(ev)) {
      // Every other event ends or redirects a turn: pending text goes first, then this event,
      // immediately. After close() nothing is held back any more.
      flush();
      emit(ev);
      return;
    }
    // Text and reasoning of one turn are two streams with one batch open at a time: a delta of the
    // other kind flushes what is pending first, so the turn's frames keep their arrival order (as
    // Bunraku's single `kind` did).
    const turn = turnKey(ev);
    for (const batch of pending.values()) {
      if (batch.head.type !== ev.type && turnKey(batch.head) === turn) {
        flush();
        break;
      }
    }
    const key = batchKey(ev);
    const open = pending.get(key);
    if (open && ev.offset === open.head.offset + open.chars) {
      open.parts.push(ev.delta);
      open.chars += ev.delta.length;
    } else {
      // A gap or an overlap: merging would put text at the wrong offset, so the open batch goes
      // out as it is and this delta starts a new one.
      if (open) emitBatch(key, open);
      pending.set(key, { head: ev, parts: [ev.delta], chars: ev.delta.length });
    }
    const batch = pending.get(key);
    if (batch && batch.chars >= maxChars) {
      emitBatch(key, batch);
      return;
    }
    // A throttle, not a debounce: the timer starts with the first pending delta and later deltas
    // never push it back, so a steady stream still produces a frame every `ms`.
    if (timer === null && pending.size > 0) timer = timers.setTimeout(onTimer, ms);
  }

  return {
    push,
    flush,
    close() {
      flush();
      closed = true;
    },
  };
}
