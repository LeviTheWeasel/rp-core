// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildConnections, configPath, parseConfig } from '../../config/config.ts';
import { isHeaderSafeKey } from '../../config/secrets.ts';
import { readCapsCache } from '../../providers/probe.ts';
import type { EngineHandle } from '../../engine/api.ts';
import type { Runtime } from '../runtime.ts';

const BLOCK = '[connections.openrouter]\nbase_url = "https://openrouter.ai/api"\nkey_env = "OPENROUTER_API_KEY"\n';

/** Keep only the non-secret connection in config.toml; the key lives in this process's resolver. */
export function connectOpenRouter(rt: Runtime, engine: EngineHandle, key: string): void {
  if (rt.recording) throw new Error('OpenRouter setup is unavailable while recording calls');
  if (!rt.secrets.provide) throw new Error('This runtime cannot accept a key from the TUI');
  if (!isHeaderSafeKey(key)) throw new Error('Invalid API key: remove spaces or invisible characters');
  const existing = rt.config.connections.openrouter;
  if (existing && new URL(existing.baseUrl).hostname !== 'openrouter.ai') {
    throw new Error('Connection "openrouter" points to another host in config.toml');
  }
  const file = configPath(rt.home);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const text = existing ? before : `${before}${before && !before.endsWith('\n') ? '\n' : ''}\n${BLOCK}`;
  const next = existing ? rt.config : parseConfig(text, file);
  const spec = { conn: 'openrouter', ...(next.connections.openrouter!.keyEnv ? { keyEnv: next.connections.openrouter!.keyEnv } : {}), ...(next.connections.openrouter!.keyCmd ? { keyCmd: next.connections.openrouter!.keyCmd } : {}) };
  rt.secrets.provide(spec, key);
  const connection = buildConnections(next, { env: rt.env, secrets: rt.secrets, capsCache: readCapsCache(rt.home) }).connections.openrouter;
  if (!connection) throw new Error('OpenRouter connection could not be created');
  if (!existing) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.config.toml-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, text, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600, flag: 'wx' });
      const fd = openSync(temp, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    Object.assign(rt.config, next);
  }
  rt.connections.openrouter = connection;
  engine.addConnection(connection);
}
