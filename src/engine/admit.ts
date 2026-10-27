// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Turn admission (ARCHITECTURE.md §6.1, §6.2 step 1, D-38): synchronous, before any write. Every
// refusal is a typed Refusal thrown to the caller, never an event. Order: busy → held → version →
// the kind's preconditions → params → connection (and its caps for the bound model) → preset.

import { Refusal, type Connection, type RunTurnOptions } from './api.ts';
import type { EngineCtx } from './context.ts';
import { MAX_TOOL_ROUNDS } from './narrate.ts';
import { parseModelRef } from './route.ts';
import { BUILTIN_PRESET, validatePreset, type Preset } from '../formats/native.ts';
import { loadFromLibrary } from '../formats/library.ts';
import type { ModelCaps } from '../providers/types.ts';
import type { Binding, SessionConfig, TurnKind } from '../session/entries.ts';
import type { MessageView, PathView } from '../session/view.ts';

/** D-38: guided re-roll text is capped. Counted in code points, as the assembler clips it. */
export const GUIDANCE_MAX = 10_000;

const KINDS: ReadonlySet<string> = new Set(['reply', 'swipe', 'continue']);

export interface AdmitState {
  busy: boolean;
  heldOpen: boolean;
  version: number;
  view: PathView;
  config: SessionConfig;
}

export interface Route {
  conn: Connection;
  model: string;
  /**
   * The caps of this model on this connection (§8.2, M1b): conn.capsFor(model) when the connection
   * resolves caps per model, else conn.caps. Resolved once at admission (§6.2 step 1); everything
   * downstream (window, assemble, shape, the request, the semaphore) reads these, never conn.caps.
   */
  caps: ModelCaps;
}

/** The caps a connection has for one model: capsFor(model) when it resolves per model, else its caps. */
export function capsOf(conn: Connection, model: string): ModelCaps {
  return conn.capsFor?.(model) ?? conn.caps;
}

