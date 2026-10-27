# M5a decisions (the lead's design note; authoritative for the M5a build)

M5a = "Compendium: data and manual memory" (ARCHITECTURE.md §15 M5a, §5.8, §7.4, §19.7, D-74…D-89).
The spec is the base; where it is silent, contradicts itself or is overtaken, THIS note decides. Every
D-1xx below becomes a numbered decision in ARCHITECTURE.md rev 16 after the build (question 24: confirm
as a batch). Research the decisions rest on — read the parts your task names:
`<session scratchpad>/m5a/understand/` (the lead gives agents the absolute path)
- `design.md` — the doc's M5a requirements module by module, with line refs, and gaps G-1…G-28;
- `bunraku.md` — every Bunraku file in scope: API, constants, algorithm, tests, quirks (§16);
- `rolecall.md` — RoleCall merge (§1, exact rules §3, vectors §3.1), freshness (§4, vectors §4.4),
  `compendium-v1.0.0` writer/reader (§5, rules §5.4, vectors §5.5);
- `rpcore.md` — what M3/M4 built and where M5a plugs in (§1, §3), tests that change (§5.2);
- `fixtures.md` — real export shape (§1), the Russian `lantern` fixture (§2, JSON in
  `fixtures-draft/lantern.compendium.json`, expected results §2.5), the deviation draft for Chi (§3),
  the innkeeper live demo (§4).

Sources (port from these exact commits; record them in headers and PROVENANCE.md):
- Bunraku `~/Documents/AI/Bunraku` @ `702d81201120a6b90eb29a783a77c60ffdebc374` (HEAD c267aaf1 has
  identical files in scope). Every file in scope: Copyright (C) 2026 Coneja-Chibi.
- RoleCall `~/ST/VAUDEVILLE` apps/rc @ `fb8dc623e6beb24083f5105c828462e89fc66ce3` (the 660a7d67a
  import-commit caveat of PROVENANCE.md applies; authors per rolecall.md §0).
Header for a ported file (as in M4):
```
// Ported from <Repo>:<path>@<commit> (<what>).
// Copyright (C) 2026 <original authors>; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
```
Fresh files keep `// SPDX-License-Identifier: AGPL-3.0-or-later` + `// Copyright (C) 2026 the rp-core authors`.

Public-repo rules (the repo is public on GitHub): no personal e-mail addresses, the author is named
only as Levi, no absolute home or scratchpad paths in tracked files (write `~/…` or
`<session scratchpad>`). Fixtures are synthetic: no creator ids, no real user data.

Machine rules for build agents: run ONLY your own test files (`bun test test/<your dir>`), never the
full suite (the lead runs it, one at a time; memory is limited). `TMPDIR=~/.cache` for any test run.
Typecheck with `bunx tsc --noEmit -p .` is fine.

## A. Superseded or clarified spec text

1. §5.11 `PathView.compendiumAt(msgId)`: PathView stays plain data (M6 serialises it; D-103 precedent).
   The folded view at another message is `foldViewAt(header, idx, leaf, opts)` (exists) with the
   library seed passed in (D-141). No function field.
2. §19.7 puts `identityField` in `types.ts`; it lives in Bunraku `filing-schema.ts:33`. M5a ports it
   into `agents/compendium/entry-types.ts` with the rest of the type tables.
3. §5.8 "CEntry.keys — only notes": from M5a a library entry also carries its non-regex lore keys
   there (selector triggers, D-153).
4. §7.4.1 brief tail `(ещё: read_lore C12)`: prompts are English, so the tail is
   `(more: read_lore C12)` (D-151).
5. `--keep-requests` (ARCH:560) is built now: the M5 demo needs it (D-164).
6. §15 demo "краткую запись": in the full profile a small entry renders full. The demo runs lite or uses
   a long entry; nothing to build.
7. RoleCall `affiliations`: the schema and renderers use `org`, the merge key fn and the trees use
   `with`. Core reads `org ?? with` everywhere (merge key, tree group). Listed deviation.

## B. Data, fold and identity

**D-140 Module map (M5a).** All under `src/agents/compendium/` unless noted.
| file | what | kind |
|---|---|---|
| `entry-types.ts` | SPEC, ENTRY_TYPE_INFO (no UI tokens), REQUIRED_FIELDS, identityField, knownFields, parseStructured, LITE_FIELDS, NESTED | port BR `types.ts`+`entry-types.ts`+`filing-schema.ts:33`; RC nested shapes (CONTRACT, lead) |
| `types.ts` | CEntry, CompendiumView, FoldIssue, LibrarySeed, trace/candidate types | contract (lead) |
| `merge.ts` | mergeData + array keys + near-dup + per-element provenance | adapt BR `merge.ts` + RC `compendium-definitions.ts:66-365` |
| `apply.ts` | fold: path/stale/newest-per-key filter, seed, applyOp for all ops, findMatch/entryNames | extend (BR `snapshot.ts` findMatch, `read.ts`, `filing-stage.ts`) |
| `library.ts` | isCompendiumEntry, bookAccess, librarySeed, routeBooks | fresh (reading rule from BR `read.ts:40-54`) |
| `refs.ts` | entryRefs, resolveEntryRef, refOf | fresh |
| `notes.ts` | notesBook etc. unchanged; noteRefs/resolveNoteRef delegate to refs.ts; isNote excludes arcs | amend |
| `render.ts` | renderContent (port + fixes), renderBrief, taglineOf, RENDER_HIDDEN | port BR `render.ts` + new |
| `fresh.ts` | visibility boundary + visibleCopy (D-80) | fresh (RC `compendium-freshness.ts` rules re-derived) |
| `tree.ts` | derived tree | port BR `tree.ts` (adapter) |
| `select.ts` | selector tiers 0/1/2 | fresh |
| `place.ts` | block builder (pick, fit, text) | adapt BR `assembly/recall-place.ts` |
| `profile.ts` | compendiumProfile, COMPENDIUM_LIMITS | fresh (M5c extends) |
| `world.ts` | worldSnapshot | adapt BR `director/compendium-snapshot.ts` |
| `export.ts` | view → core LoreBook; view → compendium rows | fresh |
| `src/formats/compendium-v1.ts` | detect, read → LoreBook, streamed write | adapt BR `formats/rolecall/compendium.ts` |
Also touched: `session/tree.ts` (touched seqs), `session/fold.ts` (fold options), `session/entries.ts`
(config, trace; lead), `engine/*`, `prompt/assemble.ts`, `tools/handles.ts`, `tools/builtin/lore.ts`,
`formats/import.ts`, `formats/kind-markers.ts`, `config/config.ts`, `cli/*`.

