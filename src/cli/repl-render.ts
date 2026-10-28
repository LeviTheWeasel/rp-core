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
import type { MemoryRow, MemoryStatus, PreviewResult, RefusalCode } from '../engine/api.ts';
import type { ImportWarning } from '../formats/native.ts';
import type { LoreVerdict } from '../lore/engine.ts';
import { entryLabel } from '../lore/engine.ts';
import type { ModelCaps, PromptMsg } from '../providers/types.ts';
import { ENTRY_TYPE_INFO } from '../agents/compendium/entry-types.ts';
import { entryCountOf, type TreeNode } from '../agents/compendium/tree.ts';
import { ENTRY_TYPES, type CEntry, type CompendiumProfile, type EntryType } from '../agents/compendium/types.ts';
import { NOTES_SCAN_DEPTH, noteText } from '../agents/compendium/notes.ts';
import { COMPENDIUM_LIMITS, LITE_WINDOW } from '../agents/compendium/profile.ts';
import { MOMENTUM } from '../agents/director/momentum.ts';
import { renderDirective } from '../agents/director/render.ts';
import { ageOf, isFinishedArc, isFinishedHidden } from '../agents/director/state.ts';
import { SURFACE_TURNS, type DirectorRecord, type DirectorState, type Horizon, type NarratorDirective } from '../agents/director/types.ts';
import type { HistorySearch } from '../tools/builtin/history.ts';
import { estimateMessage } from '../prompt/tokens.ts';
import type { CompendiumTrace, Generation, RecallRecord, Roles, SessionConfig, SessionHeader, ToolTraceRow, Trace } from '../session/entries.ts';
import type { RecallMode } from '../engine/recall.ts';
import type { MessageView, PathView } from '../session/view.ts';
import { markers, messageText, toolLine } from './render.ts';
import type { BookRow } from './refs.ts';
import type { TailRow, UsageCounts, UsageSummary } from './repl-journal.ts';

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

/** The quotes that open / close speech besides `"` (which toggles); the TUI's chat styler reads them too. */
export const OPEN_QUOTES: ReadonlySet<string> = new Set(['“', '«']);
export const CLOSE_QUOTES: ReadonlySet<string> = new Set(['”', '»']);

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

/** A memory event's change as its side line says it, after the kind and the name (`character "Мира" merged`). */
const MEMORY_CHANGE: Readonly<Record<string, string>> = {
  created: 'created',
  merged: 'merged',
  arc: 'overview written',
  note: 'added',
  edited: 'edited',
  retired: 'retired',
  restored: 'restored',
  reverted: 'reverted',
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
      return `⋯ memory: ${ev.kind} "${ev.name}" ${MEMORY_CHANGE[ev.change] ?? ev.change}${ev.by === 'user' ? '' : ` by ${ev.by}`}`;
    case 'retry':
      return `⋯ retrying in ${(ev.delayMs / 1000).toFixed(1)} s (${ev.code}${ev.status !== undefined ? `, HTTP ${ev.status}` : ''})`;
    default:
      return null;
  }
}

/** A notice as one line (the caller prints it yellow, once per code and message per session). */
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
  /** Print a notice (the REPL dedupes by code and message per session). */
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
 * neither, "ctx ?". M4 (D-113): `director` (only while it is enabled) adds "director conn:model (profile)"
 * after the narrator part.
 */
