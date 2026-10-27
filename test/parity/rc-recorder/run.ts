// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Test-only harness for the RoleCall parity suite (docs/PARITY-RC.md): one rc-recorder fixture →
// the core's AssembleInput → assemble → shape with the preset's post-processing → the request as
// {role, content} rows, the form RoleCall's conversationHistory was recorded in.

import type { Character, Persona, Preset } from '../../../src/formats/native.ts';
import type { AssembleInput, AssembleResult } from '../../../src/prompt/assemble.ts';
import { assemble } from '../../../src/prompt/assemble.ts';
import { createMacroRun } from '../../../src/prompt/macros.ts';
import { shape, type ShapeOutput } from '../../../src/prompt/shape.ts';
import { CHARS_COUNTER, type TokenCounter } from '../../../src/prompt/tokens.ts';
import type { ModelCaps, PromptMsg } from '../../../src/providers/types.ts';
import type { MessageView, PathView } from '../../../src/session/view.ts';
import { fixturePreset, loadFixture, loadRecorded, rcCharacter, rcPersona, type RcFixture, type RcRecorded } from './convert.ts';
import { EMPTY_COMPENDIUM } from '../../../src/agents/compendium/types.ts';

/** A plain chat-completions model: system messages anywhere, free alternation, assistant prefill. */
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
  prefill: 'assistant-last',
  reasoning: { output: 'none', control: 'none', canDisable: true, echo: 'never' },
  samplers: { accepted: ['temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'] },
  streamUsage: 'always',
  caching: 'none',
  maxInFlight: 1,
  source: ['script'],
};

/** Window for fixtures where RoleCall ran no budget (no contextLimit): nothing is trimmed. */
export const UNBOUNDED_WINDOW = 1_000_000;
/** RoleCall's DEFAULT_MAX_RESPONSE_TOKENS, the reply cap it carries when nothing else sets one. */
export const RC_DEFAULT_REPLY = 8192;

