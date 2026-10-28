// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Recall in the engine (ARCHITECTURE.md §7.4.2, §7.4.7; .notes/m5c-decisions.md D-201…D-204, D-207 and
// the lead's rulings G): what the turn (turn.ts) and the session's lane (lane.ts, the prerecall task)
// share. The pure parts — the index, the request, the reading, the record — are
// agents/compendium/recall.ts; this file puts them on a route and a scheduler.
// - recallModeOf: the session's mode (its config's, else the engine's RP_CORE_RECALL default, else
//   'auto'; ruling G: the override replaces only the default).
// - recallSetup: the recall route (D-85: recall → recorder → narrator, admit.ts resolveRecall), its
//   window and profile (§7.4.6: the recall binding's own window), its locality (the scheduler's, D-207),
//   the run's numbers, its reasoning, and the fingerprint a prefetch's basis carries.
// - prefetchBasis (D-202, amended): (head id, touches, recall model, profile, a hash of the settings), and
//   the newest touch (edit, hide) of a path message up to the head, so an edit after the prefetch is a
//   miss too (§7.4.2 "no edit, hide or head after it").
// - basisHead (ruling K): the answer a turn's prefetch basis is computed after — the newest assistant
//   message at or before U's parent, a player's messages stacked under it skipped.
// - runRecall: one recall run — the index over the fold the request reads (fresh copies at U's window,
//   the predicted {{recap}} slot left out), the request, structuredCall (rawRead, the deadline from the
//   grant, D-204), the top-up within what is left of the deadline (full only, and only after a first
//   structuredCall of one model call: at most two calls, ruling K), the RecallRecord (its `ms` from the
//   first grant: recall's own time, not its wait for the Director's place).
//   No index → `skipped` (empty_index), no room → `skipped` (no_room, ruling G), nothing is called.
// - the record's trace row, its event, and the notices recall tells (recall_slow, prefetch_missed,
//   recall_index_truncated, D-204).

import { createHash } from 'node:crypto';
import { visibilityAt } from '../agents/compendium/fresh.ts';
import { messageText } from '../agents/compendium/mention.ts';
import { compendiumProfile, resolveCompendium, type ResolvedCompendiumConfig } from '../agents/compendium/profile.ts';
import {
  checkRecallRecord,
  needsTopUp,
  recallDeadlineMs,
  recallIndex,
  recallReader,
  recallRecord,
  recallRequest,
  recallSettings,
  skippedRecord,
  topUpUser,
  type RecallMessage,
  type RecallRead,
} from '../agents/compendium/recall.ts';
import type { CompendiumProfile } from '../agents/compendium/types.ts';
import { AGENT_OUTPUT_FLOOR, chooseTransport, structuredCall, type AgentCallEnv, type StructuredResult, type TraceCall } from '../agents/structured.ts';
import type { Samplers } from '../formats/native.ts';
import { contextWindow, DEFAULT_LOCAL_WINDOW } from '../prompt/budget.ts';
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS, type TokenCounter } from '../prompt/tokens.ts';
import type { EventBody, Notice } from '../protocol/events.ts';
import { sendsReasoningOff } from '../providers/openai-chat.ts';
import type { ModelCaps, ModelRequest } from '../providers/types.ts';
import type { Binding, RecallRecord, SessionConfig, Trace } from '../session/entries.ts';
import type { TreeIndex } from '../session/tree.ts';
import type { PathView } from '../session/view.ts';
import { resolveRecall, type Route } from './admit.ts';
import type { EngineCtx } from './context.ts';
import { previousRecap } from './request.ts';
import { modelLabel } from './route.ts';
import type { OriginSemaphore, Scheduler } from './sched.ts';

export type RecallMode = 'auto' | 'sync' | 'prefetch' | 'lexical' | 'off';

const MODES: ReadonlySet<string> = new Set(['auto', 'sync', 'prefetch', 'lexical', 'off']);

