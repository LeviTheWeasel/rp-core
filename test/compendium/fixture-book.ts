// Ported from Bunraku:src/core/compendium/fixture-book.ts@702d8120 (the 239-entry fixture book).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A hand-seeded, deterministic set of Compendium entries for the tree tests (not a test file itself):
// 239 entries covering every type, classic entries, switched-off and retired ones, a place cycle, an
// orphaned parent and legacy severity words. Changes from Bunraku: entries are CEntry objects built by
// hand (key = Bunraku's id); a switched-off or retired entry is retired (the tree reads live entries
// only); a classic entry is a note, and its category (Bunraku's categoryId) is kept in CATEGORY by name.
import type { CEntry, EntryType, Rec } from '../../src/agents/compendium/types.ts';
import { noteEntry, typed } from './kit.ts';

const nonBlank = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** Bunraku's typedEntry: the name is data.name, else data.title, else data.topic, else the entry title. */
export function typedEntry(id: string, title: string, type: EntryType, data: Rec, meta: { featured?: boolean; retired?: boolean } = {}): CEntry {
  const name = nonBlank(data.name) ?? nonBlank(data.title) ?? nonBlank(data.topic) ?? title;
  return typed(id, type, data, { name, ...(meta.featured ? { featured: true } : {}), ...(meta.retired ? { retired: { reason: 'fixture' } } : {}) });
}

const PLOTS = ['The Missing Lantern', 'The Salt War', 'The Quiet Season', 'Old Debts'];
const ORGS = ['Lantern Guild', 'Salt Court', 'Ashen Wardens'];
const STATUSES = ['active', 'stalled', 'escalating', 'not_started', 'resolved', 'abandoned', 'active', 'active'];
const SEVERITIES = ['extinction_level', 'catastrophic', 'major', 'notable', 'minor', 'existential', 'moderate', 'resolved', 'major', 'major', 'minor'];

/** Entries: 228 typed, 6 classic, 3 switched-off items and 2 retired plots (the retired Ghost is one of the 60 characters). */
export const FIXTURE_SIZE = 239;

/** Classic entry key → its category name (Bunraku's cat-people; cat-gone no longer exists, so it has none). */
export const CATEGORY: ReadonlyMap<string, string> = new Map([
  ['classic-0', 'People'],
  ['classic-1', 'People'],
  ['classic-2', 'People'],
]);

