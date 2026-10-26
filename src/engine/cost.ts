// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The cost of one call (ARCHITECTURE.md §11 "Учёт"). Pure. In order:
//   1. what the provider reported (OpenRouter usage.cost, NanoGPT) — priceSource 'provider';
//   2. else the [prices."conn:model"] table of config.toml (EngineOptions.prices), per million
//      input and output tokens — priceSource 'table';
//   3. else null — priceSource 'none'. Never 0 by default: an unknown cost is not a free one.

import type { EngineOptions } from './api.ts';
import type { Usage } from '../providers/types.ts';

/** One [prices."conn:model"] row. */
export type PriceRow = NonNullable<EngineOptions['prices']>[string];

export interface CallCost {
  costUsd: number | null;
  priceSource: 'provider' | 'table' | 'none';
}

const NONE: CallCost = { costUsd: null, priceSource: 'none' };

/** A usable non-negative finite number, else undefined (a missing count is "unknown", never zero). */
const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/**
 * One side of a table price: tokens × rate. A free side (rate 0) costs nothing whether its count is
 * known or not; a priced side with an unknown count is unknown.
 */
function side(tokens: number | undefined, perM: number): number | undefined {
  if (perM === 0) return 0;
  return tokens === undefined ? undefined : tokens * perM;
}

/**
 * The cost of a call from its usage. The table applies only when both priced sides are known, so a
 * provider that reported only the prompt is not billed as if it wrote nothing.
 */
export function usageCost(usage: Usage, price: PriceRow | undefined): CallCost {
  const reported = count(usage.cost);
  if (reported !== undefined) return { costUsd: reported, priceSource: 'provider' };
  if (!price) return NONE;
  const inPerM = count(price.inPerM);
  const outPerM = count(price.outPerM);
  if (inPerM === undefined || outPerM === undefined) return NONE;
  const input = side(count(usage.inputTotal), inPerM);
  const output = side(count(usage.outputTotal), outPerM);
  if (input === undefined || output === undefined) return NONE;
  return { costUsd: (input + output) / 1e6, priceSource: 'table' };
}

/** The price row of a `conn:model` pair, if the table has one. */
export function priceFor(prices: EngineOptions['prices'], conn: string, model: string): PriceRow | undefined {
  if (!prices) return undefined;
  const key = `${conn}:${model}`;
  return Object.hasOwn(prices, key) ? prices[key] : undefined;
}
