// Shared setup for the M4 engine tests (not a test file itself): scripted Director answers, a session
// with the Director on, and readers for the journal rows and requests a Director turn leaves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineHandle, SessionHandle, TurnHandle, TurnOutcome } from '../../src/engine/api.ts';
import type { Character, Persona } from '../../src/formats/native.ts';
import type { Event } from '../../src/protocol/events.ts';
import { parseScriptFile, SCRIPT_CAPS, type ScriptCall, type ScriptStep } from '../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest, PromptMsg } from '../../src/providers/types.ts';
import type { DirectorRecord } from '../../src/agents/director/types.ts';
import type { Entry, MsgEntry, PrepEntry, SessionConfig, DeepPartial } from '../../src/session/entries.ts';
import { drain, entriesOf, LEVI, MIRA } from '../engine/kit.ts';

export { calls, drain, entriesOf, LEVI, MIRA, rig, scriptConn, textOf, until, writeRaw } from '../engine/kit.ts';

/** A plan as the model sends it (any shape: the reader decides). */
export type PlanJson = Record<string, unknown>;

/** A small valid plan; `over` replaces top-level sections. */
export function planOf(over: PlanJson = {}): PlanJson {
  return {
    directive: { mood: 'tense', pacing: 'slow', narrativeGoal: 'The lamp shows a door that was not there.' },
    arcUpdates: [{ title: 'The Red Door', description: 'A door that should not exist.', status: 'seeding', arcType: 'mystery' }],
    seedUpdates: [{ title: 'A smell of rain indoors', action: 'plant', scope: 'world', description: 'The door opens onto a storm.' }],
    invisibleArcUpdates: [],
    analysis: { whatHappened: 'The player looked around.' },
    chapterUpdate: { action: 'start_new', title: 'Lamps' },
    ...over,
  };
}

/** The tagged answer: one <plan> block. */
export const tagged = (plan: PlanJson): string => `<plan>${JSON.stringify(plan)}</plan>`;

/** One Director call answering with this plan (tagged). */
export const dirCall = (plan: PlanJson = planOf(), more: ScriptStep[] = []): ScriptStep[] => [{ text: tagged(plan) }, ...more];

/** The config that turns the Director on (plus anything else). */
export function dirConfig(over: DeepPartial<SessionConfig['director']> = {}, more: DeepPartial<SessionConfig> = {}): DeepPartial<SessionConfig> {
  return { ...more, director: { enabled: true, ...over } };
}

/** SCRIPT_CAPS with a window big enough for the full profile (and any other fields). */
export function fullCaps(more: Partial<ModelCaps> = {}): ModelCaps {
  return { ...structuredClone(SCRIPT_CAPS), contextLength: 32_768, ...more };
}

/** A session with the Director on and one user message sent. */
export function dirSession(
  engine: EngineHandle,
  opts: { text?: string; director?: DeepPartial<SessionConfig['director']>; config?: DeepPartial<SessionConfig>; character?: Character; persona?: Persona | null } = {},
): SessionHandle {
  const persona = opts.persona === null ? undefined : (opts.persona ?? LEVI);
  const s = engine.createSession({ character: opts.character ?? MIRA, ...(persona ? { persona } : {}), config: dirConfig(opts.director, opts.config) });
  s.send({ text: opts.text ?? 'I look around the room.', expectedVersion: s.version() });
  return s;
}

/** Run one turn to its end. */
export async function turnOf(
  s: SessionHandle,
  kind: 'reply' | 'swipe' | 'continue' = 'reply',
  more: { guidance?: string; onError?: 'drop' | 'keep' } = {},
): Promise<{ evs: Event[]; out: TurnOutcome; turn: TurnHandle }> {
  const turn = s.runTurn({ kind, expectedVersion: s.version(), ...more });
  const evs = await drain(turn);
  return { evs, out: await turn.result, turn };
}

/** send + reply. */
export async function say(s: SessionHandle, text: string): Promise<{ evs: Event[]; out: TurnOutcome }> {
  s.send({ text, expectedVersion: s.version() });
  return turnOf(s, 'reply');
}

export type DirectorEv = Extract<Event, { type: 'director' }>;
export const directorEvents = (evs: readonly Event[]): DirectorEv[] => evs.filter((e): e is DirectorEv => e.type === 'director');
export const statuses = (evs: readonly Event[]): string[] => directorEvents(evs).map((e) => e.status);
export const noticeCodes = (evs: readonly Event[]): string[] => evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []));

/** The newest msg row of a message id (the committed answer). */
export function msgRow(home: string, id: string, msgId: string): MsgEntry & { seq: number } {
  const m = entriesOf(home, id).find((e): e is Extract<Entry, { t: 'msg' }> => e.t === 'msg' && e.id === msgId);
  if (!m) throw new Error(`no msg ${msgId}`);
  return m as MsgEntry & { seq: number };
}

/** The prep row of a turn. */
export function prepRow(home: string, id: string, turnId: string): PrepEntry | undefined {
  return entriesOf(home, id).find((e): e is PrepEntry => e.t === 'prep' && e.turn === turnId);
}

/** A stored dir as the record the engine wrote. */
export const recordOf = (dir: unknown): DirectorRecord => dir as DirectorRecord;

/** The requests one agent made. */
export const byAgent = (requests: readonly ModelRequest[], agent: string): ModelRequest[] => requests.filter((r) => r.agent === agent);

export const textOfMsg = (m: PromptMsg): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/** The message of a request with this src, or undefined. */
export const msgBySrc = (r: ModelRequest, src: string): PromptMsg | undefined => r.messages.find((m) => m.src === src);

/** The Director's user prompt (its first user message). */
export const directorUser = (r: ModelRequest): string => textOfMsg(r.messages.find((m) => m.role === 'user')!);

/** A Director script file of test/fixtures/scripts. */
export function scriptFile(name: string): ScriptCall[] {
  return parseScriptFile(readFileSync(join(import.meta.dir, '..', 'fixtures', 'scripts', name), 'utf8')).calls;
}
