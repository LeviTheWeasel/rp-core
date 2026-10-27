// Ported from Bunraku:src/stage/provider/tool-loop.test.ts@702d8120 (cases 2, 3, 4, 5, 11, 12) and
// Bunraku:src/kit/loop/stop-core.test.ts@702d8120 (the repeat cases), rewritten on the engine.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The narrator's tool loop end to end (.notes/m3-decisions.md B): native and prompted rounds on a
// scripted provider, fake tools through the EngineSeams.toolSets seam.
import { describe, expect, test } from 'bun:test';
import { FINAL_CUE, FINAL_CUE_SRC, RESULTS_SRC, rekeyReplay, roundMaxTokens, ROUND_SRC } from '../../src/engine/narrate.ts';
import { buildChatRequest } from '../../src/providers/openai-chat.ts';
import type { ModelCaps, ModelRequest, Replay } from '../../src/providers/types.ts';
import { CHARS_COUNTER, EMA_START, estimateMessages, estimateToolSpecs, O200K_COUNTER } from '../../src/prompt/tokens.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { NO_ROOM_MARK } from '../../src/tools/run.ts';
import type { Block } from '../../src/session/entries.ts';
import type { Tool } from '../../src/tools/types.ts';
import { LEVI } from '../engine/kit.ts';
import {
  calls,
  capsWith,
  chkText,
  entriesOf,
  codes,
  lastMsg,
  lookupTool,
  MIRA_TOOLS,
  msgOf,
  msgText,
  reply,
  rig,
  session,
  sets,
  streamed,
  textOf,
  toolEvents,
  traceOf,
  type ToolLog,
} from './kit.ts';

const U = (n: number) => ({ usage: { inputTotal: 300 + n, outputTotal: 10 } });

/** The committed message, its chk text and the text events agree (B6). */
function agrees(home: string, sid: string, out: { type: string; message?: unknown }, evs: Parameters<typeof streamed>[0], turn: string): string {
  const shown = streamed(evs);
  expect(chkText(home, sid, turn)).toBe(shown);
  if (out.type === 'done' || out.type === 'stopped') {
    const m = (out as { message: { blocks: Block[] } }).message;
    expect(textOf(m)).toBe(shown);
  }
  return shown;
}

