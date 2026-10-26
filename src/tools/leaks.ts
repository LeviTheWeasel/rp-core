// Ported from Bunraku:src/core/assembly/sanitize.ts (stripToolCallLeaks)@702d8120, itself a port of
// RoleCall:apps/rc/src/lib/ai/strip-tool-call-leaks.ts@fb8dc623e; DSML tag shapes from
// RoleCall:apps/rc/src/lib/ai/dsml-tool-calls.ts@fb8dc623e (recognition only, no call recovery).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Leaked tool-call markup in prose (ARCHITECTURE.md §8.3 "Восстановление протечек", D-57). M1b: strip
// only, in post-processing (engine turn step 9). Turning complete calls into real calls arrives in M3.
// Port sources: Bunraku src/core/assembly/sanitize.ts stripToolCallLeaks; RoleCall
// apps/rc/src/lib/ai/strip-tool-call-leaks.ts, dsml-tool-calls.ts (formats only).
// CONTRACT FILE (M1b): signature is fixed; the prompt-m1b agent implements the body.
//
// Port notes. Kept from RoleCall/Bunraku: the five wrapper tags (tool_call, tool_use, function_call,
// function, invoke) with attributes, inner whitespace and any case; closed pairs matched lazily across
// lines; an unterminated opener strips through the end of the text (losing a cut-off call beats
// showing a literal tag); 3+ newlines left by a removal collapse to one blank line. Changed: one
// left-to-right scan over spans instead of a regex pass per tag, so nested markup goes with its outer
// block, nothing is matched twice and the work stays linear (RoleCall's lazy patterns are quadratic
// on a run of unclosed openers); a self-closing tag removes only itself (RoleCall strips to the end);
// stray closing tags are removed; whitespace is repaired only at the seams of a removal, never in
// untouched prose, and nothing is changed when nothing leaked. Added (§8.3): DSML containers in all
// three prefix spellings, <function_calls> wrappers, [TOOL_REQUEST]…[END_TOOL_REQUEST],
// Mistral [TOOL_CALLS] with a JSON payload or name[ARGS]{…}, and the DeepSeek V3 and Kimi K2
// special-token tool sections. findToolCallLeaks returns the spans, for M3's salvage.

/** Which markup a leak span is. */
export type LeakFamily = 'tag' | 'dsml' | 'tool_request' | 'tool_calls' | 'special';

/** One leaked span [start, end) of the text. `complete` is false for an unterminated tail or a stray closer. */
export interface LeakSpan {
  start: number;
  end: number;
  family: LeakFamily;
  complete: boolean;
  /** DeepSeek's end-of-sentence token, removed along with the DSML it trails; not a leak of its own. */
  residue?: true;
}

// ---- patterns -----------------------------------------------------------------------------------

/** Wrapper tags seen leaking into prose across providers (RoleCall VVS-257), plus Claude's <function_calls>. */
const TAG_NAMES = ['function_calls', 'function_call', 'function', 'tool_call', 'tool_use', 'invoke'] as const;
const TAG_ALT = TAG_NAMES.join('|');
/** An optional XML namespace before the tag name (`<ns:invoke>`). */
const NS = '(?:[A-Za-z_][\\w.-]*:)?';
/** Attributes of an opener: bounded and free of angle brackets, so a broken opener cannot run on. */
const ATTRS = '([^<>]{0,1024})';

const TAG_OPEN_AT = new RegExp(`<\\s*${NS}(?:${TAG_ALT})\\b`, 'gi');
const TAG_OPEN_FULL = new RegExp(`<\\s*${NS}(${TAG_ALT})\\b${ATTRS}>`, 'iy');
const TAG_CLOSE_AT = new RegExp(`<\\s*/\\s*${NS}(?:${TAG_ALT})\\s*>`, 'gi');
const TAG_CLOSE_OF = new Map(TAG_NAMES.map((n) => [n, new RegExp(`<\\s*/\\s*${NS}${n}\\s*>`, 'gi')]));

