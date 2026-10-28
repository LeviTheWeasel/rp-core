// Ported from Bunraku:src/core/compendium/filing-prompt.ts@702d8120 (filingMessages: the full prompt),
// Bunraku:src/core/compendium/filing-schema.ts@702d8120 (MAX_ITEMS, MAX_ITEM_CHARS, MAX_DEPTH, the
// order of the item checks and their reasons), Bunraku:src/core/compendium/filing-stage.ts@702d8120
// (items applied in order to a working copy, classic names refused, required fields after the merge,
// a merge that changes nothing is no write), Bunraku:src/core/compendium/snapshot.ts@702d8120 (the
// snapshot line, the resolved-plot filter, the greedy budget and its tail) and
// Bunraku:src/studio/compendium-filing.ts@702d8120 (temperature 0.3, max_tokens 4096); the memory
// rule from RoleCall:apps/rc/src/lib/ai/dm-stream/tools/compendium-definitions.ts:2786-2812@fb8dc623e.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Filing (ARCHITECTURE.md §7.4.3; .notes/m5b-decisions.md D-173…D-175): what one filing call sends,
// how its answer is read, and the ops the row then holds. Pure: no I/O, no engine, no clock.
// - filingRequest: the full prompt is Bunraku's filingMessages word for word except five lines (D-173):
//   (1) the books list → one line about this story's Compendium; (2) the character type line names
//   RoleCall's nested forms of current_state, relationships and memories, and the memory example
//   says what_happened; (3) the snapshot also lists the readable books' typed entries, under
//   `### <book> (library)`; (4) the example item has no "book"; (5) the guidance header no longer
//   speaks of books. The lite prompt is a new text (D-79): the same rule paragraphs, LITE_FIELDS with
//   nested forms and enum values, a roster instead of the snapshot, at most 6 items. Budgets (D-174):
//   full when the whole request leaves 4 096 tokens of the window for the answer, else lite (≤ 45 %
//   of the window); a group that fits neither splits.
// - readFilingAnswer: Bunraku's per-item checks made lenient (D-82, D-175): envelopes, flat and
//   type-keyed items, en/ru type synonyms, camelCase keys, kind coercions, enum fixes; a bad field is
//   dropped into `skipped` and the item stays. RoleCall's memory rule drops one memory, not the call.
// - stageFiling: Bunraku's stageItems against the fold's view, producing deltas (agent `file` ops, no
//   target) instead of merged entries; the fold merges them again (D-74).
// Changes from the sources, each a listed deviation: the reading above (Bunraku rejects an item for
// any kind error); the reply is cut head and tail (Bunraku sends it whole); several exchanges per call
// (everyN); per-row ops ≤ 24 000 chars instead of a 48 000-byte receipt; summaries are never filed;
// `book` is ignored; the answer may be an array or carry its items under entries/items; `{}` is
// "nothing to file" (Bunraku: unreadable); a blank compendium.language ends the prompt's rules with
// «Write every field value in the language the story is written in.» (D-183; Bunraku adds nothing).

import type { ReadResult, Skip } from '../director/types.ts';
import { MESSAGE_OVERHEAD_TOKENS } from '../../prompt/tokens.ts';
import type { JSONSchema } from '../../providers/types.ts';
import { looseJson } from '../../tools/args.ts';
import { balancedEnd } from '../../tools/prompted.ts';
import { findMatch, normalizeName } from './apply.ts';
import {
  describeKind,
  ENTRY_TYPE_INFO,
  fieldKind,
  IDENTITY_KEEP,
  identityField,
  isBlank,
  isEntryType,
  knownFields,
  LITE_FIELDS,
  NESTED,
  parseStructured,
  REQUIRED_FIELDS,
  type Kind,
  type NestedShape,
} from './entry-types.ts';
import { mergeData, sameData } from './merge.ts';
import { entryMatchers, mentioned, mentionText, type MentionText } from './mention.ts';
import { RENDER_HIDDEN } from './render.ts';
import { ENTRY_TYPES, type CEntry, type CompendiumProfile, type CompendiumView, type EntryType, type MemOp, type Rec } from './types.ts';

// ---- limits (D-87, D-174) -------------------------------------------------------------------------

/** Per profile: items per answer, JSON chars per item, chars of the narrator's reply, the answer's max_tokens. */
export const FILING_LIMITS: Readonly<Record<CompendiumProfile, { items: number; itemChars: number; replyChars: number; maxTokens: number }>> = {
  full: { items: 12, itemChars: 6000, replyChars: 8000, maxTokens: 4096 },
  lite: { items: 6, itemChars: 3000, replyChars: 6000, maxTokens: 1500 },
};
/** Bunraku MAX_DEPTH: an entry's values may nest this deep (the entry's own fields are level 1). */
export const FILING_MAX_DEPTH = 6;
/** Bunraku COVERED_CHARS: one player message. */
export const PLAYER_CHARS = 4000;
/** D-174: when texts share the budget, a reply keeps at least this much. */
export const REPLY_FLOOR_CHARS = 1000;
/** And a player message this much (not in the note; the reply's floor halved). */
export const PLAYER_FLOOR_CHARS = 500;
/** D-87: the JSON of one row's ops. */
export const OPS_CHARS = 24_000;
/** Bunraku SNAPSHOT_TOKENS, clamped to SNAPSHOT_SHARE of the window (D-79, B15). */
export const SNAPSHOT_TOKENS = 30_000;
export const SNAPSHOT_SHARE = 0.3;
/** Full runs when the request leaves this many tokens of the window for the answer (D-174). */
export const FULL_ANSWER_TOKENS = 4096;
/** The whole lite request stays within this share of the window. */
export const LITE_SHARE = 0.45;
/** Lite: the roster's lines, and how many named entries it shows as brief JSON. */
export const ROSTER_LINES = 60;
export const ROSTER_BRIEFS = 4;
export const FILING_TEMPERATURE = 0.3;
/** Below this many tokens left for the answer the call is not made (structured.ts AGENT_OUTPUT_FLOOR). */
export const FILING_OUTPUT_FLOOR = 600;
/** Bookkeeping fields a model may copy from what it was shown; the fold and the export own them (D-175). */
export const SERVICE_FIELDS: ReadonlySet<string> = new Set(['writer_source', 'source_turn', 'source_job_id', 'turn_range', 'messages_covered']);

const RESOLVED_PLOT: ReadonlySet<string> = new Set(['resolved', 'failed', 'abandoned']);

// ---- small helpers --------------------------------------------------------------------------------

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const nonBlankStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Sets an own property, also for the key '__proto__' (data comes from model output). */
function put(o: Rec, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
  else o[key] = value;
}

