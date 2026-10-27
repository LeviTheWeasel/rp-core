// The colours on screen (TUI decisions T-12): the whole TUI on a headless renderer, every span of
// every frame checked. Nothing may carry OpenTUI's fallback (an rgb white: a TextRenderable, a
// chunk, a blank cell, a Textarea or a scrollbar track with no colour of its own), since white text
// vanished on a light terminal theme. Plain text is the terminal's default foreground (the RGBA
// intent 'default', sent as SGR 39), dim text the DIM attribute on it, accents the terminal's ANSI
// palette (intent 'indexed', sent as `38;5;n`), every background the terminal's default (SGR 49).
// NO_COLOR: no indexed colour anywhere, only attributes.
import { afterEach, describe, expect, test } from 'bun:test';
import { TextAttributes, type CapturedSpan } from '@opentui/core';
import { MONO_THEME, THEME } from '../../src/cli/tui/theme.ts';
import { LAYOUT } from '../../src/cli/tui/types.ts';
import { SCRIPT_CAPS, type ScriptStep } from '../../src/providers/scripted.ts';
import { dirConfig, fullCaps, planOf, tagged } from '../engine-m4/kit.ts';
import { calls, tuiRig, type TuiRig, type TuiRigOptions } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

const WIDTH = 130;
const HEIGHT = 34;

interface Placed {
  sp: CapturedSpan;
  x: number;
  y: number;
}

/** Every span of the current frame with its position. */
async function spans(r: TuiRig): Promise<Placed[]> {
  await r.frame();
  const out: Placed[] = [];
  r.setup.captureSpans().lines.forEach((line, y) => {
    let x = 0;
    for (const sp of line.spans) {
      out.push({ sp, x, y });
      x += sp.width;
    }
  });
  return out;
}

const where = (p: Placed): string => `${JSON.stringify(p.sp.text)} at ${p.x},${p.y}`;

/**
 * No span with an rgb colour (the theme has none: OpenTUI's white fallback is the only way one gets
 * there), every background the terminal's default; under NO_COLOR no indexed colour either.
 */
function expectThemeOnly(all: Placed[], mono: boolean): void {
  expect(all.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const p of all) {
    const { fg, bg } = p.sp;
    if (fg.intent === 'rgb') bad.push(`fallback fg rgb(${fg.toInts().join(',')}) on ${where(p)}`);
    if (mono && fg.intent !== 'default') bad.push(`colour (${fg.intent} ${fg.slot}) under NO_COLOR on ${where(p)}`);
    if (bg.intent !== 'default') bad.push(`background ${bg.intent} on ${where(p)}`);
  }
  expect(bad).toEqual([]);
}

/** The first span holding `text`, from column `fromX` on. */
function find(all: Placed[], text: string, fromX = 0): CapturedSpan {
  const p = all.find((q) => q.x >= fromX && q.sp.text.includes(text));
  if (!p) throw new Error(`no span with ${JSON.stringify(text)}`);
  return p.sp;
}

const attr = (sp: CapturedSpan, a: number): boolean => (sp.attributes & a) !== 0;

/** The terminal's default foreground; dim (or not) as given. */
function expectPlain(sp: CapturedSpan, dim = false): void {
  expect(sp.fg.intent).toBe('default');
  expect(attr(sp, TextAttributes.DIM)).toBe(dim);
}

/** A palette colour of the theme (the same RGBA: intent 'indexed' and its slot). */
function expectAccent(sp: CapturedSpan, colour: typeof THEME.accent): void {
  expect(sp.fg.intent).toBe('indexed');
  expect(sp.fg.equals(colour)).toBe(true);
}

/** The input row: the label span and the span right after it (the placeholder or the typed text). */
function inputRow(all: Placed[]): { label: CapturedSpan; after: CapturedSpan } {
  const label = all.filter((p) => p.x >= LAYOUT.left && /^you\s+› $/.test(p.sp.text)).at(-1);
  if (!label) throw new Error('no input label');
  const after = all.find((p) => p.y === label.y && p.x === label.x + label.sp.width);
  if (!after) throw new Error('nothing after the input label');
  return { label: label.sp, after: after.sp };
}

