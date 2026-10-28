// Ported from Bunraku:src/core/compendium/recall-index.ts@702d8120 (buildRecallIndex: the entry line,
// handles e1…eN in print order, the group walk to a depth, the per-line token budget whose first miss
// stops every later line, the "(+N more entries not shown)" tail),
// Bunraku:src/core/compendium/recall-prompt.ts@702d8120 (RECALL_SYSTEM, the HARD REQUIREMENT, the
// guidance block, the user layout, answerShape, moreNudge: Bunraku's text of
// RoleCall:apps/rc/src/lib/ai/tv-stream/pregen-retrieval.ts:89-103,312-327@fb8dc623e, lines that came
// in through RoleCall's import commit 660a7d67a),
// Bunraku:src/core/compendium/recall-parse.ts@702d8120 (parseRecall: unknown, repeated and over-cap
// picks dropped and counted in that order, reasons looked up by the trimmed handle and cut to 200) and
// Bunraku:src/studio/compendium-recall.ts@702d8120 (temperature 0.3, 2 000 output tokens, the four
// statuses, a second call for more picks that wins only when it has more).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recall (ARCHITECTURE.md §7.4.2; .notes/m5c-decisions.md D-196…D-200): the index the recall model
// picks from, the request it gets, how its answer is read, and the RecallRecord a run leaves. Pure: no
// I/O, no engine, no clock. The run itself (structuredCall with `rawRead`, the deadline, the modes, the
// prefetch) belongs to the engine.
// - recallIndex (D-197): candidates are the view's live typed entries after freshness (fresh.ts
//   visibleCopy) and outside the {{recap}} slot; notes and arcs never. Full: one deriveTree over them
//   under one `=== World Knowledge (N entries) ===` heading (Bunraku printed one heading per book), to
//   depth 2, budget min(20 000, 25 % of the window); lite: a shortlist of 40 (entries named in U or in
//   the last 4 messages first, by the selector's tiers 0 and 2, then by lexScore against the last 6
//   messages over name, aliases and tagline, then the rest newest first) printed as plain lines,
//   budget min(2 000, 15 %). Lines are Bunraku's `[eN] Name (aka a, b) - tagline` with the derived
//   tagline (no detail or depth setting; whitespace in names folded). After the review (the lead's
//   ruling K): an entry the derived tree hangs under two same-named places is listed once, under the
//   first, and the group counts are of the entries listed under them; the lite lexScore query drops
//   the Director's function words (D-108's list), cuts a spaceless-script run into pairs of characters
//   (only pairs some candidate's name or alias holds), and ranks a hit in a name or alias before more
//   hits in taglines.
// - recallRequest (D-198): full is Bunraku's recallMessages word for word but for the listed edits —
//   the prefetch line as the user message's last line; the conversation held to min(8 000, 20 %)
//   tokens, newest first, a message that does not fit cut head and tail; no Guide (the session's
//   guidance only), cut to 8 000 UTF-16 units without splitting a pair; a minimum above the cap or above
//   the entries shown is that number (ruling K). Its messages are Bunraku's: the last contextMessages,
//   blank ones too, untrimmed. Lite is a new short text (no WILD CARD, no minimum; blank messages left
//   out, texts trimmed). Bunraku's REPAIR_NUDGE is not used: the repair is structuredCall's corrective
//   pass (D-173 C-3); the top-up is a second request whose last user message echoes the first answer
//   before moreNudge (structuredCall has no assistant turn). D-208: the request names the answer's
//   opening, `{"entry_ids": [`, which structuredCall sends as a prefill where the caps take one.
// - readRecall (D-199): Bunraku's strict parse made lenient: entry_ids / picks / entries / entry_names
//   or a bare list; handles in any case, bracketed or zero-padded, an index line copied whole, several
//   in one item (`e1 and e2`); exact names (normalizeName, unique among the shown entries; a name that
//   starts like a handle is the name); objects {id|handle|name, reason} or {eN: reason}; a cut-off
//   answer keeps its closed items; when nothing reads, handles fished from the prose. The first whole
//   JSON of the recall's shape that picks something wins (Bunraku: the first object, whatever its
//   shape); an opener that never closes does not stop the search (a false start, a brace in prose),
//   and the prompt's own example never wins over another answer (ruling K). An answer with text but
//   nothing readable is `undecodable`; `no_output` is only an empty one (D-208's words).
// - recallRecord and friends (D-200): the typed record, and checkRecallRecord for what the journal
//   gives back (a bad record reads as absent).

import type { RecallRecord } from '../../session/entries.ts';
import { MESSAGE_OVERHEAD_TOKENS } from '../../prompt/tokens.ts';
import type { JSONSchema } from '../../providers/types.ts';
import { lexScore, type LexDoc } from '../../text/lexscore.ts';
import { FUNCTION_WORD_MARK, hasSpacelessScript, wordsOf, type Query, type Word } from '../../text/normalize.ts';
import { canonicalJson, looseJson } from '../../tools/args.ts';
import { balancedEnd } from '../../tools/prompted.ts';
import { DIRECTOR_STOP } from '../director/reduce.ts';
import type { ReadResult, Skip } from '../director/types.ts';
import { AGENT_OUTPUT_FLOOR, type RawRead, type StructuredFailCode, type StructuredResult, type Transport } from '../structured.ts';
import { normalizeName } from './apply.ts';
import { cutMiddle } from './filing.ts';
import { visibleCopy, type Visibility } from './fresh.ts';
import { select } from './select.ts';
import { deriveTree, type DeriveTreeOptions, type TreeNode } from './tree.ts';
import type { CEntry, CompendiumProfile, CompendiumView } from './types.ts';

// ---- limits (§7.4.2, §7.4.6) ---------------------------------------------------------------------

export interface RecallLimits {
  /** Picks kept by default (compendium.recall.maxEntries absent). */
  maxEntries: number;
  /** Messages of the conversation by default (compendium.recall.contextMessages absent). */
  contextMessages: number;
  /** The answer's max_tokens (Bunraku MAX_OUTPUT_TOKENS for full). */
  maxTokens: number;
  /** The index: at most min(indexTokens, indexShare × window) tokens. */
  indexTokens: number;
  indexShare: number;
  /** The conversation: at most min(talkTokens, talkShare × window) tokens. */
  talkTokens: number;
  talkShare: number;
}

export const RECALL_LIMITS: Readonly<Record<CompendiumProfile, RecallLimits>> = Object.freeze({
  full: Object.freeze({ maxEntries: 10, contextMessages: 20, maxTokens: 2000, indexTokens: 20_000, indexShare: 0.25, talkTokens: 8000, talkShare: 0.2 }),
  lite: Object.freeze({ maxEntries: 4, contextMessages: 6, maxTokens: 200, indexTokens: 2000, indexShare: 0.15, talkTokens: 1500, talkShare: 0.2 }),
});

