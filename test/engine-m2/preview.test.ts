// M2 (§6.1 `preview`, §12.4 /preview, D-45): preview builds the request a turn would send through the
// turn's own request function, so its messages are the ones the provider then receives; it writes
// nothing and works while a turn runs; refusals come back as ok:false.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewResult, SessionHandle } from '../../src/engine/api.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import type { ModelRequest, Provider } from '../../src/providers/types.ts';
import { sessionsDir } from '../../src/session/log.ts';
import { scriptConn, until } from '../engine/kit.ts';
import { book, calls, drain, entriesOf, entry, LEVI, MIRA, presetWith, rig, run, say, session, writeLibrary } from './kit.ts';

const ok = (p: PreviewResult): Extract<PreviewResult, { ok: true }> => {
  if (!p.ok) throw new Error(`preview refused: ${p.code}: ${p.message}`);
  return p;
};

/** What of a ModelRequest the model sees (no signal, no call key). */
const seen = (req: ModelRequest) => ({
  messages: req.messages,
  prefill: req.prefill ?? null,
  maxTokens: req.maxTokens,
  samplers: req.samplers,
});
const seenOf = (p: Extract<PreviewResult, { ok: true }>) => ({ messages: p.messages, prefill: p.prefill, maxTokens: p.maxTokens, samplers: p.samplers });

/** A world book with a constant entry and a keyed one, so lore is part of what is compared. */
function lore(home: string): void {
  writeLibrary(
    home,
    'lorebooks',
    'w',
    book('World', [entry('sky', 'The sky is green here.', { constant: true }), entry('dragon', 'Dragons hoard maps.', { keys: ['dragon'], position: 'after' })]),
  );
}

/**
 * A preset and a book whose output depends on the turn's seed ({{random}}, a lore entry's chance):
 * a preview equals its turn only when both use one seed.
 */
function seeded(home: string): { preset: string; lorebooks: string[] } {
  writeLibrary(home, 'presets', 'rnd', presetWith('Roll: {{random::a::b::c::d::e::f::g::h::i::j::k::l}}. Play {{char}}.'));
  writeLibrary(
    home,
    'lorebooks',
    'luck',
    book('Luck', [1, 2, 3, 4, 5, 6].map((n) => entry(`coin${n}`, `Coin ${n} came up heads.`, { constant: true, probability: 50 }))),
  );
  lore(home);
  return { preset: 'rnd', lorebooks: ['w', 'luck'] };
}

/** The `turn` line of the turn that wrote message `id`. */
const turnLine = (home: string, sid: string, id: string) => entriesOf(home, sid).find((e) => e.t === 'turn' && e.msgId === id);

const journal = (home: string, s: SessionHandle): string => readFileSync(join(sessionsDir(home), `${s.id}.jsonl`), 'utf8');

