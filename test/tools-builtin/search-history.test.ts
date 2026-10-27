// Ported from RoleCall:apps/rc/src/lib/ai/btw/__tests__/scene-search.test.ts@fb8dc623e and
// Bunraku:src/studio/dramaturg-tools.test.ts@702d8120 (the cases that still apply).
// Copyright (C) 2026 Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// searchHistory and search_history (src/tools/builtin/history.ts; §7.5, D-46, D-58): the active path
// up to the turn's user message, #n numbering, hidden messages and swipe siblings never searched,
// AND over stems, quoted phrases, stop words, newest first, the `before` cursor, the ±110 snippet,
// '(in context)'. Adapted from RoleCall ai/btw/__tests__/scene-search.test.ts and Bunraku
// src/studio/dramaturg-tools.test.ts (both Levi).
import { describe, expect, test } from 'bun:test';
import { foldView } from '../../src/session/fold.ts';
import { messageWords, searchHistory, searchHistoryTool, SEARCH_LIMIT_MAX, SNIPPET_RADIUS } from '../../src/tools/builtin/history.ts';
import { call, chatEntries, chatView, ctxFor, edit, hide, idOf, makeHeader, msg, seqd, viewAt } from './kit.ts';

const NAMES = { char: 'Mira', user: 'Levi' };
const search = (view: Parameters<typeof searchHistory>[0], q: string, opts: { before?: number; limit?: number; inContext?: (id: string) => boolean } = {}) =>
  searchHistory(view, null, q, { names: NAMES, ...opts });
const ns = (r: { hits: { n: number }[] }): number[] => r.hits.map((h) => h.n);

const SCENE = ['Evening.', 'Any storms?', 'One is coming.', 'My sister saw it.', 'Your sister lies.', 'Hush.'];

describe('scope and numbering', () => {
  test('#n is the path position from 1: the greeting is #1, hidden messages keep their numbers', () => {
    const view = chatView(SCENE, [hide(idOf(3))]);
    const r = search(view, 'sister');
    expect(ns(r)).toEqual([5, 4]);
    expect(r.hits.map((h) => [h.n, h.id, h.role, h.speaker])).toEqual([
      [5, idOf(5), 'assistant', 'Mira'],
      [4, idOf(4), 'user', 'Levi'],
    ]);
    expect(ns(search(view, 'evening'))).toEqual([1]);
  });

  test('a hidden message is never searched', () => {
    const view = chatView(SCENE, [hide(idOf(5))]);
    expect(ns(search(view, 'sister'))).toEqual([4]);
    expect(search(view, 'lies').hits).toEqual([]);
  });

  test("a swipe sibling is never searched, and a swipe's view at U never sees the answer it replaces", () => {
    // #1 g, #2 u, #3 a (the old answer) with a newer sibling a' that is the head.
    const entries = [...chatEntries(['Hello.', 'Where is the bell?', 'The bell rang at dawn.']), msg('m000003b', idOf(2), 'assistant', 'The lamp went out.')];
    const atHead = viewAt(entries, 'm000003b');
    expect(search(atHead, 'bell').hits.map((h) => h.id)).toEqual([idOf(2)]);
    expect(ns(search(atHead, 'lamp'))).toEqual([3]);
    // Swiping a' again: the turn's view is folded at U (#2); neither answer is on it.
    const atU = viewAt(entries, idOf(2));
    expect(search(atU, 'lamp').hits).toEqual([]);
    expect(search(atU, 'dawn').hits).toEqual([]);
    expect(ns(search(atU, 'bell'))).toEqual([2]);
  });

  test('upTo bounds the path: messages after it are not searched', () => {
    const view = chatView(['A lamp.', 'Another lamp.', 'A third lamp.']);
    expect(ns(searchHistory(view, idOf(2), 'lamp', { names: NAMES }))).toEqual([2, 1]);
    expect(ns(searchHistory(view, null, 'lamp', { names: NAMES }))).toEqual([3, 2, 1]);
  });

  test('the effective text after an edit: the old wording is gone', () => {
    const view = chatView(['Hello.', 'The key is under the mat.'], [edit(idOf(2), 'The key is in the well.')]);
    expect(search(view, 'mat').hits).toEqual([]);
    expect(ns(search(view, 'well'))).toEqual([2]);
  });

  test('only text blocks: reasoning, tool calls and tool results are not searched', () => {
    const view = chatView([
      'Hello.',
      'Find it.',
      [
        { k: 'reasoning', text: 'She plans a lie about the treasure.' },
        { k: 'tool_call', id: 'c1', name: 'search_history', args: '{"query":"treasure"}' },
        { k: 'tool_result', callId: 'c1', name: 'search_history', text: '#2 Levi: treasure map' },
        { k: 'text', text: 'Nothing here, ' },
        { k: 'text', text: 'only dust.' },
      ],
    ]);
    expect(search(view, 'treasure').hits).toEqual([]);
    expect(search(view, 'lie').hits).toEqual([]);
    // Text blocks join as they streamed.
    expect(search(view, '"here, only dust"').hits.map((h) => h.snippet)).toEqual(['Nothing here, only dust.']);
  });
});

