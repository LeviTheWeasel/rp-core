// text/normalize.ts M3: foldText, normalizeTerm (fixture table test/fixtures/ru/normalize-terms.json),
// wordsOf offsets, parseQuery, matchQuery, stemKeyMatches and the prepared stem-key helpers.
import { describe, expect, test } from 'bun:test';
import table from '../fixtures/ru/normalize-terms.json';
import {
  compileStemKey,
  extendStemText,
  foldText,
  FUNCTION_WORD_MARK,
  matchQuery,
  matchStemKey,
  normalizeTerm,
  parseQuery,
  STOP_WORDS,
  stemKeyMatches,
  stemText,
  wordsOf,
  type StemKey,
  type Word,
} from '../../src/text/normalize.ts';

/** The words of a text as [original slice, norm, stem]: offsets checked through the slice. */
const slices = (text: string): [string, string, string][] => wordsOf(text).map((w) => [text.slice(w.start, w.end), w.norm, w.stem]);

describe('foldText', () => {
  test('NFKC, lower case, ё→е', () => {
    expect(foldText('ЁЛКА и Ёж')).toBe('елка и еж');
    expect(foldText('ﬁre ＡＢＣ ① ²')).toBe('fire abc 1 2');
    expect(foldText('Hello, World!')).toBe('hello, world!');
  });

  test('combining diacritics U+0300–U+036F are dropped; composed letters stay', () => {
    expect(foldText('Ми\u0301ра')).toBe('мира'); // stress mark
    expect(foldText('му\u0301ка')).toBe('мука');
    expect(foldText('Сергеи\u0306')).toBe('сергей'); // NFD й composes first
    expect(foldText('Е\u0308ж')).toBe('еж'); // NFD Ё composes, then folds
    expect(foldText('café')).toBe('café'); // é is one code point after NFKC
    expect(foldText('İstanbul')).toBe('istanbul'); // lower case adds U+0307, then dropped
  });

  test('locale-free and deterministic', () => {
    expect(foldText('I')).toBe('i'); // not the Turkish dotless ı
    expect(foldText('Ω')).toBe('ω'); // the ohm sign is Ω under NFKC
  });
});

describe('normalizeTerm: fixture table', () => {
  for (const g of table.meet) {
    test(`meet (${g.why}): ${g.words.join(' / ')}`, () => {
      const stems = g.words.map((w) => normalizeTerm(w));
      expect(stems.map((s, i) => [g.words[i], s])).toEqual(g.words.map((w) => [w, stems[0]]));
    });
  }

  test('apart', () => {
    for (const [a, b] of table.apart as [string, string][]) {
      expect([a, b, normalizeTerm(a) === normalizeTerm(b)]).toEqual([a, b, false]);
    }
  });

  test('exact stems', () => {
    const got = Object.fromEntries(Object.keys(table.stems).map((w) => [w, normalizeTerm(w)]));
    expect(got).toEqual(table.stems);
  });

  test('documented misses stay documented', () => {
    for (const m of table.misses) {
      const [a, b] = m.pair as [string, string];
      expect([m.why, a, b, normalizeTerm(a) === normalizeTerm(b)]).toEqual([m.why, a, b, false]);
    }
  });

  test('documented false merges stay documented (normalize.ts names each one)', () => {
    for (const m of table.merges) {
      const [a, b] = m.pair as [string, string];
      expect([m.why, a, b, normalizeTerm(a) === normalizeTerm(b)]).toEqual([m.why, a, b, true]);
    }
  });

  test('a function word gets a stem no cut can produce: it meets only itself', () => {
    for (const w of ['над', 'надо', 'под', 'подо', 'вас', 'вам', 'вами', 'нас', 'нам', 'нами', 'тем', 'том', 'тому', 'чем', 'чему', 'кем', 'ком', 'кому', 'ним', 'них', 'ней']) {
      const stem = normalizeTerm(w);
      expect([w, stem]).toEqual([w, `${w}${FUNCTION_WORD_MARK}`]);
      expect(normalizeTerm(w.toUpperCase())).toBe(stem);
      // No word of the fixture table cuts down to it.
      for (const other of table.meet.flatMap((g) => g.words)) if (foldText(other) !== w) expect([other, normalizeTerm(other) === stem]).toEqual([other, false]);
    }
  });

  test('wordsOf stems a lone word exactly as normalizeTerm does', () => {
    const words = [...table.meet.flatMap((g) => g.words), ...table.apart.flat(), ...Object.keys(table.stems), ...table.merges.flatMap((m) => m.pair)];
    for (const w of words) {
      const ws = wordsOf(w);
      if (ws.length !== 1) continue;
      expect([w, (ws[0] as Word).stem]).toEqual([w, normalizeTerm(w)]);
    }
  });

  test('the spec pairs, spelled out', () => {
    expect(new Set(['караван', 'каравана', 'караваном'].map(normalizeTerm)).size).toBe(1);
    expect(['Мира', 'Миру', 'Мирой'].map(normalizeTerm)).toEqual(['мир', 'мир', 'мир']);
    expect(normalizeTerm('трактирщица')).toBe(normalizeTerm('трактирщицу'));
    expect(['брат', 'брата', 'братом'].map(normalizeTerm)).toEqual(['брат', 'брат', 'брат']);
    expect(normalizeTerm('ёж')).toBe(normalizeTerm('еж'));
    expect(normalizeTerm('брат')).not.toBe(normalizeTerm('братства'));
    expect(normalizeTerm('мир')).not.toBe(normalizeTerm('мирный'));
  });

  test('short words, digits and other scripts are only folded', () => {
    expect(normalizeTerm('Дом')).toBe('дом');
    expect(normalizeTerm('cats')).toBe('cat');
    expect(normalizeTerm('gas')).toBe('gas');
    expect(normalizeTerm('2026')).toBe('2026');
    expect(normalizeTerm('Ἀθῆναι')).toBe(foldText('Ἀθῆναι'));
    expect(normalizeTerm('猫たち')).toBe('猫たち');
  });
});

