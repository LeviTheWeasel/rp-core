// Ported from RoleCall:apps/rc/src/lib/personas/generatePersonaXml.ts@fb8dc623e (personaXml, a subset).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only: RoleCall's rows in an rc-recorder fixture → the core's inputs (docs/PARITY-RC.md).
// RoleCall reads characters, personas and presets from its database; the fixture declares those
// rows, and this file turns each into what the core takes:
// - a `characters` row → Character; RoleCall's own depth notes (details.prompt_depth_injections)
//   use RoleCall depth, so they go through fromRcDepth [D-12, D-47];
// - a `personas` row → Persona, its description being the XML RoleCall sends (generatePersonaXml);
// - `presets` + `preset_prompts` rows → the file RoleCall's export route writes for them (ST grammar
//   with extensions.rolecall), read by the core's own importer, which applies RoleCall's rules [D-71];
// - no preset → RoleCall's synthesised default prompt set (preset-loader
//   synthesizeDefaultPresetPrompts), written as core.preset/1.
// Nothing here ships: src/ never reads RoleCall's rows.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Character, ChatRole, ImportWarning, Persona, Preset } from '../../../src/formats/native.ts';
import { validateCharacter, validatePersona, validatePreset } from '../../../src/formats/native.ts';
import { stPresetToPreset } from '../../../src/formats/st-preset.ts';
import { fromRcDepth } from '../../../src/prompt/depth.ts';

export type Row = Record<string, unknown>;

/** One rc-recorder fixture: RoleCall's PromptAssemblyInput plus the rows its database double answers. */
export interface RcFixture {
  name: string;
  about: string;
  now: string;
  seed: number;
  db: { userId: string; tables: Record<string, Row[]>; rpc: Record<string, unknown> };
  /** The SillyTavern file RoleCall imported into the preset rows (preset fixtures only). */
  stPreset?: Record<string, unknown>;
  input: {
    characterId: string;
    chatId: string;
    presetId?: string;
    personaId?: string;
    promptEnabledStates?: Record<string, boolean>;
    messages: { role: 'user' | 'assistant'; content: string }[];
    currentMessage: string;
    contextLimit?: number;
    maxResponseTokens?: number;
  };
}

/** What RoleCall's assembler returned for it, pinned at VAUDEVILLE 68afe385. */
export interface RcRecorded {
  fixture: string;
  rolecall: string;
  conversationHistory: { role: 'system' | 'user' | 'assistant'; content: string }[];
  samplerSettings: Record<string, unknown> | null;
  presetName: string | null;
  assistantPrefill: string | null;
  budgetReport: Record<string, number> | null;
  messagesTrimmed: number | null;
  personaXml: string | null;
  writes: unknown[];
  reads: string[];
}

/** The commit RoleCall's assembler was recorded at (tools/rc-recorder PIN in Bunraku). */
export const RC_PIN = '68afe385987811c4c1b8594013b27e75bebbe8f2';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'rc-recorder');

export const loadFixture = (name: string): RcFixture =>
  JSON.parse(readFileSync(join(FIXTURES, 'fixtures', `${name}.json`), 'utf8')) as RcFixture;

export const loadRecorded = (name: string): RcRecorded =>
  JSON.parse(readFileSync(join(FIXTURES, 'recorded', `${name}.json`), 'utf8')) as RcRecorded;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const roleOf = (v: unknown): ChatRole => (v === 'user' || v === 'assistant' ? v : 'system');

