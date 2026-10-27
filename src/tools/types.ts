// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The narrator's tools (ARCHITECTURE.md §9.1, D-56, D-58, D-59). v1 tools only read: a batch runs
// in parallel and its results go back in call order. The turn computes its tool set once (engine
// request.ts) and the list it sends is the dispatch table.
// CONTRACT FILE (M3): the types are fixed by the architect.

import type { CompendiumView } from '../agents/compendium/types.ts';
import type { LoreSource } from '../lore/engine.ts';
import type { Rng } from '../prompt/rng.ts';
import type { JSONSchema } from '../providers/types.ts';
import type { PathView } from '../session/view.ts';
import type { HandleTable } from './handles.ts';

/** §9.1: characters of a tool result sent to the model when the tool names no maxOutput. */
export const DEFAULT_TOOL_OUTPUT = 4000;

/** What one run of a tool produced. `summary` is the short line clients show ("2 hits"). */
export interface ToolOutput {
  text: string;
  summary: string;
  error?: boolean;
}

/** Everything a tool may read. One per turn (signal and pageChars per round). */
export interface ToolCtx {
  /** The view the request was built from (folded at upTo): a swipe never sees the answer it replaces. */
  view: PathView;
  /** The last message the turn's history included (the user message U). */
  upTo: string;
  /** Speaker names for results: the character and the persona. */
  names: { char: string; user: string };
  /** The lore sources the turn's lore run read: persona, card, notes, session books (LoreSource keys). */
  lore: readonly LoreSource[];
  /** The Compendium at the turn's start (M3: notes). */
  compendium: CompendiumView;
  /**
   * Short handles [D-59, amended]: `L<n>` for lore entries, per turn; a note's `C<n>` is its /memory
   * handle (stable), other Compendium records numbered after the notes.
   */
  handles: HandleTable;
  /** D-56: true when the message's text is in the request the model is answering ("(in context)"). */
  inContext(msgId: string): boolean;
  /**
   * D-58 page size in characters for read_history this round: historyPageChars(window), never more
   * than the tool room left (engine). A tool that pages by characters uses it.
   */
  pageChars: number;
  /**
   * Characters this run's result may take: its share of the round's tool room, never more than the
   * tool's own maxOutput. tools/run.ts sets it before the tool runs (refused calls' texts are reserved
   * first, then the room goes one share per call, water-filled over the runs' maxOutput; a run that
   * answers N identical calls takes N shares, as its result goes out N times). A tool that writes paging
   * lines (a cursor, `next_from`, "not shown") sizes its output to it, so the runner's cut, a
   * backstop, never removes them. Undefined (a tool run outside runTools): only maxOutput applies.
   */
  limit?: number;
  /** Stop and timeouts reach the tool through it. */
  signal: AbortSignal;
  /** The turn's clock and seeded randomness (§6.9). */
  now: string;
  rng: Rng;
}

export interface Tool<A extends Record<string, unknown> = Record<string, unknown>> {
  /** SAFE_NAME (providers/wire.ts). */
  name: string;
  description: string;
  /** A flat object schema: no union at the root (§9.1). Validated by tools/args.ts (D-56). */
  schema: JSONSchema;
  effect: 'read';
  /** Characters of the result sent to the model (default DEFAULT_TOOL_OUTPUT). */
  maxOutput?(ctx: ToolCtx): number;
  /** Never throws for expected trouble: an error result says what went wrong (error: true). */
  run(args: A, ctx: ToolCtx): Promise<ToolOutput>;
}

/** A call the model made, before its arguments are parsed. */
export interface ToolCall {
  /** The id the call goes by in storage and on the wire: SAFE_ID, unique within the turn. */
  id: string;
  /** The name as the model wrote it (may be unknown or unsafe). */
  name: string;
  /** The raw arguments text ('' or anything: tools/args.ts parses it). */
  args: string;
  round: number;
  /** Where it came from: a native tool_call, a prompted <tool_call> block, or leak recovery (D-57). */
  via: 'native' | 'prompted' | 'leak';
}

/** What became of one call (tools/run.ts). */
export interface ToolCallOutcome {
  call: ToolCall;
  /** The name echoed back to the model: the call's name, or 'invalid_tool' when it is not SAFE_NAME. */
  echoName: string;
  /** The arguments echoed back: JSON of the parsed object, '{}' when they could not be parsed (§9.1). */
  echoArgs: string;
  /** The tool ran and did not report an error. */
  ok: boolean;
  /** The result text as sent (after the cap); also stored in the tool_result block. */
  text: string;
  summary: string;
  /** Not run, and why (Trace.tools refused). */
  refused?: 'unknown_tool' | 'bad_args' | 'cancelled';
  /** The D-56 repairs applied to the arguments, for the trace. */
  repaired?: string[];
  /** The parsed arguments (undefined when they could not be parsed), for the tool event. */
  parsed?: Record<string, unknown>;
  /** The result was cut to fit (maxOutput or the room). */
  cut?: boolean;
  ms: number;
}
