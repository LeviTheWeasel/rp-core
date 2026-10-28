// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c scheduler (D-203, the grace wait): a boost lifts a prefetch's requests, queued or held, to
// interactive and back.
import { describe, expect, test } from 'bun:test';
import { reasonOf } from '../../src/engine/abort.ts';
import { boosted, createBoost, createScheduler, type Slot } from '../../src/engine/sched.ts';
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

describe('a boost', () => {
  test('starts demoted; promote and demote are idempotent', () => {
    const boost = createBoost();
    expect(boost.promoted).toBe(false);
    boost.promote();
    boost.promote();
    expect(boost.promoted).toBe(true);
    boost.demote();
    boost.demote();
    expect(boost.promoted).toBe(false);
  });
});

describe('a held prefetch', () => {
  test('remote, one place: promoted, it is not preempted; the interactive request waits; demoted, it is preempted at once', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const boost = createBoost();
    const pre = await sem.acquire('background', undefined, { boost });
    boost.promote();
    expect(sem.inFlight('interactive')).toBe(1);
    expect(sem.inFlight('background')).toBe(0);
    const dir = pending(sem.acquire('interactive'));
    await settle();
    expect(pre.signal.aborted).toBe(false);
    expect(dir.got()).toBeNull();
    // A Stop of the wait: back to background, and the waiting interactive request takes it over.
    boost.demote();
    expect(reasonOf(pre.signal)).toBe('preempted');
    pre.release();
    (await dir.slot).release();
    expect(sem.inFlight()).toBe(0);
  });

  test('remote: promoted, it leaves an interactive request a free place alone (no preemption when one is free)', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 2);
    const boost = createBoost();
    const pre = await sem.acquire('background', undefined, { boost });
    boost.promote();
    const dir = await sem.acquire('interactive');
    boost.demote();
    expect(pre.signal.aborted).toBe(false);
    dir.release();
    pre.release();
  });

  test('local: an interactive request preempts the filing pass but not the promoted prefetch (T6)', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 2);
    const boost = createBoost();
    const filing = await sem.acquire('background');
    const pre = await sem.acquire('background', undefined, { boost });
    boost.promote();
    // The promotion alone is interactive work about: the filing pass is preempted already.
    expect(reasonOf(filing.signal)).toBe('preempted');
    filing.release();
    const narrator = await sem.acquire('interactive');
    expect(pre.signal.aborted).toBe(false);
    narrator.release();
    pre.release();
  });

  test('local: promoted, it keeps other background off; demoted with nothing interactive about, it runs on beside it', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 2);
    const boost = createBoost();
    const pre = await sem.acquire('background', undefined, { boost });
    boost.promote();
    const filing = pending(sem.acquire('background'));
    await settle();
    expect(filing.got()).toBeNull();
    expect(sem.waiting('background')).toBe(1);
    boost.demote();
    const slot = await filing.slot;
    expect(pre.signal.aborted).toBe(false);
    expect(sem.inFlight('background')).toBe(2);
    slot.release();
    pre.release();
  });

  test('local: demoted while an interactive request is queued, it is preempted at once', async () => {
    const sem = createScheduler().forOrigin(LOCAL, 1);
    const boost = createBoost();
    const pre = await sem.acquire('background', undefined, { boost });
    boost.promote();
    const dir = pending(sem.acquire('interactive'));
    await settle();
    expect(pre.signal.aborted).toBe(false);
    boost.demote();
    expect(reasonOf(pre.signal)).toBe('preempted');
    pre.release();
    (await dir.slot).release();
  });

  test('a holder preempted before the promotion stays preempted and counts as background', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const boost = createBoost();
    const pre = await sem.acquire('background', undefined, { boost });
    const dir = pending(sem.acquire('interactive'));
    expect(reasonOf(pre.signal)).toBe('preempted');
    boost.promote();
    expect(sem.inFlight('background')).toBe(1);
    expect(sem.inFlight('interactive')).toBe(0);
    pre.release();
    (await dir.slot).release();
  });

  test('local: the release of a promoted holder is activity on the origin (the idle gate starts again)', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 2);
    const boost = createBoost();
    const pre = await sem.acquire('background', undefined, { boost });
    boost.promote();
    timers.advance(5_000);
    pre.release();
    const filing = pending(sem.acquire('background', undefined, { idleDelaySec: 8 }));
    timers.advance(7_999);
    await settle();
    expect(filing.got()).toBeNull();
    timers.advance(1);
    (await filing.slot).release();
  });
});

