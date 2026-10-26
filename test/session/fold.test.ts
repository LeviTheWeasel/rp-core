// session/fold.ts: PathView — vars under swipe and rewind [D-30], fires, cast names, config fold,
// and the 10k-message benchmark.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/entries.ts';
import type { Entry, EntryInput } from '../../src/session/entries.ts';
import { currentConfig, foldView, mergePatch } from '../../src/session/fold.ts';
import { createSessionLog, openSessionLog } from '../../src/session/log.ts';
import { tmpHome } from '../helpers.ts';
import { edit, head, hide, makeHeader, msg, seqd, text, traceWith, TS, withVars } from './fixtures.ts';

/** g → u1 → a1 (vars) with a swipe a2 (other vars). */
function swipeHistory(): EntryInput[] {
  return [
    msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' }, ...withVars({ mood: 'start' }) }),
    msg('u0000001', 'g0000001', 'user', 'Hi'),
    msg('a0000001', 'u0000001', 'assistant', 'first', withVars({ hp: 10, mood: 'happy' })),
    msg('a0000002', 'u0000001', 'assistant', 'second', withVars({ hp: 5 })),
  ];
}

describe('vars', () => {
  test('a swipe starts from the vars before the answer; selecting the old swipe brings its vars back', () => {
    const header = makeHeader('s_0000a001', { vars0: { day: 1, gone: null } });
    let entries = seqd(swipeHistory());
    let view = foldView(header, entries);
    expect(view.head).toBe('a0000002');
    expect(view.vars).toEqual({ day: 1, mood: 'start', hp: 5 });

    entries = [...entries, ...seqd([head('a0000001')], 5)];
    view = foldView(header, entries);
    expect(view.vars).toEqual({ day: 1, mood: 'happy', hp: 10 });
    expect(view.path.map((m) => m.swipe)).toEqual([
      { index: 0, count: 1 },
      { index: 0, count: 1 },
      { index: 0, count: 2 },
    ]);
    expect(view.tails).toEqual(['a0000002']);
  });

  test('rewind: moving the head back drops the later diffs; null deletes; edits count in seq order', () => {
    const header = makeHeader();
    const base = seqd([
      ...swipeHistory(),
      head('a0000001'),
      msg('u0000002', 'a0000001', 'user', 'go on'),
      msg('a0000003', 'u0000002', 'assistant', 'later', withVars({ hp: null, key: 'a3' })),
      // an edit of an EARLIER message that is newer than a3: it wins by seq
      { t: 'edit', ts: TS, target: 'a0000001', reason: 'user', blocks: text('first!'), vars: { key: 'edit' } } as EntryInput,
      // an edit of an off-path swipe never counts
      { t: 'edit', ts: TS, target: 'a0000002', reason: 'user', vars: { off: 'path' } } as EntryInput,
    ]);
    let view = foldView(header, base);
    expect(view.head).toBe('a0000003');
    expect(view.vars).toEqual({ mood: 'happy', key: 'edit' });

    const rewound = [...base, ...seqd([head('u0000001')], base.length + 1)];
    view = foldView(header, rewound);
    expect(view.head).toBe('u0000001');
    expect(view.vars).toEqual({ mood: 'start' });
    expect(view.tails.sort()).toEqual(['a0000002', 'a0000003']);
    expect(view.version).toBe(base.length + 1);
  });
});

describe('PathView', () => {
  test('messages: effective blocks, edited, hidden, gen; fires from msg and continue traces on the path', () => {
    const fired = [{ book: 'world', id: 'e1', why: 'key:castle' }];
    const entries = seqd([
      msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }),
      msg('u0000001', 'g0000001', 'user', 'Hi'),
      msg('a0000001', 'u0000001', 'assistant', 'answer', { trace: traceWith(fired) as never, gen: { kind: 'model', model: 'm' } }),
      msg('a0000002', 'u0000001', 'assistant', 'swipe', { trace: traceWith([{ book: 'x', id: 'off', why: 'k' }]) as never }),
      head('a0000001'),
      { t: 'edit', ts: TS, target: 'a0000001', reason: 'continue', blocks: text('answer, continued'), gen: { kind: 'model', model: 'm2' }, trace: traceWith([{ book: 'world', id: 'e2', why: 'key:moat' }]) as never } as EntryInput,
      edit('u0000001', 'Hi there'),
      hide('g0000001'),
    ]);
    const view = foldView(makeHeader(), entries);
    expect(view.session).toBe('s_0000a001');
    expect(view.path.map((m) => [m.id, m.role, m.hidden, m.edited])).toEqual([
      ['g0000001', 'assistant', true, false],
      ['u0000001', 'user', false, true],
      ['a0000001', 'assistant', false, false],
    ]);
    expect(view.path[1]!.blocks).toEqual(text('Hi there'));
    expect(view.path[2]!.blocks).toEqual(text('answer, continued'));
    expect(view.path[2]!.gen).toEqual({ kind: 'model', model: 'm2' });
    expect(view.path[1]!.gen).toBeUndefined();
    expect(view.path[2]!.swipe).toEqual({ index: 0, count: 2 });
    expect(view.fires).toEqual([
      { msgId: 'a0000001', fired },
      { msgId: 'a0000001', fired: [{ book: 'world', id: 'e2', why: 'key:moat' }] },
    ]);
    expect([...view.pathSet]).toEqual(['g0000001', 'u0000001', 'a0000001']);
  });

  test('greetings are sibling roots; castNames are deduplicated', () => {
    const entries = seqd([msg('g0000001', null), msg('g0000002', null), head('g0000002')]);
    const view = foldView(makeHeader(), entries);
    expect(view.path[0]!.swipe).toEqual({ index: 1, count: 2 });
    expect(view.castNames).toEqual(['Mira', 'Levi', 'L']);
    const empty = foldView(makeHeader(), []);
    expect(empty).toMatchObject({ head: null, version: 0, path: [], tails: [], vars: {}, fires: [] });
  });
});

