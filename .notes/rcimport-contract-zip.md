# RoleCall story import — contract note, unit `zip` (D-186, D-194)

Files: `src/formats/zip.ts` (new, fresh), `test/rcimport/kit.ts` (new, test helper; ports RoleCall's
exporter layout, see `rcimport-provenance-zip.md`), `test/rcimport/zip.test.ts` (new, 24 tests: 23
always, 1 opt-in). zip.ts imports only `node:zlib` (`inflateRawSync`, `crc32`). No other file touched.

## 1. `src/formats/zip.ts`

```ts
export interface ZipLimits { member: number; total: number; count: number }
export const ZIP_LIMITS: Readonly<ZipLimits>; // member 64 MiB, total 512 MiB, count 10 000 (D-186)

export type ZipErrorCode = 'not_zip' | 'truncated' | 'corrupt' | 'crc' | 'encrypted' | 'zip64'
  | 'unsupported' | 'limit' | 'unsafe_name' | 'missing';
export class ZipError extends Error { readonly code: ZipErrorCode; readonly member: string | undefined }

export interface ZipEntry { readonly name: string; readonly dir: boolean; readonly method: 0 | 8;
  readonly size: number; readonly compressedSize: number; readonly crc32: number }
export interface ZipMember { name: string; bytes: Uint8Array }
export interface ZipArchive {
  readonly entries: readonly ZipEntry[];   // central-directory order, folder records included
  has(name: string): boolean;
  read(name: string): Uint8Array;          // inflated + CRC-checked on every call; 'missing' if absent
  text(name: string): string;              // UTF-8, a leading BOM dropped
}

export function isZip(bytes: Uint8Array): boolean;                                   // `PK\x03\x04` (D-185 sniff)
export function openZip(bytes: Uint8Array, limits?: Partial<ZipLimits>): ZipArchive; // structure checked, lazy inflate
export function readZip(bytes: Uint8Array, limits?: Partial<ZipLimits>): ZipMember[]; // every non-folder member
```

- **Use `openZip` in the importer**, not `readZip`: it checks everything up front but inflates only what
  is read, so `story.jsonl` (the biggest member, a copy of the rest) is never inflated. On the user's
  export: open ≈ 3 ms, all 26 members except story.jsonl ≈ 60 ms, readZip of all 27 ≈ 135 ms.
