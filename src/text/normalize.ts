// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One definition of a word for search, lore keys and stemming (ARCHITECTURE.md §7.5, D-46).
// M2 needs only the word-character class and the lore key boundary; M3 adds normalizeTerm (NFKC,
// lower case, ё→е, stop words, ~40 endings, «…» and “…” phrases) to this file.
// CONTRACT FILE: signatures are fixed; the lore agent implements the bodies.
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