describe('native rounds', () => {
  test('a call, its result, the answer: paired blocks, text === chk === events, the separator', async () => {
    const r = await rig(calls([{ text: 'Let me check.' }, { tool: { name: 'lookup', args: { q: 'door' } } }, U(0)], [{ text: 'The door is red.' }, U(1)]));
    const s = session(r.engine);
    const { evs, out, turn } = await reply(s);
    expect(out.type).toBe('done');
    if (out.type !== 'done') return;
    expect(out.message.blocks).toEqual([
      { k: 'text', text: 'Let me check.' },
      { k: 'tool_call', id: 'call_1_0', name: 'lookup', args: '{"q":"door"}' },
      { k: 'tool_result', callId: 'call_1_0', name: 'lookup', text: 'found door' },
      { k: 'text', text: '\nThe door is red.' },
    ]);
    expect(agrees(r.home, s.id, out, evs, turn.turnId)).toBe('Let me check.\nThe door is red.');

    // Round 0 offers the tool with 'auto'; round 1 carries the round's assistant turn and ONE tool message.
    const [q0, q1] = r.provider.requests;
    expect(q0!.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(q0!.toolChoice).toBe('auto');
    expect(q0!.stop).toBeUndefined();
    expect(q1!.toolChoice).toBe('auto');
    expect(q1!.messages.length).toBe(q0!.messages.length + 2);
    expect(q1!.messages.slice(0, q0!.messages.length)).toEqual(q0!.messages);
    expect(q1!.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        src: ROUND_SRC,
        blocks: [
          { k: 'text', text: 'Let me check.' },
          { k: 'tool_call', id: 'call_1_0', name: 'lookup', args: '{"q":"door"}' },
        ],
      },
      { role: 'tool', src: RESULTS_SRC, blocks: [{ k: 'tool_result', callId: 'call_1_0', name: 'lookup', text: 'found door' }] },
    ]);

    // Tool events, stamped with the turn and the round.
    expect(toolEvents(evs).map(({ sessionId: _s, ts: _t, ...e }) => e)).toEqual([
      { type: 'tool', turnId: turn.turnId, callId: 'call_1_0', name: 'lookup', round: 0, phase: 'start', args: { q: 'door' } },
      { type: 'tool', turnId: turn.turnId, callId: 'call_1_0', name: 'lookup', round: 0, phase: 'done', args: { q: 'door' }, ok: true, summary: '1 hit for door' },
    ]);
    // The tool ran once, with a page bounded by the room.
    expect(r.log.runs.map((x) => x.args)).toEqual([{ q: 'door' }]);
    expect(r.log.runs[0]!.pageChars).toBeGreaterThan(0);

    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.rounds).toMatchObject({ n: 2, transport: 'native', ended: 'answer' });
    expect(trace.rounds!.roomLeft).toBeLessThan(trace.rounds!.room);
    expect(trace.tools).toEqual([{ round: 0, callId: 'call_1_0', name: 'lookup', ok: true, ms: expect.any(Number), chars: 10 }]);
    expect(out.message.gen).toMatchObject({ transport: 'native', rounds: 2, finish: 'end' });
    await r.engine.close();
  });

  test('the separator is lazy: none after whitespace, none before a round without text, one before the next text', async () => {
    const r = await rig(
      calls(
        [{ text: 'Let me check. ' }, { tool: { name: 'lookup', args: { q: 'a' } } }],
        [{ tool: { name: 'lookup', args: { q: 'b' } } }],
        [{ text: 'Done' }, { tool: { name: 'lookup', args: { q: 'c' } } }],
        [{ text: 'Found it.' }],
      ),
    );
    const s = session(r.engine);
    const { evs, out, turn } = await reply(s);
    expect(out.type).toBe('done');
    // Round 0 ended in a space (no separator), round 1 had no text (nothing sent), round 3 follows "Done".
    expect(agrees(r.home, s.id, out, evs, turn.turnId)).toBe('Let me check. Done\nFound it.');
    if (out.type !== 'done') return;
    expect(out.message.blocks.filter((b) => b.k === 'text')).toEqual([
      { k: 'text', text: 'Let me check. ' },
      { k: 'text', text: 'Done' },
      { k: 'text', text: '\nFound it.' },
    ]);
    expect(out.message.blocks.map((b) => b.k)).toEqual([
      'text', 'tool_call', 'tool_result', // round 0
      'tool_call', 'tool_result', // round 1
      'text', 'tool_call', 'tool_result', // round 2
      'text', // round 3
    ]);
    // A round with no text echoes the call alone (content null on the wire).
    const q2 = r.provider.requests[2]!;
    expect(q2.messages.at(-2)!.blocks.map((b) => b.k)).toEqual(['tool_call']);
    await r.engine.close();
  });

  test('ids: the server\'s when safe and new in the turn, else call_<round>_<i>', async () => {
    const r = await rig(
      calls(
        [{ tool: { name: 'lookup', args: { q: 'a' }, id: 'dup' } }, { tool: { name: 'lookup', args: { q: 'b' }, id: 'bad id!' } }],
        [{ tool: { name: 'lookup', args: { q: 'c' }, id: 'dup' } }],
        [{ text: 'ok' }],
      ),
    );
    const s = session(r.engine);
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    if (out.type !== 'done') return;
    expect(out.message.blocks.filter((b) => b.k === 'tool_call').map((b) => (b as { id: string }).id)).toEqual(['dup', 'call_0_1', 'call_1_0']);
    await r.engine.close();
  });

  test('bad arguments: an error result, the echo is {} and the tool never runs', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', argsText: '{"q": {"nested": true}}' } }], [{ text: 'Sorry.' }]));
    const s = session(r.engine);
    const { out, evs } = await reply(s);
    expect(out.type).toBe('done');
    expect(r.log.runs).toEqual([]);
    const q1 = r.provider.requests[1]!;
    const echo = q1.messages.at(-2)!.blocks.find((b) => b.k === 'tool_call') as Extract<Block, { k: 'tool_call' }>;
    expect(echo.args).toBe('{}');
    const result = q1.messages.at(-1)!.blocks[0] as Extract<Block, { k: 'tool_result' }>;
    expect(result.text).toStartWith('Invalid arguments for lookup:');
    expect(result.error).toBe(true);
    if (out.type !== 'done') return;
    expect(traceOf(r.home, s.id, out.message.id)!.tools).toEqual([expect.objectContaining({ name: 'lookup', ok: false, refused: 'bad_args' })]);
    expect(toolEvents(evs).at(-1)).toMatchObject({ phase: 'done', ok: false, summary: 'bad arguments' });
    await r.engine.close();
  });

  test('unknown and unsafe names: error results naming the tools; an unsafe name echoes as invalid_tool', async () => {
    const r = await rig(calls([{ tool: { name: 'nope', args: {} } }, { tool: { name: 'bad name!', args: {} } }], [{ text: 'Hm.' }]));
    const s = session(r.engine);
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    if (out.type !== 'done') return;
    const results = out.message.blocks.filter((b): b is Extract<Block, { k: 'tool_result' }> => b.k === 'tool_result');
    expect(results.map((b) => [b.name, b.text, b.error])).toEqual([
      ['nope', 'Unknown tool "nope". The tools you can call: lookup.', true],
      ['invalid_tool', 'Unknown tool "bad name!". The tools you can call: lookup.', true],
    ]);
    expect(traceOf(r.home, s.id, out.message.id)!.tools!.map((t) => t.refused)).toEqual(['unknown_tool', 'unknown_tool']);
    await r.engine.close();
  });

  test('the same call twice in a round runs once; both get the result', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'door' } } }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'Red.' }]));
    const s = session(r.engine);
    const { out } = await reply(s);
    expect(r.log.runs.length).toBe(1);
    if (out.type !== 'done') throw new Error(out.type);
    expect(out.message.blocks.filter((b) => b.k === 'tool_result').map((b) => (b as { text: string }).text)).toEqual(['found door', 'found door']);
    await r.engine.close();
  });

  test('a Qwen-style <tool_call> in a native round with no native calls is recovered and never shown (D-57)', async () => {
    const r = await rig(
      calls(
        [{ text: 'Let me look. <tool_' }, { text: 'call>{"name": "lookup", "arguments": {"q": "door"}}</tool_call>' }],
        [{ text: 'It is red.' }],
      ),
    );
    const s = session(r.engine);
    const { out, evs, turn } = await reply(s);
    expect(out.type).toBe('done');
    const shown = agrees(r.home, s.id, out, evs, turn.turnId);
    expect(shown).not.toContain('tool_call');
    expect(shown).toBe('Let me look.\nIt is red.');
    expect(r.log.runs.map((x) => x.args)).toEqual([{ q: 'door' }]);
    // The wire echo: the visible text without the markup, the recovered call with a loop id.
    const echo = r.provider.requests[1]!.messages.at(-2)!;
    expect(echo.blocks).toEqual([
      { k: 'text', text: 'Let me look.' },
      { k: 'tool_call', id: 'call_0_0', name: 'lookup', args: '{"q":"door"}' },
    ]);
    await r.engine.close();
  });

  test('a Qwen-style <tool_call> left unclosed after a complete call, in a native round: it runs, and the prose after it stays', async () => {
    for (const tail of ['\nThe tavern is quiet.', '']) {
      const r = await rig(calls([{ text: `Let me look. <tool_call>{"name": "lookup", "arguments": {"q": "door"}}${tail}` }], [{ text: 'It is red.' }]));
      const s = session(r.engine);
      const { out, evs, turn } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(r.log.runs.map((x) => x.args)).toEqual([{ q: 'door' }]);
      expect(agrees(r.home, s.id, out, evs, turn.turnId)).toBe(`Let me look.${tail}\nIt is red.`);
      expect(out.message.blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
      await r.engine.close();
    }
  });

  test('a <tool_call> a native round hides without running it (a tool not offered) is told by tool_markup_stripped', async () => {
    const r = await rig(calls([{ text: 'Let me look. <tool_call>{"name": "elsewhere", "arguments": {"q": "door"}}</tool_call>\nThe door is red.' }]));
    const s = session(r.engine);
    const { out, evs } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(r.log.runs).toEqual([]);
    expect(textOf(out.message)).toBe('Let me look.\nThe door is red.');
    expect(codes(evs)).toContain('tool_markup_stripped');
    await r.engine.close();
  });

  test('a replay payload rides the round\'s assistant message only', async () => {
    const r = await rig(
      calls([{ replay: { kind: 'reasoning_details', payload: [{ type: 'reasoning.text', text: 'x' }] } }, { tool: { name: 'lookup', args: { q: 'a' } } }], [{ text: 'ok' }]),
    );
    const s = session(r.engine);
    await reply(s);
    const q1 = r.provider.requests[1]!;
    expect(q1.messages.at(-2)!.replay).toEqual([{ kind: 'reasoning_details', connection: 'script', model: 'default', payload: [{ type: 'reasoning.text', text: 'x' }] }]);
    expect(q1.messages.filter((m) => m.replay !== undefined).length).toBe(1);
    await r.engine.close();
  });
});

