// Ported from Bunraku:src/core/lore/engine/engine.test.ts, explain.test.ts and engine.regressions.test.ts@702d8120 (scenarios that still apply).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lore/engine.ts: activation, every fire and skip reason, effective settings, verdicts, timers,
// determinism. Scenarios adapted from Bunraku src/core/lore/engine/engine.test.ts, explain.test.ts and
// engine.regressions.test.ts @702d8120 where they still apply (see .notes/m2-provenance-lore.md).
import { describe, expect, test } from 'bun:test';
import { entryKey, entryLabel, runLore, type LoreRunResult } from '../../src/lore/engine.ts';
import type { PastFire } from '../../src/lore/timers.ts';
import { entry, ids, run, runBook, source, verdict, whys } from './fixtures.ts';

describe('fire reasons', () => {
  test('constant fires without keys or scan text', () => {
    const res = runBook([entry('c', { constant: true })]);
    expect(ids(res.fired)).toEqual(['c']);
    expect(res.fired[0]).toMatchObject({ book: 'b', why: 'constant', matched: [], loop: 0, text: 'c text', tokens: 6 });
  });

  test('a primary key match fires as key, with the matched keys', () => {
    const res = runBook([entry('k', { keys: ['castle', 'moat', 'dragon'] })], ['Levi: the dragon by the castle']);
    expect(res.fired[0]).toMatchObject({ why: 'key', matched: ['castle', 'dragon'] });
  });

  test('secondary keys passing their logic fire as secondary; matched holds both sides', () => {
    const res = runBook([entry('s', { keys: ['dragon'], secondary: ['cave', 'gold'], logic: 'and_any' })], ['Levi: a dragon guards the cave']);
    expect(res.fired[0]).toMatchObject({ why: 'secondary', matched: ['dragon', 'cave'] });
  });

  test('a missing logic is and_any', () => {
    const hit = runBook([entry('s', { keys: ['dragon'], secondary: ['gold'] })], ['Levi: a dragon']);
    expect(whys(hit)).toEqual({ s: '-secondary-logic' });
    const ok = runBook([entry('s', { keys: ['dragon'], secondary: ['gold'] })], ['Levi: a dragon and gold']);
    expect(whys(ok)).toEqual({ s: '+secondary' });
  });

  test('blank secondary keys are ignored (ST)', () => {
    const res = runBook([entry('s', { keys: ['dragon'], secondary: ['', '  '], logic: 'and_all' })], ['Levi: a dragon']);
    expect(whys(res)).toEqual({ s: '+key' });
  });

  test('the secondary logic table through the engine', () => {
    const scan = ['Levi: dragon cave'];
    const mk = (logic: 'and_any' | 'and_all' | 'not_any' | 'not_all') => entry(logic, { keys: ['dragon'], secondary: ['cave', 'gold'], logic });
    const res = runBook([mk('and_any'), mk('and_all'), mk('not_any'), mk('not_all')], scan);
    expect(whys(res)).toEqual({ and_any: '+secondary', and_all: '-secondary-logic', not_any: '-secondary-logic', not_all: '+secondary' });
    expect(verdict(res, 'and_all').matched).toEqual(['dragon']);
  });

  test('sticky: a fresh fire within the window fires again without a key match', () => {
    const fires: PastFire[] = [{ book: 'b', id: 'e', why: 'key', at: 3 }];
    const res = runBook([entry('e', { keys: ['dragon'], sticky: 3 })], ['Levi: nothing'], { fires, chatLength: 5 });
    expect(res.fired[0]).toMatchObject({ why: 'sticky', matched: [] });
    expect(verdict(res, 'e').detail).toEqual({ remaining: 1 });
  });

  test('recursion: an accepted entry text wakes another, loop 1', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'the map leads to a dragon' }), entry('woken', { keys: ['dragon'] })], ['Levi: show me the map']);
    expect(ids(res.fired)).toEqual(['gate', 'woken']);
    expect(res.fired[1]).toMatchObject({ why: 'recursion', loop: 1, matched: ['dragon'] });
  });
});

