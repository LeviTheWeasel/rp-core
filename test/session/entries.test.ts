// session/entries.ts parse guards: per-kind shape checks, extra fields kept, never throws.
import { describe, expect, test } from 'bun:test';
import { parseEntry, parseHeader } from '../../src/session/entries.ts';
import { fakeRandom } from '../helpers.ts';
import { makeHeader, TS, traceWith } from './fixtures.ts';

const VALID: Record<string, unknown>[] = [
  { t: 'config', seq: 1, ts: TS, patch: { preset: 'x' } },
  { t: 'msg', seq: 2, ts: TS, id: 'aaaa0001', parent: null, role: 'assistant', blocks: [{ k: 'text', text: 'hi' }], gen: { kind: 'greeting' } },
  {
    t: 'msg', seq: 3, ts: TS, id: 'aaaa0002', parent: 'aaaa0001', role: 'user', turn: 't_1',
    blocks: [
      { k: 'text', text: 'a' },
      { k: 'reasoning', text: 'b', kind: 'summary' },
      { k: 'tool_call', id: 'c1', name: 'roll', args: '{}' },
      { k: 'tool_result', callId: 'c1', name: 'roll', text: '4', error: false },
    ],
    gen: { kind: 'model', model: 'm', finish: 'end', usage: { outputTotal: 3 }, route: [{ model: 'm', status: 'ok' }] },
    trace: traceWith([{ book: 'b', id: 'e1', why: 'key' }]),
    vars: { mood: 'calm', hp: 3, gone: null },
    dir: { anything: true },
  },
  { t: 'edit', seq: 4, ts: TS, target: 'aaaa0002', reason: 'continue', blocks: [], gen: { kind: 'model' } },
  { t: 'hide', seq: 5, ts: TS, target: 'aaaa0002', hidden: true },
  { t: 'head', seq: 6, ts: TS, leaf: 'aaaa0001' },
  { t: 'turn', seq: 7, ts: TS, turn: 't_1', kind: 'swipe', parent: 'aaaa0001', target: 'aaaa0002', msgId: 'aaaa0003', seed: 1, now: TS, base: 6 },
  { t: 'prep', seq: 8, turn: 't_1', trace: traceWith(), cont: { mode: 'cue', base: 'x' }, prefill: 'p' },
  { t: 'chk', seq: 9, turn: 't_1', text: 'delta' },
  { t: 'held', seq: 10, turn: 't_1', body: { blocks: [{ k: 'text', text: 'held' }] } },
  { t: 'end', seq: 11, ts: TS, turn: 't_1', outcome: 'failed', code: 'timeout' },
  { t: 'job', seq: 12, ts: TS, job: 'j1', key: 'file:x', task: 'file', on: 'aaaa0001', state: 'begin', attempt: 1 },
  { t: 'mem', seq: 13, ts: TS, key: null, on: null, payload: { free: 'form' } },
];

