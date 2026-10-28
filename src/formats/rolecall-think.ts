// Ported from RoleCall:apps/rc/src/lib/ai/thinking-tags.ts@fb8dc623e (splitThinkingFromContent's
// Auto path and everything it calls: extractThinkingBlocks, findInlineThinkingTerminator with its
// narration boundaries, extractSpecialDelimiterBlocks, extractMarkerReasoningBlock, findCodeRanges,
// stripOrphanReasoningTags, isLikelyCotTagName, extractPresetCoTTag and their tables).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RoleCall's inline reasoning splitter (.notes/rcimport-decisions.md D-188): RoleCall strips these
// blocks from every history message it sends (prompt-assembly.ts, stripThinkingTags), so an imported
// answer keeps exactly the text RoleCall sent as history and the stripped part as a reasoning block.
// The rules are RoleCall's, unchanged:
// - an opening tag whose name looks like reasoning (the listed tags, look-alike names, the extra tags
//   the caller adds) opens a block; the matching closer (nesting counted) closes it;
// - an UNCLOSED opener ends at the earliest terminator RoleCall recognises (a partial closer such as
//   `</thi`, an <answer> tag, a "Response:" heading, an explicit end marker, a glued sentence end);
//   failing those, at the narration boundary (an action `*…` or a quote on a new line, glued narration,
//   a capitalised sentence glued to a full stop); failing those, at a reply that starts right away;
//   and failing everything it swallows the rest of the text (RoleCall's VVS-265 rule);
// - tags written inside markdown code (fences, backtick spans) are quoted, not emitted;
// - ◁think▷ and <|begin_of_thought|> delimiters, and a "Thinking:" … "Response:" heading pair when no
//   tag is found, are blocks too; a stray reasoning closer is dropped from the visible text.
// Port notes: only the Auto capture policy is ported, without a prefill and without saved captures.
// That is the call RoleCall makes on history when the chat has no "Catch thinking" setting, and the
// story export carries neither the setting's other modes in practice nor any message metadata.
// Linear time (a deviation in how, not in what; .notes/rcimport-decisions.md, robust#2): RoleCall's
// regexes backtrack quadratically on some texts (`<` before a long run of spaces, `<a ` repeated with
// no `>`, long runs of newlines or letters), and its loops rescan the rest of the text for every
// unclosed opener. Here the tag tokens are found by a hand-written scanner, the closer of an opener
// is looked up in a running-depth index, each terminator search remembers its last answer (the
// openers come in text order), word counts read a precomputed index, and the blocks are cut out in
// one pass. The results are the regexes' and loops' results; RoleCall's own thinking-tags tests pass
// on this file, and a comparison against RoleCall's file on generated texts agrees.

/** Tag names always treated as model reasoning wrappers (RoleCall's ALWAYS_CAPTURED_REASONING_TAGS). */
export const ALWAYS_CAPTURED_REASONING_TAGS: readonly string[] = Object.freeze([
  'think',
  'thinking',
  'thought',
  'reasoning',
  'planning',
  'plan',
  'cot',
  'analysis',
  'reflection',
  'deliberate',
  'deliberation',
  'rationale',
  'brainstorm',
  'internal',
  'scratchpad',
  'scratch',
  'scratchwork',
  'scratchnotes',
  'chain_of_thought',
  'chain-of-thought',
  'chain_of_reasoning',
  'chain-of-reasoning',
  'inner_thought',
  'inner_thoughts',
  'inner_reasoning',
  'internal_monologue',
  'internal_thought',
  'internal_thoughts',
  'internal_reasoning',
  'private_thought',
  'private_thoughts',
  'private_reasoning',
  'hidden_reasoning',
  'hidden_thoughts',
  'step_by_step',
  'thought_process',
  'thinking_process',
  'reasoning_process',
]);

/** How a block was caught (RoleCall's capture label; the Auto path gives these four). */
export type ReasoningCaptureVia = 'tag' | 'lookalike' | 'unclosed' | 'heading';

export interface ReasoningCaptureLabel {
  via: ReasoningCaptureVia;
  open?: string;
  close?: string;
}

export interface ThinkingBlockSpan {
  tag: string;
  raw: string;
  content: string;
  bracket: 'angle' | 'square' | 'marker';
  /** Closed by its closer or by a recognised terminator; false only when it swallowed the rest. */
  closed: boolean;
  startIndex: number;
  endIndex: number;
  capture: ReasoningCaptureLabel;
}

export interface SplitThinkingResult {
  /** The blocks' text joined by a blank line, or null when nothing was caught. */
  reasoning: string | null;
  /** What RoleCall sends as history. */
  visibleContent: string;
  blocks: ThinkingBlockSpan[];
}

const HTML_TAG_DENYLIST = new Set([
  'a',
  'article',
  'b',
  'blockquote',
  'body',
  'br',
  'button',
  'code',
  'details',
  'div',
  'em',
  'font',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'i',
  'img',
  'input',
  'label',
  'li',
  'link',
  'main',
  'meta',
  'ol',
  'option',
  'p',
  'path',
  'pre',
  'script',
  'section',
  'select',
  'span',
  'strong',
  'style',
  'summary',
  'svg',
  'table',
  'tbody',
  'td',
  'textarea',
  'th',
  'thead',
  'tr',
  'ul',
]);

const COT_COMPOUND_FORMS = new Set([
  'chainofthought',
  'chainofreasoning',
  'chainofthoughts',
  'innerthought',
  'innerthoughts',
  'innerreasoning',
  'internalmonologue',
  'internalthought',
  'internalthoughts',
  'internalreasoning',
  'modelthought',
  'modelthinking',
  'privatethought',
  'privatethoughts',
  'privatereasoning',
  'hiddenreasoning',
  'hiddenthoughts',
  'scratchpad',
  'scratchwork',
  'scratchnotes',
  'stepbystep',
  'thoughtprocess',
  'thinkingprocess',
  'reasoningprocess',
]);

const COT_ANCHOR_TERMS = [
  'think',
  'thinking',
  'thought',
  'thoughts',
  'reason',
  'reasoning',
  'rationale',
  'analysis',
  'reflection',
  'planning',
  'plan',
  'cot',
  'scratch',
  'scratchpad',
  'deliberation',
];

