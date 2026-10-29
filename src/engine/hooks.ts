// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Host hooks (ARCHITECTURE.md §12.5, §6.2 steps 3, 7, 9). The call points exist in the turn state
// machine from M1a so the order of steps never changes; until M9 they pass everything through.
// M9 adds the runner here: beforeAssemble never fails a turn, transformRequest / transformReply are
// fail-closed (host_transform_failed, host_veto) and record themselves in trace.hooks.

import { SOURCE_RANK, type DepthInsert } from '../prompt/depth.ts';
import type { PromptMsg } from '../providers/types.ts';
import type { TurnKind } from '../session/entries.ts';

/** What beforeAssemble returns: tagged depth inserts (§10.1). */
export type Placement = DepthInsert;

export interface HookCtx {
  sessionId: string;
  turnId: string;
  kind: TurnKind;
  /** The turn signal: a hook must give up when the turn is stopped. */
  signal: AbortSignal;
}

export interface HostHooks {
  /** Host planners; run beside the Director and recall; a failure is an empty result and a notice. */
  beforeAssemble?(ctx: HookCtx): Promise<Placement[]>;
  /** Fail-closed: an exception, cancel or timeout fails the turn with host_transform_failed. */
  transformRequest?(req: { messages: PromptMsg[] }, ctx: HookCtx): Promise<{ edits: { index: number; text: string }[] }>;
  /** Fail-closed; `veto` fails the turn with host_veto. */
  transformReply?(text: string, ctx: HookCtx): Promise<{ text: string; note?: string } | { veto: string }>;
}

export class HostHookError extends Error {
  constructor(readonly code: 'host_transform_failed' | 'host_veto', message: string) {
    super(message);
    this.name = 'HostHookError';
  }
}

/** A hook cannot outlive the turn or its host-specified deadline. */
async function waitFor<T>(work: Promise<T>, ctx: HookCtx, timeoutMs?: number): Promise<T> {
  if (ctx.signal.aborted) throw new Error('turn stopped');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('turn stopped'));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = timeoutMs === undefined ? undefined : new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('host hook timed out')), timeoutMs);
    });
    return await Promise.race(deadline ? [work, cancelled, deadline] : [work, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** §6.2 step 3. M1a: no hooks, no placements. */
export async function hookBeforeAssemble(hooks: HostHooks | undefined, ctx: HookCtx, timeoutMs?: number): Promise<Placement[]> {
  if (!hooks?.beforeAssemble) return [];
  const result = await waitFor(Promise.resolve().then(() => hooks.beforeAssemble!(ctx)), ctx, timeoutMs);
  if (!Array.isArray(result) || result.some((p) => !p || !Number.isInteger(p.depth) || p.depth < 0 || typeof p.text !== 'string' || !Object.hasOwn(SOURCE_RANK, p.src) || (p.role !== 'system' && p.role !== 'user' && p.role !== 'assistant'))) {
    throw new Error('beforeAssemble returned invalid placements');
  }
  return result;
}

/** §6.2 step 7, after `prep`. M1a: the request goes out as shaped. */
export async function hookTransformRequest(
  hooks: HostHooks | undefined,
  messages: PromptMsg[],
  ctx: HookCtx,
  timeoutMs?: number,
): Promise<PromptMsg[]> {
  if (!hooks?.transformRequest) return messages;
  try {
    const result = await waitFor(Promise.resolve().then(() => hooks.transformRequest!({ messages: structuredClone(messages) }, ctx)), ctx, timeoutMs);
    if (!result || !Array.isArray(result.edits)) throw new Error('invalid request edits');
    const seen = new Set<number>();
    for (const edit of result.edits) {
      if (!edit || !Number.isInteger(edit.index) || edit.index < 0 || edit.index >= messages.length || typeof edit.text !== 'string' || seen.has(edit.index)) {
        throw new Error('invalid request edit');
      }
      seen.add(edit.index);
    }
    return messages.map((message, index) => {
      const edit = result.edits.find((item) => item.index === index);
      return edit ? { ...message, blocks: [{ k: 'text' as const, text: edit.text }] } : message;
    });
  } catch (error) {
    throw new HostHookError('host_transform_failed', error instanceof Error ? error.message : String(error));
  }
}

/** §6.2 step 9, before the commit. M1a: the reply is committed as streamed. */
export async function hookTransformReply(
  hooks: HostHooks | undefined,
  text: string,
  ctx: HookCtx,
  timeoutMs?: number,
): Promise<{ text: string }> {
  if (!hooks?.transformReply) return { text };
  try {
    const result = await waitFor(Promise.resolve().then(() => hooks.transformReply!(text, ctx)), ctx, timeoutMs);
    if (result && 'veto' in result && typeof result.veto === 'string') throw new HostHookError('host_veto', result.veto);
    if (!result || !('text' in result) || typeof result.text !== 'string') throw new Error('invalid transformed reply');
    return { text: result.text };
  } catch (error) {
    if (error instanceof HostHookError) throw error;
    throw new HostHookError('host_transform_failed', error instanceof Error ? error.message : String(error));
  }
}
