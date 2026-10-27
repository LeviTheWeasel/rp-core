// The TUI's lifecycle (TUI decisions T-1, T-10): a terminal is required, refusals come before the
// renderer, the exits (/quit, Ctrl+C twice, SIGINT, SIGTERM) restore the terminal and release the
// lock, the file log, and the `tui` command in main.
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { main } from '../../src/cli/main.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import { TERMINATED_LINE } from '../../src/cli/chat.ts';
import { readLock } from '../../src/session/log.ts';
import { cmdTui, NEEDS_TERMINAL } from '../../src/cli/tui/run.ts';
import { tuiLogPath } from '../../src/cli/tui/io.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { calls, LEVI, MIRA, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

const ANSWER = calls([{ text: 'Карта готова.' }]);
const RESET = '\x1b[?2027l';

async function waitFor(ok: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !ok(); waited += 5) {
    if (waited > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('cmdTui before the renderer', () => {
  const noRenderer = () => {
    const made = { n: 0 };
    return { made, createRenderer: async () => (made.n++, Promise.reject(new Error('no renderer in this test'))) };
  };

  test('no terminal: exit 64 with the way out, nothing opened', async () => {
    const home = tmpHome('rp-core-tui-');
    const err = memoryChannel();
    const r = noRenderer();
    const code = await cmdTui({ rt: loadRuntime(home, {}), io: { out: memoryChannel(), err }, exitNow: () => {}, sessionId: 'nope', tty: false, createRenderer: r.createRenderer });
    expect(code).toBe(64);
    expect(err.text()).toBe(`${NEEDS_TERMINAL}\n`);
    expect(r.made.n).toBe(0);
  });

  test('a locked session is refused as a CLI error (exit 5); the renderer is never created', async () => {
    const home = tmpHome('rp-core-tui-');
    const holder = await Engine.open({ home, clock: fakeClock() });
    const s = holder.createSession({ character: MIRA, persona: LEVI });
    const err = memoryChannel();
    const r = noRenderer();
    const code = await cmdTui({ rt: loadRuntime(home, {}), io: { out: memoryChannel(), err }, exitNow: () => {}, sessionId: s.id, tty: true, createRenderer: r.createRenderer });
    expect(code).toBe(5);
    expect(err.text()).toContain('refused (session_locked)');
    expect(r.made.n).toBe(0);
    expect(readLock(home, s.id)).not.toBeNull(); // still the holder's
    await holder.close();
  });

  test('an unknown session: exit 5 before the renderer', async () => {
    const home = tmpHome('rp-core-tui-');
    const err = memoryChannel();
    const r = noRenderer();
    const code = await cmdTui({ rt: loadRuntime(home, {}), io: { out: memoryChannel(), err }, exitNow: () => {}, sessionId: 'deadbeef', tty: true, createRenderer: r.createRenderer });
    expect(code).toBe(5);
    expect(err.text()).toContain('refused (');
    expect(r.made.n).toBe(0);
  });

  test('a renderer that fails to start: the engine is closed (lock released) and the error propagates', async () => {
    const home = tmpHome('rp-core-tui-');
    const e0 = await Engine.open({ home, clock: fakeClock() });
    const id = e0.createSession({ character: MIRA, persona: LEVI }).id;
    await e0.close();
    const r = noRenderer();
    const err = memoryChannel();
    await expect(cmdTui({ rt: loadRuntime(home, {}), io: { out: memoryChannel(), err }, exitNow: () => {}, sessionId: id, tty: true, createRenderer: r.createRenderer })).rejects.toThrow('no renderer in this test');
    expect(r.made.n).toBe(1);
    expect(readLock(home, id)).toBeNull();
    expect(readFileSync(tuiLogPath(home), 'utf8')).toContain('startup: Error: no renderer in this test');
  });
});

describe('leaving', () => {
  test('/quit: exit 0, the terminal reset after the renderer closed, the lock released, the log', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('/quit');
    expect(await rig.done).toBe(0);
    expect(rig.setup.renderer.isDestroyed).toBe(true);
    expect(rig.out()).toBe(RESET);
    expect(rig.err()).toBe('');
    expect(readLock(rig.home, rig.session.id)).toBeNull();
    const log = readFileSync(tuiLogPath(rig.home), 'utf8');
    expect(log).toContain(`open ${rig.session.id} 130x30`);
    expect(log).toContain('exit 0');
  });

  test('Ctrl+C twice at the prompt quits (the second on a Russian layout)', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    rig.setup.mockInput.pressCtrlC();
    await rig.until('press Ctrl+C again');
    await rig.setup.mockInput.pressKeys(['\x1b[1089::99;5u']);
    expect(await rig.done).toBe(0);
    expect(readLock(rig.home, rig.session.id)).toBeNull();
  });

  test('Ctrl+C with typed text clears the input first', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.type('черновик');
    rig.setup.mockInput.pressCtrlC();
    await rig.frame();
    expect(rig.input()).toBe('');
    expect(await rig.frame()).not.toContain('press Ctrl+C again');
  });

  test('SIGINT from outside is a Ctrl+C press: twice quits', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    rig.signals.emit('SIGINT');
    await rig.until('press Ctrl+C again');
    rig.signals.emit('SIGINT');
    expect(await rig.done).toBe(0);
    expect(rig.exits).toEqual([]);
  });

  test('SIGTERM mid-answer: said in the transcript and the log, engine closed, terminal restored, 143', async () => {
    rig = await tuiRig(calls([{ text: 'Половина ' }, { pause: 'p' }, { text: 'конец.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Половина');
    rig.signals.emit('SIGTERM');
    await waitFor(() => rig!.exits.length > 0, 'exitNow');
    expect(rig.exits).toEqual([143]);
    expect(rig.setup.renderer.isDestroyed).toBe(true);
    expect(rig.out()).toBe(RESET);
    expect(readLock(rig.home, rig.session.id)).toBeNull();
    expect(readFileSync(tuiLogPath(rig.home), 'utf8')).toContain(TERMINATED_LINE);
    const head = rig.session.view().path.at(-1)!;
    expect(head.role).toBe('assistant');
    // The Repl winds down too (its input ended).
    expect(await rig.done).toBe(0);
  });

  // Driven through an injected source, never the process: nothing is thrown for real and no other
  // listener (OpenTUI's own, another test's) sees the error, so it cannot land in another test.
  test('an uncaught error or an unhandled rejection goes to the log and the status row, the chat goes on', async () => {
    const errors = new EventEmitter();
    rig = await tuiRig(ANSWER, { errors });
    await rig.until('Hello, Levi');
    expect(errors.listenerCount('uncaughtException')).toBe(1);
    expect(errors.listenerCount('unhandledRejection')).toBe(1);
    errors.emit('uncaughtException', new Error('boom from nowhere'));
    await rig.until('error: boom from nowhere (see logs/tui.log)');
    expect(readFileSync(tuiLogPath(rig.home), 'utf8')).toContain('uncaught: Error: boom from nowhere');
    errors.emit('unhandledRejection', 'a promise nobody awaited');
    await rig.until('error: a promise nobody awaited');
    expect(readFileSync(tuiLogPath(rig.home), 'utf8')).toContain('a promise nobody awaited');
    await rig.send('hi');
    await rig.until('Карта готова.');
    expect(await rig.close()).toBe(0);
    // Leaving takes the handlers off again.
    expect(errors.listenerCount('uncaughtException')).toBe(0);
    expect(errors.listenerCount('unhandledRejection')).toBe(0);
  });

  test('by default the handlers are the process’s: on before the renderer, off when the TUI is over', async () => {
    const home = tmpHome('rp-core-tui-');
    const e0 = await Engine.open({ home, clock: fakeClock() });
    const id = e0.createSession({ character: MIRA, persona: LEVI }).id;
    await e0.close();
    const before = { u: process.listeners('uncaughtException'), r: process.listeners('unhandledRejection') };
    let added = { u: [] as NodeJS.UncaughtExceptionListener[], r: [] as NodeJS.UnhandledRejectionListener[] };
    const createRenderer = async (): Promise<never> => {
      added = {
        u: process.listeners('uncaughtException').filter((l) => !before.u.includes(l)),
        r: process.listeners('unhandledRejection').filter((l) => !before.r.includes(l)),
      };
      // The installed handlers, called directly (nothing reaches the process's other listeners).
      added.u[0]?.(new Error('boom before the renderer'), 'uncaughtException');
      added.r[0]?.('rejected before the renderer', Promise.resolve());
      throw new Error('no renderer in this test');
    };
    const io = { out: memoryChannel(), err: memoryChannel() };
    await expect(cmdTui({ rt: loadRuntime(home, {}), io, exitNow: () => {}, sessionId: id, tty: true, createRenderer })).rejects.toThrow('no renderer in this test');
    expect(added.u).toHaveLength(1);
    expect(added.r).toHaveLength(1);
    expect(added.u[0]).toBe(added.r[0] as unknown as NodeJS.UncaughtExceptionListener);
    const log = readFileSync(tuiLogPath(home), 'utf8');
    expect(log).toContain('uncaught: Error: boom before the renderer');
    expect(log).toContain('rejected before the renderer');
    expect(process.listeners('uncaughtException')).toEqual(before.u);
    expect(process.listeners('unhandledRejection')).toEqual(before.r);
  });
});

describe('nothing the Repl says is lost (T-14)', () => {
  test('every Repl line goes to the transcript and tui.log; a failed answer is logged too', async () => {
    rig = await tuiRig(calls([{ error: { code: 'bad_request', status: 400, message: 'upstream exploded' } }]));
    await rig.until('Hello, Levi');
    await rig.send('/nonsense');
    await rig.until('unknown command /nonsense');
    await rig.send('hi');
    await rig.until('--debug shows');
    const log = readFileSync(tuiLogPath(rig.home), 'utf8');
    expect(log).toContain('unknown command /nonsense; /help lists the commands');
    expect(log).toContain('request/bad_request');
    expect(log).toContain(`(rp-core tui ${rig.session.id} --debug shows the server's own words)`);
    // Nothing reached the real channels while the TUI was up.
    expect(rig.err()).toBe('');
  });

  test('exit 130 (Ctrl+C three times on an answer): why is printed on stderr after the terminal is restored', async () => {
    rig = await tuiRig(calls([{ text: 'Половина ' }, { pause: 'p' }, { text: 'конец.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Половина');
    // Three presses before the stop settles: stop, "still stopping", leave at once.
    rig.setup.mockInput.pressCtrlC();
    rig.setup.mockInput.pressCtrlC();
    rig.setup.mockInput.pressCtrlC();
    expect(await rig.done).toBe(130);
    expect(rig.out()).toBe(RESET);
    expect(rig.err()).toBe(
      '(still stopping; press Ctrl+C once more to leave at once: the next open recovers this turn)\n! left with the turn still open; the next open recovers it\n',
    );
    rig.provider.release('p');
  });

  test('exit 0: nothing is printed after the terminal is restored', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('/nonsense');
    await rig.until('unknown command');
    await rig.send('/quit');
    expect(await rig.done).toBe(0);
    expect(rig.err()).toBe('');
  });
});

describe('opening', () => {
  test('a session with history shows its whole path once (where-you-are is not repeated)', async () => {
    const first = await tuiRig(calls([{ text: 'Первый ответ.' }]));
    await first.until('Hello, Levi');
    await first.send('Привет');
    await first.until('swipe 1/1');
    expect(await first.close()).toBe(0);
    rig = await tuiRig([], { home: first.home, sessionId: first.session.id });
    const f = await rig.until('Первый ответ.');
    expect(f.split('Первый ответ.').length - 1).toBe(1);
    expect(f.split('Привет').length - 1).toBe(1);
    expect(f.split('Hello, Levi').length - 1).toBe(1);
  });

  test('/fork shows the new session from the top, once', async () => {
    rig = await tuiRig(ANSWER);
    await rig.until('Hello, Levi');
    await rig.send('Привет');
    await rig.until('swipe 1/1');
    await rig.send('/fork');
    await waitFor(() => rig!.engine.listSessions().length === 2, 'the fork');
    const f = await rig.until('Карта готова.');
    expect(f.split('Карта готова.').length - 1).toBe(1);
  });

  test('NO_COLOR: the monochrome theme still draws the three panes', async () => {
    rig = await tuiRig(ANSWER, { env: { NO_COLOR: '1' } });
    const f = await rig.until('Hello, Levi');
    expect(f).toContain('Models');
    expect(f).toContain('Agents');
  });
});

describe('main: the tui command', () => {
  const io = () => {
    const out = memoryChannel();
    const err = memoryChannel();
    return { out, err, io: { out, err } };
  };

  test('tui without a terminal: 64 and the way out (OpenTUI is not needed for it)', async () => {
    const c = io();
    const home = tmpHome('rp-core-tui-');
    const code = await main(['tui', 'abc', '--home', home], { io: c.io, env: {}, exit: () => {}, tty: false });
    expect(code).toBe(64);
    expect(c.err.text()).toBe(`${NEEDS_TERMINAL}\n`);
  });

  test('tui without a session: usage error', async () => {
    const c = io();
    const code = await main(['tui', '--home', tmpHome('rp-core-tui-')], { io: c.io, env: {}, exit: () => {}, tty: true });
    expect(code).toBe(64);
    expect(c.err.text()).toContain('which session? rp-core tui <session>');
  });

  test('help lists tui; help tui explains it', async () => {
    const a = io();
    expect(await main(['--help'], { io: a.io, env: {}, exit: () => {} })).toBe(0);
    expect(a.out.text()).toMatch(/\n {2}tui +open a session full-screen/);
    const b = io();
    expect(await main(['help', 'tui'], { io: b.io, env: {}, exit: () => {} })).toBe(0);
    expect(b.out.text()).toContain('Usage: rp-core tui <session>');
    expect(b.out.text()).toContain('Ctrl+R swipe');
  });

  test('new --tui: refused with --json / --no-chat, and without a terminal (no session is made)', async () => {
    const card = join(import.meta.dir, '..', 'fixtures', 'cards', 'v3-full.json');
    const home = tmpHome('rp-core-tui-');
    const a = io();
    expect(await main(['new', '--card', card, '--tui', '--json', '--home', home], { io: a.io, env: {}, exit: () => {}, tty: true })).toBe(64);
    expect(a.err.text()).toContain('--tui opens the chat; it cannot be combined with --json');
    const b = io();
    expect(await main(['new', '--card', card, '--tui', '--no-chat', '--home', home], { io: b.io, env: {}, exit: () => {}, tty: true })).toBe(64);
    const c = io();
    expect(await main(['new', '--card', card, '--tui', '--home', home], { io: c.io, env: {}, exit: () => {}, tty: false })).toBe(64);
    expect(c.err.text()).toBe(`${NEEDS_TERMINAL}\n`);
    const sessions = join(home, 'sessions');
    expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);
  });
});
