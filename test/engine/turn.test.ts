// The turn state machine on the scripted provider: reply, swipe, continue, stop, retry, fallback,
// failures, empty answers, vars, checkpoints, timeouts, the semaphore.
import { describe, expect, test } from 'bun:test';
import type { TurnOutcome } from '../../src/engine/api.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { CONTINUE_CUE } from '../../src/prompt/shape.ts';
import { applyDelta, type Event } from '../../src/protocol/events.ts';
import type { ChkEntry, Entry, MsgEntry, PrepEntry, TurnEntry } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, runs, scriptConn, since, textOf, types, until, withUserMessage } from './kit.ts';

const ofType = <T extends Entry['t']>(es: Entry[], t: T): Extract<Entry, { t: T }>[] =>
  es.filter((e) => e.t === t) as Extract<Entry, { t: T }>[];

function expectDone(o: TurnOutcome): Extract<TurnOutcome, { type: 'done' }> {
  if (o.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(o)}`);
  return o;
}
function expectFailed(o: TurnOutcome): Extract<TurnOutcome, { type: 'failed' }> {
  if (o.type !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(o)}`);
  return o;
}

describe('reply', () => {
  test('happy path: turn, prep, chk*, msg; start, text…, changed, done', async () => {
    const { engine, home, provider } = await rig(
      calls([{ text: 'She looks up ' }, { text: 'from the map, ' }, { text: 'smiling.' }, { usage: { inputTotal: 120, outputTotal: 9, cost: 0.001 } }]),
    );
    const { s, version, userId } = withUserMessage(engine, 'What are you drawing?');
    const seq0 = s.version();
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    expect(s.busy()).toBe(true);
    const evs = await drain(turn);
    const outcome = expectDone(await turn.result);
    expect(s.busy()).toBe(false);

    // Events
    expect(runs(types(evs))).toEqual(['start', 'text', 'usage', 'changed', 'done']);
    expect(evs[0]).toMatchObject({ type: 'start', kind: 'reply', messageId: turn.messageId, parentId: userId, turnId: turn.turnId });
    let copy = '';
    for (const e of evs) if (e.type === 'text') copy = applyDelta(copy, e);
    expect(copy).toBe('She looks up from the map, smiling.');
    const usage = evs.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ callKey: `${turn.turnId}:narrator:0`, agent: 'narrator', model: 'script:default', costUsd: 0.001, priceSource: 'provider' });

    // Journal
    const written = since(home, s.id, seq0);
    const kinds = written.map((e) => e.t);
    expect(kinds[0]).toBe('turn');
    expect(kinds[1]).toBe('prep');
    expect(kinds.at(-1)).toBe('msg');
    expect(kinds.slice(2, -1).every((k) => k === 'chk')).toBe(true);
    expect(kinds.filter((k) => k === 'chk').length).toBeGreaterThanOrEqual(2);
    const chkText = ofType(written, 'chk').map((c: ChkEntry) => c.text).join('');
    expect(chkText).toBe('She looks up from the map, smiling.');
    const t = written[0] as TurnEntry;
    expect(t).toMatchObject({ kind: 'reply', parent: userId, msgId: turn.messageId, base: version });
    const msg = written.at(-1) as MsgEntry;
    expect(msg).toMatchObject({ id: turn.messageId, parent: userId, role: 'assistant', turn: turn.turnId });
    expect(msg.blocks).toEqual([{ k: 'text', text: 'She looks up from the map, smiling.' }]);
    expect(msg.gen).toMatchObject({
      kind: 'model',
      connection: 'script',
      model: 'default',
      finish: 'end',
      transport: 'none',
      rounds: 1,
      route: [{ model: 'script:default', status: 'ok' }],
      usage: { inputTotal: 120, outputTotal: 9, cost: 0.001 },
    });
    expect(msg.gen?.preset?.name).toBe('builtin');
    expect(msg.gen?.preset?.hash).toMatch(/^[0-9a-f]+$/);
    expect(msg.trace?.seed).toBe(t.seed);
    expect(msg.trace?.now).toBe(t.now);
    expect(msg.trace?.tokens.reported).toBe(120);
    expect(msg.trace?.calls).toHaveLength(1);

    // The view and the request
    expect(s.view().head).toBe(turn.messageId);
    expect(textOf(outcome.message)).toBe('She looks up from the map, smiling.');
    const req = provider.requests[0]!;
    expect(req.callKey).toBe(`${turn.turnId}:narrator:0`);
    expect(req.agent).toBe('narrator');
    expect(req.messages.at(-1)).toMatchObject({ role: 'user', src: 'history' });
    expect(req.maxTokens).toBe(2048); // reserve: min(2048, 8192/2) for the 8192 scripted window
    await engine.close();
  });

  test('a preset prefill is sent, announced, recorded in prep and gen, and not part of the text', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'and so it begins.' }]));
    const { saveToLibrary } = await import('../../src/formats/library.ts');
    const { BUILTIN_PRESET } = await import('../../src/formats/native.ts');
    const { id } = saveToLibrary(home, 'presets', 'Prefilled', { ...BUILTIN_PRESET, name: 'Prefilled', prefill: '*{{char}} nods*' });
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset: id } });
    const sent = s.send({ text: 'Go on.', expectedVersion: s.version() });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: sent.version });
    const evs = await drain(turn);
    expect(evs.find((e) => e.type === 'prefill')).toMatchObject({ text: '*Mira nods*' });
    expect(provider.requests[0]!.prefill).toBe('*Mira nods*');
    const prep = ofType(entriesOf(home, s.id), 'prep')[0] as PrepEntry;
    expect(prep.prefill).toBe('*Mira nods*');
    const done = expectDone(await turn.result);
    expect(textOf(done.message)).toBe('and so it begins.');
    expect(done.message.gen?.prefill).toBe('*Mira nods*');
    expect(done.message.gen?.preset?.name).toBe(id);
    await engine.close();
  });

  test('prefill notices come once per session (D-28)', async () => {
    const caps = { ...SCRIPT_CAPS, prefill: 'none' as const };
    const { engine, home } = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }]), { caps });
    const { saveToLibrary } = await import('../../src/formats/library.ts');
    const { BUILTIN_PRESET } = await import('../../src/formats/native.ts');
    const { id } = saveToLibrary(home, 'presets', 'P', { ...BUILTIN_PRESET, name: 'P', prefill: 'Sure:' });
    const s = engine.createSession({ character: MIRA, config: { preset: id } });
    const v1 = s.send({ text: 'a', expectedVersion: s.version() }).version;
    const first = await drain(s.runTurn({ kind: 'reply', expectedVersion: v1 }));
    const v2 = s.send({ text: 'b', expectedVersion: s.version() }).version;
    const second = await drain(s.runTurn({ kind: 'reply', expectedVersion: v2 }));
    const codes = (evs: Event[]) => evs.filter((e) => e.type === 'notice').map((e) => (e as { code: string }).code);
    expect(codes(first)).toEqual(['prefill_unsupported']);
    expect(codes(second)).toEqual([]);
    expect(first.some((e) => e.type === 'prefill')).toBe(false);
    await engine.close();
  });

  test('reasoning is a separate block before the text', async () => {
    const { engine } = await rig(calls([{ reasoning: 'She is tired.' }, { text: 'Yawns.' }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs = await drain(turn);
    expect(evs.find((e) => e.type === 'reasoning')).toMatchObject({ delta: 'She is tired.', offset: 0 });
    const done = expectDone(await turn.result);
    expect(done.message.blocks).toEqual([
      { k: 'reasoning', text: 'She is tired.' },
      { k: 'text', text: 'Yawns.' },
    ]);
    await engine.close();
  });

  test('the ms cadence writes a chk before the char threshold is reached', async () => {
    const { engine, home } = await rig(calls([{ text: 'ab' }, { delay: 40 }, { text: 'cd' }]), {
      extra: { checkpoint: { chars: 1000, ms: 5, datasyncMs: 5 } },
    });
    const { s, version } = withUserMessage(engine);
    const seq0 = s.version();
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    expect(ofType(since(home, s.id, seq0), 'chk').map((c) => c.text)).toEqual(['ab', 'cd']);
    await engine.close();
  });

  test('submit = send + reply', async () => {
    const { engine } = await rig(calls([{ text: 'Sure.' }]));
    const s = engine.createSession({ character: MIRA });
    const turn = s.submit({ text: 'Help?', expectedVersion: s.version() });
    expectDone(await turn.result);
    expect(s.view().path.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    await engine.close();
  });
});

describe('swipe', () => {
  test('a swipe is a sibling of the replaced answer under the same U, with a new seed', async () => {
    const { engine, home } = await rig(calls([{ text: 'First.' }], [{ text: 'Second.' }]));
    const { s, version, userId } = withUserMessage(engine);
    const first = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(first);
    const second = s.runTurn({ kind: 'swipe', expectedVersion: s.version() });
    const evs = await drain(second);
    expect(evs[0]).toMatchObject({ type: 'start', kind: 'swipe', parentId: userId });
    const done = expectDone(await second.result);
    expect(done.message.parent).toBe(userId);
    expect(done.message.swipe).toEqual({ index: 1, count: 2 });
    expect(s.view().head).toBe(second.messageId);
    expect(s.view().tails).toContain(first.messageId);
    const turns = ofType(entriesOf(home, s.id), 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ kind: 'swipe', parent: userId, target: first.messageId });
    expect(turns[1]!.seed).not.toBe(turns[0]!.seed);
    await engine.close();
  });

  test('guided re-roll: guidance reaches the prompt with the rejected draft and gen.guidance', async () => {
    const { engine, provider } = await rig(calls([{ text: 'Rejected text.' }], [{ text: 'Better.' }]));
    const { s, version } = withUserMessage(engine);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    const turn = s.runTurn({ kind: 'swipe', expectedVersion: s.version(), guidance: '  Make it rain.  ' });
    const done = expectDone(await turn.result);
    expect(done.message.gen?.guidance).toBe('Make it rain.');
    const g = provider.requests[1]!.messages.find((m) => m.src === 'guidance');
    expect(g).toBeDefined();
    const text = textOf(g!);
    expect(text).toContain('Make it rain.');
    expect(text).toContain('Rejected text.');
    // The replaced answer is not in the history of the swipe request.
    expect(provider.requests[1]!.messages.filter((m) => m.src === 'history').map(textOf)).not.toContain('Rejected text.');
    await engine.close();
  });
});

describe('continue', () => {
  test('prefill mode: the target text is the prefill, the addition is glued as is', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'She nods.' }], [{ text: ' Then she smiles.' }]));
    const { s, version } = withUserMessage(engine);
    const first = s.runTurn({ kind: 'reply', expectedVersion: version });
    await drain(first);
    const seq0 = s.version();
    const turn = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    expect(turn.messageId).toBe(first.messageId);
    const evs = await drain(turn);
    expect(evs.find((e) => e.type === 'prefill')).toBeUndefined();
    const done = expectDone(await turn.result);
    expect(textOf(done.message)).toBe('She nods. Then she smiles.');
    expect(provider.requests[1]!.prefill).toBe('She nods.');
    const written = since(home, s.id, seq0);
    expect(written.map((e) => e.t).filter((t) => t !== 'chk')).toEqual(['turn', 'prep', 'edit']);
    expect((written[1] as PrepEntry).cont).toEqual({ mode: 'prefill', base: 'She nods.' });
    expect(written.at(-1)).toMatchObject({ t: 'edit', target: first.messageId, reason: 'continue', turn: turn.turnId });
    expect(evs.find((e) => e.type === 'changed')).toMatchObject({ change: 'edit', id: first.messageId });
    expect(done.message.edited).toBe(false); // a continue is not a human edit
    await engine.close();
  });

  test('cue mode (caps.prefill none): a user cue follows the target, the addition joins after a blank line', async () => {
    const caps = { ...SCRIPT_CAPS, prefill: 'none' as const };
    const { engine, home, provider } = await rig(calls([{ text: 'She nods.' }], [{ text: 'Then she smiles.' }]), { caps });
    const { s, version } = withUserMessage(engine);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    const turn = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    const done = expectDone(await turn.result);
    expect(textOf(done.message)).toBe('She nods.\n\nThen she smiles.');
    const req = provider.requests[1]!;
    expect(req.prefill).toBeUndefined();
    expect(textOf(req.messages.at(-1)!)).toBe(CONTINUE_CUE);
    expect(ofType(entriesOf(home, s.id), 'prep').at(-1)!.cont).toEqual({ mode: 'cue', base: 'She nods.' });
    await engine.close();
  });

  test('nothing_to_add: an echo of the base adds nothing → failed + end', async () => {
    const { engine, home } = await rig(calls([{ text: 'She nods.' }], [{ text: 'She nods.' }]));
    const { s, version } = withUserMessage(engine);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    const v = s.version();
    const turn = s.runTurn({ kind: 'continue', expectedVersion: v });
    const evs = await drain(turn);
    const f = expectFailed(await turn.result);
    expect(f.code).toBe('nothing_to_add');
    expect(types(evs).at(-1)).toBe('failed');
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'nothing_to_add' });
    expect(s.version()).toBe(v);
    expect(textOf(s.view().path.at(-1)!)).toBe('She nods.');
    await engine.close();
  });
});

