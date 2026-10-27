// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-97 in the loop (.notes/m3-decisions.md L): an offered tool's name used as a tag is a call of that
// tool wherever a <tool_call> block is one. Prompted rounds (the second live run's exact output),
// a native round's prompted-family fallback, the final round (stripped, not run, told), names that
// are not offered, and a turn without tools (M2, untouched).
import { describe, expect, test } from 'bun:test';
import { RESULTS_SRC, ROUND_SRC } from '../../src/engine/narrate.ts';
import type { Block } from '../../src/session/entries.ts';
import type { Tool, ToolCtx, ToolOutput } from '../../src/tools/types.ts';
import { calls, capsWith, chkText, codes, lookupTool, msgOf, notices, reply, rig, session, sets, streamed, textOf, traceOf, type ToolLog } from './kit.ts';

/** The live model's output (magmell-16k, prompted): the name as a tag, a made-up result inside, then prose. */
const LIVE_QUERY = 'ранее в диалоге не упоминалось имени брата Марфы.';
const LIVE_PROSE = "Марфа не mentioning her brother's name…";
const LIVE = `<search_history>\n${LIVE_QUERY}\n</search_history>\n\n${LIVE_PROSE}`;

/** search_history {query} as a fake tool: `hits for <query>`. */
function searchTool(log: ToolLog): Tool {
  return {
    name: 'search_history',
    description: 'Search the chat.',
    schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false },
    effect: 'read',
    async run(args, ctx: ToolCtx): Promise<ToolOutput> {
      log.runs.push({ name: 'search_history', args, pageChars: ctx.pageChars, signal: ctx.signal });
      return { text: `hits for ${String(args['query'])}`, summary: '1 hit' };
    },
  };
}

const texts = (blocks: readonly Block[]): string[] => blocks.filter((b) => b.k === 'text').map((b) => (b as { text: string }).text);

