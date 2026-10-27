// The turn around the loop (.notes/m3-decisions.md B1, B2, B11–B13, B16): Stop and failures mid-loop,
// empty turns, retry and fallback, usage and the EMA, the trace, crash recovery, continue.
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import { emaSamples } from '../../src/engine/ema.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import type { EditEntry, MsgEntry } from '../../src/session/entries.ts';
import { sessionsDir } from '../../src/session/log.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import {
  calls,
  capsWith,
  chkText,
  codes,
  drain,
  entriesOf,
  lookupTool,
  msgText,
  reply,
  rig,
  scriptConn,
  session,
  sets,
  slowTool,
  streamed,
  textOf,
  traceOf,
  until,
  usageEvents,
  type ToolLog,
} from './kit.ts';

const U = (inputTotal: number, outputTotal = 10, cost?: number) => ({ usage: { inputTotal, outputTotal, ...(cost !== undefined ? { cost } : {}) } });
const fail503 = { error: { code: 'overloaded' as const, status: 503 } };

describe('Stop mid-loop (B12, §6.5)', () => {
  test('during a slow tool: the running call gets "cancelled", the text so far commits as stopped', async () => {
    const log: ToolLog = { runs: [] };
    const never = new Promise<void>(() => undefined);
    const r = await rig(calls([{ text: 'Let me check.' }, { tool: { name: 'slow', args: { q: 'door' } } }, { tool: { name: 'lookup', args: { q: 'x' } } }]), {
      toolSets: sets([slowTool(log, never), lookupTool(log)]),
    });
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs = drain(turn);
    await until(() => log.runs.some((x) => x.name === 'slow'));
    s.stop();
    const out = await turn.result;
    await evs;
    expect(out.type).toBe('stopped');
    if (out.type !== 'stopped' || !out.message) throw new Error('no message');
    expect(out.message.blocks).toEqual([
      { k: 'text', text: 'Let me check.' },
      { k: 'tool_call', id: 'call_1_0', name: 'slow', args: '{"q":"door"}' },
      { k: 'tool_call', id: 'call_1_1', name: 'lookup', args: '{"q":"x"}' },
      { k: 'tool_result', callId: 'call_1_0', name: 'slow', text: 'cancelled', error: true },
      // A call that settled before the Stop keeps its result.
      { k: 'tool_result', callId: 'call_1_1', name: 'lookup', text: 'found x' },
    ]);
    expect(out.message.gen?.finish).toBe('stopped');
    expect(log.runs.find((x) => x.name === 'slow')!.signal.aborted).toBe(true);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.rounds!.ended).toBe('stopped');
    expect(trace.tools!.map((t) => [t.name, t.ok, t.refused])).toEqual([
      ['slow', false, 'cancelled'],
      ['lookup', true, undefined],
    ]);
    // No second model call after a Stop.
    expect(r.provider.requests.length).toBe(1);
    await r.engine.close();
  });

  test('during a tool with no text yet: stopped-empty, the tool rounds are not kept', async () => {
    const log: ToolLog = { runs: [] };
    const r = await rig(calls([{ tool: { name: 'slow', args: { q: 'door' } } }]), { toolSets: sets([slowTool(log, new Promise(() => undefined))]) });
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs = drain(turn);
    await until(() => log.runs.length === 1);
    s.stop();
    expect(await turn.result).toEqual({ type: 'stopped', message: null });
    await evs;
    expect(entriesOf(r.home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'stopped-empty' });
    await r.engine.close();
  });

  test('during round 1\'s stream: the earlier rounds stay paired, the partial text commits', async () => {
    const r = await rig(calls([{ text: 'Let me check.' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'The door' }, { pause: 'p' }, { text: ' is red.' }]));
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs = drain(turn);
    await until(() => r.provider.requests.length === 2 && chkText(r.home, s.id, turn.turnId).endsWith('The door'));
    s.stop();
    const out = await turn.result;
    await evs;
    if (out.type !== 'stopped' || !out.message) throw new Error(out.type);
    expect(out.message.blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    expect(textOf(out.message)).toBe('Let me check.\nThe door');
    await r.engine.close();
  });
});

