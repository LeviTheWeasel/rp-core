// Ported from RoleCall:apps/rc/src/lib/ai/dm-stream/__tests__/vvs-267-arc-title-sanitizer.test.ts@fb8dc623e
// (Coneja-Chibi: the arc title sanitizer vectors) and the cleanTitle case of
// Bunraku:src/core/director/apply.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cleanTitle (agents/director/reduce.ts, D-108): Bunraku's steps (one sentence, 80 characters) plus
// RoleCall's stutter rule plus an `arc-N` echo cut; no hex-slug rules. Kept: the stutter, pass-through,
// whitespace, cap and idempotency vectors. Changed: '' instead of undefined for an empty result (the
// caller skips it); the hex-slug vectors ("Arc:7c7a …", "6347 …", "beef", "1234 Chapter") are
// replaced by `arc-N` echo vectors, and the hex words now stay (D-108: the hex rules cut "Dead",
// "Cafe", "Face"). Added: Russian titles, the first-sentence and colon cuts, the surrogate-safe cap;
// cleanHiddenTitle (D-123: a new hidden arc's title loses the prompt's `[hidden-N] "…"` echo).
import { describe, expect, test } from 'bun:test';
import { cleanHiddenTitle, cleanTitle } from '../../src/agents/director/reduce.ts';

describe('arc-N echoes (replacing the VVS-267 slug vectors)', () => {
  test('a leading arc-N echo is cut, with its brackets and separator', () => {
    expect(cleanTitle('arc-7 Levi Strovolos')).toBe('Levi Strovolos');
    expect(cleanTitle('[arc-7] Levi Strovolos')).toBe('Levi Strovolos');
    expect(cleanTitle('arc-7: The Heist')).toBe('The Heist');
    expect(cleanTitle('arc-7 — The Heist')).toBe('The Heist');
    expect(cleanTitle('ARC-12. The Heist')).toBe('The Heist');
    expect(cleanTitle('(arc-3) Тайна маяка')).toBe('Тайна маяка');
  });

  test('several echoes in a row are all cut', () => {
    expect(cleanTitle('arc-7 arc-9 Levi St')).toBe('Levi St');
    expect(cleanTitle('[arc-7] [arc-7] arc-9: Levi')).toBe('Levi');
  });

  test('a trailing bracketed echo is cut', () => {
    expect(cleanTitle('The Heist (arc-4)')).toBe('The Heist');
    expect(cleanTitle('Тайна маяка [arc-3]')).toBe('Тайна маяка');
  });

  test('an echo alone leaves nothing (the caller skips the arc)', () => {
    expect(cleanTitle('arc-7')).toBe('');
    expect(cleanTitle('[arc-7] arc-9')).toBe('');
  });

  test('echo + stutter heal both layers', () => {
    expect(cleanTitle('arc-7 Levi Levi Levi Strovol')).toBe('Levi Strovol');
    expect(cleanTitle('arc-7 Levi Levi')).toBe('Levi Levi');
  });

  test('words that only start like an echo stay', () => {
    expect(cleanTitle('Arc Reactor')).toBe('Arc Reactor');
    expect(cleanTitle('Arcology Project')).toBe('Arcology Project');
    expect(cleanTitle('The arc-7 Protocol')).toBe('The arc-7 Protocol');
  });
});

describe('VVS-267 — hex words are titles here [D-108]', () => {
  test("'Dead Man's Hand' and other hex-looking words stay intact", () => {
    // RoleCall: "Dead Man's Hand" → "Man's Hand", "Cafe Intrigue" → "Intrigue", "beef" → undefined.
    expect(cleanTitle("Dead Man's Hand")).toBe("Dead Man's Hand");
    expect(cleanTitle('Cafe Intrigue')).toBe('Cafe Intrigue');
    expect(cleanTitle('Faced with the Abyss')).toBe('Faced with the Abyss');
    expect(cleanTitle('Decade of War')).toBe('Decade of War');
    expect(cleanTitle('beef')).toBe('beef');
    expect(cleanTitle('face')).toBe('face');
    expect(cleanTitle('1234 Chapter')).toBe('1234 Chapter');
    expect(cleanTitle('6347 Levi Strovolos')).toBe('6347 Levi Strovolos');
  });

  test('does NOT strip a 3-char hex prefix (too short — could be a real word)', () => {
    expect(cleanTitle('abc Levi')).toBe('abc Levi');
  });

  test('does NOT strip a 9+ char hex prefix (also too long to be a slug)', () => {
    expect(cleanTitle('123456789 Levi')).toBe('123456789 Levi');
  });
});

