// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The story's language, named for the Compendium agents when `compendium.language` is blank
// (.notes/m5b-decisions.md D-183, section J). A live run showed a 12B historian answering a Russian
// story in English despite «Write every field value in the language the story is written in.»; naming
// the language («in Russian») is what such a model follows. Detection is by script only: a script that
// holds most of the letters names its language; Latin and mixed texts name nothing (the generic line
// stays). Cyrillic tells Ukrainian, Belarusian, Serbian and Macedonian apart by their own letters and
// is Russian otherwise.

const SAMPLE = 20_000;
const DOMINANT = 0.6;

const SCRIPTS: readonly [RegExp, string][] = [
  [/\p{Script=Cyrillic}/u, 'cyrillic'],
  [/\p{Script=Greek}/u, 'Greek'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'kana'],
  [/\p{Script=Hangul}/u, 'Korean'],
  [/\p{Script=Han}/u, 'han'],
  [/\p{Script=Arabic}/u, 'Arabic'],
  [/\p{Script=Hebrew}/u, 'Hebrew'],
  [/\p{Script=Thai}/u, 'Thai'],
  [/\p{Script=Latin}/u, 'latin'],
];

const LETTER = /\p{L}/u;

function cyrillicLanguage(text: string): string {
  // Belarusian also writes і, so its own ў is checked first.
  if (/[ўЎ]/u.test(text)) return 'Belarusian';
  if (/[іїєґІЇЄҐ]/u.test(text)) return 'Ukrainian';
  if (/[ђћЂЋ]/u.test(text)) return 'Serbian';
  if (/[ѓќѕЃЌЅ]/u.test(text)) return 'Macedonian';
  return 'Russian';
}

/** The language the texts are written in, by their dominant script; null for Latin, mixed or no text. */
export function storyLanguage(texts: readonly string[]): string | null {
  let sample = '';
  for (let i = texts.length - 1; i >= 0 && sample.length < SAMPLE; i--) sample = `${texts[i] ?? ''}\n${sample}`;
  sample = sample.slice(-SAMPLE);
  const counts = new Map<string, number>();
  let letters = 0;
  for (const ch of sample) {
    if (!LETTER.test(ch)) continue;
    letters++;
    for (const [re, name] of SCRIPTS) {
      if (re.test(ch)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  if (letters === 0) return null;
  // Japanese mixes kana and kanji: kana present with Han makes it Japanese.
  const kana = counts.get('kana') ?? 0;
  const han = counts.get('han') ?? 0;
  if (kana > 0 && (kana + han) / letters >= DOMINANT) return 'Japanese';
  let best: [string, number] | null = null;
  for (const e of counts) if (best === null || e[1] > best[1]) best = e;
  if (best === null || best[1] / letters < DOMINANT) return null;
  switch (best[0]) {
    case 'latin':
      return null;
    case 'cyrillic':
      return cyrillicLanguage(sample);
    case 'han':
      return 'Chinese';
    case 'kana':
      return 'Japanese';
    default:
      return best[0];
  }
}
