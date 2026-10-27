// The agents pane's state (TUI T-8, src/cli/tui/agents.ts): the reducer over synthetic turn events
// (tool start/done pairing by callId, durations from ts, newest first and capped, narrator phases,
// retries, the Director's live statuses, M5 agent events, live usage), and the stored facts read from
// a journal (hand-made rows, and real ones written by the engine with the scripted provider).
import { describe, expect, test } from 'bun:test';
import { configOf, journalOf } from '../../src/cli/repl-journal.ts';
import {
  initialAgents,
  pathIds,
  recordAt,
  reduceAgents,
  storedFacts,
  usageTotal,
  withStored,
  type AgentsState,
} from '../../src/cli/tui/agents.ts';
import { LAYOUT } from '../../src/cli/tui/types.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { DEFAULT_SESSION_CONFIG, type Entry, type Generation, type SessionHeader } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import type { MessageView } from '../../src/session/view.ts';
import { recordFor, richState, traceWith } from '../cli-m4/fixtures.ts';
import { calls, dirCall, dirSession, fullCaps, rig, turnOf } from '../engine-m4/kit.ts';

const NOW = new Date('2026-10-27T00:00:00.000Z');
const T0 = Date.parse('2026-10-26T12:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

/** An event stamped like the engine does (session s_1, ts T0 + `sec` seconds). */
const ev = (body: EventBody, sec = 0): Event => ({ sessionId: 's_1', ts: at(sec), ...body }) as Event;
const run = (events: readonly Event[], s: AgentsState = initialAgents()): AgentsState => events.reduce((st, e) => reduceAgents(st, e, NOW), s);

const start = (turnId = 't1', kind: 'reply' | 'swipe' | 'continue' = 'reply'): Event => ev({ type: 'start', turnId, kind, messageId: `m_${turnId}`, parentId: 'u1' });
const toolStart = (callId: string, name: string, sec: number, args: unknown = { query: 'caravan' }, turnId = 't1'): Event =>
  ev({ type: 'tool', turnId, callId, name, phase: 'start', args }, sec);
const toolDone = (callId: string, name: string, sec: number, more: { ok?: boolean; summary?: string } = {}, turnId = 't1'): Event =>
  ev({ type: 'tool', turnId, callId, name, phase: 'done', args: { query: 'caravan' }, ok: more.ok ?? true, ...(more.summary ? { summary: more.summary } : {}) }, sec);

function message(id: string, gen?: Partial<Generation>): MessageView {
  return {
    id,
    parent: 'u1',
    role: 'assistant',
    blocks: [{ k: 'text', text: 'The lamp gutters.' }],
    ...(gen ? { gen: { kind: 'model', ...gen } as Generation } : {}),
    hidden: false,
    edited: false,
    swipe: { index: 0, count: 1 },
  } as MessageView;
}

describe('narrator phases', () => {
  test('start → waiting, reasoning → thinking N chars, text → writing, done → idle with the stats', () => {
    let s = run([start()]);
    expect(s.turnId).toBe('t1');
    expect(s.narrator.phase).toEqual({ kind: 'waiting' });
    s = run([ev({ type: 'reasoning', turnId: 't1', delta: 'Hmm, ', offset: 0 }), ev({ type: 'reasoning', turnId: 't1', delta: 'let me think.', offset: 5 })], s);
    expect(s.narrator.phase).toEqual({ kind: 'thinking', chars: 18 });
    s = run([ev({ type: 'text', turnId: 't1', delta: 'The ', offset: 0 })], s);
    expect(s.narrator.phase).toEqual({ kind: 'writing' });
    // A delta that changes nothing returns the same object (the pane skips the redraw).
    expect(reduceAgents(s, ev({ type: 'text', turnId: 't1', delta: 'lamp', offset: 4 }), NOW)).toBe(s);
    s = run([ev({ type: 'done', turnId: 't1', message: message('m_t1', { usage: { outputTotal: 300 }, ms: 13_300, finish: 'length', rounds: 2, transport: 'native' }) })], s);
    expect(s.narrator.phase).toEqual({ kind: 'idle' });
    expect(s.narrator.last).toEqual({ messageId: 'm_t1', tokens: 300, ms: 13_300, finish: 'length', rounds: 2, transport: 'native' });
  });

  test('stopped keeps the partial answer\'s stats; failed and conflict say their code; the next start clears it', () => {
    let s = run([start(), ev({ type: 'stopped', turnId: 't1', message: message('m_t1', { ms: 900, finish: 'stopped' }) })]);
    expect(s.narrator.phase).toEqual({ kind: 'stopped' });
    expect(s.narrator.last).toEqual({ messageId: 'm_t1', ms: 900, finish: 'stopped' });
    // Nothing kept: the previous answer's stats stay.
    s = run([start('t2'), ev({ type: 'stopped', turnId: 't2', message: null })], s);
    expect(s.narrator.last?.messageId).toBe('m_t1');
    s = run([start('t3'), ev({ type: 'failed', turnId: 't3', category: 'rate', code: 'rate_limited', message: 'slow down', draft: '' })], s);
    expect(s.narrator.phase).toEqual({ kind: 'failed', code: 'rate_limited' });
    s = run([start('t4'), ev({ type: 'conflict', turnId: 't4', draft: 'x' })], s);
    expect(s.narrator.phase).toEqual({ kind: 'failed', code: 'conflict' });
    s = run([start('t5')], s);
    expect(s.narrator.phase).toEqual({ kind: 'waiting' });
  });

  test('a greeting or a message without a gen leaves the last stats alone', () => {
    const s = run([start(), ev({ type: 'done', turnId: 't1', message: message('m_t1', { usage: { outputTotal: 5 } }) })]);
    const t = run([start('t2'), ev({ type: 'done', turnId: 't2', message: message('m_t2') })], s);
    expect(t.narrator.last?.messageId).toBe('m_t1');
  });

  test('retries: the narrator\'s callKey sets its phase, the Director\'s its status; the stream goes on after', () => {
    let s = run([start(), ev({ type: 'retry', callKey: 't1:narrator:0', attempt: 2, delayMs: 500, code: 'rate_limited', status: 429 })]);
    expect(s.narrator.phase).toEqual({ kind: 'retry', code: 'rate_limited', attempt: 2 });
    s = run([ev({ type: 'text', turnId: 't1', delta: 'ok', offset: 0 })], s);
    expect(s.narrator.phase).toEqual({ kind: 'writing' });
    s = run([ev({ type: 'retry', callKey: 't1:director:0', attempt: 1, delayMs: 5, code: 'server_error' })], s);
    expect(s.director).toMatchObject({ enabled: true, live: { kind: 'retry', code: 'server_error', attempt: 1 } });
    expect(s.narrator.phase).toEqual({ kind: 'writing' });
    s = run([ev({ type: 'retry', callKey: 't1:recall:0', attempt: 1, delayMs: 5, code: 'timeout' })], s);
    expect(s.others).toEqual([{ agent: 'recall', status: 'retry', code: 'timeout' }]);
  });

  test('an unreadable ts falls back to `now`', () => {
    const s = run([toolStart('c1', 'search_history', 0), { ...toolDone('c1', 'search_history', 0), ts: 'garbage' } as Event]);
    expect(s.narrator.tools[0]!.ms).toBe(NOW.getTime() - T0);
  });
});

describe('tool calls', () => {
  test('start and done pair by callId: toolLine text, the duration from the ts, the phase while it runs', () => {
    let s = run([start(), toolStart('c1', 'search_history', 1)]);
    expect(s.narrator.phase).toEqual({ kind: 'tool', name: 'search_history' });
    expect(s.narrator.tools).toEqual([{ turnId: 't1', callId: 'c1', name: 'search_history', text: '⋯ search_history "caravan"', status: 'running', startedMs: T0 + 1000 }]);
    s = run([toolDone('c1', 'search_history', 3.5, { summary: '2 hits' })], s);
    expect(s.narrator.tools).toEqual([{ turnId: 't1', callId: 'c1', name: 'search_history', text: '⋯ search_history "caravan" → 2 hits', status: 'ok', startedMs: T0 + 1000, ms: 2500 }]);
    expect(s.narrator.phase).toEqual({ kind: 'waiting' });
  });

  test('two calls at once: the first done leaves the phase on the other; a failed call is marked', () => {
    let s = run([start(), toolStart('a', 'search_history', 0), toolStart('b', 'read_lore', 0, { ids: ['L1', 'L3'] })]);
    expect(s.narrator.phase).toEqual({ kind: 'tool', name: 'read_lore' });
    s = run([toolDone('b', 'read_lore', 1, { ok: false })], s);
    expect(s.narrator.phase).toEqual({ kind: 'tool', name: 'search_history' });
    expect(s.narrator.tools.map((t) => [t.callId, t.status, t.text])).toEqual([
      ['b', 'failed', '⋯ read_lore "caravan" → failed'],
      ['a', 'running', '⋯ search_history "caravan"'],
    ]);
  });

  test('newest first, capped at LAYOUT.toolCalls across turns; the same callId in another turn is another call', () => {
    const events: Event[] = [start()];
    for (let i = 0; i < 8; i++) events.push(toolStart(`c${i}`, `tool_${i}`, i), toolDone(`c${i}`, `tool_${i}`, i + 0.5));
    let s = run(events);
    expect(s.narrator.tools).toHaveLength(LAYOUT.toolCalls);
    expect(s.narrator.tools.map((t) => t.name)).toEqual(['tool_7', 'tool_6', 'tool_5', 'tool_4', 'tool_3', 'tool_2']);
    expect(s.narrator.tools.every((t) => t.ms === 500)).toBe(true);
    s = run([start('t2'), toolStart('c7', 'again', 20, undefined, 't2')], s);
    expect(s.narrator.tools.slice(0, 2).map((t) => [t.turnId, t.callId, t.status])).toEqual([
      ['t2', 'c7', 'running'],
      ['t1', 'c7', 'ok'],
    ]);
  });

  test('a done without its start still shows (no duration); running calls are cancelled when the turn ends', () => {
    let s = run([start(), toolDone('lost', 'search_history', 2)]);
    expect(s.narrator.tools[0]).toEqual({ turnId: 't1', callId: 'lost', name: 'search_history', text: '⋯ search_history "caravan" → ok', status: 'ok' });
    s = run([toolStart('c2', 'read_lore', 3), ev({ type: 'stopped', turnId: 't1', message: null })], s);
    expect(s.narrator.tools[0]!.status).toBe('cancelled');
  });
});

describe('the Director live', () => {
  test('planning → planned — summary with its duration; reused; failed (code); skipped', () => {
    let s = run([start(), ev({ type: 'director', turnId: 't1', status: 'planning' }, 1)]);
    expect(s.director).toMatchObject({ enabled: true, live: { kind: 'planning', sinceMs: T0 + 1000 } });
    s = run([ev({ type: 'director', turnId: 't1', status: 'planned', summary: 'arcs +1 · seeds +1 · chapter 1' }, 3)], s);
    expect(s.director.live).toEqual({ kind: 'planned', summary: 'arcs +1 · seeds +1 · chapter 1', ms: 2000 });
    s = run([start('t2', 'swipe'), ev({ type: 'director', turnId: 't2', status: 'reused', summary: 'no changes' })], s);
    expect(s.director.live).toEqual({ kind: 'reused', summary: 'no changes' });
    s = run([start('t3'), ev({ type: 'director', turnId: 't3', status: 'planning' }, 10), ev({ type: 'director', turnId: 't3', status: 'failed', reason: 'timeout' }, 40)], s);
    expect(s.director.live).toEqual({ kind: 'failed', code: 'timeout', ms: 30_000 });
    s = run([ev({ type: 'director', turnId: 't3', status: 'failed' })], s);
    expect(s.director.live).toEqual({ kind: 'failed', code: 'unknown' });
    s = run([ev({ type: 'director', turnId: 't3', status: 'skipped' })], s);
    expect(s.director.live).toEqual({ kind: 'skipped' });
  });

  test('a continue skips the Director (when it is on); off it stays off', () => {
    const on = withStored(initialAgents(), { directorEnabled: true, last: null, director: null, usage: usageTotal(initialAgents()) });
    expect(run([start('t1', 'continue')], on).director.live).toEqual({ kind: 'skipped' });
    expect(run([start('t1', 'continue')]).director).toEqual({ enabled: false, live: { kind: 'none' }, facts: null });
  });
});

describe('other agents and usage', () => {
  test('M5 agent events: one block per agent with its latest status, the job\'s duration, memory changes', () => {
    const s = run([
      ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'started' }, 1),
      ev({ type: 'agent', agent: 'filing', status: 'queued', job: 'j1' }, 1),
      ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'recalled', count: 3, source: 'lexical' }, 1.4),
      ev({ type: 'agent', agent: 'filing', status: 'started', job: 'j1' }, 2),
      ev({ type: 'memory', change: 'created', ref: 'c1', kind: 'character', name: 'Old Tom', by: 'filing' }),
      ev({ type: 'agent', agent: 'filing', status: 'failed', job: 'j1', code: 'no_output' }, 5),
      ev({ type: 'memory', change: 'edited', ref: 'c2', kind: 'place', name: 'Inn', by: 'user' }),
    ]);
    expect(s.others).toEqual([
      { agent: 'recall', status: 'recalled', count: 3, source: 'lexical', ms: 400 },
      { agent: 'filing', status: 'failed', code: 'no_output', memory: 'created character "Old Tom"', ms: 4000 },
    ]);
  });

  test('usage events add up live until the stored totals replace them', () => {
    let s = run([
      ev({ type: 'usage', callKey: 't1:director:0', agent: 'director', model: 'script:default', usage: { inputTotal: 800, outputTotal: 200 }, costUsd: 0.5, priceSource: 'provider' }),
      ev({ type: 'usage', callKey: 't1:narrator:0', agent: 'narrator', model: 'script:default', usage: { inputTotal: 1000, outputTotal: 100 }, costUsd: null, priceSource: 'none' }),
    ]);
    expect(usageTotal(s)).toEqual({ calls: 2, inputTokens: 1800, outputTokens: 300, noUsage: 0, costUsd: 0.5, unpriced: 1 });
    s = withStored(s, { directorEnabled: false, last: null, director: null, usage: { calls: 4, inputTokens: 10, outputTokens: 20, noUsage: 1, costUsd: null, unpriced: 0 } });
    expect(usageTotal(s)).toEqual({ calls: 4, inputTokens: 10, outputTokens: 20, noUsage: 1, costUsd: null, unpriced: 0 });
  });

  test('withStored: the stored last answer wins; the Director off drops its live status', () => {
    const live = run([start(), ev({ type: 'director', turnId: 't1', status: 'planning' }), ev({ type: 'done', turnId: 't1', message: message('m_t1', { ms: 5 }) })]);
    const off = withStored(live, { directorEnabled: false, last: { messageId: 'other', tokens: 1 }, director: null, usage: usageTotal(initialAgents()) });
    expect(off.narrator.last).toEqual({ messageId: 'other', tokens: 1 });
    expect(off.director.live).toEqual({ kind: 'none' });
    const on = withStored(live, { directorEnabled: true, last: null, director: null, usage: usageTotal(initialAgents()) });
    expect(on.director.live.kind).toBe('planning');
    expect(on.narrator.last).toBeNull();
  });
});

