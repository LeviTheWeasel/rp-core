// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Pure prompt assembly (ARCHITECTURE.md §6.2 step 4, §10.2, §10.4, §11). No I/O, clock and seed
// come in. Bunraku src/core/assembly is the reference (§19.3); written to the core's contract.
// CONTRACT FILE: signatures are fixed; the prompt agent implements the body.
//
// One pass, in this order: validate the preset → one MacroRun → every enabled block expanded once,
// in preset order (card overrides and formats applied first, structural slots kept out of the macro
// engine) → card depth note, author's note, guidance → the prefill rule [D-28] → the chat area →
// the budget [D-49] → depth inserts → the trace. Taken from Bunraku: the step order, the history
// block split around its marker, one trace row per sent message, loud preset errors. Not taken:
// RoleCall's several macro passes, stripping of unknown macros, macro expansion of history, the
// character prompt reserve that is never sent, the 60 % pre-trim (§19.3 "Не переносить").

import type { Character, LoreBook, Persona, Preset, PresetBlock } from '../formats/native.ts';
import { validatePreset } from '../formats/native.ts';
import type { ModelCaps, PromptMsg, ToolSpec } from '../providers/types.ts';
import type { SessionConfig, Trace, TurnKind, VarsDiff } from '../session/entries.ts';
import type { PathView } from '../session/view.ts';
import type { Notice } from '../protocol/events.ts';
import type { DepthInsert } from './depth.ts';
import { injectAtDepth } from './depth.ts';
import { trimHistory } from './budget.ts';
import { createMacroRun, type MacroEnv, type MacroRun } from './macros.ts';
import { estimateMessage, estimateMessages, estimateTokens, MESSAGE_OVERHEAD_TOKENS } from './tokens.ts';
import { chatArea, HISTORY_SRC } from './assemble/chat.ts';
import { guidanceText } from './assemble/guidance.ts';
import { presetHash } from './assemble/hash.ts';
import {
  applyFormat,
  fillSlots,
  formatExamples,
  historySlots,
  protectSlots,
  renderSlot,
  slotScope,
  soleMacro,
  splitAtHistory,
  type SlotRef,
} from './assemble/slots.ts';

export { presetHash } from './assemble/hash.ts';
export { HISTORY_SRC } from './assemble/chat.ts';
export { guidanceText, REJECTED_DRAFT_LABEL } from './assemble/guidance.ts';

export interface AssembleInput {
  sessionId: string;
  view: PathView;
  /**
   * Last path message included in the history: reply → the user message U; swipe → U (the
   * replaced answer is excluded); continue → the answer A being continued (included, last).
   */
  upTo: string;
  kind: TurnKind;
  cast: { character: Character; persona?: Persona };
  preset: Preset;
  /** Ignored before M2 (lore engine). */
  lorebooks: LoreBook[];
  /** Agent inserts (Director, Compendium). [] in M1a. */
  placements: DepthInsert[];
  authorNote?: SessionConfig['authorNote'];
  /** Guided re-roll: rendered as one system block at depth 0, src 'guidance' [D-41]. */
  guidance?: { text: string; rejected?: string };
  caps: ModelCaps;
  window: number;
  reserve: number;
  seed: number;
  now: string;
  timeZone: string;
  /** Narrator tools offered this turn ([] in M1a). */
  tools: ToolSpec[];
  prefillVsTools: 'prefill' | 'tools';
}

export type AssembleResult =
  | {
      ok: true;
      messages: PromptMsg[];
      /** Tools actually offered (may be [] when the prefill rule turned them off [D-28]). */
      tools: ToolSpec[];
      /** The preset prefill to send, or null. Never set together with tools. */
      prefill: string | null;
      trace: Trace;
      varsDiff: VarsDiff;
      notices: Notice[];
    }
  | { ok: false; code: 'context_length_exceeded' | 'preset_invalid'; message: string };

// ---- preset plan --------------------------------------------------------------------------------

