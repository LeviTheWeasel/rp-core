// Ported from Bunraku:src/formats/_shared/kind-markers.ts@702d8120 and
// Bunraku:src/formats/_shared/repair-json.ts@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-kind markers and shape-only JSON repairs used by card detection and `rp-core import`
// (ARCHITECTURE.md D-72). The Tavern lineage ships many artifacts that look alike at the edges:
// presets carry `name` + `extensions`, world books carry `name` + `entries`. These predicates let
// one kind refuse another kind's file. All are pure and fail closed (false / null).

import { isRecord, type Rec } from './wire.ts';

/** `{exportedAt|version, type, data}`: the wrapper several web tools write around an export. */
export function isExportEnvelope(o: unknown): o is Rec & { type: string; data: Rec } {
  return (
    isRecord(o) &&
    typeof o.type === 'string' &&
    isRecord(o.data) &&
    (typeof o.exportedAt === 'string' || typeof o.version === 'string')
  );
}

/**
 * A SillyTavern settings-family export: chat-completion preset, text-completion preset (NovelAI,
 * KoboldAI, text generation), instruct or context template, system prompt or reasoning template.
 * Never a character or a book, whatever it bundles.
 */
export function looksLikeSettingsExport(o: unknown): boolean {
  if (!isRecord(o)) return false;
  return (
    Array.isArray(o.prompts) ||
    'prompt_order' in o ||
    'chat_completion_source' in o ||
    'temperature' in o ||
    'input_sequence' in o || // instruct template
    'story_string' in o || // context template
    // KoboldAI and text-generation presets write `temp`, not `temperature`; two of their sampler
    // fields, so one stray key in some other JSON is not enough.
    textCompletionKeys(o).length >= 2 ||
    formattingTemplateKind(o) !== null
  );
}

/**
 * An ST instruct or context template: a settings export for text completion, which carries none of
 * the chat-completion preset's fields. Null for anything else (including every chat-completion preset).
 */
export function textCompletionTemplateKind(o: unknown): 'instruct template' | 'context template' | null {
  if (!isRecord(o)) return null;
  if (Array.isArray(o.prompts) || 'prompt_order' in o || 'chat_completion_source' in o || 'temperature' in o) return null;
  if ('input_sequence' in o) return 'instruct template';
  if ('story_string' in o) return 'context template';
  return null;
}

/**
 * SillyTavern's other Advanced Formatting files (default/content/presets/sysprompt, reasoning): a
 * system prompt `{name, content, post_history}` or a reasoning template `{name, prefix, suffix,
 * separator}`. Null for anything else.
 */
export function formattingTemplateKind(o: unknown): 'system prompt' | 'reasoning template' | null {
  if (!isRecord(o) || Array.isArray(o.prompts) || 'prompt_order' in o || 'entries' in o) return null;
  if (typeof o.content === 'string' && typeof o.post_history === 'string') return 'system prompt';
  if (typeof o.prefix === 'string' && typeof o.suffix === 'string' && typeof o.separator === 'string') return 'reasoning template';
  return null;
}

/**
 * Fields only a SillyTavern chat-completion preset carries (D-72): its prompt manager (`prompts`,
 * `prompt_order`), its connection and context settings, or the pre-prompt-manager prompt fields.
 * A sampler such as `temperature` alone says nothing: NovelAI, KoboldAI and text-generation presets
 * have it too, and so does an API request body.
 */
const CHAT_COMPLETION_MARKERS = [
  'prompt_order',
  'chat_completion_source',
  'openai_max_context',
  'openai_max_tokens',
  'main_prompt',
  'nsfw_prompt',
  'jailbreak_prompt',
];

/** A SillyTavern chat-completion preset (or a RoleCall export, which is one). */
export function isChatCompletionPreset(o: unknown): boolean {
  return isRecord(o) && (Array.isArray(o.prompts) || CHAT_COMPLETION_MARKERS.some((k) => k in o));
}

