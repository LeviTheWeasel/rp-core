// Ported from Bunraku:src/core/lore/engine/groups.test.ts@702d8120 (lone member, ungrouped, weighted pick).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lore/engine.ts inclusion groups (ST filterByInclusionGroups) on the seeded 'lore.group' stream.
// Adapted from Bunraku src/core/lore/engine/groups.test.ts @702d8120 (lone member, ungrouped,
// weighted pick) onto runLore; the cumulative-weight rule is checked statistically over fixed seeds.
import { describe, expect, test } from 'bun:test';
import { entry, ids, runBook, verdict, whys } from './fixtures.ts';

const g = (id: string, patch = {}) => entry(id, { constant: true, groups: ['g'], ...patch });

describe('one winner per group', () => {
  test('a lone member always wins; ungrouped entries are never filtered', () => {
    expect(whys(runBook([g('a'), entry('solo', { constant: true })]))).toEqual({ a: '+constant', solo: '+constant' });
  });

  test('two members: exactly one fires, the other is group-lost with its matched keys', () => {
    const res = runBook([entry('a', { keys: ['x'], groups: ['g'] }), entry('b', { keys: ['x'], groups: ['g'] })], ['Levi: x'], {}, { recursive: false });
    expect(res.fired).toHaveLength(1);
    const loser = res.fired[0]?.id === 'a' ? 'b' : 'a';
    expect(verdict(res, loser)).toMatchObject({ fired: false, why: 'group-lost', matched: ['x'], loop: 0 });
  });

  test('a loser is looked at again in the recursion loop and loses to the accepted member there', () => {
    const res = runBook([entry('a', { keys: ['x'], groups: ['g'] }), entry('b', { keys: ['x'], groups: ['g'] })], ['Levi: x']);
    const loser = res.fired[0]?.id === 'a' ? 'b' : 'a';
    expect(verdict(res, loser)).toMatchObject({ fired: false, why: 'group-lost', loop: 1 });
  });

  test('group names are trimmed and compared across books', () => {
    const res = runBook([g('a', { groups: [' g '] }), g('b')]);
    expect(res.fired).toHaveLength(1);
  });

  test('a weight 0 member loses to a weighted one', () => {
    for (let seed = 0; seed < 50; seed++) expect(ids(runBook([g('a', { groupWeight: 0 }), g('b', { groupWeight: 10 })], [], { seed }).fired)).toEqual(['b']);
  });
});

describe('seeded draws', () => {
  test('deterministic per seed', () => {
    for (const seed of [1, 7, 42, 99999]) {
      const first = ids(runBook([g('a'), g('b'), g('c')], [], { seed }).fired);
      for (let i = 0; i < 5; i++) expect(ids(runBook([g('a'), g('b'), g('c')], [], { seed }).fired)).toEqual(first);
    }
  });

  test('default weights (100 each) give every member a fair share', () => {
    const wins: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let seed = 0; seed < 3000; seed++) {
      const id = runBook([g('a'), g('b'), g('c')], [], { seed }).fired[0]?.id as string;
      wins[id] = (wins[id] ?? 0) + 1;
    }
    for (const n of Object.values(wins)) {
      expect(n).toBeGreaterThan(900);
      expect(n).toBeLessThan(1100);
    }
  });

  test('weights are respected: 1 : 3 over many seeds', () => {
    let a = 0;
    const n = 4000;
    for (let seed = 0; seed < n; seed++) if (runBook([g('a', { groupWeight: 1 }), g('b', { groupWeight: 3 })], [], { seed }).fired[0]?.id === 'a') a++;
    expect(a / n).toBeGreaterThan(0.22);
    expect(a / n).toBeLessThan(0.28);
  });

  test('an unrelated entry added later does not change the pick', () => {
    for (let seed = 0; seed < 60; seed++) {
      const before = ids(runBook([g('a'), g('b')], [], { seed }).fired);
      const after = ids(runBook([g('a'), g('b'), entry('z', { constant: true, probability: 50 })], [], { seed }).fired).filter((id) => id !== 'z');
      expect([seed, after]).toEqual([seed, before]);
    }
  });

  test('group draws and probability rolls use separate streams', () => {
    // Groups are drawn before any roll of the loop; 'p' (first in gather order) still reads the
    // first value of 'lore.prob', whatever the group draw consumed.
    for (let seed = 0; seed < 60; seed++) {
      const alone = ids(runBook([entry('p', { constant: true, probability: 50 })], [], { seed }).fired);
      const withGroup: string[] = ids(runBook([entry('p', { constant: true, probability: 50, order: 500 }), g('a'), g('b')], [], { seed }).fired).filter((id) => id === 'p');
      expect([seed, withGroup]).toEqual([seed, alone]);
    }
  });
});

