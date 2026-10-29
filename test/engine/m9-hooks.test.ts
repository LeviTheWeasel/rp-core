import { describe, expect, test } from 'bun:test';
import { calls, drain, entriesOf, rig, withUserMessage } from './kit.ts';
import type { HostHooks } from '../../src/engine/hooks.ts';

describe('M9 host transforms', () => {
  test('request edit reaches the provider and reply edit reaches the journal', async () => {
    const hooks: HostHooks = {
      transformRequest: async ({ messages }) => ({ edits: [{ index: messages.length - 1, text: 'Changed by host' }] }),
      transformReply: async () => ({ text: 'Edited reply' }),
    };
    const { engine, provider, home } = await rig(calls([{ text: 'Original reply' }]), { extra: { hooks } });
    const { s, version } = withUserMessage(engine, 'Original user');
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(turn);
    const result = await turn.result;
    expect(result.type).toBe('done');
    if (result.type === 'done') {
      expect(result.message.blocks).toEqual([{ k: 'text', text: 'Edited reply' }]);
    }
    expect(provider.requests[0]?.messages.at(-1)?.blocks).toEqual([{ k: 'text', text: 'Changed by host' }]);
    const answer = entriesOf(home, s.id).find((e) => e.t === 'msg' && e.id === turn.messageId);
    expect(answer?.t === 'msg' ? answer.trace?.hooks : undefined).toEqual([{ name: 'transformRequest', ok: true }, { name: 'transformReply', ok: true }]);
    await engine.close();
  });

  test('a rejected request transform never sends the original request', async () => {
    const { engine, provider } = await rig(calls([{ text: 'Unreachable' }]), {
      extra: { hooks: { transformRequest: async () => { throw new Error('host rejected'); } } },
    });
    const { s, version } = withUserMessage(engine, 'Hello');
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(turn);
    expect(await turn.result).toMatchObject({ type: 'failed', code: 'host_transform_failed' });
    expect(provider.requests).toHaveLength(0);
    await engine.close();
  });

  test('reply veto prevents commit', async () => {
    const { engine } = await rig(calls([{ text: 'Private' }]), { extra: { hooks: { transformReply: async () => ({ veto: 'blocked' }) } } });
    const { s, version } = withUserMessage(engine, 'Hello');
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(turn);
    expect(await turn.result).toMatchObject({ type: 'failed', code: 'host_veto', draft: 'Private' });
    expect(s.view().head).not.toBe(turn.messageId);
    await engine.close();
  });
});
