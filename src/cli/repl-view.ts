// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The REPL's output port (TUI decisions T-3; the refactor of the REPL into two ports). Everything the
// Repl shows goes through a ReplView. The line REPL's view, LineView, writes to a Screen exactly as the
// Repl did before the port existed: the same calls in the same order, so the same bytes. A full-screen
// host (the TUI) gives its own view: a transcript of cards, a live card per turn, side panes it
// refreshes on idle().
//
// What crosses the port: structure where a host needs it (a message, a turn's events, the banner's
// facts), and the Repl's own styled strings everywhere else. line() carries every report of the
// Repl's say() sites, styled with the closed SGR set of repl-render.ts (SGR) when colour is on.
//
// The Repl calls a view in this order: banner() first (and again after /open and /fork switch the
// session), then lines, echoes, messages and turns as the input is processed, and idle() each time
// the queue is empty and it waits for input. Before every output call made while a turn streams, the
// Repl calls the turn's interject() itself; a view never has to.

import type { SessionHandle } from '../engine/api.ts';
import type { Event, Notice } from '../protocol/events.ts';
import type { ModelCaps } from '../providers/types.ts';
import type { Binding, SessionConfig, SessionHeader, Trace } from '../session/entries.ts';
import type { MessageView } from '../session/view.ts';
import type { ReplDeps } from './repl.ts';
import type { Journal } from './repl-journal.ts';
import { bannerLine, formatMessage, labels, prefix, Screen, statusLine, TurnPrinter, type Style } from './repl-render.ts';

/** One turn as a view renders it (the line REPL's is repl-render.ts TurnPrinter). */
export interface TurnView {
  /**
   * Every event of the turn, redacted (ReplDeps.redact), in order from `start` to the terminal event
   * (done / stopped / failed / conflict): text and reasoning deltas, prefill, usage, tool, director,
   * agent, memory, retry, notice, changed. The line view ignores what it does not print.
   */
  push(ev: Event): void;
  /** The event stream ended (also after an error): close whatever is open. */
  finish(): void;
  /** The Repl is about to show something of its own mid-turn (a held line, a refusal): close the streamed line. */
  interject(): void;
  /**
   * A msg or edit was committed during the turn (a `changed` event with change 'msg' or 'edit'). After
   * a failed turn the Repl shows the kept partial answer's status only when this is true.
   */
  readonly kept: boolean;
}

/** What view.turn() is told about a turn. */
export interface TurnOptions {
  /** The character's padded speaker label (BannerInfo.names.char). */
  label: string;
  /** Read when a reasoning segment starts: true shows it, false folds it to one line (/think). */
  showReasoning: () => boolean;
  /** Show a notice event. The Repl dedupes by code per session and says it through line(). */
  notice: (n: Notice) => void;
  /** /c: the answer's text before this turn (the line view shows the addition after its last words). */
  continueFrom?: string;
}

/**
 * The banner's facts: what the Repl's greeting line says, and what a host's side pane shows. A fresh
 * read each time (the journal, the preset); computing it changes nothing.
 */
export interface BannerInfo {
  /** The session open now. It changes on /open and /fork; banner() is that moment. */
  session: SessionHandle;
  header: SessionHeader;
  /** The speaker labels, padded to one width: `char` the character's, `user` "you". */
  names: { char: string; user: string; width: number };
  /** The session's config now (header plus every config patch): what the next turn reads. */
  config: SessionConfig;
  /** The journal this was computed from (read-only; reuse it for directorAt, pathUsage, latestTrace). */
  journal: Journal;
  /** The narrator's binding as configured (config.roles.narrator), even when --provider plays every turn. */
  narrator: Binding;
  /**
   * The narrator's context window: the last answer's trace, else the model's caps, bounded by the
   * session's and the preset's limits; null when unknown.
   */
  window: number | null;
  /** The session's or the preset's own window limit, when either sets one (the banner's `ctx ≤N`). */
  cap?: number;
  /** The narrator route's caps.tools (toolsWord() words it), or null when its caps are unknown. */
  tools: ModelCaps['tools'] | null;
  /** The Director while it is enabled: its binding (`follows`: the narrator's) and the configured profile. */
  director: { conn: string; model: string; follows: boolean; profile: SessionConfig['director']['profile'] } | null;
  /** The --provider script: / replay: connection every turn runs on, when the chat has one. */
  override?: NonNullable<ReplDeps['override']>;
}

/** The line terminal's cursor bookkeeping (repl-render.ts Screen). Only a line view has one. */
export interface LineCursor {
  /** Start a new line unless already at one. */
  newline(): void;
  write(s: string): void;
  /** Something outside the view (readline echoing an Enter) moved the cursor to a fresh line. */
  markLineStart(): void;
}

/** The Repl's output port. */
export interface ReplView {
  /** A report line (or several, joined by \n), already styled: every say() of the Repl. */
  line(text: string): void;
  /** The player's line (trimmed), shown when the input does not echo it or it was typed mid-turn. */
  echo(line: string): void;
  /**
   * A whole message (a greeting, the head after /[ /] /goto /rewind, the edited one after /e). With
   * `withStatus`, an assistant message is followed by its status line (no trace: no prefill flag).
   */
  message(m: MessageView, withStatus: boolean): void;
  /** The session was opened or switched: the banner. The speaker labels for echo() and message() come from it. */
  banner(b: BannerInfo): void;
  /** A turn starts streaming: its events go to the returned view. */
  turn(o: TurnOptions): TurnView;
  /** The status line after a turn's answer (`trace`: that answer's newest trace, when it has one). */
  status(m: MessageView, trace?: Trace): void;
  /**
   * The queue is empty and the Repl waits for input: the moment to refresh what configure() changed
   * (it publishes no event): ReplViewContext.bannerInfo(). Must not throw.
   */
  idle?(): void;
  /** Present only on a line terminal: the prompt and Ctrl+C keep the cursor right through it. */
  readonly cursor?: LineCursor;
}

/** What ReplOptions.view is given to build a view. */
export interface ReplViewContext {
  /** The Repl's styles (ReplDeps.color): the strings it hands the view carry these. */
  style: Style;
  /**
   * The banner's facts as they are now, for the current session. It reads the journal from disk: call
   * it on idle() or banner(), not per frame. Usable once the view exists (not inside the factory).
   */
  bannerInfo(): BannerInfo;
}

/** The line REPL's view: a Screen over `sink` (io.out), byte for byte what the Repl printed itself. */
export class LineView implements ReplView {
  private readonly screen: Screen;
  private names = labels('');
  readonly cursor: LineCursor;

  constructor(
    sink: (s: string) => void,
    private readonly style: Style,
  ) {
    this.screen = new Screen(sink);
    this.cursor = this.screen;
  }

  line(text: string): void {
    this.screen.line(text);
  }

  echo(line: string): void {
    this.screen.line(`${prefix(this.names.user, this.style)}${line}`);
  }

  message(m: MessageView, withStatus: boolean): void {
    this.screen.line(formatMessage(m, this.names, this.style));
    if (withStatus && m.role === 'assistant') this.screen.line(statusLine(m, this.style));
  }

  banner(b: BannerInfo): void {
    this.names = b.names;
    this.screen.line(bannerLine(b.header, b.narrator, b.window, this.style, b.cap, b.tools, b.director));
  }

  turn(o: TurnOptions): TurnView {
    return new TurnPrinter({ screen: this.screen, style: this.style, ...o });
  }

  status(m: MessageView, trace?: Trace): void {
    this.screen.line(statusLine(m, this.style, trace));
  }
}
