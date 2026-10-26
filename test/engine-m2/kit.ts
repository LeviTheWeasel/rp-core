// Shared setup for the M2 engine tests (not a test file itself): an engine on a scripted provider
// with the token counter pinned to chars/3 (EngineSeams), and library writers for books and presets.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, type EngineSeams } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, EngineOptions, SessionHandle, TurnHandle, TurnOutcome } from '../../src/engine/api.ts';
import { BUILTIN_PRESET, type LoreBook, type LoreEntry, type Preset } from '../../src/formats/native.ts';
import { libraryDir } from '../../src/formats/library.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { ScriptCall } from '../../src/providers/scripted.ts';
import type { EditEntry, Entry, MsgEntry, PrepEntry, Trace } from '../../src/session/entries.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { drain, entriesOf, LEVI, MIRA, scriptConn } from '../engine/kit.ts';

export { calls, drain, entriesOf, LEVI, MIRA, textOf } from '../engine/kit.ts';

export interface Rig {
  home: string;
  engine: EngineHandle;
  conn: Connection;
  provider: ReturnType<typeof scriptConn>['provider'];
}

/** An engine with one scripted connection 'script' (the default narrator binding), counting chars/3. */
export async function rig(script: ScriptCall[], opts: { home?: string; connections?: Record<string, Connection>; extra?: Partial<EngineOptions> & EngineSeams } = {}): Promise<Rig> {
  const home = opts.home ?? tmpHome();
  const { conn, provider } = scriptConn('script', script);
  const engine = await Engine.open({
    home,
    connections: { script: conn, ...(opts.connections ?? {}) },
    clock: fakeClock(),
    random: fakeRandom(11),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
    counter: CHARS_COUNTER,
    ...opts.extra,
  });
  return { home, engine, conn, provider };
}

/** A lore entry placed before the character description (the builtin preset's {{lore::before}}). */
export function entry(id: string, content: string, more: Partial<LoreEntry> = {}): LoreEntry {
  return { id, content, keys: [], position: 'before', ...more };
}

export function book(name: string, entries: LoreEntry[], more: Partial<LoreBook> = {}): LoreBook {
  return { name, entries, ...more };
}

/** Write a library file as is (no id canonicalisation), so tests choose the id. */
export function writeLibrary(home: string, kind: 'lorebooks' | 'presets', id: string, value: unknown): void {
  const dir = libraryDir(home, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** The builtin preset with another main prompt (a different preset hash). */
export function presetWith(main: string): Preset {
  const copy = JSON.parse(JSON.stringify(BUILTIN_PRESET)) as Preset;
  copy.name = 'custom';
  copy.blocks[0]!.content = main;
  return copy;
}

/** New session (Mira, Levi) with the given lorebook ids and one user message sent. */
export function session(engine: EngineHandle, lorebooks: string[], text = 'Hi there.', config: Record<string, unknown> = {}): { s: SessionHandle; version: number; userId: string } {
  const s = engine.createSession({ character: MIRA, persona: LEVI, config: { lorebooks, ...config } });
  const sent = s.send({ text, expectedVersion: s.version() });
  return { s, version: sent.version, userId: sent.messageId };
}

/** Run one turn to its end; returns its events and outcome. */
export async function run(t: TurnHandle): Promise<{ evs: Event[]; out: TurnOutcome }> {
  const evs = await drain(t);
  return { evs, out: await t.result };
}

/** send + reply, expecting 'done'. */
export async function say(s: SessionHandle, text: string): Promise<{ evs: Event[]; id: string }> {
  const t = s.submit({ text, expectedVersion: s.version() });
  const { evs, out } = await run(t);
  if (out.type !== 'done') throw new Error(`turn did not finish: ${JSON.stringify(out)}`);
  return { evs, id: out.message.id };
}

export const notices = (evs: readonly Event[]): Extract<Event, { type: 'notice' }>[] =>
  evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice');

/** The committed trace of a message (its msg line). */
export function msgTrace(home: string, sid: string, id: string): Trace | undefined {
  return entriesOf(home, sid).find((e): e is MsgEntry => e.t === 'msg' && e.id === id)?.trace;
}

/** The prep line of the turn that wrote message `id`. */
export function prepOf(home: string, sid: string, id: string): PrepEntry | undefined {
  const all: Entry[] = entriesOf(home, sid);
  const msg = all.find((e): e is MsgEntry => e.t === 'msg' && e.id === id);
  return all.find((e): e is PrepEntry => e.t === 'prep' && e.turn === msg?.turn);
}

/** The continue edits of message `id`. */
export function continueEdits(home: string, sid: string, id: string): EditEntry[] {
  return entriesOf(home, sid).filter((e): e is EditEntry => e.t === 'edit' && e.target === id && e.reason === 'continue');
}

/** fired as 'book:id:why' strings, for compact assertions. */
export const firedOf = (t: Trace | undefined): string[] => (t?.lore.fired ?? []).map((f) => `${f.book}:${f.id}:${f.why}`);
