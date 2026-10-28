// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b scheduler (D-172): preemption, the local-origin rule, the idle gate.
import { describe, expect, test } from 'bun:test';
import { reasonOf, TypedAbort, abortWith } from '../../src/engine/abort.ts';
import { createScheduler, STARVED_AFTER, type Slot } from '../../src/engine/sched.ts';
import { fakeTimers, settle } from '../infra/fake-timers.ts';

const LOCAL = 'http://127.0.0.1:8080';
const REMOTE = 'https://api.example.com:443';

/** An acquire whose grant is observable without awaiting it. */
function pending(p: Promise<Slot>): { got: () => Slot | null; slot: Promise<Slot> } {
  let slot: Slot | null = null;
  const tracked = p.then((s) => {
    slot = s;
    return s;
  });
  return { got: () => slot, slot: tracked };
}

describe('locality', () => {
  test('isLocalOrigin decides; script: origins are remote; an injected rule wins', () => {
    const sched = createScheduler();
    expect(sched.forOrigin(LOCAL, 1).local).toBe(true);
    expect(sched.forOrigin('http://localhost:11434', 1).local).toBe(true);
    expect(sched.forOrigin(REMOTE, 4).local).toBe(false);
    expect(sched.forOrigin('script:fixtures/x.json', 1).local).toBe(false);
    const custom = createScheduler({ isLocal: (o) => o === 'script:gpu' });
    expect(custom.forOrigin('script:gpu', 1).local).toBe(true);
    expect(custom.forOrigin(LOCAL, 1).local).toBe(false);
  });

  test('STARVED_AFTER is three preemptions in a row', () => {
    expect(STARVED_AFTER).toBe(3);
  });
});

describe('preemption on a remote origin', () => {
  test('capacity 1: an interactive request preempts the background holder and gets the place once it is released', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const bg = await sem.acquire('background');
    expect(bg.signal.aborted).toBe(false);
    const int = pending(sem.acquire('interactive'));
    // Preempted at once; the place stays the holder's until it lets go (never two requests at once).
    expect(bg.signal.aborted).toBe(true);
    expect(reasonOf(bg.signal)).toBe('preempted');
    expect(bg.signal.reason).toBeInstanceOf(TypedAbort);
    await settle();
    expect(int.got()).toBeNull();
    expect(sem.inFlight()).toBe(1);
    expect(sem.inFlight('background')).toBe(1);
    expect(sem.waiting('interactive')).toBe(1);
    bg.release();
    const slot = await int.slot;
    expect(sem.inFlight('interactive')).toBe(1);
    expect(sem.inFlight('background')).toBe(0);
    expect(slot.signal.aborted).toBe(false);
    slot.release();
    bg.release();
    expect(sem.inFlight()).toBe(0);
  });

  test('a free place: background runs alongside, nobody is preempted', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 2);
    const bg = await sem.acquire('background');
    const int = await sem.acquire('interactive');
    expect(bg.signal.aborted).toBe(false);
    expect(sem.inFlight()).toBe(2);
    int.release();
    bg.release();
  });

  test('the most recent background holder goes first; one per interactive request that cannot be served', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 3);
    const older = await sem.acquire('background');
    const newer = await sem.acquire('background');
    const int1 = await sem.acquire('interactive');
    expect([older.signal.aborted, newer.signal.aborted]).toEqual([false, false]);
    const int2 = pending(sem.acquire('interactive'));
    expect([older.signal.aborted, newer.signal.aborted]).toEqual([false, true]);
    // A second waiter while the first one's place is still on its way back takes the next holder.
    const int3 = pending(sem.acquire('interactive'));
    expect([older.signal.aborted, newer.signal.aborted]).toEqual([true, true]);
    newer.release();
    expect((await int2.slot).signal.aborted).toBe(false);
    expect(int3.got()).toBeNull();
    older.release();
    await int3.slot;
    expect(sem.inFlight('interactive')).toBe(3);
    int1.release();
  });

  test('interactive holders are never preempted', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const int = await sem.acquire('interactive');
    const next = pending(sem.acquire('interactive'));
    await settle();
    expect(int.signal.aborted).toBe(false);
    expect(next.got()).toBeNull();
    int.release();
    (await next.slot).release();
  });

  test('interactive overtakes queued background', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const holder = await sem.acquire('interactive');
    const order: string[] = [];
    const bg = sem.acquire('background').then((s) => (order.push('bg'), s));
    const int = sem.acquire('interactive').then((s) => (order.push('int'), s));
    holder.release();
    (await int).release();
    (await bg).release();
    expect(order).toEqual(['int', 'bg']);
  });

  test('a preempted slot released twice frees one place', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const bg = await sem.acquire('background');
    const int = sem.acquire('interactive');
    bg.release();
    bg.release();
    const slot = await int;
    expect(sem.inFlight()).toBe(1);
    slot.release();
    expect(sem.inFlight()).toBe(0);
  });

  test('remote origins ignore the idle gate', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(REMOTE, 2);
    sched.touch(REMOTE);
    const bg = await sem.acquire('background', undefined, { idleDelaySec: 8 });
    expect(timers.pending()).toBe(0);
    bg.release();
  });
});

