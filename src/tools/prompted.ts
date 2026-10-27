// Ported from RoleCall:apps/rc/src/lib/ai/prompted-tool-calls/index.ts@fb8dc623e (the tolerant
// <tool_call> parser, the attribute-form opener, preCleanBody, the fence widening FENCE_BEFORE /
// FENCE_AFTER, the streaming stripper, the catalog entry format) and RoleCall:apps/rc/src/lib/ai/btw/
// loop.ts@fb8dc623e (flushedPromptedResults, the <tool_result> framing).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The prompted tool transport and the core block (ARCHITECTURE.md §8.3, §7.1). Results go back as
// one user message of <tool_result> blocks with the closing tag escaped in content.
// CONTRACT FILE (M3): signatures are fixed; the tools-parse agent implements the bodies.
//
// Port notes. Kept: the documented `{"name", "args"}` envelope, the attribute form `<tool_call
// name="x">` (single or double quotes, other attributes), self-closing tags, an unterminated opener
// or an unclosed block stripped to the end, preCleanBody (a leading `json`, a fence inside the tags),
// the fence widening (both fences or neither, same character, closer at least as long), the
// catalog's argument lines, the result frame `<tool_result name="…">\n…\n</tool_result>` joined by a
// blank line. Changed (see docs/PARITY-RC.md "Tool calls (M3)"): `arguments` / `parameters` are read
// (RoleCall read only `args`, so such calls ran with invented defaults); tags are matched in any case
// and with whitespace after '<', like tools/leaks.ts; a block left unclosed is accepted when the
// JSON inside is complete (at the end, or before the next opener), and one whose complete call
// value is followed by prose ends after the value, the prose kept (RoleCall erased it);
// `<tool_calls>` containers, array and NDJSON bodies and `{"tool_calls": […]}` give one block per
// call (RoleCall kept the first);
// the python-call body form names the call; one parse, the schema check is tools/args.ts's; a run of
// blocks with only whitespace between them is one removal and shares one fence; whitespace is
// repaired at the seams (tools/leaks.ts rules); a stray closer and anything from a hallucinated
// `<tool_result` on are removed too; the streaming stripper applies the same fence rule as the
// batch one, holds trailing whitespace and partial tags, and has end() (RoleCall never flushed its
// carry); the result frame carries the call id and escapes `</tool_result` in the text. The catalog
// text is rp-core's own (RoleCall's fenced its example, said extra fields were ignored and invited
// thinking out loud between blocks). Added (D-97, TD-21): an offered tool's name used as a tag is a
// call of that tool, found, read and stripped like a <tool_call> block.

import { looseJson, pythonCall, pythonCallEnd } from './args.ts';
import type { ToolSpec } from '../providers/types.ts';

/** §8.3: the stop sequence of a prompted round; the model must never write its own results. */
export const PROMPTED_STOP = '<tool_result';

// ---- the core block -----------------------------------------------------------------------------

/** What every core block says (§7.1): look things up first, never guess, never mention the tools. */
const PROTOCOL = [
  '## Looking things up',
  '',
  'You have tools that look up details which are not in front of you. Use them quietly:',
  '- When your reply depends on an earlier detail (a name, a number, a place, a promise, who said what) and you are not sure of it, look it up first, then write.',
  '- Never guess names, numbers or quotes. If a search finds nothing, keep the detail vague instead of inventing it.',
  "- Search by word roots and short forms, in the story's own language: one or two key words find more than a whole phrase.",
  '- Never mention tools, searches or results in the story. The reader sees only the story.',
].join('\n');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A prompted call block's tags, as every model-facing example writes them. */
const CALL_OPEN = '<tool_call>';
const CALL_CLOSE = '</tool_call>';

/**
 * A value as a call example writes JSON: `{"key": value, "key2": value2}` (a space after each colon
 * and comma, no line breaks), strings and other values as JSON.stringify writes them.
 */
function inlineJson(v: unknown): string {
  if (isRecord(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inlineJson(x)}`).join(', ')}}`;
  if (Array.isArray(v)) return `[${v.map(inlineJson).join(', ')}]`;
  return JSON.stringify(v);
}

/**
 * One prompted call as every model-facing example writes it: `<tool_call>{"name": "<name>", "args":
 * {…}}</tool_call>`. The core block's example line and the prompted reminder's call (D-96 amended,
 * prompt/assemble/gap.ts) are both built here, so the two cannot drift.
 */
export function promptedCallLine(name: string, args: Record<string, unknown>): string {
  return `${CALL_OPEN}${inlineJson({ name, args })}${CALL_CLOSE}`;
}

/** How to call in prompted mode (§8.3): the example is NOT in a fence, so it is not copied with one. */
const PROMPTED_CALLS = [
  '## How to call a tool',
  '',
  'Write each call as one block on a line of its own:',
  promptedCallLine('tool_name', { argument: 'value' }),
  '',
  '- One call per block. For several calls, write several blocks one after another.',
  '- "args" is a JSON object with the arguments listed for that tool below, and nothing else.',
  '- Write the block as plain text: no code fence, no quotes and no other markup around it.',
  '- After your calls, stop writing and wait. The results come back in the next message inside <tool_result> blocks; then continue your reply.',
  '- Only the tools listed below exist.',
].join('\n');

/** A schema's type in words: `string`, `integer | null`, `array of string`. */
function typeWords(prop: Record<string, unknown>): string {
  const t = prop['type'];
  const types = Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : typeof t === 'string' ? [t] : [];
  if (types.length === 0) return 'any';
  return types
    .map((name) => {
      if (name !== 'array') return name;
      const items = prop['items'];
      return isRecord(items) && items['type'] !== undefined ? `array of ${typeWords(items)}` : 'array';
    })
    .join(' | ');
}

/** The limits the validator checks, in words: `from 1 to 20`, `at most 200 characters`. */
function limitWords(prop: Record<string, unknown>): string[] {
  const num = (k: string): number | undefined => (typeof prop[k] === 'number' ? (prop[k] as number) : undefined);
  const out: string[] = [];
  const min = num('minimum');
  const max = num('maximum');
  if (min !== undefined && max !== undefined) out.push(`from ${min} to ${max}`);
  else if (min !== undefined) out.push(`at least ${min}`);
  else if (max !== undefined) out.push(`at most ${max}`);
  const maxLen = num('maxLength');
  if (maxLen !== undefined) out.push(`at most ${maxLen} characters`);
  const maxItems = num('maxItems');
  if (maxItems !== undefined) out.push(`at most ${maxItems} items`);
  return out;
}

/** RoleCall's renderParamsSchema line: `` - `k` (type, required) (one of: "a", "b") — description ``. */
function argumentLines(schema: Record<string, unknown>): string[] {
  const props = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : []);
  const keys = Object.keys(props);
  if (keys.length === 0) return ['- (no arguments: pass {})'];
  return keys.map((k) => {
    const prop = isRecord(props[k]) ? props[k] : {};
    const head = [typeWords(prop), required.has(k) ? 'required' : 'optional', ...limitWords(prop)].join(', ');
    const values = prop['enum'];
    const oneOf = Array.isArray(values) && values.length > 0 ? ` (one of: ${values.map((v) => JSON.stringify(v)).join(', ')})` : '';
    const desc = typeof prop['description'] === 'string' && prop['description'].trim() !== '' ? ` — ${prop['description'].trim()}` : '';
    return `- \`${k}\` (${head})${oneOf}${desc}`;
  });
}

/** One catalog entry: the name, the whole description, the arguments. */
function catalogEntry(tool: ToolSpec): string {
  return [`### \`${tool.name}\``, '', tool.description.trim(), '', 'Args:', ...argumentLines(tool.schema)].join('\n');
}

/**
 * The core block's text (§8.3, §7.1): one system message at the end of the leading run, present
 * whenever tools are offered. Always: a short protocol (English) — look things up first when an
 * earlier detail matters and you are not sure of it, then write; never guess names or quotes; never
 * mention tools, searches or results in the story; search by word roots and short forms. Prompted
 * only: how to call (`<tool_call>{"name": "…", "args": {…}}</tool_call>`, one call per block, the
 * example NOT in a code fence, no fences around blocks, the reply continues after the results come
 * back) and the catalog: one entry per tool with its description and its arguments from the schema
 * (top-level properties: type, required/optional, enum, description; array item types shown).
 * Deterministic for a given tool list (it sits in the cached prefix).
 *
 * The tools are listed in the order given (the request sorts them). No tools: ''.
 */
export function renderCoreBlock(tools: readonly ToolSpec[], transport: 'native' | 'prompted'): string {
  if (tools.length === 0) return '';
  if (transport === 'native') return PROTOCOL;
  return [PROTOCOL, PROMPTED_CALLS, ['## Tools', ...tools.map(catalogEntry)].join('\n\n')].join('\n\n');
}

// ---- finding the blocks -------------------------------------------------------------------------
// One scanner serves the parser, the batch stripper and the streaming stripper. In streaming mode
// (final = false) it stops at the first thing the text so far cannot decide and reports where that
// starts (`pending`); everything before is final whatever comes next.

/** The wrapper tags, and 'named': an offered tool's name used as a tag (D-97). */
type TagName = 'tool_call' | 'tool_calls' | 'tool_result' | 'named';
const TAG_NAMES: readonly Exclude<TagName, 'named'>[] = ['tool_call', 'tool_calls', 'tool_result'];