export function bannerLine(
  header: Pick<SessionHeader, 'id' | 'title'>,
  narrator: { conn: string; model: string },
  window: number | null,
  style: Style,
  cap?: number,
  tools?: ModelCaps['tools'] | null,
  director?: { conn: string; model: string; profile: string } | null,
): string {
  const title = header.title ?? '(untitled)';
  const ctx = window !== null ? String(window) : cap !== undefined && cap > 0 ? `≤${cap}` : '?';
  const dir = director ? ` · director ${director.conn}:${director.model} (${director.profile})` : '';
  return style.bold(`session ${header.id} · ${title} · narrator ${narrator.conn}:${narrator.model} (tools: ${toolsWord(tools)})${dir} · ctx ${ctx}`);
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

/** A role's binding as /model shows it; an unset role follows `unset` (D-85: recall follows the recorder, the others the narrator). */
const bindingText = (b: Roles[keyof Roles], unset: 'narrator' | 'recorder'): string =>
  b === undefined ? `${unset} (follows)` : typeof b === 'string' ? `${b} (follows)` : `${b.conn}:${b.model}${b.fallback ? ` (fallback ${b.fallback.conn}:${b.fallback.model})` : ''}`;

/** /model: the role bindings (one role, or all four). */
export function renderBindings(roles: Roles, only?: keyof Roles): string {
  const keys: (keyof Roles)[] = only ? [only] : ['narrator', 'director', 'recorder', 'recall'];
  return keys.map((k) => `  ${k.padEnd(8)} ${bindingText(roles[k], k === 'recall' ? 'recorder' : 'narrator')}`).join('\n');
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

/** The notes under a /usage line: calls without usage, calls without a price. */
function usageNotes(u: UsageCounts, what: string): string[] {
  const notes: string[] = [];
  if (u.noUsage > 0) notes.push(`${u.noUsage}${what} without usage from the server`);
  if (u.unpriced > 0) notes.push(`${u.unpriced}${what} without a price ([prices."conn:model"] in config.toml)`);
  return notes;
}

/** "in 900 tok · out 120 tok · cost $0.50" (the tokens only when some call reported them). */
function usageParts(u: UsageCounts): string[] {
  const parts: string[] = [];
  if (u.calls - u.noUsage > 0) parts.push(`in ${u.inputTokens} tok`, `out ${u.outputTokens} tok`);
  parts.push(u.costUsd === null ? 'cost unknown' : `cost ${formatUsd(u.costUsd)}`);
  return parts;
}

/**
 * /usage. Without other agents' calls: one line for the narrator's generations, as before M4. With
 * them (M4: the Director, D-101): one row per agent, then the total.
 */
export function renderUsage(u: UsageSummary): string {
  const agents = Object.entries(u.agents ?? {}).filter(([, a]) => a.calls > 0);
  if (agents.length === 0) {
    if (u.calls === 0) return 'no model answers on this path yet';
    const parts = [`${u.calls} generation${u.calls === 1 ? '' : 's'} on this path`, ...usageParts(u)];
    const notes = usageNotes(u, '');
    return parts.join(' · ') + (notes.length > 0 ? `\n  (${notes.join('; ')})` : '');
  }
  const width = Math.max('narrator'.length, 'total'.length, ...agents.map(([name]) => name.length));
  const lines = ['usage on this path:'];
  const notes: string[] = [];
  if (u.calls > 0) {
    lines.push(`  ${'narrator'.padEnd(width)}  ${[plural(u.calls, 'generation'), ...usageParts(u)].join(' · ')}`);
    notes.push(...usageNotes(u, ' narrator generation(s)'));
  }
  const total: UsageCounts = { ...u };
  for (const [name, a] of agents) {
    lines.push(`  ${name.padEnd(width)}  ${[plural(a.calls, 'call'), ...usageParts(a)].join(' · ')}`);
    notes.push(...usageNotes(a, ` ${name} call(s)`));
    total.calls += a.calls;
    total.noUsage += a.noUsage;
    total.unpriced += a.unpriced;
    total.inputTokens += a.inputTokens;
    total.outputTokens += a.outputTokens;
    if (a.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + a.costUsd;
  }
  lines.push(`  ${'total'.padEnd(width)}  ${usageParts(total).join(' · ')}`);
  if (notes.length > 0) lines.push(`  (${notes.join('; ')})`);
  return lines.join('\n');
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
 * lore lines: the recomputed misses and the notice that the inputs changed (repl.ts). M5a: the
 * Compendium line follows when the request had Compendium input; `names` maps entry keys to names.
 * M5c: `recall` (recallTraceLine) goes right before it.
 */
export function renderTrace(
  id: string,
  t: { trace: Trace; gen?: Generation; continued: boolean },
  titles?: ReadonlyMap<string, string>,
  after: readonly string[] = [],
  names?: ReadonlyMap<string, string>,
  refs?: ReadonlyMap<string, string>,
  recall?: string | null,
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
  // M5c (D-206): what recall gave the block, before what the block did.
  if (recall !== undefined && recall !== null) lines.push(recall);
  if (tr.compendium) lines.push(compendiumTraceLine(tr.compendium, names));
  const recap = recapTraceLine(tr.recap, names, refs);
  if (recap !== null) lines.push(recap);
  if (tr.calls.length > 0) lines.push(`  calls: ${tr.calls.map((c) => `${c.agent} ${c.model} ${(c.ms / 1000).toFixed(1)}s`).join(', ')}`);
  lines.push(...toolTraceLines(tr));
  if (tr.partial) lines.push('  (partial: recovered after an interruption)');
  return lines.join('\n');
}

/**
 * /trace (M5b, D-178): what the request's {{recap}} slot held — its arcs with the revision rendered
 * (rev = the journal row of the overview's text; 0: the book's own), its summaries in render order, and
 * the boundary (the first history message sent after the cut) that keeps it stable. null when the slot
 * was empty (or the trace predates it). `names` and `refs`: entry key → its name and C<n> now.
 */
export function recapTraceLine(r: Trace['recap'] | undefined, names?: ReadonlyMap<string, string>, refs?: ReadonlyMap<string, string>): string | null {
  if (!r || (r.ids.length === 0 && r.arcs.length === 0)) return null;
  const who = (key: string): string => {
    const ref = refs?.get(key);
    const name = names?.get(key);
    if (ref !== undefined) return name !== undefined ? `${ref} ${JSON.stringify(name)}` : ref;
    return name !== undefined ? `${JSON.stringify(name)} ${key}` : key;
  };
  const parts: string[] = [];
  if (r.arcs.length > 0) parts.push(`${plural(r.arcs.length, 'arc')}: ${r.arcs.map((a) => `${who(a.key)} rev ${a.rev}`).join(', ')}`);
  if (r.ids.length > 0) parts.push(`${plural(r.ids.length, 'summary', 'summaries')}: ${r.ids.map(who).join(', ')}`);
  parts.push(`boundary ${r.boundary ?? 'none'}`);
  return `  recap: ${parts.join(' · ')}`;
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

/** An entry's data size as /memory lists it: 312, 2.1k (D-161). */
export const sizeText = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

/** An entry's display name: an arc reads `[Arc] <plot>` (D-145). */
const shownName = (type: MemoryRow['type'], name: string): string => (type === 'arc' ? `[Arc] ${name}` : name);

/**
 * One /memory line (D-161): `C12 Мира Ванс (aka Фонарщица) — <tagline> [lib: lantern] [2.1k]`. A note
 * shows the start of its text and its keys, an arc the start of its overview; an overlay reads
 * `[lib: <book>, edited]`, a retired entry `[retired: <reason>]`. `e`: the entry itself (notes, arcs).
 */
export function memoryRowText(row: MemoryRow, e?: CEntry): string {
  let line = shownName(row.type, row.name);
  if (row.aliases.length > 0) line += ` (aka ${row.aliases.join(', ')})`;
  const about = row.tagline !== '' ? row.tagline : row.type === 'note' || row.type === 'arc' ? gist(e?.content ?? '') : '';
  if (about !== '') line += ` — ${about}`;
  if (row.type === 'note' && e) line += ` · keys: ${noteKeys(e).join(', ')}`;
  const tags: string[] = [];
  if (row.origin !== 'session') tags.push(`[lib: ${row.origin.book}${row.overlay ? ', edited' : ''}]`);
  if (row.featured) tags.push('[featured]');
  if (row.retired) tags.push(row.retired.reason !== '' ? `[retired: ${row.retired.reason}]` : '[retired]');
  // A note's or an arc's size is its text's length (the lead's ruling on D-161), whatever the row says.
  const size = (row.type === 'note' || row.type === 'arc') && typeof e?.content === 'string' ? e.content.length : row.size;
  tags.push(`[${sizeText(size)}]`);
  return `${line} ${tags.join(' ')}`;
}

/** The /memory groups in order: the tree buckets of the entry types, then arcs, then notes. */
const MEMORY_GROUPS: readonly { label: string; has: (t: MemoryRow['type']) => boolean }[] = [
  ...ENTRY_TYPES.map((t) => ({ label: ENTRY_TYPE_INFO[t].bucket, has: (x: MemoryRow['type']) => x === t })),
  { label: 'Arcs', has: (x) => x === 'arc' },
  { label: 'Notes', has: (x) => x === 'note' },
];

/** What a /memory listing is of: the whole Compendium, one entry type, the notes or the arcs. */
const listWhat = (type: EntryType | 'note' | 'arc' | undefined): string =>
  type === undefined ? 'the Compendium of this path' : type === 'note' ? 'notes on this path' : type === 'arc' ? 'arcs on this path' : `${type} entries on this path`;

/**
 * /memory and /memory list [type|note|arc] [--retired] (D-161): the entries (memoryList, retired ones
 * included: they are counted, and shown with `retired`) grouped by tree bucket, one line each, with
 * the handles the engine gives them; a retired one dimmed. `entryOf`: a note's or an arc's entry (its
 * text, its keys).
 */
export function renderMemoryList(
  rows: readonly MemoryRow[],
  opts: { type?: EntryType | 'note' | 'arc'; retired?: boolean },
  style: Style,
  entryOf: (key: string) => CEntry | undefined = () => undefined,
): string {
  const live = rows.filter((r) => !r.retired).length;
  const retired = rows.length - live;
  if (rows.length === 0) {
    return opts.type === undefined
      ? 'nothing in the Compendium on this path yet: /memory new <type> [name] files an entry, /memory add <title> | <keys> | <text> writes a note'
      : `no ${listWhat(opts.type)}`;
  }
  const shown = opts.retired ? rows : rows.filter((r) => !r.retired);
  const more = retired === 0 ? '' : opts.retired ? `, ${retired} retired` : `, ${retired} retired (/memory list${opts.type ? ` ${opts.type}` : ''} --retired shows them)`;
  const what = listWhat(opts.type);
  const lines = [`${what[0]!.toUpperCase()}${what.slice(1)}: ${live} live${more}${shown.length > 0 ? ' · /memory show <ref> prints one' : ''}`];
  const width = Math.max(0, ...shown.map((r) => r.ref.length));
  for (const g of MEMORY_GROUPS) {
    const mine = shown.filter((r) => g.has(r.type));
    if (mine.length === 0) continue;
    lines.push(`${g.label} (${mine.length})`);
    for (const r of mine) {
      const line = `  ${r.ref.padEnd(width)} ${memoryRowText(r, entryOf(r.key))}`;
      lines.push(r.retired ? style.dim(line) : line);
    }
  }
  return lines.join('\n');
}

/** M5b (D-181): the journal row behind an entry's creation or last change, as /memory show names it. */
export interface RowOrigin {
  by: 'filing' | 'historian' | 'user';
  /** The row's task key (`file:<id>`, `hist:<from>-<to>`); null for a person's row. */
  key: string | null;
  /** The message it is bound to: `#n` on the active path, else its id; null when it has none. */
  at: string | null;
}

/** What repl.ts reads from the journal for /memory show: the rows that created and last changed the entry, the summary's range as `#n`. */
export interface EntryProvenance {
  created?: RowOrigin;
  last?: RowOrigin;
  range?: [string, string];
}

const AGENT_NAME: Readonly<Record<string, string>> = { filing: 'the filing agent', historian: 'the historian' };

/** `the filing agent from #7 (file:<id>)`. */
const agentRow = (o: RowOrigin): string => `${AGENT_NAME[o.by] ?? o.by}${o.at !== null ? ` from ${o.at}` : ''}${o.key !== null ? ` (${o.key})` : ''}`;

/** ` by the historian from #9 (hist:…)` for an agent row, '' for a person's (or an unknown) one. */
const changedBy = (o: RowOrigin | undefined): string => (o !== undefined && o.by !== 'user' ? ` by ${agentRow(o)}` : '');

/**
 * /memory show <ref> of a typed entry or an arc (D-161): who it is, where it came from (origin, the
 * row that created it, the last row that changed it, the overlay, a retirement, former names), then
 * its full render as read_lore gives it. M5b (D-181): `prov` names the agent behind those rows
 * (`filed by the filing agent from #7 (file:<id>)`) and the summary's range by position.
 */
export function renderEntryCard(ref: string, e: CEntry, render: string, prov: EntryProvenance = {}): string {
  const kind = e.type ?? (e.arc !== undefined ? 'arc' : 'note');
  const lines = [`${ref} ${shownName(kind, e.name)} · ${kind} · ${e.key}`];
  if (e.aliases.length > 0) lines.push(`  aka: ${e.aliases.join(', ')}`);
  if (e.origin.kind === 'library') {
    const overlay = e.origin.overlay ? '; changed in this session (an overlay: the book file stays as it is)' : '';
    lines.push(`  origin: the library book ${e.origin.book}, entry ${e.origin.id}${overlay}`);
    if (e.prov.lastSeq > 0) lines.push(`  last changed at journal row ${e.prov.lastSeq}${changedBy(prov.last)}`);
  } else {
    const made = prov.created;
    const how =
      e.prov.created === null
        ? `written by you at journal row ${e.prov.createdSeq}`
        : made !== undefined && made.by !== 'user'
          ? `filed by ${agentRow(made)} at journal row ${e.prov.createdSeq}`
          : `filed on message ${e.prov.created} at journal row ${e.prov.createdSeq}`;
    lines.push(`  origin: this session, ${how}${e.prov.lastSeq !== e.prov.createdSeq ? `; last changed at row ${e.prov.lastSeq}${changedBy(prov.last)}` : ''}`);
  }
  if (e.range) lines.push(`  covers messages ${(prov.range ?? e.range)[0]} … ${(prov.range ?? e.range)[1]}`);
  if (e.keys.length > 0) lines.push(`  keys: ${e.keys.join(', ')}`);
  if (e.prov.formerNames && e.prov.formerNames.length > 0) lines.push(`  former names: ${e.prov.formerNames.join(', ')}`);
  if (e.featured) lines.push('  featured');
  if (e.retired) lines.push(`  retired${e.retired.reason ? `: ${e.retired.reason}` : ''} (out of the story; /memory restore ${ref} brings it back)`);
  lines.push('');
  for (const l of render.split('\n')) lines.push(l === '' ? '' : `  ${l}`);
  return lines.join('\n');
}

/** At most this many entries are named on one /memory tree line; the rest are counted. */
const TREE_NAMED = 8;

/**
 * /memory tree (D-165): each tree indented, every node with the count of entries on it and below and
 * the handles and names of its own entries; a node that is one entry (a place with its sub-places)
 * is that entry. `sessionFirst`: the first tree is the session's (no book was asked for).
 */
export function renderMemoryTree(trees: readonly TreeNode[], rows: readonly MemoryRow[], sessionFirst: boolean): string {
  if (trees.every((t) => entryCountOf(t) === 0) && (sessionFirst ? trees.length <= 1 : trees.length === 0)) {
    return 'nothing in the Compendium on this path yet: /memory new <type> [name] files an entry';
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const named = (r: MemoryRow): string => `${r.ref} ${shownName(r.type, r.name)}`;
  const lines: string[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    const indent = '  '.repeat(depth);
    const own = node.entryIds.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
    const count = entryCountOf(node);
    if (own.length === 1 && node.entryIds.length === 1 && own[0]!.name === node.label) {
      lines.push(`${indent}${named(own[0]!)}${count > 1 ? ` · ${count}` : ''}`);
    } else {
      const list = own.slice(0, TREE_NAMED).map(named).join(', ') + (own.length > TREE_NAMED ? `, … ${own.length - TREE_NAMED} more` : '');
      lines.push(`${indent}${node.label} · ${count}${list !== '' ? `: ${list}` : ''}`);
    }
    for (const c of node.children) walk(c, depth + 1);
  };
  trees.forEach((root, i) => {
    let where = '';
    if (sessionFirst && i === 0) where = ' (this session)';
    else {
      const first = [...allKeys(root)].map((k) => byKey.get(k)).find((r) => r !== undefined && r.origin !== 'session');
      if (first && first.origin !== 'session') where = ` (lib: ${first.origin.book})`;
    }
    lines.push(`${root.label}${where} · ${entryCountOf(root)}`);
    for (const c of root.children) walk(c, 1);
  });
  return lines.join('\n');
}

/** Every entry key of a tree. */
function* allKeys(node: TreeNode): Generator<string> {
  yield* node.entryIds;
  for (const c of node.children) yield* allKeys(c);
}

/**
 * The trace's cut rows split by why (placeBlock keeps one list): a candidate that came after the block
 * already held the profile's maxEntries is over the entry limit, any other did not fit the budget. The
 * picks are the candidates in placeBlock's order, so the injected count before each cut row tells.
 */
export function splitCompendiumCut(c: CompendiumTrace): { limit: number; overLimit: CompendiumTrace['cut']; budget: CompendiumTrace['cut'] } {
  const limit = COMPENDIUM_LIMITS[c.profile].maxEntries;
  const injected = new Set(c.injected.map((x) => x.ref));
  const cutOf = new Map(c.cut.map((x) => [x.ref, x]));
  const overLimit: CompendiumTrace['cut'] = [];
  const seen = new Set<string>();
  let placed = 0;
  for (const p of c.picks) {
    if (seen.has(p.ref)) continue;
    seen.add(p.ref);
    if (injected.has(p.ref)) placed++;
    else if (placed >= limit && cutOf.has(p.ref)) overLimit.push(cutOf.get(p.ref)!);
  }
  const over = new Set(overLimit.map((x) => x.ref));
  return { limit, overLimit, budget: c.cut.filter((x) => !over.has(x.ref)) };
}

/**
 * /trace (D-155, D-161): what the Compendium block did, on one line — the profile, the picks with
 * their tier, what went in (full or brief, tokens), what the entry limit and what the budget cut, what
 * was already in the prompt, what freshness hid. `names`: entry key → its name now (the trace keeps no texts).
 */
export function compendiumTraceLine(c: CompendiumTrace, names?: ReadonlyMap<string, string>): string {
  const keyOf = new Map(c.picks.map((p) => [p.ref, p.key]));
  const who = (ref: string, key = keyOf.get(ref)): string => {
    const n = key !== undefined ? names?.get(key) : undefined;
    return n !== undefined ? `${ref} "${n}"` : ref;
  };
  const parts: string[] = [c.profile];
  if (c.picks.length === 0) parts.push('nothing picked');
  else {
    parts.push(`picked ${c.picks.length}: ${c.picks.map((p) => `${who(p.ref, p.key)} (${p.via})`).join(', ')}`);
    parts.push(c.injected.length === 0 ? 'nothing injected' : `injected ${c.injected.length}: ${c.injected.map((x) => `${who(x.ref)} ${x.mode} ${x.tok} tok`).join(', ')}`);
  }
  const cut = splitCompendiumCut(c);
  const rows = (xs: CompendiumTrace['cut']): string => xs.map((x) => `${who(x.ref)} ${x.tok} tok`).join(', ');
  if (cut.overLimit.length > 0) parts.push(`over the entry limit (${c.profile}: ${cut.limit}) ${cut.overLimit.length}: ${rows(cut.overLimit)}`);
  if (cut.budget.length > 0) parts.push(`cut by the budget ${cut.budget.length}: ${rows(cut.budget)}`);
  if (c.repeated.length > 0) parts.push(`already in the prompt ${c.repeated.length}`);
  if (c.hidden > 0) parts.push(`${c.hidden} hidden by freshness`);
  if (c.injected.length > 0) parts.push(`block ${c.budget.block} tok`);
  return `  compendium: ${parts.join(' · ')}`;
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

// ---- the Story Director (M4, D-113) ------------------------------------------------------------------

/** What /director show prints: the setting, and the fold of the path at the head (directorAt). */
export interface DirectorShow {
  enabled: boolean;
  /** The Director's binding (roles.director, or the narrator's when it follows). */
  binding: { conn: string; model: string; follows: boolean };
  profile: string;
  style: string;
  state: DirectorState;
  /** The accepted record the state came from; absent before the first Director turn. */
  record?: DirectorRecord;
  /** The reply that carries `record`. */
  from?: string;
  /** Unreadable records skipped on the way (directorAt's `invalid`). */
  invalid: number;
  /**
   * When `record` sent no directive (a failed plan): the last one the narrator got before it on this
   * path, the nearest record above `from` that planned one, and its reply.
   */
  sentBefore?: { turn: number; from: string; directive: NarratorDirective };
}

const quoted = (s: string, max = 60): string => `"${gist(s, max)}"`;

/** Seeds and hidden arcs are due SURFACE_TURNS[horizon] turns after they began (what the planner is told). */
const dueAfter = (h: Horizon | undefined): number => (h !== undefined ? SURFACE_TURNS[h] : undefined) ?? SURFACE_TURNS.medium;

/** The record's outcome: planned, reused (from a reply), failed (code). */
function recordResult(r: DirectorRecord, style: Style): string {
  if (!r.ok) return style.yellow(`failed (${r.code ?? 'unknown'})`);
  return r.reusedFrom !== undefined ? `reused (the plan of ${r.reusedFrom})` : 'planned';
}

/**
 * /director show (D-113): the setting, then the Director's state at the head — the last turn and how it
 * went, the chapter, the live arcs (status, priority, horizon, age, next beat), the unpaid seeds (age
 * against their horizon, OVERDUE past it; ripe for payoff by the momentum rule), the live hidden arcs,
 * the intentions and the last directive in full, the block the narrator got (renderDirective), dim.
 * Ages count from the state's own turn. Finished items are only counted. "The Director has not
 * planned yet." before its first turn on this path.
 */
export function renderDirector(d: DirectorShow, style: Style): string {
  const lines: string[] = [];
  const label = (s: string): string => style.dim(s);
  const binding = `${d.binding.conn}:${d.binding.model}${d.binding.follows ? " (the narrator's model)" : ''}`;
  if (d.enabled) lines.push(style.bold(`director on · ${binding} · profile ${d.profile} · style ${d.style}`));
  else lines.push(`${style.bold('director off')} ${style.dim('(/director on lets it plan every reply; the plan below is kept meanwhile)')}`);
  if (d.invalid > 0) lines.push(style.dim(`(${plural(d.invalid, 'unreadable Director record')} on this path skipped)`));
  const r = d.record;
  if (!r) {
    lines.push('The Director has not planned yet.');
    return lines.join('\n');
  }
  const s = d.state;
  const turn = s.turn;
  const how = [r.transport, r.profile, r.model].filter((x): x is string => typeof x === 'string' && x !== '');
  if (r.skipped.length > 0) how.push(`${r.skipped.length} skipped`);
  lines.push(`${label('turn')} ${turn} · ${recordResult(r, style)}${d.from ? ` ${label(`on ${d.from}`)}` : ''}${how.length > 0 ? ` ${label(`· ${how.join(' · ')}`)}` : ''}`);

  const current = s.currentChapterId === undefined ? undefined : s.chapters.find((c) => c.id === s.currentChapterId);
  const completed = s.chapters.filter((c) => c !== current && c.status === 'complete').length;
  const done = completed > 0 ? ` ${label(`· ${completed} completed`)}` : '';
  // "2 live, 1 finished", "none".
  const counted = (live: number, liveWord: string, done: number, doneWord: string): string =>
    live + done === 0 ? 'none' : [live > 0 ? `${live} ${liveWord}` : '', done > 0 ? `${done} ${doneWord}` : ''].filter(Boolean).join(', ');
  lines.push(
    current
      ? `${label('chapter')} ${current.number} ${quoted(current.title)} · ${current.status} · ${plural(ageOf(turn, current.createdAtTurn), 'turn')}${done}`
      : `${label('chapter')} none yet${done}`,
  );

  const arcs = s.arcs.filter((a) => !isFinishedArc(a));
  const arcsDone = s.arcs.length - arcs.length;
  lines.push(`${label('arcs:')} ${counted(arcs.length, 'live', arcsDone, 'finished')}`);
  for (const a of arcs) {
    const parts = [`${a.id} ${quoted(a.title)}`, a.status, a.priority, a.horizon, `age ${ageOf(turn, a.createdAtTurn)}`];
    const still = ageOf(turn, a.lastProgressTurn ?? a.createdAtTurn);
    if (still >= MOMENTUM.arcStale) parts.push(style.yellow(`stale: ${still} turns without progress`));
    lines.push(`  ${parts.join(' · ')}`);
    const b = a.nextBeat;
    if (b?.status === 'pending') lines.push(`    ${label('next:')} ${gist(b.description, Infinity)}${typeof b.targetTurn === 'number' ? ` ${label(`(by turn ${b.targetTurn})`)}` : ''}`);
    else if (b?.status === 'delivered') lines.push(`    ${label(`next beat delivered${b.deliveredAtTurn !== undefined ? ` on turn ${b.deliveredAtTurn}` : ''}`)}`);
    else if (b?.status === 'abandoned') lines.push(`    ${label('next beat abandoned')}`);
    else lines.push(`    ${label('no next beat')}`);
  }

  const seeds = s.seeds.filter((x) => !x.payoffDelivered);
  const paid = s.seeds.length - seeds.length;
  lines.push(`${label('seeds:')} ${counted(seeds.length, 'waiting', paid, 'paid off')}`);
  const ripe = MOMENTUM.seedRipe;
  for (const x of seeds) {
    const age = ageOf(turn, x.plantedAtTurn);
    const due = dueAfter(x.payoffHorizon);
    const parts = [`${x.id} ${quoted(x.hint)}`, x.payoffHorizon, `age ${age}/${due}${age >= due ? ` ${style.yellow('OVERDUE')}` : ''}`, plural(x.reinforcements.length, 'reinforcement')];
    if (age >= ripe.age && x.reinforcements.length >= ripe.reinforcements) parts.push(style.yellow('ripe for payoff'));
    lines.push(`  ${parts.join(' · ')}`);
  }

  const hidden = s.invisibleArcs.filter((h) => !isFinishedHidden(h));
  const surfaced = s.invisibleArcs.length - hidden.length;
  lines.push(`${label('hidden arcs:')} ${counted(hidden.length, 'live', surfaced, 'surfaced or resolved')}`);
  for (const h of hidden) {
    const age = ageOf(turn, h.createdAtTurn);
    const due = dueAfter(h.horizon);
    lines.push(`  ${[`${h.id} ${quoted(h.title)}`, h.status, h.arcType, `age ${age}/${due}${age >= due ? ` ${style.yellow('OVERDUE')}` : ''}`, plural(h.playerClues.length, 'clue')].join(' · ')}`);
  }

  if (s.nextIntentions.length > 0) {
    lines.push(label('intentions:'));
    for (const i of s.nextIntentions) lines.push(`  ${i.priority} · ${i.targetTurn}: ${gist(i.description, Infinity)}`);
  }

  // The last directive in full, dim, exactly as the narrator got it: renderDirective of the record's
  // directive (after enrich and the persona filter). A turn that sent none (a failed plan) shows the
  // last one sent before it on this path, or, when no record of it is on the path, the last one the
  // Director wrote (the state keeps it as authored: before enrich and the filter).
  const block = (head: string, directive: NarratorDirective): void => {
    const text = renderDirective(directive);
    if (text === '') lines.push(label(`${head}: empty (the narrator got no Director block)`));
    else lines.push(label(`${head}:`), ...text.split('\n').map(label));
  };
  if (r.ok && r.directive) block(`last directive (turn ${r.turn}${r.reusedFrom !== undefined ? `, reused from ${r.reusedFrom}` : ''}, as sent)`, r.directive);
  else if (d.sentBefore) block(`last directive (turn ${d.sentBefore.turn}, as sent on ${d.sentBefore.from}; turn ${r.turn} sent none)`, d.sentBefore.directive);
  else if (s.lastDirective) block(`last directive (turn ${s.lastDirective.turn}, as the Director wrote it; turn ${r.turn} sent none)`, s.lastDirective.directive);
  else lines.push(label('no directive yet'));
  return lines.join('\n');
}

// ---- the Compendium's background lane (M5b, D-181) -------------------------------------------------------

type MemoryEvent = Extract<Event, { type: 'memory' }>;
type AgentEvent = Extract<Event, { type: 'agent' }>;

/** What the lane's lines need from the session: positions, handles, the job rows, the attempt limit. */
export interface LaneWords {
  /** `#n` for a message on the active path (its /show number), else its id. */
  at(id: string): string;
  /** An entry's C<n> on this path now; undefined when it is gone (an undone entry). */
  handle(key: string): string | undefined;
  /** The job row a job id names (its task key, message and attempt), or undefined. */
  job(id: string): { key: string; on: string; attempt: number } | undefined;
  /** compendium.maxAttempts of the session. */
  readonly maxAttempts: number;
}

/** A lane task as the lines name it, from its key: `filing #7`, `historian #2–#7`. */
export function passName(key: string, words: Pick<LaneWords, 'at'>): string {
  if (key.startsWith('file:')) return `filing ${words.at(key.slice('file:'.length))}`;
  if (key.startsWith('hist:')) {
    const [from, to] = key.slice('hist:'.length).split('-');
    if (from && to) return `historian ${words.at(from)}–${words.at(to)}`;
  }
  return key;
}

/** A lane task key in an engine text: `file:<id>`, `hist:<first id>-<last id>`. */
const LANE_KEY = String.raw`(?:file:[A-Za-z0-9_]+|hist:[A-Za-z0-9_#]+-[A-Za-z0-9_]+)`;

/**
 * The lead's ruling K: task keys in an engine text (a verb's refusal, a lane notice) named as the lane
 * lines name them — `the filing task file:<id>` → `filing #3`, a bare `hist:<a>-<b>` → `historian #1–#7`.
 */
export function laneKeysInWords(text: string, words: Pick<LaneWords, 'at'>): string {
  return text
    .replace(new RegExp(String.raw`\b(?:filing|historian) task (${LANE_KEY})\b`, 'g'), (_, key: string) => passName(key, words))
    .replace(new RegExp(String.raw`\b${LANE_KEY}\b`, 'g'), (key) => passName(key, words));
}

/** The agent a task key belongs to: `file:…` the filing agent's, `hist:…` the historian's. */
export const taskOfKey = (key: string): 'file' | 'hist' => (key.startsWith('hist:') ? 'hist' : 'file');

/** Why a task asked for by name waits instead of running (the lead's ruling I: its agent is off). */
const HELD_WHY: Readonly<Record<'file' | 'hist', string>> = {
  file: 'the filing agent is off for this session (compendium.filing.enabled)',
  hist: 'the historian is off for this session (compendium.historian.interval is 0)',
};

/** One task a verb asked for that waits for its agent: `filing #3 waits: the filing agent is off … ; it runs once the agent is on`. */
export function laneHeldLine(key: string, words: Pick<LaneWords, 'at'>): string {
  return `${passName(key, words)} waits: ${HELD_WHY[taskOfKey(key)]}; it runs once the agent is on`;
}

/** At most this many entries are named on one lane line; the rest are counted. */
const LANE_NAMED = 8;

/** Each entry of a pass's memory events once, in the order it was first changed, with its last change. */
function lastChanges(changes: readonly MemoryEvent[]): MemoryEvent[] {
  const last = new Map<string, MemoryEvent>();
  for (const c of changes) last.set(c.ref, c);
  return [...last.values()];
}

/**
 * Entries as a lane line names them: `C12 "Фрол", C3 "Серый маяк"`; an arc as `C4 [Arc] "<plot>"` (beside
 * its plot's own entry); a gone entry by its kind; at most LANE_NAMED, the rest counted.
 */
function laneEntries(changes: readonly MemoryEvent[], words: Pick<LaneWords, 'handle'>): { n: number; text: string } {
  const items = changes.map((c) => {
    const handle = words.handle(c.ref);
    const name = JSON.stringify(c.name);
    if (handle === undefined) return `${c.kind} ${name}`;
    return c.kind === 'arc' ? `${handle} [Arc] ${name}` : `${handle} ${name}`;
  });
  const text = items.length > LANE_NAMED ? `${items.slice(0, LANE_NAMED).join(', ')}, … ${items.length - LANE_NAMED} more` : items.join(', ');
  return { n: items.length, text };
}

/**
 * One lane pass that ended, as the REPL prints it between turns (dim): `⋯ memory: filing #7 → +2: C12
 * "Фрол", C3 "Серый маяк"` (`changes`: the memory events the pass published before its end; what a
 * re-run took back of the key's earlier row follows as `· −1: character "Старый"`), `→ nothing to file`,
 * a preemption, a failure with its attempt, a parked task with the way out. null for the statuses that
 * say nothing (queued, started, a superseded run's skipped) and for a no_room failure (its parked line
 * follows at once and says why).
 */
export function laneAgentLine(ev: AgentEvent, changes: readonly MemoryEvent[], words: LaneWords): string | null {
  const job = ev.job !== undefined ? words.job(ev.job) : undefined;
  const who = job ? passName(job.key, words) : ev.agent;
  switch (ev.status) {
    case 'done': {
      const skipped = (ev.skipped ?? 0) > 0 ? ` · ${ev.skipped} skipped` : '';
      const last = lastChanges(changes);
      const made = laneEntries(last.filter((c) => c.change !== 'reverted'), words);
      const gone = laneEntries(last.filter((c) => c.change === 'reverted'), words);
      const parts = [made.n > 0 ? `+${made.n}: ${made.text}` : '', gone.n > 0 ? `−${gone.n}: ${gone.text}` : ''].filter(Boolean);
      if (parts.length > 0) return `⋯ memory: ${who} → ${parts.join(' · ')}${skipped}`;
      const none = (ev.count ?? 0) > 0 ? 'nothing new' : ev.agent === 'historian' ? 'nothing to record' : 'nothing to file';
      return `⋯ memory: ${who} → ${none}${skipped}`;
    }
    case 'preempted':
      return `⋯ memory: ${who} gave way to a turn; it runs again at the next pause`;
    case 'failed':
      if (ev.code === 'no_room') return null;
      return `⋯ memory: ${who} failed [${ev.code ?? 'unknown'}]${job ? ` (attempt ${job.attempt} of ${words.maxAttempts})` : ''}`;
    case 'parked': {
      const retry = `/memory retry${job ? ` ${words.at(job.on)}` : ''} runs it again`;
      if (ev.code === 'no_room') return `⋯ memory: ${who} parked: it does not fit the recorder's window [no_room]; ${retry}`;
      return `⋯ memory: ${who} parked after ${plural(words.maxAttempts, 'failed attempt')}: ${retry}`;
    }
    default:
      return null;
  }
}

/** /memory undo's reverted entries (memory{reverted, by:'user'}), one line: `⋯ memory: undo → −2: C16 "Фрол", event "Лодка с солью"`. */
export function laneUndoneLine(changes: readonly MemoryEvent[], words: Pick<LaneWords, 'handle'>): string {
  const e = laneEntries(lastChanges(changes), words);
  return `⋯ memory: undo → −${e.n}: ${e.text}`;
}

const attemptText = (n: number): string => (n > 1 ? ` (attempt ${n})` : '');

/**
 * What a /memory retry that queued nothing did (ruling K): it resumed the agents the circuit breaker paused
 * (`was`: the status's `blocked` before it; a recorder with no route hides which).
 */
export function laneResumedWords(was: MemoryStatus['blocked']): string {
  if (was?.reason !== 'paused') return 'the paused agents run again';
  if (was.agent === 'both') return 'the filing agent and the historian run again (they were paused)';
  return `${was.agent === 'filing' ? 'the filing agent' : 'the historian'} runs again (it was paused)`;
}

/** Why the lane cannot start a task (ruling K: no recorder route, an agent paused), one status line. */
const blockedLine = (b: NonNullable<MemoryStatus['blocked']>): string => `  ${b.reason === 'paused' ? 'paused' : 'blocked'}: ${b.message}`;

/**
 * /memory status (D-180): what runs (and whether it still waits for a place on the server), what waits in
 * order, what waits for its agent (held), what is parked and how to retry it, the backlog; and (ruling K)
 * what stops the lane: a recorder with no route, an agent paused after two parked tasks in a row. M5c
 * (ruling H): the recall prefetch for the next reply, queued, running or ready (with its picks).
 */
export function renderLaneStatus(s: MemoryStatus, words: Pick<LaneWords, 'at'> & Partial<Pick<RecallWords, 'entry'>>): string {
  const held = s.held ?? [];
  // M5c (ruling H): the recall prefetch is a slot of the lane, counted with what runs or waits.
  const pre = s.prefetch;
  const running = (s.running ? 1 : 0) + (pre?.state === 'running' ? 1 : 0);
  const queued = s.queued.length + (pre?.state === 'queued' ? 1 : 0);
  const counts = [
    running > 0 ? `${running} running` : '',
    queued > 0 ? `${queued} queued` : '',
    held.length > 0 ? `${held.length} held` : '',
    s.parked.length > 0 ? `${s.parked.length} parked` : '',
  ].filter(Boolean);
  const backlog = s.backlog > 0 ? ` · ${plural(s.backlog, 'answer')} not filed yet` : '';
  const blocked = s.blocked ? [blockedLine(s.blocked)] : [];
  const recall = pre !== undefined ? [prefetchStatusLine(pre, words)] : [];
  if (counts.length === 0) return [`the Compendium's background lane is idle: nothing queued, nothing parked${backlog}`, ...blocked, ...recall].join('\n');
  const lines = [`the Compendium's background lane: ${counts.join(', ')}${backlog}`, ...blocked, ...recall];
  if (s.running) {
    const waiting = s.running.waiting ? ' · waiting for a place on the server' : '';
    lines.push(`  running: ${passName(s.running.key, words)}${attemptText(s.running.attempt)} · job ${s.running.job}${waiting}`);
  }
  if (s.queued.length > 0) lines.push(`  queued: ${s.queued.map((q) => `${passName(q.key, words)}${attemptText(q.attempt)}`).join(', ')}`);
  for (const h of held) lines.push(`  held: ${passName(h.key, words)}: ${HELD_WHY[h.task]}`);
  for (const p of s.parked) {
    const why = p.code === 'no_room' ? ": it does not fit the recorder's window [no_room]" : ` after ${plural(p.failures, 'failed attempt')}`;
    lines.push(`  parked: ${passName(p.key, words)}${why} (/memory retry ${words.at(p.on)} runs it again)`);
  }
  return lines.join('\n');
}

/**
 * /memory wait's last line: idle (`: nothing to do` when no pass ended while it waited), what is parked
 * and not filed; a lane that cannot run (queued, no recorder model; ruling K: an agent paused); or still
 * working after `sec` (M5c: the recall prefetch among what runs or waits).
 */
export function renderLaneWait(r: MemoryStatus & { idle: boolean }, ran: boolean, sec: number | undefined, words: Pick<LaneWords, 'at'>): string {
  if (r.idle && r.queued.length > 0) {
    if (r.blocked?.reason === 'paused') return `the background lane cannot run: ${plural(r.queued.length, 'task')} queued. ${r.blocked.message}`;
    return `the background lane cannot run: ${plural(r.queued.length, 'task')} queued and the recorder has no model to run on (/model recorder <connection:model>)`;
  }
  if (r.idle) {
    const parked = r.parked.length > 0 ? ` · ${r.parked.length} parked (/memory retry runs ${r.parked.length === 1 ? 'it' : 'them'} again)` : '';
    const n = r.held?.length ?? 0;
    const held = n > 0 ? ` · ${n} held (${n === 1 ? 'its agent is' : 'their agents are'} off: /memory status)` : '';
    const backlog = r.backlog > 0 ? ` · ${plural(r.backlog, 'answer')} not filed yet` : '';
    return `the background lane is idle${ran ? '' : ': nothing to do'}${parked}${held}${backlog}`;
  }
  const pre = r.prefetch;
  const queued = r.queued.length + (pre?.state === 'queued' ? 1 : 0);
  const what = [
    r.running ? `${passName(r.running.key, words)} runs` : '',
    pre?.state === 'running' ? `the recall prefetch after ${words.at(pre.on)} runs` : '',
    queued > 0 ? `${queued} queued` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${sec !== undefined ? `still working after ${sec} s` : 'still working'}${what !== '' ? `: ${what}` : ''} (/memory status)`;
}

// ---- recall (M5c, D-206) ------------------------------------------------------------------------------------

/** What the recall lines need from the session: `#n` of a message, an entry's handle and name now. */
export interface RecallWords {
  /** `#n` for a message on the active path (its /show number), else its id. */
  at(id: string): string;
  /** An entry's C<n> and name on this path now (retired ones too); undefined when it is not on this path. */
  entry(key: string): { ref: string; name: string } | undefined;
}

/** At most this many picks are named on one line; the rest are counted. */
const RECALL_NAMED = 8;

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** An entry recall picked as the lines name it, `C9 "Переправа к маяку"`; its key when it is not on this path now. */
function pickName(key: string, words: Partial<Pick<RecallWords, 'entry'>>): string {
  const e = words.entry?.(key);
  return e !== undefined ? `${e.ref} ${JSON.stringify(e.name)}` : `${key} (not on this path now)`;
}

/** Picks on one line, in recall's order: at most RECALL_NAMED named, the rest counted. */
function picksText(keys: readonly string[], words: Partial<Pick<RecallWords, 'entry'>>): string {
  const named = keys.slice(0, RECALL_NAMED).map((k) => pickName(k, words));
  return keys.length > RECALL_NAMED ? `${named.join(', ')}, … ${keys.length - RECALL_NAMED} more` : named.join(', ');
}

/** Why a record holds no picks, by its code. */
const RECALL_CODE_WORDS: Readonly<Record<NonNullable<RecallRecord['code']>, string>> = {
  timeout: 'recall did not answer within its deadline',
  provider_error: 'the server failed',
  no_output: 'the answer was empty',
  undecodable: 'its answer could not be read',
  transport_unsupported: 'the server refused the structured request',
  aborted: 'it was stopped',
  no_connection: "the recall model's connection is not available",
  prefetch_missed: 'the prefetch was not ready when the reply started',
  empty_index: 'there was no entry to pick from (every one named recently, hidden or in the recap)',
  no_room: "the request does not fit the recall model's window",
};

/**
 * How a record came to its answer: `sync` (beside the Director), `prefetch after #21` (computed in the
 * background after that answer, adopted or missed), `reused from #17` (a swipe or continue); '' for a
 * skip the turn decided before any call.
 */
function recallHow(rec: RecallRecord, words: Pick<RecallWords, 'at'>): string {
  if (rec.source === 'reused') return rec.reusedFrom !== undefined ? `reused from ${words.at(rec.reusedFrom)}` : 'reused';
  if (rec.basis !== undefined) return `prefetch after ${words.at(rec.basis)}`;
  if (rec.source === 'prefetch') return 'prefetch';
  return rec.source === 'sync' || rec.status === 'failed' ? 'sync' : '';
}

/** A record's outcome in a few words: `recalled 2`, `nothing picked`, `failed [timeout]`, `missed`, `skipped [no_room]`. */
function recallResult(rec: RecallRecord): string {
  switch (rec.status) {
    case 'recalled':
      return `recalled ${rec.picks.length}`;
    case 'empty':
      return 'nothing picked';
    case 'failed':
      return `failed [${rec.code ?? 'unknown'}]`;
    case 'skipped':
      return rec.code === 'prefetch_missed' ? 'missed [prefetch_missed]' : `skipped [${rec.code ?? 'unknown'}]`;
  }
}

/** The reading's counts that are not zero: `1 unknown, 1 repeated, 2 by name`. */
function readCounts(rec: RecallRecord): string[] {
  const out: string[] = [];
  if (rec.unknown > 0) out.push(`${rec.unknown} unknown`);
  if (rec.repeated > 0) out.push(`${rec.repeated} repeated`);
  if (rec.trimmed > 0) out.push(`${rec.trimmed} over the limit`);
  if (rec.byName > 0) out.push(`${rec.byName} by name`);
  if (rec.salvaged > 0) out.push(`${rec.salvaged} salvaged from prose`);
  return out;
}

/**
 * /memory recall (D-206): an answer's RecallRecord — how it came (sync, a prefetch after #n, reused from
 * #n), what it did, the profile, model and transport; the picks in recall's order with their C<n>, name
 * and reason; what the reading counted; its calls, time and tokens. `at`: the answer as /show numbers it.
 */
export function renderRecallCard(at: string, rec: RecallRecord, words: RecallWords): string {
  const head = [recallHow(rec, words), recallResult(rec), rec.profile, rec.model ?? '', rec.transport ?? ''].filter(Boolean);
  const lines = [`recall for ${at}: ${head.join(' · ')}`];
  if (rec.status === 'failed' || rec.status === 'skipped') {
    const why = rec.code !== undefined ? RECALL_CODE_WORDS[rec.code] : 'recall gave nothing';
    lines.push(`  ${why}: the selector picked alone (lexical)`);
  } else if (rec.picks.length === 0) {
    lines.push('  picks: none (recall answered with an empty list)');
  } else {
    lines.push(`  picks, in recall's order:`);
    rec.picks.forEach((p, i) => lines.push(`    ${i + 1}. ${pickName(p.ref, words)}${p.reason !== undefined ? ` — ${p.reason}` : ''}`));
  }
  const read = readCounts(rec);
  if (rec.omitted > 0) read.push(`${plural(rec.omitted, 'entry', 'entries')} left out of the index (its budget)`);
  if (read.length > 0) lines.push(`  read: ${read.join(', ')}`);
  if (rec.source === 'reused') {
    lines.push(`  0 calls: the picks of ${rec.reusedFrom !== undefined ? words.at(rec.reusedFrom) : 'the answer it replaced'}`);
  } else {
    // A prefetch reads the story up to the answer it followed, never the player's message: true whether
    // it ended before that message came or the reply waited for it (graceSec).
    const where = rec.basis !== undefined && rec.calls > 0 ? " in the background, without the player's message" : '';
    const time = rec.ms !== undefined ? ` · ${secs(rec.ms)}` : '';
    const tokens = rec.usage !== undefined ? ` · ${rec.usage.input} in / ${rec.usage.output} out tokens` : '';
    lines.push(`  ${plural(rec.calls, 'call')}${where}${time}${tokens}`);
  }
  return lines.join('\n');
}

/**
 * /trace's recall line (D-206): how the record came, what it picked (named), the calls — the turn's own
 * recall rows of `trace.calls` (sync, the top-up's included), or for an adopted prefetch none in the
 * turn and the prefetch's own from its record. Without a record: `lexical` or `off` (trace.compendium's
 * source). null when the request had no Compendium input and no record.
 */
export function recallTraceLine(tr: Trace, rec: RecallRecord | null, words: RecallWords): string | null {
  if (rec === null) {
    const source = tr.compendium?.source;
    if (source === undefined) return null;
    if (source === 'off') return '  recall: off (no recall call)';
    if (source === 'lexical') return '  recall: lexical (no recall call; the selector picked alone)';
    return `  recall: ${source}`;
  }
  const parts: string[] = [];
  const how = recallHow(rec, words);
  if (how !== '') parts.push(how);
  if (rec.status === 'recalled') parts.push(`${rec.picks.length} picked: ${picksText(rec.picks.map((p) => p.ref), words)}`);
  else parts.push(rec.status === 'empty' ? 'nothing picked' : `${recallResult(rec)} → lexical`);
  const rows = tr.calls.filter((c) => c.agent === 'recall');
  if (rows.length > 0) parts.push(`${plural(rows.length, 'call')} ${secs(rows.reduce((n, c) => n + c.ms, 0))}`);
  else if (rec.basis !== undefined && rec.calls > 0) parts.push(`0 calls in this turn (the prefetch: ${plural(rec.calls, 'call')}${rec.ms !== undefined ? ` ${secs(rec.ms)}` : ''})`);
  else parts.push('0 calls');
  return `  recall: ${parts.join(' · ')}`;
}

/**
 * The lane's line for a recall prefetch that ended (D-206, shown between turns like the memory lines):
 * `⋯ recall: prefetched after #21 → 2: C9 "Переправа к маяку", C6 "Серый маяк"`, a failure, a run that
 * gave way to a turn. `pre`: MemoryStatus.prefetch as the event arrived (it names the answer and holds
 * the record); without it the line counts. null for the statuses that say nothing (queued, started, a
 * superseded run's skip).
 * `now` (the lead's ruling K): what the line is shown into — whether the lane still owes a prefetch on
 * the same basis (`again`), and where the answer it followed stands (`answer`: the last answer on the
 * path, earlier on it, or off it: a swipe, a regen or a rewind replaced it). A run that gave way to a
 * turn runs again only while its basis holds; otherwise the line says it was dropped and why. Without
 * `now` it says what it always did.
 */
export function lanePrefetchLine(
  ev: AgentEvent,
  pre: MemoryStatus['prefetch'],
  words: RecallWords,
  now?: { again: boolean; answer: 'last' | 'earlier' | 'gone' },
): string | null {
  const after = pre !== undefined ? ` after ${words.at(pre.on)}` : '';
  switch (ev.status) {
    case 'done': {
      const n = ev.count ?? 0;
      if (n === 0) return `⋯ recall: prefetched${after} → nothing picked`;
      const keys = pre?.state === 'ready' ? (pre.record?.picks.map((p) => p.ref) ?? []) : [];
      return keys.length === n ? `⋯ recall: prefetched${after} → ${n}: ${picksText(keys, words)}` : `⋯ recall: prefetched${after} → ${plural(n, 'pick')}`;
    }
    case 'failed':
      return `⋯ recall: the prefetch${after} failed [${ev.code ?? 'unknown'}]`;
    case 'preempted': {
      if (now === undefined || now.again) return `⋯ recall: the prefetch${after} gave way to a turn; it runs again at the next pause`;
      const why =
        now.answer === 'gone'
          ? 'that answer was replaced (a swipe, a regen or a rewind)'
          : now.answer === 'earlier'
            ? 'the story went on past that answer'
            : 'that answer changed (a continue or an edit), so a prefetch after it starts over';
      return `⋯ recall: the prefetch${after} gave way to a turn and was dropped: ${why}`;
    }
    case 'skipped':
      return ev.code !== undefined ? `⋯ recall: the prefetch${after} was skipped [${ev.code}]` : null;
    default:
      return null;
  }
}

/** /memory status's line for the recall prefetch (ruling H): queued, running, or ready with its picks. */
function prefetchStatusLine(p: NonNullable<MemoryStatus['prefetch']>, words: Pick<RecallWords, 'at'> & Partial<Pick<RecallWords, 'entry'>>): string {
  const after = `after ${words.at(p.on)}`;
  if (p.state === 'queued') return `  recall: the prefetch ${after} is queued (it runs when nothing else does)`;
  if (p.state === 'running') return `  recall: the prefetch ${after} runs`;
  const r = p.record;
  if (r === undefined) return `  recall: the prefetch ${after} is ready for the next reply`;
  if (r.status === 'recalled') return `  recall: prefetched ${after}, ready for the next reply: ${r.picks.length} picked: ${picksText(r.picks.map((x) => x.ref), words)}`;
  if (r.status === 'empty') return `  recall: prefetched ${after}, ready for the next reply: nothing picked`;
  // A skipped prefetch is adopted as it is (the turn reads no on_miss): the next reply goes lexical.
  if (r.status === 'skipped') {
    const why = r.code !== undefined ? `: ${RECALL_CODE_WORDS[r.code]}` : '';
    return `  recall: the prefetch ${after} ${recallResult(r)}${why}; the next reply goes without recall (lexical)`;
  }
  return `  recall: the prefetch ${after} ${recallResult(r)}: the next reply falls back (compendium.recall.on_miss)`;
}

/** One agent's row of /memory profile (D-206). */
export interface ProfileRow {
  agent: 'block' | 'recall' | 'filing' | 'historian';
  /** The profile it runs; null while its window is unknown under 'auto'. */
  profile: CompendiumProfile | null;
  /** 'conn:model' it runs on. */
  model: string;
  /** Its window in tokens, null when not known yet. */
  window: number | null;
  /** Whose window decides it: "the narrator's", "the recall model's", "the recorder's". */
  whose: string;
  /** How its binding was found when it follows another role ("follows the recorder, which follows the narrator"). */
  follows?: string;
  /** What the profile means for it (recall: how many picks, how many messages it reads). */
  detail?: string;
  /** Why it does not run now (filing off, the historian off, recall lexical or off). */
  off?: string;
}

/**
 * /memory profile (D-206, §7.4.6): each agent's profile and why — `compendium.profile` set to full or
 * lite decides for every agent; auto goes by each agent's own window (lite below LITE_WINDOW): the block
 * by the narrator's, recall by its model's, filing and the historian by the recorder's.
 */
export function renderProfiles(setting: 'auto' | 'full' | 'lite', rows: readonly ProfileRow[]): string {
  const head =
    setting === 'auto'
      ? `Compendium profiles (compendium.profile auto: lite below a ${LITE_WINDOW}-token window, full from it):`
      : `Compendium profiles (compendium.profile ${setting}: every agent runs ${setting}, whatever its window):`;
  const lines = [head];
  for (const r of rows) {
    const win = r.window === null ? `${r.whose} window is not known yet` : `${r.whose} window ${r.window}`;
    const why = setting !== 'auto' ? `set (${win})` : r.window === null ? win : `${win} ${r.window < LITE_WINDOW ? '<' : '≥'} ${LITE_WINDOW}`;
    const parts = [`${r.profile ?? 'full or lite'}: ${why}`, `${r.model}${r.follows !== undefined ? ` (${r.follows})` : ''}`];
    if (r.detail !== undefined) parts.push(r.detail);
    if (r.off !== undefined) parts.push(`not running: ${r.off}`);
    lines.push(`  ${r.agent.padEnd(9)} ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

/** What /memory mode says about the session's recall mode (D-201). */
export interface RecallModeFacts {
  mode: RecallMode;
  /**
   * Where the mode comes from: this session's config (`set`: /memory mode just wrote it), RP_CORE_RECALL,
   * the --provider script that tags no line for recall (ruling K), or the default (auto).
   */
  from: 'session' | 'set' | 'env' | 'script' | 'default';
  /** The scheduler's locality of the recall model's server; null when it is not known here. */
  local: boolean | null;
  onMiss: 'auto' | 'lexical' | 'sync';
  graceSec: number;
  /** 'conn:model' recall runs on. */
  model: string;
  /** D-201: the engine's lane; a manual one never prefetches (auto on a local server and prefetch act as onMiss). Absent: auto. */
  lane?: 'auto' | 'manual';
}

/**
 * D-201 (the engine's decideRecall): what recall does for the next reply — prefetch, sync, lexical or off;
 * null while it hangs on a locality not known here. A manual lane never prefetches: a mode that would
 * acts as onMiss (auto: lexical on a local server, sync on a remote one).
 */
export function recallRunsAs(f: Pick<RecallModeFacts, 'mode' | 'local' | 'onMiss' | 'lane'>): 'prefetch' | 'sync' | 'lexical' | 'off' | null {
  if (f.mode === 'off' || f.mode === 'lexical' || f.mode === 'sync') return f.mode;
  if (f.mode === 'auto' && f.local !== true) return f.local === false ? 'sync' : null;
  if (f.lane !== 'manual') return 'prefetch';
  if (f.onMiss !== 'auto') return f.onMiss;
  return f.local === null ? null : f.local ? 'lexical' : 'sync';
}

/** What a missed prefetch falls back to, in words (onMiss; auto: lexical on a local server, sync on a remote one). */
function onMissWords(f: RecallModeFacts): string {
  const miss = f.onMiss !== 'auto' ? f.onMiss : f.local === null ? null : f.local ? 'lexical' : 'sync';
  if (miss === 'lexical') return 'the selector picks alone (lexical)';
  if (miss === 'sync') return 'recall runs beside the Director instead (sync)';
  return 'the selector picks alone on a local server, recall runs beside the Director on a remote one';
}

/** One line on what the mode does for this session. */
function recallModeEffect(f: RecallModeFacts): string {
  const sync = `recall (${f.model}) picks the entries the narrator needs beside the Director, before each reply`;
  const prefetch = `recall (${f.model}) picks in the background after each answer, while you type; a reply waits for it at most ${f.graceSec} s, then ${onMissWords(f)}`;
  // D-201: a manual lane (RP_CORE_LANE=manual) never prefetches; the mode acts as on_miss.
  const manual = (local: boolean | null): string => `no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply: ${onMissWords({ ...f, local })}`;
  switch (f.mode) {
    case 'auto':
      if (f.local === true) return f.lane === 'manual' ? `here: ${manual(true)}` : `here: prefetch (the recall model's server is local): ${prefetch}`;
      if (f.local === false) return `here: sync (the recall model's server is not local): ${sync}`;
      if (f.lane === 'manual') return `sync when the recall model's server is not local (${sync}); on a local one, ${manual(true)}`;
      return `prefetch when the recall model's server is local, else sync: ${sync}`;
    case 'sync':
      return sync;
    case 'prefetch':
      return f.lane === 'manual' ? manual(f.local) : prefetch;
    case 'lexical':
      return 'no recall call: the selector picks the entries named in the conversation and those the recent messages bring up';
    case 'off':
      return 'recall is off: no recall call, the selector alone fills the Compendium block';
  }
}

/** /memory mode (D-206): the session's recall mode, where it comes from, and what it does here. */
export function recallModeText(f: RecallModeFacts): string {
  const from =
    f.from === 'session'
      ? "this session's compendium.recall.mode"
      : f.from === 'set'
        ? 'set for this session, from the next reply'
        : f.from === 'env'
          ? 'RP_CORE_RECALL'
          : f.from === 'script'
            ? 'the --provider script tags no line "agent": "recall"'
            : 'the default';
  return [`recall mode: ${f.mode} (${from})`, `  ${recallModeEffect(f)}`].join('\n');
}
