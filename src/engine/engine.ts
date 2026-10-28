// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The Engine (ARCHITECTURE.md §3, §6, §12.1): open sessions, one turn per session, the turn state
// machine (turn.ts), recovery (recover.ts), narrator loop (narrate.ts), empty host-hook points.
// CONTRACT FILE: the entry point is fixed; the engine agent implements it.
//
// Everything lives on the instance: the session registry, the per-origin scheduler, the event bus.
// Two Engines in one process share nothing but the files (and the session locks guard those).
// M5b: each open session runs its background lane (lane.ts) on this scheduler; closing the engine
// closes every session, which aborts its lane first.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CreateSessionInput, EngineHandle, EngineOptions, SessionHandle } from './api.ts';
import { Refusal } from './api.ts';
import { realTimers } from './abort.ts';
import { EventBus } from './bus.ts';
import { checkpointCadence } from './checkpoint.ts';
import type { EngineCtx } from './context.ts';
import type { ToolSets } from './request.ts';
import { createScheduler } from './sched.ts';
import { SessionImpl } from './session.ts';
import { systemClock, systemRandom, systemTimeZone } from './system.ts';
import { defaultCounter, type TokenCounter } from '../prompt/tokens.ts';
import type { Event } from '../protocol/events.ts';
import { listSessions, sessionsDir } from '../session/log.ts';

/**
 * The tuning knobs of EngineOptions (call timeouts, timers). They began outside the contract and
 * were folded into EngineOptions at integration; the name stays for callers that spell it.
 */
export type EngineTuning = Pick<EngineOptions, 'timeouts' | 'timers'>;

/**
 * Seams outside the library contract (EngineOptions), for tests: hosts never set them.
 * `counter` pins how prompts are counted (default defaultCounter(), o200k from M2); a test that
 * pins chars/3 numbers passes CHARS_COUNTER. `toolSets` (M3) replaces the built-in narrator tools the
 * request builder offers (request.ts ToolSets): the rules for when a set is offered stay the same.
 */
export interface EngineSeams {
  counter?: TokenCounter;
  toolSets?: ToolSets;
}

/** M5b (the lead's ruling G): EngineOptions.lane's default, read once per engine: RP_CORE_LANE=manual, else auto. */
const laneFromEnv = (): 'auto' | 'manual' => (process.env.RP_CORE_LANE === 'manual' ? 'manual' : 'auto');

export class Engine {
  static async open(opts: EngineOptions & EngineSeams): Promise<EngineHandle> {
    if (!opts || typeof opts.home !== 'string' || opts.home === '') throw new Error('Engine.open needs a home directory');
    const home = resolve(opts.home);
    mkdirSync(sessionsDir(home), { recursive: true });
    const ctx: EngineCtx = {
      home,
      clock: opts.clock ?? systemClock,
      random: opts.random ?? systemRandom,
      timeZone: opts.timeZone ?? systemTimeZone(),
      fetch: opts.fetch ?? globalThis.fetch,
      // M5b (the lead's ruling G): the idle gate waits on the engine's timers (tests' fake ones too).
      sched: createScheduler({ timers: opts.timers ?? realTimers }),
      checkpoint: checkpointCadence(opts.checkpoint),
      timers: opts.timers ?? realTimers,
      bus: new EventBus<Event>(),
      connections: { ...(opts.connections ?? {}) },
      counter: opts.counter ?? defaultCounter(),
      ...(opts.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: opts.retryMaxDelayMs } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
      ...(opts.prices ? { prices: { ...opts.prices } } : {}),
      ...(opts.onProviderError ? { onProviderError: opts.onProviderError } : {}),
      ...(opts.keepRequests === true ? { keepRequests: true } : {}),
      lane: opts.lane ?? laneFromEnv(),
      ...(opts.toolSets ? { toolSets: opts.toolSets } : {}),
    };
    return new EngineImpl(ctx);
  }
}

class EngineImpl implements EngineHandle {
  private readonly open = new Map<string, SessionImpl>();
  private closing: Promise<void> | null = null;

  constructor(private readonly ctx: EngineCtx) {}

  private readonly forget = (s: SessionImpl): void => {
    if (this.open.get(s.id) === s) this.open.delete(s.id);
  };

  private assertOpen(): void {
    if (this.closing) throw new Error('the engine is closed');
  }

  createSession(input: CreateSessionInput): SessionHandle {
    this.assertOpen();
    const s = SessionImpl.create(this.ctx, input, this.forget);
    this.open.set(s.id, s);
    return s;
  }

  session(id: string): SessionHandle {
    this.assertOpen();
    // Already open here: the lock file would say the same, without touching the disk.
    if (this.open.has(id)) throw new Refusal('session_locked', `session ${id} is already open in this engine`);
    const s = SessionImpl.open(this.ctx, id, this.forget);
    this.open.set(s.id, s);
    return s;
  }

  listSessions(): { id: string; title?: string; updated: string }[] {
    return listSessions(this.ctx.home);
  }

  events(): AsyncIterable<Event> {
    return this.ctx.bus.subscribe();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      // Shutdown order: stop every turn (partial text kept), let each settle, release the locks,
      // then end the event tails.
      await Promise.all([...this.open.values()].map((s) => s.close()));
      this.ctx.bus.close();
    })();
    return this.closing;
  }
}
