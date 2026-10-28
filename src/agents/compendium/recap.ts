// Ported from Bunraku:src/core/assembly/summary-cut.ts@702d8120 (summaryText: one summary as
// '[Summary: <title>]' and its text; the summaries that cover cut messages, oldest first by range).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `{{recap}}` slot's content (ARCHITECTURE.md §7.4.4; .notes/m5b-decisions.md D-177, D-178), pure. The
// request builder computes the trim, calls recapSlot with what was cut, places the text as one system
// message (`src: 'recap'`) at the trim point of `{{history}}` and writes `trace.recap`; assemble does the
// budget (≤ 10 % of the window, from the history share). The rest is design, not port (RoleCall has no
// slot; Bunraku cut the history behind its summaries and kept arc overviews as constant lore):
// 1. arc overviews `[Arc] <plot>\n<overview>`: session arcs of the plots a picked summary belongs to, newest
//    activity (prov.lastSeq) first, then library arcs (D-177: always eligible; higher `order` first);
//    together ≤ half the slot, first-fit; lite: at most 2, each overview cut to 1 200 chars with '…';
// 2. summaries `[Summary: <title>]\n<summary>` whose range touches or precedes the cut (it starts at or
//    before the last trimmed message), oldest to newest by range; over the budget the oldest drop first.
// Items are separated by a blank line. Stability (cache): while `boundary` is the previous request's,
// the previous ids and arc revisions render again (an older revision's text through `revisionText`),
// minus entries no longer live, and nothing is added; a previous slot that no longer fits, or a previous
// recap without a boundary (pre-M5b traces hold `boundary: null`), is chosen afresh.
// After the M5b review (the lead's ruling I): an arc's revision is the seq of the last effective row that
// set its text (an edit of `featured` or keys is none); a pinned revision whose row is no longer
// effective (undone, stale) or holds no op for the arc (a fork renumbered the rows) is dropped and the
// current text renders; a pin holds only under the profile it was chosen with and within its caps (lite:
// two arcs); an overview over what is left of the arc half is cut head-first (its head kept, '…') to fit.
// After the final check (the lead's ruling K): the trace records the slot's share too, and a pin holds only
// while both the profile and the share are the ones it was chosen under; a pinned revision renders only
// while the row with that seq holds an applied arc-text op of that arc (an `arc` op, or an edit that sets
// its text), and that op's own text renders (an arc op that named a renamed plot is still the arc's),
// else the current text and revision.

import type { MemEntry } from '../../session/entries.ts';
import { clipText } from '../director/state.ts';
import { entryNames, findMatch, normalizeName } from './apply.ts';
import type { CEntry, CompendiumProfile, CompendiumView, OpEffect } from './types.ts';

/** The slot's source label in the request (trace.blocks src). */
export const RECAP_SRC = 'recap';
/** D-178: the slot's share of the request window (the caller's budget). */
export const RECAP_SHARE = 0.1;
/** Arc overviews take at most this share of the slot. */
export const RECAP_ARC_SHARE = 0.5;
/** Lite: at most this many overviews, each cut to this many chars. */
export const RECAP_LITE_ARCS = 2;
export const RECAP_LITE_ARC_CHARS = 1_200;
/** An overview cut to fit (ruling I) keeps at least this many chars; below it the arc is left out. */
export const RECAP_ARC_FLOOR_CHARS = 200;

const SEPARATOR = '\n\n';

/** One arc overview as the slot shows it. */
export const recapArcText = (plot: string, overview: string): string => `[Arc] ${plot}\n${overview}`;
/** One summary as the slot shows it (Bunraku summaryText). */
export const recapSummaryText = (title: string, summary: string): string => `[Summary: ${title}]\n${summary}`;

/** trace.recap (session/entries.ts Trace['recap']). */
export interface RecapTrace {
  ids: string[];
  arcs: { key: string; rev: number }[];
  boundary: string | null;
  /** The profile the slot was chosen under: a pin applies only under the same one (ruling I). Absent: not compared. */
  profile?: CompendiumProfile;
  /**
   * The slot's share of the window it was chosen under (RecapInput.share, ⌊10 % × window⌋): a pin applies
   * only under the same one (ruling K). Absent: not compared.
   */
  share?: number;
}

