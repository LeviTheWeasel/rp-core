// Ported from Bunraku:src/core/director/compendium-snapshot.ts@702d8120 (buildCompendiumContext, adapted).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Director's world snapshot (ARCHITECTURE.md §7.4.5, §7.3; .notes/m5a-decisions.md D-157): a short
// "[COMPENDIUM CONTEXT]" section of characters with their relationships, unresolved tensions and key
// locations, read from the live character and location entries of the path's Compendium (library seed,
// overlays and session entries; no freshness filter). Bunraku's choice: the characters named in the
// recent messages or by the card and the persona come first, then those they have relationships with,
// then featured ones, then the rest; locations the scene mentions or its characters are at, then
// featured, then the rest. Changes from Bunraku (B32 of the deviation list, and C10):
// - mentions by word stems (mention.ts), so «Миру» names «Мира»; a proper name by all its words in
//   one message, in any order, a name with a short or stop word and a lore key as a run (D-169 as
//   narrowed in section I); the last WORLD_RECENT visible path messages, U included, without the
//   speaker prefix; a name equal to a cast name is in the scene;
// - equal ranks: session entries by newer prov.lastSeq, library entries by higher `order` (the lore
//   priority; Bunraku's `order` was the book position, which is the handle order here), then handle order;
// - counts from the budget (WorldBudget), fields truncated, the whole section ≤ budget.chars with
//   "(+N more not shown)" for what did not fit;
// - a status that is not text is not printed; a tension between two characters is printed once (C10).
// Pure; '' when there is nothing to show.

import type { PathView } from '../../session/view.ts';
import type { WorldBudget } from '../director/types.ts';
import { DEFAULT_LORE_ORDER } from '../../lore/engine.ts';
import { normalizeName } from './apply.ts';
import { entryMatchers, mentioned, mentionText, messageText } from './mention.ts';
import type { CEntry, Rec } from './types.ts';

/** Visible path messages, U included, whose text puts an entry in the scene (§7.3). */
export const WORLD_RECENT = 6;

/** Field caps in code points (§7.4.5). */
export const WORLD_CLIP = { description: 200, role: 60, state: 120, notes: 100, place: 160 } as const;