/** DeepSeek DSML tag prefixes: fullwidth bars, doubled ASCII bars, single ASCII bars. */
const DSML_PFX = '(?:｜DSML｜|\\|\\|DSML\\|\\||\\|DSML\\|)';
const DSML_NAMES = ['tool_calls', 'function_calls', 'invoke', 'parameter'] as const;
const DSML_ALT = DSML_NAMES.join('|');
const DSML_OPEN_AT = new RegExp(`<${DSML_PFX}(?:${DSML_ALT})(?=[\\s>/])`, 'g');
const DSML_OPEN_FULL = new RegExp(`<${DSML_PFX}(${DSML_ALT})(?=[\\s>/])${ATTRS}>`, 'y');
const DSML_CLOSE_AT = new RegExp(`</${DSML_PFX}(?:${DSML_ALT})\\s*>`, 'g');
const DSML_CLOSE_OF = new Map(DSML_NAMES.map((n) => [n, new RegExp(`</${DSML_PFX}${n}\\s*>`, 'g')]));
/** DeepSeek's end-of-sentence token, which a raw template leaves after a DSML block (removed with it). */
const DSML_EOS = /<｜end▁of▁sentence｜>/g;

/** Literal begin/end marker pairs: LM Studio's prompted format and model special-token sections. */
const MARKERS: readonly { open: string; close: string; family: LeakFamily }[] = [
  { open: '[TOOL_REQUEST]', close: '[END_TOOL_REQUEST]', family: 'tool_request' },
  { open: '<｜tool▁calls▁begin｜>', close: '<｜tool▁calls▁end｜>', family: 'special' }, // DeepSeek V3
  { open: '<｜tool▁call▁begin｜>', close: '<｜tool▁call▁end｜>', family: 'special' },
  { open: '<|tool_calls_section_begin|>', close: '<|tool_calls_section_end|>', family: 'special' }, // Kimi K2
  { open: '<|tool_call_begin|>', close: '<|tool_call_end|>', family: 'special' },
];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_OPEN_AT = new RegExp(MARKERS.map((m) => escapeRe(m.open)).join('|'), 'g');
const MARKER_CLOSE_AT = new RegExp(MARKERS.map((m) => escapeRe(m.close)).join('|'), 'g');

/** Mistral: `[TOOL_CALLS] [{…}]` (v3) or `[TOOL_CALLS]name[CALL_ID]id[ARGS]{…}` (v11+). */
const MISTRAL_AT = /\[TOOL_CALLS\]/g;
const MISTRAL_NAMED = /\s*[A-Za-z0-9_.-]{1,64}(?:\[CALL_ID\][A-Za-z0-9_-]{1,64})?\[ARGS\]\s*/y;

// ---- the scan -----------------------------------------------------------------------------------

type Kind = 'tagOpen' | 'tagClose' | 'dsmlOpen' | 'dsmlClose' | 'markerOpen' | 'markerClose' | 'mistral';

const FINDERS: readonly { kind: Kind; re: RegExp }[] = [
  { kind: 'tagOpen', re: TAG_OPEN_AT },
  { kind: 'tagClose', re: TAG_CLOSE_AT },
  { kind: 'dsmlOpen', re: DSML_OPEN_AT },
  { kind: 'dsmlClose', re: DSML_CLOSE_AT },
  { kind: 'markerOpen', re: MARKER_OPEN_AT },
  { kind: 'markerClose', re: MARKER_CLOSE_AT },
  { kind: 'mistral', re: MISTRAL_AT },
];

/** First match of a global regex at or after `from`, or null. */
function execFrom(re: RegExp, text: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(text);
}