/**
 * D-97: an offered tool as the prompted parser needs it (a ToolSpec fits). Its name, in any case, is
 * a tag of its own: `<NAME …>BODY</NAME>` is one call of it.
 */
export type OfferedTool = Pick<ToolSpec, 'name' | 'schema'>;

/** The offered tools by lowercased name (the first of two names that differ only in case wins). */
type NameTags = ReadonlyMap<string, OfferedTool>;

/** A name that can be a tag: the wire's tool-name shape (providers/wire.ts SAFE_NAME). */
const TAG_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** Longest XML prefix or tool name the tag reader takes (SAFE_NAME's limit). */
const WORD_MAX = 64;

/**
 * The name tags of a tool list; undefined when there are none, so a caller without tools runs
 * exactly the wrapper-tag scanner. A name the wrapper tags already use keeps the wrapper meaning.
 */
function nameTags(tools: readonly OfferedTool[] | undefined): NameTags | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const map = new Map<string, OfferedTool>();
  for (const tool of tools) {
    const key = tool.name.toLowerCase();
    if (!TAG_TOOL_NAME.test(tool.name) || (TAG_NAMES as readonly string[]).includes(key) || map.has(key)) continue;
    map.set(key, tool);
  }
  return map.size > 0 ? map : undefined;
}
/** Whitespace allowed between '<', '/' and the tag name. */
const TAG_WS_MAX = 16;
/** An opener's attributes: at most this long and free of '<', else it is broken (runs to the end). */
const ATTR_MAX = 1024;
/** `name="x"` / `name='x'` among an opener's attributes (not `data-name`). */
const NAME_ATTR = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** Whitespace as String.prototype.trim and /\s/ see it (the common ASCII cases without a regex). */
const isWs = (c: string | undefined): boolean => {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  return code > 127 && /\s/.test(c);
};
const isNameChar = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** Index of the first non-whitespace at or after k (text.length when none). */
function skipWs(text: string, k: number): number {
  while (k < text.length && isWs(text[k])) k++;
  return k;
}

interface Tag {
  close: boolean;
  name: TagName;
  /** 'named': the offered tool (the same object for every spelling of its name). */
  tool?: OfferedTool;
  /** Index just past the name. */
  nameEnd: number;
}

/** A character of an XML prefix or a tool name: [A-Za-z0-9_.-]. */
const isWordChar = (code: number): boolean => isNameChar(code) || (code >= 48 && code <= 57) || code === 45 || code === 46;
/** A character of a tool name: [A-Za-z0-9_-]. */
const isToolChar = (code: number): boolean => isNameChar(code) || (code >= 48 && code <= 57) || code === 45;

/**
 * tagAt with name tags (D-97), from the name's first character at j: an optional XML prefix
 * (`ns:`), then a wrapper tag's name (no prefix) or an offered tool's name, any case. Streaming: the
 * text ending inside the first word is 'partial' whenever that word could still become a prefix or
 * a name (it starts with a letter or '_'); inside the name after a prefix, while it is the start of
 * an offered name.
 */
function namedTagAt(text: string, j: number, close: boolean, final: boolean, names: NameTags): Tag | 'partial' | null {
  const n = text.length;
  let k = j;
  while (k < n && k - j <= WORD_MAX && isWordChar(text.charCodeAt(k))) k++;
  if (k - j > WORD_MAX) return null;
  const word = text.slice(j, k).toLowerCase();
  const head = k > j && isNameChar(text.charCodeAt(j));
  if (k === n) {
    if (!final) return head ? 'partial' : null;
    // The text ends right after a full name: an opener cut there is unterminated; a cut closer is prose.
    const fixed = TAG_NAMES.find((x) => x === word);
    if (close) return null;
    if (fixed !== undefined) return { close, name: fixed, nameEnd: k };
    const tool = names.get(word);
    return tool !== undefined ? { close, name: 'named', tool, nameEnd: k } : null;
  }
  if (text[k] === ':' && head) {
    // An XML prefix: the tool's name follows it (the wrapper tags take none).
    const s = k + 1;
    let e = s;
    while (e < n && e - s <= WORD_MAX && isToolChar(text.charCodeAt(e))) e++;
    if (e - s > WORD_MAX) return null;
    const name = text.slice(s, e).toLowerCase();
    if (e === n) {
      if (!final) return [...names.keys()].some((x) => x.startsWith(name)) ? 'partial' : null;
      const tool = close ? undefined : names.get(name);
      return tool !== undefined ? { close, name: 'named', tool, nameEnd: e } : null;
    }
    const tool = names.get(name);
    if (tool === undefined) return null;
    const c = text[e]!;
    return c === '>' || isWs(c) || (!close && c === '/') ? { close, name: 'named', tool, nameEnd: e } : null;
  }
  const fixed = TAG_NAMES.find((x) => x === word);
  const tool = fixed === undefined ? names.get(word) : undefined;
  if (fixed === undefined && tool === undefined) return null;
  const c = text[k]!;
  if (!(c === '>' || isWs(c) || (!close && c === '/'))) return null;
  return fixed !== undefined ? { close, name: fixed, nameEnd: k } : { close, name: 'named', tool: tool!, nameEnd: k };
}

/** The tag whose '<' is at p, 'partial' when the text ends before that is known, else null. */
function tagAt(text: string, p: number, final: boolean, names?: NameTags): Tag | 'partial' | null {
  const n = text.length;
  let j = skipWs(text, p + 1);
  if (j - (p + 1) > TAG_WS_MAX) return null;
  if (j === n) return final ? null : 'partial';
  let close = false;
  if (text[j] === '/') {
    close = true;
    const k = skipWs(text, j + 1);
    if (k - (j + 1) > TAG_WS_MAX) return null;
    j = k;
    if (j === n) return final ? null : 'partial';
  }
  if (names !== undefined) return namedTagAt(text, j, close, final, names);
  let k = j;
  while (k < n && k - j <= 12 && isNameChar(text.charCodeAt(k))) k++;
  const word = text.slice(j, k).toLowerCase();
  if (k === n) {
    if (!final) return word.length <= 11 && TAG_NAMES.some((name) => name.startsWith(word)) ? 'partial' : null;
    // The text ends right after a full name: an opener cut there is unterminated; a cut closer is prose.
    const name = TAG_NAMES.find((x) => x === word);
    return name !== undefined && !close ? { close, name, nameEnd: k } : null;
  }
  const name = TAG_NAMES.find((x) => x === word);
  if (name === undefined) return null;
  const c = text[k]!;
  return c === '>' || isWs(c) || (!close && c === '/') ? { close, name, nameEnd: k } : null;
}

/** End of a closer whose name ends at nameEnd: index past '>', 'partial', or null (not a closer). */
function closerEnd(text: string, nameEnd: number, final: boolean): number | 'partial' | null {
  const k = skipWs(text, nameEnd);
  if (k - nameEnd > TAG_WS_MAX) return null;
  if (k === text.length) return final ? null : 'partial';
  return text[k] === '>' ? k + 1 : null;
}

/** End of an opener's '>' after its name: index past it, 'partial', or 'broken' (it runs to the end). */
function openerEnd(text: string, nameEnd: number, final: boolean): number | 'partial' | 'broken' {
  const bound = nameEnd + ATTR_MAX + 1;
  const limit = Math.min(text.length, bound);
  for (let k = nameEnd; k < limit; k++) {
    const c = text[k];
    if (c === '>') return k + 1;
    if (c === '<') return 'broken';
  }
  return limit === bound || final ? 'broken' : 'partial';
}

/** A found span: a call block, a `<tool_calls>` container, a stray closer, or a hallucinated result tail. */
interface Span {
  kind: 'call' | 'container' | 'stray' | 'result';
  start: number;
  end: number;
  /** call / container: where the body is; absent when the opener never got its '>'. */
  body?: { start: number; end: number };
  /** call / container: ended by its closer (or self-closing). */
  closed: boolean;
  /** An unclosed block ended after its call values (valueEnd): they are read one by one. */
  values?: { start: number; end: number }[];
  nameAttr?: string;
  /** D-97: a call written as the offered tool's own tag. */
  tool?: OfferedTool;
}

/** Where a body ends: by its closer, or (unclosed) at the opener `by` of the next block or result. */
type BodyEnd = { bodyEnd: number; end: number; closed: true } | { bodyEnd: number; end: number; closed: false; by: TagName };

/**
 * Where a call or container body ends: its closer, or (unclosed) the next opener. `scans` (the
 * streaming stripper's): by body start, where to go on reading — every '<' before it was decided as
 * neither, and a decision never changes as the text grows, so a block left open is not read again
 * from its start on every push.
 */
function bodyEnd(text: string, from: number, tag: Tag, final: boolean, names?: NameTags, scans?: Map<number, number>): BodyEnd | 'partial' | null {
  const held = (q: number): 'partial' => {
    scans?.set(from, q);
    return 'partial';
  };
  for (let q = text.indexOf('<', scans?.get(from) ?? from); q >= 0; q = text.indexOf('<', q + 1)) {
    const t = tagAt(text, q, final, names);
    if (t === 'partial') return held(q);
    if (t === null) continue;
    if (t.close) {
      if (t.name !== tag.name || t.tool !== tag.tool) continue;
      const e = closerEnd(text, t.nameEnd, final);
      if (e === 'partial') return held(q);
      if (e === null) continue;
      scans?.delete(from);
      return { bodyEnd: q, end: e, closed: true };
    }
    // A result ends any block; a new call ends an unclosed call or name tag (a container holds calls).
    if (t.name === 'tool_result' || tag.name !== 'tool_calls') {
      scans?.delete(from);
      return { bodyEnd: q, end: q, closed: false, by: t.name };
    }
  }
  if (!final) scans?.set(from, text.length);
  return null;
}

