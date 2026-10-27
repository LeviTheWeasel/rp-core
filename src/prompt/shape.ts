// Ported from Bunraku:src/core/assembly/continuation.ts (continuationPrefill, continuationAddition)@702d8120
// and Bunraku:src/stage/provider/transport-core.ts (mergePostProcessing, applyRolePostProcessing)@702d8120,
// which follows SillyTavern src/prompt-converters.js mergeMessages (checked against SillyBunny@3021edcae).
// Copyright (C) 2026 Coneja-Chibi; SillyTavern parts Copyright (C) the SillyTavern contributors;
// changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shape the assembled request for one model (ARCHITECTURE.md §6.2 step 5, §6.4, §8.5, D-48). Pure.
// Everything that does not depend on the wire dialect: the prefill decision and the continue tail
// (M1a), then SillyTavern's prompt post-processing (Preset.postProcessing), then the capability
// rules — mid-dialogue system messages as user notes for 'as-user' models and merging same-role
// neighbours for 'strict' alternation (M1b). The leading system run, §8.5 placement for
// 'anthropic-native' and cache_control belong to the adapters (D-48).
// CONTRACT FILE: signatures are fixed; the prompt agent implements the bodies.
//
// Port notes: the prefill/continue decision follows caps.prefill (data), never a regex over the
// model id as RoleCall's prefill-injection does. continuationResult adds suffix-echo stripping and
// the cue-mode blank-line join on top of Bunraku's continuationAddition. Post-processing keeps ST's
// modes and placeholder but is block-aware [D-48]: a message carrying tool calls, tool results,
// reasoning or a replay payload is never merged or re-roled (ST and RoleCall turn tool messages
// into user text and drop tool_calls), messages of different placement never merge, and a blank
// message merges like any other instead of ST's "an empty message starts a new one" quirk. M3: the
// one exception is a history answer carrying only text and its raw reasoning (the DeepSeek echo,
// §8.4): it still merges with a neighbouring answer, reasoning kept in order, never re-roled.

import type { ModelCaps, PromptMsg } from '../providers/types.ts';
import type { Preset } from '../formats/native.ts';
import type { Block, TurnKind } from '../session/entries.ts';
import type { Notice } from '../protocol/events.ts';

export interface ShapeInput {
  messages: PromptMsg[];
  caps: ModelCaps;
  /** Preset prefill decided by assemble (reply/swipe only). */
  prefill: string | null;
  kind: TurnKind;
  postProcessing?: Preset['postProcessing'];
  /**
   * M1b, optional: speaker names for 'single' post-processing. ST prefixes "Char: " and "User: " to
   * the dialogue when it folds everything into one user message, so the model can still tell who
   * spoke; without names the dialogue is joined unprefixed.
   */
  names?: { char: string; user: string };
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
  const acceptsPrefill = input.caps.prefill !== 'none';

  // 1. The prefill and the continue tail, on the messages exactly as assembled: the target is found
  //    by its history src before any merge renames it.
  let out: ShapeOutput;
  if (input.kind === 'continue') out = shapeContinue(input.messages, acceptsPrefill, notices);
  else {
    // reply / swipe: assemble already decided the prefill (and its trade-off with tools [D-28]);
    // shape only refuses it for a model that cannot take one.
    out = { messages: [...input.messages], notices };
    if (input.prefill) {
      if (acceptsPrefill) out.prefill = input.prefill;
      else
        notices.push({
          level: 'warn',
          code: 'prefill_unsupported',
          message: 'The model does not accept an assistant prefill; the preset prefill was not sent.',
        });
    }
  }

