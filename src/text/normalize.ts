// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One definition of a word for search, lore keys and stemming (ARCHITECTURE.md §7.5, D-46).
// M2: the word-character class and the lore key boundary. M3: normalizeTerm and the query
// grammar (NFKC, lower case, ё→е, stop words, an own list of Russian endings, «…» “…” "…" phrases).
// No Snowball code and no dependency: the ending list is written for this project (§7.5).
// CONTRACT FILE: signatures are fixed; the M2 lore agent and the M3 text agent implement the bodies.
//
// The word-character rule follows Bunraku src/core/lore/engine/key-word-boundary.ts@702d8120
// (fresh code, the rule only): letters, digits and combining marks, so an NFD accent or a
// decomposed й never splits a word; '_' joins in at lore key boundaries, as in ST's ASCII \W.

/** A word character for search and stemming: letters, digits and combining marks [D-46]. */
export const WORD_CHAR_CLASS = '\\p{L}\\p{N}\\p{M}';

/** A word character at a lore key boundary: WORD_CHAR_CLASS plus '_', as in ST [D-46]. */
export const LORE_WORD_CHAR_CLASS = '\\p{L}\\p{N}\\p{M}_';

/** Scripts written without spaces between words, by script extension (regex class body, 'u' flag). */
export const SPACELESS_SCRIPT_CLASS = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}';

const LORE_WORD_CHAR_RE = new RegExp(`^[${LORE_WORD_CHAR_CLASS}]$`, 'u');
const SPACELESS_CHAR_RE = new RegExp(`^[${SPACELESS_SCRIPT_CLASS}]$`, 'u');
const SPACELESS_RE = new RegExp(`(?=[${WORD_CHAR_CLASS}])[${SPACELESS_SCRIPT_CLASS}]`, 'u');

/** True when `ch` (one code point) is a lore word character. */
export function isLoreWordChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined || ch.length !== (cp > 0xffff ? 2 : 1)) return false;
  // ASCII without a regex: [A-Za-z0-9_].
  if (cp < 128) return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
  return LORE_WORD_CHAR_RE.test(ch);
}

/**
 * True when `ch` (one code point) glues onto a whole-word lore key: a lore word character that is
 * not of a spaceless script. Running CJK or Thai text has no gaps, so its letters cannot be a key's
 * edge: 'cat' still matches inside '龍cat城' (as in Bunraku, and as ST's \W did).
 * A per-character check, not a regex lookbehind: JavaScriptCore's lookbehind reads one UTF-16 unit
 * of a surrogate pair, so (?<![\p{L}])a wrongly matches after U+10400 under Bun.
 */
export function gluesToLoreKey(ch: string): boolean {
  if (!isLoreWordChar(ch)) return false;
  return ch.charCodeAt(0) < 128 || !SPACELESS_CHAR_RE.test(ch);
}

/** The code point (as a string) ending right before UTF-16 index `end`, '' at the start. A surrogate pair is read whole. */
export function charBefore(text: string, end: number): string {
  if (end <= 0) return '';
  const low = text.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(end - 2, end);
  }
  return text.slice(end - 1, end);
}