export interface RecapInput {
  /**
   * The fold the request is built from (seed included). Its `effects` (the applied ops) tell which row
   * last set an arc's text and whether a pinned revision's row is still effective (ruling I); without
   * them (or with none for an arc) the arc's prov.lastSeq is its revision, as before.
   */
  view: Pick<CompendiumView, 'entries'> & Partial<Pick<CompendiumView, 'effects'>>;
  /** The active path's message ids, root → leaf (a position is index + 1). */
  path: readonly string[];
  /** This request's cut (trace.trimmed): the oldest and newest message trimmed; null when nothing was. */
  trimmed: { from: string; to: string } | null;
  /**
   * The first history message sent after the cut — when nothing is cut, the first history message sent;
   * null when no history is sent. Recorded as trace.recap.boundary.
   */
  boundary: string | null;
  /**
   * trace.recap of the previous request (the nearest ancestor reply's, as freshness reads it, D-152).
   * null forces a fresh choice: pass null when the books or the Compendium config changed since.
   */
  previous: RecapTrace | null;
  /** The slot's budget in the counter's tokens (≤ 10 % of the window). */
  budgetTok: number;
  /**
   * The slot's whole share in the same tokens (⌊10 % × window⌋ less its message's overhead): the arcs'
   * half is half of it (D-178 "together ≤ half the slot"), never more than `budgetTok`, so a call with
   * a tighter budget cuts the arcs as the first one did. With it, a pinned slot's arcs are cut by the same
   * rule (the same text again); absent, the half is of `budgetTok` and a pin keeps its arcs whole.
   */
  shareTok?: number;
  /**
   * The slot's share as trace.recap records it (⌊10 % × window⌋, in the window's tokens): a previous slot
   * chosen under another share is chosen afresh (ruling K). Absent: not recorded, not compared.
   */
  share?: number;
  /** compendiumProfile(cfg.profile, the narrator's window). */
  profile: CompendiumProfile;
  count: (text: string) => number;
  /**
   * An arc's overview at revision `rev` (the seq of the row that set its text then): the text that row
   * gave it (arcRevisionText). `op`: the index in that row of the op that set it (the view's effect, ruling
   * K), when known. null or absent: that revision cannot be read, the current one renders.
   */
  revisionText?: (key: string, rev: number, op?: number) => string | null;
}

export interface RecapSlot {
  /** The system message's text. */
  text: string;
  /** Its tokens: each item's and each separator's (the counter's). */
  tok: number;
  /** Summary keys in the slot, in render order (trace.recap.ids). */
  ids: string[];
  /** Arc keys and the revision rendered (trace.recap.arcs). */
  arcs: { key: string; rev: number }[];
  boundary: string | null;
  /** The profile it was chosen under (for trace.recap.profile). */
  profile: CompendiumProfile;
  /** The share it was chosen under (for trace.recap.share); absent when the input gave none. */
  share?: number;
  /** Every entry key in the slot (the block's inPrompt, D-155). */
  keys: string[];
}

interface Item {
  key: string;
  text: string;
  tok: number;
}

const live = (e: CEntry | undefined): e is CEntry => e !== undefined && e.retired === undefined;
const isArc = (e: CEntry): boolean => e.type === null && e.arc !== undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function arcItem(e: CEntry, overview: string | undefined, input: RecapInput): Item | null {
  const raw = (overview ?? e.content ?? '').trim();
  if (raw === '') return null;
  const body = input.profile === 'lite' ? clipText(raw, RECAP_LITE_ARC_CHARS) : raw;
  const text = recapArcText((e.arc ?? e.name).trim(), body);
  return { key: e.key, text, tok: input.count(text) };
}

/**
 * The arc within `room` tokens (ruling I): whole when it fits, else its overview cut head-first (the
 * head kept, '…', clipText) to the longest that fits; null when even RECAP_ARC_FLOOR_CHARS do not.
 */
