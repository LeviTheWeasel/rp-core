// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The scripted provider (ARCHITECTURE.md §14, D-40; Kintsu K4 `--provider script:<file>`).
// A script file is JSONL: each non-empty line is ONE model call, either a JSON array of steps or
// {"steps": [...], "requestHash"?: "<hex>"}. Calls are consumed in order; when they run out the
// call fails with ProviderError code 'script_exhausted'.
// CONTRACT FILE: signatures are fixed; the infra agent implements the bodies.
//
// Fresh code; the shape follows Bunraku's test `scripted()` (records requests, a gate holds the
// stream mid-way), generalised into JSONL steps so the CLI can load it from a file.
//
// M3 (tool rounds): a tool step may carry `argsText` (sent verbatim as the tool_args delta, for
// broken JSON) instead of `args`; a {replay} step yields a StreamEv 'replay'; a script FILE may start
// with a `{"caps": {...}}` line (parseScriptFile), a partial caps record the caller merges over
// SCRIPT_CAPS (scriptCapsWith), so a `script:` connection can offer tools. SCRIPT_CAPS keeps tools
// 'none'. hashRequest is unchanged: toolChoice and stop are not part of the hash.
//
// M5c (.notes/m5c-decisions.md D-207): a call line {"steps": [...], "agent": "<agent>"} is that agent's:
// a request takes the first unconsumed line tagged with its `agent`, else the first unconsumed untagged
// line, so a Director and a recall running at once each get their own answers whatever order they ask
// in; untagged lines keep today's order (a script without tags plays exactly as before). The file's
// first line may also say `"local": true` (or false), the scheduler's locality of the script's origin;
// createScriptedProvider takes it as `localOrigin` (sched.ts connectionLocality). The lead's ruling K: a
// provider says whether any line is tagged for recall (`recallTagged`); a script with none was not written
// for recall, and an engine it overrides makes recall's default lexical (engine.ts scriptRecallDefault).
// A hash mismatch names the script call that holds the hash, not the request's arrival number.

import { createHash } from 'node:crypto';
import { abortableDelay } from '../engine/abort.ts';
import { checkCapsRows, mergeCaps } from './caps.ts';
import { PROVIDER_ERROR_CATEGORY, PROVIDER_ERROR_MESSAGE, ProviderError } from './types.ts';
import type { ProviderErrorCategory, ProviderEnv, Replay, StreamEv } from './types.ts';
import type { CallAgent, FinishReason, ModelCaps, ModelRequest, Provider, ProviderErrorCode, Usage } from './types.ts';

export type ScriptStep =
  | { text: string }
  | { reasoning: string }
  /**
   * One native tool call: tool_start, one tool_args delta, tool_end. The delta is JSON.stringify(args)
   * (args default {}), or `argsText` verbatim (M3: broken JSON for the argument chain); never both.
   */
  | { tool: { name: string; args?: unknown; argsText?: string; id?: string } }
  /** M3: a StreamEv 'replay'; connection and model default to the request's. */
  | { replay: { kind: Replay['kind']; payload: unknown; connection?: string; model?: string } }
  /** Wait ms (abortable). */
  | { delay: number }
  /** Block until release(name) is called (tests) [D-40]. Abortable. */
  | { pause: string }
  | {
      error: {
        code: ProviderErrorCode;
        status?: number;
        afterOutput?: boolean;
        retryAfterSec?: number;
        message?: string;
      };
    }
  | { usage: Usage }
  /** End the stream abruptly with no finish (the engine sees truncated_stream). */
  | { cut: true }
  /** Override the finish reason (default 'end'). */
  | { finish: FinishReason };

export interface ScriptCall {
  steps: ScriptStep[];
  /** If set, the request hash (hashRequest) must match, else the call fails loudly with a diff hint. */
  requestHash?: string;
  /** M5c (D-207): only a request of this agent takes the call (ModelRequest.agent); untagged: any, in order. */
  agent?: CallAgent;
}

// ---- error categories ---------------------------------------------------------------------------

