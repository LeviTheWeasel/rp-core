// Ported from Bunraku:src/core/lore/engine/{engine,recursion,groups,budget,scan,types}.ts@702d8120
// (itself RoleCall's lorebook engine, apps/rc/src/lib/lorebook, rebuilt with derived timers and a
// seeded rng).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The lore engine (ARCHITECTURE.md §10.3, D-7, D-45, D-46). Pure: books, scan text, past fires,
// a seed and a token counter in; what fired, what the budget cut and (on request) one verdict per
// entry out. Placement is lore/place.ts; assemble puts the result into slots and depth inserts.
//
// SillyTavern semantics (world-info.js checkWorldInfo, SillyBunny's shipped defaults):
// 1. Gather the enabled entries in ST's "character first" order (getSortedEntries): the persona's
//    book, the card's book, then every session book as ONE group (ST merges its global worlds into
//    one list before sorting), each group sorted by `order` descending (missing order = 100),
//    stable (ties keep source order, then book order).
// 2. Loop 0 (direct): delay not reached → skipped; sticky window open → fires as 'sticky'; cooling
//    down → skipped; constant → fires; otherwise primary keys over the entry's scan text
//    (scanText of `scan` at entry.scanDepth ?? book.scanDepth ?? 2), then secondary keys with
//    `logic` (and_any by default).
// 3. Inclusion groups among the entries activated in this loop: a group already represented by an
//    earlier loop's entry → the rest lose ('group-lost'); a sticky member wins; else one weighted
//    pick by groupWeight (default 100) on the seeded sub-stream 'lore.group'.
// 4. Then, sticky first and otherwise in gather order: once the budget has overflowed only
//    ignoreBudget entries go on; the probability roll comes first (probability 0–100, default 100,
//    sticky always passes; sub-stream 'lore.prob') — a failed roll is 'chance' — and only then the
//    budget: the entry's expanded text (expand()) is accepted while count(all accepted text so far,
//    each entry followed by '\n') stays below `budget`; the first that does not fit sets the
//    overflow and is 'budget-cut'. ignoreBudget entries skip the check, but their text is accepted
//    text and counts against the entries after them, as in ST. Far below the
//    budget the sum of the entries' own counts decides (one count per entry); within a margin of it
//    the joined text is counted exactly, so the cut is exact and the cost stays linear.
// 5. Recursion (when the book is recursive, default true): accepted entries without
//    preventRecursion add their text to a recursion buffer; the next loop matches the entries not
//    yet activated against chat text + buffer (excludeRecursion entries: chat text only, so they
//    cannot be woken by recursion). At most 3 recursion loops (§10.3; SillyBunny's shipped
//    max_recursion_steps 0 is unlimited — a named deviation, test/golden/st/README.md G-5); stop
//    when a loop adds nothing.
// Defaults are SillyBunny's shipped settings: scanDepth 2, caseSensitive false, wholeWords true,
// recursive true, budget 25 % of the window (the caller passes tokens).
// Sources (adapt): Bunraku src/core/lore/engine/{engine,recursion,groups,budget,scan,types}.ts
// (RoleCall's pipeline with derived timers and seeded rng); reorder to ST's "probability before
// budget" and one `order` axis; drop per-book budgets, special/emotion triggers, side effects,
// boosts, character filters and the key index.
// CONTRACT FILE: signatures are fixed; the lore agent implements the bodies.
//
// Implementation notes (where the steps above needed a reading; ST world-info.js is the judge):
// - Delay is checked first, before sticky and constant, as ST does: a delayed constant waits too.
//   Sticky is checked before constant (ST checks constant first) so that a sticky constant entry
//   records 'sticky' inside its window; a 'constant' fire there would restart the derived window.
// - "Not yet activated" is ST's rule: a later loop skips only entries already accepted or that
//   failed their roll (and, here, entries blocked by delay or cooldown, which cannot change within
//   a run). A group loser is looked at again in the next loop; if its group got a member accepted
//   meanwhile it loses again, else the group is drawn again among that loop's members.
// - In recursion loops an excludeRecursion entry, or any entry of a book with recursive:false, is
//   not looked at again (ST skips excludeRecursion entries in recursion scans; per book, a
//   non-recursive book neither feeds the buffer nor is woken by it).
// - Draws: 'lore.prob' is index-addressed — the entry at position k of the gather order (disabled
//   entries hold their place) always reads the k-th value of the stream, so a roll never depends on
//   which other entries rolled, nor on the loop it happens in. 'lore.group' gives one value per
//   contested group, consumed in the order groups are met (loop by loop, sticky first, then gather
//   order), so a group draw depends only on the groups met before it.
// - Entries skipped after the overflow are never rolled nor expanded; they still count as cut by
//   the budget ('budget-cut', listed in `cut` with their raw content).
// - A group loser looked at again in a recursion loop matched by the chat text alone says 'key' /
//   'secondary', not 'recursion': only an entry the recursion text woke is a 'recursion' fire.
// - Verdicts: an entry's verdict is the last decision about it, `loop` the last loop it was judged
//   in. An entry the recursion text would have woken after the last allowed loop keeps
//   'no-key-match' with detail.recursionLimit (MAX_RECURSION). 'regex-error' replaces 'no-key-match' / 'secondary-logic' when a key of the entry failed to
//   compile (the likely cause); the other reasons stand, with regexErrors listed. 'exclude-recursion'
//   is said only when a recursion loop ran and its text would have woken the entry.
// - Book `match: 'stem'` is matched as 'literal' in M2; stems arrive in M3 with normalizeTerm.
// - Entries with meta.type are ordinary entries in M2 (M5a hands them to Compendium, D-76).