/** At most `n` UTF-16 units from the start, never inside a surrogate pair. */
function headOf(text: string, n: number): string {
  if (n >= text.length) return text;
  if (n <= 0) return '';
  const c = text.charCodeAt(n - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** At most `n` UTF-16 units from the end, never starting inside a surrogate pair. */
function tailOf(text: string, n: number): string {
  if (n >= text.length) return text;
  if (n <= 0) return '';
  const at = text.length - n;
  const c = text.charCodeAt(at);
  return text.slice(c >= 0xdc00 && c <= 0xdfff ? at + 1 : at);
}

const cutNote = (n: number): string => `\n[... ${n} characters cut from the middle ...]\n`;

/** `text` in at most `max` chars: its head and tail around a note of what was cut (D-174). */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - cutNote(text.length).length;
  if (room <= 0) return headOf(text, Math.max(0, max));
  const head = headOf(text, Math.ceil(room / 2));
  const tail = tailOf(text, Math.floor(room / 2));
  return `${head}${cutNote(text.length - head.length - tail.length)}${tail}`;
}

/** Aliases as the fold stores them (apply.ts aliasList): trimmed, deduplicated by normalized name, none equal to the name. */
function aliasList(candidates: readonly string[], name: string): string[] {
  const seen = new Set([normalizeName(name)]);
  const out: string[] = [];
  for (const a of candidates) {
    const n = normalizeName(a);
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    out.push(a.trim());
  }
  return out;
}

/** The types a filing prompt offers: `allow` in its order, deduplicated, never `summary` (the historian's). */
export const filingTypes = (allow: readonly EntryType[]): EntryType[] => [...new Set(allow)].filter((t) => isEntryType(t) && t !== 'summary');

// ---- the prompt (D-173) ---------------------------------------------------------------------------

const INTRO = 'You are the post-generation lorebook writer. The narrator has just finished a reply. Capture what happened so the compendium stays alive.';
/** Edit 1: replaces Bunraku's WRITABLE LOREBOOKS header and its list. */
const WHERE = "You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only.";
const EMPTY_SNAPSHOT = '(these books hold no typed entries yet)';
const UPSERT =
  'UPSERT MECHANICS - filing adds, it never rewrites:\nFiling an entry whose canonical name already exists MERGES your fields into it: arrays append, nested objects deep-merge, scalars replace. Send only what is new or changed, never the fields you are not changing. You are adding deltas, not rewriting cards. Nothing you file can delete an entry.';
const NO_WRITE =
  'NO-WRITE DEFAULT:\nDurable storage is scarce attention, not a turn transcript. Begin from "nothing needs filing" and write only when the reply creates or changes information that will still matter after the source messages leave the narrator\'s live context. A character memory MUST name a lasting changed belief or changed behavior. It is normal to file nothing: answer with an empty list.';
const dedup = (shape: string): string =>
  `DEDUP - use the canonical name, not the variant the narrator just used:\nEach snapshot line is "${shape}". The aka list is every nickname or title the entry already answers to. If the entity the narrator is talking about is there under ANY of those names, file under the EXISTING canonical name and let the merge do the rest. Only invent a new entry when the entity is genuinely missing. This is the single most common source of duplicates.`;
const MATTERS =
  'WRITE ONLY WHAT MATTERS: lasting character development, plot progression, world changes, new recurring elements. Do NOT file props and set dressing, body language, trivial moment-to-moment actions, things already captured and unchanged, or scene ephemera.';
const RELATIONSHIPS =
  'RELATIONSHIPS: when you add a relationship on character A pointing to character B and B would also acknowledge A, file a second item for B that mirrors it. One-sided relationships are valid fiction (unrequited feelings, oblivious rivalries): do not force them.';
/** Edits 2 and 4: `what_happened` instead of `event`, no "book". */
const EXAMPLE = '{"filings":[{"type":"character","entry":{"name":"Canonical Name","memories":[{"what_happened":"...","changed_belief":"..."}]}}]}';
const BRIEFS_HEADER = 'ENTRIES NAMED IN THIS EXCHANGE, AS THEY STAND (send only what is new):';

/** Edit 5: Bunraku's header without "change the books you may use". */
const guidanceText = (g: string): string =>
  g.trim() ? `\n\nUSER FILING GUIDANCE (it cannot widen what you may write or override the no-write default):\n${g.trim()}` : '';
/** D-183: a blank compendium.language keeps the story's language (Bunraku adds nothing then). */
export const STORY_LANGUAGE = 'Write every field value in the language the story is written in.';
const languageText = (l: string): string => `\n\n${l.trim() ? `Write every field value in ${l.trim()}.` : STORY_LANGUAGE}`;
const answerFormat = (items: number): string =>
  `ANSWER FORMAT - reply with one JSON object and nothing else:\n${EXAMPLE}\nAt most ${items} items. {"filings":[]} means nothing to file.`;

/**
 * The nested forms a type line names (D-173 edit 2: RoleCall's whole forms in full; §7.4.3's LITE_FIELDS
 * table in lite). Keys `<type>.<field>`; values the nested fields shown, in NESTED order.
 */
const NESTED_SHOWN: Readonly<Record<CompendiumProfile, Readonly<Record<string, readonly string[]>>>> = {
  full: {
    'character.current_state': Object.keys(NESTED['character.current_state']!.fields),
    'character.relationships': Object.keys(NESTED['character.relationships']!.fields),
    'character.memories': Object.keys(NESTED['character.memories']!.fields),
  },
  lite: {
    'character.current_state': ['status', 'location', 'condition'],
    'character.relationships': ['with', 'nature', 'status', 'notes'],
    'character.memories': ['what_happened', 'changed_belief', 'changed_behavior', 'when', 'emotion'],
    'location.current_state': ['status'],
  },
};

const enumValues = (kind: Kind | undefined): string => (kind !== undefined && typeof kind === 'object' ? ` (${kind.oneOf.join('|')})` : '');

/** A nested form's fields: `with*`, `nature* (ally|…)` (lite), `changed_belief or changed_behavior*` for the memory rule. */
function nestedText(shape: NestedShape, fields: readonly string[], enums: boolean): string {
  const pair = shape.required.find((r) => r.includes('|'))?.split('|') ?? [];
  const both = pair.length === 2 && pair.every((f) => fields.includes(f));
  const out: string[] = [];
  for (const f of fields) {
    if (both && f === pair[1]) continue;
    const name = both && f === pair[0] ? `${pair[0]} or ${pair[1]}*` : shape.required.includes(f) ? `${f}*` : f;
    out.push(`${name}${enums ? enumValues(shape.fields[f]) : ''}`);
  }
  return out.join(', ');
}

function fieldText(type: EntryType, field: string, profile: CompendiumProfile): string {
  const kind = fieldKind(type, field);
  let text = REQUIRED_FIELDS[type].includes(field) ? `${field}*` : field;
  if (profile === 'lite') text += enumValues(kind);
  const shown = NESTED_SHOWN[profile][`${type}.${field}`];
  const shape = NESTED[`${type}.${field}`];
  if (shown !== undefined && shape !== undefined) {
    const inner = nestedText(shape, shown, profile === 'lite');
    text += kind === 'a' ? ` [{${inner}}]` : ` {${inner}}`;
  }
  return text;
}

/** Bunraku's type line: `- <type> (<Label>): f1*, f2, …` (full: every known field; lite: LITE_FIELDS). */
export function typeLine(type: EntryType, profile: CompendiumProfile): string {
  const fields = profile === 'lite' && type !== 'summary' ? LITE_FIELDS[type] : knownFields(type);
  return `- ${type} (${ENTRY_TYPE_INFO[type].label}): ${fields.map((f) => fieldText(type, f, profile)).join(', ')}`;
}

export interface FilingSystemInput {
  /** The types offered, in order (rendered as given; filingRequest drops `summary`). */
  allow: readonly EntryType[];
  /** Full: filingSnapshot's text; lite: the roster (and briefs). '' → Bunraku's placeholder. */
  snapshot: string;
  guidance: string;
  language: string;
}

/** The full system prompt: Bunraku filingMessages' system with D-173's five edits. */
export function fullFilingSystem(input: FilingSystemInput): string {
  return `${INTRO}

${WHERE}

COMPENDIUM SNAPSHOT:
${input.snapshot || EMPTY_SNAPSHOT}

ENTRY TYPES YOU MAY FILE (* is required; fields not listed are kept as given):
${input.allow.map((t) => typeLine(t, 'full')).join('\n')}

${UPSERT}

${NO_WRITE}

${dedup('Canonical Name (aka: alt1, alt2) - tagline')}

${MATTERS}

${RELATIONSHIPS}${guidanceText(input.guidance)}${languageText(input.language)}

${answerFormat(FILING_LIMITS.full.items)}`;
}

/** The lite system prompt (new text, D-173): the rule paragraphs verbatim, the roster, LITE_FIELDS. */
export function liteFilingSystem(input: FilingSystemInput): string {
  return `${INTRO}

${WHERE}

COMPENDIUM SNAPSHOT:
${input.snapshot || EMPTY_SNAPSHOT}

ENTRY TYPES YOU MAY FILE (* is required):
${input.allow.map((t) => typeLine(t, 'lite')).join('\n')}
Other fields of the type are kept if you send them.

${UPSERT}

${NO_WRITE}

${dedup('Canonical Name (aka: alt1, alt2) [type]')}

${MATTERS}

${RELATIONSHIPS}${guidanceText(input.guidance)}${languageText(input.language)}

${answerFormat(FILING_LIMITS.lite.items)}`;
}

/** One exchange of the group: the player's visible messages, then the narrator's reply (texts, no speaker prefix). */
export interface FilingExchange {
  user: readonly string[];
  reply: string;
}

/**
 * The user message (D-174). One exchange: Bunraku's text exactly. Several: the replies numbered oldest
 * first, then what the player said before each (an exchange with nothing said is left out), then
 * Bunraku's last line. Texts are trimmed; blank player messages are dropped.
 */
export function filingUser(exchanges: readonly FilingExchange[], language = ''): string {
  const ex = exchanges.map((e) => ({ reply: e.reply.trim(), user: e.user.map((u) => u.trim()).filter((u) => u !== '') }));
  return assembleUser(ex) + languageTail(language);
}

/**
 * D-183, section J: a named language is also the user message's last line (a weak model follows the end
 * of its prompt); nothing when blank, so a blank language keeps Bunraku's user text exactly.
 */
export const languageTail = (language: string): string => (language.trim() ? `\n\nWrite every field value in ${language.trim()}.` : '');

function assembleUser(ex: readonly { reply: string; user: readonly string[] }[]): string {
  if (ex.length <= 1) {
    const one = ex[0] ?? { reply: '', user: [] };
    const asked = one.user.length > 0 ? `\n\nThe reply answers:\n${one.user.join('\n\n')}` : '';
    return `The narrator just wrote this reply:\n\n${one.reply}${asked}\n\nFile anything that meets the rules above.`;
  }
  const replies = ex.map((e, k) => `[${k + 1}] ${e.reply}`).join('\n\n');
  const said = ex.flatMap((e, k) => (e.user.length > 0 ? [`[${k + 1}] ${e.user.join('\n\n')}`] : []));
  const answers = said.length > 0 ? `\n\nThey answer:\n${said.join('\n\n')}` : '';
  return `The narrator just wrote these replies, oldest first:\n\n${replies}${answers}\n\nFile anything that meets the rules above.`;
}

// ---- the snapshot (full) and the roster (lite) ----------------------------------------------------

/** A snapshot or roster entry: live, typed, not a summary, not a resolved/failed/abandoned plot (Bunraku :51). */
function shown(e: CEntry): boolean {
  if (e.type === null || e.type === 'summary' || e.retired !== undefined || e.arc !== undefined) return false;
  return !(e.type === 'plot' && RESOLVED_PLOT.has(String(e.data.status ?? '').trim().toLowerCase()));
}

const aka = (e: CEntry): string => (e.aliases.length > 0 ? ` (aka: ${e.aliases.join(', ')})` : '');

/**
 * Lite, when no room is left for the roster (the lead's ruling I): what stands in for it, so the model
 * is never told an empty Compendium while entries exist; '' (Bunraku's placeholder) when none is shown.
 */
function rosterLeftOut(view: CompendiumView): string {
  let n = 0;
  for (const e of view.entries.values()) if (shown(e)) n++;
  return n === 0 ? '' : `(the roster of the ${n} existing ${n === 1 ? 'entry' : 'entries'} was left out for room)`;
}

/** Bunraku's snapshot line. */
const snapshotLine = (e: CEntry): string =>
  `- ${e.name}${aka(e)}${e.tagline ? ` - ${e.tagline}` : ''} [${JSON.stringify(e.data).length} chars - add to it, do not rewrite]`;

/**
 * The full snapshot (Bunraku buildSnapshot, D-174): `### This story`, then `### <book name> (library)`
 * per readable book in `books` order, each by type label; one line per shown entry in handle order. Only
 * the lines count against `budget` (tokens); a line that does not fit is counted, and a later shorter one
 * may still fit; the tail says how many were left out. '' when nothing is shown.
 */
export function filingSnapshot(view: CompendiumView, books: ReadonlyMap<string, string>, budget: number, count: (text: string) => number): string {
  const groups = new Map<string, CEntry[]>([['', []]]);
  for (const id of books.keys()) groups.set(id, []);
  for (const e of view.entries.values()) {
    if (!shown(e)) continue;
    const g = e.origin.kind === 'session' ? '' : e.origin.book;
    const list = groups.get(g);
    if (list) list.push(e);
    else groups.set(g, [e]);
  }
  const out: string[] = [];
  let used = 0;
  let hidden = 0;
  for (const [g, list] of groups) {
    if (list.length === 0) continue;
    out.push(g === '' ? '### This story' : `### ${books.get(g) ?? g} (library)`);
    for (const type of ENTRY_TYPES) {
      const lines: string[] = [];
      for (const e of list) {
        if (e.type !== type) continue;
        const text = snapshotLine(e);
        const cost = count(text);
        if (used + cost > budget) hidden += 1;
        else {
          lines.push(text);
          used += cost;
        }
      }
      if (lines.length > 0) out.push(`${ENTRY_TYPE_INFO[type].label}:`, ...lines);
    }
  }
  if (hidden > 0) out.push(`(+${hidden} more entries not shown)`);
  return out.join('\n');
}

export interface RosterInput {
  view: CompendiumView;
  /** The exchange's texts, prepared (mention.ts mentionText). */
  mentionTexts: readonly MentionText[];
  /** The card character's and the persona's names (PathView.castNames). */
  castNames: readonly string[];
}

/** The lite roster, every candidate in order (G-13), and the brief JSON of the first named ones. */
export interface Roster {
  /** `- Name (aka: …) [type]` (+ ` (library)`), in priority order (not yet capped). */
  lines: string[];
  /** Per line, the brief JSON of a named entry (the first ROSTER_BRIEFS named ones), else null. */
  briefs: (string | null)[];
}

/**
 * G-13 / D-174: the entries named in the exchange first, then those named like the cast, then the rest;
 * inside each, the entry changed last first (a library entry no row touched: higher lore order first),
 * then handle order.
 */
export function filingRoster(input: RosterInput): Roster {
  const cast = new Set(input.castNames.map(normalizeName).filter((n) => n !== ''));
  const ranked: { e: CEntry; tier: number; at: number }[] = [];
  let at = 0;
  for (const e of input.view.entries.values()) {
    at++;
    if (!shown(e)) continue;
    const matchers = input.mentionTexts.length > 0 ? entryMatchers(e) : [];
    const named = matchers.length > 0 && input.mentionTexts.some((t) => mentioned(matchers, t));
    const isCast = !named && [e.name, ...e.aliases].some((n) => cast.has(normalizeName(n)));
    ranked.push({ e, tier: named ? 0 : isCast ? 1 : 2, at });
  }
  const order = (e: CEntry): number => (typeof e.order === 'number' ? e.order : -Infinity);
  ranked.sort((a, b) => a.tier - b.tier || b.e.prov.lastSeq - a.e.prov.lastSeq || (order(b.e) === order(a.e) ? 0 : order(b.e) > order(a.e) ? 1 : -1) || a.at - b.at);
  const briefs: (string | null)[] = [];
  let named = 0;
  for (const { e, tier } of ranked) {
    const brief = tier === 0 && named < ROSTER_BRIEFS;
    if (brief) named++;
    briefs.push(brief ? briefOf(e) : null);
  }
  return { lines: ranked.map(({ e }) => `- ${e.name}${aka(e)} [${e.type}]${e.origin.kind === 'library' ? ' (library)' : ''}`), briefs };
}

/** A brief's string values are cut to this many chars, its lists to their last BRIEF_LIST items. */
const BRIEF_CHARS = 300;
const BRIEF_LIST = 6;

function briefValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > BRIEF_CHARS ? `${headOf(v, BRIEF_CHARS - 1)}…` : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.slice(-BRIEF_LIST).map((x) => briefValue(x, depth + 1)).filter((x) => x !== undefined);
  const out: Rec = {};
  for (const [k, x] of Object.entries(v)) {
    if (RENDER_HIDDEN.has(k)) continue;
    const y = briefValue(x, depth + 1);
    if (y !== undefined && !isBlank(y)) put(out, k, y);
  }
  return out;
}

