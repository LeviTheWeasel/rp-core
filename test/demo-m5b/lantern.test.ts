// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M5b demo end to end, deterministic (ARCHITECTURE.md §15 M5b "Демо"; docs/M5B-DEMO.md): the real
// CLI (`bun src/cli/main.ts`, spawned as a person runs it) on an isolated home, the background lane in
// auto mode (RP_CORE_LANE=auto: the test preload makes manual the default for tests), a scripted model
// (chat.jsonl: the narrator's answers, then each filing and historian pass in the order the lane asks
// for them) and the lines a person types (script.txt, piped into `rp-core chat`; every line that gives
// the lane work is followed by `/memory wait`, so the scripted calls are taken in a fixed order). The
// world is M5a's: the narrator card and Ян (test/demo-m5a), the RoleCall book `lantern`
// (test/fixtures/ru/lantern). config.toml: [compendium] idle_delay_sec = 0, historian.interval = 3; the
// scripted window is 4 096 tokens (lite), so the history is trimmed from the 7th exchange on.
//   a. filing after accepted answers (filing.wait 1: A1 is filed once U2 is sent);
//   b. a swipe takes the replaced answer's entries off the path; /[ brings them back with no call;
//   c. an edit of a filed answer makes its pass stale, and the lane files it again;
//   d. /memory undo takes a pass back and the lane leaves it; /memory refile files it again;
//   e. lenient reading: a ```json fence, a memory with no change dropped, an `items` envelope with
//      flat items, Russian type names, camelCase and a bad enum value (a field skipped, not the item);
//   f. the historian after three player turns: a summary and an [Arc] overview; again three turns later;
//   g. the {{recap}} slot once trimming starts (/trace, /preview), the same slot after a swipe;
//   h. kill -9 during a filing call (a 60 s {delay} step), then reopen: the job runs again once, and the
//      journal holds exactly one mem row for its key; a third open finds nothing to do.
// Each step is its own test over the one recorded run; the last prints the transcript.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import type { MemoryRow } from '../../src/engine/api.ts';
import type { Entry, JobEntry, MemEntry } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { collect, ROOT, run, spawnCli, until, type RunResult } from '../cli/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

const DIR = import.meta.dir;
const M5A = join(ROOT, 'test', 'demo-m5a');
const LANTERN = join(ROOT, 'test', 'fixtures', 'ru', 'lantern', 'lantern.compendium.json');
const CONFIG = '[compendium]\nidle_delay_sec = 0\n\n[compendium.historian]\ninterval = 3\n';
/** The lane in auto mode (a person's default); no editor, so /e takes the next piped line; no colour. */
const ENV = { RP_CORE_LANE: 'auto', VISUAL: '', EDITOR: '', NO_COLOR: '1' };

const linesOf = (file: string): string[] => readFileSync(join(DIR, file), 'utf8').split('\n').filter((l) => l.trim() !== '');
/** What the person types: process 1 (the story), 2 (killed), 3 (reopened), 4 (opened once more). */
const LINES = linesOf('script.txt');
const CRASH = linesOf('crash.txt');
const RECOVER = linesOf('recover.txt');
const AGAIN = linesOf('again.txt');
/** The lines the REPL echoes: the one after `/e 3` is the edit's new text, taken by the inline editor. */
const ECHOED = LINES.filter((_, i) => LINES[i - 1] !== '/e 3');
const EDITED = LINES[LINES.indexOf('/e 3') + 1]!;
const [U1, U2, U3, U4, U5, U6, U7] = LINES.filter((l) => l.startsWith('— '));

interface Step {
  args: string[];
  r: RunResult & { killed?: boolean };
}

let home: string;
let id: string;
const steps: Step[] = [];
/** Process 1's output per typed line, in the order typed. */
let said: { line: string; out: string }[];
let ms: number;
/** The path after all four processes: [greeting, U1, A1, …, U7, A7′, U8, A8]. */
let path: string[];
let rows: MemoryRow[];
/** Each entry's data, by its C<n>. */
let data: Map<string, Record<string, unknown>>;
/** Journal rows after process 1, and after all of them. */
let afterChat: Entry[];
let entries: Entry[];