/**
 * End of the balanced JSON value opening at i ('{' or '['), strings skipped with their escapes; -1
 * when it does not close before `limit`. Only the opener's bracket kind is counted. Linear. Shared
 * with leak recovery (tools/leaks.ts, the JSON salvage).
 */
export function balancedEnd(text: string, i: number, limit: number = text.length): number {
  const open = text[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let k = i; k < limit; k++) {
    const c = text[k];
    if (inString) {
      if (c === '\\') k++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return k + 1;
  }
  return -1;
}

/** preClean's prefixes of a body, sticky: a leading `json` word, then a fence opener and its info word. */
const JSON_WORD_AT = /json\b/iy;
const INNER_FENCE_AT = /(?:```|~~~)(?:json|xml|tool_call)?/iy;
/** A python call starting right here (no space before '('): what follows a value may be another call. */
const PY_HEAD_AT = /\[?[A-Za-z_]\w*\(/y;

const parses = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** Punctuation a model leaves after a call value it already closed: an extra brace, the rest of a list, a separator. */
const RESIDUE = new Set([',', ';', ':', '}', ']', ')']);
/** After '[': what makes it the start of more call values rather than prose ('[OOC: …]'). */
const LIST_HEAD_AT = /[A-Za-z_]\w*\s*\(/y;

/** A strictly parsing JSON value ('{' / '[') or a whole python call starting at k, within [k, stop): its end, or -1. */
function callValueAt(text: string, k: number, stop: number, python: 'any' | 'tight'): number {
  if (text[k] === '{' || text[k] === '[') {
    const b = balancedEnd(text, k, stop);
    if (b >= 0 && parses(text.slice(k, b))) return b;
  }
  if (python === 'tight') {
    PY_HEAD_AT.lastIndex = k;
    if (!PY_HEAD_AT.test(text)) return -1;
  }
  return pythonCallEnd(text, k, stop);
}

/**
 * True when the text at `p` (within [p, stop)) could still be part of the call rather than prose:
 * '{'; '[' before '{', '[' or `name(` (blanks allowed; '[OOC: …]' is prose); '<' that begins a
 * closer ('</', a cut `</tool_cal` among them) or a tool tag's name, whole or cut by `stop` ('<i>'
 * and '<br>' are prose); `name(` with no space. `names` (D-97): an offered tool's name is a tool
 * tag's name too (after an XML prefix as well): a cut `<search_hi` is part of the call like `<tool_ca`.
 */
function continuesCall(text: string, p: number, stop: number, names?: NameTags): boolean {
  const c = text[p];
  if (c === '{') return true;
  if (c === '[') {
    const j = skipWs(text, p + 1);
    if (j >= stop || text[j] === '{' || text[j] === '[') return true;
    LIST_HEAD_AT.lastIndex = j;
    return LIST_HEAD_AT.test(text) && LIST_HEAD_AT.lastIndex <= stop;
  }
  if (c === '<') {
    if (p + 1 >= stop || text[p + 1] === '/') return true;
    let k = p + 1;
    while (k < stop && isNameChar(text.charCodeAt(k))) k++;
    const word = text.slice(p + 1, k).toLowerCase();
    if (k >= stop ? TAG_NAMES.some((name) => name.startsWith(word)) : TAG_NAMES.some((name) => name === word)) return true;
    return names !== undefined && offeredNameAt(text, p + 1, stop, names);
  }
  PY_HEAD_AT.lastIndex = p;
  return PY_HEAD_AT.test(text);
}

/**
 * D-97: an offered tool's name starts at j (an XML prefix `ns:` allowed before it): whole, or cut
 * by `stop` while it is the start of one.
 */
function offeredNameAt(text: string, j: number, stop: number, names: NameTags): boolean {
  let k = j;
  while (k < stop && k - j <= WORD_MAX && isWordChar(text.charCodeAt(k))) k++;
  let s = j;
  if (k < stop && text[k] === ':' && k > j && isNameChar(text.charCodeAt(j))) {
    s = k + 1;
    k = s;
    while (k < stop && k - s <= WORD_MAX && isToolChar(text.charCodeAt(k))) k++;
  }
  const name = text.slice(s, k).toLowerCase();
  return k >= stop ? [...names.keys()].some((x) => x.startsWith(name)) : names.has(name);
}

/**
 * D-97: the end of the text cuts a tag of the call family at p (a cut opener, or a closer whose '>'
 * never came): '<' (whitespace and '/' as tagAt reads them), then nothing more, or the start of a
 * wrapper tag's or an offered tool's name (an XML prefix before an offered one), or a whole name of
 * a closer followed by blanks only. Only the end of the text decides it: a cut tag right after a text
 * body goes with its block (namedEnd), not into the query or the story.
 */
function cutTagAtEnd(text: string, p: number, names: NameTags): boolean {
  const n = text.length;
  let j = skipWs(text, p + 1);
  if (j - (p + 1) > TAG_WS_MAX) return false;
  if (j === n) return true;
  let close = false;
  if (text[j] === '/') {
    close = true;
    const k = skipWs(text, j + 1);
    if (k - (j + 1) > TAG_WS_MAX) return false;
    j = k;
    if (j === n) return true;
  }
  let k = j;
  while (k < n && k - j <= WORD_MAX && isWordChar(text.charCodeAt(k))) k++;
  let s = j;
  let family: string[] = [...TAG_NAMES, ...names.keys()];
  if (k < n && text[k] === ':' && k > j && isNameChar(text.charCodeAt(j))) {
    // An XML prefix: an offered tool's name follows it (the wrapper tags take none).
    s = k + 1;
    k = s;
    while (k < n && k - s <= WORD_MAX && isToolChar(text.charCodeAt(k))) k++;
    family = [...names.keys()];
  }
  const name = text.slice(s, k).toLowerCase();
  if (k === n) return family.some((x) => x.startsWith(name));
  return close && family.includes(name) && skipWs(text, k) === n;
}

/** valueEnd's reading of an unclosed block: where it ends, and the call values it holds (in order). */
interface ValueEnd {
  end: number;
  values: { start: number; end: number }[];
  /** namedEnd: where the body ends when the block goes on past it (a cut tag after a body of text goes with the block, not into the query). */
  body?: number;
}

/**
 * A block left unclosed (no closer: it runs to the end of the text, or to the next opener) whose body
 * [from, stop) opens with a complete call value: where the block then ends, so the prose after it
 * stays text, and the values it holds. A value is a JSON value that closes and parses strictly, or a
 * whole python call. More values follow after a comma (`{…}, {…}`, `[f(…), g(…)]`: more calls of the
 * same block); the closing fence of a fence opened inside the tags goes with them, and so does
 * punctuation left after them (an extra '}', the ']' of a list, a trailing ',' or ';'), so nothing of
 * the call reaches the story. null (the block keeps its old end: ERR_CUT unless the whole body is
 * complete) when the body opens with no such value (one that never closes stays a cut-off call), when
 * only whitespace follows a single value, when what follows could still be part of the call
 * (continuesCall), or when the whole body already reads as complete: strict JSON, or a python call
 * whose own end is the end of the body (a python call followed by prose that ends in ')' is not).
 */
function valueEnd(text: string, from: number, stop: number, names?: NameTags): ValueEnd | null {
  let k = skipWs(text, from);
  JSON_WORD_AT.lastIndex = k;
  if (JSON_WORD_AT.test(text)) k = skipWs(text, JSON_WORD_AT.lastIndex);
  INNER_FENCE_AT.lastIndex = k;
  const fenced = INNER_FENCE_AT.exec(text);
  if (fenced !== null) k = skipWs(text, k + fenced[0].length);
  if (k >= stop) return null;
  let e = callValueAt(text, k, stop, 'any');
  if (e < 0) return null;
  const values = [{ start: k, end: e }];
  // More calls after a comma: a value that closes, or a python call written tight (`name(`, so that
  // ", and (quietly) …" stays prose).
  for (;;) {
    const j = skipWs(text, e);
    if (j >= stop || text[j] !== ',') break;
    const m = skipWs(text, j + 1);
    const v = m < stop ? callValueAt(text, m, stop, 'tight') : -1;
    if (v < 0) break;
    values.push({ start: m, end: v });
    e = v;
  }
  if (fenced !== null) {
    // The fence opened inside the tags closes after the value (preClean drops both).
    const j = skipWs(text, e);
    let r = j;
    while (r < stop && (text[r] === '`' || text[r] === '~') && text[r] === text[j]) r++;
    if (r - j >= 3) e = r;
  }
  // Punctuation the call left behind, across blanks and line breaks: it goes with the block.
  let residue = false;
  for (let r = e; r < stop; r++) {
    const c = text[r]!;
    if (RESIDUE.has(c)) {
      e = r + 1;
      residue = true;
    } else if (!isWs(c)) break;
  }
  const rest = skipWs(text, e);
  if (rest >= stop && values.length === 1 && !residue) return null;
  if (rest < stop && continuesCall(text, rest, stop, names)) return null;
  // The block as readCallBody reads it: the value is complete, the whole body is not (else it stays whole).
  const first = values[0]!;
  if (!complete(preClean(text.slice(from, first.end)))) return null;
  const whole = preClean(text.slice(from, stop));
  if (parses(whole) || (skipWs(text, first.end) >= stop && pythonCall(whole) !== null)) return null;
  return { end: e, values };
}

/**
 * valueEnd for a name tag left unclosed (D-97), its body [from, stop): a body that opens with a JSON
 * object ends after the object when prose follows it (the closing fence of a fence opened inside the
 * tags and punctuation left after it go with the block, as in valueEnd); a body of text, read after a
 * leading `json` word, ends with its first line when more text follows on later lines (a query is one
 * line; the story goes on below it), or, when a fence was opened inside the tags, with its closing
 * fence line (none: it runs to `stop`, as a fence left open runs to the end). A tag of the call family
 * cut off by the end of the text right after a body of text (only blanks between) goes with the block;
 * the body ends before it. null (the block runs to `stop`) when only whitespace follows, when the
 * object never closes or does not parse, or when what follows the object could still be part of the
 * call (continuesCall).
 */
function namedEnd(text: string, from: number, stop: number, names: NameTags): ValueEnd | null {
  const first = skipWs(text, from);
  if (first >= stop) return null;
  let k = first;
  JSON_WORD_AT.lastIndex = k;
  if (JSON_WORD_AT.test(text)) k = skipWs(text, JSON_WORD_AT.lastIndex);
  INNER_FENCE_AT.lastIndex = k;
  const fenced = INNER_FENCE_AT.exec(text);
  const fence = text[k]!;
  if (fenced !== null) k = skipWs(text, k + fenced[0].length);
  if (k < stop && text[k] === '{') {
    const b = balancedEnd(text, k, stop);
    if (b < 0 || !parses(text.slice(k, b))) return null;
    let e = b;
    if (fenced !== null) {
      const j = skipWs(text, e);
      let r = j;
      while (r < stop && (text[r] === '`' || text[r] === '~') && text[r] === text[j]) r++;
      if (r - j >= 3) e = r;
    }
    for (let r = e; r < stop; r++) {
      const c = text[r]!;
      if (RESIDUE.has(c)) e = r + 1;
      else if (!isWs(c)) break;
    }
    const rest = skipWs(text, e);
    if (rest >= stop || continuesCall(text, rest, stop, names)) return null;
    return { end: e, values: [] };
  }
  // A body of text: a tag cut off by the end of the text is not part of it.
  let limit = stop;
  if (stop === text.length) {
    const lt = text.lastIndexOf('<', stop - 1);
    if (lt >= k && cutTagAtEnd(text, lt, names)) limit = lt;
  }
  let e = limit;
  if (fenced !== null) {
    const close = fenceCloseEnd(text, k, limit, fence);
    if (close >= 0) e = close;
  } else {
    const nl = text.indexOf('\n', k);
    if (nl >= 0 && nl < limit && skipWs(text, nl) < limit) e = nl;
  }
  while (e > first && isWs(text[e - 1])) e--;
  const rest = skipWs(text, e);
  if (rest >= stop) return null;
  return rest >= limit ? { end: stop, values: [], body: e } : { end: e, values: [] };
}

/**
 * Where the closing fence of a fence of `c` opened inside a name tag ends: the first line from
 * `from` (within `limit`) that holds only a run of at least three `c` and blanks; -1 when none does.
 */
function fenceCloseEnd(text: string, from: number, limit: number, c: string): number {
  for (let ls = from; ls < limit; ) {
    const lead = skipBlanks(text, ls, limit);
    let r = lead;
    while (r < limit && text[r] === c) r++;
    if (r - lead >= 3) {
      const eol = skipBlanks(text, r, limit);
      if (eol >= limit || text[eol] === '\n' || text[eol] === '\r') return r;
    }
    const nl = text.indexOf('\n', ls);
    if (nl < 0 || nl >= limit) return -1;
    ls = nl + 1;
  }
  return -1;
}

/**
 * What the streaming stripper keeps between pushes, by body start: valueEnd / namedEnd decisions (the
 * body end each was made for, and the result), and where bodyEnd goes on reading a block left open.
 */
interface ScanMemo {
  values: Map<number, { stop: number; end: ValueEnd | null }>;
  bodies: Map<number, number>;
}

/** Every span from `from` on; `pending` is where the first undecidable one starts (text.length if none). */
function scanSpans(text: string, from: number, final: boolean, memo?: ScanMemo, names?: NameTags): { spans: Span[]; pending: number } {
  const spans: Span[] = [];
  const n = text.length;
  let i = from;
  for (;;) {
    const p = text.indexOf('<', i);
    if (p < 0) return { spans, pending: n };
    const tag = tagAt(text, p, final, names);
    if (tag === 'partial') return { spans, pending: p };
    if (tag === null) {
      i = p + 1;
      continue;
    }
    if (tag.close) {
      const e = closerEnd(text, tag.nameEnd, final);
      if (e === 'partial') return { spans, pending: p };
      if (e === null) {
        i = p + 1;
        continue;
      }
      spans.push({ kind: 'stray', start: p, end: e, closed: true });
      i = e;
      continue;
    }
    if (tag.name === 'tool_result') {
      // The server ignored the stop sequence: the model is writing its own results. Never shown.
      if (!final) return { spans, pending: p };
      spans.push({ kind: 'result', start: p, end: n, closed: false });
      return { spans, pending: n };
    }
    const kind = tag.name === 'tool_calls' ? 'container' : 'call';
    const gt = openerEnd(text, tag.nameEnd, final);
    if (gt === 'partial' || (gt === 'broken' && !final)) return { spans, pending: p };
    // A name tag (D-97) is named by its tag: its attributes are allowed and not read.
    const own = tag.tool !== undefined ? { tool: tag.tool } : undefined;
    if (gt === 'broken') {
      const attr = own ? null : NAME_ATTR.exec(text.slice(tag.nameEnd, Math.min(n, tag.nameEnd + ATTR_MAX)));
      const nameAttr = attr?.[1] ?? attr?.[2];
      spans.push({ kind, start: p, end: n, closed: false, ...(nameAttr ? { nameAttr } : {}), ...own });
      return { spans, pending: n };
    }
    const attrs = text.slice(tag.nameEnd, gt - 1);
    const attr = own ? null : NAME_ATTR.exec(attrs);
    const nameAttr = attr?.[1] ?? attr?.[2];
    const named = own ?? (nameAttr ? { nameAttr } : {});
    if (/\/\s*$/.test(attrs)) {
      spans.push({ kind, start: p, end: gt, body: { start: gt, end: gt }, closed: true, ...named });
      i = gt;
      continue;
    }
    const end = bodyEnd(text, gt, tag, final, names, memo?.bodies);
    if (end === 'partial' || (end === null && !final)) return { spans, pending: p };
    if (kind === 'call' && end !== null && !end.closed && end.by !== 'tool_result' && blankBetween(text, gt, end.bodyEnd)) {
      // A wrapper around the next call (a <tool_call> around a name tag, a name tag around a
      // <tool_call>, an opener written twice): an empty block that the next opener ends is markup,
      // not a call. Removed like a stray closer (the wrapper's own closer after the call is one).
      spans.push({ kind: 'stray', start: p, end: gt, closed: true });
      i = gt;
      continue;
    }
    if (end === null || !end.closed) {
      // Unclosed: a complete call value followed by prose ends the block there.
      const stop = end === null ? n : end.bodyEnd;
      let v = memo?.values.get(gt);
      if (v === undefined || v.stop !== stop) {
        v = { stop, end: own ? namedEnd(text, gt, stop, names!) : valueEnd(text, gt, stop, names) };
        memo?.values.set(gt, v);
      }
      if (v.end !== null) {
        const values = own ? {} : { values: v.end.values };
        spans.push({ kind, start: p, end: v.end.end, body: { start: gt, end: v.end.body ?? v.end.end }, ...values, closed: false, ...named });
        i = v.end.end;
        continue;
      }
    }
    if (end === null) {
      spans.push({ kind, start: p, end: n, body: { start: gt, end: n }, closed: false, ...named });
      return { spans, pending: n };
    }
    spans.push({ kind, start: p, end: end.end, body: { start: gt, end: end.bodyEnd }, closed: end.closed, ...named });
    i = end.end;
  }
}

// ---- fences around blocks (RoleCall widenOverFence) ---------------------------------------------

/**
 * RoleCall FENCE_BEFORE: a fence line right before the block (the block may sit on that line or the
 * next). Same matches as RoleCall's `(`{3,}|~{3,})[^\n`~]*[ \t]*\n?[ \t]*$`, but the info string is
 * taken atomically (lookahead + backreference) and the blanks after it once: the three overlapping
 * runs of spaces backtracked in cubic time on a fence line with long trailing blanks.
 */
const FENCE_BEFORE = /(?:^|\n)[ \t]*(`{3,}|~{3,})(?=([^\n`~]*))\2(?:\n[ \t]*)?$/;
/**
 * RoleCall FENCE_AFTER (sticky here): the closing fence right after the block, prose may follow on
 * its line. RoleCall's `[ \t]*\n?[ \t]*` is written `[ \t]*(?:\n[ \t]*)?` (the same text, without the
 * quadratic split of one run of spaces between two quantifiers).
 */
const FENCE_AFTER = /[ \t]*(?:\n[ \t]*)?(`{3,}|~{3,})[ \t]*\n?/y;
/** Text after a block that could still grow into FENCE_AFTER. */
const FENCE_AFTER_PREFIX = /[ \t]*(?:\n[ \t]*)?(?:`{1,2}|~{1,2})?$/y;

/** The opening fence before index s: where the removal would start, and the fence run; null when none. */
function fenceBefore(text: string, s: number): { start: number; run: string } | null {
  // FENCE_BEFORE spans at most the fence line and the block's own line: two line breaks back.
  const p1 = s > 0 ? text.lastIndexOf('\n', s - 1) : -1;
  const p2 = p1 > 0 ? text.lastIndexOf('\n', p1 - 1) : -1;
  const from = p2 > 0 ? p2 : 0;
  const m = FENCE_BEFORE.exec(text.slice(from, s));
  if (m === null) return null;
  // The leading '\n' of the match stays with the prose before it.
  return { start: from + m.index + (m[0].startsWith('\n') ? 1 : 0), run: m[1]! };
}

/**
 * fenceBefore for block starts read in increasing order (the groups of one text; the streaming
 * stripper's groups, push after push): the same answers, but each line break is found once and a
 * line's opening fence is read once however many blocks sit on that line (fenceBefore searched back
 * to the line's start and ran FENCE_BEFORE over it for every block: quadratic on a long line of
 * blocks). The text may grow between calls; what was read stays true. A start before the last one
 * read goes to fenceBefore.
 */
class FenceLines {
  /** The line the last start was on, the line before it (-1: none), and the line break that ends it (-1: none before `to`). */
  private ls = 0;
  private prev = -1;
  private next = -1;
  private to = 0;
  /** The line's first non-blank (-1: none in [ls, leadTo)), and its fence as read so far (fenceSoFar). */
  private lead = -1;
  private leadTo = 0;
  private readonly scan: LineScan = { start: -1, to: 0, run: 0, after: false, broken: false };
  /** The last start read. */
  private last = 0;

  before(text: string, s: number): { start: number; run: string } | null {
    if (s < this.last) return fenceBefore(text, s);
    this.last = s;
    for (;;) {
      if (this.next < 0 && this.to < text.length) {
        this.next = text.indexOf('\n', this.to);
        this.to = text.length;
      }
      if (this.next < 0 || this.next >= s) break;
      [this.prev, this.ls] = [this.ls, this.next + 1];
      [this.lead, this.leadTo] = [-1, this.ls];
      this.next = -1;
      this.to = this.ls;
    }
    if (this.lead < 0) {
      const lead = skipBlanks(text, this.leadTo, s);
      if (lead < s) this.lead = lead;
      else this.leadTo = s;
    }
    if (this.lead >= 0) {
      // FENCE_BEFORE on the block's own line: it is a fence line up to s.
      const c = text[this.lead]!;
      if (c !== '`' && c !== '~') return null;
      return fenceSoFar(text, this.ls, this.lead, s, this.scan) && this.scan.run >= 3 ? { start: this.ls, run: c.repeat(this.scan.run) } : null;
    }
    // Only blanks before s on its line: FENCE_BEFORE on the line before (read once: one block per line gets here).
    if (this.ls === 0) return null;
    const ps = this.prev;
    const pe = this.ls - 1;
    const pl = skipBlanks(text, ps, pe);
    if (pl >= pe || (text[pl] !== '`' && text[pl] !== '~') || !FENCE_LINE.test(text.slice(ps, pe))) return null;
    let r = pl;
    while (text[r] === text[pl]) r++;
    return { start: ps, run: text.slice(pl, r) };
  }
}

/** The closing fence after index e: its end and run, null when none, 'undecided' while it may still come. */
function fenceAfter(text: string, e: number, final: boolean): { end: number; run: string } | null | 'undecided' {
  FENCE_AFTER.lastIndex = e;
  const m = FENCE_AFTER.exec(text);
  if (m !== null) {
    const end = e + m[0].length;
    return end === text.length && !final ? 'undecided' : { end, run: m[1]! };
  }
  if (final) return null;
  FENCE_AFTER_PREFIX.lastIndex = e;
  return FENCE_AFTER_PREFIX.test(text) ? 'undecided' : null;
}

/** Both fences or neither; same character; the closer at least as long (CommonMark). */
function pairs(before: { run: string } | null, after: { run: string } | null): boolean {
  return before !== null && after !== null && before.run[0] === after.run[0] && after.run.length >= before.run.length;
}

/**
 * Widen [start, end) over a fence that wraps only it (RoleCall widenOverFence), on a finished text.
 * Shared with leak recovery (tools/leaks.ts).
 */
export function widenOverFence(text: string, start: number, end: number): { start: number; end: number } {
  const after = fenceAfter(text, end, true);
  if (after === null || after === 'undecided') return { start, end };
  const before = fenceBefore(text, start);
  return pairs(before, after) ? { start: before!.start, end: after.end } : { start, end };
}

/** A removal: a run of spans with only whitespace between them, widened over its fence. */
interface Region {
  start: number;
  end: number;
  /** The spans, in order, and the bounds each block reports (the run's first/last take the fence). */
  spans: Span[];
}

const blankBetween = (text: string, a: number, b: number): boolean => {
  for (let k = a; k < b; k++) if (!isWs(text[k])) return false;
  return true;
};

/** Is [a, b) of the text whitespace only? */
type Blank = (a: number, b: number) => boolean;

/** A run of spans with only whitespace between them (one removal), and its opening fence once read. */
interface Group {
  spans: Span[];
  /** fenceBefore of the first span (the text before it never changes): undefined until read. */
  before?: { start: number; run: string } | null;
}

/** Add a span to the groups: to the last one when only whitespace lies between them. */
function joinGroup(groups: Group[], span: Span, blank: Blank): void {
  const g = groups[groups.length - 1];
  if (g !== undefined && blank(g.spans[g.spans.length - 1]!.end, span.start)) g.spans.push(span);
  else groups.push({ spans: [span] });
}

/**
 * The regions of the groups. The last group stays undecided (`hold` = where it would start) while
 * more of the text could still join it or bring its closing fence. `floor`: the end of the last
 * region already emitted (RoleCall's overlap clamp). `blank`: blankBetween on this text (the
 * streaming stripper answers from its caches). One region per group, in order, but for a held last one.
 * `lines`: the opening fences, read in the groups' order (the stripper keeps its own across pushes).
 */
function regionsOf(
  text: string,
  groups: readonly Group[],
  pending: number,
  floor: number,
  final: boolean,
  blank: Blank,
  lines: FenceLines = new FenceLines(),
): { regions: Region[]; hold: number } {
  const regions: Region[] = [];
  let hold = text.length;
  let prevEnd = floor;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const first = group.spans[0]!;
    const last = group.spans[group.spans.length - 1]!;
    if (group.before === undefined) group.before = lines.before(text, first.start);
    const before = group.before;
    let after: ReturnType<typeof fenceAfter> = null;
    if (g === groups.length - 1 && !final) {
      // The last group: more blocks may follow after whitespace, and its closing fence may still come.
      after = blank(last.end, pending) ? 'undecided' : fenceAfter(text, last.end, false);
      if (after === 'undecided') {
        hold = before !== null ? before.start : first.start;
        break;
      }
    } else after = fenceAfter(text, last.end, final);
    const fenced = after !== 'undecided' && pairs(before, after);
    regions.push({
      start: Math.max(prevEnd, fenced ? before!.start : first.start),
      end: fenced ? (after as { end: number }).end : last.end,
      spans: group.spans,
    });
    prevEnd = regions[regions.length - 1]!.end;
  }
  return { regions, hold };
}

