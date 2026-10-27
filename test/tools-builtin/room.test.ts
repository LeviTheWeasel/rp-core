// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The built-in tools under the round's room (tools/run.ts ctx.limit, history.ts outputRoom and
// read_history's page; D-58): a result sized to its share keeps its paging lines (returned,
// next_from, "More matches before #k", "Not shown"), so the runner's cut, a backstop, never fires.
// Rooms as the loop computes them: roomChars(toolRoom(window, replyReserve(window)), 1) (C6), and
// pageChars = min(historyPageChars(window), room).
import { describe, expect, test } from 'bun:test';
import { roomChars } from '../../src/engine/narrate.ts';
import type { LoreBook, LoreEntry } from '../../src/formats/native.ts';
import { replyReserve, toolRoom } from '../../src/prompt/budget.ts';
import { historyPageChars, readHistoryTool, searchHistoryTool } from '../../src/tools/builtin/history.ts';
import { readLoreTool, searchLoreTool } from '../../src/tools/builtin/lore.ts';
import { runTools } from '../../src/tools/run.ts';
import type { Tool, ToolCall, ToolCallOutcome, ToolCtx } from '../../src/tools/types.ts';
import { loadInnkeeper } from '../fixtures/ru/innkeeper-200/load.ts';
import { chatView, ctxFor } from './kit.ts';

const TOOLS: ReadonlyMap<string, Tool> = new Map([readHistoryTool, searchHistoryTool, searchLoreTool, readLoreTool].map((t) => [t.name, t]));

/** The room of a round-0 call on a window (the loop's C6 arithmetic, token factor 1). */
const roomOf = (window: number): number => roomChars(toolRoom(window, replyReserve(window)), 1);

const callOf = (name: string, args: Record<string, unknown>, i = 0): ToolCall => ({ id: `c${i}`, name, args: JSON.stringify(args), round: 0, via: 'native' });

/** One round as narrate.ts runs it: pageChars = min(page, room), roomChars = room. */
function round(ctx: ToolCtx, calls: ToolCall[], room: number, window: number): Promise<ToolCallOutcome[]> {
  return runTools({ calls, tools: TOOLS, ctx: { ...ctx, pageChars: Math.min(historyPageChars(window), room) }, roomChars: room }, () => new Date(0));
}