describe('a queued prefetch', () => {
  test('local: promoted, it passes the idle gate and takes the free place at once; counts move with it', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    sched.touch(LOCAL);
    const boost = createBoost();
    const pre = pending(sem.acquire('background', undefined, { idleDelaySec: 8, boost }));
    await settle();
    expect(pre.got()).toBeNull();
    expect(sem.waiting('background')).toBe(1);
    timers.advance(2_000);
    boost.promote();
    const slot = await pre.slot;
    expect(sem.inFlight('interactive')).toBe(1);
    expect(sem.waiting()).toBe(0);
    slot.release();
  });

  test('promoted, it is served with the interactive requests in arrival order (before a later Director request)', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const boost = createBoost();
    const holder = await sem.acquire('interactive');
    const order: string[] = [];
    const pre = sem.acquire('background', undefined, { boost }).then((s) => (order.push('prefetch'), s));
    const dir = sem.acquire('interactive').then((s) => (order.push('director'), s));
    expect([sem.waiting('interactive'), sem.waiting('background')]).toEqual([1, 1]);
    boost.promote();
    expect([sem.waiting('interactive'), sem.waiting('background')]).toEqual([2, 0]);
    holder.release();
    (await pre).release();
    (await dir).release();
    expect(order).toEqual(['prefetch', 'director']);
  });

  test('not promoted, a later interactive request still overtakes it (M5b unchanged)', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const boost = createBoost();
    const holder = await sem.acquire('interactive');
    const order: string[] = [];
    const pre = sem.acquire('background', undefined, { boost }).then((s) => (order.push('prefetch'), s));
    const dir = sem.acquire('interactive').then((s) => (order.push('director'), s));
    holder.release();
    (await dir).release();
    (await pre).release();
    expect(order).toEqual(['director', 'prefetch']);
  });

  test('local: promoted, it preempts a running filing pass like any interactive request', async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    const filing = await sem.acquire('background');
    sched.touch(LOCAL);
    const boost = createBoost();
    const pre = pending(sem.acquire('background', undefined, { idleDelaySec: 8, boost }));
    await settle();
    expect(filing.signal.aborted).toBe(false);
    boost.promote();
    expect(reasonOf(filing.signal)).toBe('preempted');
    filing.release();
    (await pre.slot).release();
  });

  test("local: demoted again, it waits behind the idle gate from its arrival, not from the demotion", async () => {
    const timers = fakeTimers();
    const sched = createScheduler({ timers });
    const sem = sched.forOrigin(LOCAL, 1);
    const filing = await sem.acquire('background');
    sched.touch(LOCAL);
    const boost = createBoost();
    const pre = pending(sem.acquire('background', undefined, { idleDelaySec: 8, boost }));
    timers.advance(2_000);
    boost.promote();
    expect(reasonOf(filing.signal)).toBe('preempted');
    timers.advance(1_000);
    boost.demote();
    // The preempted filing pass gives its place back (a background release is no touch).
    filing.release();
    timers.advance(4_999);
    await settle();
    expect(pre.got()).toBeNull();
    expect(sem.waiting('background')).toBe(1);
    timers.advance(1);
    (await pre.slot).release();
  });

  test('an abort while promoted leaves the queue; the place goes to the next waiter', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const boost = createBoost();
    const holder = await sem.acquire('interactive');
    const stop = new AbortController();
    const pre = sem.acquire('background', stop.signal, { boost }).catch((e: unknown) => e);
    const dir = pending(sem.acquire('interactive'));
    boost.promote();
    stop.abort(new Error('gone'));
    expect(((await pre) as Error).message).toBe('gone');
    expect(sem.waiting()).toBe(1);
    holder.release();
    (await dir.slot).release();
    expect(sem.inFlight()).toBe(0);
  });
});

describe('one boost, several requests', () => {
  test('it lifts the requests of a run on two origins at once', async () => {
    const sched = createScheduler();
    const a = sched.forOrigin(REMOTE, 1);
    const b = sched.forOrigin('https://other.example.com:443', 1);
    const boost = createBoost();
    const ha = await a.acquire('interactive');
    const hb = await b.acquire('interactive');
    a.acquire('background', undefined, { boost }).then((s) => s.release());
    b.acquire('background', undefined, { boost }).then((s) => s.release());
    boost.promote();
    expect([a.waiting('interactive'), b.waiting('interactive')]).toEqual([1, 1]);
    boost.demote();
    expect([a.waiting('background'), b.waiting('background')]).toEqual([1, 1]);
    ha.release();
    hb.release();
    await settle();
    expect([a.inFlight(), b.inFlight()]).toEqual([0, 0]);
  });

  test('boosted(): every acquire through it carries the boost; capacity, locality and counts pass through', async () => {
    const sched = createScheduler();
    const boost = createBoost();
    const run = boosted(sched, boost);
    const sem = run.forOrigin(LOCAL, 2);
    expect(sem.capacity).toBe(2);
    expect(sem.local).toBe(true);
    const pre = await sem.acquire('background');
    boost.promote();
    expect(sem.inFlight('interactive')).toBe(1);
    const narrator = await sched.forOrigin(LOCAL, 2).acquire('interactive');
    expect(pre.signal.aborted).toBe(false);
    expect(sem.inFlight()).toBe(2);
    narrator.release();
    pre.release();
    expect(sem.waiting()).toBe(0);
  });
});
