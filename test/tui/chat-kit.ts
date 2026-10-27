// Shared setup for the chat unit's TUI tests (not a test file itself): a headless renderer with a
// minimal Ui (the transcript ScrollBox as the host builds it), messages and events to feed it.
import { BoxRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import type { Block, Generation } from '../../src/session/entries.ts';
import type { MessageView } from '../../src/session/view.ts';
import { labels } from '../../src/cli/repl-render.ts';
import { createTranscript, type TranscriptOptions } from '../../src/cli/tui/transcript.ts';
import { THEME } from '../../src/cli/tui/theme.ts';
import type { Names, Theme, TranscriptApi, Ui } from '../../src/cli/tui/types.ts';

export const NAMES: Names = labels('Mira');

export interface ChatRig {
  setup: TestRendererSetup;
  ui: Ui;
  t: TranscriptApi;
  frame(): Promise<string>;
}

export async function chatRig(
  o: { width?: number; height?: number; theme?: Theme } & Partial<TranscriptOptions> = {},
): Promise<ChatRig> {
  const setup = await createTestRenderer({ width: o.width ?? 60, height: o.height ?? 16, kittyKeyboard: true });
  const { renderer } = setup;
  const root = new BoxRenderable(renderer, { flexDirection: 'row', width: '100%', height: '100%' });
  const left = new BoxRenderable(renderer, { width: 0, visible: false });
  const right = new BoxRenderable(renderer, { width: 0, visible: false });
  const middle = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: 'column' });
  const transcript = new ScrollBoxRenderable(renderer, { flexGrow: 1, stickyScroll: true, stickyStart: 'bottom' });
  const status = new TextRenderable(renderer, { height: 1, content: '' });
  const input = new TextareaRenderable(renderer, { height: 1 });
  middle.add(transcript);
  middle.add(status);
  middle.add(input);
  root.add(left);
  root.add(middle);
  root.add(right);
  renderer.root.add(root);
  const ui: Ui = { renderer, left, middle, right, transcript, status, input };
  const t = createTranscript(ui, o.theme ?? THEME, { warp: o.warp ?? false, ...(o.showReasoning ? { showReasoning: o.showReasoning } : {}) });
  return {
    setup,
    ui,
    t,
    async frame(): Promise<string> {
      await setup.renderOnce();
      await setup.renderOnce();
      return setup.captureCharFrame();
    },
  };
}

/** A frame row without the scrollbar's glyph and trailing blanks. */
export const row = (r: string): string => r.replace(/[▀▄█▐▌]$/u, '').trimEnd();

/** The frame's rows (see row()), empty rows dropped. */
export const rows = (frame: string): string[] =>
  frame
    .split('\n')
    .map(row)
    .filter((r) => r !== '');

export function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  o: { hidden?: boolean; edited?: boolean; finish?: Generation['finish']; reasoning?: string; swipe?: [number, number] } = {},
): MessageView {
  const blocks: Block[] = [];
  if (o.reasoning !== undefined) blocks.push({ k: 'reasoning', text: o.reasoning });
  blocks.push({ k: 'text', text });
  const m: MessageView = {
    id,
    parent: null,
    role,
    blocks,
    hidden: o.hidden ?? false,
    edited: o.edited ?? false,
    swipe: { index: o.swipe?.[0] ?? 0, count: o.swipe?.[1] ?? 1 },
  };
  if (role === 'assistant') m.gen = { kind: 'model', finish: o.finish ?? 'end' } as Generation;
  return m;
}

let seq = 0;
/** An event stamped like the engine's. */
export const ev = (body: EventBody): Event => ({ sessionId: 's_test', ts: `2026-10-27T12:00:${String(seq++ % 60).padStart(2, '0')}.000Z`, ...body }) as Event;

/** Text deltas with their offsets, as the engine emits them. */
export function textEvents(turnId: string, pieces: string[], type: 'text' | 'reasoning' = 'text', from = 0): Event[] {
  let offset = from;
  return pieces.map((delta) => {
    const e = ev({ type, turnId, delta, offset });
    offset += delta.length;
    return e;
  });
}