function fitArc(e: CEntry, overview: string | undefined, room: number, input: RecapInput): Item | null {
  const item = arcItem(e, overview, input);
  if (item === null || item.tok <= room) return item;
  const raw = (overview ?? e.content ?? '').trim();
  const body = input.profile === 'lite' ? clipText(raw, RECAP_LITE_ARC_CHARS) : raw;
  const plot = (e.arc ?? e.name).trim();
  const cost = (n: number): number => input.count(recapArcText(plot, clipText(body, n)));
  let lo = RECAP_ARC_FLOOR_CHARS;
  let hi = body.length - 1;
  if (lo > hi || cost(lo) > room) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid) <= room) lo = mid;
    else hi = mid - 1;
  }
  const text = recapArcText(plot, clipText(body, lo));
  return { key: e.key, text, tok: input.count(text) };
}

/** The arcs' half: of the slot's share when given, else of this call's budget; never above the budget. */
const arcHalf = (input: RecapInput): number => Math.min(input.budgetTok, Math.floor((input.shareTok ?? input.budgetTok) * RECAP_ARC_SHARE));

type Effect = Pick<OpEffect, 'seq' | 'op' | 'change'>;

/** The applied ops on `key` (the view's effects), or null when the view has none for it (the legacy reading). */
function effectsOf(key: string, input: RecapInput): Effect[] | null {
  const mine = input.view.effects?.filter((f) => f.key === key) ?? [];
  return mine.length > 0 ? mine : null;
}

/** An effect that may have set the arc's text: an `arc` op, or an `edit` op that sets its content. */
const setsText = (key: string, f: Effect, input: RecapInput): boolean =>
  f.change === 'arc' || (f.change === 'edited' && (input.revisionText === undefined || input.revisionText(key, f.seq, f.op) !== null));

/**
 * The arc's text revision (ruling I): the seq of the last applied op that set its text (the effects are in
 * the fold's apply order); prov.lastSeq when the view has no effects for it; 0 when no row set it.
 */
function textRev(e: CEntry, input: RecapInput): number {
  const mine = effectsOf(e.key, input);
  if (mine === null) return e.prov.lastSeq;
  for (let i = mine.length - 1; i >= 0; i--) if (setsText(e.key, mine[i]!, input)) return mine[i]!.seq;
  return 0;
}

/**
 * The arc at a pinned revision: its text then (undefined: the current text) and the revision rendered.
 * Ruling K: the row with that seq must hold an applied arc-text op of this arc — the view's effect on this
 * key at that seq that sets its text — and that very op is read back (its index in the row), so an `arc`
 * op that named the plot otherwise (renamed, an alias) is still this arc's. A pin whose row no longer
 * applies one (undone, stale, an edit that set no text) or whose text cannot be read is dropped: the
 * current text and revision. Without effects for the arc (a view built by hand) the row is read as it is.
 */
function atRevision(e: CEntry, rev: number, input: RecapInput): { overview?: string; rev: number } {
  const now = textRev(e, input);
  if (now === rev) return { rev };
  const mine = effectsOf(e.key, input);
  const at = mine?.findLast((f) => f.seq === rev && setsText(e.key, f, input));
  if (mine !== null && at === undefined) return { rev: now };
  const old = input.revisionText?.(e.key, rev, at?.op) ?? null;
  return old === null ? { rev: now } : { overview: old, rev };
}

function summaryItem(e: CEntry, input: RecapInput): Item | null {
  const title = str(e.data.title) || e.name.trim();
  const body = str(e.data.summary);
  if (title === '' || body === '') return null;
  const text = recapSummaryText(title, body);
  return { key: e.key, text, tok: input.count(text) };
}