export interface Row {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export const textOf = (m: PromptMsg): string => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');
export const rowsOf = (msgs: readonly PromptMsg[]): Row[] => msgs.map((m) => ({ role: m.role, content: textOf(m) }));

/** The path's own messages (greeting … current) as rows, the chat as the core stores it. */
export const pathRows = (view: PathView): Row[] =>
  view.path.map((m) => ({ role: m.role, content: m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('') }));

export interface Cast {
  character: Character;
  persona?: Persona;
}

export function castOf(f: RcFixture): Cast {
  const row = (f.db.tables.characters ?? []).find((c) => c.id === f.input.characterId);
  if (!row) throw new Error(`${f.name}: character row ${f.input.characterId} is missing`);
  const personaRow = f.input.personaId === undefined ? undefined : (f.db.tables.personas ?? []).find((p) => p.id === f.input.personaId);
  if (f.input.personaId !== undefined && !personaRow) throw new Error(`${f.name}: persona row ${f.input.personaId} is missing`);
  return { character: rcCharacter(row), ...(personaRow ? { persona: rcPersona(personaRow) } : {}) };
}

/**
 * The fixture's chat as a PathView: RoleCall's `messages` (oldest first) then the current message.
 * A first assistant message equal to the card's first_mes is the greeting, stored the way the engine
 * stores greetings (identity macros expanded at session creation, engine/session.ts); everything
 * else is stored as typed (history stays inert, user text gets identity macros at assembly).
 */
export function pathOf(f: RcFixture, cast: Cast): PathView {
  const firstMes = (f.db.tables.characters ?? []).find((c) => c.id === f.input.characterId)?.first_mes;
  const engineGreeting = (text: string): string =>
    createMacroRun({
      char: cast.character.name,
      user: cast.persona?.name || 'User',
      card: {
        description: cast.character.description,
        personality: cast.character.personality ?? '',
        scenario: cast.character.scenario ?? '',
        examples: cast.character.examples ?? '',
        systemPrompt: cast.character.systemPrompt ?? '',
        postHistory: cast.character.postHistory ?? '',
        firstMessage: cast.character.greetings[0] ?? '',
      },
      persona: cast.persona?.description ?? '',
      vars: {},
      now: f.now,
      timeZone: 'UTC',
      seed: 0,
      sessionId: sessionIdOf(f),
    }).userText(text);

  const all = [...f.input.messages, { role: 'user' as const, content: f.input.currentMessage }];
  const path: MessageView[] = all.map((m, i) => {
    const greeting = i === 0 && m.role === 'assistant' && m.content === firstMes;
    const id = i === all.length - 1 ? 'current' : `m${i}`;
    return {
      id,
      parent: i === 0 ? null : `m${i - 1}`,
      role: m.role,
      blocks: [{ k: 'text', text: greeting ? engineGreeting(m.content) : m.content }],
      ...(greeting ? { gen: { kind: 'greeting' as const } } : {}),
      hidden: false,
      edited: false,
      swipe: { index: 0, count: 1 },
    };
  });
  return {
    session: sessionIdOf(f),
    head: 'current',
    version: path.length,
    path,
    pathSet: new Set(path.map((m) => m.id)),
    tails: [],
    vars: {},
    fires: [],
    castNames: [cast.character.name, ...(cast.persona ? [cast.persona.name] : [])],
    compendium: EMPTY_COMPENDIUM,
  };
}

const sessionIdOf = (f: RcFixture): string => `rc-${f.input.chatId}`;

export interface RunOptions {
  /** Which reading of the preset (convert.ts fixturePreset); default 'rc'. */
  reading?: 'rc' | 'st';
  /** Replace the converted preset (e.g. the core's BUILTIN_PRESET). */
  preset?: Preset;
  window?: number;
  reserve?: number;
  /** Default CHARS_COUNTER, so pinned trim points do not move with the tokenizer. */
  counter?: TokenCounter;
}

export interface ParityRun {
  fixture: RcFixture;
  recorded: RcRecorded;
  preset: Preset;
  input: AssembleInput;
  result: AssembleResult;
  /** Present when assemble succeeded. */
  shaped?: ShapeOutput;
  /** The shaped request as {role, content}; [] when assemble refused. */
  rows: Row[];
}

/**
 * Run one fixture through the core. Window and reply reserve are RoleCall's own (contextLimit,
 * maxResponseTokens) when it ran a budget, otherwise large enough that nothing is trimmed. Tokens
 * are counted with CHARS_COUNTER unless a counter is given.
 */
export function runFixture(name: string, opts: RunOptions = {}): ParityRun {
  const fixture = loadFixture(name);
  const recorded = loadRecorded(name);
  const cast = castOf(fixture);
  const preset = opts.preset ?? fixturePreset(fixture, opts.reading ?? 'rc').preset;
  const view = pathOf(fixture, cast);
  const input: AssembleInput = {
    sessionId: sessionIdOf(fixture),
    view,
    upTo: 'current',
    kind: 'reply',
    cast,
    preset,
    lorebooks: [],
    counter: opts.counter ?? CHARS_COUNTER,
    placements: [],
    caps: CAPS,
    window: opts.window ?? fixture.input.contextLimit ?? UNBOUNDED_WINDOW,
    reserve: opts.reserve ?? fixture.input.maxResponseTokens ?? RC_DEFAULT_REPLY,
    seed: fixture.seed,
    now: fixture.now,
    timeZone: 'UTC',
    tools: [],
    prefillVsTools: 'prefill',
  };
  const result = assemble(input);
  if (!result.ok) return { fixture, recorded, preset, input, result, rows: [] };
  const shaped = shape({
    messages: result.messages,
    caps: CAPS,
    prefill: result.prefill,
    kind: 'reply',
    postProcessing: preset.postProcessing,
    names: { char: cast.character.name, user: cast.persona?.name || 'User' },
  });
  return { fixture, recorded, preset, input, result, shaped, rows: rowsOf(shaped.messages) };
}

/** The ok branch of a run, or a loud failure naming the refusal. */
export function okRun(run: ParityRun): ParityRun & { result: Extract<AssembleResult, { ok: true }>; shaped: ShapeOutput } {
  if (!run.result.ok) throw new Error(`${run.fixture.name}: assemble refused: ${run.result.code}: ${run.result.message}`);
  return run as ParityRun & { result: Extract<AssembleResult, { ok: true }>; shaped: ShapeOutput };
}
