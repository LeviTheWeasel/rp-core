// M2 [D-50]: the EMA token correction learns only from calls counted the way the next prompt is
// counted (trace.tokens.counter; absent = 'chars'): a ratio measured against chars/3 says nothing
// about o200k.
import { describe, expect, test } from 'bun:test';
import { counterOf, emaSamples, tokenFactorFor } from '../../src/engine/ema.ts';
import { charsEstimate, CHARS_COUNTER, EMA_START, estimateMessages, type TokenCounter } from '../../src/prompt/tokens.ts';
import type { Entry, EntryInput, Generation, MsgEntry, Trace } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { buildTree } from '../../src/session/tree.ts';
import type { PathView } from '../../src/session/view.ts';
import { fakeConn, fakeProvider } from '../engine-m1b/fake.ts';
import { drain, entriesOf, MIRA, rig } from './kit.ts';

const TS = '2026-10-26T12:00:00.000Z';
const trace = (estimated: number, counter?: 'chars' | 'o200k'): Trace => ({
  seed: 1,
  now: TS,
  window: 8192,
  reserve: 64,
  tokens: { estimated, ...(counter ? { counter } : {}) },
  blocks: [],
  lore: { fired: [], cut: [], budget: 0 },
  recap: { ids: [], arcs: [], boundary: null },
  prefill: null,
  macros: { unknown: [] },
  trimmed: null,
  calls: [],
  agents: {},
  presetHash: 'h',
  loreHashes: {},
});
const gen = (inputTotal: number): Generation => ({ kind: 'model', connection: 'c', model: 'm', usage: { inputTotal } });
const user = (id: string, parent: string | null): EntryInput => ({ t: 'msg', ts: TS, id, parent, role: 'user', blocks: [{ k: 'text', text: 'u' }] });
const asst = (id: string, parent: string, g: Generation, tr: Trace): EntryInput =>
  ({ t: 'msg', ts: TS, id, parent, role: 'assistant', blocks: [{ k: 'text', text: 'a' }], gen: g, trace: tr }) as EntryInput;

describe('samples by counter', () => {
  const list: EntryInput[] = [
    user('u1', null),
    asst('a1', 'u1', gen(120), trace(100)), // M1 trace: chars
    user('u2', 'a1'),
    asst('a2', 'u2', gen(150), trace(100, 'o200k')),
    user('u3', 'a2'),
    asst('a3', 'u3', gen(180), trace(100, 'chars')),
    { t: 'edit', ts: TS, target: 'a3', reason: 'continue', blocks: [{ k: 'text', text: 'a more' }], gen: gen(260), trace: trace(130, 'o200k') } as EntryInput,
  ];
  const entries = list.map((e, i) => ({ ...e, seq: i + 1 })) as unknown as Entry[];
  const idx = buildTree(entries);
  const view = {
    path: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'].map((id) => ({ id, parent: idx.msgs.get(id)!.parent, role: idx.msgs.get(id)!.role, blocks: [], hidden: false, edited: false, swipe: { index: 0, count: 1 } })),
  } as unknown as Pick<PathView, 'path'>;

  test('an absent counter is chars', () => {
    expect(counterOf(trace(1))).toBe('chars');
    expect(counterOf(trace(1, 'o200k'))).toBe('o200k');
  });

  test('only the samples of the counter in use; continue edits by their own counter', () => {
    expect(emaSamples(idx, view, 'm', 'chars')).toEqual([
      { estimated: 100, reported: 120 },
      { estimated: 100, reported: 180 },
    ]);
    expect(emaSamples(idx, view, 'm', 'o200k')).toEqual([
      { estimated: 100, reported: 150 },
      { estimated: 130, reported: 260 },
    ]);
  });

  test('a counter with no samples on the path starts from EMA_START', () => {
    const onlyChars = buildTree((list.slice(0, 2).map((e, i) => ({ ...e, seq: i + 1 })) as unknown) as Entry[]);
    const v = { path: view.path.slice(0, 2) } as Pick<PathView, 'path'>;
    expect(tokenFactorFor(onlyChars, v, 'm', 'o200k')).toBe(EMA_START);
    expect(tokenFactorFor(onlyChars, v, 'm', 'chars')).toBeGreaterThan(EMA_START);
  });
});

// ---- end to end: a history counted one way does not move the factor of another ------------------

const LINE = 'The lantern swings over the chart table while the wind worries at the shutters. ';
const BIG = LINE.repeat(4);

/** chars/3 numbers under another id: the same estimates, a different counter as far as the EMA goes. */
const OTHER: TokenCounter = { id: 'o200k', count: (text) => charsEstimate(text) };

