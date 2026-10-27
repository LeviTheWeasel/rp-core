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

import { Engine } from '../engine/engine.ts';
import { systemClock } from '../engine/system.ts';
import { Refusal, type Connection, type EngineHandle, type EngineOptions, type SessionHandle } from '../engine/api.ts';
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
}

/** `rp-core chat <session>`: open (lock + recovery) and run the REPL until /quit or EOF. */
export async function cmdChat(a: ChatArgs & { sessionId: string }): Promise<number> {
  const engine = await Engine.open({ ...a.engine, ...engineOptions(a.rt) });
  let session: SessionHandle;
  try {
    session = engine.session(a.sessionId);
  } catch (e) {
    await engine.close();
    if (e instanceof Refusal) return reportRefusal(a.io, e, false, a.rt);
    throw e;
  }
  return runChat(engine, session, a);
}

/** Run the REPL on an open session of `engine`; closes the engine when the REPL ends. */
/** ReplDeps.override of a --provider script: / replay: connection (its origin says which). */
export function overrideOf(conn: Connection): NonNullable<ReplDeps['override']> {
  return {
    conn: conn.id,
    plays: conn.origin.startsWith('replay:') ? 'recording' : 'script',
    windowOf: (model) => connectionWindow(conn, model),
    capsOf: (model) => connectionCaps(conn, model),
  };
}

export async function runChat(engine: EngineHandle, session: SessionHandle, a: ChatArgs): Promise<number> {
  const source: SignalSource = a.signals ?? process;
  let terminating = false;
  const onTerm = (): void => {
    if (terminating) return a.exitNow(EXIT_SIGTERM);
    terminating = true;
    a.io.err.write('\nrp-core: terminated: closing the session (the partial answer is kept)\n');
    void engine
      .close()
      .catch(() => {})
      .finally(() => a.exitNow(EXIT_SIGTERM));
  };
  source.on('SIGTERM', onTerm);
  let code: number;
  // --debug: while the REPL runs, raw provider failures go through its screen (engineOptions reads
  // rt.debug at the moment of a failure), so they never glue into a streamed answer.
  const plainDebug = a.rt.debug;
  const debugTap = plainDebug
    ? (print: (line: string) => void): (() => void) => {
        a.rt.debug = print;
        return () => {
          a.rt.debug = plainDebug;
        };
      }
    : undefined;
  try {
    code = await runRepl({
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
    });
  } catch (e) {
    source.removeListener('SIGTERM', onTerm);
    await engine.close();
    throw e;
  }
  source.removeListener('SIGTERM', onTerm);
  if (code === EXIT_SIGINT) {
    // The turn would not settle after Stop: leave without waiting; the lock stays for recovery.
    void engine.close().catch(() => {});
    return code;
  }
  await engine.close();
  return code === 0 ? EXIT.done : code;
}
