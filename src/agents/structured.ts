// Ported from Bunraku:src/studio/scene-director-call.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (planTurn:
// one time budget for every call of the agent, the attempt log, the base messages system + user(s),
// one corrective pass with the bad answer echoed back) and
// Bunraku:src/core/compendium/recall-parse.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (firstObject).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// structuredCall: how every JSON agent (the Director now; recall, filing and historian in M5) gets one
// JSON object out of a model (ARCHITECTURE.md §7.2, D-60; .notes/m4-decisions.md D-98…D-101).
//
// Port notes. Kept from planTurn: one budget covers the call, its retry and the corrective pass; the
// messages are system, then the user messages in order (a blank one is not sent); the corrective
// pass appends the bad answer as an assistant message and a fixed instruction as a user message, and
// its result is final; a failure is a code, never an empty success. Changed: the call is narrate.ts
// streamCall (key, origin semaphore, first-byte and idle timeouts), its text and reasoning collected
// silently; the budget starts when the first call holds its semaphore slot (onSlot, D-101), not at
// the start; the transport is 'structured' (the schema rides the request as responseSchema) or
// 'tagged' (the caller put the schema in the system prompt), never a forced tool; a `<plan>` answer
// is found by the M3 prompted scanner (D-99) instead of a `<tool_call>` regex, and a bare object by
// firstObject (D-117: a plan envelope is unwrapped on both transports, a nameless `<tool_call>` with
// a directive is a plan, and a directive object is still taken when every tag block failed); JSON
// is decoded by tools/args.ts looseJson (jsonrepair) instead of JSON.parse; when
// the visible text holds nothing, the reasoning is searched too (D-60, outcome 'ok_reasoning');
// provider errors get the shared §6.6 retry only (isRetryable / retryDelayMs, event `retry`), not
// Bunraku's own transient resend; the corrective pass runs only after a reading failure (never after
// a provider error, a timeout or a Stop), echoes at most 1 000 characters and is optional
// (`repair`); attempts carry typed outcomes, the HTTP status and output tokens (Bunraku parsed the
// status out of the error text, attempt-error.ts, not ported). Not ported: FAILURE_COPY (the caller
// words failures), `extra` (a later block is a `skipped` entry), `no_tool_support` (no tool transport).
// firstObject: Bunraku's scan of every '{' with a string-aware brace count, a ```json fence first;
// changed: it returns the object's TEXT for looseJson (an object that does not parse strictly is
// still found when it looks like JSON) and says whether the object closed.
// After the M4 review (D-121…D-123): the corrective pass lowers maxTokens by what its echo and
// correction add and is skipped below AGENT_OUTPUT_FLOOR (when the caller gives a counter);
// transport_unsupported is only a structured 400 bad_request before any output; an empty plan
// block or an argument-less plan call is not the plan (the search goes on) and no extra block.
// M5b (D-172): a call runs at the caller's priority; a background call an interactive request preempts
// ends the agent's call with code 'preempted' (no retry, no corrective pass), and filing and historian
// have their own budget reasons. A tag:null agent's answer may be a JSON list (firstJson; the lead's
// ruling G): its reader decides what the list holds. After the M5b review (ruling I): a background
// call's budget runs only while it holds a slot; a tag:null answer cut off before its JSON closed keeps
// the items that closed and drops the unfinished last one, and fails when none closed.
// After the final check (the lead's ruling K): a cut-off root object that is itself one item (a bare flat
// item: it has a type, an identity or an entry key and no envelope) is unreadable, its own lists are its
// fields; and a tag:null result says `cutOff` (finish 'length', or a JSON closed by closedItems) so the
// lane can fail a cut-off answer that gave it nothing to apply.

import { abortableDelay, abortWith, childController, reasonOf, type AbortReason, type DelayTimers } from '../engine/abort.ts';
import type { Connection, EngineOptions } from '../engine/api.ts';
import { priceFor, usageCost } from '../engine/cost.ts';
import { streamCall, type CallResult, type CallTimeouts } from '../engine/narrate.ts';
import { isRetryable, modelLabel, retryDelayMs } from '../engine/route.ts';
import type { Priority, Scheduler } from '../engine/sched.ts';
import type { Samplers } from '../formats/native.ts';
import type { EventBody } from '../protocol/events.ts';
import { MESSAGE_OVERHEAD_TOKENS } from '../prompt/tokens.ts';
import { createReasoningSplitter, DEFAULT_REASONING_TAGS, tagPairs } from '../providers/reasoning-tags.ts';
import type { JSONSchema, ModelCaps, ModelRequest, PromptMsg, ProviderError, Usage } from '../providers/types.ts';
import type { RandomBytes } from '../session/ids.ts';
import { looseJson } from '../tools/args.ts';
import { balancedEnd, parsePromptedCalls, type OfferedTool } from '../tools/prompted.ts';
import { DIRECTOR_CALL, type ReadResult, type Skip } from './director/types.ts';

// ---- the contract (D-98) --------------------------------------------------------------------------

export type StructuredAgent = 'director' | 'recall' | 'filing' | 'historian';
export type Transport = 'structured' | 'tagged';

export type StructuredFailCode =
  | 'transport_unsupported'
  | 'provider_error'
  | 'no_output'
  | 'undecodable'
  | 'invalid'
  | 'missing_directive'
  | 'timeout'
  | 'aborted'
  /** M5b (D-172): a background call whose place an interactive request took; not an attempt for the lane. */
  | 'preempted';

