// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Is a Compendium entry named in a text? (.notes/m5a-decisions.md D-153, D-157, D-169 as narrowed in
// section I.) Shared by the selector and the Director's world snapshot. Words compare by
// normalizeTerm stems, so «Миру» names «Мира». Per phrase:
// - the name and aliases of a character, location, item, power, organization, creature, threat or
//   worldbuilding entry are proper names: every word of one in a text, in any order («фонарь вашего
//   мужа, Гордея» names «Фонарь Гордея») — unless the phrase holds a word of ≤ 2 letters or a stop
//   word («Блок А», «Elizabeth I», «The Lantern Guild», «Старый Том»): then it is a run of stems, in
//   order (the M2 stem-key rule). Stop words are STOP_WORDS and the Russian function words that
//   normalizeTerm marks (том, нам, под …): a pronoun or preposition anywhere would meet them;
// - the name and aliases of an event, plot or summary entry are phrases, not names: always a run;
// - a library entry's non-regex lore key is a run, as the lore engine's stem keys are; when the entry
//   has secondary keys its logic (and_any default) must hold against the same text, the lore engine's
//   way (KeyMatcher in stem mode, '/re/' keys included). caseSensitive is not honoured (stems fold
//   case; a listed deviation).
// A name or alias with fewer than 2 letters never matches; a phrase in a spaceless script matches as a
// substring (known limit: «山田 太郎» never matches «山田太郎»). Texts are message texts without the
// "Name: " speaker prefix and without hidden messages (the caller's job).
// CONTRACT FILE (M5a): the lead owns it.

import type { LoreEntry } from '../../formats/native.ts';
import { KeyMatcher, secondaryPasses, type KeyOptions } from '../../lore/keys.ts';
import { compileStemKey, FUNCTION_WORD_MARK, matchStemKey, STOP_WORDS, stemText, wordsOf, type StemKey, type StemText } from '../../text/normalize.ts';
import type { CEntry, EntryType } from './types.ts';
import type { MessageView } from '../../session/view.ts';

type Logic = NonNullable<LoreEntry['logic']>;

/** How an entry is named: one phrase (its name, an alias or a library lore key) and how it must appear. */
export interface EntryMatcher extends StemKey {
  /** true: the stems as consecutive words, in order; false: each stem anywhere in the text. */
  run: boolean;
  /** A library lore key's guard: the entry's non-blank secondary keys, which must satisfy `logic`. */
  secondary?: readonly string[];
  logic?: Logic;
}

/** A text prepared for many entries (mentionText). */
export interface MentionText extends StemText {
  /** The text as given: '/re/' secondary keys test it. */
  raw: string;
  /** Secondary keys are matched as a stem book's keys are (lore/keys.ts), compiled once per text. */
  keys: KeyMatcher;
}

const LETTER = /\p{L}/gu;
const letters = (s: string): number => (s.match(LETTER) ?? []).length;

/** A lore key in the '/re/flags' form (not a name; never a matcher). */
const isRegexKey = (k: string): boolean => /^\/.+\/[a-z]*$/s.test(k.trim());

/** Entry types whose names are descriptive phrases (section I): always a run. */
const PHRASE_TYPES: ReadonlySet<EntryType> = new Set(['event', 'plot', 'summary']);

/** Secondary keys as a stem book's lore engine reads them (case and wholeWords do not apply there). */
const STEM_BOOK: KeyOptions = { caseSensitive: false, wholeWords: true, match: 'stem' };

const LOGICS: ReadonlySet<string> = new Set(['and_any', 'and_all', 'not_any', 'not_all']);

/** A word that forces a run: ≤ 2 letters (initials, labels, regnal numerals, numbers) or a stop word. */
const binds = (w: { norm: string; stem: string }): boolean => letters(w.norm) <= 2 || STOP_WORDS.has(w.norm) || w.stem.endsWith(FUNCTION_WORD_MARK);

/** A name or an alias (`run` forced for a phrase type); null when it never matches. */
function nameMatcher(phrase: string, phraseType: boolean): EntryMatcher | null {
  if (typeof phrase !== 'string' || letters(phrase) < 2) return null;
  const key = compileStemKey(phrase);
  if (key === null) return null;
  if (key.substring !== null) return { ...key, run: true };
  const words = wordsOf(phrase);
  if (phraseType || words.some(binds)) return { ...key, run: true };
  return { stems: [...new Set(key.stems)], substring: null, run: false };
}

/** A library lore key: a run, guarded by the entry's secondary keys when it has any. */
function keyMatcher(k: string, secondary: readonly string[], logic: Logic): EntryMatcher | null {
  if (typeof k !== 'string' || isRegexKey(k) || letters(k) < 2) return null;
  const key = compileStemKey(k);
  if (key === null) return null;
  return secondary.length === 0 ? { ...key, run: true } : { ...key, run: true, secondary, logic };
}

/**
 * The matchers of one entry: its name and each alias by its type's rule, and, for a library entry,
 * each non-regex lore key as a run with the entry's secondary keys and logic (D-153, section I).
 * Former names never match. Deduplicated.
 */
export function entryMatchers(e: CEntry): EntryMatcher[] {
  const phraseType = e.type === null || PHRASE_TYPES.has(e.type);
  const out: EntryMatcher[] = [];
  const seen = new Set<string>();
  const add = (m: EntryMatcher | null, kind: string): void => {
    if (m === null) return;
    const id = `${kind}${m.run ? 'r' : 'a'}\u0000${m.substring ?? (m.run ? m.stems : [...m.stems].sort()).join(' ')}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(m);
  };
  for (const p of [e.name, ...e.aliases]) add(nameMatcher(p, phraseType), 'n');
  if (e.origin.kind === 'library') {
    const secondary = (Array.isArray(e.secondary) ? e.secondary : []).filter((k) => typeof k === 'string' && k.trim() !== '');
    const logic: Logic = typeof e.logic === 'string' && LOGICS.has(e.logic) ? e.logic : 'and_any';
    for (const k of e.keys) add(keyMatcher(k, secondary, logic), 'k');
  }
  return out;
}

/** A prepared text (build once, test many entries). */
export function mentionText(text: string): MentionText {
  return { ...stemText(text), raw: text, keys: new KeyMatcher() };
}

function found(m: EntryMatcher, text: MentionText): boolean {
  if (m.substring !== null) return text.folded.includes(m.substring);
  return m.run ? matchStemKey(m, text) : m.stems.every((s) => text.at.has(s));
}

/** True when one matcher is found in the text (and its secondary keys, if any, hold there). */
export function mentioned(matchers: readonly EntryMatcher[], text: MentionText): boolean {
  for (const m of matchers) {
    if (!found(m, text)) continue;
    if (m.secondary === undefined) return true;
    const hits = text.keys.match(m.secondary, text.raw, STEM_BOOK).matched.length;
    if (secondaryPasses(m.logic ?? 'and_any', hits, m.secondary.length)) return true;
  }
  return false;
}

/** A message's text blocks joined, with no speaker prefix (reasoning and tool blocks are not text). */
export function messageText(m: MessageView): string {
  let text = '';
  for (const b of m.blocks) if (b.k === 'text') text += b.text;
  return text.trim();
}