/** The code point (as a string) starting at UTF-16 index `start`, '' at the end. */
export function charAt(text: string, start: number): string {
  const cp = text.codePointAt(start);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * True when `text` contains a letter of a script written without spaces between words (Han,
 * Hiragana, Katakana, Thai). Whole-word keys in such scripts match as plain substrings, as in
 * Bunraku; a word boundary inside running CJK text would never be found [D-46].
 */
export function hasSpacelessScript(text: string): boolean {
  return SPACELESS_RE.test(text);
}

// ---- M3: terms and queries (§7.5, D-46) ---------------------------------------------------------
//
// Fresh code. The pieces:
// - foldText: NFKC, lower case, ё→е, U+0300–U+036F dropped. Applied per word, so offsets stay in
//   the original text.
// - normalizeTerm: foldText, then a stem (see RU_ENDINGS and stemLatin for what is cut).
// - wordsOf: words found code point by code point; a run of a spaceless script is one word.
// - parseQuery / matchQuery: loose words match by stem, quoted phrases by folded words in a row,
//   spaceless-script words by substring.
// - stemKeyMatches (and compileStemKey / stemText / matchStemKey for the lore engine): a lore key
//   whose words appear in a row with equal stems.

/**
 * D-46: words dropped from a query before the AND (never from the searched text). Exactly this
 * list; a query made only of stop words keeps them (searching for "the" still works).
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(['и', 'в', 'на', 'по', 'как', 'the', 'a', 'of']);

const COMBINING_RE = /[\u0300-\u036f]/g;
const ASCII_RE = /^[\x00-\x7f]*$/;

/**
 * Fold text for comparison: NFKC, locale-free lower case, ё→е, and the combining diacritics
 * U+0300–U+036F dropped (a stress mark must not split or change a word; letters that NFKC composes,
 * such as й, are already single code points by then). Length may change: use wordsOf for offsets.
 */
export function foldText(text: string): string {
  // ASCII is its own NFKC and has no ё or combining marks.
  if (ASCII_RE.test(text)) return text.toLowerCase();
  // Marks are dropped after lower-casing: 'İ' lower-cases to 'i' + U+0307.
  return text.normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(COMBINING_RE, '');
}

/**
 * Russian endings (folded, so ё is е), cut by normalizeTerm: the longest one that leaves ≥ 3 letters.
 * Classes:
 * - case endings of nouns, singular and plural: а я о е у ю ы и ь й, ам ям ах ях ом ем ой ей ою ею
 *   ов ев, ами ями, and the -ия/-ие/-ья/-ье nouns (ия ию ья ье ью);
 * - adjective and participle endings: ий ый ая яя ое ее ые ие ую юю их ых ым им, ого его ому ему
 *   ыми ими;
 * - only those verb endings no noun ends in: reflexive -ться -тся -лся -лась -лось -лись. Not -ть
 *   (радость → радос, радости → радост), -ся (Маруся), nor ет/ит/ат/ут/ют (совет → сов, but
 *   советом → совет): each of those breaks nouns.
 */
const RU_ENDINGS: readonly string[] = [
  'ться', 'лась', 'лось', 'лись',
  'тся', 'лся', 'ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
  'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ой', 'ей', 'ою', 'ею', 'ов', 'ев',
  'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'их', 'ых', 'ым', 'им',
  'ия', 'ию', 'ья', 'ье', 'ью',
  'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й',
];
/** RU_ENDINGS by length, longest first. */
const RU_BY_LENGTH: readonly [number, ReadonlySet<string>][] = [4, 3, 2, 1].map((n): [number, ReadonlySet<string>] => [n, new Set(RU_ENDINGS.filter((e) => e.length === n))]);
/** What a stem may still end in after the ending is cut (the stem's tail, see stemRussian). */
const RU_TAIL_VOWELS = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я', 'ь', 'й']);

/**
 * Function words that would meet a short name or noun cut down to three letters (Надя/Нади/Надей →
 * над, Вася → вас, Тёма → тем, Тома → том): prepositions and pronoun forms, folded. Each gets
 * FUNCTION_WORD_MARK after it as its stem, which no cut can produce (a stem is a prefix of a word,
 * and the mark is no word character), so it meets only itself. A closed list: each was checked for a
 * form of its own word that it would now split from. Left out for that reason: был (была → был),
 * сам (сама → сам). Split on purpose (rare beside the function word): том the noun 'volume' from
 * тома/томом, ком 'lump' from комом, and the name Тома's accusative Тому from Тома (it is spelt as
 * the pronoun тому). чем/чему, кем/кому, вам/вами … are forms of one pronoun that no longer meet:
 * nobody searches for them.
 */
const RU_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'над', 'надо', 'под', 'подо',
  'вас', 'вам', 'вами', 'нас', 'нам', 'нами',
  'тем', 'том', 'тому', 'чем', 'чему', 'кем', 'ком', 'кому',
  'ним', 'них', 'ней',
]);
/** Marks a function word's stem (see RU_FUNCTION_WORDS): a control character no word holds. */
export const FUNCTION_WORD_MARK = '\u0001';

