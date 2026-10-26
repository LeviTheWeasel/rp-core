// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Leaked tool-call markup in prose (ARCHITECTURE.md §8.3 "Восстановление протечек", D-57). M1b: strip
// only, in post-processing (engine turn step 9). Turning complete calls into real calls arrives in M3.
// Port sources: Bunraku src/core/assembly/sanitize.ts stripToolCallLeaks; RoleCall
// apps/rc/src/lib/ai/strip-tool-call-leaks.ts, dsml-tool-calls.ts (formats only).
// CONTRACT FILE (M1b): signature is fixed; the prompt-m1b agent implements the body.

/**
 * Remove Hermes/Qwen <tool_call>…</tool_call>, DSML blocks, <function=…>…</function>, <invoke …>…</invoke>,
 * [TOOL_REQUEST]…[END_TOOL_REQUEST], [TOOL_CALLS] [...] and an unterminated tail of any of these at the
 * end of the text. Prose around them is kept; leftover blank-line runs are collapsed.
 */
export function stripToolCallLeaks(text: string): { text: string; stripped: number } {
  void text;
  throw new Error('not implemented: stripToolCallLeaks');
}
