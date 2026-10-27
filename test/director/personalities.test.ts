// Ported from RoleCall:apps/rc/src/lib/ai/dm/__tests__/personalities.test.ts@fb8dc623e (Coneja-Chibi:
// 56742b14e, 67253aa06; NemoVonNirgend: 8dd337172) and the "personalities" tests of
// Bunraku:src/core/director/prompts.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ten Director personalities (D-64, D-111). Changed from RoleCall: the default is Sage, not the
// Weaver, and an unknown id gives Sage instead of undefined (D-64; RoleCall's own callers defaulted to
// Sage); the avatar / accentColor checks are gone (not ported). Added: the D-111 text fixes, the lite
// digest (D-102), every id rendering in both profiles.
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PERSONALITY,
  PERSONALITIES,
  SHARED_PERSONALITY_GUIDANCE,
  getPersonality,
  personalityDigest,
  personalityPrompt,
} from '../../src/agents/director/personalities/index.ts';
import { systemPrompt } from '../../src/agents/director/prompt.ts';
import { DIRECTOR_PERSONALITIES } from '../../src/agents/director/types.ts';

/** Text that names tools, outputs or state sections the planner does not have (Bunraku's STALE, plus the D-111 ghosts). */
const STALE =
  /batch_update|set_directive|update_analysis|read_compendium_entry|update_relationship|add_arc\b|plant_seed|surface_invisible_arc|SINGLE JSON|Your Output Format|Game State Updates|dossier|commit_planning_round|characterSecrets|worldState|coreMemories|revealCondition|world AI/;

