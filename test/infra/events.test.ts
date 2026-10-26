// Ported from RoleCall:apps/rc/src/lib/ai/streaming/__tests__/stream-delta.test.ts@fb8dc623e6beb24083f5105c828462e89fc66ce3 (applyDelta cases).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// applyDelta (offset-only) and the terminal event set (ARCHITECTURE.md §12.2, D-36).
import { describe, expect, test } from 'bun:test';
import { applyDelta, TERMINAL_EVENTS } from '../../src/protocol/events.ts';

describe('applyDelta', () => {
  test('appends at the end', () => {
    expect(applyDelta('', { delta: 'Hello', offset: 0 })).toBe('Hello');
    expect(applyDelta('Hello', { delta: ' world', offset: 5 })).toBe('Hello world');
  });

  // Cases adapted from RoleCall stream-delta.test.ts (offset-only form).
  test('drops a fully replayed delta', () => {
    expect(applyDelta('01234hello', { delta: 'hello', offset: 5 })).toBe('01234hello');
    expect(applyDelta('01234hello!', { delta: 'hello', offset: 5 })).toBe('01234hello!');
  });

  test('keeps only the missing part of a partial overlap', () => {
    expect(applyDelta('01234he', { delta: 'hello', offset: 5 })).toBe('01234hello');
    expect(applyDelta('hello wo', { delta: 'world', offset: 6 })).toBe('hello world');
  });

  test('the re-delivered delta replaces what it overlaps, and nothing past it', () => {
    expect(applyDelta('hello world', { delta: 'HELLO', offset: 0 })).toBe('HELLO world');
    expect(applyDelta('abc', { delta: 'XYZW', offset: 1 })).toBe('aXYZW');
  });

  test('an empty delta changes nothing', () => {
    expect(applyDelta('abc', { delta: '', offset: 3 })).toBe('abc');
    expect(applyDelta('abc', { delta: '', offset: 1 })).toBe('abc');
  });

  test('a gap is an error: the client must resync from done', () => {
    expect(() => applyDelta('abc', { delta: 'x', offset: 4 })).toThrow(/gap/);
  });

  test('a malformed offset is an error', () => {
    expect(() => applyDelta('abc', { delta: 'x', offset: -1 })).toThrow(RangeError);
    expect(() => applyDelta('abc', { delta: 'x', offset: 1.5 })).toThrow(RangeError);
  });
});

describe('terminal events', () => {
  test('done, stopped, failed and conflict end a turn', () => {
    expect([...TERMINAL_EVENTS].sort()).toEqual(['conflict', 'done', 'failed', 'stopped']);
  });
});
