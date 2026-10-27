// M2 scenarios for the "no tools ⇒ exactly M2" check (not a test file itself). Self-contained on
// purpose: it imports only modules M2 had unchanged (formats/native.ts, prompt/tokens.ts), so the
// same file runs against the M2 tree (git HEAD c478eed) to capture the digests pinned in
// no-tools.test.ts. Inputs avoid what M3 changes by design: stem books (text agent) and history
// messages with several text blocks (D-92 C4: one text block per message).
import { BUILTIN_PRESET, type Character, type LoreEntry, type Persona, type Preset } from '../../src/formats/native.ts';
import { CHARS_COUNTER, O200K_COUNTER } from '../../src/prompt/tokens.ts';
import type { AssembleInput } from '../../src/prompt/assemble.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
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
  depthPrompt: { text: '{{char}} never lies about maps.', depth: 2, role: 'system' },
};

export const LEVI: Persona = { name: 'Levi', description: 'A traveller with a broken compass.' };

type MsgOpts = { hidden?: boolean; greeting?: boolean; blocks?: Block[]; model?: { connection: string; model: string } };

/** A path message; `parent` is filled by `path()`. A `model` answer carries gen {kind 'model', connection, model}. */
export function msg(id: string, role: 'user' | 'assistant', text: string, opts: MsgOpts = {}): MessageView {
  const gen = opts.greeting ? { gen: { kind: 'greeting' as const } } : opts.model ? { gen: { kind: 'model' as const, ...opts.model } } : {};
  return {
    id,
    parent: null,
    role,
    blocks: opts.blocks ?? [{ k: 'text', text }],
    ...gen,
    hidden: opts.hidden ?? false,
    edited: false,
    swipe: { index: 0, count: 1 },
  };
}

/** The empty Compendium (agents/compendium EMPTY_COMPENDIUM), inline: M2 has no such module. */
const NO_NOTES = { entries: new Map(), rev: '', lastSeq: 0, issues: [], tasks: new Map(), effects: [] } as unknown as PathView['compendium'];

export function chain(msgs: MessageView[]): PathView {
  const linked = msgs.map((x, i) => ({ ...x, parent: i === 0 ? null : msgs[i - 1]!.id }));
  return {
    session: 's_m3',
    head: linked.at(-1)?.id ?? null,
    version: linked.length,
    path: linked,
    pathSet: new Set(linked.map((x) => x.id)),
    tails: [],
    vars: {},
    fires: [],
    castNames: ['Mira', 'Levi'],
    compendium: NO_NOTES,
  };
}

/** n exchanges after a greeting: G, U1, A1, … Un (a reply to Un). Each text is ~`size` characters. */
export function longChat(n: number, size = 60): MessageView[] {
  const out: MessageView[] = [msg('g', 'assistant', 'Hello, traveller.', { greeting: true })];
  for (let i = 1; i <= n; i++) {
    out.push(msg(`u${i}`, 'user', `U${i}: where does the road go next, ${'.'.repeat(size)}`));
    if (i < n) out.push(msg(`a${i}`, 'assistant', `A${i}: the road bends past the mill, ${'.'.repeat(size)}`, { model: { connection: 'local', model: 'm1' } }));
  }
  return out;
}

const entry = (id: string, patch: Partial<LoreEntry> = {}): LoreEntry => ({ id, content: `${id} text`, keys: [], position: 'before', ...patch });

export const LORE: AssembleInput['lorebooks'] = [
  {
    key: 'lib',
    book: {
      name: 'world',
      entries: [
        entry('always', { constant: true, content: 'The lighthouse keeper is {{char}}.' }),
        entry('mill', { keys: ['mill'], content: 'The mill burned last winter.', position: 'after' }),
        entry('deep', { constant: true, content: 'Fog rolls in at night.', position: { depth: 1, role: 'system' } }),
        entry('top', { constant: true, content: 'World: the Grey Coast.', position: 'top' }),
      ],
    },
  },
];

export function base(over: Partial<AssembleInput> = {}): AssembleInput {
  const view = over.view ?? chain(longChat(3));
  return {
    sessionId: 's_m3',
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
    counter: CHARS_COUNTER,
    ...over,
  };
}