describe('VVS-267 — stutter healing (≥3 identical leading words)', () => {
  test('collapses `Levi Levi Levi Strovolos` → `Levi Strovolos`', () => {
    expect(cleanTitle('Levi Levi Levi Strovolos')).toBe('Levi Strovolos');
  });

  test('collapses 4 identical leading words', () => {
    expect(cleanTitle('Levi Levi Levi Levi Strovolos')).toBe('Levi Strovolos');
  });

  test('LEAVES intentional 2-word repeats alone (`Bora Bora`)', () => {
    expect(cleanTitle('Bora Bora')).toBe('Bora Bora');
  });

  test('LEAVES `New New York` alone (place-name pattern, 2 repeats)', () => {
    expect(cleanTitle('New New York')).toBe('New New York');
  });

  test('LEAVES different leading words alone (`A New Adventure`)', () => {
    expect(cleanTitle('A New Adventure')).toBe('A New Adventure');
  });

  test('case-insensitive stutter heal (`Levi LEVI Levi Strovolos`)', () => {
    expect(cleanTitle('Levi LEVI Levi Strovolos')).toBe('Levi Strovolos');
  });

  test('Cyrillic stutter, any case', () => {
    expect(cleanTitle('Тайна ТАЙНА тайна маяка')).toBe('Тайна маяка');
    expect(cleanTitle('Пора пора')).toBe('Пора пора');
  });

  test('pure stutter with no content after is left alone (`Lev Lev Lev`)', () => {
    expect(cleanTitle('Lev Lev Lev')).toBe('Lev Lev Lev');
  });
});

describe('VVS-267 — clean inputs pass through verbatim (no false positives)', () => {
  test('simple 2-word title', () => {
    expect(cleanTitle('Levi Strovolos')).toBe('Levi Strovolos');
  });

  test('title with apostrophe', () => {
    expect(cleanTitle("The King's Secret")).toBe("The King's Secret");
  });

  test('title with em-dash', () => {
    expect(cleanTitle('Sirens — The Awakening')).toBe('Sirens — The Awakening');
  });

  test('title with numbers (e.g. `Chapter 4`)', () => {
    expect(cleanTitle('Chapter 4')).toBe('Chapter 4');
  });

  test('very long title is unmodified', () => {
    const long = 'The Legendary Saga of the Last Strovolos and the Forgotten Citadel';
    expect(cleanTitle(long)).toBe(long);
  });

  test('accepts a single-word title', () => {
    expect(cleanTitle('Awakening')).toBe('Awakening');
    expect(cleanTitle('Lev')).toBe('Lev');
  });

  test("title containing a non-leading hex doesn't get stripped (model emits hash mid-title)", () => {
    expect(cleanTitle('Project 7c7a Reactor')).toBe('Project 7c7a Reactor');
  });

  test('Russian titles pass through', () => {
    expect(cleanTitle('Тайна старой башни')).toBe('Тайна старой башни');
    expect(cleanTitle('Сердце Маруси — последний шанс')).toBe('Сердце Маруси — последний шанс');
  });
});

describe('VVS-267 — adjacent edge cases', () => {
  test('collapses internal multi-space runs (model emits `Levi   Strovolos`)', () => {
    expect(cleanTitle('Levi   Strovolos')).toBe('Levi Strovolos');
    expect(cleanTitle('Levi\n\tStrovolos Courtship')).toBe('Levi Strovolos Courtship');
  });

  test('trims leading/trailing whitespace', () => {
    expect(cleanTitle('  Levi Strovolos  ')).toBe('Levi Strovolos');
  });

  test('empty, whitespace-only → "" (RoleCall: undefined)', () => {
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle('   \t  ')).toBe('');
  });
});

describe('one sentence, 80 characters (Bunraku cleanTitle)', () => {
  test('the first sentence is the title', () => {
    // Bunraku apply.test.ts "an unknown arc is created with RoleCall's defaults…".
    expect(cleanTitle('The Lamp. Something about a very long description that should not be a title.')).toBe('The Lamp.');
    expect(cleanTitle('Тайна башни. Следующий шаг: найти ключ')).toBe('Тайна башни.');
    expect(cleanTitle('Run! The fire spreads')).toBe('Run!');
  });

  test('a "Title: subtitle" keeps the title', () => {
    expect(cleanTitle('The Heist: From Plan to Ruin')).toBe('The Heist');
    expect(cleanTitle('Долг: от слов к делу')).toBe('Долг');
    expect(cleanTitle('Time 12:30 Train')).toBe('Time 12:30 Train');
  });

  test('a multi-paragraph body is cut at its first colon or sentence end (newlines are spaces by then, as in both sources)', () => {
    const body = 'The Ledger\n\nNext Beat: the clerk talks.\nStages:\n- found the ledger';
    expect(cleanTitle(body)).toBe('The Ledger Next Beat');
  });

  test('known limit, as in both sources: an abbreviation ends the sentence', () => {
    expect(cleanTitle("Mr. Smith's Debt")).toBe('Mr.');
  });

  test('over 80: cut at the last space past 60 %, else hard at 80', () => {
    const words = 'The long road north through the frozen passes where the old kings sleep beneath the ice and snow';
    const out = cleanTitle(words);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(words.startsWith(out)).toBe(true);
    expect(words.charAt(out.length)).toBe(' ');
    const solid = 'x'.repeat(120);
    expect(cleanTitle(solid)).toBe('x'.repeat(80));
    const ru = 'Долгая дорога на север через замёрзшие перевалы, где под снегом и льдом спят старые короли';
    expect(cleanTitle(ru).length).toBeLessThanOrEqual(80);
    expect(ru.startsWith(cleanTitle(ru))).toBe(true);
  });

  test('the cap never leaves half of a surrogate pair', () => {
    const t = `${'a'.repeat(79)}🌟 tail`;
    const out = cleanTitle(t);
    expect(out).toBe('a'.repeat(79));
    expect(out.length).toBe(79);
  });
});

