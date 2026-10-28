// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c's REPL commands, pure (.notes/m5c-decisions.md D-206): /memory recall [--turn <#n|id>], /memory
// profile and /memory mode parse and class as read (a mode that changes the config edits), /help lists
// them and has no Later line (MEMORY_LATER is empty), /model shows an unset recall following the
// recorder (D-85); the renderers of the record card, the /trace recall line, the lane's prefetch line,
// /memory status and wait with the prefetch (ruling H), the profiles and the mode; after the review
// (ruling K) a manual lane's mode, a dropped prefetch, a skipped one's status and the script's default.
import { describe, expect, test } from 'bun:test';
import type { MemoryStatus } from '../../src/engine/api.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import { commandClass, helpText, parseLine, RECALL_MODES, type Command } from '../../src/cli/repl-commands.ts';
import {
  lanePrefetchLine,
  recallModeText,
  recallRunsAs,
  recallTraceLine,
  renderBindings,
  renderLaneStatus,
  renderLaneWait,
  renderProfiles,
  renderRecallCard,
  type RecallWords,
} from '../../src/cli/repl-render.ts';
import type { RecallRecord, Trace } from '../../src/session/entries.ts';

const cmd = (line: string): Command => {
  const p = parseLine(line);
  if (p.kind !== 'command') throw new Error(`not a command: ${line} → ${JSON.stringify(p)}`);
  return p.command;
};
const error = (line: string): string => {
  const p = parseLine(line);
  if (p.kind !== 'error') throw new Error(`not an error: ${line} → ${JSON.stringify(p)}`);
  return p.message;
};

/** Messages a1…: #n by their position; k1… named entries; `gone` is not on this path. */
const words: RecallWords = {
  at: (id) => (/^a\d$/.test(id) ? `#${id.slice(1)}` : id),
  entry: (key) => ({ k1: { ref: 'C9', name: 'Переправа к маяку' }, k2: { ref: 'C3', name: 'Фонарный ряд' } })[key],
};

const record = (over: Partial<RecallRecord> = {}): RecallRecord => ({
  v: 1,
  status: 'recalled',
  source: 'sync',
  profile: 'full',
  picks: [{ ref: 'k1', reason: 'the night he was taken' }, { ref: 'k2' }],
  unknown: 0,
  repeated: 0,
  trimmed: 0,
  omitted: 0,
  byName: 0,
  salvaged: 0,
  calls: 1,
  ms: 400,
  model: 'script:default',
  transport: 'tagged',
  ...over,
});

const trace = (calls: Trace['calls'] = [], source: NonNullable<Trace['compendium']>['source'] = 'sync'): Trace =>
  ({ calls, compendium: { source } }) as unknown as Trace;
const recallCall = (ms: number, n = 0): Trace['calls'][number] => ({ callKey: `t_1:recall:${n}`, agent: 'recall', model: 'script:default', ms });

const agentEv = (body: Omit<Extract<EventBody, { type: 'agent' }>, 'type' | 'agent'>): Extract<Event, { type: 'agent' }> =>
  ({ sessionId: 's', ts: '2026-10-28T12:00:00.000Z', type: 'agent', agent: 'recall', ...body }) as Extract<Event, { type: 'agent' }>;

const idle: MemoryStatus = { queued: [], parked: [], backlog: 0 };

