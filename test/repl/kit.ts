// Shared setup for the REPL tests (not a test file itself): a real engine over a scripted provider,
// a memory Io, a line input the test types into, and a captured Ctrl+C handler.
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import type { RpConfig } from '../../src/config/config.ts';
import type { Character, Persona } from '../../src/formats/native.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { runReplWith, type ReplDeps } from '../../src/cli/repl.ts';
import type { ModelCaps, Provider } from '../../src/providers/types.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider, type ScriptStep } from '../../src/providers/scripted.ts';
import { readSessionFile, type SessionLog, openSessionLog } from '../../src/session/log.ts';
import type { DeepPartial, Entry, SessionConfig } from '../../src/session/entries.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

export const MIRA: Character = {
  name: 'Mira',
  description: '{{char}} maps dreams for {{user}}.',
  greetings: ['*Mira looks up.* "Hello, {{user}}."', 'The lamp flickers.'],
};
export const LEVI: Persona = { name: 'Levi', description: 'A traveller.' };

export const calls = (...steps: ScriptStep[][]): ScriptCall[] => steps.map((s) => ({ steps: s }));

/** An async line source the test types into; `end()` is EOF. */
export function typedInput() {
  const lines: string[] = [];
  let ended = false;
  let waiter: (() => void) | null = null;
  const wake = (): void => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const iterator: AsyncIterator<string> = {
    async next(): Promise<IteratorResult<string>> {
      while (lines.length === 0 && !ended) await new Promise<void>((r) => (waiter = r));
      if (lines.length > 0) return { done: false, value: lines.shift()! };
      return { done: true, value: undefined };
    },
    async return(): Promise<IteratorResult<string>> {
      ended = true;
      wake();
      return { done: true, value: undefined };
    },
  };
  return {
    input: {
      [Symbol.asyncIterator]: () => iterator,
      close(): void {
        ended = true;
        wake();
      },
    },
    type(...more: string[]): void {
      lines.push(...more);
      wake();
    },
    end(): void {
      ended = true;
      wake();
    },
  };
}

export const CONFIG: RpConfig = {
  path: null,
  connections: {
    script: { id: 'script', dialect: 'openai-chat', baseUrl: 'http://127.0.0.1:9' },
    alt: { id: 'alt', dialect: 'openai-chat', baseUrl: 'http://127.0.0.1:9' },
    // In config.toml but not given to the engine: a turn on it is refused no_connection.
    ghost: { id: 'ghost', dialect: 'openai-chat', baseUrl: 'http://127.0.0.1:9' },
  },
  sessionDefaults: {},
  caps: {},
  prices: { 'script:default': { inPerM: 1, outPerM: 2, asOf: '2026-10-01' } },
};

export interface ReplRig {
  home: string;
  engine: EngineHandle;
  session: SessionHandle;
  provider: ScriptedProvider;
  /** Everything the REPL printed so far. */
  out(): string;
  type(...lines: string[]): void;
  end(): void;
  /** Press Ctrl+C. */
  interrupt(): void;
  /** Resolves with runRepl's exit code. */
  done: Promise<number>;
  /** Wait until the output contains `text` (`times` occurrences). */
  until(text: string, times?: number): Promise<void>;
  /** The texts the fake editor was opened with. */
  edited: string[];
  close(): Promise<void>;
}

export interface ReplRigOptions {
  character?: Character;
  interactive?: boolean;
  /** What the fake editor returns (null: cancelled). */
  editor?: (initial: string) => string | null;
  /** An existing session to open instead of a new one (with this home). */
  home?: string;
  sessionId?: string;
  color?: boolean;
  /** Config of the new session. */
  config?: DeepPartial<SessionConfig>;
  /** Replace the session handle the REPL gets (a stand-in that misbehaves). */
  wrap?: (s: SessionHandle) => SessionHandle;
  /** The caps window of a binding before its first answer (ReplDeps.windowOf). */
  windowOf?: (conn: string, model: string) => number | null;
  /** More ReplDeps (failExit, override, …), merged over the kit's. */
  deps?: Partial<ReplDeps>;
  /** Give the scripted connection a wire() (a fake HTTP body: model, max_tokens, message count). */
  wire?: boolean;
  /** The config.toml the REPL sees (default CONFIG). */
  rpConfig?: RpConfig;
  /** M3: the caps of the scripted connections (default SCRIPT_CAPS, tools 'none'); the REPL sees them through capsOf. */
  caps?: ModelCaps;
  /** ReplOptions.env ($VISUAL / $EDITOR / NO_COLOR); default process.env. */
  env?: Record<string, string | undefined>;
  /**
   * M5c: engine seams — the lane's mode (default: the preload's manual) and the recall mode default
   * ('config': the session's own mode applies, not the preload's RP_CORE_RECALL=lexical).
   */
  engine?: { lane?: 'auto' | 'manual'; recall?: 'lexical' | 'off' | 'config' };
  /** M5c: the scripted origin is local to the scheduler (scripted.ts localOrigin); absent: remote. */
  local?: boolean;
}

