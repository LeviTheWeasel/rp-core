// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The OpenAI-compatible Chat Completions adapter (ARCHITECTURE.md §8.1, §8.4 "openai-chat (M1)").
// Covers llama.cpp, Ollama, LM Studio, koboldcpp, vLLM, TabbyAPI, OpenRouter, NanoGPT, DeepSeek.
// Port sources (adapt): Bunraku src/stage/provider/openai-compatible-request.ts, -reply.ts,
// openai-compatible.ts, provider-send.ts, reasoning-wire.ts (as data). Quirks list only: RoleCall
// apps/rc/src/lib/providers/adapters/openai.ts, base.ts.
// CONTRACT FILE (M1b): signatures are fixed; the adapter agent implements the bodies.

import type { ModelRequest, Provider, StreamEv } from './types.ts';
import type { HttpRequest } from './http.ts';
import type { ConnectionOverrides } from './wire.ts';

export interface OpenAIChatOptions {
  connectionId: string;
  baseUrl: string;
  local: boolean;
  overrides?: ConnectionOverrides;
}

/** Keep a path that has a /vN segment; else append /v1. Strip pasted /models, /completions, /chat/completions; then add /chat/completions. */
export function chatCompletionsUrl(baseUrl: string): string {
  void baseUrl;
  throw new Error('not implemented: chatCompletionsUrl');
}

/** Pure request builder (no I/O): url, headers (Authorization only when key), JSON body. */
export function buildChatRequest(req: ModelRequest, o: OpenAIChatOptions, key: string | null): HttpRequest {
  void req; void o; void key;
  throw new Error('not implemented: buildChatRequest');
}

/**
 * Per-request stateful parser over SSE data payloads. line() takes one data string (JSON or '[DONE]')
 * and returns normalised events; end() is called at EOF and returns the closing events (finish, or an
 * error 'truncated_stream' when neither finish nor [DONE] arrived).
 */
export function createChatParser(req: ModelRequest): { line(data: string): StreamEv[]; end(): StreamEv[] } {
  void req;
  throw new Error('not implemented: createChatParser');
}

export function createOpenAIChatProvider(o: OpenAIChatOptions): Provider {
  void o;
  throw new Error('not implemented: createOpenAIChatProvider');
}
