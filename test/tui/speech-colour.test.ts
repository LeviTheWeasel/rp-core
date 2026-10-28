import { afterEach, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createUi } from '../../src/cli/tui/app.ts';
import { MONO_THEME, THEME } from '../../src/cli/tui/theme.ts';
import { proseChunks } from '../../src/cli/tui/turn-view.ts';
import { chatRig, ev, msg, NAMES, textEvents, type ChatRig } from './chat-kit.ts';
import { calls, tuiRig } from './kit.ts';

let rig: ChatRig | null = null;
afterEach(async () => {
  await rig?.setup.dispose();
  rig = null;
});

test('direct speech is cyan, including its quotes; narration and user text keep their colours', async () => {
  rig = await chatRig();
  rig.t.card(msg('a1', 'assistant', '*She smiles.* «Привет», she says. "Come in."'), NAMES);
  rig.t.card(msg('u1', 'user', '"Hello"'), NAMES);
  await rig.frame();
  const spans = rig.setup.captureSpans().lines.flatMap((line) => line.spans);
  expect(spans.find((s) => s.text.includes('Привет'))?.fg.equals(THEME.speech)).toBe(true);
  expect(spans.find((s) => s.text.includes('Come in.'))?.fg.equals(THEME.speech)).toBe(true);
  expect(spans.find((s) => s.text.includes('She smiles.'))?.fg.intent).toBe('default');
  expect(spans.find((s) => s.text.includes('she says.'))?.fg.intent).toBe('default');
  expect(spans.find((s) => s.text.includes('Hello'))?.fg.intent).toBe('default');
});

test('speech colour survives streamed chunks and resets after a newline', async () => {
  rig = await chatRig();
  const turn = rig.t.turn({ label: NAMES.char, names: NAMES, showReasoning: () => false, notice: () => {} });
  turn.push(ev({ type: 'start', turnId: 't1', kind: 'reply', messageId: 'a1', parentId: 'u1' }));
  const pieces = ['She says «При', 'вет» and smiles.\n', 'Plain. "Yes', '!" Done.'];
  for (const e of textEvents('t1', pieces)) turn.push(e);
  await rig.frame();
  const spans = rig.setup.captureSpans().lines.flatMap((line) => line.spans);
  expect(spans.find((s) => s.text.includes('Привет'))?.fg.equals(THEME.speech)).toBe(true);
  expect(spans.find((s) => s.text.includes('Yes!'))?.fg.equals(THEME.speech)).toBe(true);
  expect(spans.find((s) => s.text.includes('Plain.'))?.fg.intent).toBe('default');
  expect(spans.find((s) => s.text.includes('Done.'))?.fg.intent).toBe('default');
  turn.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', pieces.join('')) }));
  turn.finish();
});

test('NO_COLOR keeps speech in the default foreground', () => {
  const chunks = proseChunks('«Привет» "Hello"', MONO_THEME, false);
  expect(chunks.every((c) => c.fg?.intent === 'default')).toBe(true);
});

test('startup logo is shown during loading and removed for the session', async () => {
  const setup = await createTestRenderer({ width: 100, height: 25 });
  try {
    const ui = createUi(setup.renderer, THEME, 30);
    // The Repl can announce readiness before the renderer draws even one frame.
    ui.hideLoading();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('loading story');
    expect(setup.captureCharFrame()).toContain('____');
    await new Promise((resolve) => setTimeout(resolve, 45));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain('loading story');
    ui.hideLoading();
  } finally {
    await setup.dispose();
  }
});

test('a fast session still shows the loading screen before its first chat frame', async () => {
  const tui = await tuiRig(calls([], []), { splashMs: 80 });
  try {
    const first = await tui.until('loading story');
    expect(first).toContain('loading story');
    expect(first).not.toContain('Hello, Levi');
    const ready = await tui.until('Hello, Levi');
    expect(ready).not.toContain('loading story');
  } finally {
    if (!tui.setup.renderer.isDestroyed) await tui.close();
  }
});
