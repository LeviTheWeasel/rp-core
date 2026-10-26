// Shared setup for the engine tests (not a test file itself).
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, EngineOptions, SessionHandle, TurnHandle } from '../../src/engine/api.ts';
import type { Character, Persona } from '../../src/formats/native.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider, type ScriptStep } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { Entry } from '../../src/session/entries.ts';
import { openSessionLog, readSessionFile, type SessionLog } from '../../src/session/log.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

export const MIRA: Character = {
  name: 'Mira',
  description: '{{char}} maps dreams for {{user}}.',
  personality: 'Curious, dry.',
  greetings: ['Hello, {{user}}. I am {{char}}.', 'The lamp flickers.'],
};
export const ONE_GREETING: Character = { name: 'Vera', description: 'A sailor.', greetings: ['Ahoy.'] };
export const LEVI: Persona = { name: 'Levi', description: 'A traveller.' };

/** Calls from step lists. */
export const calls = (...steps: ScriptStep[][]): ScriptCall[] => steps.map((s) => ({ steps: s }));

export function scriptConn(id: string, script: ScriptCall[], caps: ModelCaps = SCRIPT_CAPS): { conn: Connection; provider: ScriptedProvider } {
  const provider = createScriptedProvider(script);
  return { conn: { id, provider, caps, origin: `script:${id}`, local: true }, provider };
}

export interface Rig {
  home: string;
  engine: EngineHandle;
  provider: ScriptedProvider;
  conn: Connection;
}

export interface RigOptions {
  home?: string;
  caps?: ModelCaps;
  connections?: Record<string, Connection>;
  extra?: Partial<EngineOptions>;
}

/** An engine with one scripted connection 'script' (the default narrator binding) and tiny cadences. */
export async function rig(script: ScriptCall[], opts: RigOptions = {}): Promise<Rig> {
  const home = opts.home ?? tmpHome();
  const { conn, provider } = scriptConn('script', script, opts.caps);
  const options: EngineOptions = {
    home,
    connections: { script: conn, ...(opts.connections ?? {}) },
    clock: fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
    ...opts.extra,
  };
  const engine = await Engine.open(options);
  return { home, engine, provider, conn };
}

/** Read a turn's events to the end. */
export async function drain(turn: TurnHandle): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of turn.events) out.push(ev);
  return out;
}

export const types = (evs: readonly Event[]): string[] => evs.map((e) => e.type);

/** Collapse runs of the same type: [start, text, text, done] → [start, text, done]. */
export function runs(list: readonly string[]): string[] {
  return list.filter((t, i) => i === 0 || list[i - 1] !== t);
}

export function entriesOf(home: string, id: string): Entry[] {
  return readSessionFile(home, id).entries;
}

/** Entries written after `seq`. */
export function since(home: string, id: string, seq: number): Entry[] {
  return entriesOf(home, id).filter((e) => e.seq > seq);
}

export function lastSeq(home: string, id: string): number {
  return entriesOf(home, id).at(-1)?.seq ?? 0;
}

/** The text of a message's text blocks. */
export function textOf(m: { blocks: { k: string; text?: string }[] }): string {
  return m.blocks.reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');
}

/** New session with one user message sent; returns the session and the version after it. */
export function withUserMessage(engine: EngineHandle, text = 'Hi there.', character: Character = MIRA): { s: SessionHandle; version: number; userId: string } {
  const s = engine.createSession({ character, persona: LEVI });
  const sent = s.send({ text, expectedVersion: s.version() });
  return { s, version: sent.version, userId: sent.messageId };
}

/** Write raw lines into a closed session (to simulate a crash), through the real log. */
export function writeRaw(home: string, id: string, fn: (log: SessionLog) => void): void {
  const { log } = openSessionLog(home, id);
  try {
    fn(log);
  } finally {
    log.close();
  }
}

/** Wait until `pred` holds (polling the event loop), or fail after `ms`. */
export async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const step = 2;
  for (let waited = 0; !pred(); waited += step) {
    if (waited > ms) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, step));
  }
}
