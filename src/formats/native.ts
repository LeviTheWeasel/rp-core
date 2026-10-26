// Ported from Bunraku:src/core/canonical.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (canonicalId only).
// Copyright (C) 2026 Coneja-Chibi, Livingooal; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native content formats (ARCHITECTURE.md §5.1, §10.2, D-70). Small on purpose, shaped like
// SillyTavern so importers stay thin. Unknown foreign fields live in `extras` for round-trips.
//
// CONTRACT FILE: the types and BUILTIN_PRESET are fixed by the architect. The formats agent fills
// in the validator bodies and canonicalId below; do not change the exported type shapes.

// The one slot finder, shared with assemble. slots.ts imports only types from this file, so the
// runtime graph has no cycle (assemble → native → slots → macros).
import { historySlots as countHistorySlots } from '../prompt/assemble/slots.ts';

export interface Samplers {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  top_a?: number;
  typical_p?: number;
  repetition_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  stop?: string[];
  max_tokens?: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface Character {
  // format: 'core.character/1'
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  /** [0] is first_mes, the rest are alternate_greetings. May be empty. */
  greetings: string[];
  /** mes_example as-is. */
  examples?: string;
  /** Card overrides (§10.2, D-21). */
  systemPrompt?: string;
  postHistory?: string;
  depthPrompt?: { text: string; depth: number; role: ChatRole };
  book?: LoreBook;
  creator?: string;
  tags?: string[];
  extras?: Record<string, unknown>;
}

export interface Persona {
  // format: 'core.persona/1'
  name: string;
  aliases?: string[];
  description: string;
  book?: LoreBook;
}

export type PresetBlockAt = 'relative' | 'top' | 'bottom' | { depth: number; order?: number };

export interface PresetBlock {
  id: string;
  name?: string;
  role: ChatRole;
  enabled: boolean;
  /** Macros allowed. Structural slots ({{history}}, {{lore::x}}, {{outlet::x}}, {{recap}}, {{slot::director}}) are placed by assemble. */
  content: string;
  at: PresetBlockAt;
  override?: 'card_system' | 'card_post_history';
  extras?: Record<string, unknown>; // [D-70]
}

export interface Preset {
  // format: 'core.preset/1'
  name: string;
  blocks: PresetBlock[];
  forbidOverrides?: boolean;
  samplers?: Partial<Samplers>;
  context?: { maxContext?: number; maxMessages?: number };
  prefill?: string;
  impersonation?: { prompt?: string; prefill?: string };
  postProcessing?: 'none' | 'merge' | 'semi' | 'strict' | 'single';
  /** [D-70] ST wi_format etc., applied to non-empty slot values through `{0}`. */
  formats?: { wi?: string; personality?: string; scenario?: string; newChat?: string; newExampleChat?: string };
  extras?: Record<string, unknown>;
}

export type LorePosition =
  | 'before'
  | 'after'
  | 'examples_before'
  | 'examples_after'
  | 'note_before'
  | 'note_after'
  | 'top'
  | 'bottom'
  | 'recap'
  | { depth: number; role?: ChatRole }
  | { outlet: string };

export interface CompendiumMeta {
  type?: string;
  data?: Record<string, unknown>;
  aliases?: string[];
  featured?: boolean;
  arc?: string;
}

export interface LoreEntry {
  id: string;
  title?: string;
  content: string;
  enabled?: boolean;
  constant?: boolean;
  /** '/re/flags' is a regex (re2js, M2). */
  keys: string[];
  secondary?: string[];
  logic?: 'and_any' | 'and_all' | 'not_any' | 'not_all';
  position: LorePosition;
  /** One ST axis: place in the slot AND budget priority. */
  order?: number;
  probability?: number;
  /** [D-70] several groups allowed. */
  groups?: string[];
  groupWeight?: number;
  scanDepth?: number;
  caseSensitive?: boolean;
  wholeWords?: boolean;
  preventRecursion?: boolean;
  excludeRecursion?: boolean;
  ignoreBudget?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  meta?: CompendiumMeta;
  extras?: Record<string, unknown>; // [D-70]
}

export interface LoreBook {
  // format: 'core.lorebook/1'
  name: string;
  scanDepth?: number;
  recursive?: boolean;
  caseSensitive?: boolean;
  wholeWords?: boolean;
  match?: 'literal' | 'stem';
  entries: LoreEntry[];
  extras?: Record<string, unknown>;
}

/** [D-70] every importer returns its value plus warnings that name what exists but is not honoured. */
export interface ImportWarning {
  code: string;
  path: string;
  message: string;
}
export interface Imported<T> {
  value: T;
  warnings: ImportWarning[];
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: { path: string; message: string }[] };

/**
 * The built-in preset (§10.2 "Раскладка по умолчанию"). Used when SessionConfig.preset is 'builtin'.
 * Blocks that expand to an empty string are dropped by assemble. Structural slots are placed by assemble.
 */
export const BUILTIN_PRESET: Preset = {
  name: 'builtin',
  blocks: [
    {
      id: 'main',
      name: 'Main prompt',
      role: 'system',
      enabled: true,
      content:
        "Write {{char}}'s next reply in a fictional roleplay chat between {{char}} and {{user}}. Stay in character, write vivid prose, and never speak, act or decide for {{user}}.",
      at: 'relative',
      override: 'card_system',
    },
    { id: 'lore_before', role: 'system', enabled: true, content: '{{lore::before}}', at: 'relative' },
    { id: 'description', role: 'system', enabled: true, content: '{{description}}', at: 'relative' },
    { id: 'personality', role: 'system', enabled: true, content: '{{personality}}', at: 'relative' },
    { id: 'scenario', role: 'system', enabled: true, content: '{{scenario}}', at: 'relative' },
    { id: 'lore_after', role: 'system', enabled: true, content: '{{lore::after}}', at: 'relative' },
    { id: 'persona', role: 'system', enabled: true, content: '{{persona}}', at: 'relative' },
    {
      id: 'examples',
      role: 'system',
      enabled: true,
      content: '{{lore::examples_before}}{{examples}}{{lore::examples_after}}',
      at: 'relative',
    },
    { id: 'history', role: 'system', enabled: true, content: '{{history}}', at: 'relative' },
    {
      id: 'post_history',
      name: 'Post-history instructions',
      role: 'system',
      enabled: true,
      content: '',
      at: 'relative',
      override: 'card_post_history',
    },
  ],
  postProcessing: 'none',
};

// ---- implemented by the formats agent -------------------------------------------------------

// canonicalId is adapted from Bunraku:src/core/canonical.ts@702d8120 (Copyright (C) 2026 Coneja-Chibi,
// Livingooal; AGPL-3.0-or-later): NFKC, letter/number runs, Windows device-name guard. Changed: 64
// code-point cap, 'untitled' fallback, and combining marks (\p{M}) are kept so Indic and Thai names
// do not shatter into hyphens.

const ID_MAX = 64;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** NFKC, keep \p{L}\p{N}, lower-case, collapse the rest to '-'; never empty (falls back to 'untitled'). [D-72] */
export function canonicalId(name: string): string {
  const raw = typeof name === 'string' ? name.normalize('NFKC').toLowerCase().normalize('NFKC') : '';
  let slug = raw
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^[-\p{M}]+/u, '') // a leading mark has nothing to attach to
    .replace(/-+$/, '');
  const cps = Array.from(slug);
  if (cps.length > ID_MAX) slug = cps.slice(0, ID_MAX).join('').replace(/-+$/, '');
  if (slug === '') return 'untitled';
  return WIN_RESERVED.test(slug) ? `${slug}-id` : slug;
}

