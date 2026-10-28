// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The agents pane's state (TUI decisions T-8), pure: no OpenTUI. A reducer over the turn events
// (the narrator's state and tool calls, the Director's statuses, retries, live usage, the M5 agents)
// and the facts stored at the head (the last answer's stats, the Director's record, usage totals),
// read from the journal on idle. Durations come from the events' `ts`, never from the wall clock.

import { ageOf, directorAt, isFinishedArc } from '../../agents/director/state.ts';
import { SURFACE_TURNS, type DirectorRecord } from '../../agents/director/types.ts';
import type { MemoryStatus } from '../../engine/api.ts';
import type { Event } from '../../protocol/events.ts';
import type { SessionConfig } from '../../session/entries.ts';
import { effectiveMessage } from '../../session/tree.ts';
import type { MessageView } from '../../session/view.ts';
import { toolArgsText, toolLine } from '../render.ts';
import { latestTrace, pathUsage, type Journal, type PriceTable, type UsageCounts } from '../repl-journal.ts';
import { taskOfKey } from '../repl-render.ts';
import { LAYOUT } from './types.ts';

export type NarratorPhase =
  | { kind: 'idle' }
  /** A turn started; nothing streamed yet (the Director may be planning). */
  | { kind: 'waiting' }
  | { kind: 'thinking'; chars: number }
  | { kind: 'writing' }
  | { kind: 'tool'; name: string }
  | { kind: 'retry'; code: string; attempt: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; code: string };

export interface ToolCall {
  turnId: string;
  callId: string;
  name: string;
  /** toolLine() once done; `⋯ name args` while it runs. */
  text: string;
  status: 'running' | 'ok' | 'failed' | 'cancelled';
  startedMs?: number;
  /** start → done, from the events' ts. */
  ms?: number;
}

/** The last answer's numbers (its gen, the trace's rounds as a fallback). */
export interface AnswerStats {
  messageId: string;
  tokens?: number;
  ms?: number;
  finish?: string;
  rounds?: number;
  transport?: string;
}

export type DirectorLive =
  | { kind: 'none' }
  | { kind: 'planning'; sinceMs: number }
  | { kind: 'planned' | 'reused'; summary?: string; ms?: number }
  | { kind: 'failed'; code: string; ms?: number }
  | { kind: 'skipped' }
  | { kind: 'retry'; code: string; attempt: number };

/** What the Director's record at the head says (directorAt). */
export interface DirectorFacts {
  turn: number;
  ok: boolean;
  code?: string;
  reusedFrom?: string;
  profile?: string;
  transport?: string;
  model?: string;
  attempts: { transport: string; outcome: string; ms: number; tokens?: number }[];
  chapter?: { number: number; title: string };
  liveArcs: number;
  /** Unpaid seeds at or past SURFACE_TURNS[horizon] (what /director show marks OVERDUE). */
  seedsDue: number;
}

/** One M5 agent (recall / filing / historian): its latest status. */
export interface AgentBlock {
  agent: string;
  status?: string;
  count?: number;
  code?: string;
  source?: string;
  reason?: string;
  startedMs?: number;
  /** The last finished job's duration (started → a final status). */
  ms?: number;
  /** The last memory change this agent made. */
  memory?: string;
  /** M5c: the block was set by the background lane (recall's prefetch); filing and the historian always are. */
  lane?: true;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls whose usage the provider did not report. */
  noUsage: number;
  /** USD; null when nothing could be priced. */
  costUsd: number | null;
  /** Calls with usage but neither a provider cost nor a price row. */
  unpriced: number;
}

/** The facts stored at the head, read on idle (storedFacts). */
export interface StoredFacts {
  directorEnabled: boolean;
  last: AnswerStats | null;
  director: DirectorFacts | null;
  usage: UsageTotals;
}

export interface AgentsState {
  /** The turn the live state belongs to. */
  turnId: string | null;
  narrator: { phase: NarratorPhase; tools: ToolCall[]; last: AnswerStats | null };
  director: { enabled: boolean; live: DirectorLive; facts: DirectorFacts | null };
  /** M5 agents in first-seen order. */
  others: AgentBlock[];
  /** stored: pathUsage at the last refresh; live: usage events since then. */
  usage: { stored: UsageTotals; live: UsageTotals };
}

export const zeroUsage = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, noUsage: 0, costUsd: null, unpriced: 0 });

