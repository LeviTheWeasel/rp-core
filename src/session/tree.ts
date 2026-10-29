// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The message tree (ARCHITECTURE.md §5.3, §5.5). Pure functions over entries.
// CONTRACT FILE: signatures are fixed; the storage agent implements the bodies.
//
// Invariants buildTree guarantees (and the property tests check):
// - every message in `msgs` with a non-null parent has that parent in `msgs` (a message whose parent
//   is unknown, e.g. because the parent's line was corrupt, is left out together with its subtree);
// - a parent always has a smaller seq than its children, so the tree has no cycles and walking
//   parents always ends at a root;
// - a duplicate message id keeps the first message; later duplicates are ignored.

import type { Block, EditEntry, Entry, Generation, JobEntry, MemEntry, MsgEntry } from './entries.ts';

export interface TreeIndex {
  msgs: Map<string, MsgEntry>;
  /** Children ids ordered by seq. Key null = roots. */
  children: Map<string | null, string[]>;
  /** Edits by target, in seq order. */
  edits: Map<string, EditEntry[]>;
  /** Latest hide state per message (absent = visible). */
  hidden: Map<string, boolean>;
  /**
   * Leaf of the active path: the newest msg (not counting tail commits), or the newest explicit
   * head entry, whichever is later.
   */
  head: string | null;
  /** seq of the last msg/edit/hide/head entry; 0 when there is none. */
  version: number;
  /**
   * M3: every `mem` row in seq order (mem rows are not part of the tree or the version, but the
   * Compendium fold reads them, also for a view folded at another leaf).
   */
  mems: MemEntry[];
  /** M3: seq of the last mem row; 0 when there is none. Views are cached on (version, lastMemSeq). */
  lastMemSeq: number;
  /**
   * M5a (D-143): per message, the seq of its newest `edit` entry (any reason, continue included) or
   * `hide` entry with hidden:true. An agent mem row whose range holds a message touched after the row
   * is stale. An un-hide touches nothing.
   */
  touched: Map<string, number>;
  /**
   * M5b (.notes/m5b-decisions.md D-171, D-179): the `job` rows of the background lane by task key, each
   * list in seq order (begin, failed and retry rows; not part of the tree or the version). The lane
   * reads them for parking (failures since the key's newest `mem` or retry row) and for recovery at
   * open (a begin with no `mem` row of the key after it and no later `failed`).
   */
  jobs: Map<string, JobEntry[]>;
}

/** Entries are expected in seq order (the log guarantees it); anything else is sorted first. */
function inSeqOrder(entries: readonly Entry[]): readonly Entry[] {
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.seq <= entries[i - 1]!.seq) return [...entries].sort((a, b) => a.seq - b.seq);
  }
  return entries;
}

export function buildTree(entries: readonly Entry[]): TreeIndex {
  const msgs = new Map<string, MsgEntry>();
  const children = new Map<string | null, string[]>();
  const edits = new Map<string, EditEntry[]>();
  const hidden = new Map<string, boolean>();
  let head: string | null = null;
  let version = 0;
  const mems: MemEntry[] = [];
  let lastMemSeq = 0;
  const touched = new Map<string, number>();
  const jobs = new Map<string, JobEntry[]>();
  const touch = (id: string, seq: number): void => {
    if ((touched.get(id) ?? 0) < seq) touched.set(id, seq);
  };

  for (const e of inSeqOrder(entries)) {
    switch (e.t) {
      case 'msg': {
        version = e.seq;
        if (msgs.has(e.id)) break;
        if (e.parent !== null && !msgs.has(e.parent)) break; // orphan: its parent is not in the tree
        msgs.set(e.id, e);
        const kids = children.get(e.parent);
        if (kids) kids.push(e.id);
        else children.set(e.parent, [e.id]);
        // A new message moves the head onto itself, except an answer committed as a tail (§6.6).
        if (e.tail !== true) head = e.id;
        break;
      }
      case 'edit': {
        version = e.seq;
        if (!msgs.has(e.target)) break;
        const list = edits.get(e.target);
        if (list) list.push(e);
        else edits.set(e.target, [e]);
        touch(e.target, e.seq);
        break;
      }
      case 'hide':
        version = e.seq;
        if (!msgs.has(e.target)) break;
        hidden.set(e.target, e.hidden);
        if (e.hidden === true) touch(e.target, e.seq);
        break;
      case 'head':
        version = e.seq;
        if (msgs.has(e.leaf)) head = e.leaf;
        break;
      case 'persona':
        version = e.seq;
        break;
      case 'mem':
        // Not part of the tree or the version; collected for the Compendium fold (M3).
        mems.push(e);
        lastMemSeq = e.seq;
        break;
      case 'job': {
        // Not part of the tree or the version; indexed for the lane (M5b).
        const list = jobs.get(e.key);
        if (list) list.push(e);
        else jobs.set(e.key, [e]);
        break;
      }
      default:
        break; // config, turn, prep, chk, held, end: not part of the tree or the version
    }
  }
  // An unknown leaf in a head entry, or an orphan msg, still counts for version: version is a
  // property of the log (the commit guard), not of what the tree could use.
  return { msgs, children, edits, hidden, head, version, mems, lastMemSeq, touched, jobs };
}

