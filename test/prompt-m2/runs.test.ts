// assemble M2: one lore run per request — sources, seeds, timers from the path, verdicts, hashes,
// notices, lore content as a template (§10.3, §5.10, D-42, D-44, D-45).
import { describe, expect, test } from 'bun:test';
import type { LoreBook } from '../../src/formats/native.ts';
import { CARD_BOOK_KEY, PERSONA_BOOK_KEY } from '../../src/lore/engine.ts';
import { assemble, loreBookHash } from '../../src/prompt/assemble.ts';
import { shadowedCastBooks } from '../../src/prompt/assemble/lore.ts';
import { buildTree } from '../../src/session/tree.ts';
import { foldView, foldViewAt } from '../../src/session/fold.ts';
import type { EntryInput } from '../../src/session/entries.ts';
import { head, makeHeader, msg, seqd, traceWith } from '../session/fixtures.ts';
import { allText, always, bySrc, entry, input, LEVI, longView, MIRA, ok, source, textOf, withFires, withLore } from './fixtures.ts';

const ids = (r: { trace: { lore: { fired: { id: string }[] } } }): string[] => r.trace.lore.fired.map((f) => f.id);

describe('sources: persona book, card book, then the session books (ST character first)', () => {
  const book = (id: string): LoreBook => ({ name: id, entries: [always(id)] });

  test('gathered in that order; equal-order entries reverse it in the slot (ST unshifts)', () => {
    const r = ok(
      assemble(
        input({
          view: longView(),
          cast: { character: { ...MIRA, book: book('C') }, persona: { ...LEVI, book: book('P') } },
          lorebooks: [source('lib', [always('L')])],
        }),
      ),
    );
    expect(r.trace.lore.fired).toEqual([
      { book: PERSONA_BOOK_KEY, id: 'P', why: 'constant' },
      { book: CARD_BOOK_KEY, id: 'C', why: 'constant' },
      { book: 'lib', id: 'L', why: 'constant' },
    ]);
    expect(textOf(bySrc(r.messages, 'lore_before')!)).toBe('L text\nC text\nP text');
    expect(Object.keys(r.trace.loreHashes)).toEqual([PERSONA_BOOK_KEY, CARD_BOOK_KEY, 'lib']);
  });

  test("a world is read once by name (ST): a session book shadows the card's and the persona's own book of that name", () => {
    const named = (name: string, id: string): LoreBook => ({ name, entries: [always(id)] });
    const r = ok(
      assemble(
        input({
          view: longView(),
          cast: { character: { ...MIRA, book: named('Eldoria', 'C') }, persona: { ...LEVI, book: named('Eldoria', 'P') } },
          lorebooks: [{ key: 'eldoria', book: named(' Eldoria ', 'L') }],
          explain: true,
        }),
      ),
    );
    expect(ids(r)).toEqual(['L']);
    expect(r.verdicts!.map((v) => v.book)).toEqual(['eldoria']);
    expect(Object.keys(r.trace.loreHashes)).toEqual(['eldoria']);
    // the persona's book of the same name shadows the card's; other names and blank names do not
    const cast = (card: string, persona: string) => ({ character: { ...MIRA, book: named(card, 'C') }, persona: { ...LEVI, book: named(persona, 'P') } });
    expect(shadowedCastBooks(cast('W', 'W'), [])).toEqual({ card: PERSONA_BOOK_KEY });
    expect(shadowedCastBooks(cast('W', 'V'), [{ key: 'lib', book: named('X', 'L') }])).toEqual({});
    expect(shadowedCastBooks(cast('', ''), [{ key: 'lib', book: named('', 'L') }])).toEqual({});
    expect(shadowedCastBooks(cast('W', 'V'), [{ key: 'lib', book: named('V', 'L') }])).toEqual({ persona: 'lib' });
  });

  test('two session books with one name: only the later is read (a world is read once by name)', () => {
    // Regression: a changed copy of a world imported under a new id (harbor-2 "Harbor") was scanned
    // next to the old one, and both versions of every entry were sent.
    const named = (name: string, id: string): LoreBook => ({ name, entries: [always(id)] });
    const r = ok(
      assemble(
        input({
          view: longView(),
          lorebooks: [
            { key: 'harbor', book: named('Harbor', 'old') },
            { key: 'other', book: named('Other', 'o') },
            { key: 'harbor-2', book: named(' Harbor', 'new') },
          ],
        }),
      ),
    );
    expect(ids(r)).toEqual(['o', 'new']);
    expect(Object.keys(r.trace.loreHashes)).toEqual(['other', 'harbor-2']);
  });

  test("a nameless card book is \"<char>'s Lorebook\", as SillyTavern names it, so its extracted world is not read twice", async () => {
    const { parseCardObject } = await import('../../src/formats/card.ts');
    const { worldInfoToLoreBook } = await import('../../src/formats/st-worldinfo.ts');
    const entryRow = { id: 1, keys: ['harbor'], content: 'ONCE LORE', enabled: true, insertion_order: 100 };
    const card = parseCardObject({ spec: 'chara_card_v2', data: { name: 'Mira', description: 'd', first_mes: 'Hello.', character_book: { entries: [entryRow] } } }).value;
    expect(card.book?.name).toBe("Mira's Lorebook");
    // ST's world for it (importEmbeddedWorldInfo writes it under that name)
    const world = worldInfoToLoreBook({ name: "Mira's Lorebook", entries: { 0: { uid: 0, key: ['harbor'], content: 'ONCE LORE', position: 1 } } }, 'x').value;
    const said = ok(
      assemble(
        input({
          view: { ...longView(), path: longView().path.map((m, i, all) => (i === all.length - 1 ? { ...m, blocks: [{ k: 'text' as const, text: 'To the harbor.' }] } : m)) },
          cast: { character: { ...MIRA, book: card.book! } },
          lorebooks: [{ key: 'miras-lorebook', book: world }],
        }),
      ),
    );
    // sent once: the card's copy is not read (it used to be "Mira's book", so both copies fired)
    expect(said.messages.map((m) => textOf(m)).join('\n').split('ONCE LORE')).toHaveLength(2);
    expect(Object.keys(said.trace.loreHashes)).toEqual(['miras-lorebook']);
  });

  test('no book anywhere: nothing fired, no hashes', () => {
    const r = withLore([]);
    expect(r.trace.lore).toEqual({ fired: [], cut: [], budget: 6144 });
    expect(ok(assemble(input())).trace.loreHashes).toEqual({});
  });
});

