// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The built-in narrator tools (ARCHITECTURE.md §9.2, D-5). Which of them a turn offers is decided
// by the request builder (engine/request.ts), once per turn.
// CONTRACT FILE (M3).

import type { ToolSpec } from '../../providers/types.ts';
import type { Tool } from '../types.ts';
import { readHistoryTool, searchHistoryTool } from './history.ts';
import { readLoreTool, searchLoreTool } from './lore.ts';

/** Offered when the history did not fit whole (assemble trimmed it). */
export const HISTORY_TOOLS = (): Tool[] => [searchHistoryTool, readHistoryTool];
/** Offered when the turn's lore holds an enabled entry or live note that did not fire. */
export const LORE_TOOLS = (): Tool[] => [searchLoreTool, readLoreTool];

/** The specs a request declares, sorted by name (the order is part of the cached prefix, §8.3). */
export function toolSpecs(tools: readonly Tool[]): ToolSpec[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}
