// The side panes on a headless renderer (TUI T-5, T-8): the models pane's rows (Cyrillic names, long
// model ids cut with an ellipsis, the --provider override, the Director off and on, the keys), the
// agents pane's rows (tool calls with durations, the Director planned / failed / off, usage at the
// bottom), colours and NO_COLOR, widths that follow the laid-out box, reset(), and both panes fed by a
// real Repl through its view port (a Director turn on the scripted provider).
import { afterEach, describe, expect, test } from 'bun:test';
import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextareaRenderable, TextRenderable } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, SessionHandle } from '../../src/engine/api.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { runReplWith } from '../../src/cli/repl.ts';
import { journalOf } from '../../src/cli/repl-journal.ts';
import { labels } from '../../src/cli/repl-render.ts';
import type { BannerInfo, ReplView, ReplViewContext } from '../../src/cli/repl-view.ts';
import { agentsLines, createAgentsPane, fitLine, linesText, PANE_TEXT_WIDTH } from '../../src/cli/tui/agents-pane.ts';
import { initialAgents, recordAt, reduceAgents } from '../../src/cli/tui/agents.ts';
import { newlineKey } from '../../src/cli/tui/keys.ts';
import { createModelsPane, keyRows, modelsLines, windowText } from '../../src/cli/tui/models-pane.ts';
import { MONO_THEME, THEME } from '../../src/cli/tui/theme.ts';
import { HOTKEYS, LAYOUT, type Ui } from '../../src/cli/tui/types.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import { createScriptedProvider } from '../../src/providers/scripted.ts';
import { DEFAULT_SESSION_CONFIG, type Entry, type SessionConfig, type SessionHeader } from '../../src/session/entries.ts';
import { recordFor, richState } from '../cli-m4/fixtures.ts';
import { dirCall, dirConfig, fullCaps } from '../engine-m4/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { CONFIG, entriesOf, typedInput } from '../repl/kit.ts';
import { until } from '../engine/kit.ts';

// ---- a host-like layout ----------------------------------------------------------------------------

let setup: TestRendererSetup | undefined;
afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

async function layout(width = 120, height = 40, pad = 1): Promise<Ui> {
  setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  const r = setup.renderer;
  const root = new BoxRenderable(r, { flexDirection: 'row', width: '100%', height: '100%' });
  const left = new BoxRenderable(r, { width: LAYOUT.left, flexShrink: 0, border: true, title: ' Models ', flexDirection: 'column', paddingX: pad });
  const middle = new BoxRenderable(r, { flexGrow: 1, minWidth: LAYOUT.middleMin, border: true, title: ' Chat ', flexDirection: 'column' });
  const right = new BoxRenderable(r, { width: LAYOUT.right, flexShrink: 0, border: true, title: ' Agents ', flexDirection: 'column', paddingX: pad });
  const transcript = new ScrollBoxRenderable(r, { flexGrow: 1, stickyScroll: true, stickyStart: 'bottom' });
  const status = new TextRenderable(r, { content: '', height: 1 });
  const input = new TextareaRenderable(r, { height: 1 });
  middle.add(transcript);
  middle.add(status);
  middle.add(input);
  root.add(left);
  root.add(middle);
  root.add(right);
  r.root.add(root);
  return { renderer: r, left, middle, right, transcript, status, input };
}

/** The rows inside a box of the frame: columns [from, from + width) without the borders and padding. */
function rows(frame: string, from: number, width: number, pad = 1): string[] {
  const lines = frame.replace(/\n+$/, '').split('\n');
  return lines.slice(1, lines.length - 1).map((l) => [...l].slice(from + 1 + pad, from + width - 1 - pad).join('').trimEnd());
}
const trimTail = (r: string[]): string[] => {
  const out = [...r];
  while (out.length > 0 && out.at(-1) === '') out.pop();
  return out;
};
const leftRows = (frame: string, pad = 1): string[] => trimTail(rows(frame, 0, LAYOUT.left, pad));
const rightRows = (frame: string, total = 120, pad = 1): string[] => rows(frame, total - LAYOUT.right, LAYOUT.right, pad);

async function frame(): Promise<string> {
  await setup!.renderOnce();
  // A pane that saw its real width in a frame redraws for the next one.
  await setup!.renderOnce();
  return setup!.captureCharFrame();
}