export type AttemptOutcome =
  | 'ok'
  | 'ok_reasoning'
  | 'retried'
  | 'no_output'
  | 'undecodable'
  | 'invalid'
  | 'missing_directive'
  | 'provider_error'
  | 'transport_unsupported'
  | 'timeout'
  | 'aborted'
  | 'preempted';

/** One model call of the agent, as the record and the trace keep it. */
export interface Attempt {
  transport: Transport;
  outcome: AttemptOutcome;
  ms: number;
  status?: number;
  /** The call's finish (the normalised reason: 'end', 'length', …). */
  finish?: string;
  /** Output tokens. */
  tokens?: number;
}

/** A Trace.calls row (§5.7): one per model call, retried ones included. */
export interface TraceCall {
  callKey: string;
  agent: StructuredAgent;
  /** 'conn:model'. */
  model: string;
  ms: number;
  usage?: Usage;
}

/** The events an agent call sends through its env (the engine stamps the session id and time). */
export type AgentCallEvent = Extract<EventBody, { type: 'retry' } | { type: 'usage' }>;

/** What an agent's call needs from the engine (EngineCtx parts; the turn builds it per route). */
export interface AgentCallEnv {
  sched: Scheduler;
  fetch: typeof fetch;
  /** The route's call timeouts: timeoutsFor(route.conn, ctx.timeouts). */
  timeouts: CallTimeouts;
  timers: DelayTimers;
  clock: () => Date;
  random: RandomBytes;
  /** §6.6 retry-after cap (EngineCtx.retryMaxDelayMs). */
  retryMaxDelayMs?: number;
  /** [prices."conn:model"] for the usage events' cost (§11). */
  prices?: EngineOptions['prices'];
  /** `retry` and `usage` events (usage carries the agent). */
  emit(ev: AgentCallEvent): void;
  /** The host's debug tap for raw provider failures (§13); never an event. */
  onProviderError?(info: { callKey: string; model: string; error: ProviderError }): void;
  /** M5a (D-164, --keep-requests): handed each request right before the provider gets it. */
  keepRequest?(req: ModelRequest): void;
}

export interface StructuredInput<T> {
  agent: StructuredAgent;
  /** Sent as responseSchema on the structured transport. */
  schema: { name: string; schema: JSONSchema };
  /** raw = the decoded JSON value; its root is already an object (tag null: an object or a list, M5b). */
  read(raw: unknown): ReadResult<T>;
  /** Tagged: the caller already put the schema and "How to answer" in it. */
  system: string;
  /** One or more user messages, in order (Director: prompt, pressures); a blank one is not sent. */
  user: string[];
  tag: 'plan' | null;
  route: { conn: Connection; model: string; caps: ModelCaps };
  /** chooseTransport(caps), fixed for the turn. */
  transport: Transport;
  samplers: Partial<Samplers>;
  reasoning?: ModelRequest['reasoning'];
  maxTokens: number;
  /**
   * The session's token counter (D-121): the corrective pass lowers maxTokens by what its echo and
   * correction text add, so prompt + max_tokens stays inside the window. Absent: maxTokens as is.
   */
  count?: (text: string) => number;
  /** false: no corrective pass (recall lite, M5). */
  repair: boolean;
  /** e.g. `${turnId}:director` → `${prefix}:0`, `:1`, … one per call. */
  callKeyPrefix: string;
  /** The agent's whole time budget, from its first semaphore slot on (D-101); background: only while a call holds a slot. */
  budgetMs: number;
  /** The agent's child signal of the turn (Stop reaches the calls through it). */
  turnSignal: AbortSignal;
  env: AgentCallEnv;
  /**
   * M5b (D-172): the semaphore priority of every call; absent = 'interactive' (narrator, Director,
   * recall-sync). 'background' (filing, historian) may end with code 'preempted'.
   */
  priority?: Priority;
  /** M5b (D-172): background only, the session's compendium.idleDelaySec (the local idle gate). */
  idleDelaySec?: number;
}

/** `C`: the failure codes the call can end with (an interactive call is never preempted). */
export type StructuredResult<T, C extends StructuredFailCode = StructuredFailCode> =
  | {
      ok: true;
      value: T;
      transport: Transport;
      skipped: Skip[];
      attempts: Attempt[];
      calls: TraceCall[];
      fromReasoning?: true;
      /**
       * tag:null (the lead's ruling K): the answer read was cut off — its call finished with 'length', or its
       * JSON never closed and closedItems kept what had closed. The lane fails such an answer when it gave
       * nothing to apply (the historian: no summary). Absent otherwise.
       */
      cutOff?: true;
    }
  | { ok: false; code: C; message?: string; attempts: Attempt[]; calls: TraceCall[] };

/** What an interactive structuredCall can return: every code but 'preempted'. */
export type InteractiveResult<T> = StructuredResult<T, Exclude<StructuredFailCode, 'preempted'>>;

/** 'structured' only where json_schema output is confirmed (host, probe or user, §7.2); else 'tagged'. */
export function chooseTransport(caps: ModelCaps): Transport {
  return caps.structuredOutput.mode === 'json_schema' && caps.structuredOutput.confirmedBy !== undefined ? 'structured' : 'tagged';
}

/** The once-per-session key of the notice for a refused structured transport (D-98, D-115). */
export const STRUCTURED_REFUSED_KEY = 'caps.suggest:structured_output';

