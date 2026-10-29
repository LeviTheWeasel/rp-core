import { expect, test } from 'bun:test';
import { calls, drain, entriesOf, rig, until, withUserMessage } from './kit.ts';

test('held reply survives reopen and commitAnyway saves a tail when the head moved', async () => {
  const { engine, home, provider } = await rig(calls([{ text: 'A branch.' }, { pause: 'gate' }]));
  const { s, version, userId } = withUserMessage(engine);
  const greeting = s.view().path[0]!.id;
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
  await until(() => provider.requests.length === 1);
  s.select({ messageId: greeting, exact: true, expectedVersion: version });
  provider.release('gate');
  expect((await turn.result).type).toBe('conflict');
  await drain(turn);
  await s.close();
  const reopened = engine.session(s.id);
  expect(reopened.view().head).toBe(greeting);
  const result = reopened.commitAnyway(turn.turnId);
  expect(result.outcome).toBe('committed');
  expect(result.message?.parent).toBe(userId);
  expect(reopened.view().head).toBe(greeting);
  const saved = entriesOf(home, s.id).find((entry) => entry.t === 'msg' && entry.turn === turn.turnId);
  expect(saved?.t === 'msg' && saved.tail).toBe(true);
  await engine.close();
});

test('discard closes a held turn and allows another turn', async () => {
  const { engine, provider } = await rig(calls([{ text: 'Discard me.' }, { pause: 'gate' }], [{ text: 'Keep me.' }]));
  const { s, version, userId } = withUserMessage(engine);
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
  await until(() => provider.requests.length === 1);
  s.edit({ messageId: userId, text: 'Edited', expectedVersion: version });
  provider.release('gate');
  expect((await turn.result).type).toBe('conflict');
  await drain(turn);
  expect(s.discard(turn.turnId).discarded).toBe(turn.turnId);
  const next = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
  expect((await next.result).type).toBe('done');
  await drain(next);
  await engine.close();
});

test('commitAnyway discards a continued answer when its target text changed', async () => {
  const { engine, provider } = await rig(calls([{ text: 'First.' }], [{ text: ' Later.' }, { pause: 'gate' }]));
  const { s, version } = withUserMessage(engine);
  const first = s.runTurn({ kind: 'reply', expectedVersion: version });
  const firstOutcome = await first.result;
  await drain(first);
  if (firstOutcome.type !== 'done') throw new Error('first reply did not finish');
  const target = firstOutcome.message.id;
  const continued = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
  await until(() => provider.requests.length === 2);
  s.edit({ messageId: target, text: 'Changed.', expectedVersion: s.version() });
  provider.release('gate');
  expect((await continued.result).type).toBe('conflict');
  await drain(continued);
  expect(s.commitAnyway(continued.turnId).outcome).toBe('discarded');
  expect(s.view().path.at(-1)?.blocks.find((block) => block.k === 'text')?.text).toBe('Changed.');
  await engine.close();
});

test('commitAnyway drops a reply when its original user message was hidden', async () => {
  const { engine, home, provider } = await rig(calls([{ text: 'Unwanted.' }, { pause: 'gate' }]));
  const { s, version, userId } = withUserMessage(engine);
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
  await until(() => provider.requests.length === 1);
  s.hide({ messageId: userId, hidden: true, expectedVersion: version });
  provider.release('gate');
  expect((await turn.result).type).toBe('conflict');
  await drain(turn);
  expect(s.commitAnyway(turn.turnId).outcome).toBe('dropped');
  expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', turn: turn.turnId, outcome: 'dropped' });
  await engine.close();
});
