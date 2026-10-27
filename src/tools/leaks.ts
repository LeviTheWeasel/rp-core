// Ported from Bunraku:src/core/assembly/sanitize.ts (stripToolCallLeaks)@702d8120, itself a port of
// RoleCall:apps/rc/src/lib/ai/strip-tool-call-leaks.ts@fb8dc623e; DSML from
// RoleCall:apps/rc/src/lib/ai/dsml-tool-calls.ts@fb8dc623e (tag shapes in M1b, call recovery in M3);
// JSON salvage from RoleCall:apps/rc/src/lib/ai/narrator-engine/content-tool-salvage.ts@fb8dc623e (M3).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Leaked tool-call markup in prose (ARCHITECTURE.md §8.3 "Восстановление протечек", D-57). M1b: strip
// only, in post-processing (engine turn step 9). Turning complete calls into real calls arrives in M3.
// Port sources: Bunraku src/core/assembly/sanitize.ts stripToolCallLeaks; RoleCall
// apps/rc/src/lib/ai/strip-tool-call-leaks.ts, dsml-tool-calls.ts (formats only).
// CONTRACT FILE (M1b): signature is fixed; the prompt-m1b agent implements the body. M3 adds
// recoverLeaks at the end of the file (the tools-parse agent).
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

import { canonicalJson, looseJson } from './args.ts';
import { ARG_KEYS, balancedEnd, type BodyCall, callShape, findNameTagCalls, joinPieces, type OfferedTool, readCallBody, widenOverFence } from './prompted.ts';

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

// ---- M3: turning complete leaks into calls (§8.3, D-57) -------------------------------------------
// Ported from RoleCall:apps/rc/src/lib/ai/dsml-tool-calls.ts@fb8dc623e (parseInvocations,
// parseAttributes, readOpeningTag: DSML calls, fail-closed, 128 calls, 4 MiB) and
// RoleCall:apps/rc/src/lib/ai/narrator-engine/content-tool-salvage.ts@fb8dc623e (JSON calls of known
// tools in prose), both Coneja-Chibi. Changed: DSML is recovered per container span and gated on the
// tools offered, not on a "deepseek" model name; the salvage returns spans so the JSON leaves the
// text, keeps positions (RoleCall scanned a copy with fences replaced), takes a fenced or bare value
// only when every call in it names an offered tool, and dedupes by canonical arguments. New: the
// tag family through the prompted parser (tools/prompted.ts), Claude <function_calls>/<invoke>
// XML, <function=name>…</function> (Llama 3.1 JSON, Qwen3-coder <parameter=…>), [TOOL_REQUEST],
// Mistral [TOOL_CALLS] (array and name[ARGS]{…}), DeepSeek V3 and Kimi K2 special-token sections,
// and an offered tool's name used as a tag (D-97, read by tools/prompted.ts).

/** A call recovered from leaked markup in a reply's text. */
export interface RecoveredCall {
  name: string;
  /** Raw arguments text (tools/args.ts parses it). */
  args: string;
  /** Where it sat in the text. */
  start: number;
  end: number;
}

type Found = { name: string; args: string };

/** A complete tag span's name, attributes and body (the closer is the one the scan found). */
function tagBody(text: string, span: LeakSpan): { name: string; attrs: string; body: string } | null {
  TAG_OPEN_FULL.lastIndex = span.start;
  const m = TAG_OPEN_FULL.exec(text);
  if (m === null) return null;
  const name = m[1]!.toLowerCase();
  const attrs = m[2]!;
  const openEnd = span.start + m[0].length;
  if (attrs.trimEnd().endsWith('/')) return { name, attrs: attrs.trimEnd().slice(0, -1), body: '' };
  const closer = TAG_CLOSE_OF.get(name as (typeof TAG_NAMES)[number]);
  if (closer === undefined) return null;
  closer.lastIndex = openEnd;
  const c = closer.exec(text);
  if (c === null || c.index + c[0].length !== span.end) return null;
  return { name, attrs, body: text.slice(openEnd, c.index) };
}

