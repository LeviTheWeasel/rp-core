// Ported from Bunraku:src/formats/_shared/kind-markers.ts@702d8120 and
// Bunraku:src/formats/_shared/repair-json.ts@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-kind markers and shape-only JSON repairs used by card detection and `rp-core import`
// (ARCHITECTURE.md D-72). The Tavern lineage ships many artifacts that look alike at the edges:
// presets carry `name` + `extensions`, world books carry `name` + `entries`. These predicates let
// one kind refuse another kind's file. All are pure and fail closed (false / null).

import { isRecord, type Rec } from './wire.ts';

/** `{exportedAt|version, type, data}`: the wrapper several web tools write around an export. */
export function isExportEnvelope(o: unknown): o is Rec & { type: string; data: Rec } {
  return (
    isRecord(o) &&
    typeof o.type === 'string' &&
    isRecord(o.data) &&
    (typeof o.exportedAt === 'string' || typeof o.version === 'string')
  );
}

/**
 * A SillyTavern settings-family export: chat-completion preset, text-completion preset, instruct
 * or context template. Never a character or a book, whatever it bundles.
 */
export function looksLikeSettingsExport(o: unknown): boolean {
  if (!isRecord(o)) return false;
  return (
    Array.isArray(o.prompts) ||
    'prompt_order' in o ||
    'chat_completion_source' in o ||
    'temperature' in o ||
    'input_sequence' in o || // instruct template
    'story_string' in o // context template
  );
}

/** ST world info file: `entries` is a keyed OBJECT of ST-shaped entries (an array would be a character_book). */
export function looksLikeWorldInfo(o: unknown): boolean {
  if (!isRecord(o) || !isRecord(o.entries)) return false;
  const values = Object.values(o.entries);
  if (values.length === 0) return true; // an empty ST book is still a book
  const first = values[0];
  return (
    isRecord(first) &&
    ('key' in first || 'keysecondary' in first || 'content' in first || 'comment' in first || 'uid' in first)
  );
}

/**
 * Standalone CCv2/CCv3 character_book (Chub lorebook download, `lorebook_v3` export, card-extracted
 * book): `entries` is an array of objects with `keys` or `content`. Agnai MemoryBooks
 * (`keywords` + `entry`) are not this.
 */
export function looksLikeCharacterBook(o: unknown): boolean {
  const book = unwrapLorebookV3(o);
  if (!isRecord(book) || !Array.isArray(book.entries)) return false;
  const first: unknown = book.entries[0];
  if (first === undefined) return 'scan_depth' in book || 'token_budget' in book || 'name' in book;
  if (!isRecord(first)) return false;
  if (Array.isArray(first.keywords) && typeof first.entry === 'string') return false;
  return Array.isArray(first.keys) || typeof first.content === 'string';
}

/** CCv3 standalone lorebook `{spec:'lorebook_v3', data:{...}}` → its data; anything else as-is. */
export function unwrapLorebookV3(o: unknown): unknown {
  return isRecord(o) && o.spec === 'lorebook_v3' && isRecord(o.data) ? o.data : o;
}

/**
 * A whole document that is a JSON string holding more JSON (stringify applied twice). Bounded to one
 * unwrap, and only when the inner text is an object or array, so a quoted word is never "repaired".
 */
export function unwrapDoubleEncoded(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  const first = value.trimStart()[0];
  if (first !== '{' && first !== '[') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Every reading of a parsed document worth trying, honest one first: as-is, then double-encoded
 * (and an envelope inside it), then the payload of an export envelope. A healthy file is never
 * touched by a repair because the original reading always comes first.
 */
export function readingsOf(value: unknown): unknown[] {
  const out: unknown[] = [value];
  const inner = unwrapDoubleEncoded(value);
  if (inner !== null) {
    out.push(inner);
    if (isExportEnvelope(inner)) out.push(inner.data);
  }
  if (isExportEnvelope(value)) out.push(value.data);
  return out;
}

/**
 * A visual-novel project (VAUDEVILLE `vn.json`, the inside of a `.vnpack`): it carries `name` and
 * `description` like a V1 card, plus cast, scenes and a story graph. Not a character (§10.5: later).
 */
export function looksLikeVnProject(o: unknown): boolean {
  return isRecord(o) && ('cast' in o || 'scenes' in o || 'story_graph' in o || 'vn_type' in o);
}

/**
 * An Agnai native export (`kind: 'character'`, `persona` object, `greeting`, `sampleChat`): its
 * `name` + `scenario` would pass for a V1 card while its real content sits in fields a card lacks.
 * Any object typed by a string `kind` is some app's own record, never a Tavern card.
 */
export function looksLikeAgnaiExport(o: unknown): boolean {
  return isRecord(o) && typeof o.kind === 'string';
}

/** Why a JSON object is another app's record and not a character card, or null. */
export function foreignKindReason(o: unknown): string | null {
  if (looksLikeVnProject(o)) return 'this is a visual-novel project (vn.json / .vnpack), not a character card; .vnpack import comes later';
  if (looksLikeAgnaiExport(o)) {
    const kind = String((o as Rec).kind);
    return kind === 'character'
      ? 'this is an Agnai character export (kind "character"), not a Tavern character card; Agnai import is not supported'
      : `this is a "${kind}" record of another app (it has a "kind" field), not a character card`;
  }
  return null;
}
