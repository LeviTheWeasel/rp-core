// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One open session (ARCHITECTURE.md §5.3, §6.1, §12.1): the locked journal, the cached tree and
// PathView, the verbs, and at most one running turn. Every write goes through append() here, which
// keeps version(session) current without re-reading the log. Admission (admit.ts) and the turn's
// first line happen synchronously in runTurn; the rest of the turn runs in turn.ts. preview (M2)
// runs the same admission and request.ts buildRequest, and writes nothing.

import { normalizeName } from '../agents/compendium/apply.ts';
import { noteRefs, resolveNoteRef } from '../agents/compendium/notes.ts';
import type { CEntry } from '../agents/compendium/types.ts';
import { searchHistory, type HistorySearch } from '../tools/builtin/history.ts';
import { Refusal } from './api.ts';
import type { CreateSessionInput, PreviewOptions, PreviewResult, RunTurnOptions, SessionHandle, TurnHandle } from './api.ts';
import { admitTurn, checkOnError, resolvePreset, resolvePrimary } from './admit.ts';
import { effectiveText } from './commit.ts';
import { isoNow, type EngineCtx } from './context.ts';
import { firstRoundLast, modelRequest, roundFields } from './narrate.ts';
import { recoverSession, type RecoverJournal } from './recover.ts';
import { buildRequest, maxTokensFor } from './request.ts';
import { TurnRun, type EventBody, type TurnHost } from './turn.ts';
import { traceForSent } from '../prompt/assemble.ts';
import { isInsertSrc } from '../prompt/depth.ts';
import { CONTINUE_CUE_SRC, POST_PROCESSING_PLACEHOLDER_SRC } from '../prompt/shape.ts';
import { counterOf } from './ema.ts';
import { createMacroRun } from '../prompt/macros.ts';
import type { Event, Notice } from '../protocol/events.ts';
import {
  checkHeader,
  DEFAULT_SESSION_CONFIG,
  VERSIONED_KINDS,
  type DeepPartial,
  type Entry,
  type EntryInput,
  type EntryKind,
  type MemOp,
  type SessionConfig,
  type SessionHeader,
  type Trace,
  type TurnKind,
} from '../session/entries.ts';
import { currentConfig, foldView, foldViewAt, mergePatch } from '../session/fold.ts';
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
import type { MessageView, PathView } from '../session/view.ts';

/** How many fresh ids to draw before giving up on a collision (8 hex: practically never > 1). */
const ID_ATTEMPTS = 16;

/** PreviewOptions.draft becomes a user message with this id (message ids are 8 hex: never taken). */
export const DRAFT_ID = 'draft';

/** The view with an unsent user message appended as the head (PreviewOptions.draft). */
function withDraft(view: PathView, text: string): PathView {
  const draft: MessageView = {
    id: DRAFT_ID,
    parent: view.head,
    role: 'user',
    blocks: [{ k: 'text', text }],
    hidden: false,
    edited: false,
    swipe: { index: 0, count: 1 },
  };
  return { ...view, head: DRAFT_ID, path: [...view.path, draft], pathSet: new Set([...view.pathSet, DRAFT_ID]) };
}

/** What changed since a past answer's trace: its preset, and the books by key. Empty when nothing did. */
function inputsChanged(past: Trace, now: Trace): string[] {
  const out: string[] = [];
  if (past.presetHash !== now.presetHash) out.push('the preset');
  const was = past.loreHashes ?? {};
  const is = now.loreHashes ?? {};
  const keys = [...new Set([...Object.keys(was), ...Object.keys(is)])].sort();
  for (const k of keys) {
    if (was[k] === is[k]) continue;
    out.push(was[k] === undefined ? `lorebook ${k} (added)` : is[k] === undefined ? `lorebook ${k} (gone)` : `lorebook ${k}`);
  }
  return out;
}

/** Message sources only shaping adds (the post-processing placeholder, the continue cue). */
const SHAPING_SRCS: ReadonlySet<string> = new Set([POST_PROCESSING_PLACEHOLDER_SRC, CONTINUE_CUE_SRC]);