const CYRILLIC_WORD_RE = /^\p{Script=Cyrillic}+$/u;
const LATIN_WORD_RE = /^\p{Script=Latin}+(?:['’]s)?$/u;
const EDGE_RE = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;

/**
 * A Russian stem (the word folded, Cyrillic letters only):
 * 0. a function word of RU_FUNCTION_WORDS: the word and FUNCTION_WORD_MARK (it meets only itself);
 * 1. ≥ 4 letters: cut the longest ending of RU_ENDINGS that leaves ≥ 3 letters;
 * 2. then, while ≥ 3 letters would remain, cut a vowel, ь or й the stem still ends in, or a final
 *    -ов/-ев. Step 2 makes the forms of one word meet where an ending eats into the stem:
 *    герой/героя/героем → гер, Алексей/Алексея/Алексеем → алекс, Дмитрий/Дмитрии → дмитр,
 *    братья/братьев → брат, Петров/Петрова → петр, остров/острова → остр.
 * Required pairs: караван/каравана/караваном, Мира/Миру/Мирой → мир, трактирщица/трактирщицу,
 * брат/брата/братом. Apart: брат ≠ братства (братств), мир ≠ мирный (мирн); Надя ≠ над/надо,
 * Вася ≠ вас, Тёма ≠ тем, Тома ≠ том/тому (step 0).
 * Known misses (no dictionary, by design): fleeting vowels and alternations (отец/отца,
 * сестра/сестёр, друг/друзья, любовь/любви); words of 3 letters never change (Аня/Ани, чай/чая,
 * ёж/ежа); -мя nouns (имя/имени, время/времени, пламя/пламени); verbs beyond the reflexive endings.
 * Known false merges, pinned in test/fixtures/ru/normalize-terms.json 'merges' so a change shows:
 * - homographs: Иван/Иванов, любой/любовь, рост/Ростов, радио/рад;
 * - a short name and a content word cut to the same three or four letters: Мила/милый,
 *   Костя/кость, Соня/сон, Женя/жена, Коля/кол, Рома/ром, Дарья/дар, Лина/линия, Гера/герой, and
 *   names whose stem is a very common word, so a note keyed by the bare name fires on ordinary
 *   prose: Света/свет ('light'), Люда/люди ('people'), Люба/любой/любовь (key such a note with
 *   the full name, a quoted phrase or a '/regex/' key);
 * - step 2 cuts into another word's stem: королева/король (корол), голова/голая (гол),
 *   корова/кора, статуя/статья, соловей/соль, Пётр/Петра/Петров, Львов/льва, Андреев/Андрей,
 *   месть/место, сталь/стал.
 * The escape hatches: a '/regex/' key in a stem book (lore/keys.ts) and quotes in a search (a
 * quoted phrase matches folded words, unstemmed).
 */
function stemRussian(w: string): string {
  if (RU_FUNCTION_WORDS.has(w)) return w + FUNCTION_WORD_MARK;
  if (w.length < 4) return w;
  let s = w;
  for (const [n, set] of RU_BY_LENGTH) {
    if (s.length - n >= 3 && set.has(s.slice(-n))) {
      s = s.slice(0, -n);
      break;
    }
  }
  while (s.length > 3) {
    if (RU_TAIL_VOWELS.has(s.charAt(s.length - 1))) s = s.slice(0, -1);
    else if (s.length > 4 && (s.endsWith('ов') || s.endsWith('ев'))) s = s.slice(0, -2);
    else break;
  }
  return s;
}

/**
 * An English stem (the word folded, Latin letters only): a possessive 's / ’s is cut; then, for
 * ≥ 4 letters, the plural: -ies → -i, else -s unless the word ends in -ss, -us or -is; then, if ≥ 4
 * letters are left, a final -e after s, x, z, ch, sh or o is cut (the -es plurals: -oes too, so
 * hero/heroes and potato/potatoes meet, and shoe/shoes as sho), -ie becomes -i and a final -y becomes
 * -i, so singular and plural meet: tavern/taverns/tavern's, horse/horses, box/boxes, glass/glasses,
 * dish/dishes, church/churches, party/parties, movie/movies; plain -e words meet their plurals
 * through the -s cut (stone/stones, place/places).
 * Any other final -e stays, so a short word never meets its -e neighbour: Sam ≠ same, Tim ≠ time,
 * Don ≠ done, Ann ≠ Anne, her ≠ here, not ≠ note, plan ≠ plane.
 * Known misses: irregular plurals (man/men, knife/knives, wolf/wolves), plurals of -us/-is
 * (virus/viruses is fine, analysis/analyses is not), short words (cry/cries), verb forms
 * (kiss/kissed, walk/walking). Known false merge: Mary/Marie (both mari).
 */
function stemLatin(w: string): string {
  let s = w;
  if (s.endsWith("'s") || s.endsWith('’s')) s = s.slice(0, -2);
  if (s.length < 4) return s;
  if (s.endsWith('ies') && s.length - 2 >= 3) s = `${s.slice(0, -3)}i`;
  else if (s.endsWith('s') && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length >= 4) {
    if (/(?:s|x|z|ch|sh|i|o)e$/.test(s)) s = s.slice(0, -1);
    else if (s.endsWith('y')) s = `${s.slice(0, -1)}i`;
  }
  return s;
}

/** The stem of a word that is already folded. */
function stemFolded(w: string): string {
  if (CYRILLIC_WORD_RE.test(w)) return stemRussian(w);
  if (LATIN_WORD_RE.test(w)) return stemLatin(w);
  // Digits, mixed scripts, other scripts: the folded word itself.
  return w;
}

/**
 * The stem of one word (§7.5 steps 1–3): foldText, punctuation at the edges ignored, then
 * - Cyrillic word of ≥ 4 letters: the longest ending of the project's list (RU_ENDINGS: noun,
 *   adjective and a few safe verb endings) that leaves ≥ 3 letters, then the stem's tail
 *   (stemRussian: a final vowel, ь, й, -ов or -ев while ≥ 3 letters remain);
 * - Latin word of ≥ 4 letters: "'s", then "-s" / "-es" / "-ies", then a final -e after s, x, z,
 *   ch, sh, i or o, or a final -y (stemLatin);
 * - anything else (digits, mixed or other scripts): the folded word.
 * - a Russian function word that a cut name could meet (над, вас, тем, том …): its own marked stem;
 * Required pairs (tests): караван/каравана/караваном; Мира/Миру/Мирой (→ мир); трактирщица/
 * трактирщицу; брат/брата/братом; ёж/еж. Must stay apart: брат ≠ братства, мир ≠ мирный.
 */
export function normalizeTerm(word: string): string {
  return stemFolded(foldText(word).replace(EDGE_RE, ''));
}

/** One word of a text: its folded form, its stem, and where it sits in the ORIGINAL text (UTF-16). */
export interface Word {
  norm: string;
  stem: string;
  start: number;
  end: number;
}

// Character kinds for wordsOf.
const NOT_WORD = 0;
const LETTER = 1; // a letter or digit
const SPACELESS = 2; // a letter of a spaceless script
const MARK = 3; // a combining mark: it stays with the word it follows

const LETTER_RE = /^[\p{L}\p{N}]$/u;
const MARK_RE = /^\p{M}$/u;
const LATIN_LETTER_RE = /^\p{Script=Latin}$/u;
/** A folded word that NFKC turned into several (e.g. '½' → '1⁄2'): split again at non-word characters. */
const FOLDED_SPLIT_RE = /[^\p{L}\p{N}\p{M}'’]+/u;

function kindOf(cp: number, ch: string): number {
  if (cp < 128) return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) ? LETTER : NOT_WORD;
  // Basic Cyrillic letters, the common case for this project.
  if (cp >= 0x0400 && cp <= 0x045f) return LETTER;
  if (LETTER_RE.test(ch)) return SPACELESS_CHAR_RE.test(ch) ? SPACELESS : LETTER;
  if (MARK_RE.test(ch)) return MARK;
  return NOT_WORD;
}

/** The folded words (norm, stem) one run of the text gives: usually one, none for marks only. */
function foldRun(run: string, spaceless: boolean): [string, string][] {
  const norm = foldText(run);
  if (norm === '') return []; // only combining marks
  const pieces = FOLDED_SPLIT_RE.test(norm) ? norm.split(FOLDED_SPLIT_RE).filter((p) => p !== '') : [norm];
  return pieces.map((p) => [p, spaceless ? p : stemFolded(p)]);
}

/**
 * The words of a text: maximal runs of WORD_CHAR_CLASS characters, found character by character
 * (no lookbehind, surrogate pairs read whole), each folded and stemmed. A run in a spaceless script
 * is one word (it matches by substring, see matchQuery).
 * Details: a run also ends where spaceless and other letters meet ('龍cat城' is 龍, cat, 城); a
 * combining mark stays with the letter before it; an English possessive 's / ’s after a Latin
 * letter belongs to the word (normalizeTerm then cuts it).
 */
export function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  // Words repeat: fold and stem each distinct run once per call.
  const seen = new Map<string, [string, string][]>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    const cp = text.codePointAt(i) as number;
    const w = cp > 0xffff ? 2 : 1;
    const kind = kindOf(cp, w === 1 ? (text[i] as string) : text.slice(i, i + 2));
    if (kind === NOT_WORD) {
      i += w;
      continue;
    }
    const start = i;
    const spaceless = kind === SPACELESS || (kind === MARK && SPACELESS_CHAR_RE.test(text.slice(i, i + w)));
    i += w;
    while (i < n) {
      const c = text.codePointAt(i) as number;
      const cw = c > 0xffff ? 2 : 1;
      const k = kindOf(c, cw === 1 ? (text[i] as string) : text.slice(i, i + 2));
      if (k === NOT_WORD) break;
      // A mark stays with the run; letters end it where spaceless and other scripts meet.
      if (k !== MARK && (k === SPACELESS) !== spaceless) break;
      i += cw;
    }
    let end = i;
    if (!spaceless && (text[end] === "'" || text[end] === '’') && (text[end + 1] === 's' || text[end + 1] === 'S')) {
      const after = text.codePointAt(end + 2);
      const afterKind = after === undefined ? NOT_WORD : kindOf(after, String.fromCodePoint(after));
      if (afterKind === NOT_WORD && LATIN_LETTER_RE.test(charBefore(text, end))) end += 2;
    }
    const run = text.slice(start, end);
    let folded = seen.get(run);
    if (folded === undefined) seen.set(run, (folded = foldRun(run, spaceless)));
    for (const [norm, stem] of folded) out.push({ norm, stem, start, end });
    i = end;
  }
  return out;
}

