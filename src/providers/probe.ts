// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The catalog half of rp-core probe (ARCHITECTURE.md §8.2 source 3, §15 M1b). Active probes (tools,
// stream shape, json_schema) arrive in M3. A probe only ADVISES: it never raises capacity [D-84].
// Port sources: Bunraku src/kit/providers/models.ts (/models ladder, ~60 lines); RoleCall
// apps/rc/src/lib/models/fetcher.ts parseCapabilities (lines 110-135).
// CONTRACT FILE (M1b): signatures are fixed; the caps agent implements the bodies.

import type { ModelCaps } from './types.ts';

export interface CatalogInfo {
  server: 'llama.cpp' | 'ollama' | 'lmstudio' | 'koboldcpp' | 'openrouter' | 'vllm' | 'unknown';
  models: { id: string; contextLength?: number }[];
  /** Per model id, what the catalog says (contextLength, tools, reasoning...). */
  caps: Record<string, Partial<ModelCaps>>;
  /** Slots the server reports (llama.cpp /slots or /props total_slots): advice only. */
  slots?: number;
  notes: string[];
}

/**
 * Ladder: GET <base>/v1/models then <base>/models; llama.cpp GET /props (n_ctx, total_slots);
 * Ollama POST /api/show per model (context_length from model_info, capabilities incl. 'tools'/'thinking');
 * OpenRouter /api/v1/models (supported_parameters, context_length); koboldcpp /api/extra/version.
 * Every request uses http.guardedFetch with a short timeout; failures become notes, never throws for a
 * reachable server; throws ProviderError 'unreachable' when nothing answers.
 */
export function fetchCatalog(
  baseUrl: string,
  opts: { fetch: typeof fetch; key: string | null; signal: AbortSignal; model?: string },
): Promise<CatalogInfo> {
  void baseUrl; void opts;
  throw new Error('not implemented: fetchCatalog');
}

/** <home>/caps-cache.json: {"conn:model": {as_of, server, caps}}. Missing file → {}. Atomic writes. */
export interface CapsCacheRow {
  as_of: string;
  server?: string;
  caps: Partial<ModelCaps>;
}
export function readCapsCache(home: string): Record<string, CapsCacheRow> {
  void home;
  throw new Error('not implemented: readCapsCache');
}
export function writeCapsCache(home: string, cache: Record<string, CapsCacheRow>): void {
  void home; void cache;
  throw new Error('not implemented: writeCapsCache');
}
