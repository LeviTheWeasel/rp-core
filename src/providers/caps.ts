// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Model capability records as data (ARCHITECTURE.md §8.2, D-15, D-54). Order of sources, each refining
// the previous: pessimistic defaults → host preset (caps-data/hosts.json) → model rows by glob
// (caps-data/models.json) → catalog → probe cache → user overrides ([caps."conn:model"]).
// Unknown → whatever could 400 is treated as unsupported (tools 'prompted', structuredOutput 'none').
// CONTRACT FILE (M1b): signatures are fixed; the caps agent implements the bodies and fills the JSON.
//
// Fresh code. Rules taken as ideas only: "no field → off" (Bunraku src/stage/provider/
// openai-compatible-request.ts, src/kit/providers/spoke.ts) and "unknown → do not send, never send a
// disable" (VAUDEVILLE packages/managed-ai/src/reasoning-facts.ts). Facts live in caps-data/*.json, each
// row with `as_of` and `src` [D-54]; nothing here looks at a model id except through a data glob.
//
// Matching, in short:
// - hosts.json rows apply in file order. A row with `hostname` (a glob) matches that hostname (and
//   `port`, when given). A row with `server` matches the server kind: the one a catalog/probe reported,
//   else the one guessed from a local origin's port by a row that names both (`{port: 8080, server:
//   'llama.cpp'}` on 127.0.0.1:8080). A port alone never matches a remote origin.
// - models.json rows apply in file order (general rows first, specific ones later win). `match` is a
//   case-insensitive glob over the whole model id: `*` any run (slashes included), `?` one character,
//   `[a-z]` / `[!x]` a class, `{a,b}` alternatives. A row's optional `servers` list limits it to those
//   server kinds ('unknown' = no kind known); `dialect` limits any row to one dialect.
// - maxInFlight is not a data fact: the connection's explicit max_in_flight, else 1 local / 4 remote.
//   A data source may only lower that default, never raise it; a probe never raises capacity [D-84].

import type { ModelCaps } from './types.ts';
import { DEFAULT_REASONING_TAGS } from './reasoning-tags.ts';
import hostsFile from './caps-data/hosts.json' with { type: 'json' };
import modelsFile from './caps-data/models.json' with { type: 'json' };

/** One row of hosts.json / models.json. Every row carries as_of and src (URL or incident id) [D-54]. */
export interface CapsRow {
  /** hosts.json: {port?, hostname? (glob), server?}; models.json: a glob over the model id (case-insensitive). */
  match: { port?: number; hostname?: string; server?: string } | string;
  name?: string;
  as_of: string;
  src: string;
  caps: Partial<ModelCaps>;
  /** The row applies to this dialect only (absent: every dialect). */
  dialect?: ModelCaps['dialect'];
  /** models.json: the row applies only when the server kind is one of these ('unknown' = none known). */
  servers?: string[];
  /** Free text for people reading the data (caveats, why a value is what it is). Never read by code. */
  note?: string;
}

/** The shape of caps-data/hosts.json and models.json. */
export interface CapsFile {
  as_of: string;
  rows: CapsRow[];
}

/** The rows shipped with rp-core, in file order. */
export const HOST_ROWS: readonly CapsRow[] = (hostsFile as unknown as CapsFile).rows;
export const MODEL_ROWS: readonly CapsRow[] = (modelsFile as unknown as CapsFile).rows;

/** The sampler names of formats/native.ts Samplers: what `samplers.accepted` may list. */
export const SAMPLER_NAMES: readonly string[] = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'typical_p',
  'repetition_penalty',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'stop',
  'max_tokens',
];

/** The pessimistic defaults for an unknown openai-chat model (local or remote changes maxInFlight). */
export function pessimisticCaps(dialect: ModelCaps['dialect'], local: boolean): ModelCaps {
  // One record for every dialect for now: anthropic (M7) and gemini (M8) refine it through their own
  // host and model rows. Everything is a fresh object, so callers may mutate the result freely.
  return {
    dialect,
    maxTokensField: 'max_tokens',
    tools: 'prompted', // [D-15]
    toolChoice: ['auto', 'none'],
    toolChoiceHonored: false,
    parallelToolCalls: 'never',
    strictTools: false,
    structuredOutput: { mode: 'none' },
    midSystem: 'as-user',
    alternation: 'strict',
    prefill: 'none',
    reasoning: {
      output: 'tags',
      tags: [...DEFAULT_REASONING_TAGS],
      control: 'none',
      canDisable: false,
      echo: 'never',
    },
    samplers: {
      accepted: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty'],
    },
    streamUsage: 'none',
    caching: 'none',
    maxInFlight: defaultMaxInFlight(local),
    source: [],
  };
}