/** The core rejects what it would not use; a converter bug must fail here, not inside assemble. */
function checked<T>(what: string, v: { ok: true; value: T } | { ok: false; errors: { path: string; message: string }[] }): T {
  if (!v.ok) throw new Error(`rc-recorder convert: ${what} is invalid: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  return v.value;
}

// ---- character -----------------------------------------------------------------------------------

/**
 * RoleCall's card depth note. Its own notes (details.prompt_depth_injections, enabled, non-blank)
 * win over an imported card's extensions.depth_prompt, as buildCardFieldMacroContext reads them.
 * RoleCall injects its own notes at RoleCall depth (lorebookDepthEntries), so they get +1; an ST
 * card's depth_prompt already uses ST depth. The core keeps one note: a row with more refuses.
 */
function depthPromptOf(row: Row): Character['depthPrompt'] {
  const details = isRow(row.details) ? row.details : {};
  const own = (Array.isArray(details.prompt_depth_injections) ? details.prompt_depth_injections : [])
    .filter(isRow)
    .filter((d) => d.enabled !== false && text(d.content).trim() !== '');
  if (own.length > 1) throw new Error('rc-recorder convert: the core takes one card depth note; this row has several');
  const note = own[0];
  if (note) {
    const raw = typeof note.depth === 'number' ? note.depth : Number.parseInt(text(note.depth), 10);
    const depth = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.floor(raw))) : 4;
    return { text: text(note.content).trim(), depth: fromRcDepth(depth), role: roleOf(note.role) };
  }
  const ext = isRow(row.extensions) && isRow(row.extensions.depth_prompt) ? row.extensions.depth_prompt : undefined;
  if (ext && text(ext.prompt).trim() !== '') {
    const depth = typeof ext.depth === 'number' ? ext.depth : 4;
    return { text: text(ext.prompt), depth, role: roleOf(ext.role) };
  }
  return undefined;
}

/** A RoleCall `characters` row as core.character/1; blank fields stay absent, as the card importer does. */
export function rcCharacter(row: Row): Character {
  const opt = (v: unknown): string | undefined => (text(v).trim() === '' ? undefined : text(v));
  const alternates = Array.isArray(row.alternate_greetings) ? row.alternate_greetings.map(text) : [];
  const c: Character = {
    name: text(row.name),
    description: text(row.description),
    greetings: [text(row.first_mes), ...alternates].filter((g) => g.trim() !== ''),
  };
  const fields: [keyof Character, string | undefined][] = [
    ['personality', opt(row.personality)],
    ['scenario', opt(row.scenario)],
    ['examples', opt(row.mes_example)],
    ['systemPrompt', opt(row.system_prompt)],
    ['postHistory', opt(row.post_history_instructions)],
  ];
  for (const [k, v] of fields) if (v !== undefined) (c as unknown as Row)[k] = v;
  const dp = depthPromptOf(row);
  if (dp) c.depthPrompt = dp;
  return checked('character', validateCharacter(c));
}

// ---- persona -------------------------------------------------------------------------------------

/** RoleCall's escapeXml for plain text (its tag-preserving branch is not needed: no fixture writes XML). */
const escapeXml = (s: string): string =>
  s
    .replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * generatePersonaXml for the text fields: identity (pronouns, title, height, age), then appearance,
 * personality, quirks and history in RoleCall's default section order, newlines condensed. Colours
 * and traits are not ported (no fixture has them): a row with them refuses.
 */
export function personaXml(name: string, details: Row): string {
  if (details.colors !== undefined || details.traits !== undefined || details.section_order !== undefined) {
    throw new Error('rc-recorder convert: persona colours, traits and section_order are not ported');
  }
  const lines = [`<persona name="${escapeXml(name)}">`];
  const identity = ['pronouns', 'title', 'height', 'age'].filter((k) => text(details[k]) !== '');
  if (identity.length > 0) {
    lines.push('  <identity>');
    for (const k of identity) lines.push(`    <${k}>${escapeXml(text(details[k]))}</${k}>`);
    lines.push('  </identity>');
  }
  for (const k of ['appearance', 'personality', 'quirks', 'history']) {
    const v = text(details[k]);
    if (v.trim() !== '') lines.push(`  <${k}>${escapeXml(v.replace(/\n+/g, '\n').trim())}</${k}>`);
  }
  lines.push('</persona>');
  return lines.join('\n');
}

/** A RoleCall `personas` row as core.persona/1: the description is the XML RoleCall sends. */
export function rcPersona(row: Row): Persona {
  const name = text(row.name);
  const p: Persona = { name, description: personaXml(name, isRow(row.details) ? row.details : {}) };
  return checked('persona', validatePersona(p));
}

// ---- presets -------------------------------------------------------------------------------------

/**
 * RoleCall's "no preset" prompt set (preset-loader synthesizeDefaultPresetPrompts at the pin) as
 * core.preset/1. RoleCall's macros become the core's slots: {{lore}} → {{lore::before}} with
 * {{lore::after}} beside it (as the importer fills an RC export), {{summary}} → {{recap}},
 * {{mes_example}} stays (a core alias of {{examples}}), and the in-chat {{message_history}} at
 * depth 0 is the chat itself, so it becomes the last, relative {{history}} block.
 */
export function rcNoPreset(): Preset {
  const block = (id: string, content: string): Preset['blocks'][number] => ({ id, role: 'system', enabled: true, content, at: 'relative' });
  const p: Preset = {
    name: 'No Preset (Defaults)',
    blocks: [
      block('charDescription', '{{description}}'),
      block('charPersonality', '{{personality}}'),
      block('scenario', '{{scenario}}'),
      block('personaDescription', '{{persona}}'),
      block('loreBefore', '{{lore::before}}'),
      block('loreAfter', '{{lore::after}}'),
      block('summary', '{{recap}}'),
      block('dialogueExamples', '{{mes_example}}'),
      block('chatHistory', '{{history}}'),
    ],
    // DEFAULT_MAX_RESPONSE_TOKENS: RoleCall carries a reply cap even without a preset.
    samplers: { max_tokens: 8192 },
    postProcessing: 'none',
  };
  return checked('no-preset', validatePreset(p));
}

/** The five structural markers RoleCall's serializePreset writes in ST's sparse four-key shape. */
const SPARSE_MARKERS = new Set(['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples', 'personaDescription']);

/** RoleCall's system_prompts blob keys, written at the top level of the export (toCanonicalSystemPrompts). */
const SYSTEM_PROMPT_KEYS = [
  'impersonation_prompt',
  'new_chat_prompt',
  'new_group_chat_prompt',
  'new_example_chat_prompt',
  'continue_nudge_prompt',
  'group_nudge_prompt',
  'assistant_prefill',
  'assistant_impersonation',
];

/**
 * The file RoleCall's export route (apps/rc/src/app/api/content/presets/[id]/export) writes for a
 * preset row and its prompt rows: prompts in sort_order, the global prompt_order with each
 * prompt's `enabled` (the request's promptEnabledStates applied, as a release state would be),
 * samplers and system prompts at the top level, and extensions.rolecall marking it a RoleCall
 * export. Template formats are left out: the rows carry none, and the assembler at the pin never
 * applied the defaults the route would add (docs/PARITY-RC.md).
 */
export function rcPresetExport(preset: Row, prompts: Row[], enabledStates: Record<string, boolean> = {}): Row {
  const rows = [...prompts].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const out: Row = { name: text(preset.name) };
  const num = (from: string, to = from): void => {
    if (typeof preset[from] === 'number') out[to] = preset[from];
  };
  for (const k of ['temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty']) num(k);
  num('max_context', 'openai_max_context');
  num('max_tokens', 'openai_max_tokens');
  if (typeof preset.prompt_post_processing === 'string') out.prompt_post_processing = preset.prompt_post_processing;
  const sp = isRow(preset.system_prompts) ? preset.system_prompts : {};
  for (const k of SYSTEM_PROMPT_KEYS) if (typeof sp[k] === 'string') out[k] = sp[k];

  out.prompts = rows.map((p) => {
    const identifier = text(p.identifier);
    if (p.marker === true && SPARSE_MARKERS.has(identifier)) {
      return { identifier, name: text(p.name), system_prompt: p.system_prompt === true, marker: true };
    }
    const prompt: Row = {
      identifier,
      name: text(p.name),
      content: text(p.content),
      role: roleOf(p.role),
      system_prompt: p.system_prompt === true,
      injection_position: typeof p.injection_position === 'number' ? p.injection_position : 0,
      injection_depth: typeof p.injection_depth === 'number' ? p.injection_depth : 4,
      injection_order: typeof p.injection_order === 'number' ? p.injection_order : 100,
      forbid_overrides: p.forbid_overrides === true,
      injection_trigger: Array.isArray(p.injection_trigger) ? p.injection_trigger : [],
    };
    if (p.marker === true) prompt.marker = true;
    return prompt;
  });
  out.prompt_order = [
    {
      character_id: 100001,
      order: rows.map((p) => ({ identifier: text(p.identifier), enabled: enabledStates[text(p.identifier)] ?? p.enabled === true })),
    },
  ];
  out.extensions = { rolecall: { schema_version: 1, edition_kind: 'rolecall' } };
  return out;
}

/**
 * An ST file with the request's toggles written into its global prompt_order. RoleCall applies
 * promptEnabledStates per request; the core has no per-request switch, so the file carries them.
 */
function withEnabledStates(file: Row, states: Record<string, boolean>): Row {
  const out = structuredClone(file);
  const orders = Array.isArray(out.prompt_order) ? out.prompt_order : [];
  for (const o of orders) {
    if (!isRow(o) || String(o.character_id) !== '100001' || !Array.isArray(o.order)) continue;
    for (const item of o.order) if (isRow(item) && text(item.identifier) in states) item.enabled = states[text(item.identifier)];
  }
  return out;
}

export interface ConvertedPreset {
  preset: Preset;
  warnings: ImportWarning[];
  /** The ST-grammar JSON that went through the importer (null for RoleCall's no-preset set). */
  file: Row | null;
}

/**
 * The fixture's preset as the core reads it:
 * - 'rc': RoleCall's export of its rows through the core's importer (RoleCall's rules, D-71);
 * - 'st': the SillyTavern file RoleCall imported, through the same importer (ST's rules);
 * - no preset id: RoleCall's synthesised default set ('st' has nothing to read then).
 */
export function fixturePreset(f: RcFixture, reading: 'rc' | 'st'): ConvertedPreset {
  if (f.input.presetId === undefined) {
    if (reading === 'st') throw new Error(`${f.name}: no preset, so there is no SillyTavern file to read`);
    return { preset: rcNoPreset(), warnings: [], file: null };
  }
  let file: Row;
  if (reading === 'st') {
    if (!f.stPreset) throw new Error(`${f.name}: the fixture carries no stPreset`);
    file = withEnabledStates(f.stPreset, f.input.promptEnabledStates ?? {});
  } else {
    const row = (f.db.tables.presets ?? []).find((p) => p.id === f.input.presetId);
    if (!row) throw new Error(`${f.name}: preset row ${f.input.presetId} is missing`);
    const prompts = (f.db.tables.preset_prompts ?? []).filter((p) => p.preset_id === f.input.presetId);
    file = rcPresetExport(row, prompts, f.input.promptEnabledStates);
  }
  const r = stPresetToPreset(structuredClone(file), f.name);
  return { preset: checked('preset', validatePreset(r.value)), warnings: r.warnings, file };
}
