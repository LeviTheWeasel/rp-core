# Compendium deviations

rp-core's Compendium is a port. Its sources are Bunraku @ `702d8120` and RoleCall's Compendium
(VAUDEVILLE `apps/rc` @ `fb8dc623e`). Bunraku is Coneja-Chibi's (Chi's) work, and so is most of
RoleCall's Compendium code. The ported files keep their authors' copyright in their headers, and
`PROVENANCE.md` lists them.

This file lists every place where rp-core's Compendium differs from those sources on purpose. It
is the D-88 list. D-88 put it in `PROVENANCE.md`; D-166 moved it here. **Chi is asked to review it
before M5b.** M5b builds filing and the historian on top of these rules, so a line she disagrees
with is cheap to change now.

How to read it:

- `BR:` is Bunraku's `src/`, `RC:` is RoleCall's `apps/rc/src/`. "§" points to
  `docs/ARCHITECTURE.md`. `D-140`…`D-169` and the section letters (A.7, G, H, I) are the M5a
  decisions in `.notes/m5a-decisions.md`; ARCHITECTURE.md rev 16 takes them over.
- **Status** says where a line stands: **M5a** is built and tested now; **M5b** (filing, the
  historian, `/memory undo|refile|retry`) and **M5c** (recall) are decided but not built yet; **M3**
  was built earlier.
- Sections A and B were drafted while M5a was designed (D-74…D-89, §5.8, §7.4, D-95). Section C
  lists what the fixtures turned up, now decided. Section D lists what M5a decided while it was
  built. The last section lists what was not ported at all.

## A. Prompt text (full profile)

D-88: the full-profile prompts are ported word for word, except these lines. None of these prompts
exists yet. The lite prompts (recall, filing, historian) are new texts, not edits of Bunraku's.

| # | Area | Bunraku | rp-core | Why | Ref | Status |
|---|---|---|---|---|---|---|
| A1 | Filing: books | Lists the writable books; `book` in each answer item | One line: "You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only." `book` is read and ignored | Library books are read-only; every write lands in the session | §7.4.3 edit 1; D-3, D-75 | M5b |
| A2 | Filing: field list | Top-level fields only | Adds RoleCall's nested forms of `character.relationships`, `.memories` and `.current_state` | Weak models invent shapes; the merge keys need `with`, `nature`, `what_happened` | §7.4.3 edit 2 | M5b (the nested table is in M5a's `entry-types.ts`) |
| A3 | Filing: memory example | Uses `event` | `{"what_happened":"…","changed_belief":"…"}`; reading still accepts `event` | `event` is not in RoleCall's schema | §7.4.3 edit 2; D-82 | M5b |
| A4 | Filing: snapshot | Writable books only | Also the typed entries of readable library books, marked `(library)` | Otherwise filing duplicates them | §7.4.3 edit 3; D-75 | M5b |
| A5 | Recall: prefetch | No prefetch | Adds "The player has not answered yet; pick what the narrator will most likely need for the next reply." | Prefetch runs before the player's message exists | §7.4.2; D-78 | M5c |
| A6 | Recall: conversation | 20 messages | 20 messages and at most min(8 000 tokens, 20 % of the window); a long message is cut to head and tail | Bunraku has no token cap here | §7.4.2 | M5c |
| A7 | Tagline in index and snapshot lines | `data.tagline` only, which 3 types have; the other 8 show bare names | An explicit `data.tagline` wins; else the first sentence of `description`, ≤ 80 chars | The recall index needs something to choose by | §5.8, §7.4.2; D-151 | M5a builds the tagline (`/memory list`, the brief, `search_lore`); the index and snapshot lines come with M5b/M5c |

## B. Behaviour decided before M5a

Where M5a refined a line, the rp-core column says so and section D has the detail.