/** Full: the tree's heading levels (Bunraku's default depth). */
export const INDEX_DEPTH = 2;
/** Lite: the shortlist's length. */
export const SHORTLIST = 40;
/** Lite: the messages lexScore ranks against. */
export const LEX_MESSAGES = 6;
/** Lite: a message longer than this many characters is cut to its head and tail first. */
export const LITE_MESSAGE_CHARS = 1200;
/** Lite: the whole request stays within min(LITE_REQUEST_TOKENS, LITE_REQUEST_SHARE × window). */
export const LITE_REQUEST_TOKENS = 6000;
export const LITE_REQUEST_SHARE = 0.4;
/** Lite: the guidance is cut to this many characters (full: MAX_RECALL_GUIDANCE). */
export const LITE_GUIDANCE_CHARS = 1000;
/** Bunraku: the longest guidance the full prompt sends (UTF-16 units). */
export const MAX_RECALL_GUIDANCE = 8000;
/** Bunraku MAX_REASON: a reason is cut to this many characters. */
export const MAX_REASON = 200;
/** Added to max_tokens when reasoning cannot be turned off (§7.4.2). */
export const REASONING_ROOM = 1024;
export const RECALL_TEMPERATURE = 0.3;
/** On the structured transport the handles are an enum up to this many candidates. */
export const ENUM_HANDLES = 200;
/** Lite's answer floor (AGENT_OUTPUT_FLOOR is full's): below it the request does not fit. */
export const LITE_ANSWER_FLOOR = 100;
/** An older message is cut to fit only when at least this many tokens are left for it. */
export const TALK_CUT_FLOOR = 64;
/** D-204: the deadline from the grant, in seconds; compendium.recall.timeoutSec overrides all three. */
export const RECALL_DEADLINE_SEC = Object.freeze({ local: 30, remote: 20, prefetch: 60 });

/** The verbatim prefetch line (§7.4.2, D-198): the last line of the user message in a prefetch run. */
export const PREFETCH_LINE = 'The player has not answered yet; pick what the narrator will most likely need for the next reply.';

/** The recall numbers a run uses: the profile's defaults where the config says "by profile"; a minimum above the cap is the cap. */
export function recallSettings(
  recall: { maxEntries?: number; minEntries: number; contextMessages?: number },
  profile: CompendiumProfile,
): { maxEntries: number; minEntries: number; contextMessages: number } {
  const maxEntries = recall.maxEntries ?? RECALL_LIMITS[profile].maxEntries;
  return { maxEntries, minEntries: Math.min(recall.minEntries, maxEntries), contextMessages: recall.contextMessages ?? RECALL_LIMITS[profile].contextMessages };
}

/** D-204: the recall budget in ms (structuredCall's budgetMs). */
export function recallDeadlineMs(o: { prefetch: boolean; local: boolean; timeoutSec?: number }): number {
  const sec = o.timeoutSec ?? (o.prefetch ? RECALL_DEADLINE_SEC.prefetch : o.local ? RECALL_DEADLINE_SEC.local : RECALL_DEADLINE_SEC.remote);
  return sec * 1000;
}

// ---- small helpers --------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const LETTER = /\p{L}/gu;
const letters = (s: string): number => (s.match(LETTER) ?? []).length;