**D-141 Library seed (G-2, G-8, G-10).** Library books enter the fold at the session level, not per
request:
- "Book" = a library lorebook in `SessionConfig.lorebooks`, keyed by its **library id** (the
  `LoreSource.key`). `compendium.books.<libraryId> = 'read' | 'off'`, default `'read'`. `@card`,
  `@persona` and `@notes` are never seeded or routed (the card's own book stays plain lore).
- Books are taken **after** the "a world is read once by name" shadowing (`prompt/assemble/lore.ts`
  `shadowedSessionBooks`), in config order, so a shadowed book seeds nothing.
- `isCompendiumEntry(e)` = `e.meta?.type` is one of the 11 ENTRY_TYPES and `e.meta.arc` is undefined.
  An unknown `meta.type` is plain lore (BR `read.ts:44` rule). `[Arc]` entries (`meta.arc`) stay plain
  lore in M5a (M5b moves them into the `{{recap}}` slot).
- Seeded: compendium entries with `enabled !== false` of `'read'` books. Disabled entries are not seeded.
- Seed CEntry: key `lib:<libraryId>:<entryId>`; `type = meta.type`; `data = meta.data ?? {}` (object
  else `{}`); `name = data.name ?? data.title ?? data.topic ?? entry.title ?? entryId` (first non-blank
  string); `aliases = meta.aliases ?? data.aliases` (strings only, deduped by normalizeName, name
  excluded); `tagline` per D-151; `keys` = the entry's non-regex `keys` (D-153); `featured` =
  `meta.featured === true`; `order = entry.order`; `constant: true` when `entry.constant`; `origin =
  {kind:'library', book: libraryId, id: entryId, overlay:false}`; `prov = {created:null, lastSeq:0,
  appended:{}, createdSeq:0}`.
- `LibrarySeed.classic`: `normalizeName(title)` → key for every enabled untyped entry (no valid
  `meta.type`, no `meta.arc`) of `'read'` books with a title. Used only for `classic_conflict`.
- `LibrarySeed.hash`: sha256 over (`libraryId`, entries JSON) of the seeded books, 16 hex; `''` when
  no book. `CompendiumView.rev` hashes rows AND this hash (so a book change changes `rev`).
- Session: `SessionImpl` loads books once per (config.lorebooks, compendium config, each file's
  mtime+size) and keeps `{sources, seed, notices}`; `view()` caches on (version, memSeq, seed.hash).
  The turn, the preview and the Director all use that one load (no second read in `buildRequest`;
  `RequestInput` takes the loaded books).
- `compendium.enabled === false` → empty seed AND no routing: typed entries are plain lore again.
  The session's own rows still fold (notes and typed entries keep working in `/memory`), but no block
  and no snapshot (D-155, D-157).

**D-142 Routing (D-76).** `routeBooks(sources, cfg)` removes `isCompendiumEntry` entries of `'read'`
books from the lore sources handed to assemble (after shadowing — routing removes entries, never books,
so shadowing by name is unchanged). Disabled typed entries are removed too (they would not fire anyway).
`'off'` books and `enabled:false` keep everything. Notes unchanged (D-77: notes stay lore at depth 4).
Update the comment at `lore/engine.ts:75` and `test/lore/engine.test.ts:198` (true for a plain engine
call and for `'off'` books).

**D-143 The fold (G-17, G-26, D-68.4, D-74, D-86).**
```
rowsOnPath = mems.filter(r => r.on === null || pathSet.has(r.on))
fresh      = rowsOnPath.filter(r => r.key === null || !stale(r))
effective  = newestActionPerKey(fresh)      // human rows (key null) all pass
fold(seed, effective in seq order, applyOp)
```
- **stale(r)** (agent rows only): `r.range = [from, to]` resolved to path positions; stale when some
  message at a position in `[from..to]` has `touched(id) > r.seq`. `touched(id)` = max seq of any
  `edit` entry of that message (every reason, `continue` included: the text changed) and any `hide`
  entry with `hidden:true`. An un-hide does not stale. A range whose ends are not both on the path →
  stale (cannot be checked). No `range` → never stale. `TreeIndex.touched: Map<string, number>` is
  built in `buildTree`; `FoldOptions` gets `path` (ids root→leaf) and `touched`.
- **newestActionPerKey**: for each task key K, the actions are the rows with `key === K` and every
  `revert{key:K}` op (from any row in `fresh`). Only the newest action by seq counts: a revert → no row
  for K applies (K is closed; its range counts as covered); else the newest row with key K applies,
  older rows with K are `superseded`. A revert row's other ops still apply (it is a human row).
- The `revert` op itself is consumed by the filter: `applyOp` treats it as a no-op (no issue).
- Report for M5b: `CompendiumView.tasks: ReadonlyMap<key, {seq, status: 'applied' | 'reverted' |
  'stale' | 'superseded', range?}>` over every key seen on the path, and `CompendiumView.effects:
  OpEffect[]` = `{seq, op, key, change: 'created'|'merged'|'edited'|'arc'|'note'|'retired'|'restored'}`
  per applied op (verbs read the effect of their row instead of scanning `createdSeq`).
- Cost: 5 000 rows + 1 500 entries < 30 ms (extend `test/memory/fold.test.ts:253` to typed rows with a
  1 500-entry seed). No incremental fold unless the benchmark fails.

**D-144 `file` op (G-12, G-15, quirk 3).**
1. Read: `op.type` not one of ENTRY_TYPES → issue `unknown_type`. `op.data` not a plain object →
   `invalid`. `parseStructured` issues/extras never block (lenient read, D-82 spirit).
2. `summary`: never merges. New entry, key `summary:<range[1]>.<i>` for a row with a range (`i` = index
   among the row's summary ops), else `summary:user:<seq>.<i>`. `range` = row.range. Missing `title`
   or `summary` → `missing_required`.
3. Other types: `findMatch(type, names)` where names = normalizeName of `{identity value, ...aliases}`
   of the op data (blank names dropped). Candidates = live (not retired) entries of the same type;
   an entry's names = `entryNames(e)` = normalizeName of `[name, data.title, data.topic, ...aliases,
   ...prov.formerNames]`. Session entries first (creation order), then library entries (seed order).
   - match in session → `mergeData(old.data, op.data, IDENTITY_KEEP)`; canonical `name` kept.
   - match in library → becomes an overlay: same key `lib:…`, `origin.overlay = true`, data merged.
   - no match, `LibrarySeed.classic` has one of the names → issue `classic_conflict`, nothing written.
     Notes never cause it (a note is the human's own memory, not "the book").
   - no match → new entry if the required fields are present (`REQUIRED_FIELDS`, blank = absent), else
     `missing_required`. Key `<type>:<normalizeName(identity)>` via `allocKey` (`#2`, `#3`… when taken,
     retired included). A name whose normalizeName is `''` → `invalid`.
