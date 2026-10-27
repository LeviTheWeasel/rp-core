// Ported from RoleCall:apps/rc/src/lib/ai/btw/scene-search.ts, btw/tools/search-scene-messages.ts and
// btw/tools/read-scene-messages.ts@fb8dc623e, and Bunraku:src/studio/dramaturg-tools.ts@702d8120.
// Copyright (C) 2026 Levi, Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// search_history and read_history (ARCHITECTURE.md §7.5, D-46, D-58), and the same search for
// /search and history/search. Port sources: RoleCall ai/btw/scene-search.ts, tools/
// search-scene-messages.ts, read-scene-messages.ts (Levi's search, paging; Chi's scaffold) and
// Bunraku src/studio/dramaturg-tools.ts (Levi: #n numbering from 1, hidden stubs, pages), see the
// scratch note m3-port-search.md. Changed: Unicode words and stems (text/normalize.ts), the active
// path only (hidden messages and swipe siblings never searched), a cursor from the last hit.
// CONTRACT FILE (M3): signatures are fixed; the builtins agent implements the bodies.
//
// Port notes. Kept from RoleCall: the ±110 snippet on whitespace-collapsed text with '…' at cut ends
// (buildSnippet), literal matching only (no model-written regex: a regex the model writes against
// prose it has not read fails silently far more often than it finds anything), "an empty result is
// about your wording", "you have read the range only when next_from is null". Kept from Bunraku:
// numbers are path positions from 1 with hidden messages counted, `to` inclusive, whole messages per
// page, the first message always taken (cut with a remainder note when it alone passes the page),
// "You have not read #a to #b yet", "The chat ends at #n", newest-first search, speakers by role.
// Changed: AND over word stems and quoted phrases instead of RoleCall's substring / Bunraku's
// lower-cased words; a hidden message reads `#n (hidden)`; RoleCall's continuation bug (a cursor
// taken from the scanned window's edge skips unmatched messages) is avoided: the cursor is the
// number of the oldest hit returned, and only when an older hit exists; the page is D-58's
// (ctx.pageChars: historyPageChars capped by the tool room, never below PAGE_FLOOR_CHARS) instead of
// Bunraku's 18 000 and RoleCall's 4-message floor; the paging lines come after the messages, and a
// message cut at the page says its rest cannot be read (Bunraku) rather than RoleCall's bare count.
// The descriptions follow Levi's RoleCall guidance (personalities/rc-knowledge.ts "FINDING THINGS IN
// THE SCENE", the-dramaturg.ts method and neverClaim rules): search first, empty is about wording,
// quote only what was read and name its number, never claim an unread range.

import type { Block } from '../../session/entries.ts';
import type { MessageView, PathView } from '../../session/view.ts';
import { matchQuery, parseQuery, wordsOf, type Query, type Word } from '../../text/normalize.ts';
import type { Tool, ToolCtx, ToolOutput } from '../types.ts';

/** §7.5: snippet radius around the first match, in characters. */
export const SNIPPET_RADIUS = 110;
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 20;
/** D-58: the read_history page is clamp(15 % of the window in characters, 6 000, 18 000). */
export const PAGE_MIN_CHARS = 6000;
export const PAGE_MAX_CHARS = 18000;
/** Characters per token for the window → characters conversion (prompt/tokens.ts CHARS_PER_TOKEN). */
export const PAGE_CHARS_PER_TOKEN = 3;
/**
 * D-58: the paging lines and a cut note take far less than this; read_history's maxOutput is two
 * pages plus it (a page, or two whole messages when the room allows, see readHistoryTool).
 */
export const PAGE_SLACK_CHARS = 1000;
/** read_history never pages below this, whatever room the engine passes: a message's head at least. */
export const PAGE_FLOOR_CHARS = 500;
/** search_history's result limit: 20 long hits and the paging line fit. A smaller room lowers it (outputRoom). */
export const SEARCH_OUTPUT_MAX = 8000;

