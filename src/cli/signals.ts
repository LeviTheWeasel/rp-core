// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Signals during a one-shot turn (ARCHITECTURE.md §12.2 "Завершение", §19.2 cli/signals.ts):
// - the first SIGINT stops the turn; the partial text is committed as 'stopped' (exit 2);
// - a second SIGINT leaves at once (exit 130); the lock stays behind and the next open recovers
//   the turn exactly as after a crash;
// - SIGTERM closes the session (partial text kept), then the run exits 143; a second SIGTERM
//   leaves at once.
// Handlers live only here, never in the library, and only while a turn runs. Bunraku's
// `hookExit` (exit on the first SIGINT) is the anti-pattern this replaces (§19.2 "Не переносить").

export type CliSignal = 'SIGINT' | 'SIGTERM';

/** Exit codes a signal imposes: 128 + the signal number, as shells report them. */
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

/** What a signal can ask of the run. */
export interface TurnSignalActions {
  /** First SIGINT: stop the running turn, keeping what arrived. */
  stop(): void;
  /** SIGTERM: close the session (the turn stops with its partial text kept). */
  shutdown(): void;
  /** Leave now with this code (a second signal). Must not return. */
  exitNow(code: number): void;
  /** Tell the user what happened (stderr). */
  note?(message: string): void;
}

/** The process, or a stand-in in tests. */
export interface SignalSource {
  on(signal: CliSignal, listener: () => void): unknown;
  removeListener(signal: CliSignal, listener: () => void): unknown;
}

export interface TurnSignals {
  /** The exit code SIGTERM imposes on the run once the turn settles (null: none). */
  exitOverride(): number | null;
  /** Remove the handlers (the turn is over). Idempotent. */
  dispose(): void;
}

export function installTurnSignals(actions: TurnSignalActions, source: SignalSource = process): TurnSignals {
  let interrupted = false;
  let terminated = false;
  let disposed = false;

  const onInt = (): void => {
    // Once a stop or a shutdown is under way, another interrupt means "I am not waiting".
    if (interrupted || terminated) return actions.exitNow(EXIT_SIGINT);
    interrupted = true;
    actions.note?.('stopping the turn; press Ctrl+C again to quit at once');
    actions.stop();
  };
  const onTerm = (): void => {
    if (terminated) return actions.exitNow(EXIT_SIGTERM);
    terminated = true;
    actions.shutdown();
  };

  source.on('SIGINT', onInt);
  source.on('SIGTERM', onTerm);
  return {
    exitOverride: () => (terminated ? EXIT_SIGTERM : null),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      source.removeListener('SIGINT', onInt);
      source.removeListener('SIGTERM', onTerm);
    },
  };
}
