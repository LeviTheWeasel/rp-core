// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core compact <session> [--json]` (ARCHITECTURE.md §5.3 D-35, .notes/m4-decisions.md D-114): open
// the session through the engine (so recovery closes an interrupted turn first), close it, then
// rewrite the journal under the session lock without the chk and prep rows of closed turns
// (session/log.ts compactSessionLog). The story, its versions and the Director's snapshots stay.
//
// Output: text mode prints "compacted <id>: <before> → <after> bytes (N lines removed)"; --json prints
// {"sessionId","before","after","removed"} (plus "kept" when rows stayed to keep the reader's view)
// as the one stdout line. The open's recovery events go to stderr: text lines, or with --json one JSON
// line each (the event objects send --json prints). A recovery that set a draft aside (an answer it
// could not save) stops compact before the rewrite, as the draft's only copy is in the rows compact
// removes (D-124): the draft is shown first, then the refusal `draft_recovered`. A refusal
// (session_locked, session_not_found, turn_open, draft_recovered) exits 5 with
// {"type":"refusal","code","message"} as the last stderr line, as send does.

import { Engine } from '../engine/engine.ts';
import { Refusal, type EngineOptions, type SessionHandle } from '../engine/api.ts';
import { compactSessionLog, SessionLockedError, SessionNotFoundError, TurnOpenError, type CompactResult } from '../session/log.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { describeEvent } from './render.ts';

export interface CompactArgs {
  home: string;
  sessionId: string;
  json: boolean;
  io: Io;
  /** Extra engine options (tests: clock, random). */
  engine?: Partial<EngineOptions>;
}

const HINT: Partial<Record<string, string>> = {
  session_locked: 'another rp-core process has this session open; close it first',
  turn_open: 'an answer held by a conflict waits for a decision (or a turn runs elsewhere); compact once it is closed',
  draft_recovered: 'save the draft above if you want it, then run compact again (that run removes it)',
};

/** A refusal: a line and a hint in text mode, the machine-readable line on stderr in both modes. */
function refuse(a: CompactArgs, code: string, message: string): number {
  if (!a.json) {
    a.io.err.write(`rp-core: refused (${code}): ${message}\n`);
    const hint = HINT[code];
    if (hint) a.io.err.write(`rp-core: hint: ${hint}\n`);
  }
  a.io.err.write(`${JSON.stringify({ type: 'refusal', code, message })}\n`);
  return EXIT.refused;
}

export async function cmdCompact(a: CompactArgs): Promise<number> {
  // 1. Open (lock + recovery) and close: an interrupted turn is committed or ended before the rewrite.
  // M5b (ruling H): the lane 'manual', so opening it starts no Compendium task the rewrite would cut off.
  const engine = await Engine.open({ ...a.engine, home: a.home, lane: 'manual' });
  /** The turn whose draft recovery set aside (shown, never saved): its chk rows are the only copy. */
  let draft: string | null = null;
  try {
    let session: SessionHandle;
    try {
      session = engine.session(a.sessionId);
    } catch (e) {
      if (e instanceof Refusal) return refuse(a, e.code, e.message);
      throw e;
    }
    for (const ev of session.openEvents()) {
      if (ev.type === 'recovered' && ev.draft !== undefined && ev.draft !== '') draft = ev.turnId;
      if (a.json) a.io.err.write(`${JSON.stringify(ev)}\n`);
      else {
        const line = describeEvent(ev);
        if (line !== null) a.io.err.write(`rp-core: ${line}\n`);
      }
    }
    await session.close();
  } finally {
    await engine.close();
  }
  if (draft !== null) {
    return refuse(
      a,
      'draft_recovered',
      `recovery set aside the partial answer of an interrupted turn (${draft}) that it could not save; ` +
        'its only copy is in the rows compact removes, so nothing was compacted',
    );
  }

  // 2. The rewrite, under the lock again (another process may have opened it meanwhile).
  let r: CompactResult;
  try {
    r = compactSessionLog(a.home, a.sessionId);
  } catch (e) {
    if (e instanceof TurnOpenError) return refuse(a, 'turn_open', e.message);
    if (e instanceof SessionLockedError) return refuse(a, 'session_locked', e.message);
    if (e instanceof SessionNotFoundError) return refuse(a, 'session_not_found', e.message);
    throw e;
  }
  if (a.json) {
    const kept = r.kept !== undefined ? { kept: r.kept } : {};
    a.io.out.write(`${JSON.stringify({ sessionId: a.sessionId, before: r.before, after: r.after, removed: r.removed, ...kept })}\n`);
  } else {
    let what = r.removed === 0 ? 'nothing to remove' : `${r.removed} line${r.removed === 1 ? '' : 's'} removed`;
    if (r.kept !== undefined) what += `; ${r.kept} kept: removing ${r.kept === 1 ? 'it' : 'them'} would change the lines the reader accepts`;
    a.io.out.write(`compacted ${a.sessionId}: ${r.before} → ${r.after} bytes (${what})\n`);
  }
  return EXIT.done;
}
