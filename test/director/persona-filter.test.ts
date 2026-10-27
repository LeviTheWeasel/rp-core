// Ported from Bunraku:src/core/director/directive.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (the sanitizeForPlayerCharacter part) and Bunraku:src/core/director/directive-names.test.ts@702d8120
// (Coneja-Chibi); the RoleCall cases are the doc comment of RoleCall:apps/rc/src/lib/ai/dm-stream/
// DirectiveBuilder.ts@fb8dc623e sanitizeDirectiveForPlayerCharacter (no RoleCall unit test exists).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The persona filter (src/agents/director/render.ts, m4-decisions D-112, A.5): the player's
// character gets no beat, no line and no include entry, and no entry may claim what the persona
// thinks, feels, notices, remembers or decides. Changed against Bunraku: the second argument is the
// list of names (name + aliases); the result is {directive, skipped}; an emptied include is removed
// (D-112); Russian names, verbs and nouns (fixture test/fixtures/ru/director-persona.json).
import { describe, expect, test } from 'bun:test';
import { RU_INTERIORITY_VERBS, sanitizeForPlayerCharacter } from '../../src/agents/director/render.ts';
import type { NarratorDirective } from '../../src/agents/director/types.ts';
import fixture from '../fixtures/ru/director-persona.json';

const sanitize = (d: NarratorDirective, names: string[]) => sanitizeForPlayerCharacter(d, names).directive;
const with_ = (instruction: string): NarratorDirective => ({ mood: 'm', pacing: 'slow', callbacks: [{ reference: 'r', instruction }] });
const kept = (d: NarratorDirective) => d.callbacks?.length === 1;
/** Is the callback with this instruction kept for these names? */
const keeps = (instruction: string, names: string[]) => kept(sanitize(with_(instruction), names));