// ---- banner facts ------------------------------------------------------------------------------------

const TS = '2026-10-26T12:00:00.000Z';
function bannerOf(over: Partial<BannerInfo> = {}, config: SessionConfig = DEFAULT_SESSION_CONFIG): BannerInfo {
  const header: SessionHeader = {
    t: 'session',
    v: 1,
    id: 's_4fa2',
    created: TS,
    title: 'Фонари над рекой',
    cast: { character: { name: 'Мира', description: '', greetings: ['Привет.'] }, persona: { name: 'Леви', description: '' } },
    config,
  };
  return {
    session: { id: 's_4fa2' } as SessionHandle,
    header,
    names: labels('Мира'),
    config,
    journal: journalOf(header, []),
    narrator: { conn: 'openrouter', model: 'anthropic/claude-sonnet-4.5-20260901' },
    window: 16384,
    tools: 'native',
    director: null,
    ...over,
  };
}

/** The key rows in 24 columns (T-15): one row each, the descriptions in one column. */
const KEYS = [
  'Enter      send',
  'Alt+Enter  new line',
  'Ctrl+C     stop / quit',
  'Ctrl+R     swipe',
  'Ctrl+G     guided reroll',
  'Ctrl+O     continue',
  'Ctrl+E     edit last',
  'Alt+←/→    versions',
  'PgUp/PgDn  scroll',
  'C-Home/End top/bottom',
  'Ctrl+D     Director',
  'F1         help',
  'F2         side panes',
  'F3         mouse: off',
  'Shift+drag select',
  'Esc        cancel/clear',
];

