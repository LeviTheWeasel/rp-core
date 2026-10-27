// M4 REPL flows (D-113, D-101): /director on|off write config rows (and only when they change
// something), the banner names the Director's binding while it is on, /director show folds the
// Director's state at the head (directorAt) from records on the replies, and /usage gives the
// Director's calls a row of their own. No turn runs with the Director on here (the engine's part).
import { afterEach, describe, expect, test } from 'bun:test';
import { Engine } from '../../src/engine/engine.ts';
import { renderDirective } from '../../src/agents/director/render.ts';
import { emptyState } from '../../src/agents/director/state.ts';
import type { ConfigEntry } from '../../src/session/entries.ts';
import { recordFor, richState, msgInput, traceWith } from '../cli-m4/fixtures.ts';
import { tmpHome } from '../helpers.ts';
import { calls, entriesOf, LEVI, MIRA, replRig, writeRaw, type ReplRig, type ReplRigOptions } from './kit.ts';

const rigs: ReplRig[] = [];
async function rig(o: ReplRigOptions = {}): Promise<ReplRig> {
  const r = await replRig(calls(), o);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

const configRows = (r: ReplRig): ConfigEntry[] => entriesOf(r.home, r.session.id).filter((e): e is ConfigEntry => e.t === 'config');

describe('/director on|off', () => {
  test('on and off write director.enabled once each; a repeat says so and writes nothing', async () => {
    const r = await rig();
    r.type('/director', '/director on', '/director on', '/director', '/director off', '/director off');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('director off (/director on lets it plan every reply; the plan below is kept meanwhile)\nThe Director has not planned yet.');
    expect(out).toContain("director on: it plans every reply with script:default (the narrator's model), from the next turn");
    expect(out).toContain('the Director is already on');
    expect(out).toContain("director on · script:default (the narrator's model) · profile auto · style the-balanced\nThe Director has not planned yet.");
    expect(out).toContain('director off (from the next turn); its plan is kept: /director on resumes it');
    expect(out).toContain('the Director is already off');
    expect(configRows(r).map((e) => e.patch)).toEqual([{ director: { enabled: true } }, { director: { enabled: false } }]);
  });

  test('its own binding is named; the banner shows the Director only while it is on', async () => {
    const r = await rig({ config: { roles: { narrator: { conn: 'script', model: 'default' }, director: { conn: 'alt', model: 'big' } } } });
    r.type('/director on');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out.split('\n')[0]).toBe(`session ${r.session.id} · Mira · narrator script:default (tools: off) · ctx ?`);
    expect(out).toContain('director on: it plans every reply with alt:big, from the next turn');
  });
});

test('/director on with a binding on a connection config.toml does not have: a warning (plans would fail no_connection)', async () => {
  const r = await rig({ config: { roles: { narrator: { conn: 'script', model: 'default' }, director: { conn: 'nowhere', model: 'big' } } } });
  r.type('/director on');
  r.end();
  expect(await r.done).toBe(0);
  expect(r.out()).toContain(
    '! the Director\'s model nowhere:big cannot be reached (config.toml has no connection "nowhere"): its plans will fail with no_connection; /model director narrator makes it follow the narrator',
  );
  expect(configRows(r).map((e) => e.patch)).toEqual([{ director: { enabled: true } }]);
});

describe('banner', () => {
  test('enabled: "director <conn:model> (<profile>)" after the narrator; following the narrator names its model', async () => {
    const r = await rig({ config: { director: { enabled: true, profile: 'lite' } } });
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out().split('\n')[0]).toBe(`session ${r.session.id} · Mira · narrator script:default (tools: off) · director script:default (lite) · ctx ?`);
  });

  test('a binding of its own', async () => {
    const r = await rig({ config: { director: { enabled: true }, roles: { narrator: { conn: 'script', model: 'default' }, director: { conn: 'alt', model: 'big' } } } });
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out().split('\n')[0]).toContain('· director alt:big (auto) · ctx');
  });
});

/**
 * A closed session: greeting → u1 → a1 (Director turn 1, no plan yet: failed no_output) → u2 → a2
 * (turn 40, the rich state, with Director calls in its trace) → head a2. `failedAfter`: then u3 → a3
 * (turn 41 failed: timeout, the state kept with the authored directive of turn 40) → head a3.
 */
