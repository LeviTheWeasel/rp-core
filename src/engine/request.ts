// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The request half of a turn (ARCHITECTURE.md §6.2 steps 4–5, §10.3, §11): the window, the reply
// reserve and limits, the state the turn starts from, the model's EMA correction (D-50), the
// session's lorebooks, assemble and shape. TurnRun.body and SessionImpl.preview both call
// buildRequest and nothing else, so a preview is the request the next turn sends (§6.1 `preview`).
//
// Notices come back with the key their once-per-session rule is kept under (the turn asks the
// session whether a key was told; a preview shows them all): most are once per code, a missing
// book once per id, a broken '/regex/' lore key once per entry (label).

import type { Route } from './admit.ts';
import { tokenFactorFor } from './ema.ts';
import { modelLabel } from './route.ts';
import type { Preset, Samplers } from '../formats/native.ts';
import { validateLoreBook } from '../formats/native.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { entryLabel, type LoreRunResult, type LoreSource } from '../lore/engine.ts';
import { assemble, type AssembleResult } from '../prompt/assemble.ts';
import { regexNotice } from '../prompt/assemble/lore.ts';
import { contextWindow, replyReserve } from '../prompt/budget.ts';
import type { DepthInsert } from '../prompt/depth.ts';
import { shape } from '../prompt/shape.ts';
import type { TokenCounter } from '../prompt/tokens.ts';
import type { Notice } from '../protocol/events.ts';
import type { PromptMsg } from '../providers/types.ts';
import type { Binding, SessionConfig, SessionHeader, TurnKind } from '../session/entries.ts';
import { foldViewAt } from '../session/fold.ts';
import type { TreeIndex } from '../session/tree.ts';
import type { PathView } from '../session/view.ts';

export type AssembledOk = Extract<AssembleResult, { ok: true }>;

/** The request one route sends, shaped for that route's caps. */
export interface Shaped {
  messages: PromptMsg[];
  prefill?: string;
  cont?: { mode: 'prefill' | 'cue'; base: string };
}

/** A notice and the key its once-per-session rule is kept under. */
export interface KeyedNotice {
  key: string;
  notice: Notice;
}

/** What of an admitted turn the request depends on (AdmittedTurn fits). */
export interface RequestPlan {
  kind: TurnKind;
  upTo: string;
  primary: Route;
  binding: Binding;
  preset: Preset;
  config: SessionConfig;
  guidance?: string;
  rejected?: string;
}

export interface RequestInput {
  home: string;
  sessionId: string;
  header: SessionHeader;
  tree: TreeIndex;
  /**
   * The view the request starts from. When its head is not plan.upTo (a swipe, a past answer) the
   * view is folded again at upTo, so the replaced answer's variables and fires never reach it (§5.10).
   */
  view: PathView;
  plan: RequestPlan;
  seed: number;
  now: string;
  timeZone: string;
  counter: TokenCounter;
  /** Agent inserts (Director M4, Compendium M5, host beforeAssemble M9). */
  placements: DepthInsert[];
  /** Also return the lore verdicts (preview, /lore test) [D-45]. */
  explain?: boolean;
}

export type ReplyLimits = { maxTokens?: number; samplers: Partial<Samplers> };

export type RequestFailure = 'assemble_failed' | 'shape_failed' | 'context_length_exceeded' | 'preset_invalid';

export type BuiltRequest =
  | {
      ok: true;
      window: number;
      /** The reply reserve: what the request asks for as max_tokens (maxTokensFor per route). */
      reserve: number;
      limits: ReplyLimits;
      tokenFactor: number;
      /** The view assemble read (folded at upTo when that is not the head). */
      view: PathView;
      asm: AssembledOk;
      shaped: Shaped;
      notices: KeyedNotice[];
    }
  | { ok: false; code: RequestFailure; message: string; notices: KeyedNotice[] };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A usable token limit: a positive finite number, floored; anything else means "not set". */
export const tokenLimit = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

/**
 * The reply's token limit and the samplers to forward [D-89, §11]: `max_tokens` set by the binding
 * (maxTokens, then its samplers) or by the preset's samplers. It leaves the samplers, so a request
 * carries exactly one limit (ModelRequest.maxTokens).
 */
