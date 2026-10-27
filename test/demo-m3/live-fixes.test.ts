// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The two decisions taken after the second live run (.notes/m3-decisions.md section L), end to end on
// the innkeeper chat (199 messages, the brother named only in #5) with a 16k window:
// - D-96 amended: on the prompted transport the reminder that closes the request shows the
//   search_history call in the core block's call format; the native transport keeps the D-96 text;
// - D-97: an offered tool's name used as a tag is a call of that tool. The live model (magmell-16k,
//   prompted) wrote exactly LIVE below and stopped; that output now runs one search_history call
//   whose query is the tag's text, the result goes back inside <tool_result>, and the stored answer
//   holds no tag.
// Scripted providers, and the real openai-chat wire against a local Bun.serve mock of /v1. No live
// model call.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync } from 'node:fs';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, SessionHandle, TurnOutcome } from '../../src/engine/api.ts';
import { RESULTS_SRC, ROUND_SRC } from '../../src/engine/narrate.ts';
import { GAP_SRC, gapText, REMIND_SRC, REMIND_TEXT, REMIND_TEXT_PROMPTED } from '../../src/prompt/assemble.ts';
import { SYSTEM_NOTE_PREFIX } from '../../src/prompt/shape.ts';
import type { Event } from '../../src/protocol/events.ts';
import { createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest, PromptMsg } from '../../src/providers/types.ts';
import type { Block, MsgEntry, Trace } from '../../src/session/entries.ts';
import { HISTORY_TOOLS, toolSpecs } from '../../src/tools/builtin/index.ts';
import { parsePromptedCalls, PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { entriesOf } from '../engine/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { INNKEEPER_BROTHER, INNKEEPER_MENTION, INNKEEPER_QUESTION, seedInnkeeperHome } from '../fixtures/ru/innkeeper-200/load.ts';
import { ch, mockServer, sse, type Body, type Mock } from '../probe-m3/mock.ts';

/** What magmell-16k wrote in the second live run, to the byte, then the end of the stream. */
const LIVE_QUERY = 'ранее в диалоге не упоминалось имени брата Марфы.';
const LIVE = `<search_history>\n${LIVE_QUERY}\n</search_history>\n\n`;
/** The second round's answer: the brother's name from the fixture. */
const ANSWER = `Марфа как-то обмолвилась, что её младшего брата зовут ${INNKEEPER_BROTHER}.`;
/** The history tools' real specs, as the turn offers them. */
const HISTORY_SPECS = toolSpecs(HISTORY_TOOLS());

const PROMPTED: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: 'prompted', contextLength: 16_384 };
const NATIVE: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: 'native', contextLength: 16_384 };

const text = (m: { blocks: readonly { k: string; text?: string }[] }): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');
/** The stored message's text (its text blocks joined, as the history sends it). */
const storedText = (msg: MsgEntry): string => text({ blocks: msg.blocks ?? [] });
const streamed = (evs: readonly Event[]): string => evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const codes = (evs: readonly Event[]): string[] => evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []));
/** A src as the shaper writes a merge (`history+core:remind`): its parts. */
const srcParts = (m: PromptMsg): string[] => m.src.split('+');

/** The innkeeper chat (#1..#199), seeded once; every test copies it into a home of its own. */
let seeded: string;
let seededId: string;
const engines: EngineHandle[] = [];
const mocks: Mock[] = [];

beforeAll(async () => {
  seeded = tmpHome('rp-core-live-fixes-seed-');
  seededId = await seedInnkeeperHome(seeded);
});

afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
  for (const m of mocks) m.stop();
});

async function innkeeper(conn: Connection): Promise<{ home: string; s: SessionHandle }> {
  const home = tmpHome('rp-core-live-fixes-');
  cpSync(seeded, home, { recursive: true });
  const engine = await Engine.open({
    home,
    connections: { [conn.id]: conn },
    clock: fakeClock(),
    random: fakeRandom(16),
    timeZone: 'UTC',
    checkpoint: { chars: 1e9, ms: 1e9, datasyncMs: 1e9 },
  });
  engines.push(engine);
  const s = engine.session(seededId);
  s.configure({ roles: { narrator: { conn: conn.id, model: 'magmell' } } });
  return { home, s };
}

