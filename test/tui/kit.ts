// Shared setup for the TUI host tests (not a test file itself), cloned from test/repl/kit.ts replRig:
// a real engine over a scripted provider, a headless OpenTUI renderer (kitty keyboard), and the real
// host (runTui) driving the real Repl. Keys go in through the renderer's mock input; what the person
// would see is the captured frame.
import { EventEmitter } from 'node:events';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import type { RpConfig } from '../../src/config/config.ts';
import type { Character } from '../../src/formats/native.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import type { SignalSource } from '../../src/cli/signals.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { DeepPartial, SessionConfig } from '../../src/session/entries.ts';
import { rendererConfig } from '../../src/cli/tui/app.ts';
import { runTui, type ErrorEventSource, type TuiParts } from '../../src/cli/tui/run.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { CONFIG, LEVI, MIRA } from '../repl/kit.ts';

export { calls, CONFIG, LEVI, MIRA } from '../repl/kit.ts';

export interface TuiRigOptions {
  width?: number;
  height?: number;
  character?: Character;
  config?: DeepPartial<SessionConfig>;
  home?: string;
  sessionId?: string;
  env?: Record<string, string | undefined>;
  caps?: ModelCaps;
  rpConfig?: RpConfig;
  parts?: Partial<TuiParts>;
  exitWindowMs?: number;
  splashMs?: number;
  /** Where runTui listens for uncaught errors (default the process, as `rp-core tui`). */
  errors?: ErrorEventSource;
  /** Give the scripted connection a model catalog for picker tests. */
  catalog?: { baseUrl: string; fetch: typeof fetch };
}

/** A SIGINT / SIGTERM source the test emits on. */
export type FakeSignals = SignalSource & EventEmitter;

export interface TuiRig {
  home: string;
  engine: EngineHandle;
  session: SessionHandle;
  provider: ScriptedProvider;
  setup: TestRendererSetup;
  signals: FakeSignals;
  /** exitNow calls (SIGTERM, a SIGINT with no Repl listening). */
  exits: number[];
  /** What reached the real channels (after the renderer was gone). */
  out(): string;
  err(): string;
  /** runTui's exit code. */
  done: Promise<number>;
  frame(): Promise<string>;
  /** Wait until the frame shows `text` (`times` occurrences); returns that frame. */
  until(text: string, times?: number): Promise<string>;
  /** Wait until the frame no longer shows `text`. */
  gone(text: string): Promise<string>;
  /** Type into the input (pressKeys per code point: non-BMP safe). */
  type(text: string): Promise<void>;
  /** Type and press Enter. */
  send(text: string): Promise<void>;
  /** The input box's text now. */
  input(): string;
  close(): Promise<number>;
}

const count = (s: string, sub: string): number => s.split(sub).length - 1;

export async function tuiRig(script: ScriptCall[], o: TuiRigOptions = {}): Promise<TuiRig> {
  const home = o.home ?? tmpHome('rp-core-tui-');
  const provider = createScriptedProvider(script);
  const caps = o.caps ?? SCRIPT_CAPS;
  const conn: Connection = { id: 'script', provider, caps, origin: 'script:script', local: true, ...(o.catalog ? { baseUrl: o.catalog.baseUrl } : {}) };
  // The runtime's connections are the engine's, as in `rp-core tui` (engineOptions(rt)): the Repl's
  // capsOf / windowOf (the models pane's tools word and window) see the scripted caps.
  const connections = { script: conn, alt: { ...conn, id: 'alt', origin: 'script:alt' } };
  const engine = await Engine.open({
    home,
    connections,
    clock: fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
  });
  const session = o.sessionId ? engine.session(o.sessionId) : engine.createSession({ character: o.character ?? MIRA, persona: LEVI, ...(o.config ? { config: o.config } : {}) });
  const setup = await createTestRenderer({ width: o.width ?? 130, height: o.height ?? 30, kittyKeyboard: true, ...rendererConfig() });
  const out = memoryChannel();
  const err = memoryChannel();
  const signals = new EventEmitter() as FakeSignals;
  const exits: number[] = [];
  const rt = { ...loadRuntime(home, {}), config: o.rpConfig ?? CONFIG, connections };
  const done = runTui(engine, session, {
    rt,
    io: { out, err },
    exitNow: (c) => void exits.push(c),
    signals,
    env: o.env ?? { HOME: home },
    createRenderer: async () => setup.renderer,
    clock: fakeClock(),
    splashMs: o.splashMs ?? 0,
    ...(o.catalog ? { fetch: o.catalog.fetch } : {}),
    ...(o.parts ? { parts: o.parts } : {}),
    ...(o.exitWindowMs !== undefined ? { exitWindowMs: o.exitWindowMs } : {}),
    ...(o.errors ? { errors: o.errors } : {}),
  });
  let last = '';
  const frame = async (): Promise<string> => {
    if (!setup.renderer.isDestroyed) await setup.renderOnce();
    // After dispose() (a test that timed out still polling) the native buffer is gone: the last frame.
    try {
      last = setup.captureCharFrame();
    } catch {
      /* disposed */
    }
    return last;
  };
  const poll = async (ok: (f: string) => boolean, what: string): Promise<string> => {
    let f = '';
    for (let waited = 0; ; waited += 5) {
      f = await frame();
      if (ok(f)) return f;
      if (waited > 5000) throw new Error(`timed out waiting for ${what}; frame:\n${f}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const rig: TuiRig = {
    home,
    engine,
    session,
    provider,
    setup,
    signals,
    exits,
    out: () => out.text(),
    err: () => err.text(),
    done,
    frame,
    until: (text, times = 1) => poll((f) => count(f, text) >= times, `${JSON.stringify(text)} x${times}`),
    gone: (text) => poll((f) => !f.includes(text), `${JSON.stringify(text)} to go`),
    async type(text: string): Promise<void> {
      await setup.mockInput.pressKeys([...text]);
    },
    async send(text: string): Promise<void> {
      await setup.mockInput.pressKeys([...text]);
      setup.mockInput.pressEnter();
    },
    input: () => {
      const input = setup.renderer.root.findDescendantById('input') as unknown as { plainText: string } | undefined;
      return input?.plainText ?? '';
    },
    async close(): Promise<number> {
      if (!setup.renderer.isDestroyed) {
        // Esc: an open edit is cancelled, typed text cleared; then /quit is a line of its own.
        setup.mockInput.pressEscape();
        await rig.send('/quit');
      }
      const code = await done;
      await setup.dispose();
      return code;
    },
  };
  return rig;
}
