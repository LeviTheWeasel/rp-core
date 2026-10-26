// Ported from Bunraku:src/studio/scene-turn.ts (runTurn, commit)@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One turn, from `start` to its terminal event (ARCHITECTURE.md §6.2–§6.6, §7.1 M1a). Admission and
// the `turn` line happen synchronously in session.ts; this file runs the rest:
//
//   [hook beforeAssemble] → assemble (pure) → shape (pure) → `prep` (fsync) → [hook transformRequest]
//   → narrate: one streamed round, `chk` lines as text arrives, one retry, one fallback
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

import { abortableDelay, abortWith, type AbortReason } from './abort.ts';
import type { TurnOutcome } from './api.ts';
import type { AdmittedTurn, Route } from './admit.ts';
import { EventQueue, singleConsumer } from './bus.ts';
import { Checkpointer } from './checkpoint.ts';
import { messageViewOf, placeCommit, type Journal, type Placed } from './commit.ts';
import { isoNow, type EngineCtx } from './context.ts';
import { priceFor, usageCost } from './cost.ts';
import { tokenFactorFor, truncatedByServer } from './ema.ts';
import { hookBeforeAssemble, hookTransformReply, hookTransformRequest, type HookCtx } from './hooks.ts';
import { streamCall, timeoutsFor, type CallResult } from './narrate.ts';
import { isRetryable, modelLabel, retryDelayMs } from './route.ts';
import { assemble, traceForSent, type AssembleResult } from '../prompt/assemble.ts';
import { estimateMessages } from '../prompt/tokens.ts';
import { contextWindow, replyReserve } from '../prompt/budget.ts';
import { continuationResult, shape } from '../prompt/shape.ts';
import type { Event, EventBody, Notice } from '../protocol/events.ts';
import { stripToolCallLeaks } from '../tools/leaks.ts';
import type { FinishReason, ProviderError, PromptMsg, Usage } from '../providers/types.ts';
import type { Samplers } from '../formats/native.ts';
import type { Binding, Block, Generation, SessionHeader, Trace, TurnEntry } from '../session/entries.ts';
import { foldViewAt } from '../session/fold.ts';
import { SessionLockedError } from '../session/log.ts';
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
}

type Category = string;
interface Ending {
  outcome: TurnOutcome;
  terminal: EventBody;
}

/** The request one route sends, shaped for that route's caps. */
interface Shaped {
  messages: PromptMsg[];
  prefill?: string;
  cont?: { mode: 'prefill' | 'cue'; base: string };
}

/** What the routed narration came to. */
interface Narrated {
  res: CallResult;
  active: Route;
  shaped: Shaped;
  route: NonNullable<Generation['route']>;
  calls: Trace['calls'];
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A usable token limit: a positive finite number, floored; anything else means "not set". */
const tokenLimit = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

/**
 * The reply's token limit and the samplers to forward [D-89, §11]: `max_tokens` set by the binding
 * (maxTokens, then its samplers) or by the preset's samplers. It leaves the samplers, so a request
 * carries exactly one limit (ModelRequest.maxTokens).
 */
export function replyLimits(binding: Binding, presetSamplers: Partial<Samplers> | undefined): { maxTokens?: number; samplers: Partial<Samplers> } {
  const { max_tokens, ...samplers } = { ...(presetSamplers ?? {}), ...(binding.samplers ?? {}) };
  const maxTokens = tokenLimit(binding.maxTokens) ?? tokenLimit(max_tokens);
  return maxTokens !== undefined ? { maxTokens, samplers } : { samplers };
}

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
  /** The answer is in hand and being written: a failure now must keep the checkpoint (D-38). */
  private committing = false;
  private ended = false;

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
    const placements = await hookBeforeAssemble(this.ctx.hooks, this.hookCtx);
    if (this.ctrl.signal.aborted) return this.stoppedEmpty();

