// The whole TUI end to end (TUI decisions T-11, repl-map §5): the host, the chat transcript and both
// side panes as ONE program, over the real Repl and engine with the scripted provider, on a headless
// renderer. What a person would see is the captured frame; what the story became is the journal.
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { Engine } from '../../src/engine/engine.ts';
import { cmdNew } from '../../src/cli/commands.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import { rendererConfig } from '../../src/cli/tui/app.ts';
import { runTui, type TuiParts } from '../../src/cli/tui/run.ts';
import { messageText } from '../../src/cli/render.ts';
import { stripAnsi } from '../../src/cli/repl-render.ts';
import { createAgentsPane } from '../../src/cli/tui/agents-pane.ts';
import { THEME } from '../../src/cli/tui/theme.ts';
import { ARCHIVE_BLOCK, createTranscript, HISTORY_BATCH } from '../../src/cli/tui/transcript.ts';
import { LAYOUT } from '../../src/cli/tui/types.ts';
import { SCRIPT_CAPS, type ScriptStep } from '../../src/providers/scripted.ts';
import type { Trace } from '../../src/session/entries.ts';
import { readLock } from '../../src/session/log.ts';
import { dirConfig, fullCaps, planOf, tagged } from '../engine-m4/kit.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { writeRaw } from '../repl/kit.ts';
import { calls, LEVI, MIRA, tuiRig, type TuiRig, type TuiRigOptions } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

