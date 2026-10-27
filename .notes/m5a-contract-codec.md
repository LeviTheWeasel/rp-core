# M5a contract note — unit `codec`

Files: `src/formats/compendium-v1.ts` (new), `src/formats/import.ts`, `src/formats/kind-markers.ts`,
`test/fixtures/ru/lantern/{lantern.compendium.json, mira.character.json}` (new, copied verbatim from
`<session scratchpad>/m5a/understand/fixtures-draft/`), `test/formats-m5a/{compendium-read,
compendium-write, compendium-import}.test.ts` (new, 52 tests). compendium-v1.ts imports
`agents/compendium/entry-types.ts` (`isEntryType`), `agents/compendium/types.ts` (type only),
`lore/keys.ts` (`parseRegexKey`), `prompt/depth.ts` (`fromRcDepth`), `./kind-markers.ts`, `./native.ts`,
`./wire.ts`. No cli file was edited.

## 1. Exported API

`src/formats/compendium-v1.ts`:
```ts
export const COMPENDIUM_SCHEMA = 'compendium-v1.0.0';
export const COMPENDIUM_FORMAT = 'rolecall-compendium';
export const RC_LIMITS = { entries: 5000, bytes: 10 * 1024 * 1024 } as const; // what RoleCall refuses on import

export function looksLikeCompendium(json: unknown): boolean;

export interface CompendiumReadOptions { fallbackName: string; name?: string } // name = --as
export function readCompendium(json: unknown, opts: CompendiumReadOptions): Imported<LoreBook>;

export interface CompendiumRowInput {
  key: string; title: string; content: string; enabled: boolean; constant: boolean; keys: string[];
  type?: EntryType; data?: Rec; featured?: boolean; arc?: string; disableReason?: string; turnNumber?: number;
}
export function compendiumChunks(head: { name: string; exportDate: string }, rows: readonly CompendiumRowInput[]): Iterable<string>;
export function deterministicUuid(...parts: string[]): string;
export function compendiumWarnings(rows: readonly CompendiumRowInput[]): ImportWarning[];
```
`src/formats/kind-markers.ts`: `export function hasCompendiumTag(o: unknown): boolean` (format
`rolecall-compendium` or a `compendium-*` schemaVersion, any shape).
`src/formats/import.ts`: `DetectedKind` gains `'compendium'`; `PRODUCES.compendium = 'lorebook'`;
`KIND_LABEL.compendium = 'a RoleCall Compendium export'`; `importFile` case `'compendium'`.

## 2. Detection (D-162)

- Order in `detectFull`: card → settings/preset → **compendium** → ST world info → character_book, on
  every reading of `readingsOf` (so a double-encoded file and the `{exportedAt|version, type, data}`
  envelope are unwrapped; the import then carries `repaired_json` as for other kinds).
- `looksLikeCharacterBook` and `looksLikeWorldInfo` now refuse any `hasCompendiumTag` object (fail
  closed), so a tagged file can never be read as a plain book even when malformed. A tagged file
  that is not a Compendium (`lorebook: null`, no `entries`) is `unknown` with the reason
  "a RoleCall Compendium export without a lorebook object and an entries list; nothing to import".
  The generic unknown reason (pinned in `test/formats-m2/import.test.ts:155`) is unchanged.
- `/lore add <file>` and `new --lore` (`cli/refs.ts` → `importFile(expect:'lorebook')`) accept it
  through `PRODUCES`; `expect:'character'` refuses it with `wrong_kind` "… but this is a RoleCall
  Compendium export". Checked in tests through `resolveLoreRef`.

## 3. Read: behaviour choices the decisions note left open

- **Book name**: `opts.name` (`--as`) > non-blank `lorebook.name` > `fallbackName`. `import.ts` passes
  `--as` as `name` and the file stem **without a trailing `.compendium`** as `fallbackName`, and saves
  under `r.value.name`. So unlike the other importers, `--as` sets the stored `LoreBook.name` too (not
  only the library id) — that is how D-162 reads. The fixture's `lorebook.name` is `"Lantern"` →
  library id `lantern`: `rp-core import lantern.compendium.json` then `/lore add lantern` works.