describe('prompted rounds', () => {
  test("the live output: one search_history call with that query; the prose after it stays prose, live and stored", async () => {
    // The tag split across chunks as a server streams it: a partial opener and a partial closer at the boundaries.
    const chunks = ['<search_hi', `story>\n${LIVE_QUERY.slice(0, 9)}`, `${LIVE_QUERY.slice(9)}\n</search_hist`, `ory>\n\n${LIVE_PROSE}`];
    expect(chunks.join('')).toBe(LIVE);
    const log: ToolLog = { runs: [] };
    const r = await rig(calls(chunks.map((text) => ({ text })), [{ text: 'Брата звали Тимофей.' }]), { caps: capsWith('prompted'), toolSets: sets([searchTool(log)]) });
    const s = session(r.engine);
    const { evs, out, turn } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(log.runs.map((x) => x.args)).toEqual([{ query: LIVE_QUERY }]);
    expect(out.message.blocks).toEqual([
      { k: 'text', text: LIVE_PROSE },
      { k: 'tool_call', id: 'call_0_0', name: 'search_history', args: JSON.stringify({ query: LIVE_QUERY }) },
      { k: 'tool_result', callId: 'call_0_0', name: 'search_history', text: `hits for ${LIVE_QUERY}` },
      { k: 'text', text: '\nБрата звали Тимофей.' },
    ]);
    // What streamed never held the tag; the events, chk and the stored text agree.
    expect(streamed(evs)).toBe(`${LIVE_PROSE}\nБрата звали Тимофей.`);
    expect(chkText(r.home, s.id, turn.turnId)).toBe(streamed(evs));
    expect(textOf(out.message)).toBe(streamed(evs));
    expect(codes(evs)).not.toContain('tool_markup_stripped');
    // The wire: the round as the model wrote it (the tag kept, §8.3), then the results as one user message.
    expect(r.provider.requests[1]!.messages.slice(-2)).toEqual([
      { role: 'assistant', src: ROUND_SRC, blocks: [{ k: 'text', text: LIVE }] },
      { role: 'user', src: RESULTS_SRC, blocks: [{ k: 'text', text: `<tool_result name="search_history" id="call_0_0">\nhits for ${LIVE_QUERY}\n</tool_result>` }] },
    ]);
    expect(traceOf(r.home, s.id, out.message.id)!.tools).toEqual([expect.objectContaining({ name: 'search_history', ok: true })]);
    await r.engine.close();
  });

  test('a malformed name tag is a call whose error is its result, paired in storage', async () => {
    const log: ToolLog = { runs: [] };
    const read: Tool = { ...lookupTool(log, 'read_history'), schema: { type: 'object', properties: { from: { type: 'integer' } }, required: ['from'], additionalProperties: false } };
    const r = await rig(calls([{ text: 'Сейчас. <read_history>12</read_history>' }], [{ text: 'Ладно.' }]), { caps: capsWith('prompted'), toolSets: sets([read]) });
    const s = session(r.engine);
    const { out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(log.runs).toEqual([]);
    const result = out.message.blocks.find((b) => b.k === 'tool_result') as Extract<Block, { k: 'tool_result' }>;
    expect(result).toMatchObject({ name: 'read_history', error: true });
    expect(result.text).toBe('The <read_history> block does not hold its arguments as a JSON object. Write the call as <tool_call>{"name": "read_history", "args": {…}}</tool_call>.');
    expect(traceOf(r.home, s.id, out.message.id)!.tools).toEqual([expect.objectContaining({ name: 'read_history', ok: false, refused: 'bad_args' })]);
    expect(texts(out.message.blocks)).toEqual(['Сейчас.', '\nЛадно.']);
    await r.engine.close();
  });
});

describe("a native round's prompted-family fallback", () => {
  for (const [label, text, prose] of [
    ['closed (leak recovery)', 'Let me look. <lookup>door</lookup>\nThe tavern is quiet.', 'Let me look.\nThe tavern is quiet.'],
    ['left unclosed, prose on the next line', 'Let me look. <LOOKUP>door\nThe tavern is quiet.', 'Let me look.\nThe tavern is quiet.'],
    ['left unclosed at the end', 'Let me look. <ns:lookup mode="x">door', 'Let me look.'],
  ] as const) {
    test(`a name tag written as text instead of a native call runs: ${label}`, async () => {
      const r = await rig(calls([{ text }], [{ text: 'It is red.' }]));
      const s = session(r.engine);
      const { evs, out, turn } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(r.log.runs.map((x) => x.args)).toEqual([{ q: 'door' }]);
      expect(out.message.blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
      expect(textOf(out.message)).toBe(`${prose}\nIt is red.`);
      expect(streamed(evs)).toBe(textOf(out.message));
      expect(chkText(r.home, s.id, turn.turnId)).toBe(streamed(evs));
      // The native wire: the visible text without the tag, the call echoed with a loop id.
      expect(r.provider.requests[1]!.messages.at(-2)!.blocks).toEqual([
        { k: 'text', text: prose },
        { k: 'tool_call', id: 'call_0_0', name: 'lookup', args: '{"q":"door"}' },
      ]);
      expect(codes(evs)).not.toContain('tool_markup_stripped');
      await r.engine.close();
    });
  }

  test('next to other leaked markup, a closed name tag still runs (both, in text order)', async () => {
    const r = await rig(calls([{ text: 'A. <lookup>door</lookup> B. {"name": "lookup", "arguments": {"q": "key"}}' }], [{ text: 'C.' }]));
    const s = session(r.engine);
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(r.log.runs.map((x) => x.args['q'])).toEqual(['door', 'key']);
    expect(texts(out.message.blocks)).toEqual(['A. B.', '\nC.']);
    // One block of markup left the stored text (the JSON); the name tag never reached it.
    const told = notices(evs).find((n) => n.code === 'tool_markup_stripped');
    expect(told?.message).toContain('(1 block)');
    await r.engine.close();
  });

  test('a native call with a name tag beside it: the tag is hidden markup, told by tool_markup_stripped', async () => {
    const r = await rig(calls([{ text: 'Let me look. <lookup>door</lookup>' }, { tool: { name: 'lookup', args: { q: 'door' } } }], [{ text: 'Red.' }]));
    const s = session(r.engine);
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(r.log.runs.map((x) => x.args)).toEqual([{ q: 'door' }]);
    expect(textOf(out.message)).toBe('Let me look.\nRed.');
    expect(codes(evs)).toContain('tool_markup_stripped');
    await r.engine.close();
  });
});

describe('the final round (B9): stripped, not run, counted as hidden', () => {
  const oneRound = { narrator: { maxRounds: 1 } };
  for (const transport of ['prompted', 'native'] as const) {
    for (const [label, last] of [
      ['a name tag', 'Here. <lookup>b</lookup>'],
      ['a <tool_call> block', 'Here. <tool_call>{"name": "lookup", "args": {"q": "b"}}</tool_call>'],
    ] as const) {
      test(`${transport}: ${label} on the final round`, async () => {
        const first = transport === 'native' ? { tool: { name: 'lookup', args: { q: 'a' } } } : { text: '<tool_call>{"name": "lookup", "args": {"q": "a"}}</tool_call>' };
        const r = await rig(calls([first], [{ text: last }]), { caps: capsWith(transport) });
        const s = session(r.engine, 'Where is the red door?', oneRound);
        const { evs, out, turn } = await reply(s);
        if (out.type !== 'done') throw new Error(out.type);
        expect(r.log.runs.map((x) => x.args['q'])).toEqual(['a']);
        expect(out.message.blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
        expect(textOf(out.message)).toBe('Here.');
        expect(streamed(evs)).toBe('Here.');
        expect(chkText(r.home, s.id, turn.turnId)).toBe('Here.');
        expect(out.message.gen?.finish).toBe('max_rounds');
        expect(codes(evs)).toEqual(expect.arrayContaining(['tool_calls_on_final_round', 'tool_markup_stripped']));
        expect(notices(evs).find((n) => n.code === 'tool_markup_stripped')!.message).toContain('(1 block)');
        expect(traceOf(r.home, s.id, out.message.id)!.tools!.at(-1)).toMatchObject({ round: 1, name: 'lookup', ok: false, refused: 'final_round' });
        await r.engine.close();
      });
    }
  }
});

describe('names that are not offered are never tags', () => {
  for (const transport of ['prompted', 'native'] as const) {
    test(`${transport}: <search_history> with only the lore tool offered, <i>, <search>: untouched, not run`, async () => {
      const text = 'She <i>smiles</i>. <search_history>брат</search_history> <search>x</search>';
      const r = await rig(calls([{ text }]), { caps: capsWith(transport) });
      const s = session(r.engine);
      const { evs, out } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(r.provider.requests).toHaveLength(1);
      expect(r.log.runs).toEqual([]);
      expect(streamed(evs)).toBe(text);
      expect(textOf(out.message)).toBe(text);
      expect(codes(evs)).not.toContain('tool_markup_stripped');
      await r.engine.close();
    });
  }

  test('no tools offered (caps.tools none): the tag of a tool name is prose, the turn is M2', async () => {
    const text = 'Let me look. <lookup>door</lookup> <search_history>брат</search_history>';
    const r = await rig(calls([{ text }]), { caps: capsWith('none') });
    const s = session(r.engine);
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    const [q] = r.provider.requests;
    expect(q!.tools).toBeUndefined();
    expect(q!.stop).toBeUndefined();
    expect(q!.messages.some((m) => m.src === 'core:tools')).toBe(false);
    expect(r.log.runs).toEqual([]);
    expect(out.message.blocks).toEqual([{ k: 'text', text }]);
    expect(msgOf(r.home, s.id, out.message.id)!.blocks).toEqual([{ k: 'text', text }]);
    expect(streamed(evs)).toBe(text);
    expect(traceOf(r.home, s.id, out.message.id)!.rounds).toBeUndefined();
    await r.engine.close();
  });
});

describe('fixes after the D-97 check (.check-live: d97-native-seam-divergence, d97-wrapper-nesting-spurious-error, d97-unclosed-fenced-text-body)', () => {
  // A native round whose calls came as text: a run of closed blocks on their own lines. The stripper
  // removed the run as one group (one seam); leak recovery removed it block by block (another seam,
  // a blank line the user never saw), and the stored and wire text took that without telling.
  for (const [label, text] of [
    ['two closed name tags', 'Марфа задумалась.\n<lookup>брат</lookup>\n<find>брат</find>\nОна подняла глаза.'],
    ['two closed <tool_call> blocks', 'Марфа задумалась.\n<tool_call>{"name": "lookup", "args": {"q": "брат"}}</tool_call>\n<tool_call>{"name": "find", "args": {"q": "брат"}}</tool_call>\nОна подняла глаза.'],
    ['a name tag and a <tool_call> block, blank lines around them', 'Марфа задумалась.\n\n<lookup>брат</lookup>\n\n<tool_call>{"name": "find", "args": {"q": "брат"}}</tool_call>\n\nОна подняла глаза.'],
  ] as const) {
    test(`native round, ${label} on their own lines: stored text === streamed === chk, on the wire too`, async () => {
      const log: ToolLog = { runs: [] };
      const r = await rig(calls([{ text }], [{ text: 'Тихон.' }]), { caps: capsWith('native'), toolSets: sets([lookupTool(log), lookupTool(log, 'find')]) });
      const s = session(r.engine);
      const { evs, out, turn } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(log.runs.map((x) => [x.name, x.args])).toEqual([
        ['lookup', { q: 'брат' }],
        ['find', { q: 'брат' }],
      ]);
      const seen = streamed(evs);
      const round0 = seen.slice(0, seen.indexOf('\nТихон.'));
      expect(round0).toBe(text.startsWith('Марфа задумалась.\n\n') ? 'Марфа задумалась.\n\nОна подняла глаза.' : 'Марфа задумалась.\nОна подняла глаза.');
      expect(chkText(r.home, s.id, turn.turnId)).toBe(seen);
      expect(textOf(out.message)).toBe(seen);
      expect(texts(out.message.blocks)).toEqual([round0, '\nТихон.']);
      expect(r.provider.requests[1]!.messages.at(-2)!.blocks[0]).toEqual({ k: 'text', text: round0 });
      // Nothing that streamed left the stored text: nothing to tell.
      expect(codes(evs)).not.toContain('tool_markup_stripped');
      await r.engine.close();
    });
  }

  test('native round: a closed name tag next to salvaged JSON: the JSON left the stored text and is told; the tag keeps the stream seam', async () => {
    const log: ToolLog = { runs: [] };
    const text = 'A.\n<lookup>брат</lookup>\n<find>брат</find>\nB. {"name": "lookup", "arguments": {"q": "ключ"}}';
    const r = await rig(calls([{ text }], [{ text: 'C.' }]), { caps: capsWith('native'), toolSets: sets([lookupTool(log), lookupTool(log, 'find')]) });
    const s = session(r.engine);
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(log.runs.map((x) => x.args['q'])).toEqual(['брат', 'брат', 'ключ']);
    expect(texts(out.message.blocks)).toEqual(['A.\nB.', '\nC.']);
    expect(notices(evs).find((n) => n.code === 'tool_markup_stripped')?.message).toContain('(1 block)');
    await r.engine.close();
  });

  for (const [label, text] of [
    ['a <tool_call> wrapper around a name tag', 'Сейчас.\n<tool_call>\n<lookup>брат</lookup>\n</tool_call>'],
    ['a name tag around a <tool_call>', 'Сейчас.\n<lookup>\n<tool_call>{"name": "lookup", "args": {"q": "брат"}}</tool_call>\n</lookup>'],
    ['a <tool_call> opener written twice', 'Сейчас.\n<tool_call>\n<tool_call>{"name": "lookup", "args": {"q": "брат"}}</tool_call>'],
  ] as const) {
    test(`prompted: ${label} is one call, no extra error result`, async () => {
      const log: ToolLog = { runs: [] };
      const r = await rig(calls([{ text }], [{ text: 'Тихон.' }]), { caps: capsWith('prompted'), toolSets: sets([lookupTool(log)]) });
      const s = session(r.engine);
      const { evs, out } = await reply(s);
      if (out.type !== 'done') throw new Error(out.type);
      expect(log.runs.map((x) => x.args)).toEqual([{ q: 'брат' }]);
      expect(out.message.blocks).toEqual([
        { k: 'text', text: 'Сейчас.' },
        { k: 'tool_call', id: 'call_0_0', name: 'lookup', args: '{"q":"брат"}' },
        { k: 'tool_result', callId: 'call_0_0', name: 'lookup', text: 'found брат' },
        { k: 'text', text: '\nТихон.' },
      ]);
      expect(streamed(evs)).toBe('Сейчас.\nТихон.');
      await r.engine.close();
    });
  }

  test('prompted, final round: a wrapper around a name tag is counted as one hidden block', async () => {
    const r = await rig(calls([{ text: '<tool_call>{"name": "lookup", "args": {"q": "a"}}</tool_call>' }], [{ text: 'Here.\n<tool_call>\n<lookup>b</lookup>\n</tool_call>' }]), {
      caps: capsWith('prompted'),
    });
    const s = session(r.engine, 'Where is the red door?', { narrator: { maxRounds: 1 } });
    const { evs, out } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(textOf(out.message)).toBe('Here.');
    expect(notices(evs).find((n) => n.code === 'tool_markup_stripped')!.message).toContain('(1 block)');
    await r.engine.close();
  });

  test('prompted: an unclosed name tag with a fenced text body runs with the fenced query; no fence or query reaches the story', async () => {
    const log: ToolLog = { runs: [] };
    const text = 'Сейчас.\n<lookup>\n```\nдверь\n```\nОна улыбнулась.';
    const r = await rig(calls([{ text }], [{ text: 'Красная.' }]), { caps: capsWith('prompted'), toolSets: sets([lookupTool(log)]) });
    const s = session(r.engine);
    const { evs, out, turn } = await reply(s);
    if (out.type !== 'done') throw new Error(out.type);
    expect(log.runs.map((x) => x.args)).toEqual([{ q: 'дверь' }]);
    expect(streamed(evs)).toBe('Сейчас.\nОна улыбнулась.\nКрасная.');
    expect(textOf(out.message)).toBe(streamed(evs));
    expect(chkText(r.home, s.id, turn.turnId)).toBe(streamed(evs));
    await r.engine.close();
  });
});