/** D-98: what the engine's `caps.suggest` notice says when the server refused response_format (`label` = 'conn:model'). */
export function structuredRefusedMessage(label: string, agent: StructuredAgent = 'director'): string {
  const who = agent === 'director' ? "The Director's model" : `The ${agent} agent's model`;
  return `${who} refused structured output: set structured_output = "none" under [caps."${label}"] or run rp-core probe ${label} --active --write.`;
}

/**
 * D-121: the fewest output tokens an agent call is sent with. Below it the corrective pass is not sent
 * (the first attempt's code stands); the Director's first call has the same floor (call.ts).
 */
export const AGENT_OUTPUT_FLOOR = 600;

/** D-98: the codes after which the corrective pass runs (reading failures only). */
const CORRECTABLE: ReadonlySet<StructuredFailCode> = new Set(['no_output', 'undecodable', 'invalid', 'missing_directive']);

/** The abort reason of an agent's budget (D-172, C-12). */
const BUDGET_REASON: Readonly<Record<StructuredAgent, AbortReason>> = {
  director: 'budget:director',
  recall: 'budget:recall',
  filing: 'budget:filing',
  historian: 'budget:historian',
};

/** setTimeout's ceiling (2^31 − 1 ms); a longer budget is that long. */
const MAX_TIMER_MS = 2_147_483_647;

// ---- finding the JSON -----------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An object's text in an answer; `whole`: it closed (a closed fence, or balanced braces). */
export interface FoundObject {
  json: string;
  whole: boolean;
}