const nextFrom = (text: string): number | null | undefined => {
  const m = /^next_from: (\d+|null)$/m.exec(text);
  return m === null ? undefined : m[1] === 'null' ? null : Number(m[1]);
};
const returned = (text: string): string | undefined => /^returned: (#\d+ to #\d+)$/m.exec(text)?.[1];

const para = (n: number): string => `Сообщение ${n}. ${'Марфа протёрла стойку, поставила кружку и посмотрела в окно на дорогу. '.repeat(24)}`;
const sized = (len: number) => (n: number): string => `#${n}. ${'Марфа подбросила полено в очаг и долго смотрела на огонь. '.repeat(Math.ceil(len / 50) + 2)}`.slice(0, len);

describe('read_history keeps its cursor under the room', () => {
  for (const window of [16384, 32768]) {
    test(`two read_history calls in one round (window ${window}): both keep returned and next_from, neither is cut`, async () => {
      const view = chatView(Array.from({ length: 60 }, (_, i) => para(i + 1)));
      const room = roomOf(window);
      const out = await round(ctxFor(view), [callOf('read_history', { from: 2 }, 0), callOf('read_history', { from: 30 }, 1)], room, window);
      for (const o of out) {
        expect([o.call.id, o.cut]).toEqual([o.call.id, undefined]);
        expect(nextFrom(o.text)).toBeGreaterThan(2);
        expect(o.text).toContain('You have not read #');
      }
      expect(out.reduce((n, o) => n + o.text.length, 0)).toBeLessThanOrEqual(room);
    });
  }

  test('one read_history while the room (not the page) binds: the paging lines still arrive', async () => {
    const view = chatView(Array.from({ length: 40 }, (_, i) => sized(2125)(i + 1)));
    const [o] = await round(ctxFor(view), [callOf('read_history', { from: 2 })], 6460, 16384);
    expect(o!.cut).toBeUndefined();
    expect(o!.text.length).toBeLessThanOrEqual(6460);
    expect(o!.text).toMatch(/\nnext_from: \d+\nYou have not read #\d+ to #40 yet\. Call read_history with from=\d+ before you say anything about them\.$/);
  });

  test('a first message longer than the room is cut inside it, with its note and the paging lines', async () => {
    const view = chatView(['short', 'z'.repeat(25_000), 'after']);
    const [o] = await round(ctxFor(view), [callOf('read_history', { from: 2, to: 3 })], 3000, 8192);
    expect(o!.cut).toBeUndefined();
    expect(o!.text.length).toBeLessThanOrEqual(3000);
    expect(o!.text).toContain('[#2 continues for ');
    expect(nextFrom(o!.text)).toBe(3);
  });

  for (const window of [8192, 12288, 16384, 32768]) {
    test(`window ${window}: one read_history from every start of the 200-message demo chat never loses its cursor`, async () => {
      const { messages } = loadInnkeeper();
      const view = chatView(messages.map((m) => m.text));
      const ctx = ctxFor(view);
      const room = roomOf(window);
      const lost: number[] = [];
      for (let from = 1; from <= messages.length; from++) {
        const [o] = await round(ctx, [callOf('read_history', { from })], room, window);
        if (o!.cut === true || nextFrom(o!.text) === undefined) lost.push(from);
      }
      expect(lost).toEqual([]);
    });
  }
});

describe('read_history never takes more than its limit, whatever the room (small rooms, late rounds)', () => {
  test('rooms 277 to 1 280 chars, one call and two: never over the limit, never cut by the runner, the cursor always there', async () => {
    const { messages } = loadInnkeeper();
    const view = chatView(messages.map((m) => m.text));
    const ctx = ctxFor(view);
    const lost: string[] = [];
    for (const room of [277, 400, 500, 640, 700, 800, 1000, 1280]) {
      for (let from = 1; from <= messages.length - 40; from += 3) {
        for (const calls of [[callOf('read_history', { from })], [callOf('read_history', { from }, 0), callOf('read_history', { from: from + 30 }, 1)]]) {
          const out = await round(ctx, calls, room, 8192);
          for (const o of out) if (o.cut === true || nextFrom(o.text) === undefined) lost.push(`${room}/${calls.length}/${o.call.args}`);
          expect(out.reduce((n, o) => n + o.text.length, 0)).toBeLessThanOrEqual(room);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  test('a limit that cannot hold a useful head of the first message: only the cursor and the never-claim line', async () => {
    const view = chatView(['short', 'z'.repeat(25_000), 'after']);
    const o = await readHistoryTool.run({ from: 2, to: 3 }, { ...ctxFor(view), pageChars: 277, limit: 277 });
    expect(o.text).toBe('No room was left in this round to read #2.\nnext_from: 2\nYou have not read #2 to #3: never claim to have read them.');
    expect(o.text.length).toBeLessThanOrEqual(277);
    expect(o.error).toBeUndefined();
    // With a little more room the first message's head comes, cut inside the limit, its note and the lines after it.
    const p = await readHistoryTool.run({ from: 2, to: 3 }, { ...ctxFor(view), pageChars: 700, limit: 700 });
    expect(p.text.length).toBeLessThanOrEqual(700);
    expect(p.text).toContain('[#2 continues for ');
    expect(nextFrom(p.text)).toBe(3);
  });
});

describe('D-58: no fewer than two whole messages when the room allows', () => {
  test('16k window, 4 000-character messages: the second comes past the page, whole', async () => {
    const view = chatView(Array.from({ length: 30 }, (_, i) => sized(4000)(i + 1)));
    const room = roomOf(16384);
    expect(historyPageChars(16384)).toBeLessThan(2 * 4000);
    const [o] = await round(ctxFor(view), [callOf('read_history', { from: 2, to: 12 })], room, 16384);
    expect(o!.cut).toBeUndefined();
    expect(returned(o!.text)).toBe('#2 to #3');
    expect(nextFrom(o!.text)).toBe(4);
    expect(o!.text).not.toContain('continues');
  });

  test('20k window, 4 800-character messages: two', async () => {
    const view = chatView(Array.from({ length: 30 }, (_, i) => sized(4800)(i + 1)));
    const [o] = await round(ctxFor(view), [callOf('read_history', { from: 2, to: 12 })], roomOf(20480), 20480);
    expect(o!.cut).toBeUndefined();
    expect(returned(o!.text)).toBe('#2 to #3');
  });

  test('12k window, 3 200-character messages: two do not fit the room, so one comes and the cursor names #3', async () => {
    const view = chatView(Array.from({ length: 30 }, (_, i) => sized(3200)(i + 1)));
    const [o] = await round(ctxFor(view), [callOf('read_history', { from: 2, to: 12 })], roomOf(12288), 12288);
    expect(o!.cut).toBeUndefined();
    expect(returned(o!.text)).toBe('#2 to #2');
    expect(nextFrom(o!.text)).toBe(3);
  });

  test('a third message never comes past the page', async () => {
    const view = chatView(Array.from({ length: 30 }, (_, i) => sized(2000)(i + 1)));
    // Page 6 000, room 30 000: three 2 000-character messages fit the page, a fourth does not.
    const [o] = await round(ctxFor(view), [callOf('read_history', { from: 2, to: 20 })], 30_000, 8192);
    expect(returned(o!.text)).toBe('#2 to #3');
  });
});

describe('the listing tools keep their last line under the room', () => {
  const long = 'Летопись гласит, что замок стоял над рекой задолго до первых королей. '.repeat(40);
  const entry = (id: string, title: string): LoreEntry => ({ id, title, content: long, keys: [title], position: 'before' });
  const lore = [{ key: 'w', book: { name: 'World', entries: [entry('a', 'Замок'), entry('b', 'Река'), entry('c', 'Король')] } as LoreBook }];

  test('read_lore with a 6 400-character room (12k window): no runner cut, the "Not shown" line arrives', async () => {
    const room = roomOf(12288);
    expect(room).toBe(6400);
    const ctx = ctxFor(chatView(['Привет.']), { lore });
    const found = await searchLoreTool.run({ query: 'замок' }, ctx);
    const handles = [...found.text.matchAll(/^(L\d+) /gm)].map((m) => m[1]!);
    expect(handles).toHaveLength(3);
    const [o] = await round(ctx, [callOf('read_lore', { ids: handles })], room, 12288);
    expect(o!.cut).toBeUndefined();
    expect(o!.text.length).toBeLessThanOrEqual(room);
    expect(o!.text).toMatch(/\nNot shown, the result is full: L\d+(, L\d+)*\. Call read_lore with them again\.$/);
  });

  test('two search_history calls in a small room: both keep "More matches before #k"', async () => {
    const view = chatView(Array.from({ length: 80 }, (_, i) => `${i + 1}: лампа ${'горит в окне трактира, и тени пляшут по стенам. '.repeat(8)}`));
    const out = await round(ctxFor(view), [callOf('search_history', { query: 'лампа', limit: 20 }, 0), callOf('search_history', { query: 'тени', limit: 20 }, 1)], 3000, 8192);
    for (const o of out) {
      expect(o.cut).toBeUndefined();
      expect(o.text).toMatch(/\nMore matches before #\d+: call search_history again with before=\d+\.$/);
    }
  });
});
