// text/lexscore.ts: lexicographic ranking (ARCHITECTURE.md §9.2), the «брат трактирщица» fixture
// against RoleCall's title×3/keys×2/text×1 weights (m3-port-search.md §10), and the tie-breaks.
import { describe, expect, test } from 'bun:test';
import { lexScore, type LexDoc } from '../../src/text/lexscore.ts';
import { parseQuery } from '../../src/text/normalize.ts';

const order = (q: string, docs: LexDoc[]): number[] => lexScore(parseQuery(q), docs).map((s) => s.index);

/** RoleCall search_lorebook's score (reference only): plain lower-case substrings, title×3 + keys×2 + text×1 per word, any word. */
function roleCallScore(q: string, d: LexDoc): number {
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if ((d.title ?? '').toLowerCase().includes(w)) score += 3;
    if ((d.keys ?? []).some((k) => k.toLowerCase().includes(w))) score += 2;
    if (d.text.toLowerCase().includes(w)) score += 1;
  }
  return score;
}

describe('the «брат трактирщица» fixture', () => {
  const alexei: LexDoc = { title: 'Брат Алексей', keys: ['брат Алексей'], text: 'Брат Алексей, кузнец.' };
  const marta: LexDoc = { title: 'Марта', keys: ['Марта'], text: 'Марта, трактирщица «Гуся». Её брат пропал с караваном.' };
  const docs = [alexei, marta];

  test('RoleCall weights put «Брат Алексей» first; lexScore puts the innkeeper first (matched parts decide)', () => {
    expect(roleCallScore('брат трактирщица', alexei)).toBe(6);
    expect(roleCallScore('брат трактирщица', marta)).toBe(2);
    expect(lexScore(parseQuery('брат трактирщица'), docs)).toEqual([
      { index: 1, matched: 2, inKey: 0, rank: 0 },
      { index: 0, matched: 1, inKey: 1, rank: 0 },
    ]);
  });

  test('inflected words: RoleCall finds nothing, lexScore still ranks by stems', () => {
    expect(roleCallScore('брата трактирщицы', alexei) + roleCallScore('брата трактирщицы', marta)).toBe(0);
    expect(order('брата трактирщицы', docs)).toEqual([1, 0]);
  });

  test('a query that names Алексей puts him first', () => {
    expect(order('брат Алексея', docs)).toEqual([0, 1]);
  });
});

describe('ordering and tie-breaks', () => {
  test('matched first, then parts matched in the title or a key', () => {
    const docs: LexDoc[] = [
      { title: 'Порт', text: 'В порту стоит караван.' }, // караван in text only
      { title: 'Караван', text: 'Длинный обоз.' }, // караван in the title
      { keys: ['караваны'], text: 'Пыль.' }, // in a key
    ];
    expect(lexScore(parseQuery('караван'), docs)).toEqual([
      { index: 1, matched: 1, inKey: 1, rank: 0 },
      { index: 2, matched: 1, inKey: 1, rank: 0 },
      { index: 0, matched: 1, inKey: 0, rank: 0 },
    ]);
  });

  test('then rank (higher first), then the input order', () => {
    const docs: LexDoc[] = [
      { text: 'Мира пришла.', rank: 1 },
      { text: 'Мирой любуются.', rank: 5 },
      { text: 'О Мире.' },
      { text: 'К Миру.', rank: 5 },
    ];
    expect(order('Мира', docs)).toEqual([1, 3, 0, 2]);
  });

  test('a stronger inKey never beats more matched parts', () => {
    const docs: LexDoc[] = [
      { title: 'брат', keys: ['брат', 'братья'], text: 'брат', rank: 100 },
      { text: 'брат и сестра' },
    ];
    expect(order('брат сестра', docs)).toEqual([1, 0]);
  });

  test('docs that match nothing are left out; an empty query ranks nothing', () => {
    const docs: LexDoc[] = [{ text: 'кузнец' }, { text: 'караван' }];
    expect(order('караван', docs)).toEqual([1]);
    expect(lexScore(parseQuery(''), docs)).toEqual([]);
    expect(lexScore(parseQuery('караван'), [])).toEqual([]);
  });
});

describe('what counts as a key match', () => {
  test('phrases match a key only inside one key; regex keys take no part', () => {
    const docs: LexDoc[] = [
      { keys: ['старый', 'караван'], text: 'старый караван' }, // the phrase only in the text
      { keys: ['старый караван'], text: 'пыль' },
      { keys: ['/старый\\s+караван/i'], text: 'старый караван' },
    ];
    expect(lexScore(parseQuery('«старый караван»'), docs)).toEqual([
      { index: 1, matched: 1, inKey: 1, rank: 0 },
      { index: 0, matched: 1, inKey: 0, rank: 0 },
      { index: 2, matched: 1, inKey: 0, rank: 0 },
    ]);
  });

  test('a part found in both a key and the text counts once', () => {
    expect(lexScore(parseQuery('Мира брат'), [{ title: 'Мира', keys: ['Мира'], text: 'Мира и её брат' }])).toEqual([{ index: 0, matched: 2, inKey: 1, rank: 0 }]);
  });

  test('substrings of spaceless scripts', () => {
    const docs: LexDoc[] = [{ text: '東京タワーの話' }, { title: '東京', text: '首都' }];
    expect(lexScore(parseQuery('東京'), docs)).toEqual([
      { index: 1, matched: 1, inKey: 1, rank: 0 },
      { index: 0, matched: 1, inKey: 0, rank: 0 },
    ]);
  });
});
