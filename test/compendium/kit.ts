// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the Compendium render/freshness/tree/world tests (not a test file itself): CEntry
// objects built by hand (no fold), and a linear chat as a PathView plus its TreeIndex.
import { deriveTagline } from '../../src/agents/compendium/entry-types.ts';
import { EMPTY_COMPENDIUM, type CEntry, type CompendiumView, type EntryType, type Rec } from '../../src/agents/compendium/types.ts';
import type { Block, Entry, Trace } from '../../src/session/entries.ts';
import { buildTree, effectiveMessage, pathTo, type TreeIndex } from '../../src/session/tree.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';

export const TS = '2026-10-26T12:00:00.000Z';

const nameOf = (data: Rec, fallback: string): string => {
  for (const f of ['name', 'title', 'topic']) {
    const v = data[f];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return fallback;
};

const aliasesOf = (data: Rec): string[] => (Array.isArray(data.aliases) ? data.aliases.filter((a): a is string => typeof a === 'string') : []);

/** A typed session entry (a human row unless `prov.created` is given). */
export function typed(key: string, type: EntryType, data: Rec, more: Partial<CEntry> = {}): CEntry {
  return {
    key,
    type,
    name: nameOf(data, key),
    aliases: aliasesOf(data),
    tagline: deriveTagline(type, data),
    data,
    keys: [],
    origin: { kind: 'session' },
    prov: { created: null, lastSeq: 1, appended: {}, createdSeq: 1 },
    ...more,
  };
}

/** A library seed entry of book `book` (D-141 shape). */
export function lib(book: string, id: string, type: EntryType, data: Rec, more: Partial<CEntry> = {}): CEntry {
  return typed(`lib:${book}:${id}`, type, data, {
    origin: { kind: 'library', book, id, overlay: false },
    prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
    ...more,
  });
}

/** A human note. */
export function noteEntry(title: string, content: string, more: Partial<CEntry> = {}): CEntry {
  return {
    key: `note:${title.toLowerCase()}`,
    type: null,
    name: title,
    aliases: [],
    tagline: '',
    data: {},
    keys: [title],
    content,
    origin: { kind: 'session' },
    prov: { created: null, lastSeq: 1, appended: {}, createdSeq: 1 },
    ...more,
  };
}

/** An arc overview (D-145). */
export function arcEntry(plot: string, overview: string, more: Partial<CEntry> = {}): CEntry {
  return { ...noteEntry(plot, overview), key: `arc:${plot.toLowerCase()}`, arc: plot, keys: [], ...more };
}

export function compendiumOf(entries: readonly CEntry[]): CompendiumView {
  return { ...EMPTY_COMPENDIUM, entries: new Map(entries.map((e) => [e.key, e])) };
}

/** One message of a linear chat. `trace` is the msg's own; `cont` a continue edit's trace. */
export interface Line {
  role: 'user' | 'assistant';
  text: string;
  hidden?: boolean;
  trace?: Partial<Trace> | Record<string, unknown>;
  cont?: Partial<Trace> | Record<string, unknown>;
}

const text = (t: string): Block[] => [{ k: 'text', text: t }];

/** A linear chat m0, m1, … as a TreeIndex and the PathView at its last message (built without the fold). */
export function chat(lines: readonly Line[], opts: { castNames?: string[]; entries?: readonly CEntry[]; ids?: (i: number) => string } = {}): { view: PathView; tree: TreeIndex; ids: string[] } {
  const idOf = opts.ids ?? ((i: number) => `m${i}`);
  const log: Entry[] = [];
  let seq = 0;
  lines.forEach((l, i) => {
    log.push({ t: 'msg', seq: ++seq, ts: TS, id: idOf(i), parent: i === 0 ? null : idOf(i - 1), role: l.role, blocks: text(l.text), ...(l.trace ? { trace: l.trace as Trace } : {}) });
  });
  lines.forEach((l, i) => {
    if (l.cont) log.push({ t: 'edit', seq: ++seq, ts: TS, target: idOf(i), reason: 'continue', blocks: text(`${l.text} (continued)`), trace: l.cont as Trace });
    if (l.hidden) log.push({ t: 'hide', seq: ++seq, ts: TS, target: idOf(i), hidden: true });
  });
  const tree = buildTree(log);
  const ids = pathTo(tree, tree.head);
  const path: MessageView[] = ids.map((id) => {
    const m = tree.msgs.get(id)!;
    return { id, parent: m.parent, role: m.role, blocks: effectiveMessage(tree, id).blocks, hidden: tree.hidden.get(id) === true, edited: false, swipe: { index: 0, count: 1 } };
  });
  const view: PathView = {
    session: 's_0000c001',
    head: tree.head,
    version: tree.version,
    path,
    pathSet: new Set(ids),
    tails: [],
    vars: {},
    fires: [],
    castNames: opts.castNames ?? [],
    compendium: compendiumOf(opts.entries ?? []),
  };
  return { view, tree, ids };
}

/** A trace whose request cut the history from `from` to `to` (null: nothing cut). */
export const cut = (from: string, to: string): Record<string, unknown> => ({ seed: 1, now: TS, lore: { fired: [] }, trimmed: { from, to } });
export const uncut: Record<string, unknown> = { seed: 1, now: TS, lore: { fired: [] }, trimmed: null };

/** Alternating lines: an assistant greeting at m0, then user and assistant in turn; n messages. */
export function alternating(n: number, more: (i: number) => Partial<Line> = () => ({})): Line[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? ('assistant' as const) : ('user' as const), text: `message ${i}`, ...more(i) }));
}
