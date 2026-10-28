// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core chat <session>` and the REPL that `rp-core new` opens on a terminal (ARCHITECTURE.md §12.4,
// §15 M1b). The REPL itself lives in repl.ts; this file opens the engine with the configured
// connections, hands the session over and shuts down in the right order.
//
// Exit codes: 0 after /quit or the end of input; 3 when the chat plays --provider script: or
// replay: and an answer failed (a replay_mismatch, an exhausted script), so a piped replay in CI
// fails loudly; 130 / 143 as below.
// Signals: the REPL owns SIGINT (stop the turn; twice at the prompt quits). SIGTERM is handled here:
// close the engine (the running turn stops with its partial text kept, the lock is released), then
// exit 143; a second SIGTERM leaves at once. Exit 130 from the REPL means a turn would not settle
// after Stop: the engine is not waited for (the next open recovers that turn, as after a crash).
// runChat is three exported pieces a full-screen host (the TUI) reuses with its own ports: chatDeps
// (the REPL's deps), onChatTerm (SIGTERM, its line and its exit injected) and endChat (the close).

import { Engine } from '../engine/engine.ts';
import { systemClock } from '../engine/system.ts';
import { Refusal, type Connection, type EngineHandle, type EngineOptions, type SessionHandle } from '../engine/api.ts';
import type { Event } from '../protocol/events.ts';
import type { Io } from './io.ts';
import { EXIT, reportRefusal } from './oneshot.ts';
import { runRepl, type ReplDeps } from './repl.ts';
import { runProbe } from './catalog.ts';
import { bindingCaps, connectionCaps, connectionProblem, connectionWindow, engineOptions, redactor, windowOf, type Runtime } from './runtime.ts';
import { EXIT_SIGINT, EXIT_SIGTERM, type SignalSource } from './signals.ts';

export interface ChatArgs {
  rt: Runtime;
  io: Io;
  /** Leave the process at once (second SIGTERM, or after SIGTERM closed the engine). Never returns. */
  exitNow: (code: number) => void;
  /** process by default; tests pass a stand-in. */
  signals?: SignalSource;
  /** Extra engine options (tests: clock, random, timers). */
  engine?: Partial<EngineOptions>;
  /** For /probe --active (default globalThis.fetch and the system clock). */
  fetch?: typeof fetch;
  clock?: () => Date;
  /**
   * M5b (D-181): the engine's bus, subscribed before the session was opened (cmdChat, cmdTui), so what
   * the background lane says at open reaches the REPL (ReplDeps.events). Absent: the REPL subscribes as
   * it starts.
   */
  events?: AsyncIterable<Event>;
}

/** `rp-core chat <session>`: open (lock + recovery) and run the REPL until /quit or EOF. */
export async function cmdChat(a: ChatArgs & { sessionId: string }): Promise<number> {
  const engine = await Engine.open({ ...a.engine, ...engineOptions(a.rt) });
  // Before the open: the lane's notices at open (a backlog, shared slots) are on the bus only.
  const events = engine.events();
  let session: SessionHandle;
  try {
    session = engine.session(a.sessionId);
  } catch (e) {
    await engine.close();
    if (e instanceof Refusal) return reportRefusal(a.io, e, false, a.rt);
    throw e;
  }
  return runChat(engine, session, { ...a, events });
}

/** ReplDeps.override of a --provider script: / replay: connection (its origin says which). */
export function overrideOf(conn: Connection): NonNullable<ReplDeps['override']> {
  return {
    conn: conn.id,
    plays: conn.origin.startsWith('replay:') ? 'recording' : 'script',
    windowOf: (model) => connectionWindow(conn, model),
    capsOf: (model) => connectionCaps(conn, model),
  };
}

/** Run the REPL on an open session of `engine`; closes the engine when the REPL ends. */
export async function runChat(engine: EngineHandle, session: SessionHandle, a: ChatArgs): Promise<number> {
  const offTerm = onChatTerm(engine, { signals: a.signals, say: (line) => a.io.err.write(`\n${line}\n`), exitNow: a.exitNow });
  let code: number;
  try {
    code = await runRepl(chatDeps(engine, session, a));
  } catch (e) {
    offTerm();
    await engine.close();
    throw e;
  }
  offTerm();
  return endChat(engine, code);
}

