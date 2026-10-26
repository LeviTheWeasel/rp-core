// Ported from Bunraku:src/core/macros/{parse,normalize}.ts@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The macro lexer (ARCHITECTURE.md §10.4, D-43): {{name}} and {{name::arg::arg}} with nesting.
// Kept from Bunraku: the brace pair-scan, the depth-0 `::` split, args parsed as windows of one
// string so every node keeps absolute offsets ({{pick}} seeds on them), comments as one unsplit arg.
// Dropped: block forms (if/else, block setvar, block trim), dot/dollar shorthand and the offset map
// back to authored text (no editable preview in the core). Changed: an unclosed `{{` is literal and
// scanning resumes after it, so `{{ {{char}}` still expands {{char}}; the ST space and single-colon
// forms are read from the head of the call instead of regex-rewritten, so nested macros in their
// argument survive.

/** Escaped braces hide behind these until the block is finished (Bunraku's sentinels). */
export const ESC_OPEN = '\x01';
export const ESC_CLOSE = '\x02';
/** The bare {{trim}} marker; the whitespace around it collapses when the block is finished. */
export const TRIM_MARK = '\x04';

export interface TextNode {
  kind: 'text';
  value: string;
}

export interface MacroNode {
  kind: 'macro';
  /** The name as written (trimmed); lookup lowercases it. */
  name: string;
  /** Text between the braces, untrimmed: what isStructuralSlot sees. */
  body: string;
  args: Node[][];
  /** Absolute offsets of `{{` and one past `}}` in the parsed text. */
  start: number;
  end: number;
}

export interface CommentNode {
  kind: 'comment';
  start: number;
  end: number;
}

export type Node = TextNode | MacroNode | CommentNode;

/**
 * Pre-parse rewrites, ST order: escaped braces become sentinels, then the legacy angle tokens
 * (<USER>, <BOT>, <CHAR>, any case) become identity macros.
 */
export function normalize(text: string): string {
  let out = text;
  if (out.includes('\\{') || out.includes('\\}')) out = out.replace(/\\\{/g, ESC_OPEN).replace(/\\\}/g, ESC_CLOSE);
  if (out.includes('<')) out = out.replace(/<(user|bot|char)>/gi, (_m, w: string) => (w.toLowerCase() === 'user' ? '{{user}}' : '{{char}}'));
  return out;
}

/**
 * Remove {{trim}} markers with the line breaks around them (ST's `(?:\r?\n)*{{trim}}(?:\r?\n)*`:
 * spaces stay, so `a {{trim}} b` keeps both words apart) and put escaped braces back. Run once per
 * finished text.
 */
export function finish(text: string): string {
  let out = text;
  if (out.includes(TRIM_MARK)) out = out.replace(/(?:\r?\n)*\x04(?:\r?\n)*/g, '');
  if (out.includes(ESC_OPEN) || out.includes(ESC_CLOSE)) out = out.replaceAll(ESC_OPEN, '{').replaceAll(ESC_CLOSE, '}');
  return out;
}

/**
 * Every `{{` in [from, to) mapped to the first `}` of the `}}` closing it, in one linear pass. The
 * pairs are tokenized greedily left to right and matched with a stack, which gives exactly what
 * matchClose finds for each `{{` the parser tries (they all sit on this tokenization), without
 * rescanning to the end of the text for every unclosed `{{`: a block full of unmatched braces costs
 * O(n), not O(n²). Unmatched `{{` have no entry.
 */
export function braceMatches(text: string, from: number, to: number): Map<number, number> {
  const out = new Map<number, number>();
  const stack: number[] = [];
  let i = from;
  while (i < to - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      stack.push(i);
      i += 2;
    } else if (text[i] === '}' && text[i + 1] === '}') {
      const open = stack.pop();
      if (open !== undefined) out.set(open, i);
      i += 2;
    } else {
      i++;
    }
  }
  return out;
}

/** Index of the first `}` of the `}}` closing the `{{` at `open`, or -1 (Bunraku's pair-scan). */
export function matchClose(text: string, open: number, to: number): number {
  let depth = 0;
  let i = open;
  while (i < to - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++;
      i += 2;
    } else if (text[i] === '}' && text[i + 1] === '}') {
      depth--;
      if (depth === 0) return i;
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

interface Range {
  start: number;
  end: number;
}

/**
 * Split [from, to) on `::` at brace depth 0. The depth counter is never floored, as in Bunraku and
 * RoleCall: a stray `}}` hides later separators until the braces rebalance.
 */
function splitArgs(text: string, from: number, to: number): Range[] {
  const parts: Range[] = [];
  let depth = 0;
  let partStart = from;
  for (let i = from; i < to; i++) {
    const c = text[i];
    const n = i + 1 < to ? text[i + 1] : undefined;
    if (c === '{' && n === '{') {
      depth++;
      i++;
    } else if (c === '}' && n === '}') {
      depth--;
      i++;
    } else if (c === ':' && n === ':' && depth === 0) {
      parts.push({ start: partStart, end: i });
      partStart = i + 2;
      i++;
    }
  }
  parts.push({ start: partStart, end: to });
  return parts;
}

function trimRange(text: string, r: Range): Range {
  let a = r.start;
  let b = r.end;
  while (a < b && /\s/.test(text.charAt(a))) a++;
  while (b > a && /\s/.test(text.charAt(b - 1))) b--;
  return { start: a, end: b };
}

/** First index in [from, to) at brace depth 0 where `test` holds, or -1. */
function findAtDepth0(text: string, from: number, to: number, test: (c: string) => boolean): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = text.charAt(i);
    if (c === '{' && text[i + 1] === '{') {
      depth++;
      i++;
    } else if (c === '}' && text[i + 1] === '}') {
      depth--;
      i++;
    } else if (depth === 0 && test(c)) {
      return i;
    }
  }
  return -1;
}

