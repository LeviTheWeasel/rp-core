// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b abort reasons (D-172, C-12) and linkAbort.
import { describe, expect, test } from 'bun:test';
import { abortWith, linkAbort, reasonOf, TypedAbort, type AbortReason } from '../../src/engine/abort.ts';

describe('the M5b abort reasons', () => {
  test('budget:filing, budget:historian and preempted are typed reasons', () => {
    for (const reason of ['budget:filing', 'budget:historian', 'preempted'] satisfies AbortReason[]) {
      const ctl = new AbortController();
      abortWith(ctl, reason);
      expect(reasonOf(ctl.signal)).toBe(reason);
      expect((ctl.signal.reason as TypedAbort).message).toBe(`aborted: ${reason}`);
    }
  });
});

describe('linkAbort', () => {
  test('the controller follows the linked signal with its reason object', () => {
    const src = new AbortController();
    const ctl = new AbortController();
    linkAbort(ctl, src.signal);
    abortWith(src, 'preempted');
    expect(ctl.signal.reason).toBe(src.signal.reason);
    expect(reasonOf(ctl.signal)).toBe('preempted');
  });

  test('an already aborted signal aborts the controller at once', () => {
    const src = new AbortController();
    abortWith(src, 'shutdown');
    const ctl = new AbortController();
    linkAbort(ctl, src.signal)();
    expect(reasonOf(ctl.signal)).toBe('shutdown');
  });

  test('after unlink, or after the controller aborted on its own, the first reason stays', () => {
    const src = new AbortController();
    const ctl = new AbortController();
    const unlink = linkAbort(ctl, src.signal);
    unlink();
    abortWith(src, 'preempted');
    expect(ctl.signal.aborted).toBe(false);

    const src2 = new AbortController();
    const ctl2 = new AbortController();
    linkAbort(ctl2, src2.signal);
    abortWith(ctl2, 'timeout:idle');
    abortWith(src2, 'preempted');
    expect(reasonOf(ctl2.signal)).toBe('timeout:idle');
  });
});