describe('sanitizeForPlayerCharacter', () => {
  const d: NarratorDirective = {
    mood: 'm',
    pacing: 'slow',
    include: { characters: ['Merlin', 'Zorya'], themes: ['debt'] },
    characterBeats: [
      { character: 'Merlin', beat: 'Looks tired' },
      { character: 'Zorya', beat: 'Fidgets' },
      { character: 'Valen', beat: 'Merlin realizes the lie' },
      { character: 'Valen', beat: 'Hides the note', motivation: "Show Merlin's methodical thinking" },
    ],
    dialogueGuidance: [
      { character: 'merlin', tone: 'dry' },
      { character: 'Zorya', tone: 'warm' },
    ],
    arcDirections: [
      { arcName: 'A', instruction: 'Have Merlin notice the missing scroll', urgency: 'subtle' },
      { arcName: 'B', instruction: "Have Merlin find Valen's note on the table", urgency: 'subtle' },
      { arcName: 'C', instruction: "Let the weight of it sit in Merlin's mind", urgency: 'subtle' },
    ],
    callbacks: [
      { reference: 'r1', instruction: 'Merlin remembers the bell' },
      { reference: 'r2', instruction: 'An NPC mentions the bell to Merlin' },
    ],
  };

  test('the player gets no beat, no line and no place in include.characters; entries that claim their thoughts, senses, memories or decisions are cut', () => {
    const { directive: out, skipped } = sanitizeForPlayerCharacter(d, ['Merlin']);
    expect(out.include).toEqual({ characters: ['Zorya'], themes: ['debt'] });
    expect(out.characterBeats).toEqual([{ character: 'Zorya', beat: 'Fidgets' }]);
    expect(out.dialogueGuidance).toEqual([{ character: 'Zorya', tone: 'warm' }]);
    expect(out.arcDirections!.map((a) => a.arcName)).toEqual(['B']);
    expect(out.callbacks!.map((c) => c.reference)).toEqual(['r2']);
    // rp-core: every removal is reported, by its index in the planner's list [D-112].
    expect(skipped).toEqual([
      { path: 'directive.characterBeats[0]', why: 'persona' },
      { path: 'directive.characterBeats[2]', why: 'persona' },
      { path: 'directive.characterBeats[3]', why: 'persona' },
      { path: 'directive.dialogueGuidance[0]', why: 'persona' },
      { path: 'directive.include.characters[0]', why: 'persona' },
      { path: 'directive.arcDirections[0]', why: 'persona' },
      { path: 'directive.arcDirections[2]', why: 'persona' },
      { path: 'directive.callbacks[0]', why: 'persona' },
    ]);
    expect(d.characterBeats).toHaveLength(4); // the input is not touched
  });

  test("staging is kept: finding, placing, entering and an NPC's action toward the player", () => {
    const staged: NarratorDirective = {
      mood: 'm',
      pacing: 'slow',
      arcDirections: [{ arcName: 'A', instruction: 'Place Merlin at the third shelf; Merlin enters the archive and the candles flicker', urgency: 'subtle' }],
    };
    expect(sanitize(staged, ['Merlin'])).toEqual(staged);
    // rp-core: nothing removed → the very same object and no skips.
    expect(sanitizeForPlayerCharacter(staged, ['Merlin'])).toEqual({ directive: staged, skipped: [] });
    expect(sanitize(staged, ['Merlin'])).toBe(staged);
  });

  test('the include list loses its key when the player was the only name; with no player name nothing changes', () => {
    // Changed (D-112, render unit task): an include left with nothing in it is removed (Bunraku kept {}).
    expect(sanitize({ mood: 'm', pacing: 'slow', include: { characters: ['Merlin'] } }, ['Merlin']).include).toBeUndefined();
    expect('include' in sanitize({ mood: 'm', pacing: 'slow', include: { characters: ['Merlin'] } }, ['Merlin'])).toBe(false);
    expect(sanitize({ mood: 'm', pacing: 'slow', include: { characters: ['Merlin'], themes: ['debt'] } }, ['Merlin']).include).toEqual({ themes: ['debt'] });
    expect(sanitize(d, [])).toBe(d);
    expect(sanitize(d, ['  '])).toBe(d);
  });

  test('a name with regular-expression characters cannot break the match or match everything', () => {
    const out = sanitize(
      {
        mood: 'm',
        pacing: 'slow',
        callbacks: [
          { reference: 'r', instruction: 'Have X.Y(1) feel it' },
          { reference: 's', instruction: 'Have XaY feel it' },
        ],
      },
      ['X.Y(1)'],
    );
    expect(out.callbacks!.map((c) => c.reference)).toEqual(['s']);
  });

  test('a list the filter empties loses its key; the rest of the directive is untouched', () => {
    const only: NarratorDirective = {
      pacing: 'medium',
      narrativeGoal: 'Merlin realizes the lie',
      endingHook: 'Merlin remembers the bell',
      sceneGuidance: { atmosphere: "Merlin's thoughts drift" },
      avoid: { characters: ['Merlin'] },
      characterBeats: [{ character: 'Merlin', beat: 'Sighs' }],
      dialogueGuidance: [{ character: 'MERLIN', tone: 'dry' }],
      callbacks: [{ reference: 'Merlin remembers', instruction: 'The bell rings' }],
    };
    const out = sanitize(only, ['Merlin']);
    expect('characterBeats' in out).toBe(false);
    expect('dialogueGuidance' in out).toBe(false);
    // endingHook, narrativeGoal, sceneGuidance, avoid and the callback's reference are never filtered (§7.3, D-112).
    expect(out).toEqual({
      pacing: 'medium',
      narrativeGoal: 'Merlin realizes the lie',
      endingHook: 'Merlin remembers the bell',
      sceneGuidance: { atmosphere: "Merlin's thoughts drift" },
      avoid: { characters: ['Merlin'] },
      callbacks: [{ reference: 'Merlin remembers', instruction: 'The bell rings' }],
    });
  });

  test('filtering twice changes nothing more (a reused swipe runs the filter again, D-104)', () => {
    const once = sanitize(d, ['Merlin']);
    expect(sanitizeForPlayerCharacter(once, ['Merlin'])).toEqual({ directive: once, skipped: [] });
  });
});