describe('parsing (D-206)', () => {
  test('/memory recall: bare, a number, #n, an id, --turn <ref>; one answer at most', () => {
    expect(cmd('/memory recall')).toEqual({ name: 'memory', action: 'recall' });
    expect(cmd('/memory recall 5')).toEqual({ name: 'memory', action: 'recall', at: { n: 5 } });
    expect(cmd('/memory recall #5')).toEqual({ name: 'memory', action: 'recall', at: { n: 5 } });
    expect(cmd('/memory recall AB12cd')).toEqual({ name: 'memory', action: 'recall', at: { id: 'ab12cd' } });
    expect(cmd('/memory recall --turn 16a7c58e')).toEqual({ name: 'memory', action: 'recall', at: { id: '16a7c58e' } });
    expect(cmd('/memory recall --turn #3')).toEqual({ name: 'memory', action: 'recall', at: { n: 3 } });
    expect(error('/memory recall --turn')).toBe('/memory recall --turn needs an answer: its number as /show prints it (5 or #5) or its id (/memory recall [--turn <#n|id>])');
    expect(error('/memory recall 3 4')).toBe('/memory recall takes one answer (/memory recall [--turn <#n|id>]); bare /memory recall shows the last one');
    expect(error('/memory recall --all')).toBe('/memory recall: unknown flag --all (/memory recall [--turn <#n|id>])');
    expect(error('/memory recall lighthouse')).toBe('/memory recall: "lighthouse" is not a message (its number as /show prints it (5 or #5) or its id)');
  });

  test('/memory profile takes nothing; /memory mode alone shows, with a mode (any case) sets', () => {
    expect(cmd('/memory profile')).toEqual({ name: 'memory', action: 'profile' });
    expect(error('/memory profile lite')).toBe('/memory profile takes nothing after it (it shows the profile of every Compendium agent)');
    expect(cmd('/memory mode')).toEqual({ name: 'memory', action: 'mode' });
    for (const m of RECALL_MODES) expect(cmd(`/memory mode ${m.toUpperCase()}`)).toEqual({ name: 'memory', action: 'mode', mode: m });
    expect(error('/memory mode fast')).toBe('/memory mode takes auto, sync, prefetch, lexical or off (got "fast"); bare /memory mode shows how recall runs now');
    expect(RECALL_MODES).toEqual(['auto', 'sync', 'prefetch', 'lexical', 'off']);
  });

  test('classes: recall, profile and a bare mode only read; a mode that sets edits (refused mid-turn)', () => {
    for (const l of ['/memory recall', '/memory recall 3', '/memory profile', '/memory mode']) expect(commandClass(cmd(l))).toBe('read');
    expect(commandClass(cmd('/memory mode sync'))).toBe('edit');
  });

  test('/help lists the three; MEMORY_LATER is empty, so there is no Later line', () => {
    const help = helpText();
    expect(help).toContain('  /memory recall [--turn #n|id]   what recall picked for the last answer (or answer n): picks, reasons, calls, time');
    expect(help).toContain('  /memory profile    the Compendium profile (full or lite) of the block, recall, filing and the historian, and why');
    expect(help).toContain('  /memory mode [auto|sync|prefetch|lexical|off]   how recall picks entries before a reply: show it, or change it');
    expect(help).toContain('answers not filed yet, the recall prefetch');
    expect(help).not.toContain('Later:');
    expect(help).not.toContain('M5c');
  });

  test('/model: an unset recall follows the recorder (D-85), an unset director or recorder the narrator', () => {
    expect(renderBindings({ narrator: { conn: 'a', model: 'm' } })).toBe('  narrator a:m\n  director narrator (follows)\n  recorder narrator (follows)\n  recall   recorder (follows)');
    expect(renderBindings({ narrator: { conn: 'a', model: 'm' }, recall: 'narrator' }, 'recall')).toBe('  recall   narrator (follows)');
  });
});

