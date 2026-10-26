// M1b [D-50]: the token-estimate correction is derived from the path (reported prompt tokens over the
// estimate of what was sent, per model) and handed to assemble as tokenFactor, so a model whose
// earlier answers reported more tokens than estimated gets its history trimmed earlier.
import { describe, expect, test } from 'bun:test';
import { emaSamples, tokenFactorFor } from '../../src/engine/ema.ts';
import { EMA_START, emaFactor, estimateMessages } from '../../src/prompt/tokens.ts';
import type { Entry, EntryInput, Generation, MsgEntry, Trace } from '../../src/session/entries.ts';
import { buildTree } from '../../src/session/tree.ts';
import type { PathView } from '../../src/session/view.ts';
import { drain, entriesOf, MIRA, rig } from '../engine/kit.ts';
import { fakeConn, fakeProvider } from './fake.ts';

// ---- the samples (pure) ---------------------------------------------------------------------------

const trace = (estimated: number, extra: Partial<Trace> = {}): Trace => ({
  seed: 1,
  now: '2026-10-26T12:00:00.000Z',
  window: 8192,
  reserve: 64,
  tokens: { estimated },
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
  ...extra,
});
const gen = (model: string, inputTotal?: number): Generation => ({
  kind: 'model',
  connection: 'c',
  model,
  ...(inputTotal !== undefined ? { usage: { inputTotal } } : {}),
});

/** Entries with seq numbers, a TreeIndex, and a path view over the given ids. */
function fixture(list: EntryInput[], pathIds: string[]) {
  const entries = list.map((e, i) => ({ ...e, seq: i + 1 })) as unknown as Entry[];
  const idx = buildTree(entries);
  const path = pathIds.map((id) => {
    const m = idx.msgs.get(id)!;
    return { id, parent: m.parent, role: m.role, blocks: [], hidden: false, edited: false, swipe: { index: 0, count: 1 } };
  });
  return { idx, view: { path } as unknown as Pick<PathView, 'path'> };
}

const TS = '2026-10-26T12:00:00.000Z';
const user = (id: string, parent: string | null): EntryInput => ({ t: 'msg', ts: TS, id, parent, role: 'user', blocks: [{ k: 'text', text: 'u' }] });
const asst = (id: string, parent: string, g?: Generation, tr?: Trace): EntryInput =>
  ({ t: 'msg', ts: TS, id, parent, role: 'assistant', blocks: [{ k: 'text', text: 'a' }], ...(g ? { gen: g } : {}), ...(tr ? { trace: tr } : {}) }) as EntryInput;

// The fixture traces name no counter (M1 traces: 'chars'), so the samples are read for 'chars' (M2:
// only samples counted like the next prompt count).
describe('emaSamples', () => {
  test('answers of the bound model with both counts, oldest → newest; continue edits are their own calls', () => {
    const { idx, view } = fixture(
      [
        { t: 'msg', ts: TS, id: 'g', parent: null, role: 'assistant', gen: { kind: 'greeting' }, blocks: [{ k: 'text', text: 'hi' }] } as EntryInput,
        user('u1', 'g'),
        asst('a1', 'u1', gen('m', 120), trace(100)),
        user('u2', 'a1'),
        asst('a2', 'u2', gen('other', 500), trace(100)), // another model: skipped
        user('u3', 'a2'),
        asst('a3', 'u3', gen('m'), trace(100)), // no usage reported: skipped
        user('u4', 'a3'),
        asst('a4', 'u4', gen('m', 300), trace(200)),
        { t: 'edit', ts: TS, target: 'a4', reason: 'continue', blocks: [{ k: 'text', text: 'a more' }], gen: gen('m', 260), trace: trace(130) } as EntryInput,
        user('u5', 'a4'),
        asst('a5', 'u5', { kind: 'model', model: 'm', finish: 'interrupted' }, trace(90, { partial: true })), // recovered: skipped
      ],
      ['g', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5'],
    );
    expect(emaSamples(idx, view, 'm', 'chars')).toEqual([
      { estimated: 100, reported: 120 },
      { estimated: 200, reported: 300 },
      { estimated: 130, reported: 260 },
    ]);
    expect(tokenFactorFor(idx, view, 'm', 'chars')).toBeCloseTo(emaFactor([
      { estimated: 100, reported: 120 },
      { estimated: 200, reported: 300 },
      { estimated: 130, reported: 260 },
    ]), 12);
  });

  test('only the path counts, and no sample means the EMA start', () => {
    const { idx, view } = fixture(
      [user('u1', null), asst('a1', 'u1', gen('m', 400), trace(100)), asst('a1b', 'u1', gen('m', 100), trace(100))],
      ['u1', 'a1b'],
    );
    expect(emaSamples(idx, view, 'm', 'chars')).toEqual([{ estimated: 100, reported: 100 }]);
    const empty = fixture([user('u1', null)], ['u1']);
    expect(tokenFactorFor(empty.idx, empty.view, 'm', 'chars')).toBe(EMA_START);
  });
});

// ---- the engine hands the factor to assemble -----------------------------------------------------

const LINE = 'The lantern swings over the chart table while the wind worries at the shutters. ';
const BIG = LINE.repeat(4); // ~ 108 tokens a message

/**
 * A session on model `m` whose provider reports `ratio` × the estimate of every request as its prompt
 * tokens. Builds `exchanges` turns with a roomy window, then returns the session for one more turn.
 */
async function history(ratio: number, exchanges: number) {
  const provider = fakeProvider((req) => [
    { t: 'text', i: 0, d: BIG },
    { t: 'usage', u: { inputTotal: Math.round(estimateMessages(req.messages) * ratio), outputTotal: 40 } },
    { t: 'finish', reason: 'end', raw: 'stop' },
  ]);
  const conn = fakeConn('m', provider, { caps: { contextLength: 32768 } });
  const { engine, home } = await rig([], { connections: { m: conn } });
  const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'm', model: 'm', maxTokens: 64 } } } });
  for (let i = 0; i < exchanges; i++) {
    const v = s.send({ text: BIG, expectedVersion: s.version() }).version;
    const t = s.runTurn({ kind: 'reply', expectedVersion: v });
    await drain(t);
    if ((await t.result).type !== 'done') throw new Error('history turn failed');
  }
  return { engine, home, s, provider };
}

