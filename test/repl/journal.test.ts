// cli/repl-journal.ts: what the REPL reads from the journal beyond the PathView.
import { describe, expect, test } from 'bun:test';
import {
  configOf,
  firstWords,
  journalOf,
  latestTrace,
  pathUsage,
  resolveMessageId,
  siblingIds,
  tailRows,
  textOfMessage,
  windowFor,
} from '../../src/cli/repl-journal.ts';
import { DEFAULT_SESSION_CONFIG, type Entry, type Generation, type SessionHeader, type Trace } from '../../src/session/entries.ts';

const TS = '2026-10-26T12:00:00.000Z';
const header: SessionHeader = {
  t: 'session',
  v: 1,
  id: 's_00000001',
  created: TS,
  title: 'Mira',
  cast: { character: { name: 'Mira', description: '', greetings: ['Hi'] } },
  config: DEFAULT_SESSION_CONFIG,
};

const trace = (window: number, estimated = 50): Trace => ({
  seed: 1,
  now: TS,
  window,
  reserve: 512,
  tokens: { estimated },
  blocks: [],
  lore: { fired: [], cut: [], budget: 0 },
  recap: { ids: [], arcs: [], boundary: null },
  prefill: null,
  macros: { unknown: [] },
  trimmed: null,
  calls: [],
  agents: {},
  presetHash: 'h',
  loreHashes: {},
});

const gen = (over: Partial<Generation> = {}): Generation => ({ kind: 'model', connection: 'local', model: 'q', finish: 'end', ...over });

let seq = 0;
const msg = (id: string, parent: string | null, role: 'user' | 'assistant', text: string, extra: Partial<Entry> = {}): Entry =>
  ({ t: 'msg', seq: ++seq, ts: TS, id, parent, role, blocks: [{ k: 'text', text }], ...extra }) as Entry;

function sample(): Entry[] {
  seq = 0;
  return [
    msg('g0000000', null, 'assistant', 'Hello there.', { gen: { kind: 'greeting' } }),
    msg('u1000000', 'g0000000', 'user', 'Tell me about the caravan that went missing last spring near the pass.'),
    msg('a1000000', 'u1000000', 'assistant', 'First take.', { gen: gen({ usage: { inputTotal: 1000, outputTotal: 100 } }), trace: trace(8192) }),
    msg('a2000000', 'u1000000', 'assistant', 'Second take.', { gen: gen({ usage: { inputTotal: 1000, outputTotal: 50, cost: 0.25 } }), trace: trace(8192) }),
    { t: 'edit', seq: ++seq, ts: TS, target: 'a2000000', reason: 'continue', blocks: [{ k: 'text', text: 'Second take. More.' }], gen: gen({ usage: { inputTotal: 1100, outputTotal: 10 } }), trace: trace(4096, 70) },
    { t: 'edit', seq: ++seq, ts: TS, target: 'a2000000', reason: 'user', blocks: [{ k: 'text', text: 'Second take, edited.' }] },
    { t: 'config', seq: ++seq, ts: TS, patch: { roles: { narrator: { conn: 'local', model: 'q' } }, window: 6000 } },
  ];
}

