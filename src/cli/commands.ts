// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The non-turn subcommands: `init` (M1b), `new`, `import`, `sessions`, `show` (ARCHITECTURE.md §12.3,
// §13, §15 M1a/M1b/M2, D-72). M2: `import` takes presets and world info too, `new` takes --preset and
// --lore. `sessions` and `show` never take the session lock: they read the journal
// with readSessionFile/listSessions and fold it themselves, so they work while another process runs a
// turn. The price is that they never recover anything (recovery only runs on a locked open), so
// `show` says so when the journal has turns without a closing line.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Engine } from '../engine/engine.ts';
import type { EngineHandle, EngineOptions, SessionHandle } from '../engine/api.ts';
import { CONFIG_TEMPLATE, configPath } from '../config/config.ts';
import { openTurns } from '../engine/recover.ts';
import { parseModelRef } from '../engine/route.ts';
import { systemClock } from '../engine/system.ts';
import { importCard, importFile, ImportError } from '../formats/import.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { validateCharacter, validatePersona, type Character, type ImportWarning, type Persona } from '../formats/native.ts';
import type { DeepPartial, Entry, SessionConfig } from '../session/entries.ts';
import { foldView, mergePatch } from '../session/fold.ts';
import { DEFAULT_LOCK_TTL_MS, isLockStale, listSessions, readLock, readSessionFile, SessionNotFoundError } from '../session/log.ts';
import { UsageError } from './args.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { addLoreId, RefError, resolveLoreRef, resolvePresetRef, type Resolved } from './refs.ts';
import { messageText, renderPath, renderSessions } from './render.ts';
import { connectionProblem, engineOptions, type Runtime } from './runtime.ts';

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

// ---- init ----------------------------------------------------------------------------------------

/**
 * `rp-core init`: write the starter config.toml (CONFIG_TEMPLATE) into the home unless one is there.
 * Never overwrites: the file is created exclusively, so even a race with an editor cannot clobber it.
 */
export function cmdInit(a: { home: string; json: boolean; io: Io }): number {
  const path = configPath(a.home);
  let created = false;
  try {
    mkdirSync(a.home, { recursive: true });
    writeFileSync(path, CONFIG_TEMPLATE, { flag: 'wx' });
    created = true;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== 'EEXIST') throw new CliError(`cannot write ${path}: ${errMessage(e)}`);
  }
  if (a.json) {
    a.io.out.write(`${JSON.stringify({ path, created })}\n`);
    return EXIT.done;
  }
  a.io.out.write(`${path}\n`);
  if (created) {
    a.io.err.write(
      `rp-core: wrote a starter config to ${path}\n` +
        'rp-core: next: edit [connections] and [roles] narrator, check the server with `rp-core probe <connection>`,\n' +
        'rp-core: then `rp-core new --card <file> --model <connection>:<model>`\n',
    );
  } else {
    a.io.err.write(`rp-core: ${path} already exists; left as it is (init never overwrites)\n`);
  }
  return EXIT.done;
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
    const use = USE_HINT[r.kind];
    if (use) a.io.err.write(`rp-core: hint: ${use(r.id)}\n`);
  }
  return EXIT.done;
}

/** How to use what was imported. */
const USE_HINT: Partial<Record<string, (id: string) => string>> = {
  preset: (id) => `/preset ${id} in the chat, or rp-core new --preset ${id}`,
  lorebook: (id) => `/lore add ${id} in the chat, or rp-core new --lore ${id}`,
};

// ---- new -----------------------------------------------------------------------------------------

export interface NewArgs {
  home: string;
  card: string;
  persona?: string;
  model?: string;
  /** The narrator binding's maxTokens (the reply limit; else the preset's, else the §11 reserve). */
  maxTokens?: number;
  /** M2: the session's preset: 'builtin', a library id or an ST preset file (imported first). */
  preset?: string;
  /** M2: the session's lorebooks: library ids or world info / character_book files (imported first). */
  lore?: string[];
  title?: string;
  json: boolean;
  io: Io;
  /**
   * config.toml and its connections (M1b): new sessions start from config.sessionDefaults, and a
   * --model connection must exist there unless --provider overrides every role. Absent: no config.
   */
  rt?: Runtime;
  /** Open the REPL on the new session instead of printing its id (a terminal, no --json/--no-chat). */
  chat?: (engine: EngineHandle, session: SessionHandle) => Promise<number>;
  /** The command the "reopens it" hint names when `chat` runs (default 'chat'; `new --tui` says 'tui'). */
  reopen?: 'chat' | 'tui';
  engine?: Partial<EngineOptions>;
}

