// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The canonical library API (ARCHITECTURE.md §6.1, §12.1). REPL, one-shot, --stdio (M6) and
// Bunraku (M9) are thin clients of exactly this. CONTRACT FILE (types only): the engine agent
// implements it in engine.ts; the CLI agent codes against it.

import type { Character, ImportWarning, Persona, Samplers } from '../formats/native.ts';
import type { CEntry, CompendiumView, EntryType, Rec } from '../agents/compendium/types.ts';
import type { TreeNode } from '../agents/compendium/tree.ts';
import type { HistorySearch } from '../tools/builtin/history.ts';
import type { LoreVerdict } from '../lore/engine.ts';
import type { ModelCaps, PromptMsg, Provider, ProviderError, ToolSpec } from '../providers/types.ts';
import type { DeepPartial, RecallRecord, SessionConfig, SessionHeader, Trace, TurnKind } from '../session/entries.ts';
import type { MessageView, PathView } from '../session/view.ts';
import type { Event, Notice } from '../protocol/events.ts';
import type { RandomBytes } from '../session/ids.ts';
import type { DelayTimers } from './abort.ts';

/** A configured model endpoint. M1a only has scripted connections; openai-chat arrives in M1b. */
export interface Connection {
  id: string;
  provider: Provider;
  caps: ModelCaps;
  /** scheme://host:port for HTTP providers; `script:<id>` for in-process ones. The semaphore key. */
  origin: string;
  /** Local origins get the local defaults (8192 window, 600 s first byte, 1 in flight). */
  local: boolean;
  key?: string | null;
  /**
   * M1b: caps of one model on this connection (host preset → model rows → catalog → probe cache →
   * user overrides, §8.2). When absent the engine uses `caps`.
   */
  capsFor?(model: string): ModelCaps;
  /**
   * M1b: the API key, resolved lazily at the first call (key_env / key_cmd, D-73). Rejects with a
   * ProviderError code 'key_unavailable'. When absent the engine uses `key`.
   */
  resolveKey?(): Promise<string | null>;
  /** M1b: the dialect and base URL, for probes and display. Absent for in-process providers. */
  dialect?: ModelCaps['dialect'];
  baseUrl?: string;
}

export interface EngineOptions {
  /** ~/.rp-core by default (CLI resolves --home / RP_CORE_HOME). */
  home: string;
  connections?: Record<string, Connection>;
  /**
   * CLI `--provider script:<file>`: every role resolves to this connection for this process,
   * whatever the session's bindings say. Recorded in gen.connection as its id.
   */
  providerOverride?: Connection;
  clock?: () => Date;
  random?: RandomBytes;
  timeZone?: string;
  fetch?: typeof fetch;
  /** Checkpoint cadence (§6.2 step 8). Defaults 400 chars / 1000 ms / datasync 2000 ms. Tests shrink them. */
  checkpoint?: { chars?: number; ms?: number; datasyncMs?: number };
  /** Retry backoff cap in ms (§6.6: retry-after capped at 8 s). Tests shrink it. */
  retryMaxDelayMs?: number;
  /**
   * §8.8 call timeouts in ms. Defaults: first byte 600 s on a local connection, 120 s otherwise;
   * idle (no bytes mid-stream) 120 s. Both count body bytes, SSE keep-alive comments included, so a
   * server that keeps the stream alive is never timed out. Tests and hosts with slow local models
   * change them.
   */
  timeouts?: { firstByteMs?: number; idleMs?: number };
  /**
   * M1b: [prices."conn:model"] from config.toml (USD per million tokens). usage events use the
   * provider-reported cost first, then this table, else null (never 0) (§11).
   */
  prices?: Record<string, { inPerM: number; outPerM: number; asOf: string }>;
  /** The timers behind checkpoints, call timeouts and retry delays. Tests inject fake ones. */
  timers?: DelayTimers;
  /**
   * M1b: every provider failure of a model call (retried and tail failures too), with the server's
   * raw words in `error.detail`. Live only, for a host's debug output (the CLI's --debug, §13): the
   * engine never stores that text or puts it in an event, whose message is the fixed one of the code.
   * M5b: a call of the background lane (filing, the historian) has no `turnId`; it names its `job`.
   */
  onProviderError?(info: { sessionId: string; turnId?: string; job?: string; callKey: string; model: string; error: ProviderError }): void;
  /**
   * M5a (D-164, CLI --keep-requests): every provider request of a turn (narrator rounds, the
   * Director, any agent; never a preview) is written as pretty JSON to
   * <home>/sessions/<sessionId>.requests/<callKey>.json, each character of the callKey outside
   * [A-Za-z0-9._-] replaced by '_'. What is written is the engine's provider-level request, the
   * ModelRequest a provider receives (model {connection, model}, caps, messages as PromptMsg with
   * src and blocks, tools, toolChoice, prefill, maxTokens, samplers, stop, reasoning, responseSchema,
   * callKey, agent) — not the HTTP body the provider then builds from it (/preview --wire shows that
   * one). Never in it: headers, keys, the abort signal, and the messages' `replay` payloads (provider
   * data a tool loop sends back, kept in memory only). A call key that comes again (a retry, a
   * fallback's round 0) never overwrites: the 2nd request goes to <callKey>-2.json, the 3rd to
   * <callKey>-3.json, and so on. Off by default.
   */
  keepRequests?: boolean;
  /**
   * M5b (.notes/m5b-decisions.md D-171, the lead's ruling G): the background lane's mode. 'auto' runs
   * the Compendium's filing and historian tasks by itself; 'manual' never starts one (tests, demos):
   * SessionHandle.memoryWait runs them. Default: 'manual' when the process environment has
   * RP_CORE_LANE=manual (read once when the engine opens), else 'auto'.
   */
  lane?: 'auto' | 'manual';
}