export async function replRig(script: ScriptCall[], o: ReplRigOptions = {}): Promise<ReplRig> {
  const home = o.home ?? tmpHome('rp-core-repl-');
  const provider = createScriptedProvider(script, o.local !== undefined ? { localOrigin: o.local } : undefined);
  if (o.wire) {
    (provider as Provider).wire = (req) => ({ url: 'http://127.0.0.1:9/v1/chat/completions', body: { model: req.model.model, max_tokens: req.maxTokens, n: req.messages.length } });
  }
  const caps = o.caps ?? SCRIPT_CAPS;
  const conn: Connection = { id: 'script', provider, caps, origin: 'script:script', local: true };
  const engine = await Engine.open({
    home,
    connections: { script: conn, alt: { ...conn, id: 'alt', origin: 'script:alt' } },
    clock: fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
    ...(o.engine?.lane !== undefined ? { lane: o.engine.lane } : {}),
    ...(o.engine?.recall !== undefined ? { recall: o.engine.recall } : {}),
  });
  const session = o.sessionId ? engine.session(o.sessionId) : engine.createSession({ character: o.character ?? MIRA, persona: LEVI, ...(o.config ? { config: o.config } : {}) });
  const out = memoryChannel();
  const err = memoryChannel();
  const typed = typedInput();
  let onCtrlC: (() => void) | null = null;
  const edited: string[] = [];
  const done = runReplWith(
    {
      engine,
      session: o.wrap ? o.wrap(session) : session,
      config: o.rpConfig ?? CONFIG,
      home,
      io: { out, err },
      input: typed.input,
      onInterrupt: (h) => {
        onCtrlC = h;
        return () => {
          onCtrlC = null;
        };
      },
      editText: async (initial) => {
        edited.push(initial);
        return o.editor ? o.editor(initial) : null;
      },
      color: o.color ?? false,
      // The banner's tools word and /preview's transport: the engine's connections' caps.
      capsOf: (c) => (c === 'script' || c === 'alt' ? caps : null),
      ...(o.windowOf ? { windowOf: o.windowOf } : {}),
      // The engine's lane, when the rig sets it (else both read RP_CORE_LANE, the preload's manual).
      ...(o.engine?.lane !== undefined ? { lane: o.engine.lane } : {}),
      ...o.deps,
    },
    { interactive: o.interactive ?? false, ...(o.env ? { env: o.env } : {}) },
  );
  const count = (s: string, sub: string): number => s.split(sub).length - 1;
  return {
    home,
    engine,
    session,
    provider,
    out: () => out.text(),
    type: typed.type,
    end: typed.end,
    interrupt: () => onCtrlC?.(),
    done,
    edited,
    async until(text: string, times = 1): Promise<void> {
      for (let waited = 0; count(out.text(), text) < times; waited += 2) {
        if (waited > 5000) throw new Error(`timed out waiting for ${JSON.stringify(text)} x${times}; output:\n${out.text()}`);
        await new Promise((r) => setTimeout(r, 2));
      }
    },
    async close(): Promise<void> {
      typed.end();
      await done;
      await engine.close();
    },
  };
}

/** Entries of a session as written to disk. */
export function entriesOf(home: string, id: string): Entry[] {
  return readSessionFile(home, id).entries;
}

/** Write raw lines into a closed session (a crash), through the real log. */
export function writeRaw(home: string, id: string, fn: (log: SessionLog) => void): void {
  const { log } = openSessionLog(home, id);
  try {
    fn(log);
  } finally {
    log.close();
  }
}