describe('the models pane', () => {
  test('Cyrillic session and names, a long model id cut with an ellipsis, the Director off, every key on one row', async () => {
    const ui = await layout();
    const pane = createModelsPane(ui, THEME);
    pane.update(bannerOf(), { newlineKey: newlineKey(false), mouse: false });
    const f = await frame();
    expect(f.split('\n')[0]).toStartWith('┌─ Models ─');
    expect(leftRows(f)).toEqual([
      'Фонари над рекой',
      'Мира · you: Леви',
      '',
      'Narrator',
      'openrouter:anthropic/cl…',
      'ctx 16k · tools native',
      '',
      'Director · off',
      '',
      ...KEYS,
    ]);
  });

  test('the Director on (follows the narrator, the profile of the last plan), the script override, a window known only by its cap', async () => {
    const ui = await layout();
    const pane = createModelsPane(ui, THEME);
    const config: SessionConfig = { ...DEFAULT_SESSION_CONFIG, director: { ...DEFAULT_SESSION_CONFIG.director, enabled: true, style: 'the-slow-burn' } };
    const b = bannerOf(
      {
        narrator: { conn: 'script', model: 'default' },
        window: null,
        cap: 4096,
        tools: 'none',
        director: { conn: 'script', model: 'default', follows: true, profile: 'auto' },
        override: { conn: 'script', plays: 'script', windowOf: () => null },
      },
      config,
    );
    pane.update(b, { newlineKey: 'Shift+Enter', mouse: true, record: recordFor(richState(), { profile: 'lite' }) });
    const r = leftRows(await frame());
    expect(r.slice(0, 15)).toEqual([
      'Фонари над рекой',
      'Мира · you: Леви',
      '',
      'Narrator',
      'script:default',
      'ctx ≤4k · tools off',
      '(script)',
      '',
      'Director',
      'script:default',
      'follows narrator',
      'profile lite',
      'style the-slow-burn',
      '',
      'Enter      send',
    ]);
    expect(r).toContain('Shift+Enter new line');
    expect(r).toContain('F3         mouse: on');
    // Without a record: the configured profile; a Director of its own; a recording.
    pane.update(
      { ...b, director: { conn: 'big', model: 'judge-70b', follows: false, profile: 'full' }, override: { conn: 'rec', plays: 'recording', windowOf: () => null } },
      { newlineKey: 'Ctrl+J', mouse: false },
    );
    const r2 = leftRows(await frame());
    expect(r2.slice(6, 12)).toEqual(['(recording)', '', 'Director', 'big:judge-70b', 'profile full', 'style the-slow-burn']);
  });

  test('an untitled session shows its id; no persona; a long Cyrillic title is cut', () => {
    const b = bannerOf();
    const untitled = { ...b, header: { ...b.header, title: undefined, cast: { character: { name: 'Мира', description: '', greetings: [] } } } } as BannerInfo;
    const lines = modelsLines(untitled, { newlineKey: 'Ctrl+J', mouse: false }, 24).map((l) => l.map((s) => s.text).join(''));
    expect(lines.slice(0, 2)).toEqual(['s_4fa2', 'Мира']);
    const long = { ...b, header: { ...b.header, title: 'Очень длинное название сессии про фонари' } } as BannerInfo;
    expect(linesText(modelsLines(long, { newlineKey: 'Ctrl+J', mouse: false }, 24)).split('\n')[0]).toBe('Очень длинное название…');
  });

  test('windows in the banner\'s words', () => {
    expect([windowText(16384), windowText(8192), windowText(200_000), windowText(131_072), windowText(12_345), windowText(900), windowText(null, 4096), windowText(null)]).toEqual([
      '16k',
      '8k',
      '200k',
      '128k',
      '12k',
      '900',
      '≤4k',
      '?',
    ]);
  });

  test('the width follows the laid-out box (a host without padding gets two more columns)', async () => {
    const ui = await layout(120, 40, 0);
    const pane = createModelsPane(ui, THEME);
    pane.update(bannerOf(), { newlineKey: 'Ctrl+J', mouse: false });
    const r = leftRows(await frame(), 0);
    expect(r[4]).toBe('openrouter:anthropic/clau…');
    expect(r).toContain('Ctrl+R     swipe');
  });

  test('T-15: every key is one row and every description starts in the same column, under kitty (Shift+Enter) too', async () => {
    const shown = (kitty: boolean, width: number): string[] => {
      const all = linesText(modelsLines(bannerOf(), { newlineKey: newlineKey(kitty), mouse: kitty }, width)).split('\n');
      return all.slice(all.indexOf('Enter') >= 0 ? all.indexOf('Enter') : all.findIndex((l) => l.startsWith('Enter ')));
    };
    for (const kitty of [false, true]) {
      const rows = shown(kitty, PANE_TEXT_WIDTH.left);
      // One row per key: Enter, the newline key, Ctrl+C, then HOTKEYS (+ Shift+drag after F3, T-17); no
      // row cut, none wider than the pane.
      expect(rows).toHaveLength(3 + HOTKEYS.length + 1);
      const pairs = keyRows({ newlineKey: newlineKey(kitty), mouse: kitty });
      rows.forEach((row, i) => {
        const [label, description] = pairs[i]!;
        expect(row.startsWith(label)).toBe(true);
        expect(row.endsWith(` ${description}`)).toBe(true);
        expect(Bun.stringWidth(row)).toBeLessThanOrEqual(PANE_TEXT_WIDTH.left);
        expect(row).not.toContain('…');
        // The description column: 11 (labels are at most 10 wide); only a wider label pushes it.
        const at = Bun.stringWidth(row) - Bun.stringWidth(description);
        expect(at).toBe(Bun.stringWidth(label) >= 11 ? Bun.stringWidth(label) + 1 : 11);
      });
    }
    expect(shown(true, 24)[1]).toBe('Shift+Enter new line');
    // With two more columns the kitty label fits the column as well: all aligned at 12.
    const wide = shown(true, 26);
    expect(wide.map((r, i) => Bun.stringWidth(r) - Bun.stringWidth(keyRows({ newlineKey: 'Shift+Enter', mouse: true })[i]![1]))).toEqual(wide.map(() => 12));
    // The HOTKEYS limits the rows rely on (types.ts): label ≤ 10, description ≤ 13 columns.
    for (const h of HOTKEYS) {
      expect(Bun.stringWidth(h.label)).toBeLessThanOrEqual(10);
      expect(Bun.stringWidth(h.description)).toBeLessThanOrEqual(13);
    }
  });

  test('a session titled after its character shows the name once (the live run\'s "Narrator / Narrator")', () => {
    const b = bannerOf();
    const named = (title: string | undefined, character: string, persona?: string): string[] => {
      const cast = { character: { name: character, description: '', greetings: [] }, ...(persona ? { persona: { name: persona, description: '' } } : {}) };
      const banner = { ...b, header: { ...b.header, title, cast } } as BannerInfo;
      return linesText(modelsLines(banner, { newlineKey: 'Alt+Enter', mouse: false }, 24)).split('\n').slice(0, 3);
    };
    expect(named('Narrator', 'Narrator')).toEqual(['Narrator', '', 'Narrator']);
    expect(named(' narrator ', 'Narrator', 'Леви')).toEqual(['Narrator · you: Леви', '', 'Narrator']);
    // A different title keeps its own row.
    expect(named('Фонари', 'Мира')).toEqual(['Фонари', 'Мира', '']);
    // The single row is the character's (its colour), not the bold title.
    const once = modelsLines({ ...b, header: { ...b.header, title: 'Мира' } } as BannerInfo, { newlineKey: 'Alt+Enter', mouse: false }, 24);
    expect(once[0]).toEqual([
      { text: 'Мира', tone: 'char' },
      { text: ' · you: ', tone: 'dim' },
      { text: 'Леви', tone: 'user' },
    ]);
  });

  test('T-16: the title, the names and the model ids are sanitised (whole escape sequences go; Warp drops ZWJ / VS16)', async () => {
    const b = bannerOf();
    const dirty = {
      ...b,
      header: {
        ...b.header,
        title: 'Фонари\x1b[31m над\x1b]0;pwned\x07 рекой',
        cast: { character: { name: 'Mira\x1b[1m 👨\u200d👩\u200d👧', description: '', greetings: [] }, persona: { name: 'Леви\u2028the Bold', description: '' } },
      },
      narrator: { conn: 'or\x9b2J', model: 'evil\x1b[2Jmodel' },
      director: { conn: 'big', model: 'judge\x1bP1;2|secret\x1b\\-70b', follows: false, profile: 'full' },
    } as BannerInfo;
    const plain = linesText(modelsLines(dirty, { newlineKey: 'Alt+Enter', mouse: false }, 40)).split('\n');
    expect(plain.slice(0, 2)).toEqual(['Фонари над рекой', 'Mira 👨\u200d👩\u200d👧 · you: Леви the Bold']);
    expect(plain[4]).toBe('or:evilmodel');
    expect(plain).toContain('big:judge-70b');
    const warp = linesText(modelsLines(dirty, { newlineKey: 'Alt+Enter', mouse: false }, 40, { warp: true })).split('\n');
    expect(warp[1]).toBe('Mira 👨👩👧 · you: Леви the Bold');
    // The pane itself: the Warp flag reaches it; nothing of a sequence is on screen.
    const ui = await layout();
    const pane = createModelsPane(ui, THEME, { warp: true });
    pane.update(dirty, { newlineKey: 'Alt+Enter', mouse: false });
    const f = await frame();
    const left = leftRows(f);
    expect(left[0]).toBe('Фонари над рекой');
    // (Wide glyphs: compare the frame's row as a whole, the column slicing counts code points.)
    expect(f.split('\n')[2]).toStartWith('│ Mira 👨👩👧 · you: Леви… │');
    expect(f).not.toContain('[31m');
    expect(f).not.toContain('pwned');
    expect(f).not.toContain('\u200d');
  });
});