/** Ids from the root down to `leaf` (inclusive). [] for null. */
export function pathTo(idx: TreeIndex, leaf: string | null): string[] {
  const out: string[] = [];
  let cur = leaf;
  while (cur !== null) {
    const m = idx.msgs.get(cur);
    if (!m) return []; // unknown leaf: no path
    out.push(cur);
    cur = m.parent;
  }
  return out.reverse();
}

/** All children of the same parent (including `id`), ordered by seq. */
export function siblings(idx: TreeIndex, id: string): string[] {
  const m = idx.msgs.get(id);
  if (!m) return [];
  return idx.children.get(m.parent) ?? [id];
}

/**
 * The versions of message `id` (including it), ordered by seq: its siblings of the same role and,
 * for an assistant message, of the same kind (greetings among greetings, generated answers among
 * answers). A rewind onto the player's own line puts their next line beside the old answers under one
 * parent; it is a new branch, not a version of those answers, so it is neither counted as a swipe
 * nor reached by browsing them. [] for an unknown id.
 */
export function swipeSiblings(idx: TreeIndex, id: string): string[] {
  const m = idx.msgs.get(id);
  if (!m) return [];
  const greeting = m.gen?.kind === 'greeting';
  const all = idx.children.get(m.parent) ?? [id];
  return all.filter((sid) => {
    const s = idx.msgs.get(sid);
    return s !== undefined && s.role === m.role && (s.gen?.kind === 'greeting') === greeting;
  });
}

/** Follow the newest child repeatedly from `id` down to a leaf (selecting an old swipe). */
export function newestDescendant(idx: TreeIndex, id: string): string {
  let cur = id;
  for (;;) {
    const kids = idx.children.get(cur);
    if (!kids || kids.length === 0) return cur;
    cur = kids[kids.length - 1]!;
  }
}

/** Leaves not on the active path. */
export function tails(idx: TreeIndex, pathSet: ReadonlySet<string>): string[] {
  const out: string[] = [];
  // Map iteration is insertion order = seq order, so tails come oldest first.
  for (const id of idx.msgs.keys()) {
    const kids = idx.children.get(id);
    if ((!kids || kids.length === 0) && !pathSet.has(id)) out.push(id);
  }
  return out;
}

/**
 * Effective blocks of a message: the latest edit that carries `blocks` replaces the original.
 * A continue edit also brings its `gen`, which replaces the message's gen.
 *
 * `edited` is true when a user edit (reason 'user') with blocks applies: a continue is the model
 * extending its own text, not a human change, so it alone does not mark the message edited.
 */
export function effectiveMessage(
  idx: TreeIndex,
  id: string,
): { blocks: Block[]; edited: boolean; gen?: Generation } {
  const m = idx.msgs.get(id);
  if (!m) return { blocks: [], edited: false };
  let blocks: Block[] = m.blocks ?? [];
  let gen = m.gen;
  let edited = false;
  for (const e of idx.edits.get(id) ?? []) {
    if (e.blocks) {
      blocks = e.blocks;
      if (e.reason === 'user') edited = true;
    }
    if (e.reason === 'continue' && e.gen) gen = e.gen;
  }
  return gen ? { blocks, edited, gen } : { blocks, edited };
}