export function fixtureBook(): CEntry[] {
  const out: CEntry[] = [];
  const add = (e: CEntry): void => void out.push(e);

  // Characters: eight hand-authored, then 52 generated (every fifth unaffiliated).
  add(
    typedEntry(
      'c-mira',
      'Mira Vance',
      'character',
      {
        name: 'Mira Vance',
        aliases: ['The Lamplighter'],
        tagline: 'Keeps the last lantern lit.',
        affiliations: [{ org: 'Lantern Guild', with: 'Lantern Guild' }],
        relationships: [{ with: 'Dov Ketter', nature: 'ally', status: 'active' }, { with: 'Sela', nature: 'rival' }, { with: 'Nobody At All' }],
        arc: { key_moments: ['Arrives', 'Loses the lantern', 'Finds it'], current_phase_index: 1 },
        family: { siblings: ['Dov Ketter'] },
        possessions: ['Brass Lantern'],
      },
      { featured: true },
    ),
  );
  add(typedEntry('c-dov', 'Dov Ketter', 'character', { name: 'Dov Ketter', tagline: 'Quartermaster.', affiliations: [{ with: 'Lantern Guild' }], relationships: [{ with: 'Mira Vance', nature: 'ally', status: 'active' }] }));
  add(typedEntry('c-sela', 'Sela Brandt', 'character', { name: 'Sela Brandt', affiliations: [{ with: 'Salt Court' }], relationships: [{ with: 'Mira', nature: 'enemy' }] }));
  add(typedEntry('c-tomas', 'Tomas Fushiguro', 'character', { name: 'Tomas Fushiguro', affiliations: [{ with: 'Salt Court' }], relationships: [{ with: 'Sela Brandt', nature: 'mentor' }] }));
  add(typedEntry('c-ines', 'Ines Fushiguro', 'character', { name: 'Ines Fushiguro', affiliations: [{ with: 'Ashen Wardens' }], relationships: [{ with: 'Fushiguro' }, { with: 'Tomas Fushiguro', nature: 'sibling' }] }));
  add(typedEntry('c-oz', 'Oz', 'character', { name: 'Oz', relationships: [{ with: 'Mira Vance' }] }));
  add(typedEntry('c-blank', 'Unnamed Guest', 'character', { name: '', relationships: [{ with: 'Mira Vance' }] }));
  add(typedEntry('c-ghost', 'Ghost', 'character', { name: 'Ghost', relationships: [{ with: 'Mira Vance' }] }, { retired: true }));
  for (let i = 0; i < 52; i++) {
    add(typedEntry(`c-${i}`, `Extra Character ${i}`, 'character', { name: `Extra Character ${i}`, ...(i % 5 === 0 ? {} : { affiliations: [{ with: ORGS[i % 3]! }] }) }));
  }

  // Places: Realm > Harbor City > three districts; Salt Flats under the Realm; a two-place cycle; an orphaned parent.
  add(typedEntry('l-realm', 'The Realm', 'location', { name: 'The Realm' }));
  add(typedEntry('l-harbor', 'Harbor City', 'location', { name: 'Harbor City', parent_location: 'The Realm' }));
  for (const [n, d] of [
    ['Dock Ward', 'Harbor City'],
    ['Lamp Row', 'Harbor City'],
    ['Lamp Row Cellars', 'Lamp Row'],
    ['Salt Flats', 'The Realm'],
  ] as const) {
    add(typedEntry(`l-${n}`, n, 'location', { name: n, parent_location: d }));
  }
  add(typedEntry('l-cyc-a', 'Cycle A', 'location', { name: 'Cycle A', parent_location: 'Cycle B' }));
  add(typedEntry('l-cyc-b', 'Cycle B', 'location', { name: 'Cycle B', parent_location: 'Cycle A' }));
  add(typedEntry('l-orphan', 'Lost Hamlet', 'location', { name: 'Lost Hamlet', parent_location: 'A Place Not In This Book' }));
  for (let i = 0; i < 21; i++) add(typedEntry(`l-${i}`, `Extra Place ${i}`, 'location', { name: `Extra Place ${i}`, ...(i % 2 === 0 ? { parent_location: 'Harbor City' } : {}) }));

  for (let i = 0; i < 20; i++) {
    add(typedEntry(`i-${i}`, `Item ${i}`, 'item', { name: `Item ${i}`, current_owner: i === 0 ? 'Mira Vance' : i === 1 ? 'Nobody Anywhere' : '', linked_powers: i === 0 ? ['Lamplight'] : [] }));
  }
  for (let i = 0; i < 10; i++) add(typedEntry(`pw-${i}`, i === 0 ? 'Lamplight' : `Power ${i}`, 'power', { name: i === 0 ? 'Lamplight' : `Power ${i}`, users: i === 0 ? ['Mira Vance'] : [] }));
  for (let i = 0; i < 12; i++) add(typedEntry(`o-${i}`, i < 3 ? ORGS[i]! : `Order ${i}`, 'organization', { name: i < 3 ? ORGS[i]! : `Order ${i}`, leader: i === 0 ? 'Dov Ketter' : '' }));
  for (let i = 0; i < 20; i++) {
    add(typedEntry(`e-${i}`, `Event ${i}`, 'event', { name: `Event ${i}`, ...(i < 15 ? { related_plots: [PLOTS[i % 4]!] } : {}), where: i === 0 ? 'Harbor City' : '' }));
  }
  for (let i = 0; i < 8; i++) {
    add(typedEntry(`p-${i}`, i < 4 ? PLOTS[i]! : `Plot ${i}`, 'plot', { name: i < 4 ? PLOTS[i]! : `Plot ${i}`, status: STATUSES[i]!, central_characters: i === 0 ? ['Mira Vance', 'Dov Ketter'] : [] }));
  }
  for (let i = 0; i < 12; i++) {
    add(typedEntry(`t-${i}`, `Threat ${i}`, 'threat', { name: `Threat ${i}`, ...(i < 11 ? { severity: SEVERITIES[i]! } : {}), status: i === 3 ? 'averted' : i === 4 ? 'realized' : 'active' }));
  }
  for (let i = 0; i < 20; i++) add(typedEntry(`w-${i}`, `Concept ${i}`, 'worldbuilding', { topic: `Concept ${i}`, ...(i < 16 ? { category: ['magic', 'law', 'custom'][i % 3]! } : {}) }));
  for (let i = 0; i < 24; i++) {
    add(typedEntry(`s-${i}`, `Recap ${i}`, 'summary', { title: `Recap ${i}`, ...(i < 20 ? { parent_plot: PLOTS[i % 4]! } : {}), ...(i % 2 === 0 ? { turn_range: { from: 100 - i, to: 101 - i } } : {}) }));
  }
  for (let i = 0; i < 12; i++) add(typedEntry(`cr-${i}`, `Creature ${i}`, 'creature', { name: `Creature ${i}`, ...(i < 9 ? { classification: ['beast', 'spirit', 'construct'][i % 3]! } : {}) }));

  for (let i = 0; i < 6; i++) add({ ...noteEntry(`Classic ${i}`, 'Plain text.'), key: `classic-${i}` });
  for (let i = 0; i < 3; i++) add(typedEntry(`off-${i}`, `Switched Off ${i}`, 'item', { name: `Switched Off ${i}` }, { retired: true }));
  for (let i = 0; i < 2; i++) add(typedEntry(`ret-${i}`, `Retired ${i}`, 'plot', { name: `Retired ${i}`, status: 'active' }, { retired: true }));
  return out;
}
