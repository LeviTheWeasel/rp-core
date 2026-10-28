// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-183, section J: the story's language for the Compendium agents when compendium.language is blank.
import { describe, expect, test } from 'bun:test';
import { storyLanguage } from '../../src/agents/compendium/language.ts';
import { filingUser } from '../../src/agents/compendium/filing.ts';

describe('storyLanguage', () => {
  test('names the language of a dominant non-Latin script; Latin and mixed texts name nothing', () => {
    expect(storyLanguage(['Марфа кивнула и налила гостю щей.'])).toBe('Russian');
    // A few English words in a Russian story do not change it.
    expect(storyLanguage(['Марфа кивнула, налила гостю горячих щей и сказала: «Ok, садись к печи, путник».'])).toBe('Russian');
    expect(storyLanguage(['Вона кивнула і всміхнулася.'])).toBe('Ukrainian');
    expect(storyLanguage(['Ён кіўнуў і ўсміхнуўся.'])).toBe('Belarusian');
    expect(storyLanguage(['Ђорђе је дошао кући.'])).toBe('Serbian');
    expect(storyLanguage(['Η Μαρία χαμογέλασε.'])).toBe('Greek');
    expect(storyLanguage(['彼女は微笑んだ。'])).toBe('Japanese');
    expect(storyLanguage(['她笑了。'])).toBe('Chinese');
    expect(storyLanguage(['그녀는 미소 지었다.'])).toBe('Korean');
    expect(storyLanguage(['She smiled and poured the soup.'])).toBeNull();
    expect(storyLanguage(['Ella sonrió.'])).toBeNull();
    expect(storyLanguage(['Half русский half English text here and here and here'])).toBeNull();
    expect(storyLanguage([])).toBeNull();
    expect(storyLanguage(['123 … !!!'])).toBeNull();
  });

  test('reads the newest texts first, up to a sample', () => {
    const old = 'She smiled. '.repeat(3000);
    expect(storyLanguage([old, 'Марфа кивнула. '.repeat(2000)])).toBe('Russian');
  });
});

describe('the language tail of the filing user text', () => {
  test('a named language is the last line; a blank one adds nothing (Bunraku exactly)', () => {
    const ex = [{ user: ['Кто ты?'], reply: 'Фрол кивнул.' }];
    expect(filingUser(ex)).toBe('The narrator just wrote this reply:\n\nФрол кивнул.\n\nThe reply answers:\nКто ты?\n\nFile anything that meets the rules above.');
    expect(filingUser(ex, 'Russian')).toEndWith('File anything that meets the rules above.\n\nWrite every field value in Russian.');
  });
});
