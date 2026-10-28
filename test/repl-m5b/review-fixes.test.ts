// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b REPL after the review (.notes/m5b-decisions.md, the lead's ruling I): the undo line's way back
// names the pass it took back (cli#3); a --debug line of a lane call waits for the pause (cli#5); /usage
// counts the lane's calls (cli#6); an unresolvable recorder is told once (cli#9); /memory wait waits at
// most 24 h (cli#11); a task asked for by name while its agent is off is said to wait for it; a re-run
// that leaves out what the key's earlier row made says so; a no_room task says why it parked.
import { afterEach, describe, expect, test } from 'bun:test';
import { chatDeps } from '../../src/cli/chat.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { runReplWith } from '../../src/cli/repl.ts';
import { parseLine } from '../../src/cli/repl-commands.ts';
import { laneAgentLine, renderLaneStatus, renderLaneWait, type LaneWords } from '../../src/cli/repl-render.ts';
import { engineOptions, loadRuntime, type Runtime } from '../../src/cli/runtime.ts';
import type { Connection, EngineHandle, MemoryStatus } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptedProvider } from '../../src/providers/scripted.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { CONFIG, LEVI, MIRA, typedInput } from '../repl/kit.ts';
import { answer, calls, char, chronicle, filed, jobRows, replRig, said, type ReplRig } from './kit.ts';

let rig: ReplRig | null = null;
let engine: EngineHandle | null = null;
afterEach(async () => {
  await rig?.engine.close();
  await engine?.close();
  rig = null;
  engine = null;
});

/** Run the lines as a script, then end the input; the rig's handle is the session opened again. */
async function script(r: ReplRig, ...lines: string[]): Promise<string> {
  r.type(...lines);
  r.end();
  expect(await r.done).toBe(0);
  r.session = r.engine.session(r.session.id);
  return r.out();
}

const HIST = { compendium: { enabled: true, historian: { interval: 1 } } };
const summary = (text: string) => chronicle([{ title: 'Встреча', plot: 'Фонарь', summary: text }], []);

describe('the undo line names the pass it took back (cli#3)', () => {
  test('after /memory undo 3 file the way back is /memory refile #3 file: only the filing runs again, the historian\'s summary stays', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол')), summary('first'), filed(char('Фрол', { age: '40' }))), { config: HIST });
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/memory undo 3 file', '/memory refile #3 file', '/memory wait', '/memory undo 3 hist');
    expect(said(out, '/memory undo 3 file')).toStartWith('undone: filing #3; what it wrote leaves the Compendium from the next turn (/memory refile #3 file runs it again)\n');
    expect(said(out, '/memory refile #3 file')).toBe('filing #3 queued again (/memory wait waits for it)\n');
    expect(said(out, '/memory wait', 2)).toBe('⋯ memory: filing #3 → +1: C3 "Фрол"\nthe background lane is idle\n');
    expect(rig.provider.requests.map((q) => q.agent)).toEqual(['narrator', 'narrator', 'filing', 'historian', 'filing']);
    expect(said(out, '/memory undo 3 hist')).toStartWith('undone: historian #1–#3; what it wrote leaves the Compendium from the next turn (/memory refile #3 hist runs it again)\n');
  });

  test('an undo of both passes: what they wrote, /memory refile #3 runs them again; the refile says it waits for them', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол')), summary('first')), { config: HIST });
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/memory undo 3', '/memory refile 3');
    expect(said(out, '/memory undo 3')).toStartWith(
      'undone: filing #3 and historian #1–#3; what they wrote leaves the Compendium from the next turn (/memory refile #3 runs them again)\n',
    );
    expect(said(out, '/memory refile 3')).toBe('filing #3 and historian #1–#3 queued again (/memory wait waits for them)\n');
  });
});