export function initialAgents(): AgentsState {
  return {
    turnId: null,
    narrator: { phase: { kind: 'idle' }, tools: [], last: null },
    director: { enabled: false, live: { kind: 'none' }, facts: null },
    others: [],
    usage: { stored: zeroUsage(), live: zeroUsage() },
  };
}

/** stored + live. */
export function usageTotal(s: AgentsState): UsageTotals {
  const a = s.usage.stored;
  const b = s.usage.live;
  const cost = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    noUsage: a.noUsage + b.noUsage,
    costUsd: cost,
    unpriced: a.unpriced + b.unpriced,
  };
}

// ---- the reducer -------------------------------------------------------------------------------------

const msOf = (ev: Event, now: Date): number => {
  const t = Date.parse(ev.ts);
  return Number.isFinite(t) ? t : now.getTime();
};

/** The answer's stats from its gen (null for a greeting or a message without one). */
export function statsOf(id: string, gen: MessageView['gen'], trace?: { rounds?: { n: number; transport: string } }): AnswerStats | null {
  if (!gen || gen.kind !== 'model') return null;
  const s: AnswerStats = { messageId: id };
  if (typeof gen.usage?.outputTotal === 'number') s.tokens = gen.usage.outputTotal;
  if (typeof gen.ms === 'number') s.ms = gen.ms;
  if (gen.finish) s.finish = gen.finish;
  const rounds = gen.rounds ?? trace?.rounds?.n;
  if (typeof rounds === 'number') s.rounds = rounds;
  const transport = gen.transport ?? trace?.rounds?.transport;
  if (transport) s.transport = transport;
  return s;
}

/** Running tool calls of `turnId` become cancelled (the turn ended). */
const cancelRunning = (tools: ToolCall[], turnId: string): ToolCall[] =>
  tools.some((t) => t.turnId === turnId && t.status === 'running') ? tools.map((t) => (t.turnId === turnId && t.status === 'running' ? { ...t, status: 'cancelled' } : t)) : tools;

/**
 * The agent a callKey names: `${turnId}:narrator:0`, `${turnId}:director:1`; the lane's `${job}:filing:0`
 * and (M5c) a recall prefetch's `p_${head}:recall:0`.
 */
const agentOfKey = (callKey: string): string => callKey.split(':')[1] ?? 'narrator';

const isLaneAgent = (agent: string): boolean => agent === 'filing' || agent === 'historian';

/** M5c (D-202): a recall prefetch's call (`p_<head>:recall:N`, `…:recall:more:N`): the lane's, never a turn's. */
const isPrefetchKey = (callKey: string): boolean => callKey.startsWith('p_');

/** A block of the lane: filing's, the historian's, or recall's while the prefetch set it. */
const isLaneBlock = (b: AgentBlock): boolean => isLaneAgent(b.agent) || b.lane === true;

/**
 * M5b (D-181): an event of the session's background lane (filing, the historian; M5c: the recall
 * prefetch): its agent events (no turn), the memory changes its passes made, its calls' retries and
 * usage (ruling I: the usage block counts them), its idle{background} count. Never part of a turn's
 * stream: the host hands them to the pane from the engine's bus, a turn streaming or not. A prefetch's
 * usage is left out: it counts once a reply adopts it, through the answer's record (as /usage counts it).
 */
export function isLaneEvent(ev: Event): boolean {
  switch (ev.type) {
    case 'agent':
      return ev.turnId === undefined && (isLaneAgent(ev.agent) || ev.agent === 'recall');
    case 'memory':
      return isLaneAgent(ev.by);
    case 'retry':
      return isLaneAgent(agentOfKey(ev.callKey)) || isPrefetchKey(ev.callKey);
    case 'usage':
      return isLaneAgent(ev.agent);
    case 'idle':
      return true;
    default:
      return false;
  }
}

/** Lane block statuses that say a pass waits or runs: stale once the lane says nothing is left (idle{background: 0}). */
const LANE_BUSY: ReadonlySet<string> = new Set(['queued', 'started', 'retry']);

/**
 * The background lane as memoryStatus() says it now, into the blocks (a session the pane starts showing:
 * the lane's events at its open came before the pane): the running pass `started` (`queued` while it
 * waits for a place on the server), else a queued one `queued`, else a parked one `parked [code]`; M5c:
 * the recall prefetch `queued`, `started` or its end (`done (n)`, `failed [code]`). Those start at `now`.
 */