import type { LoreBook, LoreEntry } from '../formats/native.ts';
import { subRng } from '../prompt/rng.ts';
import { KeyMatcher, secondaryPasses, type KeyOptions } from './keys.ts';
import { DEFAULT_SCAN_DEPTH, scanText } from './scan.ts';
import { cooldownLeft, delayLeft, isSticky, stickyLeft, timerState, type PastFire } from './timers.ts';

/** One book as the engine sees it. `key` names it in traces and timers: a library id, CARD_BOOK_KEY or PERSONA_BOOK_KEY. */
export interface LoreSource {
  key: string;
  book: LoreBook;
}

/** The card's embedded book and the persona's book. '@' cannot start a library id (canonicalId). */
export const CARD_BOOK_KEY = '@card';
export const PERSONA_BOOK_KEY = '@persona';

/** Default `order` of an entry that names none (ST's default insertion order). */
export const DEFAULT_LORE_ORDER = 100;
/** Recursion loops after the direct scan (Bunraku and RoleCall cap it at 3). */
export const MAX_RECURSION = 3;

/** ST's default inclusion-group weight (world-info.js DEFAULT_WEIGHT). */
export const DEFAULT_GROUP_WEIGHT = 100;

/** Tokens of slack per entry whose budget cost is estimated instead of counted (see runLore step 4). */
const BUDGET_SLACK = 3;

/** Why an entry fired (stored in trace.lore.fired[].why). [D-45] */
export type LoreFireReason = 'constant' | 'key' | 'secondary' | 'sticky' | 'recursion';
/** Why an entry did not (recomputed on request, never stored). [D-45] */
export type LoreSkipReason =
  | 'disabled'
  | 'no-key-match'
  | 'secondary-logic'
  | 'chance'
  | 'cooldown'
  | 'delay'
  | 'budget-cut'
  | 'exclude-recursion'
  | 'group-lost'
  | 'regex-error';