/** A ```json (or bare ```) fence and its body; the closer may be missing (an answer cut off). */
const FENCE = /(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)(?:\1|$)/i;
/** The text after a '{' reads as a JSON object: a key (quoted or not), or '}' at once. */
const JSONISH = /^\{\s*(?:["'}]|[A-Za-z_$][\w$-]*["']?\s*:)/;

/**
 * The first JSON object of a text (Bunraku recall-parse firstObject): the body of the first fence
 * when it opens with '{'; else the first '{' that looks like JSON (prose braces such as "{as asked}"
 * are passed over) and closes into an object looseJson can read. A JSON-looking object that cannot
 * be read is the answer unless a readable one follows it. A JSON-looking '{' that never closes ends
 * the search (whole: false): everything after it is inside it, a cut-off answer whose inner objects
 * are fragments. Braces inside strings do not count. Null when no object is there.
 */
export function firstObject(text: string): FoundObject | null {
  const body = FENCE.exec(text)?.[2]?.trim() ?? '';
  if (body.startsWith('{')) {
    const end = balancedEnd(body, 0);
    return end > 0 ? { json: body.slice(0, end), whole: true } : { json: body, whole: false };
  }
  let broken: FoundObject | null = null;
  for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', at + 1)) {
    if (!JSONISH.test(text.slice(at, at + 200))) continue;
    const end = balancedEnd(text, at);
    if (end < 0) return broken ?? { json: text.slice(at), whole: false };
    const json = text.slice(at, end);
    const v = looseJson(json);
    if (v.ok && isRecord(v.value)) return { json, whole: true };
    broken ??= { json, whole: true };
    at = end - 1;
  }
  return broken;
}

/** What a search of one text found. */
export type Found =
  | { kind: 'none' }
  /** A block of the plan family that cannot be read (cut off, or not JSON). */
  | { kind: 'broken'; why: string }
  | {
      kind: 'json';
      json: string;
      whole: boolean;
      /** Found in a plan block (else a fenced or bare object). */
      block: boolean;
      /** Later blocks of the plan family, ignored. */
      extra: number;
      /**
       * D-123: only empty plan blocks were there (`<plan></plan>`, `<plan/>`, a plan call without
       * arguments); json is '{}', so read() says what is missing. Readers search the reasoning on.
       */
      empty?: true;
    };

/** D-99: the scanner's tools for a plan answer (name tags `<plan>`, `<commit_planning_round>`, and `<tool_call>` names). */
export const PLAN_TAGS: readonly OfferedTool[] = [
  { name: 'plan', schema: {} },
  { name: 'commit_planning_round', schema: {} },
];
const PLAN_NAMES: ReadonlySet<string> = new Set(PLAN_TAGS.map((t) => t.name));

/**
 * D-99 + D-117: the plan in an answer. The first good block of the plan family: a `<plan>`, a
 * `<tool_call>` named plan or commit_planning_round (any spelling the M3 scanner reads) without an
 * error, or a NAMELESS `<tool_call>` whose body is an object with `directive`. Blocks with errors
 * before it (a `<plan>` mention in prose) are ignored, later plan blocks counted as extra. D-123: an
 * empty block (`<plan></plan>`, `<plan/>`) or a plan call without arguments is not a good block either
 * (the search goes on) and never an extra one. Blocks naming other tools are not the plan's. No good
 * block: a whole fenced or bare object with `directive` (after a plan envelope is unwrapped) is still
 * taken, else a broken block → broken, else (only empty blocks) an empty plan (`empty`). No block at
 * all → a fenced or bare object, accepted only when its root has the key `directive` (RoleCall's text
 * path), or any object when `anyObject` (the structured transport, whose answer IS the object).
 */
export function findPlan(text: string, opts: { anyObject?: boolean } = {}): Found {
  const family = parsePromptedCalls(text, PLAN_TAGS).filter((b) => (b.name === null ? b.error !== undefined : PLAN_NAMES.has(b.name.toLowerCase())));
  const empty = family.map((b) => b.name !== null && b.error === undefined && emptyPlanArgs(b.args));
  const plans = family.map((b, i): string | null => {
    if (b.name !== null) return b.error === undefined && !empty[i] ? b.args : null;
    // A nameless <tool_call>: the scanner gives no body (no name, an error); its object is read here.
    const obj = firstObject(text.slice(b.start, b.end));
    return obj !== null && obj.whole && hasDirective(obj.json, true) ? obj.json : null;
  });
  const at = plans.findIndex((p) => p !== null);
  if (at >= 0) {
    const extra = family.slice(at + 1).filter((b, i) => !empty[at + 1 + i] && (b.name !== null || plans[at + 1 + i] !== null)).length;
    return { kind: 'json', json: plans[at]!, whole: true, block: true, extra };
  }
  const obj = firstObject(text);
  if (family.length > 0) {
    // Every block failed or was empty (a `<plan>` mention in prose, a broken tag, `<plan></plan>`): a
    // whole object with a directive still is the plan; after an empty block that holds `{}`, the first
    // object after the last empty block is looked at too.
    const lastEmpty = family.reduce((end, b, i) => (empty[i] ? Math.max(end, b.end) : end), -1);
    for (const o of [obj, ...(lastEmpty > 0 ? [firstObject(text.slice(lastEmpty))] : [])]) {
      if (o !== null && o.whole && hasDirective(o.json, true)) return { kind: 'json', json: o.json, whole: true, block: false, extra: 0 };
    }
    const failed = family.filter((_, i) => !empty[i]);
    if (failed.length === 0) return { kind: 'json', json: '{}', whole: true, block: true, extra: 0, empty: true };
    const cut = failed.some((b) => /cut off/.test(b.error ?? ''));
    return { kind: 'broken', why: cut ? 'the plan block was cut off' : 'the plan block could not be read' };
  }
  if (obj === null) return { kind: 'none' };
  if (opts.anyObject === true || hasDirective(obj.json, false)) return { kind: 'json', json: obj.json, whole: obj.whole, block: false, extra: 0 };
  return { kind: 'none' };
}

/**
 * The object's root, a plan envelope unwrapped, has the key `directive`. `decoded`: only when it
 * decodes; else an object that cannot be decoded counts when written so at its start (the reading
 * then says undecodable).
 */
function hasDirective(json: string, decoded: boolean): boolean {
  const v = looseJson(json);
  if (v.ok) {
    const root = unwrapEnvelope(v.value);
    return isRecord(root) && Object.hasOwn(root, 'directive');
  }
  return !decoded && /^\{\s*["']?directive["']?\s*:/.test(json);
}

/**
 * D-123: a plan block's arguments that hold no plan: an empty body, `{}`, or a plan envelope whose
 * arguments are missing, null, empty or `{}`. Arguments that cannot be decoded are not empty (the
 * block stays the plan and reads as undecodable).
 */
function emptyPlanArgs(args: string): boolean {
  if (args.trim() === '') return true;
  const v = looseJson(args);
  if (!v.ok) return false;
  const root = unwrapEnvelope(v.value);
  if (root === null || root === undefined || (typeof root === 'string' && root.trim() === '')) return true;
  if (!isRecord(root)) return false;
  const keys = Object.keys(root);
  if (keys.length === 0) return true;
  // `{"name": "plan"}`: an envelope without its arguments.
  return keys.length === 1 && typeof root['name'] === 'string' && PLAN_NAMES.has(root['name'].toLowerCase());
}

/** M5b (the lead's ruling G): the text after a '[' reads as a JSON list of objects, or an empty list. */
const LISTISH = /^\[\s*[{\]]/;

/**
 * tag:null (M5b, the lead's ruling G: filing and the historian accept an array root, their readers
 * decide): a fence whose body opens with a list is that list; else a JSON-looking list of objects that
 * starts before every JSON-looking object and decodes to a list (a list that never closes is a cut-off
 * answer: whole false); else firstObject.
 */
export function firstJson(text: string): FoundObject | null {
  const body = FENCE.exec(text)?.[2]?.trim() ?? '';
  if (LISTISH.test(body)) {
    const end = balancedEnd(body, 0);
    return end > 0 ? { json: body.slice(0, end), whole: true } : { json: body, whole: false };
  }
  if (body.startsWith('{')) return firstObject(text);
  let list = -1;
  for (let at = text.indexOf('['); at >= 0; at = text.indexOf('[', at + 1)) {
    if (LISTISH.test(text.slice(at, at + 200))) {
      list = at;
      break;
    }
  }
  if (list < 0) return firstObject(text);
  for (let at = text.indexOf('{'); at >= 0 && at < list; at = text.indexOf('{', at + 1)) {
    if (JSONISH.test(text.slice(at, at + 200))) return firstObject(text);
  }
  const end = balancedEnd(text, list);
  if (end < 0) return { json: text.slice(list), whole: false };
  const json = text.slice(list, end);
  const v = looseJson(json);
  return v.ok && Array.isArray(v.value) ? { json, whole: true } : firstObject(text);
}

/** What is left of a cut-off tag:null answer (closedItems). */
export interface ClosedItems {
  /** The text cut back to its last closed item, the open brackets closed again. */
  json: string;
  /** Items that closed. */
  items: number;
  /** Something unfinished (an item, a member) came after the cut and was left out. */
  dropped: boolean;
}

/** Root keys of a list envelope (filing's and the historian's readers): with one, the root holds items. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['filing', 'filings', 'entries', 'items', 'summaries', 'recaps', 'plots', 'storylines', 'arc', 'arcs', 'overviews', 'plotoverviews']);
/** Root keys of one item (its type, its identity, its entry): without an envelope key the root is the item. */
const ITEM_KEYS: ReadonlySet<string> = new Set(['type', 'entrytype', 'entry', 'data', 'name', 'title', 'topic', 'summary', 'parentplot']);
/** A key as both sets hold it: lower case, no '_', '-' or blanks (`entry_type`, `entryType`, `Parent plot`). */
const bareKey = (k: string): string => k.toLowerCase().replace(/[\s_-]+/g, '');

/** The member keys of a root object (every one in the text, cut or not); [] for a list root. */
function rootKeys(json: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let root = '';
  let inString = false;
  let start = -1;
  let last: string | null = null;
  for (let k = 0; k < json.length; k++) {
    const c = json[k];
    if (inString) {
      if (c === '\\') k++;
      else if (c === '"') {
        inString = false;
        if (depth === 1 && root === '{') last = json.slice(start + 1, k);
      }
    } else if (c === '"') {
      inString = true;
      start = k;
    } else if (c === '{' || c === '[') {
      if (depth === 0) root = c;
      depth++;
    } else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 1 && root === '{' && last !== null) keys.push(last);
    else if (c === ',') last = null;
  }
  return keys;
}

/**
 * Ruling K: a root object is one item — its lists are its fields (`relationships`), not item lists —
 * when it has a type, identity or entry key and no envelope key (a type-keyed `{"character": [...]}` has
 * neither: it holds items).
 */
function rootIsItem(json: string): boolean {
  const keys = rootKeys(json).map(bareKey);
  return keys.some((k) => ITEM_KEYS.has(k)) && !keys.some((k) => ENVELOPE_KEYS.has(k));
}

/**
 * M5b (the lead's ruling I): a tag:null answer whose JSON never closed (filing, historian). Its items are
 * the elements of the root list, or of the lists the root object holds as member values (`filings`,
 * `arcs`); the text is cut back to the end of the last item or member that closed, or to the opening
 * of a list that holds nothing yet, and its open brackets are closed again: complete items are kept,
 * the unfinished last one is left out. Null when no item closed (a root object with no list is one
 * item, and it did not close; so is a root object that is itself an item, ruling K): the attempt fails,
 * never an empty cover. Braces inside strings do not count (balancedEnd's rule).
 */
export function closedItems(json: string): ClosedItems | null {
  const stack: string[] = [];
  let inString = false;
  let items = 0;
  let cut = -1;
  let closers = '';
  const lists = !rootIsItem(json);
  const holder = (): boolean => (stack.length === 1 && stack[0] === '[') || (lists && stack.length === 2 && stack[0] === '{' && stack[1] === '[');
  const mark = (at: number): void => {
    cut = at;
    closers = stack.map((c) => (c === '{' ? '}' : ']')).reverse().join('');
  };
  for (let k = 0; k < json.length; k++) {
    const c = json[k];
    if (inString) {
      if (c === '\\') k++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      stack.push(c);
      if (c === '[' && holder()) mark(k + 1);
    } else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) break;
      if (holder()) {
        items++;
        mark(k + 1);
      } else if (stack.length === 1 && stack[0] === '{') mark(k + 1);
    }
  }
  if (items === 0 || cut < 0) return null;
  return { json: json.slice(0, cut) + closers, items, dropped: json.slice(cut).replace(/[\s,\]}]/g, '') !== '' };
}

