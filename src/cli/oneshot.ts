// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One-shot `rp-core send` (ARCHITECTURE.md §12.3; Kintsu K4 as the spec): open the session (lock
// and recovery), run one turn, print it, exit with a code that says how it ended. A thin client of
// the library API (§12.1): it calls exactly what --stdio (M6) and the REPL (M1b) will call.
//
// Output contract:
// - text mode: answer deltas to stdout as they arrive, a final newline; everything else to stderr;
// - --json: stdout carries only Events, one per line, through the same coalescing writer as
//   --stdio [D-36]; the session's open events (recovered, notice) come first;
// - a refusal before the turn opened prints {"type":"refusal","code","message"} to stderr.
// The default onError is 'keep' (§12.3): a failure after output keeps the partial answer.

import { Engine } from '../engine/engine.ts';
import { Refusal, type Connection, type EngineOptions, type SessionHandle, type TurnHandle, type TurnOutcome } from '../engine/api.ts';
import { createCoalescer, type Coalescer } from '../protocol/coalesce.ts';
import type { Event } from '../protocol/events.ts';
import type { TurnKind } from '../session/entries.ts';
import type { Io } from './io.ts';
import { createTextRenderer } from './render.ts';
import { installTurnSignals, type SignalSource } from './signals.ts';

/** Exit codes (§12.3; the same as Kintsu K4), plus 1 for errors and 64 (EX_USAGE) for usage. */
export const EXIT = {
  done: 0,
  error: 1,
  stopped: 2,
  failed: 3,
  conflict: 4,
  refused: 5,
  usage: 64,
} as const;

export function exitCodeOf(outcome: TurnOutcome): number {
  return EXIT[outcome.type];
}

export interface SendOptions {
  home: string;
  sessionId: string;
  kind: TurnKind;
  /** reply only. */
  text?: string;
  /** swipe only (guided re-roll). */
  guidance?: string;
  json: boolean;
  debug: boolean;
  /** --provider script:<file>: replaces every role's connection for this process. */
  provider?: Connection;
  io: Io;
  /** Leave the process at once (second SIGINT/SIGTERM). Never returns. */
  exitNow: (code: number) => void;
  /** process by default; tests pass a stand-in. */
  signals?: SignalSource;
  /** Extra engine options (tests: clock, random, checkpoint cadence). */
  engine?: Partial<EngineOptions>;
}

/** Where a turn's events go: the JSONL writer or the text renderer. */
interface Sink {
  push(ev: Event): void;
  close(): void;
}

function jsonSink(io: Io): Sink {
  const c: Coalescer = createCoalescer((ev) => io.out.write(`${JSON.stringify(ev)}\n`));
  return { push: (ev) => c.push(ev), close: () => c.close() };
}

function textSink(io: Io, debug: boolean): Sink {
  const r = createTextRenderer(io, { debug });
  return { push: (ev) => r.push(ev), close: () => r.finish() };
}

/** Hints for refusals a one-shot user can act on. */
const REFUSAL_HINT: Partial<Record<string, string>> = {
  no_connection: 'M1a has no configured connections yet: pass --provider script:<file>',
  nothing_to_reply: 'the last message is not yours: give --kind swipe or --kind continue, or send text',
  nothing_to_swipe: 'only a model answer can be swiped (a greeting cannot)',
  session_locked: 'another rp-core process has this session open',
};

/** A refusal: the machine-readable line on stderr (both modes) and, in text mode, a hint. */
export function reportRefusal(io: Io, r: Refusal, json: boolean): number {
  if (!json) {
    io.err.write(`rp-core: refused (${r.code}): ${r.message}\n`);
    const hint = REFUSAL_HINT[r.code];
    if (hint) io.err.write(`rp-core: hint: ${hint}\n`);
  }
  io.err.write(`${JSON.stringify({ type: 'refusal', code: r.code, message: r.message })}\n`);
  return EXIT.refused;
}

function startTurn(s: SessionHandle, o: SendOptions): TurnHandle {
  const expectedVersion = s.version();
  if (o.kind === 'reply') return s.submit({ text: o.text ?? '', expectedVersion, onError: 'keep' });
  return s.runTurn({
    kind: o.kind,
    expectedVersion,
    onError: 'keep',
    ...(o.guidance !== undefined ? { guidance: o.guidance } : {}),
  });
}

export async function runSend(o: SendOptions): Promise<number> {
  const engine = await Engine.open({
    ...o.engine,
    home: o.home,
    ...(o.provider ? { providerOverride: o.provider } : {}),
  });
  let session: SessionHandle | null = null;
  try {
    try {
      session = engine.session(o.sessionId);
    } catch (e) {
      if (e instanceof Refusal) return reportRefusal(o.io, e, o.json);
      throw e;
    }
    const sink = o.json ? jsonSink(o.io) : textSink(o.io, o.debug);
    // Recovery happened while opening; its events precede anything this turn says.
    for (const ev of session.openEvents()) sink.push(ev);

    let turn: TurnHandle;
    try {
      turn = startTurn(session, o);
    } catch (e) {
      sink.close();
      if (e instanceof Refusal) return reportRefusal(o.io, e, o.json);
      throw e;
    }

    const open = session;
    const signals = installTurnSignals(
      {
        stop: () => turn.stop(),
        // close() stops the turn with its partial text kept and releases the lock once it settles.
        shutdown: () => void open.close(),
        exitNow: o.exitNow,
        // A log line, so stderr in both modes; in text mode it starts on a fresh line after "^C".
        note: (msg) => o.io.err.write(`${o.json ? '' : '\n'}rp-core: ${msg}\n`),
      },
      o.signals,
    );
    let outcome: TurnOutcome;
    try {
      for await (const ev of turn.events) sink.push(ev);
      outcome = await turn.result;
    } finally {
      signals.dispose();
      sink.close();
    }
    return signals.exitOverride() ?? exitCodeOf(outcome);
  } finally {
    // Idempotent: a SIGTERM may already have closed the session.
    if (session) await session.close();
    await engine.close();
  }
}
