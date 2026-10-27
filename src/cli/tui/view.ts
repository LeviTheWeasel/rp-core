// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's output port (TUI decisions T-3, T-5, T-7, T-8): the Repl's ReplView over the chat
// transcript and the two side panes. The Repl's own strings (lines, echoes, status lines) keep
// their SGR styles; the transcript turns them into styled text. A session shows its whole active
// path when it opens (and after /open, /fork); the greeting's where-you-are messages are then
// already on screen and are not repeated. The panes are refreshed on banner() and idle(). An
// answer's status line carries no REPL hints (`/r swipe /c continue /e edit`: the hotkeys do that)
// and says the finish / edited / hidden markers the card then leaves out (T-15). The speaker labels
// are the REPL's, sanitised and measured in terminal columns (T-16). Under the Repl's /help the TUI
// adds its note, and the key rows themselves when the left pane does not show them (T-17).

import { directorAt } from '../../agents/director/state.ts';
import type { MessageView } from '../../session/view.ts';
import type { Trace } from '../../session/entries.ts';
import type { PriceTable } from '../repl-journal.ts';
import { helpText } from '../repl-commands.ts';
import { prefix, statusItems, type Style } from '../repl-render.ts';
import type { BannerInfo, ReplView, ReplViewContext, TurnOptions, TurnView } from '../repl-view.ts';
import type { AgentsPaneApi, ModelsPaneApi, Names, TranscriptApi } from './types.ts';
import type { Event } from '../../protocol/events.ts';
import { displayLabels } from './sanitize.ts';
import { tuiHelpLines } from './keys.ts';

export interface TuiViewDeps {
  ctx: ReplViewContext;
  transcript: TranscriptApi;
  models: ModelsPaneApi;
  agents: AgentsPaneApi;
  /** config.toml's prices (the agents pane's usage totals). */
  prices: PriceTable;
  /** The left pane's live facts: the newline key the terminal supports, whether the mouse is on. */
  extra(): { newlineKey: string; mouse: boolean };
  /** The status row under the transcript. */
  status(text: string, tone?: 'dim' | 'yellow' | 'red' | 'plain'): void;
  /** The file log (a pane that throws must not end the chat). */
  log(text: string): void;
  /** False once the renderer is destroyed: output then goes to the log only. Default: always live. */
  live?(): boolean;
  /** TERM_PROGRAM=WarpTerminal (the transcript's flag): the speaker labels are measured as Warp shows them. */
  warp?: boolean;
  /**
   * Whether the left pane (the key list) is on screen now: when it is not (below 120 columns, or
   * hidden by F2), /help lists the keys itself (T-17). Default: shown.
   */
  keysShown?(): boolean;
}

/**
 * An answer's status line in the TUI (T-15): the REPL's statusLine() without its hints. A greeting's
 * items also say the markers its card leaves out (statusItems() gives a greeting only its position).
 */
export function answerStatus(m: MessageView, style: Style, trace?: Pick<Trace, 'prefill'>): string {
  const items = statusItems(m, trace);
  if (m.gen?.kind === 'greeting') {
    if (m.gen.finish && m.gen.finish !== 'end') items.push(m.gen.finish);
    if (m.edited) items.push('edited');
    if (m.hidden) items.push('hidden');
  }
  return style.dim(`  [${items.join(' · ')}]`);
}

const READY = 'ready · Enter sends · F1 help';
/** The Repl's /help as it says it (plain text); the TUI adds its own rows under it (helpRows). */
const HELP = helpText();
const ANSWERING = 'answering… · Ctrl+C stops · typing is held until the answer ends';

export class TuiView implements ReplView {
  private names: Names = { char: '', user: 'you', width: 3 };
  private readonly style: Style;
  private session: string | null = null;
  /** Ids shown by showPath until the greeting is over: where-you-are repeats them. */
  private greeting: Set<string> | null = null;
  private turns = 0;
  /** /think: the Repl's live state once a turn handed it over; before that the session's stored setting. */
  private reasoningLive: (() => boolean) | null = null;
  private reasoningStored = false;
  /** What the Repl said for the line it works on (since the last echo): a session switch shows it again. */
  private said: string[] = [];

  constructor(private readonly d: TuiViewDeps) {
    this.style = d.ctx.style;
  }

  /** The session shown now (null before the first banner). */
  get sessionId(): string | null {
    return this.session;
  }

  /** Whether finished cards show reasoning (/think show) or fold it. */
  reasoningShown(): boolean {
    return this.reasoningLive?.() ?? this.reasoningStored;
  }

  /** A turn streams (its events reach the agents pane through the turn view). */
  get turning(): boolean {
    return this.turns > 0;
  }

  /**
   * What the Repl said (line()) since the player's last line or the last idle(): when the Repl ends,
   * the reason it ends (an error, the exit summary) is here for the host to print after the terminal
   * is restored (T-14).
   */
  get lastSaid(): readonly string[] {
    return this.said;
  }