/** D-204: a sync recall slower than this (ms, its own time from its first grant, ruling K) counts toward recall_slow. */
export const RECALL_SLOW_MS = 8000;
/** D-204: recall_slow is told (once per session) when this many sync recalls were slow. */
export const RECALL_SLOW_AFTER = 3;
/** The session-level tally key of slow sync recalls (TurnHost.tally). */
export const RECALL_SLOW = 'recall_slow';
export const PREFETCH_MISSED = 'prefetch_missed';
export const RECALL_INDEX_TRUNCATED = 'recall_index_truncated';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * D-207 and ruling G: the session's recall mode — its config's `compendium.recall.mode` when that is a
 * mode, else the engine's default (RP_CORE_RECALL / EngineSeams.recall: 'lexical' or 'off'), else 'auto'.
 */
export function recallModeOf(config: SessionConfig, recallDefault: EngineCtx['recallDefault']): RecallMode {
  const c: unknown = config.compendium;
  const recall = isObj(c) ? c.recall : undefined;
  const raw = isObj(recall) ? recall.mode : undefined;
  return typeof raw === 'string' && MODES.has(raw) ? (raw as RecallMode) : (recallDefault ?? 'auto');
}

/** A semaphore capacity as streamCall asks for it (narrate.ts capacityOf). */
export function capacityOf(caps: ModelCaps): number {
  const n = Math.floor(caps.maxInFlight);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** D-101 as the Director's and the lane's: the binding's reasoning; else off when the model can turn it off; else 'low' when it takes an effort. */
function reasoningFor(binding: Binding, caps: ModelCaps): ModelRequest['reasoning'] | undefined {
  if (binding.reasoning !== undefined) return binding.reasoning;
  if (caps.reasoning.canDisable) return 'none';
  if (caps.reasoning.control === 'effort' && (caps.reasoning.efforts === undefined || caps.reasoning.efforts.includes('low'))) return 'low';
  return undefined;
}

/** The binding's samplers only (max_tokens goes to maxTokens), recall's temperature unless the binding sets one. */
function samplersFor(binding: Binding, temperature: number): Partial<Samplers> {
  const { max_tokens: _limit, ...own } = binding.samplers ?? {};
  return { ...own, temperature: own.temperature ?? temperature };
}

const tokenLimit = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);

/** Recall's route and everything a run (or a prefetch's basis) reads off the session's config. */
export interface RecallSetup {
  cfg: ResolvedCompendiumConfig;
  mode: RecallMode;
  binding: Binding;
  /** null: no connection (or its caps cannot be resolved): a `no_connection` record, never a refusal. */
  route: Route | null;
  /** 'conn:model' of the recall route (of the binding when there is no route). */
  label: string;
  /** D-201/D-207: the scheduler's locality of the route's origin (false without a route, and in lexical and off). */
  local: boolean;
  /** §7.4.6: the recall binding's own window, and the profile it gives. */
  window: number;
  profile: CompendiumProfile;
  settings: { maxEntries: number; minEntries: number; contextMessages: number };
  reasoning: ModelRequest['reasoning'] | undefined;
  /** D-202: what of the setup a prefetch's result depends on (model, window, profile, settings), hashed. */
  fingerprint: string;
}

/** The recall setup of a session's config, or null while the Compendium is off. */
export function recallSetup(ctx: EngineCtx, config: SessionConfig): RecallSetup | null {
  const cfg = resolveCompendium(config.compendium);
  if (!cfg.enabled) return null;
  const mode = recallModeOf(config, ctx.recallDefault);
  const { binding, route } = resolveRecall(ctx, config);
  const window = route
    ? contextWindow({ caps: route.caps, local: route.conn.local, ...(config.window !== undefined ? { configWindow: config.window } : {}) })
    : DEFAULT_LOCAL_WINDOW;
  const profile = compendiumProfile(cfg.profile, window);
  const settings = recallSettings(cfg.recall, profile);
  const reasoning = route ? reasoningFor(binding, route.caps) : undefined;
  // The scheduler's locality, only when the mode can call (lexical and off never ask the origin).
  const local = route !== null && mode !== 'lexical' && mode !== 'off' ? ctx.sched.forOrigin(route.conn.origin, capacityOf(route.caps)).local : false;
  const label = route ? modelLabel(route.conn.id, route.model) : modelLabel(binding.conn, binding.model);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        label,
        window,
        profile,
        settings,
        cfg.recall.guidance,
        cfg.recall.timeoutSec ?? null,
        reasoning ?? null,
        binding.samplers ?? null,
        binding.maxTokens ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  return { cfg, mode, binding, route, label, local, window, profile, settings, reasoning, fingerprint };
}

