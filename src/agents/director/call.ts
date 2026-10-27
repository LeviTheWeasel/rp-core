// Ported from Bunraku:src/studio/scene-director.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi:
// runDirector's order — the state at the answered message, the turn counted in the state, momentum
// before the call, enrich then the persona filter, an honest failure with no directive and the turn
// counted, fitState) and src/core/director/settings.ts (the 0.7 temperature).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// runDirector: one Director turn (ARCHITECTURE.md §7.3; .notes/m4-decisions.md D-101…D-106, D-110,
// D-117, D-119…D-121, D-123). The engine calls it from the turn body, before assemble; it never fails
// the turn: every outcome is a DirectorRecord (ok, or a code with the previous state and turn + 1).
//
//   swipe reuse (D-104) → directorAt(U) → momentum → profile (D-102) → prompts (D-110) fitted to the
//   window (D-121; no room → no_room, nothing sent) → structuredCall (readPlan inside `read`) →
//   server-truncation check → applyPlan → enrichFromMomentum → persona filter → fitState → record
//
// Also the helpers the engine and preview share: the directive's depth-1 insert, the preview stub,
// and the reuse decision. Provider error text is never stored (attempts carry the category's code and
// the HTTP status only).
//
// Port notes. Not ported: `produce` / commitDirector (the record is written by the turn into `prep`
// and the commit, D-104), the person's edits and their replay, activity lines (events and the
// record's attempts instead), tiers, the Compendium context (worldSnapshot, M5a), Bunraku's own
// planner call (structuredCall). Added: the swipe reuse (D-29), the lite/full profile (D-102), the
// Director's own route, window, max_tokens, reasoning and budget (D-101), the merged `skipped` list.

import type { Route } from '../../engine/admit.ts';
import { truncatedByServer } from '../../engine/ema.ts';
import { modelLabel } from '../../engine/route.ts';
import type { Samplers } from '../../formats/native.ts';
import { contextWindow } from '../../prompt/budget.ts';
import type { DepthInsert } from '../../prompt/depth.ts';
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS, type TokenCounter } from '../../prompt/tokens.ts';
import type { EventBody, Notice } from '../../protocol/events.ts';
import type { ModelCaps, ModelRequest } from '../../providers/types.ts';
import type { Binding, SessionConfig } from '../../session/entries.ts';
import type { TreeIndex } from '../../session/tree.ts';
import type { MessageView, PathView } from '../../session/view.ts';
import { AGENT_OUTPUT_FLOOR, chooseTransport, STRUCTURED_REFUSED_KEY, structuredCall, structuredRefusedMessage, type AgentCallEnv, type TraceCall, type Transport } from '../structured.ts';
import { computeMomentum, enrichFromMomentum, formatMomentumReport, planningPressures } from './momentum.ts';
import { PLAN_SCHEMA, PLAN_SCHEMA_LITE, readPlan } from './plan.ts';
import { historyLines, LITE_SHOW_LIMITS, selfAuditSection, systemPrompt, userPrompt, type HistoryMessage } from './prompt.ts';
import { applyPlan } from './reduce.ts';
import { renderDirective, sanitizeForPlayerCharacter, STUB_DIRECTIVE, summaryOf } from './render.ts';
import { checkRecord, directorAt, fitState } from './state.ts';
import {
  DIRECTOR_CALL,
  READ_LIMITS,
  REDUCER_VERSION,
  WORLD_FULL,
  WORLD_LITE,
  type DirectorFailCode,
  type DirectorRecord,
  type DirectorState,
  type MomentumReport,
  type NarratorDirective,
  type Skip,
  type WorldBudget,
} from './types.ts';

export type DirectorProfile = 'full' | 'lite';

/** A `director` event without the turn id (the engine stamps it). */
export type DirectorEvent = Omit<Extract<EventBody, { type: 'director' }>, 'type' | 'turnId'>;

