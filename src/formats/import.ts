// Ported from Bunraku:src/formats/_shared/repair-json.ts@702d8120 and
// Bunraku:src/formats/_shared/kind-markers.ts@702d8120 (detection readings and cross-kind markers,
// via ./kind-markers.ts).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `rp-core import` and `new --card` (ARCHITECTURE.md D-72). Fixed detection order: PNG card, JSON
// card, ST preset, RoleCall Compendium export, ST world info with an entries object, bare
// character_book, else refuse with a reason. Reading tries the file as-is, then as double-encoded
// JSON, then as an export envelope. M1a imported cards only; M2 adds ST chat-completion presets
// (st-preset.ts), ST world info files and bare character_book files (st-worldinfo.ts), saved to
// library/presets and library/lorebooks; M5a adds `compendium-v1.0.0` (compendium-v1.ts, D-162),
// a library lorebook named after `lorebook.name`. RoleCall's story export (a .rolecall zip) is routed
// by `rp-core import` to the story importer before detection (D-185); here a zip, RoleCall's account
// backup and a bare story.jsonl are refused with a reason.
// CONTRACT FILE: signatures are fixed; the formats agent implements the bodies.
//
// Bunraku's registry of 29 scoring adapters is deliberately not ported: one fixed order is enough.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { CardFormatError, isCardObject, isPng, pngCardChunkKeywords, readCard } from './card.ts';
import { looksLikeCompendium, readCompendium } from './compendium-v1.ts';
import {
  foreignKindReason,
  hasCompendiumTag,
  looksLikeCharacterBook,
  looksLikeSettingsExport,
  looksLikeWorldInfo,
  readingsOf,
  notChatCompletionReason,
} from './kind-markers.ts';
import { saveToLibrary, type LibraryKind } from './library.ts';
import { isZip } from './zip.ts';
import {
  validateCharacter,
  validateLoreBook,
  validatePreset,
  type Character,
  type ImportWarning,
  type LoreBook,
  type Preset,
  type Validation,
} from './native.ts';
import { stPresetToPreset } from './st-preset.ts';
import { characterBookToLoreBook, worldInfoToLoreBook } from './st-worldinfo.ts';

export type DetectedKind = 'png_card' | 'json_card' | 'st_preset' | 'compendium' | 'st_worldinfo' | 'character_book' | 'unknown';

/** What an import produces, and the library folder it lands in (characters, presets, lorebooks). */
export type ImportedKind = 'character' | 'preset' | 'lorebook';

export type ImportResult =
  | { kind: 'character'; id: string; path: string; value: Character; warnings: ImportWarning[] }
  | { kind: 'preset'; id: string; path: string; value: Preset; warnings: ImportWarning[] }
  | { kind: 'lorebook'; id: string; path: string; value: LoreBook; warnings: ImportWarning[] };

