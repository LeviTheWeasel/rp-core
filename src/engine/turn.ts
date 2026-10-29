// Ported from Bunraku:src/studio/scene-turn.ts (runTurn, commit)@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One turn, from `start` to its terminal event (ARCHITECTURE.md §6.2–§6.6, §7.1). Admission and
// the `turn` line happen synchronously in session.ts; this file runs the rest:
//
//   [hook beforeAssemble] → assemble (pure) → shape (pure) → `prep` (fsync) → [hook transformRequest]
//   → narrate: the tool loop (every round streamed, `chk` lines as text arrives), one retry, one fallback
//   → [hook transformReply] → commit (`msg` / `edit`, guarded by `base`) | `end`
//
// Port notes — Bunraku's turn rules, mapped onto the log: beginTurn → `turn`, the first
// saveCheckpoint → `prep`, saveCheckpoint → `chk`, commitTurn(guard) → `msg`/`edit` with `base`,
// dropTurn → `end` (a kept checkpoint on conflict → `held`, M6). Kept: Stop keeps what arrived, a
// failure drops the turn and hands back the draft, an answer in hand is never thrown away (a failed
// commit keeps the checkpoint: `commit_deferred`, D-38), the fallback only before any output and
// never after a Stop, nothing_to_add on a continue. Not ported: variables written before the send
// (they ride the commit, D-30), module-level `running`, `full` text events, committing a failed
// reply without a guard, DOMException('stopped') (typed abort reasons instead), recall, trackers,
// regex, Final Cut, the Inspector and the meter. Added: one retry of the same model before the
// fallback, the answer-in-reasoning / reasoning-only rule (D-31), `onError: 'keep'` (D-22).
//
// M1b: every caps decision reads the route's caps for its model (Route.caps = capsFor(model) ??
// conn.caps); the key is resolved per call (narrate.ts); the EMA token correction of the model is
// derived from the path and handed to assemble (D-50); leaked tool-call markup is stripped from the
// answer before it commits (step 9, D-57); one `usage` event per call carries the merged usage and
// its cost (§11: provider, else the price table, else null). The reply's max_tokens is the reserve
// the budget held back (never more, so prompt + max_tokens fits the window; capped by the model's
// caps.maxOutput too); a server that reports far fewer prompt tokens than were sent cut the prompt,
// which is told once and kept out of the EMA.
//
// M2: steps 4–5 (window, reserve, the starting view, the EMA, the session's lorebooks, assemble,
// shape) live in request.ts, shared with preview, so a preview is what the turn sends. The lore
// fires assemble puts in the trace ride `prep` and the commit (traceForSent keeps them), which is
// where fold.ts reads the timers of later turns from (§5.10).
//
// M3 (.notes/m3-decisions.md B): step 8 is the tool loop (narrate.ts narrateRounds), one per route;
// the retry and the fallback wrap the whole loop and only happen while nothing came out (in practice
// round 0). A fallback with another tool transport, or whose reasoning echo differs from the
// primary's (D-94 revised), gets its request rebuilt for itself (D-90); `prep` stays the primary's. Every
// model call has its usage event and trace.calls row (callKey `<turn>:narrator:<round>`); gen.usage
// is their sum, trace.tokens.reported round 0's (the EMA sample). Step 9 strips leaks from each text
// block of a multi-round answer (the loop already left out the spans it turned into calls, §8.3);
// tool rounds commit as interleaved blocks [§5.6]. A turn with no
// visible text at all follows the M2 empty rules and commits nothing of its tool rounds.
//
// M4 (.notes/m4-decisions.md D-101, D-104, D-106): step 3 runs the Story Director when
// director.enabled and the kind is not continue — after the beforeAssemble hook, before assemble,
// on a child signal of the turn. It never fails the turn: its record (planned, reused or failed)
// rides `prep` and the commit body (`dir`), its directive goes to depth 1, its calls to trace.calls
// and CALL_CEILING, its status to trace.agents.director. A Stop during planning ends the turn
// stopped-empty with no `dir`. A continue never plans: it re-sends the target's stored directive.
//
// M5a (.notes/m5a-decisions.md D-141, D-157, D-164): the turn reads the session's books once
// (TurnHost.library) and folds every view with their seed; the Director gets the Compendium's world
// snapshot while the Compendium is on. With EngineOptions.keepRequests every provider-level request
// of the turn (narrator rounds, the Director) is kept as JSON under <home>/sessions/<id>.requests/.
//
// M5b (.notes/m5b-decisions.md D-171): the kept-request writer is shared with the session's background
// lane (keepRequestFile), and the session hears when a turn has settled (after its terminal event), so
// the lane's events never land inside a turn's stream on the bus.
//
// RoleCall import (.notes/rcimport-decisions.md D-195, ux#2): a turn the Director would plan first
// asks whether its request can be built without the directive (cannotFit: a cheap bound, then pass A
// only when the bound does not fit); when it cannot (most often context_length_exceeded: the
// never-trimmed part is larger than the narrator's window) the turn ends there, with the refusal it
// would get after the plan, before any Director call. A turn that fits plans as before.
//
// M5c (.notes/m5c-decisions.md D-201…D-204, rulings G): recall. After the D-195 fit check (which now
// also guards a turn whose recall may call a model) the turn decides recall's part: none while the
// Compendium is off or holds no live typed entry (the M5a request, no record); the mode (recall.ts
// recallModeOf: off, lexical, sync, prefetch, auto = prefetch on a local recall origin, else sync); a
// swipe (onSwipe 'reuse', no guidance) or a continue reuses the answered message's record when it
// recalled; a guided re-roll or an onSwipe 'rerun' swipe recalls again in the turn (sync), never adopting
// a prefetch (ruling K); a sync recall runs beside the Director (Promise.allSettled; on one place of one
// origin the Director's request is queued first, sched.ts ordered); a prefetch the lane holds for this
// basis (recall.ts basisHead: the newest answer before U) is adopted, one still running (queued or in
// flight) is promoted and waited for at most graceSec (the Director runs meanwhile, unless it shares a
// local origin's single place with it: then after the wait), and a wait that ends without a selection
// falls back per onMiss (lexical: a `prefetch_missed` record, or sync) and is told once; a stored failed
// prefetch falls back with its own record and nothing told, and a basis nothing was held for falls back
// with no record (nothing was waited for, so nothing was missed). A Stop ends the wait (the prefetch runs
// on at background). A manual lane never prefetches: the mode then behaves as onMiss. The picks reach the request as the
// selector's tier 1 in recall's order with trace.compendium.source; the RecallRecord rides `prep` and
// the commit (an edit's too); its calls go to trace.calls after the Director's and to CALL_CEILING;
// trace.agents.recall says done/reused/skipped/failed. Notices: recall_index_truncated,
// prefetch_missed, recall_slow (D-204), each once per session.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCompendium } from '../agents/compendium/profile.ts';
import { missedRecord, recallPicks, reusedRecord, skippedRecord } from '../agents/compendium/recall.ts';
import { worldSnapshot } from '../agents/compendium/world.ts';
import { directiveInsert, runDirector, type DirectorAgentRow } from '../agents/director/call.ts';
import { checkRecord } from '../agents/director/state.ts';
import type { DirectorRecord } from '../agents/director/types.ts';
import { STRUCTURED_REFUSED_KEY, structuredRefusedMessage, type AgentCallEnv, type TraceCall } from '../agents/structured.ts';
import { abortableDelay, abortWith, childController, type AbortReason } from './abort.ts';
import type { TurnOutcome } from './api.ts';
import { resolveDirector, type AdmittedTurn, type Route } from './admit.ts';
import type { Connection } from './api.ts';
import { EventQueue, singleConsumer } from './bus.ts';
import { Checkpointer } from './checkpoint.ts';
import { messageViewOf, placeCommit, type Journal, type Placed } from './commit.ts';
import { isoNow, type EngineCtx } from './context.ts';
import { priceFor, usageCost } from './cost.ts';
import { truncatedByServer } from './ema.ts';
import { hookBeforeAssemble, hookTransformReply, hookTransformRequest, type HookCtx } from './hooks.ts';
import { narrateRounds, storedSeparator, sumUsage, timeoutsFor, type RoundCall, type RoundsResult, type TurnTools } from './narrate.ts';
import {
  buildRequest,
  echoRuleOf,
  maxTokensFor,
  shapeRequest,
  type AssembledOk,
  type BuiltRequest,
  type KeyedNotice,
  liveTyped,
  type RecallInput,
  type ReplyLimits,
  type RequestInput,
  type SessionLibrary,
  type Shaped,
  startView,
} from './request.ts';
import {
  basisHead,
  capacityOf,
  effectiveRecall,
  missedNotice,
  onMissOf,
  prefetchBasis,
  RECALL_INDEX_TRUNCATED,
  RECALL_SLOW,
  RECALL_SLOW_AFTER,
  RECALL_SLOW_MS,
  recallAgentRow,
  recallEvent,
  recallSetup,
  runRecall,
  slowNotice,
  truncatedNotice,
  PREFETCH_MISSED,
  type RecallHow,
  type RecallSetup,
} from './recall.ts';
import { isRetryable, modelLabel, retryDelayMs } from './route.ts';
import { ordered, type Scheduler } from './sched.ts';
import { traceForSent } from '../prompt/assemble.ts';
import { continuationResult } from '../prompt/shape.ts';
import type { DepthInsert } from '../prompt/depth.ts';
import type { Event, EventBody, Notice } from '../protocol/events.ts';
import { stripToolCallLeaks } from '../tools/leaks.ts';
import type { FinishReason, ModelRequest, ProviderError, Usage } from '../providers/types.ts';
import type { Block, Generation, RecallRecord, SessionHeader, Trace, TurnEntry } from '../session/entries.ts';
import { SessionLockedError, sessionsDir } from '../session/log.ts';
import type { MessageView, PathView } from '../session/view.ts';