/** D-174: the identity, the LITE_FIELDS the entry has, its last 3 memories; as one line of JSON. */
function briefOf(e: CEntry): string {
  const type = e.type as Exclude<EntryType, 'summary'>;
  const idf = identityField(type);
  const out: Rec = { [idf]: e.name };
  for (const f of LITE_FIELDS[type]) {
    if (f === idf) continue;
    let v: unknown = f === 'aliases' ? (e.aliases.length > 0 ? e.aliases : undefined) : e.data[f];
    if (f === 'memories' && Array.isArray(v)) v = v.slice(-3);
    v = briefValue(v, 1);
    if (v === undefined || isBlank(v) || (Array.isArray(v) && v.length === 0) || (isRec(v) && Object.keys(v).length === 0)) continue;
    put(out, f, v);
  }
  return JSON.stringify(out);
}

/** The roster cut to `budget` tokens: a prefix of the lines (≤ ROSTER_LINES), the tail, then the briefs that fit. */
function rosterText(r: Roster, budget: number, count: (text: string) => number): string {
  if (r.lines.length === 0) return '';
  const tailCost = count(`(+${r.lines.length} more entries not shown)`) + 1;
  let left = budget - tailCost;
  let shownLines = 0;
  for (const line of r.lines.slice(0, ROSTER_LINES)) {
    const cost = count(line) + 1;
    if (cost > left) break;
    left -= cost;
    shownLines++;
  }
  const out = r.lines.slice(0, shownLines);
  const hidden = r.lines.length - shownLines;
  if (hidden > 0) out.push(`(+${hidden} more entries not shown)`);
  else left += tailCost;
  const briefs: string[] = [];
  let headerCost = count(BRIEFS_HEADER) + 2;
  for (const b of r.briefs.slice(0, shownLines)) {
    if (b === null) continue;
    const cost = count(b) + 1 + headerCost;
    if (cost > left) break;
    left -= cost;
    headerCost = 0;
    briefs.push(b);
  }
  return briefs.length > 0 ? `${out.join('\n')}\n\n${BRIEFS_HEADER}\n${briefs.join('\n')}` : out.join('\n');
}