/** `name="x"` among attributes. */
function attrName(attrs: string): string | undefined {
  const m = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  const v = m?.[1] ?? m?.[2];
  return v === undefined || v === '' ? undefined : v;
}

/** A plain body call list from tools/prompted.ts: all named and readable, or null. */
function readable(calls: readonly BodyCall[]): Found[] | null {
  if (calls.length === 0 || calls.some((c) => c.error !== undefined || c.name === null)) return null;
  return calls.map((c) => ({ name: c.name!, args: c.args }));
}

const XML_NS = '(?:[A-Za-z_][\\w.-]*:)?';
/** `<parameter name="p">v</parameter>` (Claude) or `<parameter=p>v</parameter>` (Qwen3-coder). */
const XML_PARAM = new RegExp(`\\s*<${XML_NS}parameter(?:\\s*=\\s*"?([A-Za-z_][\\w.-]*)"?|([^<>]*))>([\\s\\S]*?)</${XML_NS}parameter\\s*>`, 'y');
/** `<invoke name="x">…</invoke>`. */
const XML_INVOKE = new RegExp(`\\s*<${XML_NS}invoke([^<>]*)>([\\s\\S]*?)</${XML_NS}invoke\\s*>`, 'y');

/** A body made only of parameter elements → a JSON object of strings (values typed by tools/args.ts). */
function xmlParams(body: string): string | null {
  const out: Record<string, string> = {};
  let at = 0;
  for (;;) {
    XML_PARAM.lastIndex = at;
    const m = XML_PARAM.exec(body);
    if (m === null) break;
    const name = m[1] ?? attrName(m[2] ?? '');
    if (name === undefined || Object.hasOwn(out, name)) return null;
    // One line break around the value is layout (Qwen3-coder writes the value on its own line).
    out[name] = m[3]!.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    at = m.index + m[0].length;
  }
  return body.slice(at).trim() === '' ? JSON.stringify(out) : null;
}

/** A body made only of invoke elements (Claude <function_calls>). */
function xmlInvokes(body: string): Found[] | null {
  const calls: Found[] = [];
  let at = 0;
  for (;;) {
    XML_INVOKE.lastIndex = at;
    const m = XML_INVOKE.exec(body);
    if (m === null) break;
    const name = attrName(m[1]!);
    const args = xmlParams(m[2]!);
    if (name === undefined || args === null) return null;
    calls.push({ name, args });
    at = m.index + m[0].length;
  }
  return calls.length > 0 && body.slice(at).trim() === '' ? calls : null;
}

/** The tag family: <tool_call>, <tool_use>, <function_call>, <function=…>, <invoke>, <function_calls>. */
function tagCalls(text: string, span: LeakSpan): Found[] | null {
  const tag = tagBody(text, span);
  if (tag === null) return null;
  switch (tag.name) {
    case 'tool_call':
    case 'tool_use':
    case 'function_call':
      return readable(readCallBody(tag.body, attrName(tag.attrs), true));
    case 'function': {
      // <function=name> (Llama 3.1, Qwen3-coder) or <function name="x">; JSON or parameter elements inside.
      const name = /^\s*=\s*"?([A-Za-z_][\w.-]*)"?\s*$/.exec(tag.attrs)?.[1] ?? attrName(tag.attrs);
      if (name === undefined) return readable(readCallBody(tag.body, undefined, true));
      if (/^\s*</.test(tag.body)) {
        const args = xmlParams(tag.body);
        return args === null ? null : [{ name, args }];
      }
      return readable(readCallBody(tag.body, name, true));
    }
    case 'invoke': {
      const name = attrName(tag.attrs);
      const args = xmlParams(tag.body);
      return name === undefined || args === null ? null : [{ name, args }];
    }
    case 'function_calls':
      return xmlInvokes(tag.body);
    default:
      return null;
  }
}

