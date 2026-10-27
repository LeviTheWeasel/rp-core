// M4 CLI output (D-113, D-101): /director show (renderDirector, directiveSummary), the banner's
// Director part, /usage rows per agent, and the Director's stderr line of `send`'s text mode.
import { describe, expect, test } from 'bun:test';
import { emptyState } from '../../src/agents/director/state.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { createTextRenderer, describeEvent, directorLine } from '../../src/cli/render.ts';
import { bannerLine, directiveSummary, makeStyle, renderDirector, renderUsage, sideLine, stripAnsi, type DirectorShow } from '../../src/cli/repl-render.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import type { MessageView } from '../../src/session/view.ts';
import { recordFor, richState } from '../cli-m4/fixtures.ts';

const plain = makeStyle(false);
const ansi = makeStyle(true);
const ev = (body: EventBody): Event => ({ sessionId: 's_1', ts: '2026-10-26T12:00:00.000Z', ...body }) as Event;
const dir = (over: Partial<Extract<EventBody, { type: 'director' }>> = {}): EventBody => ({ type: 'director', turnId: 't_1', status: 'planned', ...over });

const show = (over: Partial<DirectorShow> = {}): DirectorShow => {
  const state = richState();
  return {
    enabled: true,
    binding: { conn: 'script', model: 'default', follows: true },
    profile: 'auto',
    style: 'the-balanced',
    state,
    record: recordFor(state),
    from: 'a1b2c3d4',
    invalid: 0,
    ...over,
  };
};

describe('/director show', () => {
  test('every section of a rich state, ages from the state turn, OVERDUE and ripe seeds, the directive as sent', () => {
    expect(renderDirector(show(), plain)).toBe(
      [
        "director on · script:default (the narrator's model) · profile auto · style the-balanced",
        'turn 40 · planned on a1b2c3d4 · structured · full · script:default · 2 skipped',
        'chapter 2 "The Flood" · active · 10 turns · 1 completed',
        'arcs: 2 live, 1 finished',
        '  arc-1 "The Locked Room" · building · active · medium · age 8',
        '    next: Someone knocks from the inside. (by turn 42)',
        '  arc-3 "Old Debts" · seeding · background · long · age 35 · stale: 20 turns without progress',
        '    no next beat',
        'seeds: 2 waiting, 1 paid off',
        '  seed-2 "A cracked bell" · long · age 5/10 · 1 reinforcement',
        '  seed-6 "The red ribbon" · epic · age 35/25 OVERDUE · 2 reinforcements · ripe for payoff',
        'hidden arcs: 1 live, 1 surfaced or resolved',
        '  hidden-8 "The Ledger Conspiracy" · approaching_player · conspiracy · age 4/5 · 2 clues',
        'intentions:',
        '  must · next: Let the red ribbon turn up again.',
        'last directive (turn 40, as sent) mood "tense" · pace fast · goal "The keeper lies about the letter." · 1 arc direction · 2 character beats · hook "A knock at the door."',
      ].join('\n'),
    );
  });

  test('no record on the path: "The Director has not planned yet."; unreadable records are counted', () => {
    const out = renderDirector(show({ state: emptyState(), record: undefined, from: undefined, invalid: 2 }), plain);
    expect(out).toBe(
      ["director on · script:default (the narrator's model) · profile auto · style the-balanced", '(2 unreadable Director records on this path skipped)', 'The Director has not planned yet.'].join('\n'),
    );
  });

  test('off: says so and how to turn it on; the kept plan still shows', () => {
    const out = renderDirector(show({ enabled: false }), plain);
    expect(out.split('\n')[0]).toBe('director off (/director on lets it plan every reply; the plan below is kept meanwhile)');
    expect(out).toContain('turn 40 · planned');
    const never = renderDirector(show({ enabled: false, state: emptyState(), record: undefined }), plain);
    expect(never).toBe('director off (/director on lets it plan every reply; the plan below is kept meanwhile)\nThe Director has not planned yet.');
  });

  test('a failed turn: failed (code), and the last directive the state kept (the authored one)', () => {
    const state = richState();
    const out = renderDirector(show({ state, record: recordFor(state, { ok: false, code: 'timeout', directive: undefined, skipped: [] }) }), plain);
    expect(out).toContain('turn 40 · failed (timeout) on a1b2c3d4 · structured · full · script:default');
    expect(out).toContain('last directive (turn 40) mood "tense" · pace fast · goal "The keeper lies about the letter."');
    expect(out).not.toContain('as sent');
  });

  test('a reused plan names the reply it came from; a binding of its own has no "(the narrator\'s model)"', () => {
    const state = richState();
    const out = renderDirector(show({ binding: { conn: 'dir', model: 'big', follows: false }, record: recordFor(state, { reusedFrom: 'feedbeef' }) }), plain);
    expect(out.split('\n')[0]).toBe('director on · dir:big · profile auto · style the-balanced');
    expect(out).toContain('turn 40 · reused (the plan of feedbeef) on a1b2c3d4');
  });

  test('an early state: no chapter, no arcs, no seeds, no directive', () => {
    const state = { ...emptyState(), turn: 1 };
    const out = renderDirector(show({ state, record: recordFor(state, { ok: false, code: 'no_output', directive: undefined, skipped: [], transport: undefined, profile: undefined, model: undefined }), from: undefined }), plain);
    expect(out.split('\n').slice(1)).toEqual(['turn 1 · failed (no_output)', 'chapter none yet', 'arcs: none', 'seeds: none', 'hidden arcs: none', 'no directive yet']);
  });

  test('colour: labels dim, the header bold, OVERDUE and failures yellow; plain text underneath', () => {
    const state = richState();
    const out = renderDirector(show({ record: recordFor(state, { ok: false, code: 'timeout', directive: undefined }) }), ansi);
    expect(out).toContain('\x1b[2marcs:\x1b[22m');
    expect(out).toContain('\x1b[33mOVERDUE\x1b[39m');
    expect(out).toContain('\x1b[33mfailed (timeout)\x1b[39m');
    expect(stripAnsi(out)).toBe(renderDirector(show({ record: recordFor(state, { ok: false, code: 'timeout', directive: undefined }) }), plain));
  });
});

