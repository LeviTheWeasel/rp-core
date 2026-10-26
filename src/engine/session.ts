// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One open session (ARCHITECTURE.md §5.3, §6.1, §12.1): the locked journal, the cached tree and
// PathView, the verbs, and at most one running turn. Every write goes through append() here, which
// keeps version(session) current without re-reading the log. Admission (admit.ts) and the turn's
// first line happen synchronously in runTurn; the rest of the turn runs in turn.ts.

import { Refusal } from './api.ts';
import type { CreateSessionInput, RunTurnOptions, SessionHandle, TurnHandle } from './api.ts';
import { admitTurn, checkOnError, resolvePreset, resolvePrimary } from './admit.ts';
import { isoNow, type EngineCtx } from './context.ts';
import { recoverSession, type RecoverJournal } from './recover.ts';
import { TurnRun, type EventBody, type TurnHost } from './turn.ts';
import { createMacroRun } from '../prompt/macros.ts';
import type { Event } from '../protocol/events.ts';
import {
  checkHeader,
  DEFAULT_SESSION_CONFIG,
  VERSIONED_KINDS,
  type DeepPartial,
  type Entry,
  type EntryInput,
  type EntryKind,
  type SessionConfig,
  type SessionHeader,
} from '../session/entries.ts';
import { currentConfig, foldView, mergePatch } from '../session/fold.ts';
import { forkSession } from '../session/fork.ts';
import { newMessageId, newSeed, newSessionId, newTurnId } from '../session/ids.ts';
import {
  createSessionLogWith,
  openSessionLog,
  SessionLockedError,
  SessionNotFoundError,
  type SessionLog,
} from '../session/log.ts';
import { buildTree, effectiveMessage, newestDescendant, type TreeIndex } from '../session/tree.ts';
import type { PathView } from '../session/view.ts';

/** How many fresh ids to draw before giving up on a collision (8 hex: practically never > 1). */
const ID_ATTEMPTS = 16;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A new session's first entries: the card greetings (identity macros expanded; blank ones skipped,
 * there is nothing to show) as sibling roots, then a `head` back on greeting 0, since each msg moves
 * the head onto itself (§5.5).
 */
function greetingEntries(ctx: EngineCtx, header: SessionHeader, now: string): EntryInput[] {
  const { character, persona } = header.cast;
  const run = createMacroRun({
    char: character.name,
    user: persona?.name || 'User',
    card: {
      description: character.description ?? '',
      personality: character.personality ?? '',
      scenario: character.scenario ?? '',
      examples: character.examples ?? '',
      systemPrompt: character.systemPrompt ?? '',
      postHistory: character.postHistory ?? '',
      firstMessage: character.greetings[0] ?? '',
    },
    persona: persona?.description ?? '',
    vars: {},
    now,
    timeZone: ctx.timeZone,
    seed: 0,
    sessionId: header.id,
  });
  const out: EntryInput[] = [];
  const ids: string[] = [];
  for (const text of character.greetings) {
    if (typeof text !== 'string' || text.trim() === '') continue;
    let id = newMessageId(ctx.random);
    // A duplicate id would silently vanish from the tree; 8 hex practically never collide.
    for (let i = 1; ids.includes(id); i++) {
      if (i >= ID_ATTEMPTS) throw new Error('could not find a free message id');
      id = newMessageId(ctx.random);
    }
    ids.push(id);
    out.push({ t: 'msg', ts: now, id, parent: null, role: 'assistant', gen: { kind: 'greeting' }, blocks: [{ k: 'text', text: run.userText(text) }] });
  }
  if (ids.length >= 2) out.push({ t: 'head', ts: now, leaf: ids[0]! });
  return out;
}