/**
 * The characters a listing tool may fill this round: `max`, or less when the tool room is short.
 * - ctx.limit (runTools: this run's share of the round's room, capped by maxOutput) binds first: a
 *   tool that fits its lines to it keeps its cursor, where the runner's blind cut would drop it;
 * - ctx.pageChars is min(page, room) (engine, C6) and a page is never below PAGE_MIN_CHARS, so a
 *   smaller pageChars is the room left: also fitted to (never below PAGE_FLOOR_CHARS), for a tool
 *   run outside runTools.
 */
export function outputRoom(ctx: ToolCtx, max: number): number {
  let room = max;
  const p = ctx.pageChars;
  if (Number.isFinite(p) && p < PAGE_MIN_CHARS) room = Math.min(room, Math.max(PAGE_FLOOR_CHARS, Math.floor(p)));
  const limit = ctx.limit;
  if (limit !== undefined && Number.isFinite(limit)) room = Math.min(room, Math.max(0, Math.floor(limit)));
  return room;
}

/** D-58: the page size for a window of `window` tokens. */
export function historyPageChars(window: number): number {
  if (!Number.isFinite(window) || window <= 0) return PAGE_MIN_CHARS;
  // 15 % in integer arithmetic: 0.15 × n drifts below whole numbers in floating point.
  const chars = Math.floor((Math.floor(window) * PAGE_CHARS_PER_TOKEN * 15) / 100);
  return Math.min(PAGE_MAX_CHARS, Math.max(PAGE_MIN_CHARS, chars));
}

export interface HistoryHit {
  /** D-58: position on the active path from 1 (the greeting is #1; hidden messages keep their numbers). */
  n: number;
  id: string;
  role: 'user' | 'assistant';
  speaker: string;
  /** ±SNIPPET_RADIUS characters around the first match, '…' where cut, whitespace collapsed. */
  snippet: string;
  inContext: boolean;
}

export interface HistorySearch {
  /** Newest first. */
  hits: HistoryHit[];
  /** Pass as `before` to get the next older hits; null when there are none. */
  nextBefore: number | null;
}

// ---- reading messages ---------------------------------------------------------------------------

/** A message's readable text (its text blocks, joined as they streamed) and, once searched, its words. */
interface Readable {
  text: string;
  words?: readonly Word[];
}

/**
 * Words per stored message: keyed by the message's blocks array, which is the journal entry's own
 * (session/tree.ts effectiveMessage), so it survives the refold every turn makes: the first search
 * of a turn and the first /search after one stay warm. The text is checked again on every read.
 */
const READABLE = new WeakMap<readonly Block[], Readable>();

/** The text the narrator read: text blocks only (no reasoning, no tool calls or results). */
function textOf(m: MessageView): string {
  let text = '';
  for (const b of m.blocks) if (b.k === 'text') text += b.text;
  return text;
}

function readable(m: MessageView): Readable {
  const text = textOf(m);
  const known = READABLE.get(m.blocks);
  // The text is checked again (cheap): stored blocks are never edited in place, but if they were,
  // the words would be stale.
  if (known !== undefined && known.text === text) return known;
  const r: Readable = { text };
  READABLE.set(m.blocks, r);
  return r;
}

function wordsOfMessage(r: Readable): readonly Word[] {
  if (r.words === undefined) r.words = wordsOf(r.text);
  return r.words;
}

/**
 * The searchable words of a message (its text blocks), cached per stored blocks array: two views
 * folded from the same entries give the same array back.
 */
export function messageWords(m: MessageView): readonly Word[] {
  return wordsOfMessage(readable(m));
}

/** The path a turn's tools see: root → upTo (the whole path when upTo is null or not on it). */
function historyPath(view: PathView, upTo: string | null): readonly MessageView[] {
  if (upTo === null) return view.path;
  const i = view.path.findIndex((m) => m.id === upTo);
  return i < 0 ? view.path : view.path.slice(0, i + 1);
}