export function replyLimits(binding: Binding, presetSamplers: Partial<Samplers> | undefined): ReplyLimits {
  const { max_tokens, ...samplers } = { ...(presetSamplers ?? {}), ...(binding.samplers ?? {}) };
  const maxTokens = tokenLimit(binding.maxTokens) ?? tokenLimit(max_tokens);
  return maxTokens !== undefined ? { maxTokens, samplers } : { samplers };
}

/** The max_tokens one route is sent: the reserve, or less when the model writes less (caps.maxOutput). */
export function maxTokensFor(route: Route, reserve: number): number {
  return Math.min(reserve, tokenLimit(route.caps.maxOutput) ?? reserve);
}

/** The view a request starts from: the given one when its head is upTo, else folded at upTo. */
export function startView(header: SessionHeader, tree: TreeIndex, view: PathView, upTo: string): PathView {
  return view.head === upTo ? view : foldViewAt(header, tree, upTo);
}

// ---- lorebooks --------------------------------------------------------------------------------

/** How many validation errors a lorebook_missing notice quotes. */
const BOOK_ERRORS_SHOWN = 3;

/**
 * config.lorebooks in order, loaded from the library and validated. A book that is missing,
 * unreadable or invalid is skipped with a 'lorebook_missing' notice naming it and why (told once per
 * session per id); a repeated id is loaded once, at its first place.
 */
export function loadLorebooks(home: string, ids: readonly string[]): { sources: LoreSource[]; notices: KeyedNotice[] } {
  const sources: LoreSource[] = [];
  const notices: KeyedNotice[] = [];
  const seen = new Set<string>();
  const skip = (id: string, why: string): void => {
    notices.push({ key: `lorebook_missing:${id}`, notice: { level: 'warn', code: 'lorebook_missing', message: `The lorebook '${id}' is skipped: ${why}.` } });
  };
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    // '@card' and '@persona' name the cast's books in traces and timers; no library id starts so.
    if (id.startsWith('@')) {
      skip(id, 'a library id cannot start with @');
      continue;
    }
    let raw: unknown;
    try {
      raw = loadFromLibrary(home, 'lorebooks', id);
    } catch (e) {
      skip(id, `it cannot be read (${errMessage(e)})`);
      continue;
    }
    if (raw === null) {
      skip(id, 'it is not in the library');
      continue;
    }
    const v = validateLoreBook(raw);
    if (!v.ok) {
      const shown = v.errors.slice(0, BOOK_ERRORS_SHOWN).map((e) => `${e.path || '(root)'}: ${e.message}`);
      const more = v.errors.length > BOOK_ERRORS_SHOWN ? `; ${v.errors.length - BOOK_ERRORS_SHOWN} more` : '';
      skip(id, `it is invalid (${shown.join('; ')}${more})`);
      continue;
    }
    sources.push({ key: id, book: v.value });
  }
  return { sources, notices };
}

// ---- the request ------------------------------------------------------------------------------

/** The once-per-session key of an assemble or shape notice: its code. */
const keyed = (list: readonly Notice[]): KeyedNotice[] => list.map((notice) => ({ key: notice.code, notice }));

/**
 * assemble's broken '/regex/' keys as one 'lore_regex_invalid' notice per entry, keyed by its label,
 * so each entry is told once per session whatever other entries break later.
 */
export function regexNoticesPerEntry(errors: LoreRunResult['regexErrors']): KeyedNotice[] {
  const byLabel = new Map<string, LoreRunResult['regexErrors']>();
  for (const e of errors) {
    const label = entryLabel(e.book, e.id);
    byLabel.set(label, [...(byLabel.get(label) ?? []), e]);
  }
  return [...byLabel].flatMap(([label, list]) => {
    const notice = regexNotice(list);
    return notice ? [{ key: `${notice.code}:${label}`, notice }] : [];
  });
}

/** Shape (pure) for one route's caps (the model's, not the connection default). Throws what shape throws. */
export function shapeRequest(
  route: Route,
  asm: AssembledOk,
  plan: Pick<RequestPlan, 'kind' | 'preset'>,
  cast: SessionHeader['cast'],
): { shaped: Shaped; notices: KeyedNotice[] } {
  const out = shape({
    messages: asm.messages,
    caps: route.caps,
    prefill: asm.prefill,
    kind: plan.kind,
    ...(plan.preset.postProcessing ? { postProcessing: plan.preset.postProcessing } : {}),
    // Speaker prefixes for the 'single' post-processing mode, as the macros name them.
    names: { char: cast.character.name, user: cast.persona?.name || 'User' },
  });
  const shaped: Shaped = { messages: out.messages };
  if (out.prefill !== undefined) shaped.prefill = out.prefill;
  if (plan.kind === 'continue' && out.continueMode) {
    shaped.cont = { mode: out.continueMode, base: out.continueBase ?? '' };
  }
  return { shaped, notices: keyed(out.notices) };
}