interface PlannedBlock {
  block: PresetBlock;
  /** The template to expand: the card's text when an override applies, else the block's content. */
  text: string;
  /** What {{original}} expands to; set only when an override applied. */
  original?: string;
  /** This block holds the {{history}} slot. */
  history: boolean;
}

/** The card text an override block takes [D-21], or undefined when the block keeps its own. */
function overrideText(block: PresetBlock, character: Character): string | undefined {
  const card =
    block.override === 'card_system' ? character.systemPrompt : block.override === 'card_post_history' ? character.postHistory : undefined;
  return card !== undefined && card.trim() !== '' ? card : undefined;
}

/**
 * ST's personality_format / scenario_format [D-70]: a block that is exactly the card slot gets the
 * format as its template, with `{0}` standing for the field, when the field is non-empty. ST-style
 * formats that name the macro themselves (`[{{char}}'s personality: {{personality}}]`) work as is.
 */
function withFieldFormat(text: string, preset: Preset, character: Character): string {
  const slot = soleMacro(text);
  if (slot === 'personality' && character.personality?.trim() && preset.formats?.personality) {
    return applyFormat(preset.formats.personality, '{{personality}}');
  }
  if (slot === 'scenario' && character.scenario?.trim() && preset.formats?.scenario) {
    return applyFormat(preset.formats.scenario, '{{scenario}}');
  }
  return text;
}

/**
 * Enabled blocks in preset order with their effective templates, or the reason the preset cannot be
 * laid out. validatePreset already counts slots with the same lexer (historySlots); the count is
 * repeated here to find the block holding the slot (a cheap guard as well), which must be placed
 * relative (the chat area sits between the relative blocks, so a pinned or in-chat history has no
 * meaning).
 */
function planPreset(preset: Preset, character: Character): PlannedBlock[] | string {
  const enabled = preset.blocks.filter((b) => b.enabled);
  const counts = enabled.map((b) => historySlots(b.content));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== 1) {
    return `preset '${preset.name}': expected exactly one {{history}} slot outside other macros in an enabled block, found ${total}`;
  }
  const holder = enabled[counts.indexOf(1)]!;
  if (holder.at !== 'relative') {
    return `preset '${preset.name}': the {{history}} block '${holder.id}' must be placed 'relative'`;
  }
  return enabled.map((block) => {
    const history = block === holder;
    // The history block is never overridden: a card text without {{original}} would delete the chat.
    const card = history || preset.forbidOverrides ? undefined : overrideText(block, character);
    if (card !== undefined) return { block, text: card, original: block.content, history };
    return { block, text: withFieldFormat(block.content, preset, character), history };
  });
}

// ---- macro environment --------------------------------------------------------------------------

function macroEnv(input: AssembleInput): MacroEnv {
  const { character, persona } = input.cast;
  return {
    char: character.name,
    user: persona?.name || 'User',
    card: {
      description: character.description ?? '',
      personality: character.personality ?? '',
      scenario: character.scenario ?? '',
      examples: formatExamples(character.examples ?? '', input.preset.formats?.newExampleChat),
      systemPrompt: character.systemPrompt ?? '',
      postHistory: character.postHistory ?? '',
      firstMessage: character.greetings[0] ?? '',
    },
    persona: persona?.description ?? '',
    vars: input.view.vars,
    now: input.now,
    timeZone: input.timeZone,
    seed: input.seed,
    sessionId: input.sessionId,
  };
}

/**
 * Values of the non-history slots. M1a has none to give: lore arrives in M2, the director slot in M4,
 * {{recap}} in M5. renderSlot already applies wi_format to whatever a later milestone puts here.
 */
function slotValue(ref: SlotRef, preset: Preset): string {
  const value = ''; // M2/M4/M5: lore::x, outlet::x, slot::director, recap
  return ref.kind === 'history' ? '' : renderSlot(ref, value, preset.formats);
}

