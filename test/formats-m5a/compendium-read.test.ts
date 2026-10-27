// Ported from Bunraku:src/formats/rolecall/compendium.test.ts@702d8120 (the cases "a malformed row value
// falls back to the default…" and "the older lorebook codec does not claim a compendium file…").
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading RoleCall's `compendium-v1.0.0` (D-162): detection vectors CV1–CV5 and CV7 of the M5a
// research (rolecall.md §5.5), the row mapping, and the Russian `lantern` fixture (fixtures.md §2).
// The Bunraku cases are re-aimed at core defaults and at rp-core's `detect` (a compendium, never a
// character_book); the rest is fresh, the hostile files of the M5a review included.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderContent } from '../../src/agents/compendium/render.ts';
import { ENTRY_TYPES } from '../../src/agents/compendium/types.ts';
import { COMPENDIUM_FORMAT, COMPENDIUM_SCHEMA, looksLikeCompendium, readCompendium } from '../../src/formats/compendium-v1.ts';
import { detect } from '../../src/formats/import.ts';
import { looksLikeCharacterBook, looksLikeWorldInfo } from '../../src/formats/kind-markers.ts';
import { validateLoreBook, type LoreEntry } from '../../src/formats/native.ts';

const LANTERN = join(import.meta.dir, '..', 'fixtures', 'ru', 'lantern', 'lantern.compendium.json');
const lanternText = readFileSync(LANTERN, 'utf8');
const lantern = (): Record<string, unknown> => JSON.parse(lanternText) as Record<string, unknown>;
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

const file = (entries: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: COMPENDIUM_SCHEMA,
  format: COMPENDIUM_FORMAT,
  exportDate: '2026-10-20T09:00:00.000Z',
  lorebook: { id: 'lb1', name: 'Aetheria', creator_id: 'u1' },
  entries,
  ...extra,
});
const read = (entries: unknown[], extra?: Record<string, unknown>) => readCompendium(file(entries, extra), { fallbackName: 'stem' });
const only = (entries: unknown[]): LoreEntry => read(entries).value.entries[0] as LoreEntry;
const codes = (ws: { code: string }[]): string[] => ws.map((w) => w.code);

describe('detection (CV1)', () => {
  test('the Bunraku predicate: a compendium tag, a lorebook object and an entries list', () => {
    expect(looksLikeCompendium({ format: 'rolecall-compendium', lorebook: {}, entries: [] })).toBe(true);
    expect(looksLikeCompendium({ schemaVersion: 'compendium-v2', lorebook: {}, entries: [] })).toBe(true);
    expect(looksLikeCompendium({ schemaVersion: '1.0.0', lorebook: { name: 'A', entries: [] } })).toBe(false); // RoleCall v1 lorebook
    expect(looksLikeCompendium({ format: 'rolecall-compendium', lorebook: {} })).toBe(false);
    expect(looksLikeCompendium({ format: 'rolecall-compendium', lorebook: null, entries: [] })).toBe(false); // RoleCall says yes
    expect(looksLikeCompendium({})).toBe(false);
    expect(looksLikeCompendium('{}')).toBe(false);
    expect(looksLikeCompendium([{ lorebook: {}, entries: [] }])).toBe(false);
  });

  test('import detection says compendium, after the preset and before the ST books', () => {
    expect(detect(enc(lanternText)).kind).toBe('compendium');
    expect(detect(enc({ format: 'rolecall-compendium', lorebook: {}, entries: [] })).kind).toBe('compendium');
    expect(detect(enc({ schemaVersion: 'compendium-v2', lorebook: {}, entries: [] })).kind).toBe('compendium');
    // the envelope several web tools write, and a double-encoded file: read through readingsOf
    expect(detect(enc({ exportedAt: '2026-10-20', type: 'lorebook', version: '1', data: lantern() })).kind).toBe('compendium');
    expect(detect(enc(JSON.stringify(lanternText))).kind).toBe('compendium');
  });

  test('a compendium is never a character_book or world info any more, even a malformed one', () => {
    expect(looksLikeCharacterBook(lantern())).toBe(false);
    expect(looksLikeCharacterBook({ format: 'rolecall-compendium', lorebook: null, entries: [{ content: 'x' }] })).toBe(false);
    expect(looksLikeWorldInfo({ schemaVersion: 'compendium-v1.0.0', entries: { 0: { content: 'x' } } })).toBe(false);
    const nearMiss = detect(enc({ format: 'rolecall-compendium', lorebook: null, entries: [{ content: 'x' }] }));
    expect(nearMiss.kind).toBe('unknown');
    expect(nearMiss.reason).toContain('RoleCall Compendium export');
    expect(detect(enc({ format: 'rolecall-compendium', lorebook: {} })).kind).toBe('unknown');
    // untagged books keep their old detection
    expect(detect(enc({ name: 'B', entries: [{ keys: ['k'], content: 'c' }] })).kind).toBe('character_book');
    expect(detect(enc({ schemaVersion: '1.0.0', lorebook: { name: 'A', entries: [] } })).kind).toBe('unknown');
  });

  test('another schema version is read, with a warning', () => {
    const r = readCompendium({ schemaVersion: 'compendium-v2', lorebook: { name: 'N' }, entries: [] }, { fallbackName: 's' });
    expect(r.value).toEqual({ name: 'N', match: 'literal', entries: [] });
    expect(r.warnings).toEqual([{ code: 'unknown_version', path: 'schemaVersion', message: 'schema version "compendium-v2" is not compendium-v1.0.0; read as compendium-v1.0.0' }]);
    expect(codes(readCompendium({ format: 'rolecall-compendium', lorebook: {}, entries: [] }, { fallbackName: 's' }).warnings)).toEqual(['unknown_version']);
  });

  test('not a compendium: an empty book and a warning, never a throw', () => {
    const r = readCompendium({ lorebook: null }, { fallbackName: 'stem', name: 'As' });
    expect(r.value).toEqual({ name: 'As', match: 'literal', entries: [] });
    expect(codes(r.warnings)).toEqual(['invalid_value']);
  });
});

