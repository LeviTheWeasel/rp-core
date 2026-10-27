// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Exporting the session's Compendium (ARCHITECTURE.md §7.4.8; .notes/m5a-decisions.md D-163). Scope:
// every session entry (notes, typed entries, summaries, arcs) and every library overlay as a whole
// entry, live and retired (retired → disabled), in handle order; plain library entries stay out (they
// are in the library already). Two shapes:
// - exportCoreBook: a core.lorebook/1 book (the caller saves it to the library): typed entries keep
//   `meta {type, data, aliases, featured}` and read as their render; notes are lore at depth 4; arcs
//   are constant `[Arc] <plot>` entries with `meta.arc`.
// - exportCompendiumRows + writeCompendiumFile: RoleCall's `compendium-v1.0.0` file, streamed through
//   the codec (formats/compendium-v1.ts) into a temp file and renamed into place. replaceFile does the
//   same for a whole text (a core export written over its old book with --force).
// Both stamp RoleCall's service fields from the path and the fold's provenance: a summary's
// `turn_range {from, to}` (0-based path positions, `to` exclusive) and `messages_covered`; a memory a
// filing row added gets `source_turn` (user messages on the path up to its message). Ids are derived
// from entry keys only, so an export is the same every time for the same view. Pure but for the file
// write.

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { compendiumChunks, RC_LIMITS, type CompendiumRowInput } from '../../formats/compendium-v1.ts';
import { validateLoreBook, type LoreBook, type LoreEntry } from '../../formats/native.ts';
import type { PathView } from '../../session/view.ts';
import { NOTES_DEPTH, NOTES_SCAN_DEPTH } from './notes.ts';
import { renderEntry } from './render.ts';
import type { CEntry, Rec } from './types.ts';

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonBlank = (s: string): boolean => s.trim() !== '';

/** D-163 scope: the session's own entries and the overlays (whole), live and retired, in handle order. */
export function exportScope(view: PathView): CEntry[] {
  const out: CEntry[] = [];
  for (const e of view.compendium.entries.values()) if (e.origin.kind === 'session' || e.origin.overlay) out.push(e);
  return out;
}

/** Path positions, and per position the number of user messages up to it (inclusive). */
interface PathIndex {
  pos: ReadonlyMap<string, number>;
  users: readonly number[];
}

function pathIndex(view: PathView): PathIndex {
  const pos = new Map<string, number>();
  const users: number[] = [];
  let n = 0;
  view.path.forEach((m, i) => {
    pos.set(m.id, i);
    if (m.role === 'user') n++;
    users.push(n);
  });
  return { pos, users };
}

/**
 * The entry's data as exported: a copy with RoleCall's service fields stamped (the view's data is
 * never changed). A summary with a range on the path gains `turn_range {from, to}` (0-based path
 * positions, `to` exclusive) and `messages_covered`; each `memories` item (a record) whose provenance
 * names a message on the path gains `source_turn` = user messages on the path up to that message.
 * Library and human elements (provenance null) are left as they are.
 */
function exportData(e: CEntry, ix: PathIndex): Rec {
  let data = e.data;
  if (e.type === 'summary' && e.range !== undefined) {
    const from = ix.pos.get(e.range[0]);
    const to = ix.pos.get(e.range[1]);
    if (from !== undefined && to !== undefined && from <= to) data = { ...data, turn_range: { from, to: to + 1 }, messages_covered: to + 1 - from };
  }
  const memories = data.memories;
  const ons = e.prov.appended.memories;
  if (Array.isArray(memories) && Array.isArray(ons)) {
    let stamped = false;
    const next = memories.map((m: unknown, j) => {
      const on = ons[j];
      const at = typeof on === 'string' ? ix.pos.get(on) : undefined;
      if (at === undefined || !isRecord(m)) return m;
      stamped = true;
      return { ...m, source_turn: ix.users[at] };
    });
    if (stamped) data = { ...data, memories: next };
  }
  return data;
}

/** A typed entry's triggers: its name, aliases and own lore keys (a library entry's; edited ones), blanks and repeats dropped. */
function typedKeys(e: CEntry): string[] {
  return [...new Set([e.name, ...e.aliases, ...e.keys].filter(nonBlank))];
}

/** A note's lore keys as its notes-book entry has them: its keys without blank ones, else its title. */
function noteKeys(e: CEntry): string[] {
  const keys = e.keys.filter(nonBlank);
  return keys.length > 0 ? [...keys] : [e.name];
}

