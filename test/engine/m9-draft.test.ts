import { expect, test } from 'bun:test';
import { calls, entriesOf, rig, withUserMessage } from './kit.ts';

test('quiet draft calls the model once and leaves the journal untouched', async () => {
  const { engine, provider, home } = await rig(calls([{ text: 'A short answer.' }]));
  const { s } = withUserMessage(engine, 'Hello');
  const before = entriesOf(home, s.id);
  const version = s.version();
  const draft = await s.draft({ kind: 'quiet', prompt: 'Summarize the story.' });
  expect(draft.text).toBe('A short answer.');
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]?.tools).toBeUndefined();
  expect(entriesOf(home, s.id)).toEqual(before);
  expect(s.version()).toBe(version);
  await engine.close();
});