describe('parseEntry', () => {
  test('accepts every kind', () => {
    for (const v of VALID) {
      const r = parseEntry(JSON.stringify(v));
      if (!r.ok) throw new Error(`${String(v.t)}: ${r.why}`);
      expect(r.value).toEqual(v as never);
    }
  });

  test('extra fields are kept, not stripped', () => {
    const r = parseEntry(JSON.stringify({ ...VALID[1], branch: 'main', future: { x: 1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as unknown as Record<string, unknown>).branch).toBe('main');
  });

  test('unknown t, the header kind, and non-objects fail', () => {
    for (const line of ['{"t":"dirEdit","seq":1}', JSON.stringify(makeHeader()), '[]', '1', 'null', '"x"']) {
      expect(parseEntry(line).ok).toBe(false);
    }
  });

  test('missing or mistyped required fields fail with a path', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...VALID[1], seq: 0 }, 'msg.seq'],
      [{ ...VALID[1], seq: 1.5 }, 'msg.seq'],
      [{ ...VALID[1], role: 'system' }, 'msg.role'],
      [{ ...VALID[1], parent: undefined }, 'msg.parent'],
      [{ ...VALID[1], blocks: [{ k: 'image', path: 'x' }] }, 'msg.blocks[0].k'],
      [{ ...VALID[1], blocks: [{ k: 'text' }] }, 'msg.blocks[0].text'],
      [{ ...VALID[2], vars: { a: true } }, 'msg.vars.a'],
      [{ ...VALID[2], gen: { kind: 'model', finish: 'eof' } }, 'msg.gen.finish'],
      [{ ...VALID[2], trace: { seed: 1, now: TS, lore: {} } }, 'msg.trace.lore.fired'],
      [{ ...VALID[3], reason: 'magic' }, 'edit.reason'],
      [{ ...VALID[4], hidden: 'yes' }, 'hide.hidden'],
      [{ ...VALID[6], base: '3' }, 'turn.base'],
      [{ ...VALID[7], trace: undefined }, 'prep.trace'],
      [{ ...VALID[9], body: {} }, 'held.body.blocks'],
      [{ ...VALID[10], outcome: 'ok' }, 'end.outcome'],
      [{ ...VALID[12], on: 3 }, 'mem.on'],
    ];
    for (const [v, path] of cases) {
      const r = parseEntry(JSON.stringify(v));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why.startsWith(path)).toBe(true);
    }
  });

  test('fuzz: corrupted lines never throw', () => {
    const rnd = fakeRandom(7);
    const pool = [...VALID.map((v) => JSON.stringify(v)), JSON.stringify(makeHeader())];
    const junk = ['{', '}', '[', ']', '"', ':', ',', 'null', '1e999', '\\', ' ', '�', 'true', '{"t":"msg"}', '__proto__'];
    let parsed = 0;
    for (let i = 0; i < 4000; i++) {
      const r = rnd(4);
      let s = pool[r[0]! % pool.length]!;
      const pos = ((r[1]! << 8) | r[2]!) % (s.length + 1);
      switch (r[3]! % 4) {
        case 0: s = s.slice(0, pos); break; // truncation (a torn line)
        case 1: s = s.slice(0, pos) + junk[r[2]! % junk.length] + s.slice(pos); break;
        case 2: s = s.slice(0, pos) + s.slice(pos + 1 + (r[1]! % 8)); break;
        case 3: s = s.slice(0, pos) + String.fromCharCode(r[1]! ^ r[2]!) + s.slice(pos + 1); break;
      }
      expect(() => parseEntry(s)).not.toThrow();
      expect(() => parseHeader(s)).not.toThrow();
      if (parseEntry(s).ok) parsed++;
    }
    // Deep nesting is a JSON.parse RangeError path; it must be reported, not thrown.
    expect(parseEntry('['.repeat(200000)).ok).toBe(false);
    expect(parsed).toBeGreaterThan(0); // some mutations stay valid: the fuzz is not trivially failing
  });
});

describe('parseHeader', () => {
  test('accepts a valid header and keeps extra fields', () => {
    const h = { ...makeHeader(), vars0: { a: 1 }, fork: { from: 's_x', at: 'm1' }, extra: 1 };
    const r = parseHeader(JSON.stringify(h));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(h as never);
  });

  test('version, kind and required fields are checked', () => {
    const h = makeHeader();
    expect(parseHeader(JSON.stringify({ ...h, v: 2 })).ok).toBe(false);
    expect(parseHeader(JSON.stringify({ ...h, t: 'msg' })).ok).toBe(false);
    expect(parseHeader(JSON.stringify({ ...h, id: '' })).ok).toBe(false);
    expect(parseHeader(JSON.stringify({ ...h, cast: { character: { name: 'x' } } })).ok).toBe(false);
    expect(parseHeader(JSON.stringify({ ...h, config: { ...h.config, roles: {} } })).ok).toBe(false);
    const { persona: _p, ...castNoPersona } = h.cast;
    expect(parseHeader(JSON.stringify({ ...h, cast: castNoPersona })).ok).toBe(true);
    expect(parseHeader('not json').ok).toBe(false);
  });
});