describe('rows (CV2–CV5, CV7)', () => {
  test('CV2: a typed row → meta {type, data, featured}; RoleCall\'s text stays in content (plain lore when the book is off)', () => {
    const e = only([
      {
        id: 'a',
        title: 'Skyports',
        content: 'Docks.',
        triggers: [{ keyword: 'skyport', isRegex: false }],
        position: 'world',
        metadata: { entry_type: 'location', structured_data: { name: 'Skyports' }, original_classic_content: 'Docks.' },
        is_featured: true,
      },
    ]);
    expect(e).toEqual({
      id: 'a',
      title: 'Skyports',
      content: 'Docks.',
      keys: ['skyport'],
      position: 'before',
      meta: { type: 'location', data: { name: 'Skyports' }, featured: true },
      extras: { metadata: { original_classic_content: 'Docks.' } },
    });
  });

  test('a typed row with blank text gets the render of its data as content (headed by the title when the data names nothing)', () => {
    const data = { name: 'Skyports', description: 'Docks in the clouds.', dangers: ['wind'] };
    const blank = only([{ id: 'b', title: 'Skyports', content: '  ', metadata: { entry_type: 'location', structured_data: data } }]);
    expect(blank.content).toBe(renderContent('location', data));
    expect(blank.extras).toBeUndefined();
    const none = only([{ id: 'n', title: 'Old Pier', metadata: { entry_type: 'location', structured_data: { description: 'Rotten boards.' } } }]);
    expect(none.content).toBe('# Old Pier\n\nRotten boards.');
    expect(none.meta?.data).toEqual({ description: 'Rotten boards.' }); // the data itself is not changed
  });

  test('typed rows: aliases from structured_data, featured from metadata too, the type word folded', () => {
    const e = only([{ id: 'c', title: 'Мира', metadata: { entry_type: ' Character ', featured: true, structured_data: { name: 'Мира', aliases: ['Фонарщица', '', 4] } } }]);
    expect(e.meta).toEqual({ type: 'character', data: { name: 'Мира', aliases: ['Фонарщица', '', 4] }, aliases: ['Фонарщица'], featured: true });
    expect(e.extras).toBeUndefined();
    const noData = read([{ id: 'n', title: 'X', metadata: { entry_type: 'item', structured_data: 'oops' } }]);
    expect(noData.value.entries[0]?.meta).toEqual({ type: 'item', data: {} });
    expect(codes(noData.warnings)).toEqual(['invalid_value']);
  });

  test('an unknown entry_type is a plain lore entry with its metadata kept, and said', () => {
    const r = read([{ id: 'u', title: 'Spell', content: 'Fire.', metadata: { entry_type: 'spell', structured_data: { name: 'Spell' } } }]);
    expect(r.value.entries[0]).toEqual({ id: 'u', title: 'Spell', content: 'Fire.', keys: [], position: 'after', extras: { metadata: { entry_type: 'spell', structured_data: { name: 'Spell' } } } });
    expect(r.warnings).toEqual([{ code: 'unknown_type', path: 'entries[0].metadata.entry_type', message: 'entry_type is not one of the 11 Compendium types; imported as a plain lore entry' }]);
  });

  test('CV3: an arc overview → meta.arc, by its source tag or the legacy [Arc] title', () => {
    const tagged = only([{ id: 'r', title: '[Arc] The Lantern', content: 'Overview.', constant: true, metadata: { source: 'tv_arc_overview', chatId: 'x', arcId: 'n1' } }]);
    expect(tagged).toMatchObject({ title: '[Arc] The Lantern', content: 'Overview.', constant: true, meta: { arc: 'The Lantern' }, extras: { metadata: { source: 'tv_arc_overview', chatId: 'x', arcId: 'n1' } } });
    expect(only([{ id: 'l', title: '[Arc]  Old Road', content: 'O.' }]).meta).toEqual({ arc: 'Old Road' });
    // metadata.arc names the plot when it is there (Bunraku and rp-core's own writer)
    expect(only([{ id: 'm', title: '[Arc] x', metadata: { source: 'tv_arc_overview', arc: 'Plot' } }]).meta).toEqual({ arc: 'Plot' });
    const blank = read([{ id: 'b', title: '[Arc] ', metadata: { source: 'tv_arc_overview' } }]);
    expect(blank.value.entries[0]?.meta).toBeUndefined();
    expect(codes(blank.warnings)).toEqual(['invalid_value']);
  });

  test('CV4: triggers as keys — strings and {keyword}; regexes as /re/flags; anything else dropped, said', () => {
    const r = read([{ id: 't', title: 'T', content: 'c', triggers: ['Mira', { keyword: 'Lamplighter', isRegex: false }, { keyword: '^Mi', isRegex: true, flags: 'i' }, 7] }]);
    expect(r.value.entries[0]?.keys).toEqual(['Mira', 'Lamplighter', '/^Mi/i']);
    expect(r.warnings).toEqual([{ code: 'invalid_value', path: 'entries[0].triggers', message: 'a trigger is neither text nor a {keyword} record; dropped' }]);
  });

  test("regex triggers: RoleCall's unflagged regex is case-insensitive unless the entry or book is case-sensitive; slashes escaped", () => {
    const key = (row: Record<string, unknown>, book?: Record<string, unknown>): string | undefined => {
      const f = file([{ id: 'r', title: 'R', ...row }]);
      if (book) f.lorebook = { ...(f.lorebook as object), ...book };
      return readCompendium(f, { fallbackName: 's' }).value.entries[0]?.keys[0];
    };
    expect(key({ triggers: [{ keyword: 'Mi+ra', isRegex: true }] })).toBe('/Mi+ra/i');
    expect(key({ triggers: [{ keyword: 'Mi+ra', isRegex: true }], case_sensitive: true })).toBe('/Mi+ra/');
    expect(key({ triggers: [{ keyword: 'Mi+ra', isRegex: true }] }, { global_case_sensitive: true })).toBe('/Mi+ra/');
    expect(key({ triggers: [{ keyword: 'a/b\\/c', isRegex: true, flags: 'mm' }] })).toBe('/a\\/b\\/c/m');
    expect(key({ triggers: [{ keyword: '   ', isRegex: false }, '  '] })).toBeUndefined();
  });

  test('CV5: two featured rows of one type both read as featured', () => {
    const r = read([
      { id: 'a', title: 'A', is_featured: true, metadata: { entry_type: 'character', structured_data: { name: 'A' } } },
      { id: 'b', title: 'B', is_featured: true, metadata: { entry_type: 'character', structured_data: { name: 'B' } } },
      { id: 'c', title: 'C', content: 'c', is_featured: true },
    ]);
    expect(r.value.entries.map((e) => e.meta?.featured)).toEqual([true, true, undefined]);
    expect(r.value.entries[2]?.extras).toEqual({ is_featured: true });
  });

  test('CV7: ids are kept as written and structured_data is never rewritten', () => {
    const r = read([
      { id: 'Mira', title: 'Mira', metadata: { entry_type: 'character', structured_data: { name: 'Mira' } } },
      { id: 'k', title: 'Kett', metadata: { entry_type: 'character', structured_data: { name: 'Kett', relationships: [{ with: 'Mira', nature: 'mentor' }] } } },
    ]);
    expect(r.value.entries.map((e) => e.id)).toEqual(['Mira', 'k']);
    expect(r.value.entries[1]?.meta?.data).toEqual({ name: 'Kett', relationships: [{ with: 'Mira', nature: 'mentor' }] });
  });

  test('positions: the structural slots, depth via fromRcDepth, append disabled, scene before the examples', () => {
    const at = (row: Record<string, unknown>) => only([{ id: 'p', title: 'P', content: 'c', ...row }]);
    expect(at({ position: 'world' }).position).toBe('before');
    expect(at({ position: 'character' }).position).toBe('after');
    expect(at({ position: 'before_example' }).position).toBe('examples_before');
    expect(at({ position: 'after_example' }).position).toBe('examples_after');
    expect(at({ position: 'prepend_top' }).position).toBe('top');
    expect(at({ position: 'append_bottom' }).position).toBe('bottom');
    expect(at({}).position).toBe('after');
    expect(at({ position: 'depth', depth: 0, role: 'user' }).position).toEqual({ depth: 1, role: 'user' });
    expect(at({ position: 'depth' }).position).toEqual({ depth: 5, role: 'system' });
    // depth and role mean nothing off depth: RoleCall's template values are dropped quietly
    expect(at({ position: 'world', depth: 4, role: 'system' }).extras).toBeUndefined();

    const append = read([{ id: 'a', title: 'A', content: 'c', enabled: true, position: 'append', depth: 2, role: 'assistant' }]);
    expect(append.value.entries[0]).toMatchObject({ enabled: false, position: 'after', extras: { position: 'append', depth: 2, role: 'assistant' } });
    expect(codes(append.warnings)).toEqual(['rc_append']);
    const scene = read([{ id: 's', title: 'S', content: 'c', position: 'scene' }]);
    expect(scene.value.entries[0]).toMatchObject({ position: 'examples_before', extras: { position: 'scene' } });
    expect(codes(scene.warnings)).toEqual(['rc_scene']);
  });

  test('a malformed cell falls back to the default instead of poisoning the entry (Bunraku)', () => {
    const r = read([{ id: 'b', title: 'Plain', content: 'Plain.', enabled: 'yes', position: 'sideways', role: 7, probability: 'high', triggers: [{ keyword: 4 }, { keyword: 'ok', isRegex: false }] }]);
    expect(r.value.entries[0]).toEqual({ id: 'b', title: 'Plain', content: 'Plain.', keys: ['ok'], position: 'after' });
    expect(r.warnings.map((w) => w.path).sort()).toEqual(['entries[0].enabled', 'entries[0].position', 'entries[0].probability', 'entries[0].triggers']);
  });

  test('columns that map to core fields', () => {
    const e = only([
      {
        id: 'x',
        title: 'X',
        content: 'c',
        enabled: false,
        constant: true,
        triggers: ['a'],
        secondary_triggers: [{ keyword: 'b', isRegex: false }],
        selective_logic: 'not_all',
        priority: 42,
        probability: 150,
        group_name: ' guards ',
        group_weight: 3,
        scan_depth: 6,
        case_sensitive: true,
        match_whole_words: false,
        prevent_recursion: true,
        exclude_recursion: false,
        ignore_budget: true,
        sticky: 2,
        cooldown: 1,
        delay: 3,
      },
    ]);
    expect(e).toEqual({
      id: 'x',
      title: 'X',
      content: 'c',
      enabled: false,
      constant: true,
      keys: ['a'],
      secondary: ['b'],
      logic: 'not_all',
      position: 'after',
      order: 42,
      probability: 100,
      groups: ['guards'],
      groupWeight: 3,
      scanDepth: 6,
      caseSensitive: true,
      wholeWords: false,
      preventRecursion: true,
      excludeRecursion: false,
      ignoreBudget: true,
      sticky: 2,
      cooldown: 1,
      delay: 3,
    });
    // selective_logic without secondary triggers is template noise
    expect(only([{ id: 'y', title: 'Y', content: 'c', selective_logic: 'and_all' }]).logic).toBeUndefined();
  });

  test('RoleCall-only columns ride extras when set, said when RoleCall would act; bookkeeping is dropped', () => {
    const r = read([
      {
        id: 'x',
        lorebook_id: 'lb1',
        title: 'X',
        content: 'c',
        comment: 'memo',
        trigger_mode: 'advanced',
        use_memo: false,
        scan_user_persona: true,
        scan_scenario: false,
        boost_ids: [],
        side_effects: null,
        token_count: 12,
        sort_order: 3,
        origin: 'imported',
        origin_source_id: 'zz',
        created_at: '2026-01-01',
        updated_at: '2026-01-02',
        category_id: null,
        future_column: 'v',
      },
    ]);
    expect(r.value.entries[0]?.extras).toEqual({ comment: 'memo', trigger_mode: 'advanced', scan_user_persona: true, future_column: 'v' });
    expect(r.warnings).toEqual([
      { code: 'not_honoured', path: 'entries[0].trigger_mode', message: 'advanced trigger mode (per-trigger frequency and probability) is not honoured; kept in extras' },
      { code: 'not_honoured', path: 'entries[0].scan_user_persona', message: 'scanning the persona description is not honoured; kept in extras' },
      { code: 'unknown_field', path: 'entries[0].future_column', message: 'unknown column "future_column" kept in extras' },
    ]);
  });

  test("category_id → extras.category = the category's name; an unknown id is dropped and said", () => {
    const r = read(
      [
        { id: 'a', title: 'A', content: 'c', category_id: 'c1' },
        { id: 'b', title: 'B', content: 'c', category_id: 'c9' },
      ],
      { categories: [{ id: 'c1', name: 'Skies', sort_order: 1 }, { id: 'c2' }, 'junk'] },
    );
    expect(r.value.entries.map((e) => e.extras)).toEqual([{ category: 'Skies' }, undefined]);
    expect(r.warnings).toEqual([{ code: 'invalid_value', path: 'entries[1].category_id', message: 'category_id names no category of the file; dropped' }]);
  });

  test('ids: kept, made unique (said), synthesised from the position; non-object rows skipped', () => {
    const r = read([{ id: 'a', title: 'A', content: '1' }, 'junk', { id: 'a', title: 'B', content: '2' }, { title: 'C', content: '3' }, { id: 7, title: 'D', content: '4' }]);
    expect(r.value.entries.map((e) => [e.id, e.title])).toEqual([
      ['a', 'A'],
      ['a-2', 'B'],
      ['3', 'C'],
      ['7', 'D'],
    ]);
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ['invalid_value', 'entries[1]'],
      ['invalid_value', 'entries[3].id'],
      ['duplicate_id', 'entries[2].id'],
    ]);
  });

  test('the book: name by --as, lorebook.name, file stem; globals mapped; creator and fork ids dropped; tree said once', () => {
    const f = file([], {
      tree: { tree_data: { root: {} }, version: 2 },
      nodeConstraints: [{ node_id: 'a' }],
      categories: [],
      counts: { totalEntries: 0 },
      extra_top: 1,
    });
    f.lorebook = {
      id: 'lb1',
      name: 'Aetheria',
      description: 'Sky isles.',
      creator_id: 'u1',
      forked_from_id: 'f1',
      original_creator_id: 'u0',
      status: 'published',
      created_at: '2026-01-01',
      global_scan_depth: 6,
      global_recursion: true,
      global_case_sensitive: false,
      global_match_whole_words: null,
      token_budget: 0,
      tags: ['oc'],
      genre: null,
      lorebook_type: 'world',
      provenance: null,
      shiny: 'new',
    };
    const r = readCompendium(f, { fallbackName: 'stem' });
    expect(r.value).toEqual({
      name: 'Aetheria',
      scanDepth: 6,
      recursive: true,
      caseSensitive: false,
      match: 'literal',
      entries: [],
      extras: { description: 'Sky isles.', tags: ['oc'], lorebook_type: 'world', shiny: 'new', envelope: { extra_top: 1 } },
    });
    expect(JSON.stringify(r.value)).not.toContain('u1');
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ['not_honoured', 'tree'],
      ['unknown_field', 'lorebook.shiny'],
      ['unknown_field', 'extra_top'],
    ]);
    expect(readCompendium(f, { fallbackName: 'stem', name: 'Небо' }).value.name).toBe('Небо');
    expect(readCompendium({ ...f, lorebook: { name: '  ' } }, { fallbackName: 'stem' }).value.name).toBe('stem');
  });
});

