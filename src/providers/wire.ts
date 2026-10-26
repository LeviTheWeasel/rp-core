// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Pure helpers shared by adapters (ARCHITECTURE.md §8.3, D-52, D-53).
// Port sources: Bunraku src/stage/provider/openai-compatible-request.ts validateToolProtocol (lines
// 72-115), transport-core.ts normalizeFinishReason, request-overrides.ts + src/stage/params/custom.ts.
// CONTRACT FILE (M1b): signatures are fixed; the transport agent implements the bodies.

import type { FinishReason, PromptMsg } from './types.ts';

/** Every tool_call has exactly one later tool_result, in order, ids unique and safe, args JSON objects. */
export function validateToolProtocol(messages: readonly PromptMsg[]): { ok: true } | { ok: false; why: string } {
  void messages;
  throw new Error('not implemented: validateToolProtocol');
}

/** Remap tool ids for a dialect (mistral9: 9 alphanumerics), consistently across calls and results. */
export function remapToolIds(messages: readonly PromptMsg[], format?: 'mistral9'): PromptMsg[] {
  void messages; void format;
  throw new Error('not implemented: remapToolIds');
}

/**
 * Merge neighbouring messages of the same role (text blocks joined with '\n\n'). Never merges messages
 * that carry tool blocks or replay payloads, nor ones with different placement.
 */
export function mergeAdjacent(messages: readonly PromptMsg[]): PromptMsg[] {
  void messages;
  throw new Error('not implemented: mergeAdjacent');
}

/** Provider finish string → FinishReason: stop/end_turn → end; length/max_tokens → length; content_filter; tool_calls → end. */
export function normalizeFinish(raw: string | null | undefined): FinishReason {
  void raw;
  throw new Error('not implemented: normalizeFinish');
}

/** [D-53] the connection's escape hatch, already resolved (header VALUES come from env at config load). */
export interface ConnectionOverrides {
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  excludeBody?: string[];
}

/** Body keys and header names an override may never touch [D-53]. */
export const PROTECTED_BODY_KEYS: readonly string[] = ['model', 'messages', 'stream', 'tools', 'tool_choice'];
export const PROTECTED_HEADERS: readonly string[] = ['authorization', 'x-api-key', 'anthropic-version', 'content-type'];

/** Apply overrides last: exclude, then deep-merge extraBody, then headers; protected keys untouched (reported). */
export function applyOverrides(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  o: ConnectionOverrides | undefined,
): { body: Record<string, unknown>; headers: Record<string, string>; ignored: string[] } {
  void body; void headers; void o;
  throw new Error('not implemented: applyOverrides');
}