describe('a task asked for by name while its agent is off waits for it (ruling I)', () => {
  test('refile with the filing agent off: the line says it waits and why; status lists it held; again changes nothing', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.')), { config: { compendium: { enabled: true, filing: { enabled: false } } } });
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory refile 3', '/memory status', '/memory refile 3', '/memory wait');
    const off = 'the filing agent is off for this session (compendium.filing.enabled)';
    expect(said(out, '/memory refile 3')).toBe(`filing #3 waits: ${off}; it runs once the agent is on\n`);
    expect(said(out, '/memory status')).toBe(`the Compendium's background lane: 1 held\n  held: filing #3: ${off}\n`);
    expect(said(out, '/memory refile 3', 2)).toBe('/memory refile: filing #3 already waits for its agent; nothing changed (/memory status)\n');
    expect(said(out, '/memory wait')).toBe('the background lane is idle: nothing to do · 1 held (its agent is off: /memory status)\n');
    expect(jobRows(rig)).toEqual([]);
  });
});

describe('refile refusals in words (ruling I)', () => {
  test('a hidden message, an answer not accepted yet, the Compendium off: one red line each, the message by its number, the way on by its command', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.')));
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory refile 5', '/hide 3', '/memory refile 3', '/unhide 3', '/memory off', '/memory refile 3', '/memory retry');
    expect(said(out, '/memory refile 5')).toBe('/memory refile: message #5 is not accepted yet: an answer is filed once 1 visible user message follows it (compendium.filing.wait)\n');
    expect(said(out, '/memory refile 3')).toBe('/memory refile: message #3 is hidden: hidden messages are not filed\n');
    expect(said(out, '/memory refile 3', 2)).toBe('/memory refile: the Compendium is off: nothing is filed while it is (/memory on)\n');
    expect(said(out, '/memory retry')).toBe('/memory retry: the Compendium is off: nothing is filed while it is (/memory on)\n');
    expect(jobRows(rig)).toEqual([]);
  });
});

describe('a re-run that leaves out an entry its key\'s earlier row made (lane#8)', () => {
  test('the pass\'s line counts it after what it made: → +1: … · −1: character "Серый"', async () => {
    rig = await replRig(calls(answer('Фрол и Серый.'), answer('Дальше.'), filed(char('Фрол'), char('Серый')), filed(char('Фрол', { age: '40' }))));
    const out = await script(rig, 'Кто здесь?', 'Ясно.', '/memory wait', '/memory refile 3', '/memory wait');
    expect(said(out, '/memory wait', 2)).toBe('⋯ memory: filing #3 → +1: C1 "Фрол" · −1: character "Серый"\nthe background lane is idle\n');
  });
});

describe('/usage counts the lane\'s calls (cli#6)', () => {
  test('a filing line beside the narrator\'s, priced by its row\'s model, and the total; a failed attempt\'s call counts too', async () => {
    const used = (inputTotal: number, outputTotal: number) => ({ usage: { inputTotal, outputTotal } });
    rig = await replRig(
      calls(
        [{ text: 'Фрол кивнул.' }, used(100, 10)],
        [{ text: 'Дальше.' }, used(100, 10)],
        [used(5000, 700), { error: { code: 'bad_request', status: 400 } }],
        [{ text: JSON.stringify({ filings: [char('Фрол')] }) }, used(4000, 300)],
      ),
    );
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait 0.05', '/memory wait', '/usage');
    expect(jobRows(rig).map((j) => j.state)).toEqual(['begin', 'failed', 'begin']);
    const usage = said(out, '/usage');
    expect(usage).toStartWith('usage on this path:\n  narrator  2 generations · in 200 tok · out 20 tok');
    // The failed attempt's call (5000/700, its usage said before the server refused) and the one that filed (4000/300).
    expect(usage).toMatch(/\n {2}filing {4}2 calls · in 9000 tok · out 1000 tok · cost \$[\d.]+\n {2}total {5}in 9200 tok · out 1020 tok · cost \$[\d.]+\n$/);
  });
});