export type RefusalCode =
  | 'stale_version'
  | 'session_busy'
  | 'session_locked'
  | 'session_not_found'
  | 'held_pending'
  | 'no_connection'
  | 'preset_missing'
  | 'nothing_to_reply'
  | 'nothing_to_swipe'
  | 'nothing_to_continue'
  | 'continue_target_hidden'
  | 'continue_target_blank'
  | 'gate_unsupported'
  | 'invalid_params'
  | 'not_found';

/** Thrown synchronously, before any `turn` entry is written (§6.1). One-shot exit code 5. */
export class Refusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message?: string) {
    super(message ?? code);
    this.name = 'Refusal';
    this.code = code;
  }
}

/** M5a (D-159): one Compendium entry as memoryList lists it. */
export interface MemoryRow {
  /** Its handle C<n> (D-150). */
  ref: string;
  key: string;
  type: EntryType | 'note' | 'arc';
  name: string;
  aliases: string[];
  /** '' for notes and arcs. */
  tagline: string;
  /** 'session', or the library book (its library id) and the entry's id there. */
  origin: 'session' | { book: string; id: string };
  retired?: { reason: string };
  /** JSON characters of the entry's data; a note's or an arc's: the length of its text. */
  size: number;
  featured?: true;
  /** A library entry changed by this session's rows. */
  overlay?: true;
}

/** M5a (the lead's rulings after the review): what a writing memory verb did. */
export interface MemoryWrite {
  /** The entry's key (CEntry.key). */
  key: string;
  /**
   * false: the dry run showed the change is already there (an edit that changes nothing, a restore
   * of a live entry, a file that merges nothing new), so no row was written and no event published.
   */
  changed: boolean;
  /**
   * The Compendium's notices (compendium_large_entry, library_entry_missing) not yet told in this
   * open session, for the caller to show; returning them is what tells them (the next turn will not).
   * Returned whether or not the verb changed anything (changed:false too), so a caller shows them on
   * every path. Absent when there are none, and while the Compendium is disabled.
   */
  notices?: Notice[];
}

