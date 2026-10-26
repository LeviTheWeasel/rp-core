// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// REPL output (ARCHITECTURE.md §12.4 "Вывод", §19.2 cli/render.ts M1b): the streamed answer after a
// "Name › " prefix with *actions* in italics and "dialogue" plain, reasoning dimmed and folded to one
// line unless /think show, one dim line per tool/agent event, one yellow line per notice, a dim
// status line after every answer, and the text of every command's report. ANSI only with colour;
// without it the output is plain text (what tests and pipes see). Pure string building plus two
// small state machines (the prose styler and the turn printer); nothing here touches a session.

import type { Event } from '../protocol/events.ts';
import type { RefusalCode } from '../engine/api.ts';
import type { Generation, Roles, SessionConfig, SessionHeader, Trace } from '../session/entries.ts';
import type { MessageView, PathView } from '../session/view.ts';
import { markers, messageText } from './render.ts';
import type { TailRow, UsageSummary } from './repl-journal.ts';

// ---- styles ----------------------------------------------------------------------------------------

const ESC = '\x1b[';
export const SGR = {
  italicOn: `${ESC}3m`,
  italicOff: `${ESC}23m`,
  dimOn: `${ESC}2m`,
  boldOn: `${ESC}1m`,
  /** Ends both bold and dim. */
  intensityOff: `${ESC}22m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  fgOff: `${ESC}39m`,
} as const;

export interface Style {
  readonly color: boolean;
  dim(s: string): string;
  bold(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
}

export function makeStyle(color: boolean): Style {
  const wrap = (on: string, off: string) => (s: string) => (color && s !== '' ? `${on}${s}${off}` : s);
  return {
    color,
    dim: wrap(SGR.dimOn, SGR.intensityOff),
    bold: wrap(SGR.boldOn, SGR.intensityOff),
    yellow: wrap(SGR.yellow, SGR.fgOff),
    red: wrap(SGR.red, SGR.fgOff),
  };
}

/** Text without SGR sequences (what a reader sees). */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---- prose: *actions* in italics, "dialogue" plain ---------------------------------------------------

export interface ProseStyler {
  /** Style one streamed delta; state (inside *…*, inside quotes) carries over to the next one. */
  push(delta: string): string;
  /** Close any open style at the end of the answer (or before a side line interrupts it). */
  end(): string;
}

const OPEN_QUOTES = new Set(['“', '«']);
const CLOSE_QUOTES = new Set(['”', '»']);

/**
 * Roleplay convention: *asterisks* mark actions, quotes mark speech. An action is italic; speech
 * inside an action is plain again. A newline closes both, so one stray asterisk cannot italicise
 * the rest of the answer. The asterisks stay visible. Without colour this is the identity.
 */
export function createProseStyler(color: boolean): ProseStyler {
  let star = false;
  let quote = false;
  return {
    push(delta: string): string {
      if (!color) return delta;
      let out = '';
      for (const ch of delta) {
        if (ch === '*') {
          if (quote) {
            star = !star; // invisible until the quote closes
            out += ch;
          } else if (!star) {
            star = true;
            out += SGR.italicOn + ch;
          } else {
            star = false;
            out += ch + SGR.italicOff;
          }
        } else if ((ch === '"' && !quote) || OPEN_QUOTES.has(ch)) {
          if (star && !quote) out += SGR.italicOff;
          quote = true;
          out += ch;
        } else if ((ch === '"' && quote) || CLOSE_QUOTES.has(ch)) {
          out += ch;
          if (quote && star) out += SGR.italicOn;
          quote = false;
        } else if (ch === '\n') {
          if (star && !quote) out += SGR.italicOff;
          star = false;
          quote = false;
          out += ch;
        } else {
          out += ch;
        }
      }
      return out;
    },
    end(): string {
      const open = color && star && !quote;
      star = false;
      quote = false;
      return open ? SGR.italicOff : '';
    },
  };
}

// ---- screen: line-aware writer ---------------------------------------------------------------------------

/** A writer that knows whether the cursor is at the start of a line, so side lines never glue onto text. */
export class Screen {
  private atLineStart = true;
  constructor(private readonly sink: (s: string) => void) {}

  write(s: string): void {
    if (s === '') return;
    this.sink(s);
    const visible = stripAnsi(s);
    if (visible !== '') this.atLineStart = visible.endsWith('\n');
  }

  /** Start a new line unless already at one. */
  newline(): void {
    if (!this.atLineStart) this.write('\n');
  }

  /** `s` on a line of its own (each line of a multi-line string). */
  line(s = ''): void {
    this.newline();
    this.write(`${s}\n`);
  }

  /** Something outside this writer (readline echoing an Enter) moved the cursor to a fresh line. */
  markLineStart(): void {
    this.atLineStart = true;
  }

  get fresh(): boolean {
    return this.atLineStart;
  }
}

// ---- labels, messages, status -----------------------------------------------------------------------------

export const USER_LABEL = 'you';

/** The speaker labels, padded to one width so the arrows line up: "Mira › " / "you  › ". */
export function labels(charName: string): { char: string; user: string; width: number } {
  const name = charName.trim() === '' ? 'them' : charName.trim();
  const width = Math.min(Math.max(name.length, USER_LABEL.length), 16);
  const cut = name.length > width ? `${name.slice(0, width - 1)}…` : name;
  return { char: cut.padEnd(width), user: USER_LABEL.padEnd(width), width };
}

export function prefix(label: string, style: Style): string {
  return `${style.bold(label)} › `;
}

/** Status items of a message: "swipe 2/3", tokens, seconds, finish ("greeting 1/2" for a greeting). */
export function statusItems(m: MessageView): string[] {
  if (m.gen?.kind === 'greeting') return [`greeting ${m.swipe.index + 1}/${m.swipe.count}`];
  const items = [`swipe ${m.swipe.index + 1}/${m.swipe.count}`];
  const g = m.gen;
  const out = g?.usage?.outputTotal;
  if (typeof out === 'number') items.push(`${out} tok`);
  if (typeof g?.ms === 'number') items.push(`${(g.ms / 1000).toFixed(1)}s`);
  if (g?.finish) items.push(g.finish);
  if (m.edited) items.push('edited');
  if (m.hidden) items.push('hidden');
  return items;
}

/** The dim line after an answer: "[swipe 1/1 · 386 tok · 7.9s · end]   /r swipe  /c continue  /e edit". */
export function statusLine(m: MessageView, style: Style): string {
  const hints = m.gen?.kind === 'greeting' ? (m.swipe.count > 1 ? '/r next greeting  /[ /] browse' : '') : '/r swipe  /c continue  /e edit';
  return style.dim(`  [${statusItems(m).join(' · ')}]${hints ? `   ${hints}` : ''}`);
}

/** A whole message as the story shows it: "Mira › *text*" (user messages under the user label). */
export function formatMessage(m: MessageView, names: { char: string; user: string }, style: Style): string {
  const label = m.role === 'user' ? names.user : names.char;
  const styler = createProseStyler(style.color);
  const text = messageText(m);
  const body = text.trim() === '' ? style.dim('(no text)') : styler.push(text) + styler.end();
  return `${prefix(label, style)}${body}`;
}

// ---- side lines -------------------------------------------------------------------------------------------

const brief = (v: unknown, max = 40): string => {
  if (v === undefined) return '';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The one dim line a tool, agent, director, memory or retry event deserves (null: nothing to say). */
export function sideLine(ev: Event): string | null {
  switch (ev.type) {
    case 'tool': {
      if (ev.phase !== 'done') return null;
      const args = brief(ev.args);
      const result = ev.summary ?? (ev.ok === false ? 'failed' : 'ok');
      return `⋯ ${ev.name}${args ? ` ${args}` : ''} → ${result}`;
    }
    case 'director':
      if (ev.status === 'planning') return null;
      return `⋯ director: ${ev.status}${ev.summary ? ` — ${brief(ev.summary, 60)}` : ev.reason ? ` (${ev.reason})` : ''}`;
    case 'agent': {
      if (ev.status === 'queued' || ev.status === 'started') return null;
      const n = ev.count !== undefined ? ` (${ev.count})` : '';
      return `⋯ ${ev.agent}: ${ev.status}${n}${ev.code ? ` [${ev.code}]` : ''}`;
    }
    case 'memory':
      return `⋯ memory: ${ev.change} ${ev.kind} "${ev.name}"`;
    case 'retry':
      return `⋯ retrying in ${(ev.delayMs / 1000).toFixed(1)} s (${ev.code}${ev.status !== undefined ? `, HTTP ${ev.status}` : ''})`;
    default:
      return null;
  }
}

/** A notice as one line (the caller prints it yellow, once per code per session). */
export function noticeText(n: { level: string; code: string; message: string }): string {
  return `! ${n.message} (${n.code})`;
}

// ---- the turn printer ---------------------------------------------------------------------------------------

export interface TurnPrinterOptions {
  screen: Screen;
  style: Style;
  /** The character's padded label. */
  label: string;
  /** Read when a reasoning segment starts: true shows it dimmed, false folds it to one line. */
  showReasoning: () => boolean;
  /** Print a notice (the REPL dedupes by code per session). */
  notice: (n: { level: 'info' | 'warn'; code: string; message: string }) => void;
  /** Continue: the answer's text before the turn, so the addition is shown after its last words. */
  continueFrom?: string;
}

/**
 * Renders one turn's events as they arrive. The caller prints the status line after the outcome
 * (it needs the committed message, which `kept` and the terminal event tell it how to find).
 */
export class TurnPrinter {
  private readonly prose: ProseStyler;
  private textOpen = false;
  private prefixed = false;
  private streamed = false;
  private reasoning: { show: boolean; chars: number } | null = null;
  /** A msg/edit was committed during the turn (a failure with onError 'keep' still saved the answer). */
  kept = false;

  constructor(private readonly o: TurnPrinterOptions) {
    this.prose = createProseStyler(o.style.color);
  }

  push(ev: Event): void {
    const { screen, style } = this.o;
    switch (ev.type) {
      case 'reasoning':
        if (ev.delta === '') return;
        if (!this.reasoning) {
          this.closeText();
          const show = this.o.showReasoning();
          this.reasoning = { show, chars: 0 };
          screen.newline();
          screen.write(style.dim(show ? '  ⋯ ' : '  ⋯ thinking'));
        }
        this.reasoning.chars += ev.delta.length;
        if (this.reasoning.show) screen.write(style.dim(ev.delta.replace(/\n/g, '\n    ')));
        return;
      case 'text':
        if (ev.delta === '') return;
        this.endReasoning();
        this.openText();
        screen.write(this.prose.push(ev.delta));
        this.streamed = true;
        return;
      case 'changed':
        if (ev.change === 'msg' || ev.change === 'edit') this.kept = true;
        return;
      case 'notice':
        this.endReasoning();
        this.closeText();
        this.o.notice({ level: ev.level, code: ev.code, message: ev.message });
        return;
      case 'done':
        this.endReasoning();
        // Nothing streamed (a hook replaced the text, or it came in one piece): show the answer itself.
        if (!this.streamed) {
          this.openText();
          screen.write(this.prose.push(messageText(ev.message)));
        }
        this.closeText();
        return;
      case 'stopped':
        this.endReasoning();
        this.closeText();
        screen.line(style.dim(ev.message ? '[stopped]' : '[stopped] nothing had arrived; nothing was kept'));
        return;
      case 'failed':
        this.endReasoning();
        this.closeText();
        screen.line(style.red(`✗ the answer failed (${ev.category}/${ev.code}): ${ev.message}`));
        if (this.kept) screen.line(style.dim('  the partial answer was kept, marked [interrupted]'));
        return;
      case 'conflict':
        this.endReasoning();
        this.closeText();
        screen.line(style.yellow('! the session changed during the turn; the answer was not committed'));
        return;
      default: {
        const side = sideLine(ev);
        if (side === null) return;
        this.endReasoning();
        this.closeText();
        screen.line(style.dim(`  ${side}`));
      }
    }
  }

  /** After the event stream ends: leave the cursor on a fresh line with every style closed. */
  finish(): void {
    this.endReasoning();
    this.closeText();
  }

  /**
   * The REPL is about to print a line of its own mid-turn (a held line, a refusal): close what is
   * open so that line stands alone; streamed text then resumes indented under the prefix.
   */
  interject(): void {
    this.endReasoning();
    this.closeText();
  }

  private openText(): void {
    if (this.textOpen) return;
    const { screen, style, label } = this.o;
    screen.newline();
    if (!this.prefixed) {
      screen.write(prefix(label, style));
      const before = this.o.continueFrom;
      if (before !== undefined && before.trim() !== '') screen.write(style.dim(`…${lastWords(before)}`));
      this.prefixed = true;
    } else {
      // Text resumes after a side line: indent under the prefix instead of repeating the name.
      screen.write(' '.repeat(label.length + 3));
    }
    this.textOpen = true;
  }

  private closeText(): void {
    if (!this.textOpen) return;
    this.o.screen.write(this.prose.end());
    this.o.screen.newline();
    this.textOpen = false;
  }

  private endReasoning(): void {
    const r = this.reasoning;
    if (!r) return;
    this.reasoning = null;
    const { screen, style } = this.o;
    if (r.show) screen.newline();
    else screen.write(style.dim(` (${r.chars} chars)\n`));
  }
}

/** The last few words of a text, one line (where a continue picks up). */
export function lastWords(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trimEnd();
  if (flat.length <= max) return flat;
  const cut = flat.slice(flat.length - max);
  const space = cut.indexOf(' ');
  return space >= 0 && space < max / 2 ? cut.slice(space) : cut;
}

// ---- command reports ------------------------------------------------------------------------------------

/** The banner line: "session s_4fa2 · Mira · narrator local:qwen3-14b (tools: off) · ctx 16384". */
export function bannerLine(
  header: Pick<SessionHeader, 'id' | 'title'>,
  narrator: { conn: string; model: string },
  window: number | null,
  style: Style,
): string {
  const title = header.title ?? '(untitled)';
  return style.bold(`session ${header.id} · ${title} · narrator ${narrator.conn}:${narrator.model} (tools: off) · ctx ${window ?? '?'}`);
}

/** /show: the active path, numbered from 1 (the numbers /e, /hide, /rewind and /fork take). */
export function renderNumberedPath(view: PathView, header: Pick<SessionHeader, 'id' | 'title'>, names: { char: string; user: string }, style: Style): string {
  const lines: string[] = [style.bold(`${header.title ?? '(untitled)'} · ${header.id} · version ${view.version}`)];
  if (view.path.length === 0) lines.push('(no messages yet)');
  const width = String(view.path.length).length;
  view.path.forEach((m, i) => {
    const who = (m.role === 'user' ? names.user : names.char).trim();
    const place =
      m.gen?.kind === 'greeting'
        ? `greeting ${m.swipe.index + 1}/${m.swipe.count}`
        : m.role === 'assistant' || m.swipe.count > 1
          ? `swipe ${m.swipe.index + 1}/${m.swipe.count}`
          : '';
    const head = [`${String(i + 1).padStart(width)}. ${who}`, m.id, place, ...markers(m).filter((x) => x !== '[reasoning]')].filter(Boolean).join(' · ');
    lines.push(m.hidden ? style.dim(head) : head);
    const text = messageText(m);
    const body = text.trim() === '' ? '(no text)' : text;
    const pad = ' '.repeat(width + 2);
    const indented = body
      .split('\n')
      .map((l) => (l === '' ? '' : pad + l))
      .join('\n');
    lines.push(m.hidden ? style.dim(indented) : indented);
  });
  const n = view.tails.length;
  if (n > 0) lines.push(style.dim(`(${n} other branch${n === 1 ? '' : 'es'} off this path: /tails)`));
  return lines.join('\n');
}

/** /tails: one row per branch off the active path. */
export function renderTails(rows: readonly TailRow[], names: { char: string; user: string }): string {
  if (rows.length === 0) return 'no other branches: every message is on this path';
  const lines = [`${rows.length} branch${rows.length === 1 ? '' : 'es'} off this path (/goto <id> switches):`];
  for (const r of rows) {
    const who = (r.role === 'user' ? names.user : names.char).trim();
    lines.push(`  ${r.id}  #${r.depth} ${who}: ${r.words === '' ? '(no text)' : `"${r.words}"`}`);
  }
  return lines.join('\n');
}

