// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The historian after the M5b review (.notes/m5b-decisions.md, the lead's ruling I): a message bigger
// than the recorder's window is cut head+tail to fit (review historian#3, breaker#4); historianOps says
// how many summaries the answer offered and how many the row holds (historian#10); a plot named by an
// alias is that plot, its arc keyed by the canonical name (historian#5); prototype keys never throw
// (breaker#8); a list key holding null, '' or "none" is nothing.
import { describe, expect, test } from 'bun:test';
import {
  historianDue,
  historianKey,
  historianOps,
  historianRequest,
  historianWindowAt,
  readHistorianAnswer,
  windowCap,
  type HistMessage,
  type HistorianAnswer,
} from '../../src/agents/compendium/historian.ts';
import { recapSlot } from '../../src/agents/compendium/recap.ts';
import { MESSAGE_OVERHEAD_TOKENS } from '../../src/prompt/tokens.ts';
import { arc, due, exchanges, fold, histRow, typed, viewOf, words } from './kit.ts';

const answer = (raw: unknown): HistorianAnswer => {
  const r = readHistorianAnswer(raw);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const W = { newStart: 1, end: 5 };

describe('review historian#3 / breaker#4: a message bigger than the window is cut to fit', () => {
  const huge = `HEADWORD ${'paste '.repeat(20_000)}TAILWORD`;
  const path: HistMessage[] = [...exchanges(2), { id: 'big', role: 'user', text: huge }, { id: 'a3', role: 'assistant', text: 'Text of a3.' }];
  const covered = new Map([['hist:u1-a2', { seq: 1, status: 'applied' as const, range: ['u1', 'a2'] as [string, string] }]]);
  const input = due(path, { window: 8192, tasks: covered });

  test('historianDue: the window is the big message alone, cut head+tail within the cap; its key is the message', () => {
    const w = historianDue(input)!;
    expect(historianKey(w)).toBe('hist:big-big');
    expect(w.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'big']);
    const text = w.messages.at(-1)!.text;
    expect(text.startsWith('HEADWORD paste')).toBe(true);
    expect(text.endsWith('paste TAILWORD')).toBe(true);
    expect(text).toMatch(/\n\[\.\.\. \d+ characters cut from the middle \.\.\.\]\n/);
    expect(w.tokens).toBeLessThanOrEqual(windowCap(8192));
    expect(w.tokens).toBe(w.messages.reduce((n, m) => n + words(m.text.trim()), 0));
  });

  test('the request fits the recorder’s window with room for the answer; historianWindowAt over the key cuts the same', () => {
    const w = historianDue(input)!;
    const req = historianRequest({ window: w, view: viewOf([]), profile: 'full', guidance: '', language: '' });
    const tokens = words(req.system) + words(req.user) + 2 * MESSAGE_OVERHEAD_TOKENS;
    expect(8192 - tokens).toBeGreaterThanOrEqual(600);
    const again = historianWindowAt({ path: path.slice(0, 5), profile: 'full', window: 8192, count: words }, ['big', 'big'])!;
    expect(again.messages).toEqual(w.messages);
    expect(again.tokens).toBe(w.tokens);
  });

  test('a smaller budget (the lane’s room) cuts it further; the messages and the key stay', () => {
    const w = historianWindowAt({ path, profile: 'full', window: 8192, count: words, budget: 500 }, ['big', 'big'])!;
    expect(historianKey(w)).toBe('hist:big-big');
    expect(w.tokens).toBeLessThanOrEqual(500);
    expect(w.messages.at(-1)!.text.startsWith('HEADWORD')).toBe(true);
    // Never above the cap.
    const roomy = historianWindowAt({ path, profile: 'full', window: 8192, count: words, budget: 1_000_000 }, ['big', 'big'])!;
    expect(roomy.tokens).toBeLessThanOrEqual(windowCap(8192));
  });

  test('a stored range of several messages: the small ones stay whole, the big ones share what is left', () => {
    const long = (tag: string): string => `${tag}HEAD ${'word '.repeat(5_000)}${tag}TAIL`;
    const p: HistMessage[] = [
      { id: 'm1', role: 'user', text: 'short one' },
      { id: 'm2', role: 'assistant', text: long('A') },
      { id: 'm3', role: 'user', text: long('B') },
      { id: 'm4', role: 'assistant', text: 'short two' },
    ];
    const w = historianWindowAt({ path: p, profile: 'full', window: 8192, count: words }, ['m1', 'm4'])!;
    expect(w.messages.map((m) => m.text.length < 100)).toEqual([true, false, false, true]);
    expect(w.messages[0]!.text).toBe('short one');
    expect(w.messages[3]!.text).toBe('short two');
    const [a, b] = [words(w.messages[1]!.text), words(w.messages[2]!.text)];
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(w.tokens).toBeLessThanOrEqual(windowCap(8192));
  });

  test('windows that fit are unchanged (no cut, the same tokens)', () => {
    const p = exchanges(3);
    const w = historianDue(due(p))!;
    expect(w.messages.map((m) => m.text)).toEqual(p.map((m) => m.text));
    expect(w.tokens).toBe(p.reduce((n, m) => n + words(m.text), 0));
  });
});