// ---- the agents pane ----------------------------------------------------------------------------------

const T0 = Date.parse(TS);
const ev = (body: EventBody, sec = 0, sessionId = 's_1'): Event => ({ sessionId, ts: new Date(T0 + sec * 1000).toISOString(), ...body }) as Event;
const clock = (): Date => new Date('2026-10-27T00:00:00.000Z');

/** A journal whose head carries a Director record (richState: chapter 2, 2 live arcs, 1 seed due). */
function journalWithRecord(over: Parameters<typeof recordFor>[1] = {}): ReturnType<typeof journalOf> {
  const header = bannerOf().header;
  const entries = [
    { t: 'msg', seq: 1, ts: TS, id: 'u1', parent: null, role: 'user', blocks: [{ k: 'text', text: 'Hi' }] },
    {
      t: 'msg',
      seq: 2,
      ts: TS,
      id: 'a1',
      parent: 'u1',
      role: 'assistant',
      blocks: [{ k: 'text', text: 'Hello' }],
      gen: { kind: 'model', connection: 'script', model: 'default', finish: 'end', usage: { inputTotal: 1200, outputTotal: 300 }, ms: 13_300, rounds: 1, transport: 'native' },
      dir: recordFor(richState(), over),
    },
  ] as Entry[];
  return journalOf(header, entries);
}
const DIR_ON: SessionConfig = { ...DEFAULT_SESSION_CONFIG, director: { ...DEFAULT_SESSION_CONFIG.director, enabled: true } };
const PRICES = { 'script:default': { inPerM: 1, outPerM: 2 } };

