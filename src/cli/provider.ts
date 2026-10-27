// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `--provider script:<file> | record:<file> | replay:<file>` (ARCHITECTURE.md §12.3, §14, D-40;
// Kintsu K4). `new`, `chat`, `send` and `preview` take it.
// - script: a scripted connection replaces every role's connection for this process
//   (EngineOptions.providerOverride). The script is read from the start on every run, so each
//   one-shot `send` plays the file's calls in order. M3: a first line {"caps": {...}} gives the
//   connection those caps over SCRIPT_CAPS (tools 'native' or 'prompted' for a tool-round script).
// - record: every connection built from config.toml keeps working as configured, wrapped so each
//   model call is appended to <file> as one JSONL line (providers/record.ts), with the secrets the
//   runtime knows (keys, header values) scrubbed.
// - replay: like script, one override connection, playing the recording back. A request that
//   differs from the recorded one fails loudly (replay_mismatch, with a diff). The requests are
//   shaped by caps, so the replay connection takes the caps of the connection each call was
//   recorded on when config.toml still has it (the same config replays byte for byte); otherwise
//   SCRIPT_CAPS, and a replay_mismatch then says why the caps are generic (another model, or the
//   recorded connection missing from config.toml). A call stopped while recording replays its
//   events and then holds for Ctrl+C in an interactive chat; anywhere else it fails at once
//   ('replay_aborted').
// Files are read (script, replay) or opened for appending (record) before anything else runs, so a
// bad path fails before a session is touched.

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connection } from '../engine/api.ts';
import { createRecordingProvider, createReplayProvider, parseRecording, type RecordedCall } from '../providers/record.ts';
import { createScriptedProvider, parseScriptFile, SCRIPT_CAPS, scriptCapsWith } from '../providers/scripted.ts';
import type { ModelCaps } from '../providers/types.ts';
import { UsageError } from './args.ts';
import type { Runtime } from './runtime.ts';

/** A bad script or recording file: not a usage mistake, but the run cannot start (exit 1). */
export class ScriptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptFileError';
  }
}

export type ProviderScheme = 'script' | 'record' | 'replay';

export interface ProviderSpec {
  scheme: ProviderScheme;
  file: string;
}

const SCHEMES: readonly ProviderScheme[] = ['script', 'record', 'replay'];

/** `command` names the subcommand whose usage a mistake prints (send, new, chat, preview). */
export function parseProviderSpec(spec: string, command = 'send'): ProviderSpec {
  const at = spec.indexOf(':');
  const scheme = at > 0 ? spec.slice(0, at) : '';
  const file = at > 0 ? spec.slice(at + 1) : '';
  if (!(SCHEMES as readonly string[]).includes(scheme)) {
    throw new UsageError(`--provider must be script:<file>, record:<file> or replay:<file>, got ${JSON.stringify(spec)}`, command);
  }
  if (file === '') throw new UsageError(`--provider ${scheme}: needs a file, e.g. ${scheme}:calls.jsonl`, command);
  return { scheme: scheme as ProviderScheme, file };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function readFile(path: string, file: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new ScriptFileError(`cannot read ${what} ${file}: ${errText(e)}`);
  }
}

/**
 * Build the script override connection: id 'script', origin 'script:<absolute file>', local. Its caps
 * are SCRIPT_CAPS, with the file's leading `{"caps": {...}}` line merged over them when it has one
 * (M3: a script can give the connection tools, e.g. {"caps": {"tools": "prompted"}}).
 */
export function scriptConnection(spec: string, command = 'send'): Connection {
  const { scheme, file } = parseProviderSpec(spec, command);
  if (scheme !== 'script') throw new UsageError(`expected script:<file>, got ${JSON.stringify(spec)}`, command);
  const path = resolve(file);
  const text = readFile(path, file, 'script');
  let parsed: ReturnType<typeof parseScriptFile>;
  let caps;
  try {
    parsed = parseScriptFile(text);
    caps = scriptCapsWith(parsed.caps);
  } catch (e) {
    throw new ScriptFileError(`${file}: ${errText(e)}`);
  }
  return { id: 'script', provider: createScriptedProvider(parsed.calls), caps, origin: `script:${path}`, local: true };
}

/** A recording file, parsed (ScriptFileError naming the line on bad input). */
export function readRecording(file: string): RecordedCall[] {
  const text = readFile(resolve(file), file, 'recording');
  try {
    return parseRecording(text);
  } catch (e) {
    throw new ScriptFileError(`${file}: ${errText(e)}`);
  }
}

/**
 * The replay override connection: id 'replay', origin 'replay:<absolute file>'. `connections` (read
 * lazily, at the first turn) are config.toml's: a call recorded on one of them is replayed with that
 * connection's caps for its model, and `local` follows the first recorded call's connection.
 * `opts.holdAborted`: a call recorded as aborted holds for Ctrl+C (an interactive chat).
 */