/** A preset with a top block, a user-role block before the history, a prefill and new_chat. */
export const RICH: Preset = {
  name: 'rich',
  blocks: [
    { id: 'pinned', role: 'system', enabled: true, content: 'Pinned rules for {{char}}.', at: 'top' },
    { id: 'main', role: 'system', enabled: true, content: 'Write {{char}}.', at: 'relative' },
    { id: 'lore_before', role: 'system', enabled: true, content: '{{lore::before}}', at: 'relative' },
    { id: 'user_hint', role: 'user', enabled: true, content: 'Keep it short, {{char}}.', at: 'relative' },
    { id: 'lore_after', role: 'system', enabled: true, content: '{{lore::after}}', at: 'relative' },
    { id: 'history', role: 'system', enabled: true, content: '{{history}}', at: 'relative' },
    { id: 'jailbreak', role: 'system', enabled: true, content: 'Stay in the scene.', at: 'relative' },
    { id: 'tail', role: 'system', enabled: true, content: 'Bottom line.', at: 'bottom' },
  ],
  prefill: '{{char}}:',
  formats: { newChat: '[Start a new chat]' },
};

/** Every scenario: a name and the M2 (tools []) input. */
export function scenarios(): { name: string; input: AssembleInput }[] {
  const mixed = chain([
    msg('g', 'assistant', 'Hello, traveller.', { greeting: true }),
    msg('u1', 'user', 'Hi, {{char}}.'),
    msg('a1', 'assistant', '', {
      blocks: [
        { k: 'reasoning', text: 'secret thoughts' },
        { k: 'text', text: 'She nods.' },
      ],
      model: { connection: 'local', model: 'm1' },
    }),
    msg('u2', 'user', 'hidden aside', { hidden: true }),
    msg('a2', 'assistant', '   '),
    msg('u3', 'user', 'Show me the mill.'),
  ]);
  return [
    { name: 'builtin-short', input: base() },
    { name: 'mixed-history', input: base({ view: mixed }) },
    {
      name: 'lore-notes-guidance',
      input: base({
        view: chain(longChat(4)),
        lorebooks: LORE,
        authorNote: { text: 'Note: rain.', depth: 2, role: 'system' },
        guidance: { text: 'Make {{user}} wait.', rejected: 'An old draft.' },
        placements: [{ depth: 1, role: 'system', src: 'director', text: 'Direct the scene.' }],
      }),
    },
    { name: 'trimmed', input: base({ view: chain(longChat(40)), window: 3000, reserve: 500 }) },
    { name: 'trimmed-factor', input: base({ view: chain(longChat(40)), window: 3000, reserve: 500, tokenFactor: 1.3 }) },
    { name: 'greeting-dropped', input: base({ view: chain([msg('g', 'assistant', 'G'.repeat(1500), { greeting: true }), ...longChat(2).slice(1)]), window: 900, reserve: 300 }) },
    { name: 'exceeded', input: base({ view: chain(longChat(2, 3000)), window: 1200, reserve: 300 }) },
    { name: 'rich-prefill', input: base({ preset: RICH, lorebooks: LORE }) },
    { name: 'rich-strict-max', input: base({ preset: { ...RICH, postProcessing: 'strict', context: { maxMessages: 3 } }, view: chain(longChat(6)) }) },
    { name: 'continue-prefill', input: base({ view: chain(longChat(3).concat(msg('a3', 'assistant', 'The road', { model: { connection: 'local', model: 'm1' } }))), kind: 'continue' }) },
    {
      name: 'continue-cue',
      input: base({ view: chain(longChat(3).concat(msg('a3', 'assistant', 'The road'))), kind: 'continue', caps: { ...CAPS, prefill: 'none' } }),
    },
    { name: 'o200k', input: base({ view: chain(longChat(12)), lorebooks: LORE, counter: O200K_COUNTER, window: 2500, reserve: 400 }) },
  ];
}

/** The part of an assemble result M2 had, as canonical JSON (Maps and Sets never occur in it). */
export function m2Json(r: unknown): string {
  if (typeof r !== 'object' || r === null) return JSON.stringify(r);
  const { toolRoom: _room, kept: _kept, ...rest } = r as Record<string, unknown>;
  return JSON.stringify(rest);
}
