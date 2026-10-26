// M1b post-processing (§6.2 step 9, D-57): leaked tool-call markup is stripped from the answer before
// it commits; the streamed text events may have shown it, the committed message never does. The
// notice tool_markup_stripped — like every assemble/shape notice — is told once per open session.
import { describe, expect, test } from 'bun:test';
import type { TurnOutcome } from '../../src/engine/api.ts';
import { saveToLibrary } from '../../src/formats/library.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, scriptConn, textOf, withUserMessage, writeRaw } from '../engine/kit.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';

const codes = (evs: readonly Event[]): string[] => evs.filter((e) => e.type === 'notice').map((e) => (e as { code: string }).code);
const streamed = (evs: readonly Event[]): string => evs.reduce((s, e) => (e.type === 'text' ? s + e.delta : s), '');

function expectDone(o: TurnOutcome): Extract<TurnOutcome, { type: 'done' }> {
  if (o.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(o)}`);
  return o;
}

const LEAK = '<tool_call>{"name": "roll_dice", "arguments": {"sides": 20}}</tool_call>';

describe('stripping leaked tool-call markup', () => {
  test('the committed text is stripped across two turns, with one notice', async () => {
    const { engine, home } = await rig(
      calls(
        [{ text: 'She rolls the die. ' }, { text: LEAK }, { text: ' It lands on twenty.' }],
        [{ text: 'Again: [TOOL_REQUEST]{"name":"x"}[END_TOOL_REQUEST] she laughs.' }],
      ),
    );
    const { s, version } = withUserMessage(engine, 'Roll.');
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: version });
    const ev1 = await drain(t1);
    const d1 = expectDone(await t1.result);

    // The stream showed the markup; the authoritative message does not.
    expect(streamed(ev1)).toContain('<tool_call>');
    expect(textOf(d1.message)).toBe('She rolls the die. It lands on twenty.');
    expect(codes(ev1)).toEqual(['tool_markup_stripped']);
    const notice = ev1.find((e) => e.type === 'notice')!;
    expect(ev1.indexOf(notice)).toBeLessThan(ev1.findIndex((e) => e.type === 'done'));
    const msg1 = entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === d1.message.id)!;
    expect(msg1.blocks).toEqual([{ k: 'text', text: 'She rolls the die. It lands on twenty.' }]);

    const v2 = s.send({ text: 'Again.', expectedVersion: s.version() }).version;
    const t2 = s.runTurn({ kind: 'reply', expectedVersion: v2 });
    const ev2 = await drain(t2);
    const d2 = expectDone(await t2.result);
    expect(textOf(d2.message)).not.toContain('TOOL_REQUEST');
    expect(textOf(d2.message)).toContain('she laughs.');
    expect(codes(ev2)).toEqual([]); // once per session
    await engine.close();
  });

  test('a clean answer is untouched and tells nothing', async () => {
    const { engine } = await rig(calls([{ text: '  Spaces stay.\n\n\n\nAs they were.  ' }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs = await drain(turn);
    expect(textOf(expectDone(await turn.result).message)).toBe('  Spaces stay.\n\n\n\nAs they were.  ');
    expect(codes(evs)).toEqual([]);
    await engine.close();
  });

  test('an answer that is nothing but leaked markup fails as empty_response', async () => {
    const { engine } = await rig(calls([{ text: LEAK }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs = await drain(turn);
    expect(await turn.result).toMatchObject({ type: 'failed', category: 'protocol', code: 'empty_response' });
    expect(codes(evs)).toEqual(['tool_markup_stripped']);
    await engine.close();
  });

  test('a stopped answer commits stripped', async () => {
    const { engine } = await rig(calls([{ text: 'Before. ' }, { text: '<tool_call>{"name":' }, { pause: 'p' }, { text: '"x"}</tool_call>' }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs: Event[] = [];
    for await (const ev of turn.events) {
      evs.push(ev);
      if (ev.type === 'text' && ev.delta.startsWith('<tool_call>')) turn.stop();
    }
    const out = await turn.result;
    if (out.type !== 'stopped' || !out.message) throw new Error(`expected stopped with text, got ${JSON.stringify(out)}`);
    // The cut-off opener strips through the end of the text.
    expect(textOf(out.message)).toBe('Before.');
    expect(codes(evs)).toEqual(['tool_markup_stripped']);
    await engine.close();
  });

  test('a failure after output hands back the stripped draft; onError keep commits it stripped', async () => {
    const steps = [{ text: 'Kept. ' }, { text: LEAK }, { text: ' More.' }, { error: { code: 'truncated_stream' as const } }];
    const { engine } = await rig(calls(steps, steps));
    const { s, version } = withUserMessage(engine);
    const dropped = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(dropped);
    expect(await dropped.result).toMatchObject({ type: 'failed', code: 'truncated_stream', draft: 'Kept. More.' });

    const kept = s.runTurn({ kind: 'reply', expectedVersion: s.version(), onError: 'keep' });
    await drain(kept);
    expect(await kept.result).toMatchObject({ type: 'failed', code: 'truncated_stream' });
    const head = s.view().path.at(-1)!;
    expect(head.gen?.finish).toBe('interrupted');
    expect(textOf(head)).toBe('Kept. More.');
    await engine.close();
  });

  test('a continue strips the leaked markup from its addition', async () => {
    const { engine } = await rig(calls([{ text: 'She nods.' }], [{ text: ' Then she waits. <tool_call>{"name":"look"}</tool_call>' }]));
    const { s, version } = withUserMessage(engine);
    const first = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(first);
    expectDone(await first.result);
    const cont = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    const evs = await drain(cont);
    expect(textOf(expectDone(await cont.result).message)).toBe('She nods. Then she waits.');
    expect(codes(evs)).toEqual(['tool_markup_stripped']);
    await engine.close();
  });
});

describe('once-per-session notices', () => {
  test('assemble/shape and leak notices are told once per open session, and again after a reopen', async () => {
    const caps = { ...SCRIPT_CAPS, prefill: 'none' as const };
    const { conn } = scriptConn('script', calls([{ text: `A ${LEAK}` }], [{ text: `B ${LEAK}` }], [{ text: `C ${LEAK}` }]), caps);
    const { engine, home } = await rig([], { connections: { script: conn } });
    const { id: preset } = saveToLibrary(home, 'presets', 'P', { ...BUILTIN_PRESET, name: 'P', prefill: 'Sure:' });
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset } });

    const run = async (h: typeof s, text: string): Promise<string[]> => {
      const v = h.send({ text, expectedVersion: h.version() }).version;
      const t = h.runTurn({ kind: 'reply', expectedVersion: v });
      const evs = await drain(t);
      expectDone(await t.result);
      return codes(evs);
    };
    expect(await run(s, 'one')).toEqual(['prefill_unsupported', 'tool_markup_stripped']);
    expect(await run(s, 'two')).toEqual([]);

    // A new open of the session is a new session handle: its first turn tells again.
    await s.close();
    const again = engine.session(s.id);
    expect(await run(again, 'three')).toEqual(['prefill_unsupported', 'tool_markup_stripped']);
    await engine.close();
  });
});

describe('recovery strips too', () => {
  test('an interrupted answer recovered on open is committed without leaked markup, with one notice', async () => {
    const { engine, home } = await rig(calls([{ text: `Next. ${LEAK}` }]));
    const { s, userId } = withUserMessage(engine, 'Hello.');
    const id = s.id;
    const base = s.version();
    await s.close();
    writeRaw(home, id, (log) => {
      log.append({ t: 'turn', ts: '2026-10-26T12:00:00.000Z', turn: 't_leak', kind: 'reply', parent: userId, msgId: 'abcd1234', seed: 1, now: '2026-10-26T12:00:00.000Z', base });
      log.append({ t: 'chk', turn: 't_leak', text: 'Recovered. ' });
      log.append({ t: 'chk', turn: 't_leak', text: '<tool_call>{"name":"x"}</tool_call> The end.' });
    });
    const reopened = engine.session(id);
    const opened = reopened.openEvents();
    expect(codes(opened)).toEqual(['tool_markup_stripped']);
    expect(opened.find((e) => e.type === 'recovered')).toMatchObject({ turnId: 't_leak', outcome: 'interrupted' });
    const head = reopened.view().path.at(-1)!;
    expect(textOf(head)).toBe('Recovered. The end.');

    // Told at open, so the first live strip in this open session stays quiet.
    const v = reopened.send({ text: 'Go on.', expectedVersion: reopened.version() }).version;
    const turn = reopened.runTurn({ kind: 'reply', expectedVersion: v });
    const evs = await drain(turn);
    expect(textOf(expectDone(await turn.result).message)).toBe('Next.');
    expect(codes(evs)).toEqual([]);
    await engine.close();
  });
});