/** §6.2 steps 4–5 for the primary route: everything a turn sends, nothing written, nothing sent. */
export function buildRequest(input: RequestInput): BuiltRequest {
  const { plan } = input;
  const primary = plan.primary;
  const notices: KeyedNotice[] = [];

  // The window and the reserve follow the primary route.
  const window = contextWindow({
    caps: primary.caps,
    local: primary.conn.local,
    preset: plan.preset,
    ...(plan.config.window !== undefined ? { configWindow: plan.config.window } : {}),
  });
  const limits = replyLimits(plan.binding, plan.preset.samplers);
  // The reply may ask for no more than the model can write (caps.maxOutput, e.g. OpenRouter's
  // top_provider.max_completion_tokens) and no more than the budget held back for it: the request
  // carries the reserve itself, so the prompt the budget packed plus max_tokens fits the window.
  const maxOutput = tokenLimit(primary.caps.maxOutput);
  const wanted = limits.maxTokens !== undefined && maxOutput !== undefined ? Math.min(limits.maxTokens, maxOutput) : (limits.maxTokens ?? maxOutput);
  const reserve = replyReserve(window, wanted);
  if (limits.maxTokens !== undefined && reserve < limits.maxTokens) {
    notices.push({
      key: 'max_tokens_reduced',
      notice: {
        level: 'info',
        code: 'max_tokens_reduced',
        message:
          maxOutput !== undefined && maxOutput < limits.maxTokens && reserve === maxOutput
            ? `max_tokens ${limits.maxTokens} is above what ${modelLabel(primary.conn.id, primary.model)} can write; ${reserve} is sent.`
            : `max_tokens ${limits.maxTokens} does not fit: the context window is ${window} tokens and at most half of it is kept for the reply, so ${reserve} is sent.`,
      },
    });
  }

  // The state the turn starts from: the head, except on a swipe (and a past answer's preview),
  // which regrows the answer from U (§6.3).
  const view = startView(input.header, input.tree, input.view, plan.upTo);
  // D-50: the model's token correction, learned from the earlier answers on this path that were
  // counted the same way.
  const tokenFactor = tokenFactorFor(input.tree, view, primary.model, input.counter.id);
  const books = loadLorebooks(input.home, plan.config.lorebooks ?? []);
  notices.push(...books.notices);

  let asm: AssembleResult;
  try {
    asm = assemble({
      sessionId: input.sessionId,
      view,
      upTo: plan.upTo,
      kind: plan.kind,
      cast: input.header.cast,
      preset: plan.preset,
      lorebooks: books.sources,
      ...(input.explain ? { explain: true } : {}),
      counter: input.counter,
      placements: input.placements,
      ...(plan.config.authorNote ? { authorNote: plan.config.authorNote } : {}),
      ...(plan.guidance ? { guidance: { text: plan.guidance, ...(plan.rejected !== undefined ? { rejected: plan.rejected } : {}) } } : {}),
      caps: primary.caps,
      window,
      reserve,
      tokenFactor,
      seed: input.seed,
      now: input.now,
      timeZone: input.timeZone,
      tools: [],
      prefillVsTools: plan.config.narrator.prefillVsTools,
    });
  } catch (e) {
    return { ok: false, code: 'assemble_failed', message: errMessage(e), notices };
  }
  if (!asm.ok) return { ok: false, code: asm.code, message: asm.message, notices };
  for (const n of asm.notices) {
    if (n.code === 'lore_regex_invalid' && asm.loreRegexErrors) notices.push(...regexNoticesPerEntry(asm.loreRegexErrors));
    else notices.push({ key: n.code, notice: n });
  }

  let shaped: Shaped;
  try {
    const out = shapeRequest(primary, asm, plan, input.header.cast);
    shaped = out.shaped;
    notices.push(...out.notices);
  } catch (e) {
    return { ok: false, code: 'shape_failed', message: errMessage(e), notices };
  }
  return { ok: true, window, reserve, limits, tokenFactor, view, asm, shaped, notices };
}
