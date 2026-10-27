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
import type { PreviewResult, RefusalCode } from '../engine/api.ts';
import type { ImportWarning } from '../formats/native.ts';
import type { LoreVerdict } from '../lore/engine.ts';
import { entryLabel } from '../lore/engine.ts';
import type { ModelCaps, PromptMsg } from '../providers/types.ts';
import type { CEntry } from '../agents/compendium/types.ts';
import { NOTES_SCAN_DEPTH, noteText } from '../agents/compendium/notes.ts';
import type { HistorySearch } from '../tools/builtin/history.ts';
import { estimateMessage } from '../prompt/tokens.ts';
import type { Generation, Roles, SessionConfig, SessionHeader, ToolTraceRow, Trace } from '../session/entries.ts';
import type { MessageView, PathView } from '../session/view.ts';
import { markers, messageText, toolLine } from './render.ts';
import type { BookRow } from './refs.ts';
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

/**
 * Status items of a message: "swipe 2/3", tokens, seconds, finish ("greeting 1/2" for a greeting).
 * `trace`: the answer's own trace, when the caller has it: 'tools: off (prefill)' when the preset's
 * prefill turned the narrator's tools off for it (D-28, M3).
 */
export function statusItems(m: MessageView, trace?: Pick<Trace, 'prefill'>): string[] {
  if (m.gen?.kind === 'greeting') return [`greeting ${m.swipe.index + 1}/${m.swipe.count}`];
  const items = [`swipe ${m.swipe.index + 1}/${m.swipe.count}`];
  const g = m.gen;
  const out = g?.usage?.outputTotal;
  if (typeof out === 'number') items.push(`${out} tok`);
  if (typeof g?.ms === 'number') items.push(`${(g.ms / 1000).toFixed(1)}s`);
  if (g?.finish) items.push(g.finish);
  if (m.edited) items.push('edited');
  if (m.hidden) items.push('hidden');
  if (trace?.prefill === 'tools_off') items.push('tools: off (prefill)');
  return items;
}

