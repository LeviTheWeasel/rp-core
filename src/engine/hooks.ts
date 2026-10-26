// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Host hooks (ARCHITECTURE.md §12.5, §6.2 steps 3, 7, 9). The call points exist in the turn state
// machine from M1a so the order of steps never changes; until M9 they pass everything through.
// M9 adds the runner here: beforeAssemble never fails a turn, transformRequest / transformReply are
// fail-closed (host_transform_failed, host_veto) and record themselves in trace.hooks.

import type { DepthInsert } from '../prompt/depth.ts';
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

/** §6.2 step 3. M1a: no hooks, no placements. */
export async function hookBeforeAssemble(hooks: HostHooks | undefined, ctx: HookCtx): Promise<Placement[]> {
  void hooks;
  void ctx;
  return [];
}

/** §6.2 step 7, after `prep`. M1a: the request goes out as shaped. */
export async function hookTransformRequest(
  hooks: HostHooks | undefined,
  messages: PromptMsg[],
  ctx: HookCtx,
): Promise<PromptMsg[]> {
  void hooks;
  void ctx;
  return messages;
}

/** §6.2 step 9, before the commit. M1a: the reply is committed as streamed. */
export async function hookTransformReply(
  hooks: HostHooks | undefined,
  text: string,
  ctx: HookCtx,
): Promise<{ text: string }> {
  void hooks;
  void ctx;
  return { text };
}
