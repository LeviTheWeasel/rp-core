// ST world info and character_book → core.lorebook/1 (§10.2, §10.5, §19.8). The real ST position enum
// (world-info.js 880-889) is pinned here because RoleCall and Bunraku both mapped 2/3 to examples.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCardObject } from '../../src/formats/card.ts';
import { validateLoreBook, type LoreEntry } from '../../src/formats/native.ts';
import { runLore } from '../../src/lore/engine.ts';
import {
  characterBookToLoreBook,
  coerceStPosition,
  splitGroups,
  stPosition,
  worldInfoToLoreBook,
} from '../../src/formats/st-worldinfo.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cards');

describe('stPosition: the real ST enum, all 8 values', () => {
  test('0..7', () => {
    expect(stPosition(0)).toBe('before');
    expect(stPosition(1)).toBe('after');
    expect(stPosition(2)).toBe('note_before');
    expect(stPosition(3)).toBe('note_after'); // the RoleCall/Bunraku bug sent this to examples
    expect(stPosition(4, { depth: 2, role: 1 })).toEqual({ depth: 2, role: 'user' });
    expect(stPosition(5)).toBe('examples_before');
    expect(stPosition(6)).toBe('examples_after');
    expect(stPosition(7, { outletName: 'sidebar' })).toEqual({ outlet: 'sidebar' });
  });

  test('depth roles 0 system, 1 user, 2 assistant; no role stays absent; depth defaults to 4', () => {
    expect(stPosition(4, { depth: 0, role: 0 })).toEqual({ depth: 0, role: 'system' });
    expect(stPosition(4, { depth: 7, role: 2 })).toEqual({ depth: 7, role: 'assistant' });
    expect(stPosition(4, { depth: 3 })).toEqual({ depth: 3 });
    expect(stPosition(4)).toEqual({ depth: 4 });
    expect(stPosition(4, { depth: -2 })).toEqual({ depth: 0 });
  });

  test('outlet without a name and unknown numbers', () => {
    expect(stPosition(7)).toEqual({ outlet: '' });
    expect(stPosition(8)).toBe('after');
    expect(stPosition(-1)).toBe('after');
  });

  test('coerceStPosition accepts numeric strings and CC/ST aliases', () => {
    expect(coerceStPosition('3')).toBe(3);
    expect(coerceStPosition('before_char')).toBe(0);
    expect(coerceStPosition('after_char')).toBe(1);
    expect(coerceStPosition('an_bottom')).toBe(3);
    expect(coerceStPosition('at_depth')).toBe(4);
    expect(coerceStPosition(9)).toBeUndefined();
    expect(coerceStPosition('sideways')).toBeUndefined();
  });
});

describe('splitGroups', () => {
  test('comma-separated, trimmed, empties dropped', () => {
    expect(splitGroups('weather, mood ,')).toEqual(['weather', 'mood']);
    expect(splitGroups('')).toEqual([]);
    expect(splitGroups('solo')).toEqual(['solo']);
  });
});

