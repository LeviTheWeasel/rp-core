// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Pure prompt assembly (ARCHITECTURE.md §6.2 step 4, §10.2, §10.4, §11). No I/O, clock and seed
// come in. Bunraku src/core/assembly is the reference (§19.3); written to the core's contract.
// CONTRACT FILE: signatures are fixed; the prompt agent implements the body.
//
// One pass, in this order: validate the preset → one MacroRun → the lore run (M2: entries expanded
// in it, placed by lore/place.ts) → every enabled block expanded once, in preset order (card
// overrides and formats applied first, structural slots kept out of the macro engine, lore filling
// its slots) → card depth note, author's note (with AN-positioned lore), guidance → the prefill
// rule [D-28] → the chat area → the budget [D-49] → depth inserts → the trace. Taken from Bunraku:
// the step order, the history block split around its marker, one trace row per sent message, loud
// preset errors. Not taken: RoleCall's several macro passes, stripping of unknown macros, macro
// expansion of history, the character prompt reserve that is never sent, the 60 % pre-trim (§19.3
// "Не переносить").

import type { Character, Persona, Preset, PresetBlock } from '../formats/native.ts';
import { entryLabel, type LoreRunResult, type LoreSource, type LoreVerdict } from '../lore/engine.ts';
import type { LorePlacement } from '../lore/place.ts';
import { validatePreset } from '../formats/native.ts';
import type { ModelCaps, PromptMsg, ToolSpec } from '../providers/types.ts';
import type { SessionConfig, Trace, TurnKind, VarsDiff } from '../session/entries.ts';
import type { PathView } from '../session/view.ts';
import type { Notice } from '../protocol/events.ts';
import type { DepthInsert } from './depth.ts';
import { injectAtDepth } from './depth.ts';
import { loreBudget, trimHistory } from './budget.ts';
import { createMacroRun, type MacroEnv, type MacroRun } from './macros.ts';
import {
  counterById,
  defaultCounter,
  ensureMemoCapacity,
  estimateMessage,
  estimateMessages,
  estimateTokens,
  MESSAGE_OVERHEAD_TOKENS,
  type TokenCounter,
} from './tokens.ts';
import { chatArea, HISTORY_SRC } from './assemble/chat.ts';
import { CONTINUE_CUE, POST_PROCESSING_PLACEHOLDER } from './shape.ts';
import { guidanceText } from './assemble/guidance.ts';
import { presetHash } from './assemble/hash.ts';
import {
  DEFAULT_NOTE_DEPTH,
  DEFAULT_NOTE_ROLE,
  loreHashes,
  loreNames,
  loreSlotValue,
  loreSources,
  noteWithLore,
  regexNotice,
  runAssembleLore,
} from './assemble/lore.ts';
import {
  applyFormat,
  fillSlots,
  formatExamples,
  historySlots,
  protectSlots,
  slotScope,
  soleMacro,
  splitAtHistory,
  type SlotRef,
} from './assemble/slots.ts';

export { presetHash, loreBookHash } from './assemble/hash.ts';
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
  /**
   * M2: the session's books (SessionConfig.lorebooks loaded from the library), keyed by library id,
   * in config order. The card's book (CARD_BOOK_KEY) and the persona's (PERSONA_BOOK_KEY) come from
   * `cast`; assemble puts them first (persona, card, these), as ST's "character first" strategy.
   */
  lorebooks: LoreSource[];
  /** M2 [D-45]: also return one lore verdict per entry (preview, /lore test). */
  explain?: boolean;
  /** M2: how tokens are counted (default defaultCounter(): o200k). Tests that pin numbers pass CHARS_COUNTER. */
  counter?: TokenCounter;
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
  /**
   * M1b [D-50]: EMA correction of the token estimate for this model, derived from the path
   * (reported prompt tokens / estimated). Every budget estimate is multiplied by it. Default 1.
   */
  tokenFactor?: number;
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
      /** M2: present when input.explain was set [D-45]. */
      verdicts?: LoreVerdict[];
      /**
       * M2 (final fix), with explain: what the lore run took of its budget, in budget tokens (the
       * counts scaled by `factor`, the model's EMA correction [D-50]; 1 = none yet).
       */
      loreUse?: { used: number; factor: number };
      /**
       * M2: the '/regex/' lore keys re2js refused this run (the same list `notices`'
       * 'lore_regex_invalid' names); present only when non-empty. The engine keys its
       * once-per-entry notices on it.
       */
      loreRegexErrors?: LoreRunResult['regexErrors'];
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