describe('stop', () => {
  test('with text: committed with finish stopped, event stopped{message}', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'Half a' }, { pause: 'p' }, { text: ' sentence.' }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs: Event[] = [];
    for await (const ev of turn.events) {
      evs.push(ev);
      if (ev.type === 'text') turn.stop();
    }
    const o = await turn.result;
    expect(o.type).toBe('stopped');
    if (o.type === 'stopped') {
      expect(textOf(o.message!)).toBe('Half a');
      expect(o.message!.gen?.finish).toBe('stopped');
    }
    expect(types(evs).slice(-2)).toEqual(['changed', 'stopped']);
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'msg' });
    provider.release('p');
    await engine.close();
  });

  test('without text: end{stopped-empty}, stopped{message:null}', async () => {
    const { engine, home } = await rig(calls([{ pause: 'p' }, { text: 'never' }]));
    const { s, version } = withUserMessage(engine);
    const v = s.version();
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await until(() => entriesOf(home, s.id).some((e) => e.t === 'prep'));
    s.stop(turn.turnId);
    const evs = await drain(turn);
    expect(await turn.result).toEqual({ type: 'stopped', message: null });
    expect(evs.at(-1)).toMatchObject({ type: 'stopped', message: null });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'stopped-empty' });
    expect(s.version()).toBe(v);
    await engine.close();
  });

  test('a stopped continue keeps its addition as an edit with finish stopped', async () => {
    const { engine, provider } = await rig(calls([{ text: 'She nods.' }], [{ text: ' And then' }, { pause: 'p' }, { text: ' more.' }]));
    const { s, version } = withUserMessage(engine);
    await drain(s.runTurn({ kind: 'reply', expectedVersion: version }));
    const turn = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    for await (const ev of turn.events) if (ev.type === 'text') turn.stop();
    const o = await turn.result;
    expect(o.type).toBe('stopped');
    if (o.type === 'stopped') {
      expect(textOf(o.message!)).toBe('She nods. And then');
      expect(o.message!.gen?.finish).toBe('stopped');
    }
    provider.release('p');
    await engine.close();
  });

  test('stop() of another turn id or with nothing running is a no-op', async () => {
    const { engine } = await rig(calls([{ text: 'ok' }]));
    const { s, version } = withUserMessage(engine);
    s.stop();
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    s.stop('t_other');
    expectDone(await turn.result);
    await engine.close();
  });
});

