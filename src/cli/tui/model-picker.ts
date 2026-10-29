// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { BoxRenderable, StyledText, TextRenderable, type KeyEvent, type PasteEvent } from '@opentui/core';
import { listModels } from '../../providers/probe.ts';
import type { Runtime } from '../runtime.ts';
import { fitLine, flatText } from './agents-pane.ts';
import { chunk } from './sgr.ts';
import type { Theme, Ui } from './types.ts';

export interface ModelChoice { conn: string; model: string }
export interface ModelGroup { conn: string; models: string[]; note?: string }

/** Ask each configured, usable connection for its model list; one failed server does not hide the others. */
export async function modelGroups(rt: Runtime, fetcher: typeof fetch, signal: AbortSignal): Promise<ModelGroup[]> {
  return Promise.all(Object.values(rt.connections).sort((a, b) => a.id.localeCompare(b.id)).map(async (c): Promise<ModelGroup> => {
    if (!c.baseUrl) return { conn: c.id, models: [], note: 'no model catalog' };
    let key: string | null;
    try { key = c.resolveKey ? await c.resolveKey() : (c.key ?? null); }
    catch { return { conn: c.id, models: [], note: 'API key unavailable' }; }
    try {
      const found = await listModels(c.baseUrl, { fetch: fetcher, key, signal });
      if (found.notes.some((note) => note.startsWith('auth_failed:'))) return { conn: c.id, models: [], note: 'API key rejected (HTTP 401/403)' };
      const models = found.models.map((m) => m.id).filter((id) => id !== '' && !/\s|[\x00-\x1f\x7f]/.test(id));
      return { conn: c.id, models, ...(models.length ? {} : { note: 'server listed no usable models' }) };
    } catch {
      return { conn: c.id, models: [], note: 'server unavailable' };
    }
  }));
}

export function choicesOf(groups: readonly ModelGroup[]): ModelChoice[] {
  return groups.flatMap((group) => group.models.map((model) => ({ conn: group.conn, model })));
}

