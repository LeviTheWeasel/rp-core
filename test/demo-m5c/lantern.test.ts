// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M5c demo end to end, deterministic (ARCHITECTURE.md §15 M5c "Демо"; docs/M5C-DEMO.md): recall
// through the real CLI (`bun src/cli/main.ts`, spawned as a person runs it) in one isolated home, four
// chats on scripted models (chat1…chat4.jsonl: every call line is tagged with the agent it answers, so a
// Director and a recall asking at once each take their own line) and the lines a person types
// (script1…script4.txt). RP_CORE_RECALL is unset for the children (the test preload sets it to lexical),
// so the session's config decides the mode; RP_CORE_LANE=auto, and every line that gives the lane work is
// followed by `/memory wait`. The world is M5a's and M5b's (test/demo-m5a, the RoleCall book `lantern`);
// config.toml: recall mode lexical (the story is built without recall), grace_sec 1, timeout_sec 4,
// filing off, historian.interval 2, idle_delay_sec 0; the scripted window is 4 096 tokens (lite).
//   1. the story to U7 without recall: three historian passes; U6 and U7 trim #2–#9, and the {{recap}}
//      slot holds only the [Arc] (history_crowded once);
//   2. a remote origin (capacity 2): /memory mode auto = sync; U8 names no entry, and recall, run beside
//      the Director, picks the summary «Переправа к маяку» (trimmed, out of the slot) by meaning; a swipe
//      reuses the record with no call; a recall slower than timeout_sec falls back to lexical;
//   3. a local origin: auto = prefetch; a prefetch still running after grace_sec is a miss (lexical);
//      one ready in time is adopted with no recall call in the turn; the lane prefetches before the
//      historian (and not again after it: the basis does not hold the Compendium's revision);
//   4. reopened on a remote origin: the swipe and the continue reuse the stored record (no recall line).
// Each claim is its own test over the one recorded run; the last prints the transcript.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PREFETCH_LINE } from '../../src/agents/compendium/recall.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { MemoryRow } from '../../src/engine/api.ts';
import type { EditEntry, Entry, MsgEntry, PrepEntry, RecallRecord } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { MAIN, ROOT, type RunResult } from '../cli/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

const DIR = import.meta.dir;
const M5A = join(ROOT, 'test', 'demo-m5a');
const LANTERN = join(ROOT, 'test', 'fixtures', 'ru', 'lantern', 'lantern.compendium.json');
const CONFIG = [
  '[compendium]',
  'idle_delay_sec = 0',
  '',
  '[compendium.recall]',
  'mode = "lexical"',
  'grace_sec = 1',
  'timeout_sec = 4',
  '',
  '[compendium.filing]',
  'enabled = false',
  '',
  '[compendium.historian]',
  'interval = 2',
  '',
].join('\n');
/** The lane in auto mode (a person's default); no colour. RP_CORE_RECALL is removed (cli()). */
const ENV = { RP_CORE_LANE: 'auto', NO_COLOR: '1' };

const linesOf = (file: string): string[] => readFileSync(join(DIR, file), 'utf8').split('\n').filter((l) => l.trim() !== '');
/** What the person types in the four chats. */
const TYPED = [linesOf('script1.txt'), linesOf('script2.txt'), linesOf('script3.txt'), linesOf('script4.txt')] as const;
const messages = (lines: readonly string[]): string[] => lines.filter((l) => l.startsWith('— '));
const [, , U3, , U5, , U7] = messages(TYPED[0]);
const [U8, U9] = messages(TYPED[1]);
const [U10, U11] = messages(TYPED[2]);

