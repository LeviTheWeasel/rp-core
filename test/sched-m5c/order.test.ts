// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c scheduler (D-203, Director-first on one place): `after` keeps a request out of the queue until a
// promise settles; ordered() gives the Director and recall schedulers whose requests queue in that order.
import { describe, expect, test } from 'bun:test';
import { abortWith, TypedAbort } from '../../src/engine/abort.ts';
import { createScheduler, ordered, type Slot } from '../../src/engine/sched.ts';
import { settle } from '../infra/fake-timers.ts';

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

/** A promise and its settlers. */
function gate(): { promise: Promise<void>; open(): void; fail(): void } {
  let open!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new Error('no'));
  });
  return { promise, open, fail };
}

describe('AcquireOpts.after', () => {
  test('the request is not queued until `after` settles; then it is served as any other', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const g = gate();
    const req = pending(sem.acquire('interactive', undefined, { after: g.promise }));
    await settle();
    expect(req.got()).toBeNull();
    expect(sem.waiting()).toBe(0);
    expect(sem.inFlight()).toBe(0);
    g.open();
    (await req.slot).release();
  });

  test('a rejected `after` lets the request go on all the same', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const g = gate();
    const req = sem.acquire('interactive', undefined, { after: g.promise });
    g.fail();
    (await req).release();
    expect(sem.inFlight()).toBe(0);
  });

  test('a request that waits for `after` comes behind one queued meanwhile', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const holder = await sem.acquire('interactive');
    const g = gate();
    const order: string[] = [];
    const late = sem.acquire('interactive', undefined, { after: g.promise }).then((s) => (order.push('late'), s));
    const early = sem.acquire('interactive').then((s) => (order.push('early'), s));
    g.open();
    await settle();
    holder.release();
    (await early).release();
    (await late).release();
    expect(order).toEqual(['early', 'late']);
  });

  test('a Stop while waiting rejects with its reason and never takes a place', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const g = gate();
    const stop = new AbortController();
    const req = sem.acquire('interactive', stop.signal, { after: g.promise }).catch((e: unknown) => e);
    abortWith(stop, 'user_stop');
    const err = await req;
    expect(err).toBeInstanceOf(TypedAbort);
    expect((err as TypedAbort).reason).toBe('user_stop');
    g.open();
    await settle();
    expect(sem.inFlight()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  test('an already aborted signal rejects at once', async () => {
    const sem = createScheduler().forOrigin(REMOTE, 1);
    const stop = new AbortController();
    abortWith(stop, 'user_stop');
    const err = await sem.acquire('interactive', stop.signal, { after: Promise.resolve() }).catch((e: unknown) => e);
    expect((err as TypedAbort).reason).toBe('user_stop');
  });

  test('a background request keeps its idle-gate options through the wait', async () => {
    const sched = createScheduler();
    const sem = sched.forOrigin(REMOTE, 1);
    const bg = await sem.acquire('background', undefined, { after: Promise.resolve(), idleDelaySec: 8 });
    expect(sem.inFlight('background')).toBe(1);
    bg.release();
  });
});