/** A parsed query. */
export interface Query {
  /** Stems of the loose words, stop words dropped (unless nothing else is left), deduplicated, in order. */
  terms: string[];
  /** Quoted phrases ("…", «…», “…”): folded words, matched consecutively and without stemming. */
  phrases: string[][];
  /** The folded loose words and phrase words written in a spaceless script: matched as substrings. */
  substrings: string[];
}

/** Opening quote → its closing quote. */
const QUOTES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ['«', '»'],
  ['“', '”'],
]);

/**
 * Parse a query (the model's or the user's): phrases first, then the loose words. An unclosed quote reads as loose words.
 * A phrase is cut where a spaceless-script word sits: those words become substrings and the words
 * around them separate phrases (rare; a phrase of one script is one phrase). Stop words are looked
 * up by folded form and only among loose words; a phrase keeps every word.
 */
export function parseQuery(q: string): Query {
  const phrases: string[][] = [];
  const substrings: string[] = [];
  let loose = '';
  let i = 0;
  while (i < q.length) {
    const ch = q[i] as string;
    const close = QUOTES.get(ch);
    const j = close === undefined ? -1 : q.indexOf(close, i + 1);
    if (j < 0) {
      // Not a quote, or an unclosed one: the opener is a separator like any punctuation.
      loose += ch;
      i++;
      continue;
    }
    let run: string[] = [];
    for (const w of wordsOf(q.slice(i + 1, j))) {
      if (hasSpacelessScript(w.norm)) {
        if (run.length > 0) phrases.push(run);
        run = [];
        substrings.push(w.norm);
      } else run.push(w.norm);
    }
    if (run.length > 0) phrases.push(run);
    loose += ' ';
    i = j + 1;
  }

  const terms: string[] = [];
  const stops: string[] = [];
  for (const w of wordsOf(loose)) {
    if (hasSpacelessScript(w.norm)) substrings.push(w.norm);
    else if (STOP_WORDS.has(w.norm)) stops.push(w.stem);
    else terms.push(w.stem);
  }
  const keepStops = terms.length === 0 && phrases.length === 0 && substrings.length === 0;
  const seenPhrase = new Set<string>();
  return {
    terms: [...new Set(keepStops ? stops : terms)],
    phrases: phrases.filter((p) => {
      const id = p.join('\u0000');
      if (seenPhrase.has(id)) return false;
      seenPhrase.add(id);
      return true;
    }),
    substrings: [...new Set(substrings)],
  };
}