/** --card is a file (imported into the library) or, when no such file exists, a library id. */
function resolveCard(a: NewArgs): { character: Character; warnings: ImportWarning[]; libraryId: string; imported: boolean } {
  if (existsSync(a.card)) {
    try {
      const r = importCard(a.home, a.card);
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

/**
 * The new session's config: config.toml's defaults, then --model / --max-tokens on the narrator.
 * A --model connection is checked against config.toml unless --provider overrides every role.
 */
function newSessionConfig(a: NewArgs): DeepPartial<SessionConfig> | undefined {
  let config: DeepPartial<SessionConfig> | undefined = a.rt && Object.keys(a.rt.config.sessionDefaults).length > 0 ? a.rt.config.sessionDefaults : undefined;
  const narrator: { conn?: string; model?: string; maxTokens?: number } = {};
  if (a.model !== undefined) {
    const ref = parseModelRef(a.model);
    if (!ref) throw new UsageError(`--model must be conn:model, got ${JSON.stringify(a.model)}`, 'new');
    if (a.rt && !a.rt.provider) {
      const problem = connectionProblem(a.rt, ref.conn);
      if (problem) throw new UsageError(`--model ${a.model}: ${problem}`, 'new');
    }
    narrator.conn = ref.conn;
    narrator.model = ref.model;
  }
  if (a.maxTokens !== undefined) narrator.maxTokens = a.maxTokens;
  if (Object.keys(narrator).length > 0) config = mergePatch<DeepPartial<SessionConfig>>(config ?? {}, { roles: { narrator } });
  return config;
}

/** A --preset / --lore ref resolved (a file imported, its warnings and the import said on stderr). */
function useRef<T>(a: NewArgs, flag: string, resolve: () => Resolved<T>): Resolved<T> {
  let r: Resolved<T>;
  try {
    r = resolve();
  } catch (e) {
    if (e instanceof RefError) throw new CliError(`${flag}: ${e.message}`);
    throw e;
  }
  if (r.imported) {
    warn(a.io, r.imported.warnings);
    a.io.err.write(`rp-core: imported ${r.imported.file} as ${r.imported.path}\n`);
  }
  return r;
}

/** --preset and --lore on top of the config (books deduplicated, in the order given). */
function withPresetAndLore(a: NewArgs, config: DeepPartial<SessionConfig> | undefined): DeepPartial<SessionConfig> | undefined {
  const patch: DeepPartial<SessionConfig> = {};
  if (a.preset !== undefined) patch.preset = useRef(a, '--preset', () => resolvePresetRef(a.home, a.preset!)).id;
  if (a.lore && a.lore.length > 0) {
    let ids: string[] = [];
    for (const ref of a.lore) {
      const r = useRef(a, '--lore', () => resolveLoreRef(a.home, ref));
      // A world is read once by name: a later book with the same name takes the earlier one's place.
      const next = addLoreId(a.home, ids, r.id, r.value.name);
      if (next.replaced !== undefined) a.io.err.write(`rp-core: --lore ${r.id} "${r.value.name.trim()}" replaces ${next.replaced} (same name; a world is read once by name)\n`);
      ids = next.ids;
    }
    patch.lorebooks = ids;
  }
  return Object.keys(patch).length > 0 ? mergePatch<DeepPartial<SessionConfig>>(config ?? {}, patch) : config;
}

/** `rp-core new --card <file>`: import the card, create the session, print its id (or open the REPL). */
export async function cmdNew(a: NewArgs): Promise<number> {
  const base = newSessionConfig(a);
  const persona = a.persona !== undefined ? resolvePersona(a.persona) : undefined;
  const config = withPresetAndLore(a, base);
  const card = resolveCard(a);
  warn(a.io, card.warnings);

  const engine = await Engine.open({ ...a.engine, ...(a.rt ? engineOptions(a.rt) : {}), home: a.home });
  let sessionId: string;
  let title: string | undefined;
  /** Set once the REPL owns the engine (runChat closes it when the REPL ends). */
  let handedOver = false;
  try {
    const session = engine.createSession({
      character: card.character,
      ...(persona ? { persona } : {}),
      ...(config ? { config } : {}),
      ...(a.title !== undefined ? { title: a.title } : {}),
    });
    sessionId = session.id;
    title = session.header().title;
    if (a.chat) {
      const how = card.imported ? `card imported as library character ${card.libraryId}` : `library character ${card.libraryId}`;
      a.io.err.write(`rp-core: created session ${sessionId} (${how}); \`rp-core ${a.reopen ?? 'chat'} ${sessionId}\` reopens it\n`);
      handedOver = true;
      return await a.chat(engine, session);
    }
    await session.close();
  } finally {
    if (!handedOver) await engine.close();
  }
  const greetings = greetingsOf(readSessionFile(a.home, sessionId).entries);

  if (a.json) {
    a.io.out.write(`${JSON.stringify({ sessionId, title: title ?? null, greetings })}\n`);
  } else {
    a.io.out.write(`${sessionId}\n`);
    const how = card.imported ? `card imported as library character ${card.libraryId}` : `library character ${card.libraryId}`;
    const n = greetings.length;
    const extra = [
      ...(config?.preset !== undefined ? [`preset ${config.preset}`] : []),
      ...(config?.lorebooks && config.lorebooks.length > 0 ? [`lorebooks ${config.lorebooks.join(', ')}`] : []),
    ];
    a.io.err.write(`rp-core: created session ${sessionId} "${title ?? ''}" with ${n} greeting${n === 1 ? '' : 's'} (${[how, ...extra].join('; ')})\n`);
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
