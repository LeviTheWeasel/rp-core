// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The M3 review fixes working together, end to end (.notes/m3-contract-fix.md). Each group fixed and
// tested its own files; this file runs the paths where their changes meet, on the innkeeper chat and
// the real tools:
// - the innkeeper demo with a NATIVE scripted model (test/demo-m3/innkeeper.test.ts is the prompted one);
// - a salvaged-JSON turn on both transports over the real openai-chat wire (a Bun.serve mock of /v1):
//   the call runs, the JSON leaves the stored story and the next request (engine), the prompted
//   parser keeps the prose of an unclosed block whose call is complete (parse);
// - two read_history calls in one round at 8k and 16k windows: the engine charges the round first,
//   the runner shares what is left before the tools run, read_history fits its paging lines (search):
//   no cursor is lost;
// - a DeepSeek-caps session (resolveCaps, the real wire) with a greeting and a foreign answer, then
//   three tool turns: thinking stays as bound, every answer without this model's reasoning goes out
//   with the placeholder, nothing is told (revised D-94);
// - a note renamed, then found by the tool and by /memory under the same C<n> (amended D-59, the
//   rename moving the keyless note's key, the confirmation naming the title).
// No live model call: scripted providers and a local mock only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync } from 'node:fs';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, SessionHandle, TurnOutcome } from '../../src/engine/api.ts';
import { RESULTS_SRC, ROUND_SRC } from '../../src/engine/narrate.ts';
import { GAP_SRC, REMIND_SRC } from '../../src/prompt/assemble.ts';
import type { Event } from '../../src/protocol/events.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import { createOpenAIChatProvider, ECHO_PLACEHOLDER } from '../../src/providers/openai-chat.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import type { ModelCaps, PromptMsg } from '../../src/providers/types.ts';
import type { Block, MsgEntry, Trace } from '../../src/session/entries.ts';
import { NO_ROOM_MARK } from '../../src/tools/run.ts';
import { entriesOf, LEVI } from '../engine/kit.ts';
import { MIRA_TOOLS } from '../engine-m3/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { INNKEEPER_BROTHER, INNKEEPER_MENTION, INNKEEPER_QUESTION, seedInnkeeperHome } from '../fixtures/ru/innkeeper-200/load.ts';
import { ch, mockServer, sse, type Body, type Mock } from '../probe-m3/mock.ts';
import { calls as replCalls, replRig } from '../repl/kit.ts';

const ANSWER = 'Марфа говорила, что её младшего брата зовут Тихон: он третью неделю торгует на ярмарке в Велеграде.';
const text = (m: { blocks: readonly { k: string; text?: string }[] }): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');

/** The innkeeper chat (#1..#199), seeded once; every test copies it into a home of its own. */
let seeded: string;
let seededId: string;
const engines: EngineHandle[] = [];
const mocks: Mock[] = [];

beforeAll(async () => {
  seeded = tmpHome('rp-core-fixes-seed-');
  seededId = await seedInnkeeperHome(seeded);
});

afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
  for (const m of mocks) m.stop();
});

/** An engine on a copy of the seeded home, with these connections; the session's narrator rebound. */
async function innkeeper(connections: Record<string, Connection>, narrator: { conn: string; model: string }): Promise<{ home: string; engine: EngineHandle; s: SessionHandle }> {
  const home = tmpHome('rp-core-fixes-');
  cpSync(seeded, home, { recursive: true });
  const engine = await Engine.open({
    home,
    connections,
    clock: fakeClock(),
    random: fakeRandom(16),
    timeZone: 'UTC',
    checkpoint: { chars: 1e9, ms: 1e9, datasyncMs: 1e9 },
  });
  engines.push(engine);
  const s = engine.session(seededId);
  s.configure({ roles: { narrator } });
  return { home, engine, s };
}

async function ask(s: SessionHandle, question: string): Promise<{ evs: Event[]; out: TurnOutcome }> {
  const turn = s.submit({ text: question, expectedVersion: s.version() });
  const evs: Event[] = [];
  for await (const ev of turn.events) evs.push(ev);
  return { evs, out: await turn.result };
}

