// Ported from Bunraku:src/formats/_shared/png.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (chunk-order cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PNG text-chunk walk and card chunk choice (§10.5, §19.8). The pinned regression: a V3 card carries
// BOTH `ccv3` (full card) and `chara` (V2 backfill), chunk order is unspecified, and reading the first
// one found silently downgraded such cards to their backfill.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { CardFormatError, readCard, readPngTextChunks } from '../../src/formats/card.ts';
import { b64json, chunk, crc32, makePng } from './png-writer.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cards');

const V3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Ada', description: 'the full card', first_mes: 'v3 hello' } };
const V2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ada', description: 'the backfill', first_mes: 'v2 hello' } };

describe('png writer helper', () => {
  test('crc32 matches the PNG reference value for IEND', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
});

describe('readPngTextChunks', () => {
  test('returns every text chunk in file order', () => {
    const png = makePng([
      { type: 'tEXt', keyword: 'Software', text: 'editor' },
      { type: 'zTXt', keyword: 'Comment', text: 'zipped' },
      { type: 'iTXt', keyword: 'Title', text: 'Заголовок', lang: 'ru', translated: 'Заголовок' },
    ]);
    expect(readPngTextChunks(png)).toEqual([
      { keyword: 'Software', text: 'editor' },
      { keyword: 'Comment', text: 'zipped' },
      { keyword: 'Title', text: 'Заголовок' },
    ]);
  });

  test('iTXt compressed and uncompressed both decode as UTF-8', () => {
    const text = 'ccv3 ✓ — кириллица';
    const png = makePng([
      { type: 'iTXt', keyword: 'a', text, compressed: false },
      { type: 'iTXt', keyword: 'b', text, compressed: true },
    ]);
    expect(readPngTextChunks(png).map((c) => c.text)).toEqual([text, text]);
  });

  test('not a PNG throws CardFormatError', () => {
    expect(() => readPngTextChunks(new Uint8Array([1, 2, 3]))).toThrow(CardFormatError);
  });

  test('a broken compressed chunk is skipped, the rest still reads', () => {
    const bad = chunk('zTXt', Uint8Array.of(...new TextEncoder().encode('junk'), 0, 0, 1, 2, 3));
    const good = makePng([{ type: 'tEXt', keyword: 'ok', text: 'yes' }]);
    // splice the broken chunk right after IHDR (8 signature + 25 IHDR bytes)
    const png = new Uint8Array([...good.subarray(0, 33), ...bad, ...good.subarray(33)]);
    expect(readPngTextChunks(png)).toEqual([{ keyword: 'ok', text: 'yes' }]);
  });

  test('a truncated file keeps the chunks read before the cut', () => {
    const png = makePng([{ type: 'tEXt', keyword: 'first', text: '1' }, { type: 'tEXt', keyword: 'second', text: '2' }]);
    expect(readPngTextChunks(png.subarray(0, png.length - 40)).map((c) => c.keyword)).toEqual(['first']);
  });
});

describe('readCard from PNG: ccv3 wins over chara whatever the order', () => {
  for (const [label, order] of [
    ['chara first', ['chara', 'ccv3']],
    ['ccv3 first', ['ccv3', 'chara']],
  ] as const) {
    test(label, () => {
      const png = makePng(order.map((kw) => ({ type: 'tEXt' as const, keyword: kw, text: b64json(kw === 'ccv3' ? V3 : V2) })));
      const card = readCard(png, 'ada.png').value;
      expect(card.description).toBe('the full card');
      expect(card.greetings).toEqual(['v3 hello']);
      expect(card.extras?.spec).toBe('chara_card_v3');
    });
  }

  test('a chara-only card reads', () => {
    const png = makePng([{ type: 'tEXt', keyword: 'chara', text: b64json(V2) }]);
    expect(readCard(png, 'x.png').value.description).toBe('the backfill');
  });

  test('ccv3 in a zTXt chunk', () => {
    const png = makePng([
      { type: 'tEXt', keyword: 'chara', text: b64json(V2) },
      { type: 'zTXt', keyword: 'ccv3', text: b64json(V3) },
    ]);
    expect(readCard(png, 'x.png').value.description).toBe('the full card');
  });

  test('ccv3 in an iTXt chunk, compressed and not', () => {
    for (const compressed of [false, true]) {
      const png = makePng([
        { type: 'tEXt', keyword: 'chara', text: b64json(V2) },
        { type: 'iTXt', keyword: 'ccv3', text: b64json(V3), compressed },
      ]);
      expect(readCard(png, 'x.png').value.description).toBe('the full card');
    }
  });

  test('an unreadable ccv3 falls back to chara with a warning', () => {
    const png = makePng([
      { type: 'tEXt', keyword: 'ccv3', text: 'not base64 json' },
      { type: 'tEXt', keyword: 'chara', text: b64json(V2) },
    ]);
    const r = readCard(png, 'x.png');
    expect(r.value.description).toBe('the backfill');
    expect(r.warnings.some((w) => w.code === 'chunk_unreadable' && w.path === 'png:ccv3')).toBe(true);
  });

  test('a ccv3 zTXt with a corrupt stream falls back to chara with a warning', () => {
    const kw = new TextEncoder().encode('ccv3');
    const broken = chunk('zTXt', Uint8Array.of(...kw, 0, 0, ...deflateSync(new Uint8Array(10)).subarray(0, 4)));
    const good = makePng([{ type: 'tEXt', keyword: 'chara', text: b64json(V2) }]);
    const png = new Uint8Array([...good.subarray(0, 33), ...broken, ...good.subarray(33)]);
    const r = readCard(png, 'x.png');
    expect(r.value.description).toBe('the backfill');
    expect(r.warnings.map((w) => w.code)).toContain('chunk_unreadable');
  });

  test('raw JSON in the chunk (not base64) is tolerated', () => {
    const png = makePng([{ type: 'iTXt', keyword: 'chara', text: JSON.stringify(V2) }]);
    expect(readCard(png, 'x.png').value.name).toBe('Ada');
  });

  test('a PNG without card chunks is refused', () => {
    expect(() => readCard(makePng([{ type: 'tEXt', keyword: 'Software', text: 'x' }]), 'x.png')).toThrow(
      /no character card/,
    );
  });

  test('a PNG carrying a preset instead of a card is refused by the firewall', () => {
    const png = makePng([{ type: 'tEXt', keyword: 'chara', text: b64json({ name: 'Preset', prompts: [], temperature: 1 }) }]);
    expect(() => readCard(png, 'x.png')).toThrow(/preset/);
  });
});

describe('Seraphina.png (SillyTavern default card)', () => {
  const bytes = readFileSync(join(FIXTURES, 'Seraphina.png'));

  test('has both chara and ccv3 chunks', () => {
    expect(readPngTextChunks(bytes).map((c) => c.keyword)).toEqual(['chara', 'ccv3']);
  });

  test('reads through ccv3 with its embedded book', () => {
    const { value } = readCard(bytes, 'Seraphina.png');
    expect(value.name).toBe('Seraphina');
    expect(value.extras?.spec).toBe('chara_card_v3');
    expect(value.greetings).toHaveLength(1);
    expect(value.creator).toBe('OtisAlejandro');
    expect(value.book?.name).toBe('Eldoria');
    expect(value.book?.entries.map((e) => e.title)).toEqual(['eldoria', 'shadowfang', 'glade', 'power']);
    expect(value.book?.entries.every((e) => e.position === 'before')).toBe(true);
    // empty personality/scenario/system_prompt mean "not set", so no override is fabricated
    expect(value.personality).toBeUndefined();
    expect(value.systemPrompt).toBeUndefined();
    expect(value.depthPrompt).toBeUndefined();
  });
});
