// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// formats/zip.ts (D-186) and the synthetic export kit (D-194): the reader on the kit writer's
// archives, on hostile ones (bad CRC, truncation, path traversal, oversize, declared-size bombs,
// ZIP64, encryption), and on the user's own export when RP_CORE_RC_EXPORT names it (read-only; only
// that it opens and that its members match its manifest; no content is asserted or kept).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { isZip, openZip, readZip, ZIP_LIMITS, ZipError, type ZipArchive, type ZipErrorCode } from '../../src/formats/zip.ts';
import { buildStory, buildStoryExport, concatBytes, writeZip, type ZipInput } from './kit.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function zipError(fn: () => unknown): ZipError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZipError) return e;
    throw e;
  }
  throw new Error('expected a ZipError');
}

const refused = (bytes: Uint8Array, code: ZipErrorCode, limits?: Parameters<typeof readZip>[1]): ZipError => {
  const e = zipError(() => readZip(bytes, limits));
  expect(e.code).toBe(code);
  return e;
};

const one = (input: Partial<ZipInput> & { name?: string }): Uint8Array => writeZip([{ name: 'a.txt', data: 'hello hello hello', ...input }]);

/** Offset of the EOCD record of a comment-less archive. */
const eocdAt = (z: Uint8Array): number => z.length - 22;
const patch16 = (z: Uint8Array, at: number, v: number): Uint8Array => {
  const out = z.slice();
  new DataView(out.buffer).setUint16(at, v, true);
  return out;
};

// ---- the layout check, shared by the synthetic export and the user's file ---------------------------

const CHAT_FILES = new Set(['chat.json', 'messages.jsonl', 'tracker.json', 'storyboard.json', 'dm-context.json']);
const TOP = new Set(['manifest.json', 'story.jsonl', 'characters', 'personas', 'presets', 'lorebooks', 'chats']);

