// Ported from Bunraku:src/formats/sillytavern/lorebook.test.ts@702d8120 and
// RoleCall:apps/rc/src/lib/lorebook/parser.test.ts@fb8dc623e (the cases that still apply).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ST world info and character_book import (§10.5, §19.8 "Тесты Bunraku / RoleCall"), re-expressed
// on core.lorebook/1 (st-worldinfo.ts, import.ts detect). Their test books are used as they were;
// the expectations follow SillyTavern where the sources did not:
// - positions through ST's real enum: 2/3 are the author's note top/bottom (note_before /
//   note_after), not "before/after examples" as both sources map them;
// - no invented defaults: no "Entry 1" titles, no scanDepth 100 or token budget 0, ST's `order` is
//   `order` (no priority/sortOrder split); a book's own scan_depth / token_budget ride extras;
// - a regex key stays its '/pattern/flags' string (matched by lore/keys.ts), not a split object;
// - a scalar keysecondary is dropped, as ST resets it to [] (RoleCall split it on commas), with a
//   warning; a string position ('character', RoleCall's own name) is not an ST value and warns.
// Not taken: the exporters and round trips (rp-core has no emitter yet; D-70 keeps what it does
// not honour in extras for one), the RoleCall v1 bridge, parseLorebookFromString (import.ts reads
// the file), Bunraku's scan_depth defaulting (ST ignores the field).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from '../../src/formats/import.ts';
import { validateLoreBook, type LoreBook } from '../../src/formats/native.ts';
import { characterBookToLoreBook, worldInfoToLoreBook } from '../../src/formats/st-worldinfo.ts';
import { runLore } from '../../src/lore/engine.ts';

const FIX = join(import.meta.dir, '..', 'fixtures');
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

/** Bunraku's makeStWorldbook: ST int enums, an inline regex key, scan-source flags, raw-only fields. */
function makeStWorldbook() {
  return {
    entries: {
      '0': {
        uid: 0,
        comment: 'The Skyports',
        content: 'Floating docks ring every island.',
        disable: false,
        constant: false,
        key: ['skyport', '/dock(s)?/i'],
        keysecondary: ['harbor'],
        selective: true,
        selectiveLogic: 3,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: 5,
        position: 2,
        depth: 4,
        role: 0,
        displayIndex: 7,
        order: 50,
        sticky: 3,
        cooldown: 2,
        delay: 1,
        group: 'places',
        groupWeight: 5,
        probability: 100,
        useProbability: false,
        addMemo: false,
        excludeRecursion: true,
        preventRecursion: false,
        delayUntilRecursion: 0,
        characterFilter: { isExclude: false, names: ['Aria'], tags: [] },
        matchCharacterDescription: true,
        matchCharacterPersonality: false,
        matchPersonaDescription: false,
        matchScenario: true,
        ignoreBudget: false,
        vectorized: true,
        matchCharacterDepthPrompt: false,
        automationId: 'auto-9',
      },
      '1': {
        uid: 1,
        comment: 'Common Tongue',
        content: 'Everyone speaks it.',
        disable: false,
        constant: true,
        key: ['language'],
        keysecondary: [],
        selective: false,
        selectiveLogic: 0,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        position: 1,
        depth: 4,
        role: 0,
        displayIndex: 1,
        order: 100,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        group: '',
        groupWeight: 1,
        probability: 50,
        useProbability: true,
        addMemo: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        characterFilter: { isExclude: false, names: [], tags: [] },
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchPersonaDescription: false,
        matchScenario: false,
        ignoreBudget: false,
      },
    },
    name: 'Aetheria',
    description: 'the floating world',
    scan_depth: 4,
    token_budget: 2048,
    recursive_scanning: true,
    case_sensitive: false,
    match_whole_words: true,
  };
}

