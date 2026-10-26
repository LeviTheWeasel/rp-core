// Ported from Bunraku:src/formats/_shared/repair-json.ts@702d8120 and
// Bunraku:src/formats/_shared/kind-markers.ts@702d8120 (detection readings and cross-kind markers,
// via ./kind-markers.ts).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `rp-core import` and `new --card` (ARCHITECTURE.md D-72). Fixed detection order: PNG card, JSON
// card, ST preset, ST world info with an entries object, bare character_book, else refuse with a
// reason. Reading tries the file as-is, then as double-encoded JSON, then as an export envelope.
// M1a imports cards only; presets and world info arrive in M2.
// CONTRACT FILE: signatures are fixed; the formats agent implements the bodies.
//
// Bunraku's registry of 29 scoring adapters is deliberately not ported: one fixed order is enough.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CardFormatError, isCardObject, isPng, pngCardChunkKeywords, readCard } from './card.ts';
import { foreignKindReason, looksLikeCharacterBook, looksLikeSettingsExport, looksLikeWorldInfo, readingsOf } from './kind-markers.ts';
import { saveToLibrary } from './library.ts';
import { validateCharacter, type Character, type ImportWarning } from './native.ts';

export type DetectedKind = 'png_card' | 'json_card' | 'st_preset' | 'st_worldinfo' | 'character_book' | 'unknown';

export class ImportError extends Error {
  readonly code: 'unreadable' | 'unknown_format' | 'unsupported_until_m2';
  constructor(code: ImportError['code'], message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

/** Detection result with the reason a file was refused, for the error message. */
export function detect(bytes: Uint8Array): { kind: DetectedKind; reason?: string } {
  if (isPng(bytes)) {
    // A PNG is a card or nothing: no other kind travels in PNG text chunks here. A card chunk that
    // cannot be decoded still makes it a card file, so the import reports the decode error.
    const hasCard = pngCardChunkKeywords(bytes).length > 0;
    return hasCard ? { kind: 'png_card' } : { kind: 'unknown', reason: 'PNG without a character card (no ccv3 or chara chunk)' };
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8').decode(bytes);
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return { kind: 'unknown', reason: 'neither a PNG nor JSON' };
  }
  // The honest reading wins; repairs are tried only when it is not recognised as anything.
  for (const reading of readingsOf(parsed)) {
    if (isCardObject(reading)) return { kind: 'json_card' };
    if (looksLikeSettingsExport(reading)) return { kind: 'st_preset' };
    if (looksLikeWorldInfo(reading)) return { kind: 'st_worldinfo' };
    if (looksLikeCharacterBook(reading)) return { kind: 'character_book' };
  }
  // Another app's record that looks card-like at the edges: say what it is (D-72).
  for (const reading of readingsOf(parsed)) {
    const foreign = foreignKindReason(reading);
    if (foreign) return { kind: 'unknown', reason: foreign };
  }
  return { kind: 'unknown', reason: 'JSON that is not a character card, SillyTavern preset, world info or character_book' };
}

export function detectKind(bytes: Uint8Array, filename: string): DetectedKind {
  void filename; // detection is by content; the name may lie
  return detect(bytes).kind;
}

const M2_KIND: Partial<Record<DetectedKind, string>> = {
  st_preset: 'SillyTavern preset',
  st_worldinfo: 'SillyTavern world info',
  character_book: 'character_book lorebook',
};

/** Read a card file and save it to the library. `as` overrides the library name. */
export function importFile(
  home: string,
  file: string,
  opts?: { as?: string },
): { kind: 'character'; id: string; path: string; value: Character; warnings: ImportWarning[] } {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new ImportError('unreadable', `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { kind, reason } = detect(bytes);
  if (kind === 'unknown') throw new ImportError('unknown_format', `${basename(file)}: ${reason ?? 'unrecognised file'}`);
  const later = M2_KIND[kind];
  if (later) throw new ImportError('unsupported_until_m2', `${basename(file)}: ${later} import arrives in M2`);

  let card: ReturnType<typeof readCard>;
  try {
    card = readCard(bytes, basename(file));
  } catch (e) {
    if (e instanceof CardFormatError) throw new ImportError('unreadable', `${basename(file)}: ${e.message}`);
    throw e;
  }
  // Self-check: an importer must never store something the loader would later reject.
  const check = validateCharacter(card.value);
  if (!check.ok) {
    const first = check.errors[0];
    throw new ImportError('unreadable', `${basename(file)}: card maps to an invalid character (${first?.path}: ${first?.message})`);
  }
  const name = opts?.as?.trim() || card.value.name;
  const { id, path } = saveToLibrary(home, 'characters', name, card.value);
  return { kind: 'character', id, path, value: card.value, warnings: card.warnings };
}