export interface LoreRunInput {
  /** In ST order: persona book, card book, then the session's books in config order. */
  sources: readonly LoreSource[];
  /** scanMessages(): chat messages, newest first, as "Name: text". */
  scan: readonly string[];
  /** chatLengthAt(): for delay and timers. */
  chatLength: number;
  /** pathFires(): every past fire on the path. */
  fires: readonly PastFire[];
  /**
   * pathScans(): chat lengths of the earlier scans on the path, for the cooldown that follows a
   * sticky window. Omitted: a scan at every chat length (the cooldown starts right at the window's end).
   */
  scans?: readonly number[];
  /** The turn's seed; groups and probability use sub-streams 'lore.group' and 'lore.prob' (D-44). */
  seed: number;
  /** Token budget, checked for entries without ignoreBudget (whose text still counts); Infinity = none. */
  budget: number;
  /** Token count of a text (the caller's counter, already scaled by the model's correction). */
  count(text: string): number;
  /**
   * With explain, optional: the same text counted without the model's correction (what a request's
   * rows show); each verdict then carries it as `rawTokens`.
   */
  rawCount?(text: string): number;
  /** Macro expansion of an entry's content, called once per entry that passes its roll. `key` is entryKey(). */
  expand(key: string, content: string): string;
  /** Also return one verdict per entry [D-45]. */
  explain?: boolean;
}

export interface LoreHit {
  book: string;
  id: string;
  entry: LoreEntry;
  /** Expanded text, as it will be placed (in `cut`, an entry skipped after the overflow keeps its raw content). */
  text: string;
  tokens: number;
  why: LoreFireReason;
  /** The keys that matched (empty for constant and sticky). */
  matched: string[];
  /** 0 = direct; 1–3 = the recursion loop it was woken in. */
  loop: number;
}

export interface LoreVerdict {
  book: string;
  id: string;
  title?: string;
  fired: boolean;
  why: LoreFireReason | LoreSkipReason;
  matched: string[];
  loop: number;
  /** Tokens of the entry's text (expanded when it got that far, else raw), as the budget counts them (`count`). */
  tokens: number;
  /** The same text counted by `rawCount` (without the model's correction), when the caller passed one. */
  rawTokens?: number;
  /**
   * chance: rolled/needed (0–1); cooldown/delay: remaining messages; a sticky fire: messages left in
   * its window; budget-cut: cost = the tokens the entry would have added (its separator included)
   * and left = the most an entry could still add (the check is strict: total < budget);
   * recursionLimit: the recursion text would have woken it, but recursion stops after that many loops.
   */
  /**
   * overflowed: a budget-cut entry that was never tried because an earlier entry had already overflowed
   * the budget (ST stops there); its cost is its own count, not what it would add.
   */
  detail?: { rolled?: number; needed?: number; remaining?: number; cost?: number; left?: number; recursionLimit?: number; overflowed?: true };
  /** '/re/' keys of this entry that did not compile. */
  regexErrors?: string[];
}

export interface LoreRunResult {
  /** Accepted entries, in acceptance order (placement order is lore/place.ts's business). */
  fired: LoreHit[];
  /** Activated and rolled, but cut by the budget (plus the activated entries skipped after the overflow, unrolled). */
  cut: LoreHit[];
  /** Tokens used against the budget. */
  used: number;
  /** Every '/re/' key that did not compile, once per entry. */
  regexErrors: { book: string; id: string; key: string; message: string }[];
  /** With explain: one per entry of every source, sources in input order, entries in book order. */
  verdicts?: LoreVerdict[];
}

/** The key of an entry in maps, timers and expand(): book and id joined by U+0000 (neither can hold it in practice). */
export function entryKey(book: string, id: string): string {
  return `${book}\u0000${id}`;
}

/** 'book:id' — how the trace and the REPL name an entry (trace.lore.cut). */
export function entryLabel(book: string, id: string): string {
  return `${book}:${id}`;
}

// ---- internals ---------------------------------------------------------------------------------

/** One entry with its effective settings (entry → book → SillyBunny defaults). */
interface Item {
  /** Position in the gather order of every entry, disabled ones included: the 'lore.prob' draw index. */
  idx: number;
  /** Source index and the entry's index in its book (where its verdict goes). */
  src: number;
  pos: number;
  book: string;
  entry: LoreEntry;
  key: string;
  scanDepth: number;
  opts: KeyOptions;
  /** The book takes part in recursion (feeds the buffer, can be woken by it). */
  recursive: boolean;
  probability: number;
  groups: string[];
  weight: number;
  /** Non-blank secondary keys (ST ignores blank ones). */
  secondaryTotal: number;
}

/** An entry activated in one loop, before groups, roll and budget. */
interface Act {
  it: Item;
  why: LoreFireReason;
  matched: string[];
  sticky: boolean;
}

