// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Synchronous journal boundary used by the existing SessionHandle contract. A host that can
// synchronously commit records (for example, an in-process SQLite connection) can implement it.

import { parseEntry, parseHeader } from './entries.ts';
import type { Entry, EntryInput, SessionHeader } from './entries.ts';
import { forkSession, planFork } from './fork.ts';
import { currentHeader } from './fold.ts';
import { createSessionLogWith, listSessions, openSessionLog, SessionLockedError, SessionNotFoundError } from './log.ts';
import type { OpenNotice, SessionLog } from './log.ts';

export interface SessionStore {
  create(header: SessionHeader, initial: readonly EntryInput[]): SessionLog;
  open(id: string): { log: SessionLog; notices: OpenNotice[] };
  fork(source: { header: SessionHeader; entries: readonly Entry[] }, at: string, opts: { newId: string; now: string }): SessionLog;
  list(): { id: string; title?: string; updated: string }[];
}

export class FileSessionStore implements SessionStore {
  constructor(readonly home: string) {}
  create(header: SessionHeader, initial: readonly EntryInput[]): SessionLog { return createSessionLogWith(this.home, header, initial); }
  open(id: string): { log: SessionLog; notices: OpenNotice[] } { return openSessionLog(this.home, id); }
  fork(source: { header: SessionHeader; entries: readonly Entry[] }, at: string, opts: { newId: string; now: string }): SessionLog {
    // The existing fork publishes a fully fsynced journal before opening it.
    return forkSession(this.home, source, at, opts);
  }
  list(): { id: string; title?: string; updated: string }[] { return listSessions(this.home); }
}

type MemoryRecord = { header: SessionHeader; entries: Entry[]; owner: MemorySessionLog | null };

function validHeader(header: SessionHeader): SessionHeader {
  const parsed = parseHeader(JSON.stringify(header));
  if (!parsed.ok) throw new Error(`invalid session header: ${parsed.why}`);
  return parsed.value;
}

function validEntry(input: EntryInput, seq: number): Entry {
  const parsed = parseEntry(JSON.stringify({ ...input, seq }));
  if (!parsed.ok) throw new Error(`invalid entry seq ${seq}: ${parsed.why}`);
  return parsed.value;
}

class MemorySessionLog implements SessionLog {
  readonly id: string;
  readonly file: string;
  readonly header: SessionHeader;
  private closed = false;
  private snapshot: readonly Entry[] | null = null;
  constructor(private readonly record: MemoryRecord) {
    this.id = record.header.id;
    this.file = `memory:${this.id}`;
    this.header = structuredClone(record.header);
  }
  private assertOpen(): void {
    if (this.closed || this.record.owner !== this) throw new SessionLockedError({ pid: 0, host: 'memory store', started: '', renewed: '' });
  }
  entries(): readonly Entry[] {
    this.assertOpen();
    return this.snapshot ??= Object.freeze(this.record.entries.map((entry) => structuredClone(entry)));
  }
  lastSeq(): number { this.assertOpen(); return this.record.entries.at(-1)?.seq ?? 0; }
  append<T extends EntryInput>(input: T, _opts?: { durable?: boolean }): T & { seq: number } {
    this.assertOpen();
    const entry = validEntry(input, this.lastSeq() + 1);
    this.record.entries.push(entry);
    this.snapshot = null;
    return structuredClone(entry) as unknown as T & { seq: number };
  }
  datasync(): void { this.assertOpen(); }
  close(): void {
    if (this.closed) return;
    this.assertOpen();
    this.closed = true;
    this.record.owner = null;
  }
}

/** A host-owned in-memory journal that survives Engine.close() and a later Engine.open(). */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, MemoryRecord>();
  /** Used by the asynchronous RecordStore adapter after releasing its lease. */
  drop(id: string): void {
    const record = this.records.get(id);
    if (record?.owner) throw new Error(`cannot drop open session ${id}`);
    this.records.delete(id);
  }
  create(header: SessionHeader, initial: readonly EntryInput[]): SessionLog {
    const copy = validHeader(header);
    if (this.records.has(copy.id)) throw new Error(`session already exists: ${copy.id}`);
    const entries = initial.map((input, index) => validEntry(input, index + 1));
    const record: MemoryRecord = { header: copy, entries, owner: null };
    const log = new MemorySessionLog(record);
    record.owner = log;
    this.records.set(copy.id, record);
    return log;
  }
  open(id: string): { log: SessionLog; notices: OpenNotice[] } {
    const record = this.records.get(id);
    if (!record) throw new SessionNotFoundError(id);
    if (record.owner) throw new SessionLockedError({ pid: 0, host: 'memory store', started: '', renewed: '' });
    const log = new MemorySessionLog(record);
    record.owner = log;
    return { log, notices: [] };
  }
  fork(source: { header: SessionHeader; entries: readonly Entry[] }, at: string, opts: { newId: string; now: string }): SessionLog {
    const plan = planFork(source, at, opts);
    return this.create(plan.header, plan.entries);
  }
  list(): { id: string; title?: string; updated: string }[] {
    return [...this.records.values()].map(({ header, entries }) => {
      const title = currentHeader(header, entries).title;
      return {
        id: header.id,
        ...(title !== undefined ? { title } : {}),
        updated: (entries.at(-1) as { ts?: string } | undefined)?.ts ?? header.created,
      };
    }).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }
}
