// {{random}}, {{pick}}, {{roll}} on the seed (ARCHITECTURE.md §6.9, D-43, D-44).
import { describe, expect, test } from 'bun:test';
import { hashString, mulberry32, subRng } from '../../src/prompt/rng.ts';
import { expand, run } from './env.ts';

/** The index a draw from `rng` picks out of n, as the engine computes it. */
const idx = (rng: () => number, n: number): number => Math.floor(rng() * n);

describe('{{random}} (ST list pick)', () => {
  test('picks one of the :: options', () => {
    for (let seed = 0; seed < 30; seed++) expect(['a', 'b', 'c']).toContain(expand('{{random::a::b::c}}', { seed }));
  });

  test('numbers are list items, not a range (D-43): {{random::1::10}} gives 1 or 10', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) seen.add(expand('{{random::1::10}}', { seed }));
    expect([...seen].sort()).toEqual(['1', '10']);
  });

  test('a single comma-separated arg is split, with \\, as a literal comma', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 80; seed++) seen.add(expand('{{random::x, y\\,z ,w}}', { seed }));
    expect([...seen].sort()).toEqual(['w', 'x', 'y,z']);
  });

  test('ST space forms {{random a,b}} and {{pick a,b}} (D-43)', () => {
    const r = new Set<string>();
    for (let seed = 0; seed < 40; seed++) r.add(expand('{{random a,b}}', { seed }));
    expect([...r].sort()).toEqual(['a', 'b']);
    expect(['a', 'b']).toContain(expand('{{pick a,b}}'));
    expect(['x y', 'z']).toContain(expand('{{RANDOM x y, z}}'));
  });

  test('single-colon legacy form {{random:a,b}}', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) seen.add(expand('{{random:left,right}}', { seed }));
    expect([...seen].sort()).toEqual(['left', 'right']);
    // colons after the first are part of the item, as in ST's legacy comma split
    expect(expand('{{random:12:30}}')).toBe('12:30');
    // ST's legacy regex allows spaces around the single colon
    for (let seed = 0; seed < 20; seed++) expect(['up', 'down']).toContain(expand('{{random : up, down}}', { seed }));
    expect(expand('{{roll: 1d1}}')).toBe('1');
  });

  test('no options renders empty', () => {
    expect(expand('[{{random}}]')).toBe('[]');
    expect(expand('[{{random::}}]')).toBe('[]');
  });

  test('draws come from subRng(seed, "macro:" + source), in order of appearance', () => {
    const r = subRng(42, 'macro:main');
    const want = [['a', 'b', 'c'], ['d', 'e'], ['f', 'g', 'h', 'i']].map((opts) => opts[idx(r, opts.length)]).join(' ');
    expect(expand('{{random::a::b::c}} {{random::d::e}} {{random::f::g::h::i}}', { seed: 42 })).toBe(want);
  });

  test('nested randoms draw innermost first', () => {
    const r = subRng(9, 'macro:main');
    const inner = ['x', 'y'][idx(r, 2)] as string;
    const outer = [inner, 'z'][idx(r, 2)] as string;
    expect(expand('{{random::{{random::x::y}}::z}}', { seed: 9 })).toBe(outer);
  });

  test('deterministic per seed + source; the seed matters', () => {
    const tpl = Array.from({ length: 12 }, () => '{{random::a::b::c::d::e::f}}').join('');
    expect(expand(tpl, { seed: 5 })).toBe(expand(tpl, { seed: 5 }));
    expect(expand(tpl, { seed: 5 }, 'main')).not.toBe(expand(tpl, { seed: 6 }, 'main'));
    expect(expand(tpl, { seed: 5 }, 'main')).not.toBe(expand(tpl, { seed: 5 }, 'author_note'));
  });

  test('sources are independent: adding a block does not change another block draws', () => {
    const tpl = Array.from({ length: 8 }, () => '{{random::1::2::3::4::5::6::7::8::9}}').join(',');
    const a = run({ seed: 77 });
    const before = [a.block(tpl, 'main'), a.block(tpl, 'author_note')];
    const b = run({ seed: 77 });
    b.block(tpl + tpl + tpl, 'new_block'); // drawn first, from its own stream
    const after = [b.block(tpl, 'main'), b.block(tpl, 'author_note')];
    expect(after).toEqual(before);
  });

  test('a source used twice in a run continues its stream instead of repeating draws', () => {
    const r = run({ seed: 3 });
    const tpl = Array.from({ length: 10 }, () => '{{random::a::b::c::d}}').join('');
    const s = subRng(3, 'macro:main');
    const want = (): string => Array.from({ length: 10 }, () => ['a', 'b', 'c', 'd'][idx(s, 4)]).join('');
    expect(r.block(tpl, 'main')).toBe(want());
    expect(r.block(tpl, 'main')).toBe(want());
  });
});

