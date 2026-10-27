// Ported from RoleCall:apps/rc/src/lib/ai/tool-call-repair/{index,layer1-jsonrepair,layer2-schema,layer3-validate}.ts@fb8dc623e
// (the size limit, empty → {}, TEMPLATE_MARKERS, the python-call and missing-brace pre-passes, the
// scalar coercions of coerceScalar, the array-slot salvage and the layer-3 checks).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tool-call arguments (ARCHITECTURE.md §9.1, D-56): the chain that turns whatever a model wrote
// into the object a tool gets, or into an error the model can act on. Never invents a missing
// required value and never drops a field silently (RoleCall's layer 2 did both).
// CONTRACT FILE (M3): signatures are fixed; the tools-parse agent implements the bodies.
//
// Port notes. Kept: the 1 MiB limit (UTF-16 length first, then UTF-8 bytes), "" / "null" → {},
// RoleCall's TEMPLATE_MARKERS regex (anchored at the end, at most 6 passes), strict JSON.parse
// first, then the python-call and missing-brace pre-passes and jsonrepair 3.14.0; the lossless
// coercions: "3" → 3, "true" → true, a number or boolean → string, a case-only enum mismatch, the
// null markers of a nullable slot, "" / "null" / "none" → [] in an array slot, a JSON-encoded array
// string → the array, a scalar → a one-item array; the layer-3 checks (type, required, minimum,
// maximum, additionalProperties:false). Changed: the empty check runs again after the markers are
// cut ("</tool_call>" alone is {}); the python pre-pass leaves string literals alone and returns the
// function name (pythonCall), and it reads the same shapes in linear time (RoleCall's whole-text
// pattern was cubic and its string pattern quadratic on adversarial text); the root must be an
// object (jsonrepair turns prose into a string);
// an array root is unwrapped only when it holds exactly one object; "4.7" for an integer is an error,
// not 4. Added: enum, minLength/maxLength (code points), minItems/maxItems,
// exclusiveMinimum/exclusiveMaximum checks; `repaired` notes; the error text of §9.1. Not ported:
// the schema-parser cascade, the layer-4 re-call, x-accept-rich, the enum alias map, filling
// required fields with type defaults, the null-marker → false/0/"" coercions, dropping unknown
// keys, invalid array items or mismatched optional fields, the array → "a, b" and object →
// "k: v" string flattening, wrapping a lone object into an array, the Gemini "with1" key rename.

import { jsonrepair } from 'jsonrepair';
import type { JSONSchema } from '../providers/types.ts';

/** D-56 step 1: arguments longer than this (UTF-8 bytes) are refused unread. */
export const MAX_ARGS_BYTES = 1 << 20;
/** §9.1: the error the model gets is at most this many characters. */
export const ARGS_ERROR_MAX = 500;

export type ArgsResult =
  | { ok: true; value: Record<string, unknown>; repaired: string[] }
  | { ok: false; error: string; repaired: string[] };

// ---- small helpers ------------------------------------------------------------------------------

type Schema = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 'null', 'array', 'object', 'string', 'number', 'boolean', 'undefined'. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typesOf(schema: Schema): string[] {
  const t = schema['type'];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return typeof t === 'string' ? [t] : [];
}

