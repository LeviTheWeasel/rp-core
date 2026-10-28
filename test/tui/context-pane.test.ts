import { afterEach, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { contextLines, createContextPane, ollamaWindow } from '../../src/cli/tui/context-pane.ts';
import { linesText } from '../../src/cli/tui/agents-pane.ts';
import { createUi } from '../../src/cli/tui/app.ts';
import { THEME } from '../../src/cli/tui/theme.ts';
import type { BannerInfo } from '../../src/cli/repl-view.ts';
import type { Runtime } from '../../src/cli/runtime.ts';
import { calls, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

test('the context block marks the last prompt and warns when Ollama loaded less than the configured window', () => {
  const text = linesText(contextLines({
    window: 32768,
    last: { window: 32768, reserve: 2048, tokens: { estimated: 28000 } },
  }, { kind: 'loaded', window: 4096 }, 32));
  expect(text).toContain('window 32k · reply 2k');
  expect(text).toContain('last ~28.0k / 30.7k');
  expect(text).toContain('91%');
  expect(text).toContain('Ollama 4k loaded · too small');
});

test('Ollama probe matches the selected model and ignores another loaded model', async () => {
  const fetcher = (async (input: string | URL | Request) => {
    expect(String(input)).toBe('http://127.0.0.1:11434/api/ps');
    return Response.json({ models: [
      { name: 'other:latest', context_length: 4096 },
      { name: 'magmell-32k:latest', context_length: 32768 },
    ] });
  }) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  expect(await ollamaWindow('http://127.0.0.1:11434/v1', 'magmell-32k', fetcher, signal)).toEqual({ kind: 'loaded', window: 32768 });
  expect(await ollamaWindow('http://127.0.0.1:11434', 'absent:latest', fetcher, signal)).toEqual({ kind: 'not-loaded' });
});

test('the mounted block shows a loaded Ollama window below the rp-core limit', async () => {
  const setup = await createTestRenderer({ width: 130, height: 20 });
  const ui = createUi(setup.renderer, THEME, 0);
  ui.hideLoading();
  const rt = { connections: { ollama: { local: true, baseUrl: 'http://127.0.0.1:11434' } } } as unknown as Runtime;
  const fetcher = (async () => Response.json({ models: [{ name: 'magmell:latest', context_length: 4096 }] })) as unknown as typeof fetch;
  const pane = createContextPane(ui, THEME, rt, fetcher);
  const banner = {
    session: { view: () => ({ path: [] }) }, narrator: { conn: 'ollama', model: 'magmell:latest' }, window: 32768,
  } as unknown as BannerInfo;
  try {
    pane.update(banner);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('Ollama 4k loaded · too small');
  } finally {
    pane.dispose();
    await setup.dispose();
  }
});

test('the TUI keeps Context below Usage and updates it after a reply', async () => {
  rig = await tuiRig(calls([{ text: 'The road continues.' }]));
  await rig.until('Hello, Levi');
  await rig.send('Go on');
  const frame = await rig.until('last ~');
  const rows = frame.split('\n');
  expect(rows.findIndex((row) => row.includes('Context'))).toBeGreaterThan(rows.findIndex((row) => row.includes('Usage')));
  expect(frame).toContain('window');
  expect(frame).toContain('█');
});
