import { expect, test } from 'bun:test';
import type { SessionImpl } from '../../src/engine/session.ts';
import { MIRA, rig } from '../engine/kit.ts';

test('historical memory reads fold the selected branch without moving the head', async () => {
  const { engine } = await rig([]);
  const s = engine.createSession({ character: MIRA });
  const greeting = s.view().head!;
  const first = s.send({ text: 'First branch', expectedVersion: s.version() }).messageId;
  s.select({ messageId: greeting, exact: true, expectedVersion: s.version() });
  const second = s.send({ text: 'Second branch', expectedVersion: s.version() }).messageId;
  (s as unknown as SessionImpl).append({
    t: 'mem', ts: '2026-10-26T12:00:00.000Z', key: null, on: first, by: 'user',
    ops: [{ op: 'note', title: 'First secret', keys: ['secret'], content: 'Only on the first branch.' }],
  });
  const head = s.view().head;
  expect(s.memoryList({ at: first, type: 'note' }).map((row) => row.name)).toEqual(['First secret']);
  expect(s.memoryGet({ at: first, ref: 'C1' }).entry.content).toBe('Only on the first branch.');
  expect(s.memoryTree({ at: first })[0]).toBeDefined();
  expect(s.memoryList({ at: second, type: 'note' })).toEqual([]);
  expect(s.memoryList({ type: 'note' })).toEqual([]);
  expect(s.view().head).toBe(head);
  await engine.close();
});