async function sessionWithRecords(o: { failedAfter?: boolean } = {}): Promise<{ home: string; id: string }> {
  const home = tmpHome('rp-core-repl-m4-');
  const engine = await Engine.open({ home });
  const s = engine.createSession({ character: MIRA, persona: LEVI, config: { director: { enabled: true } } });
  const greeting = s.view().head!;
  const id = s.id;
  await s.close();
  await engine.close();
  const first = { ...emptyState(), turn: 1 };
  const rich = richState();
  writeRaw(home, id, (log) => {
    log.append(msgInput('u1000001', greeting, 'user', 'Who rings the bell?'));
    log.append(
      msgInput('a1000001', 'u1000001', 'assistant', 'Nobody, she says.', {
        gen: { kind: 'model', connection: 'script', model: 'default', usage: { inputTotal: 1000, outputTotal: 100 } },
        dir: recordFor(first, { ok: false, code: 'no_output', directive: undefined, skipped: [] }),
      }),
    );
    log.append(msgInput('u1000002', 'a1000001', 'user', 'And the ribbon?'));
    log.append(
      msgInput('a1000002', 'u1000002', 'assistant', 'She hides it.', {
        gen: { kind: 'model', connection: 'script', model: 'default', usage: { inputTotal: 1000, outputTotal: 100 } },
        trace: traceWith([
          { callKey: 't:director:0', agent: 'director', model: 'script:default', ms: 900, usage: { inputTotal: 500, outputTotal: 50 } },
          { callKey: 't:narrator:0', agent: 'narrator', model: 'script:default', ms: 800, usage: { inputTotal: 1000, outputTotal: 100 } },
        ]),
        dir: recordFor(rich),
      }),
    );
    if (!o.failedAfter) return;
    log.append(msgInput('u1000003', 'a1000002', 'user', 'Open it.'));
    const after = { ...rich, turn: 41 };
    log.append(msgInput('a1000003', 'u1000003', 'assistant', 'The door sticks.', { dir: recordFor(after, { ok: false, code: 'timeout', directive: undefined, skipped: [] }) }));
  });
  return { home, id };
}

describe('/director show over the path', () => {
  test("the state at the head; after a rewind, the earlier reply's record; /usage has a Director row", async () => {
    const { home, id } = await sessionWithRecords();
    const r = await rig({ home, sessionId: id });
    r.type('/director', '/usage', '/rewind 3', '/director show');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('· director script:default (auto) · ctx');
    expect(out).toContain("director on · script:default (the narrator's model) · profile auto · style the-balanced\nturn 40 · planned on a1000002 · structured · full · script:default · 2 skipped");
    expect(out).toContain('  seed-6 "The red ribbon" · epic · age 35/25 OVERDUE · 2 reinforcements · ripe for payoff');
    // The directive in full, as the narrator got it (renderDirective of the record's), not a summary.
    expect(out).toContain(`last directive (turn 40, as sent):\n${renderDirective(recordFor(richState()).directive!)}\nyou  › /usage`);
    // Priced from the kit's table (script:default: $1 / $2 per million).
    expect(out).toContain(
      [
        'usage on this path:',
        '  narrator  2 generations · in 2000 tok · out 200 tok · cost $0.0024',
        '  director  1 call · in 500 tok · out 50 tok · cost $0.0006',
        '  total     in 2500 tok · out 250 tok · cost $0.0030',
      ].join('\n'),
    );
    // Rewound to a1: its own record (a failed first turn), nothing planned yet.
    expect(out).toContain('turn 1 · failed (no_output) on a1000001 · structured · full · script:default\nchapter none yet\narcs: none\nseeds: none\nhidden arcs: none\nno directive yet');
  });

  test('a failed turn at the head: the last directive sent before it on the path, in full, and whose it was', async () => {
    const { home, id } = await sessionWithRecords({ failedAfter: true });
    const r = await rig({ home, sessionId: id });
    r.type('/director show');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('turn 41 · failed (timeout) on a1000003 · structured · full · script:default');
    // a2's record (as sent: its ending hook and beats), not the state's authored copy (which has neither).
    const sent = renderDirective(recordFor(richState()).directive!);
    expect(out).toContain(`last directive (turn 40, as sent on a1000002; turn 41 sent none):\n${sent}`);
    expect(sent).toContain('[Ending: A knock at the door.]');
  });
});