describe('keys read the chat as ST does', () => {
  test('"Name: text" lines: a key naming the speaker fires (world_info_include_names)', () => {
    expect(ids(withLore([entry('who', { keys: ['Levi'] })]))).toEqual(['who']);
  });

  test('scan depth 2 by default: the greeting is out of reach unless the entry looks deeper', () => {
    expect(ids(withLore([entry('far', { keys: ['traveller'] })]))).toEqual([]);
    expect(ids(withLore([entry('far', { keys: ['traveller'], scanDepth: 6 })]))).toEqual(['far']);
    expect(ids(withLore([entry('near', { keys: ['map'] })]))).toEqual(['near']);
  });

  test('identity macros in keys are expanded first (ST normalizeWorldInfoKey); the book is not touched', () => {
    const view = longView();
    view.path[5] = { ...view.path[5]!, blocks: [{ k: 'text', text: 'Mira, show me the map.' }] };
    const entries = [
      entry('U', { keys: ['{{user}}'] }),
      entry('C', { keys: ['<BOT>'], scanDepth: 1 }),
      entry('S', { keys: ['map'], secondary: ['{{char}}'], logic: 'and_all', scanDepth: 1 }),
      entry('V', { keys: ['{{setvar::x::1}}{{char}}'] }),
    ];
    const r = withLore(entries, { view, explain: true });
    expect(ids(r).sort()).toEqual(['C', 'S', 'U']);
    expect(r.verdicts!.find((v) => v.id === 'U')!.matched).toEqual(['Levi']);
    expect(r.varsDiff).toEqual({}); // keys are read-only: only identity macros
    expect(entries[0]!.keys).toEqual(['{{user}}']);
  });

  test('history is scanned, never expanded: a macro typed in the chat matches only as text', () => {
    const view = longView();
    view.path[5] = { ...view.path[5]!, blocks: [{ k: 'text', text: 'The {{random::x}} lamp' }] };
    expect(ids(withLore([entry('lamp', { keys: ['lamp'] })], { view }))).toEqual(['lamp']);
  });
});

