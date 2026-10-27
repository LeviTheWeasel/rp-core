// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The chat area of a request (ARCHITECTURE.md §5.5, §5.6, §10.1, §10.4): the path messages from the
// root to `upTo`, as the model reads them. History is inert data: assistant text (greetings too) is
// sent as stored, user text gets identity macros only. Only text is rendered [D-16]: reasoning never
// leaves its turn and tool rounds stay out of later prompts, which keeps the prefix stable and never
// mixes native and prompted tool forms. M3: a message's text blocks are sent as ONE text block
// (joined with '', as they streamed), so a multi-round answer is never split on the wire; the
// DeepSeek echo (§8.4, D-94) keeps the raw reasoning of this model's own answers.

import type { PromptMsg } from '../../providers/types.ts';
import type { Block } from '../../session/entries.ts';
import type { MessageView, PathView } from '../../session/view.ts';
import type { MacroRun } from '../macros.ts';

/** PromptMsg.src of every chat message; shape.findContinueTarget looks for it. */
export const HISTORY_SRC = 'history';

export interface ChatArea {
  /** Chat messages oldest → newest; the last one is `upTo`. */
  msgs: PromptMsg[];
  /** Message id of each entry of `msgs`. */
  ids: string[];
  /** The first kept message is a greeting (protected from trimming, §11). */
  greeting: boolean;
}

/** M3 (§8.4): whose raw reasoning the history keeps (AssembleInput.echoReasoning). */
export interface EchoOf {
  connection: string;
  model: string;
}

/** The message's text blocks joined as they streamed; user text through the identity-only macro pass. */
function messageText(m: MessageView, run: MacroRun): string {
  let text = '';
  for (const b of m.blocks) if (b.k === 'text') text += b.text;
  return m.role === 'user' && text !== '' ? run.userText(text) : text;
}

/**
 * The raw reasoning blocks of an answer this connection and model generated, in stored order (empty
 * ones dropped). Greetings, user messages, other models and summaries or redactions keep nothing:
 * only the model's own reasoning may be echoed back to it.
 */
function echoedReasoning(m: MessageView, echo: EchoOf | undefined): Block[] {
  if (echo === undefined || m.role !== 'assistant') return [];
  const gen = m.gen;
  if (gen?.kind !== 'model' || gen.connection !== echo.connection || gen.model !== echo.model) return [];
  return m.blocks.filter((b) => b.k === 'reasoning' && (b.kind === undefined || b.kind === 'raw') && b.text !== '');
}

/**
 * The path from the root to `upTo` (inclusive). Hidden messages and messages without text are
 * skipped, except `upTo` itself: it is what the turn is about. Nothing is cut here: the budget and
 * preset.context.maxMessages are one cut in assemble (budget.ts trimHistory), which protects the
 * greeting, keeps the chunk grid and records what it dropped. With `echo`, an answer of that
 * connection and model carries its raw reasoning blocks before its text block.
 * Throws when `upTo` is not on the path: the engine admits a turn only for a path message.
 */
export function chatArea(view: PathView, upTo: string, run: MacroRun, echo?: EchoOf): ChatArea {
  const end = view.path.findIndex((m) => m.id === upTo);
  if (end < 0) throw new Error(`assemble: upTo '${upTo}' is not on the active path`);

  const kept: { view: MessageView; msg: PromptMsg }[] = [];
  for (let i = 0; i <= end; i++) {
    const m = view.path[i]!;
    const last = i === end;
    if (m.hidden && !last) continue;
    const text = messageText(m, run);
    if (text.trim() === '' && !last) continue; // a tool-only or emptied message: nothing to show the model
    const blocks: Block[] = [...echoedReasoning(m, echo), { k: 'text', text }];
    kept.push({ view: m, msg: { role: m.role, blocks, src: HISTORY_SRC } });
  }

  const first = kept[0]?.view;
  return {
    msgs: kept.map((k) => k.msg),
    ids: kept.map((k) => k.view.id),
    greeting: first !== undefined && first.role === 'assistant' && first.gen?.kind === 'greeting',
  };
}
