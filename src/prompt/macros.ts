// Ported from Bunraku:src/core/macros/{evaluate,process,limits,registry}.ts@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The macro engine (ARCHITECTURE.md §10.4, D-42, D-43, D-44). Adapted from Bunraku src/core/macros
// (lexer/evaluator) without block forms; closed table of ~25 macros.
// CONTRACT FILE: signatures are fixed; the macros agent implements the bodies.
//
// Kept from Bunraku: args evaluate depth-first and trimmed, side effects land at once so later
// macros see them, depth limit 100, a cap on output length and on steps so an expansion bomb ends
// instead of hanging. Changed: unknown macros stay literal (RoleCall stripped them and lost
// {{mes_example}}) with the known macros inside them resolved, as in ST (Bunraku left the whole
// wrapper unevaluated); {{original}} expands once per block, as in ST; only card fields and
// {{original}} are re-expanded (D-42), never variable values
// or names; a field that refers back to itself while it is being expanded renders '' (cycle guard);
// one RNG sub-stream per block source (D-44) instead of a run-wide counter; {{pick}} seeds on
// (session, source, template text, offset) like ST (D-43). Variables go to an overlay, not a store.

import type { VarsDiff } from '../session/entries.ts';
import { braceMatches, finish, normalize, parse, parseRange, type MacroNode, type Node } from './macros/lex.ts';
import { lookupMacro, toVarValue, type CallCx, type MacroResult } from './macros/table.ts';
import { hashString, mulberry32, subRng, type Rng } from './rng.ts';

/** Structural slots placed by assemble, passed through untouched by the macro engine. */
export const STRUCTURAL_SLOTS = ['history', 'recap', 'lore::*', 'outlet::*', 'slot::*'] as const;

/** Deepest nesting evaluated (args and D-42 template expansions); deeper renders '' (RoleCall's limit). */
export const MAX_MACRO_DEPTH = 100;
/** Longest string one block may produce. */
export const MAX_MACRO_OUTPUT = 1_000_000;
/** Nodes evaluated per block, so a wide template cannot stand in for a deep one. */
export const MAX_MACRO_STEPS = 1_000_000;

/** True for {{history}}, {{recap}}, {{lore::x}}, {{outlet::x}}, {{slot::x}} (case-insensitive name). */
export function isStructuralSlot(macroBody: string): boolean {
  let body = macroBody.trim();
  // Accept the whole tag too: callers scanning assembled text have braces in hand.
  if (body.startsWith('{{') && body.endsWith('}}')) body = body.slice(2, -2);
  const parts = body.split('::');
  const name = (parts[0] ?? '').trim().toLowerCase();
  if (name === 'history' || name === 'recap') return parts.length === 1;
  if (name === 'lore' || name === 'outlet' || name === 'slot') return parts.length === 2 && (parts[1] ?? '').trim() !== '';
  return false;
}

export interface MacroEnv {
  /** {{char}} */
  char: string;
  /** {{user}} — the persona name, 'User' when none. */
  user: string;
  /** Raw card fields. Their values are templates too (D-42): expanded in the same pass, depth limit 100. */
  card: {
    description: string;
    personality: string;
    scenario: string;
    examples: string;
    systemPrompt: string;
    postHistory: string;
    firstMessage: string;
  };
  /** {{persona}} — persona description. */
  persona: string;
  /** Session variables before this turn (PathView.vars). */
  vars: Record<string, string | number>;
  /** ISO instant of the turn (TurnEntry.now). */
  now: string;
  /** IANA zone for {{time}}/{{date}}/{{weekday}}. */
  timeZone: string;
  /** The turn seed. {{random}}/{{roll}} use subRng(seed, 'macro:' + source). */
  seed: number;
  /** {{pick}} is stable per session: seeded from hash(sessionId, source, block text, offset) [D-43]. */
  sessionId: string;
}

export interface MacroRun {
  /**
   * Expand a template block once. `source` labels the RNG sub-stream and the pick seed (use the
   * preset block id, 'author_note', 'card_depth', ...). `original` is what {{original}} expands to
   * inside an override block. Structural slots pass through untouched. Unknown macros stay literal
   * and are recorded. setvar/addvar/incvar update an overlay visible to later blocks of this run.
   */
  block(text: string, source: string, opts?: { original?: string }): string;
  /** User-typed text: only identity macros ({{char}}, {{user}}), read-only; everything else stays literal. */
  userText(text: string): string;
  /** Variables changed in this run (null = deleted). */
  varsDiff(): VarsDiff;
  /** Unknown macro names seen in this run, unique, in order of appearance. */
  unknown(): string[];
}