describe('lore content is a template (D-42), expanded in the request run', () => {
  test('identity macros, variables, and the vars diff', () => {
    const r = withLore([always('T', { content: '{{char}} remembers {{user}}.{{setvar::seen::yes}}' }), always('U', { order: 1, content: 'Seen: {{getvar::seen}}' })]);
    expect(textOf(bySrc(r.messages, 'lore_before')!)).toBe('Seen: yes\nMira remembers Levi.');
    expect(r.varsDiff).toEqual({ seen: 'yes' });
  });

  test("{{random}} reads the entry's own sub-stream (D-44): other blocks cannot shift it", () => {
    const lore = [always('R', { content: '{{random::a::b::c::d::e::f::g::h}}' })];
    const pick = (r: ReturnType<typeof withLore>) => textOf(bySrc(r.messages, 'lore_before')!);
    const extra = (seed: number) => withLore(lore, {
      seed,
      preset: {
        name: 'p',
        blocks: [
          { id: 'noise', role: 'system', enabled: true, content: '{{random::1::2::3}} {{roll::1d20}}', at: 'relative' },
          { id: 'lore_before', role: 'system', enabled: true, content: '{{lore::before}}', at: 'relative' },
          { id: 'history', role: 'system', enabled: true, content: '{{history}}', at: 'relative' },
        ],
      },
    });
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      expect(pick(extra(seed))).toBe(pick(withLore(lore, { seed })));
      seen.add(pick(extra(seed)));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test('an unknown macro in lore stays literal and is reported', () => {
    const r = withLore([always('X', { content: 'A {{mystery}} B' })]);
    expect(textOf(bySrc(r.messages, 'lore_before')!)).toBe('A {{mystery}} B');
    expect(r.trace.macros.unknown).toContain('mystery');
  });
});

describe('seeds (D-44): same seed, same request; a different seed can change a group pick', () => {
  const group = ['G1', 'G2', 'G3', 'G4'].map((id) => always(id, { groups: ['g'] }));

  test('same input and seed → identical messages, trace and notices', () => {
    const a = withLore(group, { seed: 7 });
    const b = withLore(group, { seed: 7 });
    expect(b.messages).toEqual(a.messages);
    expect(b.trace).toEqual(a.trace);
    expect(b.notices).toEqual(a.notices);
  });

  test('one winner per group, and the winner moves with the seed', () => {
    const winners = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const fired = ids(withLore(group, { seed }));
      expect(fired).toHaveLength(1);
      winners.add(fired[0]!);
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  test('probability rolls on the seed too', () => {
    const coin = [always('C', { probability: 50 })];
    const outcomes = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) outcomes.add(ids(withLore(coin, { seed })).length);
    expect([...outcomes].sort()).toEqual([0, 1]);
    expect(ids(withLore(coin, { seed: 3 }))).toEqual(ids(withLore(coin, { seed: 3 })));
  });
});

describe('timers from the fires on the path (§5.10)', () => {
  // a1 is path index 2; the turn at u3 sees chat length 6.
  const S = entry('S', { keys: ['dragon'], sticky: 5 }); // window [2, 7): still open at 6
  const C = entry('C', { keys: ['map'], cooldown: 10 }); // u3 says "map", but it cools down until 12
  const fired = [{ msgId: 'a1', fired: [{ book: 'lib', id: 'S', why: 'key' }, { book: 'lib', id: 'C', why: 'key' }] }];

  test('sticky persists without a key match; cooldown blocks a match', () => {
    const r = withLore([S, C], { view: withFires(longView(), fired), explain: true });
    expect(r.trace.lore.fired).toEqual([{ book: 'lib', id: 'S', why: 'sticky' }]);
    const v = Object.fromEntries((r.verdicts ?? []).map((x) => [x.id, x.why]));
    expect(v).toEqual({ S: 'sticky', C: 'cooldown' });
  });

  test('without those fires: S has no key, C fires on "map"', () => {
    expect(withLore([S, C]).trace.lore.fired).toEqual([{ book: 'lib', id: 'C', why: 'key' }]);
  });

  test('a fire from another book with the same entry id is not this entry', () => {
    const other = [{ msgId: 'a1', fired: [{ book: 'elsewhere', id: 'S', why: 'key' }] }];
    expect(ids(withLore([S], { view: withFires(longView(), other) }))).toEqual([]);
  });

  test("a swipe's view (foldViewAt U) leaves the replaced answer's fires out", () => {
    // g, u1, a1 (fires X), u2, a2 (fires Y; the answer being swiped), plus a2's earlier sibling (fires Z).
    const book = [entry('X', { keys: ['zzz'], sticky: 10 }), entry('Y', { keys: ['zzz'], sticky: 10 }), entry('Z', { keys: ['zzz'], sticky: 10 })];
    const fires = (id: string) => ({ trace: traceWith([{ book: 'lib', id, why: 'key' }]) as never });
    const log: EntryInput[] = [
      msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }),
      msg('u0000001', 'g0000001', 'user', 'Hi'),
      msg('a0000001', 'u0000001', 'assistant', 'one', fires('X')),
      msg('u0000002', 'a0000001', 'user', 'Tell me about the map'),
      msg('a000000z', 'u0000002', 'assistant', 'older swipe', fires('Z')),
      msg('a0000002', 'u0000002', 'assistant', 'two', fires('Y')),
      head('a0000002'),
    ];
    const entries = seqd(log);
    const header = makeHeader();
    const tree = buildTree(entries);
    expect(foldView(header, entries).fires.map((f) => f.msgId)).toEqual(['a0000001', 'a0000002']);

    const view = foldViewAt(header, tree, 'u0000002');
    expect(view.fires.map((f) => f.msgId)).toEqual(['a0000001']);
    const r = ok(assemble(input({ view, upTo: 'u0000002', kind: 'swipe', lorebooks: [source('lib', book)], explain: true })));
    expect(r.trace.lore.fired).toEqual([{ book: 'lib', id: 'X', why: 'sticky' }]);
    expect((r.verdicts ?? []).filter((v) => v.fired).map((v) => v.id)).toEqual(['X']);
  });
});

describe('verdicts [D-45]', () => {
  const entries = [always('K'), entry('N', { keys: ['nowhere'] }), entry('D', { keys: ['map'], enabled: false })];

  test('present only with explain: one per entry of every source, in book order', () => {
    const r = withLore(entries, { explain: true });
    expect((r.verdicts ?? []).map((v) => `${v.book}:${v.id}:${v.fired ? '+' : '-'}${v.why}`)).toEqual([
      'lib:K:+constant',
      'lib:N:-no-key-match',
      'lib:D:-disabled',
    ]);
    expect('verdicts' in withLore(entries)).toBe(false);
    expect('verdicts' in withLore(entries, { explain: false })).toBe(false);
  });

  test('explain changes nothing else', () => {
    const a = withLore(entries, { explain: true });
    const b = withLore(entries);
    expect(a.messages).toEqual(b.messages);
    expect(a.trace).toEqual(b.trace);
  });

  test('with no book at all, explain gives an empty list', () => {
    expect(ok(assemble(input({ explain: true }))).verdicts).toEqual([]);
  });
});

describe('loreHashes (§5.7)', () => {
  const lib = source('lib', [always('A'), entry('B', { keys: ['x'] })]);

  test('stable across runs, the same hash the export gives', () => {
    const a = withLore(lib.book.entries);
    const b = withLore(lib.book.entries);
    expect(a.trace.loreHashes).toEqual(b.trace.loreHashes);
    expect(a.trace.loreHashes).toEqual({ lib: loreBookHash(lib.book) });
    expect(a.trace.loreHashes.lib).toMatch(/^[0-9a-f]{16}$/);
  });

  test('follows content, not key order', () => {
    // Every object's keys written in reverse order.
    const reversed = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v;
    const reordered = reversed(lib.book) as LoreBook;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(lib.book));
    expect(loreBookHash(reordered)).toBe(loreBookHash(lib.book));
    const edited: LoreBook = { ...lib.book, entries: [{ ...lib.book.entries[0]!, content: 'changed' }, lib.book.entries[1]!] };
    expect(loreBookHash(edited)).not.toBe(loreBookHash(lib.book));
    expect(withLore(edited.entries).trace.loreHashes.lib).toBe(loreBookHash(edited));
  });

  test('a book with nothing enabled is still hashed (it is an input)', () => {
    expect(Object.keys(withLore([entry('off', { enabled: false })]).trace.loreHashes)).toEqual(['lib']);
  });
});

