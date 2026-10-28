// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { BoxRenderable, StyledText, TextRenderable, type KeyEvent } from '@opentui/core';
import { listLibrary } from '../../formats/library.ts';
import { cmdNew } from '../commands.ts';
import { memoryChannel } from '../io.ts';
import type { Runtime } from '../runtime.ts';
import { fitLine, flatText } from './agents-pane.ts';
import { chunk } from './sgr.ts';
import type { Theme, Ui } from './types.ts';

export interface NewStoryChoice { card: string; persona?: string; preset?: string; lore: string[] }
type Stage = 'card' | 'persona' | 'preset' | 'lore';
const STAGES: readonly Stage[] = ['card', 'persona', 'preset', 'lore'];
interface Option { id: string; name: string }

/** Use the same creation path and config defaults as `rp-core new`. */
export async function createLibraryStory(rt: Runtime, choice: NewStoryChoice): Promise<string> {
  const out = memoryChannel();
  const err = memoryChannel();
  const code = await cmdNew({
    home: rt.home, card: choice.card, ...(choice.persona ? { persona: choice.persona } : {}),
    ...(choice.preset ? { preset: choice.preset } : {}), ...(choice.lore.length ? { lore: choice.lore } : {}),
    json: true, io: { out, err }, rt,
  });
  if (code !== 0) throw new Error(err.text() || `session creation failed (${code})`);
  const parsed = JSON.parse(out.text()) as { sessionId?: unknown };
  if (typeof parsed.sessionId !== 'string') throw new Error('session creation returned no id');
  return parsed.sessionId;
}