/** What does not match the manifest, said by position only (no names, no content). */
function layoutProblems(zip: ZipArchive): string[] {
  const problems: string[] = [];
  if (!zip.has('manifest.json')) return ['no manifest.json'];
  const m = JSON.parse(zip.text('manifest.json')) as Record<string, unknown>;
  if (m.format !== 'rolecall-story-zip') problems.push('manifest format');
  if (m.version !== 1) problems.push('manifest version');
  const files = zip.entries.filter((e) => !e.dir).map((e) => e.name);
  const dirs = zip.entries.filter((e) => e.dir).map((e) => e.name);
  for (const f of files) if (!TOP.has(f.split('/')[0]!)) problems.push(`unexpected top-level member #${files.indexOf(f)}`);
  for (const d of dirs) if (!files.some((f) => f.startsWith(d))) problems.push(`empty folder record #${dirs.indexOf(d)}`);
  const under = (prefix: string): string[] => files.filter((f) => f.startsWith(prefix));

  const chatIds = m.chat_ids as string[];
  const chatDirs = new Set(under('chats/').map((f) => f.split('/').slice(0, 2).join('/')));
  if (chatDirs.size !== chatIds.length) problems.push(`chat folders ${chatDirs.size} ≠ chat_ids ${chatIds.length}`);
  let trackers = 0;
  let storyboards = 0;
  let dms = 0;
  chatIds.forEach((id, i) => {
    const mine = [...chatDirs].filter((d) => d.endsWith(`-${id.slice(0, 8)}`));
    if (mine.length !== 1) return void problems.push(`chat #${i}: ${mine.length} folders`);
    const inside = under(`${mine[0]}/`).map((f) => f.slice(mine[0]!.length + 1));
    if (!inside.includes('chat.json') || !inside.includes('messages.jsonl')) problems.push(`chat #${i}: chat.json or messages.jsonl missing`);
    if (inside.some((f) => !CHAT_FILES.has(f))) problems.push(`chat #${i}: unexpected file`);
    if ((JSON.parse(zip.text(`${mine[0]}/chat.json`)) as { id?: unknown }).id !== id) problems.push(`chat #${i}: chat.json id`);
    trackers += inside.includes('tracker.json') ? 1 : 0;
    storyboards += inside.includes('storyboard.json') ? 1 : 0;
    dms += inside.includes('dm-context.json') ? 1 : 0;
  });

  const bookIds = m.lorebook_ids as string[];
  const books = under('lorebooks/');
  if (books.length !== bookIds.length) problems.push(`lorebook files ${books.length} ≠ lorebook_ids ${bookIds.length}`);
  bookIds.forEach((id, i) => {
    if (books.filter((f) => f.endsWith(`-${id.slice(0, 8)}.json`)).length !== 1) problems.push(`lorebook #${i}: no single file`);
  });
  const count = (prefix: string, pred: (f: string) => boolean): number => under(prefix).filter(pred).length;
  if (count('personas/', (f) => f.endsWith('.json')) !== (m.persona_id ? 1 : 0)) problems.push('persona file');
  if (count('presets/', (f) => f.endsWith('.json')) !== (m.preset_id ? 1 : 0)) problems.push('preset file');
  if (count('characters/', (f) => f.endsWith('.raw.json')) !== (m.character_id ? 1 : 0)) problems.push('character row file');
  if (count('characters/', (f) => !f.endsWith('.raw.json') && (f.endsWith('.json') || f.endsWith('.png'))) !== (m.character_id ? 1 : 0)) {
    problems.push('character card file');
  }
  const stats = m.stats as Record<string, number>;
  if (stats.branches !== chatIds.length) problems.push('stats.branches');
  if (stats.lorebook_count !== bookIds.length) problems.push('stats.lorebook_count');
  if (stats.chats_with_trackers !== trackers) problems.push('stats.chats_with_trackers');
  if (stats.chats_with_storyboards !== storyboards) problems.push('stats.chats_with_storyboards');
  if (stats.chats_with_dm_context !== dms) problems.push('stats.chats_with_dm_context');
  return problems;
}

// ---- reading what the writer writes ----------------------------------------------------------------

