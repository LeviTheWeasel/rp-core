import { describe, expect, test } from 'bun:test';
import { createCoalescer } from '../../src/protocol/coalesce.ts';
import { applyDelta, type Event } from '../../src/protocol/events.ts';
import { fakeTimers } from './fake-timers.ts';

let tick = 0;
/** Events with increasing timestamps so a frame's ts can be checked. */
function ts(): string {
  return `2026-10-26T12:00:00.${String(tick++).padStart(3, '0')}Z`;
}
type DeltaEv = Extract<Event, { type: 'text' }>;
function text(delta: string, offset: number, turnId = 't1', sessionId = 's1'): DeltaEv {
  return { sessionId, ts: ts(), type: 'text', turnId, delta, offset };
}
function reasoning(delta: string, offset: number, turnId = 't1', sessionId = 's1'): Event {
  return { sessionId, ts: ts(), type: 'reasoning', turnId, delta, offset };
}
/** A terminal event (stopped with no text needs no MessageView). */
function stopped(turnId = 't1'): Event {
  return { sessionId: 's1', ts: ts(), type: 'stopped', turnId, message: null };
}

/** A coalescer on fake timers that collects what it emits. */
function rig(opts: { ms?: number; chars?: number } = {}) {
  const out: Event[] = [];
  const timers = fakeTimers();
  const c = createCoalescer((e) => out.push(e), { ...opts, timers });
  return { out, timers, c };
}

/** Compact view of emitted frames. */
function frames(out: Event[]): string[] {
  return out.map((e) => (e.type === 'text' || e.type === 'reasoning' ? `${e.type}@${e.offset}:${e.delta}` : e.type));
}

