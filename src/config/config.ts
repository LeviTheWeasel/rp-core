// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// <home>/config.toml (ARCHITECTURE.md §13, D-53, D-73, D-84). Parsed with Bun.TOML.parse, validated by
// hand with error paths. No secrets in the file: fields that look like keys are refused.
// CONTRACT FILE (M1b): signatures are fixed; the config agent implements the bodies.
//
// Written fresh. Bunraku src/kit/providers/config.ts was the reference for the home-override pattern;
// in rp-core the home itself is resolved by cli/home.ts (--home, RP_CORE_HOME, ~/.rp-core), so this
// file only joins config.toml onto it.
//
// Bun.TOML.parse 1.3.14 quirks this file works around (checked by hand, see test/config):
// - a TOML date/time literal is a syntax error ("Expected key but found -") as a plain value, but is
//   silently mangled inside an inline table or array ({ d = 2026-01-01 } → { d: 2026, "01": 1 }), so
//   dates are strings and a lexical pass refuses date/time literals before the parser sees them;
// - a leading byte-order mark makes it drop the first key silently, so the BOM is stripped first;
// - inf/nan come back as the strings "inf"/"nan" and -inf as 0, so the same pass refuses them, and
//   number fields still check their type and range instead of trusting the parse;
// - a multi-line basic string keeps the newline right after its opening """ (TOML trims it).
//   Left as is: it only adds a leading newline to free text.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProviderError, type ModelCaps, type Provider } from '../providers/types.ts';
import type { DeepPartial, SessionConfig, Binding } from '../session/entries.ts';
import type { Connection } from '../engine/api.ts';
import { isHeaderSafeValue, type SecretResolver } from './secrets.ts';
import { isLocalOrigin, originOf } from '../providers/http.ts';
import { resolveCaps, type CapsInput } from '../providers/caps.ts';
import { createOpenAIChatProvider, type OpenAIChatOptions } from '../providers/openai-chat.ts';
import { PROTECTED_BODY_KEYS, PROTECTED_HEADERS, type ConnectionOverrides } from '../providers/wire.ts';

export interface ConnectionConfig {
  id: string;
  /** M1b: 'openai-chat' only; 'anthropic' (M7) and 'gemini' (M8) parse but are refused when used. */
  dialect: 'openai-chat' | 'anthropic' | 'gemini';
  baseUrl: string;
  keyEnv?: string;
  keyCmd?: string[];
  maxInFlight?: number;
  /** [D-53] header NAME → name of the env var holding its value. */
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  excludeBody?: string[];
  /** Override the local/remote guess from the URL. */
  local?: boolean;
  /** Anthropic only (M7). */
  apiVersion?: string;
  /** Anthropic only (M7): prompt-cache lifetime, as in the §13 example. */
  cacheTtl?: '5m' | '1h';
}

export interface PriceRow {
  inPerM: number;
  outPerM: number;
  asOf: string;
}

export interface RpConfig {
  /** Absolute path of the file read, or null when there is none. */
  path: string | null;
  connections: Record<string, ConnectionConfig>;
  /** Defaults for NEW sessions, merged over DEFAULT_SESSION_CONFIG (roles from [roles], [narrator], [director], [compendium]). */
  sessionDefaults: DeepPartial<SessionConfig>;
  /** [caps."conn:model"] user overrides. */
  caps: Record<string, Partial<ModelCaps>>;
  /** [prices."conn:model"]. */
  prices: Record<string, PriceRow>;
}