describe('the agents pane', () => {
  test('a turn in flight: the narrator\'s tool calls newest first with durations, the Director planned, usage at the bottom', async () => {
    const ui = await layout();
    const pane = createAgentsPane(ui, THEME, clock);
    pane.refresh(journalWithRecord(), 'a1', DIR_ON, PRICES);
    for (const e of [
      ev({ type: 'start', turnId: 't1', kind: 'reply', messageId: 'm1', parentId: 'a1' }),
      ev({ type: 'director', turnId: 't1', status: 'planning' }, 1),
      ev({ type: 'director', turnId: 't1', status: 'planned', summary: 'arcs +1 · seeds +1 · chapter 1' }, 3),
      ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'search_history', phase: 'start', args: { query: 'брат' } }, 4),
      ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'search_history', phase: 'done', args: { query: 'брат' }, ok: true, summary: '2 hits' }, 4.4),
      ev({ type: 'tool', turnId: 't1', callId: 'c2', name: 'read_lore', phase: 'start', args: { ids: ['L1', 'L3'] } }, 5),
    ]) {
      pane.event(e);
    }
    const f = await frame();
    expect(f.split('\n')[0]).toEndWith('┌─ Agents ─────────────────────────┐');
    const r = rightRows(f);
    expect(r.slice(0, 15)).toEqual([
      'Narrator · tool read_lore',
      '  ⋯ read_lore ids=L1,L3 …',
      '  ⋯ search_history "брат… · 0.4s',
      '  last 300 tok · 13.3s · end',
      '  1 round · tools native',
      '',
      'Director · planned · 2.0s',
      '  arcs +1 · seeds +1 · chapter 1',
      '  turn 40 · full · structured',
      '  script:default',
      '  structured ok · 0.9s · 300 tok',
      '  chapter 2 "The Flood"',
      '  2 live arcs · 1 seed due',
      '',
      '',
    ]);
    // Usage sits on the last rows: 1 narrator generation priced from the table.
    expect(r.slice(-3)).toEqual(['Usage', '  1 call · 1200 in · 300 out', '  cost $0.0018']);
  });

  test('colours: bold accent names, dim details, yellow seeds due, red failures; NO_COLOR keeps attributes only', async () => {
    const ui = await layout();
    const pane = createAgentsPane(ui, THEME, clock);
    pane.refresh(journalWithRecord(), 'a1', DIR_ON, PRICES);
    pane.event(ev({ type: 'start', turnId: 't1', kind: 'reply', messageId: 'm1', parentId: 'a1' }));
    pane.event(ev({ type: 'director', turnId: 't1', status: 'failed', reason: 'timeout' }));
    pane.event(ev({ type: 'failed', turnId: 't1', category: 'server', code: 'server_error', message: 'x', draft: '' }));
    await frame();
    const spans = setup!.captureSpans();
    const find = (text: string) => spans.lines.flatMap((l) => l.spans).find((s) => s.text.includes(text))!;
    expect(rightRows(setup!.captureCharFrame())[0]).toBe('Narrator · failed (server_error)');
    expect(find('Narrator').fg.equals(THEME.accent)).toBe(true);
    expect(find('Narrator').attributes & TextAttributes.BOLD).toBeTruthy();
    expect(find('failed (server_error)').fg.equals(THEME.red)).toBe(true);
    expect(find('failed (timeout)').fg.equals(THEME.red)).toBe(true);
    // Dim (T-12): the DIM attribute on the terminal's default foreground, no grey.
    expect(find('turn 40').fg.equals(THEME.text)).toBe(true);
    expect(find('turn 40').attributes & TextAttributes.DIM).toBeTruthy();
    expect(find('1 seed due').fg.equals(THEME.yellow)).toBe(true);
    await setup!.dispose();

    const mono = await layout();
    const plain = createAgentsPane(mono, MONO_THEME, clock);
    plain.refresh(journalWithRecord(), 'a1', DIR_ON, PRICES);
    plain.event(ev({ type: 'start', turnId: 't1', kind: 'reply', messageId: 'm1', parentId: 'a1' }));
    plain.event(ev({ type: 'failed', turnId: 't1', category: 'server', code: 'server_error', message: 'x', draft: '' }));
    await frame();
    const monoSpans = setup!.captureSpans().lines.flatMap((l) => l.spans);
    const failed = monoSpans.find((s) => s.text.includes('failed (server_error)'))!;
    expect(failed.fg.equals(THEME.red)).toBe(false);
    expect(failed.fg.intent).toBe('default');
    expect(failed.attributes & TextAttributes.BOLD).toBeTruthy();
    expect(monoSpans.find((s) => s.text.includes('turn 40'))!.attributes & TextAttributes.DIM).toBeTruthy();
  });

  test('the Director off, then a failed record; the M5 agents as generic blocks', async () => {
    const ui = await layout();
    const pane = createAgentsPane(ui, THEME, clock);
    pane.refresh(journalWithRecord(), 'a1', DEFAULT_SESSION_CONFIG, {});
    let r = rightRows(await frame());
    expect(r.slice(0, 7)).toEqual(['Narrator · idle', '  last 300 tok · 13.3s · end', '  1 round · tools native', '', 'Director · off', '', '']);
    expect(r.slice(-3)).toEqual(['Usage', '  1 call · 1200 in · 300 out', '  cost unknown']);

    pane.refresh(journalWithRecord({ ok: false, code: 'no_output', directive: undefined, transport: undefined, profile: undefined, model: undefined, attempts: [{ transport: 'tagged', outcome: 'no_output', ms: 2500 }] }), 'a1', DIR_ON, {});
    pane.event(ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'started' }, 1));
    pane.event(ev({ type: 'agent', agent: 'recall', turnId: 't1', status: 'recalled', count: 3, source: 'lexical' }, 1.5));
    pane.event(ev({ type: 'agent', agent: 'historian', status: 'parked', reason: 'the narrator is busy' }, 2));
    r = rightRows(await frame());
    expect(r.slice(4, 18)).toEqual([
      'Director · failed (no_output)',
      '  turn 40',
      '  tagged no_output · 2.5s',
      '  chapter 2 "The Flood"',
      '  2 live arcs · 1 seed due',
      '',
      'Recall · recalled (3)',
      '  lexical · 0.5s',
      '',
      'Historian · parked',
      '  the narrator is busy',
      '',
      '',
      '',
    ]);
  });

  test('a long summary and long tool lines are cut, never wrapped; every row keeps the border', async () => {
    const ui = await layout();
    const pane = createAgentsPane(ui, THEME, clock);
    pane.refresh(journalWithRecord(), 'a1', DIR_ON, PRICES);
    pane.event(ev({ type: 'director', turnId: 't1', status: 'planned', summary: 'arcs +12 ~3 · seeds +4 ~2 -1 · hidden +1 ~1 · chapter 12' }));
    pane.event(ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'search_history', phase: 'start', args: { query: 'очень длинный запрос\nс переводом строки' } }));
    const f = await frame();
    const r = rightRows(f);
    expect(r[1]).toBe('  ⋯ search_history "очень длинн…');
    expect(r.find((l) => l.startsWith('  arcs'))).toBe('  arcs +12 ~3 · seeds +4 ~2 -1…');
    for (const line of f.replace(/\n+$/, '').split('\n').slice(1, -1)) expect(line.endsWith('│')).toBe(true);
  });

  test('T-16: model strings in the agents pane are sanitised (tool args, Director summary, memory names, reasons); Warp drops ZWJ', async () => {
    const events = [
      ev({ type: 'start', turnId: 't1', kind: 'reply', messageId: 'm1', parentId: 'a1' }),
      ev({ type: 'director', turnId: 't1', status: 'planned', summary: 'arcs +1\x1b[5m · seeds\u2028+1' }, 1),
      ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'note', phase: 'start', args: { title: 'x', body: 'Red \x1b[31mALERT\x1b[0m' } }, 2),
      ev({ type: 'memory', change: 'arc', ref: 'n1', kind: 'x', name: 'Ян \x1b]0;pwned\x07👨\u200d👩\u200d👧', by: 'filing' }, 3),
      ev({ type: 'agent', agent: 'historian', status: 'parked', reason: 'busy\x1bPq#1\x1b\\ now' }, 4),
    ];
    const ui = await layout();
    const pane = createAgentsPane(ui, THEME, clock, { warp: true });
    pane.refresh(journalWithRecord(), 'a1', DIR_ON, PRICES);
    for (const e of events) pane.event(e);
    const f = await frame();
    const r = rightRows(f);
    expect(r[1]).toBe('  ⋯ note "x" body=Red ALERT …');
    expect(r).toContain('  arcs +1 · seeds +1');
    expect(r).toContain('  busy now');
    expect(f).toContain('memory: arc x "Ян 👨👩👧"');
    for (const bad of ['[31m', '[0m', 'pwned', '[5m', 'q#1', '\u200d']) expect(f).not.toContain(bad);
    // The pure lines: without Warp the ZWJ stays (the family is one glyph there).
    let state = initialAgents();
    for (const e of events) state = reduceAgents(state, e, clock());
    expect(linesText(agentsLines(state, 60))).toContain('memory: arc x "Ян 👨\u200d👩\u200d👧"');
    expect(linesText(agentsLines(state, 60, { warp: true }))).toContain('memory: arc x "Ян 👨👩👧"');
  });

  test('reset(): the live state is gone and events of another session are ignored', async () => {
    const ui = await layout();
    const pane = createAgentsPane(ui, THEME, clock);
    pane.event(ev({ type: 'start', turnId: 't1', kind: 'reply', messageId: 'm1', parentId: 'u1' }));
    pane.event(ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'search_history', phase: 'start' }));
    expect(rightRows(await frame())[0]).toBe('Narrator · tool search_history');
    pane.reset('s_2');
    pane.event(ev({ type: 'start', turnId: 't9', kind: 'reply', messageId: 'm9', parentId: 'u1' }, 0, 's_1'));
    let r = rightRows(await frame());
    expect(r.slice(0, 4)).toEqual(['Narrator · idle', '', 'Director · off', '']);
    expect(r.slice(-2)).toEqual(['Usage', '  no model calls yet']);
    pane.event(ev({ type: 'start', turnId: 't2', kind: 'reply', messageId: 'm2', parentId: 'u1' }, 0, 's_2'));
    r = rightRows(await frame());
    expect(r[0]).toBe('Narrator · waiting…');
  });

  test('fitLine cuts by terminal columns (wide characters count two) and sanitises: whole sequences go, line breaks are spaces', () => {
    expect(fitLine([{ text: '漢字かな漢字', tone: 'text' }], 7)).toEqual([{ text: '漢字か…', tone: 'text' }]);
    expect(fitLine([{ text: 'a\x1b[31mb\tc', tone: 'dim' }], 20)).toEqual([{ text: 'ab  c', tone: 'dim' }]);
    expect(fitLine([{ text: 'one\ntwo\u2028three\u2029four\x1b]8;;http://x\x07link', tone: 'text' }], 40)).toEqual([{ text: 'one two three fourlink', tone: 'text' }]);
    // An emoji with ZWJ is one grapheme two columns wide: a cut never splits it.
    expect(fitLine([{ text: 'ab👨\u200d👩\u200d👧cd', tone: 'text' }], 4)).toEqual([{ text: 'ab…', tone: 'text' }]);
    expect(fitLine([{ text: 'ab👨\u200d👩\u200d👧cd', tone: 'text' }], 5)).toEqual([{ text: 'ab👨\u200d👩\u200d👧…', tone: 'text' }]);
    expect(fitLine([{ text: 'ab', tone: 'bold' }, { text: 'cdef', tone: 'dim' }], 4)).toEqual([
      { text: 'ab', tone: 'bold' },
      { text: 'c…', tone: 'dim' },
    ]);
    expect(PANE_TEXT_WIDTH).toEqual({ left: 24, right: 32 });
  });
});