function slotOf(arcs: readonly (Item & { rev: number })[], summaries: readonly Item[], input: RecapInput, sep: number): RecapSlot | null {
  const items = [...arcs, ...summaries];
  if (items.length === 0) return null;
  return {
    text: items.map((i) => i.text).join(SEPARATOR),
    tok: items.reduce((n, i) => n + i.tok, 0) + sep * (items.length - 1),
    ids: summaries.map((i) => i.key),
    arcs: arcs.map((i) => ({ key: i.key, rev: i.rev })),
    boundary: input.boundary,
    profile: input.profile,
    ...(input.share !== undefined ? { share: input.share } : {}),
    keys: items.map((i) => i.key),
  };
}

/**
 * The previous slot again (same boundary): its live summaries, its arcs at their revisions. 'fresh' when
 * the pin does not hold here (rulings I and K): another profile or share than the recorded ones, more arcs
 * than the profile allows, or (with `shareTok`) an arc that no longer fits the arcs' half even cut.
 */
function again(input: RecapInput, previous: RecapTrace, sep: number): RecapSlot | null | 'fresh' {
  if (previous.profile !== undefined && previous.profile !== input.profile) return 'fresh';
  if (previous.share !== undefined && input.share !== undefined && previous.share !== input.share) return 'fresh';
  const { entries } = input.view;
  const maxArcs = input.profile === 'lite' ? RECAP_LITE_ARCS : Infinity;
  const half = arcHalf(input);
  const arcs: (Item & { rev: number })[] = [];
  let used = 0;
  for (const { key, rev } of previous.arcs) {
    const e = entries.get(key);
    if (!live(e) || !isArc(e)) continue;
    if (arcs.length >= maxArcs) return 'fresh';
    const at = atRevision(e, rev, input);
    const gap = arcs.length > 0 ? sep : 0;
    const item = input.shareTok === undefined ? arcItem(e, at.overview, input) : fitArc(e, at.overview, half - used - gap, input);
    if (item === null) {
      if (input.shareTok !== undefined) return 'fresh';
      continue;
    }
    used += item.tok + gap;
    arcs.push({ ...item, rev: at.rev });
  }
  const summaries: Item[] = [];
  for (const key of previous.ids) {
    const e = entries.get(key);
    if (!live(e) || e.type !== 'summary') continue;
    const item = summaryItem(e, input);
    if (item !== null) summaries.push(item);
  }
  return slotOf(arcs, summaries, input, sep);
}

/** A fresh choice for this cut. */
function choose(input: RecapInput, sep: number): RecapSlot | null {
  const all = [...input.view.entries.values()];
  const index = new Map(all.map((e, i) => [e, i]));
  const at = new Map(input.path.map((id, i) => [id, i + 1]));
  const cutEnd = input.trimmed === null ? undefined : at.get(input.trimmed.to);

  // Summaries touching or before the cut, oldest first (range start, then end, then view order).
  const picked: { e: CEntry; from: number; to: number }[] = [];
  if (cutEnd !== undefined) {
    for (const e of all) {
      if (!live(e) || e.type !== 'summary' || e.range === undefined) continue;
      const from = at.get(e.range[0]);
      if (from === undefined || from > cutEnd) continue;
      picked.push({ e, from, to: at.get(e.range[1]) ?? Infinity });
    }
    picked.sort((a, b) => a.from - b.from || a.to - b.to || index.get(a.e)! - index.get(b.e)!);
  }

  // Their plots' names (as written, and every name of the plot entry they resolve to).
  const plots = new Set<string>();
  for (const { e } of picked) {
    const plot = str(e.data.parent_plot);
    if (plot === '') continue;
    const n = normalizeName(plot);
    if (n !== '') plots.add(n);
    const p = findMatch(all, 'plot', [plot]);
    if (p !== null) for (const name of entryNames(p)) plots.add(name);
  }
  const session = all
    .filter((e) => live(e) && isArc(e) && e.origin.kind === 'session' && plots.has(normalizeName(e.arc!)))
    .sort((a, b) => b.prov.lastSeq - a.prov.lastSeq || index.get(a)! - index.get(b)!);
  const library = all
    .filter((e) => live(e) && isArc(e) && e.origin.kind === 'library')
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || index.get(a)! - index.get(b)!);

  const arcs: (Item & { rev: number })[] = [];
  const half = arcHalf(input);
  const maxArcs = input.profile === 'lite' ? RECAP_LITE_ARCS : Infinity;
  let used = 0;
  for (const e of [...session, ...library]) {
    if (arcs.length >= maxArcs) break;
    const gap = arcs.length > 0 ? sep : 0;
    // Ruling I: an overview over what is left of the half is cut head-first to fit, not left out.
    const item = fitArc(e, undefined, half - used - gap, input);
    if (item === null) continue;
    used += item.tok + gap;
    arcs.push({ ...item, rev: textRev(e, input) });
  }

  // Newest first while they fit, then shown oldest first: over the budget the oldest drop.
  const summaries: Item[] = [];
  for (let i = picked.length - 1; i >= 0; i--) {
    const item = summaryItem(picked[i]!.e, input);
    if (item === null) continue;
    const cost = item.tok + (arcs.length + summaries.length > 0 ? sep : 0);
    if (used + cost > input.budgetTok) break;
    used += cost;
    summaries.unshift(item);
  }
  return slotOf(arcs, summaries, input, sep);
}