describe('skip reasons', () => {
  test('disabled: never fires, still gets a verdict', () => {
    const res = runBook([entry('d', { enabled: false, constant: true })]);
    expect(res.fired).toEqual([]);
    expect(verdict(res, 'd')).toMatchObject({ fired: false, why: 'disabled', loop: 0, tokens: 6 });
  });

  test('no-key-match: no match and nothing in cut; an entry with no keys never fires', () => {
    const res = runBook([entry('k', { keys: ['dragon'] }), entry('none')], ['Levi: a quiet day']);
    expect(res.fired).toEqual([]);
    expect(res.cut).toEqual([]);
    expect(whys(res)).toEqual({ k: '-no-key-match', none: '-no-key-match' });
  });

  test('chance: probability 0 never fires and draws nothing; 100 never rolls', () => {
    const res = runBook([entry('never', { constant: true, probability: 0 }), entry('always', { constant: true, probability: 100 })]);
    expect(whys(res)).toEqual({ never: '-chance', always: '+constant' });
    expect(verdict(res, 'never').detail).toEqual({ needed: 0 });
    expect(verdict(res, 'always').detail).toBeUndefined();
  });

  test('chance: a real roll records rolled and needed on the 0–1 scale, passed or not', () => {
    const seen = new Set<boolean>();
    for (let seed = 0; seed < 40; seed++) {
      const res = runBook([entry('half', { constant: true, probability: 50 })], [], { seed });
      const v = verdict(res, 'half');
      expect(v.detail?.needed).toBe(0.5);
      expect(v.detail?.rolled).toBeGreaterThanOrEqual(0);
      expect(v.detail?.rolled).toBeLessThan(1);
      expect(v.fired).toBe((v.detail?.rolled as number) < 0.5);
      expect(v.why).toBe(v.fired ? 'constant' : 'chance');
      seen.add(v.fired);
    }
    expect(seen.size).toBe(2);
  });

  test('cooldown blocks even a real key match, with remaining messages', () => {
    const fires: PastFire[] = [{ book: 'b', id: 'e', why: 'key', at: 4 }];
    const res = runBook([entry('e', { keys: ['dragon'], sticky: 1, cooldown: 5 })], ['Levi: a dragon'], { fires, chatLength: 6 });
    expect(verdict(res, 'e')).toMatchObject({ fired: false, why: 'cooldown', detail: { remaining: 4 } });
  });

  test('delay blocks until the chat has N messages, constants included (ST)', () => {
    const e = entry('late', { keys: ['storm'], delay: 5 });
    const c = entry('lateConst', { constant: true, delay: 5 });
    const early = runBook([e, c], ['Levi: the storm'], { chatLength: 3 });
    expect(whys(early)).toEqual({ late: '-delay', lateConst: '-delay' });
    expect(verdict(early, 'late').detail).toEqual({ remaining: 2 });
    const ready = runBook([e, c], ['Levi: the storm'], { chatLength: 5 });
    expect(whys(ready)).toEqual({ late: '+key', lateConst: '+constant' });
  });

  test('budget-cut, with cost and what was left', () => {
    const res = runBook([entry('a', { constant: true, content: 'aaaa' }), entry('b', { constant: true, content: 'bbbbbbbb' })], [], { budget: 8 });
    expect(ids(res.fired)).toEqual(['a']);
    expect(ids(res.cut)).toEqual(['b']);
    // cost: what the entry would have added, its '\n' included ('aaaa\nbbbbbbbb\n' = 14 minus 5);
    // left: the most an entry could still add (the check is strict, 14 < 8 fails).
    expect(verdict(res, 'b')).toMatchObject({ fired: false, why: 'budget-cut', tokens: 8, detail: { cost: 9, left: 2 } });
  });

  test('exclude-recursion: the entry would have been woken by recursion text', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'a dragon' }), entry('ex', { keys: ['dragon'], excludeRecursion: true })], ['Levi: the map']);
    expect(whys(res)).toEqual({ gate: '+key', ex: '-exclude-recursion' });
    expect(verdict(res, 'ex')).toMatchObject({ loop: 1, matched: ['dragon'] });
  });

  test('exclude-recursion entries still fire on a direct match', () => {
    const res = runBook([entry('ex', { keys: ['dragon'], excludeRecursion: true })], ['Levi: a dragon']);
    expect(whys(res)).toEqual({ ex: '+key' });
  });

  test('an excludeRecursion entry that recursion would not wake stays no-key-match', () => {
    const res = runBook([entry('gate', { keys: ['map'], content: 'a cat' }), entry('ex', { keys: ['dragon'], excludeRecursion: true })], ['Levi: the map']);
    expect(whys(res)).toEqual({ gate: '+key', ex: '-no-key-match' });
  });

  test('group-lost: the losing side of an inclusion group', () => {
    const res = runBook([entry('a', { constant: true, groups: ['g'], groupWeight: 100 }), entry('b', { constant: true, groups: ['g'], groupWeight: 0 })]);
    expect(whys(res)).toEqual({ a: '+constant', b: '-group-lost' });
  });

  test('regex-error: no match and a key that did not compile', () => {
    const res = runBook([entry('r', { keys: ['/(?<=a)b/'] }), entry('ok', { keys: ['/(?<=x)y/', 'dragon'] })], ['Levi: ab dragon']);
    expect(whys(res)).toEqual({ r: '-regex-error', ok: '+key' });
    expect(verdict(res, 'r').regexErrors).toEqual(['/(?<=a)b/']);
    expect(verdict(res, 'ok').regexErrors).toEqual(['/(?<=x)y/']);
    expect(res.regexErrors.map((e) => [e.book, e.id, e.key])).toEqual([
      ['b', 'r', '/(?<=a)b/'],
      ['b', 'ok', '/(?<=x)y/'],
    ]);
    expect(res.regexErrors[0]?.message).toContain('invalid');
  });

  test('regex errors are reported once per entry even when it is matched in several loops', () => {
    const res = runBook(
      [entry('gate', { keys: ['map'], content: 'more text' }), entry('r', { keys: ['/(?<=a)b/'] }), entry('g2', { keys: ['more'], content: 'and more' })],
      ['Levi: the map'],
    );
    expect(res.regexErrors).toHaveLength(1);
    expect(whys(res)).toEqual({ gate: '+key', r: '-regex-error', g2: '+recursion' });
  });
});

