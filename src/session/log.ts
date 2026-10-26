// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The session journal on disk (ARCHITECTURE.md §5.2, §5.3; D-35, D-36). One append-only JSONL file
// per session plus a lock file. Synchronous fs on purpose: one write() per line keeps ordering and
// atomicity simple, and the engine is the single writer per session.
//
// CONTRACT FILE: signatures are fixed; the storage agent implements the bodies.
//
// Durability recipe (verified under Bun 1.3.14 on Linux: fsyncSync on a directory fd and
// fdatasyncSync both work; the directory fsync is still wrapped so an odd filesystem cannot fail
// a create):
// - create: write the header (and the first entries) to a temp file, fsync it, link it into place
//   (never overwriting), fsync the directory, then lock.
// - append: one writeSync of the whole line (looping only on short writes), then fsync unless the
//   caller passed durable:false (chk lines); a failed write is rolled back with ftruncate so a later
//   line never glues onto a half line.
// - open: lock first, then read; a torn or invalid last line is copied to <id>.torn (fsynced) before
//   the journal is truncated to the end of the previous line.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { systemClock } from '../engine/system.ts';
import { splitLineSpans } from '../protocol/jsonl.ts';
import { parseEntry, parseHeader } from './entries.ts';
import type { Entry, EntryInput, SessionHeader } from './entries.ts';

export interface LockInfo {
  pid: number;
  host: string;
  started: string;
  renewed: string;
}

export class SessionLockedError extends Error {
  readonly info: LockInfo;
  constructor(info: LockInfo) {
    super(`session is locked by pid ${info.pid} on ${info.host}`);
    this.name = 'SessionLockedError';
    this.info = info;
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

export interface OpenNotice {
  code: 'torn_tail' | 'bad_line';
  message: string;
  /** 1-based line number in the file. */
  line?: number;
}

export interface LogOptions {
  /**
   * Wall clock for lock timestamps. Default: the system clock from engine/system.ts. It must be real
   * wall time: staleness compares it with `renewed` written by OTHER processes, so a fake test clock
   * (e.g. one that advances 1 s per read) makes a live lock look stale. The engine passes none and
   * keeps its injected clock for journal timestamps only.
   */
  clock?: () => Date;
  /** Lock is stale when `renewed` is older than this (ms). Default 30 000. */
  lockTtlMs?: number;
  /** How often the lock is renewed (ms). Default 10 000. */
  lockRenewMs?: number;
  /** Host name recorded in the lock. Default os.hostname(). */
  host?: string;
  /** Process id recorded in the lock. Default process.pid. */
  pid?: number;
}

export interface SessionLog {
  readonly id: string;
  /** Absolute path of <id>.jsonl. */
  readonly file: string;
  readonly header: SessionHeader;
  /** Every parsed non-header entry, in seq order (in-memory index of the file). */
  entries(): readonly Entry[];
  lastSeq(): number;
  /**
   * Append one entry: assigns seq = lastSeq()+1, writes exactly one line with one write(),
   * then fsync unless durable === false. chk entries should be appended with durable:false.
   */
  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number };
  /** fdatasync the file (the engine calls this every 2 s while a turn streams). */
  datasync(): void;
  /** Stop renewing and release the lock. Idempotent. */
  close(): void;
}

export const DEFAULT_LOCK_TTL_MS = 30_000;
export const DEFAULT_LOCK_RENEW_MS = 10_000;

// ---- paths -------------------------------------------------------------------------------------------

/** <home>/sessions */
export function sessionsDir(home: string): string {
  return join(home, 'sessions');
}

/**
 * Ids become file names, so they are restricted to a safe alphabet (no separators, no leading dot).
 * Generated ids (`s_` + 8 hex) always pass.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

interface Paths {
  dir: string;
  file: string;
  lock: string;
  torn: string;
}

function pathsFor(home: string, id: string): Paths {
  const dir = resolve(sessionsDir(home));
  return {
    dir,
    file: join(dir, `${id}.jsonl`),
    lock: join(dir, `${id}.lock`),
    torn: join(dir, `${id}.torn`),
  };
}

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

// ---- low-level io ------------------------------------------------------------------------------------

/** Write the whole buffer at the fd's position, looping only on short writes. */
function writeAll(fd: number, buf: Uint8Array): void {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error('write returned no progress');
    off += n;
  }
}

