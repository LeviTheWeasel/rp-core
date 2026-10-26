// Card field mapping and the cross-kind firewall (§5.1, §10.5, §19.8).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardFormatError, isCardObject, parseCardObject, readCard } from '../../src/formats/card.ts';
import { validateCharacter } from '../../src/formats/native.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cards');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const codes = (ws: { code: string }[]): string[] => ws.map((w) => w.code);

describe('parseCardObject: V3 (v3-full.json)', () => {
  const { value, warnings } = parseCardObject(fixture('v3-full.json'));

  test('maps the native fields', () => {
    expect(value.name).toBe('Alice');
    expect(value.description).toStartWith('A curious adventurer');
    expect(value.personality).toBe('Curious, brave, kind-hearted, occasionally reckless');
    expect(value.scenario).toStartWith('You meet Alice');
    expect(value.greetings).toEqual([
      'Oh! Another adventurer! I was just about to head inside. Want to join me?',
      'Hey there! Looking for treasure?',
      '*Alice waves excitedly* Another explorer!',
    ]);
    expect(value.examples).toStartWith('<START>');
    expect(value.systemPrompt).toBe('You are Alice, a brave and curious adventurer in a fantasy world.');
    expect(value.postHistory).toBe("Remember to describe Alice's surroundings.");
    expect(value.creator).toBe('ExampleCreator');
    expect(value.tags).toEqual(['fantasy', 'adventure', 'female']);
  });

  test('V3-only fields ride extras; behaviour-changing ones warn', () => {
    expect(value.extras?.spec).toBe('chara_card_v3');
    expect(value.extras?.nickname).toBe('Ali');
    expect(value.extras?.group_only_greetings).toEqual(["Looks like we've got a proper party now!"]);
    expect(value.extras?.creator_notes).toBe('Alice is designed for fantasy adventure roleplay.');
    expect(value.extras?.source).toEqual(['https://example.com/alice']);
    const paths = warnings.filter((w) => w.code === 'not_honoured').map((w) => w.path);
    expect(paths).toContain('data.nickname');
    expect(paths).toContain('data.group_only_greetings');
    expect(paths).toContain('data.assets');
    expect(paths).not.toContain('data.creator_notes');
  });

  test('character_book becomes book with literal match and no invented defaults', () => {
    const book = value.book;
    expect(book?.name).toBe("Alice's World");
    expect(book?.match).toBe('literal');
    expect(book?.scanDepth).toBe(2);
    expect(book?.recursive).toBe(true);
    expect(book?.entries).toHaveLength(2);
    const [sword, caves] = book?.entries ?? [];
    expect(sword).toEqual({
      id: '0',
      content: sword?.content ?? '',
      enabled: true,
      keys: ['sword', 'Starfall', 'weapon'],
      position: 'after', // no position at all: ST's card-book default
      order: 0,
    });
    expect(caves?.secondary).toEqual(['explore', 'enter']);
    expect(caves?.logic).toBeUndefined(); // absent stays absent (engine default is and_any)
    expect(warnings.some((w) => w.path === 'data.character_book.entries[0].content')).toBe(true); // @@decorators
  });

  test('the result validates as a core.character/1', () => {
    expect(validateCharacter(value)).toEqual({ ok: true, value });
  });
});

describe('parseCardObject: V2 with depth_prompt (v2-depth-prompt.json)', () => {
  const { value, warnings } = parseCardObject(fixture('v2-depth-prompt.json'));

  test('depth_prompt maps with string depth coerced and the authored role', () => {
    expect(value.depthPrompt).toEqual({ text: "[{{char}} never leaves the lighthouse at night.]", depth: 2, role: 'user' });
    expect(value.extras?.extensions).toEqual({ talkativeness: '0.5', fav: false, world: '', my_tool: { keep: true } });
  });

  test('greetings skip the empty first_mes and empty alternates', () => {
    expect(value.greetings).toEqual(["*The lamp turns.* You're late.", "Storm's coming."]);
  });

  test('empty strings are "not set": no empty override is fabricated', () => {
    expect(value.scenario).toBeUndefined();
    expect(value.systemPrompt).toBeUndefined();
    expect(value.postHistory).toBe('Keep replies under 200 words.');
    expect(value.tags).toEqual(['test', 'lighthouse']);
  });

  test('Cyrillic name kept; unknown extension warns; empty world does not', () => {
    expect(value.name).toBe('Мира Солнцева');
    expect(warnings).toContainEqual({ code: 'unknown_field', path: 'data.extensions.my_tool', message: expect.any(String) });
    expect(warnings.some((w) => w.path === 'data.extensions.world')).toBe(false);
  });

  test('depth_prompt defaults: role system, depth 4; an empty prompt means none', () => {
    const base = { spec: 'chara_card_v2', data: { name: 'X', description: '' } };
    const withDp = (dp: unknown) =>
      parseCardObject({ ...base, data: { ...base.data, extensions: { depth_prompt: dp } } }).value;
    expect(withDp({ prompt: 'note' }).depthPrompt).toEqual({ text: 'note', depth: 4, role: 'system' });
    expect(withDp({ prompt: '', depth: 4, role: 'system' }).depthPrompt).toBeUndefined();
    expect(withDp({ prompt: '   ', depth: 1 }).depthPrompt).toBeUndefined();
    const bad = parseCardObject({ ...base, data: { ...base.data, extensions: { depth_prompt: { prompt: 'n', role: 'narrator' } } } });
    expect(bad.value.depthPrompt?.role).toBe('system');
    expect(codes(bad.warnings)).toContain('invalid_value');
  });
});