describe('review historian#10: offered and applied summaries', () => {
  test('every summary refused (no parent_plot): offered 1, applied 0 — the lane fails the attempt', () => {
    const a = answer({ filings: [{ type: 'summary', entry: { title: 'Fog', summary: 'Fog fell.' } }], arcs: [{ plot: 'Lantern', overview: 'o' }] });
    const out = historianOps(a, W, viewOf([]), 'full');
    expect([out.ops, out.offered, out.applied]).toEqual([[], 1, 0]);
  });

  test('an empty answer offers none (it closes the window); plots alone offer none; another type is not a summary', () => {
    for (const raw of [{}, { filings: [], arcs: [] }, { filings: null }, { filings: [{ type: 'plot', entry: { name: 'Ash' } }] }, { filings: [{ type: 'character', entry: { name: 'X' } }] }]) {
      const out = historianOps(answer(raw), W, viewOf([]), 'full');
      expect(out.offered).toBe(0);
      expect(out.applied).toBe(0);
    }
  });

  test('refused ones count: no type, not an object, a summary without a title, one past the limit; applied ones are the summary ops', () => {
    const good = { type: 'summary', entry: { title: 'A', summary: 's', parent_plot: 'P' } };
    const a = answer({ filings: [good, { title: 'no type nor summary text' }, 'a string', { type: 'summary', entry: { summary: 'no title' } }, { type: 'summary', entry: 'x' }] });
    const out = historianOps(a, W, viewOf([]), 'full');
    expect([out.offered, out.applied]).toEqual([5, 1]);
    const many = answer({ filings: Array.from({ length: 14 }, () => good) });
    expect([historianOps(many, W, viewOf([]), 'full').offered, historianOps(many, W, viewOf([]), 'full').applied]).toEqual([14, 12]);
    // A summary historianOps itself refuses (a plot name with no letters) is offered, not applied.
    const blank = answer({ filings: [{ type: 'summary', entry: { title: 'T', summary: 's', parent_plot: '!!!' } }] });
    expect([historianOps(blank, W, viewOf([]), 'full').offered, historianOps(blank, W, viewOf([]), 'full').applied]).toEqual([1, 0]);
  });

  test('an answer built by hand without `offered`: its summaries', () => {
    const a: HistorianAnswer = { summaries: [{ at: 'filings[0]', data: { title: 'T', summary: 's', parent_plot: 'P' } }], plots: [], arcs: [], skipped: [] };
    expect(historianOps(a, W, viewOf([]), 'full').offered).toBe(1);
  });
});

describe('review historian#5: a plot named by an alias is that plot', () => {
  const plot = typed('plot:the lantern', 'plot', { name: 'The Lantern', aliases: ['Harbour Light'], status: 'active' });
  const view = viewOf([plot, arc('The Lantern', 'Overview one.', 5)]);

  test('A: the summary and the arc both use the alias — the arc is written under the canonical name', () => {
    const a = answer({ filings: [{ type: 'summary', entry: { title: 'Door', summary: 's', parent_plot: 'Harbour Light' } }], arcs: [{ plot: 'Harbour Light', overview: 'Overview two.' }] });
    const out = historianOps(a, W, view, 'full');
    expect(out.ops.filter((o) => o.op !== 'file' || o.type !== 'summary')).toEqual([{ op: 'arc', plot: 'The Lantern', overview: 'Overview two.' }]);
    expect(out.skipped).toEqual([]);
  });

  test('B: the summary names the plot, the arc its alias — the arc applies', () => {
    const a = answer({ filings: [{ type: 'summary', entry: { title: 'Door', summary: 's', parent_plot: 'The Lantern' } }], arcs: [{ plot: 'harbour light', overview: 'Overview two.' }] });
    expect(historianOps(a, W, view, 'full').ops.at(-1)).toEqual({ op: 'arc', plot: 'The Lantern', overview: 'Overview two.' });
    // The same text as the plot's arc under its alias is still a no-op.
    const same = answer({ filings: [{ type: 'summary', entry: { title: 'Door', summary: 's', parent_plot: 'The Lantern' } }], arcs: [{ plot: 'Harbour Light', overview: 'Overview one.' }] });
    expect(historianOps(same, W, view, 'full').ops.filter((o) => o.op === 'arc')).toEqual([]);
  });

  test('a plot the answer brings with an alias: an arc under the alias is keyed by the answer’s name', () => {
    const a = answer({
      filings: [
        { type: 'plot', entry: { name: 'Salt Road', aliases: ['the road'] } },
        { type: 'summary', entry: { title: 'March', summary: 's', parent_plot: 'The Road' } },
      ],
      arcs: [{ plot: 'the road', overview: 'They marched.' }],
    });
    expect(historianOps(a, W, viewOf([]), 'full').ops.at(-1)).toEqual({ op: 'arc', plot: 'Salt Road', overview: 'They marched.' });
  });

  test('through the fold and the slot: one arc, one overview', () => {
    const rows = [
      histRow(5, 'u1', 'a1', [
        { op: 'file', type: 'plot', data: { name: 'The Lantern', aliases: ['Harbour Light'], status: 'active' } },
        { op: 'file', type: 'summary', data: { title: 'Fog', parent_plot: 'The Lantern', summary: 'Fog fell.' } },
        { op: 'arc', plot: 'The Lantern', overview: 'Overview one.' },
      ]),
    ];
    const path = ['u1', 'a1', 'u2', 'a2', 'u3'];
    const before = fold(rows, path);
    const a = answer({ filings: [{ type: 'summary', entry: { title: 'Door', summary: 'A door.', parent_plot: 'Harbour Light' } }], arcs: [{ plot: 'Harbour Light', overview: 'Overview two.' }] });
    const ops = historianOps(a, { newStart: 3, end: 4 }, before, 'full').ops;
    const after = fold([...rows, histRow(6, 'u2', 'a2', ops)], path);
    const arcs = [...after.entries.values()].filter((e) => e.arc !== undefined);
    expect(arcs.map((e) => [e.key, e.content])).toEqual([['arc:the lantern', 'Overview two.']]);
    const slot = recapSlot({ view: after, path, trimmed: { from: 'u1', to: 'a2' }, boundary: 'u3', previous: null, budgetTok: 500, profile: 'full', count: words })!;
    expect(slot.text.match(/\[Arc\]/g)).toHaveLength(1);
  });
});