describe('prompted rounds', () => {
  test('the stripper keeps <tool_call> out of events and chk; raw text on the wire; ONE results message', async () => {
    const r = await rig(
      calls(
        [{ text: 'Let me check. <tool_' }, { text: 'call>{"name": "lookup", "args": {"q": "door"}}</tool_call>' }, U(0)],
        [{ text: 'The door is red.' }, U(1)],
      ),
      { caps: capsWith('prompted') },
    );
    const s = session(r.engine);
    const { evs, out, turn } = await reply(s);
    expect(out.type).toBe('done');
    const shown = agrees(r.home, s.id, out, evs, turn.turnId);
    expect(shown).not.toContain('<tool');
    expect(shown).toBe('Let me check.\nThe door is red.');
    if (out.type !== 'done') return;
    expect(out.message.blocks).toEqual([
      { k: 'text', text: 'Let me check.' },
      { k: 'tool_call', id: 'call_0_0', name: 'lookup', args: '{"q":"door"}' },
      { k: 'tool_result', callId: 'call_0_0', name: 'lookup', text: 'found door' },
      { k: 'text', text: '\nThe door is red.' },
    ]);
    const [q0, q1] = r.provider.requests;
    // No native tools; the prompted stop; the catalog lives in the core block.
    expect(q0!.tools).toBeUndefined();
    expect(q0!.toolChoice).toBeUndefined();
    expect(q0!.stop).toEqual([PROMPTED_STOP]);
    const core = q0!.messages.find((m) => m.src === 'core:tools');
    expect(core && msgText(core)).toContain('<tool_call>');
    // The round as the model wrote it (tags kept), then the results as one user message.
    expect(q1!.messages.slice(-2)).toEqual([
      { role: 'assistant', src: ROUND_SRC, blocks: [{ k: 'text', text: 'Let me check. <tool_call>{"name": "lookup", "args": {"q": "door"}}</tool_call>' }] },
      { role: 'user', src: RESULTS_SRC, blocks: [{ k: 'text', text: '<tool_result name="lookup" id="call_0_0">\nfound door\n</tool_result>' }] },
    ]);
    expect(out.message.gen).toMatchObject({ transport: 'prompted', rounds: 2 });
    expect(traceOf(r.home, s.id, out.message.id)!.rounds).toMatchObject({ n: 2, transport: 'prompted', ended: 'answer' });
    await r.engine.close();
  });

  test('the prompted stop joins the sampler stops; over caps.stopMax the sampler\'s last ones go', async () => {
    const r = await rig(calls([{ text: 'Hi.' }], [{ text: 'Hi.' }]), { caps: capsWith('prompted', { stopMax: 2 }) });
    const s = session(r.engine, 'Where is the red door?', { roles: { narrator: { conn: 'script', model: 'default', samplers: { stop: ['END', 'STOP', 'END'] } } } });
    await reply(s);
    expect(r.provider.requests[0]!.stop).toEqual(['END', PROMPTED_STOP]);
    await r.engine.close();
  });

  test('an unreadable block is still a call: its error is the result, paired in storage', async () => {
    const r = await rig(calls([{ text: '<tool_call>{"args": {"q": "door"}}</tool_call>' }], [{ text: 'Fine.' }]), { caps: capsWith('prompted') });
    const s = session(r.engine);
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    if (out.type !== 'done') return;
    const [call, result] = out.message.blocks.filter((b) => b.k !== 'text') as [Extract<Block, { k: 'tool_call' }>, Extract<Block, { k: 'tool_result' }>];
    expect(call).toEqual({ k: 'tool_call', id: 'call_0_0', name: 'invalid_tool', args: '{}' });
    expect(result.callId).toBe('call_0_0');
    expect(result.error).toBe(true);
    expect(result.text).toContain('no "name"');
    expect(r.log.runs).toEqual([]);
    expect(traceOf(r.home, s.id, out.message.id)!.tools).toEqual([expect.objectContaining({ refused: 'bad_args', ok: false })]);
    await r.engine.close();
  });
});