/** Which lore slots and outlets something in the request asked for (C5: lore that fired but went nowhere). */
interface SlotsUsed {
  lore: Set<string>;
  outlets: Set<string>;
}

/**
 * Values of the non-history slots: {{lore::x}} and {{outlet::x}} from this request's lore (M2).
 * The director slot arrives in M4 and {{recap}} in M5; until then they render ''.
 */
function slotValue(ref: SlotRef, lore: LorePlacement, preset: Preset, used: SlotsUsed): string {
  if (ref.kind === 'lore') used.lore.add(ref.name.toLowerCase());
  if (ref.kind === 'outlet') used.outlets.add(ref.name);
  return ref.kind === 'lore' || ref.kind === 'outlet' ? loreSlotValue(ref, lore, preset.formats) : '';
}

const SLOT_POSITIONS = new Set(['before', 'after', 'examples_before', 'examples_after']);

/**
 * Fired entries whose text no part of the request takes (entry label → the slot it needed): a
 * lore slot the preset does not hold (or holds in a disabled block), an outlet nothing names. As in
 * ST they fired and counted against the budget; their text went nowhere.
 */
function unsentLore(fired: LoreRunResult['fired'], used: SlotsUsed): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const h of fired) {
    if (h.text === '') continue;
    const p = h.entry.position;
    if (typeof p === 'string') {
      if (SLOT_POSITIONS.has(p) && !used.lore.has(p)) out[entryLabel(h.book, h.id)] = `{{lore::${p}}}`;
    } else if ('outlet' in p) {
      const name = p.outlet.trim();
      if (name !== '' && !used.outlets.has(name)) out[entryLabel(h.book, h.id)] = `{{outlet::${name}}}`;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
function layoutBlocks(plan: PlannedBlock[], run: MacroRun, preset: Preset, lore: LorePlacement, used: SlotsUsed): Layout {
  const out: Layout = { top: [], before: [], after: [], bottom: [], depth: [] };
  let pastHistory = false;

  for (const p of plan) {
    // Slots are numbered per block, in the block's own scope: what the macro engine sees of a block
    // (and so its {{pick}} seed, D-43) never changes when another block is added or toggled.
    const refs: SlotRef[] = [];
    const scope = slotScope(p.block.id);
    const fill = (text: string): string => fillSlots(text, refs, (ref) => slotValue(ref, lore, preset, used), scope);
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

// ---- token correction [D-50] --------------------------------------------------------------------

/** AssembleInput.tokenFactor as the budget uses it: a positive finite number, anything else is 1. */
function budgetFactor(f: number | undefined): number {
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : 1;
}

/** An estimate scaled by the correction, rounded up (the safe side of a budget); factor 1 is exact. */
function scaled(tok: number, factor: number): number {
  return factor === 1 ? tok : Math.ceil(tok * factor);
}

// ---- the trace of what is sent ------------------------------------------------------------------

/** trace.tokens and trace.blocks of a message list (§5.7: blocks are 1:1 with it), raw counts. */
function sentRows(messages: readonly PromptMsg[], counter: TokenCounter): Pick<Trace, 'tokens' | 'blocks'> {
  const blocks = messages.map((m) => ({ src: m.src, role: m.role, tok: estimateMessage(m, counter) }));
  return {
    tokens: { estimated: blocks.reduce((sum, b) => sum + b.tok, 0), counter: counter.id },
    blocks,
  };
}

/**
 * The trace of the request actually sent. shape() may drop a message (a continue target sent as
 * the prefill) or add one (the continue cue), so the engine re-derives the rows from its output,
 * counted with the counter the trace names (so the EMA compares like with like). The prefill the
 * request carries (a preset's, or on a continue the whole answer so far) is prompt the server
 * counts too: it is added to tokens.estimated like one more message, while `blocks` stays 1:1 with
 * the messages. A reported token count already on the trace is kept.
 */
export function traceForSent(trace: Trace, messages: readonly PromptMsg[], prefill?: string): Trace {
  const counter = counterById(trace.tokens.counter);
  const rows = sentRows(messages, counter);
  if (prefill !== undefined && prefill !== '') rows.tokens.estimated += estimateTokens(prefill, counter) + MESSAGE_OVERHEAD_TOKENS;
  return { ...trace, blocks: rows.blocks, tokens: { ...trace.tokens, ...rows.tokens } };
}

/** One system message holding lore texts joined with '\n', or none when they are blank. */
function loreMsg(texts: readonly string[], src: string): PromptMsg[] {
  const text = texts.join('\n');
  return text.trim() === '' ? [] : [{ role: 'system', blocks: [{ k: 'text', text }], src, placement: 'inline' }];
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

  const counter = input.counter ?? defaultCounter();
  // Every chat message is counted several times per turn, in order: the memo must hold them all.
  ensureMemoCapacity(2 * input.view.path.length + 256);
  // Every estimate the budgets see is scaled by the model's EMA correction [D-50]; the trace keeps
  // the raw estimates, which are what the next correction is learned from.
  const factor = budgetFactor(input.tokenFactor);
  const measure = (m: PromptMsg): number => estimateMessage(m, counter);
  const measureAll = (ms: readonly PromptMsg[]): number => estimateMessages(ms, counter);

  // One run for the whole request: variables set by one block are visible to the blocks after it.
  // {{outlet::x}} outside the preset's own slots resolves as ST's outlet macro: to the outlet's
  // entries once the lore run placed them, '' inside lore content (expanded before they exist).
  const used: SlotsUsed = { lore: new Set(), outlets: new Set() };
  let outlets: LorePlacement['outlets'] | null = null;
  const env: MacroEnv = {
    ...macroEnv(input),
    outlet: (name) => {
      if (outlets === null) return '';
      used.outlets.add(name);
      const texts = Object.hasOwn(outlets, name) ? outlets[name] : undefined;
      return texts ? texts.join('\n') : '';
    },
  };
  const run = createMacroRun(env);

  // Lore (§10.3), once per request, before the blocks whose slots it fills. Entry content is a
  // template (D-42), expanded in this run under 'lore:<book>:<id>'; keys get identity macros only;
  // history stays inert. The budget is in corrected tokens, like everything else the budgets compare.
  const sources = loreSources(input.cast, input.lorebooks);
  const budgetForLore = loreBudget(input.window, input.reserve);
  const lore = runAssembleLore({
    sources,
    view: input.view,
    upTo: input.upTo,
    names: { char: env.char, user: env.user },
    seed: input.seed,
    budget: budgetForLore,
    count: (text) => scaled(counter.count(text), factor),
    rawCount: (text) => counter.count(text),
    expand: (content, source) => run.block(content, source),
    expandKey: (key) => run.userText(key),
    explain: input.explain === true,
    ownBooks: {
      ...(character.book ? { card: character.book.name } : {}),
      ...(input.cast.persona?.book ? { persona: input.cast.persona.book.name } : {}),
    },
  });
  const place = lore.place;
  outlets = place.outlets;
  const layout = layoutBlocks(plan, run, preset, place, used);
  // Lore with no slot of its own: top and bottom of the prompt, and the recap texts right before
  // the chat area (M5 moves them to {{recap}}). A lore slot the preset does not hold is not sent,
  // as in ST; its entries still fired and still counted against the lore budget.
  const loreTop = loreMsg(place.top, 'lore:top');
  const loreBottom = loreMsg(place.bottom, 'lore:bottom');
  const loreRecap = loreMsg(place.recap, 'lore:recap');

  // ST's new_chat_prompt opens the chat area; it is not a chat message, so depths do not count it.
  const newChatText = preset.formats?.newChat ? run.block(preset.formats.newChat, 'new_chat') : '';
  const newChat: PromptMsg[] =
    newChatText.trim() === '' ? [] : [{ role: 'system', blocks: [{ k: 'text', text: newChatText }], src: 'new_chat', placement: 'inline' }];

  // Inserts in source order; injectAtDepth sorts them by depth, order and source rank (§10.1).
  const inserts: DepthInsert[] = [...layout.depth, ...place.depth];
  const dp = character.depthPrompt;
  if (dp && dp.text.trim() !== '') {
    inserts.push({ depth: dp.depth, role: dp.role, src: 'card_depth', text: run.block(dp.text, 'card_depth') });
  }
  // The author's note, wrapped in AN-top / AN-bottom lore as ST does. Without a note that lore still
  // goes to the note's place: ST's default, in-chat depth 4 as system.
  const note = input.authorNote;
  const noteText = noteWithLore(note && note.text.trim() !== '' ? run.block(note.text, 'author_note') : '', place);
  if (noteText !== '') {
    inserts.push({ depth: note?.depth ?? DEFAULT_NOTE_DEPTH, role: note?.role ?? DEFAULT_NOTE_ROLE, src: 'author_note', text: noteText });
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
  // head is the greeting, dropped only as the last resort before a refusal (below).
  // preset.context.maxMessages is applied by the same cut: same grid, same protections, recorded in
  // trace.trimmed.
  const available = input.window - input.reserve;
  const blocksTok = measureAll(layout.top) + measureAll(layout.before) + measureAll(newChat) + measureAll(layout.after) + measureAll(layout.bottom);
  const loreOwnTok = measureAll(loreTop) + measureAll(loreRecap) + measureAll(loreBottom);
  const insertsTok = measureAll(injectAtDepth([], inserts)); // every non-blank insert, measured as it will be sent
  const prefillTok = prefill.prefill === null ? 0 : estimateTokens(prefill.prefill, counter) + MESSAGE_OVERHEAD_TOKENS;
  // What shape() adds after this budget: the continue cue for a model without prefill (§6.4), and
  // the 'strict' post-processing placeholder (one short user message at most).
  const cueTok = input.kind === 'continue' && input.caps.prefill === 'none' ? estimateTokens(CONTINUE_CUE, counter) + MESSAGE_OVERHEAD_TOKENS : 0;
  const placeholderTok = preset.postProcessing === 'strict' ? estimateTokens(POST_PROCESSING_PLACEHOLDER, counter) + MESSAGE_OVERHEAD_TOKENS : 0;
  const fixed = scaled(blocksTok + loreOwnTok + insertsTok + prefillTok + cueTok + placeholderTok, factor);
  // Measured on demand: trimHistory stops at the first overflow, so older messages are never
  // tokenized (D-49's early stop holds with a real tokenizer too).
  const sized = chat.msgs.map((m, i) => {
    let tok: number | undefined;
    return {
      id: chat.ids[i]!,
      get tok(): number {
        return (tok ??= scaled(measure(m), factor));
      },
    };
  });
  const head = chat.greeting ? 1 : 0;
  const tail = Math.min(protectedTail(input, chat.ids), Math.max(0, sized.length - head));
  const maxKept = preset.context?.maxMessages;
  const trimOpts = { protectedTail: tail, ...(maxKept !== undefined ? { maxKept } : {}) };
  let cut = trimHistory(sized, available - fixed, { protectedHead: head, ...trimOpts });
  // The last resort before a refusal: the greeting goes the way of old history. SillyTavern fills
  // the history newest first and leaves out whatever does not fit, the greeting included
  // (openai.js populateChatHistory); refusing a turn ST would send is worse than a missing greeting.
  let greetingDropped = false;
  if (!cut.fits && head > 0) {
    const without = trimHistory(sized, available - fixed, { protectedHead: 0, ...trimOpts });
    if (without.fits) {
      cut = without;
      greetingDropped = true;
    }
  }
  if (!cut.fits) {
    const tailTok = sized.slice(sized.length - tail).reduce((a, s) => a + s.tok, 0);
    const need = fixed + tailTok;
    const s = (n: number): number => scaled(n, factor);
    const parts = [
      `the preset's blocks ${s(blocksTok + loreOwnTok)} (lore included: ${lore.run.used} of its budget ${budgetForLore})`,
      ...(insertsTok > 0 ? [`in-chat inserts ${s(insertsTok)} (author's note, depth prompts, depth lore)`] : []),
      ...(prefillTok + cueTok + placeholderTok > 0 ? [`prefill and cues ${s(prefillTok + cueTok + placeholderTok)}`] : []),
      `your current message${tail > 1 ? ' and the answer it continues' : ''} ${tailTok}`,
    ];
    const greeting = head > 0 ? `; the greeting (${sized[0]!.tok} tokens) is already left out` : '';
    return {
      ok: false,
      code: 'context_length_exceeded',
      message: `the required part of the prompt needs about ${need} tokens, but only ${Math.max(0, available)} are available (window ${input.window} - reply reserve ${input.reserve}): ${parts.join(', ')}${greeting}`,
    };
  }
  const kept = greetingDropped ? chat.msgs.slice(cut.keepFrom) : [...chat.msgs.slice(0, head), ...chat.msgs.slice(cut.keepFrom)];

  // The leading system run of the preset is the head the adapters send as the system prompt.
  const lead = [...loreTop, ...layout.top, ...layout.before];
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
  const messages: PromptMsg[] = [...lead, ...newChat, ...loreRecap, ...chatPart, ...layout.after, ...layout.bottom, ...loreBottom];

  const unsent = unsentLore(lore.run.fired, used);
  const trace: Trace = {
    seed: input.seed,
    now: input.now,
    window: input.window,
    reserve: input.reserve,
    ...sentRows(messages, counter),
    // Only accepted entries are fires: timers start from them (a cut entry never reached the prompt).
    lore: {
      fired: lore.run.fired.map((h) => ({ book: h.book, id: h.id, why: h.why })),
      cut: lore.run.cut.map((h) => entryLabel(h.book, h.id)),
      budget: budgetForLore,
      ...(unsent ? { unsent } : {}),
    },
    recap: { ids: [], arcs: [], boundary: null },
    prefill: prefill.trace,
    macros: { unknown: run.unknown() },
    trimmed: cut.trimmed,
    calls: [],
    agents: {},
    presetHash: presetHash(preset),
    loreHashes: loreHashes(sources),
    ...(sources.length > 0 ? { loreNames: loreNames(sources) } : {}),
  };

  const regex = regexNotice(lore.run.regexErrors);
  const notices = [...prefill.notices, ...(regex ? [regex] : [])];
  if (greetingDropped) {
    notices.push({
      level: 'warn',
      code: 'greeting_dropped',
      message: `The greeting did not fit in the context window (${input.window} tokens) next to the preset, the lore and your message, so this request leaves it out, as SillyTavern does.`,
    });
  }
  if (unsent) {
    const slots = [...new Set(Object.values(unsent))];
    const n = Object.keys(unsent).length;
    notices.push({
      level: 'warn',
      code: 'lore_unsent',
      message: `${n} lore entr${n === 1 ? 'y' : 'ies'} fired but ${n === 1 ? 'was' : 'were'} not sent: the preset has no enabled ${slots.join(', ')} (as in SillyTavern; /trace marks ${n === 1 ? 'it' : 'them'}).`,
    });
  }
  return {
    ok: true,
    messages,
    tools: prefill.tools,
    prefill: prefill.prefill,
    trace,
    varsDiff: run.varsDiff(),
    notices,
    ...(input.explain ? { verdicts: lore.run.verdicts ?? [], loreUse: { used: lore.run.used, factor } } : {}),
    ...(lore.run.regexErrors.length > 0 ? { loreRegexErrors: lore.run.regexErrors } : {}),
  };
}
