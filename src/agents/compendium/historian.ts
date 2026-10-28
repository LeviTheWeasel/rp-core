// Ported from Bunraku:src/core/compendium/historian.ts@702d8120 (historianWindow, historianMessages,
// historianDigest, parseHistorian, prepareItems, stageArcs), Bunraku:src/studio/compendium-historian.ts@702d8120
// (the run reads up to the reply filing stops at; temperature 0.3, max_tokens 4096),
// Bunraku:src/studio/compendium-recap-write.ts@702d8120 (plots before summaries before arcs; an arc only
// for a plot this run's summaries name) and RoleCall:apps/rc/src/lib/ai/tv-stream/summary-watermark.ts@fb8dc623e
// (the watermark from historian summaries only, never from other writes; the window from it plus the
// overlap; the player turns after it).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The historian, pure (ARCHITECTURE.md §7.4.4; .notes/m5b-decisions.md D-176): when a run is due, which
// messages it reads, its prompt, how its answer is read, and the ops of its row. The lane (engine/lane.ts)
// calls the model through structuredCall and writes the row
// `mem{key: historianKey(w), on: w.toId, by: 'historian', range: [w.newFromId, w.toId], ops}`.
// Changes from Bunraku, each a listed deviation:
// - the watermark is the end of the covered PREFIX of the path: positions covered by the ranges of
//   non-stale historian rows, reverted ones included (a retired summary or an undone pass never moves it
//   back; only staleness does). The window is the oldest uncovered segment: it starts at the first
//   uncovered visible message and stops before the next covered one;
// - a second trigger, `recapAfter` path messages after the watermark that the newest answer's request
//   trimmed (D-33); `interval = 0` turns the historian off (C-2);
// - the window is on the path: visible messages only, numbered by their 1-based path positions (D-58,
//   C-4; Bunraku: 0-based live indices); the cap is min(12 000, 35 % of the recorder's window) tokens;
//   the overlap is 10 (full) / 6 (lite) messages and takes at most a third of the cap, trimmed from its
//   oldest end, and at least one new message is always read (Bunraku's Q1: an overlap that filled the
//   cap gave a window that ended before its new part, so the watermark never moved);
// - the lite prompt says «At most 6 filings.» and «Keep each overview under 1200 characters.»; the lite
//   digest holds the 6 most recently active plots; the digest leaves out plots whose status is resolved,
//   failed or abandoned (as the filing snapshot);
// - the answer is read leniently (D-82, D-175): envelopes, item forms, type synonyms, camelCase fields,
//   kind and enum coercions; a field of the wrong kind is skipped and the item stays; service fields
//   (turn_range, messages_covered, …) are stripped; a summary's create_plot names its plot when
//   parent_plot is blank (RoleCall's rule; Bunraku dropped it); significance `critical` reads as
//   `pivotal` (RoleCall's word); `{}` is nothing to summarise; arcs are capped like items and every
//   dropped arc is named in `skipped`;
// - the summary text is cut to 1 500 chars and an overview to 6 000 / 1 200 with '…' (D-68.2, D-87);
//   `messages_covered` is stamped by code; a plot or arc write that changes nothing is left out;
// - after the M5b review (the lead's ruling I, D-183): a blank compendium.language ends the prompt with
//   «Write every field value in the language the story is written in.»; window texts over the cap are
//   cut head+tail to fit it (a message bigger than the recorder's window no longer stops the
//   historian); a plot named by an alias is its plot, and its arc is keyed by the canonical name;
//   historianOps says how many summaries the answer offered and how many it holds, so the lane can fail
//   an answer whose summaries were all refused; a list key holding null, '' or "none" is nothing;
// - M5c (D-208; Bunraku sends no prefill): the request names its answer's opening, `{"filings": [`,
//   which structuredCall sends as an assistant prefill on the tagged transport when the caps take one.

import type { MemOp } from '../../session/entries.ts';
import type { JSONSchema } from '../../providers/types.ts';
import { clipText } from '../director/state.ts';
import type { ReadResult, Skip } from '../director/types.ts';
import { entryNames, findMatch, normalizeName } from './apply.ts';
import { describeKind, fieldKind, IDENTITY_KEEP, isEntryType, type Kind } from './entry-types.ts';
import { cutMiddle, languageTail, STORY_LANGUAGE } from './filing.ts';
import { mergeData } from './merge.ts';
import type { CEntry, CompendiumProfile, CompendiumView, Rec, TaskState } from './types.ts';

// ---- limits ---------------------------------------------------------------------------------------

/** The most tokens of messages one run reads (Bunraku WINDOW_TOKENS)… */
export const WINDOW_TOKENS = 12_000;
/** …and at most this share of the recorder's request window (D-176). */
export const WINDOW_SHARE = 0.35;
/** The overlap takes at most this share of the window's cap (the Q1 fix). */
export const OVERLAP_SHARE = 1 / 3;
/** A summary's text is cut to this many chars (D-68.2). */
export const SUMMARY_CHARS = 1_500;
export const HISTORIAN_TEMPERATURE = 0.3;
/** D-208: the opening of the answer, sent as an assistant prefill where the caps take one (structuredCall `opening`). */
export const HISTORIAN_OPENING = '{"filings": [';
/** An item nested deeper than this is refused (Bunraku MAX_DEPTH). */
export const MAX_DEPTH = 6;

export interface HistorianLimits {
  /** Filings read from one answer (and arcs). */
  items: number;
  /** JSON chars of one item's entry. */
  itemChars: number;
  /** Messages of overlap before the new part (`historian.overlap` absent). */
  overlap: number;
  /** Chars of one arc overview. */
  overviewChars: number;
  /** Plots in the digest. */
  digestPlots: number;
  maxTokens: number;
}

/** §7.4.4 / §11 table: full and lite. */
export const HISTORIAN_LIMITS: Readonly<Record<CompendiumProfile, Readonly<HistorianLimits>>> = Object.freeze({
  full: Object.freeze({ items: 12, itemChars: 6_000, overlap: 10, overviewChars: 6_000, digestPlots: Infinity, maxTokens: 4_096 }),
  lite: Object.freeze({ items: 6, itemChars: 3_000, overlap: 6, overviewChars: 1_200, digestPlots: 6, maxTokens: 1_500 }),
});