describe('tokenFactor reaches assemble', () => {
  test('a model that reported more tokens than estimated gets its history trimmed earlier', async () => {
    const exchanges = 12;
    const honest = await history(1.0, exchanges);
    const heavy = await history(2.0, exchanges);
    // Same history, same requests so far: nothing was trimmed in either.
    for (const h of [honest, heavy]) {
      const msgs = entriesOf(h.home, h.s.id).filter((e): e is MsgEntry => e.t === 'msg' && e.role === 'assistant' && e.turn !== undefined);
      expect(msgs.every((m) => m.trace?.trimmed === null)).toBe(true);
    }
    const lastEstimate = estimateMessages(honest.provider.requests.at(-1)!.messages);
    expect(estimateMessages(heavy.provider.requests.at(-1)!.messages)).toBe(lastEstimate);

    // A window that holds the next request at the honest factor (≈1.0) but not at the heavy one (≈2.0).
    const window = 64 + Math.ceil(1.4 * (lastEstimate + 300));
    const results: { sent: number; trimmed: unknown }[] = [];
    for (const h of [honest, heavy]) {
      h.s.configure({ window });
      const v = h.s.send({ text: BIG, expectedVersion: h.s.version() }).version;
      const t = h.s.runTurn({ kind: 'reply', expectedVersion: v });
      await drain(t);
      const out = await t.result;
      if (out.type !== 'done') throw new Error(`final turn: ${JSON.stringify(out)}`);
      const msg = entriesOf(h.home, h.s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
      results.push({ sent: h.provider.requests.at(-1)!.messages.length, trimmed: msg.trace?.trimmed });
      await h.engine.close();
    }
    const [a, b] = results;
    expect(a!.trimmed).toBeNull();
    expect(b!.trimmed).not.toBeNull();
    expect(b!.sent).toBeLessThan(a!.sent);
  });

  test('samples of another model do not move the factor', async () => {
    // Heavy reports from model m, then the binding switches to model n on the same connection: n starts
    // from the EMA start, so the same window that trims for m (heavy) holds n's request.
    const h = await history(2.0, 12);
    const lastEstimate = estimateMessages(h.provider.requests.at(-1)!.messages);
    const window = 64 + Math.ceil(1.4 * (lastEstimate + 300));
    h.s.configure({ window, roles: { narrator: { conn: 'm', model: 'n', maxTokens: 64 } } });
    const v = h.s.send({ text: BIG, expectedVersion: h.s.version() }).version;
    const t = h.s.runTurn({ kind: 'reply', expectedVersion: v });
    await drain(t);
    const out = await t.result;
    if (out.type !== 'done') throw new Error(`final turn: ${JSON.stringify(out)}`);
    const msg = entriesOf(h.home, h.s.id).find((e): e is MsgEntry => e.t === 'msg' && e.id === out.message.id)!;
    expect(msg.trace?.trimmed).toBeNull();
    await h.engine.close();
  });
});