export class ConfigError extends Error {
  /** e.g. 'connections.local.base_url' */
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

export function configPath(home: string): string {
  return resolve(home, 'config.toml');
}

/**
 * Parse TOML text. Rules (D-73): dates only as strings (a TOML date literal → ConfigError suggesting
 * quotes); connection names without ':'; bindings 'conn:model' split at the FIRST ':' (so qwen3:14b and
 * a/b work) or the reference 'narrator' / 'recorder'; key-like fields (api_key, key, token, secret,
 * password at any depth) → ConfigError; unknown top-level tables → ConfigError; numbers range-checked.
 * Keys: snake_case in the file (base_url, key_env, key_cmd, max_in_flight, extra_body, exclude_body,
 * api_version, narrator_fallback, max_rounds, prefill_vs_tools, ...).
 */
export function parseConfig(text: string, path: string | null): RpConfig {
  const root = parseToml(text);
  refuseSecrets(root, []);

  for (const k of Object.keys(root)) {
    if (!(TOP_LEVEL as readonly string[]).includes(k)) {
      throw new ConfigError(fmt([k]), `unknown table; expected one of ${TOP_LEVEL.join(', ')}`);
    }
    if (!isTable(root[k])) throw new ConfigError(fmt([k]), 'must be a table');
  }

  const connections = parseConnections(tableAt(root, 'connections'));
  const ids = new Set(Object.keys(connections));
  const sessionDefaults: DeepPartial<SessionConfig> = {};

  const roles = tableAt(root, 'roles');
  if (roles) {
    const r = parseRoles(roles, ids);
    if (Object.keys(r).length > 0) sessionDefaults.roles = r;
  }
  const narrator = tableAt(root, 'narrator');
  if (narrator) sessionDefaults.narrator = parseNarrator(narrator);
  const director = tableAt(root, 'director');
  if (director) sessionDefaults.director = parseDirector(director);
  const compendium = tableAt(root, 'compendium');
  if (compendium) sessionDefaults.compendium = parseCompendium(compendium);

  const caps: Record<string, Partial<ModelCaps>> = {};
  for (const [spec, t] of Object.entries(tableAt(root, 'caps') ?? {})) {
    const p = ['caps', spec];
    modelKey(spec, p, ids);
    if (!isTable(t)) throw new ConfigError(fmt(p), 'must be a table');
    caps[spec] = parseCaps(t, p);
  }

  const prices: Record<string, PriceRow> = {};
  for (const [spec, t] of Object.entries(tableAt(root, 'prices') ?? {})) {
    const p = ['prices', spec];
    modelKey(spec, p, ids);
    if (!isTable(t)) throw new ConfigError(fmt(p), 'must be a table');
    prices[spec] = parsePrice(t, p);
  }

  return { path, connections, sessionDefaults, caps, prices };
}

/** Read <home>/config.toml; a missing file is an empty config (path null). */
export function loadConfig(home: string): RpConfig {
  const file = configPath(home);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return { path: null, connections: {}, sessionDefaults: {}, caps: {}, prices: {} };
    throw new ConfigError('config.toml', `cannot read ${file}${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  return parseConfig(text, file);
}

/** 'conn:model' → {conn, model} at the first ':'; throws ConfigError on a missing part. */
export function splitBinding(spec: string, path?: string): { conn: string; model: string } {
  const at = path ?? 'binding';
  const i = spec.indexOf(':');
  if (i < 0) throw new ConfigError(at, 'expected "<connection>:<model>"');
  const conn = spec.slice(0, i);
  const model = spec.slice(i + 1);
  if (conn === '') throw new ConfigError(at, 'the connection name before ":" is missing');
  if (!CONNECTION_ID.test(conn)) {
    throw new ConfigError(at, 'the connection name before the first ":" may only contain letters, digits, "_" and "-"');
  }
  if (model.trim() === '') throw new ConfigError(at, 'the model after ":" is missing');
  if (model !== model.trim()) throw new ConfigError(at, 'the model name has leading or trailing spaces');
  return { conn, model };
}

/** A commented starter config.toml: local Ollama, llama.cpp, LM Studio, OpenRouter (key_env). */
export const CONFIG_TEMPLATE: string = `# rp-core configuration: connections, default roles for new sessions, capability overrides,
# prices. Lines starting with # are comments; remove the "# " to turn an example on.
#
# No secrets in this file. An API key comes from an environment variable (key_env) or from a
# command that prints it (key_cmd: run without a shell, 10 s timeout). Fields that look like keys
# (api_key, token, password, ...) are refused.
#
# Dates are quoted strings: as_of = "2026-10-06". A bare 2026-10-06 is a TOML date literal and
# is refused.

# ---- Connections -------------------------------------------------------------------------
# One table per server. Its name is what bindings use: "<connection>:<model>". Names may hold
# letters, digits, "_" and "-", never ":".
#
#   dialect        "openai-chat" (the default; "anthropic" and "gemini" come later)
#   base_url       required, http:// or https://
#   key_env        name of the environment variable that holds the API key
#   key_cmd        argv of a command that prints the key, e.g. secret-tool on Linux
#   max_in_flight  requests at once to this server, 1-64 (default: 1 local, 4 remote)
#   local          true/false: overrides the guess from the URL
#   headers        header name -> name of the environment variable holding its value
#   extra_body     fields added to every request body (model, messages, stream, tools and
#                  tool_choice are protected)
#   exclude_body   body fields to leave out

# Ollama on this machine. \`ollama list\` shows the model names.
[connections.ollama]
dialect = "openai-chat"
base_url = "http://127.0.0.1:11434"
local = true                     # 127.0.0.1 is local anyway; say so for a tunnel to your own box

# llama.cpp: llama-server -m model.gguf --port 8080 (it serves whatever model it loaded).
[connections.llamacpp]
base_url = "http://127.0.0.1:8080"
max_in_flight = 1                # 2 only with -np 2 --no-kv-unified

# LM Studio: Developer tab, Start server.
[connections.lmstudio]
base_url = "http://127.0.0.1:1234"

# OpenRouter. Export the key in your shell first: export OPENROUTER_API_KEY=...
[connections.openrouter]
base_url = "https://openrouter.ai/api"
key_env = "OPENROUTER_API_KEY"
# headers = { "X-Title" = "RP_CORE_APP_TITLE" }
# extra_body = { provider = { allow_fallbacks = false } }

# A remote server whose key sits in the desktop keyring (store it once with
# secret-tool store --label=rp-core service rp-core conn deepseek). DeepSeek's /beta base is
# needed for continue-by-prefill (prefix completion); it serves ordinary chat too:
# [connections.deepseek]
# base_url = "https://api.deepseek.com/beta"
# key_cmd = ["secret-tool", "lookup", "service", "rp-core", "conn", "deepseek"]

# ---- Roles: defaults for NEW sessions ----------------------------------------------------
# A session keeps its own copy; /model changes it there. A binding is "<connection>:<model>",
# split at the first ":", so "ollama:qwen3:14b" is model "qwen3:14b" on connection "ollama".
# director, recorder and recall may say "narrator" instead (they then follow the narrator, even
# after /model); recall may also say "recorder". A role that is not set is "narrator".
[roles]
narrator = "ollama:qwen3:14b"    # change this to a model you have
# narrator_fallback = "openrouter:vendor/model"
# director = "narrator"
# recorder = "narrator"
# recall = "recorder"

[narrator]
max_rounds = 4                   # tool rounds per reply, 1-8
prefill_vs_tools = "prefill"     # prefill | tools: which wins when a turn wants both

# [director]
# enabled = false
# profile = "auto"               # auto | full | lite
# on_swipe = "reuse"             # reuse | replan
# instructions = ""              # standing instructions, at most 2000 characters
# style = "the-balanced"
# creativity = "moderate"        # subtle | moderate | dramatic

# ---- Capability overrides ----------------------------------------------------------------
# rp-core knows the common servers and models, and \`rp-core probe\` asks the server. Override a
# field per "<connection>:<model>" only after checking it:
# [caps."ollama:qwen3:14b"]
# context_length = 16384         # the window the server really runs (Ollama: num_ctx)
# tools = "native"               # native | prompted | none
# reasoning.tags = ["<think>"]

# ---- Prices, USD per million tokens, for the cost in usage reports -----------------------
# [prices."openrouter:vendor/model"]
# in_per_m = 1.0
# out_per_m = 2.0
# as_of = "2026-10-06"
`;

/**
 * Build engine Connections for every openai-chat connection: provider = createOpenAIChatProvider,
 * origin = originOf(base_url), local = isLocalOrigin unless overridden, caps = resolveCaps for model ''
 * and capsFor(model) = resolveCaps with host preset, model rows, catalog/probe cache rows for
 * "conn:model" and user overrides; resolveKey via the SecretResolver (lazy, memoised); header values
 * read from env at build time (a missing or unusable one makes that connection's resolveKey reject
 * with key_unavailable, naming the header and the variable; it never fails the whole config).
 * anthropic/gemini connections are skipped and reported in `skipped`.
 */
export function buildConnections(
  cfg: RpConfig,
  deps: {
    env: Record<string, string | undefined>;
    secrets: SecretResolver;
    capsCache: Record<string, { server?: string; caps: Partial<ModelCaps> }>;
  },
): { connections: Record<string, Connection>; skipped: { id: string; why: string }[] } {
  return buildConnectionsWith(cfg, deps, {
    originOf,
    isLocalOrigin,
    resolveCaps,
    createProvider: createOpenAIChatProvider,
  });
}

/** The provider-side functions buildConnections calls; injected so tests can run without them. */
export interface ConnectionBuilders {
  originOf(url: string): string;
  isLocalOrigin(origin: string): boolean;
  resolveCaps(input: CapsInput): ModelCaps;
  createProvider(o: OpenAIChatOptions): Provider;
}

/** buildConnections with its provider-side functions passed in. */
export function buildConnectionsWith(
  cfg: RpConfig,
  deps: Parameters<typeof buildConnections>[1],
  impl: ConnectionBuilders,
): { connections: Record<string, Connection>; skipped: { id: string; why: string }[] } {
  const connections: Record<string, Connection> = {};
  const skipped: { id: string; why: string }[] = [];

  for (const c of Object.values(cfg.connections)) {
    if (c.dialect !== 'openai-chat') {
      skipped.push({ id: c.id, why: `dialect '${c.dialect}' is not supported yet (${c.dialect === 'anthropic' ? 'M7' : 'M8'})` });
      continue;
    }
    const origin = impl.originOf(c.baseUrl);
    const local = c.local ?? impl.isLocalOrigin(origin);

    // [D-53] header values come from env. A missing or unusable one fails THIS connection, at its
    // first call, with a precise key_unavailable (as a missing key_env does): the rest of the config,
    // other connections, --provider script runs and probes of other servers are not held hostage by
    // a variable only this connection needs. The value itself is never echoed.
    let headers: Record<string, string> | undefined;
    let headerProblem: string | undefined;
    for (const [name, envName] of Object.entries(c.headers ?? {})) {
      const value = deps.env[envName];
      if (value === undefined || value === '') {
        headerProblem ??= `header ${name}: environment variable ${envName} is not set`;
        continue;
      }
      if (!isHeaderSafeValue(value)) {
        headerProblem ??= `header ${name}: environment variable ${envName} holds a character an HTTP header cannot carry (a line break, an invisible or non-ASCII character, or a space at either end); the value is not shown`;
        continue;
      }
      // A header value may be a credential of its own: scrub() must know it.
      deps.secrets.remember?.(value);
      (headers ??= {})[name] = value;
    }
    const overrides: ConnectionOverrides = {};
    if (headers) overrides.headers = headers;
    if (c.extraBody) overrides.extraBody = c.extraBody;
    if (c.excludeBody) overrides.excludeBody = c.excludeBody;

    const providerOpts: OpenAIChatOptions = { connectionId: c.id, baseUrl: c.baseUrl, local };
    if (Object.keys(overrides).length > 0) providerOpts.overrides = overrides;
    const provider = impl.createProvider(providerOpts);

    // The server kind is a property of the endpoint: any probed row of this connection may tell it.
    const prefix = `${c.id}:`;
    const connServer = Object.keys(deps.capsCache)
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((k) => deps.capsCache[k]?.server)
      .find((s): s is string => typeof s === 'string' && s !== '');

    const capsInput = (model: string): CapsInput => {
      const input: CapsInput = { dialect: c.dialect, origin, local, model };
      if (c.maxInFlight !== undefined) input.maxInFlight = c.maxInFlight;
      if (model === '') {
        if (connServer !== undefined) input.server = connServer;
        return input;
      }
      const key = `${c.id}:${model}`;
      const row = deps.capsCache[key];
      const server = row?.server ?? connServer;
      if (server !== undefined && server !== '') input.server = server;
      // caps-cache.json is the `rp-core probe` cache (§8.2 source 4); in M1b it holds catalog facts.
      if (row) input.probe = row.caps;
      const user = cfg.caps[key];
      if (user) input.user = user;
      return input;
    };

    const memo = new Map<string, ModelCaps>();
    const spec = { conn: c.id, ...(c.keyEnv !== undefined ? { keyEnv: c.keyEnv } : {}), ...(c.keyCmd !== undefined ? { keyCmd: c.keyCmd } : {}) };

    connections[c.id] = {
      id: c.id,
      provider,
      caps: impl.resolveCaps(capsInput('')),
      origin,
      local,
      capsFor(model: string): ModelCaps {
        let caps = memo.get(model);
        if (!caps) {
          caps = impl.resolveCaps(capsInput(model));
          memo.set(model, caps);
        }
        return caps;
      },
      // Lazy: a key command runs at the first call that needs it, not when the CLI starts. A header
      // that could not be read fails here too, so the call never goes out without it.
      resolveKey: headerProblem
        ? () => Promise.reject(new ProviderError({ category: 'auth', code: 'key_unavailable', message: `connection '${c.id}': ${headerProblem}` }))
        : () => deps.secrets.resolve(spec),
      dialect: c.dialect,
      baseUrl: c.baseUrl,
    };
  }
  return { connections, skipped };
}

// ---- TOML ---------------------------------------------------------------------------------------

type Table = Record<string, unknown>;

const TOP_LEVEL = ['connections', 'roles', 'narrator', 'director', 'compendium', 'caps', 'prices'] as const;

/** Connection ids: no ':' (bindings split at the first one) and nothing that needs quoting. */
const CONNECTION_ID = /^[A-Za-z0-9_-]+$/;
/** Environment variable names (key_env, header values). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token: what a header name may be. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A key path the way TOML would write it: bare segments, quoted where needed. */
function fmt(path: readonly string[]): string {
  return path.map((s) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s))).join('.');
}

function tableAt(root: Table, k: string): Table | undefined {
  const v = root[k];
  return isTable(v) ? v : undefined;
}

interface TomlPosition {
  line?: number;
  column?: number;
  lineText?: string;
}

/** Bun.TOML.parse with its errors turned into ConfigError naming the line (D-73). */
function parseToml(text: string): Table {
  // Bun drops the first key after a byte-order mark without a word; editors on Windows write one.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Bun rejects a date literal only at the top of a key/value line; inside an inline table or an
  // array it silently turns `{ when = 2026-01-01 }` into `{ when: 2026, "01": 1 }`. So literals Bun
  // cannot hold are found by a lexical pass first, and never reach the parser.
  refuseLiterals(src);
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(src);
  } catch (err) {
    throw tomlError(err);
  }
  if (!isTable(parsed)) throw new ConfigError('toml', 'the file is not a TOML table');
  return parsed;
}

/** A TOML offset/local date-time, local date or local time. */
const DATE_TOKEN = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:[Zz]|[+-]\d{2}:\d{2})?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
/** A date/time or inf/nan in VALUE position: after '=', '[' or ',' and followed by the end of the value. */
const VALUE_LITERAL = new RegExp(
  `(?:^|[=\\[,])\\s*(${DATE_TOKEN.source}|[+-]?(?:inf|nan))(?=\\s*(?:$|[,\\]}]))`,
  'g',
);

/**
 * Refuse date/time literals (D-73) and inf/nan (Bun returns "inf"/"nan" as strings and -inf as 0)
 * wherever a value may stand. Works on the text with comments removed and strings blanked, line by
 * line, so the error names the line. Only the key and the literal are echoed, never the line.
 */
function refuseLiterals(src: string): void {
  let depth = 0; // open [ / { carried over from earlier lines: inside a multi-line array
  codeLines(src).forEach((code, i) => {
    const header = depth === 0 && /^\s*\[/.test(code);
    if (!header) {
      VALUE_LITERAL.lastIndex = 0;
      const m = VALUE_LITERAL.exec(code);
      if (m) {
        const lit = m[1]!;
        const at = `line ${i + 1}`;
        if (/^[+-]?(?:inf|nan)$/.test(lit)) {
          throw new ConfigError(at, `${lit} is not supported (the TOML reader does not keep it as a number); write a finite number`);
        }
        const keyed = /([A-Za-z0-9_-]+|"")\s*=\s*$/.exec(code.slice(0, m.index + m[0].length - lit.length));
        const fix = keyed && keyed[1] !== '""' ? `${keyed[1]} = "${lit}"` : `"${lit}"`;
        throw new ConfigError(at, `TOML date and time literals are not supported; write the date as a quoted string: ${fix}`);
      }
    }
    for (const ch of code) {
      if (ch === '[' || ch === '{') depth++;
      else if ((ch === ']' || ch === '}') && depth > 0) depth--;
    }
  });
}

/**
 * The TOML text split into lines with comments removed and every string replaced by "" (multi-line
 * strings leave empty lines behind, so line numbers stay right). Malformed strings end at the end of
 * the text; the parser reports them.
 */
function codeLines(src: string): string[] {
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  const n = src.length;
  const newline = (): void => {
    lines.push(cur);
    cur = '';
  };
  while (i < n) {
    const ch = src[i]!;
    if (ch === '\n') {
      newline();
      i++;
    } else if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
    } else if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const q = src.slice(i, i + 3);
      const basic = q === '"""';
      i += 3;
      while (i < n && !src.startsWith(q, i)) {
        if (basic && src[i] === '\\') i++; // the escaped character, which may be a newline
        if (src[i] === '\n') newline();
        i++;
      }
      i += 3;
      // Up to two quotes right before the closing delimiter belong to the string.
      for (let extra = 0; extra < 2 && src[i] === q[0]; extra++) i++;
      cur += '""';
    } else if (ch === '"' || ch === "'") {
      i++;
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (ch === '"' && src[i] === '\\' && src[i + 1] !== '\n') i++;
        i++;
      }
      if (src[i] === ch) i++;
      cur += '""';
    } else {
      cur += ch;
      i++;
    }
  }
  lines.push(cur);
  return lines;
}

function tomlError(err: unknown): ConfigError {
  // Bun throws a BuildMessage {message, position:{line (1-based), column, lineText}} for one error and
  // an AggregateError whose `errors` are BuildMessages for several. The line text is not echoed.
  const first = err instanceof AggregateError && err.errors.length > 0 ? err.errors[0] : err;
  const message = String((first as { message?: unknown } | null)?.message ?? 'invalid TOML');
  const pos = (first as { position?: TomlPosition } | null)?.position;
  const at = typeof pos?.line === 'number' ? `line ${pos.line}` : 'toml';
  return new ConfigError(at, `invalid TOML: ${message}`);
}

// ---- secrets never live in the file (§13, D-73) ----------------------------------------------------

/** Field names that hold a credential. Compared after lower-casing and '-' / ' ' → '_'. */
const KEY_LIKE_NAMES = new Set([
  'key', 'token', 'auth', 'authorization', 'bearer', 'credential', 'credentials',
  'access_token', 'auth_token', 'api_token', 'bearer_token', 'refresh_token', 'session_token', 'id_token',
  'private_key', 'secret_key', 'access_key', 'x_api_key',
]);
/** Substrings that mark a credential wherever they appear in a field name. */
const KEY_LIKE_PARTS = ['api_key', 'apikey', 'password', 'passwd', 'passphrase', 'secret'];

function isKeyLikeName(name: string): boolean {
  const n = name.toLowerCase().replace(/[-\s]/g, '_');
  return KEY_LIKE_NAMES.has(n) || KEY_LIKE_PARTS.some((p) => n.includes(p));
}

/** String values shaped like well-known API keys (prefix + a long run of key characters), or a JWT. */
const KEY_LIKE_VALUE =
  /^(?:Bearer\s+\S{8,}|(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}|(?:xai|gsk|hf|ghp|github_pat|nvapi|pplx|r8|csk)[-_][A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)$/;

/**
 * Walk the whole tree: a key-like field name or a key-shaped string value anywhere → ConfigError,
 * which never repeats the value. Names that are user identifiers rather than fields (connection ids,
 * "conn:model" table names, header names whose values are env variable names, book names) are not
 * judged by name; their values still are.
 */
function refuseSecrets(v: unknown, path: string[]): void {
  if (typeof v === 'string') {
    if (KEY_LIKE_VALUE.test(v.trim())) {
      throw new ConfigError(fmt(path), 'this looks like an API key; keys never go in config.toml: use key_env or key_cmd');
    }
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => refuseSecrets(x, [...path, String(i)]));
    return;
  }
  if (!isTable(v)) return;
  const namesAreIds = isIdentifierTable(path);
  for (const [k, x] of Object.entries(v)) {
    if (!namesAreIds && isKeyLikeName(k)) {
      throw new ConfigError(
        fmt([...path, k]),
        'API keys and other secrets never go in config.toml: set key_env (the name of an environment variable) or key_cmd (a command that prints the key)',
      );
    }
    refuseSecrets(x, [...path, k]);
  }
}

function isIdentifierTable(path: readonly string[]): boolean {
  const [a, b, c] = path;
  if (path.length === 1) return a === 'connections' || a === 'caps' || a === 'prices';
  if (path.length === 2) return a === 'compendium' && b === 'books';
  if (path.length === 3) return a === 'connections' && c === 'headers';
  return false;
}

// ---- a strict reader over one table ----------------------------------------------------------------

/** Reads typed fields from one table; done() refuses every field it was not asked about. */
class Fields {
  private readonly used = new Set<string>();
  constructor(
    readonly t: Table,
    readonly path: string[],
  ) {}

  at(k: string): string {
    return fmt([...this.path, k]);
  }
  private take(k: string): unknown {
    this.used.add(k);
    return this.t[k];
  }
  has(k: string): boolean {
    return this.t[k] !== undefined;
  }
  raw(k: string): unknown {
    return this.take(k);
  }
  str(k: string, o: { nonEmpty?: boolean; max?: number } = {}): string | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new ConfigError(this.at(k), 'must be a string');
    if (o.nonEmpty && v.trim() === '') throw new ConfigError(this.at(k), 'must not be empty');
    if (o.max !== undefined && [...v].length > o.max) throw new ConfigError(this.at(k), `must be at most ${o.max} characters`);
    return v;
  }
  bool(k: string): boolean | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw new ConfigError(this.at(k), 'must be true or false');
    return v;
  }
  int(k: string, min: number, max: number): number | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new ConfigError(this.at(k), `must be a whole number from ${min} to ${max}`);
    }
    return v;
  }
  num(k: string, min: number, max: number): number | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new ConfigError(this.at(k), `must be a number from ${min} to ${max}`);
    }
    return v;
  }
  oneOf<T extends string>(k: string, values: readonly T[]): T | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      throw new ConfigError(this.at(k), `must be one of ${values.map((x) => `"${x}"`).join(', ')}`);
    }
    return v as T;
  }
  strArray(k: string, o: { nonEmpty?: boolean; oneOf?: readonly string[] } = {}): string[] | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
      throw new ConfigError(this.at(k), 'must be an array of non-empty strings');
    }
    if (o.nonEmpty && v.length === 0) throw new ConfigError(this.at(k), 'must not be empty');
    if (o.oneOf && v.some((x) => !o.oneOf!.includes(x as string))) {
      throw new ConfigError(this.at(k), `may only hold ${o.oneOf.map((x) => `"${x}"`).join(', ')}`);
    }
    return [...(v as string[])];
  }
  table(k: string): Table | undefined {
    const v = this.take(k);
    if (v === undefined) return undefined;
    if (!isTable(v)) throw new ConfigError(this.at(k), 'must be a table');
    return v;
  }
  /**
   * A required field is missing: when another key of the table is that field misspelled
   * (`base-url`, `Base_URL`), name that key with a did-you-mean hint, which is what the user needs;
   * otherwise say the field is required.
   */
  missing(k: string, why: string): ConfigError {
    const typo = Object.keys(this.t).find((x) => x !== k && x.toLowerCase().replace(/-/g, '_') === k);
    return typo !== undefined ? new ConfigError(this.at(typo), `unknown field; did you mean ${k}?`) : new ConfigError(this.at(k), why);
  }
  /** Every field not read is a typo or a field from another version: refuse it, with a hint. */
  done(known?: readonly string[]): void {
    for (const k of Object.keys(this.t)) {
      if (this.used.has(k)) continue;
      const near = (known ?? [...this.used]).find((u) => u === k.toLowerCase().replace(/-/g, '_'));
      throw new ConfigError(this.at(k), near ? `unknown field; did you mean ${near}?` : 'unknown field');
    }
  }
}

// ---- [connections.<id>] -------------------------------------------------------------------------------

const CONNECTION_FIELDS = [
  'dialect', 'base_url', 'key_env', 'key_cmd', 'max_in_flight', 'headers', 'extra_body', 'exclude_body',
  'local', 'api_version', 'cache_ttl',
] as const;

/** Official endpoints of the native dialects, for configs that leave base_url out (the §13 example). */
const DEFAULT_BASE_URL: Partial<Record<ConnectionConfig['dialect'], string>> = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

function parseConnections(t: Table | undefined): Record<string, ConnectionConfig> {
  const out: Record<string, ConnectionConfig> = {};
  for (const [id, v] of Object.entries(t ?? {})) {
    const path = ['connections', id];
    if (id.includes(':')) {
      throw new ConfigError(fmt(path), 'connection names cannot contain ":" (bindings "<connection>:<model>" split at the first ":")');
    }
    if (!CONNECTION_ID.test(id)) throw new ConfigError(fmt(path), 'connection names may only contain letters, digits, "_" and "-"');
    if (!isTable(v)) throw new ConfigError(fmt(path), 'must be a table');
    out[id] = parseConnection(id, v, path);
  }
  return out;
}

function parseConnection(id: string, t: Table, path: string[]): ConnectionConfig {
  const f = new Fields(t, path);
  const dialect = f.oneOf('dialect', ['openai-chat', 'anthropic', 'gemini'] as const) ?? 'openai-chat';

  const rawUrl = f.str('base_url');
  const baseUrl = rawUrl ?? DEFAULT_BASE_URL[dialect];
  if (baseUrl === undefined) throw f.missing('base_url', 'required (e.g. "http://127.0.0.1:8080")');
  checkBaseUrl(baseUrl, f.at('base_url'));
  const c: ConnectionConfig = { id, dialect, baseUrl };

  const keyEnv = f.str('key_env');
  if (keyEnv !== undefined) {
    if (!ENV_NAME.test(keyEnv)) {
      throw new ConfigError(f.at('key_env'), 'must be the NAME of an environment variable (letters, digits, "_"), not the key itself');
    }
    c.keyEnv = keyEnv;
  }
  const keyCmd = f.strArray('key_cmd', { nonEmpty: true });
  if (keyCmd !== undefined) c.keyCmd = keyCmd;
  if (keyEnv !== undefined && keyCmd !== undefined) {
    throw new ConfigError(f.at('key_cmd'), 'set either key_env or key_cmd, not both');
  }

  const maxInFlight = f.int('max_in_flight', 1, 64);
  if (maxInFlight !== undefined) c.maxInFlight = maxInFlight;

  const headers = f.table('headers');
  if (headers !== undefined) {
    const out: Record<string, string> = {};
    for (const [name, envName] of Object.entries(headers)) {
      const at = fmt([...path, 'headers', name]);
      if (!HEADER_NAME.test(name)) throw new ConfigError(at, 'not a valid HTTP header name');
      if (PROTECTED_HEADERS.includes(name.toLowerCase())) {
        throw new ConfigError(at, 'protected header: rp-core sets it itself (the API key comes from key_env or key_cmd)');
      }
      if (typeof envName !== 'string' || !ENV_NAME.test(envName)) {
        throw new ConfigError(at, 'must be the NAME of the environment variable that holds the header value');
      }
      out[name] = envName;
    }
    c.headers = out;
  }

  const extraBody = f.table('extra_body');
  if (extraBody !== undefined) {
    for (const k of Object.keys(extraBody)) {
      if (PROTECTED_BODY_KEYS.includes(k)) throw new ConfigError(fmt([...path, 'extra_body', k]), 'protected body field; it cannot be overridden');
    }
    c.extraBody = extraBody;
  }
  const excludeBody = f.strArray('exclude_body');
  if (excludeBody !== undefined) {
    const bad = excludeBody.find((k) => PROTECTED_BODY_KEYS.includes(k));
    if (bad !== undefined) throw new ConfigError(f.at('exclude_body'), `"${bad}" is a protected body field; it cannot be left out`);
    c.excludeBody = excludeBody;
  }

  const local = f.bool('local');
  if (local !== undefined) c.local = local;

  if (f.has('api_version') && dialect !== 'anthropic') throw new ConfigError(f.at('api_version'), 'only anthropic connections take api_version');
  const apiVersion = f.str('api_version', { nonEmpty: true });
  if (apiVersion !== undefined) c.apiVersion = apiVersion;
  if (f.has('cache_ttl') && dialect !== 'anthropic') throw new ConfigError(f.at('cache_ttl'), 'only anthropic connections take cache_ttl');
  const cacheTtl = f.oneOf('cache_ttl', ['5m', '1h'] as const);
  if (cacheTtl !== undefined) c.cacheTtl = cacheTtl;

  f.done(CONNECTION_FIELDS);
  return c;
}

function checkBaseUrl(raw: string, at: string): void {
  // The URL itself is never echoed: it may carry credentials.
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(at, 'must be an http:// or https:// URL');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '') {
    throw new ConfigError(at, 'must be an http:// or https:// URL');
  }
  if (u.username !== '' || u.password !== '') {
    throw new ConfigError(at, 'must not carry a user name or password; the key comes from key_env or key_cmd');
  }
  for (const name of u.searchParams.keys()) {
    if (isKeyLikeName(name)) throw new ConfigError(at, 'must not carry a key in its query string; use key_env or key_cmd');
  }
  if (u.hash !== '') throw new ConfigError(at, 'must not have a #fragment');
}

// ---- [roles], [narrator], [director], [compendium] -----------------------------------------------------

type RoleDefaults = NonNullable<DeepPartial<SessionConfig>['roles']>;

function parseRoles(t: Table, ids: ReadonlySet<string>): RoleDefaults {
  const f = new Fields(t, ['roles']);
  const out: RoleDefaults = {};

  const binding = (k: string, refs: readonly ('narrator' | 'recorder')[]): Binding | 'narrator' | 'recorder' | undefined => {
    const v = f.str(k);
    if (v === undefined) return undefined;
    if ((refs as readonly string[]).includes(v)) return v as 'narrator' | 'recorder';
    if (!v.includes(':')) {
      const alt = refs.map((r) => ` or "${r}"`).join('');
      throw new ConfigError(f.at(k), `expected "<connection>:<model>"${alt}`);
    }
    return bindTo(v, f.at(k), ids);
  };

  const narrator = binding('narrator', []);
  if (narrator !== undefined) out.narrator = narrator as Binding;

  const fallback = f.str('narrator_fallback');
  if (fallback !== undefined && fallback !== '') {
    const fb = bindTo(fallback, f.at('narrator_fallback'), ids);
    out.narrator = { ...(out.narrator ?? {}), fallback: { conn: fb.conn, model: fb.model } };
  }

  const director = binding('director', ['narrator']);
  if (director !== undefined) out.director = director as Binding | 'narrator';
  const recorder = binding('recorder', ['narrator']);
  if (recorder !== undefined) out.recorder = recorder as Binding | 'narrator';
  const recall = binding('recall', ['narrator', 'recorder']);
  if (recall !== undefined) out.recall = recall;

  f.done(['narrator', 'narrator_fallback', 'director', 'recorder', 'recall']);
  return out;
}

/** A 'conn:model' binding whose connection is declared in [connections]. */
function bindTo(spec: string, at: string, ids: ReadonlySet<string>): Binding {
  const { conn, model } = splitBinding(spec, at);
  if (!ids.has(conn)) throw new ConfigError(at, `connection "${conn}" is not defined in [connections]`);
  return { conn, model };
}

/** A "conn:model" table name under [caps] / [prices]. */
function modelKey(spec: string, path: string[], ids: ReadonlySet<string>): void {
  bindTo(spec, fmt(path), ids);
}

function parseNarrator(t: Table): NonNullable<DeepPartial<SessionConfig>['narrator']> {
  const f = new Fields(t, ['narrator']);
  const out: NonNullable<DeepPartial<SessionConfig>['narrator']> = {};
  const maxRounds = f.int('max_rounds', 1, 8);
  if (maxRounds !== undefined) out.maxRounds = maxRounds;
  const pvt = f.oneOf('prefill_vs_tools', ['prefill', 'tools'] as const);
  if (pvt !== undefined) out.prefillVsTools = pvt;
  f.done(['max_rounds', 'prefill_vs_tools']);
  return out;
}

function parseDirector(t: Table): NonNullable<DeepPartial<SessionConfig>['director']> {
  const f = new Fields(t, ['director']);
  const out: NonNullable<DeepPartial<SessionConfig>['director']> = {};
  const enabled = f.bool('enabled');
  if (enabled !== undefined) out.enabled = enabled;
  const profile = f.oneOf('profile', ['auto', 'full', 'lite'] as const);
  if (profile !== undefined) out.profile = profile;
  const onSwipe = f.oneOf('on_swipe', ['reuse', 'replan'] as const);
  if (onSwipe !== undefined) out.onSwipe = onSwipe;
  // D-64: standing instructions up to 2 000 characters.
  const instructions = f.str('instructions', { max: 2000 });
  if (instructions !== undefined) out.instructions = instructions;
  const style = f.str('style', { nonEmpty: true, max: 64 });
  if (style !== undefined) out.style = style;
  const creativity = f.oneOf('creativity', ['subtle', 'moderate', 'dramatic'] as const);
  if (creativity !== undefined) out.creativity = creativity;
  const timeoutSec = f.int('timeout_sec', 1, 3600);
  if (timeoutSec !== undefined) out.timeoutSec = timeoutSec;
  f.done(['enabled', 'profile', 'on_swipe', 'instructions', 'style', 'creativity', 'timeout_sec']);
  return out;
}

/** §7.4.9 is M5: the table is kept as written (snake_case); only `enabled` is checked now. */
function parseCompendium(t: Table): NonNullable<DeepPartial<SessionConfig>['compendium']> {
  if (t.enabled !== undefined && typeof t.enabled !== 'boolean') {
    throw new ConfigError('compendium.enabled', 'must be true or false');
  }
  return structuredClone(t) as NonNullable<DeepPartial<SessionConfig>['compendium']>;
}

// ---- [caps."conn:model"] ---------------------------------------------------------------------------

const CAPS_FIELDS = [
  'tools', 'tool_choice', 'tool_choice_honored', 'parallel_tool_calls', 'strict_tools', 'tool_id_format',
  'structured_output', 'mid_system', 'alternation', 'prefill', 'context_length', 'max_output',
  'max_tokens_field', 'reasoning', 'samplers', 'samplers_accepted', 'samplers_fixed', 'samplers_wire',
  'stream_usage', 'caching', 'max_in_flight', 'cache_min_tokens', 'stop_max', 'extra_body',
] as const;

/** snake_case caps fields → Partial<ModelCaps>; `dialect` and `source` are not the user's to set. */
function parseCaps(t: Table, path: string[]): Partial<ModelCaps> {
  const f = new Fields(t, path);
  const out: Partial<ModelCaps> = {};
  const set = <K extends keyof ModelCaps>(k: K, v: ModelCaps[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };

  set('tools', f.oneOf('tools', ['native', 'prompted', 'none'] as const));
  set('toolChoice', f.strArray('tool_choice', { oneOf: ['auto', 'none', 'required'] }) as ModelCaps['toolChoice'] | undefined);
  set('toolChoiceHonored', f.bool('tool_choice_honored'));
  set('parallelToolCalls', f.oneOf('parallel_tool_calls', ['send-true', 'param', 'never'] as const));
  set('strictTools', f.bool('strict_tools'));
  set('toolIdFormat', f.oneOf('tool_id_format', ['mistral9'] as const));
  set('midSystem', f.oneOf('mid_system', ['anthropic-native', 'native', 'as-user'] as const));
  set('alternation', f.oneOf('alternation', ['free', 'strict'] as const));
  set('prefill', f.oneOf('prefill', ['assistant-last', 'prefix-flag', 'none'] as const));
  set('contextLength', f.int('context_length', 256, 100_000_000));
  set('maxOutput', f.int('max_output', 1, 100_000_000));
  set('maxTokensField', f.oneOf('max_tokens_field', ['max_tokens', 'max_completion_tokens'] as const));
  set('streamUsage', f.oneOf('stream_usage', ['stream_options', 'always', 'timings', 'none'] as const));
  set('caching', f.oneOf('caching', ['auto-prefix', 'anthropic-breakpoints', 'none'] as const));
  set('maxInFlight', f.int('max_in_flight', 1, 64));
  set('cacheMinTokens', f.int('cache_min_tokens', 1, 1_000_000));
  set('stopMax', f.int('stop_max', 0, 1024));

  // structured_output = "json_schema" or { mode = "json_schema" }; an override is confirmed by the user.
  const so = f.raw('structured_output');
  if (so !== undefined) {
    const sf = isTable(so) ? new Fields(so, [...path, 'structured_output']) : null;
    const mode = sf ? sf.oneOf('mode', ['json_schema', 'none'] as const) : so;
    if (mode !== 'json_schema' && mode !== 'none') {
      throw new ConfigError(f.at('structured_output'), 'must be "json_schema" or "none"');
    }
    sf?.done(['mode']);
    out.structuredOutput = { mode, confirmedBy: 'user' };
  }

  const reasoning = f.table('reasoning');
  if (reasoning !== undefined) out.reasoning = parseReasoning(reasoning, [...path, 'reasoning']);

  // samplers: either the flat samplers_* fields or a [samplers] sub-table, not both.
  const flat = ['samplers_accepted', 'samplers_fixed', 'samplers_wire'].filter((k) => f.has(k));
  const sub = f.table('samplers');
  if (sub !== undefined && flat.length > 0) {
    throw new ConfigError(f.at(flat[0]!), 'set samplers either as samplers_* fields or as a samplers table, not both');
  }
  const samplers = sub
    ? readSamplers(new Fields(sub, [...path, 'samplers']), '')
    : readSamplers(f, 'samplers_');
  if (samplers) out.samplers = samplers;

  const extraBody = f.table('extra_body');
  if (extraBody !== undefined) {
    for (const k of Object.keys(extraBody)) {
      if (PROTECTED_BODY_KEYS.includes(k)) throw new ConfigError(fmt([...path, 'extra_body', k]), 'protected body field; it cannot be overridden');
    }
    out.extraBody = extraBody;
  }

  f.done(CAPS_FIELDS);
  return out;
}

function readSamplers(f: Fields, prefix: string): ModelCaps['samplers'] | undefined {
  const accepted = f.strArray(`${prefix}accepted`);
  const fixed = f.bool(`${prefix}fixed`);
  const wireT = f.table(`${prefix}wire`);
  let wire: Record<string, string> | undefined;
  if (wireT !== undefined) {
    wire = {};
    for (const [k, v] of Object.entries(wireT)) {
      if (typeof v !== 'string' || v === '') throw new ConfigError(fmt([...f.path, `${prefix}wire`, k]), 'must be a non-empty string (the field name on the wire)');
      wire[k] = v;
    }
  }
  if (prefix === '') f.done(['accepted', 'fixed', 'wire']);
  if (accepted === undefined && fixed === undefined && wire === undefined) return undefined;
  // A partial samplers record: mergeCaps merges it over the resolved one.
  const s: Partial<ModelCaps['samplers']> = {};
  if (accepted !== undefined) s.accepted = accepted;
  if (fixed !== undefined) s.fixed = fixed;
  if (wire !== undefined) s.wire = wire;
  return s as ModelCaps['samplers'];
}

function parseReasoning(t: Table, path: string[]): ModelCaps['reasoning'] {
  const f = new Fields(t, path);
  const r: Partial<ModelCaps['reasoning']> = {};
  const output = f.oneOf('output', [
    'none', 'reasoning_content', 'reasoning', 'reasoning_details', 'tags', 'anthropic-blocks', 'gemini-parts',
  ] as const);
  if (output !== undefined) r.output = output;
  const tags = f.strArray('tags');
  if (tags !== undefined) r.tags = tags;
  const control = f.oneOf('control', ['none', 'effort', 'budget', 'adaptive', 'level', 'toggle'] as const);
  if (control !== undefined) r.control = control;
  const canDisable = f.bool('can_disable');
  if (canDisable !== undefined) r.canDisable = canDisable;
  const offShape = f.raw('off_shape');
  if (offShape !== undefined) r.offShape = offShape;
  const echo = f.oneOf('echo', ['never', 'tool-turn', 'all-with-tools'] as const);
  if (echo !== undefined) r.echo = echo;
  const air = f.bool('answer_in_reasoning');
  if (air !== undefined) r.answerInReasoning = air;
  const efforts = f.strArray('efforts');
  if (efforts !== undefined) r.efforts = efforts;
  f.done(['output', 'tags', 'control', 'can_disable', 'off_shape', 'echo', 'answer_in_reasoning', 'efforts']);
  // A partial reasoning record: mergeCaps merges it over the resolved one.
  return r as ModelCaps['reasoning'];
}

// ---- [prices."conn:model"] ---------------------------------------------------------------------------

function parsePrice(t: Table, path: string[]): PriceRow {
  const f = new Fields(t, path);
  const inPerM = f.num('in_per_m', 0, 1_000_000);
  const outPerM = f.num('out_per_m', 0, 1_000_000);
  const asOf = f.str('as_of');
  f.done(['in_per_m', 'out_per_m', 'as_of']);
  if (inPerM === undefined) throw f.missing('in_per_m', 'required (USD per million input tokens)');
  if (outPerM === undefined) throw f.missing('out_per_m', 'required (USD per million output tokens)');
  if (asOf === undefined) throw f.missing('as_of', 'required: the date the price was checked, as a string "YYYY-MM-DD"');
  if (!isIsoDate(asOf)) throw new ConfigError(f.at('as_of'), 'must be a date string "YYYY-MM-DD"');
  return { inPerM, outPerM, asOf };
}

function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