export function replayConnection(
  file: string,
  calls: RecordedCall[],
  connections: () => Record<string, Connection> = () => ({}),
  opts: { holdAborted?: boolean } = {},
): Connection {
  const path = resolve(file);
  const recordedOn = (model?: string): Connection | undefined => {
    const known = connections();
    const call = calls.find((c) => (model === undefined || c.model.model === model) && c.model.connection !== undefined && Object.hasOwn(known, c.model.connection));
    return call ? known[call.model.connection!] : undefined;
  };
  const label = (c: RecordedCall): string => (c.model.connection !== undefined ? `${c.model.connection}:${c.model.model}` : c.model.model);
  /** Why `model` gets generic caps (SCRIPT_CAPS) instead of the recorded connection's, or undefined. */
  const fallbackNote = (model: string): string | undefined => {
    if (recordedOn(model)) return undefined;
    const same = calls.find((c) => c.model.model === model);
    if (!same) {
      const was = [...new Set(calls.map(label))].join(', ');
      return `note: the recording was made on ${was || 'no model'}; this session asks for ${model}, so the request was shaped with generic caps, not the recorded connection's (replay with the model you recorded with)`;
    }
    const conn = same.model.connection;
    return conn === undefined
      ? `note: the recording does not name the connection ${model} was recorded on, so the request was shaped with generic caps`
      : `note: the recording was made on ${conn}:${model}, and config.toml has no connection "${conn}", so the request was shaped with generic caps (replay with the config.toml you recorded with)`;
  };
  const capsOf = (conn: Connection, model: string): ModelCaps => {
    try {
      return conn.capsFor ? conn.capsFor(model) : conn.caps;
    } catch {
      return conn.caps;
    }
  };
  const provider = createReplayProvider(calls, {
    ...(opts.holdAborted ? { holdAborted: true } : {}),
    note: (req) => fallbackNote(req.model.model),
  });
  return {
    id: 'replay',
    provider,
    get caps(): ModelCaps {
      const first = calls[0];
      const conn = first ? recordedOn(first.model.model) : undefined;
      return conn && first ? capsOf(conn, first.model.model) : SCRIPT_CAPS;
    },
    origin: `replay:${path}`,
    get local(): boolean {
      return recordedOn()?.local ?? true;
    },
    capsFor(model: string): ModelCaps {
      const conn = recordedOn(model);
      return conn ? capsOf(conn, model) : SCRIPT_CAPS;
    },
  };
}

/**
 * Wrap every connection with the recorder: same id, caps, origin and key, every call appended to
 * `file` (one line each, synchronously). `secrets` lists what to scrub (the runtime's known keys and
 * header values; each call's own key is scrubbed anyway).
 */
export function recordingConnections(
  connections: Record<string, Connection>,
  file: string,
  secrets: () => readonly string[],
): Record<string, Connection> {
  const path = resolve(file);
  const sink = (line: string): void => appendFileSync(path, `${line}\n`);
  const out: Record<string, Connection> = {};
  for (const [id, conn] of Object.entries(connections)) {
    out[id] = { ...conn, provider: createRecordingProvider(conn.provider, sink, { connection: id, secrets }) };
  }
  return out;
}

/** A --provider flag, its file read or opened, ready to attach to the runtime. */
export interface PreparedProvider {
  spec: ProviderSpec;
  /** script / replay: rt.provider is the override; record: rt.connections are wrapped. */
  attach(rt: Runtime): void;
}

/**
 * Parse `--provider` and do the file work now: read the script, parse the recording, or create the
 * recording file (appending; nothing is truncated), so a bad path fails before a session is opened.
 */
export function prepareProvider(spec: string, command = 'send', opts: { interactive?: boolean } = {}): PreparedProvider {
  const parsed = parseProviderSpec(spec, command);
  switch (parsed.scheme) {
    case 'script': {
      const conn = scriptConnection(spec, command);
      return { spec: parsed, attach: (rt) => void (rt.provider = conn) };
    }
    case 'replay': {
      const calls = readRecording(parsed.file);
      return {
        spec: parsed,
        attach: (rt) => {
          rt.provider = replayConnection(parsed.file, calls, () => rt.connections, opts.interactive ? { holdAborted: true } : {});
        },
      };
    }
    case 'record': {
      try {
        appendFileSync(resolve(parsed.file), '');
      } catch (e) {
        throw new ScriptFileError(`cannot write the recording ${parsed.file}: ${errText(e)}`);
      }
      return {
        spec: parsed,
        attach: (rt) => {
          rt.connections = recordingConnections(rt.connections, parsed.file, () => rt.secrets.known());
          rt.recording = resolve(parsed.file);
        },
      };
    }
  }
}
