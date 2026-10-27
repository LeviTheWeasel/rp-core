// The M3 demo end to end, deterministic (ARCHITECTURE.md §15 "Тулы и поиск"): the 199-message
// innkeeper chat on a scripted connection with prompted tools and a 16k window. The user asks for
// the innkeeper's brother; the answer (#5) is far outside the window, so the script searches
// «брат», the result shows «братом … Тихон», and the final round names him. The request says the
// chat is cut (D-96): the gap note right after the greeting names the left-out run, the reminder is
// the last message. Then the note half: a
// note keyed «брат» fires on «брата» at depth 4, and /search (SessionHandle.search) finds #5.
// The live run of the same demo is docs/M3-DEMO.md and test/live/m3-ollama.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Engine } from '../../src/engine/engine.ts';
import type { EngineHandle, SessionHandle, TurnOutcome } from '../../src/engine/api.ts';
import { RESULTS_SRC, ROUND_SRC } from '../../src/engine/narrate.ts';
import { makeStyle, renderPreview } from '../../src/cli/repl-render.ts';
import { GAP_SRC, gapText, REMIND_SRC, REMIND_TEXT_PROMPTED } from '../../src/prompt/assemble.ts';
import type { Event } from '../../src/protocol/events.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { ModelCaps, PromptMsg } from '../../src/providers/types.ts';
import type { MsgEntry, Trace } from '../../src/session/entries.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { entriesOf } from '../engine/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import {
  INNKEEPER_BROTHER,
  INNKEEPER_MENTION,
  INNKEEPER_QUESTION,
  innkeeperConnection,
  loadInnkeeper,
  seedInnkeeperSession,
} from '../fixtures/ru/innkeeper-200/load.ts';

/** The demo's connection: a local model with prompted tools and a 16k window (like magmell-16k). */
const CAPS: ModelCaps = { ...structuredClone(SCRIPT_CAPS), tools: 'prompted', contextLength: 16_384 };
const CALL = '<tool_call>{"name": "search_history", "args": {"query": "брат"}}</tool_call>';
const ANSWER = 'Марфа говорила, что её младшего брата зовут Тихон: он третью неделю торгует на ярмарке в Велеграде.';
const NOTE = { title: 'Брат трактирщицы', keys: ['брат'], content: 'Её младшего брата зовут Тихон.' };
const DRAFT = 'А где сейчас её брата искать?';

const text = (m: { blocks: readonly { k: string; text?: string }[] }): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');

let home: string;
let engine: EngineHandle;
let provider: ScriptedProvider;
let s: SessionHandle;
let evs: Event[];
let out: TurnOutcome;

beforeAll(async () => {
  home = tmpHome();
  provider = createScriptedProvider([
    { steps: [{ text: CALL }, { usage: { inputTotal: 13_000, outputTotal: 20 } }] },
    { steps: [{ text: ANSWER }, { usage: { inputTotal: 13_200, outputTotal: 40 } }] },
  ]);
  engine = await Engine.open({
    home,
    connections: {
      innkeeper: innkeeperConnection(),
      local16k: { id: 'local16k', provider, caps: CAPS, origin: 'script:local16k', local: true },
    },
    clock: fakeClock(),
    random: fakeRandom(16),
    timeZone: 'UTC',
    checkpoint: { chars: 1e9, ms: 1e9, datasyncMs: 1e9 },
  });
  const id = await seedInnkeeperSession(engine, { narrator: { conn: 'local16k', model: 'magmell' } });
  s = engine.session(id);
  const turn = s.submit({ text: INNKEEPER_QUESTION, expectedVersion: s.version() });
  evs = [];
  for await (const ev of turn.events) evs.push(ev);
  out = await turn.result;
});

afterAll(async () => {
  await engine.close();
});

function committed(): MsgEntry {
  if (out.type !== 'done') throw new Error(`the turn ended ${out.type}`);
  const id = out.message.id;
  return entriesOf(home, s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === id)!;
}
const traceOf = (): Trace => committed().trace!;

