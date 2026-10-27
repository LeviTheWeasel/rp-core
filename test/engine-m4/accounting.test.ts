// M4 accounting and the Director-off guarantee: the Director's calls count toward CALL_CEILING (D-101),
// and with the Director off every request, trace and stored line is the M3 one (D-106).
import { describe, expect, test } from 'bun:test';
import { CALL_CEILING } from '../../src/engine/narrate.ts';
import { hashRequest } from '../../src/providers/scripted.ts';
import type { ModelRequest } from '../../src/providers/types.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { calls as m3calls, entriesOf as m3entries, MIRA_TOOLS, reply, rig as m3rig, session as m3session } from '../engine-m3/kit.ts';
import { byAgent, calls, dirCall, entriesOf, LEVI, MIRA, rig, statuses, turnOf } from './kit.ts';

describe('the call ceiling counts the Director (D-101)', () => {
  /** 4 Director calls (call, retry, correction, retry; the plan fails), then 7 tool rounds and an answer. */
  async function run(director: boolean): Promise<{ rounds: NonNullable<MsgEntry['trace']>['rounds']; agents: string[] }> {
    const dirSteps = director
      ? m3calls([{ error: { code: 'rate_limited', status: 429 } }], [{ text: 'no plan here' }], [{ error: { code: 'rate_limited', status: 429 } }], [{ text: 'still none' }])
      : [];
    const narr = m3calls(...Array.from({ length: 7 }, (_, i) => [{ tool: { name: 'lookup', args: { q: `q${i}` } } }]), [{ text: 'Found it.' }]);
    const r = await m3rig([...dirSteps, ...narr]);
    const s = m3session(r.engine, 'Where is the red door?', { narrator: { maxRounds: 8 }, ...(director ? { director: { enabled: true } } : {}) });
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    const msg = m3entries(r.home, s.id).findLast((e) => e.t === 'msg') as MsgEntry;
    await r.engine.close();
    return { rounds: msg.trace!.rounds, agents: r.provider.requests.map((x) => x.agent ?? '') };
  }

  test(`with 4 Director calls the narrator's 8th call is the final one (ended 'ceiling', ${CALL_CEILING} calls in all)`, async () => {
    const on = await run(true);
    expect(on.agents.filter((a) => a === 'director')).toHaveLength(4);
    expect(on.agents).toHaveLength(CALL_CEILING);
    expect(on.rounds).toMatchObject({ n: 8, ended: 'ceiling' });
    const off = await run(false);
    expect(off.rounds).toMatchObject({ n: 8, ended: 'answer' });
  });
});

describe('the Director off: the M3 request and lines (D-106)', () => {
  const NARR = [{ text: 'The lamp gutters.' }];
  const sendOne = async (config: Record<string, unknown>, script = calls(NARR)) => {
    const r = await rig(script);
    const s = r.engine.createSession({ character: MIRA, persona: LEVI, config });
    s.send({ text: 'I look around the room.', expectedVersion: s.version() });
    const t = await turnOf(s);
    await r.engine.close();
    return { r, s, t, req: byAgent(r.provider.requests, 'narrator')[0]! };
  };
  const withoutDirector = (req: ModelRequest): ModelRequest => ({ ...req, messages: req.messages.filter((m) => m.src !== 'director' && m.src !== 'core:director') });

  test('off (default, explicit, or with other Director settings): the same request bytes, no dir, no director trace or event', async () => {
    const base = await sendOne({});
    const explicit = await sendOne({ director: { enabled: false, profile: 'full', onSwipe: 'replan', style: 'the-jester', instructions: 'Be bold.' } });
    expect(hashRequest(explicit.req)).toBe(hashRequest(base.req));
    expect(JSON.stringify(explicit.req.messages)).toBe(JSON.stringify(base.req.messages));
    for (const { r, s, t } of [base, explicit]) {
      expect(statuses(t.evs)).toEqual([]);
      const rows = entriesOf(r.home, s.id);
      const prep = rows.find((e) => e.t === 'prep')!;
      const msg = rows.findLast((e) => e.t === 'msg')!;
      expect('dir' in prep).toBe(false);
      expect('dir' in msg).toBe(false);
      expect(prep.t === 'prep' && prep.trace.agents).toEqual({});
      expect(msg.t === 'msg' && msg.trace!.agents).toEqual({});
      expect(msg.t === 'msg' && msg.trace!.calls.map((c) => c.agent)).toEqual(['narrator']);
      expect(base.req.messages.some((m) => m.src.startsWith('core:') || m.src === 'director')).toBe(false);
    }
  });

  test('on: the narrator request is the off one plus the contract and the directive, nothing else', async () => {
    const off = await sendOne({});
    const on = await sendOne({ director: { enabled: true } }, calls(dirCall(), NARR));
    expect(on.req.messages.map((m) => m.src)).toContain('core:director');
    expect(on.req.messages.map((m) => m.src)).toContain('director');
    expect(hashRequest(withoutDirector(on.req))).toBe(hashRequest(off.req));
  });
});
