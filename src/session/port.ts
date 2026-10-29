// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The host-facing record store. It deliberately transports journal rows, not folded session state.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseEntry, parseHeader } from './entries.ts';
import { currentHeader } from './fold.ts';
import type { Entry, SessionHeader } from './entries.ts';
import { createSessionLogWith, FileSessionLog, listSessions, openSessionLog, sessionsDir, SessionLockedError } from './log.ts';
import type { SessionLog } from './log.ts';

export interface Lease {
  readonly session: string;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface RecordStore {
  /** Publish the header and initial rows atomically. */
  create(header: SessionHeader, initial?: readonly Entry[]): Promise<void>;
  acquire(session: string): Promise<Lease>;
  read(session: string): AsyncIterable<SessionHeader | Entry>;
  append(lease: Lease, entries: readonly Entry[], durable: boolean): Promise<void>;
  list(): Promise<{ id: string; title?: string; updated: string }[]>;
}

function checkedHeader(header: SessionHeader): SessionHeader {
  const parsed = parseHeader(JSON.stringify(header));
  if (!parsed.ok) throw new Error(`invalid session header: ${parsed.why}`);
  return parsed.value;
}

function checkedEntry(entry: Entry): Entry {
  const parsed = parseEntry(JSON.stringify(entry));
  if (!parsed.ok) throw new Error(`invalid entry: ${parsed.why}`);
  return parsed.value;
}

function validBatch(rows: readonly Entry[], last: number): Entry[] {
  let seq = last;
  return rows.map((row) => {
    const copy = checkedEntry(row);
    if (copy.seq !== ++seq) throw new Error(`expected seq ${seq}, got ${copy.seq}`);
    return copy;
  });
}

class MemoryLease implements Lease {
  released = false;
  constructor(readonly session: string, private readonly owner: MemoryRecordStore) {}
  async renew(): Promise<void> {
    this.owner.assert(this);
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.owner.assert(this);
    this.released = true;
    this.owner.unlock(this);
  }
}

/** Clone all rows at the boundary, so a host or a caller cannot mutate stored history. */
export class MemoryRecordStore implements RecordStore {
  private readonly records = new Map<string, { header: SessionHeader; rows: Entry[] }>();
  private readonly owners = new Map<string, MemoryLease>();

  async create(header: SessionHeader, initial: readonly Entry[] = []): Promise<void> {
    const copy = checkedHeader(header);
    if (this.records.has(copy.id)) throw new Error(`session already exists: ${copy.id}`);
    this.records.set(copy.id, { header: copy, rows: validBatch(initial, 0) });
  }

  async acquire(session: string): Promise<Lease> {
    if (!this.records.has(session)) throw new Error(`session not found: ${session}`);
    if (this.owners.has(session)) throw new Error(`session locked: ${session}`);
    const lease = new MemoryLease(session, this);
    this.owners.set(session, lease);
    return lease;
  }

  assert(lease: MemoryLease): void {
    if (lease.released || this.owners.get(lease.session) !== lease) throw new Error(`lease lost: ${lease.session}`);
  }

  unlock(lease: MemoryLease): void {
    this.owners.delete(lease.session);
  }

  async *read(session: string): AsyncIterable<SessionHeader | Entry> {
    const record = this.records.get(session);
    if (!record) throw new Error(`session not found: ${session}`);
    yield structuredClone(record.header);
    for (const row of record.rows) yield structuredClone(row);
  }

  async append(lease: Lease, entries: readonly Entry[], _durable: boolean): Promise<void> {
    if (!(lease instanceof MemoryLease)) throw new Error('foreign lease');
    this.assert(lease);
    const record = this.records.get(lease.session)!;
    const checked = validBatch(entries, record.rows.at(-1)?.seq ?? 0);
    record.rows.push(...checked);
  }

  async list(): Promise<{ id: string; title?: string; updated: string }[]> {
    return [...this.records.values()].map(({ header, rows }) => {
      const title = currentHeader(header, rows).title;
      return { id: header.id, ...(title !== undefined ? { title } : {}), updated: (rows.at(-1) as { ts?: string } | undefined)?.ts ?? header.created };
    });
  }
}

class FileLease implements Lease {
  released = false;
  constructor(readonly session: string, readonly log: SessionLog, private readonly owner: FileRecordStore) {}
  async renew(): Promise<void> {
    this.owner.assert(this);
    if (!(this.log instanceof FileSessionLog) || !this.log.renewLock()) {
      throw new SessionLockedError(this.log instanceof FileSessionLog && this.log.lockLost
        ? this.log.lockLost
        : { pid: 0, host: 'unknown', started: '', renewed: '' });
    }
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.owner.assert(this);
    this.released = true;
    this.log.close();
    this.owner.unlock(this);
  }
}

/** Adapts the existing durable JSONL journal and exclusive lock to RecordStore. */
export class FileRecordStore implements RecordStore {
  private readonly owners = new Map<string, FileLease>();
  constructor(readonly home: string) {
    mkdirSync(sessionsDir(resolve(home)), { recursive: true });
  }

