// Ported from Bunraku:src/core/compendium/compendium.test.ts@702d8120 (the derived-tree tests; the
// reading, Dashboard, relationship and cross-reference parts are not ported).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The derived tree (D-165) over the 239-entry fixture (fixture-book.ts); counts are hand-derived from
// the fixture, not from the code under test. Then the rp-core changes: notes and arcs, Unicode labels,
// places by normalizeName, Cast by `org`.
import { describe, expect, test } from 'bun:test';
import { deriveTree, entryCountOf, narrativeBucket, shouldUseTyped, treeStats, type TreeNode } from '../../src/agents/compendium/tree.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import { CATEGORY, fixtureBook, FIXTURE_SIZE, typedEntry } from './fixture-book.ts';
import { arcEntry, noteEntry, typed } from './kit.ts';

const book = fixtureBook();
const child = (node: TreeNode, label: string): TreeNode => node.children.find((c) => c.label === label)!;
const labels = (node: TreeNode): string[] => node.children.map((c) => `${c.label}:${entryCountOf(c)}`);
const allIds = (n: TreeNode): string[] => [...n.entryIds, ...n.children.flatMap(allIds)];

describe('the derived tree', () => {
  const root = deriveTree(book);

  test('the fixture really holds 239 entries', () => expect(book).toHaveLength(FIXTURE_SIZE));

  test('a mostly typed set uses the typed path: eleven buckets in order, then Unsorted, and every live entry once', () => {
    expect(shouldUseTyped(book)).toMatchObject({ use: true, typedCount: 227, totalEnabled: 233 });
    expect(entryCountOf(root)).toBe(233);
    expect(root).toMatchObject({ id: 'root', label: 'World Knowledge', summary: '233 entries across 12 compendium buckets' });
    expect(labels(root)).toEqual([
      'Cast:59',
      'Places:30',
      'Items:20',
      'Powers:10',
      'Organizations:12',
      'Events:20',
      'Plots:8',
      'Threats:12',
      'Worldbuilding:20',
      'Narrative:24',
      'Bestiary:12',
      'Unsorted:6',
    ]);
    const ids = allIds(root);
    expect(ids).toHaveLength(233);
    expect(new Set(ids).size).toBe(233);
    expect(ids).not.toContain('off-0'); // switched off
    expect(ids).not.toContain('ret-0'); // retired
    expect(ids).not.toContain('c-ghost');
  });

  test('Cast groups by first affiliation, largest first, Unaffiliated last', () => {
    expect(labels(child(root, 'Cast'))).toEqual(['Lantern Guild:16', 'Salt Court:16', 'Ashen Wardens:14', 'Unaffiliated:13']);
  });

  test('Places nest by parent; a missing parent or a cycle still shows once; counts add up', () => {
    const places = child(root, 'Places');
    expect(labels(places).slice(0, 3)).toEqual(['The Realm:17', 'Cycle A:2', 'Lost Hamlet:1']);
    expect(places.children).toHaveLength(13); // Realm, Cycle A, Lost Hamlet, ten top-level extras
    expect(places.children.reduce((n, c) => n + entryCountOf(c), 0)).toBe(30);
    const harbor = child(child(places, 'The Realm'), 'Harbor City');
    expect(entryCountOf(harbor)).toBe(15);
    expect(labels(harbor).slice(0, 2)).toEqual(['Dock Ward:1', 'Lamp Row:2']); // only the top level is sorted, as in RoleCall
    expect(child(places, 'Cycle A').children.map((c) => c.label)).toEqual(['Cycle B']);
    expect(treeStats(root).maxDepth).toBe(6); // root, Places, Realm, Harbor, Lamp Row, Cellars
    expect(harbor).toMatchObject({ id: 'place:l-harbor', entryIds: ['l-harbor'], summary: 'Harbor City (14 sub-locations)' });
  });

  test('Events group by first related plot with Standalone last; Threats rank by severity with legacy words folded in', () => {
    expect(labels(child(root, 'Events'))).toEqual(['The Missing Lantern:4', 'The Salt War:4', 'The Quiet Season:4', 'Old Debts:3', 'Standalone:5']);
    expect(labels(child(root, 'Threats'))).toEqual(['Extinction Level:2', 'Catastrophic:1', 'Major:3', 'Notable:2', 'Minor:3', 'Unrated:1']);
  });

  test("Worldbuilding, Narrative and Bestiary group as RoleCall's builders do", () => {
    expect(labels(child(root, 'Worldbuilding'))).toEqual(['Magic:6', 'Law:5', 'Custom:5', 'General:4']);
    expect(labels(child(root, 'Narrative'))).toEqual(['Old Debts:5', 'The Missing Lantern:5', 'The Quiet Season:5', 'The Salt War:5', 'Unlinked Summaries:4']);
    expect(labels(child(root, 'Bestiary'))).toEqual(['Beast:3', 'Spirit:3', 'Construct:3', 'Unclassified:3']);
  });

  test('ids and summaries: buckets, groups, flat buckets list their entries', () => {
    const cast = child(root, 'Cast');
    expect(cast).toMatchObject({ id: 'bucket:character', summary: '59 cast entries', entryIds: [] });
    expect(cast.children[0]).toMatchObject({ id: 'character/Lantern%20Guild', summary: 'Mira Vance, Dov Ketter, Extra Character 3, and 13 more' });
    const items = child(root, 'Items');
    expect(items.children).toEqual([]);
    expect(items.entryIds).toHaveLength(20);
    expect(child(root, 'Unsorted')).toMatchObject({ id: 'bucket:unsorted', summary: '6 entries without a compendium type' });
  });

  test('stats count nodes, depth and leaves of the tree itself', () => {
    let nodes = 0;
    let leaves = 0;
    const walk = (n: TreeNode): void => {
      nodes += 1;
      if (n.children.length === 0) leaves += 1;
      n.children.forEach(walk);
    };
    walk(root);
    expect(treeStats(root)).toMatchObject({ nodeCount: nodes, leafCount: leaves, maxDepth: 6 });
  });

  test('detection: under five live entries, or under half typed, falls back to categories; exactly half is typed', () => {
    const items = (n: number): CEntry[] => Array.from({ length: n }, (_, i) => typedEntry(`t${i}`, `T${i}`, 'item', {}));
    const classic = (n: number): CEntry[] => Array.from({ length: n }, (_, i) => ({ ...noteEntry(`C${i}`, 'x'), key: `c${i}` }));
    expect(shouldUseTyped([...items(4)]).use).toBe(false);
    expect(shouldUseTyped([...items(3), ...classic(4)]).use).toBe(false);
    expect(shouldUseTyped([...items(4), ...classic(4)]).use).toBe(true);
    expect(shouldUseTyped([]).ratio).toBe(0);
  });

  test('an untyped set uses its categories; no category, or one that is gone, lands in General', () => {
    const classicOnly = book.filter((e) => e.key.startsWith('classic-'));
    const t = deriveTree(classicOnly, { categoryOf: (e) => CATEGORY.get(e.key) });
    expect(labels(t)).toEqual(['People:3', 'General:3']);
    expect(t.summary).toBe('6 entries across 2 categories');
    expect(child(t, 'General')).toMatchObject({ id: 'category:general', entryIds: ['classic-3', 'classic-4', 'classic-5'] });
    expect(child(t, 'People').id).toBe('category:People');
  });

  test('an empty set has an empty tree', () => {
    const t = deriveTree([]);
    expect(t.children).toEqual([]);
    expect(treeStats(t)).toEqual({ nodeCount: 1, maxDepth: 1, leafCount: 1 });
  });

  test('key order in stored data never changes the result (F8)', () => {
    const shuffle = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shuffle) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffle(x)])) : v;
    const shuffled = fixtureBook().map((e) => ({ ...e, data: shuffle(e.data) as CEntry['data'] }));
    expect(deriveTree(shuffled)).toEqual(root);
  });
});

