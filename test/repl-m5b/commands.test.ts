// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b REPL, the pure parts (.notes/m5b-decisions.md D-180, D-181): parsing /memory undo|refile|retry|
// wait|status, their classes, /help; the lane's lines, /memory status and wait, the /trace recap line,
// /memory show's agent provenance.
import { describe, expect, test } from 'bun:test';
import { commandClass, helpText, parseLine, type Command } from '../../src/cli/repl-commands.ts';
import { laneAgentLine, laneUndoneLine, passName, recapTraceLine, renderEntryCard, renderLaneStatus, renderLaneWait, type LaneWords } from '../../src/cli/repl-render.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';

function cmd(line: string): Command {
  const p = parseLine(line);
  if (p.kind !== 'command') throw new Error(`not a command: ${line} → ${JSON.stringify(p)}`);
  return p.command;
}
function error(line: string): string {
  const p = parseLine(line);
  if (p.kind !== 'error') throw new Error(`not an error: ${line} → ${JSON.stringify(p)}`);
  return p.message;
}

describe('parsing', () => {
  test('/memory undo|refile <ref|#n> [file|hist]: a number, #number or hex id; the task by either name', () => {
    expect(cmd('/memory undo 5')).toEqual({ name: 'memory', action: 'undo', at: { n: 5 } });
    expect(cmd('/memory undo #5 hist')).toEqual({ name: 'memory', action: 'undo', at: { n: 5 }, task: 'hist' });
    expect(cmd('/memory refile AB12cd file')).toEqual({ name: 'memory', action: 'refile', at: { id: 'ab12cd' }, task: 'file' });
    expect(cmd('/memory refile 7 Historian')).toEqual({ name: 'memory', action: 'refile', at: { n: 7 }, task: 'hist' });
    expect(cmd('/memory undo 3 filing')).toMatchObject({ task: 'file' });
    expect(error('/memory undo #0')).toBe('/memory undo: "#0" is not a message (its number as /show prints it (5 or #5) or its id)');
    expect(error('/memory refile Фрол')).toBe('/memory refile: "Фрол" is not a message (its number as /show prints it (5 or #5) or its id)');
    expect(error('/memory undo 5 file now')).toBe('/memory undo takes a message and at most file or hist (/memory undo <ref|#n> [file|hist])');
    expect(error('/memory refile')).toContain('/memory refile needs a message');
  });

  test('/memory retry [#n], /memory wait [sec], /memory status', () => {
    expect(cmd('/memory retry')).toEqual({ name: 'memory', action: 'retry' });
    expect(cmd('/memory retry #4')).toEqual({ name: 'memory', action: 'retry', at: { n: 4 } });
    expect(cmd('/memory retry beef')).toEqual({ name: 'memory', action: 'retry', at: { id: 'beef' } });
    expect(error('/memory retry 4 5')).toBe('/memory retry takes at most one message: its number as /show prints it (5 or #5) or its id (bare /memory retry retries every parked task)');
    expect(cmd('/memory wait')).toEqual({ name: 'memory', action: 'wait' });
    expect(cmd('/memory wait 30')).toEqual({ name: 'memory', action: 'wait', sec: 30 });
    expect(cmd('/memory wait 0.5')).toEqual({ name: 'memory', action: 'wait', sec: 0.5 });
    expect(error('/memory wait soon')).toBe('/memory wait takes a number of seconds to wait at most, e.g. /memory wait 30 (got "soon")');
    expect(cmd('/memory status')).toEqual({ name: 'memory', action: 'status' });
    expect(error('/memory status all')).toBe('/memory status takes nothing after it');
  });

  test('classes: undo, refile and retry write (refused mid-turn); wait and status only read', () => {
    for (const l of ['/memory undo 3', '/memory refile 3', '/memory retry']) expect(commandClass(cmd(l))).toBe('edit');
    for (const l of ['/memory wait', '/memory wait 5', '/memory status']) expect(commandClass(cmd(l))).toBe('read');
  });

  test('recall\'s subcommands arrived with M5c (D-206); /help lists the M5b ones and has no Later line', () => {
    expect(cmd('/memory recall')).toEqual({ name: 'memory', action: 'recall' });
    expect(cmd('/memory profile')).toEqual({ name: 'memory', action: 'profile' });
    expect(cmd('/memory mode')).toEqual({ name: 'memory', action: 'mode' });
    const help = helpText();
    for (const s of [
      '/memory undo <ref|#n> [file|hist]   take back what the filing agent (or the historian) wrote from message n',
      '/memory refile <ref|#n> [file|hist] file message n again',
      '/memory retry [#n]  run the parked tasks again',
      '/memory wait [sec]  wait until the Compendium\'s background work is done',
      '/memory status     the background work: what runs, what waits, what is parked, answers not filed yet',
    ]) {
      expect(help).toContain(s);
    }
    expect(help).not.toContain('Later:');
    expect(help).not.toContain('M5b');
  });
});