describe('the record card (/memory recall)', () => {
  test('a sync recall: how, outcome, profile, model, transport; the picks in order with handle, name and reason; calls, time, tokens', () => {
    expect(renderRecallCard('#5', record({ unknown: 1, repeated: 1, usage: { input: 200, output: 8 } }), words)).toBe(
      [
        'recall for #5: sync · recalled 2 · full · script:default · tagged',
        "  picks, in recall's order:",
        '    1. C9 "Переправа к маяку" — the night he was taken',
        '    2. C3 "Фонарный ряд"',
        '  read: 1 unknown, 1 repeated',
        '  1 call · 0.4s · 200 in / 8 out tokens',
      ].join('\n'),
    );
  });

  test('an adopted prefetch names the answer it followed; a reuse the answer it came from, with no call', () => {
    const pre = renderRecallCard('#7', record({ source: 'prefetch', basis: 'a5', profile: 'lite', picks: [{ ref: 'k2' }], byName: 1, salvaged: 2, trimmed: 1, omitted: 3 }), words);
    expect(pre).toBe(
      [
        'recall for #7: prefetch after #5 · recalled 1 · lite · script:default · tagged',
        "  picks, in recall's order:",
        '    1. C3 "Фонарный ряд"',
        '  read: 1 over the limit, 1 by name, 2 salvaged from prose, 3 entries left out of the index (its budget)',
        "  1 call in the background, without the player's message · 0.4s",
      ].join('\n'),
    );
    const { ms: _ms, ...kept } = record();
    const reused = renderRecallCard('#7', { ...kept, source: 'reused', calls: 0, reusedFrom: '16a7c58e (another version of #7)' }, words);
    expect(reused.split('\n')[0]).toBe('recall for #7: reused from 16a7c58e (another version of #7) · recalled 2 · full · script:default · tagged');
    expect(reused.split('\n').at(-1)).toBe('  0 calls: the picks of 16a7c58e (another version of #7)');
  });

  test('a failure, a missed prefetch, a skip: why, and that the selector picked alone; an entry gone from the path is named by its key', () => {
    const failed = renderRecallCard('#5', record({ status: 'failed', source: 'lexical', picks: [], code: 'timeout', ms: 1000 }), words);
    expect(failed).toBe(['recall for #5: sync · failed [timeout] · full · script:default · tagged', '  recall did not answer within its deadline: the selector picked alone (lexical)', '  1 call · 1.0s'].join('\n'));
    const missed = renderRecallCard('#9', { ...record({ status: 'skipped', source: 'lexical', picks: [], calls: 0, code: 'prefetch_missed', basis: 'a7' }), model: undefined, transport: undefined, ms: undefined } as unknown as RecallRecord, words);
    expect(missed).toBe(['recall for #9: prefetch after #7 · missed [prefetch_missed] · full', '  the prefetch was not ready when the reply started: the selector picked alone (lexical)', '  0 calls'].join('\n'));
    const noRoom = renderRecallCard('#5', record({ status: 'skipped', source: 'lexical', picks: [], calls: 0, code: 'no_room', transport: undefined, ms: undefined }), words);
    expect(noRoom.split('\n').slice(0, 2)).toEqual(['recall for #5: skipped [no_room] · full · script:default', "  the request does not fit the recall model's window: the selector picked alone (lexical)"]);
    expect(renderRecallCard('#5', record({ picks: [{ ref: 'gone' }] }), words)).toContain('    1. gone (not on this path now)');
    expect(renderRecallCard('#5', record({ status: 'empty', picks: [] }), words)).toContain('  picks: none (recall answered with an empty list)');
  });
});

describe("/trace's recall line", () => {
  test('sync: the picks named, the turn\'s recall calls (the top-up\'s too) and their time', () => {
    expect(recallTraceLine(trace([recallCall(400), recallCall(300, 1)]), record(), words)).toBe('  recall: sync · 2 picked: C9 "Переправа к маяку", C3 "Фонарный ряд" · 2 calls 0.7s');
    expect(recallTraceLine(trace([recallCall(1000)]), record({ status: 'failed', source: 'lexical', picks: [], code: 'timeout' }), words)).toBe('  recall: sync · failed [timeout] → lexical · 1 call 1.0s');
  });

  test("an adopted prefetch: no call in the turn, the prefetch's own from its record; a miss and a reuse: none", () => {
    expect(recallTraceLine(trace([], 'prefetch'), record({ source: 'prefetch', basis: 'a5', ms: 2500 }), words)).toBe(
      '  recall: prefetch after #5 · 2 picked: C9 "Переправа к маяку", C3 "Фонарный ряд" · 0 calls in this turn (the prefetch: 1 call 2.5s)',
    );
    expect(recallTraceLine(trace([], 'lexical'), record({ status: 'skipped', source: 'lexical', picks: [], calls: 0, code: 'prefetch_missed', basis: 'a5' }), words)).toBe(
      '  recall: prefetch after #5 · missed [prefetch_missed] → lexical · 0 calls',
    );
    expect(recallTraceLine(trace([], 'reused'), record({ source: 'reused', calls: 0, reusedFrom: 'a3' }), words)).toBe(
      '  recall: reused from #3 · 2 picked: C9 "Переправа к маяку", C3 "Фонарный ряд" · 0 calls',
    );
    expect(recallTraceLine(trace([]), record({ status: 'skipped', source: 'lexical', picks: [], calls: 0, code: 'empty_index' }), words)).toBe('  recall: skipped [empty_index] → lexical · 0 calls');
  });

  test('without a record: lexical or off from the block; nothing without Compendium input; past 8 picks the rest are counted', () => {
    expect(recallTraceLine(trace([], 'lexical'), null, words)).toBe('  recall: lexical (no recall call; the selector picked alone)');
    expect(recallTraceLine(trace([], 'off'), null, words)).toBe('  recall: off (no recall call)');
    expect(recallTraceLine({ calls: [] } as unknown as Trace, null, words)).toBeNull();
    const many = record({ picks: Array.from({ length: 10 }, () => ({ ref: 'k2' })) });
    expect(recallTraceLine(trace([recallCall(100)]), many, words)).toContain('C3 "Фонарный ряд", … 2 more · 1 call 0.1s');
  });
});

