// M1b accounting (§11, D-51): one usage event per call with its cost — provider-reported, else the
// [prices."conn:model"] table, else null (never 0); gen.served from the provider's finish;
// trace.tokens.reported from usage.inputTotal.
import { describe, expect, test } from 'bun:test';
import type { EngineOptions, TurnOutcome } from '../../src/engine/api.ts';
import { priceFor, usageCost } from '../../src/engine/cost.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { drain, entriesOf, MIRA, rig } from '../engine/kit.ts';
import { answer, fakeConn, fakeProvider } from './fake.ts';
import type { StreamEv, Usage } from '../../src/providers/types.ts';

function expectDone(o: TurnOutcome): Extract<TurnOutcome, { type: 'done' }> {
  if (o.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(o)}`);
  return o;
}

type UsageEvent = Extract<Event, { type: 'usage' }>;
const usageEvents = (evs: readonly Event[]): UsageEvent[] => evs.filter((e): e is UsageEvent => e.type === 'usage');

const PRICES: NonNullable<EngineOptions['prices']> = {
  'or:vendor/model': { inPerM: 2, outPerM: 10, asOf: '2026-10-06' },
};

/** One reply on connection `or`, model `vendor/model`, answered with `events`. */
async function oneTurn(events: StreamEv[], prices?: EngineOptions['prices']) {
  const provider = fakeProvider(() => events);
  const conn = fakeConn('or', provider, { origin: 'https://openrouter.ai:443', local: false });
  const { engine, home } = await rig([], { connections: { or: conn }, ...(prices ? { extra: { prices } } : {}) });
  const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'vendor/model' } } } });
  const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
  const turn = s.runTurn({ kind: 'reply', expectedVersion: v });
  const evs = await drain(turn);
  const out = await turn.result;
  await engine.close();
  return { evs, out, home, sessionId: s.id };
}

describe('usage cost (§11)', () => {
  test('the provider-reported cost wins over the price table', async () => {
    const { evs } = await oneTurn(answer('Hi.', { usage: { inputTotal: 1000, outputTotal: 100, cost: 0.0042 } }), PRICES);
    expect(usageEvents(evs)).toEqual([
      expect.objectContaining({ agent: 'narrator', model: 'or:vendor/model', costUsd: 0.0042, priceSource: 'provider' }),
    ]);
  });

  test('else the price table: (in × inPerM + out × outPerM) / 1e6', async () => {
    const { evs } = await oneTurn(answer('Hi.', { usage: { inputTotal: 1000, outputTotal: 100 } }), PRICES);
    const [u] = usageEvents(evs);
    expect(u!.priceSource).toBe('table');
    expect(u!.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 12);
    expect(u!.usage).toEqual({ inputTotal: 1000, outputTotal: 100 });
  });

  test('else null, never 0', async () => {
    const { evs } = await oneTurn(answer('Hi.', { usage: { inputTotal: 1000, outputTotal: 100 } }));
    expect(usageEvents(evs)).toEqual([expect.objectContaining({ costUsd: null, priceSource: 'none' })]);
  });

  test('usage reported in pieces is merged into one event, priced as a whole', async () => {
    const events: StreamEv[] = [
      { t: 'usage', u: { inputTotal: 500 } },
      { t: 'text', i: 0, d: 'Hi.' },
      { t: 'finish', reason: 'end', raw: 'stop' },
      { t: 'usage', u: { outputTotal: 50 } },
    ];
    const { evs } = await oneTurn(events, PRICES);
    const list = usageEvents(evs);
    expect(list).toHaveLength(1);
    expect(list[0]!.usage).toEqual({ inputTotal: 500, outputTotal: 50 });
    expect(list[0]!.costUsd).toBeCloseTo((500 * 2 + 50 * 10) / 1e6, 12);
  });

  test('a call that reports no usage sends no usage event', async () => {
    const { evs } = await oneTurn(answer('Hi.'), PRICES);
    expect(usageEvents(evs)).toEqual([]);
  });
});

describe('usageCost (pure)', () => {
  const row = { inPerM: 3, outPerM: 15, asOf: '2026-10-01' };
  test('provider cost, including a reported 0', () => {
    expect(usageCost({ cost: 0.5 }, row)).toEqual({ costUsd: 0.5, priceSource: 'provider' });
    expect(usageCost({ cost: 0, inputTotal: 10, outputTotal: 1 }, row)).toEqual({ costUsd: 0, priceSource: 'provider' });
  });
  test('table needs every priced count; a free side needs none', () => {
    expect(usageCost({ inputTotal: 2_000_000, outputTotal: 1_000_000 }, row)).toEqual({ costUsd: 21, priceSource: 'table' });
    expect(usageCost({ inputTotal: 1000 }, row)).toEqual({ costUsd: null, priceSource: 'none' });
    expect(usageCost({ outputTotal: 1_000_000 }, { inPerM: 0, outPerM: 4, asOf: 'x' })).toEqual({ costUsd: 4, priceSource: 'table' });
  });
  test('no row, a broken row or a non-finite cost: null', () => {
    const u: Usage = { inputTotal: 1, outputTotal: 1 };
    expect(usageCost(u, undefined)).toEqual({ costUsd: null, priceSource: 'none' });
    expect(usageCost(u, { inPerM: Number.NaN, outPerM: 1, asOf: 'x' })).toEqual({ costUsd: null, priceSource: 'none' });
    expect(usageCost({ ...u, cost: Number.POSITIVE_INFINITY }, undefined)).toEqual({ costUsd: null, priceSource: 'none' });
  });
  test('priceFor looks up "conn:model" by own keys only', () => {
    expect(priceFor(PRICES, 'or', 'vendor/model')).toEqual(PRICES['or:vendor/model']!);
    expect(priceFor(PRICES, 'or', 'other')).toBeUndefined();
    expect(priceFor({}, 'constructor', '')).toBeUndefined();
    expect(priceFor(undefined, 'or', 'vendor/model')).toBeUndefined();
  });
});

describe('gen.served and trace.tokens.reported', () => {
  test('the model the provider reports serving goes to gen.served; inputTotal to trace.tokens.reported', async () => {
    const { out, home, sessionId } = await oneTurn(answer('Hi.', { usage: { inputTotal: 321, outputTotal: 7 }, model: 'vendor/model-2026-10-01' }));
    const done = expectDone(out);
    expect(done.message.gen).toMatchObject({ connection: 'or', model: 'vendor/model', served: 'vendor/model-2026-10-01' });
    expect(done.message.gen?.usage).toEqual({ inputTotal: 321, outputTotal: 7 });
    const msg = entriesOf(home, sessionId).find((e): e is MsgEntry => e.t === 'msg' && e.id === done.message.id)!;
    expect(msg.trace?.tokens.reported).toBe(321);
    expect(msg.trace?.tokens.estimated).toBeGreaterThan(0);
  });

  test('nothing reported: no served, no reported', async () => {
    const { out, home, sessionId } = await oneTurn(answer('Hi.'));
    const done = expectDone(out);
    expect(done.message.gen?.served).toBeUndefined();
    const msg = entriesOf(home, sessionId).find((e): e is MsgEntry => e.t === 'msg' && e.id === done.message.id)!;
    expect(msg.trace?.tokens.reported).toBeUndefined();
  });
});