describe('failure mid-loop (B12, D-22)', () => {
  const script = () =>
    calls([{ text: 'Let me check.' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'The do' }, { error: { code: 'overloaded', status: 503, afterOutput: true } }]);

  test("onError 'drop': end{failed}, the draft is the visible text; no retry after output", async () => {
    const r = await rig(script());
    const s = session(r.engine);
    const { out, evs } = await reply(s);
    expect(out).toMatchObject({ type: 'failed', code: 'overloaded', draft: 'Let me check.\nThe do' });
    expect(evs.some((e) => e.type === 'retry')).toBe(false);
    expect(entriesOf(r.home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'overloaded' });
    expect(r.provider.requests.length).toBe(2);
    await r.engine.close();
  });

  test("onError 'keep': the blocks so far commit as interrupted", async () => {
    const r = await rig(script());
    const s = session(r.engine);
    const { out } = await reply(s, { onError: 'keep' });
    expect(out.type).toBe('failed');
    const msg = entriesOf(r.home, s.id).filter((e): e is MsgEntry => e.t === 'msg').at(-1)!;
    expect(msg.gen?.finish).toBe('interrupted');
    const blocks = msg.blocks ?? [];
    expect(blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    expect(textOf({ blocks })).toBe('Let me check.\nThe do');
    expect(msg.trace?.rounds).toMatchObject({ n: 2, ended: 'error' });
    await r.engine.close();
  });

  test('a later round failing before its own output is not retried either (the turn already had output)', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'door' } } }], [fail503], [{ text: 'never' }]));
    const s = session(r.engine);
    const { out, evs } = await reply(s);
    expect(out).toMatchObject({ type: 'failed', code: 'overloaded', draft: '' });
    expect(evs.some((e) => e.type === 'retry')).toBe(false);
    expect(r.provider.requests.length).toBe(2);
    await r.engine.close();
  });
});

describe('empty turns (B11)', () => {
  test('tools then nothing: empty_response, nothing committed', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'door' } } }], []));
    const s = session(r.engine);
    const { out } = await reply(s);
    expect(out).toMatchObject({ type: 'failed', code: 'empty_response' });
    expect(entriesOf(r.home, s.id).some((e) => e.t === 'msg' && e.role === 'assistant' && e.gen?.kind === 'model')).toBe(false);
    await r.engine.close();
  });

  test('tools then only reasoning: reasoning_only with the reasoning as the draft; keep commits M2\'s shape', async () => {
    const script = () => calls([{ reasoning: 'Hm. ' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ reasoning: 'Red, then.' }]);
    const a = await rig(script());
    const s = session(a.engine);
    expect((await reply(s)).out).toMatchObject({ type: 'failed', code: 'reasoning_only', draft: 'Hm. Red, then.' });
    await a.engine.close();

    const b = await rig(script());
    const t = session(b.engine);
    const { out } = await reply(t, { emptyReply: 'keep' });
    if (out.type !== 'done') throw new Error(out.type);
    expect(out.message.blocks).toEqual([{ k: 'reasoning', text: 'Hm. Red, then.' }, { k: 'text', text: '' }]);
    await b.engine.close();
  });

  test('a final round without text after earlier text commits normally', async () => {
    const r = await rig(calls([{ text: 'The door is red.' }, { tool: { name: 'lookup', args: { q: 'door' } } }], []));
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(out.message.blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result']);
    await r.engine.close();
  });

  test('per-block leak stripping (step 9): a block left empty goes, the order stays', async () => {
    const r = await rig(
      calls([{ text: 'Hm.' }, { tool: { name: 'lookup', args: { q: 'a' } } }], [{ text: '<|tool_calls_section_begin|>junk' }]),
    );
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    // Round 1 streamed only a leak: the stripped block is gone, the answer is round 0's text.
    expect(out.message.blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result']);
    await r.engine.close();
  });
});