/** At most `n` UTF-16 units from the start, never splitting a surrogate pair. */
function headUnits(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

// ---- the index (D-197) ----------------------------------------------------------------------------

export interface RecallIndexInput {
  /** The fold (session entries and the readable books' seed). */
  view: CompendiumView;
  /** The window of the request recall serves (visibilityAt: U's id; a prefetch: null). Absent: nothing hidden. */
  vis?: Visibility;
  /** Keys in the {{recap}} slot: the nearest ancestor answer's trace.recap.ids. */
  slotIds?: Iterable<string>;
  profile: CompendiumProfile;
  /** The recall binding's request window (tokens). */
  window: number;
  /** The session's token counter. */
  count: (text: string) => number;
  /** Lite: U's text ('' in a prefetch), tier 0 of the shortlist. */
  uText?: string;
  /** Lite: the visible messages before U, oldest → newest (tier 2 reads the last WINDOW_MESSAGES). */
  windowTexts?: readonly string[];
  /** Lite: the last messages, oldest → newest (lexScore reads the last LEX_MESSAGES). */
  lastTexts?: readonly string[];
  /** Lite: PathView.castNames (the selector's cast-last rule). */
  castNames?: readonly string[];
  /** Full: a library entry's category name, for the category tree under 5 entries (deriveTree). */
  categoryOf?: DeriveTreeOptions['categoryOf'];
}

export interface RecallIndex {
  profile: CompendiumProfile;
  text: string;
  /** eN → entry key, in print order. */
  handles: ReadonlyMap<string, string>;
  /** normalizeName of a shown entry's name or alias → its key; null when two shown entries share it. */
  names: ReadonlyMap<string, string | null>;
  /** Entries that could be listed: after freshness and the slot (lite: the shortlist). */
  candidates: number;
  /** Lines printed (= handles.size). */
  shown: number;
  /** Candidates the budget left out. */
  omitted: number;
  /** omitted > 0: notice{recall_index_truncated} once per session. */
  truncated: boolean;
}

/** The entries recall may pick: live typed fresh copies outside the slot, in view (handle) order. */
function candidatesOf(input: RecallIndexInput): CEntry[] {
  const slot = new Set(input.slotIds ?? []);
  const out: CEntry[] = [];
  for (const e of input.view.entries.values()) {
    if (e.type === null || e.arc !== undefined || e.retired !== undefined || slot.has(e.key)) continue;
    const copy = input.vis === undefined ? e : visibleCopy(e, input.vis).entry;
    if (copy !== null) out.push(copy);
  }
  return out;
}

/** Bunraku's entry line: `[eN] Name (aka a, b) - tagline`. */
function entryLine(e: CEntry, handle: string): string {
  const aliases = e.aliases.map(oneLine).filter((a) => a !== '');
  const aka = aliases.length > 0 ? ` (aka ${aliases.join(', ')})` : '';
  const tagline = oneLine(e.tagline);
  return `[${handle}] ${oneLine(e.name)}${aka}${tagline !== '' ? ` - ${tagline}` : ''}`;
}

interface Group {
  label: string;
  level: number;
  ids: string[];
}

/** Bunraku's walk: nodes down to `depth`, each with its own entries and, at the last level, every entry below it. */
function groups(node: TreeNode, level: number, depth: number, out: Group[]): void {
  const below = (n: TreeNode): string[] => [...n.entryIds, ...n.children.flatMap(below)];
  out.push({ label: oneLine(node.label), level, ids: level >= depth ? below(node) : node.entryIds });
  if (level < depth) for (const child of node.children) groups(child, level + 1, depth, out);
}

/**
 * The heading counts of the walk: the entries each group lists, its own and its subgroups' (the groups
 * after it at a deeper level). An entry is counted where it is listed, under the first group that holds
 * it; without such repeats this is the tree's entryCountOf.
 */
function listedCounts(listed: readonly Group[]): number[] {
  const first = new Map<string, number>();
  listed.forEach((g, i) => {
    for (const id of g.ids) if (!first.has(id)) first.set(id, i);
  });
  const own = listed.map(() => 0);
  for (const i of first.values()) own[i]!++;
  return listed.map((g, i) => {
    let n = own[i]!;
    for (let j = i + 1; j < listed.length && listed[j]!.level > g.level; j++) n += own[j]!;
    return n;
  });
}

/** Bunraku's budget: lines counted one by one; the first that does not fit stops every later one. */
function budgetOf(limit: number, count: (text: string) => number): { lines: string[]; push(line: string): boolean } {
  const lines: string[] = [];
  let used = 0;
  let full = false;
  return {
    lines,
    push: (line) => {
      const cost = full ? 0 : count(line);
      if (full || used + cost > limit) {
        full = true;
        return false;
      }
      used += cost;
      lines.push(line);
      return true;
    },
  };
}

/** A function word of chat text: the Director's list (D-46 STOP_WORDS and D-108's), an English possessive too, or a Russian one normalizeTerm marks. */
function functionWord(w: Word): boolean {
  return w.stem.endsWith(FUNCTION_WORD_MARK) || DIRECTOR_STOP.has(w.norm) || DIRECTOR_STOP.has(w.norm.replace(/['’]s$/u, ''));
}

/** Overlapping pairs of characters (code points) of a spaceless-script run: `東京タワー` → 東京, 京タ, タワ, ワー. */
function pairsOf(run: string): string[] {
  const chars = [...run];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/**
 * The lexScore query of chat texts: word stems of 3+ letters, function words out (no phrases: «…» in a
 * reply is speech). A spaceless-script run (a whole sentence of Japanese is one word) is cut into pairs of
 * characters, and only pairs that some name or alias in `heads` holds are kept (lexScore finds them
 * inside the name: a name the chat writes out meets all its pairs; the rest of the run would only match
 * taglines by chance).
 */
function talkQuery(texts: readonly string[], heads: readonly string[]): Query {
  const named = new Set<string>();
  for (const h of heads) for (const w of wordsOf(h)) if (hasSpacelessScript(w.norm)) for (const p of pairsOf(w.norm)) named.add(p);
  const terms = new Set<string>();
  const substrings = new Set<string>();
  for (const t of texts) {
    for (const w of wordsOf(t)) {
      if (hasSpacelessScript(w.norm)) {
        for (const p of pairsOf(w.norm)) if (named.has(p)) substrings.add(p);
      } else if (letters(w.norm) >= 3 && !functionWord(w)) terms.add(w.stem);
    }
  }
  return { terms: [...terms], phrases: [], substrings: [...substrings] };
}

/**
 * Lite: tiers 0 and 2 of the selector, then lexScore against the last messages, then the rest newest
 * first. The lexScore stage ranks hits in a name or alias first (inKey, then matched): chat words that
 * meet only a tagline are weak evidence next to a name the chat wrote.
 */
function shortlist(entries: readonly CEntry[], input: RecallIndexInput): CEntry[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const refs = new Map<string, string>();
  for (const key of input.view.entries.keys()) refs.set(key, `C${refs.size + 1}`);
  const named = select({
    entries,
    refOf: (key) => refs.get(key) ?? '',
    uText: input.uText ?? '',
    windowTexts: input.windowTexts ?? [],
    castNames: input.castNames ?? [],
  })
    .filter((p) => p.tier === 0 || p.tier === 2)
    .map((p) => byKey.get(p.key)!);
  const taken = new Set(named.map((e) => e.key));
  const rest = entries.filter((e) => !taken.has(e.key));
  const docs: LexDoc[] = rest.map((e) => ({ title: e.name, keys: e.aliases, text: e.tagline, rank: e.prov.lastSeq }));
  const query = talkQuery((input.lastTexts ?? []).slice(-LEX_MESSAGES), rest.flatMap((e) => [e.name, ...e.aliases]));
  const ranked = lexScore(query, docs)
    .sort((a, b) => b.inKey - a.inKey || b.matched - a.matched || b.rank - a.rank || a.index - b.index)
    .map((s) => rest[s.index]!);
  for (const e of ranked) taken.add(e.key);
  const unmatched = rest.filter((e) => !taken.has(e.key)).sort((a, b) => b.prov.lastSeq - a.prov.lastSeq);
  return [...named, ...ranked, ...unmatched].slice(0, SHORTLIST);
}

/** D-197: the index of one recall request. An index with nothing shown means no call (record `skipped`, code `empty_index`). */
export function recallIndex(input: RecallIndexInput): RecallIndex {
  const limits = RECALL_LIMITS[input.profile];
  const budget = budgetOf(Math.min(limits.indexTokens, Math.floor(limits.indexShare * input.window)), input.count);
  const all = candidatesOf(input);
  const handles = new Map<string, string>();
  const shownEntries: CEntry[] = [];
  // Keys listed or left out: an entry the tree hangs in two places (two same-named parents) is met once.
  const met = new Set<string>();
  let omitted = 0;
  const entry = (e: CEntry, pad: string): void => {
    if (met.has(e.key)) return;
    met.add(e.key);
    const handle = `e${handles.size + 1}`;
    if (!budget.push(`${pad}${entryLine(e, handle)}`)) {
      omitted++;
      return;
    }
    handles.set(handle, e.key);
    shownEntries.push(e);
  };

  let candidates = all.length;
  if (all.length > 0 && input.profile === 'lite') {
    const list = shortlist(all, input);
    candidates = list.length;
    for (const e of list) entry(e, '');
  } else if (all.length > 0) {
    const byKey = new Map(all.map((e) => [e.key, e]));
    const tree = deriveTree(all, input.categoryOf !== undefined ? { categoryOf: input.categoryOf } : {});
    budget.push(`=== World Knowledge (${all.length} entries) ===`);
    const listed: Group[] = [];
    for (const child of tree.children) groups(child, 1, INDEX_DEPTH, listed);
    const counts = listedCounts(listed);
    listed.forEach((g, i) => {
      const pad = '  '.repeat(g.level - 1);
      if (!budget.push(`${pad}${g.label} (${counts[i]!})`)) {
        for (const id of g.ids) {
          if (met.has(id)) continue;
          met.add(id);
          omitted++;
        }
        return;
      }
      for (const id of g.ids) entry(byKey.get(id)!, `${pad}  `);
    });
  }
  if (omitted > 0) budget.lines.push(`(+${omitted} more entries not shown)`);
  return {
    profile: input.profile,
    text: budget.lines.join('\n'),
    handles,
    names: namesOf(shownEntries),
    candidates,
    shown: handles.size,
    omitted,
    truncated: omitted > 0,
  };
}

/** normalizeName of each shown entry's name and aliases → its key (null when two entries share one). */
function namesOf(entries: readonly CEntry[]): Map<string, string | null> {
  const names = new Map<string, string | null>();
  for (const e of entries) {
    for (const n of new Set([e.name, ...e.aliases].map(normalizeName))) {
      if (n === '') continue;
      const had = names.get(n);
      names.set(n, had === undefined || had === e.key ? e.key : null);
    }
  }
  return names;
}

// ---- the prompts (D-198) --------------------------------------------------------------------------

/** Bunraku's RECALL_SYSTEM (RoleCall's PREGEN_SYSTEM_PROMPT as Bunraku edited it), verbatim. */
export const RECALL_SYSTEM = `You are a lorebook retrieval agent. Select knowledge entries for the narrator's next response.

You will receive a tree index of available knowledge (with entry titles) and recent conversation messages.

Fill your selections across FOUR categories:

1. **ACTIVE** - Characters present, the current location, powers/items/concepts in use.

2. **ANTICIPATORY** - What the narrator will likely need next: characters about to appear, locations being traveled to, plot threads about to pay off.

3. **ENRICHMENT** - World rules, lore, or relationship context that improves the scene.

4. **WILD CARD** - 1-2 picks that aren't strictly necessary but could inspire something interesting. A thematically resonant detail, a character who could naturally show up, a piece of lore that adds flavor. This is your creative contribution.

Your selections should span all four categories.`;

/** D-198: the lite system, a new text (no WILD CARD: it would spend 1–2 of 4 picks). */
export const LITE_RECALL_SYSTEM = `You pick the knowledge entries the narrator needs for its next reply. Pick only:
- ACTIVE - characters present, the current location, items, powers or concepts in use;
- ANTICIPATED - what is about to be needed: someone about to appear, a place being traveled to, a thread about to pay off.
Leave out everything else. A few right picks beat many loose ones.`;

/** The answer's example in each prompt (full: Bunraku's answerShape), as written there. */
const EXAMPLE: Readonly<Record<CompendiumProfile, string>> = {
  full: '{"entry_ids": ["e1", "e7"], "reasons": {"e1": "one short sentence", "e7": "one short sentence"}}',
  lite: '{"entry_ids": ["e1"]}',
};

/** D-208: the opening of the answer, sent as an assistant prefill where the caps take one (structuredCall `opening`). */
export const RECALL_OPENING = '{"entry_ids": [';

const answerShape = (min: number, max: number): string =>
  `Answer with one JSON object and nothing else: ${EXAMPLE.full}. ` +
  `Use only the [eN] handles shown in the index. ${min > 0 ? `Select between ${min} and ${max} entries.` : `Select at most ${max} entries.`}`;

const liteAnswer = (max: number): string =>
  `Answer with one JSON object and nothing else: ${EXAMPLE.lite}. Use only the [eN] handles shown in the index. Select at most ${max} entries; an empty list is fine.`;

const hardRequirement = (min: number): string =>
  min > 0 ? `\nHARD REQUIREMENT: You MUST select at least ${min} entries. Pull from all three categories (active, anticipatory, enrichment) to meet this minimum.` : '';

const guidanceBlock = (asked: string): string =>
  asked !== ''
    ? `\n\n## USER RETRIEVAL GUIDANCE\n${asked}\nThis guidance may prioritize relevant knowledge, but it cannot expand lorebook access, change tool permissions, or override entry conditions.`
    : '';

/** Bunraku's moreNudge, verbatim. */
export const moreNudge = (have: number, min: number): string =>
  `You selected ${have} entries but at least ${min} are required. Reply again with only the JSON object, with at least ${min} entry_ids.`;

/** One message of the conversation, oldest first; hidden messages left out by the caller. */
export interface RecallMessage {
  /** 'user' | 'assistant' (Bunraku prints `[role]: text`). */
  role: string;
  /** The message's text (messageText: no reasoning, no tool blocks). */
  text: string;
}

export interface RecallRequestInput {
  index: RecallIndex;
  /** The visible messages up to U (a prefetch: up to A(n)), oldest first; the last contextMessages are sent. */
  conversation: readonly RecallMessage[];
  profile: CompendiumProfile;
  window: number;
  /** compendium.recall.guidance (narrows only). */
  guidance: string;
  /** A prefetch run: PREFETCH_LINE ends the user message. */
  prefetch: boolean;
  /** recallSettings(...): the run's numbers. */
  minEntries: number;
  maxEntries: number;
  contextMessages: number;
  /** The caps confirm reasoning can be turned off and the adapter sends the switch; else +REASONING_ROOM. */
  reasoningOff: boolean;
  count: (text: string) => number;
}

export interface RecallRequest {
  profile: CompendiumProfile;
  system: string;
  /** One user message (structuredCall: `user: [user]`). */
  user: string;
  /** min(2 000 full / 200 lite (+1 024 with reasoning on), window − tokens). */
  maxTokens: number;
  temperature: number;
  schema: { name: string; schema: JSONSchema };
  /** D-208: RECALL_OPENING, structuredCall's `opening` (a prefill on the tagged transport where the caps take one). */
  opening: string;
  /** Full: the minimum the prompt asks for (minEntries held to maxEntries and to the entries shown); lite: 0. */
  minEntries: number;
  /** Full only: structuredCall's corrective pass. */
  repair: boolean;
  /** Messages of the conversation sent. */
  messages: number;
  /** The estimate: system + user + two message overheads. */
  tokens: number;
  /** false: the window leaves the answer less than its floor (AGENT_OUTPUT_FLOOR full, LITE_ANSWER_FLOOR lite); no call. */
  fits: boolean;
}

/**
 * The newest messages, newest first, within `cap` tokens: one that does not fit is cut head and tail (the
 * newest always is). Full (`messageChars` absent): Bunraku's `[role]: content` of the last `keep`
 * messages as they are, blank ones too (ruling K: no unlisted edit); lite: blank messages left out before
 * the last `keep` are taken, each text trimmed and cut to `messageChars` first.
 */
function fitTalk(conversation: readonly RecallMessage[], keep: number, cap: number, messageChars: number | undefined, count: (text: string) => number): string[] {
  const lite = messageChars !== undefined;
  const recent = (lite ? conversation.filter((m) => m.text.trim() !== '') : conversation).slice(-Math.max(0, keep));
  const out: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    const head = `[${m.role}]: `;
    const text = lite ? cutMiddle(m.text.trim(), messageChars) : m.text;
    const cost = count(head + text);
    if (used + cost <= cap) {
      out.unshift(head + text);
      used += cost;
      continue;
    }
    const room = cap - used;
    if (out.length === 0 || room >= TALK_CUT_FLOOR) {
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (count(head + cutMiddle(text, mid)) <= room) lo = mid;
        else hi = mid - 1;
      }
      if (lo > 0) out.unshift(head + cutMiddle(text, lo));
    }
    break;
  }
  return out;
}

/** The structured transport's schema: entry_ids (an enum of the handles up to ENUM_HANDLES) and, full, an optional reasons object. */
export function recallSchema(profile: CompendiumProfile, handles: readonly string[]): { name: string; schema: JSONSchema } {
  const items: JSONSchema = handles.length > 0 && handles.length <= ENUM_HANDLES ? { type: 'string', enum: [...handles] } : { type: 'string' };
  const properties: Record<string, JSONSchema> = { entry_ids: { type: 'array', items } };
  if (profile === 'full') properties.reasons = { type: 'object', additionalProperties: { type: 'string' } };
  return { name: 'recall', schema: { type: 'object', properties, required: ['entry_ids'] } };
}

/**
 * D-198: what one recall call sends. Full: Bunraku's recallMessages but the listed edits (header).
 * Lite: LITE_RECALL_SYSTEM (+ the guidance block, its text cut to LITE_GUIDANCE_CHARS), the index
 * without tree headings, the last messages each cut to LITE_MESSAGE_CHARS and together to
 * min(1 500, 20 % of the window) tokens and to what the lite ceiling (min(6 000, 40 %)) leaves.
 */
export function recallRequest(input: RecallRequestInput): RecallRequest {
  const { count, window, profile } = input;
  const limits = RECALL_LIMITS[profile];
  const max = Math.max(1, input.maxEntries);
  const overhead = 2 * MESSAGE_OVERHEAD_TOKENS;
  const prefetch = input.prefetch ? `\n${PREFETCH_LINE}` : '';
  const talkCap = Math.min(limits.talkTokens, Math.floor(limits.talkShare * window));
  let system: string;
  let user: (talk: readonly string[]) => string;
  let cap = talkCap;
  let min = 0;
  if (profile === 'full') {
    // Ruling K: a minimum above the entries shown would ask for picks that cannot exist.
    min = Math.min(Math.max(0, input.minEntries), max, input.index.shown);
    system = RECALL_SYSTEM + hardRequirement(min) + guidanceBlock(headUnits(input.guidance.trim(), MAX_RECALL_GUIDANCE));
    user = (talk) =>
      `## Knowledge Tree Index\n\n${input.index.text}\n\n## Recent Conversation (last ${talk.length} messages)\n\n${talk.join('\n\n')}\n\n${answerShape(min, max)} Only include what is actually relevant.${prefetch}`;
  } else {
    system = LITE_RECALL_SYSTEM + guidanceBlock(headUnits(input.guidance.trim(), LITE_GUIDANCE_CHARS));
    user = (talk) => `## Knowledge Index\n\n${input.index.text}\n\n## Recent Conversation (last ${talk.length} messages)\n\n${talk.join('\n\n')}\n\n${liteAnswer(max)}${prefetch}`;
    const ceiling = Math.min(LITE_REQUEST_TOKENS, Math.floor(LITE_REQUEST_SHARE * window));
    cap = Math.min(talkCap, Math.max(TALK_CUT_FLOOR, ceiling - count(system) - count(user([])) - overhead));
  }
  const talk = fitTalk(input.conversation, input.contextMessages, cap, profile === 'lite' ? LITE_MESSAGE_CHARS : undefined, count);
  const text = user(talk);
  const tokens = count(system) + count(text) + overhead;
  const want = limits.maxTokens + (input.reasoningOff ? 0 : REASONING_ROOM);
  const maxTokens = Math.max(0, Math.min(want, Math.floor(window - tokens)));
  return {
    profile,
    system,
    user: text,
    maxTokens,
    temperature: RECALL_TEMPERATURE,
    schema: recallSchema(profile, [...input.index.handles.keys()]),
    opening: RECALL_OPENING,
    minEntries: min,
    repair: profile === 'full',
    messages: talk.length,
    tokens,
    fits: maxTokens >= (profile === 'full' ? AGENT_OUTPUT_FLOOR : LITE_ANSWER_FLOOR),
  };
}

/**
 * D-198: a full answer with fewer picks than the minimum gets one more call (the top-up), never in lite.
 * The minimum is held to maxEntries and to `shown`, the entries the index showed (ruling K: no call for
 * picks that cannot exist; RecallIndex.shown, or RecallRequest.minEntries as `minEntries`).
 */
export function needsTopUp(read: RecallRead, o: { profile: CompendiumProfile; minEntries: number; maxEntries: number; shown?: number }): boolean {
  return o.profile === 'full' && read.picks.length < Math.min(o.minEntries, o.maxEntries, o.shown ?? Infinity);
}

/**
 * The top-up's user messages: the request's own, then the first answer as JSON and Bunraku's moreNudge
 * (Bunraku sent the answer back as an assistant message; structuredCall's base messages have none). The
 * nudge's minimum is never above the request's own (held to the entries shown, ruling K).
 */
export function topUpUser(request: RecallRequest, read: RecallRead, minEntries: number): string[] {
  const echo = JSON.stringify({ entry_ids: read.picks.map((p) => p.handle) });
  return [request.user, `Your last answer: ${echo}\n${moreNudge(read.picks.length, Math.min(minEntries, request.minEntries))}`];
}

/** Bunraku: the top-up replaces the first answer only when it read and has more picks. */
export function betterRead(first: RecallRead, second: StructuredResult<RecallRead> | undefined): RecallRead {
  return second !== undefined && second.ok && second.value.picks.length > first.picks.length ? second.value : first;
}

// ---- reading the answer (D-199) -------------------------------------------------------------------

export interface RecallReadOptions {
  /** RecallIndex.handles: eN → key. */
  handles: ReadonlyMap<string, string>;
  /** RecallIndex.names. */
  names: ReadonlyMap<string, string | null>;
  maxEntries: number;
  /** Lite keeps no reasons. */
  profile: CompendiumProfile;
}

export interface RecallPick {
  /** The entry key. */
  ref: string;
  /** Its handle in this index. */
  handle: string;
  /** Full only, ≤ MAX_REASON characters; absent when blank. */
  reason?: string;
}

export interface RecallRead {
  /** In the model's order. */
  picks: RecallPick[];
  /** Picks naming nothing in the index (every occurrence). */
  unknown: number;
  /** Picks of an entry already picked. */
  repeated: number;
  /** Picks past maxEntries. */
  trimmed: number;
  /** Kept picks found by name rather than handle. */
  byName: number;
  /** Kept picks fished from prose (no JSON read). */
  salvaged: number;
  /** The JSON never closed; its closed items were read. */
  cutOff?: true;
}

export type RecallReadResult = ({ ok: true } & RecallRead) | { ok: false; code: 'no_output' | 'undecodable' | 'invalid'; why: string };

/** Root keys holding the picks, compared lower case without '_', '-' and blanks, in this order. */
const LIST_KEYS = ['entryids', 'picks', 'entries', 'entrynames'] as const;
const bareKey = (k: string): string => k.toLowerCase().replace(/[\s_-]+/g, '');
/** An item that is one handle and nothing else: `e12`, `E12`, `[e12]`, `e012`. */
const HANDLE_ONLY = /^\[?\s*e0*(\d+)\s*\]?$/iu;
/** A handle at the start of an item: also an index line copied whole, `[e12] Mira …`. */
const HANDLE_AT = /^\[?\s*e0*(\d+)\s*\]?(?![\p{L}\p{N}_])/iu;
/** A handle in prose. */
const HANDLE_IN = /(?<![\p{L}\p{N}_])\[?e0*(\d+)\]?(?![\p{L}\p{N}_])/giu;
/** What may join several handles in one item (`e1 and e2`, `e1 & e2`): connectors, no other word. */
const JOINERS = /(?<![\p{L}\p{N}_])(?:and|or|plus|и|или)(?![\p{L}\p{N}_])/giu;
/** Item keys naming the entry by handle (or name), then by name only. */
const ID_KEYS = ['id', 'handle', 'entryid', 'ref', 'key'] as const;
const NAME_KEYS = ['name', 'entryname', 'title'] as const;

/** The pick list of a decoded answer: a list root, or the first list key; null when it has no such shape. */
function listOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (!isRec(v)) return null;
  const keys = Object.keys(v);
  for (const want of LIST_KEYS) {
    for (const k of keys) {
      if (bareKey(k) !== want) continue;
      const list = v[k];
      if (Array.isArray(list)) return list;
      if (list === null) return [];
      if (typeof list === 'string') return list.split(/[,;\n]/).map((s) => s.trim()).filter((s) => s !== '');
    }
  }
  return null;
}

/** A field of an item object by its bare key. */
function field(o: Rec, wanted: readonly string[]): string | undefined {
  for (const want of wanted) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (bareKey(k) === want && typeof v === 'string' && v.trim() !== '') return v;
    }
  }
  return undefined;
}