/**
 * The REPL's deps for a chat on `session` (runChat; a full-screen host builds the same and adds its
 * own ports): /open, the banner's window and caps, redaction, /probe --active (not under record:),
 * the --debug tap, /model's connection check (not under --provider), and under --provider script: /
 * replay: failExit plus the override. `a.io` becomes deps.io (the REPL writes only io.out, through
 * its default view, and flushes it at the end).
 */
export function chatDeps(engine: EngineHandle, session: SessionHandle, a: Pick<ChatArgs, 'rt' | 'io' | 'fetch' | 'clock' | 'events'>): ReplDeps {
  // --debug: while the REPL runs, raw provider failures go through its screen (engineOptions reads
  // rt.debug at the moment of a failure), so they never glue into a streamed answer.
  const plainDebug = a.rt.debug;
  const debugTap = plainDebug
    ? (print: (line: string, call?: { job?: string }) => void): (() => void) => {
        a.rt.debug = print;
        return () => {
          a.rt.debug = plainDebug;
        };
      }
    : undefined;
  return {
    engine,
    session,
    config: a.rt.config,
    home: a.rt.home,
    io: a.io,
    openSession: (id) => engine.session(id),
    windowOf: (conn, model) => windowOf(a.rt, conn, model),
    capsOf: (conn, model) => bindingCaps(a.rt, conn, model),
    redact: redactor(a.rt),
    // /probe --active calls the configured connection; under record: those calls would land in
    // the recording, so it is left to the shell there.
    ...(a.rt.recording === undefined
      ? {
          probe: async (p: { target: string; write: boolean; io: Io; signal: AbortSignal }) => {
            const r = await runProbe({
              rt: a.rt,
              io: p.io,
              json: false,
              clock: a.clock ?? systemClock,
              target: p.target,
              write: p.write,
              active: true,
              signal: p.signal,
              ...(a.fetch ? { fetch: a.fetch } : {}),
            });
            return { code: r.code, written: r.results.some((x) => x.written) };
          },
        }
      : {}),
    ...(debugTap ? { debugTap } : {}),
    // Under --provider every role plays the script: /model only checks config.toml's names then.
    ...(a.rt.provider ? {} : { connectionProblem: (conn: string) => connectionProblem(a.rt, conn) }),
    // A script or a replay is a test of the turn loop: a failed answer fails the run (exit 3).
    // Every turn runs on that connection: the banner takes its window from it.
    ...(a.rt.provider ? { failExit: true, override: overrideOf(a.rt.provider) } : {}),
    ...(a.events ? { events: a.events } : {}),
  };
}

/** What SIGTERM says before the engine closes (runChat writes it to io.err on a line of its own). */
export const TERMINATED_LINE = 'rp-core: terminated: closing the session (the partial answer is kept)';

export interface ChatTermOptions {
  /** process by default; tests pass a stand-in. */
  signals?: SignalSource | undefined;
  /** Say TERMINATED_LINE (runChat: `\n<line>\n` on io.err; a full-screen host: its own log). */
  say: (line: string) => void;
  /** Leave the process with this code (143): after the engine closed, or at once on a second SIGTERM. Never returns. */
  exitNow: (code: number) => void;
}

/**
 * SIGTERM while a chat runs: say so, close the engine (the running turn stops with its partial text
 * kept, the lock is released), then exitNow(143); a second SIGTERM leaves at once. Returns the
 * function that removes the handler (call it when the REPL returned).
 */
export function onChatTerm(engine: EngineHandle, o: ChatTermOptions): () => void {
  const source: SignalSource = o.signals ?? process;
  let terminating = false;
  const onTerm = (): void => {
    if (terminating) return o.exitNow(EXIT_SIGTERM);
    terminating = true;
    o.say(TERMINATED_LINE);
    void engine
      .close()
      .catch(() => {})
      .finally(() => o.exitNow(EXIT_SIGTERM));
  };
  source.on('SIGTERM', onTerm);
  return () => void source.removeListener('SIGTERM', onTerm);
}

/**
 * After the REPL returned `code`: close the engine and give the process exit code. Exit 130 (a turn
 * that would not settle after Stop) leaves without waiting for the engine; the lock stays for recovery.
 */
export async function endChat(engine: EngineHandle, code: number): Promise<number> {
  if (code === EXIT_SIGINT) {
    void engine.close().catch(() => {});
    return code;
  }
  await engine.close();
  return code === 0 ? EXIT.done : code;
}