/** [D-51] category of every code: the shared table lives in providers/types.ts. */
const CATEGORY = PROVIDER_ERROR_CATEGORY;

/** The category a scripted error code is reported under. */
export function categoryOf(code: ProviderErrorCode): ProviderErrorCategory {
  return CATEGORY[code];
}

const FINISH_REASONS: Readonly<Record<FinishReason, true>> = {
  end: true,
  length: true,
  stopped: true,
  interrupted: true,
  content_filter: true,
  refusal: true,
  max_rounds: true,
};

const REPLAY_KINDS: Readonly<Record<Replay['kind'], true>> = {
  'anthropic-blocks': true,
  'gemini-parts': true,
  reasoning_details: true,
  tool_extra: true,
};

const AGENTS: Readonly<Record<CallAgent, true>> = {
  narrator: true,
  director: true,
  recall: true,
  filing: true,
  historian: true,
};

const USAGE_FIELDS: Readonly<Record<keyof Usage, true>> = {
  inputTotal: true,
  inputCacheRead: true,
  inputCacheWrite: true,
  inputCacheWrite1h: true,
  outputTotal: true,
  outputReasoning: true,
  cost: true,
};

// ---- parsing ------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function has<K extends string>(table: Readonly<Record<K, unknown>>, key: string): key is K {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/** Rejects keys a shape does not know, so a typo ("afterOuput") fails instead of being ignored. */
function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], fail: (msg: string) => never): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`unknown field "${k}" (allowed: ${allowed.join(', ')})`);
  }
}

function isNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function parseError(v: unknown, fail: (msg: string) => never): ScriptStep {
  if (!isRecord(v)) fail('"error" must be an object {code, status?, afterOutput?, retryAfterSec?, message?}');
  onlyKeys(v, ['code', 'status', 'afterOutput', 'retryAfterSec', 'message'], fail);
  const { code, status, afterOutput, retryAfterSec, message } = v;
  if (typeof code !== 'string' || !has(CATEGORY, code)) fail(`unknown error code ${JSON.stringify(code)}`);
  const out: Extract<ScriptStep, { error: unknown }>['error'] = { code };
  if (status !== undefined) {
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
      fail(`error.status must be an HTTP status, got ${JSON.stringify(status)}`);
    }
    out.status = status as number;
  }
  if (afterOutput !== undefined) {
    if (typeof afterOutput !== 'boolean') fail('error.afterOutput must be a boolean');
    out.afterOutput = afterOutput;
  }
  if (retryAfterSec !== undefined) {
    if (!isNonNegative(retryAfterSec)) fail('error.retryAfterSec must be a number >= 0');
    out.retryAfterSec = retryAfterSec;
  }
  if (message !== undefined) {
    if (typeof message !== 'string') fail('error.message must be a string');
    out.message = message;
  }
  return { error: out };
}

