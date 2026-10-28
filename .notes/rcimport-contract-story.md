# RoleCall story import — contract — story (D-187 library converters, D-188 messages)

Builder: story. Pure functions only: nothing here reads a file, writes the library or a journal, or reads
a clock. The zip reader (D-186) hands the members in; the integration writes what comes out.
Files: `src/formats/rolecall-story.ts` (new, part port), `src/formats/rolecall-think.ts` (new, port),
`test/rcimport/story.test.ts` (33 tests, synthetic data only). Provenance: `rcimport-provenance-story.md`.

## API (`src/formats/rolecall-story.ts`)

### `parseStory(members) → {ok: true, value: StoryBundle} | {ok: false, why}`
- `members`: `Iterable<{name, data: Uint8Array | string}>` or `ReadonlyMap<name, Uint8Array | string>` —
  whatever the zip reader gives; names are relative zip paths (`\` and a leading `./` are normalised).
- Refuses (`ok: false`): no `manifest.json`; invalid JSON; `format` other than `rolecall-story-zip` (the
  `why` names the format, so a `rolecall-backup` manifest reads as such); no chat at all.
- `StoryBundle`:
  - `manifest: StoryManifest` — `version, exportedAt?, rootChatId?, mainChatId?, characterId?, personaId?,
    presetId?, lorebookIds[], chatIds[] (BFS), failedChunks[], appVersion?, stats?`.
  - `character?: {path, bytes, card?: Imported<Character>, raw?}` — the PNG when present (else the JSON),
    read with `readCard`; `card` absent (+ `rc_character_unreadable`) when it cannot be read; `raw` =
    `<name>.raw.json` (never imported).
  - `persona?`, `preset?`: the raw rows; the one whose `id` is the manifest's, else the first (the rest:
    `rc_extra_member`). `books: Rec[]`: every lorebook row with an `entries` list, member order.
  - `chats: StoryChat[]` in the manifest's `chat_ids` order (unlisted folders after, by name). Keyed on
    `chat.json`'s `id`, never the folder name. `StoryChat = {id, dir, parentId, isMain, branchName?,
    branchPointIndex?, title?, summary?, personaId?, lorebooks: {id, enabled}[] (both RoleCall shapes; a
    bare id is enabled), config (the whole blob), createdAt?, updatedAt?, lastMessageAt?, messages: Rec[]
    (lines in index order, malformed lines skipped), tracker?, storyboard?, dmContext?}` (the last three
    raw parsed JSON).
  - `mainChatId`: the chat with `is_main_timeline`, else the manifest's `main_chat_id`, else the first.
  - `warnings`. Codes: `rc_version`, `rc_failed_chunks`, `rc_duplicate_member`, `rc_unreadable`,
    `rc_unknown_member` (folded), `rc_extra_member`, `rc_missing_member`, `rc_no_character`,
    `rc_character_unreadable`, `rc_duplicate_chat`, `rc_unlisted_chat`, `rc_main_chat`, `rc_bad_line`
    (folded), and once per story `rc_hidden_unavailable` / `rc_images_unavailable` (D-188: the exporter
    writes neither; said only when no message carries the field).
- `story.jsonl` is skipped silently (the zip holds the same data; D-185).

### `chatMessages(chat, opts?) → MessagePlan`
- `opts.extraTags`: extra reasoning tag names (e.g. `extractPresetCoTTag(preset prefill)`); the chat's
  own Start Reply With (`config.sampler_overrides.prefill`) is added automatically, as RoleCall does.
- `opts.prefixFrom: {chatId, count}`: the first `count` messages derive their ids from `chatId` instead
  of the chat's own id — for a branch whose copied prefix matched the parent by content, so its prefix
  ids equal the parent session's and a `fork` header can point at them (RoleCall copies message ids).
- `MessagePlan`:
  - `entries: Omit<MsgEntry,'seq'>[]` in write order (parents first): `{t:'msg', ts, id, parent, role,
    blocks, gen?}`. The writer numbers `seq`.
  - `messages: {rcId, index, role, active, versions[], users, contentHash}[]` — per kept RoleCall
    message: the active version id, all version ids in swipe order, user messages up to and including it
    (RoleCall's Director turn there, for D-190), sha256 of role + `content` (for prefix matching).
  - `head` (active version of the last message) and `headMove` (the newest entry is not the head: append
    one `head` entry). `hidden`: active ids with `is_hidden: true` (never in today's export).
  - `fingerprint`: sha256 over the contentHashes (equal chats → equal; D-188's "skip exact duplicates").
  - `counts {messages, versions, users, reasoning, unclosed, emptied, cleaned}`, `warnings`.
- Rules: swipes (objects or bare strings) are sibling versions in swipe order; no swipes → `content` is
  the only version. Active = the LAST swipe whose text equals `content`; none → the last swipe
  (`rc_active_swipe_missing`). Every version of message i has the active version of message i-1 as
  parent. Ids: `rcMsgId(chatId, messageId, swipeIndex)` = first 8 hex of sha256; a collision in the chat
  re-hashes with a retry counter. `message_id` missing → `m_<index>`.
- First kept message, when an assistant one: all its versions `gen {kind:'greeting'}`. Other assistant
  versions: `gen {kind:'model', model?, ms? (generationTimeMs), finish? (stop/end_turn→end,
  length/max_tokens→length, content_filter)}`; no connection. User lines: no gen.
- `ts`: the swipe's timestamp, else the message's, else previous + 1 ms (start: `chat.createdAt`, else
  the epoch).
- Blocks: stored reasoning first (message `thinking` on the active version, swipe `reasoning`), then the
  inline split (assistant lines only) as one reasoning block, then the text. Kind left unset (= raw, as
  rp-core's own commits). If the chat had `keep_inline_thinking_tags` (else `send_thinking_to_llm`) on,
  nothing is split (`rc_reasoning_kept`): RoleCall sent the tags as history.
- Skipped lines: `role: system` (`rc_system_message`), no role (`rc_bad_message`), neither content nor a
  usable swipe, legacy `is_active_swipe: false` lines (`rc_inactive_line`, as RoleCall's reader).
  Same-role neighbours are kept. Summary warnings: `rc_reasoning_split`, `rc_reasoning_tag`.
- Also exported: `rcMsgId`, `keepsInlineThinking(config)`.

### `personaFromRow(row) → Imported<Persona>` (`{name, description}`)
- Name: the row's (trimmed), else `User` (RoleCall's fallback). Description: `generatePersonaXml(name,
  details)` with the row's `section_order` column overriding `details.section_order` (as
  prompt-assembly does), prefixed by `details.injection_prefix` + `\n`. Fallback to `description`, then
  `content`, when `details` is missing or renders no section and has no prefix (`rc_persona_description`).
- `generatePersonaXml(name, details)` is exported (output identical to RoleCall's).
- Not used by RoleCall's prompt and so not carried: `details.lorebook_id` (RoleCall never attaches it; only
  the chat's lorebooks are read), `injection_position/depth`, colors' accents, emoji, tagline.

### `presetFromRow(row, chat?) → Imported<Preset> & {export, overridden}`; `rcPresetExport(row, chat?)`
- `chat = {config?, name?}`: `config` = the chat's config blob; `name` renames the result (the caller's
  `<preset> (<story>)` when `overridden`). `overridden` = the chat's settings changed something.
- `rcPresetExport` builds RoleCall's preset export from the row: prompts in `sort_order` (RoleCall's
  runtime order — preset-loader sorts the rows by it; the exporter's own order resolves to the same),
  each by serializePrompt (the five structural markers sparse; others full, injection position
  normalised 0–4, depth ?? 4, order ?? 100); `prompt_order` = one 100001 order with each row's effective
  `enabled`; samplers from the columns (`max_context` → `openai_max_context`, `max_tokens` →
  `openai_max_tokens`), `prompt_post_processing`, the eight system prompts (snake spelling first, then
  camel, an empty string counts), template formats, behaviour / API options / media / generation keys —
  each only when the row has it; `raw_settings` spread first, as the exporter does; `extensions.rolecall =
  {…raw, category_hierarchy, category_header_identifiers: [], prompt_regex_rules: {}, schema_version: 1,
  edition_kind, source_export: 'rolecall-story-zip-v1'}`. Then `stPresetToPreset` (D-71 RC path).
- Chat overrides in RoleCall's precedence (preset < request): `preset_prompt_overrides[<row id>]` toggles
  (other presets' keys ignored; unknown identifiers said), `sampler_overrides` enabled panel samplers that
  map to a preset field (temperature, top_p, top_k, min_p, top_a, the three penalties, seed, max_tokens;
  others listed in one `not_honoured`), then `preset_sampler_overrides` (camelCase numbers; topK and
  maxTokens rounded; maxContext → `openai_max_context`); post-processing: chat preset override, else the
  panel's, else the row's. A non-blank `sampler_overrides.prefill` (Start Reply With) replaces the
  preset's prefill. A `messages` context mode is said (`not_honoured`), not mapped.
- Warnings added: `rc_duplicate_prompt`, `rc_preset_overrides`, `rc_preset_settings` (the stored original
  ST file is not read), `not_honoured`; the converter's per-name `unknown_macro` lines are replaced by ONE
  `unknown_macro` listing every name (D-187).

### `booksFromRows(rows) → {books: StoryBook[], warnings}`; `compendiumFileOf(row)`
- Each row: `compendiumFileOf` wraps it as `{schemaVersion: 'compendium-v1.0.0', format:
  'rolecall-compendium', lorebook: <the export route's fields + provenance>, entries}` with entries sorted
  by `sort_order` (the story export lists them in database order; the Compendium export by sort_order,
  and readCompendium takes file order as book order) and `consumed_by_split` rows set `enabled: false`;
  then `readCompendium`.
- `StoryBook = {rcIds, book, hash, renamedFrom?, consumed, warnings}`. `hash` = sha256 of the book's
  settings (scanDepth, recursive, caseSensitive, wholeWords, match) and the sorted per-row hashes of the
  converted entries without `id` and `extras` (so row order, ids and RoleCall bookkeeping metadata do not
  count; typed data, arcs, keys, positions, enabled flags do; the name does not). Equal hash → one book;
  the copy whose rows keep the most metadata is read, at the first copy's place; `rcIds` lists the read
  one first (`rc_book_duplicate`). The caller maps a chat's `active_lorebooks` ids through `rcIds`.
- Names: compared trimmed and exact (rp-core's "read once by name"); a later different book with a taken
  name becomes `<name> (<first 8 of its RoleCall id>)` (+ ` 2`, ` 3` if that is taken too;
  `rc_book_renamed`). Re-import reuse by `hash` is the integration's (D-187).
- Per book warnings: readCompendium's, plus `rc_book_consumed` with the count.

## `src/formats/rolecall-think.ts`
`splitThinkingFromContent(content, extraTags?) → {reasoning, visibleContent, blocks}`, plus
`extractThinkingBlocks`, `isLikelyCotTagName`, `extractPresetCoTTag`, `ALWAYS_CAPTURED_REASONING_TAGS`.
RoleCall's Auto policy, unchanged (see the file header for the rules, incl. the unclosed rule: partial
closers, `<answer>`, `Response:`, explicit end markers, glued sentence ends, then the narration boundary,
then a reply that starts at once, else swallow to the end).

## Choices and findings
- `consumed_by_split` (asked): RoleCall's prompt path does NOT exclude these rows. prompt-assembly loads
  every enabled row of every active book with no metadata filter, so an enabled consumed row still fires
  by keyword next to the typed rows split from it. The only exception is a TunnelVision-managed book with
  `suppress_keywords`: there only constant rows are injected at all (the rest is fetched by tools). The
  rows are excluded only from the Compendium dashboard's classic count and from re-standardising
  (standardize.ts: "intentionally orphaned"; the data lives in the typed rows). Importing them disabled
  (D-187) therefore departs from RoleCall's raw keyword path. It matches the TV-managed case for
  non-constant rows and RoleCall's own reading that they are superseded. A consumed row that is constant
  would still have been injected in a managed book; it is disabled here too.
- Inline reasoning is split on assistant lines only. RoleCall strips user lines too, but a user's text
  stays their own (a user line with a reasoning tag is rare; the builder's report says whether any occur).
- A version whose text is swallowed whole by RoleCall's unclosed rule keeps an empty text block after
  the reasoning, as RoleCall sent it (an empty history message); counted as `emptied`.
- No category header prompts in the export (RoleCall's runtime never sends categories; their ids are
  random). Defaults the exporter fills (samplers 0.97/64…, behaviour, API options) are not invented:
  RoleCall's runtime sends only set columns, and invented `true` flags would raise spurious `not_honoured`
  warnings.
- Duplicate prompt identifiers: the first ENABLED row wins (RoleCall's loader filters enabled and then
  keeps the first by identifier); the others are left out of the export.

## Open questions (for the lead)
1. `st-preset.ts` D-71 path: a RoleCall export's custom marker (`marker: true`, an identifier ST does not
   know) WITH text is imported disabled (`unknown_marker`). RoleCall's loader sends it (`enabled &&
   (content || marker)`; only the known slots get macros). RoleCall's own export writes `marker: true` for
   these too, so a real RC export loses them as well. That is a reader fix in st-preset.ts (not my file). It
   affects real presets (the counts are in the builder's report).
2. Emptied answers (see above): keep RoleCall's parity (empty text), or keep the raw content as text?
3. `messages` context mode (RoleCall: the current message + N earlier ones) could map to
   `preset.context.maxMessages` (N + 1). Left as a warning.

## Review fixes (fix-core, after the review)

Files: `src/formats/rolecall-think.ts`, `rolecall-story.ts`, `rolecall-import.ts`, `compendium-v1.ts`,
`src/agents/director/import-rc.ts`; tests `test/rcimport/think.test.ts` (new, 9), `story.test.ts` (+14,
3 updated), `director.test.ts` (+2). Every new test fails on the code before (the timing ones hang).

- **robust#2, the splitter in linear time** (a listed deviation in how, not in what). The token regex
  is a hand-written scanner (`tagCandidates`: every token at every `<`/`[`, overlapping ones too, the
  `\b` before `[^>]*>` kept: a trailing `-` of a name goes back to the attributes); the inner closer
  walk is a lookup (`closerIndex`: per key the running depth of the global token walk; an angle
  token's end is always on that walk, a square opener first walks the square tokens up to the next
  angle token); every terminator search remembers its last answer (openers come in text order): the
  partial closers reduce to the first `</` + two letters (the longest prefix that fits there wins),
  `<answer` is a test for a later `>`, the transition is tried at `from` then searched with
  `(?<!\n)` (same matches, no newline-run backtracking), the end markers keep RoleCall's
  lower-cased-index quirk (an `İ` lengthens the lower-cased text: mapped by position), the no-space end
  is a hand-written `[^\n.]*\.?(?=…)` per line stretch, the word counts read a precomputed index;
  the heading pair is a sticky heading test + the transition search; code ranges, special spans and
  blocks are tested by halves; the blocks are cut in one pass that reproduces RoleCall's
  one-by-one removal also for overlapping special spans. `isSimilarCotTerm` skips the edit table when
  the lengths differ by more than 2 (same result). Checks: RoleCall's own thinking-tags, vvs-265,
  vvs-656 and code-span test files (133) pass on the port; a comparison against RoleCall's file on
  ~600 000 generated texts (tags, partial closers, squares inside angle tokens, newline runs, markers,
  code, both delimiter styles, İ / Kelvin signs) found no difference; 1 MB inputs that took minutes
  now take 10–60 ms. Provenance: the rolecall-think.ts row of rcimport-provenance-story.md should read
  "port, scans rewritten for linear time (results unchanged)".
- **fidelity#1.** `planStoryImport` no longer passes the preset's assistant prefill as a reasoning tag;
  only the chat's own Start Reply With (which `chatMessages` adds) is one, as RoleCall's history strip.
  `extractPresetCoTTag` and `ChatMessagesOptions.extraTags` docs say so.
- **fidelity#2.** `ChatMessagesOptions.names {user, char}`: RoleCall's name macros are written out in
  every version's text block (user and assistant) after the reasoning split: `{{user}}`/`{{player}}`,
  `{{char}}`/`{{character}}`/`{{bot}}` in any case with inner spaces, and `<user>`, `<char>`, `<bot>`;
  `\{{` stays. `rcNames(text, names)` is exported. The plan passes the persona's name (else `User`) and
  the character's. Content hashes (prefix matching, fingerprints) still read the stored text.
- **fidelity#5.** `ChatMessagesOptions.prefixSalts`: message k takes its ids from `prefixSalts[k]`
  (wins over `prefixFrom`); the plan's resolver keeps the parent's salts per message, so a branch of a
  branch whose copy passes the branch's own prefix forks from the branch. `Resolved.prefix` → `salts`.
- **fidelity#6.** `readCompendium`: a non-zero `lorebook.token_budget` is `not_honoured` (path
  `lorebook.token_budget`, the value named), still kept in extras. `booksFromRows` takes those out of
  the books' warnings and says them once: `not_honoured` `lorebooks[*].token_budget`, `"<book>" <value>`
  per book (library names).
- **fidelity#7.** A swipe whose `reasoning_provider` is `inline-tags` keeps one block (the split one, in
  the stored one's place); any stored reasoning equal (trimmed) to the split one is not doubled either.
- **fidelity#8.** `rcPresetExport` sends a slot marker's own text as RoleCall's loader does
  (`markerTexts`): chatHistory → an ordinary prompt `text\n\n{{message_history}}` (alone when a sent
  prompt holds `{{message_history}}`), personaDescription → `text\n\n{{persona}}` (alone when one holds
  `{{persona}}`), charDescription / charPersonality / scenario / dialogueExamples → the text instead of
  the slot; worldInfoBefore / After keep their slot and get their text in a prompt just before them.
  The new prompts are identified `<marker>Text` (the identifier decides a slot in st-preset.ts), enabled;
  a disabled marker is unchanged. The category hierarchy lists the exported identifiers.
- **fidelity#9.** The winner of a repeated identifier is the first row RoleCall's loader would send
  (enabled with text, or a marker); with none, the first row (as before). The warning says so.
- **fidelity#10.** Per chat with `tv_enabled` and books it managed with `suppress_keywords`, one
  `rc_tunnelvision` warning (`chats/<dir>/chat.json`) naming the books (library names): RoleCall
  injected only their constant rows; how many other enabled non-Compendium rows fire by keyword here
  and how many constant consumed rows are imported disabled (`StoryBook.consumedConstant`,
  `compendiumFileOf(...).consumedConstant`). Nothing changes in the books (the ruling: a warning).
- **robust#4.** Times are accepted from 1970 to 9999-12-31T23:59:59.999Z (`RC_TIME_MAX`, exported;
  `isoOf` and `rcIsoTime`); the +1 ms fallback stays at the last time instead of overflowing; message
  and swipe times present but refused are counted in one `rc_bad_time` per chat.
- **robust#5.** Book items are keyed `book:<id>`, and `book:<id>#n` when an earlier book took that key;
  a chat's id names the first book with it; a second different book with the id is imported but
  attached to no session, said once (`rc_duplicate_book_id`, `lorebooks`).
- **robust#7.** Own-key lookups for user strings: `FINISH`, `PANEL_SAMPLERS`, the panel values, the
  chat's per-preset toggles (`own()`), `HIDDEN_FROM_ARC` in import-rc.ts; `raw_settings` keys are
  defined, so a `__proto__` key stays a key and the export's prototype is untouched.
- **ux#9.** `rc_modules` names TunnelVision only with `tv_enabled === true` and immersion modules only
  when one has `enabled`; `rc_chat_summary` ends "the lorebooks keep the story's past" only when every
  chat with a summary has a lorebook, "its text is not imported anywhere" when none has, else how many
  have none.
- **ux#10.** The per-marker `unknown_marker` lines are one: `N marker prompt(s) without text have
  nothing to send and are kept disabled: "a", "b", …` (8 named, then a count). `rc_book_duplicate` is
  one line per merged copy with the same text for every copy of a book (`a copy of lorebook "<library
  name>" with the same rows is imported once`, path the copy's row), so the report folds them into a
  count; `rc_book_consumed` stays one per book (the report names its book) and says what differs from
  RoleCall (its keyword lore still read those rows). Paths and item keys are unchanged for the CLI's
  subject matching.

The user's export (counts only, plan without writes): main 43 distinct warning lines (was 56 lines),
`unknown_marker` 1 (was 14), the 3 duplicate-copy lines one text; the head reply's and the reply
before it's versions carry 3 records; one `rc_tunnelvision`; parse + both plans 1.6 s.
Runs: test/rcimport + test/formats-m5a 194 pass; `bunx tsc --noEmit -p .` clean.
