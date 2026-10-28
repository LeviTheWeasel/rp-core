// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c D-205 (D-89): the history_crowded check read off assembled requests (engine/request.ts
// historyCrowded, fixedTokens, crowdedNotice). The history sent holds fewer than 4 messages before U
// although the path holds more and preset.context.maxMessages alone would send more.
import { describe, expect, test } from 'bun:test';
import { crowdedNotice, fixedTokens, HISTORY_CROWDED, HISTORY_CROWDED_MIN, historyCrowded } from '../../src/engine/request.ts';
import { assemble, HISTORY_SRC, type AssembleInput } from '../../src/prompt/assemble.ts';
import { estimateToolSpecs, CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import type { MessageView } from '../../src/session/view.ts';
import { greet, input, m, ok, path, SHORT_PATH } from '../assemble/fixtures.ts';
import { SPECS } from '../prompt-m3/fixtures.ts';

/**
 * A greeting (unless `greeting` is false), then `n` messages, user first (an odd n ends on a user
 * message, u<n-1>), each about `size` characters.
 */
function chat(n: number, size = 60, greeting = true): MessageView[] {
  const msgs = Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? m(`u${i}`, 'user', `Line ${i}: ${'u'.repeat(size)}`) : m(`a${i}`, 'assistant', `Line ${i}: ${'a'.repeat(size)}`),
  );
  return greeting ? [greet('g', 'Hello, traveller.'), ...msgs] : msgs;
}

const planOf = (i: AssembleInput) => ({ kind: i.kind, upTo: i.upTo, preset: i.preset });

/** Assemble and check, with the input that produced them. */
function check(over: Partial<AssembleInput>) {
  const inp = input(over);
  const r = assemble(inp);
  if (!r.ok) return null;
  return { inp, r, found: historyCrowded(inp.view, planOf(inp), r) };
}

/** Ids the request sends before the path message `before` (by path position). */
function sentBefore(view: { path: readonly MessageView[] }, kept: readonly string[], before: string): number {
  const at = view.path.findIndex((x) => x.id === before);
  return kept.filter((id) => view.path.findIndex((x) => x.id === id) < at).length;
}