/** tag:null: a fence, else the first object or list of objects (firstJson). */
function findObject(text: string): Found {
  const obj = firstJson(text);
  return obj === null ? { kind: 'none' } : { kind: 'json', json: obj.json, whole: obj.whole, block: false, extra: 0 };
}

/** `{"name": plan | commit_planning_round, "arguments"|"args": X}` → X (one level; a string X decoded). */
function unwrapEnvelope(v: unknown): unknown {
  if (!isRecord(v) || typeof v['name'] !== 'string' || !PLAN_NAMES.has(v['name'].toLowerCase())) return v;
  const key = (['arguments', 'args'] as const).find((k) => Object.hasOwn(v, k));
  if (key === undefined || !Object.keys(v).every((k) => k === 'name' || k === key)) return v;
  const inner = v[key];
  if (typeof inner !== 'string') return inner;
  const parsed = looseJson(inner);
  return parsed.ok ? parsed.value : inner;
}

// ---- reading one call's answer (D-98 reading order) ------------------------------------------------

type Read<T> =
  | { ok: true; value: T; skipped: Skip[]; fromReasoning: boolean; cutOff?: true }
  | { ok: false; code: 'no_output' | 'undecodable' | 'invalid' | 'missing_directive'; message: string };

/** The visible text without inline think tags; what they held joins the reasoning. */
function splitThink(text: string, reasoning: string, caps: ModelCaps): { text: string; reasoning: string } {
  const splitter = createReasoningSplitter(tagPairs(caps.reasoning.tags ?? DEFAULT_REASONING_TAGS));
  let shown = '';
  let thought = reasoning;
  for (const p of [...splitter.push(text), ...splitter.end()]) {
    if (p.kind === 'text') shown += p.d;
    else thought += p.d;
  }
  return { text: shown, reasoning: thought };
}

