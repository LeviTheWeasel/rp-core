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
//
// M3 (.notes/m3-decisions.md C): the notes book joins the lore sources; the tools are chosen in two
// passes. Pass A assembles without tools, byte-identical to M2. The history tools are offered when
// pass A had to trim the history, the lore tools when some enabled entry (or live note) of the
// turn's lore did not fire; none on a continue or for caps.tools 'none'. With nothing to offer,
// pass A is the request. Otherwise pass B assembles with the specs (core block, tool room [D-93],
// the prefill rule [D-28] inside assemble), the history carrying this model's own reasoning when its
// tool requests echo it [D-94 revised]. Pass B trims more than pass A (the room, the core block): when
// the request it sends leaves history out and the history tools are not offered yet, they are, and
// pass B runs once more. The result carries the turn's TurnTools: the dispatch table and the ToolCtx
// every round reads.
//
// M4 (D-106): while director.enabled the core block holds the Director's contract on every kind
// (continue included) and in previews, so the head stays the same whether or not the Director planned;
// the directive itself arrives in `placements` (depth 1). Director off: no contract, the M3 bytes.

import { contractText } from '../agents/director/render.ts';
import type { Route } from './admit.ts';
import { MIN_ROOM_TOKENS, type TurnTools } from './narrate.ts';
import { tokenFactorFor } from './ema.ts';
import { modelLabel } from './route.ts';
import { NOTES_BOOK_KEY, notesBook } from '../agents/compendium/notes.ts';
import type { Preset, Samplers } from '../formats/native.ts';
import { validateLoreBook } from '../formats/native.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { entryKey, entryLabel, type LoreRunResult, type LoreSource } from '../lore/engine.ts';
import { assemble, type AssembleInput, type AssembleResult } from '../prompt/assemble.ts';
import { loreSources, regexNotice } from '../prompt/assemble/lore.ts';
import { contextWindow, replyReserve } from '../prompt/budget.ts';
import type { DepthInsert } from '../prompt/depth.ts';
import { subRng } from '../prompt/rng.ts';
import { shape } from '../prompt/shape.ts';
import { estimateTokens, type TokenCounter } from '../prompt/tokens.ts';
import type { Notice } from '../protocol/events.ts';
import type { PromptMsg } from '../providers/types.ts';
import type { Binding, SessionConfig, SessionHeader, TurnKind } from '../session/entries.ts';
import { foldViewAt } from '../session/fold.ts';
import type { TreeIndex } from '../session/tree.ts';
import type { PathView } from '../session/view.ts';
import { HISTORY_TOOLS, LORE_TOOLS, toolSpecs } from '../tools/builtin/index.ts';
import { HandleTable } from '../tools/handles.ts';
import type { Tool } from '../tools/types.ts';

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
  /**
   * TEST SEAM (M3): the tool sets the selection draws from instead of the built-ins (EngineSeams
   * toolSets). Hosts never set it; the rules that decide WHEN a set is offered stay the same.
   */
  toolSets?: ToolSets;
}

/** The tool sets the two-pass selection offers (C1): each is offered whole or not at all. */
export interface ToolSets {
  /** Offered when the history did not fit whole (pass A trimmed it). */
  history(): Tool[];
  /** Offered when the turn's lore holds an enabled entry or live note that did not fire. */
  lore(): Tool[];
}