describe('review breaker#8: prototype keys never throw', () => {
  const KEYS = ['__proto__', 'constructor', ' Constructor ', 'toString', 'hasOwnProperty', 'valueOf'];
  const good = { type: 'summary', entry: { title: 'T', parent_plot: 'Маяк', summary: 'Свет погас.' } };

  test('as an item type: that item is skipped, the good summaries applied', () => {
    for (const k of KEYS) {
      const raw = JSON.parse(`{"filings":[{"type":${JSON.stringify(k)},"entry":{"title":"T","parent_plot":"Маяк","summary":"…"}},${JSON.stringify(good)}]}`);
      const a = answer(raw);
      expect(a.summaries.map((s) => s.data.title)).toEqual(['T']);
      expect(a.skipped).toEqual([{ path: 'filings[0]', why: `its type "${k.trim()}" is not summary or plot` }]);
    }
  });

  test('as type-keyed keys, entry fields, significance values, arc maps and envelope keys', () => {
    for (const k of KEYS) {
      const q = JSON.stringify(k);
      const texts = [
        `{"filings":[{${q}:{"title":"T","summary":"s"}}, ${JSON.stringify(good)}]}`,
        `{"filings":[{"type":"summary","entry":{"title":"T","parent_plot":"P","summary":"s",${q}:"x"}}]}`,
        `{"filings":[{"type":"summary","entry":{"title":"T","parent_plot":"P","summary":"s","significance":${q}}}]}`,
        `{"filings":[${JSON.stringify(good)}],"arcs":{${q}:"overview"}}`,
        `{${q}:[${JSON.stringify(good)}]}`,
        `{"filings":[{"type":"plot","entry":{"name":"P","status":${q}}}]}`,
      ];
      for (const t of texts) {
        expect(() => readHistorianAnswer(JSON.parse(t))).not.toThrow();
        const r = readHistorianAnswer(JSON.parse(t));
        if (r.ok) expect(() => historianOps(r.value, W, viewOf([]), 'full')).not.toThrow();
      }
      expect(answer(JSON.parse(texts[0]!)).summaries.map((s) => s.data.title)).toEqual(['T']);
      expect(answer(JSON.parse(texts[2]!)).skipped).toEqual([{ path: 'filings[0].entry.significance', why: 'must be one of minor, moderate, major, pivotal' }]);
    }
  });
});

describe('the lead’s ruling I: a list that says "nothing" is nothing to summarise', () => {
  test('null, "none" and a blank string under filings or arcs; a number is still unreadable', () => {
    for (const raw of [{ filings: null }, { filings: 'none' }, { filings: ' NONE ', arcs: null }, { filings: '' }, { arcs: 'none' }, { summaries: null, arcs: [] }]) {
      expect(answer(raw)).toEqual({ summaries: [], plots: [], arcs: [], skipped: [], offered: 0 });
    }
    expect(readHistorianAnswer({ filings: 3 }).ok).toBe(false);
  });
});
