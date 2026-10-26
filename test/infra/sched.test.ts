import { describe, expect, test } from 'bun:test';
import { abortWith, TypedAbort } from '../../src/engine/abort.ts';
import { createScheduler, type Slot } from '../../src/engine/sched.ts';
import { settle } from './fake-timers.ts';

/** Acquire and record the order in which grants arrive. */
function track(order: string[], label: string, p: Promise<Slot>): Promise<Slot> {
  return p.then((slot) => {
    order.push(label);
    return slot;
  });
}

describe('origin semaphore', () => {
  test('grants up to capacity, queues the rest, release wakes the next', async () => {
    const sem = createScheduler().forOrigin('http://localhost:8080', 2);
    const a = await sem.acquire('interactive');
    const b = await sem.acquire('interactive');
    expect(sem.inFlight()).toBe(2);
    let granted = false;
    const c = sem.acquire('interactive').then((s) => {
      granted = true;
      return s;
    });
    await settle();
    expect(granted).toBe(false);
    expect(sem.waiting()).toBe(1);
    a.release();
    const slot = await c;
    expect(granted).toBe(true);
    expect(sem.inFlight()).toBe(2);
    expect(sem.waiting()).toBe(0);
    b.release();
    slot.release();
    expect(sem.inFlight()).toBe(0);
  });

  test('FIFO within a priority; interactive overtakes background', async () => {
    const sem = createScheduler().forOrigin('script:x', 1);
    const holder = await sem.acquire('background');
    const order: string[] = [];
    const bg1 = track(order, 'bg1', sem.acquire('background'));
    const bg2 = track(order, 'bg2', sem.acquire('background'));
    const int1 = track(order, 'int1', sem.acquire('interactive'));
    const int2 = track(order, 'int2', sem.acquire('interactive'));
    expect(sem.waiting()).toBe(4);
    holder.release();
    (await int1).release();
    (await int2).release();
    (await bg1).release();
    (await bg2).release();
    expect(order).toEqual(['int1', 'int2', 'bg1', 'bg2']);
    expect(sem.inFlight()).toBe(0);
  });

  test('abort while waiting rejects with the TypedAbort and leaves the queue', async () => {
    const sem = createScheduler().forOrigin('script:x', 1);
    const holder = await sem.acquire('interactive');
    const ctl = new AbortController();
    const order: string[] = [];
    const doomed = sem.acquire('interactive', ctl.signal);
    const next = track(order, 'next', sem.acquire('interactive'));
    expect(sem.waiting()).toBe(2);
    abortWith(ctl, 'user_stop');
    const err = await doomed.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypedAbort);
    expect((err as TypedAbort).reason).toBe('user_stop');
    expect(sem.waiting()).toBe(1);
    holder.release();
    (await next).release();
    expect(order).toEqual(['next']);
    expect(sem.inFlight()).toBe(0);
  });

  test('an already aborted signal is refused without taking a place', async () => {
    const sem = createScheduler().forOrigin('script:x', 1);
    const ctl = new AbortController();
    abortWith(ctl, 'shutdown');
    const err = await sem.acquire('interactive', ctl.signal).catch((e: unknown) => e);
    expect((err as TypedAbort).reason).toBe('shutdown');
    expect(sem.inFlight()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  test('aborting after the grant changes nothing: the holder still owns the place', async () => {
    const sem = createScheduler().forOrigin('script:x', 1);
    const ctl = new AbortController();
    const slot = await sem.acquire('interactive', ctl.signal);
    abortWith(ctl, 'user_stop');
    expect(sem.inFlight()).toBe(1);
    slot.release();
    expect(sem.inFlight()).toBe(0);
  });

  test('release is idempotent', async () => {
    const sem = createScheduler().forOrigin('script:x', 1);
    const a = await sem.acquire('interactive');
    const order: string[] = [];
    const b = track(order, 'b', sem.acquire('interactive'));
    const c = track(order, 'c', sem.acquire('interactive'));
    a.release();
    a.release();
    await settle();
    expect(order).toEqual(['b']);
    expect(sem.inFlight()).toBe(1);
    expect(sem.waiting()).toBe(1);
    const sb = await b;
    sb.release();
    sb.release();
    (await c).release();
    expect(sem.inFlight()).toBe(0);
  });
});

describe('scheduler', () => {
  test('one semaphore per origin; the first capacity holds unless a smaller one comes', () => {
    const sched = createScheduler();
    const a = sched.forOrigin('http://127.0.0.1:5001', 4);
    expect(a.capacity).toBe(4);
    expect(sched.forOrigin('http://127.0.0.1:5001', 8)).toBe(a);
    expect(a.capacity).toBe(4);
    sched.forOrigin('http://127.0.0.1:5001', 2);
    expect(a.capacity).toBe(2);
    const other = sched.forOrigin('https://api.example.com:443', 1);
    expect(other).not.toBe(a);
    expect(other.capacity).toBe(1);
  });

  test('lowering below the places in use waits for holders to drain', async () => {
    const sched = createScheduler();
    const sem = sched.forOrigin('script:x', 2);
    const a = await sem.acquire('interactive');
    const b = await sem.acquire('interactive');
    sched.forOrigin('script:x', 1);
    let granted = false;
    const c = sem.acquire('interactive').then((s) => {
      granted = true;
      return s;
    });
    a.release();
    await settle();
    expect(granted).toBe(false);
    b.release();
    (await c).release();
    expect(granted).toBe(true);
  });

  test('a capacity that is not a positive integer is refused', () => {
    const sched = createScheduler();
    expect(() => sched.forOrigin('a', 0)).toThrow(RangeError);
    expect(() => sched.forOrigin('b', 1.5)).toThrow(RangeError);
    expect(() => sched.forOrigin('c', Number.NaN)).toThrow(RangeError);
  });
});