describe('an unresolvable recorder (cli#9)', () => {
  test('one recorder_unavailable notice, no backlog notice blaming its pace; /memory wait says it cannot run', async () => {
    rig = await replRig(calls(...['1.', '2.', '3.', '4.', '5.', '6.', '7.'].map(answer)), { config: { roles: { recorder: { conn: 'ghost', model: 'm' } } } });
    const out = await script(rig, 'a', 'b', 'c', 'd', 'e', 'f', 'g', '/memory wait');
    expect(out.split('(recorder_unavailable)').length - 1).toBe(1);
    expect(said(out, 'b')).toMatch(/\n! The Compendium's filing and historian cannot run: the recorder's connection "ghost" \(model "m"\) is not available\. [^\n]*\(recorder_unavailable\)\n$/);
    expect(out).not.toContain('memory_backlog');
    expect(said(out, '/memory wait')).toStartWith('the background lane cannot run: ');
  });
});

describe('/memory wait waits at most 24 h (cli#11)', () => {
  test('more seconds than that are clamped (a longer timer would overflow and fire at once)', () => {
    expect(parseLine('/memory wait 3000000')).toEqual({ kind: 'command', command: { name: 'memory', action: 'wait', sec: 86_400 } });
    expect(parseLine('/memory wait 99999999999999999999')).toEqual({ kind: 'command', command: { name: 'memory', action: 'wait', sec: 86_400 } });
    expect(parseLine('/memory wait 86399.5')).toEqual({ kind: 'command', command: { name: 'memory', action: 'wait', sec: 86_399.5 } });
  });
});

describe('the lines and status after ruling I (pure)', () => {
  const words: LaneWords = {
    at: (id) => ({ g: '#1', u1: '#2', a1: '#3' })[id] ?? id,
    handle: () => undefined,
    job: (id) => (id === 'j_1' ? { key: 'file:a1', on: 'a1', attempt: 1 } : undefined),
    maxAttempts: 3,
  };
  const agent = (body: Omit<Extract<EventBody, { type: 'agent' }>, 'type'>) => ({ sessionId: 's', ts: '2026-10-28T12:00:00.000Z', type: 'agent', ...body }) as Extract<Event, { type: 'agent' }>;

  test('no_room: the failure says nothing (the parked line follows at once and says why); a superseded run says nothing', () => {
    expect(laneAgentLine(agent({ agent: 'filing', status: 'failed', job: 'j_1', code: 'no_room' }), [], words)).toBeNull();
    expect(laneAgentLine(agent({ agent: 'filing', status: 'parked', job: 'j_1', code: 'no_room' }), [], words)).toBe(
      "⋯ memory: filing #3 parked: it does not fit the recorder's window [no_room]; /memory retry #3 runs it again",
    );
    expect(laneAgentLine(agent({ agent: 'filing', status: 'skipped', job: 'j_1', reason: 'superseded' }), [], words)).toBeNull();
  });

  test('status: a run that waits for a place on the server, held tasks and why, a no_room task', () => {
    const s: MemoryStatus = {
      running: { key: 'file:a1', task: 'file', on: 'a1', range: ['u1', 'a1'], attempt: 1, job: 'j_1', waiting: true },
      queued: [],
      held: [{ key: 'hist:g-a1', task: 'hist', on: 'a1', range: ['g', 'a1'], attempt: 1 }],
      parked: [{ key: 'file:x', on: 'x', failures: 1, code: 'no_room' }],
      backlog: 1,
    };
    expect(renderLaneStatus(s, words)).toBe(
      [
        "the Compendium's background lane: 1 running, 1 held, 1 parked · 1 answer not filed yet",
        '  running: filing #3 · job j_1 · waiting for a place on the server',
        '  held: historian #1–#3: the historian is off for this session (compendium.historian.interval is 0)',
        "  parked: filing x: it does not fit the recorder's window [no_room] (/memory retry x runs it again)",
      ].join('\n'),
    );
    expect(renderLaneWait({ queued: [], parked: [], backlog: 0, held: [s.held![0]!, s.held![0]!], idle: true }, true, undefined, words)).toBe(
      'the background lane is idle · 2 held (their agents are off: /memory status)',
    );
  });
});

