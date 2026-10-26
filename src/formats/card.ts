// Ported from RoleCall:apps/rc/src/lib/import/png-parser.ts@fb8dc623e (dependency-free PNG chunk walk),
// Bunraku:src/formats/_shared/png.ts@702d8120 (ccv3 over chara), Bunraku:src/formats/sillytavern/index.ts@702d8120
// (detectCard and the cross-kind "firewall"), Bunraku:src/formats/_shared/tavern-fields.ts@702d8120 (field rules,
// depth_prompt) and Bunraku:src/formats/_shared/character-book-decode.ts@702d8120 (where embedded books live).
// Copyright (C) 2026 the RoleCall authors (Coneja-Chibi et al.) and Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Character cards CCv1/V2/V3 from JSON and PNG (ARCHITECTURE.md §10.5, §19.8). PNG text chunks are
// walked without dependencies (tEXt, iTXt, zTXt via node:zlib); `ccv3` wins over `chara`.
// CONTRACT FILE: signatures are fixed; the formats agent implements the bodies.
//
// Not ported: the first-found chunk (it downgrades a V3 card to its V2 backfill), `extensions` as a
// V2 marker (presets and books carry it too), png-chunk-text's iTXt crash, RoleCall's console logging.

import { basename, extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { foreignKindReason, looksLikeSettingsExport, readingsOf } from './kind-markers.ts';
import type { Character, ChatRole, Imported, LoreBook } from './native.ts';
import { characterBookAt, coerceStRole } from './st-worldinfo.ts';
import {
  compact,
  deepEq,
  isRecord,
  joinPath,
  nonBlank,
  optCount,
  optStrArray,
  uniqueIds,
  WarningSink,
  type Rec,
} from './wire.ts';

export class CardFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardFormatError';
  }
}

// ---- PNG ---------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Cap on an inflated zTXt/iTXt payload, so a compression bomb cannot take the process down. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');

/**
 * tEXt/zTXt are Latin-1 by the PNG spec, but card writers put base64 (ASCII) or raw UTF-8 JSON there.
 * Valid UTF-8 is read as UTF-8; anything else falls back to Latin-1.
 */
function decodeLoose(b: Uint8Array): string {
  try {
    return utf8Fatal.decode(b);
  } catch {
    return latin1(b);
  }
}

function inflate(b: Uint8Array): Uint8Array {
  return inflateSync(b, { maxOutputLength: MAX_TEXT_BYTES });
}

/** One tEXt / zTXt / iTXt chunk body → {keyword, text}. Throws on a malformed chunk. */
function decodeTextChunk(type: string, data: Uint8Array): { keyword: string; text: string } {
  const nul = data.indexOf(0);
  if (nul < 1 || nul > 79) throw new Error('bad keyword');
  const keyword = latin1(data.subarray(0, nul));
  const rest = data.subarray(nul + 1);
  if (type === 'tEXt') return { keyword, text: decodeLoose(rest) };
  if (type === 'zTXt') {
    if (rest[0] !== 0) throw new Error('unknown compression method');
    return { keyword, text: decodeLoose(inflate(rest.subarray(1))) };
  }
  // iTXt: compression flag, compression method, language tag \0, translated keyword \0, UTF-8 text.
  const flag = rest[0];
  const method = rest[1];
  if (flag === undefined || method === undefined) throw new Error('truncated iTXt header');
  const langEnd = rest.indexOf(0, 2);
  const transEnd = langEnd < 0 ? -1 : rest.indexOf(0, langEnd + 1);
  if (transEnd < 0) throw new Error('truncated iTXt header');
  let body = rest.subarray(transEnd + 1);
  if (flag === 1) {
    if (method !== 0) throw new Error('unknown compression method');
    body = inflate(body);
  }
  return { keyword, text: utf8Loose.decode(body) };
}

interface ChunkWalk {
  chunks: { keyword: string; text: string }[];
  /** Text chunks that exist but could not be decoded (bad zlib stream, malformed header). */
  broken: { keyword: string; reason: string }[];
}