/** trace.agents.director. */
export interface DirectorAgentRow {
  status: 'done' | 'reused' | 'failed';
  code?: string;
  transport?: Transport;
}

/** The player's persona as the Director sees it. */
export interface DirectorPersona {
  name: string;
  description?: string;
  aliases?: string[];
}

export interface RunDirectorInput {
  tree: TreeIndex;
  /** The view at U (its path ends at U). */
  view: PathView;
  /** U: the user message the answer replies to (a swipe's: the replaced answer's parent). */
  upTo: string;
  kind: 'reply' | 'swipe';
  /** swipe: the replaced answer. */
  replaced?: string;
  /** A guided re-roll's text (D-104). */
  guidance?: string;
  config: SessionConfig;
  persona?: DirectorPersona;
  charName: string;
  /** The Director's route; null = no connection (or its caps could not be resolved). */
  route: Route | null;
  binding: Binding;
  counter: TokenCounter;
  turnId: string;
  /** The Director's child signal of the turn. */
  turnSignal: AbortSignal;
  env: AgentCallEnv;
  /** M5a; absent → '' (no world section). */
  worldSnapshot?: (view: PathView, budget: WorldBudget) => string;
  emit(ev: DirectorEvent): void;
  /** A once-per-session notice: the engine tells it when `key` was not told yet. */
  notice(key: string, notice: Notice): void;
}

/** What a Director turn left: the record for prep/commit, its Trace.calls rows, its trace.agents row. */
export interface DirectorRun {
  record: DirectorRecord;
  calls: TraceCall[];
  agent: DirectorAgentRow;
}

// ---- the inserts (D-106) ----------------------------------------------------------------------------

/** The directive at depth 1 as a system message; none when absent or when it renders ''. */
export function directiveInsert(directive: NarratorDirective | undefined): DepthInsert[] {
  if (directive === undefined) return [];
  const text = renderDirective(directive);
  return text === '' ? [] : [{ depth: 1, role: 'system', src: 'director', text }];
}

/** What the preview puts at depth 1 for a turn the Director has not planned yet. */
export function stubInsert(): DepthInsert[] {
  return [{ depth: 1, role: 'system', src: 'director', text: STUB_DIRECTIVE }];
}

// ---- reuse (D-29, D-104) ----------------------------------------------------------------------------

/** The names the persona filter guards: the persona's name and aliases. */
export function personaNames(persona: DirectorPersona | undefined): string[] {
  if (!persona) return [];
  return [persona.name, ...(persona.aliases ?? [])].filter((n) => typeof n === 'string' && n.trim() !== '');
}

/** A swipe that keeps the replaced answer's plan: onSwipe 'reuse' and no guidance. */
export function swipeReuses(config: SessionConfig, guidance: string | undefined): boolean {
  return config.director.onSwipe === 'reuse' && (guidance === undefined || guidance.trim() === '');
}

/**
 * The record a swipe reuses (D-104): a copy of the replaced answer's `dir` when it planned (ok), with
 * no attempts, `reusedFrom` the answer whose plan it first was, and the persona filter run again on
 * the directive with today's names (its skips are the copy's `skipped`). null: nothing to reuse.
 */
export function reusedRecord(tree: TreeIndex, replaced: string, persona: DirectorPersona | undefined): DirectorRecord | null {
  const rec = checkRecord(tree.msgs.get(replaced)?.dir);
  if (rec === null || !rec.ok) return null;
  const filtered = rec.directive ? sanitizeForPlayerCharacter(rec.directive, personaNames(persona)) : null;
  const copy: DirectorRecord = { ...rec, attempts: [], skipped: filtered?.skipped ?? [], reusedFrom: rec.reusedFrom ?? replaced };
  if (filtered) copy.directive = filtered.directive;
  return copy;
}

