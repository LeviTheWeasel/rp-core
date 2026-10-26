// Ported from RoleCall:apps/rc/src/lib/lorebook/triggers/keyword.ts@fb8dc623e (re2js for '/re/' keys,
// literal fallback, escaped literals on native RegExp), RoleCall:apps/rc/src/lib/lorebook/regex-utils.ts@fb8dc623e
// (parseRegexFromString, itself SillyTavern's), Bunraku:src/core/lore/engine/key-word-boundary.ts@702d8120
// (Unicode word boundary) and Bunraku:src/core/lore/engine/scan.ts@702d8120 (selective logic table).
// Copyright (C) 2026 Coneja-Chibi; SillyTavern contributors (parseRegexFromString); changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lore key matching (ARCHITECTURE.md §10.3 step 4–5, D-46). One key is either
// - a regex written '/pattern/flags' — compiled with re2js (linear time, no lookaround or
//   backreferences); a key that does not compile is matched as a literal and its error is reported;
// - a literal — case-insensitive unless caseSensitive; with wholeWords a single-word key needs a
//   Unicode word boundary on both sides: (?<![\p{L}\p{N}\p{M}_])key(?![\p{L}\p{N}\p{M}_]) [D-46]
//   (ST's own boundary is ASCII \W, which breaks Cyrillic); a key of several words, or one in a
//   script without spaces, matches as a substring (as ST and Bunraku do).
// Literal keys are escaped before they reach a JS RegExp, so they cannot be slow; only '/re/' keys
// go through re2js.
// Sources (adapt): Bunraku src/core/lore/engine/key-word-boundary.ts, triggers-keyword.ts and
// scan.ts; RoleCall apps/rc/src/lib/lorebook/triggers/keyword.ts (re2js) and regex-utils.ts
// parseRegexFromString; SillyTavern world-info.js matchKeys (behaviour).
// CONTRACT FILE: signatures are fixed; the lore agent implements the bodies.
//
// Details (SillyTavern world-info.js matchKeys / normalizeWorldInfoKey, behaviour):
// - keys are trimmed; an empty key never matches;
// - a '/re/' key follows only its own flags (i, s, m; g/u/y mean nothing for a yes/no test), never
//   the entry's caseSensitive; a key that re2js refuses (lookaround, backreferences, bad syntax)
//   falls back to its pattern text matched as a literal under the entry's options (RoleCall's
//   fallback), and the error is returned;
// - literal keys and the text are NFC-normalized first, so a decomposed 'й' matches a composed one;
//   regex keys see the same NFC text;
// - the boundary does not count letters of spaceless scripts (Han, Hiragana, Katakana, Thai) as
//   glue, so a Latin key inside running CJK text still matches (Bunraku's rule);
// - the boundary is checked code point by code point around each occurrence, not with the
//   lookbehind above: JavaScriptCore (Bun) misreads surrogate pairs inside a lookbehind.
// Not ported: Bunraku's ReDoS vet over native RegExp (re2js is linear by construction), its
// process-wide LRU caches and lock gates (the cache lives on one KeyMatcher), special/emotion
// triggers and per-trigger frequency; ST's ASCII (?:^|\W) boundary.

import { RE2JS } from 're2js';
import type { LoreEntry } from '../formats/native.ts';
import { charAt, charBefore, gluesToLoreKey, hasSpacelessScript } from '../text/normalize.ts';

export interface KeyOptions {
  caseSensitive: boolean;
  wholeWords: boolean;
}

export interface KeyMatch {
  /** Keys found in the text, in key order. */
  matched: string[];
  /** '/re/' keys that did not compile (each was then matched as a literal). */
  regexErrors: { key: string; message: string }[];
}

