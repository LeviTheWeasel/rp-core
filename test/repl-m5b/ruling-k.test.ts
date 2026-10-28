// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b REPL after the final check (.notes/m5b-decisions.md, the lead's ruling K): a verb's refusal and a
// lane notice name a pass as the lane lines do ('filing #3', 'historian #1–#7'), never by its task key
// (agents-cli lane.ts:681); /memory status says what stops the lane (MemoryStatus.blocked: a recorder
// with no route, cli#9; an agent paused by the circuit breaker, cli#1), and /memory wait says a paused
// lane cannot run.
import { afterEach, describe, expect, test } from 'bun:test';
import { laneKeysInWords, laneResumedWords, renderLaneStatus, renderLaneWait, type LaneWords } from '../../src/cli/repl-render.ts';
import type { MemoryStatus } from '../../src/engine/api.ts';
import { answer, calls, char, filed, pathIds, refused, replRig, said, type ReplRig } from './kit.ts';

let rig: ReplRig | null = null;
afterEach(async () => {
  await rig?.engine.close();
  rig = null;
});

/** Run the lines as a script, then end the input; the rig's handle is the session opened again. */
async function script(r: ReplRig, ...lines: string[]): Promise<string> {
  r.type(...lines);
  r.end();
  expect(await r.done).toBe(0);
  r.session = r.engine.session(r.session.id);
  return r.out();
}

const words: Pick<LaneWords, 'at'> = { at: (id) => ({ g: '#1', u1: '#2', a1: '#3', u2: '#4', a2: '#5' })[id] ?? id };

describe('task keys in engine texts read as pass names (pure)', () => {
  test('a refusal’s key, a notice’s “<agent> task <key>”, a historian window; other text untouched', () => {
    expect(laneKeysInWords('file:a1 is parked after 3 failed attempts: /memory retry queues it again', words)).toBe(
      'filing #3 is parked after 3 failed attempts: /memory retry queues it again',
    );
    expect(laneKeysInWords("Turns took the Compendium's filing task file:a1 away 3 times in a row: it runs first at the next pause.", words)).toBe(
      "Turns took the Compendium's filing #3 away 3 times in a row: it runs first at the next pause.",
    );
    expect(laneKeysInWords("Turns took the Compendium's historian task hist:u1-a2 away 3 times", words)).toBe("Turns took the Compendium's historian #2–#5 away 3 times");
    expect(laneKeysInWords('the answers file:a2 files are hidden', words)).toBe('the answers filing #5 files are hidden');
    expect(laneKeysInWords('message a1 is hidden: hidden messages are not filed (compendium.filing.wait)', words)).toBe(
      'message a1 is hidden: hidden messages are not filed (compendium.filing.wait)',
    );
  });
});

describe('refile refusals name the pass (agents-cli lane.ts:681)', () => {
  test('a pass whose answers are all hidden: “filing #3 …”, not its key', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол'))), { config: { compendium: { enabled: true, historian: { interval: 0 } } } });
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/hide 3', '/memory refile 2');
    const a1 = pathIds(rig)[2]!;
    const line = said(out, '/memory refile 2');
    expect(line).toStartWith('/memory refile: filing #3 ');
    expect(line).toContain('hidden messages are not filed');
    expect(out).not.toContain(`file:${a1}`);
  });
});

