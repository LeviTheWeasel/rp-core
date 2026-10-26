// Manual timers for the infra tests: nothing fires until advance() moves the fake clock.

export interface FakeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** Run every timer due within `ms`, earliest first (ties in creation order), then move the clock. */
  advance(ms: number): void;
  /** Timers scheduled and not yet fired or cleared. */
  pending(): number;
  now(): number;
}

export function fakeTimers(): FakeTimers {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
    now: () => now,
  };
}

/** Let pending promise continuations run (a macrotask turn drains the microtask queue). */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
