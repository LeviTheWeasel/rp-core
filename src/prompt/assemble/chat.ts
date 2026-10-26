// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The chat area of a request (ARCHITECTURE.md §5.5, §5.6, §10.1, §10.4): the path messages from the
// root to `upTo`, as the model reads them. History is inert data: assistant text (greetings too) is
// sent as stored, user text gets identity macros only. Only text blocks are rendered [D-16]:
// reasoning never leaves its turn and tool rounds stay out of later prompts, which keeps the prefix
// stable and never mixes native and prompted tool forms.

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

/** Text blocks only, empty ones dropped; user text through the identity-only macro pass. */
function textBlocks(m: MessageView, run: MacroRun): Block[] {
  const out: Block[] = [];
  for (const b of m.blocks) {
    if (b.k !== 'text' || b.text === '') continue;
    out.push({ k: 'text', text: m.role === 'user' ? run.userText(b.text) : b.text });
  }
  return out;
}

/**
 * The path from the root to `upTo` (inclusive). Hidden messages and messages without text are
 * skipped, except `upTo` itself: it is what the turn is about. Nothing is cut here: the budget and
 * preset.context.maxMessages are one cut in assemble (budget.ts trimHistory), which protects the
 * greeting, keeps the chunk grid and records what it dropped.
 * Throws when `upTo` is not on the path: the engine admits a turn only for a path message.
 */
export function chatArea(view: PathView, upTo: string, run: MacroRun): ChatArea {
  const end = view.path.findIndex((m) => m.id === upTo);
  if (end < 0) throw new Error(`assemble: upTo '${upTo}' is not on the active path`);

  const kept: { view: MessageView; msg: PromptMsg }[] = [];
  for (let i = 0; i <= end; i++) {
    const m = view.path[i]!;
    const last = i === end;
    if (m.hidden && !last) continue;
    const blocks = textBlocks(m, run);
    const blank = blocks.every((b) => b.k === 'text' && b.text.trim() === '');
    if (blank && !last) continue; // a tool-only or emptied message: nothing to show the model
    kept.push({ view: m, msg: { role: m.role, blocks: blocks.length > 0 ? blocks : [{ k: 'text', text: '' }], src: HISTORY_SRC } });
  }

  const first = kept[0]?.view;
  return {
    msgs: kept.map((k) => k.msg),
    ids: kept.map((k) => k.view.id),
    greeting: first !== undefined && first.role === 'assistant' && first.gen?.kind === 'greeting',
  };
}
