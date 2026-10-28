// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5c recall engine tests (not a test file itself): an engine that keeps the
// recall mode of the session's config (EngineSeams.recall 'config', so test/preload.ts's lexical
// default does not apply), one scripted connection whose lines are tagged by agent (the Director and
// recall may ask at once), local to the scheduler when asked; a library book with typed entries; and
// readers for the turn's prep, its committed record and the recall events.
import type { DelayTimers } from '../../src/engine/abort.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { LoreBook, LoreEntry } from '../../src/formats/native.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider, type ScriptStep } from '../../src/providers/scripted.ts';
import type { CallAgent, ModelCaps, ModelRequest } from '../../src/providers/types.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { CompendiumConfig, DeepPartial, EditEntry, Entry, MsgEntry, PrepEntry, SessionConfig } from '../../src/session/entries.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { entriesOf, LEVI, MIRA } from '../engine/kit.ts';
import { collect, HARBOUR, LIGHTHOUSE, MIRA_ENTRY, putBook } from '../engine-m5a/kit.ts';

export { drain, entriesOf, LEVI, MIRA, textOf, until, writeRaw } from '../engine/kit.ts';
export { dirCall, fullCaps, planOf, tagged, turnOf } from '../engine-m4/kit.ts';
export { collect, tick } from '../engine-m5a/kit.ts';

/** A typed character no message names: only recall brings it to the block (tier 1). */
export const KETTER: LoreEntry = {
  id: 'e5',
  title: 'Арсений Кеттер',
  keys: ['Кеттер'],
  content: 'Арсений Кеттер — старый фонарщик.',
  position: 'after',
  meta: { type: 'character', aliases: ['Кеттер'], data: { name: 'Арсений Кеттер', description: 'Старый фонарщик, учитель Миры.', role: 'mentor' } },
};

/** Мира, the lighthouse, Kettler (typed) and a constant plain entry. */
export const HARBOR_BOOK: LoreBook = { name: 'Lantern', entries: [MIRA_ENTRY, LIGHTHOUSE, HARBOUR, KETTER] };

/** One line of an agent's answer. */
export const line = (agent: CallAgent, steps: ScriptStep[]): ScriptCall => ({ agent, steps });
/** A narrator answer. */
export const narr = (text = 'Мира кивает.'): ScriptCall => line('narrator', [{ text }]);
/** A recall answer picking these handles or names (and optional extra steps after it, e.g. usage). */
export const picks = (names: string[], more: ScriptStep[] = []): ScriptCall => line('recall', [{ text: JSON.stringify({ entry_ids: names }) }, ...more]);
/** A recall answer that waits for release(`name`) first. */
export const pausedPicks = (name: string, names: string[]): ScriptCall => line('recall', [{ pause: name }, { text: JSON.stringify({ entry_ids: names }) }]);

export interface RecallRig {
  home: string;
  engine: EngineHandle;
  provider: ScriptedProvider;
  conn: Connection;
  events: { seen: Event[]; done: Promise<void> };
}

export interface RecallRigOptions {
  caps?: ModelCaps;
  /** The scheduler's locality of the script's origin (scripted.ts localOrigin); absent: remote. */
  local?: boolean;
  lane?: 'auto' | 'manual';
  timers?: DelayTimers;
  clock?: () => Date;
  home?: string;
  keepRequests?: boolean;
}

/** An engine with one scripted connection 'script' (the narrator's, the Director's, recall's); the config's recall mode applies. */
export async function recallRig(script: ScriptCall[], opts: RecallRigOptions = {}): Promise<RecallRig> {
  const home = opts.home ?? tmpHome();
  const provider = createScriptedProvider(script, opts.local !== undefined ? { localOrigin: opts.local } : undefined);
  const conn: Connection = { id: 'script', provider, caps: opts.caps ?? SCRIPT_CAPS, origin: 'script:script', local: true };
  const engine = await Engine.open({
    home,
    connections: { script: conn },
    clock: opts.clock ?? fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
    lane: opts.lane ?? 'manual',
    recall: 'config',
    ...(opts.timers ? { timers: opts.timers } : {}),
    ...(opts.keepRequests ? { keepRequests: true } : {}),
  });
  return { home, engine, provider, conn, events: collect(engine) };
}

export type RecallCfg = NonNullable<CompendiumConfig['recall']>;

/**
 * A session (Mira, persona Levi) reading HARBOR_BOOK, the Compendium on with filing and the historian
 * off (only recall runs in the lane), recall as given; one user message unless `text` is null.
 */
export function recallSession(
  r: Pick<RecallRig, 'engine' | 'home'>,
  recall: RecallCfg = {},
  opts: { text?: string | null; compendium?: DeepPartial<CompendiumConfig>; config?: DeepPartial<SessionConfig>; character?: typeof MIRA } = {},
): SessionHandle {
  const id = putBook(r.home, HARBOR_BOOK);
  const s = r.engine.createSession({
    character: opts.character ?? MIRA,
    persona: LEVI,
    config: {
      lorebooks: [id],
      ...(opts.config ?? {}),
      compendium: { enabled: true, filing: { enabled: false }, historian: { interval: 0 }, ...(opts.compendium ?? {}), recall },
    },
  });
  if (opts.text !== null) s.send({ text: opts.text ?? 'Я жду у двери.', expectedVersion: s.version() });
  return s;
}

/** The key of a live entry of the session's Compendium, by name. */
export function keyOf(s: SessionHandle, name: string): string {
  const e = [...s.view().compendium.entries.values()].find((x) => x.name === name);
  if (e === undefined) throw new Error(`no entry named ${name}`);
  return e.key;
}

/** The agents of the provider's requests, in order. */
export const agentsOf = (reqs: readonly ModelRequest[]): string[] => reqs.map((q) => q.agent ?? '?');

/** The `prep` line of a turn. */
export const prepOf = (home: string, id: string, turnId: string): PrepEntry | undefined =>
  entriesOf(home, id).find((e): e is Extract<Entry, { t: 'prep' }> => e.t === 'prep' && e.turn === turnId);

/** The committed `msg` of an answer. */
export const msgOf = (home: string, id: string, msgId: string): MsgEntry | undefined =>
  entriesOf(home, id).find((e): e is Extract<Entry, { t: 'msg' }> => e.t === 'msg' && e.id === msgId);

/** The `edit` lines of a message (a continue's). */
export const editsOf = (home: string, id: string, target: string): EditEntry[] =>
  entriesOf(home, id).filter((e): e is Extract<Entry, { t: 'edit' }> => e.t === 'edit' && e.target === target);

/** The recall `agent` events of a list, without the session id and time. */
export function recallEvents(evs: readonly Event[]): Record<string, unknown>[] {
  return evs.flatMap((e) => {
    if (e.type !== 'agent' || e.agent !== 'recall') return [];
    const { sessionId: _s, ts: _t, ...rest } = e;
    return [rest];
  });
}

export const noticeCodes = (evs: readonly Event[]): string[] => evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []));

/** The text of a request's user message(s). */
export const userText = (req: ModelRequest): string =>
  req.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.blocks.reduce((t, b) => (b.k === 'text' ? t + b.text : t), ''))
    .join('\n');