async function ask(s: SessionHandle): Promise<{ evs: Event[]; out: TurnOutcome }> {
  const turn = s.submit({ text: INNKEEPER_QUESTION, expectedVersion: s.version() });
  const evs: Event[] = [];
  for await (const ev of turn.events) evs.push(ev);
  return { evs, out: await turn.result };
}

function committed(home: string, s: SessionHandle, out: TurnOutcome): MsgEntry {
  if (out.type !== 'done') throw new Error(`the turn ended ${out.type}: ${JSON.stringify(out)}`);
  const id = out.message.id;
  return entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === id)!;
}

function scripted(caps: ModelCaps, script: ScriptCall[]): Connection & { provider: ReturnType<typeof createScriptedProvider> } {
  return { id: 'local16k', provider: createScriptedProvider(script), caps, origin: 'script:local16k', local: true };
}

/** The path position (1-based, the history tools' numbering) of a message id. */
const posOf = (s: SessionHandle, id: string): number => s.view().path.findIndex((m) => m.id === id) + 1;

/**
 * Request 0 of the question turn, prompted (a): the gap note right after the greeting names the
 * trimmed run; the reminder (alone or merged into the question by the shaper) closes the request and
 * is the section L text, whose one block reads as search_history {query} with the offered tools.
 */
function expectPromptedRequest0(q0: ModelRequest, s: SessionHandle, trace: Trace): void {
  expect(q0.tools).toBeUndefined();
  expect(q0.stop).toContain(PROMPTED_STOP);
  expect(q0.messages.some((m) => text(m).includes(INNKEEPER_BROTHER))).toBe(false);
  // The gap note: unchanged by section L.
  const gaps = q0.messages.filter((m) => srcParts(m).includes(GAP_SRC));
  expect(gaps).toHaveLength(1);
  const [from, to] = [posOf(s, trace.trimmed!.from), posOf(s, trace.trimmed!.to)];
  expect(from).toBeLessThanOrEqual(INNKEEPER_MENTION);
  expect(to).toBeGreaterThan(INNKEEPER_MENTION);
  expect(text(gaps[0]!)).toEndWith(gapText(from, to));
  // The reminder: once, last, the prompted variant (D-96 amended), never the D-96 text.
  const reminds = q0.messages.filter((m) => srcParts(m).includes(REMIND_SRC));
  expect(reminds).toHaveLength(1);
  const last = q0.messages.at(-1)!;
  expect(reminds[0]).toBe(last);
  expect(srcParts(last).at(-1)).toBe(REMIND_SRC);
  expect(text(last)).toEndWith(REMIND_TEXT_PROMPTED);
  expect(q0.messages.some((m) => text(m).includes(REMIND_TEXT))).toBe(false);
  // Its block reads as one well-formed search_history call, with the name tags of the offered tools
  // on (D-97): nothing else in the reminder is a call.
  const blocks = parsePromptedCalls(REMIND_TEXT_PROMPTED, HISTORY_SPECS);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ name: 'search_history' });
  expect(blocks[0]!.error).toBeUndefined();
  expect(JSON.parse(blocks[0]!.args)).toEqual({ query: 'one or two key words' });
  // The gap note names the tools in prose: no call there.
  expect(parsePromptedCalls(text(gaps[0]!), HISTORY_SPECS)).toEqual([]);
}

/**
 * What the live output leaves after the turn (b): one search_history call with the tag's text as
 * its query, paired with its result, then the answer; no tag streamed or stored; nothing hidden.
 */
