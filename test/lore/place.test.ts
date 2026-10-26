// lore/place.ts: every position, ST order inside a place, depth inserts kept apart [D-47].
import { describe, expect, test } from 'bun:test';
import type { LoreEntry } from '../../src/formats/native.ts';
import type { LoreHit } from '../../src/lore/engine.ts';
import { placeLore } from '../../src/lore/place.ts';
import { entry } from './fixtures.ts';

const hit = (id: string, position: LoreEntry['position'], patch: Partial<LoreEntry> = {}, text = `${id}!`): LoreHit => ({
  book: 'bk',
  id,
  entry: entry(id, { position, ...patch }),
  text,
  tokens: text.length,
  why: 'constant',
  matched: [],
  loop: 0,
});

describe('placeLore', () => {
  test('every position lands in its place', () => {
    const p = placeLore([
      hit('b', 'before'),
      hit('a', 'after'),
      hit('eb', 'examples_before'),
      hit('ea', 'examples_after'),
      hit('nb', 'note_before'),
      hit('na', 'note_after'),
      hit('t', 'top'),
      hit('bo', 'bottom'),
      hit('r', 'recap'),
      hit('o', { outlet: 'Map' }),
      hit('d', { depth: 2, role: 'user' }),
    ]);
    expect(p.slots).toEqual({ before: ['b!'], after: ['a!'], examples_before: ['eb!'], examples_after: ['ea!'] });
    expect([p.noteBefore, p.noteAfter, p.top, p.bottom, p.recap]).toEqual([['nb!'], ['na!'], ['t!'], ['bo!'], ['r!']]);
    expect({ ...p.outlets }).toEqual({ Map: ['o!'] });
    expect(p.depth).toEqual([{ depth: 2, role: 'user', src: 'lore', srcId: 'bk:d', text: 'd!' }]);
  });

  test('order ascending within a place (highest nearest the chat), ties in reverse acceptance order (ST unshifts)', () => {
    const p = placeLore([hit('x', 'before', { order: 300 }), hit('y', 'before'), hit('z', 'before', { order: 5 }), hit('w', 'before')]);
    expect(p.slots.before).toEqual(['z!', 'w!', 'y!', 'x!']);
    // the same rule at a depth: ST unshifts into the (depth, role) group
    const d = placeLore([hit('a', { depth: 1 }), hit('b', { depth: 1 }), hit('c', { depth: 1 }, { order: 50 })]);
    expect(d.depth.map((x) => x.srcId)).toEqual(['bk:c', 'bk:b', 'bk:a']);
  });

  test("depth inserts: one per entry, default role system, in entry order but with no order of their own (ST's order-100 group)", () => {
    const p = placeLore([hit('a', { depth: 4 }, { order: 7 }), hit('b', { depth: 4 }, { order: 3 }), hit('c', { depth: 0, role: 'assistant' })]);
    expect(p.depth.map((d) => [d.srcId, d.depth, d.role, d.order])).toEqual([
      ['bk:b', 4, 'system', undefined],
      ['bk:a', 4, 'system', undefined],
      ['bk:c', 0, 'assistant', undefined],
    ]);
  });

  test('outlet names are trimmed; a nameless outlet is dropped; any name is safe', () => {
    const p = placeLore([hit('a', { outlet: ' Map ' }), hit('b', { outlet: 'Map' }), hit('c', { outlet: '  ' }), hit('d', { outlet: '__proto__' })]);
    expect(p.outlets.Map).toEqual(['b!', 'a!']);
    expect(Object.keys(p.outlets).sort()).toEqual(['Map', '__proto__']);
    expect(p.outlets['__proto__']).toEqual(['d!']);
  });

  test('an entry with empty text is not placed (ST)', () => {
    const p = placeLore([hit('a', 'before', {}, ''), hit('b', 'before', {}, ' '), hit('c', { depth: 1 }, {}, '')]);
    expect(p.slots.before).toEqual([' ']);
    expect(p.depth).toEqual([]);
  });

  test('nothing fired: everything empty', () => {
    const p = placeLore([]);
    expect(p.slots).toEqual({ before: [], after: [], examples_before: [], examples_after: [] });
    expect([p.noteBefore, p.noteAfter, p.top, p.bottom, p.recap, p.depth]).toEqual([[], [], [], [], [], []]);
    expect(Object.keys(p.outlets)).toEqual([]);
  });
});
