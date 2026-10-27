// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Derived views of a session (ARCHITECTURE.md §5.4 MessageView, §5.11 PathView). Computed by
// fold.ts from the log; never stored. CONTRACT FILE (types only).

import type { Block, Generation, Trace } from './entries.ts';
import type { CompendiumView } from '../agents/compendium/types.ts';

export interface MessageView {
  id: string;
  parent: string | null;
  role: 'user' | 'assistant';
  /** Effective blocks: the original ones replaced by the latest edit that carries blocks. */
  blocks: Block[];
  gen?: Generation;
  hidden: boolean;
  edited: boolean;
  /** Position among siblings (ordered by seq) and the sibling count. */
  swipe: { index: number; count: number };
}

/**
 * PathView. Fields reserved for later milestones (directorAt M4) are added then; consumers must
 * only read what is declared here.
 */
export interface PathView {
  session: string;
  head: string | null;
  version: number;
  /** Root → head. Hidden messages are included and flagged. */
  path: MessageView[];
  pathSet: Set<string>;
  /** Leaves that are not on the active path. */
  tails: string[];
  /** Variables folded along the path: vars0, then every committed diff on path messages (null deletes). */
  vars: Record<string, string | number>;
  /**
   * Lore fires from traces on the path (M2 timers); empty in M1a sessions. `continued`: the fires of a
   * continue edit of the message (that scan ran one message later, at the message's index + 1).
   * `names`: the trace's book names by source key (Trace.loreNames), so timers follow a world that is
   * read under another key later (§10.3 "a book is read once by name").
   */
  fires: { msgId: string; fired: Trace['lore']['fired']; continued?: true; names?: Record<string, string> }[];
  /** Path messages that have at least one continue edit (each continue was a lore scan, M2 timers). */
  continued?: ReadonlySet<string>;
  /** Names and aliases of the card and persona. */
  castNames: string[];
  /**
   * M3 (§5.8): the Compendium folded along this path (rows with `on` null or on the path). M3 holds
   * only human notes; the notes lore book is derived from it (agents/compendium/notes.ts notesBook).
   */
  compendium: CompendiumView;
}
