// Ported from Bunraku:src/formats/_shared/st-preset-wire.ts@702d8120 (resolveSequence, the
// prompt_order law, coercion of numbers written as strings, the custom_prompt_post_processing key) and
// Bunraku:src/core/assembly/preset.ts@702d8120 (fillSlots: RoleCall's lore/persona/history fills,
// applied only to RoleCall exports). ST defaults (chatCompletionDefaultPrompts,
// promptManagerDefaultPromptOrder, DEFAULT_DEPTH/ORDER) are facts taken from
// SillyBunny:public/scripts/PromptManager.js@3021edcae (SillyTavern, AGPL-3.0).
// Copyright (C) 2026 Coneja-Chibi; SillyTavern contributors; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SillyTavern chat-completion preset → core.preset/1 (ARCHITECTURE.md §10.2, §10.5, D-43, D-70,
// D-71). The law of the importer:
// - block order and `enabled` come from prompt_order for character_id 100001 (ST's global order);
//   prompts it does not reference are imported disabled; other characters' orders go to extras;
//   without a 100001 order ST installs its default order (sanitizeServiceSettings), so the
//   importer does too: ST's default prompts only, every other prompt disabled;
// - a relative custom prompt is sent only when its system_prompt is false (ST's
//   populateChatCompletion), and a custom row flagged marker with system_prompt false and text is
//   sent as text; a file with RoleCall signs (prompt_post_processing, {{message_history}}) keeps
//   RoleCall's reading of both, with a warning;
// - markers become slot macros: chatHistory → {{history}}, worldInfoBefore → {{lore::before}},
//   worldInfoAfter → {{lore::after}}, dialogueExamples →
//   {{lore::examples_before}}{{examples}}{{lore::examples_after}}, charDescription →
//   {{description}}, charPersonality → {{personality}}, scenario → {{scenario}},
//   personaDescription → {{persona}}; an unknown marker is kept disabled with a warning;
// - a disabled marker stays a disabled block and sends nothing, with a warning per slot (D-71, ST);
//   only a missing chatHistory is synthesised (enabled, at the end), with a warning;
// - injection_position 0 → 'relative', 1 → { depth: injection_depth, order: injection_order }, but
//   the chat history and the dialogue examples are always relative (ST places them so);
//   main gets override 'card_system', jailbreak 'card_post_history'; forbid_overrides carries over;
//   a row's fields that the block does not represent (system_prompt, marker, a relative block's
//   injection_depth / injection_order, ...) ride block extras for a reverse export;
// - samplers (temperature, top_p, top_k, min_p, top_a, frequency/presence/repetition penalty,
//   seed, max_tokens ← openai_max_tokens), context.maxContext ← openai_max_context, prefill ←
//   assistant_prefill, impersonation {prompt ← impersonation_prompt, prefill ←
//   assistant_impersonation}, postProcessing ← custom_prompt_post_processing (ST's names:
//   '' none, merge, semi, strict, single), formats ← wi_format, personality_format,
//   scenario_format, new_chat_prompt, new_example_chat_prompt (D-70);
// - a RoleCall export (extensions.rolecall present) is read with RoleCall's rules instead (D-71,
//   mixed): in-chat depths + 1 via fromRcDepth, lore and persona slots always on, and its numeric
//   {{random}} forms rewritten into explicit lists (D-43 amendment); its pins (injection_position
//   4 / 3) become 'top' / 'bottom' blocks sorted by injection_order, its appends (2) are imported
//   disabled, and its template formats (wi/personality/scenario, new_chat_prompt,
//   new_example_chat_prompt) ride extras unapplied, as RoleCall never applies them; a disabled
//   persona marker stays off and RoleCall's persona block is added after main, as RoleCall does;
// - everything present but not honoured becomes an ImportWarning naming it (D-70), macros rp-core
//   does not run included ('unknown_macro', one per name).
// Sources (adapt): Bunraku src/formats/_shared/st-preset-wire.ts and src/core/assembly/preset.ts
// fillSlots; reference: Bunraku src/formats/sillytavern/preset.ts, VAUDEVILLE
// packages/presets-core/src/preset-parser.ts, RoleCall apps/rc/src/lib/ai/preset-loader.ts
// 559–845; SillyTavern public/scripts/openai.js (behaviour).
// CONTRACT FILE: signatures are fixed; the formats agent implements the bodies.
//
// Implementation notes:
// - Connection settings and secrets (chat_completion_source, *_model, reverse_proxy, proxy_password,
//   custom_url, custom_include_*, ...) are dropped silently: never in the value, never in extras.
// - A setting rp-core does not honour rides `extras`; it warns when its value would make ST behave
//   differently from rp-core (squash_system_messages: true warns, false does not), the rule
//   st-worldinfo.ts uses for entries. UI-only and group-chat fields ride extras quietly.
// - Not ported from Bunraku: divider groups (NemoPresetExt dialects), placements 2–4 for ST files, the escrow
//   twin, "duplicate identifiers are skipped" (here they are kept disabled under a suffixed id), and
//   RoleCall's fills for ST presets (D-71: an ST preset behaves like ST).

import { fromRcDepth } from '../prompt/depth.ts';
import { unknownMacrosIn } from '../prompt/macros.ts';
import { historySlots, topSlots } from '../prompt/assemble/slots.ts';
import { canonicalId, type ChatRole, type Imported, type ImportWarning, type Preset, type PresetBlock } from './native.ts';
import { compact, isRecord, joinPath, nonBlank, optNum, optStr, uniqueIds, type Rec } from './wire.ts';

/** ST prompt identifiers that are markers, and the slot text each becomes (§10.2). */
export const ST_MARKER_SLOTS: Readonly<Record<string, string>> = {
  chatHistory: '{{history}}',
  worldInfoBefore: '{{lore::before}}',
  worldInfoAfter: '{{lore::after}}',
  dialogueExamples: '{{lore::examples_before}}{{examples}}{{lore::examples_after}}',
  charDescription: '{{description}}',
  charPersonality: '{{personality}}',
  scenario: '{{scenario}}',
  personaDescription: '{{persona}}',
};

/** ST's global prompt order lives under this character id. */
export const ST_GLOBAL_ORDER_ID = 100001;

/** A RoleCall preset export: ST grammar with RoleCall depths (extensions.rolecall present). [D-71] */
export function isRoleCallExport(json: unknown): boolean {
  return isRecord(json) && isRecord(json.extensions) && json.extensions.rolecall !== undefined && json.extensions.rolecall !== null;
}