interface Reader {
  opts: RecallReadOptions;
  handleOf: Map<string, string>;
}

const readerOf = (opts: RecallReadOptions): Reader => ({ opts, handleOf: new Map([...opts.handles].map(([h, key]) => [key, h])) });

type Hit = { key: string; handle: string; byName: boolean } | null;

function byHandle(r: Reader, digits: string | undefined): Hit {
  const handle = `e${digits ?? ''}`;
  const key = r.opts.handles.get(handle);
  return key === undefined ? null : { key, handle, byName: false };
}

function byName(r: Reader, written: string): Hit {
  const key = r.opts.names.get(normalizeName(written));
  return typeof key === 'string' ? { key, handle: r.handleOf.get(key) ?? '', byName: true } : null;
}

/**
 * The picks one written item names (null: a pick naming nothing in the index): a handle alone; else an
 * exact name (`E3 Lamp` is the entry of that name, not e3); else several handles joined by commas, blanks
 * or a connector (`e1 e2`, `e1 and e2`: every one counts); else the handle an index line copied whole
 * starts with.
 */
function resolve(r: Reader, written: string): Hit[] {
  const t = written.trim();
  const only = HANDLE_ONLY.exec(t);
  if (only) return [byHandle(r, only[1])];
  const named = byName(r, t);
  if (named !== null) return [named];
  const all = [...t.matchAll(HANDLE_IN)];
  if (all.length > 1 && !/\p{L}/u.test(t.replace(HANDLE_IN, ' ').replace(JOINERS, ' '))) return all.map((m) => byHandle(r, m[1]));
  const head = HANDLE_AT.exec(t);
  return [head ? byHandle(r, head[1]) : null];
}