describe('VVS-267 — idempotency (the cascade never erodes a clean title)', () => {
  test('iterative cascade simulation — cleanTitle is idempotent on its own output', () => {
    let title = 'arc-7 Levi Strovolos Courtship';
    title = cleanTitle(title);
    expect(title).toBe('Levi Strovolos Courtship');
    expect(cleanTitle(title)).toBe(title);
    expect(cleanTitle(cleanTitle(title))).toBe(title);
  });

  test('cascade with progressive corruption — cleanTitle never returns longer than the (cleaned) input', () => {
    const turns = ['arc-7 Levi Strovolos Courtship', 'arc-7 Levi Strovolos', 'arc-7 Levi', 'arc-7 Lev'];
    expect(turns.map(cleanTitle)).toEqual(['Levi Strovolos Courtship', 'Levi Strovolos', 'Levi', 'Lev']);
  });

  test('every vector of this file is a fixed point', () => {
    const inputs = [
      'The Lamp. Something about a very long description that should not be a title.',
      'Levi Levi Levi Levi Strovolos',
      '[arc-7] [arc-7] arc-9: Levi',
      'The Heist: From Plan to Ruin',
      'Тайна ТАЙНА тайна маяка',
      'The long road north through the frozen passes where the old kings sleep beneath the ice and snow',
      `${'a'.repeat(79)}🌟 tail`,
      'Levi Levi Levi. X',
      "Dead Man's Hand",
    ];
    for (const raw of inputs) {
      const once = cleanTitle(raw);
      expect(cleanTitle(once)).toBe(once);
    }
  });
});

describe('cleanHiddenTitle (D-123: the prompt lists hidden arcs as \'- [hidden-N] "Title"\')', () => {
  test('hidden-N echoes and the quotes of the prompt line are cut', () => {
    expect(cleanHiddenTitle('[hidden-2] "The Guild"')).toBe('The Guild');
    expect(cleanHiddenTitle('(hidden-2) The Guild')).toBe('The Guild');
    expect(cleanHiddenTitle('hidden-2: «Тайная гильдия»')).toBe('Тайная гильдия');
    expect(cleanHiddenTitle('“The Guild” (hidden-2)')).toBe('The Guild');
    expect(cleanHiddenTitle('„Заговор“')).toBe('Заговор');
    expect(cleanHiddenTitle('"[hidden-2] The Guild"')).toBe('The Guild');
    expect(cleanHiddenTitle('[hidden-2]')).toBe('');
    expect(cleanHiddenTitle('  "  "  ')).toBe('');
  });

  test('then the arc rules: one sentence, the part before ": ", 80 characters, a stutter healed', () => {
    expect(cleanHiddenTitle('The Watchers: they follow the keeper')).toBe('The Watchers');
    expect(cleanHiddenTitle('Cabal Cabal Cabal of Ash')).toBe('Cabal of Ash');
    expect(cleanHiddenTitle(`[hidden-1] ${'Тень '.repeat(30)}`).length).toBeLessThanOrEqual(80);
  });

  test('inner quotes and plain titles stay', () => {
    expect(cleanHiddenTitle('The "Red" Guild')).toBe('The "Red" Guild');
    expect(cleanHiddenTitle("The Prince's Cabal")).toBe("The Prince's Cabal");
    expect(cleanHiddenTitle('Hidden-Hand Society')).toBe('Hidden-Hand Society');
  });

  test('idempotent on its own output', () => {
    for (const raw of ['"[hidden-2] The Guild"', '[hidden-1] [hidden-1] «Тень» (hidden-1)', '"The Lamp. Long."', '“Levi Levi Levi Strovolos”', `"${'x'.repeat(100)}"`]) {
      const once = cleanHiddenTitle(raw);
      expect(cleanHiddenTitle(once)).toBe(once);
    }
  });
});