describe('effective settings: entry → book → SillyBunny defaults', () => {
  const scan = ['Levi: newest', 'Mira: middle', 'Levi: oldest dragon'];

  test('scanDepth: default 2, book overrides, entry overrides the book', () => {
    expect(whys(runBook([entry('e', { keys: ['dragon'] })], scan))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook([entry('e', { keys: ['dragon'] })], scan, {}, { scanDepth: 3 }))).toEqual({ e: '+key' });
    expect(whys(runBook([entry('e', { keys: ['dragon'], scanDepth: 1 })], scan, {}, { scanDepth: 3 }))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook([entry('e', { keys: ['dragon'], scanDepth: 3 })], scan, {}, { scanDepth: 1 }))).toEqual({ e: '+key' });
    expect(whys(runBook([entry('e', { keys: ['newest'], scanDepth: 0 })], scan))).toEqual({ e: '-no-key-match' });
  });

  test('caseSensitive: default off, book on, entry off again', () => {
    const s = ['Levi: a dragon'];
    expect(whys(runBook([entry('e', { keys: ['Dragon'] })], s))).toEqual({ e: '+key' });
    expect(whys(runBook([entry('e', { keys: ['Dragon'] })], s, {}, { caseSensitive: true }))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook([entry('e', { keys: ['Dragon'], caseSensitive: false })], s, {}, { caseSensitive: true }))).toEqual({ e: '+key' });
  });

  test('wholeWords: default on, book off, entry on again', () => {
    const s = ['Levi: dragonfly'];
    expect(whys(runBook([entry('e', { keys: ['dragon'] })], s))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook([entry('e', { keys: ['dragon'] })], s, {}, { wholeWords: false }))).toEqual({ e: '+key' });
    expect(whys(runBook([entry('e', { keys: ['dragon'], wholeWords: true })], s, {}, { wholeWords: false }))).toEqual({ e: '-no-key-match' });
  });

  test("book match 'stem' matches by stems (M3)", () => {
    expect(whys(runBook([entry('e', { keys: ['караван'] })], ['Levi: у каравана'], {}, { match: 'stem' }))).toEqual({ e: '+key' });
    expect(whys(runBook([entry('e', { keys: ['караван'] })], ['Levi: наш караван'], {}, { match: 'stem' }))).toEqual({ e: '+key' });
  });

  test('entries with meta.type are ordinary entries in M2', () => {
    const res = runBook([entry('npc', { keys: ['Mira'], meta: { type: 'character', aliases: ['M'] } })], ['Mira: hello']);
    expect(whys(res)).toEqual({ npc: '+key' });
  });

  test('a key naming a speaker fires while that speaker talks ("Name: text")', () => {
    const res = runBook([entry('mira', { keys: ['Mira'] })], ['Mira: I am here', 'Levi: hi']);
    expect(whys(res)).toEqual({ mira: '+key' });
  });
});

