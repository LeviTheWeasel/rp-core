// Variable macros: overlay across the run and VarsDiff (ARCHITECTURE.md §5.10, §10.4).
import { describe, expect, test } from 'bun:test';
import { expand, run } from './env.ts';

describe('getvar', () => {
  test('reads session vars; missing reads empty', () => {
    expect(expand('{{getvar::hp}}/{{getvar::name}}/[{{getvar::nope}}]', { vars: { hp: 12, name: 'Ash' } })).toBe('12/Ash/[]');
  });

  test('prototype names are not variables', () => {
    expect(expand('[{{getvar::constructor}}][{{getvar::__proto__}}]')).toBe('[][]');
  });

  test('space and single-colon forms', () => {
    expect(expand('{{getvar hp}} {{getvar:hp}}', { vars: { hp: 3 } })).toBe('3 3');
  });
});

describe('setvar / addvar / incvar / decvar', () => {
  test('setvar renders empty; later macros in the block see the value', () => {
    const r = run();
    expect(r.block('{{setvar::mood::grim}}[{{getvar::mood}}]', 'main')).toBe('[grim]');
    expect(r.varsDiff()).toEqual({ mood: 'grim' });
  });

  test('numeric values stay numbers, lossy-looking ones stay strings', () => {
    const r = run();
    r.block('{{setvar::a::5}}{{setvar::b::-2.5}}{{setvar::c::05}}{{setvar::d::1e3}}{{setvar::e::}}', 'main');
    // {{setvar::e::}} has an empty value arg: still a write
    expect(r.varsDiff()).toEqual({ a: 5, b: -2.5, c: '05', d: '1e3', e: '' });
    const r2 = run({ vars: { e: 'old' } });
    r2.block('{{setvar::e::}}', 'main');
    expect(r2.varsDiff()).toEqual({ e: '' });
  });

  test('a value with :: keeps it; a value built from macros is expanded first', () => {
    const r = run();
    r.block('{{setvar::path::a::b::c}}{{setvar::who::{{char}} & {{user}}}}', 'main');
    expect(r.varsDiff()).toEqual({ path: 'a::b::c', who: 'Alice & Bob' });
  });

  test('setvar without a value stays literal and writes nothing', () => {
    const r = run();
    expect(r.block('{{setvar::x}}', 'main')).toBe('{{setvar::x}}');
    expect(r.varsDiff()).toEqual({});
  });

  test('addvar adds numbers and concatenates text (ST addLocalVariable)', () => {
    const r = run({ vars: { gold: 10, log: 'a', n: '4' } });
    expect(r.block('{{addvar::gold::5}}{{addvar::log::b}}{{addvar::n::1}}{{addvar::fresh::7}}{{addvar::note::hi}}', 'main')).toBe('');
    expect(r.varsDiff()).toEqual({ gold: 15, log: 'ab', n: 5, fresh: 7, note: 'hi' });
  });

  test('incvar/decvar return the new value; missing starts at 0', () => {
    const r = run({ vars: { turn: 3 } });
    expect(r.block('{{incvar::turn}} {{incvar::turn}} {{decvar::lives}} {{incvar::new}}', 'main')).toBe('4 5 -1 1');
    expect(r.varsDiff()).toEqual({ turn: 5, lives: -1, new: 1 });
  });

  test('space and single-colon forms for writers', () => {
    const r = run();
    expect(r.block('{{setvar x hello world}}{{setvar:y:12:30}}{{incvar z}}{{addvar w 2}}{{incvar:z}}', 'main')).toBe('12');
    expect(r.varsDiff()).toEqual({ x: 'hello world', y: '12:30', z: 2, w: 2 });
  });
});

describe('overlay across blocks', () => {
  test('writes are visible to later blocks of the same run, in order', () => {
    const r = run({ vars: { n: 1 } });
    expect(r.block('{{getvar::n}}', 'a')).toBe('1');
    expect(r.block('{{incvar::n}}', 'b')).toBe('2');
    expect(r.block('{{getvar::n}}{{setvar::n::10}}{{getvar::n}}', 'c')).toBe('210');
    expect(r.block('{{getvar::n}}', 'd')).toBe('10');
    expect(r.varsDiff()).toEqual({ n: 10 });
  });

  test('env.vars is never mutated; a fresh run starts from it again', () => {
    const vars = { n: 1 };
    run({ vars }).block('{{setvar::n::9}}{{setvar::m::2}}', 'main');
    expect(vars).toEqual({ n: 1 });
    expect(run({ vars }).block('{{getvar::n}}', 'main')).toBe('1');
  });

  test('varsDiff leaves out values written back unchanged, keeps first-write order', () => {
    const r = run({ vars: { same: 3, flip: 'a' } });
    r.block('{{setvar::z::1}}{{setvar::same::3}}{{setvar::flip::b}}{{setvar::flip::a}}{{setvar::y::2}}', 'main');
    expect(Object.keys(r.varsDiff())).toEqual(['z', 'y']);
  });

  test('a variable named __proto__ is a plain key in the diff', () => {
    const r = run();
    r.block('{{setvar::__proto__::evil}}', 'main');
    const diff = r.varsDiff();
    expect(Object.keys(diff)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(diff)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  test('variable writes inside card fields count (D-42 expands them in the same pass)', () => {
    const r = run({ card: { scenario: '{{incvar::visits}}' } });
    expect(r.block('Visit #{{scenario}}', 'main')).toBe('Visit #1');
    expect(r.varsDiff()).toEqual({ visits: 1 });
  });

  test('Cyrillic names and values', () => {
    const r = run({ vars: { 'золото': 3 } });
    expect(r.block('{{setvar::настроение::мрачное}}{{addvar::золото::2}}{{getvar::настроение}} {{getvar::золото}}', 'main')).toBe('мрачное 5');
    expect(r.varsDiff()).toEqual({ 'настроение': 'мрачное', 'золото': 5 });
  });
});

describe('userText is read-only', () => {
  test('setvar and friends stay literal and change nothing', () => {
    const r = run({ vars: { n: 1 } });
    const typed = '{{setvar::n::99}} {{incvar::n}} {{getvar::n}} {{char}}';
    expect(r.userText(typed)).toBe('{{setvar::n::99}} {{incvar::n}} {{getvar::n}} Alice');
    expect(r.varsDiff()).toEqual({});
    expect(r.block('{{getvar::n}}', 'main')).toBe('1');
  });
});
