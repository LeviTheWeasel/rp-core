// Ported from Bunraku:src/core/assembly/continuation.ts (continuationPrefill, continuationAddition)@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shape the assembled request for one model (ARCHITECTURE.md §6.2 step 5, §6.4, D-48). Pure.
// M1a: prefill and continue only. ST post-processing, strict alternation and mid-system as-user
// arrive in M1b; cache_control belongs to adapters (D-48).
// CONTRACT FILE: signatures are fixed; the prompt agent implements the bodies.
//
// Port notes: the prefill/continue decision follows caps.prefill (data), never a regex over the
// model id as RoleCall's prefill-injection does. continuationResult adds suffix-echo stripping and
// the cue-mode blank-line join on top of Bunraku's continuationAddition.

import type { ModelCaps, PromptMsg } from '../providers/types.ts';
import type { Preset } from '../formats/native.ts';
import type { TurnKind } from '../session/entries.ts';
import type { Notice } from '../protocol/events.ts';

export interface ShapeInput {
  messages: PromptMsg[];
  caps: ModelCaps;
  /** Preset prefill decided by assemble (reply/swipe only). */
  prefill: string | null;
  kind: TurnKind;
  postProcessing?: Preset['postProcessing'];
}

export interface ShapeOutput {
  messages: PromptMsg[];
  /** What goes to ModelRequest.prefill. */
  prefill?: string;
  /**
   * continue only. 'prefill' (caps.prefill !== 'none'): the target's text is removed from messages
   * and sent as the prefill; the addition is glued as-is. 'cue': the target stays as an assistant
   * message followed by a user cue; the addition is joined with a blank line.
   */
  continueMode?: 'prefill' | 'cue';
  /** continue only: the target's current text. */
  continueBase?: string;
  notices: Notice[];
}

/** The user cue sent after the target when the model takes no assistant prefill (§6.4). */
export const CONTINUE_CUE =
  'Continue your last reply from exactly where it stopped. Do not repeat what was already written.';

/** PromptMsg.src of the continue cue. */
export const CONTINUE_CUE_SRC = 'continue_cue';

/** The shortest suffix of the base that counts as an echo when the model repeats only the end of it. */
export const ECHO_MIN_SUFFIX = 20;

/** The text of a message: its text blocks in order (reasoning and tool blocks are not reply text). */
export function messageText(m: PromptMsg): string {
  let s = '';
  for (const b of m.blocks) if (b.k === 'text') s += b.text;
  return s;
}

/**
 * The continue target: the last assistant message from history (src 'history' or 'history:…'),
 * else the last assistant message at all. Searching instead of taking messages.at(-1) keeps
 * continue working when blocks follow the history, such as post_history instructions or a depth-0
 * author note. -1 when there is no assistant message.
 */
export function findContinueTarget(messages: readonly PromptMsg[]): number {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    if (m.src === 'history' || m.src.startsWith('history:')) return i;
    if (lastAssistant < 0) lastAssistant = i;
  }
  return lastAssistant;
}

export function shape(input: ShapeInput): ShapeOutput {
  const notices: Notice[] = [];
  const pp = input.postProcessing;
  if (pp !== undefined && pp !== 'none') {
    notices.push({
      level: 'warn',
      code: 'post_processing_m1b',
      message: `Preset post-processing '${pp}' is not applied yet (M1b); messages are sent as assembled.`,
    });
  }
  const acceptsPrefill = input.caps.prefill !== 'none';
  if (input.kind === 'continue') return shapeContinue(input.messages, acceptsPrefill, notices);

  // reply / swipe: assemble already decided the prefill (and its trade-off with tools [D-28]);
  // shape only refuses it for a model that cannot take one.
  const out: ShapeOutput = { messages: [...input.messages], notices };
  if (input.prefill) {
    if (acceptsPrefill) out.prefill = input.prefill;
    else
      notices.push({
        level: 'warn',
        code: 'prefill_unsupported',
        message: 'The model does not accept an assistant prefill; the preset prefill was not sent.',
      });
  }
  return out;
}