describe('matching', () => {
  test('AND: every word of the query must be in the message, in any order', () => {
    const view = chatView(['The lamp is red.', 'The lamp is blue.', 'A red door.']);
    expect(ns(search(view, 'red lamp'))).toEqual([1]);
    expect(ns(search(view, 'LAMP'))).toEqual([2, 1]);
    expect(search(view, 'lamp green').hits).toEqual([]);
  });

  test('Cyrillic stems: брат finds брата and братом, never братства; Мира finds Миру', () => {
    const view = chatView(['Это было братство воров.', 'Я ищу брата.', 'Она пришла с братом.', 'Слава Миру!', 'Мирный договор.']);
    expect(ns(search(view, 'брат'))).toEqual([3, 2]);
    expect(ns(search(view, 'братом'))).toEqual([3, 2]);
    expect(ns(search(view, 'Мира'))).toEqual([4]);
    expect(ns(search(view, 'ёж'))).toEqual([]);
  });

  test('ё and е are one letter, case and stress marks do not matter', () => {
    const view = chatView(['Ёжик в тумане.', 'Му́ка и мука.']);
    expect(ns(search(view, 'ежик'))).toEqual([1]);
    expect(ns(search(view, 'МУКА'))).toEqual([2]);
  });

  test('stop words are dropped from the query: «как звали брата» needs only звали and брата', () => {
    const view = chatView(['Привет.', 'Её брата звали Тихон.', 'Как дела у брата?']);
    expect(ns(search(view, 'как звали брата'))).toEqual([2]);
    // A query of stop words only keeps them.
    const en = chatView(['Of course.', 'The end.', 'An end.']);
    expect(ns(search(en, 'the'))).toEqual([2]);
  });

  test('quoted phrases match literally (folded, unstemmed, words in a row); «…» and “…” too', () => {
    const view = chatView(['Брат Тихон ушёл.', 'Тихон, брат её, ушёл.', 'Брата Тихона нет.']);
    expect(ns(search(view, '"брат Тихон"'))).toEqual([1]);
    expect(ns(search(view, '«брата тихона»'))).toEqual([3]);
    expect(ns(search(view, '“БРАТ ТИХОН”'))).toEqual([1]);
    // Loose words still stem.
    expect(ns(search(view, 'брат тихон'))).toEqual([3, 2, 1]);
    // A phrase and a loose word together: both must hold.
    expect(ns(search(view, '"брат её" ушёл'))).toEqual([2]);
  });

  test('literal, not a regex: So.*n finds nothing in a scene full of Soren', () => {
    const view = chatView(['Soren spoke. soren waited. SOREN left.', 'Lucien watched.', 'Varkos and Soren argued.']);
    expect(search(view, 'So.*n').hits).toEqual([]);
    expect(ns(search(view, 'soren'))).toEqual([3, 1]);
  });

  test('an empty query (no words) returns no hits', () => {
    const view = chatView(['Hello.', '...']);
    expect(search(view, '').hits).toEqual([]);
    expect(search(view, ' ?! ').hits).toEqual([]);
  });

  test('spaceless scripts match by substring inside the run', () => {
    const view = chatView(['我的哥哥在龍城等我。', 'Nothing here.']);
    expect(ns(search(view, '龍城'))).toEqual([1]);
    expect(search(view, '龍城').hits[0]!.snippet).toBe('我的哥哥在龍城等我。');
  });

  test('a phrase found across a line break', () => {
    const view = chatView(['He turned to\nSoren and spoke.']);
    expect(ns(search(view, '"to soren"'))).toEqual([1]);
  });
});

