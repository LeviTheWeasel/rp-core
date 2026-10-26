// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What every CLI command that talks to a model needs (ARCHITECTURE.md §13, §15 M1b): <home>/config.toml,
// the engine Connections built from it, the price table, and the --provider override. One place, so
// `new`, `chat`, `send` and `probe` see the same connections.
//
// Nothing here touches the network: building a connection only resolves caps from data files and the
// probe cache (<home>/caps-cache.json). Keys are resolved lazily at the first call that needs one.

import type { Connection, EngineOptions } from '../engine/api.ts';
import { buildConnections, loadConfig, type RpConfig } from '../config/config.ts';
import { createSecretResolver, scrub, type SecretResolver } from '../config/secrets.ts';
import type { ProviderError } from '../providers/types.ts';
import { readCapsCache, type CapsCacheRow } from '../providers/probe.ts';

export interface Runtime {
  home: string;
  /** The environment the connections were built from (header values, key_env). */
  env: Record<string, string | undefined>;
  config: RpConfig;
  /** openai-chat connections of config.toml, ready for the engine. */
  connections: Record<string, Connection>;
  /** Connections in config.toml that cannot run yet (anthropic M7, gemini M8), with the reason. */
  skipped: { id: string; why: string }[];
  secrets: SecretResolver;
  /** --provider script:<file>: every role resolves to this one for this process. */
  provider?: Connection;
  /**
   * --debug: where a raw provider failure goes (one line, already scrubbed of every known secret).
   * Read at the moment of the failure, so the REPL can route it through its own screen while it runs.
   * Without --debug the server's own words are never printed (§13).
   */
  debug?: (line: string) => void;
}

/** Text with every secret this runtime knows (keys resolved so far, header values) replaced. */
export function redactor(rt: Pick<Runtime, 'secrets'>): (text: string) => string {
  return (text) => scrub(text, rt.secrets.known());
}

/** One --debug line about a provider failure: what the events say, plus the server's own words. */
export function debugLine(i: { callKey: string; model: string; error: ProviderError }): string {
  const e = i.error;
  const status = e.status !== undefined ? ` HTTP ${e.status}` : '';
  return `${i.model} (${i.callKey}) ${e.category}/${e.code}${status}: ${e.message}${e.detail !== undefined ? ` | server: ${e.detail}` : ''}`;
}

/**
 * Read config.toml (a missing file is an empty config), build its connections with keys from the
 * environment (key_env / key_cmd) and caps from the probe cache. Throws ConfigError (exit 64 in main).
 */
export function loadRuntime(
  home: string,
  env: Record<string, string | undefined>,
  opts: { provider?: Connection; capsCache?: Record<string, CapsCacheRow>; debug?: (line: string) => void } = {},
): Runtime {
  const config = loadConfig(home);
  const secrets = createSecretResolver({ env });
  const capsCache = opts.capsCache ?? readCapsCache(home);
  const { connections, skipped } = buildConnections(config, { env, secrets, capsCache });
  return {
    home,
    env,
    config,
    connections,
    skipped,
    secrets,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.debug ? { debug: opts.debug } : {}),
  };
}

/**
 * The connections again, over another probe cache (what `rp-core probe` shows: the caps a model
 * gets once the fresh catalog is stored). Same config, env and secret resolver.
 */
export function connectionsWith(rt: Runtime, capsCache: Record<string, CapsCacheRow>): Record<string, Connection> {
  return buildConnections(rt.config, { env: rt.env, secrets: rt.secrets, capsCache }).connections;
}

/** The engine options of a runtime: connections, prices, the override, and the --debug tap. */
export function engineOptions(rt: Runtime): EngineOptions {
  const o: EngineOptions = { home: rt.home, connections: rt.connections };
  if (Object.keys(rt.config.prices).length > 0) o.prices = rt.config.prices;
  if (rt.provider) o.providerOverride = rt.provider;
  if (rt.debug) {
    const redact = redactor(rt);
    // rt.debug is read when a failure happens (the REPL swaps it while it runs).
    o.onProviderError = (i) => rt.debug?.(redact(debugLine(i)));
  }
  return o;
}

/**
 * Why `conn` cannot serve a binding, or null when it can: not in config.toml, or a dialect that
 * arrives later. The caller decides whether that is an error (it is not under --provider).
 */
export function connectionProblem(rt: Runtime, conn: string): string | null {
  if (Object.hasOwn(rt.connections, conn)) return null;
  const skipped = rt.skipped.find((s) => s.id === conn);
  if (skipped) return `connection "${conn}" cannot be used: ${skipped.why}`;
  const where = rt.config.path ?? `${rt.home}/config.toml (missing: rp-core init writes a starter)`;
  const known = Object.keys(rt.connections);
  return `no connection "${conn}" in ${where}${known.length > 0 ? `; known: ${known.join(', ')}` : ''}`;
}

/** The context window to show for a binding before its first answer: the resolved caps', else null. */
export function windowOf(rt: Runtime, conn: string, model: string): number | null {
  if (rt.provider) return null;
  const c = Object.hasOwn(rt.connections, conn) ? rt.connections[conn] : undefined;
  if (!c) return null;
  try {
    const caps = c.capsFor ? c.capsFor(model) : c.caps;
    return typeof caps.contextLength === 'number' && caps.contextLength > 0 ? caps.contextLength : null;
  } catch {
    return null;
  }
}