describe('config fold', () => {
  test('mergePatch: objects merge, arrays and scalars replace, null removes, base untouched', () => {
    const base = structuredClone(DEFAULT_SESSION_CONFIG);
    const frozen = JSON.stringify(base);
    const merged = mergePatch(base, {
      director: { enabled: true },
      lorebooks: ['a', 'b'],
      authorNote: { text: 'n', depth: 4, role: 'system' },
    });
    expect(merged.director).toEqual({ ...DEFAULT_SESSION_CONFIG.director, enabled: true });
    expect(merged.lorebooks).toEqual(['a', 'b']);
    expect(JSON.stringify(base)).toBe(frozen);
    const removed = mergePatch(merged, { authorNote: null } as never);
    expect('authorNote' in removed).toBe(false);
  });

  test('currentConfig applies config entries in order', () => {
    const entries = seqd([
      { t: 'config', ts: TS, patch: { preset: 'one', lorebooks: ['x'] } } as EntryInput,
      msg('g0000001', null),
      { t: 'config', ts: TS, patch: { preset: 'two', swipe: { showRejected: false } } } as EntryInput,
    ]);
    const c = currentConfig(makeHeader(), entries);
    expect(c.preset).toBe('two');
    expect(c.lorebooks).toEqual(['x']);
    expect(c.swipe).toEqual({ showRejected: false });
    expect(c.roles).toEqual(DEFAULT_SESSION_CONFIG.roles);
  });
});

/** 10k messages: a long chat with a swipe every 10th answer, some edits, vars and hides. */
function bigHistory(): EntryInput[] {
  const out: EntryInput[] = [msg('m0000000', null, 'assistant', 'greeting', { gen: { kind: 'greeting' } })];
  let parent = 'm0000000';
  let n = 1;
  const id = () => `m${String(n++).padStart(7, '0')}`;
  while (n < 10_000) {
    const u = id();
    out.push(msg(u, parent, 'user', `user line ${n} with some words in it`));
    const a = id();
    out.push(msg(a, u, 'assistant', `assistant line ${n} `.repeat(8), { vars: { turn: n, mood: n % 3 ? 'calm' : 'tense' }, trace: traceWith() as never }));
    if (n % 10 === 0 && n < 10_000) {
      const s = id();
      out.push(msg(s, u, 'assistant', 'a swipe', { vars: { swiped: n } }));
      out.push(head(a));
    }
    if (n % 25 === 0) out.push(edit(a, 'edited text', { vars: { edited: n } }));
    if (n % 40 === 0) out.push(hide(u));
    parent = a;
  }
  return out;
}

describe('benchmark', () => {
  test('fold of 10k messages', () => {
    const header = makeHeader();
    const entries: Entry[] = seqd(bigHistory());
    const msgCount = entries.filter((e) => e.t === 'msg').length;
    expect(msgCount).toBeGreaterThanOrEqual(10_000);
    foldView(header, entries); // warm-up (JIT)
    const runs: number[] = [];
    let view = foldView(header, entries);
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      view = foldView(header, entries);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[2]!;
    console.log(`[bench] foldView over ${msgCount} messages (${entries.length} entries): median ${median.toFixed(2)} ms, min ${runs[0]!.toFixed(2)} ms`);
    expect(view.path.length).toBeGreaterThan(5000);
    expect(view.vars.turn).toBeDefined();
    expect(median).toBeLessThan(500);
  });

  test('open of a 10k-message journal (informational)', () => {
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader());
    for (const e of bigHistory()) log.append(e, { durable: false });
    log.close();
    const t0 = performance.now();
    const { log: opened, notices } = openSessionLog(home, 's_0000a001');
    const ms = performance.now() - t0;
    console.log(`[bench] openSessionLog of ${opened.entries().length} entries: ${ms.toFixed(1)} ms`);
    expect(notices).toEqual([]);
    opened.close();
    expect(ms).toBeLessThan(5000);
  });
});