/** Where a query matched in one text: the first match of each term/phrase/substring, by query part. */
export interface QueryMatch {
  /** Every part of the query matched (AND). */
  all: boolean;
  /** How many distinct parts matched (terms + phrases + substrings). */
  matched: number;
  /** [start, end) in the original text of the earliest match, for a snippet; null when none. */
  first: [number, number] | null;
}

/** Index of the first run of words whose `field` equals `seq` in order; -1 when none. */
function findRun(words: readonly Word[], seq: readonly string[], field: 'norm' | 'stem'): number {
  const n = seq.length;
  if (n === 0) return -1;
  const head = seq[0] as string;
  outer: for (let i = 0; i + n <= words.length; i++) {
    if ((words[i] as Word)[field] !== head) continue;
    for (let k = 1; k < n; k++) if ((words[i + k] as Word)[field] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Where each part of a query first matches in `words`, in part order (terms, phrases, substrings);
 * null for a part that does not match.
 */
export function locateQuery(query: Query, words: readonly Word[]): ([number, number] | null)[] {
  const out: ([number, number] | null)[] = [];
  for (const t of query.terms) {
    const i = findRun(words, [t], 'stem');
    out.push(i < 0 ? null : [(words[i] as Word).start, (words[i] as Word).end]);
  }
  for (const p of query.phrases) {
    const i = findRun(words, p, 'norm');
    out.push(i < 0 ? null : [(words[i] as Word).start, (words[i + p.length - 1] as Word).end]);
  }
  for (const s of query.substrings) {
    let at: [number, number] | null = null;
    for (const w of words) {
      const k = w.norm.indexOf(s);
      if (k < 0) continue;
      // Exact offsets when folding kept the word's length (the usual case), else the whole word.
      at = w.end - w.start === w.norm.length ? [w.start + k, w.start + k + s.length] : [w.start, w.end];
      break;
    }
    out.push(at);
  }
  return out;
}

/**
 * Match a query against a text (its words from wordsOf, passed in so callers can cache them).
 * An empty query (no parts) matches nothing: all false, matched 0.
 */
export function matchQuery(query: Query, text: string, words?: readonly Word[]): QueryMatch {
  const located = locateQuery(query, words ?? wordsOf(text));
  let matched = 0;
  let first: [number, number] | null = null;
  for (const at of located) {
    if (at === null) continue;
    matched++;
    if (first === null || at[0] < first[0] || (at[0] === first[0] && at[1] > first[1])) first = at;
  }
  return { all: located.length > 0 && matched === located.length, matched, first };
}

/** A lore key prepared for stem matching: the stems of its words, or a folded substring for a spaceless-script key. */
export interface StemKey {
  stems: string[];
  substring: string | null;
}

/** A scan text prepared for stem keys (build once per text, reuse across entries). */
export interface StemText {
  words: readonly Word[];
  folded: string;
  /** Stem → indexes of the words with that stem, ascending. */
  at: ReadonlyMap<string, readonly number[]>;
  /** Length of the text (UTF-16), for extendStemText. */
  length: number;
}

/** Prepare a key for matchStemKey; null when it has no words (it never matches). */
export function compileStemKey(key: string): StemKey | null {
  if (hasSpacelessScript(key)) {
    const substring = foldText(key.trim());
    return substring === '' ? null : { stems: [], substring };
  }
  const stems = wordsOf(key).map((w) => w.stem);
  return stems.length === 0 ? null : { stems, substring: null };
}

function indexStems(words: readonly Word[]): Map<string, number[]> {
  const at = new Map<string, number[]>();
  words.forEach((w, i) => {
    const list = at.get(w.stem);
    if (list) list.push(i);
    else at.set(w.stem, [i]);
  });
  return at;
}

/** Prepare a scan text for matchStemKey. */
export function stemText(text: string): StemText {
  const words = wordsOf(text);
  return { words, folded: foldText(text), at: indexStems(words), length: text.length };
}

/**
 * stemText(head + '\n' + tail), reusing head's words: a newline ends every word and stops NFKC
 * and casing context, so the words and the folding of the two sides are independent. The lore
 * engine's texts grow so (a deeper scan, each recursion loop).
 */
export function extendStemText(head: StemText, tail: string): StemText {
  const offset = head.length + 1;
  const more = wordsOf(tail).map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }));
  const words = head.words.concat(more);
  return { words, folded: `${head.folded}\n${foldText(tail)}`, at: indexStems(words), length: offset + tail.length };
}