describe('directiveSummary', () => {
  test('the fields a directive sets, in one line; medium pace left out; empty → (empty)', () => {
    expect(directiveSummary({ pacing: 'medium' })).toBe('(empty)');
    expect(
      directiveSummary({
        pacing: 'slow',
        mood: 'quiet',
        sceneGuidance: { setting: 'the lighthouse', tension_level: 6.6 },
        include: { characters: ['Yan'], themes: ['trust', 'debt'] },
        avoid: { revelations: ['the letter'] },
        dialogueGuidance: [{ character: 'Yan', tone: 'dry' }],
        callbacks: [{ reference: 'the bell', instruction: 'ring once' }],
      }),
    ).toBe('mood "quiet" · pace slow · setting "the lighthouse" · tension 7/10 · 1 dialogue note · 1 callback · 3 things to include · 1 thing to avoid');
    const long = directiveSummary({ pacing: 'medium', narrativeGoal: 'x'.repeat(100) });
    expect(long).toBe(`goal "${'x'.repeat(39)}…"`);
  });
});

describe('banner', () => {
  const head = { id: 's_4fa2', title: 'Mira' };
  const local = { conn: 'local', model: 'qwen3-14b' };
  test('the Director part only while it is enabled, after the narrator part', () => {
    expect(bannerLine(head, local, 16384, plain, undefined, 'prompted', { conn: 'dir', model: 'big', profile: 'auto' })).toBe(
      'session s_4fa2 · Mira · narrator local:qwen3-14b (tools: prompted) · director dir:big (auto) · ctx 16384',
    );
    expect(bannerLine(head, local, 16384, plain, undefined, 'prompted', null)).toBe('session s_4fa2 · Mira · narrator local:qwen3-14b (tools: prompted) · ctx 16384');
    expect(bannerLine(head, local, 16384, plain, undefined, 'prompted')).toBe(bannerLine(head, local, 16384, plain, undefined, 'prompted', null));
  });
});