    // Step 4: assemble (pure). The window and reserve follow the primary route.
    const primary = plan.primary;
    const window = contextWindow({
      caps: primary.caps,
      local: primary.conn.local,
      preset: plan.preset,
      ...(plan.config.window !== undefined ? { configWindow: plan.config.window } : {}),
    });
    const limits = replyLimits(plan.binding, plan.preset.samplers);
    // The reply may ask for no more than the model can write (caps.maxOutput, e.g. OpenRouter's
    // top_provider.max_completion_tokens) and no more than the budget held back for it: the request
    // carries the reserve itself, so the prompt the budget packed plus max_tokens fits the window.
    const maxOutput = tokenLimit(primary.caps.maxOutput);
    const wanted = limits.maxTokens !== undefined && maxOutput !== undefined ? Math.min(limits.maxTokens, maxOutput) : (limits.maxTokens ?? maxOutput);
    const reserve = replyReserve(window, wanted);
    if (limits.maxTokens !== undefined && reserve < limits.maxTokens && this.host.firstNotice('max_tokens_reduced')) {
      this.notice({
        level: 'info',
        code: 'max_tokens_reduced',
        message:
          maxOutput !== undefined && maxOutput < limits.maxTokens && reserve === maxOutput
            ? `max_tokens ${limits.maxTokens} is above what ${modelLabel(primary.conn.id, primary.model)} can write; ${reserve} is sent.`
            : `max_tokens ${limits.maxTokens} does not fit: the context window is ${window} tokens and at most half of it is kept for the reply, so ${reserve} is sent.`,
      });
    }
    // The state the turn starts from: the head, except on a swipe, which regrows the answer from U
    // (§6.3), so the replaced answer's variables and fires must not reach its sibling (§5.10).
    const current = this.host.view();
    const view = current.head === plan.upTo ? current : foldViewAt(this.host.header(), this.host.tree(), plan.upTo);
    // D-50: the model's token correction, learned from the earlier answers on this path.
    const tokenFactor = tokenFactorFor(this.host.tree(), view, primary.model);
    let asm: AssembleResult;
    try {
      asm = assemble({
        sessionId: this.host.sessionId,
        view,
        upTo: plan.upTo,
        kind: plan.kind,
        cast: this.host.header().cast,
        preset: plan.preset,
        lorebooks: [],
        placements,
        ...(plan.config.authorNote ? { authorNote: plan.config.authorNote } : {}),
        ...(plan.guidance ? { guidance: { text: plan.guidance, ...(plan.rejected !== undefined ? { rejected: plan.rejected } : {}) } } : {}),
        caps: primary.caps,
        window,
        reserve,
        tokenFactor,
        seed: this.entry.seed,
        now: this.entry.now,
        timeZone: this.ctx.timeZone,
        tools: [],
        prefillVsTools: plan.config.narrator.prefillVsTools,
      });
    } catch (e) {
      return this.failEarly('request', 'assemble_failed', errMessage(e));
    }
    if (!asm.ok) return this.failEarly('request', asm.code, asm.message);
    this.notices(asm.notices);

    // Step 5: shape for the primary model.
    let shaped: Shaped;
    try {
      shaped = this.shapeFor(primary, asm);
    } catch (e) {
      return this.failEarly('request', 'shape_failed', errMessage(e));
    }