/** `n` objects nested in each other, {a: {a: … 'x'}}, built in a loop (recursion would overflow too). */
function nest(n: number): Record<string, unknown> {
  let v: unknown = 'x';
  for (let i = 0; i < n; i++) v = { a: v };
  return v as Record<string, unknown>;
}

/** How many objects and lists deep `v` goes (`v` itself is level 1), walked with a stack. */
function depthOf(v: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[v, 1]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [x, d] = top;
    if (typeof x !== 'object' || x === null) continue;
    max = Math.max(max, d);
    for (const y of Object.values(x)) stack.push([y, d + 1]);
  }
  return max;
}

/** The value of an own key, or undefined (reading `o.__proto__` or `o.constructor` would give inherited ones). */
const own = (o: unknown, key: string): unknown => (typeof o === 'object' && o !== null ? Object.getOwnPropertyDescriptor(o, key)?.value : undefined);
const ownProto = (o: unknown): unknown => own(o, '__proto__');

describe('hostile files (review breaker#3, breaker#9)', () => {
  const TOO_DEEP = 'nested deeper than 32 levels; the deeper parts are kept as their JSON text, cut to 1000 characters';

  test('structured_data deeper than 32 levels: the deep part becomes its JSON text, cut; one warning for the file', () => {
    const r = read([
      { id: 'a', title: 'Глубина', content: '', metadata: { entry_type: 'character', structured_data: { name: 'Глубина', deep: nest(20_000) } } },
      { id: 'b', title: 'Дно', content: 'Дно — место.', metadata: { entry_type: 'location', structured_data: { name: 'Дно', deep: nest(20_000) } } },
    ]);
    const [a, b] = r.value.entries as [LoreEntry, LoreEntry];
    for (const e of [a, b]) {
      const data = e.meta?.data as Record<string, unknown>;
      expect(depthOf(data)).toBe(32);
      let x: unknown = data.deep;
      for (let level = 2; level < 33; level++) x = (x as Record<string, unknown>).a;
      expect(typeof x).toBe('string');
      expect((x as string).startsWith('{"a":{"a":{"a":')).toBe(true);
      expect(x as string).toHaveLength(1001);
      expect((x as string).endsWith('…')).toBe(true);
    }
    expect(a.content.startsWith('# Глубина')).toBe(true); // rendered from the bounded data, no stack overflow
    expect(b.content).toBe('Дно — место.');
    expect(r.warnings.filter((w) => w.code === 'too_deep')).toEqual([
      { code: 'too_deep', path: 'entries[*].metadata.structured_data', message: `${TOO_DEEP} (2 entries)` },
    ]);
    expect(validateLoreBook(r.value).ok).toBe(true);
    expect(JSON.stringify(r.value, null, 2).length).toBeLessThan(20_000);
  });

  test('the bound is 32 levels: data within it is kept as is (the same object), level 33 is text', () => {
    const at32 = nest(32);
    const kept = read([{ id: 'a', title: 'A', content: 'x', metadata: { entry_type: 'item', structured_data: at32 } }]);
    expect(kept.value.entries[0]?.meta?.data).toBe(at32);
    expect(codes(kept.warnings)).toEqual([]);
    const cut = read([{ id: 'a', title: 'A', content: 'x', metadata: { entry_type: 'item', structured_data: nest(33) } }]);
    let x: unknown = cut.value.entries[0]?.meta?.data;
    for (let level = 1; level < 33; level++) x = (x as Record<string, unknown>).a;
    expect(x).toBe('{"a":"x"}');
    expect(cut.warnings).toEqual([{ code: 'too_deep', path: 'entries[0].metadata.structured_data', message: TOO_DEEP }]);
  });

  test('every other kept value is bounded too: columns, metadata, the book, the envelope', () => {
    const r = read([{ id: 'a', content: 'x', zz: nest(100_000), side_effects: nest(100_000), metadata: { note: nest(100_000) } }], {
      lorebook: { name: 'A', genre: nest(100_000) },
      more: nest(100_000),
    });
    expect(() => JSON.stringify(r.value, null, 2)).not.toThrow(); // 100 000 levels overflow JSON.stringify
    expect(depthOf(r.value)).toBeLessThan(40);
    expect(r.warnings.filter((w) => w.code === 'too_deep').map((w) => w.path)).toEqual(['lorebook.genre', 'more', 'entries[0].metadata', 'entries[0].zz', 'entries[0].side_effects']);
  });

  test('readCompendium never throws: what still fails to read is a refusal with the reason', () => {
    const row: Record<string, unknown> = { id: 'a', content: 'x' };
    Object.defineProperty(row, 'title', { enumerable: true, get: (): never => { throw new Error('boom'); } });
    const r = readCompendium(file([row]), { fallbackName: 'stem' });
    expect(r.refused).toBe('could not be read as a RoleCall Compendium export: boom');
    expect(r.value).toEqual({ name: 'stem', match: 'literal', entries: [] });
    expect(r.warnings).toEqual([{ code: 'unreadable', path: '$', message: 'could not be read as a RoleCall Compendium export: boom; nothing imported' }]);
    const deep: Record<string, unknown> = { id: 'a', content: 'x' };
    Object.defineProperty(deep, 'title', { enumerable: true, get: (): never => { throw new RangeError('Maximum call stack size exceeded.'); } });
    expect(readCompendium(file([deep]), { fallbackName: 'stem', name: 'As' })).toMatchObject({
      value: { name: 'As', entries: [] },
      refused: 'could not be read as a RoleCall Compendium export: it is nested too deeply or too large',
    });
    expect(read([{ id: 'a', content: 'x' }]).refused).toBeUndefined();
  });

  test("'__proto__' and 'constructor' keys stay plain own keys everywhere, as the warnings say; nothing is polluted", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const hostile = JSON.parse(`{
      "schemaVersion": "compendium-v1.0.0",
      "lorebook": { "name": "P", "__proto__": { "evil": 1 }, "constructor": { "prototype": { "evil": 2 } } },
      "entries": [
        { "id": "a", "content": "x", "__proto__": { "category": "Hacked" }, "constructor": "c", "metadata": { "__proto__": { "m": 1 }, "note": "n" } },
        { "id": "b", "content": "y", "__proto__": "text" },
        { "id": "c", "title": "Мира", "content": "", "metadata": { "entry_type": "character", "structured_data":
          { "name": "Мира", "__proto__": { "x": 1 }, "constructor": { "prototype": { "x": 2 } }, "deep": ${JSON.stringify(nest(40))} } } }
      ],
      "__proto__": { "x": 1 }
    }`) as unknown;
    const r = readCompendium(hostile, { fallbackName: 'stem' });
    const [a, b, c] = r.value.entries as [LoreEntry, LoreEntry, LoreEntry];
    const plain = (o: unknown): void => expect(Object.getPrototypeOf(o)).toBe(Object.prototype);

    const bookExtras = r.value.extras as Record<string, unknown>;
    plain(bookExtras);
    expect(ownProto(bookExtras)).toEqual({ evil: 1 });
    expect(own(bookExtras, 'constructor')).toEqual({ prototype: { evil: 2 } });
    expect(ownProto(bookExtras.envelope)).toEqual({ x: 1 });
    plain(bookExtras.envelope);

    const aExtras = a.extras as Record<string, unknown>;
    plain(aExtras);
    expect(ownProto(aExtras)).toEqual({ category: 'Hacked' });
    expect(aExtras.category).toBeUndefined();
    expect(own(aExtras, 'constructor')).toBe('c');
    expect(ownProto(aExtras.metadata)).toEqual({ m: 1 });
    expect(ownProto(b.extras)).toBe('text');

    // structured_data: copied because of its deep part, its keys still own
    const data = c.meta?.data as Record<string, unknown>;
    plain(data);
    expect(ownProto(data)).toEqual({ x: 1 });
    expect(own(data, 'constructor')).toEqual({ prototype: { x: 2 } });
    expect(depthOf(data)).toBe(32);

    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    const fresh: Record<string, unknown> = {};
    expect([fresh.evil, fresh.x, fresh.category, fresh.m]).toEqual([undefined, undefined, undefined, undefined]);
    const text = JSON.stringify(r.value);
    for (const kept of ['"__proto__":{"evil":1}', '"__proto__":{"x":1}', '"__proto__":{"category":"Hacked"}', '"__proto__":{"m":1}', '"__proto__":"text"']) {
      expect(text).toContain(kept);
    }
    expect(r.warnings.filter((w) => w.code === 'unknown_field').map((w) => w.message)).toEqual([
      'unknown lorebook field "__proto__" kept in extras',
      'unknown lorebook field "constructor" kept in extras',
      'unknown field "__proto__" kept in extras.envelope',
      'unknown column "__proto__" kept in extras (2 entries)',
      'unknown column "constructor" kept in extras',
    ]);
  });
});

