// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The provider contract (ARCHITECTURE.md §8.1, §8.2, §8.8). Every adapter (openai-chat M1b,
// anthropic M7, gemini M8, scripted M1a) speaks this shape. The engine always streams;
// "complete" is aggregate(stream) plus a terminal-state check.

import type { Block } from '../session/entries.ts';
import type { Samplers } from '../formats/native.ts';

/** Token usage normalised across providers. A missing field means "unknown", never zero. */
export interface Usage {
  inputTotal?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
  inputCacheWrite1h?: number; // [D-51]
  outputTotal?: number;
  outputReasoning?: number;
  cost?: number; // provider-reported, USD
}

export type FinishReason =
  | 'end'
  | 'length'
  | 'stopped'
  | 'interrupted'
  | 'content_filter'
  | 'refusal'
  | 'max_rounds';

export type ProviderErrorCode =
  | 'auth_failed'
  | 'model_not_found'
  | 'context_length_exceeded'
  | 'bad_request'
  | 'rate_limited'
  | 'overloaded'
  | 'unreachable'
  | 'truncated_stream'
  | 'timeout'
  | 'content_filter'
  | 'refusal'
  | 'empty_response'
  | 'reasoning_only'
  | 'prefill_unsupported'
  | 'forced_tool_unsupported'
  | 'thinking_signature_mismatch'
  | 'tool_protocol_invalid'
  | 'script_exhausted' // scripted and replay providers: the script (or the recording) ran out of calls
  | 'replay_mismatch' // replay provider only (M2): the request differs from the recorded one
  | 'replay_aborted' // replay provider only (M2 fix): the recorded call was stopped while recording
  | 'key_unavailable'; // key_env unset or key_cmd failed / timed out [D-73]

/** [D-51] categories. */
export type ProviderErrorCategory = 'auth' | 'request' | 'rate' | 'server' | 'network' | 'content' | 'protocol';

/** [D-51] category of every code. A Record, so a new code fails the typecheck until it is placed. Shared by every adapter. */
export const PROVIDER_ERROR_CATEGORY: Readonly<Record<ProviderErrorCode, ProviderErrorCategory>> = {
  auth_failed: 'auth',
  model_not_found: 'request',
  bad_request: 'request',
  context_length_exceeded: 'request',
  replay_mismatch: 'request',
  replay_aborted: 'request',
  prefill_unsupported: 'request',
  forced_tool_unsupported: 'request',
  tool_protocol_invalid: 'request',
  script_exhausted: 'request',
  rate_limited: 'rate',
  overloaded: 'server',
  unreachable: 'network',
  timeout: 'network',
  truncated_stream: 'network',
  content_filter: 'content',
  refusal: 'content',
  empty_response: 'protocol',
  reasoning_only: 'protocol',
  thinking_signature_mismatch: 'protocol',
  key_unavailable: 'auth',
};

export function categoryOf(code: ProviderErrorCode): ProviderErrorCategory {
  return PROVIDER_ERROR_CATEGORY[code];
}

/**
 * The fixed, user-facing sentence for each code (§13: provider error text is reduced to
 * {category, code, status} and a fixed message per code before it is written anywhere). Adapters
 * build `message` from this (plus the status, the origin or an engine-authored reason that quotes
 * nothing the server or the environment said); the server's own words go to `detail`.
 */
