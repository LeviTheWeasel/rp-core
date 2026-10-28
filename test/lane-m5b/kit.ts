// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5b lane tests (not a test file itself): an engine whose recorder has its own
// scripted connection, sessions with the Compendium's lane settings, scripted filing and historian
// answers, and readers for the lane's rows and events.
import type { Connection, EngineHandle, EngineOptions, SessionHandle } from '../../src/engine/api.ts';
import type { DelayTimers } from '../../src/engine/abort.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider, type ScriptStep } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { CompendiumConfig, DeepPartial, JobEntry, MemEntry, SessionConfig } from '../../src/session/entries.ts';
import { entriesOf, LEVI, MIRA, rig, scriptConn } from '../engine/kit.ts';
import { collect } from '../engine-m5a/kit.ts';

export { calls, drain, entriesOf, LEVI, MIRA, textOf, until, writeRaw } from '../engine/kit.ts';
export { say, turnOf } from '../engine-m4/kit.ts';
export { collect, tick } from '../engine-m5a/kit.ts';

/** The recorder's binding in these tests (its own connection). */
export const REC = { conn: 'rec', model: 'r' } as const;

export interface LaneRig {
  home: string;
  engine: EngineHandle;
  /** The narrator's script ('script'). */
  narrator: ScriptedProvider;
  /** The recorder's script ('rec'). */
  recorder: ScriptedProvider;
  events: { seen: Event[]; done: Promise<void> };
}

export interface LaneRigOptions {
  narrator?: ScriptCall[];
  recorder?: ScriptCall[];
  lane?: 'auto' | 'manual';
  home?: string;
  timers?: DelayTimers;
  /** Extra connections (another origin, a shared one). */
  connections?: Record<string, Connection>;
  recorderCaps?: ModelCaps;
  extra?: Partial<EngineOptions>;
}

/** An engine with the narrator on 'script' and the recorder on 'rec' (each its own script and origin); lane 'manual' unless asked. */
export async function laneRig(opts: LaneRigOptions = {}): Promise<LaneRig> {
  const rec = scriptConn('rec', opts.recorder ?? [], opts.recorderCaps);
  const r = await rig(opts.narrator ?? [], {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    connections: { rec: rec.conn, ...(opts.connections ?? {}) },
    extra: { lane: opts.lane ?? 'manual', ...(opts.timers ? { timers: opts.timers } : {}), ...(opts.extra ?? {}) },
  });
  return { home: r.home, engine: r.engine, narrator: r.provider, recorder: rec.provider, events: collect(r.engine) };
}

/** A session (Mira, persona Levi) whose recorder is 'rec', with these Compendium settings. */
export function laneSession(engine: EngineHandle, compendium: DeepPartial<CompendiumConfig> = {}, more: DeepPartial<SessionConfig> = {}): SessionHandle {
  return engine.createSession({
    character: MIRA,
    persona: LEVI,
    config: { ...more, roles: { recorder: { ...REC }, ...(more.roles ?? {}) }, compendium: { enabled: true, ...compendium } },
  });
}

/** One narrator answer. */
export const answer = (text: string): ScriptStep[] => [{ text }];

/** One filing answer holding these items ({type, entry}). */
export const filed = (...items: unknown[]): ScriptStep[] => [{ text: JSON.stringify({ filings: items }) }];

/** A character item. */
export const char = (name: string, more: Record<string, unknown> = {}): { type: string; entry: Record<string, unknown> } => ({ type: 'character', entry: { name, ...more } });

/** One historian answer. */
export const chronicle = (summaries: { title: string; plot: string; summary: string }[], arcs: { plot: string; overview: string }[]): ScriptStep[] => [
  {
    text: JSON.stringify({
      filings: summaries.map((s) => ({ type: 'summary', entry: { title: s.title, parent_plot: s.plot, summary: s.summary } })),
      arcs,
    }),
  },
];

/** The session's job rows. */
export const jobRows = (home: string, id: string): JobEntry[] => entriesOf(home, id).filter((e): e is JobEntry => e.t === 'job');

/** The session's mem rows. */
export const memRows = (home: string, id: string): MemEntry[] => entriesOf(home, id).filter((e): e is MemEntry => e.t === 'mem');

/** job rows as [state, key, attempt] (code for a failure). */
export const jobs = (home: string, id: string): (string | number)[][] =>
  jobRows(home, id).map((j) => (j.code !== undefined ? [j.state, j.key, j.attempt, j.code] : [j.state, j.key, j.attempt]));

/** The lane's events (agent, memory, idle, notice) of the bus, minus the session id and time. */
export function laneEvents(seen: readonly Event[]): Record<string, unknown>[] {
  return seen.flatMap((e): Record<string, unknown>[] => {
    if (e.type !== 'agent' && e.type !== 'memory' && e.type !== 'idle' && e.type !== 'notice') return [];
    const { sessionId: _s, ts: _t, ...rest } = e;
    if (rest.type === 'agent' && 'job' in rest) return [{ ...rest, job: 'j' }];
    if (rest.type === 'notice') return [{ type: 'notice', code: rest.code }];
    return [rest];
  });
}

/** A scripted connection on a local origin (127.0.0.1: the scheduler's local rules and idle gate apply). */
export function localConn(id: string, script: ScriptCall[], caps: ModelCaps = SCRIPT_CAPS): { conn: Connection; provider: ScriptedProvider } {
  const provider = createScriptedProvider(script);
  return { conn: { id, provider, caps, origin: 'http://127.0.0.1:5005', local: true }, provider };
}

/** Sixteen ids (the tests' paths are shorter; destructured places past the end are undefined at runtime). */
type Ids = [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];

/** The ids of the path, by role and order: [greeting, U1, A1, U2, A2, …]. */
export const pathIds = (s: SessionHandle): Ids => s.view().path.map((m) => m.id) as Ids;

/** The text of the first user message of a request. */
export function userText(req: { messages: { role: string; blocks: { k: string; text?: string }[] }[] }): string {
  const m = req.messages.find((x) => x.role === 'user');
  return m ? m.blocks.map((b) => b.text ?? '').join('') : '';
}
