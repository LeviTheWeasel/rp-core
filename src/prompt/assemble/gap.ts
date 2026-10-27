// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The gap note and the tool reminder (D-96, .notes/m3-decisions.md). The first live M3 demo
// (docs/M3-DEMO.md §6) showed local models answering from the visible chat as if it were all of it:
// nothing in the request said the history was cut, and the only tool guidance was the core block in
// the head, thousands of tokens before the question. When the history tools are offered and the
// request leaves out a run of messages, two ordinary system messages say so:
// - the gap note (src GAP_SRC) in the chat, right before the first message sent after the left-out
//   run, naming the run in the history tools' numbering (path positions from 1, the greeting #1,
//   hidden messages counted: tools/builtin/history.ts);
// - the reminder (src REMIND_SRC) at depth 0 after every other depth-0 insert. Its text depends on
//   the turn's transport (D-96 amended, section L): native tools keep REMIND_TEXT; prompted tools get
//   REMIND_TEXT_PROMPTED, which shows the search_history call in the core block's call format right
//   where the model writes (the second live run: a small local model reached for a made-up
//   `<search_history>` tag when the only example of the format sat ~9 000 tokens back in the head).
// Both are part of the fixed, never-trimmed budget, the reminder in the variant actually sent. The
// note's numbers depend on the cut, so the budget reserves its widest form first (widestGapMsgs).
// Model-facing texts: English, deterministic (the note changes only when the cut does, which changes
// the request from the trim point anyway; the reminder is constant for a transport). Neither exists
// without the history tools, so a tool-less request is M2's.

import type { PromptMsg, ToolSpec } from '../../providers/types.ts';
import { promptedCallLine } from '../../tools/prompted.ts';

export { promptedCallLine };

/** PromptMsg.src of the gap note. */
export const GAP_SRC = 'core:gap';
/** PromptMsg.src of the reminder. */
export const REMIND_SRC = 'core:remind';

/**
 * The history tools' names (tools/builtin/history.ts, offered together when the history was trimmed,
 * D-92). The note and the reminder name them, so both must be offered for either message to exist.
 */
export const HISTORY_TOOL_NAMES = ['search_history', 'read_history'] as const;

/** The reminder's text for native tools (D-96.2). */
export const REMIND_TEXT =
  '(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up with search_history before you write. If it does not, just write the reply.)';

/**
 * The call the prompted reminder shows: search_history with a placeholder query (D-96 amended), built
 * by the same builder as the core block's example line (tools/prompted.ts promptedCallLine).
 */
export const REMIND_CALL = promptedCallLine('search_history', { query: 'one or two key words' });

/**
 * The reminder's text for prompted tools (D-96 amended, .notes/m3-decisions.md section L): the D-96
 * text with the call shown on a line of its own, then the instruction to stop.
 */
export const REMIND_TEXT_PROMPTED = `(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up before you write. Write the call on a line of its own, then stop:\n${REMIND_CALL}\nIf it does not, just write the reply.)`;

/** The reminder's text for the turn's transport: prompted shows the call, native keeps the D-96 text. */
export function remindText(transport: 'native' | 'prompted'): string {
  return transport === 'prompted' ? REMIND_TEXT_PROMPTED : REMIND_TEXT;
}

/** True when `tools` holds every history tool (the condition of D-96; lore tools alone never count). */
export function offersHistoryTools(tools: readonly Pick<ToolSpec, 'name'>[]): boolean {
  return HISTORY_TOOL_NAMES.every((name) => tools.some((t) => t.name === name));
}

/** The range form with the numbers as given (strings, so the reservation can pass its widest digits). */
const rangeText = (a: string, b: string): string =>
  `[Messages #${a}–#${b} of this chat are not shown here. search_history finds what was said in them; read_history shows them in full.]`;

const singleText = (a: string): string =>
  `[Message #${a} of this chat is not shown here. search_history finds what was said in it; read_history shows it in full.]`;

/**
 * The gap note's text for left-out messages #a..#b (D-96.1): the range with an en dash, or the
 * singular form when a = b.
 */
export function gapText(a: number, b: number): string {
  return a === b ? singleText(String(a)) : rangeText(String(a), String(b));
}

/** A system message of the chat part (placement inline, like a depth insert). */
const systemMsg = (text: string, src: string): PromptMsg => ({ role: 'system', blocks: [{ k: 'text', text }], src, placement: 'inline' });

/**
 * The widest gap notes a path of `pathLength` messages can need, for the budget's reservation: both
 * numbers as wide as the path length's digit count (all nines), in both forms. Every o200k chunk of
 * up to three digits is one token and the chars counter counts characters, so no real note on that
 * path measures more than the larger of the two.
 */
export function widestGapMsgs(pathLength: number): PromptMsg[] {
  const digits = String(Math.max(1, Math.floor(Number.isFinite(pathLength) ? pathLength : 1))).length;
  const widest = '9'.repeat(digits);
  return [systemMsg(rangeText(widest, widest), GAP_SRC), systemMsg(singleText(widest), GAP_SRC)];
}

/** The gap note for left-out messages #a..#b. */
export function gapMsg(a: number, b: number): PromptMsg {
  return systemMsg(gapText(a, b), GAP_SRC);
}

/** The reminder message for the turn's transport (remindText). */
export function remindMsg(transport: 'native' | 'prompted'): PromptMsg {
  return systemMsg(remindText(transport), REMIND_SRC);
}
