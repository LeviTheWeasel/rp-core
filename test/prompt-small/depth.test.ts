// prompt/depth.ts: ST depth convention, tie-breaks, no merging [D-12, D-47].
import { describe, expect, test } from 'bun:test';
import { fromRcDepth, injectAtDepth, insertSrc, isInsertSrc, type DepthInsert } from '../../src/prompt/depth.ts';
import type { PromptMsg } from '../../src/providers/types.ts';

const msg = (role: PromptMsg['role'], text: string): PromptMsg => ({ role, blocks: [{ k: 'text', text }], src: 'history' });
// greeting, one exchange, current user message
const chat: PromptMsg[] = [msg('assistant', 'G'), msg('user', 'U1'), msg('assistant', 'A1'), msg('user', 'U2')];
const ins = (over: Partial<DepthInsert> & Pick<DepthInsert, 'depth' | 'text'>): DepthInsert => ({
  role: 'system',
  src: 'preset',
  ...over,
});
const texts = (ms: PromptMsg[]) => ms.map((m) => (m.blocks[0] as { text: string }).text);

describe('injectAtDepth', () => {
  test('depth 0 lands after the last message', () => {
    expect(texts(injectAtDepth(chat, [ins({ depth: 0, text: 'X' })]))).toEqual(['G', 'U1', 'A1', 'U2', 'X']);
  });

  test('depth 1 lands right above the current user message', () => {
    expect(texts(injectAtDepth(chat, [ins({ depth: 1, text: 'X' })]))).toEqual(['G', 'U1', 'A1', 'X', 'U2']);
  });

  test('depth d has exactly d chat messages after it', () => {
    for (let d = 0; d <= chat.length; d++) {
      const out = injectAtDepth(chat, [ins({ depth: d, text: 'X' })]);
      const at = out.findIndex((m) => m.src === 'preset');
      expect(out.length - at - 1).toBe(d);
    }
  });

  test('depth >= count lands before the first message, deeper ones higher', () => {
    expect(texts(injectAtDepth(chat, [ins({ depth: 4, text: 'X' })]))).toEqual(['X', 'G', 'U1', 'A1', 'U2']);
    expect(texts(injectAtDepth(chat, [ins({ depth: 99, text: 'X' })]))).toEqual(['X', 'G', 'U1', 'A1', 'U2']);
    const out = injectAtDepth(chat, [ins({ depth: 5, text: 'five' }), ins({ depth: 50, text: 'fifty' })]);
    expect(texts(out)).toEqual(['fifty', 'five', 'G', 'U1', 'A1', 'U2']);
  });

  test('an empty chat takes every insert in order', () => {
    const out = injectAtDepth([], [ins({ depth: 3, text: 'B' }), ins({ depth: 0, text: 'A', order: 1 })]);
    expect(texts(out)).toEqual(['B', 'A']);
  });

  test('negative and NaN depths behave like 0', () => {
    const out = injectAtDepth(chat, [ins({ depth: -2, text: 'N' }), ins({ depth: Number.NaN, text: 'Q' })]);
    expect(texts(out)).toEqual(['G', 'U1', 'A1', 'U2', 'N', 'Q']);
  });

  test('equal depth: order ascending (undefined = 100), then source rank', () => {
    const inserts: DepthInsert[] = [
      ins({ depth: 1, text: 'director', src: 'director' }),
      ins({ depth: 1, text: 'guidance', src: 'guidance' }),
      ins({ depth: 1, text: 'note', src: 'author_note' }),
      ins({ depth: 1, text: 'card', src: 'card_depth' }),
      ins({ depth: 1, text: 'comp', src: 'compendium' }),
      ins({ depth: 1, text: 'lore', src: 'lore' }),
      ins({ depth: 1, text: 'preset', src: 'preset' }),
      ins({ depth: 1, text: 'late', src: 'preset', order: 150 }),
      ins({ depth: 1, text: 'early', src: 'director', order: 50 }),
      ins({ depth: 1, text: 'at100', src: 'preset', order: 100 }),
    ];
    const out = injectAtDepth(chat, inserts);
    expect(texts(out)).toEqual([
      'G', 'U1', 'A1',
      'early',
      // order 100 group: preset (explicit 100 and default, stable input order) < lore < … < guidance
      'preset', 'at100', 'lore', 'comp', 'card', 'note', 'director', 'guidance',
      'late',
      'U2',
    ]);
  });

  test('mixed depths and sources interleave correctly', () => {
    const out = injectAtDepth(chat, [
      ins({ depth: 0, text: 'g', src: 'guidance', role: 'system' }),
      ins({ depth: 1, text: 'dir', src: 'director' }),
      ins({ depth: 4, text: 'cn', src: 'compendium', role: 'user' }),
      ins({ depth: 2, text: 'an', src: 'author_note', role: 'user' }),
      ins({ depth: 1, text: 'lore1', src: 'lore' }),
    ]);
    expect(texts(out)).toEqual(['cn', 'G', 'U1', 'an', 'A1', 'lore1', 'dir', 'U2', 'g']);
    expect(out[0]!.role).toBe('user');
  });

  test('blocks are never merged, even with equal depth, order and role', () => {
    const out = injectAtDepth(chat, [
      ins({ depth: 1, text: 'one', srcId: 'a' }),
      ins({ depth: 1, text: 'two', srcId: 'b' }),
    ]);
    expect(out).toHaveLength(chat.length + 2);
    expect(out[3]).toEqual({ role: 'system', blocks: [{ k: 'text', text: 'one' }], src: 'preset:a', placement: 'inline' });
    expect(out[4]).toEqual({ role: 'system', blocks: [{ k: 'text', text: 'two' }], src: 'preset:b', placement: 'inline' });
  });

  test('src carries the source, with the srcId when given', () => {
    const out = injectAtDepth(chat, [ins({ depth: 0, text: 'x', src: 'author_note' })]);
    expect(out.at(-1)!.src).toBe('author_note');
    expect(insertSrc({ src: 'lore', srcId: 'book/entry' })).toBe('lore:book/entry');
    expect(isInsertSrc('preset:main')).toBe(true);
    expect(isInsertSrc('history')).toBe(false);
    expect(isInsertSrc('constructor')).toBe(false);
  });

  test('blank inserts are skipped; chat messages and input arrays are untouched', () => {
    const before = structuredClone(chat);
    const inserts = [ins({ depth: 1, text: '  \n' })];
    const out = injectAtDepth(chat, inserts);
    expect(texts(out)).toEqual(['G', 'U1', 'A1', 'U2']);
    expect(out).not.toBe(chat);
    expect(out[0]).toBe(chat[0]!);
    expect(chat).toEqual(before);
  });

  test('fromRcDepth adds one (RC depth 0 = ST depth 1)', () => {
    expect(fromRcDepth(0)).toBe(1);
    const rc0 = injectAtDepth(chat, [ins({ depth: fromRcDepth(0), text: 'X' })]);
    expect(texts(rc0)).toEqual(['G', 'U1', 'A1', 'X', 'U2']);
  });
});