/** A chat message's source ('history' or 'history:…'), as assemble names it. */
const isHistorySrc = (src: string): boolean => src === 'history' || src.startsWith('history:');

/** What the past answer's request was built from, beyond its trace: decided by the caller from the journal. */
interface PastInputs {
  /** The path messages it was built from (ids, hidden state, text) differ from today's. */
  history: boolean;
  /** The preset or a lorebook changed (inputsChanged named it): it explains other blocks' text. */
  presetOrBooks: boolean;
  presetChanged: boolean;
  /** 'conn:model' of the answer, when its gen recorded the connection; today's. */
  model: { past?: string; now: string };
}

/**
 * What else changed since a past answer was sent (§6.1 preview --turn), read off the request rebuilt
 * today against the one its trace recorded (one row per message sent: src, role, tokens) and off the
 * journal: the history (an edit or a hidden message, compared by message id and text, never by the
 * rows: shaping merges history rows with other blocks), the cut of old messages (trace.trimmed), the
 * author's note and other in-chat inserts, the text of the system blocks when neither the preset nor
 * a book explains it, the shaping (rows merged or re-roled with the same parts in the same order:
 * the model's connection or the preset's post-processing), the window and the model. A row is split
 * on '+' into the parts shape() joined. Token counts are compared only when both were counted the
 * same way (an M1 trace counted chars) and the rows line up one to one. Empty when the rebuild matches.
 */
function sentChanged(past: Trace, now: Trace, inputs: PastInputs): string[] {
  const out: string[] = [];
  const sameCounter = counterOf(past) === counterOf(now);
  const pastRows = past.blocks ?? [];
  const nowRows = now.blocks ?? [];
  const parts = (src: string): string[] => src.split('+');
  const atoms = (rows: readonly { src: string }[], keep: (src: string) => boolean): string =>
    rows
      .flatMap((r) => parts(r.src))
      .filter(keep)
      .join('\u0001');
  const isInsert = (a: string): boolean => !isHistorySrc(a) && isInsertSrc(a);
  const isBlock = (a: string): boolean => !isHistorySrc(a) && !isInsertSrc(a) && !SHAPING_SRCS.has(a);
  const shape = (rows: readonly { src: string; role: string }[]): string => rows.map((r) => `${r.src}\u0000${r.role}`).join('\u0001');
  const sameShape = shape(pastRows) === shape(nowRows);

  let inserts = atoms(pastRows, isInsert) !== atoms(nowRows, isInsert);
  let blocks = atoms(pastRows, isBlock) !== atoms(nowRows, isBlock);
  if (sameShape && sameCounter) {
    // The rows line up: a row whose count moved changed its text (history rows: the journal decides).
    pastRows.forEach((r, i) => {
      if (r.tok === nowRows[i]!.tok) return;
      const p = parts(r.src);
      if (p.some(isInsert)) inserts = true;
      else if (p.some(isBlock)) blocks = true;
    });
  }
  // Same parts in the same order, grouped or roled otherwise (or a placeholder came or went): shaping.
  const noShaping = (a: string): boolean => !SHAPING_SRCS.has(a);
  const shaping =
    (!sameShape && atoms(pastRows, noShaping) === atoms(nowRows, noShaping)) || atoms(pastRows, (a) => SHAPING_SRCS.has(a)) !== atoms(nowRows, (a) => SHAPING_SRCS.has(a));
  const modelChanged = inputs.model.past !== undefined && inputs.model.past !== inputs.model.now;

  if (inputs.history) out.push('the history (an edit or a hidden message)');
  if (JSON.stringify(past.trimmed ?? null) !== JSON.stringify(now.trimmed ?? null)) out.push('which old messages the budget leaves out');
  if (inserts) out.push("the author's note or other in-chat inserts");
  if (blocks && !inputs.presetOrBooks) out.push('the text of the system blocks (the card, the persona or the lore that fired)');
  if (past.window !== now.window || past.reserve !== now.reserve) out.push(`the window (${past.window}/${past.reserve} then, ${now.window}/${now.reserve} now)`);
  if (modelChanged) out.push(`the model (${inputs.model.past} then)`);
  if (shaping) {
    const cause = modelChanged ? "the model's connection" : inputs.presetChanged ? "the preset's post-processing" : "the connection's capabilities";
    out.push(`how the messages are shaped (merged or re-roled: ${cause})`);
  }
  return out;
}