describe('rp-core changes (D-165)', () => {
  test('notes go to Unsorted; an arc sits first in its plot under Narrative', () => {
    const entries = [
      typed('summary:a', 'summary', { title: 'Глава 1', summary: 'x', parent_plot: 'Фонарь' }),
      typed('summary:b', 'summary', { title: 'Глава 2', summary: 'x', parent_plot: 'Фонарь' }),
      arcEntry('Фонарь', 'Потерян и найден.'),
      typed('character:мира', 'character', { name: 'Мира' }),
      typed('location:маяк', 'location', { name: 'Маяк' }),
      noteEntry('Брат', 'Ушёл в море.'),
    ];
    const t = deriveTree(entries);
    expect(labels(t)).toEqual(['Cast:1', 'Places:1', 'Narrative:3', 'Unsorted:1']);
    expect(child(child(t, 'Narrative'), 'Фонарь').entryIds).toEqual(['arc:фонарь', 'summary:a', 'summary:b']);
    expect(child(t, 'Unsorted').entryIds).toEqual(['note:брат']);
  });

  test("narrativeBucket (exported for M5b, as Bunraku's): the typed tree's Narrative node from live summaries and arcs only", () => {
    const entries = [
      typed('summary:a', 'summary', { title: 'Глава 1', summary: 'x', parent_plot: 'Фонарь' }),
      typed('summary:z', 'summary', { title: 'Глава 9', summary: 'x', parent_plot: 'Буря' }),
      typed('summary:loose', 'summary', { title: 'Отступление', summary: 'x' }),
      typed('summary:gone', 'summary', { title: 'Стёртая', summary: 'x', parent_plot: 'Фонарь' }, { retired: { reason: 'дубль' } }),
      arcEntry('Фонарь', 'Потерян и найден.'),
      typed('character:мира', 'character', { name: 'Мира' }),
      noteEntry('Брат', 'Ушёл в море.'),
    ];
    const n = narrativeBucket(entries);
    expect(n.id).toBe('bucket:summary');
    expect(n.label).toBe('Narrative');
    expect(labels(n)).toEqual(['Буря:1', 'Фонарь:2', 'Unlinked Summaries:1']);
    expect(child(n, 'Фонарь').entryIds).toEqual(['arc:фонарь', 'summary:a']);
    // The same node the derived tree holds for these entries.
    expect(child(deriveTree(entries.filter((e) => e.key !== 'note:брат')), 'Narrative')).toEqual(n);
    expect(narrativeBucket([typed('character:мира', 'character', { name: 'Мира' })])).toMatchObject({ entryIds: [], children: [] });
  });

  test('labels made from data capitalise their first letter in any script', () => {
    const entries = [
      typed('w1', 'worldbuilding', { topic: 'Право огня', category: 'закон', description: 'x' }),
      typed('w2', 'worldbuilding', { topic: 'Соль', category: 'закон', description: 'x' }),
      typed('w3', 'worldbuilding', { topic: 'Tides', category: 'sea lore', description: 'x' }),
      typed('b1', 'creature', { name: 'Чайка', classification: 'дух моря' }),
      typed('t1', 'threat', { name: 'Тень', severity: 'катастрофа' }),
    ];
    const t = deriveTree(entries);
    expect(labels(child(t, 'Worldbuilding'))).toEqual(['Закон:2', 'Sea Lore:1']);
    expect(labels(child(t, 'Bestiary'))).toEqual(['Дух моря:1']);
    expect(labels(child(t, 'Threats'))).toEqual(['Катастрофа:1']);
  });

  test('places nest by normalizeName: case, ё and punctuation do not split a parent from its child', () => {
    const entries = [
      typed('l1', 'location', { name: 'Ёлкин Мыс' }),
      typed('l2', 'location', { name: 'Маяк', parent_location: 'елкин мыс' }),
      typed('l3', 'location', { name: 'Лестница', parent_location: 'МАЯК!' }),
      typed('c1', 'character', { name: 'Мира' }),
      typed('c2', 'character', { name: 'Дов' }),
    ];
    const places = child(deriveTree(entries), 'Places');
    expect(labels(places)).toEqual(['Ёлкин Мыс:3']);
    expect(child(child(places, 'Ёлкин Мыс'), 'Маяк').children.map((c) => c.label)).toEqual(['Лестница']);
  });

  test("Cast groups by the first affiliation's org, else its with", () => {
    const entries = [
      typed('c1', 'character', { name: 'Мира', affiliations: [{ org: 'Гильдия фонарщиков', role: 'keeper' }] }),
      typed('c2', 'character', { name: 'Дов', affiliations: [{ with: 'Гильдия фонарщиков' }] }),
      typed('c3', 'character', { name: 'Села', affiliations: [{ org: ' ', with: 'Соляной двор' }] }),
      typed('c4', 'character', { name: 'Оз' }),
      typed('c5', 'character', { name: 'Тень', affiliations: 'none' }),
    ];
    expect(labels(child(deriveTree(entries), 'Cast'))).toEqual(['Гильдия фонарщиков:2', 'Соляной двор:1', 'Unaffiliated:2']);
  });

  test('the root label can be named; retired entries are never in the tree', () => {
    const entries = [...Array.from({ length: 5 }, (_, i) => typed(`i${i}`, 'item', { name: `I${i}` })), typed('gone', 'item', { name: 'Gone' }, { retired: { reason: 'lost' } })];
    const t = deriveTree(entries, { rootLabel: 'lantern' });
    expect(t.label).toBe('lantern');
    expect(allIds(t)).not.toContain('gone');
    expect(t.summary).toBe('5 entries across 1 compendium buckets');
  });

  test('a category named General joins the General node', () => {
    const entries = [noteEntry('A', 'x'), noteEntry('B', 'x'), noteEntry('C', 'x')];
    const cats = new Map([
      ['note:a', 'general'],
      ['note:b', 'Места'],
    ]);
    expect(labels(deriveTree(entries, { categoryOf: (e) => cats.get(e.key) }))).toEqual(['Места:1', 'General:2']);
  });
});
