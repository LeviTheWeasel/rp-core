// Unit tests for the engine's small parts: checkpoint cadence, retry rules, event plumbing,
// commit placement.
import { describe, expect, test } from 'bun:test';
import type { DelayTimers } from '../../src/engine/abort.ts';
import { EventBus, EventQueue, singleConsumer } from '../../src/engine/bus.ts';
import { Checkpointer, checkpointCadence, DEFAULT_CHECKPOINT } from '../../src/engine/checkpoint.ts';
import { placeCommit, type Journal } from '../../src/engine/commit.ts';
import { isRetryable, parseModelRef, retryDelayMs } from '../../src/engine/route.ts';
import { ProviderError } from '../../src/providers/types.ts';
import type { Entry, EntryInput, TurnEntry } from '../../src/session/entries.ts';
import { buildTree } from '../../src/session/tree.ts';
import { fakeRandom } from '../helpers.ts';

/** Manual timers: run() fires everything due at `now`. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: DelayTimers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        pending.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

describe('Checkpointer', () => {
  test('flushes at the char threshold, or after ms, whichever first; datasync only when dirty', () => {
    const t = manualTimers();
    const written: string[] = [];
    let syncs = 0;
    const c = new Checkpointer((x) => written.push(x), () => syncs++, { chars: 5, ms: 100, datasyncMs: 50 }, t.timers);
    c.start();
    c.add('abc');
    expect(written).toEqual([]);
    c.add('de'); // 5 chars → flush now
    expect(written).toEqual(['abcde']);
    c.add('f');
    t.advance(99);
    expect(written).toEqual(['abcde']);
    expect(syncs).toBe(1); // the tick at 50 ms synced 'abcde'
    t.advance(1);
    expect(written).toEqual(['abcde', 'f']);
    const after = syncs; // the tick at 100 ms may sync 'f' right away
    t.advance(500);
    expect(syncs).toBeLessThanOrEqual(2);
    expect(syncs - after).toBeLessThanOrEqual(1); // at most one more sync, then nothing new: no sync
    const settled = syncs;
    t.advance(500);
    expect(syncs).toBe(settled);
    c.add('gh');
    c.stop({ flush: true });
    expect(written).toEqual(['abcde', 'f', 'gh']);
    expect(t.pending()).toBe(0); // every timer cleared
    c.add('ignored');
    expect(written).toHaveLength(3);
  });

  test('stop without flush discards pending text; write errors are kept, not thrown', () => {
    const t = manualTimers();
    const c = new Checkpointer(() => {
      throw new Error('disk full');
    }, () => undefined, { chars: 2, ms: 10, datasyncMs: 10 }, t.timers);
    c.add('xy');
    expect((c.error as Error).message).toBe('disk full');
    const written: string[] = [];
    const d = new Checkpointer((x) => written.push(x), () => undefined, DEFAULT_CHECKPOINT, t.timers);
    d.add('pending');
    d.stop({ flush: false });
    expect(written).toEqual([]);
    expect(t.pending()).toBe(0);
  });

  test('cadence defaults fill gaps and nonsense', () => {
    expect(checkpointCadence()).toEqual({ chars: 400, ms: 1000, datasyncMs: 2000 });
    expect(checkpointCadence({ chars: 10, ms: -1, datasyncMs: Number.NaN })).toEqual({ chars: 10, ms: 1000, datasyncMs: 2000 });
  });
});

describe('retry rules', () => {
  const err = (init: Partial<ConstructorParameters<typeof ProviderError>[0]>) =>
    new ProviderError({ category: 'server', code: 'overloaded', ...init });

  test('only "try again later" before any output, with a status', () => {
    expect(isRetryable(err({ status: 503 }))).toBe(true);
    expect(isRetryable(err({ code: 'rate_limited', category: 'rate', status: 429 }))).toBe(true);
    expect(isRetryable(err({ code: 'rate_limited', category: 'rate', status: 420 }))).toBe(true); // transient code + a status
    expect(isRetryable(err({ code: 'bad_request', category: 'request', status: 500 }))).toBe(true); // a 5xx is a 5xx
    expect(isRetryable(err({ status: 503, afterOutput: true }))).toBe(false);
    expect(isRetryable(err({ code: 'timeout', category: 'network' }))).toBe(false); // ours: ambiguous, maybe billed
    expect(isRetryable(err({ code: 'unreachable', category: 'network' }))).toBe(false);
    expect(isRetryable(err({ code: 'auth_failed', category: 'auth', status: 401 }))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });

  test('delay: retry-after capped, default 1 s, plus jitter of at most min(250 ms, delay/4)', () => {
    const r = fakeRandom(3);
    const d1 = retryDelayMs(err({ status: 429, retryAfterSec: 30 }), undefined, r);
    expect(d1).toBeGreaterThanOrEqual(8000);
    expect(d1).toBeLessThanOrEqual(8250);
    const d2 = retryDelayMs(err({ status: 503 }), undefined, r);
    expect(d2).toBeGreaterThanOrEqual(1000);
    expect(d2).toBeLessThanOrEqual(1250);
    const d3 = retryDelayMs(err({ status: 503, retryAfterSec: 2 }), 5, r);
    expect(d3).toBeGreaterThanOrEqual(5);
    expect(d3).toBeLessThanOrEqual(6);
  });

  test('conn:model refs', () => {
    expect(parseModelRef('local:qwen3:14b')).toEqual({ conn: 'local', model: 'qwen3:14b' });
    expect(parseModelRef('nocolon')).toBeNull();
    expect(parseModelRef(':m')).toBeNull();
    expect(parseModelRef('c:')).toBeNull();
  });
});

describe('event plumbing', () => {
  test('a queue delivers buffered and later values, then ends', async () => {
    const q = new EventQueue<number>();
    q.push(1);
    const it = singleConsumer(q)[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    const later = it.next();
    q.push(2);
    expect(await later).toEqual({ value: 2, done: false });
    q.end();
    q.push(3);
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  test('single consumer: a second iteration throws', () => {
    const iterable = singleConsumer(new EventQueue<number>());
    iterable[Symbol.asyncIterator]();
    expect(() => iterable[Symbol.asyncIterator]()).toThrow('single consumer');
  });

  test('the bus is a live tail per subscriber; breaking out unsubscribes; close ends everyone', async () => {
    const bus = new EventBus<string>();
    bus.publish('before');
    const a = bus.subscribe();
    const b = bus.subscribe();
    bus.publish('x');
    const ita = a[Symbol.asyncIterator]();
    expect(await ita.next()).toEqual({ value: 'x', done: false });
    await ita.return!();
    bus.publish('y');
    bus.close();
    const got: string[] = [];
    for await (const v of b) got.push(v);
    expect(got).toEqual(['x', 'y']);
    const late = bus.subscribe();
    expect(await late[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });
});

describe('placeCommit (the unconditional-commit rule)', () => {
  const TS = '2026-10-26T12:00:00.000Z';
  function journal(initial: EntryInput[]): Journal & { list: Entry[] } {
    const list: Entry[] = [];
    let version = 0;
    const j = {
      list,
      tree: () => buildTree(list),
      version: () => version,
      now: () => TS,
      append<T extends EntryInput>(input: T): T & { seq: number } {
        const e = { ...input, seq: list.length + 1 } as unknown as Entry;
        list.push(e);
        if (['msg', 'edit', 'hide', 'head'].includes(e.t)) version = e.seq;
        return e as unknown as T & { seq: number };
      },
    };
    for (const e of initial) j.append(e);
    return j;
  }
  const g = { t: 'msg' as const, ts: TS, id: 'g', parent: null, role: 'assistant' as const, gen: { kind: 'greeting' as const }, blocks: [{ k: 'text' as const, text: 'G' }] };
  const u = { t: 'msg' as const, ts: TS, id: 'u', parent: 'g', role: 'user' as const, blocks: [{ k: 'text' as const, text: 'U' }] };
  const a = { t: 'msg' as const, ts: TS, id: 'a', parent: 'u', role: 'assistant' as const, blocks: [{ k: 'reasoning' as const, text: 'r' }, { k: 'text' as const, text: 'A' }] };
  const turn = (o: Partial<TurnEntry>): TurnEntry => ({ t: 'turn', seq: 0, ts: TS, turn: 't1', kind: 'reply', parent: 'u', msgId: 'n', seed: 1, now: TS, base: 2, ...o });
  const plan = (t: TurnEntry, extra: object = {}) => ({ turn: t, blocks: [{ k: 'text' as const, text: 'N' }], addition: ' more', body: {}, continueConflict: 'discarded' as const, ...extra });

  test('no conflict: one msg under U; the head follows it', () => {
    const j = journal([g, u]);
    const placed = placeCommit(j, plan(turn({ base: 2 })));
    expect(placed).toMatchObject({ kind: 'msg', tail: false });
    expect(j.tree().head).toBe('n');
  });

  test('swipe while the head is still a child of U: the head follows the new sibling', () => {
    const j = journal([g, u, a, { t: 'hide', ts: TS, target: 'g', hidden: false }]);
    const placed = placeCommit(j, plan(turn({ kind: 'swipe', target: 'a', base: 3 })));
    expect(placed).toMatchObject({ kind: 'msg', tail: false });
    expect(j.tree().head).toBe('n');
  });

  test('continue keeps the non-text blocks; a conflict on its text discards it', () => {
    const j = journal([g, u, a]);
    const t = turn({ kind: 'continue', target: 'a', msgId: 'a', base: 3 });
    const placed = placeCommit(j, plan(t, { cont: { mode: 'prefill', base: 'A' } }));
    expect(placed.kind).toBe('edit');
    if (placed.kind === 'edit') expect(placed.entry.blocks).toEqual([{ k: 'reasoning', text: 'r' }, { k: 'text', text: 'A more' }]);
    const j2 = journal([g, u, a, { t: 'edit', ts: TS, target: 'a', reason: 'user', blocks: [{ k: 'text', text: 'B' }] }]);
    const p2 = placeCommit(j2, plan(t, { cont: { mode: 'prefill', base: 'A' } }));
    expect(p2.kind === 'end' && p2.entry.outcome).toBe('discarded');
    // version moved but the target text is unchanged: still applied
    const j3 = journal([g, u, a, { t: 'hide', ts: TS, target: 'g', hidden: false }]);
    expect(placeCommit(j3, plan(t, { cont: { mode: 'cue', base: 'A' } })).kind).toBe('edit');
  });
});