/** fsync a directory so a create/rename inside it survives power loss. Best effort by design. */
export function fsyncDir(dir: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
    return true;
  } catch {
    // Some filesystems/platforms refuse fsync on a directory (EISDIR/EINVAL/EPERM); the data file
    // itself is already fsynced, so we only lose the guarantee about the directory entry.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function datasyncFd(fd: number): void {
  try {
    fdatasyncSync(fd);
  } catch {
    fsyncSync(fd);
  }
}

// ---- lock --------------------------------------------------------------------------------------------

interface LockSettings {
  clock: () => Date;
  ttlMs: number;
  renewMs: number;
  host: string;
  pid: number;
}

function settingsOf(opts: LogOptions | undefined): LockSettings {
  return {
    clock: opts?.clock ?? systemClock,
    ttlMs: opts?.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    renewMs: opts?.lockRenewMs ?? DEFAULT_LOCK_RENEW_MS,
    host: opts?.host ?? hostname(),
    pid: opts?.pid ?? process.pid,
  };
}

function parseLockInfo(raw: string): LockInfo | null {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      v &&
      typeof v === 'object' &&
      typeof v.pid === 'number' &&
      typeof v.host === 'string' &&
      typeof v.started === 'string' &&
      typeof v.renewed === 'string' &&
      Number.isFinite(Date.parse(v.renewed))
    ) {
      return { pid: v.pid, host: v.host, started: v.started, renewed: v.renewed };
    }
  } catch {
    /* fall through */
  }
  return null;
}

type LockRead = { raw: string; info: LockInfo | null; mtimeMs: number } | null;

/** Read the lock file; null when it does not exist. */
function readLockFile(file: string): LockRead {
  try {
    const raw = readFileSync(file, 'utf8');
    const mtimeMs = statSync(file).mtimeMs;
    return { raw, info: parseLockInfo(raw), mtimeMs };
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

/**
 * The session's lock as its holder wrote it, or null when there is none, it is unreadable, or the
 * id could never name a session. Read-only, never takes the lock: for callers such as `rp-core show`
 * that want to know whether a turn is running elsewhere (pair it with isLockStale).
 */
export function readLock(home: string, id: string): LockInfo | null {
  if (!isValidSessionId(id)) return null;
  try {
    return readLockFile(pathsFor(home, id).lock)?.info ?? null;
  } catch {
    return null; // e.g. EACCES: treated like "no readable lock", as the caller only wants a hint
  }
}

/** process.kill(pid, 0): ESRCH = gone; EPERM = alive but not ours. */
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) !== 'ESRCH';
  }
}

/** A lock is stale when its owner is a dead pid on this host, or it has not been renewed in time. */
export function isLockStale(lock: LockInfo, now: Date, ttlMs: number, host: string): boolean {
  if (now.getTime() - Date.parse(lock.renewed) > ttlMs) return true;
  return lock.host === host && !pidAlive(lock.pid);
}

function unknownOwner(mtimeMs: number): LockInfo {
  const at = new Date(mtimeMs).toISOString();
  return { pid: 0, host: 'unknown', started: at, renewed: at };
}

