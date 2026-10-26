// lore/engine.ts budget: ST order (probability before budget, cumulative '\n'-joined text,
// overflow stops all but ignoreBudget), one `order` axis. Bunraku's budget.test.ts (priority/
// sortOrder split, per-book budgets) does not apply: see .notes/m2-provenance-lore.md.
import { describe, expect, test } from 'bun:test';
import { entry, ids, run, runBook, source, verdict, whys } from './fixtures.ts';

const c = (id: string, content: string, patch = {}) => entry(id, { constant: true, content, ...patch });

describe('cumulative budget (count of all accepted text, each entry followed by a newline)', () => {
  test('accepted while the total stays below the budget', () => {
    // 'aaaa\n' = 5, 'aaaa\nbbbb\n' = 10.
    expect(ids(runBook([c('a', 'aaaa'), c('b', 'bbbb')], [], { budget: 11 }).fired)).toEqual(['a', 'b']);
    const tight = runBook([c('a', 'aaaa'), c('b', 'bbbb')], [], { budget: 10 });
    expect(ids(tight.fired)).toEqual(['a']);
    expect(ids(tight.cut)).toEqual(['b']);
    expect(tight.used).toBe(5);
  });

  test('used is the counted total; without a budget it is still reported', () => {
    expect(runBook([c('a', 'aaaa'), c('b', 'bbbb')], [], { budget: 100 }).used).toBe(10);
    expect(runBook([c('a', 'aaaa'), c('b', 'bbbb')]).used).toBe(10);
    expect(runBook([]).used).toBe(0);
  });

  test('the budget counts the expanded text', () => {
    const expand = (_k: string, s: string) => s.repeat(3);
    const res = runBook([c('a', 'aa')], [], { budget: 6, expand });
    expect(res.fired).toEqual([]);
    expect(res.cut[0]).toMatchObject({ id: 'a', text: 'aaaaaa', tokens: 6 });
    // 'aaaaaa\n' would cost 7 of the 6 tokens; at most 5 more could still be added (the check is strict).
    expect(verdict(res, 'a').detail).toEqual({ cost: 7, left: 5 });
    expect(ids(runBook([c('a', 'aa')], [], { budget: 6 }).fired)).toEqual(['a']);
  });

  test('the counter decides near the budget: the joined text is counted, not the sum of the entries', () => {
    // Two or more entries cost 2 tokens more than their lengths: 'aaa\n' = 4, 'aaa\nbbb\n' = 10.
    const count = (t: string) => t.length + (t.indexOf('\n') >= 0 && t.indexOf('\n') < t.length - 1 ? 2 : 0);
    const res = runBook([c('a', 'aaa'), c('b', 'bbb')], [], { budget: 10, count, explain: true });
    expect(ids(res.fired)).toEqual(['a']);
    expect(ids(res.cut)).toEqual(['b']);
    expect(verdict(res, 'b').detail).toEqual({ cost: 6, left: 5 });
    expect(ids(runBook([c('a', 'aaa'), c('b', 'bbb')], [], { budget: 11, count }).fired)).toEqual(['a', 'b']);
  });

  test("a cut entry's detail reads as not fitting: cost is the marginal cost of the check, left what could still fit", () => {
    // Regression: budget 250, a = 199 chars, b = 49 chars. 'a…\nb…\n' = 250 is not < 250, yet the
    // verdict said "cost 49, left 50".
    const res = runBook([c('a', 'a'.repeat(199)), c('b', 'b'.repeat(49))], [], { budget: 250, explain: true });
    expect(ids(res.cut)).toEqual(['b']);
    const d = verdict(res, 'b').detail!;
    expect(d).toEqual({ cost: 50, left: 49 });
    expect(d.cost!).toBeGreaterThan(d.left!);
  });

  test('cost stays linear: hundreds of fired entries are counted about once each, not once per accepted prefix', () => {
    // Regression: every accepted entry used to count the whole accepted text so far (O(n²) chars).
    const n = 300;
    const entries = Array.from({ length: n }, (_, i) => c(`e${i}`, `${'word '.repeat(60)}${i}`));
    const total = entries.reduce((sum, e) => sum + e.content.length, 0);
    let chars = 0;
    const count = (t: string) => ((chars += t.length), Math.ceil(t.length / 3));
    const res = runBook(entries, [], { budget: 50000, count });
    expect(res.fired).toHaveLength(n);
    expect(chars).toBeLessThan(3 * total);
    // used is still the exact count of the joined text.
    expect(res.used).toBe(Math.ceil(entries.map((e) => `${e.content}\n`).join('').length / 3));
  });

  test('the boundary stays exact when many entries are accepted on the estimate first', () => {
    // 100 entries of 'x' * 29 + '\n' = 30 chars = 10 tokens each with chars/3; budget 1000 takes 99.
    const entries = Array.from({ length: 100 }, (_, i) => c(`e${i}`, 'x'.repeat(29)));
    const count = (t: string) => Math.ceil(t.length / 3);
    const res = runBook(entries, [], { budget: 1000, count, explain: true });
    expect(res.fired).toHaveLength(99);
    expect(ids(res.cut)).toEqual(['e99']);
    expect(res.used).toBe(990);
    expect(verdict(res, 'e99').detail).toEqual({ cost: 10, left: 9 });
  });
});

