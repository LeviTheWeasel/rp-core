// Ported from Bunraku:src/core/director/personalities/types.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi, 0a4580d3), itself RoleCall:apps/rc/src/lib/ai/dm/personalities/types.ts@fb8dc623e
// (Coneja-Chibi: split ca8a2723f, 2793bf923).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shape of one Story Director personality. Left out, as in Bunraku: avatar, accentColor and
// optionalToolBudget. Changed: `id` is the contract's PersonalityId. Only some fields reach a prompt
// (buildSystemPrompt for full, personalityDigest for lite); the rest (description, traits, favoriteArcs,
// moodGuidance…) are data for a picker or `/director` listing.

import type { PersonalityId } from '../types.ts';

export interface DirectorPersonalityDef {
  id: PersonalityId;
  name: string;
  title: string;
  description: string;
  tagline: string;
  traits: {
    pacing: 'slow' | 'balanced' | 'fast';
    drama: 'subtle' | 'moderate' | 'high';
    romance: 'minimal' | 'moderate' | 'focus';
    action: 'minimal' | 'moderate' | 'focus';
    mystery: 'minimal' | 'moderate' | 'focus';
    humor: 'minimal' | 'moderate' | 'focus';
  };
  philosophy: {
    coreBeliefs: string[];
    improvisation: 'rigid' | 'adaptive' | 'fluid';
    playerAgency: 'guided' | 'collaborative' | 'freeform';
    informationControl: 'tight' | 'moderate' | 'loose';
  };
  preferences: { favoriteArcs: string[]; signatureTropes: string[]; pacingRhythm: string; emotionalFocus: string[] };
  improvisation: { whenPlayerDiverts: string; whenPlanFails: string; backupPlanStrategy: string; yesAndPhilosophy: string };
  /** What never leaks to the narrator, and the safe and unsafe directive examples. */
  directiveSafety: {
    neverReveal: string[];
    hintingStyle: string;
    moodGuidance: string;
    exampleSafeDirective: string;
    exampleUnsafeDirective: string;
  };
  /** The stages the planner works through before it writes its plan. */
  planningFramework: string;
  /** The full prompt's personality block (without the shared footer). */
  buildSystemPrompt: () => string;
}
