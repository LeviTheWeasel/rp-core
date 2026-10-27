// Shared fixtures of the M4 CLI tests (not a test file itself): a Director state with something in
// every section, the record a turn would write for it, and journal lines that carry such records.
import { checkRecord } from '../../src/agents/director/state.ts';
import { REDUCER_VERSION, type DirectorRecord, type DirectorState } from '../../src/agents/director/types.ts';
import type { EntryInput, Trace } from '../../src/session/entries.ts';
import { arcOf, chapterOf, hiddenOf, seedOf, stateOf } from '../director/fixtures-state.ts';

/**
 * Turn 40: chapter 2 current (chapter 1 complete); a live arc with a pending beat, a stale one without
 * a beat, a finished one; a young seed, an epic seed past its horizon and ripe for payoff, a paid one;
 * a live hidden arc with two clues and a resolved one; one intention; the authored directive.
 */
export function richState(): DirectorState {
  return stateOf({
    turn: 40,
    nextId: 10,
    chapters: [
      chapterOf({ id: 'chapter-1', number: 1, title: 'Arrival', status: 'complete', createdAtTurn: 1 }),
      chapterOf({ id: 'chapter-2', number: 2, title: 'The Flood', status: 'active', createdAtTurn: 30 }),
    ],
    currentChapterId: 'chapter-2',
    arcs: [
      arcOf({
        id: 'arc-1',
        title: 'The Locked Room',
        status: 'building',
        priority: 'active',
        horizon: 'medium',
        createdAtTurn: 32,
        lastProgressTurn: 38,
        nextBeat: { description: 'Someone knocks from the inside.', plannedAtTurn: 38, targetTurn: 42, status: 'pending' },
      }),
      arcOf({ id: 'arc-3', title: 'Old Debts', status: 'seeding', priority: 'background', horizon: 'long', arcType: 'character', createdAtTurn: 5, lastProgressTurn: 20 }),
      arcOf({ id: 'arc-4', title: 'The Toll Bridge', status: 'complete', createdAtTurn: 3, lastProgressTurn: 25 }),
    ],
    seeds: [
      seedOf({ id: 'seed-2', hint: 'A cracked bell', payoffHorizon: 'long', plantedAtTurn: 35, reinforcements: [{ turn: 37 }] }),
      seedOf({ id: 'seed-6', hint: 'The red ribbon', payoffHorizon: 'epic', plantedAtTurn: 5, reinforcements: [{ turn: 12 }, { turn: 22 }] }),
      seedOf({ id: 'seed-7', hint: 'A wet footprint', plantedAtTurn: 8, payoffDelivered: true, payoffTurn: 30 }),
    ],
    invisibleArcs: [
      hiddenOf({ id: 'hidden-8', title: 'The Ledger Conspiracy', status: 'approaching_player', createdAtTurn: 36, playerClues: [{ turn: 37, clue: 'ink' }, { turn: 39, clue: 'a torn page' }] }),
      hiddenOf({ id: 'hidden-9', title: 'The Smugglers', status: 'resolved', createdAtTurn: 10 }),
    ],
    nextIntentions: [{ type: 'reveal', description: 'Let the red ribbon turn up again.', priority: 'must', targetTurn: 'next' }],
    pacing: { currentMood: 'tense', turnsAtCurrentMood: 2, rhythm: { lastActionSequence: 31, lastQuietMoment: 36 } },
    lastDirective: { turn: 40, directive: { pacing: 'fast', mood: 'tense', narrativeGoal: 'The keeper lies about the letter.' } },
    lastPlantTurn: 35,
  });
}

/** The record a planned turn writes (msg.dir); checked against checkRecord so the fold accepts it. */
export function recordFor(state: DirectorState, over: Partial<DirectorRecord> = {}): DirectorRecord {
  const r: DirectorRecord = {
    turn: state.turn,
    ok: true,
    transport: 'structured',
    profile: 'full',
    model: 'script:default',
    directive: {
      pacing: 'fast',
      mood: 'tense',
      narrativeGoal: 'The keeper lies about the letter.',
      arcDirections: [{ arcName: 'The Locked Room', instruction: 'A knock.', urgency: 'moderate' }],
      characterBeats: [
        { character: 'Mira', beat: 'She hides the key.' },
        { character: 'The keeper', beat: 'He looks away.' },
      ],
      endingHook: 'A knock at the door.',
    },
    skipped: [
      { path: 'arcUpdates[2]', why: 'unknown key' },
      { path: 'state', why: 'limit:text' },
    ],
    attempts: [{ transport: 'structured', outcome: 'ok', ms: 900, tokens: 300 }],
    state,
    reducer: REDUCER_VERSION,
    ...over,
  };
  if (checkRecord(r) === null) throw new Error('fixture record does not pass checkRecord');
  return r;
}

const TS = '2026-10-26T12:00:00.000Z';

/** A minimal trace with the given call rows (narrator and others). */
export function traceWith(calls: Trace['calls']): Trace {
  return {
    seed: 1,
    now: TS,
    window: 8192,
    reserve: 512,
    tokens: { estimated: 50 },
    blocks: [],
    lore: { fired: [], cut: [], budget: 0 },
    recap: { ids: [], arcs: [], boundary: null },
    prefill: null,
    macros: { unknown: [] },
    trimmed: null,
    calls,
    agents: {},
    presetHash: 'h',
    loreHashes: {},
  };
}

/** A msg entry without seq (what SessionLog.append takes). */
export function msgInput(id: string, parent: string | null, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}): Extract<EntryInput, { t: 'msg' }> {
  return { t: 'msg', ts: TS, id, parent, role, blocks: [{ k: 'text', text }], ...extra } as Extract<EntryInput, { t: 'msg' }>;
}