describe('the question turn (prompted tools, 16k window)', () => {
  test('request 0: the core block with the history tools, the early chat trimmed, the prompted stop', () => {
    const q0 = provider.requests[0]!;
    const core = q0.messages.filter((m) => m.src === 'core:tools');
    expect(core).toHaveLength(1);
    const catalog = text(core[0]!);
    // The protocol and the catalog: both history tools, no lore tools (the card has no book, no notes yet).
    expect(catalog).toContain('<tool_call>');
    expect(catalog).toContain('search_history');
    expect(catalog).toContain('read_history');
    expect(catalog).not.toContain('search_lore');
    // Prompted: nothing native on the wire; the stop that ends a round at its first fake result.
    expect(q0.tools).toBeUndefined();
    expect(q0.stop).toContain(PROMPTED_STOP);
    // The question is the last chat message; #5 (the brother) was trimmed away with the rest of the early chat.
    expect(text(q0.messages.at(-2)!)).toContain(INNKEEPER_QUESTION);
    expect(q0.messages.some((m) => text(m).includes(INNKEEPER_BROTHER))).toBe(false);
    const trace = traceOf();
    expect(trace.trimmed).not.toBeNull();
    const path = s.view().path;
    const trimmedFrom = path.findIndex((m) => m.id === trace.trimmed!.from) + 1;
    const trimmedTo = path.findIndex((m) => m.id === trace.trimmed!.to) + 1;
    expect(trimmedFrom).toBeLessThanOrEqual(INNKEEPER_MENTION);
    expect(trimmedTo).toBeGreaterThan(INNKEEPER_MENTION);
  });

  test('request 0 says the chat is cut (D-96): the gap note after the greeting names #2–#169, the reminder is last', () => {
    const q0 = provider.requests[0]!;
    const trace = traceOf();
    const path = s.view().path;
    const trimmedFrom = path.findIndex((m) => m.id === trace.trimmed!.from) + 1;
    const trimmedTo = path.findIndex((m) => m.id === trace.trimmed!.to) + 1;
    // The fixture keeps the greeting (#1) and #170–#199 of the seeded chat, then the question (#200).
    expect([trimmedFrom, trimmedTo]).toEqual([2, 169]);
    const gaps = q0.messages.filter((m) => m.src === GAP_SRC);
    expect(gaps).toHaveLength(1);
    const at = q0.messages.indexOf(gaps[0]!);
    expect(gaps[0]).toEqual({ role: 'system', blocks: [{ k: 'text', text: gapText(trimmedFrom, trimmedTo) }], src: GAP_SRC, placement: 'inline' });
    expect(text(gaps[0]!)).toBe(
      '[Messages #2\u2013#169 of this chat are not shown here. search_history finds what was said in them; read_history shows them in full.]',
    );
    // Right after the greeting (the first chat message), right before the first message kept after the run (#170).
    const firstChat = q0.messages.findIndex((m) => m.src === 'history');
    expect(at).toBe(firstChat + 1);
    expect(text(q0.messages[firstChat]!)).toBe(loadInnkeeper().character.greetings[0]!);
    expect(q0.messages[at + 1]).toMatchObject({ src: 'history', role: path[169]!.role });
    expect(text(q0.messages[at + 1]!)).toBe(text(path[169]!));
    // The reminder closes the request, after the question: prompted tools, so the variant that shows the call (D-96 amended).
    expect(q0.messages.at(-1)).toEqual({ role: 'system', blocks: [{ k: 'text', text: REMIND_TEXT_PROMPTED }], src: REMIND_SRC, placement: 'inline' });
    expect(q0.messages.filter((m) => m.src === REMIND_SRC)).toHaveLength(1);
    // Both are counted in the trace (one row each, 1:1 with the messages).
    expect(trace.blocks.map((b) => b.src)).toEqual(q0.messages.map((m) => m.src));
  });

  test('preview --turn rebuilds request 0 with both notes; /preview shows them with their src like any message', () => {
    const p = s.preview({ turn: committed().id });
    if (!p.ok) throw new Error(p.message);
    expect(p.messages).toEqual(provider.requests[0]!.messages);
    const shown = renderPreview(p, makeStyle(false), undefined, 'prompted');
    const gap = p.messages.findIndex((m) => m.src === GAP_SRC);
    const n = p.messages.length;
    const tok = (i: number): number => p.trace.blocks[i]!.tok;
    expect(shown).toContain(`\n#${gap + 1} system · core:gap · ${tok(gap)} tok\n${gapText(2, 169)}\n\n#${gap + 2} user · history · `);
    expect(shown).toContain(`\n#${n - 1} user · history · ${tok(n - 2)} tok\n${INNKEEPER_QUESTION}\n\n#${n} system · core:remind · ${tok(n - 1)} tok\n${REMIND_TEXT_PROMPTED}\n\nprefill: none`);
  });

  test('round 0 searches «брат»; request 1 carries the round and ONE results message with «братом» and «Тихон»', () => {
    expect(provider.requests).toHaveLength(2);
    const q1 = provider.requests[1]!;
    const [round, results] = q1.messages.slice(-2) as [PromptMsg, PromptMsg];
    expect(round).toMatchObject({ role: 'assistant', src: ROUND_SRC });
    expect(text(round)).toBe(CALL);
    expect(results).toMatchObject({ role: 'user', src: RESULTS_SRC });
    expect(q1.messages.filter((m) => m.src === RESULTS_SRC)).toHaveLength(1);
    const result = text(results);
    expect(result.startsWith('<tool_result name="search_history" id="call_0_0">')).toBe(true);
    // Newest first: the question itself (#200, in the context), then #5 (outside it) with the name.
    const hits = result.split('\n').filter((l) => l.startsWith('#'));
    expect(hits.map((l) => l.slice(0, l.indexOf(' ')))).toEqual(['#200', `#${INNKEEPER_MENTION}`]);
    expect(hits[0]).toEndWith('(in context)');
    const five = hits[1]!;
    expect(five).toContain('братом');
    expect(five).toContain(INNKEEPER_BROTHER);
    expect(five).not.toContain('(in context)');
    // Request 1 is request 0 plus the round: nothing was re-assembled.
    expect(q1.messages.slice(0, -2)).toEqual(provider.requests[0]!.messages);
  });

  test('the answer names Тихон; no tool markup reached the events or the stored text', () => {
    expect(out.type).toBe('done');
    const streamed = evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    expect(streamed).toBe(ANSWER);
    expect(streamed).not.toContain('<tool');
    const tools = evs.filter((e): e is Extract<Event, { type: 'tool' }> => e.type === 'tool');
    expect(tools.map((e) => [e.phase, e.round, e.name])).toEqual([
      ['start', 0, 'search_history'],
      ['done', 0, 'search_history'],
    ]);
    expect(tools[1]!.ok).toBe(true);
  });

  test('the committed message: paired blocks, transport prompted, 2 rounds, trace.tools and trace.rounds', () => {
    const msg = committed();
    const blocks = msg.blocks ?? [];
    expect(blocks.map((b) => b.k)).toEqual(['tool_call', 'tool_result', 'text']);
    expect(blocks[0]).toEqual({ k: 'tool_call', id: 'call_0_0', name: 'search_history', args: '{"query":"брат"}' });
    expect(blocks[1]).toMatchObject({ k: 'tool_result', callId: 'call_0_0', name: 'search_history' });
    expect((blocks[1] as { text: string }).text).toContain(INNKEEPER_BROTHER);
    expect(blocks[2]).toEqual({ k: 'text', text: ANSWER });
    expect(msg.gen).toMatchObject({ kind: 'model', connection: 'local16k', model: 'magmell', transport: 'prompted', rounds: 2, finish: 'end' });
    // gen.usage sums the turn's calls; the trace's reported tokens are round 0's (the EMA sample).
    expect(msg.gen!.usage).toMatchObject({ inputTotal: 26_200, outputTotal: 60 });
    const trace = traceOf();
    expect(trace.tokens.reported).toBe(13_000);
    expect(trace.tools).toHaveLength(1);
    expect(trace.tools![0]).toMatchObject({ round: 0, callId: 'call_0_0', name: 'search_history', ok: true });
    expect(trace.tools![0]!.chars).toBeGreaterThan(0);
    expect(trace.rounds).toMatchObject({ n: 2, transport: 'prompted', ended: 'answer' });
    expect(trace.rounds!.room).toBeGreaterThan(0);
    // One call row per model call.
    expect(trace.calls).toHaveLength(2);
  });
});