export const PROVIDER_ERROR_MESSAGE: Readonly<Record<ProviderErrorCode, string>> = {
  auth_failed: 'the server refused the API key',
  model_not_found: 'the server does not know this model (or this URL)',
  context_length_exceeded: "the prompt does not fit the model's context window",
  bad_request: 'the server refused the request',
  rate_limited: 'the server is rate limiting requests',
  overloaded: 'the server failed or is overloaded',
  unreachable: 'the server could not be reached',
  truncated_stream: 'the answer broke off',
  timeout: 'the server did not answer in time',
  content_filter: "the provider's moderation refused the request",
  refusal: 'the model refused to answer',
  empty_response: 'the model returned an empty reply',
  reasoning_only: 'the model only reasoned and wrote no reply',
  prefill_unsupported: 'this model does not accept a prefill',
  forced_tool_unsupported: 'this model does not accept a forced tool call',
  thinking_signature_mismatch: "the provider rejected the replayed reasoning's signature",
  tool_protocol_invalid: 'the tool calls broke the protocol',
  script_exhausted: 'the script ran out of calls',
  replay_mismatch: 'the request differs from the recorded one',
  replay_aborted: 'this call was stopped (or timed out) while it was recorded',
  key_unavailable: 'the API key is unavailable',
};

/** "<fixed message> (HTTP <status>)": what a failure may say anywhere without --debug. */
export function providerMessage(code: ProviderErrorCode, status?: number): string {
  return status === undefined ? PROVIDER_ERROR_MESSAGE[code] : `${PROVIDER_ERROR_MESSAGE[code]} (HTTP ${status})`;
}

/**
 * A provider failure. `message` is safe to show and to put in events: adapters write it from a
 * fixed sentence per code (PROVIDER_ERROR_MESSAGE) and engine-authored context only. The server's
 * own words (which may quote the prompt, or echo a key or a header back) and raw transport errors
 * go to `detail`: shown live only on --debug, never stored or put in an event (§8.8, §13). Only
 * {category, code, status} reach the session log.
 */
export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryAfterSec?: number;
  readonly afterOutput: boolean;
  /** Raw server / transport text, for --debug only (never in events, files or plain output). */
  readonly detail?: string;
  constructor(init: {
    category: ProviderErrorCategory;
    code: ProviderErrorCode;
    message?: string;
    status?: number;
    retryAfterSec?: number;
    afterOutput?: boolean;
    detail?: string;
  }) {
    super(init.message ?? init.code);
    this.name = 'ProviderError';
    this.category = init.category;
    this.code = init.code;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterSec !== undefined) this.retryAfterSec = init.retryAfterSec;
    this.afterOutput = init.afterOutput ?? false;
    if (init.detail !== undefined && init.detail !== '') this.detail = init.detail;
  }
  /** The same failure with another afterOutput (everything else, detail included, kept). */
  withAfterOutput(afterOutput: boolean): ProviderError {
    return new ProviderError({
      category: this.category,
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.retryAfterSec !== undefined ? { retryAfterSec: this.retryAfterSec } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      afterOutput,
    });
  }
  /** What may be persisted. */
  toRecord(): { category: ProviderErrorCategory; code: ProviderErrorCode; status?: number } {
    return this.status === undefined
      ? { category: this.category, code: this.code }
      : { category: this.category, code: this.code, status: this.status };
  }
}

/** HTTP statuses that may be retried once before any output (§6.6). */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504, 524, 529]);

export interface ModelRef {
  connection: string;
  model: string;
}