/** `rp-core chat` on the scripted model `provider` (a file here). */
const chatArgs = (provider: string, ...more: string[]): string[] => ['chat', id, ...more, '--provider', `script:${join(DIR, provider)}`];

async function cli(argv: string[], stdin: string, env?: Record<string, string>): Promise<RunResult> {
  const r = await run(['--home', home, ...argv], { stdin, ...(env ? { env } : {}) });
  steps.push({ args: argv, r });
  return r;
}

/** The chat's stdout cut at the echo of each typed line (`you › <line>`), in the order typed. */
function segments(out: string, lines: readonly string[]): { line: string; out: string }[] {
  const segs: { line: string; out: string }[] = [];
  let next = 0;
  for (const l of out.split('\n')) {
    const echo = /^you\s+› (.*)$/.exec(l);
    if (echo && next < lines.length && echo[1] === lines[next]) {
      segs.push({ line: lines[next]!, out: '' });
      next++;
    } else if (segs.length > 0) {
      segs.at(-1)!.out += `${l}\n`;
    }
  }
  return segs;
}

/** Index of the n-th typing of `line` (n from 1). */
function indexOf(line: string, n = 1): number {
  let seen = 0;
  const i = said.findIndex((s) => s.line === line && ++seen === n);
  if (i < 0) throw new Error(`no output for ${JSON.stringify(line)} #${n}`);
  return i;
}

const saidFor = (line: string, n = 1): string => said[indexOf(line, n)]!.out;

/**
 * What a line that gives the lane work and the `/memory wait` right after it printed, together: a pass
 * that ends before the REPL reads the wait prints under the line itself (the scripted lane answers take
 * 200 ms, so it does not, but the claims do not hang on the timing). The wait ends with the idle line.
 */
function withWait(line: string, n = 1): string {
  const i = indexOf(line, n);
  const wait = said[i + 1]!;
  expect(wait.line).toBe('/memory wait');
  expect(wait.out).toMatch(/^the background lane is idle.*\n$/m);
  return said[i]!.out + wait.out;
}

/** The lane's lines in an output. */
const laneLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('⋯ memory: '));

const memRows = (es: readonly Entry[]): MemEntry[] => es.filter((e): e is MemEntry => e.t === 'mem');
const jobRows = (es: readonly Entry[]): JobEntry[] => es.filter((e): e is JobEntry => e.t === 'job');
/** The mem rows of a key, in journal order. */
const rowsOf = (key: string): MemEntry[] => memRows(entries).filter((r) => r.key === key);

