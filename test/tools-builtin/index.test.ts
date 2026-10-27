// Ported from RoleCall:apps/rc/src/lib/ai/btw/__tests__/scene-history-guidance.test.ts@fb8dc623e and
// Bunraku:src/studio/dramaturg-tools.test.ts@702d8120 (strict schemas, unknown arguments).
// Copyright (C) 2026 Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The built-in tool set (src/tools/builtin/index.ts; §9.2, D-5): names, flat strict schemas, sorted
// specs, the descriptions that teach how to search and read (RoleCall
// ai/btw/__tests__/scene-history-guidance.test.ts, Levi: pin the guidance), and the tools run
// through runTools (argument chain, unknown arguments refused by name, maxOutput honoured).
import { describe, expect, test } from 'bun:test';
import { HISTORY_TOOLS, LORE_TOOLS, toolSpecs } from '../../src/tools/builtin/index.ts';
import { outputRoom, PAGE_FLOOR_CHARS, readHistoryTool, searchHistoryTool } from '../../src/tools/builtin/history.ts';
import { readLoreTool, searchLoreTool } from '../../src/tools/builtin/lore.ts';
import { runTools } from '../../src/tools/run.ts';
import type { Tool, ToolCall, ToolCtx } from '../../src/tools/types.ts';
import { renderCoreBlock } from '../../src/tools/prompted.ts';
import { fakeClock } from '../helpers.ts';
import { chatView, ctxFor } from './kit.ts';

const ALL = [...HISTORY_TOOLS(), ...LORE_TOOLS()];
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const table = (tools: readonly Tool[]) => new Map(tools.map((t) => [t.name, t]));
const callOf = (name: string, args: string, i = 0): ToolCall => ({ id: `call_0_${i}`, name, args, round: 0, via: 'native' });
const runOne = async (name: string, args: string, ctx: ToolCtx, roomChars = 1_000_000) =>
  (await runTools({ calls: [callOf(name, args)], tools: table(ALL), ctx, roomChars }, fakeClock()))[0]!;

describe('the tool set', () => {
  test('history tools and lore tools; every one read-only, SAFE_NAME, a flat object schema that refuses unknown keys', () => {
    expect(HISTORY_TOOLS().map((t) => t.name)).toEqual(['search_history', 'read_history']);
    expect(LORE_TOOLS().map((t) => t.name)).toEqual(['search_lore', 'read_lore']);
    for (const t of ALL) {
      expect(t.effect).toBe('read');
      expect(t.name).toMatch(SAFE_NAME);
      expect(t.schema['type']).toBe('object');
      expect(t.schema['additionalProperties']).toBe(false);
      expect(Object.keys(t.schema)).not.toContain('anyOf');
      const props = t.schema['properties'] as Record<string, Record<string, unknown>>;
      for (const p of Object.values(props)) {
        expect(typeof p['type']).toBe('string');
        expect(typeof p['description']).toBe('string');
      }
      for (const r of t.schema['required'] as string[]) expect(Object.keys(props)).toContain(r);
    }
  });

  test('toolSpecs: sorted by name, the same text every time (it sits in the cached prefix)', () => {
    const specs = toolSpecs([...LORE_TOOLS(), ...HISTORY_TOOLS()]);
    expect(specs.map((s) => s.name)).toEqual(['read_history', 'read_lore', 'search_history', 'search_lore']);
    expect(JSON.stringify(toolSpecs(ALL))).toBe(JSON.stringify(toolSpecs([...ALL].reverse())));
    // The prompted catalog renders them deterministically too.
    expect(renderCoreBlock(specs, 'prompted')).toBe(renderCoreBlock(toolSpecs(ALL), 'prompted'));
  });

  test('model-facing text is English: descriptions and parameter texts hold no Cyrillic outside the examples', () => {
    for (const t of ALL) {
      const texts = [t.description, ...Object.values(t.schema['properties'] as Record<string, { description: string }>).map((p) => p.description)];
      for (const s of texts) expect(s.replace(/братом|брата|брат/g, '')).not.toMatch(/\p{Script=Cyrillic}/u);
    }
  });
});

