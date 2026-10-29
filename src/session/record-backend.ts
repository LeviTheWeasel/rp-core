// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// A synchronous session mirror with an ordered asynchronous RecordStore write queue. The mirror
// lets existing folds and admission rules remain synchronous; the async engine facade and the turn
// barriers await flush() before exposing a durable operation or sending a provider request.

import type { Entry, EntryInput, SessionHeader } from './entries.ts';
import { MemorySessionStore, type SessionStore } from './backend.ts';
import type { OpenNotice, SessionLog } from './log.ts';
import type { Lease, RecordStore } from './port.ts';

class QueuedLog implements SessionLog {
  readonly id: string;
  readonly file: string;
  readonly header: SessionHeader;
  private closed = false;
  constructor(private readonly inner: SessionLog, private readonly backend: RecordSessionStore) {
    this.id = inner.id;
    this.file = inner.file;
    this.header = inner.header;
  }
  entries(): readonly Entry[] { return this.inner.entries(); }
  lastSeq(): number { return this.inner.lastSeq(); }
  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number } {
    const entry = this.inner.append(input, opts);
    this.backend.write(this.id, entry as Entry, opts?.durable !== false);
    return entry;
  }
  datasync(): void {
    this.inner.datasync();
    this.backend.sync(this.id);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.close();
    this.backend.release(this.id);
  }
}

export class RecordSessionStore implements SessionStore {
  private readonly mirror = new MemorySessionStore();
  private readonly leases = new Map<string, Lease>();
  private readonly renewers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly serial = new Map<string, number>();
  private readonly errors = new Map<string, { at: number; error: unknown }>();

  constructor(readonly records: RecordStore) {}

  private enqueue(id: string, task: () => Promise<void>): void {
    const at = (this.serial.get(id) ?? 0) + 1;
    this.serial.set(id, at);
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.errors.has(id)) return;
      await task();
    }).catch((error: unknown) => { this.errors.set(id, { at, error }); });
    this.chains.set(id, next);
  }

  async flush(id: string): Promise<void> {
    const target = this.serial.get(id) ?? 0;
    const chain = this.chains.get(id);
    await chain;
    const failure = this.errors.get(id);
    if (failure && failure.at <= target) throw failure.error;
  }

  /** Await cleanup even when an earlier write poisoned the session's queue. */
  async drain(id: string): Promise<void> { await this.chains.get(id); }

  async flushAll(): Promise<void> {
    await Promise.all([...this.chains.keys()].map((id) => this.flush(id)));
  }

  private persistNew(header: SessionHeader, entries: readonly Entry[]): void {
    this.enqueue(header.id, async () => {
      await this.records.create(header, entries);
      this.hold(header.id, await this.records.acquire(header.id));
    });
  }

  private hold(id: string, lease: Lease): void {
    this.leases.set(id, lease);
    const timer = setInterval(() => this.enqueue(id, () => lease.renew()), 10_000);
    timer.unref?.();
    this.renewers.set(id, timer);
  }

  create(header: SessionHeader, initial: readonly EntryInput[]): SessionLog {
    const inner = this.mirror.create(header, initial);
    this.persistNew(inner.header, inner.entries());
    return new QueuedLog(inner, this);
  }

  /** Acquire and hydrate before the synchronous engine opens this session. */
  async load(id: string): Promise<void> {
    if (this.leases.has(id)) return;
    const lease = await this.records.acquire(id);
    try {
      let header: SessionHeader | undefined;
      const entries: Entry[] = [];
      for await (const row of this.records.read(id)) {
        if (row.t === 'session') {
          if (header) throw new Error(`duplicate header for ${id}`);
          header = row;
        } else entries.push(row);
      }
      if (!header || header.id !== id) throw new Error(`missing header for ${id}`);
      const inner = this.mirror.create(header, entries);
      inner.close();
      this.hold(id, lease);
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  open(id: string): { log: SessionLog; notices: OpenNotice[] } {
    if (!this.leases.has(id)) throw new Error(`record session ${id} must be loaded before opening`);
    const { log, notices } = this.mirror.open(id);
    return { log: new QueuedLog(log, this), notices };
  }

  fork(source: { header: SessionHeader; entries: readonly Entry[] }, at: string, opts: { newId: string; now: string }): SessionLog {
    const inner = this.mirror.fork(source, at, opts);
    this.persistNew(inner.header, inner.entries());
    return new QueuedLog(inner, this);
  }

  list(): { id: string; title?: string; updated: string }[] { return this.mirror.list(); }
  async listDurable(): Promise<{ id: string; title?: string; updated: string }[]> { return this.records.list(); }

  write(id: string, entry: Entry, durable: boolean): void {
    this.enqueue(id, async () => {
      const lease = this.leases.get(id);
      if (!lease) throw new Error(`missing record lease for ${id}`);
      await this.records.append(lease, [entry], durable);
    });
  }

  sync(id: string): void {
    this.enqueue(id, async () => {
      const lease = this.leases.get(id);
      if (!lease) throw new Error(`missing record lease for ${id}`);
      await this.records.append(lease, [], true);
    });
  }

  release(id: string): void {
    const timer = this.renewers.get(id);
    if (timer) clearInterval(timer);
    this.renewers.delete(id);
    // A poisoned append queue still has to release its lease. Never run this through enqueue(),
    // which deliberately skips normal writes after the first failure.
    const at = (this.serial.get(id) ?? 0) + 1;
    this.serial.set(id, at);
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const lease = this.leases.get(id);
      this.leases.delete(id);
      await lease?.release();
    }).catch((error: unknown) => { this.errors.set(id, { at, error }); });
    this.chains.set(id, next);
    this.mirror.drop(id);
  }
}
