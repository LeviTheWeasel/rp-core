// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Model capability records as data (ARCHITECTURE.md §8.2, D-15, D-54). Order of sources, each refining
// the previous: pessimistic defaults → host preset (caps-data/hosts.json) → model rows by glob
// (caps-data/models.json) → catalog → probe cache → user overrides ([caps."conn:model"]).
// Unknown → whatever could 400 is treated as unsupported (tools 'prompted', structuredOutput 'none').
// CONTRACT FILE (M1b): signatures are fixed; the caps agent implements the bodies and fills the JSON.

import type { ModelCaps } from './types.ts';

/** One row of hosts.json / models.json. Every row carries as_of and src (URL or incident id) [D-54]. */
export interface CapsRow {
  /** hosts.json: {port?, hostname? (glob), server?}; models.json: a glob over the model id (case-insensitive). */
  match: { port?: number; hostname?: string; server?: string } | string;
  name?: string;
  as_of: string;
  src: string;
  caps: Partial<ModelCaps>;
}

/** The pessimistic defaults for an unknown openai-chat model (local or remote changes maxInFlight). */
export function pessimisticCaps(dialect: ModelCaps['dialect'], local: boolean): ModelCaps {
  void dialect; void local;
  throw new Error('not implemented: pessimisticCaps');
}

/** Deep merge for caps (reasoning, samplers, structuredOutput merged; arrays replaced); appends source. */
export function mergeCaps(base: ModelCaps, patch: Partial<ModelCaps>, source?: ModelCaps['source'][number]): ModelCaps {
  void base; void patch; void source;
  throw new Error('not implemented: mergeCaps');
}

export interface CapsInput {
  dialect: ModelCaps['dialect'];
  /** origin of the base URL (http.ts originOf). */
  origin: string;
  local: boolean;
  model: string;
  /** The server kind if a probe/catalog knows it ('llama.cpp', 'ollama', 'lmstudio', 'koboldcpp', 'openrouter', ...). */
  server?: string;
  catalog?: Partial<ModelCaps>;
  probe?: Partial<ModelCaps>;
  user?: Partial<ModelCaps>;
  /** explicit max_in_flight of the connection. */
  maxInFlight?: number;
}

export function resolveCaps(input: CapsInput): ModelCaps {
  void input;
  throw new Error('not implemented: resolveCaps');
}