/** The /preview messages: `#n role · src · k tok`, then the text up to the next header. */
function previewMessages(out: string): { n: number; role: string; src: string; text: string }[] {
  const msgs: { n: number; role: string; src: string; text: string }[] = [];
  const tail = out.indexOf('\nprefill: ');
  for (const block of out.slice(0, tail < 0 ? undefined : tail).split(/\n(?=#\d+ )/)) {
    const head = /^#(\d+) (\w+) · (\S+) · \d+ tok\n/.exec(block);
    if (head) msgs.push({ n: Number(head[1]), role: head[2]!, src: head[3]!, text: block.slice(head[0].length).trim() });
  }
  return msgs;
}

/** chat.jsonl's calls, each a list of steps (the caps line left out). */
const CALLS = readFileSync(join(DIR, 'chat.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('['))
  .map((l) => JSON.parse(l) as { text?: string; delay?: number }[]);
/** The text of scripted call k (1-based). */
const callText = (k: number): string => CALLS[k - 1]!.find((s) => s.text !== undefined)!.text!;
/** A historian answer of the script, parsed. */
const historianAnswer = (k: number) =>
  JSON.parse(callText(k)) as { filings: { entry: { title: string; summary: string } }[]; arcs: { plot: string; overview: string }[] };

beforeAll(async () => {
  const t0 = performance.now();
  home = tmpHome('rp-core-demo-m5b-');
  // Setup: the RoleCall book into the library, config.toml, a new session reading the book.
  await cli(['import', LANTERN], '');
  writeFileSync(join(home, 'config.toml'), CONFIG);
  id = (await cli(['new', '--card', join(M5A, 'card.json'), '--persona', join(M5A, 'persona.json'), '--lore', 'lantern', '--no-chat'], '')).stdout.trim();

  // Process 1: the story, the lane in auto mode, every request kept.
  const chat = await cli(chatArgs('chat.jsonl', '--keep-requests'), `${LINES.join('\n')}\n`, ENV);
  said = segments(chat.stdout, ECHOED);
  afterChat = readSessionFile(home, id).entries;
  const jobsBefore = jobRows(afterChat).length;

  // Process 2: one more message; its acceptance of A7′ starts a filing call that sleeps 60 s; kill -9
  // once the job row is in the journal and the chat waits for it.
  const p = spawnCli(['--home', home, ...chatArgs('crash.jsonl')], { stdin: `${CRASH.join('\n')}\n`, env: ENV });
  const out = collect(p.stdout);
  await until(
    () => out.text().includes('› /memory wait\n') && jobRows(readSessionFile(home, id).entries).length > jobsBefore,
    15_000,
    'the filing job of A7′',
  );
  p.kill('SIGKILL');
  const [stderr] = await Promise.all([new Response(p.stderr).text(), p.exited, out.done]);
  steps.push({ args: chatArgs('crash.jsonl'), r: { code: p.exitCode ?? -1, stdout: out.text(), stderr, killed: p.signalCode === 'SIGKILL' } });

  // Process 3: reopen; the job runs again. Process 4: once more; nothing runs.
  await cli(chatArgs('recover.jsonl'), `${RECOVER.join('\n')}\n`, ENV);
  await cli(chatArgs('again.jsonl'), `${AGAIN.join('\n')}\n`, ENV);
  ms = performance.now() - t0;

  // The session as the engine folds it, after the CLI exited (lane manual: it starts nothing).
  entries = readSessionFile(home, id).entries;
  const engine = await Engine.open({ home, connections: {}, clock: fakeClock(), random: fakeRandom(5), timeZone: 'UTC' });
  try {
    const s = engine.session(id);
    path = s.view().path.map((m) => m.id);
    rows = s.memoryList();
    data = new Map(rows.map((r) => [r.ref, s.memoryGet({ ref: r.ref }).entry.data as Record<string, unknown>]));
    await s.close();
  } finally {
    await engine.close();
  }
}, 60_000);

/** The data of the live entry named `name` (a name only one entry has). */
const dataOf = (name: string): Record<string, unknown> => data.get(rows.find((r) => r.name === name)!.ref)!;

/** Path ids by name: greeting, U1, A1, U2, A2, … as on the final path (A7 is the swipe A7′). */
const msg = (name: string): string => {
  const names = ['G', 'U1', 'A1', 'U2', 'A2', 'U3', 'A3', 'U4', 'A4', 'U5', 'A5', 'U6', 'A6', 'U7', 'A7', 'U8', 'A8'];
  return path[names.indexOf(name)]!;
};

describe('the M5b demo (lantern, scripted model, the real CLI, the background lane in auto mode)', () => {
  test('every command ran: exit 0, nothing on stderr, every typed line echoed; process 2 died by SIGKILL; under 20 s', () => {
    expect(steps.map((s) => s.r.code)).toEqual([0, 0, 0, steps[3]!.r.code, 0, 0]);
    expect(steps[3]!.r.killed).toBe(true);
    for (const i of [2, 4, 5]) expect(steps[i]!.r.stderr).toBe('');
    expect(said.map((s) => s.line)).toEqual(ECHOED);
    expect(id).toMatch(/^s_[0-9a-f]{8}$/);
    expect(path).toHaveLength(17);
    expect(ms).toBeLessThan(20_000);
  });

  test('a. filing after accepted answers: nothing for U1; U2 accepts A1 and its pass files Фрол and the lighthouse (an overlay by alias)', () => {
    expect(saidFor('/memory list').split('\n')[0]).toBe('The Compendium of this path: 16 live · /memory show <ref> prints one');
    // filing.wait 1: A1 is not accepted until U2 is sent; the lane had nothing to do after U1.
    expect(laneLines(saidFor(U1!))).toEqual([]);
    expect(laneLines(withWait(U2!))).toEqual(['⋯ memory: filing #3 → +2: C17 "Фрол", C6 "Серый маяк"']);
    // One job row, then one mem row with the key of the answer and the exchange as its range.
    const first = memRows(afterChat).find((r) => r.by === 'filing')!;
    expect(first).toMatchObject({ key: `file:${msg('A1')}`, on: msg('A1'), by: 'filing', range: [msg('U1'), msg('A1')] });
    expect(first.gen).toMatchObject({ model: 'script:default', profile: 'lite', transport: 'tagged', calls: 1 });
    const begin = jobRows(afterChat)[0]!;
    expect(begin).toMatchObject({ key: `file:${msg('A1')}`, task: 'file', on: msg('A1'), state: 'begin', attempt: 1 });
    expect(begin.seq).toBeLessThan(first.seq);
    // «маяк» is the lighthouse's alias: the book's entry is edited in this session, not duplicated.
    expect(saidFor('/memory list character')).toContain('  C17 Фрол (aka лодочник) — Старый лодочник Вельмара с седой косицей; сорок лет возит людей через гавань. [249]\n');
    expect(saidFor('/memory list', 2)).toContain('  C6  Серый маяк (aka маяк) — Каменная башня на краю мыса; на её крюке висел Латунный фонарь. [lib: lantern, edited] [featured] [252]\n');
  });

  test('b. a swipe takes the replaced answer’s entries off the path; /[ brings them back with no call', () => {
    expect(saidFor('/rewind 2')).toContain('rewound to your message 2');
    expect(saidFor('/r')).toContain('Рассказчик › Лодку держит у причала не старик, а широкоплечая женщина в мокром плаще.');
    // The swipe's path has A1′, not A1: the pass bound to A1 is off it, and so is Фрол.
    const swiped = saidFor('/memory list character', 2);
    expect(swiped.split('\n')[0]).toBe('Character entries on this path: 3 live · /memory show <ref> prints one');
    expect(swiped).not.toContain('Фрол');
    // A1′ is not accepted (nothing follows it): a swipe before acceptance costs no call.
    expect(saidFor('/memory wait', 2)).toBe('the background lane is idle: nothing to do\n');
    // Back to A1 and its branch: Фрол is back, from the row already there.
    expect(saidFor('/[')).toContain('[swipe 1/2');
    expect(saidFor('/memory list character', 3)).toBe(saidFor('/memory list character', 1));
    const forA1 = jobRows(afterChat).filter((j) => j.key === `file:${msg('A1')}`);
    // Two passes of A1 in all: the first, and the one after the edit (c); none for the swipe or /[.
    expect(forA1).toHaveLength(2);
    const head = afterChat.filter((e) => e.t === 'head').map((e) => e.seq);
    expect(head).toHaveLength(2);
    expect(forA1[1]!.seq).toBeGreaterThan(head[1]!);
  });

  test('c. an edit of the filed answer makes its pass stale; the lane files it again from the new text', () => {
    expect(saidFor('/e 3')).toContain('edited message 3\n');
    expect(laneLines(withWait('/e 3'))).toEqual(['⋯ memory: filing #3 → +2: C17 "Фрол", C6 "Серый маяк"']);
    const edit = afterChat.find((e) => e.t === 'edit')!;
    expect(edit).toMatchObject({ target: msg('A1') });
    expect(JSON.stringify(edit)).toContain(EDITED.slice(0, 40));
    const passes = memRows(afterChat).filter((r) => r.key === `file:${msg('A1')}`);
    expect(passes).toHaveLength(2);
    expect(passes[1]!.seq).toBeGreaterThan(edit.seq);
    const show = saidFor('/memory show Фрол').split('\n');
    expect(show[0]).toBe('C17 Фрол · character · character:фрол');
    expect(show[2]).toBe(`  origin: this session, filed by the filing agent from #3 (file:${msg('A1')}) at journal row ${passes[1]!.seq}`);
    expect(show).toContain('  Лодочник Вельмара с седой косицей; двадцать лет был смотрителем Серого маяка, пока ключи не приняла Ульяна.');
    expect(show).toContain('  - Nature: ally; Notes: передал ей ключи от маяка; Status: past; With: Ульяна');
  });

  test('d. /memory undo takes the pass back and the lane leaves it; /memory refile files it again', () => {
    const key = `file:${msg('A2')}`;
    expect(laneLines(withWait(U3!))).toEqual(['⋯ memory: filing #5 → +2: C17 "Фрол", C18 "Лодка с солью"']);
    expect(saidFor('/memory undo 5')).toBe(
      'undone: filing #5; what it wrote leaves the Compendium from the next turn (/memory refile #5 file runs it again)\n⋯ memory: undo → −2: C17 "Фрол", event "Лодка с солью"\n',
    );
    expect(saidFor('/memory list event')).toBe(
      'Event entries on this path: 1 live · /memory show <ref> prints one\nEvents (1)\n  C10 Погасший маяк — Серый маяк погас без ветра и дождя; утром фонаря на крюке не было. [lib: lantern] [365]\n',
    );
    // An undone pass counts as done: the lane does not file A2 again by itself.
    expect(said[indexOf('/memory list event') + 1]).toEqual({ line: '/memory wait', out: 'the background lane is idle: nothing to do\n' });
    expect(saidFor('/memory refile 5')).toBe('filing #5 queued again (/memory wait waits for it)\n');
    expect(laneLines(withWait('/memory refile 5'))).toEqual(['⋯ memory: filing #5 → +2: C17 "Фрол", C18 "Лодка с солью"']);
    // The journal: the pass, the person's revert (no key of its own), the pass again.
    const forA2 = memRows(afterChat).filter((r) => r.key === key || r.ops.some((op) => op.op === 'revert' && op.key === key));
    expect(forA2.map((r) => [r.by, r.key, r.ops.map((op) => op.op).join(',')])).toEqual([
      ['filing', key, 'file,file'],
      ['user', null, 'revert'],
      ['filing', key, 'file,file'],
    ]);
    expect(forA2[1]).toMatchObject({ on: msg('A2'), ops: [{ op: 'revert', key }] });
    expect(jobRows(afterChat).filter((j) => j.key === key).map((j) => [j.state, j.attempt])).toEqual([
      ['begin', 1],
      ['begin', 1],
    ]);
  });

  test('e. lenient reading: a ```json fence, a memory with no change dropped, an items envelope with Russian types, camelCase and a bad enum', () => {
    // F2 came in a ```json fence: Фрол's memory and a new event.
    expect(callText(7)).toStartWith('```json\n');
    expect(dataOf('Фрол')).toMatchObject({
      memories: [{ what_happened: 'В ночь кражи видел у Старой пристани чужую лодку с солью; один мешок звенел', changed_belief: 'фонарь увезли люди, а не туман' }],
    });
    expect(rows.find((r) => r.name === 'Лодка с солью')).toMatchObject({ type: 'event', origin: 'session' });
    // F4: «Смотрительница» is Ульяна's alias (an overlay); her second memory has no changed_* (dropped).
    expect(laneLines(withWait(U5!))).toEqual(['⋯ memory: filing #9 → +1: C3 "Ульяна" · 1 skipped']);
    const f4 = rowsOf(`file:${msg('A4')}`)[0]!;
    expect(f4.skipped).toEqual([{ path: 'filings[0].entry.memories[1]', why: expect.stringMatching(/^memory_rule: /) }]);
    expect(rows.find((r) => r.name === 'Ульяна')).toMatchObject({ ref: 'C3', overlay: true });
    expect((dataOf('Ульяна').memories as unknown[]).length).toBe(1);
    expect(dataOf('Ульяна')).toMatchObject({ current_state: { status: 'alive', location: 'Серый маяк' } });
    // F5: {"items": [...]}, flat items, «персонаж»/«место», parentLocation; «злодей» is no role (skipped).
    expect(callText(15)).toStartWith('{"items":[{"type":"персонаж","name":"Хромой стражник"');
    expect(laneLines(withWait(U6!))).toEqual(['⋯ memory: filing #11 → +2: C22 "Хромой стражник", C23 "Подвалы Соляного суда" · 1 skipped']);
    const f5 = rowsOf(`file:${msg('A5')}`)[0]!;
    expect(f5.skipped).toEqual([{ path: 'filings[0].entry.role', why: expect.stringMatching(/^bad_enum: role must be one of /) }]);
    expect(rows.find((r) => r.name === 'Хромой стражник')).toMatchObject({ type: 'character' });
    expect(dataOf('Хромой стражник').role).toBeUndefined();
    expect(dataOf('Хромой стражник')).toMatchObject({ relationships: [{ with: 'Селина Бранд', nature: 'ally' }] });
    expect(rows.find((r) => r.name === 'Подвалы Соляного суда')).toMatchObject({ type: 'location' });
    expect(dataOf('Подвалы Соляного суда')).toMatchObject({ parent_location: 'Вельмар' });
    // F6: nothing to file still closes the key (a row with no ops).
    expect(rowsOf(`file:${msg('A6')}`)).toMatchObject([{ by: 'filing', ops: [] }]);
  });

  test('f. the historian: after three player turns a summary and an [Arc] overview; three turns later again, the arc rewritten', () => {
    const h1 = historianAnswer(11);
    const h2 = historianAnswer(18);
    expect(laneLines(withWait(U4!))).toEqual([
      '⋯ memory: filing #7 → +2: C19 "Мира", C7 "Латунный фонарь"',
      '⋯ memory: historian #1–#7 → +2: C20 "Переправа к маяку", C21 [Arc] "Украденный свет"',
    ]);
    expect(laneLines(withWait(U7!))).toEqual([
      '⋯ memory: filing #13 → nothing to file',
      '⋯ memory: historian #8–#13 → +2: C24 "Ульяна в фонарной башне", C21 [Arc] "Украденный свет"',
    ]);
    // The first window starts at the greeting; the second at U4 (its overlap is read, not keyed).
    const [first, second] = memRows(entries).filter((r) => r.by === 'historian');
    expect(first).toMatchObject({ key: `hist:${msg('G')}-${msg('A3')}`, on: msg('A3'), range: [msg('G'), msg('A3')] });
    expect(second).toMatchObject({ key: `hist:${msg('U4')}-${msg('A6')}`, on: msg('A6'), range: [msg('U4'), msg('A6')] });
    expect(first!.ops.map((op) => op.op)).toEqual(['file', 'arc']);
    // The book's plot «Украденный свет» was reused: no plot was created.
    expect(rows.filter((r) => r.type === 'plot').map((r) => r.ref)).toEqual(['C11']);
    const list = saidFor('/memory list', 2);
    expect(list).toContain('  C20 Переправа к маяку — Фрол везёт Яна к тёмному маяку. [487]\n');
    expect(list).toContain('Arcs (2)\n  C16 [Arc] Украденный свет — Маяк погас, фонарь пропал вместе со смотрительницей. Гильди… [lib: lantern] [148]\n  C21 [Arc] Украденный свет');
    // The arc now holds H2's overview; the summaries are H1's and H2's.
    const arc = rows.find((r) => r.ref === 'C21')!;
    expect(arc).toMatchObject({ type: 'arc', key: 'arc:украденный свет', origin: 'session', size: [...h2.arcs[0]!.overview].length });
    // The book's own summary «Фонарь погас» (its foreign turn_range) did not move the first window.
    expect(rows.filter((r) => r.type === 'summary').map((r) => r.name)).toEqual(['Фонарь погас', h1.filings[0]!.entry.title, h2.filings[0]!.entry.title]);
  });

  test('g. the {{recap}} slot once trimming starts: the arc (H1’s revision) and the summary at the cut; the same slot after a swipe', () => {
    const h1 = historianAnswer(11);
    const h1Row = memRows(entries).find((r) => r.by === 'historian')!;
    const trace = saidFor('/trace').split('\n');
    // U7's request: U1…A4 trimmed (a 4 096 window), the slot built after H1 and before H2.
    expect(trace).toContain(`  trimmed: ${msg('U1')} … ${msg('A4')} · prefill: none`);
    const recapLine = `  recap: 1 arc: C21 "Украденный свет" rev ${h1Row.seq} · 1 summary: C20 "Переправа к маяку" · boundary ${msg('U5')}`;
    expect(trace).toContain(recapLine);
    // /preview (a swipe of A7, built after H2 rewrote the arc): the slot right after the greeting holds
    // the arc as H1 wrote it (the boundary has not moved) and H1's summary; then U5, the first message kept.
    const msgs = previewMessages(saidFor('/preview'));
    const at = msgs.findIndex((m) => m.src === 'recap');
    expect(msgs[at - 1]).toMatchObject({ role: 'assistant', src: 'history' });
    expect(msgs[at - 1]!.text).toStartWith('Ночь опускается на портовый город.');
    expect(msgs[at]).toMatchObject({ role: 'system', src: 'recap' });
    expect(msgs[at]!.text).toBe(`[Arc] Украденный свет\n${h1.arcs[0]!.overview}\n\n[Summary: Переправа к маяку]\n${h1.filings[0]!.entry.summary}`);
    expect(msgs[at + 1]).toMatchObject({ role: 'user', src: 'history', text: U5 });
    expect(msgs.filter((m) => m.src === 'recap')).toHaveLength(1);
    // The swipe A7′ was sent with the same slot: same ids, same arc revision, same boundary.
    expect(saidFor('/r', 2)).toContain('Рассказчик › Арсений молча выслушивает Ульяну');
    const again = saidFor('/trace', 2).split('\n');
    expect(again).toContain(recapLine);
    expect(again).toContain(`  trimmed: ${msg('U1')} … ${msg('A4')} · prefill: none`);
    expect(memRows(entries).filter((r) => r.by === 'historian')[1]!.seq).toBeGreaterThan(h1Row.seq);
  });

  test('h. kill -9 during a filing call: reopened, the job runs once more; exactly one mem row for its key; a third open finds nothing', () => {
    const key = `file:${msg('A7')}`;
    const killed = steps[3]!.r;
    expect(killed.stdout).toContain('you        › — Я пойду с вами. Что мне нести?\nРассказчик › Ночь в Фонарном ряду проходит без сна.');
    expect(killed.stdout).toContain('you        › /memory wait\n');
    expect(killed.stdout).not.toContain('⋯ memory:');
    // Process 3: the begin row with no row after it is queued again at open (the same attempt: a kill
    // is no failure), and runs with the next scripted answer.
    const recover = segments(steps[4]!.r.stdout, RECOVER);
    expect(recover.map((s) => s.line)).toEqual(RECOVER);
    expect(laneLines(recover[0]!.out)).toEqual(['⋯ memory: filing #15 → +1: C1 "Арсений Кеттер"']);
    const show = recover[1]!.out;
    expect(show).toContain(`  last changed at journal row ${rowsOf(key)[0]!.seq} by the filing agent from #15 (${key})\n`);
    expect(show).toContain('  Condition: собирает старших фонарщиков, чтобы идти в суд с огнём\n');
    expect(show).toContain('  - Changed behavior: ведёт Гильдию в суд открыто, с зажжёнными лампами; What happened: Узнал, что Латунный фонарь держат в подвалах Соляного суда\n');
    // Process 4: nothing left, nothing runs.
    const again = segments(steps[5]!.r.stdout, AGAIN);
    expect(again.map((s) => s.out).slice(0, 2)).toEqual([
      'the background lane is idle: nothing to do\n',
      "the Compendium's background lane is idle: nothing queued, nothing parked\n",
    ]);
    // The journal: two begins of the key (the killed one, the rerun), one mem row, no failure; after
    // process 1 only this key's rows (and the new messages) were written.
    expect(jobRows(entries).filter((j) => j.key === key).map((j) => [j.state, j.attempt])).toEqual([
      ['begin', 1],
      ['begin', 1],
    ]);
    expect(rowsOf(key)).toHaveLength(1);
    expect(rowsOf(key)[0]).toMatchObject({ on: msg('A7'), by: 'filing', range: [msg('U7'), msg('A7')] });
    const later = entries.slice(afterChat.length);
    expect(later.filter((e) => e.t === 'job' || e.t === 'mem').every((e) => (e as JobEntry | MemEntry).key === key)).toBe(true);
    expect(jobRows(entries).some((j) => j.state === 'failed')).toBe(false);
    // Every key the lane wrote holds exactly one row after its newest begin (no duplicate pass).
    for (const k of new Set(jobRows(entries).map((j) => j.key))) {
      const lastBegin = jobRows(entries).filter((j) => j.key === k).at(-1)!.seq;
      expect(rowsOf(k).filter((r) => r.seq > lastBegin)).toHaveLength(1);
    }
  });

  test('--keep-requests: 19 requests, one per scripted call (9 narrator, 8 filing, 2 historian); the historian reads numbered positions', () => {
    const dir = join(home, 'sessions', `${id}.requests`);
    const kept = readdirSync(dir).map((f) => ({ f, body: JSON.parse(readFileSync(join(dir, f), 'utf8')) as { agent?: string } }));
    expect(kept).toHaveLength(CALLS.length);
    const count = (agent: string): number => kept.filter((k) => k.body.agent === agent).length;
    expect([count('narrator'), count('filing'), count('historian')]).toEqual([9, 8, 2]);
    // Lane calls are kept under their job: <job>_<agent>_<n>.json.
    for (const { f, body } of kept) {
      if (body.agent === 'narrator') expect(f).toMatch(/^t_[0-9a-f]{8}_narrator_0\.json$/);
      else expect(f).toMatch(new RegExp(`^j_[0-9a-f]{8}_${body.agent}_0\\.json$`));
    }
    // The historian reads numbered path positions (D-176): the first window from the greeting.
    const hist = kept.filter((k) => k.body.agent === 'historian').map((k) => JSON.stringify(k.body));
    expect(hist.some((h) => h.includes('[1] assistant: Ночь опускается на портовый город.'))).toBe(true);
    // The second window: an overlap read back, then the new part from U4 (#8).
    const second = hist.find((h) => h.includes('Messages 8 to 13 are NEW'));
    expect(second).toContain('Messages 4 to 7 are OVERLAP from the previous window (already summarized;');
  });

  test('the transcript (docs/M5B-DEMO.md)', () => {
    const hide = (s: string): string => s.replaceAll(home, '<home>').replaceAll(`${ROOT}/`, '');
    const input: Record<string, string> = { 'chat.jsonl': 'script.txt', 'crash.jsonl': 'crash.txt', 'recover.jsonl': 'recover.txt', 'again.jsonl': 'again.txt' };
    const out: string[] = [`$ cat <home>/config.toml\n${CONFIG.trimEnd()}`];
    for (const s of steps) {
      const a = s.args.map((x) => (x.startsWith('script:') ? `script:${relative(ROOT, x.slice(7))}` : hide(x)));
      const provider = s.args.find((x) => x.startsWith('script:'));
      const stdin = provider ? ` < test/demo-m5b/${input[provider.split('/').at(-1)!]}` : '';
      const env = provider?.endsWith('chat.jsonl') ? 'EDITOR= VISUAL= ' : '';
      out.push(`$ ${env}rp-core --home <home> ${a.join(' ')}${stdin}${s.r.killed ? '    # kill -9 once the job row is written' : ''}`);
      out.push(hide(s.r.stdout + s.r.stderr).trimEnd());
    }
    console.log(`\n${out.join('\n')}\n\n(${ms.toFixed(0)} ms)\n`);
    expect(out.join('\n')).not.toContain(home);
  });
});
