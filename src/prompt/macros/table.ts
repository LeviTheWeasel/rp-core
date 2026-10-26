// Ported from Bunraku:src/core/macros/handlers/{identity,text,random,time,variables}.ts@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The closed macro table of ARCHITECTURE.md §10.4: ~25 names, no registration API. A name that is
// not here is unknown and stays literal. Changes from Bunraku, and why:
// - {{random}} is ST's list pick only (D-43): RoleCall's numeric ranges are rewritten by the
//   importer, not read here. {{pick}} is ST's getPickReplaceMacro: a hash-seeded index that holds
//   across turns and swipes, instead of RoleCall's `_pick_` chat variable.
// - {{roll}} follows ST's droll reading ('20' means '1d20'); an invalid formula renders '' as in ST.
// - Card fields and {{original}} return templates for the evaluator to expand (D-42); identity and
//   variable values are inert and never re-scanned.
// - Variables are string | number (PathView.vars). addvar/incvar/decvar follow ST's addLocalVariable:
//   numeric when both sides are numbers, otherwise string concatenation.
// - Time macros read env.now in env.timeZone through Intl, en-US like ST's moment 'LT'/'LL'/'dddd'.

import type { MacroEnv } from '../macros.ts';
import { TRIM_MARK } from './lex.ts';

/** What a handler sees of the run. */
export interface CallCx {
  env: MacroEnv;
  /** {{original}} of the current block ('' outside an override). */
  original: string;
  /** {{original}} for this occurrence: the text the first time in a block, '' after (ST). */
  takeOriginal(): string;
  /** Next draw of the block's 'macro:<source>' stream. */
  random(): number;
  /** Stable index in [0, n) for this {{pick}} call (D-43). */
  pickIndex(n: number): number;
  getVar(name: string): string | number | undefined;
  setVar(name: string, value: string | number): void;
}

export type MacroResult =
  /** Inert text: inserted as is. */
  | { text: string }
  /** A template (D-42): expanded in the same pass; `key` guards against self-reference. */
  | { template: string; key: string }
  /** Malformed call: the macro stays literal. */
  | null;

export interface MacroDef {
  /** Calls with fewer args stay literal and their args are not evaluated (no side effects). */
  minArgs: number;
  run(args: string[], cx: CallCx): MacroResult;
}

const text = (t: string): MacroResult => ({ text: t });
const tpl = (template: string, key: string): MacroResult => ({ template, key });

// ---- lists: {{random}} / {{pick}} ---------------------------------------------------------------

/**
 * ST's list reading: several `::` args are the list (empty ones dropped, as ST's legacy split did);
 * a single arg is split on commas, `\,` being a literal comma (ST readSingleArgsRandomList).
 */
export function readList(args: readonly string[]): string[] {
  if (args.length !== 1) return args.filter((a) => a.length > 0);
  const only = args[0] ?? '';
  if (!only.includes(',')) return only.length > 0 ? [only] : [];
  const HOLD = '\u0000';
  return only
    .replace(/\\,/g, HOLD)
    .split(',')
    .map((s) => s.trim().replaceAll(HOLD, ','));
}

// ---- dice ---------------------------------------------------------------------------------------

const DICE = /^(\d*)d(\d+)([+-]\d+)?$/i;
const MAX_DICE = 1000;
const MAX_SIDES = 1_000_000;

/** NdS[+-M] (droll's grammar); digits alone mean 1dN. Null when invalid or out of bounds. */
export function rollDice(formula: string, random: () => number): number | null {
  let f = formula.replace(/\s+/g, '');
  if (/^\d+$/.test(f)) f = `1d${f}`;
  const m = DICE.exec(f);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const mod = m[3] ? Number(m[3]) : 0;
  if (count < 1 || count > MAX_DICE || sides < 1 || sides > MAX_SIDES) return null;
  let total = mod;
  for (let i = 0; i < count; i++) total += Math.floor(random() * sides) + 1;
  return total;
}

// ---- time ---------------------------------------------------------------------------------------

/**
 * Format env.now in env.timeZone, en-US. An unknown zone falls back to UTC rather than throwing; an
 * unparseable instant renders ''. ICU may put U+202F/U+00A0 before AM/PM; ST shows a plain space.
 */
export function formatNow(env: MacroEnv, opts: Intl.DateTimeFormatOptions): string {
  const at = new Date(env.now);
  if (Number.isNaN(at.getTime())) return '';
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: env.timeZone || 'UTC' });
  } catch {
    f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
  }
  return f.format(at).replace(/[  ]/g, ' ');
}

// ---- variables ----------------------------------------------------------------------------------

/** Lossless numeric reading: '5' → 5, but '05', '1.50', '1e3' stay strings so nothing is rewritten. */
export function toVarValue(s: string): string | number {
  if (s.trim() === '' || s !== s.trim()) return s;
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : s;
}

