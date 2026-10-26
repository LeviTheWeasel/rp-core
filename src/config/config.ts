// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// <home>/config.toml (ARCHITECTURE.md §13, D-53, D-73, D-84). Parsed with Bun.TOML.parse, validated by
// hand with error paths. No secrets in the file: fields that look like keys are refused.
// CONTRACT FILE (M1b): signatures are fixed; the config agent implements the bodies.

import type { ModelCaps } from '../providers/types.ts';
import type { DeepPartial, SessionConfig } from '../session/entries.ts';
import type { Connection } from '../engine/api.ts';
import type { SecretResolver } from './secrets.ts';

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
  void home;
  throw new Error('not implemented: configPath');
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
  void text; void path;
  throw new Error('not implemented: parseConfig');
}

/** Read <home>/config.toml; a missing file is an empty config (path null). */
export function loadConfig(home: string): RpConfig {
  void home;
  throw new Error('not implemented: loadConfig');
}

/** 'conn:model' → {conn, model} at the first ':'; throws ConfigError on a missing part. */
export function splitBinding(spec: string, path?: string): { conn: string; model: string } {
  void spec; void path;
  throw new Error('not implemented: splitBinding');
}

/** A commented starter config.toml: local Ollama, llama.cpp, LM Studio, OpenRouter (key_env). */
export const CONFIG_TEMPLATE: string = "";

/**
 * Build engine Connections for every openai-chat connection: provider = createOpenAIChatProvider,
 * origin = originOf(base_url), local = isLocalOrigin unless overridden, caps = resolveCaps for model ''
 * and capsFor(model) = resolveCaps with host preset, model rows, catalog/probe cache rows for
 * "conn:model" and user overrides; resolveKey via the SecretResolver (lazy, memoised); header values
 * read from env at build time (missing env → ConfigError). anthropic/gemini connections are skipped and
 * reported in `skipped`.
 */
export function buildConnections(
  cfg: RpConfig,
  deps: {
    env: Record<string, string | undefined>;
    secrets: SecretResolver;
    capsCache: Record<string, { server?: string; caps: Partial<ModelCaps> }>;
  },
): { connections: Record<string, Connection>; skipped: { id: string; why: string }[] } {
  void cfg; void deps;
  throw new Error('not implemented: buildConnections');
}