// ---- small helpers ----------------------------------------------------------------------------------

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const text = (v: unknown): string | undefined => (isStr(v) && v.trim() !== '' ? v.trim() : undefined);

/** Sets an own property, also for the key '__proto__'. */
function put(o: Rec, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
  else o[key] = value;
}

// ---- coverage and the watermark (D-176) -------------------------------------------------------------

/** One message of the path as the historian reads it: its text blocks joined (mention.ts messageText). */
export interface HistMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  hidden?: boolean;
}

/** A message of a window: its 1-based path position (D-58). */
export interface WindowMessage {
  pos: number;
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The ranges the historian has covered on this path: every historian key ('hist:…') whose row applies
 * or was reverted (D-74: a reverted range counts as covered), but not a stale one, nor a reverted key
 * whose reverted row went stale (D-179). Filing keys never count (RoleCall's watermark pollution).
 */
export function historianRanges(tasks: ReadonlyMap<string, TaskState>): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, s] of tasks) {
    if (!key.startsWith('hist:') || s.range === undefined) continue;
    if (s.status === 'applied' || (s.status === 'reverted' && s.stale !== true)) out.push(s.range);
  }
  return out;
}

/** covered[pos] = 1 for each path position inside a range. A range whose end lies past `path` covers to its end. */
function coveredPositions(path: readonly HistMessage[], at: ReadonlyMap<string, number>, ranges: readonly [string, string][]): Uint8Array {
  const covered = new Uint8Array(path.length + 1);
  for (const [a, b] of ranges) {
    const from = at.get(a);
    if (from === undefined) continue;
    const to = Math.min(at.get(b) ?? path.length, path.length);
    for (let p = from; p <= to; p++) covered[p] = 1;
  }
  return covered;
}

/** id → 1-based path position. */
const positions = (path: readonly HistMessage[]): Map<string, number> => new Map(path.map((m, i) => [m.id, i + 1]));

/** The covered prefix: the watermark (position of its last visible message, 0 when none) and the first uncovered visible message's index (-1: all covered). */
function prefix(path: readonly HistMessage[], covered: Uint8Array): { watermark: number; first: number } {
  let watermark = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i]!.hidden === true) continue;
    if (covered[i + 1] !== 1) return { watermark, first: i };
    watermark = i + 1;
  }
  return { watermark, first: -1 };
}

/**
 * D-176: the end of the covered prefix of `path` — the position of the last visible message before the
 * first uncovered visible one (hidden messages are skipped, never a hole); 0 when nothing is covered.
 */
export function historianWatermark(path: readonly HistMessage[], tasks: ReadonlyMap<string, TaskState>): number {
  const covered = coveredPositions(path, positions(path), historianRanges(tasks));
  const p = prefix(path, covered);
  return p.first < 0 ? lastVisible(path) : p.watermark;
}

function lastVisible(path: readonly HistMessage[]): number {
  for (let i = path.length - 1; i >= 0; i--) if (path[i]!.hidden !== true) return i + 1;
  return 0;
}

// ---- the window ---------------------------------------------------------------------------------------

export interface HistorianConfig {
  /** Player turns after the watermark that make a run due; 0 = the historian is off (C-2). */
  interval: number;
  /** Messages after the watermark the newest request trimmed that make a run due. */
  recapAfter: number;
  /** Messages of overlap; absent = by profile (10 full, 6 lite); 0 = none. */
  overlap?: number;
}

export interface WindowInput {
  /**
   * The active path from the root through the last accepted answer (D-176: the answer filing just
   * filed), every message, hidden ones flagged; a message's position is its index + 1 (D-58).
   */
  path: readonly HistMessage[];
  profile: CompendiumProfile;
  /** The recorder's request window, in tokens. */
  window: number;
  /** The token counter (the recorder's). */
  count: (text: string) => number;
  cfg?: Pick<HistorianConfig, 'overlap'>;
  /**
   * The most tokens the window's message texts may take (overlap included); absent: windowCap(window).
   * Never above windowCap. The lane passes less when the prompt around the messages leaves less of the
   * recorder's window (window − the prompt without its messages − the answer's floor): the texts are
   * then cut to that, the window's messages and key unchanged.
   */
  budget?: number;
}

export interface HistorianDueInput extends WindowInput {
  /** view.compendium.tasks of the same path. */
  tasks: ReadonlyMap<string, TaskState>;
  /** trace.trimmed of the newest committed answer's last request (its continue's, if any); null: nothing cut. */
  trimmed: { from: string; to: string } | null;
  cfg: HistorianConfig;
}

export interface HistorianWindow {
  /** The first message shown (overlap included) and the first new one, the last new one. */
  fromId: string;
  newFromId: string;
  toId: string;
  /** Their 1-based path positions; `end` is inclusive. */
  start: number;
  newStart: number;
  end: number;
  /** The visible messages shown, overlap first, in path order. */
  messages: WindowMessage[];
  /** Tokens of their texts (the counter's). */
  tokens: number;
}

export interface HistorianDue extends HistorianWindow {
  /** The covered prefix's end (position; 0: nothing covered). */
  watermark: number;
  /** Visible player messages after the watermark. */
  turns: number;
  /** Visible messages after the watermark inside the trimmed span. */
  trimmed: number;
  trigger: 'interval' | 'trimmed';
}

/** The window's token cap: min(12 000, 35 % of the recorder's window). */
export const windowCap = (window: number): number => Math.max(0, Math.min(WINDOW_TOKENS, Math.floor(window * WINDOW_SHARE)));

/** The window's token cap: windowCap(window), or the caller's smaller budget. */
const capOf = (input: WindowInput): number => {
  const cap = windowCap(input.window);
  return input.budget === undefined ? cap : Math.max(0, Math.min(cap, Math.floor(input.budget)));
};

/**
 * Water-filling: the largest per-text token share L with Σ min(t, L) ≤ room; null when the texts fit
 * whole. Texts over L are cut to L, the others stay whole.
 */