export function withLane(s: AgentsState, lane: MemoryStatus, now: Date): AgentsState {
  let others = s.others;
  const pre = lane.prefetch;
  if (pre !== undefined) {
    const rec = pre.record;
    const block: AgentBlock =
      pre.state !== 'ready'
        ? { agent: 'recall', status: pre.state === 'running' ? 'started' : 'queued', source: 'prefetch', startedMs: now.getTime(), lane: true }
        : rec?.status === 'failed' || rec?.status === 'skipped'
          ? { agent: 'recall', status: rec.status, ...(rec.code !== undefined ? { code: rec.code } : {}), source: 'prefetch', lane: true }
          : { agent: 'recall', status: 'done', count: rec?.picks.length ?? 0, source: 'prefetch', lane: true };
    others = upsertAgent(others, 'recall', () => block);
  }
  for (const [task, agent] of [
    ['file', 'filing'],
    ['hist', 'historian'],
  ] as const) {
    const running = lane.running?.task === task ? lane.running : undefined;
    const parked = lane.parked.find((p) => taskOfKey(p.key) === task);
    const block: AgentBlock | null = running
      ? { agent, status: running.waiting ? 'queued' : 'started', startedMs: now.getTime() }
      : lane.queued.some((q) => q.task === task)
        ? { agent, status: 'queued', startedMs: now.getTime() }
        : parked
          ? { agent, status: 'parked', ...(parked.code !== undefined ? { code: parked.code } : {}) }
          : null;
    if (block) others = upsertAgent(others, agent, () => block);
  }
  return others === s.others ? s : { ...s, others };
}

const FINAL_AGENT_STATUSES: ReadonlySet<string> = new Set(['preempted', 'adopted', 'recalled', 'reused', 'fallback', 'skipped', 'done', 'failed', 'parked']);

function upsertAgent(others: AgentBlock[], name: string, fn: (b: AgentBlock) => AgentBlock): AgentBlock[] {
  const i = others.findIndex((b) => b.agent === name);
  if (i < 0) return [...others, fn({ agent: name })];
  return others.map((b, j) => (j === i ? fn(b) : b));
}

function withPhase(s: AgentsState, phase: NarratorPhase): AgentsState {
  return { ...s, narrator: { ...s.narrator, phase } };
}

/**
 * One event into the state. Returns `s` itself when the event changes nothing (a text delta while
 * already writing), so a caller can skip a redraw. `now` only stands in for an unreadable `ts`.
 */
