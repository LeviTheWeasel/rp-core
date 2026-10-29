// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { BoxRenderable, StyledText, TextRenderable, type KeyEvent } from '@opentui/core';
import { listLibrary } from '../../formats/library.ts';
import type { Persona } from '../../formats/native.ts';
import { fitLine, flatText } from './agents-pane.ts';
import { chunk } from './sgr.ts';
import type { Theme, Ui } from './types.ts';

type Row = { kind: 'name' | 'description' | 'library'; id?: string; name: string };

/** Choose a library persona, or put an editable command into the chat input. */
export function createPersonaPicker(ui: Ui, theme: Theme, home: string, current: () => Persona | undefined, choose: (id: string) => void, edit: (field: 'name' | 'description') => void) {
  const box = new BoxRenderable(ui.renderer, {
    id: 'persona-picker', position: 'absolute', top: 1, left: 1, right: 1, bottom: 2,
    zIndex: 101, border: true, title: ' Persona ', borderColor: theme.focusedBorder,
    titleColor: theme.text, backgroundColor: theme.background, flexDirection: 'column', paddingX: 1, visible: false,
  });
  const body = new TextRenderable(ui.renderer, { id: 'persona-picker-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1 });
  box.add(body);
  ui.middle.add(box);
  let library: { id: string; name: string }[] = [];
  let query = '';
  let selected = 0;
  let drawnWidth = -1;
  let drawnHeight = -1;
  const rows = (): Row[] => {
    const all: Row[] = [
      { kind: 'name', name: 'Edit name…' },
      { kind: 'description', name: 'Edit description…' },
      ...library.map((r) => ({ kind: 'library' as const, id: r.id, name: r.name })),
    ];
    const needle = query.toLocaleLowerCase();
    return needle ? all.filter((r) => `${r.name} ${r.id ?? ''}`.toLocaleLowerCase().includes(needle)) : all;
  };
  const draw = (): void => {
    drawnWidth = box.width; drawnHeight = box.height;
    const width = Math.max(12, box.width - 4);
    const height = Math.max(1, box.height - 3);
    const p = current();
    const lines: { text: string; tone: 'text' | 'accent' | 'dim' | 'yellow'; bold?: boolean }[] = [
      { text: `Current: ${p?.name || '(none)'} · search: ${query || 'type to filter'}`, tone: 'accent', bold: true },
      { text: '↑/↓ select · Enter choose/edit · Esc close', tone: 'dim' },
      { text: `Description: ${p?.description || '(empty)'}`, tone: 'dim' },
    ];
    const items = rows();
    if (!items.length) lines.push({ text: 'No matching personas', tone: 'yellow' });
    items.forEach((row, i) => lines.push({ text: `${i === selected ? '›' : ' '} ${row.name}${row.id ? ` · ${row.id}` : ''}`, tone: i === selected ? 'accent' : 'text', bold: i === selected }));
    const marker = 3 + selected;
    const start = Math.max(0, Math.min(Math.max(0, lines.length - height), marker - Math.floor(height / 2)));
    body.content = new StyledText(lines.slice(start, start + height).flatMap((row, i) => [
      chunk(fitLine([{ text: flatText(row.text), tone: 'text' }], width).map((s) => s.text).join(''), theme, { fg: row.tone === 'dim' ? theme.text : theme[row.tone], dim: row.tone === 'dim', bold: row.bold }),
      ...(i < Math.min(height, lines.length - start) - 1 ? [chunk('\n', theme)] : []),
    ]));
  };
  const onFrame = (): void => { if (box.visible && (box.width !== drawnWidth || box.height !== drawnHeight)) draw(); };
  ui.renderer.on('frame', onFrame);
  const close = (): void => { box.visible = false; ui.input.focus(); };
  const open = (): void => {
    if (box.visible) return close();
    library = listLibrary(home, 'personas'); query = ''; selected = 0;
    box.visible = true; draw();
  };
  const handle = (key: KeyEvent): boolean => {
    if (!box.visible) return false;
    key.preventDefault();
    if (key.name === 'escape') close();
    else if (key.name === 'up') { selected = Math.max(0, selected - 1); draw(); }
    else if (key.name === 'down') { selected = Math.min(Math.max(0, rows().length - 1), selected + 1); draw(); }
    else if (key.name === 'return' || key.name === 'kpenter') {
      const row = rows()[selected];
      if (row) { close(); if (row.kind === 'library') choose(row.id!); else edit(row.kind); }
    } else if (key.name === 'backspace') { query = [...query].slice(0, -1).join(''); selected = 0; draw(); }
    else if (key.name === 'space' || (!key.ctrl && !key.meta && [...key.name].length === 1)) { query += key.name === 'space' ? ' ' : key.name; selected = 0; draw(); }
    return true;
  };
  return { open, handle, dispose(): void { close(); ui.renderer.off('frame', onFrame); }, get visible() { return box.visible; } };
}