  // 2. The preset's post-processing, then 3. the capability rules (D-48: in that order). The continue
  //    cue is part of the dialogue by then, so it is merged like any other user message.
  const pp = postProcess(out.messages, input.postProcessing, input.names);
  notices.push(...pp.notices);
  out.messages = applyCapsRules(pp.messages, input.caps);
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

// ---- merging, block-aware [D-48] ----------------------------------------------------------------

/**
 * A message shaping must leave exactly as it is: a tool message, one carrying anything but text
 * (tool calls, tool results, reasoning, a block kind from a newer core) or a verbatim replay
 * payload. Merging would lose the second message's calls (RoleCall's merge does), re-roling would
 * make a tool call or a signed reasoning block invalid.
 */
export function isFixedMessage(m: PromptMsg): boolean {
  if (m.role === 'tool') return true;
  if (m.replay !== undefined && m.replay.length > 0) return true;
  return m.blocks.some((b) => b.k !== 'text');
}

/** 'head' (the leading system run the adapter sends as the system prompt) or 'inline'; unset is inline. */
function placementOf(m: PromptMsg): 'head' | 'inline' {
  return m.placement === 'head' ? 'head' : 'inline';
}

/** A raw reasoning block (the model's own text, not a summary or a redaction). */
const isRawReasoning = (b: Block): b is Extract<Block, { k: 'reasoning' }> => b.k === 'reasoning' && (b.kind === undefined || b.kind === 'raw');

/**
 * M3 (§8.4, D-94): a history answer carrying the DeepSeek echo, i.e. a chat message (src 'history')
 * from the assistant whose only blocks besides text are raw reasoning, with no replay payload. Such
 * messages still merge with a neighbouring answer (their reasoning kept in order): DeepSeek refuses
 * successive assistant turns, and a hidden user message between two answers would otherwise leave
 * them apart. Messages of the tool loop itself stay fixed.
 */
function isEchoAnswer(m: PromptMsg): boolean {
  if (m.role !== 'assistant' || !isHistory(m) || (m.replay !== undefined && m.replay.length > 0)) return false;
  return m.blocks.every((b) => b.k === 'text' || isRawReasoning(b));
}

/** Two messages may become one: both plain text (or echo answers), same role, same placement. */
function canMerge(a: PromptMsg, b: PromptMsg): boolean {
  const mergeable = (m: PromptMsg): boolean => !isFixedMessage(m) || isEchoAnswer(m);
  return a.role === b.role && mergeable(a) && mergeable(b) && placementOf(a) === placementOf(b);
}

/** ST's join: a blank line between the parts. A blank part adds nothing (and no separator). */
function joinText(a: string, b: string): string {
  if (b.trim() === '') return a.trim() === '' ? a + b : a;
  if (a.trim() === '') return b;
  return `${a}\n\n${b}`;
}

/** A plain text message (the shape every merge or rewrite produces). Keeps the placement when set. */
function textMsg(role: PromptMsg['role'], text: string, src: string, placement: PromptMsg['placement']): PromptMsg {
  const m: PromptMsg = { role, blocks: [{ k: 'text', text }], src };
  if (placement !== undefined) m.placement = placement;
  return m;
}

/**
 * `a` and `b` as one message: a's role and placement, the texts joined with a blank line, the
 * sources joined with '+' so the trace row still names every block that went into it.
 */
function merged(a: PromptMsg, b: PromptMsg): PromptMsg {
  const out = textMsg(a.role, joinText(messageText(a), messageText(b)), `${a.src}+${b.src}`, a.placement ?? b.placement);
  // Echo answers (M3): the reasoning of both, in order, before the joined text.
  const reasoning = [...a.blocks, ...b.blocks].filter(isRawReasoning);
  if (reasoning.length > 0) out.blocks = [...reasoning, ...out.blocks];
  return out;
}

/** `m` under another role. A message that stops being system leaves the head (placement 'inline'). */
function reRoled(m: PromptMsg, role: PromptMsg['role']): PromptMsg {
  if (m.role === role) return m;
  const out: PromptMsg = { ...m, role };
  if (m.placement === 'head') out.placement = 'inline';
  return out;
}

/**
 * Merge every run of consecutive messages that canMerge, from index `from` on (earlier messages
 * are copied as they are). Untouched messages keep their identity.
 */
function squash(messages: readonly PromptMsg[], from = 0): PromptMsg[] {
  const out: PromptMsg[] = messages.slice(0, from);
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]!;
    const last = out.length > from ? out[out.length - 1] : undefined;
    if (last !== undefined && canMerge(last, m)) out[out.length - 1] = merged(last, m);
    else out.push(m);
  }
  return out;
}

// ---- SillyTavern post-processing [D-48] ---------------------------------------------------------

/** What SillyTavern (promptPlaceholder) and RoleCall insert when a mode needs a user turn that is missing. */
export const POST_PROCESSING_PLACEHOLDER = "Let's get started.";

/** PromptMsg.src of that placeholder. */
export const POST_PROCESSING_PLACEHOLDER_SRC = 'pp_placeholder';

const placeholder = (): PromptMsg => textMsg('user', POST_PROCESSING_PLACEHOLDER, POST_PROCESSING_PLACEHOLDER_SRC, 'inline');

