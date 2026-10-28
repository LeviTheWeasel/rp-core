// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// A small ZIP reader for RoleCall's story export (.notes/rcimport-decisions.md D-186), no dependency:
// the end-of-central-directory record (found from the end, past a comment), the central directory,
// each local header, methods 0 (stored) and 8 (deflate, node:zlib inflateRawSync), CRC-32 checked.
// What an export never needs is refused with a reason: ZIP64, encryption, split archives, other
// methods. Hostile archives are refused before anything is inflated: a member over `member` bytes,
// declared sizes summing past `total`, more than `count` records, names that climb (`..`) or start
// at a root, duplicate names, members that overlap (the overlapping-file bomb) or run past the
// central directory. A member is inflated with its declared size as the output cap, so a lying
// size stops at the cap instead of filling memory.
// Names are normalised: '\' becomes '/', '.' segments and doubled slashes go; a directory record
// keeps its trailing '/'. Directory records are listed in `entries` and skipped by readZip.

import { crc32, inflateRawSync } from 'node:zlib';

const MiB = 1024 * 1024;

export interface ZipLimits {
  /** The largest member, uncompressed, in bytes. */
  member: number;
  /** The archive itself, and the sum of its members' uncompressed sizes, in bytes. */
  total: number;
  /** Central directory records, directories included. */
  count: number;
}

/** D-186: a member ≤ 64 MB, the whole ≤ 512 MB, ≤ 10 000 members. */
export const ZIP_LIMITS: Readonly<ZipLimits> = { member: 64 * MiB, total: 512 * MiB, count: 10_000 };

export type ZipErrorCode =
  | 'not_zip'
  | 'truncated'
  | 'corrupt'
  | 'crc'
  | 'encrypted'
  | 'zip64'
  | 'unsupported'
  | 'limit'
  | 'unsafe_name'
  | 'missing';

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  /** The member the error is about, when there is one (its normalised name, else the raw one). */
  readonly member: string | undefined;
  constructor(code: ZipErrorCode, message: string, member?: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    this.member = member;
  }
}

export interface ZipEntry {
  /** '/'-separated, relative, no '.' or '..' segments; a directory ends with '/'. */
  readonly name: string;
  readonly dir: boolean;
  readonly method: 0 | 8;
  /** Uncompressed size, as declared by the central directory. */
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
}

export interface ZipMember {
  name: string;
  bytes: Uint8Array;
}

export interface ZipArchive {
  /** Every central directory record, in archive order, directories included. */
  readonly entries: readonly ZipEntry[];
  has(name: string): boolean;
  /** The member's bytes, inflated and CRC-checked on each call. */
  read(name: string): Uint8Array;
  /** read() decoded as UTF-8 (a leading BOM dropped). */
  text(name: string): string;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;
const METHOD_AES = 99;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_AES = 0x9901;

/** The local file header magic `PK\x03\x04` that D-185 sniffs. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

interface Located extends ZipEntry {
  /** Where the member's local header starts, and where its data starts and ends, in the archive. */
  headerStart: number;
  dataStart: number;
  dataEnd: number;
}

/**
 * Reads the archive's structure and checks it; members are inflated on read(). Throws ZipError.
 * `limits` overrides ZIP_LIMITS field by field.
 */
