// Ported from RoleCall:apps/rc/src/lib/scenes-export/per-chat-export.ts@fb8dc623e (safeName,
// buildCharacterCardV3's row-to-card mapping, the member layout of buildRolecallZip and the record
// order of buildEnrichedJsonl).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test kit for the RoleCall story import (.notes/rcimport-decisions.md D-186, D-194).
// 1. writeZip: a tiny ZIP writer (stored and deflate, JSZip's record layout, optional data
//    descriptors and comment) with `lie` knobs that write false values, for hostile archives.
// 2. buildStory / buildStoryExport: a synthetic `rolecall-story-zip` v1 export in the real shape:
//    manifest.json, story.jsonl, characters/<n>.json (chara_card_v3) + .raw.json, personas/,
//    presets/, lorebooks/, chats/<slug>-<id8>/{chat.json, messages.jsonl, tracker.json,
//    storyboard.json, dm-context.json}. Every name, id and line of text here is invented; nothing
//    comes from a real export. Deterministic: the same options give the same bytes.
// Changes from RoleCall: no JSZip (writeZip writes the same records), no PNG card (the export's
// fallback when the image fetch fails: the v3 JSON), rows built from invented data rather than a
// decrypted bundle. Behaviour reference (facts, not code): RoleCall
// app/api/scenes/[chatId]/export-package/route.ts @fb8dc623e (the manifest stats).

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

// ---- ZIP writer -----------------------------------------------------------------------------------

export interface ZipInput {
  /** The member name as written (UTF-8). A name ending in '/' is a directory record. */
  name: string;
  /** Raw name bytes instead of `name` (for names that are not UTF-8). */
  rawName?: Uint8Array;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate. Default: 8 for a non-empty file, else 0. */
  method?: 0 | 8;
  /** No local record: only a central record pointing at `lie.localOffset` (overlap tests). */
  centralOnly?: boolean;
  /** Values written instead of the true ones, to build hostile archives. */
  lie?: {
    crc?: number;
    size?: number;
    compressedSize?: number;
    flags?: number;
    method?: number;
    localName?: string;
    localOffset?: number;
    centralExtra?: Uint8Array;
    localExtra?: Uint8Array;
  };
}

export interface ZipWriteOptions {
  /** The archive comment after the EOCD record. */
  comment?: string | Uint8Array;
  /** Every record's DOS time stamp (UTC fields). */
  date?: Date;
  /** Flag bit 3: zero CRC and sizes in local headers, a signed data descriptor after the data. */
  dataDescriptor?: boolean;
}

const enc = new TextEncoder();
const bytesOf = (v: Uint8Array | string): Uint8Array => (typeof v === 'string' ? enc.encode(v) : v);

/** Little-endian fields: [width in bytes, value]. */
function le(...fields: Array<[2 | 4, number]>): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [w]) => n + w, 0));
  const v = new DataView(out.buffer);
  let o = 0;
  for (const [w, x] of fields) {
    if (w === 2) v.setUint16(o, x & 0xffff, true);
    else v.setUint32(o, x >>> 0, true);
    o += w;
  }
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const KIT_DATE = new Date('2026-10-01T12:00:00.000Z');

/**
 * A ZIP archive the way JSZip writes one (version needed 1.0, made by 2.0/DOS, directory records
 * with the DOS directory attribute), from `entries` in order.
 */
export function writeZip(entries: readonly ZipInput[], opts: ZipWriteOptions = {}): Uint8Array {
  const { time, date } = dosStamp(opts.date ?? KIT_DATE);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const dir = e.name.endsWith('/');
    const data = dir ? new Uint8Array(0) : bytesOf(e.data ?? '');
    const method = e.method ?? (dir || data.length === 0 ? 0 : 8);
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const lie = e.lie ?? {};
    const name = e.rawName ?? enc.encode(e.name);
    const nonAscii = name.some((b) => b > 0x7f);
    const descriptor = opts.dataDescriptor === true && !dir;
    const flags = lie.flags ?? ((descriptor ? 0x0008 : 0) | (nonAscii && !e.rawName ? 0x0800 : 0));
    const m = lie.method ?? method;
    const crc = lie.crc ?? crc32(data) >>> 0;
    const size = lie.size ?? data.length;
    const csize = lie.compressedSize ?? body.length;
    const localName = lie.localName !== undefined ? enc.encode(lie.localName) : name;
    const localExtra = lie.localExtra ?? new Uint8Array(0);
    const centralExtra = lie.centralExtra ?? new Uint8Array(0);
    const at = lie.localOffset ?? offset;

    if (!e.centralOnly) {
      const local = concatBytes([
        le(
          [4, 0x04034b50],
          [2, 10],
          [2, flags],
          [2, m],
          [2, time],
          [2, date],
          [4, descriptor ? 0 : crc],
          [4, descriptor ? 0 : csize],
          [4, descriptor ? 0 : size],
          [2, localName.length],
          [2, localExtra.length],
        ),
        localName,
        localExtra,
        body,
        descriptor ? le([4, 0x08074b50], [4, crc], [4, csize], [4, size]) : new Uint8Array(0),
      ]);
      parts.push(local);
      offset += local.length;
    }
    central.push(
      concatBytes([
        le(
          [4, 0x02014b50],
          [2, 0x0014],
          [2, 10],
          [2, flags],
          [2, m],
          [2, time],
          [2, date],
          [4, crc],
          [4, csize],
          [4, size],
          [2, name.length],
          [2, centralExtra.length],
          [2, 0],
          [2, 0],
          [2, 0],
          [4, dir ? 0x10 : 0],
          [4, at],
        ),
        name,
        centralExtra,
      ]),
    );
  }
  const cd = concatBytes(central);
  const comment = bytesOf(opts.comment ?? '');
  const eocd = concatBytes([
    le([4, 0x06054b50], [2, 0], [2, 0], [2, central.length], [2, central.length], [4, cd.length], [4, offset], [2, comment.length]),
    comment,
  ]);
  return concatBytes([...parts, cd, eocd]);
}

// ---- the synthetic export: options and facts ----------------------------------------------------

export interface StoryExportOptions {
  /** Varies every id (and nothing else), so two exports can coexist. Default 'kit'. */
  seed?: string;
  /** Messages in the main chat. Default 12; at least 10 (the feature messages are 0-9). */
  messages?: number;
  /**
   * A "Take 2" branch of the main chat at branch_point_index 3. 'matching' (default) copies main's
   * messages 0-2 (same ids, text, swipes, times) and adds two of its own; 'diverged' starts from the
   * card's greeting with ids and text of its own (main's opener replaced after branching).
   */
  branch?: 'matching' | 'diverged' | false;
  /** An exact duplicate of the branch (of main when there is no branch), parent = it. Default true. */
  duplicate?: boolean;
  /** A detached run: parent = main, no branch point/name/title, its own greeting. Default true. */
  detached?: boolean;
  /** Messages in the detached chat. Default 8; at least 6. */
  detachedMessages?: number;
  /** A fifth book named like the world book, with other rows. Default false. */
  sameNameBook?: boolean;
  /** Write story.jsonl. Default true. */
  storyJsonl?: boolean;
  /** List one failed chunk (main, chunk 1) in the manifest; no message is removed. Default false. */
  failedChunk?: boolean;
  /** 'deflate' (default, as RoleCall), 'stored', or 'mixed' (alternating file by file). */
  compression?: 'deflate' | 'stored' | 'mixed';
  /** JSZip's folder records. Default true. */
  folders?: boolean;
  zip?: ZipWriteOptions;
}

export type ChatKey = 'main' | 'branch' | 'duplicate' | 'detached';
export type BookKey = 'world' | 'saga' | 'sagaTwin' | 'compendium' | 'sameName';

export interface KitChat {
  key: ChatKey;
  id: string;
  /** The member folder, `chats/<slug>-<id8>`. */
  dir: string;
  parentId: string | null;
  branchPointIndex: number | null;
  messages: number;
  /** User messages: RoleCall's Director turn. */
  users: number;
  messageIds: string[];
  roles: Array<'user' | 'assistant'>;
  swipeCounts: number[];
  /** Index of the active swipe (the one whose content equals the message's). */
  active: number[];
  /** First message equals the card's first_mes. */
  startsWithCardGreeting: boolean;
  files: string[];
}

export interface KitBook {
  key: BookKey;
  id: string;
  name: string;
  path: string;
  rows: number;
}

export interface StoryFacts {
  seed: string;
  exportedAt: string;
  character: { id: string; name: string; card: string; raw: string; firstMes: string };
  persona: { id: string; name: string; path: string };
  preset: {
    id: string;
    name: string;
    path: string;
    /** The preset the branch chats name; not in the zip. */
    missingId: string;
    prompts: number;
    enabledRows: number;
    /** The main chat's per-prompt toggles for this preset (identifier → enabled). */
    mainOverrides: Record<string, boolean>;
    /** Identifiers present only in the stale `settings` blob. */
    settingsOnly: string[];
  };
  books: Partial<Record<BookKey, KitBook>>;
  /** manifest.chat_ids order (BFS). */
  chatIds: string[];
  chats: Partial<Record<ChatKey, KitChat>>;
  /** Fixed message indices in the main chat. */
  features: {
    customOpener: 0;
    /** 3 swipes, the first one active. */
    activeNotLast: 2;
    /** Starts `<think>` and never closes it. */
    unclosedThink: 4;
    /** `<think>…</think>` then text; 2 swipes, the last active. */
    closedThink: 6;
    /** The second of two assistant messages in a row. */
    sameRolePair: 7;
  };
  /** The detached chat's user→user pair (index of the second), when there is one. */
  detachedUserPair: 4;
  compendium: { typed: number; arcRows: number; consumed: number; consumedIds: string[]; failed: number };
  saga: { arcRows: number; constant: number };
  /** Dirty dm-context rows in the main chat, by RoleCall key: index of each odd row. */
  mainDmDirty: {
    stringArc: number;
    seedWithoutId: number;
    otherShapeInvisibleArc: number;
    stringHiddenEvent: number;
    spreadParallelTimeline: number;
    chapterWithoutCreatedAtTurn: string;
    moodOutsideEnum: string;
  };
  /** Member names in zip order, folders excluded. */
  files: string[];
}

export interface StoryExport {
  bytes: Uint8Array;
  /** Every non-folder member, in zip order, as text. */
  files: Array<{ name: string; data: string }>;
  facts: StoryFacts;
}

// ---- small helpers --------------------------------------------------------------------------------