/**
 * The path messages a request up to `leaf` was built from, as of journal seq `seq` and as of now,
 * compared by message id, hidden state and content (an edit, a hide or an unhide since then).
 */
function historyChangedSince(entries: readonly Entry[], tree: TreeIndex, header: SessionHeader, leaf: string, seq: number): boolean {
  const key = (v: PathView): string => v.path.map((m) => `${m.id}\u0000${m.hidden ? 1 : 0}\u0000${JSON.stringify(m.blocks)}`).join('\u0001');
  const then = buildTree(entries.filter((e) => e.seq <= seq));
  if (!then.msgs.has(leaf)) return true;
  return key(foldViewAt(header, then, leaf)) !== key(foldViewAt(header, tree, leaf));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The path messages the head answer's request sent (§7.5 "(in context)"): every visible path
 * message before the head outside the budget's cut (its trace.trimmed {from, to}; a continue's own
 * trace when it has one). null when unknown: the head is not an answer with a trace, or the cut
 * names messages that are no longer on the path.
 */
export function sentByHeadRequest(view: PathView, tree: TreeIndex): ReadonlySet<string> | null {
  const head = view.path.at(-1);
  if (!head || head.role !== 'assistant') return null;
  let trace = tree.msgs.get(head.id)?.trace;
  for (const e of tree.edits.get(head.id) ?? []) if (e.reason === 'continue' && e.trace) trace = e.trace;
  if (!trace) return null;
  const before = view.path.slice(0, -1);
  const trimmed: unknown = trace.trimmed;
  let cut: [number, number] | null = null;
  if (trimmed !== null) {
    if (!isObject(trimmed)) return null;
    const from = before.findIndex((m) => m.id === trimmed.from);
    const to = before.findIndex((m) => m.id === trimmed.to);
    if (from < 0 || to < 0) return null;
    cut = [Math.min(from, to), Math.max(from, to)];
  }
  const sent = new Set<string>();
  before.forEach((m, i) => {
    if (m.hidden || (cut && i >= cut[0] && i <= cut[1])) return;
    sent.add(m.id);
  });
  return sent;
}

/** A note title as stored: trimmed; refused when it has no letter or digit (its key would be empty). */
function noteTitle(v: unknown): string {
  if (typeof v !== 'string') throw new Refusal('invalid_params', 'title must be a string');
  const title = v.trim();
  if (normalizeName(title) === '') throw new Refusal('invalid_params', 'a note title needs at least one letter or digit');
  return title;
}

/** A note's text as stored: trimmed, never empty. */
function noteContent(v: unknown): string {
  if (typeof v !== 'string') throw new Refusal('invalid_params', 'content must be a string');
  const content = v.trim();
  if (content === '') throw new Refusal('invalid_params', 'a note needs some text');
  return content;
}