/** [D-84] the capacity of an origin without an explicit max_in_flight. */
export function defaultMaxInFlight(local: boolean): number {
  return local ? 1 : 4;
}

/** Keys a patch may set. `dialect` belongs to the connection and `source` to the fold: never patched. */
const PATCHABLE: ReadonlySet<string> = new Set([
  'contextLength',
  'maxOutput',
  'maxTokensField',
  'tools',
  'toolChoice',
  'toolChoiceHonored',
  'parallelToolCalls',
  'strictTools',
  'toolIdFormat',
  'structuredOutput',
  'midSystem',
  'alternation',
  'prefill',
  'reasoning',
  'samplers',
  'streamUsage',
  'caching',
  'maxInFlight',
  'cacheMinTokens',
  'stopMax',
  'extraBody',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A deep copy of JSON-ish data, so results never alias the shared data rows or a caller's patch. */
function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copy) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = copy(x);
    return out as T;
  }
  return v;
}

/** Plain objects merged key by key at every depth; arrays and scalars replaced; undefined skipped. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = copy(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : copy(v);
  }
  return out;
}

/** One level of merge: the patch's defined fields win, arrays replaced. */
function shallowMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out = copy(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = copy(v);
  return out as T;
}

/** Deep merge for caps (reasoning, samplers, structuredOutput merged; arrays replaced); appends source. */
export function mergeCaps(base: ModelCaps, patch: Partial<ModelCaps>, source?: ModelCaps['source'][number]): ModelCaps {
  const out: ModelCaps = copy(base);
  let applied = false;
  for (const [key, value] of Object.entries(patch) as [keyof ModelCaps, unknown][]) {
    if (value === undefined || !PATCHABLE.has(key)) continue;
    applied = true;
    switch (key) {
      case 'reasoning':
        if (isPlainObject(value)) out.reasoning = shallowMerge(out.reasoning, value as Partial<ModelCaps['reasoning']>);
        break;
      case 'samplers': {
        if (!isPlainObject(value)) break;
        const p = value as Partial<ModelCaps['samplers']>;
        const next = shallowMerge(out.samplers, { ...p, wire: undefined });
        // The wire-name map grows like a dictionary: a later row renames more, it never forgets one.
        if (p.wire !== undefined) next.wire = { ...(out.samplers.wire ?? {}), ...copy(p.wire) };
        out.samplers = next;
        break;
      }
      case 'structuredOutput': {
        if (!isPlainObject(value)) break;
        const next = shallowMerge(out.structuredOutput, value as Partial<ModelCaps['structuredOutput']>);
        // A confirmation belongs to json_schema: switching it off forgets who confirmed it.
        if (next.mode === 'none' && (value as Partial<ModelCaps['structuredOutput']>).confirmedBy === undefined) {
          delete next.confirmedBy;
        }
        out.structuredOutput = next;
        break;
      }
      case 'extraBody':
        if (isPlainObject(value)) out.extraBody = deepMerge(out.extraBody ?? {}, value);
        break;
      default:
        (out as unknown as Record<string, unknown>)[key] = copy(value);
    }
  }
  if (applied && source !== undefined && !out.source.includes(source)) out.source.push(source);
  return out;
}

export interface CapsInput {
  dialect: ModelCaps['dialect'];
  /** origin of the base URL (http.ts originOf). */
  origin: string;
  local: boolean;
  model: string;
  /** The server kind if a probe/catalog knows it ('llama.cpp', 'ollama', 'lmstudio', 'koboldcpp', 'openrouter', ...). */
  server?: string;
  catalog?: Partial<ModelCaps>;
  probe?: Partial<ModelCaps>;
  user?: Partial<ModelCaps>;
  /** explicit max_in_flight of the connection. */
  maxInFlight?: number;
}

export function resolveCaps(input: CapsInput): ModelCaps {
  return resolveCapsWith(input, HOST_ROWS, MODEL_ROWS);
}

/**
 * resolveCaps over explicit row sets (tests and tools that check a data file). Pure: the same input
 * and rows give the same record; nothing is read from the environment.
 */