describe('verdicts [D-45]', () => {
  test('exactly one per entry of every source: sources in input order, entries in book order', () => {
    const res = run(
      [
        source('@persona', [entry('p1', { constant: true, order: 1 }), entry('p2', { enabled: false })]),
        source('@card', [entry('c1', { keys: ['x'] }), entry('c2', { constant: true, order: 500, title: 'Second' })]),
        source('lib', [entry('l1', { constant: true })]),
      ],
      { scan: ['Levi: nothing'] },
    );
    expect(res.verdicts?.map((v) => entryLabel(v.book, v.id))).toEqual(['@persona:p1', '@persona:p2', '@card:c1', '@card:c2', 'lib:l1']);
    expect(res.verdicts?.map((v) => v.why)).toEqual(['constant', 'disabled', 'no-key-match', 'constant', 'constant']);
    expect(verdict(res, 'c2').title).toBe('Second');
    expect(verdict(res, 'c1').title).toBeUndefined();
  });

  test('verdict tokens: expanded text when it got that far, raw content otherwise', () => {
    const res = runBook([entry('e', { constant: true, content: 'ab' }), entry('n', { keys: ['zz'], content: 'abc' })], [], { expand: (_k, c) => `${c}${c}` });
    expect(verdict(res, 'e').tokens).toBe(4);
    expect(verdict(res, 'n').tokens).toBe(3);
  });

  test('explain off: no verdicts, the same outcome', () => {
    const entries = [entry('a', { constant: true }), entry('b', { keys: ['x'] }), entry('c', { constant: true, probability: 0 })];
    const on = runBook(entries, ['Levi: x']);
    const off = runBook(entries, ['Levi: x'], { explain: false });
    expect(off.verdicts).toBeUndefined();
    expect(off.fired).toEqual(on.fired);
    expect(off.cut).toEqual(on.cut);
    expect(off.used).toBe(on.used);
  });

  test('explain only adds verdicts: its exclude-recursion look reports no extra regex errors', () => {
    const entries = [entry('gate', { keys: ['map'], content: 'a dragon' }), entry('ex', { keys: ['dragon'], secondary: ['/(?<=x)y/'], logic: 'not_any', excludeRecursion: true })];
    const on = runBook(entries, ['Levi: the map']);
    const off = runBook(entries, ['Levi: the map'], { explain: false });
    expect(verdict(on, 'ex').why).toBe('exclude-recursion');
    expect(on.regexErrors).toEqual([]);
    expect(off.regexErrors).toEqual([]);
  });

  test('explain off counts nothing it does not need', () => {
    const counted: string[] = [];
    runBook([entry('a', { constant: true, content: 'A' }), entry('b', { keys: ['zz'], content: 'B' }), entry('c', { enabled: false, content: 'C' })], [], {
      explain: false,
      count: (t) => (counted.push(t), t.length),
    });
    // The fired entry's tokens, then `used` once at the end (no budget: no per-entry total).
    expect(counted).toEqual(['A', 'A\n']);
  });
});