describe('the local-origin rule', () => {
  test('an interactive request preempts background even with a free place, and starts at once', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 2);
    const bg = await sem.acquire('background');
    const int = await sem.acquire('interactive');
    expect(reasonOf(bg.signal)).toBe('preempted');
    expect(int.signal.aborted).toBe(false);
    expect(sem.inFlight()).toBe(2);
    bg.release();
    int.release();
  });

  test('every background holder is preempted', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 3);
    const a = await sem.acquire('background');
    const b = await sem.acquire('background');
    const int = await sem.acquire('interactive');
    expect([reasonOf(a.signal), reasonOf(b.signal)]).toEqual(['preempted', 'preempted']);
    a.release();
    b.release();
    int.release();
  });

  test('background waits while an interactive request is in flight or queued, even with free places', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 2);
    const int = await sem.acquire('interactive');
    const bg = pending(sem.acquire('background'));
    await settle();
    expect(bg.got()).toBeNull();
    expect(sem.waiting('background')).toBe(1);
    int.release();
    const slot = await bg.slot;
    expect(sem.inFlight('background')).toBe(1);
    slot.release();
  });

  test('a queued interactive request keeps background out', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 1);
    const holder = await sem.acquire('interactive');
    const queued = sem.acquire('interactive');
    const bg = pending(sem.acquire('background'));
    // The holder leaves; the queued interactive request takes the place, background still waits.
    holder.release();
    const int = await queued;
    await settle();
    expect(bg.got()).toBeNull();
    int.release();
    (await bg.slot).release();
  });

  test('an interactive request withdrawn from the queue lets background have the place', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 1);
    const old = await sem.acquire('background');
    const stop = new AbortController();
    const doomed = sem.acquire('interactive', stop.signal).catch((e: unknown) => e);
    expect(reasonOf(old.signal)).toBe('preempted');
    const bg = pending(sem.acquire('background'));
    abortWith(stop, 'user_stop');
    expect(((await doomed) as TypedAbort).reason).toBe('user_stop');
    await settle();
    expect(bg.got()).toBeNull();
    // The preempted holder leaves: with no interactive request about, the place goes to background.
    old.release();
    (await bg.slot).release();
    expect(sem.inFlight()).toBe(0);
  });
});

describe('the idle gate', () => {
  test('background waits idleDelaySec after the last touch; a touch starts the wait again', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    sched.touch(LOCAL);
    const bg = pending(sem.acquire('background', undefined, { idleDelaySec: 8 }));
    timers.advance(5_000);
    await settle();
    expect(bg.got()).toBeNull();
    sched.touch(LOCAL);
    timers.advance(7_999);
    await settle();
    expect(bg.got()).toBeNull();
    timers.advance(1);
    const slot = await bg.slot;
    expect(timers.pending()).toBe(0);
    slot.release();
  });

  test('a passed wait lets the next request of that delay start at once, until the next touch', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    sched.touch(LOCAL);
    const first = pending(sem.acquire('background', undefined, { idleDelaySec: 2 }));
    timers.advance(2_000);
    (await first.slot).release();
    (await sem.acquire('background', undefined, { idleDelaySec: 2 })).release();
    sched.touch(LOCAL);
    const later = pending(sem.acquire('background', undefined, { idleDelaySec: 2 }));
    await settle();
    expect(later.got()).toBeNull();
    timers.advance(2_000);
    (await later.slot).release();
  });

  test('each request waits its own session delay', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 2);
    sched.touch(LOCAL);
    const slow = pending(sem.acquire('background', undefined, { idleDelaySec: 8 }));
    const quick = pending(sem.acquire('background', undefined, { idleDelaySec: 1 }));
    timers.advance(1_000);
    await settle();
    expect(quick.got()).not.toBeNull();
    expect(slow.got()).toBeNull();
    timers.advance(7_000);
    await settle();
    expect(slow.got()).not.toBeNull();
    (await slow.slot).release();
    (await quick.slot).release();
  });

  test('idleDelaySec 0 or absent never waits; a never-touched origin is open', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    (await sem.acquire('background', undefined, { idleDelaySec: 8 })).release();
    sched.touch(LOCAL);
    (await sem.acquire('background', undefined, { idleDelaySec: 0 })).release();
    (await sem.acquire('background')).release();
    expect(timers.pending()).toBe(0);
  });

  test('a touch before the first call counts', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    sched.touch(LOCAL);
    const sem = sched.forOrigin(LOCAL, 1);
    const bg = pending(sem.acquire('background', undefined, { idleDelaySec: 3 }));
    await settle();
    expect(bg.got()).toBeNull();
    timers.advance(3_000);
    (await bg.slot).release();
  });

  test('the end of an interactive request is a touch', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    const int = await sem.acquire('interactive');
    const bg = pending(sem.acquire('background', undefined, { idleDelaySec: 4 }));
    timers.advance(10_000);
    await settle();
    expect(bg.got()).toBeNull();
    int.release();
    timers.advance(3_999);
    await settle();
    expect(bg.got()).toBeNull();
    timers.advance(1);
    (await bg.slot).release();
  });

  test('a background request aborted while gated leaves no timer behind', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    sched.touch(LOCAL);
    const ctl = new AbortController();
    const doomed = sem.acquire('background', ctl.signal, { idleDelaySec: 8 }).catch((e: unknown) => e);
    expect(timers.pending()).toBe(1);
    abortWith(ctl, 'shutdown');
    expect(((await doomed) as TypedAbort).reason).toBe('shutdown');
    expect(timers.pending()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  test('an open gate still waits for interactive work to end', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 2);
    sched.touch(LOCAL);
    const bg = pending(sem.acquire('background', undefined, { idleDelaySec: 1 }));
    const int = await sem.acquire('interactive');
    timers.advance(1_000);
    await settle();
    expect(bg.got()).toBeNull();
    int.release();
    timers.advance(1_000);
    (await bg.slot).release();
  });
});