describe('the descriptions teach the method', () => {
  test('search_history: roots and short forms with an example, quotes for phrases, read before quoting, empty is about wording', () => {
    const d = searchHistoryTool.description;
    expect(d).toContain('search by word roots and short forms');
    expect(d).toContain('брат finds брата and братом');
    expect(d).toMatch(/exact phrase in quotes/);
    expect(d).toMatch(/read it with read_history before you quote it/);
    expect(d).toMatch(/No hits means the words did not match, not that it never happened/);
    expect(d).toMatch(/newest first/);
  });

  test('read_history forbids claiming unread messages; read_lore names its handles and its limit', () => {
    expect(readHistoryTool.description).toMatch(/never claim to have read, summarise or quote a message it did not return/);
    expect(readHistoryTool.description).toMatch(/null once the whole range is read/);
    expect(readLoreTool.description).toMatch(/handles search_lore gave \(like L3 or C2\)/);
    expect(readLoreTool.description).toContain('8000 characters');
    expect(searchLoreTool.description).toMatch(/word roots and short forms/);
  });
});

describe('through runTools', () => {
  const lamps = chatView(Array.from({ length: 40 }, (_, i) => `lamp ${i + 1}`));

  test('an unknown argument is refused by name (additionalProperties false), the tool not run', async () => {
    const o = await runOne('read_history', '{"from": 1, "to": 2, "all": true}', ctxFor(lamps));
    expect(o.refused).toBe('bad_args');
    expect(o.text).toContain('all');
    expect(o.text).toMatch(/complete JSON object/);
  });

  test('a missing required value is never invented', async () => {
    const o = await runOne('search_history', '{"limit": 3}', ctxFor(lamps));
    expect(o.refused).toBe('bad_args');
    expect(o.text).toContain('query');
  });

  test('limit as a string is coerced; a limit above 20 is clamped, not refused', async () => {
    const coerced = await runOne('search_history', '{"query": "lamp", "limit": "3"}', ctxFor(lamps));
    expect(coerced.ok).toBe(true);
    expect(coerced.text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(3);
    const big = await runOne('search_history', '{"query": "lamp", "limit": 50}', ctxFor(lamps));
    expect(big.ok).toBe(true);
    expect(big.text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(20);
    expect(big.text.split('\n').at(-1)).toBe('More matches before #21: call search_history again with before=21.');
    const zero = await runOne('search_history', '{"query": "lamp", "limit": 0}', ctxFor(lamps));
    expect(zero.refused).toBe('bad_args');
  });

  test('a full read_history page reaches the model whole: its maxOutput is the page + 1 000, above the 4 000 default', async () => {
    const view = chatView(Array.from({ length: 30 }, (_, i) => `${i + 1}:${'w'.repeat(1800)}`));
    const ctx = ctxFor(view, { pageChars: 14745 });
    const o = await runOne('read_history', '{"from": 1, "to": 30}', ctx);
    expect(o.ok).toBe(true);
    expect(o.cut).toBeUndefined();
    expect(o.text.length).toBeGreaterThan(4000);
    expect(o.text).toMatch(/next_from: \d+/);
    expect(o.text).toContain('returned: #1 to #8');
  });

  test('read_lore takes one handle as a bare string (the chain wraps a scalar into the array)', async () => {
    const ctx = ctxFor(chatView(['Hello.']), {
      lore: [{ key: 'w', book: { name: 'W', entries: [{ id: 'a', title: 'Lamp', content: 'It burns.', keys: ['lamp'], position: 'before' }] } }],
    });
    const found = await runOne('search_lore', '{"query": "lamp"}', ctx);
    expect(found.text).toBe('L1 Lamp (W): It burns.');
    const read = await runOne('read_lore', '{"ids": "L1"}', ctx);
    expect(read.ok).toBe(true);
    expect(read.text).toBe('L1 Lamp (W):\nIt burns.');
  });

  test('the same call twice in a round runs once and both get the same text', async () => {
    const ctx = ctxFor(lamps);
    const out = await runTools(
      { calls: [callOf('search_history', '{"query":"lamp","limit":2}', 0), callOf('search_history', '{"limit":2,"query":"lamp"}', 1)], tools: table(ALL), ctx, roomChars: 1_000_000 },
      fakeClock(),
    );
    expect(out[0]!.text).toBe(out[1]!.text);
    expect(out[0]!.text).toMatch(/^#40 Levi: lamp 40\n#39 Mira: lamp 39\nMore matches before #39/);
  });
});

describe('a short tool room (ctx.pageChars below the smallest page)', () => {
  test('outputRoom: the tool max, lowered to pageChars only below PAGE_MIN_CHARS, never under PAGE_FLOOR_CHARS', () => {
    const at = (pageChars: number) => ctxFor(chatView(['Hello.']), { pageChars });
    expect(outputRoom(at(6000), 8000)).toBe(8000);
    expect(outputRoom(at(18000), 8000)).toBe(8000);
    expect(outputRoom(at(3000), 8000)).toBe(3000);
    expect(outputRoom(at(3000), 2000)).toBe(2000);
    expect(outputRoom(at(100), 8000)).toBe(PAGE_FLOOR_CHARS);
    expect(outputRoom(at(Number.NaN), 8000)).toBe(8000);
  });

  test('search_history fits its lines to the room and points the cursor at the last one shown', async () => {
    const view = chatView(Array.from({ length: 40 }, (_, i) => `${'слово '.repeat(30)}лампа ${i + 1} ${'слово '.repeat(30)}`));
    const ctx = ctxFor(view, { pageChars: 900 });
    const out = await searchHistoryTool.run({ query: 'лампа' }, ctx);
    expect(out.text.length).toBeLessThanOrEqual(searchHistoryTool.maxOutput!(ctx));
    const shown = out.text.split('\n').filter((l) => l.startsWith('#')).map((l) => Number(/^#(\d+)/.exec(l)![1]));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(10);
    expect(out.text.split('\n').at(-1)).toBe(`More matches before #${shown.at(-1)}: call search_history again with before=${shown.at(-1)}.`);
    // Through the runner the result is not cut.
    const [o] = await runTools({ calls: [callOf('search_history', '{"query":"лампа"}')], tools: table(ALL), ctx, roomChars: 900 }, fakeClock());
    expect(o!.cut).toBeUndefined();
  });

  test('search_lore shows the rows that fit and counts the rest; handles only for rows shown', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, title: `Lamp ${i}`, content: `${'oil '.repeat(60)}lamp`, keys: ['lamp'], position: 'before' as const }));
    const ctx = ctxFor(chatView(['Hello.']), { pageChars: 900, lore: [{ key: 'w', book: { name: 'W', entries } }] });
    const out = await searchLoreTool.run({ query: 'lamp' }, ctx);
    expect(out.text.length).toBeLessThanOrEqual(searchLoreTool.maxOutput!(ctx));
    const rows = out.text.split('\n').filter((l) => /^L\d+ /.test(l));
    expect(rows.length).toBeLessThan(10);
    expect(out.text.split('\n').at(-1)).toBe(`${10 - rows.length} more match; add a word to narrow it.`);
    expect(ctx.handles.resolve(`L${rows.length + 1}`)).toBeUndefined();
  });

  test('read_lore caps at the room and says so in its cut note', async () => {
    const ctx = ctxFor(chatView(['Hello.']), { pageChars: 900, lore: [{ key: 'w', book: { name: 'W', entries: [{ id: 'a', title: 'Lamp', content: 'x'.repeat(3000), keys: ['lamp'], position: 'before' }] } }] });
    await searchLoreTool.run({ query: 'lamp' }, ctx);
    const out = await readLoreTool.run({ ids: ['L1'] }, ctx);
    expect(readLoreTool.maxOutput!(ctx)).toBe(900);
    expect(out.text.length).toBeLessThanOrEqual(900);
    expect(out.text).toMatch(/\[L1 continues for \d+ more characters past the 900-character limit\]$/);
  });
});