type Detail = NonNullable<LoreVerdict['detail']>;

const orderOf = (e: LoreEntry): number => e.order ?? DEFAULT_LORE_ORDER;

function makeItem(idx: number, src: number, pos: number, source: LoreSource, entry: LoreEntry): Item {
  const book = source.book;
  const p = entry.probability;
  const groups = [...new Set((entry.groups ?? []).map((g) => g.trim()).filter(Boolean))];
  return {
    idx,
    src,
    pos,
    book: source.key,
    entry,
    key: entryKey(source.key, entry.id),
    scanDepth: entry.scanDepth ?? book.scanDepth ?? DEFAULT_SCAN_DEPTH,
    // book.match 'stem' is matched as 'literal' in M2 (M3 adds stems).
    opts: {
      caseSensitive: entry.caseSensitive ?? book.caseSensitive ?? false,
      wholeWords: entry.wholeWords ?? book.wholeWords ?? true,
    },
    recursive: book.recursive ?? true,
    // ST: a missing or non-numeric probability is 100.
    probability: p === undefined || !Number.isFinite(p) ? 100 : p,
    groups,
    weight: Math.max(0, entry.groupWeight ?? DEFAULT_GROUP_WEIGHT),
    secondaryTotal: (entry.secondary ?? []).filter((k) => k.trim() !== '').length,
  };
}

