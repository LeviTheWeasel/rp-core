// Ported from RoleCall:apps/rc/src/lib/ai/streaming/stream-delta.ts@fb8dc623e6beb24083f5105c828462e89fc66ce3 (applyDelta only).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event union every client serialises (ARCHITECTURE.md §12.2). text/reasoning deltas are
// ephemeral; done/stopped/failed/conflict always follow with the authoritative message.
// CONTRACT FILE: the Event type is fixed; the infra agent implements applyDelta.

import type { TurnKind } from '../session/entries.ts';
import type { MessageView } from '../session/view.ts';
import type { Usage } from '../providers/types.ts';

export interface Notice {
  level: 'info' | 'warn';
  code: string;
  message: string;
}

/** An event before the session id and timestamp are stamped on it (what an emitter builds). */
export type EventBody =
  | { type: 'start'; turnId: string; kind: TurnKind; messageId: string; parentId: string }
  | { type: 'text'; turnId: string; delta: string; offset: number }
  | { type: 'reasoning'; turnId: string; delta: string; offset: number }
  | { type: 'prefill'; turnId: string; text: string }
  | {
      type: 'director';
      turnId: string;
      status: 'planning' | 'planned' | 'reused' | 'failed' | 'skipped';
      reason?: string;
      summary?: string;
    }
  | {
      type: 'tool';
      turnId: string;
      callId: string;
      name: string;
      /** M3: the loop round the call came from (0-based). */
      round?: number;
      phase: 'start' | 'done';
      args?: unknown;
      ok?: boolean;
      summary?: string;
    }
  | { type: 'gate'; turnId: string; gateId: string; kind: 'review' | 'transform'; payload: unknown }
  | { type: 'done'; turnId: string; message: MessageView }
  | { type: 'stopped'; turnId: string; message: MessageView | null }
  | { type: 'failed'; turnId: string; category: string; code: string; message: string; draft: string }
  | { type: 'conflict'; turnId: string; draft: string }
  | {
      type: 'agent';
      agent: 'recall' | 'filing' | 'historian';
      turnId?: string;
      job?: string;
      status:
        | 'queued'
        | 'started'
        | 'preempted'
        | 'adopted'
        | 'recalled'
        | 'reused'
        | 'fallback'
        | 'skipped'
        | 'done'
        | 'failed'
        | 'parked';
      source?: 'sync' | 'prefetch' | 'lexical' | 'reused';
      count?: number;
      skipped?: number;
      code?: string;
      reason?: string;
    }
  | {
      type: 'memory';
      change: 'created' | 'merged' | 'arc' | 'note' | 'edited' | 'retired' | 'restored' | 'reverted';
      ref: string;
      kind: string;
      name: string;
      by: 'filing' | 'historian' | 'user';
    }
  | {
      type: 'usage';
      callKey: string;
      agent: string;
      parentToolCallId?: string;
      model: string;
      usage: Usage;
      costUsd: number | null;
      priceSource: 'provider' | 'table' | 'none';
    }
  | { type: 'retry'; callKey: string; attempt: number; delayMs: number; code: string; status?: number }
  | {
      type: 'recovered';
      turnId: string;
      /**
       * interrupted: the partial answer was committed; abandoned: nothing worth keeping, or a
       * continue whose target changed; dropped: the answer's user message was hidden (§6.6).
       */
      outcome: 'interrupted' | 'abandoned' | 'dropped';
      /** The checkpointed text when it exists but was not committed (dropped, or an abandoned continue). */
      draft?: string;
    }
  | { type: 'changed'; version: number; change: 'msg' | 'edit' | 'hide' | 'head'; id?: string }
  | ({ type: 'notice' } & Notice)
  | { type: 'idle'; background: number };

export type Event = { sessionId: string; ts: string } & EventBody;
export type EventType = Event['type'];

/** Events that end a turn's event stream. */
export const TERMINAL_EVENTS: ReadonlySet<EventType> = new Set(['done', 'stopped', 'failed', 'conflict']);

/**
 * Apply a text/reasoning delta to the client's copy (port of RoleCall streaming/stream-delta.ts,
 * offset-only, no `full` variant). If offset < current.length the overlap is replaced (idempotent
 * re-delivery); if offset > current.length the gap is an error the client must resync from `done`.
 */
export function applyDelta(current: string, ev: { delta: string; offset: number }): string {
  // Adapted from RoleCall stream-delta.ts missingStreamSuffix (offset only; see .notes provenance).
  const { delta, offset } = ev;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`applyDelta: bad offset ${String(offset)}`);
  }
  if (offset > current.length) {
    // Text between current.length and offset never arrived; guessing would corrupt the copy.
    throw new RangeError(`applyDelta: gap, offset ${offset} > length ${current.length}; resync from done`);
  }
  if (offset === current.length) return current + delta;
  // Re-delivery: the delta overwrites what it covers and text past its end stays, so replaying
  // an old frame never truncates a copy that has already moved on.
  return current.slice(0, offset) + delta + current.slice(offset + delta.length);
}