// ---- blocks → messages --------------------------------------------------------------------------

interface Layout {
  top: PromptMsg[];
  before: PromptMsg[];
  after: PromptMsg[];
  bottom: PromptMsg[];
  depth: DepthInsert[];
}

/**
 * PromptMsg.src of a preset block: its id, unless the id would pass for a chat message ('history'
 * is the builtin history block's id, and shape.findContinueTarget keys on that src).
 */
export function blockSrc(id: string): string {
  return id === HISTORY_SRC || id.startsWith(`${HISTORY_SRC}:`) ? `block:${id}` : id;
}

const blockMsg = (block: PresetBlock, text: string): PromptMsg => ({
  role: block.role,
  blocks: [{ k: 'text', text }],
  src: blockSrc(block.id),
  placement: 'inline',
});

/** Expand every planned block once, in preset order (later blocks see earlier setvars), and sort it into place. */
function layoutBlocks(plan: PlannedBlock[], run: MacroRun, preset: Preset): Layout {
  const out: Layout = { top: [], before: [], after: [], bottom: [], depth: [] };
  let pastHistory = false;

  for (const p of plan) {
    // Slots are numbered per block, in the block's own scope: what the macro engine sees of a block
    // (and so its {{pick}} seed, D-43) never changes when another block is added or toggled.
    const refs: SlotRef[] = [];
    const scope = slotScope(p.block.id);
    const fill = (text: string): string => fillSlots(text, refs, (ref) => slotValue(ref, preset), scope);
    const text = protectSlots(p.text, refs, scope);
    const original = p.original === undefined ? undefined : protectSlots(p.original, refs, scope);
    const expanded = run.block(text, p.block.id, original === undefined ? undefined : { original });

    if (p.history) {
      // Text around the slot becomes its own message on either side of the chat (as Bunraku splits
      // around its marker); the planner guarantees the slot is there, the fallback is defensive.
      const [head, tail] = splitAtHistory(expanded, refs, scope) ?? [expanded, ''];
      const lead = fill(head).trimEnd();
      const rest = fill(tail).trimStart();
      if (lead.trim() !== '') out.before.push(blockMsg(p.block, lead));
      if (rest.trim() !== '') out.after.push(blockMsg(p.block, rest));
      pastHistory = true;
      continue;
    }

    const filled = fill(expanded);
    if (filled.trim() === '') continue; // a block that expands to nothing is not sent
    const at = p.block.at;
    if (typeof at === 'object') {
      out.depth.push({ depth: at.depth, order: at.order, role: p.block.role, src: 'preset', srcId: p.block.id, text: filled });
    } else if (at === 'top') out.top.push(blockMsg(p.block, filled));
    else if (at === 'bottom') out.bottom.push(blockMsg(p.block, filled));
    else (pastHistory ? out.after : out.before).push(blockMsg(p.block, filled));
  }
  return out;
}

// ---- prefill rule [D-28] ------------------------------------------------------------------------

interface PrefillDecision {
  prefill: string | null;
  tools: ToolSpec[];
  trace: Trace['prefill'];
  notices: Notice[];
}

function decidePrefill(input: AssembleInput, run: MacroRun): PrefillDecision {
  // continue: the target's own text is the prefill (shape.ts), never the preset's; no tools either (§6.4).
  if (input.kind === 'continue') return { prefill: null, tools: [], trace: null, notices: [] };
  const raw = input.preset.prefill;
  const text = raw === undefined || raw === '' ? '' : run.block(raw, 'prefill');
  if (text.trim() === '') return { prefill: null, tools: input.tools, trace: null, notices: [] };

  if (input.caps.prefill === 'none') {
    return {
      prefill: null,
      tools: input.tools,
      trace: 'unsupported',
      notices: [{ level: 'warn', code: 'prefill_unsupported', message: 'The preset prefill was not sent: this model takes no assistant prefill.' }],
    };
  }
  if (input.tools.length > 0 && input.prefillVsTools === 'prefill') {
    return {
      prefill: text,
      tools: [],
      trace: 'tools_off',
      notices: [
        { level: 'info', code: 'prefill_disables_tools', message: "The preset has a prefill, so the narrator's tools are off this turn (narrator.prefillVsTools = 'prefill')." },
      ],
    };
  }
  if (input.tools.length > 0) {
    return {
      prefill: null,
      tools: input.tools,
      trace: 'skipped_for_tools',
      notices: [
        { level: 'info', code: 'prefill_skipped_for_tools', message: "The preset prefill was skipped so the narrator's tools stay on (narrator.prefillVsTools = 'tools')." },
      ],
    };
  }
  return { prefill: text, tools: input.tools, trace: 'sent', notices: [] };
}

