// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The non-turn subcommands of M1a: `new`, `import`, `sessions`, `show` (ARCHITECTURE.md §12.3,
// §15 M1a, D-72). `sessions` and `show` never take the session lock: they read the journal with
// readSessionFile/listSessions and fold it themselves, so they work while another process runs a
// turn. The price is that they never recover anything (recovery only runs on a locked open), so
// `show` says so when the journal has turns without a closing line.

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Engine } from '../engine/engine.ts';
import type { EngineOptions } from '../engine/api.ts';
import { openTurns } from '../engine/recover.ts';
import { parseModelRef } from '../engine/route.ts';
import { systemClock } from '../engine/system.ts';
import { importFile, ImportError } from '../formats/import.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { validateCharacter, validatePersona, type Character, type ImportWarning, type Persona } from '../formats/native.ts';
import type { DeepPartial, Entry, SessionConfig } from '../session/entries.ts';
import { foldView } from '../session/fold.ts';
import { DEFAULT_LOCK_TTL_MS, isLockStale, listSessions, readLock, readSessionFile, SessionNotFoundError } from '../session/log.ts';
import { UsageError } from './args.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { messageText, renderPath, renderSessions } from './render.ts';

/** A failure the user can fix (bad input file, missing session): one stderr line, exit 1. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT.error) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function warn(io: Io, warnings: readonly ImportWarning[]): void {
  for (const w of warnings) io.err.write(`rp-core: warning: ${w.message}${w.path ? ` (${w.path})` : ''}\n`);
}

function readJsonFile(file: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new CliError(`cannot read ${what} ${file}: ${errMessage(e)}`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (e) {
    throw new CliError(`${what} ${file} is not valid JSON: ${errMessage(e)}`);
  }
}

// ---- import --------------------------------------------------------------------------------------

export interface ImportArgs {
  home: string;
  file: string;
  as?: string;
  json: boolean;
  io: Io;
}

/** `rp-core import <file> [--as name]`: detect, convert, save to the library [D-72]. */
export function cmdImport(a: ImportArgs): number {
  let r: ReturnType<typeof importFile>;
  try {
    r = importFile(a.home, a.file, a.as !== undefined ? { as: a.as } : undefined);
  } catch (e) {
    if (e instanceof ImportError) throw new CliError(`import failed: ${e.message}`);
    throw e;
  }
  if (a.json) {
    a.io.out.write(`${JSON.stringify({ kind: r.kind, id: r.id, path: r.path, name: r.value.name, warnings: r.warnings })}\n`);
  } else {
    warn(a.io, r.warnings);
    a.io.out.write(`${r.id}\n`);
    a.io.err.write(`rp-core: imported ${r.kind} "${r.value.name}" as ${r.path}\n`);
  }
  return EXIT.done;
}

// ---- new -----------------------------------------------------------------------------------------

export interface NewArgs {
  home: string;
  card: string;
  persona?: string;
  model?: string;
  title?: string;
  json: boolean;
  io: Io;
  engine?: Partial<EngineOptions>;
}

/** --card is a file (imported into the library) or, when no such file exists, a library id. */
function resolveCard(a: NewArgs): { character: Character; warnings: ImportWarning[]; libraryId: string; imported: boolean } {
  if (existsSync(a.card)) {
    try {
      const r = importFile(a.home, a.card);
      return { character: r.value, warnings: r.warnings, libraryId: r.id, imported: true };
    } catch (e) {
      if (e instanceof ImportError) throw new CliError(`cannot use the card: ${e.message}`);
      throw e;
    }
  }
  let raw: unknown = null;
  try {
    raw = loadFromLibrary(a.home, 'characters', a.card);
  } catch (e) {
    // An id that could never name a library file is just "not found" here.
    if (!(e instanceof Error) || !e.message.startsWith('invalid library id')) throw new CliError(errMessage(e));
  }
  if (raw === null) throw new CliError(`no card file and no library character named ${JSON.stringify(a.card)}`);
  const v = validateCharacter(raw);
  if (!v.ok) {
    const first = v.errors[0];
    throw new CliError(`library character ${a.card} is invalid (${first?.path || '(root)'}: ${first?.message})`);
  }
  return { character: v.value, warnings: [], libraryId: a.card, imported: false };
}

function resolvePersona(file: string): Persona {
  const v = validatePersona(readJsonFile(file, 'persona'));
  if (!v.ok) {
    const why = v.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
    throw new CliError(`persona ${file} is invalid: ${why}`);
  }
  return v.value;
}