describe("the lane's prefetch lines, /memory status and /memory wait (ruling H)", () => {
  const ready = (rec: RecallRecord): NonNullable<MemoryStatus['prefetch']> => ({ basis: 'a5|r|0|0|f', on: 'a5', state: 'ready', record: rec });

  test('done names the answer and the picks from the status at arrival; without it, a count; failed, preempted, a coded skip; nothing for queued, started, superseded', () => {
    const rec = record({ source: 'prefetch', basis: 'a5' });
    expect(lanePrefetchLine(agentEv({ status: 'done', source: 'prefetch', count: 2 }), ready(rec), words)).toBe('⋯ recall: prefetched after #5 → 2: C9 "Переправа к маяку", C3 "Фонарный ряд"');
    expect(lanePrefetchLine(agentEv({ status: 'done', source: 'prefetch', count: 2 }), undefined, words)).toBe('⋯ recall: prefetched → 2 picks');
    expect(lanePrefetchLine(agentEv({ status: 'done', source: 'prefetch', count: 0 }), ready(record({ picks: [] })), words)).toBe('⋯ recall: prefetched after #5 → nothing picked');
    expect(lanePrefetchLine(agentEv({ status: 'failed', code: 'timeout' }), ready(record({ status: 'failed', picks: [], code: 'timeout' })), words)).toBe('⋯ recall: the prefetch after #5 failed [timeout]');
    expect(lanePrefetchLine(agentEv({ status: 'preempted' }), { basis: 'b', on: 'a5', state: 'queued' }, words)).toBe('⋯ recall: the prefetch after #5 gave way to a turn; it runs again at the next pause');
    expect(lanePrefetchLine(agentEv({ status: 'skipped', code: 'no_room' }), undefined, words)).toBe('⋯ recall: the prefetch was skipped [no_room]');
    for (const body of [{ status: 'queued' }, { status: 'started', source: 'prefetch' }, { status: 'skipped', reason: 'superseded' }] as const) {
      expect(lanePrefetchLine(agentEv(body), undefined, words)).toBeNull();
    }
  });

  test('a run that gave way to a turn runs again only while the lane owes its basis; else it was dropped, and why (ruling K, cli#6)', () => {
    const ev = agentEv({ status: 'preempted' });
    const pre = { basis: 'b', on: 'a5', state: 'running' } as const;
    expect(lanePrefetchLine(ev, pre, words, { again: true, answer: 'last' })).toBe('⋯ recall: the prefetch after #5 gave way to a turn; it runs again at the next pause');
    expect(lanePrefetchLine(ev, { ...pre, on: 'gone' }, words, { again: false, answer: 'gone' })).toBe(
      '⋯ recall: the prefetch after gone gave way to a turn and was dropped: that answer was replaced (a swipe, a regen or a rewind)',
    );
    expect(lanePrefetchLine(ev, pre, words, { again: false, answer: 'last' })).toBe(
      '⋯ recall: the prefetch after #5 gave way to a turn and was dropped: that answer changed (a continue or an edit), so a prefetch after it starts over',
    );
    expect(lanePrefetchLine(ev, pre, words, { again: false, answer: 'earlier' })).toBe('⋯ recall: the prefetch after #5 gave way to a turn and was dropped: the story went on past that answer');
  });

  test('/memory status counts a queued or running prefetch and says it; a ready one on the idle line', () => {
    expect(renderLaneStatus({ ...idle, prefetch: { basis: 'b', on: 'a5', state: 'running' } }, words)).toBe("the Compendium's background lane: 1 running\n  recall: the prefetch after #5 runs");
    expect(renderLaneStatus({ ...idle, prefetch: { basis: 'b', on: 'a5', state: 'queued' } }, words)).toBe(
      "the Compendium's background lane: 1 queued\n  recall: the prefetch after #5 is queued (it runs when nothing else does)",
    );
    expect(renderLaneStatus({ ...idle, prefetch: ready(record({ source: 'prefetch' })) }, words)).toBe(
      "the Compendium's background lane is idle: nothing queued, nothing parked\n  recall: prefetched after #5, ready for the next reply: 2 picked: C9 \"Переправа к маяку\", C3 \"Фонарный ряд\"",
    );
    expect(renderLaneStatus({ ...idle, prefetch: ready(record({ status: 'failed', picks: [], code: 'timeout' })) }, words)).toContain(
      '  recall: the prefetch after #5 failed [timeout]: the next reply falls back (compendium.recall.on_miss)',
    );
    // A skipped prefetch is adopted as it is: the next reply goes lexical whatever on_miss says (ruling K, cli#10).
    expect(renderLaneStatus({ ...idle, prefetch: ready(record({ status: 'skipped', source: 'lexical', picks: [], calls: 0, code: 'empty_index' })) }, words)).toContain(
      '  recall: the prefetch after #5 skipped [empty_index]: there was no entry to pick from (every one named recently, hidden or in the recap); the next reply goes without recall (lexical)',
    );
    expect(renderLaneStatus({ ...idle, prefetch: ready(record({ status: 'skipped', source: 'lexical', picks: [], calls: 0, code: 'no_room' })) }, words)).not.toContain('on_miss');
    expect(renderLaneStatus(idle, words)).toBe("the Compendium's background lane is idle: nothing queued, nothing parked");
  });

  test('/memory wait that ran out while the prefetch runs or waits says so', () => {
    expect(renderLaneWait({ ...idle, idle: false, prefetch: { basis: 'b', on: 'a5', state: 'running' } }, false, 1, words)).toBe(
      'still working after 1 s: the recall prefetch after #5 runs (/memory status)',
    );
    expect(renderLaneWait({ ...idle, idle: false, prefetch: { basis: 'b', on: 'a5', state: 'queued' } }, false, 2, words)).toBe('still working after 2 s: 1 queued (/memory status)');
  });
});