describe('order, limit and the before cursor', () => {
  test('newest first, at most `limit` hits (default 10, max 20, at least 1)', () => {
    const view = chatView(Array.from({ length: 60 }, (_, i) => `lamp ${i + 1}`));
    const r = search(view, 'lamp');
    expect(ns(r)).toEqual(Array.from({ length: 10 }, (_, i) => 60 - i));
    expect(r.nextBefore).toBe(51);
    expect(search(view, 'lamp', { limit: 50 }).hits).toHaveLength(SEARCH_LIMIT_MAX);
    expect(search(view, 'lamp', { limit: 0 }).hits).toHaveLength(1);
    expect(search(view, 'lamp', { limit: -3 }).hits).toHaveLength(1);
    expect(search(view, 'lamp', { limit: 2.7 }).hits).toHaveLength(2);
  });

  test('before: only messages numbered below it; at or below #1 nothing', () => {
    const view = chatView(Array.from({ length: 8 }, (_, i) => `lamp ${i + 1}`));
    expect(ns(search(view, 'lamp', { before: 4 }))).toEqual([3, 2, 1]);
    expect(ns(search(view, 'lamp', { before: 100 }))).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(search(view, 'lamp', { before: 1 }).hits).toEqual([]);
    expect(search(view, 'lamp', { before: 0 }).hits).toEqual([]);
  });

  test('paging through 50 hits with the cursor never skips or repeats one (RoleCall window-edge bug)', () => {
    // 120 messages: every other one matches, some of those hidden, so hits are not evenly spaced.
    const texts = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 || i % 7 === 0 ? `караван ${i + 1}` : `дорога ${i + 1}`));
    const hidden = [5, 33, 34, 77].map((n) => hide(idOf(n)));
    const view = chatView(texts, hidden);
    const expected = texts
      .map((t, i) => ({ t, n: i + 1 }))
      .filter((x) => x.t.startsWith('караван') && ![5, 33, 34, 77].includes(x.n))
      .map((x) => x.n)
      .reverse();
    expect(expected.length).toBeGreaterThanOrEqual(50);
    for (const limit of [1, 7, 10, 20]) {
      const seen: number[] = [];
      let before: number | undefined;
      for (let pages = 0; pages < 200; pages++) {
        const r = search(view, 'каравана', { limit, ...(before !== undefined ? { before } : {}) });
        seen.push(...ns(r));
        if (r.nextBefore === null) break;
        expect(r.nextBefore).toBe(r.hits.at(-1)!.n);
        before = r.nextBefore;
      }
      expect(seen).toEqual(expected);
    }
  });

  test('nextBefore is null when the last page ends exactly at the oldest hit', () => {
    const view = chatView(Array.from({ length: 10 }, (_, i) => `lamp ${i + 1}`));
    const r = search(view, 'lamp', { limit: 10 });
    expect(r.hits).toHaveLength(10);
    expect(r.nextBefore).toBeNull();
  });
});

