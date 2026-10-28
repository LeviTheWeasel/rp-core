// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Shared setup for the M5c recall tests (not a test file itself): the Harbor book as the fold seeds it,
// hand-made entries and views, a visibility window, and the recall index's read options.
import { foldCompendium } from '../../src/agents/compendium/apply.ts';
import { deriveTagline } from '../../src/agents/compendium/entry-types.ts';
import type { Visibility } from '../../src/agents/compendium/fresh.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { RecallIndex, RecallReadOptions } from '../../src/agents/compendium/recall.ts';
import { EMPTY_COMPENDIUM, type CEntry, type CompendiumView, type EntryType, type Rec } from '../../src/agents/compendium/types.ts';
import { CHARS_COUNTER } from '../../src/prompt/tokens.ts';
import { harborSource } from './harbor.ts';

export const count = (text: string): number => CHARS_COUNTER.count(text);

/** The Harbor book folded as a session's only library book (no rows). */
export function harborView(): CompendiumView {
  return foldCompendium([], { pathSet: new Set(), path: [], library: librarySeed([harborSource()], { enabled: true }) });
}

export interface EntryOptions {
  aliases?: string[];
  data?: Rec;
  /** The message its creating row was bound to (plots and events hide while it is visible). */
  created?: string | null;
  /** A summary's range (it hides while range[1] is visible). */
  range?: [string, string];
  lastSeq?: number;
  retired?: true;
  library?: string;
  constant?: true;
  arc?: string;
  /** Per list field, the message that added each element (freshness drops those still visible). */
  appended?: Record<string, (string | null)[]>;
}

/** A CEntry as the fold would hold it (the tagline derived from the data). */
export function ce(key: string, type: EntryType | null, name: string, o: EntryOptions = {}): CEntry {
  const data: Rec = { ...(type === 'summary' ? { title: name } : type === 'worldbuilding' ? { topic: name } : { name }), ...o.data };
  return {
    key,
    type,
    name,
    aliases: o.aliases ?? [],
    tagline: type === null ? '' : deriveTagline(type, data),
    data,
    keys: [],
    origin: o.library !== undefined ? { kind: 'library', book: o.library, id: key, overlay: false } : { kind: 'session' },
    ...(o.retired ? { retired: { reason: 'gone' } } : {}),
    ...(o.constant ? { constant: true as const } : {}),
    ...(o.range ? { range: o.range } : {}),
    ...(o.arc !== undefined ? { arc: o.arc, content: 'Overview.' } : {}),
    prov: { created: o.created ?? null, lastSeq: o.lastSeq ?? 0, appended: o.appended ?? {}, createdSeq: o.lastSeq ?? 0 },
  };
}

export const viewOf = (entries: readonly CEntry[]): CompendiumView => ({ ...EMPTY_COMPENDIUM, entries: new Map(entries.map((e) => [e.key, e])) });

/** A request window over `path` whose last request cut [from, to] (positions), or nothing. */
export function visOf(path: readonly string[], cut: readonly [number, number] | null): Visibility {
  return { cut, pos: new Map(path.map((id, i) => [id, i])) };
}

/** readRecall's options from an index. */
export const optsOf = (index: RecallIndex, maxEntries = 10): RecallReadOptions => ({ handles: index.handles, names: index.names, maxEntries, profile: index.profile });

/** An index whose text is given (the prompt tests): handles e1…eN for keys k1…kN. */
export function fakeIndex(text: string, n = 0, profile: 'full' | 'lite' = 'full'): RecallIndex {
  const handles = new Map(Array.from({ length: n }, (_, i) => [`e${i + 1}`, `k${i + 1}`] as const));
  return { profile, text, handles, names: new Map(), candidates: n, shown: n, omitted: 0, truncated: false };
}