// ---- the request (D-174) --------------------------------------------------------------------------

/** D-173: in `structured` the schema is the envelope only (a per-type schema would be a huge anyOf). */
export const FILING_SCHEMA: { name: string; schema: JSONSchema } = {
  name: 'filings',
  schema: {
    type: 'object',
    properties: {
      filings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: [...ENTRY_TYPES] }, entry: { type: 'object' } },
          required: ['type', 'entry'],
        },
      },
    },
    required: ['filings'],
  },
};

export interface FilingRequestInput {
  /** The fold at the group's last answer, the library seed included. */
  view: CompendiumView;
  /** LibrarySeed.books: library id → book name (the snapshot's `### <name> (library)`). */
  books: ReadonlyMap<string, string>;
  /** compendium.filing.allow; `summary` is never offered. */
  allow: readonly EntryType[];
  /** The profile wanted: compendiumProfile(cfg.profile, recorder window). */
  profile: CompendiumProfile;
  /** The recorder's request window (tokens). */
  window: number;
  /** The group's exchanges, oldest first, hidden messages left out. At least one. */
  exchanges: readonly FilingExchange[];
  /** The exchange's texts prepared for the roster; absent: built from `exchanges`. */
  mentionTexts?: readonly MentionText[];
  castNames?: readonly string[];
  /** compendium.guidance (shared with the historian) and compendium.language. */
  guidance: string;
  language: string;
  /** The session's token counter. */
  count: (text: string) => number;
}

export interface FilingCall {
  kind: 'call';
  system: string;
  /** One user message. */
  user: string;
  /** min(4 096 full / 1 500 lite, window − tokens). */
  maxTokens: number;
  temperature: number;
  schema: { name: string; schema: JSONSchema };
  /** After the full → lite fallback. */
  profile: CompendiumProfile;
  /** The request's estimate: system + user + per-message overhead. */
  tokens: number;
  /** Full was wanted but did not fit (the lane may say so). */
  fellBack?: true;
}

/**
 * `split`: several exchanges that fit neither profile even with every text at its floor — the lane
 * splits the group by halves (each part keyed by its last answer). `no_room`: one exchange whose
 * shortest request leaves less than FILING_OUTPUT_FLOOR tokens of the window for the answer.
 */
export type FilingRequest = FilingCall | { kind: 'split' } | { kind: 'no_room'; profile: CompendiumProfile; tokens: number };

interface Piece {
  text: string;
  cap: number;
  floor: number;
  /** Lower goes first when the texts share a budget: the newest exchange, its reply before its player messages. */
  rank: number;
}

/** The texts at their caps or the largest cuts that share `room` tokens; null when even the floors do not fit. */
function fitPieces(pieces: readonly Piece[], room: number, count: (text: string) => number): string[] | null {
  const base = pieces.map((p) => cutMiddle(p.text, Math.min(p.cap, p.floor)));
  const cost = base.map(count);
  const used = cost.reduce((a, b) => a + b, 0);
  if (used > room) return null;
  const out = base.slice();
  let left = room - used;
  const order = pieces.map((_, i) => i).sort((a, b) => pieces[a]!.rank - pieces[b]!.rank || a - b);
  for (const i of order) {
    const p = pieces[i]!;
    const top = Math.min(p.cap, p.text.length);
    const bottom = Math.min(p.cap, p.floor, p.text.length);
    if (top <= bottom) continue;
    const whole = cutMiddle(p.text, top);
    const extra = count(whole) - cost[i]!;
    if (extra <= left) {
      out[i] = whole;
      left -= extra;
      continue;
    }
    let lo = bottom;
    let hi = top - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (count(cutMiddle(p.text, mid)) - cost[i]! <= left) lo = mid;
      else hi = mid - 1;
    }
    out[i] = cutMiddle(p.text, lo);
    break;
  }
  return out;
}

interface Exchanges {
  ex: { reply: string; user: string[] }[];
  pieces(replyCap: number): Piece[];
  rebuild(texts: readonly string[]): { reply: string; user: string[] }[];
}

function exchangesOf(input: readonly FilingExchange[]): Exchanges {
  const ex = input.map((e) => ({ reply: e.reply.trim(), user: e.user.map((u) => u.trim()).filter((u) => u !== '') }));
  const n = ex.length;
  return {
    ex,
    pieces: (replyCap) =>
      ex.flatMap((e, k) => [
        { text: e.reply, cap: replyCap, floor: REPLY_FLOOR_CHARS, rank: 2 * (n - 1 - k) },
        ...e.user.map((u) => ({ text: u, cap: PLAYER_CHARS, floor: PLAYER_FLOOR_CHARS, rank: 2 * (n - 1 - k) + 1 })),
      ]),
    rebuild: (texts) => {
      let i = 0;
      return ex.map((e) => ({ reply: texts[i++] ?? '', user: e.user.map(() => texts[i++] ?? '') }));
    },
  };
}

/** The user message within `room` tokens (texts cut to share it), or null when the floors do not fit. */
function fitUser(x: Exchanges, replyCap: number, room: number, count: (text: string) => number): string | null {
  const frame = count(assembleUser(x.ex.map((e) => ({ reply: '', user: e.user.map(() => '') }))));
  let textsRoom = room - frame;
  const pieces = x.pieces(replyCap);
  // Counts of joined texts are not always the sum of their parts: correct by the excess, a few times.
  for (let tries = 0; tries < 4; tries++) {
    const texts = fitPieces(pieces, textsRoom, count);
    if (texts === null) return null;
    const user = assembleUser(x.rebuild(texts));
    const over = count(user) - room;
    if (over <= 0) return user;
    textsRoom -= over;
  }
  return null;
}

const sumCost = (pieces: readonly Piece[], at: (p: Piece) => number, count: (text: string) => number): number =>
  pieces.reduce((n, p) => n + count(cutMiddle(p.text, at(p))), 0);

/**
 * What one filing call sends (D-173, D-174). Full: Bunraku's prompt with the snapshot capped at
 * min(30 000, 30 % of the window) tokens; it runs when the request leaves FULL_ANSWER_TOKENS of the
 * window, the exchange texts cut to share what is left (newest first; a reply keeps ≥ 1 000 chars). Else
 * lite: the roster and briefs take what the texts at their caps leave, at least 30 % of the lite budget
 * when they need it; the whole request ≤ 45 % of the window. Several exchanges that fit neither →
 * `split`. One exchange that does not fit lite is sent at its floors without the roster when the window
 * still leaves FILING_OUTPUT_FLOOR for the answer, else `no_room`. A lite prompt without its roster says
 * the roster was left out for room (Bunraku's "no typed entries yet" only when there are none).
 */
export function filingRequest(input: FilingRequestInput): FilingRequest {
  const { count, window } = input;
  const types = filingTypes(input.allow);
  const x = exchangesOf(input.exchanges);
  const overhead = 2 * MESSAGE_OVERHEAD_TOKENS;
  const call = (profile: CompendiumProfile, system: string, body: string, fellBack: boolean): FilingRequest => {
    const user = body + languageTail(input.language);
    const tokens = count(system) + count(user) + overhead;
    const maxTokens = Math.min(FILING_LIMITS[profile].maxTokens, Math.floor(window - tokens));
    if (maxTokens < FILING_OUTPUT_FLOOR) return { kind: 'no_room', profile, tokens };
    return {
      kind: 'call',
      system,
      user,
      maxTokens,
      temperature: FILING_TEMPERATURE,
      schema: FILING_SCHEMA,
      profile,
      tokens,
      ...(fellBack ? { fellBack: true as const } : {}),
    };
  };

  let fellBack = false;
  if (input.profile === 'full') {
    const budget = Math.min(SNAPSHOT_TOKENS, Math.floor(SNAPSHOT_SHARE * window));
    const system = fullFilingSystem({ allow: types, snapshot: filingSnapshot(input.view, input.books, budget, count), guidance: input.guidance, language: input.language });
    const user = fitUser(x, FILING_LIMITS.full.replyChars, window - FULL_ANSWER_TOKENS - count(system) - overhead, count);
    if (user !== null) return call('full', system, user, false);
    fellBack = true;
  }

  const limit = Math.floor(LITE_SHARE * window);
  const replyCap = FILING_LIMITS.lite.replyChars;
  // Without the roster (no room for it): a line that says so, never "no typed entries yet" (ruling I).
  const system0 = liteFilingSystem({ allow: types, snapshot: rosterLeftOut(input.view), guidance: input.guidance, language: input.language });
  const frame = count(assembleUser(x.ex.map((e) => ({ reply: '', user: e.user.map(() => '') }))));
  const avail = limit - count(system0) - overhead - frame;
  const pieces = x.pieces(replyCap);
  const floors = sumCost(pieces, (p) => Math.min(p.cap, p.floor), count);
  if (avail < floors && x.ex.length > 1) return { kind: 'split' };
  let knowledge = '';
  if (avail >= floors) {
    const caps = sumCost(pieces, (p) => p.cap, count);
    const budget = Math.max(0, Math.min(avail - floors, Math.max(Math.floor(SNAPSHOT_SHARE * limit), avail - caps)));
    const texts = input.mentionTexts ?? x.ex.flatMap((e) => [e.reply, ...e.user]).filter((t) => t !== '').map(mentionText);
    knowledge = rosterText(filingRoster({ view: input.view, mentionTexts: texts, castNames: input.castNames ?? [] }), budget, count);
  }
  const system = knowledge === '' ? system0 : liteFilingSystem({ allow: types, snapshot: knowledge, guidance: input.guidance, language: input.language });
  const user = fitUser(x, replyCap, limit - count(system) - overhead, count);
  if (user !== null) return call('lite', system, user, fellBack);
  // Counts of joined texts can exceed the sum of their parts: without the roster before giving up.
  const bare = knowledge === '' ? null : fitUser(x, replyCap, limit - count(system0) - overhead, count);
  if (bare !== null) return call('lite', system0, bare, fellBack);
  if (x.ex.length > 1) return { kind: 'split' };
  // One exchange over the lite budget: its floors, no roster, if the window still holds an answer.
  const floored = assembleUser(x.rebuild(pieces.map((p) => cutMiddle(p.text, Math.min(p.cap, p.floor)))));
  return call('lite', system0, floored, fellBack);
}