function speakerOf(m: MessageView, names: { char: string; user: string }): string {
  return m.role === 'assistant' ? names.char.trim() || 'Assistant' : names.user.trim() || 'User';
}

// ---- snippets -----------------------------------------------------------------------------------

const WS_RUN = /\s+/g;

/** RoleCall's flatten: whitespace runs to one space, trimmed (a snippet stays one readable line). */
function flatten(text: string): string {
  return text.replace(WS_RUN, ' ').trim();
}

/** Where original index `i` (at a non-space character, or just after one) lands in flatten(text). */
function flatIndex(text: string, i: number): number {
  return text.slice(0, i).replace(WS_RUN, ' ').trimStart().length;
}

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** flat[start, end), widened so no surrogate pair is split, trimmed, with '…' at each cut end. */
function clip(flat: string, start: number, end: number): string {
  let s = Math.max(0, start);
  let e = Math.min(flat.length, end);
  if (s > 0 && s < flat.length && isLowSurrogate(flat.charCodeAt(s))) s--;
  if (e > 0 && e < flat.length && isLowSurrogate(flat.charCodeAt(e))) e++;
  return `${s > 0 ? '…' : ''}${flat.slice(s, e).trim()}${e < flat.length ? '…' : ''}`;
}

/**
 * An excerpt of `text` around the match at [start, end) (original offsets), whitespace collapsed:
 * `lead` characters before the match, the match (at most `lead` of it), `lead` after. With no match,
 * the text's head (2 × lead characters).
 */
export function snippetAround(text: string, at: readonly [number, number] | null, lead: number = SNIPPET_RADIUS): string {
  const flat = flatten(text);
  if (at === null) return clip(flat, 0, 2 * lead);
  const fs = flatIndex(text, at[0]);
  const fe = Math.max(fs, flatIndex(text, at[1]));
  return clip(flat, fs - lead, Math.min(fe, fs + lead) + lead);
}

/** An excerpt of at most `width` characters (ellipses aside) that shows the match about a third in. */
export function excerptAround(text: string, at: readonly [number, number] | null, width: number): string {
  const flat = flatten(text);
  if (at === null || flat.length <= width) return clip(flat, 0, width);
  const fs = flatIndex(text, at[0]);
  const start = Math.max(0, Math.min(fs - Math.floor(width / 3), flat.length - width));
  return clip(flat, start, start + width);
}

// ---- the search ---------------------------------------------------------------------------------

const partsOf = (q: Query): number => q.terms.length + q.phrases.length + q.substrings.length;

/** A whole number from what a caller passed, or undefined when it is not a finite number. */
const whole = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined);

/**
 * §7.5 search over the active path of `view` up to `upTo` (null: the whole path): the effective text
 * of each visible message's text blocks; every query part must match (AND); newest first; at most
 * `limit` (default SEARCH_LIMIT_DEFAULT, max SEARCH_LIMIT_MAX) hits; `before`: only messages with
 * n < before. An empty query (no parts) returns no hits.
 */
export function searchHistory(
  view: PathView,
  upTo: string | null,
  query: string,
  opts: { before?: number; limit?: number; names: { char: string; user: string }; inContext?: (id: string) => boolean },
): HistorySearch {
  const q = parseQuery(query);
  if (partsOf(q) === 0) return { hits: [], nextBefore: null };
  const path = historyPath(view, upTo);
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, whole(opts.limit) ?? SEARCH_LIMIT_DEFAULT));
  const before = whole(opts.before);
  // #n sits at index n - 1; `before` keeps n < before.
  const newest = before === undefined ? path.length - 1 : Math.min(path.length - 1, before - 2);
  const hits: HistoryHit[] = [];
  for (let i = newest; i >= 0; i--) {
    const m = path[i] as MessageView;
    if (m.hidden) continue;
    const r = readable(m);
    if (r.text === '') continue;
    const found = matchQuery(q, r.text, wordsOfMessage(r));
    if (!found.all) continue;
    // One hit past the limit only proves that older ones exist: the cursor is the last hit returned.
    if (hits.length === limit) return { hits, nextBefore: (hits.at(-1) as HistoryHit).n };
    hits.push({
      n: i + 1,
      id: m.id,
      role: m.role,
      speaker: speakerOf(m, opts.names),
      snippet: snippetAround(r.text, found.first),
      inContext: opts.inContext?.(m.id) === true,
    });
  }
  return { hits, nextBefore: null };
}