describe('non-ASCII names', () => {
  test.each([
    ['Élodie', 'Have Élodie feel the weight of it'],
    ['Élodie', 'Élodie remembers the bell'],
    ['Åsa', 'Let Åsa notice the draft'],
    ['沈墨', '沈墨 thinks about the letter'],
    ['Zoë', "Zoë's thoughts drift to the pier"],
  ])('%s: %s is cut', (name, text) => {
    expect(keeps(text, [name])).toBe(false);
  });

  test('staging the same names is kept, and a longer word that merely contains the name is not mistaken for it', () => {
    expect(keeps('Place Élodie at the third shelf', ['Élodie'])).toBe(true);
    expect(keeps('Have Sélodiem feel it', ['Élodie'])).toBe(true);
    expect(keeps('Have Asaki feel it', ['Åsa'])).toBe(true);
  });

  test('ASCII names still work, including a name inside a longer sentence', () => {
    expect(keeps('Then, quietly, Merlin realizes the lie.', ['Merlin'])).toBe(false);
  });

  test('a decomposed accent (NFD) in the name or the text still matches (NFKC fold)', () => {
    expect(keeps('Have Élodie feel it', ['Élodie'])).toBe(false);
    expect(keeps('Have Élodie feel it', ['Élodie'])).toBe(false);
  });
});

describe('RoleCall DirectiveBuilder cases', () => {
  // The doc comment of sanitizeDirectiveForPlayerCharacter lists what stays and what goes.
  test.each(["Have Merlin find Valen's note", 'Place Merlin at the third shelf', 'Merlin enters the archive', 'A scroll for Merlin to discover'])(
    'staging is allowed: %s',
    (text) => {
      expect(keeps(text, ['Merlin'])).toBe(true);
    },
  );

  test.each(['Merlin notices X', 'Have Merlin feel Y', "Merlin's thoughts", 'Merlins mind', "Show Merlin's methodical thinking"])('interiority is stripped: %s', (text) => {
    expect(keeps(text, ['Merlin'])).toBe(false);
  });

  test('aliases count as the persona: in beats, lines, include and in the text', () => {
    const out = sanitizeForPlayerCharacter(
      {
        pacing: 'medium',
        include: { characters: ['the Archivist', 'Zorya'] },
        characterBeats: [{ character: 'The Archivist', beat: 'Sighs' }],
        dialogueGuidance: [{ character: 'the archivist', tone: 'dry' }],
        callbacks: [
          { reference: 'r1', instruction: 'The Archivist remembers the bell' },
          { reference: 'r2', instruction: 'Merlin hears the bell' },
        ],
      },
      ['Merlin', 'the Archivist'],
    );
    expect(out.directive).toEqual({ pacing: 'medium', include: { characters: ['Zorya'] }, callbacks: [{ reference: 'r2', instruction: 'Merlin hears the bell' }] });
    expect(out.skipped).toHaveLength(4);
  });

  test('a beat whose motivation claims the persona is cut even when the beat itself is about an NPC', () => {
    const out = sanitize({ pacing: 'medium', characterBeats: [{ character: 'Valen', beat: 'Waits', motivation: 'so that Merlin decides alone' }] }, ['Merlin']);
    expect(out.characterBeats).toBeUndefined();
  });

  test('aliases without a name still filter (rp-core passes [name, ...aliases]; RoleCall ignored aliases without a name)', () => {
    expect(keeps('The Archivist remembers', ['', 'the Archivist'])).toBe(false);
  });
});