describe('/memory status says what stops the lane (ruling K: MemoryStatus.blocked)', () => {
  const s = (blocked: MemoryStatus['blocked'], queued = 0): MemoryStatus => ({
    queued: Array.from({ length: queued }, (_, i) => ({ key: `file:a${i + 1}`, task: 'file' as const, on: `a${i + 1}`, range: [`u${i + 1}`, `a${i + 1}`] as [string, string], attempt: 1 })),
    parked: [],
    backlog: queued,
    ...(blocked ? { blocked } : {}),
  });
  const NO_ROUTE = { agent: 'both' as const, reason: 'no_route' as const, message: 'The Compendium\'s filing and historian cannot run: the recorder\'s connection "ghost" (model "m") is not available.' };
  const PAUSED = { agent: 'filing' as const, reason: 'paused' as const, message: 'The filing agent is paused: two of its tasks in a row were parked after failing.' };

  test('a recorder with no route: the queue, then why it cannot run', () => {
    expect(renderLaneStatus(s(NO_ROUTE, 2), words)).toBe(
      [
        "the Compendium's background lane: 2 queued · 2 answers not filed yet",
        `  blocked: ${NO_ROUTE.message}`,
        '  queued: filing #3, filing #5',
      ].join('\n'),
    );
  });

  test('a paused agent: said under an idle lane too; /memory wait says the lane is paused, not that the recorder has no model', () => {
    expect(renderLaneStatus(s(PAUSED), words)).toBe(`the Compendium's background lane is idle: nothing queued, nothing parked\n  paused: ${PAUSED.message}`);
    expect(renderLaneWait({ ...s(PAUSED, 1), idle: true }, false, undefined, words)).toBe(`the background lane cannot run: 1 task queued. ${PAUSED.message}`);
    expect(renderLaneWait({ ...s(NO_ROUTE, 1), idle: true }, false, undefined, words)).toBe(
      'the background lane cannot run: 1 task queued and the recorder has no model to run on (/model recorder <connection:model>)',
    );
  });

  test('nothing stops it: no such line', () => {
    expect(renderLaneStatus(s(undefined, 1), words)).toBe("the Compendium's background lane: 1 queued · 1 answer not filed yet\n  queued: filing #3");
  });

  test('through the REPL: a recorder bound to a connection that does not exist', async () => {
    rig = await replRig(calls(answer('1.'), answer('2.')), { config: { roles: { recorder: { conn: 'ghost', model: 'm' } } } });
    const out = await script(rig, 'a', 'b', '/memory status');
    expect(said(out, '/memory status')).toMatch(/^the Compendium's background lane: 1 queued · 1 answer not filed yet\n {2}blocked: The Compendium's filing and historian cannot run: the recorder's connection "ghost" \(model "m"\) is not available\.[^\n]*\n {2}queued: filing #3\n$/);
  });
});

describe('the circuit breaker in the REPL (ruling K, cli#1)', () => {
  test('two filing tasks parked in a row: the notice, /memory status says the agent is paused; a retry that finds nothing parked says it runs again', async () => {
    const six = Array.from({ length: 6 }, () => refused());
    rig = await replRig(calls(answer('1.'), answer('2.'), answer('3.'), ...six));
    const out = await script(rig, 'a', 'b', 'c', '/memory wait', '/memory status', '/hide 3', '/hide 5', '/memory retry');
    expect(out.split('(memory_paused)').length - 1).toBe(1);
    const status = said(out, '/memory status');
    expect(status).toStartWith("the Compendium's background lane: 2 parked");
    expect(status).toContain('\n  paused: The filing agent is paused: ');
    expect(said(out, '/memory retry')).toBe('/memory retry: nothing is parked on this path; the filing agent runs again (it was paused)\n');
  });

  test('the words for each paused agent; a recorder with no route hides which', () => {
    const paused = (agent: 'filing' | 'historian' | 'both') => ({ agent, reason: 'paused' as const, message: '' });
    expect(laneResumedWords(paused('filing'))).toBe('the filing agent runs again (it was paused)');
    expect(laneResumedWords(paused('historian'))).toBe('the historian runs again (it was paused)');
    expect(laneResumedWords(paused('both'))).toBe('the filing agent and the historian run again (they were paused)');
    expect(laneResumedWords({ agent: 'both', reason: 'no_route', message: '' })).toBe('the paused agents run again');
    expect(laneResumedWords(undefined)).toBe('the paused agents run again');
  });
});
