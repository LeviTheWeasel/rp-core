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

import { createHash } from 'node:crypto';
import { abortableDelay } from '../engine/abort.ts';
import { PROVIDER_ERROR_CATEGORY, PROVIDER_ERROR_MESSAGE, ProviderError } from './types.ts';
import type { ProviderErrorCategory, ProviderEnv, StreamEv } from './types.ts';
import type { FinishReason, ModelCaps, ModelRequest, Provider, ProviderErrorCode, Usage } from './types.ts';

export type ScriptStep =
  | { text: string }
  | { reasoning: string }
  | { tool: { name: string; args: unknown; id?: string } }
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
      if (!isRecord(arg)) fail('"tool" must be an object {name, args, id?}');
      onlyKeys(arg, ['name', 'args', 'id'], fail);
      if (typeof arg.name !== 'string' || arg.name === '') fail('tool.name must be a non-empty string');
      if (arg.id !== undefined && (typeof arg.id !== 'string' || arg.id === '')) fail('tool.id must be a non-empty string');
      // A missing args object means "called with no arguments", which models send as {}.
      const tool = { name: arg.name, args: arg.args === undefined ? {} : arg.args };
      return { tool: typeof arg.id === 'string' ? { ...tool, id: arg.id } : tool };
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
  if (!isRecord(v)) fail('a call must be a JSON array of steps or {"steps": [...], "requestHash"?: "..."}');
  onlyKeys(v, ['steps', 'requestHash'], fail);
  if (!Array.isArray(v.steps)) fail('"steps" must be an array');
  const call: ScriptCall = { steps: parseSteps(v.steps, fail) };
  if (v.requestHash !== undefined) {
    // hashRequest gives 16 lowercase hex chars; anything else could never match, so say so now.
    if (typeof v.requestHash !== 'string' || !/^[0-9a-f]{16}$/.test(v.requestHash)) {
      fail('"requestHash" must be 16 lowercase hex chars (the output of hashRequest)');
    }
    call.requestHash = v.requestHash;
  }
  return call;
}

function parseSteps(steps: unknown[], fail: (msg: string) => never): ScriptStep[] {
  return steps.map((s, i) => parseStep(s, (msg) => fail(`step ${i + 1}: ${msg}`)));
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
  remaining(): number;
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

export function createScriptedProvider(
  calls: ScriptCall[],
  opts?: { timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void } },
): ScriptedProvider {
  const script = [...calls];
  const timers = opts?.timers;
  const requests: ModelRequest[] = [];
  let next = 0;
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

  async function* play(req: ModelRequest, call: ScriptCall | undefined, index: number): AsyncGenerator<StreamEv> {
    if (!call) {
      yield failure(
        'script_exhausted',
        `${PROVIDER_ERROR_MESSAGE.script_exhausted}: request ${index + 1} has no call left (the script has ${script.length})`,
        false,
      );
      return;
    }
    if (call.requestHash !== undefined) {
      const actual = hashRequest(req);
      if (actual !== call.requestHash) {
        yield failure(
          'bad_request',
          `script call ${index + 1}: request hash mismatch: expected ${call.requestHash}, actual ${actual} ` +
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
        yield { t: 'tool_args', i, d: JSON.stringify(step.tool.args ?? {}) };
        yield { t: 'tool_end', i };
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
    remaining: () => script.length - next,
    stream(req: ModelRequest, _env: ProviderEnv): AsyncIterable<StreamEv> {
      // Recorded and consumed at call time, not on first iteration, so a test can assert on
      // `requests` and `remaining()` as soon as the engine has asked.
      requests.push(req);
      const index = requests.length - 1;
      const call = script[next];
      if (call) next++;
      return guarded(req.signal, play(req, call, index));
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