describe('preview equals the next request', () => {
  test('reply: a user head', async () => {
    const r = await rig(calls([{ text: 'Mm.' }]));
    const { preset, lorebooks } = seeded(r.home);
    const { s } = session(r.engine, lorebooks, 'Tell me of the dragon.', { preset, roles: { narrator: { conn: 'script', model: 'm', samplers: { temperature: 0.7 } } } });
    const p = ok(s.preview());
    expect(p.kind).toBe('reply');
    expect(p.upTo).toBe(s.view().head!);
    expect(p.model).toEqual({ connection: 'script', model: 'm' });
    // Previews of one state agree (the next turn's seed is drawn once).
    expect(ok(s.preview()).messages).toEqual(p.messages);
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t);
    expect(seenOf(p)).toEqual(seen(r.provider.requests[0]!));
    expect(turnLine(r.home, s.id, t.messageId)).toMatchObject({ seed: p.trace.seed });
    expect(JSON.stringify(p.messages)).toContain('Dragons hoard maps.');
    expect(p.samplers).toEqual({ temperature: 0.7 });
    // The trace is the one the turn writes, without what only the call can add.
    expect(p.trace.lore.fired.map((f) => f.id).filter((id) => !id.startsWith('coin'))).toEqual(['sky', 'dragon']);
    // The chances came out mixed, so the seed decided something.
    const coins = p.trace.lore.fired.filter((f) => f.id.startsWith('coin')).length;
    expect(coins).toBeGreaterThan(0);
    expect(coins).toBeLessThan(6);
    await r.engine.close();
  });

  test('swipe: an answer head (what /r sends)', async () => {
    const r = await rig(calls([{ text: 'First.' }], [{ text: 'Second.' }]));
    const { preset, lorebooks } = seeded(r.home);
    const { s, userId } = session(r.engine, lorebooks, 'A dragon?', { preset });
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const p = ok(s.preview());
    expect(p.kind).toBe('swipe');
    expect(p.upTo).toBe(userId);
    await run(s.runTurn({ kind: 'swipe', expectedVersion: s.version() }));
    expect(seenOf(p)).toEqual(seen(r.provider.requests[1]!));
    await r.engine.close();
  });

  test('draft: the reply to a message not sent yet', async () => {
    const r = await rig(calls([{ text: 'First.' }], [{ text: 'Second.' }]));
    const { preset, lorebooks } = seeded(r.home);
    const { s } = session(r.engine, lorebooks, 'Hello.', { preset });
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const p = ok(s.preview({ draft: 'And the dragon?' }));
    expect(p.kind).toBe('reply');
    expect(p.upTo).toBe('draft');
    await say(s, 'And the dragon?');
    expect(seenOf(p)).toEqual(seen(r.provider.requests[1]!));
    expect(JSON.stringify(p.messages)).toContain('Dragons hoard maps.');
    await r.engine.close();
  });

  test('turn: a past answer is rebuilt from its own seed and clock, up to its user message', async () => {
    // {{random}} is seeded by the turn and {{time}} reads its clock: only the past answer's own seed
    // and now give back its request.
    const r = await rig(calls([{ text: 'First.' }], [{ text: 'Swiped.' }], [{ text: 'Later.' }]));
    const preset = presetWith('Roll: {{random::a::b::c::d::e::f::g::h}} at {{time}}. Play {{char}}.');
    writeLibrary(r.home, 'presets', 'rnd', preset);
    lore(r.home);
    const { s, userId } = session(r.engine, ['w'], 'A dragon?', { preset: 'rnd' });
    const t1 = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t1);
    const sw = s.runTurn({ kind: 'swipe', expectedVersion: s.version() });
    await run(sw);
    await say(s, 'Go on.');

    const p1 = ok(s.preview({ turn: sw.messageId }));
    expect(p1.kind).toBe('swipe'); // it has an older sibling
    expect(p1.upTo).toBe(userId);
    expect(seenOf(p1)).toEqual(seen(r.provider.requests[1]!));
    expect(p1.notices.map((n) => n.code)).not.toContain('preview_inputs_changed');

    // The first answer is off the path now; select it back and rebuild it too.
    s.select({ messageId: t1.messageId, expectedVersion: s.version() });
    const p0 = ok(s.preview({ turn: t1.messageId }));
    expect(p0.kind).toBe('reply');
    expect(seenOf(p0)).toEqual(seen(r.provider.requests[0]!));
    await r.engine.close();
  });

  test('a guided swipe is rebuilt with its direction', async () => {
    const r = await rig(calls([{ text: 'First.' }], [{ text: 'Guided.' }]));
    const { s } = session(r.engine, [], 'Hello.');
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const sw = s.runTurn({ kind: 'swipe', expectedVersion: s.version(), guidance: 'Be terse.' });
    await run(sw);
    const p = ok(s.preview({ turn: sw.messageId }));
    expect(seenOf(p)).toEqual(seen(r.provider.requests[1]!));
    expect(JSON.stringify(p.messages)).toContain('Be terse.');
    await r.engine.close();
  });
});