const cutReason = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = headUnits(v.trim(), MAX_REASON).trim();
  return t === '' ? undefined : t;
};

/** One pick of an item as read: what it hit, how it was written, its own reason. */
interface Named {
  hit: Hit;
  written?: string;
  own?: unknown;
}

/**
 * The picks of one list item: a string (resolve); an object by its id field, else its name field; an
 * object with neither whose keys are handles, `{"e1": "why"}` (each handle a pick, its value the reason).
 * Anything else names nothing.
 */
function itemPicks(r: Reader, item: unknown): Named[] {
  if (typeof item === 'string') return resolve(r, item).map((hit) => ({ hit, written: item }));
  if (!isRec(item)) return [{ hit: null }];
  const own = field(item, ['reason', 'why']);
  const id = field(item, ID_KEYS);
  const name = field(item, NAME_KEYS);
  if (id !== undefined) {
    const hits = resolve(r, id);
    if (hits.some((h) => h !== null) || name === undefined) return hits.map((hit) => ({ hit, written: id, own }));
  }
  if (name !== undefined) return [{ hit: byName(r, name), written: name, own }];
  const keyed = Object.keys(item).filter((k) => HANDLE_ONLY.test(k.trim()));
  if (keyed.length > 0) return keyed.map((k) => ({ hit: byHandle(r, HANDLE_ONLY.exec(k.trim())?.[1]), written: k, own: item[k] }));
  return [{ hit: null }];
}