    // Step 6: `prep`, durable, before anything is sent. vars ride the commit, not this line's
    // application: a turn that never commits changes no variable (D-30).
    const vars = asm.varsDiff;
    this.host.append({
      t: 'prep',
      turn: this.entry.turn,
      trace: traceForSent(asm.trace, shaped.messages),
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

    // Step 7: the host's transformRequest gate, after `prep` (M9; a pass-through now).
    shaped.messages = await hookTransformRequest(this.ctx.hooks, shaped.messages, this.hookCtx);

    // Step 8: narrate (one streamed round in M1a).
    const narrated = await this.narrate(asm, shaped, reserve, limits);
    // Every byte that arrived goes to a chk before anything can commit or crash (§6.2 step 8).
    this.chk.flush();
    const { res } = narrated;
    this.checkServerWindow(narrated, window);
    // Step 9: post-processing, before anything commits or is handed back.
    this.postProcess();
    if (res.tailError) {
      this.notice({
        level: 'warn',
        code: 'stream_tail_failed',
        message: `The answer was complete, but the stream failed after it (${res.tailError.code}); it is kept, its usage may be missing.`,
      });
    }
    if (res.stopped) return this.onStopped(asm, narrated);
    if (res.error) return this.onFailure(asm, narrated, res.error);
    return this.onFinished(asm, narrated);
  }

  /** Shape (pure) for one route's caps (the model's, not the connection default). */
  private shapeFor(route: Route, asm: Extract<AssembleResult, { ok: true }>): Shaped {
    const { character, persona } = this.host.header().cast;
    const out = shape({
      messages: asm.messages,
      caps: route.caps,
      prefill: asm.prefill,
      kind: this.plan.kind,
      ...(this.plan.preset.postProcessing ? { postProcessing: this.plan.preset.postProcessing } : {}),
      // Speaker prefixes for the 'single' post-processing mode, as the macros name them.
      names: { char: character.name, user: persona?.name || 'User' },
    });
    this.notices(out.notices);
    const shaped: Shaped = { messages: out.messages };
    if (out.prefill !== undefined) shaped.prefill = out.prefill;
    if (this.plan.kind === 'continue' && out.continueMode) {
      shaped.cont = { mode: out.continueMode, base: out.continueBase ?? '' };
    }
    return shaped;
  }

  /** One retry of the same model, then one fallback, both only before any output (§6.6). */
  private async narrate(
    asm: Extract<AssembleResult, { ok: true }>,
    primaryShape: Shaped,
    reserve: number,
    limits: ReturnType<typeof replyLimits>,
  ): Promise<Narrated> {
    const { plan } = this;
    const callKey = `${this.entry.turn}:narrator:0`;
    const route: NonNullable<Generation['route']> = [];
    const calls: Trace['calls'] = [];
    const samplers = limits.samplers;
    // The reserve (it already holds the binding's max_tokens and the primary's maxOutput); a fallback
    // with a smaller output limit gets its own.
    const maxTokensFor = (r: Route): number => Math.min(reserve, tokenLimit(r.caps.maxOutput) ?? reserve);
    this.chk.start();

    const call = async (r: Route, shaped: Shaped): Promise<CallResult> => {
      const label = modelLabel(r.conn.id, r.model);
      const res = await streamCall({
        conn: r.conn,
        model: r.model,
        caps: r.caps,
        messages: shaped.messages,
        ...(shaped.prefill !== undefined ? { prefill: shaped.prefill } : {}),
        maxTokens: maxTokensFor(r),
        samplers,
        ...(plan.binding.reasoning ? { reasoning: plan.binding.reasoning } : {}),
        callKey,
        turnSignal: this.ctrl.signal,
        sched: this.ctx.sched,
        fetch: this.ctx.fetch,
        timeouts: timeoutsFor(r.conn, this.ctx.timeouts),
        timers: this.ctx.timers,
        clock: this.ctx.clock,
        onText: (delta) => {
          const offset = this.text.length;
          this.text += delta;
          this.emit({ type: 'text', turnId: this.entry.turn, delta, offset });
          this.chk.add(delta);
        },
        onReasoning: (delta) => {
          const offset = this.reasoning.length;
          this.reasoning += delta;
          this.emit({ type: 'reasoning', turnId: this.entry.turn, delta, offset });
        },
      });
      // One usage event per call, with everything the call reported merged, so a cost from the
      // price table is never computed from half a usage (§11).
      if (res.usage) this.emitUsage(callKey, r, res.usage);
      // The host's debug tap sees the raw failure (server words in error.detail); events never do.
      for (const error of [res.error, res.tailError]) {
        if (!error || !this.ctx.onProviderError) continue;
        try {
          this.ctx.onProviderError({ sessionId: this.host.sessionId, turnId: this.entry.turn, callKey, model: label, error });
        } catch {
          /* a debug sink must never break a turn */
        }
      }
      calls.push({ callKey, agent: 'narrator', model: label, ms: res.ms, ...(res.usage ? { usage: res.usage } : {}) });
      return res;
    };
    const again = (res: CallResult): res is CallResult & { error: ProviderError } =>
      !res.stopped && !res.output && !this.ctrl.signal.aborted && isRetryable(res.error);

    let active = plan.primary;
    let shaped = primaryShape;
    let res = await call(active, shaped);

    if (again(res)) {
      const err = res.error;
      route.push({ model: modelLabel(active.conn.id, active.model), status: 'retry', code: err.code });
      const delayMs = retryDelayMs(err, this.ctx.retryMaxDelayMs, this.ctx.random);
      this.emit({ type: 'retry', callKey, attempt: 1, delayMs, code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) });
      let waited = true;
      try {
        await abortableDelay(delayMs, this.ctrl.signal, this.ctx.timers);
      } catch {
        waited = false;
      }
      // Stopped while waiting to retry: nothing was written, nothing streamed.
      res = waited ? await call(active, shaped) : { text: '', reasoning: '', stopped: true, output: false, ms: 0 };
    }

    if (again(res) && plan.fallback) {
      const err = res.error;
      route.push({ model: modelLabel(active.conn.id, active.model), status: 'error', code: err.code });
      const fb = plan.fallback;
      this.notice({
        level: 'warn',
        code: 'fallback',
        message: `${modelLabel(active.conn.id, active.model)} failed (${err.code}); trying the fallback ${modelLabel(fb.conn.id, fb.model)}.`,
      });
      active = fb;
      // Re-shaped for the fallback's caps (prefill support may differ), through the same gate.
      shaped = this.shapeFor(fb, asm);
      shaped.messages = await hookTransformRequest(this.ctx.hooks, shaped.messages, this.hookCtx);
      res = await call(active, shaped);
    }

    const last = modelLabel(active.conn.id, active.model);
    route.push(res.error ? { model: last, status: 'error', code: res.error.code } : { model: last, status: 'ok' });
    return { res, active, shaped, route, calls };
  }