/** Group the spans (joinGroup) and lay out their regions (regionsOf). */
function layout(
  text: string,
  spans: Span[],
  pending: number,
  floor: number,
  final: boolean,
  blank: Blank = (a, b) => blankBetween(text, a, b),
): { regions: Region[]; hold: number } {
  const groups: Group[] = [];
  for (const span of spans) joinGroup(groups, span, blank);
  return regionsOf(text, groups, pending, floor, final, blank);
}

// ---- stripping ----------------------------------------------------------------------------------

/** Number of '\n' in s. */
function newlines(s: string): number {
  let k = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) k++;
  return k;
}

/** tools/leaks.ts seam: one side's spaces within a line; across lines at most one blank line, then the right indent. */
function seam(left: string, right: string): string {
  const lines = Math.min(2, Math.max(newlines(left), newlines(right)));
  if (lines === 0) return left || right;
  const indent = right.includes('\n') ? right.slice(right.lastIndexOf('\n') + 1) : '';
  return '\n'.repeat(lines) + indent;
}

/**
 * Glue the prose pieces left between removals (tools/leaks.ts stripToolCallLeaks rules): seams
 * repaired, whitespace that opened or closed the text at a removal dropped. `started`: text was
 * already emitted before pieces[0] and it ended in non-whitespace. Shared with leak recovery.
 */