/** '/pattern/flags' → its parts, or null when the key is not written as a regex (ST's parseRegexFromString). */
export function parseRegexKey(key: string): { source: string; flags: string } | null {
  const m = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
  if (!m) return null;
  const source = m[1] as string;
  // An unescaped '/' inside the pattern means it is not a delimited regex (ST's rule).
  if (/(^|[^\\])\//.test(source)) return null;
  // Escaped delimiters become plain slashes (every one; ST's own replace only did the first).
  // Unlike ST, the pattern is not test-compiled here: re2js is the judge, and its error is reported.
  return { source: source.replace(/\\\//g, '/'), flags: m[2] as string };
}

/** Escapes a literal for a JS RegExp (the key text never acts as syntax). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Compiled = { test(text: string): boolean; error?: string };

/** Matches keys against scan text. Compiled keys are cached on the instance (one per lore run is enough). */
export class KeyMatcher {
  private readonly compiled = new Map<string, Compiled>();
  /** NFC of recent scan texts: entries of one run share a handful of texts. */
  private readonly nfc = new Map<string, string>();

  match(keys: readonly string[], text: string, opts: KeyOptions): KeyMatch {
    const out: KeyMatch = { matched: [], regexErrors: [] };
    if (keys.length === 0) return out;
    const norm = this.normalized(text);
    for (const raw of keys) {
      const key = raw.trim();
      if (!key) continue;
      const c = this.compile(key, opts);
      if (c.error !== undefined) out.regexErrors.push({ key: raw, message: c.error });
      if (c.test(norm)) out.matched.push(raw);
    }
    return out;
  }

  private normalized(text: string): string {
    let n = this.nfc.get(text);
    if (n === undefined) {
      if (this.nfc.size >= 32) this.nfc.clear();
      n = text.normalize('NFC');
      this.nfc.set(text, n);
    }
    return n;
  }

  private compile(key: string, opts: KeyOptions): Compiled {
    const re = parseRegexKey(key);
    // A regex key ignores the entry's options; a literal (and a regex's fallback) depends on them.
    const id = re ? `/\u0000${key}\u0000${+opts.caseSensitive}${+opts.wholeWords}` : `${+opts.caseSensitive}${+opts.wholeWords}\u0000${key}`;
    let c = this.compiled.get(id);
    if (c === undefined) {
      c = re ? compileRegex(re.source, re.flags, opts) : compileLiteral(key, opts);
      this.compiled.set(id, c);
    }
    return c;
  }
}

/** '/re/flags' through re2js; on a compile error, the pattern text as a literal plus the message. */
function compileRegex(source: string, flags: string, opts: KeyOptions): Compiled {
  let f = 0;
  if (flags.includes('i')) f |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes('s')) f |= RE2JS.DOTALL;
  if (flags.includes('m')) f |= RE2JS.MULTILINE;
  try {
    const re = RE2JS.compile(source, f);
    return { test: (text) => re.matcher(text).find() };
  } catch (e) {
    const literal = compileLiteral(source, opts);
    return { test: literal.test, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A literal key: escaped JS RegExp with the 'u' flag ('i' unless case-sensitive), NFC like the text. */
function compileLiteral(key: string, opts: KeyOptions): Compiled {
  const k = key.normalize('NFC');
  const flags = opts.caseSensitive ? 'u' : 'iu';
  // ST: a key of several words matches as a substring even with whole words on; so does a key in a
  // spaceless script, whose words have no edges to find.
  const substring = !opts.wholeWords || /\s/u.test(k) || hasSpacelessScript(k);
  const body = escapeRegex(k);
  if (substring) {
    const re = new RegExp(body, flags);
    return { test: (text) => re.test(text) };
  }
  // Whole word: every occurrence is checked for glue on both sides, code point by code point (the
  // boundary (?<![\p{L}\p{N}\p{M}_])key(?![…]) as a loop; see gluesToLoreKey for why not a lookbehind).
  const re = new RegExp(body, `${flags}g`);
  return {
    test(text) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const end = m.index + m[0].length;
        if (!gluesToLoreKey(charBefore(text, m.index)) && !gluesToLoreKey(charAt(text, end))) return true;
        // Overlapping occurrences: retry one code point after this one's start.
        re.lastIndex = m.index + charAt(text, m.index).length;
      }
      return false;
    },
  };
}

/**
 * ST selective logic: does an entry with `total` secondary keys, `matched` of them found, pass?
 * and_any: ≥ 1; and_all: all; not_any: none; not_all: not all. total 0 always passes.
 */
export function secondaryPasses(logic: NonNullable<LoreEntry['logic']>, matched: number, total: number): boolean {
  if (total <= 0) return true;
  switch (logic) {
    case 'and_any':
      return matched >= 1;
    case 'and_all':
      return matched >= total;
    case 'not_any':
      return matched === 0;
    case 'not_all':
      return matched < total;
    default:
      return matched >= 1; // an unknown value from hand-edited data reads as ST's default, and_any
  }
}