describe('gather order and expand', () => {
  test('session books are one group sorted by order descending (missing = 100), stable; ties keep source order', () => {
    const res = run([
      source('one', [entry('lo', { constant: true, order: 5 }), entry('mid', { constant: true }), entry('hi', { constant: true, order: 300 }), entry('mid2', { constant: true })]),
      source('two', [entry('top', { constant: true, order: 999 }), entry('tie', { constant: true })]),
    ]);
    expect(res.fired.map((h) => entryLabel(h.book, h.id))).toEqual(['two:top', 'one:hi', 'one:mid', 'one:mid2', 'two:tie', 'one:lo']);
  });

  test('the persona and card books come first, each sorted on its own, whatever the session books order', () => {
    const res = run([
      source('@persona', [entry('p', { constant: true, order: 1 })]),
      source('@card', [entry('k1', { constant: true, order: 2 }), entry('k2', { constant: true, order: 3 })]),
      source('a', [entry('a', { constant: true, order: 900 })]),
      source('b', [entry('b', { constant: true, order: 950 })]),
    ]);
    expect(res.fired.map((h) => entryLabel(h.book, h.id))).toEqual(['@persona:p', '@card:k2', '@card:k1', 'b:b', 'a:a']);
  });

  test("two session books under budget pressure: the higher order wins, whichever book it is in (ST merges its global worlds)", () => {
    // Regression: each book used to be sorted on its own and the books concatenated, so book a's
    // low-order entry took the budget ahead of book b's high-order one.
    const res = run(
      [source('a', [entry('A-low', { constant: true, order: 10, content: 'x'.repeat(99) })]), source('b', [entry('B-high', { constant: true, order: 500, content: 'y'.repeat(99) })])],
      { budget: 150, explain: true },
    );
    expect(res.fired.map((h) => h.id)).toEqual(['B-high']);
    expect(res.cut.map((h) => h.id)).toEqual(['A-low']);
    // Verdict slots still follow the sources: book a's verdict first.
    expect(res.verdicts?.map((v) => `${v.book}:${v.id}:${v.why}`)).toEqual(['a:A-low:budget-cut', 'b:B-high:constant']);
  });

  test('expand is called once per entry that passes its roll, with entryKey, and its text is placed', () => {
    const calls: string[] = [];
    const res = run([source('bk', [entry('a', { constant: true, content: 'A {{x}}' }), entry('z', { constant: true, probability: 0 }), entry('n', { keys: ['q'] })])], {
      expand: (key, content) => (calls.push(key), content.replace('{{x}}', 'X')),
    });
    expect(calls).toEqual([entryKey('bk', 'a')]);
    expect(res.fired[0]?.text).toBe('A X');
  });

  test('the same entry id in two books is two entries', () => {
    const res = run([source('one', [entry('e', { constant: true })]), source('two', [entry('e', { constant: true })])]);
    expect(res.fired.map((h) => entryLabel(h.book, h.id))).toEqual(['one:e', 'two:e']);
  });
});

