// Ported from Bunraku:src/studio/scene-turn-resume.ts (resumeScene)@702d81201120a6b90eb29a783a77c60ffdebc374.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Crash recovery on open (ARCHITECTURE.md §6.7): every `turn` without a closing `msg`/`edit` (with
// that turn id) or `end` is resolved once, after the lock is taken and before anything else runs.
//
// | found           | done                                                                  |
// |-----------------|-----------------------------------------------------------------------|
// | a `held`        | left open (new turns are refused held_pending until it is decided, M6)|
// | text in `chk`   | committed with finish 'interrupted'; dir/recall/vars and the trace    |
// |                 | (partial:true) from `prep`; guarded by `base`, else the unconditional |
// |                 | commit rule (commit.ts); a continue on a changed target → abandoned,  |
// |                 | a reply/swipe whose U is hidden → dropped; both hand back the draft   |
// | nothing         | end{abandoned}                                                        |
//
// Port notes: Bunraku's rule (a crash keeps what arrived; an empty checkpoint is dropped; a
// continue that finds the version moved is dropped) is kept. Changed: a conflicting reply/swipe is
// not committed "at the end of the take" unguarded but under its original parent U, as a tail when
// the head moved, and dropped when U is hidden; the tool loop is never resumed; no module-level
// `running` set (the engine recovers before it can start a turn on the session).
//
// M1b: the checkpointed text goes through the same post-processing as a live answer before it
// commits (§6.2 step 9, D-57): leaked tool-call markup is stripped, with one notice per open.

import { continuationResult } from '../prompt/shape.ts';
import { stripToolCallLeaks } from '../tools/leaks.ts';
import type { Entry, Generation, PrepEntry, TurnEntry } from '../session/entries.ts';
import type { Notice } from '../protocol/events.ts';
import { placeCommit, type Journal } from './commit.ts';

export interface RecoverJournal extends Journal {
  entries(): readonly Entry[];
}

export type RecoveryEvent =
  | { type: 'recovered'; turnId: string; outcome: 'interrupted' | 'abandoned' | 'dropped'; draft?: string }
  | ({ type: 'notice' } & Notice);

export interface RecoveryReport {
  events: RecoveryEvent[];
  /** Turns left open because they hold an answer awaiting a decision. */
  held: string[];
}

interface OpenTurn {
  turn: TurnEntry;
  prep?: PrepEntry;
  text: string;
  held: boolean;
}

/** Turns with no closing line, in the order they began. */
export function openTurns(entries: readonly Entry[]): OpenTurn[] {
  const open = new Map<string, OpenTurn>();
  for (const e of entries) {
    switch (e.t) {
      case 'turn':
        open.set(e.turn, { turn: e, text: '', held: false });
        break;
      case 'prep': {
        const o = open.get(e.turn);
        if (o && !o.prep) o.prep = e;
        break;
      }
      case 'chk': {
        const o = open.get(e.turn);
        if (o) o.text += e.text;
        break;
      }
      case 'held': {
        const o = open.get(e.turn);
        if (o) o.held = true;
        break;
      }
      case 'msg':
      case 'edit':
        if (e.turn !== undefined) open.delete(e.turn);
        break;
      case 'end':
        open.delete(e.turn);
        break;
      default:
        break;
    }
  }
  return [...open.values()];
}

/** The generation a recovered answer carries: who was asked (from `prep`) and that it was cut short. */
function recoveredGen(prep: PrepEntry | undefined): Generation {
  const gen: Generation = { kind: 'model', finish: 'interrupted' };
  // The primary binding: a crash during a fallback attempt is still labelled with the primary.
  if (prep?.model) {
    gen.connection = prep.model.connection;
    gen.model = prep.model.model;
  }
  if (prep?.prefill) gen.prefill = prep.prefill;
  return gen;
}

export function recoverSession(j: RecoverJournal): RecoveryReport {
  const events: RecoveryEvent[] = [];
  const held: string[] = [];
  let strippedNoticed = false;

  for (const o of openTurns(j.entries())) {
    const { turn, prep } = o;
    if (o.held) {
      held.push(turn.turn);
      continue;
    }
    const abandon = (): void => {
      j.append({ t: 'end', ts: j.now(), turn: turn.turn, outcome: 'abandoned' });
      events.push({ type: 'recovered', turnId: turn.turn, outcome: 'abandoned' });
    };

    // Post-processing (D-57), as a live turn does before its commit.
    const leaks = stripToolCallLeaks(o.text);
    const text = leaks.text;
    if (leaks.stripped > 0 && !strippedNoticed) {
      strippedNoticed = true;
      events.push({
        type: 'notice',
        level: 'info',
        code: 'tool_markup_stripped',
        message: 'Leaked tool-call markup was removed from an interrupted answer; the model wrote tool calls as text.',
      });
    }

    // Nothing worth keeping: no text at all, or (continue) nothing beyond an echo of the base.
    const cont = prep?.cont;
    const hasText =
      turn.kind === 'continue'
        ? cont !== undefined && continuationResult(cont.base, text, cont.mode).addition !== ''
        : text.trim() !== '';
    if (!hasText) {
      abandon();
      continue;
    }

    const placed = placeCommit(j, {
      turn,
      blocks: [{ k: 'text', text }],
      addition: text,
      ...(cont ? { cont } : {}),
      body: {
        gen: recoveredGen(prep),
        ...(prep ? { trace: { ...prep.trace, partial: true as const } } : {}),
        ...(prep?.dir ? { dir: prep.dir } : {}),
        ...(prep?.recall ? { recall: prep.recall } : {}),
        ...(prep?.vars ? { vars: prep.vars } : {}),
      },
      continueConflict: 'abandoned',
    });
    if (placed.kind === 'end') {
      // The unconditional-commit rule ended it: U hidden (dropped) or a changed continue target
      // (abandoned). The text survives only in chk lines, which `compact` deletes, so it rides the
      // event as the draft (§6.6).
      const outcome = placed.entry.outcome === 'dropped' ? 'dropped' : 'abandoned';
      events.push({ type: 'recovered', turnId: turn.turn, outcome, draft: text });
      continue;
    }
    if (placed.kind === 'msg' && placed.tail) {
      events.push({
        type: 'notice',
        level: 'warn',
        code: 'committed_as_tail',
        message: `The interrupted answer ${placed.entry.id} was saved as a side branch: the conversation had moved on.`,
      });
    }
    events.push({ type: 'recovered', turnId: turn.turn, outcome: 'interrupted' });
  }
  return { events, held };
}