// Validators are hand-written (no Zod): each walks the whole value and reports every problem with
// its path, e.g. `blocks[2].at.depth`. Unknown keys are errors, because foreign data belongs in
// `extras`; an optional `format` tag is accepted when it names the right format.

type VErr = { path: string; message: string };
type Check = (v: unknown, path: string, errs: VErr[]) => void;

const vPath = (base: string, key: string | number): string =>
  typeof key === 'number' ? `${base}[${key}]` : base ? `${base}.${key}` : key;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (errs: VErr[], path: string, message: string): void => {
  errs.push({ path: path || '$', message });
};

const vStr: Check = (v, p, e) => {
  if (typeof v !== 'string') err(e, p, 'must be a string');
};
const vNonEmptyStr: Check = (v, p, e) => {
  if (typeof v !== 'string' || v.trim() === '') err(e, p, 'must be a non-empty string');
};
const vBool: Check = (v, p, e) => {
  if (typeof v !== 'boolean') err(e, p, 'must be a boolean');
};
const vNum: Check = (v, p, e) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) err(e, p, 'must be a finite number');
};
const vCount: Check = (v, p, e) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) err(e, p, 'must be an integer >= 0');
};
const vPositiveInt: Check = (v, p, e) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) err(e, p, 'must be an integer >= 1');
};
const vProbability: Check = (v, p, e) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) err(e, p, 'must be a number from 0 to 100');
};
const vStrArray: Check = (v, p, e) => {
  if (!Array.isArray(v)) return err(e, p, 'must be an array of strings');
  v.forEach((x, i) => vStr(x, vPath(p, i), e));
};
const vRecord: Check = (v, p, e) => {
  if (!isObj(v)) err(e, p, 'must be an object');
};
const vOneOf =
  (options: readonly string[]): Check =>
  (v, p, e) => {
    if (typeof v !== 'string' || !options.includes(v)) err(e, p, `must be one of ${options.map((o) => `'${o}'`).join(', ')}`);
  };
