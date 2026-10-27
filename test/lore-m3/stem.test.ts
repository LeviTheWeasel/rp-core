// M3 lore: books with match 'stem' (lore/keys.ts, lore/engine.ts; ARCHITECTURE.md §5.8 notes, §10.3
// step 4), plus a timing check over a long chat.
import { describe, expect, test } from 'bun:test';
import { KeyMatcher } from '../../src/lore/keys.ts';
import { entry, ids, runBook, verdict, whys } from '../lore/fixtures.ts';

const STEM = { match: 'stem' } as const;

describe('stem books in the engine', () => {
  test("'брат' fires on 'брата' and 'братом', not on 'братства'", () => {
    const e = [entry('e', { keys: ['брат'] })];
    expect(whys(runBook(e, ['Levi: я видел брата'], {}, STEM))).toEqual({ e: '+key' });
    expect(whys(runBook(e, ['Levi: с братом'], {}, STEM))).toEqual({ e: '+key' });
    expect(whys(runBook(e, ['Levi: клятва братства'], {}, STEM))).toEqual({ e: '-no-key-match' });
  });

  test("'Мира' fires on 'Мирой', not on 'мирный'", () => {
    const e = [entry('e', { keys: ['Мира'] })];
    expect(whys(runBook(e, ['Vera: любуюсь Мирой'], {}, STEM))).toEqual({ e: '+key' });
    expect(whys(runBook(e, ['Vera: мирный день'], {}, STEM))).toEqual({ e: '-no-key-match' });
  });

  test('the matched list names the key as written', () => {
    const res = runBook([entry('e', { keys: ['Брат', 'сестра', 'Мира'] })], ['Levi: брата и Мирой'], {}, STEM);
    expect(res.fired[0]).toMatchObject({ why: 'key', matched: ['Брат', 'Мира'] });
  });

  test('a key of several words: its words in a row, each by stem', () => {
    const e = [entry('e', { keys: ['Брат Алексей'] })];
    expect(whys(runBook(e, ['Levi: позовите брата Алексея'], {}, STEM))).toEqual({ e: '+key' });
    expect(whys(runBook(e, ['Levi: брат, Алексей, иди сюда'], {}, STEM))).toEqual({ e: '+key' }); // punctuation is not a word
    expect(whys(runBook(e, ['Levi: Алексей и брат'], {}, STEM))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook(e, ['Levi: брат и Алексей'], {}, STEM))).toEqual({ e: '-no-key-match' });
  });

  test("a '/regex/' key in a stem book stays a regex (no stemming)", () => {
    const e = [entry('e', { keys: ['/карав[аы]н$/m'] })];
    expect(whys(runBook(e, ['Levi: наш караван'], {}, STEM))).toEqual({ e: '+key' });
    expect(whys(runBook(e, ['Levi: у каравана'], {}, STEM))).toEqual({ e: '-no-key-match' });
  });

  test('a regex key re2js refuses falls back to a stem key and reports its error', () => {
    const res = runBook([entry('e', { keys: ['/(?<=у )каравана/'] })], ['Levi: мы шли у каравану'], {}, STEM);
    expect(whys(res)).toEqual({ e: '+key' }); // the pattern text read as words: «у», «каравана» by stem
    expect(res.regexErrors).toHaveLength(1);
    expect(res.regexErrors[0]).toMatchObject({ book: 'b', id: 'e', key: '/(?<=у )каравана/' });
  });

  test('secondary keys match by stem too', () => {
    const mk = (logic: 'and_any' | 'and_all' | 'not_any' | 'not_all') => entry(logic, { keys: ['брат'], secondary: ['Мира', 'караван'], logic });
    const res = runBook([mk('and_any'), mk('and_all'), mk('not_any'), mk('not_all')], ['Levi: братом и Мирой'], {}, STEM);
    expect(whys(res)).toEqual({ and_any: '+secondary', and_all: '-secondary-logic', not_any: '-secondary-logic', not_all: '+secondary' });
    expect(verdict(res, 'and_any').matched).toEqual(['брат', 'Мира']);
    const all = runBook([mk('and_all')], ['Levi: брату, Мире и каравану'], {}, STEM);
    expect(whys(all)).toEqual({ and_all: '+secondary' });
  });

  test('case and whole-word settings do not apply in a stem book', () => {
    const cased = [entry('e', { keys: ['БРАТ'], caseSensitive: true })];
    expect(whys(runBook(cased, ['Levi: брата'], {}, STEM))).toEqual({ e: '+key' });
    const loose = [entry('e', { keys: ['брат'], wholeWords: false })];
    expect(whys(runBook(loose, ['Levi: братства'], {}, { match: 'stem', wholeWords: false }))).toEqual({ e: '-no-key-match' });
  });

  test('a spaceless-script key is a substring in a stem book', () => {
    expect(whys(runBook([entry('e', { keys: ['タワー'] })], ['Levi: 東京タワーへ'], {}, STEM))).toEqual({ e: '+key' });
  });

  test('a literal book is untouched: no stems', () => {
    const e = [entry('e', { keys: ['караван'] })];
    expect(whys(runBook(e, ['Levi: у каравана']))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook(e, ['Levi: у каравана'], {}, { match: 'literal' }))).toEqual({ e: '-no-key-match' });
    expect(whys(runBook(e, ['Levi: наш караван']))).toEqual({ e: '+key' });
  });

  test('recursion text is matched by stem as well', () => {
    const res = runBook(
      [entry('gate', { keys: ['ключ'], content: 'ключ у брата Алексея' }), entry('woken', { keys: ['Брат Алексей'] })],
      ['Levi: где ключ?'],
      {},
      STEM,
    );
    expect(ids(res.fired)).toEqual(['gate', 'woken']);
    expect(res.fired[1]).toMatchObject({ why: 'recursion', loop: 1 });
  });

  test('a speaker name in the scan line is a word like any other', () => {
    expect(whys(runBook([entry('e', { keys: ['Мира'] })], ['Мира: привет'], {}, STEM))).toEqual({ e: '+key' });
  });
});