/** A prepared key against a prepared text (stemKeyMatches with an index). */
export function matchStemKey(key: StemKey, text: StemText): boolean {
  if (key.substring !== null) return text.folded.includes(key.substring);
  // Anchor on the key's rarest stem; a stem the text lacks settles it at once.
  let anchor = 0;
  let where: readonly number[] = [];
  for (let j = 0; j < key.stems.length; j++) {
    const list = text.at.get(key.stems[j] as string);
    if (list === undefined) return false;
    if (j === 0 || list.length < where.length) {
      anchor = j;
      where = list;
    }
  }
  outer: for (const p of where) {
    const i = p - anchor;
    if (i < 0) continue;
    for (let k = 0; k < key.stems.length; k++) if (text.words[i + k]?.stem !== key.stems[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Stem-mode lore key match (§5.8 notes, LoreBook.match 'stem'): the key's words (wordsOf) must
 * appear as consecutive words of the text with equal stems; a key in a spaceless script matches as a
 * folded substring. Case-insensitive by construction; wholeWords does not apply.
 */
export function stemKeyMatches(key: string, textWords: readonly Word[], foldedText: string): boolean {
  const k = compileStemKey(key);
  if (k === null) return false;
  if (k.substring !== null) return foldedText.includes(k.substring);
  return findRun(textWords, k.stems, 'stem') >= 0;
}
