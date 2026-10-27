// The caps cache split (probe.ts CapsCacheRow, decisions G3): catalog facts and active-probe facts
// are stored apart, a legacy row ({caps}) reads as catalog, and config.ts feeds each part into its
// own resolveCaps slot, so caps.source says 'catalog' or 'probe'.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildConnections, parseConfig } from '../../src/config/config.ts';
import { createSecretResolver } from '../../src/config/secrets.ts';
import { capsCachePath, readCapsCache, writeCapsCache, type CapsCacheRow } from '../../src/providers/probe.ts';
import { tmpHome } from '../helpers.ts';

const CONFIG = '[connections.local]\nbase_url = "http://127.0.0.1:8080"\n';

function capsFor(cache: Record<string, CapsCacheRow>, model = 'qwen3-14b', config = CONFIG) {
  const { connections } = buildConnections(parseConfig(config, null), { env: {}, secrets: createSecretResolver({ env: {} }), capsCache: cache });
  return connections.local!.capsFor!(model);
}

describe('read and write', () => {
  test('a legacy row ({caps}) reads as catalog; the file is rewritten in the new shape', () => {
    const home = tmpHome();
    writeFileSync(capsCachePath(home), JSON.stringify({ 'local:qwen3-14b': { as_of: '2026-10-01', server: 'llama.cpp', caps: { contextLength: 16384 } } }));
    const read = readCapsCache(home);
    expect(read).toEqual({ 'local:qwen3-14b': { as_of: '2026-10-01', server: 'llama.cpp', catalog: { contextLength: 16384 } } });
    writeCapsCache(home, read);
    expect(JSON.parse(readFileSync(capsCachePath(home), 'utf8'))).toEqual({
      'local:qwen3-14b': { as_of: '2026-10-01', server: 'llama.cpp', catalog: { contextLength: 16384 } },
    });
  });

  test('catalog and probe parts round-trip; a row with only a probe part is kept', () => {
    const home = tmpHome();
    const cache: Record<string, CapsCacheRow> = {
      'local:a': { as_of: '2026-10-26', server: 'llama.cpp', catalog: { contextLength: 8192 }, probe: { tools: 'native', streamUsage: 'timings' } },
      'local:b': { as_of: '2026-10-26', probe: { structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' } } },
    };
    writeCapsCache(home, cache);
    expect(readCapsCache(home)).toEqual(cache);
    // A row that says nothing at all (no part) is dropped on read and on write.
    writeFileSync(capsCachePath(home), JSON.stringify({ x: { as_of: '2026-10-26', server: 'ollama' } }));
    expect(readCapsCache(home)).toEqual({});
  });

  test('a row with both a legacy caps and a catalog keeps the catalog', () => {
    const home = tmpHome();
    writeFileSync(capsCachePath(home), JSON.stringify({ k: { as_of: '2026-10-26', caps: { contextLength: 1 }, catalog: { contextLength: 2 } } }));
    expect(readCapsCache(home)).toEqual({ k: { as_of: '2026-10-26', catalog: { contextLength: 2 } } });
  });
});

describe('the caps chain: catalog slot vs probe slot (caps.source)', () => {
  test('catalog facts resolve as catalog, not probe', () => {
    const caps = capsFor({ 'local:qwen3-14b': { as_of: '2026-10-26', server: 'llama.cpp', catalog: { contextLength: 16384 } } });
    expect(caps.contextLength).toBe(16384);
    expect(caps.source).toEqual(['host', 'model', 'catalog']);
  });

  test('a legacy row is catalog too (it was written by the catalog half of M1b/M2)', () => {
    const caps = capsFor({ 'local:qwen3-14b': { as_of: '2026-10-26', server: 'llama.cpp', caps: { contextLength: 16384 } } });
    expect(caps.source).toContain('catalog');
    expect(caps.source).not.toContain('probe');
  });

  test('probe facts land after the catalog and before the user', () => {
    const cache: Record<string, CapsCacheRow> = {
      'local:qwen3-14b': {
        as_of: '2026-10-26',
        server: 'llama.cpp',
        catalog: { contextLength: 16384, tools: 'prompted' },
        probe: { tools: 'native', structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' } },
      },
    };
    const caps = capsFor(cache);
    expect(caps.source).toEqual(['host', 'model', 'catalog', 'probe']);
    expect(caps.tools).toBe('native');
    expect(caps.structuredOutput).toEqual({ mode: 'json_schema', confirmedBy: 'probe' });
    // The user wins over any probe.
    const user = capsFor(cache, 'qwen3-14b', `${CONFIG}[caps."local:qwen3-14b"]\ntools = "prompted"\n`);
    expect(user.tools).toBe('prompted');
    expect(user.source).toEqual(['host', 'model', 'catalog', 'probe', 'user']);
  });

  test('a probe never raises capacity or sets the window', () => {
    const caps = capsFor({ 'local:qwen3-14b': { as_of: '2026-10-26', probe: { maxInFlight: 8 } } });
    expect(caps.maxInFlight).toBe(1);
  });
});
