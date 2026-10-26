import { describe, expect, test } from 'bun:test';
import { abortableDelay, abortWith, childController, reasonOf, TypedAbort } from '../../src/engine/abort.ts';
import { fakeTimers } from './fake-timers.ts';

/** Counts listener add/remove calls on a signal, to prove cleanup. */
function spyListeners(signal: AbortSignal): { added: () => number; removed: () => number } {
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  (signal as { addEventListener: unknown }).addEventListener = (...a: Parameters<typeof add>) => {
    added++;
    return add(...a);
  };
  (signal as { removeEventListener: unknown }).removeEventListener = (...a: Parameters<typeof remove>) => {
    removed++;
    return remove(...a);
  };
  return { added: () => added, removed: () => removed };
}

describe('abort tree', () => {
  test('a child follows the parent with the very same TypedAbort', () => {
    const turn = new AbortController();
    const fetchCtl = childController(turn.signal);
    const toolCtl = childController(fetchCtl.signal);
    abortWith(turn, 'user_stop');
    expect(fetchCtl.signal.aborted).toBe(true);
    expect(toolCtl.signal.aborted).toBe(true);
    expect(fetchCtl.signal.reason).toBe(turn.signal.reason);
    expect(toolCtl.signal.reason).toBe(turn.signal.reason);
    expect(reasonOf(toolCtl.signal)).toBe('user_stop');
  });

  test('a child of an already aborted parent starts aborted', () => {
    const turn = new AbortController();
    abortWith(turn, 'shutdown');
    const child = childController(turn.signal);
    expect(child.signal.aborted).toBe(true);
    expect(reasonOf(child.signal)).toBe('shutdown');
  });

  test('a child aborting on its own leaves the parent alone and stops listening to it', () => {
    const turn = new AbortController();
    const spy = spyListeners(turn.signal);
    const fetchCtl = childController(turn.signal);
    abortWith(fetchCtl, 'timeout:first_byte');
    expect(turn.signal.aborted).toBe(false);
    expect(spy.added()).toBe(1);
    expect(spy.removed()).toBe(1);
    // A later Stop does not rewrite the child's reason: a timeout is never reported as a Stop.
    abortWith(turn, 'user_stop');
    expect(reasonOf(fetchCtl.signal)).toBe('timeout:first_byte');
  });

  test('a foreign parent reason is passed through unchanged', () => {
    const turn = new AbortController();
    const child = childController(turn.signal);
    const foreign = new Error('host gone');
    turn.abort(foreign);
    expect(child.signal.reason).toBe(foreign);
    expect(reasonOf(child.signal)).toBeNull();
  });

  test('abortWith: the first reason wins', () => {
    const ctl = new AbortController();
    abortWith(ctl, 'timeout:idle');
    const first = ctl.signal.reason;
    abortWith(ctl, 'user_stop');
    expect(ctl.signal.reason).toBe(first);
    expect(reasonOf(ctl.signal)).toBe('timeout:idle');
    expect(first).toBeInstanceOf(TypedAbort);
    expect((first as TypedAbort).name).toBe('AbortError');
  });

  test('reasonOf: null when not aborted or aborted with a foreign value', () => {
    const live = new AbortController();
    expect(reasonOf(live.signal)).toBeNull();
    const plain = new AbortController();
    plain.abort();
    expect(reasonOf(plain.signal)).toBeNull();
    const typed = new AbortController();
    typed.abort(new TypedAbort('budget:director'));
    expect(reasonOf(typed.signal)).toBe('budget:director');
  });
});

describe('abortableDelay', () => {
  test('resolves after ms and removes its listener', async () => {
    const timers = fakeTimers();
    const ctl = new AbortController();
    const spy = spyListeners(ctl.signal);
    let done = false;
    const p = abortableDelay(50, ctl.signal, timers).then(() => {
      done = true;
    });
    timers.advance(49);
    await Promise.resolve();
    expect(done).toBe(false);
    timers.advance(1);
    await p;
    expect(done).toBe(true);
    expect(spy.added()).toBe(1);
    expect(spy.removed()).toBe(1);
  });

  test('rejects with the TypedAbort and clears its timer when aborted first', async () => {
    const timers = fakeTimers();
    const ctl = new AbortController();
    const p = abortableDelay(1000, ctl.signal, timers);
    expect(timers.pending()).toBe(1);
    abortWith(ctl, 'user_stop');
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypedAbort);
    expect((err as TypedAbort).reason).toBe('user_stop');
    expect(timers.pending()).toBe(0);
  });

  test('rejects at once on an already aborted signal without scheduling', async () => {
    const timers = fakeTimers();
    const ctl = new AbortController();
    abortWith(ctl, 'shutdown');
    const err = await abortableDelay(10, ctl.signal, timers).catch((e: unknown) => e);
    expect((err as TypedAbort).reason).toBe('shutdown');
    expect(timers.pending()).toBe(0);
  });

  test('works with the real timers by default', async () => {
    await abortableDelay(1, new AbortController().signal);
  });
});