export function reduceAgents(s: AgentsState, ev: Event, now: Date): AgentsState {
  switch (ev.type) {
    case 'start': {
      const director = ev.kind === 'continue' && s.director.enabled ? { ...s.director, live: { kind: 'skipped' } as const } : s.director;
      return { ...s, turnId: ev.turnId, narrator: { ...s.narrator, phase: { kind: 'waiting' } }, director };
    }
    case 'text':
      return s.narrator.phase.kind === 'writing' ? s : withPhase(s, { kind: 'writing' });
    case 'reasoning':
      return withPhase(s, { kind: 'thinking', chars: ev.offset + ev.delta.length });
    case 'tool': {
      const at = msOf(ev, now);
      let tools = s.narrator.tools;
      if (ev.phase === 'start') {
        const args = toolArgsText(ev.args);
        const row: ToolCall = { turnId: ev.turnId, callId: ev.callId, name: ev.name, text: `⋯ ${ev.name}${args ? ` ${args}` : ''}`, status: 'running', startedMs: at };
        tools = [row, ...tools.filter((t) => !(t.turnId === ev.turnId && t.callId === ev.callId))].slice(0, LAYOUT.toolCalls);
      } else {
        const done = (t: ToolCall): ToolCall => ({
          ...t,
          name: ev.name,
          text: toolLine(ev) ?? t.text,
          status: ev.ok === false ? 'failed' : 'ok',
          ...(t.startedMs !== undefined ? { ms: Math.max(0, at - t.startedMs) } : {}),
        });
        const i = tools.findIndex((t) => t.turnId === ev.turnId && t.callId === ev.callId);
        tools =
          i >= 0
            ? tools.map((t, j) => (j === i ? done(t) : t))
            : [done({ turnId: ev.turnId, callId: ev.callId, name: ev.name, text: '', status: 'running' }), ...tools].slice(0, LAYOUT.toolCalls);
      }
      const running = tools.find((t) => t.turnId === ev.turnId && t.status === 'running');
      const phase: NarratorPhase = running ? { kind: 'tool', name: running.name } : { kind: 'waiting' };
      return { ...s, narrator: { ...s.narrator, tools, phase } };
    }
    case 'retry': {
      const agent = agentOfKey(ev.callKey);
      if (agent === 'narrator') return withPhase(s, { kind: 'retry', code: ev.code, attempt: ev.attempt });
      if (agent === 'director') return { ...s, director: { ...s.director, enabled: true, live: { kind: 'retry', code: ev.code, attempt: ev.attempt } } };
      return { ...s, others: upsertAgent(s.others, agent, (b) => ({ ...b, status: 'retry', code: ev.code })) };
    }
    case 'director': {
      const at = msOf(ev, now);
      const prev = s.director.live;
      const since = prev.kind === 'planning' ? prev.sinceMs : undefined;
      const ms = since !== undefined ? { ms: Math.max(0, at - since) } : {};
      let live: DirectorLive;
      switch (ev.status) {
        case 'planning':
          live = { kind: 'planning', sinceMs: at };
          break;
        case 'planned':
        case 'reused':
          live = { kind: ev.status, ...(ev.summary !== undefined && ev.summary.trim() !== '' ? { summary: ev.summary } : {}), ...ms };
          break;
        case 'failed':
          live = { kind: 'failed', code: ev.reason !== undefined && ev.reason.trim() !== '' ? ev.reason : 'unknown', ...ms };
          break;
        default:
          live = { kind: 'skipped' };
      }
      return { ...s, director: { ...s.director, enabled: true, live } };
    }
    case 'agent': {
      const at = msOf(ev, now);
      // M5b: the lane queues the next pass while one runs; the running one keeps its block (status, start).
      if (ev.status === 'queued' && s.others.some((b) => b.agent === ev.agent && b.status === 'started')) return s;
      // M5c: the recall prefetch (no turn) says `prefetch` whatever its status, and is the lane's block.
      const prefetch = ev.agent === 'recall' && ev.turnId === undefined;
      return {
        ...s,
        others: upsertAgent(s.others, ev.agent, (b) => {
          // A pass that starts is a new job: the last one's memory change is not its.
          const keep = b.memory !== undefined && ev.status !== 'started';
          const next: AgentBlock = { agent: b.agent, status: ev.status, ...(keep ? { memory: b.memory } : {}) };
          if (ev.count !== undefined) next.count = ev.count;
          if (ev.code !== undefined) next.code = ev.code;
          if (ev.source !== undefined) next.source = ev.source;
          else if (prefetch) next.source = 'prefetch';
          if (prefetch) next.lane = true;
          if (ev.reason !== undefined) next.reason = ev.reason;
          if (ev.status === 'queued' || ev.status === 'started') next.startedMs = b.status === 'queued' && b.startedMs !== undefined ? b.startedMs : at;
          else if (FINAL_AGENT_STATUSES.has(ev.status) && b.startedMs !== undefined) next.ms = Math.max(0, at - b.startedMs);
          return next;
        }),
      };
    }
    case 'memory':
      if (ev.by === 'user') return s;
      return { ...s, others: upsertAgent(s.others, ev.by, (b) => ({ ...b, memory: `${ev.change} ${ev.kind} "${ev.name}"` })) };
    case 'idle': {
      // Nothing queued or running in the lane: a block still saying so missed its pass's end (a pass
      // dropped from the queue by /memory off, a run cut short with nothing to tell).
      const busy = (b: AgentBlock): boolean => isLaneBlock(b) && b.status !== undefined && LANE_BUSY.has(b.status);
      if (ev.background !== 0 || !s.others.some(busy)) return s;
      const others = s.others.map((b) => (busy(b) ? { agent: b.agent, status: 'idle', ...(b.memory !== undefined ? { memory: b.memory } : {}), ...(b.lane ? { lane: true as const } : {}) } : b));
      return { ...s, others };
    }
    case 'usage': {
      const u = ev.usage;
      const live = { ...s.usage.live };
      live.calls++;
      live.inputTokens += u.inputTotal ?? 0;
      live.outputTokens += u.outputTotal ?? 0;
      const reported = u.inputTotal !== undefined || u.outputTotal !== undefined;
      if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd)) live.costUsd = (live.costUsd ?? 0) + ev.costUsd;
      else if (reported) live.unpriced++;
      if (!reported && typeof ev.costUsd !== 'number') live.noUsage++;
      return { ...s, usage: { ...s.usage, live } };
    }
    case 'done':
      return {
        ...s,
        narrator: { phase: { kind: 'idle' }, tools: cancelRunning(s.narrator.tools, ev.turnId), last: statsOf(ev.message.id, ev.message.gen) ?? s.narrator.last },
      };
    case 'stopped':
      return {
        ...s,
        narrator: {
          phase: { kind: 'stopped' },
          tools: cancelRunning(s.narrator.tools, ev.turnId),
          last: (ev.message ? statsOf(ev.message.id, ev.message.gen) : null) ?? s.narrator.last,
        },
      };
    case 'failed':
    case 'conflict':
      return {
        ...s,
        narrator: { ...s.narrator, phase: { kind: 'failed', code: ev.type === 'failed' ? ev.code : 'conflict' }, tools: cancelRunning(s.narrator.tools, ev.turnId) },
      };
    default:
      return s;
  }
}