function walkTextChunks(bytes: Uint8Array): ChunkWalk {
  if (!isPng(bytes)) throw new CardFormatError('not a PNG file (bad signature)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk: ChunkWalk = { chunks: [], broken: [] };
  let off = 8;
  // Each chunk: length(4) type(4) data(length) crc(4). CRCs are not checked: a reader that refuses a
  // card over a wrong CRC helps nobody, and the payload is validated as JSON anyway.
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = latin1(bytes.subarray(off + 4, off + 8));
    const start = off + 8;
    const end = start + len;
    if (end + 4 > bytes.length) break; // truncated file: keep what was read so far
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = bytes.subarray(start, end);
      try {
        walk.chunks.push(decodeTextChunk(type, data));
      } catch (e) {
        const nul = data.indexOf(0);
        walk.broken.push({ keyword: nul > 0 ? latin1(data.subarray(0, nul)) : '', reason: errText(e) });
      }
    }
    if (type === 'IEND') break;
    off = end + 4;
  }
  return walk;
}

/** All text chunks of a PNG, in file order. Throws CardFormatError if not a PNG. */
export function readPngTextChunks(bytes: Uint8Array): { keyword: string; text: string }[] {
  return walkTextChunks(bytes).chunks;
}

/**
 * Keywords (lowercased, file order) of the PNG's card chunks, `ccv3` and `chara`, including ones
 * that exist but could not be decoded: a card whose only chunk is corrupt is still a card file, and
 * readCard then says what is wrong with it (D-72: a refusal carries its reason).
 */
export function pngCardChunkKeywords(bytes: Uint8Array): string[] {
  const { chunks, broken } = walkTextChunks(bytes);
  return [...chunks, ...broken].map((c) => c.keyword.toLowerCase()).filter((k) => k === 'ccv3' || k === 'chara');
}

// ---- card shape detection (the "firewall") -----------------------------------------------------

export const CARD_SPEC_V2 = 'chara_card_v2';
export const CARD_SPEC_V3 = 'chara_card_v3';

type Variant = 'v3' | 'v2' | 'flat' | 'v1';
interface Detected {
  card: Rec;
  data: Rec;
  variant: Variant;
}

/** Recognise a card and pull out the object that holds its fields; null for anything else. */
function detectCard(json: unknown): Detected | null {
  if (!isRecord(json)) return null;
  if (json.spec === CARD_SPEC_V3 && isRecord(json.data)) return { card: json, data: json.data, variant: 'v3' };
  if (json.spec === CARD_SPEC_V2 && isRecord(json.data)) return { card: json, data: json.data, variant: 'v2' };
  if (json.spec !== undefined || json.data !== undefined || typeof json.name !== 'string') return null;
  // Cross-kind firewall: ST presets, templates and world books also carry `name` (+ `extensions`,
  // + even `description` on a standalone character_book), and so do other apps' records (a VN
  // project, an Agnai export). Any marker of those disqualifies.
  if ('entries' in json || looksLikeSettingsExport(json) || foreignKindReason(json) !== null) return null;
  // `extensions` is NOT a signal: presets and books carry it. A flat card must show a field only a
  // character has.
  const looksV2 =
    'alternate_greetings' in json ||
    'system_prompt' in json ||
    'post_history_instructions' in json ||
    'creator_notes' in json ||
    'character_version' in json;
  const looksV1 =
    'description' in json || 'personality' in json || 'scenario' in json || 'first_mes' in json || 'mes_example' in json;
  if (!looksV2 && !looksV1) return null;
  return { card: json, data: json, variant: looksV2 ? 'flat' : 'v1' };
}

/** True when `json` is a character card this module can map. */
export function isCardObject(json: unknown): boolean {
  return detectCard(json) !== null;
}

/** Why `json` is not a card, in words a person can act on. */
export function whyNotCard(json: unknown): string {
  if (!isRecord(json)) return 'not a JSON object';
  if (looksLikeSettingsExport(json)) return 'this is a SillyTavern preset or template, not a character card';
  if (json.spec === undefined && json.data === undefined) {
    const foreign = foreignKindReason(json);
    if (foreign) return foreign;
  }
  if ('entries' in json) return 'this is a world book / character_book, not a character card';
  if (typeof json.spec === 'string' && json.spec !== CARD_SPEC_V2 && json.spec !== CARD_SPEC_V3) {
    return `unsupported card spec "${json.spec}"`;
  }
  if (json.spec !== undefined) return 'card envelope has no data object';
  if (typeof json.name !== 'string') return 'no character name';
  return 'no character fields (description, personality, scenario, first_mes, ...)';
}

// ---- field mapping -----------------------------------------------------------------------------

/** Data fields mapped into native Character fields (an empty string maps to "absent", as in ST). */
const MAPPED = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greetings',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator',
  'tags',
  'extensions',
]);