describe('timers across turns (fires derived from earlier results)', () => {
  // One book, entry e: key 'dragon', sticky 3, cooldown 2. Each turn is run at the given chat length;
  // its fires become PastFires at that length (the reply's path index), as pathFires would give them.
  const e = entry('e', { keys: ['dragon'], sticky: 3, cooldown: 2 });
  const history: PastFire[] = [];
  const turn = (chatLength: number, text: string): LoreRunResult => {
    const res = runBook([e], [`Levi: ${text}`], { fires: [...history], chatLength });
    for (const h of res.fired) history.push({ book: h.book, id: h.id, why: h.why, at: chatLength });
    return res;
  };

  test('sticky 3 after a fresh fire at L keeps it in through L+2; cooldown 2 blocks L+3 and L+4; free at L+5', () => {
    expect(whys(turn(2, 'a dragon'))).toEqual({ e: '+key' });
    expect(whys(turn(3, 'nothing'))).toEqual({ e: '+sticky' });
    expect(whys(turn(4, 'nothing'))).toEqual({ e: '+sticky' });
    // The two reinjections did not restart the window: it closed at 5.
    const c1 = turn(5, 'a dragon again');
    expect(verdict(c1, 'e')).toMatchObject({ why: 'cooldown', detail: { remaining: 2 } });
    expect(verdict(turn(6, 'dragon'), 'e')).toMatchObject({ why: 'cooldown', detail: { remaining: 1 } });
    expect(whys(turn(7, 'dragon'))).toEqual({ e: '+key' });
    expect(whys(turn(8, 'nothing'))).toEqual({ e: '+sticky' });
  });

  test('a sticky constant entry records sticky inside its window, so the window still ends', () => {
    const c = entry('c', { constant: true, sticky: 2, cooldown: 1 });
    const fires: PastFire[] = [];
    const at = (n: number): string => {
      const res = runBook([c], [], { fires: [...fires], chatLength: n });
      for (const h of res.fired) fires.push({ book: h.book, id: h.id, why: h.why, at: n });
      return whys(res).c as string;
    };
    expect([at(1), at(2), at(3), at(4)]).toEqual(['+constant', '+sticky', '-cooldown', '+constant']);
  });

  test('sticky entries bypass the probability roll', () => {
    const fires: PastFire[] = [{ book: 'b', id: 'p', why: 'key', at: 1 }];
    const res = runBook([entry('p', { keys: ['x'], probability: 0, sticky: 5 })], [], { fires, chatLength: 2 });
    expect(whys(res)).toEqual({ p: '+sticky' });
  });
});

describe('seeded determinism (D-44)', () => {
  const half = (id: string, patch = {}) => entry(id, { keys: ['dragon'], probability: 50, ...patch });

  test('the same seed gives the same result', () => {
    const a = runBook([half('a'), half('b')], ['Levi: dragon'], { seed: 42 });
    const b = runBook([half('a'), half('b')], ['Levi: dragon'], { seed: 42 });
    expect(a).toEqual(b);
  });

  test('a 50 % entry fires on some seeds and not on others, about half the time', () => {
    let n = 0;
    for (let seed = 0; seed < 1000; seed++) n += runBook([half('a')], ['Levi: dragon'], { seed }).fired.length;
    expect(n).toBeGreaterThan(440);
    expect(n).toBeLessThan(560);
  });

  test('adding an unrelated entry later in the order never changes earlier draws', () => {
    for (let seed = 0; seed < 100; seed++) {
      const before = runBook([half('a'), half('b')], ['Levi: dragon'], { seed });
      const after = runBook([half('a'), half('b'), half('c')], ['Levi: dragon'], { seed });
      expect([seed, ids(after.fired).filter((id) => id !== 'c')]).toEqual([seed, ids(before.fired)]);
    }
  });

  test('…even when the earlier entry rolls in a later recursion loop', () => {
    const gate = entry('gate', { constant: true, content: 'a wyvern' });
    const late = entry('late', { keys: ['wyvern'], probability: 50 });
    for (let seed = 0; seed < 100; seed++) {
      const before = runBook([gate, late], ['Levi: dragon'], { seed });
      const after = runBook([gate, late, half('c')], ['Levi: dragon'], { seed });
      expect([seed, ids(after.fired).includes('late')]).toEqual([seed, ids(before.fired).includes('late')]);
    }
  });

  test('disabling an entry does not reshuffle the others', () => {
    for (let seed = 0; seed < 50; seed++) {
      const on = runBook([half('a'), half('b'), half('c')], ['Levi: dragon'], { seed });
      const off = runBook([half('a'), half('b', { enabled: false }), half('c')], ['Levi: dragon'], { seed });
      expect([seed, ids(off.fired)]).toEqual([seed, ids(on.fired).filter((id) => id !== 'b')]);
    }
  });

  test('runLore is pure: inputs are not mutated', () => {
    const books = [source('b', [half('a'), entry('c', { constant: true, groups: ['g'] }), entry('d', { constant: true, groups: ['g'] })])];
    const copy = structuredClone(books);
    runLore({ sources: books, scan: ['Levi: dragon'], chatLength: 1, fires: [], seed: 3, budget: 10, count: (t) => t.length, expand: (_k, c) => c, explain: true });
    expect(books).toEqual(copy);
  });
});