describe('wordsOf', () => {
  test('Cyrillic words with offsets into the original text', () => {
    expect(slices('«Брат, — сказала Мира.»')).toEqual([
      ['Брат', 'брат', 'брат'],
      ['сказала', 'сказала', 'сказал'],
      ['Мира', 'мира', 'мир'],
    ]);
  });

  test('a combining mark stays inside its word; the slice keeps it, the norm does not', () => {
    expect(slices('Ми\u0301ра и Сергеи\u0306')).toEqual([
      ['Ми\u0301ра', 'мира', 'мир'],
      ['и', 'и', 'и'],
      ['Сергеи\u0306', 'сергей', 'серг'],
    ]);
  });

  test('emoji and other surrogate pairs: read whole, offsets stay right', () => {
    const text = '🐉брат 𐐀𐐁 x🐉y';
    const ws = wordsOf(text);
    expect(slices(text)).toEqual([
      ['брат', 'брат', 'брат'],
      ['𐐀𐐁', '𐐨𐐩', '𐐨𐐩'], // Deseret letters are \p{L} (astral), lower-cased
      ['x', 'x', 'x'],
      ['y', 'y', 'y'],
    ]);
    expect(ws.map((w) => [w.start, w.end])).toEqual([
      [2, 6],
      [7, 11],
      [12, 13],
      [15, 16],
    ]);
  });

  test('a spaceless-script run is one word, cut where other letters begin', () => {
    expect(slices('東京タワーへ行く')).toEqual([['東京タワーへ行く', '東京タワーへ行く', '東京タワーへ行く']]);
    expect(slices('龍cat城 и ภาษาไทย')).toEqual([
      ['龍', '龍', '龍'],
      ['cat', 'cat', 'cat'],
      ['城', '城', '城'],
      ['и', 'и', 'и'],
      ['ภาษาไทย', 'ภาษาไทย', 'ภาษาไทย'], // Thai vowel signs are marks: one word
    ]);
    expect(slices('第3章')).toEqual([
      ['第', '第', '第'],
      ['3', '3', '3'],
      ['章', '章', '章'],
    ]);
  });

  test('punctuation, quotes, dashes and _ split words; an English possessive joins its word', () => {
    expect(slices("snake_case don't Mira's tavern’s 's")).toEqual([
      ['snake', 'snake', 'snake'], // a final -e is cut only after s, x, z, ch, sh, i or o
      ['case', 'case', 'cas'],
      ['don', 'don', 'don'],
      ['t', 't', 't'],
      ["Mira's", "mira's", 'mira'],
      ['tavern’s', 'tavern’s', 'tavern'],
      ['s', 's', 's'],
    ]);
    expect(slices('северо-запад')).toEqual([
      ['северо', 'северо', 'север'],
      ['запад', 'запад', 'запад'],
    ]);
  });

  test('a run NFKC turns into several words splits again, sharing the offsets', () => {
    expect(wordsOf('½')).toEqual([
      { norm: '1', stem: '1', start: 0, end: 1 },
      { norm: '2', stem: '2', start: 0, end: 1 },
    ]);
    expect(wordsOf('\u0301 ,')).toEqual([]); // a lone stress mark folds to nothing
    expect(wordsOf('')).toEqual([]);
  });
});