describe('retry and fallback', () => {
  test('a 429 before any output is retried once on the same model', async () => {
    const { engine, provider } = await rig(
      calls([{ error: { code: 'rate_limited', status: 429, retryAfterSec: 30 } }], [{ text: 'Second try.' }]),
    );
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs = await drain(turn);
    const retry = evs.find((e) => e.type === 'retry');
    expect(retry).toMatchObject({ attempt: 1, code: 'rate_limited', status: 429, callKey: `${turn.turnId}:narrator:0` });
    // retry-after 30 s is capped by retryMaxDelayMs (5 ms in the rig), plus at most a little jitter
    expect((retry as { delayMs: number }).delayMs).toBeLessThanOrEqual(6);
    const done = expectDone(await turn.result);
    expect(textOf(done.message)).toBe('Second try.');
    expect(done.message.gen?.route).toEqual([
      { model: 'script:default', status: 'retry', code: 'rate_limited' },
      { model: 'script:default', status: 'ok' },
    ]);
    expect(provider.requests).toHaveLength(2);
    await engine.close();
  });

  test('after the retry fails too, one fallback attempt on another connection:model', async () => {
    const backup = scriptConn('backup', calls([{ text: 'From the backup.' }]));
    const { engine, provider } = await rig(
      calls([{ error: { code: 'overloaded', status: 503 } }], [{ error: { code: 'overloaded', status: 503 } }]),
      { connections: { backup: backup.conn } },
    );
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version, fallback: 'backup:big' });
    const evs = await drain(turn);
    const done = expectDone(await turn.result);
    expect(textOf(done.message)).toBe('From the backup.');
    expect(done.message.gen).toMatchObject({ connection: 'backup', model: 'big' });
    expect(done.message.gen?.route).toEqual([
      { model: 'script:default', status: 'retry', code: 'overloaded' },
      { model: 'script:default', status: 'error', code: 'overloaded' },
      { model: 'backup:big', status: 'ok' },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(backup.provider.requests[0]!.model).toEqual({ connection: 'backup', model: 'big' });
    expect(evs.some((e) => e.type === 'notice' && e.code === 'fallback')).toBe(true);
    await engine.close();
  });

  test("the binding's fallback is used when the call names none", async () => {
    const backup = scriptConn('backup', calls([{ text: 'Backup.' }]));
    const { engine } = await rig(calls([{ error: { code: 'overloaded', status: 529 } }], [{ error: { code: 'overloaded', status: 529 } }]), {
      connections: { backup: backup.conn },
    });
    const s = engine.createSession({
      character: MIRA,
      config: { roles: { narrator: { conn: 'script', model: 'default', fallback: { conn: 'backup', model: 'b' } } } },
    });
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    const done = expectDone(await s.runTurn({ kind: 'reply', expectedVersion: sent.version }).result);
    expect(done.message.gen?.connection).toBe('backup');
    await engine.close();
  });

  test('non-retryable errors and errors without a status fail at once (no retry, no fallback)', async () => {
    const backup = scriptConn('backup', calls([{ text: 'unused' }]));
    const { engine, home, provider } = await rig(calls([{ error: { code: 'auth_failed', status: 401 } }], [{ error: { code: 'timeout' } }]), {
      connections: { backup: backup.conn },
    });
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version, fallback: 'backup:b' }).result);
    expect(f).toMatchObject({ category: 'auth', code: 'auth_failed', draft: '' });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'auth_failed' });
    const f2 = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'backup:b' }).result);
    expect(f2.code).toBe('timeout');
    expect(provider.requests).toHaveLength(2);
    expect(backup.provider.requests).toHaveLength(0);
    await engine.close();
  });

  test('a stop during the retry wait ends stopped-empty and never reaches the fallback', async () => {
    const backup = scriptConn('backup', calls([{ text: 'unused' }]));
    const { engine, home } = await rig(calls([{ error: { code: 'rate_limited', status: 429, retryAfterSec: 5 } }]), {
      connections: { backup: backup.conn },
      extra: { retryMaxDelayMs: 10_000 },
    });
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version, fallback: 'backup:b' });
    for await (const ev of turn.events) if (ev.type === 'retry') turn.stop();
    expect(await turn.result).toEqual({ type: 'stopped', message: null });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'stopped-empty' });
    expect(backup.provider.requests).toHaveLength(0);
    await engine.close();
  });
});

