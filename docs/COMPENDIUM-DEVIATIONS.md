# Compendium deviations

rp-core's Compendium is a port. Its sources are Bunraku @ `702d8120` and RoleCall's Compendium
(VAUDEVILLE `apps/rc` @ `fb8dc623e`). Bunraku is Coneja-Chibi's (Chi's) work, and so is most of
RoleCall's Compendium code. The ported files keep their authors' copyright in their headers, and
`PROVENANCE.md` lists them.

This file lists every place where rp-core's Compendium differs from those sources on purpose. It
is the D-88 list. D-88 put it in `PROVENANCE.md`; D-166 moved it here. **Chi is asked to review it.**
It was written before M5b so that a line she disagrees with would be cheap to change. M5b has now
built filing and the historian on top of these rules; section E lists what it decided on the way.
M5c has now built recall; section F lists what it decided on the way. Those lines are as open to
her review as the older ones.

How to read it:

- `BR:` is Bunraku's `src/`, `RC:` is RoleCall's `apps/rc/src/`. "§" points to
  `docs/ARCHITECTURE.md`. `D-140`…`D-169` and the section letters (A.7, G, H, I) are the M5a
  decisions in `.notes/m5a-decisions.md`; ARCHITECTURE.md rev 16 takes them over. In section E,
  `D-170`…`D-184` and the letters G–K are the M5b decisions in `.notes/m5b-decisions.md` (G and H
  after the two build waves, I after the review and the first live run, J after the second live
  run, K after the final check); ARCHITECTURE.md rev 17 takes them over. In section F, `D-196`…`D-208`
  and the letters G–K are the M5c decisions in `.notes/m5c-decisions.md` (G, H and I after the three
  build waves, J after the live run on Ollama, K after the review); ARCHITECTURE.md rev 19 is to take
  them over.
- **Status** says where a line stands: **M5a**, **M5b** (filing, the historian, the `{{recap}}`
  slot, the background lane, `/memory undo|refile|retry|wait|status`) and **M5c** (recall: the index,
  the full and lite prompts, the lenient reader, the top-up, the `RecallRecord`, the modes and the
  prefetch, tier 1 of the block, `/memory recall|profile|mode`) are built and tested now; **M3** was
  built earlier. **Deferred** marks a line that was decided and then left for a later milestone.
  **M5d** (latency: `id_slot` pinning and the `/slots` probe, Ollama runner options, LM Studio's
  auto-evict, `bench ttft`, the prefetch-quality harness) is decided but not built: none of it can be
  checked on the machine M5c was built on (D-196). Its items concern the servers recall runs on, not
  Bunraku's Compendium, so no line below waits for it.
- Sections A and B were drafted while M5a was designed (D-74…D-89, §5.8, §7.4, D-95). Section C
  lists what the fixtures turned up, now decided. Section D lists what M5a decided while it was
  built, section E what M5b decided, section F what M5c decided. The last section lists what was not
  ported at all.

## A. Prompt text (full profile)

D-88: the full-profile prompts are ported word for word, except these lines. M5b built the filing
and historian prompts: A1–A4 are in the full filing prompt, and a golden test compares it with
Bunraku's rendered text line by line (`test/filing-m5b/prompt.test.ts`). Besides A1–A4 only two
lines that follow from A1 (D-173) and the language line (D-183) differ; section E has them. M5c
built the recall prompt: it is Bunraku's `recallMessages` word for word except A5, A6 and A8–A10,
and a golden test compares it with Bunraku's rendered text (`test/recall-m5c/prompt.test.ts`).
D-183's language line does not apply to recall, which answers handles. The lite prompts (recall,
filing, historian) are new texts, not edits of Bunraku's (sections E and F).

| # | Area | Bunraku | rp-core | Why | Ref | Status |
|---|---|---|---|---|---|---|
| A1 | Filing: books | Lists the writable books; `book` in each answer item | One line: "You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only." `book` is read and ignored | Library books are read-only; every write lands in the session | §7.4.3 edit 1; D-3, D-75 | M5b: built (D-173) |
| A2 | Filing: field list | Top-level fields only | Adds RoleCall's nested forms of `character.relationships`, `.memories` and `.current_state` | Weak models invent shapes; the merge keys need `with`, `nature`, `what_happened` | §7.4.3 edit 2 | M5b: built (the nested table is M5a's `entry-types.ts`) |
| A3 | Filing: memory example | Uses `event` | `{"what_happened":"…","changed_belief":"…"}`; reading still accepts `event` | `event` is not in RoleCall's schema | §7.4.3 edit 2; D-82 | M5b: built |
| A4 | Filing: snapshot | Writable books only | Also the typed entries of readable library books, marked `(library)` | Otherwise filing duplicates them | §7.4.3 edit 3; D-75 | M5b: built; full: under `### <book> (library)` after `### This story`; the lite roster ends such lines with ` (library)` (D-174) |
| A5 | Recall: prefetch | No prefetch | In a prefetch run the user message ends with one more line: "The player has not answered yet; pick what the narrator will most likely need for the next reply." A turn's own recall sends Bunraku's text | Prefetch runs before the player's message exists | §7.4.2; D-78, D-198 | M5c: built |
| A6 | Recall: conversation | The last `contextMessages` (20) messages, whole | The same messages (blank ones too, texts untouched), but at most min(8 000 tokens, 20 % of the recall window), counted from the newest. The first message that does not fit is cut to head and tail and no older one follows it; the newest always goes in, an older one is cut only when ≥ 64 tokens are left, else left out. "(last N messages)" counts the messages sent. Hidden messages are not part of the conversation | Bunraku has no token cap here | §7.4.2; D-198, K | M5c: built |
| A7 | Tagline in index and snapshot lines | `data.tagline` only, which 3 types have; the other 8 show bare names | An explicit `data.tagline` wins; else the first sentence of `description`, ≤ 80 chars | The recall index needs something to choose by | §5.8, §7.4.2; D-151 | M5a builds the tagline (`/memory list`, the brief, `search_lore`); M5b the full filing snapshot's lines (the lite roster has no taglines); M5c: built in the recall index too |
| A8 | Recall: guidance | The Guide's text, then the inline guidance, together cut to 8 000 chars | The session's `compendium.recall.guidance` only (rp-core has no Guides), cut to 8 000 UTF-16 units without splitting a surrogate pair. The block's words are Bunraku's | No Guide store to read | D-198 | M5c: built |
| A9 | Recall: the minimum | `minEntries` as configured, in the HARD REQUIREMENT, in "Select between N and M entries" and in the top-up | Held to `maxEntries` and to the number of entries the index shows, in all three places. The default stays 0, as Bunraku's, so the HARD REQUIREMENT is absent unless set | A minimum above the cap or above the index asks for picks that cannot exist | D-198, K | M5c: built |
| A10 | Recall: the top-up's messages | The first answer as an assistant message, then `moreNudge` as a user message | The request's user message, then a second user message: "Your last answer: " and the first answer's picks as compact JSON (`{"entry_ids":["e3"]}`, re-written from what was read, not the raw text), a new line and Bunraku's `moreNudge` word for word | structuredCall's base messages are system and user messages only; the echo is clean JSON even when the answer was not | D-198 | M5c: built |

