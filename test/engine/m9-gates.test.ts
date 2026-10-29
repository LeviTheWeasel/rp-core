import { expect, test } from 'bun:test';
import { calls, drain, rig, withUserMessage } from './kit.ts';

test('review gate waits for an answer and applies edits before the provider call', async () => {
  const { engine, provider } = await rig(calls([{ text: 'Approved' }]));
  const { s, version } = withUserMessage(engine, 'Hello');
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version, inspect: true });
  const events = (async () => {
    for await (const event of turn.events) {
      if (event.type === 'gate') {
        expect(provider.requests).toHaveLength(0);
        expect(s.answerGate(turn.turnId, event.gateId, { action: 'send', edits: [{ index: (event.payload as { messages: unknown[] }).messages.length - 1, text: 'Approved prompt' }] })).toBe(true);
        expect(s.answerGate(turn.turnId, event.gateId, { action: 'send' })).toBe(false);
      }
    }
  })();
  await events;
  expect(await turn.result).toMatchObject({ type: 'done' });
  expect(provider.requests[0]?.messages.at(-1)?.blocks).toEqual([{ k: 'text', text: 'Approved prompt' }]);
  await engine.close();
});

test('stopping a review gate cancels without a model call', async () => {
  const { engine, provider } = await rig(calls([{ text: 'Unreachable' }]));
  const { s, version } = withUserMessage(engine, 'Hello');
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version, inspect: true });
  for await (const event of turn.events) if (event.type === 'gate') s.stop(turn.turnId);
  expect(await turn.result).toMatchObject({ type: 'stopped', message: null });
  expect(provider.requests).toHaveLength(0);
  await engine.close();
});

test('transform gate timeout fails closed before the provider sees a request', async () => {
  const { engine, provider } = await rig(calls([{ text: 'Unreachable' }]), { extra: { hookTimeoutMs: 5 } });
  const { s, version } = withUserMessage(engine, 'Hello');
  const turn = s.runTurn({ kind: 'reply', expectedVersion: version, transformGate: true });
  await drain(turn);
  expect(await turn.result).toMatchObject({ type: 'failed', code: 'host_transform_failed' });
  expect(provider.requests).toHaveLength(0);
  await engine.close();
});