describe('parseCardObject: V1 and flat cards', () => {
  test('V1 flat card', () => {
    const { value } = parseCardObject({
      name: 'Old',
      description: 'd',
      personality: 'p',
      scenario: 's',
      first_mes: 'hi',
      mes_example: 'ex',
      avatar: 'none',
      chat: 'Old - 2023',
    });
    expect(value).toEqual({
      name: 'Old',
      description: 'd',
      personality: 'p',
      scenario: 's',
      greetings: ['hi'],
      examples: 'ex',
      extras: { avatar: 'none', chat: 'Old - 2023' },
    });
  });

  test('flat card with V2 fields at the top level', () => {
    const { value } = parseCardObject({ name: 'Flat', system_prompt: 'sys', alternate_greetings: ['a', 'b'] });
    expect(value.systemPrompt).toBe('sys');
    expect(value.description).toBe('');
    expect(value.greetings).toEqual(['a', 'b']);
  });

  test('a V2 envelope keeps unknown top-level keys under extras.envelope and drops ST mirrors', () => {
    const { value, warnings } = parseCardObject({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      name: 'Mirror',
      description: 'mirror text',
      create_date: 'x',
      exporter: 'some-tool',
      data: { name: 'Real', description: 'real text' },
    });
    expect(value.name).toBe('Real');
    expect(value.description).toBe('real text');
    expect(value.extras?.envelope).toEqual({ exporter: 'some-tool' });
    expect(warnings).toContainEqual({ code: 'unknown_field', path: 'exporter', message: expect.any(String) });
  });
});

