// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Freshness (ARCHITECTURE.md §7.4.1, D-80; .notes/m5a-decisions.md D-152): what the Compendium must not
// repeat to the narrator while the messages it was filed from are still in front of it. The rules are
// RoleCall's (lib/ai/tv-stream/compendium-freshness.ts: a summary while its span is live, a plot or an
// event while the turn that filed it is live, a character's memories one by one), re-derived on path
// positions and the fold's provenance instead of message counts and stamped turn numbers, and applied
// to every top-level list. One function serves the block (M5a) and the recall index (M5c). Pure.

import type { TreeIndex } from '../../session/tree.ts';
import type { PathView } from '../../session/view.ts';
import type { CEntry, Rec } from './types.ts';

/**
 * The visible window of a request: every path position is in front of the model except the cut run
 * `cut` (inclusive) that the last request left out. Messages before the cut (a protected head, the
 * greeting) were sent, so they count as visible.
 */
export interface Visibility {
  /** Path positions [from, to] of the oldest and newest message the last request cut; null: nothing cut. */
  cut: readonly [number, number] | null;
  /** Message id → its position on the view's path. */
  pos: ReadonlyMap<string, number>;
}

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The window for a request that answers `upTo` (U): the nearest assistant message on the path before U
 * is the last request; its trace (the trace of its newest `continue` edit when it has one, else its own)
 * says which old messages that request left out: `trimmed = {from, to}` names the oldest and newest
 * message cut (prompt/budget.ts), and the messages before `from` (the protected head) were still sent.
 * `upTo` null is a request that answers no user message (an opening): U's place is after the path's
 * end, so the newest assistant message on the path (the greeting, by its last continue) is the last
 * request. A `from` that cannot be read (not text, not on the path) is taken as the path's start.
 * Nothing is cut (everything visible) when there is no such message, no trace, no cut (`trimmed:
 * null`), a `to` that cannot be read or is not on the path, a `from` after `to`, or when U itself is
 * not on the path.
 */
export function visibilityAt(view: PathView, tree: TreeIndex, upTo: string | null): Visibility {
  const pos = new Map<string, number>();
  view.path.forEach((m, i) => pos.set(m.id, i));
  const at = upTo === null ? view.path.length : pos.get(upTo);
  if (at === undefined) return { cut: null, pos };
  for (let i = at - 1; i >= 0; i--) {
    const m = view.path[i]!;
    if (m.role !== 'assistant') continue;
    let trace = tree.msgs.get(m.id)?.trace;
    for (const e of tree.edits.get(m.id) ?? []) if (e.reason === 'continue' && e.trace) trace = e.trace;
    // Traces are read back leniently (the journal checks only seed, now and lore fires).
    const trimmed: unknown = trace?.trimmed;
    const to = isRecord(trimmed) && typeof trimmed.to === 'string' ? pos.get(trimmed.to) : undefined;
    if (to === undefined) return { cut: null, pos };
    const from = isRecord(trimmed) && typeof trimmed.from === 'string' ? (pos.get(trimmed.from) ?? 0) : 0;
    return { cut: from <= to ? [from, to] : null, pos };
  }
  return { cut: null, pos };
}

/** Whether a message is in front of the model: on the path and not inside the cut. null → false. */
export function isVisible(vis: Visibility, id: string | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  const p = vis.pos.get(id);
  if (p === undefined) return false;
  return vis.cut === null || p < vis.cut[0] || p > vis.cut[1];
}

/**
 * The entry as the narrator may see it (D-152). `entry` null: hidden whole — a summary with a range
 * while its last message is visible; a plot or an event while the message its creating row was bound
 * to is visible. Otherwise a deep copy (sharing nothing mutable with `e`) without the elements of
 * top-level lists whose adding message (`prov.appended[field][j]`) is visible; `prov.appended` of the
 * copy loses the same slots. Notes, arcs, human rows (`on: null`) and library base data are never
 * hidden. `dropped`: 1 for a hidden entry, else the number of list elements dropped (the trace's
 * `hidden` is their sum).
 */
export function visibleCopy(e: CEntry, vis: Visibility): { entry: CEntry | null; dropped: number } {
  if (e.type === 'summary' && e.range !== undefined && isVisible(vis, e.range[1])) return { entry: null, dropped: 1 };
  if ((e.type === 'plot' || e.type === 'event') && isVisible(vis, e.prov.created)) return { entry: null, dropped: 1 };
  const copy = structuredClone(e);
  if (e.type === null) return { entry: copy, dropped: 0 };
  let dropped = 0;
  for (const [field, ons] of Object.entries(e.prov.appended)) {
    const list = e.data[field];
    if (!Array.isArray(list) || !Array.isArray(ons)) continue;
    const keep = list.map((_, j) => !isVisible(vis, ons[j]));
    const gone = keep.filter((k) => !k).length;
    if (gone === 0) continue;
    dropped += gone;
    copy.data[field] = (copy.data[field] as unknown[]).filter((_, j) => keep[j]);
    copy.prov.appended[field] = ons.filter((_, j) => j >= keep.length || keep[j]);
  }
  return { entry: copy, dropped };
}