/** End of a closing tag found from `from` with a per-name closer regex, or -1. */
function closerEnd(re: RegExp | undefined, text: string, from: number): number {
  if (re === undefined) return -1;
  const m = execFrom(re, text, from);
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * Index just past the JSON value that starts at `i` ('[' or '{'), or -1 when it never closes. Strings
 * are skipped with their escapes, so brackets inside them do not count. Linear.
 */
function jsonEnd(text: string, i: number): number {
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/**
 * The span an opener at `at` covers: through its closer, or through the end of the text when the
 * opener is cut off or never closed (complete: false).
 */
function openerSpan(kind: Kind, text: string, at: number, token: string): LeakSpan {
  const n = text.length;
  const tail = (family: LeakFamily): LeakSpan => ({ start: at, end: n, family, complete: false });
  switch (kind) {
    case 'tagOpen':
    case 'dsmlOpen': {
      const family: LeakFamily = kind === 'tagOpen' ? 'tag' : 'dsml';
      const full = kind === 'tagOpen' ? TAG_OPEN_FULL : DSML_OPEN_FULL;
      full.lastIndex = at;
      const m = full.exec(text);
      if (m === null) return tail(family); // the opener itself is cut off (or broken by a '<')
      const openEnd = at + m[0].length;
      if (m[2]!.trimEnd().endsWith('/')) return { start: at, end: openEnd, family, complete: true }; // <tool_call />
      const name = m[1]!.toLowerCase();
      const closer = kind === 'tagOpen' ? TAG_CLOSE_OF.get(name as (typeof TAG_NAMES)[number]) : DSML_CLOSE_OF.get(name as (typeof DSML_NAMES)[number]);
      const end = closerEnd(closer, text, openEnd);
      return end < 0 ? tail(family) : { start: at, end, family, complete: true };
    }
    case 'markerOpen': {
      const pair = MARKERS.find((p) => p.open === token)!;
      const close = text.indexOf(pair.close, at + token.length);
      return close < 0 ? tail(pair.family) : { start: at, end: close + pair.close.length, family: pair.family, complete: true };
    }
    case 'mistral': {
      let i = at + token.length;
      MISTRAL_NAMED.lastIndex = i;
      const named = MISTRAL_NAMED.exec(text);
      if (named !== null) i += named[0].length;
      else while (i < n && /\s/.test(text[i]!)) i++;
      const c = text[i];
      if (c !== '[' && c !== '{') {
        // The marker with no payload: a named call without one is cut off; a bare marker goes alone.
        return named !== null ? tail('tool_calls') : { start: at, end: at + token.length, family: 'tool_calls', complete: false };
      }
      const end = jsonEnd(text, i);
      return end < 0 ? tail('tool_calls') : { start: at, end, family: 'tool_calls', complete: true };
    }
    default:
      throw new Error(`leaks: ${kind} is not an opener`);
  }
}

/**
 * Every leaked tool-call span in `text`, in order and non-overlapping. One left-to-right pass: the
 * earliest token wins, an opener takes everything through its closer (nested markup included), a
 * closer with no opener is a stray of its own, and an opener that never closes takes the rest of
 * the text and ends the scan. Each finder's next match is cached, so the scan is linear.
 */
export function findToolCallLeaks(text: string): LeakSpan[] {
  const spans: LeakSpan[] = [];
  if (!text) return spans;
  const next: (RegExpExecArray | null | undefined)[] = FINDERS.map(() => undefined);
  let cursor = 0;
  let sawDsml = false;
  for (;;) {
    let best = -1;
    for (let f = 0; f < FINDERS.length; f++) {
      let m = next[f];
      if (m === undefined || (m !== null && m.index < cursor)) next[f] = m = execFrom(FINDERS[f]!.re, text, cursor);
      if (m != null && (best < 0 || m.index < next[best]!.index)) best = f;
    }
    if (best < 0) break;
    const m = next[best]!;
    const kind = FINDERS[best]!.kind;
    let span: LeakSpan;
    if (kind === 'tagClose' || kind === 'dsmlClose' || kind === 'markerClose') {
      const family: LeakFamily =
        kind === 'tagClose' ? 'tag' : kind === 'dsmlClose' ? 'dsml' : MARKERS.find((p) => p.close === m[0])!.family;
      span = { start: m.index, end: m.index + m[0].length, family, complete: false };
    } else span = openerSpan(kind, text, m.index, m[0]);
    if (span.family === 'dsml') sawDsml = true;
    spans.push(span);
    if (span.end >= text.length) break;
    cursor = span.end;
  }
  // DeepSeek's end-of-sentence token goes with the DSML it trails (RoleCall drops it from the visible
  // content whenever it recovered DSML); elsewhere it is left alone. Not counted as a leak.
  if (sawDsml) {
    const extra: LeakSpan[] = [];
    for (const e of text.matchAll(DSML_EOS)) {
      const at = e.index;
      if (!spans.some((s) => at >= s.start && at < s.end)) {
        extra.push({ start: at, end: at + e[0].length, family: 'dsml', complete: false, residue: true });
      }
    }
    if (extra.length > 0) return [...spans, ...extra].sort((a, b) => a.start - b.start);
  }
  return spans;
}

// ---- stripping ----------------------------------------------------------------------------------

/** Number of '\n' in s. */
function newlines(s: string): number {
  let k = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) k++;
  return k;
}

/**
 * The whitespace that joins two pieces of prose a removal brought together, from the whitespace
 * that ended the left one and began the right one. Within a line: one side's spaces (not both, so
 * no double space). Across lines: as many line breaks as the wider side had, at most one blank
 * line (RoleCall's 3+ → 2 collapse), followed by the right line's own indentation.
 */
function seam(left: string, right: string): string {
  const lines = Math.min(2, Math.max(newlines(left), newlines(right)));
  if (lines === 0) return left || right;
  const indent = right.includes('\n') ? right.slice(right.lastIndexOf('\n') + 1) : '';
  return '\n'.repeat(lines) + indent;
}

/**
 * Remove Hermes/Qwen <tool_call>…</tool_call>, DSML blocks, <function=…>…</function>, <invoke …>…</invoke>,
 * [TOOL_REQUEST]…[END_TOOL_REQUEST], [TOOL_CALLS] [...] and an unterminated tail of any of these at the
 * end of the text. Prose around them is kept; leftover blank-line runs are collapsed.
 *
 * `stripped` counts the removed leaks (blocks, stray closers, a cut-off tail). Whitespace is touched
 * only where something was removed: the seam keeps one side's spacing (see seam), and whitespace
 * left at the very start or end of the text by a removal there is dropped. Text with no leak is
 * returned unchanged.
 */
export function stripToolCallLeaks(text: string): { text: string; stripped: number } {
  const spans = findToolCallLeaks(text);
  if (spans.length === 0) return { text, stripped: 0 };
  const stripped = spans.filter((s) => !s.residue).length;

  // The prose between the spans, then glued back seam by seam.
  const pieces: string[] = [];
  let at = 0;
  for (const s of spans) {
    pieces.push(text.slice(at, s.start));
    at = s.end;
  }
  pieces.push(text.slice(at));

  let out = pieces[0]!;
  // Whitespace between two removals: it belongs to the seam after the next removal, not to `out`.
  let carry = '';
  for (let i = 1; i < pieces.length; i++) {
    const right = carry + pieces[i]!;
    carry = '';
    const leftBody = out.trimEnd();
    const rightBody = right.trimStart();
    if (leftBody === '') out = rightBody; // only whitespace before the removal: it opened the text
    else if (rightBody === '') {
      if (i === pieces.length - 1) out = leftBody; // only whitespace after the last removal: it closed the text
      else carry = right;
    } else out = leftBody + seam(out.slice(leftBody.length), right.slice(0, right.length - rightBody.length)) + rightBody;
  }
  return { text: out, stripped };
}