describe('characterBookToLoreBook on a card with positions 0..7 (v2-book-positions.json)', () => {
  const card = JSON.parse(readFileSync(join(FIXTURES, 'v2-book-positions.json'), 'utf8')) as { data: { character_book: unknown } };
  const { value: book, warnings } = characterBookToLoreBook(card.data.character_book, "Archivist's book");
  const byTitle = (t: string): LoreEntry => {
    const e = book.entries.find((x) => x.title === t);
    if (!e) throw new Error(`no entry ${t}`);
    return e;
  };

  test('book-level fields: fallback name, no invented defaults; scan depth and recursion ride extras (ST ignores them)', () => {
    expect(book.name).toBe("Archivist's book");
    expect(book.scanDepth).toBeUndefined();
    expect(book.recursive).toBeUndefined();
    expect(book.match).toBe('literal');
    expect(book.extras).toEqual({ scan_depth: 3, recursive_scanning: false, token_budget: 512, extensions: {} });
    expect(book.caseSensitive).toBeUndefined();
    const w = warnings.filter((x) => x.code === 'not_honoured' && x.path === 'scan_depth');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('scan_depth 3 and recursive_scanning false are ignored by SillyTavern');
    expect(warnings.some((x) => x.code === 'unknown_field' && /scan_depth|recursive_scanning/.test(x.path))).toBe(false);
  });

  test('every position maps through the ST enum', () => {
    expect(book.entries.map((e) => e.position)).toEqual([
      'before',
      'after',
      'note_before',
      'note_after',
      { depth: 2, role: 'user' },
      'examples_before',
      'examples_after',
      { outlet: 'sidebar' },
    ]);
  });

  test('pos 0: ids from the source, insertion_order → order, template defaults stay quiet', () => {
    const e = byTitle('pos 0');
    expect(e.id).toBe('10');
    expect(e.order).toBe(100);
    expect(e.probability).toBe(100);
    expect(e.groups).toBeUndefined();
    expect(e.secondary).toBeUndefined();
    expect(e.extras?.extensions).toMatchObject({ display_index: 0, vectorized: false });
  });

  test('pos 1: selective + secondary + selectiveLogic 3 → and_all; groups split', () => {
    const e = byTitle('pos 1');
    expect(e.secondary).toEqual(['also']);
    expect(e.logic).toBe('and_all');
    expect(e.groups).toEqual(['weather', 'mood']);
    expect(e.groupWeight).toBe(40);
  });

  test('pos 2: disabled entry and live probability', () => {
    const e = byTitle('pos 2');
    expect(e.enabled).toBe(false);
    expect(e.probability).toBe(25);
  });

  test('pos 3: secondary without selective and probability without useProbability ride extras (ST ignores them too)', () => {
    const e = byTitle('pos 3');
    expect(e.secondary).toBeUndefined();
    expect(e.probability).toBeUndefined();
    expect(e.extras).toMatchObject({
      secondary_keys: ['ignored without selective'],
      extensions: { probability: 10, useProbability: false },
    });
    expect(warnings.some((w) => w.path.includes('entries[3]'))).toBe(false);
  });

  test('pos 4: depth/role consumed, matching and recursion flags, timers with string coercion', () => {
    const e = byTitle('pos 4');
    expect(e).toMatchObject({
      caseSensitive: true,
      wholeWords: false,
      scanDepth: 5,
      preventRecursion: true,
      excludeRecursion: true,
      sticky: 3,
      cooldown: 2,
      delay: 1,
    });
    expect(e.extras).toBeUndefined();
  });

  test('pos 5: vectorized and an unknown flag go to extras with warnings', () => {
    const e = byTitle('pos 5');
    expect(e.extras?.extensions).toEqual({ vectorized: true, my_plugin_flag: 'x' });
    expect(warnings).toContainEqual({
      code: 'not_honoured',
      path: 'entries[5].extensions.vectorized',
      message: expect.stringContaining('vector'),
    });
    expect(warnings).toContainEqual({
      code: 'unknown_field',
      path: 'entries[5].extensions.my_plugin_flag',
      message: expect.any(String),
    });
  });

  test('pos 6 and 7: ignore_budget, constant', () => {
    expect(byTitle('pos 6').ignoreBudget).toBe(true);
    expect(byTitle('pos 7').constant).toBe(true);
  });

  test('use_regex on plain keys warns once', () => {
    expect(warnings.filter((w) => w.path.endsWith('use_regex'))).toHaveLength(1);
  });

  test('the book validates', () => {
    expect(validateLoreBook(book).ok).toBe(true);
  });

  test('inside the card the same book is named by its fallback and warns under data.character_book', () => {
    const { value, warnings: cw } = parseCardObject(card);
    expect(value.book?.name).toBe("Archivist's Lorebook");
    expect(cw.some((w) => w.path === 'data.character_book.entries[5].extensions.vectorized')).toBe(true);
  });
});