/** Names worth reporting as unknown: identifier-like, so `{{"a": 1}}` in a JSON sample is not noise. */
const REPORTABLE = /^[#/.$]?[\p{L}\p{N}_][\p{L}\p{N}_.\-]*$/u;

/** Identity only, for user-typed text; `\{{` stays as typed. */
const USER_TEXT = /(?<!\\)\{\{\s*(char|user)\s*\}\}|<(user|bot|char)>/gi;

/** pick's seed parts are joined with a byte that cannot occur in a session id or block source. */
const SEP = '\u0000';

/** Per-block evaluation state. */
interface BlockState {
  source: string;
  original: string;
  /** {{original}} already expanded in this block: ST substitutes it once, later ones render ''. */
  originalUsed: boolean;
  steps: number;
  /** A bound tripped: nothing more is evaluated in this block. */
  stopped: boolean;
  /** Template keys being expanded right now (D-42 cycle guard). */
  active: Set<string>;
}

/** The template being evaluated: its normalized text (node offsets point into it) and raw form. */
interface Frame {
  text: string;
  raw: string;
  /** Brace pairs of `text`, computed on first need (re-parsing an unknown macro's body). */
  pairs?: Map<number, number>;
}

export function createMacroRun(env: MacroEnv): MacroRun {
  const overlay = new Map<string, string | number>();
  const unknownSeen = new Set<string>();
  const unknownList: string[] = [];
  const streams = new Map<string, Rng>();

  const baseVar = (name: string): string | number | undefined => (Object.hasOwn(env.vars, name) ? env.vars[name] : undefined);
  const getVar = (name: string): string | number | undefined => (overlay.has(name) ? overlay.get(name) : baseVar(name));

  /** One stream per source for the whole run: a repeated source continues, other sources are untouched. */
  const streamFor = (source: string): Rng => {
    let rng = streams.get(source);
    if (!rng) {
      rng = subRng(env.seed, 'macro:' + source);
      streams.set(source, rng);
    }
    return rng;
  };

  function evalNodes(nodes: Node[], frame: Frame, bs: BlockState, depth: number): string {
    let out = '';
    for (const node of nodes) {
      if (bs.stopped) break;
      if (++bs.steps > MAX_MACRO_STEPS) {
        bs.stopped = true;
        break;
      }
      if (node.kind === 'text') out += node.value;
      else if (node.kind === 'macro') out += evalMacro(node, frame, bs, depth);
      // comment: renders nothing and its body is never evaluated
      if (out.length > MAX_MACRO_OUTPUT) {
        bs.stopped = true;
        return out.slice(0, MAX_MACRO_OUTPUT);
      }
    }
    return out;
  }

  function evalMacro(node: MacroNode, frame: Frame, bs: BlockState, depth: number): string {
    if (depth > MAX_MACRO_DEPTH) return '';
    const raw = frame.text.slice(node.start, node.end);
    if (isStructuralSlot(node.body)) return raw;
    const def = lookupMacro(node.name);
    if (!def) {
      if (REPORTABLE.test(node.name) && !unknownSeen.has(node.name)) {
        unknownSeen.add(node.name);
        unknownList.push(node.name);
      }
      return unknownMacro(node, frame, bs, depth);
    }
    if (node.args.length < def.minArgs) return raw;
    const args = node.args.map((a) => evalNodes(a, frame, bs, depth + 1).trim());
    if (bs.stopped) return '';
    const cx: CallCx = {
      env,
      original: bs.original,
      takeOriginal: () => {
        if (bs.originalUsed) return '';
        bs.originalUsed = true;
        return bs.original;
      },
      random: () => streamFor(bs.source)(),
      pickIndex: (n) => Math.floor(mulberry32(hashString([env.sessionId, bs.source, frame.raw, node.start].join(SEP)))() * n),
      getVar,
      setVar: (name, value) => {
        overlay.set(name, typeof value === 'string' ? toVarValue(finish(value)) : value);
      },
    };
    const result: MacroResult = def.run(args, cx);
    if (result === null) return raw;
    if ('text' in result) return result.text;
    return expandTemplate(result.template, result.key, bs, depth + 1);
  }

  /**
   * An unknown macro stays literal, as in ST (§10.4), but like ST it is rebuilt from its body with
   * the known macros inside already resolved: `{{img::{{char}}_happy}}` sends `{{img::Mira_happy}}`.
   * The body's macros run as anywhere else, side effects included (ST's MacroEngine does the same).
   */
  function unknownMacro(node: MacroNode, frame: Frame, bs: BlockState, depth: number): string {
    const raw = frame.text.slice(node.start, node.end);
    if (!raw.includes('{{', 2)) return raw; // nothing nested: the literal as authored
    frame.pairs ??= braceMatches(frame.text, 0, frame.text.length);
    const body = parseRange(frame.text, node.start + 2, node.end - 2, depth + 1, frame.pairs);
    const inner = evalNodes(body, frame, bs, depth + 1);
    return bs.stopped ? '' : `{{${inner}}}`;
  }

  /** D-42: a substituted card field is a template, expanded here, in the same pass. */
  function expandTemplate(template: string, key: string, bs: BlockState, depth: number): string {
    if (template === '' || depth > MAX_MACRO_DEPTH) return '';
    if (bs.active.has(key)) return ''; // refers back to itself: stop the cycle here
    bs.active.add(key);
    try {
      const text = normalize(template);
      return evalNodes(parse(text), { text, raw: template }, bs, depth);
    } finally {
      bs.active.delete(key);
    }
  }

  return {
    block(text, source, opts) {
      const bs: BlockState = { source, original: opts?.original ?? '', originalUsed: false, steps: 0, stopped: false, active: new Set() };
      const normalized = normalize(text);
      return finish(evalNodes(parse(normalized), { text: normalized, raw: text }, bs, 0));
    },

    userText(text) {
      return text.replace(USER_TEXT, (_m, a: string | undefined, b: string | undefined) =>
        (a ?? b ?? '').toLowerCase() === 'user' ? env.user : env.char,
      );
    },

    varsDiff() {
      const out: VarsDiff = {};
      for (const [name, value] of overlay) {
        if (baseVar(name) === value) continue; // written back to what it was: no change
        // defineProperty, not assignment: a variable named __proto__ must stay a plain key.
        Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
      }
      return out;
    },

    unknown() {
      return [...unknownList];
    },
  };
}