// ---- the tools ----------------------------------------------------------------------------------

const fail = (text: string, summary: string): ToolOutput => ({ text, summary, error: true });

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A message number the model passed: a whole number ≥ 1, else null. */
const messageNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null);

const SEARCH_DESCRIPTION = [
  'Search the earlier messages of this chat, newest first.',
  'Use it when your reply needs a detail you cannot see in the messages in front of you: a name, a place, an object, something said long ago.',
  'A message matches when it holds every word of the query.',
  'Nouns, names and adjectives match their other forms, so search by word roots and short forms: брат finds брата and братом. One or two key words find more than a sentence.',
  'Put an exact phrase in quotes.',
  'Each hit is #n, the speaker and a short snippet; "(in context)" marks a message you can already see.',
  'A snippet is not the message: read it with read_history before you quote it or build on it.',
  'No hits means the words did not match, not that it never happened: try another word or a name first.',
].join(' ');

/**
 * search_history {query, before?, limit?}: the hits as lines `#n speaker: snippet` with
 * ' (in context)' where it applies, then 'More matches before #k: call search_history again with
 * before=k.' when nextBefore is set; 'No messages match.' otherwise. The description (English) asks
 * to search by word roots and short forms, quotes for exact phrases, and to read a message with
 * read_history before quoting it.
 */