/** Lore keys as stored: trimmed, blanks dropped, duplicates dropped (first kept). undefined when absent. */
function noteKeys(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) throw new Refusal('invalid_params', 'keys must be an array of strings');
  const keys: string[] = [];
  for (const k of v as string[]) {
    const key = k.trim();
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

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
  /** seq of the newest mem row: mem rows change the Compendium but not the version (§5.8 "Стоимость"). */
  private memSeq: number;
  private treeCache: { version: number; memSeq: number; idx: TreeIndex } | null = null;
  private viewCache: { version: number; memSeq: number; view: PathView } | null = null;
  private config: SessionConfig;
  private running: TurnRun | null = null;
  /** Turns left open with a `held` answer (M6 decides them); new turns are refused meanwhile. */
  private readonly held = new Set<string>();
  private readonly turnIds = new Set<string>();
  private readonly noticed = new Set<string>();
  /**
   * The next turn's seed, drawn early by a preview of it and kept until a turn takes it, so what is
   * seeded ({{random}}, {{pick}}, lore chance and groups) comes out in the turn as the preview showed.
   */
  private nextSeed: number | null = null;
  private readonly opened: Event[] = [];
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly ctx: EngineCtx,
    private readonly log: SessionLog,
    private readonly onClose: (s: SessionImpl) => void,
  ) {
    this.id = log.id;
    const entries = log.entries();
    const tree = buildTree(entries);
    this.ver = tree.version;
    this.memSeq = tree.lastMemSeq;
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
    const t = (e as { t: EntryKind }).t;
    if (VERSIONED_KINDS.has(t)) this.ver = e.seq;
    else if (t === 'mem') this.memSeq = e.seq;
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
    // Versioned entries change the tree and mem rows its `mems`: (version, memSeq) is a complete key.
    const c = this.treeCache;
    if (c?.version === this.ver && c.memSeq === this.memSeq) return c.idx;
    const idx = buildTree(this.log.entries());
    this.treeCache = { version: this.ver, memSeq: this.memSeq, idx };
    return idx;
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
    // Cached like the tree: a mem row (a note) changes view().compendium without a new version.
    const c = this.viewCache;
    if (c?.version === this.ver && c.memSeq === this.memSeq) return c.view;
    const view = foldView(this.log.header, this.log.entries(), this.tree());
    this.viewCache = { version: this.ver, memSeq: this.memSeq, view };
    return view;
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
      // The seed a preview already drew for this turn, else a fresh one (§6.2 step 2).
      seed: this.nextSeed ?? newSeed(this.ctx.random),
      now,
      base: this.ver,
    });
    this.nextSeed = null;
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

  /**
   * M2 (§6.1, §12.4 /preview): the request a turn would send, built by the turn's own buildRequest.
   * Refusals come back as ok:false; nothing is written, the version and the head stay, the
   * session's once-per-session notices stay untold (a preview shows every notice). Works while a
   * turn runs: it reads the current view.
   */
  preview(opts?: PreviewOptions): PreviewResult {
    this.assertOpen();
    try {
      return this.buildPreview(opts ?? {});
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  private buildPreview(opts: PreviewOptions): PreviewResult {
    if (!isObject(opts)) throw new Refusal('invalid_params', 'preview options must be an object');
    if (opts.draft !== undefined && typeof opts.draft !== 'string') throw new Refusal('invalid_params', 'draft must be a string');
    if (opts.turn !== undefined && typeof opts.turn !== 'string') throw new Refusal('invalid_params', 'turn must be a message id');
    if (opts.explain !== undefined && typeof opts.explain !== 'boolean') throw new Refusal('invalid_params', 'explain must be a boolean');
    if (opts.draft !== undefined && opts.turn !== undefined) throw new Refusal('invalid_params', 'draft and turn exclude each other');

    const header = this.log.header;
    const tree = this.tree();
    const current = this.view();
    let view = current;
    // The kind admission checks, and the kind the request is built as (a past swipe is admitted as
    // the reply to its U: same prompt).
    let admitKind: TurnKind;
    let kind: TurnKind | undefined;
    // A past answer's own seed; else the next turn's, drawn once admission passed.
    let seed: number | undefined;
    let now: string;
    let past: Trace | undefined;
    let guided: { guidance: string; rejected?: string } | undefined;

    if (opts.turn !== undefined) {
      // A past answer: the path up to the user message it answers, that turn's seed and clock.
      const id = opts.turn;
      const entry = tree.msgs.get(id);
      if (!entry) throw new Refusal('not_found', `no message ${id}`);
      const m = current.path.find((x) => x.id === id);
      if (!m) throw new Refusal('invalid_params', `message ${id} is not on the active path`);
      if (m.role !== 'assistant' || m.parent === null || entry.gen?.kind !== 'model' || !entry.trace) {
        throw new Refusal('invalid_params', `message ${id} is not a model answer with a trace`);
      }
      past = entry.trace;
      seed = past.seed;
      now = past.now;
      view = foldViewAt(header, tree, m.parent);
      admitKind = 'reply';
      kind = m.swipe.index > 0 ? 'swipe' : 'reply';
      // A guided re-roll is rebuilt with its direction (gen.guidance) and, when today's config shows
      // it, the text of the answer it replaced (the turn's target) as that answer reads now.
      const guidance = entry.gen.guidance;
      if (guidance) {
        guided = { guidance };
        const turn = entry.turn === undefined ? undefined : this.log.entries().find((e) => e.t === 'turn' && e.turn === entry.turn);
        const target = turn?.t === 'turn' ? turn.target : undefined;
        if (this.config.swipe.showRejected && target !== undefined && tree.msgs.has(target)) guided.rejected = effectiveText(tree, target);
      }
    } else if (opts.draft !== undefined) {
      view = withDraft(current, opts.draft);
      admitKind = 'reply';
      now = this.now();
    } else {
      // What the next turn would be: a reply to a user head, else a swipe of the head answer (/r).
      admitKind = current.path.at(-1)?.role === 'user' ? 'reply' : 'swipe';
      now = this.now();
    }

    // The turn's admission (§6.2 step 1), minus what is about writing: a preview never waits for a
    // running turn or a held answer, and has no version to be stale against.
    const admitted = admitTurn(this.ctx, { busy: false, heldOpen: false, version: this.ver, view, config: this.config }, { kind: admitKind, expectedVersion: this.ver });
    const plan = kind === undefined ? admitted : { ...admitted, kind, ...guided };
    seed ??= this.seedOfNextTurn();
    const explain = opts.explain === true;

    const built = buildRequest({
      home: this.ctx.home,
      sessionId: this.id,
      header,
      tree,
      view,
      plan,
      seed,
      now,
      timeZone: this.ctx.timeZone,
      counter: this.ctx.counter,
      // M4: the Director's stub directive goes here; the Director is never called by a preview.
      placements: [],
      ...(explain ? { explain: true } : {}),
      ...(this.ctx.toolSets ? { toolSets: this.ctx.toolSets } : {}),
    });
    if (!built.ok) {
      // A shape failure is the request failing to build, as assemble's own.
      return { ok: false, code: built.code === 'shape_failed' ? 'assemble_failed' : built.code, message: built.message };
    }

    // Every notice once (by its key), none of them marked as told: the next turn still tells them.
    const notices: Notice[] = [];
    const keys = new Set<string>();
    for (const n of built.notices) {
      if (keys.has(n.key)) continue;
      keys.add(n.key);
      notices.push(n.notice);
    }
    const native = built.tools?.transport === 'native' ? built.tools.specs : undefined;
    const sent = traceForSent(built.asm.trace, built.shaped.messages, built.shaped.prefill, native);
    if (past && opts.turn !== undefined) {
      const answer = tree.msgs.get(opts.turn)!;
      const was = answer.gen;
      const named = inputsChanged(past, built.asm.trace);
      const changed = [
        ...named,
        ...sentChanged(past, sent, {
          history: historyChangedSince(this.log.entries(), tree, header, answer.parent!, answer.seq),
          presetOrBooks: named.length > 0,
          presetChanged: past.presetHash !== built.asm.trace.presetHash,
          model: {
            ...(was?.connection !== undefined ? { past: `${was.connection}:${was.model ?? '?'}` } : {}),
            now: `${plan.primary.conn.id}:${plan.primary.model}`,
          },
        }),
      ];
      if (changed.length > 0) {
        notices.push({
          level: 'info',
          code: 'preview_inputs_changed',
          message: `Since this answer was written, ${changed.join(', ')} changed: the preview is built with today's.`,
        });
      }
    }

    const { primary } = plan;
    const { asm, shaped } = built;
    const maxTokens = maxTokensFor(primary, built.reserve);
    const samplers = built.limits.samplers;
    const prefill = shaped.prefill !== undefined && shaped.prefill !== '' ? shaped.prefill : null;
    const out: Extract<PreviewResult, { ok: true }> = {
      ok: true,
      kind: plan.kind,
      upTo: plan.upTo,
      model: { connection: primary.conn.id, model: primary.model },
      messages: shaped.messages,
      prefill,
      tools: asm.tools,
      maxTokens,
      samplers,
      trace: sent,
      notices,
    };
    if (explain) {
      out.verdicts = asm.verdicts ?? [];
      if (asm.loreUse) out.loreUse = asm.loreUse;
    }
    // What the connection drops from the request (openai-chat samplerFields / stopField read the same caps).
    const spec = primary.caps.samplers;
    const notSent = Object.keys(samplers).filter((k) => (samplers as Record<string, unknown>)[k] !== undefined && (spec.fixed === true || !spec.accepted.includes(k)));
    if (notSent.length > 0) out.samplersNotSent = notSent;

    // The HTTP body the primary connection would send (no headers: they carry the key): round 0 of
    // the turn, its tools, tool_choice, stop list and reasoning setting included (M3).
    const provider = primary.conn.provider;
    if (provider.wire) {
      const reasoning = plan.binding.reasoning;
      const req = modelRequest(
        {
          conn: primary.conn,
          model: primary.model,
          caps: primary.caps,
          messages: shaped.messages,
          ...(shaped.prefill !== undefined && built.tools === null ? { prefill: shaped.prefill } : {}),
          maxTokens,
          samplers,
          ...(reasoning ? { reasoning } : {}),
          callKey: 'preview:narrator:0',
          ...roundFields(built.tools, primary.caps, samplers, firstRoundLast(built.tools, plan.maxRounds)),
        },
        new AbortController().signal,
      );
      try {
        out.wire = provider.wire(req);
      } catch (e) {
        notices.push({ level: 'warn', code: 'wire_unavailable', message: `The wire request cannot be built: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return out;
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

  /** The next turn's seed, drawn once and kept for it (only a turn's `turn` line consumes it). */
  private seedOfNextTurn(): number {
    this.nextSeed ??= newSeed(this.ctx.random);
    return this.nextSeed;
  }

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

  // ---- M3: history search and notes (§7.5, §5.8) ----------------------------------------------------

  /**
   * §7.5 /search: the narrator's search_history over the current path (read-only, also while a turn
   * runs). A hit is "in context" when the head answer's request sent it; unknown counts as not.
   */
  search(input: { query: string; before?: number; limit?: number }): HistorySearch {
    this.assertOpen();
    if (!isObject(input) || typeof input.query !== 'string') throw new Refusal('invalid_params', 'search needs {query}');
    const { before, limit } = input;
    if (before !== undefined && !(Number.isSafeInteger(before) && before >= 1)) throw new Refusal('invalid_params', 'before must be a positive integer');
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1)) throw new Refusal('invalid_params', 'limit must be a positive integer');
    const view = this.view();
    const sent = sentByHeadRequest(view, this.tree());
    const { character, persona } = this.log.header.cast;
    return searchHistory(view, null, input.query, {
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
      names: { char: character.name, user: persona?.name || 'User' },
      inContext: (id) => sent?.has(id) === true,
    });
  }

  notes(): CEntry[] {
    this.assertOpen();
    return noteRefs(this.view().compendium).map((r) => r.entry);
  }

  memoryAdd(input: { title: string; keys?: string[]; content: string }): { key: string } {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryAdd needs {title, content}');
    const title = noteTitle(input.title);
    const content = noteContent(input.content);
    const keys = noteKeys(input.keys) ?? [];
    const row = this.memAppend({ op: 'note', title, keys: keys.length > 0 ? keys : [title], content });
    // The fold names the note (its key may carry '#2' when the title's key is taken).
    let note: CEntry | undefined;
    for (const e of this.view().compendium.entries.values()) if (e.prov.createdSeq === row.seq) note = e;
    if (!note) throw new Error(`the note written at seq ${row.seq} did not fold`);
    this.publishMemory('note', note);
    return { key: note.key };
  }

  memoryEdit(input: { ref: string; title?: string; keys?: string[]; content?: string }): { key: string } {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryEdit needs {ref}');
    const title = input.title === undefined ? undefined : noteTitle(input.title);
    const content = input.content === undefined ? undefined : noteContent(input.content);
    const keys = noteKeys(input.keys);
    if (title === undefined && content === undefined && keys === undefined) {
      throw new Refusal('invalid_params', 'nothing to change: give a title, keys or content');
    }
    const note = this.findNote(input.ref, 'live');
    const set: Record<string, unknown> = {};
    if (title !== undefined) set.title = title;
    if (content !== undefined) set.content = content;
    // A rename without keys moves the key a keyless add derived from the title (stored keys exactly
    // [old title]) to the new title, so the note fires on its new name; keys the user wrote stay.
    const autoKey = keys === undefined && title !== undefined && title !== note.name && note.keys.length === 1 && note.keys[0] === note.name;
    this.memAppend({
      op: 'edit',
      ref: note.key,
      ...(Object.keys(set).length > 0 ? { set } : {}),
      // Keys emptied by the trim fall back to the title, as on add.
      ...(keys !== undefined ? { keys: keys.length > 0 ? keys : [title ?? note.name] } : autoKey ? { keys: [title] } : {}),
    });
    this.publishMemory('edited', this.view().compendium.entries.get(note.key) ?? note);
    return { key: note.key };
  }

  memoryRetire(input: { ref: string; reason?: string }): { key: string } {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryRetire needs {ref}');
    if (input.reason !== undefined && typeof input.reason !== 'string') throw new Refusal('invalid_params', 'reason must be a string');
    const note = this.findNote(input.ref, 'live');
    if (note.retired) throw new Refusal('invalid_params', `the note ${JSON.stringify(note.name)} is already retired`);
    this.memAppend({ op: 'retire', ref: note.key, reason: (input.reason ?? '').trim() });
    this.publishMemory('retired', note);
    return { key: note.key };
  }

  memoryRestore(input: { ref: string }): { key: string } {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryRestore needs {ref}');
    const note = this.findNote(input.ref, 'retired');
    if (!note.retired) throw new Refusal('invalid_params', `the note ${JSON.stringify(note.name)} is not retired`);
    this.memAppend({ op: 'restore', ref: note.key });
    this.publishMemory('restored', note);
    return { key: note.key };
  }

  /** The memory verbs' preconditions: an open session and no running turn. */
  private guardMemory(): void {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
  }

  /** The note a ref names on the current path (C<n>, key or title, see resolveNoteRef), else not_found. */
  private findNote(ref: unknown, prefer: 'live' | 'retired'): CEntry {
    if (typeof ref !== 'string' || ref.trim() === '') throw new Refusal('invalid_params', 'ref must be a note handle (C<n>), key or title');
    const note = resolveNoteRef(this.view().compendium, ref, prefer);
    if (!note) throw new Refusal('not_found', `no single note matches ${JSON.stringify(ref)} (use its C<n> handle or key)`);
    return note;
  }

  /** One durable human mem row with one op (§5.8, decision F1); the version does not move. */
  private memAppend(op: MemOp): { seq: number } {
    return this.verbAppend({ t: 'mem', ts: this.now(), key: null, on: null, by: 'user', ops: [op] });
  }

  private publishMemory(change: 'note' | 'edited' | 'retired' | 'restored', note: CEntry): void {
    this.publish({ type: 'memory', change, ref: note.key, kind: 'note', name: note.name, by: 'user' });
  }
}