export function openZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipArchive {
  const lim: ZipLimits = { ...ZIP_LIMITS, ...limits };
  if (bytes.length > lim.total) {
    throw new ZipError('limit', `the archive is ${bytes.length} bytes, over the ${lim.total}-byte limit`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);

  const diskNo = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (eocd >= ZIP64_LOCATOR_SIZE && view.getUint32(eocd - ZIP64_LOCATOR_SIZE, true) === SIG_ZIP64_LOCATOR) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported');
  }
  if (count === U16_MAX || onDisk === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported');
  }
  if (diskNo !== 0 || cdDisk !== 0 || onDisk !== count) {
    throw new ZipError('unsupported', 'split (multi-disk) archives are not supported');
  }
  if (count > lim.count) {
    throw new ZipError('limit', `the archive has ${count} members, over the ${lim.count}-member limit`);
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipError('truncated', 'the central directory runs past the end of the archive');
  }

  const located: Located[] = [];
  const byName = new Map<string, Located>();
  let declared = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_SIZE > cdOffset + cdSize) {
      throw new ZipError('corrupt', `the central directory holds fewer than the ${count} records it declares`);
    }
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError('corrupt', `central directory record ${i + 1} has a bad signature`);
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const startDisk = view.getUint16(p + 34, true);
    const localOffset = view.getUint32(p + 42, true);
    const end = p + CENTRAL_SIZE + nameLen + extraLen + commentLen;
    if (end > cdOffset + cdSize) {
      throw new ZipError('corrupt', `central directory record ${i + 1} runs past the central directory`);
    }
    const rawName = bytes.subarray(p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLen);
    const extra = bytes.subarray(p + CENTRAL_SIZE + nameLen, p + CENTRAL_SIZE + nameLen + extraLen);
    const label = printable(rawName);

    if (compressedSize === U32_MAX || size === U32_MAX || localOffset === U32_MAX || startDisk === U16_MAX || hasExtra(extra, EXTRA_ZIP64)) {
      throw new ZipError('zip64', `${label}: ZIP64 members are not supported`, label);
    }
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS) || method === METHOD_AES || hasExtra(extra, EXTRA_AES)) {
      throw new ZipError('encrypted', `${label}: encrypted members are not supported`, label);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError('unsupported', `${label}: compression method ${method} is not supported (only stored and deflate)`, label);
    }
    if (startDisk !== 0) {
      throw new ZipError('unsupported', `${label}: split (multi-disk) archives are not supported`, label);
    }

    const { name, dir } = normaliseName(rawName, (flags & FLAG_UTF8) !== 0);
    if (byName.has(name)) throw new ZipError('unsafe_name', `${name}: the name appears twice`, name);
    if (dir && size !== 0) throw new ZipError('corrupt', `${name}: a directory record with ${size} bytes of data`, name);
    if (method === 0 && compressedSize !== size) {
      throw new ZipError('corrupt', `${name}: stored, but its sizes differ (${compressedSize} vs ${size})`, name);
    }
    if (size > lim.member) {
      throw new ZipError('limit', `${name}: ${size} bytes uncompressed, over the ${lim.member}-byte member limit`, name);
    }
    declared += size;
    if (declared > lim.total) {
      throw new ZipError('limit', `the members add up to more than the ${lim.total}-byte limit`, name);
    }

    const dataStart = checkLocal(bytes, view, localOffset, rawName, name, flags, method, crc, compressedSize, size, cdOffset);
    const entry: Located = {
      name,
      dir,
      method,
      size,
      compressedSize,
      crc32: crc,
      headerStart: localOffset,
      dataStart,
      dataEnd: dataStart + compressedSize,
    };
    located.push(entry);
    byName.set(name, entry);
    p = end;
  }

  // Overlapping members are how a small archive claims huge output (one deflate stream named many
  // times, local headers quoted inside another member); a RoleCall export never shares bytes.
  const order = [...located].sort((a, b) => a.headerStart - b.headerStart);
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1]!;
    const cur = order[i]!;
    if (cur.headerStart < prev.dataEnd) {
      throw new ZipError('corrupt', `${cur.name}: its data overlaps ${prev.name}`, cur.name);
    }
  }

  const entries: ZipEntry[] = located.map(({ headerStart: _h, dataStart: _s, dataEnd: _e, ...entry }) => entry);

  const read = (name: string): Uint8Array => {
    const e = byName.get(name);
    if (!e) throw new ZipError('missing', `${name}: no such member`, name);
    return inflate(bytes, e);
  };

  return {
    entries,
    has: (name) => byName.has(name),
    read,
    text: (name) => new TextDecoder().decode(read(name)),
  };
}

/** Every member that is not a directory, inflated and checked, in archive order. Throws ZipError. */
export function readZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipMember[] {
  const zip = openZip(bytes, limits);
  return zip.entries.filter((e) => !e.dir).map((e) => ({ name: e.name, bytes: zip.read(e.name) }));
}

/**
 * The EOCD record: searched backwards from the end over at most a full comment's length; the one
 * whose comment ends exactly at the end of the file wins (a comment may itself hold `PK\x05\x06`).
 */
function findEocd(bytes: Uint8Array, view: DataView): number {
  if (bytes.length < EOCD_SIZE) {
    throw new ZipError(isZip(bytes) ? 'truncated' : 'not_zip', isZip(bytes) ? 'the archive is truncated' : 'not a zip archive');
  }
  const floor = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
  for (let p = bytes.length - EOCD_SIZE; p >= floor; p--) {
    if (view.getUint32(p, true) !== SIG_EOCD) continue;
    if (p + EOCD_SIZE + view.getUint16(p + 20, true) === bytes.length) return p;
  }
  const empty = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06;
  if (isZip(bytes) || empty) {
    throw new ZipError('truncated', 'no end-of-central-directory record: the archive is truncated or has trailing data');
  }
  throw new ZipError('not_zip', 'not a zip archive');
}