/** D-201: the mode asks for a prefetch (prefetch, or auto on a local origin); the lane must also be in auto mode. */
export const wantsPrefetch = (s: RecallSetup): boolean => s.route !== null && (s.mode === 'prefetch' || (s.mode === 'auto' && s.local));

/** D-201: what a miss falls back to — onMiss, its 'auto' being lexical on a local origin and sync on a remote one. */
export const onMissOf = (s: RecallSetup): 'lexical' | 'sync' => (s.cfg.recall.onMiss === 'auto' ? (s.local ? 'lexical' : 'sync') : s.cfg.recall.onMiss);

/**
 * D-202 (amended, section I): the basis of a prefetch computed after `head` (a prefetch's own head; the
 * turn's: U's parent, a continue's target): the head, the newest touch (edit, hide) of a path message up
 * to the head and the hidden ones among them, and the setup's fingerprint (recall model, window, profile,
 * settings). Not the Compendium's rev: picks are entry keys and the block reads their current text, so a
 * lane row filed after the prefetch (which moves the rev every answer) must not waste it. The turn adopts
 * a prefetch only when its basis is this one exactly.
 */
export function prefetchBasis(setup: RecallSetup, view: PathView, tree: TreeIndex, head: string): string {
  const at = view.path.findIndex((m) => m.id === head);
  let touched = 0;
  let hidden = 0;
  for (let i = 0; i <= at; i++) {
    const m = view.path[i]!;
    touched = Math.max(touched, tree.touched.get(m.id) ?? 0);
    if (m.hidden) hidden++;
  }
  return `${head}|${touched}|${hidden}|${setup.fingerprint}`;
}

/**
 * Ruling K (breaker#2): the head of a turn's prefetch basis — the newest assistant message at or before
 * `id` on its branch (U's parent; a continue's target), user messages skipped: a player's message stacked
 * under one the narrator never answered still reads the prefetch made after the last answer (the lane
 * prefetches only after an answer or the greeting). null: no assistant message before it.
 */
export function basisHead(tree: TreeIndex, id: string | null): string | null {
  for (let at = id; at !== null; ) {
    const m = tree.msgs.get(at);
    if (m === undefined) return null;
    if (m.role === 'assistant') return at;
    at = m.parent;
  }
  return null;
}

/**
 * The RecallRecord a message carries as it reads now: its newest `continue` edit's when one has a record,
 * else its own (checkRecallRecord: a malformed one reads as absent).
 */
export function effectiveRecall(tree: TreeIndex, id: string): RecallRecord | null {
  let rec: unknown = tree.msgs.get(id)?.recall;
  for (const e of tree.edits.get(id) ?? []) if (e.reason === 'continue' && e.recall !== undefined) rec = e.recall;
  return rec === undefined ? null : checkRecallRecord(rec);
}

/** The scheduler `sched` with `onGrant` called each time a request of it is given a place (not one preempted at once). */
export function tapGrant(sched: Scheduler, onGrant: () => void): Scheduler {
  return {
    touch: (origin) => sched.touch(origin),
    forOrigin: (origin, capacity): OriginSemaphore => {
      const sem = sched.forOrigin(origin, capacity);
      return {
        get capacity() {
          return sem.capacity;
        },
        get local() {
          return sem.local;
        },
        inFlight: (priority) => sem.inFlight(priority),
        waiting: (priority) => sem.waiting(priority),
        acquire: async (priority, signal, opts) => {
          const slot = await sem.acquire(priority, signal, opts);
          if (!slot.signal.aborted) onGrant();
          return slot;
        },
      };
    },
  };
}

