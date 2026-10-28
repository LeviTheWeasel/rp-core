// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { TextRenderable } from '@opentui/core';
import { guardedFetch, originOf } from '../../providers/http.ts';
import type { Trace } from '../../session/entries.ts';
import { latestTrace } from '../repl-journal.ts';
import type { BannerInfo } from '../repl-view.ts';
import type { Runtime } from '../runtime.ts';
import { fitLine, paneText, PANE_TEXT_WIDTH, paneWarp, type Line, type PaneOptions } from './agents-pane.ts';
import { selectionColours } from './app.ts';
import { windowText } from './models-pane.ts';
import type { Theme, Ui } from './types.ts';

export interface ContextFacts {
  window: number | null;
  cap?: number;
  last?: Pick<Trace, 'window' | 'reserve' | 'tokens'>;
}

export type OllamaWindow = { kind: 'loaded'; window: number } | { kind: 'not-loaded' } | { kind: 'unknown' };

/** The latest prompt made with this narrator binding on the active path, never an older model's. */
export function contextFacts(b: BannerInfo): ContextFacts {
  const facts: ContextFacts = { window: b.window, ...(b.cap !== undefined ? { cap: b.cap } : {}) };
  const path = b.session.view().path;
  for (let i = path.length - 1; i >= 0; i--) {
    const item = latestTrace(b.journal, path[i]!.id);
    if (item?.gen?.connection === b.narrator.conn && item.gen.model === b.narrator.model) {
      facts.last = item.trace;
      break;
    }
  }
  return facts;
}

const compact = (n: number): string => n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** A small fixed block below Usage. The bar is explicitly the last prompt, not a live prediction. */
export function contextLines(f: ContextFacts, ollama: OllamaWindow | null, width: number, o: PaneOptions = {}): Line[] {
  const lines: Line[] = [[{ text: 'Context', tone: 'bold' }]];
  const push = (line: Line): void => { lines.push(fitLine(line, width, o)); };
  push([{ text: `  window ${windowText(f.window, f.cap)}${f.last ? ` · reply ${windowText(f.last.reserve)}` : ''}`, tone: 'dim' }]);
  if (f.last) {
    const available = Math.max(0, f.last.window - f.last.reserve);
    const measured = f.last.tokens.reported;
    const used = measured ?? f.last.tokens.estimated;
    const ratio = available > 0 ? Math.min(1, used / available) : 1;
    const filled = used > 0 ? Math.max(1, Math.round(ratio * 10)) : 0;
    const tone = ratio >= 0.9 ? 'yellow' : 'accent';
    push([{ text: `  last ${measured === undefined ? '~' : ''}${compact(used)} / ${compact(available)}`, tone: 'dim' }]);
    push([{ text: `  ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(ratio * 100)}%`, tone }]);
  } else push([{ text: '  no prompt measured yet', tone: 'dim' }]);
  if (ollama?.kind === 'loaded') {
    const mismatch = f.window !== null && ollama.window < f.window;
    push([{ text: mismatch ? `  Ollama ${windowText(ollama.window)} loaded · too small` : `  Ollama ${windowText(ollama.window)} loaded`, tone: mismatch ? 'yellow' : 'dim' }]);
  } else if (ollama?.kind === 'not-loaded') push([{ text: '  Ollama model not loaded', tone: 'dim' }]);
  else if (ollama?.kind === 'unknown') push([{ text: '  Ollama window unknown', tone: 'dim' }]);
  return lines;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const modelKey = (name: string): string => name.endsWith(':latest') ? name.slice(0, -7) : name;

/** Read only Ollama's loaded runtime window. A failed or unexpected response never claims a size. */
export async function ollamaWindow(baseUrl: string, model: string, fetcher: typeof fetch, signal: AbortSignal): Promise<OllamaWindow> {
  const origin = originOf(baseUrl);
  const res = await guardedFetch({ url: `${origin}/api/ps`, method: 'GET', headers: {} }, { fetch: fetcher, signal, allowedOrigin: origin });
  if (!res.ok) return { kind: 'unknown' };
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.models)) return { kind: 'unknown' };
  for (const row of body.models) {
    if (!isRecord(row)) continue;
    const same = [row.name, row.model].some((v) => typeof v === 'string' && modelKey(v) === modelKey(model));
    if (!same) continue;
    return typeof row.context_length === 'number' && Number.isFinite(row.context_length) && row.context_length > 0
      ? { kind: 'loaded', window: Math.floor(row.context_length) } : { kind: 'unknown' };
  }
  return { kind: 'not-loaded' };
}

/** The right pane owns the renderable; the request is cancelled on a model switch or TUI exit. */
export function createContextPane(ui: Ui, theme: Theme, rt: Runtime, fetcher: typeof fetch, o: PaneOptions = {}) {
  const opts: PaneOptions = { warp: paneWarp(o) };
  const text = new TextRenderable(ui.renderer, { id: 'agents-context', content: '', fg: theme.text, wrapMode: 'none', flexShrink: 0, ...selectionColours(theme) });
  ui.right.add(text);
  let facts: ContextFacts = { window: null };
  let observed: OllamaWindow | null = null;
  let request: AbortController | null = null;
  let generation = 0;
  let drawnWidth = 0;
  const width = (): number => text.width > 0 ? text.width : PANE_TEXT_WIDTH.right;
  const draw = (): void => {
    drawnWidth = width();
    text.content = paneText(contextLines(facts, observed, drawnWidth, opts), theme);
  };
  const onFrame = (): void => { if (text.width > 0 && text.width !== drawnWidth) draw(); };
  ui.renderer.on('frame', onFrame);
  draw();
  const update = (b: BannerInfo): void => {
    facts = contextFacts(b);
    const id = ++generation;
    request?.abort();
    request = null;
    observed = null;
    draw();
    const conn = rt.connections[b.narrator.conn];
    if (!conn?.baseUrl || !conn.local) return;
    let isOllama = b.narrator.conn.toLowerCase().includes('ollama');
    try { isOllama ||= originOf(conn.baseUrl).endsWith(':11434'); } catch { return; }
    if (!isOllama) return;
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), 1500);
    void ollamaWindow(conn.baseUrl, b.narrator.model, fetcher, controller.signal)
      .then((value) => { if (id === generation && !text.isDestroyed) { observed = value; draw(); } })
      .catch(() => { if (id === generation && !text.isDestroyed) { observed = { kind: 'unknown' }; draw(); } })
      .finally(() => { clearTimeout(timer); if (id === generation) request = null; });
  };
  return { update, dispose(): void { generation++; request?.abort(); ui.renderer.off('frame', onFrame); } };
}