/** The answer's text and reasoning as reading sees them (think tags out; answerInReasoning, turn.ts rule). */
function answerOf(res: Pick<CallResult, 'text' | 'reasoning'>, caps: ModelCaps): { text: string; reasoning: string } {
  const split = splitThink(res.text, res.reasoning, caps);
  if (split.text.trim() === '' && split.reasoning.trim() !== '' && caps.reasoning.answerInReasoning === true) {
    return { text: split.reasoning, reasoning: '' };
  }
  return split;
}

/**
 * One answer read (D-98): find the JSON in the visible text (tag 'plan': D-99; null: a fence or the
 * first object), else in the reasoning; decode it with looseJson (root must be an object; tag
 * 'plan': an object cut off by finish 'length' is undecodable; tag null: an answer cut off at any
 * finish keeps the items that closed — closedItems, a `cut_off` skip when one was left out — and is
 * undecodable when none did); then read(). Tag null: `cutOff` when the JSON was closed here or the finish
 * was 'length' (ruling K).
 */
export function readAnswer<T>(
  answer: { text: string; reasoning: string },
  opts: { tag: 'plan' | null; transport: Transport; finish?: string; read: (raw: unknown) => ReadResult<T> },
): Read<T> {
  const search = (t: string): Found => (opts.tag === 'plan' ? findPlan(t, { anyObject: opts.transport === 'structured' }) : findObject(t));
  let found = search(answer.text);
  let fromReasoning = false;
  // D-123: only an empty plan block in the text is nothing found either; the reasoning replaces it
  // only with a real plan (else the empty block stands and read() says what is missing).
  const emptyPlan = found.kind === 'json' && found.empty === true;
  if ((found.kind === 'none' || emptyPlan) && answer.reasoning.trim() !== '') {
    const there = search(answer.reasoning);
    if (emptyPlan ? there.kind === 'json' && there.empty !== true : there.kind !== 'none') {
      found = there;
      fromReasoning = true;
    }
  }
  if (found.kind === 'none') return { ok: false, code: 'no_output', message: noOutputReason(opts.tag, opts.transport) };
  if (found.kind === 'broken') return { ok: false, code: 'undecodable', message: found.why };
  let json = found.json;
  const cutOff: Skip[] = [];
  const closedHere = !found.whole && opts.tag === null;
  if (closedHere) {
    // The lead's ruling I: whatever the finish, the items that closed are read; none closed fails.
    const kept = closedItems(found.json);
    if (kept === null) return { ok: false, code: 'undecodable', message: 'the answer was cut off before its first item closed' };
    json = kept.json;
    if (kept.dropped) cutOff.push({ path: 'answer', why: 'cut_off: the answer was cut off; its unfinished last item was left out' });
  } else if (!found.whole && opts.finish === 'length') return { ok: false, code: 'undecodable', message: 'the answer was cut off before the JSON closed' };
  const decoded = looseJson(json);
  if (!decoded.ok) return { ok: false, code: 'undecodable', message: 'the JSON could not be read' };
  // D-117: a plan envelope is unwrapped on both transports, from a block or a bare object alike.
  const value = opts.tag === 'plan' ? unwrapEnvelope(decoded.value) : decoded.value;
  // The lead's ruling G (M5b): a tag:null agent's reader takes a list root too.
  if (!isRecord(value) && !(opts.tag === null && Array.isArray(value))) return { ok: false, code: 'undecodable', message: 'the answer is not a JSON object' };
  const got = opts.read(value);
  if (!got.ok) return { ok: false, code: got.code, message: got.message };
  const extra: Skip[] = Array.from({ length: found.extra }, () => ({ path: 'plan', why: 'extra block' }));
  const cut = closedHere || (opts.tag === null && opts.finish === 'length');
  return { ok: true, value: got.value, skipped: [...extra, ...cutOff, ...got.skipped], fromReasoning, ...(cut ? { cutOff: true as const } : {}) };
}

// ---- the corrective pass (D-99) -------------------------------------------------------------------

function noOutputReason(tag: 'plan' | null, transport: Transport): string {
  return tag === 'plan' && transport === 'tagged' ? 'no plan block was found' : 'no JSON object was found';
}

/** The short fixed phrase a correction gives for a failure (read()'s own message for 'invalid'). */
export function correctionReason(code: 'no_output' | 'undecodable' | 'invalid' | 'missing_directive', message: string, tag: 'plan' | null, transport: Transport): string {
  if (code === 'no_output') return noOutputReason(tag, transport);
  if (code === 'undecodable') return 'the JSON could not be read';
  if (code === 'missing_directive') return 'the directive was empty';
  const own = cutChars(message.trim(), 200);
  return own === '' ? 'the answer did not follow the schema' : own;
}

/** The corrective user message (D-99 for the Director; tag:null agents get the same without the plan words). */
export function correctionText(reason: string, tag: 'plan' | null, transport: Transport): string {
  if (tag === 'plan') {
    return transport === 'tagged'
      ? `Your answer had no usable plan (${reason}). Answer again with exactly one <plan>…</plan> block that holds one JSON object following the schema above, with a directive that sets at least one field. Write nothing else.`
      : `Your answer was not a usable plan (${reason}). Answer again with one JSON object following the schema, with a directive that sets at least one field.`;
  }
  return transport === 'tagged'
    ? `Your answer was not usable (${reason}). Answer again with exactly one JSON object following the schema above. Write nothing else.`
    : `Your answer was not usable (${reason}). Answer again with one JSON object following the schema.`;
}