/** A UUID-shaped id derived from a label (version 4 and variant bits set). */
function uuidFor(seed: string, label: string): string {
  const h = createHash('sha256').update(`${seed}\u0000${label}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** RoleCall's safeName: runs outside [a-z0-9._-] become '_', cut to 80. */
function safeName(s: string, fallback: string): string {
  const cleaned = s.trim().replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
  return cleaned || fallback;
}

/** Postgres' timestamptz text, as the rows carry it. */
const pgTime = (ms: number): string => new Date(ms).toISOString().replace('Z', '000+00:00');

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-01T09:00:00.000Z');

// ---- invented content -----------------------------------------------------------------------------

const CHAR_NAME = 'Tavik Ashvale';
const PERSONA_NAME = 'Wren Calder';
const PRESET_NAME = 'Quill & Lantern v2.1';

const FIRST_MES =
  '*The ferry bell rings twice over Saltmark harbor. Tavik Ashvale looks up from a damp ledger, a lantern swinging above him.* "You are late, and the tide is not."';
const ALT_GREETING = '*Rain on the customs-house roof. Tavik slides a cup of something hot across the counter.* "Sit. Talk."';
const CUSTOM_OPENER =
  '*Night on the breakwater. Somewhere below, a rope creaks against a bollard, and the lighthouse turns its slow eye across the water.*\n\n' +
  'Tavik stands at the end of the stone pier with his collar up, holding a brass key he should not have. When your footsteps reach him he does not turn. "Wren. Tell me you brought the ledger."';

const SCENES = ['the quay', 'the lantern room', 'the fish market', 'the tide gate', 'the chapel steps', 'the ropewalk', 'the customs house', 'the breakwater'];
const ACTS_A = [
  'Tavik sets the lantern down',
  'Tavik laughs under his breath',
  'Tavik turns a page of the ledger',
  'Tavik glances toward the water',
  'Tavik folds his arms against the wind',
  'Tavik pockets the brass key',
  'Tavik leans on the railing',
];
const LINES_A = [
  '"The tide waits for no one, least of all us."',
  '"You kept the bell rope, then. Good."',
  '"Someone has been writing in this ledger after midnight."',
  '"The guild will want an answer before the fog lifts."',
  '"Do not look at the lighthouse. Look at who is watching it."',
  '"I owe the harbormaster a debt I cannot pay in coin."',
];
const ACTS_U = [
  'Wren shakes rain from her coat',
  'Wren counts the coins twice',
  'Wren holds out the ledger',
  'Wren squints at the far shore',
  'Wren taps the brass key',
];
const LINES_U = ['"Then we go tonight."', '"Who else knows about the key?"', '"I am not afraid of the fog."', '"Tell me about the debt."'];

const assistantText = (i: number, chat: string): string =>
  `*${ACTS_A[i % ACTS_A.length]} near ${SCENES[(i * 3) % SCENES.length]}.* ${LINES_A[(i * 5) % LINES_A.length]} (${chat} beat ${i})`;
const userText = (i: number, chat: string): string =>
  `*${ACTS_U[i % ACTS_U.length]}.* ${LINES_U[(i * 3) % LINES_U.length]} (${chat} beat ${i})`;

const SAMPLER = {
  min_p: 0.05,
  top_a: 0,
  top_k: 0,
  top_p: 0.95,
  max_tokens: 1200,
  temperature: 0.9,
  presence_penalty: 0,
  frequency_penalty: 0,
  repetition_penalty: 1,
};

// ---- messages -------------------------------------------------------------------------------------

interface Swipe {
  [k: string]: unknown;
  content: string;
  timestamp: number;
}

interface Message {
  index: number;
  message_id: string;
  role: 'user' | 'assistant';
  is_user: boolean;
  content: string;
  timestamp: number;
  swipes: Swipe[];
}

function message(index: number, id: string, role: 'user' | 'assistant', swipes: Swipe[], active: number): Message {
  return { index, message_id: id, role, is_user: role === 'user', content: swipes[active]!.content, timestamp: swipes[0]!.timestamp, swipes };
}

/** An assistant swipe in one of the shapes RoleCall stores (by index, deterministic). */
function assistantSwipe(i: number, content: string, ts: number, id: string): Swipe {
  if (i < 10 || i % 3 === 0) return { id, content, timestamp: ts, model: 'vendor/model-a' };
  if (i % 3 === 1) {
    return { content, timestamp: ts, model: 'vendor/model-b', generationTimeMs: 4000 + i, presetName: PRESET_NAME, samplerSettings: { ...SAMPLER } };
  }
  return { content, timestamp: ts };
}

function mainMessages(seed: string, n: number, chatId: string): Message[] {
  const out: Message[] = [];
  const at = (i: number): number => T0 + 2 * DAY + i * 137_000;
  const mid = (i: number): string => uuidFor(seed, `msg:${chatId}:${i}`);
  const alt = (i: number, k: number): string => uuidFor(seed, `swipe:${chatId}:${i}:${k}`);
  for (let i = 0; i < n; i++) {
    const ts = at(i);
    const id = mid(i);
    const role: 'user' | 'assistant' = i === 0 || i === 2 || i === 4 || i === 6 || i === 7 ? 'assistant' : i < 8 ? 'user' : i % 2 === 0 ? 'user' : 'assistant';
    if (role === 'user') {
      out.push(message(i, id, 'user', [{ id, content: userText(i, 'main'), timestamp: ts }], 0));
      continue;
    }
    if (i === 0) {
      out.push(message(i, id, 'assistant', [{ id, content: CUSTOM_OPENER, timestamp: ts }], 0));
    } else if (i === 2) {
      // Three swipes, the first one kept: RoleCall does not export which, only the matching text.
      const base = assistantText(i, 'main');
      out.push(
        message(
          i,
          id,
          'assistant',
          [
            { id, content: base, timestamp: ts, model: 'vendor/model-a' },
            { id: alt(i, 1), content: `${base} [second take]`, timestamp: ts + 40_000, model: 'vendor/model-b' },
            {
              id: alt(i, 2),
              content: `${base} [third take]`,
              timestamp: ts + 80_000,
              model: 'vendor/model-b',
              immersionSnapshot: { capturedAt: ts + 80_000, resources: { hp: 10, maxHp: 10, initialized: true } },
            },
          ],
          0,
        ),
      );
    } else if (i === 4) {
      const content =
        '<think>\nWren asked about the key. Tavik should deflect, then give one true detail about the guild.\n\n' +
        assistantText(i, 'main');
      out.push(message(i, id, 'assistant', [{ id, content, timestamp: ts, model: 'vendor/model-a' }], 0));
    } else if (i === 6) {
      const visible = assistantText(i, 'main');
      out.push(
        message(
          i,
          id,
          'assistant',
          [
            { id, content: visible, timestamp: ts, model: 'vendor/model-a' },
            { id: alt(i, 1), content: `<think>\nKeep it short; end on the lighthouse.\n</think>\n\n${visible} [with a plan]`, timestamp: ts + 30_000, model: 'vendor/model-b' },
          ],
          1,
        ),
      );
    } else if (i >= 10 && i % 40 === 21) {
      const base = assistantText(i, 'main');
      out.push(
        message(i, id, 'assistant', [assistantSwipe(i, base, ts, id), { id: alt(i, 1), content: `${base} [retry]`, timestamp: ts + 20_000, model: 'vendor/model-a' }], 1),
      );
    } else {
      out.push(message(i, id, 'assistant', [assistantSwipe(i, assistantText(i, 'main'), ts, id)], 0));
    }
  }
  return out;
}

/** A run that starts from the card's greeting, with a user→user pair at 3-4 and a mid-text think. */
function detachedMessages(seed: string, n: number, chatId: string, label: string, start: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const ts = start + i * 211_000;
    const id = uuidFor(seed, `msg:${chatId}:${i}`);
    const role: 'user' | 'assistant' = i === 0 || i === 2 ? 'assistant' : i < 5 ? 'user' : i % 2 === 1 ? 'assistant' : 'user';
    if (role === 'user') {
      out.push(message(i, id, 'user', [{ id, content: userText(i, label), timestamp: ts }], 0));
    } else if (i === 0) {
      out.push(message(i, id, 'assistant', [{ id, content: FIRST_MES, timestamp: ts }], 0));
    } else if (i === 5) {
      const content = `${assistantText(i, label)}\n\n<think>\nA second thought, mid-reply.\n</think>\n\nThe fog rolls in.`;
      out.push(message(i, id, 'assistant', [{ id, content, timestamp: ts, model: 'vendor/model-a' }], 0));
    } else {
      out.push(message(i, id, 'assistant', [{ id, content: assistantText(i, label), timestamp: ts }], 0));
    }
  }
  return out;
}

function branchMessages(seed: string, chatId: string, kind: 'matching' | 'diverged', main: Message[]): Message[] {
  const own = (i: number, ts: number, role: 'user' | 'assistant', content: string): Message => {
    const id = uuidFor(seed, `msg:${chatId}:${i}`);
    return message(i, id, role, [{ id, content, timestamp: ts }], 0);
  };
  if (kind === 'matching') {
    const after = main[2]!.swipes.at(-1)!.timestamp + 600_000;
    return [
      ...main.slice(0, 3).map((m) => structuredClone(m)),
      own(3, after, 'user', userText(3, 'take-two')),
      own(4, after + 90_000, 'assistant', assistantText(4, 'take-two')),
    ];
  }
  // Older than main's first message: main's opener was replaced after this branch was made.
  const start = T0;
  const first = own(0, start, 'assistant', FIRST_MES);
  const id2 = uuidFor(seed, `msg:${chatId}:2`);
  const base = assistantText(2, 'take-two');
  return [
    first,
    own(1, start + 60_000, 'user', userText(1, 'take-two')),
    message(
      2,
      id2,
      'assistant',
      [
        { id: id2, content: base, timestamp: start + 120_000 },
        { id: uuidFor(seed, `swipe:${chatId}:2:1`), content: `${base} [second take]`, timestamp: start + 150_000, model: 'vendor/model-a' },
      ],
      1,
    ),
  ];
}

// ---- library rows ---------------------------------------------------------------------------------

interface Ids {
  seed: string;
  user: string;
  character: string;
  persona: string;
  preset: string;
  missingPreset: string;
  thirdPreset: string;
}

function characterRow(ids: Ids): Record<string, unknown> {
  const created = T0 - 30 * DAY;
  return {
    id: ids.character,
    name: CHAR_NAME,
    description: 'A harbor clerk in Saltmark who keeps the tide ledger and owes a debt to the harbormaster.',
    personality: 'Dry, watchful, loyal to a fault; jokes when frightened.',
    scenario: 'Saltmark, a fog-bound harbor town where the lighthouse keeper vanished a week ago.',
    first_mes: FIRST_MES,
    mes_example: '<START>\n{{user}}: Where is the keeper?\n{{char}}: *He closes the ledger.* "Not here. That is the problem."',
    alternate_greetings: [ALT_GREETING],
    system_prompt: 'Write {{char}} in third person, present tense.',
    post_history_instructions: 'Keep replies under 300 words.',
    creator_notes: '',
    character_version: null,
    creator_id: ids.user,
    tagline: 'Keeper of the tide ledger',
    card_layout: 'classic',
    accent_color: '#3a6b8c',
    genre: null,
    fandom: null,
    token_count: 512,
    download_count: 0,
    favorite_count: 0,
    chat_count: 3,
    image_url: null,
    thumbnail_url: null,
    spec_version: '2.0',
    creation_tool: 'rolecall',
    source_url: null,
    extensions: {},
    is_featured: false,
    status: 'private',
    created_at: pgTime(created),
    updated_at: pgTime(created + DAY),
    published_at: null,
    import_source: null,
    forked_from_id: null,
    deleted_at: null,
    sprites: null,
    details: {
      age: '31',
      title: 'Tide Clerk',
      colors: [{ hex: '#2f3e46', name: 'Slate', label: 'Hair' }],
      pronouns: 'he/him',
      full_name: 'Tavik Ashvale',
      groupSize: 1,
      genderCounts: {},
      gradient_colors: ['#3a6b8c', '#a3c4bc'],
      signature_color: { hex: '#3a6b8c', name: 'Harbor Blue', label: 'Signature' },
    },
    language: 'en',
    card_format: 'v2',
    greeting_count: 2,
    whispers_enabled: false,
    vn_playbill: null,
    current_version_number: '1',
    version_count: 1,
    slug: 'tavik-ashvale',
    collection_id: null,
  };
}

/** The v3 card RoleCall builds from the row (no character_book; lorebooks ship separately). */
function characterCard(row: Record<string, unknown>): Record<string, unknown> {
  const str = (k: string): string => (typeof row[k] === 'string' ? (row[k] as string) : '');
  const strs = (k: string): string[] => (Array.isArray(row[k]) ? (row[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: str('name'),
      description: str('description'),
      personality: str('personality'),
      scenario: str('scenario'),
      first_mes: str('first_mes'),
      mes_example: str('example_messages') || str('mes_example'),
      creator_notes: str('creator_notes'),
      system_prompt: str('system_prompt'),
      post_history_instructions: str('post_history_instructions'),
      alternate_greetings: strs('alternate_greetings'),
      tags: strs('tags'),
      creator: str('creator') || str('creator_name'),
      character_version: str('character_version') || '1.0',
      assets: [],
      group_only_greetings: [],
      creation_date: Math.floor(Date.parse(String(row.created_at)) / 1000),
      modification_date: Math.floor(Date.parse(String(row.updated_at)) / 1000),
      extensions: { rolecall: { id: row.id, source_export: 'rolecall-story-zip-v1' } },
    },
  };
}

function personaRow(ids: Ids, worldBookId: string): Record<string, unknown> {
  const created = T0 - 20 * DAY;
  const order = ['personality', 'appearance', 'history', 'quirks'];
  return {
    id: ids.persona,
    creator_id: ids.user,
    name: PERSONA_NAME,
    description: 'A courier who carries sealed letters between Saltmark and the islands.',
    content: '',
    image_url: null,
    deprecated_column: false,
    favorite_count: 0,
    use_count: 4,
    created_at: pgTime(created),
    updated_at: pgTime(created + DAY),
    deleted_at: null,
    status: 'private',
    forked_from_id: null,
    original_creator_id: null,
    forked_at: null,
    fork_count: 0,
    details: {
      emoji: '🧭',
      title: 'Island Courier',
      colors: [
        { hex: '#c8a27a', name: 'Sand', label: 'Skin' },
        { hex: '#5b3a29', name: 'Chestnut', label: 'Hair' },
        { hex: '#4a7c59', name: '', label: 'Eyes' },
      ],
      quirks: 'Whistles when lying.',
      history: 'Grew up on the ferry.\n\n\nLost her father to the Grey Tide.',
      tagline: 'Letters, not questions',
      pronouns: 'she/her',
      appearance: 'Wiry, salt-stained coat, a satchel of <letters> & seals.',
      lorebook_id: worldBookId,
      personality: 'Quick, stubborn, kind to animals.\n\nHates being pitied.',
      traits: ['Stubborn', 'Quick'],
      age: '26',
      height: 'Short',
      section_order: order,
      signatureColor: { hex: '#4a7c59', name: 'Kelp', label: 'Signature' },
      injection_depth: 4,
      injection_position: 'character',
    },
    is_after_dark: false,
    section_order: order,
    content_rating: 'all_hours',
    manual_rating_override: null,
    is_original_creation: true,
    is_custom_variant: false,
    current_version_id: uuidFor(ids.seed, 'persona-version'),
    current_version_number: 1,
    version_count: 1,
    slug: 'wren-calder',
    accent_color: '#4a7c59',
    au_id: null,
    collection_id: null,
    moderation_metadata: null,
  };
}

interface PromptSpec {
  identifier: string;
  name: string;
  role?: 'system' | 'user' | 'assistant';
  enabled: boolean;
  marker?: boolean;
  content?: string;
  depth?: number;
  category?: string;
  systemPrompt?: boolean;
}

const PROMPTS: PromptSpec[] = [
  { identifier: 'main', name: 'Main Prompt', enabled: false, systemPrompt: true, content: "Write {{char}}'s next reply in a fictional chat with {{user}}." },
  { identifier: 'qt_frame', name: 'Frame', enabled: true, category: 'Frame', content: 'You are the narrator of a harbor mystery. {{trim}}' },
  {
    identifier: 'qt_vars',
    name: 'Variables',
    enabled: true,
    category: 'Frame',
    content: '{{setvar::tone::warm}}{{setvar::pace::2}}Tone: {{getvar::tone}}.',
  },
  {
    identifier: 'qt_branch',
    name: 'Tone switch',
    enabled: true,
    category: 'Frame',
    content: '{{if .tone == warm}}Let small kindnesses show.{{else}}Keep it cold.{{/if}} Pace {{.pace}}.',
  },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', enabled: true, marker: true },
  { identifier: 'charDescription', name: 'Char Description', enabled: false, marker: true },
  { identifier: 'charPersonality', name: 'Char Personality', enabled: false, marker: true },
  { identifier: 'scenario', name: 'Scenario', enabled: false, marker: true },
  { identifier: 'personaDescription', name: 'Persona Description', enabled: false, marker: true },
  { identifier: 'qt_card', name: 'Card block', enabled: true, category: 'Cast', content: '<char>\n{{description}}\n{{personality}}\n{{scenario}}\n</char>' },
  { identifier: 'qt_persona', name: 'Persona block', enabled: true, category: 'Cast', content: '<user>\n{{persona}}\n</user>' },
  { identifier: 'qt_style_plain', name: 'Style: plain', enabled: true, category: 'Voices', content: 'Plain sentences. No purple prose.' },
  { identifier: 'qt_style_lyric', name: 'Style: lyric', enabled: false, category: 'Voices', content: 'Let the sea into the sentences.' },
  { identifier: 'qt_dice', name: 'Dice', enabled: true, category: 'Voices', content: 'Luck today: {{random::1::6}}.' },
  { identifier: 'dialogueExamples', name: 'Chat Examples', enabled: false, marker: true },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', enabled: true, marker: true },
  { identifier: 'chatHistory', name: 'Chat History', enabled: true, marker: true },
  { identifier: 'qt_depth_note', name: 'Depth note', enabled: true, depth: 2, content: '[Remember the fog hides the lighthouse.]' },
  { identifier: 'qt_user_nudge', name: 'User nudge', role: 'user', enabled: false, content: 'Continue the scene.' },
  { identifier: 'qt_prefill', name: 'Prefill', role: 'assistant', enabled: true, content: '*' },
];

const CATEGORIES: Array<{ name: string; parent?: string }> = [{ name: 'Frame' }, { name: 'Cast' }, { name: 'Style' }, { name: 'Voices', parent: 'Style' }];

/** The main chat's toggles: switch the style pair and turn the user nudge on. */
const MAIN_OVERRIDES: Record<string, boolean> = { qt_style_plain: false, qt_style_lyric: true, qt_user_nudge: true };

function presetRow(ids: Ids): Record<string, unknown> {
  const created = T0 - 10 * DAY;
  const catId = (name: string): string => uuidFor(ids.seed, `preset-category:${name}`);
  const categories = CATEGORIES.map((c, i) => ({
    id: catId(c.name),
    preset_id: ids.preset,
    name: c.name,
    content: '',
    sort_order: i,
    created_at: pgTime(created + i * 1000),
    updated_at: pgTime(created + i * 1000),
    parent_id: c.parent ? catId(c.parent) : null,
    enabled: true,
  }));
  const prompts = PROMPTS.map((p, i) => ({
    id: uuidFor(ids.seed, `preset-prompt:${p.identifier}`),
    preset_id: ids.preset,
    category_id: p.category ? catId(p.category) : null,
    identifier: p.identifier,
    name: p.name,
    content: p.content ?? '',
    role: p.role ?? 'system',
    enabled: p.enabled,
    system_prompt: p.systemPrompt ?? false,
    marker: p.marker ?? false,
    injection_position: p.depth !== undefined ? '1' : '0',
    injection_depth: p.depth ?? 4,
    injection_order: 100,
    forbid_overrides: false,
    is_default: p.marker ?? false,
    sort_order: i,
    created_at: pgTime(created + 60_000 + i * 1000),
    updated_at: pgTime(created + 60_000 + i * 1000),
    injection_trigger: [],
    metadata: {},
  }));
  // The ST file as first imported: one prompt the rows no longer have, one enabled flag that the
  // rows have since changed. Neither is what RoleCall sends.
  const stale = PROMPTS.map((p) => ({
    name: p.name,
    role: p.role ?? 'system',
    content: p.content ?? '',
    identifier: p.identifier,
    system_prompt: p.systemPrompt ?? false,
    injection_depth: p.depth ?? 4,
    injection_order: 100,
    forbid_overrides: false,
    injection_trigger: [],
    injection_position: p.depth !== undefined ? 1 : 0,
    ...(p.marker ? { marker: true } : {}),
  }));
  stale.push({
    name: 'Legacy only',
    role: 'system',
    content: 'An old rule.',
    identifier: 'qt_legacy_only',
    system_prompt: false,
    injection_depth: 4,
    injection_order: 100,
    forbid_overrides: false,
    injection_trigger: [],
    injection_position: 0,
  });
  const order = [...PROMPTS.map((p) => ({ identifier: p.identifier, enabled: p.identifier === 'qt_dice' ? false : p.enabled })), { identifier: 'qt_legacy_only', enabled: true }];
  const settings = {
    temperature: 0.9,
    top_p: 0.95,
    top_k: 0,
    top_a: 0,
    min_p: 0.05,
    presence_penalty: 0,
    frequency_penalty: 0,
    repetition_penalty: 1,
    openai_max_context: 32000,
    openai_max_tokens: 1200,
    names_behavior: 0,
    send_if_empty: '',
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',
    new_chat_prompt: '[Start a new Chat]',
    continue_nudge_prompt: '[Continue your last message.]',
    assistant_prefill: '',
    stream_openai: true,
    show_thoughts: false,
    reasoning_effort: 'medium',
    prompts: stale,
    prompt_order: [
      { character_id: 100000, order: order.map((o) => ({ ...o })) },
      { character_id: 100001, order },
    ],
    extensions: {},
  };
  return {
    id: ids.preset,
    name: PRESET_NAME,
    description: 'A compact narrator preset for slow mysteries.',
    creator_id: ids.user,
    temperature: 0.9,
    max_context: 32000,
    max_tokens: 1200,
    download_count: 0,
    favorite_count: 0,
    settings,
    is_featured: false,
    status: 'draft',
    created_at: pgTime(created),
    updated_at: pgTime(created + DAY),
    search_vector: null,
    style: null,
    content_hash: null,
    icon: 'feather',
    source_format: 'legacy',
    frequency_penalty: 0,
    presence_penalty: 0,
    top_p: 0.95,
    top_k: 0,
    top_a: 0,
    min_p: 0.05,
    repetition_penalty: 1,
    system_prompts: {
      new_chat_prompt: '[Start a new Chat]',
      assistant_prefill: '',
      group_nudge_prompt: '',
      impersonation_prompt: '',
      continue_nudge_prompt: '[Continue your last message.]',
      new_group_chat_prompt: '',
      assistant_impersonation: '',
      new_example_chat_prompt: '[Example Chat]',
    },
    template_formats: { wi_format: '{0}', scenario_format: '{{scenario}}', personality_format: '{{personality}}' },
    behavior: { send_if_empty: '', names_behavior: 0, wrap_in_quotes: false, continue_postfix: ' ', continue_prefill: false },
    api_options: {
      show_thoughts: false,
      stream_openai: true,
      request_images: false,
      function_calling: false,
      reasoning_effort: 'medium',
      enable_web_search: false,
      claude_use_sysprompt: false,
      squash_system_messages: false,
      use_makersuite_sysprompt: false,
    },
    media_settings: { imageInlining: false, videoInlining: false, inlineImageQuality: 'auto' },
    generation_settings: { n: 1, seed: -1, biasPresetSelected: '', maxContextUnlocked: false },
    raw_settings: { verbosity: 'medium', extensions: {}, use_sysprompt: false, media_inlining: false, tool_reasoning_mode: 'auto' },
    accent_color: '#6c5b7b',
    forked_from_id: null,
    original_creator_id: null,
    fork_count: 0,
    import_source: 'file',
    deleted_at: null,
    current_version_id: uuidFor(ids.seed, 'preset-version'),
    current_version_number: '1',
    version_count: 1,
    model_families: [],
    slug: 'quill-lantern-v2-1',
    language: 'en',
    api_type: null,
    instruct_format: null,
    is_after_dark: false,
    image_url: null,
    prompt_post_processing: null,
    content_rating: 'all_hours',
    edition_kind: 'standard',
    edition_sync_state: 'ready',
    collection_id: null,
    categories,
    prompts,
  };
}

// ---- lorebooks ------------------------------------------------------------------------------------

interface RowSpec {
  key: string;
  title: string;
  content: string;
  keys?: Array<string | { keyword: string; isRegex: boolean }>;
  constant?: boolean;
  enabled?: boolean;
  position?: string;
  depth?: number;
  metadata?: Record<string, unknown>;
  origin?: 'created' | 'forked' | 'initial';
  originSourceId?: string | null;
}

function entryRow(seed: string, bookId: string, i: number, spec: RowSpec, created: number): Record<string, unknown> {
  return {
    id: uuidFor(seed, `entry:${bookId}:${spec.key}`),
    lorebook_id: bookId,
    title: spec.title,
    content: spec.content,
    comment: null,
    enabled: spec.enabled ?? true,
    constant: spec.constant ?? false,
    trigger_mode: 'simple',
    triggers: (spec.keys ?? []).map((k) => (typeof k === 'string' ? { keyword: k, isRegex: false } : k)),
    case_sensitive: null,
    match_whole_words: null,
    scan_depth: null,
    position: spec.position ?? 'character',
    depth: spec.depth ?? 4,
    role: 'system',
    sort_order: i,
    priority: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    group_name: null,
    group_weight: 1,
    probability: 100,
    use_memo: false,
    allow_recursion: false,
    scan_character_description: false,
    scan_user_persona: false,
    token_count: null,
    created_at: pgTime(created + i * 1000),
    updated_at: pgTime(created + i * 1000),
    origin: spec.origin ?? 'created',
    origin_source_id: spec.originSourceId ?? null,
    boost_ids: [],
    secondary_triggers: null,
    selective_logic: 'and_any',
    exclude_recursion: false,
    prevent_recursion: false,
    delay_until_recursion: 0,
    character_filter: null,
    scan_character_personality: false,
    scan_scenario: false,
    scan_preset: false,
    ignore_budget: false,
    side_effects: null,
    category_id: null,
    metadata: spec.metadata ?? {},
    probability_mode: 'highest',
    is_featured: false,
    boost_amount: 0,
  };
}

interface BookSpec {
  id: string;
  name: string;
  type: 'world' | 'character';
  description: string;
  budget: number;
  forkedFrom: string | null;
  hasTree: boolean;
  created: number;
}

function bookRow(seed: string, b: BookSpec, entries: Array<Record<string, unknown>>, user: string): Record<string, unknown> {
  const typed = entries.filter((e) => typeof (e.metadata as Record<string, unknown>).entry_type === 'string').length;
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    creator_id: user,
    lorebook_type: b.type,
    genre: null,
    fandom: null,
    entry_count: entries.length,
    total_tokens: entries.length * 60,
    download_count: 0,
    favorite_count: 0,
    is_featured: false,
    status: 'private',
    created_at: pgTime(b.created),
    updated_at: pgTime(b.created + DAY),
    search_vector: null,
    rating_sum: 0,
    rating_count: 0,
    is_soft_hidden: false,
    review_status: 'pending',
    last_reviewed_at: null,
    import_source: null,
    forked_from_id: b.forkedFrom,
    original_creator_id: null,
    forked_at: b.forkedFrom ? pgTime(b.created) : null,
    fork_count: 0,
    deleted_at: null,
    global_case_sensitive: false,
    global_match_whole_words: false,
    global_scan_depth: 100,
    global_recursion: false,
    token_budget: b.budget,
    current_version_number: '1',
    version_count: 1,
    current_branch_id: null,
    deprecated_column: false,
    is_staff_pick: false,
    language: 'en',
    forked_from: null,
    imported_from: null,
    is_after_dark: false,
    image_url: null,
    thumbnail_url: null,
    content_rating: 'all_hours',
    manual_rating_override: null,
    budget_mode: 'token',
    entry_budget: 20,
    default_sort: 'sort_order',
    default_sort_direction: 'asc',
    fork_snapshot: null,
    current_version_id: uuidFor(seed, `book-version:${b.id}`),
    fork_depth: b.forkedFrom ? 1 : 0,
    repertoire_count: 0,
    published_at: null,
    slug: safeName(b.name, 'book').toLowerCase(),
    compendium_entry_count: typed,
    has_tree: b.hasTree,
    accent_color: '#5c7a8a',
    rating_average: 0,
    library_locked: false,
    au_id: null,
    world_state_revision: 0,
    world_state_revision_floor: 0,
    scene_fork_source_chat_id: null,
    scene_fork_source_message_id: null,
    scene_fork_source_lorebook_id: null,
    scene_fork_source_lorebook_name: null,
    scene_fork_source_message_label: null,
    scene_fork_status: null,
    world_state_tracked: false,
    collection_id: null,
    entries,
  };
}

const WORLD_ROWS: RowSpec[] = [
  { key: 'saltmark', title: 'Saltmark', content: 'A harbor town of slate roofs and bells. Fog most nights.', keys: ['Saltmark', 'harbor town'], position: 'world' },
  { key: 'lighthouse', title: 'The Lighthouse', content: 'Its keeper vanished a week ago; the lamp still turns.', keys: ['lighthouse', { keyword: '/light ?house(s)?/i', isRegex: true }] },
  { key: 'bells', title: 'Bell Law', content: 'Two rings: ferry. Three: fire. Five: the tide gate closes.', constant: true, position: 'before_example' },
  { key: 'guild', title: 'Saltmark Guild', content: 'Merchants who own the quay and most debts in town.', keys: ['guild'], position: 'depth', depth: 3 },
  { key: 'ferry', title: 'The Ferry', content: 'Runs to the islands twice a day, weather allowing.', keys: ['ferry'] },
  { key: 'old-chapel', title: 'Old Chapel', content: 'Closed since the flood.', keys: ['chapel'], enabled: false },
];

const SAME_NAME_ROWS: RowSpec[] = [
  { key: 'islands', title: 'The Islands', content: 'Three rocks with a post office each.', keys: ['islands'] },
  { key: 'post', title: 'Island Post', content: 'Letters wait a week for a calm sea.', keys: ['letters', 'post'] },
];

function sagaRows(chatId: string): RowSpec[] {
  const arc = (key: string, title: string, content: string): RowSpec => ({
    key,
    title,
    content,
    constant: true,
    metadata: { chatId, source: 'tv_arc_overview', turnNumber: 12 },
  });
  return [
    { key: 'tavik', title: 'Tavik Ashvale', content: 'Tide clerk. Owes the harbormaster.', keys: ['Tavik'], constant: true },
    { key: 'maren', title: 'Maren Holt', content: 'The harbormaster: patient, exact, never forgets a debt.', keys: ['Maren', 'harbormaster'] },
    { key: 'ledger', title: 'The Tide Ledger', content: 'Someone writes in it after midnight.', keys: ['ledger'] },
    { key: 'key', title: 'Brass Key', content: 'Opens the lantern room. Tavik should not have it.', keys: ['brass key', 'key'] },
    arc('arc-debt', '[Arc] The Lantern Debt', 'Tavik must repay Maren before the equinox tide, or lose the ledger.'),
    arc('arc-keeper', '[Arc] The Missing Keeper', 'Where the lighthouse keeper went, and who keeps the lamp turning.'),
  ];
}

interface TypedSpec {
  key: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
  constant?: boolean;
}

const TYPED: TypedSpec[] = [
  { key: 't-maren', type: 'character', title: 'Maren Holt', data: { name: 'Maren Holt', description: 'The harbormaster.', role: 'rival', aliases: ['the harbormaster'], personality: { traits: ['exact', 'patient'] } } },
  { key: 't-lantern', type: 'location', title: 'The Brine Lantern', data: { name: 'The Brine Lantern', type: 'building', description: 'A smoky inn by the quay.', atmosphere: { mood: 'smoky' } } },
  { key: 't-ledger', type: 'item', title: 'Tide Ledger', data: { name: 'Tide Ledger', type: 'document', description: 'Tide tables and debts.', condition: 'damaged' } },
  { key: 't-guild', type: 'organization', title: 'Saltmark Guild', data: { name: 'Saltmark Guild', type: 'guild', description: 'Owns the quay.', goals: ['control the ferry'] } },
  {
    key: 't-bells',
    type: 'event',
    title: 'The Night of Two Bells',
    data: { name: 'The Night of Two Bells', type: 'personal', description: 'The ferry bell rang with no ferry.', participants: ['Tavik', 'Wren'], significance: 'notable', how_remembered: 'As a joke, at first.', items_involved: ['Tide Ledger'] },
  },
  { key: 't-ferryman', type: 'plot', title: 'The Missing Ferryman', data: { name: 'The Missing Ferryman', type: 'mystery', status: 'active', description: 'The ferryman left no note.', goal: 'Find him before the guild does.' } },
  { key: 't-tide', type: 'threat', title: 'The Grey Tide', data: { name: 'The Grey Tide', nature: 'environmental', scope: 'local', severity: 'major', status: 'stirring', description: 'A tide that comes in wrong.' } },
  { key: 't-belllaw', type: 'worldbuilding', title: 'Bell Law', data: { topic: 'Bell Law', category: 'custom', description: 'What each bell count means.', rules: ['Five rings close the tide gate.'] } },
  {
    key: 't-recap',
    type: 'summary',
    title: 'First Nights',
    data: { title: 'First Nights', summary: 'Wren arrives; the key changes hands.', significance: 'moderate', messages_covered: 40, turn_range: { start: 1, end: 20 } },
  },
  { key: 't-heron', type: 'creature', title: 'Fog Heron', data: { name: 'Fog Heron', classification: 'bird', rarity: 'uncommon', description: 'Only seen in fog.' } },
  { key: 't-tidesense', type: 'power', title: 'Tidesense', data: { name: 'Tidesense', category: 'utility', source: 'innate', description: 'Knowing the tide without looking.' } },
  {
    key: 't-arc-debt',
    type: 'plot',
    title: '[Arc] The Lantern Debt',
    constant: true,
    data: { name: 'The Lantern Debt', type: 'main_quest', status: 'active', description: 'Repay Maren before the equinox tide.' },
  },
];

function compendiumRows(seed: string, bookId: string, chatId: string, sagaBookId: string): RowSpec[] {
  const at = '2026-03-20T10:00:00.000000+00:00';
  const typed: RowSpec[] = TYPED.map((t) => ({
    key: t.key,
    title: t.title,
    content: `${t.title}\n${String(t.data.description ?? t.data.summary ?? '')}`,
    keys: [t.title.replace('[Arc] ', '')],
    constant: t.constant ?? false,
    metadata: {
      chatId,
      source: 'tv_compendium',
      entry_type: t.type,
      standardized_at: at,
      structured_data: t.data,
      standardization_state: 'standardized',
      original_classic_content: `${t.title}: ${String(t.data.description ?? '')}`,
    },
  }));
  const typedId = (key: string): string => uuidFor(seed, `entry:${bookId}:${key}`);
  return [
    ...typed,
    // An untyped [Arc] row: an overview the tree builder reads by its title.
    { key: 'u-arc-keeper', title: '[Arc] The Missing Keeper', content: 'Where the keeper went.', constant: true, metadata: { chatId, source: 'tv_compendium' } },
    // Originals whose data was split into typed rows; RoleCall leaves them enabled.
    {
      key: 'c-maren',
      title: 'Maren (old note)',
      content: 'Maren Holt, harbormaster; also runs the guild ledger.',
      keys: ['Maren'],
      metadata: {
        chatId,
        source: 'tv_compendium',
        consumed_at: at,
        consumed_by_entry_id: typedId('t-maren'),
        standardization_state: 'consumed_by_split',
        original_classic_content: 'Maren Holt, harbormaster; also runs the guild ledger.',
      },
    },
    {
      key: 'c-bells',
      title: 'Bells (old note)',
      content: 'Two bells, no ferry: the night it started.',
      keys: ['bells'],
      metadata: {
        chatId,
        source: 'tv_compendium',
        consumed_at: at,
        consumed_by_entry_id: typedId('t-bells'),
        standardization_state: 'consumed_by_split',
        original_classic_content: 'Two bells, no ferry: the night it started.',
      },
    },
    {
      key: 'f-fog',
      title: 'Fog',
      content: 'It smells of iron.',
      keys: ['fog'],
      metadata: { chatId, source: 'tv_compendium', standardization_state: 'failed', standardization_error: 'no type fits', standardization_failed_at: at },
    },
    {
      key: 'k-tavik',
      title: 'Tavik Ashvale',
      content: 'Tide clerk. Owes the harbormaster.',
      keys: ['Tavik'],
      constant: true,
      origin: 'forked',
      originSourceId: uuidFor(seed, `entry:${sagaBookId}:tavik`),
    },
    {
      key: 's-swipe',
      title: 'Lamp Oil',
      content: 'The lamp burns whale oil, not paraffin.',
      keys: ['lamp oil'],
      metadata: { chatId, source: 'tv_compendium', _created_by_swipe: true, turnNumber: 3 },
    },
  ];
}

// ---- chats ----------------------------------------------------------------------------------------

function chatConfig(ids: Ids, books: { world: string; managed: Array<{ id: string; primary: boolean; managed: boolean }> }, kind: ChatKey): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model_id: 'vendor/model-a',
    provider_id: 'openrouter',
    preset_id: kind === 'branch' || kind === 'duplicate' ? ids.missingPreset : ids.preset,
    dmEnabled: kind === 'main' || kind === 'detached',
    dmModelId: 'vendor/model-c',
    dmProviderId: 'openrouter',
    lorebook_ids: [books.world],
    active_persona_id: ids.persona,
    variant_id: null,
    selected_greeting_index: 0,
    chatTitle: null,
    sampler_overrides: {
      stream: true,
      values: {
        temperature: 0.85,
        min_p: 0.05,
        top_p: 0.95,
        enable_thinking: true,
        reasoning_effort: 'medium',
        logit_bias: kind === 'detached' ? [{ id: uuidFor(ids.seed, 'bias:1'), text: 'suddenly', value: -50 }] : null,
      },
      enabled: { clear_thinking: false, enable_thinking: true, reasoning_effort: true },
      prefill: '',
      showPrefill: false,
      promptPostProcessing: 'none',
    },
    preset_sampler_overrides: {
      minP: 0.05,
      topA: 0,
      topK: 0,
      topP: 0.95,
      maxTokens: 1500,
      maxContext: 64000,
      temperature: 0.85,
      presencePenalty: 0,
      frequencyPenalty: 0,
      repetitionPenalty: 1,
      promptPostProcessing: 'none',
    },
    messageStyle: 'novel',
    messageLayout: 'bubbles',
    layoutSize: 'medium',
    compactMode: false,
    showAvatars: true,
    showTimestamps: false,
    typingIndicator: true,
    groupedAlignment: 'left',
  };
  if (kind === 'main') {
    return {
      ...base,
      dmMode: 'full',
      dmPersonality: 'the-chronicler',
      dmAutoRetryInvalidTools: true,
      agentLoopEnabled: true,
      agentLoopMaxTurns: 2,
      autoScroll: true,
      mind_enabled: true,
      regex_script_ids: [],
      preset_prompt_overrides: {
        [ids.preset]: { ...MAIN_OVERRIDES },
        [ids.thirdPreset]: { qt_other_rule: true },
      },
      summary_prompts: {
        summary_mode: 'replace',
        summary_model: { model_id: 'vendor/model-d', provider_id: 'openrouter' },
        memory_model: { model_id: 'vendor/model-e', provider_id: 'openrouter' },
        summary_interval: 50,
        memory_chunk_size: 50,
        memory_window_size: 10,
        summary_max_tokens: 150,
        summary_temperature: 0.3,
        chat_summary_prompt: 'Summarize the story so far.',
        memory_prompt: 'List what matters.',
      },
      immersionModules: {
        relationships: { enabled: true, subFeatures: { emotions: true, memories: true } },
        calendar: { enabled: true, subFeatures: { events: true } },
        gossip: { enabled: true, subFeatures: { spread: true } },
        quests: { enabled: false },
        knowledge: { enabled: false, subFeatures: { reliability: true } },
      },
      tv_enabled: true,
      tv_model_id: 'vendor/model-c',
      tv_provider_id: 'openrouter',
      tv_managed_lorebooks: books.managed.map((m) => ({ is_primary: m.primary, tv_managed: m.managed, lorebook_id: m.id, suppress_keywords: true })),
      tv_summary_interval: 20,
      tv_summary_constant: true,
      tv_mandatory_tool: true,
      tv_mandatory_depth: 0,
      tv_mandatory_position: 'system',
      tv_experimental_compendium: true,
    };
  }
  if (kind === 'detached') {
    return {
      ...base,
      dmPersonality: 'the-weaver',
      preset_prompt_overrides: { [ids.preset]: { qt_style_lyric: true } },
      immersionModules: { knowledge: { enabled: true }, memoryJournal: { enabled: true }, quests: { enabled: true } },
    };
  }
  return base;
}

function chatRecord(c: {
  id: string;
  parent: string | null;
  main: boolean;
  branchName: string | null;
  bpi: number | null;
  title: string | null;
  summary: string | null;
  activeLorebooks: unknown[];
  config: Record<string, unknown>;
  count: number;
  created: number;
  last: number;
}): Record<string, unknown> {
  return {
    id: c.id,
    parent_chat_id: c.parent,
    is_main_timeline: c.main,
    branch_name: c.branchName,
    branch_point_index: c.bpi,
    title: c.title,
    summary: c.summary,
    active_persona_id: c.config.active_persona_id,
    active_lorebooks: c.activeLorebooks,
    config: c.config,
    // Stale in RoleCall: the main timeline says 0 whatever it holds.
    message_count: c.main ? 0 : c.count,
    total_tokens: 0,
    created_at: pgTime(c.created),
    updated_at: pgTime(c.last),
    last_message_at: pgTime(c.last),
  };
}

// ---- dm-context, tracker, storyboard --------------------------------------------------------------

function mainDmContext(seed: string, turn: number, ts: string): { data: Record<string, unknown>; dirty: StoryFacts['mainDmDirty'] } {
  const arcs: unknown[] = [
    {
      id: 'the_lantern_debt',
      scope: 'player',
      title: 'The Lantern Debt',
      stages: [
        { turn: 1, title: 'The key changes hands', timestamp: ts, description: 'Tavik takes the key.' },
        { turn: Math.max(2, turn - 2), title: 'Maren names a date', timestamp: ts, description: 'The equinox tide.' },
      ],
      status: 'building',
      arcType: 'main',
      horizon: 'medium',
      priority: 'urgent',
      rigidity: 'loose',
      chapterId: 'chapter_2',
      createdAt: ts,
      updatedAt: ts,
      description: 'Repay Maren before the equinox tide.',
      turnsActive: turn - 1,
      lastProgressTurn: Math.max(2, turn - 2),
      nextBeat: { status: 'planned', description: 'Maren sends a reminder.', plannedAtTurn: turn },
      plannedBeats: ['a reminder', 'a deadline'],
      plantedSeeds: ["The keeper's spare lamp"],
      completedBeats: ['the key'],
      involvedCharacters: ['Tavik', 'Maren'],
      setupsWithoutPayoff: 1,
    },
    {
      id: 'chapter_1_arrival',
      scope: 'player',
      title: 'Arrival',
      stages: [{ turn: 0, title: 'Wren lands', timestamp: ts, description: 'Off the ferry.' }],
      status: 'complete',
      arcType: 'side',
      horizon: 'medium',
      priority: 'background',
      rigidity: 'loose',
      chapterId: 'chapter_1',
      createdAt: ts,
      updatedAt: ts,
      description: 'Wren finds her feet.',
      turnsActive: 3,
      plannedBeats: [],
      plantedSeeds: [],
      completedBeats: ['landing'],
      involvedCharacters: ['Wren'],
      setupsWithoutPayoff: 0,
    },
    'the_missing_keeper: an arc the old Director wrote as plain text',
    {
      id: 'the_grey_tide',
      scope: 'world',
      title: 'The Grey Tide',
      stages: [],
      status: 'climax',
      arcType: 'mystery',
      horizon: 'medium',
      priority: 'active',
      rigidity: 'firm',
      chapterId: 'chapter_2',
      createdAt: ts,
      updatedAt: ts,
      description: 'The tide comes in wrong.',
      turnsActive: 2,
      plannedBeats: [],
      plantedSeeds: [],
      completedBeats: [],
      involvedCharacters: [],
      setupsWithoutPayoff: 0,
    },
  ];
  const seeds: unknown[] = [
    {
      id: "The keeper's spare lamp",
      hint: 'A second lamp hangs unlit in the lantern room.',
      scope: 'player',
      payoff: 'The keeper left a signal.',
      turnsActive: turn - 1,
      payoffHorizon: 'medium',
      plantedAtTurn: 1,
      reinforcements: [{ turn: 2, description: 'Wren notices the hook.' }],
      relatedArcId: 'the_lantern_debt',
      payoffDelivered: false,
    },
    {
      id: 'seed_1_2',
      hint: 'Maren never writes in ink.',
      scope: 'world',
      payoff: 'The midnight writer is not Maren.',
      payoffTurn: 3,
      turnsActive: 2,
      payoffHorizon: 'short',
      plantedAtTurn: 1,
      reinforcements: [],
      payoffDelivered: true,
    },
    {
      hint: 'A heron that only comes with the fog.',
      scope: 'world',
      payoff: 'Fog herons nest where the keeper hides.',
      turnsActive: 1,
      payoffHorizon: 'immediate',
      plantedAtTurn: 2,
      reinforcements: [],
      payoffDelivered: false,
    },
  ];
  const invisible: unknown[] = [
    {
      id: 'iarc_1_1',
      scope: 'world',
      title: 'The Guild Buys the Ferry',
      stages: [{ turn: 2, title: 'An offer', timestamp: ts, description: 'Quietly made.' }],
      status: 'hidden',
      arcType: 'faction',
      horizon: 'immediate',
      createdAt: ts,
      updatedAt: ts,
      description: 'The guild wants the ferry.',
      playerClues: [{ clue: 'New paint on the ferry.', turn: 3 }],
      turnsActive: 2,
      plannedBeats: [],
      surfaceCondition: 'Wren rides the ferry.',
      foreshadowingSeeds: ['seed_1_2'],
      relatedVisibleArcs: ['the_lantern_debt'],
      expectedSurfaceTurn: turn + 5,
    },
    { _stableId: 'old-shape-1', arcTitle: 'The Keeper Is Alive', description: 'Written in the old shape.', status: 'brewing', turnsActive: 4 },
  ];
  const timeline = 'The keeper rows north.';
  const spread = Object.fromEntries([...timeline].map((ch, i) => [String(i), ch]));
  const data: Record<string, unknown> = {
    notes: [
      { id: 'note_1_1', type: 'observation', scope: 'player', content: 'Wren trusts Tavik more than she says.', resolved: false, createdAtTurn: Math.max(1, turn - 1) },
      { id: 'note_1_2', type: 'reminder', scope: 'world', content: 'The equinox tide is close.', resolved: true, resolvedAtTurn: turn, createdAtTurn: 1, triggerCondition: 'a bell rings five times' },
    ],
    pacing: {
      rhythm: { lastQuietMoment: 1, lastEmotionalBeat: 2, lastActionSequence: 0, lastMajorRevelation: 0 },
      currentMood: 'measured_hope',
      chapterPhase: 'rising',
      recommendations: { needsTension: true, needsBreather: false, readyForClimax: false, needsQuietMoment: false },
      recentMoodHistory: ['tense', 'quiet'],
      turnsAtCurrentMood: 2,
    },
    chapters: [
      {
        id: 'chapter_1',
        tone: 'quiet',
        title: 'Fog and Ferries',
        arcIds: ['chapter_1_arrival'],
        number: 1,
        status: 'complete',
        themes: ['arrival'],
        premise: 'Wren arrives in Saltmark.',
        createdAt: ts,
        majorGoal: 'Find lodging.',
        updatedAt: ts,
        createdAtTurn: 0,
        turnsElapsed: 2,
        closingMoment: 'The key changes hands.',
        estimatedTurns: { target: 10, maximum: 20, minimum: 5 },
        emotionalJourney: 'wary to curious',
      },
      {
        id: 'chapter_2',
        tone: 'tense',
        title: 'The Lantern Debt',
        arcIds: ['the_lantern_debt', 'the_grey_tide'],
        number: 2,
        status: 'active',
        themes: ['debt', 'trust'],
        premise: 'A debt comes due.',
        createdAt: ts,
        majorGoal: 'Repay Maren.',
        updatedAt: ts,
        turnsElapsed: Math.max(0, turn - 2),
        closingMoment: '',
        estimatedTurns: { target: 30, maximum: 60, minimum: 15 },
        emotionalJourney: 'curious to afraid',
      },
    ],
    epicSeeds: seeds,
    sessionId: uuidFor(seed, 'dm-session:main'),
    updatedAt: ts,
    activeArcs: arcs,
    worldState: {},
    storyHealth: {
      activeArcCount: 3,
      coreMemoryCount: 1,
      hiddenEventsCount: 2,
      invisibleArcCount: 2,
      pendingSeedsCount: 2,
      turnsWithoutMajorEvent: 1,
      turnsWithoutQuietMoment: 0,
    },
    coreMemories: [
      {
        id: 'mem_1_1',
        scope: 'player',
        title: 'The key',
        content: 'Tavik gave Wren the brass key without being asked.',
        context: 'On the breakwater.',
        category: 'revelation',
        isSecret: false,
        updatedAt: ts,
        importance: 'critical',
        hasBeenUsed: false,
        relatedArcs: ['the_lantern_debt'],
        relatedSeeds: [],
        createdAtTurn: 1,
        relatedCharacters: ['Tavik', 'Wren'],
      },
    ],
    hiddenEvents: [
      {
        id: 'hidden_1',
        title: 'Maren reads the ledger',
        description: 'At midnight, alone.',
        status: 'pending',
        clues: [],
        createdAt: ts,
        updatedAt: ts,
        involvedNPCs: ['Maren'],
        relatedArcs: ['the_lantern_debt'],
        worldImpact: 'minor',
        occurredAtTurn: 2,
      },
      'The ferryman was seen at the chapel.',
    ],
    invisibleArcs: invisible,
    lastDirective: {
      mood: 'tense',
      avoid: { topics: ['the keeper'], characters: [], revelations: ['who writes in the ledger'] },
      pacing: 'slow',
      include: { themes: ['debt'], characters: ['Maren'], foreshadowing: ['the spare lamp'], sensoryDetails: ['wet rope'] },
      endingHook: 'A bell rings five times.',
      sceneGuidance: { atmosphere: 'fog', tension_level: 6 },
    },
    nextIntentions: [{ type: 'escalate', description: 'Maren arrives early.', priority: 'high' }],
    recentAnalysis: [
      { turn, timestamp: ts, userAction: 'Wren asks about the key.', seedsPlanted: [], whatHappened: 'Tavik deflects.', seedsPayedOff: [], unexpectedDevelopments: [] },
    ],
    characterSecrets: {},
    currentChapterId: 'chapter_2',
    lastDirectiveTurn: turn,
    parallelTimelines: [
      {
        id: 'ptl_1',
        title: 'The Keeper',
        stages: [],
        location: 'north coast',
        createdAt: ts,
        startTurn: 1,
        updatedAt: ts,
        currentTurn: turn,
        description: 'What the keeper is doing.',
        participants: ['the keeper'],
        revealProgress: 10,
        revealStrategy: 'gradual',
        worldStateChanges: [],
      },
      spread,
    ],
    npcOffScreenActions: [
      {
        id: 'npc_1',
        goal: 'Collect the debt.',
        action: 'Maren hires a clerk.',
        npcName: 'Maren',
        createdAt: ts,
        discovered: false,
        consequences: [],
        discoveryClues: [],
        occurredAtTurn: 2,
        affectsPlayerArcs: true,
        playerCanDiscover: true,
      },
      { npc: 'the ferryman', action: 'rows north' },
      'Someone oils the lighthouse hinge.',
    ],
  };
  return {
    data,
    dirty: {
      stringArc: 2,
      seedWithoutId: 2,
      otherShapeInvisibleArc: 1,
      stringHiddenEvent: 1,
      spreadParallelTimeline: 1,
      chapterWithoutCreatedAtTurn: 'chapter_2',
      moodOutsideEnum: 'measured_hope',
    },
  };
}

function detachedDmContext(seed: string, turn: number, ts: string): Record<string, unknown> {
  return {
    notes: [],
    pacing: { rhythm: { lastQuietMoment: 0, lastActionSequence: 0 }, currentMood: 'quiet', turnsAtCurrentMood: 1 },
    chapters: [
      {
        id: 'chapter_1',
        tone: 'quiet',
        title: 'Another Shore',
        arcIds: [],
        number: 1,
        status: 'active',
        themes: [],
        premise: 'The same harbor, another night.',
        createdAt: ts,
        majorGoal: 'Meet Tavik.',
        updatedAt: ts,
        createdAtTurn: 0,
        turnsElapsed: turn,
        estimatedTurns: { target: 10, maximum: 20, minimum: 5 },
        emotionalJourney: '',
      },
    ],
    epicSeeds: [
      { id: 'seed_2_1', hint: 'Wet footprints on dry stone.', scope: 'player', payoff: 'Someone came from the sea.', payoffHorizon: 'short', plantedAtTurn: 1, reinforcements: [], payoffDelivered: false },
    ],
    sessionId: uuidFor(seed, 'dm-session:detached'),
    updatedAt: ts,
    activeArcs: [
      {
        id: 'another_shore',
        scope: 'player',
        title: 'Another Shore',
        stages: [{ turn: 1, title: 'Landing', timestamp: ts, description: '' }],
        status: 'building',
        arcType: 'main',
        horizon: 'short',
        priority: 'active',
        rigidity: 'loose',
        chapterId: 'chapter_1',
        createdAt: ts,
        updatedAt: ts,
        description: 'The second run.',
        turnsActive: turn,
        plannedBeats: [],
        plantedSeeds: [],
        completedBeats: [],
        involvedCharacters: [],
        setupsWithoutPayoff: 0,
      },
    ],
    worldState: {},
    storyHealth: { activeArcCount: 1 },
    coreMemories: [],
    hiddenEvents: [{ event: 'The ferry leaves early.', turn: 1 }, 'A lamp goes out.', { event: 'A bell cracks.', location: 'chapel', significance: 'minor' }],
    invisibleArcs: [
      { _stableId: 'old-shape-2', arcTitle: 'The Debt Repeats', description: 'Old shape.', status: 'brewing', turnsActive: 1 },
      { _stableId: 'old-shape-3', arcTitle: 'Fog Choir', status: 'brewing', turnsActive: 1, update: 'louder' },
    ],
    nextIntentions: [],
    recentAnalysis: [],
    characterSecrets: {},
    currentChapterId: 'chapter_1',
    parallelTimelines: ['A ship waits offshore.', { timeline: 'north', update: 'still rowing' }],
    npcOffScreenActions: [{ npc: 'Maren', action: 'counts coins', reasoning: 'habit' }, 'The guild meets.'],
  };
}

function storyDirectorBlock(turn: number, ms: number): Record<string, unknown> {
  return {
    chapters: [{ id: 'chapter_1', title: 'Fog and Ferries', status: 'complete' }],
    currentChapterId: 'chapter_2',
    arcs: [{ id: 'the_lantern_debt', title: 'The Lantern Debt', status: 'building' }],
    shadowWorld: { npcs: [], factions: [] },
    dmNotes: [],
    seedUpdates: [],
    toolLog: [{ tool: 'plant_seed', turn }],
    turnNumber: turn,
    timestamp: ms,
  };
}

function mainTracker(turn: number, ms: number): Record<string, unknown> {
  return {
    capturedAt: ms,
    resources: { hp: 10, maxHp: 10, mp: 0, maxMp: 0, ap: 3, maxAp: 3, shield: 0, xp: 40, level: 2, currency: 12, initialized: true },
    relationships: [
      {
        id: 'rel_maren',
        npcName: 'Maren Holt',
        category: 'rival',
        affinity: -10,
        trustLevel: 30,
        memories: ['named a date'],
        firstMetAt: ms - DAY,
        lastInteractionAt: ms,
        interactionCount: 3,
        currentEmotion: 'impatient',
        emotionIntensity: 4,
        emotionCause: 'the debt',
        dynamics: 'creditor',
        currentThoughts: 'He will pay or he will run.',
        npcNeeds: ['the ledger'],
        scenePresence: 'offscreen',
      },
    ],
    map: { locations: [{ id: 'quay', name: 'The Quay' }], playerMarker: 'quay', sceneContext: 'night', scope: 'town', seed: 7 },
    calendar: {
      calendar: {
        months: ['Thaw', 'Bloom'],
        currentDate: { day: 3, month: 1, year: 412 },
        calendarName: 'Harbor Reckoning',
        eraName: 'After the Flood',
        daysPerWeek: 7,
        weekDayNames: ['Moon', 'Tide', 'Wind', 'Salt', 'Bell', 'Net', 'Rest'],
        currentTime: 'night',
      },
      events: [{ id: 'ev_1', date: { day: 9, month: 1, year: 412 }, title: 'Equinox tide', description: 'The debt is due.', type: 'deadline', isRecurring: false }],
    },
    gossip: [
      {
        id: 'gos_1',
        topic: 'The keeper',
        source: 'fish market',
        createdAt: ms,
        perceptions: [],
        spreadRate: 'slow',
        witnessedBy: [],
        playerSeeded: false,
        spreadStatus: 'local',
        lastUpdatedAt: ms,
        originalTruth: 'He left on purpose.',
      },
    ],
    storyDirector: { current: storyDirectorBlock(turn, ms) },
  };
}

function detachedTracker(turn: number, ms: number): Record<string, unknown> {
  return {
    capturedAt: ms,
    resources: { hp: 8, maxHp: 10, mp: 0, maxMp: 0, ap: 3, maxAp: 3, shield: 0, xp: 5, level: 1, currency: 3, initialized: true },
    relationships: [],
    knowledge: [{ id: 'kn_1', subject: 'the ferry', content: 'Runs late on Bell days.', reliability: 'rumor', learnedAt: ms, category: 'place' }],
    memoryJournal: [{ id: 'mj_1', npcName: 'Tavik Ashvale', content: 'Shared a cup on the quay.', category: 'moment', sentiment: 'warm', emotionalWeight: 3, timestamp: ms }],
    quests: [{ id: 'q_1', title: 'Find the ferryman', status: 'active' }],
    inventory: { items: [{ id: 'it_1', name: 'Satchel' }], gold: 3, capacity: 10 },
    storyDirector: { current: storyDirectorBlock(turn, ms), history: [storyDirectorBlock(Math.max(0, turn - 1), ms - 60_000), storyDirectorBlock(Math.max(0, turn - 2), ms - 120_000)] },
  };
}

function storyboard(seed: string, ids: Ids, chatId: string, ms: number): Array<Record<string, unknown>> {
  const row = (n: number, moduleId: string, eventType: string, entity: string, summary: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    id: uuidFor(seed, `storyboard:${n}`),
    user_id: ids.user,
    chat_id: chatId,
    character_id: ids.character,
    snapshot_id: uuidFor(seed, 'storyboard-snapshot'),
    message_id: null,
    swipe_id: null,
    swipe_index: null,
    turn_index: 0,
    module_id: moduleId,
    entity_type: moduleId === 'map' ? 'location' : moduleId === 'calendar' ? 'event' : 'npc',
    entity_id: `${moduleId}_${n}`,
    entity_name: entity,
    event_type: eventType,
    summary,
    importance: 2,
    visibility: 'ai_user',
    payload: { source: 'legacy_snapshot_backfill', backfillVersion: 1, snapshotCapturedAt: ms, ...payload },
    occurred_at: pgTime(ms),
    created_at: pgTime(ms),
    recorded_at: pgTime(ms),
    story_time: null,
    story_time_label: null,
    valid_from_story_time: null,
    valid_until_story_time: null,
    reverted_at: null,
    reverted_reason: null,
    participant_id: null,
  });
  return [
    row(1, 'calendar', 'calendar_initialized', 'Harbor Reckoning', 'The calendar starts.', { calendar: { name: 'Harbor Reckoning' } }),
    row(2, 'calendar', 'calendar_event_added', 'Equinox tide', 'A deadline is set.', { event: { id: 'ev_1', title: 'Equinox tide' } }),
    row(3, 'relationships', 'relationship_recorded', 'Maren Holt', 'Maren is a rival.', { relationship: { id: 'rel_maren', category: 'rival' } }),
    row(4, 'map', 'player_moved', 'The Quay', 'Wren goes to the quay.', { location: { id: 'quay' } }),
  ];
}

// ---- assembling the export ------------------------------------------------------------------------

interface ChatBuild {
  key: ChatKey;
  record: Record<string, unknown>;
  messages: Message[];
  tracker?: Record<string, unknown>;
  storyboard?: Array<Record<string, unknown>>;
  dm?: Record<string, unknown>;
}

const countUsers = (ms: readonly Message[]): number => ms.filter((m) => m.role === 'user').length;
const activeIndex = (m: Message): number => m.swipes.findIndex((s) => s.content === m.content);

/** The synthetic export, its members as text, and the facts tests assert against. */
export function buildStory(options: StoryExportOptions = {}): StoryExport {
  const seed = options.seed ?? 'kit';
  const n = options.messages ?? 12;
  if (!Number.isInteger(n) || n < 10) throw new Error('buildStory: messages must be an integer ≥ 10');
  const nDetached = options.detachedMessages ?? 8;
  if (!Number.isInteger(nDetached) || nDetached < 6) throw new Error('buildStory: detachedMessages must be an integer ≥ 6');
  const branchKind = options.branch === undefined ? 'matching' : options.branch;
  const withDuplicate = options.duplicate ?? true;
  const withDetached = options.detached ?? true;
  const exportedAt = '2026-10-01T12:00:00.000Z';
  const exportedMs = Date.parse(exportedAt);

  const ids: Ids = {
    seed,
    user: uuidFor(seed, 'user'),
    character: uuidFor(seed, 'character'),
    persona: uuidFor(seed, 'persona'),
    preset: uuidFor(seed, 'preset'),
    missingPreset: uuidFor(seed, 'preset:missing'),
    thirdPreset: uuidFor(seed, 'preset:third'),
  };
  const chatId = (k: ChatKey): string => uuidFor(seed, `chat:${k}`);
  const mainId = chatId('main');

  // Books.
  const bookId = (k: BookKey): string => uuidFor(seed, `book:${k}`);
  const specs: Array<{ key: BookKey; spec: BookSpec; rows: RowSpec[]; copyOf?: BookKey }> = [
    {
      key: 'world',
      spec: { id: bookId('world'), name: 'Harbor Atlas', type: 'world', description: 'Places and customs of Saltmark.', budget: 4096, forkedFrom: null, hasTree: false, created: T0 - 40 * DAY },
      rows: WORLD_ROWS,
    },
    {
      key: 'saga',
      spec: { id: bookId('saga'), name: 'Ashvale Saga', type: 'character', description: 'The story so far.', budget: 2048, forkedFrom: null, hasTree: true, created: T0 - 5 * DAY },
      rows: sagaRows(mainId),
    },
    {
      key: 'sagaTwin',
      spec: { id: bookId('sagaTwin'), name: 'Ashvale Saga 2', type: 'character', description: 'The story so far.', budget: 2048, forkedFrom: bookId('saga'), hasTree: true, created: T0 - 4 * DAY },
      rows: sagaRows(mainId),
      copyOf: 'saga',
    },
    {
      key: 'compendium',
      spec: {
        id: bookId('compendium'),
        name: 'Ashvale Saga Compendium',
        type: 'character',
        description: 'Typed entries kept by the Compendium.',
        budget: 2048,
        forkedFrom: bookId('saga'),
        hasTree: true,
        created: T0 - 3 * DAY,
      },
      rows: compendiumRows(seed, bookId('compendium'), mainId, bookId('saga')),
    },
  ];
  if (options.sameNameBook) {
    specs.push({
      key: 'sameName',
      spec: { id: bookId('sameName'), name: 'Harbor Atlas', type: 'world', description: 'The islands.', budget: 4096, forkedFrom: null, hasTree: false, created: T0 - 35 * DAY },
      rows: SAME_NAME_ROWS,
    });
  }
  const bookRows = new Map<BookKey, Record<string, unknown>>();
  for (const b of specs) {
    // A twin keeps the original's row creation times: its rows differ only by `id` and `lorebook_id`.
    const created = b.copyOf ? specs.find((s) => s.key === b.copyOf)!.spec.created : b.spec.created;
    const entries = b.rows.map((r, i) => entryRow(seed, b.spec.id, i, r, created));
    bookRows.set(b.key, bookRow(seed, b.spec, entries, ids.user));
  }
  const worldId = bookId('world');

  // Library rows.
  const character = characterRow(ids);
  const card = characterCard(character);
  const persona = personaRow(ids, worldId);
  const preset = presetRow(ids);

  // Chats.
  const booksInfo = {
    world: worldId,
    managed: [
      { id: bookId('saga'), primary: true, managed: false },
      { id: bookId('compendium'), primary: false, managed: true },
      { id: worldId, primary: false, managed: false },
    ],
  };
  const chats: ChatBuild[] = [];
  const mainMsgs = mainMessages(seed, n, mainId);
  const mainUsers = countUsers(mainMsgs);
  const dmTs = pgTime(mainMsgs.at(-1)!.timestamp);
  const dm = mainDmContext(seed, mainUsers, dmTs);
  chats.push({
    key: 'main',
    record: chatRecord({
      id: mainId,
      parent: null,
      main: true,
      branchName: null,
      bpi: null,
      title: 'Harbor Nights',
      summary: 'Wren and Tavik chase a debt and a missing lighthouse keeper through Saltmark.',
      activeLorebooks: specs.map((s) => ({ id: s.spec.id, enabled: s.key !== 'sameName' })),
      config: chatConfig(ids, booksInfo, 'main'),
      count: n,
      created: T0 - DAY,
      last: mainMsgs.at(-1)!.timestamp,
    }),
    messages: mainMsgs,
    tracker: mainTracker(mainUsers, mainMsgs.at(-1)!.timestamp),
    storyboard: storyboard(seed, ids, mainId, mainMsgs.at(-1)!.timestamp),
    dm: dm.data,
  });

  let branch: ChatBuild | undefined;
  if (branchKind) {
    const id = chatId('branch');
    const msgs = branchMessages(seed, id, branchKind, mainMsgs);
    branch = {
      key: 'branch',
      record: chatRecord({
        id,
        parent: mainId,
        main: false,
        branchName: 'Take 2',
        bpi: 3,
        title: null,
        summary: null,
        activeLorebooks: [{ id: worldId, enabled: true }],
        config: chatConfig(ids, booksInfo, 'branch'),
        count: msgs.length,
        created: msgs[0]!.timestamp - 60_000,
        last: msgs.at(-1)!.swipes.at(-1)!.timestamp,
      }),
      messages: msgs,
    };
    chats.push(branch);
  }

  let detached: ChatBuild | undefined;
  if (withDetached) {
    const id = chatId('detached');
    const msgs = detachedMessages(seed, nDetached, id, 'second-run', T0 + 3 * DAY + 3_600_000);
    const users = countUsers(msgs);
    detached = {
      key: 'detached',
      record: chatRecord({
        id,
        parent: mainId,
        main: false,
        branchName: null,
        bpi: null,
        title: null,
        summary: 'A second run of the same story from the card greeting.',
        activeLorebooks: [worldId],
        config: chatConfig(ids, booksInfo, 'detached'),
        count: msgs.length,
        created: msgs[0]!.timestamp - 60_000,
        last: msgs.at(-1)!.timestamp,
      }),
      messages: msgs,
      tracker: detachedTracker(users, msgs.at(-1)!.timestamp),
      dm: detachedDmContext(seed, users, pgTime(msgs.at(-1)!.timestamp)),
    };
    chats.push(detached);
  }

  if (withDuplicate) {
    const source = branch ?? chats[0]!;
    const id = chatId('duplicate');
    const rec = source.record;
    chats.push({
      key: 'duplicate',
      record: {
        ...structuredClone(rec),
        id,
        parent_chat_id: rec.id,
        is_main_timeline: false,
        branch_name: rec.branch_name ?? 'Take 2',
        branch_point_index: rec.branch_point_index ?? source.messages.length,
        message_count: source.messages.length,
        created_at: pgTime(Date.parse(String(rec.created_at)) + 3000),
      },
      messages: source.messages.map((m) => structuredClone(m)),
    });
  }

  // BFS from main: main's children in order, then the duplicate when it hangs off the branch.
  const ordered = [
    chats.find((c) => c.key === 'main')!,
    ...chats.filter((c) => c.key !== 'main' && c.record.parent_chat_id === mainId),
    ...chats.filter((c) => c.key !== 'main' && c.record.parent_chat_id !== mainId),
  ];

  // Members.
  const files: Array<{ name: string; data: string }> = [];
  const add = (name: string, data: string): void => {
    files.push({ name, data });
  };
  const totalMessages = ordered.reduce((s, c) => s + c.messages.length, 0);
  const entryCount = [...bookRows.values()].reduce((s, b) => s + (b.entries as unknown[]).length, 0);
  const stats = {
    branches: ordered.length,
    chats_with_trackers: ordered.filter((c) => c.tracker).length,
    chats_with_storyboards: ordered.filter((c) => c.storyboard).length,
    chats_with_dm_context: ordered.filter((c) => c.dm).length,
    total_messages_estimate: totalMessages,
    chunk_count: ordered.reduce((s, c) => s + Math.ceil(c.messages.length / 50), 0),
    storyboard_event_count: ordered.reduce((s, c) => s + (c.storyboard?.length ?? 0), 0),
    lorebook_count: bookRows.size,
    lorebook_entry_count: entryCount,
  };
  const failed = options.failedChunk ? [{ chat_id: mainId, chunk_number: 1, reason: 'decrypt_failed' }] : [];
  const manifest = {
    format: 'rolecall-story-zip',
    version: 1,
    exported_at: exportedAt,
    root_chat_id: mainId,
    main_chat_id: mainId,
    app_version: null,
    notice:
      'This bundle contains decrypted chat content. Treat it like a private journal — anyone who opens it can read everything inside.',
    stats,
    character_id: ids.character,
    persona_id: ids.persona,
    preset_id: ids.preset,
    lorebook_ids: [...bookRows.values()].map((b) => String(b.id)),
    chat_ids: ordered.map((c) => String(c.record.id)),
    failed_chunks: failed,
  };
  add('manifest.json', pretty(manifest));

  if (options.storyJsonl ?? true) {
    const lines: string[] = [
      JSON.stringify({
        kind: 'manifest',
        format: 'rolecall-story',
        version: 1,
        exported_at: exportedAt,
        root_chat_id: mainId,
        main_chat_id: mainId,
        stats: { ...stats, decrypted_chats: ordered.length, decrypted_messages: totalMessages, failed_chunks: failed.length },
      }),
      JSON.stringify({ kind: 'character', data: character }),
      JSON.stringify({ kind: 'persona', data: persona }),
      JSON.stringify({ kind: 'preset', data: preset }),
      ...[...bookRows.values()].map((b) => JSON.stringify({ kind: 'lorebook', data: b })),
    ];
    for (const c of ordered) {
      const { id, ...rest } = c.record;
      lines.push(JSON.stringify({ kind: 'chat', chat_id: id, ...rest }));
      if (c.tracker) lines.push(JSON.stringify({ kind: 'tracker', chat_id: id, data: c.tracker }));
      if (c.storyboard) lines.push(JSON.stringify({ kind: 'storyboard', chat_id: id, events: c.storyboard }));
      if (c.dm) lines.push(JSON.stringify({ kind: 'dm_context', chat_id: id, data: c.dm }));
      for (const m of c.messages) {
        lines.push(
          JSON.stringify({
            kind: 'message',
            chat_id: id,
            index: m.index,
            message_id: m.message_id,
            is_user: m.is_user,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            swipes: m.swipes,
          }),
        );
      }
    }
    add('story.jsonl', lines.join('\n'));
  }

  const charName = safeName(CHAR_NAME, 'character');
  const cardPath = `characters/${charName}.json`;
  const rawPath = `characters/${charName}.raw.json`;
  add(cardPath, JSON.stringify(card));
  add(rawPath, pretty(character));
  const personaPath = `personas/${safeName(PERSONA_NAME, 'persona')}.json`;
  add(personaPath, pretty(persona));
  const presetPath = `presets/${safeName(PRESET_NAME, 'preset')}.json`;
  add(presetPath, pretty(preset));
  const books: Partial<Record<BookKey, KitBook>> = {};
  for (const b of specs) {
    const path = `lorebooks/${safeName(b.spec.name, 'lorebook')}-${b.spec.id.slice(0, 8)}.json`;
    const row = bookRows.get(b.key)!;
    add(path, pretty(row));
    books[b.key] = { key: b.key, id: b.spec.id, name: b.spec.name, path, rows: (row.entries as unknown[]).length };
  }

  const kitChats: Partial<Record<ChatKey, KitChat>> = {};
  for (const c of ordered) {
    const id = String(c.record.id);
    const title = c.record.title as string | null;
    const branchName = c.record.branch_name as string | null;
    const dir = `chats/${safeName(title ?? branchName ?? id.slice(0, 8), id.slice(0, 8))}-${id.slice(0, 8)}`;
    const own: string[] = [];
    const put = (file: string, data: string): void => {
      add(`${dir}/${file}`, data);
      own.push(`${dir}/${file}`);
    };
    put('chat.json', pretty(c.record));
    put(
      'messages.jsonl',
      c.messages
        .map((m) =>
          JSON.stringify({
            index: m.index,
            message_id: m.message_id,
            role: m.role,
            is_user: m.is_user,
            content: m.content,
            timestamp: m.timestamp,
            swipes: m.swipes,
          }),
        )
        .join('\n'),
    );
    if (c.tracker) put('tracker.json', pretty(c.tracker));
    if (c.storyboard) put('storyboard.json', pretty(c.storyboard));
    if (c.dm) put('dm-context.json', pretty(c.dm));
    kitChats[c.key] = {
      key: c.key,
      id,
      dir,
      parentId: c.record.parent_chat_id as string | null,
      branchPointIndex: c.record.branch_point_index as number | null,
      messages: c.messages.length,
      users: countUsers(c.messages),
      messageIds: c.messages.map((m) => m.message_id),
      roles: c.messages.map((m) => m.role),
      swipeCounts: c.messages.map((m) => m.swipes.length),
      active: c.messages.map(activeIndex),
      startsWithCardGreeting: c.messages[0]!.content === FIRST_MES,
      files: own,
    };
  }

  // The zip, in JSZip's order: a folder record before the first member inside it.
  const compression = options.compression ?? 'deflate';
  const folders = options.folders ?? true;
  const inputs: ZipInput[] = [];
  const seen = new Set<string>();
  files.forEach((f, i) => {
    if (folders) {
      const parts = f.name.split('/');
      for (let k = 1; k < parts.length; k++) {
        const folder = `${parts.slice(0, k).join('/')}/`;
        if (!seen.has(folder)) {
          seen.add(folder);
          inputs.push({ name: folder });
        }
      }
    }
    const method: 0 | 8 = compression === 'stored' ? 0 : compression === 'mixed' && i % 2 === 1 ? 0 : 8;
    inputs.push({ name: f.name, data: f.data, method });
  });
  const bytes = writeZip(inputs, { date: new Date(exportedMs), ...options.zip });

  const typedRows = TYPED.length;
  const compRows = compendiumRows(seed, bookId('compendium'), mainId, bookId('saga'));
  const facts: StoryFacts = {
    seed,
    exportedAt,
    character: { id: ids.character, name: CHAR_NAME, card: cardPath, raw: rawPath, firstMes: FIRST_MES },
    persona: { id: ids.persona, name: PERSONA_NAME, path: personaPath },
    preset: {
      id: ids.preset,
      name: PRESET_NAME,
      path: presetPath,
      missingId: ids.missingPreset,
      prompts: PROMPTS.length,
      enabledRows: PROMPTS.filter((p) => p.enabled).length,
      mainOverrides: { ...MAIN_OVERRIDES },
      settingsOnly: ['qt_legacy_only'],
    },
    books,
    chatIds: manifest.chat_ids,
    chats: kitChats,
    features: { customOpener: 0, activeNotLast: 2, unclosedThink: 4, closedThink: 6, sameRolePair: 7 },
    detachedUserPair: 4,
    compendium: {
      typed: typedRows,
      arcRows: compRows.filter((r) => r.title.startsWith('[Arc]')).length,
      consumed: compRows.filter((r) => r.metadata?.standardization_state === 'consumed_by_split').length,
      consumedIds: compRows.filter((r) => r.metadata?.standardization_state === 'consumed_by_split').map((r) => uuidFor(seed, `entry:${bookId('compendium')}:${r.key}`)),
      failed: compRows.filter((r) => r.metadata?.standardization_state === 'failed').length,
    },
    saga: { arcRows: sagaRows(mainId).filter((r) => r.title.startsWith('[Arc]')).length, constant: sagaRows(mainId).filter((r) => r.constant).length },
    mainDmDirty: dm.dirty,
    files: files.map((f) => f.name),
  };
  return { bytes, files, facts };
}

/** The synthetic `.rolecall` story zip. */
export function buildStoryExport(options: StoryExportOptions = {}): Uint8Array {
  return buildStory(options).bytes;
}