/**
 * ST/RoleCall short forms (D-43): `{{roll 1d20}}`, `{{roll:d6}}`, `{{random:a,b}}`, `{{random a,b}}`,
 * `{{pick a,b}}`, `{{setvar x 5}}`. Value = how many args the rest splits into (1, or 2 for name +
 * value).
 */
const SPACE_FORMS: ReadonlyMap<string, number> = new Map([
  ['random', 1], ['pick', 1], ['roll', 1], ['getvar', 1], ['incvar', 1], ['decvar', 1], ['setvar', 2], ['addvar', 2],
]);
const COLON_FORMS: ReadonlyMap<string, number> = new Map([
  ['random', 1], ['pick', 1], ['roll', 1], ['getvar', 1], ['incvar', 1], ['decvar', 1], ['setvar', 2], ['addvar', 2],
]);

/** Re-read a head like `roll 1d20` as name `roll` + arg ranges; null when it is not a short form. */
function shortForm(text: string, head: Range): { name: string; args: Range[] } | null {
  // ST's legacy patterns allow one space before the colon and any after it: `{{random : a, b}}`.
  const m = /^([A-Za-z_]+)(\s?:\s*|\s+)(?=\S)/.exec(text.slice(head.start, head.end));
  if (!m) return null;
  const name = m[1] ?? '';
  const colon = (m[2] ?? '').includes(':');
  const arity = (colon ? COLON_FORMS : SPACE_FORMS).get(name.toLowerCase());
  if (arity === undefined) return null;
  const rest: Range = { start: head.start + m[0].length, end: head.end };
  if (arity === 1) return { name, args: [rest] };
  // Two-arg form: the first separator (space or `:`) outside nested braces ends the variable name.
  const sep = findAtDepth0(text, rest.start, rest.end, colon ? (c) => c === ':' : (c) => /\s/.test(c));
  if (sep === -1) return { name, args: [rest] };
  return { name, args: [{ start: rest.start, end: sep }, { start: sep + 1, end: rest.end }] };
}

/**
 * Args nested deeper than this are not parsed: the evaluator renders anything past depth 100 as ''
 * anyway, and an unbounded recursion here would let a pathological template overflow the stack.
 */
export const MAX_PARSE_DEPTH = 102;

/**
 * Parse the window [from, to) of `text` into nodes with absolute offsets. `matches` is the brace
 * map of an enclosing window (braceMatches); nested windows reuse it, since a pair inside them
 * never closes outside them, so a whole parse scans the text once.
 */
export function parseRange(text: string, from: number, to: number, depth = 0, matches?: Map<number, number>): Node[] {
  const pairs = matches ?? braceMatches(text, from, to);
  const nodes: Node[] = [];
  let pos = from;
  let textStart = from;
  const flushText = (end: number): void => {
    if (end > textStart) nodes.push({ kind: 'text', value: text.slice(textStart, end) });
  };

  while (pos < to) {
    const open = text.indexOf('{{', pos);
    if (open === -1 || open + 1 >= to) break;
    const close = pairs.get(open);
    if (close === undefined || close + 1 >= to) {
      // Unclosed: these two braces are text; a complete macro further on still counts.
      pos = open + 2;
      continue;
    }
    flushText(open);
    nodes.push(parseCall(text, open, close, depth, pairs));
    pos = close + 2;
    textStart = pos;
  }
  flushText(to);
  return nodes;
}

function parseCall(text: string, open: number, close: number, depth: number, pairs: Map<number, number>): Node {
  const inner: Range = { start: open + 2, end: close };
  const trimmed = trimRange(text, inner);
  const end = close + 2;
  // {{// anything}}: one unsplit body that is never evaluated, so macros inside a comment do nothing.
  if (text.startsWith('//', trimmed.start)) return { kind: 'comment', start: open, end };

  const ranges = splitArgs(text, inner.start, inner.end);
  const head = trimRange(text, ranges[0] ?? inner);
  let name = text.slice(head.start, head.end);
  let argRanges = ranges.slice(1);
  if (argRanges.length === 0) {
    const short = shortForm(text, head);
    if (short) {
      name = short.name;
      argRanges = short.args;
    }
  }
  return {
    kind: 'macro',
    name,
    body: text.slice(inner.start, inner.end),
    args: argRanges.map((r): Node[] =>
      depth < MAX_PARSE_DEPTH ? parseRange(text, r.start, r.end, depth + 1, pairs) : [{ kind: 'text', value: text.slice(r.start, r.end) }],
    ),
    start: open,
    end,
  };
}

/** Whole-text parse. `text` must already be normalized. */
export const parse = (text: string): Node[] => parseRange(text, 0, text.length);