// ---- the facts stored at the head --------------------------------------------------------------------

/** Root → `head` (hidden messages included, like PathView.path). */
export function pathIds(j: Journal, head: string | null): string[] {
  const out: string[] = [];
  for (let cur = head; cur !== null && out.length <= j.tree.msgs.size; ) {
    const m = j.tree.msgs.get(cur);
    if (!m) break;
    out.push(cur);
    cur = m.parent;
  }
  return out.reverse();
}

/** The Director's record at the head (what ModelsPaneApi.update's `extra.record` wants). */
export function recordAt(j: Journal, head: string | null): DirectorRecord | undefined {
  return directorAt(j.tree, head ?? j.tree.head).record;
}

export function directorFacts(r: DirectorRecord): DirectorFacts {
  const s = r.state;
  const chapter = s.currentChapterId === undefined ? undefined : s.chapters.find((c) => c.id === s.currentChapterId);
  const due = (h: string | undefined): number => (h !== undefined ? SURFACE_TURNS[h as keyof typeof SURFACE_TURNS] : undefined) ?? SURFACE_TURNS.medium;
  const f: DirectorFacts = {
    turn: r.turn,
    ok: r.ok,
    attempts: r.attempts.map((a) => ({ transport: a.transport, outcome: a.outcome, ms: a.ms, ...(a.tokens !== undefined ? { tokens: a.tokens } : {}) })),
    liveArcs: s.arcs.filter((a) => !isFinishedArc(a)).length,
    seedsDue: s.seeds.filter((x) => !x.payoffDelivered && ageOf(s.turn, x.plantedAtTurn) >= due(x.payoffHorizon)).length,
  };
  if (r.code !== undefined) f.code = r.code;
  if (r.reusedFrom !== undefined) f.reusedFrom = r.reusedFrom;
  if (r.profile !== undefined) f.profile = r.profile;
  if (r.transport !== undefined) f.transport = r.transport;
  if (r.model !== undefined) f.model = r.model;
  if (chapter) f.chapter = { number: chapter.number, title: chapter.title };
  return f;
}

function addCounts(t: UsageTotals, c: UsageCounts): void {
  t.calls += c.calls;
  t.inputTokens += c.inputTokens;
  t.outputTokens += c.outputTokens;
  t.noUsage += c.noUsage;
  if (c.costUsd !== null) t.costUsd = (t.costUsd ?? 0) + c.costUsd;
  t.unpriced += c.unpriced;
}

/** The facts at `head` (null: the journal's own head): last answer, the Director's record, usage over the path. */
export function storedFacts(j: Journal, head: string | null, config: SessionConfig, prices: PriceTable): StoredFacts {
  const h = head ?? j.tree.head;
  const ids = pathIds(j, h);
  let last: AnswerStats | null = null;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    if (j.tree.msgs.get(id)?.role !== 'assistant') continue;
    last = statsOf(id, effectiveMessage(j.tree, id).gen, latestTrace(j, id)?.trace);
    break;
  }
  const u = pathUsage(j, ids, prices);
  const usage = zeroUsage();
  addCounts(usage, u);
  for (const a of Object.values(u.agents ?? {})) addCounts(usage, a);
  const record = directorAt(j.tree, h).record;
  return { directorEnabled: config.director.enabled, last, director: record ? directorFacts(record) : null, usage };
}

/** The stored facts into the state: they replace the last answer, the Director's record and the usage (live usage restarts at 0). */
export function withStored(s: AgentsState, f: StoredFacts): AgentsState {
  return {
    ...s,
    narrator: { ...s.narrator, last: f.last },
    director: { enabled: f.directorEnabled, live: f.directorEnabled ? s.director.live : { kind: 'none' }, facts: f.director },
    usage: { stored: f.usage, live: zeroUsage() },
  };
}
