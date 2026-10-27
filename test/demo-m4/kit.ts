// Shared setup for the M4 demos (not a test file): an engine on one scripted connection (the Director's
// calls before the narrator's in its script), the state at the head, and a readable dump of it in the
// spirit of `/director show` (the REPL command is the cli unit's; this one is for the test output).
import { directorAt } from '../../src/agents/director/state.ts';
import type { DirectorRecord, DirectorState } from '../../src/agents/director/types.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import { buildTree } from '../../src/session/tree.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import type { Character, Persona } from '../../src/formats/native.ts';
import type { Event } from '../../src/protocol/events.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

export const MARFA: Character = {
  name: 'Марфа',
  description: '{{char}} держит трактир «Три дороги» на перекрёстке у старой мельницы.',
  personality: 'Хозяйственная, острая на язык, недоверчивая к чужакам.',
  greetings: ['Марфа вытирает стойку и поднимает глаза: «Ну, заходи, {{user}}, коли пришёл. Дверь за собой прикрой — дует».'],
};
export const ELISEY: Persona = { name: 'Елисей', description: 'Странник, ищет пропавшего брата.' };

export interface Demo {
  home: string;
  engine: EngineHandle;
  provider: ScriptedProvider;
}

/** An engine with one scripted connection 'script' (the narrator's binding; the Director follows it). */
export async function demoEngine(script: ScriptCall[], caps: ModelCaps = SCRIPT_CAPS): Promise<Demo> {
  const home = tmpHome('rp-core-demo-m4-');
  const provider = createScriptedProvider(script);
  const engine = await Engine.open({
    home,
    connections: { script: { id: 'script', provider, caps, origin: 'script:script', local: true } },
    clock: fakeClock(),
    random: fakeRandom(11),
    timeZone: 'UTC',
    checkpoint: { chars: 4_000, ms: 1_000, datasyncMs: 1_000 },
    retryMaxDelayMs: 5,
    counter: CHARS_COUNTER,
  });
  return { home, engine, provider };
}

/** The state and the record at the session's head (the fold `/director show` reads). */
export function atHead(home: string, s: SessionHandle): { state: DirectorState; record?: DirectorRecord } {
  const tree = buildTree(readSessionFile(home, s.id).entries);
  const at = directorAt(tree, s.view().head);
  return { state: at.state, ...(at.record ? { record: at.record } : {}) };
}

/** A REPL-like line for a director event (`⋯ director: planned — …`). */
export function directorLine(ev: Event): string | null {
  if (ev.type !== 'director' || ev.status === 'planning') return null;
  return `⋯ director: ${ev.status}${ev.summary ? ` — ${ev.summary}` : ''}${ev.reason ? ` (${ev.reason})` : ''}`;
}

/** A readable dump of a state, in the order `/director show` lists it (D-113). */
export function dumpState(state: DirectorState, record?: DirectorRecord): string {
  const out: string[] = [];
  const last = record ? (record.reusedFrom ? 'reused' : record.ok ? 'planned' : `failed (${record.code})`) : 'none';
  out.push(`Director turn ${state.turn} · last result: ${last}`);
  const current = state.chapters.find((c) => c.id === state.currentChapterId);
  const done = state.chapters.filter((c) => c.status === 'complete').length;
  out.push(`Chapter: ${current ? `${current.number}. ${current.title} (${current.status})` : '—'} · completed: ${done}`);
  out.push('Arcs:');
  for (const a of state.arcs) {
    const age = state.turn - a.createdAtTurn;
    out.push(`  [${a.id}] ${a.title} — ${a.status}, ${a.priority}, ${a.horizon}, age ${age}`);
    if (a.nextBeat) out.push(`      next beat (${a.nextBeat.status}): ${a.nextBeat.description}`);
  }
  out.push('Seeds:');
  for (const x of state.seeds) {
    const age = state.turn - x.plantedAtTurn;
    out.push(`  [${x.id}] ${x.hint} — age ${age}, reinforced ${x.reinforcements.length}${x.payoffDelivered ? ', paid off' : ''}`);
  }
  out.push('Hidden arcs:');
  for (const h of state.invisibleArcs) {
    out.push(`  [${h.id}] ${h.title} — ${h.status}; clues: ${h.playerClues.map((c) => c.clue).join(' | ') || '—'}`);
  }
  out.push(`Intentions: ${state.nextIntentions.map((i) => `[${i.priority}] ${i.description}`).join('; ') || '—'}`);
  return out.join('\n');
}

/** UTF-8 bytes of a value's JSON. */
export const bytesOf = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).byteLength;
