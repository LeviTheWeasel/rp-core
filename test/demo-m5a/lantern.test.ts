// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M5a demo end to end, deterministic (ARCHITECTURE.md §15 M5a "Демо"; docs/M5A-DEMO.md): the real
// CLI (`bun src/cli/main.ts`, spawned as a person would run it) on an isolated home, a scripted model
// (chat.jsonl: the Director's plan, then two answers), the lines a person types (script.txt, piped into
// `rp-core chat`) and a scripted $EDITOR (editor.ts). The Russian `lantern` world
// (test/fixtures/ru/lantern) is RoleCall's export of 18 rows; the card is a narrator (card.json), the
// persona Ян (persona.json).
//   a. rp-core import lantern.compendium.json → the library book `lantern`;
//   b. a new session; /lore add lantern; /memory tree (Cast, Places, Narrative…); /memory list (C1…C16:
//      M5b seeds the book's [Arc] overview too, D-177);
//   c. /memory new character Мира in the editor; «…отдай это Мире…» with the Director on; /preview shows
//      [Retrieved World Knowledge] with her brief at depth 1, above the Director's directive (and, since
//      M5b, the book's [Arc] overview in the {{recap}} slot right after the greeting, D-177/D-178);
//   d. /memory edit of a library entry (Ульяна): the book file stays byte-identical, /memory show shows
//      the overlay;
//   e. a swipe and a rewind leave the human rows in place; a fork keeps the entry keys;
//   f. /memory export lantern2 --format compendium, then rp-core import of it: the same types, names,
//      aliases and data;
//   g. --keep-requests: the Director's request holds [COMPENDIUM CONTEXT] with Мира.
// Each step is its own test over the one recorded run; the last prints the transcript.
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import type { MemoryRow } from '../../src/engine/api.ts';
import { libraryDir } from '../../src/formats/library.ts';
import type { LoreBook } from '../../src/formats/native.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { ROOT, run, type RunResult } from '../cli/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { MIRA_FILE, ULYANA_STATE } from './editor.ts';

const LANTERN = join(ROOT, 'test', 'fixtures', 'ru', 'lantern', 'lantern.compendium.json');
const CARD = join(import.meta.dir, 'card.json');
const PERSONA = join(import.meta.dir, 'persona.json');
const SCRIPT = join(import.meta.dir, 'chat.jsonl');
const EDITOR = join(import.meta.dir, 'editor.ts');
const MIRA_DATA = JSON.parse(readFileSync(MIRA_FILE, 'utf8')) as Record<string, unknown>;
const ULYANA_KEY = 'lib:lantern:00000000-0000-4000-8000-000000000e03';

/** What the person types into `rp-core chat` (a piped script: each line waits for the answer before it). */
const LINES = readFileSync(join(import.meta.dir, 'script.txt'), 'utf8').split('\n').filter((l) => l.trim() !== '');

/** «…отдай это Мире…», the one line that is not a command: Мира in the dative (§15 writes «Миру»; every form stems to мир). */
const MESSAGE = LINES.find((l) => !l.startsWith('/'))!;

/** A path or a word as one shell word. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

interface Step {
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  r: RunResult;
}

let home: string;
let sessionId: string;
let forkId: string;
const steps: Step[] = [];
let bookBefore: Buffer;
let bookAfter: Buffer;
/** The chat's output per typed line, in the order typed. */
let said: { line: string; out: string }[];
let ms: number;

async function cli(args: string[], o: { env?: Record<string, string>; stdin?: string } = {}): Promise<RunResult> {
  const r = await run(['--home', home, ...args], { ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), ...(o.env ? { env: o.env } : {}) });
  steps.push({ args, ...o, r });
  return r;
}

/**
 * The chat's stdout cut at the echo of each typed line (`you › <line>`), in the order typed. Other
 * `you ›` lines (the head re-shown after /rewind and /fork) stay inside the segment they belong to.
 */
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