describe('/memory profile and /memory mode', () => {
  test('auto: each agent by its own window, and how its binding was found; full or lite set decides for all', () => {
    const rows = [
      { agent: 'block', profile: 'lite', model: 'ollama:m', window: 16384, whose: "the narrator's" },
      { agent: 'recall', profile: 'full', model: 'or:big', window: 32768, whose: "the recall model's", detail: 'up to 10 picks, reading the last 20 messages' },
      { agent: 'filing', profile: null, model: 'x:y', window: null, whose: "the recorder's", follows: 'follows the narrator', off: 'compendium.filing.enabled is false' },
    ] as const;
    expect(renderProfiles('auto', rows)).toBe(
      [
        'Compendium profiles (compendium.profile auto: lite below a 24576-token window, full from it):',
        "  block     lite: the narrator's window 16384 < 24576 · ollama:m",
        "  recall    full: the recall model's window 32768 ≥ 24576 · or:big · up to 10 picks, reading the last 20 messages",
        "  filing    full or lite: the recorder's window is not known yet · x:y (follows the narrator) · not running: compendium.filing.enabled is false",
      ].join('\n'),
    );
    expect(renderProfiles('lite', [{ agent: 'block', profile: 'lite', model: 'a:b', window: 32768, whose: "the narrator's" }])).toBe(
      "Compendium profiles (compendium.profile lite: every agent runs lite, whatever its window):\n  block     lite: set (the narrator's window 32768) · a:b",
    );
  });

  test('the mode, where it comes from, and what it does here (auto by the server\'s locality; prefetch with its grace and onMiss)', () => {
    const f = { mode: 'auto', from: 'default', local: true, onMiss: 'auto', graceSec: 4, model: 'ollama:m' } as const;
    expect(recallModeText(f)).toBe(
      "recall mode: auto (the default)\n  here: prefetch (the recall model's server is local): recall (ollama:m) picks in the background after each answer, while you type; a reply waits for it at most 4 s, then the selector picks alone (lexical)",
    );
    expect(recallModeText({ ...f, local: false, from: 'session' })).toBe(
      "recall mode: auto (this session's compendium.recall.mode)\n  here: sync (the recall model's server is not local): recall (ollama:m) picks the entries the narrator needs beside the Director, before each reply",
    );
    expect(recallModeText({ ...f, local: null })).toContain("prefetch when the recall model's server is local, else sync");
    expect(recallModeText({ ...f, mode: 'prefetch', local: false, from: 'set' })).toBe(
      'recall mode: prefetch (set for this session, from the next reply)\n  recall (ollama:m) picks in the background after each answer, while you type; a reply waits for it at most 4 s, then recall runs beside the Director instead (sync)',
    );
    expect(recallModeText({ ...f, mode: 'lexical', from: 'env' }).split('\n')[0]).toBe('recall mode: lexical (RP_CORE_RECALL)');
    expect(recallModeText({ ...f, mode: 'lexical', from: 'script' }).split('\n')[0]).toBe('recall mode: lexical (the --provider script tags no line "agent": "recall")');
    expect(recallModeText({ ...f, mode: 'off' }).split('\n')[1]).toBe('  recall is off: no recall call, the selector alone fills the Compendium block');
  });

  test('a manual lane never prefetches: auto on a local server and prefetch say on_miss decides (ruling K, cli#3)', () => {
    const f = { mode: 'auto', from: 'default', local: true, onMiss: 'auto', graceSec: 4, model: 'ollama:m', lane: 'manual' } as const;
    expect(recallModeText(f).split('\n')[1]).toBe(
      '  here: no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply: the selector picks alone (lexical)',
    );
    expect(recallModeText({ ...f, onMiss: 'sync' }).split('\n')[1]).toBe(
      '  here: no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply: recall runs beside the Director instead (sync)',
    );
    expect(recallModeText({ ...f, mode: 'prefetch', local: false }).split('\n')[1]).toBe(
      '  no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply: recall runs beside the Director instead (sync)',
    );
    // A remote server: auto is sync, lane or no lane; locality unknown: both said.
    expect(recallModeText({ ...f, local: false })).toBe(recallModeText({ ...f, local: false, lane: 'auto' }));
    expect(recallModeText({ ...f, local: null }).split('\n')[1]).toBe(
      "  sync when the recall model's server is not local (recall (ollama:m) picks the entries the narrator needs beside the Director, before each reply); on a local one, no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply: the selector picks alone (lexical)",
    );
    // What the next reply does (D-201, as the engine decides it).
    expect(recallRunsAs(f)).toBe('lexical');
    expect(recallRunsAs({ ...f, onMiss: 'sync' })).toBe('sync');
    expect(recallRunsAs({ ...f, lane: 'auto' })).toBe('prefetch');
    expect(recallRunsAs({ ...f, mode: 'prefetch', local: false })).toBe('sync');
    expect(recallRunsAs({ ...f, mode: 'prefetch', local: false, lane: 'auto' })).toBe('prefetch');
    expect(recallRunsAs({ ...f, local: false })).toBe('sync');
    expect(recallRunsAs({ ...f, local: null })).toBeNull();
    expect(recallRunsAs({ ...f, mode: 'lexical' })).toBe('lexical');
  });
});
