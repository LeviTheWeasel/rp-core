// Every exit signal is the TUI's (TUI decisions T-13) and nothing the Repl says on the way out is lost
// (T-14): OpenTUI handles no signal; SIGTERM, SIGHUP, SIGQUIT, SIGABRT, SIGPIPE and SIGBUS close the
// engine (lock released, partial answer kept) and leave with 128 + n after the terminal is restored;
// the restored terminal is told the signal's line and the Repl's exit summary. Checked on the real
// process listeners, and on a real `rp-core tui` in a pseudo-terminal (a hangup and a closed terminal).
// Also the status row while a long command runs (T-15), which needs this file's runtime with a base URL.
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { engineOptions, loadRuntime, type Runtime } from '../../src/cli/runtime.ts';
import { TERMINATED_LINE } from '../../src/cli/chat.ts';
import { messageText } from '../../src/cli/render.ts';
import { readLock } from '../../src/session/log.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import { rendererConfig } from '../../src/cli/tui/app.ts';
import { tuiLogPath } from '../../src/cli/tui/io.ts';
import { EXIT_SIGNALS, runTui, signalExitCode, signalLine, WORKING, type ExitSignal } from '../../src/cli/tui/run.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, LEVI, MIRA, tuiRig, type TuiRig } from './kit.ts';

const RESET = '\x1b[?2027l';
const REPO = join(import.meta.dir, '..', '..');