export const searchHistoryTool: Tool = {
  name: 'search_history',
  description: SEARCH_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The words to find; a message must hold all of them. Roots and short forms work best (брат, not братом). Quotes mark an exact phrase.',
      },
      before: {
        type: 'integer',
        minimum: 1,
        description: 'Only messages numbered below this. For older hits, pass the number the previous result gave.',
      },
      limit: { type: 'integer', minimum: 1, description: `How many hits to return, 1 to ${SEARCH_LIMIT_MAX}. Default ${SEARCH_LIMIT_DEFAULT}.` },
    },
    required: ['query'],
    additionalProperties: false,
  },
  effect: 'read',
  maxOutput: (ctx) => outputRoom(ctx, SEARCH_OUTPUT_MAX),
  async run(args, ctx: ToolCtx): Promise<ToolOutput> {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    if (partsOf(parseQuery(query)) === 0) return fail('The query holds no words to search for. Give one or more words to find.', 'no words');
    const before = whole(args['before']);
    const limit = whole(args['limit']);
    const found = searchHistory(ctx.view, ctx.upTo, query, {
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
      names: ctx.names,
      inContext: (id) => ctx.inContext(id),
    });
    if (found.hits.length === 0) {
      const text =
        before !== undefined
          ? `No messages before #${before} match.`
          : 'No messages match. That is about the words, not the story: try a shorter root, another word or a name before you decide it never happened.';
      return { text, summary: 'no hits' };
    }
    // Lines that fit the room (the paging line kept free); a hit left out stays reachable through the cursor.
    const room = outputRoom(ctx, SEARCH_OUTPUT_MAX) - 100;
    const lines: string[] = [];
    let used = 0;
    let shown = 0;
    for (const h of found.hits) {
      const line = `#${h.n} ${h.speaker}: ${h.snippet}${h.inContext ? ' (in context)' : ''}`;
      if (shown > 0 && used + line.length + 1 > room) break;
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
    const next = shown < found.hits.length ? (found.hits[shown - 1] as HistoryHit).n : found.nextBefore;
    if (next !== null) lines.push(`More matches before #${next}: call search_history again with before=${next}.`);
    return { text: lines.join('\n'), summary: `${plural(shown, 'hit', 'hits')}${next !== null ? `, more before #${next}` : ''}` };
  },
};

const READ_DESCRIPTION = [
  'Read earlier messages of this chat whole, from #from to #to. Messages are numbered from #1, the first message of the chat.',
  'The result is a page: it holds as many whole messages as fit, then next_from names the first message you have not read yet (call again with from set to it), or null once the whole range is read.',
  'A hidden message shows as "#n (hidden)": it is not part of the story.',
  'You have read only what a page shows: never claim to have read, summarise or quote a message it did not return, and give the number of the message you quote.',
].join(' ');

/** The page for this round: ctx.pageChars, never below PAGE_FLOOR_CHARS. */
function pageOf(ctx: ToolCtx): number {
  const p = ctx.pageChars;
  return Number.isFinite(p) ? Math.max(PAGE_FLOOR_CHARS, Math.floor(p)) : PAGE_MIN_CHARS;
}

/** The first `n` UTF-16 units of s, one fewer when that would split a surrogate pair. */
export function headOf(s: string, n: number): string {
  if (n <= 0) return '';
  if (n >= s.length) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** The paging lines after the messages (each line after a '\n'): returned, next_from, then what is unread or where the chat ends. */
function pagingTail(from: number, last: number, next: number | null, end: number, total: number, to: number | null): string {
  const lines = ['', '', `returned: #${from} to #${last}`, `next_from: ${next ?? 'null'}`];
  if (next !== null) lines.push(`You have not read #${next} to #${end} yet. Call read_history with from=${next} before you say anything about them.`);
  else if (to === null || to > total) lines.push(`The chat ends at #${total}.`);
  return lines.join('\n');
}

/** The note after the head of a message cut at the page. */
const cutNoteOf = (n: number, rest: number): string => `\n[#${n} continues for ${rest} more characters, which read_history cannot show]`;

/**
 * A cut message shows at least this much of its head: less says nothing of it, and the result is
 * then only the cursor (noRoomText). Only reached when the result may take less than a page.
 */
export const READ_MIN_HEAD_CHARS = 100;

/** The whole result when what it may take cannot hold a useful head of #from: only the cursor, and the rule. */
function noRoomText(from: number, end: number): string {
  return [
    `No room was left in this round to read #${from}.`,
    `next_from: ${from}`,
    `You have not read #${from} to #${end}: never claim to have read them.`,
  ].join('\n');
}

/**
 * read_history {from, to?}: messages #from..#to (inclusive; to defaults to from + what fits) on the
 * path up to upTo, each as `#n speaker:\n<text>`, a hidden one as `#n (hidden)`; whole messages
 * until the page is reached (at least one; a message longer than the page is cut with
 * `[#n continues for N more characters, which read_history cannot show]`); then `next_from: k`
 * when the range continues. The description forbids claiming to have read messages that were not
 * returned.
 * Sizes: the page is ctx.pageChars (never below PAGE_FLOOR_CHARS), and never more than the result
 * may take (ctx.limit, else maxOutput) less the paging lines, so they always arrive: the result
 * never exceeds ctx.limit (a limit under PAGE_FLOOR_CHARS + the lines gets a smaller page; one that
 * cannot hold READ_MIN_HEAD_CHARS of the first message gets only the cursor: `No room was left in
 * this round to read #from.`, `next_from: from` and the never-claim line). D-58's floor of two whole
 * messages: when the second message passes the page but fits what the result may take, it comes
 * too. maxOutput = 2 × page + PAGE_SLACK_CHARS (two page-sized messages and the lines).
 */
export const readHistoryTool: Tool = {
  name: 'read_history',
  description: READ_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      from: { type: 'integer', minimum: 1, description: 'The first message to read, by its number (#1 is the first message of the chat).' },
      to: { type: 'integer', minimum: 1, description: 'The last message to read, inclusive. Leave it out to read on from `from` as far as one page goes.' },
    },
    required: ['from'],
    additionalProperties: false,
  },
  effect: 'read',
  maxOutput: (ctx) => 2 * pageOf(ctx) + PAGE_SLACK_CHARS,
  async run(args, ctx: ToolCtx): Promise<ToolOutput> {
    const from = messageNumber(args['from']);
    if (from === null) return fail('from must be a message number, 1 or more (#1 is the first message of the chat).', 'bad range');
    let to: number | null = null;
    if (args['to'] !== undefined && args['to'] !== null) {
      to = messageNumber(args['to']);
      if (to === null) return fail('to must be a message number, 1 or more.', 'bad range');
      if (to < from) return fail(`to (#${to}) must not be before from (#${from}).`, 'bad range');
    }
    const path = historyPath(ctx.view, ctx.upTo);
    const total = path.length;
    if (total === 0) return fail('The chat has no messages yet.', 'no messages');
    if (from > total) return fail(`The chat has ${plural(total, 'message', 'messages')}; #${from} is past the end. Read from #1 to #${total}.`, 'past the end');
    const end = Math.min(to ?? total, total);
    const pieceOf = (n: number): string => {
      const m = path[n - 1] as MessageView;
      return m.hidden ? `#${n} (hidden)` : `#${n} ${speakerOf(m, ctx.names)}:\n${readable(m).text || '(no text)'}`;
    };

    // What the result may take (this run's share of the room, else maxOutput), less the longest
    // paging lines this range can have (numbers never wider than #end or #total): the messages' room.
    // The result never takes more than the limit, so the runner never cuts it and the cursor always
    // arrives: below PAGE_FLOOR_CHARS of body the page is what is left, and when the first message
    // neither fits nor leaves room for a useful head, the result is the cursor alone.
    const own = 2 * pageOf(ctx) + PAGE_SLACK_CHARS;
    const limit = ctx.limit !== undefined && Number.isFinite(ctx.limit) ? Math.max(0, Math.min(own, Math.floor(ctx.limit))) : own;
    const tailMax = Math.max(pagingTail(from, end, end, end, total, to).length, pagingTail(from, end, null, end, total, to).length);
    const body = limit - tailMax;
    const page = Math.min(pageOf(ctx), body);
    const noRoom = (): ToolOutput => ({ text: noRoomText(from, end), summary: `no room, next #${from}` });

    const pieces: string[] = [];
    let used = 0;
    let next: number | null = null;
    let firstCut = false;
    for (let n = from; n <= end; n++) {
      let piece = pieceOf(n);
      if (pieces.length > 0) {
        // Whole messages while they fit the page; a second whole one also when it fits the body (D-58).
        const fits = used + 2 + piece.length <= page || (pieces.length === 1 && !firstCut && used + 2 + piece.length <= body);
        if (!fits) {
          next = n;
          break;
        }
      } else if (piece.length > page) {
        // The first one always comes: its head, and how much is missing, inside the body.
        const note = cutNoteOf(n, piece.length);
        const room = Math.min(page, body - note.length);
        if (room < READ_MIN_HEAD_CHARS) return noRoom();
        const kept = headOf(piece, room);
        piece = `${kept}${cutNoteOf(n, piece.length - kept.length)}`;
        firstCut = true;
      }
      used += (pieces.length > 0 ? 2 : 0) + piece.length;
      pieces.push(piece);
    }

    const last = next === null ? end : next - 1;
    const text = pieces.join('\n\n') + pagingTail(from, last, next, end, total, to);
    return { text, summary: `#${from} to #${last}${next !== null ? `, next #${next}` : ''}` };
  },
};
