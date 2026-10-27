// M4 turn integration (.notes/m4-decisions.md D-101…D-106): the Director plans before assemble, its
// directive goes to depth 1, its contract to the core block, its record to prep and the commit; swipe
// reuse, guided re-roll, replan, rewind and fork; continue; Stop, budget, missing connection; crash
// recovery; accounting (trace.calls, trace.agents, usage, retry). Scripted provider: one connection
// whose script holds the Director's calls before the narrator's, or two connections with roles.director.
import { describe, expect, test } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import { contractText, renderDirective } from '../../src/agents/director/render.ts';
import { emptyState } from '../../src/agents/director/state.ts';
import type { Connection } from '../../src/engine/api.ts';
import { sessionsDir } from '../../src/session/log.ts';
import { fakeClock, fakeRandom } from '../helpers.ts';
import {
  byAgent,
  calls,
  dirCall,
  directorEvents,
  directorUser,
  dirSession,
  drain,
  entriesOf,
  fullCaps,
  msgBySrc,
  msgRow,
  noticeCodes,
  planOf,
  prepRow,
  recordOf,
  rig,
  say,
  scriptConn,
  scriptFile,
  statuses,
  tagged,
  textOfMsg,
  turnOf,
  until,
  writeRaw,
} from './kit.ts';

const NARR = (text = 'The lamp gutters.') => [{ text }];

