// Ported from Bunraku:src/core/director/personalities/index.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi, 0a4580d3), itself RoleCall:apps/rc/src/lib/ai/dm/personalities/index.ts@fb8dc623e
// (Coneja-Chibi: split ca8a2723f; NemoVonNirgend: SHARED_PERSONALITY_GUIDANCE, 8dd337172).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ten Story Director personalities in picker order, the shared footer, and the lite digest.
// An unknown or absent id is Sage, `the-balanced` [D-64, D-111]: RoleCall's getDefaultPersonality
// answered the Weaver, but its settings and picker default to Sage. Changed: `personalityOf` is
// `getPersonality` (the id is trimmed first); `personalityDigest` is new (D-102: the lite system prompt
// reads a personality's own fields, no new text).

import { DEFAULT_PERSONALITY } from '../types.ts';
import { THE_ARCHITECT } from './the-architect.ts';
import { THE_BALANCED } from './the-balanced.ts';
import { THE_CHRONICLER } from './the-chronicler.ts';
import { THE_ENIGMA } from './the-enigma.ts';
import { THE_JESTER } from './the-jester.ts';
import { THE_ORACLE } from './the-oracle.ts';
import { THE_ROMANTIC } from './the-romantic.ts';
import { THE_SHADOW } from './the-shadow.ts';
import { THE_THRILL_SEEKER } from './the-thrill-seeker.ts';
import { THE_WEAVER } from './the-weaver.ts';
import type { DirectorPersonalityDef } from './types.ts';

export type { DirectorPersonalityDef } from './types.ts';
export { DEFAULT_PERSONALITY } from '../types.ts';

/** Picker order, the same as DIRECTOR_PERSONALITIES. */
export const PERSONALITIES: readonly DirectorPersonalityDef[] = [
  THE_WEAVER,
  THE_ARCHITECT,
  THE_ORACLE,
  THE_ROMANTIC,
  THE_THRILL_SEEKER,
  THE_SHADOW,
  THE_JESTER,
  THE_ENIGMA,
  THE_CHRONICLER,
  THE_BALANCED,
];

const BY_ID: ReadonlyMap<string, DirectorPersonalityDef> = new Map(PERSONALITIES.map((p) => [p.id, p]));

/** The personality for `director.style`; unknown, blank or absent → Sage. */
export function getPersonality(id: string | null | undefined): DirectorPersonalityDef {
  return BY_ID.get(id?.trim() ?? DEFAULT_PERSONALITY) ?? THE_BALANCED;
}

/**
 * Appended to every personality's block (RoleCall SHARED_PERSONALITY_GUIDANCE): the personalities
 * describe a lane, not a script, and flavor delivery, never the story's register.
 */
export const SHARED_PERSONALITY_GUIDANCE = `

---

### Vary Within Your Lane (Anti-Repetition)
Do not reuse the same beats, phrasings, NPC behaviors, atmospheres, or "signature" devices turn-to-turn. The arcs, tropes, and examples above describe your *tendencies and flavor* - they are not a checklist to replay or a fixed set of moves to cycle through. Vary your choices within your personality's lane; choose freshness over formula every turn.

### Personality Flavors Delivery, Never Register
Your personality flavors the DELIVERY; it never overrides the story's primary register/genre. Even a darker/edgier personality defers to an erotic/romance/slice-of-life register - flavor it, don't convert it. Stay in the story's lane and color it with your voice.`;

/** The full system prompt's personality block: its own text, then the shared footer. */
export function personalityPrompt(id: string | null | undefined): string {
  return getPersonality(id).buildSystemPrompt() + SHARED_PERSONALITY_GUIDANCE;
}

/** Each line without its leading indentation (the source texts are indented for the code, not the model). */
const flush = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

/**
 * The lite system prompt's personality block (D-102), ≈ 0.9–1.3k chars: name, title, tagline, core
 * beliefs, pacing rhythm and hinting style, all from the personality's own fields.
 */
export function personalityDigest(p: DirectorPersonalityDef): string {
  return `## Your Storytelling Personality: ${p.name} "${p.title}"
${p.tagline}

### Core Philosophy
${p.philosophy.coreBeliefs.map((b) => `- ${b}`).join('\n')}

### Pacing Rhythm
${flush(p.preferences.pacingRhythm)}

### Directive Safety
${flush(p.directiveSafety.hintingStyle)}`;
}
