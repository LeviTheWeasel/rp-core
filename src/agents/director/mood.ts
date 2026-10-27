// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What a mood says about the story's rhythm, by its words (m4-decisions D-109). Bunraku's pacingAfter
// compared the whole mood string with 'action', 'climax', 'calm'…, so "tense, watchful" never read as
// tense and no Russian mood ever matched. Here a mood is split into words, each stemmed with
// normalizeTerm (D-46), and a kind is set when any word's stem is one of the kind's stems.
// Shared by reduce.ts (the rhythm counters) and momentum.ts (the rhythm signals).

import { wordsOf } from '../../text/normalize.ts';

export type MoodKind = 'action' | 'quiet' | 'climax' | 'tense';

/** The words of each kind, English and Russian. Data: extend here, the stems follow. */
export const MOOD_WORDS: Readonly<Record<MoodKind, readonly string[]>> = {
  action: ['action', 'fight', 'chase', 'battle', 'combat', 'бой', 'драка', 'погоня', 'схватка', 'битва', 'сражение'],
  quiet: [
    'calm',
    'quiet',
    'reflective',
    'intimate',
    'aftermath',
    'peaceful',
    'спокойствие',
    'спокойный',
    'тихий',
    'тишина',
    'размышление',
    'близость',
  ],
  climax: ['climax', 'кульминация'],
  tense: ['tense', 'tension', 'напряжение', 'напряжённый', 'тревога', 'тревожный'],
};

const stemsOf = (words: readonly string[]): ReadonlySet<string> => new Set(words.flatMap((w) => wordsOf(w).map((x) => x.stem)));

const KIND_STEMS: ReadonlyArray<readonly [MoodKind, ReadonlySet<string>]> = (Object.keys(MOOD_WORDS) as MoodKind[]).map(
  (k) => [k, stemsOf(MOOD_WORDS[k])] as const,
);

/** The kinds a mood belongs to (none for an empty or unknown mood). */
export function moodKinds(mood: string | undefined): ReadonlySet<MoodKind> {
  const out = new Set<MoodKind>();
  if (mood === undefined || mood.trim() === '') return out;
  const stems = wordsOf(mood).map((w) => w.stem);
  for (const [kind, set] of KIND_STEMS) if (stems.some((s) => set.has(s))) out.add(kind);
  return out;
}