// ---- one run ------------------------------------------------------------------------------------------

export interface RecallRunInput {
  setup: RecallSetup;
  route: Route;
  /** The fold the request reads (a turn: folded at U; a prefetch: the head's). */
  view: PathView;
  tree: TreeIndex;
  /** The conversation's last message: U (a reply or swipe), a continue's target, the head answer A(n) (a prefetch). */
  upTo: string;
  /** A prefetch: no U (its window is the head's, `null`), the prefetch line, the 60 s deadline, `basis` = upTo. */
  prefetch: boolean;
  counter: TokenCounter;
  env: AgentCallEnv;
  /** The run's signal (a turn's child signal; a prefetch's own). */
  signal: AbortSignal;
  /** `<turn>:recall` → `<turn>:recall:0`…; the top-up `<prefix>:more:0`. */
  callKeyPrefix: string;
  priority: 'interactive' | 'background';
  idleDelaySec?: number;
  /** The first time one of its calls is given a place on the server. */
  onGrant?: () => void;
}

export interface RecallRunResult {
  record: RecallRecord;
  /** Trace.calls rows of every call (the top-up's included). */
  calls: TraceCall[];
  /** The index was cut (recall_index_truncated); `omitted` entries left out. */
  truncated: boolean;
  omitted: number;
  /** The server refused the structured transport (caps.suggest, as the Director's). */
  refused: boolean;
  /** A background run an interactive request took the place of (the lane runs it again; no result). */
  preempted: boolean;
}

/**
 * D-197…D-200, D-204: one recall run. Never throws for provider trouble: every outcome is a record. The
 * deadline runs from the first call's grant (structuredCall's budget); the top-up gets what is left of it.
 * The record's `ms` runs from that grant too (ruling K): recall's own time, not its wait for a place (the
 * Director's call on one place, a prefetch's idle gate); a run never granted counts from its start.
 */