/** At most `n` UTF-16 units, never splitting a surrogate pair. */
function cutChars(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** The bad answer the corrective pass shows back: the visible text, else the reasoning, cut; "(no text)". */
export function correctionEcho(answer: { text: string; reasoning: string }): string {
  const said = answer.text.trim() !== '' ? answer.text : answer.reasoning;
  return said.trim() === '' ? '(no text)' : cutChars(said, DIRECTOR_CALL.correctionEchoChars);
}

/**
 * D-121: the corrective pass's maxTokens. Its prompt is the first one plus the echo and the correction
 * (two messages), so its output budget shrinks by as much and prompt + max_tokens stays where the
 * caller put it. Null: below AGENT_OUTPUT_FLOOR, the pass is not sent. Without a counter: unchanged.
 */
export function correctionMaxTokens(maxTokens: number, echo: string, correction: string, count?: (text: string) => number): number | null {
  if (count === undefined) return maxTokens;
  const left = Math.floor(maxTokens - (count(echo) + count(correction) + 2 * MESSAGE_OVERHEAD_TOKENS));
  return left >= AGENT_OUTPUT_FLOOR ? left : null;
}

// ---- the call ------------------------------------------------------------------------------------

const textMsg = (role: PromptMsg['role'], text: string, src: string): PromptMsg => ({ role, blocks: [{ k: 'text', text }], src });

/** System, then the user messages (blank ones dropped; one joined message under strict alternation). */
function baseMessages(input: Pick<StructuredInput<unknown>, 'agent' | 'system' | 'user' | 'route'>): PromptMsg[] {
  const users = input.user.filter((u) => u.trim() !== '');
  const joined = input.route.caps.alternation === 'strict' && users.length > 1 ? [users.join('\n\n')] : users;
  return [
    ...(input.system.trim() !== '' ? [textMsg('system', input.system, `${input.agent}:system`)] : []),
    ...joined.map((u) => textMsg('user', u, `${input.agent}:user`)),
  ];
}

/** What one call came to. */
type Called<T> =
  | Read<T> & { ok: true }
  | {
      ok: false;
      code: StructuredFailCode | 'retried';
      message?: string;
      /** The answer as reading saw it (for the corrective echo). */
      answer?: { text: string; reasoning: string };
      error?: ProviderError;
    };

/**
 * structuredCall (D-98): one JSON object from the agent's model. Never throws for provider trouble;
 * the result says what happened, with every call's attempt and trace row. M5b (D-172): a call left at
 * the interactive priority is never preempted, so its result type has no 'preempted'; a background
 * call's result may have it (the lane re-queues the task without counting an attempt).
 */
export function structuredCall<T>(input: StructuredInput<T> & { priority?: 'interactive' }): Promise<InteractiveResult<T>>;
export function structuredCall<T>(input: StructuredInput<T>): Promise<StructuredResult<T>>;
export async function structuredCall<T>(input: StructuredInput<T>): Promise<StructuredResult<T>> {
  const { env, route, transport } = input;
  const label = modelLabel(route.conn.id, route.model);
  const ctrl = childController(input.turnSignal);
  const attempts: Attempt[] = [];
  const calls: TraceCall[] = [];
  let n = 0;

  // D-101: the budget starts once the first call holds its slot; the retry and the corrective pass share it.
  // M5b (the lead's ruling I): a background call's budget runs only while one of its calls holds a slot,
  // so a §6.6 retry or a corrective pass queued behind a turn (or the backoff before it) is not timed.
  const pausable = input.priority === 'background';
  let budget: unknown = null;
  let armed = false;
  let left = Math.min(MAX_TIMER_MS, Math.max(0, input.budgetMs));
  let since = 0;
  const onSlot = (): void => {
    if (budget !== null || (armed && !pausable)) return;
    armed = true;
    if (!Number.isFinite(input.budgetMs)) return;
    since = env.clock().getTime();
    budget = env.timers.setTimeout(() => abortWith(ctrl, BUDGET_REASON[input.agent]), left);
  };
  /** A background call gave its slot back: the budget stops with what is left of it. */
  const pause = (): void => {
    if (!pausable || budget === null) return;
    env.timers.clearTimeout(budget);
    budget = null;
    left = Math.max(0, left - Math.max(0, env.clock().getTime() - since));
  };
  /** An abort of the agent's signal: its budget ran out, or the turn was stopped. */
  const stopCode = (): 'timeout' | 'aborted' => (reasonOf(ctrl.signal)?.startsWith('budget:') ? 'timeout' : 'aborted');

  const call = async (messages: PromptMsg[], maxTokens: number, retryable: boolean): Promise<Called<T>> => {
    const callKey = `${input.callKeyPrefix}:${n++}`;
    const res = await streamCall({
      conn: route.conn,
      model: route.model,
      caps: route.caps,
      messages,
      maxTokens,
      samplers: input.samplers,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      callKey,
      turnSignal: ctrl.signal,
      sched: env.sched,
      fetch: env.fetch,
      timeouts: env.timeouts,
      timers: env.timers,
      clock: env.clock,
      agent: input.agent,
      ...(transport === 'structured' ? { responseSchema: input.schema } : {}),
      ...(env.keepRequest ? { keepRequest: env.keepRequest } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.idleDelaySec !== undefined ? { idleDelaySec: input.idleDelaySec } : {}),
      onSlot,
      onText: () => undefined,
      onReasoning: () => undefined,
    });
    pause();
    record(callKey, res);
    const got = outcomeOf(res, retryable);
    attempts.push({
      transport,
      outcome: got.ok ? (got.fromReasoning ? 'ok_reasoning' : 'ok') : got.code,
      ms: res.ms,
      ...(res.error?.status !== undefined ? { status: res.error.status } : {}),
      ...(res.finish ? { finish: res.finish.reason } : {}),
      ...(res.usage?.outputTotal !== undefined ? { tokens: res.usage.outputTotal } : {}),
    });
    return got;
  };

  /** The trace row, the usage event (with the agent) and the debug tap of one call. */
  const record = (callKey: string, res: CallResult): void => {
    calls.push({ callKey, agent: input.agent, model: label, ms: res.ms, ...(res.usage ? { usage: res.usage } : {}) });
    if (res.usage) {
      const cost = usageCost(res.usage, priceFor(env.prices, route.conn.id, route.model));
      env.emit({ type: 'usage', callKey, agent: input.agent, model: label, usage: res.usage, costUsd: cost.costUsd, priceSource: cost.priceSource });
    }
    if (!env.onProviderError) return;
    for (const error of [res.error, res.tailError]) {
      if (!error) continue;
      try {
        env.onProviderError({ callKey, model: label, error });
      } catch {
        /* a debug sink must never break a call */
      }
    }
  };

  const outcomeOf = (res: CallResult, retryable: boolean): Called<T> => {
    // D-172: a preemption is the call's own end; a Stop or the budget of the whole agent outranks it.
    if (res.preempted === true && !ctrl.signal.aborted) return { ok: false, code: 'preempted' };
    if (res.stopped || (res.error && ctrl.signal.aborted)) return { ok: false, code: stopCode() };
    const e = res.error;
    if (e) {
      // streamCall's own first-byte / idle deadline: "did not answer in time" (D-98).
      if (e.code === 'timeout' && e.status === undefined) return { ok: false, code: 'timeout', message: e.message, error: e };
      if (retryable && !res.output && isRetryable(e)) return { ok: false, code: 'retried', message: e.message, error: e };
      // D-98, D-122: the server refused response_format — a structured 400 bad_request BEFORE any output
      // (a 400 inside a stream that already answered is not a refusal). No silent switch to tagged.
      if (transport === 'structured' && e.status === 400 && e.code === 'bad_request' && !res.output && !e.afterOutput) {
        return { ok: false, code: 'transport_unsupported', message: e.message, error: e };
      }
      return { ok: false, code: 'provider_error', message: e.message, error: e };
    }
    const answer = answerOf(res, route.caps);
    const read = readAnswer(answer, { tag: input.tag, transport, ...(res.finish ? { finish: res.finish.reason } : {}), read: (raw) => input.read(raw) });
    return read.ok ? read : { ...read, answer };
  };

  /** A call and, before any output, one §6.6 retry of it (event `retry` with the failed call's key). */
  const pass = async (messages: PromptMsg[], maxTokens: number): Promise<Called<T>> => {
    const first = await call(messages, maxTokens, true);
    if (first.ok || first.code !== 'retried' || first.error === undefined) return first;
    const err = first.error;
    const delayMs = retryDelayMs(err, env.retryMaxDelayMs, env.random);
    env.emit({ type: 'retry', callKey: `${input.callKeyPrefix}:${n - 1}`, attempt: 1, delayMs, code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) });
    try {
      await abortableDelay(delayMs, ctrl.signal, env.timers);
    } catch {
      return { ok: false, code: stopCode() };
    }
    return call(messages, maxTokens, false);
  };

  const fail = (code: StructuredFailCode, message?: string): StructuredResult<T> => ({
    ok: false,
    code,
    ...(message !== undefined && message !== '' ? { message } : {}),
    attempts,
    calls,
  });
  const succeed = (got: Read<T> & { ok: true }): StructuredResult<T> => ({
    ok: true,
    value: got.value,
    transport,
    skipped: got.skipped,
    attempts,
    calls,
    ...(got.fromReasoning ? { fromReasoning: true as const } : {}),
    ...(got.cutOff ? { cutOff: true as const } : {}),
  });
  /** A failure of a pass (never 'retried': a retried call is always followed by its retry). */
  const failed = (got: Exclude<Called<T>, { ok: true }>): StructuredResult<T> => fail(got.code === 'retried' ? 'provider_error' : got.code, got.message);

  try {
    if (ctrl.signal.aborted) return fail(stopCode());
    const base = baseMessages(input);
    const first = await pass(base, input.maxTokens);
    if (first.ok) return succeed(first);
    if (!input.repair || first.code === 'retried' || !CORRECTABLE.has(first.code)) return failed(first);
    // The budget may have run out between the answer and the correction: no call is sent then.
    if (ctrl.signal.aborted) return fail(stopCode());
    const code = first.code as 'no_output' | 'undecodable' | 'invalid' | 'missing_directive';
    const answer = first.answer ?? { text: '', reasoning: '' };
    const reason = correctionReason(code, first.message ?? '', input.tag, transport);
    const echo = correctionEcho(answer);
    const correction = correctionText(reason, input.tag, transport);
    const maxTokens = correctionMaxTokens(input.maxTokens, echo, correction, input.count);
    // D-121: no room left for an answer after the echo and the correction: the first attempt's code stands.
    if (maxTokens === null) return failed(first);
    const messages = [...base, textMsg('assistant', echo, `${input.agent}:answer`), textMsg('user', correction, `${input.agent}:correction`)];
    const second = await pass(messages, maxTokens);
    return second.ok ? succeed(second) : failed(second);
  } finally {
    if (budget !== null) env.timers.clearTimeout(budget);
  }
}