const vRole = vOneOf(['system', 'user', 'assistant']);

/**
 * Check an object against required and optional field checks; unknown keys are errors. Returns false
 * when `v` is not an object at all (so callers can skip follow-up checks).
 */
function vShape(
  v: unknown,
  p: string,
  e: VErr[],
  required: Record<string, Check>,
  optional: Record<string, Check>,
  format?: string,
): v is Record<string, unknown> {
  if (!isObj(v)) {
    err(e, p, 'must be an object');
    return false;
  }
  for (const [k, check] of Object.entries(required)) {
    if (v[k] === undefined) err(e, vPath(p, k), 'is required');
    else check(v[k], vPath(p, k), e);
  }
  for (const [k, val] of Object.entries(v)) {
    if (k in required || val === undefined) continue;
    const check = optional[k];
    if (check) check(val, vPath(p, k), e);
    else if (k === 'format' && format !== undefined) {
      if (val !== format) err(e, vPath(p, k), `must be '${format}'`);
    } else err(e, vPath(p, k), 'unknown field (foreign data belongs in extras)');
  }
  return true;
}

const vSamplers: Check = (v, p, e) => {
  const n = vNum;
  vShape(v, p, e, {}, {
    temperature: n,
    top_p: n,
    top_k: n,
    min_p: n,
    top_a: n,
    typical_p: n,
    repetition_penalty: n,
    frequency_penalty: n,
    presence_penalty: n,
    seed: n,
    stop: vStrArray,
    max_tokens: vPositiveInt,
  });
};

const vDepthPrompt: Check = (v, p, e) => {
  vShape(v, p, e, { text: vStr, depth: vCount, role: vRole }, {});
};

const LORE_SLOTS = [
  'before',
  'after',
  'examples_before',
  'examples_after',
  'note_before',
  'note_after',
  'top',
  'bottom',
  'recap',
] as const;

const vLorePosition: Check = (v, p, e) => {
  if (typeof v === 'string') {
    if (!(LORE_SLOTS as readonly string[]).includes(v)) vOneOf(LORE_SLOTS)(v, p, e);
    return;
  }
  if (isObj(v) && 'outlet' in v) return void vShape(v, p, e, { outlet: vStr }, {});
  if (isObj(v) && 'depth' in v) return void vShape(v, p, e, { depth: vCount }, { role: vRole });
  err(e, p, `must be a slot name, {depth, role?} or {outlet}`);
};

const vCompendiumMeta: Check = (v, p, e) => {
  vShape(v, p, e, {}, { type: vStr, data: vRecord, aliases: vStrArray, featured: vBool, arc: vStr });
};

const vLoreEntry: Check = (v, p, e) => {
  vShape(
    v,
    p,
    e,
    { id: vNonEmptyStr, content: vStr, keys: vStrArray, position: vLorePosition },
    {
      title: vStr,
      enabled: vBool,
      constant: vBool,
      secondary: vStrArray,
      logic: vOneOf(['and_any', 'and_all', 'not_any', 'not_all']),
      order: vNum,
      probability: vProbability,
      groups: vStrArray,
      groupWeight: vNum,
      scanDepth: vCount,
      caseSensitive: vBool,
      wholeWords: vBool,
      preventRecursion: vBool,
      excludeRecursion: vBool,
      ignoreBudget: vBool,
      sticky: vCount,
      cooldown: vCount,
      delay: vCount,
      meta: vCompendiumMeta,
      extras: vRecord,
    },
  );
};

const vLoreBook = (v: unknown, p: string, e: VErr[], format?: string): void => {
  const ok = vShape(
    v,
    p,
    e,
    { name: vStr, entries: (x, xp, xe) => (Array.isArray(x) ? x.forEach((it, i) => vLoreEntry(it, vPath(xp, i), xe)) : err(xe, xp, 'must be an array')) },
    {
      scanDepth: vCount,
      recursive: vBool,
      caseSensitive: vBool,
      wholeWords: vBool,
      match: vOneOf(['literal', 'stem']),
      extras: vRecord,
    },
    format,
  );
  if (!ok || !Array.isArray(v.entries)) return;
  // Entry ids key lore verdicts and trace lines, so they must be unique within a book.
  const seen = new Set<string>();
  v.entries.forEach((it: unknown, i: number) => {
    const id = isObj(it) ? it.id : undefined;
    if (typeof id !== 'string') return;
    if (seen.has(id)) err(e, vPath(vPath(vPath(p, 'entries'), i), 'id'), `duplicate entry id '${id}'`);
    seen.add(id);
  });
};

