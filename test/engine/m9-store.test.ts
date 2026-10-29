import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { Engine } from '../../src/engine/engine.ts';
import { MemorySessionStore } from '../../src/session/backend.ts';
import { calls, drain, rig, withUserMessage } from './kit.ts';

test('engine runs, forks and reopens a story on a host-owned memory journal', async () => {
  const store = new MemorySessionStore();
  const { engine, home, conn } = await rig(calls([{ text: 'The map opens.' }]), { extra: { sessionStore: store, lane: 'manual' } });
  const { s, version } = withUserMessage(engine, 'Show me the map.');
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
  await drain(turn);
  expect(await turn.result).toMatchObject({ type: 'done' });
  const answerId = turn.messageId;
  s.name('The map story');
  expect(store.list().find((row) => row.id === s.id)?.title).toBe('The map story');
  const forkId = s.fork({ at: answerId });
  expect(store.list().some((row) => row.id === forkId)).toBe(true);
  const id = s.id;
  expect(readdirSync(`${home}/sessions`).filter((name) => name.endsWith('.jsonl'))).toEqual([]);
  await engine.close();

  const reopened = await Engine.open({ home, connections: { script: conn }, sessionStore: store, lane: 'manual' });
  const again = reopened.session(id);
  expect(again.view().head).toBe(answerId);
  expect(again.view().path.at(-1)?.blocks).toEqual([{ k: 'text', text: 'The map opens.' }]);
  const fork = reopened.session(forkId);
  expect(fork.view().head).toBe(answerId);
  expect(fork.header().fork).toEqual({ from: id, at: answerId });
  await reopened.close();
});

test('memory backend enforces an exclusive session lease across engines', async () => {
  const store = new MemorySessionStore();
  const { engine, home, conn } = await rig([], { extra: { sessionStore: store, lane: 'manual' } });
  const { s } = withUserMessage(engine, 'Hello');
  const head = s.view().head;
  const second = await Engine.open({ home, connections: { script: conn }, sessionStore: store, lane: 'manual' });
  expect(() => second.session(s.id)).toThrow();
  await engine.close();
  const opened = second.session(s.id);
  expect(opened.view().head).toBe(head);
  await second.close();
});