// ---- RoleCall's numeric {{random}} (D-43 amendment) ---------------------------------------------

/** Most values a rewritten list may hold: {{random}} itself is 0–100, 101 values. */
const RC_RANDOM_MAX_VALUES = 101;
/** `{{random}}`, `{{random::…}}` with optional spaces; arguments cannot hold nested macros. */
const RC_RANDOM = /(\\?)\{\{\s*random\s*((?:::[^{}]*)?)\}\}/gi;
const INTEGER = /^[+-]?\d+$/;

/**
 * [D-43 amendment] RoleCall's numeric {{random}} forms in an RC export: `{{random}}` (0–100),
 * `{{random::a}}` (a–100) and `{{random::a::b}}` with integers (a–b) become the explicit ST list
 * `{{random::a::…::b}}` when the range holds at most 101 values; wider ranges stay as they are and
 * are returned in `wide` (the caller warns 'rc_random_range'). Three or more arguments, or any
 * non-integer argument, are already ST choices and stay untouched.
 */
export function rewriteRcRandom(text: string): { text: string; wide: string[] } {
  const wide: string[] = [];
  const out = text.replace(RC_RANDOM, (tag: string, escape: string, tail: string) => {
    if (escape) return tag; // an escaped tag is literal text
    const args = tail === '' ? [] : tail.slice(2).split('::').map((a) => a.trim());
    if (args.length > 2 || !args.every((a) => INTEGER.test(a))) return tag; // an ST choice already
    const a = args[0] === undefined ? 0 : Number(args[0]);
    const b = args[1] === undefined ? 100 : Number(args[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
      wide.push(tag);
      return tag;
    }
    // RoleCall computes floor(r * (b - a + 1)) + a; a reversed range is read as the same span sorted.
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo + 1 > RC_RANDOM_MAX_VALUES) {
      wide.push(tag);
      return tag;
    }
    const values: number[] = [];
    for (let v = lo; v <= hi; v++) values.push(v);
    return `{{random::${values.join('::')}}}`;
  });
  return { text: out, wide };
}

// ---- tables ------------------------------------------------------------------------------------

/**
 * ST's DEFAULT_DEPTH for an in-chat prompt without a depth (PromptManager.js). A missing order stays
 * absent: depth.ts already defaults it to ST's DEFAULT_ORDER, 100.
 */
const ST_DEFAULT_DEPTH = 4;

const ROLES: readonly string[] = ['system', 'user', 'assistant'];

/** The ST defaults that stay ordinary blocks even when flagged as markers. */
const CONTENT_DEFAULTS = new Set(['main', 'nsfw', 'jailbreak', 'enhanceDefinitions']);

const OVERRIDES: Readonly<Record<string, PresetBlock['override']>> = {
  main: 'card_system',
  jailbreak: 'card_post_history',
};

/**
 * ST's chatCompletionDefaultPrompts (PromptManager.js; the main text as ST's Default.json ships it,
 * without the group-only {{charIfNotGroup}}). ST adds any of these a preset lacks
 * (checkForMissingPrompts), so an order that references one still gets it.
 */