function parseStep(v: unknown, fail: (msg: string) => never): ScriptStep {
  if (!isRecord(v)) fail('a step must be an object such as {"text": "..."}');
  const keys = Object.keys(v);
  const kind = keys[0];
  if (keys.length !== 1 || kind === undefined) {
    fail(`a step must have exactly one key, got ${keys.length === 0 ? 'none' : keys.join(', ')}`);
  }
  const arg = v[kind];
  switch (kind) {
    case 'text':
    case 'reasoning':
      if (typeof arg !== 'string') fail(`"${kind}" must be a string`);
      return kind === 'text' ? { text: arg } : { reasoning: arg };
    case 'tool': {
      if (!isRecord(arg)) fail('"tool" must be an object {name, args? | argsText?, id?}');
      onlyKeys(arg, ['name', 'args', 'argsText', 'id'], fail);
      if (typeof arg.name !== 'string' || arg.name === '') fail('tool.name must be a non-empty string');
      if (arg.id !== undefined && (typeof arg.id !== 'string' || arg.id === '')) fail('tool.id must be a non-empty string');
      const id = typeof arg.id === 'string' ? { id: arg.id } : {};
      if (arg.argsText !== undefined) {
        if (typeof arg.argsText !== 'string') fail('tool.argsText must be a string (sent as is)');
        if (arg.args !== undefined) fail('give tool.args or tool.argsText, not both');
        return { tool: { name: arg.name, argsText: arg.argsText, ...id } };
      }
      // A missing args object means "called with no arguments", which models send as {}.
      return { tool: { name: arg.name, args: arg.args === undefined ? {} : arg.args, ...id } };
    }
    case 'replay': {
      if (!isRecord(arg)) fail('"replay" must be an object {kind, payload, connection?, model?}');
      onlyKeys(arg, ['kind', 'payload', 'connection', 'model'], fail);
      if (typeof arg.kind !== 'string' || !has(REPLAY_KINDS, arg.kind)) fail(`unknown replay kind ${JSON.stringify(arg.kind)}`);
      if (!('payload' in arg)) fail('replay.payload is required');
      for (const k of ['connection', 'model'] as const) {
        if (arg[k] !== undefined && typeof arg[k] !== 'string') fail(`replay.${k} must be a string`);
      }
      return {
        replay: {
          kind: arg.kind,
          payload: arg.payload,
          ...(typeof arg.connection === 'string' ? { connection: arg.connection } : {}),
          ...(typeof arg.model === 'string' ? { model: arg.model } : {}),
        },
      };
    }
    case 'delay':
      if (!isNonNegative(arg)) fail('"delay" must be a number of ms >= 0');
      return { delay: arg };
    case 'pause':
      if (typeof arg !== 'string' || arg === '') fail('"pause" must be a non-empty name');
      return { pause: arg };
    case 'error':
      return parseError(arg, fail);
    case 'usage': {
      if (!isRecord(arg)) fail('"usage" must be an object');
      const u: Usage = {};
      for (const [k, n] of Object.entries(arg)) {
        if (!has(USAGE_FIELDS, k)) fail(`unknown usage field "${k}"`);
        if (!isNonNegative(n)) fail(`usage.${k} must be a number >= 0`);
        u[k] = n;
      }
      return { usage: u };
    }
    case 'cut':
      if (arg !== true) fail('"cut" must be true');
      return { cut: true };
    case 'finish':
      if (typeof arg !== 'string' || !has(FINISH_REASONS, arg)) fail(`unknown finish reason ${JSON.stringify(arg)}`);
      return { finish: arg };
    default:
      return fail(`unknown step "${kind}"`);
  }
}

function parseCall(v: unknown, fail: (msg: string) => never): ScriptCall {
  if (Array.isArray(v)) return { steps: parseSteps(v, fail) };
  if (!isRecord(v)) fail('a call must be a JSON array of steps or {"steps": [...], "requestHash"?: "...", "agent"?: "..."}');
  onlyKeys(v, ['steps', 'requestHash', 'agent'], fail);
  if (!Array.isArray(v.steps)) fail('"steps" must be an array');
  const call: ScriptCall = { steps: parseSteps(v.steps, fail) };
  if (v.requestHash !== undefined) {
    // hashRequest gives 16 lowercase hex chars; anything else could never match, so say so now.
    if (typeof v.requestHash !== 'string' || !/^[0-9a-f]{16}$/.test(v.requestHash)) {
      fail('"requestHash" must be 16 lowercase hex chars (the output of hashRequest)');
    }
    call.requestHash = v.requestHash;
  }
  if (v.agent !== undefined) {
    if (typeof v.agent !== 'string' || !has(AGENTS, v.agent)) fail(`"agent" must be one of ${Object.keys(AGENTS).join(', ')}, got ${JSON.stringify(v.agent)}`);
    call.agent = v.agent;
  }
  return call;
}

function parseSteps(steps: unknown[], fail: (msg: string) => never): ScriptStep[] {
  return steps.map((s, i) => parseStep(s, (msg) => fail(`step ${i + 1}: ${msg}`)));
}

/** The physical line (0-based) of the first non-empty line, or -1. */
function firstLine(lines: readonly string[]): number {
  return lines.findIndex((l) => l.trim() !== '');
}

