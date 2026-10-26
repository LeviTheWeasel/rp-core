// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core probe [conn[:model]]` and `rp-core models <conn>` (ARCHITECTURE.md §8.2 source 3/4, §15 M1b:
// the catalog half of probe). A probe only ADVISES [D-84]: it prints what the server says (kind,
// models, windows, slots) and the caps a model would get with that knowledge; --write stores the
// catalog rows in <home>/caps-cache.json, where new turns pick them up as the probe source.
//
// The keys of config.toml are used when present (OpenRouter lists models without one, so a missing
// key is a note, not a failure). Requests go through providers/probe.ts (guardedFetch, same origin,
// short per-request timeouts); nothing here retries.

import type { Connection } from '../engine/api.ts';
import { fetchCatalog, listModels, readCapsCache, writeCapsCache, capsCachePath, type CapsCacheRow, type CatalogInfo } from '../providers/probe.ts';
import { ProviderError, type ModelCaps } from '../providers/types.ts';
import { UsageError } from './args.ts';
import { CliError } from './commands.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { connectionProblem, connectionsWith, redactor, type Runtime } from './runtime.ts';

export interface CatalogArgs {
  rt: Runtime;
  io: Io;
  json: boolean;
  /** globalThis.fetch by default (tests: a mock server is reached the same way). */
  fetch?: typeof fetch;
  /** The wall clock for the cache rows' as_of (injected: src/ reads no clock of its own). */
  clock: () => Date;
  /** Per-request timeout of the probe (default PROBE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** One probed connection, as --json prints it. */
export interface ProbeResult {
  connection: string;
  baseUrl: string;
  ok: boolean;
  /** Set when nothing answered (ok false). */
  error?: string;
  server?: CatalogInfo['server'];
  models?: CatalogInfo['models'];
  slots?: number;
  notes: string[];
  /** The model whose caps are shown: the one asked for, or the only one the server lists. */
  model?: string;
  /** Its caps with this probe stored (sources in caps.source). */
  caps?: ModelCaps;
  /** True when --write stored rows of this connection. */
  written: boolean;
  /** --write was given but nothing of this connection was stored: why. */
  notStored?: string;
}

/** A cache row that says something: a known server kind or at least one caps fact. */
function rowSaysSomething(row: CapsCacheRow): boolean {
  return row.server !== 'unknown' || Object.keys(row.caps).length > 0;
}

/** `conn` or `conn:model` (split at the first ':'), optionally a second positional model. */
export function parseProbeTarget(target: string, model?: string): { conn: string; model?: string } {
  const at = target.indexOf(':');
  const conn = at < 0 ? target : target.slice(0, at);
  const inline = at < 0 ? undefined : target.slice(at + 1);
  if (conn === '') throw new UsageError(`expected <connection>[:<model>], got ${JSON.stringify(target)}`, 'probe');
  if (inline !== undefined && model !== undefined) throw new UsageError('give the model once: <connection>:<model> or <connection> <model>', 'probe');
  const m = inline ?? model;
  if (m !== undefined && m.trim() === '') throw new UsageError(`the model after "${conn}:" is missing`, 'probe');
  return m !== undefined ? { conn, model: m } : { conn };
}

function connectionOf(rt: Runtime, conn: string, command: string): Connection {
  const problem = connectionProblem(rt, conn);
  if (problem) throw new UsageError(problem, command);
  const c = rt.connections[conn]!;
  if (c.baseUrl === undefined) throw new CliError(`connection "${conn}" has no base URL to probe`);
  return c;
}

/** The connection's key when it has one; a key that cannot be resolved is a note (catalogs are often public). */
async function keyFor(c: Connection, notes: string[]): Promise<string | null> {
  try {
    return c.resolveKey ? await c.resolveKey() : (c.key ?? null);
  } catch (e) {
    notes.push(`no key: ${e instanceof Error ? e.message : String(e)}; probing without one`);
    return null;
  }
}

const errText = (e: unknown): string => (e instanceof ProviderError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/**
 * `rp-core probe [conn[:model]] [--write] [--json]`: ask each named (else every) connection's server
 * for its catalog. Exit 0 when every server answered, 1 otherwise.
 */
export async function cmdProbe(a: CatalogArgs & { target?: string; model?: string; write: boolean }): Promise<number> {
  const { rt } = a;
  const wanted: { conn: Connection; model?: string }[] = [];
  if (a.target !== undefined) {
    const t = parseProbeTarget(a.target, a.model);
    wanted.push({ conn: connectionOf(rt, t.conn, 'probe'), ...(t.model !== undefined ? { model: t.model } : {}) });
  } else {
    if (a.model !== undefined) throw new UsageError('a model needs its connection: rp-core probe <connection>:<model>', 'probe');
    for (const c of Object.values(rt.connections)) wanted.push({ conn: c });
    if (wanted.length === 0) {
      const where = rt.config.path ?? `${rt.home}/config.toml (missing: rp-core init writes a starter)`;
      throw new CliError(`no connections to probe in ${where}`);
    }
  }

  const doFetch = a.fetch ?? fetch;
  const asOf = a.clock().toISOString().slice(0, 10);
  let cache: Record<string, CapsCacheRow> = readCapsCache(rt.home);
  const results: ProbeResult[] = [];

  for (const w of wanted) {
    const c = w.conn;
    const notes: string[] = [];
    const key = await keyFor(c, notes);
    let info: CatalogInfo;
    try {
      info = await fetchCatalog(c.baseUrl!, {
        fetch: doFetch,
        key,
        signal: new AbortController().signal,
        ...(w.model !== undefined ? { model: w.model } : {}),
        ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
      });
    } catch (e) {
      // Messages are fixed sentences at their source; scrubbed all the same before printing (§13).
      results.push({ connection: c.id, baseUrl: c.baseUrl!, ok: false, error: redactor(rt)(errText(e)), notes, written: false });
      continue;
    }
    notes.push(...info.notes);

    // The server refused the key (the key is not exported, or expired): what it said is not this
    // account's catalog, so the probe failed and nothing is stored; the rows a good probe left stay.
    if (info.authFailed) {
      results.push({
        connection: c.id,
        baseUrl: c.baseUrl!,
        ok: false,
        error: "auth_failed: the server refused the key (HTTP 401/403); check the connection's key_env / key_cmd",
        notes,
        written: false,
        ...(a.write ? { notStored: 'the server refused the key' } : {}),
      });
      continue;
    }

    // The rows this probe yields: the model asked for, else every listed model. A row that says
    // nothing (server unknown, no caps) is never stored over what is known, and neither is a model the
    // server does not list (a typo; llama.cpp and koboldcpp serve any name). A whole-connection probe
    // replaces that connection's rows (models the server no longer lists go), unless it found nothing
    // to store: then the old rows stay.
    const listed = new Set(info.models.map((m) => m.id));
    const anyName = info.server === 'llama.cpp' || info.server === 'koboldcpp';
    const ids = w.model !== undefined ? (info.models.length === 0 || anyName || listed.has(w.model) ? [w.model] : []) : info.models.map((m) => m.id);
    const fresh: Record<string, CapsCacheRow> = {};
    for (const id of ids) {
      const row: CapsCacheRow = { as_of: asOf, server: info.server, caps: info.caps[id] ?? {} };
      if (rowSaysSomething(row)) fresh[`${c.id}:${id}`] = row;
    }
    const stored = Object.keys(fresh).length;
    const replaceAll = w.model === undefined && stored > 0;
    const next: Record<string, CapsCacheRow> = {};
    for (const [k, row] of Object.entries(cache)) if (!replaceAll || !k.startsWith(`${c.id}:`)) next[k] = row;
    Object.assign(next, fresh);

    const model = w.model ?? (info.models.length === 1 ? info.models[0]!.id : undefined);
    const r: ProbeResult = { connection: c.id, baseUrl: c.baseUrl!, ok: true, server: info.server, models: info.models, notes, written: a.write && stored > 0 };
    if (a.write && stored === 0) {
      r.notStored =
        w.model !== undefined && ids.length === 0 ? `${w.model} is not in the server's model list` : 'the server told nothing worth keeping (kind unknown, no limits)';
    }
    if (info.slots !== undefined) r.slots = info.slots;
    if (model !== undefined) {
      r.model = model;
      const probed = connectionsWith(rt, next)[c.id];
      if (probed) r.caps = probed.capsFor ? probed.capsFor(model) : probed.caps;
    }
    if (a.write) cache = next;
    results.push(r);
  }

  if (results.some((r) => r.written)) writeCapsCache(rt.home, cache);

  if (a.json) a.io.out.write(`${JSON.stringify(results)}\n`);
  else for (const r of results) a.io.out.write(renderProbe(r, capsCachePath(rt.home)));
  return results.every((r) => r.ok) ? EXIT.done : EXIT.error;
}

/** `rp-core models <conn> [--json]`: the server's model ids, one per line. */
export async function cmdModels(a: CatalogArgs & { conn: string }): Promise<number> {
  const c = connectionOf(a.rt, a.conn, 'models');
  const notes: string[] = [];
  const key = await keyFor(c, notes);
  let out: Awaited<ReturnType<typeof listModels>>;
  try {
    out = await listModels(c.baseUrl!, {
      fetch: a.fetch ?? fetch,
      key,
      signal: new AbortController().signal,
      ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
    });
  } catch (e) {
    throw new CliError(`models ${c.id}: ${redactor(a.rt)(errText(e))}`);
  }
  for (const n of [...notes, ...out.notes]) a.io.err.write(`rp-core: note: ${n}\n`);
  if (a.json) a.io.out.write(`${JSON.stringify(out.models)}\n`);
  else {
    for (const m of out.models) a.io.out.write(`${m.id}\n`);
    if (out.models.length === 0) a.io.err.write(`rp-core: ${c.id} lists no models\n`);
  }
  return EXIT.done;
}

// ---- text output ------------------------------------------------------------------------------------

/** One line of caps, the fields that decide how a turn is sent. */
export function capsSummary(caps: ModelCaps): string[] {
  const r = caps.reasoning;
  const parts: string[] = [];
  if (r.output !== 'none' && r.output !== 'tags') parts.push(`field ${r.output}`);
  if (r.tags?.length) parts.push(`tags ${r.tags.join(' ')}`);
  if (r.control !== 'none') parts.push(`control ${r.control}${r.efforts?.length ? ` (${r.efforts.join('/')})` : ''}${r.canDisable ? ', can be turned off' : ''}`);
  const reasoning = parts.length > 0 ? parts.join(' · ') : 'none';
  const samplers = caps.samplers.fixed ? 'fixed (none sent)' : caps.samplers.accepted.length > 0 ? caps.samplers.accepted.join(' ') : 'none';
  return [
    `context ${caps.contextLength ?? '? (engine default: 8192 local, 32768 remote)'} · max output ${caps.maxOutput ?? '?'} · in flight ${caps.maxInFlight}`,
    `tools ${caps.tools} · tool_choice ${caps.toolChoice.length > 0 ? caps.toolChoice.join('/') : 'never sent'} · structured ${caps.structuredOutput.mode}`,
    `prefill ${caps.prefill} · mid-system ${caps.midSystem} · alternation ${caps.alternation} · usage ${caps.streamUsage}`,
    `reasoning ${reasoning}`,
    `samplers ${samplers}`,
    `source ${caps.source.length > 0 ? caps.source.join(' → ') : 'engine defaults only'}`,
  ];
}

export function renderProbe(r: ProbeResult, cachePath: string): string {
  const out: string[] = [];
  if (!r.ok) {
    const auth = r.error?.startsWith('auth_failed') === true;
    out.push(`${r.connection}  ${r.baseUrl}  ${auth ? 'refused the key' : 'unreachable'}`);
    out.push(`  ${r.error ?? 'no answer'}`);
    for (const n of r.notes) out.push(`  note: ${n}`);
    if (r.notStored !== undefined) out.push(`  not stored: ${r.notStored}`);
    return `${out.join('\n')}\n\n`;
  }
  out.push(`${r.connection}  ${r.baseUrl}  server: ${r.server}`);
  const models = r.models ?? [];
  out.push(`  models (${models.length}):`);
  const width = Math.min(60, Math.max(0, ...models.map((m) => m.id.length)));
  for (const m of models) out.push(`    ${m.id.padEnd(width)}  ctx ${m.contextLength ?? '?'}`);
  if (r.slots !== undefined) out.push(`  slots: ${r.slots} reported (advice only; capacity stays at the connection's max_in_flight)`);
  if (r.notes.length > 0) {
    out.push('  notes:');
    for (const n of r.notes) out.push(`    - ${n}`);
  }
  if (r.model !== undefined && r.caps) {
    out.push(`  caps of ${r.connection}:${r.model}${r.written ? '' : ' (with this probe stored)'}:`);
    for (const l of capsSummary(r.caps)) out.push(`    ${l}`);
  } else if (models.length > 1) {
    out.push(`  caps: name a model to see them (rp-core probe ${r.connection}:<model>)`);
  }
  out.push(r.written ? `  stored in ${cachePath}` : r.notStored !== undefined ? `  not stored: ${r.notStored}` : '  not stored: --write keeps this catalog for new turns');
  return `${out.join('\n')}\n\n`;
}
