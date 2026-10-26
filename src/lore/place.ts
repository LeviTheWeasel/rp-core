// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Where fired lore goes (ARCHITECTURE.md §10.2, §10.3 step 9, §10.1). Pure grouping in ST order:
// within every place, entries sorted by `order` ascending, ties in REVERSE acceptance order. ST
// sorts the activated entries by order descending (stable over activation order) and unshifts each
// into its place, so the highest order ends up last, nearest the chat, and of two entries with the
// same order the one activated later comes first (the SillyBunny golden snapshots 03 and 05 show it).
// assemble re-sorts examples_before, which ST unshifts a second time (assemble/lore.ts).
// - before / after / examples_before / examples_after → the {{lore::x}} slots (assemble joins with
//   '\n' and applies wi_format; the examples slots are formatted like {{examples}});
// - note_before / note_after → around the author's note (ST: AN top / AN bottom);
// - top / bottom → the top / bottom of the prompt;
// - recap → where {{recap}} goes (M5); until then assemble puts it right before the chat area;
// - { outlet } → the {{outlet::name}} slot (sent only where a preset names it, as in ST);
// - { depth, role } → one DepthInsert per entry, src 'lore', srcId entryLabel(), no order of its
//   own: ST puts all world info of one depth and role into its order-100 extension-prompt group,
//   after the author's note and the card's depth prompt, so an entry's `order` only sorts it among
//   the lore (the inserts come out in that order and depth.ts keeps input order on ties). ST merges
//   same-depth same-role entries into one message; the core keeps them apart so the trace sees
//   every source — the named D-47 deviation.
// CONTRACT FILE: signatures are fixed; the lore agent implements the bodies.
//
// As in ST (world-info.js checkWorldInfo, prompt building): an entry with empty text is not placed,
// an outlet entry without a name is dropped, and a depth entry without a role is a system message.

import type { DepthInsert } from '../prompt/depth.ts';
import { DEFAULT_LORE_ORDER, entryLabel, type LoreHit } from './engine.ts';

export type LoreSlotName = 'before' | 'after' | 'examples_before' | 'examples_after';

export interface LorePlacement {
  slots: Record<LoreSlotName, string[]>;
  noteBefore: string[];
  noteAfter: string[];
  top: string[];
  bottom: string[];
  recap: string[];
  /** Outlet name → texts. Names compare as written, trimmed. */
  outlets: Record<string, string[]>;
  depth: DepthInsert[];
}

export function placeLore(fired: readonly LoreHit[]): LorePlacement {
  const out: LorePlacement = {
    slots: { before: [], after: [], examples_before: [], examples_after: [] },
    noteBefore: [],
    noteAfter: [],
    top: [],
    bottom: [],
    recap: [],
    // No prototype: an outlet may be called anything, '__proto__' included.
    outlets: Object.create(null) as Record<string, string[]>,
    depth: [],
  };
  const orderOf = (h: LoreHit): number => h.entry.order ?? DEFAULT_LORE_ORDER;
  const sorted = fired.map((h, i) => ({ h, i })).sort((a, b) => orderOf(a.h) - orderOf(b.h) || b.i - a.i);
  for (const { h } of sorted) {
    if (h.text === '') continue;
    const p = h.entry.position;
    switch (p) {
      case 'before':
      case 'after':
      case 'examples_before':
      case 'examples_after':
        out.slots[p].push(h.text);
        break;
      case 'note_before':
        out.noteBefore.push(h.text);
        break;
      case 'note_after':
        out.noteAfter.push(h.text);
        break;
      case 'top':
        out.top.push(h.text);
        break;
      case 'bottom':
        out.bottom.push(h.text);
        break;
      case 'recap':
        out.recap.push(h.text);
        break;
      default:
        if ('depth' in p) {
          out.depth.push({
            depth: p.depth,
            role: p.role ?? 'system',
            src: 'lore',
            srcId: entryLabel(h.book, h.id),
            text: h.text,
          });
        } else if ('outlet' in p) {
          const name = p.outlet.trim();
          if (name) (out.outlets[name] ??= []).push(h.text);
        }
    }
  }
  return out;
}