/** ST's isNaN(Number(x)) test, minus the '' → 0 quirk on the incoming value. */
const isNumeric = (v: string | number): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : v.trim() !== '' && Number.isFinite(Number(v));

/** ST addLocalVariable: sum when both sides are numeric, else concatenate. Missing counts as 0. */
export function addValue(current: string | number | undefined, delta: string): string | number {
  const cur = current === undefined || current === '' ? 0 : current;
  if (isNumeric(cur) && isNumeric(delta)) return Number(cur) + Number(delta);
  return (current === undefined ? '' : String(current)) + delta;
}

/** Extra `::` parts of a value are part of the value, as ST's `([^}]+)` capture had it. */
const valueArg = (args: readonly string[]): string => args.slice(1).join('::');

function addvarLike(args: string[], cx: CallCx, delta: string, echo: boolean): MacroResult {
  const name = args[0] ?? '';
  if (!name) return null;
  const next = addValue(cx.getVar(name), delta);
  cx.setVar(name, next);
  return text(echo ? String(next) : '');
}

// ---- the table ----------------------------------------------------------------------------------

const card = (pick: (env: MacroEnv) => string, key: string): MacroDef => ({ minArgs: 0, run: (_a, cx) => tpl(pick(cx.env), key) });

const DEFS: Record<string, MacroDef> = {
  // identity
  char: { minArgs: 0, run: (_a, cx) => text(cx.env.char) },
  user: { minArgs: 0, run: (_a, cx) => text(cx.env.user) },

  // card and persona: templates (D-42); one cycle key per field, shared by its aliases
  description: card((e) => e.card.description, 'description'),
  personality: card((e) => e.card.personality, 'personality'),
  scenario: card((e) => e.card.scenario, 'scenario'),
  persona: card((e) => e.persona, 'persona'),
  examples: card((e) => e.card.examples, 'examples'),
  mesexamples: card((e) => e.card.examples, 'examples'),
  mes_example: card((e) => e.card.examples, 'examples'),
  system_prompt: card((e) => e.card.systemPrompt, 'system_prompt'),
  charprompt: card((e) => e.card.systemPrompt, 'system_prompt'),
  post_history: card((e) => e.card.postHistory, 'post_history'),
  charinstruction: card((e) => e.card.postHistory, 'post_history'),
  first_message: card((e) => e.card.firstMessage, 'first_message'),
  firstmessage: card((e) => e.card.firstMessage, 'first_message'),
  // ST substitutes {{original}} once per prompt text; later occurrences render ''.
  original: { minArgs: 0, run: (_a, cx) => tpl(cx.takeOriginal(), 'original') },

  // text ({{// …}} is a lexer node, never looked up here)
  trim: { minArgs: 0, run: () => text(TRIM_MARK) },
  newline: { minArgs: 0, run: () => text('\n') },

  // random and time
  random: {
    minArgs: 0,
    run: (args, cx) => {
      const list = readList(args);
      return text(list.length === 0 ? '' : (list[Math.floor(cx.random() * list.length)] ?? ''));
    },
  },
  pick: {
    minArgs: 0,
    run: (args, cx) => {
      const list = readList(args);
      return text(list.length === 0 ? '' : (list[cx.pickIndex(list.length)] ?? ''));
    },
  },
  roll: {
    minArgs: 1,
    run: (args, cx) => {
      const total = rollDice(args.join('::'), () => cx.random());
      return text(total === null ? '' : String(total));
    },
  },
  time: { minArgs: 0, run: (_a, cx) => text(formatNow(cx.env, { hour: 'numeric', minute: '2-digit', hour12: true })) },
  date: { minArgs: 0, run: (_a, cx) => text(formatNow(cx.env, { month: 'long', day: 'numeric', year: 'numeric' })) },
  weekday: { minArgs: 0, run: (_a, cx) => text(formatNow(cx.env, { weekday: 'long' })) },

  // variables
  getvar: {
    minArgs: 1,
    run: (args, cx) => {
      const name = args[0] ?? '';
      if (!name) return null;
      const v = cx.getVar(name);
      return text(v === undefined ? '' : String(v));
    },
  },
  setvar: {
    minArgs: 2,
    run: (args, cx) => {
      const name = args[0] ?? '';
      if (!name) return null;
      cx.setVar(name, toVarValue(valueArg(args)));
      return text('');
    },
  },
  addvar: { minArgs: 2, run: (args, cx) => addvarLike(args, cx, valueArg(args), false) },
  incvar: { minArgs: 1, run: (args, cx) => addvarLike(args, cx, '1', true) },
  decvar: { minArgs: 1, run: (args, cx) => addvarLike(args, cx, '-1', true) },
};

/** Lookup by lowercased name. Own properties only, so {{constructor}} or {{__proto__}} is unknown. */
export function lookupMacro(name: string): MacroDef | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(DEFS, key) ? DEFS[key] : undefined;
}

/** Every name in the table (lowercase), for tests and docs. */
export const MACRO_NAMES: readonly string[] = Object.keys(DEFS);
