// Ported from Bunraku:src/core/assembly/guided-swipe.ts@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The guided re-roll block (ARCHITECTURE.md §6.3, D-41). The directive wording is RoleCall's
// buildGuidedSwipeDirective (apps/rc/src/lib/ai/guided-swipe.ts), which Bunraku ported verbatim:
// it leads with the rewind, says the draft never happened and names where to begin, with the
// negations last. Changed for the core: RoleCall and Bunraku send the rejected draft as an
// assistant message followed by a system directive, which Anthropic rejects mid-dialogue (§8.5).
// Here everything is ONE system block at depth 0; the draft sits at its end under the
// REJECTED_DRAFT_LABEL, fenced so prose that imitates a directive (or its end marker) reads as a
// quotation. The draft is cut to 2 000 characters; without a draft the wording drops its references
// to one.

/** The longest guidance a turn takes (§6.3). Longer text is cut, never rejected here. */
export const GUIDANCE_MAX = 10_000;
/** How much of the rejected draft the block quotes (§6.3, D-41). */
export const REJECTED_MAX = 2_000;
/** Marks the rejected draft inside the content itself (RoleCall's REJECTED_DRAFT_LABEL). */
export const REJECTED_DRAFT_LABEL = '[REJECTED DRAFT - NOT PART OF THE STORY]';

/** The first `max` code points of `text` (never half a surrogate pair); `…` marks a cut. */
export function clip(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max - 1).join('') + '…';
}

/** A backtick fence one longer than any backtick run in the text, so the text cannot close it. */
export function fence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const bar = '`'.repeat(Math.max(3, longest + 1));
  return `${bar}\n${text}\n${bar}`;
}

/**
 * The block's text. `guidance` is the user's direction (identity macros already applied by the
 * caller); `rejected` is the replaced answer, inert model output, or undefined when the session does
 * not show it (`swipe.showRejected = false`).
 */
export function guidanceText(guidance: string, rejected?: string): string {
  const direction = clip(guidance.trim(), GUIDANCE_MAX);
  const draft = rejected !== undefined && rejected.trim() !== '' ? clip(rejected, REJECTED_MAX) : undefined;
  if (draft === undefined) {
    return [
      '<<<MANDATORY GUIDED SWIPE DIRECTIVE>>>',
      'REWIND. The previous draft of this reply was rejected. It was never sent.',
      'The character never said or did any of it. The scene has NOT moved past',
      "the user's last message.",
      '',
      "Write the character's reply to that user message again, starting from the",
      'same story moment. Your text replaces the draft entirely.',
      '',
      'USER DIRECTION:',
      direction,
      '<<<END GUIDED SWIPE DIRECTIVE>>>',
    ].join('\n');
  }
  return [
    '<<<MANDATORY GUIDED SWIPE DIRECTIVE>>>',
    'REWIND. The draft quoted at the end of this directive was rejected. It was',
    'never sent. The character never said or did any of it. The scene has NOT',
    "moved past the user's last message.",
    '',
    "Write the character's reply to that user message again, starting from the",
    'same story moment the draft started from. Your text replaces the draft',
    'entirely.',
    '',
    'USER DIRECTION:',
    direction,
    '',
    'Read the draft only to see what to avoid, then write as if it never',
    'existed. Do not continue it, extend it, or refer to it.',
    '',
    REJECTED_DRAFT_LABEL,
    fence(draft),
    '<<<END GUIDED SWIPE DIRECTIVE>>>',
  ].join('\n');
}
