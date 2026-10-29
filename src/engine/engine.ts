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
// M5c (.notes/m5c-decisions.md D-207): the scheduler takes each origin's locality from the engine's
// connections (sched.ts connectionLocality), and RP_CORE_RECALL, read once here like RP_CORE_LANE,
// can replace the recall mode default (EngineCtx.recallDefault). The lead's ruling K: so does a scripted
// providerOverride whose script tags no line for recall (scriptRecallDefault): lexical.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connection, CreateSessionInput, EngineHandle, EngineOptions, SessionHandle } from './api.ts';
import { Refusal } from './api.ts';
import { realTimers } from './abort.ts';
import { EventBus } from './bus.ts';
import { checkpointCadence } from './checkpoint.ts';
import type { EngineCtx } from './context.ts';
import type { ToolSets } from './request.ts';
import { connectionLocality, createScheduler } from './sched.ts';
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

/** D-207: a recall mode RP_CORE_RECALL may put in place of the default ('auto'). */
export type RecallOverride = 'lexical' | 'off';

/**
 * Seams outside the library contract (EngineOptions), for tests: hosts never set them.
 * `counter` pins how prompts are counted (default defaultCounter(), o200k from M2); a test that
 * pins chars/3 numbers passes CHARS_COUNTER. `toolSets` (M3) replaces the built-in narrator tools the
 * request builder offers (request.ts ToolSets): the rules for when a set is offered stay the same.
 * `recall` (M5c, D-207) decides the recall mode default instead of RP_CORE_RECALL: 'lexical' or
 * 'off' replace it, 'config' keeps the config's own (an M5c test opting in under test/preload.ts).
 */
export interface EngineSeams {
  counter?: TokenCounter;
  toolSets?: ToolSets;
  recall?: RecallOverride | 'config';
}

/**
 * D-207: the part of EngineCtx (context.ts) that carries `recallDefault`, the recall mode a session
 * gets when its config sets none ('lexical' or 'off'); absent, 'auto'. A mode the session's config or
 * `/memory mode` sets wins. Kept as a name for callers of wave 1; EngineCtx has the field itself.
 */
export type RecallDefaultCtx = Pick<EngineCtx, 'recallDefault'>;

/** M5b (the lead's ruling G): EngineOptions.lane's default, read once per engine: RP_CORE_LANE=manual, else auto. */
const laneFromEnv = (): 'auto' | 'manual' => (process.env.RP_CORE_LANE === 'manual' ? 'manual' : 'auto');

/** D-207: the recall mode default's override, read once per engine: RP_CORE_RECALL=lexical|off, else none. */
const recallFromEnv = (): RecallOverride | undefined => {
  const v = process.env.RP_CORE_RECALL;
  return v === 'lexical' || v === 'off' ? v : undefined;
};

/**
 * The lead's ruling K (sched#4): the recall default a providerOverride asks for — 'lexical' when it plays a
 * script that tags no line `"agent": "recall"` (scripted.ts `recallTagged: false`). Such a script was not
 * written for recall (the M5a and M5b demo scripts): a recall call would take the next untagged line, the
 * narrator's answer. undefined for anything else (a script with a recall line, a replay, a real connection).
 */
export function scriptRecallDefault(override: Pick<Connection, 'provider'> | undefined): RecallOverride | undefined {
  const tagged = (override?.provider as { recallTagged?: unknown } | undefined)?.recallTagged;
  return tagged === false ? 'lexical' : undefined;
}

/** D-207: EngineSeams.recall ('config': nothing replaces the default), else RP_CORE_RECALL, else the override's script (ruling K). */
function recallDefaultOf(seam: EngineSeams['recall'], override: Connection | undefined): RecallOverride | undefined {
  if (seam === 'config') return undefined;
  return seam ?? recallFromEnv() ?? scriptRecallDefault(override);
}

export class Engine {
  static async open(opts: EngineOptions & EngineSeams): Promise<EngineHandle> {
    if (!opts || typeof opts.home !== 'string' || opts.home === '') throw new Error('Engine.open needs a home directory');
    const home = resolve(opts.home);
    mkdirSync(sessionsDir(home), { recursive: true });
    const connections = { ...(opts.connections ?? {}) };
    const override = opts.providerOverride;
    const recallDefault = recallDefaultOf(opts.recall, override);
    const ctx: EngineCtx = {
      home,
      clock: opts.clock ?? systemClock,
      random: opts.random ?? systemRandom,
      timeZone: opts.timeZone ?? systemTimeZone(),
      fetch: opts.fetch ?? globalThis.fetch,
      // M5b (the lead's ruling G): the idle gate waits on the engine's timers (tests' fake ones too).
      // D-207: an origin is local when a connection on it says so (read when the origin is first used).
      sched: createScheduler({
        timers: opts.timers ?? realTimers,
        isLocal: connectionLocality(() => (override ? [...Object.values(connections), override] : Object.values(connections))),
      }),
      checkpoint: checkpointCadence(opts.checkpoint),
      timers: opts.timers ?? realTimers,
      bus: new EventBus<Event>(),
      connections,
      counter: opts.counter ?? defaultCounter(),
      ...(opts.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: opts.retryMaxDelayMs } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
      ...(opts.prices ? { prices: { ...opts.prices } } : {}),
      ...(opts.onProviderError ? { onProviderError: opts.onProviderError } : {}),
      ...(opts.keepRequests === true ? { keepRequests: true } : {}),
      lane: opts.lane ?? laneFromEnv(),
      ...(opts.toolSets ? { toolSets: opts.toolSets } : {}),
      ...(recallDefault !== undefined ? { recallDefault } : {}),
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

  addConnection(connection: Connection): void {
    this.assertOpen();
    this.ctx.connections[connection.id] = connection;
  }

  session(id: string): SessionHandle {
    this.assertOpen();
    // Already open here: the lock file would say the same, without touching the disk.
    if (this.open.has(id)) throw new Refusal('session_locked', `session ${id} is already open in this engine`);
    const s = SessionImpl.open(this.ctx, id, this.forget);
    this.open.set(s.id, s);
    return s;
  }

  async nameSession(id: string, title: string, leaf?: string): Promise<void> {
    this.assertOpen();
    const active = this.open.get(id);
    if (active) { active.name(title, leaf); return; }
    const session = this.session(id);
    try { session.name(title, leaf); }
    finally { await session.close(); }
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
