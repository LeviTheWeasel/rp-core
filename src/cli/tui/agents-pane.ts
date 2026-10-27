// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The right "Agents" pane (TUI decisions T-8): the narrator's state and its last tool calls, the
// Director's status and stored record, the M5 agents, and the usage totals at the bottom. The state is
// agents.ts; this file turns it into lines cut to the pane's width and into one StyledText per Text.
// Also the line helpers the models pane shares (Seg, fitLine, paneText). Every string on a row goes
// through the TUI's sanitiser in fitLine (T-10, T-16): names, titles, model ids, summaries and tool
// arguments come from files and models.

import { StyledText, TextRenderable, type RGBA, type TextChunk } from '@opentui/core';
import type { Event } from '../../protocol/events.ts';
import type { SessionConfig } from '../../session/entries.ts';
import type { Journal, PriceTable } from '../repl-journal.ts';
import { formatUsd } from '../repl-render.ts';
import {
  initialAgents,
  reduceAgents,
  storedFacts,
  usageTotal,
  withStored,
  type AgentsState,
  type DirectorLive,
  type NarratorPhase,
  type ToolCall,
} from './agents.ts';
import { selectionColours } from './app.ts';
import { sanitize } from './sanitize.ts';
import { chunk } from './sgr.ts';
import { LAYOUT, type AgentsPaneApi, type Theme, type Ui } from './types.ts';

// ---- lines ---------------------------------------------------------------------------------------

export type Tone = 'text' | 'bold' | 'dim' | 'yellow' | 'red' | 'accent' | 'user' | 'char';
/** A run of text in one tone; `bold` adds the attribute to a coloured tone. */
export interface Seg {
  text: string;
  tone: Tone;
  bold?: boolean;
}
export type Line = Seg[];

/** How the panes clean what they show. */
export interface PaneOptions {
  /** TERM_PROGRAM=WarpTerminal: the sanitiser also drops ZWJ, VS16 and skin-tone modifiers (T-10). */
  warp?: boolean;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** Terminal columns (Cyrillic 1, CJK and emoji 2), as OpenTUI's unicode width method counts them. */
export const textWidth = (s: string): number => Bun.stringWidth(s);
/**
 * A string as one pane row shows it: sanitised (whole escape sequences and controls gone, a tab two
 * spaces, under Warp no ZWJ / VS16 / skin tones), line breaks (also U+2028 / U+2029) a space.
 */
export const flatText = (s: string, o: PaneOptions = {}): string => sanitize(s, { warp: o.warp === true }).replace(/[\n\u2028\u2029]+/g, ' ');
const lineWidth = (l: Line): number => l.reduce((n, s) => n + textWidth(s.text), 0);

/**
 * `line` cleaned (flatText) and cut to `width` terminal columns; a cut ends in '…' (in the tone of
 * the segment it falls in) and never splits a grapheme. Never wraps.
 */
export function fitLine(line: Line, width: number, o: PaneOptions = {}): Line {
  const clean = line.map((s) => ({ ...s, text: flatText(s.text, o) }));
  if (lineWidth(clean) <= width) return clean;
  const room = Math.max(0, width - 1);
  const out: Line = [];
  let used = 0;
  for (const seg of clean) {
    const w = textWidth(seg.text);
    if (used + w <= room) {
      out.push(seg);
      used += w;
      continue;
    }
    let cut = '';
    for (const { segment } of graphemes.segment(seg.text)) {
      const gw = textWidth(segment);
      if (used + gw > room) break;
      cut += segment;
      used += gw;
    }
    out.push({ ...seg, text: `${cut.trimEnd()}…` });
    break;
  }
  return out;
}

/** `main` cut so that `suffix` (a duration) still fits after it. */
export function fitWithSuffix(main: Line, suffix: Line, width: number, o: PaneOptions = {}): Line {
  const tail = fitLine(suffix, Number.MAX_SAFE_INTEGER, o);
  const sw = lineWidth(tail);
  if (sw >= width) return fitLine([...main, ...suffix], width, o);
  return [...fitLine(main, width - sw, o), ...tail];
}

/**
 * A segment as a chunk with its colour always set (T-12): text, bold and dim in the terminal's
 * default foreground (dim is the DIM attribute), the rest from the terminal's palette. NO_COLOR (the
 * mono theme's colours are all the default foreground): yellow becomes italic and red bold.
 */
function chunkOf(seg: Seg, theme: Theme): TextChunk {
  const colour: Record<Tone, RGBA> = {
    text: theme.text,
    bold: theme.text,
    dim: theme.text,
    yellow: theme.yellow,
    red: theme.red,
    accent: theme.accent,
    user: theme.user,
    char: theme.char,
  };
  return chunk(seg.text, theme, {
    fg: colour[seg.tone],
    bold: seg.tone === 'bold' || seg.bold === true || (theme.mono && seg.tone === 'red'),
    dim: seg.tone === 'dim',
    italic: theme.mono && seg.tone === 'yellow',
  });
}

/** Lines as one StyledText (rows joined by '\n'). */
export function paneText(lines: readonly Line[], theme: Theme): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, i) => {
    if (i > 0) chunks.push(chunk('\n', theme));
    for (const seg of line) if (seg.text !== '') chunks.push(chunkOf(seg, theme));
  });
  return new StyledText(chunks);
}