/** M5b (D-180): one task of the session's background lane. */
export interface LaneTaskInfo {
  /** 'file:<the group's last answer id>' or 'hist:<first new message id>-<last message id>'. */
  key: string;
  task: 'file' | 'hist';
  /** The message its row is bound to: the group's last answer, the window's last message. */
  on: string;
  /** The first and last path message it covers. */
  range: [string, string];
  /** The attempt its next (or current) run is: the failures since the key's last row or retry, plus one. */
  attempt: number;
}

/** M5b (D-180): what memoryStatus says about the lane. */
export interface MemoryStatus {
  /** Tasks waiting, in the order the lane runs them. */
  queued: LaneTaskInfo[];
  /**
   * The task running now and its job id. `waiting`: begun (its job{begin} is written) but none of its
   * calls has a place on the server yet (the local idle gate, a turn's calls): nothing was sent.
   */
  running?: LaneTaskInfo & { job: string; waiting?: true };
  /**
   * Keys on the active path parked after maxAttempts failed attempts, until memoryRetry; `code`: the
   * last failure's ('no_room': a task the recorder's window can never hold, parked at its first
   * failure). A historian window that is no longer due (its key moved) or that another pass covered is
   * not listed (the lead's ruling I), nor a filing key whose answers are all hidden, filed by another
   * key's row or owed under another key (ruling K).
   */
  parked: { key: string; on: string; failures: number; code?: string }[];
  /** Tasks asked for by name (a refile, a retry) whose agent is off: they wait for it (ruling I). Absent when none. */
  held?: LaneTaskInfo[];
  /** Accepted answers no filing row covers yet (D-171), queued or waiting for their group. */
  backlog: number;
  /**
   * The lead's ruling K (cli#1, cli#9): why the lane cannot start a task, for the agents that are on
   * ('both': filing and the historian). 'no_route': the recorder's connection or model cannot be
   * resolved, nothing runs until it can (notice recorder_unavailable, once, while work is owed);
   * 'paused': two tasks of the agent parked in a row (the circuit breaker, notice memory_paused once per
   * agent): no new task of it starts until memoryRetry or the next open. Its tasks stay in `queued`.
   * `message`: the same in words (a sentence). Absent when nothing stops the lane.
   */
  blocked?: { agent: 'filing' | 'historian' | 'both'; reason: 'no_route' | 'paused'; message: string };
  /**
   * M5c (.notes/m5c-decisions.md D-202, the lead's ruling H): the recall prefetch for the next reply. It
   * is a lane slot, not a task: never in `queued` or `running`. Absent when none is wanted (a manual
   * lane, the Compendium off or without a live typed entry, a recall mode that does not prefetch on this
   * origin, a head that is neither an answer nor a player's message answering one). `on`: the answer it
   * is computed after; `basis`: what a turn must match to adopt it (engine/recall.ts prefetchBasis).
   * `queued`: owed, not begun (it starts after the running task, at background priority past the idle
   * gate); `running`: begun (its call may still wait for a place on the server); `ready`: its record is
   * held for the next reply on that basis (a `failed` record too: the turn then falls back per onMiss).
   */
  prefetch?: { basis: string; on: string; state: 'queued' | 'running' | 'ready'; record?: RecallRecord };
}

/** M5b (D-180): what memoryUndo, memoryRefile and memoryRetry did. */
export interface MemoryLaneWrite {
  /** The task keys reverted, queued or retried. */
  keys: string[];
  /** false: nothing written or queued (already reverted, queued or running; nothing parked). */
  changed: boolean;
}

export interface CreateSessionInput {
  character: Character;
  persona?: Persona;
  config?: DeepPartial<SessionConfig>;
  title?: string;
}

export interface RunTurnOptions {
  kind: TurnKind;
  expectedVersion: number;
  /** Guided re-roll text (swipe only, <= 10 000 chars) [D-38]. */
  guidance?: string;
  /** 'conn:model' of a one-shot fallback (§6.6). */
  fallback?: string;
  /** Failure after output started: 'drop' (engine default) or 'keep' as interrupted (CLI) [D-22]. */
  onError?: 'drop' | 'keep';
  /** Reasoning-only answer: 'fail' (default) or 'keep' [D-31]. */
  emptyReply?: 'fail' | 'keep';
}