type ActiveCheck = (v: unknown) => string | null;
const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** Card fields that would change behaviour in ST/CCv3 readers but are not honoured: warn when active. */
const CARD_NOT_HONOURED: Record<string, ActiveCheck> = {
  nickname: (v) => (nonBlank(v) ? 'CCv3 nickname is not honoured: {{char}} stays the card name' : null),
  group_only_greetings: (v) => (nonEmptyArray(v) ? 'group-only greetings are not used (no group chats)' : null),
  assets: (v) =>
    Array.isArray(v) && v.some((a) => !(isRecord(a) && a.type === 'icon' && a.uri === 'ccdefault:'))
      ? 'CCv3 assets are not used'
      : null,
};
/** Card metadata kept in extras without a warning. */
const CARD_SILENT = new Set([
  'creator_notes',
  'character_version',
  'creator_notes_multilingual',
  'source',
  'creation_date',
  'modification_date',
  'creatorcomment',
  'avatar',
  'chat',
  'create_date',
  'talkativeness',
  'fav',
  'character_book', // only left over when it was not a book; that already warned
]);
const EXT_NOT_HONOURED: Record<string, ActiveCheck> = {
  world: (v) => (nonBlank(v) ? `linked world book "${String(v)}" is not part of the card; import it separately` : null),
  regex_scripts: (v) => (nonEmptyArray(v) ? 'embedded regex scripts are not run' : null),
};
const EXT_SILENT = new Set(['talkativeness', 'fav', 'chub', 'depth_prompt']);
/** Top-level keys of a V2/V3 envelope that mirror `data` for V1 readers (ST writes them): dropped. */
const ENVELOPE_MIRROR = new Set([
  'spec',
  'spec_version',
  'data',
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'avatar',
  'chat',
  'create_date',
  'talkativeness',
  'fav',
  'creatorcomment',
  'tags',
]);

const ROLES: readonly ChatRole[] = ['system', 'user', 'assistant'];

/** extensions.depth_prompt → depthPrompt. An empty prompt means "no note" (ST writes a default). */
function readDepthPrompt(raw: unknown, path: string, sink: WarningSink): Character['depthPrompt'] | undefined {
  if (!isRecord(raw)) return undefined;
  const text = nonBlank(raw.prompt);
  if (text === undefined) return undefined;
  let role: ChatRole = 'system';
  if (raw.role !== undefined && raw.role !== null) {
    const n = coerceStRole(raw.role);
    if (n === undefined) sink.add('invalid_value', joinPath(path, 'role'), `unknown depth_prompt role ${JSON.stringify(raw.role)}; using system`);
    else role = ROLES[n] ?? 'system';
  }
  return { text, depth: optCount(raw.depth) ?? 4, role };
}

function readTags(v: unknown): string[] | undefined {
  const list = typeof v === 'string' ? v.split(',') : optStrArray(v);
  const tags = list?.map((t) => t.trim()).filter((t) => t !== '');
  return tags && tags.length > 0 ? tags : undefined;
}

/**
 * Embedded books can live in four places (CCv3 `data.character_book`, the CCv2 convention
 * `data.extensions.character_book`, RoleCall's `data.extensions.character_books` array, written
 * when a card embeds several books, and the top level of a V2/V3 envelope written by hybrid
 * exporters); identical copies collapse, the rest merge into one `book` (§19.8).
 */
function readBooks(
  places: [string, unknown, () => void][],
  charName: string,
  sink: WarningSink,
): LoreBook | undefined {
  const found: { path: string; raw: unknown }[] = [];
  for (const [path, raw, consume] of places) {
    if (raw === undefined || raw === null) {
      consume();
      continue;
    }
    if (!isRecord(raw) || !Array.isArray(raw.entries)) {
      sink.add('invalid_value', path, 'character_book is not a book (no entries list); kept in extras');
      continue;
    }
    consume();
    if (!found.some((f) => deepEq(f.raw, raw))) found.push({ path, raw });
  }
  if (found.length === 0) return undefined;
  // SillyTavern's name for an embedded book it extracts into a world (world-info.js
  // checkEmbeddedWorld / importEmbeddedWorldInfo): the same name, so a world is still read once.
  const fallback = `${charName.trim() || 'Untitled'}'s Lorebook`;
  const books = found.map((f) => {
    const r = characterBookAt(f.raw, fallback, f.path);
    sink.addAll(r.warnings);
    return r.value;
  });
  const [first, ...rest] = books;
  if (!first) return undefined;
  if (rest.length === 0) return first;
  sink.add(
    'books_merged',
    found.map((f) => f.path).join(' + '),
    `${books.length} embedded character books merged into one; book settings come from the first`,
  );
  return { ...first, entries: uniqueIds(books.flatMap((b) => b.entries)) };
}

