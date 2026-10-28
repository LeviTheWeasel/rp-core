// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The session's background lane (ARCHITECTURE.md §7.4.7, §6.7; .notes/m5b-decisions.md D-171, D-172,
// D-180 and the lead's rulings G): the Compendium's filing agent and its historian, one task at a time,
// at background priority, for one open session.
//
// The work is derived, never a cursor. Every look (after a commit, a head move, an edit, a hide, a
// config change, a verb, at open) folds the path afresh:
// - an accepted answer is an assistant message of the active path, not hidden, not the opening
//   greeting (anything before the first user message is card material), with at least `filing.wait`
//   visible user messages after it (wait 0: committed), whose `msg` seq is after the enable moment
//   (the header when the session was created enabled, just before a fork's fork-point answer, else
//   the newest `config` entry that turned the Compendium on);
// - it is covered by a filing key whose row applies, or whose reverted row is not stale, and whose
//   range holds it; an answer a stale filing row spans is debt whatever the enable moment (the lead's
//   ruling I: an edit of an old message re-files it after /memory off+on and on forks);
// - uncovered accepted answers group by `everyN` in path order; a covered, hidden or earlier answer
//   ends a group (the part before is its own task); the last group waits until it has N answers; a
//   group the request builder cannot fit is split by halves, each part a task at once (keyed by its
//   last answer); the first part's row records the whole group's end (`groupEnd`, ruling K), so the
//   rest is owed at once after a reopen too;
// - then one historian check over the path up to the last accepted answer (positions before the
//   enable moment count as covered, the lead's ruling G, except where a stale historian row left a
//   hole);
// - a key with maxAttempts `job{failed}` rows since its newest `mem` or `job{retry}` row is parked (one
//   `no_room` failure parks it at once); its next attempt is that count plus one, so a preempted,
//   superseded or shut-down run (which writes nothing after its begin) is not an attempt. A parked
//   historian key whose window is covered or no longer due is dropped (its key moves with the window),
//   and so is a parked filing key whose answers are hidden, filed or owed under another key (ruling K);
// - when two tasks of one agent park in a row, the agent pauses (the circuit breaker, ruling K): no new
//   task of it starts until memoryRetry or the next open (memory_paused once, MemoryStatus.blocked).
// Besides the derived work the lane runs what was asked for by name: a refile and a retry. They run
// only while their agent is on (held while it is off, never begun). Recovery at open (§6.7) needs no
// list of its own (ruling I: rule 1 is a hint): a `job{begin}` left with no row after it runs again
// with its attempt exactly when its key is in the derived debt (rule 2); begins of superseded windows
// and of covered answers are dropped; rule 3 is parking.
//
// A pass stages against exactly what the fold applies before its row on the head path (ruling K,
// apply.ts foldStaged).
// A run: `job{begin, attempt}` (durable), then structuredCall at 'background' priority on the recorder
// binding (D-85: roles.recorder, else the narrator's connection and model), then one `mem` row (with
// the calls' usage rows, as a turn's trace.calls) or `job{failed, code}`. `agent{started}` is told when
// its call is given a place on the server (the idle gate and interactive work come first). A preemption
// re-queues the task (3 in a row, counted per key for filing and per agent for the historian, whose
// key moves: it goes first, memory_starved once); an edit, a hide, a head move, an undo or a config
// change that pulls the ground from under a running task aborts it ('superseded', told as
// agent{skipped}); close() aborts it with 'shutdown'. Nothing it writes moves the session's version.
// Events and notices go on the session bus (never into a turn's stream).
//
// Mode (D-171, rulings G and I): 'auto' starts tasks by itself; 'manual' only when memoryWait asks.
// The lane starts nothing while a turn of the session runs (the turn's own calls come first; the lane
// looks again when it settles): a task begun between a message and its turn would only be preempted.
// Auto mode also holds back while the head is a user message younger than max(idleDelaySec, 2 s) (a
// `send` its `runTurn` follows), and spaces a key's attempts after a failure: 15 s × 2^(attempt − 1),
// at most 5 min (manual memoryWait ignores both). memoryWait in auto mode only waits.

import { foldStaged, normalizeName } from '../agents/compendium/apply.ts';
import { cutMiddle, filingReader, filingRequest, stageFiling, type FilingExchange, type FilingItem } from '../agents/compendium/filing.ts';
import {
  historianDue,
  historianKey,
  historianOps,
  historianRequest,
  historianWindowAt,
  readHistorianAnswer,
  type HistMessage,
  type HistorianAnswer,
  type HistorianRequest,
  type HistorianWindow,
} from '../agents/compendium/historian.ts';
import { storyLanguage } from '../agents/compendium/language.ts';
import { messageText } from '../agents/compendium/mention.ts';
import { compendiumProfile, resolveCompendium, type ResolvedCompendiumConfig } from '../agents/compendium/profile.ts';
import type { CompendiumProfile, CompendiumView, LibrarySeed, TaskState } from '../agents/compendium/types.ts';
import { capSkipped } from '../agents/director/call.ts';
import type { ReadResult, Skip } from '../agents/director/types.ts';
import {
  AGENT_OUTPUT_FLOOR,
  chooseTransport,
  STRUCTURED_REFUSED_KEY,
  structuredCall,
  structuredRefusedMessage,
  type AgentCallEnv,
  type StructuredResult,
  type TraceCall,
  type Transport,
} from '../agents/structured.ts';
import type { Samplers } from '../formats/native.ts';
import { contextWindow, DEFAULT_LOCAL_WINDOW } from '../prompt/budget.ts';
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS } from '../prompt/tokens.ts';
import type { EventBody, Notice } from '../protocol/events.ts';
import type { JSONSchema, ModelCaps, ModelRequest } from '../providers/types.ts';
import type { Binding, Entry, EntryInput, JobEntry, MemEntry, SessionConfig, SessionHeader } from '../session/entries.ts';
import { mergePatch } from '../session/fold.ts';
import { hex8 } from '../session/ids.ts';
import { SessionLockedError } from '../session/log.ts';
import { pathTo, type TreeIndex } from '../session/tree.ts';
import type { MessageView, PathView } from '../session/view.ts';
import { abortWith, reasonOf } from './abort.ts';
import { Refusal, type Connection, type LaneTaskInfo, type MemoryLaneWrite, type MemoryStatus } from './api.ts';
import { resolveConnection, resolvePrimary, routeTo, type Route } from './admit.ts';
import type { EngineCtx } from './context.ts';
import { timeoutsFor } from './narrate.ts';
import type { SessionLibrary } from './request.ts';
import { modelLabel } from './route.ts';
import { STARVED_AFTER, type OriginSemaphore, type Scheduler } from './sched.ts';
import { keepRequestFile } from './turn.ts';

/** What the lane needs from its session (SessionImpl implements it). */
export interface LaneHost {
  readonly sessionId: string;
  header(): SessionHeader;
  entries(): readonly Entry[];
  tree(): TreeIndex;
  view(): PathView;
  library(): SessionLibrary;
  currentConfig(): SessionConfig;
  /** A turn of the session is running (auto mode starts nothing then). */
  busy(): boolean;
  /** The session's one writer (job and mem rows never move the version). */
  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number };
  now(): string;
  /** True the first time a once-per-session notice code is seen. */
  firstNotice(code: string): boolean;
  /** A session-level event on the bus (no turn). */
  publish(body: EventBody): void;
  /**
   * One `memory` event per entry the row at `seq` of task `key` really changed (`before`/`after`: the
   * head view's Compendium around the write), the entries the key's replaced row had made and this one
   * dropped included.
   */
  publishChanges(before: CompendiumView, after: CompendiumView, seq: number, by: 'filing' | 'historian', key: string): void;
}

/** One task of the lane. */
export type LaneTask =
  | { task: 'file'; key: string; on: string; answers: string[]; range: [string, string] }
  | { task: 'hist'; key: string; on: string; range: [string, string] };

/** A parked key and the task it would run. */
interface Parked {
  key: string;
  on: string;
  failures: number;
  /** The code of its last failure. */
  code?: string;
  task: LaneTask | null;
}

/** One look at the path (cached until the journal, the config, the books or the lane's own state change). */
interface Plan {
  /** Runnable tasks in order (starved first, filing oldest first, then the historian); the running key left out. */
  tasks: LaneTask[];
  /** Tasks asked for by name whose agent is off (ruling I: held, never begun). */
  held: LaneTask[];
  parked: Parked[];
  /** Uncovered accepted answers (queued or waiting for their group). */
  backlog: number;
  /** Key → the attempt its next run is. */
  attempts: Map<string, number>;
  /** Every derived task, parked ones included (refile and retry find their specs here). */
  derived: Map<string, LaneTask>;
  /** The path's answers by id (refile's checks). */
  answers: Map<string, Answer>;
  cfg: ResolvedCompendiumConfig;
  /** The Compendium is on (it has an enable moment). */
  on: boolean;
}

/** A running task. */
interface Running {
  task: LaneTask;
  job: string;
  attempt: number;
  ctrl: AbortController;
  /** seq of its job{begin}: a message of its range touched after it makes the result stale. */
  beginSeq: number;
  /** No call of it has been given a place yet (the idle gate, a turn); `agent{started}` comes with the first. */
  waiting: boolean;
  done: Promise<void>;
}

/** The recorder's route and what goes with it. */
interface Recorder {
  binding: Binding;
  route: Route;
  window: number;
  profile: CompendiumProfile;
  count: (text: string) => number;
}

