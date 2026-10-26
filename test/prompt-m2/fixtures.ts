// Fixtures for the M2 assemble tests (not a test file itself): lore books over a scripted PathView.
import type { LoreEntry } from '../../src/formats/native.ts';
import { assemble, type AssembleInput, type AssembleResult } from '../../src/prompt/assemble.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import type { PathView } from '../../src/session/view.ts';
import { greet, input, m, ok, path, textOf } from '../assemble/fixtures.ts';
import { entry, source } from '../lore/fixtures.ts';

export { entry, source } from '../lore/fixtures.ts';
export { HISTORY_BLOCK, LEVI, MIRA, greet, input, lines, m, ok, path, preset, textOf } from '../assemble/fixtures.ts';

/** G, U1, A1, U2, A2, U3: six chat messages, a reply to U3. */
export const longView = (): PathView =>
  path([
    greet('g', 'Hello, traveller.'),
    m('u1', 'user', 'Hi.'),
    m('a1', 'assistant', 'She nods.'),
    m('u2', 'user', 'Where are we?'),
    m('a2', 'assistant', 'At the lighthouse.'),
    m('u3', 'user', 'Show me the map.'),
  ]);

/** A constant entry: fires on every turn, wherever its position says. */
export const always = (id: string, patch: Partial<LoreEntry> = {}): LoreEntry => entry(id, { constant: true, content: `${id} text`, ...patch });

/** assemble over `longView()` (unless a view is given) with the session book 'lib' holding `entries`. */
export function withLore(entries: LoreEntry[], over: Partial<AssembleInput> = {}): Extract<AssembleResult, { ok: true }> {
  return ok(assemble(input({ view: longView(), lorebooks: [source('lib', entries)], ...over })));
}

/** The message whose src is `src`, or undefined. */
export const bySrc = (msgs: readonly PromptMsg[], src: string): PromptMsg | undefined => msgs.find((x) => x.src === src);

/** Every message text joined: to check that a text is (not) sent anywhere. */
export const allText = (msgs: readonly PromptMsg[]): string => msgs.map(textOf).join('\n\u0001\n');

/** `view` with these past fires (as fold.ts would put them from the traces on the path). */
export function withFires(view: PathView, fires: PathView['fires']): PathView {
  return { ...view, fires };
}
