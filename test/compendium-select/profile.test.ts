// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Profile, limits and the resolved config (D-154, D-158).
import { describe, expect, test } from 'bun:test';
import { COMPENDIUM_LIMITS, compendiumProfile, LITE_WINDOW, resolveCompendium } from '../../src/agents/compendium/profile.ts';
import type { CompendiumConfig } from '../../src/session/entries.ts';

describe('profile and limits', () => {
  test("'full' and 'lite' as set; 'auto' (or unset) is lite below 24 576 tokens", () => {
    expect(LITE_WINDOW).toBe(24_576);
    expect(compendiumProfile('full', 4096)).toBe('full');
    expect(compendiumProfile('lite', 200_000)).toBe('lite');
    expect(compendiumProfile('auto', 24_575)).toBe('lite');
    expect(compendiumProfile('auto', 24_576)).toBe('full');
    expect(compendiumProfile(undefined, 8192)).toBe('lite');
    expect(compendiumProfile(undefined, 131_072)).toBe('full');
  });

  test('the D-154 table', () => {
    expect(COMPENDIUM_LIMITS).toEqual({
      full: { maxEntries: 12, fullChars: 4000, briefChars: 1200, blockTok: Infinity },
      lite: { maxEntries: 6, fullChars: 0, briefChars: 700, blockTok: 1600 },
    });
    expect(Object.isFrozen(COMPENDIUM_LIMITS.full)).toBe(true);
  });
});

const DEFAULTS = {
  enabled: true,
  profile: 'auto',
  language: '',
  guidance: '',
  minShare: 0.4,
  maxAttempts: 3,
  idleDelaySec: 8,
  books: {},
  recall: { mode: 'auto', onMiss: 'auto', minEntries: 0, graceSec: 4, onSwipe: 'reuse', guidance: '' },
  filing: {
    enabled: true,
    wait: 1,
    everyN: 1,
    allow: ['character', 'location', 'item', 'power', 'organization', 'event', 'plot', 'threat', 'worldbuilding', 'creature'],
  },
  historian: { interval: 20, recapAfter: 24 },
};

describe('resolveCompendium', () => {
  test('absent config → enabled with every default; "by profile" values stay absent', () => {
    const r = resolveCompendium(undefined);
    expect(r).toEqual(DEFAULTS as ReturnType<typeof resolveCompendium>);
    expect('maxEntries' in r.recall || 'contextMessages' in r.recall || 'timeoutSec' in r.recall).toBe(false);
    expect('timeoutSec' in r.filing || 'overlap' in r.historian).toBe(false);
  });

  test('an old header with only enabled:false keeps it and gets the rest', () => {
    expect(resolveCompendium({ enabled: false })).toEqual({ ...DEFAULTS, enabled: false } as ReturnType<typeof resolveCompendium>);
  });

  test('every set field is kept, nested tables field by field', () => {
    const c: CompendiumConfig = {
      enabled: true,
      profile: 'lite',
      language: 'ru',
      guidance: 'Only places.',
      minShare: 0.5,
      maxAttempts: 2,
      idleDelaySec: 0,
      books: { lantern: 'off', atlas: 'read' },
      recall: { mode: 'lexical', maxEntries: 5, contextMessages: 10, timeoutSec: 15, onSwipe: 'rerun' },
      filing: { wait: 0, allow: ['location', 'summary'], timeoutSec: 60 },
      historian: { interval: 0, overlap: 4 },
    };
    const r = resolveCompendium(c);
    expect(r).toEqual({
      ...DEFAULTS,
      profile: 'lite',
      language: 'ru',
      guidance: 'Only places.',
      minShare: 0.5,
      maxAttempts: 2,
      idleDelaySec: 0,
      books: { lantern: 'off', atlas: 'read' },
      recall: { ...DEFAULTS.recall, mode: 'lexical', maxEntries: 5, contextMessages: 10, timeoutSec: 15, onSwipe: 'rerun' },
      filing: { ...DEFAULTS.filing, wait: 0, allow: ['location', 'summary'], timeoutSec: 60 },
      historian: { interval: 0, recapAfter: 24, overlap: 4 },
    } as ReturnType<typeof resolveCompendium>);
    // A fresh object: resolving never shares the stored tables.
    r.books.extra = 'off';
    expect(c.books).toEqual({ lantern: 'off', atlas: 'read' });
  });

  test('0 means "by profile" for the optional numbers; an empty allow list is the default', () => {
    const r = resolveCompendium({ enabled: true, recall: { maxEntries: 0, contextMessages: 0, timeoutSec: 0 }, filing: { allow: [] }, historian: { overlap: 0 } });
    expect(r.recall).toEqual(DEFAULTS.recall as typeof r.recall);
    expect(r.filing.allow).toEqual(DEFAULTS.filing.allow as typeof r.filing.allow);
    expect('overlap' in r.historian).toBe(false);
  });

  test('a stored value of the wrong kind reads as its default', () => {
    const bad = {
      enabled: 'yes',
      profile: 'huge',
      minShare: 1.5,
      maxAttempts: Number.NaN,
      books: { a: 'write', b: 'off' },
      recall: 'none',
      filing: { allow: ['spell', 'item'] },
      historian: null,
      min_share: 0.1,
    } as unknown as CompendiumConfig;
    const r = resolveCompendium(bad);
    expect(r).toEqual({ ...DEFAULTS, books: { b: 'off' }, filing: { ...DEFAULTS.filing, allow: ['item'] } } as ReturnType<typeof resolveCompendium>);
  });
});