export class SessionImpl implements SessionHandle, TurnHost, RecoverJournal {
  readonly id: string;
  private ver: number;
  private treeCache: { version: number; idx: TreeIndex } | null = null;
  private viewCache: { version: number; view: PathView } | null = null;
  private config: SessionConfig;
  private running: TurnRun | null = null;
  /** Turns left open with a `held` answer (M6 decides them); new turns are refused meanwhile. */
  private readonly held = new Set<string>();
  private readonly turnIds = new Set<string>();
  private readonly noticed = new Set<string>();
  private readonly opened: Event[] = [];
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly ctx: EngineCtx,
    private readonly log: SessionLog,
    private readonly onClose: (s: SessionImpl) => void,
  ) {
    this.id = log.id;
    const entries = log.entries();
    this.ver = buildTree(entries).version;
    this.config = currentConfig(log.header, entries);
    for (const e of entries) if (e.t === 'turn') this.turnIds.add(e.turn);
  }

  // ---- construction -----------------------------------------------------------------------------

  /**
   * New session file: header, greetings as sibling roots, head on greeting 0 (§5.5). The whole
   * first state is one file made visible at once (createSessionLogWith), so a crash never leaves a
   * listed session without its greetings or with the head on the wrong one.
   */
  static create(ctx: EngineCtx, input: CreateSessionInput, onClose: (s: SessionImpl) => void): SessionImpl {
    if (!isObject(input) || !isObject(input.character)) throw new Refusal('invalid_params', 'createSession needs a character');
    const { character, persona } = input;
    const config = mergePatch<SessionConfig>(DEFAULT_SESSION_CONFIG, input.config);
    const created = isoNow(ctx);
    let log: SessionLog | null = null;
    for (let i = 0; i < ID_ATTEMPTS && !log; i++) {
      const header: SessionHeader = {
        t: 'session',
        v: 1,
        id: newSessionId(ctx.random),
        created,
        title: input.title ?? character.name,
        cast: persona ? { character, persona } : { character },
        config,
      };
      const checked = checkHeader(JSON.parse(JSON.stringify(header)) as unknown);
      if (!checked.ok) throw new Refusal('invalid_params', `invalid session: ${checked.why}`);
      try {
        log = createSessionLogWith(ctx.home, header, greetingEntries(ctx, header, created));
      } catch (e) {
        // Only an id collision is worth another draw; anything else is real trouble.
        if (!(e instanceof Error) || !e.message.startsWith('session already exists')) throw e;
      }
    }
    if (!log) throw new Error('could not find a free session id');
    return new SessionImpl(ctx, log, onClose);
  }

  /** Open an existing session: lock, read, recover (§6.7). */
  static open(ctx: EngineCtx, id: string, onClose: (s: SessionImpl) => void): SessionImpl {
    let opened: ReturnType<typeof openSessionLog>;
    try {
      opened = openSessionLog(ctx.home, id);
    } catch (e) {
      if (e instanceof SessionLockedError) throw new Refusal('session_locked', e.message);
      if (e instanceof SessionNotFoundError) throw new Refusal('session_not_found', e.message);
      throw e;
    }
    const s = new SessionImpl(ctx, opened.log, onClose);
    for (const n of opened.notices) {
      s.openEvent({ type: 'notice', level: 'warn', code: n.code, message: n.message });
    }
    try {
      const report = recoverSession(s);
      for (const h of report.held) s.held.add(h);
      for (const ev of report.events) {
        // A notice told while opening counts as told for this open session (once-per-session codes).
        if (ev.type === 'notice') s.noticed.add(ev.code);
        s.openEvent(ev);
      }
    } catch (e) {
      opened.log.close();
      throw e;
    }
    return s;
  }

  // ---- journal access (TurnHost / RecoverJournal) -------------------------------------------------

  get sessionId(): string {
    return this.id;
  }

  entries(): readonly Entry[] {
    return this.log.entries();
  }

  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number } {
    const e = this.log.append(input, opts);
    if (VERSIONED_KINDS.has((e as { t: EntryKind }).t)) this.ver = e.seq;
    return e;
  }

  /**
   * A verb's single write. The log refuses it before writing anything when the lock was lost (the
   * process was suspended past the TTL and another one took the session), so it surfaces as the
   * refusal it is (§6.1), not as an internal error.
   */
  private verbAppend<T extends EntryInput>(input: T): T & { seq: number } {
    try {
      return this.append(input);
    } catch (e) {
      if (e instanceof SessionLockedError) throw new Refusal('session_locked', `another process took this session over: ${e.message}`);
      throw e;
    }
  }

  now(): string {
    return isoNow(this.ctx);
  }

  datasync(): void {
    this.log.datasync();
  }

  tree(): TreeIndex {
    // Only versioned entries change the tree, so the version is a complete cache key.
    if (this.treeCache?.version !== this.ver) this.treeCache = { version: this.ver, idx: buildTree(this.log.entries()) };
    return this.treeCache.idx;
  }

  firstNotice(code: string): boolean {
    if (this.noticed.has(code)) return false;
    this.noticed.add(code);
    return true;
  }

  turnEnded(run: TurnRun): void {
    if (this.running === run) this.running = null;
  }

  // ---- reading -----------------------------------------------------------------------------------

  header(): SessionHeader {
    return this.log.header;
  }

  version(): number {
    return this.ver;
  }

  view(): PathView {
    if (this.viewCache?.version !== this.ver) {
      this.viewCache = { version: this.ver, view: foldView(this.log.header, this.log.entries(), this.tree()) };
    }
    return this.viewCache.view;
  }

  busy(): boolean {
    return this.running !== null;
  }

  openEvents(): Event[] {
    return [...this.opened];
  }

  /** The session's current config (header + config entries). */
  currentConfig(): SessionConfig {
    return this.config;
  }

  // ---- verbs -------------------------------------------------------------------------------------

  send(input: { text: string; expectedVersion: number; greetingIndex?: number }): { messageId: string; version: number } {
    this.guardWrite(input?.expectedVersion, { held: true });
    if (typeof input.text !== 'string') throw new Refusal('invalid_params', 'text must be a string');
    const idx = this.tree();
    let parent: string | null = idx.head;
    if (input.greetingIndex !== undefined) {
      const gi = input.greetingIndex;
      if (!Number.isInteger(gi) || gi < 0) throw new Refusal('invalid_params', 'greetingIndex must be a non-negative integer');
      const greetings = (idx.children.get(null) ?? []).filter((id) => idx.msgs.get(id)?.gen?.kind === 'greeting');
      const g = greetings[gi];
      if (g === undefined) throw new Refusal('not_found', `there is no greeting ${gi}`);
      parent = g;
    }
    const id = this.freshMessageId();
    // One line: the new message moves the head itself, so the send is atomic (§5.5).
    this.verbAppend({ t: 'msg', ts: this.now(), id, parent, role: 'user', blocks: [{ k: 'text', text: input.text }] });
    this.publish({ type: 'changed', version: this.ver, change: 'msg', id });
    return { messageId: id, version: this.ver };
  }

  runTurn(opts: RunTurnOptions): TurnHandle {
    this.assertOpen();
    const plan = admitTurn(
      this.ctx,
      { busy: this.running !== null, heldOpen: this.held.size > 0, version: this.ver, view: this.view(), config: this.config },
      opts,
    );
    // §6.2 step 2: the `turn` line (fsync), the controller, `start`.
    const now = this.now();
    const turnId = this.freshTurnId();
    const msgId = plan.kind === 'continue' ? plan.target! : this.freshMessageId();
    const entry = this.verbAppend({
      t: 'turn',
      ts: now,
      turn: turnId,
      kind: plan.kind,
      parent: plan.parent,
      ...(plan.target !== undefined ? { target: plan.target } : {}),
      msgId,
      seed: newSeed(this.ctx.random),
      now,
      base: this.ver,
    });
    const run = new TurnRun(this, this.ctx, plan, entry);
    this.running = run;
    run.emit({ type: 'start', turnId, kind: plan.kind, messageId: msgId, parentId: plan.parent });
    void run.run();
    return {
      turnId,
      messageId: msgId,
      events: run.events,
      result: run.result,
      stop: () => this.stop(turnId),
    };
  }

  submit(input: { text: string; expectedVersion: number; onError?: 'drop' | 'keep' }): TurnHandle {
    // Everything that does not depend on the new message is checked first, so a refusal writes
    // nothing at all (not even the user's line).
    this.guardWrite(input?.expectedVersion, { held: true });
    if (typeof input.text !== 'string') throw new Refusal('invalid_params', 'text must be a string');
    // runTurn's own params, validated as admitTurn will (§6.1: a refusal writes nothing).
    const onError = checkOnError(input.onError);
    resolvePrimary(this.ctx, this.config);
    resolvePreset(this.ctx, this.config.preset);
    const sent = this.send({ text: input.text, expectedVersion: input.expectedVersion });
    return this.runTurn({ kind: 'reply', expectedVersion: sent.version, onError });
  }

  stop(turnId?: string): void {
    const run = this.running;
    if (!run) return;
    if (turnId !== undefined && turnId !== run.turnId) return;
    run.stop('user_stop');
  }

  edit(input: { messageId: string; text: string; expectedVersion: number }): { version: number } {
    this.guardWrite(input?.expectedVersion);
    if (typeof input.text !== 'string') throw new Refusal('invalid_params', 'text must be a string');
    const idx = this.tree();
    this.mustExist(idx, input.messageId);
    // Non-text blocks (reasoning, tool rounds) stay; the text becomes the one new block.
    const keep = effectiveMessage(idx, input.messageId).blocks.filter((b) => b.k !== 'text');
    this.verbAppend({ t: 'edit', ts: this.now(), target: input.messageId, reason: 'user', blocks: [...keep, { k: 'text', text: input.text }] });
    this.publish({ type: 'changed', version: this.ver, change: 'edit', id: input.messageId });
    return { version: this.ver };
  }

  hide(input: { messageId: string; hidden: boolean; expectedVersion: number }): { version: number } {
    this.guardWrite(input?.expectedVersion);
    if (typeof input.hidden !== 'boolean') throw new Refusal('invalid_params', 'hidden must be a boolean');
    this.mustExist(this.tree(), input.messageId);
    this.verbAppend({ t: 'hide', ts: this.now(), target: input.messageId, hidden: input.hidden });
    this.publish({ type: 'changed', version: this.ver, change: 'hide', id: input.messageId });
    return { version: this.ver };
  }

  select(input: { messageId: string; expectedVersion: number; exact?: boolean }): { version: number } {
    this.guardWrite(input?.expectedVersion);
    if (input.exact !== undefined && typeof input.exact !== 'boolean') throw new Refusal('invalid_params', 'exact must be a boolean');
    const idx = this.tree();
    this.mustExist(idx, input.messageId);
    // exact: a rewind puts the head on the message itself (§5.5); else the newest message below it.
    const leaf = input.exact === true ? input.messageId : newestDescendant(idx, input.messageId);
    if (leaf === idx.head) return { version: this.ver }; // already there: no line, no new version
    this.verbAppend({ t: 'head', ts: this.now(), leaf });
    this.publish({ type: 'changed', version: this.ver, change: 'head', id: leaf });
    return { version: this.ver };
  }

  fork(input: { at: string }): string {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
    if (!isObject(input) || typeof input.at !== 'string') throw new Refusal('invalid_params', 'fork needs {at}');
    this.mustExist(this.tree(), input.at);
    for (let i = 0; i < ID_ATTEMPTS; i++) {
      const newId = newSessionId(this.ctx.random);
      try {
        const log = forkSession(this.ctx.home, { header: this.log.header, entries: this.log.entries() }, input.at, { newId, now: this.now() });
        log.close(); // not opened: the caller opens it with engine.session(id)
        return newId;
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith('session already exists')) throw e;
      }
    }
    throw new Error('could not find a free session id for the fork');
  }

  configure(patch: DeepPartial<SessionConfig>): void {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
    if (!isObject(patch)) throw new Refusal('invalid_params', 'configure needs an object');
    const next = mergePatch<SessionConfig>(this.config, patch);
    // A patch that would make the config unreadable is refused before it reaches the journal.
    const checked = checkHeader(JSON.parse(JSON.stringify({ ...this.log.header, config: next })) as unknown);
    if (!checked.ok) throw new Refusal('invalid_params', `invalid config: ${checked.why}`);
    this.verbAppend({ t: 'config', ts: this.now(), patch });
    this.config = next;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const run = this.running;
      if (run) {
        run.stop('shutdown');
        await run.result;
      }
      this.log.close();
      this.onClose(this);
    })();
    return this.closing;
  }

  // ---- helpers -----------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closing) throw new Error(`session ${this.id} is closed`);
  }

  /** busy → held → version, the shared preconditions of every write verb. */
  private guardWrite(expectedVersion: unknown, opts: { held?: boolean } = {}): void {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
    if (opts.held && this.held.size > 0) throw new Refusal('held_pending', 'an answer held by a conflict must be decided first');
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
      throw new Refusal('invalid_params', 'expectedVersion must be an integer');
    }
    if (expectedVersion !== this.ver) throw new Refusal('stale_version', `expected version ${expectedVersion}, the session is at ${this.ver}`);
  }

  private mustExist(idx: TreeIndex, id: unknown): void {
    if (typeof id !== 'string' || !idx.msgs.has(id)) throw new Refusal('not_found', `no message ${String(id)}`);
  }

  /** A message id not used in this session (a duplicate would silently vanish from the tree). */
  private freshMessageId(): string {
    const idx = this.tree();
    for (let i = 0; i < ID_ATTEMPTS; i++) {
      const id = newMessageId(this.ctx.random);
      if (!idx.msgs.has(id)) return id;
    }
    throw new Error('could not find a free message id');
  }

  private freshTurnId(): string {
    for (let i = 0; i < ID_ATTEMPTS; i++) {
      const id = newTurnId(this.ctx.random);
      if (!this.turnIds.has(id)) {
        this.turnIds.add(id);
        return id;
      }
    }
    throw new Error('could not find a free turn id');
  }

  private stamp(body: EventBody): Event {
    return { sessionId: this.id, ts: this.now(), ...body } as Event;
  }

  /** A session-level event (no turn): engine.events() only. */
  private publish(body: EventBody): void {
    this.ctx.bus.publish(this.stamp(body));
  }

  /** An event produced while opening: kept for openEvents() and published. */
  private openEvent(body: EventBody): void {
    const ev = this.stamp(body);
    this.opened.push(ev);
    this.ctx.bus.publish(ev);
  }
}