describe('the final round (B4, B9)', () => {
  const oneRound = { narrator: { maxRounds: 1 } };

  test('native: toolChoice none with the schemas declared, the cue as a system message (midSystem native)', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'a' } } }], [{ text: 'Done.' }]));
    const s = session(r.engine, 'Where is the red door?', oneRound);
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    const q1 = r.provider.requests[1]!;
    expect(q1.toolChoice).toBe('none');
    expect(q1.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(lastMsg(q1)).toEqual({ role: 'system', src: FINAL_CUE_SRC, blocks: [{ k: 'text', text: FINAL_CUE }] });
    // Round 0 had no cue.
    expect(r.provider.requests[0]!.messages.some((m) => m.src === FINAL_CUE_SRC)).toBe(false);
    if (out.type !== 'done') return;
    expect(traceOf(r.home, s.id, out.message.id)!.rounds).toMatchObject({ n: 2, ended: 'max_rounds' });
    expect(out.message.gen?.finish).toBe('end');
    await r.engine.close();
  });

  test('native: the cue is a user message where mid-dialogue system is not native', async () => {
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'a' } } }], [{ text: 'Done.' }]), { caps: capsWith('native', { midSystem: 'as-user' }) });
    const s = session(r.engine, 'Where is the red door?', oneRound);
    await reply(s);
    expect(lastMsg(r.provider.requests[1]!)).toMatchObject({ role: 'user', src: FINAL_CUE_SRC });
    await r.engine.close();
  });

  test('prompted: the cue closes the results message', async () => {
    const r = await rig(calls([{ text: '<tool_call>{"name": "lookup", "args": {"q": "a"}}</tool_call>' }], [{ text: 'Done.' }]), { caps: capsWith('prompted') });
    const s = session(r.engine, 'Where is the red door?', oneRound);
    await reply(s);
    const last = lastMsg(r.provider.requests[1]!);
    expect(last.src).toBe(RESULTS_SRC);
    expect(msgText(last)).toBe(`<tool_result name="lookup" id="call_0_0">\nfound a\n</tool_result>\n\n${FINAL_CUE}`);
    expect(r.provider.requests[1]!.messages.some((m) => m.src === FINAL_CUE_SRC)).toBe(false);
    await r.engine.close();
  });

  test('calls on the final round: not run, not stored, traced as refused, told once per session; finish max_rounds', async () => {
    const r = await rig(
      calls(
        [{ tool: { name: 'lookup', args: { q: 'a' } } }],
        [{ text: 'Here.' }, { tool: { name: 'lookup', args: { q: 'b' } } }],
        [{ tool: { name: 'lookup', args: { q: 'c' } } }],
        [{ text: 'Again.' }, { tool: { name: 'lookup', args: { q: 'd' } } }],
      ),
    );
    const s = session(r.engine, 'Where is the red door?', oneRound);
    const first = await reply(s);
    expect(first.out.type).toBe('done');
    if (first.out.type !== 'done') return;
    expect(r.log.runs.map((x) => x.args['q'])).toEqual(['a']);
    expect(first.out.message.gen?.finish).toBe('max_rounds');
    expect(first.out.message.blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
    expect(textOf(first.out.message)).toBe('Here.');
    expect(codes(first.evs)).toContain('tool_calls_on_final_round');
    const tools = traceOf(r.home, s.id, first.out.message.id)!.tools!;
    expect(tools.at(-1)).toEqual({ round: 1, callId: 'call_2_0', name: 'lookup', ok: false, refused: 'final_round' });

    s.send({ text: 'And now?', expectedVersion: s.version() });
    const second = await reply(s);
    expect(second.out.type).toBe('done');
    expect(codes(second.evs)).not.toContain('tool_calls_on_final_round');
    await r.engine.close();
  });
});

describe('the loop guard (B10) and the room (B3, C6)', () => {
  test('the same call with the same result three times: the next round is the final one', async () => {
    const r = await rig(
      calls(
        [{ tool: { name: 'lookup', args: { q: 'door' } } }],
        [{ tool: { name: 'lookup', args: { q: 'door' } } }],
        [{ tool: { name: 'lookup', args: { q: 'door' } } }],
        [{ text: 'The door is red.' }],
      ),
    );
    const s = session(r.engine, 'Where is the red door?', { narrator: { maxRounds: 8 } });
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    expect(r.provider.requests.map((q) => q.toolChoice)).toEqual(['auto', 'auto', 'auto', 'none']);
    if (out.type !== 'done') return;
    expect(traceOf(r.home, s.id, out.message.id)!.rounds).toMatchObject({ n: 4, ended: 'guard' });
    await r.engine.close();
  });

  test('a parallel batch [A, A, A, B] trips it at once (stop-core looked only at the newest key)', async () => {
    const A = { tool: { name: 'lookup', args: { q: 'door' } } };
    const r = await rig(calls([A, A, A, { tool: { name: 'lookup', args: { q: 'key' } } }], [{ text: 'Red.' }]));
    const s = session(r.engine, 'Where is the red door?', { narrator: { maxRounds: 8 } });
    const { out } = await reply(s);
    expect(r.provider.requests.map((q) => q.toolChoice)).toEqual(['auto', 'none']);
    expect(r.log.runs.length).toBe(2);
    if (out.type !== 'done') throw new Error(out.type);
    expect(traceOf(r.home, s.id, out.message.id)!.rounds!.ended).toBe('guard');
    await r.engine.close();
  });

  test('a result that fills the room ends the loop; it is cut to the room and says so', async () => {
    const log: ToolLog = { runs: [] };
    const long = lookupTool(log, 'lookup', () => 'x'.repeat(5000));
    const r = await rig(calls([{ tool: { name: 'lookup', args: { q: 'all' } } }], [{ text: 'Enough.' }]), { toolSets: sets([long]) });
    // window 2400 → reserve 1200 → tool room round(0.25 × 1200) = 300 tokens.
    const s = session(r.engine, 'Where is the red door?', { window: 2400 });
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    expect(r.provider.requests.map((q) => q.toolChoice)).toEqual(['auto', 'none']);
    if (out.type !== 'done') return;
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.rounds).toMatchObject({ n: 2, ended: 'room', room: 300 });
    expect(trace.rounds!.roomLeft).toBeLessThan(256);
    expect(trace.tools![0]).toMatchObject({ ok: true, cut: true });
    const result = out.message.blocks.find((b) => b.k === 'tool_result') as Extract<Block, { k: 'tool_result' }>;
    expect(result.text).toContain('[cut: the result was longer than');
    // The page a paging tool may fill never exceeds the room either.
    expect(log.runs[0]!.pageChars).toBeLessThanOrEqual(Math.floor((300 / 1.15) * 2.5));
    await r.engine.close();
  });
});

describe('messages and storage', () => {
  test('committed message of a tool turn is readable back as is (msg line)', async () => {
    const r = await rig(calls([{ text: 'A' }, { tool: { name: 'lookup', args: { q: 'x' } } }], [{ text: 'B' }]));
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(msgOf(r.home, s.id, out.message.id)!.blocks).toEqual(out.message.blocks);
    expect(s.view().path.at(-1)!.blocks).toEqual(out.message.blocks);
    await r.engine.close();
  });
});