  line(text: string): void {
    if (!this.live(text)) return;
    this.said.push(text);
    this.guard('line', () => {
      this.d.transcript.system(text);
      if (text === HELP) for (const row of this.helpRows()) this.d.transcript.system(this.style.dim(row));
    });
  }

  /**
   * What the TUI says under the Repl's /help (T-9, T-17): /e edits in the input box; the keys are on
   * the left, or, when the left pane is not on screen, listed here row by row (keys.ts tuiHelpLines).
   */
  helpRows(): string[] {
    const { newlineKey, mouse } = this.d.extra();
    return tuiHelpLines({ newlineKey, mouse }, this.d.keysShown?.() ?? true);
  }

  echo(line: string): void {
    this.greeting = null;
    this.said = [];
    const sgr = `${prefix(this.names.user, this.style)}${line}`;
    if (this.live(sgr)) this.guard('echo', () => this.d.transcript.echo(sgr));
  }

  message(m: MessageView, withStatus: boolean): void {
    if (this.greeting?.has(m.id)) return;
    if (!this.live(`message ${m.id}`)) return;
    this.guard('message', () => {
      this.d.transcript.card(m, this.names);
      if (withStatus && m.role === 'assistant') this.d.transcript.status(answerStatus(m, this.style));
    });
  }

  banner(b: BannerInfo): void {
    const name = b.header?.cast?.character?.name;
    this.names = typeof name === 'string' ? displayLabels(name, { warp: this.d.warp ?? false }) : b.names;
    this.reasoningStored = b.config.reasoningShown;
    if (!this.live(`banner ${b.session.id}`)) return;
    this.guard('banner', () => {
      if (b.session.id !== this.session) {
        this.session = b.session.id;
        const path = b.session.view().path;
        this.d.transcript.showPath(path, this.names, (m) => this.statusOf(m));
        // showPath cleared the screen: what the Repl said before switching (`forked into …`) stays.
        for (const text of this.said) this.d.transcript.system(text);
        this.greeting = new Set(path.map((m) => m.id));
        this.d.agents.reset(b.session.id);
      }
      this.updateModels(b);
    });
  }

  turn(o: TurnOptions): TurnView {
    this.greeting = null;
    this.reasoningLive = o.showReasoning;
    this.d.status(ANSWERING);
    const tv = this.d.transcript.turn({
      ...o,
      label: this.names.char,
      names: this.names,
      onEvent: (ev: Event) => this.guard('agents', () => this.d.agents.event(ev)),
    });
    this.turns++;
    let open = true;
    return {
      push: (ev) => {
        // The turn view draws these rows itself (not through line()): the log gets them here (T-14).
        if (ev.type === 'failed') this.logQuietly(`the answer failed (${ev.category}/${ev.code}): ${ev.message}`);
        else if (ev.type === 'conflict') this.logQuietly('the session changed during the turn; the answer was not committed');
        this.guard('turn', () => tv.push(ev));
      },
      finish: () => {
        if (open) this.turns--;
        open = false;
        this.guard('turn', () => tv.finish());
      },
      interject: () => this.guard('turn', () => tv.interject()),
      get kept() {
        return tv.kept;
      },
    };
  }

  status(m: MessageView, trace?: Trace): void {
    const sgr = answerStatus(m, this.style, trace);
    if (this.live(sgr)) this.guard('status', () => this.d.transcript.status(sgr));
  }

  /** The queue is empty: re-read the banner's facts (configure() publishes no event) into the panes. */
  idle(): void {
    this.greeting = null;
    this.said = [];
    if (!this.live('idle')) return;
    this.refresh();
    this.guard('status', () => this.d.status(READY));
  }

  /** Re-read the panes now (idle, F3). Never throws. */
  refresh(): void {
    this.guard('refresh', () => {
      const b = this.d.ctx.bannerInfo();
      this.reasoningStored = b.config.reasoningShown;
      this.updateModels(b);
      this.d.agents.refresh(b.journal, b.session.view().head, b.config, this.d.prices);
    });
  }

  private updateModels(b: BannerInfo): void {
    const record = directorAt(b.journal.tree, b.session.view().head).record;
    this.d.models.update(b, { ...this.d.extra(), ...(record ? { record } : {}) });
  }

  private statusOf(m: MessageView): string | null {
    return m.role === 'assistant' ? answerStatus(m, this.style) : null;
  }

  private logQuietly(text: string): void {
    try {
      this.d.log(text);
    } catch {
      /* the log is gone: the row is still on screen */
    }
  }

  private live(what: string): boolean {
    if (this.d.live?.() ?? true) return true;
    this.d.log(`(after the renderer) ${what}`);
    return false;
  }

  /** A pane or the transcript that throws is logged and shown on the status row, never fatal. */
  private guard(where: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.d.log(`${where}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      try {
        this.d.status(`error in ${where}: ${e instanceof Error ? e.message : String(e)} (see logs/tui.log)`, 'red');
      } catch {
        /* the status row itself is gone */
      }
    }
  }
}