/** What a task comes to before its call (no row written yet). */
type Prepared =
  | {
      kind: 'call';
      agent: 'filing' | 'historian';
      system: string;
      user: string;
      schema: { name: string; schema: JSONSchema };
      maxTokens: number;
      temperature: number;
      profile: CompendiumProfile;
      read(raw: unknown): ReadResult<unknown>;
      /**
       * The row from the read answer: its ops, its skipped list (capped) and how many were skipped in
       * all; `fail`: the attempt fails instead (a historian answer whose summaries were all refused, or
       * one cut off that applies none). `cut`: the answer was cut off (structuredCall's cutOff: finish
       * 'length', or its JSON closed by closedItems).
       */
      row(value: unknown, readSkipped: Skip[], cut: boolean): { ops: MemEntry['ops']; skipped: Skip[]; skippedCount: number; notices: Notice[]; fail?: { code: string; reason: string } };
      range: [string, string];
      on: string;
    }
  | { kind: 'split'; after: string }
  | { kind: 'gone' }
  | { kind: 'fail'; code: string };

/** Synchronous outcomes in a row that one look may take before it gives up (splits, gone tasks, instant failures). */
const PUMP_GUARD = 64;

/** Ruling K (the circuit breaker): an agent pauses when this many of its tasks park in a row. */
const PAUSE_AFTER_PARKS = 2;

/** D-174: the filing call's budget by origin when compendium.filing.timeoutSec is unset (seconds). */
const FILING_TIMEOUT_LOCAL_SEC = 300;
const FILING_TIMEOUT_REMOTE_SEC = 120;

/** Ruling I: a key's next attempt after a failure waits BACKOFF_BASE_MS × 2^(attempt − 1), at most BACKOFF_MAX_MS (auto mode). */
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 300_000;

/** Ruling I: auto mode holds back while the head is a user message younger than max(idleDelaySec, this) seconds. */
const FRESH_MESSAGE_SEC = 2;

/** setTimeout's ceiling (2^31 − 1 ms): a longer memoryWait timeout waits that long. */
const MAX_TIMER_MS = 2_147_483_647;

/** The historian's request that does not fit: rounds of cutting its largest message, and the size below which a message is not cut further (tokens). */
const FIT_ROUNDS = 16;
const FIT_FLOOR_TOKENS = 32;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A positive finite token limit, floored; else undefined. */
const tokenLimit = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);

/** D-85 (as the Director's D-101): the binding's reasoning; else off when the model can turn it off; else 'low' when it takes an effort. */
function reasoningFor(binding: Binding, caps: ModelCaps): ModelRequest['reasoning'] | undefined {
  if (binding.reasoning !== undefined) return binding.reasoning;
  if (caps.reasoning.canDisable) return 'none';
  if (caps.reasoning.control === 'effort' && (caps.reasoning.efforts === undefined || caps.reasoning.efforts.includes('low'))) return 'low';
  return undefined;
}

/** The binding's samplers only (max_tokens goes to maxTokens), the agent's temperature unless the binding sets one. */
function samplersFor(binding: Binding, temperature: number): Partial<Samplers> {
  const { max_tokens: _limit, ...own } = binding.samplers ?? {};
  return { ...own, temperature: own.temperature ?? temperature };
}

/**
 * D-85: the recorder's binding and route. `roles.recorder` absent or 'narrator' → the narrator's
 * connection and model only (not its reply settings); an explicit binding keeps all its fields. A
 * connection that is missing or whose caps cannot be resolved gives route null (the lane waits).
 * providerOverride applies.
 */
export function resolveRecorder(ctx: EngineCtx, config: SessionConfig): { binding: Binding; route: Route | null } {
  const role = config.roles.recorder;
  const narrator = config.roles.narrator;
  const own = role !== undefined && role !== 'narrator';
  const binding: Binding = own ? role : { conn: narrator.conn, model: narrator.model };
  try {
    if (!own) return { binding, route: resolvePrimary(ctx, config) };
    const conn = resolveConnection(ctx, role.conn);
    return { binding, route: conn ? routeTo(conn, role.model) : null };
  } catch (e) {
    if (e instanceof Refusal) return { binding, route: null };
    throw e;
  }
}

/** The connections a session's bindings resolve to (narrator, its fallback, Director, recorder, recall), by id. */
function sessionConnections(ctx: EngineCtx, config: SessionConfig): Map<string, Connection> {
  const out = new Map<string, Connection>();
  const add = (id: string | undefined): void => {
    if (id === undefined) return;
    const conn = resolveConnection(ctx, id);
    if (conn) out.set(conn.id, conn);
  };
  const { narrator, director, recorder, recall } = config.roles;
  add(narrator.conn);
  add(narrator.fallback?.conn);
  for (const role of [director, recorder, recall]) if (typeof role === 'object') add(role.conn);
  return out;
}

/**
 * A fork's moment (the lead's rulings H and I): just before the earliest answer of the fork point's
 * path that was not yet accepted there (fewer than `wait` visible user messages after it up to the fork
 * point), so it is filed once it is accepted on the fork; at the fork point when every answer was
 * accepted. Earlier answers are the source's: its copied rows cover what it filed, and the rest is not
 * back-filled. `wait` is the fork's own filing.wait at its creation (its header's config).
 */
function forkMoment(tree: TreeIndex, at: string, wait: number): number {
  const msg = tree.msgs.get(at);
  if (msg === undefined) return 0;
  const path = pathTo(tree, at);
  const first = path.findIndex((id) => tree.msgs.get(id)?.role === 'user');
  let users = 0;
  let earliest: number | null = null;
  // Acceptance only grows towards the root (an earlier answer has at least as many user messages after it).
  for (let i = path.length - 1; first >= 0 && i > first; i--) {
    const m = tree.msgs.get(path[i]!)!;
    const hidden = tree.hidden.get(m.id) === true;
    if (m.role === 'user') {
      if (!hidden) users++;
      continue;
    }
    if (hidden) continue;
    if (users >= wait) break;
    earliest = m.seq;
  }
  return earliest !== null ? earliest - 1 : msg.seq;
}

/**
 * D-171 (C-11, G-26): the seq after which answers count, or null while the Compendium is off. The
 * header when the session was created enabled (0; a fork: forkMoment); else the newest `config` entry
 * that turned compendium.enabled on.
 */
export function enableMoment(header: SessionHeader, entries: readonly Entry[], tree: TreeIndex): number | null {
  let config = header.config;
  const created = resolveCompendium(config.compendium);
  let on = created.enabled;
  let moment: number | null = on ? (header.fork ? forkMoment(tree, header.fork.at, created.filing.wait) : 0) : null;
  for (const e of entries) {
    if (e.t !== 'config') continue;
    config = mergePatch<SessionConfig>(config, e.patch);
    const now = resolveCompendium(config.compendium).enabled;
    if (now && !on) moment = e.seq;
    on = now;
  }
  return on ? moment : null;
}

/** The 'on' and range a key names: 'file:<on>' (range unknown), 'hist:<from>-<to>'. */
function keyParts(key: string): { task: 'file' | 'hist'; on: string; range?: [string, string] } | null {
  if (key.startsWith('file:')) return { task: 'file', on: key.slice(5) };
  if (!key.startsWith('hist:')) return null;
  const [from, to] = key.slice(5).split('-');
  return from && to ? { task: 'hist', on: to, range: [from, to] } : null;
}

/** The message a task key's row is bound to ('file:<on>', 'hist:<from>-<on>'), or null for another key. */
export const taskOn = (key: string): string | null => keyParts(key)?.on ?? null;

/** id → index on the path. */
const indexOf = (path: readonly MessageView[]): Map<string, number> => new Map(path.map((m, i) => [m.id, i]));

/** The visible messages a range [from, to] spans on the path (indexes), or null when an end is off the path. */
function rangeSpan(at: ReadonlyMap<string, number>, range: readonly [string, string]): [number, number] | null {
  const a = at.get(range[0]);
  const b = at.get(range[1]);
  if (a === undefined || b === undefined || a > b) return null;
  return [a, b];
}

/** The first visible message of an answer's exchange: its user messages back to the previous answer, else the answer. */
function exchangeStart(view: PathView, at: ReadonlyMap<string, number>, answer: string): string {
  const end = at.get(answer);
  if (end === undefined) return answer;
  let i = end;
  while (i > 0 && view.path[i - 1]!.role === 'user') i--;
  return view.path.slice(i, end).find((m) => !m.hidden)?.id ?? answer;
}

/** One answer of the path as the derivation reads it. */
interface Answer {
  id: string;
  at: number;
  hidden: boolean;
  /** ≥ wait visible user messages after it. */
  accepted: boolean;
  /** Its msg seq is after the enable moment. */
  counted: boolean;
  /** Its range start: the first visible user message since the previous answer, else itself. */
  first: string;
}

/** Every assistant message after the first user message of the path (the greeting and card material before it never count). */
function answersOf(view: PathView, tree: TreeIndex, wait: number, moment: number): Answer[] {
  const path = view.path;
  const usersAfter: number[] = new Array<number>(path.length + 1).fill(0);
  for (let i = path.length - 1; i >= 0; i--) usersAfter[i] = usersAfter[i + 1]! + (path[i]!.role === 'user' && !path[i]!.hidden ? 1 : 0);
  const out: Answer[] = [];
  let seenUser = false;
  let first: string | null = null;
  path.forEach((m, i) => {
    if (m.role === 'user') {
      seenUser = true;
      if (first === null && !m.hidden) first = m.id;
      return;
    }
    if (!seenUser) return;
    out.push({
      id: m.id,
      at: i,
      hidden: m.hidden,
      accepted: usersAfter[i + 1]! >= wait,
      counted: (tree.msgs.get(m.id)?.seq ?? 0) > moment,
      first: first ?? m.id,
    });
    first = null;
  });
  return out;
}

/** D-171: a task state whose row covers its range (applied, or reverted with a row that is not stale). */
const effective = (s: TaskState): boolean => s.status === 'applied' || (s.status === 'reverted' && s.stale !== true);

/** A task state whose row went stale (stale, or reverted with a stale reverted row): its range is to be written again. */
const restale = (s: TaskState): boolean => s.status === 'stale' || (s.status === 'reverted' && s.stale === true);