/** Why a retired entry is disabled: its reason, or 'retired' when it gave none. */
const disableReason = (e: CEntry): string | undefined => (e.retired === undefined ? undefined : nonBlank(e.retired.reason) ? e.retired.reason : 'retired');

const arcPlot = (e: CEntry): string => e.arc ?? e.name;

/** One exported entry as a core lore entry (D-163). */
function coreEntry(e: CEntry, ix: PathIndex): LoreEntry {
  const off = e.retired === undefined ? {} : { enabled: false };
  const why = disableReason(e);
  const extras = why === undefined ? {} : { extras: { disableReason: why } };
  if (e.arc !== undefined) {
    const plot = arcPlot(e);
    return { id: e.key, title: `[Arc] ${plot}`, content: e.content ?? '', ...off, constant: true, keys: [], position: 'after', meta: { arc: plot }, ...extras };
  }
  if (e.type === null) {
    return {
      id: e.key,
      title: e.name,
      content: e.content ?? '',
      ...off,
      keys: noteKeys(e),
      position: { depth: NOTES_DEPTH, role: 'system' },
      scanDepth: NOTES_SCAN_DEPTH,
      ...extras,
    };
  }
  const meta: LoreEntry['meta'] = { type: e.type, data: exportData(e, ix) };
  if (e.aliases.length > 0) meta.aliases = [...e.aliases];
  if (e.featured === true) meta.featured = true;
  return {
    id: e.key,
    title: e.name,
    content: renderEntry(e),
    ...off,
    ...(e.constant === true ? { constant: true } : {}),
    keys: typedKeys(e),
    // An overlay keeps its book entry's guard (section I): the secondary keys and their logic.
    ...(e.secondary !== undefined && e.secondary.length > 0 ? { secondary: [...e.secondary], ...(e.logic !== undefined ? { logic: e.logic } : {}) } : {}),
    position: 'after',
    ...(e.order !== undefined ? { order: e.order } : {}),
    meta,
    ...extras,
  };
}

/**
 * D-163 `--format core`: the export scope as a core.lorebook/1 book named `name`, `match: 'stem'`
 * (the notes matched by stems in the session). Typed entries (summaries too): id = the entry key,
 * title = name, keys = [name, ...aliases, ...own keys], content = renderEntry, position 'after',
 * meta {type, data with service fields, aliases, featured}, order and constant when the entry has
 * them. Notes: their keys (else the title) and text at depth 4 (role system, scan depth 4). Arcs:
 * constant `[Arc] <plot>` with the overview and meta.arc. Retired → enabled false and
 * extras.disableReason. The book is checked with the native validator (a failure is a bug: throws).
 */
export function exportCoreBook(view: PathView, name: string): LoreBook {
  const ix = pathIndex(view);
  const book: LoreBook = { name, match: 'stem', entries: exportScope(view).map((e) => coreEntry(e, ix)) };
  const checked = validateLoreBook(book);
  if (!checked.ok) throw new Error(`exported book is not core.lorebook/1: ${checked.errors.map((x) => `${x.path} ${x.message}`).join('; ')}`);
  return book;
}

/** One exported entry as a compendium-v1 row (D-163, rolecall.md §5.4 "Write"). */
function compendiumRow(e: CEntry, ix: PathIndex): CompendiumRowInput {
  const enabled = e.retired === undefined;
  const why = disableReason(e);
  const off = why === undefined ? {} : { disableReason: why };
  if (e.arc !== undefined) {
    const plot = arcPlot(e);
    return { key: e.key, title: `[Arc] ${plot}`, content: e.content ?? '', enabled, constant: true, keys: [], arc: plot, ...off };
  }
  if (e.type === null) return { key: e.key, title: e.name, content: e.content ?? '', enabled, constant: false, keys: noteKeys(e), ...off };
  const stamped = exportData(e, ix);
  // RoleCall reads aliases back from structured_data (the codec's meta.aliases on import).
  const data = e.aliases.length > 0 ? { ...stamped, aliases: [...e.aliases] } : stamped;
  return {
    key: e.key,
    title: e.name,
    content: renderEntry(e),
    enabled,
    constant: e.constant === true,
    keys: typedKeys(e),
    type: e.type,
    data,
    ...(e.featured === true ? { featured: true } : {}),
    ...off,
  };
}