describe('what tools read (B15, C6) and what they never write (I)', () => {
  test('a swipe\'s tools see the view at U, never the answer it replaces; inContext reads the request', async () => {
    const seen: { upTo: string; ids: string[]; userIn: boolean; names: { char: string; user: string } }[] = [];
    const spy = {
      name: 'peek',
      description: 'Peek.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read' as const,
      async run(_args: Record<string, unknown>, ctx: import('../../src/tools/types.ts').ToolCtx) {
        seen.push({ upTo: ctx.upTo, ids: ctx.view.path.map((m) => m.id), userIn: ctx.inContext(ctx.upTo), names: ctx.names });
        return { text: 'ok', summary: 'ok' };
      },
    };
    const r = await rig(calls([{ text: 'First answer.' }], [{ tool: { name: 'peek', args: {} } }], [{ text: 'Second answer.' }]), { toolSets: sets([spy]) });
    const s = session(r.engine);
    const first = await reply(s);
    if (first.out.type !== 'done') throw new Error(first.out.type);
    const replaced = first.out.message.id;
    const userId = first.out.message.parent!;
    const version = s.version();
    const swipe = s.runTurn({ kind: 'swipe', expectedVersion: version });
    for await (const _ of swipe.events) void _;
    const out = await swipe.result;
    expect(out.type).toBe('done');
    expect(seen).toEqual([{ upTo: userId, ids: expect.not.arrayContaining([replaced]), userIn: true, names: { char: 'Mira', user: 'Levi' } }]);
    expect(seen[0]!.ids.at(-1)).toBe(userId);
    // The tool round wrote nothing versioned and nothing of the Compendium: the commit is the only one.
    const since = entriesOf(r.home, s.id).filter((e) => e.seq > version);
    expect(since.filter((e) => ['msg', 'edit', 'hide', 'head', 'mem'].includes(e.t)).map((e) => e.t)).toEqual(['msg']);
    await r.engine.close();
  });
});

/** The openai-chat wire body of a request (no I/O). */
const chatBody = (q: ModelRequest) =>
  JSON.parse(buildChatRequest(q, { connectionId: q.model.connection, baseUrl: 'http://127.0.0.1:1', local: true }, null).body!) as {
    messages: { role: string; content?: unknown; reasoning_content?: string; tool_calls?: { id: string; extra_content?: unknown }[] }[];
  };