/** The modal owns navigation keys only while open. The REPL still performs the actual /model edit. */
export function createModelPicker(ui: Ui, theme: Theme, rt: Runtime, fetcher: typeof fetch, current: () => ModelChoice | null, choose: (choice: ModelChoice) => void, connectOpenRouter?: (key: string) => void) {
  const box = new BoxRenderable(ui.renderer, {
    id: 'model-picker', position: 'absolute', top: 1, left: 1, right: 1, bottom: 2,
    zIndex: 100, border: true, title: ' Choose narrator model ',
    borderColor: theme.focusedBorder, titleColor: theme.text,
    backgroundColor: theme.background, flexDirection: 'column', paddingX: 1, visible: false,
  });
  const body = new TextRenderable(ui.renderer, { id: 'model-picker-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1 });
  box.add(body);
  ui.middle.add(box);
  let groups: ModelGroup[] = [];
  let selected = 0;
  let query = '';
  let keyInput: string | null = null;
  let keyError = '';
  let loading = false;
  let controller: AbortController | null = null;
  let serial = 0;
  let drawnWidth = -1;
  let drawnHeight = -1;
  const matches = (conn: string, model: string): boolean => query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((part) => `${conn} ${model}`.toLocaleLowerCase().includes(part));
  const filtered = (): ModelChoice[] => choicesOf(groups).filter((c) => matches(c.conn, c.model));
  const show = (): void => {
    drawnWidth = box.width;
    drawnHeight = box.height;
    const width = Math.max(12, box.width - 4);
    const height = Math.max(1, box.height - 3);
    const rows: { text: string; tone: 'text' | 'accent' | 'dim' | 'yellow'; bold?: boolean }[] = [];
    if (keyInput !== null) {
      rows.push({ text: 'Connect OpenRouter', tone: 'accent', bold: true });
      rows.push({ text: 'Paste your API key · Enter connect · Esc cancel', tone: 'dim' });
      rows.push({ text: `API key: ${'•'.repeat(Math.min(keyInput.length, 24))}${keyInput.length > 24 ? '…' : ''}▏`, tone: 'text' });
      rows.push({ text: 'The key stays in memory for this run; it is never saved to config.toml.', tone: 'dim' });
      if (keyError) rows.push({ text: keyError, tone: 'yellow' });
    } else {
      rows.push({ text: loading ? 'Loading model catalogs… · F9 connect OpenRouter' : '↑/↓ select · Enter use · F9 connect OpenRouter · Esc close', tone: 'dim' });
      if (!loading) rows.push({ text: `Search: ${query || 'type to filter models'}`, tone: 'dim' });
      if (!loading) {
        let index = 0;
        for (const group of groups) {
          const matchingModels = group.models.filter((model) => matches(group.conn, model));
          if (query && matchingModels.length === 0) continue;
          rows.push({ text: group.conn, tone: 'accent', bold: true });
          if (matchingModels.length === 0) rows.push({ text: `  ${group.note ?? 'no models'}`, tone: 'yellow' });
          for (const model of matchingModels) {
            const active = current();
            const isCurrent = active?.conn === group.conn && active.model === model;
            rows.push({ text: `${index++ === selected ? '›' : ' '} ${model}${isCurrent ? '  (current)' : ''}`, tone: index - 1 === selected ? 'accent' : 'text', bold: index - 1 === selected });
          }
        }
        if (groups.length === 0) rows.push({ text: 'No configured connections. Press F9 to add OpenRouter.', tone: 'yellow' });
        else if (query && filtered().length === 0) rows.push({ text: 'No matching models', tone: 'yellow' });
      }
    }
    // Keep the selected model visible in a short terminal.
    const marker = rows.findIndex((r) => r.text.startsWith('› '));
    const start = Math.max(0, Math.min(rows.length - height, marker - Math.floor(height / 2)));
    const visible = rows.slice(start, start + height);
    body.content = new StyledText(visible.flatMap((row, i) => [
      chunk(fitLine([{ text: flatText(row.text), tone: 'text' }], width).map((s) => s.text).join(''), theme, { fg: row.tone === 'dim' ? theme.text : theme[row.tone], dim: row.tone === 'dim', bold: row.bold }),
      ...(i < visible.length - 1 ? [chunk('\n', theme)] : []),
    ]));
  };
  const onFrame = (): void => { if (box.visible && (box.width !== drawnWidth || box.height !== drawnHeight)) show(); };
  ui.renderer.on('frame', onFrame);
  const close = (): void => { box.visible = false; keyInput = null; keyError = ''; controller?.abort(); controller = null; serial++; ui.input.focus(); };
  const open = (): void => {
    if (box.visible) return close();
    box.visible = true;
    loading = true;
    selected = 0;
    query = '';
    show();
    const id = ++serial;
    controller = new AbortController();
    void modelGroups(rt, fetcher, controller.signal).then((next) => {
      if (id !== serial) return;
      groups = next;
      loading = false;
      const active = current();
      const at = choicesOf(groups).findIndex((choice) => choice.conn === active?.conn && choice.model === active.model);
      if (at >= 0) selected = at;
      show();
    });
  };
  const handle = (key: KeyEvent): boolean => {
    if (!box.visible) return false;
    key.preventDefault();
    if (keyInput !== null) {
      if (key.name === 'escape') { keyInput = null; keyError = ''; show(); }
      else if (key.name === 'backspace') { keyInput = [...keyInput].slice(0, -1).join(''); keyError = ''; show(); }
      else if (key.name === 'return' || key.name === 'kpenter') {
        try {
          if (!keyInput) throw new Error('Enter an API key');
          connectOpenRouter?.(keyInput);
          keyInput = null; keyError = ''; close(); open();
        } catch (e) { keyError = e instanceof Error ? e.message : 'Could not connect'; show(); }
      } else if (key.name === 'space' || (!key.ctrl && !key.meta && [...key.name].length === 1)) { keyInput += key.name === 'space' ? ' ' : key.name; show(); }
      return true;
    }
    if (key.name === 'escape') close();
    else if (key.name === 'f9' && connectOpenRouter) { keyInput = ''; keyError = ''; show(); }
    else if (key.name === 'f4') { close(); open(); }
    else if (!loading && key.name === 'up') { selected = Math.max(0, selected - 1); show(); }
    else if (!loading && key.name === 'down') { selected = Math.min(Math.max(0, filtered().length - 1), selected + 1); show(); }
    else if (!loading && (key.name === 'return' || key.name === 'kpenter')) {
      const choice = filtered()[selected];
      if (choice) { close(); choose(choice); }
    }
    else if (!loading && key.name === 'backspace') { query = [...query].slice(0, -1).join(''); selected = 0; show(); }
    else if (!loading && (key.name === 'space' || (!key.ctrl && !key.meta && [...key.name].length === 1))) { query += key.name === 'space' ? ' ' : key.name; selected = 0; show(); }
    return true;
  };
  const onPaste = (event: PasteEvent): void => {
    if (!box.visible || keyInput === null) return;
    event.preventDefault();
    keyInput += new TextDecoder().decode(event.bytes);
    keyError = ''; show();
  };
  ui.renderer.keyInput.on('paste', onPaste);
  return { open, handle, close, dispose(): void { close(); ui.renderer.off('frame', onFrame); ui.renderer.keyInput.off('paste', onPaste); }, get visible() { return box.visible; } };
}