export function joinPieces(pieces: readonly string[], started = false): string {
  // A non-blank sentinel stands for the text already emitted, so nothing before it is touched.
  let out = (started ? '\u0001' : '') + (pieces[0] ?? '');
  let carry = '';
  for (let i = 1; i < pieces.length; i++) {
    const right = carry + pieces[i]!;
    carry = '';
    const leftBody = out.trimEnd();
    const rightBody = right.trimStart();
    if (leftBody === '') out = rightBody;
    else if (rightBody === '') {
      if (i === pieces.length - 1) out = leftBody;
      else carry = right;
    } else out = leftBody + seam(out.slice(leftBody.length), right.slice(0, right.length - rightBody.length)) + rightBody;
  }
  return started ? out.slice(1) : out;
}

/** A line that is, or may still grow into, an opening fence: ``` / ~~~ with an info string, or a run of 1–2. */
const FENCE_LINE_SO_FAR = /^[ \t]*(?:(?:`{3,}|~{3,})[^\n`~]*|`{1,2}|~{1,2})$/;
/** A finished fence line (no line break). */
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})[^\n`~]*$/;

/** First index in [a, b) that is not a space or tab (b when none). */
function skipBlanks(text: string, a: number, b: number): number {
  while (a < b && (text[a] === ' ' || text[a] === '\t')) a++;
  return a;
}