describe('short names and their neighbours (normalize.ts function words, the English -e rule)', () => {
  test("a note keyed 'Надя' fires on her forms, never on the preposition над/надо", () => {
    const e = [entry('n', { keys: ['Надя'] })];
    expect(whys(runBook(e, ['Марфа: склонилась над очагом'], {}, STEM))).toEqual({ n: '-no-key-match' });
    expect(whys(runBook(e, ['Марфа: надо бы дров принести'], {}, STEM))).toEqual({ n: '-no-key-match' });
    expect(whys(runBook(e, ['Марфа: позови Надю'], {}, STEM))).toEqual({ n: '+key' });
    expect(whys(runBook(e, ['Марфа: с Надей не спорят'], {}, STEM))).toEqual({ n: '+key' });
  });

  test("'Вася', 'Тёма' and 'Тома' stay away from вас, тем and том", () => {
    expect(whys(runBook([entry('v', { keys: ['Вася'] })], ['Марфа: я вас ждала'], {}, STEM))).toEqual({ v: '-no-key-match' });
    expect(whys(runBook([entry('t', { keys: ['Тёма'] })], ['Марфа: тем временем стемнело'], {}, STEM))).toEqual({ t: '-no-key-match' });
    expect(whys(runBook([entry('t', { keys: ['Тома'] })], ['Марфа: о том и речь'], {}, STEM))).toEqual({ t: '-no-key-match' });
    expect(whys(runBook([entry('t', { keys: ['Тома'] })], ['Марфа: спроси у Томы'], {}, STEM))).toEqual({ t: '+key' });
  });

  test("a note keyed 'Sam' never fires on 'same', 'Tim' never on 'time'", () => {
    expect(whys(runBook([entry('s', { keys: ['Sam'] })], ['Levi: It was the same old tavern.'], {}, STEM))).toEqual({ s: '-no-key-match' });
    expect(whys(runBook([entry('t', { keys: ['Tim'] })], ['Levi: Some time later the door opened.'], {}, STEM))).toEqual({ t: '-no-key-match' });
    expect(whys(runBook([entry('s', { keys: ['Sam'] })], ["Levi: That is Sam's horse."], {}, STEM))).toEqual({ s: '+key' });
    expect(whys(runBook([entry('h', { keys: ['horse'] })], ['Levi: The horses are tired.'], {}, STEM))).toEqual({ h: '+key' });
  });
});

describe('KeyMatcher in stem mode', () => {
  test('one matcher serves literal and stem books without mixing their compiled keys', () => {
    const m = new KeyMatcher();
    const text = 'Levi: у каравана';
    const literal = { caseSensitive: false, wholeWords: true };
    expect(m.match(['караван'], text, literal).matched).toEqual([]);
    expect(m.match(['караван'], text, { ...literal, match: 'stem' }).matched).toEqual(['караван']);
    expect(m.match(['караван'], text, literal).matched).toEqual([]);
    expect(m.match(['караван'], text, { ...literal, match: 'literal' }).matched).toEqual([]);
  });

  test('blank keys are skipped in stem mode too', () => {
    const m = new KeyMatcher();
    expect(m.match(['', '  ', '—'], 'Levi: — брат', { caseSensitive: false, wholeWords: true, match: 'stem' })).toEqual({ matched: [], regexErrors: [] });
  });
});

describe('timing', () => {
  test('200 messages × 100 stem keys stays well under 100 ms', () => {
    const words = ['караван', 'брат', 'Мира', 'трактирщица', 'дорога', 'ключ', 'сестра', 'город', 'река', 'огонь'];
    const forms = (w: string, i: number): string => [w, `${w}а`, `${w}ом`, `${w}у`][i % 4] as string;
    const scan: string[] = [];
    for (let i = 0; i < 200; i++) {
      const parts: string[] = [];
      for (let k = 0; k < 40; k++) parts.push(forms(words[(i * 7 + k) % words.length] as string, i + k), 'и', 'шёл', 'далее,');
      scan.push(`${i % 2 ? 'Мира' : 'Levi'}: ${parts.join(' ')}.`);
    }
    // 100 entries: keys that never fire (so every entry scans the whole text) and a few that do.
    const entries = Array.from({ length: 100 }, (_, i) =>
      entry(`e${i}`, { keys: i % 10 === 0 ? [words[i / 10] as string] : [`ключник${i}`, `Брат Алексей${i}`], secondary: i % 3 === 0 ? [`пустошь${i}`] : [] }),
    );
    const run = () => runBook(entries, scan, { explain: false }, { match: 'stem', scanDepth: 200 });
    run(); // warm-up: the JIT, regexes, Intl data
    const t0 = performance.now();
    const res = run();
    const ms = performance.now() - t0;
    expect(res.fired.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });
});