describe('readZip on the kit writer', () => {
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  const entries: ZipInput[] = [
    { name: 'stored.txt', data: 'plain text', method: 0 },
    { name: 'deflated.txt', data: 'the tide, the tide, the tide '.repeat(200), method: 8 },
    { name: 'empty.txt', data: '' },
    { name: 'folder/' },
    { name: 'folder/binary.bin', data: binary, method: 8 },
    { name: 'folder/ünïcode-名前.json', data: '{"ok":true}' },
  ];

  test('stored, deflate, empty, a folder and a UTF-8 name round-trip', () => {
    const z = writeZip(entries);
    expect(isZip(z)).toBe(true);
    const members = readZip(z);
    expect(members.map((m) => m.name)).toEqual(['stored.txt', 'deflated.txt', 'empty.txt', 'folder/binary.bin', 'folder/ünïcode-名前.json']);
    expect(dec.decode(members[0]!.bytes)).toBe('plain text');
    expect(dec.decode(members[1]!.bytes)).toBe('the tide, the tide, the tide '.repeat(200));
    expect(members[2]!.bytes.length).toBe(0);
    expect([...members[3]!.bytes]).toEqual([...binary]);
    expect(members[3]!.bytes.constructor).toBe(Uint8Array);
    const zip = openZip(z);
    expect(zip.entries.map((e) => [e.name, e.dir, e.method])).toEqual([
      ['stored.txt', false, 0],
      ['deflated.txt', false, 8],
      ['empty.txt', false, 0],
      ['folder/', true, 0],
      ['folder/binary.bin', false, 8],
      ['folder/ünïcode-名前.json', false, 8],
    ]);
    expect(zip.entries[1]!.compressedSize).toBeLessThan(zip.entries[1]!.size);
    expect(zip.has('folder/binary.bin')).toBe(true);
    expect(zip.has('nope')).toBe(false);
    expect(zipError(() => zip.read('nope')).code).toBe('missing');
    expect(JSON.parse(zip.text('folder/ünïcode-名前.json'))).toEqual({ ok: true });
  });

  test('data descriptors (flag bit 3) and a comment that holds the EOCD signature', () => {
    const z = writeZip(entries, { dataDescriptor: true, comment: 'made by hand PK\u0005\u0006 not a record' });
    expect(readZip(z).map((m) => m.name)).toHaveLength(5);
    expect(dec.decode(openZip(z).read('deflated.txt'))).toBe('the tide, the tide, the tide '.repeat(200));
  });

  test('an archive inside a larger buffer (a non-zero byteOffset)', () => {
    const z = writeZip(entries);
    const big = new Uint8Array(z.length + 64);
    big.set(z, 32);
    expect(readZip(big.subarray(32, 32 + z.length)).map((m) => m.name)).toEqual(readZip(z).map((m) => m.name));
  });

  test('an empty archive has no members; text() drops a BOM', () => {
    const empty = writeZip([]);
    expect(isZip(empty)).toBe(false);
    expect(readZip(empty)).toEqual([]);
    const bom = writeZip([{ name: 'b.json', data: concatBytes([Uint8Array.of(0xef, 0xbb, 0xbf), enc.encode('{"a":1}')]) }]);
    expect(JSON.parse(openZip(bom).text('b.json'))).toEqual({ a: 1 });
  });

  test("names are normalised: '.' segments, doubled slashes and backslashes", () => {
    const z = writeZip([
      { name: './chats//one/./chat.json', data: '{}' },
      { name: 'lorebooks\\book.json', data: '{}' },
    ]);
    expect(readZip(z).map((m) => m.name)).toEqual(['chats/one/chat.json', 'lorebooks/book.json']);
  });

  test('isZip sniffs the local header magic only', () => {
    expect(isZip(enc.encode('{"format":"rolecall-backup"}'))).toBe(false);
    expect(isZip(Uint8Array.of(0x50, 0x4b))).toBe(false);
    expect(isZip(buildStoryExport())).toBe(true);
  });
});

// ---- hostile archives ------------------------------------------------------------------------------