/** Checks a member's local header against its central record; returns where its data starts. */
function checkLocal(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  rawName: Uint8Array,
  name: string,
  flags: number,
  method: number,
  crc: number,
  compressedSize: number,
  size: number,
  cdOffset: number,
): number {
  if (offset + LOCAL_SIZE > cdOffset) {
    throw new ZipError('corrupt', `${name}: its local header lies outside the archive's data`, name);
  }
  if (view.getUint32(offset, true) !== SIG_LOCAL) {
    throw new ZipError('corrupt', `${name}: bad local header signature`, name);
  }
  const lFlags = view.getUint16(offset + 6, true);
  const lMethod = view.getUint16(offset + 8, true);
  const lCrc = view.getUint32(offset + 14, true);
  const lCompressed = view.getUint32(offset + 18, true);
  const lSize = view.getUint32(offset + 22, true);
  const nameLen = view.getUint16(offset + 26, true);
  const extraLen = view.getUint16(offset + 28, true);
  const dataStart = offset + LOCAL_SIZE + nameLen + extraLen;
  if (dataStart + compressedSize > cdOffset) {
    throw new ZipError('truncated', `${name}: its data runs past the archive's data`, name);
  }
  if (lFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
    throw new ZipError('encrypted', `${name}: encrypted members are not supported`, name);
  }
  if (lMethod !== method) {
    throw new ZipError('corrupt', `${name}: the local header and the central directory disagree on the method`, name);
  }
  if (!sameBytes(bytes.subarray(offset + LOCAL_SIZE, offset + LOCAL_SIZE + nameLen), rawName)) {
    throw new ZipError('corrupt', `${name}: the local header names a different file`, name);
  }
  if (!(flags & FLAG_DESCRIPTOR) && !(lFlags & FLAG_DESCRIPTOR)) {
    if (lCompressed === U32_MAX || lSize === U32_MAX) {
      throw new ZipError('zip64', `${name}: ZIP64 members are not supported`, name);
    }
    if (lCrc !== crc || lCompressed !== compressedSize || lSize !== size) {
      throw new ZipError('corrupt', `${name}: the local header and the central directory disagree on its size or CRC`, name);
    }
  }
  return dataStart;
}

function inflate(bytes: Uint8Array, e: Located): Uint8Array {
  const raw = bytes.subarray(e.dataStart, e.dataEnd);
  let out: Uint8Array;
  if (e.method === 0) {
    out = raw.slice();
  } else {
    try {
      // The cap is the declared size: a member that inflates past it stops here.
      const b = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
      out = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ZipError('corrupt', `${e.name}: inflates past its declared ${e.size} bytes`, e.name);
      }
      throw new ZipError('corrupt', `${e.name}: bad deflate data (${(err as Error).message})`, e.name);
    }
  }
  if (out.length !== e.size) {
    throw new ZipError('corrupt', `${e.name}: ${out.length} bytes, but ${e.size} declared`, e.name);
  }
  const actual = crc32(out) >>> 0;
  if (actual !== e.crc32) {
    throw new ZipError('crc', `${e.name}: CRC-32 mismatch (the member is damaged)`, e.name);
  }
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A safe relative name. Refused: not UTF-8, control characters, an absolute or drive-rooted path,
 * any `..` segment, nothing left after normalising.
 */
function normaliseName(raw: Uint8Array, utf8Flag: boolean): { name: string; dir: boolean } {
  let decoded: string;
  try {
    decoded = UTF8.decode(raw);
  } catch {
    const label = printable(raw);
    throw new ZipError('unsafe_name', `${label}: the name is not UTF-8${utf8Flag ? ' although flagged so' : ''}`, label);
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) {
    const label = printable(raw);
    throw new ZipError('unsafe_name', `${label}: control characters in the name`, label);
  }
  const slashed = decoded.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new ZipError('unsafe_name', `${decoded}: an absolute path`, decoded);
  }
  const segments = slashed.split('/');
  if (segments.includes('..')) {
    throw new ZipError('unsafe_name', `${decoded}: the name climbs out of the archive ('..')`, decoded);
  }
  const kept = segments.filter((s) => s !== '' && s !== '.');
  if (kept.length === 0) throw new ZipError('unsafe_name', `${JSON.stringify(decoded)}: an empty name`, decoded);
  const dir = slashed.endsWith('/');
  return { name: kept.join('/') + (dir ? '/' : ''), dir };
}

function hasExtra(extra: Uint8Array, id: number): boolean {
  const v = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let p = 0; p + 4 <= extra.length; ) {
    if (v.getUint16(p, true) === id) return true;
    p += 4 + v.getUint16(p + 2, true);
  }
  return false;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A raw name for an error message: decoded leniently, control characters shown as escapes. */
function printable(raw: Uint8Array): string {
  return new TextDecoder().decode(raw).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