describe('/usage with other agents', () => {
  const narrator = { calls: 2, inputTokens: 2000, outputTokens: 200, noUsage: 0, costUsd: 0.0024, unpriced: 0 };
  test('without agent rows: the M3 line, unchanged', () => {
    expect(renderUsage(narrator)).toBe('2 generations on this path · in 2000 tok · out 200 tok · cost $0.0024');
    expect(renderUsage({ ...narrator, agents: {} })).toBe(renderUsage(narrator));
  });

  test('with the Director: a row per agent and the total; notes name the agent', () => {
    const director = { calls: 3, inputTokens: 900, outputTokens: 300, noUsage: 1, costUsd: 0.0015, unpriced: 1 };
    expect(renderUsage({ ...narrator, agents: { director } })).toBe(
      [
        'usage on this path:',
        '  narrator  2 generations · in 2000 tok · out 200 tok · cost $0.0024',
        '  director  3 calls · in 900 tok · out 300 tok · cost $0.0015',
        '  total     in 2900 tok · out 500 tok · cost $0.0039',
        '  (1 director call(s) without usage from the server; 1 director call(s) without a price ([prices."conn:model"] in config.toml))',
      ].join('\n'),
    );
  });

  test('nothing priced anywhere: cost unknown on every row', () => {
    const none = { calls: 1, inputTokens: 10, outputTokens: 5, noUsage: 0, costUsd: null, unpriced: 1 };
    const out = renderUsage({ ...none, agents: { director: { ...none } } });
    expect(out).toContain('  narrator  1 generation · in 10 tok · out 5 tok · cost unknown');
    expect(out).toContain('  director  1 call · in 10 tok · out 5 tok · cost unknown');
    expect(out).toContain('  total     in 20 tok · out 10 tok · cost unknown');
    expect(out).toContain('1 narrator generation(s) without a price');
  });
});

describe("send's text mode: the Director's line", () => {
  test('planned and reused carry the summary; failed the reason; planning and skipped say nothing', () => {
    expect(directorLine(ev(dir({ summary: 'arcs +1 · seeds +1' })) as Extract<Event, { type: 'director' }>)).toBe('⋯ director: planned — arcs +1 · seeds +1');
    expect(describeEvent(ev(dir({ status: 'reused', summary: 'no changes' })))).toBe('⋯ director: reused — no changes');
    expect(describeEvent(ev(dir({ status: 'reused' })))).toBe('⋯ director: reused');
    expect(describeEvent(ev(dir({ status: 'failed', reason: 'timeout' })))).toBe('⋯ director: failed (timeout)');
    expect(describeEvent(ev(dir({ status: 'failed' })))).toBe('⋯ director: failed (unknown)');
    expect(describeEvent(ev(dir({ status: 'planning' })))).toBeNull();
    expect(describeEvent(ev(dir({ status: 'skipped', reason: 'off' })))).toBeNull();
    // The REPL's side line is its own (unchanged).
    expect(sideLine(ev(dir({ summary: 'arcs +1' })))).toBe('⋯ director: planned — arcs +1');
  });

  test('the line goes to stderr before the answer; stdout stays the answer alone', () => {
    const out = memoryChannel();
    const err = memoryChannel();
    const r = createTextRenderer({ out, err }, { debug: false });
    const message: MessageView = { id: 'm1', parent: 'u1', role: 'assistant', blocks: [{ k: 'text', text: 'She nods.' }], hidden: false, edited: false, swipe: { index: 0, count: 1 } };
    r.push(ev({ type: 'start', turnId: 't_1', kind: 'reply', messageId: 'm1', parentId: 'u1' }));
    r.push(ev(dir({ status: 'planning' })));
    r.push(ev(dir({ summary: 'arcs +1 ~2 · chapter 2' })));
    r.push(ev({ type: 'text', turnId: 't_1', delta: 'She nods.', offset: 0 }));
    r.push(ev({ type: 'done', turnId: 't_1', message }));
    r.finish();
    expect(out.text()).toBe('She nods.\n');
    expect(err.text()).toBe('rp-core: ⋯ director: planned — arcs +1 ~2 · chapter 2\n');
  });

  test('a failed plan is one line too; the turn goes on', () => {
    const out = memoryChannel();
    const err = memoryChannel();
    const r = createTextRenderer({ out, err }, { debug: false });
    r.push(ev(dir({ status: 'planning' })));
    r.push(ev(dir({ status: 'failed', reason: 'provider_error' })));
    r.push(ev({ type: 'text', turnId: 't_1', delta: 'Rain.', offset: 0 }));
    r.finish();
    expect(err.text()).toBe('rp-core: ⋯ director: failed (provider_error)\n');
    expect(out.text()).toBe('Rain.\n');
  });
});