/**
 * How many newest chat messages the budget never cuts (§11: the current user message): the one the
 * turn is about, and on continue also the user message the answer A replies to, so the model never
 * continues A without what it answers.
 */
function protectedTail(input: AssembleInput, ids: readonly string[]): number {
  if (input.kind !== 'continue') return 1;
  const parent = input.view.path.find((m) => m.id === input.upTo)?.parent ?? null;
  const at = parent === null ? -1 : ids.lastIndexOf(parent);
  return at >= 0 ? ids.length - at : 1;
}

// ---- the trace of what is sent ------------------------------------------------------------------

/** trace.tokens.estimated and trace.blocks of a message list (§5.7: blocks are 1:1 with it). */
function sentRows(messages: readonly PromptMsg[]): Pick<Trace, 'tokens' | 'blocks'> {
  return {
    tokens: { estimated: estimateMessages(messages) },
    blocks: messages.map((m) => ({ src: m.src, role: m.role, tok: estimateMessage(m) })),
  };
}

/**
 * The trace of the messages actually sent. shape() may drop a message (a continue target sent as
 * the prefill) or add one (the continue cue), so the engine re-derives the rows from its output.
 * A reported token count already on the trace is kept.
 */
export function traceForSent(trace: Trace, messages: readonly PromptMsg[]): Trace {
  const rows = sentRows(messages);
  return { ...trace, blocks: rows.blocks, tokens: { ...trace.tokens, estimated: rows.tokens.estimated } };
}

// ---- the assembler ------------------------------------------------------------------------------