describe('failures', () => {
  const afterOutput = () => calls([{ text: 'Partial' }, { error: { code: 'overloaded', status: 503, afterOutput: true } }]);

  test("after output with onError 'drop' (default): end{failed}, draft only in the event", async () => {
    const { engine, home, provider } = await rig(afterOutput());
    const { s, version } = withUserMessage(engine);
    const v = s.version();
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs = await drain(turn);
    const f = expectFailed(await turn.result);
    expect(f).toMatchObject({ category: 'server', code: 'overloaded', draft: 'Partial' });
    expect(evs.at(-1)).toMatchObject({ type: 'failed', draft: 'Partial' });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'overloaded' });
    expect(s.version()).toBe(v);
    expect(provider.requests).toHaveLength(1); // never retried after output
    await engine.close();
  });

  test("after output with onError 'keep': committed as interrupted, then failed", async () => {
    const { engine, home } = await rig(afterOutput());
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version, onError: 'keep' });
    const evs = await drain(turn);
    const f = expectFailed(await turn.result);
    expect(f.draft).toBe('Partial');
    expect(types(evs).slice(-2)).toEqual(['changed', 'failed']);
    const msg = entriesOf(home, s.id).at(-1) as MsgEntry;
    expect(msg).toMatchObject({ t: 'msg', id: turn.messageId });
    expect(msg.gen?.finish).toBe('interrupted');
    expect(textOf(s.view().path.at(-1)!)).toBe('Partial');
    await engine.close();
  });

  test('truncated_stream: a stream that ends without finish', async () => {
    const { engine, home } = await rig(calls([{ text: 'abc' }, { cut: true }], [{ cut: true }]));
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(f).toMatchObject({ category: 'network', code: 'truncated_stream', draft: 'abc' });
    const f2 = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: s.version() }).result);
    expect(f2).toMatchObject({ code: 'truncated_stream', draft: '' });
    expect(ofType(entriesOf(home, s.id), 'end').map((e) => e.code)).toEqual(['truncated_stream', 'truncated_stream']);
    await engine.close();
  });

  test('empty_response: no text and no reasoning', async () => {
    const { engine, home } = await rig(calls([], [{ finish: 'content_filter' }]));
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(f).toMatchObject({ category: 'protocol', code: 'empty_response', draft: '' });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'empty_response' });
    const f2 = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: s.version() }).result);
    expect(f2).toMatchObject({ category: 'content', code: 'content_filter' });
    await engine.close();
  });

  test("reasoning only: 'fail' (default) → reasoning_only with the reasoning as draft", async () => {
    const { engine, home } = await rig(calls([{ reasoning: 'Thinking hard.' }]));
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(f).toMatchObject({ code: 'reasoning_only', draft: 'Thinking hard.' });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'reasoning_only' });
    await engine.close();
  });

  test("reasoning only: 'keep' → an empty text block after the reasoning", async () => {
    const { engine } = await rig(calls([{ reasoning: 'Thinking hard.' }]));
    const { s, version } = withUserMessage(engine);
    const done = expectDone(await s.runTurn({ kind: 'reply', expectedVersion: version, emptyReply: 'keep' }).result);
    expect(done.message.blocks).toEqual([
      { k: 'reasoning', text: 'Thinking hard.' },
      { k: 'text', text: '' },
    ]);
    await engine.close();
  });

  test('answerInReasoning caps: the reasoning field is the reply', async () => {
    const caps = { ...SCRIPT_CAPS, reasoning: { ...SCRIPT_CAPS.reasoning, answerInReasoning: true } };
    const { engine } = await rig(calls([{ reasoning: 'The answer.' }]), { caps });
    const { s, version } = withUserMessage(engine);
    const done = expectDone(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(done.message.blocks).toEqual([{ k: 'text', text: 'The answer.' }]);
    await engine.close();
  });

  test('script_exhausted and assemble failures end the turn with failed', async () => {
    const { engine, home } = await rig([]);
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(f.code).toBe('script_exhausted');
    // A window too small for the mandatory part: context_length_exceeded before anything is sent.
    s.configure({ window: 10 });
    const f2 = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: s.version() }).result);
    expect(f2).toMatchObject({ category: 'request', code: 'context_length_exceeded', draft: '' });
    const last = entriesOf(home, s.id).slice(-2);
    expect(last.map((e) => e.t)).toEqual(['turn', 'end']); // no prep: nothing was sent
    await engine.close();
  });
});