export function runLore(input: LoreRunInput): LoreRunResult {
  const explain = input.explain === true;
  const timers = timerState(input.fires, input.chatLength, input.scans);
  const matcher = new KeyMatcher();

  // Verdicts: one slot per entry of every source; the last decision about an entry wins.
  const verdicts: (LoreVerdict | undefined)[][] = input.sources.map((s) => new Array<LoreVerdict | undefined>(s.book.entries.length));
  const rawTokens = new Map<Item, number>();
  const raw = (it: Item): number => {
    let n = rawTokens.get(it);
    if (n === undefined) rawTokens.set(it, (n = input.count(it.entry.content)));
    return n;
  };
  /** `text`: what `tokens` counted (the expanded text), when not the entry's own content. */
  const judge = (it: Item, fired: boolean, why: LoreVerdict['why'], loop: number, matched: string[], tokens?: number, detail?: Detail, text?: string): void => {
    if (!explain) return;
    const v: LoreVerdict = { book: it.book, id: it.entry.id, fired, why, matched, loop, tokens: tokens ?? raw(it) };
    if (input.rawCount) v.rawTokens = input.rawCount(text ?? it.entry.content);
    if (it.entry.title !== undefined) v.title = it.entry.title;
    if (detail) v.detail = detail;
    (verdicts[it.src] as (LoreVerdict | undefined)[])[it.pos] = v;
  };

  // Regex errors, once per entry and key.
  const regexErrors: LoreRunResult['regexErrors'] = [];
  const errorsOf = new Map<Item, Set<string>>();
  const noteErrors = (it: Item, errs: readonly { key: string; message: string }[]): void => {
    for (const e of errs) {
      let seen = errorsOf.get(it);
      if (!seen) errorsOf.set(it, (seen = new Set()));
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      regexErrors.push({ book: it.book, id: it.entry.id, key: e.key, message: e.message });
    }
  };

  /** Primary keys, then secondary keys with the entry's logic. `probe`: an explain-only look that reports nothing. */
  const evaluate = (it: Item, text: string, probe = false): { ok: boolean; secondary: boolean; matched: string[] } => {
    const prim = matcher.match(it.entry.keys, text, it.opts);
    if (!probe) noteErrors(it, prim.regexErrors);
    if (prim.matched.length === 0) return { ok: false, secondary: false, matched: [] };
    if (it.secondaryTotal === 0) return { ok: true, secondary: false, matched: prim.matched };
    const sec = matcher.match(it.entry.secondary ?? [], text, it.opts);
    if (!probe) noteErrors(it, sec.regexErrors);
    const ok = secondaryPasses(it.entry.logic ?? 'and_any', sec.matched.length, it.secondaryTotal);
    return { ok, secondary: true, matched: ok ? [...prim.matched, ...sec.matched] : prim.matched };
  };

  // 1. Gather: the persona's book, the card's book, then the session books merged into one group;
  // each group sorted by order descending, stable (source order, then book order). Disabled entries
  // keep a draw index.
  const groupKey = (key: string): string => (key === PERSONA_BOOK_KEY || key === CARD_BOOK_KEY ? key : '');
  const groups = new Map<string, { entry: LoreEntry; s: number; pos: number }[]>();
  input.sources.forEach((source, s) => {
    const g = groupKey(source.key);
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    source.book.entries.forEach((entry, pos) => (list as { entry: LoreEntry; s: number; pos: number }[]).push({ entry, s, pos }));
  });
  const items: Item[] = [];
  let idx = 0;
  for (const list of groups.values()) {
    list.sort((a, b) => orderOf(b.entry) - orderOf(a.entry) || a.s - b.s || a.pos - b.pos);
    for (const { entry, s, pos } of list) {
      const it = makeItem(idx++, s, pos, input.sources[s] as LoreSource, entry);
      if (entry.enabled === false) judge(it, false, 'disabled', 0, []);
      else items.push(it);
    }
  }

  const probRng = subRng(input.seed, 'lore.prob');
  const probDraws: number[] = [];
  const probDraw = (i: number): number => {
    while (probDraws.length <= i) probDraws.push(probRng());
    return probDraws[i] as number;
  };
  const groupRng = subRng(input.seed, 'lore.group');

  const chatTexts = new Map<number, string>();
  const chatText = (depth: number): string => {
    let t = chatTexts.get(depth);
    if (t === undefined) chatTexts.set(depth, (t = scanText(input.scan, depth)));
    return t;
  };

  const done = new Set<Item>(); // accepted, failed roll, cut, or blocked by delay/cooldown
  const acceptedGroups = new Set<string>();
  const fired: LoreHit[] = [];
  const cut: LoreHit[] = [];
  const recursion: string[] = [];
  const finite = Number.isFinite(input.budget);
  let overflow = false;
  let budgetText = '';
  // The budget check is count(budgetText + text + '\n') < budget (ST counts the joined text). That
  // count is taken only near the budget: `exact` is count(budgetText) as of the last exact count,
  // `pending` the entries accepted since, each estimated from its own count (+1 for its '\n').
  let exact = 0;
  let pendingTok = 0;
  let pendingN = 0;
  const usedNow = (): number => {
    if (pendingN > 0) {
      exact = input.count(budgetText);
      pendingTok = 0;
      pendingN = 0;
    }
    return exact;
  };
  const lostGroup = new Set<Item>(); // judged 'group-lost' in an earlier loop

  /** 3. Inclusion groups (ST filterByInclusionGroups); returns the survivors in their order. */
  const resolveGroups = (acts: Act[], loop: number): Act[] => {
    const grouped = new Map<string, Act[]>();
    for (const a of acts) {
      for (const g of a.it.groups) {
        let list = grouped.get(g);
        if (!list) grouped.set(g, (list = []));
        list.push(a);
      }
    }
    if (grouped.size === 0) return acts;
    const lost = new Set<Act>();
    const lose = (a: Act): void => {
      if (lost.has(a)) return;
      lost.add(a);
      for (const list of grouped.values()) {
        const i = list.indexOf(a);
        if (i >= 0) list.splice(i, 1);
      }
      lostGroup.add(a.it);
      judge(a.it, false, 'group-lost', loop, a.matched);
    };
    // A group with sticky members keeps only those, without a draw.
    const settled = new Set<string>();
    for (const [g, members] of grouped) {
      if (!members.some((a) => a.sticky)) continue;
      for (const a of [...members]) if (!a.sticky) lose(a);
      settled.add(g);
    }
    for (const [g, members] of grouped) {
      if (settled.has(g)) continue;
      if (acceptedGroups.has(g)) {
        for (const a of [...members]) lose(a);
        continue;
      }
      if (members.length <= 1) continue;
      // ST: roll in [0, total), the first member whose cumulative weight reaches it wins.
      const total = members.reduce((sum, a) => sum + a.it.weight, 0);
      const roll = groupRng() * total;
      let acc = 0;
      const winner = members.find((a) => (acc += a.it.weight) >= roll) ?? members[0];
      for (const a of [...members]) if (a !== winner) lose(a);
    }
    return acts.filter((a) => !lost.has(a));
  };

  for (let loop = 0; loop <= MAX_RECURSION; loop++) {
    const recText = recursion.join('\n');
    const textFor = (it: Item): string => {
      const chat = chatText(it.scanDepth);
      if (loop === 0 || !recText) return chat;
      return chat ? `${chat}\n${recText}` : recText;
    };

    // 2. Activation.
    const acts: Act[] = [];
    for (const it of items) {
      if (done.has(it)) continue;
      const e = it.entry;
      if (loop > 0 && (!it.recursive || e.excludeRecursion)) {
        // Say why when recursion text would have woken it.
        if (explain && it.recursive && e.excludeRecursion) {
          const v = verdicts[it.src]?.[it.pos];
          if (v && (v.why === 'no-key-match' || v.why === 'secondary-logic') && !e.constant) {
            const r = evaluate(it, textFor(it), true);
            if (r.ok) judge(it, false, 'exclude-recursion', loop, r.matched);
          }
        }
        continue;
      }
      const delay = delayLeft(e.delay, input.chatLength);
      if (delay > 0) {
        done.add(it);
        judge(it, false, 'delay', loop, [], undefined, { remaining: delay });
        continue;
      }
      if (isSticky(timers, it.key, e.sticky)) {
        acts.push({ it, why: 'sticky', matched: [], sticky: true });
        continue;
      }
      const cooldown = cooldownLeft(timers, it.key, e.sticky, e.cooldown);
      if (cooldown > 0) {
        done.add(it);
        judge(it, false, 'cooldown', loop, [], undefined, { remaining: cooldown });
        continue;
      }
      if (e.constant) {
        acts.push({ it, why: 'constant', matched: [], sticky: false });
        continue;
      }
      // A group loser seen again matches the chat text by itself: a key fire, not a recursion one.
      if (loop > 0 && lostGroup.has(it)) {
        const c = evaluate(it, chatText(it.scanDepth));
        if (c.ok) {
          acts.push({ it, why: c.secondary ? 'secondary' : 'key', matched: c.matched, sticky: false });
          continue;
        }
      }
      const r = evaluate(it, textFor(it));
      if (!r.ok) {
        judge(it, false, r.matched.length > 0 ? 'secondary-logic' : 'no-key-match', loop, r.matched);
        continue;
      }
      acts.push({ it, why: loop > 0 ? 'recursion' : r.secondary ? 'secondary' : 'key', matched: r.matched, sticky: false });
    }
    if (acts.length === 0) break;

    // Sticky entries first, then gather order (ST sorts each loop's activations so).
    acts.sort((a, b) => +b.sticky - +a.sticky || a.it.idx - b.it.idx);
    const kept = resolveGroups(acts, loop);

    // 4. Probability, then budget.
    const feed: string[] = [];
    for (const a of kept) {
      const it = a.it;
      const e = it.entry;
      if (overflow && !e.ignoreBudget) {
        // Never rolled nor expanded: the budget is spent.
        done.add(it);
        const tokens = raw(it);
        cut.push({ book: it.book, id: e.id, entry: e, text: e.content, tokens, why: a.why, matched: a.matched, loop });
        judge(it, false, 'budget-cut', loop, a.matched, tokens, { cost: tokens, left: Math.max(0, input.budget - exact - 1), overflowed: true });
        continue;
      }
      let rolled: number | undefined;
      let pass: boolean;
      if (a.sticky || it.probability >= 100) pass = true;
      else if (it.probability <= 0) pass = false;
      else {
        rolled = probDraw(it.idx);
        pass = rolled * 100 < it.probability;
      }
      const chance: Detail | undefined = rolled !== undefined || !pass ? { ...(rolled !== undefined ? { rolled } : {}), needed: Math.max(0, it.probability) / 100 } : undefined;
      if (!pass) {
        done.add(it);
        judge(it, false, 'chance', loop, a.matched, undefined, chance);
        continue;
      }

      const text = input.expand(it.key, e.content);
      const tokens = input.count(text);
      const hit: LoreHit = { book: it.book, id: e.id, entry: e, text, tokens, why: a.why, matched: a.matched, loop };
      done.add(it);
      if (!e.ignoreBudget) {
        const next = `${budgetText}${text}\n`;
        if (finite) {
          // The sum of per-entry counts and the count of the joined text differ only at the joins
          // and by the '\n' (a token or two each); BUDGET_SLACK per estimated entry covers that.
          const estimate = exact + pendingTok + tokens + 1;
          if (estimate + BUDGET_SLACK * (pendingN + 1) < input.budget) {
            pendingTok += tokens + 1;
            pendingN++;
          } else {
            const total = input.count(next);
            if (!(total < input.budget)) {
              const before = usedNow();
              overflow = true;
              cut.push(hit);
              judge(it, false, 'budget-cut', loop, a.matched, tokens, { cost: total - before, left: Math.max(0, input.budget - before - 1) }, text);
              continue;
            }
            exact = total;
            pendingTok = 0;
            pendingN = 0;
          }
        }
        budgetText = next;
      } else {
        // An ignoreBudget entry skips the check, but its text joins the accepted text and so counts
        // against every entry after it (ST: acceptedContent = nextContent for every accepted entry).
        budgetText = `${budgetText}${text}\n`;
        if (finite) {
          pendingTok += tokens + 1;
          pendingN++;
        }
      }
      fired.push(hit);
      for (const g of it.groups) acceptedGroups.add(g);
      const detail = a.sticky ? { remaining: stickyLeft(timers, it.key, e.sticky) } : chance;
      judge(it, true, a.why, loop, a.matched, tokens, detail, text);
      // 5. Recursion feed.
      if (it.recursive && !e.preventRecursion && text) feed.push(text);
    }

    if (overflow || feed.length === 0) break;
    recursion.push(feed.join('\n'));
    // The last allowed loop fed text: say which entries it would have woken (explain only).
    if (loop === MAX_RECURSION && explain) {
      const recText = recursion.join('\n');
      for (const it of items) {
        if (done.has(it) || !it.recursive || it.entry.excludeRecursion || it.entry.constant) continue;
        const v = verdicts[it.src]?.[it.pos];
        if (!v || (v.why !== 'no-key-match' && v.why !== 'secondary-logic')) continue;
        const chat = chatText(it.scanDepth);
        const r = evaluate(it, chat ? `${chat}\n${recText}` : recText, true);
        if (r.ok) judge(it, false, 'no-key-match', MAX_RECURSION + 1, r.matched, undefined, { recursionLimit: MAX_RECURSION });
      }
    }
  }

  const used = !finite ? (budgetText ? input.count(budgetText) : 0) : usedNow();

  let verdictList: LoreVerdict[] | undefined;
  if (explain) {
    verdictList = [];
    const itemAt = new Map<string, Item>();
    for (const it of items) itemAt.set(`${it.src}:${it.pos}`, it);
    input.sources.forEach((source, s) => {
      source.book.entries.forEach((entry, pos) => {
        const it = itemAt.get(`${s}:${pos}`);
        let v = verdicts[s]?.[pos];
        if (!v) {
          // Every enabled entry is judged above; this only guards an impossible gap.
          v = { book: source.key, id: entry.id, fired: false, why: 'no-key-match', matched: [], loop: 0, tokens: input.count(entry.content) };
          if (input.rawCount) v.rawTokens = input.rawCount(entry.content);
          if (entry.title !== undefined) v.title = entry.title;
        }
        const errs = it ? errorsOf.get(it) : undefined;
        if (errs && errs.size > 0) {
          v.regexErrors = [...errs];
          // A key that failed to compile is the likely reason a key match failed.
          if (!v.fired && (v.why === 'no-key-match' || v.why === 'secondary-logic')) v.why = 'regex-error';
        }
        (verdictList as LoreVerdict[]).push(v);
      });
    });
  }

  return { fired, cut, used, regexErrors, ...(verdictList ? { verdicts: verdictList } : {}) };
}