/** The tool transports a caps line may name, checked here because a typo would silently mean "prompted". */
const SCRIPT_TOOLS: readonly ModelCaps['tools'][] = ['native', 'prompted', 'none'];

/**
 * The value rule of each caps field a script may patch (ModelCaps names; the ranges are config.toml's
 * [caps] ranges): a wrong type would otherwise be merged as is (a string window, a negative
 * in-flight count) and show up only as odd budgets.
 */
type CapsRule =
  | { int: [number, number] }
  | { oneOf: readonly string[] }
  | { bool: true }
  | { list: readonly string[] | 'strings' }
  | { object: true }
  | { record: 'strings' }
  | { any: true };
const CAPS_RULES: Readonly<Record<string, CapsRule>> = {
  contextLength: { int: [256, 100_000_000] },
  maxOutput: { int: [1, 100_000_000] },
  maxInFlight: { int: [1, 64] },
  cacheMinTokens: { int: [1, 1_000_000] },
  stopMax: { int: [0, 1024] },
  maxTokensField: { oneOf: ['max_tokens', 'max_completion_tokens'] },
  tools: { oneOf: SCRIPT_TOOLS },
  toolChoice: { list: ['auto', 'none', 'required'] },
  toolChoiceHonored: { bool: true },
  parallelToolCalls: { oneOf: ['send-true', 'param', 'never'] },
  strictTools: { bool: true },
  toolIdFormat: { oneOf: ['mistral9'] },
  midSystem: { oneOf: ['anthropic-native', 'native', 'as-user'] },
  alternation: { oneOf: ['free', 'strict'] },
  prefill: { oneOf: ['assistant-last', 'prefix-flag', 'none'] },
  streamUsage: { oneOf: ['stream_options', 'always', 'timings', 'none'] },
  caching: { oneOf: ['auto-prefix', 'anthropic-breakpoints', 'none'] },
  structuredOutput: { object: true },
  reasoning: { object: true },
  samplers: { object: true },
  extraBody: { object: true },
};

/** The fields of the caps objects a script may patch, by object. */
const OBJECT_RULES: Readonly<Record<string, Readonly<Record<string, CapsRule>>>> = {
  structuredOutput: { mode: { oneOf: ['json_schema', 'none'] }, confirmedBy: { oneOf: ['host', 'probe', 'user'] } },
  reasoning: {
    output: { oneOf: ['none', 'reasoning_content', 'reasoning', 'reasoning_details', 'tags', 'anthropic-blocks', 'gemini-parts'] },
    tags: { list: 'strings' },
    control: { oneOf: ['none', 'effort', 'budget', 'adaptive', 'level', 'toggle'] },
    canDisable: { bool: true },
    echo: { oneOf: ['never', 'tool-turn', 'all-with-tools'] },
    answerInReasoning: { bool: true },
    efforts: { list: 'strings' },
    offShape: { any: true },
  },
  samplers: { accepted: { list: 'strings' }, fixed: { bool: true }, wire: { record: 'strings' } },
};

/** Why `v` breaks `rule`, or null. */
function capsRuleProblem(v: unknown, rule: CapsRule): string | null {
  if ('int' in rule) {
    const [lo, hi] = rule.int;
    return Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? null : `must be an integer from ${lo} to ${hi}`;
  }
  if ('oneOf' in rule) return typeof v === 'string' && rule.oneOf.includes(v) ? null : `must be one of ${rule.oneOf.join(', ')}`;
  if ('bool' in rule) return typeof v === 'boolean' ? null : 'must be a boolean';
  if ('object' in rule) return isRecord(v) ? null : 'must be an object';
  if ('record' in rule) return isRecord(v) && Object.values(v).every((x) => typeof x === 'string') ? null : 'must be an object of strings';
  if ('any' in rule) return null;
  const items = rule.list;
  if (items === 'strings') return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be an array of strings';
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && items.includes(x)) ? null : `must be an array of ${items.join(', ')}`;
}