const ST_DEFAULT_PROMPTS: readonly Rec[] = [
  { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}." },
  { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '' },
  { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
  { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '' },
  { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
  {
    identifier: 'enhanceDefinitions',
    role: 'system',
    name: 'Enhance Definitions',
    content:
      "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    system_prompt: true,
    marker: false,
  },
  { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
  { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
  { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
  { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
];

/** ST's promptManagerDefaultPromptOrder, used with the default prompts. */
const ST_DEFAULT_ORDER: readonly Rec[] = [
  ['main', true],
  ['worldInfoBefore', true],
  ['personaDescription', true],
  ['charDescription', true],
  ['charPersonality', true],
  ['scenario', true],
  ['enhanceDefinitions', false],
  ['nsfw', true],
  ['worldInfoAfter', true],
  ['dialogueExamples', true],
  ['chatHistory', true],
  ['jailbreak', true],
].map(([identifier, enabled]) => ({ identifier, enabled }));

/** Connection settings and secrets (ST's is_connection fields and sensitiveFields): dropped, never stored. */
const CONNECTION = new Set([
  'chat_completion_source',
  'reverse_proxy',
  'proxy_password',
  'custom_url',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
  'custom_model_icon_detection',
  'bypass_status_check',
  'workers_ai_account_id',
  'api_url_scale',
  'modelId',
]);
const CONNECTION_PATTERN =
  /(?:_model|_endpoint|_sort_models|_group_models)$|^(?:openrouter|azure|vertexai)_|(?:^|_)(?:password|secret|token|api_?key|key)$/i;
const isConnection = (key: string): boolean => CONNECTION.has(key) || CONNECTION_PATTERN.test(key);

type Active = (v: unknown, preset: Rec) => boolean;
const isTrue: Active = (v) => v === true || v === 'true' || v === 1;
const setText: Active = (v) => typeof v === 'string' && v.trim() !== '';
const nonEmptyList: Active = (v) => Array.isArray(v) && v.length > 0;
const notOneOf =
  (...quiet: unknown[]): Active =>
  (v) =>
    v !== undefined && v !== null && v !== '' && !quiet.includes(v);

/**
 * Settings ST acts on and rp-core does not. They ride extras; a warning names the ones whose value
 * would make ST behave differently from rp-core.
 */
const NOT_HONOURED: Readonly<Record<string, { active: Active; what: string }>> = {
  names_behavior: { active: notOneOf(0, -1, '0', '-1'), what: 'character names in messages (names_behavior)' },
  send_if_empty: { active: setText, what: 'the send-if-empty replacement' },
  continue_nudge_prompt: { active: setText, what: "the continue nudge (rp-core's /c continues the last answer its own way)" },
  continue_prefill: { active: isTrue, what: 'continue as prefill' },
  continue_postfix: { active: (v) => typeof v === 'string' && v !== '' && v !== ' ', what: 'the continue postfix' },
  squash_system_messages: { active: isTrue, what: 'squashing system messages' },
  wrap_in_quotes: { active: isTrue, what: 'wrapping messages in quotes' },
  use_sysprompt: { active: isTrue, what: 'the provider system-prompt switch (use_sysprompt)' },
  claude_use_sysprompt: { active: isTrue, what: 'the Claude system-prompt switch' },
  use_makersuite_sysprompt: { active: isTrue, what: 'the Google system-prompt switch' },
  media_inlining: { active: isTrue, what: 'media inlining' },
  image_inlining: { active: isTrue, what: 'image inlining' },
  video_inlining: { active: isTrue, what: 'video inlining' },
  audio_inlining: { active: isTrue, what: 'audio inlining' },
  request_images: { active: isTrue, what: 'image requests' },
  function_calling: { active: isTrue, what: 'function calling (tools follow the narrator config)' },
  enable_web_search: { active: isTrue, what: 'web search' },
  show_thoughts: { active: isTrue, what: 'requesting model thoughts (show_thoughts)' },
  reasoning_effort: { active: notOneOf('auto'), what: 'reasoning effort (set per connection in config.toml)' },
  verbosity: { active: notOneOf('auto'), what: 'verbosity' },
  tool_reasoning_mode: { active: notOneOf('disabled'), what: 'tool reasoning mode' },
  auto_append_reasoning_tags: { active: isTrue, what: 'auto-appended reasoning tags' },
  claude_disable_temperature: { active: isTrue, what: 'dropping temperature for Claude' },
  claude_disable_top_p: { active: isTrue, what: 'dropping top_p for Claude' },
  n: { active: notOneOf(1, '1'), what: 'several completions per request (n)' },
  bias_presets: { active: (v, p) => activeBias(v, p.bias_preset_selected), what: 'the selected logit bias preset' },
  show_external_models: { active: isTrue, what: 'the external model list' },
  macro_engine_yaml: { active: setText, what: "SillyBunny's macro engine dashboard" },
  choice_groups: { active: nonEmptyList, what: "SillyBunny's choice groups" },
};

/** Known fields with no effect on a single-character rp-core chat: extras, no warning. */
const QUIET = new Set([
  'max_context_unlocked',
  'stream_openai',
  'new_group_chat_prompt',
  'group_nudge_prompt',
  'bias_preset_selected',
  'inline_image_quality',
  'request_image_aspect_ratio',
  'request_image_resolution',
  'auto_append_reasoning_tag_style',
  'tool_call_recurse_limit',
  'readme',
  'suggested_models',
]);

function activeBias(presets: unknown, selected: unknown): boolean {
  if (!isRecord(presets) || typeof selected !== 'string') return false;
  return nonEmptyList(presets[selected], {});
}

/** Fields of a prompt row the converter reads; anything else rides block extras with a warning. */
const PROMPT_FIELDS = new Set([
  'identifier',
  'name',
  'role',
  'content',
  'marker',
  'system_prompt',
  'enabled',
  'injection_position',
  'injection_depth',
  'injection_order',
  'forbid_overrides',
  'injection_trigger',
]);

const POST_PROCESSING: Readonly<Record<string, NonNullable<Preset['postProcessing']>>> = {
  '': 'none',
  none: 'none',
  merge: 'merge',
  claude: 'merge', // deprecated; ST migrates it to merge
  semi: 'semi',
  strict: 'strict',
  single: 'single',
};

// ---- warnings ----------------------------------------------------------------------------------

/** Warnings, with per-block ones folded by (code, field) so 150 blocks do not give 150 lines. */
class Warnings {
  readonly list: ImportWarning[] = [];
  private readonly folded = new Map<string, { code: string; paths: string[]; star: string; message: string }>();

  add(code: string, path: string, message: string): void {
    this.list.push({ code, path: path || '$', message });
  }

  fold(code: string, path: string, star: string, message: string): void {
    const key = `${code}\u0000${star}\u0000${message}`;
    const hit = this.folded.get(key);
    if (hit) hit.paths.push(path);
    else this.folded.set(key, { code, paths: [path], star, message });
  }

  all(): ImportWarning[] {
    const out = [...this.list];
    for (const f of this.folded.values()) {
      out.push(
        f.paths.length === 1
          ? { code: f.code, path: f.paths[0] ?? f.star, message: f.message }
          : { code: f.code, path: f.star, message: `${f.message} (${f.paths.length} blocks)` },
      );
    }
    return out;
  }
}

// ---- prompts → blocks --------------------------------------------------------------------------

interface Row {
  raw: Rec;
  /** Where the row came from, for warnings: `prompts[3]`, or `prompt_order` for an ST default. */
  path: string;
}

/** A block under construction, with what the later passes need to know about it. */
interface Draft {
  block: PresetBlock;
  path: string;
  /** The ST identifier (also the block id before ids are made unique). */
  ident: string;
  /** The slot macro this marker became, if it is a known marker. */
  slot?: string;
  /** Not referenced by the global order. */
  unreferenced: boolean;
  /** RC exports: a pin's injection_order (RoleCall sorts each pin group by it). */
  pinOrder?: number;
}

/** ST's `entry.enabled` is a plain truthiness test; drifted 'true'/'false' strings are read as booleans. */
function orderEnabled(v: unknown): boolean {
  if (v === 'false' || v === '0') return false;
  return Boolean(v);
}

/** Every top-level structural slot that is not an ST macro (all but {{outlet::x}}) is escaped to stay literal, as in ST. */
function escapeForeignSlots(text: string): { text: string; count: number } {
  const slots = topSlots(text).filter((s) => s.ref.kind !== 'outlet');
  let out = text;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i]!;
    out = `${out.slice(0, s.start)}\\${out.slice(s.start)}`;
  }
  return { text: out, count: slots.length };
}

/** RoleCall's history macro: the chat sits wherever it is written. */
const MESSAGE_HISTORY = /(\\?)\{\{\s*message_history\s*\}\}/gi;
const hasMessageHistory = (text: string): boolean =>
  [...text.matchAll(MESSAGE_HISTORY)].some((m) => m[1] === '');
const toHistorySlot = (text: string): string => text.replace(MESSAGE_HISTORY, (tag: string, esc: string) => (esc ? tag : '{{history}}'));

const PERSONA_MACRO = /\{\{\s*persona\s*\}\}/i;
const carriesLore = (b: PresetBlock, name: string): boolean =>
  topSlots(b.content).some((s) => s.ref.kind === 'lore' && 'name' in s.ref && s.ref.name.toLowerCase() === name);

interface Ctx {
  rc: boolean;
  /**
   * An ST-grammar file born in RoleCall (prompt_post_processing, {{message_history}}): its custom
   * prompts are read as RoleCall sends them, whatever their system_prompt / marker flags.
   */
  rcBorn: boolean;
  /** rcBorn: custom prompts SillyTavern itself would not send, kept as RoleCall reads them. */
  rcKept: number;
  w: Warnings;
}

/** ST's own prompts: sent by their own code paths in ST, whatever their system_prompt flag. */
const isKnownPrompt = (ident: string): boolean => CONTENT_DEFAULTS.has(ident) || ST_MARKER_SLOTS[ident] !== undefined;

/** RoleCall signs in an ST-grammar file that is not an RC export (paramnesia-vi-*.json). */
function hasRoleCallSigns(json: Rec): boolean {
  if ('prompt_post_processing' in json && !('custom_prompt_post_processing' in json)) return true;
  const prompts = Array.isArray(json.prompts) ? json.prompts : [];
  return prompts.some((p) => isRecord(p) && typeof p.content === 'string' && hasMessageHistory(p.content));
}

function toDraft(row: Row, enabled: boolean, unreferenced: boolean, index: number, c: Ctx): Draft {
  const r = row.raw;
  const at = (k: string): string => joinPath(row.path, k);
  const star = (k: string): string => joinPath('prompts[*]', k);
  const ident = nonBlank(r.identifier)?.trim() ?? '';
  const name = nonBlank(r.name);
  const id = ident || (name ? canonicalId(name) : '') || `prompt-${index}`;
  const extras: Rec = {};

  let role: ChatRole = 'system';
  if (typeof r.role === 'string' && ROLES.includes(r.role)) role = r.role as ChatRole;
  else if (r.role !== undefined && r.role !== null && r.role !== '') {
    c.w.fold('invalid_value', at('role'), star('role'), `unknown role ${JSON.stringify(r.role)}; sent as system`);
    extras.role = r.role;
  }

  const rawContent = r.content;
  let content = typeof rawContent === 'string' ? rawContent : '';
  if (rawContent !== undefined && rawContent !== null && typeof rawContent !== 'string') {
    c.w.fold('invalid_value', at('content'), star('content'), 'content is not a string; imported as empty');
    extras.content = rawContent;
  }

  // Markers: the identifier decides (ST overwrites a marker's row by identifier), the flag only
  // matters for identifiers ST does not know.
  const slot = ST_MARKER_SLOTS[ident];
  let on = enabled;
  const plainSt = !c.rc && !c.rcBorn;
  // ST sends a custom relative prompt by its system_prompt flag alone (marker is ignored there), so
  // a custom "marker" with system_prompt false and text is an ordinary block in an ST file.
  const markerWithText = plainSt && r.marker === true && r.system_prompt === false && content.trim() !== '';
  if (slot !== undefined) {
    if (content.trim() !== '') {
      c.w.fold('marker_content', at('content'), star('content'), "a marker's own text is not sent (ST replaces the marker); kept in extras");
      extras.content = content;
    }
    content = slot;
  } else if (r.marker === true && !CONTENT_DEFAULTS.has(ident) && !markerWithText) {
    c.w.add('unknown_marker', at('identifier'), `unknown marker "${ident}" has nothing to send; kept disabled`);
    on = false;
  } else {
    // Text that would be a core slot is no ST macro: keep it literal so it cannot move the chat.
    const esc = escapeForeignSlots(content);
    if (esc.count > 0) {
      c.w.fold('slot_escaped', at('content'), star('content'), 'core slot syntax ({{history}}, {{lore::x}}, ...) is not an ST macro; kept as literal text');
      content = esc.text;
    }
    if (c.rc && hasMessageHistory(content)) content = toHistorySlot(content);
  }

  // Placement: 0 relative, 1 in-chat (ST INJECTION_POSITION); depth and order default like ST.
  // A RoleCall export also has 4 prepend-top, 3 append-bottom (pins) and 2 append (presets-core).
  let place: PresetBlock['at'] = 'relative';
  let pinOrder: number | undefined;
  const pos = optNum(r.injection_position);
  if (pos === 1 && ident === 'dialogueExamples' && slot !== undefined) {
    // ST adds the examples where the marker stands in the relative frame (populateDialogueExamples);
    // the marker's own in-chat copy has no text and is dropped.
    c.w.add('examples_relative', at('injection_position'), 'SillyTavern always places the dialogue examples relative; injection_position 1 is ignored (kept in extras)');
    extras.injection_position = r.injection_position;
  } else if (pos === 1) {
    const d = optNum(r.injection_depth);
    const depth = d === undefined || d < 0 ? ST_DEFAULT_DEPTH : Math.trunc(d);
    const order = optNum(r.injection_order);
    place = { depth: c.rc ? fromRcDepth(depth) : depth, ...(order !== undefined ? { order } : {}) };
  } else if (c.rc && (pos === 3 || pos === 4)) {
    // RoleCall pins each group to the very end / start, sorted by injection_order (default 100).
    place = pos === 4 ? 'top' : 'bottom';
    pinOrder = optNum(r.injection_order) ?? RC_PIN_ORDER;
  } else if (c.rc && pos === 2) {
    // RoleCall glues an append onto the d-th last chat message of its role; the core has no such
    // placement, and a relative user/assistant block would read as chat, so it is not sent.
    if (on) c.w.fold('rc_append', at('injection_position'), star('injection_position'), "a RoleCall append (glued onto a chat message) has no rp-core placement; imported disabled, relative");
    on = false;
    extras.injection_position = r.injection_position;
    if (r.injection_depth !== undefined) extras.injection_depth = r.injection_depth;
  } else if (pos !== undefined && pos !== 0) {
    c.w.fold('unknown_position', at('injection_position'), star('injection_position'), `injection_position ${JSON.stringify(r.injection_position)} is not ST's; placed relative`);
    extras.injection_position = r.injection_position;
  }

  // Card overrides: ST checks forbid_overrides on main and jailbreak only.
  let override = OVERRIDES[ident];
  if (override && (r.forbid_overrides === true || r.forbid_overrides === 'true')) {
    override = undefined;
    extras.forbid_overrides = true;
  } else if (!override && r.forbid_overrides !== undefined) {
    extras.forbid_overrides = r.forbid_overrides; // no effect in ST on other blocks; kept for the round trip
  }

  if (nonEmptyList(r.injection_trigger, {})) {
    c.w.fold('not_honoured', at('injection_trigger'), star('injection_trigger'), 'generation-type triggers (injection_trigger) are not honoured; the block is sent on every turn');
  }
  if (r.injection_trigger !== undefined) extras.injection_trigger = r.injection_trigger;

  // The rest of the row the block does not represent rides extras, so a reverse export loses nothing
  // (D-70): the flags, and a depth / order the placement does not use.
  if (r.system_prompt !== undefined) extras.system_prompt = r.system_prompt;
  if (r.marker !== undefined) extras.marker = r.marker;
  if (typeof place !== 'object') {
    if (r.injection_depth !== undefined && !('injection_depth' in extras)) extras.injection_depth = r.injection_depth;
    if (r.injection_order !== undefined) extras.injection_order = r.injection_order;
  }

  // Which custom prompts are sent (ST populateChatCompletion): a relative one only when its
  // system_prompt is false. An RC export, or an ST file born in RoleCall, sends them as RoleCall does.
  const relative = place === 'relative' || place === 'top' || place === 'bottom';
  if (!isKnownPrompt(ident) && relative && r.system_prompt !== false && on && !(r.marker === true && !markerWithText)) {
    if (plainSt) {
      on = false;
      c.w.fold(
        'st_not_sent',
        at('system_prompt'),
        star('system_prompt'),
        'SillyTavern sends a relative custom prompt only when its system_prompt is false; this one is not (or has no flag), so it is imported disabled',
      );
    } else if (c.rcBorn) c.rcKept++;
  }
  for (const [k, v] of Object.entries(r)) {
    if (PROMPT_FIELDS.has(k)) continue;
    extras[k] = v;
    c.w.fold('unknown_field', at(k), star(k), `unknown prompt field "${k}" kept in extras`);
  }

  const block: PresetBlock = compact({
    id,
    name,
    role,
    enabled: on,
    content,
    at: place,
    override,
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  });
  return { block, path: row.path, ident, slot, unreferenced, ...(pinOrder !== undefined ? { pinOrder } : {}) };
}

/** RoleCall's default injection_order for a pin without one (preset-loader.ts). */
const RC_PIN_ORDER = 100;

/** RC exports: each pin group ('top', 'bottom') stable-sorted by injection_order, in the places the group holds. */
function sortRcPins(drafts: Draft[]): void {
  for (const group of ['top', 'bottom'] as const) {
    const slots = drafts.flatMap((d, i) => (d.block.at === group ? [i] : []));
    const sorted = slots.map((i) => drafts[i]!).sort((a, b) => (a.pinOrder ?? RC_PIN_ORDER) - (b.pinOrder ?? RC_PIN_ORDER));
    slots.forEach((i, k) => {
      drafts[i] = sorted[k]!;
    });
  }
}

/**
 * The 100001 law: the global order gives sequence and `enabled`; unreferenced prompts follow,
 * disabled. Without a global order the file's own order and `enabled` flags are used (Bunraku).
 */
function sequence(json: Rec, c: Ctx): { drafts: Draft[]; others?: unknown[] } {
  const rawPrompts = json.prompts;
  let rows: Row[] = [];
  if (Array.isArray(rawPrompts)) {
    rawPrompts.forEach((p, i) => {
      if (isRecord(p)) rows.push({ raw: p, path: `prompts[${i}]` });
      else c.w.add('invalid_value', `prompts[${i}]`, 'prompt is not an object; skipped');
    });
  } else if (rawPrompts !== undefined && rawPrompts !== null) {
    c.w.add('invalid_value', 'prompts', 'prompts is not a list; ignored');
  }
  const usedDefaults = rows.length === 0;
  if (usedDefaults) {
    c.w.add('no_prompts', 'prompts', "the preset carries no prompts; SillyTavern's default prompts are used");
    rows = ST_DEFAULT_PROMPTS.map((raw) => ({ raw: { ...raw }, path: 'prompts' }));
  }

  const orders = Array.isArray(json.prompt_order) ? json.prompt_order : [];
  if (json.prompt_order !== undefined && !Array.isArray(json.prompt_order)) {
    c.w.add('invalid_value', 'prompt_order', 'prompt_order is not a list; ignored');
  }
  const globalAt = orders.findIndex((o) => isRecord(o) && String(o.character_id) === String(ST_GLOBAL_ORDER_ID));
  const global = globalAt >= 0 ? (orders[globalAt] as Rec) : undefined;
  const others = orders.filter((_, i) => i !== globalAt);

  // First occurrence of an identifier is the one ST finds (getPromptById); later ones are never referenced.
  const byId = new Map<string, Row>();
  for (const row of rows) {
    const id = nonBlank(row.raw.identifier)?.trim();
    if (id === undefined) continue;
    if (byId.has(id)) c.w.add('duplicate_prompt', joinPath(row.path, 'identifier'), `duplicate prompt identifier "${id}"; ST only uses the first, this one is imported disabled`);
    else byId.set(id, row);
  }

  const drafts: Draft[] = [];
  const picked = new Set<Row>();
  let items: unknown[] | undefined = Array.isArray(global?.order) ? global.order : undefined;
  const itemsPath = `prompt_order[${globalAt}].order`;
  if (global && !items) c.w.add('invalid_value', `prompt_order[${globalAt}].order`, 'the global order is not a list; ignored');
  // No (or an empty) 100001 order: ST's sanitizeServiceSettings installs promptManagerDefaultPromptOrder,
  // so only ST's default prompts are sent; the file's other prompts are imported disabled. (A file
  // with no prompt_order at all keeps the order of the preset ST had loaded before; a fresh ST's is
  // that same default.)
  const defaultOrder = !items || items.length === 0;
  if (defaultOrder && !usedDefaults) {
    const custom = rows.filter((row) => !isKnownPrompt(nonBlank(row.raw.identifier)?.trim() ?? '')).length;
    c.w.add(
      'no_global_order',
      'prompt_order',
      `no prompt_order for character ${ST_GLOBAL_ORDER_ID}; SillyTavern then uses its default order: its default prompts are sent (missing ones filled in), ${custom === 0 ? 'and the file has no others' : `the other ${custom} prompt(s) are imported disabled`}`,
    );
  }
  if (defaultOrder) items = ST_DEFAULT_ORDER as unknown[];
  if (items) {
    items.forEach((item, i) => {
      const path = defaultOrder ? 'prompt_order' : `${itemsPath}[${i}]`;
      if (!isRecord(item)) return c.w.add('invalid_value', path, 'order entry is not an object; skipped');
      const id = nonBlank(item.identifier)?.trim();
      if (id === undefined) return c.w.add('invalid_value', joinPath(path, 'identifier'), 'order entry without an identifier; skipped');
      let row = byId.get(id);
      if (!row) {
        const def = ST_DEFAULT_PROMPTS.find((p) => p.identifier === id);
        if (!def) return c.w.add('missing_prompt', joinPath(path, 'identifier'), `prompt_order references "${id}", which the preset lacks; skipped, as in ST`);
        // ST adds the defaults a preset lacks (checkForMissingPrompts), so the reference still resolves.
        // (Under ST's default order the no_global_order warning already says so.)
        if (!defaultOrder) c.w.add('default_prompt', joinPath(path, 'identifier'), `"${id}" is missing from prompts; SillyTavern's default "${id}" is used`);
        row = { raw: { ...def }, path: joinPath(path, 'identifier') };
        byId.set(id, row);
      }
      if (picked.has(row)) return c.w.add('duplicate_order_entry', joinPath(path, 'identifier'), `"${id}" is listed twice in the global order; the first place is kept`);
      picked.add(row);
      drafts.push(toDraft(row, orderEnabled(item.enabled), false, drafts.length, c));
    });
    // Unreferenced prompts are imported disabled: dropping them would be silent data loss.
    for (const row of rows) if (!picked.has(row)) drafts.push(toDraft(row, false, true, drafts.length, c));
  }
  return others.length > 0 ? { drafts, others } : { drafts };
}

// ---- passes over the blocks --------------------------------------------------------------------

const enabledHistory = (drafts: Draft[]): number =>
  drafts.reduce((n, d) => n + (d.block.enabled ? historySlots(d.block.content) : 0), 0);

/** Exactly one enabled, relative {{history}}: rp-core cannot send a chat without it (§10.2). */
function settleHistory(drafts: Draft[], c: Ctx): void {
  const marker = drafts.find((d) => d.ident === 'chatHistory' && d.slot !== undefined);
  // RoleCall: an enabled block holding {{message_history}} (already turned into {{history}} by
  // toDraft) is the chat; the marker then sends nothing. An ST preset without a chatHistory marker
  // but with RoleCall's macro in one block gets the same reading, with a warning.
  const rcHolders = drafts.filter((d) => d.block.enabled && d.slot === undefined && historySlots(d.block.content) > 0);
  if (!c.rc && !marker) {
    const candidates = drafts.filter((d) => d.block.enabled && d.slot === undefined && hasMessageHistory(d.block.content));
    if (candidates.length === 1) {
      const d = candidates[0]!;
      d.block.content = toHistorySlot(d.block.content);
      c.w.add('history_macro', joinPath(d.path, 'content'), "no chatHistory marker; RoleCall's {{message_history}} in this block is taken as the chat history");
      return void forceRelative(d, c);
    }
  }
  if (c.rc && rcHolders.length > 0 && marker?.block.enabled) {
    marker.block.enabled = false;
    c.w.add('history_macro', marker.path, "{{message_history}} places the chat; the chatHistory marker sends nothing, as in RoleCall");
  }
  if (enabledHistory(drafts) === 0) {
    if (marker) {
      marker.block.enabled = true;
      c.w.add('history_enabled', marker.path, 'chatHistory is disabled or not in the global order; rp-core cannot send a chat without it, so it is enabled');
    } else {
      drafts.push({
        block: { id: 'chatHistory', name: 'Chat History', role: 'system', enabled: true, content: '{{history}}', at: 'relative' },
        path: 'prompts',
        ident: 'chatHistory',
        slot: '{{history}}',
        unreferenced: false,
      });
      c.w.add('history_synthesised', 'prompts', 'the preset has no chatHistory marker; one is added at the end');
    }
  }
  const holder = drafts.find((d) => d.block.enabled && historySlots(d.block.content) > 0);
  if (holder) forceRelative(holder, c);
}

function forceRelative(d: Draft, c: Ctx): void {
  if (d.block.at === 'relative') return;
  d.block.at = 'relative';
  c.w.add('history_relative', joinPath(d.path, 'injection_position'), 'the chat history cannot be injected in-chat; placed relative');
}

/** RoleCall's fills (D-71 mixed): lore and persona always reach the prompt in an RC export. */
function rcAlwaysOn(drafts: Draft[], c: Ctx): void {
  const enabled = (): PresetBlock[] => drafts.filter((d) => d.block.enabled).map((d) => d.block);
  const carries = {
    worldInfoBefore: (b: PresetBlock) => carriesLore(b, 'before'),
    worldInfoAfter: (b: PresetBlock) => carriesLore(b, 'after'),
    personaDescription: (b: PresetBlock) => PERSONA_MACRO.test(b.content),
  } as const;
  // RoleCall's loader only sees enabled prompts: a disabled persona marker is invisible to it, and its
  // persona block is synthesised after main (below), not revived where the marker stands. The lore
  // markers are revived in place (RoleCall's structural lore placement is not covered by parity yet).
  for (const ident of ['worldInfoBefore', 'worldInfoAfter'] as const) {
    const d = drafts.find((x) => x.ident === ident && x.slot !== undefined);
    if (!d || d.block.enabled || enabled().some(carries[ident])) continue;
    d.block.enabled = true;
    c.w.add('rc_forced_on', d.path, `${ident} is disabled; a RoleCall preset always sends it, so it is enabled`);
  }
  const synth = (id: string, name: string, content: string, at: number): void => {
    drafts.splice(at, 0, {
      block: { id, name, role: 'system', enabled: true, content, at: 'relative' },
      path: 'prompts',
      ident: id,
      unreferenced: false,
    });
    c.w.add('rc_synthesised', 'prompts', `the RoleCall preset has no ${content} slot; a "${name}" block is added, as RoleCall does`);
  };
  // Lore goes next to the lore already there, else right above the chat (RoleCall's placement).
  const historyAt = (): number => {
    const i = drafts.findIndex((d) => d.block.enabled && historySlots(d.block.content) > 0);
    return i >= 0 ? i : drafts.length;
  };
  for (const [name, id, label] of [
    ['before', 'loreBefore', 'Lorebook (before)'],
    ['after', 'loreAfter', 'Lorebook (after)'],
  ] as const) {
    if (enabled().some((b) => carriesLore(b, name))) continue;
    const anchor = drafts.findIndex((d) => d.block.enabled && (carriesLore(d.block, 'before') || carriesLore(d.block, 'after')));
    synth(id, label, `{{lore::${name}}}`, anchor >= 0 ? anchor + (name === 'after' ? 1 : 0) : historyAt());
  }
  if (!enabled().some(carries.personaDescription)) {
    // RoleCall (preset-loader.ts): right after the first enabled main, else after jailbreak, else first.
    const main = drafts.findIndex((d) => d.block.enabled && d.ident === 'main');
    const anchor = main >= 0 ? main : drafts.findIndex((d) => d.block.enabled && d.ident === 'jailbreak');
    synth('personaInjection', 'Persona', '{{persona}}', anchor + 1);
  }
}

// ---- top-level settings ------------------------------------------------------------------------

interface Settings {
  value: Partial<Preset>;
  extras: Rec;
}

function readSettings(json: Rec, c: Ctx): Settings {
  const extras: Rec = {};
  const samplers: NonNullable<Preset['samplers']> = {};
  const invalid = (key: string, why: string): void => {
    extras[key] = json[key];
    c.w.add('invalid_value', key, `${key} ${why}; not imported (kept in extras)`);
  };
  const num = (key: string): number | undefined => {
    const v = json[key];
    if (v === undefined || v === null) return undefined;
    const n = optNum(v);
    if (n === undefined) invalid(key, `is not a number (${JSON.stringify(v)})`);
    return n;
  };
  for (const key of ['temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'] as const) {
    const n = num(key);
    if (n !== undefined) samplers[key] = n;
  }
  const seed = num('seed');
  if (seed !== undefined && seed >= 0) samplers.seed = Math.trunc(seed); // ST: -1 = a fresh seed every time
  const maxTokens = num('openai_max_tokens');
  if (maxTokens !== undefined) {
    if (maxTokens >= 1) samplers.max_tokens = Math.trunc(maxTokens);
    else invalid('openai_max_tokens', 'is below 1');
  }
  const maxContext = num('openai_max_context');
  let context: Preset['context'];
  if (maxContext !== undefined) {
    if (maxContext >= 1) context = { maxContext: Math.trunc(maxContext) };
    else invalid('openai_max_context', 'is below 1');
  }

  // ST's key is custom_prompt_post_processing; prompt_post_processing is RoleCall's own (D-71: an RC
  // export is read by RoleCall's rules), never ST's (§19.8).
  let postProcessing: Preset['postProcessing'];
  const ppKey = 'custom_prompt_post_processing' in json ? 'custom_prompt_post_processing' : c.rc ? 'prompt_post_processing' : undefined;
  if (ppKey !== undefined && json[ppKey] !== undefined && json[ppKey] !== null) {
    const raw = json[ppKey];
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    const base = typeof v === 'string' ? v.replace(/_tools$/, '') : undefined;
    postProcessing = base !== undefined ? POST_PROCESSING[base] : undefined;
    if (postProcessing === undefined) invalid(ppKey, `has an unknown value ${JSON.stringify(raw)}`);
    else if (base !== v) {
      extras[ppKey] = raw;
      c.w.add('not_honoured', ppKey, `${JSON.stringify(raw)}: tool calls are not kept apart; imported as '${postProcessing}'`);
    }
  }

  const str = (key: string): string | undefined => {
    const v = json[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') invalid(key, 'is not a string');
    return optStr(v);
  };
  const prefill = str('assistant_prefill');
  const impPrompt = str('impersonation_prompt');
  const impPrefill = str('assistant_impersonation');
  const impersonation = compact({ prompt: nonBlank(impPrompt), prefill: nonBlank(impPrefill) });
  // RoleCall's export route always writes the three template formats (its defaults when unset), but
  // RoleCall never applies them: an RC export keeps them in extras, unapplied (D-71 mixed).
  const template = (key: string): string | undefined => {
    if (!c.rc) return str(key);
    if (json[key] !== undefined && json[key] !== null) extras[key] = json[key];
    return undefined;
  };
  const formats = compact({
    wi: template('wi_format'),
    personality: template('personality_format'),
    scenario: template('scenario_format'),
    newChat: template('new_chat_prompt'),
    newExampleChat: template('new_example_chat_prompt'),
  });
  const rcTemplates = RC_TEMPLATE_FORMATS.filter((k) => c.rc && typeof json[k] === 'string' && (json[k] as string).trim() !== '');
  if (rcTemplates.length > 0) {
    c.w.add('rc_formats', rcTemplates[0]!, `${rcTemplates.join(', ')}: RoleCall never applies these formats, so they are not applied; kept in extras`);
  }

  const value: Partial<Preset> = compact({
    samplers: Object.keys(samplers).length > 0 ? samplers : undefined,
    context,
    prefill: nonBlank(prefill),
    impersonation: Object.keys(impersonation).length > 0 ? impersonation : undefined,
    postProcessing,
    formats: Object.keys(formats).length > 0 ? formats : undefined,
  });
  return { value, extras };
}

/**
 * The formats RoleCall's export writes and its assembler never applies (preset-loader.ts reads only
 * the prefill, impersonation and continue prompts; {{mesExamples}} is the raw mes_example).
 */
const RC_TEMPLATE_FORMATS = ['wi_format', 'personality_format', 'scenario_format', 'new_chat_prompt', 'new_example_chat_prompt'] as const;

const HONOURED = new Set([
  'name',
  'prompts',
  'prompt_order',
  'extensions',
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'openai_max_tokens',
  'openai_max_context',
  'custom_prompt_post_processing',
  'assistant_prefill',
  'impersonation_prompt',
  'assistant_impersonation',
  'wi_format',
  'personality_format',
  'scenario_format',
  'new_chat_prompt',
  'new_example_chat_prompt',
]);

/** Leftover top-level fields: connection settings dropped, the rest into extras (warned when live). */
function classifyLeftovers(json: Rec, extras: Rec, c: Ctx): void {
  for (const [k, v] of Object.entries(json)) {
    if (HONOURED.has(k) || k in extras) continue;
    if (isConnection(k)) continue; // never stored, not even in extras
    if (k === 'prompt_post_processing') {
      if (c.rc && !('custom_prompt_post_processing' in json)) continue; // read above
      extras[k] = v;
      if (typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'none') {
        c.w.add('not_honoured', k, "prompt_post_processing is RoleCall's key; SillyTavern's is custom_prompt_post_processing, so it is not honoured");
      }
      continue;
    }
    extras[k] = v;
    const rule = NOT_HONOURED[k];
    if (rule) {
      if (rule.active(v, json)) c.w.add('not_honoured', k, `not honoured: ${rule.what}; kept in extras`);
    } else if (!QUIET.has(k)) {
      c.w.add('unknown_field', k, `unknown preset field "${k}" kept in extras`);
    }
  }
}

/** `extensions`: kept whole in extras; regex scripts and other live extension data warn. */
function readExtensions(raw: unknown, extras: Rec, c: Ctx): void {
  if (raw === undefined || raw === null) return;
  if (!isRecord(raw)) {
    extras.extensions = raw;
    return c.w.add('invalid_value', 'extensions', 'extensions is not an object; kept in extras');
  }
  if (Object.keys(raw).length === 0) return;
  extras.extensions = raw;
  for (const [k, v] of Object.entries(raw)) {
    const path = joinPath('extensions', k);
    if (k === 'regex_scripts' || k === 'linkedRegexScripts') {
      if (nonEmptyList(v, {})) c.w.add('not_honoured', path, `${(v as unknown[]).length} regex script(s) are not honoured; kept in extras`);
    } else if (k === 'rolecall') {
      const rules = isRecord(v) && isRecord(v.prompt_regex_rules) ? v.prompt_regex_rules : {};
      const live = Object.values(rules).filter((x) => nonEmptyList(x, {})).length;
      if (live > 0) c.w.add('not_honoured', joinPath(path, 'prompt_regex_rules'), `RoleCall regex rules on ${live} prompt(s) are not honoured; kept in extras`);
    } else if (v !== undefined && v !== null && !(isRecord(v) && Object.keys(v).length === 0) && !(Array.isArray(v) && v.length === 0)) {
      c.w.add('unknown_field', path, `extension data "${k}" is not honoured; kept in extras`);
    }
  }
}

/**
 * D-70: every macro the core does not run is named at import (they stay literal text, §10.4):
 * SillyBunny's {{#if}} blocks and {{.var}} shorthands, RoleCall's {{if}}, {{choice}}, ... One
 * warning per name, counting the blocks; the prefill and impersonation texts too.
 */
function warnUnknownMacros(drafts: readonly Draft[], settings: Partial<Preset>, w: Warnings): void {
  const message = (name: string): string => `{{${name}}} is not an rp-core macro; it is sent as literal text`;
  for (const d of drafts) {
    for (const name of unknownMacrosIn(d.block.content)) w.fold('unknown_macro', joinPath(d.path, 'content'), 'prompts[*].content', message(name));
  }
  const texts: [string, string | undefined][] = [
    ['assistant_prefill', settings.prefill],
    ['impersonation_prompt', settings.impersonation?.prompt],
    ['assistant_impersonation', settings.impersonation?.prefill],
  ];
  for (const [path, text] of texts) if (text !== undefined) for (const name of unknownMacrosIn(text)) w.add('unknown_macro', path, message(name));
}

// ---- entry point -------------------------------------------------------------------------------

/** Convert a parsed ST chat-completion preset. `fallbackName` names it when the file does not. */
export function stPresetToPreset(json: unknown, fallbackName: string): Imported<Preset> {
  const w = new Warnings();
  const src: Rec = isRecord(json) ? json : {};
  if (!isRecord(json)) w.add('invalid_value', '$', 'the preset is not a JSON object; imported with default prompts');
  const rc = isRoleCallExport(src);
  const c: Ctx = { rc, rcBorn: !rc && hasRoleCallSigns(src), rcKept: 0, w };

  const { drafts, others } = sequence(src, c);
  const settings = readSettings(src, c);

  // Passes in order: the chat first (it anchors RoleCall's lore), then RoleCall's always-on slots.
  settleHistory(drafts, c);
  if (c.rc) {
    rcAlwaysOn(drafts, c);
    sortRcPins(drafts);
  }

  if (c.rcKept > 0) {
    w.add(
      'rc_signs',
      'prompts',
      `the file carries RoleCall signs (prompt_post_processing, {{message_history}}): its custom prompts are sent as RoleCall sends them; SillyTavern would not send ${c.rcKept} of them (system_prompt not false)`,
    );
  }

  // ST semantics (D-71): a disabled slot sends nothing. One warning per slot, never silent. (An RC
  // export's disabled persona marker is replaced by RoleCall's own persona block.)
  const personaBlock = c.rc && drafts.some((d) => d.ident === 'personaInjection' && d.block.enabled);
  for (const d of drafts) {
    if (d.slot === undefined || d.block.enabled || d.ident === 'chatHistory') continue;
    if (personaBlock && d.ident === 'personaDescription') continue;
    w.add('marker_disabled', d.path, `${d.ident} is ${d.unreferenced ? 'not in the global order' : 'disabled'}; its slot ${d.slot} sends nothing`);
  }

  if (c.rc) {
    const inChat = drafts.filter((d) => typeof d.block.at === 'object').length;
    const pins = drafts.filter((d) => d.block.at === 'top' || d.block.at === 'bottom').length;
    w.add('rc_export', 'extensions.rolecall', `RoleCall export: read with RoleCall's rules (in-chat depths +1 on ${inChat} block(s), ${pins} top/bottom pin(s) in injection_order, lore and persona always on, numeric {{random}} rewritten)`);
    // Every text the macro engine expands: block contents, the prefill and the impersonation texts.
    const rewrite = (text: string, path: string): string => {
      const r = rewriteRcRandom(text);
      for (const tag of r.wide) {
        w.add('rc_random_range', path, `${tag}: RoleCall's numeric range holds more than ${RC_RANDOM_MAX_VALUES} values; left as an ST choice`);
      }
      return r.text;
    };
    for (const d of drafts) d.block.content = rewrite(d.block.content, joinPath(d.path, 'content'));
    const s = settings.value;
    if (s.prefill !== undefined) s.prefill = rewrite(s.prefill, 'assistant_prefill');
    if (s.impersonation?.prompt !== undefined) s.impersonation.prompt = rewrite(s.impersonation.prompt, 'impersonation_prompt');
    if (s.impersonation?.prefill !== undefined) s.impersonation.prefill = rewrite(s.impersonation.prefill, 'assistant_impersonation');
  }

  warnUnknownMacros(drafts, settings.value, w);

  const extras: Rec = { ...settings.extras };
  readExtensions(src.extensions, extras, c);
  classifyLeftovers(src, extras, c);
  if (others) extras.prompt_order = others; // other characters' orders, verbatim

  const value: Preset = compact({
    name: nonBlank(src.name) ?? fallbackName,
    blocks: uniqueIds(drafts.map((d) => d.block)),
    ...settings.value,
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  });
  return { value, warnings: w.all() };
}