/** A decoded answer of the recall's shape; null when it has none, 'invalid' when its list holds no string or object. */
function readValue(r: Reader, value: unknown): RecallRead | 'invalid' | null {
  const list = listOf(value);
  if (list === null) return null;
  if (list.length > 0 && !list.some((it) => typeof it === 'string' || isRec(it))) return 'invalid';
  let reasons: Rec = {};
  if (isRec(value)) for (const k of Object.keys(value)) if (bareKey(k) === 'reasons' && isRec(value[k])) reasons = value[k];
  const out: RecallRead = { picks: [], unknown: 0, repeated: 0, trimmed: 0, byName: 0, salvaged: 0 };
  const seen = new Set<string>();
  for (const { hit, written, own } of list.flatMap((item) => itemPicks(r, item))) {
    // Bunraku's order: unknown, then repeated, then the cap.
    if (hit === null) {
      out.unknown++;
      continue;
    }
    if (seen.has(hit.key)) {
      out.repeated++;
      continue;
    }
    seen.add(hit.key);
    if (out.picks.length >= r.opts.maxEntries) {
      out.trimmed++;
      continue;
    }
    const reason =
      r.opts.profile === 'full'
        ? (cutReason(own) ?? cutReason(written !== undefined ? reasons[written.trim()] : undefined) ?? cutReason(reasons[hit.handle]) ?? cutReason(reasons[`[${hit.handle}]`]))
        : undefined;
    out.picks.push({ ref: hit.key, handle: hit.handle, ...(reason !== undefined ? { reason } : {}) });
    if (hit.byName) out.byName++;
  }
  return out;
}