describe('ordered(): Director-first on one place', () => {
  test('one place: recall asks first, the Director still gets the place first and recall after it', async () => {
    const sched = createScheduler();
    const order = ordered(sched);
    const got: string[] = [];
    // Recall's acquire happens first (its prompt was quicker to build than the Director's key command).
    const recall = order.second
      .forOrigin(REMOTE, 1)
      .acquire('interactive')
      .then((s) => (got.push('recall'), s));
    await settle();
    expect(got).toEqual([]);
    const director = await order.first.forOrigin(REMOTE, 1).acquire('interactive');
    got.push('director');
    await settle();
    expect(got).toEqual(['director']);
    director.release();
    (await recall).release();
    expect(got).toEqual(['director', 'recall']);
  });

  test('two places: both run alongside once the Director has queued', async () => {
    const sched = createScheduler();
    const order = ordered(sched);
    const recall = order.second.forOrigin(REMOTE, 2).acquire('interactive');
    const director = await order.first.forOrigin(REMOTE, 2).acquire('interactive');
    const r = await recall;
    expect(sched.forOrigin(REMOTE, 2).inFlight('interactive')).toBe(2);
    director.release();
    r.release();
  });

  test("two places (ruling K): recall is not held back by the Director's work before its acquire", async () => {
    const sched = createScheduler();
    const order = ordered(sched);
    // The Director is still resolving its key: it has not asked yet.
    const recall = pending(order.second.forOrigin(REMOTE, 2).acquire('interactive'));
    await settle();
    expect(recall.got()).not.toBeNull();
    const director = await order.first.forOrigin(REMOTE, 2).acquire('interactive');
    expect(sched.forOrigin(REMOTE, 2).inFlight('interactive')).toBe(2);
    director.release();
    (await recall.slot).release();
  });

  test('a local origin with a filing pass: the Director preempts it and goes first; recall follows', async () => {
    const sched = createScheduler();
    const sem = sched.forOrigin(LOCAL, 1);
    const filing = await sem.acquire('background');
    const order = ordered(sched);
    const got: string[] = [];
    const recall = order.second
      .forOrigin(LOCAL, 1)
      .acquire('interactive')
      .then((s) => (got.push('recall'), s));
    const director = order.first
      .forOrigin(LOCAL, 1)
      .acquire('interactive')
      .then((s) => (got.push('director'), s));
    await settle();
    expect(filing.signal.aborted).toBe(true);
    filing.release();
    (await director).release();
    (await recall).release();
    expect(got).toEqual(['director', 'recall']);
  });

  test('open() lets recall go when the Director makes no call; it is idempotent', async () => {
    const order = ordered(createScheduler());
    const recall = pending(order.second.forOrigin(REMOTE, 1).acquire('interactive'));
    await settle();
    expect(recall.got()).toBeNull();
    order.open();
    order.open();
    (await recall.slot).release();
    // Once open, later acquires do not wait.
    (await order.second.forOrigin(REMOTE, 1).acquire('interactive')).release();
  });

  test("a Director stopped in the queue still opens the order", async () => {
    const sched = createScheduler();
    const sem = sched.forOrigin(REMOTE, 1);
    const holder = await sem.acquire('interactive');
    const order = ordered(sched);
    const stop = new AbortController();
    const director = order.first.forOrigin(REMOTE, 1).acquire('interactive', stop.signal).catch((e: unknown) => e);
    const recall = pending(order.second.forOrigin(REMOTE, 1).acquire('interactive'));
    abortWith(stop, 'user_stop');
    expect(((await director) as TypedAbort).reason).toBe('user_stop');
    holder.release();
    (await recall.slot).release();
  });

  test("the Director's own `after` is honoured: the order opens when its request is queued", async () => {
    const sched = createScheduler();
    const order = ordered(sched);
    const g = gate();
    const got: string[] = [];
    const director = order.first
      .forOrigin(REMOTE, 1)
      .acquire('interactive', undefined, { after: g.promise })
      .then((s) => (got.push('director'), s));
    const recall = order.second
      .forOrigin(REMOTE, 1)
      .acquire('interactive')
      .then((s) => (got.push('recall'), s));
    await settle();
    expect(got).toEqual([]);
    g.open();
    (await director).release();
    (await recall).release();
    expect(got).toEqual(['director', 'recall']);
  });

  test("recall's own `after` is waited for as well as the order", async () => {
    const order = ordered(createScheduler());
    const g = gate();
    const recall = pending(order.second.forOrigin(REMOTE, 1).acquire('interactive', undefined, { after: g.promise }));
    order.open();
    await settle();
    expect(recall.got()).toBeNull();
    g.open();
    (await recall.slot).release();
  });

  test('the wrappers pass capacity, locality, counts and touches through to the one scheduler', async () => {
    const sched = createScheduler();
    const order = ordered(sched);
    const sem = order.first.forOrigin(LOCAL, 2);
    expect(sem.capacity).toBe(2);
    expect(sem.local).toBe(true);
    const held = await sem.acquire('interactive');
    expect(order.second.forOrigin(LOCAL, 2).inFlight()).toBe(1);
    expect(order.second.forOrigin(LOCAL, 2).waiting()).toBe(0);
    order.second.touch(LOCAL);
    held.release();
    expect(sched.forOrigin(LOCAL, 2).inFlight()).toBe(0);
  });
});