describe('readZip refuses hostile archives', () => {
  test('a wrong CRC, a flipped stored byte, a broken deflate stream', () => {
    const lied = refused(one({ lie: { crc: 0x12345678 } }), 'crc');
    expect(lied.member).toBe('a.txt');
    const stored = one({ method: 0 });
    const flipped = stored.slice();
    flipped[30 + 'a.txt'.length] = flipped[30 + 'a.txt'.length]! ^ 0x20;
    refused(flipped, 'crc');
    const deflated = one({ data: 'x'.repeat(1000), method: 8 });
    const broken = deflated.slice();
    broken[30 + 'a.txt'.length] = 0xff;
    broken[31 + 'a.txt'.length] = 0xff;
    expect(['corrupt', 'crc']).toContain(zipError(() => readZip(broken)).code);
  });

  test('truncated archives', () => {
    const z = buildStoryExport();
    refused(z.subarray(0, z.length - 1), 'truncated');
    refused(z.subarray(0, Math.floor(z.length / 2)), 'truncated');
    refused(z.subarray(0, 10), 'truncated');
    // The central directory said to sit past the end.
    const far = one({}).slice();
    new DataView(far.buffer).setUint32(eocdAt(far) + 16, far.length, true);
    refused(far, 'truncated');
    // Data that runs into the central directory.
    refused(one({ method: 0, lie: { size: 1000, compressedSize: 1000 } }), 'truncated');
  });

  test('not a zip at all', () => {
    refused(enc.encode('{"format":"rolecall-backup","version":1}'), 'not_zip');
    refused(new Uint8Array(0), 'not_zip');
    refused(new Uint8Array(100), 'not_zip');
  });

  test('path traversal, absolute names, control characters, bad UTF-8, duplicates', () => {
    for (const name of ['../evil.json', 'chats/../../evil', '..\\evil', 'a\\..\\..\\b', '/etc/passwd', '\\\\server\\share', 'C:\\x.json', 'c:/x.json', 'a\u0000b', 'tab\there', '', './', '//']) {
      const e = refused(writeZip([{ name, data: 'x' }]), 'unsafe_name');
      expect(e.message.length).toBeGreaterThan(0);
    }
    refused(writeZip([{ name: 'x', rawName: Uint8Array.of(0x61, 0xff, 0xfe, 0x62), data: 'x' }]), 'unsafe_name');
    refused(
      writeZip([
        { name: 'chats/a.json', data: '1' },
        { name: 'chats//a.json', data: '2' },
      ]),
      'unsafe_name',
    );
  });

  test('a member over the member limit, members over the total, too many members, a huge archive', () => {
    // Declared near 4 GB: refused from the central directory, nothing inflated.
    const e = refused(one({ lie: { size: 0xfffffff0 } }), 'limit');
    expect(e.message).toContain(String(ZIP_LIMITS.member));
    refused(one({ data: 'x'.repeat(2000) }), 'limit', { member: 1000 });
    const many = writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `m${i}.txt`, data: 'y'.repeat(400) })));
    refused(many, 'limit', { total: 1500 });
    expect(readZip(many, { total: 2000 })).toHaveLength(5);
    refused(many, 'limit', { count: 4 });
    // An EOCD that claims 10 001 records.
    const z = one({});
    refused(patch16(patch16(z, eocdAt(z) + 8, 10_001), eocdAt(z) + 10, 10_001), 'limit');
  });

  test('zip bombs: a member that inflates past its declared size stops at the cap', () => {
    const zeros = new Uint8Array(8 * 1024 * 1024);
    const bomb = writeZip([{ name: 'bomb.bin', data: zeros, method: 8, lie: { size: 1024 } }]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    const e = refused(bomb, 'corrupt');
    expect(e.message).toContain('declared');
    // One that inflates to less than it declares.
    refused(writeZip([{ name: 'short.bin', data: 'abc', method: 8, lie: { size: 10 } }]), 'corrupt');
  });

  test('zip bombs: overlapping members (a local header quoted inside another member)', () => {
    const inner = writeZip([{ name: 'b.bin', data: 'z'.repeat(5000), method: 8 }]);
    const innerLocal = inner.subarray(0, inner.length - (46 + 'b.bin'.length) - 22);
    const z = writeZip([
      { name: 'a.bin', data: innerLocal, method: 0 },
      { name: 'b.bin', data: 'z'.repeat(5000), method: 8, centralOnly: true, lie: { localOffset: 30 + 'a.bin'.length } },
    ]);
    const e = refused(z, 'corrupt');
    expect(e.message).toContain('overlaps');
  });

  test('ZIP64 in any of its forms', () => {
    const zip64Extra = concatBytes([Uint8Array.of(0x01, 0x00, 0x08, 0x00), new Uint8Array(8)]);
    refused(one({ lie: { centralExtra: zip64Extra } }), 'zip64');
    refused(one({ lie: { compressedSize: 0xffffffff } }), 'zip64');
    const z = one({});
    refused(patch16(patch16(z, eocdAt(z) + 8, 0xffff), eocdAt(z) + 10, 0xffff), 'zip64');
    const locator = concatBytes([Uint8Array.of(0x50, 0x4b, 0x06, 0x07), new Uint8Array(16)]);
    const withLocator = concatBytes([z.subarray(0, eocdAt(z)), locator, z.subarray(eocdAt(z))]);
    refused(withLocator, 'zip64');
  });

  test('encryption: traditional, strong, AES', () => {
    refused(one({ lie: { flags: 0x0001 } }), 'encrypted');
    refused(one({ lie: { flags: 0x0041 } }), 'encrypted');
    refused(one({ lie: { method: 99 } }), 'encrypted');
    const aes = concatBytes([Uint8Array.of(0x01, 0x99, 0x07, 0x00), new Uint8Array(7)]);
    refused(one({ lie: { centralExtra: aes } }), 'encrypted');
  });

  test('other methods, split archives, a local header that disagrees, a directory with data', () => {
    expect(refused(one({ lie: { method: 12 } }), 'unsupported').message).toContain('method 12');
    const z = one({});
    refused(patch16(z, eocdAt(z) + 4, 1), 'unsupported');
    refused(one({ lie: { localName: 'b.txt' } }), 'corrupt');
    refused(one({ lie: { localOffset: 3 } }), 'corrupt');
    refused(writeZip([{ name: 'dir/', lie: { size: 5, compressedSize: 5 } }]), 'corrupt');
    refused(writeZip([{ name: 'x.txt', data: 'abc', method: 0, lie: { compressedSize: 2 } }]), 'corrupt');
  });
});