function mapCard(det: Detected): Imported<Character> {
  const sink = new WarningSink();
  const d = det.data;
  const enveloped = det.variant === 'v2' || det.variant === 'v3';
  const base = enveloped ? 'data' : '';
  const p = (k: string): string => joinPath(base, k);

  if (typeof d.name !== 'string') throw new CardFormatError('card has no name');
  const name = d.name.trim();
  if (name === '') sink.add('empty_name', p('name'), 'card name is empty');

  const used = new Set(MAPPED);
  const ext: Rec = isRecord(d.extensions) ? d.extensions : {};
  if (d.extensions !== undefined && d.extensions !== null && !isRecord(d.extensions)) {
    sink.add('invalid_value', p('extensions'), 'extensions is not an object; ignored');
  }
  const usedExt = new Set<string>();
  const usedEnv = new Set<string>();

  const first = nonBlank(d.first_mes);
  const alternates = (optStrArray(d.alternate_greetings) ?? []).filter((g) => g.trim() !== '');

  const depthPrompt = readDepthPrompt(ext.depth_prompt, joinPath(p('extensions'), 'depth_prompt'), sink);
  if (depthPrompt) usedExt.add('depth_prompt');

  // RoleCall's multi-book extension: every element is a place; the array leaves extras only when
  // all of them were read as books (a bad element keeps the whole array, with its warning).
  const rcBooks = Array.isArray(ext.character_books) ? (ext.character_books as unknown[]) : [];
  let rcRead = 0;
  const book = readBooks(
    [
      [p('character_book'), d.character_book, () => used.add('character_book')],
      [joinPath(p('extensions'), 'character_book'), ext.character_book, () => usedExt.add('character_book')],
      ...rcBooks.map(
        (raw, i): [string, unknown, () => void] => [joinPath(joinPath(p('extensions'), 'character_books'), i), raw, () => void rcRead++],
      ),
      ...(enveloped && 'character_book' in det.card
        ? [['character_book', det.card.character_book, () => usedEnv.add('character_book')] as [string, unknown, () => void]]
        : []),
    ],
    name,
    sink,
  );
  if (rcBooks.length > 0 && rcRead === rcBooks.length) usedExt.add('character_books');

  // Leftovers ride extras so a later exporter can write them back.
  const extras: Rec = {};
  if (enveloped) {
    extras.spec = det.card.spec;
    if (det.card.spec_version !== undefined) extras.spec_version = det.card.spec_version;
  }
  for (const [k, v] of Object.entries(d)) {
    if (used.has(k)) continue;
    extras[k] = v;
    const rule = CARD_NOT_HONOURED[k];
    const msg = rule ? rule(v) : null;
    if (msg) sink.add('not_honoured', p(k), msg);
    else if (!rule && !CARD_SILENT.has(k)) sink.add('unknown_field', p(k), `unknown card field "${k}" kept in extras`);
  }
  const extLeft: Rec = {};
  for (const [k, v] of Object.entries(ext)) {
    if (usedExt.has(k)) continue;
    extLeft[k] = v;
    const rule = EXT_NOT_HONOURED[k];
    // ST embeds the linked world as character_book on export: same name = it is the card's own book.
    const embedded = k === 'world' && book !== undefined && typeof v === 'string' && v.trim() !== '' && v.trim() === book.name.trim();
    const msg = rule && !embedded ? rule(v) : null;
    const path = joinPath(p('extensions'), k);
    if (msg) sink.add('not_honoured', path, msg);
    else if (!rule && !EXT_SILENT.has(k)) sink.add('unknown_field', path, `unknown extension "${k}" kept in extras`);
  }
  if (Object.keys(extLeft).length > 0) extras.extensions = extLeft;
  if (enveloped) {
    const envLeft: Rec = {};
    for (const [k, v] of Object.entries(det.card)) {
      if (ENVELOPE_MIRROR.has(k) || usedEnv.has(k)) continue;
      envLeft[k] = v;
      // an unusable top-level character_book already warned in readBooks
      if (k !== 'character_book') sink.add('unknown_field', k, `unknown envelope field "${k}" kept in extras.envelope`);
    }
    if (Object.keys(envLeft).length > 0) extras.envelope = envLeft;
  }

  const value: Character = compact({
    name,
    description: typeof d.description === 'string' ? d.description : '',
    personality: nonBlank(d.personality),
    scenario: nonBlank(d.scenario),
    greetings: first !== undefined ? [first, ...alternates] : alternates,
    examples: nonBlank(d.mes_example),
    systemPrompt: nonBlank(d.system_prompt),
    postHistory: nonBlank(d.post_history_instructions),
    depthPrompt,
    book,
    creator: nonBlank(d.creator),
    tags: readTags(d.tags),
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  });
  return { value, warnings: sink.list() };
}