describe('timeouts', () => {
  test('first byte: a timeout is a failure (network/timeout), never a stop', async () => {
    const { engine, home } = await rig(calls([{ delay: 300 }, { text: 'late' }]), { extra: { timeouts: { firstByteMs: 20 } } });
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(f).toMatchObject({ category: 'network', code: 'timeout', draft: '' });
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'end', outcome: 'failed', code: 'timeout' });
    await engine.close();
  });

  test('idle: a stall after output fails with the draft', async () => {
    const { engine } = await rig(calls([{ text: 'Some' }, { delay: 300 }, { text: ' more' }]), { extra: { timeouts: { idleMs: 20 } } });
    const { s, version } = withUserMessage(engine);
    const f = expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(f).toMatchObject({ code: 'timeout', draft: 'Some' });
    await engine.close();
  });
});

describe('vars (D-30)', () => {
  const noteSetsVar = { authorNote: { text: '{{setvar::mood::happy}}', depth: 4, role: 'system' as const } };

  test('the diff is committed with the answer and folds into the view', async () => {
    const { engine, home } = await rig(calls([{ text: 'Smiles.' }]));
    const s = engine.createSession({ character: MIRA, config: noteSetsVar });
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    expect(s.view().vars).toEqual({});
    const done = expectDone(await s.runTurn({ kind: 'reply', expectedVersion: sent.version }).result);
    const msg = ofType(entriesOf(home, s.id), 'msg').find((m) => m.id === done.message.id)!;
    expect(msg.vars).toEqual({ mood: 'happy' });
    expect(s.view().vars).toEqual({ mood: 'happy' });
    await engine.close();
  });

  test('a failed turn changes no variable (the diff stays in prep only)', async () => {
    const { engine, home } = await rig(calls([{ error: { code: 'bad_request', status: 400 } }]));
    const s = engine.createSession({ character: MIRA, config: noteSetsVar });
    const sent = s.send({ text: 'Hi', expectedVersion: s.version() });
    expectFailed(await s.runTurn({ kind: 'reply', expectedVersion: sent.version }).result);
    expect(ofType(entriesOf(home, s.id), 'prep')[0]!.vars).toEqual({ mood: 'happy' });
    expect(ofType(entriesOf(home, s.id), 'msg').some((m) => m.vars)).toBe(false);
    expect(s.view().vars).toEqual({});
    await engine.close();
  });
});

describe('semaphore', () => {
  test('two sessions on one single-slot origin take turns', async () => {
    const { engine, provider } = await rig(calls([{ text: 'A1' }, { pause: 'a' }, { text: '.' }], [{ text: 'B1.' }]));
    const a = withUserMessage(engine);
    const b = withUserMessage(engine);
    const ta = a.s.runTurn({ kind: 'reply', expectedVersion: a.version });
    await until(() => provider.requests.length === 1);
    const tb = b.s.runTurn({ kind: 'reply', expectedVersion: b.version });
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.requests).toHaveLength(1); // B waits for A's place
    provider.release('a');
    expectDone(await ta.result);
    expectDone(await tb.result);
    expect(provider.requests).toHaveLength(2);
    await engine.close();
  });
});
