// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the {{recap}} slot tests through assemble and the request builder (not a test file
// itself): a long chat that the budget trims, a Compendium view over it, and the slot's input.
import type { RecapTrace } from '../../src/agents/compendium/recap.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import type { AssembleInput } from '../../src/prompt/assemble.ts';
import type { RecapRequest } from '../../src/prompt/assemble/recap.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';
import { greet, input, m, ok, path, textOf } from '../assemble/fixtures.ts';
import { viewOf } from '../historian-m5b/kit.ts';

export { arc, libArc, summary, typed } from '../historian-m5b/kit.ts';
export { lines, ok, preset, textOf, HISTORY_BLOCK } from '../assemble/fixtures.ts';

/** 60 characters: 20 tokens by the chars counter (24 with the message overhead). */
const text = (id: string): string => `${id}: `.padEnd(60, 'x');

/** The greeting g, then n exchanges u1 a1 … un an, then the user message u<n+1> the request answers. */
export function longChat(n: number): MessageView[] {
  const out: MessageView[] = [greet('g', 'Hello, traveller.')];
  for (let k = 1; k <= n; k++) out.push(m(`u${k}`, 'user', text(`u${k}`)), m(`a${k}`, 'assistant', text(`a${k}`)));
  out.push(m(`u${n + 1}`, 'user', text(`u${n + 1}`)));
  return out;
}

/** A view of the chat with these Compendium entries. */
export function chatView(msgs: MessageView[], entries: readonly CEntry[]): PathView {
  return { ...path(msgs), compendium: viewOf(entries) };
}

/** The slot's input as the request builder gives it while the Compendium is on (no previous request). */
export function recapIn(over: Partial<RecapRequest> = {}): RecapRequest {
  return { previous: null, profile: 'full', ...over };
}

/**
 * A window the 20-exchange chat does not fit: 1 600 tokens, 600 for the reply, so the 41 messages of
 * 24 tokens and the preset's ~120 leave the first chunk of 8 out (u1…a4); the slot's share is 160.
 */
export const WINDOW = { window: 1600, reserve: 600 } as const;

/** assemble's input over `view`, upTo its last message, the small window. */
export function asmIn(view: PathView, over: Partial<AssembleInput> = {}): AssembleInput {
  return input({ view, upTo: view.path.at(-1)!.id, ...WINDOW, ...over });
}

/** The previous request's trace.recap, as a later request reads it. */
export const prev = (slot: RecapTrace): RecapTrace => structuredClone(slot);

/** The request's sources in order. */
export const srcs = (r: ReturnType<typeof ok>): string[] => r.messages.map((x) => x.src);

/** The text of the request's 'recap' message, or undefined. */
export const recapText = (r: ReturnType<typeof ok>): string | undefined => {
  const msg = r.messages.find((x) => x.src === 'recap');
  return msg === undefined ? undefined : textOf(msg);
};
