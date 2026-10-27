// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One lexical ranking (ARCHITECTURE.md §9.2 "lexScore"): search_lore now, the Compendium selector,
// shortlist and roster and the Director's world snapshot later. Fresh code. Lexicographic, not
// weighted: RoleCall's title×3/keys×2/text×1 ranks «Брат Алексей» above the innkeeper whose entry
// says she has a brother, for the query «брат трактирщица»; this scheme must not (fixture in tests).
// CONTRACT FILE (M3): signatures are fixed; the text agent implements the body.
//
// How a part matches (text/normalize.ts locateQuery): a term by stem against any word, a phrase by
// folded words in a row, a substring inside a spaceless-script word. The title and each key are
// matched one by one (a phrase never spans two keys); '/regex/' keys take no part in ranking.

import { locateQuery, wordsOf, type Query } from './normalize.ts';

export interface LexDoc {
  title?: string;
  keys?: readonly string[];
  text: string;
  /** Tie-break, higher first: freshness (Compendium prov.lastSeq) or lore `order`. Default 0. */
  rank?: number;
}

export interface LexScore {
  /** Index into the docs array. */
  index: number;
  /** 1) distinct query parts (terms, phrases, substrings) matched anywhere: title, keys or text. */
  matched: number;
  /** 2) distinct query parts matched in the title or a key (the title counts as a key). */
  inKey: number;
  /** 3) the doc's rank. */
  rank: number;
}

/** A key written '/pattern/flags' (lore/keys.ts parseRegexKey's shape, without the lore import). */
const REGEX_KEY_RE = /^\/[\s\S]+\/[gimsuy]*$/;

/**
 * Rank docs for a query: matched desc, then inKey desc, then rank desc, then index asc (stable).
 * Docs that match no part are left out. Partial matches count (unlike search_history's AND).
 */
export function lexScore(query: Query, docs: readonly LexDoc[]): LexScore[] {
  const parts = query.terms.length + query.phrases.length + query.substrings.length;
  if (parts === 0) return [];
  const out: LexScore[] = [];
  docs.forEach((doc, index) => {
    const inKey = new Array<boolean>(parts).fill(false);
    const heads = [doc.title ?? '', ...(doc.keys ?? []).filter((k) => !REGEX_KEY_RE.test(k.trim()))];
    for (const head of heads) {
      if (head.trim() === '') continue;
      locateQuery(query, wordsOf(head)).forEach((at, i) => {
        if (at !== null) inKey[i] = true;
      });
    }
    const inText = locateQuery(query, wordsOf(doc.text));
    let matched = 0;
    let keyed = 0;
    for (let i = 0; i < parts; i++) {
      if (inKey[i]) keyed++;
      if (inKey[i] || inText[i] !== null) matched++;
    }
    if (matched > 0) out.push({ index, matched, inKey: keyed, rank: doc.rank ?? 0 });
  });
  return out.sort((a, b) => b.matched - a.matched || b.inKey - a.inKey || b.rank - a.rank || a.index - b.index);
}
