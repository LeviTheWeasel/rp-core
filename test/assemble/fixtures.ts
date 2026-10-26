// Fixtures for the assemble tests (not a test file itself).
import type { Character, Persona, Preset } from '../../src/formats/native.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import type { AssembleInput, AssembleResult } from '../../src/prompt/assemble.ts';
import type { ModelCaps, PromptMsg } from '../../src/providers/types.ts';
import type { Block } from '../../src/session/entries.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';

export const NOW = '2026-10-26T12:00:00.000Z';

export const CAPS: ModelCaps = {
  dialect: 'openai-chat',
  contextLength: 32768,
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
  samplers: { accepted: ['temperature'] },
  streamUsage: 'always',
  caching: 'none',
  maxInFlight: 1,
  source: ['script'],
};

export const MIRA: Character = {
  name: 'Mira',
  description: '{{char}} is a cartographer who maps dreams for {{user}}.',
  personality: 'Curious, dry.',
  scenario: 'A lighthouse at dusk.',
  greetings: ['Hello, traveller.'],
};

export const LEVI: Persona = { name: 'Levi', description: 'A traveller with a broken compass.' };

type MsgOpts = { hidden?: boolean; greeting?: boolean; blocks?: Block[] };

/** A path message; `parent` is filled by `path()`. */
export function m(id: string, role: 'user' | 'assistant', text: string, opts: MsgOpts = {}): MessageView {
  return {
    id,
    parent: null,
    role,
    blocks: opts.blocks ?? [{ k: 'text', text }],
    ...(opts.greeting ? { gen: { kind: 'greeting' as const } } : {}),
    hidden: opts.hidden ?? false,
    edited: false,
    swipe: { index: 0, count: 1 },
  };
}

export const greet = (id: string, text: string): MessageView => m(id, 'assistant', text, { greeting: true });

/** A PathView over the messages as one root → head chain. */
export function path(msgs: MessageView[], vars: Record<string, string | number> = {}): PathView {
  const chain = msgs.map((x, i) => ({ ...x, parent: i === 0 ? null : msgs[i - 1]!.id }));
  return {
    session: 's_test',
    head: chain.at(-1)?.id ?? null,
    version: chain.length,
    path: chain,
    pathSet: new Set(chain.map((x) => x.id)),
    tails: [],
    vars,
    fires: [],
    castNames: ['Mira', 'Levi'],
  };
}

/** G, U1, A1, U2 by default: a reply to U2. */
export const SHORT_PATH = (): MessageView[] => [
  greet('g', 'Hello, traveller.'),
  m('u1', 'user', 'Hi.'),
  m('a1', 'assistant', 'She nods.'),
  m('u2', 'user', 'Where are we?'),
];

export function input(over: Partial<AssembleInput> = {}): AssembleInput {
  const view = over.view ?? path(SHORT_PATH());
  return {
    sessionId: 's_test',
    view,
    upTo: view.path.at(-1)!.id,
    kind: 'reply',
    cast: { character: MIRA, persona: LEVI },
    preset: BUILTIN_PRESET,
    lorebooks: [],
    placements: [],
    caps: CAPS,
    window: 32768,
    reserve: 8192,
    seed: 42,
    now: NOW,
    timeZone: 'UTC',
    tools: [],
    prefillVsTools: 'prefill',
    // The token numbers these tests pin are M1's chars/3 estimate; o200k (the default) is tested in prompt-m2.
    counter: CHARS_COUNTER,
    ...over,
  };
}

/** The text of a message (its text blocks joined). */
export const textOf = (msg: PromptMsg): string => msg.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');

/** A compact `role|src|text` view of the request, the golden form. */
export const lines = (msgs: readonly PromptMsg[]): string[] => msgs.map((x) => `${x.role}|${x.src}|${textOf(x)}`);

/** Narrow to the ok branch or fail loudly. */
export function ok(r: AssembleResult): Extract<AssembleResult, { ok: true }> {
  if (!r.ok) throw new Error(`assemble failed: ${r.code}: ${r.message}`);
  return r;
}

/** A small preset with the history block between two relative blocks. */
export function preset(blocks: Preset['blocks'], extra: Partial<Preset> = {}): Preset {
  return { name: 'test', blocks, ...extra };
}

export const HISTORY_BLOCK: Preset['blocks'][number] = { id: 'history', role: 'system', enabled: true, content: '{{history}}', at: 'relative' };