/** Re-exported for session.ts: an event before the session id and timestamp are stamped on it. */
export type { EventBody };

/** What the turn needs from its session. */
export interface TurnHost extends Journal {
  readonly sessionId: string;
  header(): SessionHeader;
  view(): PathView;
  datasync(): void;
  /** True the first time a once-per-session notice code is seen (D-28 notices). */
  firstNotice(code: string): boolean;
  /** The turn is over: the session stops being busy. Called before the terminal event. */
  turnEnded(run: TurnRun): void;
  /** Keep a conflicted answer pending for an explicit client decision. */
  turnHeld(turnId: string): void;
  /**
   * M5b: called after the terminal event (the turn's stream has ended), for what follows a turn without
   * being part of it: the background lane's next look at its work (D-171).
   */
  turnSettled?(run: TurnRun): void;
  /** M5a (D-141): the session's books and the Compendium's seed view() was folded with. */
  library(): SessionLibrary;
  /**
   * M5c (D-202): what the session's lane holds for a prefetch basis (recall.ts prefetchBasis): its
   * stored record, or the run still queued or in flight; null when it holds neither. Absent: no lane.
   */
  prefetchFor?(basis: string): PrefetchLook | null;
  /** M5c (D-204): a session-level tally (recall_slow): adds one under `key` and returns the new count. */
  tally?(key: string): number;
}

/** M5c (D-202, D-203): a prefetch run the turn may wait for (lane.ts). */
export interface RunningPrefetch {
  /** Its record, or null when it ends without one (superseded, preempted, shut down). */
  done: Promise<RecallRecord | null>;
  /** Interactive and never preempted while the turn waits (sched.ts boost). */
  promote(): void;
  /** Back to background (a Stop: it runs on for the next turn). */
  demote(): void;
  /** Aborted as superseded (it came too late). */
  supersede(): void;
}

/** M5c: what the lane holds for one prefetch basis. */
export interface PrefetchLook {
  record?: RecallRecord;
  running?: RunningPrefetch;
}

/**
 * M5c (D-201…D-203): recall's part of a turn, decided before any call. `none`: the Compendium is off or
 * has no live typed entry (the M5a request, nothing recorded). `set`: decided without a call (off,
 * lexical, a reuse, a stored prefetch, a skip, a miss to lexical). `sync`: a recall call beside the
 * Director. `wait`: a prefetch still running, promoted and waited for.
 */
type RecallPlan =
  | { kind: 'none' }
  | { kind: 'set'; input: RecallInput; record?: RecallRecord; how?: RecallHow }
  | { kind: 'sync'; setup: RecallSetup; route: Route }
  | { kind: 'wait'; setup: RecallSetup; route: Route; look: RunningPrefetch; onMiss: 'lexical' | 'sync'; head: string };

/** D-164: where a session's kept requests go. */
export function requestsDir(home: string, sessionId: string): string {
  return join(sessionsDir(home), `${sessionId}.requests`);
}

/**
 * D-164: a call key as a file name: every character outside [A-Za-z0-9._-] becomes '_'. The n-th
 * request under one call key (a retry, a fallback's round 0) gets `-n` before `.json` (n ≥ 2).
 */
export const requestFileName = (callKey: string, n = 1): string => `${callKey.replace(/[^A-Za-z0-9._-]/g, '_')}${n > 1 ? `-${n}` : ''}.json`;

/**
 * D-164: writes one provider-level request as JSON under <home>/sessions/<id>.requests/ (see
 * TurnRun.keepRequest); shared with the background lane (M5b). Throws when it cannot be written.
 */