  async create(header: SessionHeader, initial: readonly Entry[] = []): Promise<void> {
    const rows = validBatch(initial, 0);
    const log = createSessionLogWith(this.home, checkedHeader(header), rows);
    log.close();
  }

  async acquire(session: string): Promise<Lease> {
    if (this.owners.has(session)) throw new SessionLockedError({ pid: process.pid, host: 'this process', started: '', renewed: '' });
    const { log } = openSessionLog(this.home, session);
    const lease = new FileLease(session, log, this);
    this.owners.set(session, lease);
    return lease;
  }

  assert(lease: FileLease): void {
    if (lease.released || this.owners.get(lease.session) !== lease) throw new Error(`lease lost: ${lease.session}`);
  }

  unlock(lease: FileLease): void { this.owners.delete(lease.session); }

  async *read(session: string): AsyncIterable<SessionHeader | Entry> {
    const owned = this.owners.get(session);
    if (owned) {
      yield structuredClone(owned.log.header);
      for (const row of owned.log.entries()) yield structuredClone(row);
      return;
    }
    const { log } = openSessionLog(this.home, session);
    try {
      yield structuredClone(log.header);
      for (const row of log.entries()) yield structuredClone(row);
    } finally { log.close(); }
  }

  async append(lease: Lease, entries: readonly Entry[], durable: boolean): Promise<void> {
    if (!(lease instanceof FileLease)) throw new Error('foreign lease');
    this.assert(lease);
    const rows = validBatch(entries, lease.log.lastSeq());
    for (const row of rows) lease.log.append(row, { durable });
    if (durable) lease.log.datasync();
  }

  async list(): Promise<{ id: string; title?: string; updated: string }[]> { return listSessions(this.home); }
}

/** Reusable contract: run it against any host implementation, including a crash/reopen factory. */
export async function checkRecordStoreConformance(
  make: () => Promise<RecordStore> | RecordStore,
  header: SessionHeader,
  entries: readonly Entry[],
  reopen?: () => Promise<RecordStore> | RecordStore,
): Promise<void> {
  if (entries.length < 2) throw new Error('conformance needs at least two entries');
  const store = await make();
  await store.create(header);
  const lease = await store.acquire(header.id);
  try {
    await lease.renew();
    let excluded = false;
    try { await store.acquire(header.id); } catch { excluded = true; }
    if (!excluded) throw new Error('acquire was not exclusive');
    await store.append(lease, entries, true);
    const read: (SessionHeader | Entry)[] = [];
    for await (const row of store.read(header.id)) read.push(row);
    if (!isDeepStrictEqual(read, [header, ...entries])) throw new Error('read order or content differs');
    let rejected = false;
    try { await store.append(lease, [entries[0]!], true); } catch { rejected = true; }
    if (!rejected) throw new Error('non-monotonic seq accepted');
    const next = { ...entries[0]!, seq: entries.at(-1)!.seq + 1 } as Entry;
    const skipped = { ...entries[1]!, seq: next.seq + 2 } as Entry;
    rejected = false;
    try { await store.append(lease, [next, skipped], true); } catch { rejected = true; }
    if (!rejected) throw new Error('gapped batch accepted');
    const after: (SessionHeader | Entry)[] = [];
    for await (const row of store.read(header.id)) after.push(row);
    if (!isDeepStrictEqual(after, [header, ...entries])) throw new Error('failed batch wrote a prefix');
  } finally { await lease.release(); }
  const reopened = await store.acquire(header.id);
  await reopened.release();
  const initialHeader = { ...header, id: `${header.id}_initial` };
  await store.create(initialHeader, entries);
  const initialRows: (SessionHeader | Entry)[] = [];
  for await (const row of store.read(initialHeader.id)) initialRows.push(row);
  if (!isDeepStrictEqual(initialRows, [initialHeader, ...entries])) throw new Error('atomic create omitted initial rows');
  if (reopen) {
    const fresh = await reopen();
    const rows: (SessionHeader | Entry)[] = [];
    for await (const row of fresh.read(header.id)) rows.push(row);
    if (!isDeepStrictEqual(rows, [header, ...entries])) throw new Error('durable rows did not survive reopening');
  }
}