/** The built-in sets: search_history + read_history, search_lore + read_lore. */
export const BUILTIN_TOOL_SETS: ToolSets = { history: HISTORY_TOOLS, lore: LORE_TOOLS };

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
      /**
       * M3: the tools this turn offers, fixed for the turn (§9.1): null when none (continue,
       * caps.tools 'none', the prefill rule [D-28], or nothing worth offering — see
       * .notes/m3-decisions.md "tool selection").
       */
      tools: TurnTools | null;
      /**
       * M3: the history carries this route's raw reasoning for the DeepSeek echo (D-94 revised: tools
       * offered natively, caps.reasoning.echo 'all-with-tools', thinking on). Another model must never
       * get it (§8.6): a fallback whose echo rule differs rebuilds the request (turn.ts).
       */
      echo?: true;
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
  // C5: the path's live notes are one more book, before the session's (the lore engine gathers
  // '@notes' after '@card'); none without notes, so an M2 request stays as it was.
  const notes = notesBook(view.compendium);
  const lorebooks: LoreSource[] = notes ? [{ key: NOTES_BOOK_KEY, book: notes }, ...books.sources] : books.sources;

  const base: AssembleInput = {
    sessionId: input.sessionId,
    view,
    upTo: plan.upTo,
    kind: plan.kind,
    cast: input.header.cast,
    preset: plan.preset,
    lorebooks,
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
    ...(plan.config.director?.enabled === true ? { contract: contractText(input.header.cast.persona?.name ?? '') } : {}),
    prefillVsTools: plan.config.narrator.prefillVsTools,
  };
  const common = { window, reserve, limits, tokenFactor, view };

  // Pass A: no tools, exactly the M2 request.
  const a = assembleAndShape(base, primary, plan, input.header.cast);
  if (!a.ok) return { ok: false, code: a.code, message: a.message, notices: [...notices, ...a.notices] };
  const passA = (): BuiltRequest => ({ ok: true, ...common, asm: a.asm, shaped: a.shaped, notices: [...notices, ...a.notices], tools: null });

  // C1: what is worth offering, read off pass A.
  const transport = primary.caps.tools;
  if (plan.kind === 'continue' || transport === 'none') return passA();
  const sets = input.toolSets ?? BUILTIN_TOOL_SETS;
  const sources = loreSources(input.header.cast, lorebooks);
  const history = a.asm.trace.trimmed !== null;
  let offered: Tool[] = [...(history ? sets.history() : []), ...(unfiredLore(sources, a.asm.trace.lore.fired) ? sets.lore() : [])];
  if (offered.length === 0) return passA();

  // Pass B: with the specs and, when this route's tool requests echo reasoning (D-94 revised), this
  // model's own reasoning in the history (every other answer goes out with the adapter's placeholder).
  const echoOf = echoRuleOf(primary, plan.binding.reasoning);
  const passB = (list: readonly Tool[]) =>
    assembleAndShape({ ...base, tools: toolSpecs(list), ...(echoOf ? { echoReasoning: echoOf } : {}) }, primary, plan, input.header.cast);
  let b = passB(offered);
  // Tools are optional: a request that cannot carry them (the core block does not fit) goes without.
  if (!b.ok) return passA();
  // D-28 turned them off inside assemble: pass B is the request (its trace and notice say why).
  if (b.asm.tools.length === 0) return { ok: true, ...common, asm: b.asm, shaped: b.shaped, notices: [...notices, ...b.notices], tools: null };
  // Too little room for even one round of results: tools would only cost the core block.
  if (b.asm.toolRoom < MIN_ROOM_TOKENS) return passA();
  // C1 reads "the history did not fit" off the request actually sent: pass B reserves the room and the
  // core block, so it may trim history pass A kept. Then the history set joins and pass B runs once
  // more (more tools only trim more, so one step settles it; D-96's gap note follows the set). When
  // that request cannot carry the tools (a small window), the history set goes alone: with the history
  // cut, reading it matters more than the lore pass A left unfired. When neither fits, the first pass
  // B stands.
  if (!history && b.asm.trace.trimmed !== null) {
    const more = sets.history();
    if (more.length > 0) {
      for (const list of [[...more, ...offered], more]) {
        const c = passB(list);
        if (c.ok && c.asm.tools.length > 0 && c.asm.toolRoom >= MIN_ROOM_TOKENS) {
          b = c;
          offered = list;
          break;
        }
      }
    }
  }

  // C6: the per-turn tool context; signal and pageChars come per round (narrate.ts).
  const kept = new Set(b.asm.kept);
  const cast = input.header.cast;
  const tools: TurnTools = {
    transport,
    tools: new Map(offered.map((t) => [t.name, t])),
    specs: b.asm.tools,
    ctx: {
      view,
      upTo: plan.upTo,
      names: { char: cast.character.name, user: cast.persona?.name || 'User' },
      lore: sources,
      compendium: view.compendium,
      handles: new HandleTable(),
      inContext: (id) => kept.has(id),
      now: input.now,
      rng: subRng(input.seed, 'tools'),
    },
    roomTokens: b.asm.toolRoom,
    window,
    tokenFactor,
    count: (text) => estimateTokens(text, input.counter),
  };
  return {
    ok: true,
    ...common,
    asm: b.asm,
    shaped: b.shaped,
    notices: [...notices, ...b.notices],
    tools,
    ...(echoOf ? { echo: true as const } : {}),
  };
}

/**
 * D-94 (revised): the connection and model whose raw reasoning a route's tool requests echo, or null
 * when they echo none: native tools, caps.reasoning.echo 'all-with-tools' and thinking on for the
 * call (not `reasoning 'none'` on a model that can turn thinking off; the adapter's rule, wire.ts
 * echoesReasoning). Pass B keeps that model's reasoning blocks in the history; a fallback whose rule
 * differs from the primary's gets its own request.
 */
export function echoRuleOf(route: Route, reasoning: Binding['reasoning']): { connection: string; model: string } | null {
  const caps = route.caps;
  if (caps.tools !== 'native' || caps.reasoning.echo !== 'all-with-tools') return null;
  if (reasoning === 'none' && caps.reasoning.canDisable) return null;
  return { connection: route.conn.id, model: route.model };
}

/** One assemble + shape for the primary route, with their notices keyed. */
function assembleAndShape(
  input: AssembleInput,
  primary: Route,
  plan: RequestPlan,
  cast: SessionHeader['cast'],
): { ok: true; asm: AssembledOk; shaped: Shaped; notices: KeyedNotice[] } | { ok: false; code: RequestFailure; message: string; notices: KeyedNotice[] } {
  const notices: KeyedNotice[] = [];
  let asm: AssembleResult;
  try {
    asm = assemble(input);
  } catch (e) {
    return { ok: false, code: 'assemble_failed', message: errMessage(e), notices };
  }
  if (!asm.ok) return { ok: false, code: asm.code, message: asm.message, notices };
  for (const n of asm.notices) {
    if (n.code === 'lore_regex_invalid' && asm.loreRegexErrors) notices.push(...regexNoticesPerEntry(asm.loreRegexErrors));
    else notices.push({ key: n.code, notice: n });
  }
  try {
    const out = shapeRequest(primary, asm, plan, cast);
    notices.push(...out.notices);
    return { ok: true, asm, shaped: out.shaped, notices };
  } catch (e) {
    return { ok: false, code: 'shape_failed', message: errMessage(e), notices };
  }
}

/** C1: some enabled entry of the turn's lore (a live note included) did not fire in pass A. */
export function unfiredLore(sources: readonly LoreSource[], fired: readonly { book: string; id: string }[]): boolean {
  const done = new Set(fired.map((f) => entryKey(f.book, f.id)));
  return sources.some((s) => s.book.entries.some((e) => e.enabled !== false && !done.has(entryKey(s.key, e.id))));
}
