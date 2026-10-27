// Shared setup for the M3 loop tests (not a test file itself): an engine on a scripted provider with
// tools in its caps, fake tools through the EngineSeams.toolSets test seam, and a character whose
// book holds an entry that never fires (so the lore set is offered, decisions C1).
import { Engine, type EngineSeams } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, EngineOptions, SessionHandle, TurnHandle, TurnOutcome } from '../../src/engine/api.ts';
import type { ToolSets } from '../../src/engine/request.ts';
import type { Character, LoreBook } from '../../src/formats/native.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import type { Event } from '../../src/protocol/events.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest } from '../../src/providers/types.ts';
import type { Entry, MsgEntry, PrepEntry, Trace } from '../../src/session/entries.ts';
import type { Tool, ToolCtx, ToolOutput } from '../../src/tools/types.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { drain, entriesOf, LEVI } from '../engine/kit.ts';

export { calls, drain, entriesOf, LEVI, textOf, until } from '../engine/kit.ts';

/** SCRIPT_CAPS with a tool transport (and any other fields). */
export function capsWith(tools: ModelCaps['tools'], more: Partial<ModelCaps> = {}): ModelCaps {
  return { ...structuredClone(SCRIPT_CAPS), tools, ...more };
}

/** A book whose only entry is keyed on a word no test says: it never fires, so the lore set is offered. */
export const SLEEPING_BOOK: LoreBook = {
  name: 'World',
  entries: [{ id: 'e1', title: 'Unicorns', keys: ['unicorn'], content: 'Unicorns live in the north.', position: 'before' }],
};

/** Mira with the sleeping book. */
export const MIRA_TOOLS: Character = {
  name: 'Mira',
  description: '{{char}} maps dreams for {{user}}.',
  personality: 'Curious, dry.',
  greetings: ['Hello, {{user}}. I am {{char}}.'],
  book: SLEEPING_BOOK,
};

/** What the fake tools saw: one entry per run (not per call). */
export interface ToolLog {
  runs: { name: string; args: Record<string, unknown>; pageChars: number; signal: AbortSignal }[];
}

const LOOKUP_SCHEMA = {
  type: 'object',
  properties: { q: { type: 'string', description: 'what to look up' } },
  required: ['q'],
  additionalProperties: false,
};

/** lookup {q}: `found <q>` (Bunraku's fixture tool). */
export function lookupTool(log: ToolLog, name = 'lookup', answer: (q: string) => string = (q) => `found ${q}`): Tool {
  return {
    name,
    description: 'Look something up.',
    schema: LOOKUP_SCHEMA,
    effect: 'read',
    async run(args, ctx: ToolCtx): Promise<ToolOutput> {
      log.runs.push({ name, args, pageChars: ctx.pageChars, signal: ctx.signal });
      const q = String(args['q']);
      return { text: answer(q), summary: `1 hit for ${q}` };
    },
  };
}