/** What the n-th typing of `line` printed (n from 1). */
function saidFor(line: string, n = 1): string {
  const hit = said.filter((s) => s.line === line)[n - 1];
  if (!hit) throw new Error(`no output for ${JSON.stringify(line)} #${n}`);
  return hit.out;
}

const lanternFile = (): string => join(libraryDir(home, 'lorebooks'), 'lantern.json');
const memRowsOf = (id: string): MemEntry[] => readSessionFile(home, id).entries.filter((e): e is MemEntry => e.t === 'mem');

/** Every message of a kept request as text, one string. */
function requestText(file: string): string {
  const body = JSON.parse(readFileSync(file, 'utf8')) as { messages: { blocks: { k: string; text?: string }[] }[] };
  return body.messages.map((m) => m.blocks.map((b) => (b.k === 'text' ? (b.text ?? '') : '')).join('')).join('\n\n');
}

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

/** The sessions' Compendium as the engine folds it (C<n>, keys, data), read after the CLI exited. */
async function compendiumOf(ids: string[]): Promise<Map<string, { rows: MemoryRow[]; data: Map<string, Record<string, unknown>> }>> {
  const engine = await Engine.open({ home, connections: {}, clock: fakeClock(), random: fakeRandom(5), timeZone: 'UTC' });
  const out = new Map<string, { rows: MemoryRow[]; data: Map<string, Record<string, unknown>> }>();
  try {
    for (const id of ids) {
      const s = engine.session(id);
      const rows = s.memoryList();
      out.set(id, { rows, data: new Map(rows.map((r) => [r.ref, s.memoryGet({ ref: r.ref }).entry.data as Record<string, unknown>])) });
      await s.close();
    }
  } finally {
    await engine.close();
  }
  return out;
}

beforeAll(async () => {
  const t0 = performance.now();
  home = tmpHome('rp-core-demo-m5a-');
  // a. RoleCall's export into the library.
  await cli(['import', LANTERN]);
  bookBefore = readFileSync(lanternFile());
  // b. A new session (a narrator card, the persona Ян), then the chat.
  sessionId = (await cli(['new', '--card', CARD, '--persona', PERSONA, '--no-chat'])).stdout.trim();
  const chat = await cli(['chat', sessionId, '--keep-requests', '--provider', `script:${SCRIPT}`], {
    stdin: `${LINES.join('\n')}\n`,
    env: { VISUAL: '', EDITOR: `${shq(process.execPath)} ${shq(EDITOR)}`, NO_COLOR: '1' },
  });
  said = segments(chat.stdout, LINES);
  bookAfter = readFileSync(lanternFile());
  forkId = /forked into (s_\w+)/.exec(chat.stdout)?.[1] ?? '';
  // f. The exported file back into the library.
  await cli(['import', join(home, 'exports', 'lantern2.compendium.json')]);
  ms = performance.now() - t0;
}, 30_000);

