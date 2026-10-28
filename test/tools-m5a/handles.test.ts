// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-150 in the tools: the turn's HandleTable numbers the Compendium exactly as refs.ts entryRefs does
// (the library seed first, then session entries in creation order), so search_lore, read_lore,
// /memory and the block's brief tail print the same C<n>.
import { describe, expect, test } from 'bun:test';
import { EMPTY_SEED } from '../../src/agents/compendium/types.ts';
import { entryRefs, refOf } from '../../src/agents/compendium/refs.ts';
import { readLoreTool, searchLoreTool } from '../../src/tools/builtin/lore.ts';
import { HandleTable } from '../../src/tools/handles.ts';
import { world, worldCtx } from './kit.ts';

const handlesOf = (text: string): string[] => text.split('\n').flatMap((l) => /^(C\d+) /.exec(l)?.[1] ?? []);

describe('C<n> = entryRefs', () => {
  test('a bound table resolves every entry of the view to its entryRefs handle, library first, retired too', () => {
    const view = world();
    const refs = entryRefs(view.compendium);
    expect(refs.map((r) => `${r.ref} ${r.entry.key}`)).toEqual([
      'C1 lib:lantern:e1',
      'C2 lib:lantern:e2',
      'C3 lib:lantern:e3',
      // M5b (D-177): the book's [Arc] overview, seeded in its book place.
      'C4 lib:lantern:k2',
      'C5 note:брат',
      'C6 character:мира',
      'C7 arc:украденный свет',
      'C8 location:старая пристань',
      'C9 summary:m0000005.0',
      'C10 character:тихон',
    ]);
    const h = new HandleTable(view.compendium);
    for (const { ref, entry } of refs) {
      expect(h.resolve(ref)).toEqual({ kind: 'compendium', key: entry.key });
      expect(h.handleFor({ kind: 'compendium', key: entry.key })).toBe(ref);
    }
  });

  test("search_lore's rows carry the same handle as /memory (refOf), whatever order they are listed in", async () => {
    const view = world();
    const ctx = worldCtx(view);
    const out = await searchLoreTool.run({ query: 'маяк' }, ctx);
    const shown = handlesOf(out.text);
    expect(shown.length).toBeGreaterThan(3);
    const byRef = new Map(entryRefs(view.compendium).map((r) => [r.ref, r.entry]));
    for (const line of out.text.split('\n')) {
      const m = /^(C\d+) (.+?) \((.+?)\):/.exec(line);
      if (m === null) continue;
      const entry = byRef.get(m[1]!)!;
      const kind = entry.arc !== undefined ? 'arc' : entry.type === null ? 'note' : entry.type;
      expect([line, entry.name, m[3]!.split(',')[0]]).toEqual([line, m[2]!, kind]);
    }
  });

  test('read_lore resolves a C<n> no search listed (the brief tail names it), with a fresh table each turn', async () => {
    const view = world();
    const ref = refOf(view.compendium, 'character:тихон')!;
    expect(ref).toBe('C10');
    const out = await readLoreTool.run({ ids: [ref] }, worldCtx(view, { handles: new HandleTable() }));
    expect(out.text).toStartWith('C10 Тихон (character):\n# Тихон');
  });

  test('without a typed book the notes keep their M3 numbers; attaching one shifts session handles by its entry count', async () => {
    // Without the book the arc creates its plot (C3), and the overlay edit finds no base.
    const bare = world(undefined, EMPTY_SEED);
    expect(entryRefs(bare.compendium).map((r) => `${r.ref} ${r.entry.key}`)).toEqual([
      'C1 note:брат',
      'C2 character:мира',
      'C3 plot:украденный свет',
      'C4 arc:украденный свет',
      'C5 location:старая пристань',
      'C6 summary:m0000005.0',
      'C7 character:тихон',
    ]);
    const booked = world();
    expect(refOf(booked.compendium, 'note:брат')).toBe('C5');
    expect(handlesOf((await searchLoreTool.run({ query: 'Тихон' }, worldCtx(bare, { lore: [] }))).text)).toEqual(['C7', 'C1']);
    expect(handlesOf((await searchLoreTool.run({ query: 'Тихон' }, worldCtx(booked))).text)).toEqual(['C10', 'C5']);
  });
});