/** Does `v` have one of the schema's types (no type: anything goes)? */
function hasType(v: unknown, schema: Schema): boolean {
  const types = typesOf(schema);
  if (types.length === 0) return true;
  const actual = typeOf(v);
  return types.some((t) => t === actual || (t === 'integer' && actual === 'number' && Number.isInteger(v)));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const utf8 = new TextEncoder();

// ---- steps 1–5: text → value ----------------------------------------------------------------------

/**
 * RoleCall's TEMPLATE_MARKERS (index.ts 113–119), without the /g flag: a chat-template close tag
 * leaked after the arguments. Anchored at the end, so a '<' inside a valid value is never touched.
 */
const TEMPLATE_MARKERS =
  /\s*(?:<\/?(?:tool_call|tool_calls|function_call|function|invoke)[^>]*>|<\|(?:tool_calls?_end|im_end|end_of_turn|eot_id|fim_suffix)\|>|\[\/?(?:TOOL_CALLS?|FUNCTION_CALLS?|INST)\])\s*$/i;
const MARKER_PASSES = 6;
/** The markers are looked for in this many trailing characters only (the regex is costly on long text). */
const MARKER_WINDOW = 1024;

/** One pass of the marker cut, on the tail window. */
function cutMarker(s: string): string | null {
  const from = Math.max(0, s.length - MARKER_WINDOW);
  const m = TEMPLATE_MARKERS.exec(s.slice(from));
  return m === null ? null : s.slice(0, from + m.index);
}

/** Blank text or the JSON null: no arguments. */
const isEmptyText = (s: string): boolean => {
  const t = s.trim();
  return t === '' || t.toLowerCase() === 'null';
};

/**
 * The head of the python-call envelope (RoleCall layer 1, `fn(k="v", …)` or `[fn(…)]`): '[', the name,
 * '('. The tail (')', then at most one ']') is checked by hand: RoleCall's one pattern for the whole
 * text, `^\[?\s*(\w+)\s*\(\s*([\s\S]*?)\s*\)\s*\]?\s*$`, backtracks in cubic time on a whitespace run
 * in a call that never closes (a 4 kB newline loop took 25 s, and nothing can interrupt a regex).
 */
const PYTHON_HEAD = /^\[?\s*([A-Za-z_]\w*)\s*\(/;

/**
 * The string literals of a python call's body, in order: what RoleCall's PY_STRING,
 * `/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g`, finds with
 * matchAll (triple quotes first, then quotes with escapes), in linear time: the regex scans to the end
 * again from every quote of a run that never closes (`"\"\"\"…`), quadratic. One scan that fails
 * means every later one of its kind fails too (a later quote of that kind was escaped in it, and the
 * two scans agree from there), so each kind is scanned to the end at most once.
 */
function pyStrings(body: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  /** Per quote: where a search for a closing triple found none (no later one finds one), and a quote whose scan never closed. */
  const tripleNone: Record<string, number> = { '"': Infinity, "'": Infinity };
  const singleFailed: Record<string, number> = { '"': Infinity, "'": Infinity };
  for (let i = 0; i < body.length; ) {
    const c = body[i]!;
    if (c !== '"' && c !== "'") {
      i++;
      continue;
    }
    let end = -1;
    const q3 = c + c + c;
    if (body.startsWith(q3, i) && i + 3 < tripleNone[c]!) {
      const close = body.indexOf(q3, i + 3);
      if (close >= 0) end = close + 3;
      else tripleNone[c] = i + 3;
    }
    if (end < 0 && i < singleFailed[c]!) {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
      if (j < body.length) end = j + 1;
      else singleFailed[c] = i;
    }
    if (end < 0) i++;
    else {
      out.push({ start: i, end });
      i = end;
    }
  }
  return out;
}

/** The closing ']' of `[fn(…)]`, whitespace before it. */
const PY_CLOSE_BRACKET = /\s*\]/y;
/** A head longer than this (a whitespace run before the name or the '(') is not looked at. */
const PY_HEAD_MAX = 1024;

/**
 * Index just past a whole python call (`fn(…)` or `[fn(…)]`) that starts at `at`, within [at, limit);
 * -1 when the text there is not one or it never closes. Parentheses inside string literals (the
 * pyStrings forms) do not count. Linear. Used by the prompted parser to end a block left unclosed
 * after a complete call (tools/prompted.ts).
 */
export function pythonCallEnd(text: string, at: number, limit: number = text.length): number {
  const head = PYTHON_HEAD.exec(text.slice(at, Math.min(limit, at + PY_HEAD_MAX)));
  if (head === null) return -1;
  let depth = 1;
  for (let k = at + head[0].length; k < limit; k++) {
    const c = text[k]!;
    if (c === '"' || c === "'") {
      const q3 = c.repeat(3);
      if (text.startsWith(q3, k)) {
        const close = text.indexOf(q3, k + 3);
        if (close < 0 || close + 3 > limit) return -1;
        k = close + 2;
        continue;
      }
      let j = k + 1;
      while (j < limit && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= limit) return -1;
      k = j;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      if (!head[0].startsWith('[')) return k + 1;
      PY_CLOSE_BRACKET.lastIndex = k + 1;
      const close = PY_CLOSE_BRACKET.exec(text);
      return close !== null && k + 1 + close[0].length <= limit ? k + 1 + close[0].length : k + 1;
    }
  }
  return -1;
}

/** A python string literal as a JSON string. */
function pyStringToJson(lit: string): string {
  if (lit.startsWith('"""') || lit.startsWith("'''")) return JSON.stringify(lit.slice(3, -3));
  if (lit.startsWith('"')) {
    try {
      return JSON.stringify(JSON.parse(lit) as string);
    } catch {
      return JSON.stringify(lit.slice(1, -1));
    }
  }
  // 'single quoted': \' is a quote, other escapes are kept for JSON.
  const inner = lit.slice(1, -1).replace(/\\'/g, "'");
  try {
    return JSON.stringify(JSON.parse(`"${inner.replace(/"/g, '\\"')}"`) as string);
  } catch {
    return JSON.stringify(inner);
  }
}

/**
 * D-56 step 5, the python-call pre-pass: `search_history(query="брат", limit=5)` (llama-4-scout and
 * kin) → `{name: 'search_history', json: '{"query": "брат", "limit": 5}'}`; null when the text is not
 * that shape. String literals are left alone (RoleCall rewrote `k = v` and True/False/None inside
 * them too), and the function name is returned (a prompted block needs it as the call's name).
 */
export function pythonCall(text: string): { name: string; json: string } | null {
  const s = text.trim();
  const head = PYTHON_HEAD.exec(s);
  if (head === null) return null;
  // The tail: ')' last, after it at most one ']' with whitespace before it.
  const tail = s.endsWith(']') ? s.slice(0, -1).trimEnd() : s;
  if (tail.length <= head[0].length || !tail.endsWith(')')) return null;
  const body = tail.slice(head[0].length, -1).trim();
  let out = '';
  let at = 0;
  const code = (chunk: string): string =>
    chunk
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
      .replace(/(^|[,({[\s])([A-Za-z_]\w*)\s*=\s*/g, '$1"$2": ');
  for (const lit of pyStrings(body)) {
    out += code(body.slice(at, lit.start)) + pyStringToJson(body.slice(lit.start, lit.end));
    at = lit.end;
  }
  out = (out + code(body.slice(at))).trim();
  return { name: head[1]!, json: out.startsWith('{') ? out : `{${out}}` };
}

/**
 * D-56 step 5, the missing-brace pre-pass (RoleCall layer 1, verbatim): `{entry_names": […` →
 * `{"entry_names": […`, `{"directive": mood": …` → `{"directive": {"mood": …`, `[name": …` → `[{"name": …`.
 */
function missingBraces(s: string): string {
  return s
    .replace(/^(\s*)\{(\w[\w-]*)":/, '$1{"$2":')
    .replace(/(":\s*)(\w[\w-]*)":/g, '$1{"$2":')
    .replace(/(\[\s*)(\w[\w-]*)":/g, '$1{"$2":');
}

export type LooseJson = { ok: true; value: unknown; repaired: string[] } | { ok: false; error: string; repaired: string[] };

/**
 * D-56 steps 2–5 on a text, with no schema and no root check: blank or "null" → {}, the template
 * markers cut (then blank → {} again), JSON.parse, else the pre-passes and jsonrepair. The value can
 * be anything JSON (jsonrepair turns prose into a string): the caller decides what it accepts.
 * Shared with the prompted parser and leak recovery, so jsonrepair is imported here only.
 */
export function looseJson(text: string): LooseJson {
  const repaired: string[] = [];
  if (isEmptyText(text)) {
    if (text !== '') repaired.push('empty');
    return { ok: true, value: {}, repaired };
  }
  let s = text;
  for (let pass = 0; pass < MARKER_PASSES; pass++) {
    const cut = cutMarker(s);
    if (cut === null) break;
    s = cut;
  }
  if (s !== text) {
    repaired.push('template_markers');
    if (isEmptyText(s)) return { ok: true, value: {}, repaired };
  }
  try {
    return { ok: true, value: JSON.parse(s) as unknown, repaired };
  } catch {
    // repaired below
  }
  const py = pythonCall(s);
  let t = s;
  if (py !== null) {
    t = py.json;
    repaired.push('python_call');
  }
  const braced = missingBraces(t);
  if (braced !== t) repaired.push('missing_braces');
  try {
    return { ok: true, value: JSON.parse(braced) as unknown, repaired };
  } catch {
    // jsonrepair below
  }
  try {
    const value = JSON.parse(jsonrepair(braced)) as unknown;
    repaired.push('jsonrepair');
    return { ok: true, value, repaired };
  } catch (e) {
    return { ok: false, error: `not valid JSON (${e instanceof Error ? e.message : String(e)})`, repaired };
  }
}

// ---- step 7: coercion ---------------------------------------------------------------------------

const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const NULL_MARKERS = new Set(['null', 'none', '']);

/** Path of a child for notes and errors: `limit`, `ids[0]`, `a.b`. */
const childPath = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/**
 * The lossless coercions of RoleCall's coerceScalar and array-slot salvage, recursively (flat
 * schemas need only one level, array items the second). Each change adds `coerce:<path>`; a value
 * that cannot be coerced is returned as is for validation to report.
 */
function coerce(v: unknown, schema: Schema, path: string, notes: Set<string>): unknown {
  const types = typesOf(schema);
  const note = (): void => void notes.add(`coerce:${path || '$'}`);

  if (isRecord(v)) {
    const props = isRecord(schema['properties']) ? (schema['properties'] as Record<string, Schema>) : null;
    if (props === null) return v;
    let out: Record<string, unknown> | null = null;
    for (const [k, child] of Object.entries(v)) {
      const sub = props[k];
      if (!Object.hasOwn(props, k) || !isRecord(sub)) continue;
      const c = coerce(child, sub, childPath(path, k), notes);
      if (c !== child) (out ??= { ...v })[k] = c;
    }
    return out ?? v;
  }

  if (Array.isArray(v)) {
    const items = schema['items'];
    if (!isRecord(items)) return v;
    let out: unknown[] | null = null;
    v.forEach((item, i) => {
      const c = coerce(item, items, `${path}[${i}]`, notes);
      if (c !== item) (out ??= [...v])[i] = c;
    });
    return out ?? v;
  }

  // A nullable slot: "null" / "none" mean null (and "" too where a string is not allowed anyway).
  if (types.includes('null') && typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'null' || t === 'none' || (t === '' && !types.includes('string'))) {
      note();
      return null;
    }
  }

  if (types.length === 0 || hasType(v, schema)) {
    // Right type already; only a case-only enum mismatch is fixed.
    return enumCase(v, schema, note);
  }

  if (types.includes('array') && typeof v === 'string') {
    const t = v.trim();
    // "" / "null" / "none": the model has no items (RoleCall's Gemini fix).
    if (NULL_MARKERS.has(t.toLowerCase())) {
      note();
      return [];
    }
    // A JSON-encoded array (qwen3-coder writes '["a","b"]').
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) {
          note();
          return coerce(parsed, schema, path, notes);
        }
      } catch {
        // not an encoded array
      }
    }
  }
  if (types.includes('array') && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
    // A lone scalar where a list of them goes: read_lore {ids: "L12"} → ["L12"].
    const items = isRecord(schema['items']) ? (schema['items'] as Schema) : {};
    const one = coerce(v, items, `${path}[0]`, new Set());
    if (hasType(one, items)) {
      note();
      return [one];
    }
  }

  if ((types.includes('number') || types.includes('integer')) && typeof v === 'string') {
    const t = v.trim();
    if (NUMERIC.test(t)) {
      const n = Number(t);
      // "4.7" for an integer stays a string: truncating would change the value.
      if (types.includes('number') || Number.isInteger(n)) {
        note();
        return n;
      }
    }
  }
  if (types.includes('boolean') && typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'false') {
      note();
      return t === 'true';
    }
  }
  if (types.includes('string') && (typeof v === 'number' || typeof v === 'boolean')) {
    note();
    return enumCase(String(v), schema, () => undefined);
  }
  return v;
}

/** A string that differs from one enum value only in case or surrounding spaces becomes that value. */
function enumCase(v: unknown, schema: Schema, note: () => void): unknown {
  const values = schema['enum'];
  if (!Array.isArray(values) || typeof v !== 'string' || values.some((e) => e === v)) return v;
  const key = v.trim().toLowerCase();
  const hit = values.find((e): e is string => typeof e === 'string' && e.toLowerCase() === key);
  if (hit === undefined) return v;
  note();
  return hit;
}

// ---- step 8: validation -------------------------------------------------------------------------

const quote = (path: string): string => `"${path}"`;
const typeName = (schema: Schema): string => {
  const types = typesOf(schema);
  return types.length === 0 ? 'any' : types.join(' or ');
};
const describe = (v: unknown): string => (typeOf(v) === 'number' && Number.isInteger(v) ? 'integer' : typeOf(v));

/** Errors in plain words, in schema order: missing fields, unknown fields, then each field's checks. */
function validate(v: unknown, schema: Schema, path: string, errors: string[]): void {
  const types = typesOf(schema);
  if (types.length > 0 && !hasType(v, schema)) {
    errors.push(
      path === ''
        ? `the arguments must be a JSON object, not ${describe(v)}`
        : `${quote(path)} must be ${typeName(schema)}, not ${describe(v)}`,
    );
    return;
  }
  const values = schema['enum'];
  if (Array.isArray(values) && !values.some((e) => deepEqual(e, v))) {
    errors.push(`${quote(path)} must be one of ${values.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof v === 'number') {
    const num = (k: string): number | undefined => (typeof schema[k] === 'number' ? (schema[k] as number) : undefined);
    const min = num('minimum');
    const max = num('maximum');
    const xmin = num('exclusiveMinimum');
    const xmax = num('exclusiveMaximum');
    if (min !== undefined && v < min) errors.push(`${quote(path)} must be at least ${min}`);
    if (max !== undefined && v > max) errors.push(`${quote(path)} must be at most ${max}`);
    if (xmin !== undefined && v <= xmin) errors.push(`${quote(path)} must be more than ${xmin}`);
    if (xmax !== undefined && v >= xmax) errors.push(`${quote(path)} must be less than ${xmax}`);
  }
  if (typeof v === 'string') {
    const len = [...v].length;
    if (typeof schema['maxLength'] === 'number' && len > schema['maxLength']) {
      errors.push(`${quote(path)} must be at most ${schema['maxLength']} characters long`);
    }
    if (typeof schema['minLength'] === 'number' && len < schema['minLength']) {
      errors.push(`${quote(path)} must be at least ${schema['minLength']} characters long`);
    }
  }
  if (Array.isArray(v)) {
    if (typeof schema['maxItems'] === 'number' && v.length > schema['maxItems']) {
      errors.push(`${quote(path)} must have at most ${schema['maxItems']} items`);
    }
    if (typeof schema['minItems'] === 'number' && v.length < schema['minItems']) {
      errors.push(`${quote(path)} must have at least ${schema['minItems']} items`);
    }
    const items = schema['items'];
    if (isRecord(items)) v.forEach((item, i) => validate(item, items, `${path}[${i}]`, errors));
  }
  if (isRecord(v)) {
    const props = isRecord(schema['properties']) ? (schema['properties'] as Record<string, Schema>) : {};
    const required = Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : [];
    for (const r of required) {
      if (!Object.hasOwn(v, r) || v[r] === undefined) errors.push(`missing required field ${quote(childPath(path, r))}`);
    }
    if (schema['additionalProperties'] === false) {
      const allowed = Object.keys(props);
      for (const k of Object.keys(v)) {
        if (!Object.hasOwn(props, k)) {
          errors.push(`unknown field ${quote(childPath(path, k))} (allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none'})`);
        }
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (Object.hasOwn(v, k) && v[k] !== undefined && isRecord(sub)) validate(v[k], sub, childPath(path, k), errors);
    }
  }
}

// ---- the chain ----------------------------------------------------------------------------------

const GUIDANCE = 'Send one complete JSON object that matches the schema.';
const DETAIL_MAX = 300;
const NAME_MAX = 64;

/** §9.1 / RoleCall formatToolRepairFailure: one line, control characters gone, at most ARGS_ERROR_MAX. */
function argsError(toolName: string, detail: string): string {
  const clean = (s: string, max: number): string => {
    const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const d = clean(detail, DETAIL_MAX).replace(/[.;:,\s]+$/, '');
  return `Invalid arguments for ${clean(toolName, NAME_MAX)}: ${d}. ${GUIDANCE}`.slice(0, ARGS_ERROR_MAX);
}

/** Validation errors as one detail: the first three, then how many more. */
function summarise(errors: string[]): string {
  const head = errors.slice(0, 3).join('; ');
  return errors.length > 3 ? `${head} (and ${errors.length - 3} more)` : head;
}

/**
 * D-56, in this order:
 * 1. more than MAX_ARGS_BYTES → error;
 * 2. undefined, null, '' or whitespace → {};
 * 3. template markers stripped (RoleCall TEMPLATE_MARKERS, anchored at the end; valid JSON untouched);
 * 4. JSON.parse;
 * 5. on failure: the pre-passes (python-call form, missing braces) and jsonrepair; the root must be
 *    an object after repair (jsonrepair turns prose into a JSON string: that is an error);
 * 6. an array root with exactly one object is unwrapped (several objects: error);
 * 7. scalars coerced by the schema ("3" → 3 for integer/number, "true" → true, a number → string);
 * 8. validation: type, required (never filled in), enum, maxLength, minimum/maximum,
 *    additionalProperties:false (an unknown key is an error, not dropped).
 * `repaired` names each step that changed something ('template_markers', 'jsonrepair',
 * 'python_call', 'array_root', 'coerce:<field>', …). A plain-object input is validated as is.
 * The error starts "Invalid arguments for <toolName>:", says what is wrong, and ends with
 * "Send one complete JSON object that matches the schema."; at most ARGS_ERROR_MAX characters.
 *
 * Notes: 'empty' marks whitespace or the text "null" read as {} ('' and undefined/null are just "no
 * arguments"); 'missing_braces' marks the second pre-pass. A plain object (or array) skips steps
 * 1–5 and still gets 6–8. Any other non-string input is an error.
 */
export function parseToolArgs(raw: unknown, schema: JSONSchema, toolName: string): ArgsResult {
  const fail = (detail: string, repaired: string[]): ArgsResult => ({ ok: false, error: argsError(toolName, detail), repaired });
  let value: unknown;
  let repaired: string[] = [];

  if (raw === undefined || raw === null) value = {};
  else if (typeof raw === 'string') {
    // 1. Size: the UTF-16 length bounds the bytes from below, so a long text fails before encoding.
    if (raw.length > MAX_ARGS_BYTES) return fail(`the arguments are at least ${raw.length} bytes, over the ${MAX_ARGS_BYTES}-byte limit`, []);
    const bytes = utf8.encode(raw).byteLength;
    if (bytes > MAX_ARGS_BYTES) return fail(`the arguments are ${bytes} bytes, over the ${MAX_ARGS_BYTES}-byte limit`, []);
    // 2–5.
    const r = looseJson(raw);
    repaired = r.repaired;
    if (!r.ok) return fail(`the arguments are ${r.error}`, repaired);
    value = r.value;
  } else if (typeof raw === 'object') value = raw;
  else return fail(`the arguments must be a JSON object, not ${describe(raw)}`, []);

  // 6. An array root: one object is unwrapped; anything else would drop or invent.
  if (Array.isArray(value)) {
    if (value.length === 1 && isRecord(value[0])) {
      value = value[0];
      repaired = [...repaired, 'array_root'];
    } else {
      const objects = value.filter(isRecord).length;
      const what = objects > 1 ? `${objects} objects` : `${value.length} item${value.length === 1 ? '' : 's'}`;
      return fail(`the arguments are an array of ${what}, not one object (one call per tool call)`, repaired);
    }
  }
  if (!isRecord(value)) {
    return fail(
      typeof value === 'string' ? 'the arguments are text, not a JSON object' : `the arguments must be a JSON object, not ${describe(value)}`,
      repaired,
    );
  }

  // 7–8.
  const notes = new Set<string>();
  const coerced = coerce(value, schema, '', notes) as Record<string, unknown>;
  if (notes.size > 0) repaired = [...repaired, ...notes];
  const errors: string[] = [];
  validate(coerced, schema, '', errors);
  if (errors.length > 0) return fail(summarise(errors), repaired);
  return { ok: true, value: coerced, repaired };
}

/** Values sorted for canonical output: object keys at every level; undefined members dropped as JSON does. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** JSON with object keys sorted at every level: the identity of a call's arguments (loop guard, duplicates). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}