export function resolveCapsWith(input: CapsInput, hostRows: readonly CapsRow[], modelRows: readonly CapsRow[]): ModelCaps {
  const where = parseOrigin(input.origin);
  const knownServer = input.server !== undefined && input.server !== '' && input.server !== 'unknown' ? input.server : undefined;
  const server = knownServer ?? guessServer(hostRows, input, where);
  const ctx: MatchContext = { dialect: input.dialect, local: input.local, hostname: where.hostname, port: where.port, server, serverKnown: knownServer !== undefined };

  const lowered: number[] = [];
  const take = (patch: Partial<ModelCaps> | undefined): Partial<ModelCaps> | undefined => {
    if (patch !== undefined && isPositiveInt(patch.maxInFlight)) lowered.push(patch.maxInFlight);
    return patch;
  };

  let caps = pessimisticCaps(input.dialect, input.local);
  for (const row of hostRows) if (hostRowMatches(row, ctx)) caps = mergeCaps(caps, take(row.caps) ?? {}, 'host');
  for (const row of modelRows) if (modelRowMatches(row, ctx, input.model)) caps = mergeCaps(caps, take(row.caps) ?? {}, 'model');
  if (input.catalog) caps = mergeCaps(caps, take(input.catalog) ?? {}, 'catalog');
  if (input.probe) caps = mergeCaps(caps, take(input.probe) ?? {}, 'probe');
  if (input.user) caps = mergeCaps(caps, take(input.user) ?? {}, 'user');

  // [D-84] capacity: the connection's explicit value is final; otherwise the local/remote default,
  // which a data source may lower (a server that only queues) but never raise.
  caps.maxInFlight = isPositiveInt(input.maxInFlight)
    ? input.maxInFlight
    : Math.min(defaultMaxInFlight(input.local), ...lowered);
  return caps;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

interface MatchContext {
  dialect: ModelCaps['dialect'];
  local: boolean;
  hostname: string;
  port: number | undefined;
  /** The server kind: reported by a catalog/probe, or guessed from a local port. */
  server: string | undefined;
  serverKnown: boolean;
}

/** hostname (lower case, IPv6 brackets kept) and port (default ports made explicit) of an origin. */
function parseOrigin(origin: string): { hostname: string; port: number | undefined } {
  try {
    const u = new URL(origin);
    const port = u.port !== '' ? Number(u.port) : u.protocol === 'http:' ? 80 : u.protocol === 'https:' ? 443 : undefined;
    return { hostname: u.hostname.toLowerCase(), port };
  } catch {
    return { hostname: '', port: undefined };
  }
}

function dialectOk(row: CapsRow, dialect: ModelCaps['dialect']): boolean {
  return row.dialect === undefined || row.dialect === dialect;
}

/** The server kind a host row implies for this origin when no catalog/probe reported one. */
function guessServer(rows: readonly CapsRow[], input: CapsInput, where: { hostname: string; port: number | undefined }): string | undefined {
  for (const row of rows) {
    if (!dialectOk(row, input.dialect) || typeof row.match !== 'object' || row.match.server === undefined) continue;
    const m = row.match;
    if (m.hostname !== undefined) {
      if (globMatch(m.hostname, where.hostname) && (m.port === undefined || m.port === where.port)) return m.server;
    } else if (m.port !== undefined && input.local && m.port === where.port) {
      return m.server;
    }
  }
  return undefined;
}

function hostRowMatches(row: CapsRow, ctx: MatchContext): boolean {
  if (!dialectOk(row, ctx.dialect) || typeof row.match !== 'object') return false;
  const m = row.match;
  if (m.hostname !== undefined) return globMatch(m.hostname, ctx.hostname) && (m.port === undefined || m.port === ctx.port);
  if (m.server !== undefined) return m.server === ctx.server;
  // A bare port row: only a local origin whose server nobody reported.
  return m.port !== undefined && ctx.local && !ctx.serverKnown && m.port === ctx.port;
}

function modelRowMatches(row: CapsRow, ctx: MatchContext, model: string): boolean {
  if (!dialectOk(row, ctx.dialect) || typeof row.match !== 'string') return false;
  if (row.servers !== undefined && !row.servers.includes(ctx.server ?? 'unknown')) return false;
  return globMatch(row.match, model);
}

const globCache = new Map<string, RegExp>();

/**
 * Case-insensitive glob over a whole string: `*` any run (slashes too), `?` one character, `[abc]`,
 * `[a-z]`, `[!x]` classes, `{a,b}` alternatives (not nested). Everything else is literal.
 */
export function globMatch(pattern: string, text: string): boolean {
  let re = globCache.get(pattern);
  if (re === undefined) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re.test(text);
}

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g;

function globToRegExp(pattern: string): RegExp {
  let src = '';
  let inBrace = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') src += '[\\s\\S]*';
    else if (c === '?') src += '[\\s\\S]';
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        src += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith('!');
      if (negate) body = body.slice(1);
      // Keep ranges (a-z); escape everything else that is special inside a class.
      body = body.replace(/[\\^\]]/g, (x) => `\\${x}`);
      src += `[${negate ? '^' : ''}${body}]`;
      i = close;
    } else if (c === '{' && !inBrace) {
      inBrace = true;
      src += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace = false;
      src += ')';
    } else if (c === ',' && inBrace) src += '|';
    else src += c.replace(REGEX_SPECIAL, (x) => `\\${x}`);
  }
  if (inBrace) throw new Error(`caps: unclosed '{' in glob ${JSON.stringify(pattern)}`);
  return new RegExp(`^${src}$`, 'i');
}