async function waitFor(ok: () => boolean, what: string, ms = 5000): Promise<void> {
  for (let waited = 0; !ok(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- runTui on a headless renderer, with the process's own signal listeners (no stand-in) -----------

interface Direct {
  home: string;
  engine: EngineHandle;
  session: SessionHandle;
  setup: TestRendererSetup;
  rt: Runtime;
  exits: number[];
  out(): string;
  err(): string;
  log(): string;
  done: Promise<number>;
  until(text: string): Promise<string>;
}

let direct: Direct | null = null;
let rig: TuiRig | null = null;
afterEach(async () => {
  for (const r of [direct, rig]) {
    if (r && !r.setup.renderer.isDestroyed) {
      r.setup.mockInput.pressEscape();
      await r.setup.mockInput.pressKeys([...'/quit']);
      r.setup.mockInput.pressEnter();
      await r.done;
    }
  }
  direct = null;
  rig = null;
});

/** runTui over a scripted provider, with `signals` left out: the real process listeners. */
async function directRig(
  script: ScriptCall[],
  o: { rt?: Partial<Runtime>; signals?: EventEmitter; playsScript?: boolean; fetch?: typeof fetch; onRenderer?: (rt: Runtime) => void } = {},
): Promise<Direct> {
  const home = tmpHome('rp-core-tui-sig-');
  const provider = createScriptedProvider(script);
  // A base URL as config.toml gives one: /probe --active asks it (through `fetch`).
  const conn: Connection = { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true, baseUrl: 'http://127.0.0.1:9' };
  const connections = { script: conn };
  const rt: Runtime = { ...loadRuntime(home, {}), config: CONFIG, connections, ...(o.playsScript ? { provider: conn } : {}), ...o.rt };
  const engine = await Engine.open({
    ...engineOptions(rt),
    clock: fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
  });
  const session = engine.createSession({ character: MIRA, persona: LEVI });
  const setup = await createTestRenderer({ width: 130, height: 30, kittyKeyboard: true, ...rendererConfig() });
  const out = memoryChannel();
  const err = memoryChannel();
  const exits: number[] = [];
  const done = runTui(engine, session, {
    rt,
    io: { out, err },
    exitNow: (c) => void exits.push(c),
    ...(o.signals ? { signals: o.signals } : {}),
    env: { HOME: home },
    createRenderer: async () => {
      o.onRenderer?.(rt);
      return setup.renderer;
    },
    clock: fakeClock(),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  let last = '';
  return {
    home,
    engine,
    session,
    setup,
    rt,
    exits,
    out: () => out.text(),
    err: () => err.text(),
    log: () => (existsSync(tuiLogPath(home)) ? readFileSync(tuiLogPath(home), 'utf8') : ''),
    done,
    async until(text: string): Promise<string> {
      await waitFor(() => {
        if (!setup.renderer.isDestroyed) {
          void setup.renderOnce();
          try {
            last = setup.captureCharFrame();
          } catch {
            /* disposed */
          }
        }
        return last.includes(text);
      }, JSON.stringify(text));
      return last;
    },
  };
}

describe('exit signals on the real process listeners (T-13)', () => {
  test('OpenTUI is given no signal of its own', () => {
    expect(rendererConfig().exitSignals).toEqual([]);
    expect([...EXIT_SIGNALS]).toEqual(['SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGBUS']);
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalLine('SIGTERM')).toBe(TERMINATED_LINE);
  });

  test('SIGHUP while idle: engine closed, lock released, terminal restored, the line told after it, 129', async () => {
    direct = await directRig(calls([{ text: 'Ответ.' }]));
    await direct.until('Hello, Levi');
    expect(readLock(direct.home, direct.session.id)).not.toBeNull();
    process.emit('SIGHUP');
    await waitFor(() => direct!.exits.length > 0, 'exitNow');
    expect(direct.exits).toEqual([129]);
    expect(direct.setup.renderer.isDestroyed).toBe(true);
    expect(readLock(direct.home, direct.session.id)).toBeNull();
    // The reset first, then the line on the restored terminal (stderr), as runChat says SIGTERM.
    expect(direct.out()).toBe(RESET);
    expect(direct.err()).toBe(`${signalLine('SIGHUP')}\n`);
    const log = direct.log();
    expect(log).toContain('rp-core: SIGHUP: closing the session');
    expect(log).toContain('closed');
    expect(log).toContain('exit 129');
    expect(await direct.done).toBe(0); // the Repl wound down too (its input ended)
    // Our listeners are gone once the TUI is over.
    expect(process.listenerCount('SIGHUP')).toBe(0);
  });

  test.each(['SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGBUS'] as ExitSignal[])('%s takes the same path (128 + n)', async (sig) => {
    const signals = new EventEmitter();
    direct = await directRig(calls([{ text: 'Ответ.' }]), { signals });
    await direct.until('Hello, Levi');
    signals.emit(sig);
    await waitFor(() => direct!.exits.length > 0, 'exitNow');
    expect(direct.exits).toEqual([signalExitCode(sig)]);
    expect(readLock(direct.home, direct.session.id)).toBeNull();
    expect(direct.err()).toBe(`rp-core: ${sig}: closing the session (the partial answer is kept)\n`);
  });

  test('a second signal leaves at once', async () => {
    const signals = new EventEmitter();
    direct = await directRig(calls([{ text: 'Ответ.' }]), { signals });
    await direct.until('Hello, Levi');
    signals.emit('SIGHUP');
    signals.emit('SIGTERM');
    expect(direct.exits).toEqual([143]); // synchronously, before the engine closed
    await waitFor(() => direct!.exits.length > 1, 'the first one leaving');
    expect(readLock(direct.home, direct.session.id)).toBeNull();
  });

  test('SIGHUP mid-answer: the partial answer is kept, nothing writes into the destroyed renderer', async () => {
    rig = await tuiRig(calls([{ text: 'Половина ' }, { pause: 'p' }, { text: 'конец.' }]));
    await rig.until('Hello, Levi');
    await rig.send('hi');
    await rig.until('Половина');
    rig.signals.emit('SIGHUP');
    await waitFor(() => rig!.exits.length > 0, 'exitNow');
    expect(rig.exits).toEqual([129]);
    expect(await rig.done).toBe(0);
    const head = rig.session.view().path.at(-1)!;
    expect(head.role).toBe('assistant');
    expect(messageText(head)).toBe('Половина ');
    expect(readLock(rig.home, rig.session.id)).toBeNull();
    const log = readFileSync(tuiLogPath(rig.home), 'utf8');
    expect(log).not.toContain('is destroyed');
    expect(log).not.toContain('uncaught');
  });

  test('the renderer destroyed any other way: the input ends, the chat closes as after /quit', async () => {
    rig = await tuiRig(calls([{ text: 'Ответ.' }]));
    await rig.until('Hello, Levi');
    rig.setup.renderer.destroy();
    expect(await rig.done).toBe(0);
    expect(readLock(rig.home, rig.session.id)).toBeNull();
    expect(readFileSync(tuiLogPath(rig.home), 'utf8')).toContain('the renderer was destroyed: the input ends');
    // A late Ctrl+C from outside finds nothing to break.
    rig.signals.emit('SIGINT');
    expect(rig.err()).toBe('');
  });
});

describe('what the restored terminal is told (T-14)', () => {
  test('exit 3: the Repl\'s summary is printed on stderr after the terminal is restored', async () => {
    // --provider script: the chat plays a script, and a failed answer makes it exit 3.
    direct = await directRig(calls([{ text: 'Один.' }]), { signals: new EventEmitter(), playsScript: true });
    await direct.until('Hello, Levi');
    const keys = direct.setup.mockInput;
    await keys.pressKeys([...'hi']);
    keys.pressEnter();
    await direct.until('Один.');
    await keys.pressKeys([...'again']);
    keys.pressEnter();
    await direct.until('script_exhausted');
    await keys.pressKeys([...'/quit']);
    keys.pressEnter();
    expect(await direct.done).toBe(3);
    expect(direct.out()).toBe(RESET);
    expect(direct.err()).toBe('(1 answer failed: script_exhausted; exit 3)\n');
    expect(direct.log()).toContain('(1 answer failed: script_exhausted; exit 3)');
  });

  test('--debug lines reach tui.log, never the real stderr while the TUI is up; rt.debug is given back', async () => {
    const printed: string[] = [];
    const own = (line: string): void => void printed.push(line);
    direct = await directRig(calls([{ error: { code: 'bad_request', status: 400, message: 'upstream exploded' } }]), {
      signals: new EventEmitter(),
      rt: { debug: own },
      // Outside the Repl's run (here: as the renderer starts) a debug line goes through the TUI's Io too.
      onRenderer: (rt) => rt.debug?.('a line before the Repl runs'),
    });
    await direct.until('Hello, Levi');
    const keys = direct.setup.mockInput;
    await keys.pressKeys([...'hi']);
    keys.pressEnter();
    await direct.until('debug:');
    expect(direct.err()).toBe('');
    expect(printed).toEqual([]);
    expect(direct.log()).toContain('rp-core: debug: a line before the Repl runs');
    expect(direct.log()).toMatch(/debug: script:default .*HTTP 400: upstream exploded/);
    await keys.pressKeys([...'/quit']);
    keys.pressEnter();
    expect(await direct.done).toBe(0);
    expect(direct.rt.debug).toBe(own);
  });
});

describe('a long command (T-15)', () => {
  test('"working…" in the status row, lines sent meanwhile counted as queued, ready again after', async () => {
    // /probe --active waits on the server (here a fetch that never answers) until Ctrl+C stops it.
    let asked = 0;
    const fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      asked++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof globalThis.fetch;
    direct = await directRig(calls([{ text: 'Ответ.' }]), { signals: new EventEmitter(), fetch });
    const keys = direct.setup.mockInput;
    const send = async (line: string): Promise<void> => {
      await keys.pressKeys([...line]);
      keys.pressEnter();
    };
    await direct.until('Hello, Levi');
    await send('/probe --active');
    await direct.until('probing script:default');
    await direct.until(WORKING);
    expect(asked).toBe(1);
    await send('/think');
    await direct.until('working… · queued: 1');
    await send('/think show');
    await direct.until('working… · queued: 2');
    keys.pressCtrlC();
    // The queued lines ran in order after the probe, then the Repl waited for input again.
    const f = await direct.until('ready · Enter sends');
    expect(f).not.toContain('working…');
    const rows = f.split('\n');
    const row = (re: RegExp): number => rows.findIndex((r) => re.test(r));
    expect(row(/probe stopped/)).toBeGreaterThan(0);
    expect(row(/you  › \/think +│/)).toBeGreaterThan(row(/probe stopped/));
    expect(row(/you  › \/think show/)).toBeGreaterThan(row(/you  › \/think +│/));
  });
});

// ---- a real `rp-core tui` in a pseudo-terminal ---------------------------------------------------------

const PTY = process.platform !== 'win32' && typeof (Bun as { Terminal?: unknown }).Terminal === 'function';

interface Pty {
  proc: ReturnType<typeof Bun.spawn>;
  text(): string;
  /** The output from `mark` on. */
  since(mark: number): string;
  bytes(): number;
  until(text: string, ms?: number): Promise<void>;
  exit(ms?: number): Promise<number | 'timeout'>;
  close(): void;
}

function spawnPty(args: string[], env: Record<string, string> = {}): Pty {
  const chunks: Buffer[] = [];
  let size = 0;
  const proc = Bun.spawn([process.execPath, 'src/cli/main.ts', ...args], {
    cwd: REPO,
    env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: '', NO_COLOR: '', ...env },
    terminal: {
      cols: 120,
      rows: 36,
      data(_t, d) {
        chunks.push(Buffer.from(d));
        size += d.length;
      },
    },
  });
  const all = (): Buffer => Buffer.concat(chunks);
  const pty: Pty = {
    proc,
    text: () => all().toString('utf8'),
    since: (mark) => all().subarray(mark).toString('utf8'),
    bytes: () => size,
    async until(text, ms = 20_000) {
      await waitFor(() => pty.text().includes(text), `${JSON.stringify(text)} in the pty`, ms);
    },
    exit: (ms = 10_000) => Promise.race([proc.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]),
    close() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      try {
        proc.terminal?.close();
      } catch {
        /* already closed */
      }
    },
  };
  return pty;
}

/** A home with one session (Mira) and a script file for --provider script:. */
async function ptyHome(script: unknown[][]): Promise<{ home: string; id: string; script: string }> {
  const home = tmpHome('rp-core-tui-pty-');
  const e = await Engine.open({ home });
  const id = e.createSession({ character: MIRA, persona: LEVI }).id;
  await e.close();
  const file = join(home, 'script.jsonl');
  writeFileSync(file, `${script.map((c) => JSON.stringify(c)).join('\n')}\n`);
  return { home, id, script: file };
}

describe.skipIf(!PTY)('a real rp-core tui in a pseudo-terminal (T-13)', () => {
  let pty: Pty | null = null;
  afterEach(() => {
    pty?.close();
    pty = null;
  });

  test('kill -HUP: exit 129, the alternate screen left and mode 2027 reset, the lock released', async () => {
    const h = await ptyHome([[{ text: 'Ответ.' }]]);
    pty = spawnPty(['tui', h.id, '--home', h.home, '--provider', `script:${h.script}`]);
    await pty.until('Enter sends');
    expect(readLock(h.home, h.id)?.pid).toBe(pty.proc.pid);
    const mark = pty.bytes();
    pty.proc.kill('SIGHUP');
    expect(await pty.exit()).toBe(129);
    const tail = pty.since(mark);
    expect(tail).toContain('\x1b[?1049l');
    expect(tail).toContain('\x1b[?2027l');
    expect(tail.indexOf(signalLine('SIGHUP'))).toBeGreaterThan(tail.indexOf('\x1b[?1049l'));
    expect(readLock(h.home, h.id)).toBeNull();
    const log = readFileSync(tuiLogPath(h.home), 'utf8');
    expect(log).toContain('closed');
    expect(log).toContain('exit 129');
  }, 40_000);

  test('the terminal closed mid-answer: the process leaves, the partial answer is kept, the lock released', async () => {
    const h = await ptyHome([[{ text: 'Половина ' }, { delay: 20_000 }, { text: 'конец.' }]]);
    pty = spawnPty(['tui', h.id, '--home', h.home, '--provider', `script:${h.script}`]);
    await pty.until('Enter sends');
    pty.proc.terminal!.write('hi\r');
    await pty.until('Половина');
    pty.proc.terminal!.close();
    expect(await pty.exit()).toBe(129);
    expect(readLock(h.home, h.id)).toBeNull();
    const e = await Engine.open({ home: h.home });
    const head = e.session(h.id).view().path.at(-1)!;
    expect(head.role).toBe('assistant');
    expect(messageText(head)).toBe('Половина ');
    await e.close();
  }, 40_000);

  test('new --tui --sandbox, then a hangup: the sandbox home is removed', async () => {
    const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'rp-core-tui-tmp-'));
    const h = await ptyHome([[{ text: 'Ответ.' }]]);
    const card = join(REPO, 'test', 'fixtures', 'cards', 'v3-full.json');
    pty = spawnPty(['new', '--tui', '--card', card, '--sandbox', '--provider', `script:${h.script}`], { TMPDIR: tmp });
    await pty.until('Enter sends');
    expect(readdirSync(tmp).filter((n) => n.startsWith('rp-core-sandbox-'))).toHaveLength(1);
    pty.proc.kill('SIGHUP');
    expect(await pty.exit()).toBe(129);
    expect(readdirSync(tmp).filter((n) => n.startsWith('rp-core-sandbox-'))).toEqual([]);
  }, 40_000);
});