export type TurnOutcome =
  | { type: 'done'; message: MessageView }
  | { type: 'stopped'; message: MessageView | null }
  | {
      type: 'failed';
      category: string;
      code: string;
      message: string;
      draft: string;
      /**
       * 'conn:model' of the model call whose failure this is (the fallback's when it ran and failed);
       * absent when no model call failed (a refusal before the call, a conflict, an internal error).
       */
      route?: string;
    }
  | { type: 'conflict'; draft: string };

export interface TurnHandle {
  readonly turnId: string;
  /** reply/swipe: the new message id; continue: the target id. */
  readonly messageId: string;
  /** This turn's events, from `start` to the terminal event; then the iterator ends. Single consumer. */
  readonly events: AsyncIterable<Event>;
  /** Settles with the terminal outcome (never rejects for provider failures). */
  readonly result: Promise<TurnOutcome>;
  /** Same as session.stop(turnId). */
  stop(): void;
}

/** M2 (§6.1 `preview`, §12.4 /preview, /lore test) [D-45]. */
export interface PreviewOptions {
  /**
   * A user message that is not sent: the prompt of a reply to it, as if it were the head. Without
   * it the preview is of what the next turn would send: a reply when the head is a user message,
   * else a swipe of the head answer.
   */
  draft?: string;
  /**
   * Rebuild the prompt of this past answer (an assistant message id on the path): the path up to
   * the user message it answers, its turn's seed and clock from its trace, today's preset, books
   * and config (a notice 'preview_inputs_changed' says so when their hashes differ from the trace).
   */
  turn?: string;
  /** Also recompute the lore verdicts. */
  explain?: boolean;
}

export type PreviewResult =
  | {
      ok: true;
      kind: TurnKind;
      /** The message the request is built up to (U, or A for a continue); 'draft' for a draft. */
      upTo: string;
      model: { connection: string; model: string };
      /** Exactly what the primary model would get: assemble, then shape. */
      messages: PromptMsg[];
      prefill: string | null;
      tools: ToolSpec[];
      maxTokens: number;
      /** The samplers of the request (preset and binding), as the request carries them. */
      samplers: Partial<Samplers>;
      /**
       * M2 (fix): the names among `samplers` the primary connection's caps do not send
       * (caps.samplers.accepted, or all of them when the model's sampling is fixed). Absent when none.
       */
      samplersNotSent?: string[];
      trace: Trace;
      notices: Notice[];
      verdicts?: LoreVerdict[];
      /**
       * M2 (final fix), with explain: the lore budget as the run used it, in budget tokens (raw
       * counts × factor, the model's EMA correction; factor 1 = none yet). The verdicts' rawTokens
       * are the raw counts the request rows show.
       */
      loreUse?: { used: number; factor: number };
      /** Provider.wire() of the primary connection, when it has one (no headers). */
      wire?: { url: string; body: unknown };
    }
  | { ok: false; code: RefusalCode | 'context_length_exceeded' | 'preset_invalid' | 'assemble_failed'; message: string };

export interface SessionHandle {
  readonly id: string;
  header(): SessionHeader;
  /** Replace this session's persona for future turns; preserves the journal's past. */
  setPersona(persona: Persona): void;
  /** Name this story, or the branch through `leaf`. Names survive reopening. */
  name(title: string, leaf?: string): void;
  /** version(session) (§5.3). */
  version(): number;
  /**
   * The PathView at the current head (cached per version). M5a: its Compendium is folded with the
   * library seed (the session's readable books, D-141).
   */
  view(): PathView;
  /** True while a turn is running. */
  busy(): boolean;
  /** Events produced while opening: `recovered` per resolved turn, `notice` for torn/bad lines. */
  openEvents(): Event[];