/** A route with its caps resolved. A connection that cannot resolve them is refused like a missing one. */
export function routeTo(conn: Connection, model: string): Route {
  let caps: ModelCaps;
  try {
    caps = capsOf(conn, model);
  } catch (e) {
    throw new Refusal('no_connection', `the caps of ${conn.id}:${model} cannot be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { conn, model, caps };
}

export interface AdmittedTurn {
  kind: TurnKind;
  /** TurnEntry.parent: U for reply/swipe, the target's parent for continue (the target itself for a root). */
  parent: string;
  /** swipe: the replaced answer; continue: the answer continued. */
  target?: string;
  /** The last path message the history includes (assemble's upTo). */
  upTo: string;
  primary: Route;
  fallback?: Route;
  /** A binding fallback that names an unknown connection: told with a notice, not refused. */
  fallbackMissing?: string;
  binding: Binding;
  preset: Preset;
  /** What config.preset names ('builtin' or a library id): gen.preset.name. */
  presetRef: string;
  config: SessionConfig;
  /** Trimmed guidance (swipe only), when non-blank. */
  guidance?: string;
  /** The replaced answer's text for the guidance block, when swipe.showRejected is on. */
  rejected?: string;
  onError: 'drop' | 'keep';
  emptyReply: 'fail' | 'keep';
  /** M3: config.narrator.maxRounds clamped to 1..MAX_TOOL_ROUNDS (D-55). */
  maxRounds: number;
  /** M3: the configured value when it was above MAX_TOOL_ROUNDS (the turn says so: tool_rounds_clamped). */
  roundsClamped?: number;
}

/** D-55: tool rounds per turn, 1..MAX_TOOL_ROUNDS; `clamped` is the configured value when it was too high. */
export function clampRounds(configured: unknown): { maxRounds: number; clamped?: number } {
  const n = typeof configured === 'number' && Number.isFinite(configured) ? Math.floor(configured) : 1;
  if (n > MAX_TOOL_ROUNDS) return { maxRounds: MAX_TOOL_ROUNDS, clamped: n };
  return { maxRounds: Math.max(1, n) };
}

/** RunTurnOptions.onError (D-22), checked wherever a turn can be asked for (runTurn, submit). */
export function checkOnError(v: unknown): 'drop' | 'keep' {
  const onError = v ?? 'drop';
  if (onError !== 'drop' && onError !== 'keep') throw new Refusal('invalid_params', "onError must be 'drop' or 'keep'");
  return onError;
}

const textOf = (m: MessageView): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/** The connection a binding names, or the process-wide override (CLI --provider). */
export function resolveConnection(ctx: EngineCtx, connId: string): Connection | undefined {
  if (ctx.providerOverride) return ctx.providerOverride;
  return Object.hasOwn(ctx.connections, connId) ? ctx.connections[connId] : undefined;
}

/** config.preset → a valid Preset, or Refusal preset_missing. */
export function resolvePreset(ctx: EngineCtx, ref: string): Preset {
  if (ref === 'builtin') return BUILTIN_PRESET;
  let raw: unknown;
  try {
    raw = loadFromLibrary(ctx.home, 'presets', ref);
  } catch (e) {
    throw new Refusal('preset_missing', `preset '${ref}' cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw === null) throw new Refusal('preset_missing', `preset '${ref}' is not in the library`);
  const v = validatePreset(raw);
  if (!v.ok) {
    const why = v.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
    throw new Refusal('preset_missing', `preset '${ref}' is invalid: ${why}`);
  }
  return v.value;
}

/** The narrator's primary route; Refusal no_connection when the binding names nothing known. */
export function resolvePrimary(ctx: EngineCtx, config: SessionConfig): Route {
  const binding = config.roles.narrator;
  const conn = resolveConnection(ctx, binding.conn);
  if (!conn) throw new Refusal('no_connection', `no connection '${binding.conn}' for the narrator`);
  return routeTo(conn, binding.model);
}

/**
 * M4 (D-101, D-119): the Director's binding and route, resolved in the turn body (never at admission).
 * `roles.director` absent or 'narrator' → the narrator's connection and model only, on its admitted
 * route: not its maxTokens, samplers, reasoning or fallback (those are the narrator's reply settings;
 * a narrator capped at 300 tokens must not cut every plan). An explicit director binding keeps all its
 * fields. A missing connection or caps that cannot be resolved give route null (the record says
 * no_connection); never a Refusal. providerOverride applies (resolveConnection).
 */
export function resolveDirector(ctx: EngineCtx, config: SessionConfig, narrator: { binding: Binding; primary: Route }): { binding: Binding; route: Route | null } {
  const role = config.roles.director;
  if (role === undefined || role === 'narrator') return { binding: { conn: narrator.binding.conn, model: narrator.binding.model }, route: narrator.primary };
  const conn = resolveConnection(ctx, role.conn);
  if (!conn) return { binding: role, route: null };
  try {
    return { binding: role, route: routeTo(conn, role.model) };
  } catch (e) {
    if (e instanceof Refusal) return { binding: role, route: null };
    throw e;
  }
}

/** The head message and what the kind needs of it. */
function placeKind(kind: TurnKind, view: PathView): { parent: string; target?: string; upTo: string; head: MessageView } {
  const head = view.head === null ? undefined : view.path[view.path.length - 1];
  switch (kind) {
    case 'reply':
      if (!head || head.role !== 'user') throw new Refusal('nothing_to_reply', 'the head is not a user message');
      return { parent: head.id, upTo: head.id, head };
    case 'swipe':
      // A greeting is swiped by navigating to another greeting (select), never by the model (§5.5).
      if (!head || head.role !== 'assistant' || head.gen?.kind === 'greeting' || head.parent === null) {
        throw new Refusal('nothing_to_swipe', 'the head is not a model answer');
      }
      return { parent: head.parent, target: head.id, upTo: head.parent, head };
    case 'continue':
      if (!head || head.role !== 'assistant') throw new Refusal('nothing_to_continue', 'the head is not an assistant message');
      if (head.hidden) throw new Refusal('continue_target_hidden', 'the answer to continue is hidden');
      if (textOf(head).trim() === '') throw new Refusal('continue_target_blank', 'the answer to continue has no text');
      // TurnEntry.parent must name a message; a root (greeting) is its own anchor.
      return { parent: head.parent ?? head.id, target: head.id, upTo: head.id, head };
  }
}

export function admitTurn(ctx: EngineCtx, s: AdmitState, opts: RunTurnOptions): AdmittedTurn {
  if (s.busy) throw new Refusal('session_busy', 'a turn is already running in this session');
  if (s.heldOpen) throw new Refusal('held_pending', 'an answer held by a conflict must be committed or discarded first');
  if (typeof opts !== 'object' || opts === null) throw new Refusal('invalid_params', 'runTurn needs options');
  if (typeof opts.expectedVersion !== 'number' || !Number.isInteger(opts.expectedVersion)) {
    throw new Refusal('invalid_params', 'expectedVersion must be an integer');
  }
  if (opts.expectedVersion !== s.version) {
    throw new Refusal('stale_version', `expected version ${opts.expectedVersion}, the session is at ${s.version}`);
  }
  if (typeof opts.kind !== 'string' || !KINDS.has(opts.kind)) {
    throw new Refusal('invalid_params', `kind must be reply, swipe or continue, got ${JSON.stringify(opts.kind)}`);
  }
  const kind = opts.kind;
  const placed = placeKind(kind, s.view);

  // Params (D-38). Blank guidance counts as none, as Bunraku treats it.
  if (opts.guidance !== undefined && typeof opts.guidance !== 'string') throw new Refusal('invalid_params', 'guidance must be a string');
  const guidance = opts.guidance?.trim() ?? '';
  if (guidance && kind !== 'swipe') throw new Refusal('invalid_params', 'guidance belongs to a swipe (guided re-roll)');
  if ([...guidance].length > GUIDANCE_MAX) throw new Refusal('invalid_params', `guidance is longer than ${GUIDANCE_MAX} characters`);
  const onError = checkOnError(opts.onError);
  const emptyReply = opts.emptyReply ?? 'fail';
  if (emptyReply !== 'fail' && emptyReply !== 'keep') throw new Refusal('invalid_params', "emptyReply must be 'fail' or 'keep'");
  let explicitFallback: { conn: string; model: string } | undefined;
  if (opts.fallback !== undefined) {
    const ref = typeof opts.fallback === 'string' ? parseModelRef(opts.fallback) : null;
    if (!ref) throw new Refusal('invalid_params', "fallback must be 'conn:model'");
    explicitFallback = ref;
  }

  // Connection(s).
  const config = s.config;
  const binding = config.roles.narrator;
  const primary = resolvePrimary(ctx, config);
  let fallback: Route | undefined;
  let fallbackMissing: string | undefined;
  if (explicitFallback) {
    const conn = resolveConnection(ctx, explicitFallback.conn);
    // The caller asked for this fallback by name: an unknown one is refused, not ignored.
    if (!conn) throw new Refusal('no_connection', `no connection '${explicitFallback.conn}' for the fallback`);
    fallback = routeTo(conn, explicitFallback.model);
  } else if (binding.fallback) {
    const conn = resolveConnection(ctx, binding.fallback.conn);
    if (conn) fallback = routeTo(conn, binding.fallback.model);
    else fallbackMissing = `${binding.fallback.conn}:${binding.fallback.model}`;
  }
  // §6.6: the fallback is only ever a different connection:model pair.
  if (fallback && fallback.conn.id === primary.conn.id && fallback.model === primary.model) fallback = undefined;

  const preset = resolvePreset(ctx, config.preset);
  const rounds = clampRounds(config.narrator?.maxRounds);

  const out: AdmittedTurn = {
    kind,
    parent: placed.parent,
    upTo: placed.upTo,
    primary,
    binding,
    preset,
    presetRef: config.preset,
    config,
    onError,
    emptyReply,
    maxRounds: rounds.maxRounds,
  };
  if (rounds.clamped !== undefined) out.roundsClamped = rounds.clamped;
  if (placed.target !== undefined) out.target = placed.target;
  if (fallback) out.fallback = fallback;
  if (fallbackMissing) out.fallbackMissing = fallbackMissing;
  if (guidance) {
    out.guidance = guidance;
    if (config.swipe.showRejected) out.rejected = textOf(placed.head);
  }
  return out;
}