describe('probability before budget (ST)', () => {
  test('a failed roll consumes no budget; the next entry still fits', () => {
    const res = runBook([c('big', 'x'.repeat(50), { probability: 0, order: 200 }), c('small', 'yyyy')], [], { budget: 6 });
    expect(whys(res)).toEqual({ big: '-chance', small: '+constant' });
    expect(res.cut).toEqual([]);
  });

  test('an entry that would be cut still rolls first: a failed roll is chance, not budget-cut', () => {
    const res = runBook([c('a', 'aaaa'), c('b', 'x'.repeat(50), { probability: 0 })], [], { budget: 6 });
    expect(whys(res)).toEqual({ a: '+constant', b: '-chance' });
  });
});

describe('overflow', () => {
  test('the first entry that does not fit sets the overflow; every later one is cut except ignoreBudget', () => {
    const res = runBook(
      [c('a', 'aaaa', { order: 400 }), c('b', 'x'.repeat(20), { order: 300 }), c('tiny', 't', { order: 200 }), c('free', 'z'.repeat(30), { order: 100, ignoreBudget: true })],
      [],
      { budget: 9 },
    );
    expect(whys(res)).toEqual({ a: '+constant', b: '-budget-cut', tiny: '-budget-cut', free: '+constant' });
    expect(ids(res.fired)).toEqual(['a', 'free']);
    expect(ids(res.cut)).toEqual(['b', 'tiny']);
    // 'tiny' would have fit; after the overflow it is not rolled, not expanded.
    expect(res.cut[1]).toMatchObject({ text: 't', tokens: 1 });
    expect(verdict(res, 'tiny').detail).toEqual({ cost: 1, left: 3, overflowed: true });
  });

  test('entries skipped after the overflow are never rolled nor expanded', () => {
    const expanded: string[] = [];
    runBook([c('a', 'x'.repeat(20)), c('b', 'b', { probability: 0 })], [], { budget: 5, expand: (k, s) => (expanded.push(k), s) });
    expect(expanded).toHaveLength(1);
  });

  test('ignoreBudget entries skip the check but count against the entries after them, as in ST', () => {
    // ST world-info.js: `acceptedContent = nextContent` runs for an ignoreBudget entry too, so the
    // next entry's check sees its text. 'z'×30 + '\n' = 31 ≥ 5 → 'a' overflows.
    const res = runBook([c('free', 'z'.repeat(30), { ignoreBudget: true, order: 500 }), c('a', 'aaa')], [], { budget: 5 });
    expect(whys(res)).toEqual({ free: '+constant', a: '-budget-cut' });
    expect(res.used).toBe(31);
    expect(whys(runBook([c('free', 'zz', { ignoreBudget: true })], [], { budget: 0 }))).toEqual({ free: '+constant' });
  });

  test("the review's case: an ignoreBudget entry ahead of two others leaves room for one", () => {
    // Budget 250, three 99-char entries: IGN\n = 100, IGN\nX\n = 200 < 250, IGN\nX\nY\n = 300 ≥ 250.
    const e99 = (id: string, order: number, patch = {}) => c(id, id.padEnd(99, 'x'), { order, ...patch });
    const res = runBook([e99('IGN', 300, { ignoreBudget: true }), e99('X', 200), e99('Y', 100)], [], { budget: 250 });
    expect(ids(res.fired)).toEqual(['IGN', 'X']);
    expect(ids(res.cut)).toEqual(['Y']);
    expect(res.used).toBe(200);
  });

  test('a zero budget cuts every entry that counts', () => {
    const res = runBook([c('a', 'a')], [], { budget: 0 });
    expect(whys(res)).toEqual({ a: '-budget-cut' });
    expect(verdict(res, 'a').detail).toEqual({ cost: 2, left: 0 });
  });
});

describe('the order axis', () => {
  test('higher order wins the budget, whatever the book order', () => {
    const res = runBook([c('low', 'llll', { order: 10 }), c('high', 'hhhh', { order: 200 })], [], { budget: 6 });
    expect(whys(res)).toEqual({ low: '-budget-cut', high: '+constant' });
  });

  test('equal order: book order wins', () => {
    const res = runBook([c('first', 'ffff'), c('second', 'ssss')], [], { budget: 6 });
    expect(whys(res)).toEqual({ first: '+constant', second: '-budget-cut' });
  });

  test('sticky entries go first, before a higher order', () => {
    const fires = [{ book: 'b', id: 'st', why: 'key', at: 1 }];
    const res = runBook([c('high', 'hhhh', { order: 900 }), entry('st', { keys: ['zz'], content: 'ssss', sticky: 5, order: 1 })], [], { budget: 6, fires, chatLength: 2 });
    expect(whys(res)).toEqual({ high: '-budget-cut', st: '+sticky' });
  });

  test('the cast books come first in the budget (persona, card, then session books), whatever the order', () => {
    const res = run([source('@persona', [c('p', 'pppp', { order: 1 })]), source('@card', [c('k', 'kkkk', { order: 900 })])], { budget: 6 });
    expect(whys(res)).toEqual({ p: '+constant', k: '-budget-cut' });
  });
});