describe('Russian (test/fixtures/ru/director-persona.json)', () => {
  const names = [fixture.persona, ...fixture.aliases];

  test.each(fixture.cut.map((c) => [c.text, c.why]))('cut: %s (%s)', (text) => {
    expect(keeps(text, names)).toBe(false);
  });

  test.each(fixture.kept.map((c) => [c.text, c.why]))('kept: %s (%s)', (text) => {
    expect(keeps(text, names)).toBe(true);
  });

  test('every listed Russian verb form is caught after the subject, and the list is folded', () => {
    const missed = RU_INTERIORITY_VERBS.filter((v) => keeps(`Елисей ${v} о брате`, ['Елисей']));
    expect(missed).toEqual([]);
    expect(RU_INTERIORITY_VERBS.filter((v) => v !== v.toLowerCase() || v.includes('ё') || /\s/.test(v))).toEqual([]);
  });

  test('a name inside another word is not the persona: Иван is not Иванов, nor Ивановна', () => {
    expect(keeps('Иванов думает о долге', ['Иван'])).toBe(true);
    expect(keeps('Ивановна думает о долге', ['Иван'])).toBe(true);
    expect(keeps('Иван думает о долге', ['Иван'])).toBe(false);
    expect(keeps('Ивану кажется, что его обманули', ['Иван'])).toBe(false);
    expect(keeps('Заставь Ивана вспомнить долг', ['Иван'])).toBe(false);
    // …and the other way round: the persona Иванов is not every Иван.
    expect(keeps('Иван думает о долге', ['Иванов'])).toBe(true);
    expect(keeps('Иванова вспоминает брата', ['Иванов'])).toBe(true); // a woman of that name, nominative; not this persona
    expect(keeps('Пусть Иванова вспомнит брата', ['Иванов'])).toBe(false); // the persona in the accusative after an order
  });

  test('names of every declension are found in their case forms', () => {
    const cases: [string, string, boolean][] = [
      ['Мира', 'Мире кажется, что её зовут', false], // а: dative
      ['Мира', 'Мира думает о брате', false],
      ['Мира', 'Мира встречает гостей', true],
      ['Илья', 'Илье страшно', false], // я: dative
      ['Мария', 'Марии хочется уйти', false],
      ['Игорь', 'Игорю кажется', false], // ь: dative
      ['Игорь', 'мысли Игоря путаются', false],
      ['Пётр', 'Петру кажется', false], // ё in the name folds
      ['Алёна', 'Алена думает', false],
    ];
    for (const [name, text, stays] of cases) expect([name, text, keeps(text, [name])]).toEqual([name, text, stays]);
  });

  test('a two-word name is found with each word in its case form', () => {
    expect(keeps('Заставь Елисея Петровича вспомнить брата', ['Елисей Петрович'])).toBe(false);
    expect(keeps('Елисей  Петрович\nдумает', ['Елисей Петрович'])).toBe(false);
    expect(keeps('Елисей думает', ['Елисей Петрович'])).toBe(true);
  });

  test('beats, lines and include entries match the name by case and ё, not by inflection', () => {
    const out = sanitizeForPlayerCharacter(
      {
        pacing: 'medium',
        include: { characters: ['ЕЛИСЕЙ', 'Мира'] },
        characterBeats: [{ character: ' елисей ', beat: 'вздыхает' }, { character: 'Елисея', beat: 'вздыхает' }],
        dialogueGuidance: [{ character: 'Алёна', tone: 'сухо' }],
      },
      ['Елисей', 'Алена'],
    );
    expect(out.directive).toEqual({
      pacing: 'medium',
      include: { characters: ['Мира'] },
      characterBeats: [{ character: 'Елисея', beat: 'вздыхает' }],
    });
    expect(out.skipped.map((s) => s.path)).toEqual(['directive.characterBeats[0]', 'directive.dialogueGuidance[0]', 'directive.include.characters[0]']);
  });
});

describe('word edges are read by code point (decision A.5)', () => {
  const E = ['Елисей'];
  test('an emoji next to the name or the verb is an edge', () => {
    expect(keeps('😀Елисей думает о брате', E)).toBe(false);
    expect(keeps('Елисей думает😀', E)).toBe(false);
    expect(keeps('мысли Елисея🙂', E)).toBe(false);
    expect(keeps('🙂Merlin realizes the lie', ['Merlin'])).toBe(false);
    expect(keeps("Merlin's🙂 thoughts", ['Merlin'])).toBe(true); // the emoji breaks the possessive: no whitespace before the noun
  });

  test('a letter outside the BMP glued to the name is part of the word, so the name is not there', () => {
    // U+10400 DESERET CAPITAL LONG I is a letter; a \p lookbehind under Bun reads half of it and would match.
    expect(keeps('\u{10400}Елисей думает о брате', E)).toBe(true);
    expect(keeps('Елисей\u{10400} думает о брате', E)).toBe(true);
    expect(keeps('Have \u{10400}Merlin feel it', ['Merlin'])).toBe(true);
    expect(keeps('Have Merlin feel\u{10400} it', ['Merlin'])).toBe(true);
  });

  test('digits and _ are word characters too, as in Bunraku', () => {
    expect(keeps('Merlin2 realizes the lie', ['Merlin'])).toBe(true);
    expect(keeps('_Merlin realizes the lie', ['Merlin'])).toBe(true);
    expect(keeps('Merlin realizes_ the lie', ['Merlin'])).toBe(true);
  });
});