/** A chat message (src 'history' or 'history:…'): only those carry a speaker's words. */
const isHistory = (m: PromptMsg): boolean => m.src === 'history' || m.src.startsWith('history:');

/**
 * ST's 'single' speaker prefix: "Name: text" unless the text already starts with it. Only chat
 * messages get one (ST also prefixes user-role preset blocks, which turns an instruction into a
 * line the persona never said).
 */
function withSpeaker(m: PromptMsg, names: ShapeInput['names']): PromptMsg {
  if (names === undefined || !isHistory(m) || isFixedMessage(m)) return m;
  const name = m.role === 'assistant' ? names.char : m.role === 'user' ? names.user : '';
  const text = messageText(m);
  if (!name || text.startsWith(`${name}: `)) return m;
  return textMsg(m.role, `${name}: ${text}`, m.src, m.placement);
}

/**
 * SillyTavern's prompt post-processing (prompt-converters.js mergeMessages), over PromptMsg blocks:
 * - 'merge': consecutive same-role messages become one, joined with a blank line;
 * - 'semi': merge, then every system message but the first becomes user, then merge again;
 * - 'strict': semi, and the first message after a leading system message must be user: ST's
 *   placeholder user message ("Let's get started.") is inserted when it is not;
 * - 'single': every message becomes user (chat lines prefixed with the speaker when names are
 *   given) and everything is merged into one;
 * - 'none' / unset: unchanged.
 * Tool-carrying messages are left in place with their role (isFixedMessage) and messages of
 * different placement never merge. An empty list becomes the placeholder, as in ST. Notices only
 * for the unusual: an unknown mode, a merge a tool message blocked, an empty request.
 */
export function postProcess(
  messages: readonly PromptMsg[],
  mode: Preset['postProcessing'] | undefined,
  names?: ShapeInput['names'],
): { messages: PromptMsg[]; notices: Notice[] } {
  const notices: Notice[] = [];
  if (mode === undefined || mode === 'none') return { messages: [...messages], notices };
  if (mode !== 'merge' && mode !== 'semi' && mode !== 'strict' && mode !== 'single') {
    notices.push({
      level: 'warn',
      code: 'post_processing_unknown',
      message: `Unknown preset post-processing '${String(mode)}'; messages are sent as assembled.`,
    });
    return { messages: [...messages], notices };
  }

  let list: PromptMsg[] = [...messages];
  if (mode === 'single') list = list.map((m) => (isFixedMessage(m) ? m : reRoled(withSpeaker(m, names), 'user')));
  list = squash(list);

  if (mode !== 'merge') {
    // Only the first message may stay system (ST: "force mid-prompt system messages to be user").
    list = list.map((m, i) => (i > 0 && m.role === 'system' && !isFixedMessage(m) ? reRoled(m, 'user') : m));
    if (mode === 'strict' && list.length > 0) {
      const first = list[0]!;
      if (first.role === 'system' && (list.length === 1 || list[1]!.role !== 'user')) list.splice(1, 0, placeholder());
      else if (first.role !== 'system' && first.role !== 'user') list.unshift(placeholder());
    }
    // Re-roling makes new same-role neighbours; ST merges once more.
    list = squash(list);
  }

  if (list.length === 0) {
    list.push(placeholder());
    notices.push({
      level: 'info',
      code: 'post_processing_placeholder',
      message: `The request had no messages; post-processing '${mode}' sent ST's placeholder user message.`,
    });
  }

  const blocked = blockedMerges(list);
  if (blocked > 0 || (mode === 'single' && list.length > 1)) {
    notices.push({
      level: 'info',
      code: 'post_processing_partial',
      message:
        mode === 'single'
          ? `Post-processing 'single' left ${list.length} messages: messages carrying tool calls, tool results or reasoning are never merged.`
          : `Post-processing '${mode}' left ${blocked} same-role neighbour(s) unmerged: messages carrying tool calls, tool results or reasoning are never merged.`,
    });
  }
  return { messages: list, notices };
}

/** Same-role neighbours left apart only because one of them is fixed (tool messages among themselves are normal). */
function blockedMerges(list: readonly PromptMsg[]): number {
  let n = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!;
    const b = list[i]!;
    if (a.role === b.role && a.role !== 'tool' && (isFixedMessage(a) || isFixedMessage(b))) n++;
  }
  return n;
}