## B. Behaviour decided before M5a

Where M5a refined a line, the rp-core column says so and section D has the detail. Where M5b
refined one, section E has the detail, and its Ref column names the row.

| # | Area | Bunraku / RoleCall | rp-core | Why | Ref | Status |
|---|---|---|---|---|---|---|
| B1 | Storage | Writes into scene books; receipts, undo, commit, queue, deps, book writer (≈ 470 lines) | `mem` rows bound to path messages, folded per path; no receipts | Swipe, rewind and fork drop records for free | §5.8; D-74 | M5a |
| B2 | Addressing | Entry ids through receipts | Operations by name (`file`, `arc`, `edit`, `retire`, `restore`, `revert`); identity from `findMatch` at fold time; keys `<type>:<normalizeName(name)>`, never a seq. M5a: a person's `file` rows are pinned to their key (D-168) | Rows land out of order (catch-up historian); a fork renumbers seqs | D-74; D-168 | M5a (agent rows: M5b) |
| B3 | Undo | An undone pass becomes lane debt again; an undone summary is rewritten | A `revert` row closes the key: the pass counts as covered, and only `/memory refile`, staleness or `/memory retry` write it again | Otherwise `/memory undo` is a delayed refile | D-74; q.18 | Fold: M5a. Verbs: M5b |
| B4 | Edits after filing | Records silently diverge from the edited text | An `edit` (any reason, `continue` too) or a `hide` inside a pass's `range`, newer than the row, makes the row stale. An un-hide does not | Written records must match the text | D-86, D-68.4; D-143 | Staleness: M5a. Refiling: M5b |
| B5 | Read-only books | Filing writes a writable book; with a read-only book it makes a duplicate in the session | Library books are never written. A write about a library entity is a session overlay keyed `lib:<book>:<id>`; if the book changes, the deltas apply over the new base. A vanished base: D-147 (section D). Export is the only way into the library | D-3 | D-75; D-147 | M5a |
| B6 | Typed entries in the prompt | They also fire by key in the lore engine (full text at the entry's position), besides recall | Typed entries reach the prompt only through the Compendium. `compendium.books.<id> = 'off'` or `compendium.enabled = false` makes them plain lore again. Untyped entries keep SillyTavern semantics. D-76 also made them recall candidates; M5c left that out, so recall picks typed entries only (section F, "The index") | One path and one budget; a rich character must fit a 16k window | D-76; D-141, D-142; D-196 | Routing: M5a. Untyped recall: deferred (D-196) |
| B7 | Activation and placement | Key activation, plus a recall block before the current message (`BR:core/assembly/assemble.ts:207-211, 346-349`); budget = lore share − lore used; no floor; full text | A model-free selector every turn. Tiers: 0 named in the player's message, 1 recall, 2 named in the last 4 visible messages, 3 a constant library entry. One `[Retrieved World Knowledge]` block at depth 1, source `compendium`, after lore and the author's note, before the Director's directive. Floor of 40 % of the lore share. full: ≤ 12 entries, full render ≤ 4 000 chars, else brief. lite: ≤ 6, brief ≤ 700 chars, block ≤ 1 600 tokens. Cuts follow tier order and go to the trace. M5a: order inside a tier, matching in any order, openings (section D). M5c: tier 1 keeps recall's own order (section F) | One block, one budget, deterministic | D-77; D-153…D-155, D-169; D-203 | M5a; tier 1: M5c, built |
| B8 | Brief render | `renderContent` only | Adds `renderBrief(entry, maxChars)`. Its tail `(more: read_lore C12)` appears only when the request offers `read_lore` and the brief left something out | For lite and long entries | §5.8; D-151 | M5a |
| B9 | Recall schedule | Always synchronous, in the turn (`compendium.recall.on`) | `compendium.recall.mode`: `auto`/`sync`/`prefetch`/`lexical`/`off`; `auto` is prefetch when the recall route's origin is local, sync otherwise. A prefetch still running is waited for ≤ `graceSec` (4 s); a miss goes by `onMiss`, whose `auto` is lexical locally and sync remotely. `lexical` and `off` run no recall, so the block has its tiers 0, 2 and 3 only; the trace's source names the mode. A manual lane or a one-shot command never prefetches: the mode then acts as `onMiss`. `/memory mode` sets it for the session | 4–12 s off the first token on one-slot local backends | D-78; q.16; D-201, G | M5c: built (section F) |
| B10 | Recall deadline | `RECALL_TIMEOUT_MS = 90_000` (`BR:studio/compendium-recall.ts:29`), from the call's start | 30 s local / 20 s remote from the semaphore grant, prefetch 60 s; `compendium.recall.timeoutSec` overrides all three; the top-up gets what is left. A failure falls back to the lexical selector, never a failed turn. +1 024 output tokens when reasoning cannot be turned off (Bunraku always sends `reasoning_effort: "none"`; rp-core sends the binding's reasoning, else off where the model can turn it off, else `low` where it takes an effort level) | 90 s plus the first-byte timeout held answers for minutes | D-78; D-204 | M5c: built |
| B11 | Recall reuse | A cache of 32 successes (`recalled` only; the oldest written goes first, a hit does not refresh it) in process memory, keyed by the scene, the shown messages, the books' revisions, the settings, the model and the Guide | `RecallRecord` stored in `prep` and the commit (a `continue` edit's too). A swipe (`onSwipe: reuse`) or a continue reuses the answered message's record with 0 calls, even after a restart, when it is `recalled` or `empty`; a failed, skipped or absent one runs by the mode. A guided re-roll (`/regen <guidance>`) or `onSwipe: rerun` recalls again, in the turn | Determinism and replay | D-78; D-200, D-203, K | M5c: built |
| B12 | Recall beside the Director | In parallel (`BR:studio/scene-turn.ts:175-183`) | The same (`Promise.allSettled`). When the Director and recall call one origin that has a single place, the Director's request is queued first and recall's behind it; with two places or two origins both ask at once. The grace wait for a prefetch holds the Director back only when both share that single place | KV cache on one slot | §7.4.2; D-203, K | M5c: built |
| B13 | Recall reading | Strict: the first JSON object only, `entry_ids` a list of strings (`BR:core/compendium/recall-parse.ts`) | Lenient: other keys and a bare list, handles in any form, exact names, item objects, cut-off JSON, handles salvaged from prose (section F, "Reading the answer") | Weak local models | §7.4.2; D-199, K | M5c: built |
| B14 | Profiles | Full only | `compendium.profile`; `auto` gives lite below a 24 576 window, judged per agent on its own binding's window (recall's on the recall binding). lite: a short-list of 40 instead of the tree, `LITE_FIELDS`, a roster plus 4 entries instead of the snapshot, smaller limits. `/memory profile` shows each agent's profile and why | 16k windows | D-79; D-154; D-206 | Block limits: M5a. Prompts: M5b (filing, historian), M5c (recall) |
| B15 | Full budgets | Fixed: recall index 20 000, filing snapshot 30 000, historian window 12 000 | Clamped by the window: min(20 000, 25 %), min(30 000, 30 %), min(12 000, 35 %) | Small windows overflow | D-79, §7.4.6 | M5b; the recall index: M5c, built |
| B16 | Freshness | `isStillLive` on the recall index only (`BR:core/compendium/recall-index.ts:33-41`); plots and events judged by `metadata.turnNumber`, which Bunraku never writes; no per-element filter | Derived from provenance, for the block and the index. A summary is hidden while its last message is visible; a plot or event while the message that created it is visible; any top-level list element while the message that added it is visible. M5a: the exact window rule is D-152 (section D). The index reads the window of the request being recalled for (a prefetch: of the head answer's request) | RoleCall's rules, made to work | D-80; D-152; D-197 | Block: M5a. Index: M5c, built |
| B17 | Freshness of library entries | Would compare an imported summary's foreign `turn_range` with this chat | Library base entries, notes, arcs and the person's rows are never hidden. Overlay elements a filing row added are hidden like any other | Foreign indices mean nothing on a path | §7.4.1 | M5a |
| B18 | Merge | Append unless `deepEq` (`BR:core/compendium/merge.ts:12-28`) | Bunraku's `mergeData` plus RoleCall's keyed lists and near-duplicate collapse, with fixes (section D, "Merge") | Otherwise a status change makes a second relationship; RoleCall's `[^a-z0-9]` erases Cyrillic | D-81; D-148 | M5a |
| B19 | Summary identity | `findMatch` by title merges two summaries with the same title | Summaries never merge. A historian summary's key is the end of its range; a hand-filed one's key comes from its title | Different scenes can share a title | §5.8; D-144, D-168 | M5a |
| B20 | Reading filing and historian answers | Any kind or enum error rejects the whole item | Lenient: envelopes, flat items, en/ru type synonyms, camelCase, coercion; a bad field goes to `skipped`; one repair, only if nothing is readable | A weak model loses most items otherwise | D-82 | M5b |
| B21 | Memory and relationship rules | None found in Bunraku; RoleCall rejects the whole call | A memory without `changed_belief` and `changed_behavior`, or a relationship without `with`, is dropped; the rest of the item is kept | RoleCall's rule, softened | D-82 | M5b |
| B22 | Old Bunraku data | Memories use `event` | `event` is read as `what_happened` | — | D-82 | M5b |
| B23 | Historian trigger | Every `interval` player turns | Checked after every accepted answer, after filing: ≥ `interval` (20) player turns past the watermark or ≥ 24 trimmed, uncovered messages. Replaces the `recap` task | Trimming must not lose story | D-83 | M5b |
| B24 | Watermark | Max `turn_range.to` of live summaries (`BR:core/compendium/historian.ts:25-31`) | From non-stale historian rows, reverted ones included; a retired or reverted summary is not rewritten; ranges are path message ids | Stable on swipe and fork | D-83 | M5b |
| B25 | Overlap | 10 | 10 full / 6 lite | Lite window | D-83, D-68.1 | M5b |
| B26 | Arc overviews | Constant lore entries, up to 6 000 chars, every turn | First in the `{{recap}}` slot, ≤ half of it (lite: 2 × ≤ 1 200 chars); re-rendered only when the trim boundary moves. In M5a `[Arc]` entries stayed plain lore (C5); M5b puts a library book's `[Arc]` entries in the slot too (section E) | Lore share on 16k; prefix-cache stability | D-83 | M5b |
| B27 | Scheduling | No per-origin semaphore found | A semaphore per origin; local background work waits for no interactive request and ≥ `idleDelaySec` (8 s); after 3 preemptions the task goes first, with `memory_starved` | KV cache and shared pools | D-84 | M5b |
| B28 | `filing.everyN` | Files only the last reply, with the last N user messages (`BR:studio/compendium-hooks.ts:25-27, 46`) | One task per N accepted answers covers all N exchanges; split if over budget | The in-between replies were lost | D-86 | M5b |
| B29 | Filing deadline | None, and no abort signal | 300 s local / 120 s remote from the grant, with a signal | Stuck background work | §7.4.3, D-88 | M5b |
| B30 | Bounds | `MAX_ITEM_CHARS` 6 000, `MAX_ITEMS` 12, `RECEIPT_BUDGET` 48 000, no notice | Item ≤ 6 000 / 3 000 (lite) chars, depth ≤ 6; ≤ 12 / 6 items per pass; ≤ 24 000 chars of ops per row; arc ≤ 6 000 / 1 200; summary ≤ 1 500. No cap on an entry, but `notice{compendium_large_entry}` at 12 000 chars of data | Upsert contract kept; cap at render | D-87; D-144 | Notice: M5a. Caps: M5b |
| B31 | Model binding | `compendium.model ?? scene model` | Role `recall` → `recorder` → `narrator`; `recorder` runs filing and the historian. Live, an RP fine-tune bound as narrator answered recall in character (section F, "The JSON prefill"); the docs advise binding `recall` and `recorder` to an instruction-following model then | A cheap model for recall | D-85; J | M5b (recorder); M5c (recall): built |
| B32 | Director's world snapshot | Exact words through `normalizeName` (`BR:core/director/compendium-snapshot.ts:41-43`), so «Миру» ≠ «Мира»; book order; no truncation | Stems; fields truncated (description 200, role 60, state 120, relationship note 100, place 160); block capped (`WORLD_FULL` 4 000 / `WORLD_LITE` 1 500 chars; counts 15/5/5/5 vs 6/2/3/2) with "(+N more not shown)". M5a: ties, keys, tensions (section D) | Russian inflection; a 10k+ block | §7.4.5, §7.3; D-157 | M5a |
| B33 | `normalizeName` | `BR:core/compendium/relationships.ts:39` | Adds NFKC and `ё`→`е`, keeps `\p{M}`; a nameless string becomes `''`. «Ёж», «ёж» and «Еж» are one name | Russian `ё` | D-95 | M3 |
| B34 | Lookup tool | `explore_lorebook` | `search_lore` / `read_lore` over the whole Compendium (notes, typed entries, arcs), with the `C<n>` handles of D-150; `read_lore` gives the full render, with no freshness filter | One tool family | §7.4.10, D-59; D-156 | M5a |
| B35 | Export | A book read from a RoleCall file is written back from the escrowed raw rows, tree and constraints (`BR:formats/rolecall/compendium.ts:157-178`) | `--format compendium` writes a fresh copy: `tree: null`, no constraints, overlays as whole entries (D-163, section D) | The library book is `core.lorebook/1`, and the tree is derived | §7.4.8; D-163 | M5a |

D-89 (the narrator's reply reserve) concerns the narrator, not Bunraku's behaviour, so it is not
listed. Nor is its notice, `history_crowded`, which M5c built (D-205): it says when the request's
fixed part leaves fewer than 4 messages of history before the player's message.

## C. Found while building the fixtures, now decided

| # | Finding | Decided | Ref |
|---|---|---|---|
| C1 | RoleCall's `affiliations` disagree on the key: the schema requires `org`, but `ARRAY_KEY_FNS` keys by `with` and both trees group by `affiliations[0].with` (`RC:lib/ai/dm-stream/tools/compendium-definitions.ts:111`, `BR:core/compendium/tree.ts:79`) | rp-core reads `org`, else `with`, for the merge key and the Cast group | A.7; D-148, D-165 |
| C2 | RoleCall's service fields on memories (`writer_source`, `source_turn`, `source_job_id`) would render as "Source turn: 14" | Kept in the data at import, never rendered (D-151 render fix 1) | D-151, D-162 |
| C3 | An explicit `tagline` on a type that has no such field | The explicit tagline wins on any type, as in Bunraku; derived otherwise (A7). No deviation from Bunraku | D-151 |
| C4 | Tree labels capitalise ASCII only («закон» stays lower case); places nest by `toLowerCase` | Bunraku's ASCII per-word capitals stay, plus a Unicode capital on the first letter; places nest by `normalizeName` | D-165, G |
| C5 | `[Arc]` overviews before the `{{recap}}` slot exists | Import tags them `meta.arc`. In M5a they stay plain lore (a constant one fires every turn as lore); they are not seeded and not in the block. M5b moved them into the slot: seeded as arcs, routed out of the lore engine (section E) | D-141, D-162, D-177 |
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

## E. Decided while building M5b

All of this section is built in M5b: filing, the historian, the `{{recap}}` slot, the background
lane and its scheduler. One line each, as in section D. The letters G–K are the sections of
`.notes/m5b-decisions.md` (see "How to read it"); "docs/M5B-DEMO.md §4" is the live run on Ollama.
Where a line refines a row of sections A–C, the Ref column names that row.

### Prompts

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| The full filing prompt | `filingMessages` (`BR:core/compendium/filing-prompt.ts`): a `WRITABLE LOREBOOKS` list, `"book":"<book id, optional>"` in the example, a guidance header saying the guidance cannot "change the books you may use", memories with `event` | Word for word except five lines: (1) the books list becomes "You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only."; (2) the character line names RoleCall's nested forms of `current_state`, `relationships` and `memories`, and the example memory has `what_happened`; (3) the snapshot also lists the readable books' typed entries, under `### <book> (library)` after `### This story`; (4) the example has no `"book"`; (5) the guidance header no longer speaks of books. A golden test renders both prompts with the same type list and compares them line by line | Library books are read-only (A1–A4); (4) and (5) only follow from (1) | D-173; A1–A4 |
| The lite filing prompt | — (Bunraku has one profile) | A new text: the rule paragraphs word for word (UPSERT, NO-WRITE DEFAULT, DEDUP with the roster's line shape `Name (aka: …) [type]`, WRITE ONLY WHAT MATTERS, RELATIONSHIPS, guidance, language); `LITE_FIELDS` with the nested forms, enum values and "Other fields of the type are kept if you send them."; "At most 6 items." Instead of the snapshot: a roster of ≤ 60 lines (entries named in the exchange first, the book's marked ` (library)`) and up to 4 named entries as brief JSON. When the roster does not fit, it says "the roster of the N existing entries was left out for room" instead of Bunraku's "these books hold no typed entries yet" | 16k windows (B14); a weak model must not be told that the Compendium is empty | D-173, D-174, I; B14 |
| The lite historian prompt | `historianMessages` says "At most 12 filings." and sets no limit on an overview; its digest lists every live plot | Bunraku's text with "At most 6 filings." and "Keep each overview under 1200 characters."; the digest holds the 6 most recently active plots. In both profiles the digest leaves out resolved, failed and abandoned plots, as the filing snapshot does | Lite window; one plot filter for both agents (Bunraku's snapshot has it, `RESOLVED_PLOT`) | D-176, G; B14 |
| Message numbers in the historian | 0-based live indices, the greeting is 0 (`BR:core/compendium/historian.ts:85`) | D-58's 1-based path positions: the greeting is `[1]`, as `/show` numbers it. Hidden messages are left out, so a number may be skipped | The person and the model see the same numbers; export's `turn_range` stays 0-based (D-163) | D-176 (C-4) |
| The repair | `repairMessages`: the first user message, then "Your previous answer could not be used (<error>):", the answer cut to 2 000 chars and "Answer again with only the JSON object." | `structuredCall`'s corrective pass, the one every agent uses: the bad answer (≤ 1 000 chars) as an assistant message and a fixed correction as a user message; only after a reading failure, never after a provider error, a timeout or a preemption | One mechanism for the Director, filing and the historian | D-173 (C-3); B20 |
| The story's language | A blank `language` adds nothing; a set one ends the rules with "Write every field value in <language>." | A set `compendium.language` as in Bunraku. A blank one: the lane names the story's language by the dominant script of the texts it sends (`agents/compendium/language.ts`: Cyrillic is Russian, or Ukrainian, Belarusian, Serbian or Macedonian by their own letters; Greek, Japanese, Chinese, Korean, Arabic, Hebrew, Thai). A named language ends the rules ("Write every field value in Russian.") and is also the last line of the user message. Latin or mixed texts name nothing: the rules end with "Write every field value in the language the story is written in." and the user message is Bunraku's | Live, a 12B historian wrote English summaries of a Russian story with no language line, and again with the generic one; with the language named it wrote Russian (docs/M5B-DEMO.md §4) | D-183, J |

### Filing

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| The greeting | The greeting counts as a reply and is filed like one (`BR:studio/compendium-hooks.ts`; its test files it with `wait = 2`) | Never filed: an assistant message before the first user message is card material | The card already holds it | D-171 |
| Several answers in one pass (`everyN` > 1) | Bunraku files only the last reply, with the last N player messages (B28); RoleCall sends the N exchanges as history with a line of counts | One pass covers the whole group: "The narrator just wrote these replies, oldest first:" with `[k] <reply>` blocks, then "They answer:" with `[k] <what the player said before reply k>`, then Bunraku's last line. With N = 1 the user message is Bunraku's exactly | Nothing between the passes is lost | D-174; B28 |
| Cutting the exchange's texts | Bunraku sends the reply whole and cuts each player message to its first 4 000 chars (a UTF-16 slice, which may split a pair) | Head and tail around "[... N characters cut from the middle ...]", never inside a surrogate pair: a reply ≤ 8 000 / 6 000 (lite) chars, a player message ≤ 4 000. With N > 1 the texts share what the budget leaves, newest first, and a reply keeps ≥ 1 000. A message too large for the historian's window is cut the same way to fit, instead of parking the historian | Lite budgets; a head-only cut loses how the reply ends | D-174, I |
| A group that does not fit | Bunraku files one reply; RoleCall drops the oldest covered messages until the request fits | The full prompt when the request leaves 4 096 tokens of the recorder's window for the answer, else lite (≤ 45 % of the window); a group that fits neither splits by halves, each part a task at once, keyed by its last answer. The first part's row records `groupEnd` (the whole group's last answer), so the rest is owed at once after a reopen too | Every exchange is filed; a split survives a restart | D-174, I, K; B28 |
| Nothing to file | Bunraku: `{}` has no `filings` list, so it is unreadable and costs a repair call | `{}`, `{"filings": null}`, `"none"` and `[]` read as nothing to file; the row is still written (`ops: []`) and the key is done | D-82's spirit: an empty answer is an answer | G, I |
| Service fields | RoleCall stamps `writer_source`, `source_turn` and `source_job_id` with `??`, so a model's own values win; a model-chosen `turn_range` moves its historian's watermark | Fields a model sends under those names, `turn_range` or `messages_covered` are dropped when its answer is read; the code sets a summary's range and `messages_covered` | Provenance comes from the rows, never from the model | D-175; C2 |
| The memory rule | RoleCall rejects the whole call ("Memory N was not saved. …") | Only that memory is dropped, with a `skipped` line (`memory_rule: …`); likewise a relationship without `with` (`no_with: …`). The rest of the item is filed | One weak memory must not cost the pass | D-175; B21 |
| A cut-off answer | An answer whose JSON did not close is unreadable, and the repair call follows | The items that closed are kept and the unfinished last one is dropped, with a `cut_off` line in `skipped` (in the row and the `done` event); with no closed item the attempt fails (never an empty cover). A cut-off root that is itself one bare item is unreadable. A historian answer cut off before any summary applied, or whose summaries were all refused, fails the attempt | A 12B at 1 500 tokens stops mid-list; what it finished is usable | I, K |

### Historian

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| The watermark | The largest `turn_range.to` of the live summaries (RoleCall: of its rows; a retired newest summary is rewritten, an older one is not) | The end of the covered prefix of the path: the positions that non-stale historian rows' ranges cover (reverted rows included), counted from the start. The next window starts at the first uncovered visible message and stops before the next covered one, so a hole that staleness left is summarised again. Positions before the enable moment count as covered | Stable on swipe and fork; an undo never brings a window back; turning the Compendium on in a long chat does not summarise the past | D-176, G; B24 |
| The overlap | 10 messages, counted in the 12 000-token cap with no floor for new ones: an overlap that fills the cap gives a window that ends before its new part, so the watermark never moves | 10 / 6 (lite) messages, at most a third of the cap (trimmed from the oldest end); at least one new message is always read. The cap is min(12 000, 35 % of the recorder's window) tokens | Bunraku's window could get stuck re-reading its overlap | D-176; B15, B25 |
| `historian.interval = 0` | Bunraku: `interval <= 0` runs nothing (`BR:core/compendium/historian.ts:48`); RoleCall: 0 disables | The historian is off: neither trigger fires, `recap_after` included. §7.4.4 had attached 0 to the turn trigger only. Not a deviation from the sources; listed because the spec read otherwise | `recap_after` cannot be 0, so the spec's reading left no way to turn the historian off | D-176 (C-2); B23 |
| `create_plot` | Bunraku drops a summary's `create_plot`; RoleCall writes that plot first and files the summary under it | Honoured: when `parent_plot` is blank, `create_plot.name` names the plot and its fields make the plot (created if missing) | RoleCall's prompts teach models to send it | G |
| Lengths | Bunraku cuts an overview at 6 000 chars mid-word and sets no limit on a summary | A summary's text is cut to 1 500 chars and an overview to 6 000 / 1 200 (lite) chars, each with "…". In the slot a full-profile overview is cut head-first to fit the arc half | The slot is ≤ 10 % of the window | D-176, I; B30 |
| Library `[Arc]` entries | Constant lore, every turn | An enabled library `[Arc]` entry of a `'read'` book is seeded as an arc (`lib:<book>:<id>`) and routed out of the lore engine; in the slot it is always eligible, after the session's arcs. A session arc of the same plot replaces it there. `search_lore` labels it `arc, <book>`. A book set `'off'`, or the Compendium off: plain lore as before | Lore share on 16k; one place for overviews | D-177, G; B26, C5 |

### The `{{recap}}` slot

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| What the slot holds | Bunraku's smart context (`BR:core/assembly/summary-cut.ts`, RoleCall's `tv_smart_context`) leaves out the oldest messages its recaps cover and puts `[Summary: <title>]` texts in their place; arcs are constant lore. RoleCall's Compendium mode has no arc overview | The history is trimmed by the window, as before. Once something is trimmed, one system message (`src: 'recap'`) right after the greeting takes ≤ 10 % of the window: first `[Arc] <plot>` overviews (the session arcs of the plots its summaries belong to, newest activity first, then library arcs; ≤ half the slot; lite: 2 × ≤ 1 200 chars), then `[Summary: <title>]` texts of the summaries whose range touches or precedes the cut, oldest first; over the budget the oldest drop first. No macro expansion; a preset that holds `{{recap}}` in an enabled block gets the text there. With nothing trimmed nothing is reserved and the request is byte-identical to one without the slot. The block treats keys in the slot as already in the prompt (`inPrompt`) | Smart context is not ported (§7.4.10); the slot only stands in for what the window lost | D-178; B26 |
| Stability | — | While the cut's boundary (the first visible message) holds, the slot renders the same ids and the same arc revisions as the previous request, minus entries no longer live, and adds nothing; an older revision's text is read back from the row that wrote it. A pin holds only under the same profile and slot share, and only while the row with that revision still holds that arc's text op (not undone, not stale, not renumbered by a fork). An empty slot pins nothing | Prefix cache: a rewritten overview must not break the cached prompt until the cut moves | D-178, H, I, K |

### Fold

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Story order | Writes land in the book in the order the passes run | Rows apply by (anchor, kind, seq). An agent row is anchored at the path position of its `on`, a person's row at the position of the newest path message older than the row; at one anchor agent rows come first. A pass stages against exactly what the fold applies before its row, without the key's own rows | A re-write of an old answer (staleness, refile, recovery) lands where its answer is in the story, not after later answers; a person's edit made while answer n was the head wins over any pass of n | D-184, K |
| A person's ops wait for their entry | Bunraku's undo skips an entry the person edited since the pass and lists it | A person's `edit`, `retire` or `restore` whose key does not exist yet is held, and applied right after the entry with that key is created (in seq order); one that never meets its entry stays a `not_found` issue | A refile or a re-write after staleness creates an agent entry again at a later seq; the person's edits must survive it | D-179 |

### The lane and the scheduler

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| When a pass starts | Bunraku starts filing A(n−1) when the turn starts, beside the narrator; §7.4.7's cloud row has it start at `send` too | The lane starts nothing while its own session's turn runs, nor while the head is a user message younger than max(`idleDelaySec`, 2 s) (a `send` whose turn is about to follow). On cloud too the pass waits for the turn's end | A pass begun between a message and its turn is only preempted; on a one-place origin it refilled the server's cache with the filing prompt on every message (docs/M5B-DEMO.md §5, fix 1) | I |
| The idle gate | None: Bunraku's per-scene queue runs a pass as soon as it is queued; RoleCall's post-turn wave runs in the generation job | Per origin, in the scheduler, shared by the sessions on that server, and on local origins only: background waits `idleDelaySec` (8 s) after the last touch (a turn's end, a head move, an edit, a hide, a continue, a swipe, a session open, the end of any interactive request on the origin). A remote origin runs background alongside while places are free | A quick swipe after an answer still finds the narrator's cache warm; a remote origin has no such cache to keep | D-172, G; B27 |
| Retrying a failed pass | Bunraku: a failed receipt stays failed until "File again"; RoleCall: a failed pass is lost | The key is still debt. In auto mode its next attempt waits 15 s × 2^(attempt − 1), at most 5 min (the manual mode of tests does not wait). After `maxAttempts` (3) failures it is parked until `/memory retry`. A task that can never fit (`no_room`) writes one begin and one `failed` row and parks at once | A failing server is not hammered, and nothing is lost | D-171, H, I |
| The circuit breaker | — | When two tasks of one agent park in a row, that agent pauses: no new task of it starts until `/memory retry` or the next open; `notice{memory_paused}` once. `/memory status` shows it, as it shows a recorder with no route | Parking is per key and a historian key moves with its window: a dead recorder was called `maxAttempts` times for every new window | K |

## F. Decided while building M5c

All of this section is built in M5c: the recall agent, its record, its modes and the prefetch. One
line each, as in sections D and E. The letters G–K are the sections of `.notes/m5c-decisions.md` (see
"How to read it"); "the live run" is J, a 12B RP fine-tune on Ollama at 16 384 tokens (lite);
`docs/M5C-DEMO.md` is the scripted demo. Where a line refines a row of sections A–C, the Ref column
names that row. Not in this section: untyped entries as picks (deferred, first row below) and M5d's
latency work (not built; see "How to read it").

### The index

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Candidates | Every enabled, unretired entry of each readable book, classic (untyped) entries included, minus summaries, plots and events still live in the shown messages (`BR:core/compendium/recall-index.ts`) | The view's live typed entries (the session's and the readable library books', overlays applied) as fresh copies at the request's window (B16), minus the entries the `{{recap}}` slot already holds. Notes, arcs and untyped entries are never candidates. D-76 had accepted untyped entries as recall candidates; D-196 deferred that, so recall picks typed entries only and a plain entry still fires by its keys in the lore engine | The block renders typed entries from their data; the deferral kept M5c's scope to the Compendium's own entries. In the demo's draft a prefetch named an untyped song, which is not a candidate | D-196, D-197; D-76, B6, B16 |
| Layout (full) | One tree per book under `=== Lorebook: "<name>" (N entries) ===`; with `bookDisplay: unified` and several books, `World Knowledge (combined):` and a `Book:` line each. `detail` (names, taglines, preview) and `depth` are settings | One `deriveTree` over all candidates under one `=== World Knowledge (N entries) ===` heading; taglines always (A7), depth 2, no settings; whitespace in names folded. An entry the tree hangs under two same-named places is listed once, and a group's count is of the entries listed under it. Kept: the line `[eN] Name (aka a, b) - tagline`, handles in print order, the group walk, the per-line budget whose first miss stops every later line, the `(+N more entries not shown)` tail | The session's entries and the books' are one view with one set of handles; a repeated line would give one entry two handles | D-197, K; A7, B15 |
| The lite shortlist | — (one profile) | At most 40 entries as plain lines, no tree headings, under `## Knowledge Index`: first those named in the player's message or the last 4 messages (the selector's tiers 0 and 2), then by `lexScore` against the last 6 messages over name, aliases and tagline (function words dropped, a spaceless-script run cut into character pairs, a hit in a name or alias first), then the rest newest first. Budget min(2 000, 15 % of the recall window) | A tree of hundreds of entries does not fit a 16k window | D-197, K; B14 |
| A cut or empty index | The omitted count goes to the trace; an index with no entry listed makes no call and is `skipped` | The same, and `notice{recall_index_truncated}` once per session. An empty index makes no call and writes a `skipped` record (`empty_index`) | The person learns why an entry was never offered | D-197, D-204 |

### The prompts and the calls

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| The lite prompt | — (one profile) | A new short system text: ACTIVE and ANTICIPATED only (no ENRICHMENT, no WILD CARD, which would spend 1–2 of 4 picks) and "A few right picks beat many loose ones."; the answer `{"entry_ids": ["e1"]}`, "Select at most N entries; an empty list is fine." No minimum, no reasons kept, no corrective pass, no top-up. 4 picks; 6 messages, blank ones left out, each trimmed and cut to 1 200 chars, together ≤ min(1 500, 20 %) tokens and the whole request ≤ min(6 000, 40 %); guidance cut to 1 000 chars; 200 output tokens (+1 024 as in B10) | 16k windows; a wild card would spend 1–2 of the 4 picks | D-198; B14 |
| The transport | Plain JSON in the answer's text, always (a forced tool choice had failed on some providers) | structuredCall's two transports, as for the Director: `structured` when the model's caps confirm `json_schema` (the schema: `entry_ids`, an enum of the handles up to 200 candidates, and in full an optional `reasons` object), else `tagged`, Bunraku's text read from the answer. A server that refuses the schema gets the `caps.suggest` notice | One mechanism for every JSON agent; on a capable server the schema holds the answer to the handles | D-199; D-98 |
| The JSON prefill | No prefill (RoleCall neither) | On the tagged transport, when the model's caps take an assistant prefill, every call of a JSON agent without a tag sends its answer's opening as the prefill: `{"entry_ids": [` for recall, `{"filings": [` for filing and the historian, on the corrective pass and the top-up too. The answer read is the opening followed by the model's text (the text alone when it restates the opening, opens a fence or a list, or is one whole object). Not sent on the structured transport or to caps without a prefill | In the live run the RP fine-tune answered the recall prompt in character (270 tokens of an innkeeper's prose, no handles). With the prefill it answered valid JSON in 0.4–0.6 s, but its picks leaned hard on the first index line; the prefill fixes the form, not the choice (B31) | D-208, J |
| The repair | After an answer that did not parse: the whole answer as an assistant message, then `REPAIR_NUDGE` ("Your last answer was not the JSON object asked for. …") | structuredCall's corrective pass, as for filing and the historian (section E, "The repair"): the bad answer cut to 1 000 chars as an assistant message, then "Your answer was not usable (<reason>). Answer again with exactly one JSON object following the schema above. Write nothing else.", the reason in the reader's own words ("no JSON object was found" for prose). Full only. Only after a reading failure, never after a provider error, a timeout or a preemption. `REPAIR_NUDGE` is not ported | One mechanism for every JSON agent | D-198; D-173 (C-3) |
| The top-up and the number of calls | Fewer picks than `minEntries` and one call so far (`calls < 2`): one more call; it replaces the first answer only when it parses and has more picks. The repair or the top-up is the second call, never both | The same rule: full only, only after a first answer that took one model call, within what is left of the deadline and only with room for an answer; the minimum held as in A9, the messages as in A10, the prefill as above. Unlike Bunraku, a provider error gets the shared §6.6 retry once; a retried first answer gets no top-up, but a reading failure after the retry still gets the corrective pass (three calls, four when the corrective pass's own call is retried), and the top-up's own call can be retried too (three calls). Ruling K's "at most two recall calls" holds only where no retry ran | Bunraku's limit, kept for the top-up; the retry is the engine's for every call | D-198, K |

### The prefetch

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| When it runs | — (recall runs in the turn, after the player's message) | While the lane is in auto mode and the mode wants a prefetch (B9), once the head is an assistant reply (an answer, or the greeting the first reply will answer), the lane runs `prerecall:<head>` on the recall route: at background priority, before the filing and historian tasks (after a starved one), behind the idle gate, preempted by any interactive request on the origin and started again after the gate. It writes no job row, is never journaled or recovered (a crash is a miss), and keeps its record in memory. Its request is the turn's with the head answer as the last message, plus A5's line; its deadline is 60 s (B10) | The first token does not wait for recall on a one-slot local server (B9) | D-202, H; A5, B9 |
| Its basis | The cache key: the scene, the shown messages' ids and texts, each book's revision, the settings, the model and the Guide | The head (the newest assistant reply before the player's message, the player's own messages stacked under it skipped), the newest edit or hide of a path message up to it and the number hidden, and a fingerprint of the recall setup (model, window, profile, numbers, guidance, timeout, reasoning, samplers, output limit). Not the Compendium's revision: picks are entry keys and the block reads their current text, so an entry filed after the prefetch is shown as it now reads, and one created after it is still reachable by name (tiers 0 and 2) and by search | With the revision in the basis, every lane row filed after a prefetch (filing is on by default) wasted it: a second, byte-identical prefetch per answer (`docs/M5C-DEMO.md` §5) | D-202, H, I, K |
| The grace wait | — | A turn whose basis has a stored prefetch adopts it with no call. One still queued or running is promoted to interactive priority and awaited ≤ `graceSec`; one later than that is cancelled and the turn goes by `onMiss`. A Stop ends the wait and lets the prefetch run on at background. `prefetch_missed` (record and notice, once per session) only when the turn waited for a prefetch that existed and got no selection; a failed prefetch is a fallback with its own code and no notice; a basis nothing was held for falls back with no record | The player never waits longer than `graceSec` for a guess | D-203, D-204, G, H, K |
| What it cannot know | — (recall reads the player's message) | A prefetch picks before the player writes. In the live run an adopted prefetch could not know the player would ask about a merchant by description. Entries named in the player's message still come in at tier 0, and `sync` recalls after the message. A guided re-roll or `onSwipe: rerun` recalls again in the turn and never adopts the prefetch the first version used | The trade for not waiting; the mode is the person's choice | J, K; B9, B11 |
| Its calls | — | An adopted prefetch's calls count in `/usage` through its record (`calls`, `model`), not in the turn's `trace.calls` or its call ceiling. A prefetch never adopted is not journaled, so its calls are not in `/usage` (like a superseded lane run). A sync recall's calls go to `trace.calls` after the Director's and count toward the ceiling | The journal records what a reply used | D-204, H |

### The record, tier 1 and the notices

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Tier 1 | The picks go into their own `[Retrieved World Knowledge]` block before the current message, as whole `[Lore: <title>]` sections in the selector's order, within the lore share left after lore; an entry lore already placed is skipped (`BR:core/assembly/recall-place.ts`) | Picks are tier 1 of the one M5a block (B7) and keep recall's order there, where D-153 orders the other tiers by cast last, recency and handle. A pick named in the player's message is tier 0 instead. All tiers share the block's caps, floor and budget, and cuts follow tier order | The model's ranking is what recall knows that the selector does not; one block, one budget (B7) | D-203 (D-153 amended); B7 |
| The record | `RecallRun`, in the trace only: status, reason, model, calls, cached, the picks with reasons, counts | A typed `RecallRecord` in `prep` and the commit: picks as entry keys (full: with their reasons); `status` (recalled, empty, skipped, failed); `source` (sync, prefetch, lexical, reused); a `code` (such as `empty_index`, `no_connection`, `no_room`, `prefetch_missed`, `timeout`, `undecodable`); counts (unknown, repeated, trimmed, by name, salvaged, omitted); calls, ms, usage. A stored record that does not check reads as absent. `/memory recall [--turn <id>]` and the `/trace` `recall:` line show it; `/preview --turn` and `/trace` of a continued answer use the record of the request they show; a preview of the next turn makes no recall call (lexical) | Reuse and replay (B11) | D-200, D-203, D-206, H, K; B11 |
| No room, no model | A Compendium model that cannot be connected is `skipped`; nothing checks the room | The D-195 fit check comes first: a turn that cannot fit makes no recall call. A recall request that leaves its answer less than its floor writes a `skipped` record (`no_room`) and the turn goes lexical; so does a recall role with no connection (`no_connection`) | No call whose answer cannot fit | D-203, G |
| Notices | None (the counts go to the trace) | `recall_slow` once per session after 3 sync recalls slower than 8 s of their own time (not the wait for the Director's place), advising prefetch or a cheaper recall model; `prefetch_missed` and `recall_index_truncated` as above | The person learns what recall costs and what it missed | D-204, K |

### Reading the answer

| Area | Bunraku / RoleCall | rp-core | Why | Ref |
|---|---|---|---|---|
| Where the picks are | The first complete JSON object (inside a code fence first); `entry_ids` must be a list of strings, else the whole answer is refused (`bad_shape`) | `entry_ids`, `picks`, `entries` or `entry_names` (compared without case, `_` or `-`), or a bare list. The first whole JSON value of recall's shape that picks something wins; an opener that never closes does not stop the search, a later whole value wins over a cut or a repaired rest, and the prompt's own example echoed before the answer never wins. As in Bunraku, the reasoning is never searched for JSON (rp-core's other agents fall back to it, D-60); it stands in for a blank answer only when the model's caps say the answer arrives there | Weak local models wrap, rename and restate | D-199, K; B13 |
| What a pick may be | A handle string, trimmed, matched exactly | A handle in any case, bracketed or zero-padded (`E12`, `[e12]`, `e012`), an index line copied whole, or several handles in one item (`e1 and e2`), all counted; an exact name or alias (`normalizeName`, unique among the shown entries; a name that starts like a handle is the name); an object `{id\|handle\|name, reason}` or `{"e1": "reason"}`. Unknown, repeated and over-cap picks are dropped and counted in Bunraku's order; reasons are cut to 200 chars (lite keeps none) | Weak local models name entries or quote lines instead of giving bare handles | D-199, K; B13 |
| Damaged answers | Anything that does not parse is a refusal (`no_json`), repaired once | A cut-off answer keeps its closed items (`cutOff`); a cut that closed none is no success. When nothing reads, handles are fished from the prose (counted `salvaged`). Text with no readable selection is `undecodable`, and `no_output` is only an empty answer; a wrong shape reads as `invalid` and is recorded as `undecodable`. RoleCall's name resolution and parse ladder (`pregen-retrieval.ts`) were read as test vectors only; no code was taken | A 12B stops mid-list or answers in prose; what it named is usable | D-199, D-208, K; B13 |

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
- Bunraku's recall cache (32 successes in process memory, `clearRecallCache`): the stored
  `RecallRecord` and the prefetch's basis take its place (B11, section F).
- `REPAIR_NUDGE` (structuredCall's corrective pass instead, section F) and the recall Guide (A8).
- The recall settings `detail`, `depth` and `bookDisplay` (the index has taglines, depth 2 and one
  heading, section F), and `keywordHints`, which nothing reads at the pin.