describe('a leak recovered into a call leaves the story (§8.3, B6)', () => {
  const JSON_CALL = '{"name": "lookup", "arguments": {"q": "door"}}';

  for (const transport of ['native', 'prompted'] as const) {
    test(`${transport}: JSON in prose runs; the stored text and the next request drop it, the events and chk keep it, the notice tells`, async () => {
      const r = await rig(calls([{ text: `Let me think.\n${JSON_CALL}` }], [{ text: 'The door is red.' }], [{ text: 'Next.' }]), { caps: capsWith(transport) });
      const s = session(r.engine);
      const { evs, out, turn } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(r.log.runs.map((x) => x.args)).toEqual([{ q: 'door' }]);
      expect(out.message.blocks).toEqual([
        { k: 'text', text: 'Let me think.' },
        { k: 'tool_call', id: 'call_0_0', name: 'lookup', args: '{"q":"door"}' },
        { k: 'tool_result', callId: 'call_0_0', name: 'lookup', text: 'found door' },
        { k: 'text', text: '\nThe door is red.' },
      ]);
      expect(msgOf(r.home, s.id, out.message.id)!.blocks).toEqual(out.message.blocks);
      // What streamed stays streamed (as step 9's markup): the events and chk agree with each other.
      expect(streamed(evs)).toBe(`Let me think.\n${JSON_CALL}\nThe door is red.`);
      expect(chkText(r.home, s.id, turn.turnId)).toBe(streamed(evs));
      expect(codes(evs)).toContain('tool_markup_stripped');

      s.send({ text: 'And then?', expectedVersion: s.version() });
      const next = await reply(s);
      expect(next.out.type).toBe('done');
      const history = r.provider.requests[2]!.messages.filter((m) => m.role === 'assistant' && m.src === 'history').map(msgText);
      expect(history.at(-1)).toBe('Let me think.\nThe door is red.');
      expect(history.join('\n')).not.toContain('"arguments"');
      await r.engine.close();
    });

    test(`${transport}: a salvaged span that took the whitespace with it never glues two rounds in storage or history`, async () => {
      const textsOf = (blocks: readonly Block[]) => blocks.filter((b) => b.k === 'text').map((b) => (b as { text: string }).text);
      const nextHistory = async (first: string, then: string) => {
        const r = await rig(calls([{ text: first }], [{ text: then }], [{ text: 'Next.' }]), { caps: capsWith(transport) });
        const s = session(r.engine);
        const { out } = await reply(s);
        if (out.type !== 'done') throw new Error(out.type);
        s.send({ text: 'And then?', expectedVersion: s.version() });
        await reply(s);
        const history = r.provider.requests[2]!.messages.filter((m) => m.role === 'assistant' && m.src === 'history').map(msgText);
        await r.engine.close();
        return { stored: textsOf(out.message.blocks), history: history.at(-1) };
      };
      // The JSON and the newline after it leave the stored text: the next round's separator is decided there.
      expect(await nextHistory(`Let me think.\n${JSON_CALL}\n`, 'The door is red.')).toEqual({
        stored: ['Let me think.', '\nThe door is red.'],
        history: 'Let me think.\nThe door is red.',
      });
      expect(await nextHistory(`Let me think.\n\n${JSON_CALL}\n\n`, 'The door is red.')).toEqual({
        stored: ['Let me think.', '\nThe door is red.'],
        history: 'Let me think.\nThe door is red.',
      });
      // A round that was only the call stores nothing, and nothing stored before means no separator.
      expect(await nextHistory(JSON_CALL, 'The door is red.')).toEqual({ stored: ['The door is red.'], history: 'The door is red.' });
    });

    test(`${transport}: on the final round (B9) a salvaged call is not run, and its JSON is not stored either`, async () => {
      const first = transport === 'native' ? { tool: { name: 'lookup', args: { q: 'a' } } } : { text: '<tool_call>{"name": "lookup", "args": {"q": "a"}}</tool_call>' };
      const r = await rig(calls([first], [{ text: 'Here. {"name": "lookup", "arguments": {"q": "b"}}' }]), { caps: capsWith(transport) });
      const s = session(r.engine, 'Where is the red door?', { narrator: { maxRounds: 1 } });
      const { evs, out } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(r.log.runs.map((x) => x.args['q'])).toEqual(['a']);
      expect(out.message.blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
      expect(textOf(out.message)).toBe('Here.');
      expect(out.message.gen?.finish).toBe('max_rounds');
      expect(codes(evs)).toEqual(expect.arrayContaining(['tool_calls_on_final_round', 'tool_markup_stripped']));
      expect(traceOf(r.home, s.id, out.message.id)!.tools!.at(-1)).toMatchObject({ round: 1, ok: false, refused: 'final_round' });
      await r.engine.close();
    });
  }
});

describe('the stored text keeps D-55\'s separator where a removal took the whitespace (B6)', () => {
  const textsOf = (blocks: readonly Block[]) => blocks.filter((b) => b.k === 'text').map((b) => (b as { text: string }).text);

  test('a fully salvaged middle round: the rounds around it stay apart', async () => {
    const r = await rig(
      calls(
        [{ text: 'A.' }, { tool: { name: 'lookup', args: { q: 'one' } } }],
        [{ text: '\n{"name": "lookup", "arguments": {"q": "two"}}\n' }],
        [{ text: 'B.' }],
      ),
    );
    const s = session(r.engine);
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(r.log.runs.map((x) => x.args['q'])).toEqual(['one', 'two']);
    expect(streamed(evs)).toBe('A.\n\n{"name": "lookup", "arguments": {"q": "two"}}\nB.');
    expect(textsOf(out.message.blocks)).toEqual(['A.', '\nB.']);
    expect(textOf(out.message)).toBe('A.\nB.');
    await r.engine.close();
  });

  test("step 9: markup stripped at a block's end (a tool not offered) leaves the next round its separator", async () => {
    const first = 'Let me think.\n<function=elsewhere>{"q": "door"}</function>\n';
    const r = await rig(calls([{ text: first }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'The door is red.' }]));
    const s = session(r.engine);
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(streamed(evs)).toBe(`${first}The door is red.`);
    expect(textsOf(out.message.blocks)).toEqual(['Let me think.', '\nThe door is red.']);
    expect(codes(evs)).toContain('tool_markup_stripped');
    await r.engine.close();
  });

  test('step 9: a block stripped whole takes the separator of the next one with it when nothing is kept before', async () => {
    const r = await rig(calls([{ text: '<function=elsewhere>{"q": "door"}</function>' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'The door is red.' }]));
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(textsOf(out.message.blocks)).toEqual(['The door is red.']);
    expect(out.message.blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
    await r.engine.close();
  });
});

describe("the in-loop reasoning echo follows the adapter's thinking rule (§8.6)", () => {
  const caps = (canDisable: boolean): ModelCaps =>
    capsWith('native', { reasoning: { output: 'reasoning_content', control: canDisable ? 'toggle' : 'none', canDisable, echo: 'all-with-tools' } });
  const script = () => calls([{ reasoning: 'I should look it up.' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ reasoning: 'Now answer.' }, { text: 'Red.' }]);
  const none = { roles: { narrator: { conn: 'script', model: 'default', reasoning: 'none' } } };

  test("binding 'none' on a model that cannot stop thinking: round 0's reasoning rides round 1, the wire sends it", async () => {
    const r = await rig(script(), { caps: caps(false) });
    const s = session(r.engine, 'Where is the red door?', none);
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    const q1 = r.provider.requests[1]!;
    expect(q1.messages.find((m) => m.src === ROUND_SRC)!.blocks.map((b) => b.k)).toEqual(['reasoning', 'tool_call']);
    const turn = chatBody(q1).messages.find((m) => Array.isArray(m.tool_calls))!;
    expect(turn.reasoning_content).toBe('I should look it up.');
    await r.engine.close();
  });

  test("binding 'none' on a model that can turn thinking off: nothing of it rides the wire", async () => {
    const r = await rig(script(), { caps: caps(true) });
    const s = session(r.engine, 'Where is the red door?', none);
    await reply(s);
    const q1 = r.provider.requests[1]!;
    expect(q1.messages.find((m) => m.src === ROUND_SRC)!.blocks.map((b) => b.k)).toEqual(['tool_call']);
    for (const m of chatBody(q1).messages) expect(m).not.toHaveProperty('reasoning_content');
    await r.engine.close();
  });
});

describe('the tool room bounds what the loop adds (C6, D-93)', () => {
  /** Budget tokens of a request as assemble measures them (CHARS counter, the model's starting factor). */
  const budget = (q: ModelRequest) => Math.ceil(estimateMessages(q.messages, CHARS_COUNTER) * EMA_START);
  const declared = (q: ModelRequest) => Math.ceil(estimateToolSpecs(q.tools ?? [], CHARS_COUNTER) * EMA_START);

  test("the round's own text, its echoes and the final cue are charged before the results are capped", async () => {
    const log: ToolLog = { runs: [] };
    const long = lookupTool(log, 'lookup', () => 'x'.repeat(5000));
    const prose = 'The road bends north. '.repeat(7);
    const r = await rig(calls([{ text: prose }, { tool: { name: 'lookup', args: { q: 'all' } } }], [{ text: 'Enough.' }]), { toolSets: sets([long]) });
    // window 2400 → reserve 1200 → tool room 300.
    const s = session(r.engine, 'Where is the red door?', { window: 2400 });
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.rounds).toMatchObject({ n: 2, ended: 'room', room: 300 });
    const [q0, q1] = r.provider.requests;
    // Round 1 (the final one, with its cue) adds no more than the room to round 0's prompt...
    expect(q1!.messages.at(-1)!.src).toBe(FINAL_CUE_SRC);
    expect(budget(q1!) - budget(q0!)).toBeLessThanOrEqual(300);
    // ...so it may still ask for the whole reserve.
    expect(q1!.maxTokens).toBe(q0!.maxTokens);
    expect(log.runs[0]!.pageChars).toBeLessThan(Math.floor((300 / EMA_START) * 2.5));
    await r.engine.close();
  });

  test('text before a call that alone exceeds the room comes out of the next round\'s max_tokens: prompt + max_tokens fits the window', async () => {
    const log: ToolLog = { runs: [] };
    const long = lookupTool(log, 'lookup', () => 'x'.repeat(5000));
    const prose = 'The lantern swings in the wind and the road bends north. '.repeat(26);
    const r = await rig(calls([{ text: prose }, { tool: { name: 'lookup', args: { q: 'all' } } }], [{ text: 'Enough.' }]), { toolSets: sets([long]) });
    const s = session(r.engine, 'Where is the red door?', { window: 2400 });
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    const [q0, q1] = r.provider.requests;
    expect(budget(q0!) + declared(q0!) + q0!.maxTokens).toBeLessThanOrEqual(2400);
    expect(budget(q1!) + declared(q1!) + q1!.maxTokens).toBeLessThanOrEqual(2400);
    expect(q1!.maxTokens).toBeLessThan(q0!.maxTokens);
    await r.engine.close();
  });

  test('a round whose own text used up the room: its result says so (never empty), and the next round is the final one', async () => {
    const log: ToolLog = { runs: [] };
    const long = lookupTool(log, 'lookup', () => 'x'.repeat(5000));
    const prose = 'The lantern swings in the wind and the road bends north. '.repeat(26);
    const r = await rig(calls([{ text: prose }, { tool: { name: 'lookup', args: { q: 'all' } } }], [{ text: 'Enough.' }]), { toolSets: sets([long]) });
    const s = session(r.engine, 'Where is the red door?', { window: 2400 });
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(out.message.blocks.filter((b) => b.k === 'tool_result')).toEqual([{ k: 'tool_result', callId: 'call_1_0', name: 'lookup', text: NO_ROOM_MARK }]);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    expect(trace.tools).toEqual([{ round: 0, callId: 'call_1_0', name: 'lookup', ok: true, ms: expect.any(Number), chars: NO_ROOM_MARK.length, cut: true }]);
    expect(trace.rounds).toMatchObject({ n: 2, ended: 'room' });
    const q1 = r.provider.requests[1]!;
    expect(q1.messages.at(-2)!.blocks).toEqual([{ k: 'tool_result', callId: 'call_1_0', name: 'lookup', text: NO_ROOM_MARK }]);
    expect(q1.messages.at(-1)!.src).toBe(FINAL_CUE_SRC);
    expect(budget(q1) + declared(q1) + q1.maxTokens).toBeLessThanOrEqual(2400);
    await r.engine.close();
  });

  test('when the next round is the final one, its cue is taken from the room too: roomLeft = room − (round + results) − cue', async () => {
    for (const [transport, rounds] of [['native', 1], ['prompted', 1], ['native', 8]] as const) {
      const call = transport === 'native' ? { tool: { name: 'lookup', args: { q: 'door' } } } : { text: '<tool_call>{"name": "lookup", "args": {"q": "door"}}</tool_call>' };
      const r = await rig(calls([call], [{ text: 'Red.' }]), { caps: capsWith(transport) });
      const s = session(r.engine, 'Where is the red door?', { window: 2400, narrator: { maxRounds: rounds } });
      const { out } = await reply(s);
      if (out.type !== 'done') throw new Error(`${transport} ${rounds}: ${JSON.stringify(out)}`);
      const trace = traceOf(r.home, s.id, out.message.id)!;
      const [q0, q1] = r.provider.requests;
      // What the loop appended to round 0's wire, as spent() measures it, message by message.
      const tail = q1!.messages.slice(q0!.messages.length);
      const cost = (ms: typeof tail) => Math.ceil(estimateMessages(ms, CHARS_COUNTER) * EMA_START);
      if (rounds === 1) {
        expect(trace.rounds).toMatchObject({ n: 2, ended: 'max_rounds', room: 300 });
        if (transport === 'native') {
          expect(tail.map((m) => m.src)).toEqual([ROUND_SRC, RESULTS_SRC, FINAL_CUE_SRC]);
          expect(trace.rounds!.roomLeft).toBe(300 - cost(tail.slice(0, 2)) - cost(tail.slice(2)));
        } else {
          // Prompted: the cue rides the results message, and that message is charged with it.
          expect(tail.map((m) => m.src)).toEqual([ROUND_SRC, RESULTS_SRC]);
          expect(textOf(tail[1]!)).toEndWith(FINAL_CUE);
          expect(trace.rounds!.roomLeft).toBe(300 - cost(tail));
        }
      } else {
        // The next round may still call tools: no cue is sent, and none is charged.
        expect(trace.rounds).toMatchObject({ n: 2, ended: 'answer', room: 300 });
        expect(tail.map((m) => m.src)).toEqual([ROUND_SRC, RESULTS_SRC]);
        expect(trace.rounds!.roomLeft).toBe(300 - cost(tail));
      }
      await r.engine.close();
    }
  });

  test('results the counter measures denser than 2.5 chars/token (CJK) are fitted to the room in tokens: the reply keeps its max_tokens', async () => {
    const ZH = '他走进了旅馆，看见老板娘站在柜台后面。';
    const limits: number[] = [];
    // A tool that pages to its limit and ends with its cursor line, like read_history.
    const pager: Tool = {
      name: 'pager',
      description: 'Read pages.',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
      effect: 'read',
      async run(_args, ctx) {
        limits.push(ctx.limit!);
        const tail = '\nnext_from: 7';
        return { text: ZH.repeat(4000).slice(0, ctx.limit! - tail.length) + tail, summary: 'page' };
      },
    };
    const log: ToolLog = { runs: [] };
    const blind = lookupTool(log, 'lookup', () => ZH.repeat(2000));
    const r = await rig(
      calls([{ tool: { name: 'pager', args: { q: 'a' } } }, { tool: { name: 'lookup', args: { q: 'b' } } }], [{ text: 'Answer.' }]),
      { toolSets: sets([pager, blind]), extra: { counter: O200K_COUNTER } },
    );
    const s = r.engine.createSession({ character: MIRA_TOOLS, persona: LEVI, config: { window: 8192 } });
    s.send({ text: 'Where?', expectedVersion: s.version() });
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    const [q0, q1] = r.provider.requests;
    // Measured by the counter, what the loop added stays within the room, so the reply is not squeezed.
    expect(q1!.maxTokens).toBe(q0!.maxTokens);
    const trace = traceOf(r.home, s.id, out.message.id)!;
    const added = estimateMessages(q1!.messages.slice(q0!.messages.length), O200K_COUNTER) * EMA_START;
    expect(added).toBeLessThanOrEqual(trace.rounds!.room);
    // The batch ran twice: the pager learnt a smaller limit and kept its cursor line, uncut.
    expect(limits).toHaveLength(2);
    expect(limits[1]!).toBeLessThan(limits[0]!);
    const results = out.message.blocks.filter((b) => b.k === 'tool_result') as Extract<Block, { k: 'tool_result' }>[];
    expect(results[0]!.text).toEndWith('\nnext_from: 7');
    expect(trace.tools!.map((t) => t.cut)).toEqual([undefined, true]);
    await r.engine.close();
  });

  test('roundMaxTokens: the whole reply while the loop stays within the room, less by what went beyond it, never below 1', () => {
    expect(roundMaxTokens(1200, 0, 300)).toBe(1200);
    expect(roundMaxTokens(1200, 300, 300)).toBe(1200);
    expect(roundMaxTokens(1200, 682, 300)).toBe(818);
    expect(roundMaxTokens(1200, 5000, 300)).toBe(1);
  });
});