describe('a reply with the Director on', () => {
  test('one director call (tagged <plan>), then the narrator request with the directive at depth 1 and the contract', async () => {
    const r = await rig(calls(dirCall(), NARR()));
    const s = dirSession(r.engine);
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    const [d, n] = r.provider.requests;
    expect(r.provider.requests.map((x) => [x.agent, x.callKey])).toEqual([
      ['director', `${turn.turnId}:director:0`],
      ['narrator', `${turn.turnId}:narrator:0`],
    ]);
    // Tagged: the schema and "How to answer" ride the system prompt; no response_format.
    expect(d!.responseSchema).toBeUndefined();
    expect(textOfMsg(d!.messages[0]!)).toContain('<plan>');
    expect(d!.samplers).toEqual({ temperature: 0.7 });
    expect(d!.maxTokens).toBe(1500); // lite: SCRIPT_CAPS has an 8192 window
    expect(d!.reasoning).toBe('none'); // SCRIPT_CAPS can turn reasoning off

    // The narrator: the contract closes the leading system run, the directive sits right above U.
    const core = msgBySrc(n!, 'core:director');
    expect(core && textOfMsg(core)).toBe(contractText('Levi'));
    const at = n!.messages.findIndex((m) => m.src === 'director');
    expect(at).toBeGreaterThan(0);
    expect(n!.messages[at + 1]).toMatchObject({ role: 'user', src: 'history' });
    expect(at + 1).toBe(n!.messages.length - 1);

    const msg = msgRow(r.home, s.id, turn.messageId);
    const prep = prepRow(r.home, s.id, turn.turnId)!;
    expect(prep.dir).toEqual(msg.dir!);
    const rec = recordOf(msg.dir);
    expect(rec).toMatchObject({ turn: 1, ok: true, transport: 'tagged', profile: 'lite', model: 'script:default', reducer: 1 });
    expect(textOfMsg(n!.messages[at]!)).toBe(renderDirective(rec.directive!));
    expect(rec.state.turn).toBe(1);
    expect(rec.state.arcs.map((a) => a.title)).toEqual(['The Red Door']);
    expect(rec.state.lastDirective?.directive.mood).toBe('tense');
    expect(rec.attempts).toEqual([expect.objectContaining({ transport: 'tagged', outcome: 'ok' })]);

    expect(statuses(evs)).toEqual(['planning', 'planned']);
    expect(directorEvents(evs)[1]!.summary).toBe('arcs +1 · seeds +1 · chapter 1');
    expect(msg.trace!.calls.map((c) => [c.agent, c.callKey])).toEqual([
      ['director', `${turn.turnId}:director:0`],
      ['narrator', `${turn.turnId}:narrator:0`],
    ]);
    expect(prep.trace.calls.map((c) => c.agent)).toEqual(['director']);
    expect(msg.trace!.agents).toEqual({ director: { status: 'done', transport: 'tagged' } });
    expect(prep.trace.agents).toEqual({ director: { status: 'done', transport: 'tagged' } });
    await r.engine.close();
  });

  test('the fixture script director-reply.jsonl plays a whole planned turn', async () => {
    const r = await rig(scriptFile('director-reply.jsonl'));
    const s = dirSession(r.engine);
    const { out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    const rec = recordOf(msgRow(r.home, s.id, turn.messageId).dir);
    expect(rec.ok).toBe(true);
    expect(rec.state.invisibleArcs.map((h) => h.title)).toEqual(['The tenant between the walls']);
    expect(rec.state.arcs[0]!.nextBeat?.description).toBe('The flame leans toward the guest.');
    await r.engine.close();
  });

  test('usage and retry events carry the agent; gen.usage stays the narrator’s', async () => {
    const r = await rig(
      calls(
        [{ error: { code: 'rate_limited', status: 429 } }],
        [{ text: tagged(planOf()) }, { usage: { inputTotal: 900, outputTotal: 40 } }],
        [{ text: 'The lamp gutters.' }, { usage: { inputTotal: 1200, outputTotal: 7 } }],
      ),
    );
    const s = dirSession(r.engine);
    const { evs, turn } = await turnOf(s);
    const t = turn.turnId;
    expect(evs.filter((e) => e.type === 'retry')).toEqual([expect.objectContaining({ callKey: `${t}:director:0`, attempt: 1 })]);
    const usage = evs.flatMap((e) => (e.type === 'usage' ? [[e.agent, e.callKey, e.usage.outputTotal]] : []));
    expect(usage).toEqual([
      ['director', `${t}:director:1`, 40],
      ['narrator', `${t}:narrator:0`, 7],
    ]);
    const msg = msgRow(r.home, s.id, turn.messageId);
    expect(msg.gen!.usage).toEqual({ inputTotal: 1200, outputTotal: 7 });
    expect(msg.trace!.calls.map((c) => c.callKey)).toEqual([`${t}:director:0`, `${t}:director:1`, `${t}:narrator:0`]);
    expect(recordOf(msg.dir).attempts.map((a) => a.outcome)).toEqual(['retried', 'ok']);
    await r.engine.close();
  });

  test('a broken plan, a correction, still broken: failed (undecodable), the reply arrives, the state is the previous one with turn + 1', async () => {
    const r = await rig([...calls(dirCall(), NARR('First.')), ...scriptFile('director-broken.jsonl')]);
    const s = dirSession(r.engine);
    const first = await turnOf(s);
    const prev = recordOf(msgRow(r.home, s.id, first.turn.messageId).dir).state;
    s.send({ text: 'I open the door.', expectedVersion: s.version() });
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(out.type === 'done' && out.message.blocks).toEqual([{ k: 'text', text: 'The lamp gutters, and the reply still arrives.' }]);
    expect(statuses(evs)).toEqual(['planning', 'failed']);
    expect(directorEvents(evs)[1]!.reason).toBe('undecodable');
    const dirs = byAgent(r.provider.requests, 'director');
    expect(dirs).toHaveLength(3);
    expect(dirs[2]!.messages.map((m) => m.src)).toEqual(['director:system', 'director:user', 'director:user', 'director:answer', 'director:correction']);
    const rec = recordOf(msgRow(r.home, s.id, turn.messageId).dir);
    expect(rec).toMatchObject({ turn: 2, ok: false, code: 'undecodable', transport: 'tagged', profile: 'lite', skipped: [] });
    expect(rec.directive).toBeUndefined();
    expect(rec.state).toEqual({ ...prev, turn: 2 });
    expect(rec.attempts.map((a) => a.outcome)).toEqual(['undecodable', 'undecodable']);
    // No directive this turn (the previous one is not sent again), the contract stays.
    const narr = byAgent(r.provider.requests, 'narrator')[1]!;
    expect(narr.messages.some((m) => m.src === 'director')).toBe(false);
    expect(msgBySrc(narr, 'core:director')).toBeDefined();
    expect(msgRow(r.home, s.id, turn.messageId).trace!.agents).toEqual({ director: { status: 'failed', code: 'undecodable', transport: 'tagged' } });
    await r.engine.close();
  });

  test('the second plan audits the first: self-audit with the reply’s prose; history holds the greeting, U only in the action', async () => {
    const r = await rig(calls(dirCall(), NARR('Mira lifts the lamp toward the stairs.'), dirCall(planOf({ chapterUpdate: { action: 'none' } })), NARR('The stairs creak.')));
    const s = dirSession(r.engine, { text: 'I look around the room.' });
    await turnOf(s);
    await say(s, 'I follow her up.');
    const [d1, d2] = byAgent(r.provider.requests, 'director');
    expect(directorUser(d1!)).not.toContain('[SELF-AUDIT]');
    const u2 = directorUser(d2!);
    expect(u2).toContain('## Turn 2');
    expect(u2).toContain('[SELF-AUDIT]');
    expect(u2).toContain('Mira lifts the lamp toward the stairs.');
    expect(u2).toContain('### User\'s Action\nI follow her up.');
    expect(u2).toContain('[Turn 1] assistant: Hello, Levi. I am Mira.');
    expect(u2).toContain('[Turn 2] user: I look around the room.');
    expect(u2).not.toContain('user: I follow her up.');
    await r.engine.close();
  });

  test('the persona filter: a beat for the player is removed from the directive sent, the authored one stays in the state', async () => {
    const plan = planOf({
      directive: { mood: 'tense', characterBeats: [{ character: 'Levi', beat: 'Levi realizes the door is a trap' }, { character: 'Mira', beat: 'Mira smiles' }] },
    });
    const r = await rig(calls(dirCall(plan), NARR()));
    const s = dirSession(r.engine);
    const { turn } = await turnOf(s);
    const rec = recordOf(msgRow(r.home, s.id, turn.messageId).dir);
    expect(rec.directive!.characterBeats).toEqual([{ character: 'Mira', beat: 'Mira smiles' }]);
    expect(rec.skipped).toContainEqual(expect.objectContaining({ why: 'persona' }));
    expect(rec.state.lastDirective!.directive.characterBeats).toHaveLength(2);
    const narr = byAgent(r.provider.requests, 'narrator')[0]!;
    expect(textOfMsg(msgBySrc(narr, 'director')!)).not.toContain('trap');
    await r.engine.close();
  });

  test('a second connection: roles.director routes the calls there', async () => {
    const dir = scriptConn('dir', calls(dirCall()));
    const r = await rig(calls(NARR()), { connections: { dir: dir.conn } });
    const s = dirSession(r.engine, { config: { roles: { director: { conn: 'dir', model: 'planner' } } } });
    const { turn } = await turnOf(s);
    expect(dir.provider.requests.map((x) => x.agent)).toEqual(['director']);
    expect(r.provider.requests.map((x) => x.agent)).toEqual(['narrator']);
    const msg = msgRow(r.home, s.id, turn.messageId);
    expect(recordOf(msg.dir).model).toBe('dir:planner');
    expect(msg.trace!.calls.map((c) => c.model)).toEqual(['dir:planner', 'script:default']);
    await r.engine.close();
  });
});

describe('swipes (D-29, D-104)', () => {
  test('a plain swipe reuses the plan: no call, reusedFrom, event reused; a swipe of that swipe keeps the first id', async () => {
    const r = await rig(calls(dirCall(), NARR('First.'), NARR('Second.'), NARR('Third.')));
    const s = dirSession(r.engine);
    const a = await turnOf(s);
    const first = recordOf(msgRow(r.home, s.id, a.turn.messageId).dir);
    const b = await turnOf(s, 'swipe');
    expect(b.out.type).toBe('done');
    expect(byAgent(r.provider.requests, 'director')).toHaveLength(1);
    expect(statuses(b.evs)).toEqual(['reused']);
    expect(directorEvents(b.evs)[0]!.summary).toBe('arcs +1 · seeds +1 · chapter 1');
    const copy = recordOf(msgRow(r.home, s.id, b.turn.messageId).dir);
    expect(copy).toEqual({ ...first, attempts: [], skipped: [], reusedFrom: a.turn.messageId });
    expect(prepRow(r.home, s.id, b.turn.turnId)!.dir).toEqual(copy);
    expect(msgRow(r.home, s.id, b.turn.messageId).trace!.agents).toEqual({ director: { status: 'reused', transport: 'tagged' } });
    expect(msgRow(r.home, s.id, b.turn.messageId).trace!.calls.map((c) => c.agent)).toEqual(['narrator']);
    // The same directive at depth 1.
    const [n1, n2] = byAgent(r.provider.requests, 'narrator');
    expect(msgBySrc(n2!, 'director')).toEqual(msgBySrc(n1!, 'director'));

    const c = await turnOf(s, 'swipe');
    expect(recordOf(msgRow(r.home, s.id, c.turn.messageId).dir).reusedFrom).toBe(a.turn.messageId);
    await r.engine.close();
  });

  test('/regen guidance replans: the guidance is one more line in the Director’s user prompt', async () => {
    const second = planOf({ directive: { mood: 'quiet', narrativeGoal: 'A softer scene.' }, arcUpdates: [], seedUpdates: [], chapterUpdate: { action: 'none' } });
    const r = await rig(calls(dirCall(), NARR('First.'), dirCall(second), NARR('Softer.')));
    const s = dirSession(r.engine);
    await turnOf(s);
    const g = await turnOf(s, 'swipe', { guidance: 'Make it gentler.' });
    expect(statuses(g.evs)).toEqual(['planning', 'planned']);
    const d2 = byAgent(r.provider.requests, 'director')[1]!;
    expect(directorUser(d2)).toContain('I look around the room.\nThe player asked for a new version of the last answer: Make it gentler.');
    const rec = recordOf(msgRow(r.home, s.id, g.turn.messageId).dir);
    // Planned from the state at U (empty): the same Director turn as the replaced answer's.
    expect(rec).toMatchObject({ turn: 1, ok: true });
    expect(rec.reusedFrom).toBeUndefined();
    expect(rec.directive!.mood).toBe('quiet');
    await r.engine.close();
  });

  test("onSwipe 'replan' plans anew from the state at U; a failed plan is never reused", async () => {
    const r = await rig(calls(dirCall(), NARR('First.'), dirCall(planOf({ directive: { mood: 'grim' } })), NARR('Second.')));
    const s = dirSession(r.engine, { director: { onSwipe: 'replan' } });
    await turnOf(s);
    const b = await turnOf(s, 'swipe');
    expect(byAgent(r.provider.requests, 'director')).toHaveLength(2);
    expect(directorUser(byAgent(r.provider.requests, 'director')[1]!)).toContain('## Turn 1');
    expect(recordOf(msgRow(r.home, s.id, b.turn.messageId).dir)).toMatchObject({ turn: 1, ok: true, directive: { mood: 'grim' } });
    await r.engine.close();

    const r2 = await rig([...scriptFile('director-broken.jsonl'), ...calls(dirCall(), NARR('Again.'))]);
    const s2 = dirSession(r2.engine);
    await turnOf(s2);
    const sw = await turnOf(s2, 'swipe');
    expect(statuses(sw.evs)).toEqual(['planning', 'planned']);
    expect(recordOf(msgRow(r2.home, s2.id, sw.turn.messageId).dir)).toMatchObject({ turn: 1, ok: true });
    await r2.engine.close();
  });
});

describe('the state follows the path (D-103)', () => {
  test('a rewind plans from the older state; a fork keeps the state', async () => {
    const plan2 = planOf({ arcUpdates: [{ title: 'The Stairs', description: 'Up.', status: 'seeding' }], seedUpdates: [], chapterUpdate: { action: 'none' } });
    const r = await rig(calls(dirCall(), NARR('A1.'), dirCall(plan2), NARR('A2.'), dirCall(planOf({ arcUpdates: [], seedUpdates: [] })), NARR('A3.'), dirCall(planOf({ arcUpdates: [], seedUpdates: [] })), NARR('F1.')));
    const s = dirSession(r.engine);
    const a1 = await turnOf(s);
    const a2 = await say(s, 'I climb.');
    expect(a2.out.type).toBe('done');
    const a2Id = a2.out.type === 'done' ? a2.out.message.id : '';
    expect(recordOf(msgRow(r.home, s.id, a2Id).dir).state.arcs.map((a) => a.title)).toEqual(['The Red Door', 'The Stairs']);

    // Rewind to the first answer and say something else: turn 2 again, from a1's state.
    s.select({ messageId: a1.turn.messageId, expectedVersion: s.version(), exact: true });
    const a3 = await say(s, 'I stay downstairs.');
    const a3Id = a3.out.type === 'done' ? a3.out.message.id : '';
    expect(directorUser(byAgent(r.provider.requests, 'director')[2]!)).toContain('## Turn 2');
    const rec3 = recordOf(msgRow(r.home, s.id, a3Id).dir);
    expect(rec3.turn).toBe(2);
    expect(rec3.state.arcs.map((a) => a.title)).toEqual(['The Red Door']);

    // A fork at a2 carries a2's state: the next plan is turn 3.
    const forkId = s.fork({ at: a2Id });
    const f = r.engine.session(forkId);
    const f1 = await say(f, 'In the fork.');
    const fId = f1.out.type === 'done' ? f1.out.message.id : '';
    expect(directorUser(byAgent(r.provider.requests, 'director')[3]!)).toContain('## Turn 3');
    expect(recordOf(msgRow(r.home, forkId, fId).dir).state.arcs.map((a) => a.title)).toEqual(['The Red Door', 'The Stairs']);
    await r.engine.close();
  });
});

describe('continue', () => {
  test('no Director call: the target’s directive is sent again with the contract; the edit row has no dir', async () => {
    const r = await rig(calls(dirCall(), NARR('The lamp burns.'), [{ text: ' And then it dims.' }]));
    const s = dirSession(r.engine);
    const a = await turnOf(s);
    const rec = recordOf(msgRow(r.home, s.id, a.turn.messageId).dir);
    const c = await turnOf(s, 'continue');
    expect(c.out.type).toBe('done');
    expect(byAgent(r.provider.requests, 'director')).toHaveLength(1);
    expect(statuses(c.evs)).toEqual([]);
    const n = byAgent(r.provider.requests, 'narrator')[1]!;
    expect(textOfMsg(msgBySrc(n, 'director')!)).toBe(renderDirective(rec.directive!));
    expect(textOfMsg(msgBySrc(n, 'core:director')!)).toBe(contractText('Levi'));
    const edit = entriesOf(r.home, s.id).findLast((e) => e.t === 'edit');
    expect(edit && 'dir' in edit).toBe(false);
    expect(edit?.t === 'edit' && edit.trace?.agents).toEqual({ director: { status: 'skipped' } });
    expect(prepRow(r.home, s.id, c.turn.turnId)!.dir).toBeUndefined();
    // The target keeps its own plan.
    expect(msgRow(r.home, s.id, a.turn.messageId).dir).toEqual(rec);
    await r.engine.close();
  });
});

describe('the Director never fails the turn', () => {
  test('Stop during planning: stopped-empty, no prep, no dir', async () => {
    const r = await rig(calls([{ pause: 'plan' }, { text: tagged(planOf()) }], NARR()));
    const s = dirSession(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await until(() => r.provider.requests.length === 1);
    s.stop();
    const evs = await drain(turn);
    const out = await turn.result;
    expect(out).toEqual({ type: 'stopped', message: null });
    expect(statuses(evs)).toEqual(['planning', 'failed']);
    expect(directorEvents(evs)[1]!.reason).toBe('aborted');
    const rows = entriesOf(r.home, s.id).filter((e) => 'turn' in e && e.turn === turn.turnId);
    expect(rows.map((e) => e.t)).toEqual(['turn', 'end']);
    expect(rows[1]).toMatchObject({ outcome: 'stopped-empty' });
    expect(byAgent(r.provider.requests, 'narrator')).toHaveLength(0);
    await r.engine.close();
  });

  test('a stopped answer with partial text carries the plan; a failed turn commits nothing (prep keeps it)', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Half an ' }, { pause: 'mid' }, { text: 'answer.' }], dirCall(planOf({ chapterUpdate: { action: 'none' } })), [{ error: { code: 'auth_failed', status: 401 } }]));
    const s = dirSession(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await until(() => r.provider.requests.length === 2);
    await until(() => entriesOf(r.home, s.id).some((e) => e.t === 'chk'));
    s.stop();
    await drain(turn);
    const out = await turn.result;
    expect(out.type).toBe('stopped');
    const msg = msgRow(r.home, s.id, turn.messageId);
    expect(msg.gen!.finish).toBe('stopped');
    expect(recordOf(msg.dir)).toMatchObject({ ok: true, turn: 1 });
    expect(msg.dir).toEqual(prepRow(r.home, s.id, turn.turnId)!.dir!);

    s.send({ text: 'Go on.', expectedVersion: s.version() });
    const failed = await turnOf(s);
    expect(failed.out.type).toBe('failed');
    expect(entriesOf(r.home, s.id).some((e) => e.t === 'msg' && e.id === failed.turn.messageId)).toBe(false);
    expect(recordOf(prepRow(r.home, s.id, failed.turn.turnId)!.dir)).toMatchObject({ ok: true, turn: 2 });
    await r.engine.close();
  });

  test('the budget runs out: failed (timeout), the reply arrives', async () => {
    const r = await rig(calls([{ delay: 5_000 }, { text: tagged(planOf()) }], NARR('Arrived.')));
    const s = dirSession(r.engine, { director: { timeoutSec: 0.05 } });
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(directorEvents(evs).map((e) => [e.status, e.reason])).toEqual([
      ['planning', undefined],
      ['failed', 'timeout'],
    ]);
    const rec = recordOf(msgRow(r.home, s.id, turn.messageId).dir);
    expect(rec).toMatchObject({ ok: false, code: 'timeout', turn: 1 });
    expect(rec.state).toEqual({ ...emptyState(), turn: 1 });
    expect(rec.attempts.map((a) => a.outcome)).toEqual(['timeout']);
    await r.engine.close();
  });

  test('a missing director connection (or caps that cannot be resolved): failed (no_connection), no call, the reply arrives', async () => {
    const r = await rig(calls(NARR('Arrived.'), NARR('Again.')));
    const s = dirSession(r.engine, { config: { roles: { director: { conn: 'nope', model: 'm' } } } });
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(directorEvents(evs).map((e) => [e.status, e.reason])).toEqual([['failed', 'no_connection']]);
    const msg = msgRow(r.home, s.id, turn.messageId);
    expect(recordOf(msg.dir)).toMatchObject({ ok: false, code: 'no_connection', turn: 1, attempts: [] });
    expect(recordOf(msg.dir).model).toBeUndefined();
    expect(msg.trace!.agents).toEqual({ director: { status: 'failed', code: 'no_connection' } });
    expect(r.provider.requests.map((x) => x.agent)).toEqual(['narrator']);
    await r.engine.close();

    const broken: Connection = {
      ...scriptConn('bad', []).conn,
      capsFor: () => {
        throw new Error('no caps');
      },
    };
    const r2 = await rig(calls(NARR('Arrived.')), { connections: { bad: broken } });
    const s2 = dirSession(r2.engine, { config: { roles: { director: { conn: 'bad', model: 'm' } } } });
    const t2 = await turnOf(s2);
    expect(recordOf(msgRow(r2.home, s2.id, t2.turn.messageId).dir).code).toBe('no_connection');
    await r2.engine.close();
  });

  test('crash recovery: an interrupted reply gets its dir from prep', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Half an answer ' }, { pause: 'mid' }, { text: 'and the rest.' }]));
    const s = dirSession(r.engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const file = join(sessionsDir(r.home), `${s.id}.jsonl`);
    const saved = join(r.home, 'crash.jsonl');
    await until(() => entriesOf(r.home, s.id).some((e) => e.t === 'chk' && e.turn === turn.turnId));
    // The journal as a crash would leave it: turn, prep (with dir), chk; nothing committed.
    copyFileSync(file, saved);
    const prepDir = prepRow(r.home, s.id, turn.turnId)!.dir;
    expect(recordOf(prepDir).ok).toBe(true);
    r.provider.release('mid');
    await drain(turn);
    await r.engine.close();
    copyFileSync(saved, file);

    const engine = await Engine.open({ home: r.home, connections: { script: r.conn }, clock: fakeClock(), random: fakeRandom(9), timeZone: 'UTC' });
    const s2 = engine.session(s.id);
    expect(s2.openEvents()).toContainEqual(expect.objectContaining({ type: 'recovered', turnId: turn.turnId, outcome: 'interrupted' }));
    const m = msgRow(r.home, s.id, turn.messageId);
    expect(m.gen!.finish).toBe('interrupted');
    expect(m.dir).toEqual(prepDir!);
    await engine.close();
  });
});

describe('notices once per session (D-115)', () => {
  test("director_lite: profile 'full' on a window below 16 384 runs lite and says so once", async () => {
    const r = await rig(calls(dirCall(), NARR('One.'), dirCall(planOf({ chapterUpdate: { action: 'none' } })), NARR('Two.')));
    const s = dirSession(r.engine, { director: { profile: 'full' } });
    const one = await turnOf(s);
    expect(noticeCodes(one.evs)).toEqual(['director_lite']);
    expect(recordOf(msgRow(r.home, s.id, one.turn.messageId).dir).profile).toBe('lite');
    const two = await say(s, 'Again.');
    expect(noticeCodes(two.evs)).toEqual([]);
    await r.engine.close();
  });

  test('director_state_invalid: an unreadable dir on the path is skipped and told once', async () => {
    const r = await rig(calls(dirCall(), NARR('One.'), dirCall(planOf({ chapterUpdate: { action: 'none' } })), NARR('Two.')));
    const s = dirSession(r.engine);
    const v = s.version();
    await s.close();
    const user = entriesOf(r.home, s.id).findLast((e) => e.t === 'msg')!;
    writeRaw(r.home, s.id, (log) => {
      log.append({ t: 'msg', ts: '2026-10-26T12:00:00.000Z', id: 'bad00001', parent: user.t === 'msg' ? user.id : null, role: 'assistant', blocks: [{ k: 'text', text: 'Old.' }], gen: { kind: 'model' }, dir: { reducer: 1, ok: true, turn: 'x' } });
      log.append({ t: 'msg', ts: '2026-10-26T12:00:00.000Z', id: 'usr00002', parent: 'bad00001', role: 'user', blocks: [{ k: 'text', text: 'Hello again.' }] });
    });
    expect(v).toBeGreaterThan(0);
    const s2 = r.engine.session(s.id);
    const one = await turnOf(s2);
    expect(noticeCodes(one.evs)).toEqual(['director_state_invalid']);
    expect(recordOf(msgRow(r.home, s.id, one.turn.messageId).dir).turn).toBe(1);
    const two = await say(s2, 'And again.');
    expect(noticeCodes(two.evs)).toEqual([]);
    await r.engine.close();
  });
});

describe('the full profile and the structured transport', () => {
  test('a 32k window plans full: the full prompts, max_tokens 16 384, the Shadow World section', async () => {
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps() });
    const s = dirSession(r.engine);
    const { turn } = await turnOf(s);
    const d = byAgent(r.provider.requests, 'director')[0]!;
    expect(d.maxTokens).toBe(16_384);
    expect(directorUser(d)).toContain('### Shadow World (Your Private Tracking)');
    expect(recordOf(msgRow(r.home, s.id, turn.messageId).dir).profile).toBe('full');
    await r.engine.close();
  });

  test("'auto' runs lite when the full prompt does not leave 4 096 tokens on a big window", async () => {
    // The Director's model has 24 576 tokens (auto's threshold), the narrator's far more: a long
    // persona fills the Director's full system prompt past what its window leaves for the plan.
    const dir = scriptConn('dir', calls(dirCall()), fullCaps({ contextLength: 24_576 }));
    const r = await rig(calls(NARR()), { caps: fullCaps({ contextLength: 200_000 }), connections: { dir: dir.conn } });
    const s = dirSession(r.engine, {
      persona: { name: 'Levi', description: 'A traveller who talks a lot about roads, rivers and rain. '.repeat(1_000) },
      config: { roles: { director: { conn: 'dir', model: 'm' } } },
    });
    const { turn } = await turnOf(s);
    expect(recordOf(msgRow(r.home, s.id, turn.messageId).dir).profile).toBe('lite');
    expect(dir.provider.requests[0]!.maxTokens).toBe(1500);
    await r.engine.close();
  });

  test('json_schema confirmed: responseSchema director_plan, no "How to answer"; a refusal (400) is told once as caps.suggest', async () => {
    const caps = fullCaps({ structuredOutput: { mode: 'json_schema', confirmedBy: 'user' } });
    const r = await rig(
      calls(
        [{ text: JSON.stringify(planOf()) }],
        NARR('One.'),
        [{ error: { code: 'bad_request', status: 400 } }],
        NARR('Two.'),
        [{ error: { code: 'bad_request', status: 400 } }],
        NARR('Three.'),
      ),
      { caps },
    );
    const s = dirSession(r.engine);
    const one = await turnOf(s);
    const d = byAgent(r.provider.requests, 'director')[0]!;
    expect(d.responseSchema?.name).toBe('director_plan');
    expect(JSON.stringify(d.responseSchema?.schema)).toContain('"description"');
    expect(textOfMsg(d.messages[0]!)).not.toContain('## How to answer');
    expect(recordOf(msgRow(r.home, s.id, one.turn.messageId).dir)).toMatchObject({ ok: true, transport: 'structured' });

    const two = await say(s, 'Again.');
    expect(directorEvents(two.evs).map((e) => e.reason)).toEqual([undefined, 'transport_unsupported']);
    expect(noticeCodes(two.evs)).toEqual(['caps.suggest']);
    const three = await say(s, 'Once more.');
    expect(noticeCodes(three.evs)).toEqual([]);
    expect(three.out.type).toBe('done');
    await r.engine.close();
  });
});

