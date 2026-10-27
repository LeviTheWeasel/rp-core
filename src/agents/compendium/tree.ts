// Ported from Bunraku:src/core/compendium/tree.ts@702d8120 (the derived typed tree and the category fallback).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Compendium's tree, derived and never stored (ARCHITECTURE.md §5.8, .notes/m5a-decisions.md D-165).
// Bunraku's port of RoleCall's typed builder (lib/lorebook/tv-tree-typed.ts): eleven buckets in fixed
// order, a sub-grouping per bucket, an Unsorted bucket for entries without a type, and the typed path
// only when at least 5 entries are live and at least half of them typed; otherwise one node per
// category and General. Bunraku's code runs unchanged through an adapter over CEntry: id = the entry
// key, title = its name, enabled = live (not retired; disabled library entries are never seeded),
// arc = CEntry.arc, category = opts.categoryOf (a library entry's `extras.category` name; none else).
// Changes from Bunraku (listed deviations, D-165):
// - labels made from data (threat severities, worldbuilding categories, bestiary classes) capitalise
//   their first letter with Unicode (Bunraku's ASCII `\b\w` stays for the other words), so «закон»
//   reads «Закон»;
// - places nest by normalizeName(parent_location) against normalizeName(name) (Bunraku: lower case);
// - Cast groups by affiliations[0].org ?? .with (RoleCall's schema names `org`; Bunraku read `with`);
// - narrative plots sort with an explicit 'en' collation (deterministic on every machine);
// - categories have names only: they come in the order they first appear, and one named "General"
//   joins the General node. Notes land in Unsorted, arcs first in their plot under Narrative;
// - nodes carry no `kind`/`entryCount` (entryCountOf counts); narrativeBucket takes CEntry objects. Pure.

import { normalizeName } from './apply.ts';
import { ENTRY_TYPE_INFO } from './entry-types.ts';
import { ENTRY_TYPES, type CEntry, type EntryType, type Rec } from './types.ts';

export interface TreeNode {
  id: string;
  label: string;
  summary?: string;
  /** Entry keys listed directly on this node (a bucket with sub-groups lists none itself). */
  entryIds: string[];
  children: TreeNode[];
}

export interface DeriveTreeOptions {
  /** The root's label; 'World Knowledge' by default. */
  rootLabel?: string;
  /** An entry's category name (a library entry's `extras.category`), for the category tree. */
  categoryOf?: (e: CEntry) => string | undefined;
}

/** RoleCall's detection (tv-tree-typed.ts:121-147): at least 5 live entries and at least half typed. */
export const TYPED_THRESHOLD = 0.5;
export const TYPED_MINIMUM = 5;

/** Bunraku's CompendiumEntry, as much of it as the tree reads. */
interface Item {
  id: string;
  title: string;
  type: EntryType | null;
  arc: string | null;
  data: Rec;
  category: string | null;
}

interface Node extends TreeNode {
  summary: string;
  /** This node's entries plus all below it. */
  entryCount: number;
}

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const recArray = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const nonBlank = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** Whether a set of entries gets the typed tree (live entries only count). */
export function shouldUseTyped(entries: readonly CEntry[]): { use: boolean; typedCount: number; totalEnabled: number; ratio: number } {
  const enabled = entries.filter((e) => e.retired === undefined);
  const typedCount = enabled.filter((e) => e.type !== null).length;
  const ratio = enabled.length === 0 ? 0 : typedCount / enabled.length;
  return { use: enabled.length >= TYPED_MINIMUM && ratio >= TYPED_THRESHOLD, typedCount, totalEnabled: enabled.length, ratio };
}

const summaryOf = (entries: readonly Item[]): string =>
  entries.length === 0
    ? 'Empty'
    : entries.length <= 3
      ? entries.map((e) => e.title).join(', ')
      : `${entries
          .slice(0, 3)
          .map((e) => e.title)
          .join(', ')}, and ${entries.length - 3} more`;

