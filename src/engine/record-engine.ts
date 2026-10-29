// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import type { CreateSessionInput, EngineHandle, SessionHandle, TurnHandle } from './api.ts';
import type { Event } from '../protocol/events.ts';
import { RecordSessionStore } from '../session/record-backend.ts';

/** Every session operation awaits the RecordStore's ordered writes before it resolves. */
export type AsyncSessionHandle = { readonly id: string } & {
  [K in Exclude<keyof SessionHandle, 'id'>]: SessionHandle[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : SessionHandle[K];
};

export interface AsyncEngineHandle {
  createSession(input: CreateSessionInput): Promise<AsyncSessionHandle>;
  session(id: string): Promise<AsyncSessionHandle>;
  nameSession(id: string, title: string, leaf?: string): Promise<void>;
  listSessions(): Promise<{ id: string; title?: string; updated: string }[]>;
  addConnection: EngineHandle['addConnection'];
  events(): AsyncIterable<Event>;
  close(): Promise<void>;
}

function guardedTurn(turn: TurnHandle, store: RecordSessionStore, sessionId: string): TurnHandle {
  return {
    ...turn,
    events: (async function* () {
      for await (const event of turn.events) {
        try { await store.flush(sessionId); }
        catch { if (event.type !== 'failed') continue; }
        yield event;
      }
    })(),
  };
}

function guardedSession(raw: SessionHandle, store: RecordSessionStore, onClose: () => void): AsyncSessionHandle {
  return new Proxy({ id: raw.id } as AsyncSessionHandle, {
    get(_target, property) {
      if (property === 'id') return raw.id;
      const member = Reflect.get(raw, property) as unknown;
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(member, raw, args);
        if (property === 'close') {
          try { await store.flush(raw.id); }
          finally { onClose(); }
        } else if (property === 'fork' && typeof result === 'string') await store.flush(result);
        else await store.flush(raw.id);
        return result && typeof result === 'object' && 'turnId' in result && 'events' in result
          ? guardedTurn(result as TurnHandle, store, raw.id)
          : result;
      };
    },
  });
}

/** The async facade keeps the sync API intact for file-backed and Bunraku SQLite callers. */
export class RecordEngine implements AsyncEngineHandle {
  private readonly opened = new Map<string, AsyncSessionHandle>();
  constructor(private readonly raw: EngineHandle, private readonly store: RecordSessionStore) {}

  async createSession(input: CreateSessionInput): Promise<AsyncSessionHandle> {
    const raw = this.raw.createSession(input);
    try { await this.store.flush(raw.id); }
    catch (error) { await raw.close(); await this.store.drain(raw.id); throw error; }
    const session = guardedSession(raw, this.store, () => this.opened.delete(raw.id));
    this.opened.set(raw.id, session);
    return session;
  }

  async session(id: string): Promise<AsyncSessionHandle> {
    await this.store.load(id);
    const raw = this.raw.session(id);
    await this.store.flush(id);
    const session = guardedSession(raw, this.store, () => this.opened.delete(raw.id));
    this.opened.set(id, session);
    return session;
  }

  async nameSession(id: string, title: string, leaf?: string): Promise<void> {
    const active = this.opened.get(id);
    const session = active ?? await this.session(id);
    try { await session.name(title, leaf); }
    finally { if (!active) { await session.close(); this.opened.delete(id); } }
  }

  listSessions(): Promise<{ id: string; title?: string; updated: string }[]> { return this.store.listDurable(); }
  addConnection(connection: Parameters<EngineHandle['addConnection']>[0]): void { this.raw.addConnection(connection); }
  async *events(): AsyncIterable<Event> {
    for await (const event of this.raw.events()) {
      try { await this.store.flush(event.sessionId); }
      catch { if (event.type !== 'failed') continue; }
      yield event;
    }
  }
  async close(): Promise<void> {
    await this.raw.close();
    await this.store.flushAll();
    this.opened.clear();
  }
}