/** Model capability record (§8.2). Data, never regexes over model ids. */
export interface ModelCaps {
  dialect: 'openai-chat' | 'anthropic' | 'gemini';
  contextLength?: number;
  maxOutput?: number;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  tools: 'native' | 'prompted' | 'none';
  toolChoice: ('auto' | 'none' | 'required')[];
  toolChoiceHonored: boolean;
  parallelToolCalls: 'send-true' | 'param' | 'never';
  strictTools: boolean;
  toolIdFormat?: 'mistral9';
  structuredOutput: { mode: 'json_schema' | 'none'; confirmedBy?: 'host' | 'probe' | 'user' };
  midSystem: 'anthropic-native' | 'native' | 'as-user';
  alternation: 'free' | 'strict';
  prefill: 'assistant-last' | 'prefix-flag' | 'none';
  reasoning: {
    output:
      | 'none'
      | 'reasoning_content'
      | 'reasoning'
      | 'reasoning_details'
      | 'tags'
      | 'anthropic-blocks'
      | 'gemini-parts';
    tags?: string[];
    control: 'none' | 'effort' | 'budget' | 'adaptive' | 'level' | 'toggle';
    canDisable: boolean;
    offShape?: unknown;
    echo: 'never' | 'tool-turn' | 'all-with-tools';
    answerInReasoning?: boolean;
    /** [D-54] allowed effort values instead of regexes over model ids. */
    efforts?: string[];
  };
  samplers: { accepted: string[]; fixed?: boolean; wire?: Record<string, string> };
  streamUsage: 'stream_options' | 'always' | 'timings' | 'none';
  caching: 'auto-prefix' | 'anthropic-breakpoints' | 'none';
  maxInFlight: number;
  cacheMinTokens?: number; // [D-54]
  stopMax?: number; // [D-54]
  /** [D-54] host/model specific body fields (OpenRouter provider.allow_fallbacks, llama.cpp cache_prompt, ...). Protected keys are never overwritten. */
  extraBody?: Record<string, unknown>;
  source: ('host' | 'model' | 'catalog' | 'probe' | 'user' | 'script')[];
}

export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  schema: JSONSchema;
}

/** Verbatim provider payloads kept in memory only, inside the current tool loop (§8.6). */
export interface Replay {
  kind: 'anthropic-blocks' | 'gemini-parts' | 'reasoning_details' | 'tool_extra';
  connection: string;
  model: string;
  payload: unknown;
}

/** One message of the normalised request. `src` names where it came from (preset block id, 'history', 'author_note', ...). */
export interface PromptMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  blocks: Block[];
  placement?: 'head' | 'inline';
  src: string;
  replay?: Replay[];
}

export type CallAgent = 'narrator' | 'director' | 'recall' | 'filing' | 'historian';

export interface ModelRequest {
  model: ModelRef;
  caps: ModelCaps;
  messages: PromptMsg[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  /** Text the reply must start with (sent the way caps.prefill says). Never together with tools [D-28]. */
  prefill?: string;
  maxTokens: number;
  samplers: Partial<Samplers>;
  stop?: string[];
  reasoning?: 'auto' | 'none' | 'low' | 'medium' | 'high';
  responseSchema?: { name: string; schema: JSONSchema };
  signal: AbortSignal;
  callKey: string;
  agent: CallAgent;
}

export type StreamEv =
  | { t: 'text'; i: number; d: string }
  | { t: 'reasoning'; i: number; d: string }
  | { t: 'reasoning_end'; i: number; signature?: string; redacted?: boolean }
  | { t: 'tool_start'; i: number; id: string; name: string }
  | { t: 'tool_args'; i: number; d: string }
  | { t: 'tool_end'; i: number }
  | { t: 'usage'; u: Usage }
  | { t: 'finish'; reason: FinishReason; raw: string; model?: string }
  | { t: 'error'; err: ProviderError; afterOutput: boolean };

export interface ProviderEnv {
  fetch: typeof fetch;
  key: string | null;
  /**
   * Called on every chunk of response body bytes, SSE comments and keep-alives included (§8.8: the
   * first-byte and idle timeouts are about bytes on the wire, not about parsed events). Optional:
   * a provider that never calls it is timed by its events alone.
   */
  onActivity?(): void;
}

export interface Provider {
  stream(req: ModelRequest, env: ProviderEnv): AsyncIterable<StreamEv>;
  /**
   * M2 (/preview --wire): the HTTP request this provider would send for `req`, without sending it
   * and without headers (they carry the key). Optional: in-process providers have no wire.
   */
  wire?(req: ModelRequest): { url: string; body: unknown };
}

/** What one streamed call amounts to once aggregated [D-51]. */
export interface AssistantResult {
  blocks: Block[];
  replay?: Replay[];
  usage?: Usage;
  finish: { reason: FinishReason; raw: string };
  /** The model the server actually served (goes to gen.served). */
  model?: string;
}
