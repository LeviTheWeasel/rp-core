// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What the REPL reads from a session's journal beyond the PathView (ARCHITECTURE.md §5.3, §5.7,
// §11, §12.4): the current config (/model, /note, the banner), sibling ids (/[ /], greeting
// swipes), the first words of tails (/tails), id prefixes (/goto), usage and cost over the path
// (/usage), and the last answer's trace (/trace). Pure functions over (header, entries); repl.ts
// reads the file with session/log.ts readSessionFile (read-only, no lock).

import type { Entry, Generation, SessionConfig, SessionHeader, Trace } from '../session/entries.ts';
import { currentConfig } from '../session/fold.ts';
import { buildTree, effectiveMessage, swipeSiblings, type TreeIndex } from '../session/tree.ts';
import type { Usage } from '../providers/types.ts';

export interface Journal {
  header: SessionHeader;
  entries: readonly Entry[];
  tree: TreeIndex;
}

export function journalOf(header: SessionHeader, entries: readonly Entry[]): Journal {
  return { header, entries, tree: buildTree(entries) };
}

/** The session's config now: header + every config patch (what the next turn reads). */
export function configOf(j: Journal): SessionConfig {
  return currentConfig(j.header, j.entries);
}

/**
 * The versions of `id` that /[ /] browse, in seq order (swipe order): siblings of the same role and
 * kind (session/tree.ts swipeSiblings, which the view's swipe i/n counts too). A player's line sent
 * after a rewind sits beside the old answers but is a branch, not a version. [] for an unknown id.
 */
export function siblingIds(j: Journal, id: string): string[] {
  return swipeSiblings(j.tree, id);
}

/** The text blocks of a message as it reads now (edits applied). */
export function textOfMessage(j: Journal, id: string): string {
  let s = '';
  for (const b of effectiveMessage(j.tree, id).blocks) if (b.k === 'text') s += b.text;
  return s;
}

/** The first words of `text` on one line, at most `max` characters (an ellipsis marks a cut). */
export function firstWords(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface TailRow {
  id: string;
  role: 'user' | 'assistant';
  /** Messages from the root down to the tail. */
  depth: number;
  words: string;
}

/** One row per tail id, in the order given (PathView.tails: oldest first). Unknown ids are skipped. */
export function tailRows(j: Journal, tails: readonly string[]): TailRow[] {
  const out: TailRow[] = [];
  for (const id of tails) {
    const m = j.tree.msgs.get(id);
    if (!m) continue;
    let depth = 0;
    for (let cur: string | null = id; cur !== null; cur = j.tree.msgs.get(cur)?.parent ?? null) depth++;
    out.push({ id, role: m.role, depth, words: firstWords(textOfMessage(j, id)) });
  }
  return out;
}

/** /goto: a full id or a unique prefix of one. */
export function resolveMessageId(j: Journal, prefix: string): { ok: true; id: string } | { ok: false; message: string } {
  const p = prefix.toLowerCase();
  if (j.tree.msgs.has(p)) return { ok: true, id: p };
  const hits = [...j.tree.msgs.keys()].filter((id) => id.startsWith(p));
  if (hits.length === 1) return { ok: true, id: hits[0]! };
  if (hits.length === 0) return { ok: false, message: `no message starts with "${prefix}"` };
  return { ok: false, message: `"${prefix}" matches ${hits.length} messages (${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ', …' : ''}); type more of the id` };
}

// ---- usage and cost (§11) --------------------------------------------------------------------------

export interface UsageSummary {
  /** Generations counted: answers and continue additions on the path that recorded a gen. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Generations whose usage the provider did not report. */
  noUsage: number;
  /** USD; null when no generation could be priced. */
  costUsd: number | null;
  /** Generations with usage but neither a provider cost nor a price row. */
  unpriced: number;
}

export type PriceTable = Readonly<Record<string, { inPerM: number; outPerM: number }>>;

/**
 * Usage over the path: each answer's own generation plus every continue that extended it (a
 * continue's gen replaces the message's gen in the view, so the view alone would lose the original
 * call). Cost: the provider-reported figure first, else the price table, else unpriced (never 0, §11).
 */
export function pathUsage(j: Journal, pathIds: readonly string[], prices: PriceTable): UsageSummary {
  const sum: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, noUsage: 0, costUsd: null, unpriced: 0 };
  const add = (gen: Generation | undefined): void => {
    if (!gen || gen.kind !== 'model') return;
    sum.calls++;
    const u: Usage | undefined = gen.usage;
    if (!u || (u.inputTotal === undefined && u.outputTotal === undefined && u.cost === undefined)) {
      sum.noUsage++;
      return;
    }
    sum.inputTokens += u.inputTotal ?? 0;
    sum.outputTokens += u.outputTotal ?? 0;
    let cost: number | null = null;
    if (typeof u.cost === 'number' && Number.isFinite(u.cost)) cost = u.cost;
    else {
      const row = gen.connection !== undefined && gen.model !== undefined ? prices[`${gen.connection}:${gen.model}`] : undefined;
      if (row && u.inputTotal !== undefined && u.outputTotal !== undefined) {
        cost = (u.inputTotal * row.inPerM + u.outputTotal * row.outPerM) / 1_000_000;
      }
    }
    if (cost === null) sum.unpriced++;
    else sum.costUsd = (sum.costUsd ?? 0) + cost;
  };
  for (const id of pathIds) {
    add(j.tree.msgs.get(id)?.gen);
    for (const e of j.tree.edits.get(id) ?? []) if (e.reason === 'continue') add(e.gen);
  }
  return sum;
}

// ---- trace (§5.7) ------------------------------------------------------------------------------------

/** The newest trace of message `id`: its latest continue's, else its own. null when it has none. */
export function latestTrace(j: Journal, id: string): { trace: Trace; gen?: Generation; continued: boolean } | null {
  const m = j.tree.msgs.get(id);
  if (!m) return null;
  const edits = j.tree.edits.get(id) ?? [];
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.reason === 'continue' && e.trace) return e.gen ? { trace: e.trace, gen: e.gen, continued: true } : { trace: e.trace, continued: true };
  }
  if (!m.trace) return null;
  return m.gen ? { trace: m.trace, gen: m.gen, continued: false } : { trace: m.trace, continued: false };
}

/**
 * The context window to show in the banner: the window the last answer by this exact binding was
 * assembled for (it already went through caps, probes and the session's own cap), else the
 * [caps."conn:model"] override, capped by the session's `window`. null when nothing says.
 */
export function windowFor(
  j: Journal,
  pathIds: readonly string[],
  binding: { conn: string; model: string },
  capsOverrides: Readonly<Record<string, { contextLength?: number }>>,
  sessionWindow: number | undefined,
): number | null {
  let w: number | null = null;
  for (let i = pathIds.length - 1; i >= 0 && w === null; i--) {
    const t = latestTrace(j, pathIds[i]!);
    if (t && t.gen?.connection === binding.conn && t.gen?.model === binding.model && t.trace.window > 0) w = t.trace.window;
  }
  if (w === null) {
    const c = capsOverrides[`${binding.conn}:${binding.model}`]?.contextLength;
    if (typeof c === 'number' && c > 0) w = c;
  }
  if (w !== null && typeof sessionWindow === 'number' && sessionWindow > 0) w = Math.min(w, sessionWindow);
  return w;
}