describe('journal helpers', () => {
  test('configOf folds config patches over the header', () => {
    const j = journalOf(header, sample());
    const c = configOf(j);
    expect(c.roles.narrator).toEqual({ conn: 'local', model: 'q' });
    expect(c.window).toBe(6000);
  });

  test('siblingIds in swipe order; [] for an unknown id', () => {
    const j = journalOf(header, sample());
    expect(siblingIds(j, 'a1000000')).toEqual(['a1000000', 'a2000000']);
    expect(siblingIds(j, 'g0000000')).toEqual(['g0000000']);
    expect(siblingIds(j, 'nope')).toEqual([]);
  });

  test('textOfMessage applies edits', () => {
    const j = journalOf(header, sample());
    expect(textOfMessage(j, 'a2000000')).toBe('Second take, edited.');
  });

  test('firstWords: one line, cut at a word with an ellipsis', () => {
    expect(firstWords('  a\n b  ')).toBe('a b');
    expect(firstWords('The lamp flickers as the door opens and the rain comes in', 20)).toBe('The lamp flickers…');
    expect(firstWords('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  test('tailRows: depth, role and first words', () => {
    const j = journalOf(header, sample());
    expect(tailRows(j, ['a1000000', 'missing'])).toEqual([{ id: 'a1000000', role: 'assistant', depth: 3, words: 'First take.' }]);
  });

  test('resolveMessageId: full id, unique prefix, ambiguity, miss', () => {
    const j = journalOf(header, sample());
    expect(resolveMessageId(j, 'a1000000')).toEqual({ ok: true, id: 'a1000000' });
    expect(resolveMessageId(j, 'A2')).toEqual({ ok: true, id: 'a2000000' });
    const amb = resolveMessageId(j, 'a');
    expect(amb.ok).toBe(false);
    if (!amb.ok) expect(amb.message).toContain('matches 2 messages');
    const miss = resolveMessageId(j, 'ff');
    if (!miss.ok) expect(miss.message).toContain('no message starts with');
  });

  test('pathUsage counts answers and their continues; provider cost first, then the price table', () => {
    const j = journalOf(header, sample());
    const prices = { 'local:q': { inPerM: 1, outPerM: 10 } };
    // Path G → U → A2 (A2 + its continue): A2 reports cost 0.25; the continue is priced from the table.
    const u = pathUsage(j, ['g0000000', 'u1000000', 'a2000000'], prices);
    expect(u.calls).toBe(2);
    expect(u.inputTokens).toBe(2100);
    expect(u.outputTokens).toBe(60);
    expect(u.costUsd).toBeCloseTo(0.25 + (1100 * 1 + 10 * 10) / 1_000_000, 10);
    expect(u.unpriced).toBe(0);
    // Without a price row the continue is unpriced; the provider-reported answer still counts.
    const none = pathUsage(j, ['a2000000'], {});
    expect(none.unpriced).toBe(1);
    expect(none.costUsd).toBe(0.25);
    // Nothing priced at all: null, never 0.
    expect(pathUsage(j, ['a1000000'], {}).costUsd).toBeNull();
  });

  test('pathUsage: answers without usage are counted apart', () => {
    seq = 0;
    const j = journalOf(header, [msg('u', null, 'user', 'x'), msg('a', 'u', 'assistant', 'y', { gen: gen() })]);
    expect(pathUsage(j, ['u', 'a'], {})).toEqual({ calls: 1, inputTokens: 0, outputTokens: 0, noUsage: 1, costUsd: null, unpriced: 0 });
  });

  test('latestTrace: the newest continue, else the message itself, else null', () => {
    const j = journalOf(header, sample());
    expect(latestTrace(j, 'a2000000')).toMatchObject({ continued: true, trace: { window: 4096 } });
    expect(latestTrace(j, 'a1000000')).toMatchObject({ continued: false, trace: { window: 8192 } });
    expect(latestTrace(j, 'g0000000')).toBeNull();
    expect(latestTrace(j, 'nope')).toBeNull();
  });

  test('windowFor: the last trace of the same binding, else a caps override, capped by the session window', () => {
    const j = journalOf(header, sample());
    const path = ['g0000000', 'u1000000', 'a2000000'];
    expect(windowFor(j, path, { conn: 'local', model: 'q' }, {}, undefined)).toBe(4096);
    expect(windowFor(j, path, { conn: 'local', model: 'q' }, {}, 3000)).toBe(3000);
    expect(windowFor(j, path, { conn: 'other', model: 'm' }, { 'other:m': { contextLength: 32768 } }, 16000)).toBe(16000);
    expect(windowFor(j, path, { conn: 'other', model: 'm' }, {}, undefined)).toBeNull();
  });
});