describe('{{roll}}', () => {
  test('{{roll::1d20}} is the next draw of the block stream', () => {
    const r = subRng(11, 'macro:main');
    expect(expand('{{roll::1d20}}', { seed: 11 })).toBe(String(idx(r, 20) + 1));
  });

  test('space and single-colon forms, digits-only and modifiers', () => {
    for (let seed = 0; seed < 40; seed++) {
      const [a, b, c, d, e] = expand('{{roll 1d20}}|{{roll:d6}}|{{roll::20}}|{{roll::2d6+3}}|{{roll::1d4-1}}', { seed }).split('|').map(Number);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(20);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(6);
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(20);
      expect(d).toBeGreaterThanOrEqual(5);
      expect(d).toBeLessThanOrEqual(15);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(3);
    }
  });

  test('roll and random share the block stream, in order', () => {
    const r = subRng(4, 'macro:main');
    const first = ['p', 'q', 'r'][idx(r, 3)];
    const die = idx(r, 6) + 1;
    expect(expand('{{random::p::q::r}} {{roll::d6}}', { seed: 4 })).toBe(`${first} ${die}`);
  });

  test('invalid formulas render empty (ST placeholder); no dice stays literal', () => {
    expect(expand('[{{roll::banana}}][{{roll::0d6}}][{{roll::1d0}}][{{roll::5000d6}}]')).toBe('[][][][]');
    expect(expand('{{roll}}')).toBe('{{roll}}');
  });

  test('dice inside nested macros', () => {
    expect(['1', '2']).toContain(expand('{{roll::{{random::1d2}}}}'));
  });
});

describe('{{pick}} (stable per session, D-43)', () => {
  const tpl = 'Mood: {{pick::calm::angry::sad::happy::bored::tired::curious}}';

  test('the same session keeps its pick across turn seeds (turns and swipes)', () => {
    const first = expand(tpl, { seed: 1 });
    for (let seed = 2; seed < 30; seed++) expect(expand(tpl, { seed })).toBe(first);
  });

  test('changes across sessions', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(expand(tpl, { sessionId: `sess-${i}` }));
    expect(seen.size).toBeGreaterThan(2);
  });

  test('changes across block sources', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(expand(tpl, {}, `block-${i}`));
    expect(seen.size).toBeGreaterThan(2);
  });

  test('two identical picks in one block are seeded by their offsets, independently', () => {
    const two = '{{pick::a::b::c::d::e::f::g::h}}{{pick::a::b::c::d::e::f::g::h}}';
    let differ = 0;
    for (let i = 0; i < 30; i++) {
      const out = expand(two, { sessionId: `s${i}` });
      if (out[0] !== out[1]) differ++;
    }
    expect(differ).toBeGreaterThan(0);
  });

  test('seed recipe: hashString(sessionId, source, raw block text, offset) → mulberry32', () => {
    const text = 'xx{{pick::a::b::c::d::e}}';
    const seed = hashString(['sess-1', 'main', text, 2].join('\u0000'));
    const want = ['a', 'b', 'c', 'd', 'e'][idx(mulberry32(seed), 5)];
    expect(expand(text)).toBe(`xx${want}`);
  });

  test('comma form and Cyrillic options', () => {
    expect(['кот', 'пёс']).toContain(expand('{{pick::кот,пёс}}'));
    expect(['кот', 'пёс']).toContain(expand('{{pick:кот, пёс}}'));
  });

  test('does not consume the random stream', () => {
    expect(expand('{{pick::a::b}}{{random::1::2::3::4::5::6}}', { seed: 8 }).slice(1)).toBe(expand('{{random::1::2::3::4::5::6}}', { seed: 8 }));
  });
});
