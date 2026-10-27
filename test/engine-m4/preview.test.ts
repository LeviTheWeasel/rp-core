// M4 preview (D-106): never calls the Director; with it on, the request carries the contract and, at
// depth 1, a stub for a turn not planned yet, the reused directive for a swipe that would reuse, and a
// past answer's stored directive for preview({turn}) — so /trace and /preview --turn show what was sent.
import { describe, expect, test } from 'bun:test';
import { contractText, renderDirective, STUB_DIRECTIVE } from '../../src/agents/director/render.ts';
import type { PreviewResult } from '../../src/engine/api.ts';
import type { ModelRequest } from '../../src/providers/types.ts';
import { byAgent, calls, dirCall, dirSession, msgBySrc, msgRow, planOf, recordOf, rig, textOfMsg, turnOf } from './kit.ts';

const ok = (p: PreviewResult): Extract<PreviewResult, { ok: true }> => {
  if (!p.ok) throw new Error(`preview refused: ${p.code} ${p.message}`);
  return p;
};
const seen = (req: ModelRequest) => ({ messages: req.messages, prefill: req.prefill ?? null, maxTokens: req.maxTokens, samplers: req.samplers });
const seenOf = (p: Extract<PreviewResult, { ok: true }>) => ({ messages: p.messages, prefill: p.prefill, maxTokens: p.maxTokens, samplers: p.samplers });
const directorText = (p: { messages: { src: string; blocks: { k: string; text?: string }[] }[] }): string | undefined => {
  const m = p.messages.find((x) => x.src === 'director');
  return m && m.blocks.map((b) => b.text ?? '').join('');
};

describe('preview with the Director on', () => {
  test('the next reply: the contract and the stub at depth 1; nothing is called', async () => {
    const r = await rig(calls());
    const s = dirSession(r.engine);
    const p = ok(s.preview());
    expect(p.kind).toBe('reply');
    expect(directorText(p)).toBe(STUB_DIRECTIVE);
    const core = p.messages.find((m) => m.src === 'core:director');
    expect(core && core.blocks[0]).toEqual({ k: 'text', text: contractText('Levi') });
    // Right above U.
    const at = p.messages.findIndex((m) => m.src === 'director');
    expect(at).toBe(p.messages.length - 2);
    // A draft is a next reply too.
    expect(directorText(ok(s.preview({ draft: 'And then?' })))).toBe(STUB_DIRECTIVE);
    expect(r.provider.requests).toHaveLength(0);
    await r.engine.close();
  });

  test('the next swipe shows the directive it would reuse; with replan the stub', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'The lamp gutters.' }], [{ text: 'Swiped.' }]));
    const s = dirSession(r.engine);
    const a = await turnOf(s);
    const rec = recordOf(msgRow(r.home, s.id, a.turn.messageId).dir);
    const p = ok(s.preview());
    expect(p.kind).toBe('swipe');
    expect(directorText(p)).toBe(renderDirective(rec.directive!));
    // What the swipe then sends is what the preview showed.
    await turnOf(s, 'swipe');
    expect(seenOf(p)).toEqual(seen(byAgent(r.provider.requests, 'narrator')[1]!));

    s.configure({ director: { onSwipe: 'replan' } });
    expect(directorText(ok(s.preview()))).toBe(STUB_DIRECTIVE);
    expect(byAgent(r.provider.requests, 'director')).toHaveLength(1);
    await r.engine.close();
  });

  test("preview({turn}) re-renders that answer's stored directive: the request it sent, rebuilt", async () => {
    const r = await rig(calls(dirCall(), [{ text: 'First.' }], dirCall(planOf({ directive: { mood: 'grim' }, chapterUpdate: { action: 'none' } })), [{ text: 'Second.' }]));
    const s = dirSession(r.engine);
    const a = await turnOf(s);
    s.send({ text: 'I go on.', expectedVersion: s.version() });
    const b = await turnOf(s);
    const [n1, n2] = byAgent(r.provider.requests, 'narrator');
    const p1 = ok(s.preview({ turn: a.turn.messageId }));
    expect(seenOf(p1)).toEqual(seen(n1!));
    expect(p1.notices.map((n) => n.code)).not.toContain('preview_inputs_changed');
    const p2 = ok(s.preview({ turn: b.turn.messageId }));
    expect(seenOf(p2)).toEqual(seen(n2!));
    expect(textOfMsg(msgBySrc(n2!, 'director')!)).toContain('grim');
    await r.engine.close();
  });

  test('a failed plan sent no directive, and its preview shows none', async () => {
    const r = await rig(calls([{ text: 'no plan' }], [{ text: 'still no plan' }], [{ text: 'Arrived.' }]));
    const s = dirSession(r.engine);
    const a = await turnOf(s);
    const p = ok(s.preview({ turn: a.turn.messageId }));
    expect(directorText(p)).toBeUndefined();
    expect(seenOf(p)).toEqual(seen(byAgent(r.provider.requests, 'narrator')[0]!));
    await r.engine.close();
  });

  test('the Director off: no contract, no stub', async () => {
    const r = await rig(calls());
    const s = dirSession(r.engine, { director: { enabled: false } });
    const p = ok(s.preview());
    expect(p.messages.some((m) => m.src === 'director' || m.src === 'core:director')).toBe(false);
    await r.engine.close();
  });
});
