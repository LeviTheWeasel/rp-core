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
  | 'script_exhausted'; // scripted provider only: the script ran out of calls

/** [D-51] categories. */
export type ProviderErrorCategory = 'auth' | 'request' | 'rate' | 'server' | 'network' | 'content' | 'protocol';

/**
 * A provider failure. `message` may echo prompt text, so it is shown live but never stored:
 * only {category, code, status} reach the session log (§8.8, §13).
 */
export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryAfterSec?: number;
  readonly afterOutput: boolean;
  constructor(init: {
    category: ProviderErrorCategory;
    code: ProviderErrorCode;
    message?: string;
    status?: number;
    retryAfterSec?: number;
    afterOutput?: boolean;
  }) {
    super(init.message ?? init.code);
    this.name = 'ProviderError';
    this.category = init.category;
    this.code = init.code;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterSec !== undefined) this.retryAfterSec = init.retryAfterSec;
    this.afterOutput = init.afterOutput ?? false;
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
  };
  samplers: { accepted: string[]; fixed?: boolean; wire?: Record<string, string> };
  streamUsage: 'stream_options' | 'always' | 'timings' | 'none';
  caching: 'auto-prefix' | 'anthropic-breakpoints' | 'none';
  maxInFlight: number;
  cacheMinTokens?: number; // [D-54]
  stopMax?: number; // [D-54]
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
}

export interface Provider {
  stream(req: ModelRequest, env: ProviderEnv): AsyncIterable<StreamEv>;
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