// ---- characters ----------------------------------------------------------------------------------

const SPACE_RE = /\s/;

/** JS `\s` (what the replaced regexes read as a space); NaN (past the end) is none. */
function isSpace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  return code >= 128 && SPACE_RE.test(String.fromCharCode(code));
}

/** ASCII letter. */
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** JS `\w` (ASCII without the u flag). */
const isWordCode = (c: number): boolean => isLetter(c) || (c >= 48 && c <= 57) || c === 95;
/** A tag name character, `[a-zA-Z0-9_-]`. */
const isNameCode = (c: number): boolean => isWordCode(c) || c === 45;

/** The first index at or after `i` that is not a JS space. */
function skipSpaces(text: string, i: number): number {
  while (isSpace(text.charCodeAt(i))) i++;
  return i;
}

/** Whether `lower` (ASCII, lower case) is at `at`, read as a non-unicode `/i` regex reads it: ASCII letters only. */
function asciiAt(text: string, at: number, lower: string): boolean {
  if (at + lower.length > text.length) return false;
  for (let k = 0; k < lower.length; k++) {
    let c = text.charCodeAt(at + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lower.charCodeAt(k)) return false;
  }
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first index whose value is >= `x` in an ascending list (`list.length` when none). */
function lowerBound(list: readonly number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A membership test for [start, end) spans: merged, then searched by halves. */
function spanTest(spans: readonly { start: number; end: number }[]): (index: number) => boolean {
  const merged: { start: number; end: number }[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.end <= s.start) continue;
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  const starts = merged.map((s) => s.start);
  return (index) => {
    const i = lowerBound(starts, index + 1) - 1;
    return i >= 0 && index < merged[i]!.end;
  };
}

// ---- tag names -----------------------------------------------------------------------------------

interface TagToken {
  tag: string;
  bracket: 'angle' | 'square';
  closing: boolean;
  startIndex: number;
  endIndex: number;
}

/**
 * Every tag token of `text` in order of start, overlapping ones included: at each `<` and `[` the
 * token RoleCall's THINKING_TAG_TOKEN_RE matches there,
 * /<\s*(\/+)?\s*([a-zA-Z][a-zA-Z0-9_-]*)\b[^>]*>|\[\s*(\/+)?\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\]/.
 * The regex backtracks between its two `\s*` and reads `[^>]*` to the end for every `<` that has no
 * `>` after it; this reads each character once. Names are lower-cased (sanitizeTagName). The
 * stretch after a `<` or `[` that a token's name and spaces take holds no other `<` or `[`.
 */
function tagCandidates(text: string): TagToken[] {
  const out: TagToken[] = [];
  let gt = -2; // the first '>' at or after the last position asked; -1: there is none
  const nextGt = (from: number): number => {
    if (gt === -1 || gt >= from) return gt;
    gt = text.indexOf('>', from);
    return gt;
  };
  for (let i = 0; i < text.length; i++) {
    const open = text.charCodeAt(i);
    if (open !== 60 && open !== 91) continue; // '<', '['
    let j = skipSpaces(text, i + 1);
    const slashes = j;
    while (text.charCodeAt(j) === 47) j++;
    const closing = j > slashes;
    if (closing) j = skipSpaces(text, j);
    if (!isLetter(text.charCodeAt(j))) continue;
    const nameStart = j;
    for (j++; isNameCode(text.charCodeAt(j)); j++);
    let nameEnd = j;
    let end: number;
    if (open === 60) {
      // `\b` after the name: a name ending in '-' gives the '-' back to `[^>]*`.
      while (text.charCodeAt(nameEnd - 1) === 45) nameEnd--;
      const g = nextGt(nameEnd);
      if (g < 0) continue;
      end = g + 1;
    } else {
      const k = skipSpaces(text, j);
      if (text.charCodeAt(k) !== 93) continue; // ']'
      end = k + 1;
    }
    out.push({ tag: text.slice(nameStart, nameEnd).toLowerCase(), bracket: open === 60 ? 'angle' : 'square', closing, startIndex: i, endIndex: end });
  }
  return out;
}

/** The index of the first candidate starting at or after `pos` (-1: none). */
function firstCandidate(starts: readonly number[], pos: number): number {
  const i = lowerBound(starts, pos);
  return i < starts.length ? i : -1;
}

/** The tokens a global scan of the token regex meets from 0: each next one starts where the last ended. */
function tokenChain(cands: readonly TagToken[], starts: readonly number[]): TagToken[] {
  const out: TagToken[] = [];
  for (let i = firstCandidate(starts, 0); i >= 0; i = firstCandidate(starts, cands[i]!.endIndex)) out.push(cands[i]!);
  return out;
}

/** `text` with the tokens `drop` picks removed (a global replace with the token regex). */
function removeTokens(text: string, drop: (t: TagToken) => boolean): string {
  const cands = tagCandidates(text);
  const chain = tokenChain(cands, cands.map((c) => c.startIndex));
  let out = '';
  let last = 0;
  for (const t of chain) {
    if (!drop(t)) continue;
    out += text.slice(last, t.startIndex);
    last = t.endIndex;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * The CoT tag a Start Reply With opens (`<plan>`, `[THINK]`), lower-cased, or null. RoleCall adds the
 * chat's own Start Reply With tag (its prefill guides) to the history split; the preset's assistant
 * prefill is not one of them.
 */
export function extractPresetCoTTag(prefill: string | undefined | null): string | null {
  if (!prefill) return null;
  // /<\s*([a-zA-Z][a-zA-Z0-9_-]*)\b[^>]*>/ first, then /\[\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\]/: the
  // first token without a slash of each bracket.
  const cands = tagCandidates(prefill).filter((t) => !t.closing);
  return (cands.find((t) => t.bracket === 'angle') ?? cands.find((t) => t.bracket === 'square'))?.tag ?? null;
}

function sanitizeTagName(tag: string): string | null {
  const normalized = tag.toLowerCase().trim();
  return normalized && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(normalized) ? normalized : null;
}

function normalizeTagShape(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitTagTokens(tag: string): string[] {
  return tag
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = Array<number>(rows * cols).fill(0);
  for (let i = 0; i < rows; i++) dp[i * cols] = i;
  for (let j = 0; j < cols; j++) dp[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i * cols + j] = Math.min(dp[(i - 1) * cols + j]! + 1, dp[i * cols + (j - 1)]! + 1, dp[(i - 1) * cols + (j - 1)]! + cost);
    }
  }
  return dp[a.length * cols + b.length]!;
}

function isSimilarCotTerm(value: string): boolean {
  if (COT_ANCHOR_TERMS.includes(value)) return true;
  if (value.length < 5) return false;
  return COT_ANCHOR_TERMS.some((term) => {
    if (term.length < 5) return false;
    // The distance is at least the length difference, and only 1 or 2 counts: a long name needs no table.
    if (Math.abs(value.length - term.length) > 2) return false;
    const distance = editDistance(value, term);
    return distance <= 1 || (Math.max(value.length, term.length) >= 8 && distance <= 2);
  });
}

function addConfiguredTags(set: Set<string>, extra?: string | readonly string[] | null): void {
  if (!extra) return;
  const list = typeof extra === 'string' ? [extra] : extra;
  for (const tag of list) {
    const normalized = sanitizeTagName(tag);
    if (normalized) set.add(normalized);
  }
}

function likelyCot(tagName: string, exactTags: ReadonlySet<string>): boolean {
  const normalized = sanitizeTagName(tagName);
  if (!normalized) return false;
  if (exactTags.has(normalized)) return true;
  const compact = normalizeTagShape(normalized);
  if (!compact || HTML_TAG_DENYLIST.has(compact)) return false;
  if (COT_COMPOUND_FORMS.has(compact)) return true;
  const longAnchor = COT_ANCHOR_TERMS.filter((term) => term.length >= 5).some((term) => compact.includes(term));
  if (longAnchor) return true;
  return splitTagTokens(normalized).some(isSimilarCotTerm);
}

/** Whether a tag name looks like a model's reasoning wrapper (by its name only, never its content). */
export function isLikelyCotTagName(tagName: string, extraTags?: string | readonly string[] | null): boolean {
  const exactTags = new Set<string>(ALWAYS_CAPTURED_REASONING_TAGS);
  addConfiguredTags(exactTags, extraTags);
  return likelyCot(tagName, exactTags);
}

/** isLikelyCotTagName and RoleCall's "listed" test for one call's extra tags, remembered per name. */
interface CotTags {
  isCot(tag: string): boolean;
  isListed(tag: string): boolean;
}

function cotTags(extraTags?: string | readonly string[] | null): CotTags {
  const exact = new Set<string>(ALWAYS_CAPTURED_REASONING_TAGS);
  addConfiguredTags(exact, extraTags);
  const seen = new Map<string, boolean>();
  return {
    isCot(tag) {
      let hit = seen.get(tag);
      if (hit === undefined) {
        hit = likelyCot(tag, exact);
        seen.set(tag, hit);
      }
      return hit;
    },
    isListed: (tag) => exact.has(tag.toLowerCase()),
  };
}

// ---- markdown code -------------------------------------------------------------------------------

interface CodeRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/** Opening or closing fence line: up to 3 spaces, then ``` or ~~~. */
const CODE_FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;

/**
 * Character ranges covered by markdown code: fenced blocks (an unclosed fence runs to the end) and
 * inline spans (a run of N backticks closed by a run of N). A tag in there is quoted, not emitted.
 */
function findCodeRanges(content: string): CodeRange[] {
  if (!content) return [];
  const fences: CodeRange[] = [];
  const fenceRe = new RegExp(CODE_FENCE_LINE_RE.source, 'gm');
  let fence: RegExpExecArray | null;
  let openAt: number | null = null;
  let openChar = '';
  let openLen = 0;
  while ((fence = fenceRe.exec(content)) !== null) {
    const marker = fence[1] ?? '';
    if (openAt === null) {
      openAt = fence.index;
      openChar = marker[0] ?? '';
      openLen = marker.length;
      continue;
    }
    // CommonMark: the closer uses the same character and is at least as long as the opener.
    if (marker[0] === openChar && marker.length >= openLen) {
      fences.push({ start: openAt, end: fence.index + fence[0].length });
      openAt = null;
    }
  }
  if (openAt !== null) fences.push({ start: openAt, end: content.length });

  // Fences are in text order and so are the backtick runs: one pointer walks both.
  const ranges = [...fences];
  let f = 0;
  const insideFence = (index: number): boolean => {
    while (f < fences.length && fences[f]!.end <= index) f++;
    return f < fences.length && index >= fences[f]!.start;
  };
  const tickRe = /`+/g;
  let tick: RegExpExecArray | null;
  let spanStart: number | null = null;
  let spanLen = 0;
  while ((tick = tickRe.exec(content)) !== null) {
    if (insideFence(tick.index)) continue;
    const len = tick[0].length;
    if (spanStart === null) {
      spanStart = tick.index;
      spanLen = len;
      continue;
    }
    if (len === spanLen) {
      ranges.push({ start: spanStart, end: tick.index + len });
      spanStart = null;
      spanLen = 0;
    }
  }
  // A backtick that never closes is a literal backtick, not a code span.
  return ranges.sort((a, b) => a.start - b.start);
}

/** Reasoning tag tokens that are part of no block (a lone `</think>`) are dropped; other markup stays. */
function stripOrphanReasoningTags(content: string, cot: CotTags): string {
  if (!content) return content;
  const inCode = spanTest(findCodeRanges(content));
  return removeTokens(content, (t) => !inCode(t.startIndex) && cot.isCot(t.tag));
}

function normalizeVisibleAfterThinkingRemoval(content: string): string {
  return content
    .replace(/^\s*<\s*answer\b[^>]*>/i, '')
    .replace(/<\s*\/\s*answer\s*>\s*$/i, '')
    .replace(/^\s*(?:NARRATION FOLLOWS|\{\{newline\}\})\s*/i, '')
    .replace(/^\s*(?:Response|Answer|Output|Result):[ \t]*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- the scans an unclosed opener needs ----------------------------------------------------------

/** Non-tag delimiters, matched literally and case-insensitively. */
const SPECIAL_REASONING_DELIMITERS = [
  { tag: 'think', open: '◁think▷', close: '◁/think▷' },
  { tag: 'thought', open: '<|begin_of_thought|>', close: '<|end_of_thought|>' },
] as const;

const EXPLICIT_REASONING_END_MARKERS = ['NARRATION FOLLOWS', '{{newline}}', 'END OF THINKING', 'CLOSING THINKING NOW'];

const TRANSITION_WORDS = '(?:Response|Answer|Output|Result):[ \\t]*\\n?';
/** RoleCall's RESPONSE_TRANSITION_RE, /\n{2,}(?:Response|Answer|Output|Result):[ \t]*\n?/i, tried at one place. */
const TRANSITION_AT = new RegExp(`\\n{2,}${TRANSITION_WORDS}`, 'iy');
/** …and searched: a match can only start where a newline run starts (every place in a run has the same rest). */
const TRANSITION_FROM = new RegExp(`(?<!\\n)\\n{2,}${TRANSITION_WORDS}`, 'gi');
/** The start of RoleCall's ANSWER_OPEN_TAG_RE, /<\s*answer\b[^>]*>/i: the `[^>]*>` is a test for a later '>'. */
const ANSWER_START_RE = /<\s*answer\b/gi;
/** Where RoleCall's NO_SPACE_REASONING_END_RE can start (its literal openings). */
const NO_SPACE_START_RE = /time to write\.|okay,|!vital!|end of thinking|closing thinking now/gi;
const NEWLINE_MARKER_RE = /\n[ \t]*(?=\*(?!\*|\s)|["“])/g;
const GLUED_NARRATION_RE = /[.!?…](?=(?:\*(?!\*)|["“])\S)/g;
const GENERIC_NO_SPACE_TRANSITION_RE = /[.!?](?=[A-Z][a-z]{2,}\s)/g;
/** RoleCall's MARKER_REASONING_SECTION_RE heading: /^\s*((?:Thoughts?|Thinking|Reasoning|Analysis):[ \t]*\n/. */
const MARKER_HEADING_RE = /(?:Thoughts?|Thinking|Reasoning|Analysis):[ \t]*\n/iy;

interface Hit {
  at: number;
  len: number;
}

interface Terminator {
  contentEnd: number;
  endIndex: number;
  closed: boolean;
}

/**
 * A text read once for the searches an unclosed opener makes. Each search answers "the first match
 * at or after `from`", and the openers come in text order, so a search remembers its last answer and
 * only reads further when `from` passes it: every part of the text is read a bounded number of times.
 * (A match of these patterns does not depend on where the search began, which is what makes the
 * remembered answer right; the one pattern whose start does, the transition, is tried at `from` first.)
 */
class TextScan {
  readonly text: string;
  private readonly last = new Map<string, { from: number; hit: Hit | null }>();
  private readonly partials = new Map<string, RegExp>();
  private lower?: string;
  private lowerFrom = 0;
  private lowerLen = 0;
  private lastGt?: number;
  private lastPunct?: number;
  private words?: { next: Int32Array; end: Int32Array };
  private stop = { from: -1, at: -1 };
  private readonly segments = new Map<number, { lo: number; best: number; dot: boolean }>();

  constructor(text: string) {
    this.text = text;
  }

  private remembered(key: string, from: number, search: (from: number) => Hit | null): Hit | null {
    const was = this.last.get(key);
    if (was && was.from <= from && (was.hit === null || was.hit.at >= from)) return was.hit;
    const hit = search(from);
    this.last.set(key, { from, hit });
    return hit;
  }

  private regexFrom(re: RegExp, from: number): RegExpExecArray | null {
    re.lastIndex = from;
    return re.exec(this.text);
  }

  /**
   * The earliest of the partial closers RoleCall tries (`</think`, `</thin`, … down to four
   * characters): every one starts with the shortest, so the shortest's first place is the earliest,
   * and the longest that fits there wins (it is listed first).
   */
  partialCloser(tag: string, from: number): Terminator | null {
    if (tag.length < 2) return null; // `</x>` has no partial of four characters or more
    const shortest = `</${tag.slice(0, 2)}`;
    const hit = this.remembered(`p${shortest}`, from, (f) => {
      let re = this.partials.get(shortest);
      if (!re) this.partials.set(shortest, (re = new RegExp(escapeRegex(shortest), 'gi')));
      const m = this.regexFrom(re, f);
      return m ? { at: m.index, len: 4 } : null;
    });
    if (!hit) return null;
    const full = `</${tag}`;
    let len = 4;
    while (len < full.length && asciiAt(this.text, hit.at + len, full[len]!)) len++;
    return { contentEnd: hit.at, endIndex: hit.at + len, closed: true };
  }

  answerTag(from: number): Hit | null {
    return this.remembered('answer', from, (f) => {
      const m = this.regexFrom(ANSWER_START_RE, f);
      if (!m) return null;
      // A later '>' closes this opening, or no later one is closed either.
      this.lastGt ??= this.text.lastIndexOf('>');
      return this.lastGt >= m.index + m[0].length ? { at: m.index, len: 0 } : null;
    });
  }

  transition(from: number): Hit | null {
    return this.remembered('transition', from, (f) => {
      TRANSITION_AT.lastIndex = f;
      const here = TRANSITION_AT.exec(this.text);
      if (here) return { at: here.index, len: here[0].length };
      const m = this.regexFrom(TRANSITION_FROM, f + 1);
      return m ? { at: m.index, len: m[0].length } : null;
    });
  }

  /**
   * RoleCall's explicit end marker, found in the lower-cased rest of the text: the index it finds
   * there is used as an index into the rest itself (RoleCall's own reading, kept). Lower-casing can
   * lengthen a text (İ becomes two characters); the lower-cased text is then mapped by position.
   */
  marker(marker: string, from: number): number | null {
    this.lower ??= this.text.toLowerCase();
    const lower = this.lower;
    let lowFrom = from;
    if (lower.length !== this.text.length) {
      if (from < this.lowerFrom) {
        this.lowerFrom = 0;
        this.lowerLen = 0;
      }
      this.lowerLen += this.text.slice(this.lowerFrom, from).toLowerCase().length;
      this.lowerFrom = from;
      lowFrom = this.lowerLen;
    }
    const needle = marker.toLowerCase();
    const hit = this.remembered(`m${needle}`, lowFrom, (f) => {
      const at = lower.indexOf(needle, f);
      return at < 0 ? null : { at, len: needle.length };
    });
    return hit ? from + (hit.at - lowFrom) + marker.length : null;
  }

  /** `[A-Z][a-z]{2,}\s` read case-insensitively at `q`: three or more ASCII letters, then a space. */
  private wordAhead(q: number): boolean {
    let k = q;
    while (isLetter(this.text.charCodeAt(k))) k++;
    return k - q >= 3 && isSpace(this.text.charCodeAt(k));
  }

  /** The first '\n' or '.' at or after `from` (the text's length when none). */
  private stopAfter(from: number): number {
    if (this.stop.from <= from && this.stop.at >= from) return this.stop.at;
    let i = from;
    for (; i < this.text.length; i++) {
      const c = this.text.charCodeAt(i);
      if (c === 10 || c === 46) break;
    }
    this.stop = { from, at: i };
    return i;
  }

  /**
   * `END OF THINKING[^\n.]*\.?` before the word test: the longest stretch wins, so the end is the '.'
   * that stops it (when a word follows), else the last place in the stretch where a word starts that
   * is followed by a space. Remembered per stretch end: openers in one long line share it.
   */
  private stretchEnd(e0: number): number | null {
    const stop = this.stopAfter(e0);
    let seg = this.segments.get(stop);
    if (!seg || seg.lo > e0) {
      let best = -1;
      let runEnd = -1;
      for (let q = stop - 1; q >= e0; q--) {
        if (!isLetter(this.text.charCodeAt(q))) {
          runEnd = -1;
          continue;
        }
        if (runEnd < 0) runEnd = q + 1;
        if (runEnd - q >= 3 && isSpace(this.text.charCodeAt(runEnd))) {
          best = q;
          break;
        }
      }
      seg = { lo: e0, best, dot: this.text.charCodeAt(stop) === 46 && this.wordAhead(stop + 1) };
      this.segments.set(stop, seg);
    }
    if (seg.dot) return stop + 1;
    return seg.best >= e0 ? seg.best : null;
  }

  /**
   * RoleCall's NO_SPACE_REASONING_END_RE, /(Time to write\.|Okay,\s*plan is set\.|!VITAL!\s*Output\.?|
   * END OF THINKING[^\n.]*\.?|CLOSING THINKING NOW[^\n.]*\.?)(?=[A-Z][a-z]{2,}\s)/i, without its
   * backtracking (quadratic on a long run of letters).
   */
  noSpaceEnd(from: number): Hit | null {
    return this.remembered('nospace', from, (f) => {
      const re = new RegExp(NO_SPACE_START_RE.source, 'gi');
      for (let m = this.regexFrom(re, f); m !== null; m = this.regexFrom(re, m.index + 1)) {
        const p = m.index;
        const lit = m[0].toLowerCase();
        let end: number | null = null;
        if (lit === 'time to write.') end = this.wordAhead(p + lit.length) ? p + lit.length : null;
        else if (lit === 'okay,') {
          const k = skipSpaces(this.text, p + lit.length);
          if (asciiAt(this.text, k, 'plan is set.') && this.wordAhead(k + 12)) end = k + 12;
        } else if (lit === '!vital!') {
          const k = skipSpaces(this.text, p + lit.length);
          if (asciiAt(this.text, k, 'output')) {
            if (this.text.charCodeAt(k + 6) === 46 && this.wordAhead(k + 7)) end = k + 7;
            else if (this.wordAhead(k + 6)) end = k + 6;
          }
        } else end = this.stretchEnd(p + lit.length);
        if (end !== null) return { at: p, len: end - p };
      }
      return null;
    });
  }

  newlineMarker(from: number): Hit | null {
    return this.remembered('newline', from, (f) => {
      const m = this.regexFrom(NEWLINE_MARKER_RE, f);
      return m ? { at: m.index, len: m[0].length } : null;
    });
  }

  gluedNarration(from: number): Hit | null {
    return this.remembered('glued', from, (f) => {
      const m = this.regexFrom(GLUED_NARRATION_RE, f);
      return m ? { at: m.index, len: 1 } : null;
    });
  }

  /** findGenericNoSpaceTransition: a `.Word ` with four words and a later sentence mark after it. */
  genericTransition(from: number): Hit | null {
    return this.remembered('generic', from, (f) => {
      if (this.lastPunct === undefined) {
        let i = this.text.length - 1;
        while (i >= 0 && !'.!?"'.includes(this.text[i]!)) i--;
        this.lastPunct = i;
      }
      for (let m = this.regexFrom(GENERIC_NO_SPACE_TRANSITION_RE, f); m !== null; m = this.regexFrom(GENERIC_NO_SPACE_TRANSITION_RE, m.index + 1)) {
        const after = m.index + 1;
        if (this.wordsIn(after, 4) >= 4 && this.lastPunct >= after) return { at: m.index, len: 1 };
      }
      return null;
    });
  }

  /**
   * How many matches of /\b[\w'-]+\b/g `text.slice(from)` holds, counted up to `cap`. A match runs
   * from a word boundary to the last word boundary of its run of word characters, quotes and hyphens;
   * the slice's own start is a boundary when a word character stands there.
   */
  wordsIn(from: number, cap: number): number {
    const text = this.text;
    const n = text.length;
    if (from >= n) return 0;
    if (!this.words) {
      const isRun = (c: number): boolean => isWordCode(c) || c === 39 || c === 45;
      const wordAt = (i: number): boolean => i >= 0 && i < n && isWordCode(text.charCodeAt(i));
      const end = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; ) {
        if (!isRun(text.charCodeAt(i))) {
          i++;
          continue;
        }
        const a = i;
        while (i < n && isRun(text.charCodeAt(i))) i++;
        let lastB = -1;
        for (let q = i; q > a; q--) {
          if (wordAt(q - 1) !== wordAt(q)) {
            lastB = q;
            break;
          }
        }
        for (let p = a; p < lastB; p++) end[p] = lastB;
      }
      const next = new Int32Array(n + 1).fill(-1);
      for (let p = n - 1; p >= 0; p--) next[p] = end[p]! >= 0 && wordAt(p - 1) !== wordAt(p) ? p : next[p + 1]!;
      this.words = { next, end };
    }
    const { next, end } = this.words;
    let count = 0;
    let e: number;
    if (isWordCode(text.charCodeAt(from))) {
      count = 1;
      e = end[from]!;
    } else e = from + 1;
    while (count < cap && e < n) {
      const p = next[e]!;
      if (p < 0) break;
      count++;
      e = end[p]!;
    }
    return count;
  }
}

/** Words a reasoning paragraph tends to start with; a reply starting with another capitalised word is narration. */
const LIKELY_REASONING_LEAD = new Set(['the', 'this', 'that', 'there', 'they', 'user', 'let', 'lets', 'need', 'okay', 'we']);

/** Where a reply starts right after `from` (relative to it), or null. */
function findLeadingVisibleReplyStart(scan: TextScan, from: number, tagAt: (index: number) => TagToken | undefined): number | null {
  const text = scan.text;
  const start = skipSpaces(text, from);
  if (start >= text.length) return null;
  const lead = start - from;
  const c = text[start];
  if ((c === '*' && text[start + 1] !== '*' && !isSpace(text.charCodeAt(start + 1))) || c === '"' || c === '“') return lead;
  // /^<\s*([a-zA-Z][a-zA-Z0-9_-]*)\b[^>]*>/: the angle token without a slash that starts here.
  const html = tagAt(start);
  if (html && html.bracket === 'angle' && !html.closing && HTML_TAG_DENYLIST.has(html.tag)) return lead;
  const sentence = /[A-Z][a-zA-Z'-]{2,}\b/y;
  sentence.lastIndex = start;
  const word = sentence.exec(text)?.[0];
  if (word !== undefined) {
    const firstWord = word.toLowerCase();
    if (firstWord !== 'i' && !LIKELY_REASONING_LEAD.has(firstWord)) return lead;
  }
  return null;
}

/**
 * Where narration most likely begins inside text an unclosed block swallowed (relative to `from`): a
 * new line starting with an action (`*…`, not `**` or a bullet) or a quote; narration glued onto a
 * sentence end (`draft.*The door`); a capitalised sentence glued onto a full stop. The earliest one
 * with at least three words after it wins; -1 when none is confident.
 */
function findNarrationBoundary(scan: TextScan, from: number): number {
  let boundary = -1;
  const consider = (idx: number): void => {
    if (idx <= 0) return;
    if (scan.wordsIn(from + idx, 3) < 3) return;
    if (boundary === -1 || idx < boundary) boundary = idx;
  };
  const newline = scan.newlineMarker(from);
  if (newline) consider(newline.at + newline.len - from);
  const glued = scan.gluedNarration(from);
  if (glued) consider(glued.at + 1 - from);
  const generic = scan.genericTransition(from);
  if (generic) consider(generic.at + 1 - from);
  return boundary;
}

/** The unclosed-block rule: the earliest terminator RoleCall recognises after an opener, or null. */
function findInlineThinkingTerminator(
  scan: TextScan,
  searchStart: number,
  opening: TagToken,
  tagAt: (index: number) => TagToken | undefined,
): Terminator | null {
  const candidates: Terminator[] = [];
  const partial = scan.partialCloser(opening.tag, searchStart);
  if (partial) candidates.push(partial);
  const answer = scan.answerTag(searchStart);
  if (answer) candidates.push({ contentEnd: answer.at, endIndex: answer.at, closed: true });
  const transition = scan.transition(searchStart);
  if (transition) candidates.push({ contentEnd: transition.at, endIndex: transition.at + transition.len, closed: true });
  for (const marker of EXPLICIT_REASONING_END_MARKERS) {
    const markerEnd = scan.marker(marker, searchStart);
    if (markerEnd !== null) candidates.push({ contentEnd: markerEnd, endIndex: markerEnd, closed: true });
  }
  const noSpace = scan.noSpaceEnd(searchStart);
  if (noSpace) candidates.push({ contentEnd: noSpace.at + noSpace.len, endIndex: noSpace.at + noSpace.len, closed: true });
  if (candidates.length === 0) {
    const boundaryIndex = findNarrationBoundary(scan, searchStart);
    if (boundaryIndex > 0) candidates.push({ contentEnd: searchStart + boundaryIndex, endIndex: searchStart + boundaryIndex, closed: true });
  }
  if (candidates.length === 0) {
    const leadingVisibleStart = findLeadingVisibleReplyStart(scan, searchStart, tagAt);
    if (leadingVisibleStart !== null) {
      candidates.push({ contentEnd: searchStart + leadingVisibleStart, endIndex: searchStart + leadingVisibleStart, closed: true });
    }
  }
  candidates.sort((a, b) => a.contentEnd - b.contentEnd);
  return candidates[0] ?? null;
}

/**
 * A "Thinking:" … "Response:" pair of headings with no tag: RoleCall's MARKER_REASONING_SECTION_RE,
 * /^\s*((?:Thoughts?|Thinking|Reasoning|Analysis):[ \t]*\n[\s\S]*?)\n{2,}(?:Response|Answer|Output|
 * Result):[ \t]*\n?([\s\S]*)$/i, as a heading test and the first transition after it (the regex is
 * quadratic on a long run of newlines).
 */
function extractMarkerReasoningBlock(content: string): ThinkingBlockSpan | null {
  const lead = skipSpaces(content, 0);
  MARKER_HEADING_RE.lastIndex = lead;
  const heading = MARKER_HEADING_RE.exec(content);
  if (!heading) return null;
  const transition = new TextScan(content).transition(lead + heading[0].length);
  if (!transition) return null;
  const rawReasoningSection = content.slice(lead, transition.at);
  const tail = content.slice(transition.at + transition.len);
  const visible = tail.trim();
  const reasoning = rawReasoningSection.replace(/^\s*(?:Thoughts?|Thinking|Reasoning|Analysis):[ \t]*\n/i, '').trim();
  if (reasoning.length < 10 || !visible) return null;
  const startIndex = 0;
  const endIndex = content.length - tail.length;
  const headingName = rawReasoningSection.match(/^\s*([^:\n]+):/)?.[1] ?? 'Reasoning';
  const raw = content.slice(startIndex, endIndex);
  const responseHeading = raw.match(/(Response|Answer|Output|Result):[ \t]*\n?$/i)?.[1] ?? 'Response';
  return {
    tag: headingName.toLowerCase(),
    raw,
    content: reasoning,
    bracket: 'marker',
    closed: true,
    startIndex,
    endIndex,
    capture: { via: 'heading', open: `${headingName}:`, close: `${responseHeading}:` },
  };
}

/** ◁think▷ and <|begin_of_thought|> blocks; an opener with no closer swallows the rest. */
function extractSpecialDelimiterBlocks(content: string): ThinkingBlockSpan[] {
  const blocks: ThinkingBlockSpan[] = [];
  for (const { tag, open, close } of SPECIAL_REASONING_DELIMITERS) {
    const openRe = new RegExp(escapeRegex(open), 'gi');
    const closeRe = new RegExp(escapeRegex(close), 'gi');
    let match: RegExpExecArray | null;
    while ((match = openRe.exec(content)) !== null) {
      const contentStart = match.index + match[0].length;
      closeRe.lastIndex = contentStart;
      const closeMatch = closeRe.exec(content);
      const contentEnd = closeMatch ? closeMatch.index : content.length;
      const endIndex = closeMatch ? contentEnd + closeMatch[0].length : content.length;
      blocks.push({
        tag,
        raw: content.slice(match.index, endIndex),
        content: content.slice(contentStart, contentEnd).trim(),
        bracket: 'marker',
        closed: !!closeMatch,
        startIndex: match.index,
        endIndex,
        capture: closeMatch ? { via: 'tag', open, close } : { via: 'unclosed', open },
      });
      if (!closeMatch) break;
      openRe.lastIndex = endIndex;
    }
  }
  return blocks.sort((a, b) => a.startIndex - b.startIndex);
}

function displayTagToken(token: TagToken): string {
  if (token.bracket === 'square') return token.closing ? `[/${token.tag.toUpperCase()}]` : `[${token.tag.toUpperCase()}]`;
  return token.closing ? `</${token.tag}>` : `<${token.tag}>`;
}

// ---- closers -------------------------------------------------------------------------------------

/** One key's tokens (bracket and name) in the order a walk meets them, with the walk's running depth. */
class DepthIndex {
  readonly tokens: TagToken[] = [];
  readonly starts: number[] = [];
  /** depth[i]: openers minus closers among the first i tokens. */
  readonly depth: number[] = [0];
  private byDepth?: Map<number, number[]>;

  add(t: TagToken): void {
    this.tokens.push(t);
    this.starts.push(t.startIndex);
    this.depth.push(this.depth[this.depth.length - 1]! + (t.closing ? -1 : 1));
  }

  /** The index of the first token starting at or after `pos` (tokens.length when none). */
  firstFrom(pos: number): number {
    return lowerBound(this.starts, pos);
  }

  /** The first token index >= `from` after which the depth is `v` (-1: none). The depth moves by one, so this is where it first gets there. */
  firstWithDepth(from: number, v: number): number {
    if (!this.byDepth) {
      this.byDepth = new Map();
      this.tokens.forEach((_, i) => {
        const d = this.depth[i + 1]!;
        const list = this.byDepth!.get(d);
        if (list) list.push(i);
        else this.byDepth!.set(d, [i]);
      });
    }
    const list = this.byDepth.get(v);
    if (!list) return -1;
    const i = lowerBound(list, from);
    return i < list.length ? list[i]! : -1;
  }
}

/**
 * The closer RoleCall's inner loop finds for each opener: from the opener it reads the token regex
 * on (the token after each token), counting the opener's own key up and its closers down, and stops at
 * zero. Read once per opener, that is quadratic for a text full of unclosed openers; here it is a
 * lookup. The walk from the end of an angle token is the global token walk from 0 (an angle token's
 * '>' cannot sit inside another token's span). From a square token the walk meets the square tokens
 * that follow, in order, up to the next angle token, then continues from that token's end.
 */
function closerIndex(cands: readonly TagToken[], starts: readonly number[]): (ci: number) => TagToken | null {
  const key = (t: TagToken): string => `${t.bracket}:${t.tag}`;
  const chain = new Map<string, DepthIndex>();
  for (const t of tokenChain(cands, starts)) {
    let d = chain.get(key(t));
    if (!d) chain.set(key(t), (d = new DepthIndex()));
    d.add(t);
  }
  const squares = new Map<string, DepthIndex>();
  const squareAt = new Int32Array(cands.length).fill(-1);
  const nextAngle = new Int32Array(cands.length).fill(-1);
  cands.forEach((t, i) => {
    if (t.bracket !== 'square') return;
    let d = squares.get(key(t));
    if (!d) squares.set(key(t), (d = new DepthIndex()));
    squareAt[i] = d.tokens.length;
    d.add(t);
  });
  for (let i = cands.length - 2; i >= 0; i--) nextAngle[i] = cands[i + 1]!.bracket === 'angle' ? i + 1 : nextAngle[i + 1]!;

  return (ci) => {
    const opener = cands[ci]!;
    const k = key(opener);
    let depth = 1;
    let from = opener.endIndex;
    if (opener.bracket === 'square') {
      const local = squares.get(k)!;
      const i = squareAt[ci]!;
      const angle = nextAngle[ci]!;
      const limit = angle >= 0 ? cands[angle]!.startIndex : Number.POSITIVE_INFINITY;
      const j = local.firstWithDepth(i + 1, local.depth[i]!);
      if (j >= 0 && local.starts[j]! < limit) return local.tokens[j]!;
      if (angle < 0) return null;
      depth = 1 + local.depth[local.firstFrom(limit)]! - local.depth[i + 1]!;
      from = cands[angle]!.endIndex;
    }
    const global = chain.get(k);
    if (!global) return null;
    const g = global.firstFrom(from);
    const j = global.firstWithDepth(g, global.depth[g]! - depth);
    return j >= 0 ? global.tokens[j]! : null;
  };
}

// ---- blocks --------------------------------------------------------------------------------------

/** Every reasoning block of `content`, in text order. */
export function extractThinkingBlocks(content: string, extraTags?: string | readonly string[] | null): ThinkingBlockSpan[] {
  return thinkingBlocks(content, cotTags(extraTags));
}

function thinkingBlocks(content: string, cot: CotTags): ThinkingBlockSpan[] {
  if (!content) return [];
  const specialBlocks = extractSpecialDelimiterBlocks(content);
  const inSpecial = spanTest(specialBlocks.map((s) => ({ start: s.startIndex, end: s.endIndex })));
  const inCode = spanTest(findCodeRanges(content));
  const cands = tagCandidates(content);
  const starts = cands.map((c) => c.startIndex);
  const tagAt = (index: number): TagToken | undefined => {
    const i = lowerBound(starts, index);
    return starts[i] === index ? cands[i] : undefined;
  };
  let closerOf: ((ci: number) => TagToken | null) | undefined;
  let scan: TextScan | undefined;
  const blocks: ThinkingBlockSpan[] = [];

  for (let ci = firstCandidate(starts, 0); ci >= 0; ) {
    const opening = cands[ci]!;
    // Tag tokens inside a special-delimiter span belong to that block; tags in code are quoted.
    if (opening.closing || !cot.isCot(opening.tag) || inSpecial(opening.startIndex) || inCode(opening.startIndex)) {
      ci = firstCandidate(starts, opening.endIndex);
      continue;
    }
    const contentStart = opening.endIndex;
    closerOf ??= closerIndex(cands, starts);
    const close = closerOf(ci);
    const terminator = close ? null : findInlineThinkingTerminator((scan ??= new TextScan(content)), contentStart, opening, tagAt);
    const endIndex = close?.endIndex ?? terminator?.endIndex ?? content.length;
    const contentEnd = close?.startIndex ?? terminator?.contentEnd ?? content.length;
    const capturedContent = removeTokens(content.slice(contentStart, contentEnd), () => true).trim();
    const openText = displayTagToken(opening);
    blocks.push({
      tag: opening.tag,
      raw: content.slice(opening.startIndex, endIndex),
      content: capturedContent,
      bracket: opening.bracket,
      closed: !!close || !!terminator?.closed,
      startIndex: opening.startIndex,
      endIndex,
      capture: !close
        ? { via: 'unclosed', open: openText }
        : cot.isListed(opening.tag)
          ? { via: 'tag', open: openText, close: displayTagToken(close) }
          : { via: 'lookalike', open: openText, close: displayTagToken(close) },
    });
    ci = firstCandidate(starts, endIndex);
  }

  if (specialBlocks.length === 0) return blocks;
  // A special block swallowed by a tag block's span (an unclosed <think> running to the end) is dropped:
  // overlapping spans would corrupt the index-based removal below.
  const inBlock = spanTest(blocks.map((b) => ({ start: b.startIndex, end: b.endIndex })));
  const independent = specialBlocks.filter((s) => !inBlock(s.startIndex));
  return [...blocks, ...independent].sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * `content` without the blocks, as RoleCall removes them one by one from the last to the first
 * (`slice(0, start) + slice(end)` on the text so far), built in one pass. Spans that overlap (the two
 * delimiter styles nested) come out as that loop leaves them.
 */
function removeBlocks(content: string, blocks: readonly ThinkingBlockSpan[]): string {
  let keep = content.length; // content[0, keep) is untouched so far
  const rest: { start: number; end: number }[] = []; // what follows it, as stretches of content; the last comes first
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { startIndex: s, endIndex: e } = blocks[i]!;
    if (e <= keep) {
      if (e < keep) rest.push({ start: e, end: keep });
    } else {
      let drop = e - keep;
      while (drop > 0 && rest.length > 0) {
        const top = rest[rest.length - 1]!;
        if (top.end - top.start <= drop) {
          drop -= top.end - top.start;
          rest.pop();
        } else {
          top.start += drop;
          drop = 0;
        }
      }
    }
    keep = Math.min(keep, s);
  }
  let out = content.slice(0, keep);
  for (let i = rest.length - 1; i >= 0; i--) out += content.slice(rest[i]!.start, rest[i]!.end);
  return out;
}

/**
 * RoleCall's split of a reply into reasoning and the visible text it sends as history (the Auto
 * policy; `extraTags` are the chat's own CoT tags, i.e. extractPresetCoTTag of its Start Reply With).
 */
export function splitThinkingFromContent(content: string, extraTags?: string | readonly string[] | null): SplitThinkingResult {
  if (!content) return { reasoning: null, visibleContent: content, blocks: [] };

  const cot = cotTags(extraTags);
  const blocks = thinkingBlocks(content, cot);
  const markerBlock = blocks.length === 0 ? extractMarkerReasoningBlock(content) : null;
  const allBlocks = markerBlock ? [markerBlock] : blocks;
  if (allBlocks.length === 0) {
    // No block, but a stray closer is still dropped; the text is otherwise verbatim (no trimming).
    return { reasoning: null, visibleContent: stripOrphanReasoningTags(content, cot), blocks };
  }

  const visibleContent = removeBlocks(content, allBlocks);
  const reasoning = allBlocks
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    reasoning: reasoning || null,
    // An unclosed block still swallows to the end of the text (RoleCall's VVS-265 rule).
    visibleContent: normalizeVisibleAfterThinkingRemoval(stripOrphanReasoningTags(visibleContent, cot)),
    blocks: allBlocks,
  };
}