// ---- prompt pieces ----------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON Schema without its `description` keywords (property NAMES called description stay). */
export function withoutDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDescriptions);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description' && typeof v === 'string') continue;
    out[k] = k === 'properties' && isRecord(v) ? Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, withoutDescriptions(sub)])) : withoutDescriptions(v);
  }
  return out;
}

/** D-110, D-117: the tagged schema text, compact JSON; lite without descriptions. */
const SCHEMA_TEXT: Readonly<Record<DirectorProfile, string>> = {
  full: JSON.stringify(PLAN_SCHEMA),
  lite: JSON.stringify(withoutDescriptions(PLAN_SCHEMA_LITE)),
};

/** D-117: the json_schema name of the structured transport. */
export const PLAN_SCHEMA_NAME = 'director_plan';

const textOf = (m: Pick<MessageView, 'blocks'>): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/** D-110: the visible path messages before U, text blocks only, the greeting included. */
function historyOf(view: PathView, upTo: string, names: { user: string; char: string }): HistoryMessage[] {
  const at = view.path.findIndex((m) => m.id === upTo);
  const before = at < 0 ? view.path : view.path.slice(0, at);
  return before.flatMap((m) => {
    const text = textOf(m);
    if (m.hidden || text.trim() === '') return [];
    return [{ role: m.role, name: m.role === 'user' ? names.user : names.char, text }];
  });
}

/** A positive finite token limit, floored; else undefined. */
const tokenLimit = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);

/** D-101 reasoning: the binding's; else off when the model can turn it off; else 'low' when it takes an effort. */
function reasoningFor(binding: Binding, caps: ModelCaps): ModelRequest['reasoning'] | undefined {
  if (binding.reasoning !== undefined) return binding.reasoning;
  if (caps.reasoning.canDisable) return 'none';
  if (caps.reasoning.control === 'effort' && (caps.reasoning.efforts === undefined || caps.reasoning.efforts.includes('low'))) return 'low';
  return undefined;
}

/** D-101: the binding's samplers only (never the preset's), temperature 0.7 unless set; max_tokens goes to maxTokens. */
function samplersFor(binding: Binding): Partial<Samplers> {
  const { max_tokens: _limit, ...own } = binding.samplers ?? {};
  return { ...own, temperature: own.temperature ?? DIRECTOR_CALL.temperature };
}

/** D-117: the record's skipped list, capped once at READ_LIMITS.skipped then `+N more` (earlier caps folded in). */
export function capSkipped(lists: readonly (readonly Skip[])[]): Skip[] {
  let hidden = 0;
  const real: Skip[] = [];
  for (const list of lists) {
    for (const s of list) {
      const more = s.path === 'skipped' ? /^\+(\d+) more$/.exec(s.why) : null;
      if (more) hidden += Number(more[1]);
      else real.push(s);
    }
  }
  const max = READ_LIMITS.skipped;
  const extra = Math.max(0, real.length - max) + hidden;
  return extra > 0 ? [...real.slice(0, max), { path: 'skipped', why: `+${extra} more` }] : real;
}

// ---- the call ---------------------------------------------------------------------------------------

/** The prompts of one profile. */
interface Prompts {
  system: string;
  user: string[];
}

/** How a prompt is fitted to the window (D-121): with its history share, and with the full lists. */
interface Fit {
  history: boolean;
  limits: boolean;
}
const FIT_NORMAL: Fit = { history: true, limits: false };
/** D-121: the lite prompt's shrink order: as is → no history → no history and LITE_SHOW_LIMITS. */
const LITE_FITS: readonly Fit[] = [FIT_NORMAL, { history: false, limits: false }, { history: false, limits: true }];

/**
 * D-121: below this many output tokens left by the prompt in the window no Director call is sent
 * (no_room); the corrective pass's floor (structured.ts) is the same number.
 */
export const DIRECTOR_OUTPUT_FLOOR = AGENT_OUTPUT_FLOOR;

/** What the conversation section says when the history was left out to fit the window (D-121). */
const HISTORY_LEFT_OUT = '[The conversation history is left out: your context window is too small for it this turn.]';