// ---- capability rules (§8.5 generic path, D-48) -------------------------------------------------

/** The prefix a mid-dialogue system message carries once it travels as user text (§8.5). */
export const SYSTEM_NOTE_PREFIX = '[System note] ';

/** Length of the leading system run: the messages before the first non-system one. Left for the adapter. */
export function leadingSystemRun(messages: readonly PromptMsg[]): number {
  let i = 0;
  while (i < messages.length && messages[i]!.role === 'system') i++;
  return i;
}

/**
 * The capability rules, after post-processing (D-48):
 * - caps.midSystem 'as-user': every system message after the leading system run travels as user
 *   text (midSystemAsUser);
 * - caps.alternation 'strict': consecutive same-role messages after the leading run are merged.
 * 'native' and 'anthropic-native' mid-system and free alternation leave the list as it is (the
 * Anthropic placement rule of §8.5 is the adapter's, M7).
 */
export function applyCapsRules(messages: readonly PromptMsg[], caps: ModelCaps): PromptMsg[] {
  let list: PromptMsg[] = [...messages];
  if (caps.midSystem === 'as-user') list = midSystemAsUser(list);
  if (caps.alternation === 'strict') list = squash(list, leadingSystemRun(list));
  return list;
}

/** Notes waiting for the next user message: each group is one run of adjacent system messages. */
interface NoteGroup {
  text: string;
  src: string;
}

/**
 * The generic 'as-user' path of §8.5 for routers and models without mid-dialogue system:
 * adjacent system messages after the leading run are merged into one note first (so a second
 * note never lands after the first), the note's text gets SYSTEM_NOTE_PREFIX and it is merged
 * into the nearest following user message, in front of its text; when no user message follows,
 * or the one that follows carries tool results, it is appended to the nearest previous user
 * message after the leading run; when there is none either, it stays a user message of its own
 * at its place. Blank notes are dropped. Tool-carrying messages are never touched.
 */
export function midSystemAsUser(messages: readonly PromptMsg[]): PromptMsg[] {
  const lead = leadingSystemRun(messages);
  const out: PromptMsg[] = messages.slice(0, lead);
  let pending: NoteGroup[] = [];
  let prevWasNote = false;

  for (let i = lead; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'system' && !isFixedMessage(m)) {
      const text = messageText(m);
      const last = pending.at(-1);
      // A run of adjacent notes is one note (§8.5 step 1); a blank one adds nothing.
      if (prevWasNote && last !== undefined) {
        last.text = joinText(last.text, text);
        last.src = `${last.src}+${m.src}`;
      } else pending.push({ text, src: m.src });
      prevWasNote = true;
      continue;
    }
    prevWasNote = false;
    if (pending.length > 0 && m.role === 'user') {
      if (!isFixedMessage(m)) {
        const notes = noteText(pending);
        out.push(notes === null ? m : textMsg('user', joinText(notes.text, messageText(m)), `${notes.src}+${m.src}`, m.placement));
        pending = [];
        continue;
      }
      // The next user turn carries tool results: the note goes back to the previous one instead.
      flushBackward(out, lead, pending);
      pending = [];
    }
    out.push(m);
  }
  if (pending.length > 0) flushBackward(out, lead, pending);
  return out;
}

/** The pending groups as one prefixed text, or null when they are all blank. */
function noteText(groups: readonly NoteGroup[]): NoteGroup | null {
  const live = groups.filter((g) => g.text.trim() !== '');
  if (live.length === 0) return null;
  return {
    text: live.map((g) => SYSTEM_NOTE_PREFIX + g.text).join('\n\n'),
    src: live.map((g) => g.src).join('+'),
  };
}

/** Append the notes to the nearest previous mergeable user message after the lead, else add them as their own user message. */
function flushBackward(out: PromptMsg[], lead: number, groups: readonly NoteGroup[]): void {
  const notes = noteText(groups);
  if (notes === null) return;
  for (let k = out.length - 1; k >= lead; k--) {
    const u = out[k]!;
    if (u.role !== 'user') continue;
    if (isFixedMessage(u)) break; // never write into a tool-result turn; keep the note at its place
    out[k] = textMsg('user', joinText(messageText(u), notes.text), `${u.src}+${notes.src}`, u.placement);
    return;
  }
  out.push(textMsg('user', notes.text, notes.src, 'inline'));
}

// ---- continue result ----------------------------------------------------------------------------

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