const leaf = (id: string, label: string, entries: readonly Item[]): Node => ({
  id,
  label,
  summary: summaryOf(entries),
  entryIds: entries.map((e) => e.id),
  children: [],
  entryCount: entries.length,
});

const bucket = (type: EntryType, entries: readonly Item[], children: Node[], flat = false): Node => {
  const label = ENTRY_TYPE_INFO[type].bucket;
  return {
    id: `bucket:${type}`,
    label,
    summary: `${entries.length} ${label.toLowerCase()} entries`,
    entryIds: flat ? entries.map((e) => e.id) : [],
    children,
    entryCount: entries.length,
  };
};

/** Groups by a trimmed key; entries with no key come back apart. Insertion order is kept, so ties sort the way the entries come. */
function groupBy(entries: readonly Item[], key: (e: Item) => unknown): { groups: [string, Item[]][]; none: Item[] } {
  const map = new Map<string, Item[]>();
  const none: Item[] = [];
  for (const e of entries) {
    const raw = key(e);
    const k = typeof raw === 'string' ? raw.trim() : '';
    if (k === '') none.push(e);
    else map.set(k, [...(map.get(k) ?? []), e]);
  }
  return { groups: [...map], none };
}

const bySize = (a: [string, Item[]], b: [string, Item[]]): number => b[1].length - a[1].length;
/** Bunraku's ASCII word capitals, then the first letter upper case with Unicode. */
const capital = (s: string): string => {
  const words = s.replace(/\b\w/g, (c) => c.toUpperCase());
  const cp = words.codePointAt(0);
  if (cp === undefined) return words;
  const first = String.fromCodePoint(cp);
  return first.toUpperCase() + words.slice(first.length);
};
const titled = (s: string): string => capital(s.replace(/_/g, ' '));
const group = (type: EntryType, label: string, list: Item[]): Node => leaf(`${type}/${encodeURIComponent(label)}`, label, list);

/** Characters group by their first affiliation (RoleCall :212-235), `org` first, else `with`. */
function castBucket(entries: Item[]): Node {
  const { groups, none } = groupBy(entries, (e) => {
    const first = recArray(e.data.affiliations)[0];
    return first === undefined ? undefined : (nonBlank(first.org) ?? first.with);
  });
  const children = groups.sort(bySize).map(([name, list]) => group('character', name, list));
  if (none.length > 0) children.push(group('character', 'Unaffiliated', none));
  return bucket('character', entries, children);
}

/** Places nest under `parent_location` by name (RoleCall :242-338). A parent outside the bucket, or a cycle, still shows at the top. Two places with the same name share one slot. */
function placesBucket(entries: Item[]): Node {
  const nameOf = (e: Item): string => normalizeName(e.title);
  const byName = new Map<string, Item>();
  for (const e of entries) byName.set(nameOf(e), e);
  const parentOf = (e: Item): string | null => {
    const p = e.data.parent_location;
    const n = typeof p === 'string' ? normalizeName(p) : '';
    return n === '' ? null : n;
  };
  const kids = new Map<string, Item[]>();
  const top: Item[] = [];
  for (const e of entries) {
    const parent = parentOf(e);
    if (parent === null || !byName.has(parent)) top.push(e);
    else kids.set(parent, [...(kids.get(parent) ?? []), e]);
  }
  const seen = new Set<string>();
  // A place already on the way down is left out of its own subtree (RoleCall repeats it as a leaf and counts it twice).
  const build = (e: Item, path: Set<string>): Node | null => {
    const key = nameOf(e);
    seen.add(key);
    if (path.has(key)) return null;
    path.add(key);
    const children = (kids.get(key) ?? []).flatMap((k) => build(k, path) ?? []);
    path.delete(key);
    const count = 1 + children.reduce((n, c) => n + c.entryCount, 0);
    return {
      id: `place:${e.id}`,
      label: e.title,
      summary: children.length > 0 ? `${e.title} (${count - 1} sub-locations)` : e.title,
      entryIds: [e.id],
      children,
      entryCount: count,
    };
  };
  const children = top.flatMap((e) => build(e, new Set()) ?? []);
  for (const e of entries) {
    const node = seen.has(nameOf(e)) ? null : build(e, new Set());
    if (node) children.push(node);
  }
  return bucket('location', entries, children.sort((a, b) => b.entryCount - a.entryCount));
}

