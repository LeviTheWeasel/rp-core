// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The text lore keys are matched against (ARCHITECTURE.md §10.3 step 3). As in SillyTavern:
// the chat messages up to the one the turn is about (greeting and history included, hidden
// messages left out), newest first, each as "Name: text" (ST's world_info_include_names, on by
// default), so a key naming a speaker fires while that speaker talks. An entry reads the newest
// `scanDepth` of them (default 2, ST's world_info_depth); recursion adds fired entries' text.
// CONTRACT FILE: signatures are fixed; the lore agent implements the bodies.
//
// Behaviour reference: SillyTavern world-info-scan-chat.js buildWorldInfoScanChat (`${name}: ${mes}`
// lines, newest first) and world-info.js WorldInfoBuffer (each trimmed, the newest `depth` joined
// with '\n').

import type { PathView } from '../session/view.ts';

/** ST's default scan depth (world_info_depth) for books and entries that name none. */
export const DEFAULT_SCAN_DEPTH = 2;

/**
 * Chat messages up to and including `upTo`, newest first, hidden ones left out, each
 * `${name}: ${text}` (the text blocks of the message joined; reasoning and tool blocks are not
 * text). Names: assistant → char, user → user.
 */
export function scanMessages(view: PathView, upTo: string, names: { char: string; user: string }): string[] {
  const last = view.path.findIndex((m) => m.id === upTo);
  if (last < 0) throw new Error(`lore: message ${upTo} is not on the active path`);
  const out: string[] = [];
  for (let i = last; i >= 0; i--) {
    const m = view.path[i] as PathView['path'][number];
    if (m.hidden) continue;
    let text = '';
    for (const b of m.blocks) if (b.k === 'text') text += b.text;
    const name = m.role === 'assistant' ? names.char : names.user;
    out.push(`${name}: ${text.trim()}`);
  }
  return out;
}

/** The scan text for one entry: the newest `depth` messages joined with '\n' (newest first, as ST joins its buffer). */
export function scanText(messages: readonly string[], depth: number): string {
  const d = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : depth > 0 ? messages.length : 0;
  return messages.slice(0, d).join('\n');
}