/**
 * continue (§6.4). A preset prefill is ignored here: the target's own text is the reply's start.
 * The target must exist (assemble includes it as the last history message); a request without
 * one is a caller bug, so it throws rather than sending a reply turn by mistake.
 */
function shapeContinue(messages: PromptMsg[], acceptsPrefill: boolean, notices: Notice[]): ShapeOutput {
  const t = findContinueTarget(messages);
  if (t < 0) throw new Error('shape: continue needs the target assistant message in messages');
  const base = messageText(messages[t]!);

  if (acceptsPrefill) {
    // The target leaves the list and becomes the prefill, which the adapter sends last: ST's
    // continue-prefill also moves it below anything placed after the history.
    const out: ShapeOutput = {
      messages: messages.filter((_, i) => i !== t),
      continueMode: 'prefill',
      continueBase: base,
      notices,
    };
    // Trailing whitespace is trimmed from what is sent: several providers refuse a final assistant
    // turn ending in whitespace. continueBase keeps it; continuationResult undoes a repeat of it.
    const sent = base.trimEnd();
    if (sent) out.prefill = sent;
    return out;
  }

  const cue: PromptMsg = {
    role: 'user',
    blocks: [{ k: 'text', text: CONTINUE_CUE }],
    src: CONTINUE_CUE_SRC,
    placement: 'inline',
  };
  return { messages: [...messages, cue], continueMode: 'cue', continueBase: base, notices };
}

/**
 * Length of the longest suffix of `base` that `text` starts with, if it is a real echo: at least
 * ECHO_MIN_SUFFIX characters and starting at a word boundary, so a coincidental "the" never counts.
 */
function echoedSuffix(base: string, text: string): number {
  const first = text[0];
  if (first === undefined || /\s/.test(first)) return 0;
  for (let i = 0; i <= base.length - ECHO_MIN_SUFFIX; i++) {
    // Cheap filters before the slice: same first character, word boundary before it.
    if (base[i] !== first || (i > 0 && !/[\s"'“”«»*_(\[]/.test(base[i - 1]!))) continue;
    if (text.startsWith(base.slice(i))) return base.length - i;
  }
  return 0;
}

/** Bunraku's echo strip plus the suffix case: what the model added beyond repeating `base`. */
function stripEcho(base: string, streamed: string): string {
  const trimmed = base.trimEnd();
  const tail = base.slice(trimmed.length);
  let added = streamed;
  if (base && added.startsWith(base)) added = added.slice(base.length);
  else if (trimmed && added.startsWith(trimmed)) added = added.slice(trimmed.length);
  else {
    const k = echoedSuffix(trimmed, added);
    if (k > 0) added = added.slice(k);
  }
  // The model was sent the base without its trailing whitespace; when it sends that again, it is
  // not doubled.
  if (tail && added.startsWith(tail)) added = added.slice(tail.length);
  return added;
}

/**
 * The text actually added by a continue (port of Bunraku core/assembly/continuation.ts
 * continuationAddition): strips an echo of the base at the start of the streamed text; returns ''
 * when nothing new was added. `full` is what the edit commits.
 *
 * An addition of only whitespace counts as nothing new. In cue mode the model starts a fresh turn,
 * so leading whitespace there is dropped and the join is exactly one blank line.
 */
export function continuationResult(
  base: string,
  streamed: string,
  mode: 'prefill' | 'cue',
): { addition: string; full: string } {
  const added = stripEcho(base, mode === 'cue' ? streamed.trimStart() : streamed);
  if (added.trim() === '') return { addition: '', full: base };
  if (mode === 'prefill') return { addition: added, full: base + added };
  const addition = added.trimStart();
  const head = base.trimEnd();
  return { addition, full: head ? `${head}\n\n${addition}` : addition };
}
