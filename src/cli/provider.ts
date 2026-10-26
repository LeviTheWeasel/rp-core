// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `--provider script:<file>` (ARCHITECTURE.md §12.3, D-40; Kintsu K4): a scripted connection that
// replaces every role's connection for this process (EngineOptions.providerOverride). The script
// is read from the start on every run, so each one-shot `send` plays the file's calls in order.
// record:/replay: arrive in M2.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connection } from '../engine/api.ts';
import { createScriptedProvider, parseScript, SCRIPT_CAPS } from '../providers/scripted.ts';
import { UsageError } from './args.ts';

/** A bad script file: not a usage mistake, but the run cannot start (exit 1). */
export class ScriptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptFileError';
  }
}

export function parseProviderSpec(spec: string): { scheme: 'script'; file: string } {
  const at = spec.indexOf(':');
  const scheme = at > 0 ? spec.slice(0, at) : '';
  const file = at > 0 ? spec.slice(at + 1) : '';
  if (scheme === 'record' || scheme === 'replay') {
    throw new UsageError(`--provider ${scheme}:<file> arrives in M2; M1a has script:<file>`, 'send');
  }
  if (scheme !== 'script' || file === '') throw new UsageError(`--provider must be script:<file>, got ${JSON.stringify(spec)}`, 'send');
  return { scheme, file };
}

/** Build the override connection: id 'script', origin 'script:<absolute file>', local, SCRIPT_CAPS. */
export function scriptConnection(spec: string): Connection {
  const { file } = parseProviderSpec(spec);
  const path = resolve(file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ScriptFileError(`cannot read script ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let calls;
  try {
    calls = parseScript(text);
  } catch (e) {
    throw new ScriptFileError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { id: 'script', provider: createScriptedProvider(calls), caps: SCRIPT_CAPS, origin: `script:${path}`, local: true };
}