const vBookField: Check = (v, p, e) => vLoreBook(v, p, e);

function result<T>(x: unknown, errs: VErr[]): Validation<T> {
  return errs.length === 0 ? { ok: true, value: x as T } : { ok: false, errors: errs };
}

export function validateCharacter(x: unknown): Validation<Character> {
  const errs: VErr[] = [];
  vShape(
    x,
    '',
    errs,
    { name: vNonEmptyStr, description: vStr, greetings: vStrArray },
    {
      personality: vStr,
      scenario: vStr,
      examples: vStr,
      systemPrompt: vStr,
      postHistory: vStr,
      depthPrompt: vDepthPrompt,
      book: vBookField,
      creator: vStr,
      tags: vStrArray,
      extras: vRecord,
    },
    'core.character/1',
  );
  return result<Character>(x, errs);
}

export function validatePersona(x: unknown): Validation<Persona> {
  const errs: VErr[] = [];
  vShape(
    x,
    '',
    errs,
    { name: vNonEmptyStr, description: vStr },
    { aliases: vStrArray, book: vBookField },
    'core.persona/1',
  );
  return result<Persona>(x, errs);
}

const vBlockAt: Check = (v, p, e) => {
  if (typeof v === 'string') return vOneOf(['relative', 'top', 'bottom'])(v, p, e);
  if (isObj(v)) return void vShape(v, p, e, { depth: vCount }, { order: vNum });
  err(e, p, `must be 'relative', 'top', 'bottom' or {depth, order?}`);
};

const vBlock: Check = (v, p, e) => {
  vShape(
    v,
    p,
    e,
    { id: vNonEmptyStr, role: vRole, enabled: vBool, content: vStr, at: vBlockAt },
    { name: vStr, override: vOneOf(['card_system', 'card_post_history']), extras: vRecord },
  );
};

const HISTORY_SLOT = '{{history}}';

/**
 * Also checks the preset has exactly one enabled {{history}} slot (§10.2). Slots are counted the
 * way assemble finds them (the macro lexer: `{{ History }}` is a slot, an escaped `\{{history}}`
 * or one nested in another macro's argument is not), so validation and assembly always agree.
 */
export function validatePreset(x: unknown): Validation<Preset> {
  const errs: VErr[] = [];
  const ok = vShape(
    x,
    '',
    errs,
    {
      name: vStr,
      blocks: (v, p, e) => (Array.isArray(v) ? v.forEach((b, i) => vBlock(b, vPath(p, i), e)) : err(e, p, 'must be an array')),
    },
    {
      forbidOverrides: vBool,
      samplers: vSamplers,
      context: (v, p, e) => void vShape(v, p, e, {}, { maxContext: vPositiveInt, maxMessages: vPositiveInt }),
      prefill: vStr,
      impersonation: (v, p, e) => void vShape(v, p, e, {}, { prompt: vStr, prefill: vStr }),
      postProcessing: vOneOf(['none', 'merge', 'semi', 'strict', 'single']),
      formats: (v, p, e) =>
        void vShape(v, p, e, {}, { wi: vStr, personality: vStr, scenario: vStr, newChat: vStr, newExampleChat: vStr }),
      extras: vRecord,
    },
    'core.preset/1',
  );
  if (ok && Array.isArray(x.blocks)) {
    const ids = new Set<string>();
    let historySlots = 0;
    x.blocks.forEach((b: unknown, i: number) => {
      if (!isObj(b)) return;
      if (typeof b.id === 'string') {
        if (ids.has(b.id)) err(errs, vPath(vPath('blocks', i), 'id'), `duplicate block id '${b.id}'`);
        ids.add(b.id);
      }
      if (b.enabled === true && typeof b.content === 'string') historySlots += countHistorySlots(b.content);
    });
    // Without exactly one history slot the chat would vanish or repeat: an error, not a silent loss.
    if (historySlots !== 1) {
      err(errs, 'blocks', `must contain exactly one enabled ${HISTORY_SLOT} slot (found ${historySlots})`);
    }
  }
  return result<Preset>(x, errs);
}

export function validateLoreBook(x: unknown): Validation<LoreBook> {
  const errs: VErr[] = [];
  vLoreBook(x, '', errs, 'core.lorebook/1');
  return result<LoreBook>(x, errs);
}
