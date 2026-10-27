// M4 (D-101): /usage adds every trace.calls row of an agent other than the narrator, priced by the
// row's own model; the narrator's numbers stay its generations'. directorBinding (the banner, /director).
import { describe, expect, test } from 'bun:test';
import { directorBinding, journalOf, pathUsage } from '../../src/cli/repl-journal.ts';
import { DEFAULT_SESSION_CONFIG, type Entry, type Generation, type SessionHeader, type Trace } from '../../src/session/entries.ts';
import { traceWith } from '../cli-m4/fixtures.ts';

const TS = '2026-10-26T12:00:00.000Z';
const header: SessionHeader = {
  t: 'session',
  v: 1,
  id: 's_00000001',
  created: TS,
  cast: { character: { name: 'Mira', description: '', greetings: ['Hi'] } },
  config: DEFAULT_SESSION_CONFIG,
};
const gen = (over: Partial<Generation> = {}): Generation => ({ kind: 'model', connection: 'local', model: 'q', finish: 'end', ...over });
let seq = 0;
const msg = (id: string, parent: string | null, role: 'user' | 'assistant', extra: Partial<Entry> = {}): Entry =>
  ({ t: 'msg', seq: ++seq, ts: TS, id, parent, role, blocks: [{ k: 'text', text: id }], ...extra }) as Entry;
type Call = Trace['calls'][number];
const call = (agent: string, model: string, usage?: Call['usage'], n = 0): Call => ({ callKey: `t:${agent}:${n}`, agent, model, ms: 100, ...(usage ? { usage } : {}) });

/**
 * u1 → a1 (narrator 1000/100 on local:q; director 800/200 on dir:big, plus a retried call without
 * usage) → u2 → a2 (narrator; director with a provider cost) + a continue (narrator only); a1x: a
 * swipe of a1 off the path, with its own director call.
 */
function sample(): Entry[] {
  seq = 0;
  const n1 = call('narrator', 'local:q', { inputTotal: 1000, outputTotal: 100 });
  return [
    msg('u1', null, 'user'),
    msg('a1x', 'u1', 'assistant', { gen: gen({ usage: { inputTotal: 5, outputTotal: 5 } }), trace: traceWith([call('director', 'dir:big', { inputTotal: 9999, outputTotal: 9999 })]) }),
    msg('a1', 'u1', 'assistant', {
      gen: gen({ usage: { inputTotal: 1000, outputTotal: 100 } }),
      trace: traceWith([call('director', 'dir:big', undefined, 0), call('director', 'dir:big', { inputTotal: 800, outputTotal: 200 }, 1), n1]),
    }),
    msg('u2', 'a1', 'user'),
    msg('a2', 'u2', 'assistant', {
      gen: gen({ usage: { inputTotal: 1200, outputTotal: 50 } }),
      trace: traceWith([call('director', 'dir:small', { inputTotal: 300, outputTotal: 30, cost: 0.5 }), call('narrator', 'local:q', { inputTotal: 1200, outputTotal: 50 })]),
    }),
    {
      t: 'edit',
      seq: ++seq,
      ts: TS,
      target: 'a2',
      reason: 'continue',
      blocks: [{ k: 'text', text: 'a2 more' }],
      gen: gen({ usage: { inputTotal: 1300, outputTotal: 20 } }),
      trace: traceWith([call('narrator', 'local:q', { inputTotal: 1300, outputTotal: 20 })]),
    },
  ];
}

const PATH = ['u1', 'a1', 'u2', 'a2'];

describe('pathUsage with Director calls', () => {
  test('the narrator counts its generations as before; the Director its calls, priced by each row\'s model', () => {
    const j = journalOf(header, sample());
    const prices = { 'local:q': { inPerM: 1, outPerM: 2 }, 'dir:big': { inPerM: 10, outPerM: 20 } };
    const u = pathUsage(j, PATH, prices);
    // Narrator: a1, a2 and the continue — never its own trace.calls rows (no double count).
    expect({ calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, noUsage: u.noUsage, unpriced: u.unpriced }).toEqual({
      calls: 3,
      inputTokens: 3500,
      outputTokens: 170,
      noUsage: 0,
      unpriced: 0,
    });
    expect(u.costUsd).toBeCloseTo((3500 * 1 + 170 * 2) / 1e6, 12);
    // Director: three calls on the path (the swipe a1x is off it): one without usage, one priced from
    // the table (dir:big), one with the provider's own cost (dir:small has no price row).
    const d = u.agents?.director;
    expect(d).toBeDefined();
    expect({ calls: d!.calls, inputTokens: d!.inputTokens, outputTokens: d!.outputTokens, noUsage: d!.noUsage, unpriced: d!.unpriced }).toEqual({
      calls: 3,
      inputTokens: 1100,
      outputTokens: 230,
      noUsage: 1,
      unpriced: 0,
    });
    expect(d!.costUsd).toBeCloseTo((800 * 10 + 200 * 20) / 1e6 + 0.5, 12);
    expect(Object.keys(u.agents!)).toEqual(['director']);
  });

  test('unpriced Director calls: counted apart, cost null when none could be priced (never 0)', () => {
    const j = journalOf(header, sample());
    const u = pathUsage(j, ['u1', 'a1'], { 'local:q': { inPerM: 1, outPerM: 2 } });
    expect(u.agents!.director).toEqual({ calls: 2, inputTokens: 800, outputTokens: 200, noUsage: 1, costUsd: null, unpriced: 1 });
    // The narrator's numbers do not move.
    expect(u.costUsd).toBeCloseTo(1200 / 1e6, 12);
  });

  test('no other agent on the path: no agents key, the M3 summary exactly', () => {
    seq = 0;
    const j = journalOf(header, [msg('u', null, 'user'), msg('a', 'u', 'assistant', { gen: gen({ usage: { inputTotal: 10, outputTotal: 1 } }), trace: traceWith([call('narrator', 'local:q')]) })]);
    expect(pathUsage(j, ['u', 'a'], {})).toEqual({ calls: 1, inputTokens: 10, outputTokens: 1, noUsage: 0, costUsd: null, unpriced: 1 });
  });

  test('a stopped or recovered answer whose trace has Director rows but whose gen has no usage', () => {
    seq = 0;
    const j = journalOf(header, [
      msg('u', null, 'user'),
      msg('a', 'u', 'assistant', { gen: { kind: 'model', finish: 'interrupted' }, trace: { ...traceWith([call('director', 'dir:big', { inputTotal: 50, outputTotal: 5 })]), partial: true } }),
    ]);
    const u = pathUsage(j, ['u', 'a'], { 'dir:big': { inPerM: 1, outPerM: 1 } });
    expect(u.noUsage).toBe(1);
    expect(u.agents!.director!.costUsd).toBeCloseTo(55 / 1e6, 12);
  });
});

describe('directorBinding', () => {
  test("follows the narrator (whole binding) when unset or 'narrator'; else its own", () => {
    const narrator = { conn: 'local', model: 'q', fallback: { conn: 'alt', model: 'r' } };
    expect(directorBinding({ narrator })).toEqual({ conn: 'local', model: 'q', follows: true });
    expect(directorBinding({ narrator, director: 'narrator' })).toEqual({ conn: 'local', model: 'q', follows: true });
    expect(directorBinding({ narrator, director: { conn: 'dir', model: 'big' } })).toEqual({ conn: 'dir', model: 'big', follows: false });
  });
});