export async function runRecall(input: RecallRunInput): Promise<RecallRunResult> {
  const { setup, route, view, tree, upTo, prefetch, env } = input;
  const { profile, settings, cfg } = setup;
  const t0 = env.clock().getTime();
  const count = (s: string): number => estimateTokens(s, input.counter);
  const at = view.path.findIndex((m) => m.id === upTo);
  const path = at < 0 ? view.path : view.path.slice(0, at + 1);
  let u = -1;
  if (!prefetch) for (let i = path.length - 1; i >= 0 && u < 0; i--) if (path[i]!.role === 'user') u = i;
  const U = u < 0 ? undefined : path[u]!;
  const visible = path.filter((m) => !m.hidden);
  const before = (U === undefined ? path : path.slice(0, u)).filter((m) => !m.hidden).map(messageText);
  const basis = prefetch ? { basis: upTo } : {};

  // D-197: the window of U's request (a prefetch: the head's), the predicted {{recap}} slot left out.
  const index = recallIndex({
    view: view.compendium,
    vis: visibilityAt(view, tree, U?.id ?? null),
    slotIds: previousRecap(view, tree, upTo)?.recap.ids ?? [],
    profile,
    window: setup.window,
    count,
    uText: U === undefined ? '' : messageText(U),
    windowTexts: before,
    lastTexts: visible.map(messageText),
    castNames: view.castNames,
  });
  const done = (record: RecallRecord, calls: TraceCall[] = [], refused = false, preempted = false): RecallRunResult => ({
    record,
    calls,
    truncated: index.truncated,
    omitted: index.omitted,
    refused,
    preempted,
  });
  if (index.shown === 0) return done(skippedRecord({ profile, code: 'empty_index', omitted: index.omitted, model: setup.label, ...basis }));

  const caps = route.caps;
  // D-198 (+1 024): the room is not needed when the model does not reason, or when it is told not to and the wire can say so.
  const reasoningOff = caps.reasoning.output === 'none' || (setup.reasoning === 'none' && sendsReasoningOff(caps));
  const conversation: RecallMessage[] = visible.map((m) => ({ role: m.role, text: messageText(m) }));
  const req = recallRequest({
    index,
    conversation,
    profile,
    window: setup.window,
    guidance: cfg.recall.guidance,
    prefetch,
    minEntries: settings.minEntries,
    maxEntries: settings.maxEntries,
    contextMessages: settings.contextMessages,
    reasoningOff,
    count,
  });
  if (!req.fits) return done(skippedRecord({ profile, code: 'no_room', omitted: index.omitted, model: setup.label, ...basis }));

  const { read, rawRead } = recallReader({ handles: index.handles, names: index.names, maxEntries: settings.maxEntries, profile });
  const transport = chooseTransport(caps);
  const capOut = tokenLimit(caps.maxOutput) ?? Infinity;
  const bindOut = tokenLimit(setup.binding.maxTokens) ?? tokenLimit(setup.binding.samplers?.max_tokens) ?? Infinity;
  const maxTokens = Math.max(1, Math.floor(Math.min(req.maxTokens, capOut, bindOut)));
  const deadline = recallDeadlineMs({ prefetch, local: setup.local, ...(cfg.recall.timeoutSec !== undefined ? { timeoutSec: cfg.recall.timeoutSec } : {}) });
  let granted: number | null = null;
  const sched = tapGrant(env.sched, () => {
    if (granted !== null) return;
    granted = env.clock().getTime();
    input.onGrant?.();
  });
  const common = {
    agent: 'recall' as const,
    schema: req.schema,
    read,
    rawRead,
    system: req.system,
    tag: null,
    // D-208: the answer's opening, a prefill where the transport and the caps take one (structuredCall decides).
    opening: req.opening,
    route,
    transport,
    samplers: samplersFor(setup.binding, req.temperature),
    ...(setup.reasoning !== undefined ? { reasoning: setup.reasoning } : {}),
    count,
    turnSignal: input.signal,
    env: { ...env, sched },
    priority: input.priority,
    ...(input.idleDelaySec !== undefined ? { idleDelaySec: input.idleDelaySec } : {}),
  };
  const first: StructuredResult<RecallRead> = await structuredCall<RecallRead>({
    ...common,
    user: [req.user],
    maxTokens,
    repair: req.repair,
    callKeyPrefix: input.callKeyPrefix,
    budgetMs: deadline,
  });
  if (!first.ok && first.code === 'preempted') return done(recallRecord({ source: 'prefetch', profile, omitted: index.omitted, model: setup.label, transport, first, ...basis }), first.calls, false, true);

  // D-198: the top-up, full only, within what is left of the deadline; it replaces the first answer only when it reads and has more.
  // Ruling K (§7.4.2 "there is no third", Bunraku's `calls < 2`): only after a first structuredCall of one
  // model call — a corrective pass (or a retry) already was the second call.
  let topUp: StructuredResult<RecallRead> | undefined;
  if (first.ok && first.calls.length < 2 && needsTopUp(first.value, { profile, ...settings, shown: index.shown }) && !input.signal.aborted) {
    const left = deadline - (granted === null ? 0 : env.clock().getTime() - granted);
    const user = topUpUser(req, first.value, settings.minEntries);
    const more = Math.min(maxTokens, Math.floor(setup.window - req.tokens - count(user[1]!) - MESSAGE_OVERHEAD_TOKENS));
    if (left > 0 && more >= AGENT_OUTPUT_FLOOR) {
      topUp = await structuredCall<RecallRead>({ ...common, user, maxTokens: more, repair: false, callKeyPrefix: `${input.callKeyPrefix}:more`, budgetMs: left });
    }
  }
  const record = recallRecord({
    source: prefetch ? 'prefetch' : 'sync',
    profile,
    omitted: index.omitted,
    model: setup.label,
    transport,
    first,
    ...(topUp !== undefined ? { topUp } : {}),
    ms: Math.max(0, env.clock().getTime() - (granted ?? t0)),
    ...basis,
  });
  const calls = [...first.calls, ...(topUp?.calls ?? [])];
  return done(record, calls, !first.ok && first.code === 'transport_unsupported', topUp !== undefined && !topUp.ok && topUp.code === 'preempted');
}

