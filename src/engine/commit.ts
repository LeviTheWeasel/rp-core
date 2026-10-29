// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Where a finished turn lands in the tree (ARCHITECTURE.md §5.3 "Атомарный коммит", §6.6 table of
// the unconditional commit, §6.7). Shared by the live turn (guard on `base`) and by recovery.
//
// - Version unchanged since the turn began: one `msg` (reply/swipe) or one `edit` (continue).
// - Version moved (a conflict): reply/swipe still go under the original parent U, never under an
//   assistant message; if the head went elsewhere the answer becomes a tail (one msg with
//   `tail: true`, which leaves the head where it is) and the caller says `committed_as_tail`; if U is hidden or gone the turn ends `dropped`. A continue
//   is applied only when its target is visible and its text is the one the turn started from;
//   otherwise it ends `abandoned` (recovery) or `discarded` (live, §6.6).

import { continuationResult } from '../prompt/shape.ts';
import type { Block, EditEntry, EndEntry, EntryInput, MsgEntry, TurnEntry, CommitBody, HeldEntry } from '../session/entries.ts';
import { effectiveMessage, type TreeIndex } from '../session/tree.ts';
import type { MessageView } from '../session/view.ts';

/** The slice of the session the commit needs. */
export interface Journal {
  tree(): TreeIndex;
  version(): number;
  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number };
  now(): string;
}

export interface CommitPlan {
  turn: TurnEntry;
  /** reply/swipe: the blocks of the answer (reasoning first, then text; tool rounds interleaved, §5.6). */
  blocks: Block[];
  /** continue: the streamed text as it came (an echo of the base is stripped here). */
  addition: string;
  /** continue: how the addition joins, and the target's text when the turn began. */
  cont?: { mode: 'prefill' | 'cue'; base: string };
  body: Omit<CommitBody, 'blocks'>;
  /** What a continue on a changed or hidden target ends as. */
  continueConflict: 'abandoned' | 'discarded';
}

export type Placed =
  | { kind: 'msg'; entry: MsgEntry; tail: boolean }
  | { kind: 'edit'; entry: EditEntry }
  | { kind: 'held'; entry: HeldEntry }
  | { kind: 'end'; entry: EndEntry };

/** The text a model reads from a message: its effective text blocks, joined. */
export function effectiveText(idx: TreeIndex, id: string): string {
  let s = '';
  for (const b of effectiveMessage(idx, id).blocks) if (b.k === 'text') s += b.text;
  return s;
}

/**
 * The MessageView of any message, on the path or not (a tail has no place in PathView.path). Same
 * fields as session/fold.ts computes for path messages.
 */
export function messageViewOf(idx: TreeIndex, id: string): MessageView {
  const m = idx.msgs.get(id);
  if (!m) throw new Error(`no message ${id}`);
  const sibs = idx.children.get(m.parent) ?? [id];
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

/** Copy only the optional body fields that are set (the log refuses undefined-shaped noise). */
function bodyFields(body: CommitPlan['body']): Partial<CommitBody> {
  const out: Partial<CommitBody> = {};
  if (body.gen) out.gen = body.gen;
  if (body.trace) out.trace = body.trace;
  if (body.dir) out.dir = body.dir;
  if (body.recall) out.recall = body.recall;
  if (body.vars && Object.keys(body.vars).length > 0) out.vars = body.vars;
  return out;
}

/**
 * A continued message's blocks, its text now `full` (the old text and the addition). Without tool
 * blocks: the other blocks, then one text block (M1). M3 (B16): with tool rounds the block order
 * stays and the addition goes to the LAST text block, the earlier text blocks unchanged (when `full`
 * still starts with them; else the M1 layout, so the text is right whatever the order).
 */
export function continuedBlocks(blocks: readonly Block[], full: string): Block[] {
  const plain = (): Block[] => [...blocks.filter((b) => b.k !== 'text'), { k: 'text', text: full }];
  if (!blocks.some((b) => b.k === 'tool_call' || b.k === 'tool_result')) return plain();
  let lastText = -1;
  blocks.forEach((b, i) => {
    if (b.k === 'text') lastText = i;
  });
  if (lastText < 0) return plain();
  let before = '';
  for (let i = 0; i < lastText; i++) {
    const b = blocks[i]!;
    if (b.k === 'text') before += b.text;
  }
  if (!full.startsWith(before)) return plain();
  return blocks.map((b, i) => (i === lastText ? { k: 'text', text: full.slice(before.length) } : b));
}

function end(j: Journal, turn: TurnEntry, outcome: EndEntry['outcome'], code?: string): Placed {
  const entry = j.append({ t: 'end', ts: j.now(), turn: turn.turn, outcome, ...(code ? { code } : {}) });
  return { kind: 'end', entry };
}

export function placeCommit(j: Journal, plan: CommitPlan): Placed {
  const { turn } = plan;
  const idx = j.tree();
  const conflict = j.version() !== turn.base;

  if (turn.kind === 'continue') {
    const target = turn.target ?? turn.msgId;
    const cont = plan.cont;
    if (!idx.msgs.has(target) || !cont) return end(j, turn, plan.continueConflict);
    // Never apply text written for one version of a reply to another one unasked (§6.6).
    if (conflict && (idx.hidden.get(target) === true || effectiveText(idx, target) !== cont.base)) {
      return end(j, turn, plan.continueConflict);
    }
    const full = continuationResult(cont.base, plan.addition, cont.mode).full;
    const entry = j.append({
      t: 'edit',
      ts: j.now(),
      target,
      reason: 'continue',
      turn: turn.turn,
      blocks: continuedBlocks(effectiveMessage(idx, target).blocks, full),
      ...bodyFields(plan.body),
    });
    return { kind: 'edit', entry };
  }

  const parent = turn.parent;
  if (!idx.msgs.has(parent) || (conflict && idx.hidden.get(parent) === true)) return end(j, turn, 'dropped');
  const headBefore = idx.head;
  // The head follows the answer only where it would have been anyway: on U for a reply, on a child
  // of U (a sibling) for a swipe. Anywhere else the user moved on and the answer is a tail. The
  // decision rides the msg line itself (`tail: true`), so the commit stays one atomic line (§5.3):
  // a crash can never leave the head on a tail.
  const follows =
    !conflict || headBefore === null || (turn.kind === 'reply' ? headBefore === parent : idx.msgs.get(headBefore)?.parent === parent);
  const tail = !follows;
  const entry = j.append({
    t: 'msg',
    ts: j.now(),
    id: turn.msgId,
    parent,
    role: 'assistant',
    turn: turn.turn,
    ...(tail ? { tail: true as const } : {}),
    blocks: plan.blocks,
    ...bodyFields(plan.body),
  });
  return { kind: 'msg', entry, tail };
}