/** FENCE_LINE_SO_FAR read one character at a time over a growing line (its start, how far it was read). */
interface LineScan {
  start: number;
  to: number;
  /** Length of the run of the fence character that opens the line. */
  run: number;
  /** Something other than the run followed it. */
  after: boolean;
  /** The line can no longer be a fence line, whatever comes next. */
  broken: boolean;
}

/**
 * FENCE_LINE_SO_FAR on [ls, q), whose first non-blank `lead` (< q) is a backtick or tilde, read on
 * from where `scan` stopped when it is this line's (the text only grows): a run of that character,
 * 1–2 long with nothing after it, or 3+ long followed by no backtick or tilde.
 */
function fenceSoFar(text: string, ls: number, lead: number, q: number, scan: LineScan): boolean {
  if (scan.start !== ls || scan.to < lead || scan.to > q) Object.assign(scan, { start: ls, to: lead, run: 0, after: false, broken: false });
  const c = text[lead];
  for (let k = scan.to; k < q && !scan.broken; k++) {
    const d = text[k];
    if (!scan.after && d === c) scan.run++;
    else if (scan.run < 3 || d === '`' || d === '~' || d === '\n') scan.broken = true;
    else scan.after = true;
  }
  scan.to = q;
  return !scan.broken;
}

/** What the streaming stripper knows about its last line, so a push does not re-read it. */
interface LineCache {
  /** The line's start and its first non-blank index (q when none yet). */
  start: number;
  lead: number;
  scan: LineScan;
  /** The line before a blank last line: the last line's start it was read for, and its start when it is a fence line (else -1). */
  prev: { ls: number; ps: number };
}

/**
 * Hold back a line before q that FENCE_BEFORE of a later block could still take: the line q is on
 * when it is (or may become) a fence line, or the line before it when q's line is blank so far.
 * `line`: q's line (q = the end of the text), with the reads of earlier pushes.
 */
function fenceLineHold(text: string, q: number, line?: LineCache): number {
  const ls = line?.start ?? (q > 0 ? text.lastIndexOf('\n', q - 1) + 1 : 0);
  const lead = line?.lead ?? skipBlanks(text, ls, q);
  if (lead < q) {
    if (text[lead] !== '`' && text[lead] !== '~') return q;
    const open = line !== undefined ? fenceSoFar(text, ls, lead, q, line.scan) : FENCE_LINE_SO_FAR.test(text.slice(ls, q));
    return open ? ls : q;
  }
  if (ls === 0) return q;
  if (line !== undefined && line.prev.ls === ls) return line.prev.ps >= 0 ? line.prev.ps : q;
  const ps = ls > 1 ? text.lastIndexOf('\n', ls - 2) + 1 : 0;
  const pl = skipBlanks(text, ps, ls - 1);
  const fence = (text[pl] === '`' || text[pl] === '~') && FENCE_LINE.test(text.slice(ps, ls - 1));
  if (line !== undefined) line.prev = { ls, ps: fence ? ps : -1 };
  return fence ? ps : q;
}

/**
 * Index just past the last non-whitespace character in [from, q) outside every region; `from` when
 * none. `blankFrom`: [blankFrom, end of text) is known to be whitespace, so the walk starts below it.
 */
function lastProse(text: string, from: number, q: number, regions: readonly Region[], blankFrom = q): number {
  let r = regions.length - 1;
  for (let k = Math.min(q, blankFrom) - 1; k >= from; ) {
    while (r >= 0 && regions[r]!.start > k) r--;
    if (r >= 0 && k < regions[r]!.end) {
      k = regions[r]!.start - 1;
      continue;
    }
    if (!isWs(text[k])) return k + 1;
    k--;
  }
  return from;
}

/**
 * The stripper's state over the whole text so far. Each step emits the text up to the last point
 * no later text can change: after a non-whitespace character of prose, before anything pending (an
 * open block, a partial tag, a group that may still grow or get its closing fence, a line that may
 * be a block's opening fence). That prefix of the result is final because every rule looks at most
 * that far back, so any chunking gives the same text as one final step over the whole.
 */
class Stripper implements PromptedStripper {
  private raw = '';
  /** raw[0..done) has been emitted. */
  private done = 0;
  /** Something non-blank has been emitted (the next seam has text on its left). */
  private started = false;
  /** End of the last region emitted. */
  private floor = 0;
  // Caches that keep a step cheap on long lines and long whitespace runs (all derived from raw):
  /** Start of the trailing whitespace run of raw. */
  private blankFrom = 0;
  /** Start of the last line, and its first non-blank index (-1: none yet). */
  private lineStart = 0;
  private lineLead = -1;
  /** The last hold point computed for a pending position before the end, and its result. */
  private heldAt = -1;
  private held = 0;
  private proseAt = -1;
  private prose = 0;
  /** valueEnd decisions (a held block before the next opener is not re-read on every push), and bodyEnd's place in a block left open. */
  private readonly memo: ScanMemo = { values: new Map(), bodies: new Map() };
  /**
   * The spans decided so far and not emitted yet, grouped (joinGroup), and where the scan goes on:
   * a decided span's end and body are fixed text, so a push reads only what follows the last one (a
   * flood of blocks that never close was read again from its first block on every push).
   */
  private groups: Group[] = [];
  private scanAt = 0;
  /** The groups' opening fences, read once each, in order. */
  private readonly lines = new FenceLines();
  /** The last line's fence reads (fenceLineHold). */
  private line: LineCache = { start: 0, lead: 0, scan: { start: -1, to: 0, run: 0, after: false, broken: false }, prev: { ls: -1, ps: -1 } };
  /** Gaps between spans already read, by their start: the end read to, and whether it was blank. */
  private gaps = new Map<number, { b: number; blank: boolean }>();
  /** blankBetween on raw: a gap that runs to the end is blank exactly when it starts in the trailing whitespace. */
  private readonly blank: Blank = (a, b) => {
    if (b === this.raw.length) return a >= this.blankFrom;
    const g = this.gaps.get(a);
    if (g !== undefined && g.b === b) return g.blank;
    const blank = blankBetween(this.raw, a, b);
    this.gaps.set(a, { b, blank });
    return blank;
  };

  /** D-97: the offered tools whose names are tags (none: the wrapper tags only). */
  constructor(private readonly names?: NameTags) {}

  push(delta: string): string {
    const base = this.raw.length;
    this.raw += delta;
    const body = delta.trimEnd().length;
    if (body > 0) this.blankFrom = base + body;
    const nl = delta.lastIndexOf('\n');
    if (nl >= 0) {
      this.lineStart = base + nl + 1;
      this.lineLead = -1;
    }
    if (this.lineLead < 0) {
      const lead = skipBlanks(this.raw, Math.max(this.lineStart, base), this.raw.length);
      if (lead < this.raw.length) this.lineLead = lead;
    }
    return this.step(false);
  }

  end(): string {
    return this.step(true);
  }

  /** The batch strip: one final step over the whole text. */
  static strip(text: string, names?: NameTags): string {
    const s = new Stripper(names);
    s.raw = text;
    s.blankFrom = text.trimEnd().length;
    return s.step(true);
  }