/**
 * One Director turn (D-105). Never throws for provider trouble; a bug in a pure step propagates
 * (the turn's crash handler fails the turn, as for any internal error).
 */
export async function runDirector(input: RunDirectorInput): Promise<DirectorRun> {
  const { tree, upTo, config, persona } = input;

  // D-104: a plain swipe keeps the plan the replaced answer was written under.
  if (input.kind === 'swipe' && input.replaced !== undefined && swipeReuses(config, input.guidance)) {
    const copy = reusedRecord(tree, input.replaced, persona);
    if (copy !== null) {
      const before = directorAt(tree, upTo).state;
      input.emit({ status: 'reused', summary: summaryOf(before, copy.state) });
      return { record: copy, calls: [], agent: { status: 'reused', ...(copy.transport ? { transport: copy.transport } : {}) } };
    }
  }

  const at = directorAt(tree, upTo);
  if (at.invalid > 0) {
    input.notice('director_state_invalid', {
      level: 'warn',
      code: 'director_state_invalid',
      message: `${at.invalid} Director record${at.invalid === 1 ? '' : 's'} on this path could not be read; the Director plans from the last one it can read (or from the start).`,
    });
  }
  const prev = at.state;
  const turn = prev.turn + 1;
  const failure = (code: DirectorFailCode, extra: Partial<DirectorRecord> = {}, calls: TraceCall[] = []): DirectorRun => {
    const fitted = fitState({ ...prev, turn });
    input.emit({ status: 'failed', reason: code });
    return {
      record: { turn, ok: false, code, ...extra, skipped: fitted.skipped, attempts: extra.attempts ?? [], state: fitted.state, reducer: REDUCER_VERSION },
      calls,
      agent: { status: 'failed', code, ...(extra.transport ? { transport: extra.transport } : {}) },
    };
  };

  const route = input.route;
  if (route === null) return failure('no_connection');
  const caps = route.caps;
  const label = modelLabel(route.conn.id, route.model);
  const report = computeMomentum(prev, turn);
  // D-101: the Director's own window (preset.maxContext is the narrator's).
  const window = contextWindow({ caps, local: route.conn.local, ...(config.window !== undefined ? { configWindow: config.window } : {}) });
  const transport = chooseTransport(caps);
  const count = (s: string): number => estimateTokens(s, input.counter);
  const prompts = (profile: DirectorProfile, fit: Fit = FIT_NORMAL): Prompts => buildPrompts(input, profile, transport, prev, turn, report, window, count, fit);
  const tokensOf = (p: Prompts): number =>
    count(p.system) + MESSAGE_OVERHEAD_TOKENS + p.user.reduce((n, u) => (u.trim() === '' ? n : n + count(u) + MESSAGE_OVERHEAD_TOKENS), 0);
  const liteNotice = (why: string): void =>
    input.notice('director_lite', { level: 'info', code: 'director_lite', message: `director.profile is 'full', but ${why}: the Director runs its lite profile.` });

  // D-101: reasoning (the lite output reserve depends on it).
  const reasoning = reasoningFor(input.binding, caps);
  const thinks = caps.reasoning.output !== 'none' && !(reasoning === 'none' && caps.reasoning.canDisable);
  const liteReserve = DIRECTOR_CALL.liteMaxTokens + (thinks ? DIRECTOR_CALL.liteReasoningExtra : 0);

  // D-102 + D-121: the profile. Full runs only when its prompt leaves its output reserve in the window
  // (the auto test, and an explicit 'full' too); otherwise lite.
  let p: Prompts | undefined;
  const want = config.director.profile;
  if (want === 'full' && window < DIRECTOR_CALL.fullMinWindow) {
    liteNotice(`${label} has a window of ${window} tokens (below ${DIRECTOR_CALL.fullMinWindow})`);
  } else if (want === 'full' || (want !== 'lite' && window >= DIRECTOR_CALL.liteWindow)) {
    const full = prompts('full');
    const need = tokensOf(full) + DIRECTOR_CALL.fullOutputReserve;
    if (need <= window) p = full;
    else if (want === 'full') liteNotice(`its full prompt and ${DIRECTOR_CALL.fullOutputReserve} tokens for the plan (${need}) do not fit the window of ${label} (${window} tokens)`);
  }
  const profile: DirectorProfile = p === undefined ? 'lite' : 'full';
  const lite = profile === 'lite';
  // D-121: a lite prompt over its room (window − output reserve) shrinks: no history, then shorter lists.
  if (p === undefined) {
    for (const fit of LITE_FITS) {
      p = prompts('lite', fit);
      if (tokensOf(p) + liteReserve <= window) break;
    }
  }
  const sent = p!;
  const promptTokens = tokensOf(sent);

  // D-101 + D-121: max_tokens within what the window leaves; below the floor nothing is sent.
  const room = window - promptTokens;
  if (room < DIRECTOR_OUTPUT_FLOOR) {
    input.notice('director_no_room', {
      level: 'warn',
      code: 'director_no_room',
      message:
        `The Director's model window (${label}, ${window} tokens) is too small for its prompt (about ${promptTokens} tokens, shortened) ` +
        `and a plan: the Director does not plan. Give it a bigger window or a model with one (roles.director).`,
    });
    return failure('no_room', { profile, model: label });
  }
  const capOut = tokenLimit(caps.maxOutput) ?? Infinity;
  const bindOut = tokenLimit(input.binding.maxTokens) ?? tokenLimit(input.binding.samplers?.max_tokens) ?? Infinity;
  const wanted = lite ? liteReserve : DIRECTOR_CALL.fullMaxTokens;
  const maxTokens = Math.max(1, Math.floor(Math.min(wanted, room, capOut, bindOut)));
  const budgetSec = config.director.timeoutSec ?? input.env.timeouts.firstByteMs / 1000 + 60;

  input.emit({ status: 'planning' });
  const res = await structuredCall({
    agent: 'director',
    schema: { name: PLAN_SCHEMA_NAME, schema: lite ? PLAN_SCHEMA_LITE : PLAN_SCHEMA },
    read: (raw) => readPlan(raw, { lite }),
    system: sent.system,
    user: sent.user,
    tag: 'plan',
    route,
    transport,
    samplers: samplersFor(input.binding),
    ...(reasoning !== undefined ? { reasoning } : {}),
    maxTokens,
    count,
    repair: true,
    callKeyPrefix: `${input.turnId}:director`,
    budgetMs: budgetSec * 1000,
    turnSignal: input.turnSignal,
    env: input.env,
  });

  // D-121: the narrator's server-truncation check on the Director's calls (a server that cut the
  // prompt to a smaller window reports far fewer prompt tokens); told once per session.
  const cut = res.calls.find((c) => truncatedByServer(promptTokens, c.usage?.inputTotal));
  if (cut !== undefined) {
    input.notice('context_truncated_by_server', {
      level: 'warn',
      code: 'context_truncated_by_server',
      message:
        `The server reported ${cut.usage!.inputTotal} prompt tokens for a Director prompt of about ${promptTokens}: it probably cut the prompt to fit a ` +
        `context window smaller than the ${window} tokens assumed for ${label}, dropping parts of it unseen. ` +
        `Set context_length under [caps."${label}"] in config.toml (\`rp-core probe ${label}\` reads what the server reports), ` +
        `or give the model a larger window on the server.`,
    });
  }

  const known = { transport, profile, model: label } as const;
  if (!res.ok) {
    if (res.code === 'transport_unsupported') {
      input.notice(STRUCTURED_REFUSED_KEY, { level: 'warn', code: 'caps.suggest', message: structuredRefusedMessage(label) });
    }
    // D-117: `invalid` (a reader's refusal of the root) reads as an undecodable plan.
    const code: DirectorFailCode = res.code === 'invalid' ? 'undecodable' : res.code;
    return failure(code, { ...known, attempts: res.attempts }, res.calls);
  }

  const round = res.value;
  // applyPlan stores the AUTHORED directive as state.lastDirective; the narrator gets the enriched,
  // filtered one.
  const applied = applyPlan(prev, round, { turn });
  const enriched = enrichFromMomentum(round.directive, report);
  const filtered = sanitizeForPlayerCharacter(enriched, personaNames(persona));
  const fitted = fitState(applied.state);
  const record: DirectorRecord = {
    turn,
    ok: true,
    ...known,
    directive: filtered.directive,
    ...(Object.keys(round.analysis).length > 0 ? { analysis: round.analysis } : {}),
    skipped: capSkipped([res.skipped, applied.skipped, filtered.skipped, fitted.skipped]),
    attempts: res.attempts,
    state: fitted.state,
    reducer: REDUCER_VERSION,
    ...(res.fromReasoning ? { fromReasoning: true as const } : {}),
  };
  input.emit({ status: 'planned', summary: summaryOf(prev, fitted.state) });
  return { record, calls: res.calls, agent: { status: 'done', transport } };
}

