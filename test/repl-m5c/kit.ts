// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5c REPL tests (not a test file itself): the REPL rig over a session that reads
// the lantern book (typed entries, test/recall-engine-m5c's HARBOR_BOOK) with the Compendium on and
// filing and the historian off, an engine that keeps the session's recall mode (seam 'config', so the
// preload's RP_CORE_RECALL=lexical does not apply, and the REPL is told so: recallDefault), scripted lines
// tagged by agent, and a routeOf that says the script's window and whether its origin is local, and the
// lane's mode (what chat.ts gives the REPL).
import type { ScriptCall } from '../../src/providers/scripted.ts';
import type { CompendiumConfig, DeepPartial, SessionConfig } from '../../src/session/entries.ts';
import { tmpHome } from '../helpers.ts';
import { putBook } from '../engine-m5a/kit.ts';
import { HARBOR_BOOK } from '../recall-engine-m5c/kit.ts';
import { replRig, type ReplRig, type ReplRigOptions } from '../repl/kit.ts';

export { line, narr, picks, pausedPicks } from '../recall-engine-m5c/kit.ts';
export { blocks, said } from '../repl-m5b/kit.ts';
export type { ReplRig } from '../repl/kit.ts';

export type RecallCfg = NonNullable<CompendiumConfig['recall']>;

export interface RecallReplOptions {
  /** compendium.recall of the new session. */
  recall?: RecallCfg;
  /** More of compendium (idleDelaySec, profile, …). */
  compendium?: DeepPartial<CompendiumConfig>;
  /** More session config (roles, …). */
  config?: DeepPartial<SessionConfig>;
  /** The lane's mode (default manual, as the preload). */
  lane?: 'auto' | 'manual';
  /** The script's origin is local to the scheduler (default remote). */
  local?: boolean;
  /** routeOf's window per connection (default 8192, SCRIPT_CAPS'). */
  windows?: Record<string, number>;
  /** What the REPL is told of the engine's recall default (default 'auto': the engine keeps the session's mode). */
  recallDefault?: 'auto' | 'lexical' | 'off';
  /** More rig options. */
  rig?: ReplRigOptions;
}

/** A REPL on a new session reading the lantern book, recall as given; the engine keeps the session's recall mode. */
export async function recallRepl(script: ScriptCall[], o: RecallReplOptions = {}): Promise<ReplRig> {
  const home = tmpHome('rp-core-repl-m5c-');
  const book = putBook(home, HARBOR_BOOK);
  const local = o.local ?? false;
  return replRig(script, {
    home,
    engine: { lane: o.lane ?? 'manual', recall: 'config' },
    ...(o.local !== undefined ? { local: o.local } : {}),
    env: {},
    config: {
      lorebooks: [book],
      ...(o.config ?? {}),
      compendium: { enabled: true, filing: { enabled: false }, historian: { interval: 0 }, ...(o.compendium ?? {}), recall: o.recall ?? {} },
    },
    ...o.rig,
    deps: {
      routeOf: (conn) => (conn === 'script' || conn === 'alt' ? { window: o.windows?.[conn] ?? 8192, local } : null),
      lane: o.lane ?? 'manual',
      recallDefault: o.recallDefault ?? 'auto',
      ...o.rig?.deps,
    },
  });
}