/**
 * D-163 `--format compendium`: the export scope as the codec's rows, in handle order. Typed rows:
 * title = name, content = renderEntry, keys = [name, ...aliases, ...own keys], data with the service
 * fields and `aliases` (RoleCall reads them from there), featured as stored (the codec keeps one per
 * type). Arcs: `[Arc] <plot>`, constant, the plot in `arc`. Notes: classic rows with their keys.
 * Retired → enabled false with disableReason. No turnNumber (a plot or an event stamped with this
 * chat's turn would read as "still live" in a new RoleCall chat).
 */
export function exportCompendiumRows(view: PathView): CompendiumRowInput[] {
  const ix = pathIndex(view);
  return exportScope(view).map((e) => compendiumRow(e, ix));
}

/** Thrown by writeCompendiumFile when the file would pass what RoleCall imports (RC_LIMITS); nothing is left on disk. */
export class ExportLimitError extends Error {
  readonly limit: 'entries' | 'bytes';
  constructor(limit: 'entries' | 'bytes', message: string) {
    super(message);
    this.name = 'ExportLimitError';
    this.limit = limit;
  }
}

const errCode = (e: unknown): string | undefined => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined);

/** Every byte of `buf` to `fd` (writeSync may write less than asked). */
function writeAll(fd: number, buf: Uint8Array): void {
  for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
}

/** fsync a directory so a rename inside it survives a power cut; best effort (not every platform can). */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Windows cannot open directories; some filesystems refuse fsync on them.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const MB = 1024 * 1024;

/**
 * An exclusive temp file next to `path` (`<path>.tmp-<n>`, the first n not taken: no clock, no
 * randomness), opened for writing; its name and descriptor.
 */
function openTemp(path: string): { tmp: string; fd: number } {
  for (let n = 1; ; n++) {
    const tmp = `${path}.tmp-${n}`;
    try {
      return { tmp, fd: openSync(tmp, 'wx') };
    } catch (e) {
      if (errCode(e) !== 'EEXIST' || n >= 10_000) throw e;
    }
  }
}

/**
 * Write `chunks` to an exclusive temp file next to `path`, fsync it, rename it over `path` and fsync
 * the folder; when anything fails (a chunk's own refusal included) the temp file is removed and
 * `path` is left as it was.
 */
function writeReplacing(path: string, chunks: Iterable<Uint8Array>): void {
  const dir = dirname(path);
  const { tmp, fd: opened } = openTemp(path);
  let fd: number | undefined = opened;
  let renamed = false;
  try {
    for (const buf of chunks) writeAll(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    renamed = true;
    syncDir(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * `text` written over `path` in place (D-163 `--force` of a core export): the same temp file, fsync,
 * rename and folder fsync as writeCompendiumFile; a failed write removes the temp file and leaves the
 * old file whole.
 */
export function replaceFile(path: string, text: string): void {
  writeReplacing(path, [new TextEncoder().encode(text)]);
}

/**
 * Write the rows as a `compendium-v1.0.0` file at `path`: the codec's chunks streamed into
 * `<path>.tmp-<n>` (the first n not taken: no clock, no randomness), fsynced, then renamed over
 * `path` (an existing file is replaced: whether that is allowed is the caller's call, D-163
 * `--force`). The folder is created when missing. Refused with ExportLimitError, nothing written,
 * above RC_LIMITS.entries rows; refused the same way, the temp file removed, as soon as the text
 * passes RC_LIMITS.bytes (RoleCall's import limits).
 */
export function writeCompendiumFile(path: string, head: { name: string; exportDate: string }, rows: readonly CompendiumRowInput[]): void {
  if (rows.length > RC_LIMITS.entries) {
    throw new ExportLimitError('entries', `${rows.length} entries: RoleCall imports at most ${RC_LIMITS.entries} from one Compendium file; nothing was written`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const utf8 = new TextEncoder();
  let bytes = 0;
  writeReplacing(
    path,
    (function* () {
      for (const chunk of compendiumChunks(head, rows)) {
        const buf = utf8.encode(chunk);
        bytes += buf.length;
        if (bytes > RC_LIMITS.bytes) {
          throw new ExportLimitError('bytes', `the export passes ${RC_LIMITS.bytes / MB} MB, more than RoleCall imports from one file; nothing was written`);
        }
        yield buf;
      }
    })(),
  );
}