/** The path indexes the ranges of one kind's keys (`file:`, `hist:`) span, for the states `which` picks (`except`: a key left out). */
function spanned(view: PathView, at: ReadonlyMap<string, number>, prefix: string, which: (s: TaskState) => boolean, except?: string): Uint8Array {
  const out = new Uint8Array(view.path.length);
  for (const [key, s] of view.compendium.tasks) {
    if (key === except || !key.startsWith(prefix) || s.range === undefined || !which(s)) continue;
    const span = rangeSpan(at, s.range);
    if (span === null) continue;
    for (let i = span[0]; i <= span[1]; i++) out[i] = 1;
  }
  return out;
}

/** D-171: the ids filing rows cover on this path (applied, or reverted with a row that is not stale). */
function coveredIds(view: PathView, at: ReadonlyMap<string, number>): Set<string> {
  const marks = spanned(view, at, 'file:', effective);
  return new Set(view.path.filter((_, i) => marks[i] === 1).map((m) => m.id));
}

/**
 * Ruling K (lane#1, cli#1): every answer of a filing task is hidden, covered by another filing key's row,
 * or part of another derived filing task (the derivation files it under that key).
 */
function filedElsewhere(view: PathView, at: ReadonlyMap<string, number>, t: Extract<LaneTask, { task: 'file' }>, derived: ReadonlyMap<string, LaneTask>): boolean {
  const marks = spanned(view, at, 'file:', effective, t.key);
  const owed = new Set<string>();
  for (const d of derived.values()) if (d.task === 'file' && d.key !== t.key) for (const id of d.answers) owed.add(id);
  return t.answers.every((id) => {
    const i = at.get(id);
    return i === undefined || view.path[i]!.hidden || marks[i] === 1 || owed.has(id);
  });
}

/** Ruling I: every visible message of a historian range is covered by another historian key's row (a parked or asked-for window a wider pass took). */
function histCovered(view: PathView, at: ReadonlyMap<string, number>, key: string, range: readonly [string, string]): boolean {
  const span = rangeSpan(at, range);
  if (span === null) return false;
  const marks = spanned(view, at, 'hist:', effective, key);
  for (let i = span[0]; i <= span[1]; i++) if (!view.path[i]!.hidden && marks[i] !== 1) return false;
  return true;
}

/** The newest committed answer's trace.trimmed on the path (its continue's when it has one); null: nothing cut or unknown. */
function newestTrim(view: PathView, tree: TreeIndex): { from: string; to: string } | null {
  for (let i = view.path.length - 1; i >= 0; i--) {
    const m = view.path[i]!;
    if (m.role !== 'assistant') continue;
    let trace = tree.msgs.get(m.id)?.trace;
    for (const e of tree.edits.get(m.id) ?? []) if (e.reason === 'continue' && e.trace) trace = e.trace;
    if (!trace) continue;
    const t: unknown = trace.trimmed;
    return isRecord(t) && typeof t.from === 'string' && typeof t.to === 'string' ? { from: t.from, to: t.to } : null;
  }
  return null;
}

/** Whether a revert of `key` was written after `seq`. */
function revertedAfter(tree: TreeIndex, key: string, seq: number): boolean {
  for (let i = tree.mems.length - 1; i >= 0 && tree.mems[i]!.seq > seq; i--) {
    if (tree.mems[i]!.ops.some((op) => op.op === 'revert' && op.key === key)) return true;
  }
  return false;
}

/**
 * Ruling K (lane#5): the end of the whole group a split's first part was cut from, as its row recorded
 * it (`groupEnd`, any row of the key on the path), or undefined.
 */
function storedGroupEnd(tree: TreeIndex, pathSet: ReadonlySet<string>, key: string): string | undefined {
  for (let i = tree.mems.length - 1; i >= 0; i--) {
    const r = tree.mems[i]!;
    if (r.key === key && typeof r.groupEnd === 'string' && r.on !== null && pathSet.has(r.on)) return r.groupEnd;
  }
  return undefined;
}

/**
 * The historian's request for a window. When it leaves less than AGENT_OUTPUT_FLOOR of the recorder's
 * window for the answer, its largest message is cut head and tail (as filing cuts its texts, D-174)
 * until it fits (the lead's ruling I: one message too large for the window never parks the
 * historian); null when even that leaves no room (the prompt alone is too large).
 */
function fitHistorian(w: HistorianWindow, build: (messages: HistorianWindow['messages']) => HistorianRequest, rec: Recorder): { req: HistorianRequest; room: number } | null {
  let messages = w.messages;
  for (let round = 0; round <= FIT_ROUNDS; round++) {
    const req = build(messages);
    const room = rec.window - (rec.count(req.system) + rec.count(req.user) + 2 * MESSAGE_OVERHEAD_TOKENS);
    if (room >= AGENT_OUTPUT_FLOOR) return { req, room };
    let big = -1;
    let bigTok = FIT_FLOOR_TOKENS;
    messages.forEach((m, i) => {
      const t = rec.count(m.text);
      if (t > bigTok) {
        big = i;
        bigTok = t;
      }
    });
    if (big < 0) return null;
    const keep = Math.max(FIT_FLOOR_TOKENS, bigTok - (AGENT_OUTPUT_FLOOR - room) - FIT_FLOOR_TOKENS);
    const chars = Math.max(1, Math.floor((messages[big]!.text.length * keep) / bigTok));
    messages = messages.map((m, i) => (i === big ? { ...m, text: cutMiddle(m.text, chars) } : m));
  }
  return null;
}

/** Ruling K: what a paused agent waits for (memory_paused, MemoryStatus.blocked). */
const pausedWords = (agent: 'file' | 'hist' | 'both'): string =>
  `No new ${agent === 'file' ? 'filing' : agent === 'hist' ? 'historian' : 'filing or historian'} task starts until /memory retry or the session is opened again; check the recorder's connection and model.`;

/** The key a preemption is counted under (D-172, ruling I): the task's for filing, the agent's for the historian (its key moves with the window). */
const preemptKey = (t: LaneTask): string => (t.task === 'hist' ? 'hist' : t.key);

const info = (t: LaneTask, attempt: number): LaneTaskInfo => ({ key: t.key, task: t.task, on: t.on, range: [t.range[0], t.range[1]], attempt });

export class Lane {
  private closed = false;
  private running: Running | null = null;
  /** Tasks asked for by name: refiles and retries of keys the derivation does not hold (they last while the session is open). */
  private readonly forced = new Map<string, LaneTask>();
  /** Answers after which a group ends (a group the request builder could not fit, split by halves). */
  private readonly splits = new Set<string>();
  /** Ruling K (lane#5): a split's cut → the end of the whole group it was cut from (its row records it as `groupEnd`). */
  private readonly groupEnds = new Map<string, string>();
  /** Ruling K (cli#1, the circuit breaker): per agent, its tasks parked in a row (a done task resets it), and the agents paused. */
  private readonly parksInRow = new Map<'file' | 'hist', number>();
  private readonly paused = new Set<'file' | 'hist'>();
  /** D-172: preemptions in a row per preemptKey, and the preemptKeys that go first. */
  private readonly preemptions = new Map<string, number>();
  private readonly starved = new Set<string>();
  /** Ruling I (auto mode): keys whose next attempt waits after a failure, with their timer. */
  private readonly backoff = new Map<string, unknown>();
  /** A key superseded before anything new was written, and the journal's last seq then: not begun again until the journal moves. */
  private readonly noRerun = new Map<string, number>();
  /** Ruling I (auto mode): the fresh user message at the head the lane holds back for, and the one whose hold ran out. */
  private hold: { id: string; timer: unknown } | null = null;
  private released: string | null = null;
  /** memoryWait loops waiting for the lane's next look. */
  private wakers: (() => void)[] = [];
  /** Keys told as queued (an `agent{queued}` each time a key enters the queue). */
  private announced = new Set<string>();
  /** The last idle{background} count told. */
  private told = 0;
  /** Bumped by every change of the lane's own state (part of the plan cache's key). */
  private rev = 0;
  private cache: { stamp: string; config: SessionConfig; seed: LibrarySeed; plan: Plan } | null = null;
  private pumping = false;

  constructor(
    private readonly ctx: EngineCtx,
    private readonly host: LaneHost,
    readonly mode: 'auto' | 'manual',
  ) {}

  // ---- the session's hooks ----------------------------------------------------------------------

  /**
   * The session opened (or was created): its origins are touched (the idle gate) and the lane looks.
   * Recovery (§6.7, D-171, ruling I) is that look: a `job{begin}` left with no row after it runs again
   * with its attempt (a begin is not a failure) when its key is in the derived debt; a begin of a
   * superseded window, of a covered answer or of a refile is not re-run; a parked key stays parked.
   */
  open(): void {
    this.touch();
    this.poke();
  }

  /** D-172: activity on every origin the session's bindings use (turn end, head, edit, hide, swipe, continue, open). */
  touch(): void {
    for (const conn of sessionConnections(this.ctx, this.host.currentConfig()).values()) this.ctx.sched.touch(conn.origin);
  }

  /** Something changed: look again (events, notices, a superseded run), and in auto mode start what is next. */
  poke(): void {
    if (this.closed) return;
    this.refresh();
    this.pump();
    this.wake();
  }

