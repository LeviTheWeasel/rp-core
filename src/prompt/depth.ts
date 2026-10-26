// Ported from Bunraku:src/core/assembly/conversation.ts (injectAtDepth)@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE depth function (ARCHITECTURE.md §10.1, D-12, D-47). ST convention: an insert at depth d has
// exactly d chat messages after it. d = 0: after the last message; d = 1: right above the current
// user message; d >= count: before the first. Equal depth: order ascending, then source rank
// preset < author_note < card_depth < lore < compendium < director < guidance. The first four are
// SillyTavern's (openai.js populationInjectionPrompts): at one depth, order and role it sends the
// preset's in-chat prompts, then its extension prompts in key order — author's note, the card's
// depth prompt, world info. Lore depth inserts all carry ST's extension-prompt order 100 (place.ts):
// an entry's own `order` sorts it among the lore only.
// Blocks stay separate (named deviation from ST, which merges same depth/order/role) [D-47].
// CONTRACT FILE: signatures are fixed; the prompt agent implements the bodies.
//
// Port notes: Bunraku counts RoleCall depth (0 = before the current user message) and walks the
// message list with a depth→index map. Here the ST convention is computed directly: every insert
// gets a slot index (chat.length - depth, clamped), inserts are sorted once, then interleaved.

import type { PromptMsg } from '../providers/types.ts';
import type { ChatRole } from '../formats/native.ts';

export type InsertSource = 'preset' | 'lore' | 'compendium' | 'card_depth' | 'author_note' | 'director' | 'guidance';

export interface DepthInsert {
  depth: number;
  role: ChatRole;
  order?: number;
  src: InsertSource;
  /** Trace label, e.g. the preset block id. */
  srcId?: string;
  text: string;
}

/** ST's injection order when a block names none (extension prompts default to 100 there). */
export const DEFAULT_INSERT_ORDER = 100;

/**
 * Tie-break at equal depth and order: lower rank sits higher, so the Director (and guidance) end up
 * closest to the chat message below them, where the model weighs them most (§10.1).
 */
export const SOURCE_RANK: Readonly<Record<InsertSource, number>> = {
  preset: 0,
  author_note: 1,
  card_depth: 2,
  lore: 3,
  compendium: 4,
  director: 5,
  guidance: 6,
};

/** The PromptMsg.src an insert carries into the trace: 'preset:<id>' when it names one, else the bare source. */
export function insertSrc(insert: Pick<DepthInsert, 'src' | 'srcId'>): string {
  return insert.srcId ? `${insert.src}:${insert.srcId}` : insert.src;
}

/** True for a PromptMsg made by injectAtDepth (its src starts with an InsertSource). */
export function isInsertSrc(src: string): boolean {
  const head = src.split(':', 1)[0] ?? '';
  return Object.prototype.hasOwnProperty.call(SOURCE_RANK, head);
}

/** Depth as a non-negative integer; NaN (a broken import) behaves like 0 rather than vanishing. */
function normDepth(depth: number): number {
  if (Number.isNaN(depth)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(depth)));
}

function normOrder(order: number | undefined): number {
  return order === undefined || Number.isNaN(order) ? DEFAULT_INSERT_ORDER : order;
}

/** -1 / 0 / 1 without subtraction, so ±Infinity orders cannot produce NaN. */
function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Insert into the chat area. `chat` holds only chat messages (greeting, history, current user message).
 *
 * Inserts whose text is blank are skipped: ST drops empty injections too, and several providers
 * reject an empty message. Depths past the chat all land before the first message, deeper ones
 * higher (ST's reversed-splice order), then by order and source rank as at any equal depth.
 */
export function injectAtDepth(chat: readonly PromptMsg[], inserts: readonly DepthInsert[]): PromptMsg[] {
  const n = chat.length;
  const placed = inserts
    .map((ins, index) => {
      const depth = normDepth(ins.depth);
      // `at`: index of the chat message the insert goes in front of (n = after the last one).
      return { ins, index, depth, at: n - Math.min(depth, n), order: normOrder(ins.order) };
    })
    .filter((p) => p.ins.text.trim() !== '')
    .sort(
      (a, b) =>
        a.at - b.at ||
        cmp(b.depth, a.depth) || // only differs among depths clamped to "before the first"
        cmp(a.order, b.order) ||
        SOURCE_RANK[a.ins.src] - SOURCE_RANK[b.ins.src] ||
        a.index - b.index, // stable: input order breaks the last tie
    );

  const out: PromptMsg[] = [];
  let k = 0;
  for (let pos = 0; pos <= n; pos++) {
    for (; k < placed.length && placed[k]!.at === pos; k++) out.push(toMsg(placed[k]!.ins));
    if (pos < n) out.push(chat[pos]!);
  }
  return out;
}

/** One insert, one message: never merged with a neighbour, so the trace sees every source [D-47]. */
function toMsg(ins: DepthInsert): PromptMsg {
  return { role: ins.role, blocks: [{ k: 'text', text: ins.text }], src: insertSrc(ins), placement: 'inline' };
}

/** RoleCall/Bunraku in-chat depth → core depth: d + 1. Only importers call this [D-47]. */
export function fromRcDepth(d: number): number {
  return d + 1;
}