- Member names are **normalised**: `\` → `/`, `.` segments and doubled slashes dropped; a folder record
  keeps its trailing `/` and has `dir: true`. Look members up by the normalised name
  (`chats/<slug>-<id8>/chat.json`). Folder records (JSZip writes them; the real export has 9) are in
  `entries`, skipped by `readZip`; filter `!e.dir` when listing files.
- Errors carry the member's name in `message` and `member` (names in a real export hold character,
  persona and book names: fine on the user's terminal, never in a test or fixture).

Checks, in order (all before anything is inflated, except the last two):
1. archive bytes ≤ `total`; EOCD found from the end over ≤ 64 KiB of comment, the one whose comment ends
   exactly at EOF (so a comment holding `PK\5\6` is fine; trailing junk after the EOCD is 'truncated');
2. ZIP64 refused: a ZIP64 locator before the EOCD, `0xFFFF`/`0xFFFFFFFF` in EOCD or central fields, a
   `0x0001` extra field; split archives ('unsupported'); record count ≤ `count`; the central directory
   inside the file;
3. per central record: signature; encryption refused (flag bits 0, 6, 13, method 99, AES extra
   `0x9901`); methods other than 0/8 'unsupported'; the name (UTF-8 strictly, no control characters,
   no leading `/`, no drive letter, no `..` segment, not empty after normalising, not a duplicate after
   normalising); a folder with data, a stored member whose sizes differ: 'corrupt'; size ≤ `member`;
   running sum of declared sizes ≤ `total`;
4. per local header: signature, method and raw name equal to the central record's, CRC and sizes equal
   unless flag bit 3 (data descriptor) is set, the data before the central directory;
5. no two members overlap (local header start vs the previous member's data end): the overlapping-file
   bomb;
6. on read: deflate with `maxOutputLength` = the declared size (a member that inflates past it stops
   there: 'corrupt'), output length = declared size, CRC-32 equal ('crc').

## 2. `test/rcimport/kit.ts` (for the other builders' tests)

```ts
export function writeZip(entries: readonly ZipInput[], opts?: ZipWriteOptions): Uint8Array;
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array;
export function buildStory(options?: StoryExportOptions): StoryExport;   // { bytes, files, facts }
export function buildStoryExport(options?: StoryExportOptions): Uint8Array;
```

`ZipInput {name, rawName?, data?, method?, centralOnly?, lie?: {crc, size, compressedSize, flags,
method, localName, localOffset, centralExtra, localExtra}}`; `ZipWriteOptions {comment?, date?,
dataDescriptor?}`. JSZip's record layout (needed 1.0, made by 2.0/DOS, folder attr 0x10), matching the
real file's headers.

`StoryExportOptions` (all optional): `seed` ('kit'; changes every id, nothing else), `messages` (main
chat, default 12, ≥ 10), `branch` ('matching' default | 'diverged' | false), `duplicate` (true),
`detached` (true), `detachedMessages` (8, ≥ 6), `sameNameBook` (false), `storyJsonl` (true),
`failedChunk` (false: one manifest entry, no message removed), `compression` ('deflate' | 'stored' |
'mixed'), `folders` (true), `zip` (writer options). Deterministic: same options → same bytes. 1 200 +
300 messages build in ≈ 25 ms.

What the default export holds (all invented; character "Tavik Ashvale", persona "Wren Calder", preset
"Quill & Lantern v2.1"):
- `manifest.json` (pretty, RC key order), `story.jsonl` (RC record order; message lines = per-file
  line + `kind`, `chat_id`), `characters/Tavik_Ashvale.json` (compact v3 card built from the row like
  RoleCall: one alternate greeting, no character_book) + `.raw.json` (pretty DB row, a subset of the
  real ~107 columns incl. `details`), `personas/Wren_Calder.json`, `presets/Quill_Tide_v2.1.json`,
  4 × `lorebooks/<name>-<id8>.json`, chat folders in BFS order: main, branch, detached, duplicate.
- **main** (`Harbor Nights`, `is_main_timeline`, `message_count: 0` stale): message 0 a custom opener
  (≠ card `first_mes` and its alternate); fixed feature indices in `facts.features`: 2 = three swipes,
  the first active; 4 = starts `<think>`, never closed; 6 = `<think>…</think>` + text, 2 swipes, the last
  active; 7 = second of two assistant messages in a row. From 8 on: even = user, odd = assistant (an
  even `messages` ends on an assistant); every `i % 40 == 21` has 2 swipes, the last active. Swipe
  shapes vary like the real file (`{id, content, timestamp, model}`, `{content, timestamp, model,
  generationTimeMs, presetName, samplerSettings}`, `{content, timestamp}`, one `immersionSnapshot`);
  `timestamp` = swipes[0].timestamp, strictly increasing; contents unique. tracker.json,
  storyboard.json (4 backfilled rows, `message_id` null), dm-context.json.
- **dm-context (main)**: `lastDirectiveTurn` = user-message count; chapters `chapter_1` (complete) and
  `chapter_2` (active, **no `createdAtTurn`**); arcs with slug ids, stages, `nextBeat`,
  `lastProgressTurn`, **activeArcs[2] a bare string**; seeds: one id = its own title text, `seed_1_2`
  (delivered), **epicSeeds[2] without id**; invisibleArcs[1] in the **old shape** (`_stableId`,
  `arcTitle`); hiddenEvents[1] a string; parallelTimelines[1] a **string spread into `{"0":…}`**;
  npcOffScreenActions mixed (dict, `{npc, action}`, string); `pacing.currentMood: 'measured_hope'`
  (outside the enum); one `nextIntentions` row without `targetTurn`; notes, coreMemories,
  recentAnalysis, lastDirective. Indices in `facts.mainDmDirty`.
- **branch** "Take 2", `branch_point_index: 3`, preset id not in the zip (`facts.preset.missingId`),
  one book. 'matching': messages 0-2 equal main's (ids, text, swipes, times) + 2 of its own.
  'diverged': 3 messages from the card greeting, own ids, older than main's opener, last one active
  swipe 1 of 2.
- **duplicate**: byte-identical `messages.jsonl` to the branch (main when `branch: false`), parent = it,
  same `branch_name`/`bpi`, created 3 s later, no tracker/dm.
- **detached**: parent main, `branch_point_index`/`branch_name`/`title` null, starts with the card's
  `first_mes`, no shared ids with main, users at 3 and 4 (a user→user pair, `facts.detachedUserPair`),
  a mid-text `<think>` at 5; `active_lorebooks` in the plain-id form; own tracker (with `storyDirector
  .history`) and an all-old-shape dm-context (no `lastDirective`); logit_bias rows in its config.
- **chat config (main)**: `dmEnabled`, `dmMode: 'full'`, `dmPersonality: 'the-chronicler'` (detached:
  `'the-weaver'`; branches: `dmEnabled: false`), `preset_prompt_overrides` keyed by **two** preset ids
  (the exported one: `facts.preset.mainOverrides` = `qt_style_plain: false, qt_style_lyric: true,
  qt_user_nudge: true`), `preset_sampler_overrides`, `sampler_overrides` (values, enabled, prefill),
  `summary_prompts`, `immersionModules`, `tv_*` incl. `tv_managed_lorebooks`, `lorebook_ids` = the world
  book only while `active_lorebooks` lists all books `{id, enabled}`.
- **persona row**: `details` {colors (one with an empty name), traits, age, height, appearance with `<letters> &`,
  personality/history with blank-line runs, quirks, `section_order`, `lorebook_id` = world book,
  `injection_*`}, top-level `section_order`, short `description`, `content: ''`.
- **preset row**: 4 categories (one nested: `Voices` under `Style`), 20 prompt rows by `sort_order`
  (markers on and off as in the real preset: the stock card/persona markers disabled; `qt_card`/
  `qt_persona` blocks instead; `injection_position '1'` depth 2; user and assistant roles; RC macros
  `{{setvar::…}}`, `{{getvar::…}}`, `{{if .tone == warm}}…{{else}}…{{/if}}`, `{{.pace}}`, `{{trim}}`,
  `{{random::1::6}}`), 12 enabled; `settings` = a stale ST blob (an extra `qt_legacy_only` prompt,
  `qt_dice` disabled in its `prompt_order`, `extensions: {}`), no `extensions.rolecall` anywhere.
- **books** (`facts.books`): `world` "Harbor Atlas" (6 rows: positions world/character/before_example/
  depth, one constant, one regex trigger, one disabled); `saga` "Ashvale Saga" (6 rows, 2 `[Arc]` rows
  with `metadata.source: 'tv_arc_overview'`); `sagaTwin` "Ashvale Saga 2" (`forked_from_id` = saga; rows
  **differ from saga's only by `id` and `lorebook_id`**); `compendium` "Ashvale Saga Compendium" (18
  rows: 12 typed covering all 11 types, `[Arc]` rows = 1 typed plot + 1 untyped, 2 `consumed_by_split`
  rows (enabled, `consumed_by_entry_id` → a typed row), 1 `failed`, 1 forked copy of a saga row, 1
  `_created_by_swipe`). `sameNameBook`: a fifth "Harbor Atlas" with other rows. Every row has the
  real 49 columns.

`facts` (`StoryFacts`): ids and member paths of everything above, `chatIds` (manifest order), per chat
`KitChat {id, dir, parentId, branchPointIndex, messages, users, messageIds, roles, swipeCounts,
active, startsWithCardGreeting, files}`, `preset {prompts, enabledRows, mainOverrides, settingsOnly,
missingId}`, `compendium {typed, arcRows, consumed, consumedIds, failed}`, `saga {arcRows, constant}`,
`mainDmDirty`, `files` (zip order, folders excluded).

## 3. Tests (`TMPDIR=~/.cache bun test test/rcimport/zip.test.ts`)

24 tests, 250 expects: round trips (stored, deflate, empty, folder, UTF-8 name, data descriptors, a
comment holding `PK\5\6`, a non-zero byteOffset, the empty archive, BOM, name normalisation, `isZip`);
hostile archives (CRC lie, flipped stored byte, broken deflate, five truncations, not-a-zip, 13 unsafe
names + bad UTF-8 + normalised duplicates, member/total/count/archive limits incl. a declared ~4 GB
member at default limits, an 8 MiB bomb declared as 1 KiB, an under-sized member, overlapping members via
a quoted local header, four ZIP64 forms, four encryption forms, method 12, split archives, a local
header naming another file, a bad local offset, a folder with data, stored sizes that differ); the
kit's export (layout vs manifest, the layout checker itself, story.jsonl, every D-194 feature, all
options, 1 200 messages); the opt-in real export. No temp dirs.

**Real export:** `RP_CORE_RC_EXPORT=<path> bun test test/rcimport/zip.test.ts`. Without the variable (or
when the file is absent) the test skips. It asserts only: `isZip`, `readZip` succeeds (every CRC), and
the members match the manifest (one chat folder per `chat_ids` entry holding chat.json + messages.jsonl
and only the five known files, whose `id` is that chat; one book file per `lorebook_ids`; persona,
preset, character card + row files; the stats' branch/book/tracker/storyboard/dm counts). Problems
are reported by position, never by name. Passes on the user's file.

## 4. Choices and deviations

- `openZip` (lazy) beside the asked-for `readZip`, for memory and time (story.jsonl is ~45 % of the
  inflated bytes in the real export).
- A bad member refuses the **whole archive** (not just the member): a traversal name or a lying size
  means the file is not a RoleCall export.
- Names that are not valid UTF-8 are refused, with or without flag bit 11 (no CP437 fallback: RoleCall's
  `safeName` writes ASCII only).
- Trailing bytes after the EOCD are refused ('truncated'); prepended data (self-extracting stubs) fails
  the local-header signature ('corrupt').
- The kit writes no `characters/<n>.png` (RoleCall writes the PNG only when its image fetch works; the
  real export has the JSON card). No `chat-images/` (RoleCall never writes it).

## 5. Open questions

- None blocking. For the importer: the twin books differ only by `id`/`lorebook_id`, so a normalised
  row hash must drop at least those two (real forks also differ in `origin`, `origin_source_id`,
  timestamps and sometimes a wiped `metadata`; whether those count is the importer's call).