// DSML (RoleCall dsml-tool-calls.ts), per container span, fail-closed.
const DSML_CANON = /<(\/?)(?:｜DSML｜|\|\|DSML\|\||\|DSML\|)(tool_calls|function_calls|invoke|parameter)(?=[\s>])/g;
const DSML_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DSML_TOOL_CALLS = 128;
const MAX_DSML_CONTENT_CHARS = 4 * 1024 * 1024;

const dsmlSkip = (s: string, k: number): number => {
  while (k < s.length && s[k]!.trim() === '') k++;
  return k;
};

/** RoleCall parseAttributes: name=value pairs in quotes, lowercased names, no duplicates. */
function dsmlAttributes(source: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let k = dsmlSkip(source, 0);
  while (k < source.length) {
    const nameStart = k;
    while (k < source.length && /[A-Za-z0-9_-]/.test(source[k]!)) k++;
    if (k === nameStart) return null;
    const name = source.slice(nameStart, k).toLowerCase();
    if (attributes.has(name)) return null;
    k = dsmlSkip(source, k);
    if (source[k] !== '=') return null;
    k = dsmlSkip(source, k + 1);
    const quote = source[k];
    if (quote !== '"' && quote !== "'") return null;
    const valueEnd = source.indexOf(quote, k + 1);
    if (valueEnd === -1) return null;
    attributes.set(name, source.slice(k + 1, valueEnd));
    k = dsmlSkip(source, valueEnd + 1);
  }
  return attributes;
}

/** RoleCall readOpeningTag. */
function dsmlOpening(source: string, start: number, name: 'invoke' | 'parameter'): { attributes: Map<string, string>; contentStart: number } | null {
  const prefix = `<DSML:${name}`;
  if (!source.startsWith(prefix, start)) return null;
  const boundary = source[start + prefix.length];
  if (boundary !== '>' && boundary?.trim() !== '') return null;
  const tagEnd = source.indexOf('>', start + prefix.length);
  if (tagEnd === -1) return null;
  const attributes = dsmlAttributes(source.slice(start + prefix.length, tagEnd));
  return attributes === null ? null : { attributes, contentStart: tagEnd + 1 };
}

/** RoleCall parseInvocations: invoke elements of typed parameters; any malformed piece → null. */
function dsmlInvocations(body: string): Found[] | null {
  const calls: Found[] = [];
  let k = dsmlSkip(body, 0);
  while (k < body.length) {
    if (calls.length >= MAX_DSML_TOOL_CALLS) return null;
    const invoke = dsmlOpening(body, k, 'invoke');
    if (invoke === null) return null;
    const invokeEnd = body.indexOf('</DSML:invoke>', invoke.contentStart);
    if (invokeEnd === -1) return null;
    const params = body.slice(invoke.contentStart, invokeEnd);
    const name = invoke.attributes.get('name') ?? null;
    if (name === null || !DSML_TOOL_NAME.test(name)) return null;
    const members: string[] = [];
    const seen = new Set<string>();
    let p = dsmlSkip(params, 0);
    while (p < params.length) {
      const param = dsmlOpening(params, p, 'parameter');
      if (param === null) return null;
      const paramEnd = params.indexOf('</DSML:parameter>', param.contentStart);
      if (paramEnd === -1) return null;
      const pname = param.attributes.get('name') ?? null;
      const flag = param.attributes.get('string')?.toLowerCase();
      if (pname === null || seen.has(pname) || (flag !== 'true' && flag !== 'false')) return null;
      const raw = params.slice(param.contentStart, paramEnd);
      if (raw.includes('<DSML:')) return null;
      if (flag === 'false') {
        const candidate = raw.trim();
        if (candidate === '') return null;
        try {
          JSON.parse(candidate);
        } catch {
          return null;
        }
        members.push(`${JSON.stringify(pname)}:${candidate}`);
      } else members.push(`${JSON.stringify(pname)}:${JSON.stringify(raw)}`);
      seen.add(pname);
      p = dsmlSkip(params, paramEnd + '</DSML:parameter>'.length);
    }
    calls.push({ name, args: `{${members.join(',')}}` });
    k = dsmlSkip(body, invokeEnd + '</DSML:invoke>'.length);
  }
  return calls.length > 0 ? calls : null;
}

