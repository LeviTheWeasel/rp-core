// Ported from Bunraku:src/core/lore/engine/recursion.test.ts, recursion.regressions.test.ts and engine.regressions.test.ts@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lore/engine.ts recursion: loops 1–3, preventRecursion, excludeRecursion, per-book recursive.
// Adapted from Bunraku src/core/lore/engine/recursion.test.ts, recursion.regressions.test.ts and
// engine.regressions.test.ts @702d8120 (see .notes/m2-provenance-lore.md).
import { describe, expect, test } from 'bun:test';
import { MAX_RECURSION } from '../../src/lore/engine.ts';
import { entry, ids, run, runBook, source, verdict, whys } from './fixtures.ts';

// A chain: 'start' fires on the chat and mentions k1; each link's text mentions the next key.
const chain = [
  entry('start', { keys: ['map'], content: 'see k1' }),
  entry('l1', { keys: ['k1'], content: 'see k2' }),
  entry('l2', { keys: ['k2'], content: 'see k3' }),
  entry('l3', { keys: ['k3'], content: 'see k4' }),
  entry('l4', { keys: ['k4'], content: 'see k5' }),
];
const chat = ['Levi: the map'];

describe('recursion loops', () => {
  test('levels 1–3 wake one by one; the cap stops at 3', () => {
    expect(MAX_RECURSION).toBe(3);
    const res = runBook(chain, chat);
    expect(res.fired.map((h) => [h.id, h.why, h.loop])).toEqual([
      ['start', 'key', 0],
      ['l1', 'recursion', 1],
      ['l2', 'recursion', 2],
      ['l3', 'recursion', 3],
    ]);
    expect(verdict(res, 'l4')).toMatchObject({ fired: false, why: 'no-key-match' });
  });

  test('an entry the last loop would have woken says so: recursion stops after 3 loops (a named deviation, G-5)', () => {
    // SillyBunny's shipped max_recursion_steps 0 is unlimited and would fire l4 too.
    const res = runBook(chain, chat);
    expect(verdict(res, 'l4')).toMatchObject({ fired: false, why: 'no-key-match', matched: ['k4'], detail: { recursionLimit: MAX_RECURSION } });
    // An entry nothing would wake keeps a plain no-key-match.
    const plain = runBook([...chain, entry('far', { keys: ['nowhere'] })], chat);
    expect(verdict(plain, 'far').detail).toBeUndefined();
    // Without explain nothing extra is computed.
    expect(runBook(chain, chat, { explain: false }).verdicts).toBeUndefined();
  });

  test('the buffer accumulates: a loop-2 entry can match text added in loop 1', () => {
    const res = runBook([entry('start', { keys: ['map'], content: 'k1 and kX' }), entry('l1', { keys: ['k1'], content: 'k2' }), entry('both', { keys: ['k2'], secondary: ['kX'], logic: 'and_all' })], chat);
    expect(res.fired.map((h) => [h.id, h.loop])).toEqual([
      ['start', 0],
      ['l1', 1],
      ['both', 2],
    ]);
  });

  test('a mutually triggering pair terminates with each entry once', () => {
    const res = runBook([entry('a', { keys: ['keyword-a'], content: 'mentions keyword-b' }), entry('b', { keys: ['keyword-b'], content: 'mentions keyword-a' })], ['Levi: keyword-a']);
    expect(ids(res.fired)).toEqual(['a', 'b']);
  });

  test('recursion text is the expanded text', () => {
    const res = runBook([entry('gate', { constant: true, content: '{{beast}}' }), entry('w', { keys: ['dragon'] })], [], {
      expand: (_k, s) => s.replace('{{beast}}', 'a dragon'),
    });
    expect(whys(res)).toEqual({ gate: '+constant', w: '+recursion' });
  });

  test('a woken entry with scan depth 0 still reads the recursion buffer', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'dragon' }), entry('w', { keys: ['dragon'], scanDepth: 0 })], chat);
    expect(whys(res)).toEqual({ gate: '+key', w: '+recursion' });
  });

  test('recursion stops once the budget overflowed', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'dragon' }), entry('big', { constant: true, content: 'x'.repeat(30), order: 50 }), entry('w', { keys: ['dragon'] })], chat, {
      budget: 10,
    });
    expect(whys(res)).toEqual({ gate: '+key', big: '-budget-cut', w: '-no-key-match' });
  });
});

describe('recursion controls', () => {
  test('preventRecursion: its text wakes nothing', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'a hidden dragon', preventRecursion: true }), entry('w', { keys: ['dragon'] })], chat);
    expect(whys(res)).toEqual({ gate: '+key', w: '-no-key-match' });
  });

  test('excludeRecursion: never woken by another entry, only by the chat', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'leads to a dragon' }), entry('w', { keys: ['dragon'], excludeRecursion: true })], chat);
    expect(ids(res.fired)).toEqual(['gate']);
    expect(verdict(res, 'w').why).toBe('exclude-recursion');
    const direct = runBook([entry('gate', { keys: ['map'], content: 'x' }), entry('w', { keys: ['dragon'], excludeRecursion: true })], ['Levi: the map and a dragon']);
    expect(ids(direct.fired)).toEqual(['gate', 'w']);
  });

  test('an excludeRecursion entry can still wake others', () => {
    const res = runBook([entry('ex', { keys: ['map'], content: 'dragon', excludeRecursion: true }), entry('w', { keys: ['dragon'] })], chat);
    expect(whys(res)).toEqual({ ex: '+key', w: '+recursion' });
  });

  test('book recursive:false: its entries neither feed the buffer nor get woken', () => {
    const res = run(
      [
        source('flat', [entry('gate', { keys: ['map'], content: 'dragon' }), entry('inner', { keys: ['wyvern'] })], { recursive: false }),
        source('deep', [entry('w', { keys: ['dragon'] }), entry('src', { keys: ['map'], content: 'a wyvern' })]),
      ],
      { scan: chat },
    );
    expect(whys(res)).toEqual({ gate: '+key', inner: '-no-key-match', w: '-no-key-match', src: '+key' });
  });

  test('a delayed entry stays delayed, recursion or not', () => {
    const entries = [entry('gate', { keys: ['map'], content: 'storm' }), entry('late', { keys: ['storm'], delay: 5 })];
    expect(whys(runBook(entries, chat, { chatLength: 2 }))).toEqual({ gate: '+key', late: '-delay' });
    expect(whys(runBook(entries, chat, { chatLength: 5 }))).toEqual({ gate: '+key', late: '+recursion' });
  });

  test('an entry on cooldown is not woken by recursion', () => {
    const fires = [{ book: 'b', id: 'cool', why: 'key', at: 2 }];
    const res = runBook([entry('gate', { keys: ['map'], content: 'dragon' }), entry('cool', { keys: ['dragon'], cooldown: 3 })], chat, { fires, chatLength: 3 });
    expect(whys(res)).toEqual({ gate: '+key', cool: '-cooldown' });
  });

  test('a failed roll is final: recursion does not roll the entry again', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'more text' }), entry('p', { keys: ['map'], probability: 0 })], chat);
    expect(verdict(res, 'p')).toMatchObject({ why: 'chance', loop: 0 });
  });
});
