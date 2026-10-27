// Shared setup for the built-in tool tests (not a test file itself): linear chats folded into a
// PathView, and a ToolCtx over a view.
import { EMPTY_COMPENDIUM } from '../../src/agents/compendium/types.ts';
import type { Block, EntryInput } from '../../src/session/entries.ts';
import { foldView, foldViewAt } from '../../src/session/fold.ts';
import { buildTree } from '../../src/session/tree.ts';
import type { PathView } from '../../src/session/view.ts';
import { HandleTable } from '../../src/tools/handles.ts';
import type { Tool, ToolCtx, ToolOutput } from '../../src/tools/types.ts';
import { makeHeader, msg, seqd, TS } from '../session/fixtures.ts';

export { edit, head, hide, makeHeader, msg, seqd, TS } from '../session/fixtures.ts';

/** Message id of #n in a linear chat: m0000001 … */
export const idOf = (n: number): string => `m${String(n).padStart(7, '0')}`;

/** A linear chat: #1 is an assistant greeting, then user and assistant in turn. `extra` entries follow. */
export function chatEntries(texts: readonly (string | Block[])[], extra: EntryInput[] = []): EntryInput[] {
  const out: EntryInput[] = texts.map((t, i) => {
    const role = i % 2 === 0 ? 'assistant' : 'user';
    const parent = i === 0 ? null : idOf(i);
    const more = i === 0 ? { gen: { kind: 'greeting' as const } } : {};
    return typeof t === 'string' ? msg(idOf(i + 1), parent, role, t, more) : msg(idOf(i + 1), parent, role, '', { blocks: t, ...more });
  });
  return [...out, ...extra];
}

/** The PathView at the head of a linear chat (plus `extra` entries). */
export function chatView(texts: readonly (string | Block[])[], extra: EntryInput[] = []): PathView {
  return foldView(makeHeader(), seqd(chatEntries(texts, extra)));
}

/** The view folded at `leaf` (a swipe's view at U). */
export function viewAt(entries: EntryInput[], leaf: string): PathView {
  return foldViewAt(makeHeader(), buildTree(seqd(entries)), leaf);
}

export function ctxFor(view: PathView, more: Partial<ToolCtx> = {}): ToolCtx {
  return {
    view,
    upTo: view.head ?? '',
    names: { char: 'Mira', user: 'Levi' },
    lore: [],
    compendium: view.compendium ?? EMPTY_COMPENDIUM,
    handles: new HandleTable(),
    inContext: () => false,
    pageChars: 6000,
    signal: new AbortController().signal,
    now: TS,
    rng: () => 0.5,
    ...more,
  };
}

/** Run a tool with arguments as given (no schema check: the tool's own defences). */
export const call = (tool: Tool, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> => tool.run(args, ctx);