/** A DSML container span (`tool_calls` / `function_calls`): its calls, or null (fail closed). */
function dsmlCalls(text: string, span: LeakSpan): Found[] | null {
  const raw = text.slice(span.start, span.end);
  if (raw.length > MAX_DSML_CONTENT_CHARS) return null;
  const canon = raw.replace(DSML_CANON, (_m, slash: string, tag: string) => `<${slash}DSML:${tag}`);
  const m = /^<DSML:(tool_calls|function_calls)>/.exec(canon);
  if (m === null) return null;
  const close = `</DSML:${m[1]}>`;
  if (!canon.endsWith(close)) return null;
  return dsmlInvocations(canon.slice(m[0].length, canon.length - close.length));
}

/** Mistral `[TOOL_CALLS]name[CALL_ID]id[ARGS]{…}` (v11+), with the name kept. */
const MISTRAL_NAMED_CALL = /\s*([A-Za-z0-9_.-]{1,64})(?:\[CALL_ID\][A-Za-z0-9_-]{1,64})?\[ARGS\]\s*/y;

/** Mistral `[TOOL_CALLS] [{…}]` or the named form. */
function mistralCalls(text: string, span: LeakSpan): Found[] | null {
  const at = span.start + '[TOOL_CALLS]'.length;
  MISTRAL_NAMED_CALL.lastIndex = at;
  const named = MISTRAL_NAMED_CALL.exec(text);
  if (named !== null) return [{ name: named[1]!, args: text.slice(at + named[0].length, span.end) }];
  const parsed = looseJson(text.slice(at, span.end));
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return null;
  const list = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const calls: Found[] = [];
  for (const item of list) {
    const shape = callShape(item, false);
    if (shape === undefined || shape.name === null) return null;
    calls.push({ name: shape.name, args: shape.args });
  }
  return calls.length > 0 ? calls : null;
}

/** DeepSeek V3: `<｜tool▁call▁begin｜>function<｜tool▁sep｜>name\n```json\n{…}\n```<｜tool▁call▁end｜>`. */
const DEEPSEEK_CALL = /<｜tool▁call▁begin｜>\s*(?:function)?\s*<｜tool▁sep｜>\s*([A-Za-z_][\w.-]{0,63})\s*([\s\S]*?)<｜tool▁call▁end｜>/g;
/** Kimi K2: `<|tool_call_begin|>functions.name:0<|tool_call_argument_begin|>{…}<|tool_call_end|>`. */
const KIMI_CALL = /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z_][\w-]{0,63})(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
const SECTION_MARKERS = /<｜tool▁calls▁begin｜>|<｜tool▁calls▁end｜>|<\|tool_calls_section_begin\|>|<\|tool_calls_section_end\|>/g;

/** The special-token sections: every call in the span, and nothing else but whitespace. */
function specialCalls(text: string, span: LeakSpan): Found[] | null {
  const raw = text.slice(span.start, span.end);
  const calls: Found[] = [];
  let rest = raw;
  for (const re of [DEEPSEEK_CALL, KIMI_CALL]) {
    for (const m of raw.matchAll(re)) {
      // The arguments may sit in a ```json fence (DeepSeek's template).
      const args = m[2]!.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
      calls.push({ name: m[1]!, args });
    }
    rest = rest.replace(re, '');
  }
  if (calls.length === 0 || rest.replace(SECTION_MARKERS, '').trim() !== '') return null;
  return calls;
}

/** The calls one complete leak span holds, or null when it does not parse. */
function spanCallsOf(text: string, span: LeakSpan): Found[] | null {
  switch (span.family) {
    case 'tag':
      return tagCalls(text, span);
    case 'dsml':
      return dsmlCalls(text, span);
    case 'tool_request': {
      const body = text.slice(span.start + '[TOOL_REQUEST]'.length, span.end - '[END_TOOL_REQUEST]'.length);
      return readable(readCallBody(body, undefined, true));
    }
    case 'tool_calls':
      return mistralCalls(text, span);
    case 'special':
      return specialCalls(text, span);
    default:
      return null;
  }
}

// JSON-in-prose salvage (RoleCall content-tool-salvage.ts), with spans.

/** RoleCall's fence pattern for salvage candidates. */
const SALVAGE_FENCE = /```(?:json|javascript|js)?\s*\n?([\s\S]*?)```/g;

/** The calls a salvage candidate holds; null unless the whole value is calls of offered tools. */
function salvageCalls(value: unknown, offered: ReadonlySet<string>): Found[] | null {
  const out: Found[] = [];
  const visit = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0 && v.every(visit);
    if (typeof v === 'object' && v !== null && Array.isArray((v as Record<string, unknown>)['tool_calls'])) {
      return visit((v as Record<string, unknown>)['tool_calls']);
    }
    const shape = callShape(v, true);
    if (shape === undefined || shape.name === null || !offered.has(shape.name)) return false;
    // RoleCall: an object, or a string that parses to an object.
    let args = shape.args;
    const raw = (v as Record<string, unknown>);
    const given = typeof raw['function'] === 'object' && raw['function'] !== null ? (raw['function'] as Record<string, unknown>)['arguments'] : ARG_KEYS.map((k) => raw[k]).find((x) => x !== undefined);
    if (typeof given === 'string') {
      try {
        const parsed = JSON.parse(given) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
      } catch {
        return false;
      }
    } else if (given === null || given === undefined) args = '{}';
    else if (typeof given !== 'object' || Array.isArray(given)) return false;
    out.push({ name: shape.name, args });
    return true;
  };
  return visit(value) ? out : null;
}