/** A tool that waits until `gate` resolves or its signal aborts (for Stop during a tool). */
export function slowTool(log: ToolLog, gate: Promise<void>, name = 'slow'): Tool {
  return {
    name,
    description: 'Takes its time.',
    schema: LOOKUP_SCHEMA,
    effect: 'read',
    async run(args, ctx): Promise<ToolOutput> {
      log.runs.push({ name, args, pageChars: ctx.pageChars, signal: ctx.signal });
      await new Promise<void>((resolve) => {
        void gate.then(resolve);
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { text: 'slow result', summary: 'done' };
    },
  };
}

/** The test seam: the given tools are the lore set (and the history set, when a test asks). */
export function sets(lore: Tool[], history: Tool[] = []): ToolSets {
  return { history: () => history, lore: () => lore };
}

export interface Rig {
  home: string;
  engine: EngineHandle;
  conn: Connection;
  provider: ScriptedProvider;
  log: ToolLog;
}

export interface RigOptions {
  caps?: ModelCaps;
  /** The tool sets; default: lookup as the lore set. */
  toolSets?: ToolSets;
  connections?: Record<string, Connection>;
  extra?: Partial<EngineOptions> & EngineSeams;
  home?: string;
}

/** An engine with one scripted connection 'script' (the narrator binding), counting chars/3. */
export async function rig(script: ScriptCall[], opts: RigOptions = {}): Promise<Rig> {
  const home = opts.home ?? tmpHome();
  const provider = createScriptedProvider(script);
  const conn: Connection = { id: 'script', provider, caps: opts.caps ?? capsWith('native'), origin: 'script:script', local: true };
  const log: ToolLog = { runs: [] };
  const engine = await Engine.open({
    home,
    connections: { script: conn, ...(opts.connections ?? {}) },
    clock: fakeClock(),
    random: fakeRandom(5),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
    counter: CHARS_COUNTER,
    toolSets: opts.toolSets ?? sets([lookupTool(log)]),
    ...opts.extra,
  });
  return { home, engine, conn, provider, log };
}

/** A scripted connection with its own caps (a fallback). */
export function scriptConn(id: string, script: ScriptCall[], caps: ModelCaps): { conn: Connection; provider: ScriptedProvider } {
  const provider = createScriptedProvider(script);
  return { conn: { id, provider, caps, origin: `script:${id}`, local: true }, provider };
}

/** New session (Mira with the sleeping book, Levi) with one user message sent. */
export function session(engine: EngineHandle, text = 'Where is the red door?', config: Record<string, unknown> = {}, character: Character = MIRA_TOOLS): SessionHandle {
  const s = engine.createSession({ character, persona: LEVI, config });
  s.send({ text, expectedVersion: s.version() });
  return s;
}

/** Run one reply to its end. */
export async function reply(s: SessionHandle, opts: { onError?: 'drop' | 'keep'; emptyReply?: 'fail' | 'keep' } = {}): Promise<{ evs: Event[]; out: TurnOutcome; turn: TurnHandle }> {
  const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), ...opts });
  const evs = await drain(turn);
  return { evs, out: await turn.result, turn };
}

export const notices = (evs: readonly Event[]): Extract<Event, { type: 'notice' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice');
export const codes = (evs: readonly Event[]): string[] => notices(evs).map((n) => n.code);

/** Everything the text events carried, in order. */
export const streamed = (evs: readonly Event[]): string =>
  evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

export const toolEvents = (evs: readonly Event[]): Extract<Event, { type: 'tool' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'tool' }> => e.type === 'tool');

export const usageEvents = (evs: readonly Event[]): Extract<Event, { type: 'usage' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'usage' }> => e.type === 'usage');

/** The chk text of a turn: its chk lines joined. */
export function chkText(home: string, sid: string, turn: string): string {
  return entriesOf(home, sid)
    .filter((e): e is Extract<Entry, { t: 'chk' }> => e.t === 'chk' && e.turn === turn)
    .map((e) => e.text)
    .join('');
}

/** The msg line of message `id`. */
export function msgOf(home: string, sid: string, id: string): MsgEntry | undefined {
  return entriesOf(home, sid).find((e): e is MsgEntry => e.t === 'msg' && e.id === id);
}

export function traceOf(home: string, sid: string, id: string): Trace | undefined {
  return msgOf(home, sid, id)?.trace;
}

export function prepOfTurn(home: string, sid: string, turn: string): PrepEntry | undefined {
  return entriesOf(home, sid).find((e): e is PrepEntry => e.t === 'prep' && e.turn === turn);
}

/** The text of a request's messages (roles and srcs), for compact assertions. */
export const shapeOf = (req: ModelRequest): string[] => req.messages.map((m) => `${m.role}:${m.src}`);

/** The last message of a request. */
export const lastMsg = (req: ModelRequest) => req.messages[req.messages.length - 1]!;

/** A message's text blocks joined. */
export const msgText = (m: { blocks: { k: string; text?: string }[] }): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');