// ---- reading the answer (D-82, D-175) -------------------------------------------------------------

/** One item read from the answer. `at` is its index in the answer's (flattened) list: `filings[at]`. */
export interface FilingItem {
  at: number;
  type: EntryType;
  /** The identity value, trimmed (also in `data`). */
  name: string;
  data: Rec;
}

export type FilingRead = { ok: true; items: FilingItem[]; skipped: Skip[] } | { ok: false; why: string };

export interface FilingReadOptions {
  allow: readonly EntryType[];
  /** Picks the limits: items 12 / 6, item JSON 6 000 / 3 000 chars. */
  profile: CompendiumProfile;
  /** The historian reads summaries through the same rules; filing never takes one (D-175). */
  summaries?: boolean;
}

/** D-82: en and ru words for the eleven types. */
const TYPE_SYNONYMS: Readonly<Record<string, EntryType>> = {
  npc: 'character',
  person: 'character',
  персонаж: 'character',
  place: 'location',
  место: 'location',
  локация: 'location',
  faction: 'organization',
  group: 'organization',
  организация: 'organization',
  фракция: 'organization',
  quest: 'plot',
  storyline: 'plot',
  сюжет: 'plot',
  квест: 'plot',
  lore: 'worldbuilding',
  rule: 'worldbuilding',
  мир: 'worldbuilding',
  правило: 'worldbuilding',
  monster: 'creature',
  beast: 'creature',
  существо: 'creature',
  ability: 'power',
  spell: 'power',
  skill: 'power',
  способность: 'power',
  сила: 'power',
  object: 'item',
  предмет: 'item',
  danger: 'threat',
  угроза: 'threat',
  событие: 'event',
};

const typeWord = (w: string): EntryType | null => (isEntryType(w) ? w : Object.hasOwn(TYPE_SYNONYMS, w) ? TYPE_SYNONYMS[w]! : null);

/** A type as a model wrote it: any case, spaces or hyphens for '_' (or none: "World Building"), a synonym, an English plural. */
export function resolveType(v: unknown): EntryType | null {
  if (typeof v !== 'string') return null;
  const spaced = v.trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s-]+/g, '_');
  for (const w of new Set([spaced, spaced.replace(/_/g, '')])) {
    if (w === '') continue;
    const t = typeWord(w) ?? (w.endsWith('ies') ? typeWord(`${w.slice(0, -3)}y`) : null) ?? (w.endsWith('s') ? typeWord(w.slice(0, -1)) : null);
    if (t !== null) return t;
  }
  return null;
}

/** A key as the schema spells it: camelCase, spaces and hyphens → snake_case, lower case. */
export function snakeKey(k: string): string {
  return k
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

/** An enum value as the schema spells it (D-82): snakeKey, runs of '_' collapsed, none at the ends. */
const enumKey = (s: string): string => snakeKey(s).replace(/_+/g, '_').replace(/^_|_$/g, '');

/** RoleCall's severity synonyms (tv-tree-typed.ts:417-423), without the sorting hack `resolved`. */
const SEVERITY_SYNONYMS: Readonly<Record<string, string>> = { existential: 'extinction_level', moderate: 'notable' };

const ENVELOPE = /^(?:filings?|entries|items)$/i;
const TYPE_KEYS = ['type', 'entry_type', 'entryType'] as const;
const ITEM_KEYS: ReadonlySet<string> = new Set([...TYPE_KEYS, 'book', 'entry', 'data']);

/** The item's entry object: `entry` (or `data`), a record or a JSON string of one. */
function entryField(raw: Rec): Rec | undefined {
  for (const k of ['entry', 'data']) {
    const v = raw[k];
    if (isRec(v)) return v;
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      const parsed = looseJson(v);
      if (parsed.ok && isRec(parsed.value)) return parsed.value;
    }
  }
  return undefined;
}

/**
 * The item-level key that gives the item's type: the first of type / entry_type / entryType whose value
 * names a type, else the first one given (the lead's ruling I: an `entry_type` that names a type wins
 * over a `type` that is the entry's own field, as a location's `type: building`).
 */
const typeKeyOf = (raw: Rec): (typeof TYPE_KEYS)[number] | undefined =>
  TYPE_KEYS.find((k) => resolveType(raw[k]) !== null) ?? TYPE_KEYS.find((k) => raw[k] !== undefined);

const typeOf = (raw: Rec): unknown => {
  const k = typeKeyOf(raw);
  return k === undefined ? undefined : raw[k];
};

/** A list element before the checks: the element, or (a type-keyed form) an entry and its type word. */
interface RawItem {
  raw: unknown;
  hint?: string;
}

/**
 * `{"character": {...}, "location": [{...}]}`: the elements under the keys that name a type, when the
 * object is one of that form — no identity field (name, title, topic) and every key that holds an
 * object or a list names a type (a stray scalar such as `"mood": "x"` is ignored); null otherwise. So an
 * entry whose fields happen to be type words (`abilities`, `events`, `rules`) next to its `name` is not
 * type-keyed: it is an item without a type, rejected as such (the lead's ruling I).
 */
function typeKeyed(v: Rec): RawItem[] | null {
  for (const [k, val] of Object.entries(v)) {
    if (IDENTITY_KEEP.includes(snakeKey(k))) return null;
    if (typeof val === 'object' && val !== null && resolveType(k) === null) return null;
  }
  const out: RawItem[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (resolveType(k) === null) continue;
    if (isRec(val)) out.push({ raw: val, hint: k });
    else if (Array.isArray(val)) for (const x of val) out.push({ raw: x, hint: k });
  }
  return out.length > 0 ? out : null;
}

const looksLikeItem = (v: Rec): boolean => typeOf(v) !== undefined || entryField(v) !== undefined;

function expand(el: unknown): RawItem[] {
  if (isRec(el) && !looksLikeItem(el)) return typeKeyed(el) ?? [{ raw: el }];
  return [{ raw: el }];
}

/** An envelope that says "nothing": null, a blank string or "none" (the lead's ruling I). */
const saysNothing = (v: unknown): boolean => v === null || (typeof v === 'string' && /^(?:none)?$/i.test(v.trim()));

/**
 * The answer's items, flattened (D-82 envelopes), or why the answer cannot be read as a whole. `{}` (no
 * envelope, no item) is "nothing to file" (the lead's ruling G; Bunraku: unreadable); so is an envelope
 * that holds null, '' or "none" (ruling I).
 */
function itemsOf(root: unknown): RawItem[] | string {
  if (Array.isArray(root)) return root.flatMap(expand);
  if (!isRec(root)) return 'the answer is not a JSON object';
  if (Object.keys(root).length === 0) return [];
  const key = Object.keys(root).find((k) => ENVELOPE.test(k.trim()));
  if (key !== undefined) {
    const list = root[key];
    if (Array.isArray(list)) return list.flatMap(expand);
    if (isRec(list)) return expand(list);
    if (saysNothing(list)) return [];
    return 'the answer has no "filings" list';
  }
  if (looksLikeItem(root)) return [{ raw: root }];
  return typeKeyed(root) ?? 'the answer has no "filings" list';
}