/** A scripted call line: its agent and its steps. */
interface Call {
  agent: string;
  steps: { text?: string; delay?: number; usage?: { inputTotal: number; outputTotal: number } }[];
}
const callsOf = (file: string): Call[] =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{"agent"'))
    .map((l) => JSON.parse(l) as Call);
const CALLS = ['chat1.jsonl', 'chat2.jsonl', 'chat3.jsonl', 'chat4.jsonl'].map(callsOf);
const textOf = (c: Call): string => c.steps.find((s) => s.text !== undefined)!.text!;

interface Step {
  args: string[];
  r: RunResult;
}

let home: string;
let id: string;
const steps: Step[] = [];
/** Each chat's output per typed line, in the order typed. */
const said: { line: string; out: string }[][] = [];
let ms: number;
/** The path after all four chats: [G, U1, A1, …, U11, A11′]. */
let path: string[];
let rows: MemoryRow[];
let entries: Entry[];
/** The kept requests' file names after each chat. */
const keptAfter: string[][] = [];

async function cli(argv: string[], stdin: string | null): Promise<RunResult> {
  const { RP_CORE_RECALL: _seam, ...inherited } = process.env;
  const p = Bun.spawn([process.execPath, MAIN, '--home', home, ...argv], {
    cwd: ROOT,
    stdin: stdin === null ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...inherited, ...ENV },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const r = { code, stdout, stderr };
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

const requestsDir = (): string => join(home, 'sessions', `${id}.requests`);
const kept = (): string[] => readdirSync(requestsDir()).sort();
const request = (file: string): { agent: string; callKey: string; prefill?: string; messages: { role: string; blocks: { text?: string }[] }[] } =>
  JSON.parse(readFileSync(join(requestsDir(), file), 'utf8'));
/** A kept request's messages as one text per message. */
const texts = (file: string): string[] => request(file).messages.map((m) => m.blocks.map((b) => b.text ?? '').join(''));

beforeAll(async () => {
  const t0 = performance.now();
  home = tmpHome('rp-core-demo-m5c-');
  // Setup: the RoleCall book into the library, config.toml, a new session reading the book.
  await cli(['import', LANTERN], null);
  writeFileSync(join(home, 'config.toml'), CONFIG);
  id = (await cli(['new', '--card', join(M5A, 'card.json'), '--persona', join(M5A, 'persona.json'), '--lore', 'lantern', '--no-chat'], null)).stdout.trim();
  // The four chats, every request kept.
  for (let i = 0; i < 4; i++) {
    const r = await cli(['chat', id, '--keep-requests', '--provider', `script:${join(DIR, `chat${i + 1}.jsonl`)}`], `${TYPED[i]!.join('\n')}\n`);
    said.push(segments(r.stdout, TYPED[i]!));
    keptAfter.push(kept());
  }
  ms = performance.now() - t0;

  // The session as the engine folds it, after the CLIs exited (the preload's lane: manual).
  entries = readSessionFile(home, id).entries;
  const engine = await Engine.open({ home, connections: {}, clock: fakeClock(), random: fakeRandom(5), timeZone: 'UTC' });
  try {
    const s = engine.session(id);
    path = s.view().path.map((m) => m.id);
    rows = s.memoryList();
    await s.close();
  } finally {
    await engine.close();
  }
}, 60_000);

/** Output of chat `p` (1…4) for the n-th typing of `line`. */
function saidFor(p: number, line: string, n = 1): string {
  let seen = 0;
  const seg = said[p - 1]!.find((s) => s.line === line && ++seen === n);
  if (seg === undefined) throw new Error(`chat ${p}: no output for ${JSON.stringify(line)} #${n}`);
  return seg.out;
}

/**
 * What a line that gives the lane work and the `/memory wait` right after it printed, together: a lane
 * line that comes before the REPL reads the wait prints under the line itself (the scripted lane answers
 * take 200 ms, so it does not, but the claims do not hang on the timing). The wait ends with the idle line.
 */
function withWait(p: number, line: string): string {
  const segs = said[p - 1]!;
  const i = segs.findIndex((s) => s.line === line);
  const wait = segs[i + 1]!;
  expect(wait.line).toBe('/memory wait');
  expect(wait.out).toMatch(/^the background lane is idle.*\n$/m);
  return segs[i]!.out + wait.out;
}

/** The lane's lines in an output (`⋯ memory:` and the prefetch's `⋯ recall:`, unindented). */
const laneLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('⋯ '));
/** A turn's agent lines (`  ⋯ recall: …`, `  ⋯ director: …`). */
const turnLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('  ⋯ '));
/** A /trace line starting with `  <name>: `. */
const traceLine = (out: string, name: string): string => out.split('\n').find((l) => l.startsWith(`  ${name}: `)) ?? '';

const msgRows = (): MsgEntry[] => entries.filter((e): e is MsgEntry => e.t === 'msg');
const msgRow = (msgId: string): MsgEntry => msgRows().find((m) => m.id === msgId)!;
const prepOf = (turn: string): PrepEntry => entries.find((e): e is PrepEntry => e.t === 'prep' && e.turn === turn)!;
const recallOf = (msgId: string): RecallRecord => msgRow(msgId).recall as RecallRecord;

/** Path ids by name: G, U1, A1, …, U8, A8 (the swipe A8′), …, U11, A11 (the swipe A11′). */
const NAMES = ['G', ...Array.from({ length: 11 }, (_, i) => [`U${i + 1}`, `A${i + 1}`]).flat()];
const msg = (name: string): string => path[NAMES.indexOf(name)]!;
/** The first version of an answer the swipe replaced: the other answer to the same message. */
const replaced = (answer: string): string => msgRows().find((m) => m.role === 'assistant' && m.parent === msgRow(msg(answer)).parent && m.id !== msg(answer))!.id;
/** A Compendium entry's key and ref by name. */
const entry = (name: string): MemoryRow => rows.find((r) => r.name === name)!;

describe('the M5c demo (lantern, scripted models, the real CLI: recall sync, reused, timed out, prefetched, missed)', () => {
  test('every command ran: exit 0, nothing on stderr, every typed line echoed; under 20 s', () => {
    expect(steps.map((s) => s.r.code)).toEqual([0, 0, 0, 0, 0, 0]);
    for (const s of steps.slice(2)) expect(s.r.stderr).toBe('');
    expect(said.map((segs) => segs.map((s) => s.line))).toEqual(TYPED.map((t) => [...t]));
    expect(id).toMatch(/^s_[0-9a-f]{8}$/);
    expect(path).toHaveLength(23);
    expect(ms).toBeLessThan(20_000);
  });

  test('1. the story without recall: three historian passes; U6 and U7 trim #2–#9; the {{recap}} slot holds only the [Arc]', () => {
    expect(laneLines(withWait(1, U3!))).toEqual(['⋯ memory: historian #1–#5 → +2: C17 "Переправа к маяку", C18 [Arc] "Украденный свет"']);
    expect(laneLines(withWait(1, U5!))).toEqual(['⋯ memory: historian #6–#9 → +2: C19 "Стекло и смотрительница", C18 [Arc] "Украденный свет"']);
    expect(laneLines(withWait(1, U7!))).toEqual(['⋯ memory: historian #10–#13 → +2: C20 "Хромой стражник", C18 [Arc] "Украденный свет"']);
    // The summary recall finds later: H1's, over #1–#5, filed from A2.
    expect(entry('Переправа к маяку')).toMatchObject({ ref: 'C17', type: 'summary', key: `summary:${msg('A2')}.0` });
    // A6's and A7's requests: #2–#9 trimmed; the slot (lite: ≤ 409 tokens, what the history leaves) has room for the arc only.
    for (const a of ['A6', 'A7']) {
      const trace = msgRow(msg(a)).trace!;
      expect(trace.trimmed).toEqual({ from: msg('U1'), to: msg('A4') });
      expect(trace.recap).toMatchObject({ ids: [], arcs: [{ key: 'arc:украденный свет' }], boundary: msg('U5') });
      expect(trace.compendium?.source).toBe('lexical');
    }
    const trace = saidFor(1, '/trace');
    expect(traceLine(trace, 'trimmed')).toBe(`  trimmed: ${msg('U1')} … ${msg('A4')} · prefill: none`);
    expect(traceLine(trace, 'recall')).toBe('  recall: lexical (no recall call; the selector picked alone)');
    expect(traceLine(trace, 'recap')).toMatch(/^ {2}recap: 1 arc: C18 "Украденный свет" rev \d+ · boundary [0-9a-f]{8}$/);
    // D-205: the history crowded out, told once in the chat (at U6).
    const crowded = steps[2]!.r.stdout.split('\n').filter((l) => l.includes('(history_crowded)'));
    expect(crowded).toHaveLength(1);
    expect(saidFor(1, messages(TYPED[0])[5]!)).toContain('! Only 3 of the 11 earlier messages fit in the request');
    // No recall request in the story: 7 narrator, 3 historian.
    expect(keptAfter[0]!.filter((f) => f.includes('_recall_'))).toEqual([]);
    expect(keptAfter[0]).toHaveLength(10);
  });

  test('2a. /memory mode auto on a remote origin is sync; /model: recall follows the recorder; /memory profile: lite on a 4 096 window', () => {
    expect(saidFor(2, '/memory mode auto')).toBe(
      'recall mode: auto (set for this session, from the next reply)\n' +
        "  here: sync (the recall model's server is not local): recall (script:default) picks the entries the narrator needs beside the Director, before each reply\n",
    );
    expect(saidFor(2, '/model')).toBe('  narrator script:default\n  director narrator (follows)\n  recorder narrator (follows)\n  recall   recorder (follows)\n');
    expect(saidFor(2, '/memory profile')).toBe(
      [
        'Compendium profiles (compendium.profile auto: lite below a 24576-token window, full from it):',
        "  block     lite: the narrator's window 4096 < 24576 · script:default",
        "  recall    lite: the recall model's window 4096 < 24576 · script:default (follows the recorder, which follows the narrator) · up to 4 picks, reading the last 6 messages",
        "  filing    lite: the recorder's window 4096 < 24576 · script:default (follows the narrator) · not running: compendium.filing.enabled is false",
        "  historian lite: the recorder's window 4096 < 24576 · script:default (follows the narrator)",
        '',
      ].join('\n'),
    );
  });

  test('2b. the index of U8’s recall: the trimmed summaries, not the one still in the history; the answer’s handles are its lines', () => {
    const turn = msgRow(replaced('A8')).turn!;
    const file = `${turn}_recall_0.json`;
    expect(keptAfter[1]).toContain(file);
    expect(request(file)).toMatchObject({ agent: 'recall', callKey: `${turn}:recall:0` });
    const [system, user] = texts(file);
    expect(system).toStartWith('You pick the knowledge entries the narrator needs for its next reply.');
    const index = user!.slice(0, user!.indexOf('## Recent Conversation'));
    // H1 (#1–#5) and H2 (#6–#9) were trimmed at A7's request and are not in its slot: candidates. H3
    // (#10–#13, still sent) is hidden by freshness; the arcs are no candidates.
    expect(index).toContain('[e12] Переправа к маяку - Фрол везёт Яна к тёмному маяку.\n');
    expect(index).toContain('[e11] Стекло и смотрительница - Стекло фонаря цело, Ульяна нашлась.\n');
    expect(index).toContain('[e6] Фонарный ряд - Квартал Гильдии фонарщиков');
    expect(index).not.toContain('Хромой стражник');
    expect(index.match(/^\[e\d+\] /gm)).toHaveLength(17);
    // R1 names e12 and e6 (in a ```json fence, e12 twice, and an e99 the index does not have).
    expect(textOf(CALLS[1]!.find((c) => c.agent === 'recall')!)).toBe('```json\n{"entry_ids":["e12","e6","e12","e99"]}\n```');
    // The sync request reads the conversation up to U8 and has no prefetch line.
    expect(user).toContain(`[user]: ${U8}\n`);
    expect(user).not.toContain(PREFETCH_LINE);
  });

  test('2c. by meaning: U8 names no entry; recall picks «Переправа к маяку» (model), the narrator gets its brief and uses the salt boat', () => {
    const a8 = replaced('A8');
    // The selector alone (/preview of a swipe: previews stay lexical) does not pick it, nor «Фонарный ряд».
    const preview = saidFor(2, '/preview');
    expect(preview).toContain('[Lore: Арсений Кеттер]');
    expect(preview).not.toContain('[Lore: Переправа к маяку]');
    expect(preview).not.toContain('[Lore: Фонарный ряд]');
    // The turn: recall beside the Director, two picks, tier 1 first in the block.
    expect(turnLines(saidFor(2, U8!))).toEqual(['  ⋯ director: planned — chapter 1', '  ⋯ recall: recalled (2)']);
    const trace = saidFor(2, '/trace');
    expect(traceLine(trace, 'recall')).toMatch(/^ {2}recall: sync · 2 picked: C17 "Переправа к маяку", C5 "Фонарный ряд" · 1 call \d+\.\ds$/);
    expect(traceLine(trace, 'compendium')).toStartWith('  compendium: lite · picked 8: C17 "Переправа к маяку" (model), C5 "Фонарный ряд" (model), C1 "Арсений Кеттер" (window)');
    const picked = msgRow(a8).trace!.compendium!;
    expect(picked.source).toBe('sync');
    expect(picked.picks.slice(0, 2)).toEqual([
      { ref: 'C17', key: entry('Переправа к маяку').key, via: 'model' },
      { ref: 'C5', key: entry('Фонарный ряд').key, via: 'model' },
    ]);
    const narrator = `${msgRow(a8).turn}_narrator_0.json`;
    expect(keptAfter[1]).toContain(narrator);
    const block = texts(narrator).find((t) => t.startsWith('[Retrieved World Knowledge]'))!;
    expect(block).toContain('[Lore: Переправа к маяку]');
    expect(block).toContain('[Lore: Фонарный ряд]');
    // The salt boat is in no message the narrator was sent (A2 is trimmed): only in the summary.
    const sent = texts(narrator).filter((t) => !t.startsWith('[Retrieved World Knowledge]')).join('\n');
    expect(sent).not.toContain('гружённая солью');
    expect(block).toContain('гружённая солью');
    // The record: picks as keys in recall's order, the fence read, the repeat and the unknown handle counted.
    expect(recallOf(a8)).toMatchObject({
      v: 1,
      status: 'recalled',
      source: 'sync',
      profile: 'lite',
      picks: [{ ref: entry('Переправа к маяку').key }, { ref: entry('Фонарный ряд').key }],
      unknown: 1,
      repeated: 1,
      trimmed: 0,
      calls: 1,
      model: 'script:default',
      transport: 'tagged',
      usage: { input: 1162, output: 31 },
    });
    expect(prepOf(msgRow(a8).turn!).recall).toEqual(recallOf(a8));
    expect(saidFor(2, '/memory recall')).toMatch(
      /^recall for #17: sync · recalled 2 · lite · script:default · tagged\n {2}picks, in recall's order:\n {4}1\. C17 "Переправа к маяку"\n {4}2\. C5 "Фонарный ряд"\n {2}read: 1 unknown, 1 repeated\n {2}1 call · \d+\.\ds · 1162 in \/ 31 out tokens\n$/,
    );
  });

  test('2d. beside the Director on a remote origin with two places: both calls took 1.2 s, the turn less than their sum', () => {
    const a8 = msgRow(replaced('A8'));
    const calls = a8.trace!.calls!;
    expect(calls.map((c) => c.agent)).toEqual(['director', 'recall', 'narrator']);
    const [dir, rec] = calls;
    expect(dir!.ms).toBeGreaterThanOrEqual(1200);
    expect(rec!.ms).toBeGreaterThanOrEqual(1200);
    // One after the other the turn would take ≥ 2.4 s; side by side it takes one delay and the rest.
    expect(a8.gen!.ms!).toBeLessThan(dir!.ms + rec!.ms);
    expect(traceLine(saidFor(2, '/trace'), 'calls')).toMatch(/^ {2}calls: director script:default \d+\.\ds, recall script:default \d+\.\ds, narrator script:default \d+\.\ds$/);
  });

  test('2e. a swipe reuses the record: no recall call, the same picks; the Director’s plan too', () => {
    expect(turnLines(saidFor(2, '/r'))).toEqual(['  ⋯ recall: reused (2)', '  ⋯ director: reused — chapter 1']);
    const a8b = msg('A8');
    expect(recallOf(a8b)).toMatchObject({ status: 'recalled', source: 'reused', reusedFrom: replaced('A8'), calls: 0, picks: recallOf(replaced('A8')).picks });
    expect(recallOf(a8b).usage).toBeUndefined();
    expect(msgRow(a8b).trace!.calls!.map((c) => c.agent)).toEqual(['narrator']);
    const trace = saidFor(2, '/trace', 2);
    expect(traceLine(trace, 'recall')).toBe(`  recall: reused from ${replaced('A8')} (another version of #17) · 2 picked: C17 "Переправа к маяку", C5 "Фонарный ряд" · 0 calls`);
    expect(traceLine(trace, 'calls')).toBe('  calls: narrator script:default 0.0s');
    // Process 2 kept one Director request and two recall requests (U8's and U9's): none for the swipe.
    const fresh = keptAfter[1]!.filter((f) => !keptAfter[0]!.includes(f));
    expect(fresh.filter((f) => f.includes('_director_'))).toHaveLength(1);
    expect(fresh.filter((f) => f.includes('_recall_'))).toHaveLength(2);
  });

  test('2f. a recall slower than timeout_sec (4 s): the turn falls back to lexical and the answer comes', () => {
    expect(CALLS[1]!.filter((c) => c.agent === 'recall')[1]!.steps[0]).toEqual({ delay: 10000 });
    expect(turnLines(saidFor(2, U9!))).toEqual(['  ⋯ recall: fallback [timeout]']);
    expect(saidFor(2, U9!)).toContain('Рассказчик › — У перевоза, в сторожке за Старой пристанью');
    const a9 = msgRow(msg('A9'));
    expect(recallOf(a9.id)).toMatchObject({ status: 'failed', source: 'lexical', code: 'timeout', calls: 1, picks: [] });
    expect(a9.trace!.calls!.map((c) => c.agent)).toEqual(['recall', 'narrator']);
    expect(a9.trace!.calls![0]!.ms).toBeGreaterThanOrEqual(4000);
    expect(a9.trace!.calls![0]!.ms).toBeLessThan(10_000);
    expect(a9.trace!.compendium?.picks?.some((p) => p.via === 'model')).toBe(false);
    expect(traceLine(saidFor(2, '/trace', 3), 'recall')).toMatch(/^ {2}recall: sync · failed \[timeout\] → lexical · 1 call 4\.\ds$/);
    expect(saidFor(2, '/memory recall', 2)).toMatch(
      /^recall for #19: sync · failed \[timeout\] · lite · script:default · tagged\n {2}recall did not answer within its deadline: the selector picked alone \(lexical\)\n {2}1 call · 4\.\ds\n$/,
    );
    // The historian's fourth pass after U9 (it accepted A8′).
    expect(laneLines(withWait(2, U9!))).toEqual(['⋯ memory: historian #14–#17 → +1: C21 "Свидетель той ночи"']);
  });

  test('3a. a local origin: auto = prefetch; the one still running after grace_sec is a miss, and the turn goes lexical', () => {
    expect(saidFor(3, '/memory mode')).toBe(
      "recall mode: auto (this session's compendium.recall.mode)\n" +
        "  here: prefetch (the recall model's server is local): recall (script:default) picks in the background after each answer, while you type; a reply waits for it at most 1 s, then the selector picks alone (lexical)\n",
    );
    // The prefetch after A9 began when the chat opened; its scripted answer takes 10 s.
    expect(saidFor(3, '/memory wait 1')).toBe('still working after 1 s: the recall prefetch after #19 runs (/memory status)\n');
    const out = saidFor(3, U10!);
    expect(out).toContain('(prefetch_missed)');
    expect(out).toContain('the turn waited 1 s for it');
    expect(turnLines(out)).toEqual(['  ⋯ recall: fallback [prefetch_missed]']);
    const a10 = msgRow(msg('A10'));
    expect(recallOf(a10.id)).toEqual({
      v: 1,
      status: 'skipped',
      source: 'lexical',
      profile: 'lite',
      picks: [],
      unknown: 0,
      repeated: 0,
      trimmed: 0,
      omitted: 0,
      byName: 0,
      salvaged: 0,
      calls: 0,
      code: 'prefetch_missed',
      basis: msg('A9'),
    });
    expect(a10.trace!.calls!.map((c) => c.agent)).toEqual(['narrator']);
    // It waited grace_sec, not the prefetch's 10 s nor its 4 s deadline.
    expect(a10.gen!.ms!).toBeGreaterThanOrEqual(1000);
    expect(a10.gen!.ms!).toBeLessThan(4000);
    expect(traceLine(saidFor(3, '/trace'), 'recall')).toBe('  recall: prefetch after #19 · missed [prefetch_missed] → lexical · 0 calls');
    expect(saidFor(3, '/memory recall')).toBe(
      'recall for #21: prefetch after #19 · missed [prefetch_missed] · lite\n  the prefetch was not ready when the reply started: the selector picked alone (lexical)\n  0 calls\n',
    );
    // Its request was sent (kept), then the miss superseded it.
    expect(keptAfter[2]).toContain(`p_${msg('A9')}_recall_0.json`);
  });

  test('3b. a prefetch ready in time is adopted: no recall call in the turn; its request carries the prefetch line and no player message', () => {
    expect(laneLines(withWait(3, U10!))).toEqual(['⋯ recall: prefetched after #21 → 2: C17 "Переправа к маяку", C6 "Серый маяк"']);
    expect(turnLines(saidFor(3, U11!))).toEqual(['  ⋯ recall: adopted (2)']);
    const a11 = replaced('A11');
    expect(recallOf(a11)).toMatchObject({
      status: 'recalled',
      source: 'prefetch',
      basis: msg('A10'),
      picks: [{ ref: entry('Переправа к маяку').key }, { ref: entry('Серый маяк').key }],
      byName: 2,
      calls: 1,
      usage: { input: 1204, output: 12 },
    });
    expect(prepOf(msgRow(a11).turn!).recall).toEqual(recallOf(a11));
    expect(msgRow(a11).trace!.calls!.map((c) => c.agent)).toEqual(['narrator']);
    expect(msgRow(a11).trace!.compendium?.source).toBe('prefetch');
    const trace = saidFor(3, '/trace', 2);
    expect(traceLine(trace, 'recall')).toMatch(/^ {2}recall: prefetch after #21 · 2 picked: C17 "Переправа к маяку", C6 "Серый маяк" · 0 calls in this turn \(the prefetch: 1 call \d+\.\ds\)$/);
    expect(traceLine(trace, 'calls')).toBe('  calls: narrator script:default 0.0s');
    expect(saidFor(3, '/memory recall', 2)).toMatch(/\n {2}read: 2 by name\n {2}1 call in the background, without the player's message · \d+\.\ds · 1204 in \/ 12 out tokens\n$/);
    // The prefetch's request: the A5 line last, the conversation up to A10 (U11 was not typed yet).
    const [, user] = texts(`p_${msg('A10')}_recall_0.json`);
    expect(user).toEndWith(`\n${PREFETCH_LINE}`);
    expect(user).not.toContain(U11!);
    // /usage counts the adopted prefetch's call and tokens through its record, and U9's timed-out call.
    expect(saidFor(3, '/usage')).toContain('  recall     2 calls · in 1204 tok · out 12 tok · cost unknown\n');
  });

  test('3c. the lane prefetches before the historian, and not again after it: the basis does not hold the Compendium revision (D-202 amended)', () => {
    expect(laneLines(withWait(3, U11!))).toEqual([
      '⋯ recall: prefetched after #23 → 2: C17 "Переправа к маяку", C1 "Арсений Кеттер"',
      '⋯ memory: historian #18–#21 → +1: C22 "Ночь у Старой пристани"',
    ]);
    // The historian's row moved the Compendium's rev, but the prefetch stays valid: one request after A11.
    const a11 = replaced('A11');
    expect(kept().filter((f) => f.startsWith(`p_${a11}_recall_`))).toEqual([`p_${a11}_recall_0.json`]);
    // P3 answered in prose (after the prefill's opening): the handles were salvaged — its index lists
    // «Переправа к маяку» as e8 and «Арсений Кеттер» as e7.
    expect(textOf(CALLS[2]!.filter((c) => c.agent === 'recall')[2]!)).toStartWith('Для следующего ответа нужны e8 и e7:');
    const [, p3] = texts(`p_${a11}_recall_0.json`);
    expect(p3).toContain('[e8] Переправа к маяку - ');
    expect(p3).toContain('[e7] Арсений Кеттер (aka Старшина, Арсений) - ');
    expect(saidFor(3, '/memory status')).toBe(
      'the Compendium\'s background lane is idle: nothing queued, nothing parked\n  recall: prefetched after #23, ready for the next reply: 2 picked: C17 "Переправа к маяку", C1 "Арсений Кеттер"\n',
    );
  });

  test('4. reopened on a remote origin: the swipe and the continue reuse the stored record (the script has no recall line)', () => {
    expect(CALLS[3]!.map((c) => c.agent)).toEqual(['narrator', 'narrator']);
    expect(turnLines(saidFor(4, '/r'))).toEqual(['  ⋯ recall: reused (2)']);
    const a11 = replaced('A11');
    const a11b = msg('A11');
    expect(recallOf(a11b)).toMatchObject({ status: 'recalled', source: 'reused', reusedFrom: a11, calls: 0, picks: recallOf(a11).picks, byName: 2 });
    expect(traceLine(saidFor(4, '/trace'), 'recall')).toBe(`  recall: reused from ${a11} (another version of #23) · 2 picked: C17 "Переправа к маяку", C6 "Серый маяк" · 0 calls`);
    expect(saidFor(4, '/memory recall')).toContain(`  0 calls: the picks of ${a11} (another version of #23)\n`);
    // The continue: an edit row of A11′ with the record of A11′ reused.
    expect(turnLines(saidFor(4, '/c'))).toEqual(['  ⋯ recall: reused (2)']);
    const cont = entries.find((e): e is EditEntry => e.t === 'edit' && e.reason === 'continue')!;
    expect(cont.target).toBe(a11b);
    expect(cont.recall).toMatchObject({ source: 'reused', reusedFrom: a11b, calls: 0, picks: recallOf(a11).picks });
    expect(traceLine(saidFor(4, '/trace', 2), 'recall')).toBe('  recall: reused from #23 · 2 picked: C17 "Переправа к маяку", C6 "Серый маяк" · 0 calls');
    // Process 4 sent two narrator requests and nothing else.
    const fresh = keptAfter[3]!.filter((f) => !keptAfter[2]!.includes(f));
    expect(fresh.map((f) => request(f).agent)).toEqual(['narrator', 'narrator']);
  });

  test('--keep-requests: one request per scripted call; every recall request is lite (200 tokens); the JSON agents send their opening as a prefill', () => {
    const all = kept();
    const count = (agent: string): number => all.filter((f) => request(f).agent === agent).length;
    expect([count('narrator'), count('director'), count('recall'), count('historian')]).toEqual([14, 1, 5, 5]);
    expect(all.length).toBe(CALLS.flat().length);
    for (const f of all.filter((x) => x.includes('_recall_'))) expect(request(f)).toMatchObject({ maxTokens: 200 });
    // D-208: the scripted model is on the tagged transport and takes a prefill, so recall and the
    // historian open their answers (the scripts' whole answers, a fence or a list are read alone).
    const prefills = (agent: string): unknown[] => [...new Set(all.filter((f) => request(f).agent === agent).map((f) => request(f).prefill))];
    expect([prefills('recall'), prefills('historian')]).toEqual([['{"entry_ids": ['], ['{"filings": [']]);
    // Prefetches are kept under p_<the answer>, sync recalls under t_<the turn>.
    expect(all.filter((f) => f.startsWith('p_'))).toEqual(
      [`p_${msg('A9')}_recall_0.json`, `p_${msg('A10')}_recall_0.json`, `p_${replaced('A11')}_recall_0.json`].sort(),
    );
  });

  test('the transcript (docs/M5C-DEMO.md)', () => {
    const hide = (s: string): string => s.replaceAll(home, '<home>').replaceAll(`${ROOT}/`, '');
    const out: string[] = [`$ cat <home>/config.toml\n${CONFIG.trimEnd()}`];
    for (const s of steps) {
      const a = s.args.map((x) => (x.startsWith('script:') ? `script:${relative(ROOT, x.slice(7))}` : hide(x)));
      const provider = s.args.find((x) => x.startsWith('script:'));
      const stdin = provider ? ` < test/demo-m5c/${provider.split('/').at(-1)!.replace('chat', 'script').replace('.jsonl', '.txt')}` : '';
      out.push(`$ rp-core --home <home> ${a.join(' ')}${stdin}`);
      out.push(hide(s.r.stdout + s.r.stderr).trimEnd());
    }
    console.log(`\n${out.join('\n')}\n\n(${ms.toFixed(0)} ms)\n`);
    expect(out.join('\n')).not.toContain(home);
  });
});