describe('preview writes nothing', () => {
  test('journal bytes, version, head and the next turn are unchanged', async () => {
    const r = await rig(calls([{ text: 'First.' }], [{ text: 'Second.' }]));
    lore(r.home);
    writeLibrary(r.home, 'lorebooks', 'bad', '{ nope');
    const { s } = session(r.engine, ['w', 'bad'], 'Hi.');
    const before = journal(r.home, s);
    const v = s.version();
    const head = s.view().head;
    const p = ok(s.preview({ explain: true }));
    ok(s.preview({ draft: 'x' }));
    // Notices are shown, but not marked told: the turn still tells the missing book.
    expect(p.notices.map((n) => n.code)).toContain('lorebook_missing');
    expect(journal(r.home, s)).toBe(before);
    expect(s.version()).toBe(v);
    expect(s.view().head).toBe(head);
    expect(r.provider.requests).toHaveLength(0);
    const { evs } = await run(s.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(evs.filter((e) => e.type === 'notice' && e.code === 'lorebook_missing')).toHaveLength(1);
    await r.engine.close();
  });

  test('works while a turn runs, reading the current view', async () => {
    const r = await rig(calls([{ text: 'Slow ' }, { pause: 'go' }, { text: 'answer.' }]));
    const { s, userId } = session(r.engine, [], 'Hi.');
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const events = drain(t);
    await until(() => r.provider.requests.length === 1);
    expect(s.busy()).toBe(true);
    const before = journal(r.home, s);
    const p = ok(s.preview());
    expect(p.kind).toBe('reply');
    expect(p.upTo).toBe(userId);
    expect(p.messages).toEqual(r.provider.requests[0]!.messages);
    expect(journal(r.home, s)).toBe(before);
    r.provider.release('go');
    await events;
    expect((await t.result).type).toBe('done');
    await r.engine.close();
  });

  test('explain returns the lore verdicts', async () => {
    const r = await rig([]);
    lore(r.home);
    const { s } = session(r.engine, ['w'], 'Nothing to see.');
    const p = ok(s.preview({ explain: true }));
    expect(p.verdicts?.map((v) => [v.id, v.fired, v.why])).toEqual([
      ['sky', true, 'constant'],
      ['dragon', false, 'no-key-match'],
    ]);
    expect(ok(s.preview()).verdicts).toBeUndefined();
    await r.engine.close();
  });
});

describe('refusals come back as ok:false', () => {
  test('the kind preconditions, the connection, the preset, bad options', async () => {
    const r = await rig([]);
    const fresh = r.engine.createSession({ character: MIRA, persona: LEVI });
    const before = journal(r.home, fresh);
    // A fresh session's head is the greeting: nothing to swipe.
    expect(fresh.preview()).toMatchObject({ ok: false, code: 'nothing_to_swipe' });
    expect(fresh.preview({ turn: 'nope' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(fresh.preview({ turn: fresh.view().head! })).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(fresh.preview({ draft: 'a', turn: 'b' })).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(fresh.preview({ draft: 7 as unknown as string })).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(ok(fresh.preview({ draft: 'Hello.' })).kind).toBe('reply');
    expect(journal(r.home, fresh)).toBe(before);

    const noConn = session(r.engine, [], 'Hi.', { roles: { narrator: { conn: 'nowhere', model: 'm' } } }).s;
    expect(noConn.preview()).toMatchObject({ ok: false, code: 'no_connection' });
    const noPreset = session(r.engine, [], 'Hi.', { preset: 'missing' }).s;
    expect(noPreset.preview()).toMatchObject({ ok: false, code: 'preset_missing' });
    await r.engine.close();
  });

  test('a prompt that cannot fit is context_length_exceeded', async () => {
    const r = await rig([]);
    const { s } = session(r.engine, [], 'word '.repeat(4000), { window: 2048 });
    const p = s.preview();
    expect(p).toMatchObject({ ok: false, code: 'context_length_exceeded' });
    await r.engine.close();
  });

  test('a user message as the turn is not an answer', async () => {
    const r = await rig(calls([{ text: 'A.' }]));
    const { s, userId } = session(r.engine, [], 'Hi.');
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    expect(s.preview({ turn: userId })).toMatchObject({ ok: false, code: 'invalid_params' });
    await r.engine.close();
  });
});

describe('preview_inputs_changed', () => {
  test("a past answer's preview says so when the preset or a book changed since", async () => {
    const r = await rig(calls([{ text: 'A.' }], [{ text: 'B.' }]));
    writeLibrary(r.home, 'presets', 'p1', presetWith('Play {{char}}.'));
    writeLibrary(r.home, 'presets', 'p2', presetWith('Be {{char}}, briefly.'));
    lore(r.home);
    const { s } = session(r.engine, ['w'], 'Hi.', { preset: 'p1' });
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t);
    const codes = (p: PreviewResult) => ok(p).notices.filter((n) => n.code === 'preview_inputs_changed');
    expect(codes(s.preview({ turn: t.messageId }))).toEqual([]);

    s.configure({ preset: 'p2' });
    const changed = codes(s.preview({ turn: t.messageId }));
    expect(changed).toHaveLength(1);
    expect(changed[0]!.message).toContain('the preset');
    // Today's preset is what the preview shows.
    expect(JSON.stringify(ok(s.preview({ turn: t.messageId })).messages)).toContain('briefly');

    s.configure({ preset: 'p1' });
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('sky', 'The sky is red now.', { constant: true })]));
    const books = codes(s.preview({ turn: t.messageId }));
    expect(books).toHaveLength(1);
    expect(books[0]!.message).toContain('lorebook w');
    expect(books[0]!.message).not.toContain('the preset');
    await r.engine.close();
  });

  // Regression: only the preset and the books were compared, so an edited history, an author's
  // note or another window rebuilt a different request with no word about it.
  const changedOf = (p: PreviewResult): string[] => ok(p).notices.filter((n) => n.code === 'preview_inputs_changed').map((n) => n.message);

  test('an earlier message edited since: the notice names the history', async () => {
    const r = await rig(calls([{ text: 'A1.' }], [{ text: 'A2.' }]));
    const { s, userId } = session(r.engine, [], 'Hi, I am Levi.');
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const { id: a2 } = await say(s, 'Where are we?');
    expect(changedOf(s.preview({ turn: a2 }))).toEqual([]);
    s.edit({ messageId: userId, text: 'Hi, I am somebody else entirely.', expectedVersion: s.version() });
    const changed = changedOf(s.preview({ turn: a2 }));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('the history');
    await r.engine.close();
  });

  test("an author's note set since, or another window: the notice says which", async () => {
    const r = await rig(calls([{ text: 'A1.' }]));
    const { s } = session(r.engine, [], 'Hi.');
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t);
    s.configure({ authorNote: { text: 'Be grim.', depth: 1, role: 'system' } });
    expect(changedOf(s.preview({ turn: t.messageId }))[0]).toContain("the author's note or other in-chat inserts");
    s.configure({ authorNote: null } as never);
    expect(changedOf(s.preview({ turn: t.messageId }))).toEqual([]);
    s.configure({ window: 4000 });
    expect(changedOf(s.preview({ turn: t.messageId }))[0]).toMatch(/the window \(\d+\/\d+ then, 4000\/\d+ now\)/);
    await r.engine.close();
  });

  // Regression: a model whose connection folds system notes into the user turn ('as-user') turned
  // the history row into 'history+post_history', and the notice blamed "the history (an edit, a
  // hidden message or the cut)" and "the other messages" although only the shaping changed.
  test('a model switch that only reshapes the request names the model and the shaping, not the history', async () => {
    const { conn } = scriptConn('asuser', calls());
    const asUser = { ...conn, id: 'asuser', caps: { ...SCRIPT_CAPS, midSystem: 'as-user' as const } };
    const r = await rig(calls([{ text: 'A1.' }]), { connections: { asuser: asUser } });
    const ph = presetWith('Play {{char}}.');
    ph.blocks.find((b) => b.id === 'post_history')!.content = 'Keep it short.';
    writeLibrary(r.home, 'presets', 'ph', ph);
    const { s } = session(r.engine, [], 'Hi.', { preset: 'ph', roles: { narrator: { conn: 'script', model: 'm1' } } });
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t);
    expect(changedOf(s.preview({ turn: t.messageId }))).toEqual([]);
    s.configure({ roles: { narrator: { conn: 'asuser', model: 'm1' } } });
    const p = ok(s.preview({ turn: t.messageId }));
    // The rebuilt request really is shaped otherwise: the note rides the user turn now.
    expect(p.trace.blocks.map((b) => b.src)).toContain('history+post_history');
    const changed = changedOf(p);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('the model (script:m1 then)');
    expect(changed[0]).toContain("how the messages are shaped (merged or re-roled: the model's connection)");
    expect(changed[0]).not.toContain('the history');
    expect(changed[0]).not.toContain('the other messages');
    await r.engine.close();
  });

  test('a message hidden since names the history; unhiding it again clears the notice', async () => {
    const r = await rig(calls([{ text: 'A1.' }], [{ text: 'A2.' }]));
    const { s, userId } = session(r.engine, [], 'Hi, I am Levi.');
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const { id: a2 } = await say(s, 'Where are we?');
    s.hide({ messageId: userId, hidden: true, expectedVersion: s.version() });
    const changed = changedOf(s.preview({ turn: a2 }));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('the history (an edit or a hidden message)');
    s.hide({ messageId: userId, hidden: false, expectedVersion: s.version() });
    expect(changedOf(s.preview({ turn: a2 }))).toEqual([]);
    await r.engine.close();
  });

  test('a trace counted another way (chars, M1) with nothing changed: no notice', async () => {
    const r = await rig(calls([{ text: 'A1.' }]));
    const { s } = session(r.engine, [], 'Hi.');
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    await run(t);
    await r.engine.close();
    // Reopened with the default counter (o200k): the past trace says chars, tokens are not compared.
    const { O200K_COUNTER } = await import('../../src/prompt/tokens.ts');
    const again = await rig(calls(), { home: r.home, extra: { counter: O200K_COUNTER } });
    const s2 = again.engine.session(s.id);
    expect(changedOf(s2.preview({ turn: t.messageId }))).toEqual([]);
    await again.engine.close();
  });
});