  /** Append one user message under the head (or under greeting `greetingIndex`). Refusal: stale_version, session_busy, held_pending. */
  send(input: { text: string; expectedVersion: number; greetingIndex?: number }): { messageId: string; version: number };
  /** Admission is synchronous: throws Refusal before writing anything. */
  runTurn(opts: RunTurnOptions): TurnHandle;
  /** send + runTurn('reply'). */
  submit(input: { text: string; expectedVersion: number; onError?: 'drop' | 'keep' }): TurnHandle;
  /** Stop the running turn (or the given one). No-op when nothing runs. */
  stop(turnId?: string): void;
  /** Resolve a completed answer held because the history changed during its turn. */
  commitAnyway(turnId: string): { outcome: 'committed' | 'dropped' | 'discarded'; version: number; message?: MessageView };
  /** Throw away a held answer. */
  discard(turnId: string): { discarded: string };

  /** M1a refuses these with session_busy while a turn runs (conflict handling is M6). */
  edit(input: { messageId: string; text: string; expectedVersion: number }): { version: number };
  hide(input: { messageId: string; hidden: boolean; expectedVersion: number }): { version: number };
  /**
   * Move the head to the newest descendant of `messageId` (select a swipe, go to a tail). With
   * `exact: true` the head goes to `messageId` itself: a rewind (§5.5), after which the next message
   * starts a new branch and the old continuation becomes a tail. On a straight path the newest
   * descendant of every message is the head, so only the exact form can rewind.
   */
  select(input: { messageId: string; expectedVersion: number; exact?: boolean }): { version: number };
  /** Copy the path up to `at` into a new session; returns the new session id (not opened). */
  fork(input: { at: string }): string;
  /**
   * Append a config entry (does not change the version). M5a: `{compendium: {enabled}}` switches the
   * Compendium for this session; view(), compendium(), the memory verbs, a preview and the next turn
   * read the new value at once. A patch's `compendium` fields are checked with config.toml's ranges
   * (camelCase names; invalid_params with the dotted path).
   */
  configure(patch: DeepPartial<SessionConfig>): void;
  /**
   * M2: build the request a turn would send, without sending or writing anything (§6.1). Same path
   * as a turn: the same admission checks (as ok:false, never thrown), assemble and shape; the
   * Director is never called. M4 (D-106): while it is on, the request carries its contract and, at
   * depth 1, the directive the turn would carry when it is known (a swipe that reuses the plan) or a
   * stub; a past answer's preview (`turn`) re-renders that answer's stored directive.
   */
  preview(opts?: PreviewOptions): PreviewResult;

  /**
   * M3 (§7.5, /search, history/search): search the active path's visible messages (the same search
   * the narrator's search_history runs). `before`: only messages numbered below it (#n from 1, the
   * greeting #1). `inContext` marks hits whose text the last request sent (the head answer's trace
   * rows), or false when unknown. Read-only: works while a turn runs.
   */
  search(input: { query: string; before?: number; limit?: number }): HistorySearch;