/** Events group by their first related plot (RoleCall :355-380). */
function eventsBucket(entries: Item[]): Node {
  const { groups, none } = groupBy(entries, (e) => (Array.isArray(e.data.related_plots) ? e.data.related_plots[0] : undefined));
  const children = groups.sort(bySize).map(([plot, list]) => group('event', plot, list));
  if (none.length > 0) children.push(group('event', 'Standalone', none));
  return bucket('event', entries, children);
}

const SEVERITY_RANK: Record<string, number> = { extinction_level: 0, catastrophic: 1, major: 2, notable: 3, minor: 4 };
const SEVERITY_SYNONYM: Record<string, string> = { existential: 'extinction_level', moderate: 'notable', resolved: 'minor' };
/** RoleCall's canonical severity (:408-414). */
export const canonicalSeverity = (sev: string): string => {
  const s = sev.toLowerCase().trim();
  return SEVERITY_SYNONYM[s] ?? s;
};
export const severityRank = (sev: unknown): number => (typeof sev === 'string' ? (SEVERITY_RANK[canonicalSeverity(sev)] ?? 99) : 99);

/** Threats group by severity, worst first, unknown last (RoleCall :416-447). */
function threatsBucket(entries: Item[]): Node {
  const { groups, none } = groupBy(entries, (e) => (typeof e.data.severity === 'string' ? canonicalSeverity(e.data.severity) : null));
  const children = groups.sort((a, b) => severityRank(a[0]) - severityRank(b[0])).map(([sev, list]) => group('threat', titled(sev), list));
  if (none.length > 0) children.push(group('threat', 'Unrated', none));
  return bucket('threat', entries, children);
}

function worldBucket(entries: Item[]): Node {
  const { groups, none } = groupBy(entries, (e) => e.data.category);
  const children = groups.sort(bySize).map(([cat, list]) => group('worldbuilding', capital(cat), list));
  if (none.length > 0) children.push(group('worldbuilding', 'General', none));
  return bucket('worldbuilding', entries, children);
}

/** Summaries group by `parent_plot`, plots in name order (RoleCall :476-500); a plot's arc overview sits first in its arc. */
function narrativeNode(entries: Item[]): Node {
  const { groups, none } = groupBy(
    [...entries].sort((a, b) => Number(b.arc !== null) - Number(a.arc !== null)),
    (e) => e.arc ?? e.data.parent_plot,
  );
  const children = groups.sort((a, b) => a[0].localeCompare(b[0], 'en')).map(([plot, list]) => group('summary', plot, list));
  if (none.length > 0) children.push(group('summary', 'Unlinked Summaries', none));
  return bucket('summary', entries, children);
}

function bestiaryBucket(entries: Item[]): Node {
  const { groups, none } = groupBy(entries, (e) => e.data.classification);
  const children = groups.sort(bySize).map(([cls, list]) => group('creature', capital(cls), list));
  if (none.length > 0) children.push(group('creature', 'Unclassified', none));
  return bucket('creature', entries, children);
}

const BUILDERS: Partial<Record<EntryType, (entries: Item[]) => Node>> = {
  character: castBucket,
  location: placesBucket,
  event: eventsBucket,
  threat: threatsBucket,
  worldbuilding: worldBucket,
  summary: narrativeNode,
  creature: bestiaryBucket,
};

/** The number of entries on a node and below it. */
export function entryCountOf(node: TreeNode): number {
  return node.entryIds.length + node.children.reduce((n, c) => n + entryCountOf(c), 0);
}

export interface TreeStats {
  nodeCount: number;
  maxDepth: number;
  leafCount: number;
}