describe('wire', () => {
  test('the primary connection’s wire() gets the request the turn then streams', async () => {
    const { provider: scripted } = scriptConn('w', calls([{ text: 'Mm.' }]));
    const wired: ModelRequest[] = [];
    const provider: Provider & { requests: ModelRequest[] } = {
      requests: scripted.requests,
      stream: (req, env) => scripted.stream(req, env),
      wire(req) {
        wired.push(req);
        return { url: 'http://127.0.0.1:9/v1/chat/completions', body: { model: req.model.model, max_tokens: req.maxTokens, n: req.messages.length } };
      },
    };
    const r = await rig([], { connections: { wired: { id: 'wired', provider, caps: SCRIPT_CAPS, origin: 'script:wired', local: true } } });
    lore(r.home);
    const { s } = session(r.engine, ['w'], 'Hi.', { roles: { narrator: { conn: 'wired', model: 'm1', maxTokens: 300 } } });
    const p = ok(s.preview());
    expect(p.wire).toEqual({ url: 'http://127.0.0.1:9/v1/chat/completions', body: { model: 'm1', max_tokens: 300, n: p.messages.length } });
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const sent = scripted.requests[0]!;
    const strip = ({ signal, callKey, ...rest }: ModelRequest) => (void signal, void callKey, rest);
    expect(strip(wired[0]!)).toEqual(strip(sent));
    await r.engine.close();
  });

  test('no wire for a provider without one', async () => {
    const r = await rig([]);
    const { s } = session(r.engine, [], 'Hi.');
    expect(ok(s.preview()).wire).toBeUndefined();
    await r.engine.close();
  });
});
