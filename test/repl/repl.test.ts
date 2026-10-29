// cli/repl.ts end to end (§12.4, §15 M1b "REPL и вывод"): a real engine over a scripted provider,
// an injected line input, a memory Io and a captured Ctrl+C handler.
import { afterEach, describe, expect, test } from 'bun:test';
import { Engine } from '../../src/engine/engine.ts';
import type { SessionHandle, TurnHandle, TurnOutcome } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { MsgEntry, Trace } from '../../src/session/entries.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, entriesOf, LEVI, MIRA, replRig, writeRaw, type ReplRig } from './kit.ts';

const rigs: ReplRig[] = [];
async function rig(...args: Parameters<typeof replRig>): Promise<ReplRig> {
  const r = await replRig(...args);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

const msgs = (r: ReplRig, id = r.session.id): MsgEntry[] => entriesOf(r.home, id).filter((e): e is MsgEntry => e.t === 'msg');
const textOf = (m: { blocks?: { k: string; text?: string }[] }): string => (m.blocks ?? []).reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');


describe('REPL: the story loop', () => {
  test('banner and greeting, a streamed reply, /r, /show 2/2, /[ back, /c, /e, /hide; EOF closes with 0', async () => {
    const r = await rig(
      calls(
        [{ text: '*She smiles.* "Hello' }, { text: ', traveller."' }, { usage: { inputTotal: 100, outputTotal: 12 } }],
        [{ reasoning: 'Let me think.' }, { text: 'A second take.' }],
        [{ text: ' And then more.' }],
      ),
      { editor: (t) => `${t} (edited)` },
    );
    r.type('Hi there', '/r', '/show', '/[', '/c', '/e', '/hide 2', '/show');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();

    // Banner, then where the story stands: the greeting with its status.
    expect(out.startsWith(`session ${r.session.id} · Mira · narrator script:default (tools: off) · ctx ?\n`)).toBe(true);
    expect(out).toContain('Mira › *Mira looks up.* "Hello, Levi."\n  [greeting 1/2]');
    // The reply streamed after the prefix, then the status line.
    expect(out).toContain('you  › Hi there\nMira › *She smiles.* "Hello, traveller."\n  [swipe 1/1 · 12 tok · ');
    expect(out).toContain('/r swipe  /c continue  /e edit');
    // /r: a sibling; its reasoning folded to one line.
    expect(out).toContain('  ⋯ thinking (13 chars)\nMira › A second take.\n  [swipe 2/2 · ');
    expect(out).toContain('3. Mira · ');
    expect(out).toMatch(/3\. Mira · [0-9a-f]{8} · swipe 2\/2\n {3}A second take\./);
    // /[: back to the first version (select), shown with its status.
    expect(out).toContain('you  › /[\nMira › *She smiles.* "Hello, traveller."\n  [swipe 1/2 · ');
    // /c: the addition after the last words of the answer.
    expect(out).toContain('Mira › …*She smiles.* "Hello, traveller." And then more.\n');
    // /e: the fake editor got the current text; the edit is shown.
    expect(r.edited).toEqual(['*She smiles.* "Hello, traveller." And then more.']);
    expect(out).toContain('edited message 3');
    // /hide 2, then /show marks it.
    expect(out).toContain('message 2 is hidden');
    expect(out).toMatch(/2\. you · [0-9a-f]{8} · \[hidden\]/);
    expect(out).toMatch(/3\. Mira · [0-9a-f]{8} · swipe 1\/2 · \[edited\]/);

    // The journal agrees: two answers under U, the first continued then edited, U hidden.
    const es = entriesOf(r.home, r.session.id);
    const answers = msgs(r).filter((m) => m.role === 'assistant' && m.gen?.kind === 'model');
    expect(answers.map(textOf)).toEqual(['*She smiles.* "Hello, traveller."', 'A second take.']);
    expect(es.filter((e) => e.t === 'edit').map((e) => (e as { reason: string }).reason)).toEqual(['continue', 'user']);
    expect(es.some((e) => e.t === 'hide' && e.hidden)).toBe(true);
    // The REPL closed the session: it can be opened again.
    const again = r.engine.session(r.session.id);
    expect(again.view().path.at(-1)!.blocks.at(-1)).toEqual({ k: 'text', text: '*She smiles.* "Hello, traveller." And then more. (edited)' });
    await again.close();
  });

  test('greeting swipes before the first message are navigation, without a model call', async () => {
    const r = await rig(calls());
    r.type('/r', '/r', '/]', '/[');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('you  › /r\nMira › The lamp flickers.\n  [greeting 2/2]');
    // /r wraps around to the first greeting; /] at the last one says so.
    expect(out).toContain('you  › /r\nMira › *Mira looks up.* "Hello, Levi."\n  [greeting 1/2]');
    expect(out).toContain('you  › /]\nMira › The lamp flickers.');
    expect(out).toContain('you  › /[\nMira › *Mira looks up.*');
    expect(r.provider.requests).toHaveLength(0);
  });

  test('the edit prompt: a cancelled or unchanged edit writes nothing; /e n edits that message', async () => {
    let call = 0;
    const r = await rig(calls([{ text: 'Answer.' }]), { editor: (t) => (++call === 1 ? null : call === 2 ? t : 'Hello again.') });
    r.type('Hello', '/e', '/e', '/e 2', '/e 9');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('edit cancelled');
    expect(out).toContain('no change');
    expect(out).toContain('edited message 2\nyou  › Hello again.');
    expect(out).toContain('there is no message 9: this path has 3 messages');
    expect(entriesOf(r.home, r.session.id).filter((e) => e.t === 'edit')).toHaveLength(1);
  });

  test('/regen passes guidance to the swipe; /r on your own unanswered message asks for the answer', async () => {
    // 'unreachable' without a status is not retried (engine/route.ts): one call, one failure.
    const r = await rig(calls([{ error: { code: 'unreachable' } }], [{ text: 'Finally.' }], [{ text: 'Angrier.' }]));
    r.type('Hello', '/regen angrier', '/r', '/regen angrier');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    // The first reply failed; the head is the user's message, so /regen has nothing to re-roll.
    expect(out).toContain('✗ the answer failed (network/unreachable)');
    expect(out).toContain('your message has no answer to re-roll yet; /r asks for one');
    expect(out).toContain('Mira › Finally.');
    expect(out).toContain('Mira › Angrier.\n  [swipe 2/2');
    expect(r.provider.requests.at(-1)!.messages.some((m) => m.blocks.some((b) => b.k === 'text' && b.text.includes('angrier')))).toBe(true);
    const guided = msgs(r).find((m) => textOf(m) === 'Angrier.');
    expect(guided?.gen?.guidance).toBe('angrier');
  });
});

describe('REPL: branches', () => {
  test('/rewind then a new message makes the old continuation a tail; /tails lists it; /goto returns', async () => {
    const r = await rig(calls([{ text: 'First answer.' }], [{ text: 'Second answer.' }], [{ text: 'Other path.' }]));
    r.type('One', 'Two', '/rewind 3', 'Instead', '/tails');
    await r.until('2 branches off this path');
    const out = r.out();
    expect(out).toContain('rewound to message 3');
    expect(out).toContain('Mira › Other path.');
    const tailLine = out.split('\n').find((l) => l.includes('"Second answer."'))!;
    expect(tailLine).toMatch(/^ {2}[0-9a-f]{8} {2}#5 Mira: "Second answer\."$/);
    const id = tailLine.trim().slice(0, 8);
    r.type(`/goto ${id.slice(0, 5)}`, '/show');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toMatch(/5\. Mira · [0-9a-f]{8} · swipe 1\/1\n {3}Second answer\./);
  });

  test('/rewind onto a player message says what a new line and /r do there', async () => {
    const r = await rig(calls([{ text: 'First answer.' }], [{ text: 'Again.' }]));
    r.type('One', '/rewind 2', '/r');
    await r.until('Mira › Again.');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('rewound to your message 2: /r asks for a new answer to it');
    expect(out).toContain('/rewind 1 to replace it instead');
    // /r on the player's line asked for an answer to it: the old answer is now a sibling.
    const path = r.session.view().path;
    expect(path.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  test('/tails lists greeting branches with ids and first words', async () => {
    const r = await rig(calls([{ text: 'Answer.' }]));
    r.type('Hello', '/tails');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toMatch(/1 branch off this path \(\/goto <id> switches\):\n {2}[0-9a-f]{8} {2}#1 Mira: "The lamp flickers\."/);
  });

  test('/fork prints the new id and opens it; /open switches back', async () => {
    const r = await rig(calls([{ text: 'Answer one.' }]));
    const original = r.session.id;
    r.type('Hello', '/fork 2', '/show');
    await r.until('has no answer yet');
    const forked = /forked into (s_[0-9a-f]{8}) \(messages 1–2\)/.exec(r.out())?.[1];
    expect(forked).toBeDefined();
    expect(r.out()).toContain(`session ${forked} · Mira · narrator script:default`);
    await r.until('version');
    r.type(`/open ${original}`, '/sessions');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    // The fork holds messages 1–2 (the path only): the greeting and the user's line, no answer.
    expect(out).toContain(`Mira · ${forked} · version`);
    expect(out).toContain(`session ${original} · Mira`);
    expect(out).toContain(`* ${original}`);
    expect(msgs(r, forked!).map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  test('/open of an unknown session keeps the current one', async () => {
    const r = await rig(calls());
    r.type('/open s_ffffffff', '/show');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('refused [session_not_found]');
    expect(r.out()).toContain(`Mira · ${r.session.id} · version`);
  });
});

describe('REPL: models and settings', () => {
  test('/model lists, validates the connection, binds roles; /note and /think go to the session config', async () => {
    const r = await rig(calls());
    r.type('/model', '/model nope:x', '/model alt:big', '/model director narrator', '/model recall alt:small', '/model', '/note Rain all night. @2', '/note', '/note off', '/think show', '/think');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('  narrator script:default\n  director narrator (follows)');
    expect(out).toContain('/model narrator: unknown connection "nope" (config.toml has: alt, ghost, script)');
    expect(out).toContain('narrator → alt:big (from the next turn)');
    expect(out).toContain('  narrator alt:big\n  director narrator (follows)\n  recorder narrator (follows)\n  recall   alt:small');
    expect(out).toContain("author's note @2 (system): Rain all night.");
    expect(out).toContain("author's note removed");
    expect(out).toContain('reasoning is shown');
    // unknown[]: /note off writes a merge-patch null, which DeepPartial<SessionConfig> does not spell.
    const patches: unknown[] = entriesOf(r.home, r.session.id).flatMap((e) => (e.t === 'config' ? [e.patch] : []));
    expect(patches).toEqual([
      { roles: { narrator: { conn: 'alt', model: 'big' } } },
      { roles: { director: 'narrator' } },
      { roles: { recall: { conn: 'alt', model: 'small' } } },
      { authorNote: { text: 'Rain all night.', depth: 2, role: 'system' } },
      { authorNote: null },
      { reasoningShown: true },
    ]);
  });

  test('a refusal prints its code and a human message, and the line is not written', async () => {
    const r = await rig(calls());
    r.type('/model ghost:x', 'Hello');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain("refused [no_connection]: the narrator's connection is not configured");
    expect(r.out()).not.toContain('    at ');
    expect(msgs(r).filter((m) => m.role === 'user')).toHaveLength(0);
  });

  test('/usage sums the path, /trace summarises the last answer, unknown and later commands get hints', async () => {
    const r = await rig(calls([{ text: 'Priced.' }, { usage: { inputTotal: 1000, outputTotal: 100 } }]));
    r.type('/trace', 'Hello', '/usage', '/trace', '/probe', '/persona', '/bogus');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('no answer with a trace on this path yet');
    expect(out).toContain('1 generation on this path · in 1000 tok · out 100 tok · cost $0.0012');
    expect(out).toMatch(/trace of [0-9a-f]{8} · script:default\n {2}window 8192 · reserve \d+ · prompt ~\d+ tok \(server: 1000\)/);
    expect(out).toContain('rp-core probe <connection>');
    expect(out).toContain('persona: "Levi"');
    expect(out).toContain('unknown command /bogus; /help lists the commands');
  });

  test('notices are shown once per code per session', async () => {
    // A status makes the error retryable (engine/route.ts), so the retry and then the fallback run.
    const fail = { error: { code: 'overloaded' as const, status: 503 } };
    const r = await rig(calls([fail], [fail], [{ text: 'From the fallback.' }], [fail], [fail], [{ text: 'Again.' }]), {
      config: { roles: { narrator: { conn: 'script', model: 'default', fallback: { conn: 'alt', model: 'spare' } } } },
    });
    r.type('One', 'Two');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('Mira › From the fallback.');
    expect(out).toContain('Mira › Again.');
    expect(out.split('(fallback)').length - 1).toBe(1);
    expect(out).toContain('⋯ retrying in');
  });
});

describe('REPL: Ctrl+C, held lines, EOF', () => {
  test('Ctrl+C during a slow reply stops it; the partial answer is kept', async () => {
    const r = await rig(calls([{ text: 'Partial ' }, { pause: 'never' }, { text: 'never arrives' }]));
    r.type('Go');
    await r.until('Mira › Partial');
    r.interrupt();
    await r.until('[stopped]');
    await r.until('[swipe 1/1');
    expect(r.out()).toContain('Mira › Partial \n[stopped]\n  [swipe 1/1 · ');
    expect(r.out()).toContain(' · stopped]');
    r.end();
    expect(await r.done).toBe(0);
    const answer = msgs(r).at(-1)!;
    expect(textOf(answer)).toBe('Partial ');
    expect(answer.gen?.finish).toBe('stopped');
  });

  test('interactive: a line typed during a turn is held and sent after it; editing commands are refused, read-only ones wait', async () => {
    const r = await rig(calls([{ text: 'One, ' }, { pause: 'p1' }, { text: 'two.' }], [{ text: 'Answer to the held line.' }]), { interactive: true });
    r.type('first');
    await r.until('Mira › One, ');
    r.type('second line');
    await r.until('(held: sent when this answer ends)');
    r.type('/r');
    await r.until('refused [session_busy]: /r changes the story while an answer is being written');
    r.type('/show');
    await r.until('(runs when this answer ends)');
    r.type('/think show');
    await r.until('reasoning will be shown');
    expect(r.provider.requests).toHaveLength(1);
    r.provider.release('p1');
    await r.until('Mira › Answer to the held line.');
    await r.until('version');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    // The held line is echoed when it is finally sent, after the first answer's status line.
    expect(out.indexOf('you  › second line\nMira › Answer to the held line.')).toBeGreaterThan(out.indexOf('[swipe 1/1'));
    // The queued /show ran after the held line's answer.
    expect(out.indexOf('version')).toBeGreaterThan(out.indexOf('Answer to the held line.'));
    expect(msgs(r).filter((m) => m.gen?.kind !== 'greeting').map((m) => [m.role, textOf(m)])).toEqual([
      ['user', 'first'],
      ['assistant', 'One, two.'],
      ['user', 'second line'],
      ['assistant', 'Answer to the held line.'],
    ]);
    // /r was refused locally: no swipe was asked for.
    expect(r.provider.requests).toHaveLength(2);
  });

  test('non-interactive: lines that arrive during a turn run in order afterwards (a piped script)', async () => {
    const r = await rig(calls([{ text: 'Slow ' }, { pause: 'p' }, { text: 'answer.' }], [{ text: 'Swiped.' }]));
    r.type('Go', '/r', '/show');
    await r.until('Mira › Slow ');
    expect(r.out()).not.toContain('refused');
    r.provider.release('p');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('Mira › Swiped.\n  [swipe 2/2');
    expect(r.out()).toMatch(/3\. Mira · [0-9a-f]{8} · swipe 2\/2/);
  });

  test('a double Ctrl+C at the prompt exits 0; one press only prints a hint', async () => {
    const r = await rig(calls());
    await r.until('[greeting 1/2]');
    r.interrupt();
    await r.until('(press Ctrl+C again to quit, or type /quit)');
    let settled = false;
    void r.done.then(() => (settled = true));
    await new Promise((res) => setTimeout(res, 20));
    expect(settled).toBe(false);
    r.interrupt();
    expect(await r.done).toBe(0);
  });

  test('a line between two Ctrl+C presses disarms the exit', async () => {
    const r = await rig(calls());
    r.interrupt();
    await r.until('(press Ctrl+C again');
    r.type('/help');
    await r.until('Type to speak.');
    r.interrupt();
    await r.until('(press Ctrl+C again', 2);
    r.type('/quit');
    expect(await r.done).toBe(0);
  });

  test('a turn that will not stop: the second Ctrl+C explains, the third leaves at once with 130', async () => {
    // A server that ignores the abort, as a session whose turn never settles and whose stop does nothing.
    const stamp = { sessionId: 's', ts: '2026-10-26T12:00:00.000Z' };
    const hung: TurnHandle = {
      turnId: 't_hung',
      messageId: 'deadbeef',
      events: (async function* (): AsyncGenerator<Event> {
        yield { ...stamp, type: 'start', turnId: 't_hung', kind: 'reply', messageId: 'deadbeef', parentId: 'u' };
        yield { ...stamp, type: 'text', turnId: 't_hung', delta: 'Stuck', offset: 0 };
        await new Promise(() => {});
      })(),
      result: new Promise<TurnOutcome>(() => {}),
      stop: () => {},
    };
    const wrap = (s: SessionHandle): SessionHandle => ({
      get id() {
        return s.id;
      },
      header: () => s.header(),
      draft: (input, signal) => s.draft(input, signal),
      answerGate: (turnId, gateId, answer) => s.answerGate(turnId, gateId, answer),
      setPersona: (persona) => s.setPersona(persona),
      name: (title, leaf) => s.name(title, leaf),
      version: () => s.version(),
      view: () => s.view(),
      busy: () => false,
      openEvents: () => s.openEvents(),
      send: (i) => s.send(i),
      runTurn: (o) => s.runTurn(o),
      submit: () => hung,
      stop: () => {},
      commitAnyway: (turnId) => s.commitAnyway(turnId),
      discard: (turnId) => s.discard(turnId),
      edit: (i) => s.edit(i),
      hide: (i) => s.hide(i),
      select: (i) => s.select(i),
      fork: (i) => s.fork(i),
      configure: (p) => s.configure(p),
      preview: (o) => s.preview(o),
      search: (i) => s.search(i),
      notes: () => s.notes(),
      memoryAdd: (i) => s.memoryAdd(i),
      memoryFile: (i) => s.memoryFile(i),
      memoryEdit: (i) => s.memoryEdit(i),
      memoryRetire: (i) => s.memoryRetire(i),
      memoryRestore: (i) => s.memoryRestore(i),
      memoryList: (i) => s.memoryList(i),
      memoryGet: (i) => s.memoryGet(i),
      memoryTree: (i) => s.memoryTree(i),
      memoryExport: (i) => s.memoryExport(i),
      compendium: () => s.compendium(),
      memoryUndo: (i) => s.memoryUndo(i),
      memoryRefile: (i) => s.memoryRefile(i),
      memoryRetry: (i) => s.memoryRetry(i),
      memoryWait: (i) => s.memoryWait(i),
      memoryStatus: () => s.memoryStatus(),
      close: () => s.close(),
    });
    const r = await rig(calls(), { wrap });
    r.type('Go');
    await r.until('Mira › Stuck');
    r.interrupt();
    r.interrupt();
    await r.until('(still stopping; press Ctrl+C once more to leave at once');
    r.interrupt();
    expect(await r.done).toBe(130);
    expect(r.out()).toContain('! left with the turn still open; the next open recovers it');
  });

  test('/quit during a turn stops it and leaves', async () => {
    const r = await rig(calls([{ text: 'Part ' }, { pause: 'never' }]), { interactive: true });
    r.type('Go');
    await r.until('Mira › Part');
    r.type('/quit');
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('[stopped]');
    expect(msgs(r).at(-1)!.gen?.finish).toBe('stopped');
  });

  test('EOF while a turn runs lets it finish before closing', async () => {
    const r = await rig(calls([{ text: 'Long ' }, { pause: 'p' }, { text: 'answer.' }]));
    r.type('Go');
    await r.until('Mira › Long');
    r.end();
    await new Promise((res) => setTimeout(res, 10));
    r.provider.release('p');
    expect(await r.done).toBe(0);
    const answer = msgs(r).at(-1)!;
    expect(textOf(answer)).toBe('Long answer.');
    expect(answer.gen?.finish).toBe('end');
  });
});

describe('REPL: opening', () => {
  test('recovered turns from openEvents() are shown at start, then the interrupted answer', async () => {
    const home = tmpHome('rp-core-repl-');
    // A session with a user line and a turn that crashed mid-answer.
    const provider = createScriptedProvider([]);
    const engine = await Engine.open({
      home,
      connections: { script: { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true } },
      clock: fakeClock(),
      random: fakeRandom(11),
      timeZone: 'UTC',
    });
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    const sent = s.send({ text: 'Tell me.', expectedVersion: s.version() });
    const id = s.id;
    await s.close();
    await engine.close();
    const trace: Trace = {
      seed: 1,
      now: '2026-10-26T12:00:00.000Z',
      window: 8192,
      reserve: 2048,
      tokens: { estimated: 10 },
      blocks: [],
      lore: { fired: [], cut: [], budget: 0 },
      recap: { ids: [], arcs: [], boundary: null },
      prefill: null,
      macros: { unknown: [] },
      trimmed: null,
      calls: [],
      agents: {},
      presetHash: 'h',
      loreHashes: {},
    };
    writeRaw(home, id, (log) => {
      const ts = '2026-10-26T12:00:00.000Z';
      log.append({ t: 'turn', ts, turn: 't_crash01', kind: 'reply', parent: sent.messageId, msgId: 'abcdef01', seed: 1, now: ts, base: sent.version });
      log.append({ t: 'prep', turn: 't_crash01', trace });
      log.append({ t: 'chk', turn: 't_crash01', text: 'She begins to ' }, { durable: false });
    });

    const r = await rig(calls(), { home, sessionId: id });
    await r.until('[swipe 1/1');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('! recovered an interrupted turn (t_crash01): its partial answer was saved, marked [interrupted]');
    expect(out).toContain('Mira › She begins to \n  [swipe 1/1 · interrupted]');
    expect(out.indexOf('recovered an interrupted turn')).toBeLessThan(out.indexOf('Mira › She begins to'));
  });

  test('a session whose head is the user line says the answer is missing', async () => {
    const r = await rig(calls([{ error: { code: 'bad_request' } }]));
    r.type('Hello');
    await r.until('✗ the answer failed');
    r.type('/fork');
    await r.until('your message has no answer yet');
    r.end();
    expect(await r.done).toBe(0);
  });

  test('colour: italics for actions in the stream, dim status line, plain when off', async () => {
    const r = await rig(calls([{ text: '*waves* "hi"' }]), { color: true });
    r.type('Hello');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('\x1b[3m*waves*\x1b[23m "hi"');
    expect(out).toContain('\x1b[2m  [swipe 1/1');
  });
});

describe('REPL: versions are of one role (review M1b)', () => {
  test('after /rewind onto your own line and a new line, /] from the old answer does not land on your line; swipe counts agree', async () => {
    const r = await rig(calls([{ text: 'First answer.' }], [{ text: 'Second answer.' }]));
    r.type('Hi');
    await r.until('First answer.');
    r.type('/rewind 2');
    await r.until('rewound to your message 2');
    r.type('Another line of mine');
    await r.until('Second answer.');
    const first = msgs(r).find((m) => textOf(m) === 'First answer.')!;
    r.type(`/goto ${first.id}`);
    await r.until('you  › /goto');
    r.type('/]', '/show');
    await r.until('version ');
    await r.close();
    const out = r.out();
    // /goto shows the old answer as the only version of itself (not "swipe 1/2" with the user line).
    const afterGoto = out.slice(out.lastIndexOf('› /goto'));
    expect(afterGoto).toContain('Mira › First answer.\n  [swipe 1/1');
    // /] stays on the answer: there is no next version.
    const afterBrowse = out.slice(out.lastIndexOf('› /]'));
    expect(afterBrowse.split('\n')[1]).toBe('this is the only version; /r makes another');
    expect(afterBrowse).not.toContain('you  › Another line of mine');
  });
});