describe('snippets and marks', () => {
  test('±110 characters around the first match, whitespace collapsed, … at both cut ends', () => {
    const before = 'дорога\n\n\tи   лес '.repeat(20);
    const after = ' река   мост\n'.repeat(20);
    const text = `${before}НАХОДКА${after}`;
    const [hit] = search(chatView([text]), 'находка').hits;
    const flat = text.replace(/\s+/g, ' ').trim();
    const at = flat.indexOf('НАХОДКА');
    expect(hit!.snippet).toBe(`…${flat.slice(at - SNIPPET_RADIUS, at + 'НАХОДКА'.length + SNIPPET_RADIUS).trim()}…`);
    expect(hit!.snippet).not.toMatch(/\s\s|\n|\t/);
    expect(hit!.snippet.length).toBeLessThanOrEqual(2 * SNIPPET_RADIUS + 'НАХОДКА'.length + 2);
  });

  test('a short message is not ellipsised; a match near the start has no leading …', () => {
    const [short] = search(chatView(['a\n\n  b\tlamp c']), 'lamp').hits;
    expect(short!.snippet).toBe('a b lamp c');
    const [head] = search(chatView([`lamp ${'x '.repeat(200)}`]), 'lamp').hits;
    expect(head!.snippet.startsWith('lamp')).toBe(true);
    expect(head!.snippet.endsWith('…')).toBe(true);
  });

  test('the snippet centres on the earliest match of any query part', () => {
    const text = `${'a '.repeat(150)}lamp ${'b '.repeat(150)}door ${'c '.repeat(150)}`;
    const [hit] = search(chatView([text]), 'door lamp').hits;
    expect(hit!.snippet).toContain('lamp');
    expect(hit!.snippet).not.toContain('door');
  });

  test('a surrogate pair is never split at a cut end', () => {
    const text = `${'😀'.repeat(200)} lamp ${'😀'.repeat(200)}`;
    const [hit] = search(chatView([text]), 'lamp').hits;
    expect(hit!.snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  test('inContext marks the hits the request sent; unknown counts as not', () => {
    const view = chatView(['lamp one', 'lamp two', 'lamp three']);
    const r = search(view, 'lamp', { inContext: (id) => id === idOf(3) || id === idOf(2) });
    expect(r.hits.map((h) => [h.n, h.inContext])).toEqual([
      [3, true],
      [2, true],
      [1, false],
    ]);
    expect(search(view, 'lamp').hits.every((h) => !h.inContext)).toBe(true);
  });
});

describe('search_history (the tool)', () => {
  test('lines `#n speaker: snippet` with (in context), newest first, then the cursor line', async () => {
    const view = chatView(Array.from({ length: 30 }, (_, i) => `lamp ${i + 1}`));
    const ctx = ctxFor(view, { inContext: (id) => id === idOf(30) });
    const out = await call(searchHistoryTool, { query: 'lamp', limit: 3 }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(['#30 Levi: lamp 30 (in context)', '#29 Mira: lamp 29', '#28 Levi: lamp 28', 'More matches before #28: call search_history again with before=28.'].join('\n'));
    expect(out.summary).toBe('3 hits, more before #28');
    const next = await call(searchHistoryTool, { query: 'lamp', limit: 3, before: 28 }, ctx);
    expect(next.text.split('\n')[0]).toBe('#27 Mira: lamp 27');
  });

  test('no hits says so and suggests other words; with a cursor it names it', async () => {
    const ctx = ctxFor(chatView(['Hello.', 'Bye.']));
    const none = await call(searchHistoryTool, { query: 'dragon' }, ctx);
    expect(none.text).toMatch(/^No messages match\./);
    expect(none.text).toMatch(/another word or a name/);
    expect(none.error).toBeUndefined();
    expect(none.summary).toBe('no hits');
    expect((await call(searchHistoryTool, { query: 'dragon', before: 2 }, ctx)).text).toBe('No messages before #2 match.');
  });

  test('a query with no words is an error the model can fix', async () => {
    const out = await call(searchHistoryTool, { query: '?!' }, ctxFor(chatView(['Hello.'])));
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/no words/);
  });

  test('it searches ctx.view up to ctx.upTo with ctx.names', async () => {
    const view = chatView(['lamp a', 'lamp b', 'lamp c']);
    const out = await call(searchHistoryTool, { query: 'lamp' }, ctxFor(view, { upTo: idOf(2), names: { char: 'Vera', user: 'Ada' } }));
    expect(out.text).toBe('#2 Ada: lamp b\n#1 Vera: lamp a');
    expect(out.summary).toBe('2 hits');
  });

  test('20 long hits stay under maxOutput, and the cursor still points at the last hit shown', async () => {
    const long = (i: number) => `${'слово '.repeat(40)}лампа ${i} ${'слово '.repeat(40)}`;
    const view = chatView(Array.from({ length: 40 }, (_, i) => long(i + 1)));
    const ctx = ctxFor(view);
    const out = await call(searchHistoryTool, { query: 'лампа', limit: 20 }, ctx);
    expect(out.text.length).toBeLessThanOrEqual(searchHistoryTool.maxOutput!(ctx));
    const lines = out.text.split('\n');
    expect(lines.filter((l) => l.startsWith('#'))).toHaveLength(20);
    expect(lines.at(-1)).toBe('More matches before #21: call search_history again with before=21.');
  });
});

describe('the words cache', () => {
  test('survives a refold: views folded twice from the same entries share each message words', () => {
    const entries = seqd(chatEntries(SCENE, [edit(idOf(4), 'My sister saw the storm.')]));
    const a = foldView(makeHeader(), entries);
    const b = foldView(makeHeader(), entries);
    expect(b.path[3]).not.toBe(a.path[3]); // a new view object per fold, as every turn makes
    for (let i = 0; i < a.path.length; i++) expect(messageWords(b.path[i]!)).toBe(messageWords(a.path[i]!));
    expect(messageWords(b.path[3]!).map((w) => w.norm)).toEqual(['my', 'sister', 'saw', 'the', 'storm']);
    // Searching the second view finds the edited text.
    expect(ns(search(b, 'storm'))).toEqual([4, 2]); // #2 asks about storms
  });
});