/**
 * Sampler fields of SillyTavern's text-completion presets (default/content/presets/novel, kobold,
 * textgen) that no chat-completion preset writes. `top_a`, `min_p`, `top_k` are left out: an ST
 * chat-completion preset has them too.
 */
const TEXT_COMPLETION_KEYS = [
  'max_length',
  'min_length',
  'tail_free_sampling',
  'phrase_rep_pen',
  'repetition_penalty_range',
  'order',
  'temp',
  'rep_pen',
  'sampler_order',
  'sampler_priority',
  'rep_pen_range',
  'rep_pen_slope',
  'tfs',
  'typical',
  'mirostat',
  'mirostat_mode',
  'mirostat_tau',
  'typical_p',
  'temperature_last',
  'dry_multiplier',
  'ban_eos_token',
];

/** The text-completion sampler fields `o` has, in TEXT_COMPLETION_KEYS order. */
function textCompletionKeys(o: Rec): string[] {
  return TEXT_COMPLETION_KEYS.filter((k) => k in o);
}

/**
 * Which text-completion backend a preset's fields belong to, as SillyTavern files them: NovelAI
 * (`order`, `max_length`, `phrase_rep_pen`), text generation WebUI and friends (`sampler_priority`,
 * DRY, `temperature_last`), KoboldAI (`temp` with `sampler_order` and none of those). Null when
 * the fields do not say.
 */
function textCompletionBackend(o: Rec): 'NovelAI' | 'KoboldAI' | 'text-generation' | null {
  if ('order' in o && ('max_length' in o || 'phrase_rep_pen' in o || 'tail_free_sampling' in o)) return 'NovelAI';
  if ('sampler_priority' in o || 'samplers' in o || 'dry_multiplier' in o || 'temperature_last' in o || 'ban_eos_token' in o) return 'text-generation';
  if ('temp' in o && 'sampler_order' in o) return 'KoboldAI';
  return null;
}

/**
 * Why a settings-family export is not a chat-completion preset, or null when it is one: an instruct
 * or context template, a system prompt or reasoning template, an API request body, a
 * text-completion preset, or bare samplers.
 */
export function notChatCompletionReason(o: unknown): string | null {
  if (!isRecord(o) || isChatCompletionPreset(o)) return null;
  const template = textCompletionTemplateKind(o);
  if (template) return `this is a SillyTavern ${template} (text completion), not a chat-completion preset; it is not imported`;
  const formatting = formattingTemplateKind(o);
  if (formatting === 'system prompt') {
    return "this is a SillyTavern system prompt (Advanced Formatting), not a chat-completion preset; it is not imported (its text belongs in a preset's main prompt)";
  }
  if (formatting === 'reasoning template') {
    return 'this is a SillyTavern reasoning template (Advanced Formatting: prefix, suffix, separator), not a chat-completion preset; it is not imported';
  }
  if (Array.isArray(o.messages)) return 'this is an API request body (it has a messages list), not a preset; it is not imported';
  const tc = textCompletionKeys(o);
  if (tc.length > 0) {
    const backend = textCompletionBackend(o) ?? 'NovelAI, KoboldAI or text-generation';
    return `this is a SillyTavern text-completion preset (${backend} samplers: ${tc.slice(0, 3).join(', ')}), not a chat-completion preset; it is not imported`;
  }
  return 'this has samplers but no prompts, prompt_order or chat-completion settings, so it is not a SillyTavern chat-completion preset; it is not imported';
}

/**
 * Tagged as a RoleCall Compendium export (`format: 'rolecall-compendium'` or a `compendium-*`
 * schemaVersion), whatever its shape. No book reader but formats/compendium-v1.ts may claim such a
 * file: its rows carry `content` like a character_book, and reading it as one would lose the types.
 */
export function hasCompendiumTag(o: unknown): boolean {
  return (
    isRecord(o) &&
    (o.format === 'rolecall-compendium' || (typeof o.schemaVersion === 'string' && o.schemaVersion.startsWith('compendium-')))
  );
}