/** Nodes, depth (the root is 1) and leaves of a tree. */
export function treeStats(root: TreeNode): TreeStats {
  const stats = { nodeCount: 0, maxDepth: 0, leafCount: 0 };
  const walk = (node: TreeNode, depth: number): void => {
    stats.nodeCount += 1;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (node.children.length === 0) stats.leafCount += 1;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 1);
  return stats;
}

const rootOf = (label: string, children: Node[], total: number, what: string): Node => ({
  id: 'root',
  label,
  summary: `${total} entries across ${children.length} ${what}`,
  entryIds: [],
  children,
  entryCount: total,
});

function typedTree(label: string, enabled: Item[]): Node {
  const children: Node[] = [];
  for (const type of ENTRY_TYPES) {
    const list = enabled.filter((e) => e.type === type || (type === 'summary' && e.arc !== null));
    if (list.length > 0) children.push(BUILDERS[type]?.(list) ?? bucket(type, list, [], true));
  }
  const unsorted = enabled.filter((e) => e.type === null && e.arc === null);
  if (unsorted.length > 0) {
    children.push({
      id: 'bucket:unsorted',
      label: 'Unsorted',
      summary: `${unsorted.length} entries without a compendium type`,
      entryIds: unsorted.map((e) => e.id),
      children: [],
      entryCount: unsorted.length,
    });
  }
  return rootOf(label, children, enabled.length, 'compendium buckets');
}

const GENERAL = 'general';

function categoryTree(label: string, enabled: Item[]): Node {
  const byName = new Map<string, Item[]>();
  const general: Item[] = [];
  for (const e of enabled) {
    const name = e.category?.trim() ?? '';
    if (name === '' || name.toLowerCase() === GENERAL) general.push(e);
    else byName.set(name, [...(byName.get(name) ?? []), e]);
  }
  const children = [...byName].map(([name, list]) => leaf(`category:${encodeURIComponent(name)}`, name, list));
  if (general.length > 0) children.push(leaf(`category:${GENERAL}`, 'General', general));
  return rootOf(label, children, enabled.length, 'categories');
}

function toItem(e: CEntry, categoryOf: DeriveTreeOptions['categoryOf']): Item {
  return { id: e.key, title: e.name, type: e.type, arc: e.arc ?? null, data: e.data, category: categoryOf?.(e) ?? null };
}

/** Drops the internal counts, so callers get plain TreeNodes. */
function plain(node: Node): TreeNode {
  return { id: node.id, label: node.label, summary: node.summary, entryIds: node.entryIds, children: (node.children as Node[]).map(plain) };
}

/**
 * Bunraku's exported narrativeBucket (for M5b's historian and the {{recap}} slot): the Narrative bucket
 * of a set of entries, as the typed tree builds it. Only their live summaries and arcs are read; each
 * plot (an arc's plot, else a summary's `parent_plot`) is one child in 'en' name order with its arc
 * first, then 'Unlinked Summaries'. Node `entryIds` are entry keys.
 */
export function narrativeBucket(entries: readonly CEntry[]): TreeNode {
  const items = entries.filter((e) => e.retired === undefined && (e.type === 'summary' || e.arc !== undefined)).map((e) => toItem(e, undefined));
  return plain(narrativeNode(items));
}

/**
 * The tree of a set of entries (a session's, or one book's with its overlays): typed buckets when at
 * least TYPED_MINIMUM entries are live and at least TYPED_THRESHOLD of them are typed, else the
 * category tree. Retired entries are left out. Node `entryIds` are entry keys.
 */
export function deriveTree(entries: readonly CEntry[], opts: DeriveTreeOptions = {}): TreeNode {
  const enabled = entries.filter((e) => e.retired === undefined).map((e) => toItem(e, opts.categoryOf));
  const label = opts.rootLabel ?? 'World Knowledge';
  return plain(shouldUseTyped(entries).use ? typedTree(label, enabled) : categoryTree(label, enabled));
}