/** RoleCall's mockSTLorebook (two entries, every timing and matching field set). */
const mockSTLorebook = {
  entries: {
    '0': {
      uid: 0,
      key: ['mother', 'queen', "JJ's mother"],
      keysecondary: ['trauma', 'pain'],
      comment: 'JJ Trauma: Mother',
      content: 'JJ flinches at any mention of his mother.',
      constant: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: false,
      order: 100,
      position: 1,
      disable: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: 0,
      probability: 50,
      useProbability: true,
      depth: 4,
      group: 'JJ_Trauma',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: false,
      matchWholeWords: false,
      useGroupScoring: false,
      automationId: '',
      role: 0,
      sticky: 0,
      cooldown: 0,
      delay: 0,
    },
    '1': {
      uid: 1,
      key: ['magic', 'charm'],
      keysecondary: [],
      comment: 'JJ Trauma: Magic',
      content: 'JJ refuses to discuss his magical abilities.',
      constant: true,
      selective: false,
      selectiveLogic: 0,
      addMemo: false,
      order: 99,
      position: 0,
      disable: true,
      excludeRecursion: false,
      preventRecursion: true,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: false,
      depth: 4,
      group: 'JJ_Trauma',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: 10,
      caseSensitive: true,
      matchWholeWords: true,
      useGroupScoring: false,
      automationId: '',
      role: 1,
      sticky: 5,
      cooldown: 3,
      delay: 2,
    },
  },
  name: 'JJ Character Lore',
  description: 'Lorebook for JJ character',
  scan_depth: 100,
  token_budget: 2048,
  recursive_scanning: false,
};

const one = (entry: Record<string, unknown>) => worldInfoToLoreBook({ entries: { '0': entry } }, 'f');

describe('detection (Bunraku detect, RoleCall basic parsing)', () => {
  test('an ST world info file; a RoleCall v1 lorebook, a card and junk are not one', () => {
    expect(detect(enc(makeStWorldbook())).kind).toBe('st_worldinfo');
    expect(detect(enc(mockSTLorebook)).kind).toBe('st_worldinfo');
    expect(detect(enc({ schemaVersion: '1.0.0', lorebook: { entries: [] } })).kind).toBe('unknown');
    expect(detect(enc({ spec: 'chara_card_v2', data: { name: 'x' } })).kind).toBe('json_card');
    expect(detect(new TextEncoder().encode('not json')).kind).toBe('unknown');
  });

  test("entries as an array is a character_book (RoleCall's array format), read with the ST enum", () => {
    const arr = {
      entries: [
        { key: ['test1'], content: 'Content 1', constant: false, position: 2, role: 2 },
        { key: ['test2'], content: 'Content 2', constant: true, position: 3, role: 0 },
      ],
      name: 'Array Format Lorebook',
    };
    expect(detect(enc(arr)).kind).toBe('character_book');
    const r = characterBookToLoreBook(arr, 'f');
    expect(r.value.name).toBe('Array Format Lorebook');
    expect(r.value.entries.map((e) => [e.id, e.position, e.constant])).toEqual([
      ['0', 'note_before', false],
      ['1', 'note_after', true],
    ]);
  });

  test('a CCv3/Chub character_book (entries array with keys) imports; its title comes from name', () => {
    const chub = { name: 'Chub Sample', entries: [{ keys: ['skyport'], content: 'Floating docks.', name: 'Skyports', insertion_order: 10, enabled: true }], scan_depth: 4, token_budget: 1000 };
    expect(detect(enc(chub)).kind).toBe('character_book');
    const r = characterBookToLoreBook(chub, 'fallback');
    expect(r.value.name).toBe('Chub Sample');
    expect(r.value.entries).toEqual([{ id: '0', title: 'Skyports', content: 'Floating docks.', enabled: true, keys: ['skyport'], position: 'after', order: 10 }]);
    // Book-level scan_depth / token_budget: ST does not read them; they ride extras.
    expect(r.value.extras).toEqual({ scan_depth: 4, token_budget: 1000 });
  });
});