  private step(final: boolean): string {
    const { raw, done } = this;
    let regions: Region[];
    let hold: number;
    let pending: number;
    if (final) {
      const scan = scanSpans(raw, done, true, this.memo, this.names);
      pending = scan.pending;
      ({ regions, hold } = layout(raw, scan.spans, pending, this.floor, true, this.blank));
    } else {
      // The scan goes on after the last decided span (or after the emitted text, when that is later).
      const scan = scanSpans(raw, Math.max(done, this.scanAt), false, this.memo, this.names);
      for (const span of scan.spans) joinGroup(this.groups, span, this.blank);
      if (scan.spans.length > 0) this.scanAt = scan.spans[scan.spans.length - 1]!.end;
      pending = scan.pending;
      ({ regions, hold } = regionsOf(raw, this.groups, pending, this.floor, false, this.blank, this.lines));
    }
    let cut = raw.length;
    if (!final) {
      const p = Math.min(pending, hold);
      let q: number;
      if (p === raw.length) {
        this.line.start = this.lineStart;
        this.line.lead = this.lineLead < 0 ? p : this.lineLead;
        q = fenceLineHold(raw, p, this.line);
      } else {
        // A pending block stays where it is for many pushes; its hold point does not change.
        if (this.heldAt !== p) [this.heldAt, this.held] = [p, fenceLineHold(raw, p)];
        q = this.held;
      }
      if (q === raw.length) cut = lastProse(raw, done, q, regions, this.blankFrom);
      else {
        if (this.proseAt !== q) [this.proseAt, this.prose] = [q, lastProse(raw, done, q, regions)];
        cut = Math.max(done, this.prose);
      }
      if (cut <= done) return '';
    }
    const pieces: string[] = [];
    let at = done;
    let emitted = 0;
    for (const r of regions) {
      if (r.end > cut) break;
      pieces.push(raw.slice(at, r.start));
      at = r.end;
      this.floor = r.end;
      emitted++;
    }
    // Regions are the groups' in order: the emitted ones leave.
    if (!final && emitted > 0) this.groups.splice(0, emitted);
    pieces.push(raw.slice(at, cut));
    const out = joinPieces(pieces, this.started);
    if (!this.started && /\S/.test(out)) this.started = true;
    this.done = cut;
    return out;
  }
}

/**
 * The text with every call block removed (the same spans parsePromptedCalls finds), seams repaired.
 * `tools`: the offered tools, whose names used as tags are calls too (D-97); without them, only the
 * wrapper tags.
 */
export function stripPromptedCalls(text: string, tools?: readonly OfferedTool[]): string {
  return Stripper.strip(text, nameTags(tools));
}

/**
 * Live stripping of call blocks from a stream (§8.3): push(delta) returns the text that is safe to
 * show now; a possible tag start is held back in a carry; end() returns the rest. The concatenation
 * of everything returned equals stripPromptedCalls(all pushed text).
 */
export interface PromptedStripper {
  push(delta: string): string;
  end(): string;
}

/**
 * Besides partial tags the stripper holds back trailing whitespace (a seam may still change it), a
 * line that may open a fence around a coming block, and a finished block until what follows it is
 * known. Call end() once; push after end() is not supported. `tools`: as stripPromptedCalls (with
 * them, a `<word` at the end of the text so far is held until the next character: it may still
 * become an offered name or an XML prefix).
 */
export function createPromptedStripper(tools?: readonly OfferedTool[]): PromptedStripper {
  return new Stripper(nameTags(tools));
}

// ---- reading the blocks -------------------------------------------------------------------------

/** One <tool_call> block (or name tag, D-97) found in a reply. */
export interface PromptedBlock {
  /** The tool name, or null when the block had none. */
  name: string | null;
  /** The raw arguments text: the value of "args", else "arguments", else "parameters" (a string value as is, an object re-serialised); '' when absent. */
  args: string;
  /** [start, end) of the block in the text, fences around it included. */
  start: number;
  end: number;
  /** Why the block is unusable (no name, unreadable envelope); the call then gets an error result. */
  error?: string;
}

/** A call read from a block body (also used by leak recovery): no position yet. */
export interface BodyCall {
  name: string | null;
  args: string;
  error?: string;
}

const CALL_FORMAT = 'Write the call as <tool_call>{"name": "tool_name", "args": {…}}</tool_call>.';
const ERR_EMPTY = `The <tool_call> block is empty. ${CALL_FORMAT}`;
const ERR_CUT = `The <tool_call> block was cut off before it was complete. ${CALL_FORMAT}`;
const ERR_NO_NAME = `The <tool_call> block has no "name". ${CALL_FORMAT}`;
const ERR_NO_CALLS = `The <tool_call> block holds no call. ${CALL_FORMAT}`;
const errNotJson = (why: string): string => `The <tool_call> block is not readable JSON (${why.slice(0, 160)}). ${CALL_FORMAT}`;

/** Keys a call's name and arguments go by (RoleCall content-tool-salvage NAME_KEYS / ARG_KEYS, `args` first). */
export const NAME_KEYS = ['name', 'tool', 'tool_name', 'function_name'] as const;
export const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input'] as const;

/** RoleCall preCleanBody: trimmed, a leading `json` word and a fence inside the tags dropped. */
function preClean(raw: string): string {
  let body = raw.trim();
  if (/^json\b/i.test(body)) body = body.replace(/^json\b/i, '').trim();
  return body
    .replace(/^(?:```|~~~)(?:json|xml|tool_call)?\s*\n?/i, '')
    .replace(/\n?(?:```|~~~)\s*$/, '')
    .trim();
}

/** The arguments value as text: a string as is, null/absent '', anything else as JSON. */
function argsText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * A call shape: `{"name": …, "args"|"arguments"|"parameters"|…: …}` or OpenAI's `{"function": {"name",
 * "arguments"}}`. `needArgs`: a name with no arguments key is not a call (JSON salvage); a prompted
 * envelope may omit them. Undefined when the value is not call-shaped.
 */
export function callShape(v: unknown, needArgs: boolean): { name: string | null; args: string; hasArgs: boolean } | undefined {
  if (!isRecord(v)) return undefined;
  const fn = v['function'];
  if (isRecord(fn) && typeof fn['name'] === 'string') {
    const has = Object.hasOwn(fn, 'arguments');
    return needArgs && !has ? undefined : { name: fn['name'], args: argsText(fn['arguments']), hasArgs: has };
  }
  const key = NAME_KEYS.find((k) => typeof v[k] === 'string');
  const argKey = ARG_KEYS.find((k) => Object.hasOwn(v, k));
  if (needArgs && (key === undefined || argKey === undefined)) return undefined;
  return { name: key === undefined ? null : (v[key] as string), args: argKey === undefined ? '' : argsText(v[argKey]), hasArgs: argKey !== undefined };
}

/** The calls a parsed envelope holds: an object, an array of them, or `{"tool_calls": […]}`. */
function envelopeCalls(v: unknown): BodyCall[] {
  if (Array.isArray(v)) return v.length === 0 ? [{ name: null, args: '', error: ERR_NO_CALLS }] : v.flatMap(envelopeCalls);
  if (isRecord(v) && Array.isArray(v['tool_calls']) && callShape(v, false)?.name == null) return envelopeCalls(v['tool_calls']);
  const shape = callShape(v, false);
  if (shape === undefined) return [{ name: null, args: '', error: errNotJson('not a JSON object') }];
  if (shape.name === null || shape.name.trim() === '') return [{ name: null, args: shape.args, error: ERR_NO_NAME }];
  return [{ name: shape.name, args: shape.args }];
}

/** The JSON inside is whole: it parses strictly (or is a whole python call). */
const complete = (body: string): boolean => parses(body) || pythonCall(body) !== null;

/** A name written in an unreadable body, for the error result's label. */
function nameIn(body: string): string | null {
  return /"(?:name|tool|tool_name|function_name)"\s*:\s*"([A-Za-z_][A-Za-z0-9_.-]{0,63})"/.exec(body)?.[1] ?? null;
}

/**
 * The calls one block body holds (§8.3 tolerant parser). `nameAttr`: the attribute form, whose body
 * is the arguments (an envelope nested in it is unwrapped). `closed`: the block had its closer; an
 * unclosed one counts only when the JSON inside is complete. Arguments are not checked here (the
 * schema check is tools/args.ts's at run time).
 */
export function readCallBody(rawBody: string, nameAttr: string | undefined, closed: boolean): BodyCall[] {
  const body = preClean(rawBody);
  if (nameAttr !== undefined && nameAttr !== '') {
    if (body === '') return [closed ? { name: nameAttr, args: '' } : { name: nameAttr, args: '', error: ERR_CUT }];
    if (!closed && !complete(body)) return [{ name: nameAttr, args: body, error: ERR_CUT }];
    // `{"args": {…}}` (or `arguments` / `parameters`, maybe with the same name) inside the attribute form.
    const parsed = looseJson(body);
    if (parsed.ok && isRecord(parsed.value)) {
      const keys = Object.keys(parsed.value);
      const argKey = (['args', 'arguments', 'parameters'] as const).find((k) => Object.hasOwn(parsed.value as object, k));
      const sameName = !Object.hasOwn(parsed.value, 'name') || parsed.value['name'] === nameAttr;
      if (argKey !== undefined && sameName && keys.every((k) => k === 'name' || k === argKey)) {
        return [{ name: nameAttr, args: argsText(parsed.value[argKey]) }];
      }
    }
    return [{ name: nameAttr, args: body }];
  }
  if (body === '') return [{ name: null, args: '', error: ERR_EMPTY }];
  const py = pythonCall(body);
  if (!closed && py === null && !parses(body)) return [{ name: nameIn(body), args: '', error: ERR_CUT }];
  if (py !== null) return [{ name: py.name, args: py.json }];
  const parsed = looseJson(body);
  if (!parsed.ok) return [{ name: nameIn(body), args: '', error: errNotJson(parsed.error) }];
  if (typeof parsed.value === 'string') return [{ name: nameIn(body), args: '', error: errNotJson('not a JSON object') }];
  return envelopeCalls(parsed.value);
}

// D-97: a name tag's body. Model-facing, English, deterministic.
const namedFormat = (name: string): string => `Write the call as <tool_call>{"name": "${name}", "args": {…}}</tool_call>.`;
const errNamedCut = (name: string): string => `The <${name}> block was cut off before it was complete. ${namedFormat(name)}`;
const errNamedJson = (name: string, why: string): string => `The <${name}> block is not readable JSON (${why.slice(0, 160)}). ${namedFormat(name)}`;
const errNamedArgs = (name: string): string => `The <${name}> block does not hold its arguments as a JSON object. ${namedFormat(name)}`;

/** The one required property of a schema when its type is string (search_history `query`), else undefined. */
function soleStringArg(schema: Record<string, unknown>): string | undefined {
  const required = [...new Set(Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : [])];
  if (required.length !== 1) return undefined;
  const props = isRecord(schema['properties']) ? schema['properties'] : {};
  const prop = props[required[0]!];
  if (!isRecord(prop)) return undefined;
  const t = prop['type'];
  const string = t === 'string' || (Array.isArray(t) && t.includes('string') && t.every((x) => x === 'string' || x === 'null'));
  return string ? required[0] : undefined;
}

/**
 * A body of text as its argument: trimmed, a fence inside the tags dropped, and a `json` word before
 * that fence or alone on the first line (preClean drops it before JSON; a query that starts with the
 * word, `json parser`, keeps it).
 */
const textArg = (raw: string): string =>
  raw
    .trim()
    .replace(/^json(?:[ \t]*\r?\n|\s*(?=```|~~~))/i, '')
    .trim()
    .replace(/^(?:```|~~~)(?:json|xml|tool_call)?\s*\n?/i, '')
    .replace(/\n?(?:```|~~~)\s*$/, '')
    .trim();