export class ImportError extends Error {
  /**
   * wrong_kind: the file is fine but not the kind the caller asked for (opts.expect), e.g. a card
   * given to /preset. unsupported_until_m2 is M1a's and goes away with M2.
   */
  readonly code: 'unreadable' | 'unknown_format' | 'unsupported_until_m2' | 'wrong_kind';
  constructor(code: ImportError['code'], message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

/** A detection plus the JSON reading that matched (JSON kinds only) and whether it took a repair. */
interface Detection {
  kind: DetectedKind;
  reason?: string;
  reading?: unknown;
  repaired?: boolean;
}

/** RoleCall's account backup: a `.rolecall` JSON file, not the story export (D-185). */
const RC_BACKUP_REASON =
  "RoleCall's account backup (format rolecall-backup), not a story export: export the story itself from RoleCall (its .rolecall zip) and import that";
/** RoleCall's story.jsonl on its own (the zip holds the same data; D-185). */
const RC_JSONL_REASON = "RoleCall's story.jsonl on its own is not imported: import the .rolecall export it came from (the zip holds the same story)";

/** The first line of a JSONL file, parsed, when it is RoleCall's story manifest line. */
function isStoryJsonl(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
  const line = head.split('\n', 1)[0] ?? '';
  try {
    const v = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line) as unknown;
    return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'manifest' && (v as { format?: unknown }).format === 'rolecall-story';
  } catch {
    return false;
  }
}

function detectFull(bytes: Uint8Array): Detection {
  // `rp-core import` never gets here with a ZIP: it takes a story export and refuses any other ZIP
  // itself (cli/import-story.ts storyArchive); this reason is for the other callers (new --card, /preset…).
  if (isZip(bytes)) return { kind: 'unknown', reason: 'a ZIP archive; the only archive rp-core imports is a RoleCall story export (.rolecall), with `rp-core import <file>`' };
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
    return { kind: 'unknown', reason: isStoryJsonl(bytes) ? RC_JSONL_REASON : 'neither a PNG nor JSON' };
  }
  if (typeof parsed === 'object' && parsed !== null && (parsed as { format?: unknown }).format === 'rolecall-backup') return { kind: 'unknown', reason: RC_BACKUP_REASON };
  // The honest reading wins; repairs are tried only when it is not recognised as anything.
  const readings = readingsOf(parsed);
  for (const [i, reading] of readings.entries()) {
    const found = (kind: DetectedKind): Detection => ({ kind, reading, repaired: i > 0 });
    if (isCardObject(reading)) return found('json_card');
    if (looksLikeSettingsExport(reading)) {
      // Instruct and context templates, text-completion presets (NovelAI and friends carry
      // `temperature` too) and request bodies are settings-shaped, but not a chat-completion preset.
      const refused = notChatCompletionReason(reading);
      if (refused) return { kind: 'unknown', reason: refused };
      return found('st_preset');
    }
    // Before the ST books: a Compendium's rows carry `content` like a character_book's (D-162).
    if (looksLikeCompendium(reading)) return found('compendium');
    if (looksLikeWorldInfo(reading)) return found('st_worldinfo');
    if (looksLikeCharacterBook(reading)) return found('character_book');
  }
  // Another app's record that looks card-like at the edges: say what it is (D-72).
  for (const reading of readings) {
    const foreign = foreignKindReason(reading);
    if (foreign) return { kind: 'unknown', reason: foreign };
    if (hasCompendiumTag(reading)) {
      return { kind: 'unknown', reason: 'a RoleCall Compendium export without a lorebook object and an entries list; nothing to import' };
    }
  }
  return { kind: 'unknown', reason: 'JSON that is not a character card, SillyTavern preset, world info or character_book' };
}

/** Detection result with the reason a file was refused, for the error message. */
export function detect(bytes: Uint8Array): { kind: DetectedKind; reason?: string } {
  const d = detectFull(bytes);
  return d.reason !== undefined ? { kind: d.kind, reason: d.reason } : { kind: d.kind };
}

export function detectKind(bytes: Uint8Array, filename: string): DetectedKind {
  void filename; // detection is by content; the name may lie
  return detect(bytes).kind;
}

/** What each detected kind imports as. */
const PRODUCES: Record<Exclude<DetectedKind, 'unknown'>, ImportedKind> = {
  png_card: 'character',
  json_card: 'character',
  st_preset: 'preset',
  compendium: 'lorebook',
  st_worldinfo: 'lorebook',
  character_book: 'lorebook',
};

const KIND_LABEL: Record<Exclude<DetectedKind, 'unknown'>, string> = {
  png_card: 'a PNG character card',
  json_card: 'a character card',
  st_preset: 'a SillyTavern preset',
  compendium: 'a RoleCall Compendium export',
  st_worldinfo: 'a SillyTavern world info file',
  character_book: 'a character_book lorebook',
};

const EXPECT_LABEL: Record<ImportedKind, string> = {
  character: 'a character card',
  preset: 'a preset',
  lorebook: 'a lorebook',
};

const REPAIRED: ImportWarning = {
  code: 'repaired_json',
  path: '$',
  message: 'the file was double-encoded or wrapped in an export envelope; unwrapped',
};

/** Self-check: an importer must never store something the loader would later reject. */
function selfCheck<T>(file: string, what: string, v: Validation<T>): void {
  if (v.ok) return;
  const first = v.errors[0];
  throw new ImportError('unreadable', `${basename(file)}: ${what} (${first?.path}: ${first?.message})`);
}

function readCardFile(bytes: Uint8Array, file: string): ReturnType<typeof readCard> {
  try {
    return readCard(bytes, basename(file));
  } catch (e) {
    if (e instanceof CardFormatError) throw new ImportError('unreadable', `${basename(file)}: ${e.message}`);
    throw e;
  }
}