describe('historyCrowded', () => {
  test('nothing left out: never crowded, the path is not even read', () => {
    const r = ok(assemble(input()));
    expect(r.trace.trimmed).toBeNull();
    expect(historyCrowded(input().view, planOf(input()), r)).toBeNull();
    // A view that does not hold upTo would throw in assemble; the check never looks.
    expect(historyCrowded(path([]), { kind: 'reply', upTo: 'nowhere', preset: input().preset }, r)).toBeNull();
  });

  test('across windows and grid offsets: crowded exactly when fewer than 4 earlier messages are sent while some are left out', () => {
    // The cut moves 8 messages at a time from the oldest, so the path's length decides which counts a
    // window can leave: these three paths between them leave 0, 1, 3, 4 and every message.
    const views = [
      { view: path(chat(27)), u: 'u26', before: 27 },
      { view: path(chat(31)), u: 'u30', before: 31 },
      { view: path(chat(29, 60, false)), u: 'u28', before: 28 },
    ];
    const seen = new Map<number, boolean>();
    for (const { view, u, before } of views) {
      for (let window = 200; window <= 1200; window += 5) {
        const c = check({ view, upTo: u, window, reserve: 100 });
        if (c === null) continue; // the protected part does not fit at all
        const sent = sentBefore(view, c.r.kept, u);
        const want = c.r.trace.trimmed !== null && sent < HISTORY_CROWDED_MIN;
        expect(c.found !== null).toBe(want);
        if (c.found) expect(c.found).toEqual({ before, sent });
        seen.set(sent, want);
      }
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(expect.arrayContaining([0, 1, 3, 4, 27, 28, 31]));
    expect(seen.get(0)).toBe(true); // the greeting dropped too
    expect(seen.get(1)).toBe(true);
    expect(seen.get(HISTORY_CROWDED_MIN - 1)).toBe(true);
    expect(seen.get(HISTORY_CROWDED_MIN)).toBe(false);
    expect(seen.get(31)).toBe(false);
  });

  test('the greeting dropped as a last resort is not counted as sent; it is counted as earlier', () => {
    const view = path([greet('g', `Hello. ${'g'.repeat(900)}`), ...chat(5).slice(1)]);
    const c = check({ view, upTo: 'u4', window: 500, reserve: 100 })!;
    expect(c.r.notices.map((n) => n.code)).toContain('greeting_dropped');
    expect(c.r.kept).not.toContain('g');
    expect(c.found).toEqual({ before: 5, sent: sentBefore(view, c.r.kept, 'u4') });
    expect(c.found!.sent).toBeLessThan(HISTORY_CROWDED_MIN);
  });

  test('hidden and blank messages are not earlier messages', () => {
    const msgs = chat(31);
    msgs[3] = { ...msgs[3]!, hidden: true };
    msgs[4] = m('a3', 'assistant', '   ');
    const view = path(msgs);
    const c = check({ view, upTo: 'u30', window: 300, reserve: 100 })!;
    expect(c.found).toEqual({ before: 29, sent: 1 });
  });

  test('a path with fewer than 4 earlier messages is crowded only when one of them is left out', () => {
    const view = path(chat(3, 300));
    const whole = check({ view, upTo: 'u2', window: 4000, reserve: 100 })!;
    expect(whole.r.trace.trimmed).toBeNull();
    expect(whole.found).toBeNull();
    const cut = check({ view, upTo: 'u2', window: 400, reserve: 100 })!;
    expect(cut.r.trace.trimmed).not.toBeNull();
    expect(cut.found).toEqual({ before: 3, sent: 1 });
  });

  test('continue: the earlier messages are those before the U the answer replies to', () => {
    const view = path(chat(32));
    const c = check({ view, upTo: 'a31', kind: 'continue', window: 350, reserve: 100 })!;
    expect(c.r.kept).toEqual(['g', 'u30', 'a31']);
    expect(c.found).toEqual({ before: 31, sent: 1 });
    // A reply up to the same answer counts the earlier messages before a31 itself.
    const reply = check({ view, upTo: 'a31', window: 300, reserve: 100 })!;
    expect(reply.found).toEqual({ before: 32, sent: 1 });
  });

  test('preset.context.maxMessages: a preset that keeps few messages on purpose is not crowded; the budget cutting below it is', () => {
    const limit = (maxMessages: number) => ({ ...input().preset, context: { maxMessages } });
    const view = path(chat(31));
    const roomy = check({ view, upTo: 'u30', preset: limit(3), window: 100_000, reserve: 100 })!;
    expect(roomy.r.trace.trimmed).not.toBeNull();
    expect(sentBefore(view, roomy.r.kept, 'u30')).toBe(1);
    expect(roomy.found).toBeNull();
    // The budget leaving out the greeting as well goes below what the limit sends: crowded.
    expect(check({ view, upTo: 'u30', preset: limit(3), window: 240, reserve: 100 })!.found).toEqual({ before: 31, sent: 0 });

    // A limit of 10 on 27 earlier messages lands its grid cut at 3 of them (the greeting and two).
    const short = path(chat(27));
    const grid = check({ view: short, upTo: 'u26', preset: limit(10), window: 100_000, reserve: 100 })!;
    expect(sentBefore(short, grid.r.kept, 'u26')).toBe(3);
    expect(grid.found).toBeNull();
    expect(check({ view: short, upTo: 'u26', preset: limit(10), window: 250, reserve: 100 })!.found).toEqual({ before: 27, sent: 1 });

    // A generous limit the budget cuts far below: crowded.
    expect(check({ view, upTo: 'u30', preset: limit(20), window: 300, reserve: 100 })!.found).toEqual({ before: 31, sent: 1 });
  });
});

describe('fixedTokens', () => {
  test('every message but the history, in the request counter; scaled by the EMA correction', () => {
    const c = check({ view: path(chat(31)), upTo: 'u30', window: 300, reserve: 100 })!;
    expect(c.found).not.toBeNull();
    const rows = c.r.trace.blocks;
    const fixed = rows.filter((b) => b.src !== HISTORY_SRC).reduce((s, b) => s + b.tok, 0);
    const history = rows.filter((b) => b.src === HISTORY_SRC).reduce((s, b) => s + b.tok, 0);
    expect(fixedTokens(c.r, 1, false)).toBe(fixed);
    // It is the never-trimmed part the budget fit: with the history sent it stays within the window less the reserve.
    expect(fixed + history).toBeLessThanOrEqual(300 - 100);
    expect(fixedTokens(c.r, 1.5, false)).toBe(Math.ceil(fixed * 1.5));
    expect(fixedTokens(c.r, Number.NaN, false)).toBe(fixed);
  });

  test('a sent prefill and native tool declarations count; prompted tools are already messages', () => {
    const prefilled = ok(assemble(input({ preset: { ...input().preset, prefill: 'Sure, here it is:' } })));
    expect(prefilled.prefill).toBe('Sure, here it is:');
    const rows = prefilled.trace.blocks.filter((b) => b.src !== HISTORY_SRC).reduce((s, b) => s + b.tok, 0);
    expect(fixedTokens(prefilled, 1, false)).toBeGreaterThan(rows);

    const tools = ok(assemble(input({ tools: SPECS })));
    expect(tools.tools.length).toBe(2);
    expect(fixedTokens(tools, 1, true) - fixedTokens(tools, 1, false)).toBe(estimateToolSpecs(tools.tools, CHARS_COUNTER));
  });
});

describe('crowdedNotice', () => {
  const at = { window: 16_384, reserve: 2_048, toolRoom: 0 };

  test('keyed once per session by its code; names the fixed part, the window and the reserve; advises /model and /preset builtin', () => {
    const n = crowdedNotice({ before: 30, sent: 2 }, 11_234, at);
    expect(n.key).toBe(HISTORY_CROWDED);
    expect(n.notice.code).toBe('history_crowded');
    expect(n.notice.level).toBe('warn');
    expect(n.notice.message).toBe(
      'Only 2 of the 30 earlier messages fit in the request: the fixed part of the prompt (everything but the chat history) ' +
        'takes about 11234 of the 14336 tokens a request may use (window 16384 - reply reserve 2048). A narrator with a larger ' +
        'window (/model) or a lighter preset (/preset builtin) leaves the history more room; /preview shows the parts.',
    );
  });

  test('the tool room is named when tools are offered; counts read right at one and none', () => {
    expect(crowdedNotice({ before: 30, sent: 2 }, 9_000, { ...at, toolRoom: 3_584 }).notice.message).toContain(
      '(window 16384 - reply reserve 2048), and 3584 more are kept free for tool rounds.',
    );
    expect(crowdedNotice({ before: 9, sent: 1 }, 1, at).notice.message).toStartWith('Only 1 of the 9 earlier messages fits in the request');
    expect(crowdedNotice({ before: 9, sent: 0 }, 1, at).notice.message).toStartWith('None of the 9 earlier messages fit in the request');
    expect(crowdedNotice({ before: 1, sent: 0 }, 1, at).notice.message).toStartWith('The earlier message does not fit in the request');
  });

  test('a short path stays quiet', () => {
    const inp = input({ view: path(SHORT_PATH()) });
    expect(historyCrowded(inp.view, planOf(inp), ok(assemble(inp)))).toBeNull();
  });
});