describe('characterBookToLoreBook edge cases', () => {
  test('duplicate and missing ids become unique, deterministic ids', () => {
    const { value } = characterBookToLoreBook(
      { entries: [{ id: 1, keys: ['a'], content: '' }, { id: 1, keys: ['b'], content: '' }, { keys: ['c'], content: '' }] },
      'B',
    );
    expect(value.entries.map((e) => e.id)).toEqual(['1', '1-2', '2']);
  });

  test('blank keys are dropped; comment wins over name, a different name stays in extras', () => {
    const { value } = characterBookToLoreBook(
      { entries: [{ keys: ['a', ' ', 7], content: 'x', comment: 'Title', name: 'Other' }] },
      'B',
    );
    expect(value.entries[0]?.keys).toEqual(['a']);
    expect(value.entries[0]?.title).toBe('Title');
    expect(value.entries[0]?.extras).toEqual({ name: 'Other' });
  });

  test('a garbage position warns and falls back to after', () => {
    const { value, warnings } = characterBookToLoreBook({ entries: [{ keys: ['a'], content: 'x', position: 'sideways' }] }, 'B');
    expect(value.entries[0]?.position).toBe('after');
    expect(warnings.map((w) => w.code)).toContain('invalid_value');
  });

  test('a lorebook_v3 envelope is unwrapped', () => {
    const { value } = characterBookToLoreBook({ spec: 'lorebook_v3', data: { name: 'V3', entries: [{ keys: ['k'], content: 'c' }] } }, 'B');
    expect(value.name).toBe('V3');
    expect(value.entries).toHaveLength(1);
  });

  test('not a book: empty book with a warning', () => {
    const r = characterBookToLoreBook('nope', 'Fallback');
    expect(r.value).toEqual({ name: 'Fallback', match: 'literal', entries: [] });
    expect(r.warnings).toHaveLength(1);
  });

  test('many entries with one inactive feature fold into one warning', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ keys: [`k${i}`], content: '', extensions: { group_override: true } }));
    const { warnings } = characterBookToLoreBook({ entries }, 'B');
    expect(warnings).toEqual([
      { code: 'not_honoured', path: 'entries[*].extensions.group_override', message: 'group override is not honoured; kept in extras (5 entries)' },
    ]);
  });
});