- **Typed row** (`metadata.entry_type`, trimmed + lower-cased, one of the 11): `content: ''`;
  RoleCall's content in `extras.content`; `meta = {type, data, aliases?, featured?}` with `data =
  structured_data` (object, else `{}` + warning, kept by reference, nothing stripped — service fields
  like `writer_source`/`turn_range` stay in data; render must hide them, D-151), `aliases` = non-blank
  strings of `data.aliases` (omitted when none), `featured` only when true (`is_featured === true ||
  metadata.featured === true`). The rest of `metadata` (`source`, `chatId`, `turnNumber`,
  `disableReason`, `original_classic_content`, …) → `extras.metadata`.
- **Arc**: untyped row with `metadata.source === 'tv_arc_overview'` **or** a title starting `[Arc]`
  (RoleCall's tree builder reads the legacy title too). `meta = {arc}` with the plot =
  `metadata.arc` else the title minus `[Arc]`, trimmed; content stays in `content`; `metadata` minus
  `arc` → `extras.metadata`. No plot name → classic + warning. Position as the row says (D-141: plain
  lore in M5a; e17 is `constant`, so it fires every turn as lore until M5b moves it).
- **Classic row**: ordinary entry; non-empty `metadata` → `extras.metadata`; an `is_featured: true`
  → `extras.is_featured` (featured means nothing for untyped rows).
- **Unknown non-blank `entry_type`** → classic, whole metadata in extras, warning `unknown_type`.
- **Triggers**: plain strings and `{keyword}` records (blank dropped, others dropped + warning).
  `isRegex` → `/pattern/flags` with every unescaped `/` escaped; flags filtered to `gimsuy`. An
  unflagged regex gets `i` unless the entry (`case_sensitive`) or the book (`global_case_sensitive`)
  is case-sensitive — RoleCall's matcher does that. Consequence: rp-core's `/x/` exported and
  re-imported comes back as `/x/i`.
- **Columns → LoreEntry**: `priority`→order, `probability` (clamped), `group_name`→`groups:[trimmed]`
  (not comma-split: RoleCall has one group), `group_weight`, `scan_depth`, `case_sensitive`,
  `match_whole_words`, `prevent/exclude_recursion`, `ignore_budget`, `sticky/cooldown/delay`,
  `enabled`, `constant`, `secondary_triggers` + `selective_logic` (logic only with secondary keys).
  Values are kept as carried (e.g. `order: 100`, `groupWeight: 1`); a wrong-kind cell → warning,
  default kept. Positions per D-162; `depth` → `{depth: fromRcDepth(d ?? 4), role: role ?? 'system'}`
  (role always written); `append` → disabled, `position/depth/role` kept in extras, warning
  `rc_append` (only when it was enabled); `scene` → `examples_before`, `extras.position`, warning
  `rc_scene`; unknown → `after` + warning.
- **RoleCall-only columns** (comment, trigger_mode, use_memo, allow_recursion, delay_until_recursion,
  character_filter, scan_*, side_effects, boost_*, probability_mode, Bunraku's unsupported_fields) →
  `extras.<column>` only when not unset and not RoleCall's default; `not_honoured` when RoleCall would
  act on them. **Dropped silently**: `lorebook_id, origin, origin_source_id, created_at, updated_at,
  token_count, sort_order` (file order is the book order). Unknown columns → extras + `unknown_field`.
- **category_id** → `extras.category` = the name from the file's `categories`; unknown id → warning.
- **ids**: string or number id kept; missing → its index in the file (`"3"`) + warning; duplicates via
  `uniqueIds` (`-2`, `-3`) + `duplicate_id` warning.
- **Book**: `global_scan_depth`→`scanDepth`, `global_recursion`→`recursive`,
  `global_case_sensitive`→`caseSensitive`, `global_match_whole_words`→`wholeWords` (RoleCall applies
  them; null = absent); `match: 'literal'`. Dropped: `id, creator_id, forked_from_id,
  original_creator_id, status, created_at, updated_at`. Kept silently in extras when set:
  `description, genre, fandom, tags, lorebook_type, token_budget (≠0), provenance`. Unknown book keys
  and unknown top-level keys (→ `extras.envelope`) warn `unknown_field`. `tree`/`nodeConstraints`
  non-empty → one `not_honoured` warning. Version ≠ v1.0.0 (or missing) → `unknown_version`, read.
- Warning codes used: `invalid_value`, `unknown_type`, `unknown_version`, `not_honoured`,
  `unknown_field`, `duplicate_id`, `rc_append`, `rc_scene` (+ `repaired_json` from import.ts).

## 4. Write: what the caller (export.ts, D-163) must know

- `compendiumChunks` is a sync generator of strings: header, one chunk per row, footer. Joined, the
  text is exactly `JSON.stringify(payload, null, 2)` (RoleCall's layout, **no trailing newline**);
  0 rows still gives the exact `"entries": []`. Stream it to a temp file and rename.
- Header `lorebook` = `{id: deterministicUuid(name), name (≤200 code points), description: null,
  tags: [], lorebook_type: 'compendium'}`; footer `{tree: null, nodeConstraints: [], categories: [],
  counts}`.
- Rows are **thin**: `id = deterministicUuid(head.name, key)`, `lorebook_id`, `title`, `content`,
  `enabled`, `constant`, `trigger_mode:'simple'`, `triggers` (from `keys`; '/re/flags' →
  `{keyword, isRegex:true, flags?}`; blank keys dropped), `secondary_triggers: []`,
  `selective_logic:'and_any'`, `position:'character'`, `depth: 4`, `role:'system'`, `sort_order: i`,
  `priority: 100`, `probability: 100`, `category_id: null`, `metadata`, `is_featured`. RoleCall's
  importer fills the other columns with its defaults.
- `metadata`: typed → `{source:'tv_compendium', entry_type, structured_data: data ?? {},
  turnNumber?}`; `arc` set (untyped) → `{source:'tv_arc_overview', arc}` (the plot is written so the
  round trip is exact; RoleCall ignores the key); otherwise `{}`; `disableReason` added when given.
- `is_featured`: true only for the first `featured` typed row of each type; untyped rows always
  false (so a note's featured flag is not exported). `compendiumWarnings(rows)` lists the rows written
  unfeatured (`featured_dropped`) and `too_many_entries` above 5 000; the 10 MB check
  (`RC_LIMITS.bytes`) is the caller's while streaming.
- The caller supplies: `title` (name; summary: its title; arc: `[Arc] <plot>` — the writer does not
  prefix), `content` (renderContent / note text / overview), `keys` (`[name, ...aliases]`, note keys),
  `data` with `aliases` inside (`meta.aliases` is read back from `data.aliases`), the service fields
  (`turn_range`, `messages_covered`, `source_turn`) already in `data`, `enabled = !retired`,
  `disableReason = retired.reason`, `exportDate` (no clock in the codec).
- Ids are stable across re-exports of the same (name, key); a different export name gives new ids.

## 5. For other builders and the engine wiring

- D-141 seed: the importer gives exactly `meta.type/data/aliases/featured`, `meta.arc`, `keys` (regex
  keys included; the seed keeps the non-regex ones), `order`, `constant`, `enabled`, and
  `extras.category` (D-165 tree `categoryId`).
- **Open (lead)**: a typed entry's `content` is `''` (D-162 "content only in extras"). When the book
  is `'off'` or `compendium.enabled === false`, D-141/D-142 say typed entries are "plain lore again" —
  with empty content they inject nothing. Either the lore path renders `meta.data` (renderContent)
  for a typed entry with blank content, or the importer should keep RoleCall's content in `content`.
  I followed the note literally.
- The lantern fixture keeps a synthetic `creator_id` (`00000000-…-0a01`) as in fixtures.md §2.3; the
  read test asserts it is dropped. Nothing personal in either fixture file (checked).

## 6. Fixes after the review (fix-codec: breaker#3 import side, breaker#9, fidelity#3)

- **Depth bound (breaker#3, the lead's "import flattens deeper data with a warning").**
  `export const MAX_DATA_DEPTH = 32` in compendium-v1.ts. Every value the reader keeps from the file
  (a typed row's `structured_data`, every `extras.<column>` of a row (`metadata`, RoleCall-only and
  unknown columns, an append's `position/depth/role`), every book extras field, every envelope field)
  is walked from level 1 (the value itself); an object or list at level 33 or deeper is replaced by
  its JSON text, cut to 1000 UTF-16 units plus `…` (never splitting a surrogate pair). The text is
  written by a budgeted serializer, so neither the walk (≤ 33 levels) nor the text (≤ ~1000 levels)
  can overflow the stack, whatever the input depth. Data within the bound is kept as is (the same
  object: CV7's "never rewritten" holds); only a changed object is copied. Warning code `too_deep`,
  message `nested deeper than 32 levels; the deeper parts are kept as their JSON text, cut to 1000
  characters`, folded per field over the rows (`entries[*].metadata.structured_data … (N entries)`),
  plain for book fields (`lorebook.<k>`) and envelope fields (`<k>`). A 20 000-level file now imports
  in milliseconds and its library file is a few KB (it was a RangeError, or an 800 MB pretty-printed file).
- **No throw (breaker#3).** `readCompendium` now returns `CompendiumRead = Imported<LoreBook> &
  { refused?: string }` (exported interface). Anything that still throws while reading (no JSON input
  is known to; a getter or a non-JSON value from an in-process caller does) is caught: empty book
  (named `--as` or the fallback), the warnings so far plus `{code:'unreadable', path:'$', message:
  '<refused>; nothing imported'}`, and `refused = 'could not be read as a RoleCall Compendium export:
  <why>'` (`why` = the error's message; a RangeError reads `it is nested too deeply or too large`).
  `importFile` turns `refused` into `ImportError('unreadable', '<file>: <refused>')`; nothing is saved.
  That branch has no file-level trigger after the bound (it is the safety net), so it is tested
  through readCompendium.