describe('sticky members and earlier loops', () => {
  test('a sticky member wins without a draw; the other members lose', () => {
    const fires = [{ book: 'b', id: 'st', why: 'key', at: 1 }];
    for (let seed = 0; seed < 30; seed++) {
      const res = runBook([g('a', { order: 900 }), g('st', { constant: false, keys: ['zz'], sticky: 4 }), g('c')], [], { seed, fires, chatLength: 2 });
      expect(whys(res)).toEqual({ a: '-group-lost', st: '+sticky', c: '-group-lost' });
    }
  });

  test('a group already represented by an earlier loop: later members lose', () => {
    const res = runBook([g('a', { content: 'wakes the dragon' }), entry('b', { keys: ['dragon'], groups: ['g'] })]);
    expect(whys(res)).toEqual({ a: '+constant', b: '-group-lost' });
    expect(verdict(res, 'b')).toMatchObject({ loop: 1, matched: ['dragon'] });
  });

  test('a member that lost to a winner which then failed its roll gets another chance next loop', () => {
    // Loop 0: 'win' (weight 100) beats 'other' (weight 0) but fails its roll; 'gate' feeds recursion.
    // Loop 1: 'other' is looked at again, the group is not represented, and it fires alone.
    const res = runBook([
      entry('gate', { constant: true, content: 'more' }),
      g('win', { probability: 0, groupWeight: 100 }),
      g('other', { groupWeight: 0 }),
    ]);
    expect(whys(res)).toEqual({ gate: '+constant', win: '-chance', other: '+constant' });
    expect(res.fired.find((h) => h.id === 'other')?.loop).toBe(1);
  });

  test('several groups per entry: losing one group takes it out of the others (ST removeEntry)', () => {
    // g = [a, b] is drawn first, then h = [a, c]. a can win g and still lose h, leaving g empty.
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const res = runBook([g('a', { groups: ['g', 'h'] }), g('b'), entry('c', { constant: true, groups: ['h'] })], [], { seed }, { recursive: false });
      seen.add(ids(res.fired).sort().join(','));
    }
    expect([...seen].sort()).toEqual(['a', 'b,c', 'c']);
  });
});

describe('a group loser seen again in a recursion loop', () => {
  test("matched by the chat text it is a 'key' fire, not 'recursion'; a recursion-woken entry still says recursion", () => {
    // A constant feeder's text holds 'tide' (wakes w in loop 1); g0/g1 share group 'grp' with 50 %,
    // their key 'storm' is in the user's message. When the loop-0 winner fails its roll, the loser
    // is drawn again in loop 1 — where it still matched the chat text.
    const book = [
      entry('feeder', { constant: true, content: 'the tide turns' }),
      entry('g0', { keys: ['storm'], groups: ['grp'], probability: 50 }),
      entry('g1', { keys: ['storm'], groups: ['grp'], probability: 50 }),
      entry('w', { keys: ['tide'] }),
    ];
    let redrawn = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const res = runBook(book, ['Levi: a storm'], { seed });
      for (const h of res.fired) {
        if (h.id === 'g0' || h.id === 'g1') {
          expect(h.why).toBe('key');
          if (h.loop > 0) redrawn++;
        }
        if (h.id === 'w') expect(h.why).toBe('recursion');
      }
      for (const v of res.verdicts ?? []) if ((v.id === 'g0' || v.id === 'g1') && v.fired) expect(v.why).toBe('key');
    }
    expect(redrawn).toBeGreaterThan(0);
  });
});
