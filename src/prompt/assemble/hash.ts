// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Content hashes for the trace (ARCHITECTURE.md §5.7): `/preview --turn` warns when the preset a
// turn was built with no longer matches. The JSON is canonical (sorted keys, undefined dropped) so
// the hash follows the content, not the key order a file happened to be written in.

import { createHash } from 'node:crypto';
import type { LoreBook, Preset } from '../../formats/native.ts';

/** JSON with object keys sorted at every level; undefined members are left out as JSON.stringify does. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const members: string[] = [];
  for (const k of Object.keys(v).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined || typeof x === 'function') continue;
    members.push(`${JSON.stringify(k)}:${canonicalJson(x)}`);
  }
  return `{${members.join(',')}}`;
}

/** First 16 hex digits of sha256(canonical JSON). */
export function shortHash(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 16);
}

/** Trace.presetHash and Generation.preset.hash. */
export function presetHash(preset: Preset): string {
  return shortHash(preset);
}

/** Trace.loreHashes[sourceKey]: the book as loaded, hashed the same way. */
export function loreBookHash(book: LoreBook): string {
  return shortHash(book);
}