export function assemble(input: AssembleInput): AssembleResult {
  const checked = validatePreset(input.preset);
  if (!checked.ok) {
    return { ok: false, code: 'preset_invalid', message: checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ') };
  }
  const preset = input.preset;
  const { character } = input.cast;
  const plan = planPreset(preset, character);
  if (typeof plan === 'string') return { ok: false, code: 'preset_invalid', message: plan };

  // One run for the whole request: variables set by one block are visible to the blocks after it.
  const run = createMacroRun(macroEnv(input));
  const layout = layoutBlocks(plan, run, preset);

  // ST's new_chat_prompt opens the chat area; it is not a chat message, so depths do not count it.
  const newChatText = preset.formats?.newChat ? run.block(preset.formats.newChat, 'new_chat') : '';
  const newChat: PromptMsg[] =
    newChatText.trim() === '' ? [] : [{ role: 'system', blocks: [{ k: 'text', text: newChatText }], src: 'new_chat', placement: 'inline' }];

  // Inserts in source order; injectAtDepth sorts them by depth, order and source rank (§10.1).
  const inserts: DepthInsert[] = [...layout.depth];
  const dp = character.depthPrompt;
  if (dp && dp.text.trim() !== '') {
    inserts.push({ depth: dp.depth, role: dp.role, src: 'card_depth', text: run.block(dp.text, 'card_depth') });
  }
  const note = input.authorNote;
  if (note && note.text.trim() !== '') {
    inserts.push({ depth: note.depth, role: note.role, src: 'author_note', text: run.block(note.text, 'author_note') });
  }
  inserts.push(...input.placements);
  const g = input.guidance;
  if (g && g.text.trim() !== '') {
    // The direction is user-typed (identity macros only); the rejected draft is model output (inert).
    inserts.push({ depth: 0, role: 'system', src: 'guidance', text: guidanceText(run.userText(g.text), g.rejected) });
  }

  const prefill = decidePrefill(input, run);
  const chat = chatArea(input.view, input.upTo, run);

  // Budget (§11, D-49): everything but the older history is mandatory. The protected tail is the
  // message the turn is about (U; on continue the answer A and the U it replies to); the protected
  // head is the greeting. preset.context.maxMessages is applied by the same cut: same grid, same
  // protections, recorded in trace.trimmed.
  const available = input.window - input.reserve;
  const fixed =
    estimateMessages(layout.top) +
    estimateMessages(layout.before) +
    estimateMessages(newChat) +
    estimateMessages(injectAtDepth([], inserts)) + // every non-blank insert, measured as it will be sent
    estimateMessages(layout.after) +
    estimateMessages(layout.bottom) +
    (prefill.prefill === null ? 0 : estimateTokens(prefill.prefill) + MESSAGE_OVERHEAD_TOKENS);
  const sized = chat.msgs.map((m, i) => ({ id: chat.ids[i]!, tok: estimateMessage(m) }));
  const head = chat.greeting ? 1 : 0;
  const tail = Math.min(protectedTail(input, chat.ids), Math.max(0, sized.length - head));
  const maxKept = preset.context?.maxMessages;
  const cut = trimHistory(sized, available - fixed, { protectedHead: head, protectedTail: tail, ...(maxKept !== undefined ? { maxKept } : {}) });
  if (!cut.fits) {
    const greetingTok = sized.slice(0, head).reduce((a, s) => a + s.tok, 0);
    const tailTok = sized.slice(sized.length - tail).reduce((a, s) => a + s.tok, 0);
    const need = fixed + greetingTok + tailTok;
    return {
      ok: false,
      code: 'context_length_exceeded',
      message: `the required part of the prompt needs about ${need} tokens, but only ${Math.max(0, available)} are available (window ${input.window} - reply reserve ${input.reserve})`,
    };
  }
  const kept = [...chat.msgs.slice(0, head), ...chat.msgs.slice(cut.keepFrom)];

  // The leading system run of the preset is the head the adapters send as the system prompt.
  const lead = [...layout.top, ...layout.before];
  for (const m of lead) {
    if (m.role !== 'system') break;
    m.placement = 'head';
  }
  // A continue sent with a prefill: the target A leaves the chat and becomes the prefill (shape.ts),
  // so depths are counted without it (§10.1 "префилл continue не считается"; ST displaces the
  // continued message before its in-chat injections). A is put back after the chat for shape to take.
  // In cue mode A is a real message and counts like any other.
  const displaced = input.kind === 'continue' && input.caps.prefill !== 'none' ? kept.pop() : undefined;
  const chatPart = [...injectAtDepth(kept, inserts), ...(displaced ? [displaced] : [])];
  const messages: PromptMsg[] = [...lead, ...newChat, ...chatPart, ...layout.after, ...layout.bottom];

  const trace: Trace = {
    seed: input.seed,
    now: input.now,
    window: input.window,
    reserve: input.reserve,
    ...sentRows(messages),
    lore: { fired: [], cut: [], budget: 0 },
    recap: { ids: [], arcs: [], boundary: null },
    prefill: prefill.trace,
    macros: { unknown: run.unknown() },
    trimmed: cut.trimmed,
    calls: [],
    agents: {},
    presetHash: presetHash(preset),
    loreHashes: {},
  };

  return {
    ok: true,
    messages,
    tools: prefill.tools,
    prefill: prefill.prefill,
    trace,
    varsDiff: run.varsDiff(),
    notices: prefill.notices,
  };
}