describe('colours (T-12)', () => {
  test('theme values: no rgb colour, plain text the default foreground, accents from the palette', () => {
    expect(THEME.text.intent).toBe('default');
    expect(THEME.background.intent).toBe('default');
    expect(THEME.cursor.intent).toBe('default');
    const palette = { yellow: 3, red: 1, accent: 4, user: 2, char: 5, border: 8, focusedBorder: 4 } as const;
    for (const [k, slot] of Object.entries(palette)) {
      const c = THEME[k as keyof typeof palette];
      expect([k, c.intent, c.slot]).toEqual([k, 'indexed', slot]);
      expect(MONO_THEME[k as keyof typeof palette].intent).toBe('default');
    }
    expect(MONO_THEME.text.intent).toBe('default');
  });

  test('a whole session: three panes, cards, system rows, the status row, the input, a Director turn', async () => {
    const director: ScriptStep[] = [{ pause: 'd' }, { text: tagged(planOf()) }];
    rig = await tuiRig(calls(director, [{ text: 'Фонарь *гаснет*.' }]), { width: WIDTH, height: HEIGHT, caps: fullCaps(), config: dirConfig() });
    await rig.until('Hello, Levi');

    // Opening: the greeting card, both panes, the status row, the input with its placeholder.
    let all = await spans(rig);
    expectThemeOnly(all, false);
    expectAccent(find(all, '┌'), THEME.border);
    expectPlain(find(all, ' Chat '));
    const head = find(all, 'Mira', LAYOUT.left);
    expectAccent(head, THEME.char);
    expect(attr(head, TextAttributes.BOLD)).toBe(true);
    // The action italic without its asterisks (polish2).
    expect(attr(find(all, 'Mira looks up.'), TextAttributes.ITALIC)).toBe(true);
    expectPlain(find(all, 'Mira looks up.'));
    expectPlain(find(all, 'ready'), true);
    expectPlain(find(all, 'script:default'));
    const key = find(all, 'Ctrl+R');
    expectAccent(key, THEME.accent);
    expect(attr(key, TextAttributes.BOLD)).toBe(true);
    expectPlain(find(all, 'guided reroll'), true);
    expectAccent(find(all, 'Narrator', WIDTH - LAYOUT.right), THEME.accent);
    expectPlain(find(all, 'not planned yet'), true);
    let input = inputRow(all);
    expectAccent(input.label, THEME.user);
    expect(input.after.text).toStartWith('Write your line');
    expectPlain(input.after, true);

    // The player's echo, the Director planning.
    await rig.send('I look around.');
    await rig.until('Director · planning…');
    all = await spans(rig);
    expectThemeOnly(all, false);
    expectAccent(find(all, 'planning…'), THEME.accent);
    expectPlain(find(all, 'I look around.'));

    // The answer: the card, the Director's side line in it, its status line, the Director's record.
    rig.provider.release('d');
    await rig.until('turn 1 · full · tagged');
    all = await spans(rig);
    expectThemeOnly(all, false);
    expectPlain(find(all, 'Фонарь'));
    expect(attr(find(all, 'гаснет'), TextAttributes.ITALIC)).toBe(true);
    expectPlain(find(all, '⋯ director: planned'), true);
    expectPlain(find(all, '[swipe 1/1'), true);
    expectPlain(find(all, 'chapter 1 "Lamps"'), true);

    // System rows (/help overflows the chat: the scrollbar shows), then typed text in the input.
    await rig.send('/help');
    await rig.until('Start a line with //');
    await rig.type('Привет');
    await rig.until('Привет');
    all = await spans(rig);
    expectThemeOnly(all, false);
    expectPlain(find(all, 'Start a line with //'));
    const thumb = all.find((p) => p.x === WIDTH - LAYOUT.right - 2 && /[▄▀█]/.test(p.sp.text));
    expect(thumb).toBeDefined();
    expectAccent(thumb!.sp, THEME.border);
    input = inputRow(all);
    expect(input.after.text).toStartWith('Привет');
    expectPlain(input.after);
  });

  test('a native tool line, a red failure row', async () => {
    const SMALL_WINDOW = { window: 3000, roles: { narrator: { conn: 'script', model: 'default', maxTokens: 64 } } } as const;
    const o: TuiRigOptions = { width: WIDTH, height: HEIGHT, caps: { ...SCRIPT_CAPS, tools: 'native' }, config: SMALL_WINDOW };
    const script = calls(
      [{ tool: { name: 'search_history', args: { query: 'caravan' } } }],
      [{ text: 'The caravan left at dawn.' }],
      [{ error: { code: 'auth_failed', status: 401 } }],
    );
    rig = await tuiRig(script, o);
    // A history longer than the window: search_history is offered.
    for (let i = 1; i <= 40; i++) {
      const filler = ' The road goes on through the dunes and the wind keeps blowing sand into every pack and every boot.'.repeat(3);
      rig.session.send({ text: `Day ${i}: ${i === 3 ? 'the caravan moves on.' : 'we walk on.'}${filler}`, expectedVersion: rig.session.version() });
    }
    await rig.until('no answer yet');
    await rig.send('Where did the caravan go?');
    await rig.until('Mira › The caravan left at dawn.');
    await rig.until('2 rounds · tools native');
    let all = await spans(rig);
    expectThemeOnly(all, false);
    expectPlain(find(all, '⋯ search_history "caravan"', LAYOUT.left), true);
    expectPlain(find(all, '⋯ search_history', WIDTH - LAYOUT.right));

    await rig.send('And then?');
    await rig.until('✗');
    all = await spans(rig);
    expectThemeOnly(all, false);
    expectAccent(find(all, '✗'), THEME.red);
  });

  test('NO_COLOR: no palette colour anywhere, the attributes carry the tones', async () => {
    const director: ScriptStep[] = [{ text: tagged(planOf()) }];
    rig = await tuiRig(calls(director, [{ text: 'Фонарь *гаснет*.' }]), {
      width: WIDTH,
      height: HEIGHT,
      caps: fullCaps(),
      config: dirConfig(),
      env: { NO_COLOR: '1' },
    });
    await rig.until('Hello, Levi');
    let all = await spans(rig);
    expectThemeOnly(all, true);
    expect(attr(find(all, 'Mira', LAYOUT.left), TextAttributes.BOLD)).toBe(true);
    expect(attr(inputRow(all).after, TextAttributes.DIM)).toBe(true);

    await rig.send('I look around.');
    await rig.until('turn 1 · full · tagged');
    await rig.send('/help');
    await rig.until('Start a line with //');
    await rig.type('Привет');
    await rig.until('Привет');
    all = await spans(rig);
    expectThemeOnly(all, true);
    expect(attr(find(all, 'Narrator', WIDTH - LAYOUT.right), TextAttributes.BOLD)).toBe(true);
    expect(attr(find(all, 'chapter 1 "Lamps"'), TextAttributes.DIM)).toBe(true);
  });
});