/** Deeper than FILING_MAX_DEPTH (Bunraku jsonSafe: the entry is level 0, its fields level 1). */
function tooDeep(v: unknown, depth: number): boolean {
  if (depth > FILING_MAX_DEPTH) return true;
  if (Array.isArray(v)) return v.some((x) => tooDeep(x, depth + 1));
  if (isRec(v)) return Object.values(v).some((x) => tooDeep(x, depth + 1));
  return false;
}

const DROP = Symbol('drop');

/**
 * How clean() spells an object's keys (the lead's ruling I): `fields` — the entry's own fields, as the
 * schema spells them (snakeKey); `records` — the value of a NESTED field (relationships, memories,
 * current_state…): its record or each of its records is a `record`, spelled so too; `free` — any other
 * object (a map keyed by names or labels: `stakes_per_character`, `family`, `notable_stats`) and
 * everything inside a record's values: keys as written, trimmed.
 */
type KeyMode = { kind: 'fields'; type: EntryType } | { kind: 'records' } | { kind: 'record' } | { kind: 'free' };

/**
 * Cleans a value from the answer: field keys to snake_case (a camelCase twin of a key given in
 * snake_case is dropped), other keys trimmed, service fields out, blank values and empty lists or
 * objects out, a non-finite number out (said in `skipped`). DROP when nothing is left.
 */
function clean(v: unknown, path: string, skipped: Skip[], mode: KeyMode): unknown {
  if (v === null || v === undefined) return DROP;
  if (typeof v === 'string') return v.trim() === '' ? DROP : v;
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
    skipped.push({ path, why: 'non_finite: a number too large for JSON' });
    return DROP;
  }
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const inner: KeyMode = mode.kind === 'records' ? { kind: 'record' } : { kind: 'free' };
    const out = v.map((x, j) => clean(x, `${path}[${j}]`, skipped, inner)).filter((x) => x !== DROP);
    return out.length > 0 ? out : DROP;
  }
  if (!isRec(v)) return DROP;
  const out: Rec = {};
  const exact = new Set<string>();
  for (const [k, x] of Object.entries(v)) {
    const key = mode.kind === 'free' ? k.trim() : snakeKey(k);
    if (key === '' || SERVICE_FIELDS.has(snakeKey(k))) continue;
    const child: KeyMode = mode.kind === 'fields' && NESTED[`${mode.type}.${key}`] !== undefined ? { kind: 'records' } : { kind: 'free' };
    const y = clean(x, `${path}.${key}`, skipped, child);
    if (y === DROP) continue;
    if (Object.hasOwn(out, key)) {
      // The key spelled as the schema spells it wins over its camelCase twin.
      if (exact.has(key) || k !== key) {
        skipped.push({ path: `${path}.${k}`, why: `duplicate_field: ${key} was given twice` });
        continue;
      }
      skipped.push({ path: `${path}.${key}`, why: `duplicate_field: ${key} was given twice` });
    }
    if (k === key) exact.add(key);
    put(out, key, y);
  }
  return Object.keys(out).length > 0 ? out : DROP;
}

type Coerced = { ok: true; value: unknown } | { ok: false; why: string };

/**
 * D-82's kind coercions: a string where a list is expected → [string] (an object → [object]); a list of
 * strings where a string is expected → joined with '; ' (a one-string list for an enum → that string);
 * a numeric string → a number; 'true'/'false' → a boolean; an enum lower-cased with spaces and hyphens
 * as '_' (threat severity: RoleCall's synonyms); a number where text is expected → its digits, at the
 * top level only (`age: 30`).
 */
function coerce(field: string, kind: Kind, v: unknown, top: boolean, synonyms?: Readonly<Record<string, string>>): Coerced {
  const fail = (): Coerced => ({ ok: false, why: `${typeof kind === 'object' ? 'bad_enum' : 'wrong_kind'}: ${field} must be ${describeKind(kind)}` });
  if (typeof kind === 'object') {
    const s = typeof v === 'string' ? v : Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' ? v[0] : null;
    if (s === null) return fail();
    let w = enumKey(s);
    if (synonyms && Object.hasOwn(synonyms, w)) w = synonyms[w]!;
    return kind.oneOf.includes(w) ? { ok: true, value: w } : fail();
  }
  const joined = Array.isArray(v) && v.length > 0 && v.every(isStr) ? v.join('; ') : null;
  switch (kind) {
    case 's':
      if (typeof v === 'string') return { ok: true, value: v };
      if (joined !== null) return { ok: true, value: joined };
      if (top && typeof v === 'number') return { ok: true, value: String(v) };
      return fail();
    case 'so':
      if (typeof v === 'string' || isRec(v)) return { ok: true, value: v };
      if (joined !== null) return { ok: true, value: joined };
      if (top && typeof v === 'number') return { ok: true, value: String(v) };
      return fail();
    case 'n':
      if (typeof v === 'number') return { ok: true, value: v };
      if (typeof v === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) return { ok: true, value: Number(v) };
      return fail();
    case 'b':
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (typeof v === 'string' && /^\s*(?:true|false)\s*$/i.test(v)) return { ok: true, value: v.trim().toLowerCase() === 'true' };
      return fail();
    case 'a':
      if (Array.isArray(v)) return { ok: true, value: v };
      if (typeof v === 'string' || isRec(v)) return { ok: true, value: [v] };
      return fail();
    case 'o':
      return isRec(v) ? { ok: true, value: v } : fail();
  }
  return fail();
}

/**
 * The fields of one nested record by its shape (kinds, enums); a bad field is dropped and said. A key
 * the shape does not own (`constructor`, `__proto__`) is an unknown field, kept as given (the lead's ruling I).
 */
function nestedRecord(shape: NestedShape, v: Rec, path: string, skipped: Skip[]): Rec {
  const out: Rec = {};
  for (const [k, x] of Object.entries(v)) {
    const kind = Object.hasOwn(shape.fields, k) ? shape.fields[k] : undefined;
    if (kind === undefined) {
      put(out, k, x);
      continue;
    }
    const c = coerce(k, kind, x, false);
    if (c.ok) put(out, k, c.value);
    else skipped.push({ path: `${path}.${k}`, why: c.why });
  }
  return out;
}

const MEMORY_RULE = 'memory_rule: a memory needs changed_belief or changed_behavior; objective events belong in the historian\'s summaries';

/**
 * A nested list (relationships, memories, affiliations, powers): records go through their shape. RoleCall's
 * memory rule (adapted, D-82): a memory with neither a non-blank changed_belief nor changed_behavior —
 * after `event` → `what_happened` and the coercions — is dropped; so is a relationship without `with`.
 */
function nestedList(type: EntryType, field: string, shape: NestedShape, list: unknown[], path: string, skipped: Skip[]): unknown[] {
  const out: unknown[] = [];
  list.forEach((x, j) => {
    const at = `${path}[${j}]`;
    let el = x;
    if (isRec(el)) {
      if (field === 'memories' && isBlank(el.what_happened) && el.event !== undefined) {
        const { event, ...rest } = el;
        el = { what_happened: event, ...rest };
      }
      el = nestedRecord(shape, el as Rec, at, skipped);
    }
    if (type === 'character' && field === 'memories') {
      const m = isRec(el) ? el : {};
      if (!nonBlankStr(m.changed_belief) && !nonBlankStr(m.changed_behavior)) return void skipped.push({ path: at, why: MEMORY_RULE });
    }
    if (type === 'character' && field === 'relationships' && !(isRec(el) && nonBlankStr(el.with))) {
      return void skipped.push({ path: at, why: 'no_with: a relationship needs "with"' });
    }
    out.push(el);
  });
  return out;
}

/** The known fields of an entry coerced to their kinds; a field that cannot be is dropped into `skipped`. */
function coerceEntry(type: EntryType, data: Rec, path: string, skipped: Skip[]): Rec {
  const out: Rec = {};
  for (const [field, v] of Object.entries(data)) {
    const at = `${path}.${field}`;
    if (field === 'aliases') {
      const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
      if (list === null || !list.some(isStr)) {
        skipped.push({ path: at, why: 'wrong_kind: aliases must be a list of names' });
        continue;
      }
      if (!list.every(isStr)) skipped.push({ path: at, why: 'wrong_kind: aliases must be a list of names; the other values were dropped' });
      put(out, field, list.filter(isStr));
      continue;
    }
    const kind = fieldKind(type, field);
    if (kind === undefined) {
      put(out, field, v);
      continue;
    }
    const c = coerce(field, kind, v, true, type === 'threat' && field === 'severity' ? SEVERITY_SYNONYMS : undefined);
    if (!c.ok) {
      skipped.push({ path: at, why: c.why });
      continue;
    }
    let value = c.value;
    const shape = NESTED[`${type}.${field}`];
    if (shape !== undefined) {
      if (Array.isArray(value)) value = nestedList(type, field, shape, value, at, skipped);
      else if (isRec(value)) value = nestedRecord(shape, value, at, skipped);
      if ((Array.isArray(value) && value.length === 0) || (isRec(value) && Object.keys(value).length === 0)) continue;
    }
    put(out, field, value);
  }
  return out;
}