  /** close(): no new task, no timer left; a running one is aborted ('shutdown': nothing more is written; its key runs at the next open while it is still owed). */
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.backoff.values()) this.ctx.timers.clearTimeout(t);
    this.backoff.clear();
    if (this.hold) this.ctx.timers.clearTimeout(this.hold.timer);
    this.hold = null;
    this.wake();
    const r = this.running;
    if (!r) return;
    abortWith(r.ctrl, 'shutdown');
    await r.done;
  }

  /** The memoryWait loops look again. */
  private wake(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }

  /** Resolves at the lane's next look (a poke, a run's end, a timer, close). */
  private nextLook(): Promise<void> {
    return new Promise((resolve) => this.wakers.push(resolve));
  }

  // ---- the verbs (session.ts checks the session first) ----------------------------------------------

  status(): MemoryStatus {
    const plan = this.plan();
    const r = this.running;
    return {
      queued: plan.tasks.map((t) => info(t, plan.attempts.get(t.key) ?? 1)),
      ...(r ? { running: { ...info(r.task, r.attempt), job: r.job, ...(r.waiting ? { waiting: true as const } : {}) } } : {}),
      parked: plan.parked.map((p) => ({ key: p.key, on: p.on, failures: p.failures, ...(p.code !== undefined ? { code: p.code } : {}) })),
      ...(plan.held.length > 0 ? { held: plan.held.map((t) => info(t, plan.attempts.get(t.key) ?? 1)) } : {}),
      backlog: plan.backlog,
      ...this.blockedOf(plan),
    };
  }

  /**
   * Ruling K (cli#1, cli#9): why the lane cannot start a task — the recorder has no route (nothing runs),
   * or an agent is paused (the circuit breaker) — for the agents that are on; {} when nothing stops it.
   */
  private blockedOf(plan: Plan): { blocked?: NonNullable<MemoryStatus['blocked']> } {
    if (!plan.on) return {};
    const agent = (file: boolean, hist: boolean): 'filing' | 'historian' | 'both' | null => (file && hist ? 'both' : file ? 'filing' : hist ? 'historian' : null);
    const fileOn = plan.cfg.filing.enabled;
    const histOn = plan.cfg.historian.interval > 0;
    const stopped = agent(fileOn, histOn);
    if (stopped === null) return {};
    if (this.recorder(plan.cfg) === null) {
      const { binding } = resolveRecorder(this.ctx, this.host.currentConfig());
      const who = stopped === 'both' ? 'filing and historian' : stopped === 'filing' ? 'filing agent' : 'historian';
      return {
        blocked: {
          agent: stopped,
          reason: 'no_route',
          message: `The Compendium's ${who} cannot run: the recorder's connection ${JSON.stringify(binding.conn)} (model ${JSON.stringify(binding.model)}) is not available. Bind the recorder to a connection that exists (roles.recorder) or add that connection.`,
        },
      };
    }
    const paused = agent(fileOn && this.paused.has('file'), histOn && this.paused.has('hist'));
    if (paused === null) return {};
    const who = paused === 'filing' ? 'file' : paused === 'historian' ? 'hist' : 'both';
    const name = paused === 'filing' ? 'The filing agent is' : paused === 'historian' ? 'The historian is' : 'The filing agent and the historian are';
    return { blocked: { agent: paused, reason: 'paused', message: `${name} paused: two ${who === 'both' ? 'tasks of each' : 'of its tasks'} in a row were parked after failing. ${pausedWords(who)}` } };
  }

  /** A task of a paused agent does not start (ruling K, the circuit breaker). */
  private startable(t: LaneTask): boolean {
    return !this.paused.has(t.task);
  }

  /**
   * D-180, ruling I: the keys whose rows are bound to a message, per kind (filing first): the effective
   * row first (applied, then reverted and not stale), its `on` the message before a range holding it,
   * the newest row among equals; a stale key only when no effective row holds the message (a wider
   * pass that covered a stale window is the one bound). `task` keeps one kind.
   */
  boundKeys(messageId: string, task?: 'file' | 'hist'): { key: string; state: TaskState }[] {
    const view = this.host.view();
    const at = indexOf(view.path);
    const pos = at.get(messageId);
    const tier = (s: TaskState): number => (s.status === 'applied' ? 0 : effective(s) ? 1 : 2);
    const out: { key: string; state: TaskState }[] = [];
    for (const kind of ['file', 'hist'] as const) {
      if (task !== undefined && task !== kind) continue;
      let best: { key: string; state: TaskState; rank: number } | undefined;
      for (const [key, state] of view.compendium.tasks) {
        const parts = keyParts(key);
        if (parts?.task !== kind) continue;
        let how = 0;
        if (parts.on !== messageId) {
          const span = pos === undefined || state.range === undefined ? null : rangeSpan(at, state.range);
          if (span === null || pos! < span[0] || pos! > span[1]) continue;
          how = 1;
        }
        const rank = tier(state) * 2 + how;
        if (best === undefined || rank < best.rank || (rank === best.rank && state.seq > best.state.seq)) best = { key, state, rank };
      }
      if (best) out.push({ key: best.key, state: best.state });
    }
    return out;
  }

  /** Undo is writing reverts of these keys: a running job of one is superseded, a queued refile dropped. */
  cancel(keys: readonly string[]): void {
    for (const key of keys) {
      this.forced.delete(key);
      this.clearBackoff(key);
      if (this.running?.task.key === key) abortWith(this.running.ctrl, 'superseded');
    }
    this.rev++;
  }

  /**
   * D-180 refile: the keys bound to the message queued again by name; an accepted answer no filing row
   * is bound to: its own filing task as well (ruling K, even inside a historian pass). Ruling I: refused
   * in words for the Compendium off, a hidden message (or a pass whose answers are all hidden) and an
   * answer not accepted yet; with its agent off the task is held. A refusal names a pass by its task
   * key (`file:<id>`, `hist:<from>-<to>`), which a client may render as the lane's lines do.
   */
  refile(messageId: string, task?: 'file' | 'hist'): MemoryLaneWrite {
    const plan = this.plan();
    if (!plan.on) throw new Refusal('invalid_params', 'the Compendium is off: nothing is filed while it is (turn it on first)');
    const view = this.host.view();
    const at = indexOf(view.path);
    const m = view.path[at.get(messageId) ?? -1];
    if (m?.hidden) throw new Refusal('invalid_params', `message ${messageId} is hidden: hidden messages are not filed`);
    const specs: LaneTask[] = [];
    for (const { key, state } of this.boundKeys(messageId, task)) {
      const spec = this.specOf(key, view, at, state);
      if (spec) specs.push(spec);
    }
    // Ruling K (lane#2): an accepted answer no filing row is bound to gets its own filing task too,
    // whatever historian pass holds it (filing first).
    const answer = plan.answers.get(messageId);
    if (task !== 'hist' && answer !== undefined && !specs.some((s) => s.task === 'file')) {
      if (!answer.accepted) {
        const wait = plan.cfg.filing.wait;
        if (specs.length === 0) throw new Refusal('invalid_params', `message ${messageId} is not accepted yet: an answer is filed once ${wait} visible user message${wait === 1 ? '' : 's'} follow${wait === 1 ? 's' : ''} it (compendium.filing.wait)`);
      } else {
        const derived = [...plan.derived.values()].find((t) => t.task === 'file' && t.answers.includes(messageId));
        const spec = derived ?? this.specOf(`file:${messageId}`, view, at, undefined);
        if (spec) specs.unshift(spec);
      }
    }
    if (specs.length === 0) throw new Refusal('invalid_params', `no filing or historian task can be bound to message ${messageId}`);
    for (const spec of specs) {
      if (spec.task === 'file' && spec.answers.every((id) => view.path[at.get(id) ?? -1]?.hidden !== false)) {
        throw new Refusal('invalid_params', `${spec.key} has no visible answer left: hidden messages are not filed`);
      }
      const parked = plan.parked.find((p) => p.key === spec.key);
      if (parked) throw new Refusal('invalid_params', `${spec.key} is parked after ${parked.failures} failed attempt${parked.failures === 1 ? '' : 's'}: /memory retry queues it again`);
    }
    const queued = new Set([...plan.tasks, ...plan.held].map((t) => t.key));
    let changed = false;
    for (const spec of specs) {
      if (this.running?.task.key === spec.key || queued.has(spec.key)) continue;
      this.forced.set(spec.key, spec);
      changed = true;
    }
    if (changed) this.rev++;
    this.poke();
    return { keys: specs.map((s) => s.key), changed };
  }

  /**
   * D-180 retry: a `job{retry}` row per parked key (all, or those bound to the message), then queued: by
   * the derivation, or by name when the derivation does not hold it (a parked refile, ruling I). Ruling
   * K: it also resumes a paused agent (changed:true with no key when nothing is parked). Refused in
   * words while the Compendium is off.
   */
  retry(messageId?: string): MemoryLaneWrite {
    const plan = this.plan();
    if (!plan.on) throw new Refusal('invalid_params', 'the Compendium is off: nothing is filed while it is (turn it on first)');
    const view = this.host.view();
    const at = indexOf(view.path);
    const pos = messageId === undefined ? undefined : at.get(messageId);
    const picked = plan.parked.filter((p) => {
      if (messageId === undefined || p.on === messageId) return true;
      const range = p.task?.range ?? view.compendium.tasks.get(p.key)?.range;
      const span = range === undefined ? null : rangeSpan(at, range);
      return pos !== undefined && span !== null && pos >= span[0] && pos <= span[1];
    });
    // Ruling K (the circuit breaker): a retry resumes the paused agents (their parked windows may be gone).
    const resumed = this.paused.size > 0;
    this.paused.clear();
    this.parksInRow.clear();
    if (picked.length === 0) {
      if (!resumed) return { keys: [], changed: false };
      this.rev++;
      this.poke();
      return { keys: [], changed: true };
    }
    for (const p of picked) {
      const kind = keyParts(p.key)?.task ?? 'file';
      this.host.append({ t: 'job', ts: this.host.now(), job: this.jobId(), key: p.key, task: kind, on: p.on, state: 'retry', attempt: 1 });
      this.clearBackoff(p.key);
      if (plan.derived.has(p.key)) continue;
      const spec = p.task ?? this.specOf(p.key, view, at, view.compendium.tasks.get(p.key));
      if (spec) this.forced.set(p.key, spec);
    }
    this.rev++;
    this.poke();
    return { keys: picked.map((p) => p.key), changed: true };
  }

  /**
   * D-171 memoryWait, until nothing is left to run or `timeoutMs` passed (idle false; a running task
   * goes on). Manual mode runs the lane (never while a turn of the session runs: it waits for the
   * turn; a failure's wait and a fresh message's hold do not apply). Auto mode only waits (ruling I):
   * the lane starts its tasks itself, after a turn, a fresh message's hold or a failure's wait.
   */
  async wait(timeoutMs?: number): Promise<MemoryStatus & { idle: boolean }> {
    let timedOut = false;
    let timer: unknown = null;
    const timeout = new Promise<void>((resolve) => {
      if (timeoutMs === undefined) return;
      timer = this.ctx.timers.setTimeout(
        () => {
          timedOut = true;
          resolve();
        },
        Math.min(MAX_TIMER_MS, timeoutMs),
      );
    });
    try {
      for (let quick = 0; !this.closed && !timedOut && quick < PUMP_GUARD; ) {
        if (this.running) {
          await Promise.race([this.running.done, timeout]);
          continue;
        }
        const plan = this.plan();
        const next = plan.tasks.find((t) => this.startable(t));
        if (!next || this.recorder(plan.cfg) === null) break;
        if (this.mode === 'auto' || this.host.busy()) {
          this.pump();
          if (!this.running) await Promise.race([this.nextLook(), timeout]);
          continue;
        }
        const went = this.tryBegin(next, plan);
        if (went === 'none') break;
        quick = went === 'quick' ? quick + 1 : 0;
        this.refresh();
      }
    } finally {
      if (timer !== null) this.ctx.timers.clearTimeout(timer);
    }
    // Closed meanwhile: the journal is not read any more.
    if (this.closed) return { queued: [], parked: [], backlog: 0, idle: false };
    const status = this.status();
    const plan = this.plan();
    const runnable = this.recorder(plan.cfg) !== null && plan.tasks.some((t) => this.startable(t));
    return { ...status, idle: !timedOut && status.running === undefined && !runnable };
  }

  // ---- the derivation ---------------------------------------------------------------------------------

  /** The spec of a key named by a job row, a refile or a retry (null: its message left the path). */
  private specOf(
    key: string,
    view: PathView,
    at: ReadonlyMap<string, number>,
    state: TaskState | undefined,
    tasks: ReadonlyMap<string, LaneTask> | undefined = this.cache?.plan.derived,
  ): LaneTask | null {
    const parts = keyParts(key);
    if (parts === null || !at.has(parts.on)) return null;
    if (parts.task === 'hist') {
      const range = state?.range ?? parts.range!;
      return rangeSpan(at, range) === null ? null : { task: 'hist', key, on: parts.on, range: [range[0], range[1]] };
    }
    const derived = tasks?.get(key);
    if (derived) return derived;
    const span = state?.range ? rangeSpan(at, state.range) : null;
    const end = at.get(parts.on)!;
    // The stored row's range; else a single exchange (back to the previous answer).
    const start = span?.[0] ?? at.get(exchangeStart(view, at, parts.on))!;
    const answers = view.path.slice(start, end + 1).filter((m) => m.role === 'assistant' && !m.hidden).map((m) => m.id);
    if (!answers.includes(parts.on)) answers.push(parts.on);
    return { task: 'file', key, on: parts.on, answers, range: [view.path[start]!.id, parts.on] };
  }

  /** One look at the path (cached on the journal's last seq, the config, the seed and the lane's own state). */
  private plan(): Plan {
    const entries = this.host.entries();
    const config = this.host.currentConfig();
    const seed = this.host.library().seed;
    const stamp = `${entries.length}:${entries.at(-1)?.seq ?? 0}:${this.rev}:${this.running?.task.key ?? ''}`;
    const c = this.cache;
    if (c && c.stamp === stamp && c.config === config && c.seed === seed) return c.plan;
    const plan = this.derive(entries, config);
    this.cache = { stamp, config, seed, plan };
    return plan;
  }

  private derive(entries: readonly Entry[], config: SessionConfig): Plan {
    const cfg = resolveCompendium(config.compendium);
    const empty: Plan = { tasks: [], held: [], parked: [], backlog: 0, attempts: new Map(), derived: new Map(), answers: new Map(), cfg, on: false };
    const tree = this.host.tree();
    const moment = enableMoment(this.host.header(), entries, tree);
    if (!cfg.enabled || moment === null) return empty;
    const view = this.host.view();
    const at = indexOf(view.path);
    const answers = answersOf(view, tree, cfg.filing.wait, moment);
    const derived = new Map<string, LaneTask>();
    let backlog = 0;

    if (cfg.filing.enabled) {
      const covered = coveredIds(view, at);
      // Ruling I: an answer a stale filing row spans is debt whatever the enable moment.
      const stale = spanned(view, at, 'file:', restale);
      // Ruling K (lane#5): a split's first part recorded the whole group's end (`groupEnd`): the
      // uncovered answers after it up to that end are a task at once, after a reopen too.
      const ends = new Set<string>();
      for (const r of tree.mems) {
        if (typeof r.groupEnd !== 'string' || r.key === null || !r.key.startsWith('file:') || r.on === null || !view.pathSet.has(r.on)) continue;
        const s = view.compendium.tasks.get(r.key);
        if (s !== undefined && effective(s)) ends.add(r.groupEnd);
      }
      let run: Answer[] = [];
      const close = (): void => {
        if (run.length === 0) return;
        const last = run.at(-1)!;
        const key = `file:${last.id}`;
        derived.set(key, { task: 'file', key, on: last.id, answers: run.map((a) => a.id), range: [run[0]!.first, last.id] });
        run = [];
      };
      for (const a of answers) {
        if (!a.accepted) break;
        if (!(a.counted || stale[a.at] === 1) || a.hidden || covered.has(a.id)) {
          close();
          continue;
        }
        backlog++;
        run.push(a);
        if (run.length >= cfg.filing.everyN || this.splits.has(a.id) || ends.has(a.id)) close();
      }
      // The trailing group waits for its N answers (D-171).
    }

    // Ruling K: with no route for the recorder the due window is still derived (on a stand-in window),
    // so the lane tells what is owed and why it cannot run (recorder_unavailable, blocked); it never
    // runs on it (a run needs the route).
    const recorder = this.recorder(cfg) ?? this.standIn(cfg);
    const lastAccepted = [...answers].reverse().find((a) => a.accepted && !a.hidden);
    if (cfg.historian.interval > 0 && lastAccepted !== undefined) {
      const path: HistMessage[] = view.path.slice(0, lastAccepted.at + 1).map((m) => ({ id: m.id, role: m.role, text: messageText(m), hidden: m.hidden }));
      const tasks = new Map(view.compendium.tasks);
      // The lead's ruling G: positions before the enable moment count as covered; ruling I: except
      // where a stale historian row left a hole (it is the next window whatever the moment).
      let floor = -1;
      for (let i = 0; i < path.length && (tree.msgs.get(path[i]!.id)?.seq ?? 0) <= moment; i++) floor = i;
      if (moment > 0 && floor >= 0) {
        const holes = spanned(view, at, 'hist:', restale);
        let from = -1;
        let n = 0;
        for (let i = 0; i <= floor + 1; i++) {
          const kept = i <= floor && holes[i] !== 1;
          if (kept && from < 0) from = i;
          if (kept || from < 0) continue;
          tasks.set(`hist:#${n++}`, { seq: 0, status: 'applied', range: [path[from]!.id, path[i - 1]!.id] });
          from = -1;
        }
      }
      const due = historianDue({
        path,
        profile: recorder.profile,
        window: recorder.window,
        count: recorder.count,
        tasks,
        trimmed: newestTrim(view, tree),
        cfg: { interval: cfg.historian.interval, recapAfter: cfg.historian.recapAfter, ...(cfg.historian.overlap !== undefined ? { overlap: cfg.historian.overlap } : {}) },
      });
      if (due) {
        const key = historianKey(due);
        derived.set(key, { task: 'hist', key, on: due.toId, range: [due.newFromId, due.toId] });
      }
    }

    // The tasks asked for by name whose message is still on the path (a historian window another pass
    // covered is dropped, ruling I); while their agent is off they are held, never begun.
    const held: LaneTask[] = [];
    const named: LaneTask[] = [];
    for (const [key, t] of this.forced) {
      if (!view.pathSet.has(t.on) || (t.task === 'hist' && !derived.has(key) && histCovered(view, at, key, t.range))) this.forced.delete(key);
      else if (derived.has(key)) continue;
      else if (t.task === 'file' ? cfg.filing.enabled : cfg.historian.interval > 0) named.push(t);
      else held.push(t);
    }
    const all = new Map<string, LaneTask>();
    const order = (t: LaneTask): number => (t.task === 'file' ? (at.get(t.on) ?? 0) : view.path.length + 1);
    for (const t of [...derived.values(), ...named].sort((a, b) => order(a) - order(b))) if (!all.has(t.key)) all.set(t.key, t);

    // Parking and attempts: failures since the key's newest mem or retry row.
    const memSeq = new Map<string, number>();
    for (const r of tree.mems) if (r.key !== null) memSeq.set(r.key, r.seq);
    const failuresOf = (rows: readonly JobEntry[], key: string): JobEntry[] => {
      let reset = memSeq.get(key) ?? 0;
      for (const r of rows) if (r.state === 'retry' && r.seq > reset) reset = r.seq;
      return rows.filter((r) => r.state === 'failed' && r.seq > reset);
    };
    const attempts = new Map<string, number>();
    const parked: Parked[] = [];
    for (const [key, rows] of tree.jobs) {
      const failed = failuresOf(rows, key);
      attempts.set(key, failed.length + 1);
      const on = rows.at(-1)!.on;
      const code = failed.at(-1)?.code;
      // Ruling H/I: a task that can never fit parks at its first no_room.
      if (!view.pathSet.has(on) || !(failed.length >= cfg.maxAttempts || code === 'no_room')) continue;
      // Ruling I: a parked historian window that is no longer due (its key moved) or that another pass covered is dropped.
      if (key.startsWith('hist:') && !all.has(key)) continue;
      // Ruling K (lane#1, cli#1): so is a parked filing key whose answers are all hidden, filed by
      // another key's row or owed under another derived key (a retry would file them twice).
      if (key.startsWith('file:') && !derived.has(key)) {
        const spec = all.get(key) ?? this.specOf(key, view, at, view.compendium.tasks.get(key), derived);
        if (spec === null || (spec.task === 'file' && filedElsewhere(view, at, spec, derived))) continue;
      }
      parked.push({ key, on, failures: failed.length, ...(code !== undefined ? { code } : {}), task: all.get(key) ?? null });
    }
    const parkedKeys = new Set(parked.map((p) => p.key));
    const running = this.running?.task.key;
    const last = entries.at(-1)?.seq ?? 0;
    for (const [key, seq] of this.noRerun) if (seq !== last) this.noRerun.delete(key);
    const tasks = [...all.values()].filter((t) => !parkedKeys.has(t.key) && t.key !== running && !this.noRerun.has(t.key));
    // D-172: a starved task goes first.
    const starved = (t: LaneTask): number => (this.starved.has(preemptKey(t)) ? 1 : 0);
    tasks.sort((a, b) => starved(b) - starved(a));
    return { tasks, held, parked, backlog, attempts, derived, answers: new Map(answers.map((a) => [a.id, a])), cfg, on: true };
  }

  /** What the derivation shapes a historian window with while the recorder has no route (never a run). */
  private standIn(cfg: ResolvedCompendiumConfig): Pick<Recorder, 'window' | 'profile' | 'count'> {
    const counter = this.ctx.counter;
    return { window: DEFAULT_LOCAL_WINDOW, profile: compendiumProfile(cfg.profile, DEFAULT_LOCAL_WINDOW), count: (s) => estimateTokens(s, counter) };
  }

  /** The recorder's route, window and profile, or null (no route: the lane waits). */
  private recorder(cfg: ResolvedCompendiumConfig): Recorder | null {
    const config = this.host.currentConfig();
    const { binding, route } = resolveRecorder(this.ctx, config);
    if (route === null) return null;
    const window = contextWindow({ caps: route.caps, local: route.conn.local, ...(config.window !== undefined ? { configWindow: config.window } : {}) });
    const counter = this.ctx.counter;
    return { binding, route, window, profile: compendiumProfile(cfg.profile, window), count: (s) => estimateTokens(s, counter) };
  }

  // ---- events -------------------------------------------------------------------------------------------

  /**
   * The look's events: queued keys, idle{background}, the backlog, recorder and shared-slots notices; a
   * running task the ground left is superseded.
   */
  private refresh(): void {
    if (this.closed) return;
    const plan = this.plan();
    const r = this.running;
    if (r && !this.stillValid(r, plan.cfg)) abortWith(r.ctrl, 'superseded');
    const keys = new Set(plan.tasks.map((t) => t.key));
    for (const t of plan.tasks) {
      if (!this.announced.has(t.key)) this.host.publish({ type: 'agent', agent: t.task === 'file' ? 'filing' : 'historian', status: 'queued' });
    }
    this.announced = keys;
    const n = plan.tasks.length + (r ? 1 : 0);
    if (n !== this.told) {
      this.told = n;
      this.host.publish({ type: 'idle', background: n });
    }
    if (!plan.on) return;
    // A queue the recorder cannot run (its connection gone, its caps unresolved; ruling K: a historian
    // window counts too): told once, and the backlog notice (which blames the recorder's pace) waits
    // until it can run; nor is it told while the filing agent is paused (the circuit breaker).
    const { blocked } = this.blockedOf(plan);
    const owed = plan.tasks.length > 0 || plan.backlog > plan.cfg.filing.everyN + 3;
    if (owed && blocked?.reason === 'no_route' && this.host.firstNotice('recorder_unavailable')) {
      this.notice({ level: 'warn', code: 'recorder_unavailable', message: blocked.message });
    }
    const pace = blocked === undefined || (blocked.reason === 'paused' && blocked.agent === 'historian');
    if (pace && plan.backlog > plan.cfg.filing.everyN + 3 && this.host.firstNotice('memory_backlog')) {
      this.notice({
        level: 'warn',
        code: 'memory_backlog',
        message: `${plan.backlog} answers are waiting to be filed into the Compendium: the recorder cannot keep up. A second slot on the server, a separate connection for the recorder (roles.recorder) or a larger compendium.filing.every_n helps.`,
      });
    }
    this.slotsShared();
  }

  /** G-21: once per session, when two connections the session uses are one server (they share its places). */
  private slotsShared(): void {
    const byOrigin = new Map<string, string[]>();
    for (const conn of sessionConnections(this.ctx, this.host.currentConfig()).values()) byOrigin.set(conn.origin, [...(byOrigin.get(conn.origin) ?? []), conn.id]);
    for (const [origin, ids] of byOrigin) {
      if (ids.length < 2) continue;
      if (this.host.firstNotice('slots_shared')) {
        this.notice({
          level: 'info',
          code: 'slots_shared',
          message: `The connections ${ids.join(', ')} are one server (${origin}): they share its places (max_in_flight), so the Compendium's background work waits for turns there.`,
        });
      }
      return;
    }
  }

  private notice(n: Notice): void {
    this.host.publish({ type: 'notice', level: n.level, code: n.code, message: n.message });
  }

  private agentEvent(
    t: LaneTask,
    status: 'started' | 'preempted' | 'skipped' | 'done' | 'failed' | 'parked',
    more: { job: string; count?: number; skipped?: number; code?: string; reason?: string },
  ): void {
    this.host.publish({ type: 'agent', agent: t.task === 'file' ? 'filing' : 'historian', status, ...more });
  }

  /** A running task still stands on the path it was built from: its message is there, nothing in its range was touched since its begin, its agent is on. */
  private stillValid(r: Running, cfg: ResolvedCompendiumConfig): boolean {
    if (!cfg.enabled || (r.task.task === 'file' && !cfg.filing.enabled) || (r.task.task === 'hist' && cfg.historian.interval <= 0)) return false;
    const view = this.host.view();
    const tree = this.host.tree();
    const span = rangeSpan(indexOf(view.path), r.task.range);
    if (span === null || !view.pathSet.has(r.task.on)) return false;
    for (let i = span[0]; i <= span[1]; i++) if ((tree.touched.get(view.path[i]!.id) ?? 0) > r.beginSeq) return false;
    return !revertedAfter(tree, r.task.key, r.beginSeq);
  }

  // ---- running ------------------------------------------------------------------------------------------

  /**
   * Auto mode: start what is next while nothing runs (no task of the lane, no turn of the session, no
   * fresh user message at the head); a key whose last attempt failed waits its backoff.
   */
  private pump(): void {
    if (this.closed || this.mode !== 'auto' || this.pumping || this.host.busy()) return;
    this.pumping = true;
    try {
      for (let quick = 0; quick < PUMP_GUARD && !this.running && !this.closed; ) {
        const plan = this.plan();
        const next = plan.tasks.find((t) => !this.backoff.has(t.key) && this.startable(t));
        if (!next || this.holding(plan.cfg)) break;
        const went = this.tryBegin(next, plan);
        if (went === 'none') break;
        quick = went === 'quick' ? quick + 1 : 0;
        this.refresh();
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Ruling I: the head is a user message younger than max(idleDelaySec, 2 s), the lane holds back (a
   * `send` its `runTurn` follows: a task begun now would only be preempted). One timer per message: when
   * it fires the hold is over for that message and the lane looks again.
   */
  private holding(cfg: ResolvedCompendiumConfig): boolean {
    const tree = this.host.tree();
    const head = tree.head;
    const msg = head === null ? undefined : tree.msgs.get(head);
    if (head === null || msg?.role !== 'user' || this.released === head) return false;
    if (this.hold?.id === head) return true;
    if (this.hold) this.ctx.timers.clearTimeout(this.hold.timer);
    this.hold = null;
    const ms = Math.max(cfg.idleDelaySec, FRESH_MESSAGE_SEC) * 1000;
    const written = Date.parse(msg.ts);
    const age = Number.isFinite(written) ? Math.max(0, this.ctx.clock().getTime() - written) : 0;
    if (age >= ms) {
      this.released = head;
      return false;
    }
    const timer = this.ctx.timers.setTimeout(() => {
      if (this.hold?.id !== head) return;
      this.hold = null;
      this.released = head;
      this.poke();
    }, ms - age);
    this.hold = { id: head, timer };
    return true;
  }

  /** Ruling I (auto mode): a key's next attempt after its `attempt` failed waits 15 s × 2^(attempt − 1), at most 5 min. */
  private backOff(key: string, attempt: number): void {
    if (this.mode !== 'auto' || this.closed) return;
    this.clearBackoff(key);
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
    const timer = this.ctx.timers.setTimeout(() => {
      if (this.backoff.get(key) !== timer) return;
      this.backoff.delete(key);
      this.poke();
    }, ms);
    this.backoff.set(key, timer);
  }

  private clearBackoff(key: string): void {
    const t = this.backoff.get(key);
    if (t === undefined) return;
    this.ctx.timers.clearTimeout(t);
    this.backoff.delete(key);
  }

  private jobId(): string {
    return `j_${hex8(this.ctx.random)}`;
  }

  /**
   * One task: prepared synchronously, `job{begin}`, then the call runs (this.running) — or an outcome
   * with no call. 'none': nothing can run (no recorder route); 'quick': only the lane's own state changed
   * (a split, a task gone); 'progress': rows were written (a run started, or failed at once).
   */
  private begin(task: LaneTask, plan: Plan): 'none' | 'quick' | 'progress' {
    const rec = this.recorder(plan.cfg);
    if (rec === null) return 'none';
    const prep = this.prepare(task, plan.cfg, rec);
    if (prep.kind === 'split') {
      // Both parts are tasks at once (ruling I), each keyed by its last answer: the group's end stays one.
      this.splits.add(prep.after);
      this.splits.add(task.on);
      // Ruling K (lane#5): the first part's row records the whole group's end (a part split again keeps it).
      this.groupEnds.set(prep.after, this.groupEnds.get(task.on) ?? storedGroupEnd(this.host.tree(), this.host.view().pathSet, task.key) ?? task.on);
      // A group asked for by name splits in place: its first half under the key of its own last answer.
      const forced = this.forced.get(task.key);
      if (forced?.task === 'file') {
        const view = this.host.view();
        const cut = forced.answers.indexOf(prep.after) + 1;
        const key = `file:${prep.after}`;
        this.forced.set(key, { task: 'file', key, on: prep.after, answers: forced.answers.slice(0, cut), range: [forced.range[0], prep.after] });
        this.forced.set(task.key, { ...forced, answers: forced.answers.slice(cut), range: [exchangeStart(view, indexOf(view.path), forced.answers[cut]!), forced.on] });
      }
      this.rev++;
      return 'quick';
    }
    if (prep.kind === 'gone') {
      this.forced.delete(task.key);
      this.rev++;
      return 'quick';
    }
    const attempt = plan.attempts.get(task.key) ?? 1;
    const job = this.jobId();
    const begin = this.host.append({ t: 'job', ts: this.host.now(), job, key: task.key, task: task.task, on: task.on, state: 'begin', attempt });
    if (prep.kind === 'fail') {
      this.failed(task, job, attempt, prep.code, undefined, plan.cfg, []);
      return 'progress';
    }
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const running: Running = { task, job, attempt, ctrl: new AbortController(), beginSeq: begin.seq, waiting: true, done };
    this.running = running;
    this.rev++;
    void this.execute(running, prep, rec, plan.cfg)
      .catch((e: unknown) => {
        if (!this.closed && !running.ctrl.signal.aborted) this.broken(task, job, attempt, e, plan.cfg);
      })
      .finally(() => {
        this.running = null;
        this.rev++;
        settle();
        if (!this.closed) {
          this.refresh();
          this.pump();
        }
        this.wake();
      });
    return 'progress';
  }

  /**
   * The scheduler as a run's calls see it (sched#7): the first place given to one of them is the run's
   * `agent{started}` (until then it waits behind the idle gate or interactive work).
   */
  private tapped(r: Running): Scheduler {
    const sched = this.ctx.sched;
    const granted = (): void => {
      if (!r.waiting || this.closed || this.running !== r) return;
      r.waiting = false;
      this.agentEvent(r.task, 'started', { job: r.job });
    };
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
            if (!slot.signal.aborted) granted();
            return slot;
          },
        };
      },
    };
  }

  /** begin(), with what can go wrong outside the call: a lost lock stops the lane; a bug is a failed attempt. */
  private tryBegin(task: LaneTask, plan: Plan): 'none' | 'quick' | 'progress' {
    try {
      return this.begin(task, plan);
    } catch (e) {
      if (e instanceof SessionLockedError) {
        this.closed = true;
        return 'none';
      }
      this.broken(task, this.jobId(), plan.attempts.get(task.key) ?? 1, e, plan.cfg);
      return this.closed ? 'none' : 'progress';
    }
  }

  /**
   * A bug in a pure step or the journal failing under a task: the attempt fails ('internal'; parking
   * stops a loop of them). A lost lock (another process took the session) stops the lane instead.
   */
  private broken(task: LaneTask, job: string, attempt: number, e: unknown, cfg: ResolvedCompendiumConfig): void {
    if (e instanceof SessionLockedError) {
      this.closed = true;
      return;
    }
    try {
      if (!(this.host.tree().jobs.get(task.key) ?? []).some((j) => j.job === job && j.state === 'begin')) {
        this.host.append({ t: 'job', ts: this.host.now(), job, key: task.key, task: task.task, on: task.on, state: 'begin', attempt });
      }
      this.failed(task, job, attempt, 'internal', e instanceof Error ? e.message : String(e), cfg, []);
    } catch {
      this.closed = true;
    }
  }

  /** The request of a task, built from the path as it is now. */
  private prepare(task: LaneTask, cfg: ResolvedCompendiumConfig, rec: Recorder): Prepared {
    const view = this.host.view();
    const tree = this.host.tree();
    const seed = this.host.library().seed;
    const at = indexOf(view.path);
    if (!view.pathSet.has(task.on) || rangeSpan(at, task.range) === null) return { kind: 'gone' };
    // Ruling K (order#1): the pass stages against exactly what the fold applies before its row on the
    // head path (apply.ts foldStaged: the rows that sort before (pos(on), agent, ∞), without the key's
    // own). Its checkpoint is kept: it is the prefix the landing pass's view resumes from.
    const stage = foldStaged(tree.mems, { pathSet: view.pathSet, path: view.path.map((m) => m.id), touched: tree.touched, library: seed, msgs: tree.msgs }, { key: task.key, on: task.on });
    const capOut = tokenLimit(rec.route.caps.maxOutput) ?? Infinity;
    const bindOut = tokenLimit(rec.binding.maxTokens) ?? tokenLimit(rec.binding.samplers?.max_tokens) ?? Infinity;

    if (task.task === 'file') {
      const exchanges: FilingExchange[] = [];
      const answers = task.answers.filter((id) => at.has(id) && !view.path[at.get(id)!]!.hidden);
      for (const id of answers) {
        const i = at.get(id)!;
        let j = i;
        while (j > 0 && view.path[j - 1]!.role === 'user') j--;
        const user = view.path.slice(j, i).filter((m) => !m.hidden).map(messageText);
        exchanges.push({ user, reply: messageText(view.path[i]!) });
      }
      if (exchanges.length === 0) return { kind: 'gone' };
      const req = filingRequest({
        view: stage,
        books: seed.books,
        allow: cfg.filing.allow,
        profile: rec.profile,
        window: rec.window,
        exchanges,
        castNames: view.castNames,
        guidance: cfg.guidance,
        language: cfg.language.trim() || storyLanguage(exchanges.flatMap((e) => [...e.user, e.reply])) || '',
        count: rec.count,
      });
      if (req.kind === 'split') return { kind: 'split', after: answers[Math.ceil(answers.length / 2) - 1]! };
      if (req.kind === 'no_room') return { kind: 'fail', code: 'no_room' };
      return {
        kind: 'call',
        agent: 'filing',
        system: req.system,
        user: req.user,
        schema: req.schema,
        maxTokens: Math.max(1, Math.floor(Math.min(req.maxTokens, capOut, bindOut))),
        temperature: req.temperature,
        profile: req.profile,
        read: filingReader({ allow: cfg.filing.allow, profile: req.profile }),
        row: (value, readSkipped) => {
          const staged = stageFiling(value as FilingItem[], stage, { classic: seed.classic });
          const skippedCount = readSkipped.length + staged.skipped.length;
          const notices: Notice[] = [];
          for (const n of staged.notices) {
            if (!this.host.firstNotice(`filing_classic_conflict:${normalizeName(n.name)}`)) continue;
            const book = n.key.split(':')[1] ?? '';
            notices.push({
              level: 'info',
              code: 'filing_classic_conflict',
              message: `The filing agent did not file ${JSON.stringify(n.name)}: that name is a plain (untyped) entry of the book ${JSON.stringify(seed.books.get(book) ?? book)} (${n.key}). Give the book entry a type, or file it under another name.`,
            });
          }
          return { ops: staged.ops, skipped: capSkipped([readSkipped, staged.skipped]), skippedCount, notices };
        },
        range: task.range,
        on: task.on,
      };
    }

    const end = at.get(task.on)!;
    const path: HistMessage[] = view.path.slice(0, end + 1).map((m) => ({ id: m.id, role: m.role, text: messageText(m), hidden: m.hidden }));
    const input = { path, profile: rec.profile, window: rec.window, count: rec.count, ...(cfg.historian.overlap !== undefined ? { cfg: { overlap: cfg.historian.overlap } } : {}) };
    let w = historianWindowAt(input, task.range);
    if (w === null) return { kind: 'gone' };
    const shape = { start: w.start, newStart: w.newStart, end: w.end };
    // D-183, section J: a blank compendium.language names the story's language when its script tells it.
    const language = cfg.language.trim() || storyLanguage(w.messages.map((m) => m.text)) || '';
    const build = (messages: HistorianWindow['messages']): HistorianRequest =>
      historianRequest({ window: { ...shape, messages }, view: stage, profile: rec.profile, guidance: cfg.guidance, language });
    // Ruling I: what the prompt around the messages leaves of the window (less the answer's floor) bounds
    // their texts; historian.ts cuts them head+tail to it (same messages, same key).
    const bare = build([]);
    const budget = rec.window - (rec.count(bare.system) + rec.count(bare.user) + 2 * MESSAGE_OVERHEAD_TOKENS) - AGENT_OUTPUT_FLOOR;
    if (budget < w.tokens) w = historianWindowAt({ ...input, budget: Math.max(0, budget) }, task.range) ?? w;
    const fit = fitHistorian(w, build, rec);
    if (fit === null) return { kind: 'fail', code: 'no_room' };
    const { req, room } = fit;
    const profile = rec.profile;
    return {
      kind: 'call',
      agent: 'historian',
      system: req.system,
      user: req.user,
      schema: req.schema,
      maxTokens: Math.max(1, Math.floor(Math.min(req.maxTokens, room, capOut, bindOut))),
      temperature: req.temperature,
      profile,
      read: (raw) => readHistorianAnswer(raw, profile),
      // historianOps' skipped list holds the reader's; the read's own lines (cut_off, an extra block)
      // go first (ruling K: the row and the done event say the answer was cut). Ruling I: an answer that
      // offered summaries none of which the row holds fails the attempt (the window stays due); an answer
      // that offered none still closes it. Ruling K: one cut off that applies no summary fails too (its
      // summary may be what was cut).
      row: (value, readSkipped, cut) => {
        const answer = value as HistorianAnswer;
        const out = historianOps(answer, w, stage, profile);
        const own = new Set(answer.skipped);
        const skipped = [...readSkipped.filter((s) => !own.has(s)), ...out.skipped];
        const why = out.skipped[0] === undefined ? '' : `: ${out.skipped[0].path} ${out.skipped[0].why}`;
        const fail =
          out.applied > 0
            ? undefined
            : cut
              ? { code: 'undecodable', reason: "the historian's answer was cut off before a summary closed" }
              : out.offered > 0
                ? { code: 'invalid', reason: `every summary of the historian's answer was refused${why}` }
                : undefined;
        return { ops: out.ops, skipped: capSkipped([skipped]), skippedCount: skipped.length, notices: [], ...(fail ? { fail } : {}) };
      },
      range: [w.newFromId, w.toId],
      on: w.toId,
    };
  }

  /**
   * The call and its outcome: one mem row (with its calls' usage rows), or job{failed}, or nothing
   * (preempted; superseded, told as agent{skipped}; shutdown).
   */
  private async execute(r: Running, prep: Extract<Prepared, { kind: 'call' }>, rec: Recorder, cfg: ResolvedCompendiumConfig): Promise<void> {
    const { task, job } = r;
    const label = modelLabel(rec.route.conn.id, rec.route.model);
    const transport: Transport = chooseTransport(rec.route.caps);
    const reasoning = reasoningFor(rec.binding, rec.route.caps);
    const env: AgentCallEnv = {
      sched: this.tapped(r),
      fetch: this.ctx.fetch,
      timeouts: timeoutsFor(rec.route.conn, this.ctx.timeouts),
      timers: this.ctx.timers,
      clock: this.ctx.clock,
      random: this.ctx.random,
      ...(this.ctx.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: this.ctx.retryMaxDelayMs } : {}),
      ...(this.ctx.prices ? { prices: this.ctx.prices } : {}),
      emit: (ev) => {
        if (!this.closed) this.host.publish(ev);
      },
      onProviderError: (i) => this.ctx.onProviderError?.({ sessionId: this.host.sessionId, job, ...i }),
      ...(this.ctx.keepRequests === true ? { keepRequest: (req: ModelRequest) => this.keepRequest(req) } : {}),
    };
    const timeoutSec = cfg.filing.timeoutSec ?? (rec.route.conn.local ? FILING_TIMEOUT_LOCAL_SEC : FILING_TIMEOUT_REMOTE_SEC);
    const res: StructuredResult<unknown> = await structuredCall<unknown>({
      agent: prep.agent,
      schema: prep.schema,
      read: prep.read,
      system: prep.system,
      user: [prep.user],
      tag: null,
      route: rec.route,
      transport,
      samplers: samplersFor(rec.binding, prep.temperature),
      ...(reasoning !== undefined ? { reasoning } : {}),
      maxTokens: prep.maxTokens,
      count: rec.count,
      repair: true,
      callKeyPrefix: `${job}:${prep.agent}`,
      budgetMs: timeoutSec * 1000,
      turnSignal: r.ctrl.signal,
      env,
      priority: 'background',
      idleDelaySec: cfg.idleDelaySec,
    });
    if (this.closed) return;
    if (!res.ok && res.code === 'preempted') {
      // D-172: not an attempt; the task stays queued. Three in a row (per key for filing, per agent for
      // the historian, whose key moves with its window, ruling I): it goes first at the next pause.
      this.agentEvent(task, 'preempted', { job });
      const pk = preemptKey(task);
      const n = (this.preemptions.get(pk) ?? 0) + 1;
      this.preemptions.set(pk, n);
      if (n >= STARVED_AFTER && !this.starved.has(pk)) {
        this.starved.add(pk);
        if (this.host.firstNotice('memory_starved')) {
          this.notice({
            level: 'warn',
            code: 'memory_starved',
            message: `Turns took the Compendium's ${task.task === 'file' ? 'filing' : 'historian'} task ${task.key} away ${n} times in a row: it runs first at the next pause. A host cache or a second slot, a separate connection for the recorder (roles.recorder) or a larger compendium.filing.every_n helps.`,
          });
        }
      }
      return;
    }
    // Superseded (or shut down): nothing more is written; its key runs again while it is owed.
    if (r.ctrl.signal.aborted) {
      if (reasonOf(r.ctrl.signal) === 'superseded') this.superseded(r);
      return;
    }
    if (!res.ok) {
      if (res.code === 'transport_unsupported' && this.host.firstNotice(STRUCTURED_REFUSED_KEY)) {
        this.notice({ level: 'warn', code: 'caps.suggest', message: structuredRefusedMessage(label, prep.agent) });
      }
      this.failed(task, job, r.attempt, res.code, res.message, cfg, res.calls);
      return;
    }
    // The ground may have moved while the call ran (an edit, a hide, a head move, an undo).
    if (!this.stillValid(r, this.plan().cfg)) {
      this.superseded(r);
      return;
    }
    const row = prep.row(res.value, res.skipped, res.cutOff === true);
    if (row.fail !== undefined) {
      this.failed(task, job, r.attempt, row.fail.code, row.fail.reason, cfg, res.calls);
      return;
    }
    const view = this.host.view();
    const before = view.compendium;
    // Ruling K (lane#5): a split's first part names the whole group's end, so its rest is owed at once after a reopen too.
    const groupEnd = task.task === 'file' ? (this.groupEnds.get(task.on) ?? storedGroupEnd(this.host.tree(), view.pathSet, task.key)) : undefined;
    const written = this.host.append({
      t: 'mem',
      ts: this.host.now(),
      key: task.key,
      on: prep.on,
      by: prep.agent,
      range: prep.range,
      ops: row.ops,
      ...(groupEnd !== undefined && groupEnd !== task.on ? { groupEnd } : {}),
      ...(row.skipped.length > 0 ? { skipped: row.skipped } : {}),
      gen: { model: label, profile: prep.profile, transport, calls: res.calls.length, ms: res.attempts.reduce((n, a) => n + a.ms, 0) },
      // The calls' usage, as a turn's trace.calls rows (/usage counts the lane's agents from them).
      ...(res.calls.length > 0 ? { calls: res.calls } : {}),
    });
    this.forced.delete(task.key);
    this.settled(task);
    this.parksInRow.delete(task.task);
    this.host.publishChanges(before, this.host.view().compendium, written.seq, prep.agent, task.key);
    for (const n of row.notices) this.notice(n);
    this.agentEvent(task, 'done', { job, count: row.ops.length, skipped: row.skippedCount });
  }

  /**
   * A run the ground left (an edit, a hide, a head move, an undo, a config change): agent{skipped,
   * superseded}. One superseded before anything new was written (nothing can have changed for it) is
   * not begun again until the journal moves (a guard against a loop).
   */
  private superseded(r: Running): void {
    this.agentEvent(r.task, 'skipped', { job: r.job, reason: 'superseded' });
    const last = this.host.entries().at(-1)?.seq ?? 0;
    if (last === r.beginSeq) this.noRerun.set(r.task.key, last);
  }

  /** A completed attempt resets the task's preemption count (D-172). */
  private settled(task: LaneTask): void {
    const pk = preemptKey(task);
    this.preemptions.delete(pk);
    this.starved.delete(pk);
    this.clearBackoff(task.key);
  }

  /**
   * job{failed} (with its calls' usage rows); parked after maxAttempts of them since the key's last row
   * or retry, or at once for no_room (a task that can never fit, ruling H); else the next attempt
   * waits (auto mode, ruling I).
   */
  private failed(task: LaneTask, job: string, attempt: number, code: string, message: string | undefined, cfg: ResolvedCompendiumConfig, calls: readonly TraceCall[]): void {
    this.host.append({ t: 'job', ts: this.host.now(), job, key: task.key, task: task.task, on: task.on, state: 'failed', attempt, code, ...(calls.length > 0 ? { calls: [...calls] } : {}) });
    this.settled(task);
    this.rev++;
    this.agentEvent(task, 'failed', { job, code, ...(message !== undefined && message !== '' ? { reason: message } : {}) });
    if (attempt >= cfg.maxAttempts || code === 'no_room') {
      this.agentEvent(task, 'parked', { job, code });
      this.parkedOne(task.task);
    } else this.backOff(task.key, attempt);
  }

  /**
   * Ruling K (cli#1, the circuit breaker): when two tasks of one agent park in a row, the agent pauses —
   * no new task of it starts until memoryRetry or the next open — and memory_paused is told once.
   */
  private parkedOne(agent: 'file' | 'hist'): void {
    const n = (this.parksInRow.get(agent) ?? 0) + 1;
    this.parksInRow.set(agent, n);
    if (n < PAUSE_AFTER_PARKS || this.paused.has(agent)) return;
    this.paused.add(agent);
    this.rev++;
    if (!this.host.firstNotice(`memory_paused:${agent}`)) return;
    const name = agent === 'file' ? 'filing agent' : 'historian';
    this.notice({
      level: 'warn',
      code: 'memory_paused',
      message: `The Compendium's ${name} is paused: ${n} of its tasks in a row were parked after failing. ${pausedWords(agent)}`,
    });
  }

  /** D-164: a lane request kept as JSON (a failure to write is told once, never fails the task). */
  private keepRequest(req: ModelRequest): void {
    try {
      keepRequestFile(this.ctx.home, this.host.sessionId, req);
    } catch (e) {
      if (this.host.firstNotice('keep_requests_failed')) {
        this.notice({ level: 'warn', code: 'keep_requests_failed', message: `A request could not be kept (--keep-requests): ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
}