describe('--debug and the lane (cli#5)', () => {
  /** A remote narrator and a remote recorder of their own (background runs beside a turn), the lane auto, --debug on. */
  async function debugRig(narr: ScriptedProvider, rec: ScriptedProvider): Promise<{ out: () => string; type: (...l: string[]) => void; end: () => void; done: Promise<number>; debugged: string[] }> {
    const home = tmpHome('rp-core-repl-');
    const conn = (id: string, provider: ScriptedProvider): Connection => ({ id, provider, caps: SCRIPT_CAPS, origin: `script:${id}`, local: false });
    const debugged: string[] = [];
    const rt: Runtime = { ...loadRuntime(home, {}), config: CONFIG, connections: { script: conn('script', narr), rec: conn('rec', rec) }, debug: (line) => void debugged.push(line) };
    engine = await Engine.open({ ...engineOptions(rt), clock: fakeClock(), random: fakeRandom(7), timeZone: 'UTC', checkpoint: { chars: 8, ms: 5, datasyncMs: 5 }, retryMaxDelayMs: 5, lane: 'auto' });
    const session = engine.createSession({ character: MIRA, persona: LEVI, config: { roles: { recorder: { conn: 'rec', model: 'default' } }, compendium: { enabled: true, filing: { wait: 0 } } } });
    const out = memoryChannel();
    const typed = typedInput();
    const done = runReplWith({ ...chatDeps(engine, session, { rt, io: { out, err: memoryChannel() } }), input: typed.input, onInterrupt: () => () => {}, color: false }, { interactive: true });
    return { out: () => out.text(), type: typed.type, end: typed.end, done, debugged };
  }
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let waited = 0; !ok(); waited += 2) {
      if (waited > 5000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  test('a lane call that fails while an answer streams: its debug line comes after the answer, before the pass\'s own line', async () => {
    const narr = createScriptedProvider(calls(answer('A1.'), [{ text: 'Part one ' }, { pause: 'p' }, { text: 'part two.' }]));
    const rec = createScriptedProvider(calls([{ pause: 'f' }, { error: { code: 'bad_request', status: 400, message: 'boom' } }]));
    const r = await debugRig(narr, rec);
    r.type('u1');
    await until(() => r.out().includes('[swipe 1/1') && rec.requests.length === 1, 'the filing of A1 to start');
    r.type('u2');
    await until(() => r.out().includes('Mira › Part one'), 'the second answer to stream');
    rec.release('f');
    // The failure is in (the debug tap ran) while the answer still streams: nothing of it on screen yet.
    await new Promise((res) => setTimeout(res, 30));
    expect(r.out()).not.toContain('debug:');
    narr.release('p');
    await until(() => r.out().includes('⋯ memory: filing #3 failed'), 'the pass\'s line');
    const rows = r.out().split('\n');
    const at = rows.findIndex((l) => l.startsWith('Mira › Part one'));
    expect(rows[at]).toBe('Mira › Part one part two.');
    expect(rows[at + 1]).toMatch(/^ {2}\[swipe 1\/1/);
    expect(rows[at + 2]).toMatch(/^debug: rec:default \(j_[0-9a-f]{8}:filing:0\) request\/bad_request HTTP 400: boom$/);
    expect(rows[at + 3]).toBe('⋯ memory: filing #3 failed [provider_error] (attempt 1 of 3)');
    // The REPL's tap took the line; the plain --debug writer saw none of it while the REPL ran.
    expect(r.debugged).toEqual([]);
    r.end();
    expect(await r.done).toBe(0);
  });
});
