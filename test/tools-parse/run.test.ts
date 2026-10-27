// Ported from Bunraku:src/stage/provider/tool-loop.test.ts@702d8120 (the per-call cases 6, 7, 8, 9, 10)
// and Bunraku:src/kit/loop/scheduler.test.ts@702d8120 (case 1), and
// RoleCall:apps/rc/src/lib/ai/narrator-engine/__tests__/tool-executor-repair.test.ts@fb8dc623e (2 cases).
// Copyright (C) 2026 Coneja-Chibi, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tools/run.ts runTools. Adapted from Bunraku: malformed JSON that jsonrepair now fixes is replaced
// by text it cannot read; `{"q": 7}` (now coerced to "7") by a value nothing coerces; Stop gives
// 'cancelled' outcomes instead of throwing; the cap is 4 000 by default (Bunraku 12 000) and the mark
// sits inside the limit; reads run in parallel (Bunraku ran them one by one).
import { describe, expect, test } from 'bun:test';
import { fakeClock } from '../helpers.ts';
import { HandleTable } from '../../src/tools/handles.ts';
import { cutMark, NO_ROOM_MARK, runTools, waterFill } from '../../src/tools/run.ts';
import { DEFAULT_TOOL_OUTPUT, type Tool, type ToolCall, type ToolCtx, type ToolOutput } from '../../src/tools/types.ts';

function ctxWith(signal: AbortSignal = new AbortController().signal): ToolCtx {
  return {
    view: {} as ToolCtx['view'],
    upTo: 'm1',
    names: { char: 'Mira', user: 'User' },
    lore: [],
    compendium: {} as ToolCtx['compendium'],
    handles: new HandleTable(),
    inContext: () => false,
    pageChars: 6000,
    signal,
    now: '2026-10-26T12:00:00.000Z',
    rng: () => 0.5,
  };
}