// ---- stored facts ----------------------------------------------------------------------------------

const TS = '2026-10-26T12:00:00.000Z';
const header = (config = DEFAULT_SESSION_CONFIG): SessionHeader => ({
  t: 'session',
  v: 1,
  id: 's_00000001',
  created: TS,
  cast: { character: { name: 'Mira', description: '', greetings: ['Hi'] } },
  config,
});
let seq = 0;
const msg = (id: string, parent: string | null, role: 'user' | 'assistant', extra: Partial<Entry> = {}): Entry =>
  ({ t: 'msg', seq: ++seq, ts: TS, id, parent, role, blocks: [{ k: 'text', text: id }], ...extra }) as Entry;
const gen = (over: Partial<Generation> = {}): Generation => ({ kind: 'model', connection: 'local', model: 'q', finish: 'end', ...over });

describe('stored facts', () => {
  test('a hand-made journal: the head\'s last answer, the record\'s facts (chapter, live arcs, seeds due), usage over the path', () => {
    seq = 0;
    const state = richState();
    const entries: Entry[] = [
      msg('g1', null, 'assistant', { gen: { kind: 'greeting' } }),
      msg('u1', 'g1', 'user'),
      msg('a1', 'u1', 'assistant', {
        gen: gen({ usage: { inputTotal: 1000, outputTotal: 120 }, ms: 4200, transport: 'prompted' }),
        trace: { ...traceWith([{ callKey: 't:director:0', agent: 'director', model: 'dir:big', ms: 900, usage: { inputTotal: 800, outputTotal: 300, cost: 0.25 } }]), rounds: { n: 2, transport: 'prompted', ended: 'answer', room: 100, roomLeft: 40 } },
        dir: recordFor(state, { attempts: [{ transport: 'structured', outcome: 'no_output', ms: 1200 }, { transport: 'tagged', outcome: 'ok', ms: 900, tokens: 300 }] }),
      }),
      msg('u2', 'a1', 'user'),
    ];
    const j = journalOf(header(), entries);
    expect(pathIds(j, 'u2')).toEqual(['g1', 'u1', 'a1', 'u2']);
    const f = storedFacts(j, 'u2', { ...DEFAULT_SESSION_CONFIG, director: { ...DEFAULT_SESSION_CONFIG.director, enabled: true } }, { 'local:q': { inPerM: 1, outPerM: 2 } });
    // The head is the player's line: the last answer is a1's (rounds from its gen, else its trace).
    expect(f.last).toEqual({ messageId: 'a1', tokens: 120, ms: 4200, finish: 'end', rounds: 2, transport: 'prompted' });
    expect(f.directorEnabled).toBe(true);
    expect(f.director).toEqual({
      turn: 40,
      ok: true,
      profile: 'full',
      transport: 'structured',
      model: 'script:default',
      attempts: [
        { transport: 'structured', outcome: 'no_output', ms: 1200 },
        { transport: 'tagged', outcome: 'ok', ms: 900, tokens: 300 },
      ],
      chapter: { number: 2, title: 'The Flood' },
      // arc-1 and arc-3 (arc-4 is complete); seed-6 (epic, 35 turns) is past its horizon, seed-2 is not, seed-7 is paid.
      liveArcs: 2,
      seedsDue: 1,
    });
    expect(recordAt(j, 'u2')?.turn).toBe(40);
    // Narrator 1000/120 priced 0.00124; the Director's 800/300 with its own cost 0.25.
    expect(f.usage.calls).toBe(2);
    expect(f.usage.inputTokens).toBe(1800);
    expect(f.usage.outputTokens).toBe(420);
    expect(f.usage.costUsd).toBeCloseTo(0.25124, 8);
    expect(f.usage.unpriced).toBe(0);
  });

  test('a greeting head has no answer stats; an empty journal has nothing', () => {
    seq = 0;
    const j = journalOf(header(), [msg('g1', null, 'assistant', { gen: { kind: 'greeting' } })]);
    expect(storedFacts(j, null, DEFAULT_SESSION_CONFIG, {})).toEqual({
      directorEnabled: false,
      last: null,
      director: null,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, noUsage: 0, costUsd: null, unpriced: 0 },
    });
    const empty = journalOf(header(), []);
    expect(storedFacts(empty, null, DEFAULT_SESSION_CONFIG, {}).last).toBeNull();
    expect(recordAt(empty, null)).toBeUndefined();
  });

  test('a failed Director record: ok false with its code', () => {
    seq = 0;
    const state = richState();
    const j = journalOf(header(), [
      msg('u1', null, 'user'),
      msg('a1', 'u1', 'assistant', { gen: gen(), dir: recordFor(state, { ok: false, code: 'timeout', directive: undefined, transport: undefined, profile: undefined, model: undefined }) }),
    ]);
    expect(storedFacts(j, 'a1', DEFAULT_SESSION_CONFIG, {}).director).toMatchObject({ turn: 40, ok: false, code: 'timeout' });
  });

  test('a real Director turn written by the engine: the live events, then the facts from the journal', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'The lamp gutters.' }]), { caps: fullCaps() });
    const s = dirSession(r.engine);
    const { evs, out } = await turnOf(s);
    expect(out.type).toBe('done');
    const live = run(evs);
    expect(live.narrator.phase).toEqual({ kind: 'idle' });
    expect(live.director.live.kind).toBe('planned');
    expect(live.director.live).toMatchObject({ summary: expect.stringContaining('chapter 1') });
    expect(typeof (live.director.live as { ms?: number }).ms).toBe('number');

    const file = readSessionFile(r.home, s.id);
    const j = journalOf(file.header, file.entries);
    const f = storedFacts(j, s.view().head, configOf(j), { 'script:default': { inPerM: 1, outPerM: 2 } });
    expect(f.directorEnabled).toBe(true);
    expect(f.last?.messageId).toBe(s.view().head!);
    expect(f.director).toMatchObject({ turn: 1, ok: true, transport: 'tagged', model: 'script:default', chapter: { number: 1, title: 'Lamps' }, liveArcs: 1, seedsDue: 0 });
    expect(f.director!.attempts.length).toBeGreaterThan(0);
    // One narrator generation plus the Director's call.
    expect(f.usage.calls).toBe(2);
    const merged = withStored(live, f);
    expect(merged.director.facts?.turn).toBe(1);
    expect(merged.director.live.kind).toBe('planned');
    await r.engine.close();
  });

  test('a real tool round: the tool row from the engine\'s events, rounds and transport from the stored gen', async () => {
    const caps = { ...SCRIPT_CAPS, tools: 'native' as const };
    const r = await rig(calls([{ tool: { name: 'search_history', args: { query: 'caravan' } } }], [{ text: 'The caravan left at dawn.' }]), { caps });
    const s = r.engine.createSession({ character: { name: 'Mira', description: 'A guide.', greetings: ['Hello.'] }, config: { window: 3000, roles: { narrator: { conn: 'script', model: 'default', maxTokens: 64 } } } });
    const filler = ' The road goes on through the dunes and the wind keeps blowing sand into every pack and every boot.'.repeat(3);
    for (let i = 1; i <= 40; i++) s.send({ text: `Day ${i}: ${i === 3 ? 'the caravan moves on.' : 'we walk on.'}${filler}`, expectedVersion: s.version() });
    s.send({ text: 'Where did the caravan go?', expectedVersion: s.version() });
    const { evs, out } = await turnOf(s);
    expect(out.type).toBe('done');
    const live = run(evs);
    expect(live.narrator.tools).toHaveLength(1);
    const row = live.narrator.tools[0]!;
    expect(row.text).toMatch(/^⋯ search_history "caravan" → /);
    expect(row.status).toBe('ok');
    expect(typeof row.ms).toBe('number');
    const file = readSessionFile(r.home, s.id);
    const j = journalOf(file.header, file.entries);
    const f = storedFacts(j, s.view().head, configOf(j), {});
    expect(f.last).toMatchObject({ rounds: 2, transport: 'native', finish: 'end' });
    await r.engine.close();
  });

});