  // ---- outcomes -------------------------------------------------------------------------------

  /**
   * The server reported far fewer prompt tokens than were sent: it cut the prompt to fit a smaller
   * window than the one budgeted for (Ollama does so silently at its num_ctx, keeping only the newest
   * messages). Told once per session, with what to do; the call is no EMA sample (tokens.ts).
   */
  private checkServerWindow(n: Narrated, window: number): void {
    const reported = n.res.usage?.inputTotal;
    const estimated = estimateMessages(n.shaped.messages);
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
   */
  private postProcess(): void {
    const { text, stripped } = stripToolCallLeaks(this.text);
    this.answer = text;
    if (stripped > 0 && this.host.firstNotice('tool_markup_stripped')) {
      this.notice({
        level: 'info',
        code: 'tool_markup_stripped',
        message: `Leaked tool-call markup was removed from the answer (${stripped} block${stripped === 1 ? '' : 's'}); the model wrote tool calls as text.`,
      });
    }
  }

  /** The addition a continue would commit ('' when nothing beyond an echo arrived). */
  private addition(n: Narrated): string {
    const cont = n.shaped.cont;
    return cont ? continuationResult(cont.base, this.answerText, cont.mode).addition : '';
  }

  private hasAnswerText(n: Narrated): boolean {
    return this.plan.kind === 'continue' ? this.addition(n) !== '' : this.answerText.trim() !== '';
  }

  /** §6.5: text in hand → commit as 'stopped'; nothing → end{stopped-empty}. */
  private async onStopped(asm: Extract<AssembleResult, { ok: true }>, n: Narrated): Promise<Ending> {
    if (!this.hasAnswerText(n)) return this.stoppedEmpty();
    const placed = await this.commit(asm, n, answerBlocks(this.answerText, this.reasoning), 'stopped');
    if (placed.kind === 'end') return this.lostToConflict(placed);
    const message = this.messageView(placed);
    return { outcome: { type: 'stopped', message }, terminal: { type: 'stopped', turnId: this.entry.turn, message } };
  }

  /** §6.6 / D-22: a failure. After output with onError 'keep' the text is committed as 'interrupted'. */
  private async onFailure(asm: Extract<AssembleResult, { ok: true }>, n: Narrated, err: ProviderError): Promise<Ending> {
    const draft = this.answerText;
    if (n.res.output && this.plan.onError === 'keep' && this.hasAnswerText(n)) {
      const placed = await this.commit(asm, n, answerBlocks(this.answerText, this.reasoning), 'interrupted');
      if (placed.kind === 'end') return this.lostToConflict(placed);
    } else {
      this.host.append({ t: 'end', ts: isoNow(this.ctx), turn: this.entry.turn, outcome: 'failed', code: err.code });
    }
    return this.failed(err.category, err.code, err.message, draft);
  }

  /** The stream finished: commit, or one of the empty-answer failures (§6.4, §7.1, D-31). */
  private async onFinished(asm: Extract<AssembleResult, { ok: true }>, n: Narrated): Promise<Ending> {
    const finish: FinishReason = n.res.finish?.reason ?? 'end';
    if (this.plan.kind === 'continue') {
      if (this.addition(n) === '') {
        return this.endFailed('protocol', 'nothing_to_add', 'The model had nothing to add to this reply.', '');
      }
      return this.done(await this.commit(asm, n, [], finish));
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
      return this.done(await this.commit(asm, n, [{ k: 'reasoning', text: reasoning }, { k: 'text', text: '' }], finish));
    }
    const reply = await hookTransformReply(this.ctx.hooks, text, this.hookCtx);
    return this.done(await this.commit(asm, n, answerBlocks(reply.text, reasoning), finish));
  }

  // ---- commit ---------------------------------------------------------------------------------

  /** Write the answer (§6.2 step 10) and announce `changed`. Throws only when the write itself fails. */
  private async commit(
    asm: Extract<AssembleResult, { ok: true }>,
    n: Narrated,
    blocks: Block[],
    finish: FinishReason,
  ): Promise<Placed> {
    const { plan } = this;
    const { res, active, shaped } = n;
    const gen: Generation = {
      kind: 'model',
      connection: active.conn.id,
      model: active.model,
      ...(res.served ? { served: res.served } : {}),
      finish,
      ...(res.usage ? { usage: res.usage } : {}),
      ms: Math.max(0, this.ctx.clock().getTime() - this.t0),
      ...(res.ttftMs !== undefined ? { ttftMs: res.ttftMs } : {}),
      transport: 'none',
      rounds: 1,
      preset: { name: plan.presetRef, hash: asm.trace.presetHash },
      ...(shaped.prefill !== undefined && plan.kind !== 'continue' ? { prefill: shaped.prefill } : {}),
      ...(plan.guidance ? { guidance: plan.guidance } : {}),
      route: n.route,
    };
    const sent = traceForSent(asm.trace, shaped.messages);
    const trace: Trace = {
      ...sent,
      tokens: { ...sent.tokens, ...(res.usage?.inputTotal !== undefined ? { reported: res.usage.inputTotal } : {}) },
      calls: n.calls,
    };
    this.committing = true;
    const placed = placeCommit(this.host, {
      turn: this.entry,
      blocks,
      addition: this.answerText,
      ...(shaped.cont ? { cont: shaped.cont } : {}),
      body: { gen, trace, ...(Object.keys(asm.varsDiff).length > 0 ? { vars: asm.varsDiff } : {}) },
      // Live, a continue on a changed target is discarded (§6.6); recovery says abandoned.
      continueConflict: 'discarded',
    });
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
    if (placed.kind === 'end') return this.lostToConflict(placed);
    const message = this.messageView(placed);
    return { outcome: { type: 'done', message }, terminal: { type: 'done', turnId: this.entry.turn, message } };
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

  private failed(category: Category, code: string, message: string, draft: string): Ending {
    return {
      outcome: { type: 'failed', category, code, message, draft },
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

  private notices(list: readonly Notice[]): void {
    // Assemble/shape notices (prefill/tools D-28, post-processing) come once per session; the
    // assembler and shape emit them on every call.
    for (const n of list) if (this.host.firstNotice(n.code)) this.notice(n);
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
  }
}
