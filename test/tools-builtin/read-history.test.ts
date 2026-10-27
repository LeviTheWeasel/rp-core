// Ported from Bunraku:src/studio/dramaturg-tools.test.ts@702d8120 and
// RoleCall:apps/rc/src/lib/ai/btw/tools/__tests__/read-scene-messages-paging.test.ts@fb8dc623e.
// Copyright (C) 2026 Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// read_history and historyPageChars (src/tools/builtin/history.ts; §7.5, D-58): ranges and
// next_from, whole messages per page, hidden stubs, the long-message cut, the page floor and
// maxOutput. Adapted from Bunraku src/studio/dramaturg-tools.test.ts and RoleCall
// ai/btw/tools/__tests__/read-scene-messages-paging.test.ts (both Levi), with D-58's numbers.
import { describe, expect, test } from 'bun:test';
import {
  historyPageChars,
  PAGE_FLOOR_CHARS,
  PAGE_MAX_CHARS,
  PAGE_MIN_CHARS,
  PAGE_SLACK_CHARS,
  readHistoryTool,
} from '../../src/tools/builtin/history.ts';
import type { ToolCtx } from '../../src/tools/types.ts';
import { call, chatEntries, chatView, ctxFor, hide, idOf, msg, viewAt } from './kit.ts';

const SCENE = ['Evening.', 'Any storms?', 'One is coming.', 'My sister saw it.', 'Your sister lies.', 'Hush.'];
const read = (args: Record<string, unknown>, ctx: ToolCtx) => call(readHistoryTool, args, ctx);
/** The `#n` headers of the messages a page holds (a hidden stub included). */
const numbers = (text: string): number[] => [...text.matchAll(/^#(\d+)(?: \(hidden\)| [^\n]*:)$/gm)].map((m) => Number(m[1]));
const nextFrom = (text: string): number | null => {
  const m = /^next_from: (\d+|null)$/m.exec(text);
  if (!m) throw new Error(`no next_from in:\n${text}`);
  return m[1] === 'null' ? null : Number(m[1]);
};

describe('historyPageChars (D-58)', () => {
  test('clamp(15 % of the window in characters, 6 000, 18 000), chars = tokens × 3', () => {
    expect(historyPageChars(4096)).toBe(PAGE_MIN_CHARS);
    expect(historyPageChars(8192)).toBe(PAGE_MIN_CHARS);
    expect(historyPageChars(13334)).toBe(6000); // 6000.3
    expect(historyPageChars(16384)).toBe(7372); // 7372.8
    expect(historyPageChars(32768)).toBe(14745);
    expect(historyPageChars(40000)).toBe(PAGE_MAX_CHARS);
    expect(historyPageChars(131072)).toBe(PAGE_MAX_CHARS);
    for (const w of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(historyPageChars(w)).toBe(PAGE_MIN_CHARS);
  });
});

describe('ranges', () => {
  test('whole messages #from..#to (inclusive), speakers by role, next_from null once read', async () => {
    const out = await read({ from: 3, to: 5 }, ctxFor(chatView(SCENE)));
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(
      ['#3 Mira:\nOne is coming.', '#4 Levi:\nMy sister saw it.', '#5 Mira:\nYour sister lies.', '', 'returned: #3 to #5', 'next_from: null'].join('\n').replace(/\.\n#/g, '.\n\n#'),
    );
    expect(out.summary).toBe('#3 to #5');
  });

  test('`to` left out reads on to the end of the chat; `to` past the end is clamped; both say where the chat ends', async () => {
    const ctx = ctxFor(chatView(SCENE));
    const open = await read({ from: 4 }, ctx);
    expect(numbers(open.text)).toEqual([4, 5, 6]);
    expect(open.text).toContain('next_from: null');
    expect(open.text).toContain('The chat ends at #6.');
    const past = await read({ from: 5, to: 40 }, ctx);
    expect(numbers(past.text)).toEqual([5, 6]);
    expect(past.text).toContain('The chat ends at #6.');
    const inside = await read({ from: 1, to: 2 }, ctx);
    expect(inside.text).not.toContain('The chat ends');
  });

  test('one message: from = to', async () => {
    const out = await read({ from: 1, to: 1 }, ctxFor(chatView(SCENE)));
    expect(out.text.startsWith('#1 Mira:\nEvening.\n\nreturned: #1 to #1\nnext_from: null')).toBe(true);
  });

  test('refusals: from below 1 or not a whole number, to before from, from past the end (naming the total)', async () => {
    const ctx = ctxFor(chatView(SCENE));
    for (const from of [0, -1, 2.5, '3', undefined]) {
      const out = await read({ from }, ctx);
      expect(out.error).toBe(true);
      expect(out.text).toMatch(/^from must be a message number/);
    }
    expect((await read({ from: 3, to: 2 }, ctx)).text).toBe('to (#2) must not be before from (#3).');
    expect((await read({ from: 3, to: 0 }, ctx)).text).toMatch(/^to must be a message number/);
    const past = await read({ from: 7 }, ctx);
    expect(past.error).toBe(true);
    expect(past.text).toBe('The chat has 6 messages; #7 is past the end. Read from #1 to #6.');
    expect((await read({ from: 1 }, ctxFor(chatView([])))).text).toBe('The chat has no messages yet.');
  });

  test("the path ends at upTo: a swipe's view at U never shows the answer it replaces", async () => {
    const entries = [...chatEntries(['Hello.', 'Where is the bell?', 'The bell rang at dawn.']), msg('m000003b', idOf(2), 'assistant', 'The lamp went out.')];
    const ctx = ctxFor(viewAt(entries, idOf(2)));
    expect((await read({ from: 3 }, ctx)).text).toMatch(/2 messages; #3 is past the end/);
    const all = await read({ from: 1, to: 9 }, ctx);
    expect(all.text).not.toMatch(/dawn|lamp/);
    expect(all.text).toContain('The chat ends at #2.');
    // upTo inside a longer view bounds it too.
    const view = chatView(SCENE);
    expect((await read({ from: 1 }, ctxFor(view, { upTo: idOf(3) }))).text).toContain('The chat ends at #3.');
  });

  test('only text blocks are read: no reasoning, no tool calls or results', async () => {
    const view = chatView([
      'Hello.',
      [
        { k: 'reasoning', text: 'She plans a lie.' },
        { k: 'text', text: 'Evening, ' },
        { k: 'tool_call', id: 'c1', name: 'read_history', args: '{"from":1}' },
        { k: 'tool_result', callId: 'c1', name: 'read_history', text: 'secret result' },
        { k: 'text', text: 'traveller.' },
      ],
    ]);
    const out = await read({ from: 2 }, ctxFor(view));
    expect(out.text).toContain('#2 Levi:\nEvening, traveller.');
    expect(out.text).not.toMatch(/plans|secret|tool/);
  });
});

describe('hidden messages', () => {
  test('a hidden message keeps its number and reads as `#n (hidden)`, never its text', async () => {
    const view = chatView(SCENE, [hide(idOf(4))]);
    const out = await read({ from: 3, to: 5 }, ctxFor(view));
    expect(numbers(out.text)).toEqual([3, 4, 5]);
    expect(out.text).toContain('#3 Mira:\nOne is coming.\n\n#4 (hidden)\n\n#5 Mira:\nYour sister lies.');
    expect(out.text).not.toContain('My sister saw it');
  });
});

describe('pages', () => {
  const ctx6000 = (texts: string[]) => ctxFor(chatView(texts), { pageChars: 6000 });

  test('whole messages while they fit the page; next_from names the first unread; the rest is named as unread', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `${i + 1}:${'w'.repeat(2500)}`);
    const ctx = ctx6000(texts);
    const first = await read({ from: 1, to: 12 }, ctx);
    expect(numbers(first.text)).toEqual([1, 2]);
    expect(nextFrom(first.text)).toBe(3);
    expect(first.text).toContain('returned: #1 to #2');
    expect(first.text).toContain('You have not read #3 to #12 yet. Call read_history with from=3 before you say anything about them.');
    expect(first.text).not.toContain('#3 Mira:');
    expect(first.summary).toBe('#1 to #2, next #3');
    const last = await read({ from: 11, to: 40 }, ctx);
    expect(numbers(last.text)).toEqual([11, 12]);
    expect(nextFrom(last.text)).toBeNull();
    expect(last.text).toContain('The chat ends at #12.');
  });

  test('`to` left out: a page from `from`, and the unread rest runs to the end of the chat', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `${i + 1}:${'w'.repeat(2500)}`);
    const out = await read({ from: 5 }, ctx6000(texts));
    expect(numbers(out.text)).toEqual([5, 6]);
    expect(out.text).toContain('You have not read #7 to #12 yet.');
  });

  test('a walk with next_from visits every message exactly once, and every page stays under maxOutput', async () => {
    // Sizes vary: short ones, typical ~1 800-character RP messages, one longer than the page.
    const sizes = [40, 1800, 1800, 300, 5900, 1800, 7000, 20, 1800, 1800, 1800, 2500, 2500, 900, 13000, 60, 1800, 1800];
    const texts = sizes.map((n, i) => `${i + 1}:${'ж'.repeat(n)}`);
    for (const pageChars of [600, 3000, 6000, 18000]) {
      const ctx = ctxFor(chatView(texts, [hide(idOf(9))]), { pageChars });
      const seen: number[] = [];
      let from: number | null = 1;
      for (let calls = 0; from !== null && calls < 100; calls++) {
        const out = await read({ from, to: texts.length }, ctx);
        expect(out.text.length).toBeLessThanOrEqual(readHistoryTool.maxOutput!(ctx));
        seen.push(...numbers(out.text));
        from = nextFrom(out.text);
      }
      expect(seen).toEqual(texts.map((_, i) => i + 1));
    }
  });

  test('typical RP messages (~1 800 characters): a 6 000 page holds three, an 18 000 page nine', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `${i + 1}:${'y'.repeat(1800)}`);
    expect(numbers((await read({ from: 1, to: 20 }, ctxFor(chatView(texts), { pageChars: 6000 }))).text)).toHaveLength(3);
    expect(numbers((await read({ from: 1, to: 20 }, ctxFor(chatView(texts), { pageChars: 18000 }))).text)).toHaveLength(9);
  });

  test('one message longer than the page is cut and says how much is left; paging moves on', async () => {
    const texts = ['short', 'z'.repeat(25_000), 'after'];
    const ctx = ctx6000(texts);
    const out = await read({ from: 2, to: 3 }, ctx);
    expect(numbers(out.text)).toEqual([2]);
    expect(nextFrom(out.text)).toBe(3);
    const piece = `#2 Levi:\n${'z'.repeat(25_000)}`;
    expect(out.text).toContain(`\n[#2 continues for ${piece.length - 6000} more characters, which read_history cannot show]`);
    expect(out.text.indexOf('[#2 continues')).toBe(6001);
    expect(out.text.length).toBeLessThanOrEqual(readHistoryTool.maxOutput!(ctx));
    // The last message cut: nothing more to read.
    const tail = await read({ from: 2 }, ctxFor(chatView(texts.slice(0, 2)), { pageChars: 6000 }));
    expect(nextFrom(tail.text)).toBeNull();
    expect(tail.text).toContain('The chat ends at #2.');
  });

  test('a long message after others waits for the next page instead of being cut', async () => {
    const out = await read({ from: 1, to: 3 }, ctx6000(['short', 'z'.repeat(25_000), 'after']));
    expect(numbers(out.text)).toEqual([1]);
    expect(nextFrom(out.text)).toBe(2);
    expect(out.text).not.toContain('continues');
  });

  test('the page floor: a tiny page still shows PAGE_FLOOR_CHARS of the first message; maxOutput = 2 × page + 1 000', async () => {
    const texts = ['a'.repeat(3000), 'b'];
    const ctx = ctxFor(chatView(texts), { pageChars: 100 });
    expect(readHistoryTool.maxOutput!(ctx)).toBe(2 * PAGE_FLOOR_CHARS + PAGE_SLACK_CHARS);
    const out = await read({ from: 1 }, ctx);
    expect(out.text.indexOf('\n[#1 continues')).toBe(PAGE_FLOOR_CHARS);
    expect(nextFrom(out.text)).toBe(2);
    expect(readHistoryTool.maxOutput!(ctxFor(chatView(texts), { pageChars: 14745 }))).toBe(2 * 14745 + PAGE_SLACK_CHARS);
    expect(readHistoryTool.maxOutput!(ctxFor(chatView(texts), { pageChars: 7000.9 }))).toBe(2 * 7000 + PAGE_SLACK_CHARS);
  });

  test('the cut never splits a surrogate pair', async () => {
    const out = await read({ from: 1 }, ctxFor(chatView(['😀'.repeat(5000)]), { pageChars: 600 }));
    const body = out.text.slice(0, out.text.indexOf('\n[#1 continues'));
    expect(body).not.toMatch(/[\ud800-\udbff]$/);
    expect(body.length).toBeLessThanOrEqual(600);
  });
});

describe('the description', () => {
  test('forbids claiming what was not returned, and explains next_from and the hidden stub', () => {
    const d = readHistoryTool.description;
    expect(d).toMatch(/never claim to have read, summarise or quote a message it did not return/);
    expect(d).toContain('next_from');
    expect(d).toContain('null once the whole range is read');
    expect(d).toContain('#n (hidden)');
    expect(d).toMatch(/#1, the first message/);
  });
});