/** The dim line after an answer: "[swipe 1/1 · 386 tok · 7.9s · end]   /r swipe  /c continue  /e edit". */
export function statusLine(m: MessageView, style: Style, trace?: Pick<Trace, 'prefill'>): string {
  const hints = m.gen?.kind === 'greeting' ? (m.swipe.count > 1 ? '/r next greeting  /[ /] browse' : '') : '/r swipe  /c continue  /e edit';
  return style.dim(`  [${statusItems(m, trace).join(' · ')}]${hints ? `   ${hints}` : ''}`);
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
    case 'tool':
      // One line per finished call, whatever round it came from (render.ts, shared with `send`).
      return toolLine(ev);
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
  /** A side line (a tool call) interrupted the answer's text; the next round's separator is not shown. */
  private afterSide = false;
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
      case 'text': {
        let delta = ev.delta;
        // D-55: the text of a round after tool calls starts with one "\n" when the answer so far
        // ends mid-line. The side line already broke the line, so the screen drops it (the stored
        // answer keeps it).
        if (this.afterSide && delta.startsWith('\n')) delta = delta.slice(1);
        if (delta === '') return;
        this.afterSide = false;
        this.endReasoning();
        this.openText();
        screen.write(this.prose.push(delta));
        this.streamed = true;
        return;
      }
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
        if (this.prefixed) this.afterSide = true;
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

/** The banner's tools word for a caps.tools value (M3): native, prompted, or off ('none' or unknown caps). */
export function toolsWord(tools: ModelCaps['tools'] | null | undefined): 'native' | 'prompted' | 'off' {
  return tools === 'native' || tools === 'prompted' ? tools : 'off';
}

/**
 * The banner line: "session s_4fa2 · Mira · narrator local:qwen3-14b (tools: prompted) · ctx 16384".
 * `tools` is the narrator route's caps.tools (off for 'none' or caps nobody knows). With the model's
 * window unknown, `cap` (the preset's or the session's own limit) still bounds it: "ctx ≤4095"; with
 * neither, "ctx ?".
 */
export function bannerLine(
  header: Pick<SessionHeader, 'id' | 'title'>,
  narrator: { conn: string; model: string },
  window: number | null,
  style: Style,
  cap?: number,
  tools?: ModelCaps['tools'] | null,
): string {
  const title = header.title ?? '(untitled)';
  const ctx = window !== null ? String(window) : cap !== undefined && cap > 0 ? `≤${cap}` : '?';
  return style.bold(`session ${header.id} · ${title} · narrator ${narrator.conn}:${narrator.model} (tools: ${toolsWord(tools)}) · ctx ${ctx}`);
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

/** `book:id` with the entry's title when it has one: `"Gull Point" harbor:0`. */
function entryName(book: string, id: string, titles?: ReadonlyMap<string, string>): string {
  const label = entryLabel(book, id);
  const title = titles?.get(label);
  return title ? `"${title}" ${label}` : label;
}

/** ' · not sent: …' for a fired entry whose text nothing in the request took (Trace.lore.unsent). */
function unsentNote(lore: Trace['lore'] | undefined, label: string): string {
  const slot = lore?.unsent && Object.hasOwn(lore.unsent, label) ? lore.unsent[label] : undefined;
  return slot === undefined ? '' : ` · not sent: the preset has no enabled ${slot}`;
}

/**
 * The lore lines of a trace (M2): what fired and why, what the budget cut, the budget. Nothing for a
 * trace with no lore at all (M1 traces, sessions without books).
 */
export function loreTraceLines(tr: Trace, titles?: ReadonlyMap<string, string>): string[] {
  const lore = tr.lore;
  if (!lore || (lore.fired.length === 0 && lore.cut.length === 0 && !(lore.budget > 0))) return [];
  const lines: string[] = [];
  if (lore.fired.length === 0) lines.push(`  lore: nothing fired · budget ${lore.budget} tok`);
  else {
    lines.push(`  lore fired: ${lore.fired.length} · budget ${lore.budget} tok`);
    for (const f of lore.fired) lines.push(`    ✓ ${entryName(f.book, f.id, titles)} (${f.why})${unsentNote(lore, entryLabel(f.book, f.id))}`);
  }
  if (lore.cut.length > 0) lines.push(`  lore cut by the budget: ${lore.cut.map((l) => (titles?.get(l) ? `"${titles.get(l)}" ${l}` : l)).join(', ')}`);
  return lines;
}

/**
 * /trace: a summary of the newest trace of the last answer. `after` goes right after the stored
 * lore lines: the recomputed misses and the notice that the inputs changed (repl.ts).
 */
export function renderTrace(
  id: string,
  t: { trace: Trace; gen?: Generation; continued: boolean },
  titles?: ReadonlyMap<string, string>,
  after: readonly string[] = [],
): string {
  const tr = t.trace;
  const tok = `prompt ~${tr.tokens.estimated} tok${tr.tokens.reported !== undefined ? ` (server: ${tr.tokens.reported})` : ''}`;
  const lines = [
    `trace of ${id}${t.continued ? ' (its last continue)' : ''}${t.gen?.connection ? ` · ${t.gen.connection}:${t.gen.model ?? '?'}` : ''}`,
    `  window ${tr.window} · reserve ${tr.reserve} · ${tok} · ${tr.blocks.length} messages sent`,
    `  trimmed: ${tr.trimmed ? `${tr.trimmed.from} … ${tr.trimmed.to}` : 'nothing'} · prefill: ${tr.prefill ?? 'none'}`,
    `  unknown macros: ${tr.macros.unknown.length > 0 ? tr.macros.unknown.join(', ') : 'none'}`,
  ];
  lines.push(...loreTraceLines(tr, titles), ...after);
  if (tr.calls.length > 0) lines.push(`  calls: ${tr.calls.map((c) => `${c.agent} ${c.model} ${(c.ms / 1000).toFixed(1)}s`).join(', ')}`);
  lines.push(...toolTraceLines(tr));
  if (tr.partial) lines.push('  (partial: recovered after an interruption)');
  return lines.join('\n');
}

/** Why a tool loop stopped calling tools (Trace.rounds.ended), in a few words. */
const ENDED: Readonly<Record<NonNullable<Trace['rounds']>['ended'], string>> = {
  answer: 'answer',
  max_rounds: 'max_rounds (the round limit)',
  ceiling: 'ceiling (the model call limit of a turn)',
  guard: 'guard (the same call kept coming back)',
  room: 'room (the tool room ran out)',
  stopped: 'stopped',
  error: 'error',
};

/** One Trace.tools row: "round 1 · search_history · ok · 412 chars · cut". */
function toolRowText(t: ToolTraceRow): string {
  const parts = [`round ${t.round}`, t.name, t.refused !== undefined ? `refused: ${t.refused}` : t.ok ? 'ok' : 'error'];
  if (t.repaired && t.repaired.length > 0) parts.push(`repaired: ${t.repaired.join(', ')}`);
  if (t.chars !== undefined) parts.push(plural(t.chars, 'char'));
  if (t.cut) parts.push('cut');
  return parts.join(' · ');
}

/**
 * /trace (M3): the narrator's tool loop — model calls, transport, why it stopped, the tool room
 * used of what assemble reserved — then one line per tool call. Nothing for a turn without tools.
 */
export function toolTraceLines(tr: Pick<Trace, 'rounds' | 'tools'>): string[] {
  const out: string[] = [];
  const r = tr.rounds;
  if (r) {
    const used = Math.max(0, r.room - r.roomLeft);
    out.push(`  rounds: ${r.n} · ${r.transport} tools · ended: ${ENDED[r.ended] ?? r.ended} · tool room ${used} of ${r.room} tok used`);
  }
  const rows = tr.tools ?? [];
  if (rows.length > 0) {
    out.push(`  tool calls: ${rows.length}`);
    for (const t of rows) out.push(`    ${toolRowText(t)}`);
  }
  return out;
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

// ---- presets and lorebooks (M2) -----------------------------------------------------------------------

/** The cap words of a preset's window limit (openai_max_context), or '' when it does not shrink the model's. */
export function presetCapText(cap: number | undefined, model: number | null): string {
  if (cap === undefined || !(cap > 0) || (model !== null && cap >= model)) return '';
  return `it caps the window at ${cap}${model !== null ? ` of the model's ${model}` : ''} tokens`;
}

/**
 * /preset with no argument: the session's preset (and the window it caps, when it does: `cap` is
 * the preset's own limit and the model's window, null when unknown) and what the library holds.
 * 'builtin' is always the built-in layout: a library file of that id (saved before the id was
 * reserved) can never be selected, so it is not listed as one, only named.
 */
export function renderPresets(
  current: string,
  library: readonly { id: string; name: string }[],
  cap?: { maxContext?: number; model: number | null },
): string {
  const shadowed = library.some((r) => r.id === 'builtin');
  const rows = [{ id: 'builtin', name: '' }, ...library.filter((r) => r.id !== 'builtin')];
  const width = Math.max(...rows.map((r) => r.id.length));
  const caps = cap ? presetCapText(cap.maxContext, cap.model) : '';
  const lines = [`preset: ${current}${rows.some((r) => r.id === current) ? '' : ' (missing from the library: the next turn is refused)'}${caps ? ` · ${caps}` : ''}`];
  for (const r of rows) {
    const what = r.id === 'builtin' ? 'the built-in layout' : r.name !== r.id ? `"${r.name}"` : '';
    lines.push(`${r.id === current ? '*' : ' '} ${r.id.padEnd(width)}  ${what}`.trimEnd());
  }
  if (shadowed) lines.push("(library/presets/builtin.json is not listed: 'builtin' always means the built-in layout; rename the file to use it)");
  lines.push('(/preset <id> switches; /preset <file> imports a SillyTavern preset first)');
  return lines.join('\n');
}

/**
 * What an import said, briefly: one line, then at most `max` warnings (each names what the file
 * has that rp-core does not honour) and a count of the rest.
 */
export function renderImported(
  kind: string,
  imp: { file: string; path: string; warnings: readonly ImportWarning[] },
  id: string,
  max = 3,
): string {
  const n = imp.warnings.length;
  const lines = [`imported ${kind} ${id} from ${imp.file}${n > 0 ? ` (${n} warning${n === 1 ? '' : 's'})` : ''}`];
  for (const w of imp.warnings.slice(0, max)) lines.push(`  ! ${w.message}${w.path ? ` (${w.path})` : ''}`);
  if (n > max) lines.push(`  … and ${n - max} more (rp-core import <file> lists them all)`);
  return lines.join('\n');
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** /lore: every book a turn scans, in scan order, and the library books not in use. */
export function renderLoreBooks(rows: readonly BookRow[], library: readonly { id: string; name: string }[]): string {
  const lines: string[] = [];
  if (rows.length === 0) lines.push('no lorebooks: /lore add <id|file> adds one (a SillyTavern world info file is imported)');
  else {
    lines.push('lorebooks, in the order a turn scans them:');
    const width = Math.max(...rows.map((r) => r.key.length));
    for (const r of rows) {
      const whose = r.owner === 'card' ? "the card's own book " : r.owner === 'persona' ? "your persona's book " : '';
      const body = r.problem
        ? `(${r.problem})`
        : `${whose}"${r.name}" · ${plural(r.entries ?? 0, 'entry', 'entries')}${r.disabled ? ` (${r.disabled} disabled)` : ''}` +
          (r.shadowedBy ? ` · not read: ${r.shadowedBy} has the same name (a world is read once, as in SillyTavern)` : '');
      lines.push(`  ${r.key.padEnd(width)}  ${body}`);
    }
  }
  const used = new Set(rows.map((r) => r.key));
  const spare = library.filter((b) => !used.has(b.id)).map((b) => b.id);
  if (spare.length > 0) lines.push(`in the library, not in this session: ${spare.join(', ')} (/lore add <id>)`);
  return lines.join('\n');
}

/** A verdict's numbers in words: the roll, the timers, the budget (in budget tokens: the counts the budget compares). */
function verdictDetail(v: LoreVerdict): string[] {
  const d = v.detail;
  const out: string[] = [];
  if (d?.rolled !== undefined && d.needed !== undefined) out.push(`roll ${d.rolled.toFixed(2)} ${v.fired ? '≤' : '>'} ${d.needed.toFixed(2)}`);
  if (d?.remaining !== undefined) {
    const what = v.why === 'sticky' ? 'sticky for' : v.why === 'cooldown' ? 'cooldown:' : v.why === 'delay' ? 'delayed:' : 'for';
    out.push(`${what} ${plural(d.remaining, 'more message')}`);
  }
  if (d?.overflowed) out.push(`skipped: an earlier entry had already used up the budget (alone it costs ${d.cost ?? '?'} budget tok)`);
  else if (d?.cost !== undefined && d.left !== undefined) out.push(`costs ${d.cost} budget tok, ${d.left} left`);
  if (d?.recursionLimit !== undefined) out.push(`recursion would wake it, but it stops after ${plural(d.recursionLimit, 'loop')}`);
  if (v.regexErrors && v.regexErrors.length > 0) out.push(`bad regex ${v.regexErrors.join(', ')}`);
  return out;
}

/** Reasons that make up the bulk of a large book; only these are folded into a count. */
const QUIET = new Set(['no-key-match', 'disabled']);

/** A no-key-match that recursion would have woken past the loop limit is news, not bulk. */
const isQuiet = (v: LoreVerdict): boolean => QUIET.has(v.why) && v.detail?.recursionLimit === undefined;

/**
 * One verdict as a line (after `indent`): mark, title and label, reason, keys, loop, the numbers,
 * and for a fire its own token count — raw, as /preview's rows count (v.rawTokens; the budget's
 * corrected count when the run had no raw counter). A budget cut's numbers are its detail.
 */
function verdictLine(v: LoreVerdict, lore: Trace['lore'] | undefined, style: Style, titles: ReadonlyMap<string, string> | undefined, indent: string): string {
  const name = v.title?.trim() || titles?.get(entryLabel(v.book, v.id));
  const parts = [`${v.fired ? '✓' : '✗'} ${name ? `"${name}" ` : ''}${entryLabel(v.book, v.id)}`, v.why];
  if (v.matched.length > 0) parts.push(`keys: ${v.matched.join(', ')}`);
  // A miss is judged again in every loop; only a fire's loop says something.
  if (v.fired && v.loop > 0) parts.push(`recursion loop ${v.loop}`);
  parts.push(...verdictDetail(v));
  if (v.fired) parts.push(`${v.rawTokens ?? v.tokens} tok`);
  const text = `${indent}${parts.join(' · ')}${v.fired ? unsentNote(lore, entryLabel(v.book, v.id)) : ''}`;
  return v.fired ? text : style.dim(text);
}

/** "no-key-match 12, disabled 3": a count per reason, in first-seen order. */
function countsByWhy(vs: readonly LoreVerdict[]): string {
  const by = new Map<string, number>();
  for (const v of vs) by.set(v.why, (by.get(v.why) ?? 0) + 1);
  return [...by].map(([why, n]) => `${why} ${n}`).join(', ');
}

/** The factor as the budget line names it: ×1.15. */
const factorText = (f: number): string => `×${f.toFixed(2)}`;

/**
 * The budget part of a verdicts' totals line: "909 of 949 budget tok (counts ×1.15 for this model)".
 * Budget tokens are the raw counts scaled by the model's EMA correction [D-50]; without the run's
 * figures (an older engine), the bare budget.
 */
function budgetText(lore: Trace['lore'] | undefined, use: { used: number; factor: number } | undefined): string[] {
  if (!lore) return [];
  if (!use) return [`budget ${lore.budget} budget tok`];
  const factor = use.factor !== 1 ? ` (counts ${factorText(use.factor)} for this model)` : '';
  return [`${use.used} of ${lore.budget} budget tok${factor}`];
}

/**
 * /lore test and `preview --verdicts`: one line per entry, fired first (acceptance order kept), then
 * the others; a large book's no-key-match / disabled tail beyond `max` lines is summed up in one
 * line. Then the totals: the fired entries' own tokens (raw, as /preview counts them) and the budget
 * in budget tokens with the model's correction factor (`use`, PreviewResult.loreUse).
 */
export function renderVerdicts(
  verdicts: readonly LoreVerdict[],
  lore: Trace['lore'] | undefined,
  style: Style,
  titles?: ReadonlyMap<string, string>,
  max = 40,
  use?: { used: number; factor: number },
): string {
  if (verdicts.length === 0) return 'no lore entries to test: /lore add <id|file> adds a book';
  const line = (v: LoreVerdict): string => verdictLine(v, lore, style, titles, '  ');
  const fired = verdicts.filter((v) => v.fired);
  const loud = verdicts.filter((v) => !v.fired && !isQuiet(v));
  const quiet = verdicts.filter((v) => !v.fired && isQuiet(v));
  const lines = [...fired.map(line), ...loud.map(line)];
  const room = Math.max(0, max - lines.length);
  lines.push(...quiet.slice(0, room).map(line));
  const rest = quiet.slice(room);
  if (rest.length > 0) lines.push(style.dim(`  … and ${rest.length} more not fired (${countsByWhy(rest)})`));
  const cut = verdicts.filter((v) => v.why === 'budget-cut').length;
  const used = fired.reduce((n, v) => n + (v.rawTokens ?? v.tokens), 0);
  const totals = [`${fired.length} of ${verdicts.length} fired`, ...(cut > 0 ? [`${cut} cut by the budget`] : []), `${used} tok of lore`, ...budgetText(lore, use)];
  lines.push(totals.join(' · '));
  return lines.join('\n');
}

/**
 * /trace (M2 final fix, D-45): the misses of a past answer's verdicts, recomputed from its seed and
 * clock, for the lines after the stored fired / cut / unsent ones. Each miss with a reason of its
 * own gets a line; the no-key-match and disabled ones (a large book's bulk) are one count line, as
 * /lore test folds them. Budget cuts the stored line already names are left out. Empty when nothing
 * was missed. `continued`: the trace shown is a continue's, the verdicts are of the answer's own request.
 */
export function renderTraceMisses(
  verdicts: readonly LoreVerdict[],
  lore: Trace['lore'] | undefined,
  style: Style,
  titles?: ReadonlyMap<string, string>,
  continued = false,
): string[] {
  const stored = new Set(lore?.cut ?? []);
  const misses = verdicts.filter((v) => !v.fired && !(v.why === 'budget-cut' && stored.has(entryLabel(v.book, v.id))));
  if (misses.length === 0) return [];
  const loud = misses.filter((v) => !isQuiet(v));
  const quiet = misses.filter(isQuiet);
  const what = continued ? "recomputed for the answer's own request, before its continue" : 'recomputed from its seed';
  const lines = [`  lore not fired (${what}):`, ...loud.map((v) => verdictLine(v, lore, style, titles, '    '))];
  if (quiet.length > 0) lines.push(style.dim(`    ✗ ${loud.length > 0 ? `${quiet.length} more` : plural(quiet.length, 'entry', 'entries')}: ${countsByWhy(quiet)}`));
  return lines;
}

/** A prompt message's text as sent: text blocks as they are, other blocks as a bracketed line. */
export function promptText(m: PromptMsg): string {
  return m.blocks
    .map((b) => {
      switch (b.k) {
        case 'text':
          return b.text;
        case 'reasoning':
          return `[reasoning] ${b.text}`;
        case 'tool_call':
          return `[tool call ${b.name} ${b.args}]`;
        case 'tool_result':
          return `[tool result ${b.name}${b.error ? ' (error)' : ''}] ${b.text}`;
        default:
          return '';
      }
    })
    .join('');
}

/** What the request is built for, in words. */
function previewWhat(r: Extract<PreviewResult, { ok: true }>): string {
  if (r.upTo === 'draft') return 'a reply to your draft';
  switch (r.kind) {
    case 'reply':
      return `a reply to ${r.upTo}`;
    case 'swipe':
      return `a swipe (a new answer to ${r.upTo})`;
    case 'continue':
      return `a continue of ${r.upTo}`;
  }
}

const samplerText = (s: Record<string, unknown>): string => {
  const entries = Object.entries(s).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k} ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`).join(', ');
};

/**
 * The tools line of a preview (M3): the tools the request offers and how (`transport`: the primary
 * route's caps.tools, when the caller knows it); 'off (prefill)' when the preset's prefill turned
 * them off (D-28); else none.
 */
export function previewToolsText(r: Pick<Extract<PreviewResult, { ok: true }>, 'tools' | 'trace'>, transport?: ModelCaps['tools'] | null): string {
  if (r.tools.length === 0) return r.trace.prefill === 'tools_off' ? "off (prefill): the preset's prefill wins this turn (prefill_vs_tools)" : 'none';
  const how = transport === 'native' || transport === 'prompted' ? ` (${transport})` : '';
  return `${r.tools.map((t) => t.name).join(', ')}${how}`;
}

/**
 * /preview and `rp-core preview`: kind and model, then every message numbered with its role, its
 * source and its token count, followed by its full text (M3: the core:tools block is one of them);
 * then prefill, max tokens, samplers, tools, the lore lines and the notices.
 */
export function renderPreview(
  r: Extract<PreviewResult, { ok: true }>,
  style: Style,
  titles?: ReadonlyMap<string, string>,
  transport?: ModelCaps['tools'] | null,
): string {
  const tr = r.trace;
  const counter = tr.tokens.counter ? ` (${tr.tokens.counter})` : '';
  const lines = [
    style.bold(`preview of ${previewWhat(r)} · ${r.model.connection}:${r.model.model}`),
    `  window ${tr.window} · reserve ${tr.reserve} · prompt ~${tr.tokens.estimated} tok${counter} · ${plural(r.messages.length, 'message')} · nothing was sent`,
  ];
  // trace.blocks is 1:1 with the messages assemble produced; shaping may merge some, so the counts
  // are taken from it only when it still lines up.
  const aligned = tr.blocks.length === r.messages.length;
  r.messages.forEach((m, i) => {
    const tok = aligned ? tr.blocks[i]!.tok : estimateMessage(m);
    lines.push('', style.bold(`#${i + 1} ${m.role} · ${m.src} · ${tok} tok`));
    const text = promptText(m);
    lines.push(text === '' ? style.dim('(empty)') : text);
  });
  lines.push('');
  // The samplers as the connection sends them; the ones its caps drop are named apart.
  const dropped = new Set(r.samplersNotSent ?? []);
  const sent = Object.fromEntries(Object.entries(r.samplers).filter(([k]) => !dropped.has(k)));
  lines.push(`prefill: ${r.prefill === null ? 'none' : JSON.stringify(r.prefill)} · max tokens ${r.maxTokens} · samplers: ${samplerText(sent)}`);
  if (dropped.size > 0) lines.push(`not sent by this connection: ${[...dropped].join(', ')}`);
  lines.push(`tools: ${previewToolsText(r, transport)}`);
  lines.push(...loreTraceLines(tr, titles));
  for (const n of r.notices) lines.push(style.yellow(noticeText(n)));
  return lines.join('\n');
}

/** --wire: the HTTP request the connection would send (no headers: they carry the key). */
export function renderWire(wire: { url: string; body: unknown }): string {
  return `POST ${wire.url}\n${JSON.stringify(wire.body, null, 2)}`;
}

/** A preview that could not be built: its code and message. */
export function previewFailureText(r: Extract<PreviewResult, { ok: false }>): string {
  const human = (REFUSAL_TEXT as Partial<Record<string, string>>)[r.code];
  return `preview refused [${r.code}]: ${human ?? r.message}${human && r.message && r.message !== r.code && !human.includes(r.message) ? ` (${r.message})` : ''}`;
}

// ---- notes and search (M3) ----------------------------------------------------------------------

/** A note's text on one line, cut to `max` characters. */
const gist = (s: string, max = 60): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A note's lore keys as the notes book reads them (a note without keys is keyed by its title). */
const noteKeys = (e: CEntry): string[] => {
  const keys = e.keys.filter((k) => k.trim() !== '');
  return keys.length > 0 ? keys : [e.name];
};

/**
 * /memory (decision F6): the notes of this path in creation order, each with its handle:
 * "C1  Brother — Mira's brother Yan sails the north road · keys: Yan, brother"; a retired one dimmed.
 */
export function renderNoteList(rows: readonly { ref: string; entry: CEntry }[], style: Style): string {
  if (rows.length === 0) return 'no notes on this path yet: /memory add <title> | <keys> | <text> writes one';
  const width = Math.max(...rows.map((r) => r.ref.length));
  const live = rows.filter((r) => !r.entry.retired).length;
  const lines = [`notes on this path: ${live} live${rows.length > live ? `, ${rows.length - live} retired` : ''} (/memory show <ref> prints one)`];
  for (const { ref, entry: e } of rows) {
    const parts = [`${e.name} — ${gist(e.content ?? '')}`, `keys: ${noteKeys(e).join(', ')}`];
    if (e.retired) parts.push(`retired${e.retired.reason ? ` (${e.retired.reason})` : ''}`);
    const line = `  ${ref.padEnd(width)}  ${parts.join(' · ')}`;
    lines.push(e.retired ? style.dim(line) : line);
  }
  return lines.join('\n');
}

/** /memory show <ref>: the note, its keys, where it came from, and the text a turn sends when it fires. */
export function renderNoteCard(ref: string, e: CEntry): string {
  const lines = [`${ref} ${e.name} · ${e.key}`, `  keys: ${noteKeys(e).join(', ')}`];
  const changed = e.prov.lastSeq !== e.prov.createdSeq ? `; last changed at row ${e.prov.lastSeq}` : '';
  lines.push(`  written by you at journal row ${e.prov.createdSeq}${changed}`);
  if (e.retired) {
    lines.push(`  retired${e.retired.reason ? `: ${e.retired.reason}` : ''} (it does not fire; /memory restore ${ref} brings it back)`);
  } else {
    lines.push(`  sent when one of its keys comes up in the last ${NOTES_SCAN_DEPTH} messages, as:`);
  }
  for (const l of noteText(e.name, e.content ?? '').split('\n')) lines.push(`    ${l}`);
  return lines.join('\n');
}

/**
 * /search (§7.5): the hits as search_history gives them to the narrator — `#n speaker: snippet`,
 * ' (in context)' when the last request sent that message — newest first, then the next page's command.
 */
export function renderSearch(query: string, r: HistorySearch, before: number | undefined, style: Style): string {
  if (r.hits.length === 0) return style.dim(before !== undefined ? `no messages before #${before} match` : 'no messages match');
  const lines = r.hits.map((h) => `#${h.n} ${h.speaker}: ${h.snippet}${h.inContext ? ' (in context)' : ''}`);
  if (r.nextBefore !== null) lines.push(style.dim(`(older matches: /search ${query} before=${r.nextBefore})`));
  return lines.join('\n');
}