describe('coalescer', () => {
  test('contiguous deltas merge into one frame that keeps the first ts and offset', () => {
    const { out, c } = rig();
    const first = text('Hel', 0);
    c.push(first);
    c.push(text('lo', 3));
    c.push(text(', world', 5));
    expect(out).toEqual([]);
    c.flush();
    expect(out).toEqual([{ ...first, delta: 'Hello, world' }]);
  });

  test('a batch reaching 768 chars goes out at once', () => {
    const { out, c, timers } = rig();
    const piece = 'x'.repeat(100);
    for (let i = 0; i < 7; i++) c.push(text(piece, i * 100));
    expect(out).toEqual([]);
    c.push(text(piece, 700));
    expect(frames(out)).toEqual([`text@0:${'x'.repeat(800)}`]);
    // The full batch also stopped the timer: nothing is left to fire.
    expect(timers.pending()).toBe(0);
    c.push(text('tail', 800));
    c.flush();
    expect(frames(out)).toEqual([`text@0:${'x'.repeat(800)}`, 'text@800:tail']);
  });

  // After Bunraku server-chats-turn.test.ts "M5: a thousand tiny chunks…", as a unit test.
  test('a thousand one-char deltas inside one window become two frames', () => {
    const { out, c, timers } = rig();
    for (let i = 0; i < 1000; i++) c.push(text(String(i % 10), i));
    timers.advance(40);
    expect(out.map((e) => ('delta' in e ? e.delta.length : 0))).toEqual([768, 232]);
    expect(out.map((e) => ('delta' in e ? e.delta : '')).join('')).toBe(
      Array.from({ length: 1000 }, (_, i) => String(i % 10)).join(''),
    );
  });

  test('a failure mid-stream flushes the pending text first, so the client copy equals the draft', () => {
    const { out, c } = rig();
    c.push(text('Half a sen', 0));
    c.push(text('tence', 10));
    c.push({ sessionId: 's1', ts: ts(), type: 'failed', turnId: 't1', category: 'network', code: 'truncated_stream', message: 'cut', draft: 'Half a sentence' });
    expect(frames(out)).toEqual(['text@0:Half a sentence', 'failed']);
    let copy = '';
    for (const e of out) if (e.type === 'text') copy = applyDelta(copy, e);
    const failed = out[1];
    expect(failed?.type === 'failed' ? failed.draft : null).toBe(copy);
  });

  test('custom char threshold splits a stream into frames', () => {
    const { out, c } = rig({ chars: 4 });
    'abcdefghij'.split('').forEach((ch, i) => c.push(text(ch, i)));
    c.flush();
    expect(frames(out)).toEqual(['text@0:abcd', 'text@4:efgh', 'text@8:ij']);
  });

  test('the 40 ms timer is a throttle: later deltas do not push it back', () => {
    const { out, c, timers } = rig();
    c.push(text('a', 0));
    timers.advance(30);
    c.push(text('b', 1));
    timers.advance(9);
    expect(out).toEqual([]);
    timers.advance(1);
    expect(frames(out)).toEqual(['text@0:ab']);
    expect(timers.pending()).toBe(0);
    // The next delta starts a new 40 ms window.
    c.push(text('c', 2));
    timers.advance(39);
    expect(out.length).toBe(1);
    timers.advance(1);
    expect(frames(out)).toEqual(['text@0:ab', 'text@2:c']);
  });

  test('any other event flushes pending deltas first, in order', () => {
    const { out, c, timers } = rig();
    c.push(reasoning('think', 0));
    c.push(reasoning('ing', 5));
    c.push(text('Hi', 0));
    c.push(text(' there', 2));
    c.push({ sessionId: 's1', ts: ts(), type: 'tool', turnId: 't1', callId: 'c1', name: 'roll', phase: 'start' });
    c.push(text('!', 8));
    c.push(stopped());
    expect(frames(out)).toEqual(['reasoning@0:thinking', 'text@0:Hi there', 'tool', 'text@8:!', 'stopped']);
    expect(timers.pending()).toBe(0);
  });

  test('switching between text and reasoning in one turn keeps arrival order', () => {
    const { out, c } = rig();
    c.push(reasoning('r1', 0));
    c.push(text('t1', 0));
    c.push(reasoning('r2', 2));
    c.push(text('t2', 2));
    c.flush();
    expect(frames(out)).toEqual(['reasoning@0:r1', 'text@0:t1', 'reasoning@2:r2', 'text@2:t2']);
  });

  test('non-contiguous offsets are never merged', () => {
    const { out, c } = rig();
    c.push(text('hello', 0));
    c.push(text('world', 10)); // gap
    c.push(text('wor', 10)); // overlap: re-delivery
    c.push(text('ld', 13));
    c.flush();
    expect(frames(out)).toEqual(['text@0:hello', 'text@10:world', 'text@10:world']);
  });

  test('batches are kept per (session, turn, type)', () => {
    const { out, c } = rig();
    c.push(text('a', 0, 't1', 's1'));
    c.push(text('x', 0, 't9', 's2'));
    c.push(text('b', 1, 't1', 's1'));
    c.push(text('y', 1, 't9', 's2'));
    c.push(text('m', 0, 't2', 's1'));
    c.flush();
    expect(out.map((e) => `${e.sessionId}/${'turnId' in e ? e.turnId : ''}:${'delta' in e ? e.delta : ''}`)).toEqual([
      's1/t1:ab',
      's2/t9:xy',
      's1/t2:m',
    ]);
  });

  test('close flushes, stops the timer, and lets later events straight through', () => {
    const { out, c, timers } = rig();
    c.push(text('abc', 0));
    expect(timers.pending()).toBe(1);
    c.close();
    expect(frames(out)).toEqual(['text@0:abc']);
    expect(timers.pending()).toBe(0);
    c.push(text('d', 3));
    expect(frames(out)).toEqual(['text@0:abc', 'text@3:d']);
    expect(timers.pending()).toBe(0);
  });

  test('a client applying the frames gets exactly the streamed text', () => {
    const { out, c, timers } = rig({ chars: 16 });
    const whole = 'Мира подняла фонарь. "Кто здесь?" — спросила она, и тишина ответила эхом.';
    let at = 0;
    let step = 1;
    while (at < whole.length) {
      const piece = whole.slice(at, at + step);
      c.push(text(piece, at));
      at += piece.length;
      step = (step % 5) + 1;
      if (at % 7 === 0) timers.advance(40);
    }
    c.close();
    let copy = '';
    for (const e of out) if (e.type === 'text') copy = applyDelta(copy, e);
    expect(copy).toBe(whole);
    expect(out.length).toBeLessThan(whole.length);
  });
});
