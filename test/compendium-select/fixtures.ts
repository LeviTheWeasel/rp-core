// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Fixtures for the selector and block tests (not a test file itself). CEntry objects are built by
// hand: the fold is tested elsewhere.
import type { BlockCandidate, CEntry, CompendiumBlockInput, EntryType } from '../../src/agents/compendium/types.ts';
import { COMPENDIUM_LIMITS } from '../../src/agents/compendium/profile.ts';

/** A live typed session entry named `name` (data.name too), never changed by a row. */
export function entry(key: string, type: EntryType | null, name: string, over: Partial<CEntry> = {}): CEntry {
  return {
    key,
    type,
    name,
    aliases: [],
    tagline: '',
    data: type === null ? {} : { name },
    keys: [],
    origin: { kind: 'session' },
    prov: { created: null, lastSeq: 0, appended: {}, createdSeq: 0 },
    ...over,
  };
}

/** The same, from the library book 'lantern' (entry id = the key's last part). */
export function libEntry(key: string, type: EntryType, name: string, over: Partial<CEntry> = {}): CEntry {
  return entry(key, type, name, { origin: { kind: 'library', book: 'lantern', id: key.split(':').at(-1)!, overlay: false }, ...over });
}

/** refOf over a list: C<i+1> in list order (D-150's numbering over a view's Map order). */
export function refsOf(entries: readonly CEntry[]): (key: string) => string {
  const refs = new Map(entries.map((e, i) => [e.key, `C${i + 1}`]));
  return (key) => refs.get(key) ?? key;
}

/** A block candidate; `full` null unless given, brief '# <name>' + text. */
export function cand(ref: string, name: string, over: Partial<BlockCandidate> = {}): BlockCandidate {
  return {
    key: `character:${name.toLowerCase()}`,
    ref,
    tier: 0,
    via: 'mention',
    name,
    full: null,
    brief: `# ${name}`,
    briefTail: `(more: read_lore ${ref})`,
    ...over,
  };
}

/** A block input in the full profile with these candidates. */
export function blockInput(candidates: BlockCandidate[], over: Partial<CompendiumBlockInput> = {}): CompendiumBlockInput {
  return {
    rev: 'rev1',
    profile: 'full',
    candidates,
    limits: COMPENDIUM_LIMITS.full,
    minShare: 0.4,
    inPrompt: new Set(),
    hidden: 0,
    ...over,
  };
}

/** One token per character: block sizes in the tests are plain lengths. */
export const LEN = (text: string): number => text.length;