describe('the lane\'s lines', () => {
  const words = (o: Partial<LaneWords> = {}): LaneWords => ({
    at: (id) => ({ g: '#1', u1: '#2', a1: '#3', u2: '#4', a2: '#5' })[id] ?? id,
    handle: (key) => ({ 'character:фрол': 'C12', 'location:маяк': 'C3', 'arc:фонарь': 'C20' })[key],
    job: (id) => ({ j_1: { key: 'file:a1', on: 'a1', attempt: 2 }, j_2: { key: 'hist:g-a2', on: 'a2', attempt: 1 } })[id],
    maxAttempts: 3,
    ...o,
  });
  const ev = (body: EventBody): Event => ({ sessionId: 's', ts: '2026-10-28T12:00:00.000Z', ...body }) as Event;
  const mem = (ref: string, kind: string, name: string, change: 'created' | 'merged' | 'arc' | 'reverted' = 'created', by: 'filing' | 'historian' | 'user' = 'filing') =>
    ev({ type: 'memory', change, ref, kind, name, by }) as Extract<Event, { type: 'memory' }>;
  const agent = (body: Omit<Extract<EventBody, { type: 'agent' }>, 'type'>) => ev({ type: 'agent', ...body }) as Extract<Event, { type: 'agent' }>;

  test('passName: a filing pass by its answer, the historian\'s by its window', () => {
    expect(passName('file:a1', words())).toBe('filing #3');
    expect(passName('hist:g-a2', words())).toBe('historian #1–#5');
    expect(passName('file:gone', words())).toBe('filing gone');
    expect(passName('odd', words())).toBe('odd');
  });

  test('done: the entries it changed, each once in first-change order (an arc marked); gone ones by kind; skipped counted', () => {
    const changes = [mem('character:фрол', 'character', 'Фрол'), mem('location:маяк', 'location', 'Серый маяк', 'merged'), mem('character:фрол', 'character', 'Фрол', 'merged')];
    expect(laneAgentLine(agent({ agent: 'filing', status: 'done', job: 'j_1', count: 2, skipped: 0 }), changes, words())).toBe('⋯ memory: filing #3 → +2: C12 "Фрол", C3 "Серый маяк"');
    expect(laneAgentLine(agent({ agent: 'historian', status: 'done', job: 'j_2', count: 2, skipped: 1 }), [mem('arc:фонарь', 'arc', 'Фонарь', 'arc', 'historian'), mem('summary:x', 'summary', 'Встреча', 'created', 'historian')], words())).toBe(
      '⋯ memory: historian #1–#5 → +2: C20 [Arc] "Фонарь", summary "Встреча" · 1 skipped',
    );
    expect(laneAgentLine(agent({ agent: 'filing', status: 'done', job: 'j_1', count: 0 }), [], words())).toBe('⋯ memory: filing #3 → nothing to file');
    expect(laneAgentLine(agent({ agent: 'historian', status: 'done', job: 'j_2', count: 0 }), [], words())).toBe('⋯ memory: historian #1–#5 → nothing to record');
    expect(laneAgentLine(agent({ agent: 'filing', status: 'done', job: 'j_1', count: 3 }), [], words())).toBe('⋯ memory: filing #3 → nothing new');
    const many = Array.from({ length: 10 }, (_, i) => mem(`character:n${i}`, 'character', `N${i}`));
    expect(laneAgentLine(agent({ agent: 'filing', status: 'done', job: 'j_1', count: 10 }), many, words())).toBe(
      '⋯ memory: filing #3 → +10: character "N0", character "N1", character "N2", character "N3", character "N4", character "N5", character "N6", character "N7", … 2 more',
    );
  });

  test('preempted, failed with its attempt, parked with the way out; queued and started say nothing; an unknown job by its agent', () => {
    expect(laneAgentLine(agent({ agent: 'filing', status: 'preempted', job: 'j_1' }), [], words())).toBe('⋯ memory: filing #3 gave way to a turn; it runs again at the next pause');
    expect(laneAgentLine(agent({ agent: 'filing', status: 'failed', job: 'j_1', code: 'timeout' }), [], words())).toBe('⋯ memory: filing #3 failed [timeout] (attempt 2 of 3)');
    expect(laneAgentLine(agent({ agent: 'filing', status: 'parked', job: 'j_1', code: 'timeout' }), [], words())).toBe('⋯ memory: filing #3 parked after 3 failed attempts: /memory retry #3 runs it again');
    expect(laneAgentLine(agent({ agent: 'historian', status: 'failed', job: 'j_9', code: 'no_output' }), [], words())).toBe('⋯ memory: historian failed [no_output]');
    expect(laneAgentLine(agent({ agent: 'filing', status: 'queued' }), [], words())).toBeNull();
    expect(laneAgentLine(agent({ agent: 'filing', status: 'started', job: 'j_1' }), [], words())).toBeNull();
  });

  test('an undo\'s line', () => {
    expect(laneUndoneLine([mem('character:фрол', 'character', 'Фрол', 'reverted', 'user'), mem('event:лодка', 'event', 'Лодка с солью', 'reverted', 'user')], words())).toBe(
      '⋯ memory: undo → −2: C12 "Фрол", event "Лодка с солью"',
    );
  });

  test('/memory status: the counts and backlog, then what runs, the queue in order, each parked task with its retry', () => {
    const status = {
      running: { key: 'file:a1', task: 'file' as const, on: 'a1', range: ['u1', 'a1'] as [string, string], attempt: 2, job: 'j_1' },
      queued: [
        { key: 'file:a2', task: 'file' as const, on: 'a2', range: ['u2', 'a2'] as [string, string], attempt: 1 },
        { key: 'hist:g-a2', task: 'hist' as const, on: 'a2', range: ['g', 'a2'] as [string, string], attempt: 1 },
      ],
      parked: [{ key: 'file:x', on: 'x', failures: 3 }],
      backlog: 3,
    };
    expect(renderLaneStatus(status, words())).toBe(
      [
        "the Compendium's background lane: 1 running, 2 queued, 1 parked · 3 answers not filed yet",
        '  running: filing #3 (attempt 2) · job j_1',
        '  queued: filing #5, historian #1–#5',
        '  parked: filing x after 3 failed attempts (/memory retry x runs it again)',
      ].join('\n'),
    );
    expect(renderLaneStatus({ queued: [], parked: [], backlog: 0 }, words())).toBe("the Compendium's background lane is idle: nothing queued, nothing parked");
  });

  test('/memory wait\'s last line: idle (nothing to do when nothing ran), parked, still working after a timeout, a lane that cannot run', () => {
    const idle = { queued: [], parked: [], backlog: 0, idle: true };
    expect(renderLaneWait(idle, false, undefined, words())).toBe('the background lane is idle: nothing to do');
    expect(renderLaneWait({ ...idle, parked: [{ key: 'file:a1', on: 'a1', failures: 3 }], backlog: 1 }, true, undefined, words())).toBe(
      'the background lane is idle · 1 parked (/memory retry runs it again) · 1 answer not filed yet',
    );
    const busy = { running: { key: 'file:a1', task: 'file' as const, on: 'a1', range: ['u1', 'a1'] as [string, string], attempt: 1, job: 'j_1' }, queued: [], parked: [], backlog: 1, idle: false };
    expect(renderLaneWait(busy, false, 30, words())).toBe('still working after 30 s: filing #3 runs (/memory status)');
    expect(renderLaneWait({ ...idle, queued: [{ key: 'file:a1', task: 'file', on: 'a1', range: ['u1', 'a1'], attempt: 1 }] }, false, undefined, words())).toBe(
      'the background lane cannot run: 1 task queued and the recorder has no model to run on (/model recorder <connection:model>)',
    );
  });
});

