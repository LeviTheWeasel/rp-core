// Regression tests for the turn's durability and state rules found in review: an answer in hand is
// never thrown away after its finish, a stop is never invented, refusals write nothing, a session
// is created whole, a stolen lock fails the turn instead of reporting success, and the swipe, the
// token limit and the trace follow the state and the request the turn actually had.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal, type TurnOutcome } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import { saveToLibrary } from '../../src/formats/library.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { ProviderError, type ModelRequest, type Provider, type StreamEv } from '../../src/providers/types.ts';
import type { Entry, MsgEntry } from '../../src/session/entries.ts';
import { sessionsDir } from '../../src/session/log.ts';
import { fakeRandom, tmpHome } from '../helpers.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, until, withUserMessage } from './kit.ts';

const msgs = (es: Entry[]): MsgEntry[] => es.filter((e): e is MsgEntry => e.t === 'msg');

function expectDone(o: TurnOutcome): Extract<TurnOutcome, { type: 'done' }> {
  if (o.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(o)}`);
  return o;
}

/** A provider that sends a whole answer and its finish, then does `after` (stall, fail, …). */
function finishedThen(after: (req: ModelRequest) => AsyncGenerator<StreamEv>, onFinished?: () => void): Provider {
  return {
    stream(req: ModelRequest): AsyncIterable<StreamEv> {
      return (async function* () {
        yield { t: 'text', i: 0, d: 'The whole answer.' };
        yield { t: 'finish', reason: 'end', raw: 'stop' };
        onFinished?.();
        yield* after(req);
      })();
    },
  };
}

/** Waits for the call's abort (a stall until the idle timeout, or a Stop), then throws its reason. */
async function* stallUntilAbort(req: ModelRequest): AsyncGenerator<StreamEv> {
  await new Promise<void>((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
}

async function engineWith(provider: Provider, idleMs = 50) {
  const home = tmpHome();
  const engine = await Engine.open({
    home,
    connections: { script: { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:x', local: true } },
    random: fakeRandom(3),
    timeZone: 'UTC',
    timeouts: { idleMs },
  });
  return { home, engine };
}

describe('after the finish, the answer stands (§8.1, §19.2)', () => {
  test('a stall before the stream closes: done with the provider finish, a notice, no failure', async () => {
    const { home, engine } = await engineWith(finishedThen(stallUntilAbort));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const evs = await drain(turn);
    const done = expectDone(await turn.result);
    expect(done.message.gen?.finish).toBe('end');
    expect(evs.some((e) => e.type === 'notice' && e.code === 'stream_tail_failed')).toBe(true);
    expect(entriesOf(home, s.id).at(-1)).toMatchObject({ t: 'msg', blocks: [{ k: 'text', text: 'The whole answer.' }] });
    await engine.close();
  });

  test('an error event after the finish does not discard the answer', async () => {
    const provider = finishedThen(async function* () {
      yield { t: 'error', err: new ProviderError({ category: 'server', code: 'overloaded', status: 529, afterOutput: true }), afterOutput: true };
    });
    const { engine } = await engineWith(provider);
    const { s, version } = withUserMessage(engine);
    const done = expectDone(await s.runTurn({ kind: 'reply', expectedVersion: version, onError: 'drop' }).result);
    expect(done.message.gen?.finish).toBe('end');
    await engine.close();
  });

  test('a Stop after the finish does not relabel a complete answer as stopped', async () => {
    let finished = false;
    const { engine } = await engineWith(finishedThen(stallUntilAbort, () => (finished = true)), 60_000);
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await until(() => finished);
    turn.stop();
    const done = expectDone(await turn.result);
    expect(done.message.gen?.finish).toBe('end');
    await engine.close();
  });
});

describe('the engine never invents a stop', () => {
  test("a provider finish 'stopped' (or 'interrupted') is recorded as a natural end", async () => {
    const { engine } = await rig(calls([{ text: 'Done.' }, { finish: 'stopped' }], [{ text: 'Again.' }, { finish: 'interrupted' }]));
    const { s, version } = withUserMessage(engine);
    const first = expectDone(await s.runTurn({ kind: 'reply', expectedVersion: version }).result);
    expect(first.message.gen?.finish).toBe('end');
    const second = expectDone(await s.runTurn({ kind: 'swipe', expectedVersion: s.version() }).result);
    expect(second.message.gen?.finish).toBe('end');
    await engine.close();
  });
});

describe('refusals write nothing (§6.1)', () => {
  test('submit with an invalid onError is refused before the user line is written', async () => {
    const { engine, home } = await rig(calls([{ text: 'x' }]));
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    const before = entriesOf(home, s.id).length;
    let code = '';
    try {
      s.submit({ text: 'hello', expectedVersion: s.version(), onError: 'bogus' as never });
    } catch (e) {
      code = e instanceof Refusal ? e.code : String(e);
    }
    expect(code).toBe('invalid_params');
    expect(entriesOf(home, s.id).length).toBe(before);
    expect(s.busy()).toBe(false);
    await engine.close();
  });
});

describe('session creation is one atomic file (§5.5)', () => {
  test('header, every greeting and the head on greeting 0 appear together; no temp file is left', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: { ...MIRA, greetings: ['One.', 'Two.', 'Three.'] }, persona: LEVI });
    const lines = readFileSync(join(sessionsDir(home), `${s.id}.jsonl`), 'utf8').trimEnd().split('\n');
    const kinds = lines.map((l) => (JSON.parse(l) as { t: string }).t);
    expect(kinds).toEqual(['session', 'msg', 'msg', 'msg', 'head']);
    const roots = msgs(entriesOf(home, s.id));
    expect(s.view().head).toBe(roots[0]!.id);
    expect(readdirSync(sessionsDir(home)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await engine.close();
  });
});

describe('a stolen lock fails the turn, it never reports success', () => {
  test('another writer extends the journal mid-turn: failed{session_locked}, nothing committed', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'Part one. ' }, { pause: 'p' }, { text: 'Part two.' }]));
    const { s, version } = withUserMessage(engine);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await until(() => provider.requests.length === 1);
    // Another process stole the (seemingly stale) lock and wrote a line meanwhile.
    const file = join(sessionsDir(home), `${s.id}.jsonl`);
    const seq = (entriesOf(home, s.id).at(-1)?.seq ?? 0) + 1;
    writeFileSync(join(sessionsDir(home), `${s.id}.lock`), JSON.stringify({ pid: 4242, host: 'elsewhere', started: 'x', renewed: '2026-10-26T12:00:00.000Z' }));
    appendFileSync(file, `${JSON.stringify({ t: 'config', seq, ts: '2026-10-26T12:00:00.000Z', patch: { window: 4096 } })}\n`);
    provider.release('p');
    const outcome = await turn.result;
    expect(outcome).toMatchObject({ type: 'failed', category: 'conflict', code: 'session_locked', draft: 'Part one. Part two.' });
    const after = entriesOf(home, s.id);
    expect(msgs(after).some((m) => m.id === turn.messageId)).toBe(false);
    expect(after.at(-1)).toMatchObject({ t: 'config', seq });
    // Later verbs are refused as session_locked (a refusal: nothing written), not an internal error.
    let code = '';
    try {
      s.send({ text: 'still here?', expectedVersion: s.version() });
    } catch (e) {
      code = e instanceof Refusal ? e.code : String(e);
    }
    expect(code).toBe('session_locked');
    expect(entriesOf(home, s.id).length).toBe(after.length);
    await engine.close();
  });
});

describe('the turn sees the state and request it really has', () => {
  test('a swipe expands macros against the variables at U, not after the answer it replaces (§6.3)', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'first' }], [{ text: 'second' }], [{ text: 'third' }]));
    const blocks = BUILTIN_PRESET.blocks.map((b) => (b.id === 'main' ? { ...b, content: 'COUNTER={{incvar::n}}' } : b));
    saveToLibrary(home, 'presets', 'counter', { ...BUILTIN_PRESET, name: 'counter', blocks });
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset: 'counter' } });
    await drain(s.submit({ text: 'hi', expectedVersion: s.version() }));
    await drain(s.runTurn({ kind: 'swipe', expectedVersion: s.version() }));
    await drain(s.runTurn({ kind: 'swipe', expectedVersion: s.version() }));
    const main = (i: number) => (provider.requests[i]!.messages[0]!.blocks[0] as { text: string }).text;
    expect([main(0), main(1), main(2)]).toEqual(['COUNTER=1', 'COUNTER=1', 'COUNTER=1']);
    const answers = msgs(entriesOf(home, s.id)).filter((m) => m.role === 'assistant' && m.gen?.kind === 'model');
    expect(answers.map((m) => m.vars)).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
    expect(s.view().vars).toEqual({ n: 1 });
    await engine.close();
  });

  test("the preset's samplers.max_tokens sets the reserve and the request limit, sent once (D-89)", async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'ok' }], [{ text: 'ok' }]));
    saveToLibrary(home, 'presets', 'small', { ...BUILTIN_PRESET, name: 'small', samplers: { max_tokens: 300, temperature: 0.7 } });
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { preset: 'small' } });
    await drain(s.submit({ text: 'hi', expectedVersion: s.version() }));
    const req = provider.requests[0]!;
    expect(req.maxTokens).toBe(300);
    expect(req.samplers).toEqual({ temperature: 0.7 });
    const prep = entriesOf(home, s.id).find((e) => e.t === 'prep') as { trace: { reserve: number } };
    expect(prep.trace.reserve).toBe(300);
    // The binding's maxTokens still wins over the preset.
    s.configure({ roles: { narrator: { conn: 'script', model: 'default', maxTokens: 120 } } });
    await drain(s.runTurn({ kind: 'swipe', expectedVersion: s.version() }));
    expect(provider.requests[1]!.maxTokens).toBe(120);
    await engine.close();
  });

  test('a continue trace lists exactly the messages sent (§5.7), in prefill and in cue mode', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'She nods' }], [{ text: ' and smiles.' }]));
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    await drain(s.submit({ text: 'hi', expectedVersion: s.version() }));
    await drain(s.runTurn({ kind: 'continue', expectedVersion: s.version() }));
    const sent = provider.requests[1]!;
    const edit = entriesOf(home, s.id).find((e) => e.t === 'edit' && e.reason === 'continue') as { trace: { blocks: { src: string; role: string }[] } };
    expect(edit.trace.blocks.map((b) => `${b.role}|${b.src}`)).toEqual(sent.messages.map((m) => `${m.role}|${m.src}`));
    const prep = entriesOf(home, s.id).filter((e) => e.t === 'prep').at(-1) as { trace: { blocks: unknown[] } };
    expect(prep.trace.blocks.length).toBe(sent.messages.length);
    await engine.close();

    const cue = await rig(calls([{ text: 'She nods' }], [{ text: 'And smiles.' }]), { caps: { ...SCRIPT_CAPS, prefill: 'none' } });
    const c = cue.engine.createSession({ character: MIRA, persona: LEVI });
    await drain(c.submit({ text: 'hi', expectedVersion: c.version() }));
    await drain(c.runTurn({ kind: 'continue', expectedVersion: c.version() }));
    const cueSent = cue.provider.requests[1]!;
    const cueEdit = entriesOf(cue.home, c.id).find((e) => e.t === 'edit' && e.reason === 'continue') as { trace: { blocks: { src: string }[] } };
    expect(cueEdit.trace.blocks.map((b) => b.src)).toEqual(cueSent.messages.map((m) => m.src));
    expect(cueEdit.trace.blocks.at(-1)!.src).toBe('continue_cue');
    await cue.engine.close();
  });

  test('a live commit as a tail is one msg line that keeps the head (§5.3)', async () => {
    const { engine, home, provider } = await rig(calls([{ text: 'Late ' }, { pause: 'p' }, { text: 'answer.' }]));
    const { s, version } = withUserMessage(engine);
    const g1 = msgs(entriesOf(home, s.id)).filter((m) => m.parent === null)[1]!.id;
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    await until(() => provider.requests.length === 1);
    s.select({ messageId: g1, exact: true, expectedVersion: version });
    provider.release('p');
    const evs = await drain(turn);
    expect((await turn.result).type).toBe('conflict');
    expect(evs.some((e) => e.type === 'conflict')).toBe(true);
    expect(s.commitAnyway(turn.turnId).outcome).toBe('committed');
    const last = entriesOf(home, s.id).at(-1)!;
    expect(last).toMatchObject({ t: 'msg', id: turn.messageId, tail: true });
    expect(s.view().head).toBe(g1);
    await engine.close();
  });
});