/** Fenced and bare JSON values outside `skip` spans, in text order, each with the calls it holds. */
function salvage(text: string, offered: ReadonlySet<string>, skip: readonly { start: number; end: number }[]): { start: number; end: number; calls: Found[] }[] {
  if (text.length < 8 || offered.size === 0 || ![...offered].some((n) => text.includes(n))) return [];
  const free = (a: number, b: number): boolean => !skip.some((s) => a < s.end && s.start < b);
  const found: { start: number; end: number; calls: Found[] }[] = [];
  const fences: { start: number; end: number }[] = [];
  for (const m of text.matchAll(SALVAGE_FENCE)) {
    const start = m.index;
    const end = start + m[0].length;
    fences.push({ start, end });
    if (!free(start, end)) continue;
    try {
      const calls = salvageCalls(JSON.parse(m[1]!.trim()) as unknown, offered);
      if (calls !== null) found.push({ start, end, calls });
    } catch {
      // not JSON
    }
  }
  // Bare values between the fences, left to right; an unbalanced opener ends the scan (RoleCall).
  const outside = (a: number): { start: number; end: number } | undefined => fences.find((f) => a >= f.start && a < f.end);
  for (let k = 0; k < text.length; ) {
    const c = text[k];
    if (c !== '{' && c !== '[') {
      k++;
      continue;
    }
    const fence = outside(k);
    if (fence !== undefined) {
      k = fence.end;
      continue;
    }
    const limit = fences.find((f) => f.start > k)?.start ?? text.length;
    const end = balancedEnd(text, k, limit);
    if (end < 0) break;
    // A value that parses is one unit, call or not (nothing inside it is a candidate of its own);
    // one that does not may still hold a call further in.
    let value: unknown;
    try {
      value = JSON.parse(text.slice(k, end)) as unknown;
    } catch {
      k++;
      continue;
    }
    const calls = free(k, end) ? salvageCalls(value, offered) : null;
    if (calls !== null) found.push({ start: k, end, calls });
    k = end;
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Recover leaked calls of OFFERED tools from a round's text (§8.3): every complete span of
 * findToolCallLeaks whose call parses and names an offered tool becomes a call; a span naming
 * anything else, an incomplete span, or one that does not parse is left for stripToolCallLeaks.
 * JSON-in-prose salvage (`{"name": "<offered>", "arguments"|"args": {…}}` outside any markup) runs
 * only when nativeCalls is 0 (a native round that returned no calls). Returns the calls in text order
 * and the text with the recovered spans removed (seams repaired as stripToolCallLeaks does).
 *
 * Details: with nativeCalls > 0 nothing is recovered (the markup echoes calls the server already
 * made; RoleCall's "no double execution"). A span with several calls is taken whole or not at all
 * (every call named and offered). A recovered span also takes a fence that wraps only it
 * (tools/prompted.ts widenOverFence). Salvaged JSON: fenced values first, then bare ones; the same
 * name and canonical arguments twice give one call (both spans leave the text).
 *
 * `tools` (D-97): the offered tools' specs. An offered tool's name used as a tag
 * (`<search_history>брат</search_history>`, tools/prompted.ts findNameTagCalls) is a complete span
 * of the tag family when its closer came (or it closed itself) and its body reads as a call; one
 * inside or around other markup is left to that markup. Name tags are never salvage ground (their
 * JSON is theirs). Without `tools`, exactly the leak families above.
 *
 * `keep`: ranges of the text the caller removes itself (a native round's prompted-family blocks,
 * which its stripper already kept out of the visible text). A recovered span inside one of them is
 * still a call, but stays in the returned text, so the caller's own strip removes it with its own
 * grouping and seams (removed one span at a time here, a run of adjacent blocks got another seam).
 */
export function recoverLeaks(
  text: string,
  opts: { offered: readonly string[]; nativeCalls: number; tools?: readonly OfferedTool[]; keep?: readonly { start: number; end: number }[] },
): { calls: RecoveredCall[]; text: string } {
  const offered = new Set(opts.offered);
  if (opts.nativeCalls > 0 || offered.size === 0 || !text) return { calls: [], text };
  const spans = findToolCallLeaks(text);
  const taken: { start: number; end: number; calls: Found[]; salvaged?: true }[] = [];
  let dsml = false;
  for (const span of spans) {
    if (!span.complete || span.residue) continue;
    const calls = spanCallsOf(text, span);
    if (calls === null || !calls.every((c) => offered.has(c.name))) continue;
    taken.push({ ...widenOverFence(text, span.start, span.end), calls });
    if (span.family === 'dsml') dsml = true;
  }
  const named = opts.tools === undefined ? [] : findNameTagCalls(text, opts.tools.filter((t) => offered.has(t.name)));
  for (const tag of named) {
    const { name, args, error } = tag.call;
    if (!tag.closed || error !== undefined || name === null) continue;
    if (spans.some((s) => s.start < tag.end && tag.start < s.end)) continue;
    taken.push({ ...widenOverFence(text, tag.start, tag.end), calls: [{ name, args }] });
  }
  // DeepSeek's end-of-sentence token goes with the DSML it trailed (as stripToolCallLeaks does).
  if (dsml) for (const span of spans) if (span.residue) taken.push({ start: span.start, end: span.end, calls: [] });
  for (const s of salvage(text, offered, named.length > 0 ? [...spans, ...named] : spans)) taken.push({ ...s, salvaged: true });
  if (taken.length === 0) return { calls: [], text };
  taken.sort((a, b) => a.start - b.start);

  const calls: RecoveredCall[] = [];
  const seen = new Set<string>();
  const pieces: string[] = [];
  let at = 0;
  for (const t of taken) {
    const start = Math.max(at, t.start);
    const kept = opts.keep?.some((k) => k.start <= start && t.end <= k.end) === true;
    for (const c of t.calls) {
      if (t.salvaged) {
        // RoleCall dedupes salvaged calls (the same JSON shown twice is one call).
        const parsed = looseJson(c.args);
        const key = `${c.name}\u0000${parsed.ok ? canonicalJson(parsed.value) : c.args}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      calls.push({ name: c.name, args: c.args, start, end: t.end });
    }
    if (kept) continue;
    pieces.push(text.slice(at, start));
    at = Math.max(at, t.end);
  }
  pieces.push(text.slice(at));
  return { calls, text: joinPieces(pieces) };
}