/** A `{"caps": {...}}` patch, checked: an object, known keys only (caps.ts rules), each value of its field's type. */
function parseCapsPatch(v: unknown, fail: (msg: string) => never): Partial<ModelCaps> {
  if (!isRecord(v)) fail('"caps" must be an object of ModelCaps fields, e.g. {"tools": "native"}');
  const problems = checkCapsRows([{ match: '*', as_of: '2026-01-01', src: 'script', caps: v as Partial<ModelCaps> }], 'models');
  if (problems.length > 0) fail(`caps: ${problems.map((p) => p.replace(/^models\[0\]: /, '')).join('; ')}`);
  for (const [k, value] of Object.entries(v)) {
    const rule = CAPS_RULES[k];
    if (rule === undefined) continue; // checkCapsRows refused unknown keys above
    const problem = capsRuleProblem(value, rule);
    if (problem !== null) fail(`caps.${k} ${problem}, got ${JSON.stringify(value)}`);
    const fields = OBJECT_RULES[k];
    if (fields === undefined || !isRecord(value)) continue;
    for (const [f, fv] of Object.entries(value)) {
      const fr = fields[f];
      if (fr === undefined) fail(`caps.${k}: unknown field "${f}" (allowed: ${Object.keys(fields).join(', ')})`);
      const fp = capsRuleProblem(fv, fr);
      if (fp !== null) fail(`caps.${k}.${f} ${fp}, got ${JSON.stringify(fv)}`);
    }
  }
  return JSON.parse(JSON.stringify(v)) as Partial<ModelCaps>;
}

/** The first line of a script file: `{"caps": {...}}`, `{"local": true}` or both in one object. */
const isHeader = (v: unknown): v is Record<string, unknown> => isRecord(v) && ('caps' in v || 'local' in v);

/** Why a header line after the first is refused: its own keys, and that caps and local share the first line's object. */
function misplacedHeader(v: Record<string, unknown>): string {
  const keys = ['caps', 'local'].filter((k) => k in v);
  const shape = `{${keys.map((k) => `"${k}": ...`).join(', ')}}`;
  return `a ${shape} line must be the first line of the file (caps and local go together there, in one object: {"caps": {...}, "local": true})`;
}

/**
 * Parse a script FILE: parseScript, except that the first non-empty line may be `{"caps": {...}}`,
 * a partial caps record for the scripted connection (merged over SCRIPT_CAPS by the caller:
 * scriptCapsWith), and/or `"local": true|false` (M5c, D-207: the scheduler's locality of the
 * script's origin, createScriptedProvider's `localOrigin`). Such a line anywhere else is an error.
 * Throws Error with the line number.
 */
export function parseScriptFile(text: string): { calls: ScriptCall[]; caps?: Partial<ModelCaps>; local?: boolean } {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const at = firstLine(lines);
  let caps: Partial<ModelCaps> | undefined;
  let local: boolean | undefined;
  if (at >= 0) {
    let value: unknown;
    try {
      value = JSON.parse(lines[at]!.trim());
    } catch {
      value = undefined; // parseScript reports it with its line number
    }
    if (isHeader(value)) {
      const fail = (msg: string): never => {
        throw new Error(`script line ${at + 1}: ${msg}`);
      };
      onlyKeys(value, ['caps', 'local'], fail);
      if ('caps' in value) caps = parseCapsPatch(value.caps, fail);
      if ('local' in value) {
        const said = value.local;
        local = typeof said === 'boolean' ? said : fail('"local" must be a boolean (true: the scheduler treats the script\'s origin as local)');
      }
      lines[at] = ''; // the line numbers of the calls stay the editor's
    }
  }
  // A caps or local line later in the file: say so (naming its keys) instead of "unknown field caps".
  lines.forEach((raw, n) => {
    const line = raw.trim();
    if (!line.startsWith('{') || !(line.includes('"caps"') || line.includes('"local"'))) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return; // parseScript reports bad JSON
    }
    if (isHeader(v)) throw new Error(`script line ${n + 1}: ${misplacedHeader(v)}`);
  });
  const calls = parseScript(lines.join('\n'));
  return { calls, ...(caps !== undefined ? { caps } : {}), ...(local !== undefined ? { local } : {}) };
}

