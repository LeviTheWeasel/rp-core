// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c (.notes/m5c-decisions.md D-206, D-207): what the chat tells the REPL about a binding's connection
// for /memory profile and /memory mode (runtime.ts routeOf, ReplDeps.routeOf): its window as the engine
// computes it before the preset (the caps' context length, else the local or remote default) and whether
// the scheduler takes its origin for a local server — a configured connection's `local`, a script's own
// `"local"` line, else the URL's guess; the --provider override serves every binding.
import { describe, expect, test } from 'bun:test';
import type { Connection } from '../../src/engine/api.ts';
import { routeOf } from '../../src/cli/runtime.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';

const http = (id: string, baseUrl: string, local: boolean, contextLength?: number): Connection => ({
  id,
  provider: createScriptedProvider([]),
  // No context length stated: the engine's local or remote default.
  caps: { ...SCRIPT_CAPS, contextLength } as Connection['caps'],
  origin: baseUrl,
  local,
  baseUrl,
});

describe('routeOf', () => {
  test("a configured connection: the caps' window, else the local or remote default; its own local flag", () => {
    const connections = {
      box: http('box', 'http://127.0.0.1:11434', true, 16384),
      tunnel: http('tunnel', 'https://box.example', true),
      cloud: http('cloud', 'https://api.example', false),
    };
    expect(routeOf({ connections }, 'box', 'm')).toEqual({ window: 16384, local: true });
    expect(routeOf({ connections }, 'tunnel', 'm')).toEqual({ window: 8192, local: true });
    expect(routeOf({ connections }, 'cloud', 'm')).toEqual({ window: 32768, local: false });
    expect(routeOf({ connections }, 'ghost', 'm')).toBeNull();
  });

  test("the --provider override serves every binding: a script is local only when its file says so", () => {
    const script = (local?: boolean): Connection => ({
      id: 'script',
      provider: createScriptedProvider([], local !== undefined ? { localOrigin: local } : undefined),
      caps: { ...SCRIPT_CAPS, contextLength: 4096 },
      origin: 'script:/x/chat.jsonl',
      local: true,
    });
    expect(routeOf({ connections: {}, provider: script() }, 'anything', 'm')).toEqual({ window: 4096, local: false });
    expect(routeOf({ connections: {}, provider: script(true) }, 'anything', 'm')).toEqual({ window: 4096, local: true });
  });
});
