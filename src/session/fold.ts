// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// PathView: the one derived view (ARCHITECTURE.md §5.11). Recomputed per version, cached by caller.
// CONTRACT FILE: signature is fixed; the storage agent implements the body.
//
// Fold order (§19.2): path, edits, swipes, vars [D-30] → fires (M2 reads them) → directorAt (M4)
// → Compendium (M5). One linear pass over the tree index; the 10k-message benchmark lives in
// test/session/fold.test.ts.

import type { DeepPartial, Entry, SessionConfig, SessionHeader, VarsDiff } from './entries.ts';
import type { TreeIndex } from './tree.ts';
import { buildTree, effectiveMessage, pathTo, swipeSiblings, tails } from './tree.ts';
import type { MessageView, PathView } from './view.ts';

/** Apply one diff in place: null deletes, anything else sets. */
function applyVars(into: Record<string, string | number>, diff: VarsDiff | undefined): void {
  if (!diff) return;
  for (const k of Object.keys(diff)) {
    const v = diff[k];
    if (v === null || v === undefined) delete into[k];
    else into[k] = v;
  }
}

/**
 * Variables along a path [D-30]: vars0, then every committed diff of the path's messages (msg.vars
 * and the vars of edits targeting them) in seq order. Swipe siblings and rewound continuations are
 * off the path, so their diffs never count; a turn that did not commit wrote no diff.
 */
export function foldVars(header: SessionHeader, idx: TreeIndex, pathIds: readonly string[]): Record<string, string | number> {
  const vars: Record<string, string | number> = {};
  applyVars(vars, header.vars0);
  const diffs: { seq: number; vars: VarsDiff }[] = [];
  for (const id of pathIds) {
    const m = idx.msgs.get(id);
    if (m?.vars) diffs.push({ seq: m.seq, vars: m.vars });
    for (const e of idx.edits.get(id) ?? []) if (e.vars) diffs.push({ seq: e.seq, vars: e.vars });
  }
  // Path messages are already in seq order, but an edit of an early message can be newer than a
  // later message, so the diffs are ordered by seq explicitly.
  diffs.sort((a, b) => a.seq - b.seq);
  for (const d of diffs) applyVars(vars, d.vars);
  return vars;
}

/** Lore fires from the traces of path messages: the msg itself, then its continue edits by seq. */
function foldFires(idx: TreeIndex, pathIds: readonly string[]): PathView['fires'] {
  const out: PathView['fires'] = [];
  const push = (msgId: string, fired: unknown): void => {
    if (Array.isArray(fired) && fired.length > 0) out.push({ msgId, fired: fired as PathView['fires'][number]['fired'] });
  };
  for (const id of pathIds) {
    push(id, idx.msgs.get(id)?.trace?.lore?.fired);
    for (const e of idx.edits.get(id) ?? []) if (e.reason === 'continue') push(id, e.trace?.lore?.fired);
  }
  return out;
}

/** Character name, persona name and persona aliases; deduplicated, empty names dropped. */
function castNamesOf(header: SessionHeader): string[] {
  const { character, persona } = header.cast;
  const names = [character.name, persona?.name, ...(persona?.aliases ?? [])];
  const out: string[] = [];
  for (const n of names) if (typeof n === 'string' && n.length > 0 && !out.includes(n)) out.push(n);
  return out;
}

function messageView(idx: TreeIndex, id: string): MessageView {
  const m = idx.msgs.get(id)!;
  // Swipe position among the message's own versions (same role and kind), not every child of the parent.
  const sibs = swipeSiblings(idx, id);
  const eff = effectiveMessage(idx, id);
  const view: MessageView = {
    id,
    parent: m.parent,
    role: m.role,
    blocks: eff.blocks,
    hidden: idx.hidden.get(id) === true,
    edited: eff.edited,
    swipe: { index: sibs.indexOf(id), count: sibs.length },
  };
  if (eff.gen) view.gen = eff.gen;
  return view;
}

/** Build the PathView at the current head. Pass `idx` when the caller already built it. */
export function foldView(header: SessionHeader, entries: readonly Entry[], idx?: TreeIndex): PathView {
  const tree = idx ?? buildTree(entries);
  const pathIds = pathTo(tree, tree.head);
  const pathSet = new Set(pathIds);
  return {
    session: header.id,
    head: tree.head,
    version: tree.version,
    path: pathIds.map((id) => messageView(tree, id)),
    pathSet,
    tails: tails(tree, pathSet),
    vars: foldVars(header, tree, pathIds),
    fires: foldFires(tree, pathIds),
    castNames: castNamesOf(header),
  };
}

/**
 * The PathView with the head on `leaf` instead of the session's head: the state a turn starts from
 * when that is not the head (a swipe starts at U, before the answer it replaces, §6.3). Vars and
 * fires are folded along the path to `leaf` only.
 */
export function foldViewAt(header: SessionHeader, idx: TreeIndex, leaf: string): PathView {
  return foldView(header, [], { ...idx, head: leaf });
}

// ---- configuration fold ----------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deep merge of a config patch (JSON merge-patch semantics, RFC 7396): objects merge key by key,
 * arrays and scalars replace, null removes the key, undefined is ignored. Never mutates `base`.
 */
export function mergePatch<T>(base: T, patch: DeepPartial<T> | Record<string, unknown> | undefined): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (pv === undefined) continue;
    if (pv === null) delete out[k];
    else if (isPlainObject(pv)) out[k] = mergePatch(out[k], pv);
    else out[k] = pv;
  }
  return out as T;
}

/** The session's current config: the header's config with every `config` entry's patch applied in seq order. */
export function currentConfig(header: SessionHeader, entries: readonly Entry[]): SessionConfig {
  let config = header.config;
  for (const e of entries) if (e.t === 'config') config = mergePatch<SessionConfig>(config, e.patch);
  return config;
}