/** Four-step library picker: card, persona, preset, then any number of lorebooks. */
export function createNewStoryPicker(ui: Ui, theme: Theme, home: string, create: (choice: NewStoryChoice) => Promise<void>) {
  const box = new BoxRenderable(ui.renderer, {
    id: 'new-story-picker', position: 'absolute', top: 1, left: 1, right: 1, bottom: 2,
    zIndex: 102, border: true, title: ' New story ', borderColor: theme.focusedBorder,
    titleColor: theme.text, backgroundColor: theme.background, flexDirection: 'column', paddingX: 1, visible: false,
  });
  const body = new TextRenderable(ui.renderer, { id: 'new-story-picker-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1 });
  box.add(body);
  ui.middle.add(box);
  let stageIndex = 0;
  let query = '';
  let selected = 0;
  let choice: NewStoryChoice = { card: '', lore: [] };
  let busy = false;
  let disposed = false;
  let error = '';
  let catalog: Record<Stage, Option[]> = { card: [], persona: [], preset: [], lore: [] };
  let drawnWidth = -1;
  let drawnHeight = -1;
  const stage = (): Stage => STAGES[stageIndex]!;
  const options = (): Option[] => {
    const items = catalog[stage()];
    const rows = stage() === 'card' || stage() === 'lore' ? items : [{ id: '', name: stage() === 'persona' ? '(no persona)' : '(default preset)' }, ...items];
    if (stage() === 'preset' && !rows.some((r) => r.id === 'builtin')) rows.splice(1, 0, { id: 'builtin', name: 'Builtin' });
    const needle = query.toLocaleLowerCase();
    return needle ? rows.filter((r) => `${r.name} ${r.id}`.toLocaleLowerCase().includes(needle)) : rows;
  };
  const draw = (): void => {
    drawnWidth = box.width; drawnHeight = box.height;
    const width = Math.max(12, box.width - 4);
    const height = Math.max(1, box.height - 3);
    const label = ['Card', 'Persona', 'Preset', 'Lorebooks'][stageIndex]!;
    const rows: { text: string; tone: 'text' | 'accent' | 'dim' | 'yellow'; bold?: boolean }[] = [
      { text: `New story · ${stageIndex + 1}/4 ${label} · search: ${query || 'type to filter'}`, tone: 'accent', bold: true },
      { text: stage() === 'lore' ? '↑/↓ select · Space toggle · Enter create · ← back · Esc cancel' : '↑/↓ select · Enter next · ← back · Esc cancel', tone: 'dim' },
      { text: `Card: ${choice.card || '—'} · Persona: ${choice.persona || 'none'} · Preset: ${choice.preset || 'default'} · Lore: ${choice.lore.length}`, tone: 'dim' },
    ];
    if (busy) rows.push({ text: 'Creating session…', tone: 'yellow' });
    else {
      if (error) rows.push({ text: error, tone: 'yellow' });
      const items = options();
      if (!items.length) rows.push({ text: stage() === 'card' && !query ? 'No cards in library. Import a card first.' : 'No matching items', tone: 'yellow' });
      items.forEach((item, i) => {
        const checked = stage() === 'lore' ? (choice.lore.includes(item.id) ? '[x]' : '[ ]') : '';
        rows.push({ text: `${i === selected ? '›' : ' '} ${checked} ${item.name}${item.id ? ` · ${item.id}` : ''}`, tone: i === selected ? 'accent' : 'text', bold: i === selected });
      });
    }
    const marker = 3 + selected + (error ? 1 : 0);
    const start = Math.max(0, Math.min(Math.max(0, rows.length - height), marker - Math.floor(height / 2)));
    body.content = new StyledText(rows.slice(start, start + height).flatMap((row, i) => [
      chunk(fitLine([{ text: flatText(row.text), tone: 'text' }], width).map((s) => s.text).join(''), theme, { fg: row.tone === 'dim' ? theme.text : theme[row.tone], dim: row.tone === 'dim', bold: row.bold }),
      ...(i < Math.min(height, rows.length - start) - 1 ? [chunk('\n', theme)] : []),
    ]));
  };
  const onFrame = (): void => { if (box.visible && (box.width !== drawnWidth || box.height !== drawnHeight)) draw(); };
  ui.renderer.on('frame', onFrame);
  const close = (): void => { if (busy) return; box.visible = false; ui.input.focus(); };
  const open = (): void => {
    if (box.visible || disposed) return;
    catalog = {
      card: listLibrary(home, 'characters'), persona: listLibrary(home, 'personas'),
      preset: listLibrary(home, 'presets'), lore: listLibrary(home, 'lorebooks'),
    };
    stageIndex = 0; query = ''; selected = 0; choice = { card: '', lore: [] }; error = '';
    box.visible = true; draw();
  };
  const next = (): void => { stageIndex++; query = ''; selected = 0; error = ''; draw(); };
  const handle = (key: KeyEvent): boolean => {
    if (!box.visible) return false;
    key.preventDefault();
    if (busy) return true;
    if (key.name === 'escape') close();
    else if (key.name === 'left') { if (stageIndex > 0) { stageIndex--; query = ''; selected = 0; error = ''; draw(); } else close(); }
    else if (key.name === 'up') { selected = Math.max(0, selected - 1); draw(); }
    else if (key.name === 'down') { selected = Math.min(Math.max(0, options().length - 1), selected + 1); draw(); }
    else if (key.name === 'return' || key.name === 'kpenter') {
      if (stage() === 'lore') {
        busy = true; error = ''; draw();
        void create({ ...choice, lore: [...choice.lore] }).then(() => { busy = false; if (!disposed) close(); }).catch((e: unknown) => { busy = false; if (!disposed) { error = e instanceof Error ? e.message : String(e); draw(); } });
      } else {
        const item = options()[selected];
        if (!item) return true;
        if (stage() === 'card') choice.card = item.id;
        else if (stage() === 'persona') choice.persona = item.id || undefined;
        else choice.preset = item.id || undefined;
        next();
      }
    } else if (stage() === 'lore' && key.name === 'space') {
      const item = options()[selected];
      if (item) choice.lore = choice.lore.includes(item.id) ? choice.lore.filter((id) => id !== item.id) : [...choice.lore, item.id];
      draw();
    } else if (key.name === 'backspace') { query = [...query].slice(0, -1).join(''); selected = 0; draw(); }
    else if (key.name === 'space' || (!key.ctrl && !key.meta && [...key.name].length === 1)) { query += key.name === 'space' ? ' ' : key.name; selected = 0; draw(); }
    return true;
  };
  return { open, close, handle, dispose(): void { disposed = true; busy = false; box.visible = false; ui.renderer.off('frame', onFrame); }, get visible() { return box.visible; } };
}