export function keepRequestFile(home: string, sessionId: string, req: ModelRequest): void {
  const { signal: _signal, ...rest } = req;
  const body = { ...rest, messages: rest.messages.map(({ replay: _replay, ...m }) => m) };
  const dir = requestsDir(home, sessionId);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(body, null, 2)}\n`;
  for (let n = 1; ; n++) {
    try {
      writeFileSync(join(dir, requestFileName(req.callKey, n)), text, { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

type Category = string;
interface Ending {
  outcome: TurnOutcome;
  terminal: EventBody;
}

type BuiltOk = Extract<BuiltRequest, { ok: true }>;

/** One route's request: the primary's, a reshaped copy for a fallback, or a fallback's own (D-90). */
interface Leg {
  route: Route;
  asm: AssembledOk;
  shaped: Shaped;
  tools: TurnTools | null;
  reserve: number;
  limits: ReplyLimits;
}

/** What the routed narration came to. */
interface Narrated {
  res: RoundsResult;
  active: Route;
  /** The request the answer came from (the primary's, or the fallback's own). */
  asm: AssembledOk;
  shaped: Shaped;
  tools: TurnTools | null;
  route: NonNullable<Generation['route']>;
  calls: Trace['calls'];
}

/** Two echo rules (request.ts echoRuleOf) are the same: both off, or the same connection and model. */
function sameEcho(a: { connection: string; model: string } | null, b: { connection: string; model: string } | null): boolean {
  return a === null || b === null ? a === b : a.connection === b.connection && a.model === b.model;
}

/** A loop that never ran (stopped while waiting to retry). */
function stoppedRounds(): RoundsResult {
  return { blocks: [], text: '', reasoning: '', rounds: 0, ended: 'stopped', stopped: true, output: false, ms: 0, toolRows: [], roomLeft: 0 };
}

const isToolBlock = (b: Block): boolean => b.k === 'tool_call' || b.k === 'tool_result';

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** reasoning block(s) first, then one text block (§5.4: reasoning is never glued into the text). */
function answerBlocks(text: string, reasoning: string): Block[] {
  return reasoning.trim() !== '' ? [{ k: 'reasoning', text: reasoning }, { k: 'text', text }] : [{ k: 'text', text }];
}

export class TurnRun {
  readonly entry: TurnEntry;
  readonly ctrl = new AbortController();
  readonly events: AsyncIterable<Event>;
  readonly result: Promise<TurnOutcome>;
  private readonly queue = new EventQueue<Event>();
  private resolveResult!: (o: TurnOutcome) => void;
  private readonly chk: Checkpointer;
  private readonly hookCtx: HookCtx;
  private readonly t0: number;
  /** Everything streamed this turn (a retry only happens before any output, so attempts never mix). */
  private text = '';
  private reasoning = '';
  /**
   * The streamed text after post-processing (§6.2 step 9): what commits and what a draft hands back.
   * null until the stream is over; the text events already sent may still show what was removed.
   */
  private answer: string | null = null;
  /** M3: a multi-round answer's blocks after step 9 (null: one round, committed as M2 did). */
  private roundBlocks: Block[] | null = null;
  /** The answer is in hand and being written: a failure now must keep the checkpoint (D-38). */
  private committing = false;
  private ended = false;
  /** traceForSent of the last shaped request: counted once, reused by the server check and the commit. */
  private sentCache: { messages: readonly unknown[]; prefill: string | undefined; tools: TurnTools | null; trace: Trace } | null = null;
  /** M4: the Director's record of this turn (prep and the commit body), when it ran or reused a plan. */
  private dir: DirectorRecord | undefined;
  /** M4: the Director's model calls (trace.calls rows; they count toward CALL_CEILING). */
  private dirCalls: TraceCall[] = [];
  /** M4: trace.agents.director; undefined while the Director is off. */
  private dirAgent: DirectorAgentRow | { status: 'skipped' } | undefined;
  /** M4: the view at U the Director planned from (request.ts startView); D-195: folded before the fit check. */
  private dirView: PathView | undefined;
  /** M5a: the session's books for this turn (read once, at the start). */
  private lib: SessionLibrary | undefined;
  /** M5c: recall's plan for this turn (body decides it after the hook, before the fit check). */
  private recallPlan: RecallPlan = { kind: 'none' };
  /** M5c (D-200): the turn's RecallRecord (prep and the commit), when recall ran, was reused or a prefetch missed. */
  private recallRec: RecallRecord | undefined;
  /** M5c: the sync recall's model calls (trace.calls after the Director's; they count toward CALL_CEILING). */
  private recallCalls: TraceCall[] = [];
  /** M5c: trace.agents.recall; undefined without a record. */
  private recallAgent: Trace['agents'][string] | undefined;
  /** M5c (D-203): the request's tier 1 and trace.compendium.source; undefined: the M5a request. */
  private recallInput: RecallInput | undefined;
  /** D-164: keeps each provider request when EngineOptions.keepRequests is on. */
  private readonly keep: ((req: ModelRequest) => void) | undefined;

  constructor(
    private readonly host: TurnHost,
    private readonly ctx: EngineCtx,
    readonly plan: AdmittedTurn,
    entry: TurnEntry,
  ) {
    this.entry = entry;
    this.t0 = ctx.clock().getTime();
    this.events = singleConsumer(this.queue);
    this.result = new Promise<TurnOutcome>((resolve) => (this.resolveResult = resolve));
    this.chk = new Checkpointer(
      (text) => void host.append({ t: 'chk', turn: entry.turn, text }, { durable: false }),
      () => host.datasync(),
      ctx.checkpoint,
      ctx.timers,
    );
    this.hookCtx = { sessionId: host.sessionId, turnId: entry.turn, kind: entry.kind, signal: this.ctrl.signal };
    this.keep = ctx.keepRequests === true ? (req) => this.keepRequest(req) : undefined;
  }

  /** The session's books, read once per turn (the Director, the request and a fallback's share them). */
  private library(): SessionLibrary {
    return (this.lib ??= this.host.library());
  }

  /**
   * D-164: one provider-level request (the ModelRequest the provider gets, not the HTTP body it then
   * builds) as JSON under <home>/sessions/<id>.requests/, without the abort signal and without the
   * messages' `replay` payloads (provider data kept in memory only, §8.6); headers and keys are never
   * in it. A call key that comes again never overwrites: the file is created exclusively, and a taken
   * name moves on to `-2`, `-3`… A failure to write is told once and never touches the turn.
   */
  private keepRequest(req: ModelRequest): void {
    try {
      keepRequestFile(this.ctx.home, this.host.sessionId, req);
    } catch (e) {
      if (this.host.firstNotice('keep_requests_failed')) {
        this.notice({ level: 'warn', code: 'keep_requests_failed', message: `A request could not be kept (--keep-requests): ${errMessage(e)}` });
      }
    }
  }

  get turnId(): string {
    return this.entry.turn;
  }

  /** Stop (§6.5). Shutdown is a stop too: text already streamed is kept as 'stopped'. */
  stop(reason: Extract<AbortReason, 'user_stop' | 'shutdown'> = 'user_stop'): void {
    abortWith(this.ctrl, reason);
  }

  /** Stamp and deliver an event: to this turn's stream and to engine.events(). */
  emit(body: EventBody): void {
    const ev = { sessionId: this.host.sessionId, ts: isoNow(this.ctx), ...body } as Event;
    this.queue.push(ev);
    this.ctx.bus.publish(ev);
  }

  /** Runs the turn to its end. Never rejects: every outcome is an event and a TurnOutcome. */
  async run(): Promise<void> {
    let ending: Ending;
    try {
      ending = await this.body();
    } catch (e) {
      ending = this.crashed(e);
    }
    this.finish(ending);
  }

  // ---- the steps ------------------------------------------------------------------------------

  private async body(): Promise<Ending> {
    const { plan } = this;
    const hooked = await hookBeforeAssemble(this.ctx.hooks, this.hookCtx);
    if (this.ctrl.signal.aborted) return this.stoppedEmpty();
    // M5c (D-201…D-203): recall's part, decided before any call (nothing is told or written yet).
    this.recallPlan = this.decideRecall();
    const recalls = this.recallPlan.kind === 'sync' || this.recallPlan.kind === 'wait';
    // D-195 (ux#2): a request that cannot be built is refused before the Director's model calls, and
    // (M5c) before recall's: no recall call, no prefetch waited for.
    if (this.plans() || recalls) {
      this.dirView ??= startView(this.host.header(), this.host.tree(), this.host.view(), plan.upTo, this.library().seed);
      const refused = this.cannotFit(hooked);
      if (refused) {
        this.keyedNotices(refused.notices);
        return this.failEarly('request', refused.code, refused.message);
      }
    }
    // Step 3 (M4): the Director plans before assemble, and (M5c) recall picks beside it; a Stop
    // meanwhile ends the turn like one above.
    const directed = await this.agents();
    if (this.ctrl.signal.aborted) return this.stoppedEmpty();
    const placements = directed.length > 0 ? [...hooked, ...directed] : hooked;

    // Steps 4–5: assemble and shape for the primary model (request.ts, the same function preview runs).
    const request = this.requestInput(placements);
    const built = buildRequest(request);
    this.keyedNotices(built.notices);
    if (!built.ok) return this.failEarly('request', built.code, built.message);
    const { asm, shaped, window } = built;
    const primary = plan.primary;

    // Step 6: `prep`, durable, before anything is sent. vars ride the commit, not this line's
    // application: a turn that never commits changes no variable (D-30).
    const vars = asm.varsDiff;
    this.host.append({
      t: 'prep',
      turn: this.entry.turn,
      ...(this.dir ? { dir: this.dir } : {}),
      ...(this.recallRec ? { recall: this.recallRec } : {}),
      trace: this.withAgents(this.sentTrace(asm, shaped, built.tools)),
      // Recovery has nothing else to name the model of an interrupted answer by.
      model: { connection: primary.conn.id, model: primary.model },
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(shaped.cont ? { cont: shaped.cont } : {}),
      ...(shaped.prefill !== undefined && plan.kind !== 'continue' ? { prefill: shaped.prefill } : {}),
    });
    if (shaped.prefill !== undefined && plan.kind !== 'continue') {
      this.emit({ type: 'prefill', turnId: this.entry.turn, text: shaped.prefill });
    }
    if (plan.fallbackMissing && this.host.firstNotice('fallback_unavailable')) {
      this.notice({
        level: 'warn',
        code: 'fallback_unavailable',
        message: `The narrator's fallback ${plan.fallbackMissing} names an unknown connection; there is no fallback this turn.`,
      });
    }
    if (built.tools && plan.roundsClamped !== undefined && this.host.firstNotice('tool_rounds_clamped')) {
      this.notice({
        level: 'warn',
        code: 'tool_rounds_clamped',
        message: `narrator.maxRounds is ${plan.roundsClamped}; a turn runs at most ${plan.maxRounds} tool rounds, so ${plan.maxRounds} are used.`,
      });
    }

    // Step 7: the host's transformRequest gate, after `prep` (M9; a pass-through now).
    shaped.messages = await hookTransformRequest(this.ctx.hooks, shaped.messages, this.hookCtx);

    // Step 8: narrate — the tool loop (§7.1), with one retry and one fallback around it.
    const narrated = await this.narrate(request, built);
    // Every byte that arrived goes to a chk before anything can commit or crash (§6.2 step 8).
    this.chk.flush();
    const { res } = narrated;
    this.checkServerWindow(narrated, window);
    // Step 9: post-processing, before anything commits or is handed back.
    this.postProcess(res);
    if (res.tailError) {
      this.notice({
        level: 'warn',
        code: 'stream_tail_failed',
        message: `The answer was complete, but the stream failed after it (${res.tailError.code}); it is kept, its usage may be missing.`,
      });
    }
    if (res.stopped) return this.onStopped(narrated);
    if (res.error) return this.onFailure(narrated, res.error);
    return this.onFinished(narrated);
  }

  /**
   * traceForSent for what this request sends, the prefill included (an EMA sample compares the
   * estimate with the prompt tokens the server counted, and a continue's prefill is the whole answer
   * so far), and the native tool declarations (the server counts them as prompt too). Cached on the
   * shaped messages: the prep line, the server check and the commit share one count of a long chat
   * instead of three.
   */
  private sentTrace(asm: AssembledOk, shaped: Shaped, tools: TurnTools | null): Trace {
    const c = this.sentCache;
    if (c && c.messages === shaped.messages && c.prefill === shaped.prefill && c.tools === tools) return c.trace;
    const trace = traceForSent(asm.trace, shaped.messages, shaped.prefill, tools?.transport === 'native' ? tools.specs : undefined);
    this.sentCache = { messages: shaped.messages, prefill: shaped.prefill, tools, trace };
    return trace;
  }

  /** The request of this turn with these inserts (steps 4–5; the D-195 check before the Director too). */
  private requestInput(placements: DepthInsert[]): RequestInput {
    return {
      home: this.ctx.home,
      sessionId: this.host.sessionId,
      header: this.host.header(),
      tree: this.host.tree(),
      // The view the Director read (folded at U on a swipe), so the request does not fold it again.
      view: this.dirView ?? this.host.view(),
      library: this.library(),
      plan: this.plan,
      seed: this.entry.seed,
      now: this.entry.now,
      timeZone: this.ctx.timeZone,
      counter: this.ctx.counter,
      placements,
      ...(this.ctx.toolSets ? { toolSets: this.ctx.toolSets } : {}),
      ...(this.recallInput ? { recall: this.recallInput } : {}),
    };
  }

  /**
   * D-195 (ux#2): the refusal this turn's request gets without the Director's directive, or null when
   * it can be built. The directive only adds to the never-trimmed part, so a request that cannot be
   * built without it cannot be built with it. The cheap bound first (request.ts fitCheck): when it
   * fits, so does the request, at a fraction of an assemble; only when it does not is pass A of the
   * request itself built, whose refusal is the one the turn gives below.
   */
  private cannotFit(placements: DepthInsert[]): Extract<BuiltRequest, { ok: false }> | null {
    const input = this.requestInput(placements);
    if (buildRequest({ ...input, fitCheck: 'bound' }).ok) return null;
    const exact = buildRequest({ ...input, fitCheck: 'exact' });
    return exact.ok ? null : exact;
  }

  /** The Director runs runDirector this turn (on, and not a continue): it may call its model. */
  private plans(): boolean {
    return this.plan.config.director?.enabled === true && this.plan.kind !== 'continue';
  }

  // ---- M5c: recall (D-201…D-204) --------------------------------------------------------------------

  /** The view the request (and the Director, and recall) reads: folded at U on a swipe (request.ts startView). */
  private turnView(): PathView {
    return (this.dirView ??= startView(this.host.header(), this.host.tree(), this.host.view(), this.plan.upTo, this.library().seed));
  }

  /**
   * D-201…D-203: recall's part of this turn, decided before any call and without telling anything
   * (the fit check may still refuse the turn). Order: the Compendium and its live typed entries; the
   * mode (off, lexical); a swipe's or continue's reuse; the route; a re-roll's recall; sync, or the
   * prefetch the lane holds for this turn's basis (the newest answer before U; a continue's target).
   */
  private decideRecall(): RecallPlan {
    const { plan } = this;
    const setup = recallSetup(this.ctx, plan.config);
    if (setup === null) return { kind: 'none' };
    const view = this.turnView();
    if (liveTyped(view.compendium).length === 0) return { kind: 'none' };
    if (setup.mode === 'off' || setup.mode === 'lexical') return { kind: 'set', input: { picks: [], source: setup.mode } };
    const tree = this.host.tree();
    // D-203: a swipe (onSwipe 'reuse', not a guided re-roll) or a continue reuses the answered message's
    // record when it recalled; a failed, skipped or absent one runs per mode.
    const swipeReuses = plan.kind === 'swipe' && setup.cfg.recall.onSwipe === 'reuse' && (plan.guidance === undefined || plan.guidance.trim() === '');
    if ((swipeReuses || plan.kind === 'continue') && plan.target !== undefined) {
      const reused = reusedRecord(effectiveRecall(tree, plan.target), plan.target);
      if (reused !== null) return { kind: 'set', input: { picks: recallPicks(reused), source: 'reused' }, record: reused, how: 'reused' };
    }
    const route = setup.route;
    if (route === null) {
      const rec = skippedRecord({ profile: setup.profile, code: 'no_connection', model: setup.label });
      return { kind: 'set', input: { picks: [], source: rec.source }, record: rec, how: 'sync' };
    }
    // D-203 and ruling K: a guided re-roll or an onSwipe 'rerun' swipe recalls again, in the turn, whatever
    // the mode: the prefetch of its basis is the one the version it replaces read (it never saw U).
    if (plan.kind === 'swipe' && !swipeReuses) return { kind: 'sync', setup, route };
    const prefetching = setup.mode === 'prefetch' || (setup.mode === 'auto' && setup.local);
    if (!prefetching) return { kind: 'sync', setup, route };
    const onMiss = onMissOf(setup);
    /** onMiss with nothing recorded and nothing told (no prefetch was waited for, so none was missed). */
    const fallBack = (): RecallPlan => (onMiss === 'sync' ? { kind: 'sync', setup, route } : { kind: 'set', input: { picks: [], source: 'lexical' } });
    // D-201: a manual lane (tests, a one-shot command) never prefetches: the mode behaves as onMiss.
    if (this.ctx.lane !== 'auto' || this.host.prefetchFor === undefined) return fallBack();
    // D-202 and ruling K: the prefetch was computed after the newest answer before U, the player's
    // messages stacked under it skipped (a continue: after the target).
    const head = plan.kind === 'continue' ? plan.upTo : basisHead(tree, tree.msgs.get(plan.upTo)?.parent ?? null);
    const look = head === null ? null : this.host.prefetchFor(prefetchBasis(setup, view, tree, head));
    const stored = look?.record;
    if (stored !== undefined && stored.status !== 'failed') {
      return { kind: 'set', input: { picks: recallPicks(stored), source: stored.source }, record: stored, how: 'adopted' };
    }
    if (look?.running !== undefined && head !== null) return { kind: 'wait', setup, route, look: look.running, onMiss, head };
    // Ruling K: a prefetch that failed is a fallback with its own record (its code; its calls count in
    // /usage) and nothing told; with onMiss sync the turn's recall replaces it.
    if (stored !== undefined && onMiss === 'lexical') return { kind: 'set', input: { picks: [], source: stored.source }, record: stored, how: 'adopted' };
    // Nothing held for the basis (no answer before U, a prefetch never begun, a session just opened).
    return fallBack();
  }

  /** Step 3 with M5c: the Director's inserts, recall's part carried out beside it (D-203). */
  private async agents(): Promise<DepthInsert[]> {
    const r = this.recallPlan;
    switch (r.kind) {
      case 'none':
        return this.direct();
      case 'set':
        this.recalled(r.input, r.record, r.how);
        return this.direct();
      case 'sync':
        return this.alongside(r.setup, r.route);
      case 'wait':
        return this.graceWait(r);
    }
  }

  /** The Director's route when it will call this turn (on, not a continue), else null. */
  private directorRoute(): Route | null {
    if (!this.plans()) return null;
    return resolveDirector(this.ctx, this.plan.config, this.plan).route;
  }

  /**
   * D-203 and ruling K: the Director calls this turn on recall's origin, and that origin has a single
   * place (the smaller of the two routes' capacities, as their calls will ask for it). Only then do the
   * two contend: the Director's request goes first, and a grace wait on a local origin holds it back.
   */
  private sharesOnePlace(route: Route): boolean {
    const dir = this.directorRoute();
    if (dir === null || dir.conn.origin !== route.conn.origin) return false;
    return this.ctx.sched.forOrigin(route.conn.origin, Math.min(capacityOf(dir.caps), capacityOf(route.caps))).capacity === 1;
  }

  /**
   * D-203: a sync recall beside the Director (Promise.allSettled). On one place of one origin the
   * Director's request is queued first (sched.ts ordered: recall's waits until the Director's is queued,
   * or until its work ends without a call); otherwise both ask at once (ruling K: two places, or two
   * origins, never wait for the Director's work before its request, a key command say).
   */
  private async alongside(setup: RecallSetup, route: Route): Promise<DepthInsert[]> {
    const order = this.sharesOnePlace(route) ? ordered(this.ctx.sched) : null;
    const planned = this.direct(order?.first).finally(() => order?.open());
    const recalled = this.syncRecall(setup, route, order?.second);
    const [a, b] = await Promise.allSettled([planned, recalled]);
    if (a.status === 'rejected') throw a.reason;
    if (b.status === 'rejected') throw b.reason;
    return a.value;
  }

  /**
   * D-202/D-203: the prefetch for this basis is still queued or in flight: promoted (interactive, never
   * preempted) and waited for at most graceSec — the Director meanwhile, unless it shares a local
   * origin's single place with the prefetch (ruling K): then after the wait. In time: adopted. Late:
   * superseded, a miss (onMiss), told. A failed record: a fallback, not told. A Stop ends the wait and
   * demotes it: it runs on at background and serves the next reply to the same U.
   */
  private async graceWait(r: Extract<RecallPlan, { kind: 'wait' }>): Promise<DepthInsert[]> {
    const { setup, route, look } = r;
    look.promote();
    const graceSec = setup.cfg.recall.graceSec;
    const waited = this.waitFor(look.done, Math.round(graceSec * 1000));
    /** What the wait came to: adopted or missed to lexical (done), a sync recall still owed, or a Stop. */
    const after = async (): Promise<'done' | 'sync' | 'stopped'> => {
      const got = await waited;
      if (got === 'stopped') {
        look.demote();
        return 'stopped';
      }
      if (got === 'late') look.supersede();
      const rec = got === 'late' ? null : got.rec;
      if (rec !== null && rec.status !== 'failed') {
        this.recalled({ picks: recallPicks(rec), source: rec.source }, rec, 'adopted');
        return 'done';
      }
      if (rec === null) this.tellMissed(graceSec, got === 'late');
      if (r.onMiss === 'sync') return 'sync';
      const fallback = rec ?? missedRecord({ profile: setup.profile, basis: r.head });
      this.recalled({ picks: [], source: fallback.source }, fallback, 'adopted');
      return 'done';
    };
    const shared = this.sharesOnePlace(route);
    if (setup.local && shared) {
      const next = await after();
      if (next === 'stopped') return [];
      return next === 'sync' ? this.alongside(setup, route) : this.direct();
    }
    // The Director plans while the turn waits; a sync recall owed by a miss runs after the wait, its
    // request behind the Director's on one place (ruling K, as alongside orders it).
    const order = shared ? ordered(this.ctx.sched) : null;
    const planned = this.direct(order?.first).finally(() => order?.open());
    const recalled = (async (): Promise<void> => {
      if ((await after()) === 'sync') await this.syncRecall(setup, route, order?.second);
    })();
    const [a, b] = await Promise.allSettled([planned, recalled]);
    if (a.status === 'rejected') throw a.reason;
    if (b.status === 'rejected') throw b.reason;
    return a.value;
  }

  /** At most `ms` for a prefetch's record: {rec} (null: it ended without one), 'late', or 'stopped' (the turn's Stop). */
  private async waitFor(done: Promise<RecallRecord | null>, ms: number): Promise<{ rec: RecallRecord | null } | 'late' | 'stopped'> {
    const ctrl = childController(this.ctrl.signal);
    try {
      return await Promise.race([
        done.then((rec) => ({ rec })),
        abortableDelay(ms, ctrl.signal, this.ctx.timers).then(
          () => 'late' as const,
          () => (this.ctrl.signal.aborted ? ('stopped' as const) : ('late' as const)),
        ),
      ]);
    } finally {
      // The grace timer goes with the wait.
      abortWith(ctrl, 'superseded');
    }
  }

  /** D-203: recall in the turn, at interactive priority, on the fold the request reads; its record decides the request's tier 1. */
  private async syncRecall(setup: RecallSetup, route: Route, sched?: Scheduler): Promise<void> {
    const turnId = this.entry.turn;
    const ctrl = childController(this.ctrl.signal);
    const res = await runRecall({
      setup,
      route,
      view: this.turnView(),
      tree: this.host.tree(),
      upTo: this.plan.upTo,
      prefetch: false,
      counter: this.ctx.counter,
      env: this.agentEnv(route.conn, sched),
      signal: ctrl.signal,
      callKeyPrefix: `${turnId}:recall`,
      priority: 'interactive',
      onGrant: () => this.emit({ type: 'agent', agent: 'recall', turnId, status: 'started', source: 'sync' }),
    });
    this.recallCalls = res.calls;
    if (res.truncated && this.host.firstNotice(RECALL_INDEX_TRUNCATED)) this.notice(truncatedNotice(res.omitted, setup.profile, setup.label));
    if (res.refused && this.host.firstNotice(STRUCTURED_REFUSED_KEY)) {
      this.notice({ level: 'warn', code: 'caps.suggest', message: structuredRefusedMessage(setup.label, 'recall') });
    }
    // D-204: recall_slow once per session, after RECALL_SLOW_AFTER sync recalls slower than RECALL_SLOW_MS.
    const ms = res.record.ms ?? 0;
    if (res.record.calls > 0 && ms > RECALL_SLOW_MS && this.host.tally !== undefined) {
      const n = this.host.tally(RECALL_SLOW);
      if (n >= RECALL_SLOW_AFTER && this.host.firstNotice(RECALL_SLOW)) this.notice(slowNotice(n, ms, setup.label));
    }
    // A Stop during the call: the turn ends stopped-empty and writes nothing (body checks the signal).
    if (this.ctrl.signal.aborted) return;
    this.recalled({ picks: recallPicks(res.record), source: res.record.source }, res.record, 'sync');
  }

  /** recall's part is settled: the request's tier 1 and source; with a record, prep/commit, trace.agents.recall and the event. */
  private recalled(input: RecallInput, record?: RecallRecord, how?: RecallHow): void {
    this.recallInput = input;
    if (record === undefined) return;
    this.recallRec = record;
    this.recallAgent = recallAgentRow(record);
    this.emit({ ...recallEvent(record, how ?? 'sync'), turnId: this.entry.turn });
  }

  /** D-204 and ruling K: the turn waited for a prefetch and went on without its selection (once per session). */
  private tellMissed(graceSec: number, late: boolean): void {
    if (this.host.firstNotice(PREFETCH_MISSED)) this.notice(missedNotice(graceSec, late));
  }

  /**
   * Step 3 (M4, D-101 / D-104): the Director's inserts for this turn. Off: none, nothing recorded. A
   * continue never plans: the target's stored directive is sent again (trace status 'skipped'). Else
   * runDirector on the Director's route (no route → a no_connection record, never a refusal).
   */
  private async direct(sched: Scheduler = this.ctx.sched): Promise<DepthInsert[]> {
    const { plan } = this;
    if (plan.config.director?.enabled !== true) return [];
    const tree = this.host.tree();
    if (plan.kind === 'continue') {
      this.dirAgent = { status: 'skipped' };
      const target = plan.target === undefined ? undefined : tree.msgs.get(plan.target);
      return directiveInsert(checkRecord(target?.dir)?.directive);
    }
    const header = this.host.header();
    const { binding, route } = resolveDirector(this.ctx, plan.config, plan);
    const turnId = this.entry.turn;
    const ctrl = childController(this.ctrl.signal);
    const persona = header.cast.persona;
    const env = this.agentEnv(route?.conn ?? plan.primary.conn, sched);
    // The view body() folded for the D-195 check: the Director plans from what the request reads.
    const view = (this.dirView ??= startView(header, tree, this.host.view(), plan.upTo, this.library().seed));
    const run = await runDirector({
      tree,
      view,
      upTo: plan.upTo,
      kind: plan.kind,
      ...(plan.target !== undefined ? { replaced: plan.target } : {}),
      ...(plan.guidance !== undefined ? { guidance: plan.guidance } : {}),
      config: plan.config,
      ...(persona ? { persona: { name: persona.name, description: persona.description, ...(persona.aliases ? { aliases: persona.aliases } : {}) } } : {}),
      charName: header.cast.character.name,
      // D-157: the Compendium's characters and places, while the Compendium is on.
      ...(resolveCompendium(plan.config.compendium).enabled ? { worldSnapshot } : {}),
      route,
      binding,
      counter: this.ctx.counter,
      turnId,
      turnSignal: ctrl.signal,
      env,
      emit: (ev) => this.emit({ type: 'director', turnId, ...ev }),
      notice: (key, n) => {
        if (this.host.firstNotice(key)) this.notice(n);
      },
    });
    this.dir = run.record;
    this.dirCalls = run.calls;
    this.dirAgent = run.agent;
    return directiveInsert(run.record.directive);
  }

  /** An agent's call env on this turn (the Director's, recall's): the engine's parts, this turn's events and kept requests. */
  private agentEnv(conn: Connection, sched: Scheduler = this.ctx.sched): AgentCallEnv {
    const turnId = this.entry.turn;
    return {
      sched,
      fetch: this.ctx.fetch,
      timeouts: timeoutsFor(conn, this.ctx.timeouts),
      timers: this.ctx.timers,
      clock: this.ctx.clock,
      random: this.ctx.random,
      ...(this.ctx.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: this.ctx.retryMaxDelayMs } : {}),
      ...(this.ctx.prices ? { prices: this.ctx.prices } : {}),
      emit: (ev) => this.emit(ev),
      onProviderError: (info) => this.ctx.onProviderError?.({ sessionId: this.host.sessionId, turnId, ...info }),
      ...(this.keep ? { keepRequest: this.keep } : {}),
    };
  }

  /**
   * A trace with the agents' calls before the narrator's — the Director's, then recall's (M5c) — and
   * their trace.agents rows (as is while both are off). Generalises M4's withDirector.
   */
  private withAgents(trace: Trace): Trace {
    if (this.dirAgent === undefined && this.recallAgent === undefined) return trace;
    return {
      ...trace,
      calls: [...this.dirCalls, ...this.recallCalls, ...trace.calls],
      agents: {
        ...trace.agents,
        ...(this.dirAgent !== undefined ? { director: this.dirAgent } : {}),
        ...(this.recallAgent !== undefined ? { recall: this.recallAgent } : {}),
      },
    };
  }

  /** Shape (pure) for a fallback route's caps; its notices keep the once-per-session rule. */
  private shapeFor(route: Route, asm: AssembledOk): Shaped {
    const out = shapeRequest(route, asm, this.plan, this.host.header().cast);
    this.keyedNotices(out.notices);
    return out.shaped;
  }

  /**
   * The fallback's request (§6.6, D-90): reshaped from the primary's when the tool transport and the
   * reasoning echo are the same; rebuilt for the fallback (same view, seed and clock) when the
   * transport differs, or when the request offers tools and the two routes' echo rules differ (D-94
   * revised: the history must carry the echoing model's own reasoning, and another model's never,
   * §8.6). `{code}` when the rebuilt request cannot be built.
   */
  private fallbackLeg(request: RequestInput, built: BuiltOk, fb: Route): Leg | { code: string } {
    const primary = this.plan.primary;
    const reasoning = this.plan.binding.reasoning;
    const rebuild = fb.caps.tools !== primary.caps.tools || (built.tools !== null && !sameEcho(echoRuleOf(primary, reasoning), echoRuleOf(fb, reasoning)));
    if (!rebuild) {
      return { route: fb, asm: built.asm, shaped: this.shapeFor(fb, built.asm), tools: built.tools, reserve: built.reserve, limits: built.limits };
    }
    const own = buildRequest({ ...request, view: built.view, plan: { ...this.plan, primary: fb } });
    this.keyedNotices(own.notices);
    if (!own.ok) return { code: own.code };
    return { route: fb, asm: own.asm, shaped: own.shaped, tools: own.tools, reserve: own.reserve, limits: own.limits };
  }

  /** One retry of the same model, then one fallback, both only before any output (§6.6, B1). */
  private async narrate(request: RequestInput, built: BuiltOk): Promise<Narrated> {
    const { plan } = this;
    const turnId = this.entry.turn;
    const route: NonNullable<Generation['route']> = [];
    const calls: Trace['calls'] = [];
    this.chk.start();

    const run = (leg: Leg): Promise<RoundsResult> => {
      const r = leg.route;
      const reasoning = plan.binding.reasoning;
      return narrateRounds({
        conn: r.conn,
        model: r.model,
        caps: r.caps,
        messages: leg.shaped.messages,
        ...(leg.shaped.prefill !== undefined ? { prefill: leg.shaped.prefill } : {}),
        // The reserve (it already holds the binding's max_tokens and the primary's maxOutput); a
        // fallback with a smaller output limit gets its own.
        maxTokens: maxTokensFor(r, leg.reserve),
        samplers: leg.limits.samplers,
        ...(reasoning ? { reasoning } : {}),
        turnSignal: this.ctrl.signal,
        sched: this.ctx.sched,
        fetch: this.ctx.fetch,
        timeouts: timeoutsFor(r.conn, this.ctx.timeouts),
        timers: this.ctx.timers,
        clock: this.ctx.clock,
        turnId,
        tools: leg.tools,
        maxRounds: plan.maxRounds,
        // B3: every model call of the turn counts toward CALL_CEILING, a retried round 0 and (M4,
        // D-101) the Director's calls too, and (M5c, §7.4.2) a sync recall's.
        callsBefore: this.dirCalls.length + this.recallCalls.length + calls.length,
        onText: (delta) => {
          const offset = this.text.length;
          this.text += delta;
          this.emit({ type: 'text', turnId, delta, offset });
          this.chk.add(delta);
        },
        onReasoning: (delta) => {
          const offset = this.reasoning.length;
          this.reasoning += delta;
          this.emit({ type: 'reasoning', turnId, delta, offset });
        },
        onTool: (ev) => {
          this.emit({
            type: 'tool',
            turnId,
            callId: ev.callId,
            name: ev.name,
            round: ev.round,
            phase: ev.phase,
            ...(ev.args !== undefined ? { args: ev.args } : {}),
            ...(ev.ok !== undefined ? { ok: ev.ok } : {}),
            ...(ev.summary !== undefined ? { summary: ev.summary } : {}),
          });
        },
        onCall: (c) => this.recorded(c, r, calls),
        ...(this.keep ? { keepRequest: this.keep } : {}),
        onNotice: (code, message, key) => {
          if (this.host.firstNotice(key ?? code)) this.notice({ level: 'warn', code, message });
        },
      });
    };
    const again = (res: RoundsResult): res is RoundsResult & { error: ProviderError } =>
      !res.stopped && !res.output && !this.ctrl.signal.aborted && isRetryable(res.error);

    let leg: Leg = {
      route: plan.primary,
      asm: built.asm,
      shaped: built.shaped,
      tools: built.tools,
      reserve: built.reserve,
      limits: built.limits,
    };
    let res = await run(leg);

    if (again(res)) {
      const err = res.error;
      const active = leg.route;
      route.push({ model: modelLabel(active.conn.id, active.model), status: 'retry', code: err.code });
      const delayMs = retryDelayMs(err, this.ctx.retryMaxDelayMs, this.ctx.random);
      this.emit({ type: 'retry', callKey: `${turnId}:narrator:0`, attempt: 1, delayMs, code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) });
      let waited = true;
      try {
        await abortableDelay(delayMs, this.ctrl.signal, this.ctx.timers);
      } catch {
        waited = false;
      }
      // Stopped while waiting to retry: nothing was written, nothing streamed. A retry re-runs the
      // whole loop: nothing of the failed attempt came out.
      res = waited ? await run(leg) : stoppedRounds();
    }

    if (again(res) && plan.fallback) {
      const err = res.error;
      const active = leg.route;
      route.push({ model: modelLabel(active.conn.id, active.model), status: 'error', code: err.code });
      const fb = plan.fallback;
      this.notice({
        level: 'warn',
        code: 'fallback',
        message: `${modelLabel(active.conn.id, active.model)} failed (${err.code}); trying the fallback ${modelLabel(fb.conn.id, fb.model)}.`,
      });
      const next = this.fallbackLeg(request, built, fb);
      if ('code' in next) {
        // The fallback's own request cannot be built (its window is too small, say): the primary's
        // failure stands, and the route says why the fallback never ran.
        route.push({ model: modelLabel(fb.conn.id, fb.model), status: 'error', code: next.code });
        return { res, active, asm: leg.asm, shaped: leg.shaped, tools: leg.tools, route, calls };
      }
      leg = next;
      // Through the same gate as the primary's request.
      leg.shaped.messages = await hookTransformRequest(this.ctx.hooks, leg.shaped.messages, this.hookCtx);
      res = await run(leg);
    }

    const active = leg.route;
    const last = modelLabel(active.conn.id, active.model);
    route.push(res.error ? { model: last, status: 'error', code: res.error.code } : { model: last, status: 'ok' });
    return { res, active, asm: leg.asm, shaped: leg.shaped, tools: leg.tools, route, calls };
  }

  /**
   * After every model call: one usage event with everything the call reported merged, so a cost
   * from the price table is never computed from half a usage (§11); the host's debug tap; the
   * trace.calls row.
   */
  private recorded(c: RoundCall, r: Route, calls: Trace['calls']): void {
    const { res, callKey } = c;
    if (res.usage) this.emitUsage(callKey, r, res.usage);
    // The host's debug tap sees the raw failure (server words in error.detail); events never do.
    const label = modelLabel(r.conn.id, r.model);
    for (const error of [res.error, res.tailError]) {
      if (!error || !this.ctx.onProviderError) continue;
      try {
        this.ctx.onProviderError({ sessionId: this.host.sessionId, turnId: this.entry.turn, callKey, model: label, error });
      } catch {
        /* a debug sink must never break a turn */
      }
    }
    calls.push({ callKey, agent: 'narrator', model: label, ms: res.ms, ...(res.usage ? { usage: res.usage } : {}) });
  }

  // ---- outcomes -------------------------------------------------------------------------------

  /**
   * The server reported far fewer prompt tokens than were sent: it cut the prompt to fit a smaller
   * window than the one budgeted for (Ollama does so silently at its num_ctx, keeping only the newest
   * messages). Told once per session, with what to do; the call is no EMA sample (tokens.ts). Round
   * 0's usage against round 0's request: later rounds sent more than the estimate counts.
   */
  private checkServerWindow(n: Narrated, window: number): void {
    const reported = n.res.firstUsage?.inputTotal;
    if (reported === undefined) return;
    // The messages and the prefill the server counted, as the trace counts them.
    const estimated = this.sentTrace(n.asm, n.shaped, n.tools).tokens.estimated;
    if (!truncatedByServer(estimated, reported) || !this.host.firstNotice('context_truncated_by_server')) return;
    const label = modelLabel(n.active.conn.id, n.active.model);
    this.notice({
      level: 'warn',
      code: 'context_truncated_by_server',
      message:
        `The server reported ${reported} prompt tokens for a prompt of about ${estimated}: it probably cut the prompt to fit a ` +
        `context window smaller than the ${window} tokens assumed for ${label}, dropping older messages unseen. ` +
        `Set context_length under [caps."${label}"] in config.toml (\`rp-core probe ${label}\` reads what the server reports), ` +
        `or give the model a larger window on the server.`,
    });
  }

  /** The answer text: post-processed once the stream is over, the raw stream before that. */
  private get answerText(): string {
    return this.answer ?? this.text;
  }

  /**
   * §6.2 step 9 (D-57): leaked tool-call markup is cut out of the answer. Streamed `text` events may
   * have shown it; the committed message and every draft carry the stripped text. Told once per
   * session. Inline reasoning tags are split by the adapter, before the text reaches the engine.
   * M3 (B6): an answer with tool rounds is stripped text block by text block (a block left empty
   * goes), so the rounds keep their order; a one-round answer is stripped whole, as in M2. Spans the
   * loop recovered into calls (§8.3) are already out of its blocks (RoundsResult.salvaged): they count
   * toward the notice, and such an answer is taken block by block even without tool blocks (calls on
   * a final round 0 are not stored), since its streamed text still holds them.
   */
  private postProcess(res: RoundsResult): void {
    const salvaged = res.salvaged ?? 0;
    // Markup a native round's stripper hid without running it never reached the text: counted here.
    let stripped = salvaged + (res.hidden ?? 0);
    if (!res.blocks.some(isToolBlock) && salvaged === 0) {
      const out = stripToolCallLeaks(this.text);
      this.answer = out.text;
      stripped += out.stripped;
    } else {
      const blocks: Block[] = [];
      let answer = '';
      // The text blocks as the loop stored them, joined: it put D-55's separator in front of a block
      // when this did not end in whitespace (narrate.ts storedSeparator).
      let before = '';
      for (const b of res.blocks) {
        if (b.k !== 'text') {
          blocks.push(b);
          continue;
        }
        // The loop's separator goes, and the stripped body takes the one what is kept before it needs:
        // a strip that took the whitespace at a block's end (or a whole block) never glues two rounds.
        const sep = storedSeparator(before, b.text) !== '' && b.text.startsWith('\n') ? 1 : 0;
        before += b.text;
        const out = stripToolCallLeaks(b.text.slice(sep));
        stripped += out.stripped;
        if (out.text === '') continue;
        const text = storedSeparator(answer, out.text) + out.text;
        blocks.push({ k: 'text', text });
        answer += text;
      }
      this.answer = answer;
      this.roundBlocks = blocks;
    }
    if (stripped > 0 && this.host.firstNotice('tool_markup_stripped')) {
      this.notice({
        level: 'info',
        code: 'tool_markup_stripped',
        message: `Leaked tool-call markup was removed from the answer (${stripped} block${stripped === 1 ? '' : 's'}); the model wrote tool calls as text.`,
      });
    }
  }

  /** What commits for the answer in hand: the rounds' blocks, or M2's [reasoning?, text]. */
  private answerBlocks(): Block[] {
    return this.roundBlocks ?? answerBlocks(this.answerText, this.reasoning);
  }

  /** The addition a continue would commit ('' when nothing beyond an echo arrived). */
  private addition(n: Narrated): string {
    const cont = n.shaped.cont;
    return cont ? continuationResult(cont.base, this.answerText, cont.mode).addition : '';
  }

  private hasAnswerText(n: Narrated): boolean {
    return this.plan.kind === 'continue' ? this.addition(n) !== '' : this.answerText.trim() !== '';
  }

  /** §6.5: text in hand → commit as 'stopped' (tool calls paired with 'cancelled'); nothing → end{stopped-empty}. */
  private async onStopped(n: Narrated): Promise<Ending> {
    if (!this.hasAnswerText(n)) return this.stoppedEmpty();
    const placed = await this.commit(n, this.answerBlocks(), 'stopped');
    if (placed.kind === 'held') return this.conflicted();
    if (placed.kind === 'end') return this.lostToConflict(placed);
    const message = this.messageView(placed);
    return { outcome: { type: 'stopped', message }, terminal: { type: 'stopped', turnId: this.entry.turn, message } };
  }

  /** §6.6 / D-22: a failure. After output with onError 'keep' the text is committed as 'interrupted'. */
  private async onFailure(n: Narrated, err: ProviderError): Promise<Ending> {
    const draft = this.answerText;
    if (n.res.output && this.plan.onError === 'keep' && this.hasAnswerText(n)) {
      const placed = await this.commit(n, this.answerBlocks(), 'interrupted');
      if (placed.kind === 'held') return this.conflicted();
      if (placed.kind === 'end') return this.lostToConflict(placed);
    } else {
      this.host.append({ t: 'end', ts: isoNow(this.ctx), turn: this.entry.turn, outcome: 'failed', code: err.code });
    }
    return this.failed(err.category, err.code, err.message, draft, modelLabel(n.active.conn.id, n.active.model));
  }

  /**
   * The stream finished: commit, or one of the empty-answer failures (§6.4, §7.1, D-31). With tool
   * rounds the rules read the whole turn (B11): a final round without text after earlier text
   * commits; a turn without any visible text fails as in M2 and its tool rounds are not kept.
   */
  private async onFinished(n: Narrated): Promise<Ending> {
    const finish: FinishReason = n.res.finish?.reason ?? 'end';
    if (this.plan.kind === 'continue') {
      if (this.addition(n) === '') {
        return this.endFailed('protocol', 'nothing_to_add', 'The model had nothing to add to this reply.', '');
      }
      return this.done(await this.commit(n, [], finish));
    }

    let text = this.answerText;
    let reasoning = this.reasoning;
    if (text.trim() === '' && reasoning.trim() !== '' && n.active.caps.reasoning.answerInReasoning) {
      // The capability record says this server puts the answer in the reasoning field (§6.6).
      text = reasoning;
      reasoning = '';
    }
    if (text.trim() === '') {
      if (reasoning.trim() === '') {
        // A filtered or refused empty answer says so; anything else is a protocol failure (§7.1).
        if (finish === 'content_filter' || finish === 'refusal') {
          return this.endFailed('content', finish, `The model returned no text (finish: ${finish}).`, '');
        }
        return this.endFailed('protocol', 'empty_response', 'The model returned an empty reply.', '');
      }
      if (this.plan.emptyReply !== 'keep') {
        return this.endFailed('protocol', 'reasoning_only', 'The model only reasoned and wrote no reply.', reasoning);
      }
      return this.done(await this.commit(n, [{ k: 'reasoning', text: reasoning }, { k: 'text', text: '' }], finish));
    }
    const reply = await hookTransformReply(this.ctx.hooks, text, this.hookCtx);
    if (this.roundBlocks === null || text !== this.answerText) return this.done(await this.commit(n, answerBlocks(reply.text, reasoning), finish));
    // M9 may rewrite the reply; a rewritten multi-round answer keeps its tool blocks, text last.
    const blocks = reply.text === text ? this.roundBlocks : [...this.roundBlocks.filter((b) => b.k !== 'text'), { k: 'text' as const, text: reply.text }];
    return this.done(await this.commit(n, blocks, finish));
  }

  // ---- commit ---------------------------------------------------------------------------------

  /** Write the answer (§6.2 step 10) and announce `changed`. Throws only when the write itself fails. */
  private async commit(n: Narrated, blocks: Block[], finish: FinishReason): Promise<Placed> {
    const { plan } = this;
    const { res, active, shaped, asm, tools } = n;
    // B13: gen.usage sums every call of the turn (retries included); a single call's is its own.
    const usage = sumUsage(n.calls.flatMap((c) => (c.usage ? [c.usage] : [])));
    const gen: Generation = {
      kind: 'model',
      connection: active.conn.id,
      model: active.model,
      ...(res.served ? { served: res.served } : {}),
      finish,
      ...(usage ? { usage } : {}),
      ms: Math.max(0, this.ctx.clock().getTime() - this.t0),
      ...(res.ttftMs !== undefined ? { ttftMs: res.ttftMs } : {}),
      transport: tools ? tools.transport : 'none',
      rounds: res.rounds,
      preset: { name: plan.presetRef, hash: asm.trace.presetHash },
      ...(shaped.prefill !== undefined && plan.kind !== 'continue' ? { prefill: shaped.prefill } : {}),
      ...(plan.guidance ? { guidance: plan.guidance } : {}),
      route: n.route,
    };
    // trace.blocks / tokens.estimated stay the round-0 request (preview --turn compares them 1:1);
    // reported is round 0's prompt, the EMA's sample (B13). The loop rides trace.tools / rounds.
    // M4: the Director's calls come first in trace.calls, then (M5c) a sync recall's; gen.usage stays the narrator's (D-101).
    const sent = this.withAgents(this.sentTrace(asm, shaped, tools));
    const reported = res.firstUsage?.inputTotal;
    const trace: Trace = {
      ...sent,
      tokens: { ...sent.tokens, ...(reported !== undefined ? { reported } : {}) },
      calls: [...this.dirCalls, ...this.recallCalls, ...n.calls],
      ...(tools
        ? {
            ...(res.toolRows.length > 0 ? { tools: res.toolRows } : {}),
            rounds: { n: res.rounds, transport: tools.transport, ended: res.ended, room: tools.roomTokens, roomLeft: res.roomLeft },
          }
        : {}),
    };
    this.committing = true;
    const commitPlan = {
      turn: this.entry,
      blocks,
      addition: this.answerText,
      ...(shaped.cont ? { cont: shaped.cont } : {}),
      // D-104: the plan rides the answer it shaped (a stopped or interrupted one too); a continue writes none.
      // M5c (D-200): the RecallRecord rides it too, a continue's (its reuse) included.
      body: {
        gen,
        trace,
        ...(this.dir && plan.kind !== 'continue' ? { dir: this.dir } : {}),
        ...(this.recallRec ? { recall: this.recallRec } : {}),
        ...(Object.keys(asm.varsDiff).length > 0 ? { vars: asm.varsDiff } : {}),
      },
      // Live, a continue on a changed target is discarded (§6.6); recovery says abandoned.
      continueConflict: 'discarded' as const,
    };
    const placed: Placed = this.host.version() !== this.entry.base
      ? (() => {
          const entry = this.host.append({ t: 'held', turn: this.entry.turn, body: {
            blocks, ...commitPlan.body, addition: commitPlan.addition, ...(commitPlan.cont ? { cont: commitPlan.cont } : {}),
          } });
          this.host.turnHeld(this.entry.turn);
          return { kind: 'held' as const, entry };
        })()
      : placeCommit(this.host, commitPlan);
    this.committing = false;
    if (placed.kind === 'msg') {
      this.emit({ type: 'changed', version: placed.entry.seq, change: 'msg', id: placed.entry.id });
      if (placed.tail) {
        // The head stayed where the user had moved it (commit.ts).
        this.notice({ level: 'warn', code: 'committed_as_tail', message: `The answer ${placed.entry.id} was saved as a side branch: the conversation had moved on.` });
      }
    } else if (placed.kind === 'edit') {
      this.emit({ type: 'changed', version: placed.entry.seq, change: 'edit', id: placed.entry.target });
    }
    return placed;
  }

  private messageView(placed: Extract<Placed, { kind: 'msg' | 'edit' }>): MessageView {
    const id = placed.kind === 'msg' ? placed.entry.id : placed.entry.target;
    return this.host.view().path.find((m) => m.id === id) ?? messageViewOf(this.host.tree(), id);
  }

  private done(placed: Placed): Ending {
    if (placed.kind === 'held') return this.conflicted();
    if (placed.kind === 'end') return this.lostToConflict(placed);
    const message = this.messageView(placed);
    return { outcome: { type: 'done', message }, terminal: { type: 'done', turnId: this.entry.turn, message } };
  }

  private conflicted(): Ending {
    return { outcome: { type: 'conflict', draft: this.answerText }, terminal: { type: 'conflict', turnId: this.entry.turn, draft: this.answerText } };
  }

  /** The unconditional-commit rule ended the turn (U hidden, continue target changed). */
  private lostToConflict(placed: Extract<Placed, { kind: 'end' }>): Ending {
    const outcome = placed.entry.outcome;
    return this.failed('conflict', outcome, `The session changed during the turn; the answer was ${outcome}.`, this.answerText);
  }

  // ---- endings --------------------------------------------------------------------------------

  private stoppedEmpty(): Ending {
    this.host.append({ t: 'end', ts: isoNow(this.ctx), turn: this.entry.turn, outcome: 'stopped-empty' });
    return { outcome: { type: 'stopped', message: null }, terminal: { type: 'stopped', turnId: this.entry.turn, message: null } };
  }

  /** Before anything was sent (assemble/shape refused): end{failed} and an empty draft. */
  private failEarly(category: Category, code: string, message: string): Ending {
    return this.endFailed(category, code, message, '');
  }

  private endFailed(category: Category, code: string, message: string, draft: string): Ending {
    this.host.append({ t: 'end', ts: isoNow(this.ctx), turn: this.entry.turn, outcome: 'failed', code });
    return this.failed(category, code, message, draft);
  }

  /** `route`: 'conn:model' of the model call that failed (TurnOutcome only; the terminal event is unchanged). */
  private failed(category: Category, code: string, message: string, draft: string, route?: string): Ending {
    return {
      outcome: { type: 'failed', category, code, message, draft, ...(route !== undefined ? { route } : {}) },
      terminal: { type: 'failed', turnId: this.entry.turn, category, code, message, draft },
    };
  }

  /** An exception escaped the steps (a bug, or the journal refused a write). */
  private crashed(e: unknown): Ending {
    const message = errMessage(e);
    if (e instanceof SessionLockedError) {
      // Another process took the session over (this one was suspended past the lock's TTL). The
      // journal can no longer be written from here: what was checkpointed is recovered by an open
      // (perhaps the other process's, already), the rest only exists here. So the full answer is
      // handed back as the draft and the turn fails; it is never reported as done.
      this.committing = false;
      const who = e.info.pid > 0 ? `pid ${e.info.pid} on ${e.info.host}` : 'it wrote to the journal meanwhile';
      return this.failed('conflict', 'session_locked', `Another process took this session over (${who}); the answer was not saved.`, this.answerText);
    }
    if (this.committing) {
      // D-38: the answer arrived but is not written. Its checkpoint stays (no `end`), so the
      // next open commits it as interrupted.
      this.chk.flush();
      return this.failed('internal', 'commit_deferred', `The reply arrived but could not be saved yet; it comes back when the session reopens (${message}).`, this.answerText);
    }
    try {
      this.host.append({ t: 'end', ts: isoNow(this.ctx), turn: this.entry.turn, outcome: 'failed', code: 'internal_error' });
    } catch {
      /* the journal is unusable; recovery closes the turn at the next open */
    }
    return this.failed('internal', 'internal_error', message, this.answerText);
  }

  /** §11: the call's usage and its cost (provider-reported, else the price table, else null). */
  private emitUsage(callKey: string, r: Route, usage: Usage): void {
    const cost = usageCost(usage, priceFor(this.ctx.prices, r.conn.id, r.model));
    this.emit({
      type: 'usage',
      callKey,
      agent: 'narrator',
      model: modelLabel(r.conn.id, r.model),
      usage,
      costUsd: cost.costUsd,
      priceSource: cost.priceSource,
    });
  }

  private keyedNotices(list: readonly KeyedNotice[]): void {
    // Request notices (prefill/tools D-28, post-processing, missing books, broken lore keys) come
    // once per session under their key; the assembler and shape emit them on every call.
    for (const n of list) if (this.host.firstNotice(n.key)) this.notice(n.notice);
  }

  private notice(n: Notice): void {
    this.emit({ type: 'notice', level: n.level, code: n.code, message: n.message });
  }

  private finish(ending: Ending): void {
    if (this.ended) return;
    this.ended = true;
    this.chk.stop({ flush: false });
    // Not busy any more before anyone hears the terminal event, so a client may send right away.
    this.host.turnEnded(this);
    this.emit(ending.terminal);
    this.queue.end();
    this.resolveResult(ending.outcome);
    this.host.turnSettled?.(this);
  }
}