describe('worldInfoToLoreBook (ST field names)', () => {
  const wi = {
    entries: {
      '0': {
        uid: 0,
        key: ['dragon', '/wyrm(s)?/i'],
        keysecondary: ['fire'],
        comment: 'Dragons',
        content: 'Dragons nest in the north.',
        constant: false,
        selective: true,
        selectiveLogic: 2,
        order: 150,
        position: 3, // the Eorzea regression: AN bottom, not "after examples"
        disable: false,
        excludeRecursion: true,
        preventRecursion: false,
        probability: 60,
        useProbability: true,
        depth: 4,
        role: 0,
        group: 'beasts,lore',
        groupWeight: 70,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: true,
        sticky: 2,
        cooldown: null,
        delay: 0,
        outletName: '',
        displayIndex: 0,
        addMemo: true,
        vectorized: false,
        automationId: '',
        extensions: { from_card: true },
      },
      '5': {
        uid: 5,
        key: ['tavern'],
        keysecondary: ['ale'],
        comment: 'Tavern',
        content: 'The Rusty Mug.',
        position: 4,
        depth: 1,
        role: 2,
        disable: true,
        automationId: 'qr-7',
      },
      '6': { uid: 6, key: [], comment: 'Outlet', content: 'o', position: 7, outletName: 'map', constant: true },
    },
    originalData: { entries: [] },
  };
  const { value: book, warnings } = worldInfoToLoreBook(wi, 'Bestiary');

  test('book: fallback name, literal match, originalData kept silently', () => {
    expect(book.name).toBe('Bestiary');
    expect(book.match).toBe('literal');
    expect(book.extras).toEqual({ originalData: { entries: [] } });
  });

  test('a full ST entry', () => {
    expect(book.entries[0]).toEqual({
      id: '0',
      title: 'Dragons',
      content: 'Dragons nest in the north.',
      enabled: true,
      constant: false,
      keys: ['dragon', '/wyrm(s)?/i'],
      secondary: ['fire'],
      logic: 'not_any',
      position: 'note_after',
      order: 150,
      probability: 60,
      groups: ['beasts', 'lore'],
      groupWeight: 70,
      wholeWords: true,
      preventRecursion: false,
      excludeRecursion: true,
      sticky: 2,
      delay: 0,
      extras: { depth: 4, role: 0, outletName: '', displayIndex: 0, addMemo: true, vectorized: false, automationId: '', extensions: { from_card: true } },
    });
  });

  test('missing selective defaults to true in WI files (ST template), disable → enabled false, depth role', () => {
    const e = book.entries[1];
    expect(e?.secondary).toEqual(['ale']);
    expect(e?.enabled).toBe(false);
    expect(e?.position).toEqual({ depth: 1, role: 'assistant' });
    expect(warnings).toContainEqual({ code: 'not_honoured', path: 'entries.5.automationId', message: expect.any(String) });
  });

  test('outlet entry', () => {
    expect(book.entries[2]?.position).toEqual({ outlet: 'map' });
    expect(book.entries[2]?.keys).toEqual([]);
  });

  test('missing position in a WI file defaults to before (ST template 0)', () => {
    const r = worldInfoToLoreBook({ entries: { '1': { uid: 1, key: ['a'], content: 'x' } } }, 'B');
    expect(r.value.entries[0]?.position).toBe('before');
  });

  test('the book validates', () => {
    expect(validateLoreBook(book)).toEqual({ ok: true, value: book });
  });

  test('not a WI file: empty book with a warning', () => {
    const r = worldInfoToLoreBook({ entries: [] }, 'B');
    expect(r.value.entries).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('a card book with scan_depth 100 and recursive_scanning false (the Wymare cards) scans as SillyTavern does', () => {
  // Regression: the book-level fields were applied, so every entry scanned 100 messages back with
  // recursion off. ST's convertCharacterBook copies the entries only; its globals (depth 2,
  // recursion on) apply.
  const { value: book, warnings } = characterBookToLoreBook(
    {
      name: 'Varkos',
      scan_depth: 100,
      recursive_scanning: false,
      token_budget: 2048,
      entries: [
        { id: 1, keys: ['hunt'], content: 'The Iron Hunt rides at dawn.', enabled: true, insertion_order: 100, extensions: { position: 0 } },
        { id: 2, keys: ['Iron Hunt'], content: 'Its banner is a black stag.', enabled: true, insertion_order: 90, extensions: { position: 0 } },
      ],
    },
    "Varkos's Lorebook",
  );
  const lore = (scan: string[]) =>
    runLore({ sources: [{ key: '@card', book }], scan, chatLength: scan.length, fires: [], seed: 1, budget: Infinity, count: (t) => t.length, expand: (_k, c) => c });

  test('the book keeps them in extras and says it does not apply them', () => {
    expect(book.scanDepth).toBeUndefined();
    expect(book.recursive).toBeUndefined();
    expect(book.extras).toMatchObject({ scan_depth: 100, recursive_scanning: false, token_budget: 2048 });
    expect(warnings.filter((w) => w.code === 'not_honoured').map((w) => w.message)).toEqual([
      "the book's scan_depth 100 and recursive_scanning false are ignored by SillyTavern, which scans every world at its global depth 2 with recursion on; rp-core does the same (kept in extras)",
    ]);
  });

  test('a key said 10 messages back fires nothing (depth 2)', () => {
    const scan = Array.from({ length: 10 }, (_, i) => (i === 9 ? 'Levi: the hunt begins' : `Levi: line ${i}`));
    expect(lore(scan).fired).toEqual([]);
  });

  test('recursion between its entries works', () => {
    expect(lore(['Levi: the hunt']).fired.map((h) => [h.id, h.why])).toEqual([
      ['1', 'key'],
      ['2', 'recursion'],
    ]);
  });
});

describe("decorators: SillyTavern's parseDecorators (world-info.js)", () => {
  const wi = worldInfoToLoreBook(
    {
      entries: {
        0: { uid: 0, key: ['lamp'], content: '@@depth 2\n@@role user\nLAMP LORE', position: 0, selective: true },
        1: { uid: 1, key: ['lamp'], content: '@@dont_activate\nNEVER BY KEY', position: 0, selective: true },
        2: { uid: 2, key: ['zzz'], content: '@@activate\nALWAYS ON', position: 0, selective: true, constant: false },
        3: { uid: 3, key: ['lamp'], content: 'not @@ at the start\n@@activate', position: 0, selective: true },
        4: { uid: 4, key: ['lamp'], content: '@@unknown\n@@@activate\nFALLBACK', position: 0, selective: true },
      },
    },
    'w',
  );
  const e = (id: string): LoreEntry => wi.value.entries.find((x) => x.id === id)!;

  test('leading @@ lines are stripped from the content and kept in extras.decorators', () => {
    expect(e('0').content).toBe('LAMP LORE');
    expect(e('0').extras?.decorators).toEqual(['@@depth 2', '@@role user']);
    expect(e('3').content).toBe('not @@ at the start\n@@activate');
    expect(e('3').extras?.decorators).toBeUndefined();
  });

  test('@@activate fires without a key (constant); @@dont_activate never fires (disabled)', () => {
    expect(e('2')).toMatchObject({ content: 'ALWAYS ON', constant: true, extras: { decorators: ['@@activate'], constant: false } });
    expect(e('1')).toMatchObject({ content: 'NEVER BY KEY', enabled: false });
    // '@@@activate' is the fallback for the unknown decorator just before it
    expect(e('4')).toMatchObject({ content: 'FALLBACK', constant: true });
  });

  test('only decorators SillyTavern drops too are warned about', () => {
    const w = wi.warnings.filter((x) => x.code === 'not_honoured');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('decorators other than @@activate / @@dont_activate');
    expect(w[0]!.message).toContain('(2 entries)');
  });

  test('assembled: no @@ line reaches the model, @@dont_activate stays out, @@activate goes in', () => {
    const res = runLore({ sources: [{ key: 'w', book: wi.value }], scan: ['Levi: the lamp'], chatLength: 1, fires: [], seed: 1, budget: Infinity, count: (t) => t.length, expand: (_k, c) => c });
    const sent = res.fired.map((h) => h.text).join('\n');
    expect(sent).not.toContain('@@depth');
    expect(sent).not.toContain('NEVER BY KEY');
    expect(sent).toContain('ALWAYS ON');
    expect(sent).toContain('LAMP LORE');
  });
});

describe('selective: false is kept when it switches secondary keys off (round trip)', () => {
  test('a WI entry with secondary keys and selective false keeps selective in extras', () => {
    const { value } = worldInfoToLoreBook({ entries: { 0: { uid: 0, key: ['a'], keysecondary: ['b'], selective: false, selectiveLogic: 2, content: 'x' } } }, 'w');
    expect(value.entries[0]!.secondary).toBeUndefined();
    expect(value.entries[0]!.extras).toEqual({ keysecondary: ['b'], selective: false, selectiveLogic: 2 });
  });

  test('honoured secondary keys or no secondary keys: nothing extra', () => {
    const { value } = worldInfoToLoreBook(
      { entries: { 0: { uid: 0, key: ['a'], keysecondary: ['b'], selective: true, content: 'x' }, 1: { uid: 1, key: ['a'], keysecondary: [], selective: false, content: 'y' } } },
      'w',
    );
    expect(value.entries[0]!.extras).toBeUndefined();
    expect(value.entries[1]!.extras).toBeUndefined();
  });
});