function fairShare(tokens: readonly number[], room: number): number | null {
  if (tokens.reduce((a, b) => a + b, 0) <= room) return null;
  const sorted = [...tokens].sort((a, b) => a - b);
  let left = Math.max(0, room);
  for (let k = 0; k < sorted.length; k++) {
    const rest = sorted.length - k;
    if (sorted[k]! * rest > left) return Math.floor(left / rest);
    left -= sorted[k]!;
  }
  return null;
}

/** `text` cut head+tail (filing's cutMiddle, D-174) to at most `tokens` of the counter's. */
function cutToTokens(text: string, tokens: number, count: (text: string) => number): string {
  if (count(text) <= tokens) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (count(cutMiddle(text, mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return cutMiddle(text, lo);
}

/**
 * The visible messages of a window whose new part starts at path index `first`: back up to `overlap`
 * visible messages, nearest first, while they stay within a third of the cap; then forward while the
 * total stays within the cap — the first new message always — and, without `last`, while uncovered
 * (the oldest uncovered segment ends at the next covered message). With `last` (a stored range) the
 * new part is every visible message up to that index. New texts over what the overlap leaves of the
 * cap are cut head+tail to fit (the longest first, to a fair share; the lead's ruling I): a message
 * bigger than the recorder's window no longer parks the historian. The same messages give the same cut
 * whether the window comes from historianDue or historianWindowAt.
 */
function windowFrom(input: WindowInput, first: number, covered: Uint8Array | null, last: number | null): HistorianWindow | null {
  const { path, count } = input;
  const cap = capOf(input);
  const overlapMax = input.cfg?.overlap ?? HISTORIAN_LIMITS[input.profile].overlap;
  const tok = (m: HistMessage): number => count(m.text.trim());
  const shown: number[] = [];
  const toks: number[] = [];
  let used = 0;
  const overlapCap = Math.floor(cap * OVERLAP_SHARE);
  for (let i = first - 1, n = 0; i >= 0 && n < overlapMax; i--) {
    const m = path[i]!;
    if (m.hidden === true) continue;
    const t = tok(m);
    if (used + t > overlapCap) break;
    used += t;
    n++;
    shown.unshift(i);
    toks.unshift(t);
  }
  const overlap = shown.length;
  const overlapUsed = used;
  for (let i = first; i < path.length; i++) {
    const m = path[i]!;
    if (m.hidden === true) continue;
    const t = tok(m);
    if (last !== null) {
      if (i > last) break;
    } else {
      if (covered !== null && covered[i + 1] === 1) break;
      if (shown.length > overlap && used + t > cap) break;
    }
    used += t;
    shown.push(i);
    toks.push(t);
  }
  if (shown.length === overlap) return null;
  const share = fairShare(toks.slice(overlap), cap - overlapUsed);
  let tokens = overlapUsed;
  const messages = shown.map((i, k): WindowMessage => {
    const m = path[i]!;
    if (k < overlap) return { pos: i + 1, id: m.id, role: m.role, text: m.text };
    if (share === null || toks[k]! <= share) {
      tokens += toks[k]!;
      return { pos: i + 1, id: m.id, role: m.role, text: m.text };
    }
    const text = cutToTokens(m.text.trim(), share, count);
    tokens += count(text);
    return { pos: i + 1, id: m.id, role: m.role, text };
  });
  const head = messages[0]!;
  const fresh = messages[overlap]!;
  const tail = messages[messages.length - 1]!;
  return { fromId: head.id, newFromId: fresh.id, toId: tail.id, start: head.pos, newStart: fresh.pos, end: tail.pos, messages, tokens };
}

/** The trimmed span as positions [from, to] in `path`, or null. */
function trimmedSpan(path: readonly HistMessage[], at: ReadonlyMap<string, number>, trimmed: { from: string; to: string } | null): [number, number] | null {
  if (trimmed === null) return null;
  const from = at.get(trimmed.from);
  const to = at.get(trimmed.to);
  if (from === undefined && to === undefined) return null;
  return [from ?? 1, to ?? path.length];
}

/**
 * D-176: the historian's next window, or null when no run is due. Due when either trigger fires:
 * ≥ `interval` visible player messages after the watermark, or ≥ `recapAfter` visible messages after
 * it that the newest request trimmed. `interval = 0`: never. The window is the oldest uncovered
 * segment (it starts right after the watermark), with the overlap before it, within the cap.
 */
export function historianDue(input: HistorianDueInput): HistorianDue | null {
  const { path, cfg } = input;
  if (!(cfg.interval > 0)) return null;
  const at = positions(path);
  const covered = coveredPositions(path, at, historianRanges(input.tasks));
  const { watermark, first } = prefix(path, covered);
  if (first < 0) return null;
  const cut = trimmedSpan(path, at, input.trimmed);
  let turns = 0;
  let trimmed = 0;
  for (let i = first; i < path.length; i++) {
    const m = path[i]!;
    if (m.hidden === true) continue;
    if (m.role === 'user') turns++;
    if (cut !== null && i + 1 >= cut[0] && i + 1 <= cut[1]) trimmed++;
  }
  const trigger = turns >= cfg.interval ? 'interval' : cfg.recapAfter > 0 && trimmed >= cfg.recapAfter ? 'trimmed' : null;
  if (trigger === null) return null;
  const w = windowFrom(input, first, covered, null);
  return w === null ? null : { ...w, watermark, turns, trimmed, trigger };
}

/**
 * The window of a stored range (a refile, a retry, a recovered `job{begin}` of key
 * `hist:<newFromId>-<toId>`): the new part is every visible message from `newFromId` through `toId`,
 * with the overlap computed as historianDue does, and texts over the cap (or `budget`) cut head+tail to
 * fit it. Null when the ids are not on `path` in that order or nothing between them is visible.
 * Due-ness is not checked.
 */
export function historianWindowAt(input: WindowInput, range: readonly [string, string]): HistorianWindow | null {
  const at = positions(input.path);
  const from = at.get(range[0]);
  const to = at.get(range[1]);
  if (from === undefined || to === undefined || from > to) return null;
  let first = from - 1;
  while (first < to && input.path[first]!.hidden === true) first++;
  if (first >= to) return null;
  return windowFrom(input, first, null, to - 1);
}

/** The row key of a window's pass (§5.8): 'hist:<newFromId>-<toId>'; the overlap is not in it. */
export const historianKey = (w: Pick<HistorianWindow, 'newFromId' | 'toId'>): string => `hist:${w.newFromId}-${w.toId}`;

// ---- the prompt (Bunraku historianMessages, historianDigest) ------------------------------------------

const DIGEST_HEAD = 'Existing plots (REUSE these names in parent_plot):';
const NO_DIGEST = 'No summaries or plots exist yet.';

const statusOf = (e: CEntry): string => text(e.data.status) ?? 'active';

/** Plot statuses the digest leaves out (the lead's ruling G; the filing snapshot's rule). */
const CLOSED_PLOT: ReadonlySet<string> = new Set(['resolved', 'failed', 'abandoned']);

/**
 * The plots the prompt shows so the model reuses their names: each live plot whose status is not
 * resolved, failed or abandoned, `- <name> (<status>)` and the titles of its last 3 summaries (view
 * order); lite: only the 6 most recently active (the newest prov.lastSeq of the plot, its arc and its
 * summaries), shown in view order. '' when there is none.
 */
export function historianDigest(view: Pick<CompendiumView, 'entries'>, profile: CompendiumProfile): string {
  const live = [...view.entries.values()].filter((e) => e.retired === undefined);
  let plots = live.filter((e) => e.type === 'plot' && !CLOSED_PLOT.has(statusOf(e).toLowerCase()));
  if (plots.length === 0) return '';
  const summaries = live.filter((e) => e.type === 'summary').map((e) => ({ e, plot: isStr(e.data.parent_plot) ? normalizeName(e.data.parent_plot) : '' }));
  const arcs = live.filter((e) => e.arc !== undefined).map((e) => ({ e, plot: normalizeName(e.arc!) }));
  const recapsOf = (p: CEntry): CEntry[] => {
    const names = new Set(entryNames(p));
    return summaries.filter((s) => s.plot !== '' && names.has(s.plot)).map((s) => s.e);
  };
  const limit = HISTORIAN_LIMITS[profile].digestPlots;
  if (plots.length > limit) {
    const activity = (p: CEntry): number => {
      const names = new Set(entryNames(p));
      let seq = p.prov.lastSeq;
      for (const s of recapsOf(p)) seq = Math.max(seq, s.prov.lastSeq);
      for (const a of arcs) if (names.has(a.plot)) seq = Math.max(seq, a.e.prov.lastSeq);
      return seq;
    };
    const ranked = plots.map((p, i) => ({ p, i, seq: activity(p) })).sort((a, b) => b.seq - a.seq || a.i - b.i);
    const keep = new Set(ranked.slice(0, limit).map((r) => r.p));
    plots = plots.filter((p) => keep.has(p));
  }
  const lines = plots.map((p) => {
    const recaps = recapsOf(p).slice(-3).map((s) => s.name);
    return `- ${p.name} (${statusOf(p)})${recaps.length > 0 ? `; recent recaps: ${recaps.join('; ')}` : ''}`;
  });
  return `${DIGEST_HEAD}\n${lines.join('\n')}`;
}

export interface HistorianPromptInput {
  /** 1-based path positions: the first message shown, the first new one, the last one (inclusive). */
  start: number;
  newStart: number;
  end: number;
  messages: readonly { pos: number; role: string; text: string }[];
  /** historianDigest(); '' when there are no plots. */
  digest: string;
  guidance: string;
  language: string;
  profile: CompendiumProfile;
}

/**
 * Bunraku historianMessages verbatim, numbered by path positions (`end` inclusive); the lite profile
 * says «At most 6 filings.» and «Keep each overview under 1200 characters.» (D-176, new text; prompt
 * numbers carry no separators, the lead's ruling G).
 */
export function historianPrompt(input: HistorianPromptInput): { system: string; user: string } {
  const { start, newStart, end } = input;
  const overlap =
    start < newStart
      ? `\nMessages ${start} to ${newStart - 1} are OVERLAP from the previous window (already summarized; they are there so you can bridge events that span the boundary).\nMessages ${newStart} to ${end} are NEW and need summarizing.\n`
      : '';
  const guidance = input.guidance.trim() ? `\n\nUSER GUIDANCE (it cannot widen what you may write):\n${input.guidance.trim()}` : '';
  // D-183: a blank compendium.language keeps the story's language (Bunraku adds nothing then).
  const language = `\n\n${input.language.trim() ? `Write every field value in ${input.language.trim()}.` : STORY_LANGUAGE}`;
  const limit = input.profile === 'lite' ? 'At most 6 filings. Keep each overview under 1200 characters.' : 'At most 12 filings.';
  const system = `You are a historian and narrative archivist for a roleplay. Review recent events and write clear, organized summaries.

YOUR WINDOW: messages ${start} through ${end} (${end - start + 1} messages).${overlap}
${input.digest ? `${input.digest}\n` : `${NO_DIGEST}\n`}
What to do:
1. Write summaries of significant events. Every summary MUST belong to a plot: put its plot's exact name in "parent_plot", reusing an existing plot when it fits and naming a new storyline when a new thread begins. Fill title, tagline (one-line hook), summary (past tense), participants, significance (minor, moderate, major or pivotal) and key_moments.
2. For each plot you summarized, write "arcs": that plot's overview, one cohesive chronological narrative of its key events, character developments and progression. It stays in the narrator's context, so keep it comprehensive but concise, and rewrite it whole.
3. Focus on what matters: character development, plot turns, world changes, relationship shifts. Skip filler. If nothing notable happened, answer with empty lists.

ANSWER FORMAT - reply with one JSON object and nothing else:
{"filings":[{"type":"summary","entry":{"title":"...","parent_plot":"Plot Name","summary":"..."}}],"arcs":[{"plot":"Plot Name","overview":"..."}]}
Optionally {"type":"plot","entry":{"name":"Plot Name","status":"active","description":"..."}} describes a new plot. ${limit}${guidance}${language}`;
  const body = input.messages.map((m) => `[${m.pos}] ${m.role}: ${m.text.trim()}`).join('\n\n');
  return { system, user: `Messages ${start} to ${end}:\n\n${body}\n\nSummarize the new events.${languageTail(input.language)}` };
}

const oneOf = (type: 'summary' | 'plot', field: string): readonly string[] => {
  const k = fieldKind(type, field);
  return typeof k === 'object' ? k.oneOf : [];
};

/** The answer's JSON schema (the structured transport's responseSchema). */
export function historianSchema(profile: CompendiumProfile): JSONSchema {
  const items = HISTORIAN_LIMITS[profile].items;
  const str = { type: 'string' };
  const list = { type: 'array', items: str };
  return {
    type: 'object',
    required: ['filings', 'arcs'],
    properties: {
      filings: {
        type: 'array',
        maxItems: items,
        items: {
          type: 'object',
          required: ['type', 'entry'],
          properties: {
            type: { type: 'string', enum: ['summary', 'plot'] },
            entry: {
              type: 'object',
              properties: {
                title: str,
                parent_plot: str,
                tagline: str,
                summary: str,
                participants: list,
                significance: { type: 'string', enum: oneOf('summary', 'significance') },
                key_moments: list,
                name: str,
                status: { type: 'string', enum: oneOf('plot', 'status') },
                description: str,
              },
            },
          },
        },
      },
      arcs: {
        type: 'array',
        maxItems: items,
        items: { type: 'object', required: ['plot', 'overview'], properties: { plot: str, overview: str } },
      },
    },
  };
}

export interface HistorianRequestInput {
  window: Pick<HistorianWindow, 'start' | 'newStart' | 'end' | 'messages'>;
  /** The fold at the window's last message (its plots and summaries make the digest). */
  view: Pick<CompendiumView, 'entries'>;
  /** compendiumProfile(cfg.profile, the recorder's window). */
  profile: CompendiumProfile;
  /** compendium.guidance (shared with filing; narrows only). */
  guidance: string;
  /** compendium.language ('' = the story's). */
  language: string;
}

export interface HistorianRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  schema: { name: string; schema: JSONSchema };
  /** D-208: HISTORIAN_OPENING, structuredCall's `opening`. */
  opening: string;
}

/** Everything structuredCall needs from the historian but the route (D-176): tag null, repair on. */
export function historianRequest(input: HistorianRequestInput): HistorianRequest {
  const { window: w, profile } = input;
  const { system, user } = historianPrompt({
    start: w.start,
    newStart: w.newStart,
    end: w.end,
    messages: w.messages,
    digest: historianDigest(input.view, profile),
    guidance: input.guidance,
    language: input.language,
    profile,
  });
  return {
    system,
    user,
    maxTokens: HISTORIAN_LIMITS[profile].maxTokens,
    temperature: HISTORIAN_TEMPERATURE,
    schema: { name: 'historian', schema: historianSchema(profile) },
    opening: HISTORIAN_OPENING,
  };
}

// ---- reading the answer (Bunraku parseHistorian, leniently) -------------------------------------------

export interface HistorianItem {
  /** Where it was in the answer (a skip path prefix): 'filings[2]'. */
  at: string;
  data: Rec;
}

export interface HistorianArc {
  at: string;
  plot: string;
  overview: string;
}

export interface HistorianAnswer {
  /** Each with a non-blank title, summary and parent_plot (trimmed), service fields stripped. */
  summaries: HistorianItem[];
  /** Each with a non-blank name (trimmed). */
  plots: HistorianItem[];
  arcs: HistorianArc[];
  /** What was left out, and why (also the ReadResult's `skipped`). */
  skipped: Skip[];
  /**
   * The summaries the answer offered, refused ones included: every item read or refused as a summary,
   * every item without a readable type, every item past the limit; not plots, not items of another
   * named type. Absent (an answer built by hand): summaries.length.
   */
  offered?: number;
}

/** Model-sent fields that only code sets (D-175). */
const SERVICE_FIELDS: ReadonlySet<string> = new Set(['writer_source', 'source_turn', 'source_job_id', 'turn_range', 'messages_covered']);

/** Item lists of an answer, in reading order, with the type their items have when they name none. */
const ITEM_LISTS: readonly (readonly [string, 'summary' | 'plot' | undefined])[] = [
  ['filings', undefined],
  ['entries', undefined],
  ['items', undefined],
  ['summaries', 'summary'],
  ['recaps', 'summary'],
  ['plots', 'plot'],
  ['storylines', 'plot'],
];
const ARC_LISTS: readonly string[] = ['arcs', 'arc', 'overviews', 'plot_overviews'];
const ARC_PLOT: readonly string[] = ['plot', 'plot_name', 'plotName', 'name', 'title', 'parent_plot', 'parentPlot'];
const ARC_TEXT: readonly string[] = ['overview', 'text', 'content', 'summary', 'description'];

/** The type words a model uses, folded (lower case, spaces and hyphens as '_'). */
const TYPE_WORDS: Readonly<Record<string, 'summary' | 'plot'>> = {
  summary: 'summary',
  summaries: 'summary',
  recap: 'summary',
  recaps: 'summary',
  пересказ: 'summary',
  резюме: 'summary',
  сводка: 'summary',
  plot: 'plot',
  plots: 'plot',
  storyline: 'plot',
  story_line: 'plot',
  сюжет: 'plot',
  сюжетная_линия: 'plot',
};

const fold = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** A list that says "nothing": null, a blank string or "none" (the lead's ruling I). */
const saysNothing = (v: unknown): boolean => v === null || (isStr(v) && /^(?:none)?$/i.test(v.trim()));

type ItemType = 'summary' | 'plot' | { other: string };

function typeWord(v: unknown): ItemType | undefined {
  if (!isStr(v) || v.trim() === '') return undefined;
  const w = fold(v);
  // Own words only: '__proto__' or 'constructor' is another type, never Object's (ruling I).
  return Object.hasOwn(TYPE_WORDS, w) ? TYPE_WORDS[w]! : { other: v.trim().slice(0, 40) };
}

function depthOf(v: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  let max = depth;
  if (Array.isArray(v)) for (const x of v) max = Math.max(max, depthOf(x, depth + 1));
  else if (isRec(v)) for (const x of Object.values(v)) max = Math.max(max, depthOf(x, depth + 1));
  return max;
}

/** Enum words read as another value of the field: RoleCall's `critical` significance is `pivotal` (the lead's ruling G). */
const ENUM_SYNONYMS: Readonly<Record<string, Readonly<Record<string, string>>>> = { 'summary.significance': { critical: 'pivotal' } };

/** A known field's value made to its kind, or undefined when it cannot be (the field is skipped). */
function coerce(v: unknown, kind: Kind, synonyms?: Readonly<Record<string, string>>): unknown {
  if (typeof kind === 'object') {
    if (!isStr(v)) return undefined;
    const w = fold(v);
    const word = synonyms !== undefined && Object.hasOwn(synonyms, w) ? synonyms[w]! : w;
    return kind.oneOf.includes(word) ? word : undefined;
  }
  switch (kind) {
    case 's':
      if (isStr(v)) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (typeof v === 'boolean') return String(v);
      if (Array.isArray(v) && v.length > 0 && v.every((x) => isStr(x) || (typeof x === 'number' && Number.isFinite(x)))) return v.join(', ');
      return undefined;
    case 'n':
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (isStr(v) && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return undefined;
    case 'b':
      if (typeof v === 'boolean') return v;
      if (isStr(v) && (fold(v) === 'true' || fold(v) === 'false')) return fold(v) === 'true';
      return undefined;
    case 'a':
      if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined);
      return isStr(v) || isRec(v) || (typeof v === 'number' && Number.isFinite(v)) ? [v] : undefined;
    case 'o':
      return isRec(v) ? v : undefined;
    case 'so':
      return isStr(v) || isRec(v) ? v : undefined;
  }
}

/** A field name as the type knows it: camelCase → snake_case when that is a known or service field. */
function fieldName(type: 'summary' | 'plot', key: string): string {
  if (fieldKind(type, key) !== undefined || !/[A-Z]/.test(key)) return key;
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return fieldKind(type, snake) !== undefined || SERVICE_FIELDS.has(snake) ? snake : key;
}

/** The entry's fields read leniently; a field of the wrong kind goes to `skipped` and the rest stays. */
function readFields(type: 'summary' | 'plot', entry: Rec, at: string, skipped: Skip[]): Rec {
  const out: Rec = {};
  for (const [raw, value] of Object.entries(entry)) {
    const key = fieldName(type, raw);
    if (SERVICE_FIELDS.has(key) || value === null || value === undefined) continue;
    const kind = fieldKind(type, key);
    if (kind === undefined) {
      put(out, key, value);
      continue;
    }
    const syn = `${type}.${key}`;
    const v = coerce(value, kind, Object.hasOwn(ENUM_SYNONYMS, syn) ? ENUM_SYNONYMS[syn] : undefined);
    if (v === undefined) skipped.push({ path: `${at}.${raw}`, why: `must be ${describeKind(kind)}` });
    else put(out, key, v);
  }
  return out;
}

/** A type-less item that reads as a summary (a parent_plot, or a title and a summary text). */
const looksLikeSummary = (e: Rec): boolean => text(e.parent_plot) !== undefined || text(e.parentPlot) !== undefined || (text(e.title) !== undefined && text(e.summary) !== undefined);

interface Reader {
  lim: HistorianLimits;
  out: HistorianAnswer;
  /** HistorianAnswer.offered, counted as the items are read. */
  offered: number;
}

/** An item counts as an offered summary unless it is a plot or names another type. */
const offers = (r: Reader, type: ItemType | undefined): void => {
  if (type === undefined || type === 'summary') r.offered++;
};

/** One item of a list: its type, its entry, then its fields; a bad item is skipped alone. */
function readItem(r: Reader, raw: unknown, at: string, dflt: 'summary' | 'plot' | undefined): void {
  const { out, lim } = r;
  const skip = (why: string): void => void out.skipped.push({ path: at, why });
  if (!isRec(raw)) {
    offers(r, dflt);
    return skip('not an object');
  }
  let type = typeWord(raw.type ?? raw.entry_type ?? raw.kind);
  let entry: Rec | undefined;
  let sub = at;
  if (raw.entry !== undefined) {
    if (!isRec(raw.entry)) {
      offers(r, type ?? dflt);
      return skip('it has no entry object');
    }
    entry = raw.entry;
    sub = `${at}.entry`;
  } else if (isRec(raw.data)) {
    entry = raw.data;
    sub = `${at}.data`;
  } else if (type === undefined) {
    for (const [k, v] of Object.entries(raw)) {
      const t = typeWord(k);
      if (isRec(v) && t !== undefined && typeof t === 'string') {
        type = t;
        entry = v;
        sub = `${at}.${k}`;
        break;
      }
    }
  }
  if (entry === undefined) {
    entry = {};
    for (const [k, v] of Object.entries(raw)) if (k !== 'type' && k !== 'entry_type' && k !== 'kind' && k !== 'book') put(entry, k, v);
  }
  if (type === undefined) type = dflt ?? (looksLikeSummary(entry) ? 'summary' : undefined);
  offers(r, type);
  if (type === undefined) return skip('it has no type');
  if (typeof type === 'object') {
    return skip(isEntryType(fold(type.other)) ? 'the historian writes only summaries and plots' : `its type "${type.other}" is not summary or plot`);
  }
  if (JSON.stringify(entry).length > lim.itemChars) return skip(`its entry is longer than ${lim.itemChars} characters`);
  if (depthOf(entry) > MAX_DEPTH) return skip(`its entry is nested deeper than ${MAX_DEPTH} levels`);
  const skipped: Skip[] = [];
  const data = readFields(type, entry, sub, skipped);
  if (type === 'plot') {
    if (text(data.name) === undefined && text(data.title) !== undefined) {
      data.name = data.title;
      delete data.title;
    }
    const name = text(data.name);
    if (name === undefined) return skip('it has no name');
    data.name = name;
    out.skipped.push(...skipped);
    out.plots.push({ at, data });
    return;
  }
  if (text(data.title) === undefined && text(data.name) !== undefined) {
    data.title = data.name;
    delete data.name;
  }
  const title = text(data.title);
  if (title === undefined) return skip('it has no title');
  if (text(data.summary) === undefined) return skip('it has no summary');
  data.title = title;
  const made = data.create_plot;
  delete data.create_plot;
  let plot = text(data.parent_plot);
  let madePlot: HistorianItem | null = null;
  if (plot === undefined && isRec(made)) {
    const name = text(made.name) ?? text(made.title);
    if (name !== undefined) {
      plot = name;
      const fields = readFields('plot', made, `${sub}.create_plot`, skipped);
      delete fields.title;
      madePlot = { at: `${sub}.create_plot`, data: { ...fields, name } };
    }
  }
  if (plot === undefined) return skip('every summary must belong to a plot (parent_plot)');
  data.parent_plot = plot;
  out.skipped.push(...skipped);
  if (madePlot !== null) out.plots.push(madePlot);
  out.summaries.push({ at, data });
}

const firstText = (o: Rec, keys: readonly string[]): string | undefined => {
  for (const k of keys) {
    const t = text(o[k]);
    if (t !== undefined) return t;
  }
  return undefined;
};

/** The arcs of an answer: a list of {plot, overview}, one such object, or a map plot → overview. */
function arcList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (!isRec(v)) return [v];
  if (firstText(v, ARC_PLOT) !== undefined || firstText(v, ARC_TEXT) !== undefined) return [v];
  return Object.entries(v).map(([plot, overview]) => ({ plot, overview }));
}

/**
 * D-176, §7.4.4: a historian answer (the decoded JSON) read leniently. Items: `filings` (also `entries`,
 * `items`; `summaries`/`recaps` and `plots`/`storylines` lists type their items), a top-level list, or a
 * lone item; each `{type, entry}`, `{type, data}`, `{type, …fields}`, `{summary: {…}}` or, type-less in
 * a general list, a summary when it reads as one. Only summaries and plots are taken; a summary needs a
 * title, a summary text and a plot (`parent_plot`, else `create_plot.name`, whose fields make a plot).
 * Arcs: `arcs` (also `arc`, `overviews`) as a list of {plot, overview}, one such object or a map; each
 * needs a plot and an overview. Items and arcs past 12 (lite 6) are skipped as `over_limit`. Invalid
 * (the corrective pass) only when the answer is not an object or a list, or holds neither items nor arcs
 * (`{}` is nothing to summarise). A summary's significance `critical` (RoleCall's word) reads as `pivotal`.
 */
export function readHistorianAnswer(raw: unknown, profile: CompendiumProfile = 'full'): ReadResult<HistorianAnswer> {
  const lim = HISTORIAN_LIMITS[profile];
  const out: HistorianAnswer = { summaries: [], plots: [], arcs: [], skipped: [] };
  const r: Reader = { lim, out, offered: 0 };
  const lists: { key: string; items: unknown[]; dflt: 'summary' | 'plot' | undefined }[] = [];
  let arcs: { key: string; items: unknown[] } | null = null;
  // The lead's ruling I: a list key holding null, '' or "none" says "nothing" (it is not unreadable).
  let nothing = false;
  if (Array.isArray(raw)) lists.push({ key: '', items: raw, dflt: undefined });
  else if (isRec(raw)) {
    for (const [key, dflt] of ITEM_LISTS) {
      const v = raw[key];
      if (Array.isArray(v)) lists.push({ key, items: v, dflt });
      else if (isRec(v)) lists.push({ key, items: [v], dflt });
      else if (saysNothing(v)) nothing = true;
    }
    for (const key of ARC_LISTS) {
      if (raw[key] === undefined) continue;
      if (saysNothing(raw[key])) {
        nothing = true;
        continue;
      }
      arcs = { key, items: arcList(raw[key]) };
      break;
    }
    if (lists.length === 0 && (raw.type !== undefined || raw.entry !== undefined)) lists.push({ key: 'filings', items: [raw], dflt: undefined });
    // The lead's ruling G: `{}` (no envelope, no item) is nothing to summarise, not an unreadable answer.
    if (lists.length === 0 && arcs === null && !nothing && Object.keys(raw).length > 0) return { ok: false, code: 'invalid', message: 'the answer has no "filings" list' };
  } else return { ok: false, code: 'invalid', message: 'the answer is not a JSON object' };

  let n = 0;
  for (const list of lists) {
    list.items.forEach((item, i) => {
      const at = `${list.key}[${i}]`;
      if (++n > lim.items) {
        offers(r, list.dflt);
        out.skipped.push({ path: at, why: 'over_limit' });
      } else readItem(r, item, at, list.dflt);
    });
  }
  out.offered = r.offered;
  arcs?.items.forEach((a, i) => {
    const at = `${arcs.key}[${i}]`;
    if (i >= lim.items) return void out.skipped.push({ path: at, why: 'over_limit' });
    const plot = isRec(a) ? firstText(a, ARC_PLOT) : undefined;
    const overview = isRec(a) ? firstText(a, ARC_TEXT) : undefined;
    if (plot === undefined || overview === undefined) out.skipped.push({ path: at, why: 'an arc needs a plot and an overview' });
    else out.arcs.push({ at, plot, overview });
  });
  return { ok: true, value: out, skipped: out.skipped };
}

// ---- the row's ops (Bunraku prepareItems, stageArcs, writeRecaps) -------------------------------------

export interface HistorianOps {
  /** file(plot)… (made, then the answer's), file(summary)…, arc… — the row's ops in that order. */
  ops: MemOp[];
  /** The answer's skips and what this step left out or cut (the row's `skipped`). */
  skipped: Skip[];
  /** The summaries the answer offered, refused ones included (HistorianAnswer.offered). */
  offered: number;
  /**
   * The summaries the row holds. The lead's ruling I: `offered > 0 && applied === 0` (every summary
   * refused) fails the attempt instead of closing the window; an answer that offered none still closes it.
   */
  applied: number;
}

/** The live session arc of a plot (normalized name), as the fold's `arc` op would find it. */
function sessionArc(entries: readonly CEntry[], plot: string): CEntry | undefined {
  return entries.find((e) => e.arc !== undefined && e.origin.kind === 'session' && e.retired === undefined && normalizeName(e.arc) === plot);
}

/**
 * D-176: the ops of the historian's row for `answer` over `window`, against the fold `view` the run
 * started from. Each summary belongs to a plot; a plot neither the view (live, any origin) nor the answer
 * has is made `{name, status:'active'}` once, before the rest (Bunraku prepareItems). A summary's text is
 * cut to 1 500 chars; `messages_covered` = the positions of the new part (export's formula); its range
 * is the row's. An answer's plot that would change nothing is left out. An arc applies only to a plot this
 * run's summaries name, the last one per plot wins, its overview cut to 6 000 (lite 1 200) chars, and it is
 * left out when the plot's arc already says exactly that. The lead's ruling I: a plot named by any of its
 * names or aliases (findMatch in the view, else a plot of the answer) is that plot — the summaries name
 * it, and its arc is written under its canonical name, so one plot has one overview.
 */
export function historianOps(
  answer: HistorianAnswer,
  window: Pick<HistorianWindow, 'newStart' | 'end'>,
  view: Pick<CompendiumView, 'entries'>,
  profile: CompendiumProfile,
): HistorianOps {
  const lim = HISTORIAN_LIMITS[profile];
  const skipped = [...answer.skipped];
  const entries = [...view.entries.values()];
  const known = new Set<string>();
  for (const e of entries) if (e.type === 'plot' && e.retired === undefined) for (const n of entryNames(e)) known.add(n);
  const answerPlots: { name: string; names: Set<string> }[] = [];
  for (const p of answer.plots) {
    const names = new Set<string>();
    for (const v of [p.data.name, ...(Array.isArray(p.data.aliases) ? p.data.aliases : [])]) {
      const n = isStr(v) ? normalizeName(v) : '';
      if (n !== '') names.add(n);
    }
    for (const n of names) known.add(n);
    if (isStr(p.data.name) && normalizeName(p.data.name) !== '') answerPlots.push({ name: p.data.name.trim(), names });
  }
  /** The canonical name of the plot a name means: the view's plot (findMatch), else the answer's, else the name. */
  const canonical = (written: string): string => {
    const match = findMatch(entries, 'plot', [written]);
    if (match !== null) return match.name;
    const n = normalizeName(written);
    return answerPlots.find((p) => p.names.has(n))?.name ?? written;
  };

  const answered: MemOp[] = [];
  for (const p of answer.plots) {
    const name = isStr(p.data.name) ? p.data.name.trim() : '';
    if (normalizeName(name) === '') {
      skipped.push({ path: `${p.at}.name`, why: 'the name has no letters or digits' });
      continue;
    }
    const aliases = Array.isArray(p.data.aliases) ? p.data.aliases.filter(isStr) : [];
    const old = findMatch(entries, 'plot', [name, ...aliases]);
    if (old !== null && !mergeData(old.data, p.data, { keep: IDENTITY_KEEP, on: null, appended: old.prov.appended }).changed) continue;
    answered.push({ op: 'file', type: 'plot', data: { ...p.data, name } });
  }

  const made: MemOp[] = [];
  const summaries: MemOp[] = [];
  const named = new Set<string>();
  const covered = window.end - window.newStart + 1;
  for (const s of answer.summaries) {
    const title = isStr(s.data.title) ? s.data.title.trim() : '';
    const plot = isStr(s.data.parent_plot) ? s.data.parent_plot.trim() : '';
    const n = normalizeName(plot);
    if (normalizeName(title) === '') {
      skipped.push({ path: `${s.at}.title`, why: 'the title has no letters or digits' });
      continue;
    }
    if (n === '') {
      skipped.push({ path: `${s.at}.parent_plot`, why: 'the plot name has no letters or digits' });
      continue;
    }
    if (!known.has(n)) {
      known.add(n);
      made.push({ op: 'file', type: 'plot', data: { name: plot, status: 'active' } });
    }
    named.add(normalizeName(canonical(plot)));
    const full = isStr(s.data.summary) ? s.data.summary.trim() : '';
    const summary = clipText(full, SUMMARY_CHARS);
    if (summary !== full) skipped.push({ path: `${s.at}.summary`, why: `cut to ${SUMMARY_CHARS} chars` });
    const data: Rec = {};
    for (const [k, v] of Object.entries(s.data)) if (k !== 'create_plot' && !SERVICE_FIELDS.has(k)) put(data, k, v);
    summaries.push({ op: 'file', type: 'summary', data: { ...data, title, parent_plot: plot, summary, messages_covered: covered } });
  }

  const plotOf = answer.arcs.map((a) => canonical(a.plot));
  const lastOf = new Map<string, number>();
  plotOf.forEach((plot, i) => lastOf.set(normalizeName(plot), i));
  const arcs: MemOp[] = [];
  answer.arcs.forEach((a, i) => {
    const plot = plotOf[i]!;
    const n = normalizeName(plot);
    if (n === '' || !named.has(n)) return void skipped.push({ path: a.at, why: 'no summary of this run names the plot' });
    if (lastOf.get(n) !== i) return void skipped.push({ path: a.at, why: 'a later arc of this answer rewrites the same plot' });
    const overview = clipText(a.overview, lim.overviewChars);
    if (overview !== a.overview) skipped.push({ path: `${a.at}.overview`, why: `cut to ${lim.overviewChars} chars` });
    if (sessionArc(entries, n)?.content === overview) return;
    arcs.push({ op: 'arc', plot, overview });
  });
  return { ops: [...made, ...answered, ...summaries, ...arcs], skipped, offered: answer.offered ?? answer.summaries.length, applied: summaries.length };
}