function committed(home: string, s: SessionHandle, out: TurnOutcome): MsgEntry {
  if (out.type !== 'done') throw new Error(`the turn ended ${out.type}: ${JSON.stringify(out)}`);
  const id = out.message.id;
  return entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === id)!;
}

const scripted = (id: string, caps: ModelCaps, script: ScriptCall[]): Connection & { provider: ReturnType<typeof createScriptedProvider> } => ({
  id,
  provider: createScriptedProvider(script),
  caps,
  origin: `script:${id}`,
  local: true,
});

describe('the innkeeper demo with a native model', () => {
  test('search_history «брат» as a native call: the gap note and reminder, ONE tool message, Тихон in the answer', async () => {
    const caps: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: 'native', contextLength: 16_384 };
    const conn = scripted('local16k', caps, [
      { steps: [{ tool: { name: 'search_history', args: { query: 'брат' } } }, { usage: { inputTotal: 13_000, outputTotal: 20 } }] },
      { steps: [{ text: ANSWER }, { usage: { inputTotal: 13_200, outputTotal: 40 } }] },
    ]);
    const { home, s } = await innkeeper({ local16k: conn }, { conn: 'local16k', model: 'magmell' });
    const { evs, out } = await ask(s, INNKEEPER_QUESTION);
    const msg = committed(home, s, out);

    const [q0, q1] = conn.provider.requests;
    expect(conn.provider.requests).toHaveLength(2);
    // Round 0: the history tools natively, no prompted core block, the chat cut and said so (D-96).
    expect(q0!.tools?.map((t) => t.name).sort()).toEqual(['read_history', 'search_history']);
    expect(q0!.toolChoice).toBe('auto');
    expect(q0!.messages.some((m) => text(m).includes(INNKEEPER_BROTHER))).toBe(false);
    expect(q0!.messages.filter((m) => m.src === GAP_SRC)).toHaveLength(1);
    expect(q0!.messages.at(-1)!.src).toBe(REMIND_SRC);
    // Round 1: round 0's assistant turn (the call) and ONE tool message whose result names Тихон in #5.
    const [round, results] = q1!.messages.slice(-2) as [PromptMsg, PromptMsg];
    expect(round).toMatchObject({ role: 'assistant', src: ROUND_SRC });
    expect(round.blocks).toEqual([{ k: 'tool_call', id: expect.any(String), name: 'search_history', args: '{"query":"брат"}' }]);
    const id = (round.blocks[0] as Extract<Block, { k: 'tool_call' }>).id;
    expect(results).toMatchObject({ role: 'tool', src: RESULTS_SRC });
    const result = (results.blocks[0] as Extract<Block, { k: 'tool_result' }>).text;
    const five = result.split('\n').find((l) => l.startsWith(`#${INNKEEPER_MENTION} `))!;
    expect(five).toContain(INNKEEPER_BROTHER);
    expect(q1!.messages.slice(0, -2)).toEqual(q0!.messages);

    // The answer: streamed text only, paired blocks stored, a native 2-round trace.
    expect(evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')).toBe(ANSWER);
    expect((msg.blocks ?? []).map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
    expect(msg.blocks![2]).toEqual({ k: 'text', text: ANSWER });
    expect(msg.gen).toMatchObject({ transport: 'native', rounds: 2, finish: 'end' });
    const trace = msg.trace as Trace;
    expect(trace.rounds).toMatchObject({ n: 2, transport: 'native', ended: 'answer' });
    expect(msg.blocks![0]).toEqual({ k: 'tool_call', id, name: 'search_history', args: '{"query":"брат"}' });
    expect(trace.tools).toEqual([{ round: 0, callId: id, name: 'search_history', ok: true, ms: expect.any(Number), chars: result.length }]);
  });
});

describe('two read_history calls in one round keep both cursors (engine room × runner limit × read_history)', () => {
  for (const window of [8192, 16_384]) {
    test(`window ${window}`, async () => {
      const caps: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: 'native', contextLength: window };
      const conn = scripted('local', caps, [
        {
          steps: [
            { text: 'Let me read back.' },
            { tool: { name: 'read_history', args: { from: 2 } } },
            { tool: { name: 'read_history', args: { from: 100 } } },
          ],
        },
        { steps: [{ text: ANSWER }] },
      ]);
      const { home, s } = await innkeeper({ local: conn }, { conn: 'local', model: 'm' });
      const { out } = await ask(s, INNKEEPER_QUESTION);
      const msg = committed(home, s, out);
      const results = (msg.blocks ?? []).filter((b): b is Extract<Block, { k: 'tool_result' }> => b.k === 'tool_result');
      expect(results).toHaveLength(2);
      for (const [r, from] of [[results[0]!, 2], [results[1]!, 100]] as const) {
        // Never cut by the runner: no mark, the paging lines last.
        expect(r.text).not.toContain('[cut: ');
        expect(r.text).not.toBe(NO_ROOM_MARK);
        const tail = r.text.split('\n').slice(-3);
        expect(tail[0]).toMatch(new RegExp(`^returned: #${from} to #(\\d+)$`));
        const last = Number(/#(\d+)$/.exec(tail[0]!)![1]);
        expect(tail[1]).toBe(`next_from: ${last + 1}`);
        expect(tail[2]).toBe(`You have not read #${last + 1} to #200 yet. Call read_history with from=${last + 1} before you say anything about them.`);
        // D-58: at least two whole messages.
        expect(last).toBeGreaterThanOrEqual(from + 1);
      }
      const trace = msg.trace as Trace;
      expect(trace.tools!.map((t) => [t.name, t.ok, t.cut])).toEqual([
        ['read_history', true, undefined],
        ['read_history', true, undefined],
      ]);
      // Both results fit the tool room the round left (the runner shared it before the tools ran).
      const room = trace.rounds!.room;
      expect(trace.rounds!.roomLeft).toBeGreaterThanOrEqual(0);
      expect(results[0]!.text.length + results[1]!.text.length).toBeLessThanOrEqual(room * 2.5);
    });
  }
});

// ---- the real openai-chat wire on a local mock -------------------------------------------------------

const NEXT_Q = 'А где он сейчас?';
const NEXT_A = 'Должно быть, всё ещё на ярмарке.';
const SALVAGED = '{"name": "search_history", "arguments": {"query": "брат"}}';
const content = (m: Record<string, unknown>): string => (typeof m.content === 'string' ? m.content : '');
const lastIndex = <T>(xs: readonly T[], f: (x: T) => boolean): number => xs.findLastIndex(f);

/** A text reply of one delta, then a finish with usage. */
const say = (t: string): Response => sse([ch({ role: 'assistant', content: t }), ch({}, 'stop', { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })]);

/** What turn and round a request is: the question's round 0, its round 1 (results last), or the next question. */
function phaseOf(b: Body): 'round0' | 'round1' | 'next' {
  const ms = b.messages;
  // A result quotes the question (search_history lists #200), so a results message never counts as it.
  const isResult = (m: Record<string, unknown>): boolean => m.role === 'tool' || (m.role === 'user' && content(m).startsWith('<tool_result'));
  const r = lastIndex(ms, isResult);
  const q = lastIndex(ms, (m) => m.role === 'user' && !isResult(m) && content(m).includes(INNKEEPER_QUESTION));
  const n = lastIndex(ms, (m) => m.role === 'user' && !isResult(m) && content(m).includes(NEXT_Q));
  if (n > q && n > r) return 'next';
  return r > q ? 'round1' : 'round0';
}

function httpConn(mock: Mock, caps: ModelCaps): Connection {
  return { id: 'http', provider: createOpenAIChatProvider({ connectionId: 'http', baseUrl: `${mock.base}/v1`, local: true }), caps, origin: mock.base, local: true };
}

describe('a salvaged JSON call over the real wire, on both transports', () => {
  for (const transport of ['native', 'prompted'] as const) {
    test(`${transport}: the call runs, the JSON leaves the stored story and the next request; what streamed stays streamed`, async () => {
      const mock = mockServer();
      mocks.push(mock);
      mock.behave = (b) => ({ round0: () => say(`Сейчас вспомню.\n${SALVAGED}`), round1: () => say(ANSWER), next: () => say(NEXT_A) })[phaseOf(b)]();
      const caps: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: transport, contextLength: 16_384 };
      const { home, s } = await innkeeper({ http: httpConn(mock, caps) }, { conn: 'http', model: 'm' });
      const { evs, out } = await ask(s, INNKEEPER_QUESTION);
      const msg = committed(home, s, out);
      expect(mock.bodies.map(phaseOf)).toEqual(['round0', 'round1']);

      // Stored: the prose without the JSON, the call and its result paired, the answer after the separator.
      const blocks = msg.blocks ?? [];
      expect(blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
      expect(blocks[0]).toEqual({ k: 'text', text: 'Сейчас вспомню.' });
      expect(blocks[1]).toMatchObject({ k: 'tool_call', name: 'search_history', args: '{"query":"брат"}' });
      expect((blocks[2] as Extract<Block, { k: 'tool_result' }>).text).toContain(INNKEEPER_BROTHER);
      expect(blocks[3]).toEqual({ k: 'text', text: `\n${ANSWER}` });
      // The events streamed the JSON before it was recognised; the turn says it was taken out.
      expect(evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')).toBe(`Сейчас вспомню.\n${SALVAGED}\n${ANSWER}`);
      expect(evs.some((e) => e.type === 'notice' && e.code === 'tool_markup_stripped')).toBe(true);
      expect(msg.gen).toMatchObject({ transport, rounds: 2 });

      // Round 1 on the wire: native sends the visible text with the call; prompted sends the round as
      // written (the model sees its call) and the results as one user message.
      const w1 = mock.bodies[1]!.messages;
      const turn = w1.findLast((m) => m.role === 'assistant')!;
      if (transport === 'native') {
        expect(turn.content).toBe('Сейчас вспомню.');
        expect((turn.tool_calls as { function: { name: string; arguments: string } }[]).map((c) => c.function)).toEqual([{ name: 'search_history', arguments: '{"query":"брат"}' }]);
        expect(content(w1.at(-1)!)).toContain(INNKEEPER_BROTHER);
        expect(w1.at(-1)!.role).toBe('tool');
      } else {
        expect(turn.content).toBe(`Сейчас вспомню.\n${SALVAGED}`);
        expect(turn.tool_calls).toBeUndefined();
        expect(content(w1.at(-1)!)).toStartWith('<tool_result name="search_history"');
      }

      // The next question: the earlier answer is history without the JSON.
      const next = await ask(s, NEXT_Q);
      expect(next.out.type).toBe('done');
      const w2 = mock.bodies.at(-1)!.messages;
      expect(phaseOf(mock.bodies.at(-1)!)).toBe('next');
      const history = w2.filter((m) => m.role === 'assistant').map(content).join('\n');
      expect(history).toContain(`Сейчас вспомню.\n${ANSWER}`);
      expect(history).not.toContain('"arguments"');
    });
  }

  test('prompted: an unclosed block whose call is complete, then prose — the call runs and the prose stays (parse fix through the engine)', async () => {
    const mock = mockServer();
    mocks.push(mock);
    const block = '<tool_call>{"name": "search_history", "args": {"query": "брат"}}';
    mock.behave = (b) => ({ round0: () => say(`${block}\nМарфа задумалась.`), round1: () => say(ANSWER), next: () => say(NEXT_A) })[phaseOf(b)]();
    const caps: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: 'prompted', contextLength: 16_384 };
    const { home, s } = await innkeeper({ http: httpConn(mock, caps) }, { conn: 'http', model: 'm' });
    const { evs, out } = await ask(s, INNKEEPER_QUESTION);
    const msg = committed(home, s, out);
    const blocks = msg.blocks ?? [];
    expect(blocks.map((b) => b.k)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    expect(blocks[0]).toEqual({ k: 'text', text: 'Марфа задумалась.' });
    expect(blocks[1]).toMatchObject({ k: 'tool_call', name: 'search_history', args: '{"query":"брат"}' });
    expect((blocks[2] as Extract<Block, { k: 'tool_result' }>).text).toContain(INNKEEPER_BROTHER);
    expect(blocks[3]).toEqual({ k: 'text', text: `\n${ANSWER}` });
    const shown = evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    expect(shown).toBe(`Марфа задумалась.\n${ANSWER}`);
    expect(shown).not.toContain('<tool_call');
  });
});

describe('DeepSeek (revised D-94) over the real wire: a greeting and a foreign answer, then three tool turns', () => {
  test('thinking stays as bound, tools stay offered, every answer without its own reasoning gets the placeholder, nothing is told', async () => {
    const mock = mockServer();
    mocks.push(mock);
    let turn = 0;
    mock.behave = (b) => {
      const last = b.messages.at(-1)!;
      if (last.role === 'tool') {
        return sse([ch({ role: 'assistant', reasoning_content: `Answering ${turn}.` }), ch({ content: `Answer ${turn}.` }), ch({}, 'stop', { usage: { prompt_tokens: 200, completion_tokens: 9, total_tokens: 209 } })]);
      }
      turn++;
      return sse([
        ch({ role: 'assistant', reasoning_content: `Thinking ${turn}.` }),
        ch({ tool_calls: [{ index: 0, id: `call_ds_${turn}`, type: 'function', function: { name: 'search_lore', arguments: '{"query":"unicorn"}' } }] }),
        ch({}, 'tool_calls', { usage: { prompt_tokens: 200, completion_tokens: 9, total_tokens: 209 } }),
      ]);
    };
    // The DeepSeek API's own record (host and model rows), sent to the mock.
    const caps = resolveCaps({ dialect: 'openai-chat', origin: 'https://api.deepseek.com', local: false, model: 'deepseek-v4-flash' });
    expect(caps).toMatchObject({ tools: 'native', reasoning: { echo: 'all-with-tools', canDisable: true, control: 'toggle' } });
    const ds: Connection = { id: 'ds', provider: createOpenAIChatProvider({ connectionId: 'ds', baseUrl: `${mock.base}/v1`, local: false }), caps, origin: mock.base, local: false };
    const other = scripted('other', structuredClone(SCRIPT_CAPS), [{ steps: [{ text: 'A foreign answer.' }] }]);
    const home = tmpHome('rp-core-fixes-ds-');
    const engine = await Engine.open({ home, connections: { ds, other }, clock: fakeClock(), random: fakeRandom(3), timeZone: 'UTC', checkpoint: { chars: 1e9, ms: 1e9, datasyncMs: 1e9 } });
    engines.push(engine);
    const s = engine.createSession({ character: MIRA_TOOLS, persona: LEVI, config: { roles: { narrator: { conn: 'other', model: 'any' } } } });
    expect((await ask(s, 'Hello.')).out.type).toBe('done');
    s.configure({ roles: { narrator: { conn: 'ds', model: 'deepseek-v4-flash', reasoning: 'high' } } });

    const told: string[] = [];
    let lastAnswer = '';
    for (const q of ['Where is the red door?', 'And the key?', 'Who keeps it?']) {
      const { evs, out } = await ask(s, q);
      if (out.type !== 'done') throw new Error(out.type);
      lastAnswer = out.message.id;
      for (const e of evs) if (e.type === 'notice') told.push(e.code);
    }
    // preview --turn rebuilds the third turn's round 0 as it went out (the binding's reasoning, the echo).
    const p = s.preview({ turn: lastAnswer });
    if (!p.ok) throw new Error(p.message);
    expect((p.wire as { body: unknown }).body).toEqual(mock.bodies[4]);
    expect(told).not.toContain('caps.suggest');
    expect(mock.bodies).toHaveLength(6);

    for (const [i, b] of mock.bodies.entries()) {
      // The binding's thinking setting ('high': DeepSeek thinks by default) on every call: never turned off.
      expect(b.thinking).toBeUndefined();
      const assistants = b.messages.filter((m) => m.role === 'assistant');
      // Every assistant message carries reasoning_content: its own, else the one-space placeholder.
      for (const m of assistants) expect(typeof m.reasoning_content).toBe('string');
      const echoed = assistants.map((m) => m.reasoning_content);
      // The greeting and the foreign answer: the placeholder, on every call.
      expect(echoed.slice(0, 2)).toEqual([ECHO_PLACEHOLDER, ECHO_PLACEHOLDER]);
      // Every round 0 offers the tools (tool_choice never sent: the record lists none).
      if (i % 2 === 0) {
        expect((b.tools as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0);
        expect(b.tool_choice).toBeUndefined();
      }
      // DeepSeek's own earlier answers carry their own reasoning, never the placeholder.
      expect(echoed.slice(2).every((r) => r !== ECHO_PLACEHOLDER)).toBe(true);
    }
    // Round 1 of the third turn: the greeting and the foreign answer with the placeholder, the two
    // earlier answers with the reasoning of both their rounds, this turn's round with its own.
    expect(mock.bodies[5]!.messages.filter((m) => m.role === 'assistant').map((m) => [m.content, m.reasoning_content, Array.isArray(m.tool_calls)])).toEqual([
      ['Hello, Levi. I am Mira.', ECHO_PLACEHOLDER, false],
      ['A foreign answer.', ECHO_PLACEHOLDER, false],
      ['Answer 1.', 'Thinking 1.\n\nAnswering 1.', false],
      ['Answer 2.', 'Thinking 2.\n\nAnswering 2.', false],
      [null, 'Thinking 3.', true],
    ]);
  });
});

describe('a renamed note keeps one handle: the tools and /memory say the same C<n> (amended D-59)', () => {
  test('rename without keys moves the key; search_lore lists C2 under the new title, read_lore reads it, /memory show C2 prints it', async () => {
    const script = replCalls(
      [{ tool: { name: 'search_lore', args: { query: 'Uncle' } } }],
      // The handle as a model may write it: one string, a Cyrillic С.
      [{ tool: { name: 'read_lore', args: { ids: 'С2, L9' } } }],
      [{ text: 'He sails the north road.' }],
    );
    const r = await replRig(script, { caps: { ...structuredClone(SCRIPT_CAPS), tools: 'native' } });
    try {
      r.type(
        '/memory add Lamp | | The lamp in the window never goes out.',
        '/memory add Brother | | Yan sails the north road.',
        '/memory edit C2 Uncle',
        'What do you remember?',
        '/memory show C2',
      );
      r.end();
      expect(await r.done).toBe(0);
      const out = r.out();
      // The rename: the confirmation names the note by handle and new title; the key moved with it.
      expect(out).toContain('note C2 "Uncle" changed: title (from the next turn)');
      expect(out).toMatch(/C2 Uncle · note:brother\n {2}keys: Uncle\n/);
      // The turn offered the lore tools (no key came up), and the lookup lines name C2.
      expect((r.provider.requests[0]!.tools ?? []).map((t) => t.name)).toEqual(['read_lore', 'search_lore']);
      expect(out).toContain('⋯ search_lore "Uncle" → 1 hit');
      expect(out).toContain('⋯ read_lore ids=С2, L9 → 1 read, 1 unknown');
      // What the model got: C2 is the /memory handle, under the new title, read whole.
      const msg = entriesOf(r.home, r.session.id).findLast((e): e is MsgEntry => e.t === 'msg' && e.role === 'assistant')!;
      const results = (msg.blocks ?? []).filter((b): b is Extract<Block, { k: 'tool_result' }> => b.k === 'tool_result').map((b) => b.text);
      expect(results[0]!.split('\n').filter((l) => /^[CL]\d+ /.test(l))).toEqual([expect.stringMatching(/^C2 Uncle \(/)]);
      expect(results[1]).toContain('Yan sails the north road.');
      expect(results[1]).toContain('L9');
    } finally {
      await r.engine.close();
    }
  });
});