/**
 * Server kinds that are self-hosted OpenAI-compatible servers: their `response_format` json_schema is
 * confirmed only by a probe or the user, never by a host row (§7.2: "llama.cpp/Ollama always turn the
 * schema into a grammar" is not taken on faith).
 */
export const LOCAL_SERVER_KINDS: readonly string[] = ['llama.cpp', 'ollama', 'lmstudio', 'koboldcpp', 'vllm'];

/**
 * Problems in a caps-data file (empty when it is sound): missing as_of/src, a bad date, a match of the
 * wrong shape for its file, an unknown caps key, a sampler name the core does not have, a glob that
 * does not compile, a local server's structured output confirmed by its host row (§7.2). Tests run
 * it over both shipped files.
 */
export function checkCapsRows(rows: readonly CapsRow[], kind: 'hosts' | 'models'): string[] {
  const problems: string[] = [];
  rows.forEach((row, i) => {
    const at = `${kind}[${i}]${row.name ? ` (${row.name})` : ''}`;
    if (typeof row.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.as_of)) problems.push(`${at}: as_of must be YYYY-MM-DD`);
    if (typeof row.src !== 'string' || row.src.trim() === '') problems.push(`${at}: src is required`);
    if (!isPlainObject(row.caps)) problems.push(`${at}: caps must be an object`);
    if (kind === 'hosts') {
      if (!isPlainObject(row.match)) problems.push(`${at}: match must be {port?, hostname?, server?}`);
      else {
        const m = row.match;
        if (m.hostname === undefined && m.server === undefined) problems.push(`${at}: match needs hostname or server`);
        if (m.port !== undefined && !isPositiveInt(m.port)) problems.push(`${at}: port must be a positive integer`);
        const localServer = m.hostname === undefined && (m.server === undefined || LOCAL_SERVER_KINDS.includes(m.server));
        if (localServer && isPlainObject(row.caps) && row.caps.structuredOutput?.confirmedBy === 'host') {
          problems.push(`${at}: a local server's structured output needs a probe or the user, not confirmedBy 'host' (§7.2)`);
        }
      }
      if (row.servers !== undefined) problems.push(`${at}: servers is a models.json field`);
    } else {
      if (typeof row.match !== 'string' || row.match === '') problems.push(`${at}: match must be a glob string`);
      else {
        try {
          globToRegExp(row.match);
        } catch (e) {
          problems.push(`${at}: ${(e as Error).message}`);
        }
      }
    }
    if (isPlainObject(row.caps)) {
      for (const k of Object.keys(row.caps)) if (!PATCHABLE.has(k)) problems.push(`${at}: unknown caps key ${k}`);
      const s = row.caps.samplers;
      if (s?.accepted) for (const n of s.accepted) if (!SAMPLER_NAMES.includes(n)) problems.push(`${at}: unknown sampler ${n}`);
      if (s?.wire) for (const n of Object.keys(s.wire)) if (!SAMPLER_NAMES.includes(n)) problems.push(`${at}: wire renames unknown sampler ${n}`);
    }
  });
  return problems;
}