describe('retry and fallback around the whole loop (B1, B2)', () => {
  test('round 0 fails before output: one retry re-runs the loop; callKeys keep :0', async () => {
    const r = await rig(calls([fail503], [{ tool: { name: 'lookup', args: { q: 'door' } } }, U(300)], [{ text: 'Red.' }, U(330)]));
    const s = session(r.engine);
    const { out, evs } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(evs.filter((e) => e.type === 'retry')).toEqual([expect.objectContaining({ callKey: expect.stringMatching(/:narrator:0$/), attempt: 1 })]);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.calls.map((c) => c.callKey.split(':').slice(1).join(':'))).toEqual(['narrator:0', 'narrator:0', 'narrator:1']);
    expect(out.message.gen?.route).toEqual([
      { model: 'script:default', status: 'retry', code: 'overloaded' },
      { model: 'script:default', status: 'ok' },
    ]);
    // gen.rounds counts the loop that answered; trace.calls every call of the turn.
    expect(out.message.gen?.rounds).toBe(2);
    await r.engine.close();
  });

  test('D-90: a fallback with another transport gets its own request (prompted catalog, no native tools)', async () => {
    const fb = scriptConn('fb', calls([{ text: '<tool_call>{"name": "lookup", "args": {"q": "door"}}</tool_call>' }], [{ text: 'Red.' }]), capsWith('prompted'));
    const r = await rig(calls([fail503], [fail503]), { connections: { fb: fb.conn } });
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'fb:other' });
    const evs = await drain(turn);
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(out.type);
    // The primary sent native tools; the fallback's request is prompted throughout.
    expect(r.provider.requests[0]!.tools?.map((t) => t.name)).toEqual(['lookup']);
    const [f0, f1] = fb.provider.requests;
    expect(f0!.tools).toBeUndefined();
    expect(f0!.stop).toEqual([PROMPTED_STOP]);
    expect(msgText(f0!.messages.find((m) => m.src === 'core:tools')!)).toContain('<tool_call>');
    expect(f1!.messages.at(-1)!.src).toBe('core:tool_results');
    expect(out.message.gen).toMatchObject({ connection: 'fb', model: 'other', transport: 'prompted', rounds: 2 });
    expect(codes(evs)).toContain('fallback');
    // The prep line keeps the primary's request.
    const prep = entriesOf(r.home, s.id).find((e) => e.t === 'prep' && e.turn === turn.turnId);
    expect(prep).toMatchObject({ model: { connection: 'script', model: 'default' } });
    await r.engine.close();
  });

  test('a fallback with the same transport is reshaped and offered the same tools', async () => {
    const fb = scriptConn('fb', calls([{ tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'Red.' }]), capsWith('native'));
    const r = await rig(calls([fail503], [fail503]), { connections: { fb: fb.conn } });
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'fb:other' });
    await drain(turn);
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(out.type);
    expect(fb.provider.requests[0]!.messages).toEqual(r.provider.requests[0]!.messages);
    expect(fb.provider.requests[0]!.tools).toEqual(r.provider.requests[0]!.tools);
    expect(out.message.gen).toMatchObject({ connection: 'fb', transport: 'native', rounds: 2 });
    // Every call counts: two failed primary calls, then the fallback's two rounds.
    expect(traceOf(r.home, s.id, out.message.id)!.calls.length).toBe(4);
    await r.engine.close();
  });

  test('a fallback without tools gets the M2 request', async () => {
    const fb = scriptConn('fb', calls([{ text: 'Plain.' }]), capsWith('none'));
    const r = await rig(calls([fail503], [fail503]), { connections: { fb: fb.conn } });
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'fb:other' });
    await drain(turn);
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(out.type);
    expect(fb.provider.requests[0]!.tools).toBeUndefined();
    expect(fb.provider.requests[0]!.messages.some((m) => m.src === 'core:tools')).toBe(false);
    expect(out.message.gen).toMatchObject({ transport: 'none', rounds: 1 });
    expect(traceOf(r.home, s.id, out.message.id)!.rounds).toBeUndefined();
    await r.engine.close();
  });

  test('D-94 revised: a same-transport fallback whose echo rule differs gets its own request (its own reasoning echoed)', async () => {
    const deepseek = capsWith('native', { reasoning: { output: 'reasoning_content', control: 'toggle', canDisable: true, echo: 'all-with-tools' } });
    // Turn 1 is the DeepSeek model's own answer, with its reasoning; turn 2's plain primary fails twice.
    const fb = scriptConn('fb', calls([{ reasoning: 'Hm.' }, { text: 'Hi from the fallback model.' }], [{ text: 'Fallback answer.' }]), deepseek);
    const r = await rig(calls([fail503], [fail503]), { caps: capsWith('native'), connections: { fb: fb.conn } });
    const s = session(r.engine, 'Where is the red door?', { roles: { narrator: { conn: 'fb', model: 'other' } } });
    expect((await reply(s)).out.type).toBe('done');
    s.configure({ roles: { narrator: { conn: 'script', model: 'default' } } });
    s.send({ text: 'And the door?', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'fb:other' });
    await drain(turn);
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(out.type);
    expect(out.message.gen).toMatchObject({ connection: 'fb', model: 'other', transport: 'native' });
    const answer = (q: (typeof r.provider.requests)[number]) => q.messages.filter((m) => m.role === 'assistant' && m.src === 'history').at(-1)!.blocks;
    // The primary (no echo) sends the answer text-only; the fallback carries its own reasoning on it.
    expect(answer(r.provider.requests[0]!)).toEqual([{ k: 'text', text: 'Hi from the fallback model.' }]);
    const fq = fb.provider.requests[1]!;
    expect(answer(fq)).toEqual([{ k: 'reasoning', text: 'Hm.' }, { k: 'text', text: 'Hi from the fallback model.' }]);
    expect(fq.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(fq.reasoning).toBeUndefined();
    await r.engine.close();
  });

  test('…and the other way round: the primary echoes its reasoning, a plain fallback never gets it (§8.6)', async () => {
    const deepseek = capsWith('native', { reasoning: { output: 'reasoning_content', control: 'toggle', canDisable: true, echo: 'all-with-tools' } });
    const fb = scriptConn('fb', calls([{ text: 'Fallback answer.' }]), capsWith('native'));
    const r = await rig(calls([{ reasoning: 'Think.' }, { text: 'Hi.' }], [fail503], [fail503]), { caps: deepseek, connections: { fb: fb.conn } });
    const s = session(r.engine);
    await reply(s);
    s.send({ text: 'And the door?', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'fb:other' });
    await drain(turn);
    expect((await turn.result).type).toBe('done');
    expect(r.provider.requests[1]!.messages.some((m) => m.blocks.some((b) => b.k === 'reasoning'))).toBe(true);
    expect(fb.provider.requests[0]!.messages.some((m) => m.blocks.some((b) => b.k === 'reasoning'))).toBe(false);
    await r.engine.close();
  });
});