4. After merge: `name` = identity value if the entry had none; `aliases` = union (normalizeName dedupe,
   the name itself excluded); `tagline` recomputed (D-151); `prov.lastSeq = row.seq`; appended per
   D-149. A merge that changes nothing (`mergeData` returns the same reference and aliases unchanged)
   records effect `merged` but does not move `prov.lastSeq`.
5. `IDENTITY_KEEP = ['name','title','topic']`: an existing non-blank value is never replaced by `file`
   (only `edit` renames).
6. Large entry: when an entry's `JSON.stringify(data)` reaches 12 000 chars, the fold records issue
   `large_entry` (once per key per fold); the engine turns it into `notice{compendium_large_entry}` once
   per key per session (D-87).

**D-145 `arc` op and arc entries (G-16).** `arc{plot, overview}` → key `arc:<normalizeName(plot)>`;
replaces the overview whole. CEntry: `type:null`, `name = plot` (display `[Arc] <plot>`), `arc = plot`,
`content = overview`, `data = {}`, `keys = []`, origin session. If no live `plot` entry matches the plot
name, a plot entry `{name: plot, status:'active'}` is created first (BR `prepareItems`; effect
`created`). Blank plot or overview → `invalid`. `isNote(e)` becomes `type === null && origin session &&
e.arc === undefined && typeof content === 'string'`. Arcs are listed and in the tree (Narrative), are
not selector candidates and not lore in M5a (M5b's `{{recap}}` slot reads them).

**D-146 `edit` op on typed and library entries.** `edit{ref, set?, unset?, keys?, featured?}`:
- `ref` resolves to a key (the verb stores the key; the fold resolves C<n> or names too, for hand-written
  rows). Not found → `not_found`; a `lib:` key whose base is gone → `library_entry_missing` (D-147).
- typed: `set` replaces top-level `data` fields (no merge); `unset` deletes them. Setting or unsetting
  the identity field: unset → `invalid`; set to a new non-blank value renames (`name` follows the
  identity, the key never changes, the old name is pushed to `prov.formerNames` unless already a name
  there). `set.aliases` replaces the alias list. `featured` true/false as M3. `keys` replaces `keys`
  (meaningful for notes and library triggers; allowed on any entry).
- library entry → overlay (`origin.overlay = true`), same rules.
- `set` of a top-level array → `prov.appended[field]` = all `null`; `unset` → deleted.
- notes keep M3 semantics (`set.title` renames, `set.content` replaces text, both cannot be unset).
- arcs: `set.content` (or `set.overview`) replaces the overview; `set.title`/`set.name` → `invalid`.

**D-147 Vanished library base (G-4).** A book removed from the config, set `'off'`, or an entry deleted
from it: overlay rows by `ref` (`edit`, `retire`, `restore` on a `lib:` key) are skipped with issue
`library_entry_missing`; the engine emits `notice{library_entry_missing, key}` once per key per session.
Name-addressed `file` ops simply find no library match and create a session entry. Deviation (the spec
says "the overlay keeps its deltas"); recorded for Chi.

**D-148 Merge (D-81 made exact; rolecall.md §3 "core" column).** `mergeData(old, incoming, keep, on?)
→ {data, appended, changed}`:
- Blank = `undefined`, `null`, whitespace-only string — at every depth: a blank incoming value never
  erases. `old` blank/absent → take incoming (arrays still go through the array merge against `[]`, so
  first writes are deduped too).
- Objects deep-merge; scalars replace (no change when `deepEq`); kind mismatch → incoming replaces.
- Arrays with a key fn: same key → the item deep-merges into the existing one (recursively, by the
  nested field's key fn); new key → appended; items with no key → appended unless `deepEq` to an item
  already in the result. Keys: `normKey` = `foldText` + whitespace collapse + trim. Key fns
  (RC `ARRAY_KEY_FNS`, fixed): `relationships` with|nature; `affiliations` (org ?? with); `memories`
  what_happened|when; `key_moments` string or label??description; `points_of_interest` name;
  `members`/`participants` string or `.name`; `abilities` string → normKey, object → name|type; plain
  string-list fields of RC's list (rolecall.md §3 / design.md §1.2) → normKey of the string. A composite
  key whose parts are all empty → no key. Every key fn accepts a plain string item (its normKey).
  Duplicate keys already in `old`: the first index wins. Duplicates inside `incoming` are merged.
- Arrays without a key fn: append items not `deepEq` to one already in the result.
- Blank list items are dropped.
- Near-duplicate collapse of string lists (RC `:200-264` constants: ≥ 3 significant tokens, Jaccard ≥
  0.8 or subset, scan limit 400 items, the longer wording kept at the first one's position), run on the
  whole merged list. Tokens = distinct `normalizeTerm` stems of `wordsOf(text)` whose folded word has ≥ 3
  code points and is not a stop word; stop words = RC `NEAR_DUP_STOPWORDS` ∪ `STOP_WORDS` ∪ a small
  folded Russian list (его она они оно был была было были что это для при или так уже еще тоже также
  который которая которое которые над под без про через после перед). Known miss: хранит/хранится.
- `keep` (identity fields): an existing non-blank value is kept.
- Returns the same `data` reference when nothing changed (`changed:false`).
- Test vectors M1–M16 and N1–N7 of rolecall.md §3.1 are the spec ("core" column).

**D-149 Provenance (D-80 input).** `prov.created` = `on` of the creating row (null for human rows and
library entries). `prov.appended[field][j]` parallel to every TOP-level array `data[field][j]` (nested
arrays carry none): a new element → the row's `on`; an old element changed by a keyed merge or replaced
by a longer near-duplicate → the row's `on`; an unchanged old element → its old value; an element
removed by a collapse → its slot removed; the field replaced by a non-array → `appended[field]`
deleted; `edit set` of an array → all `null`. Library base elements have no `appended` entry (= null,
never hidden); overlay elements appended by filing rows get their row's `on`. `prov.formerNames?:
string[]` (D-146).

**D-150 Handles (G-1; amends D-59).** One numbering over the whole view: `entryRefs(view)` gives
`C<i+1>` to the i-th entry of `view.entries` in Map order. The fold inserts the library seed first
(config order, book order), then session entries in creation order (seq, op index). Retired entries
keep their numbers; nothing is ever removed from the Map except a library entry whose base vanished.
- M3 note numbers are unchanged while no typed book is attached; attaching a book shifts session
  handles by its entry count; a session entry never shifts a library handle; path-bound filing rows
  (M5b) can shift later session handles after a rewind. Documented, accepted.
- `resolveEntryRef(view, ref, prefer='live')`: `C<n>`/`c<n>` (also Cyrillic С), an exact key, or a
  unique normalizeName of a name/alias/former name, preferred pool first. `noteRefs` = `entryRefs`
  filtered to notes (same numbers); `resolveNoteRef` keeps its contract (notes only).
- `HandleTable` binds every view entry by `entryRefs` (no "first appearance" numbering any more;
  `test/tools-parse/handles.test.ts:78` changes). `/memory`, the tools and the brief tail print the
  same C<n>.

## C. Render, freshness, tree

**D-151 Render (G-13, G-24, quirks 1/C2/C3).**
- `renderContent(type, data)`: BR verbatim (`# <name|title|topic, else Label(type)>`; HEAD_FIELDS
  `tagline, description, summary` as bare paragraphs; `## <Label>` sections in SPEC order, then unknown
  fields sorted; nested `lines()`), with fixes (each a listed deviation):
  1. `RENDER_HIDDEN` = `writer_source, source_turn, source_job_id, turn_range, messages_covered,
     preserved_prose` are never rendered, at the top level or inside array items/objects.
  2. HEAD_FIELDS are not repeated as sections when the type does not know them.
  3. `aliases` is never a section (any type).
  4. `title`/`topic` that are the heading are not repeated.
- `deriveTagline(type, data)` (in `entry-types.ts`, lead-owned, so the fold can use it): an explicit non-blank `data.tagline` (any type) wins; else the first sentence of
  `description` (summary: of `summary`), cut to ≤ 80 chars at a word boundary with `…`; else `''`.
- `renderBrief(entry, maxChars, tail?)`: lines `# <name>`, the tagline (if any), then the type's fields
  as `Label: value` lines (lists joined `; `, at most the counts below), cut at a sentence/line
  boundary so the whole text incl. the tail fits `maxChars`; `tail` (e.g. `(more: read_lore C12)`) is
  appended on its own line only when something was left out.
  | type | brief fields |
  |---|---|
  | character | role; state = current_state.status (≠ alive), condition, location; relationships ≤ 3 (status strained or nature rival/enemy first) as `with (nature[, status≠active])`; memories: last 2 as `what_happened — changed_belief` |
  | location | type; parent_location; controlling_faction; dangers ≤ 3 |
  | item | type; current_owner; condition; abilities ≤ 3 (string or `.name`) |
  | power | category; mastery; users ≤ 3; cost; limitations ≤ 2 |
  | organization | type; leader; goals ≤ 3; enemies ≤ 3 |
  | event | type; when; where; outcome; significance |
  | plot | status; goal; current_progress; next_steps |
  | threat | severity; status; scope; what_happens_if_unaddressed |
  | worldbuilding | category; key_facts ≤ 3; rules ≤ 3 |
  | summary | significance; the summary text; consequences ≤ 2 |
  | creature | classification; disposition; habitat; weaknesses ≤ 3 |
  A note renders as its `noteText`; an arc as `# [Arc] <plot>\n<overview>`.

**D-152 Freshness (D-80 exact; rolecall.md §4.3).** `freshness(view, upTo)` → `{firstVisible: number}`
(a path position) and `visibleCopy(entry, vis) → CEntry | null`:
- Boundary: the nearest ancestor **reply** of U (the newest assistant message on the path before U).
  Its "last request" trace = the trace of its newest `continue` edit if any, else the message's own
  trace. `trace.trimmed = {from, to}` → first visible = position(to) + 1; `null` → 0 (everything
  visible). No ancestor reply → 0.
- `vis(id)` = id on the path at position ≥ firstVisible (null → false; not on the path → false).
- summary with `range` → `null` (hidden) while `vis(range[1])`. plot, event → hidden while
  `vis(prov.created)`. Any entry: element j of a top-level array is dropped from the copy while
  `vis(prov.appended[field][j])`. Library entries' base elements, notes, arcs and human rows
  (`on:null`) are never hidden. `hidden` (trace) = entries hidden + elements dropped.
- One function for the block (M5a) and the recall index (M5c). Test vectors C1–C6 of rolecall.md §4.4.

**D-165 Tree (G-11, C4).** BR `tree.ts` ported through an adapter (`id` = entry key, `title` = name,
`enabled` = live, `categoryId` = library entry `extras.category` name, else none). Changes (deviations):
labels capitalise the first letter with Unicode (`toLocaleUpperCase` of the first code point), Places
nest by `normalizeName(parent_location)` vs `normalizeName(name)`, Cast groups by
`affiliations[0].org ?? .with`. Notes go to Unsorted, arcs to Narrative (arc first). `/memory tree`
shows the session tree, then one tree per readable book (overlays applied). Node `entryIds` are entry
keys (M5c's recall index uses them).

## D. Prompt: selector, block, budget, tools, Director

**D-153 Selector (G-3, G-20, G-21, G-25, C6, C7, C8).** `select(input) → Pick[]`, no model, every turn.
- Candidates: live typed entries of the view (session and seed), after freshness (`visibleCopy`). Not:
  notes, arcs, retired entries.
- Matchers per entry: its name, each alias, and (library) each non-regex lore key, compiled with
  `compileStemKey` (a run of stems; the whole phrase must appear in order). A matcher whose folded text
  has < 2 letters is skipped. `prov.formerNames` do not match.
- Text: message text WITHOUT the "Name: " speaker prefix (`scanMessages` adds it — do not use its
  output), hidden messages skipped.
- Tier 0 `via:'mention'`: matched in U's text (plus the guidance text on a guided re-roll).
  Tier 1 `via:'model'`: `input.recallPicks` keys (M5c; `[]` in M5a).
  Tier 2 `via:'window'`: matched in the last 4 visible path messages before U.
  Tier 3 `via:'constant'`: library entries with `constant`, not picked above.
  An entry is picked once, at its best tier.
- Order inside a tier: entries named in `view.castNames` (card character, persona) last; then (tier 2)
  the newer message first; then larger `prov.lastSeq`; then C-order. (Deviation: the spec's `lexScore`
  inside a tier is replaced by this.) Matching lives in `mention.ts` (lead-owned): `entryMatchers`,
  `mentionText`, `mentioned`, `messageText`; the selector and the snapshot both use it.
- Known limits (documented, accepted): single-stem collisions (Мира ~ мир), fleeting vowels (Уголёк /
  Уголька). Typed rows' extra triggers DO match (library keys) — a mitigation of D-76.

**D-154 Profile and limits (G-22).** `compendiumProfile(cfg.profile, window)`: `'full'`/`'lite'` as set;
`'auto'` → lite when `window < 24_576` (LITE_WINDOW). For the block the window is the narrator's request
window. `COMPENDIUM_LIMITS`:
| profile | maxEntries | full render ≤ chars | brief ≤ chars | block ≤ tokens |
|---|---|---|---|---|
| full | 12 | 4 000 (else brief) | 1 200 | no cap beyond the budget |
| lite | 6 | — (always brief) | 700 | 1 600 |

**D-155 The block and the budget (G-5, G-6).** `AssembleInput.compendium?: CompendiumBlockInput`
(contract in `types.ts`): candidates in pick order, each with `{ref, key, name, tier, via, full: string
| null, brief: string, briefTail: string}` (texts pre-rendered by the request builder; `full` null when
over the full limit or lite), `limits`, `minShare` (0.4), `inPrompt` (keys already in the prompt; M5b
fills it from the `{{recap}}` slot; empty now).
- No candidates (or no input) → assemble is byte-identical to M4 (lore budget unchanged, no block, no
  trace key).
- With candidates: lore engine budget = `floor(loreBudget × (1 − minShare))`; after the lore run, block
  budget = `loreBudget − loreUsed` (lite: `min(that, 1 600)`).
- Pick (`place.ts`): candidates in order, at most `maxEntries`; a key in `inPrompt` → `repeated`; text =
  `full` when non-null and it fits, else `brief` (+ `briefTail` on its own line when the request offers
  `read_lore`); does not fit → `cut`, continue (first-fit in tier order). Block text:
  `[Retrieved World Knowledge]` + per entry `\n[Lore: <name>]\n<text>`, entries separated by a blank line.
  Token cost via the request's counter; the header counts.
- Insert `{depth:1, role:'system', src:'compendium', srcId:'block', text}` (no `order` → 100: below
  lore/author note, above the Director, §10.1 via SOURCE_RANK). Fixed (never trimmed by the final pass).
- `trace.compendium` (typed, `entries.ts`): written whenever the request had a `compendium` input:
  `{rev, source:'lexical', profile, picks:{ref,key,via}[], injected:{ref,tok,mode:'full'|'brief'}[],
  cut:{ref,tok}[], repeated:string[], hidden:number, budget:{share, lore, block}}`. No entry texts.
  The request builder passes the input only when Compendium is enabled and the view has ≥ 1 live typed
  entry; then a turn with zero picks still records `picks: []`.
- Pass A (no tools) and pass B (tools) both pick; the tail appears only in pass B. Previews show the
  block (`/preview` needs no change: `src` prints).

**D-156 Lore tools over the Compendium (G-5, D-59).** `unfiredLore` is also true when the view has a
live typed entry that the block did not inject. `search_lore` docs = lore entries of the (routed) sources
+ every live Compendium entry (notes, typed, arcs): handle C<n> (D-150), title = name, label = `note`,
`arc`, the type (session) or `<type>, <book name>` (library); excerpt = renderBrief without tail
(≈ 200 chars); lex rank = `prov.lastSeq` (session) or `order` (library). `read_lore C<n>` returns the
full `renderContent` (notes: noteText; arcs: their render) with no freshness filter. Retired → "no such
handle". `SEARCH_DESCRIPTION` mentions "Compendium entries". Tool-spec pins in tests update.

**D-157 Director world snapshot (G-26, C10; §7.4.5).** `worldSnapshot(view, budget, opts) → string`
in `world.ts`, BR port with the B32 changes: input = `view.compendium` (seed + overlays + session),
characters and locations only, live; mention = `compileStemKey` matchers of name/aliases in the last 6
visible path messages up to U inclusive (no speaker prefix) or equal to a cast name; ranks as §7.4.5;
ties: session by larger `prov.lastSeq`, library by `order`, then C-order; truncation (description 200,
role 60, state 120, relationship note 100, location description 160); block ≤ `budget.chars`, overflow
`(+N more not shown)`; tensions deduped as unordered pairs (deviation C10). Returns the whole section
(header `[COMPENDIUM CONTEXT]`) or `''`. `WorldBudget`, `WORLD_FULL`, `WORLD_LITE` are imported from
`agents/director/types.ts`. Wired in `turn.ts` (`runDirector({... worldSnapshot})`) only when
`compendium.enabled`.

## E. Config, verbs, CLI, formats

**D-158 Config (G-7, C5).** `CompendiumConfig` (entries.ts, typed) with every §7.4.9 field optional
except `enabled`; `resolveCompendium(c) → ResolvedCompendiumConfig` fills the doc defaults (profile
'auto', minShare 0.4, maxAttempts 3, idleDelaySec 8, books {}, recall {mode 'auto', onMiss 'auto',
minEntries 0, graceSec 4, onSwipe 'reuse'}, filing {enabled true, wait 1, everyN 1, allow all but
summary}, historian {interval 20, recapAfter 24}). Ranges validated in `config.ts` (TOML snake_case →
camelCase: `min_share`, `idle_delay_sec`, `max_attempts`, `[compendium.books]`, `[compendium.recall]
on_miss/min_entries/max_entries/context_messages/grace_sec/timeout_sec/on_swipe`, `[compendium.filing]`,
`[compendium.historian]`). `DEFAULT_SESSION_CONFIG.compendium = {enabled: true}` for NEW sessions;
existing headers keep what they stored. M5a reads `enabled`, `profile`, `minShare`, `books`; the rest is
parsed and validated for M5b/M5c.

**D-159 Verbs, events, notices (G-15).** `SessionHandle` (api.ts):
```ts
memoryFile(input: { type: EntryType; data: Rec }): { key: string; ref: string; change: 'created' | 'merged' };
memoryEdit(input: { ref: string; title?: string; keys?: string[]; content?: string;
                    set?: Rec; unset?: string[]; featured?: boolean }): { key: string };
memoryRetire / memoryRestore: any entry (unchanged signatures).
memoryList(input?: { type?: EntryType | 'note' | 'arc'; includeRetired?: boolean }): MemoryRow[];
memoryGet(input: { ref: string }): { ref: string; entry: CEntry; render: string; brief: string };
memoryTree(input?: { book?: string }): TreeNode[];   // session first, then each readable book
memoryExport(input: { name: string; format: 'core' | 'compendium'; force?: boolean }): { path: string; id: string; entries: number };
compendium(): CompendiumView;                        // the head view's fold (seed included)
```
- Every writing verb dry-runs: it folds the current rows plus the candidate row; an issue on the new
  row → `Refusal('invalid_params', <why in words>)` and nothing is written. `session_busy` during a turn
  (guardMemory). `memoryExport` writes no row (refused mid-turn too, for one consistent rule).
- `memory` event: `{change, ref: key, kind: EntryType | 'note' | 'arc', name, by:'user'}`; `file` →
  `created` or `merged` (from the row's effect).
- Notices `compendium_large_entry` and `library_entry_missing` (D-144, D-147), once per key per open
  session.

**D-160 Manual editing UX (G-14).** `/memory new <type> [name]` and `/memory edit <ref>` (typed or arc)
go through the REPL's `editText(initial)` (the named `$VISUAL`/`$EDITOR`, else the in-place edit; the
TUI edits in place). The text is pretty JSON:
- new: `{"//": "<one-line help: fill what you know, blank fields are ignored; enums: role = a|b|…>",
  …LITE_FIELDS of the type with ""/[]/{} by kind, the name filled when given}`; summary (no LITE row):
  `title, summary, significance, participants`.
- edit: the entry's current `data` plus the `"//"` help key. On save the diff becomes `set`
  (changed/new fields) and `unset` (removed fields); no change → nothing written.
- Parse: strip `"//"`, drop blank values; a JSON error or a refusal → print it and re-open the editor
  with the same text; an empty or unchanged text cancels. Notes keep the M3 one-line syntax.
- `/memory new` refuses when the name already matches a live entry of that type
  (`"Мира" is already C12; use /memory edit C12`).

**D-161 REPL commands.** `/memory` (= `list`) and `/memory list [type|note|arc] [--retired]`: grouped by
tree bucket, one line per entry `C12 Мира Ванс (aka Фонарщица) — <tagline> [lib: lantern] [2,1k]`
(size = JSON chars of data, `k` with one decimal). `/memory show <ref>`: renderContent + provenance
(origin, created on, last seq, overlay, retired reason, former names). `/memory tree`. `/memory new`,
`/memory edit`, `/memory retire <ref> [reason]`, `/memory restore <ref>`, `/memory export <name>
[--format core|compendium] [--force]`. `MEMORY_LATER` = undo, refile, retry (M5b), recall, profile, mode
(M5c). `/trace` gets one `compendium:` line (picks/injected/cut counts and refs). TUI: the same REPL; the
agents pane ignores `by:'user'` memory events (unchanged).

**D-162 Import of `compendium-v1.0.0` (G-19, C9; rolecall.md §5.4 "Read").** `DetectedKind` gains
`'compendium'` (PRODUCES `'lorebook'`), detected after the ST preset and BEFORE ST world info and
`character_book` (BR predicate: object with `lorebook` object and `entries` array, and `format ===
'rolecall-compendium'` or `schemaVersion` starting `compendium-`; other version → warning). Book name:
`--as`, else non-blank `lorebook.name`, else the file stem. Rows → `LoreEntry`: typed per §5.4.3
(`meta.type/data/aliases/featured`); `[Arc]` → `meta.arc`; classic rows → ordinary entries (triggers →
keys, regex → `/re/flags`; positions world→before, character→after, before_example→examples_before,
after_example→examples_after, prepend_top→top, append_bottom→bottom, depth→`{depth: fromRcDepth(d),
role}`, append → imported disabled + warning, scene → examples_before + warning); `category_id` →
`extras.category` = the category's name; `tree`/`nodeConstraints` dropped with one warning; ids kept
(made unique); creator/fork ids dropped. Typed rows keep `content` only as `extras` (it is re-rendered).

**D-163 Export (G-18).** Scope: every session-origin entry (notes, typed, arcs, summaries) and every
overlay (as a whole entry), live and retired (retired → `enabled:false`); plain library entries are not
exported (they are already in the library).
- `--format core` (default) → `saveToLibrary(home, 'lorebooks', name, book)`; an existing id is refused
  unless `--force` (then overwritten in place, same id). Typed entry → `{id: key-derived, title: name,
  keys: [name, ...aliases], content: renderContent, position:'after', meta:{type, data, aliases,
  featured}}`; notes → their keys/content at depth 4; arcs → constant `[Arc] <plot>` with `meta.arc`;
  summaries gain `data.turn_range {from, to}` (0-based path positions, exclusive `to`) and
  `messages_covered`; memories with a non-null `prov.appended` get `source_turn` (user messages on the
  path up to it).
- `--format compendium` → `<home>/exports/<canonicalId(name)>.compendium.json`, streamed (temp file +
  rename), refused when it exists unless `--force`; rows per rolecall.md §5.4 "Write" (deterministic
  UUIDs from (name, key), `is_featured` for at most one entry per type, `tree:null`). The path is printed.
- Round trip (demo): export `--format compendium`, re-import → same types, names, aliases, data.

**D-164 `--keep-requests`.** `rp-core chat|tui|new --keep-requests` (and the engine option
`keepRequests`): every provider request body (the JSON sent, never headers or keys) is written to
`<home>/sessions/<id>.requests/<callKey with ':' → '_'>.json`, Director and narrator alike. Off by
default; nothing else changes.

**D-166 Deviation list for Chi (D-88).** `docs/COMPENDIUM-DEVIATIONS.md` (English): fixtures.md §3 A/B
as decided, plus this note's deviations (A.7, D-147, D-150, D-151 fixes, D-153 order and library keys,
D-157 C10, D-165). Must reach Chi before M5b.

**D-167 Fixtures and demos.** `test/fixtures/ru/lantern/lantern.compendium.json` (fresh, synthetic,
from `fixtures-draft/`; 18 rows, all 11 types), `test/fixtures/ru/lantern/mira.character.json` (the
`/memory new` payload). Deterministic demo = scripted provider through the CLI (docs/M5A-DEMO.md);
live demo on the user's Ollama with the innkeeper story and a small compendium (fixtures.md §4).

## F. Build plan

Wave 1 (parallel, disjoint files): memory core (`merge, apply, library, refs, notes` + `session/tree,
fold`), render (`render, fresh, tree, world`), codec (`formats/compendium-v1`, import detection),
select (`select, place, profile` + the assemble hook). Wave 2: engine (session/request/turn/config/
api/notices/keep-requests) and tools+export (`handles`, `lore` tool, `export.ts`). Wave 3: CLI and
integration, demos. Then review → fixes → lead verification → docs.

## G. Rulings after wave 1 (the lead)

- **Fold cost (D-143).** A fold from scratch of 5 000 typed rows over a 1 500-entry seed takes 45–70 ms
  on this machine, over the 30 ms target. The fold keeps checkpoints (at its end and every 2 048 rows,
  keyed by row identity and the seed object) and resumes from them: a refold after one new row ≈ 7 ms,
  a view at an earlier leaf ≈ 5 ms (asserted < 30). From scratch is guarded at < 150 ms. Callers pass
  the same LibrarySeed object while the books are unchanged and never mutate folded rows or views.
- **TaskState.superseded** stays in the type; M5a reports applied / reverted / stale.
- **Openings** (no user message U) get no Compendium input; continue and swipe get it as a reply does.
- **Zero candidates.** With input present but no candidates the messages and lore budget are unchanged
  and `trace.compendium` is still written (`picks: []`); with no input there is no trace key.
- **D-157 amended.** A library entry's lore keys can place it in the scene (one matcher set, mention.ts);
  equal ranks fall back to C-order (library before session).
- **D-152 amended.** `trimmed = {from, to}` names the oldest and newest cut messages; messages before
  `from` (a protected head) are still sent. vis(id) = on the path and not inside [pos(from)..pos(to)].
- **D-162 amended.** A typed row keeps RoleCall's text in `content` (an `'off'` book or a disabled
  Compendium still injects it as plain lore); blank text → `renderContent(type, data)`. The Compendium
  ignores `content` and re-renders.
- **Tree labels (D-165).** Bunraku's ASCII per-word capitals stay, plus a Unicode capital on the first
  code point; locale-independent comparisons.

## H. Rulings after the review and the live run (the lead)

**D-168 Human `file` rows are pinned (review fold#1, fold#2, breaker#1).** A verb writes the key its dry
run produced into the op: `{op:'file', type, data, target}`. The fold applies a pinned op to that key and
nothing else: an existing entry with the key (any state, same type) → merge into it; a missing `lib:` key →
`library_entry_missing`; a missing session key → create it with exactly that key (allocKey from it only
if it is taken by another type). No name matching and no `classic_conflict` on refold: those were checked
when the row was written. Attaching a book, switching one to `'read'` or re-enabling the Compendium later
never re-homes a human row. Agent rows (M5b, no target) stay name-addressed (D-74). A hand-filed summary's
key is `summary:user:<normalizeName(title)>` (`#2`… on collision), never built from a seq, so a fork keeps it.

**D-169 Name matching is "all significant words, any order" (live run).** §7.4.1 says every significant
word of the name or of one alias; it never asked for a run. «Это фонарь вашего мужа, Гордея?» must name
«Фонарь Гордея». mention.ts: a phrase matches when every significant stem is in one text (one message, or
U plus the guidance); stop words are not significant unless the phrase has nothing else; spaceless
scripts match as a substring. The selector and the world snapshot share it.

**Other rulings.**
- Openings (no U) get the selector too, with an empty U: tier 2 (the greeting and what precedes) and
  tier 3 (constants), so a constant typed entry is never lost (review prompt#2). Section G's "no input on
  an opening" is withdrawn.
- A typed library entry needs a `meta.data` object with at least one non-blank field; without one it
  stays plain lore (its text is all it has).
- Verbs write nothing when the dry run shows no change (a no-op edit, a restore of a live entry); a
  rename onto a name another live entry of that type already answers to is refused.
- `/memory export <name> --format core` refuses a name whose library id is a book this session reads,
  even with `--force` (it would replace that book with the session's part of it).
- Verbs return their notices (and the export its warnings) to the caller, which shows them; a notice is
  marked told only once it has been returned or sent with a turn.
- `/memory on|off` switches `compendium.enabled` for the session (sessions made before M5a stored
  `enabled:false`); `/memory` says when it is off.
- The header guard stays lenient for `compendium` (only `enabled` is checked); `resolveCompendium`
  defaults bad values and also reads the older snake_case keys a header may hold.
- `--keep-requests` writes the engine's provider-level request (documented as that, not the wire body),
  without `replay` payloads and without the signal; a repeated call key gets `-2`, `-3`.
- Render, merge and import bound their recursion (depth > 32 renders `…`; import flattens deeper data with
  a warning); deduplicating unkeyed list items is O(1) per item (a canonical-JSON set).
- World snapshot ties among library entries: higher `order` first (as the lore budget does).
- The near-duplicate collapse runs after a merge that added or reworded a string (memory builder's
  choice): a listed deviation from D-148's "whole list", same results for lists the fold built.

## I. Rulings after the final check (the lead)

**D-169 narrowed (matching).** Any order is for proper names only:
- the name and aliases of a character, location, item, power, organization, creature, threat or
  worldbuilding entry match in any order within one text — unless the phrase holds a word of ≤ 2 letters
  or a stop word («Блок А», «Wing A», «Elizabeth I», «The Lantern Guild»): then it must appear as a run
  of stems, in order (the M2 stem-key rule);
- the titles of event, plot and summary entries are phrases, not names: always a run, in order;
- a library entry's lore keys match as the lore engine's stem keys do (a run, in order), and when the
  entry has secondary keys its `logic` (and_any default, and_all, not_any, not_all) must hold against the
  same text; `caseSensitive` is not honoured (stems fold case; listed deviation);
- a spaceless-script phrase still matches as a substring (known limit: «山田 太郎» vs «山田太郎»).
CEntry gains `secondary?: string[]` and `logic?` for library entries (seed).

**Pinned rows (D-168) tightened.** A pinned `lib:` target whose base no longer answers to any name of
the op's data (name, title, topic, aliases — normalizeName) is a different entity now (the book was
replaced under the same id): the op is skipped with `library_entry_missing`, never merged into it.
Rows written before D-168 (today's unreleased builds) are not migrated.

**Other rulings.**
- A typed library entry needs data with at least one non-blank value at any depth (blank is checked
  deeply: lists of blank strings and objects of blank values are blank).
- The verbs' no-op check uses merge.ts's bounded comparison (never an unbounded deepEq); `set.aliases`
  equal to the aliases the entry already shows is a no-op; the "one name per live entry" refusal covers
  aliases and restore too; summaries are exempt (they never merge by name).
- `trace.loreHashes` hash the books as loaded (before routing), so turning the Compendium on or off is
  reported as "the Compendium", not as a changed book.
- Export always folds with the readable books' seed, even while the Compendium is off (it is a data
  operation), so overlays are never dropped silently.
- The REPL prints a verb's notices on every path (changed or not); notices are deduplicated by code and
  message, never by code alone.
- `/lore add` and `/lore rm` of a book the Compendium reads both say how /memory changes (entries join or
  leave; the handles after them shift).
- Piped input: a `/memory new|edit` refused before its editor opens still consumes the editor's line
  (the script supplied one), so it never reaches the model as a story message.
- `/memory edit <name>` takes the whole rest of the line as the ref unless it holds '|' (the M3 note form).
- The near-duplicate collapse stays O(L²) per merge for string lists (≤ 400 items): a from-scratch fold
  of 5 000 rows adding strings to one list takes ≈ 2 s; refolds use checkpoints. Accepted for M5a,
  revisit with M5b's real filing rows.
- Tree categories come in first-appearance order with "general" merged into General (RoleCall's
  sort_order is not kept): a listed deviation (D-165).
- (the lead, after round 2) While the Compendium is off, `memoryFile` refuses a name that a readable
  book's typed entry of that type answers to (it would share the name once the Compendium is on);
  `/memory retire <name of several words> [reason]` takes the longest run of leading words that names a
  live entry as the ref; a core export of an overlay keeps its book entry's `secondary` and `logic`.
- Stop words for D-169's run rule: `STOP_WORDS` plus the Russian function words normalizeTerm marks
  (том, нам, под…), so «Старый Том» needs the run. Known limits, documented: a hyphenated name
  («Жан-Поль») still matches in any order; multi-line JSON piped after `/memory new` reaches the
  in-place editor as its first line only (use `$EDITOR` or one-line JSON in scripts).