describe("ST enums, regex keys and scan sources (Bunraku toCanonical, RoleCall entry parsing)", () => {
  const book = worldInfoToLoreBook(makeStWorldbook(), 'fallback');

  test('the entries, field by field', () => {
    expect(book.value.name).toBe('Aetheria');
    const [e0, e1] = book.value.entries;
    expect(e0).toMatchObject({
      id: '0',
      title: 'The Skyports',
      keys: ['skyport', '/dock(s)?/i'],
      secondary: ['harbor'],
      logic: 'and_all', // ST 3
      position: 'note_before', // ST 2: AN top (both sources: "before examples")
      order: 50,
      groups: ['places'],
      groupWeight: 5,
      scanDepth: 5,
      excludeRecursion: true,
      sticky: 3,
      cooldown: 2,
      delay: 1,
    });
    // probability with useProbability false: ST does not roll it; it rides extras.
    expect(e0!.probability).toBeUndefined();
    expect(e1).toMatchObject({ id: '1', constant: true, position: 'after', probability: 50, order: 100 });
    expect(e1!.groups).toBeUndefined(); // an empty group string is no group
    expect(validateLoreBook(book.value).ok).toBe(true);
  });

  test('raw-only fields and the scan sources rp-core does not honour ride extras, with a warning each', () => {
    const [e0] = book.value.entries;
    expect(e0!.extras).toMatchObject({ vectorized: true, automationId: 'auto-9', displayIndex: 7, characterFilter: { names: ['Aria'] }, matchCharacterDescription: true, matchScenario: true });
    const paths = book.warnings.map((w) => w.path);
    for (const p of ['entries.0.characterFilter', 'entries.0.matchCharacterDescription', 'entries.0.matchScenario', 'entries.0.vectorized', 'entries.0.automationId']) expect(paths).toContain(p);
  });

  test('duplicate uid twins get distinct ids and keep their own unknown fields', () => {
    const src = makeStWorldbook();
    const first = { ...src.entries['0'], uid: 9, privateTwinMarker: 'first' };
    const second = { ...src.entries['1'], uid: 9, content: 'second twin', privateTwinMarker: 'second' };
    const r = worldInfoToLoreBook({ ...src, entries: { first, second } }, 'f');
    expect(r.value.entries.map((e) => [e.id, e.content, e.extras?.privateTwinMarker])).toEqual([
      ['9', first.content, 'first'],
      ['9-2', 'second twin', 'second'],
    ]);
  });

  test("RoleCall's JJ book: keys, secondary keys, logic, timers, matching, recursion, probability, titles", () => {
    const r = worldInfoToLoreBook(mockSTLorebook, 'f');
    const [mother, magic] = r.value.entries;
    expect(r.value.name).toBe('JJ Character Lore');
    expect(mother).toMatchObject({ title: 'JJ Trauma: Mother', keys: ['mother', 'queen', "JJ's mother"], secondary: ['trauma', 'pain'], logic: 'and_any', position: 'after', probability: 50, groups: ['JJ_Trauma'], groupWeight: 100, enabled: true, constant: false, preventRecursion: false });
    expect(magic).toMatchObject({ title: 'JJ Trauma: Magic', position: 'before', enabled: false, constant: true, sticky: 5, cooldown: 3, delay: 2, caseSensitive: true, wholeWords: true, scanDepth: 10, preventRecursion: true });
    // useProbability false: no probability (every roll passes), not a stamped 100.
    expect(magic!.probability).toBeUndefined();
    // Book settings ST ignores (scan_depth 100, recursive_scanning false) are not applied.
    expect(r.value.scanDepth).toBeUndefined();
    expect(r.value.recursive).toBeUndefined();
    expect(r.value.extras).toMatchObject({ description: 'Lorebook for JJ character', scan_depth: 100, token_budget: 2048, recursive_scanning: false });
  });

  test('every ST selectiveLogic code; roles ride extras unless the entry is at depth', () => {
    const logic = [0, 1, 2, 3].map((n) => one({ key: ['a'], keysecondary: ['b'], content: 'T', selective: true, selectiveLogic: n }).value.entries[0]!.logic);
    expect(logic).toEqual(['and_any', 'not_all', 'not_any', 'and_all']);
    expect(one({ key: ['t'], content: 'T', position: 4, depth: 2, role: 2 }).value.entries[0]!.position).toEqual({ depth: 2, role: 'assistant' });
  });

  test('a regex key keeps its slashes (matched as a regex at scan time); no title is invented', () => {
    const e = one({ key: ['/mother/', 'normal keyword'], content: 'Test' }).value.entries[0]!;
    expect(e.keys).toEqual(['/mother/', 'normal keyword']);
    expect(e.title).toBeUndefined(); // RoleCall: "Entry 1"
  });
});