// ---- both panes behind a real Repl ----------------------------------------------------------------------

describe('fed by the Repl through its view port', () => {
  test('a Director turn: the banner and idle() fill the models pane, the turn\'s events and idle() the agents pane', async () => {
    const ui = await layout();
    const models = createModelsPane(ui, THEME);
    const agents = createAgentsPane(ui, THEME, clock);
    const home = tmpHome('rp-core-tui-panes-');
    const provider = createScriptedProvider([{ steps: dirCall() }, { steps: [{ text: 'Фонарь гаснет.' }] }]);
    const caps = fullCaps();
    const conn: Connection = { id: 'script', provider, caps, origin: 'script:script', local: true };
    const engine = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(7), timeZone: 'UTC', checkpoint: { chars: 8, ms: 5, datasyncMs: 5 }, retryMaxDelayMs: 5 });
    const session = engine.createSession({ character: { name: 'Мира', description: 'Хранительница.', greetings: ['Привет.'] }, persona: { name: 'Леви', description: '' }, config: dirConfig() });
    const typed = typedInput();
    const pushed: Event[] = [];
    const extra = (b: BannerInfo) => {
      const record = recordAt(b.journal, b.session.view().head);
      return { ...(record ? { record } : {}), newlineKey: 'Ctrl+J', mouse: false };
    };
    const view = (ctx: ReplViewContext): ReplView => ({
      line: () => {},
      echo: () => {},
      message: () => {},
      status: () => {},
      banner(b) {
        agents.reset(b.session.id);
        models.update(b, extra(b));
      },
      turn() {
        let kept = false;
        return {
          push(e) {
            pushed.push(e);
            agents.event(e);
            if (e.type === 'changed' && (e.change === 'msg' || e.change === 'edit')) kept = true;
          },
          finish: () => {},
          interject: () => {},
          get kept() {
            return kept;
          },
        };
      },
      idle() {
        idles++;
        const b = ctx.bannerInfo();
        models.update(b, extra(b));
        agents.refresh(b.journal, b.session.view().head, b.config, CONFIG.prices);
      },
    });
    let idles = 0;
    const done = runReplWith(
      { engine, session, config: CONFIG, home, io: { out: memoryChannel(), err: memoryChannel() }, input: typed.input, onInterrupt: () => () => {}, color: true, capsOf: () => caps },
      { view, env: {} },
    );
    // The first idle() follows the greeting; the line's turn ends in the second (the TUI's input stays open).
    await until(() => idles >= 1);
    typed.type('Я оглядываюсь.');
    await until(() => idles >= 2);
    typed.end();
    expect(await done).toBe(0);
    expect(pushed.some((e) => e.type === 'director' && e.status === 'planned')).toBe(true);

    const f = await frame();
    const left = leftRows(f);
    const record = recordAt(journalOf(session.header(), entriesOf(home, session.id)), session.view().head)!;
    expect(record.profile).toBe('full');
    // A new session is titled after its character: the name shows once (T-15 live run).
    expect(session.header().title).toBe('Мира');
    expect(left.slice(0, 12)).toEqual([
      'Мира · you: Леви',
      '',
      'Narrator',
      'script:default',
      'ctx 32k · tools off',
      '',
      'Director',
      'script:default',
      'follows narrator',
      'profile full',
      'style the-balanced',
      '',
    ]);
    const right = rightRows(f);
    expect(right[0]).toBe('Narrator · idle');
    expect(right[1]).toMatch(/^ {2}last \d+\.\ds · end$/);
    // Durations come from the events' ts (the fake clock steps 1 s per read).
    const dir = right.findIndex((l) => /^Director · planned · \d+\.\ds$/.test(l));
    expect(dir).toBeGreaterThan(0);
    expect(right[dir + 1]).toMatch(/^ {2}arcs \+1 · seeds \+1 · chapter 1/);
    expect(right[dir + 2]).toBe('  turn 1 · full · tagged');
    expect(right).toContain('  chapter 1 "Lamps"');
    expect(right).toContain('  1 live arc · 0 seeds due');
    expect(right.slice(-3)[0]).toBe('Usage');
    // The scripted provider reports no usage: the calls are counted, the tokens are not invented.
    expect(right.slice(-3)).toEqual(['Usage', '  2 calls · usage not reported', '  cost unknown']);
    await engine.close();
  });
});
