// trace.tokens.estimated counts native tool declarations (integrate fix of the loop agent's note 21):
// the server counts them as prompt, so the EMA sample and the server-window check compare like with
// like. Prompted tools are already in the messages (the core block); no tools: M2's sum exactly.
import { describe, expect, test } from 'bun:test';
import { CHARS_COUNTER, estimateToolSpecs } from '../../src/prompt/tokens.ts';
import { calls, capsWith, reply, rig, session, traceOf } from './kit.ts';

const sumBlocks = (t: { blocks: { tok: number }[] }): number => t.blocks.reduce((s, b) => s + b.tok, 0);

describe('tokens.estimated and native declarations', () => {
  test('native: the messages plus the declarations; preview says the same', async () => {
    const r = await rig(calls([{ text: 'The red door is north.' }]), { caps: capsWith('native') });
    const s = session(r.engine);
    const p = s.preview();
    if (!p.ok) throw new Error(p.message);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    const specs = r.provider.requests[0]!.tools ?? [];
    expect(specs.length).toBeGreaterThan(0);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.tokens.estimated).toBe(sumBlocks(trace) + estimateToolSpecs(specs, CHARS_COUNTER));
    expect(p.trace.tokens.estimated).toBe(trace.tokens.estimated);
    await r.engine.close();
  });

  test('prompted: the catalog is a message, nothing is added', async () => {
    const r = await rig(calls([{ text: 'The red door is north.' }]), { caps: capsWith('prompted') });
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(r.provider.requests[0]!.messages.some((m) => m.src === 'core:tools')).toBe(true);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.tokens.estimated).toBe(sumBlocks(trace));
    await r.engine.close();
  });

  test('no tools: the sum of the rows, as in M2', async () => {
    const r = await rig(calls([{ text: 'The red door is north.' }]), { caps: capsWith('none') });
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(r.provider.requests[0]!.tools ?? null).toBeNull();
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.tokens.estimated).toBe(sumBlocks(trace));
    await r.engine.close();
  });
});
