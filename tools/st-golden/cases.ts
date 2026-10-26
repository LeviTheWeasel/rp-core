// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Inputs of the SillyTavern golden snapshots (ARCHITECTURE.md §14 "Golden-фикстуры сборщика").
// Each case is a card, a persona, an ST chat-completion preset, an optional ST world book and a
// chat, written to test/golden/st/<case>/ in the formats ST itself reads and writes. stage.ts
// installs a case into a scratch SillyBunny, which sends the prompt to recorder.ts; save.ts turns
// the capture into expected.json. The test feeds the same files through rp-core's importers.
// Usage: bun tools/st-golden/cases.ts   (rewrites every case's inputs; expected.json is untouched)
//
// Rules for a case: no time or random macros (ST uses the wall clock and Math.random), entries
// with probability only 0 or 100, short chats that never reach the history budget, and token
// margins of 40+ around every budget line (ST counts with o200k for a gpt-4o model, as rp-core).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const OUT = join(ROOT, 'test', 'golden', 'st');
const SB_DEFAULT_PRESET = `${process.env.HOME ?? ''}/ST/SillyBunny/default/content/presets/openai/Default.json`;

type Json = Record<string, unknown>;

// ---- card, persona, chat ---------------------------------------------------------------------

interface CardSpec {
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt?: string;
  post_history_instructions?: string;
  depth_prompt?: { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' };
}

const BASE_CARD: CardSpec = {
  description: '{{char}} keeps the lighthouse on the island of Vell. She has known {{user}} since they were children.',
  personality: 'dry, patient, quietly funny',
  scenario: 'A storm night at the Vell lighthouse. {{user}} has just come in from the boat.',
  first_mes: '*Mira looks up from the logbook.* You came through that weather? Sit down and dry off.',
  mes_example: '<START>\n{{user}}: Is the lamp lit?\n{{char}}: Since dusk. It always is.',
};

/** A CCv2 card with the legacy top-level fields too (ST writes both). */
function card(spec: CardSpec): Json {
  const data = {
    name: 'Mira',
    description: spec.description,
    personality: spec.personality,
    scenario: spec.scenario,
    first_mes: spec.first_mes,
    mes_example: spec.mes_example,
    creator_notes: '',
    system_prompt: spec.system_prompt ?? '',
    post_history_instructions: spec.post_history_instructions ?? '',
    alternate_greetings: [],
    tags: [],
    creator: 'rp-core golden',
    character_version: '1',
    extensions: {
      talkativeness: '0.5',
      fav: false,
      world: '',
      depth_prompt: spec.depth_prompt ?? { prompt: '', depth: 4, role: 'system' },
    },
  };
  return {
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  };
}

const PERSONA = { name: 'Levi', description: '{{user}} is a cartographer who maps the northern coast.' };

interface ChatSpec {
  /** Alternating from the greeting (assistant) on; the last one is the user's current message. */
  messages: { user: boolean; text: string }[];
  /** ST author's note (chat_metadata note_*): in-chat at `depth`, role system. */
  note?: { text: string; depth: number };
}

// ---- preset ----------------------------------------------------------------------------------

interface PromptSpec {
  identifier: string;
  name: string;
  content: string;
  role?: 'system' | 'user' | 'assistant';
  /** In-chat injection (injection_position 1). */
  depth?: number;
  order?: number;
  enabled?: boolean;
  /** Insert into prompt_order 100001 after this identifier (default: before chatHistory). */
  after?: string;
}

interface PresetSpec {
  prompts?: PromptSpec[];
  set?: Json;
  /** Identifiers to disable in prompt_order 100001. */
  disable?: string[];
}

function preset(spec: PresetSpec = {}): Json {
  const p = JSON.parse(readFileSync(SB_DEFAULT_PRESET, 'utf8')) as Json & {
    prompts: Json[];
    prompt_order: { character_id: number; order: { identifier: string; enabled: boolean }[] }[];
  };
  const order = p.prompt_order.find((o) => o.character_id === 100001)!.order;
  for (const ps of spec.prompts ?? []) {
    p.prompts.push({
      identifier: ps.identifier,
      name: ps.name,
      system_prompt: false,
      role: ps.role ?? 'system',
      content: ps.content,
      injection_position: ps.depth === undefined ? 0 : 1,
      injection_depth: ps.depth ?? 4,
      injection_order: ps.order ?? 100,
      forbid_overrides: false,
    });
    const at = ps.after ? order.findIndex((o) => o.identifier === ps.after) + 1 : order.findIndex((o) => o.identifier === 'chatHistory');
    order.splice(at, 0, { identifier: ps.identifier, enabled: ps.enabled ?? true });
  }
  for (const id of spec.disable ?? []) order.find((o) => o.identifier === id)!.enabled = false;
  Object.assign(p, spec.set ?? {});
  return p;
}

// ---- world -----------------------------------------------------------------------------------

interface EntrySpec {
  comment: string;
  content: string;
  key?: string[];
  keysecondary?: string[];
  /** ST: 0 and_any, 1 not_all, 2 not_any, 3 and_all. */
  selectiveLogic?: number;
  constant?: boolean;
  order?: number;
  /** ST enum: 0 before, 1 after, 2 AN top, 3 AN bottom, 4 at depth, 5 EM top, 6 EM bottom, 7 outlet. */
  position?: number;
  depth?: number;
  /** 0 system, 1 user, 2 assistant (position 4 only). */
  role?: number;
  probability?: number;
  scanDepth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  preventRecursion?: boolean;
  excludeRecursion?: boolean;
  ignoreBudget?: boolean;
  outletName?: string;
  disable?: boolean;
}

function world(entries: EntrySpec[]): Json {
  const out: Record<string, Json> = {};
  entries.forEach((e, uid) => {
    out[String(uid)] = {
      uid,
      key: e.key ?? [],
      keysecondary: e.keysecondary ?? [],
      comment: e.comment,
      content: e.content,
      constant: e.constant ?? false,
      vectorized: false,
      selective: true,
      selectiveLogic: e.selectiveLogic ?? 0,
      addMemo: true,
      order: e.order ?? 100,
      position: e.position ?? 0,
      disable: e.disable ?? false,
      ignoreBudget: e.ignoreBudget ?? false,
      excludeRecursion: e.excludeRecursion ?? false,
      preventRecursion: e.preventRecursion ?? false,
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
      delayUntilRecursion: false,
      probability: e.probability ?? 100,
      useProbability: true,
      depth: e.depth ?? 4,
      outletName: e.outletName ?? '',
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: e.scanDepth ?? null,
      caseSensitive: e.caseSensitive ?? null,
      matchWholeWords: e.matchWholeWords ?? null,
      useGroupScoring: null,
      automationId: '',
      role: e.role ?? null,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      triggers: [],
      displayIndex: uid,
      characterFilter: { isExclude: false, names: [], tags: [] },
    };
  });
  return { entries: out, name: 'golden' };
}

/** A paragraph of about `tokens` o200k tokens (ordinary English words are about one token each). */
function filler(label: string, tokens: number): string {
  const words = ['salt', 'rope', 'tide', 'stone', 'gull', 'mist', 'oar', 'reef', 'wick', 'glass'];
  const out: string[] = [label];
  for (let i = 0; out.length < tokens; i++) out.push(words[i % words.length]!);
  return `${out.join(' ')}.`;
}

// ---- the cases -------------------------------------------------------------------------------

interface Case {
  about: string;
  card: CardSpec;
  preset: PresetSpec;
  world?: EntrySpec[];
  chat: ChatSpec;
}

const CHAT_LANTERN: ChatSpec = {
  messages: [
    { user: false, text: BASE_CARD.first_mes },
    { user: true, text: 'I shake the rain off and set my satchel down. The ferry nearly turned back.' },
    { user: false, text: '*She pours tea without asking.* It should have. Nobody crosses on a night like this.' },
    { user: true, text: 'I lift the lantern and look toward the harbor.' },
  ],
};

const CASES: Record<string, Case> = {
  '01-default-preset': {
    about: "ST's Default preset with a card that uses every field: system prompt override with {{original}}, post-history instructions, depth prompt, examples, persona.",
    card: {
      ...BASE_CARD,
      system_prompt: '{{original}} Keep {{char}} dry and brief.',
      post_history_instructions: 'Reply in under 120 words.',
      depth_prompt: { prompt: '{{char}} is tired tonight.', depth: 2, role: 'system' },
    },
    preset: {},
    chat: CHAT_LANTERN,
  },
  '02-wi-positions': {
    about: 'One world entry per ST position (0–7), several orders, an outlet named by a preset prompt, and an author\'s note for positions 2/3.',
    card: BASE_CARD,
    preset: {
      prompts: [{ identifier: 'outletBlock', name: 'Outlet block', content: 'Scene notes: {{outlet::scene}}', after: 'worldInfoAfter' }],
    },
    world: [
      { comment: 'before constant', content: 'WI before, constant, order 100.', constant: true, position: 0, order: 100 },
      { comment: 'before keyed', content: 'WI before, keyed lantern, order 50.', key: ['lantern'], position: 0, order: 50 },
      { comment: 'after', content: 'WI after, keyed lantern.', key: ['lantern'], position: 1 },
      { comment: 'AN top', content: 'WI AN top, keyed harbor.', key: ['harbor'], position: 2 },
      { comment: 'AN bottom', content: 'WI AN bottom, keyed harbor.', key: ['harbor'], position: 3 },
      { comment: 'depth 0 system', content: 'WI depth 0 system, order 100.', key: ['lantern'], position: 4, depth: 0, role: 0, order: 100 },
      { comment: 'depth 0 system early', content: 'WI depth 0 system, order 50.', key: ['lantern'], position: 4, depth: 0, role: 0, order: 50 },
      { comment: 'depth 1 user', content: 'WI depth 1 user.', key: ['lantern'], position: 4, depth: 1, role: 1 },
      { comment: 'depth 9 assistant', content: 'WI depth 9 assistant (past the chat).', key: ['lantern'], position: 4, depth: 9, role: 2 },
      { comment: 'EM top', content: 'WI examples top, keyed harbor.', key: ['harbor'], position: 5 },
      { comment: 'EM bottom', content: 'WI examples bottom, keyed harbor.', key: ['harbor'], position: 6 },
      { comment: 'outlet', content: 'WI outlet scene, keyed lantern.', key: ['lantern'], position: 7, outletName: 'scene' },
      { comment: 'outlet unused', content: 'WI outlet nowhere, keyed lantern.', key: ['lantern'], position: 7, outletName: 'nowhere' },
      { comment: 'disabled', content: 'WI disabled entry.', key: ['lantern'], disable: true },
    ],
    chat: { ...CHAT_LANTERN, note: { text: "Author's note: keep the storm audible.", depth: 2 } },
  },
  '03-wi-keys': {
    about: 'Key matching: whole words (Latin and Cyrillic), case sensitivity, regex keys, secondary logic, per-entry scan depth, speaker names in the scan text. Every entry has preventRecursion, so only direct matches fire.',
    card: BASE_CARD,
    preset: {},
    world: [
      { comment: 'whole word miss', content: 'KEY lamp (whole word; text has lamppost only).', key: ['lamp'], preventRecursion: true },
      { comment: 'substring hit', content: 'KEY lamp (substring allowed).', key: ['lamp'], matchWholeWords: false, preventRecursion: true },
      { comment: 'case sensitive miss', content: 'KEY Kettle (case-sensitive; text has kettle).', key: ['Kettle'], caseSensitive: true, preventRecursion: true },
      { comment: 'case insensitive hit', content: 'KEY KETTLE (case-insensitive).', key: ['KETTLE'], preventRecursion: true },
      { comment: 'regex hit', content: 'KEY /ket+le/i regex.', key: ['/KET+LE/i'], preventRecursion: true },
      { comment: 'cyrillic whole word', content: 'KEY мир (whole word; text has мирный).', key: ['мир'], preventRecursion: true },
      { comment: 'cyrillic exact', content: 'KEY маяк (whole word, present).', key: ['маяк'], preventRecursion: true },
      { comment: 'multi word', content: 'KEY "old ferry" (several words).', key: ['old ferry'], preventRecursion: true },
      { comment: 'speaker name', content: 'KEY Levi (only as the speaker name).', key: ['Levi'], preventRecursion: true },
      { comment: 'and_any', content: 'SEC and_any (kettle + [nope, lamppost]).', key: ['kettle'], keysecondary: ['nope', 'lamppost'], selectiveLogic: 0, preventRecursion: true },
      { comment: 'not_all', content: 'SEC not_all (kettle + [lamppost, nope]).', key: ['kettle'], keysecondary: ['lamppost', 'nope'], selectiveLogic: 1, preventRecursion: true },
      { comment: 'not_any', content: 'SEC not_any (kettle + [lamppost]) must not fire.', key: ['kettle'], keysecondary: ['lamppost'], selectiveLogic: 2, preventRecursion: true },
      { comment: 'and_all', content: 'SEC and_all (kettle + [lamppost, ferry]).', key: ['kettle'], keysecondary: ['lamppost', 'ferry'], selectiveLogic: 3, preventRecursion: true },
      { comment: 'scan depth 2 miss', content: 'DEPTH anchor (only 3 messages back).', key: ['anchor'], preventRecursion: true },
      { comment: 'scan depth 4 hit', content: 'DEPTH anchor with scanDepth 4.', key: ['anchor'], scanDepth: 4, preventRecursion: true },
    ],
    chat: {
      messages: [
        { user: false, text: BASE_CARD.first_mes },
        { user: true, text: 'I tie the boat to the anchor ring outside.' },
        { user: false, text: 'Good. The old ferry rope rots in this weather.' },
        { user: true, text: 'Мирный вечер, правда? Маяк горит. I set the kettle by the lamppost.' },
      ],
    },
  },
  '04-wi-budget': {
    about: 'The lore budget: 25 % of (max context 1200 − max tokens 200) = 250 tokens; higher order wins, a failed probability roll costs nothing, overflow stops all but ignoreBudget.',
    card: BASE_CARD,
    preset: { set: { openai_max_context: 1200, openai_max_tokens: 200 } },
    world: [
      { comment: 'never', content: filler('NEVER (probability 0, order 500).', 86), key: ['lantern'], order: 500, probability: 0 },
      { comment: 'first', content: filler('FIRST (order 400).', 86), key: ['lantern'], order: 400 },
      { comment: 'second', content: filler('SECOND (order 300).', 86), key: ['lantern'], order: 300 },
      { comment: 'third cut', content: filler('THIRD (order 200, over the budget).', 86), key: ['lantern'], order: 200 },
      { comment: 'fourth after overflow', content: 'FOURTH (order 100, small, after the overflow).', key: ['lantern'], order: 100 },
      { comment: 'ignores budget', content: filler('IGNORE (ignoreBudget, order 50).', 86), key: ['lantern'], order: 50, ignoreBudget: true },
    ],
    chat: CHAT_LANTERN,
  },
  '05-wi-recursion': {
    about: 'Recursion: a fired entry wakes others through its text; preventRecursion and excludeRecursion; three levels deep.',
    card: BASE_CARD,
    preset: {},
    world: [
      { comment: 'root', content: 'ROOT: the lantern was a gift from the tidewatch.', key: ['lantern'] },
      { comment: 'level 1', content: 'LEVEL1: the tidewatch keeps a signal horn.', key: ['tidewatch'] },
      { comment: 'level 2', content: 'LEVEL2: the signal horn wakes the keeper.', key: ['signal horn'] },
      { comment: 'level 3', content: 'LEVEL3: the keeper remembers.', key: ['keeper'] },
      { comment: 'excluded', content: 'EXCLUDED: tidewatch entry that recursion may not wake.', key: ['tidewatch'], excludeRecursion: true },
      { comment: 'prevent', content: 'PREVENT: mentions the beacon but starts no recursion.', key: ['harbor'], preventRecursion: true },
      { comment: 'beacon', content: 'BEACON: only reachable through PREVENT, so it stays silent.', key: ['beacon'] },
    ],
    chat: CHAT_LANTERN,
  },
  '06-depth-sources': {
    about: 'In-chat inserts from every source at the same depths: preset prompts (injection_position 1, orders, roles), card depth prompt, author\'s note and world entries.',
    card: { ...BASE_CARD, depth_prompt: { prompt: 'CARD depth 1 note.', depth: 1, role: 'system' } },
    preset: {
      prompts: [
        { identifier: 'inj0', name: 'Depth 0 system', content: 'PRESET depth 0 system.', depth: 0 },
        { identifier: 'inj1a', name: 'Depth 1 user', content: 'PRESET depth 1 user, order 100.', depth: 1, role: 'user' },
        { identifier: 'inj1b', name: 'Depth 1 system early', content: 'PRESET depth 1 system, order 10.', depth: 1, order: 10 },
        { identifier: 'inj9', name: 'Depth 9 assistant', content: 'PRESET depth 9 assistant.', depth: 9, role: 'assistant' },
      ],
    },
    world: [{ comment: 'depth 1', content: 'WI depth 1 system.', key: ['lantern'], position: 4, depth: 1, role: 0 }],
    chat: { ...CHAT_LANTERN, note: { text: 'NOTE at depth 1.', depth: 1 } },
  },
  '07-macros': {
    about: 'Macros: unknown ones stay literal, legacy <USER>/<BOT>, comments, trim, variables, and a user message holding macros.',
    card: { ...BASE_CARD, personality: '<BOT> is dry with <USER>.' },
    preset: {
      prompts: [
        {
          identifier: 'macroBlock',
          name: 'Macro block',
          content: '{{// a comment}}Unknown: {{nonsense}}. {{setvar::mood::wary}}Mood: {{getvar::mood}}. Names: {{char}}/{{user}}.{{trim}}',
          after: 'main',
        },
      ],
    },
    chat: {
      messages: [
        { user: false, text: BASE_CARD.first_mes },
        { user: true, text: 'I say {{char}} out loud and write {{nonsense}} on the fogged glass.' },
      ],
    },
  },
};

// ---- write -----------------------------------------------------------------------------------

for (const [name, c] of Object.entries(CASES)) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const write = (file: string, value: unknown): void => writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  write('card.json', card(c.card));
  write('persona.json', PERSONA);
  write('preset.json', preset(c.preset));
  if (c.world) write('world.json', world(c.world));
  write('chat.json', { about: c.about, ...c.chat });
  console.log(`wrote ${name}`);
}