/**
 * D-110: the system prompt and the two user messages (prompt, pressures) of one profile; `fit` (D-121)
 * leaves the history out and shortens the shown lists of a lite prompt that must fit a small window.
 */
function buildPrompts(
  input: RunDirectorInput,
  profile: DirectorProfile,
  transport: Transport,
  state: DirectorState,
  turn: number,
  report: MomentumReport,
  window: number,
  count: (s: string) => number,
  fit: Fit,
): Prompts {
  const lite = profile === 'lite';
  const { config, persona, view, upTo } = input;
  const personaName = persona?.name.trim() ?? '';
  const system = systemPrompt({
    profile,
    transport,
    style: config.director.style,
    creativity: config.director.creativity,
    ...(persona ? { persona: { name: persona.name, ...(persona.description !== undefined ? { description: persona.description } : {}) } } : {}),
    charName: input.charName,
    ...(transport === 'tagged' ? { schemaText: SCHEMA_TEXT[profile] } : {}),
  });

  const msgs = historyOf(view, upTo, { user: personaName || 'the player', char: input.charName });
  const share = lite ? DIRECTOR_CALL.historyShareLite : DIRECTOR_CALL.historyShareFull;
  const history = !fit.history
    ? msgs.length > 0
      ? HISTORY_LEFT_OUT
      : ''
    : historyLines(msgs, Math.floor(window * share), count);

  // D-110: the self-audit runs when the previous Director turn planned and U answers a reply; never
  // on a hidden reply (D-123: hiding takes its text out of every prompt).
  const u = view.path.find((m) => m.id === upTo);
  const parent = u?.parent ? view.path.find((m) => m.id === u.parent) : undefined;
  const last = state.lastDirective;
  const audit =
    last !== undefined && last.turn === state.turn && parent?.role === 'assistant' && !parent.hidden ? selfAuditSection(last.directive, textOf(parent)) : '';

  const world = input.worldSnapshot?.(view, lite ? WORLD_LITE : WORLD_FULL) ?? '';
  const user = userPrompt({
    profile,
    state,
    turn,
    momentumText: formatMomentumReport(report, { lite }),
    worldText: world,
    userMessage: u ? textOf(u) : '',
    ...(input.guidance !== undefined && input.guidance.trim() !== '' ? { guidance: input.guidance } : {}),
    instructions: config.director.instructions ?? '',
    history,
    historyCount: msgs.length,
    ...(audit !== '' ? { selfAudit: audit } : {}),
    rhythm: report.rhythm,
    ...(fit.limits ? { limits: LITE_SHOW_LIMITS } : {}),
  });
  return { system, user: [user, planningPressures(state, report, { lite })] };
}