/** ST world info file: `entries` is a keyed OBJECT of ST-shaped entries (an array would be a character_book). */
export function looksLikeWorldInfo(o: unknown): boolean {
  if (!isRecord(o) || !isRecord(o.entries) || hasCompendiumTag(o)) return false;
  const values = Object.values(o.entries);
  if (values.length === 0) return true; // an empty ST book is still a book
  const first = values[0];
  return (
    isRecord(first) &&
    ('key' in first || 'keysecondary' in first || 'content' in first || 'comment' in first || 'uid' in first)
  );
}

/**
 * Standalone CCv2/CCv3 character_book (Chub lorebook download, `lorebook_v3` export, card-extracted
 * book): `entries` is an array of objects with `keys` or `content`. Agnai MemoryBooks
 * (`keywords` + `entry`) and RoleCall Compendium exports (hasCompendiumTag) are not this.
 */
export function looksLikeCharacterBook(o: unknown): boolean {
  const book = unwrapLorebookV3(o);
  if (!isRecord(book) || !Array.isArray(book.entries) || hasCompendiumTag(book)) return false;
  const first: unknown = book.entries[0];
  if (first === undefined) return 'scan_depth' in book || 'token_budget' in book || 'name' in book;
  if (!isRecord(first)) return false;
  if (Array.isArray(first.keywords) && typeof first.entry === 'string') return false;
  return Array.isArray(first.keys) || typeof first.content === 'string';
}

/** CCv3 standalone lorebook `{spec:'lorebook_v3', data:{...}}` → its data; anything else as-is. */
export function unwrapLorebookV3(o: unknown): unknown {
  return isRecord(o) && o.spec === 'lorebook_v3' && isRecord(o.data) ? o.data : o;
}

/**
 * A whole document that is a JSON string holding more JSON (stringify applied twice). Bounded to one
 * unwrap, and only when the inner text is an object or array, so a quoted word is never "repaired".
 */
export function unwrapDoubleEncoded(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  const first = value.trimStart()[0];
  if (first !== '{' && first !== '[') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Every reading of a parsed document worth trying, honest one first: as-is, then double-encoded
 * (and an envelope inside it), then the payload of an export envelope. A healthy file is never
 * touched by a repair because the original reading always comes first.
 */
export function readingsOf(value: unknown): unknown[] {
  const out: unknown[] = [value];
  const inner = unwrapDoubleEncoded(value);
  if (inner !== null) {
    out.push(inner);
    if (isExportEnvelope(inner)) out.push(inner.data);
  }
  if (isExportEnvelope(value)) out.push(value.data);
  return out;
}

/**
 * A visual-novel project (VAUDEVILLE `vn.json`, the inside of a `.vnpack`): it carries `name` and
 * `description` like a V1 card, plus cast, scenes and a story graph. Not a character (§10.5: later).
 */
export function looksLikeVnProject(o: unknown): boolean {
  return isRecord(o) && ('cast' in o || 'scenes' in o || 'story_graph' in o || 'vn_type' in o);
}

/**
 * An Agnai native export (`kind: 'character'`, `persona` object, `greeting`, `sampleChat`): its
 * `name` + `scenario` would pass for a V1 card while its real content sits in fields a card lacks.
 * Any object typed by a string `kind` is some app's own record, never a Tavern card.
 */
export function looksLikeAgnaiExport(o: unknown): boolean {
  return isRecord(o) && typeof o.kind === 'string';
}

/** Why a JSON object is another app's record and not a character card, or null. */
export function foreignKindReason(o: unknown): string | null {
  if (looksLikeVnProject(o)) return 'this is a visual-novel project (vn.json / .vnpack), not a character card; .vnpack import comes later';
  if (looksLikeAgnaiExport(o)) {
    const kind = String((o as Rec).kind);
    return kind === 'character'
      ? 'this is an Agnai character export (kind "character"), not a Tavern character card; Agnai import is not supported'
      : `this is a "${kind}" record of another app (it has a "kind" field), not a character card`;
  }
  return null;
}