/** A ```json (or bare ```) fence and its body; the closer may be missing. */
const FENCE = /(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)(?:\1|$)/i;
/** After '{': a key (quoted or not) or '}' at once (structured.ts JSONISH). */
const OBJECTISH = /^\{\s*(?:["'}]|[A-Za-z_$][\w$-]*["']?\s*:)/;
/** After '[': a quoted string, an object or ']' (a prose `[e1]` is not a list: it is salvaged). */
const LISTISH = /^\[\s*["'{\]]/;

/** The canonical JSON of each prompt's example (an answer equal to it is the example echoed). */
const EXAMPLE_JSON: Readonly<Record<CompendiumProfile, string>> = {
  full: canonicalJson(JSON.parse(EXAMPLE.full)),
  lite: canonicalJson(JSON.parse(EXAMPLE.lite)),
};

interface Found {
  /**
   * Whole JSON values decoded, in text order (a fence's first). `inner`: it sits after an opener that
   * never closed (inside a cut-off answer, or after a false start or a stray bracket in prose).
   */
  values: { value: unknown; inner: boolean }[];
  /** A JSON-looking value that closed but could not be read. */
  broken: boolean;
  /**
   * The first JSON-looking opener that never closed: `whole` its rest decoded when the rest ends with
   * the opener's closer (a stray quote unbalances the count of a value that did close); else `cut`, the
   * text from it (a cut-off answer).
   */
  open: { whole: unknown } | { cut: string } | null;
}

/** Every JSON-looking value of a text; an opener that never closes is remembered and the search goes on after it. */
function scan(text: string, found: Found): void {
  let open = false;
  for (let at = 0; at < text.length; at++) {
    const c = text[at];
    if (c !== '{' && c !== '[') continue;
    if (!(c === '{' ? OBJECTISH : LISTISH).test(text.slice(at, at + 200))) continue;
    const end = balancedEnd(text, at);
    if (end < 0) {
      if (!open && found.open === null) {
        const rest = text.slice(at).trimEnd();
        const whole = rest.endsWith(c === '{' ? '}' : ']') ? looseJson(rest) : null;
        found.open = whole !== null && whole.ok && (isRec(whole.value) || Array.isArray(whole.value)) ? { whole: whole.value } : { cut: text.slice(at) };
      }
      open = true;
      continue;
    }
    const v = looseJson(text.slice(at, end));
    if (v.ok && (isRec(v.value) || Array.isArray(v.value))) found.values.push({ value: v.value, inner: open });
    else found.broken = true;
    at = end - 1;
  }
}

/** A cut-off JSON closed again: an unfinished last string is dropped, then looseJson closes the brackets. */
function closeCut(json: string): unknown {
  let inString = false;
  let start = -1;
  for (let k = 0; k < json.length; k++) {
    const c = json[k];
    if (inString) {
      if (c === '\\') k++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      start = k;
    }
  }
  const v = looseJson(inString ? json.slice(0, start) : json);
  return v.ok ? v.value : undefined;
}

/** Handles in prose: every known one once, in order; unknown handles counted. */
function salvage(r: Reader, text: string): RecallRead {
  const out: RecallRead = { picks: [], unknown: 0, repeated: 0, trimmed: 0, byName: 0, salvaged: 0 };
  const seen = new Set<string>();
  for (const m of text.matchAll(HANDLE_IN)) {
    const handle = `e${m[1]}`;
    const key = r.opts.handles.get(handle);
    if (key === undefined) {
      out.unknown++;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.picks.length >= r.opts.maxEntries) {
      out.trimmed++;
      continue;
    }
    out.picks.push({ ref: key, handle });
    out.salvaged++;
  }
  return out;
}

/**
 * D-199: a recall answer — its visible text (structuredCall's rawRead, think tags already cut) or a
 * decoded JSON value. Text: every JSON-looking object or quoted list is decoded (a fence first, then in
 * text order); an opener that never closes is remembered and the search goes on after it (ruling K).
 * The answer is the first read of the recall's shape that picks something, else the first of that shape,
 * in this order: whole values (after an opener that never closed only objects of the recall's shape: a
 * list or an object there is a piece of the unfinished answer); the rest after that opener read whole (a
 * stray quote); that opener's text closed again (`cutOff`, its unfinished last item dropped; only when it
 * picks something); the prompt's own example (it never wins over another answer). Else known handles
 * fished from the text (`salvaged`); else `invalid` when JSON of another shape was there (the corrective
 * pass), `undecodable` when the answer has text — broken JSON, prose — and `no_output` only when it is
 * empty (D-208's words).
 */
export function readRecall(raw: unknown, opts: RecallReadOptions): RecallReadResult {
  const r = readerOf(opts);
  if (typeof raw !== 'string') {
    const got = readValue(r, raw);
    if (got === null) return { ok: false, code: 'invalid', why: 'the answer has no entry_ids list' };
    if (got === 'invalid') return { ok: false, code: 'invalid', why: 'entry_ids must be a list of handles' };
    return { ok: true, ...got };
  }
  const found: Found = { values: [], broken: false, open: null };
  const body = FENCE.exec(raw)?.[2]?.trim() ?? '';
  if (body.startsWith('{') || body.startsWith('[')) scan(body, found);
  scan(raw, found);
  let invalid = false;
  let other = false;
  const answers: { read: RecallRead; cutOff?: true }[] = [];
  const examples: RecallRead[] = [];
  for (const { value, inner } of found.values) {
    if (inner && !isRec(value)) continue;
    const got = readValue(r, value);
    if (got === 'invalid') invalid = true;
    else if (got === null) other ||= !inner;
    else if (canonicalJson(value) === EXAMPLE_JSON[opts.profile]) examples.push(got);
    else answers.push({ read: got });
  }
  if (found.open !== null) {
    if ('whole' in found.open) {
      const got = readValue(r, found.open.whole);
      if (got !== null && got !== 'invalid') answers.push({ read: got });
    } else {
      const got = readValue(r, closeCut(found.open.cut));
      if (got !== null && got !== 'invalid' && got.picks.length > 0) answers.push({ read: got, cutOff: true });
    }
  }
  const pool: typeof answers = answers.length > 0 ? answers : examples.map((read) => ({ read }));
  const best = pool.find((a) => a.read.picks.length > 0) ?? pool[0];
  if (best !== undefined) return { ok: true, ...best.read, ...(best.cutOff ? { cutOff: true as const } : {}) };
  const fished = salvage(r, raw);
  if (fished.picks.length > 0) return { ok: true, ...fished };
  if (invalid) return { ok: false, code: 'invalid', why: 'entry_ids must be a list of handles' };
  if (other) return { ok: false, code: 'invalid', why: 'the answer has no entry_ids list' };
  if (found.broken || found.open !== null) return { ok: false, code: 'undecodable', why: 'the JSON could not be read' };
  if (raw.trim() !== '') return { ok: false, code: 'undecodable', why: 'no JSON object was found' };
  return { ok: false, code: 'no_output', why: 'no JSON object was found' };
}

/** readRecall as structuredCall's `rawRead` (the answer's text) and `read` (a decoded value). */
export function recallReader(opts: RecallReadOptions): {
  read: (raw: unknown) => ReadResult<RecallRead>;
  rawRead: (answer: { text: string }) => RawRead<RecallRead>;
} {
  const skipsOf = (got: RecallRead): Skip[] => (got.cutOff ? [{ path: 'answer', why: 'cut_off: the answer was cut off; its unfinished last item was left out' }] : []);
  const strip = (got: { ok: true } & RecallRead): RecallRead => {
    const { ok: _ok, ...value } = got;
    return value;
  };
  return {
    read: (raw) => {
      const got = readRecall(raw, opts);
      return got.ok ? { ok: true, value: strip(got), skipped: skipsOf(got) } : { ok: false, code: 'invalid', message: got.why };
    },
    rawRead: (answer) => {
      const got = readRecall(answer.text, opts);
      if (!got.ok) return { ok: false, code: got.code, message: got.why };
      return { ok: true, value: strip(got), skipped: skipsOf(got), ...(got.cutOff ? { cutOff: true as const } : {}) };
    },
  };
}

// ---- the record (D-200) ---------------------------------------------------------------------------

type RecordCode = NonNullable<RecallRecord['code']>;

/** structuredCall's failure codes as the record names them. */
const CODE_OF: Readonly<Record<StructuredFailCode, RecordCode>> = {
  transport_unsupported: 'transport_unsupported',
  provider_error: 'provider_error',
  no_output: 'no_output',
  undecodable: 'undecodable',
  invalid: 'undecodable',
  missing_directive: 'undecodable',
  timeout: 'timeout',
  aborted: 'aborted',
  preempted: 'aborted',
};
export interface RecallRun {
  /** A sync call in the turn, or an adopted prefetch. */
  source: 'sync' | 'prefetch';
  profile: CompendiumProfile;
  /** RecallIndex.omitted. */
  omitted: number;
  /** The recall route's 'conn:model' (named on a failure too). */
  model: string;
  transport: Transport;
  first: StructuredResult<RecallRead>;
  /** The top-up, when one ran. */
  topUp?: StructuredResult<RecallRead>;
  ms?: number;
  /** A prefetch: the answer A(n) it was computed after. */
  basis?: string;
}

const ZERO = { unknown: 0, repeated: 0, trimmed: 0, byName: 0, salvaged: 0 } as const;

/**
 * D-200: the record of a run. Read → `recalled` (picks) or `empty`, with the run's source; a failure
 * → `failed`, source `lexical` (the selector's tiers 0/2/3 stand in), with its code — a lite answer
 * that cannot be read too (the lead's ruling G after wave 1: it is not reused on a swipe, and the turn
 * falls back per onMiss). `calls` counts every model call (retries and the top-up included); `usage`
 * sums what they reported.
 */
export function recallRecord(run: RecallRun): RecallRecord {
  const calls = [...run.first.calls, ...(run.topUp?.calls ?? [])];
  let input = 0;
  let output = 0;
  let reported = false;
  for (const c of calls) {
    if (c.usage === undefined) continue;
    reported = true;
    input += c.usage.inputTotal ?? 0;
    output += c.usage.outputTotal ?? 0;
  }
  const base = {
    v: 1 as const,
    profile: run.profile,
    omitted: run.omitted,
    calls: calls.length,
    ...(run.ms !== undefined ? { ms: run.ms } : {}),
    model: run.model,
    transport: run.transport,
    ...(run.basis !== undefined ? { basis: run.basis } : {}),
    ...(reported ? { usage: { input, output } } : {}),
  };
  if (!run.first.ok) return { ...base, status: 'failed', source: 'lexical', picks: [], ...ZERO, code: CODE_OF[run.first.code] };
  const read = betterRead(run.first.value, run.topUp);
  return {
    ...base,
    status: read.picks.length > 0 ? 'recalled' : 'empty',
    source: run.source,
    picks: read.picks.map((p) => ({ ref: p.ref, ...(run.profile === 'full' && p.reason !== undefined ? { reason: p.reason } : {}) })),
    unknown: read.unknown,
    repeated: read.repeated,
    trimmed: read.trimmed,
    byName: read.byName,
    salvaged: read.salvaged,
  };
}

/**
 * No call: the index was empty (`empty_index`), the recall route has no connection (`no_connection`), or
 * the request leaves the answer less than its floor in the recall window (`no_room`, the lead's ruling G).
 * The selector stands in.
 */
export function skippedRecord(o: { profile: CompendiumProfile; code: 'empty_index' | 'no_connection' | 'no_room'; omitted?: number; model?: string; basis?: string }): RecallRecord {
  return {
    v: 1,
    status: 'skipped',
    source: 'lexical',
    profile: o.profile,
    picks: [],
    ...ZERO,
    omitted: o.omitted ?? 0,
    calls: 0,
    ...(o.model !== undefined ? { model: o.model } : {}),
    code: o.code,
    ...(o.basis !== undefined ? { basis: o.basis } : {}),
  };
}

/** A prefetch missed and `onMiss` fell back to the selector (`prefetch_missed`). */
export function missedRecord(o: { profile: CompendiumProfile; basis?: string }): RecallRecord {
  return { v: 1, status: 'skipped', source: 'lexical', profile: o.profile, picks: [], ...ZERO, omitted: 0, calls: 0, code: 'prefetch_missed', ...(o.basis !== undefined ? { basis: o.basis } : {}) };
}

/** D-203: a swipe or continue reuses a record that answered (`recalled` or `empty`); a failed, skipped or absent one does not. */
export function reusable(rec: RecallRecord | null | undefined): rec is RecallRecord {
  return rec !== null && rec !== undefined && (rec.status === 'recalled' || rec.status === 'empty');
}

/** The reuse of a record that answered: its picks and counts, 0 calls, `reusedFrom` the answer it came from; null when it is not reusable. */
export function reusedRecord(prev: RecallRecord | null | undefined, from: string): RecallRecord | null {
  if (!reusable(prev)) return null;
  const { ms: _ms, usage: _usage, basis: _basis, code: _code, reusedFrom: _from, ...kept } = prev;
  return { ...kept, picks: prev.picks.map((p) => ({ ...p })), source: 'reused', calls: 0, reusedFrom: from };
}

/** The entry keys of a record, tier 1 of the selector in recall's order (select.ts recallPicks). */
export const recallPicks = (rec: RecallRecord | null | undefined): string[] => (rec ? rec.picks.map((p) => p.ref) : []);

// ---- reading a stored record ----------------------------------------------------------------------

const STATUSES: ReadonlySet<string> = new Set(['recalled', 'empty', 'skipped', 'failed']);
const SOURCES: ReadonlySet<string> = new Set(['sync', 'prefetch', 'lexical', 'reused']);
const PROFILES: ReadonlySet<string> = new Set(['full', 'lite']);
const TRANSPORTS: ReadonlySet<string> = new Set(['structured', 'tagged']);
const CODES: ReadonlySet<string> = new Set([
  'timeout',
  'provider_error',
  'no_output',
  'undecodable',
  'transport_unsupported',
  'aborted',
  'no_connection',
  'prefetch_missed',
  'empty_index',
  'no_room',
]);
/** Bounds of a stored record (a record M5c writes holds at most 30 picks). */
const STORED = Object.freeze({ picks: 64, ref: 512, text: 200, id: 80 });

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const shortStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;

/**
 * A `recall` field as the journal gives it back (D-200): the record, or null when its required fields
 * are bad (it then reads as absent). Optional fields of the wrong kind are dropped, picks past 64 and
 * picks without a usable key are dropped, reasons are cut to 200 characters, unknown keys are not
 * copied.
 */
export function checkRecallRecord(stored: unknown): RecallRecord | null {
  if (!isRec(stored) || stored.v !== 1) return null;
  const { status, source, profile, picks } = stored;
  if (typeof status !== 'string' || !STATUSES.has(status) || typeof source !== 'string' || !SOURCES.has(source)) return null;
  if (typeof profile !== 'string' || !PROFILES.has(profile) || !Array.isArray(picks)) return null;
  const counters = ['unknown', 'repeated', 'trimmed', 'omitted', 'byName', 'salvaged', 'calls'] as const;
  if (!counters.every((k) => count(stored[k]))) return null;
  const kept: RecallRecord['picks'] = [];
  for (const p of picks.slice(0, STORED.picks)) {
    if (!isRec(p) || !shortStr(p.ref, STORED.ref)) continue;
    const reason = cutReason(p.reason);
    kept.push({ ref: p.ref, ...(reason !== undefined ? { reason } : {}) });
  }
  const usage = stored.usage;
  return {
    v: 1,
    status: status as RecallRecord['status'],
    source: source as RecallRecord['source'],
    profile: profile as RecallRecord['profile'],
    picks: kept,
    unknown: stored.unknown as number,
    repeated: stored.repeated as number,
    trimmed: stored.trimmed as number,
    omitted: stored.omitted as number,
    byName: stored.byName as number,
    salvaged: stored.salvaged as number,
    calls: stored.calls as number,
    ...(typeof stored.ms === 'number' && Number.isFinite(stored.ms) && stored.ms >= 0 ? { ms: stored.ms } : {}),
    ...(shortStr(stored.model, STORED.text) ? { model: stored.model } : {}),
    ...(typeof stored.transport === 'string' && TRANSPORTS.has(stored.transport) ? { transport: stored.transport as Transport } : {}),
    ...(typeof stored.code === 'string' && CODES.has(stored.code) ? { code: stored.code as RecordCode } : {}),
    ...(shortStr(stored.basis, STORED.id) ? { basis: stored.basis } : {}),
    ...(shortStr(stored.reusedFrom, STORED.id) ? { reusedFrom: stored.reusedFrom } : {}),
    ...(isRec(usage) && count(usage.input) && count(usage.output) ? { usage: { input: usage.input, output: usage.output } } : {}),
  };
}