describe("notice 'lore_regex_invalid'", () => {
  test('one warning naming book:id and the keys, no other text from the book', () => {
    const r = withLore([
      entry('R1', { keys: ['/a(?=b)/'], content: 'SECRET ONE' }),
      entry('R2', { keys: ['/(x/i', 'fine'], content: 'SECRET TWO' }),
      entry('ok', { keys: ['/ma+p/'] }),
    ]);
    const n = r.notices.filter((x) => x.code === 'lore_regex_invalid');
    expect(n).toHaveLength(1);
    expect(n[0]!.level).toBe('warn');
    expect(n[0]!.message).toContain('lib:R1 /a(?=b)/');
    expect(n[0]!.message).toContain('lib:R2 /(x/i');
    expect(n[0]!.message).not.toContain('SECRET');
    expect(n[0]!.message).not.toContain('lib:ok');
    expect(ids(r)).toEqual(['ok']);
  });

  test('none when every key compiles', () => {
    expect(withLore([entry('ok', { keys: ['/ma+p/'] })]).notices).toEqual([]);
  });

  test('a long list is capped', () => {
    const many = Array.from({ length: 14 }, (_, i) => entry(`r${i}`, { keys: ['/(/'] }));
    const msg = withLore(many).notices.find((x) => x.code === 'lore_regex_invalid')!.message;
    expect(msg).toContain('and 4 more');
    expect(msg).not.toContain('lib:r13');
  });
});

describe('continue', () => {
  test('lore runs over the path up to the answer being continued', () => {
    const view = longView();
    const r = ok(assemble(input({ view, upTo: 'a2', kind: 'continue', lorebooks: [source('lib', [entry('L', { keys: ['lighthouse'] })])] })));
    expect(ids(r)).toEqual(['L']);
    expect(allText(r.messages)).toContain('L text');
  });
});