const LOOKUP_SCHEMA = { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string' } } };

/** Bunraku's fixture tool: `lookup {q}` → "found <q>"; records its calls. */
function lookup(name = 'lookup', extra: Partial<Tool> = {}): Tool & { seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  return {
    name,
    description: 'Look something up.',
    schema: LOOKUP_SCHEMA,
    effect: 'read',
    run: async (args) => {
      seen.push(args);
      return { text: `found ${String(args['q'])}`, summary: '1 hit' };
    },
    ...extra,
    seen,
  };
}

const call = (name: string, args: string, i = 0): ToolCall => ({ id: `call_0_${i}`, name, args, round: 0, via: 'native' });
const table = (...tools: Tool[]): Map<string, Tool> => new Map(tools.map((t) => [t.name, t]));
const run = (calls: ToolCall[], tools: Map<string, Tool>, opts: { roomChars?: number; ctx?: ToolCtx; clock?: () => Date } = {}) =>
  runTools({ calls, tools, ctx: opts.ctx ?? ctxWith(), roomChars: opts.roomChars ?? 1_000_000 }, opts.clock ?? fakeClock());

describe('runTools', () => {
  test('a valid call runs with its parsed arguments; the echo is rebuilt from them', async () => {
    const t = lookup();
    const [o] = await run([call('lookup', ' {"q": "door"} ')], table(t));
    expect(t.seen).toEqual([{ q: 'door' }]);
    expect(o).toEqual({
      call: call('lookup', ' {"q": "door"} '),
      echoName: 'lookup',
      echoArgs: '{"q":"door"}',
      ok: true,
      text: 'found door',
      summary: '1 hit',
      parsed: { q: 'door' },
      ms: 1000,
    });
  });

  test('outcomes in call order while the runs overlap (Kit scheduler case 1)', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const slow: Tool = {
      ...lookup('slow'),
      run: async () => {
        events.push('slow:start');
        await gate;
        events.push('slow:end');
        return { text: 'first', summary: '' };
      },
    };
    const fast: Tool = {
      ...lookup('fast'),
      run: async () => {
        events.push('fast:start');
        events.push('fast:end');
        releaseFirst();
        return { text: 'second', summary: '' };
      },
    };
    const out = await run([call('slow', '{"q":"a"}', 0), call('fast', '{"q":"b"}', 1)], table(slow, fast));
    expect(out.map((o) => o.text)).toEqual(['first', 'second']);
    expect(events).toEqual(['slow:start', 'fast:start', 'fast:end', 'slow:end']);
  });

  test('the same tool with the same canonical arguments runs once; both calls get the result', async () => {
    const t = lookup();
    const out = await run([call('lookup', '{"q":"x"}', 0), call('lookup', '{ "q" : "x" }', 1), call('lookup', '{"q":"y"}', 2)], table(t));
    expect(t.seen).toEqual([{ q: 'x' }, { q: 'y' }]);
    expect(out.map((o) => [o.call.id, o.text, o.ok])).toEqual([
      ['call_0_0', 'found x', true],
      ['call_0_1', 'found x', true],
      ['call_0_2', 'found y', true],
    ]);
  });

  test('unknown tool, unsafe name, schema failure: reported and never run (Bunraku case 7)', async () => {
    const t = lookup();
    const decoy = lookup('invalid_tool');
    const out = await run([call('lookup', '{"q":{}}', 0), call('nope', '{"q":"x"}', 1), call('bad name!', '{}', 2)], table(t, decoy));
    expect(t.seen).toEqual([]);
    expect(decoy.seen).toEqual([]); // an unsafe name never reaches a real tool called invalid_tool
    expect(out.map((o) => [o.echoName, o.ok, o.refused])).toEqual([
      ['lookup', false, 'bad_args'],
      ['nope', false, 'unknown_tool'],
      ['invalid_tool', false, 'unknown_tool'],
    ]);
    expect(out[0]!.text).toBe('Invalid arguments for lookup: "q" must be string, not object. Send one complete JSON object that matches the schema.');
    expect(out[0]!.echoArgs).toBe('{}');
    expect(out[1]!.text).toBe('Unknown tool "nope". The tools you can call: invalid_tool, lookup.');
    expect(out[1]!.echoArgs).toBe('{"q":"x"}');
    expect(out[2]!.text).toBe('Unknown tool "bad name!". The tools you can call: invalid_tool, lookup.');
    expect(out.map((o) => o.ms)).toEqual([0, 0, 0]);
  });

  test('arguments nothing can read are refused and echoed as {} (Bunraku case 6)', async () => {
    const t = lookup();
    const [o] = await run([call('lookup', 'Sure! {"q":"door"} done')], table(t));
    expect(t.seen).toEqual([]);
    expect(o).toMatchObject({ ok: false, refused: 'bad_args', echoArgs: '{}' });
    expect(o!.text).toContain('not valid JSON');
    expect(o!.parsed).toBeUndefined();
  });

  test("RoleCall: '{\"amount\": 2,}' is repaired before execution", async () => {
    const seen: unknown[] = [];
    const t: Tool = {
      name: 'vn_example',
      description: 'test',
      effect: 'read',
      schema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
      run: async (args) => {
        seen.push(args);
        return { text: 'ok', summary: '' };
      },
    };
    const [o] = await run([call('vn_example', '{"amount": 2,}')], table(t));
    expect(seen).toEqual([{ amount: 2 }]);
    expect(o).toMatchObject({ ok: true, repaired: ['jsonrepair'], echoArgs: '{"amount":2}' });
  });

  test('RoleCall: "<not-json>" does not run; the guidance asks for a complete JSON object, ≤ 500 chars', async () => {
    const t = { ...lookup('vn_example'), schema: { type: 'object', additionalProperties: false, properties: { amount: { type: 'number' } }, required: ['amount'] } };
    const [o] = await run([call('vn_example', '<not-json>')], table(t));
    expect(t.seen).toEqual([]);
    expect(o!.ok).toBe(false);
    expect(o!.text).toMatch(/complete JSON object/i);
    expect(o!.text.length).toBeLessThanOrEqual(500);
  });

  test('a tool that throws is reported, the others are untouched (Bunraku case 8)', async () => {
    const boom: Tool = { ...lookup('boom'), run: async () => Promise.reject(new Error('index unavailable')) };
    const sync: Tool = {
      ...lookup('sync'),
      run: () => {
        throw new Error(`x${'y'.repeat(1000)}`);
      },
    };
    const odd: Tool = { ...lookup('odd'), run: async () => Promise.reject('plain string') };
    const out = await run([call('boom', '{"q":"a"}', 0), call('lookup', '{"q":"b"}', 1), call('sync', '{"q":"c"}', 2), call('odd', '{"q":"d"}', 3)], table(boom, lookup(), sync, odd));
    expect(out[0]).toMatchObject({ ok: false, text: 'Tool boom failed: index unavailable', summary: 'failed' });
    expect(out[0]!.refused).toBeUndefined();
    expect(out[1]).toMatchObject({ ok: true, text: 'found b' });
    expect(out[2]!.text.length).toBe(300);
    expect(out[2]!.text).toStartWith('Tool sync failed: xyyy');
    expect(out[2]!.text).toEndWith('…');
    expect(out[3]!.text).toBe('Tool odd failed: plain string');
  });

  test('a tool reporting its own error is not ok but not refused', async () => {
    const t: Tool = { ...lookup(), run: async (): Promise<ToolOutput> => ({ text: 'No messages match.', summary: '0 hits', error: true }) };
    const [o] = await run([call('lookup', '{"q":"x"}')], table(t));
    expect(o).toMatchObject({ ok: false, text: 'No messages match.', summary: '0 hits' });
    expect(o!.refused).toBeUndefined();
  });

  test('Stop during a tool: cancelled, typed, paired (Bunraku case 9 adapted)', async () => {
    const ac = new AbortController();
    const waits: Tool = {
      ...lookup('waits'),
      run: (_args, ctx) =>
        new Promise<ToolOutput>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    // A tool that ignores its signal is not waited for.
    const deaf: Tool = { ...lookup('deaf'), run: () => new Promise<ToolOutput>(() => undefined) };
    const done: Tool = lookup('done');
    const p = run([call('waits', '{"q":"a"}', 0), call('deaf', '{"q":"b"}', 1), call('done', '{"q":"c"}', 2)], table(waits, deaf, done), { ctx: ctxWith(ac.signal) });
    await Bun.sleep(5);
    ac.abort();
    const out = await p;
    expect(out.map((o) => [o.text, o.ok, o.refused ?? null])).toEqual([
      ['cancelled', false, 'cancelled'],
      ['cancelled', false, 'cancelled'],
      ['found c', true, null], // settled before Stop: its result stands (§6.5: only running tools are cancelled)
    ]);
    expect(out[0]!.summary).toBe('cancelled');
  });

  test('a signal already aborted runs nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const t = lookup();
    const out = await run([call('lookup', '{"q":"a"}'), call('nope', '{}', 1)], table(t), { ctx: ctxWith(ac.signal) });
    expect(t.seen).toEqual([]);
    expect(out.map((o) => o.refused)).toEqual(['cancelled', 'unknown_tool']);
    expect(out[0]!.ms).toBe(0);
  });

  test('a long result is cut at 4 000 with the mark inside the limit; a tool may allow more (Bunraku case 10)', async () => {
    const long: Tool = { ...lookup('long'), run: async () => ({ text: 'x'.repeat(5000), summary: 'long' }) };
    const roomy: Tool = { ...lookup('roomy'), maxOutput: () => 6000, run: async () => ({ text: 'y'.repeat(5000), summary: 'roomy' }) };
    const [a, b] = await run([call('long', '{"q":"a"}', 0), call('roomy', '{"q":"b"}', 1)], table(long, roomy));
    expect(a!.text.length).toBe(DEFAULT_TOOL_OUTPUT);
    expect(a!.text).toEndWith(cutMark(4000));
    expect(a!.text).toBe('x'.repeat(4000 - cutMark(4000).length) + '\n[cut: the result was longer than 4000 characters]');
    expect(a!.cut).toBe(true);
    expect(b!.text).toBe('y'.repeat(5000));
    expect(b!.cut).toBeUndefined();
  });

  test('maxOutput reads the context', async () => {
    const paged: Tool = { ...lookup('paged'), maxOutput: (ctx) => ctx.pageChars + 1000, run: async () => ({ text: 'z'.repeat(8000), summary: '' }) };
    const [o] = await run([call('paged', '{"q":"a"}')], table(paged));
    expect(o!.text.length).toBe(7000);
  });

  test('room shares: split evenly, unused share passed on in call order', async () => {
    const small: Tool = { ...lookup('small'), run: async () => ({ text: 's'.repeat(100), summary: '' }) };
    const big: Tool = { ...lookup('big'), run: async () => ({ text: 'b'.repeat(5000), summary: '' }) };
    const out = await run([call('small', '{"q":"a"}', 0), call('big', '{"q":"b"}', 1), call('big', '{"q":"c"}', 2)], table(small, big), { roomChars: 3000 });
    // small: share 1000, uses 100; big #1: share floor(2900 / 2) = 1450; big #2: share 1450.
    expect(out.map((o) => o.text.length)).toEqual([100, 1450, 1450]);
    expect(out[1]!.text).toEndWith(cutMark(1450));
    // A refused call's error text is reserved first, whole; a duplicate runs once but its result goes
    // on the wire twice, so the run takes a share per call: both copies together fit the room.
    const refusedText = 'Unknown tool "nope". The tools you can call: big.';
    const dup = await run([call('big', '{"q":"b"}', 0), call('big', '{"q":"b"}', 1), call('nope', '{}', 2)], table(big), { roomChars: 3000 });
    const each = Math.floor((3000 - refusedText.length) / 2);
    expect(dup.map((o) => o.text)).toEqual(['b'.repeat(each - cutMark(each).length) + cutMark(each), dup[0]!.text, refusedText]);
    expect(dup.reduce((n, o) => n + o.text.length, 0)).toBeLessThanOrEqual(3000);
  });

  test('duplicates: the limit a run learns is one share per call, and every copy is charged', async () => {
    const seen: number[] = [];
    const sized: Tool = { ...lookup('sized'), run: async (_a, ctx) => (seen.push(ctx.limit!), { text: 'x'.repeat(ctx.limit!), summary: '' }) };
    const out = await run([call('sized', '{"q":"a"}', 0), call('sized', '{"q":"a"}', 1), call('sized', '{"q":"a"}', 2), call('sized', '{"q":"b"}', 3)], table(sized), { roomChars: 4000 });
    expect(seen.sort()).toEqual([1000, 1000]);
    expect(out.map((o) => [o.text.length, o.cut])).toEqual([[1000, undefined], [1000, undefined], [1000, undefined], [1000, undefined]]);
  });

  test('pre-run shares are water-filled: a run capped below its share leaves the rest to the others', async () => {
    const limits = new Map<string, number>();
    const capped: Tool = { ...lookup('capped'), maxOutput: () => 300, run: async (_a, ctx) => (limits.set('capped', ctx.limit!), { text: 'c'.repeat(300), summary: '' }) };
    const pager: Tool = { ...lookup('pager'), maxOutput: () => 9000, run: async (_a, ctx) => (limits.set('pager', ctx.limit!), { text: 'p'.repeat(ctx.limit!), summary: '' }) };
    const out = await run([call('capped', '{"q":"a"}', 0), call('pager', '{"q":"b"}', 1)], table(capped, pager), { roomChars: 3000 });
    expect(Object.fromEntries(limits)).toEqual({ capped: 300, pager: 2700 });
    expect(out.map((o) => [o.text.length, o.cut])).toEqual([[300, undefined], [2700, undefined]]);
    expect(waterFill(3000, [300, 9000], [1, 1])).toEqual([300, 2700]);
    expect(waterFill(3000, [300, 500, 9000], [1, 2, 1])).toEqual([300, 500, 1700]);
    expect(waterFill(3000, [9000, 9000], [1, 2])).toEqual([1000, 1000]);
    expect(waterFill(10, [9000], [0])).toEqual([0]);
  });

  test('a share too small for the mark gives the no-room mark alone, never an empty or unmarked cut', async () => {
    const big: Tool = { ...lookup('big'), run: async () => ({ text: 'b'.repeat(500), summary: '' }) };
    expect((await run([call('big', '{"q":"b"}')], table(big), { roomChars: 30 }))[0]).toMatchObject({ text: NO_ROOM_MARK, cut: true });
    expect((await run([call('big', '{"q":"b"}')], table(big), { roomChars: 0 }))[0]).toMatchObject({ text: NO_ROOM_MARK, cut: true });
    // A refused call's error line too, and every call of the round gets its own mark.
    const out = await run([call('big', '{"q":"b"}', 0), call('nope', '{}', 1)], table(big), { roomChars: 0 });
    expect(out.map((o) => [o.text, o.cut])).toEqual([[NO_ROOM_MARK, true], [NO_ROOM_MARK, true]]);
    expect(out[1]!.refused).toBe('unknown_tool');
    // A result that fits is never replaced.
    expect((await run([call('big', '{"q":"b"}')], table({ ...big, run: async () => ({ text: 'ok', summary: '' }) }), { roomChars: 2 }))[0]).toMatchObject({ text: 'ok' });
    expect(NO_ROOM_MARK.length).toBeLessThan(cutMark(0).length);
  });

  test('the cut never splits a surrogate pair', async () => {
    const emoji: Tool = { ...lookup('emoji'), run: async () => ({ text: '😀'.repeat(3000), summary: '' }) };
    const [o] = await run([call('emoji', '{"q":"b"}')], table(emoji));
    const head = o!.text.slice(0, -cutMark(4000).length);
    expect(head.length % 2).toBe(0);
    expect(head).toBe('😀'.repeat(head.length / 2));
    expect(o!.text.length).toBeLessThanOrEqual(4000);
  });

  test('ms per call from the injected clock', async () => {
    const t = lookup();
    const out = await run([call('lookup', '{"q":"a"}', 0), call('lookup', '{"q":"b"}', 1)], table(t), { clock: fakeClock('2026-10-26T12:00:00.000Z', 250) });
    // Both start (t0, t0+250) before either settles (t0+500, t0+750).
    expect(out.map((o) => o.ms)).toEqual([500, 500]);
  });

  test('repairs and the parsed value reach the outcome', async () => {
    const t = lookup();
    const [o] = await run([call('lookup', '[{"q": 5}]')], table(t));
    expect(o).toMatchObject({ ok: true, repaired: ['array_root', 'coerce:q'], parsed: { q: '5' }, echoArgs: '{"q":"5"}', text: 'found 5' });
  });

  test('no calls, no outcomes; a tool returning no text is a failure', async () => {
    expect(await run([], table(lookup()))).toEqual([]);
    const broken: Tool = { ...lookup('broken'), run: async () => ({}) as ToolOutput };
    expect((await run([call('broken', '{"q":"a"}')], table(broken)))[0]).toMatchObject({ ok: false, text: 'Tool broken failed: the tool returned no text' });
  });
});
