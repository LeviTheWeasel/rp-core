// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// What every session of one Engine shares (ARCHITECTURE.md §3: "Engine (экземпляр; никаких
// глобалов модуля)"). Built once by Engine.open and handed down; nothing here is module state.

import type { Connection, EngineOptions } from './api.ts';
import type { DelayTimers } from './abort.ts';
import type { EventBus } from './bus.ts';
import type { CheckpointCadence } from './checkpoint.ts';
import type { HostHooks } from './hooks.ts';
import type { CallTimeouts } from './narrate.ts';
import type { Scheduler } from './sched.ts';
import type { TokenCounter } from '../prompt/tokens.ts';
import type { Event } from '../protocol/events.ts';
import type { RandomBytes } from '../session/ids.ts';

export interface EngineCtx {
  home: string;
  clock: () => Date;
  random: RandomBytes;
  timeZone: string;
  fetch: typeof fetch;
  sched: Scheduler;
  checkpoint: CheckpointCadence;
  retryMaxDelayMs?: number;
  /** EngineOptions.timeouts: override of the §8.8 call timeouts. */
  timeouts?: Partial<CallTimeouts>;
  timers: DelayTimers;
  bus: EventBus<Event>;
  connections: Record<string, Connection>;
  providerOverride?: Connection;
  /** EngineOptions.prices: [prices."conn:model"], the second source of a call's cost (§11). */
  prices?: EngineOptions['prices'];
  /** M9. Always undefined in M1a. */
  hooks?: HostHooks;
  /** EngineOptions.onProviderError: the host's debug tap for raw provider failures (§13). */
  onProviderError?: EngineOptions['onProviderError'];
  /**
   * M2: how every prompt of this engine is counted (assemble's budgets, trace.tokens, the EMA's
   * samples, D-50). defaultCounter() unless a test pins another (engine.ts EngineSeams).
   */
  counter: TokenCounter;
}

/** ISO timestamp from the injected clock. */
export const isoNow = (ctx: Pick<EngineCtx, 'clock'>): string => ctx.clock().toISOString();