interface Relationship {
  with: string;
  /** `with` as written, when it was text. */
  named?: string;
  nature: string;
  status?: string;
  notes?: string;
}

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const recArray = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const opt = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** At most `max` code points, whitespace flattened; a longer text is cut at a word with '…'. */
function clip(s: string, max: number): string {
  const text = s.replace(/\s+/g, ' ').trim();
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  const cut = cps.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, '')}…`;
}

function relationshipsOf(e: CEntry): Relationship[] {
  return recArray(e.data.relationships).map((r) => {
    const named = opt(r.with);
    const status = opt(r.status);
    const notes = opt(r.notes);
    return {
      with: named ?? 'unknown',
      ...(named !== undefined ? { named } : {}),
      nature: opt(r.nature) ?? 'unknown',
      ...(status !== undefined ? { status } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
  });
}

const stateRec = (e: CEntry): Rec | undefined => (isRecord(e.data.current_state) ? e.data.current_state : undefined);

function stateOf(e: CEntry): string | undefined {
  const s = stateRec(e);
  if (!s) return undefined;
  const status = opt(s.status);
  const location = opt(s.location);
  const parts = [status !== undefined && status !== 'alive' ? `Status: ${status}` : '', opt(s.condition) ?? '', location !== undefined ? `At: ${location}` : ''];
  const text = parts.filter((p) => p !== '').join('. ');
  return text === '' ? undefined : text;
}

const isTension = (r: Relationship): boolean => r.status === 'strained' || r.nature === 'rival' || r.nature === 'enemy';

/**
 * The Director's "[COMPENDIUM CONTEXT]" section for a view that ends at U, within `budget`
 * (WORLD_FULL / WORLD_LITE): at most `characters` characters (each with at most `relationships`
 * relationships), `tensions` tensions and `locations` locations, the whole text at most `chars` long.
 */
export function worldSnapshot(view: PathView, budget: WorldBudget): string {
  const handle = new Map<string, number>();
  const characters: CEntry[] = [];
  const locations: CEntry[] = [];
  for (const e of view.compendium.entries.values()) {
    handle.set(e.key, handle.size);
    if (e.retired !== undefined) continue;
    if (e.type === 'character') characters.push(e);
    else if (e.type === 'location') locations.push(e);
  }
  if (characters.length === 0 && locations.length === 0) return '';

  const recent = view.path
    .filter((m) => !m.hidden)
    .slice(-WORLD_RECENT)
    .map((m) => mentionText(messageText(m)));
  const said = new Set<CEntry>();
  for (const e of [...characters, ...locations]) {
    const matchers = entryMatchers(e);
    if (matchers.length > 0 && recent.some((t) => mentioned(matchers, t))) said.add(e);
  }
  const names = (e: CEntry): string[] => [e.name, ...e.aliases].map(normalizeName).filter((n) => n !== '');
  const cast = new Set(view.castNames.map(normalizeName).filter((n) => n !== ''));
  const inScene = characters.filter((c) => said.has(c) || names(c).some((n) => cast.has(n)));
  const scene = new Set(inScene);

  // Equal ranks: session entries newest first, library entries by higher lore `order` first (ST's
  // meaning, as the lore engine and search_lore read it), then handle order (book order).
  const tie = (a: CEntry, b: CEntry): number => {
    const la = a.origin.kind === 'library';
    const lb = b.origin.kind === 'library';
    let d = 0;
    if (la && lb) d = (b.order ?? DEFAULT_LORE_ORDER) - (a.order ?? DEFAULT_LORE_ORDER);
    else if (!la && !lb) d = b.prov.lastSeq - a.prov.lastSeq;
    return d || handle.get(a.key)! - handle.get(b.key)!;
  };
  const ranked = (list: CEntry[], rank: (e: CEntry) => number, cap: number): CEntry[] => {
    const r = new Map(list.map((e) => [e, rank(e)]));
    return [...list].sort((a, b) => r.get(a)! - r.get(b)! || tie(a, b)).slice(0, Math.max(0, cap));
  };

  // The characters the scene's characters are related to come next (RoleCall's expansion).
  const related = new Set(inScene.flatMap((c) => relationshipsOf(c).flatMap((r) => (r.named !== undefined ? [normalizeName(r.named)] : []))));
  const chosen = ranked(characters, (c) => (scene.has(c) ? 0 : names(c).some((n) => related.has(n)) ? 1 : c.featured ? 2 : 3), budget.characters);
  const places = new Set(inScene.map((c) => normalizeName(opt(stateRec(c)?.location) ?? '')).filter((n) => n !== ''));
  const spots = ranked(locations, (l) => (said.has(l) || names(l).some((n) => places.has(n)) ? 0 : l.featured ? 1 : 2), budget.locations);

  const characterUnits = chosen.map((c) => {
    const description = opt(c.data.description);
    const role = opt(c.data.role);
    const state = stateOf(c);
    const line = `  - ${c.name}${description ? `: ${clip(description, WORLD_CLIP.description)}` : ''}${role ? ` (${clip(role, WORLD_CLIP.role)})` : ''}${state ? `. ${clip(state, WORLD_CLIP.state)}` : ''}`;
    const rels = relationshipsOf(c).slice(0, Math.max(0, budget.relationships));
    if (rels.length === 0) return line;
    const list = rels.map((r) => `${r.with} (${r.nature}${r.status && r.status !== 'active' ? `, ${r.status}` : ''})`).join(', ');
    return `${line}\n    Relationships: ${list}`;
  });

  // A tension is an unordered pair: B's rivalry with A is A's with B (C10).
  const keyOf = new Map<string, string>();
  for (const c of characters) for (const n of names(c)) if (!keyOf.has(n)) keyOf.set(n, c.key);
  const pairs = new Set<string>();
  const tensionUnits: string[] = [];
  for (const c of chosen) {
    for (const r of relationshipsOf(c)) {
      if (!isTension(r)) continue;
      const other = keyOf.get(normalizeName(r.with)) ?? `name:${normalizeName(r.with)}`;
      const pair = [c.key, other].sort().join('\u0000');
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      tensionUnits.push(`  Tension: ${c.name} / ${r.with}: ${r.nature} relationship (${r.status || 'active'})${r.notes ? `: ${clip(r.notes, WORLD_CLIP.notes)}` : ''}`);
    }
  }
  tensionUnits.splice(Math.max(0, budget.tensions));

  const locationUnits = spots.map((l) => {
    const description = opt(l.data.description);
    return `  - ${l.name}${description ? `: ${clip(description, WORLD_CLIP.place)}` : ''}`;
  });

  return fitSections(
    [
      { head: 'Characters:', units: characterUnits },
      { head: '\nUnresolved Tensions:', units: tensionUnits },
      { head: '\nKey Locations:', units: locationUnits },
    ],
    budget.chars,
  );
}

const HEADER = '[COMPENDIUM CONTEXT]';
const more = (n: number): string => `(+${n} more not shown)`;

/**
 * The section within `chars`: everything when it fits; else units (a character with its
 * relationships, a tension, a location) are taken in order while they fit — a unit that does not is
 * skipped and counted — and "(+N more not shown)" closes the text. '' when no unit fits.
 */
function fitSections(sections: { head: string; units: string[] }[], chars: number): string {
  const render = (kept: string[][]): string => {
    const out = [HEADER];
    sections.forEach((s, i) => {
      if (kept[i]!.length > 0) out.push(s.head, ...kept[i]!);
    });
    return out.join('\n');
  };
  const all = sections.map((s) => s.units);
  const total = all.reduce((n, u) => n + u.length, 0);
  if (total === 0) return '';
  const whole = render(all);
  if (whole.length <= chars) return whole;
  const reserve = 1 + more(total).length;
  const kept: string[][] = sections.map(() => []);
  let used = HEADER.length;
  let skipped = 0;
  sections.forEach((s, i) => {
    for (const unit of s.units) {
      const cost = (kept[i]!.length === 0 ? 1 + s.head.length : 0) + 1 + unit.length;
      if (used + cost + reserve <= chars) {
        kept[i]!.push(unit);
        used += cost;
      } else skipped++;
    }
  });
  if (skipped === total) return '';
  return `${render(kept)}\n${more(skipped)}`;
}
