// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Test-only harness for the SillyTavern golden snapshots (test/golden/st/README.md, ARCHITECTURE.md
// §14 "Golden-фикстуры сборщика"): one captured case → rp-core's own importers (card, preset,
// world info) → assemble → shape with the preset's post-processing → the request as
// {role, content} rows, next to what SillyTavern sent (expected.json).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCardObject } from '../../src/formats/card.ts';
import type { Character, Persona, Preset } from '../../src/formats/native.ts';
import { stPresetToPreset } from '../../src/formats/st-preset.ts';
import { worldInfoToLoreBook } from '../../src/formats/st-worldinfo.ts';
import { assemble, type AssembleInput, type AssembleResult } from '../../src/prompt/assemble.ts';
import { contextWindow, replyReserve } from '../../src/prompt/budget.ts';
import { createMacroRun } from '../../src/prompt/macros.ts';
import { shape, type ShapeOutput } from '../../src/prompt/shape.ts';
import { O200K_COUNTER } from '../../src/prompt/tokens.ts';
import type { ModelCaps, PromptMsg } from '../../src/providers/types.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';
import { EMPTY_COMPENDIUM } from '../../src/agents/compendium/types.ts';

export const GOLDEN = join(import.meta.dir, 'st');
export const CASES = readdirSync(GOLDEN).filter((d) => /^\d\d-/.test(d)).sort();

/** gpt-4o on a Custom OpenAI-compatible source, as captured: system messages anywhere, no prefill. */
export const CAPS: ModelCaps = {
  dialect: 'openai-chat',
  maxTokensField: 'max_tokens',
  tools: 'native',
  toolChoice: ['auto', 'none'],
  toolChoiceHonored: true,
  parallelToolCalls: 'never',
  strictTools: false,
  structuredOutput: { mode: 'none' },
  midSystem: 'native',
  alternation: 'free',
  prefill: 'none',
  reasoning: { output: 'none', control: 'none', canDisable: true, echo: 'never' },
  samplers: { accepted: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'] },
  streamUsage: 'always',
  caching: 'none',
  maxInFlight: 1,
  contextLength: 128_000,
  source: ['script'],
};

export interface Row {
  role: string;
  content: string;
  name?: string;
}

interface ChatFile {
  about: string;
  messages: { user: boolean; text: string }[];
  note?: { text: string; depth: number };
}

export interface GoldenCase {
  name: string;
  about: string;
  character: Character;
  persona: Persona;
  preset: Preset;
  world?: ReturnType<typeof worldInfoToLoreBook>['value'];
  chat: ChatFile;
  expected: { messages: Row[]; params: Record<string, unknown> };
}

const read = (c: string, f: string): unknown => JSON.parse(readFileSync(join(GOLDEN, c, f), 'utf8'));

export function loadCase(name: string): GoldenCase {
  const chat = read(name, 'chat.json') as ChatFile;
  const persona = read(name, 'persona.json') as Persona;
  const worldFile = join(GOLDEN, name, 'world.json');
  return {
    name,
    about: chat.about,
    character: parseCardObject(read(name, 'card.json')).value,
    persona: { name: persona.name, description: persona.description },
    preset: stPresetToPreset(read(name, 'preset.json'), name).value,
    ...(existsSync(worldFile) ? { world: worldInfoToLoreBook(read(name, 'world.json'), 'world').value } : {}),
    chat,
    expected: read(name, 'expected.json') as GoldenCase['expected'],
  };
}

/** The chat as a PathView: the greeting stored as the engine stores it (identity macros expanded). */
function pathOf(c: GoldenCase): PathView {
  const greetingText = (text: string): string =>
    createMacroRun({
      char: c.character.name,
      user: c.persona.name,
      card: { description: '', personality: '', scenario: '', examples: '', systemPrompt: '', postHistory: '', firstMessage: '' },
      persona: '',
      vars: {},
      now: NOW,
      timeZone: 'UTC',
      seed: 0,
      sessionId: 'golden',
    }).userText(text);
  const msgs = c.chat.messages;
  const path: MessageView[] = msgs.map((m, i) => ({
    id: i === msgs.length - 1 ? 'current' : `m${i}`,
    parent: i === 0 ? null : `m${i - 1}`,
    role: m.user ? 'user' : 'assistant',
    blocks: [{ k: 'text', text: i === 0 ? greetingText(m.text) : m.text }],
    ...(i === 0 ? { gen: { kind: 'greeting' as const } } : {}),
    hidden: false,
    edited: false,
    swipe: { index: 0, count: 1 },
  }));
  return {
    session: 'golden',
    head: 'current',
    version: path.length,
    path,
    pathSet: new Set(path.map((m) => m.id)),
    tails: [],
    vars: {},
    fires: [],
    castNames: [c.character.name, c.persona.name],
    compendium: EMPTY_COMPENDIUM,
  };
}

const NOW = '2026-10-26T12:00:00.000Z';

export interface GoldenRun {
  c: GoldenCase;
  input: AssembleInput;
  result: Extract<AssembleResult, { ok: true }>;
  shaped: ShapeOutput;
  rows: Row[];
  /** The shaped messages, for src-aware normalisation. */
  messages: PromptMsg[];
}

export const textOf = (m: PromptMsg): string => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');

export function runCase(name: string): GoldenRun {
  const c = loadCase(name);
  const window = contextWindow({ caps: CAPS, local: false, preset: c.preset });
  const input: AssembleInput = {
    sessionId: 'golden',
    view: pathOf(c),
    upTo: 'current',
    kind: 'reply',
    cast: { character: c.character, persona: c.persona },
    preset: c.preset,
    lorebooks: c.world ? [{ key: 'world', book: c.world }] : [],
    counter: O200K_COUNTER,
    placements: [],
    ...(c.chat.note ? { authorNote: { text: c.chat.note.text, depth: c.chat.note.depth, role: 'system' as const } } : {}),
    caps: CAPS,
    window,
    reserve: replyReserve(window, c.preset.samplers?.max_tokens),
    seed: 1,
    now: NOW,
    timeZone: 'UTC',
    tools: [],
    prefillVsTools: 'prefill',
  };
  const result = assemble(input);
  if (!result.ok) throw new Error(`${name}: assemble refused: ${result.code}: ${result.message}`);
  const shaped = shape({
    messages: result.messages,
    caps: CAPS,
    prefill: result.prefill,
    kind: 'reply',
    postProcessing: c.preset.postProcessing,
    names: { char: c.character.name, user: c.persona.name },
  });
  return { c, input, result, shaped, messages: shaped.messages, rows: shaped.messages.map((m) => ({ role: m.role, content: textOf(m) })) };
}