/**
 * Map a parsed card object (V1 flat, V2 {spec:'chara_card_v2', data}, V3 {spec:'chara_card_v3', data})
 * into the native Character: first_mes + alternate_greetings → greetings; system_prompt →
 * systemPrompt; post_history_instructions → postHistory; extensions.depth_prompt → depthPrompt
 * (empty prompt = none); character_book → book (via st-worldinfo.characterBookToLoreBook); unknown
 * fields → extras. Rejects presets and world books that look like cards (the "firewall", §19.8).
 */
export function parseCardObject(obj: unknown): Imported<Character> {
  const det = detectCard(obj);
  if (!det) throw new CardFormatError(whyNotCard(obj));
  return mapCard(det);
}

// ---- files -------------------------------------------------------------------------------------

/** A chunk payload: base64 of UTF-8 JSON as written by ST, or raw JSON from lax writers. */
function decodeCardPayload(text: string): unknown {
  const t = text.trim();
  const json = t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8');
  try {
    return JSON.parse(stripBom(json)) as unknown;
  } catch (e) {
    throw new CardFormatError(`card chunk is not valid JSON: ${errText(e)}`);
  }
}

function readPngCard(bytes: Uint8Array, pre: WarningSink): Imported<Character> {
  const { chunks, broken } = walkTextChunks(bytes);
  let firstError: CardFormatError | undefined;
  // ccv3 first wherever it sits in the file: a V3 card carries a V2 backfill under `chara`.
  for (const kw of ['ccv3', 'chara']) {
    const chunk = chunks.find((c) => c.keyword.toLowerCase() === kw);
    if (!chunk) {
      const bad = broken.find((b) => b.keyword.toLowerCase() === kw);
      if (bad) {
        firstError ??= new CardFormatError(`the ${kw} chunk could not be decoded: ${bad.reason}`);
        pre.add('chunk_unreadable', `png:${kw}`, `the ${kw} chunk could not be decoded (${bad.reason})`);
      }
      continue;
    }
    try {
      return parseCardObject(decodeCardPayload(chunk.text));
    } catch (e) {
      if (!(e instanceof CardFormatError)) throw e;
      firstError ??= e;
      pre.add('chunk_unreadable', `png:${kw}`, `the ${kw} chunk was skipped: ${e.message}`);
    }
  }
  throw firstError ?? new CardFormatError('PNG carries no character card (no ccv3 or chara text chunk)');
}

function readJsonCard(bytes: Uint8Array, pre: WarningSink): Imported<Character> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(utf8Loose.decode(bytes))) as unknown;
  } catch (e) {
    throw new CardFormatError(`not a PNG and not JSON: ${errText(e)}`);
  }
  const readings = readingsOf(parsed);
  for (const [i, reading] of readings.entries()) {
    if (!isCardObject(reading)) continue;
    if (i > 0) pre.add('repaired_json', '$', 'the card was double-encoded or wrapped in an export envelope; unwrapped');
    return parseCardObject(reading);
  }
  throw new CardFormatError(whyNotCard(parsed));
}

/** PNG (by signature) or JSON bytes → Character. */
export function readCard(bytes: Uint8Array, filename: string): Imported<Character> {
  const pre = new WarningSink();
  const r = isPng(bytes) ? readPngCard(bytes, pre) : readJsonCard(bytes, pre);
  let warnings = r.warnings;
  // A nameless card takes its file's name, as a person would expect from the file they picked.
  const stem = basename(filename, extname(filename)).trim();
  if (r.value.name === '' && stem !== '') {
    r.value.name = stem;
    warnings = warnings.map((w) =>
      w.code === 'empty_name' ? { code: 'name_from_filename', path: w.path, message: `card name is empty; using "${stem}"` } : w,
    );
  }
  return { value: r.value, warnings: [...pre.list(), ...warnings] };
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