describe('usage, trace and the EMA (B13)', () => {
  test('one usage event per call, gen.usage summed (cost only when every call has one), reported = round 0', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'door' } } }, U(300, 5, 0.01)], [{ text: 'Red.' }, U(340, 7, 0.02)]));
    const s = session(r.engine);
    const { out, evs, turn } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(usageEvents(evs).map((e) => [e.callKey, e.usage.inputTotal])).toEqual([
      [`${turn.turnId}:narrator:0`, 300],
      [`${turn.turnId}:narrator:1`, 340],
    ]);
    expect(out.message.gen?.usage).toEqual({ inputTotal: 640, outputTotal: 12, cost: 0.03 });
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.tokens.reported).toBe(300);
    expect(trace.calls.map((c) => c.usage?.inputTotal)).toEqual([300, 340]);
    await r.engine.close();
  });

  test('cost is left out of the sum when one call has none', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'door' } } }, U(300, 5, 0.01)], [{ text: 'Red.' }, U(340, 7)]));
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(out.message.gen?.usage).toEqual({ inputTotal: 640, outputTotal: 12 });
    await r.engine.close();
  });

  test('the EMA sample of a tool turn is round 0 (reported first, B13)', async () => {
    const { buildTree } = await import('../../src/session/tree.ts');
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'door' } } }, U(300)], [{ text: 'Red.' }, U(9000)]));
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    const tree = buildTree(entriesOf(r.home, s.id));
    const samples = emaSamples(tree, s.view(), 'default', 'chars');
    const estimated = traceOf(r.home, s.id, out.message.id)!.tokens.estimated;
    expect(samples).toEqual([{ estimated, reported: 300 }]);
    await r.engine.close();
  });
});