// ---- the synthetic export ---------------------------------------------------------------------------

describe('buildStoryExport (the synthetic rolecall-story-zip v1)', () => {
  const story = buildStory();
  const zip = openZip(story.bytes);
  const json = (name: string): Record<string, unknown> => JSON.parse(zip.text(name)) as Record<string, unknown>;
  const lines = (name: string): Array<Record<string, unknown>> => zip.text(name).split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const { facts } = story;

  test('opens, matches its manifest, and every JSON member parses', () => {
    expect(layoutProblems(zip)).toEqual([]);
    const files = zip.entries.filter((e) => !e.dir).map((e) => e.name);
    expect(files).toEqual(facts.files);
    expect(zip.entries.filter((e) => e.dir).map((e) => e.name)).toEqual([
      'characters/',
      'personas/',
      'presets/',
      'lorebooks/',
      'chats/',
      ...facts.chatIds.map((id) => `${Object.values(facts.chats).find((c) => c.id === id)!.dir}/`),
    ]);
    for (const f of files) {
      if (f.endsWith('.json')) expect(() => json(f)).not.toThrow();
      if (f.endsWith('.jsonl')) {
        expect(zip.text(f).endsWith('\n')).toBe(false);
        expect(() => lines(f)).not.toThrow();
      }
    }
    expect(zip.entries.filter((e) => !e.dir).every((e) => e.method === 8)).toBe(true);
    expect(buildStoryExport()).toEqual(story.bytes);
  });

  test('the layout check notices a missing chat, book or stat', () => {
    const without = (drop: (name: string) => boolean): ZipArchive =>
      openZip(writeZip(story.files.filter((f) => !drop(f.name)).map((f) => ({ name: f.name, data: f.data }))));
    expect(layoutProblems(without((n) => n.startsWith(`${facts.chats.detached!.dir}/`)))).toContain('chat folders 3 ≠ chat_ids 4');
    expect(layoutProblems(without((n) => n === facts.books.sagaTwin!.path))).toContain('lorebook #2: no single file');
    expect(layoutProblems(without((n) => n === `${facts.chats.main!.dir}/tracker.json`))).toEqual(['stats.chats_with_trackers']);
  });

  test('the manifest and story.jsonl', () => {
    const m = json('manifest.json');
    expect(m.main_chat_id).toBe(facts.chats.main!.id);
    expect(m.root_chat_id).toBe(facts.chats.main!.id);
    expect(m.chat_ids).toEqual(facts.chatIds);
    expect(m.failed_chunks).toEqual([]);
    const s = lines('story.jsonl');
    expect(s[0]).toMatchObject({ kind: 'manifest', format: 'rolecall-story', version: 1 });
    expect(s.slice(1, 4).map((l) => l.kind)).toEqual(['character', 'persona', 'preset']);
    expect(s.filter((l) => l.kind === 'lorebook')).toHaveLength(4);
    expect(s.filter((l) => l.kind === 'chat').map((l) => l.chat_id)).toEqual(facts.chatIds);
    const total = Object.values(facts.chats).reduce((n, c) => n + c.messages, 0);
    expect(s.filter((l) => l.kind === 'message')).toHaveLength(total);
    // A message line is the per-file line plus kind and chat_id.
    const main = facts.chats.main!;
    const first = s.find((l) => l.kind === 'message' && l.chat_id === main.id)!;
    const { kind: _k, chat_id: _c, ...rest } = first;
    expect(rest).toEqual(lines(`${main.dir}/messages.jsonl`)[0]!);
  });

  test('main chat: custom opener, a non-last active swipe, think tags, a same-role pair', () => {
    const main = facts.chats.main!;
    const msgs = lines(`${main.dir}/messages.jsonl`);
    const card = json(facts.character.card) as { spec: string; data: Record<string, unknown> };
    expect(card.spec).toBe('chara_card_v3');
    expect(msgs[0]!.content).not.toBe(card.data.first_mes);
    expect(card.data.alternate_greetings as string[]).not.toContain(msgs[0]!.content);
    const swipes = (i: number): Array<{ content: string }> => msgs[i]!.swipes as Array<{ content: string }>;
    expect(swipes(facts.features.activeNotLast)).toHaveLength(3);
    expect(swipes(facts.features.activeNotLast).findIndex((s) => s.content === msgs[2]!.content)).toBe(0);
    expect(String(msgs[facts.features.unclosedThink]!.content).startsWith('<think>')).toBe(true);
    expect(String(msgs[facts.features.unclosedThink]!.content)).not.toContain('</think>');
    expect(String(msgs[facts.features.closedThink]!.content)).toMatch(/^<think>[\s\S]*<\/think>/);
    expect(main.active[facts.features.closedThink]).toBe(1);
    expect(msgs[facts.features.sameRolePair - 1]!.role).toBe('assistant');
    expect(msgs[facts.features.sameRolePair]!.role).toBe('assistant');
    expect(msgs.map((m) => m.index)).toEqual(msgs.map((_, i) => i));
    expect(new Set(msgs.map((m) => m.message_id)).size).toBe(msgs.length);
    expect(new Set(msgs.map((m) => m.content)).size).toBe(msgs.length);
    for (let i = 1; i < msgs.length; i++) expect(Number(msgs[i]!.timestamp)).toBeGreaterThan(Number(msgs[i - 1]!.timestamp));
    for (const m of msgs) {
      expect(Object.keys(m)).toEqual(['index', 'message_id', 'role', 'is_user', 'content', 'timestamp', 'swipes']);
      expect((m.swipes as Array<{ timestamp: number }>)[0]!.timestamp).toBe(Number(m.timestamp));
    }
    expect(main.users).toBe(msgs.filter((m) => m.role === 'user').length);
    const dm = json(`${main.dir}/dm-context.json`);
    expect(dm.lastDirectiveTurn).toBe(main.users);
    expect(typeof (dm.activeArcs as unknown[])[facts.mainDmDirty.stringArc]).toBe('string');
    expect((dm.epicSeeds as Array<Record<string, unknown>>)[facts.mainDmDirty.seedWithoutId]!.id).toBeUndefined();
    expect((dm.invisibleArcs as Array<Record<string, unknown>>)[facts.mainDmDirty.otherShapeInvisibleArc]!.arcTitle).toBeString();
    expect((dm.parallelTimelines as Array<Record<string, unknown>>)[facts.mainDmDirty.spreadParallelTimeline]!['0']).toBeString();
    expect(json(`${main.dir}/chat.json`)).toMatchObject({ is_main_timeline: true, parent_chat_id: null, message_count: 0 });
  });

  test('the branch, its exact duplicate, and the detached run', () => {
    const { main, branch, duplicate, detached } = facts.chats;
    expect(branch!.parentId).toBe(main!.id);
    expect(branch!.messageIds.slice(0, 3)).toEqual(main!.messageIds.slice(0, 3));
    expect(lines(`${branch!.dir}/messages.jsonl`).slice(0, 3)).toEqual(lines(`${main!.dir}/messages.jsonl`).slice(0, 3));
    expect(duplicate!.parentId).toBe(branch!.id);
    expect(zip.text(`${duplicate!.dir}/messages.jsonl`)).toBe(zip.text(`${branch!.dir}/messages.jsonl`));
    expect(json(`${branch!.dir}/chat.json`).config).toMatchObject({ preset_id: facts.preset.missingId });
    expect(detached!.parentId).toBe(main!.id);
    expect(json(`${detached!.dir}/chat.json`)).toMatchObject({ branch_point_index: null, branch_name: null, title: null });
    expect(detached!.startsWithCardGreeting).toBe(true);
    expect(detached!.messageIds.filter((id) => main!.messageIds.includes(id))).toEqual([]);
    expect(detached!.roles[facts.detachedUserPair - 1]).toBe('user');
    expect(detached!.roles[facts.detachedUserPair]).toBe('user');
    expect(detached!.files.map((f) => f.split('/').pop())).toEqual(['chat.json', 'messages.jsonl', 'tracker.json', 'dm-context.json']);
  });

  test('library rows: card + row, persona details, preset rows, four books', () => {
    const raw = json(facts.character.raw);
    expect(raw.id).toBe(facts.character.id);
    const persona = json(facts.persona.path) as { details: Record<string, unknown>; section_order: string[] };
    expect(persona.section_order).toEqual(persona.details.section_order as string[]);
    expect(persona.details.lorebook_id).toBe(facts.books.world!.id);
    const preset = json(facts.preset.path) as { categories: Array<Record<string, unknown>>; prompts: Array<Record<string, unknown>>; settings: Record<string, unknown> };
    expect(preset.prompts).toHaveLength(facts.preset.prompts);
    expect(preset.prompts.map((p) => p.sort_order)).toEqual(preset.prompts.map((_, i) => i));
    expect(preset.prompts.filter((p) => p.enabled)).toHaveLength(facts.preset.enabledRows);
    expect(preset.categories.some((c) => c.parent_id !== null)).toBe(true);
    expect(new Set(preset.prompts.map((p) => p.injection_position))).toEqual(new Set(['0', '1']));
    expect(JSON.stringify(preset.prompts)).toContain('{{/if}}');
    expect(preset.settings.extensions).toEqual({});
    const mainCfg = json(`${facts.chats.main!.dir}/chat.json`).config as Record<string, Record<string, unknown>>;
    expect(Object.keys(mainCfg.preset_prompt_overrides!)).toHaveLength(2);
    expect(mainCfg.preset_prompt_overrides![facts.preset.id]).toEqual(facts.preset.mainOverrides);

    const rows = (k: 'world' | 'saga' | 'sagaTwin' | 'compendium'): Array<Record<string, unknown>> => json(facts.books[k]!.path).entries as Array<Record<string, unknown>>;
    const strip = (r: Record<string, unknown>): Record<string, unknown> => {
      const { id: _i, lorebook_id: _l, ...rest } = r;
      return rest;
    };
    expect(rows('sagaTwin').map(strip)).toEqual(rows('saga').map(strip));
    expect(rows('sagaTwin').map((r) => r.id)).not.toEqual(rows('saga').map((r) => r.id));
    const comp = rows('compendium');
    const meta = (r: Record<string, unknown>): Record<string, unknown> => r.metadata as Record<string, unknown>;
    expect(comp.filter((r) => typeof meta(r).entry_type === 'string')).toHaveLength(facts.compendium.typed);
    expect(comp.filter((r) => String(r.title).startsWith('[Arc]'))).toHaveLength(facts.compendium.arcRows);
    const consumed = comp.filter((r) => meta(r).standardization_state === 'consumed_by_split');
    expect(consumed.map((r) => r.id)).toEqual(facts.compendium.consumedIds);
    expect(consumed.every((r) => r.enabled === true)).toBe(true);
    expect(consumed.every((r) => comp.some((t) => t.id === meta(r).consumed_by_entry_id))).toBe(true);
    expect(Object.keys(comp[0]!)).toHaveLength(49);
  });

  test('options: 1 000+ messages, no duplicate or detached, a diverged branch, stored and mixed', () => {
    const t0 = performance.now();
    const big = buildStory({ messages: 1200, detachedMessages: 300 });
    expect(performance.now() - t0).toBeLessThan(2000);
    const bz = openZip(big.bytes);
    expect(layoutProblems(bz)).toEqual([]);
    const main = big.facts.chats.main!;
    expect(bz.text(`${main.dir}/messages.jsonl`).split('\n')).toHaveLength(1200);
    expect(main.swipeCounts.filter((n) => n > 1).length).toBeGreaterThan(20);
    expect(main.roles.at(-1)).toBe('assistant');

    const bare = buildStory({ duplicate: false, detached: false, branch: false, storyJsonl: false });
    expect(Object.keys(bare.facts.chats)).toEqual(['main']);
    expect(openZip(bare.bytes).has('story.jsonl')).toBe(false);
    expect(layoutProblems(openZip(bare.bytes))).toEqual([]);

    const dupOfMain = buildStory({ branch: false, detached: false });
    expect(dupOfMain.facts.chats.duplicate!.parentId).toBe(dupOfMain.facts.chats.main!.id);
    expect(dupOfMain.facts.chats.duplicate!.messageIds).toEqual(dupOfMain.facts.chats.main!.messageIds);

    const diverged = buildStory({ branch: 'diverged' }).facts.chats;
    expect(diverged.branch!.startsWithCardGreeting).toBe(true);
    expect(diverged.branch!.messageIds.filter((id) => diverged.main!.messageIds.includes(id))).toEqual([]);
    expect(diverged.branch!.active).toEqual([0, 0, 1]);

    const named = buildStory({ sameNameBook: true, failedChunk: true, seed: 'other' });
    expect(named.facts.books.sameName!.name).toBe(named.facts.books.world!.name);
    expect(named.facts.books.sameName!.path).not.toBe(named.facts.books.world!.path);
    expect(named.facts.chats.main!.id).not.toBe(story.facts.chats.main!.id);
    expect((JSON.parse(openZip(named.bytes).text('manifest.json')) as { failed_chunks: unknown[] }).failed_chunks).toHaveLength(1);

    for (const compression of ['stored', 'mixed'] as const) {
      const z = buildStory({ compression, folders: false, zip: { dataDescriptor: true } });
      const zz = openZip(z.bytes);
      expect(zz.entries.some((e) => e.dir)).toBe(false);
      expect(zz.entries.some((e) => e.method === 0)).toBe(true);
      expect(readZip(z.bytes).map((m) => dec.decode(m.bytes))).toEqual(story.files.map((f) => f.data));
    }
    expect(() => buildStory({ messages: 9 })).toThrow();
  });
});

// ---- the user's own export (read-only, opt-in) --------------------------------------------------------

const REAL = process.env.RP_CORE_RC_EXPORT;

describe('a real export, when RP_CORE_RC_EXPORT names one', () => {
  test.skipIf(!REAL || !existsSync(REAL))('opens, every member checks out, and the members match the manifest', () => {
    const bytes = readFileSync(REAL!);
    expect(isZip(bytes)).toBe(true);
    const members = readZip(bytes);
    expect(members.length).toBeGreaterThan(0);
    expect(layoutProblems(openZip(bytes))).toEqual([]);
  });
});