const RESET = '\x1b[?2027l';
/** RP_CORE_PERF=1: the wall-clock and memory thresholds run too (they flake on a loaded machine, so not by default). */
const PERF = process.env.RP_CORE_PERF === '1';
const count = (s: string, sub: string): number => s.split(sub).length - 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(ok: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !ok(); waited += 5) {
    if (waited > 5000) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- the frame's columns (every glyph of these frames is one column wide) -------------------------

const rowsOf = (f: string): string[] => f.split('\n');
const slice = (f: string, from: number, to?: number): string =>
  rowsOf(f)
    .map((r) => [...r].slice(from, to).join(''))
    .join('\n');
/** The Models box at a width that shows all three columns. */
const leftPane = (f: string): string => slice(f, 0, LAYOUT.left);
/** The Agents box (the last LAYOUT.right columns). */
const rightPane = (f: string, width: number): string => slice(f, width - LAYOUT.right);
/** The Chat box between them. */
const chatPane = (f: string, width: number): string => slice(f, LAYOUT.left, width - LAYOUT.right);
/** The rows of a pane as text without the box's borders and padding. */
const lines = (pane: string): string[] => rowsOf(pane).map((r) => r.replace(/^[│┌└]\s?/, '').replace(/\s*[│┐┘▄▀█]?$/, '').trimEnd());

/** The first span holding `text` in the frame, from column `fromX` on. */
function spanWith(r: TuiRig, text: string, fromX = 0) {
  for (const line of r.setup.captureSpans().lines) {
    let x = 0;
    for (const sp of line.spans) {
      if (x >= fromX && sp.text.includes(text)) return sp;
      x += sp.width;
    }
  }
  return undefined;
}

// ---- a recording host: the transcript's calls, the idle()s ---------------------------------------------

interface Recorded {
  /** One line per transcript call: `echo:…`, `sys:…`, `status:…`, `card:…`, `turn`, `path:N`. */
  log: string[];
  /** agents.refresh() calls: one per Repl idle() (and F3). */
  idles(): number;
  parts: Partial<TuiParts>;
}

function recording(): Recorded {
  const log: string[] = [];
  let idles = 0;
  return {
    log,
    idles: () => idles,
    parts: {
      transcript(ui, theme, o) {
        const t = createTranscript(ui, theme, o);
        return {
          showPath: (p, n, s) => (log.push(`path:${p.length}`), t.showPath(p, n, s)),
          card: (m, n) => (log.push(`card:${messageText(m)}`), t.card(m, n)),
          system: (s) => (log.push(`sys:${stripAnsi(s)}`), t.system(s)),
          echo: (s) => (log.push(`echo:${stripAnsi(s)}`), t.echo(s)),
          status: (s) => (log.push(`status:${stripAnsi(s)}`), t.status(s)),
          turn: (o2) => (log.push('turn'), t.turn(o2)),
          scroll: (h) => t.scroll(h),
          lastCardId: () => t.lastCardId(),
        };
      },
      agents(ui, theme, clock) {
        const a = createAgentsPane(ui, theme, clock);
        return { event: (e) => a.event(e), refresh: (...x) => (idles++, a.refresh(...x)), reset: (id) => a.reset(id) };
      },
    },
  };
}

/** Another session in the same home, closed again (so /open can take its lock). */
async function otherSession(home: string): Promise<string> {
  const e = await Engine.open({ home, clock: fakeClock() });
  const s = e.createSession({ character: { name: 'Ольга', description: 'Смотритель маяка.', greetings: ['Здравствуй, путник.'] }, persona: LEVI, title: 'Маяк' });
  const id = s.id;
  await e.close();
  return id;
}

/** A closed session with `n` lines of the player already in it (taller than the screen). */
async function storyWith(n: number): Promise<{ home: string; id: string }> {
  const home = tmpHome('rp-core-tui-');
  const e = await Engine.open({ home, clock: fakeClock() });
  const s = e.createSession({ character: MIRA, persona: LEVI });
  for (let i = 1; i <= n; i++) s.send({ text: `Строка ${i} истории.`, expectedVersion: s.version() });
  const id = s.id;
  await e.close();
  return { home, id };
}

// ---- layout -------------------------------------------------------------------------------------------

describe('layout', () => {
  test.each([
    [120, ['Models', 'Chat', 'Agents']],
    [100, ['Chat', 'Agents']],
    [70, ['Chat']],
  ])('%i columns: the boxes, their widths, every row exactly as wide as the terminal', async (width, boxes) => {
    rig = await tuiRig(calls([{ text: 'Карта готова.' }]), { width, height: 30 });
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    const f = await rig.until('swipe 1/1');
    const top = rowsOf(f)[0]!;
    for (const row of rowsOf(f).filter((r) => r !== '')) expect(Bun.stringWidth(row)).toBe(width);
    // The top border: each box where T-4 puts it.
    const starts: Record<string, number> = {};
    for (const b of boxes) starts[b] = [...top].join('').indexOf(`┌─ ${b} `);
    for (const b of ['Models', 'Chat', 'Agents']) if (!boxes.includes(b)) expect(top).not.toContain(` ${b} `);
    if (boxes.includes('Models')) expect(starts.Models).toBe(0);
    expect(starts.Chat).toBe(boxes.includes('Models') ? LAYOUT.left : 0);
    if (boxes.includes('Agents')) expect(starts.Agents).toBe(width - LAYOUT.right);
    expect(top.endsWith('┐')).toBe(true);
    // The chat box holds the transcript, the status row and the input row, in that order.
    const chat = boxes.includes('Agents') ? slice(f, starts.Chat!, width - LAYOUT.right) : slice(f, starts.Chat!);
    const rows = lines(chat);
    const card = rows.findIndex((r) => r.startsWith('Mira › Карта готова.'));
    const status = rows.findIndex((r) => r.startsWith('ready · Enter sends'));
    // T-17: the input label is `you ›` with no padding (the transcript keeps the REPL's alignment).
    const input = rows.findIndex((r) => r.startsWith('you › Write your line'));
    expect(card).toBeGreaterThan(0);
    expect(status).toBeGreaterThan(card);
    expect(input).toBe(status + 1);
    if (boxes.includes('Models')) expect(lines(leftPane(f))).toContain('script:default');
    if (boxes.includes('Agents')) expect(lines(rightPane(f, width))[1]).toBe('Narrator · idle');
  });
});

// ---- a turn ---------------------------------------------------------------------------------------------

describe('a turn', () => {
  test('type + Enter: the echo, the card streams, then its status line; the panes and the status row follow', async () => {
    rig = await tuiRig(calls([{ text: 'Карта ' }, { pause: 'p' }, { text: '*шуршит* готова.' }]), { width: 130 });
    await rig.until('Hello, Levi');
    await rig.type('Привет, Мира');
    expect(rig.input()).toBe('Привет, Мира');
    rig.setup.mockInput.pressEnter();
    let f = await rig.until('Mira › Карта');
    expect(rig.input()).toBe('');
    expect(chatPane(f, 130)).toContain('you  › Привет, Мира');
    expect(f).toContain('answering… · Ctrl+C stops');
    expect(f).not.toContain('swipe 1/1');
    expect(lines(rightPane(f, 130))).toContain('Narrator · writing…');
    rig.provider.release('p');
    f = await rig.until('swipe 1/1');
    const chat = lines(chatPane(f, 130));
    // The action italic without its asterisks (polish2); the stored text keeps them.
    const card = chat.findIndex((r) => r === 'Mira › Карта шуршит готова.');
    expect(card).toBeGreaterThan(0);
    expect(chat[card + 1]).toMatch(/^ {2}\[swipe 1\/1 · [\d.]+s · end\]/);
    expect(count(f, 'Карта')).toBe(1);
    expect(f).toContain('ready · Enter sends');
    expect(lines(rightPane(f, 130))).toContain('Narrator · idle');
    // *actions* in italics, the name in the character's colour.
    expect(spanWith(rig, 'шуршит')!.attributes & TextAttributes.ITALIC).toBeTruthy();
    expect(spanWith(rig, 'Mira', LAYOUT.left)!.fg.equals(THEME.char)).toBe(true);
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Карта *шуршит* готова.');
  });

  // T-17, one stop marker: the status line says `stopped`; the dim [stopped] row that used to repeat it is gone.
  test('a pause, then Ctrl+C: the status line says stopped (no [stopped] row), the partial answer kept on screen and in the story; the next turn runs', async () => {
    rig = await tuiRig(calls([{ text: 'Начало ' }, { pause: 'p' }, { text: 'конец.' }], [{ text: 'Дальше.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Mira › Начало');
    rig.setup.mockInput.pressCtrlC();
    const f = await rig.until('· stopped]');
    const chat = lines(chatPane(f, 130));
    const card = chat.indexOf('Mira › Начало');
    expect(card).toBeGreaterThan(0);
    expect(chat[card + 1]).toMatch(/^ {2}\[swipe 1\/1 · [\d.]+s · stopped\]$/);
    expect(f).not.toContain('[stopped]');
    expect(f).not.toContain('конец.');
    const head = rig.session.view().path.at(-1)!;
    expect([messageText(head), head.gen?.finish]).toEqual(['Начало ', 'stopped']);
    await rig.until('ready · Enter sends');
    await rig.send('ещё');
    await rig.until('Mira › Дальше.');
    expect(count(await rig.frame(), 'Mira › Начало')).toBe(1);
  });

  test('typing mid-turn is held and sent after the answer; /hide 1 mid-turn is refused', async () => {
    rig = await tuiRig(calls([{ text: 'Медленно ' }, { pause: 'p' }, { text: 'всё.' }], [{ text: 'Потом.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Медленно');
    await rig.send('ещё');
    await rig.until('(held: sent when this answer ends)');
    await rig.send('/hide 1');
    await rig.until('refused [session_busy]: /hide changes the story');
    expect(rig.session.view().path[0]!.hidden).toBe(false);
    rig.provider.release('p');
    const f = await rig.until('Mira › Потом.');
    // The held line went in after the first answer ended, as the player's own line.
    expect(f.indexOf('Медленно всё.')).toBeLessThan(f.lastIndexOf('you  › ещё'));
    expect(f.lastIndexOf('you  › ещё')).toBeLessThan(f.indexOf('Mira › Потом.'));
    expect(rig.session.view().path.map((m) => messageText(m))).toEqual(['*Mira looks up.* "Hello, Levi."', 'hi', 'Медленно всё.', 'ещё', 'Потом.']);
  });
});

describe('the chat reads like a chat (T-15)', () => {
  test('continue after F1: a block of its own under `you › /c`, in view while it streams; the first card repainted; no REPL hints', async () => {
    rig = await tuiRig(calls([{ text: 'Первый ответ.' }], [{ text: ' ДАЛЬШЕ-1' }, { pause: 'p' }, { text: ' ДАЛЬШЕ-2.' }]), { width: 130, height: 30 });
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    let f = await rig.until('swipe 1/1');
    expect(f).not.toContain('/r swipe');
    expect(f).not.toContain('/c continue');
    await rig.setup.mockInput.pressKeys(['F1']);
    await rig.until('Ctrl+C stops an answer');
    rig.setup.mockInput.pressKey('o', { ctrl: true });
    f = await rig.until('Mira › …Первый ответ. ДАЛЬШЕ-1');
    // The chat's rows without the scrollbar's thumb.
    const chatRows = (frame: string): string[] => lines(chatPane(frame, 130)).map((r) => r.replace(/[▄▀█]$/, '').trimEnd());
    let chat = chatRows(f);
    expect(chat.indexOf('Mira › …Первый ответ. ДАЛЬШЕ-1')).toBeGreaterThan(chat.lastIndexOf('you  › /c'));
    expect(chat.lastIndexOf('you  › /c')).toBeGreaterThan(0);
    rig.provider.release('p');
    f = await rig.until('Mira › …Первый ответ. ДАЛЬШЕ-1 ДАЛЬШЕ-2.');
    f = await rig.until('ready · Enter sends');
    chat = chatRows(f);
    const block = chat.indexOf('Mira › …Первый ответ. ДАЛЬШЕ-1 ДАЛЬШЕ-2.');
    expect(block).toBeGreaterThan(0);
    expect(chat[block + 1]).toMatch(/^ {2}\[swipe 1\/1 · [\d.]+s · end\]$/);
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Первый ответ. ДАЛЬШЕ-1 ДАЛЬШЕ-2.');
    // The first card, scrolled away under the help, now shows the whole answer.
    rig.setup.mockInput.pressKey('HOME', { ctrl: true });
    f = await rig.until('Mira › Первый ответ. ДАЛЬШЕ-1 ДАЛЬШЕ-2.');
  });

  test('a held line mid-action: the rest of the action stays italic, the speech plain', async () => {
    rig = await tuiRig(calls([{ text: '*Она идёт к ' }, { pause: 'p' }, { text: 'двери.* «Привет», — говорит она.' }], [{ text: 'Потом.' }]), { width: 130 });
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Она идёт к');
    await rig.send('ещё');
    await rig.until('(held: sent when this answer ends)');
    rig.provider.release('p');
    await rig.until('Mira › Потом.');
    expect(spanWith(rig, 'двери.', LAYOUT.left)!.attributes & TextAttributes.ITALIC).toBeTruthy();
    expect(spanWith(rig, '«Привет»', LAYOUT.left)!.attributes & TextAttributes.ITALIC).toBeFalsy();
    expect(spanWith(rig, 'говорит она', LAYOUT.left)!.attributes & TextAttributes.ITALIC).toBeFalsy();
  });

  test('stopped inside *…*, then Ctrl+O: the addition starts italic; the first card loses its stopped status', async () => {
    rig = await tuiRig(calls([{ text: '*Она идёт к ' }, { pause: 'p' }, { text: 'never' }], [{ text: 'двери.* «Привет», — говорит она.' }]), { width: 130 });
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Mira › Она идёт к');
    rig.setup.mockInput.pressCtrlC();
    let f = await rig.until('· stopped]');
    expect(f).not.toContain('Mira › [stopped]');
    await rig.until('ready · Enter sends');
    rig.setup.mockInput.pressKey('o', { ctrl: true });
    await rig.until('говорит она.');
    f = await rig.until('ready · Enter sends');
    expect(f).toContain('Mira › Она идёт к двери. «Привет», — говорит она.');
    expect(f).toContain('Mira › …Она идёт к двери. «Привет», — говорит она.');
    expect(f).not.toContain('· stopped]');
    const block = lines(chatPane(f, 130)).findIndex((r) => r.startsWith('Mira › …'));
    expect(block).toBeGreaterThan(0);
    for (const sp of rig.setup.captureSpans().lines.flatMap((l) => l.spans).filter((x) => x.text.includes('двери.'))) {
      expect(sp.attributes & TextAttributes.ITALIC).toBeTruthy();
    }
    for (const sp of rig.setup.captureSpans().lines.flatMap((l) => l.spans).filter((x) => x.text.includes('говорит она'))) {
      expect(sp.attributes & TextAttributes.ITALIC).toBeFalsy();
    }
  });
});

describe('scrolling', () => {
  test('PgUp holds the view while an answer streams; Ctrl+End and a hotkey command bring it back to the bottom', async () => {
    const story = await storyWith(30);
    rig = await tuiRig(calls([{ text: 'Начало ' }, { pause: 'p' }, { text: 'и конец.' }], [{ text: 'Новая версия.' }]), { home: story.home, sessionId: story.id, width: 100, height: 20 });
    await rig.until('Строка 30 истории.');
    await rig.send('дальше');
    await rig.until('Mira › Начало');
    await rig.setup.mockInput.pressKeys(['\x1b[5~']);
    const held = await rig.gone('Mira › Начало');
    rig.provider.release('p');
    await waitFor(() => messageText(rig!.session.view().path.at(-1)!) === 'Начало и конец.', 'the answer');
    await rig.gone('answering…');
    // Only the scrollbar (and the status row) moved: the transcript rows the reader looks at stayed put.
    const transcriptRows = (f: string): string[] => {
      const rows = lines(slice(f, 0, 100 - LAYOUT.right)).map((r) => r.replace(/[▄▀█]$/, '').trimEnd());
      return rows.slice(0, rows.findIndex((r) => /^(answering…|ready) /.test(r)));
    };
    const after = transcriptRows(await rig.frame());
    expect(after.length).toBeGreaterThan(10);
    expect(after).toEqual(transcriptRows(held));
    rig.setup.mockInput.pressKey('END', { ctrl: true });
    await rig.until('Mira › Начало и конец.');
    await rig.setup.mockInput.pressKeys(['\x1b[5~', '\x1b[5~']);
    await rig.gone('Mira › Начало и конец.');
    rig.setup.mockInput.pressKey('r', { ctrl: true });
    await rig.until('Mira › Новая версия.');
  });
});

describe('/think', () => {
  test('folded while it streams; after /think show the reasoning of a card shown later is open', async () => {
    rig = await tuiRig(calls([{ reasoning: 'думаю о лампе' }, { text: 'Первый.' }], [{ reasoning: 'снова думаю' }, { text: 'Второй.' }]), { width: 120, height: 30 });
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    let f = await rig.until('swipe 1/1');
    expect(f).toContain('⋯ thinking (13 chars)');
    expect(f).not.toContain('думаю о лампе');
    await rig.send('/think show');
    await rig.until('reasoning will be shown');
    rig.setup.mockInput.pressKey('r', { ctrl: true });
    f = await rig.until('swipe 2/2');
    expect(f).toContain('⋯ снова думаю');
    await rig.send('/[');
    f = await rig.until('swipe 1/2');
    // The first answer's card again, now with its reasoning open (the transcript asks the Repl's /think).
    expect(f).toContain('⋯ думаю о лампе');
    await rig.send('/think hide');
    await rig.until('reasoning will be folded');
    await rig.send('/]');
    f = await rig.until('swipe 2/2', 2);
    expect(f.slice(f.lastIndexOf('you  › /]'))).toContain('⋯ thinking (11 chars)');
  });
});

// ---- every slash command ----------------------------------------------------------------------------------

describe('every slash command (smoke)', () => {
  test('each shows its rows in the transcript; nothing reaches stdout / stderr while the TUI is up', async () => {
    const rec = recording();
    rig = await tuiRig(
      calls([{ text: 'Карта готова.' }], [{ text: 'Вторая.' }], [{ text: 'Мягче.' }], [{ text: ' И ещё.' }], [{ text: 'Ответ на слэш.' }]),
      { width: 130, height: 40, parts: rec.parts },
    );
    const other = await otherSession(rig.home);
    await rig.until('Hello, Levi');
    const writes: string[] = [];
    const real = { out: process.stdout.write, err: process.stderr.write };
    const spy = (name: 'out' | 'err') =>
      function (this: unknown, chunk: unknown, ...rest: unknown[]) {
        writes.push(`${name}: ${String(chunk)}`);
        return (real[name] as (...a: unknown[]) => boolean).call(name === 'out' ? process.stdout : process.stderr, chunk, ...rest);
      };
    process.stdout.write = spy('out') as typeof process.stdout.write;
    process.stderr.write = spy('err') as typeof process.stderr.write;
    let answerId = '';
    try {
      // [line, what its rows say]
      const script: [string | (() => string), string][] = [
        ['hi', 'status:  [swipe 1/1'],
        ['/r', 'status:  [swipe 2/2'],
        ['/[', 'card:Карта готова.'],
        ['/]', 'card:Вторая.'],
        ['/regen softer', 'status:  [swipe 3/3'],
        ['/c', 'turn'],
        ['/hide 2', 'message 2 is hidden'],
        ['/unhide 2', 'message 2 is visible again'],
        ['/show', '3. Mira'],
        ['/tails', 'branches off this path'],
        ['/model', 'narrator script:default'],
        ['/note hello', "author's note set"],
        ['/note off', "author's note removed"],
        ['/think', 'reasoning is folded'],
        ['/think show', 'reasoning will be shown'],
        ['/think hide', 'reasoning will be folded'],
        ['/sessions', 'Маяк'],
        ['/usage', 'generations on this path'],
        ['/trace', 'trace of'],
        ['/preset', 'preset: builtin'],
        ['/lore', 'no lorebooks'],
        ['/lore test lamp', 'lore test:'],
        ['/lore add /nonexistent.json', 'error: no such file'],
        ['/lore rm nothing', 'is not a lorebook of this session'],
        ['/preview', 'preview of a swipe'],
        ['/preview --wire', 'no wire form'],
        ['/preview --verdicts', 'lore verdicts:'],
        ['/probe', 'Probes run from the shell'],
        ['/memory', 'nothing in the Compendium on this path yet'],
        ['/memory add Lamp | lamp | The lamp is old.', 'note C1 "Lamp" added'],
        ['/memory show C1', '[Memory: Lamp]'],
        ['/memory edit C1 | | The lamp is very old.', 'note C1 "Lamp" changed'],
        ['/memory retire C1', 'retired'],
        ['/memory restore C1', 'restored'],
        ['/memory tree', 'General · 1: C1 Lamp'],
        ['/memory recall', 'arrives with M5c'],
        ['/search lamp', 'no messages match'],
        ['/director', 'The Director has not planned yet'],
        ['/director on', 'director on:'],
        ['/director off', 'director off (from the next turn)'],
        ['/help', 'Type to speak. Commands:'],
        ['/persona', 'arrives with a later milestone'],
        ['/bogus', 'unknown command /bogus'],
        ['/', 'a lone "/" is not a command'],
        ['/model narrator alt:default', 'narrator → alt:default'],
        ['/model narrator script:default', 'narrator → script:default'],
        [() => ((answerId = rig!.session.view().path.at(-1)!.id), '/rewind 2'), 'rewound to your message 2'],
        [() => `/goto ${answerId}`, 'card:Мягче. И ещё.'],
        ['//slash', 'status:  [swipe 1/1'],
        ['/fork', 'forked into'],
        [`/open ${other}`, 'path:1'],
      ];
      for (const [item, says] of script) {
        const line = typeof item === 'function' ? item() : item;
        const mark = rec.log.length;
        const before = rec.idles();
        await rig.send(line);
        await waitFor(() => rec.idles() > before, `idle after ${line}`);
        const rows = rec.log.slice(mark);
        const shown = rows.join('\n');
        // The Repl echoes the line, then shows what it did.
        expect(rows[0]).toMatch(new RegExp(` › ${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        expect(rows.length).toBeGreaterThan(1);
        if (!shown.includes(says)) throw new Error(`${line}: expected ${JSON.stringify(says)} in\n${shown}`);
      }
      // /help in the TUI says how /e works here.
      expect(rec.log.join('\n')).toContain('In the TUI: /e and Ctrl+E edit in the input box');
      // /open switched to the other story.
      const f = await rig.until('Здравствуй, путник.');
      expect(f).not.toContain('Карта готова.');
      // /e opens the in-place edit (no idle until it ends); Esc cancels it.
      await rig.send('/e');
      await rig.until('edit ›');
      expect(rig.input()).toBe('Здравствуй, путник.');
      rig.setup.mockInput.pressEscape();
      await rig.until('edit cancelled');
      expect(rig.out()).toBe('');
      expect(rig.err()).toBe('');
    } finally {
      process.stdout.write = real.out;
      process.stderr.write = real.err;
    }
    expect(writes).toEqual([]);
    await rig.send('/quit');
    expect(await rig.done).toBe(0);
    expect(rig.out()).toBe(RESET);
  }, 30_000);
});

// ---- /e in place ------------------------------------------------------------------------------------------

describe('/e in place (Ctrl+E)', () => {
  test('prefill with real line breaks, edit, Enter saves; Ctrl+E again and Esc cancels', async () => {
    rig = await tuiRig(calls([{ text: 'Строка один.\nСтрока два.' }]), { width: 130 });
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('swipe 1/1');
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    let f = await rig.until('edit ›');
    expect(f).toContain('editing in place · Enter saves · Esc or Ctrl+C cancels');
    expect(rig.input()).toBe('Строка один.\nСтрока два.');
    // The input grows to the two lines (measured after a frame, applied in the next).
    const input = rig.setup.renderer.root.findDescendantById('input') as unknown as { height: number };
    await waitFor(() => input.height === 2 || (void rig!.frame(), false), 'the input to grow');
    await rig.type(' Правка!');
    rig.setup.mockInput.pressEnter();
    f = await rig.until('Строка два. Правка!');
    await rig.gone('edit ›');
    expect(f).toContain('you  ›');
    const head = rig.session.view().path.at(-1)!;
    expect([messageText(head), head.edited]).toEqual(['Строка один.\nСтрока два. Правка!', true]);
    // Again, and Esc: nothing changes, the box is empty, the label is back.
    rig.setup.mockInput.pressKey('e', { ctrl: true });
    await rig.until('edit ›');
    await rig.type(' мусор');
    rig.setup.mockInput.pressEscape();
    f = await rig.until('edit cancelled');
    await rig.gone('edit ›');
    expect(rig.input()).toBe('');
    expect(f).not.toContain('мусор');
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Строка один.\nСтрока два. Правка!');
  });
});

// ---- the side panes after real turns ---------------------------------------------------------------------

describe('the side panes', () => {
  test('a Director turn: planning… then planned + summary in Agents; the binding and the plan\'s profile in Models', async () => {
    const director: ScriptStep[] = [{ pause: 'd' }, { text: tagged(planOf()) }];
    rig = await tuiRig(calls(director, [{ text: 'Фонарь гаснет.' }]), { width: 130, height: 34, caps: fullCaps(), config: dirConfig() });
    let f = await rig.until('Hello, Levi');
    let models = lines(leftPane(f));
    expect(models).toContain('Director');
    expect(models).toContain('follows narrator');
    expect(models).toContain('profile auto');
    expect(models).toContain('style the-balanced');
    expect(lines(rightPane(f, 130))).toContain('Director · not planned yet');
    await rig.send('I look around.');
    f = await rig.until('Director · planning…');
    rig.provider.release('d');
    f = await rig.until('Mira › Фонарь гаснет.');
    f = await rig.until('turn 1 · full · tagged');
    const agents = lines(rightPane(f, 130));
    expect(agents.find((r) => r.startsWith('Director · planned · '))).toMatch(/^Director · planned · [\d.]+s$/);
    expect(agents).toContain('  arcs +1 · seeds +1 · chapter 1');
    expect(agents).toContain('  chapter 1 "Lamps"');
    expect(agents).toContain('  1 live arc · 0 seeds due');
    models = lines(leftPane(f));
    const at = models.indexOf('Director');
    expect(models.slice(at, at + 5)).toEqual(['Director', 'script:default', 'follows narrator', 'profile full', 'style the-balanced']);
    // The transcript has the Director's side line in the card, as the REPL prints it.
    expect(f).toContain('⋯ director: planned — arcs +1 · seeds +1 · chapter 1');
  });

  test('a native tool step: the side line in the card, a tool row with its duration in Agents, "tools native" in Models', async () => {
    const SMALL_WINDOW = { window: 3000, roles: { narrator: { conn: 'script', model: 'default', maxTokens: 64 } } } as const;
    const o: TuiRigOptions = { width: 130, height: 34, caps: { ...SCRIPT_CAPS, tools: 'native' }, config: SMALL_WINDOW };
    rig = await tuiRig(calls([{ tool: { name: 'search_history', args: { query: 'caravan' } } }], [{ text: 'The caravan left at dawn.' }]), o);
    // A history longer than the window: search_history is offered.
    for (let i = 1; i <= 40; i++) {
      const filler = ' The road goes on through the dunes and the wind keeps blowing sand into every pack and every boot.'.repeat(3);
      rig.session.send({ text: `Day ${i}: ${i === 3 ? 'the caravan moves on.' : 'we walk on.'}${filler}`, expectedVersion: rig.session.version() });
    }
    await rig.until('no answer yet');
    await rig.send('Where did the caravan go?');
    const f = await rig.until('Mira › The caravan left at dawn.');
    expect(f).toContain('⋯ search_history "caravan" → 2 hits');
    const agents = await rig.until('2 rounds · tools native');
    expect(lines(rightPane(agents, 130))[2]).toMatch(/^ {2}⋯ search_history "cara… · [\d.]+s$/);
    expect(lines(leftPane(agents))).toContain('ctx 3k · tools native');
  });
});

// ---- sessions --------------------------------------------------------------------------------------------

describe('sessions', () => {
  test('/open and /fork switch the transcript and both panes', async () => {
    rig = await tuiRig(calls([{ text: 'Карта готова.' }]), { width: 130, height: 34 });
    const other = await otherSession(rig.home);
    await rig.until('Hello, Levi');
    await rig.send('hi');
    let f = await rig.until('swipe 1/1');
    expect(lines(rightPane(f, 130))).toContain('  1 call · usage not reported');
    await rig.send(`/open ${other}`);
    f = await rig.until('Здравствуй, путник.');
    expect(f).not.toContain('Карта готова.');
    expect(f).not.toContain('Hello, Levi');
    let models = lines(leftPane(f));
    expect(models[1]).toBe('Маяк');
    expect(models[2]).toBe('Ольга · you: Levi');
    let agents = lines(rightPane(f, 130));
    expect(agents).toContain('Narrator · idle');
    expect(agents).toContain('  no model calls yet');
    expect(agents.some((r) => r.includes('last '))).toBe(false);
    // T-17: the input label is `you ›` whatever the names (it was padded to the character's label).
    expect(f).toContain('│ you › Write your line');
    expect(f).not.toContain('you   › Write your line');
    await rig.send('/fork');
    await waitFor(() => rig!.engine.listSessions().length === 3, 'the fork');
    f = await rig.until('forked into');
    const forkId = /forked into (s_[0-9a-f]+)/.exec(f)![1]!;
    f = await rig.until('Здравствуй, путник.');
    expect(count(f, 'Здравствуй, путник.')).toBe(1);
    expect(f).not.toContain(`/open ${other}`);
    models = lines(leftPane(f));
    const fork = rig.engine.listSessions().find((s) => s.id === forkId)!;
    expect(models[1]).toBe(fork.title ?? forkId);
    agents = lines(rightPane(f, 130));
    expect(agents).toContain('  no model calls yet');
  });

  test('a recovery notice at open: the interrupted answer once, the notice under the story', async () => {
    const home = tmpHome('rp-core-tui-');
    const e = await Engine.open({ home, clock: fakeClock() });
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const sent = s.send({ text: 'Tell me.', expectedVersion: s.version() });
    const id = s.id;
    await s.close();
    await e.close();
    const trace: Trace = {
      seed: 1,
      now: '2026-10-26T12:00:00.000Z',
      window: 8192,
      reserve: 2048,
      tokens: { estimated: 10 },
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
    };
    writeRaw(home, id, (log) => {
      const ts = '2026-10-26T12:00:00.000Z';
      log.append({ t: 'turn', ts, turn: 't_crash01', kind: 'reply', parent: sent.messageId, msgId: 'abcdef01', seed: 1, now: ts, base: sent.version });
      log.append({ t: 'prep', turn: 't_crash01', trace });
      log.append({ t: 'chk', turn: 't_crash01', text: 'She begins to ' }, { durable: false });
    });
    rig = await tuiRig([], { home, sessionId: id, width: 130 });
    const f = await rig.until('recovered an interrupted turn');
    // One row, wrapped at the chat's width.
    expect(lines(chatPane(f, 130)).join(' ')).toContain('! recovered an interrupted turn (t_crash01): its partial answer was saved, marked [interrupted]');
    // The finish is said once (T-15): in the status line under the card, not before its text.
    expect(count(f, 'Mira › She begins to')).toBe(1);
    expect(f).not.toContain('[interrupted] She');
    expect(f).toMatch(/\[swipe 1\/1 · interrupted\]/);
    expect(f.indexOf('Mira › She begins to')).toBeLessThan(f.indexOf('recovered an interrupted turn'));
    // The notice is yellow, as the REPL styles it.
    expect(spanWith(rig, 'recovered an interrupted turn')!.fg.equals(THEME.yellow)).toBe(true);
  });

  test('new --tui: the new session opens in the TUI, the hint names `rp-core tui`, /quit closes it', async () => {
    const home = tmpHome('rp-core-tui-');
    const setup = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, ...rendererConfig() });
    const out = memoryChannel();
    const err = memoryChannel();
    const rt = loadRuntime(home, {});
    const card = join(import.meta.dir, '..', 'fixtures', 'cards', 'v3-full.json');
    const done = cmdNew({
      home,
      card,
      json: false,
      io: { out, err },
      rt,
      reopen: 'tui',
      chat: (engine, session) =>
        runTui(engine, session, { rt, io: { out, err }, exitNow: () => {}, env: { HOME: home }, signals: new EventEmitter(), createRenderer: async () => setup.renderer }),
    });
    let f = '';
    for (let waited = 0; !f.includes('Another adventurer'); waited += 5) {
      if (waited > 5000) throw new Error(`no greeting; frame:\n${f}`);
      await sleep(5);
      await setup.renderOnce();
      f = setup.captureCharFrame();
    }
    expect(f).toContain('Alice › ');
    // (The card's import warnings come first, on the real stderr before the renderer starts.)
    expect(err.text()).toMatch(/\nrp-core: created session (s_[0-9a-f]+) \(card imported as library character [^)]+\); `rp-core tui \1` reopens it\n$/);
    await setup.mockInput.pressKeys([...'/quit']);
    setup.mockInput.pressEnter();
    expect(await done).toBe(0);
    expect(out.text()).toBe(RESET);
    const id = /(s_[0-9a-f]+)/.exec(err.text())![1]!;
    expect(readLock(home, id)).toBeNull();
    await setup.dispose();
  });

  test('/quit mid-turn: the answer stops, its partial is kept, the lock is released, the terminal reset', async () => {
    rig = await tuiRig(calls([{ text: 'Начало ' }, { pause: 'p' }, { text: 'конец.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Mira › Начало');
    expect(readLock(rig.home, rig.session.id)).not.toBeNull();
    await rig.send('/quit');
    expect(await rig.done).toBe(0);
    expect(rig.setup.renderer.isDestroyed).toBe(true);
    expect(readLock(rig.home, rig.session.id)).toBeNull();
    expect(rig.out()).toBe(RESET);
    expect(rig.err()).toBe('');
    const head = rig.session.view().path.at(-1)!;
    expect([messageText(head), head.gen?.finish]).toEqual(['Начало ', 'stopped']);
  });
});

// ---- keys -------------------------------------------------------------------------------------------------

/** A Ctrl+letter as a kitty terminal on a Russian layout sends it: the Cyrillic key, the Latin base key. */
const ctrlRu = (cyrillic: string, latin: string): string => `\x1b[${cyrillic.codePointAt(0)}::${latin.codePointAt(0)};5u`;

describe('hotkeys on a Russian layout (kitty baseCode)', () => {
  test('ctrl+к swipes, ctrl+щ continues, ctrl+в shows the Director, ctrl+п prefills /regen, ctrl+у edits in place', async () => {
    rig = await tuiRig(calls([{ text: 'Первый.' }], [{ text: 'Второй.' }], [{ text: ' И дальше.' }]), { width: 130, height: 34 });
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    await rig.until('swipe 1/1');
    await rig.setup.mockInput.pressKeys([ctrlRu('к', 'r')]);
    await rig.until('Mira › Второй.');
    await rig.until('swipe 2/2');
    await rig.setup.mockInput.pressKeys([ctrlRu('щ', 'o')]);
    await rig.until('Второй. И дальше.');
    expect(messageText(rig.session.view().path.at(-1)!)).toBe('Второй. И дальше.');
    await rig.setup.mockInput.pressKeys([ctrlRu('в', 'd')]);
    await rig.until('The Director has not planned yet');
    await rig.type('мягче');
    await rig.setup.mockInput.pressKeys([ctrlRu('п', 'g')]);
    await rig.frame();
    expect(rig.input()).toBe('/regen мягче');
    rig.setup.mockInput.pressEscape();
    await rig.frame();
    expect(rig.input()).toBe('');
    await rig.setup.mockInput.pressKeys([ctrlRu('у', 'e')]);
    await rig.until('edit ›');
    expect(rig.input()).toBe('Второй. И дальше.');
    // ctrl+с is Ctrl+C: it cancels the edit as the Repl's rules say.
    await rig.setup.mockInput.pressKeys([ctrlRu('с', 'c')]);
    await rig.until('edit cancelled');
    // The typed letters of the layout itself still reach the input.
    await rig.type('кщву');
    expect(rig.input()).toBe('кщву');
  });

  // T-17: the mouse wheel is ON by default (with reporting off terminals turn the wheel into ↑/↓); F3 turns it off.
  test('F3 turns wheel scrolling off and on (the Models pane says so); F2 hides and shows both side panes', async () => {
    rig = await tuiRig(calls(), { width: 130, height: 34 });
    let f = await rig.until('Hello, Levi');
    const f3 = (frame: string): string => lines(leftPane(frame)).find((r) => r.startsWith('F3 ')) ?? '';
    expect(f3(f)).toMatch(/ on$/);
    expect(rig.setup.renderer.useMouse).toBe(true);
    await rig.setup.mockInput.pressKeys(['F3']);
    for (let k = 0; k < 200 && !/ off$/.test(f3(f)); k++) f = await rig.frame();
    expect(f3(f)).toMatch(/ off$/);
    expect(rig.setup.renderer.useMouse).toBe(false);
    await rig.setup.mockInput.pressKeys(['F3']);
    for (let k = 0; k < 200 && !/ on$/.test(f3(f)); k++) f = await rig.frame();
    expect(f3(f)).toMatch(/ on$/);
    expect(rig.setup.renderer.useMouse).toBe(true);
    await rig.setup.mockInput.pressKeys(['F2']);
    f = await rig.gone('Agents');
    expect(rowsOf(f)[0]!.startsWith('┌─ Chat ')).toBe(true);
    expect(f).not.toContain('Models');
    await rig.setup.mockInput.pressKeys(['F2']);
    await rig.until('Agents');
  });
});

// ---- NO_COLOR ---------------------------------------------------------------------------------------------

describe('NO_COLOR', () => {
  test('the monochrome theme: no theme colour anywhere on screen, the attributes stay', async () => {
    rig = await tuiRig(calls([{ text: 'Карта *шуршит* готова.' }]), { width: 130, env: { NO_COLOR: '1' } });
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    await rig.until('swipe 1/1');
    // T-12: the mono theme has no palette colours, so no span may carry an indexed (or rgb) colour.
    for (const line of rig.setup.captureSpans().lines) {
      for (const sp of line.spans) {
        if (sp.fg.intent !== 'default' || sp.bg.intent !== 'default') throw new Error(`a colour on ${JSON.stringify(sp.text)}: ${sp.fg.intent}/${sp.bg.intent}`);
      }
    }
    expect(spanWith(rig, 'шуршит')!.attributes & TextAttributes.ITALIC).toBeTruthy();
    expect(spanWith(rig, 'Narrator')!.attributes & TextAttributes.BOLD).toBeTruthy();
  });
});

// ---- a long story ------------------------------------------------------------------------------------------

describe('a long session', () => {
  test('2 000 messages: opens in bounded renderables and streams with cheap frames', async () => {
    const home = tmpHome('rp-core-tui-');
    const e = await Engine.open({ home, clock: fakeClock() });
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const id = s.id;
    let parent = s.view().head!;
    await s.close();
    await e.close();
    writeRaw(home, id, (log) => {
      for (let i = 1; i <= 2000; i++) {
        const mid = (0x10000000 + i).toString(16);
        const user = i % 2 === 1;
        log.append(
          {
            t: 'msg',
            ts: '2026-10-26T12:00:00.000Z',
            id: mid,
            parent,
            role: user ? 'user' : 'assistant',
            ...(user ? {} : { gen: { kind: 'model' as const, connection: 'script', model: 'default', finish: 'end' as const, ms: 1200 } }),
            blocks: [{ k: 'text' as const, text: `${i}: *она идёт* дальше по дороге, и ветер несёт песок в каждый мешок.` }],
          },
          { durable: false },
        );
        parent = mid;
      }
    });
    const pieces: ScriptStep[] = Array.from({ length: 80 }, (_, i) => [{ delay: 1 }, { text: `слово${i} ` }] as ScriptStep[]).flat();
    const t0 = performance.now();
    rig = await tuiRig(calls([{ text: 'Начало. ' }, { pause: 'p' }, ...pieces]), { home, sessionId: id, width: 120, height: 40 });
    await rig.until('Mira › 2000: она идёт');
    const openMs = performance.now() - t0;
    expect(count(await rig.frame(), '2000: ')).toBe(1);
    const transcript = rig.setup.renderer.root.findDescendantById('transcript') as unknown as { content: { getChildren(): unknown[] } };
    const mounted = transcript.content.getChildren().length;
    // The newest entries as their own renderables, the rest in archive blocks of ARCHIVE_BLOCK.
    expect(mounted).toBeLessThanOrEqual(LAYOUT.liveCards + ARCHIVE_BLOCK + Math.ceil(3000 / ARCHIVE_BLOCK));
    await rig.send('дальше');
    await rig.until('Mira › Начало.');
    rig.provider.release('p');
    // Every frame while the 80 words stream in (one per millisecond or so).
    const frames: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = performance.now();
      await rig.setup.renderOnce();
      frames.push(performance.now() - a);
      if (rig.setup.captureCharFrame().includes('слово79')) break;
      await sleep(1);
    }
    await rig.gone('answering…');
    frames.sort((a, b) => a - b);
    const median = frames[Math.floor(frames.length / 2)]!;
    const worst = frames.at(-1)!;
    console.log(`2 000 messages: open ${openMs.toFixed(0)} ms, ${mounted} renderables, ${frames.length} streaming frames: median ${median.toFixed(2)} ms, max ${worst.toFixed(2)} ms`);
    expect(frames.length).toBeGreaterThan(10);
    if (PERF) {
      expect(median).toBeLessThan(16);
      expect(worst).toBeLessThan(100);
      expect(openMs).toBeLessThan(3000);
    }
  }, 30_000);

  test('5 000 messages of 800 characters: only the newest part is built on open; Ctrl+Home brings the rest', async () => {
    const home = tmpHome('rp-core-tui-');
    const e = await Engine.open({ home, clock: fakeClock() });
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const id = s.id;
    let parent = s.view().head!;
    await s.close();
    await e.close();
    const n = 5000;
    const body = '*она идёт* дальше по дороге, и ветер несёт песок в каждый мешок. '.repeat(13).slice(0, 800);
    writeRaw(home, id, (log) => {
      for (let i = 1; i <= n; i++) {
        const mid = (0x10000000 + i).toString(16);
        const user = i % 2 === 1;
        log.append(
          {
            t: 'msg',
            ts: '2026-10-26T12:00:00.000Z',
            id: mid,
            parent,
            role: user ? 'user' : 'assistant',
            ...(user ? {} : { gen: { kind: 'model' as const, connection: 'script', model: 'default', finish: 'end' as const, ms: 1200 } }),
            blocks: [{ k: 'text' as const, text: `${i}: ${user ? 'Я иду.' : body}` }],
          },
          { durable: false },
        );
        parent = mid;
      }
    });
    Bun.gc(true);
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    rig = await tuiRig(calls(), { home, sessionId: id, width: 120, height: 40 });
    let f = await rig.until(`Mira › ${n}: она идёт`);
    const openMs = performance.now() - t0;
    Bun.gc(true);
    const rssMb = (process.memoryUsage().rss - rss0) / 1e6;
    console.log(`5 000 messages × 800 chars: open ${openMs.toFixed(0)} ms, +${rssMb.toFixed(0)} MB RSS`);
    const transcript = rig.setup.renderer.root.findDescendantById('transcript') as unknown as { content: { getChildren(): { plainText?: string }[] } };
    const children = transcript.content.getChildren();
    // The count row, HISTORY_BATCH messages in archive blocks, the newest entries.
    expect(children.length).toBeLessThanOrEqual(1 + Math.ceil((HISTORY_BATCH * 1.5) / ARCHIVE_BLOCK) + 1 + LAYOUT.liveCards + 1);
    const built = children.map((c) => c.plainText ?? '').join('\n');
    expect(built.length).toBeLessThan((HISTORY_BATCH + LAYOUT.liveCards) * 900);
    // Ctrl+Home: the count row at the top, then a batch more each time.
    rig.setup.mockInput.pressKey('HOME', { ctrl: true });
    f = await rig.until('earlier messages · Ctrl+Home loads more');
    const waiting = Number(/⋯ (\d+) earlier messages/.exec(f)![1]);
    expect(waiting).toBeGreaterThan(n - 2 * HISTORY_BATCH - LAYOUT.liveCards);
    expect(waiting).toBeLessThan(n - 2 * HISTORY_BATCH);
    if (PERF) {
      expect(openMs).toBeLessThan(1500);
      expect(rssMb).toBeLessThan(150);
    }
  }, 30_000);
});