/**
 * D-178: the `{{recap}}` slot for this request, or null when it has nothing (then nothing is reserved and
 * the request stays as it was without it). See the file comment for the content and the stability rule.
 * When it returns null the caller still records `{ids: [], arcs: [], boundary}` as trace.recap, so an
 * empty slot stays empty while the boundary holds.
 */
export function recapSlot(input: RecapInput): RecapSlot | null {
  if (!(input.budgetTok > 0)) return null;
  const sep = input.count(SEPARATOR);
  const prev = input.previous;
  if (prev !== null && prev.boundary !== null && prev.boundary === input.boundary) {
    const slot = again(input, prev, sep);
    if (slot !== 'fresh' && (slot === null || slot.tok <= input.budgetTok)) return slot;
  }
  return choose(input, sep);
}

/**
 * The text an arc had at revision `rev` (D-178): what the `mem` row with seq `rev` set it to. With `op`
 * (the index of the op the fold applied to the arc, ruling K) exactly that op: an `arc` op's overview, an
 * `edit` of the key's `set.content` / `set.overview`. Without it the last such op of the row — an `arc` op
 * for the arc's plot as its key names it ('arc:<plot>' or 'arc:<plot>#n'), or an `edit` of the key. null
 * when that row (or op) says nothing about the arc's text.
 */
export function arcRevisionText(rows: readonly MemEntry[], key: string, rev: number, op?: number): string | null {
  const row = findRow(rows, rev);
  if (row === undefined || !Array.isArray(row.ops)) return null;
  const ops = row.ops as unknown[];
  if (op !== undefined) return Number.isInteger(op) && op >= 0 && op < ops.length ? opText(ops[op], key, () => true) : null;
  const plot = key.startsWith('arc:') ? key.slice(4).replace(/#\d+$/, '') : null;
  let found: string | null = null;
  for (const o of ops) found = opText(o, key, (p) => plot !== null && normalizeName(p) === plot) ?? found;
  return found;
}

/** The arc text one op sets: an `arc` op's overview (when `ofPlot` takes its plot), an `edit` of `key`'s content or overview. */
function opText(op: unknown, key: string, ofPlot: (plot: string) => boolean): string | null {
  if (typeof op !== 'object' || op === null) return null;
  const o = op as Record<string, unknown>;
  if (o.op === 'arc') return typeof o.plot === 'string' && typeof o.overview === 'string' && ofPlot(o.plot) ? o.overview : null;
  if (o.op !== 'edit' || o.ref !== key || typeof o.set !== 'object' || o.set === null) return null;
  const set = o.set as Record<string, unknown>;
  const t = set.content !== undefined ? set.content : set.overview;
  return typeof t === 'string' ? t : null;
}

/** The row with this seq (rows in seq order: a binary search; else a scan). */
function findRow(rows: readonly MemEntry[], seq: number): MemEntry | undefined {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = rows[mid]!.seq;
    if (s === seq) return rows[mid];
    if (s < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return rows.find((r) => r.seq === seq);
}