/** Create the lock with 'wx' (exclusive); false when it already exists. */
function tryCreateLock(file: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o644);
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
  try {
    writeAll(fd, Buffer.from(JSON.stringify(info)));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Take the lock, replacing a stale one. Throws SessionLockedError when someone live holds it. */
function acquireLock(file: string, s: LockSettings): LockInfo {
  const now = s.clock().toISOString();
  const mine: LockInfo = { pid: s.pid, host: s.host, started: now, renewed: now };
  let owner: LockInfo = unknownOwner(0);
  // A few rounds cover the race where two processes replace the same stale lock at once.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (tryCreateLock(file, mine)) return mine;
    const cur = readLockFile(file);
    if (!cur) continue; // released between our create and read
    if (cur.info) {
      owner = cur.info;
      if (!isLockStale(cur.info, s.clock(), s.ttlMs, s.host)) throw new SessionLockedError(cur.info);
    } else {
      // Unreadable lock: possibly a writer between its 'wx' open and its write. Trust it while fresh.
      owner = unknownOwner(cur.mtimeMs);
      if (s.clock().getTime() - cur.mtimeMs <= s.ttlMs) throw new SessionLockedError(owner);
    }
    // Replace the stale lock only if it is still the one we judged (narrows the steal race).
    const again = readLockFile(file);
    if (again && again.raw === cur.raw) {
      try {
        unlinkSync(file);
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
    }
  }
  throw new SessionLockedError(owner);
}

const sameOwner = (a: LockInfo, b: LockInfo): boolean =>
  a.pid === b.pid && a.host === b.host && a.started === b.started;

// ---- reading -----------------------------------------------------------------------------------------

interface ParsedJournal {
  header: SessionHeader;
  entries: Entry[];
  notices: OpenNotice[];
  /** Where the dropped tail starts (the end of the last good line); null when nothing is dropped. */
  tailStart: number | null;
}

/** Thrown when the header line is missing or invalid: such a file cannot be opened at all. */
export class SessionCorruptError extends Error {
  constructor(id: string, why: string) {
    super(`session ${id} has an unreadable header: ${why}`);
    this.name = 'SessionCorruptError';
  }
}

/**
 * Parse a whole journal. Never throws for entry lines; throws SessionCorruptError when the header
 * does not parse. Rules:
 * - the first non-empty complete line is the header;
 * - a line that fails to parse, or whose seq does not increase, is skipped with bad_line;
 * - a torn final segment, or a final complete line that fails to parse, is a torn tail: the file
 *   is to be cut back to the end of the last GOOD line, so bad lines sitting between that line and
 *   the tail go with it (otherwise the next open would find one of them as the new invalid last
 *   line and keep eating the file one line per open).
 */
function parseJournal(id: string, bytes: Uint8Array): ParsedJournal {
  const { spans, torn, tornOffset, tornLine } = splitLineSpans(bytes);
  const first = spans[0];
  if (!first) throw new SessionCorruptError(id, torn !== null ? 'the header line is torn' : 'the file is empty');
  const h = parseHeader(first.text);
  if (!h.ok) throw new SessionCorruptError(id, h.why);

  const entries: Entry[] = [];
  const bad: { line: number; start: number; why: string; parsed: boolean }[] = [];
  let lastGoodEnd = first.end;
  let prevSeq = 0;
  for (let i = 1; i < spans.length; i++) {
    const span = spans[i]!;
    const r = parseEntry(span.text);
    if (r.ok && r.value.seq > prevSeq) {
      entries.push(r.value);
      prevSeq = r.value.seq;
      lastGoodEnd = span.end;
    } else if (r.ok) {
      bad.push({ line: span.line, start: span.start, why: `seq ${r.value.seq} does not follow ${prevSeq}`, parsed: true });
    } else {
      bad.push({ line: span.line, start: span.start, why: r.why, parsed: false });
    }
  }

  const lastSpan = spans[spans.length - 1]!;
  const lastBad = bad[bad.length - 1];
  // A crash can leave a complete-looking but broken last line; it is a tail, not history.
  const invalidLast = torn === null && lastBad !== undefined && !lastBad.parsed && lastBad.start === lastSpan.start;
  const tailStart = torn !== null || invalidLast ? lastGoodEnd : null;

  const notices: OpenNotice[] = [];
  for (const b of bad) {
    if (invalidLast && b === lastBad) {
      notices.push({ code: 'torn_tail', message: `dropped an invalid last line (${b.why})`, line: b.line });
    } else {
      const moved = tailStart !== null && b.start >= tailStart ? ' (moved to .torn with the tail)' : '';
      notices.push({ code: 'bad_line', message: `skipped line ${b.line}: ${b.why}${moved}`, line: b.line });
    }
  }
  if (torn !== null && tornOffset !== null) {
    notices.push({
      code: 'torn_tail',
      message: `dropped a torn last line (${bytes.length - tornOffset} bytes without a line feed)`,
      ...(tornLine !== null ? { line: tornLine } : {}),
    });
  }
  return { header: h.value, entries, notices, tailStart };
}

/** Move the dropped tail into <id>.torn (append, fsynced) and cut the journal back to the last line. */
function repairTail(paths: Paths, bytes: Uint8Array, tailStart: number): void {
  const tail = bytes.subarray(tailStart);
  // Keep successive fragments apart in the .torn file.
  const sep = tail.length > 0 && tail[tail.length - 1] === 0x0a ? new Uint8Array(0) : Buffer.from('\n');
  const fdTorn = openSync(paths.torn, 'a', 0o644);
  try {
    writeAll(fdTorn, tail);
    if (sep.length) writeAll(fdTorn, sep);
    fsyncSync(fdTorn);
  } finally {
    closeSync(fdTorn);
  }
  const fd = openSync(paths.file, 'r+');
  try {
    ftruncateSync(fd, tailStart);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---- the log -----------------------------------------------------------------------------------------

/** Order the keys t, seq, ...rest for readable lines; a stray seq in the input is overridden. */
function withSeq(input: EntryInput, seq: number): Record<string, unknown> {
  return Object.assign({ t: input.t, seq }, input, { seq });
}

/** File-backed SessionLog. Exported for tests (renewLock, lockLost); callers use the interface. */
export class FileSessionLog implements SessionLog {
  readonly id: string;
  readonly file: string;
  readonly header: SessionHeader;
  private readonly paths: Paths;
  private readonly settings: LockSettings;
  private readonly list: Entry[];
  private snapshot: readonly Entry[] | null = null;
  private fd: number;
  private size: number;
  private lock: LockInfo;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Wall time (ms) the lock was last confirmed ours: a renewal, or the check before a write. */
  private verifiedAt: number;
  /**
   * Set when the lock is no longer ours (a renewal found someone else's lock, or the journal changed
   * under us): further appends are refused.
   */
  lockLost: LockInfo | null = null;
  /** Set when a write/fsync failed in a way we could not roll back. */
  private broken: Error | null = null;

  constructor(paths: Paths, id: string, header: SessionHeader, entries: Entry[], lock: LockInfo, s: LockSettings) {
    this.paths = paths;
    this.id = id;
    this.file = paths.file;
    this.header = header;
    this.list = entries;
    this.lock = lock;
    this.settings = s;
    // O_APPEND: every write lands at the end even if something else extended the file.
    this.fd = openSync(paths.file, 'a');
    this.size = fstatSync(this.fd).size;
    this.verifiedAt = s.clock().getTime();
    if (s.renewMs > 0) {
      this.timer = setInterval(() => this.renewLock(), s.renewMs);
      // Never keep the process alive just to renew a lock.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * A frozen snapshot of the index, reused until the next append. A snapshot (not the live array)
   * so a caller that holds it, or iterates it while appending, never sees it grow underneath.
   */
  entries(): readonly Entry[] {
    if (!this.snapshot || this.snapshot.length !== this.list.length) this.snapshot = Object.freeze(this.list.slice());
    return this.snapshot;
  }

  lastSeq(): number {
    return this.list.length ? this.list[this.list.length - 1]!.seq : 0;
  }

  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number } {
    if (this.closed) throw new Error(`session log ${this.id} is closed`);
    if (this.broken) throw new Error(`session log ${this.id} is unusable after a failed write: ${this.broken.message}`);
    this.assertOwner();
    const seq = this.lastSeq() + 1;
    const json = JSON.stringify(withSeq(input, seq));
    // Validate the exact bytes we are about to write: a line the reader would reject must never
    // reach the journal, where it would later be skipped (or, as the last line, cut off).
    const checked = parseEntry(json);
    if (!checked.ok) throw new Error(`refusing to append an invalid ${String(input.t)} entry: ${checked.why}`);
    const buf = Buffer.from(json + '\n', 'utf8');
    try {
      writeAll(this.fd, buf);
    } catch (e) {
      this.rollback(e);
      throw e;
    }
    if (opts?.durable !== false) {
      try {
        fsyncSync(this.fd);
      } catch (e) {
        // After a failed fsync the page cache state is unknown; stop writing rather than guess.
        this.broken = e instanceof Error ? e : new Error(String(e));
        throw e;
      }
    }
    this.size += buf.length;
    // Index the parsed copy so memory equals what a reopen reads, and callers cannot alias it.
    this.list.push(checked.value);
    return checked.value as unknown as T & { seq: number };
  }

  /**
   * Ownership is a precondition of every write. A process can lose its lock without noticing: it is
   * suspended (Ctrl+Z) past the TTL, another opener steals the lock, writes, and releases it. So:
   * - the journal must be exactly the file and the size our own writes left (another writer, a
   *   repair or a rewrite changes one of them): otherwise the lock is lost;
   * - when the renew timer has not confirmed the lock for longer than a renew period (timers do not
   *   run in a suspended or blocked process), the lock file is checked, and renewed, before writing.
   */
  private assertOwner(): void {
    if (!this.lockLost && !this.journalIsOurs()) this.loseLock();
    if (!this.lockLost) {
      const overdue = this.settings.clock().getTime() - this.verifiedAt > Math.max(0, this.settings.renewMs);
      if (overdue) this.renewLock();
    }
    if (this.lockLost) throw new SessionLockedError(this.lockLost);
  }

  /** True while the path still names our open file and nobody else changed its length. */
  private journalIsOurs(): boolean {
    try {
      const mine = fstatSync(this.fd);
      if (mine.size !== this.size) return false;
      const named = statSync(this.paths.file);
      return named.ino === mine.ino && named.dev === mine.dev;
    } catch {
      return false; // the journal was removed or replaced under us
    }
  }

  /** Record the lock as lost to whoever holds it now (or an unknown owner) and stop renewing. */
  private loseLock(): void {
    let now: LockRead = null;
    try {
      now = readLockFile(this.paths.lock);
    } catch {
      /* unreadable: unknown owner */
    }
    this.lockLost = now?.info ?? unknownOwner(now?.mtimeMs ?? 0);
    this.stopTimer();
  }

  /** Cut a half-written line back off, so the next append starts on a clean line. */
  private rollback(cause: unknown): void {
    try {
      ftruncateSync(this.fd, this.size);
    } catch {
      this.broken = cause instanceof Error ? cause : new Error(String(cause));
    }
  }

  datasync(): void {
    if (this.closed) return;
    datasyncFd(this.fd);
  }

  /**
   * Rewrite the lock with a fresh `renewed` (temp + rename) if it is still ours. Returns false and
   * records `lockLost` when another owner holds it, or when our lock file is gone and the journal
   * changed meanwhile (a thief came, wrote and left). Never throws (it runs on a timer).
   */
  renewLock(): boolean {
    if (this.closed || this.lockLost) return false;
    try {
      const cur = readLockFile(this.paths.lock);
      if (!cur) {
        // Our lock file was removed. If the journal is untouched nobody wrote meanwhile, so it is
        // safe to take it back exclusively rather than run unprotected; otherwise it was stolen.
        if (!this.journalIsOurs()) {
          this.loseLock();
          return false;
        }
        const fresh: LockInfo = { ...this.lock, renewed: this.settings.clock().toISOString() };
        if (tryCreateLock(this.paths.lock, fresh)) {
          this.lock = fresh;
          this.verifiedAt = this.settings.clock().getTime();
          return true;
        }
        this.loseLock();
        return false;
      }
      if (!cur.info || !sameOwner(cur.info, this.lock)) {
        this.lockLost = cur.info ?? unknownOwner(cur.mtimeMs);
        this.stopTimer();
        return false;
      }
      const next: LockInfo = { ...this.lock, renewed: this.settings.clock().toISOString() };
      const tmp = `${this.paths.lock}.${this.settings.pid}.tmp`;
      const fd = openSync(tmp, 'w', 0o644);
      try {
        writeAll(fd, Buffer.from(JSON.stringify(next)));
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.paths.lock);
      this.lock = next;
      this.verifiedAt = this.settings.clock().getTime();
      return true;
    } catch {
      // A transient fs error: the next tick tries again; the TTL is three renew periods.
      return false;
    }
  }

  /** The lock as we last wrote it. */
  lockInfo(): LockInfo {
    return this.lock;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    try {
      // chk lines are written without fsync; give them the same durability as the rest on close.
      if (!this.broken) datasyncFd(this.fd);
    } catch {
      /* closing must not throw */
    }
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
    releaseLock(this.paths.lock, this.lock);
  }
}

/** Remove the lock file only when it is still ours. */
function releaseLock(file: string, mine: LockInfo): void {
  try {
    const cur = readLockFile(file);
    if (cur?.info && sameOwner(cur.info, mine)) unlinkSync(file);
  } catch {
    /* best effort: a leftover lock becomes stale by pid or TTL */
  }
}

// ---- public API --------------------------------------------------------------------------------------

/**
 * Serialize a header for a new file, round-tripped through the reader's guard: a header the reader
 * would reject would brick the session, so it is refused before anything is written.
 */
export function checkHeaderForCreate(header: SessionHeader): string {
  const json = JSON.stringify(header);
  const checked = parseHeader(json);
  if (!checked.ok) throw new Error(`refusing to write session header ${JSON.stringify(header.id)}: ${checked.why}`);
  return json;
}

/**
 * Make a complete new journal visible under <home>/sessions/<id>.jsonl in one step: the bytes are
 * written whole to a private temp file and fsynced, then hard-linked into place, which (unlike
 * rename) refuses to overwrite, and the directory is fsynced. A crash at any point leaves either no
 * session or the whole file, never a listed session with half of its first lines. Throws
 * `session already exists: <id>` when the id is taken. Shared by create and fork.
 */
export function publishNewJournal(home: string, id: string, bytes: Uint8Array): void {
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  const paths = pathsFor(home, id);
  mkdirSync(paths.dir, { recursive: true });
  if (existsSync(paths.file)) throw new Error(`session already exists: ${id}`);
  // Per-process temp name, so two creators of the same id never truncate each other's temp file;
  // a dotfile that does not end in .jsonl, so a crash before the link leaves nothing that lists or
  // reads as a session.
  const tmp = join(paths.dir, `.${id}.${process.pid}.new.tmp`);
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkQuiet(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    linkSync(tmp, paths.file);
    unlinkSync(tmp);
  } catch (e) {
    const code = errCode(e);
    if (code === 'EEXIST') {
      unlinkQuiet(tmp);
      throw new Error(`session already exists: ${id}`);
    }
    // Filesystems without hard links: rename after the existence check above.
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') renameSync(tmp, paths.file);
    else {
      unlinkQuiet(tmp);
      throw e;
    }
  }
  fsyncDir(paths.dir);
}

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** Create <id>.jsonl with the header line (fsynced, dir fsynced) and take the lock. Fails if it exists. */
export function createSessionLog(home: string, header: SessionHeader, opts?: LogOptions): SessionLog {
  return createSessionLogWith(home, header, [], opts);
}

/**
 * createSessionLog with the session's first entries (greetings, the head) in the same file, made
 * visible at once (publishNewJournal): a session is never listed without them (§5.5). Entries get
 * seq 1..n and are checked like append() checks, before anything is written.
 */
export function createSessionLogWith(
  home: string,
  header: SessionHeader,
  initial: readonly EntryInput[],
  opts?: LogOptions,
): SessionLog {
  const id = header.id;
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  const json = checkHeaderForCreate(header);
  // Keep the parsed copies, so memory equals what a reopen reads.
  const stored = JSON.parse(json) as SessionHeader;
  const lines = [json];
  const entries: Entry[] = [];
  for (const [i, input] of initial.entries()) {
    const line = JSON.stringify(withSeq(input, i + 1));
    const checked = parseEntry(line);
    if (!checked.ok) throw new Error(`refusing to create session ${id}: entry ${i + 1} (${String(input.t)}) is invalid: ${checked.why}`);
    lines.push(line);
    entries.push(checked.value);
  }
  publishNewJournal(home, id, Buffer.from(lines.join('\n') + '\n', 'utf8'));

  const paths = pathsFor(home, id);
  const s = settingsOf(opts);
  const lock = acquireLock(paths.lock, s);
  try {
    return new FileSessionLog(paths, id, stored, entries, lock, s);
  } catch (e) {
    releaseLock(paths.lock, lock);
    throw e;
  }
}

/**
 * Take the lock (stealing a stale one), read the file line by line through protocol/jsonl.ts
 * splitLines, drop a torn/invalid LAST line (copy it to <id>.torn and truncate the file), skip and
 * report invalid middle lines. Throws SessionLockedError / SessionNotFoundError.
 */
export function openSessionLog(
  home: string,
  id: string,
  opts?: LogOptions,
): { log: SessionLog; notices: OpenNotice[] } {
  if (!isValidSessionId(id)) throw new SessionNotFoundError(id);
  const paths = pathsFor(home, id);
  if (!existsSync(paths.file)) throw new SessionNotFoundError(id);
  const s = settingsOf(opts);
  const lock = acquireLock(paths.lock, s);
  try {
    const bytes = readFileSync(paths.file);
    const parsed = parseJournal(id, bytes);
    if (parsed.tailStart !== null) repairTail(paths, bytes, parsed.tailStart);
    const log = new FileSessionLog(paths, id, parsed.header, parsed.entries, lock, s);
    return { log, notices: parsed.notices };
  } catch (e) {
    releaseLock(paths.lock, lock);
    throw e;
  }
}

/** Read without taking the lock (for listing and `show`). Never modifies the file. */
export function readSessionFile(
  home: string,
  id: string,
): { header: SessionHeader; entries: Entry[]; notices: OpenNotice[] } {
  if (!isValidSessionId(id)) throw new SessionNotFoundError(id);
  const paths = pathsFor(home, id);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(paths.file);
  } catch (e) {
    if (errCode(e) === 'ENOENT') throw new SessionNotFoundError(id);
    throw e;
  }
  const { header, entries, notices } = parseJournal(id, bytes);
  return { header, entries, notices };
}

/** Read just the first line of a file (the header), without loading the whole journal. */
function readFirstLine(file: string): string | null {
  const fd = openSync(file, 'r');
  try {
    const parts: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, total);
      if (n <= 0) return null; // no LF: torn or empty header
      const lf = chunk.subarray(0, n).indexOf(0x0a);
      if (lf >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, lf)));
        const { spans } = splitLineSpans(Buffer.concat([...parts, Buffer.from('\n')]));
        return spans[0]?.text ?? null;
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
  } finally {
    closeSync(fd);
  }
}

/** All sessions under <home>/sessions, newest first by file mtime. Unreadable ones are skipped. */
export function listSessions(home: string): { id: string; title?: string; updated: string }[] {
  const dir = sessionsDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: { id: string; title?: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!isValidSessionId(id)) continue;
    try {
      const file = join(dir, name);
      const st = statSync(file);
      if (!st.isFile()) continue;
      const line = readFirstLine(file);
      if (line === null) continue;
      const h = parseHeader(line);
      if (!h.ok) continue;
      rows.push(h.value.title !== undefined ? { id, title: h.value.title, mtimeMs: st.mtimeMs } : { id, mtimeMs: st.mtimeMs });
    } catch {
      /* unreadable: skipped */
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map(({ mtimeMs, ...r }) => ({ ...r, updated: new Date(mtimeMs).toISOString() }));
}