describe('crash and continue', () => {
  test('a crash after a tool round recovers the checkpointed text only (§6.7)', async () => {
    const r = await rig(calls([{ text: 'Let me check.' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'The door' }, { pause: 'p' }, { text: ' is red.' }]));
    const s = session(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs = drain(turn);
    await until(() => chkText(r.home, s.id, turn.turnId).endsWith('The door'));
    // The journal as a crash would leave it: copied while the turn is still open.
    const other = tmpHome();
    mkdirSync(sessionsDir(other), { recursive: true });
    for (const f of readdirSync(sessionsDir(r.home))) if (f.startsWith(s.id) && f.endsWith('.jsonl')) copyFileSync(join(sessionsDir(r.home), f), join(sessionsDir(other), f));
    s.stop();
    await evs;
    await r.engine.close();

    const e2 = await Engine.open({ home: other, clock: fakeClock('2026-10-26T13:00:00.000Z'), random: fakeRandom(9), timeZone: 'UTC' });
    const s2 = e2.session(s.id);
    expect(s2.openEvents().filter((e) => e.type === 'recovered')).toEqual([expect.objectContaining({ outcome: 'interrupted' })]);
    const head = s2.view().path.at(-1)!;
    expect(head.blocks).toEqual([{ k: 'text', text: 'Let me check.\nThe door' }]);
    expect(head.gen?.finish).toBe('interrupted');
    await e2.close();
  });

  test('continue on a message with tool blocks: the addition goes to the last text block, the order stays (B16)', async () => {
    const r = await rig(calls([{ text: 'Let me check.' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'The door is red.' }], [{ text: ' It creaks.' }]));
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    const turn = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    await drain(turn);
    const cont = await turn.result;
    if (cont.type !== 'done') throw new Error(cont.type);
    // Continue sends no tools (C1).
    expect(r.provider.requests[2]!.tools).toBeUndefined();
    expect(cont.message.blocks).toEqual([
      { k: 'text', text: 'Let me check.' },
      { k: 'tool_call', id: 'call_1_0', name: 'lookup', args: '{"q":"door"}' },
      { k: 'tool_result', callId: 'call_1_0', name: 'lookup', text: 'found door' },
      { k: 'text', text: '\nThe door is red. It creaks.' },
    ]);
    const edit = entriesOf(r.home, s.id).filter((e): e is EditEntry => e.t === 'edit').at(-1)!;
    expect(edit.reason).toBe('continue');
    expect(edit.gen).toMatchObject({ transport: 'none', rounds: 1 });
    await r.engine.close();
  });
});

describe('notices', () => {
  test('narrator.maxRounds above 8 is clamped with tool_rounds_clamped, once per session', async () => {
    // Distinct arguments every round, so the guard never trips.
    const rounds = Array.from({ length: 8 }, (_, i) => [{ tool: { name: 'lookup', args: { q: `x${i}` } } }]);
    const r = await rig(calls(...rounds, [{ text: 'Done.' }], [{ text: 'Again.' }]));
    const s = session(r.engine, 'Where is the red door?', { narrator: { maxRounds: 20 } });
    const { out, evs } = await reply(s);
    expect(out.type).toBe('done');
    expect(codes(evs)).toContain('tool_rounds_clamped');
    expect(r.provider.requests.length).toBe(9);
    expect(r.provider.requests[8]!.toolChoice).toBe('none');
    s.send({ text: 'More?', expectedVersion: s.version() });
    const second = await reply(s);
    expect(codes(second.evs)).not.toContain('tool_rounds_clamped');
    await r.engine.close();
  });

  test('the text events offsets stay contiguous across rounds', async () => {
    const r = await rig(calls([{ text: 'A' }, { tool: { name: 'lookup', args: { q: 'x' } } }], [{ text: 'B' }, { text: 'C' }]));
    const s = session(r.engine);
    const { evs } = await reply(s);
    let at = 0;
    for (const e of evs) {
      if (e.type !== 'text') continue;
      expect(e.offset).toBe(at);
      at += e.delta.length;
    }
    expect(streamed(evs)).toBe('A\nBC');
    await r.engine.close();
  });
});

