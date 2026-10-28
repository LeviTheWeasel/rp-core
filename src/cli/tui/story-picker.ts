// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { BoxRenderable, StyledText, TextRenderable, type KeyEvent } from '@opentui/core';
import { journalOf, tailRows, type TailRow } from '../repl-journal.ts';
import { listSessions, readSessionFile, readSessionHeader } from '../../session/log.ts';
import { tails } from '../../session/tree.ts';
import { fitLine, flatText } from './agents-pane.ts';
import { chunk } from './sgr.ts';
import type { Theme, Ui } from './types.ts';

export interface StoryRow { id: string; title: string; character: string; forkFrom?: string; updated: string; depth: number }

/** Keep forks under their parent, with newest roots and siblings first. Orphans remain visible. */
export function storyRows(home: string, query = ''): StoryRow[] {
  const raw = listSessions(home).flatMap((s) => {
    try {
      const h = readSessionHeader(home, s.id);
      return [{ id: s.id, title: h.title || h.cast.character.name || s.id, character: h.cast.character.name, forkFrom: h.fork?.from, updated: s.updated }];
    } catch { return []; }
  });
  const byId = new Map(raw.map((r) => [r.id, r]));
  const children = new Map<string, typeof raw>();
  for (const r of raw) {
    const parent = r.forkFrom && r.forkFrom !== r.id && byId.has(r.forkFrom) ? r.forkFrom : '';
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const result: StoryRow[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    for (const r of children.get(id) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      result.push({ ...r, depth });
      visit(r.id, depth + 1);
    }
  };
  visit('', 0);
  for (const r of raw) if (!seen.has(r.id)) visit(r.forkFrom && byId.has(r.forkFrom) ? r.forkFrom : '', 0);
  const needle = query.toLocaleLowerCase();
  return needle ? result.filter((r) => `${r.id} ${r.title} ${r.character}`.toLocaleLowerCase().includes(needle)) : result;
}

interface BranchRow extends TailRow { active: boolean }

/** The active leaf plus alternative leaves of a selected story. */
export function branchRows(home: string, id: string): BranchRow[] {
  const { header, entries } = readSessionFile(home, id);
  const j = journalOf(header, entries);
  const head = j.tree.head;
  const pathSet = new Set<string>();
  for (let cur = head; cur !== null; cur = j.tree.msgs.get(cur)?.parent ?? null) pathSet.add(cur);
  const ids = [...(head ? [head] : []), ...tails(j.tree, pathSet)];
  return tailRows(j, ids).map((r) => ({ ...r, active: r.id === head }));
}

/** A full-pane browser. All writes still go through the REPL's /open and /goto commands. */
export function createStoryPicker(ui: Ui, theme: Theme, home: string, current: () => string | null, choose: (id: string, leaf?: string) => void, standalone = false) {
  const box = new BoxRenderable(ui.renderer, {
    id: 'story-picker', position: 'absolute', top: 1, left: 1, right: 1, bottom: 2,
    zIndex: 101, border: true, title: ' Stories and branches ', borderColor: theme.focusedBorder,
    titleColor: theme.text, backgroundColor: theme.background, flexDirection: 'column', paddingX: 1, visible: false,
  });
  const body = new TextRenderable(ui.renderer, { id: 'story-picker-body', content: '', fg: theme.text, wrapMode: 'none', flexGrow: 1 });
  box.add(body);
  ui.middle.add(box);
  let tab: 'stories' | 'branches' = 'stories';
  let query = '';
  let stories: StoryRow[] = [];
  let storyIndex = 0;
  let branches: BranchRow[] = [];
  let branchIndex = 0;
  let error = '';
  let drawnWidth = -1;
  let drawnHeight = -1;
  const selectedStory = (): StoryRow | undefined => stories[storyIndex];
  const refreshStories = (): void => {
    const id = selectedStory()?.id ?? current();
    stories = storyRows(home, query);
    storyIndex = Math.max(0, stories.findIndex((s) => s.id === id));
  };
  const refreshBranches = (): void => {
    error = '';
    try { branches = selectedStory() ? branchRows(home, selectedStory()!.id) : []; }
    catch (e) { branches = []; error = e instanceof Error ? e.message : String(e); }
    branchIndex = 0;
  };
  const draw = (): void => {
    drawnWidth = box.width; drawnHeight = box.height;
    const width = Math.max(12, box.width - 4);
    const height = Math.max(1, box.height - 3);
    const rows: { text: string; tone: 'text' | 'accent' | 'dim' | 'yellow'; bold?: boolean }[] = [];
    if (tab === 'stories') {
      rows.push({ text: `Stories  › branches  ·  search: ${query || 'type to filter'}`, tone: 'accent', bold: true });
      rows.push({ text: `↑/↓ select · Enter open · → branches · Esc ${standalone ? 'quit' : 'close'} · F5 refresh`, tone: 'dim' });
      if (!stories.length) rows.push({ text: query ? 'No matching stories' : 'No stories yet', tone: 'yellow' });
      stories.forEach((s, i) => rows.push({ text: `${i === storyIndex ? '›' : ' '} ${'  '.repeat(Math.min(5, s.depth))}${s.depth ? '↳ ' : ''}${s.title} · ${s.character} · ${s.id}${s.id === current() ? '  (current)' : ''} · ${s.updated.slice(0, 10)}`, tone: i === storyIndex ? 'accent' : 'text', bold: i === storyIndex }));
    } else {
      const story = selectedStory();
      rows.push({ text: `Stories  ›  ${story?.title ?? 'branches'}`, tone: 'accent', bold: true });
      rows.push({ text: `↑/↓ select · Enter go to branch · ← stories · Esc ${standalone ? 'quit' : 'close'}`, tone: 'dim' });
      if (error) rows.push({ text: error, tone: 'yellow' });
      else if (!branches.length) rows.push({ text: 'No messages in this story yet', tone: 'yellow' });
      branches.forEach((b, i) => rows.push({ text: `${i === branchIndex ? '›' : ' '} ${b.active ? '● current' : '○ branch'} · ${b.role === 'user' ? 'you' : 'character'} · ${b.words || b.id} · ${b.id}`, tone: i === branchIndex ? 'accent' : 'text', bold: i === branchIndex }));
    }
    const marker = 2 + (tab === 'stories' ? storyIndex : branchIndex);
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
    tab = 'stories'; query = ''; stories = []; storyIndex = 0; refreshStories();
    box.visible = true; draw();
  };
  const handle = (key: KeyEvent): boolean => {
    if (!box.visible) return false;
    key.preventDefault();
    if (key.name === 'escape') close();
    else if (key.name === 'f5') { refreshStories(); if (tab === 'branches') refreshBranches(); draw(); }
    else if (key.name === 'up') { if (tab === 'stories') storyIndex = Math.max(0, storyIndex - 1); else branchIndex = Math.max(0, branchIndex - 1); draw(); }
    else if (key.name === 'down') { if (tab === 'stories') storyIndex = Math.min(Math.max(0, stories.length - 1), storyIndex + 1); else branchIndex = Math.min(Math.max(0, branches.length - 1), branchIndex + 1); draw(); }
    else if (key.name === 'right' && tab === 'stories' && selectedStory()) { tab = 'branches'; refreshBranches(); draw(); }
    else if (key.name === 'left' && tab === 'branches') { tab = 'stories'; draw(); }
    else if (key.name === 'return' || key.name === 'kpenter') {
      const story = selectedStory();
      if (!story) return true;
      const branch = tab === 'branches' ? branches[branchIndex] : undefined;
      if (tab === 'branches' && !branch) return true;
      close(); choose(story.id, branch?.id);
    } else if (tab === 'stories' && key.name === 'backspace') { query = [...query].slice(0, -1).join(''); refreshStories(); draw(); }
    else if (tab === 'stories' && key.name === 'space') { query += ' '; refreshStories(); draw(); }
    else if (tab === 'stories' && !key.ctrl && !key.meta && [...key.name].length === 1) { query += key.name; refreshStories(); draw(); }
    return true;
  };
  return { open, handle, close, dispose(): void { close(); ui.renderer.off('frame', onFrame); }, get visible() { return box.visible; } };
}
