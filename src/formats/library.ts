// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The library folder (ARCHITECTURE.md §5.2): <home>/library/{characters,personas,presets,lorebooks}/<id>.json
// CONTRACT FILE: signatures are fixed; the formats agent implements the bodies.
//
// Plain files, no database [D-13]. Writes are atomic: a reader sees the old file or the new one,
// never half of one, and a crash leaves at most a dot-prefixed temp file that listings ignore.

import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalId } from './native.ts';

export type LibraryKind = 'characters' | 'personas' | 'presets' | 'lorebooks';

export function libraryDir(home: string, kind: LibraryKind): string {
  return join(home, 'library', kind);
}

/** Library ids name files directly, so anything that could escape the folder is refused. */
function assertSafeId(id: string): void {
  if (typeof id !== 'string' || id === '' || id.startsWith('.') || /[/\\\0]/.test(id)) {
    throw new Error(`invalid library id ${JSON.stringify(id)}`);
  }
}

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

/** fsync a directory so a rename/link inside it survives a power cut. Not supported everywhere. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (e) {
    // Windows cannot open directories; some filesystems refuse fsync on them. Best effort there.
    const code = errCode(e);
    if (process.platform !== 'win32' && code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL' && code !== 'EBADF') {
      throw e;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let tmpSeq = 0;

/**
 * Write `text` to a temp file, fsync it, then publish it at `path` only if nothing is there yet.
 * `link` is an atomic create-if-absent, so two importers racing for one id cannot overwrite each
 * other; filesystems without hard links fall back to `rename` after an existence check.
 * Returns false when `path` already exists (the caller decides what a collision means).
 */
function publishExclusive(dir: string, path: string, text: string): boolean {
  // pid + counter keeps temp names unique without wall-clock or randomness (§6.9); a leftover from a
  // crashed process that had the same pid is skipped over, never overwritten.
  let tmp = '';
  let fd: number | undefined;
  while (fd === undefined) {
    tmp = join(dir, `.${process.pid}-${++tmpSeq}.tmp`);
    try {
      fd = openSync(tmp, 'wx');
    } catch (e) {
      if (errCode(e) !== 'EEXIST' || tmpSeq > 1_000_000) throw e;
    }
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(tmp, path);
    } catch (e) {
      const code = errCode(e);
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS' && code !== 'EXDEV') throw e;
      if (readIfExists(path) !== null) return false;
      renameSync(tmp, path);
    }
    fsyncDir(dir);
    return true;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed away
    }
  }
}

/**
 * Atomic write (temp file + fsync + rename + dir fsync) of `value` under canonicalId(name); if the
 * id exists with different content, use id-2, id-3, ... Returns the id and absolute path.
 */
export function saveToLibrary(home: string, kind: LibraryKind, name: string, value: unknown): { id: string; path: string } {
  const dir = libraryDir(home, kind);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const base = canonicalId(name);
  for (let n = 1; n <= 10_000; ) {
    const id = n === 1 ? base : `${base}-${n}`;
    const path = join(dir, `${id}.json`);
    const existing = readIfExists(path);
    if (existing === text) return { id, path }; // the same import twice is a no-op, not a copy
    if (existing !== null) {
      n++;
      continue;
    }
    if (publishExclusive(dir, path, text)) return { id, path };
    // Lost a race for this id: loop without advancing to compare against the winner's content.
  }
  throw new Error(`library ${kind}: no free id for ${JSON.stringify(name)}`);
}

/** Parsed JSON or null when missing. Throws on invalid JSON. */
export function loadFromLibrary(home: string, kind: LibraryKind, id: string): unknown | null {
  assertSafeId(id);
  const path = join(libraryDir(home, kind), `${id}.json`);
  const text = readIfExists(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function listLibrary(home: string, kind: LibraryKind): { id: string; name: string }[] {
  let files: string[];
  try {
    files = readdirSync(libraryDir(home, kind));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw e;
  }
  return files
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => {
      // A broken file still lists (under its id) so the user can find and fix it.
      let name = id;
      try {
        const v = JSON.parse(readFileSync(join(libraryDir(home, kind), `${id}.json`), 'utf8')) as unknown;
        if (typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string') {
          name = (v as { name: string }).name || id;
        }
      } catch {
        // keep the id as the name
      }
      return { id, name };
    });
}