- **`__proto__` and friends (breaker#9).** Keys are kept, never dropped: row columns → `extras`, book
  fields → `extras`, top-level fields → `extras.envelope`, and the bound's copies of nested objects all
  go through a local `put()` (Object.defineProperty for `'__proto__'`, as merge.ts/apply.ts do), so a
  `'__proto__'` key is an own data property and the "kept in extras" warnings are now true. Objects the
  reader passes on by reference (`structured_data`, `metadata`) come from JSON.parse, where such keys
  are already own; `without()` uses Object.fromEntries. `constructor`, `prototype` and the like were
  already own keys (plain assignment shadows a writable inherited property). Nothing touches
  Object.prototype; the keys survive save → loadFromLibrary as own keys.
- **Headers (fidelity#3).** `test/formats-m5a/compendium-read.test.ts` and `compendium-write.test.ts`
  carry the ported-file header (Bunraku:src/formats/rolecall/compendium.test.ts@702d8120, Coneja-Chibi;
  the case names as in m5a-provenance-codec.md). `compendium-import.test.ts` stays fresh (its row says so).
- Tests: 7 new (read: depth flatten + one folded warning, the 32/33 boundary, every other kept value,
  the refusal, `__proto__`/`constructor` everywhere; import: a 20 000-level file end to end, the
  `__proto__` library round trip). All 7 fail on the code before the fix.