/** SCRIPT_CAPS with a script file's caps patch merged over it (deep, as caps rows merge; source stays 'script'). */
export function scriptCapsWith(patch?: Partial<ModelCaps>): ModelCaps {
  return patch === undefined ? structuredClone(SCRIPT_CAPS) : mergeCaps(SCRIPT_CAPS, patch, 'script');
}

/** Parse script JSONL. Throws Error with the line number on bad input. */
export function parseScript(text: string): ScriptCall[] {
  const calls: ScriptCall[] = [];
  // Physical lines, 1-based, so the number in an error is the one an editor shows. trim() also
  // drops a CR before LF; a leading BOM is not part of the first line.
  const lines = text.replace(/^﻿/, '').split('\n');
  lines.forEach((raw, at) => {
    const line = raw.trim();
    if (line === '') return;
    const fail = (msg: string): never => {
      throw new Error(`script line ${at + 1}: ${msg}`);
    };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      fail(`invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    calls.push(parseCall(value, fail));
  });
  return calls;
}

// ---- request hash -------------------------------------------------------------------------------

/** JSON with object keys sorted at every level; undefined members dropped as JSON.stringify does. Shared with record.ts. */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'object' && v !== null && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    v = (v as { toJSON(): unknown }).toJSON();
  }
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return 'null';
  if (typeof v === 'bigint') throw new TypeError('hashRequest: bigint is not JSON');
  if (typeof v !== 'object' || v === null) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const members: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const x = obj[k];
    if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
    members.push(`${JSON.stringify(k)}:${canonicalJson(x)}`);
  }
  return `{${members.join(',')}}`;
}

/** Stable hash of the parts of a request that matter (messages, tools, prefill, maxTokens, samplers). */
export function hashRequest(req: ModelRequest): string {
  // `src`, placement, signal, callKey and caps are bookkeeping: the model never sees them.
  const subject = {
    messages: req.messages.map((m) => ({ role: m.role, blocks: m.blocks })),
    tools: req.tools,
    prefill: req.prefill,
    maxTokens: req.maxTokens,
    samplers: req.samplers,
  };
  return createHash('sha256').update(canonicalJson(subject)).digest('hex').slice(0, 16);
}

/** What a mismatching request looked like, without echoing prompt text. */
function describeRequest(req: ModelRequest): string {
  const roles = req.messages.map((m) => m.role).join(',');
  const prefill = req.prefill === undefined ? 'none' : `${req.prefill.length} chars`;
  return `messages ${req.messages.length} [${roles}], tools ${req.tools?.length ?? 0}, prefill ${prefill}, maxTokens ${req.maxTokens}, samplers ${canonicalJson(req.samplers)}`;
}

// ---- provider -----------------------------------------------------------------------------------

export interface ScriptedProvider extends Provider {
  /** Every request received, in order (for assertions). */
  readonly requests: ModelRequest[];
  /** Release a {pause} step. Releasing a name nobody waits on is remembered (release-before-pause works). */
  release(name: string): void;
  /** Calls not yet taken (tagged ones included). */
  remaining(): number;
  /**
   * M5c (D-207): the script's own word on its origin's locality (createScriptedProvider's `localOrigin`,
   * a script file's `"local"`), read by the scheduler (sched.ts connectionLocality). Absent: it says none.
   */
  readonly localOrigin?: boolean;
  /**
   * The lead's ruling K (M5c): whether any line of the script is tagged `"agent": "recall"`. A script with
   * none was not written for recall (every script before M5c): as an engine's providerOverride it makes
   * recall's default mode lexical (engine.ts scriptRecallDefault), so a recall call never takes the
   * untagged lines the narrator and the Director wait for.
   */
  readonly recallTagged: boolean;
}

/** createScriptedProvider's options. */
export interface ScriptedOptions {
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** D-207: the scheduler treats the connection's origin as local (true) or remote (false). */
  localOrigin?: boolean;
}

/** The calls of a script no request has taken yet (D-207). */
interface ScriptQueue {
  /** The call a request of `agent` takes (its own first line, else the first untagged one) and its place in the script (0-based). */
  take(agent: CallAgent): { call: ScriptCall; at: number } | undefined;
  remaining(): number;
  /** The lines left for agents other than `agent`, counted per agent ('director 1, recall 2'; '' when none). */
  taggedFor(agent: CallAgent): string;
}

function scriptQueue(calls: readonly ScriptCall[]): ScriptQueue {
  // Each call keeps its place in the script: with tags, the n-th request may take a later line.
  const left = calls.map((call, at) => ({ call, at }));
  return {
    take(agent) {
      // The agent's own line first; else the next untagged one. Lines tagged for others wait for them.
      let i = left.findIndex((c) => c.call.agent === agent);
      if (i < 0) i = left.findIndex((c) => c.call.agent === undefined);
      return i < 0 ? undefined : left.splice(i, 1)[0];
    },
    remaining: () => left.length,
    taggedFor(agent) {
      const others = new Map<string, number>();
      for (const { call: c } of left) if (c.agent !== undefined && c.agent !== agent) others.set(c.agent, (others.get(c.agent) ?? 0) + 1);
      return [...others].map(([a, n]) => `${a} ${n}`).join(', ');
    },
  };
}

function failure(code: ProviderErrorCode, message: string, afterOutput: boolean): StreamEv {
  return { t: 'error', err: new ProviderError({ category: CATEGORY[code], code, message, afterOutput }), afterOutput };
}

/** Throws the signal's reason before every event, so an abort at any point surfaces as a throw. */
async function* guarded(signal: AbortSignal, inner: AsyncGenerator<StreamEv>): AsyncGenerator<StreamEv> {
  signal.throwIfAborted();
  for await (const ev of inner) {
    signal.throwIfAborted();
    yield ev;
  }
  signal.throwIfAborted();
}

export function createScriptedProvider(calls: ScriptCall[], opts?: ScriptedOptions): ScriptedProvider {
  const script = scriptQueue(calls);
  const total = calls.length;
  const timers = opts?.timers;
  const requests: ModelRequest[] = [];
  // Pause gates. Each release lets exactly one pause through: the oldest one waiting on that name,
  // or, when nobody waits, the next one to arrive (a banked token).
  const banked = new Map<string, number>();
  const waiters = new Map<string, (() => void)[]>();

  function release(name: string): void {
    const queue = waiters.get(name);
    const wake = queue?.shift();
    if (queue && queue.length === 0) waiters.delete(name);
    if (wake) wake();
    else banked.set(name, (banked.get(name) ?? 0) + 1);
  }

  function pause(name: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const tokens = banked.get(name) ?? 0;
    if (tokens > 0) {
      if (tokens === 1) banked.delete(name);
      else banked.set(name, tokens - 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const queue = waiters.get(name) ?? [];
      waiters.set(name, queue);
      const onAbort = (): void => {
        // An aborted pause must not swallow a later release meant for someone else.
        const at = queue.indexOf(wake);
        if (at >= 0) queue.splice(at, 1);
        if (queue.length === 0 && waiters.get(name) === queue) waiters.delete(name);
        reject(signal.reason);
      };
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      queue.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * `taken`: the call and its place in the script (undefined: none left for this agent); `index`: the
   * request's arrival number (0-based), which the tool ids and the exhausted message use.
   */
  async function* play(req: ModelRequest, taken: { call: ScriptCall; at: number } | undefined, index: number, others: string): AsyncGenerator<StreamEv> {
    if (!taken) {
      // Lines left that are tagged for other agents are named: the script is not used up, it is out of this agent's.
      const tagged = others === '' ? '' : `; left for other agents: ${others}`;
      yield failure(
        'script_exhausted',
        `${PROVIDER_ERROR_MESSAGE.script_exhausted}: request ${index + 1} has no call left (the script has ${total})${tagged}`,
        false,
      );
      return;
    }
    const { call } = taken;
    if (call.requestHash !== undefined) {
      const actual = hashRequest(req);
      if (actual !== call.requestHash) {
        // The call that holds the hash (its place among the script's calls); the request's own number when they differ.
        const which = taken.at === index ? `script call ${taken.at + 1}` : `script call ${taken.at + 1} (taken by request ${index + 1}, the ${req.agent}'s)`;
        yield failure(
          'bad_request',
          `${which}: request hash mismatch: expected ${call.requestHash}, actual ${actual} ` +
            `(${describeRequest(req)}); if the change is intended, set requestHash to ${actual}`,
          false,
        );
        return;
      }
    }
    const signal = req.signal;
    let output = false;
    let finish: FinishReason = 'end';
    let toolIndex = 0;
    for (const step of call.steps) {
      if ('text' in step) {
        output = true;
        yield { t: 'text', i: 0, d: step.text };
      } else if ('reasoning' in step) {
        output = true;
        yield { t: 'reasoning', i: 0, d: step.reasoning };
      } else if ('tool' in step) {
        // Tool calls are indexed 0, 1, … per call, as openai-chat (the scripted dialect) does.
        const i = toolIndex++;
        output = true;
        yield { t: 'tool_start', i, id: step.tool.id ?? `call_${index + 1}_${i}`, name: step.tool.name };
        // argsText goes out verbatim (an empty one sends no delta, as a server that sent no arguments).
        const d = step.tool.argsText ?? JSON.stringify(step.tool.args ?? {});
        if (d !== '') yield { t: 'tool_args', i, d };
        yield { t: 'tool_end', i };
      } else if ('replay' in step) {
        const r = step.replay;
        yield {
          t: 'replay',
          r: { kind: r.kind, connection: r.connection ?? req.model.connection, model: r.model ?? req.model.model, payload: structuredClone(r.payload) },
        };
      } else if ('delay' in step) {
        await abortableDelay(step.delay, signal, timers);
      } else if ('pause' in step) {
        await pause(step.pause, signal);
      } else if ('error' in step) {
        const e = step.error;
        const afterOutput = e.afterOutput ?? output;
        const err = new ProviderError({
          category: CATEGORY[e.code],
          code: e.code,
          status: e.status,
          retryAfterSec: e.retryAfterSec,
          message: e.message,
          afterOutput,
        });
        yield { t: 'error', err, afterOutput };
        return;
      } else if ('usage' in step) {
        yield { t: 'usage', u: { ...step.usage } };
      } else if ('cut' in step) {
        return;
      } else {
        finish = step.finish;
      }
    }
    yield { t: 'finish', reason: finish, raw: finish };
  }

  return {
    requests,
    release,
    remaining: () => script.remaining(),
    ...(opts?.localOrigin !== undefined ? { localOrigin: opts.localOrigin } : {}),
    recallTagged: calls.some((c) => c.agent === 'recall'),
    stream(req: ModelRequest, _env: ProviderEnv): AsyncIterable<StreamEv> {
      // Recorded and consumed at call time, not on first iteration, so a test can assert on
      // `requests` and `remaining()` as soon as the engine has asked.
      requests.push(req);
      const index = requests.length - 1;
      const taken = script.take(req.agent);
      return guarded(req.signal, play(req, taken, index, taken ? '' : script.taggedFor(req.agent)));
    },
  };
}

/** Caps of the scripted connection: openai-chat dialect, assistant-last prefill, 8192 context, no tools, 1 in flight. */
export const SCRIPT_CAPS: ModelCaps = {
  dialect: 'openai-chat',
  contextLength: 8192,
  maxTokensField: 'max_tokens',
  tools: 'none',
  toolChoice: ['auto', 'none'],
  toolChoiceHonored: true,
  parallelToolCalls: 'never',
  strictTools: false,
  structuredOutput: { mode: 'none' },
  midSystem: 'native',
  alternation: 'free',
  prefill: 'assistant-last',
  reasoning: { output: 'none', control: 'none', canDisable: true, echo: 'never' },
  samplers: { accepted: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed'] },
  streamUsage: 'always',
  caching: 'none',
  maxInFlight: 1,
  source: ['script'],
};