describe('parseQuery', () => {
  test('three quote styles make phrases of folded, unstemmed words', () => {
    expect(parseQuery('"Брата Алексея" «старый КАРАВАН» “the end”')).toEqual({
      terms: [],
      phrases: [
        ['брата', 'алексея'],
        ['старый', 'караван'],
        ['the', 'end'],
      ],
      substrings: [],
    });
  });

  test('loose words become stems around the phrases', () => {
    expect(parseQuery('трактирщица «Гуся» братом')).toEqual({ terms: ['трактирщиц', 'брат'], phrases: [['гуся']], substrings: [] });
  });

  test('an unclosed quote reads as loose words', () => {
    expect(parseQuery('брата «старый караван')).toEqual({ terms: ['брат', 'стар', 'караван'], phrases: [], substrings: [] });
    expect(parseQuery('"brothers')).toEqual({ terms: ['brother'], phrases: [], substrings: [] });
    expect(parseQuery('“тот” ”этот”')).toEqual({ terms: ['этот'], phrases: [['тот']], substrings: [] }); // a closing quote alone opens nothing
  });

  test('stop words are dropped from loose words only', () => {
    expect([...STOP_WORDS]).toEqual(['и', 'в', 'на', 'по', 'как', 'the', 'a', 'of']);
    expect(parseQuery('как звали брата').terms).toEqual(['звал', 'брат']);
    expect(parseQuery('The keeper of a tavern').terms).toEqual(['keeper', 'tavern']);
    expect(parseQuery('«в пути» и по дороге')).toEqual({ terms: ['дорог'], phrases: [['в', 'пути']], substrings: [] });
  });

  test('a query of stop words only keeps them', () => {
    expect(parseQuery('как')).toEqual({ terms: ['как'], phrases: [], substrings: [] });
    expect(parseQuery('и в на')).toEqual({ terms: ['и', 'в', 'на'], phrases: [], substrings: [] });
    expect(parseQuery('the of the')).toEqual({ terms: ['the', 'of'], phrases: [], substrings: [] });
    // A phrase is something else left: the stop words go.
    expect(parseQuery('как «звали»')).toEqual({ terms: [], phrases: [['звали']], substrings: [] });
  });

  test('duplicates collapse: equal stems, equal phrases, equal substrings', () => {
    expect(parseQuery('брат брата Братом «a b» "A B" 東京 東京')).toEqual({ terms: ['брат'], phrases: [['a', 'b']], substrings: ['東京'] });
  });

  test('spaceless-script words are substrings, loose or quoted', () => {
    expect(parseQuery('東京 tower')).toEqual({ terms: ['tower'], phrases: [], substrings: ['東京'] });
    expect(parseQuery('«big 東京 tower»')).toEqual({ terms: [], phrases: [['big'], ['tower']], substrings: ['東京'] });
  });

  test('nothing searchable: an empty query', () => {
    expect(parseQuery('')).toEqual({ terms: [], phrases: [], substrings: [] });
    expect(parseQuery(' «» "" — !')).toEqual({ terms: [], phrases: [], substrings: [] });
  });
});

describe('matchQuery', () => {
  const text = 'Марта, трактирщица «Гуся». Её брат пропал с караваном.';

  test('AND over stems; first is the earliest match in the original text', () => {
    const m = matchQuery(parseQuery('брата трактирщицы'), text);
    expect(m.all).toBe(true);
    expect(m.matched).toBe(2);
    expect(text.slice(...(m.first as [number, number]))).toBe('трактирщица');
  });

  test('partial matches count, all is false', () => {
    const m = matchQuery(parseQuery('караван кузнец'), text);
    expect(m).toMatchObject({ all: false, matched: 1 });
    expect(text.slice(...(m.first as [number, number]))).toBe('караваном');
    expect(matchQuery(parseQuery('кузнец'), text)).toEqual({ all: false, matched: 0, first: null });
  });

  test('a phrase needs its words in a row, folded and unstemmed', () => {
    const m = matchQuery(parseQuery('«её брат»'), text);
    expect(m.all).toBe(true);
    expect(text.slice(...(m.first as [number, number]))).toBe('Её брат');
    expect(matchQuery(parseQuery('«брат её»'), text).all).toBe(false);
    expect(matchQuery(parseQuery('«брата»'), text).all).toBe(false); // no stemming inside quotes
    expect(matchQuery(parseQuery('«брат пропал с караваном»'), text).all).toBe(true);
    expect(matchQuery(parseQuery('«брат с караваном»'), text).all).toBe(false);
  });

  test('a stress mark in the text does not hide the word', () => {
    const t = 'Ми\u0301ра ушла.';
    const m = matchQuery(parseQuery('Мирой'), t);
    expect(m.all).toBe(true);
    expect(t.slice(...(m.first as [number, number]))).toBe('Ми\u0301ра');
  });

  test('substrings inside spaceless runs, with offsets', () => {
    const t = 'He said 東京タワーへ行く, then left.';
    const m = matchQuery(parseQuery('タワー said'), t);
    expect(m).toMatchObject({ all: true, matched: 2 });
    expect(t.slice(...(m.first as [number, number]))).toBe('said');
    const only = matchQuery(parseQuery('タワー'), t);
    expect(t.slice(...(only.first as [number, number]))).toBe('タワー');
  });

  test('words passed in are used as given (callers cache them)', () => {
    const words = wordsOf(text);
    expect(matchQuery(parseQuery('брат'), 'ignored', words).all).toBe(true);
  });

  test('an empty query matches nothing', () => {
    expect(matchQuery(parseQuery(''), text)).toEqual({ all: false, matched: 0, first: null });
  });
});