/** Greeting roots as stored (macros expanded), in file order. */
function greetingsOf(entries: readonly Entry[]): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const e of entries) {
    if (e.t === 'msg' && e.parent === null && e.gen?.kind === 'greeting') out.push({ id: e.id, text: messageText({ blocks: e.blocks ?? [] }) });
  }
  return out;
}

/** `rp-core new --card <file>`: import the card, create the session, print its id. */
export async function cmdNew(a: NewArgs): Promise<number> {
  let config: DeepPartial<SessionConfig> | undefined;
  if (a.model !== undefined) {
    const ref = parseModelRef(a.model);
    if (!ref) throw new UsageError(`--model must be conn:model, got ${JSON.stringify(a.model)}`, 'new');
    config = { roles: { narrator: { conn: ref.conn, model: ref.model } } };
  }
  const persona = a.persona !== undefined ? resolvePersona(a.persona) : undefined;
  const card = resolveCard(a);
  warn(a.io, card.warnings);

  const engine = await Engine.open({ ...a.engine, home: a.home });
  let sessionId: string;
  let title: string | undefined;
  try {
    const s = engine.createSession({
      character: card.character,
      ...(persona ? { persona } : {}),
      ...(config ? { config } : {}),
      ...(a.title !== undefined ? { title: a.title } : {}),
    });
    sessionId = s.id;
    title = s.header().title;
    await s.close();
  } finally {
    await engine.close();
  }
  const greetings = greetingsOf(readSessionFile(a.home, sessionId).entries);

  if (a.json) {
    a.io.out.write(`${JSON.stringify({ sessionId, title: title ?? null, greetings })}\n`);
  } else {
    a.io.out.write(`${sessionId}\n`);
    const how = card.imported ? `card imported as library character ${card.libraryId}` : `library character ${card.libraryId}`;
    const n = greetings.length;
    a.io.err.write(`rp-core: created session ${sessionId} "${title ?? ''}" with ${n} greeting${n === 1 ? '' : 's'} (${how})\n`);
  }
  return EXIT.done;
}

// ---- sessions / show -----------------------------------------------------------------------------

export function cmdSessions(a: { home: string; json: boolean; io: Io }): number {
  const rows = listSessions(a.home);
  if (a.json) a.io.out.write(`${JSON.stringify(rows)}\n`);
  else if (rows.length === 0) a.io.err.write(`rp-core: no sessions in ${a.home}\n`);
  else a.io.out.write(renderSessions(rows));
  return EXIT.done;
}

/**
 * What to tell the user about turns with no closing line. A live lock means a turn is running in
 * another process right now; otherwise the turns were interrupted and wait for recovery.
 */
export function unclosedTurnsHint(home: string, id: string, entries: readonly Entry[]): string | null {
  const open = openTurns(entries);
  if (open.length === 0) return null;
  const lock = readLock(home, id);
  if (lock && !isLockStale(lock, systemClock(), DEFAULT_LOCK_TTL_MS, hostname())) {
    return `a turn is running in process ${lock.pid} on ${lock.host}; its answer appears when it ends`;
  }
  const held = open.filter((t) => t.held).length;
  const crashed = open.length - held;
  const parts: string[] = [];
  if (crashed > 0) {
    const chars = open.filter((t) => !t.held).reduce((n, t) => n + t.text.length, 0);
    parts.push(
      `${crashed} interrupted turn${crashed === 1 ? '' : 's'} (${chars} chars of partial text) not shown yet: ` +
        'the next `rp-core send` on this session recovers them, keeping partial text marked [interrupted]',
    );
  }
  if (held > 0) parts.push(`${held} answer${held === 1 ? '' : 's'} held by a conflict await a decision`);
  return parts.join('; ');
}

/** `rp-core show <session>`: the active path, without the lock. */
export function cmdShow(a: { home: string; id: string; json: boolean; io: Io }): number {
  let file: ReturnType<typeof readSessionFile>;
  try {
    file = readSessionFile(a.home, a.id);
  } catch (e) {
    if (e instanceof SessionNotFoundError) throw new CliError(`no session ${a.id} in ${a.home}`);
    throw e;
  }
  for (const n of file.notices) a.io.err.write(`rp-core: warning: ${n.message}${n.line ? ` (line ${n.line})` : ''}\n`);
  const view = foldView(file.header, file.entries);
  if (a.json) a.io.out.write(`${JSON.stringify(view.path)}\n`);
  else a.io.out.write(renderPath(view, file.header));
  const hint = unclosedTurnsHint(a.home, a.id, file.entries);
  if (hint) a.io.err.write(`rp-core: hint: ${hint}\n`);
  return EXIT.done;
}