describe('/trace and /memory show', () => {
  test('the recap line: arcs with their revision, summaries in order, the boundary; nothing for an empty slot', () => {
    const names = new Map([
      ['arc:фонарь', 'Фонарь'],
      ['summary:a1.0', 'Встреча'],
    ]);
    const refs = new Map([
      ['arc:фонарь', 'C20'],
      ['summary:a1.0', 'C19'],
    ]);
    expect(recapTraceLine({ ids: ['summary:a1.0', 'summary:gone.0'], arcs: [{ key: 'arc:фонарь', rev: 41 }], boundary: 'a4' }, names, refs)).toBe(
      '  recap: 1 arc: C20 "Фонарь" rev 41 · 2 summaries: C19 "Встреча", summary:gone.0 · boundary a4',
    );
    expect(recapTraceLine({ ids: [], arcs: [], boundary: null })).toBeNull();
    expect(recapTraceLine(undefined)).toBeNull();
  });

  test('a library entry last changed by the filing agent says so', () => {
    const e: CEntry = {
      key: 'lib:lantern:k1',
      type: 'location',
      name: 'Серый маяк',
      aliases: [],
      tagline: '',
      data: {},
      keys: [],
      origin: { kind: 'library', book: 'lantern', id: 'k1', overlay: true },
      prov: { created: null, lastSeq: 12, appended: {}, createdSeq: 0 },
    };
    const card = renderEntryCard('C6', e, '# Серый маяк', { last: { by: 'filing', key: 'file:a1', at: '#3' } }).split('\n');
    expect(card.slice(1, 3)).toEqual([
      '  origin: the library book lantern, entry k1; changed in this session (an overlay: the book file stays as it is)',
      '  last changed at journal row 12 by the filing agent from #3 (file:a1)',
    ]);
    // A person's row adds nothing.
    expect(renderEntryCard('C6', e, '', { last: { by: 'user', key: null, at: null } }).split('\n')[2]).toBe('  last changed at journal row 12');
  });
});
