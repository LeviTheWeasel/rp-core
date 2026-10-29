// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { BoxRenderable, StyledText, TextRenderable, type KeyEvent } from '@opentui/core';
import { listLibrary } from '../../formats/library.ts';
import { currentConfig } from '../../session/fold.ts';
import { readSessionFile } from '../../session/log.ts';
import { fitLine, flatText } from './agents-pane.ts';
import { chunk } from './sgr.ts';
import type { Theme, Ui } from './types.ts';

interface Item { id: string; name: string }

/** Read the current settings from the journal so an /open or a slash command is reflected on F8. */
export function storySettings(home: string, sessionId: string): { preset: string; lorebooks: string[] } {
  const { header, entries } = readSessionFile(home, sessionId);
  const config = currentConfig(header, entries);
  return { preset: config.preset, lorebooks: [...config.lorebooks] };
}

/** A two-tab editor. Selection applies through the REPL's /preset and /lore commands. */
export function createSettingsPicker(ui: Ui, theme: Theme, home: string, sessionId: () => string | null, command: (line: string) => void) {
  const box = new BoxRenderable(ui.renderer, {
    id: 'settings-picker', position: 'absolute', top: 1, left: 1, right: 1, bottom: 2,
    zIndex: 101, border: true, title: ' Story settings ', borderColor: theme.focusedBorder,
    titleColor: theme.text, backgroundColor: theme.background, flexDirection: 'column', paddingX: 1, visible: false,
  });
  const body = new TextRenderable(ui.renderer, { id: 'settings-picker-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1 });
  box.add(body);
  ui.middle.add(box);
  let tab: 'preset' | 'lore' = 'preset';
  let query = '';
  let selected = 0;
  let presets: Item[] = [];
  let books: Item[] = [];
  let current = { preset: 'builtin', lorebooks: [] as string[] };
  let chosen: string[] = [];
  let drawnWidth = -1;
  let drawnHeight = -1;
  const items = (): Item[] => {
    const all = tab === 'preset' ? presets : books;
    const needle = query.toLocaleLowerCase();
    return needle ? all.filter((r) => `${r.name} ${r.id}`.toLocaleLowerCase().includes(needle)) : all;
  };
  const draw = (): void => {
    drawnWidth = box.width; drawnHeight = box.height;
    const width = Math.max(12, box.width - 4);
    const height = Math.max(1, box.height - 3);
    const rows: { text: string; tone: 'text' | 'accent' | 'dim' | 'yellow'; bold?: boolean }[] = [
      { text: `Story settings · ${tab === 'preset' ? '[Preset]  Lorebooks' : 'Preset  [Lorebooks]'} · search: ${query || 'type to filter'}`, tone: 'accent', bold: true },
      { text: tab === 'preset' ? '←/→ section · ↑/↓ select · Enter use · Esc close' : '←/→ section · ↑/↓ select · Space toggle · Enter apply · Esc close', tone: 'dim' },
      { text: `Preset: ${current.preset} · Lorebooks: ${current.lorebooks.length}${tab === 'lore' ? ` → ${chosen.length} selected` : ''}`, tone: 'dim' },
    ];
    if (tab === 'lore') rows.push({ text: 'Books with the same name replace one another.', tone: 'dim' });
    const visible = items();
    if (!visible.length) rows.push({ text: query ? 'No matching items' : tab === 'lore' ? 'No lorebooks in the library' : 'No presets', tone: 'yellow' });
    visible.forEach((item, i) => {
      const mark = tab === 'preset' ? (item.id === current.preset ? '●' : '○') : (chosen.includes(item.id) ? '[x]' : '[ ]');
      rows.push({ text: `${i === selected ? '›' : ' '} ${mark} ${item.name} · ${item.id}`, tone: i === selected ? 'accent' : 'text', bold: i === selected });
    });
    const marker = (tab === 'lore' ? 4 : 3) + selected;
    const start = Math.max(0, Math.min(Math.max(0, rows.length - height), marker - Math.floor(height / 2)));
    body.content = new StyledText(rows.slice(start, start + height).flatMap((row, i) => [
      chunk(fitLine([{ text: flatText(row.text), tone: 'text' }], width).map((s) => s.text).join(''), theme, { fg: row.tone === 'dim' ? theme.text : theme[row.tone], dim: row.tone === 'dim', bold: row.bold }),
      ...(i < Math.min(height, rows.length - start) - 1 ? [chunk('\n', theme)] : []),
    ]));
  };
  const onFrame = (): void => { if (box.visible && (box.width !== drawnWidth || box.height !== drawnHeight)) draw(); };
  ui.renderer.on('frame', onFrame);
  const close = (): void => { box.visible = false; ui.input.focus(); };
  const open = (): void => {
    if (box.visible) return close();
    const id = sessionId();
    if (!id) return;
    current = storySettings(home, id);
    const libraryPresets = listLibrary(home, 'presets');
    presets = [{ id: 'builtin', name: 'Builtin' }, ...libraryPresets.filter((r) => r.id !== 'builtin')];
    if (!presets.some((r) => r.id === current.preset)) presets.push({ id: current.preset, name: '(missing preset)' });
    books = listLibrary(home, 'lorebooks');
    for (const id of current.lorebooks) if (!books.some((r) => r.id === id)) books.push({ id, name: '(missing lorebook)' });
    chosen = [...current.lorebooks]; tab = 'preset'; query = ''; selected = 0;
    box.visible = true; draw();
  };
  const switchTab = (next: 'preset' | 'lore'): void => { tab = next; query = ''; selected = 0; draw(); };
  const toggle = (item: Item): void => {
    if (chosen.includes(item.id)) chosen = chosen.filter((id) => id !== item.id);
    else {
      // /lore add keeps one book per name; reflect that rule before Apply.
      chosen = chosen.filter((id) => books.find((b) => b.id === id)?.name !== item.name);
      chosen.push(item.id);
    }
    draw();
  };
  const applyLore = (): void => {
    const remove = current.lorebooks.filter((id) => !chosen.includes(id));
    const add = chosen.filter((id) => !current.lorebooks.includes(id));
    close();
    for (const id of remove) command(`/lore rm ${id}`);
    for (const id of add) command(`/lore add ${id}`);
  };
  const handle = (key: KeyEvent): boolean => {
    if (!box.visible) return false;
    key.preventDefault();
    if (key.name === 'escape') close();
    else if (key.name === 'left') switchTab('preset');
    else if (key.name === 'right') switchTab('lore');
    else if (key.name === 'up') { selected = Math.max(0, selected - 1); draw(); }
    else if (key.name === 'down') { selected = Math.min(Math.max(0, items().length - 1), selected + 1); draw(); }
    else if (key.name === 'return' || key.name === 'kpenter') {
      if (tab === 'lore') applyLore();
      else { const item = items()[selected]; if (item) { close(); command(`/preset ${item.id}`); } }
    } else if (key.name === 'space' && tab === 'lore') { const item = items()[selected]; if (item) toggle(item); }
    else if (key.name === 'backspace') { query = [...query].slice(0, -1).join(''); selected = 0; draw(); }
    else if (key.name === 'space' || (!key.ctrl && !key.meta && [...key.name].length === 1)) { query += key.name === 'space' ? ' ' : key.name; selected = 0; draw(); }
    return true;
  };
  return { open, handle, dispose(): void { close(); ui.renderer.off('frame', onFrame); }, get visible() { return box.visible; } };
}