// ---- the record in the trace, the events and the notices ------------------------------------------------

/** trace.agents.recall of a record (D-203): done, reused, skipped or failed, with its code and transport. */
export function recallAgentRow(rec: RecallRecord): Trace['agents'][string] {
  const status = rec.source === 'reused' ? 'reused' : rec.status === 'failed' ? 'failed' : rec.status === 'skipped' ? 'skipped' : 'done';
  return { status, ...(rec.code !== undefined ? { code: rec.code } : {}), ...(rec.transport !== undefined ? { transport: rec.transport } : {}) };
}

/** How a record came to the turn (or the lane). */
export type RecallHow = 'sync' | 'adopted' | 'reused' | 'prefetch';

/**
 * The `agent` event of a finished run or a decided record (§7.4.9): a turn's recalled (sync), adopted
 * (a prefetch) or reused; fallback when the selector stood in (a failure, a missed prefetch); skipped
 * (no index, no room, no connection). The lane's prefetch: done (its picks) or failed.
 */
export function recallEvent(rec: RecallRecord, how: RecallHow): Extract<EventBody, { type: 'agent' }> {
  const count = rec.picks.length;
  const base = { type: 'agent' as const, agent: 'recall' as const };
  if (how === 'reused') return { ...base, status: 'reused', source: 'reused', count };
  if (rec.status === 'failed') {
    return how === 'prefetch' ? { ...base, status: 'failed', ...(rec.code !== undefined ? { code: rec.code } : {}) } : { ...base, status: 'fallback', source: 'lexical', ...(rec.code !== undefined ? { code: rec.code } : {}) };
  }
  if (rec.status === 'skipped') {
    if (rec.code === 'prefetch_missed') return { ...base, status: 'fallback', source: 'lexical', code: rec.code };
    return { ...base, status: 'skipped', ...(rec.code !== undefined ? { code: rec.code } : {}) };
  }
  if (how === 'prefetch') return { ...base, status: 'done', source: 'prefetch', count };
  return { ...base, status: how === 'adopted' ? 'adopted' : 'recalled', source: how === 'adopted' ? 'prefetch' : 'sync', count };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** D-197: the index was cut (once per session). */
export function truncatedNotice(omitted: number, profile: CompendiumProfile, label: string): Notice {
  return {
    level: 'info',
    code: RECALL_INDEX_TRUNCATED,
    message:
      `The recall index did not fit its budget: ${plural(omitted, 'Compendium entry was', 'Compendium entries were')} left out of the list ` +
      `recall picks from (${label}, ${profile} profile). Entries named in the conversation still reach the narrator; a recall model with a larger window lists more.`,
  };
}

/**
 * D-204 and ruling K: the turn waited for a prefetch that was running and did not get its selection (once
 * per session) — `late`: still running after grace_sec (it was cancelled), else it ended without one
 * (preempted or cancelled before it answered). Never told when nothing was waited for.
 */
export function missedNotice(graceSec: number, late: boolean): Notice {
  return {
    level: 'info',
    code: PREFETCH_MISSED,
    message: late
      ? `The recall prefetched while the player typed was still running when the turn needed it (the turn waited ${graceSec} s for it), so it went on without it. ` +
        `A longer compendium.recall.grace_sec, or a second slot on the server, gives the prefetch time.`
      : `The recall prefetched while the player typed ended without a selection while the turn waited for it (it was interrupted before it answered), so the turn went on without it.`,
  };
}

/** D-204: sync recalls keep the player waiting (once per session, after RECALL_SLOW_AFTER slow ones). */
export function slowNotice(n: number, ms: number, label: string): Notice {
  return {
    level: 'info',
    code: RECALL_SLOW,
    message:
      `Recall kept the turn waiting: ${n} of this session's recalls took more than ${RECALL_SLOW_MS / 1000} s (the last ${(ms / 1000).toFixed(1)} s on ${label}). ` +
      `Prefetch (/memory mode prefetch) runs it while the player types; a cheaper or faster recall model (/model recall) shortens it.`,
  };
}
