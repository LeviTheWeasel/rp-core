// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The canonical library API (ARCHITECTURE.md §6.1, §12.1). REPL, one-shot, --stdio (M6) and
// Bunraku (M9) are thin clients of exactly this. CONTRACT FILE (types only): the engine agent
// implements it in engine.ts; the CLI agent codes against it.

import type { Character, Persona } from '../formats/native.ts';
import type { ModelCaps, Provider, ProviderError } from '../providers/types.ts';
import type { DeepPartial, SessionConfig, SessionHeader, TurnKind } from '../session/entries.ts';
import type { MessageView, PathView } from '../session/view.ts';
import type { Event } from '../protocol/events.ts';
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
   */
  onProviderError?(info: { sessionId: string; turnId: string; callKey: string; model: string; error: ProviderError }): void;
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
  | { type: 'failed'; category: string; code: string; message: string; draft: string }
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

export interface SessionHandle {
  readonly id: string;
  header(): SessionHeader;
  /** version(session) (§5.3). */
  version(): number;
  /** The PathView at the current head (cached per version). */
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
  /** Append a config entry (does not change the version). */
  configure(patch: DeepPartial<SessionConfig>): void;

  /** Stop any running turn (keeping partial text), wait for it to settle, release the lock. */
  close(): Promise<void>;
}

export interface EngineHandle {
  createSession(input: CreateSessionInput): SessionHandle;
  /** Open (lock + recover). Throws Refusal('session_locked' | 'session_not_found'). */
  session(id: string): SessionHandle;
  listSessions(): { id: string; title?: string; updated: string }[];
  /** All events of all open sessions (live tail; starts empty). */
  events(): AsyncIterable<Event>;
  /** Close every open session. */
  close(): Promise<void>;
}
