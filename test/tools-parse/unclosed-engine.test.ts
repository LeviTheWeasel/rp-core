// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// A prompted round whose call is complete but never closed, followed by prose (review finding
// unclosed-complete-json-then-prose), end to end on the engine: the call runs, and the prose after it
// is shown, committed and stored like the rest of the reply (it was erased, while the wire kept it).
import { describe, expect, test } from 'bun:test';
import { RESULTS_SRC, ROUND_SRC } from '../../src/engine/narrate.ts';
import type { Block } from '../../src/session/entries.ts';
import { calls, capsWith, chkText, reply, rig, session, streamed, textOf } from '../engine-m3/kit.ts';

const U = (n: number) => ({ usage: { inputTotal: 300 + n, outputTotal: 10 } });

describe('prompted: an unclosed complete call, then prose', () => {
  test('the call runs; the prose after it is in the events, the chk lines and the message', async () => {
    const round1 = 'Let me check. <tool_call>{"name": "lookup", "args": {"q": "door"}}\nThe tavern was quiet that night.';
    const r = await rig(
      calls(
        [{ text: 'Let me check. <tool_call>{"name": "lookup", ' }, { text: '"args": {"q": "door"}}\nThe tavern was ' }, { text: 'quiet that night.' }, U(0)],
        [{ text: 'The door is red.' }, U(1)],
      ),
      { caps: capsWith('prompted') },
    );
    const s = session(r.engine);
    const { evs, out, turn } = await reply(s);
    expect(out.type).toBe('done');
    if (out.type !== 'done') return;
    expect(r.log.runs.map((x) => [x.name, x.args])).toEqual([['lookup', { q: 'door' }]]);
    const shown = streamed(evs);
    expect(shown).toBe('Let me check.\nThe tavern was quiet that night.\nThe door is red.');
    expect(chkText(r.home, s.id, turn.turnId)).toBe(shown);
    expect(textOf(out.message as { blocks: Block[] })).toBe(shown);
    expect(out.message.blocks).toEqual([
      { k: 'text', text: 'Let me check.\nThe tavern was quiet that night.' },
      { k: 'tool_call', id: 'call_0_0', name: 'lookup', args: '{"q":"door"}' },
      { k: 'tool_result', callId: 'call_0_0', name: 'lookup', text: 'found door' },
      { k: 'text', text: '\nThe door is red.' },
    ]);
    // The wire holds the round as the model wrote it, then the result; no error result for a "cut off" call.
    const q1 = r.provider.requests[1]!;
    expect(q1.messages.slice(-2)).toEqual([
      { role: 'assistant', src: ROUND_SRC, blocks: [{ k: 'text', text: round1 }] },
      { role: 'user', src: RESULTS_SRC, blocks: [{ k: 'text', text: '<tool_result name="lookup" id="call_0_0">\nfound door\n</tool_result>' }] },
    ]);
    await r.engine.close();
  });
});