describe('replay payloads follow the loop\'s ids (B8, §8.6)', () => {
  const U = { usage: { inputTotal: 300, outputTotal: 10 } };
  const sig = (s: string) => ({ extra_content: { google: { thought_signature: s } } });

  test('two rounds reusing the server id fc_1: each signature rides its own call on the wire', async () => {
    const r = await rig(
      calls(
        [{ tool: { name: 'lookup', args: { q: 'a' }, id: 'fc_1' } }, { replay: { kind: 'tool_extra', payload: { fc_1: sig('one') } } }, U],
        [{ tool: { name: 'lookup', args: { q: 'b' }, id: 'fc_1' } }, { replay: { kind: 'tool_extra', payload: { fc_1: sig('two') } } }, U],
        [{ text: 'Done.' }, U],
      ),
    );
    const s = session(r.engine);
    const { out } = await reply(s);
    expect(out.type).toBe('done');
    const wire = chatBody(r.provider.requests[2]!).messages.filter((m) => m.tool_calls).map((m) => m.tool_calls!.map((c) => [c.id, c.extra_content]));
    expect(wire).toEqual([[['fc_1', sig('one').extra_content]], [['call_1_0', sig('two').extra_content]]]);
    await r.engine.close();
  });

  test('an unsafe server id: the signature follows the loop id', async () => {
    const r = await rig(
      calls([{ tool: { name: 'lookup', args: { q: 'a' }, id: 'fc/1+=' } }, { replay: { kind: 'tool_extra', payload: { 'fc/1+=': sig('one') } } }, U], [{ text: 'Done.' }, U]),
    );
    const s = session(r.engine);
    await reply(s);
    const wire = chatBody(r.provider.requests[1]!).messages.filter((m) => m.tool_calls).map((m) => m.tool_calls!.map((c) => [c.id, c.extra_content]));
    expect(wire).toEqual([[['call_0_0', sig('one').extra_content]]]);
    await r.engine.close();
  });

  test('rekeyReplay: tool_extra keys and reasoning_details ids of renamed calls follow the rename; the rest stays', () => {
    const base = { connection: 'c', model: 'm' };
    const replay: Replay[] = [
      { kind: 'tool_extra', ...base, payload: { fc_1: { x: 1 }, keep: { y: 2 }, ok_id: { z: 3 } } },
      { kind: 'reasoning_details', ...base, payload: [{ type: 'reasoning.encrypted', data: 'd', id: 'fc_1' }, { type: 'reasoning.text', text: 't', id: 'rs_9' }, 'odd'] },
    ];
    const found = [{ server: 'fc_1' }, { server: 'ok_id' }, {}];
    const got = rekeyReplay(replay, found, [{ id: 'call_1_0' }, { id: 'ok_id' }, { id: 'call_1_2' }]);
    expect(got).toEqual([
      { kind: 'tool_extra', ...base, payload: { call_1_0: { x: 1 }, ok_id: { z: 3 }, keep: { y: 2 } } },
      { kind: 'reasoning_details', ...base, payload: [{ type: 'reasoning.encrypted', data: 'd', id: 'call_1_0' }, { type: 'reasoning.text', text: 't', id: 'rs_9' }, 'odd'] },
    ]);
    // No rename: the payloads as they came.
    expect(rekeyReplay(replay, [{ server: 'fc_1' }], [{ id: 'fc_1' }])).toEqual(replay);
  });

  test('rekeyReplay: one response giving two calls the same id: the call that kept it keeps its payloads', () => {
    const base = { connection: 'c', model: 'm' };
    const replay: Replay[] = [
      { kind: 'tool_extra', ...base, payload: { fc_1: { sig: 'A' } } },
      { kind: 'reasoning_details', ...base, payload: [{ type: 'reasoning.encrypted', data: 'A', id: 'fc_1' }] },
    ];
    expect(rekeyReplay(replay, [{ server: 'fc_1' }, { server: 'fc_1' }], [{ id: 'fc_1' }, { id: 'call_0_1' }])).toEqual(replay);
    // Both renamed (fc_1 was taken in an earlier round): the first of them takes it, as before.
    expect(rekeyReplay(replay, [{ server: 'fc_1' }, { server: 'fc_1' }], [{ id: 'call_1_0' }, { id: 'call_1_1' }])).toEqual([
      { kind: 'tool_extra', ...base, payload: { call_1_0: { sig: 'A' } } },
      { kind: 'reasoning_details', ...base, payload: [{ type: 'reasoning.encrypted', data: 'A', id: 'call_1_0' }] },
    ]);
  });
});