describe('the engine reads samples of its own counter', () => {
  test('heavy reports counted as chars trim a chars turn, not a turn counted otherwise', async () => {
    // 12 exchanges whose provider reports 2× the chars estimate.
    const provider = fakeProvider((req) => [
      { t: 'text', i: 0, d: BIG },
      { t: 'usage', u: { inputTotal: Math.round(estimateMessages(req.messages, CHARS_COUNTER) * 2), outputTotal: 40 } },
      { t: 'finish', reason: 'end', raw: 'stop' },
    ]);
    const conn = fakeConn('m', provider, { caps: { contextLength: 32768 } });
    const first = await rig([], { connections: { m: conn } });
    const s = first.engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'm', model: 'm', maxTokens: 64 } } } });
    for (let i = 0; i < 12; i++) {
      const v = s.send({ text: BIG, expectedVersion: s.version() }).version;
      const t = s.runTurn({ kind: 'reply', expectedVersion: v });
      await drain(t);
      if ((await t.result).type !== 'done') throw new Error('history turn failed');
    }
    const committed = entriesOf(first.home, s.id).filter((e): e is MsgEntry => e.t === 'msg' && e.role === 'assistant' && e.turn !== undefined);
    expect(committed.every((m) => m.trace?.tokens.counter === 'chars')).toBe(true);
    const lastEstimate = estimateMessages(provider.requests.at(-1)!.messages, CHARS_COUNTER);
    const window = 64 + Math.ceil(1.4 * (lastEstimate + 300));
    s.configure({ window });
    const sid = s.id;
    const tree = buildTree(readSessionFile(first.home, sid).entries);
    expect(tokenFactorFor(tree, s.view(), 'm', 'chars')).toBeGreaterThan(1.8);
    expect(tokenFactorFor(tree, s.view(), 'm', 'o200k')).toBe(EMA_START);
    await first.engine.close();

    /** One more turn on the same history with the engine counting by `counter`. */
    const finalTurn = async (counter: TokenCounter): Promise<unknown> => {
      const again = await rig([], { home: first.home, connections: { m: conn }, extra: { counter } });
      const s2 = again.engine.session(sid);
      const v = s2.send({ text: BIG, expectedVersion: s2.version() }).version;
      const t = s2.runTurn({ kind: 'reply', expectedVersion: v });
      await drain(t);
      const out = await t.result;
      if (out.type !== 'done') throw new Error(`final turn: ${JSON.stringify(out)}`);
      const msg = entriesOf(first.home, sid).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
      await again.engine.close();
      return msg.trace?.trimmed;
    };
    // Counted as chars, the heavy samples are read: the history is trimmed.
    expect(await finalTurn(CHARS_COUNTER)).not.toBeNull();
    // Counted otherwise they are not, and the EMA start fits the window even with one more exchange.
    expect(await finalTurn(OTHER)).toBeNull();
  });
});

describe('the prefill is prompt too: an exact server teaches no bias (M2 fix)', () => {
  // Regression: trace.tokens.estimated counted the messages only. On a continue sent as a prefill
  // (Ollama, llama.cpp, the scripted provider) the whole answer moves into the prefill, which the
  // server counts as prompt, so every continue taught the EMA a ratio well above 1.
  test('a reply with a preset prefill, then a continue: every sample has ratio exactly 1', async () => {
    const { SCRIPT_CAPS } = await import('../../src/providers/scripted.ts');
    const { estimateTokens, MESSAGE_OVERHEAD_TOKENS } = await import('../../src/prompt/tokens.ts');
    const { foldView } = await import('../../src/session/fold.ts');
    const { BUILTIN_PRESET } = await import('../../src/formats/native.ts');
    const { session, run, writeLibrary } = await import('./kit.ts');
    const requests: { prefill?: string }[] = [];
    const replies = ['She unrolls the chart across the table, weighting its corners with tin cups. '.repeat(30), ' Then she points north.'];
    let i = 0;
    const exact = {
      async *stream(req: import('../../src/providers/types.ts').ModelRequest) {
        requests.push(req);
        // The server's tokenizer IS chars/3, and it counts the messages and the assistant prefill.
        const prompt = estimateMessages(req.messages, CHARS_COUNTER) + (req.prefill ? estimateTokens(req.prefill, CHARS_COUNTER) + MESSAGE_OVERHEAD_TOKENS : 0);
        yield { t: 'text' as const, i: 0, d: replies[i++] ?? 'x' };
        yield { t: 'usage' as const, u: { inputTotal: prompt, outputTotal: 5 } };
        yield { t: 'finish' as const, reason: 'end' as const, raw: 'stop' };
      },
    };
    const r = await rig([], { connections: { exact: { id: 'exact', provider: exact, caps: SCRIPT_CAPS, origin: 'script:exact', local: true } } });
    const p = JSON.parse(JSON.stringify(BUILTIN_PRESET));
    p.prefill = '*She looks up from the map.*';
    writeLibrary(r.home, 'presets', 'pf', p);
    const { s } = session(r.engine, [], 'Show me the map.', { preset: 'pf', roles: { narrator: { conn: 'exact', model: 'm' } } });
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    await run(s.runTurn({ kind: 'continue', expectedVersion: s.version() }));
    expect(requests.map((q) => (q.prefill ?? '').length > 0)).toEqual([true, true]);
    const entries = entriesOf(r.home, s.id);
    const tree = buildTree(entries);
    const view = foldView(s.header(), entries, tree);
    const samples = emaSamples(tree, view, 'm', 'chars');
    expect(samples).toHaveLength(2);
    for (const x of samples) expect(x.reported / x.estimated).toBe(1);
    await r.engine.close();
  });
});