  /** M3 (§5.8): the notes of the current path in creation order, live and retired. */
  notes(): CEntry[];
  /**
   * M3: add a note (one human `mem` row, on:null, op 'note'). keys default to [title]. Returns its
   * key. Refusals: session_busy during a turn; invalid_params for an empty title or content, or a
   * title with no letters or digits. Publishes a `memory` event {change:'note', kind:'note', by:'user'}.
   * M5a: returns the Compendium's untold notices too (MemoryWrite; `changed` is always true).
   */
  memoryAdd(input: { title: string; keys?: string[]; content: string }): MemoryWrite;
  /**
   * M5a (D-144, D-159, D-168): file a typed entry (op 'file'): merged into the live entry of that
   * type it names (session first, then the library: a library entry becomes an overlay), else
   * created. A summary is always new. The row stores the key its dry run found (op.target), so it
   * keeps addressing that entry whatever books are attached, set to 'read' or enabled later.
   * Refusals (nothing written): invalid_params with the reason in words for an unknown type, data
   * that is not an object, a missing required field, a name that is a plain entry of a readable book
   * (classic_conflict), a merge that would give the entry a name (an alias) another live entry of the
   * type answers to (not for summaries); session_busy during a turn. A merge that adds nothing writes
   * nothing (changed:false). Event change 'created' or 'merged', kind = the type.
   */
  memoryFile(input: { type: EntryType; data: Rec }): MemoryWrite & { ref: string; change: 'created' | 'merged' };
  /**
   * Change an entry (op 'edit'; its key stays). A note takes title, keys, content and featured (M3);
   * a typed entry, a library entry (it becomes an overlay; the book file is never written) and an arc
   * take set (top-level data fields replaced; the identity field renames), unset, keys and featured
   * (an arc's set.content replaces its overview). not_found for an unknown ref; invalid_params for a
   * change the fold would refuse, said in words, and for a rename, a new alias (or a title or topic
   * field) onto a name (name, alias or former name) another live entry of the same type answers to
   * (summaries are exempt: they never merge by name). An edit that changes nothing writes nothing
   * (changed:false); `set.aliases` equal to the aliases the entry already shows is no change. Event
   * change 'edited'.
   */
  memoryEdit(input: { ref: string; title?: string; keys?: string[]; content?: string; set?: Rec; unset?: string[]; featured?: boolean }): MemoryWrite;
  /**
   * Retire any entry (op 'retire'): it leaves the block, the tools and the lore. Event change
   * 'retired'. An entry already retired is refused (invalid_params "… is already retired").
   */
  memoryRetire(input: { ref: string; reason?: string }): MemoryWrite;
  /**
   * Bring any retired entry back (op 'restore'). A live entry: nothing written (changed:false). Refused
   * (invalid_params) while another live entry of the type answers to one of its names (name, alias,
   * former name); summaries, notes and arcs are exempt. Event change 'restored'.
   */
  memoryRestore(input: { ref: string }): MemoryWrite;
  /**
   * M5a: the entries of the current path's Compendium (library seed included) in handle order, live
   * only unless includeRetired; `type` keeps one entry type, 'note' or 'arc'. Read-only.
   */
  memoryList(input?: { at?: string; type?: EntryType | 'note' | 'arc'; includeRetired?: boolean }): MemoryRow[];
  /** M5a: one entry (C<n>, key or a unique name; live first) with its full render and its brief. not_found. */
  memoryGet(input: { ref: string; at?: string }): { ref: string; entry: CEntry; render: string; brief: string };
  /**
   * M5a (D-165): the session's tree first, then one tree per readable book (its overlays applied),
   * or only that book's with `book` (a library id; not_found when it is not a readable book).
   */
  memoryTree(input?: { at?: string; book?: string }): TreeNode[];
  /**
   * M5a (D-163): export the session's entries and overlays (live and retired) under `name`. 'core':
   * a library lorebook (canonicalId(name)); 'compendium': <home>/exports/<id>.compendium.json. An
   * existing id or file is refused (invalid_params) unless `force`, which overwrites it in place
   * (temp file, fsync, rename, folder fsync); a core export whose id is one of this session's own
   * lorebooks is refused even with `force` (it would replace that book with the session's part of
   * it). Writes no row; session_busy during a turn. `warnings`: what the file could not keep (the
   * codec's compendiumWarnings, e.g. featured_dropped: RoleCall keeps one featured entry per type),
   * for the caller to show; absent when none. The export folds with the readable books' seed even
   * while the Compendium is off (an export is a data operation), so the overlays are always in it.
   */
  memoryExport(input: { name: string; format: 'core' | 'compendium'; force?: boolean }): { path: string; id: string; entries: number; warnings?: ImportWarning[] };
  /** M5a: the head view's Compendium (the fold with the library seed). */
  compendium(): CompendiumView;
  /**
   * M5b (D-180, the lead's ruling I): undo the Compendium agents' pass bound to a message: one `revert`
   * row (by 'user', `on` = the reverted row's) for the filing key whose row is bound to it (the
   * effective row first: its `on`, else a range holding the message; a stale key only when no effective
   * row holds it), then the same for the historian; `task` picks one of the two. Only an applied pass is
   * reverted: an undone or stale one gives changed:false and writes nothing. A running job of the key is
   * superseded. Event memory{change:'reverted', by:'user'} per entry the pass had changed. Refusals:
   * session_busy during a turn; not_found for an unknown message or one no pass is bound to;
   * invalid_params.
   */
  memoryUndo(input: { messageId: string; task?: 'file' | 'hist' }): MemoryLaneWrite;
  /**
   * M5b (D-180, the lead's ruling I): queue the pass bound to a message again under its key (its new row
   * replaces the old one and supersedes an undo; the effective pass is bound first, as memoryUndo); an
   * accepted answer no filing row covers queues its own filing task as well, also when a historian pass
   * holds it (the lead's ruling K; `keys` lists filing first). A refile is not written: it lasts while the
   * session is open (a run of it cut short by close() is not re-run at the next open unless the key is
   * still owed). With its agent off (filing.enabled false, historian.interval 0) the task is held
   * (memoryStatus.held) until the agent is on. changed:false when the key is already queued, held or
   * running. Refusals: session_busy; not_found; invalid_params, in words, for the Compendium off, a
   * hidden message (or a pass whose answers are all hidden), an answer not accepted yet
   * (compendium.filing.wait), a parked key (memoryRetry un-parks it) or a message no task can be
   * bound to. A refusal about a pass names it by its task key (`file:<id>`, `hist:<from>-<to>`).
   */
  memoryRefile(input: { messageId: string; task?: 'file' | 'hist' }): MemoryLaneWrite;
  /**
   * M5b (D-171, D-180): one `job{state:'retry'}` row per parked key (every parked key on the active
   * path, or those bound to `messageId`): it resets the key's failure count (a reopen keeps that), and
   * the key is queued (by name when the derivation does not hold it, e.g. a parked refile; as a refile,
   * that lasts while the session is open). Parked keys whose answers were filed under another key or
   * hidden since are not listed, so not retried (the lead's ruling K). It also resumes an agent the
   * circuit breaker paused (memoryStatus.blocked): changed:true with no key when nothing is parked.
   * changed:false when nothing there is parked and nothing was paused. session_busy during a turn;
   * invalid_params while the Compendium is off.
   */
  memoryRetry(input?: { messageId?: string }): MemoryLaneWrite;
  /**
   * M5b (D-171, the lead's ruling I): until nothing is left to run, or until `timeoutMs` passed
   * (idle:false; a running task goes on). Manual mode runs the lane; auto mode only waits for it (the
   * lane starts its tasks itself, after a turn, a fresh message's hold or a failure's wait). M5c (the
   * lead's rulings I and K): auto mode waits for the recall prefetch too — one queued or running is
   * waited for to its end, one owed for the head until the lane begins it; idle is false while either
   * is so (manual mode never prefetches). Allowed while a turn runs: nothing starts before the turn has
   * settled. A timeout over 2^31 − 1 ms waits that long.
   */
  memoryWait(input?: { timeoutMs?: number }): Promise<MemoryStatus & { idle: boolean }>;
  /**
   * M5b (D-180): the lane's queue, running task, parked keys, backlog and what blocks it (ruling K); M5c
   * (ruling H): the recall prefetch for the next reply (`prefetch`). Read-only. memoryWait's result has it too.
   */
  memoryStatus(): MemoryStatus;

  /**
   * Stop any running turn (keeping partial text), wait for it to settle, release the lock. M5b: a
   * running lane task is aborted first ('shutdown'; it writes nothing and runs again at the next open
   * while its key is still owed).
   */
  close(): Promise<void>;
}

export interface EngineHandle {
  createSession(input: CreateSessionInput): SessionHandle;
  /** Add a connection configured while this engine is already running. */
  addConnection(connection: Connection): void;
  /** Open (lock + recover). Throws Refusal('session_locked' | 'session_not_found'). */
  session(id: string): SessionHandle;
  /** Name a story or branch, opening and closing an inactive session when needed. */
  nameSession(id: string, title: string, leaf?: string): Promise<void>;
  listSessions(): { id: string; title?: string; updated: string }[];
  /** All events of all open sessions (live tail; starts empty). */
  events(): AsyncIterable<Event>;
  /** Close every open session. */
  close(): Promise<void>;
}