describe('the note half and /search', () => {
  test('memoryAdd, then a preview of «А где сейчас её брата искать?» fires the note at depth 4 (src compendium)', () => {
    const { key } = s.memoryAdd(NOTE);
    expect(key).toBe('note:брат трактирщицы');
    expect(s.notes().map((n) => n.key)).toEqual([key]);
    const p = s.preview({ draft: DRAFT, explain: true });
    if (!p.ok) throw new Error(p.message);
    const verdict = p.verdicts!.find((v) => v.book === '@notes' && v.id === key);
    expect(verdict).toMatchObject({ fired: true, why: 'key', matched: ['брат'] });
    expect(p.trace.lore.fired).toContainEqual({ book: '@notes', id: key, why: 'key' });
    // A depth insert's src is `<rank source>:<entry label>` (lore/place.ts, prompt/depth.ts).
    const at = p.messages.findIndex((m) => m.src.startsWith('compendium:'));
    expect(at).toBeGreaterThan(0);
    expect(p.messages[at]).toMatchObject({ role: 'system', src: `compendium:@notes:${key}` });
    expect(text(p.messages[at]!)).toBe(`[Memory: ${NOTE.title}]\n${NOTE.content}`);
    // Depth 4: four chat messages after it, the draft the last of them; then only the reminder (D-96),
    // which depths never count.
    expect(p.messages.at(-1)!.src).toBe(REMIND_SRC);
    const after = p.messages.slice(at + 1, -1);
    expect(after).toHaveLength(4);
    expect(after.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(text(after.at(-1)!)).toContain(DRAFT);
    // The gap note still sits right after the greeting, numbered like search_history (#1 the greeting).
    const gap = p.messages.findIndex((m) => m.src === GAP_SRC);
    expect(gap).toBe(p.messages.findIndex((m) => m.src === 'history') + 1);
    const path = s.view().path;
    const [from, to] = [p.trace.trimmed!.from, p.trace.trimmed!.to].map((id) => path.findIndex((m) => m.id === id) + 1);
    expect(text(p.messages[gap]!)).toBe(gapText(from!, to!));
    // The history tools are still offered (the chat is still trimmed); the note fired, so no lore tools.
    expect(p.tools.map((t) => t.name)).toEqual(['read_history', 'search_history']);
  });

  test('SessionHandle.search «брат» finds #5 with Тихон in its snippet, outside the context', () => {
    const found = s.search({ query: 'брат' });
    const hit = found.hits.find((h) => h.n === INNKEEPER_MENTION);
    expect(hit).toBeDefined();
    expect(hit!).toMatchObject({ role: 'assistant', speaker: loadInnkeeper().character.name, inContext: false });
    expect(hit!.snippet).toContain('братом');
    expect(hit!.snippet).toContain(INNKEEPER_BROTHER);
    // Newest first: the answer (#201) and the question (#200) mention «брата» too; #5 is the oldest.
    expect(found.hits.map((h) => h.n)).toEqual([201, 200, INNKEEPER_MENTION]);
    expect(found.nextBefore).toBeNull();
  });
});