const bindingText = (b: Roles[keyof Roles]): string =>
  b === undefined ? 'narrator (follows)' : typeof b === 'string' ? `${b} (follows)` : `${b.conn}:${b.model}${b.fallback ? ` (fallback ${b.fallback.conn}:${b.fallback.model})` : ''}`;

/** /model: the role bindings (one role, or all four). */
export function renderBindings(roles: Roles, only?: keyof Roles): string {
  const keys: (keyof Roles)[] = only ? [only] : ['narrator', 'director', 'recorder', 'recall'];
  return keys.map((k) => `  ${k.padEnd(8)} ${bindingText(roles[k])}`).join('\n');
}

/** /note with no argument. */
export function renderNote(config: Pick<SessionConfig, 'authorNote'>): string {
  const n = config.authorNote;
  if (!n || n.text.trim() === '') return "no author's note (/note <text> [@depth] sets one)";
  return `author's note @${n.depth} (${n.role}): ${n.text}`;
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/** /usage. */
export function renderUsage(u: UsageSummary): string {
  if (u.calls === 0) return 'no model answers on this path yet';
  const parts = [`${u.calls} generation${u.calls === 1 ? '' : 's'} on this path`];
  const reported = u.calls - u.noUsage;
  if (reported > 0) parts.push(`in ${u.inputTokens} tok`, `out ${u.outputTokens} tok`);
  parts.push(u.costUsd === null ? 'cost unknown' : `cost ${formatUsd(u.costUsd)}`);
  const notes: string[] = [];
  if (u.noUsage > 0) notes.push(`${u.noUsage} without usage from the server`);
  if (u.unpriced > 0) notes.push(`${u.unpriced} without a price ([prices."conn:model"] in config.toml)`);
  return parts.join(' · ') + (notes.length > 0 ? `\n  (${notes.join('; ')})` : '');
}

/** /trace: a summary of the newest trace of the last answer. */
export function renderTrace(id: string, t: { trace: Trace; gen?: Generation; continued: boolean }): string {
  const tr = t.trace;
  const tok = `prompt ~${tr.tokens.estimated} tok${tr.tokens.reported !== undefined ? ` (server: ${tr.tokens.reported})` : ''}`;
  const lines = [
    `trace of ${id}${t.continued ? ' (its last continue)' : ''}${t.gen?.connection ? ` · ${t.gen.connection}:${t.gen.model ?? '?'}` : ''}`,
    `  window ${tr.window} · reserve ${tr.reserve} · ${tok} · ${tr.blocks.length} messages sent`,
    `  trimmed: ${tr.trimmed ? `${tr.trimmed.from} … ${tr.trimmed.to}` : 'nothing'} · prefill: ${tr.prefill ?? 'none'}`,
    `  unknown macros: ${tr.macros.unknown.length > 0 ? tr.macros.unknown.join(', ') : 'none'}`,
  ];
  if (tr.lore.fired.length > 0) lines.push(`  lore fired: ${tr.lore.fired.length}${tr.lore.cut.length > 0 ? `, cut ${tr.lore.cut.length}` : ''}`);
  if (tr.calls.length > 0) lines.push(`  calls: ${tr.calls.map((c) => `${c.agent} ${c.model} ${(c.ms / 1000).toFixed(1)}s`).join(', ')}`);
  if (tr.partial) lines.push('  (partial: recovered after an interruption)');
  return lines.join('\n');
}

/** /sessions: newest first, the open one marked. */
export function renderSessionList(rows: readonly { id: string; title?: string; updated: string }[], current: string): string {
  if (rows.length === 0) return 'no sessions';
  return rows.map((r) => `${r.id === current ? '*' : ' '} ${r.id}  ${r.updated}  ${r.title ?? ''}`.trimEnd()).join('\n');
}

const REFUSAL_TEXT: Readonly<Record<RefusalCode, string>> = {
  stale_version: 'the session changed underneath; try again',
  session_busy: 'an answer is being written; wait for it or press Ctrl+C',
  session_locked: 'another rp-core process has this session open',
  session_not_found: 'there is no such session (/sessions lists them)',
  held_pending: 'an answer held back by a conflict must be kept or discarded first',
  no_connection: "the narrator's connection is not configured: /model <connection:model>",
  preset_missing: "the session's preset is missing",
  nothing_to_reply: 'the last message is not yours: type a message, /r or /c',
  nothing_to_swipe: 'there is no answer to swipe',
  nothing_to_continue: 'there is no answer to continue',
  continue_target_hidden: 'that answer is hidden: /unhide it first',
  continue_target_blank: 'that answer has no text to continue: /r for a new one',
  gate_unsupported: 'this needs a host gate the REPL does not have',
  invalid_params: 'invalid request',
  not_found: 'no such message',
};

/** A refusal: its code and a short human message, never a stack (§12.4). */
export function refusalText(code: RefusalCode, message: string): string {
  const human = REFUSAL_TEXT[code] ?? 'refused';
  const detail = message && message !== code && !human.includes(message) ? ` (${message})` : '';
  return `refused [${code}]: ${human}${detail}`;
}
