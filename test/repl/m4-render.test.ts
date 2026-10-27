// M4 CLI output (D-113, D-101): /director show (renderDirector; the last directive in full, as sent), the banner's
// Director part, /usage rows per agent, and the Director's stderr line of `send`'s text mode.
import { describe, expect, test } from 'bun:test';
import { emptyState } from '../../src/agents/director/state.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { createTextRenderer, describeEvent, directorLine } from '../../src/cli/render.ts';
import { DIRECTOR_FOOTER, DIRECTOR_HEADER, renderDirective } from '../../src/agents/director/render.ts';
import type { NarratorDirective } from '../../src/agents/director/types.ts';
import { bannerLine, makeStyle, renderDirector, renderUsage, sideLine, stripAnsi, type DirectorShow } from '../../src/cli/repl-render.ts';
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
        'last directive (turn 40, as sent):',
        DIRECTOR_HEADER,
        'The following are non-negotiable scene constraints decided by the Story Director.',
        'They take precedence over any internal planning, director framework, or evaluation',
        'protocol you may otherwise apply to arc/callback/character-beat decisions.',
        'Your job is to render these constraints as excellent prose. Do NOT second-guess',
        'which arc to advance, which callback to weave in, or which character beat to hit -',
        'the Director has already made those decisions. Execute them.',
        '',
        'Mood: tense',
        'Pacing: Keep things moving. Punchy sentences. Action-oriented.',
        '',
        'Narrative Goal: The keeper lies about the letter.',
        '',
        'Story Arc Directions:',
        '  - "The Locked Room" (moderate): A knock.',
        '',
        'Character Beats:',
        '  - Mira: She hides the key.',
        '  - The keeper: He looks away.',
        '',
        '[Ending: A knock at the door.]',
        DIRECTOR_FOOTER,
      ].join('\n'),
    );
  });

  test('the last directive is the whole block the narrator got: long fields are never cut', () => {
    const state = richState();
    const hook = `Daigorou looks at you with a mix of excitement and dread, ${'and the samurai armour creaks, '.repeat(6)}waiting.`;
    const setting = 'Your bedroom, with the samurai armour standing in the corner under a sheet';
    const directive: NarratorDirective = { pacing: 'medium', sceneGuidance: { setting, tension_level: 4 }, endingHook: hook, include: { foreshadowing: ['a', 'b'] } };
    const out = renderDirector(show({ state, record: recordFor(state, { directive }) }), plain);
    const lines = out.split('\n');
    const at = lines.indexOf('last directive (turn 40, as sent):');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1).join('\n')).toBe(renderDirective(directive));
    expect(lines).toContain(`  Setting: ${setting}`);
    expect(lines).toContain(`[Ending: ${hook}]`);
    expect(out).not.toContain('…');
  });

  test('intentions and next beats are shown in full, never cut (Levi, 27.10: "…pat…" read as a bug)', () => {
    const state = richState();
    const long = `Demonstrate Marfa's hospitality and care for Elisey's wellbeing by offering a safe, alternative path around the broken bridge at Горелая балка.`;
    expect(long.length).toBeGreaterThan(100);
    state.nextIntentions = [{ type: 'story', description: long, priority: 'must', targetTurn: 'next' }];
    const arc = state.arcs.find((a) => a.nextBeat?.status === 'pending')!;
    arc.nextBeat = { ...arc.nextBeat!, description: `${long} Then a knock.` };
    const lines = renderDirector(show({ state, record: recordFor(state) }), plain).split('\n');
    expect(lines).toContain(`  must · next: ${long}`);
    expect(lines.some((l) => l.startsWith('    next: ') && l.includes(`${long} Then a knock.`))).toBe(true);
    expect(lines.filter((l) => l.includes('…'))).toEqual([]);
  });

  test('a directive that renders nothing: the narrator got no block, and it says so', () => {
    const state = richState();
    const out = renderDirector(show({ state, record: recordFor(state, { directive: { pacing: 'medium' } }) }), plain);
    expect(out.split('\n').at(-1)).toBe('last directive (turn 40, as sent): empty (the narrator got no Director block)');
  });

  test('colour: the heading and every line of the block dim, blank lines left bare', () => {
    const out = renderDirector(show(), ansi);
    const lines = out.split('\n');
    const at = lines.indexOf('\x1b[2mlast directive (turn 40, as sent):\x1b[22m');
    expect(at).toBeGreaterThan(0);
    for (const l of lines.slice(at + 1)) expect(l === '' || (l.startsWith('\x1b[2m') && l.endsWith('\x1b[22m'))).toBe(true);
    expect(lines.at(-1)).toBe(`\x1b[2m${DIRECTOR_FOOTER}\x1b[22m`);
    expect(stripAnsi(out)).toBe(renderDirector(show(), plain));
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

  test('a failed turn: failed (code); the last directive sent before it, in full, and which turn it was', () => {
    const state = { ...richState(), turn: 41 };
    const before: NarratorDirective = { pacing: 'slow', mood: 'quiet', endingHook: 'The lamp goes out.' };
    const out = renderDirector(
      show({ state, record: recordFor(state, { ok: false, code: 'timeout', directive: undefined, skipped: [] }), sentBefore: { turn: 40, from: 'a0000040', directive: before } }),
      plain,
    );
    expect(out).toContain('turn 41 · failed (timeout) on a1b2c3d4 · structured · full · script:default');
    expect(out).toContain(`last directive (turn 40, as sent on a0000040; turn 41 sent none):\n${renderDirective(before)}`);
    expect(out.endsWith(DIRECTOR_FOOTER)).toBe(true);
  });

  test('a failed turn with no record of the last directive on the path: the one the Director wrote (the state keeps it)', () => {
    const state = { ...richState(), turn: 41 };
    const out = renderDirector(show({ state, record: recordFor(state, { ok: false, code: 'timeout', directive: undefined, skipped: [] }) }), plain);
    expect(out).toContain(`last directive (turn 40, as the Director wrote it; turn 41 sent none):\n${renderDirective(state.lastDirective!.directive)}`);
    expect(out).toContain('Narrative Goal: The keeper lies about the letter.');
    expect(out).not.toContain('as sent');
  });

  test('a reused plan names the reply it came from, in the turn line and over the directive; a binding of its own has no "(the narrator\'s model)"', () => {
    const state = richState();
    const record = recordFor(state, { reusedFrom: 'feedbeef' });
    const out = renderDirector(show({ binding: { conn: 'dir', model: 'big', follows: false }, record }), plain);
    expect(out.split('\n')[0]).toBe('director on · dir:big · profile auto · style the-balanced');
    expect(out).toContain('turn 40 · reused (the plan of feedbeef) on a1b2c3d4');
    expect(out).toContain(`last directive (turn 40, reused from feedbeef, as sent):\n${renderDirective(record.directive!)}`);
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