| # | Area | Bunraku / RoleCall | rp-core | Why | Ref | Status |
|---|---|---|---|---|---|---|
| B1 | Storage | Writes into scene books; receipts, undo, commit, queue, deps, book writer (≈ 470 lines) | `mem` rows bound to path messages, folded per path; no receipts | Swipe, rewind and fork drop records for free | §5.8; D-74 | M5a |
| B2 | Addressing | Entry ids through receipts | Operations by name (`file`, `arc`, `edit`, `retire`, `restore`, `revert`); identity from `findMatch` at fold time; keys `<type>:<normalizeName(name)>`, never a seq. M5a: a person's `file` rows are pinned to their key (D-168) | Rows land out of order (catch-up historian); a fork renumbers seqs | D-74; D-168 | M5a (agent rows: M5b) |
| B3 | Undo | An undone pass becomes lane debt again; an undone summary is rewritten | A `revert` row closes the key: the pass counts as covered, and only `/memory refile`, staleness or `/memory retry` write it again | Otherwise `/memory undo` is a delayed refile | D-74; q.18 | Fold: M5a. Verbs: M5b |
| B4 | Edits after filing | Records silently diverge from the edited text | An `edit` (any reason, `continue` too) or a `hide` inside a pass's `range`, newer than the row, makes the row stale. An un-hide does not | Written records must match the text | D-86, D-68.4; D-143 | Staleness: M5a. Refiling: M5b |
| B5 | Read-only books | Filing writes a writable book; with a read-only book it makes a duplicate in the session | Library books are never written. A write about a library entity is a session overlay keyed `lib:<book>:<id>`; if the book changes, the deltas apply over the new base. A vanished base: D-147 (section D). Export is the only way into the library | D-3 | D-75; D-147 | M5a |
| B6 | Typed entries in the prompt | They also fire by key in the lore engine (full text at the entry's position), besides recall | Typed entries reach the prompt only through the Compendium. `compendium.books.<id> = 'off'` or `compendium.enabled = false` makes them plain lore again. Untyped entries keep SillyTavern semantics and become recall candidates | One path and one budget; a rich character must fit a 16k window | D-76; D-141, D-142 | Routing: M5a. Untyped recall: M5c |
| B7 | Activation and placement | Key activation, plus a recall block before the current message (`BR:core/assembly/assemble.ts:207-211, 346-349`); budget = lore share − lore used; no floor; full text | A model-free selector every turn. Tiers: 0 named in the player's message, 1 recall, 2 named in the last 4 visible messages, 3 a constant library entry. One `[Retrieved World Knowledge]` block at depth 1, source `compendium`, after lore and the author's note, before the Director's directive. Floor of 40 % of the lore share. full: ≤ 12 entries, full render ≤ 4 000 chars, else brief. lite: ≤ 6, brief ≤ 700 chars, block ≤ 1 600 tokens. Cuts follow tier order and go to the trace. M5a: order inside a tier, matching in any order, openings (section D) | One block, one budget, deterministic | D-77; D-153…D-155, D-169 | M5a (tier 1: M5c) |
| B8 | Brief render | `renderContent` only | Adds `renderBrief(entry, maxChars)`. Its tail `(more: read_lore C12)` appears only when the request offers `read_lore` and the brief left something out | For lite and long entries | §5.8; D-151 | M5a |
| B9 | Recall schedule | Always synchronous | `auto`/`sync`/`prefetch`/`lexical`/`off`; `auto` is prefetch on a local origin, sync otherwise; prefetch waited for ≤ `graceSec` (4 s); a miss falls back to lexical locally, sync remotely | 4–12 s off the first token on one-slot local backends | D-78; q.16 | M5c |
| B10 | Recall deadline | `RECALL_TIMEOUT_MS = 90_000` (`BR:studio/compendium-recall.ts:29`) | 30 s local / 20 s remote from the semaphore grant (prefetch 60 s); a failure means lexical fallback, never a failed turn; +1 024 tokens when reasoning cannot be turned off | 90 s plus the first-byte timeout held answers for minutes | D-78 | M5c |
| B11 | Recall reuse | LRU of 32 entries in process memory | `RecallRecord` stored in `prep` and the commit; swipe and continue reuse it with 0 calls, even after a restart | Determinism and replay | D-78 | M5c |
| B12 | Recall beside the Director | In parallel (`BR:studio/scene-turn.ts:175-183`) | The same, but on a one-slot origin the semaphore runs the Director first | KV cache on one slot | §7.4.2 | M5c |
| B13 | Recall reading | Strict: the first JSON object only (`BR:core/compendium/recall-parse.ts`) | Also a bare array, an exact normalized candidate name, and handles salvaged from prose | Weak local models | §7.4.2 | M5c |
| B14 | Profiles | Full only | `compendium.profile`; `auto` gives lite below a 24 576 window. lite: a short-list of 40 instead of the tree, `LITE_FIELDS`, a roster plus 4 entries instead of the snapshot, smaller limits | 16k windows | D-79; D-154 | Block limits: M5a. Prompts: M5b/M5c |
| B15 | Full budgets | Fixed: recall index 20 000, filing snapshot 30 000, historian window 12 000 | Clamped by the window: min(20 000, 25 %), min(30 000, 30 %), min(12 000, 35 %) | Small windows overflow | D-79, §7.4.6 | M5b/M5c |
| B16 | Freshness | `isStillLive` on the recall index only (`BR:core/compendium/recall-index.ts:33-41`); plots and events judged by `metadata.turnNumber`, which Bunraku never writes; no per-element filter | Derived from provenance, for the block and (M5c) the index. A summary is hidden while its last message is visible; a plot or event while the message that created it is visible; any top-level list element while the message that added it is visible. M5a: the exact window rule is D-152 (section D) | RoleCall's rules, made to work | D-80; D-152 | Block: M5a. Index: M5c |
| B17 | Freshness of library entries | Would compare an imported summary's foreign `turn_range` with this chat | Library base entries, notes, arcs and the person's rows are never hidden. Overlay elements a filing row added are hidden like any other | Foreign indices mean nothing on a path | §7.4.1 | M5a |
| B18 | Merge | Append unless `deepEq` (`BR:core/compendium/merge.ts:12-28`) | Bunraku's `mergeData` plus RoleCall's keyed lists and near-duplicate collapse, with fixes (section D, "Merge") | Otherwise a status change makes a second relationship; RoleCall's `[^a-z0-9]` erases Cyrillic | D-81; D-148 | M5a |
| B19 | Summary identity | `findMatch` by title merges two summaries with the same title | Summaries never merge. A historian summary's key is the end of its range; a hand-filed one's key comes from its title | Different scenes can share a title | §5.8; D-144, D-168 | M5a |
| B20 | Reading filing and historian answers | Any kind or enum error rejects the whole item | Lenient: envelopes, flat items, en/ru type synonyms, camelCase, coercion; a bad field goes to `skipped`; one repair, only if nothing is readable | A weak model loses most items otherwise | D-82 | M5b |
| B21 | Memory and relationship rules | None found in Bunraku; RoleCall rejects the whole call | A memory without `changed_belief` and `changed_behavior`, or a relationship without `with`, is dropped; the rest of the item is kept | RoleCall's rule, softened | D-82 | M5b |
| B22 | Old Bunraku data | Memories use `event` | `event` is read as `what_happened` | — | D-82 | M5b |
| B23 | Historian trigger | Every `interval` player turns | Checked after every accepted answer, after filing: ≥ `interval` (20) player turns past the watermark or ≥ 24 trimmed, uncovered messages. Replaces the `recap` task | Trimming must not lose story | D-83 | M5b |
| B24 | Watermark | Max `turn_range.to` of live summaries (`BR:core/compendium/historian.ts:25-31`) | From non-stale historian rows, reverted ones included; a retired or reverted summary is not rewritten; ranges are path message ids | Stable on swipe and fork | D-83 | M5b |
| B25 | Overlap | 10 | 10 full / 6 lite | Lite window | D-83, D-68.1 | M5b |
| B26 | Arc overviews | Constant lore entries, up to 6 000 chars, every turn | First in the `{{recap}}` slot, ≤ half of it (lite: 2 × ≤ 1 200 chars); re-rendered only when the trim boundary moves. Until then `[Arc]` entries stay plain lore (C5) | Lore share on 16k; prefix-cache stability | D-83 | M5b |
| B27 | Scheduling | No per-origin semaphore found | A semaphore per origin; local background work waits for no interactive request and ≥ `idleDelaySec` (8 s); after 3 preemptions the task goes first, with `memory_starved` | KV cache and shared pools | D-84 | M5b |
| B28 | `filing.everyN` | Files only the last reply, with the last N user messages (`BR:studio/compendium-hooks.ts:25-27, 46`) | One task per N accepted answers covers all N exchanges; split if over budget | The in-between replies were lost | D-86 | M5b |
| B29 | Filing deadline | None, and no abort signal | 300 s local / 120 s remote from the grant, with a signal | Stuck background work | §7.4.3, D-88 | M5b |
| B30 | Bounds | `MAX_ITEM_CHARS` 6 000, `MAX_ITEMS` 12, `RECEIPT_BUDGET` 48 000, no notice | Item ≤ 6 000 / 3 000 (lite) chars, depth ≤ 6; ≤ 12 / 6 items per pass; ≤ 24 000 chars of ops per row; arc ≤ 6 000 / 1 200; summary ≤ 1 500. No cap on an entry, but `notice{compendium_large_entry}` at 12 000 chars of data | Upsert contract kept; cap at render | D-87; D-144 | Notice: M5a. Caps: M5b |
| B31 | Model binding | `compendium.model ?? scene model` | Role `recall` → `recorder` → `narrator`; `recorder` runs filing and the historian | A cheap model for recall | D-85 | M5b/M5c |
| B32 | Director's world snapshot | Exact words through `normalizeName` (`BR:core/director/compendium-snapshot.ts:41-43`), so «Миру» ≠ «Мира»; book order; no truncation | Stems; fields truncated (description 200, role 60, state 120, relationship note 100, place 160); block capped (`WORLD_FULL` 4 000 / `WORLD_LITE` 1 500 chars; counts 15/5/5/5 vs 6/2/3/2) with "(+N more not shown)". M5a: ties, keys, tensions (section D) | Russian inflection; a 10k+ block | §7.4.5, §7.3; D-157 | M5a |
| B33 | `normalizeName` | `BR:core/compendium/relationships.ts:39` | Adds NFKC and `ё`→`е`, keeps `\p{M}`; a nameless string becomes `''`. «Ёж», «ёж» and «Еж» are one name | Russian `ё` | D-95 | M3 |
| B34 | Lookup tool | `explore_lorebook` | `search_lore` / `read_lore` over the whole Compendium (notes, typed entries, arcs), with the `C<n>` handles of D-150; `read_lore` gives the full render, with no freshness filter | One tool family | §7.4.10, D-59; D-156 | M5a |
| B35 | Export | A book read from a RoleCall file is written back from the escrowed raw rows, tree and constraints (`BR:formats/rolecall/compendium.ts:157-178`) | `--format compendium` writes a fresh copy: `tree: null`, no constraints, overlays as whole entries (D-163, section D) | The library book is `core.lorebook/1`, and the tree is derived | §7.4.8; D-163 | M5a |

D-89 (the narrator's reply reserve) concerns the narrator, not Bunraku's behaviour, so it is not
listed.

## C. Found while building the fixtures, now decided

| # | Finding | Decided | Ref |
|---|---|---|---|
| C1 | RoleCall's `affiliations` disagree on the key: the schema requires `org`, but `ARRAY_KEY_FNS` keys by `with` and both trees group by `affiliations[0].with` (`RC:lib/ai/dm-stream/tools/compendium-definitions.ts:111`, `BR:core/compendium/tree.ts:79`) | rp-core reads `org`, else `with`, for the merge key and the Cast group | A.7; D-148, D-165 |
| C2 | RoleCall's service fields on memories (`writer_source`, `source_turn`, `source_job_id`) would render as "Source turn: 14" | Kept in the data at import, never rendered (D-151 render fix 1) | D-151, D-162 |
| C3 | An explicit `tagline` on a type that has no such field | The explicit tagline wins on any type, as in Bunraku; derived otherwise (A7). No deviation from Bunraku | D-151 |
| C4 | Tree labels capitalise ASCII only («закон» stays lower case); places nest by `toLowerCase` | Bunraku's ASCII per-word capitals stay, plus a Unicode capital on the first letter; places nest by `normalizeName` | D-165, G |
| C5 | `[Arc]` overviews before the `{{recap}}` slot exists | Import tags them `meta.arc`. In M5a they stay plain lore (a constant one fires every turn as lore); they are not seeded and not in the block. M5b moves them into the slot | D-141, D-162 |
| C6 | Entries for the card's character or the persona hit tier 2 almost every turn | Not skipped; they go last inside their tier. The snapshot still counts them as in the scene | D-153 |
| C7 | Stem collisions and blind spots: «Мира» → `мир` (world); «Уголёк» / «Уголька»; «паром» → `пар` | Accepted and documented. No extra rule for short names | D-153 |
| C8 | RoleCall triggers on typed rows: Bunraku fires «Право огня» on any «закон», a plain rp-core port never would | Reversed: a library entry's non-regex lore keys are selector matchers, like its name and aliases. They pick the entry for the block; they never fire its text as lore | D-153, G |
| C9 | The library id of an imported Compendium (`lantern.compendium.json` → `lantern-compendium`) | `--as`, else a non-blank `lorebook.name`, else the file stem without `.compendium` | D-162 |
| C10 | Mirror tensions: the snapshot prints A/B and B/A for one rivalry | Printed once, as an unordered pair | D-157 |
| C11 | RoleCall's export file name replaces every non-ASCII character with `_` (`RC:app/api/content/lorebooks/[id]/compendium/export/route.ts:208`) | Nothing for rp-core to change; it writes `<home>/exports/<id>.compendium.json` | D-163 |

## D. Decided while building M5a

All of this section is built in M5a. One line each. "Bunraku / RoleCall" is what the source does;
a dash means the source has no such case.

### Library books and the fold

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Card and persona books | Bunraku reads the scene's character and persona books as Compendium books too (`BR:studio/compendium-deps.ts:39-51`) | Only library lorebooks of the session are seeded and routed. The card's own book, the persona's and the notes (`@card`, `@persona`, `@notes`) stay plain lore | Overlays are keyed by library id (`lib:<id>:<entry>`); those books have none | D-141 |
| A typed entry needs data | Any row with a known `entry_type` is typed; missing data reads as `{}` (`BR:core/compendium/read.ts:40-54`) | A library entry is typed only when `meta.data` has at least one filled field; otherwise it stays plain lore | Its text is all it has; the Compendium renders from data and would show only `# <title>` | D-141, H |
| Classic names | Bunraku refuses an item when an untyped live entry of the book being written has the name (`BR:core/compendium/snapshot.ts:27-35`, `filing-stage.ts:55-58`); RoleCall upgrades that row to the type in place | `classic_conflict` only against untyped entries of readable library books; the session's notes never conflict. An `arc` whose plot is a classic name still applies, creates no plot and records the issue | Library books are never written, so there is nothing to upgrade; a note is the person's own memory, not the book | D-144, H |
| Identity fields | Bunraku keeps the type's identity field; RoleCall restores `name`, `title` and `topic` | A `file` never replaces a non-blank `name`, `title` or `topic`; only `edit` renames, and the old name becomes a former name | Filing under an alias must not rename the entry | D-144, D-146 |
| Vanished library base | — (both write into the book). §5.8 said "the overlay keeps its deltas" | An `edit`, `retire` or `restore` row on a `lib:` key whose book or entry is gone is skipped, with `notice{library_entry_missing}` once per entry per session. A `file` by name finds no library match and creates a session entry. If the book comes back, the overlay applies again | An overlay without a base has nothing to render | D-147 |
| Handles | Bunraku: entry ids (`explore_lorebook`, receipts); RoleCall: entry UUIDs | One `C<n>` numbering over the whole view: library entries first (config order, then book order), then session entries by creation. Retired entries keep their numbers. `/memory`, the tools and the brief tail print the same handle. Attaching a book shifts the session's handles by its number of typed entries | One handle for the person and the model | D-150 |
| A person's `file` rows | By name, like every row (B2) | The verb stores the key its dry run found (`target`); a refold applies the row there and nowhere else. Attaching a book, switching one to `'read'` or turning the Compendium on later never moves it. A hand-filed summary's key comes from its title (`summary:user:<title>`), so a fork keeps it | A person's entry must not move into a book entry they never chose. Agent rows (M5b) stay by name | D-168 |

### Merge

The RoleCall side is `mergeStructuredData` and `dedupArray`
(`RC:lib/ai/dm-stream/tools/compendium-definitions.ts:66-349`); the Bunraku side is `mergeData`
(`BR:core/compendium/merge.ts`).

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Blank values | RoleCall: `""` and whitespace replace the old value | A blank value (undefined, null, whitespace) never erases, at any depth (Bunraku's rule) | «пустое значение ничего не стирает» | D-148 |
| Blank list items, first writes | Both store them as given; RoleCall appends blank items | Blank list items are dropped; a first write goes through the list merge too, so it is deduplicated | No duplicates from one answer | D-148 |
| Items without a key | RoleCall compares `JSON.stringify` (key order matters) | `deepEq`, as Bunraku | `{a,b}` and `{b,a}` are one item | D-148 |
| Key functions | RoleCall: a string `ability` gets key `\|` and overwrites the previous one; a composite key with empty parts (`\|`) merges unrelated items | String items get their text as key in every keyed field; a composite key whose parts are all empty is no key | Bugs B2 and B3 of the RoleCall study | D-148 |
| Duplicate keys already in a list | RoleCall: the last index wins | The first index wins | Stable positions | D-148 |
| Key text | RoleCall: `toLowerCase` and whitespace | `foldText` (NFKC, lower case, `ё`→`е`, marks dropped), whitespace collapsed | «Ёлка» and «елка» are one key | D-148 |
| Near-duplicate words | RoleCall: `[^a-z0-9]` tokens, English stop words | Word stems; stop words = RoleCall's list + D-46 `STOP_WORDS` + a short Russian list. Same constants (≥ 3 words, Jaccard ≥ 0.8 or subset, scan limit 400, the longer text kept at the first one's place). Known miss: «хранит» / «хранится» | RoleCall's rule erased every Cyrillic word | D-148 |
| When the collapse runs | RoleCall: after every merge, over the whole list | Over the whole list, but only after a merge that added or reworded a string | Same result for lists the fold built; a merge that adds nothing leaves the list alone | D-148, H |
| Deep data | — | Past 32 levels a value is a scalar: it replaces and is never walked | Bounded work on hostile data | H |

### Render

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Service fields | Bunraku's `renderContent` prints every key ("Source job id: …") | `writer_source`, `source_turn`, `source_job_id`, `turn_range`, `messages_covered` and `preserved_prose` are never rendered, at any depth; a list item or section left empty (or a bare `{}`) is not printed | Bookkeeping, not story (§5.8) | D-151 fix 1 |
| Repeated fields | A character's `tagline` prints twice; a summary's `description` too; `aliases` shows as a section on a type that does not list it; a `title` that is the heading shows again | Head fields are not repeated as sections; `aliases` is never a section; the field that gave the heading is not repeated | Quirk 1 of the Bunraku study | D-151 fixes 2–4 |
| Deep data | Bunraku passes a depth it never checks | Lists and objects deeper than 32 levels render as `…` | No stack overflow on hostile data | D-151 fix 5, H |
| Heading | `# <name\|title\|topic>`, else the type's label | The same, but an entry whose data names nothing is headed by its name (a library entry named by its lore title) | `# Character` says nothing | D-151 |
| Brief | — | `renderBrief`: name, tagline, the type's key fields as `Label: value` lines (D-151 table), cut at a line or sentence. An uncapped list of plain values shown whole is no reason for the tail | Lite and long entries | D-151 |

### Freshness, selector, block

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| The visible window | RoleCall: message counts and stamped turn numbers (`RC:lib/ai/tv-stream/compendium-freshness.ts`); Bunraku: the recall index only | Path positions. The window comes from the newest assistant reply before the player's message: its last request (its newest `continue`, if any) and that request's `trimmed {from, to}`. The run `from…to` is not visible; a protected head before `from` is. An unreadable trim means everything is visible. An opening reads the greeting's request | Turn numbers break on swipe and fork; the exclusive/inclusive quirks go away | D-152, G |
| Order inside a tier | §7.4.1: `lexScore`; Bunraku: book order | Entries named like the card's character or the persona last; then (tier 2) the newer message first; then the entry changed last (`prov.lastSeq`); then handle order | Deterministic, nothing to tune | D-153 |
| Library lore keys | A typed row's triggers fire its text at its position | A library entry's non-regex keys (and an overlay's) pick the entry for the block, never fire its text. A key matches as the lore engine's stem keys do: its words in order. When the entry has secondary keys, their logic (`and_any` by default, `and_all`, `not_any`, `not_all`) must hold in the same text. `case_sensitive` is not honoured: stems fold case. Regex keys and former names never match. A session entry's own keys do not match | RoleCall's triggers stay useful without a second path into the prompt (C8) | D-153, I |
| Constant typed entries | Fire every turn as lore | Tier 3 of the selector: in the block after tiers 0–2, under its cap and budget | One path, one budget | D-153 |
| Openings | Bunraku builds no recall block on an opening (`BR:core/assembly/assemble.ts:207-211`) | The selector runs with an empty player message: tier 2 reads the greeting and what precedes it, tier 3 adds constants | Routing took the constant typed entries out of lore; without this an opening would lose them | H |
| Name matching | Key activation matches a trigger as written; Bunraku's snapshot compares whole names by `normalizeName` | Words compare by stems. The name or an alias of a character, location, item, power, organization, creature, threat or worldbuilding entry matches when every word stem is in one text, in any order. One text is one message, or the player's message with a re-roll's guidance. A name with a word of one or two letters or a stop word («Блок А», «The Lantern Guild») must appear in order, as must the titles of events, plots and summaries (they are phrases, not names). Spaceless scripts match as a substring; fewer than 2 letters never match. Known limit: a hyphenated name («Жан-Поль») matches in any order too | §7.4.1 asks for every significant word, not a run. «Это фонарь вашего мужа, Гордея?» must name «Фонарь Гордея»; the first live run missed it | D-169, I |

### Director's world snapshot

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Who is in the scene | Names in the recent messages, exact words | Stems in the last 6 visible messages (D-169 rule), and a library entry's lore keys too; a name equal to the card's or the persona's is in the scene | One matcher for the selector and the snapshot | D-157, G |
| Equal ranks | Book order | Session entries by the newer `prov.lastSeq`; library entries by higher `order`, then book order; library before session | The same priority the lore engine and `search_lore` use | D-157, H |
| Tensions | A/B and B/A both printed (`BR:core/director/compendium-snapshot.ts:73`) | One line per pair; the higher-ranked side's line | Lite has 3 tension slots (C10) | D-157 |
| Status | A non-text `status` prints `Status: ` | Not printed | Empty line | D-157 |
| When | — | Only while `compendium.enabled`; input = live character and location entries of the fold (library, overlays, session), no freshness filter | The Director plans from the whole world, not from what the narrator may repeat | D-157 |

### Import (`compendium-v1.0.0`)

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Detection | Bunraku's predicate; RoleCall also accepts `lorebook: null` | Bunraku's predicate, checked after the SillyTavern preset and before SillyTavern world info and `character_book`. A tagged file is never read as a plain book | A Compendium file used to pass as a `character_book` | D-162 |
| Typed rows | Bunraku keeps the raw row and the file (escrow) | `meta {type, data, aliases, featured}`. RoleCall's text stays in `content` (rendered from data when blank), so an `'off'` book or a disabled Compendium still sends it as plain lore. The Compendium ignores `content` and renders from data | One source of truth; the book still works as plain lore | D-162, G |
| `entry_type` | Compared exactly | Trimmed and lower-cased | Hand-edited files | D-162 |
| `[Arc]` rows | `metadata.source === 'tv_arc_overview'` | That, or a title starting `[Arc]` → `meta.arc` | RoleCall's tree reads the title too | D-162 |
| Triggers | Bunraku reads `{keyword}` records only; RoleCall also plain strings | Both. Regex → `/re/flags`; an unflagged regex gets `i` unless the entry or book is case-sensitive, as RoleCall's matcher does | Keep what RoleCall would match | D-162 |
| Positions | — | world → before, character → after, before_example → examples_before, after_example → examples_after, prepend_top → top, append_bottom → bottom, depth → `{depth: fromRcDepth(d), role}`; `append` → imported disabled with a warning; `scene` → examples_before with a warning | Core slots | D-162 |
| Categories, tree | Bunraku keeps categories with `sort_order`, and the stored tree | Only the category name, as `extras.category`; `sort_order` dropped; `tree` and `nodeConstraints` dropped with one warning | The tree is derived | D-162, D-165 |
| Ids and owners | RoleCall's importer gives fresh UUIDs and remaps references | Ids kept (made unique); creator and fork ids dropped | rp-core has no accounts | D-162 |
| Other columns | Bunraku: `unsupported_fields` | RoleCall-only columns go to `extras`, with a warning when RoleCall would act on them | Nothing silently lost | D-162 |
| Deep data | — | Data nested deeper than 32 levels is kept as JSON text (≤ 1 000 chars) with a `too_deep` warning; a `__proto__` key stays a plain key | Hostile files | H |

### Export

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Scope | Bunraku writes the whole book | The session's entries (notes, typed, summaries, arcs) and overlays as whole entries, live and retired (retired → `enabled: false`). Untouched library entries are not exported | They are in the library already | D-163 |
| Ids | RoleCall: database ids; its scene-fork export: random UUIDs per export; Bunraku: ids as stored | UUIDs derived from (export name, entry key). A re-export keeps them; RoleCall's id remap finds nothing to rewrite | Deterministic files | D-163 |
| `is_featured` | Bunraku writes it per entry, so two featured entries of a type fail RoleCall's unique index | Only the first featured entry of each type; the rest are written unfeatured with a `featured_dropped` warning | RoleCall keeps one per type | D-163 |
| `turnNumber` | RoleCall stamps the turn of the last write | Not written. Summaries get `turn_range {from, to}` (0-based path positions, `to` exclusive) and `messages_covered`; a memory a filing row added gets `source_turn`. No `writer_source` | RoleCall's freshness would hide plots and events in a new chat | D-163 |
| Rows | Bunraku: full rows from the escrow | Thin rows (RoleCall fills the rest); typed `triggers` = name, aliases and the entry's own keys; `tree: null`, `nodeConstraints: []`, `categories: []` | A copy, not a round trip | D-163 |
| Limits | RoleCall refuses > 5 000 entries or > 10 MB on import | The export refuses too, before or while writing; the old file stays whole | Never write a file RoleCall refuses | D-163 |
| `--format core` | — | Refuses a name that is one of the session's books, even with `--force` | It would replace the book with the session's part of it | H |

### Tree

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Labels | `\b\w` capitals, ASCII only | The same, plus a Unicode capital on the first letter («закон» → «Закон»); comparisons are locale-free | Russian labels (C4) | D-165, G |
| Places | Nest by `title.toLowerCase()` | Nest by `normalizeName` of `parent_location` against the name | `ё` and punctuation | D-165 |
| Cast | Groups by `affiliations[0].with` | `org`, else `with` | C1 | D-165, A.7 |
| Narrative plots | `localeCompare` in the machine's locale | `'en'` collation | Same order on every machine | D-165 |
| Categories | By `sortOrder` | By first appearance, names only; a category named "General" joins the General node | The import keeps names only | D-165 |
| Notes, arcs, books | — | Notes go to Unsorted; arcs to Narrative, first in their plot. `/memory tree` shows the session's tree, then one tree per readable book (overlays applied) | The session holds entries a book never has | D-165 |
| Nodes | Carry `kind` and `entryCount` | They do not (`entryCountOf` counts); node `entryIds` are entry keys | Plain data; M5c's recall index reads the keys | D-165 |

## Not ported

These are left out, not changed:

- Reconcile, diagnostics, ingest, standardize, refine, the model-built tree, the dashboard,
  cross-references, dossiers and smart context (§7.4.10).
- Receipts and everything around them: undo by receipt, commit, the queue, deps, the book writer
  (B1). Undo is a `revert` row instead (B3).
- Bunraku's codec registry, the raw-file escrow and its write-back (`mergedRow`), and writing
  `unsupported_fields` and categories (B35).
- `BR:core/compendium/relationships.ts` beyond `normalizeName`: the relationship graph, backlinks
  and mirrors.
- The stored (model-built) tree and `LorebookCategory` ordering.
- `explore_lorebook` (replaced by `search_lore` / `read_lore`, B34).
- RoleCall's content-trigram identity fallback (`CONTENT_TRIGRAM_THRESHOLD = 0.85`): rp-core
  matches entries by names only, as Bunraku does.
- RoleCall's id remap on import (ids are kept) and its `metadata` stamps `chatId`,
  `standardization_state` and `preserve_during_standardize`.
