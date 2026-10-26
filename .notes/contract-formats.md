# formats agent: contract notes (M1a)

No contract signature had to change. Notes for the architect and for consumers of `src/formats/`:

## Behaviour other agents can rely on

- **Validators are strict.** Unknown keys are errors (foreign data belongs in `extras`). An optional
  `format` key is accepted only when it names the right format (`core.character/1`, `core.persona/1`,
  `core.preset/1`, `core.lorebook/1`). On success `value` is the input object itself (no copy, no
  normalisation). `name` must be non-empty for Character and Persona; Preset/LoreBook names may be ''.
- **Library files carry no `format` tag**: `saveToLibrary` writes the value as given; `importFile` saves the
  bare `Character`. Same content saved twice reuses the id (idempotent re-import); different content → `id-2`, ...
- **Preset `{{history}}` check is an exact, case-sensitive substring count** over enabled blocks (must be 1).
  If the macro engine also accepts `{{ history }}` or `{{History}}`, validation and assembly should agree —
  please align in `prompt/`.
- **At-depth lore with no role in the source has no `role`** (`{depth}`): the engine should default to `system`
  (ST's default). Depth with no value → 4 (ST `DEFAULT_DEPTH`).
- **Card import, empty string = absent.** `system_prompt: ''` does not become `systemPrompt: ''`, so an empty
  card field never overrides a preset block (§10.2 D-21). `description` is required by the type, so a card
  without one gets `''`. A nameless card takes its file stem (warning `name_from_filename`).
- **Warning codes** (`ImportWarning.code`): `not_honoured`, `unknown_field`, `invalid_value`, `empty_outlet`,
  `books_merged`, `chunk_unreadable`, `repaired_json`, `empty_name`, `name_from_filename`. Per-entry warnings
  in a book are folded: path `…entries[*].field`, message ends with `(N entries)`.

## Gaps in the native types (worked around, worth a decision)

1. `LoreEntry` has no `selective`. ST ignores secondary keys unless `selective` is on, so they are mapped to
   `secondary` only when selective; otherwise they stay in `extras` (same behaviour as ST, round-trip kept).
2. `LoreEntry` has no slot for things ST acts on: `characterFilter`, `groupOverride`, `useGroupScoring`,
   `delayUntilRecursion`, `vectorized`, `triggers`, `automationId`, the `match*` scan sources, SillyBunny's
   `use_regex` and `agentBlacklisted`. They ride `extras` with a `not_honoured` warning when active. M2's lore
   engine may want `characterFilter`, `groupOverride` and the scan sources natively.
3. `Character` has no slot for CCv3 `nickname` (V3 readers use it for `{{char}}`) or `group_only_greetings`:
   both in `extras` with a warning.
4. `ImportError` has no code for "the file is the right kind but broken" (e.g. a PNG whose chara chunk is not
   JSON, or a card that maps to an invalid Character): used `unreadable`.
5. `DetectedKind` has one preset kind: `st_preset` covers the whole ST settings family (chat-completion and
   text-completion presets, instruct and context templates — Bunraku's `looksLikeSettingsExport`). The M2
   preset importer should refuse the non-chat-completion ones with a reason.
6. `detectKind(bytes, filename)` ignores `filename`: detection is by content only (a name can lie).

## Deviation from the task text

- `canonicalId` also keeps combining marks (`\p{M}`), not only `\p{L}\p{N}`: otherwise Devanagari/Thai names
  shatter into hyphens (`नमस्ते` → `नमस-त`). Same D-72 rationale as keeping Cyrillic. Leading marks are trimmed.
  Windows device names (`con`, `nul`, `lpt1`, …) get `-id`, as in Bunraku.

## Extra exports (additive)

- `card.ts`: `isPng`, `isCardObject`, `whyNotCard`, `CARD_SPEC_V2`, `CARD_SPEC_V3`.
- `st-worldinfo.ts`: `coerceStPosition` (numbers, numeric strings, `before_char`/`after_char`/… aliases),
  `coerceStRole`, `splitGroups`, `characterBookAt(book, fallbackName, pathPrefix)`.
- `import.ts`: `detect(bytes) → {kind, reason?}`.
- New helper files: `src/formats/wire.ts` (guards, `WarningSink`), `src/formats/kind-markers.ts`
  (cross-kind markers, JSON readings).