describe('edge cases (RoleCall)', () => {
  test('empty keys, no content, a hundred keys, order kept, unique ids', () => {
    expect(one({ key: [], content: 'Test content' }).value.entries[0]!.keys).toEqual([]);
    expect(one({ key: ['test'] }).value.entries[0]!.content).toBe('');
    expect(one({ key: Array.from({ length: 100 }, (_, i) => `keyword${i}`), content: 'T' }).value.entries[0]!.keys).toHaveLength(100);
    const ordered = worldInfoToLoreBook({ entries: { '0': { key: ['a'], content: 'A', order: 50 }, '1': { key: ['b'], content: 'B', order: 10 }, '2': { key: ['c'], content: 'C', order: 100 } } }, 'f');
    expect(ordered.value.entries.map((e) => e.order)).toEqual([50, 10, 100]);
    const ids = worldInfoToLoreBook({ entries: { '0': { key: ['a'], content: 'A' }, '1': { key: ['b'], content: 'B' } } }, 'f').value.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the `keys` alias is read; a scalar keysecondary is dropped as ST drops it, and said (RoleCall split it)", () => {
    const r = one({ keys: ['visceral', 'codex'], keysecondary: 'bloodline, oath', comment: 'Visceral Codex', content: 'A compatibility export.' });
    expect(r.value.entries[0]!.keys).toEqual(['visceral', 'codex']);
    expect(r.value.entries[0]!.secondary).toBeUndefined();
    expect(r.warnings).toContainEqual({ code: 'invalid_value', path: 'entries.0.secondary_keys', message: 'secondary keys are not a list; ST drops them, so does rp-core' });
  });

  test("a string position that is not ST's ('character', RoleCall's own name) warns and falls back", () => {
    const r = one({ key: ['t'], content: 'T', position: 'character', role: 'assistant' });
    expect(r.value.entries[0]!.position).toBe('before');
    expect(r.warnings.map((w) => w.code)).toContain('invalid_value');
  });

  test("an object without entries is not a lorebook (RoleCall's refusal; here it reads as a V1 card, as ST would)", () => {
    expect(detect(enc({ name: 'Test', description: 'No entries' })).kind).toBe('json_card');
    expect(detect(enc({ name: 'Test' })).kind).toBe('unknown');
  });
});

describe("every sample world matches its own keywords (Bunraku's corpus guard)", () => {
  /** One user line through the lore engine, budget off, every roll passing (probability as written). */
  const fired = (book: LoreBook, text: string): string[] =>
    runLore({ sources: [{ key: 'b', book }], scan: [`User: ${text}`], chatLength: 1, fires: [], seed: 1, budget: Infinity, count: (t) => t.length, expand: (_k, c) => c }).fired.map((h) => h.id);

  for (const file of [join(FIX, 'worlds', 'Eldoria.json'), join(FIX, 'cli-m2', 'Harbor.json')]) {
    test(file.split('/').slice(-2).join('/'), () => {
      const book = worldInfoToLoreBook(JSON.parse(readFileSync(file, 'utf8')), 'f').value;
      const keyed = book.entries.filter((e) => e.keys.length > 0 && !e.constant && e.enabled !== false && (e.probability ?? 100) >= 100);
      expect(keyed.length).toBeGreaterThan(0);
      for (const e of keyed) expect(fired(book, `talking about ${e.keys[0]} right now`)).toContain(e.id);
    });
  }
});