/** One list element checked alone, in Bunraku checkItem's order; a string is why it was rejected. */
function readItem(it: RawItem, at: number, opts: FilingReadOptions, skipped: Skip[]): FilingItem | string {
  const { raw, hint } = it;
  if (!isRec(raw)) return 'not_object: it is not an object';
  const typeKey = typeKeyOf(raw);
  const own = typeKey === undefined ? undefined : raw[typeKey];
  const body = entryField(raw);
  // A type-keyed entry is the entry itself (its own `type` is a field), unless it has an entry object.
  const typeRaw = hint !== undefined && body === undefined ? hint : resolveType(own) !== null ? own : (hint ?? own);
  const type = resolveType(typeRaw);
  if (type === null) return own === undefined && hint === undefined ? 'unknown_type: it has no type' : `unknown_type: its type "${String(typeRaw).slice(0, 40)}" is not one of the eleven`;
  if (type === 'summary' && opts.summaries !== true) return 'summary: filing never writes summaries; the historian does';
  if (!opts.allow.includes(type)) return `not_allowed: filing ${type} entries is switched off`;
  let entry: Rec;
  if (body !== undefined) entry = body;
  else if (hint !== undefined) entry = raw;
  else {
    // A flat item: its fields are the entry's; `type` stays a field when entry_type gave the item's type.
    entry = {};
    for (const [k, v] of Object.entries(raw)) if (!ITEM_KEYS.has(k) || (k === 'type' && typeKey !== 'type')) put(entry, k, v);
  }
  if (Object.keys(entry).length === 0) return 'no_entry: it has no entry object';
  if (tooDeep(entry, 0)) return `too_deep: its entry nests deeper than ${FILING_MAX_DEPTH} levels`;
  const max = FILING_LIMITS[opts.profile].itemChars;
  if (JSON.stringify(entry).length > max) return `too_long: its entry is longer than ${max} characters; file a shorter addition`;
  const path = `filings[${at}].entry`;
  const ownSkips: Skip[] = [];
  const cleaned = clean(entry, path, ownSkips, { kind: 'fields', type });
  const data = coerceEntry(type, cleaned === DROP ? {} : (cleaned as Rec), path, ownSkips);
  // The identity field, else another identity-like field moved into it (a worldbuilding `name`).
  const idf = identityField(type);
  if (!nonBlankStr(data[idf])) {
    const alt = (['name', 'title', 'topic'] as const).find((f) => f !== idf && nonBlankStr(data[f]));
    if (alt === undefined) return `no_identity: it has no ${idf}`;
    put(data, idf, data[alt]);
    delete data[alt];
  }
  const name = (data[idf] as string).trim();
  put(data, idf, name);
  skipped.push(...ownSkips);
  return { at, type, name, data };
}

