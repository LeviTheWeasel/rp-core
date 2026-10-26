// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Fork: copy the path up to `at` into a new session file (ARCHITECTURE.md §5.3 "Форк").
// CONTRACT FILE: signature is fixed; the storage agent implements the body.
//
// The new file is written whole to a temp file, fsynced, and then linked into place without
// overwriting, so a crash never leaves a half-copied fork behind under the new id.

import { parseEntry } from './entries.ts';
import type { Entry, SessionHeader } from './entries.ts';
import { currentConfig } from './fold.ts';
import type { LogOptions, SessionLog } from './log.ts';
import { checkHeaderForCreate, isValidSessionId, openSessionLog, publishNewJournal } from './log.ts';
import { buildTree, pathTo } from './tree.ts';

/** Which source entries a fork copies: everything that belongs to the path, plus global mem rows. */
function belongsToPath(e: Entry, pathSet: ReadonlySet<string>): boolean {
  switch (e.t) {
    case 'msg':
      return pathSet.has(e.id);
    case 'edit':
    case 'hide':
      return pathSet.has(e.target);
    case 'mem':
      return e.on === null || pathSet.has(e.on);
    default:
      return false; // config is folded into the header; turn/prep/chk/held/end/job stay behind
  }
}

/** Build the fork's header and renumbered entries (pure; exported for tests and dry runs). */
export function planFork(
  source: { header: SessionHeader; entries: readonly Entry[] },
  at: string,
  opts: { newId: string; now: string },
): { header: SessionHeader; entries: Entry[] } {
  const idx = buildTree(source.entries);
  if (!idx.msgs.has(at)) throw new Error(`cannot fork: ${JSON.stringify(at)} is not a message of ${source.header.id}`);
  const pathIds = pathTo(idx, at);
  const pathSet = new Set(pathIds);

  // vars0 stays the source's: the copied path messages carry their own diffs, so the fork's head
  // folds to the same vars as the source at `at`, and a rewind inside the fork to an earlier
  // message does not see keys first set later on the path (a fork-point snapshot would leak them).
  const { title, vars0 } = source.header;
  const header: SessionHeader = {
    t: 'session',
    v: 1,
    id: opts.newId,
    created: opts.now,
    ...(title !== undefined ? { title } : {}),
    fork: { from: source.header.id, at },
    cast: source.header.cast,
    config: currentConfig(source.header, source.entries),
    ...(vars0 && Object.keys(vars0).length > 0 ? { vars0 } : {}),
  };

  const entries: Entry[] = [];
  let seq = 0;
  let lastMsg: string | null = null;
  for (const e of source.entries) {
    // Orphans and duplicate ids never made it into the tree, so they are not copied either.
    if (e.t === 'msg' && idx.msgs.get(e.id) !== e) continue;
    if (!belongsToPath(e, pathSet)) continue;
    if (e.t === 'msg' && e.tail) {
      // On the fork the path is the main line: a tail commit's "keep the head" no longer applies.
      const { tail: _tail, ...line } = e;
      entries.push({ ...line, seq: ++seq });
    } else entries.push({ ...e, seq: ++seq });
    if (e.t === 'msg') lastMsg = e.id;
  }
  // The newest copied msg is the fork's head; only if it is not `at` does the head need moving.
  if (lastMsg !== at) entries.push({ t: 'head', seq: ++seq, ts: opts.now, leaf: at });
  return { header, entries };
}

/**
 * New header: fork {from, at}, current config, same cast, `created` = now. Copies msg/edit/hide/mem
 * entries that belong to messages on the path up to `at` (inclusive) and mem with on:null,
 * renumbers seq, keeps message ids, and ends with a `head` on `at` if needed. Returns the new log
 * (locked). Throws if `at` is not a message of the source.
 */
export function forkSession(
  home: string,
  source: { header: SessionHeader; entries: readonly Entry[] },
  at: string,
  opts: { newId: string; now: string } & LogOptions,
): SessionLog {
  if (!isValidSessionId(opts.newId)) throw new Error(`invalid session id: ${JSON.stringify(opts.newId)}`);
  const plan = planFork(source, at, opts);
  const headerLine = checkHeaderForCreate(plan.header);
  const lines = [headerLine];
  for (const e of plan.entries) {
    const json = JSON.stringify(e);
    const r = parseEntry(json);
    if (!r.ok) throw new Error(`cannot fork: entry seq ${e.seq} would not read back (${r.why})`);
    lines.push(json);
  }

  // Temp file, fsync, link without overwriting, directory fsync: never a half-copied fork.
  publishNewJournal(home, opts.newId, Buffer.from(lines.join('\n') + '\n', 'utf8'));
  return openSessionLog(home, opts.newId, opts).log;
}
