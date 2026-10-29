import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/engine.ts';
import { FileRecordStore, MemoryRecordStore, type Lease } from '../../src/session/port.ts';
import type { Entry, SessionHeader } from '../../src/session/entries.ts';
import { tmpHome } from '../helpers.ts';
import { calls, MIRA, scriptConn } from './kit.ts';

async function rows(store: MemoryRecordStore, id: string): Promise<(SessionHeader | Entry)[]> {
  const result: (SessionHeader | Entry)[] = [];
  for await (const row of store.read(id)) result.push(row);
  return result;
}

test('async RecordStore runs a turn and reopens its durable history', async () => {
  const store = new MemoryRecordStore();
  const { conn, provider } = scriptConn('script', calls([{ text: 'The door opens.' }]));
  const home = tmpHome();
  const engine = await Engine.openWithRecordStore({ home, connections: { script: conn }, recordStore: store, lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const sent = await session.send({ text: 'Open the door.', expectedVersion: await session.version() });
  const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
  for await (const _ of turn.events) { /* consume */ }
  expect(await turn.result).toMatchObject({ type: 'done' });
  expect(provider.requests).toHaveLength(1);
  const saved = await rows(store, session.id);
  expect(saved.some((row) => row.t === 'turn')).toBe(true);
  expect(saved.some((row) => row.t === 'prep')).toBe(true);
  expect(saved.some((row) => row.t === 'msg' && row.id === turn.messageId)).toBe(true);
  const id = session.id;
  await engine.close();

  const reopened = await Engine.openWithRecordStore({ home, connections: { script: conn }, recordStore: store, lane: 'manual' });
  const again = await reopened.session(id);
  expect((await again.view()).head).toBe(turn.messageId);
  await reopened.close();
});

test('provider is not called until turn and prep are durable in RecordStore', async () => {
  class SlowStore extends MemoryRecordStore {
    pending: (() => void) | null = null;
    override async append(lease: Lease, entries: readonly Entry[], durable: boolean): Promise<void> {
      if (entries.some((row) => row.t === 'prep')) await new Promise<void>((resolve) => { this.pending = resolve; });
      await super.append(lease, entries, durable);
    }
  }
  const store = new SlowStore();
  const { conn, provider } = scriptConn('script', calls([{ text: 'Done.' }]));
  const engine = await Engine.openWithRecordStore({ home: tmpHome(), connections: { script: conn }, recordStore: store, lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const sent = await session.send({ text: 'Hello', expectedVersion: await session.version() });
  const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
  for (let i = 0; i < 100 && !store.pending; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(store.pending).not.toBeNull();
  expect(provider.requests).toHaveLength(0);
  store.pending?.();
  for await (const _ of turn.events) { /* consume */ }
  expect(await turn.result).toMatchObject({ type: 'done' });
  expect(provider.requests).toHaveLength(1);
  await engine.close();
});

test('done event waits for the durable answer row', async () => {
  class SlowAnswerStore extends MemoryRecordStore {
    pending: (() => void) | null = null;
    override async append(lease: Lease, entries: readonly Entry[], durable: boolean): Promise<void> {
      if (entries.some((row) => row.t === 'msg' && row.gen?.kind === 'model')) await new Promise<void>((resolve) => { this.pending = resolve; });
      await super.append(lease, entries, durable);
    }
  }
  const store = new SlowAnswerStore();
  const { conn } = scriptConn('script', calls([{ text: 'Held answer.' }]));
  const engine = await Engine.openWithRecordStore({ home: tmpHome(), connections: { script: conn }, recordStore: store, lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const sent = await session.send({ text: 'Hello', expectedVersion: await session.version() });
  const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
  const events: string[] = [];
  const watching = (async () => { for await (const event of turn.events) events.push(event.type); })();
  for (let i = 0; i < 100 && !store.pending; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(store.pending).not.toBeNull();
  expect(events).not.toContain('done');
  store.pending?.();
  await watching;
  expect(events).toContain('done');
  expect(await turn.result).toMatchObject({ type: 'done' });
  await engine.close();
});

test('async RecordStore persists names and forks before returning', async () => {
  const store = new MemoryRecordStore();
  const { conn } = scriptConn('script', []);
  const engine = await Engine.openWithRecordStore({ home: tmpHome(), connections: { script: conn }, recordStore: store, lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const sent = await session.send({ text: 'A new path', expectedVersion: await session.version() });
  await session.name('Renamed story');
  const forkId = await session.fork({ at: sent.messageId });
  expect((await engine.listSessions()).find((row) => row.id === session.id)?.title).toBe('Renamed story');
  const fork = await engine.session(forkId);
  expect((await fork.view()).head).toBe(sent.messageId);
  expect((await fork.header()).fork).toEqual({ from: session.id, at: sent.messageId });
  await session.close();
  await engine.nameSession(session.id, 'Named after reopening');
  expect((await engine.listSessions()).find((row) => row.id === session.id)?.title).toBe('Named after reopening');
  await engine.close();
});

test('file RecordStore uses the same async engine path', async () => {
  const home = tmpHome();
  const { conn } = scriptConn('script', calls([{ text: 'Stored on disk.' }]));
  const engine = await Engine.openWithRecordStore({ home, connections: { script: conn }, recordStore: new FileRecordStore(home), lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const sent = await session.send({ text: 'Go.', expectedVersion: await session.version() });
  const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
  for await (const _ of turn.events) { /* consume */ }
  expect(await turn.result).toMatchObject({ type: 'done' });
  await engine.close();
});

test('review gate works through the asynchronous session facade', async () => {
  const store = new MemoryRecordStore();
  const { conn, provider } = scriptConn('script', calls([{ text: 'Approved.' }]));
  const engine = await Engine.openWithRecordStore({ home: tmpHome(), connections: { script: conn }, recordStore: store, lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const sent = await session.send({ text: 'Hello', expectedVersion: await session.version() });
  const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version, inspect: true });
  for await (const event of turn.events) {
    if (event.type === 'gate') expect(await session.answerGate(turn.turnId, event.gateId, { action: 'send' })).toBe(true);
  }
  expect(await turn.result).toMatchObject({ type: 'done' });
  expect(provider.requests).toHaveLength(1);
  await engine.close();
});

test('a delayed write in one session does not block another session', async () => {
  class SlowStore extends MemoryRecordStore {
    pending: (() => void) | null = null;
    override async append(lease: Lease, entries: readonly Entry[], durable: boolean): Promise<void> {
      if (entries.some((row) => row.t === 'prep')) await new Promise<void>((resolve) => { this.pending = resolve; });
      await super.append(lease, entries, durable);
    }
  }
  const store = new SlowStore();
  const { conn } = scriptConn('script', calls([{ text: 'First.' }]));
  const engine = await Engine.openWithRecordStore({ home: tmpHome(), connections: { script: conn }, recordStore: store, lane: 'manual' });
  const first = await engine.createSession({ character: MIRA });
  const second = await engine.createSession({ character: MIRA });
  const one = await first.send({ text: 'One', expectedVersion: await first.version() });
  const turn = await first.runTurn({ kind: 'reply', expectedVersion: one.version });
  for (let i = 0; i < 100 && !store.pending; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(store.pending).not.toBeNull();
  const two = await second.send({ text: 'Two', expectedVersion: await second.version() });
  expect(two.version).toBeGreaterThan(0);
  store.pending?.();
  for await (const _ of turn.events) { /* consume */ }
  await engine.close();
});

test('failed durable prep never calls the provider and releases the lease on close', async () => {
  class FailingStore extends MemoryRecordStore {
    override async append(lease: Lease, entries: readonly Entry[], durable: boolean): Promise<void> {
      if (entries.some((row) => row.t === 'prep')) throw new Error('store write failed');
      await super.append(lease, entries, durable);
    }
  }
  const store = new FailingStore();
  const { conn, provider } = scriptConn('script', calls([{ text: 'Never sent.' }]));
  const home = tmpHome();
  const engine = await Engine.openWithRecordStore({ home, connections: { script: conn }, recordStore: store, lane: 'manual' });
  const session = await engine.createSession({ character: MIRA });
  const id = session.id;
  const sent = await session.send({ text: 'Hello', expectedVersion: await session.version() });
  const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
  for await (const _ of turn.events) { /* consume */ }
  expect(await turn.result).toMatchObject({ type: 'failed' });
  expect(provider.requests).toHaveLength(0);
  await expect(engine.close()).rejects.toThrow('store write failed');
  const another = await Engine.openWithRecordStore({ home, connections: { script: conn }, recordStore: store, lane: 'manual' });
  const reopened = await another.session(id);
  expect((await reopened.view()).path.at(-1)?.role).toBe('user');
  await another.close();
});