const nextOpener = (text: string, from: number): number => {
  const i = text.slice(from).search(/[[{]/);
  return i < 0 ? -1 : from + i;
};

/** The first JSON object or array of a text: a fenced body first; else the first `{` or `[` that reads as JSON. */
function findJson(text: string): { value: unknown } | { why: string } {
  if (text.trim() === '') return { why: 'the answer is empty' };
  const fence = /(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)(?:\1|$)/i.exec(text)?.[2];
  const bodies = fence !== undefined && /^\s*[[{]/.test(fence) ? [fence, text] : [text];
  for (const body of bodies) {
    let from = 0;
    for (let at = body.search(/[[{]/); at >= 0; at = nextOpener(body, from)) {
      from = at + 1;
      const head = body.slice(at, at + 200);
      // An object that starts like JSON (structured.ts JSONISH); an array of objects, or an empty one.
      const jsonish = body[at] === '{' ? /^\{\s*(?:["'}]|[A-Za-z_$][\w$-]*["']?\s*:)/.test(head) : /^\[\s*[{\]]/.test(head);
      if (!jsonish) continue;
      const end = balancedEnd(body, at);
      if (end < 0) return { why: 'the answer was cut off before the JSON closed' };
      const parsed = looseJson(body.slice(at, end));
      if (parsed.ok && (isRec(parsed.value) || Array.isArray(parsed.value))) return { value: parsed.value };
      // A span that closes but cannot be read: its inner objects are fragments, look past it.
      from = end;
    }
  }
  return { why: 'the answer is not a JSON object' };
}

/**
 * Reads a filing answer (D-82, D-175): the decoded JSON (structuredCall's `read`) or the answer's text.
 * Envelopes `filings` | `entries` | `items` (a list or one item), a top-level array, one bare item, a
 * type-keyed object; items `{type, entry}`, flat `{type, name, …}` (`book` ignored) or `{"character":
 * {…}}`. Items past the profile's count go to `skipped` (`over_limit`, one line); each other item is
 * checked alone: a rejected one is one `skipped` line, a kept one may add lines for the fields or list
 * elements it lost. `ok: false` only when nothing in the answer is a list of items (the repair's cue);
 * `{}`, `[]` and an envelope holding null, '' or "none" are "nothing to file". A type-keyed object is one
 * whose every key names a type; an item's type is the first of type / entry_type / entryType that names
 * one; keys of free-form maps inside an entry stay as written (ruling I).
 * Skip reasons start with a code: not_object, unknown_type, summary, not_allowed, no_entry, too_deep,
 * too_long, no_identity, over_limit, wrong_kind, bad_enum, memory_rule, no_with, non_finite,
 * duplicate_field.
 */
export function readFilingAnswer(raw: unknown, opts: FilingReadOptions): FilingRead {
  let root = raw;
  if (typeof raw === 'string') {
    const found = findJson(raw);
    if ('why' in found) return { ok: false, why: found.why };
    root = found.value;
  }
  const list = itemsOf(root);
  if (typeof list === 'string') return { ok: false, why: list };
  const cap = FILING_LIMITS[opts.profile].items;
  const items: FilingItem[] = [];
  const skipped: Skip[] = [];
  list.slice(0, cap).forEach((it, at) => {
    const got = readItem(it, at, opts, skipped);
    if (typeof got === 'string') skipped.push({ path: `filings[${at}]`, why: got });
    else items.push(got);
  });
  if (list.length > cap) skipped.push({ path: `filings[${cap}]`, why: `over_limit: only the first ${cap} items are taken (${list.length - cap} more)` });
  return { ok: true, items, skipped };
}

/** readFilingAnswer as structuredCall's `read` (an unreadable answer is `invalid`: the corrective pass runs). */
export function filingReader(opts: FilingReadOptions): (raw: unknown) => ReadResult<FilingItem[]> {
  return (raw) => {
    const r = readFilingAnswer(raw, opts);
    return r.ok ? { ok: true, value: r.items, skipped: r.skipped } : { ok: false, code: 'invalid', message: r.why };
  };
}

// ---- staging (D-175) ------------------------------------------------------------------------------

export interface StageOptions {
  /** LibrarySeed.classic: normalized title → key of a readable book's untyped entry (classic_conflict). */
  classic?: ReadonlyMap<string, string>;
  /** The row's ops JSON cap (OPS_CHARS). */
  opsChars?: number;
}

export interface FilingNotice {
  code: 'filing_classic_conflict';
  /** The name the item used, as written. */
  name: string;
  /** The library entry's key. */
  key: string;
}

/** What one op of the row is expected to do (the fold decides; staging predicts it). */
export interface PlannedOp {
  type: EntryType;
  /** The entry's name after the op. */
  name: string;
  change: 'created' | 'merged';
  /** The key merged into (a `lib:` key: an overlay); null for an entry this row creates. */
  key: string | null;
  /** `at` of the items the op carries. */
  items: number[];
}

export interface StageResult {
  /** Agent `file` ops (no target): the verified deltas. */
  ops: MemOp[];
  /** Parallel to `ops`. */
  planned: PlannedOp[];
  skipped: Skip[];
  notices: FilingNotice[];
  /** `at` of the items that would change nothing (not written, not a problem). */
  unchanged: number[];
}

/** The working copy: the view's entries in handle order (library seed, then session), new ones after. */
interface Sim {
  list: CEntry[];
  at: Map<string, number>;
  made: number;
}

const simOf = (entries: readonly CEntry[]): Sim => ({ list: entries.slice(), at: new Map(entries.map((e, i) => [e.key, i])), made: 0 });

function simPut(sim: Sim, e: CEntry): void {
  const i = sim.at.get(e.key);
  if (i === undefined) {
    sim.at.set(e.key, sim.list.length);
    sim.list.push(e);
  } else sim.list[i] = e;
}

type Step =
  | { kind: 'match'; key: string; next: CEntry | null }
  | { kind: 'new'; next: CEntry }
  | { kind: 'classic'; key: string; name: string }
  | { kind: 'missing'; fields: string[] }
  | { kind: 'invalid'; name: string };

/**
 * One `file` op as the fold applies an agent row's (apply.ts fileEntry, mergeInto, createTyped): a live
 * entry of the type by name or alias (session first, then library) → merge; else a readable book's
 * untyped entry of one of the names → classic_conflict; else a new entry when the required fields are
 * there. `next` is null for a merge that changes nothing.
 */
function step(sim: Sim, type: EntryType, data: Rec, classic: ReadonlyMap<string, string>): Step {
  const idf = identityField(type);
  const identity = isStr(data[idf]) ? data[idf].trim() : '';
  const aliasesIn = strings(data.aliases);
  const wanted = [identity, ...aliasesIn];
  const match = findMatch(sim.list, type, wanted);
  if (match !== null) {
    const m = mergeData(match.data, data, { keep: IDENTITY_KEEP, on: null, appended: match.prov.appended });
    let name = match.name;
    const filled = m.data[idf];
    if (isBlank(match.data[idf]) && isStr(filled) && !isBlank(filled)) name = filled.trim();
    const extra = name !== match.name ? [match.name] : [];
    const aliases = aliasesIn.length === 0 && extra.length === 0 ? match.aliases : aliasList([...match.aliases, ...extra, ...aliasesIn], name);
    if (!m.changed && sameList(aliases, match.aliases) && name === match.name) return { kind: 'match', key: match.key, next: null };
    return { kind: 'match', key: match.key, next: { ...match, name, aliases, data: m.data, prov: { ...match.prov, appended: m.appended } } };
  }
  for (const n of wanted) {
    const key = classic.get(normalizeName(n));
    if (key !== undefined) return { kind: 'classic', key, name: n.trim() };
  }
  const missing = REQUIRED_FIELDS[type].filter((f) => isBlank(data[f]));
  if (missing.length > 0) return { kind: 'missing', fields: missing };
  if (normalizeName(identity) === '') return { kind: 'invalid', name: identity };
  const m = mergeData({}, data, { keep: [], on: null, appended: {} });
  const next: CEntry = {
    key: `new:${++sim.made}`,
    type,
    name: identity,
    aliases: aliasList(aliasesIn, identity),
    tagline: '',
    data: m.data,
    keys: [],
    origin: { kind: 'session' },
    prov: { created: null, lastSeq: 0, appended: m.appended, createdSeq: 0 },
  };
  return { kind: 'new', next };
}

interface Accepted {
  item: FilingItem;
  /** The entity in the working copy: an existing key or `new:<n>`. */
  key: string;
}

/** The ops as one delta per entity (two items about one entity merge), in the order the entities were first named. */
function combine(accepted: readonly Accepted[]): { key: string; type: EntryType; data: Rec; items: number[] }[] {
  const groups = new Map<string, { key: string; type: EntryType; data: Rec; items: number[] }>();
  for (const a of accepted) {
    const g = groups.get(a.key);
    if (g === undefined) groups.set(a.key, { key: a.key, type: a.item.type, data: a.item.data, items: [a.item.at] });
    else {
      g.data = mergeData(g.data, a.item.data, { keep: IDENTITY_KEEP, on: null, appended: {} }).data;
      g.items.push(a.item.at);
    }
  }
  return [...groups.values()];
}

/** Whether the combined ops, replayed from the start, land where the items did and end the same. */
function verify(initial: readonly CEntry[], groups: ReturnType<typeof combine>, final: Sim, classic: ReadonlyMap<string, string>): boolean {
  const sim = simOf(initial);
  const keyOf = new Map<string, string>();
  for (const g of groups) {
    const s = step(sim, g.type, g.data, classic);
    if (g.key.startsWith('new:')) {
      if (s.kind !== 'new') return false;
      keyOf.set(g.key, s.next.key);
      simPut(sim, s.next);
    } else {
      if (s.kind !== 'match' || s.key !== g.key || s.next === null) return false;
      keyOf.set(g.key, g.key);
      simPut(sim, s.next);
    }
  }
  for (const [mine, theirs] of keyOf) {
    const a = final.list[final.at.get(mine)!]!;
    const b = sim.list[sim.at.get(theirs)!]!;
    if (a.name !== b.name || !sameList(a.aliases, b.aliases) || !sameData(a.data, b.data)) return false;
  }
  return true;
}

/**
 * Stages read items against the fold at the group's last answer (D-175; Bunraku stageItems): in order on
 * a working copy — findMatch (session, then library: a library entity becomes an overlay); no match and a
 * readable book's untyped entry of one of the names → `classic_conflict` (+ a notice, once per name);
 * merge (or create); required fields after the merge; a merge that changes nothing is dropped. Then two
 * items about one entity become one delta; when that delta, replayed, would land elsewhere or end
 * differently (rare: a name only the earlier item gave), the row keeps one op per item instead. Ops past
 * `opsChars` of JSON, with everything after them, go to `skipped` (`ops_limit`). An empty result is
 * still a row (`ops: []`). Skip reasons: classic_conflict, missing_required, invalid_name, ops_limit.
 */
export function stageFiling(items: readonly FilingItem[], view: CompendiumView, opts: StageOptions = {}): StageResult {
  const classic = opts.classic ?? new Map<string, string>();
  const cap = opts.opsChars ?? OPS_CHARS;
  const initial = [...view.entries.values()];
  const sim = simOf(initial);
  const skipped: Skip[] = [];
  const notices: FilingNotice[] = [];
  const told = new Set<string>();
  const unchanged: number[] = [];
  const accepted: Accepted[] = [];
  const created = new Set<string>();

  for (const item of items) {
    const path = `filings[${item.at}]`;
    const s = step(sim, item.type, item.data, classic);
    switch (s.kind) {
      case 'classic': {
        skipped.push({ path, why: `classic_conflict: an entry named "${s.name}" exists without a type and is left as written` });
        const n = normalizeName(s.name);
        if (!told.has(n)) {
          told.add(n);
          notices.push({ code: 'filing_classic_conflict', name: s.name, key: s.key });
        }
        break;
      }
      case 'missing':
        skipped.push({ path, why: `missing_required: a new ${item.type} needs ${s.fields.join(', ')}` });
        break;
      case 'invalid':
        skipped.push({ path, why: `invalid_name: "${s.name}" is not a name` });
        break;
      case 'new':
        simPut(sim, s.next);
        created.add(s.next.key);
        accepted.push({ item, key: s.next.key });
        break;
      case 'match': {
        if (s.next === null) {
          unchanged.push(item.at);
          break;
        }
        const missing = parseStructured(item.type, s.next.data).missing;
        if (missing.length > 0) {
          skipped.push({ path, why: `missing_required: "${s.next.name}" would still lack ${missing.join(', ')}` });
          break;
        }
        simPut(sim, s.next);
        accepted.push({ item, key: s.key });
        break;
      }
    }
  }

  const entityOf = (key: string): CEntry => sim.list[sim.at.get(key)!]!;
  const plan = (key: string, type: EntryType, itemsAt: number[], first: boolean): PlannedOp => ({
    type,
    name: entityOf(key).name,
    change: created.has(key) && first ? 'created' : 'merged',
    key: created.has(key) ? null : key,
    items: itemsAt,
  });
  const groups = combine(accepted);
  let staged: { op: MemOp; planned: PlannedOp }[];
  if (verify(initial, groups, sim, classic)) {
    staged = groups.map((g) => ({ op: { op: 'file', type: g.type, data: g.data }, planned: plan(g.key, g.type, g.items, true) }));
  } else {
    const seen = new Set<string>();
    staged = accepted.map((a) => {
      const first = !seen.has(a.key);
      seen.add(a.key);
      return { op: { op: 'file', type: a.item.type, data: a.item.data }, planned: plan(a.key, a.item.type, [a.item.at], first) };
    });
  }

  const ops: MemOp[] = [];
  const planned: PlannedOp[] = [];
  let used = 2;
  let full = false;
  for (const s of staged) {
    const size = JSON.stringify(s.op).length + (ops.length > 0 ? 1 : 0);
    if (!full && used + size <= cap) {
      used += size;
      ops.push(s.op);
      planned.push(s.planned);
      continue;
    }
    full = true;
    for (const at of s.planned.items) skipped.push({ path: `filings[${at}]`, why: `ops_limit: this row already holds ${cap} characters of changes; file it again` });
  }
  return { ops, planned, skipped, notices, unchanged };
}