describe('DM personality registry', () => {
  test('exposes 10 personalities', () => {
    expect(PERSONALITIES).toHaveLength(10);
  });

  test('registers each personality with a unique id', () => {
    const ids = PERSONALITIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Changed: RoleCall's registry defaulted to the Weaver; rp-core (D-64) and every RoleCall caller use Sage.
  test('default personality is THE_BALANCED (Sage)', () => {
    expect(DEFAULT_PERSONALITY).toBe('the-balanced');
    expect(getPersonality(DEFAULT_PERSONALITY).name).toBe('Sage');
  });

  test('getPersonality finds known ids', () => {
    expect(getPersonality('the-weaver').id).toBe('the-weaver');
    expect(getPersonality('the-architect').id).toBe('the-architect');
    expect(getPersonality('the-balanced').id).toBe('the-balanced');
  });

  // Changed: an unknown id is Sage (D-111), not undefined.
  test('getPersonality returns Sage for unknown ids', () => {
    expect(getPersonality('unknown').id).toBe('the-balanced');
    expect(getPersonality('').id).toBe('the-balanced');
    expect(getPersonality('  the-jester  ').id).toBe('the-jester');
    expect(getPersonality('The-Jester').id).toBe('the-balanced');
  });

  test('each personality has a buildSystemPrompt returning a non-empty string', () => {
    for (const p of PERSONALITIES) {
      const prompt = p.buildSystemPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    }
  });

  // Changed: no avatar or accentColor (not ported).
  test('each personality has all required identity fields', () => {
    for (const p of PERSONALITIES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.tagline).toBeTruthy();
    }
  });

  describe('personalityPrompt helper', () => {
    test("returns the personality's prompt for a known id", () => {
      // The shared anti-repetition + register-tempering guidance is appended, so it CONTAINS the raw prompt.
      expect(personalityPrompt('the-architect')).toContain(getPersonality('the-architect').buildSystemPrompt());
    });

    test('appends the shared anti-repetition + register-tempering guidance', () => {
      const result = personalityPrompt('the-architect');
      expect(result).toContain('Anti-Repetition');
      expect(result).toContain("never overrides the story's primary register");
    });

    test('falls back to the default personality for unknown ids', () => {
      expect(personalityPrompt('unknown')).toContain(getPersonality(DEFAULT_PERSONALITY).buildSystemPrompt());
    });

    test('falls back to the default for null/undefined', () => {
      expect(personalityPrompt(null)).toContain(getPersonality(DEFAULT_PERSONALITY).buildSystemPrompt());
      expect(personalityPrompt(undefined)).toContain(getPersonality(DEFAULT_PERSONALITY).buildSystemPrompt());
    });
  });
});

describe('personalities', () => {
  test("there are RoleCall's ten, in its order, one per id the settings accept; Sage is the default and what an unknown id means", () => {
    expect(PERSONALITIES.map((p) => p.id)).toEqual([...DIRECTOR_PERSONALITIES]);
    expect(DEFAULT_PERSONALITY).toBe('the-balanced');
    expect(getPersonality(undefined).name).toBe('Sage');
    expect(getPersonality('the-nobody').id).toBe('the-balanced');
    expect(getPersonality('the-weaver').name).toBe('Meridian');
    expect(getPersonality('the-jester').name).toBe('Felix');
  });

  test.each(PERSONALITIES.map((p) => [p.id] as const))(
    '%s renders its block and the shared footer, and tells the planner nothing about JSON output or tools it lacks',
    (id) => {
      const text = personalityPrompt(id);
      expect(text).toContain(getPersonality(id).name);
      expect(text.endsWith(SHARED_PERSONALITY_GUIDANCE)).toBe(true);
      expect(text).not.toMatch(STALE);
      expect(text).not.toMatch(/output your JSON/i);
      expect(text).not.toMatch(/OUTPUT STRUCTURE/);
      expect(text).toContain('## STAGE');
      expect(text).not.toContain(String.fromCharCode(0x2014));
      expect(text).not.toContain('${');
    },
  );

  test("the picker's data is whole: identity, beliefs, favorite arcs, emotional focus", () => {
    for (const p of PERSONALITIES) {
      expect([p.name, p.title, p.tagline, p.description].every((s) => s.length > 0)).toBe(true);
      expect(p.philosophy.coreBeliefs.length).toBeGreaterThan(0);
      expect(p.preferences.favoriteArcs.length).toBeGreaterThan(0);
      expect(p.preferences.emotionalFocus.length).toBeGreaterThan(0);
    }
  });
});

describe('the D-111 text fixes', () => {
  test("the weaver's STAGE 9 tracks the off-screen world as invisible arcs with a surfaceCondition", () => {
    const fw = getPersonality('the-weaver').planningFramework;
    const stage9 = fw.slice(fw.indexOf('## STAGE 9'));
    expect(stage9).toContain('Track these as invisible arcs (invisibleArcUpdates):');
    expect(stage9).toContain('surfaceCondition');
    expect(stage9).toContain('"npc_agenda"');
  });

  test("the oracle's hidden NPC layers are invisible arcs with a surfaceCondition", () => {
    const fw = getPersonality('the-oracle').planningFramework;
    expect(fw).toContain('Track these as invisible arcs (invisibleArcUpdates, arcType "npc_agenda") with a surfaceCondition.');
  });

  test("the architect's orphan line is gone and its framework still ends on the closing motto", () => {
    const fw = getPersonality('the-architect').planningFramework;
    expect(fw).not.toContain('My private planning');
    expect(fw).toContain('---\n\nRemember: Everything except directive is MY SECRET EMOTIONAL ARCHITECTURE.');
  });

  test('every personality, as sent in either profile, is free of ghost sections and tool names', () => {
    for (const style of DIRECTOR_PERSONALITIES) {
      for (const profile of ['full', 'lite'] as const) {
        const text = systemPrompt({ profile, transport: 'structured', style, creativity: 'moderate', charName: 'Vera' });
        expect(text).not.toMatch(STALE);
      }
    }
  });
});

describe('the lite digest', () => {
  test.each(PERSONALITIES.map((p) => [p.id] as const))('%s: name, title, tagline, beliefs, pacing rhythm and hinting style, ≈ 0.9–1.3k chars', (id) => {
    const p = getPersonality(id);
    const digest = personalityDigest(p);
    expect(digest.startsWith(`## Your Storytelling Personality: ${p.name} "${p.title}"\n${p.tagline}\n`)).toBe(true);
    for (const b of p.philosophy.coreBeliefs) expect(digest).toContain(`- ${b}`);
    expect(digest).toContain('### Pacing Rhythm');
    expect(digest).toContain('### Directive Safety');
    expect(digest.length).toBeGreaterThan(800);
    expect(digest.length).toBeLessThan(1_400);
    // Not the full block.
    expect(digest).not.toContain('## STAGE');
    expect(digest).not.toContain('Example Safe');
    // Indentation of the source text is gone.
    expect(digest.split('\n').some((l) => l.startsWith(' '))).toBe(false);
  });

  test('every id renders in both profiles and both transports, with its own name', () => {
    for (const style of DIRECTOR_PERSONALITIES) {
      const p = getPersonality(style);
      for (const profile of ['full', 'lite'] as const) {
        for (const transport of ['structured', 'tagged'] as const) {
          const text = systemPrompt({ profile, transport, style, creativity: 'moderate', charName: 'Vera', schemaText: '{"type":"object"}' });
          expect(text).toContain(`## Your Storytelling Personality: ${p.name} "${p.title}"`);
        }
      }
    }
  });
});