describe('the lantern fixture (fixtures.md §2)', () => {
  const r = readCompendium(lantern(), { fallbackName: 'lantern.compendium' });
  const book = r.value;
  const byId = (suffix: string): LoreEntry => book.entries.find((e) => e.id.endsWith(suffix)) as LoreEntry;

  test('18 rows: 16 typed over all 11 types, an arc, a classic entry; a valid lorebook named Lantern', () => {
    expect(validateLoreBook(book).ok).toBe(true);
    expect(book.name).toBe('Lantern');
    expect(book.entries).toHaveLength(18);
    expect(book.entries.map((e) => e.id.slice(-3))).toEqual(Array.from({ length: 18 }, (_, i) => `e${String(i + 1).padStart(2, '0')}`));
    const typed = book.entries.filter((e) => e.meta?.type !== undefined);
    expect(typed).toHaveLength(16);
    expect(new Set(typed.map((e) => e.meta?.type))).toEqual(new Set(ENTRY_TYPES));
    expect(book.entries.filter((e) => e.meta?.arc !== undefined).map((e) => e.id.slice(-3))).toEqual(['e17']);
    expect(book.entries.filter((e) => e.meta === undefined).map((e) => e.id.slice(-3))).toEqual(['e18']);
  });

  test('typed rows: data as stored, aliases, featured e01/e06/e11, RoleCall\'s text in content', () => {
    expect(byId('e01').meta).toMatchObject({ type: 'character', aliases: ['Старшина', 'Арсений'], featured: true });
    expect(byId('e01').meta?.data?.smell).toBe('ламповое масло и дым'); // an unknown field is kept
    expect((byId('e01').meta?.data?.memories as Record<string, unknown>[])[0]?.writer_source).toBe('postgen'); // service fields kept in data
    expect(byId('e03').meta?.aliases).toEqual(['Смотрительница']);
    expect(byId('e06').meta).toMatchObject({ type: 'location', aliases: ['маяк'], featured: true });
    expect(byId('e05').meta?.data?.type).toBe('district'); // an off-enum value read as is
    expect(byId('e12').meta?.data?.severity).toBe('moderate');
    expect(book.entries.filter((e) => e.meta?.featured).map((e) => e.id.slice(-3))).toEqual(['e01', 'e06', 'e11']);
    for (const e of book.entries.filter((x) => x.meta?.type !== undefined)) {
      expect(e.content.trim()).not.toBe('');
      expect(e.extras?.content).toBeUndefined();
      expect(e.position).toBe('after');
    }
    expect(byId('e13').keys).toEqual(['Право огня', 'закон']);
    expect(byId('e13').extras?.metadata).toMatchObject({ source: 'tv_compendium', original_classic_content: expect.any(String), standardization_state: 'standardized' });
    expect(byId('e14')).toMatchObject({ title: '[Summary] Фонарь погас', meta: { type: 'summary', data: { title: 'Фонарь погас', turn_range: { from: 12, to: 31 } } } });
    expect(byId('e10').extras?.metadata).toMatchObject({ turnNumber: 9 });
  });

  test('the disabled row, the arc and the classic row', () => {
    expect(byId('e16')).toMatchObject({ enabled: false, meta: { type: 'location' }, extras: { metadata: { disableReason: 'merged' } } });
    expect(byId('e17')).toMatchObject({
      title: '[Arc] Украденный свет',
      constant: true,
      keys: ['Мира', 'Арсений Кеттер'],
      meta: { arc: 'Украденный свет' },
      extras: { metadata: { source: 'tv_arc_overview' } },
    });
    expect(byId('e17').content).toStartWith('Маяк погас');
    expect(byId('e18')).toEqual({
      id: '00000000-0000-4000-8000-000000000e18',
      title: 'Песня фонарщиков',
      content: byId('e18').content,
      enabled: true,
      constant: false,
      keys: ['песня фонарщиков', 'песню фонарщиков'],
      position: 'after',
      extras: { category: 'Песни и обычаи' },
    });
  });

  test('one warning (the stored tree); no creator or row-bookkeeping ids kept', () => {
    expect(codes(r.warnings)).toEqual(['not_honoured']);
    const text = JSON.stringify(book);
    expect(text).not.toContain('000000000a01'); // creator_id
    expect(text).not.toContain('000000000b01'); // lorebook id and every row's lorebook_id
    expect(text).not.toContain('created_at');
    expect(book.extras).toEqual({ description: expect.any(String), genre: 'фэнтези', tags: ['фонари', 'порт'], lorebook_type: 'world' });
  });
});