describe('embedded books', () => {
  const entry = (k: string) => ({ keys: [k], content: k });

  test('books from data.character_book and extensions.character_book merge into one', () => {
    const { value, warnings } = parseCardObject({
      spec: 'chara_card_v2',
      data: {
        name: 'Two',
        character_book: { name: 'Main', entries: [entry('a')] },
        extensions: { character_book: { entries: [entry('b')] } },
      },
    });
    expect(value.book?.name).toBe('Main');
    expect(value.book?.entries.map((e) => [e.id, e.keys[0]])).toEqual([
      ['0', 'a'],
      ['0-2', 'b'],
    ]);
    expect(codes(warnings)).toContain('books_merged');
    expect(value.extras?.extensions).toBeUndefined();
  });

  test('identical copies collapse; a nameless book is named after the character', () => {
    const book = { entries: [entry('a')] };
    const { value, warnings } = parseCardObject({
      spec: 'chara_card_v2',
      data: { name: 'Same', character_book: book, extensions: { character_book: structuredClone(book) } },
    });
    expect(value.book?.entries).toHaveLength(1);
    expect(value.book?.name).toBe("Same's book");
    expect(codes(warnings)).not.toContain('books_merged');
  });

  test('a book at the envelope top level (hybrid exporters) is read; a non-book stays in extras with a warning', () => {
    const top = parseCardObject({ spec: 'chara_card_v2', character_book: { entries: [entry('t')] }, data: { name: 'Top' } });
    expect(top.value.book?.entries[0]?.keys).toEqual(['t']);
    expect(top.value.extras?.envelope).toBeUndefined();
    const bad = parseCardObject({ spec: 'chara_card_v2', data: { name: 'Bad', character_book: 'none' } });
    expect(bad.value.book).toBeUndefined();
    expect(bad.value.extras?.character_book).toBe('none');
    expect(bad.warnings).toEqual([{ code: 'invalid_value', path: 'data.character_book', message: expect.any(String) }]);
  });

  test("RoleCall's extensions.character_books array (several embedded books) is read, not lost in extras", () => {
    const { value, warnings } = parseCardObject({
      spec: 'chara_card_v2',
      data: {
        name: 'Many',
        extensions: { character_books: [{ name: 'People', entries: [entry('p')] }, { name: 'Places', entries: [entry('q')] }] },
      },
    });
    expect(value.book?.name).toBe('People');
    expect(value.book?.entries.map((e) => e.keys[0])).toEqual(['p', 'q']);
    expect(codes(warnings)).toContain('books_merged');
    expect(codes(warnings)).not.toContain('unknown_field');
    expect(value.extras?.extensions).toBeUndefined();
    // A bad element keeps the array in extras (with a warning) and loses nothing.
    const bad = parseCardObject({ spec: 'chara_card_v2', data: { name: 'Bad', extensions: { character_books: [{ entries: [entry('x')] }, 'junk'] } } });
    expect(bad.value.book?.entries.map((e) => e.keys[0])).toEqual(['x']);
    expect((bad.value.extras?.extensions as { character_books?: unknown[] })?.character_books).toHaveLength(2);
    expect(bad.warnings.some((w) => w.path === 'data.extensions.character_books[1]')).toBe(true);
  });

  test('a null character_book is simply absent', () => {
    const { value, warnings } = parseCardObject({ spec: 'chara_card_v2', data: { name: 'N', character_book: null } });
    expect(value.book).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('firewall: other SillyTavern kinds are not cards', () => {
  const preset = { name: 'My Preset', temperature: 0.8, prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [], extensions: {} };
  const worldInfo = { name: 'World', entries: { '0': { uid: 0, key: ['a'], content: 'x' } }, description: 'a book' };
  const charBook = { name: 'Book', description: 'about', entries: [{ keys: ['a'], content: 'x' }], extensions: {} };
  const instruct = { name: 'ChatML', input_sequence: '<|im_start|>user', description: 'x' };

  for (const [label, obj, reason] of [
    ['chat-completion preset', preset, /preset/],
    ['world info file', worldInfo, /world book/],
    ['standalone character_book', charBook, /world book/],
    ['instruct template', instruct, /preset or template/],
  ] as const) {
    test(`${label} is rejected`, () => {
      expect(isCardObject(obj)).toBe(false);
      expect(() => parseCardObject(obj)).toThrow(reason);
    });
  }

  test("other apps' records with card-like edges are refused with what they are (D-72)", () => {
    const vn = { name: 'The Ambrosia Vice', description: 'A VN', vn_type: 'dating', cast: [], scenes: [], story_graph: [] };
    const agnai = { kind: 'character', name: 'Robot', persona: { kind: 'text', attributes: {} }, greeting: 'Beep.', scenario: 'A lab', sampleChat: '' };
    expect(isCardObject(vn)).toBe(false);
    expect(() => parseCardObject(vn)).toThrow(/visual-novel project/);
    expect(isCardObject(agnai)).toBe(false);
    expect(() => parseCardObject(agnai)).toThrow(/Agnai character/);
    expect(() => parseCardObject({ kind: 'preset', name: 'x', description: 'y' })).toThrow(/"preset" record/);
    // A real flat card is still a card.
    expect(isCardObject({ name: 'Flat', description: 'd', first_mes: 'hi' })).toBe(true);
  });

  test('a bare {name} with only extensions is not a card', () => {
    expect(() => parseCardObject({ name: 'x', extensions: {} })).toThrow(CardFormatError);
  });

  test('unknown spec and missing data are refused with a reason', () => {
    expect(() => parseCardObject({ spec: 'chara_card_v9', data: { name: 'x' } })).toThrow(/unsupported card spec/);
    expect(() => parseCardObject({ spec: 'chara_card_v2' })).toThrow(/no data/);
    expect(() => parseCardObject([1, 2])).toThrow(/not a JSON object/);
  });
});

describe('readCard from JSON bytes', () => {
  const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
  const card = { spec: 'chara_card_v2', data: { name: 'Jay', description: 'd' } };

  test('plain, with BOM, double-encoded and enveloped', () => {
    expect(readCard(enc(card), 'jay.json').value.name).toBe('Jay');
    expect(readCard(enc(`﻿${JSON.stringify(card)}`), 'jay.json').value.name).toBe('Jay');
    const dbl = readCard(enc(JSON.stringify(JSON.stringify(card))), 'jay.json');
    expect(dbl.value.name).toBe('Jay');
    expect(codes(dbl.warnings)).toContain('repaired_json');
    const env = readCard(enc({ exportedAt: '2026-01-01', type: 'character', data: card }), 'jay.json');
    expect(env.value.name).toBe('Jay');
  });

  test('an empty name falls back to the file name', () => {
    const r = readCard(enc({ spec: 'chara_card_v2', data: { name: '  ', description: 'd' } }), '/x/Лиса.card.json');
    expect(r.value.name).toBe('Лиса.card');
    expect(codes(r.warnings)).toContain('name_from_filename');
    expect(codes(r.warnings)).not.toContain('empty_name');
  });

  test('not JSON is a CardFormatError', () => {
    expect(() => readCard(enc('hello'), 'x.txt')).toThrow(CardFormatError);
  });
});