describe('stemKeyMatches and prepared stem keys', () => {
  const text = 'Levi: Я видел брата Алексея у каравана. Мирой звали его сестру. 東京タワーの下で';
  const words = wordsOf(text);
  const folded = foldText(text);
  const both = (key: string): boolean => {
    const a = stemKeyMatches(key, words, folded);
    const k = compileStemKey(key);
    const b = k !== null && matchStemKey(k, stemText(text));
    expect([key, b]).toEqual([key, a]);
    return a;
  };

  test('one-word keys by stem, case-free', () => {
    expect(both('брат')).toBe(true);
    expect(both('БРАТОМ')).toBe(true);
    expect(both('Мира')).toBe(true);
    expect(both('караван')).toBe(true);
    expect(both('братство')).toBe(false);
    expect(both('мирный')).toBe(false);
  });

  test('several words: in a row, each by stem', () => {
    expect(both('Брат Алексей')).toBe(true);
    expect(both('брат, Алексей!')).toBe(true); // punctuation in the key is not a word
    expect(both('Алексей брат')).toBe(false);
    expect(both('брат каравана')).toBe(false);
  });

  test('a spaceless-script key is a folded substring', () => {
    expect(both('タワー')).toBe(true);
    expect(both('東京タワー')).toBe(true);
    expect(both('大阪')).toBe(false);
  });

  test('a key with no words never matches', () => {
    expect(compileStemKey(' — ')).toBeNull();
    expect(stemKeyMatches('', words, folded)).toBe(false);
    expect(stemKeyMatches('!!!', words, folded)).toBe(false);
  });

  test('extendStemText(head, tail) equals stemText(head + "\\n" + tail)', () => {
    const cases: [string, string][] = [
      ['Levi: брат Мира', 'Vera: брата Алексея'],
      ["Mira's tavern", "'s ΟΔΟΣ"], // no possessive across the newline; Greek final sigma on both sides
      ['', 'брат'],
      ['東京', 'タワー Ми\u0301ра'],
      ['ﬁ ½', '\u0301брат'],
    ];
    for (const [a, b] of cases) {
      const whole = stemText(`${a}\n${b}`);
      const ext = extendStemText(stemText(a), b);
      expect({ ...ext, at: [...ext.at] }).toEqual({ ...whole, at: [...whole.at] });
    }
  });

  test('a multi-word key anchors on its rarest stem, and still needs the words in a row', () => {
    const t = stemText('брат брат брат Алексей брат');
    expect(matchStemKey(compileStemKey('брат Алексей') as StemKey, t)).toBe(true);
    expect(matchStemKey(compileStemKey('Алексей брат') as StemKey, t)).toBe(true);
    expect(matchStemKey(compileStemKey('брат брат Алексей') as StemKey, t)).toBe(true);
    expect(matchStemKey(compileStemKey('Алексей Алексей') as StemKey, t)).toBe(false);
    expect(matchStemKey(compileStemKey('Алексей брат брат') as StemKey, t)).toBe(false);
    expect(matchStemKey(compileStemKey('сестра') as StemKey, t)).toBe(false);
  });

  test('stemText indexes every word by stem', () => {
    const t = stemText('брат и брата, и братом');
    expect(t.at.get('брат')).toEqual([0, 2, 4]);
    expect(t.at.get('и')).toEqual([1, 3]);
    expect(t.folded).toBe('брат и брата, и братом');
    expect(t.length).toBe(22);
  });
});