/**
 * D-97: the call a name tag holds (`<NAME>BODY</NAME>`, NAME an offered tool). BODY a JSON object:
 * an envelope `{"name": NAME, "args"|"arguments"|"parameters": …}` (the name may be left out, as in
 * the attribute form) gives its arguments, any other object is the arguments itself. Otherwise, when
 * the tool's schema has exactly one required property and it is a string, the trimmed BODY is that
 * property. An empty BODY is a call without arguments (the tool's own check tells the model what is
 * missing); one cut off at the end of the text is not. Anything else is malformed: an error call.
 */
function readNamedBody(rawBody: string, tool: OfferedTool, closed: boolean): BodyCall {
  const name = tool.name;
  if (rawBody.trim() === '') return closed ? { name, args: '' } : { name, args: '', error: errNamedCut(name) };
  const body = preClean(rawBody);
  if (body.startsWith('{')) {
    if (!closed && !parses(body)) return { name, args: '', error: errNamedCut(name) };
    const parsed = looseJson(body);
    if (!parsed.ok) return { name, args: '', error: errNamedJson(name, parsed.error) };
    if (!isRecord(parsed.value)) return { name, args: '', error: errNamedArgs(name) };
    const v = parsed.value;
    const argKey = (['args', 'arguments', 'parameters'] as const).find((k) => Object.hasOwn(v, k));
    const own = v['name'];
    const sameName = !Object.hasOwn(v, 'name') || (typeof own === 'string' && own.toLowerCase() === name.toLowerCase());
    if (argKey !== undefined && sameName && Object.keys(v).every((k) => k === 'name' || k === argKey)) return { name, args: argsText(v[argKey]) };
    return { name, args: body };
  }
  const arg = soleStringArg(tool.schema);
  if (arg !== undefined) return { name, args: JSON.stringify({ [arg]: textArg(rawBody) }) };
  return { name, args: '', error: errNamedArgs(name) };
}

/** The calls of one span (a block, or a container of blocks). */
function spanCalls(text: string, span: Span, names?: NameTags): BodyCall[] {
  if (span.tool !== undefined) {
    if (span.body === undefined) return [{ name: span.tool.name, args: '', error: errNamedCut(span.tool.name) }];
    return [readNamedBody(text.slice(span.body.start, span.body.end), span.tool, span.closed)];
  }
  if (span.body === undefined) return [{ name: span.nameAttr ?? null, args: '', error: ERR_CUT }];
  if (span.values !== undefined) return span.values.flatMap((v) => readCallBody(text.slice(v.start, v.end), span.nameAttr, false));
  const body = text.slice(span.body.start, span.body.end);
  if (span.kind === 'container') {
    const inner = scanSpans(body, 0, true, undefined, names).spans.filter((s) => s.kind === 'call' || s.kind === 'container');
    if (inner.length > 0) return inner.flatMap((s) => spanCalls(body, s, names));
  }
  return readCallBody(body, span.nameAttr, span.closed);
}

/**
 * Every call block in a prompted reply, in order (§8.3 tolerant parser): `{"name","args"}` and the
 * `arguments` / `parameters` spellings, the attribute form `<tool_call name="x">{…}</tool_call>`, a
 * fence around the block or inside it, an unclosed tag at the end of the text when the JSON inside is
 * complete, `<tool_calls>`/array roots holding several calls (one block each). Text outside blocks is
 * ignored.
 *
 * Also: a block left unclosed before the next opener counts like one at the end; an unclosed block
 * whose body opens with a complete call value and goes on with prose ends right after the value (the
 * prose is text: the strippers keep it, see valueEnd); a python-call body
 * `search_history(query="…")` names the call; blocks from one container or array share its span;
 * a run of blocks with only whitespace between them shares the fence around it (the first block's
 * start and the last one's end take the fence). Nothing after a `<tool_result` is read.
 *
 * `tools` (D-97): the offered tools. `<NAME …>BODY</NAME>` with NAME one of them (any case,
 * whitespace after '<', attributes, an XML prefix) is one call of NAME (readNamedBody), found,
 * fenced, left unclosed and stripped exactly as a `<tool_call>` block; a stray `</NAME>` is removed
 * like a stray `</tool_call>`. Left unclosed, a JSON body ends after its object and a body of text
 * after its first line when more follows, or after its closing fence line when a fence was opened
 * inside the tags (namedEnd). Names not given are never tags; without `tools` the result is exactly
 * the wrapper tags'.
 *
 * A block left empty and ended by the next call's opener (a `<tool_call>` around a name tag, a name
 * tag around a `<tool_call>`, an opener written twice) is a wrapper: markup, not a call. A tag of the
 * family cut off by the end of the text right after an unclosed call value is part of that call (it
 * is cut off); right after a body of text it goes with the block and the text stays the argument.
 */
export function parsePromptedCalls(text: string, tools?: readonly OfferedTool[]): PromptedBlock[] {
  const names = nameTags(tools);
  const { spans } = scanSpans(text, 0, true, undefined, names);
  const { regions } = layout(text, spans, text.length, 0, true);
  const blocks: PromptedBlock[] = [];
  for (const region of regions) {
    region.spans.forEach((span, i) => {
      if (span.kind !== 'call' && span.kind !== 'container') return;
      const start = i === 0 ? region.start : span.start;
      const end = i === region.spans.length - 1 ? region.end : span.end;
      for (const call of spanCalls(text, span, names)) {
        blocks.push({ name: call.name, args: call.args, start, end, ...(call.error !== undefined ? { error: call.error } : {}) });
      }
    });
  }
  return blocks;
}

/**
 * D-97 for leak recovery (tools/leaks.ts): the name-tag blocks of `tools` in a text, in order, each
 * with its own bounds (no fence), whether its closer came (or it closed itself), and its call.
 */
export function findNameTagCalls(text: string, tools: readonly OfferedTool[]): { start: number; end: number; closed: boolean; call: BodyCall }[] {
  const names = nameTags(tools);
  if (names === undefined) return [];
  return scanSpans(text, 0, true, undefined, names)
    .spans.filter((s) => s.tool !== undefined)
    .map((s) => ({ start: s.start, end: s.end, closed: s.closed, call: spanCalls(text, s, names)[0]! }));
}

/**
 * A prompted round's raw text up to the first `<tool_result` tag: what a server that ignored
 * PROMPTED_STOP let the model write after its calls is cut off before the text goes back on the
 * wire. The text itself when there is none (the usual case).
 */
export function cutAtPromptedStop(text: string): string {
  const tail = scanSpans(text, 0, true).spans.find((s) => s.kind === 'result');
  return tail === undefined ? text : text.slice(0, tail.start);
}

// ---- results ------------------------------------------------------------------------------------

/** An attribute value that cannot break the tag (names and ids are safe already; this is a guard). */
const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * One user message's text with a round's results (§8.3), in call order:
 * `<tool_result name="<name>" id="<id>">\n<text>\n</tool_result>` joined by a blank line; a
 * '</tool_result' inside a text is written '<\/tool_result' so the frame cannot break. `cue` (the
 * final-round cue) follows after a blank line when given.
 *
 * The escape ignores case (`</TOOL_RESULT` too). No results and a cue: the cue alone.
 */
export function frameResults(results: readonly { name: string; id: string; text: string }[], cue?: string): string {
  const parts = results.map((r) => `<tool_result name="${attr(r.name)}" id="${attr(r.id)}">\n${r.text.replace(/<\/(tool_result)/gi, '<\\/$1')}\n</tool_result>`);
  if (cue !== undefined && cue !== '') parts.push(cue);
  return parts.join('\n\n');
}