/** Lines as plain text (tests, logs). */
export const linesText = (lines: readonly Line[]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');

// ---- the agents' lines ---------------------------------------------------------------------------

/** The text width inside a side box with a single border and paddingX 1 (the default before the first frame). */
export const PANE_TEXT_WIDTH = { left: LAYOUT.left - 4, right: LAYOUT.right - 4 } as const;

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const tok = (n: number): string => (n < 10_000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function heading(name: string, status: Line): Line {
  return [{ text: name, tone: 'accent', bold: true }, ...(status.length > 0 ? [{ text: ' · ', tone: 'dim' } as Seg, ...status] : [])];
}

function phaseLine(p: NarratorPhase): Line {
  switch (p.kind) {
    case 'idle':
      return [{ text: 'idle', tone: 'dim' }];
    case 'waiting':
      return [{ text: 'waiting…', tone: 'dim' }];
    case 'thinking':
      return [{ text: `thinking (${plural(p.chars, 'char')})`, tone: 'text' }];
    case 'writing':
      return [{ text: 'writing…', tone: 'text' }];
    case 'tool':
      return [{ text: 'tool ', tone: 'text' }, { text: p.name, tone: 'accent' }];
    case 'retry':
      return [{ text: `retry ${p.code}${p.attempt > 1 ? ` #${p.attempt}` : ''}`, tone: 'yellow' }];
    case 'stopped':
      return [{ text: 'stopped', tone: 'yellow' }];
    case 'failed':
      return [{ text: `failed (${p.code})`, tone: 'red' }];
  }
}

function toolRow(t: ToolCall, width: number, o: PaneOptions): Line {
  const tone: Tone = t.status === 'failed' ? 'red' : t.status === 'cancelled' ? 'dim' : 'text';
  const main: Line = [{ text: `  ${t.text}${t.status === 'running' ? ' …' : t.status === 'cancelled' ? ' (cancelled)' : ''}`, tone }];
  return t.ms !== undefined ? fitWithSuffix(main, [{ text: ` · ${secs(t.ms)}`, tone: 'dim' }], width, o) : fitLine(main, width, o);
}

function directorStatus(s: AgentsState): Line {
  const d = s.director;
  if (!d.enabled) return [{ text: 'off', tone: 'dim' }];
  const live: DirectorLive = d.live;
  const took = (ms: number | undefined): Line => (ms !== undefined ? [{ text: ` · ${secs(ms)}`, tone: 'dim' }] : []);
  switch (live.kind) {
    case 'planning':
      return [{ text: 'planning…', tone: 'accent' }];
    case 'planned':
    case 'reused':
      return [{ text: live.kind, tone: 'text' }, ...took(live.ms)];
    case 'failed':
      return [{ text: `failed (${live.code})`, tone: 'red' }, ...took(live.ms)];
    case 'skipped':
      return [{ text: 'skipped', tone: 'dim' }];
    case 'retry':
      return [{ text: `retry ${live.code}${live.attempt > 1 ? ` #${live.attempt}` : ''}`, tone: 'yellow' }];
    case 'none': {
      const f = d.facts;
      if (!f) return [{ text: 'not planned yet', tone: 'dim' }];
      if (!f.ok) return [{ text: `failed (${f.code ?? 'unknown'})`, tone: 'red' }];
      return [{ text: f.reusedFrom !== undefined ? 'reused' : 'planned', tone: 'text' }];
    }
  }
}

const AGENT_TONE: Readonly<Record<string, Tone>> = { failed: 'red', fallback: 'yellow', preempted: 'yellow', retry: 'yellow', parked: 'yellow' };

/** The pane's body: Narrator, Director, the M5 agents (usage is usageLines, at the bottom). */
export function agentsLines(s: AgentsState, width: number, o: PaneOptions = {}): Line[] {
  const lines: Line[] = [];
  const push = (l: Line): void => void lines.push(fitLine(l, width, o));
  const detail = (text: string, tone: Tone = 'dim'): void => push([{ text: `  ${text}`, tone }]);

  push(heading('Narrator', phaseLine(s.narrator.phase)));
  for (const t of s.narrator.tools) lines.push(toolRow(t, width, o));
  const last = s.narrator.last;
  if (last) {
    const a = [last.tokens !== undefined ? `${last.tokens} tok` : '', last.ms !== undefined ? secs(last.ms) : '', last.finish ?? ''].filter(Boolean);
    if (a.length > 0) push([{ text: '  last ', tone: 'dim' }, { text: a.join(' · '), tone: 'text' }]);
    const b = [last.rounds !== undefined ? plural(last.rounds, 'round') : '', last.transport ? `tools ${last.transport === 'none' ? 'off' : last.transport}` : ''].filter(Boolean);
    if (b.length > 0) detail(b.join(' · '));
  }

  lines.push([]);
  push(heading('Director', directorStatus(s)));
  const d = s.director;
  if (d.enabled) {
    const live = d.live;
    if ((live.kind === 'planned' || live.kind === 'reused') && live.summary) detail(live.summary);
    const f = d.facts;
    if (f) {
      detail([`turn ${f.turn}`, f.profile, f.transport].filter(Boolean).join(' · '));
      if (f.model) detail(f.model);
      for (const a of f.attempts.slice(-3)) {
        const text = [`${a.transport} ${a.outcome}`, secs(a.ms), a.tokens !== undefined ? `${a.tokens} tok` : ''].filter(Boolean).join(' · ');
        detail(text, a.outcome === 'ok' ? 'dim' : 'yellow');
      }
      if (f.chapter) detail(`chapter ${f.chapter.number} "${f.chapter.title}"`);
      push([
        { text: `  ${plural(f.liveArcs, 'live arc')} · `, tone: 'dim' },
        { text: `${plural(f.seedsDue, 'seed')} due`, tone: f.seedsDue > 0 ? 'yellow' : 'dim' },
      ]);
    }
  }

  for (const o of s.others) {
    lines.push([]);
    const status: Line = o.status
      ? [{ text: `${o.status}${o.count !== undefined ? ` (${o.count})` : ''}${o.code ? ` [${o.code}]` : ''}`, tone: AGENT_TONE[o.status] ?? 'text' }]
      : [];
    push(heading(cap(o.agent), status));
    const more = [o.source ?? '', o.ms !== undefined ? secs(o.ms) : '', o.reason ?? ''].filter(Boolean);
    if (more.length > 0) detail(more.join(' · '));
    if (o.memory) detail(`memory: ${o.memory}`);
  }
  return lines;
}

/** The bottom block: calls, tokens and cost over the path (pathUsage) plus this turn's usage events. */
export function usageLines(s: AgentsState, width: number, o: PaneOptions = {}): Line[] {
  const u = usageTotal(s);
  const lines: Line[] = [[{ text: 'Usage', tone: 'bold' }]];
  const push = (l: Line): void => void lines.push(fitLine(l, width, o));
  if (u.calls === 0) {
    push([{ text: '  no model calls yet', tone: 'dim' }]);
    return lines;
  }
  // Tokens only when some call reported them (as /usage does).
  const tokens = u.calls - u.noUsage > 0 ? `${tok(u.inputTokens)} in · ${tok(u.outputTokens)} out` : 'usage not reported';
  push([{ text: `  ${plural(u.calls, 'call')} · ${tokens}`, tone: 'dim' }]);
  const cost: Line = [{ text: `  cost ${u.costUsd === null ? 'unknown' : formatUsd(u.costUsd)}`, tone: 'dim' }];
  if (u.unpriced > 0 && u.costUsd !== null) cost.push({ text: ` + ${u.unpriced} unpriced`, tone: 'yellow' });
  push(cost);
  return lines;
}

// ---- the pane ------------------------------------------------------------------------------------

/** The Warp flag a pane uses when its host passes none: TERM_PROGRAM, as run.ts reads it for the transcript. */
export const paneWarp = (o: PaneOptions): boolean => o.warp ?? process.env.TERM_PROGRAM === 'WarpTerminal';

/**
 * The agents pane in `ui.right`: a body Text (grows, clipped at the bottom) and the usage Text under
 * it. Widths follow the laid-out Text (checked after each frame); before the first frame they are
 * PANE_TEXT_WIDTH.right. `o.warp`: as the transcript's (default: from TERM_PROGRAM).
 */
export function createAgentsPane(ui: Ui, theme: Theme, clock: () => Date, o: PaneOptions = {}): AgentsPaneApi {
  const opts: PaneOptions = { warp: paneWarp(o) };
  const r = ui.renderer;
  // A drag selects in the terminal's colours (T-17), never OpenTUI's own.
  const body = new TextRenderable(r, { id: 'agents-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1, flexShrink: 1, minHeight: 0, ...selectionColours(theme) });
  const usage = new TextRenderable(r, { id: 'agents-usage', content: '', fg: theme.text, wrapMode: 'none', flexShrink: 0, ...selectionColours(theme) });
  ui.right.add(body);
  ui.right.add(usage);

  let state = initialAgents();
  let sessionId: string | null = null;
  let drawnWidth = 0;
  const width = (): number => (body.width > 0 ? body.width : PANE_TEXT_WIDTH.right);
  const draw = (): void => {
    drawnWidth = width();
    body.content = paneText(agentsLines(state, drawnWidth, opts), theme);
    usage.content = paneText(usageLines(state, drawnWidth, opts), theme);
  };
  r.on('frame', () => {
    if (body.width > 0 && body.width !== drawnWidth) draw();
  });
  draw();

  return {
    event(ev: Event): void {
      if (sessionId !== null && ev.sessionId !== sessionId) return;
      const next = reduceAgents(state, ev, clock());
      if (next === state) return;
      state = next;
      draw();
    },
    refresh(j: Journal, head: string | null, config: SessionConfig, prices: PriceTable): void {
      state = withStored(state, storedFacts(j, head, config, prices));
      draw();
    },
    reset(id: string): void {
      sessionId = id;
      state = initialAgents();
      draw();
    },
  };
}