function save<K extends ImportedKind>(
  home: string,
  kind: K,
  name: string,
  value: Extract<ImportResult, { kind: K }>['value'],
  warnings: ImportWarning[],
): Extract<ImportResult, { kind: K }> {
  const folder: LibraryKind = kind === 'character' ? 'characters' : kind === 'preset' ? 'presets' : 'lorebooks';
  const { id, path } = saveToLibrary(home, folder, name, value);
  return { kind, id, path, value, warnings } as Extract<ImportResult, { kind: K }>;
}

/** Card warnings that concern its embedded book (or how the file was read), for a book-only import. */
const isBookWarning = (w: ImportWarning): boolean =>
  /character_books?/.test(w.path) || w.code === 'books_merged' || w.code === 'repaired_json' || w.code === 'chunk_unreadable';

/**
 * Read a file, convert it and save it to the library. `as` overrides the library name. With
 * `expect`, a file of another kind is refused with 'wrong_kind' before anything is written — except
 * that `expect: 'lorebook'` on a card with an embedded character_book imports that book (named
 * after the card unless `as` is given).
 */
export function importFile(home: string, file: string, opts?: { as?: string; expect?: ImportedKind }): ImportResult {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new ImportError('unreadable', `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const base = basename(file);
  const d = detectFull(bytes);
  if (d.kind === 'unknown') throw new ImportError('unknown_format', `${base}: ${d.reason ?? 'unrecognised file'}`);
  const produced = PRODUCES[d.kind];
  const expect = opts?.expect;
  const bookFromCard = expect === 'lorebook' && produced === 'character';
  if (expect !== undefined && expect !== produced && !bookFromCard) {
    throw new ImportError('wrong_kind', `${base}: expected ${EXPECT_LABEL[expect]}, but this is ${KIND_LABEL[d.kind]}`);
  }
  const as = opts?.as?.trim() || undefined;
  // Formats without a name field (ST presets, world info) are named after the file, as ST does.
  const stem = basename(file, extname(file)).trim() || base;
  const pre = d.repaired ? [REPAIRED] : [];

  switch (d.kind) {
    case 'png_card':
    case 'json_card': {
      const card = readCardFile(bytes, file);
      if (bookFromCard) {
        const book = card.value.book;
        if (!book) throw new ImportError('wrong_kind', `${base}: expected a lorebook, but this character card has no embedded lorebook`);
        selfCheck(file, 'the embedded book maps to an invalid lorebook', validateLoreBook(book));
        return save(home, 'lorebook', as ?? card.value.name, book, card.warnings.filter(isBookWarning));
      }
      selfCheck(file, 'card maps to an invalid character', validateCharacter(card.value));
      return save(home, 'character', as ?? card.value.name, card.value, card.warnings);
    }
    case 'st_preset': {
      const r = stPresetToPreset(d.reading, stem);
      selfCheck(file, 'preset maps to an invalid preset', validatePreset(r.value));
      return save(home, 'preset', as ?? r.value.name, r.value, [...pre, ...r.warnings]);
    }
    case 'compendium': {
      // Named after `--as`, else `lorebook.name`, else the stem without RoleCall's `.compendium` (D-162).
      const r = readCompendium(d.reading, { fallbackName: stem.replace(/\.compendium$/iu, '').trim() || stem, ...(as !== undefined ? { name: as } : {}) });
      if (r.refused !== undefined) throw new ImportError('unreadable', `${base}: ${r.refused}`);
      selfCheck(file, 'compendium maps to an invalid lorebook', validateLoreBook(r.value));
      return save(home, 'lorebook', r.value.name, r.value, [...pre, ...r.warnings]);
    }
    case 'st_worldinfo':
    case 'character_book': {
      const r = d.kind === 'st_worldinfo' ? worldInfoToLoreBook(d.reading, stem) : characterBookToLoreBook(d.reading, stem);
      selfCheck(file, 'book maps to an invalid lorebook', validateLoreBook(r.value));
      return save(home, 'lorebook', as ?? r.value.name, r.value, [...pre, ...r.warnings]);
    }
  }
}

/** importFile for a character card: the only kind `new --card` accepts. */
export function importCard(home: string, file: string, opts?: { as?: string }): Extract<ImportResult, { kind: 'character' }> {
  const r = importFile(home, file, { ...(opts?.as !== undefined ? { as: opts.as } : {}), expect: 'character' });
  if (r.kind !== 'character') throw new ImportError('wrong_kind', `${basename(file)}: not a character card (it is a ${r.kind})`);
  return r;
}