describe('the M5a demo (lantern, scripted model, the real CLI)', () => {
  test('every command ran: exit 0, nothing on the chat stderr, every typed line echoed, under 10 s', () => {
    expect(MESSAGE).toBe('— Отдай это Мире, — говорю я лодочнику. — Она ждёт у маяка.');
    expect(steps.map((s) => s.r.code)).toEqual([0, 0, 0, 0]);
    expect(steps[2]!.r.stderr).toBe('');
    expect(said.map((s) => s.line)).toEqual(LINES);
    expect(sessionId).toMatch(/^s_[0-9a-f]{8}$/);
    expect(ms).toBeLessThan(10_000);
  });

  test('a. rp-core import: RoleCall’s export lands as the library book "lantern" (18 entries, 16 typed, 1 arc)', () => {
    const r = steps[0]!.r;
    expect(r.stdout).toBe('lantern\n');
    expect(r.stderr).toContain(`rp-core: imported lorebook "Lantern" as ${lanternFile()}`);
    expect(r.stderr).toContain("RoleCall's stored tree and node constraints are dropped");
    const book = JSON.parse(bookBefore.toString('utf8')) as LoreBook;
    expect(book.name).toBe('Lantern');
    expect(book.entries).toHaveLength(18);
    expect(book.entries.filter((e) => e.meta?.type !== undefined)).toHaveLength(16);
    expect(book.entries.filter((e) => e.meta?.arc !== undefined).map((e) => e.title)).toEqual(['[Arc] Украденный свет']);
  });

  test('b. /lore add lantern; /memory tree: the session tree, then the book’s (Cast, Places, Narrative…); /memory list: C1…C16', () => {
    // Section I: /lore add says what /memory gains (nothing follows the book here: no handle moves).
    // M5b (D-177): the book's 15 typed entries and its [Arc] overview.
    expect(saidFor('/lore add lantern')).toBe('lorebook lantern "Lantern" added: 18 entries (from the next turn); its 16 Compendium entries join /memory now\n');
    const tree = saidFor('/memory tree').split('\n');
    expect(tree.slice(0, 2)).toEqual(['World Knowledge (this session) · 0', 'Lantern (lib: lantern) · 16']);
    for (const line of [
      '  Cast · 3',
      '    Unaffiliated · 1: C3 Ульяна',
      '  Places · 3',
      '    C4 Вельмар · 3',
      '      C6 Серый маяк',
      '  Events · 1',
      '  Narrative · 2',
      '    Украденный свет · 2: C16 [Arc] Украденный свет, C14 Фонарь погас',
      '  Bestiary · 1',
    ]) {
      expect(tree).toContain(line);
    }
    const list = saidFor('/memory list').split('\n');
    expect(list[0]).toBe('The Compendium of this path: 16 live · /memory show <ref> prints one');
    const rows = list.filter((l) => /^ {2}C\d+ /.test(l));
    const refs = rows.map((l) => Number(/^ {2}C(\d+)/.exec(l)![1]));
    expect(refs.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    for (const l of rows) expect(l).toContain('[lib: lantern]');
    expect(list).toContain('  C6  Серый маяк (aka маяк) — Каменная башня на краю мыса; на её крюке висел Латунный фонарь. [lib: lantern] [featured] [217]');
    expect(list).toContain('  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]');
  });

  test('c. /memory new character Мира (the editor), then «…отдай это Мире…»: her brief in the block at depth 1, above the directive', () => {
    expect(saidFor('/memory new character Мира')).toBe('character C17 "Мира" filed (from the next turn)\n');
    // One human row (path-free), the editor's JSON as saved.
    const rows = memRowsOf(sessionId);
    expect(rows[0]).toMatchObject({ key: null, on: null, by: 'user', ops: [{ op: 'file', type: 'character', data: MIRA_DATA }] });
    expect(saidFor('/memory show Мира').split('\n').slice(0, 3)).toEqual(['C17 Мира · character · character:мира', '  aka: Фонарщица', '  origin: this session, written by you at journal row 3']);

    // The turn: the Director planned, the narrator answered.
    const turn = saidFor(MESSAGE);
    expect(turn).toContain('  ⋯ director: planned — arcs +1 · chapter 1\n');
    expect(turn).toContain('Рассказчик › Лодочник взвешивает свёрток на ладони и долго молчит.');
    // /trace: picked by mention (Мира by her name in another case, the lighthouse by its alias, the
    // library summary by its RoleCall trigger «Мира»), all three as briefs (lite: an 8 192 window).
    const trace = saidFor('/trace');
    expect(trace).toContain('  compendium: lite · picked 3: C17 "Мира" (mention), C6 "Серый маяк" (mention), C14 "Фонарь погас" (mention) · injected 3: C17 "Мира" brief');
    // M5b (D-177, D-178): the book's [Arc] overview is no longer lore; it rides in the {{recap}} slot.
    expect(trace).toMatch(/\n {2}recap: 1 arc: C16 "Украденный свет" rev 0 · boundary [0-9a-f]{8}\n/);
    expect(trace).toContain('  lore: nothing fired');

    // /preview (the next turn: a swipe of that answer, whose user message is «…отдай это Мире…»).
    const preview = saidFor('/preview');
    expect(preview.split('\n')[0]).toStartWith('preview of a swipe (a new answer to ');
    const msgs = previewMessages(preview);
    const last = msgs.at(-1)!;
    expect(last).toMatchObject({ role: 'user', src: 'history', text: MESSAGE });
    const block = msgs.find((m) => m.src === 'compendium:block')!;
    const directive = msgs.find((m) => m.src === 'director')!;
    // Depth 1: the block and the directive sit right above the last message, the block first.
    expect([block.n, directive.n]).toEqual([last.n - 2, last.n - 1]);
    // M5b: the {{recap}} slot at the cut (nothing is cut: right after the greeting), ahead of the inserts.
    const recap = msgs[block.n - 2]!;
    expect(recap).toMatchObject({ role: 'system', src: 'recap' });
    expect(recap.text).toStartWith('[Arc] Украденный свет\nМаяк погас, фонарь пропал вместе со смотрительницей.');
    expect(msgs[recap.n - 2]).toMatchObject({ role: 'assistant', src: 'history' });
    expect(msgs.filter((m) => m.src.startsWith('lore'))).toEqual([]);
    expect(block.role).toBe('system');
    expect(directive.text).toStartWith('[DIRECTOR CONSTRAINTS - BINDING THIS TURN]');
    expect(block.text).toStartWith(
      [
        '[Retrieved World Knowledge]',
        '[Lore: Мира]',
        '# Мира',
        'Младшая фонарщица Вельмара и ученица Арсения Кеттера.',
        'Role: protagonist',
        'State: не спала две ночи, at Фонарный ряд',
        'Relationships: Селина Бранд (rival, strained); Арсений Кеттер (mentor)',
      ].join('\n'),
    );
    // The brief, not the full render.
    expect(block.text).not.toContain('## ');
    expect(block.text).toContain('\n\n[Lore: Серый маяк]\n');
    expect(block.text).toContain('\n\n[Lore: Фонарь погас]\n');
  });

  test('d. /memory edit of a library entry: an overlay; the book file is byte-identical; /memory show shows it', () => {
    expect(saidFor('/memory edit Ульяна')).toBe('character C3 "Ульяна" changed: set current_state (from the next turn; the book file stays as it is)\n');
    expect(bookAfter.equals(bookBefore)).toBe(true);
    const book = JSON.parse(bookAfter.toString('utf8')) as LoreBook;
    expect(book.entries.find((e) => e.title === 'Ульяна')?.meta?.data).toMatchObject({ current_state: { status: 'missing' } });
    expect(memRowsOf(sessionId)[1]).toMatchObject({ key: null, on: null, by: 'user', ops: [{ op: 'edit', ref: ULYANA_KEY, set: { current_state: ULYANA_STATE } }] });
    const show = saidFor('/memory show Ульяна').split('\n');
    expect(show[0]).toBe(`C3 Ульяна · character · ${ULYANA_KEY}`);
    expect(show).toContain(
      '  origin: the library book lantern, entry 00000000-0000-4000-8000-000000000e03; changed in this session (an overlay: the book file stays as it is)',
    );
    expect(show).toContain('  Condition: нашлась: три ночи пряталась в фонарной башне');
    expect(show).toContain('  Status: alive');
    // The second tree: the session's own (Мира; under 5 entries Bunraku's tree is one General group),
    // and the book's tree still holds Ульяна.
    const tree = saidFor('/memory tree', 2).split('\n');
    expect(tree.slice(0, 3)).toEqual(['World Knowledge (this session) · 1', '  General · 1: C17 Мира', 'Lantern (lib: lantern) · 16']);
    expect(tree).toContain('    Unaffiliated · 1: C3 Ульяна');
  });

  test('e. a swipe and a rewind leave Мира and the overlay in place; a fork keeps the entry keys', async () => {
    expect(saidFor('/r')).toContain('  ⋯ director: reused — arcs +1 · chapter 1\n');
    expect(saidFor('/r')).toContain('Рассказчик › Старик прячет свёрток под скамью.');
    expect(saidFor('/rewind 2')).toContain('rewound to your message 2');
    expect(saidFor('/fork')).toContain(`forked into ${forkId} (messages 1–2)\n`);
    const lists = [1, 2, 3].map((n) => saidFor('/memory list character', n));
    // After the swipe, after the rewind, in the fork: the same four characters, Ульяна still edited.
    expect(lists[1]).toBe(lists[0]!);
    expect(lists[2]).toBe(lists[0]!);
    expect(lists[0]).toContain('  C17 Мира (aka Фонарщица) — Младшая фонарщица Вельмара и ученица Арсения Кеттера. [698]\n');
    expect(lists[0]).toContain('  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern, edited] [348]\n');

    // The fork copied the human rows (renumbered in its own journal); the engine folds both sessions to
    // the same keys and handles.
    const human = (id: string) => memRowsOf(id).map(({ key, on, by, ops }) => ({ key, on, by, ops }));
    expect(human(forkId)).toEqual(human(sessionId));
    expect(human(sessionId)).toHaveLength(2);
    const c = await compendiumOf([sessionId, forkId]);
    const keys = (id: string) => c.get(id)!.rows.map((r) => `${r.ref} ${r.key}`);
    expect(keys(forkId)).toEqual(keys(sessionId));
    expect(keys(sessionId)).toContain('C17 character:мира');
    expect(keys(sessionId)).toContain(`C3 ${ULYANA_KEY}`);
    expect(c.get(forkId)!.rows.find((r) => r.ref === 'C3')).toMatchObject({ overlay: true });
    expect(c.get(forkId)!.data.get('C3')).toMatchObject({ current_state: ULYANA_STATE });
  });

  test('f. /memory export lantern2 --format compendium, then rp-core import: the same types, names, aliases, data', async () => {
    const path = join(home, 'exports', 'lantern2.compendium.json');
    expect(saidFor('/memory export lantern2 --format compendium')).toBe(`exported 2 entries as a RoleCall Compendium file (compendium-v1.0.0): ${path}\n`);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: string; format: string; tree: unknown; nodeConstraints: unknown[] };
    expect(file).toMatchObject({ schemaVersion: 'compendium-v1.0.0', format: 'rolecall-compendium', tree: null, nodeConstraints: [] });

    const r = steps[3]!.r;
    expect(r.stdout).toBe('lantern2\n');
    const back = JSON.parse(readFileSync(join(libraryDir(home, 'lorebooks'), 'lantern2.json'), 'utf8')) as LoreBook;
    const imported = back.entries.map((e) => ({ type: e.meta?.type, name: e.title ?? '', aliases: e.meta?.aliases, data: e.meta?.data }));
    // What was exported: the session's own entry (Мира) and the overlay (Ульяна, as a whole entry).
    const s = (await compendiumOf([sessionId])).get(sessionId)!;
    const exported = s.rows
      .filter((x) => x.origin === 'session' || x.overlay === true)
      .map((x) => ({ type: x.type, name: x.name, aliases: x.aliases, data: s.data.get(x.ref) }));
    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
    expect(imported.sort(byName)).toEqual(exported.sort(byName));
    expect(imported.map((e) => e.name).sort()).toEqual(['Мира', 'Ульяна']);
    expect(imported.find((e) => e.name === 'Мира')!.data).toEqual(MIRA_DATA);
  });

  test('g. --keep-requests: the Director’s request holds [COMPENDIUM CONTEXT] with Мира; the narrator’s the block', () => {
    const dir = join(home, 'sessions', `${sessionId}.requests`);
    const files = readdirSync(dir).sort();
    // The reply: the Director and the narrator; the swipe reused the plan, so only its narrator.
    const director = files.filter((f) => f.endsWith('_director_0.json'));
    const narrator = files.filter((f) => f.endsWith('_narrator_0.json'));
    expect(files).toHaveLength(3);
    expect(director).toHaveLength(1);
    expect(narrator).toHaveLength(2);
    const turn1 = director[0]!.slice(0, -'_director_0.json'.length);
    expect(narrator).toContain(`${turn1}_narrator_0.json`);

    const plan = requestText(join(dir, director[0]!));
    const ctx = plan.slice(plan.indexOf('[COMPENDIUM CONTEXT]'));
    expect(plan).toContain('[COMPENDIUM CONTEXT]\nCharacters:\n  - Мира: Младшая фонарщица Вельмара и ученица Арсения Кеттера.');
    expect(ctx).toContain('Unresolved Tensions:\n  Tension: Мира / Селина Бранд: rival relationship (strained)');
    expect(ctx).toContain('Key Locations:\n');
    for (const f of narrator) expect(requestText(join(dir, f))).toContain('[Retrieved World Knowledge]\n[Lore: Мира]\n# Мира\n');
    // Only the session that ran turns keeps requests (the fork ran none).
    expect(existsSync(join(home, 'sessions', `${forkId}.requests`))).toBe(false);
  });

  test('the transcript (docs/M5A-DEMO.md)', () => {
    const hide = (s: string): string => s.replaceAll(home, '<home>').replaceAll(`${ROOT}/`, '');
    const out: string[] = [];
    for (const s of steps) {
      const args = s.args.map((a) => (a.startsWith('script:') ? `script:${relative(ROOT, a.slice(7))}` : hide(a)));
      const env = s.env ? 'EDITOR="bun test/demo-m5a/editor.ts" ' : '';
      out.push(`$ ${env}rp-core --home <home> ${args.join(' ')}${s.stdin !== undefined ? ' < test/demo-m5a/script.txt' : ''}`);
      out.push(hide(s.r.stdout + s.r.stderr).trimEnd());
    }
    // The exported file and the book it imports as: a row per entry.
    const file = JSON.parse(readFileSync(join(home, 'exports', 'lantern2.compendium.json'), 'utf8')) as {
      schemaVersion: string;
      format: string;
      lorebook: { name: string };
      entries: { title: string; metadata: { entry_type?: string; structured_data?: { aliases?: string[] } } }[];
      tree: unknown;
    };
    out.push(`# exports/lantern2.compendium.json: ${file.schemaVersion} · ${file.format} · lorebook "${file.lorebook.name}" · tree ${JSON.stringify(file.tree)}`);
    for (const e of file.entries) out.push(`  ${e.metadata.entry_type} ${e.title} (aka ${(e.metadata.structured_data?.aliases ?? []).join(', ')})`);
    const back = JSON.parse(readFileSync(join(libraryDir(home, 'lorebooks'), 'lantern2.json'), 'utf8')) as LoreBook;
    out.push(`# library/lorebooks/lantern2.json: "${back.name}"`);
    for (const e of back.entries) out.push(`  ${e.meta?.type} ${e.title} (aka ${(e.meta?.aliases ?? []).join(', ')}) · data ${JSON.stringify(e.meta?.data).length} chars`);
    const dir = join(home, 'sessions', `${sessionId}.requests`);
    const director = readdirSync(dir).find((f) => f.endsWith('_director_0.json'))!;
    const plan = requestText(join(dir, director));
    out.push(`$ ls <home>/sessions/${sessionId}.requests`, readdirSync(dir).sort().join('\n'));
    const at = plan.indexOf('[COMPENDIUM CONTEXT]');
    out.push(`# the [COMPENDIUM CONTEXT] section of ${director}:`, plan.slice(at, plan.indexOf('\n\n### ', at)));
    console.log(`\n${out.join('\n')}\n\n(${ms.toFixed(0)} ms)\n`);
    expect(out.join('\n')).not.toContain(home);
  });
});
