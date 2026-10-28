// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What the REPL reads from a session's journal beyond the PathView (ARCHITECTURE.md §5.3, §5.7,
// §11, §12.4): the current config (/model, /note, the banner), sibling ids (/[ /], greeting
// swipes), the first words of tails (/tails), id prefixes (/goto), usage and cost over the path
// (/usage), and the last answer's trace (/trace). Pure functions over (header, entries); repl.ts
// reads the file with session/log.ts readSessionFile (read-only, no lock).

import type { Entry, Generation, JobEntry, RecallRecord, Roles, SessionConfig, SessionHeader, Trace } from '../session/entries.ts';
import { currentConfig } from '../session/fold.ts';
import { buildTree, effectiveMessage, swipeSiblings, type TreeIndex } from '../session/tree.ts';
import type { Usage } from '../providers/types.ts';
import { checkRecallRecord } from '../agents/compendium/recall.ts';

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
 * The Director's binding [D-101]: `roles.director`, or the narrator's whole binding when it follows
 * ('narrator' or unset). `follows` says which, for the banner and /director.
 */
export function directorBinding(roles: Roles): { conn: string; model: string; follows: boolean } {
  const d = roles.director;
  if (d !== undefined && typeof d !== 'string') return { conn: d.conn, model: d.model, follows: false };
  return { conn: roles.narrator.conn, model: roles.narrator.model, follows: true };
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

/** Calls and tokens of one agent (or the narrator's generations) over a path. */
export interface UsageCounts {
  /** Narrator: generations (answers and continue additions with a gen). Other agents: model calls (trace.calls rows and the lane rows' `calls`, retries included). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Generations / calls whose usage the provider did not report. */
  noUsage: number;
  /** USD; null when none could be priced. */
  costUsd: number | null;
  /** With usage but neither a provider cost nor a price row. */
  unpriced: number;
}

/**
 * The narrator's numbers at the top level (as before M4); `agents` holds every other agent that made
 * calls on the path (M4: the Director, D-101), keyed by trace.calls' `agent`. Absent when none did.
 */
export interface UsageSummary extends UsageCounts {
  agents?: Record<string, UsageCounts>;
}

export type PriceTable = Readonly<Record<string, { inPerM: number; outPerM: number }>>;

const zeroCounts = (): UsageCounts => ({ calls: 0, inputTokens: 0, outputTokens: 0, noUsage: 0, costUsd: null, unpriced: 0 });

/** Count one call or generation: provider cost first, else the price row of `model` ('conn:model'), else unpriced (never 0, §11). */
function addUsage(sum: UsageCounts, u: Usage | undefined, model: string | undefined, prices: PriceTable): void {
  sum.calls++;
  if (!u || (u.inputTotal === undefined && u.outputTotal === undefined && u.cost === undefined)) {
    sum.noUsage++;
    return;
  }
  sum.inputTokens += u.inputTotal ?? 0;
  sum.outputTokens += u.outputTotal ?? 0;
  let cost: number | null = null;
  if (typeof u.cost === 'number' && Number.isFinite(u.cost)) cost = u.cost;
  else {
    const row = model !== undefined && Object.hasOwn(prices, model) ? prices[model] : undefined;
    if (row && u.inputTotal !== undefined && u.outputTotal !== undefined) {
      cost = (u.inputTotal * row.inPerM + u.outputTotal * row.outPerM) / 1_000_000;
    }
  }
  if (cost === null) sum.unpriced++;
  else sum.costUsd = (sum.costUsd ?? 0) + cost;
}

/**
 * Usage over the path: each answer's own generation plus every continue that extended it (a
 * continue's gen replaces the message's gen in the view, so the view alone would lose the original
 * call). Cost: the provider-reported figure first, else the price table, else unpriced (never 0, §11).
 * M4 (D-101): every trace.calls row of another agent (the Director) in those traces is counted under
 * its agent and priced by the row's own model; the narrator's numbers come from its gens as before.
 * M5b (the lead's ruling I): the background lane's calls too — the `calls` rows of the filing and
 * historian rows (`mem`) and of their failed attempts (`job{failed}`) bound to a message on the path,
 * an undone or re-run pass's included (its calls were made).
 * M5c (D-204): recall — a sync recall's calls are trace.calls rows (agent 'recall', counted above); an
 * adopted prefetch's are not (the lane made them, no row holds them), so its RecallRecord counts them:
 * `calls` model calls with the summed `usage`, priced by its `model`. A reused record has none; a
 * prefetch never adopted is in no journal row and is not counted (like a superseded lane pass).
 */
export function pathUsage(j: Journal, pathIds: readonly string[], prices: PriceTable): UsageSummary {
  const sum: UsageSummary = zeroCounts();
  const agents = new Map<string, UsageCounts>();
  const add = (gen: Generation | undefined): void => {
    if (!gen || gen.kind !== 'model') return;
    addUsage(sum, gen.usage, gen.connection !== undefined && gen.model !== undefined ? `${gen.connection}:${gen.model}` : undefined, prices);
  };
  /** trace.calls-shaped rows (a turn's, a lane row's): each under its agent, the narrator's left to its gens. */
  const addRows = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows as Trace['calls']) {
      if (typeof row !== 'object' || row === null || typeof row.agent !== 'string' || row.agent === 'narrator') continue;
      let into = agents.get(row.agent);
      if (!into) agents.set(row.agent, (into = zeroCounts()));
      addUsage(into, row.usage, typeof row.model === 'string' ? row.model : undefined, prices);
    }
  };
  const addCalls = (trace: Trace | undefined): void => addRows(trace?.calls);
  /** M5c: an adopted prefetch's calls (its record has a basis: they are in no trace.calls row). */
  const addPrefetch = (stored: unknown): void => {
    const rec = checkRecallRecord(stored);
    if (rec === null || rec.basis === undefined || rec.source === 'reused' || rec.calls === 0) return;
    let into = agents.get('recall');
    if (!into) agents.set('recall', (into = zeroCounts()));
    const usage: Usage | undefined = rec.usage ? { inputTotal: rec.usage.input, outputTotal: rec.usage.output } : undefined;
    addUsage(into, usage, rec.model, prices);
    // The record sums its calls: the other calls count as calls, with their tokens already in.
    into.calls += rec.calls - 1;
    if (!usage) into.noUsage += rec.calls - 1;
  };
  for (const id of pathIds) {
    const m = j.tree.msgs.get(id);
    add(m?.gen);
    addCalls(m?.trace);
    addPrefetch(m?.recall);
    for (const e of j.tree.edits.get(id) ?? []) {
      if (e.reason !== 'continue') continue;
      add(e.gen);
      addCalls(e.trace);
      addPrefetch(e.recall);
    }
  }
  const onPath = new Set(pathIds);
  for (const m of j.tree.mems) if (m.by !== 'user' && m.on !== null && onPath.has(m.on)) addRows(m.calls);
  for (const rows of j.tree.jobs.values()) {
    for (const r of rows) if (r.state === 'failed' && onPath.has(r.on)) addRows((r as JobEntry & { calls?: unknown }).calls);
  }
  if (agents.size > 0) sum.agents = Object.fromEntries(agents);
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
 * The RecallRecord of the request latestTrace shows (the lead's ruling K): its latest continue's when that
 * continue has a trace, else the message's own. null when that request wrote none (a continue in lexical
 * or off mode, a request with no Compendium input): its trace's compendium source says why. Not
 * effectiveRecall, which falls back to an older request's record (/memory recall's answer-wide view).
 */
export function traceRecall(j: Journal, id: string): RecallRecord | null {
  const m = j.tree.msgs.get(id);
  if (!m) return null;
  const edits = j.tree.edits.get(id) ?? [];
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.reason === 'continue' && e.trace) return e.recall === undefined ? null : checkRecallRecord(e.recall);
  }
  return m.trace && m.recall !== undefined ? checkRecallRecord(m.recall) : null;
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
  presetWindow?: number,
): number | null {
  let w: number | null = null;
  for (let i = pathIds.length - 1; i >= 0 && w === null; i--) {
    const t = latestTrace(j, pathIds[i]!);
    if (t && t.gen?.connection === binding.conn && t.gen?.model === binding.model && t.trace.window > 0) w = t.trace.window;
  }
  if (w === null) {
    const c = capsOverrides[`${binding.conn}:${binding.model}`]?.contextLength;
    // A trace's window already holds the preset's limit; the model's own window does not (§10.2).
    if (typeof c === 'number' && c > 0) w = typeof presetWindow === 'number' && presetWindow > 0 ? Math.min(c, presetWindow) : c;
  }
  if (w !== null && typeof sessionWindow === 'number' && sessionWindow > 0) w = Math.min(w, sessionWindow);
  return w;
}