function expectLiveTurn(home: string, s: SessionHandle, evs: Event[], out: TurnOutcome): { result: string } {
  const msg = committed(home, s, out);
  const blocks = msg.blocks ?? [];
  expect(blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
  expect(blocks[0]).toEqual({ k: 'tool_call', id: 'call_0_0', name: 'search_history', args: JSON.stringify({ query: LIVE_QUERY }) });
  const result = blocks[1] as Extract<Block, { k: 'tool_result' }>;
  expect(result).toMatchObject({ k: 'tool_result', callId: 'call_0_0', name: 'search_history' });
  expect(result.error).toBeUndefined();
  // The round wrote nothing but the tag and blank lines: no text block, no separator before the answer.
  expect(blocks[2]).toEqual({ k: 'text', text: ANSWER });
  const stored = storedText(msg);
  expect(stored).toBe(ANSWER);
  expect(stored).not.toContain('<search_history');
  expect(stored).not.toContain('search_history>');
  expect(stored).toContain(INNKEEPER_BROTHER);
  // Live: only the answer streamed; one tool ran, in round 0; the tag was a call, not hidden markup.
  expect(streamed(evs)).toBe(ANSWER);
  const tools = evs.filter((e): e is Extract<Event, { type: 'tool' }> => e.type === 'tool');
  expect(tools.map((e) => [e.phase, e.round, e.name])).toEqual([
    ['start', 0, 'search_history'],
    ['done', 0, 'search_history'],
  ]);
  expect(tools[1]!.ok).toBe(true);
  expect(codes(evs)).not.toContain('tool_markup_stripped');
  expect(codes(evs)).not.toContain('tool_calls_on_final_round');
  expect(msg.gen).toMatchObject({ transport: 'prompted', rounds: 2, finish: 'end' });
  const trace = msg.trace as Trace;
  expect(trace.tools).toEqual([expect.objectContaining({ round: 0, callId: 'call_0_0', name: 'search_history', ok: true, chars: result.text.length })]);
  expect(trace.rounds).toMatchObject({ n: 2, transport: 'prompted', ended: 'answer' });
  return { result: result.text };
}

describe('prompted transport, 16k window: the request says the chat is cut and shows the call', () => {
  test('(a) request 0: the gap note, then the section L reminder last; its block parses as a search_history call', async () => {
    const conn = scripted(PROMPTED, [{ steps: [{ text: ANSWER }] }]);
    const { home, s } = await innkeeper(conn);
    const { out } = await ask(s);
    const msg = committed(home, s, out);
    const q0 = conn.provider.requests[0]!;
    expectPromptedRequest0(q0, s, msg.trace as Trace);
    // Not merged here (caps.midSystem 'native'): the reminder is its own system message, after the question.
    expect(q0.messages.at(-1)).toEqual({ role: 'system', blocks: [{ k: 'text', text: REMIND_TEXT_PROMPTED }], src: REMIND_SRC, placement: 'inline' });
    expect(text(q0.messages.at(-2)!)).toContain(INNKEEPER_QUESTION);
    // The core block's example and the reminder's call are the only call lines of the request.
    const callLines = q0.messages.flatMap((m) => text(m).split('\n')).filter((l) => l.startsWith('<tool_call>'));
    expect(callLines).toEqual(['<tool_call>{"name": "tool_name", "args": {"argument": "value"}}</tool_call>', '<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>']);
    // A model that answers without a call: one round, the answer stored as is.
    expect(conn.provider.requests).toHaveLength(1);
    expect(storedText(msg)).toBe(ANSWER);
  });
});

describe('prompted transport: the live output is one search_history call (D-97)', () => {
  // The live model's output as one chunk, and as a server may stream it: one character at a time
  // (every partial `<search_hi…` and `</search_hist…` sits at a chunk boundary once).
  for (const [label, chunks] of [
    ['one chunk', [LIVE]],
    ['one character per chunk', [...LIVE]],
  ] as const) {
    test(`(b) ${label}: the call runs, its result reaches request 1 in <tool_result>, the stored answer names the brother and holds no tag`, async () => {
      expect(chunks.join('')).toBe(LIVE);
      const conn = scripted(PROMPTED, [
        // Exactly the live output, then the end of the stream: no usage, no more text.
        { steps: chunks.map((t) => ({ text: t })) },
        { steps: [{ text: ANSWER }, { usage: { inputTotal: 13_200, outputTotal: 30 } }] },
      ]);
      const { home, s } = await innkeeper(conn);
      const { evs, out } = await ask(s);
      expect(conn.provider.requests).toHaveLength(2);
      const msg = committed(home, s, out);
      const [q0, q1] = conn.provider.requests as [ModelRequest, ModelRequest];
      expectPromptedRequest0(q0, s, msg.trace as Trace);
      const { result } = expectLiveTurn(home, s, evs, out);

      // Request 1: request 0, the round as the model wrote it (the tag kept, §8.3), then ONE user
      // message holding the search's result inside <tool_result>.
      expect(q1.messages.slice(0, -2)).toEqual(q0.messages);
      const [round, results] = q1.messages.slice(-2) as [PromptMsg, PromptMsg];
      expect(round).toEqual({ role: 'assistant', src: ROUND_SRC, blocks: [{ k: 'text', text: LIVE }] });
      expect(results).toMatchObject({ role: 'user', src: RESULTS_SRC });
      expect(text(results)).toBe(`<tool_result name="search_history" id="call_0_0">\n${result}\n</tool_result>`);
      expect(q1.messages.filter((m) => m.src === RESULTS_SRC)).toHaveLength(1);
      // The result is the real tool's answer to the tag's text (an AND of all its words finds no message).
      expect(result).toStartWith('No messages match.');
      // Request 1 is still prompted: no native tools, the stop that ends a round at a fake result.
      expect(q1.tools).toBeUndefined();
      expect(q1.stop).toContain(PROMPTED_STOP);
    });
  }
});

// ---- the real openai-chat wire on a local mock --------------------------------------------------------

const content = (m: Record<string, unknown>): string => (typeof m.content === 'string' ? m.content : '');
/** Round 1 of the question: a results message is on the wire. */
const isRound1 = (b: Body): boolean => b.messages.some((m) => m.role === 'user' && content(m).startsWith('<tool_result'));
/** Ollama-like: the reply in these deltas, then a stop with usage. */
const say = (parts: readonly string[]): Response =>
  sse([
    ch({ role: 'assistant', content: '' }),
    ...parts.map((p) => ch({ content: p })),
    ch({}, 'stop', { usage: { prompt_tokens: 13_000, completion_tokens: 30, total_tokens: 13_030 } }),
  ]);

function httpConn(mock: Mock, caps: ModelCaps): Connection {
  return { id: 'http', provider: createOpenAIChatProvider({ connectionId: 'http', baseUrl: `${mock.base}/v1`, local: true }), caps, origin: mock.base, local: true };
}

describe('the same over the real openai-chat wire (Bun.serve mock of /v1)', () => {
  // 'native': the reminder is its own system message; 'as-user': the shaper merges it into the
  // question as a [System note] (src history+core:remind), the call line kept whole.
  for (const midSystem of ['native', 'as-user'] as const) {
    test(`(c) midSystem ${midSystem}: the reminder on the wire, the live output split as a server streams it, one call, the brother named`, async () => {
      const mock = mockServer();
      mocks.push(mock);
      // The tag split mid-name and mid-closer, as token deltas arrive.
      const parts = ['<search_hi', `story>\n${LIVE_QUERY.slice(0, 12)}`, `${LIVE_QUERY.slice(12)}\n</search_hist`, 'ory>\n\n'];
      expect(parts.join('')).toBe(LIVE);
      mock.behave = (b) => (isRound1(b) ? say([ANSWER.slice(0, 20), ANSWER.slice(20)]) : say(parts));
      const caps: ModelCaps = { ...PROMPTED, midSystem };
      const { home, s } = await innkeeper(httpConn(mock, caps));
      const { evs, out } = await ask(s);
      const msg = committed(home, s, out);
      expect(mock.bodies.map(isRound1)).toEqual([false, true]);
      const [w0, w1] = mock.bodies as [Body, Body];

      // Request 0 on the wire: no tools, the prompted stop; the request closes with the section L text.
      expect(w0.tools).toBeUndefined();
      expect(w0.stop).toContain(PROMPTED_STOP);
      const last0 = w0.messages.at(-1)!;
      expect(content(last0)).toEndWith(REMIND_TEXT_PROMPTED);
      if (midSystem === 'native') {
        expect(last0).toMatchObject({ role: 'system', content: REMIND_TEXT_PROMPTED });
      } else {
        expect(last0.role).toBe('user');
        expect(content(last0)).toStartWith(INNKEEPER_QUESTION);
        expect(content(last0)).toEndWith(`${SYSTEM_NOTE_PREFIX}${REMIND_TEXT_PROMPTED}`);
      }
      expect(w0.messages.filter((m) => content(m).includes('(Part of this chat is hidden from you.'))).toHaveLength(1);
      expect(w0.messages.some((m) => content(m).includes(REMIND_TEXT))).toBe(false);
      expect(w0.messages.filter((m) => content(m).includes('search_history finds what was said in them'))).toHaveLength(1);

      // The turn: one search_history call with the tag's text, the answer stored without the tag.
      const { result } = expectLiveTurn(home, s, evs, out);
      // Round 1 on the wire: the round as written, then its result as one user message.
      const turn = w1.messages.at(-2)!;
      expect(turn).toMatchObject({ role: 'assistant', content: LIVE });
      expect(turn.tool_calls).toBeUndefined();
      expect(w1.messages.at(-1)).toMatchObject({ role: 'user', content: `<tool_result name="search_history" id="call_0_0">\n${result}\n</tool_result>` });
      expect(w1.messages.slice(0, -2)).toEqual(w0.messages);
      expect(storedText(msg)).toContain(INNKEEPER_BROTHER);
    });
  }
});

describe('native transport keeps the D-96 reminder', () => {
  test('(d) request 0: native tools, the gap note, the D-96 reminder last; no call is shown anywhere', async () => {
    const conn = scripted(NATIVE, [
      { steps: [{ tool: { name: 'search_history', args: { query: 'брат' } } }] },
      { steps: [{ text: ANSWER }] },
    ]);
    const { home, s } = await innkeeper(conn);
    const { out } = await ask(s);
    const msg = committed(home, s, out);
    const q0 = conn.provider.requests[0]!;
    expect(q0.tools?.map((t) => t.name).sort()).toEqual(['read_history', 'search_history']);
    expect(q0.messages.filter((m) => m.src === GAP_SRC)).toHaveLength(1);
    expect(q0.messages.at(-1)).toEqual({ role: 'system', blocks: [{ k: 'text', text: REMIND_TEXT }], src: REMIND_SRC, placement: 'inline' });
    expect(q0.messages.filter((m) => m.src === REMIND_SRC)).toHaveLength(1);
    expect(q0.messages.some((m) => text(m).includes('<tool_call>'))).toBe(false);
    expect(q0.messages.some((m) => text(m).includes(REMIND_TEXT_PROMPTED))).toBe(false);
    expect(storedText(msg)).toBe(ANSWER);
  });

  test('(d) the live output written as text in a native round still runs as one call (the prompted-family fallback)', async () => {
    const conn = scripted(NATIVE, [{ steps: [{ text: LIVE }] }, { steps: [{ text: ANSWER }] }]);
    const { home, s } = await innkeeper(conn);
    const { evs, out } = await ask(s);
    const msg = committed(home, s, out);
    expect(conn.provider.requests[0]!.messages.at(-1)!.blocks).toEqual([{ k: 'text', text: REMIND_TEXT }]);
    const blocks = msg.blocks ?? [];
    expect(blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
    expect(blocks[0]).toEqual({ k: 'tool_call', id: 'call_0_0', name: 'search_history', args: JSON.stringify({ query: LIVE_QUERY }) });
    expect(blocks[2]).toEqual({ k: 'text', text: ANSWER });
    expect(streamed(evs)).toBe(ANSWER);
    expect(codes(evs)).not.toContain('tool_markup_stripped');
    // The native wire: the call echoed as a native call, its result as a tool message.
    const q1 = conn.provider.requests[1]!;
    expect(q1.messages.at(-2)).toMatchObject({ role: 'assistant', src: ROUND_SRC });
    expect(q1.messages.at(-2)!.blocks).toEqual([{ k: 'tool_call', id: 'call_0_0', name: 'search_history', args: JSON.stringify({ query: LIVE_QUERY }) }]);
    expect(q1.messages.at(-1)).toMatchObject({ role: 'tool', src: RESULTS_SRC });
    expect(msg.gen).toMatchObject({ transport: 'native', rounds: 2, finish: 'end' });
  });
});
