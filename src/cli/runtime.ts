// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What every CLI command that talks to a model needs (ARCHITECTURE.md §13, §15 M1b): <home>/config.toml,
// the engine Connections built from it, the price table, and the --provider override (provider.ts
// attaches it). One place, so `new`, `chat`, `send`, `preview` and `probe` see the same connections.
//
// Nothing here touches the network: building a connection only resolves caps from data files and the
// caps cache (<home>/caps-cache.json: catalog facts and active-probe facts, each in its own resolveCaps
// slot). Keys are resolved lazily at the first call that needs one.

import type { Connection, EngineOptions } from '../engine/api.ts';
import { connectionLocality } from '../engine/sched.ts';
import { contextWindow } from '../prompt/budget.ts';
import { buildConnections, loadConfig, type RpConfig } from '../config/config.ts';
import { createSecretResolver, scrub, type SecretResolver } from '../config/secrets.ts';
import type { ModelCaps, ProviderError } from '../providers/types.ts';
import { readCapsCache, type CapsCacheRow } from '../providers/probe.ts';

export interface Runtime {
  home: string;
  /** The environment the connections were built from (header values, key_env). */
  env: Record<string, string | undefined>;
  config: RpConfig;
  /** openai-chat connections of config.toml, ready for the engine (under --provider record: each one records its calls). */
  connections: Record<string, Connection>;
  /** Connections in config.toml that cannot run, with the reason (forward compatibility). */
  skipped: { id: string; why: string }[];
  secrets: SecretResolver;
  /** --provider script:<file> or replay:<file>: every role resolves to this one for this process. */
  provider?: Connection;
  /** --provider record:<file>: the file every model call of `connections` is appended to. */
  recording?: string;
  /**
   * --debug: where a raw provider failure goes (one line, already scrubbed of every known secret).
   * Read at the moment of the failure, so the REPL can route it through its own screen while it runs.
   * Without --debug the server's own words are never printed (§13). `call.job`: the failed call is a
   * background lane pass's (M5b): the REPL holds its line for a pause, as it holds the lane's own lines.
   */
  debug?: (line: string, call?: { job?: string }) => void;
  /**
   * --keep-requests (D-164; chat, tui, new): every provider request of a turn is kept as JSON under
   * <home>/sessions/<id>.requests/ (EngineOptions.keepRequests).
   */
  keepRequests?: boolean;
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
 * environment (key_env / key_cmd) and caps from the caps cache. Throws ConfigError (exit 64 in main).
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
 * The connections again, over another caps cache (what `rp-core probe` shows: the caps a model gets
 * once the fresh catalog, and with --active the probe facts, are stored; and the caps an active probe
 * starts from). Same config, env and secret resolver.
 */
export function connectionsWith(rt: Runtime, capsCache: Record<string, CapsCacheRow>): Record<string, Connection> {
  return buildConnections(rt.config, { env: rt.env, secrets: rt.secrets, capsCache }).connections;
}

/** The engine options of a runtime: connections, prices, the override, the --debug tap and --keep-requests. */
export function engineOptions(rt: Runtime): EngineOptions {
  const o: EngineOptions = { home: rt.home, connections: rt.connections };
  if (Object.keys(rt.config.prices).length > 0) o.prices = rt.config.prices;
  if (rt.provider) o.providerOverride = rt.provider;
  if (rt.keepRequests === true) o.keepRequests = true;
  if (rt.debug) {
    const redact = redactor(rt);
    // rt.debug is read when a failure happens (the REPL swaps it while it runs).
    o.onProviderError = (i) => rt.debug?.(redact(debugLine(i)), i.job !== undefined ? { job: i.job } : {});
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
  return c ? connectionWindow(c, model) : null;
}

/**
 * The caps a binding's turns use (M3: the banner's tools word, /preview's transport): the --provider
 * override's for any binding, else the configured connection's for the model; null when unknown.
 */
export function bindingCaps(rt: Runtime, conn: string, model: string): ModelCaps | null {
  const c = rt.provider ?? (Object.hasOwn(rt.connections, conn) ? rt.connections[conn] : undefined);
  return c ? connectionCaps(c, model) : null;
}

/** A connection's caps for `model` (capsFor when it resolves per model), or null when they cannot be resolved. */
export function connectionCaps(c: Connection, model: string): ModelCaps | null {
  try {
    return c.capsFor ? c.capsFor(model) : c.caps;
  } catch {
    return null;
  }
}

/** The context window a connection's caps state for `model`, or null when they state none. */
export function connectionWindow(c: Connection, model: string): number | null {
  try {
    const caps = c.capsFor ? c.capsFor(model) : c.caps;
    return typeof caps.contextLength === 'number' && caps.contextLength > 0 ? caps.contextLength : null;
  } catch {
    return null;
  }
}

/**
 * M5c (/memory profile, /memory mode; ReplDeps.routeOf): a binding's connection as the engine sees it —
 * its window before the preset's and the session's limits (budget.ts contextWindow over the resolved
 * caps: their context length, else the local or remote default) and whether the scheduler takes its
 * origin for a local server (sched.ts connectionLocality over the connections engineOptions gives the
 * engine, the --provider override's included). The override serves every binding. null when the
 * connection is unknown or its caps cannot be resolved for the model.
 */
export function routeOf(rt: Pick<Runtime, 'connections' | 'provider'>, conn: string, model: string): { window: number; local: boolean } | null {
  const c = rt.provider ?? (Object.hasOwn(rt.connections, conn) ? rt.connections[conn] : undefined);
  if (!c) return null;
  const caps = connectionCaps(c, model);
  if (caps === null) return null;
  const all = Object.values(rt.connections);
  const isLocal = connectionLocality(() => (rt.provider ? [...all, rt.provider] : all));
  return { window: contextWindow({ caps, local: c.local }), local: isLocal(c.origin) };
}
